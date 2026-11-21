---
id: usage
title: JS SDK (@velexis/ota-sdk) — usage guide
summary: How to try the OTA booking API's JavaScript client in its three session modes, every namespace and command, what each should do, and what to check in the database, Redis, cookies and Mailpit when hunting bugs.
---

## What it is

`@velexis/ota-sdk` (`repo:ota/sdk`) is the [[velexis-sdk|JavaScript client]] of the OTA booking API: vanilla ES2022
modules with JSDoc types and **no runtime dependencies**, one method per OpenAPI operation that has an
[[x-sdk-method]] (129 methods in 8 namespaces: 96 from the frozen [[contract-declarations]] plus 33
[[mvp-addition|MVP additions]]). It has no screens, no server and no tables of its own: it runs inside its callers and
talks only to the [[app:ota-api]]. Every row it causes to change is written by the API.

```diagram
neighbours
```

Who uses it, and how ([[cookie-mode]], [[token-mode]], [[server-mode]] are chosen once, when the client is created):

| Caller | Mode | Client options | Credentials on the wire | Code |
|---|---|---|---|---|
| Hosted [[app:storefront]] (browser) | cookie | `{ baseUrl: "/api", session: "cookie" }` | Session cookies + `X-CSRF-Token`; Caddy adds the [[edge-caller]] credential | `repo:ota/frontend/src/lib/client.js` |
| Third-party browser app | token | `{ publishableKey: "pk_…", baseUrl }` (+ tokens) | `X-Api-Key: pk_…`, `Authorization: Bearer`, `X-Booking-Token`; `credentials: "omit"` | build-your-own-frontend guide |
| Third-party server / custom console | server | `{ secretKey: "sk_…", baseUrl, endUser }` (+ tokens per request) | `X-Api-Key: sk_…`, Bearer, `X-Velexis-End-User-IP` / `-Agent` | `repo:ota/sdk/test/smoke/server-mode.smoke.test.js` |
| [[app:ota-admin]] server | server, staff | `{ secretKey: OTA_ADMIN_SERVICE_KEY, sessionKind: "staff", environment, accessToken }` | [[service-key]], [[staff-session|staff]] Bearer, [[x-velexis-environment]] | `repo:ota/admin/src/lib/velexis.ts` |

Status (2026-11-20): version **1.0.0 prepared but not published**. `package.json` is `"private": true` with licence
`UNLICENSED`; the npm publish workflow is a draft waiting for the owner's approval
(`repo:ota/sdk/release/sdk-publish.draft.yml`). Inside the monorepo the storefront and the OTA admin use it as
`workspace:*`.

```note
The repository's `docs/velexis-sdk/` folder is the original **reference design** (contract `.d.ts`, guides B1–B4 and a
Next.js example). The example imports `@velexis/ota-sdk/next` and `@velexis/ota-sdk/react`, which are **deferred**
(post-MVP): they do not exist in `ota/sdk`. For a working custom storefront follow
`repo:ota/frontend/docs/build-your-own-frontend.md` instead.
```

## Before you start

The SDK needs nothing running for its own checks. To try it against a real API you need the OTA stack of
[[app:ota-api]] (PostgreSQL, Redis, Mailpit, the [[amadeus-stub]], both [[dev-seed]] commands) — see
[[journey:run-the-stack]].

```try
command: pnpm --filter @velexis/api-types build
command: pnpm --filter @velexis/ota-sdk typecheck && pnpm --filter @velexis/ota-sdk test
command: pnpm --filter @velexis/ota-sdk build
expect: Unit + contract tests green; dist/velexis-sdk.mjs, dist/velexis-sdk.iife.js and dist/types/; the size check prints about 15.8 KB min+gzip (budget 25 KB)
```

```try
command: pnpm --filter @velexis/ota-backend dev:seed
command: SDK_SMOKE_PUBLISHABLE_KEY=pk_test_… SDK_SMOKE_SECRET_KEY=sk_test_… SDK_SMOKE_CONSOLE_KEY=sk_test_… pnpm --filter @velexis/ota-sdk test:smoke
url: http://127.0.0.1:4000/health/live
expect: Both smoke files pass against the demo OTA (tenant_demo) and the Amadeus stub
```

Development data (development only):

