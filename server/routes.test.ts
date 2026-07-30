/**
 * Order visibility + auth tests for /api/orders/search.
 *
 * The regression these lock down: order search used to be filtered by the
 * requesting user's salesperson aliases, so a legitimate rep whose name did
 * not match the (frequently empty or oddly-cased) salesperson recorded on the
 * order saw zero results. Every authenticated user must now reach every order.
 */

// Env is read at module load in auth.ts / routes.ts, so it must be set before
// the dynamic imports below.
process.env.ADMIN_EMAILS = "bstock@signumbio.com";
process.env.RSD_EMAILS = "";
process.env.SHOPIFY_STORE_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-token";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import express from "express";

const { createSession, resolveUserForEmail } = await import("./auth");
const { registerRoutes } = await import("./routes");

// An order attributed to a rep who is nobody's alias match. Katie Hall
// (khall@epicutis.com) has no relationship to "Jose Villegas" under any
// name-matching scheme, which is precisely the point.
const ORDER_NAME = "#EPI24831";
const ORDER_NOTE = "INV-078968 | Vivaz Med Spa | Reorder | salesperson: Jose Villegas";

function orderNode() {
  return {
    name: ORDER_NAME,
    createdAt: "2026-05-01T00:00:00Z",
    displayFulfillmentStatus: "FULFILLED",
    channelInformation: { channelDefinition: { channelName: "Draft Orders" } },
    customer: { displayName: "Vivaz Med Spa" },
    billingAddress: { firstName: "Vivaz", lastName: "Med Spa" },
    shippingAddress: {
      firstName: "Vivaz", lastName: "Med Spa", address1: "1 Main St",
      address2: null, city: "Austin", provinceCode: "TX", zip: "78701",
    },
    note: ORDER_NOTE,
    customAttributes: [],
    metafields: { edges: [] },
    lineItems: {
      edges: [{
        node: {
          id: "gid://li/1", title: "Epicutis Lipid Serum", sku: "ELS-30",
          quantity: 2, fulfillmentStatus: "fulfilled",
          originalUnitPriceSet: { shopMoney: { amount: "150.00" } },
        },
      }],
    },
    fulfillments: [],
    subtotalPriceSet: { shopMoney: { amount: "300.00" } },
    totalShippingPriceSet: { shopMoney: { amount: "0.00" } },
    totalPriceSet: { shopMoney: { amount: "300.00" } },
  };
}

// Stand in for the Shopify GraphQL Admin API. Two query shapes reach it: the
// lightweight name+note scan that builds the invoice/note index, and the full
// order projection used by every search path.
function installShopifyStub() {
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init: any) => {
    if (!String(url).includes("myshopify.com")) return realFetch(url, init);
    const gql = String(JSON.parse(init.body).query);
    const isFullProjection = gql.includes("displayFulfillmentStatus");
    const node = isFullProjection ? orderNode() : { name: ORDER_NAME, note: ORDER_NOTE };
    return {
      ok: true,
      json: async () => ({
        data: {
          orders: {
            edges: [{ cursor: "c1", node }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    };
  };
}

let server: Server;
let baseUrl: string;

before(async () => {
  installShopifyStub();
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

function tokenFor(email: string): string {
  const user = resolveUserForEmail(email);
  assert.ok(user, `expected ${email} to resolve to a user`);
  return createSession(user);
}

async function search(query: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/api/orders/search?q=${encodeURIComponent(query)}`, { headers });
  return { status: res.status, body: (await res.json()) as any };
}

test("an AE whose name matches no salesperson on the order still gets results", async () => {
  const user = resolveUserForEmail("khall@epicutis.com");
  assert.equal(user?.role, "ae");

  const { status, body } = await search("Vivaz", tokenFor("khall@epicutis.com"));
  assert.equal(status, 200);
  assert.equal(body.orders.length, 1);
  assert.equal(body.orders[0].orderName, ORDER_NAME);
});

test("an AE and an admin see the same orders", async () => {
  const ae = await search("Vivaz", tokenFor("khall@epicutis.com"));
  const admin = await search("Vivaz", tokenFor("bstock@signumbio.com"));
  assert.deepEqual(
    ae.body.orders.map((o: any) => o.orderName),
    admin.body.orders.map((o: any) => o.orderName),
  );
});

test("the salesperson field stays admin/RSD-only", async () => {
  const ae = await search("Vivaz", tokenFor("khall@epicutis.com"));
  assert.equal(ae.body.orders[0].salesperson, undefined);

  const admin = await search("Vivaz", tokenFor("bstock@signumbio.com"));
  assert.equal(admin.body.orders[0].salesperson, "Jose Villegas");
});

test("an unauthenticated search is rejected", async () => {
  const { status, body } = await search("Vivaz");
  assert.equal(status, 401);
  assert.equal(body.error, "Unauthorized");
  assert.equal(body.orders, undefined);
});

test("a bogus bearer token is rejected", async () => {
  const { status } = await search("Vivaz", "not-a-real-session-token");
  assert.equal(status, 401);
});

test("sign-in remains restricted to the allowed email domains", async () => {
  assert.equal(resolveUserForEmail("stranger@gmail.com"), null);
});
