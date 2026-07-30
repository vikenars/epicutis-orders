/**
 * Email-OTP authentication for Epicutis Orders.
 *
 * Hard rules:
 *  - Only @epicutis.com / @signumbio.com may request a code.
 *  - Role is fail-closed: only emails explicitly listed in ADMIN_EMAILS (env
 *    or the built-in default list) get the admin role; only emails listed in
 *    RSD_EMAILS get the rsd role. Every other allowed-domain user is an AE.
 *    Role controls admin-only fields and diagnostics, not which orders are
 *    reachable — every authenticated user can search all orders.
 *  - OTP codes are hash-stored, 10-minute TTL, 5-attempt cap per code.
 *  - 30s per-email cooldown between code requests.
 *  - No code is ever logged in production.
 */

import crypto from "crypto";

export type UserRole = "admin" | "rsd" | "ae";

export interface AuthUser {
  email: string;
  label: string;
  role: UserRole;
}

// ── Domain allowlist ──────────────────────────────────────────────────────────
const ALLOWED_DOMAINS = ["epicutis.com", "signumbio.com"] as const;

export function isAllowedDomain(email: string): boolean {
  const lower = (email || "").trim().toLowerCase();
  return ALLOWED_DOMAINS.some((d) => lower.endsWith(`@${d}`));
}

// ── Blocklist (env-driven, fail-closed, highest precedence) ───────────────────
// Emails in BLOCKED_EMAILS are denied at the authentication layer, ahead of the
// domain allowlist and all role assignment. A blocked email cannot request an
// OTP, cannot verify one, and any session token already issued to it stops
// working on its next request. Comma-separated list, matched case-insensitively.
//   BLOCKED_EMAILS = "abitter@epicutis.com,someone@signumbio.com"
const BLOCKED_EMAIL_SET = parseBlockedEmails();

function parseBlockedEmails(): Set<string> {
  const raw = process.env.BLOCKED_EMAILS || "";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

export function isBlockedEmail(email: string): boolean {
  return BLOCKED_EMAIL_SET.has((email || "").trim().toLowerCase());
}

// ── Admin allowlist (env override → defaults) ─────────────────────────────────
const DEFAULT_ADMIN_EMAILS = [
  "bstock@signumbio.com",
  "varslanian@signumbio.com",
  "lisajo@signumbio.com",
  "mstock@signumbio.com",
  "jvillegas@epicutis.com",
  "tweast@epicutis.com",
  "rwoods@signumbio.com",
];

function parseAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS || "";
  const fromEnv = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const list = fromEnv.length ? fromEnv : DEFAULT_ADMIN_EMAILS.map((e) => e.toLowerCase());
  return new Set(list);
}

const ADMIN_EMAIL_SET = parseAdminEmails();

export function isAdminEmail(email: string): boolean {
  return ADMIN_EMAIL_SET.has((email || "").trim().toLowerCase());
}

// ── Role assignment (env-driven, fail-closed) ─────────────────────────────────
// Every authenticated user can search all orders. Role only controls
// admin-only fields and diagnostics:
//   - admin: sees the resolved `salesperson` field and the diagnostics
//            endpoints. Granted ONLY to emails on the ADMIN_EMAILS allowlist
//            (env override, else the built-in default list above).
//   - rsd:   same as admin. Granted ONLY to emails in RSD_EMAILS.
//   - ae:    default for every other allowed-domain user. Full order search,
//            without the admin-only `salesperson` field.
//
// Configuration:
//   ADMIN_EMAILS       = "alice@x.com,bob@y.com" (comma list)
//   RSD_EMAILS         = "carol@x.com,dave@y.com"

