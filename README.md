# Epicutis Orders

Internal Shopify order-search tool for the Epicutis / Signum Bio team.

## Authentication

Access is gated by a 6-digit email-OTP flow (no shared password). On every
sign-in:

1. The user enters their work email. The server checks the domain
   (`@epicutis.com` / `@signumbio.com`). Any allowed-domain user can request
   a code; their role (and which fields they see) is decided server-side
   from `ADMIN_EMAILS` / `RSD_EMAILS` — see
   [Access control](#access-control) below.
2. The server emails a 6-digit code via Resend (`RESEND_API_KEY`) with a
   10-minute TTL, 5-attempt cap, and a 30-second per-email cooldown.
3. On verification, the server mints a Bearer session token (7-day sliding
   TTL, kept in process memory) which the client attaches to every API call.

The token is stored in React state only — refreshing the page logs you out.
That avoids `localStorage` / cookie footguns in iframed previews.

In **development** with no `RESEND_API_KEY`, the OTP code is logged to the
server console so you can sign in locally without email setup. In
**production**, `RESEND_API_KEY` is required; otherwise OTP requests fail.

### Auth API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/request-otp` | none | Body: `{ email }`. Sends a code if the email is on an allowed domain. |
| POST | `/api/auth/verify-otp` | none | Body: `{ email, code }`. Returns `{ token, user }`. |
| GET | `/api/auth/me` | Bearer | Returns the current `{ user }`. |
| POST | `/api/auth/logout` | Bearer | Invalidates the current token. |
| GET | `/api/diagnostics/auth` | none | Non-secret diagnostic info. |

### Order API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/orders/search?q=…` | Bearer | Searches **all** Shopify orders. Returns `{ orders }`. |
| GET | `/api/diagnostics/salesperson` | Bearer (admin/RSD) | Aggregate resolver counts. Counts only — never order or customer data. |
| GET | `/healthz` | none | Cheap liveness check (does not call Shopify). |
| GET | `/health` | none | Alias for `/healthz`. |

## Environment

See [`.env.example`](./.env.example) for the full list. Required for a working
deploy:

- `SHOPIFY_STORE_DOMAIN`
- One of:
  - `SHOPIFY_ADMIN_ACCESS_TOKEN`, **or**
  - `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`
- `RESEND_API_KEY` (production)
- Optional: `ADMIN_EMAILS`, `SHOPIFY_API_VERSION`, `OTP_FROM_ADDRESS`,
  `OTP_REPLY_TO`, `RSD_EMAILS`, `BLOCKED_EMAILS`
- Zoho Books — optional. Populates the admin/RSD-only `salesperson` column,
  which is not encoded in Shopify itself (see
  [Salesperson resolution](#salesperson-resolution) below). Order visibility
  does not depend on it:
  - `ZOHO_CLIENT_ID`
  - `ZOHO_CLIENT_SECRET`
  - `ZOHO_BOOKS_REFRESH_TOKEN` (alias `ZOHO_REFRESH_TOKEN` is also accepted)
  - `ZOHO_ORG_ID`
  - Optional: `ZOHO_ACCOUNTS_BASE`, `ZOHO_BOOKS_BASE` (set if your Zoho
    tenant is in a non-US region).

Secrets are only ever read from `process.env`. Do not commit them.

## Access control

Sign-in is gated by email-OTP on the allowed domains. Once signed in,
**every user can see and search every order.** Role does not narrow the
result set; it only controls the admin/RSD-only `salesperson` field and the
diagnostics endpoints, and it is enforced server-side regardless of how the
client is written.

Order visibility is deliberately *not* tied to rep attribution. The
salesperson recorded against an order is unreliable — frequently empty on
Zoho Books invoices, and where present often taken from the customer account
owner in arbitrary casing rather than the invoice itself. Gating on a name
match meant legitimate reps signed in and saw nothing at all.

**Revoking access — `BLOCKED_EMAILS`.** A comma-separated denylist checked
*before* the domain allowlist and all role logic. A blocked email cannot
request an OTP, cannot verify one, and any session token already issued to it
is invalidated on its next request — all three paths return `403 {"error":
"This account has been disabled."}`. This is the correct way to fully revoke
someone: removing them from `RSD_EMAILS`/`ADMIN_EMAILS` only downgrades their
role (they would still sign in as an AE), whereas `BLOCKED_EMAILS` denies
authentication outright. Example: `BLOCKED_EMAILS=abitter@epicutis.com`. The
list contents are never exposed by the diagnostics endpoints — only a count
(`roles.blockedConfigured`).

| Role  | How it is granted | Order search | Sensitive fields |
| ----- | ----------------- | ------------ | ---------------- |
| admin | Listed in `ADMIN_EMAILS` (env), or in the built-in default list in `server/auth.ts`. | All orders. | Sees `salesperson` and the diagnostics endpoints. |
| rsd   | Listed in `RSD_EMAILS`. | All orders. | Sees `salesperson` and the diagnostics endpoints. |
| ae    | Default for every other allowed-domain user. | All orders. | `salesperson` column hidden. |

The `salesperson` field on each row is resolved server-side
(see [Salesperson resolution](#salesperson-resolution) for the full
pipeline). It is added to the response **only when the caller is an admin
or RSD**. AEs never receive it. The frontend mirrors this by hiding the
`Salesperson` column for AEs, but the server is the source of truth — a
client cannot add the field back.

`/api/orders/search` returns `{ orders }`. There is no per-user scoping to
report, so there is no `scope` object.

`/api/diagnostics/auth` reports the size of each role list (counts only,
never the actual emails).

## Salesperson resolution

Live Shopify orders in this account do not carry the salesperson in any
field we can read: `order.note` pipe-segments, `customAttributes`, order
metafields, and tags are all empty for the rep on the recent sample we
checked. `staffMember` would work but requires the `read_users` scope we
don't have.

Every recent live order *does* carry Zoho cross-references as order
metafields under the `custom` namespace:

| Metafield                              | What it is                          |
| -------------------------------------- | ----------------------------------- |
| `custom.zoho_invoice`                  | Zoho Books invoice number           |
| `custom.zoho_order_reference_number`   | Zoho Books sales-order number       |

Zoho Books exposes `salesperson_name` on both invoices and sales-orders,
so the server resolves the rep for each order using whichever reference
is present. Resolution order, per row:

1. Any explicit Shopify-side salesperson — note 4th pipe-segment,
   `customAttributes.salesperson` (or common variants), or
   `metafields.custom.salesperson` / `salesperson_name`. Wins if set.
2. Zoho Books lookup by `custom.zoho_invoice` (if present), falling back
   to `custom.zoho_order_reference_number`.

Successful Zoho resolutions are cached in process memory for 6 hours; the
negative cache (no match) is 15 minutes so a Zoho correction is visible
within minutes. The cache is keyed by the reference, so the second search
that touches the same orders pays no Zoho cost. Zoho lookups are issued
with bounded concurrency (8 in flight) so a wide text search of 50 rows
that all miss the cache still resolves in a small handful of round-trips.

If Zoho is not configured, everyone still sees every order — the
`salesperson` column is simply empty for admin/RSD. The Zoho refresh-token
flow is the only secret store — refresh tokens never leave `process.env`,
access tokens only live in memory.

### Diagnostics

- `GET /api/diagnostics/auth` (unauth) reports Shopify + Zoho env
  presence (booleans only), role list sizes, and OTP provider status.
- `GET /api/diagnostics/salesperson` (admin/RSD only) reports aggregate
  counters from the caller's most recent order search — orders scanned,
  with Shopify salesperson, with Zoho refs, resolved from Zoho,
  unresolved — plus Zoho cache size. No order names, customer info,
  references, or secret values are ever exposed.

## Scripts

- `npm run dev` — local development server (Vite + Express).
- `npm run check` — TypeScript typecheck.
- `npm test` — server tests (`node:test` via `tsx`).
- `npm run build` — production bundle.
- `npm start` — run the production bundle.

## Deploy

Both `railway.json` and `render.yaml` use `/healthz` as the platform health
check so the loader never has to authenticate or hit Shopify just to keep the
service marked up.

The build relies on `tsx`, `vite`, and `esbuild`, which live in
`devDependencies`. Both deploy configs run `npm install --include=dev` so the
build still pulls them in when the platform sets `NODE_ENV=production` on the
service (which makes a bare `npm install` skip dev deps).
