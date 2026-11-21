---
id: usage
title: OTA API and worker — usage guide
summary: How to run, call and test the OTA booking API and its worker - every endpoint group, the jobs and CLI commands, what each call should answer, and which tenant tables, Redis keys, queues and e-mails to check.
---

## What it is

The OTA API is the data plane of Velexis (`repo:ota/backend`, package `@velexis/ota-backend`): everything a
traveller or an OTA's staff does with flights goes through it. It serves three kinds of callers and keeps every OTA's
data in its own [[tenant-schema]] (`tenant_<key>`), reached only through [[tenant-tx]].

| Process | Entry | Port (127.0.0.1) | Does |
|---|---|---|---|
| API | `repo:ota/backend/src/main.ts` → `dist/main.js` | 4000 | 117 operations of the OpenAPI contract (+19 deferred that answer `501`), Stripe webhooks, signed file and image downloads, health |
| Worker | `repo:ota/backend/src/worker.ts` → `dist/worker.js` | 4001 (health only) | [[bullmq]] consumers and schedulers: provisioning, Stripe events, payments, booking sync and [[reconciliation]], ticketing, e-mails ([[outbox]]), PDFs, purges, queue polling |
| CLI | `repo:ota/backend/src/cli.ts` → `dist/cli.js` | — | `dev:seed`, `tenants:report-migrations`, `amadeus:ping`, `secrets:rewrap`, `tenants:scrub-card-copies` |

```diagram
neighbours
```

Who calls it:

| Caller | Credential | Scope | Typical use |
|---|---|---|---|
| Hosted [[app:storefront]] | [[edge-caller]]: Caddy adds `X-Velexis-Edge` + `X-Velexis-Host`; cookies `__Host-vx_at`/`_rt`/`_bt` + [[csrf-token]] | customer | Search, book, my trips; the only caller allowed to send an [[airline-card]] |
| Third-party site / server | [[publishable-key]] `pk_test_…` (origin allow-list) or [[secret-key]] `sk_…` scoped `storefront` | customer | Same operations with bearer tokens; `X-Velexis-End-User-IP` from servers |
| [[app:ota-admin]] server | [[service-key]] on a direct loopback connection + staff bearer token + `X-Velexis-Environment` | [[console-scope]] | Every `/v1/console/**` operation |
| Custom console / automation | `sk_…` scoped `console` + staff token, or `console:automation` + `X-Velexis-Scope: console` | console | Scripts, the SDK's server mode |
| Stripe | Webhook signature | webhook | `/webhooks/stripe/**` |

The contract is `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`; every operation names its SDK method
(`x-sdk-method`), the tenant tables it touches (`x-tenant-tables`), the Amadeus calls (`x-amadeus`) and its error codes.
`app.json` of this app lists all 136 operations.

## Before you start

Prerequisites: PostgreSQL 16, Redis 7, Mailpit, the [[amadeus-stub]] and the platform seed (the Velexis test Amadeus
account and its 40 test offices). The whole setup, step by step:

```diagram
flow-local-setup
```

```try
command: pnpm dev:keys && cp ota/backend/.env.example ota/backend/.env.local
command: pnpm db:migrate && pnpm db:seed:reference
command: pnpm stub:amadeus
command: pnpm --filter @velexis/platform-backend dev:seed && pnpm --filter @velexis/ota-backend dev:seed
command: pnpm --filter @velexis/ota-backend dev
url: http://localhost:4000/health/ready
expect: {"status":"ok","checks":{"postgres":"ok","redis":"ok"}}; http://127.0.0.1:4001/health/ready adds the queues
```

Seeded data (development only):

| What | Where it comes from | Notes |
|---|---|---|
| [[demo-ota]] `demo` ("Demo Travel", `tenant_demo`, storefront `test`) | `repo:ota/backend/src/dev/dev-seed.command.ts` | On `demo.ota.example.com`; Amadeus test connection through the Velexis account (an office `DEV1A00xx` of the [[office-pool]]); Stripe connection in `velexis` mode |
| Three test keys | the same seed, **printed once** | `Publishable test key` (`pk_test_…`, no origins), `Secret test key` (`sk_test_…`, scope `storefront`), `Console automation test key` (`sk_test_…`, `console:automation` + `amadeus:read`). Lost: delete the key rows locally and seed again |
| Tenant defaults | provisioning seeds `repo:ota/backend/src/provisioning/seeds/index.ts` | `storefront_settings` (`issue_after_payment`, booking queue 50/0, airline card off), Default markup rule 0 % priority 1000, notification templates |
| Staff | none for `demo` | Create your own OTA in the [[app:portal]] and "Open console" ([[sso]]) to get a staff session |
| Customers | none | Sign up on the storefront; verification links arrive in Mailpit http://127.0.0.1:8025 |

