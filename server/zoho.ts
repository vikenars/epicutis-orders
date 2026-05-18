/**
 * Zoho Books integration — salesperson lookup by invoice / sales-order number.
 *
 * Live Shopify orders in this account do NOT carry a parseable salesperson in
 * note / tags / customAttributes / order metafields (read_users is also out of
 * scope, so `staffMember` is unavailable). They DO carry Zoho cross-references
 * as order metafields under the `custom` namespace:
 *
 *   custom.zoho_invoice                 — Zoho Books invoice number
 *   custom.zoho_order_reference_number  — Zoho Books sales-order number
 *
 * Zoho Books exposes `salesperson_name` on both invoices and salesorders, so
 * we resolve the rep by querying Zoho with whichever reference is present.
 * Results are cached in-process with a TTL so we make at most one Zoho call
 * per distinct reference per TTL window.
 *
 * Auth model is the standard Zoho self-client refresh-token flow:
 *   refresh_token + client_id + client_secret  →  short-lived access_token
 * The refresh token is long-lived (until revoked) and is stored only in
 * process.env. Access tokens are cached in-memory until 60s before expiry.
 *
 * Env (all read at call time):
 *   ZOHO_CLIENT_ID
 *   ZOHO_CLIENT_SECRET
 *   ZOHO_BOOKS_REFRESH_TOKEN  (alias ZOHO_REFRESH_TOKEN also accepted)
 *   ZOHO_ORG_ID               (Zoho Books organization id)
 *   ZOHO_ACCOUNTS_BASE        (optional, default https://accounts.zoho.com)
 *   ZOHO_BOOKS_BASE           (optional, default https://www.zohoapis.com/books/v3)
 */

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || "";
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "";
const ZOHO_REFRESH_TOKEN =
  process.env.ZOHO_BOOKS_REFRESH_TOKEN || process.env.ZOHO_REFRESH_TOKEN || "";