function parseEmailListEnv(name: string): Set<string> {
  const raw = process.env[name] || "";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

const RSD_EMAIL_SET = parseEmailListEnv("RSD_EMAILS");

// ── Salesperson label parsing ────────────────────────────────────────────────
// The salesperson field on a Shopify order note is hand-typed by operators and
// shows up in many shapes: "Jose Villegas", "salesperson: Jose Villegas",
// "rep - J. Villegas". These helpers strip the label so the note parser can
// surface a clean name for the admin/RSD-only display column.

const SALESPERSON_LABEL_RE =
  /^(?:sales[\s_-]*person|sales[\s_-]*rep|salesrep|sales|rep|account[\s_-]*exec(?:utive)?|ae|owner|assigned[\s_-]*to)\s*[:\-–]\s*/i;

// Best-effort detection of whether a pipe-segment value LOOKS like a labeled
// salesperson field. Used by the note parser to find labeled values regardless
// of segment position.
export function segmentLooksLikeSalesperson(segment: string): boolean {
  return SALESPERSON_LABEL_RE.test(String(segment || "").trim());
}

export function extractSalespersonFromSegment(segment: string): string {
  const s = String(segment || "");
  const m = s.match(SALESPERSON_LABEL_RE);
  if (!m) return s.trim();
  return s.slice(m[0].length).trim();
}

export function resolveRole(email: string): UserRole {
  const e = (email || "").trim().toLowerCase();
  // Order matters: admin > rsd > ae. An email that appears in multiple lists
  // is granted the most privileged role it is explicitly listed in. The
  // default for everyone else is "ae" — fail-closed, never "admin".
  if (ADMIN_EMAIL_SET.has(e)) return "admin";
  if (RSD_EMAIL_SET.has(e)) return "rsd";
  return "ae";
}

export function resolveUserForEmail(email: string): AuthUser | null {
  const e = (email || "").trim().toLowerCase();
  if (!e) return null;
  if (isBlockedEmail(e)) return null;
  if (!isAllowedDomain(e)) return null;
  return { email: e, label: e, role: resolveRole(e) };
}

// Diagnostic counts only — never the values themselves.
export function roleConfigSummary() {
  return {
    blockedConfigured: BLOCKED_EMAIL_SET.size,
    adminConfigured: ADMIN_EMAIL_SET.size,
    rsdConfigured: RSD_EMAIL_SET.size,
  };
}

// ── OTP store ─────────────────────────────────────────────────────────────────
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_REQUEST_COOLDOWN_MS = 30_000;

interface OtpRecord {
  email: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  user: AuthUser;
}

const otpStore = new Map<string, OtpRecord>();
const lastRequestAt = new Map<string, number>();

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function canRequestOtp(email: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const e = email.trim().toLowerCase();
  const last = lastRequestAt.get(e);
  if (!last) return { ok: true };
  const wait = OTP_REQUEST_COOLDOWN_MS - (Date.now() - last);
  if (wait > 0) return { ok: false, retryAfterMs: wait };
  return { ok: true };
}

export function storeOtp(email: string, code: string, user: AuthUser): void {
  const e = email.trim().toLowerCase();
  otpStore.set(e, {
    email: e,
    codeHash: hashCode(code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    user,
  });
  lastRequestAt.set(e, Date.now());
}

export type VerifyResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: "not_found" | "expired" | "too_many_attempts" | "wrong_code" };

export function verifyOtp(email: string, code: string): VerifyResult {
  const e = email.trim().toLowerCase();
  const rec = otpStore.get(e);
  if (!rec) return { ok: false, reason: "not_found" };
  if (rec.expiresAt < Date.now()) {
    otpStore.delete(e);
    return { ok: false, reason: "expired" };
  }
  if (rec.attempts >= OTP_MAX_ATTEMPTS) {
    otpStore.delete(e);
    return { ok: false, reason: "too_many_attempts" };
  }
  rec.attempts += 1;
  if (rec.codeHash !== hashCode(code)) {
    return { ok: false, reason: "wrong_code" };
  }
  otpStore.delete(e);
  return { ok: true, user: rec.user };
}

// ── Sessions (Bearer tokens) ──────────────────────────────────────────────────
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, sliding

interface Session {
  user: AuthUser;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

export function createSession(user: AuthUser): string {
  const token = crypto.randomUUID();
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token: string): Session | undefined {
  if (!token) return undefined;
  const s = sessions.get(token);
  if (!s) return undefined;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  // Revoke on the fly if the user has since been added to BLOCKED_EMAILS, so a
  // previously-issued token cannot be used to keep accessing the site.
  if (isBlockedEmail(s.user.email)) {
    sessions.delete(token);
    return undefined;
  }
  // Sliding expiry — successful use extends the session.
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return s;
}

export function deleteSession(token: string): void {
  if (token) sessions.delete(token);
}

export const SESSION_TTL_DAYS = SESSION_TTL_MS / (24 * 60 * 60 * 1000);

// Periodic cleanup of expired records.
setInterval(() => {
  const now = Date.now();
  otpStore.forEach((v, k) => {
    if (v.expiresAt < now) otpStore.delete(k);
  });
  sessions.forEach((s, k) => {
    if (s.expiresAt < now) sessions.delete(k);
  });
  lastRequestAt.forEach((t, k) => {
    if (now - t > 24 * 60 * 60 * 1000) lastRequestAt.delete(k);
  });
}, 60_000).unref();

// ── Email delivery via Resend ─────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const OTP_FROM_ADDRESS =
  process.env.OTP_FROM_ADDRESS || "Epicutis Orders <onboarding@resend.dev>";
const OTP_REPLY_TO = process.env.OTP_REPLY_TO || "";

export interface SendOtpResult {
  ok: boolean;
  error?: string;
}

export async function sendOtpEmail(email: string, code: string): Promise<SendOtpResult> {
  if (!RESEND_API_KEY) {
    // In local dev with no Resend key, surface the code in server logs so
    // testing is possible without the key. Production must always have the key.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[auth:otp] RESEND_API_KEY not set — code for ${email}: ${code}`);
      return { ok: true };
    }
    return { ok: false, error: "Email delivery is not configured (missing RESEND_API_KEY)." };
  }

  const subject = `Your Epicutis Orders sign-in code: ${code}`;
  const text = [
    `Your sign-in code is: ${code}`,
    "",
    "It expires in 10 minutes. If you did not request this, you can ignore this email.",
    "",
    "— Epicutis Orders",
  ].join("\n");
  const html = `
    <!doctype html>
    <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#07100d; color:#fff; padding:32px;">
        <div style="max-width:520px; margin:0 auto; background:#111915; border:1px solid rgba(255,255,255,0.08); border-radius:16px; padding:32px;">
          <h1 style="margin:0 0 8px; font-size:20px; color:#fff;">Epicutis Orders</h1>
          <p style="margin:0 0 24px; color:rgba(255,255,255,0.6); font-size:14px;">Your sign-in code is below.</p>
          <div style="font-family:'SF Mono', Menlo, monospace; font-size:36px; letter-spacing:0.18em; font-weight:700; background:rgba(5,168,97,0.12); border:1px solid rgba(5,168,97,0.3); color:#5dd4a0; padding:18px 24px; border-radius:12px; text-align:center;">${code}</div>
          <p style="margin:24px 0 0; color:rgba(255,255,255,0.5); font-size:13px;">This code expires in 10 minutes. If you did not request it, you can safely ignore this email.</p>
        </div>
      </body>
    </html>
  `;

  const body: Record<string, unknown> = {
    from: OTP_FROM_ADDRESS,
    to: [email],
    subject,
    text,
    html,
  };
  if (OTP_REPLY_TO) body.reply_to = OTP_REPLY_TO;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[auth:otp] Resend send failed", res.status, errText.slice(0, 300));
      return { ok: false, error: `Email service responded ${res.status}` };
    }
    return { ok: true };
  } catch (err: any) {
    console.error("[auth:otp] Resend send error:", err?.message || err);
    return { ok: false, error: "Email service unreachable" };
  }
}
