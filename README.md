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
| GET | `/api/diagnostics/salesperson` | Bearer (admin/RSD) | Aggregate resolver counts. Counts only — never order or customer data. |
| GET | `/api/diagnostics/ae-visibility` | Bearer (admin/RSD) | Per-AE visibility audit (see [AE visibility audit](#ae-visibility-audit)). |
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
- `AE_SALESPERSONS` — JSON map of AE email → salesperson aliases. **Required
  for AE visibility**: AEs whose email is missing from this map (or whose
  entry has no aliases) see zero orders. Admins and RSDs ignore this map.
- Zoho Books — **required for AE visibility on the live store**, where the
  salesperson is not encoded in Shopify itself (see
  [Salesperson resolution](#salesperson-resolution) below):
  - `ZOHO_CLIENT_ID`
  - `ZOHO_CLIENT_SECRET`
  - `ZOHO_BOOKS_REFRESH_TOKEN` (alias `ZOHO_REFRESH_TOKEN` is also accepted)
  - `ZOHO_ORG_ID`
  - Optional: `ZOHO_ACCOUNTS_BASE`, `ZOHO_BOOKS_BASE` (set if your Zoho
    tenant is in a non-US region).

Secrets are only ever read from `process.env`. Do not commit them.

## Access control

Sign-in is gated by email-OTP on the allowed domains. Once signed in,
**which orders you see is decided server-side by role**, and the
`salesperson` field is restricted to admin/RSD callers regardless of how
the client is written.

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
| admin | Listed in `ADMIN_EMAILS` (env), or in the built-in default list in `server/auth.ts`. | All orders. | Sees `salesperson` and other admin context. |
| rsd   | Listed in `RSD_EMAILS`. | All orders. | Sees `salesperson` and other admin context. |
| ae    | Default for every other allowed-domain user. | **Only orders whose salesperson matches one of the AE's aliases in `AE_SALESPERSONS`.** AEs not listed in `AE_SALESPERSONS` see zero orders. | `salesperson` column hidden. |

The `salesperson` field on each row is resolved server-side
(see [Salesperson resolution](#salesperson-resolution) for the full
pipeline). It is added to the response **only when the caller is an admin
or RSD**. AEs never receive it. The frontend mirrors this by hiding the
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
to a list of aliases that should match the salesperson string Zoho or
Shopify records on their orders.

```json
{
  "jvillegas@epicutis.com": ["Jose Villegas", "JV"],
  "rep@signumbio.com": ["Jane Doe"]
}
```

#### Matching rules

Before comparing, both sides are normalized: NFKD diacritic strip
(`José` → `Jose`), parenthetical removal (`Jose Villegas (Epicutis)` →
`Jose Villegas`), label stripping (`Salesperson: Jose Villegas`,
`Rep — Jose`, `AE: Jose`), all non-alphanumerics collapsed to single
spaces, lowercased. An AE matches a row when, for their effective
normalized alias set `A` and the normalized resolved salesperson `v`:

1. `v === a` for some `a ∈ A`, **or**
2. all tokens of some `a ∈ A` are present in `v`'s token set, **or**
3. all tokens of `v` are present in some `a`'s token set, **or**
4. `a` is a single token of ≥2 chars and `a ∈ tokens(v)`.

The effective alias set is the configured aliases plus aliases derived
from the email local part — `jvillegas@…` adds `jvillegas`,
`j villegas`, `villegas j`; `first.last@…` adds `first last`, `last
first`, `f last`, `last`. Surname-only is **not** derived from
`flast`-style locals to avoid over-matching common surnames; list it
explicitly in `AE_SALESPERSONS` if you want it.

Examples (configured `["Jose Villegas","JV"]` + email
`jvillegas@epicutis.com`):

- `Jose Villegas` ✅
- `VILLEGAS, JOSE` ✅
- `Salesperson: Jose Villegas` ✅
- `Jose Villegas (Epicutis)` ✅
- `J. Villegas` ✅
- `JV` ✅
- `jvillegas` ✅
- `Bob Stock` ❌

An AE whose email is missing from this map — or whose entry has no
aliases — sees zero orders (fail-closed). The UI surfaces this as a
"not configured" message so the rep knows to ask an admin to add their
aliases rather than thinking the system is broken.

#### Nickname expansions

A small built-in table in `server/auth.ts`
(`EMAIL_NICKNAME_ALIASES`) adds nicknames for AEs where production data
shows Zoho/Shopify uses a form the configured aliases and email-derived
aliases would not otherwise catch (e.g. `Mel Federico` on Melissa
Federico's orders). **Only add entries here with explicit production
evidence** — do not guess nicknames. Prefer extending
`AE_SALESPERSONS` from the deploy environment when possible; the
nickname table exists for the cases where the canonical email already
encodes the formal first name.

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

If Zoho is not configured, AEs effectively see no orders (the
fail-closed behaviour); admin/RSD still see all orders, just without a
populated `salesperson` column. The Zoho refresh-token flow is the only
secret store — refresh tokens never leave `process.env`, access tokens
only live in memory.

### Diagnostics

- `GET /api/diagnostics/auth` (unauth) reports Shopify + Zoho env
  presence (booleans only), role list sizes, and OTP provider status.
- `GET /api/diagnostics/salesperson` (admin/RSD only) reports aggregate
  counters from the caller's most recent order search — orders scanned,
  with Shopify salesperson, with Zoho refs, resolved from Zoho,
  unresolved — plus Zoho cache size. No order names, customer info,
  references, or secret values are ever exposed.

### AE visibility audit

Before launching the tool to a new AE — or after editing
`AE_SALESPERSONS` — admins/RSDs can confirm that every configured AE
will see the orders they should, *without* signing in as them.

```
GET /api/diagnostics/ae-visibility?sample=250&q=
Authorization: Bearer <admin-or-rsd-token>
```

The endpoint scans a bounded recent slice of Shopify orders (`sample`
defaults to 250, max 1000), runs the orders through the **exact same**
salesperson resolver and the **exact same** AE matcher used by
`/api/orders/search`, and reports per-AE aggregates only:

```json
{
  "sample":   { "requested": 250, "scanned": 250, "q": null },
  "resolver": { "withShopifySalesperson": 0, "withZohoRefs": 248, "resolvedFromZoho": 246, "unresolved": 4 },
  "zoho":     { "configured": true, "cache": { "size": 246, "positive": 246, "negative": 0 } },
  "aes": [
    {
      "email": "jvillegas@epicutis.com",
      "aliases": ["jose villegas", "jv"],
      "configured": true,
      "matchedOrderCount": 38,
      "matchedSalespersonNames": ["jose villegas"]
    }
  ],
  "unmatchedResolvedNames": [ { "name": "k. ramirez", "count": 17 } ]
}
```

What admins do with it:

- `matchedOrderCount = 0` for an AE who *should* see orders → their
  aliases in `AE_SALESPERSONS` do not match what Zoho returns. Compare
  `aliases` against `matchedSalespersonNames` from another AE or against
  `unmatchedResolvedNames` to find the spelling Zoho actually uses.
- `unmatchedResolvedNames` lists real reps that no AE is configured for
  — every name here is an order that no AE would see. Add an
  `AE_SALESPERSONS` entry for each one before launch.
- `resolver.unresolved` tells you how many orders in the sample lack
  both a Shopify-side salesperson hint and a working Zoho lookup; those
  orders fall to zero AEs by definition.
- `q` accepts a substring (e.g. an order name prefix) to narrow the
  sample to a specific area; useful for spot-checking after fixing one
  AE's aliases.

The endpoint never returns order IDs, customer names, addresses,
tracking, or invoice/sales-order numbers. Salesperson names are
internal staff labels resolved from Zoho — they appear so the admin can
diff them against `AE_SALESPERSONS` aliases. The Zoho cache is shared
with the production search path, so running this audit will not double
the load on Zoho if a search ran in the same TTL window.

### Known unmapped Zoho salesperson values (operator notes)

A production audit (`/api/diagnostics/ae-visibility?sample=1000`,
2026-05-19) surfaced the following resolved Zoho salesperson values
that did not correspond to any configured AE. Some are admins, RSDs,
or inside-sales aliases where no AE mapping is expected. Others are
real reps without an `AE_SALESPERSONS` entry — those AEs will see
zero orders until an entry is added.

Reps that may need an `AE_SALESPERSONS` entry. Do **not** guess emails;
ask the rep (or HR) for the canonical work email before adding:

| Zoho salesperson | Observed count | Action |
| --- | --- | --- |
| Sheila McCrink | 12 | Confirm work email, add `AE_SALESPERSONS["<email>"] = ["Sheila McCrink"]`. |
| Alma Hernandez-Gonzalez | 4 | Confirm work email. Hyphen is preserved by the normalizer as a space, so `"Alma Hernandez Gonzalez"` and `"Alma Hernandez-Gonzalez"` both match. |
| Shannon OByrne | 2 | Confirm work email. Note Zoho writes the surname without the apostrophe. The normalizer treats `O'Byrne` and `OByrne` as the same token, so either spelling works once configured. |
| Vivienne Davis | 1 | Confirm work email. |
| Mel Federico | 1 | Already handled via `EMAIL_NICKNAME_ALIASES` for `mfederico@epicutis.com` (Melissa Federico). No action needed. |

Values where no `AE_SALESPERSONS` entry is expected — admins/RSDs see
all orders regardless, and inside-sales values typically aren't tied to
a single AE: list those in the diagnostics output and skip.

Workflow for adding a new alias:

1. Get the canonical work email from HR or the rep directly. **Never**
   put a guessed email in `AE_SALESPERSONS` — a wrong email grants the
   wrong account visibility into someone else's orders.
2. In the deploy environment, extend `AE_SALESPERSONS` with the new
   entry. Example JSON patch:

   ```json
   {
     "smccrink@epicutis.com": ["Sheila McCrink"],
     "ahernandez@epicutis.com": ["Alma Hernandez-Gonzalez", "Alma Hernandez Gonzalez"]
   }
   ```

3. Redeploy (env changes are read at startup).
4. Re-run `/api/diagnostics/ae-visibility` and confirm
   `matchedOrderCount > 0` and the name now appears under
   `matchedSalespersonNames` instead of `unmatchedResolvedNames`.

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
