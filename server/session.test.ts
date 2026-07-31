/**
 * Session lifetime tests.
 *
 * The portal used to ask for a fresh emailed OTP on every page load because the
 * token was never persisted. Now that it survives reloads, the guarantees that
 * matter are: a resumed session is indistinguishable from a fresh sign-in
 * (same identity, same role, same admin-only fields), the 12-hour window slides
 * with activity but really does end after 12 idle hours, and the BLOCKED_EMAILS
 * denylist is re-applied on every validation — not just at sign-in.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import test, { after, afterEach, before, describe, mock } from "node:test";
import type { AddressInfo } from "node:net";

// Env is read at module load, so it must be set before the dynamic imports.
process.env.SHOPIFY_STORE_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-token";
process.env.BLOCKED_EMAILS = "blocked@epicutis.com";

const AE_EMAIL = "khall@epicutis.com";
const ADMIN_EMAIL = "jvillegas@epicutis.com"; // built-in default admin list
const BLOCKED_EMAIL = "blocked@epicutis.com";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

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
          quantity: 1,
          fulfillmentStatus: "fulfilled",
          originalUnitPriceSet: { shopMoney: { amount: "150.00" } },
        },
      },
    ],
  },
  fulfillments: [],
  subtotalPriceSet: { shopMoney: { amount: "150.00" } },
  totalShippingPriceSet: { shopMoney: { amount: "0.00" } },
  totalPriceSet: { shopMoney: { amount: "150.00" } },
};

const realFetch = globalThis.fetch;
let baseUrl = "";
let server: import("node:http").Server;
let auth: typeof import("./auth");

before(async () => {
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
  auth = await import("./auth");
  const { registerRoutes } = await import("./routes");

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

afterEach(() => {
  mock.timers.reset();
});

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

/**
 * Drive the real OTP verification endpoint with a known code, so the resulting
 * session is minted exactly the way a genuine sign-in mints it. Only email
 * delivery is bypassed.
 */
async function signIn(email: string) {
  const user = auth.resolveUserForEmail(email);
  assert.ok(user, `expected ${email} to resolve to a user`);
  const code = auth.generateOtpCode();
  auth.storeOtp(email, code, user);
  const res = await postJson("/api/auth/verify-otp", { email, code });
  assert.equal(res.status, 200, `sign-in for ${email} should succeed`);
  return (await res.json()) as {
    token: string;
    user: { email: string; label: string; role: string };
    sessionTtlMs: number;
  };
}

// Advance wall-clock time without touching the real timers the HTTP server and
// the store's cleanup interval depend on.
function advance(ms: number) {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  mock.timers.tick(ms);
}

describe("session window", () => {
  test("the server session lasts 12 hours and reports it to the client", async () => {
    assert.equal(auth.SESSION_TTL_MS, TWELVE_HOURS_MS);
    assert.equal(auth.SESSION_TTL_HOURS, 12);

    const fresh = await signIn(ADMIN_EMAIL);
    assert.equal(fresh.sessionTtlMs, TWELVE_HOURS_MS);

    const me = (await (await get("/api/auth/me", fresh.token)).json()) as any;
    assert.equal(me.sessionTtlMs, TWELVE_HOURS_MS);
  });

  test("a session idle for more than 12 hours is rejected", async () => {
    const { token } = await signIn(AE_EMAIL);
    assert.equal((await get("/api/auth/me", token)).status, 200);

    advance(TWELVE_HOURS_MS + 60_000);

    // Nothing half-authenticated survives: rehydration and data both 401, so
    // the client lands on the sign-in screen.
    assert.equal((await get("/api/auth/me", token)).status, 401);
    assert.equal((await get("/api/orders/search?q=vivaz", token)).status, 401);
  });

  test("activity slides the window forward", async () => {
    const { token } = await signIn(AE_EMAIL);

    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    // Two 11-hour gaps: 22 hours after sign-in, and still valid, because the
    // request at the 11-hour mark reset the clock.
    mock.timers.tick(11 * 60 * 60 * 1000);
    assert.equal((await get("/api/auth/me", token)).status, 200);
    mock.timers.tick(11 * 60 * 60 * 1000);
    assert.equal((await get("/api/auth/me", token)).status, 200);

    // A third gap with no activity in it does end the session.
    mock.timers.tick(TWELVE_HOURS_MS + 60_000);
    assert.equal((await get("/api/auth/me", token)).status, 401);
  });

  test("signing out invalidates the token immediately", async () => {
    const { token } = await signIn(AE_EMAIL);
    assert.equal((await postJson("/api/auth/logout", {})).status, 401);

    const res = await realFetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal((await get("/api/auth/me", token)).status, 401);
  });
});

describe("a rehydrated session matches a fresh sign-in", () => {
  for (const [label, email, expectedRole] of [
    ["admin", ADMIN_EMAIL, "admin"],
    ["AE", AE_EMAIL, "ae"],
  ] as const) {
    test(`${label}: identity and role survive rehydration`, async () => {
      const fresh = await signIn(email);
      assert.equal(fresh.user.role, expectedRole);

      // What the client does on reload: replay the stored token at /api/auth/me.
      const res = await get("/api/auth/me", fresh.token);
      assert.equal(res.status, 200);
      const rehydrated = (await res.json()) as any;
      assert.deepEqual(rehydrated.user, fresh.user);
    });
  }

  test("the salesperson field follows the role, not the sign-in path", async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const ae = await signIn(AE_EMAIL);

    // Rehydrate both, then read data with the resumed tokens.
    assert.equal((await get("/api/auth/me", admin.token)).status, 200);
    assert.equal((await get("/api/auth/me", ae.token)).status, 200);

    const adminBody = (await (await get("/api/orders/search?q=vivaz", admin.token)).json()) as any;
    assert.equal(adminBody.orders[0].salesperson, "Jose Villegas");

    const aeBody = (await (await get("/api/orders/search?q=vivaz", ae.token)).json()) as any;
    assert.equal("salesperson" in aeBody.orders[0], false);

    // Admin-only routes stay admin-only after a resume.
    assert.equal((await get("/api/diagnostics/salesperson", admin.token)).status, 200);
    assert.equal((await get("/api/diagnostics/salesperson", ae.token)).status, 403);
  });
});

describe("BLOCKED_EMAILS survives a longer-lived session", () => {
  test("a blocked address is refused at sign-in", async () => {
    const requested = await postJson("/api/auth/request-otp", { email: BLOCKED_EMAIL });
    assert.equal(requested.status, 403);
    assert.equal(((await requested.json()) as any).error, "This account has been disabled.");

    const verified = await postJson("/api/auth/verify-otp", { email: BLOCKED_EMAIL, code: "123456" });
    assert.equal(verified.status, 403);
    assert.equal(((await verified.json()) as any).error, "This account has been disabled.");
  });

  test("a session held by a blocked address is refused at validation time", async () => {
    // A token issued before the address was blocked: the denylist is re-checked
    // on every request, so the stored session dies on its next use rather than
    // riding out the remaining hours.
    const token = auth.createSession({ email: BLOCKED_EMAIL, label: BLOCKED_EMAIL, role: "ae" });
    assert.equal((await get("/api/auth/me", token)).status, 401);
    assert.equal((await get("/api/orders/search?q=vivaz", token)).status, 401);
  });
});