| What | Where | Notes |
|---|---|---|
| Three test keys of the [[demo-ota]] | printed **once** by `pnpm --filter @velexis/ota-backend dev:seed` (`repo:ota/backend/src/dev/dev-seed.command.ts`) | `Publishable test key` (`pk_test_…`, no allowed origins), `Secret test key` (`sk_test_…`, scope `storefront`), `Console automation test key` (`sk_test_…`, scopes `console:automation`, `amadeus:read`) |
| OTA admin service key | `ota/admin/.env.example` and `ota/backend/.env.example`: `OTA_ADMIN_SERVICE_KEY=sk_dev_ota_admin_service_key_change_me` | Development only; only the OTA admin's server uses it |
| Smoke settings | `OTA_API_URL` (default `http://127.0.0.1:4000`), `SDK_SMOKE_*`, `REDIS_URL`, `DATABASE_MIGRATOR_URL` | Read by `repo:ota/sdk/test/smoke/smoke-env.js` from the environment, then `.env.local` of `ota/sdk` and the root; never printed |

A browser page on another origin needs a publishable key whose **allowed origins** list that origin (create one in
the [[app:portal]], API keys page): the seeded `pk_test_` key has none, so it only works from Node.js (no `Origin`).

## Tour

A library has no screens; its "areas" are the namespaces of a client and the package scripts. Every method takes
`(params, options?)`; `options` are the [[request-options|RequestOptions]] (`signal`, `idempotencyKey`,
`timeoutMs`, `headers`, `accessToken`, `bookingToken`, `locale`, `currency`, `next`, `cache`, `endUser`, `host`).

### Namespaces

