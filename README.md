# Epicutis Orders

Internal Shopify order-search tool for the Epicutis / Signum Bio team.

## Authentication

Access is gated by a 6-digit email-OTP flow (no shared password). On every
sign-in:

1. The user enters their work email. The server checks the domain
   (`@epicutis.com` / `@signumbio.com`) and the admin allowlist
   (`ADMIN_EMAILS` env, or the built-in default list).
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
| POST | `/api/auth/request-otp` | none | Body: `{ email }`. Sends a code if domain + allowlist pass. |
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
  `OTP_REPLY_TO`, `RSD_EMAILS`, `AE_SALESPERSONS`

Secrets are only ever read from `process.env`. Do not commit them.

## Access control

Every signed-in user has a role:

| Role  | Scope |
| ----- | ----- |
| admin | All orders (default for any allowlisted email). |
| rsd   | All orders. Listed in `RSD_EMAILS`. |
| ae    | Only orders whose salesperson matches one of the user's aliases in `AE_SALESPERSONS`. |

Salesperson identity is read from the **4th pipe-delimited segment** of
Shopify's `order.note`:

```
INV-12345 | Acme Clinic | Reorder | Jose Villegas
```

Matching is a case-insensitive substring check against the AE's configured
aliases. If an AE is configured with no aliases the server returns zero
orders — leave a user out of `AE_SALESPERSONS` entirely to grant admin-level
access. All filtering happens server-side; the client cannot widen its own
scope.

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