Development connection strings (from `.env.example`, development only): `psql
postgres://velexis_ota_app:dev_ota@127.0.0.1:5432/velexis` (DML on `tenant_*`), `redis-cli -a dev_redis`. Feature
switches that matter: `AIRLINE_CARD_ENABLED=true` in `.env.example`; Stripe needs your own **test** keys in
`ota/backend/.env.local` (`STRIPE_SECRET_KEY_TEST`, `STRIPE_PUBLISHABLE_KEY_TEST`, `STRIPE_WEBHOOK_SECRET_VELEXIS_TEST`)
and `stripe listen --forward-to localhost:4000/webhooks/stripe/velexis/test`. The card method is hidden only when the
two key variables are **empty or absent**: the dummies copied from `.env.example` (`sk_test_replace_me`,
`pk_test_replace_me`) pass the start-up check, so `storefront.get` lists `card` and `checkout.createPayment` then fails
at Stripe (`502 PAYMENT_PROVIDER_ERROR`).

```note
The stub picks a scenario per request from the header `X-Stub-Scenario` (`success`, `sold-out`, `price-changed`,
`ticketing-failed`, `version-conflict`, `cancel-refused`, `server-error`, `rate-limited`, `timeout`, `timeout-lost`;
an unknown name is a stub `400`), which the API forwards only when `APP_ENV` is not `production`. `timeout` holds the
answer 30 s, then the stub gives up with `504` (an order write is applied first); `timeout-lost` holds without
applying it. Destination `ZZZ` returns no offers; card `4000 0000 0000 0002` is declined. This is how you reproduce
most failure paths locally.
```

## Tour

The API has no screens: the tour walks every endpoint group of the contract with what to try and what should happen.
Error bodies are always `{error: {code, message, status, requestId, details?, fieldErrors?, supplier?}}`; supplier
details only in console scope. Every answer carries `X-Request-Id` ([[request-id]]).

### Storefront and reference — `repo:ota/backend/src/storefront`, `repo:ota/backend/src/reference`

| Endpoint | Try | Should happen |
|---|---|---|
| `GET /v1/storefront` | With `pk_test_…`; with a suspended tenant | `200` brand, locales, currencies, payment methods, legal versions, `environment`; edge callers also get the `__Host-vx_csrf` cookie. Cached per locale in `t:<tenantId>:<env>:sf:<locale>` (5 min). Suspended: `403 TENANT_SUSPENDED` |
| `GET /v1/storefront/pages`, `/pages/{slug}` | A draft page; a page in another locale | Only published pages; Markdown subset rendered to blocks; the default locale as fallback; cached in `t:…:pages:<locale>` |
| `GET /v1/assets/{tenantKey}/{assetId}.{ext}` | A deleted asset; 121 requests/min | Public immutable image (no key); `404`; `429` (`rl:ota_downloads`) |
| `GET /v1/reference/locations?keyword=par`, `/airports/{iata}`, `/airlines`, `/countries`, `/currencies` | Keyword of 1 letter; unknown IATA | Reads `reference.*` only; `400 VALIDATION_FAILED` with the field path; `404` |

### Customer auth and account — `repo:ota/backend/src/identity/auth.controller.ts`, `repo:ota/backend/src/account/account.controller.ts`

| Endpoint | Try | Should happen |
|---|---|---|
| `POST /v1/auth/sign-up` | Weak password; used e-mail; old `termsVersion` | `201` + session ([[customer-session]]); `422 PASSWORD_TOO_WEAK`; `409 EMAIL_ALREADY_REGISTERED`; `400` on `/termsVersion`. Customer accounts off → `403 FEATURE_DISABLED` |
| `POST /v1/auth/email-verification/confirm`, `/resend` | Use the Mailpit link twice | `200`, `email_verified_at` set, guest bookings of the address attached; second use `400 VERIFICATION_TOKEN_INVALID`; resend always `202` (5/h per IP, 3/h per address) |
| `POST /v1/auth/sign-in` | 5 wrong passwords | `401 INVALID_CREDENTIALS`, then `423 ACCOUNT_LOCKED` ([[account-lockout]], `t:…:authfail:<sha256(email)>`, 15 min); 10/min per IP |
| `POST /v1/auth/refresh` | Reuse a rotated refresh token | New pair; reuse → `401 REFRESH_TOKEN_REUSED` and the [[refresh-family]] revoked (`customer_sessions.revoked_at`) |
| `POST /v1/auth/sign-out` (`scope: current\|all`), `GET /v1/auth/session` | Sign out everywhere, then refresh elsewhere | `204`; other sessions fail on refresh |
| `POST /v1/auth/password-resets`, `/confirm`, `POST /v1/auth/password/change` | Unknown address; reuse the reset link | Always `202`; `auth.password_reset` e-mail; confirm revokes every session; second use `400 PASSWORD_RESET_TOKEN_INVALID`; change needs the current password (`422 CURRENT_PASSWORD_INCORRECT`) |
| `GET/PATCH /v1/account` | Change e-mail (needs `currentPassword`); wrong password; stale `If-Match` | New address becomes `pendingEmail` until its `auth.verify_email` link is used (sign-in keeps the old one); `account.email_changed` notice to the **current** address; `422 CURRENT_PASSWORD_INCORRECT`; `412 PRECONDITION_FAILED` |
| `POST /v1/account/deletion` | Delete, then use the old access token; delete with a booking that still waits for payment, tickets or a refund; `exportData: true` | `202` with `erasureDueBy` (+30 days); `account.deleted` e-mail; old token `401` (Redis `t:<tenantId>:<env>:cust:<id>` = `0`); [[customer-erasure]] 30 days later; `409 ACCOUNT_DELETION_BLOCKED` with `details.bookingIds`; `403 FEATURE_DISABLED` (`dataExports`) |