| Namespace | Methods (deferred) | File | What to try | What should happen | Tables the API touches |
|---|---|---|---|---|---|
| `storefront` | 4 (`resolve`) | `repo:ota/sdk/src/namespaces/storefront.js` | `storefront.get()`, `get({ locale: "fr" })`, `listPages()`, `getPage({ slug })`, `resolve({ host })` | `StorefrontConfig` (name, branding, locales, currencies, features, `legal.termsVersion`, payment public config); `locale` becomes `Accept-Language`; pages `{ data: [...] }`; `resolve` → `ServerError 501 NOT_IMPLEMENTED`. No `cache: "no-store"` by default (cacheable) | `storefront_settings`, `storefront_assets`, `storefront_pages` |
| `reference` | 6 | `repo:ota/sdk/src/namespaces/reference.js` | `reference.locations.search({ keyword: "par", limit: 3 })`, `airports.get({ iataCode: "CDG" })`, `airlines.list()`, `countries.list()`, `currencies.list()` | Lists resolve as a [[cursor-pagination|Page]] (`data`, `page.nextCursor`, `next()`, `for await`); `PAR` (city) first for "par" | `reference.*` (shared, read-only) |
| `flights` | 10 (`availability`) | `repo:ota/sdk/src/namespaces/flights.js` | `search` → `listResults({ searchId, sort, stops, limit })` → `getOffer` → `upsell` → `price({ offerIds })` → `getPricedOffer`, `getAncillaries`, `getFareRules` | `srch_…` (201; `resultOptions.async` answers `403 FEATURE_DISABLED` in the MVP), `prc_…` active; `PriceChangedError` carries `newPrice`, `oldPrice`, `pricedOfferId`. 60 s timeout for `search`, `upsell`, `price`; `availability` is console-scoped and deferred | `flight_searches`, `flight_offers`, `offer_upsells`, `priced_offers`, `supplier_requests`, `idempotency_keys` |
| `checkout` | 11 | `repo:ota/sdk/src/namespaces/checkout.js` | `create({ pricedOfferId })`, `setTravelers` / `setContacts` / `setAncillaries` / `setRemarks` (optional `ifMatch`), `createPayment`, `updatePayment`, `getPayment`, `complete`, `completeWithAirlineCard` | `chk_…` open (guest when no customer token); `complete` 90 s, retried only with the same [[idempotency-key]]; `completeWithAirlineCard` is hosted-storefront only, never retried, errors scrubbed of the card | `checkouts`, `checkout_*`, `payments`, `payment_events`, `bookings`, `booking_*`, `booking_access_tokens`, `idempotency_keys` |
| `bookings` | 14 (`addAncillaries`, `createPayment`, `getAncillaries`) | `repo:ota/sdk/src/namespaces/bookings.js` | `list({ timeframe })`, `get`, `lookup({ bookingReference, lastName })`, `update({ ifMatch })`, `quoteCancellation`, `cancel({ ifMatch })`, `getFareRules`, `listDocuments`, `getDocumentDownloadUrl`, `listEvents`, `getTicketingStatus` | `update`, `cancel`, `addAncillaries` without `ifMatch` → `TypeError` before any request; `lookup` resolves `bookingToken: null` in cookie mode; guest calls send the [[guest-token]] as `options.bookingToken` (`X-Booking-Token`) | `bookings`, `booking_*`, `booking_access_tokens`, `payments`, `refunds`, `notifications` |
| `auth` | 10 | `repo:ota/sdk/src/namespaces/auth.js` | `signUp`, `verifyEmail`, `resendVerification`, `signIn`, `refresh`, `signOut`, `requestPasswordReset`, `resetPassword`, `changePassword`, `getSession` | Token/server mode: `signIn` / `refresh` / `changePassword` results become the client's session ([[session-result]]). Cookie mode: results come back **without** `accessToken` / `refreshToken`, `signUp` / `resetPassword` with `session: null`; `refreshToken` in `refresh` / `signOut` params → `TypeError` | `customers`, `customer_identities`, `customer_sessions`, `customer_password_resets`, `notifications` (e-mails) |
| `account` | 12 (9: `preferences.*`, `savedTravelers.*`, `dataExports.*`) | `repo:ota/sdk/src/namespaces/account.js` | `get`, `update({ ifMatch, … })`, `delete`, any deferred method | `update()` without `ifMatch` → `TypeError` naming "the account version"; deferred → `501 NOT_IMPLEMENTED` (`retryable: false`) | `customers`, `customer_consents`, `customer_sessions`, deletion fan-out |
| `console` | 62 (5: `bookings.create`, 4 raw Amadeus writes) | `repo:ota/sdk/src/namespaces/console.js` | `auth.signIn({ grantType: "portal_token", portalToken })` ([[portal-token]]), `auth.me`, `bookings.list/get/findByRecordLocator/retrieve/import/patch/issue/cancel/closeReview/resync/addNote`, `queues.*`, `customers.*`, `supplierRequests.list`, `amadeus.*`, `settings.*` (25), `payments.*` (4) | Needs a secret key not scoped `storefront` (else `403 SCOPE_NOT_ALLOWED`) and a staff token or a [[console-automation-key]]; with `environment` every call carries `X-Velexis-Environment`; `findByRecordLocator` / `getFlightOrderByReference` default `originSystemCode: "GDS"`; `settings.assets.upload` sends `multipart/form-data` | `bookings`, `staff_actions`, `supplier_requests`, `queue_snapshots`, `markup_rules`, `fee_rules`, `storefront_*`, `notification_templates`, `payments`, `refunds` |

The client itself also offers `withOptions(overrides)` (a derived client in the same [[client-family]]) and
`request(method, path, init)` (the [[request-escape-hatch]] for any `/v1/…` path). All 129 operations with their HTTP
method and path are in this app's facts card (endpoints).

### Package scripts

Run as `pnpm --filter @velexis/ota-sdk <script>` (`repo:ota/sdk/package.json`):

| Script | Does | Expect |
|---|---|---|
| `generate` | `scripts/generate-operations.mjs`: OpenAPI → `src/internal/operations.js` + `test/contract/methods.generated.ts` | No diff on a clean tree (CI fails on a stale table) |
| `typecheck` | `tsc -p tsconfig.json` over `src/**/*.js` ([[jsdoc-types]]) | Exit 0 |
| `test` | Vitest: `test/unit/**`, `test/contract/**` (fake fetch, no network) | Green; includes parity, `@throws`, bundle and pack tests |
| `test:contract` | Declaration build + `tsc -p test/contract/tsconfig.json` | Exit 0 (run `build` again before packing) |
| `test:smoke` | [[sdk-smoke-tests]] against `OTA_API_URL` | Both files pass; fails fast with what to start when the API is down |
| `build` | `scripts/build.mjs` (esbuild ESM + IIFE, declarations, API types copy) then `scripts/check-size.mjs` | `dist/…`; fails above the 25 KB [[size-budget]] |
| `lint` | ESLint | No errors |
| `clean` | Removes `dist` and `coverage` | — |

