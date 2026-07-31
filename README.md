# Epicutis Orders

Internal Shopify order-search tool for the Epicutis / Signum Bio team.

## Authentication

Access is gated by a 6-digit email-OTP flow (no shared password). On every
sign-in:

1. The user enters their work email. The server checks the denylist
   (`BLOCKED_EMAILS`) and then the domain (`@epicutis.com` /
   `@signumbio.com`). Any allowed-domain user can request a code; their role
   (which decides which admin-only fields and routes they get, not which
   orders they see) is resolved server-side from `ADMIN_EMAILS` /
   `RSD_EMAILS` — see [Access control](#access-control) below.
2. The server emails a 6-digit code via Resend (`RESEND_API_KEY`) with a
   10-minute TTL, 5-attempt cap, and a 30-second per-email cooldown.
3. On verification, the server mints a Bearer session token (12-hour sliding
   TTL, kept in process memory) which the client attaches to every API call.

### Session lifetime

A sign-in lasts **12 hours, sliding**: every authenticated request pushes the
deadline out another 12 hours, so a working day never interrupts you, but 12
hours of inactivity signs you out. The server enforces the window
(`SESSION_TTL_MS` in `server/auth.ts`) and hands the same value to the browser
as `sessionTtlMs`, so the two never drift.

The token is mirrored into `localStorage` (`epicutis.orders.session.v1`), so
reloads, back-navigation and new tabs resume the session instead of asking for
another emailed code. On startup the app replays the stored token against
`GET /api/auth/me` and takes the identity **and role** from that response — the
stored copy is never trusted on its own, so a resumed session is
indistinguishable from a fresh sign-in and can never carry a role the server
would not grant right now. An expired, revoked or corrupt record drops straight
to the sign-in screen. Where `localStorage` is unavailable (Safari private
mode, sandboxed iframes) the app silently falls back to the old memory-only
behaviour rather than failing to load.

Two consequences worth knowing:

- **Sessions do not survive a server restart or redeploy.** The session store is
  a process-memory `Map`, so a Railway deploy signs everyone out and they need
  a fresh code. Making sessions durable would mean adding real persistence
  (Redis, Postgres, or a mounted Railway volume) — the repo has none today.
- A single `401` on one request no longer tears the session down. The client
  re-checks `/api/auth/me` first and only returns to the sign-in screen if the
  token itself is genuinely rejected.

In **development** with no `RESEND_API_KEY`, the OTP code is logged to the
server console so you can sign in locally without email setup. In
**production**, `RESEND_API_KEY` is required; otherwise OTP requests fail.

### Auth API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/request-otp` | none | Body: `{ email }`. Sends a code if the email is on an allowed domain. |
| POST | `/api/auth/verify-otp` | none | Body: `{ email, code }`. Returns `{ token, user, sessionTtlMs }`. |
| GET | `/api/auth/me` | Bearer | Returns `{ user, sessionTtlMs }`. Used to resume a stored session; 401 means sign in again. |
| POST | `/api/auth/logout` | Bearer | Invalidates the current token. |
| GET | `/api/diagnostics/auth` | none | Non-secret diagnostic info. |

### Order API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/orders/search?q=…` | Bearer | Searches **all** Shopify orders. Returns `{ orders }`. |
| GET | `/api/diagnostics/salesperson` | Bearer (admin/RSD) | Aggregate resolver counts. Counts only — never order or customer data. |
| GET | `/api/diagnostics/ae-visibility` | Bearer (admin/RSD) | Per-AE attribution audit (see [AE attribution audit](#ae-attribution-audit)). |
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
- Optional: `AE_SALESPERSONS` — JSON map of AE email → salesperson aliases.
  Used only by the admin/RSD attribution audit; it does not grant or withhold
  order visibility. A missing entry costs nothing but audit coverage.
- Zoho Books — optional; supplies the `salesperson` attribution shown to
  admins/RSDs, which Shopify itself does not record (see
  [Salesperson resolution](#salesperson-resolution) below):
  - `ZOHO_CLIENT_ID`
  - `ZOHO_CLIENT_SECRET`
  - `ZOHO_BOOKS_REFRESH_TOKEN` (alias `ZOHO_REFRESH_TOKEN` is also accepted)
  - `ZOHO_ORG_ID`
  - Optional: `ZOHO_ACCOUNTS_BASE`, `ZOHO_BOOKS_BASE` (set if your Zoho
    tenant is in a non-US region).

Secrets are only ever read from `process.env`. Do not commit them.

## Access control

Order lookup is gated by **authentication only**. Any user who can sign in
(not denylisted, allowed domain, valid OTP) can search every order and view
its tracking. Role decides which admin-only *fields* and *routes* are
available — never which orders come back.

This is deliberate. Salesperson attribution in the Epicutis data is
unreliable: the field is frequently missing on orders, and where a name does
exist it often reflects the customer's account owner in arbitrary casing
rather than the actual rep. Gating visibility on that match meant legitimate
reps signed in and saw nothing. Do not reintroduce a per-user order filter
(see [History](#history-the-ae-salesperson-filter)).

**Revoking access — `BLOCKED_EMAILS`.** A comma-separated denylist checked
*before* the domain allowlist and all role logic. A blocked email cannot
request an OTP, cannot verify one (both return `403 {"error": "This account has
been disabled."}`), and any session token already issued to it is invalidated
on its next request (`401`). The denylist is re-evaluated on *every* request,
not just at sign-in, so blocking someone still takes effect immediately even
though a session now lives for 12 hours. This is the correct way to fully revoke
someone: removing them from `RSD_EMAILS`/`ADMIN_EMAILS` only downgrades their
role (they would still sign in as an AE), whereas `BLOCKED_EMAILS` denies
authentication outright. Example: `BLOCKED_EMAILS=abitter@epicutis.com`. The
list contents are never exposed by the diagnostics endpoints — only a count
(`roles.blockedConfigured`).

| Role  | How it is granted | Order search | Admin-only extras |
| ----- | ----------------- | ------------ | ----------------- |
| admin | Listed in `ADMIN_EMAILS` (env), or in the built-in default list in `server/auth.ts`. | All orders. | `salesperson` field; both `/api/diagnostics/*` role-gated routes. |
| rsd   | Listed in `RSD_EMAILS`. | All orders. | Same as admin. |
| ae    | Default for every other allowed-domain user. | All orders. | None — `salesperson` column hidden, diagnostics return 403. |

The `salesperson` field on each row is resolved server-side
(see [Salesperson resolution](#salesperson-resolution) for the full
pipeline). It is added to the response **only when the caller is an admin
or RSD**. AEs never receive it. The frontend mirrors this by hiding the
`Salesperson` column for AEs, but the server is the source of truth — a
client cannot widen its own scope. This is a *field* gate: it changes what
is shown about an order, not whether the order is returned.

`/api/orders/search` returns `{ "orders": [...] }`. There is no per-caller
scope object, because the result set does not depend on the caller.

`/api/diagnostics/auth` reports the size of each role list (counts only,
never the actual emails or aliases).

### History: the AE salesperson filter

Earlier versions restricted AEs to orders whose salesperson matched a
per-user alias list (added in #6, removed in #8, restored "fail-closed" in
#9). Under #9 an AE whose alias set matched nothing received an empty result
set and a message telling them to ask an admin to fix their aliases — which
is exactly what reps hit in production, because the underlying attribution
data is sparse and inconsistent. The filter is gone; `AE_SALESPERSONS` now
feeds reporting only.

### Configuring `AE_SALESPERSONS`

`AE_SALESPERSONS` is a JSON object mapping each AE's email (lowercased)
to a list of aliases that should match the salesperson string Zoho or
Shopify records on their orders. It is consumed only by the
[AE attribution audit](#ae-attribution-audit).

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
spaces, lowercased. An order is attributed to an AE when, for their
effective normalized alias set `A` and the normalized resolved salesperson
`v`:

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
aliases — simply does not appear in the attribution audit. Their order
search is unaffected: they still see every order.

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

If Zoho is not configured, everyone still sees every order; admin/RSD just
get an unpopulated `salesperson` column and the attribution audit has
nothing to report. The Zoho refresh-token flow is the only secret store —
refresh tokens never leave `process.env`, access tokens only live in memory.

### Diagnostics

- `GET /api/diagnostics/auth` (unauth) reports Shopify + Zoho env
  presence (booleans only), role list sizes, and OTP provider status.
- `GET /api/diagnostics/salesperson` (admin/RSD only) reports aggregate
  counters from the caller's most recent order search — orders scanned,
  with Shopify salesperson, with Zoho refs, resolved from Zoho,
  unresolved — plus Zoho cache size. No order names, customer info,
  references, or secret values are ever exposed.

### AE attribution audit

Reports how many orders in a recent sample are attributable to each AE on
the roster. This is a **data-quality report, not an access check** — no AE's
search results depend on it. The path keeps its original
`ae-visibility` name so existing admin bookmarks keep working.

```
GET /api/diagnostics/ae-visibility?sample=250&q=
Authorization: Bearer <admin-or-rsd-token>
```

The endpoint scans a bounded recent slice of Shopify orders (`sample`
defaults to 250, max 1000), runs the orders through the **exact same**
salesperson resolver used by `/api/orders/search`, and reports per-AE
aggregates only:

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

- `matchedOrderCount = 0` for an AE with a real book of business → their
  aliases in `AE_SALESPERSONS` do not match what Zoho returns. Compare
  `aliases` against `unmatchedResolvedNames` to find the spelling Zoho
  actually uses. The AE can still search everything meanwhile.
- `unmatchedResolvedNames` lists rep names no roster entry covers.
- `resolver.unresolved` tells you how many orders in the sample lack
  both a Shopify-side salesperson hint and a working Zoho lookup — i.e.
  orders with no attribution at all.
- `q` accepts a substring (e.g. an order name prefix) to narrow the
  sample to a specific area.

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
real reps without an `AE_SALESPERSONS` entry — adding them improves
attribution reporting only; every rep can already search every order.

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

1. Get the canonical work email from HR or the rep directly. A guessed
   email produces misleading attribution numbers (it grants no access —
   `AE_SALESPERSONS` is reporting-only — but it credits one rep's orders
   to another).
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
- `npm test` — server tests (`node --test` via `tsx`).
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
