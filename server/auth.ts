/**
 * Email-OTP authentication for Epicutis Orders.
 *
 * Hard rules:
 *  - Emails in BLOCKED_EMAILS are refused outright, ahead of everything else.
 *  - Only @epicutis.com / @signumbio.com may request a code.
 *  - Role is fail-closed: only emails explicitly listed in ADMIN_EMAILS (env
 *    or the built-in default list) get the admin role; only emails listed in
 *    RSD_EMAILS get the rsd role. Every other allowed-domain user is an AE.
 *    Role decides which admin-only fields and routes are available — it does
 *    NOT decide which orders a user may see. Every authenticated user can
 *    search all orders.
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
// Every authenticated user can search every order. Role only decides which
// admin-only fields (the `salesperson` column) and admin-only routes (the
// diagnostics endpoints) are available:
//   - admin: granted ONLY to emails on the ADMIN_EMAILS allowlist (env
//            override, else the built-in default list above).
//   - rsd:   granted ONLY to emails in RSD_EMAILS.
//   - ae:    default for every other allowed-domain user.
//
// Configuration:
//   ADMIN_EMAILS       = "alice@x.com,bob@y.com" (comma list)
//   RSD_EMAILS         = "carol@x.com,dave@y.com"
//   AE_SALESPERSONS    = JSON object mapping email -> aliases, e.g.
//                        {"jvillegas@epicutis.com":["Jose Villegas","JV"]}
//                        Used only by the admin/RSD attribution audit at
//                        /api/diagnostics/ae-visibility to report which
//                        orders are attributed to which rep. It grants and
//                        withholds nothing.

function parseEmailListEnv(name: string): Set<string> {
  const raw = process.env[name] || "";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

const RSD_EMAIL_SET = parseEmailListEnv("RSD_EMAILS");

function parseAeSalespersons(): Map<string, string[]> {
  const raw = (process.env.AE_SALESPERSONS || "").trim();
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();
    const out = new Map<string, string[]>();
    for (const [email, aliases] of Object.entries(parsed)) {
      const e = String(email || "").trim().toLowerCase();
      if (!e) continue;
      const list = Array.isArray(aliases)
        ? aliases
            .map((s) => String(s || "").trim().toLowerCase())
            .filter(Boolean)
        : [];
      out.set(e, list);
    }
    return out;
  } catch (err) {
    console.warn("[auth] AE_SALESPERSONS env is not valid JSON — ignoring");
    return new Map();
  }
}

const AE_SALESPERSON_MAP = parseAeSalespersons();

// ── Salesperson normalization & matching ─────────────────────────────────────
// Used for parsing and *attributing* the rep name recorded on an order — never
// for deciding who may see it. The field is hand-typed by operators and shows
// up in many shapes: "Jose Villegas", "JOSE VILLEGAS", "Villegas, Jose",
// "J. Villegas", "salesperson: Jose Villegas", "Jose Villegas (Epicutis)", etc.
// We normalize aggressively before comparing so the attribution audit is robust
// against punctuation, casing, accents, parentheticals, and common labels.

const SALESPERSON_LABEL_RE =
  /^(?:sales[\s_-]*person|sales[\s_-]*rep|salesrep|sales|rep|account[\s_-]*exec(?:utive)?|ae|owner|assigned[\s_-]*to)\s*[:\-–]\s*/i;

export function normalizeSalespersonValue(raw: string): string {
  if (!raw) return "";
  let s = String(raw);
  // Strip diacritics: "José" → "Jose"
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // Drop anything inside parentheses/brackets: "Jose Villegas (Epicutis)" → "Jose Villegas"
  s = s.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, " ");
  // Strip common label prefixes like "salesperson:" / "rep -" / "AE:"
  s = s.replace(SALESPERSON_LABEL_RE, "");
  // Replace any non-alphanumeric with a space (handles commas, dots, dashes, slashes, apostrophes)
  s = s.replace(/[^A-Za-z0-9]+/g, " ");
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

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

// Generate plausible aliases from an email address so attribution can work out
// of the box for AEs who have not been entered in AE_SALESPERSONS yet.
// For "jvillegas@epicutis.com" we produce candidates like "jvillegas",
// "j villegas", "villegas j". Explicit aliases in AE_SALESPERSONS always take
// precedence and are sufficient on their own.
export function deriveAliasesFromEmail(email: string): string[] {
  const e = (email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at <= 0) return [];
  const local = e.slice(0, at);
  // Strip plus-tags ("user+tag" → "user") and trailing digit suffixes.
  const baseRaw = local.replace(/\+.*$/, "").replace(/\d+$/, "");
  const base = baseRaw.replace(/[^a-z]/g, "");
  if (!base) return [];

  const aliases = new Set<string>();
  aliases.add(base); // "jvillegas"

  // dot/underscore/dash separator forms — "first.last" → first + last + "first last"
  const sepMatch = baseRaw.match(/^([a-z]+)[._-]([a-z]+)$/);
  if (sepMatch) {
    const first = sepMatch[1];
    const last = sepMatch[2];
    if (first && last) {
      aliases.add(`${first} ${last}`);
      aliases.add(`${last} ${first}`);
      aliases.add(`${first[0]} ${last}`);
      aliases.add(`${first}${last}`);
      aliases.add(last);
    }
    return Array.from(aliases);
  }

  // "flast" pattern — single leading initial + 3+ char surname → split it.
  // Surname-only is intentionally NOT added (would over-match common surnames).
  if (base.length >= 4 && base.length <= 24) {
    const first = base[0];
    const last = base.slice(1);
    if (last.length >= 3) {
      aliases.add(`${first} ${last}`);
      aliases.add(`${last} ${first}`);
    }
  }
  return Array.from(aliases);
}