### Shopping — `repo:ota/backend/src/shopping`

```diagram
seq-search-price
```

| Endpoint | Try | Should happen |
|---|---|---|
| `POST /v1/flight-searches` | `mode: simple` MAD→PAR; `ZZZ`; `resultOptions.async: true`; the same search twice within 30 s | `201` [[flight-search]] with up to 150 offers (`search_defaults.maxResults` 1-250 overrides it; console scope always asks for 250); zero offers; `403 FEATURE_DISABLED`; the second answers the same search (single flight `t:…:search:<sha256>`) |
| `GET /v1/flight-searches/{id}`, `/offers` | Filters `stops`, `carriers`, `maxPrice`, `departureWindow`, `refundable`, `sort`, `cursor` | SQL over stored offers, no Amadeus call; `/offers` answers `409 SEARCH_NOT_COMPLETED` for a pending or failed search and `410 SEARCH_EXPIRED` after `expires_at`, while `GET …/{id}` keeps answering `200` with `status: expired` |
| `GET /v1/flight-offers/{offerId}` | An expired offer | `200` [[flight-offer]] with selling prices only; `410 OFFER_EXPIRED` |
| `POST /v1/flight-offers/{offerId}/upsells` | Same body twice | [[branded-fare-upsell]] stored as offers `origin = upsell`; second answer `cached: true`; stub `sold-out` → `409 SOLD_OUT` |
| `POST /v1/priced-offers` | Two offers of different searches; `X-Stub-Scenario: price-changed` | `201` [[priced-offer]]; `422 OFFER_COMBINATION_INVALID`; `priceChanged: true` with old and new totals |
| `GET /v1/priced-offers/{id}`, `/ancillaries`, `/fare-rules` | Ancillaries for an expired priced offer | Bags/services catalogue and fare rules from the stored Flight Offers Price answer (Amadeus only when not stored); `410 OFFER_EXPIRED` |

### Checkout and payments — `repo:ota/backend/src/checkout/checkout.controller.ts`, `repo:ota/backend/src/payments/payments.controller.ts`

| Endpoint | Try | Should happen |
|---|---|---|
| `POST /v1/checkouts` | Guest checkout disabled; unverified customer with `require_email_verification` | `201` [[checkout]] `open` (`expires_at` = now + `checkout_ttl_minutes`); `403 FEATURE_DISABLED`; `403 EMAIL_NOT_VERIFIED`. A customer's other open checkout of the same priced offer becomes `abandoned` |
| `PUT /v1/checkouts/{id}/travelers`, `/contacts`, `/ancillaries`, `/remarks` | Stale `If-Match`; invalid passport date; a step while the booking is pending | `200` with new `version`; `412`; `422 TRAVELER_DATA_INVALID`; `409 CHECKOUT_BEING_COMPLETED`. Travellers' documents only in `documents_ciphertext` ([[envelope-encryption]]) |
| `POST /v1/checkouts/{id}/payments` | `method: card` without Stripe keys; with the `.env.example` dummies; `method: airline_card` | `424 PAYMENT_PROVIDER_NOT_CONFIGURED` (and `storefront.get` lists no card); `502 PAYMENT_PROVIDER_ERROR` (Stripe refuses the dummy key); airline card switches the checkout to `pricing_mode = net` ([[pricing-mode]]) |
| `GET/PATCH /v1/payments/{paymentId}` | PATCH `{card: {brand, bin}}` | Re-quotes the [[card-fee]] with Flight Offers Price (`card_fee_amount`, `card_fee_lines`) |
| `POST /v1/checkouts/{id}/complete` | Twice with the same `Idempotency-Key`; before the card is confirmed; a wrong `expectedTotal`; with `X-Stub-Scenario: sold-out` / `server-error` | `201` CheckoutCompletion and a replay of it; `402 PAYMENT_REQUIRED` (declined: `402 PAYMENT_DECLINED`); `409 PRICE_CHANGED` (total above it) or `409 PAYMENT_AMOUNT_MISMATCH`; `409 SOLD_OUT` + void, checkout `open` again; `504 SUPPLIER_TIMEOUT {bookingId}` ([[supplier-timeout]]) |
| `POST /v1/checkouts/{id}/airline-card-completion` | From a `pk_` key; a Luhn-invalid number; 3 declines | `403 SCOPE_NOT_ALLOWED` (edge only); `400 VALIDATION_FAILED` (not counted); `402 PAYMENT_DECLINED` ×2 then `403 PAYMENT_ATTEMPTS_EXCEEDED` |

