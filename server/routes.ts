import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "http";
import {
  type AuthUser,
  canRequestOtp,
  createSession,
  deleteSession,
  extractSalespersonFromSegment,
  generateOtpCode,
  getSession,
  isAllowedDomain,
  listAllAeEffectiveAliases,
  matchesSalesperson,
  normalizeSalespersonValue,
  resolveUserForEmail,
  roleConfigSummary,
  segmentLooksLikeSalesperson,
  sendOtpEmail,
  SESSION_TTL_DAYS,
  storeOtp,
  verifyOtp,
} from "./auth";

// ── Shopify credentials (env-only) ────────────────────────────────────────────
// Two supported auth modes for Shopify:
//   1. Static admin access token (preferred): SHOPIFY_ADMIN_ACCESS_TOKEN
//   2. Public-app client_credentials flow: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
// Either is fine — we pick whichever is set. Never hardcode.
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "";
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

// --- Shared order index ---
// Maps invoice number (lowercase, e.g. "inv-078968") → order name (e.g. "#EPI24831")
// Also maps order name → searchable note text (for keyword search across all orders)
// Built lazily on first use, refreshed every 30 minutes.
let invoiceIndex: Map<string, string> | null = null;
let noteIndex: Map<string, string> | null = null; // orderName → full note text (lowercase)
let invoiceIndexBuiltAt = 0;
let invoiceIndexBuilding: Promise<void> | null = null;
const INVOICE_INDEX_TTL = 30 * 60 * 1000; // 30 minutes

function shopifyApiUrl(path: string): string {
  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error("SHOPIFY_STORE_DOMAIN is not configured");
  }
  return `https://${SHOPIFY_STORE_DOMAIN}${path}`;
}

// Escape a value before embedding it inside a Shopify GraphQL string literal.
// Shopify search query strings (e.g. `name:#EPI123` or `shipping_address:*foo*`)
// are passed inside a `query: "..."` argument in the GQL document we build.
// Anything the user types must not be able to break out of that string literal
// or close the surrounding GraphQL block.
function escapeGqlString(s: string): string {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, " ");
}

// For values that are interpolated into a Shopify search query (not raw GraphQL),
// strip characters that have semantic meaning to Shopify search syntax so a
// crafted query string can't pivot from one filter to another. Conservative
// allowlist: alphanumerics, plus a few common punctuation marks safe inside
// search terms. Wildcard `*` is preserved so existing wildcard usage works.
function sanitizeShopifySearchTerm(s: string): string {
  return String(s).replace(/[^A-Za-z0-9 .#@_*\-]/g, "");
}

async function getInvoiceIndex(): Promise<Map<string, string>> {
  const now = Date.now();
  if (invoiceIndex && now - invoiceIndexBuiltAt < INVOICE_INDEX_TTL) return invoiceIndex;
  if (invoiceIndexBuilding) { await invoiceIndexBuilding; return invoiceIndex!; }

  invoiceIndexBuilding = (async () => {
    const token = await getAccessToken();
    const inv = new Map<string, string>();
    const notes = new Map<string, string>();
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const cursorArg = cursor ? `, after: "${escapeGqlString(cursor)}"` : "";
      const gql = `{ orders(first: 250${cursorArg}, sortKey: CREATED_AT, reverse: true) {
        edges { node { name note } }
        pageInfo { hasNextPage endCursor }
      } }`;

      const res = await fetch(shopifyApiUrl(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query: gql }),
      });
      const data = (await res.json()) as any;
      const orders = data.data?.orders;
      for (const edge of orders?.edges || []) {
        const { name, note } = edge.node;
        if (note) {
          const match = note.match(/inv[-\s]?(\d+)/i);
          if (match) inv.set(`inv-${match[1]}`, name);
          notes.set(name, note.toLowerCase());
        }
      }
      hasMore = orders?.pageInfo?.hasNextPage;
      cursor = orders?.pageInfo?.endCursor || null;
    }

    invoiceIndex = inv;
    noteIndex = notes;
    invoiceIndexBuiltAt = Date.now();
    console.log(`[invoice-index] Built: ${inv.size} invoices, ${notes.size} notes indexed`);
  })();

  await invoiceIndexBuilding;
  invoiceIndexBuilding = null;
  return invoiceIndex!;
}

