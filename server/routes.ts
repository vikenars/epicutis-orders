import type { Express } from "express";
import type { Server } from "http";

const SHOPIFY_STORE = "new-epicutis.myshopify.com";
const SHOPIFY_CLIENT_ID = "deb0bbbfe0cc41d08708460b66c3f8e5";
const SHOPIFY_CLIENT_SECRET = "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";

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

// --- Invoice index ---
// Maps invoice number (lowercase, e.g. "inv-078968") → order name (e.g. "#EPI24831")
// Built lazily on first invoice search, then refreshed every 30 minutes.
let invoiceIndex: Map<string, string> | null = null;
let invoiceIndexBuiltAt = 0;
let invoiceIndexBuilding: Promise<void> | null = null;
const INVOICE_INDEX_TTL = 30 * 60 * 1000; // 30 minutes

async function getInvoiceIndex(): Promise<Map<string, string>> {
  const now = Date.now();
  if (invoiceIndex && now - invoiceIndexBuiltAt < INVOICE_INDEX_TTL) return invoiceIndex;
  // If already building, wait for it
  if (invoiceIndexBuilding) { await invoiceIndexBuilding; return invoiceIndex!; }

  invoiceIndexBuilding = (async () => {
    const token = await getAccessToken();
    const index = new Map<string, string>();
    let cursor: string | null = null;
    let hasMore = true;
    const batchSize = 10; // fetch 10 pages in parallel at a time

    // First pass: get total page count via a single query
    while (hasMore) {
      // Fetch up to batchSize pages in parallel
      const cursors: (string | null)[] = [cursor];
      // We don't know future cursors yet, so fetch sequentially with parallel batching:
      // Fetch one page, get its endCursor, then do next batch
      const pagePromises: Promise<{ names: [string, string][]; nextCursor: string | null; hasNext: boolean }>[] = [];

      // Simple sequential pagination — 96 pages × ~150ms = ~15s on first search
      const gql = `{ orders(first: 250${cursor ? `, after: "${cursor}"` : ""}, sortKey: CREATED_AT, reverse: true) {
        edges { node { name note } }
        pageInfo { hasNextPage endCursor }
      } }`;

      const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query: gql }),
      });
      const data = (await res.json()) as any;
      const orders = data.data?.orders;
      for (const edge of orders?.edges || []) {
        const { name, note } = edge.node;
        if (note) {
          // Parse INV-XXXXXX from note (format: "INV-XXXXXX | Customer | Type")
          const match = note.match(/inv[-\s]?(\d+)/i);
          if (match) index.set(`inv-${match[1]}`, name);
        }
      }
      hasMore = orders?.pageInfo?.hasNextPage;
      cursor = orders?.pageInfo?.endCursor || null;
    }

    invoiceIndex = index;
    invoiceIndexBuiltAt = Date.now();
    console.log(`[invoice-index] Built: ${index.size} invoices indexed`);
  })();

  await invoiceIndexBuilding;
  invoiceIndexBuilding = null;
  return invoiceIndex!;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
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
  if (!note || !note.trim()) return { invoiceNumber: null, noteCustomer: null, orderType: null };
  const parts = note.split("|").map((p) => p.trim());
  return {
    invoiceNumber: parts[0] || null,
    noteCustomer: parts[1] || null,
    orderType: parts[2] || null,
  };
}

