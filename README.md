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
| GET | `/api/orders/search?q=…` | Bearer | Searches Shopify orders. Returns `{ orders }`. |
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
  `OTP_REPLY_TO`, `RSD_EMAILS`
- `AE_SALESPERSONS` — JSON map of AE email → salesperson aliases. **Required
  for AE visibility**: AEs whose email is missing from this map (or whose
  entry has no aliases) see zero orders. Admins and RSDs ignore this map.

Secrets are only ever read from `process.env`. Do not commit them.

## Access control

Sign-in is gated by email-OTP on the allowed domains. Once signed in,
**which orders you see is decided server-side by role**, and the
`salesperson` field is restricted to admin/RSD callers regardless of how
the client is written.

| Role  | How it is granted | Order search | Sensitive fields |
| ----- | ----------------- | ------------ | ---------------- |
| admin | Listed in `ADMIN_EMAILS` (env), or in the built-in default list in `server/auth.ts`. | All orders. | Sees `salesperson` and other admin context. |
| rsd   | Listed in `RSD_EMAILS`. | All orders. | Sees `salesperson` and other admin context. |
| ae    | Default for every other allowed-domain user. | **Only orders whose salesperson matches one of the AE's aliases in `AE_SALESPERSONS`.** AEs not listed in `AE_SALESPERSONS` see zero orders. | `salesperson` column hidden. |

The `salesperson` field on each row is the 4th pipe-delimited segment of
Shopify's `order.note`:

```
INV-12345 | Acme Clinic | Reorder | Jose Villegas
```

It is added to the response **only when the caller is an admin or RSD**.
AEs never receive it. The frontend mirrors this by hiding the
`Salesperson` column for AEs, but the server is the source of truth — a
client cannot widen its own scope.

`/api/orders/search` returns a `scope` object alongside `orders`:

```json
{ "orders": [...], "scope": { "role": "ae", "restricted": true, "configured": true } }
```

- `restricted: true` means the server narrowed the result set by role
  (true for AEs, false for admin/RSD).
- `configured` is `false` for AEs whose email has no aliases in
  `AE_SALESPERSONS`. The UI uses this to show an actionable "not yet
  configured" message instead of a generic "no orders" empty state.

AEs still receive full tracking information (tracking #s, line items, ETA)
for the orders they are entitled to see.

`/api/diagnostics/auth` reports the size of each role list (counts only,
never the actual emails or aliases).

### Configuring `AE_SALESPERSONS`

`AE_SALESPERSONS` is a JSON object mapping each AE's email (lowercased)
to a list of aliases that should match the salesperson string on their
orders. Matching is normalized (case-insensitive, whitespace-collapsed)
and accepts substring matches in either direction so common spellings
("Jose Villegas", "J. Villegas", "JV") all hit.

```json
{
  "jvillegas@epicutis.com": ["Jose Villegas", "JV"],
  "rep@signumbio.com": ["Jane Doe"]
}
```

An AE whose email is missing from this map — or whose entry has no
aliases — sees zero orders (fail-closed). The UI surfaces this as a
"not configured" message so the rep knows to ask an admin to add their
aliases rather than thinking the system is broken.

## Scripts

- `npm run dev` — local development server (Vite + Express).
- `npm run check` — TypeScript typecheck.
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
