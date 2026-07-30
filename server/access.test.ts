/**
 * Order visibility + authentication boundary tests.
 *
 * The central guarantee: an authenticated user sees every order regardless of
 * whether the salesperson recorded on it resembles their name. Authentication
 * itself (domain gate, OTP, BLOCKED_EMAILS denylist) and the admin/RSD-only
 * field and route gates must stay intact.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import test, { after, before, describe } from "node:test";
import type { AddressInfo } from "node:net";

// Env is read at module load, so it must be set before the dynamic imports.
process.env.SHOPIFY_STORE_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-token";
process.env.BLOCKED_EMAILS = "blocked@epicutis.com";
// Katie Hall's real-world shape: she has a roster entry, but the salesperson
// recorded on the orders ("Jose Villegas") does not resemble it.
process.env.AE_SALESPERSONS = JSON.stringify({
  "khall@epicutis.com": ["Katie Hall"],
});

const AE_EMAIL = "khall@epicutis.com";
const ADMIN_EMAIL = "jvillegas@epicutis.com"; // built-in default admin list
const BLOCKED_EMAIL = "blocked@epicutis.com";

const SHOPIFY_ORDER = {
  name: "#EPI24831",
  createdAt: "2026-05-01T12:00:00Z",
  displayFulfillmentStatus: "FULFILLED",
  note: "INV-078968 | Vivaz Med Spa | Reorder | Jose Villegas",
  customer: { displayName: "Vivaz Med Spa" },
  shippingAddress: {
    firstName: "Vivaz",
    lastName: "Med Spa",
    address1: "1 Main St",
    city: "Austin",
    provinceCode: "TX",
    zip: "78701",
  },
  lineItems: {
    edges: [
      {
        node: {
          id: "gid://shopify/LineItem/1",
          title: "Epicutis Lipid Serum",
          sku: "EPI-LS-1",
          quantity: 2,
          fulfillmentStatus: "fulfilled",
          originalUnitPriceSet: { shopMoney: { amount: "150.00" } },
        },
      },
    ],
  },
  fulfillments: [],
  subtotalPriceSet: { shopMoney: { amount: "300.00" } },
  totalShippingPriceSet: { shopMoney: { amount: "0.00" } },
  totalPriceSet: { shopMoney: { amount: "300.00" } },
};

const realFetch = globalThis.fetch;
let baseUrl = "";
let server: import("node:http").Server;
let createSession: (typeof import("./auth"))["createSession"];
let resolveUserForEmail: (typeof import("./auth"))["resolveUserForEmail"];

before(async () => {
  // Answer every Shopify GraphQL call with the same single-order page, and let
  // requests to our own test server through untouched.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (!url.includes("myshopify.com")) return realFetch(input, init);
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            edges: [{ cursor: "c1", node: SHOPIFY_ORDER }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const express = (await import("express")).default;
  const auth = await import("./auth");
  const { registerRoutes } = await import("./routes");
  createSession = auth.createSession;
  resolveUserForEmail = auth.resolveUserForEmail;

  const app = express();
  app.use(express.json());
  registerRoutes(null as any, app);
  server = app.listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
});

function tokenFor(email: string): string {
  const user = resolveUserForEmail(email);
  assert.ok(user, `expected ${email} to resolve to a user`);
  return createSession(user);
}

function get(path: string, token?: string) {
  return realFetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function postJson(path: string, body: unknown) {
  return realFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("order visibility", () => {
  test("an AE whose aliases match no salesperson still gets full results", async () => {
    const user = resolveUserForEmail(AE_EMAIL)!;
    assert.equal(user.role, "ae");

    const res = await get(`/api/orders/search?q=vivaz`, tokenFor(AE_EMAIL));
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    // The order's salesperson is "Jose Villegas"; Katie's roster alias is
    // "Katie Hall". Under the old fail-closed filter this was an empty list.
    assert.equal(body.orders.length, 1);
    assert.equal(body.orders[0].orderName, "#EPI24831");
    // No per-caller scope signal is sent any more — results do not depend on
    // who is asking, so there is nothing to qualify them with.
    assert.equal(body.scope, undefined);
  });

  test("an AE with no roster entry at all gets the same results", async () => {
    const res = await get(`/api/orders/search?q=vivaz`, tokenFor("newhire@signumbio.com"));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).orders.length, 1);
  });

  test("AE and admin see the same orders", async () => {
    const [aeBody, adminBody] = await Promise.all([
      get(`/api/orders/search?q=vivaz`, tokenFor(AE_EMAIL)).then((r) => r.json() as any),
      get(`/api/orders/search?q=vivaz`, tokenFor(ADMIN_EMAIL)).then((r) => r.json() as any),
    ]);
    assert.deepEqual(
      aeBody.orders.map((o: any) => o.orderName),
      adminBody.orders.map((o: any) => o.orderName),
    );
  });

  test("blank query returns recent orders for an AE", async () => {
    const res = await get(`/api/orders/search?q=`, tokenFor(AE_EMAIL));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).orders.length, 1);
  });
});

describe("authentication is still enforced", () => {
  test("unauthenticated order search is rejected", async () => {
    const res = await get(`/api/orders/search?q=vivaz`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as any).error, "Unauthorized");
  });

  test("a bogus bearer token is rejected", async () => {
    const res = await get(`/api/orders/search?q=vivaz`, "not-a-real-token");
    assert.equal(res.status, 401);
  });

  test("sign-in stays restricted to the allowed domains", async () => {
    const res = await postJson("/api/auth/request-otp", { email: "outsider@gmail.com" });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as any).error, /restricted to @epicutis\.com/);
    assert.equal(resolveUserForEmail("outsider@gmail.com"), null);
  });
});

describe("BLOCKED_EMAILS denylist", () => {
  test("a blocked address cannot request an OTP", async () => {
    const res = await postJson("/api/auth/request-otp", { email: BLOCKED_EMAIL });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).error, "This account has been disabled.");
  });

  test("a blocked address cannot verify an OTP", async () => {
    const res = await postJson("/api/auth/verify-otp", { email: BLOCKED_EMAIL, code: "123456" });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).error, "This account has been disabled.");
  });

  test("matching is case-insensitive and does not resolve a user", async () => {
    const res = await postJson("/api/auth/request-otp", { email: "BLOCKED@epicutis.com" });
    assert.equal(res.status, 403);
    assert.equal(resolveUserForEmail(BLOCKED_EMAIL), null);
  });

  test("an already-issued session for a blocked address stops working", async () => {
    const token = createSession({ email: BLOCKED_EMAIL, label: BLOCKED_EMAIL, role: "ae" });
    const res = await get(`/api/orders/search?q=vivaz`, token);
    assert.equal(res.status, 401);
  });
});

describe("role gates are unchanged", () => {
  test("salesperson is sent to admins and withheld from AEs", async () => {
    const adminBody = (await (await get(`/api/orders/search?q=vivaz`, tokenFor(ADMIN_EMAIL))).json()) as any;
    assert.equal(adminBody.orders[0].salesperson, "Jose Villegas");

    const aeBody = (await (await get(`/api/orders/search?q=vivaz`, tokenFor(AE_EMAIL))).json()) as any;
    assert.equal("salesperson" in aeBody.orders[0], false);
  });

  test("diagnostics routes stay admin/RSD-only", async () => {
    for (const path of ["/api/diagnostics/ae-visibility", "/api/diagnostics/salesperson"]) {
      assert.equal((await get(path, tokenFor(AE_EMAIL))).status, 403, path);
      assert.equal((await get(path)).status, 401, path);
      assert.equal((await get(path, tokenFor(ADMIN_EMAIL))).status, 200, path);
    }
  });

  test("the attribution audit still reports unmatched rep names", async () => {
    const res = await get(`/api/diagnostics/ae-visibility?sample=1`, tokenFor(ADMIN_EMAIL));
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const katie = body.aes.find((a: any) => a.email === AE_EMAIL);
    // Attribution still says the order is not hers — and she can still see it.
    assert.equal(katie.matchedOrderCount, 0);
    assert.deepEqual(body.unmatchedResolvedNames, [{ name: "jose villegas", count: 1 }]);
  });
});