function formatCurrency(amount: string) {
  const num = parseFloat(amount);
  return num === 0 ? "$0" : `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function buildFulfillmentMap(fulfillments: any[]): Map<string, { trackingNumber: string | null; trackingUrl: string | null; estDelivery: string | null }> {
  // Maps lineItem id → tracking info from the fulfillment that contains it
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
  const { invoiceNumber, noteCustomer, orderType } = isOnlineStore
    ? { invoiceNumber: null, noteCustomer: null, orderType: null }
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

  const shipToName = o.shippingAddress
    ? `${o.shippingAddress.firstName} ${o.shippingAddress.lastName}`.trim()
    : null;
  const customerName = o.customer?.displayName || noteCustomer || shipToName || "—";

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
    // Raw fields for client-side filtering
    _note: o.note || "",
    _skus: lineItems.map((li: any) => `${li.sku || ""} ${li.title || ""}`).join(" "),
  };
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

// Searches Shopify's full-text order index (catches B2B orders where customer name
// isn't in the note or shipping address). Returns nodes ready for buildOrderRow.
async function fetchOrdersByFullTextSearch(query: string): Promise<any[]> {
  // Shopify's bare query searches across customer name, email, note, address, etc.
  return fetchOrdersFromShopify(query, 50);
}

async function fetchOrdersFromShopify(shopifyQuery: string, count = 50): Promise<any[]> {
  const token = await getAccessToken();
  const queryArg = shopifyQuery ? `, query: "${shopifyQuery}"` : "";
  const gql = `{ orders(first: ${count}, sortKey: CREATED_AT, reverse: true${queryArg}) ${ORDER_GQL} }`;

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: gql }),
  });

  if (!res.ok) throw new Error("Shopify API request failed");
  const data = (await res.json()) as any;
  return data?.data?.orders?.edges?.map((e: any) => e.node) || [];
}

async function searchOrders(query: string) {
  const q = query.trim().toLowerCase();

  if (!q) {
    // No query — return 50 most recent
    const nodes = await fetchOrdersFromShopify("", 50);
    return nodes.map(buildOrderRow).map(stripPrivate);
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
      return merged.map(buildOrderRow).map(stripPrivate);
    }
  }

  // If the query starts with "0" (like "078976"), treat it as an invoice number with INV- prefix
  // This check must come BEFORE the order number check (which would also match bare digits)
  const normalizedQ = /^0\d+$/.test(q) ? `inv-${q}` : q;

  // Check if it looks like an invoice number (INV-XXXXXX)
  const invMatch = normalizedQ.match(/^inv[-\s]?(\d+)$/i);
  if (invMatch) {
    // Use the full invoice index (covers all historical orders, not just recent 250)
    const index = await getInvoiceIndex();
    const orderName = index.get(normalizedQ); // e.g. "#EPI24831"
    if (!orderName) return [];
    // Fetch the full order data by name
    const nodes = await fetchOrdersFromShopify(`name:${orderName}`);
    return nodes.map(buildOrderRow).map(stripPrivate);
  }

  // Check if it looks like an order number (digits, optionally prefixed with EPI or #)
  const orderNumMatch = q.match(/^#?(epi)?(\d+)$/i);
  if (orderNumMatch) {
    const num = orderNumMatch[2];
    const nodes = await fetchOrdersFromShopify(`name:#EPI${num}`);
    return nodes.map(buildOrderRow).map(stripPrivate);
  }

  // General keyword — three parallel strategies:
  // 1. Shopify full-text search (covers customer name, email, B2B orders, etc.)
  // 2. Shopify shipping_address filter
  // 3. Local scan of 250 recent orders filtered by note/shipTo/SKU
  const [fullTextResults, addressResults, recentOrders] = await Promise.all([
    fetchOrdersByFullTextSearch(query),
    fetchOrdersFromShopify(`shipping_address:*${query}*`, 50),
    fetchOrdersFromShopify("", 250),
  ]);

  const recentRows = recentOrders.map(buildOrderRow);

  // Split query into words — ALL words must appear in the haystack (AND logic)
  const words = q.split(/\s+/).filter(Boolean);

  function matchesQuery(row: any) {
    const haystack = [row._note, row.shipTo, row._skus, row.orderName].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  }

  const noteFiltered = recentRows.filter((r) => matchesQuery(r));

  // Merge: full-text Shopify results first (most relevant), then address, then local note matches
  // Full-text results are trusted from Shopify so we don't apply the local AND filter to them
  const merged = new Map<string, any>();
  for (const node of fullTextResults) {
    merged.set(node.name, buildOrderRow(node));
  }
  for (const node of addressResults) {
    const row = buildOrderRow(node);
    if (!merged.has(node.name) && matchesQuery(row)) merged.set(node.name, row);
  }
  for (const row of noteFiltered) {
    if (!merged.has(row.orderName)) merged.set(row.orderName, row);
  }

  return Array.from(merged.values()).slice(0, 50).map(stripPrivate);
}

function stripPrivate(row: any) {
  const { _note, _skus, itemsText, ...rest } = row;
  return rest;
}

export async function warmInvoiceIndex() {
  await getInvoiceIndex();
}

export function registerRoutes(httpServer: Server, app: Express) {
  app.get("/api/orders/search", async (req, res) => {
    try {
      const query = (req.query.q as string) || "";
      const orders = await searchOrders(query);
      res.json({ orders });
    } catch (err: any) {
      console.error("Search error:", err);
      res.status(500).json({ error: err.message || "Search failed" });
    }
  });
}
