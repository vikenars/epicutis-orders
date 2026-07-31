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
  isBlockedEmail,
  listConfiguredAes,
  matchesSalesperson,
  normalizeSalespersonValue,
  resolveUserForEmail,
  roleConfigSummary,
  segmentLooksLikeSalesperson,
  sendOtpEmail,
  SESSION_TTL_HOURS,
  SESSION_TTL_MS,
  storeOtp,
  verifyOtp,
} from "./auth";
import {
  isZohoConfigured,
  resolveSalespersonFromZoho,
  zohoCacheStats,
  zohoConfigSummary,
} from "./zoho";

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
  // operator adds it out of order. Prefer a labeled segment when present,
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

// Pull every Shopify-side hint that might encode a rep name. Live data shows
// these are usually empty, but if any are ever populated they should win over
// the Zoho fallback. Tried sources, in priority order:
//   1. 4th pipe-segment of order.note   (legacy desktop-import convention)
//   2. customAttributes with a likely "salesperson"-ish key
//   3. order metafields under custom.salesperson(_name)
function extractShopifySalesperson(o: any, noteSalesperson: string | null): string | null {
  if (noteSalesperson && noteSalesperson.trim()) return noteSalesperson.trim();

  const attrs: Array<{ key?: string; value?: string }> = o.customAttributes || [];
  for (const a of attrs) {
    const key = String(a?.key || "").trim().toLowerCase();
    const val = String(a?.value || "").trim();
    if (!val) continue;
    if (key === "salesperson" || key === "sales_person" || key === "sales rep" || key === "sales_rep" || key === "rep" || key === "sales-rep") {
      return val;
    }
  }

  const mfEdges: Array<{ node?: { namespace?: string; key?: string; value?: string } }> =
    o.metafields?.edges || [];
  for (const e of mfEdges) {
    const key = String(e.node?.key || "").trim().toLowerCase();
    const val = String(e.node?.value || "").trim();
    if (!val) continue;
    if (key === "salesperson" || key === "salesperson_name" || key === "sales_rep" || key === "rep") {
      return val;
    }
  }
  return null;
}

function extractZohoRefs(o: any): { invoice: string | null; salesorder: string | null } {
  const out: { invoice: string | null; salesorder: string | null } = { invoice: null, salesorder: null };
  const mfEdges: Array<{ node?: { namespace?: string; key?: string; value?: string } }> =
    o.metafields?.edges || [];
  for (const e of mfEdges) {
    const ns = String(e.node?.namespace || "").trim().toLowerCase();
    const key = String(e.node?.key || "").trim().toLowerCase();
    const val = String(e.node?.value || "").trim();
    if (!val) continue;
    if (ns !== "custom") continue;
    if (key === "zoho_invoice") out.invoice = val;
    else if (key === "zoho_order_reference_number") out.salesorder = val;
  }
  return out;
}

function buildOrderRow(o: any) {
  const channel = o.channelInformation?.channelDefinition?.channelName || null;
  const isOnlineStore = channel === "Online Store";
  const { invoiceNumber, noteCustomer, orderType, salesperson } = isOnlineStore
    ? { invoiceNumber: null, noteCustomer: null, orderType: null, salesperson: null }
    : parseNote(o.note);

  const shopifySalesperson = extractShopifySalesperson(o, salesperson);
  const zohoRefs = extractZohoRefs(o);

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
    // Salesperson surfaced by Shopify itself (note pipe-segment, customAttributes
    // or order metafield). Empty for most orders today — the Zoho fallback fills
    // in the rest via resolveSalespersonForRows().
    _shopifySalesperson: shopifySalesperson || "",
    // Final resolved salesperson (Shopify wins, then Zoho). Filled in by
    // resolveSalespersonForRows() before role-filtering / stripping happen.
    _salesperson: shopifySalesperson || "",
    _zohoInvoice: zohoRefs.invoice || "",
    _zohoSalesorder: zohoRefs.salesorder || "",
  };
}

// Attribution-only helper: does this order's resolved salesperson look like the
// given AE? Used exclusively by the admin/RSD attribution audit below. It is
// NOT an access control check — every authenticated user can see every order.
function rowAttributedToAe(row: any, normalizedAliases: string[]): boolean {
  return matchesSalesperson(String(row._salesperson || ""), normalizedAliases);
}

// Resolve salesperson for every row that does not already have a Shopify-side
// value. Uses the Zoho refs collected in buildOrderRow. Lookups are cached
// (see server/zoho.ts) so repeating searches and overlapping queries do not
// hit Zoho for the same invoice twice within the TTL. Counters returned here
// drive the admin-only diagnostics endpoint.
interface ResolveCounters {
  scanned: number;
  withShopifySalesperson: number;
  withZohoRefs: number;
  resolvedFromZoho: number;
  unresolved: number;
}