## How to …

### Check the SDK offline

```diagram
flow-offline-checks
```

### Run the smoke tests against the local stack

```diagram
flow-smoke-tests
```

### Try token mode from a browser page

```diagram
flow-token-mode-browser
```

### Use server mode from a Node.js script

```diagram
flow-server-mode
```

### Watch cookie mode in the hosted storefront

```diagram
flow-cookie-mode-storefront
```

### Add or change an operation

```diagram
flow-add-operation
```

### Review and release 1.0.0 (owner)

After 1.0.0 every version is published with npm [[trusted-publishing]] only.

```diagram
flow-release
```

## Roles and permissions

The SDK enforces only what it can check locally; everything else is the API's decision and comes back as a typed
error ([[velexis-error]]).

| Who | Can | Refused locally (`TypeError`, before any request) | Refused by the API |
|---|---|---|---|
| Cookie-mode page | Customer operations on its own origin; the only caller of `checkout.completeWithAirlineCard` | Any key, `accessToken` / `refreshToken` / `bookingToken` (option or per call), `X-Api-Key` / `Authorization` headers; no `document`; `withOptions` to another mode | `console.*` → `403 SCOPE_NOT_ALLOWED`; a missing CSRF cookie is fixed automatically, a second `403 CSRF_TOKEN_INVALID` is thrown |
| [[publishable-key]] (`pk_`) | Customer-scope operations from listed origins | A key with the wrong prefix, two keys at once | `403 ORIGIN_NOT_ALLOWED` (origin not listed), `403 SCOPE_NOT_ALLOWED` (`console_operation`, `edge_only`) |
| [[secret-key]] scoped `storefront` | Customer operations for any visitor (`endUser`) | `secretKey` in a page with `document` | `403 SCOPE_NOT_ALLOWED` (`storefront_key`) on every console operation |
| `sk_` with the [[key-scope]] `console:automation` | Console operations listed in its own scopes; with a staff token, what the staff member's role allows | — | `403 FORBIDDEN` with `details.requiredPermission` |
| [[service-key]] (OTA admin) | Console operations with a staff token and `X-Velexis-Environment` | — | `403 SCOPE_NOT_ALLOWED` (`service_console_only`) on customer operations; `403 ENVIRONMENT_NOT_ALLOWED` for `live` without a live OTA or with role `viewer` |
| [[hosting-key]] (`hk_`) | Nothing yet: the option exists (contract), the client runs in server mode | — | Every call `401 INVALID_API_KEY`: the API does not serve hosting keys in the MVP (`repo:ota/backend/src/tenancy/caller-resolver.ts`); `storefront.resolve` is deferred too |

A forbidden action looks like this from the SDK: the promise rejects with `PermissionError`, `status 403`, `code`
(`SCOPE_NOT_ALLOWED`, `FORBIDDEN`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `EMAIL_NOT_VERIFIED`, `FEATURE_DISABLED`,
…), `details.reason` or `details.requiredPermission`, a `requestId`, and `retryable: false`.

## Bug-hunting checklist

```bug-hunt
**Option validation.** `createVelexisClient({ publishableKey: "sk_test_x" })`, `{ timeoutMs: 0 }`, `{ currency: "eur" }`,
`{ baseUrl: "//evil.example.com" }`, `{ baseUrl: "https://u:p@api.ota.example.com" }`, an unknown option, two keys:
each must throw a `TypeError` whose message names the option and **never** contains its value. Per call:
`{ idempotencyKey: "short" }` (needs 16–128 visible ASCII). A client with **no key at all** is accepted (token mode)
and every call is then refused by the API (`401`): note it if you think it should be refused at construction.
Two gaps to confirm: an `Idempotency-Key` passed in `options.headers` skips the 16–128 check (`{ headers:
{ "Idempotency-Key": "short" } }` goes out and the API refuses it), and `client.request("GET", "/../v1/storefront")`
is accepted although method params refuse `.` and `..` (with `baseUrl: "/api"` the browser resolves it outside `/api`).
```