async function getNoteIndex(): Promise<Map<string, string>> {
  await getInvoiceIndex(); // builds both indexes together
  return noteIndex!;
}

async function getAccessToken(): Promise<string> {
  // Prefer a pre-issued admin access token if the operator has set one.
  if (SHOPIFY_ADMIN_ACCESS_TOKEN) return SHOPIFY_ADMIN_ACCESS_TOKEN;

  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      "Shopify credentials are not configured. Set SHOPIFY_ADMIN_ACCESS_TOKEN, " +
      "or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.",
    );
  }

  const res = await fetch(shopifyApiUrl(`/admin/oauth/access_token`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) throw new Error("Failed to get Shopify access token");
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function parseNote(note: string | null | undefined) {
  if (!note || !note.trim()) {
    return { invoiceNumber: null, noteCustomer: null, orderType: null, salesperson: null };
  }
  const parts = note.split("|").map((p) => p.trim());
  // Historical note format is "invoice | customer | orderType". Some orders
  // append a 4th pipe-delimited segment with the salesperson / rep name —
  // sometimes as a bare name, sometimes as a labeled "salesperson: Jose
  // Villegas" pair. The label may also appear in any later segment if an
  // operator adds it out of order. We prefer a labeled segment when present,
  // then fall back to the legacy 4th-position bare value.
  let salesperson: string | null = null;
  for (let i = 3; i < parts.length; i++) {
    const p = parts[i];
    if (p && segmentLooksLikeSalesperson(p)) {
      salesperson = extractSalespersonFromSegment(p) || null;
      break;
    }
  }
  if (!salesperson) {
    const fourth = parts[3];
    if (fourth) {
      // The fourth segment may itself be labeled (rare but seen), or be a bare
      // name. extractSalespersonFromSegment is a no-op when no label is present.
      salesperson = extractSalespersonFromSegment(fourth) || null;
    }
  }
  return {
    invoiceNumber: parts[0] || null,
    noteCustomer: parts[1] || null,
    orderType: parts[2] || null,
    salesperson,
  };
}

function formatCurrency(amount: string) {
  const num = parseFloat(amount);
  return num === 0 ? "$0" : `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function buildFulfillmentMap(fulfillments: any[]): Map<string, { trackingNumber: string | null; trackingUrl: string | null; estDelivery: string | null }> {
  const map = new Map<string, { trackingNumber: string | null; trackingUrl: string | null; estDelivery: string | null }>();
  for (const f of fulfillments || []) {
    const trackingNumber = f.trackingInfo?.[0]?.number || null;
    const trackingUrl = f.trackingInfo?.[0]?.url || null;
    const deliveredAt = f.deliveredAt
      ? new Date(f.deliveredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null;
    const estDelivery = f.estimatedDeliveryAt
      ? new Date(f.estimatedDeliveryAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null;
    const delivery = deliveredAt ? `Delivered ${deliveredAt}` : estDelivery ? `Est. ${estDelivery}` : null;
    for (const edge of f.fulfillmentLineItems?.edges || []) {
      const lineItemId = edge.node?.lineItem?.id;
      if (lineItemId) {
        map.set(lineItemId, { trackingNumber, trackingUrl, estDelivery: delivery });
      }
    }
  }
  return map;
}

function formatItems(lineItems: any[], fulfillmentMap: Map<string, any>) {
  return lineItems.map((item: any) => {
    const price = parseFloat(item.originalUnitPriceSet?.shopMoney?.amount || "0");
    const tracking = fulfillmentMap.get(item.id);
    const itemFulfillmentStatus = item.fulfillmentStatus || "unfulfilled";
    return {
      title: item.title,
      sku: item.sku || "",
      quantity: item.quantity,
      unitPrice: price > 0 ? `$${price.toLocaleString()}` : "—",
      lineTotal: price > 0 ? `$${(price * item.quantity).toLocaleString()}` : "—",
      trackingNumber: tracking?.trackingNumber || null,
      trackingUrl: tracking?.trackingUrl || null,
      itemEstDelivery: tracking?.estDelivery || null,
      itemFulfillmentStatus,
    };
  });
}

function buildOrderRow(o: any) {
  const channel = o.channelInformation?.channelDefinition?.channelName || null;
  const isOnlineStore = channel === "Online Store";
  const { invoiceNumber, noteCustomer, orderType, salesperson } = isOnlineStore
    ? { invoiceNumber: null, noteCustomer: null, orderType: null, salesperson: null }
    : parseNote(o.note);

  const lineItems = o.lineItems?.edges?.map((li: any) => li.node) || [];
  const fulfillments = o.fulfillments || [];
  const fulfillment = fulfillments[0] || null;
  const trackingNumber = fulfillment?.trackingInfo?.[0]?.number || null;
  const trackingUrl = fulfillment?.trackingInfo?.[0]?.url || null;
  const estDelivery = fulfillment?.estimatedDeliveryAt
    ? new Date(fulfillment.estimatedDeliveryAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;
  const deliveredAt = fulfillment?.deliveredAt
    ? new Date(fulfillment.deliveredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;
  const fulfillmentMap = buildFulfillmentMap(fulfillments);

  const shipTo = o.shippingAddress
    ? (() => {
        const a = o.shippingAddress;
        const name = `${a.firstName} ${a.lastName}`.trim();
        const clean = (v: string | null | undefined) => (v && v.trim() && v.trim() !== "-" ? v.trim() : null);
        const street = [clean(a.address1), clean(a.address2)].filter(Boolean).join(" ");
        const cityLine = [clean(a.city), clean(a.provinceCode), clean(a.zip)].filter(Boolean).join(" ");
        return [name, street, cityLine].filter(Boolean).join("\n");
      })()
    : "—";

  const billingName = o.billingAddress
    ? `${o.billingAddress.firstName} ${o.billingAddress.lastName}`.trim()
    : null;
  const customerName = o.customer?.displayName || noteCustomer || billingName || "—";

  return {
    orderName: o.name,
    date: new Date(o.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    channel: channel || "—",
    customerName,
    shipTo,
    items: formatItems(lineItems, fulfillmentMap),
    itemsText: lineItems.map((li: any) => li.title).join(" "),
    subtotal: formatCurrency(o.subtotalPriceSet?.shopMoney?.amount || "0"),
    shipping: formatCurrency(o.totalShippingPriceSet?.shopMoney?.amount || "0"),
    total: formatCurrency(o.totalPriceSet?.shopMoney?.amount || "0"),
    fulfillmentStatus: o.displayFulfillmentStatus?.replace(/_/g, " ") || "—",
    trackingNumber,
    trackingUrl,
    estDelivery: deliveredAt ? `Delivered ${deliveredAt}` : estDelivery ? `Est. ${estDelivery}` : "—",
    invoiceNumber: invoiceNumber || "—",
    noteCustomer: noteCustomer || "—",
    orderType: orderType || "—",
    _note: o.note || "",
    _skus: lineItems.map((li: any) => `${li.sku || ""} ${li.title || ""}`).join(" "),
    _salesperson: salesperson || "",
  };
}

// Server-side AE result filter. AEs may only see orders where the parsed
// salesperson on the order matches one of their effective aliases (configured
// aliases plus email-derived ones). The aliases on AuthUser are already
// normalized; matching here delegates to the shared salesperson matcher so
// the rules stay consistent with what other surfaces report. Admins and RSDs
// see all orders. AEs with no aliases see zero orders (fail-closed) — the
// response includes a non-PII `scope` object so the UI can show an
// actionable message.
function rowMatchesAe(row: any, normalizedAliases: string[]): boolean {
  return matchesSalesperson(String(row._salesperson || ""), normalizedAliases);
}

function filterOrdersForUser(rows: any[], user: AuthUser): any[] {
  if (user.role === "admin" || user.role === "rsd") return rows;
  const aliases = user.salespersonAliases || [];
  if (aliases.length === 0) return [];
  return rows.filter((r) => rowMatchesAe(r, aliases));
}

const ORDER_GQL = `{
  edges {
    node {
      name
      createdAt
      displayFulfillmentStatus
      channelInformation {
        channelDefinition { channelName }
      }
      customer { displayName }
      billingAddress { firstName lastName }
      shippingAddress {
        firstName lastName address1 address2 city provinceCode zip
      }
      note
      lineItems(first: 20) {
        edges {
          node {
            id
            title sku quantity
            fulfillmentStatus
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
      fulfillments(first: 10) {
        status
        trackingInfo { number url }
        deliveredAt
        estimatedDeliveryAt
        fulfillmentLineItems(first: 30) {
          edges {
            node {
              quantity
              lineItem { id sku title }
            }
          }
        }
      }
      subtotalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
    }
  }
}`;

async function fetchOrdersByFullTextSearch(query: string): Promise<any[]> {
  return fetchOrdersFromShopify(query, 50);
}

// shopifyQuery is treated as a Shopify search-syntax string. We sanitize the
// caller's arbitrary substrings before they reach this function; here we just
// guard against accidental breakouts of the GraphQL string literal.
async function fetchOrdersFromShopify(shopifyQuery: string, count = 50, afterCursor?: string): Promise<any[]> {
  const token = await getAccessToken();
  const queryArg = shopifyQuery ? `, query: "${escapeGqlString(shopifyQuery)}"` : "";
  const cursorArg = afterCursor ? `, after: "${escapeGqlString(afterCursor)}"` : "";
  const gql = `{ orders(first: ${count}, sortKey: CREATED_AT, reverse: true${queryArg}${cursorArg}) ${ORDER_GQL} }`;

  const res = await fetch(shopifyApiUrl(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: gql }),
  });

  if (!res.ok) throw new Error("Shopify API request failed");
  const data = (await res.json()) as any;
  return data?.data?.orders?.edges?.map((e: any) => e.node) || [];
}

async function searchOrders(query: string, user: AuthUser) {
  const q = query.trim().toLowerCase();
  const scope = (rows: any[]) =>
    filterOrdersForUser(rows, user).map((r) => stripPrivate(r, user));

  if (!q) {
    const nodes = await fetchOrdersFromShopify("", 50);
    return scope(nodes.map(buildOrderRow));
  }

  // --- Comma-separated multi-order lookup (e.g. "EPI24737, EPI24769") ---
  if (q.includes(",")) {
    const parts = q.split(",").map((p) => p.trim()).filter(Boolean);
    const allNumeric = parts.every((p) => /^#?(epi)?(\d+)$/i.test(p));
    if (allNumeric) {
      const nums = parts.map((p) => p.replace(/^#?(epi)?/i, ""));
      const results = await Promise.all(
        nums.map((num) => fetchOrdersFromShopify(`name:#EPI${num}`))
      );
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const nodes of results) {
        for (const node of nodes) {
          if (!seen.has(node.name)) {
            seen.add(node.name);
            merged.push(node);
          }
        }
      }
      return scope(merged.map(buildOrderRow));
    }
  }

  const normalizedQ = /^0\d+$/.test(q) ? `inv-${q}` : q;

  const invMatch = normalizedQ.match(/^inv[-\s]?(\d+)$/i);
  if (invMatch) {
    const index = await getInvoiceIndex();
    const orderName = index.get(normalizedQ);
    if (!orderName) return [];
    const nodes = await fetchOrdersFromShopify(`name:${orderName}`);
    return scope(nodes.map(buildOrderRow));
  }

  const orderNumMatch = q.match(/^#?(epi)?(\d+)$/i);
  if (orderNumMatch) {
    const num = orderNumMatch[2];
    const nodes = await fetchOrdersFromShopify(`name:#EPI${num}`);
    return scope(nodes.map(buildOrderRow));
  }

  const words = q.split(/\s+/).filter(Boolean);

  function matchesQuery(row: any) {
    const haystack = [row._note, row.shipTo, row._skus, row.orderName, row.customerName].join(" ").toLowerCase();
    return words.every((word) => {
      if (word.length <= 2) {
        return new RegExp(`(?<![a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(haystack);
      }
      return haystack.includes(word);
    });
  }

  // Sanitize the user-typed query before building Shopify search-syntax strings.
  // We pass two flavours of search to Shopify: the bare term (full-text) and a
  // shipping_address wildcard match. Both must not let the user inject
  // additional Shopify query operators.
  const safeTerm = sanitizeShopifySearchTerm(query);

  const [fullTextResults, addressResults, recentOrders, notes] = await Promise.all([
    safeTerm ? fetchOrdersByFullTextSearch(safeTerm) : Promise.resolve([] as any[]),
    safeTerm ? fetchOrdersFromShopify(`shipping_address:*${safeTerm}*`, 50) : Promise.resolve([] as any[]),
    fetchOrdersFromShopify("", 250),
    getNoteIndex(),
  ]);

  const recentRows = recentOrders.map(buildOrderRow);

  const wordMatchers = words.map((word) =>
    word.length <= 2
      ? new RegExp(`(?<![a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i")
      : null
  );
  function noteMatches(noteText: string): boolean {
    return words.every((word, i) =>
      wordMatchers[i] ? wordMatchers[i]!.test(noteText) : noteText.includes(word)
    );
  }

  const noteMatchedNames: string[] = [];
  for (const [orderName, noteText] of notes.entries()) {
    if (noteMatches(noteText)) {
      noteMatchedNames.push(orderName);
    }
  }

  const recentNames = new Set(recentOrders.map((o: any) => o.name));
  const noteOnlyNames = noteMatchedNames.filter((n) => !recentNames.has(n)).slice(0, 50);
  const noteOnlyOrders = noteOnlyNames.length > 0
    ? await Promise.all(noteOnlyNames.map((name) => fetchOrdersFromShopify(`name:${name}`, 1)))
    : [];
  const noteOnlyRows = noteOnlyOrders.flat().map(buildOrderRow);

  const merged = new Map<string, any>();
  for (const node of fullTextResults) {
    const row = buildOrderRow(node);
    if (matchesQuery(row)) merged.set(node.name, row);
  }
  for (const node of addressResults) {
    const row = buildOrderRow(node);
    if (!merged.has(node.name) && matchesQuery(row)) merged.set(node.name, row);
  }
  for (const row of recentRows) {
    if (!merged.has(row.orderName) && matchesQuery(row)) merged.set(row.orderName, row);
  }
  for (const row of noteOnlyRows) {
    if (!merged.has(row.orderName) && matchesQuery(row)) merged.set(row.orderName, row);
  }

  // Apply role-based filtering before the 50-row cap so that AEs can still
  // get up to 50 of their own matches even when the wider merged set contains
  // many rows that belong to other reps.
  const filtered = filterOrdersForUser(Array.from(merged.values()), user);
  return filtered.slice(0, 50).map((r) => stripPrivate(r, user));
}

function stripPrivate(row: any, user: AuthUser) {
  const { _note, _skus, itemsText, _salesperson, ...rest } = row;
  // Salesperson is an admin/RSD-only field: AEs can look up any order but do
  // not need to see which other rep owns it.
  if (user.role === "admin" || user.role === "rsd") {
    return { ...rest, salesperson: _salesperson || null };
  }
  return rest;
}

export async function warmInvoiceIndex() {
  // Skip warm-up if Shopify is not configured (e.g. in fresh CI). The first
  // authenticated request will surface the real config error.
  if (!SHOPIFY_STORE_DOMAIN) return;
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN && !(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET)) return;
  await getInvoiceIndex();
}

// ── Auth middleware ───────────────────────────────────────────────────────────
interface AuthedRequest extends Request {
  authUser?: AuthUser;
  authToken?: string;
}

// Public projection of AuthUser: drop server-only fields (aliases) before
// sending the user object back to the browser.
function publicUser(u: AuthUser) {
  return { email: u.email, label: u.label, role: u.role };
}

function getTokenFromRequest(req: Request): string {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = getTokenFromRequest(req);
  const session = token ? getSession(token) : undefined;
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.authUser = session.user;
  req.authToken = token;
  next();
}

export function registerRoutes(_httpServer: Server, app: Express) {
  // ── Health ─────────────────────────────────────────────────────────────────
  // Cheap endpoint suitable for Railway / Render health checks. Does NOT call
  // Shopify and does NOT require authentication.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  // Compat alias
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // ── Auth: request a 6-digit OTP via email ──────────────────────────────────
  app.post("/api/auth/request-otp", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "Please enter a valid email address." });
      return;
    }
    if (!isAllowedDomain(email)) {
      res.status(403).json({
        error: "Sign-in is restricted to @epicutis.com and @signumbio.com email addresses.",
      });
      return;
    }
    const user = resolveUserForEmail(email);
    if (!user) {
      console.warn(`[auth:otp] unmatched email rejected: ${email}`);
      res.status(403).json({
        error: "This email is not on the allowlist. Ask an admin to add you.",
      });
      return;
    }
    const cooldown = canRequestOtp(email);
    if (!cooldown.ok) {
      res.status(429).json({
        error: `Please wait ${Math.ceil(cooldown.retryAfterMs / 1000)}s before requesting another code.`,
      });
      return;
    }
    const code = generateOtpCode();
    storeOtp(email, code, user);
    const result = await sendOtpEmail(email, code);
    if (!result.ok) {
      res.status(502).json({ error: result.error || "Could not send sign-in code." });
      return;
    }
    res.json({ ok: true });
  });

  // ── Auth: verify OTP, mint a session token ─────────────────────────────────
  app.post("/api/auth/verify-otp", (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    if (!email || !code) {
      res.status(400).json({ error: "Email and code are required." });
      return;
    }
    const result = verifyOtp(email, code);
    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: "No active code for this email. Request a new one.",
        expired: "That code has expired. Request a new one.",
        too_many_attempts: "Too many incorrect attempts. Request a new code.",
        wrong_code: "That code is incorrect.",
      };
      res.status(401).json({ error: messages[result.reason] || "Invalid code." });
      return;
    }
    const token = createSession(result.user);
    res.json({ token, user: publicUser(result.user) });
  });

  app.get("/api/auth/me", requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: publicUser(req.authUser!) });
  });

  app.post("/api/auth/logout", requireAuth, (req: AuthedRequest, res) => {
    if (req.authToken) deleteSession(req.authToken);
    res.json({ ok: true });
  });

  // Light diagnostic — no secrets, no PII. Useful for debugging deploys.
  // Reports presence (boolean) of each required env var so an operator can
  // verify Railway/Render config without exposing any values.
  app.get("/api/diagnostics/auth", (_req, res) => {
    res.json({
      otp: {
        enabled: true,
        provider: process.env.RESEND_API_KEY ? "resend" : "console (dev)",
        sessionTtlDays: SESSION_TTL_DAYS,
      },
      shopify: {
        storeDomainSet: Boolean(SHOPIFY_STORE_DOMAIN),
        adminAccessTokenSet: Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN),
        clientIdSet: Boolean(SHOPIFY_CLIENT_ID),
        clientSecretSet: Boolean(SHOPIFY_CLIENT_SECRET),
        apiVersion: SHOPIFY_API_VERSION,
        configured:
          Boolean(SHOPIFY_STORE_DOMAIN) &&
          (Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN) ||
            (Boolean(SHOPIFY_CLIENT_ID) && Boolean(SHOPIFY_CLIENT_SECRET))),
      },
      // Counts only — never the actual emails or aliases.
      roles: roleConfigSummary(),
    });
  });

  // ── Salesperson-matching diagnostics (admin only) ──────────────────────────
  // Scans recent orders, parses the salesperson field, and reports how
  // distinct parsed values map onto the effective alias sets of configured
  // AEs. Surfaces unmapped values so operators can quickly see which note
  // strings are slipping through and update AE_SALESPERSONS accordingly.
  //
  // Restricted to admin/RSD because the parsed salesperson values are
  // internal staff names, not customer data. No order numbers, customer
  // names, or line-item data are returned.
  app.get(
    "/api/diagnostics/salesperson-matching",
    requireAuth,
    async (req: AuthedRequest, res) => {
      const user = req.authUser!;
      if (user.role !== "admin" && user.role !== "rsd") {
        res.status(403).json({ error: "Admin only." });
        return;
      }
      if (!SHOPIFY_STORE_DOMAIN) {
        res.status(503).json({ error: "Shopify is not configured." });
        return;
      }
      try {
        const aeEntries = listAllAeEffectiveAliases();
        // Pre-flatten alias→email map for "who would match this value".
        const aliasOwners: Array<{ email: string; aliases: string[] }> =
          aeEntries.map((e) => ({ email: e.email, aliases: e.aliases }));

        // Use the recent-orders note index that we already maintain for
        // search. It is bounded and refreshed every 30 minutes.
        const recent = await fetchOrdersFromShopify("", 250);
        const valueCounts = new Map<string, number>();
        for (const node of recent) {
          const channel =
            node.channelInformation?.channelDefinition?.channelName || null;
          if (channel === "Online Store") continue;
          const parsed = parseNote(node.note);
          const raw = (parsed.salesperson || "").trim();
          if (!raw) continue;
          const norm = normalizeSalespersonValue(raw);
          if (!norm) continue;
          valueCounts.set(norm, (valueCounts.get(norm) || 0) + 1);
        }

        const mapped: Array<{ value: string; count: number; matches: string[] }> = [];
        const unmapped: Array<{ value: string; count: number }> = [];
        for (const [value, count] of valueCounts.entries()) {
          const matches: string[] = [];
          for (const owner of aliasOwners) {
            if (matchesSalesperson(value, owner.aliases)) matches.push(owner.email);
          }
          if (matches.length > 0) mapped.push({ value, count, matches });
          else unmapped.push({ value, count });
        }
        mapped.sort((a, b) => b.count - a.count);
        unmapped.sort((a, b) => b.count - a.count);

        res.json({
          scanned: recent.length,
          distinctSalespersonValues: valueCounts.size,
          mappedCount: mapped.length,
          unmappedCount: unmapped.length,
          aeConfigured: aeEntries.length,
          // Internal staff names only — never customer data.
          mapped,
          unmapped,
          // Show each AE's effective normalized aliases so an admin can see
          // exactly what strings they will match against.
          aeAliases: aeEntries,
        });
      } catch (err: any) {
        console.error("Diagnostics error:", err?.message || err);
        res
          .status(500)
          .json({ error: err?.message || "Diagnostics failed" });
      }
    },
  );

  // ── Order search (auth required) ───────────────────────────────────────────
  app.get("/api/orders/search", requireAuth, async (req: AuthedRequest, res) => {
    if (!SHOPIFY_STORE_DOMAIN) {
      res.status(503).json({
        error:
          "Shopify is not configured: SHOPIFY_STORE_DOMAIN is missing. Set it in the deploy environment.",
      });
      return;
    }
    if (
      !SHOPIFY_ADMIN_ACCESS_TOKEN &&
      !(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET)
    ) {
      res.status(503).json({
        error:
          "Shopify is not configured: set SHOPIFY_ADMIN_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
      });
      return;
    }
    try {
      const query = (req.query.q as string) || "";
      const user = req.authUser!;
      const isAe = user.role === "ae";
      const configured = isAe ? user.salespersonAliases.length > 0 : true;
      // Skip the Shopify round-trip for unconfigured AEs — they would always
      // get zero results, and we want the UI to surface "not configured"
      // promptly without paying the Shopify latency.
      const orders = isAe && !configured ? [] : await searchOrders(query, user);
      res.json({
        orders,
        scope: {
          role: user.role,
          // restricted: server narrowed the result set by role.
          restricted: isAe,
          // configured: for AEs, whether AE_SALESPERSONS has any aliases for
          // this user. Admins/RSDs are always considered configured.
          configured,
        },
      });
    } catch (err: any) {
      console.error("Search error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Search failed" });
    }
  });
}