async function resolveSalespersonForRows(rows: any[]): Promise<ResolveCounters> {
  const counters: ResolveCounters = {
    scanned: rows.length,
    withShopifySalesperson: 0,
    withZohoRefs: 0,
    resolvedFromZoho: 0,
    unresolved: 0,
  };

  const toResolve: any[] = [];
  for (const r of rows) {
    if (r._shopifySalesperson) {
      counters.withShopifySalesperson += 1;
      continue;
    }
    if (r._zohoInvoice || r._zohoSalesorder) {
      counters.withZohoRefs += 1;
      toResolve.push(r);
    }
  }

  if (toResolve.length > 0 && isZohoConfigured()) {
    // Bounded concurrency — Zoho rate-limits aggressive callers and we may have
    // ~50 rows in a single search. The cache means repeat searches are nearly
    // free regardless.
    const CONCURRENCY = 8;
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < toResolve.length) {
        const row = toResolve[i++];
        try {
          const name = await resolveSalespersonFromZoho({
            invoice: row._zohoInvoice || null,
            salesorder: row._zohoSalesorder || null,
          });
          if (name) {
            row._salesperson = name;
            counters.resolvedFromZoho += 1;
          }
        } catch (err: any) {
          console.warn(`[zoho-resolve] failed for ${row.orderName}: ${err?.message || err}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toResolve.length) }, () => worker()));
  }

  for (const r of rows) {
    if (!r._salesperson) counters.unresolved += 1;
  }
  return counters;
}

// Per-session counters from the most recent searchOrders() call, keyed by the
// caller's email. Drives the admin-only diagnostics endpoint without retaining
// any order- or customer-level data.
const lastResolveByUser = new Map<string, { at: number; counters: ResolveCounters }>();

const ORDER_GQL_NODE = `{
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
  customAttributes { key value }
  metafields(first: 25, namespace: "custom") {
    edges { node { namespace key value } }
  }
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
}`;

const ORDER_GQL = `{
  edges {
    node ${ORDER_GQL_NODE}
  }
}`;

async function fetchOrdersByFullTextSearch(query: string): Promise<any[]> {
  return fetchOrdersFromShopify(query, 50);
}

// Paginated fetch used by the AE-visibility diagnostic. Reuses the same
// ORDER_GQL projection and access-token cache as the production search path
// so the simulation sees the exact same data shape. Total is bounded by the
// caller (max 1000) and each page is at most 250 (Shopify's per-page max).
async function fetchOrdersForDiagnostics(
  shopifyQuery: string,
  total: number,
): Promise<any[]> {
  const token = await getAccessToken();
  const PAGE = 250;
  const out: any[] = [];
  let cursor: string | null = null;
  while (out.length < total) {
    const pageSize = Math.min(PAGE, total - out.length);
    const queryArg = shopifyQuery ? `, query: "${escapeGqlString(shopifyQuery)}"` : "";
    const cursorArg = cursor ? `, after: "${escapeGqlString(cursor)}"` : "";
    const gql = `{ orders(first: ${pageSize}, sortKey: CREATED_AT, reverse: true${queryArg}${cursorArg}) {
      edges { cursor node ${ORDER_GQL_NODE} }
      pageInfo { hasNextPage endCursor }
    } }`;
    const res = await fetch(shopifyApiUrl(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: gql }),
    });
    if (!res.ok) throw new Error("Shopify API request failed");
    const data = (await res.json()) as any;
    const orders = data?.data?.orders;
    const edges: Array<{ cursor: string; node: any }> = orders?.edges || [];
    for (const e of edges) out.push(e.node);
    if (!orders?.pageInfo?.hasNextPage) break;
    cursor = orders.pageInfo.endCursor || null;
    if (!cursor) break;
  }
  return out;
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
  // Resolve the salesperson on each row (Shopify hints first, then Zoho) so
  // admins/RSDs get the attribution field, then strip server-only fields. The
  // result set itself is never narrowed by who is asking.
  const finalize = async (rows: any[]) => {
    const counters = await resolveSalespersonForRows(rows);
    lastResolveByUser.set(user.email, { at: Date.now(), counters });
    return rows.map((r) => stripPrivate(r, user));
  };

  if (!q) {
    const nodes = await fetchOrdersFromShopify("", 50);
    return finalize(nodes.map(buildOrderRow));
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
      return finalize(merged.map(buildOrderRow));
    }
  }

  const normalizedQ = /^0\d+$/.test(q) ? `inv-${q}` : q;

  const invMatch = normalizedQ.match(/^inv[-\s]?(\d+)$/i);
  if (invMatch) {
    const index = await getInvoiceIndex();
    const orderName = index.get(normalizedQ);
    if (!orderName) return [];
    const nodes = await fetchOrdersFromShopify(`name:${orderName}`);
    return finalize(nodes.map(buildOrderRow));
  }

  const orderNumMatch = q.match(/^#?(epi)?(\d+)$/i);
  if (orderNumMatch) {
    const num = orderNumMatch[2];
    const nodes = await fetchOrdersFromShopify(`name:#EPI${num}`);
    return finalize(nodes.map(buildOrderRow));
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

  // Resolve salesperson for the merged result set (typically <= 250 rows; the
  // Zoho cache absorbs most calls after the first search) so admins/RSDs get
  // the attribution field on each row.
  const mergedRows = Array.from(merged.values());
  const counters = await resolveSalespersonForRows(mergedRows);
  lastResolveByUser.set(user.email, { at: Date.now(), counters });

  return mergedRows.slice(0, 50).map((r) => stripPrivate(r, user));
}

function stripPrivate(row: any, user: AuthUser) {
  const {
    _note,
    _skus,
    itemsText,
    _salesperson,
    _shopifySalesperson,
    _zohoInvoice,
    _zohoSalesorder,
    ...rest
  } = row;
  // Salesperson is an admin/RSD-only *display* field (see #7). Every role can
  // look up every order; only admin/RSD are shown who the order is attributed
  // to. This is a field gate, not an access gate.
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
    if (isBlockedEmail(email)) {
      console.warn(`[auth:otp] blocked email rejected: ${email}`);
      res.status(403).json({ error: "This account has been disabled." });
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
    if (isBlockedEmail(email)) {
      console.warn(`[auth:otp] blocked email verify rejected: ${email}`);
      res.status(403).json({ error: "This account has been disabled." });
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
    res.json({ token, user: publicUser(result.user), sessionTtlMs: SESSION_TTL_MS });
  });

  // Session rehydration. requireAuth has already re-applied the denylist and
  // expiry checks and slid the window, so a 200 here means the stored token is
  // still good and the user it returns is the authoritative one — a client that
  // resumes from this response is indistinguishable from one that just signed
  // in. A 401 means the client must fall back to the sign-in screen.
  app.get("/api/auth/me", requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: publicUser(req.authUser!), sessionTtlMs: SESSION_TTL_MS });
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
        sessionTtlHours: SESSION_TTL_HOURS,
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
      zoho: zohoConfigSummary(),
    });
  });

  // Admin/RSD-only: salesperson attribution audit. Scans a bounded recent
  // sample of Shopify orders, resolves salespersons through the same
  // Zoho-aware pipeline as /api/orders/search, and reports how many orders in
  // the sample are attributable to each configured AE. Order *visibility* is
  // no longer derived from this — every authenticated user sees every order —
  // so these counts describe data quality (are rep names recorded, do they
  // match the roster?), not access.
  //
  // Never exposes order, customer, address, tracking, or invoice details.
  // Salesperson names are listed for the matched and unresolved buckets so
  // admins can spot misconfigured aliases ("Zoho says 'J Villegas' but the
  // AE_SALESPERSONS entry only has 'JV'"). Salesperson strings are internal
  // staff labels, not customer PII.
  app.get("/api/diagnostics/ae-visibility", requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "rsd") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (!SHOPIFY_STORE_DOMAIN) {
      res.status(503).json({ error: "Shopify is not configured: SHOPIFY_STORE_DOMAIN is missing." });
      return;
    }
    if (
      !SHOPIFY_ADMIN_ACCESS_TOKEN &&
      !(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET)
    ) {
      res.status(503).json({ error: "Shopify is not configured: missing access token or client credentials." });
      return;
    }

    const DEFAULT_SAMPLE = 250;
    const MAX_SAMPLE = 1000;
    const sampleRaw = Number(req.query.sample ?? DEFAULT_SAMPLE);
    const sample = Number.isFinite(sampleRaw)
      ? Math.max(1, Math.min(MAX_SAMPLE, Math.floor(sampleRaw)))
      : DEFAULT_SAMPLE;
    const q = String(req.query.q || "").trim();

    try {
      // Build Shopify search string identically to /api/orders/search when q
      // is a simple substring. We deliberately do NOT support all of the
      // multi-source merge logic here (invoice index, note index, etc.) —
      // those are search-UX features. For an audit we want a deterministic
      // recent slice. If q is given, it narrows the sample.
      const safeTerm = sanitizeShopifySearchTerm(q);
      const shopifyQuery = safeTerm ? safeTerm : "";

      const nodes = await fetchOrdersForDiagnostics(shopifyQuery, sample);
      const rows = nodes.map(buildOrderRow);
      // Resolve salesperson through the exact same pipeline as search. This
      // populates row._salesperson from Shopify hints (if any) and the Zoho
      // refs (when present), reusing the Zoho cache.
      const counters = await resolveSalespersonForRows(rows);

      // Aggregate per resolved salesperson name (lowercased). Used to build
      // a count of "orders attributable to <name>" across the sample.
      const perSalesperson = new Map<string, number>();
      for (const r of rows) {
        const name = normalizeSalespersonValue(String(r._salesperson || ""));
        if (!name) continue;
        perSalesperson.set(name, (perSalesperson.get(name) || 0) + 1);
      }

      // Per-AE attribution counts across the sample.
      const aes = listConfiguredAes();
      const aeReports = aes.map((ae) => {
        let matched = 0;
        const matchedNames = new Set<string>();
        for (const r of rows) {
          if (rowAttributedToAe(r, ae.aliases)) {
            matched += 1;
            const sp = normalizeSalespersonValue(String(r._salesperson || ""));
            if (sp) matchedNames.add(sp);
          }
        }
        return {
          email: ae.email,
          aliases: ae.aliases,
          configured: ae.aliases.length > 0,
          matchedOrderCount: matched,
          matchedSalespersonNames: Array.from(matchedNames).sort(),
        };
      });

      // Pull resolved salesperson names that did NOT match any configured AE.
      // These are typically reps who don't yet have an AE_SALESPERSONS entry
      // or whose aliases are spelled differently. Showing the names lets an
      // admin fix the roster; no order or customer data is exposed.
      const unmatchedResolvedNames: { name: string; count: number }[] = [];
      for (const [name, count] of perSalesperson.entries()) {
        const matchesAny = aes.some((ae) => rowAttributedToAe({ _salesperson: name }, ae.aliases));
        if (!matchesAny) unmatchedResolvedNames.push({ name, count });
      }
      unmatchedResolvedNames.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      res.json({
        sample: {
          requested: sample,
          scanned: counters.scanned,
          q: q || null,
        },
        resolver: {
          withShopifySalesperson: counters.withShopifySalesperson,
          withZohoRefs: counters.withZohoRefs,
          resolvedFromZoho: counters.resolvedFromZoho,
          unresolved: counters.unresolved,
        },
        zoho: { configured: zohoConfigSummary().configured, cache: zohoCacheStats() },
        aes: aeReports,
        // Salesperson names present in Zoho/Shopify but not matched by any
        // configured AE's aliases — i.e. orders attributed to a name that is
        // not on the roster. Useful for cleaning up rep attribution data.
        unmatchedResolvedNames,
      });
    } catch (err: any) {
      console.error("ae-visibility error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Diagnostics failed" });
    }
  });

  // Admin/RSD-only diagnostics for the salesperson resolver. Reports aggregate
  // counts from the caller's most recent /api/orders/search call plus the
  // Zoho cache size. No order names, customer info, references, or secrets
  // are exposed — only counts.
  app.get("/api/diagnostics/salesperson", requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "rsd") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const last = lastResolveByUser.get(user.email);
    res.json({
      zoho: zohoConfigSummary(),
      cache: zohoCacheStats(),
      lastSearch: last
        ? { atMsAgo: Date.now() - last.at, counters: last.counters }
        : null,
    });
  });

  // ── Admin: list all configured AEs (for "View As" dropdown) ───────────────
  app.get("/api/auth/ae-list", requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const aes = listConfiguredAes()
      .map((ae) => ({ email: ae.email }))
      .sort((a, b) => a.email.localeCompare(b.email));
    res.json({ aes });
  });

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
      const caller = req.authUser!;

      // Admin-only: "View As" — impersonate an AE's perspective.
      // Only affects the response shape (hides salesperson column);
      // order visibility is unchanged (all orders are always returned).
      let effectiveUser = caller;
      const viewAs = String(req.query.viewAs || "").trim().toLowerCase();
      if (viewAs && caller.role === "admin") {
        const resolved = resolveUserForEmail(viewAs);
        if (resolved) {
          effectiveUser = resolved;
        }
      }

      const orders = await searchOrders(query, effectiveUser);
      res.json({ orders, viewingAs: effectiveUser.email !== caller.email ? effectiveUser.email : undefined });
    } catch (err: any) {
      console.error("Search error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Search failed" });
    }
  });
}