```bug-hunt
**Idempotency.** In the Network tab every state-changing POST that the document marks with `Idempotency-Key` carries a
UUID v4, the **same** one on its automatic retries and on the resend after `TOKEN_EXPIRED` / `CSRF_TOKEN_INVALID`;
`completeWithAirlineCard` gets a new one per call and is never resent. Reusing a key with another body →
`409 IDEMPOTENCY_KEY_REUSED`. DB: `SELECT key, status, response_status, request_path FROM tenant_demo.idempotency_keys
ORDER BY created_at DESC LIMIT 5;` (one row per key, `completed` after success).
```

```bug-hunt
**Retries and timeouts.** Only GET / PUT / DELETE, calls with an `Idempotency-Key` and `x-idempotent-by-design` POSTs
are retried, at most `maxRetries` (2) times, on 429, 503, 504 and network errors; a PATCH is never retried. Use the stub's
`X-Stub-Scenario: server-error` / `rate-limited` / `timeout` (non-production only) through `options.headers` and check
the attempts in `onResponse`. A `Retry-After` above 30 s ends the call at once. A custom `fetch` that throws (a programming error) is reported as
`ConnectionError NETWORK_ERROR` and retried like a network failure. `flights.search` / `upsell` / `price`
and the long console actions time out at 60 s, `checkout.complete*` at 90 s, everything else at 30 s.
```

```bug-hunt
**Errors.** Each status maps to its class: 400/422 `ValidationError` (`fieldErrors` with JSON pointers; every error has the [[request-id]]), 401
`AuthenticationError`, 402 `PaymentError`, 403 `PermissionError`, 404 `NotFoundError`, 409 `ConflictError`
(`PRICE_CHANGED` → `PriceChangedError` with `newPrice`, `SOLD_OUT` → `SoldOutError`), 410 `ExpiredError`, 429
`RateLimitError` (`retryAfterSeconds`), 424/502/504 and `SUPPLIER_UNAVAILABLE` `SupplierError`, 5xx `ServerError`,
412/423 plain `VelexisError`. A proxy's HTML 502 must become `ServerError` `SERVICE_UNAVAILABLE`, never
`SupplierError`, and its body must not reach `message`. `JSON.stringify(error)` must never show a key, a Bearer token
or a JWT (`eyJ…`), nor `details.bookingToken`.
```

```bug-hunt
**Cookie mode and tokens.** In the storefront no request carries `X-Api-Key` or `Authorization`; `__Host-vx_at`,
`__Host-vx_rt` and `__Host-vx_bt` are httpOnly; `auth.signIn` / `refresh` answers seen by page code have no token
fields; `bookings.lookup` and `checkout.complete` resolve `bookingToken: null` (the SDK forces `null` for `lookup`
only; for `checkout.complete*` it relies on the API's edge answer, so a token there is an API bug). A page with the
currency switcher and fare rules open (three clients of one family) must send **one** `POST /api/v1/auth/refresh` per
expiry ([[customer-session]] rotation), never two with the same refresh cookie: two would show up as
`customer_sessions.revoke_reason = 'rotation_reuse'` and a signed-out customer. **Two tabs are two families**, but their
cookie refreshes run one at a time under the origin's Web Lock `velexis-sdk:cookie-refresh`. Sign one customer in on
two tabs, delete `__Host-vx_at` once in DevTools (the cookie jar is shared) and reload both tabs at the same moment:
only one `POST /api/v1/auth/refresh` goes out and the customer stays signed in. While the first tab refreshes,
`navigator.locks.query()` in the second tab shows its pending request.
```

```bug-hunt
**Refresh rotation (token/server mode).** One [[single-flight-refresh|refresh per expiry]] per family. After a refresh, `customer_sessions` shows the old row `rotated_at` +
`replaced_by_id` and a new row with the same `family_id`; `onSessionRefreshed` receives the **newest** pair. A rotated
refresh token presented more than 10 s later by a client that did not hold it → `401 REFRESH_TOKEN_REUSED`, the whole
[[refresh-family]] revoked (by design). Staff sessions live in Redis: `redis-cli -a dev_redis --scan --pattern 'staffsess:*'`
(development password).
```