const ZOHO_ORG_ID = process.env.ZOHO_ORG_ID || "";
const ZOHO_ACCOUNTS_BASE = (process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.com").replace(/\/$/, "");
const ZOHO_BOOKS_BASE = (process.env.ZOHO_BOOKS_BASE || "https://www.zohoapis.com/books/v3").replace(/\/$/, "");

export function isZohoConfigured(): boolean {
  return Boolean(ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET && ZOHO_REFRESH_TOKEN && ZOHO_ORG_ID);
}

export function zohoConfigSummary() {
  return {
    clientIdSet: Boolean(ZOHO_CLIENT_ID),
    clientSecretSet: Boolean(ZOHO_CLIENT_SECRET),
    refreshTokenSet: Boolean(ZOHO_REFRESH_TOKEN),
    orgIdSet: Boolean(ZOHO_ORG_ID),
    accountsBase: ZOHO_ACCOUNTS_BASE,
    booksBase: ZOHO_BOOKS_BASE,
    configured: isZohoConfigured(),
  };
}

// ── Access token cache ────────────────────────────────────────────────────────
let cachedAccessToken: string | null = null;
let accessTokenExpiry = 0;
let tokenFetchInFlight: Promise<string> | null = null;

async function getZohoAccessToken(): Promise<string> {
  if (!isZohoConfigured()) {
    throw new Error("Zoho is not configured");
  }
  const now = Date.now();
  if (cachedAccessToken && now < accessTokenExpiry) return cachedAccessToken;
  if (tokenFetchInFlight) return tokenFetchInFlight;

  tokenFetchInFlight = (async () => {
    const url = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`;
    const params = new URLSearchParams({
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Zoho token refresh failed: ${res.status} ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!data.access_token) {
      throw new Error(`Zoho token refresh returned no access_token: ${data.error || "unknown"}`);
    }
    cachedAccessToken = data.access_token;
    // expires_in is seconds; refresh ~60s before actual expiry.
    const lifetime = (data.expires_in || 3600) * 1000;
    accessTokenExpiry = Date.now() + Math.max(60_000, lifetime - 60_000);
    return cachedAccessToken;
  })().finally(() => {
    tokenFetchInFlight = null;
  });

  return tokenFetchInFlight;
}

async function zohoGet(path: string, query: Record<string, string>): Promise<any> {
  const token = await getZohoAccessToken();
  const qs = new URLSearchParams({ organization_id: ZOHO_ORG_ID, ...query }).toString();
  const url = `${ZOHO_BOOKS_BASE}${path}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (res.status === 401) {
    // Force a refresh on next call.
    cachedAccessToken = null;
    accessTokenExpiry = 0;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Zoho GET ${path} failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ── Salesperson resolution + cache ────────────────────────────────────────────
// Cache key is the normalised reference string (e.g. "inv-078968" or "so-12345"
// or "1234567"). Value is the resolved salesperson_name (lowercased) or null
// when we looked it up and the reference produced no rep.
interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

const RESOLVE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — salesperson on a closed
                                            // invoice does not change in practice.
const NEGATIVE_TTL_MS = 15 * 60 * 1000;     // shorter TTL for misses so a Zoho
                                            // fix becomes visible within minutes.
const resolveCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | null>>();

export function normalizeZohoRef(raw: string | null | undefined): string {
  return String(raw || "").trim().toLowerCase();
}

function cacheGet(key: string): CacheEntry | undefined {
  const e = resolveCache.get(key);
  if (!e) return undefined;
  if (e.expiresAt < Date.now()) {
    resolveCache.delete(key);
    return undefined;
  }
  return e;
}

function cachePut(key: string, value: string | null) {
  resolveCache.set(key, {
    value,
    expiresAt: Date.now() + (value ? RESOLVE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

// Try to resolve a salesperson via the Zoho Books "invoices" endpoint. Zoho
// search by `invoice_number=` returns an array; we take the first match.
async function fetchSalespersonByInvoice(invoiceNumber: string): Promise<string | null> {
  const data = await zohoGet("/invoices", { invoice_number: invoiceNumber });
  const list = (data?.invoices || []) as any[];
  for (const inv of list) {
    const name = String(inv?.salesperson_name || "").trim();
    if (name) return name.toLowerCase();
  }
  return null;
}

// Same for sales-orders. Zoho field name: `salesorder_number`.
async function fetchSalespersonBySalesorder(salesorderNumber: string): Promise<string | null> {
  const data = await zohoGet("/salesorders", { salesorder_number: salesorderNumber });
  const list = (data?.salesorders || []) as any[];
  for (const so of list) {
    const name = String(so?.salesperson_name || "").trim();
    if (name) return name.toLowerCase();
  }
  return null;
}

export interface ZohoRefs {
  invoice?: string | null;
  salesorder?: string | null;
}

/**
 * Resolve a salesperson for a single Shopify order given the Zoho refs from
 * its metafields. Tries invoice first (more commonly present), then falls back
 * to the sales-order number. Returns a lowercased name, or null if nothing
 * resolves. Errors talking to Zoho are caught and logged so a single bad
 * reference does not break the whole order search.
 */
export async function resolveSalespersonFromZoho(refs: ZohoRefs): Promise<string | null> {
  if (!isZohoConfigured()) return null;
  const inv = normalizeZohoRef(refs.invoice);
  const so = normalizeZohoRef(refs.salesorder);
  if (!inv && !so) return null;

  // Compound cache key so we don't pollute the cache when only one ref is
  // present on a given order.
  const cacheKey = `${inv}|${so}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached.value;

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const p = (async () => {
    let resolved: string | null = null;
    if (inv) {
      try {
        resolved = await fetchSalespersonByInvoice(inv);
      } catch (err: any) {
        console.warn(`[zoho] invoice lookup failed for ${inv}: ${err?.message || err}`);
      }
    }
    if (!resolved && so) {
      try {
        resolved = await fetchSalespersonBySalesorder(so);
      } catch (err: any) {
        console.warn(`[zoho] salesorder lookup failed for ${so}: ${err?.message || err}`);
      }
    }
    cachePut(cacheKey, resolved);
    return resolved;
  })().finally(() => {
    inflight.delete(cacheKey);
  });

  inflight.set(cacheKey, p);
  return p;
}

export function zohoCacheStats() {
  let positive = 0;
  let negative = 0;
  resolveCache.forEach((v) => {
    if (v.value) positive += 1;
    else negative += 1;
  });
  return { size: resolveCache.size, positive, negative };
}
