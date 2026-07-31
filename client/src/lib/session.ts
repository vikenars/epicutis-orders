/**
 * Persisted sign-in session.
 *
 * The Bearer token used to live in React state only, so every reload, refresh,
 * back-navigation or new tab dropped it and forced another emailed OTP. It is
 * now mirrored into localStorage alongside a sliding deadline that matches the
 * server's session TTL, so a signed-in user stays signed in for the whole
 * window.
 *
 * What is stored is the token, the last-known user, and the deadline. The user
 * is a cache for nothing — on startup the app always re-asks /api/auth/me and
 * takes the role from the server, so a stored record can never grant a role the
 * server would not grant right now.
 *
 * localStorage is not always available (Safari private mode, sandboxed
 * iframes). Every access is guarded; when it throws, the app silently falls
 * back to the previous memory-only behaviour rather than failing to load.
 */

export type SessionRole = "admin" | "rsd" | "ae";

export interface SessionUser {
  email: string;
  label: string;
  role?: SessionRole;
}

export interface StoredSession {
  token: string;
  user: SessionUser;
  expiresAt: number;
  ttlMs: number;
}

const STORAGE_KEY = "epicutis.orders.session.v1";

// Used only if the server response somehow omits sessionTtlMs; the server value
// (server/auth.ts SESSION_TTL_MS) is authoritative.
export const FALLBACK_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalizeTtl(ttlMs: unknown): number {
  return typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
    ? ttlMs
    : FALLBACK_SESSION_TTL_MS;
}

export function clearSession(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if the store is unavailable.
  }
}

export function saveSession(token: string, user: SessionUser, ttlMs?: number): void {
  const ttl = normalizeTtl(ttlMs);
  const record: StoredSession = { token, user, expiresAt: Date.now() + ttl, ttlMs: ttl };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota or a disabled store — the in-memory session still works for this tab.
  }
}

/**
 * Read the stored session. Returns null — and clears the record — when nothing
 * is stored, the record is malformed, or the window has already lapsed, so the
 * caller only ever gets a session it can actually use.
 */
export function loadSession(): StoredSession | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSession();
    return null;
  }

  const record = parsed as Partial<StoredSession> | null;
  const token = typeof record?.token === "string" ? record.token : "";
  const email = typeof record?.user?.email === "string" ? record.user.email : "";
  const expiresAt = typeof record?.expiresAt === "number" ? record.expiresAt : 0;
  if (!token || !email || !expiresAt) {
    clearSession();
    return null;
  }
  if (expiresAt <= Date.now()) {
    clearSession();
    return null;
  }

  return {
    token,
    user: {
      email,
      label: typeof record?.user?.label === "string" ? record.user.label : email,
      role: record?.user?.role,
    },
    expiresAt,
    ttlMs: normalizeTtl(record?.ttlMs),
  };
}

/**
 * Slide the deadline out by a full TTL. Called after every successful
 * authenticated request, mirroring the server's sliding expiry so the two
 * windows stay in step. A no-op once the stored window has already lapsed —
 * activity cannot resurrect an expired session.
 */
export function touchSession(): void {
  const current = loadSession();
  if (!current) return;
  saveSession(current.token, current.user, current.ttlMs);
}