```bug-hunt
**[[airline-card|Airline card]].** Trigger a decline (card `4000 0000 0000 0002` on the stub) and a validation error: the thrown error,
its `toJSON()`, `onResponse` and any log must not contain the card number (with or without spaces), its last 12
digits, the CVC or the holder name; `fieldErrors` keep `path` and `code` only. From a key caller the method answers
`403 SCOPE_NOT_ALLOWED` (`edge_only`). Three declines → `403 PAYMENT_ATTEMPTS_EXCEEDED`.
```

```bug-hunt
**If-Match and versions.** `bookings.update`, `bookings.cancel`, `account.update`, the console `bookings.patch/issue/
cancel/closeReview`, settings updates/deletes and `payments.capture` without `ifMatch` → `TypeError` naming whose
version; with a stale version → `409 VERSION_CONFLICT` (or `412 PRECONDITION_FAILED`, a plain `VelexisError`). A number
is sent as `If-Match: "<n>"`, a string as it is. Compare with the row's `version` column.
```

```bug-hunt
**Pagination.** `for await (const b of await client.console.bookings.list({ limit: 2 }))` fetches page after page
only as you iterate and stops at `nextCursor: null`; extra fields (`totalCount`, `facets`, `snapshot`, `warnings`) stay
on each page; `JSON.stringify(page)` shows data, never a function. A list answer without `page.limit` would not be
wrapped in a `Page` (then `next` is missing).
```

```bug-hunt
**Tenancy and rate limits.** Keys of one OTA never reach another (`401 INVALID_API_KEY`, `401 UNAUTHENTICATED` for a
token of another tenant). Sign-ups are limited to 5 per hour per end-user IP: token-mode calls from Node count as
127.0.0.1; server-mode calls with `endUser.ip` count per visitor. Counters: `redis-cli -a dev_redis --scan --pattern
'rl:*'`. Key usage: `apikey:used:<keyId>` then `platform.api_keys.last_used_at` after the platform worker's flush.
```

```bug-hunt
**E-mails.** `auth.signUp`, `resendVerification`, `requestPasswordReset` and booking completion queue e-mails: open
Mailpit http://127.0.0.1:8025 and check the recipient, the OTA's branding and the link host; `requestPasswordReset`
always resolves `202 accepted` (no account enumeration) even for an unknown address, and sends nothing then (at most
three reset e-mails per customer per hour). Queue rows: `SELECT template_key, status, created_at FROM
tenant_demo.notifications ORDER BY created_at DESC LIMIT 5;`.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `TypeError: Velexis SDK: session "cookie" needs a browser page (document)` | Cookie mode in Node.js or a worker | Use a key (token or server mode) outside a page |
| `TypeError: … "secretKey" belongs on servers only` | `secretKey` in a page (or a test environment with `document`, such as happy-dom) | Move the call to server code; in tests use the Node environment |
| `TypeError: … this runtime has no global fetch` | Old runtime | Pass `fetch` or run Node.js 22.12+ / 24 |
| Every call `401 INVALID_API_KEY` | Wrong, revoked or expired key; key of another environment | `SELECT prefix, revoked_at, expires_at FROM platform.api_keys WHERE prefix = '<first 14 chars>';` |
| Browser shows a CORS error / `ConnectionError NETWORK_ERROR` | Page origin not in the publishable key's `allowed_origins` (`403 ORIGIN_NOT_ALLOWED` unreadable without CORS) | Add the origin in the portal (API keys) |
| `403 SCOPE_NOT_ALLOWED` on `console.*` | `pk_` key, or `sk_` scoped `storefront` | Use a `console:automation` key or the OTA admin |
| `ServerError 501 NOT_IMPLEMENTED` | A [[deferred-operation]] | Expected in the MVP; `details.milestone = "deferred"` |
| Smoke run stops at once | API not reachable on `OTA_API_URL` within 3 s, or a missing `SDK_SMOKE_*` | Start `pnpm --filter @velexis/ota-backend dev`; set the three keys |
| Smoke sign-up `RateLimitError` | Sixth token-mode run within an hour (127.0.0.1) | Wait an hour or empty the API's Redis locally |
| `generate` changes `operations.js` | OpenAPI document changed without regenerating | Commit the regenerated table and fix the namespace and `@throws` |
| `build` fails on size | ESM bundle above 25 KB min+gzip | Split `console` into its own entry (ADR-0019 follow-up) |
| Lost the seeded keys | `dev:seed` prints them once | Delete the demo OTA's `platform.api_keys` rows locally and seed again |