### Bookings for customers and guests — `repo:ota/backend/src/bookings/customer-bookings.controller.ts`, `repo:ota/backend/src/bookings/lookup.controller.ts`

| Endpoint | Try | Should happen |
|---|---|---|
| `GET /v1/bookings?timeframe=upcoming\|past\|cancelled` | As a guest | Customer session only; guest → `401` |
| `GET /v1/bookings/{id}` (`?refresh=true`) | Another customer's booking; refresh twice within 60 s | `404`; second refresh throttled (`allowedActions.canRefresh` false, reason `throttled`) |
| `PATCH /v1/bookings/{id}` | Contacts; travellers | Amadeus PATCH + `booking.updated` e-mails; travellers → `403 FEATURE_DISABLED` (`travelerChanges`); Amadeus 2552 → `409 VERSION_CONFLICT` |
| `POST /v1/bookings/lookup` (reference or airline record locator + any traveller's last name) | Wrong name vs wrong reference | `200` + [[guest-token]] (`booking_access_tokens`, 24 h, cookie `__Host-vx_bt`); both wrong answers identical `404`; after 5 failures in 15 min (per IP, or per reference) the next lookup answers `429` |
| `GET …/cancellation-quote`, `POST …/cancellation` | Within 3 h of departure; changed `expectedRefund` | [[cancellation-mode]] `not_allowed` (`too_close_to_departure`); `409 REFUND_AMOUNT_CHANGED`; release/void cancel the order; `request_only` → `202` and staff alert |
| `GET …/fare-rules`, `…/ticketing`, `…/events` | A guest token for another booking | Fare rules from the order; ticket status per traveller; customer-visible events only; wrong booking `404` |
| `GET …/documents`, `…/documents/{docId}/download-url`, `GET /v1/files/{storageKey}?exp=&sig=` | A document not rendered yet; a URL 6 minutes old; a changed `sig` | `409 DOCUMENT_NOT_READY`; [[signed-url]] valid 5 minutes; expired or altered → `403 FORBIDDEN` |

### Console auth — `repo:ota/backend/src/identity/staff/staff-auth.controller.ts`

| Endpoint | Try | Should happen |
|---|---|---|
| `POST /v1/console/auth/sign-in` | `grantType: password`; a used [[portal-token]]; a live OTA without MFA | `403 FEATURE_DISABLED` (`passwordGrant`); `401 PORTAL_TOKEN_INVALID`; `403 MFA_REQUIRED`; success writes `staff_actions` `staff.sign_in` and `staffsess:<familyId>` ([[staff-session]]) |
| `POST /v1/console/auth/refresh`, `/sign-out` (`scope: all`), `GET /v1/console/auth/me` | Role changed in the portal, then refresh | `401 REFRESH_TOKEN_INVALID` (sign in again); `scope: all` writes `staffdeny:member:<staffId>` ([[staff-deny-cut-off]]); `me` lists permissions, environments, `storefrontUrl`, `billingNotice` |

### Console bookings — `repo:ota/backend/src/console/console-bookings.controller.ts`

| Endpoint | Permission | Try → should happen |
|---|---|---|
| `GET /v1/console/bookings` (filters `status`, `ticketingStatus`, `reconcileOutcome`, `cancellationRequested`, `q`, …) | `bookings:read` | Only the request's environment (`X-Velexis-Environment`); live rows never in test |
| `GET /v1/console/bookings/{id}` | `bookings:read` | Net amounts, markup rule, payments, staff actions, `cancellationMode`, `canCloseReview` |
| `PATCH /v1/console/bookings/{id}` | `bookings:write` | Amadeus PATCH with `If-Match`; `notifyCustomer` sends `booking.updated` |
| `POST …/issuance` | `bookings:issue` | Captures first, then issues; `allowUnpaid` owner/admin only; airline card only with `other` CASH/ACCOUNT; `409 BOOKING_NOT_MODIFIABLE` (`cancellation_pending`) |
| `POST …/cancellation` | `bookings:cancel` | Release/void only; refund `none`/`full`/`amount`; a waiting customer request → `409` (`pending`) |
| `POST …/review-closure` | `bookings:cancel` | Closes a [[reconcile-outcome]] `manual_review`: order found (record locator must carry the [[velexis-remark]]) or not booked |
| `POST …/resync`, `POST …/notes` | `bookings:write` | Flight Order Management GET (`429` within 10 s of the last refresh); note = `booking_events` row `staff.note`, staff-only unless `visibleToCustomer`; a text that holds a card number is refused (`400 VALIDATION_FAILED`, `card_data` at `/text`). Finance cannot add notes (`403`), although the contract's description says it may |
| `GET /v1/console/bookings/by-record-locator`, `POST …/imports`, `GET …/{id}/amadeus-order` | `bookings:read` / `bookings:write` | [[pnr-import]] with [[office-isolation]] (`403 OFFICE_NOT_ALLOWED`, `409 ORDER_ALREADY_IMPORTED`); verbatim order (audited `order.retrieve`) |

### Console queues, customers, supplier log, raw Amadeus — `repo:ota/backend/src/console`

| Endpoint | Permission | Should happen |
|---|---|---|
| `GET /v1/console/queues/{queueId}`, `GET /v1/console/queue-snapshots` | `queues:read` | Queue List of the tenant's office, stored as a [[queue-snapshot]], each PNR linked to its booking or shown as orphan; the [[queue-poller]] adds snapshots every 15 min |
| `GET /v1/console/customers`, `/{customerId}` | `customers:read` | Search by e-mail/name prefix; the detail is an audited read (`customer.view`) |
| `GET /v1/console/supplier-requests` | `supplier_requests:read` | The [[supplier-request]] log (redacted bodies with `includeBodies`) |
| `/v1/console/amadeus/**` (8 read operations) | `amadeus:read` | [[raw-amadeus]] answers with net prices; foreign offices `403 OFFICE_NOT_ALLOWED`; each call audited `amadeus.<operationId>`; the four raw writes are deferred (`501`) |

### Console payments and settings — `repo:ota/backend/src/console/console-payments.controller.ts`, `repo:ota/backend/src/settings`

| Endpoint | Permission | Should happen |
|---|---|---|
| `GET /v1/console/payments`, `/{id}` | `payments:read` | Payment with events and refunds |
| `POST …/capture` | `payments:capture` | Authorised Stripe payment only, else `409 CONFLICT` (`payment_not_capturable`) |
| `POST …/refunds` | `payments:refund` | `201` refund `pending`, sent by `refund.submit`; airline card → `422` (`refund_via_airline`) |
| `/v1/console/settings/markup-rules`, `/fee-rules` (CRUD) | `settings:read` / `settings:write` | [[markup-rule]] / [[fee-rule]] with `If-Match`; the Default rule cannot be deleted, narrowed or dated |
| `GET/PATCH /v1/console/settings/storefront` | same | [[storefront-settings]] (`version`), deletes `t:…:sf:*` and `t:…:pages:*` |
| `/v1/console/settings/pages`, `/assets` | same | [[content-page]] CRUD; [[storefront-asset]] upload (multipart, ≤ 1 MiB, sniffed: `422 ASSET_INVALID`); delete in use `409` |
| `/v1/console/settings/notification-templates/{key}/{channel}/{locale}` (+ `/preview`, `/reset`) | same | [[notification-template]] put with `If-Match`; `422 TEMPLATE_INVALID` with line errors; reset returns to the code default |

### Webhooks, health and deferred operations

| Endpoint | Should happen |
|---|---|
| `POST /webhooks/stripe/velexis/{environment}`, `/connect/{environment}`, `/c/{connectionId}` | Signature on the raw body, else `400`; `payment_events` row + `stripe.event` job; `200 {received: true}` ([[stripe-webhook]]) |
| `GET /health/live`, `/health/ready` | `200 {"status":"ok"}`; ready `503` when PostgreSQL or Redis is `down`/`timeout`; blocked by Caddy from outside |
| 19 deferred operations (saved travellers, preferences, data exports, post-booking ancillaries and payments, availability search, console bookings create, raw Amadeus writes, `storefront.resolve`) | `501 NOT_IMPLEMENTED` with `details.milestone` and `details.operationId` ([[deferred-operation]]); the body is not validated and only the caller guard runs (no tenant-guard, staff or permission check: a staff member of any role gets the `501`) |

### Worker jobs and schedules — `repo:ota/backend/src/jobs/schedulers.ts`, `repo:ota/backend/src/common/queues/queue-names.ts`

| Queue (concurrency) | Jobs | Triggered by |
|---|---|---|
| `ota-tenant-ops` (2) | `tenant.provision`, `tenant.migrate`, `tenant.suspend`, `tenant.resume` | Platform worker ([[ota-tenant-ops]]); answers on [[platform-tenant-events]] |
| `ota-stripe-events` (4) | `stripe.event` | Webhook receiver |
| `ota-payments` (4) | `payment.void`, `payment.capture_retry`, `refund.submit` | API, schedulers |
| `ota-bookings` (4) | `booking.reconcile`, `booking.sync`, `booking.cancellation_check` | API, schedulers |
| `ota-ticketing` (2) | `ticketing.issue` | Scheduler, API |
| `ota-notifications` (4) | `notify {tenantId}` | After commit, sweep |
| `ota-documents` (2) | `document.render` | Booking events |
| `ota-maintenance` (2) | [[fan-out]] jobs of the schedules below | Job schedulers |

| Schedule (UTC) | Every | Does |
|---|---|---|
| `checkouts.expire` | 1 min | Expire open/payment_pending checkouts past `expires_at` (50 per job), void their authorisations |
| `bookings.reconcile_scan` | 1 min | Adopt stale claims (>2 min), run `booking.reconcile` for bookings with `reconcile_until` |
| `notifications.sweep` | 1 min | `notify` for tenants with due outbox rows |
| `ticketing.scan` | 5 min | `ticketing.issue` for due retries and for abandoned `in_progress` claims |
| `refunds.sweep` | 5 min | Re-queue refunds still `pending` 5 min after their request |
| `bookings.sync_scan` | 10 min | [[booking-sync]]: the 20 oldest active bookings with an order whose trip is not over, not synced for 6 h (1 h in the 24 h before the ticketing deadline) nor claimed for 30 min |
| `offers.purge` | 15 min | Delete ≤ 500 expired searches (cascade) not backing a checkout |
| `queues.poll` | 15 min | Queue List of monitored queues (active tenants only) |
| `customers.erase` | hourly :50 | Erase customers deleted ≥ 30 days − 1 h 5 min ago |
| `retention.daily` | 03:35 | `supplier_requests` > 90 d, `queue_snapshots` > 30 d, expired idempotency keys, sessions/tokens expired > 7 d |
| `payments.authorisation_watch` | 06:15 | Alert staff on authorised payments older than 5 days |

### CLI — `repo:ota/backend/src/cli.ts`

| Command | Should happen |
|---|---|
| `node dist/cli.js help` | Lists the commands; unknown command exit 1 |
| `pnpm --filter @velexis/ota-backend dev:seed` | Demo OTA (above); `APP_ENV=production` exits 1 and writes nothing |
| `node dist/cli.js amadeus:ping --tenant demo --env test` | Resolves the connection, gets a token, one MAD-BCN search; last line `ok`, exit 0; failure prints the code (`SUPPLIER_NOT_CONFIGURED (credentials_refused)`) |
| `node dist/cli.js tenants:report-migrations --report <file>` | Publishes `tenant.migrated` / `tenant.migration_failed` per schema of a fan-out report |
| `node dist/cli.js secrets:rewrap [--tenant <key> \| --all] [--dry-run]` | Re-wraps every tenant ciphertext to `MASTER_KEY_CURRENT` (key rotation runbook) |
| `node dist/cli.js tenants:scrub-card-copies (--tenant <key> \| --all) [--batch-size <n>]` | One-off: drops the card holder and expiry from card copies stored before 2026-10-24 |

## How to …

### Search and price through the API

```diagram
flow-search-price-api
```

### Book with the airline card (no Stripe needed)

```diagram
flow-book-airline-card
```

### Book with a Stripe card

```diagram
flow-book-stripe
```

### Use a customer account (sign up → my trips → change → cancel)

```diagram
flow-customer-account
```

### Find a booking as a guest

```diagram
flow-guest-lookup
```

### Work bookings in the console (issue, cancel, notes)

```diagram
flow-console-bookings
```

### Look up and import a PNR

```diagram
flow-pnr-import
```

### Reproduce a lost order and close the review

```diagram
flow-reconciliation-review
```

### Capture and refund in the console

```diagram
flow-payments-console
```

### Change settings and watch the storefront follow

```diagram
flow-settings-effects
```

### Check the worker (queues, schedules, e-mails, PDFs)

```diagram
flow-worker-checks
```

## Roles and permissions

The [[staff-role]] of the membership decides the [[staff-permission]]s (`repo:ota/backend/src/common/auth/roles.ts`);
the API decides, the OTA admin only hides buttons.

| Permission | owner | admin | agent | finance | viewer |
|---|---|---|---|---|---|
| `bookings:read`, `customers:read`, `payments:read`, `settings:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `bookings:write`, `bookings:issue`, `bookings:cancel`, `queues:read`, `amadeus:read` | ✓ | ✓ | ✓ | | |
| `supplier_requests:read`, `payments:capture` | ✓ | ✓ | ✓ | ✓ | |
| `payments:refund` | ✓ | ✓ | | ✓ | |
| `settings:write`, `amadeus:write` (raw writes deferred), `allowUnpaid` issuance | ✓ | ✓ | | | |
| Live environment (live OTA only) | ✓ | ✓ | ✓ | ✓ | test only |

A forbidden console call answers `403 FORBIDDEN` with `details.requiredPermission` (or `403 ENVIRONMENT_NOT_ALLOWED`,
`403 SCOPE_NOT_ALLOWED` for a key without `console:automation`) and writes a [[staff-action]] row with
`outcome = denied`. Customer scope never sees net amounts, markups or raw supplier errors; a customer or guest reaching
another booking gets `404`, never `403`.

## Bug-hunting checklist

```bug-hunt
**Money.** For a booking, check `total_amount = net_amount + markup_amount + fees_amount + card_fee_amount` (and
ancillaries) against what the page showed; `SELECT reference, status, net_amount, markup_amount, fees_amount,
card_fee_amount, total_amount, amount_paid, amount_refunded FROM tenant_demo.bookings ORDER BY created_at DESC LIMIT 5;`
Payments must keep `amount_refunded ≤ amount_captured ≤ amount`. Airline-card bookings have `pricing_mode = net` and
`markup_amount = 0`. Customer-scope answers must contain no `net*`, `markup*` or `margin*` keys.
```

```bug-hunt
**States.** After each step compare `bookings.status`, `ticketing_status`, `reconcile_outcome`, `checkouts.status`,
`payments.status` with the lifecycle diagrams of the architecture guide; every change must have its `booking_events` / `payment_events` row in
the same transaction (`SELECT type, actor_type, status_from, status_to, created_at FROM tenant_demo.booking_events WHERE
booking_id = 'bkg_…' ORDER BY created_at;`). A booking stuck `pending` without `reconcile_until` for more than 2 minutes
should be adopted by the scan.
```

```bug-hunt
**Time zones.** The void window is "issued today in `storefront_settings.time_zone`", not UTC: book late in the
evening UTC with a non-UTC OTA and check `cancellationMode` and `voidDeadlineAt`. Departure rules use UTC instants
(`departure_at`) while e-mails and PDFs show local times (`departure_local`). Schedules run in UTC.
```

```bug-hunt
**Traveller dates use the UTC day.** `checkout.setTravelers` compares the date of birth and the document issue date
with "today" in UTC (`utcDate(now)`, `repo:ota/backend/src/checkout/checkout.service.ts#L358`), not the OTA's
`storefront_settings.time_zone`. Between local midnight and UTC midnight in a zone ahead of UTC (e.g. Asia), a baby
born today or a passport issued today is refused with `422 TRAVELER_DATA_INVALID` ("The date of birth cannot be in the
future." / "The issue date cannot be in the future.").
```

```bug-hunt
**Tenancy isolation.** With two OTAs, every id of one (booking, checkout, payment, document storage key, asset) must
answer `404` through the other's key, cookie or staff token; console lists must never mix `test` and `live`
(`environment` column). Platform rows are never written by the OTA API (only `dev:seed` as migrator).
```

```bug-hunt
**E-mails (Mailpit).** One e-mail per event (`notifications.dedupe_key` unique): `auth.verify_email`,
`auth.password_reset`, `account.email_changed`, `account.deleted`, `booking.confirmed`, `booking.ticketed`,
`booking.ticketing_delayed`, `booking.cancelled`, `booking.cancellation_requested`, `booking.not_confirmed`,
`booking.updated`, and staff alerts `staff.ticketing_failed`, `staff.manual_review`, `staff.airline_card_alert`
(to `ops_alert_email`, else the owners, else `OPS_ALERT_EMAIL`). Check brand name in From, Reply-To = support e-mail,
links pointing to the OTA's storefront host, attachments, and that `secret_payload_ciphertext` is NULL once `sent`.
```

```bug-hunt
**Card data (PCI).** After any airline-card attempt: no card number, last 12 digits, CVC, holder or expiry in any
tenant table, Redis key, BullMQ job or log line; `payments` keeps `card_brand`, `card_bin`, `card_last4` only;
`supplier_requests.request_body` shows the card as brand + last 4. The completion's body over 10 KB → `400 INVALID_REQUEST` (`body_too_large`) before anything is read.
```

```note
**Card numbers in staff free text are refused.** Every console note, reason and remark answers `400 VALIDATION_FAILED`
with `card_data` at its pointer ("A note never holds a card number: remove it.", or "A reason …" / "A remark …") when
it holds a card number (12 to 19 digits, grouped by single spaces or dashes or not, that start with 2 to 6 and pass the
Luhn check), before the idempotency key is claimed and before anything is stored or sent to Amadeus; the audit keeps one
`failed` row with the action and target only (`repo:ota/backend/src/common/http/card-free-text.ts`). The review-closure
note is checked with its outcome rules, after the key is claimed. Try `4111 1111 1111 1111` as a note: `400`, and
`SELECT summary FROM tenant_<key>.booking_events WHERE type = 'staff.note' ORDER BY created_at DESC LIMIT 1;` shows no
such row.
```

```bug-hunt
**Queues and jobs.** `curl 127.0.0.1:4001/health/ready` shows `oldestWaitingSeconds` per queue: anything growing
means a stuck consumer. Failed jobs: `redis-cli -a dev_redis zrange vx:ota-<queue>:failed 0 -1`. A message that fails
validation is logged `queue.job_invalid` and fails at once. Check `refunds` never stay `pending` beyond the 5-minute
sweep and `notifications` never stay `pending` with `attempts` growing.
```

```bug-hunt
**Caches.** After a settings change the storefront must show it within 5 minutes (`t:<tenantId>:<env>:sf:*` deleted
at once; the storefront's own sessionStorage copy lives 5 min). Platform changes (suspension, keys, domains) reach the
OTA API through `vx:invalidate` within a second, else after the 60 s TTL of `tenant:*`, `apikey:*`, `host:*`.
```

```bug-hunt
**Idempotency and concurrency.** Send `checkout.complete` twice in parallel with the same `Idempotency-Key`: one
booking, one order (`bookings.checkout_id` unique), the second answer a replay. The same key with another body →
`409 IDEMPOTENCY_KEY_REUSED`. Stale `If-Match` everywhere → `412`. Cancelling while the ticketing job holds the
booking → `409 BOOKING_NOT_MODIFIABLE`.
```

```bug-hunt
**Validation and errors.** Every `400 VALIDATION_FAILED` must name field paths, never echo values (passwords, card
numbers). Unknown errors must be `500 INTERNAL_ERROR` with a `requestId` you can find in the logs. Rate limits answer
`429` with `Retry-After`; with Redis stopped, limited routes and every console/Amadeus call answer `503` while stored
bookings and searches stay readable.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Process exits at start with `ConfigError` naming variables | Missing or invalid env value or key file (mode must be 0400/0600) | Compare `ota/backend/.env.local` with `.env.example`; rerun `pnpm dev:keys` |
| Every call `401 INVALID_API_KEY` | Key printed by a different seed run, or revoked | Delete the `dev:seed` key rows of `demo` locally and seed again (keys print only when created) |
| `403 TENANT_SUSPENDED` everywhere | Tenant not `active` (still `provisioning`, or suspended) | Check `platform.tenants.status`; rerun the OTA `dev:seed`; resume in the platform admin |
| Searches answer `424 SUPPLIER_NOT_CONFIGURED` | No active Amadeus connection, or credentials refused (`amadeus:badcred:<credId>` for 5 min) | Start the stub (`pnpm stub:amadeus`); `node dist/cli.js amadeus:ping --tenant demo --env test` |
| `503 SERVICE_UNAVAILABLE` on searches, sign-in, console | Redis down (limits and Amadeus buckets cannot be counted) | Start Redis with the `dev_redis` password |
| Card method missing on the storefront | No Stripe test keys, or `424 PAYMENT_PROVIDER_NOT_CONFIGURED` | Set the three `STRIPE_*_TEST` variables and restart both processes |
| Card method offered but paying fails with `502 PAYMENT_PROVIDER_ERROR` | The `replace_me` dummies of `.env.example` are still in `.env.local` | Put your own Stripe test keys there, or empty both key variables to hide the method |
| Airline card missing | `AIRLINE_CARD_ENABLED` false, switch `airline_card_enabled_test` off, or suspended after 20 declines (`t:…:ac:suspended`, 1 h) | See the airline-card flow; delete the suspension key locally |
| No e-mails in Mailpit | Worker not running, or `SMTP_URL` wrong | Check port 4001 health; `notifications` rows `pending` with `last_error` |
| Booking stays `pending` | Order outcome unknown, reconciler still looking (15 min) | Watch `reconcile_attempts`; `reconcile_outcome = manual_review` → close the review in the console |
| `403 CSRF_TOKEN_INVALID` from the storefront | Cookie `__Host-vx_csrf` missing or `Origin` not the storefront host | Reload `storefront.get`; use the Vite dev server URL, not 127.0.0.1 mixed with localhost |

Runbooks: `repo:ota/docs/runbooks/README.md` (Redis lost, supplier timeouts, ticketing failures, Stripe incidents,
tenant migration failures, JWT key rotation, airline-card go-live).