// Known-nickname expansions, keyed by AE email. Only add entries here when
// production data shows a Zoho/Shopify salesperson value uses a nickname that
// the configured aliases and email-derived aliases would not otherwise catch
// (e.g. "Mel Federico" appearing on Melissa Federico's orders). Each entry is
// applied on top of the configured aliases and the email-derived set; do NOT
// guess nicknames — only add entries with explicit production evidence.
const EMAIL_NICKNAME_ALIASES: Record<string, string[]> = {
  // Production audit (2026-05-19) recorded 1 order with salesperson
  // "Mel Federico" while mfederico@epicutis.com is configured as
  // "Melissa Federico". Both forms must hit.
  "mfederico@epicutis.com": ["Mel Federico"],
};

// Combine the configured aliases for an AE with email-derived aliases plus any
// explicit nickname expansions, all normalized. Returns a deduplicated array
// of normalized alias strings.
export function effectiveAliasesForUser(
  email: string,
  configuredAliases: string[],
): string[] {
  const set = new Set<string>();
  for (const a of configuredAliases || []) {
    const n = normalizeSalespersonValue(a);
    if (n) set.add(n);
  }
  for (const a of deriveAliasesFromEmail(email)) {
    const n = normalizeSalespersonValue(a);
    if (n) set.add(n);
  }
  const nicknames = EMAIL_NICKNAME_ALIASES[(email || "").trim().toLowerCase()];
  if (nicknames) {
    for (const a of nicknames) {
      const n = normalizeSalespersonValue(a);
      if (n) set.add(n);
    }
  }
  return Array.from(set);
}

// Match a normalized salesperson value against an AE's normalized aliases.
// Accepts:
//   - exact normalized equality;
//   - token-set containment in either direction, so "jose villegas" matches
//     "villegas jose" and "j villegas" matches "jose villegas";
//   - single-token alias of ≥2 chars present as a whole token in the value.
// Both sides are normalized first. The 1-char surname-only case is rejected.
export function matchesSalesperson(
  rawSalesperson: string,
  normalizedAliases: string[],
): boolean {
  const value = normalizeSalespersonValue(rawSalesperson);
  if (!value) return false;
  const valueTokens = new Set(value.split(" ").filter(Boolean));
  for (const alias of normalizedAliases) {
    if (!alias) continue;
    if (alias === value) return true;
    const aliasTokens = alias.split(" ").filter(Boolean);
    if (aliasTokens.length === 0) continue;
    const aliasInValue = aliasTokens.every((t) => valueTokens.has(t));
    if (aliasInValue) return true;
    if (valueTokens.size > 0 && Array.from(valueTokens).every((t) => aliasTokens.includes(t))) {
      return true;
    }
    if (aliasTokens.length === 1 && aliasTokens[0].length >= 2 && valueTokens.has(aliasTokens[0])) {
      return true;
    }
  }
  return false;
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
    aeConfigured: AE_SALESPERSON_MAP.size,
    aeWithAliases: Array.from(AE_SALESPERSON_MAP.values()).filter((v) => v.length > 0).length,
  };
}

// An AE roster entry, used only by the admin/RSD attribution audit. This is
// reporting metadata, not an access grant — it never affects which orders a
// user can see.
export interface ConfiguredAe {
  email: string;
  aliases: string[];
}

// All AEs listed in AE_SALESPERSONS, with their effective normalized aliases.
// Returned in stable order so the audit produces deterministic output.
// Includes AEs whose entry exists but has no aliases so the audit can flag
// them explicitly.
export function listConfiguredAes(): ConfiguredAe[] {
  const out: ConfiguredAe[] = [];
  for (const [email, aliases] of AE_SALESPERSON_MAP.entries()) {
    // Skip entries whose email is admin/RSD — attribution is reported per AE.
    if (resolveRole(email) !== "ae") continue;
    out.push({ email, aliases: effectiveAliasesForUser(email, aliases) });
  }
  out.sort((a, b) => a.email.localeCompare(b.email));
  return out;
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
// 12 hours, sliding: every authenticated request pushes the deadline out again,
// so a working day never interrupts you, but 12 hours of inactivity signs you
// out. The client mirrors this window locally (see client/src/lib/session.ts)
// using the value handed back by the auth endpoints, so the two never drift.
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

export const SESSION_TTL_HOURS = SESSION_TTL_MS / (60 * 60 * 1000);

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
