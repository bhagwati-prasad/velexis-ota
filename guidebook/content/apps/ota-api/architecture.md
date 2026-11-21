---
id: architecture
title: OTA API and worker — architecture guide
summary: How ota/backend is built - processes, NestJS modules, the request pipeline, tenant schemas and tenantTx, Redis keys and BullMQ queues, the booking orchestration and every lifecycle, integrations, security, configuration, tests and where to change things.
---

## At a glance

| Item | Value |
|---|---|
| Package | `@velexis/ota-backend` (`repo:ota/backend/package.json`), CommonJS, TypeScript 5.6 strict, Node 24 |
| Framework | NestJS 11 on Express 5; `nestjs-pino`, `nestjs-cls`, `@nestjs/bullmq`, `@nestjs/throttler`, `helmet`, `cookie-parser` |
| API | `repo:ota/backend/src/main.ts` + `repo:ota/backend/src/app.module.ts` → `dist/main.js`, `127.0.0.1:4000` |
| Worker | `repo:ota/backend/src/worker.ts` + `repo:ota/backend/src/worker.module.ts` → `dist/worker.js`, health on `127.0.0.1:4001` |
| CLI | `repo:ota/backend/src/cli.ts` → `dist/cli.js` |
| Contract | `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` (136 operations: 117 implemented, 19 deferred → `501`) |
| Data | PostgreSQL 16: one [[tenant-schema]] `tenant_<key>` per OTA (role `velexis_ota_app`), `reference` (read), selected `platform` tables (read, cached); Redis 7 (caches, limits, sessions, BullMQ `vx`) |
| Units on the VM | `velexis-ota-api.service`, `velexis-ota-worker.service`; env `/etc/velexis/ota-backend.env` (+ `ota-worker.env` with the provisioner DSN, worker only) |
| Build / test | `pnpm --filter @velexis/ota-backend build`, `test` (unit + contract), `test:int` (PostgreSQL, Redis, Mailpit), `test:xb` (both backends built) |

The build is plain `tsc` plus copies of the e-mail templates, the breached-password list and the PDF fonts into
`dist/`; the script fails when an entry point is missing.

## Components

```diagram
components
```

| Module (`src/…`) | Job | Main tenant tables | Process |
|---|---|---|---|
| `common` | Guards, OpenAPI validation and idempotency interceptors, error filter, cookie writer, CORS, Redis keys, queue names, Clock, ids | `idempotency_keys` | both |
| `tenancy` | Caller and tenant resolution, read-only platform repository and 60 s caches, `vx:invalidate` subscriber, `TenantContext`, [[tenant-tx]] | — (platform read) | both |
| `identity` (+ `identity/staff`) | Customer sign-up/verification/sign-in/sessions/password reset; console sign-in by [[portal-token]], [[staff-session]]s in Redis | `customers`, `customer_identities`, `customer_sessions`, `customer_password_resets`, `customer_consents` | API |
| `account` | Profile, deletion; [[customer-erasure]] job | `customers` and children | API; erasure in worker |
| `storefront` | `storefront.get`, published pages, public images | `storefront_settings`, `storefront_pages`, `storefront_assets` | API |
| `reference` | Airports, airlines, countries, currencies | `reference.*` | API |
| `shopping` | Search, results/facets, offers, upsell, priced offers, ancillaries, fare rules, purge | `flight_searches`, `flight_offers`, `offer_upsells`, `priced_offers` | API (+ purge in worker) |
| `pricing` | Markup and fee engine, card fees | `markup_rules`, `fee_rules` | both |
| `checkout` | Checkout aggregate, expiry job | `checkouts`, `checkout_*` | both |
| `payments` | [[payment-gateway]] (Stripe in three [[account-mode]]s, airline card), webhooks, Stripe events, capture/void/refund jobs, authorisation watch | `payments`, `payment_events`, `refunds` | both |
| `bookings` | Orchestration, ticketing, [[booking-sync]], [[reconciliation]], change and cancel, my bookings, guest lookup | `bookings`, `booking_*` | both |
| `documents` | Itinerary and e-ticket receipt PDFs, [[signed-url]] downloads | `booking_documents` | both |
| `notifications` | [[outbox]], templates, renderer, SMTP mailer, [[staff-alert]] recipients | `notifications`, `notification_templates` | both (send: worker) |
| `amadeus` | The only Amadeus caller: connection resolver, token provider, [[rate-limit-bucket]]s, timeouts, error mapper, [[supplier-request]] log | `supplier_requests` | both |
| `console` | Console bookings, [[pnr-import]], queues, customers, supplier log, [[raw-amadeus]], payments; [[staff-action]] writer; review closure; [[queue-poller]] | `staff_actions`, `queue_snapshots` | API (+ poller in worker) |
| `settings` | Markup and fee rules, storefront settings, pages, assets, templates | settings tables | API |
| `provisioning` | [[ota-tenant-ops]] consumer, seeds, [[platform-tenant-events]] producer | whole schema (DDL as `velexis_provisioner`) | worker |
| `jobs` | Schedulers, per-tenant [[fan-out]], retention | many | worker |
| `health` | `/health/live`, `/health/ready` | — | both |

Rules: a controller calls one service method; services own transactions; only `amadeus`, `payments`,
`notifications` and `documents` talk to the outside; `storefront` never depends on `settings` (a source scan,
`repo:ota/backend/src/storefront/module-direction.test.ts`, guards it).

## Data

```diagram
er-shopping-booking
```

```diagram
er-customers-settings-ops
```

- **Tenancy.** Every OTA has a schema `tenant_<key>` with the same 44 tables (42 of the baseline + `storefront_assets`
  and `storefront_pages` of `0002`), created by the OTA worker on `tenant.provision`. Tenant data is read and written
  only through [[tenant-tx]] (`repo:ota/backend/src/tenancy/tenant-tx.ts`): one transaction that first runs
  `set_config('search_path', '<schema>, reference', true)` and a 15 s `statement_timeout`; the schema name comes from
  the cached tenant row and is checked against `^tenant_[a-z][a-z0-9_]{1,39}$`. SQL never names a tenant schema.
- **One transaction per step.** No transaction stays open across an Amadeus or Stripe call; multi-row locks follow
  the order checkout → booking → payment → refund (`repo:ota/backend/test/helpers/lock-order.ts` checks it).
- **Platform reads** (`repo:ota/backend/src/tenancy/platform-read.repository.ts`): `tenants`, `tenant_domains`,
  `api_keys`, `tenant_memberships`, `accounts`, `supplier_connections`, `amadeus_accounts`, `amadeus_offices`,
  `payment_provider_connections`, `subscriptions`, `plans`; cached 60 s in Redis and deleted on `vx:invalidate`
  ([[vx-invalidate]]). The OTA role cannot write them; only the development `dev:seed` writes them, as migrator.
- **Migrations** `repo:ota/backend/migrations/tenant`: `0001_baseline` (byte copy of the reference DDL), `0002` MVP
  deltas (airline card, pricing mode, reconciliation columns, settings columns, assets, pages), `0003` sync claim,
  `0004` card fee lines, `0005` cancellation claim + calling-code CHECKs. Each schema keeps its own
  `schema_migrations`; the platform mirrors it from `tenant.provisioned` / `tenant.migrated`.
- **Ids** are [[prefixed-id]]s with a CSPRNG ULID (`bkg_`, `chk_`, `pay_`, …); `srch_`, `off_`, `prc_`, `chk_`, `pay_`
  are capability ids for guests. **Money** is `numeric(12,2)` + `char(3)`, computed with decimal.js
  ([[money-decimal]]); [[net-and-selling-amounts]] are separate columns.
- **Encrypted columns** ([[envelope-encryption]], associated data `tenant_<key>.<table>.<column>:<id>`): traveller
  `documents_ciphertext`, `discount_eligibility_ciphertext`, `notifications.secret_payload_ciphertext`,
  `idempotency_keys.response_ciphertext`, saved-traveller documents.
- **Redis keys** are built only in `repo:ota/backend/src/common/redis/redis.keys.ts` (every key has a TTL; Redis runs
  `noeviction`; tenant data keys start with `t:<tenantId>:<env>:`). Main ones: `tenant:*`, `tenantkey:*`, `host:*`,
  `apikey:*`, `member:*`, `conn:*` (60 s); `amadeus:token:<credId>:<env>`, `amadeus:tokenlock:*`,
  `amadeus:badcred:*`, `rl:amadeus:cred|ten:*`; `t:…:sf:<locale>`, `t:…:pages:<locale>` (5 min); `t:…:search:<sha256>`
  (30 s); `t:…:cxq:<bookingId>` (10 min); `t:…:ac:chk:*`, `ac:declines`, `ac:suspended`; `t:…:authfail:*`;
  `t:…:cust:<id>`; `staffsess:*`, `staffdeny:*`, `ptk:*`, `apikey:used:*`; `rl:ota_*` (throttler).
- **Queues** (`repo:ota/backend/src/common/queues/queue-names.ts`, prefix `vx`, 5 attempts with exponential backoff
  from 30 s, failed jobs kept 30 days, completed 1 day / 1 hour for `ota-maintenance`): `ota-tenant-ops`,
  `platform-tenant-events` (produced), `ota-stripe-events`, `ota-payments`, `ota-bookings`, `ota-ticketing`,
  `ota-notifications`, `ota-documents`, `ota-maintenance`. Payloads carry ids only.
- **Retention**: searches/offers until expiry (unless a checkout references them), `supplier_requests` 90 days,
  `queue_snapshots` 30 days, idempotency keys 24 h, expired sessions and tokens + 7 days; bookings, payments, refunds,
  events and staff actions are kept.

## Key flows

The request pipeline every call passes: Express middleware, then all guards in order (caller, tenant, scope, customer, staff, CSRF, rate limit, permission), then the OpenAPI validation and idempotency interceptors around the controller. The 501 routes of deferred operations bind no operation, so the tenant, scope, customer, staff, CSRF and permission guards let them through (only the caller guard applies):

```diagram
seq-request-pipeline
```

Search and price (`repo:ota/backend/src/shopping`):

```diagram
seq-search-price
```

The booking orchestration in five steps — claim, call, record, money, issue
(`repo:ota/backend/src/bookings/booking-orchestrator.service.ts`):

```diagram
seq-checkout-stripe
```

The airline-card path (PCI, edge only; `repo:ota/backend/src/payments/airline-card`):

```diagram
seq-checkout-airline-card
```

When Amadeus does not answer Flight Create Orders ([[supplier-timeout]]):

```diagram
seq-supplier-timeout
```

Cancellation (`repo:ota/backend/src/bookings/cancellation.service.ts`):

```diagram
seq-cancel-booking
```

Console sign-in and a staff action (`repo:ota/backend/src/identity/staff/staff-auth.service.ts`,
`repo:ota/backend/src/console/console-booking-actions.service.ts`):

```diagram
seq-console-sso-issue
```

Stripe webhooks (`repo:ota/backend/src/payments/webhooks/webhook-receiver.service.ts`):

```diagram
seq-stripe-webhook
```

E-mails, PDFs and downloads (`repo:ota/backend/src/notifications`, `repo:ota/backend/src/documents`):

```diagram
seq-emails-documents
```

Tenant provisioning by the worker (`repo:ota/backend/src/provisioning/tenant-ops.processor.ts`):

```diagram
seq-provisioning
```

## Lifecycles

Booking status (`bookings.status`):

```diagram
booking-states
```

Ticketing status (`bookings.ticketing_status`), driven by the [[ticketing-policy]]:

```diagram
ticketing-states
```

Checkout status:

```diagram
checkout-states
```

Payment status (Stripe and airline card):

```diagram
payment-states
```

Refund status:

```diagram
refund-states
```

Flight search and offers:

```diagram
search-states
```

Customer account:

```diagram
customer-states
```

E-mail outbox (as the code uses it):

```diagram
notification-states
```

Booking documents:

```diagram
document-states
```

Idempotency records:

```diagram
idempotency-states
```

The OTA's own lifecycle (provisioning, active, suspended) belongs to the platform; the OTA worker only acts on the
messages: `tenant.suspend` expires open checkouts, voids their authorisations and writes
`staffdeny:tenant:<tenantId>`; `tenant.resume` deletes it. See the platform's diagram:

```diagram
platform-api/tenant-states
```

## Integrations

| System | Where | How |
|---|---|---|
| [[amadeus-enterprise]] | `repo:ota/backend/src/amadeus/amadeus.client.ts` | 12 operations over `fetch` (types generated in `src/amadeus/generated` from `docs/amadeus-api/*.json`); credentials from the tenant's [[supplier-connection]] (Velexis shared account office or OTA-owned), OAuth token cached encrypted (`amadeus:token:*`, single flight `amadeus:tokenlock:*`); token buckets per credential set and per tenant with a background reserve; per-operation timeouts (`repo:ota/backend/src/amadeus/limits.ts`); retries only for reads and token requests; errors mapped in `error-mapper.ts`; every call one redacted `supplier_requests` row; [[office-isolation]] on imports and raw reads |
| Stripe | `repo:ota/backend/src/payments/stripe/stripe.gateway.ts` | PaymentIntents with manual capture ([[payment-intent]]); account modes `velexis` (Velexis account), `connect_standard` (`Stripe-Account` header), `api_keys` (OTA's own keys, decrypted only here); idempotency keys `pi:create:<pay_id>`, `pi:update:<pay_id>:<version>`, `pi:capture:<pay_id>:<amount>` (`…:cancellation:<amount>` for a cancellation's kept amount), `pi:cancel:<pay_id>`, `refund:<rfd_id>`; webhooks on three endpoints. Both test keys must be set (or both empty): the `.env.example` dummies count as set |
| SMTP | `repo:ota/backend/src/notifications/mailer.gateway.ts` | Nodemailer from the worker only; `From: "<brand>" <MAIL_FROM>`, `Reply-To` support e-mail; Mailpit locally |
| Storage | `@velexis/db/storage` (local disk under `STORAGE_DIR`) | `tenant_<key>/…` keys; PDFs downloaded through HMAC-signed URLs (`DOCUMENT_URL_KEY_FILE`, 5 min); images public and immutable |
| Platform | `repo:ota/backend/src/tenancy`, `repo:ota/backend/src/provisioning` | No HTTP: read-only tables, `vx:invalidate`, `ota-tenant-ops` / `platform-tenant-events`, `ptk:*`, `staffdeny:acct:*`, `apikey:used:*` |
| Apps | [[app:storefront]], [[app:ota-admin]], [[app:sdk]] | The SDK maps every operation by `x-sdk-method`; the OTA admin consumes the SDK server side |

## Security

- **Callers** (`repo:ota/backend/src/tenancy/caller-resolver.ts`, `repo:ota/backend/src/common/auth`): the
  [[edge-secret]] and the [[service-key]] are compared in constant time before any lookup; the service key is accepted
  only on a direct loopback connection without `X-Forwarded-For`; a request with both an edge header and an API key
  is refused; [[publishable-key]]s answer CORS only for their allowed origins; [[key-scope]]s decide customer vs
  console scope.
- **Tokens** (`repo:ota/backend/src/identity/token.service.ts`, `jwt-keys.ts`): EdDSA JWTs signed with the OTA's own
  Ed25519 key (`kid` = JWK thumbprint); customer access 15 min, refresh 12 h (30 days with remember me) rotating in
  `customer_sessions` with reuse detection ([[refresh-family]]); staff refresh families in Redis with four deny keys;
  [[guest-token]]s hashed in `booking_access_tokens`. During a key rotation `JWT_PREVIOUS_PUBLIC_KEY_FILE` verifies
  old tokens for 15 minutes.
- **Cookies and CSRF**: `__Host-vx_at`, `__Host-vx_rt`, `__Host-vx_bt` are HttpOnly [[host-cookie]]s; only
  `__Host-vx_csrf` is readable, and every edge write must echo it in `X-CSRF-Token` with a matching `Origin`
  ([[csrf-token]], `repo:ota/backend/src/common/auth/csrf.guard.ts`).
- **Passwords**: argon2id, breached-password list (`repo:ota/backend/src/identity/breached-passwords.txt`), lockout
  after 5 failures for 15 min ([[account-lockout]]).
- **Rate limits** (`repo:ota/backend/src/common/http/rate-limits.ts`): sign-in 10/min/IP; sign-up, reset, resend
  5/h/IP and 3/h/address; shopping 30/min/IP (edge, `pk_`); lookup 5 failures/15 min per IP and reference; checkout
  payment/complete 10/min/IP; airline card 5/min/IP, 3 per checkout, 60/h per tenant, suspension after 20 declines/h;
  console 600/min per session or key; downloads 120/min/IP. A limit that cannot be counted (Redis down) answers `503`,
  never skipped.
- **PCI scope** ([[pci-scope]], [[sensitive-card]]): the airline card is accepted only from the storefront edge, lives
  in memory for one request, is never logged, queued or stored; only brand, BIN and last 4 persist. Both units run with
  `LimitCORE=0` and no swap. `test/integration/payments/pan-absence.int.test.ts` scans every table, Redis key, job and
  log line after each path.
- **Redaction**: every stored payload copy passes the shared redactor of `@velexis/logger` (supplier bodies, order
  snapshots, events, staff actions, idempotency bodies, notification payloads); identity document numbers keep their
  last 4. Request bodies are never logged.
- **Audit**: one [[staff-action]] row per state-changing or refused console call and per audited read
  (`repo:ota/backend/src/console/staff-actions.writer.ts`). Every console free-text field (notes, reasons, remarks,
  process and emergency-contact texts) refuses a card number in the request validation, before the idempotency key is
  claimed and before any booking write or supplier call (`400 VALIDATION_FAILED`, field code `card_data`;
  `holdsCardNumber` of `@velexis/logger`, `repo:ota/backend/src/common/http/card-free-text.ts`); the refusal's audit row
  holds the action and target only. The review-closure note keeps its own check
  (`repo:ota/backend/src/console/review-closure.service.ts`).
- **Tenancy**: only `active` tenants are served (`403 TENANT_SUSPENDED`); every repository has a two-tenant isolation
  test. Review: `repo:ota/docs/security-review.md`.

## Configuration

Validated by `repo:ota/backend/src/config.ts` (one `ConfigError` naming every bad variable, never a value; exit 1).
The API and the worker validate separate schemas. Template: `repo:ota/backend/.env.example`.

| Variable | Process | Purpose |
|---|---|---|
| `APP_ENV`, `LOG_LEVEL`, `PORT` (4000), `HEALTH_PORT` (4001), `TRUST_PROXY` | both / API / worker | Environment, logging, ports, client IPs from Caddy |
| `DATABASE_URL` | both | `velexis_ota_app` |
| `DATABASE_PROVISIONER_URL` | worker | `velexis_provisioner` for tenant DDL (the API cannot read it) |
| `REDIS_URL` | both | Caches, limits, sessions, queues |
| `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT` | both | Envelope encryption keys (`local:v<N>`) |
| `API_KEY_PEPPER_FILE`, `JWT_PRIVATE_KEY_FILE`, `JWT_PREVIOUS_PUBLIC_KEY_FILE`, `DOCUMENT_URL_KEY_FILE` | API | Key HMAC pepper, Ed25519 signing key (+ previous public key during rotation), signed-URL key; files mode 0400/0600 |
| `VELEXIS_EDGE_SECRET`, `OTA_ADMIN_SERVICE_KEY` | API | Storefront edge credential (same as Caddy), OTA admin service key |
| `PUBLIC_OTA_API_URL`, `PUBLIC_OTA_ADMIN_URL`, `STOREFRONT_BASE_DOMAIN` | API / worker | Absolute URLs, staff alert links, `<key>.<base>` hosts |
| `SMTP_URL`, `MAIL_FROM`, `OPS_ALERT_EMAIL` | worker (ops: both) | E-mail sending and the last-resort alert address |
| `STRIPE_SECRET_KEY_TEST\|LIVE`, `STRIPE_PUBLISHABLE_KEY_TEST\|LIVE` | both | Velexis Stripe account per environment (empty: no card method) |
| `STRIPE_WEBHOOK_SECRET_VELEXIS_TEST\|LIVE`, `STRIPE_WEBHOOK_SECRET_CONNECT_TEST\|LIVE` | API | Webhook signing secrets |
| `AMADEUS_BASE_URL_TEST\|LIVE` | both | Override of the Amadeus host (the stub `http://127.0.0.1:4900` locally) |
| `AIRLINE_CARD_ENABLED` | both | Global kill switch of the airline card |
| `STORAGE_DRIVER`, `STORAGE_DIR` | both | Document and image storage |
| `SENTRY_DSN` | both | Error tracking (off when empty) |
| `TEST_DATABASE_ADMIN_URL`, `MAILPIT_API_URL` | tests | Integration harness |

Never in environment variables: Amadeus credentials and OTA Stripe keys (encrypted in platform rows), card data.
Timeouts and batch sizes are constants (`repo:ota/backend/src/amadeus/limits.ts`, `repo:ota/backend/src/jobs/limits.ts`).

## Testing

| Level | Where | Run one |
|---|---|---|
| Unit | `src/**/*.test.ts` (pricing tables, error mapper, guards, `SensitiveCard`, Markdown parser, Redis key builders, redaction) | `pnpm --filter @velexis/ota-backend test -- src/pricing` |
| Contract | `repo:ota/backend/test/contract` (route parity with `x-milestone`, response conformance, migration `0002` byte check, redaction coverage) | `pnpm --filter @velexis/ota-backend test -- contract` |
| Integration | `repo:ota/backend/test/integration` (every endpoint: success, validation, auth, two-tenant isolation; PAN absence) | `pnpm --filter @velexis/ota-backend test:int -- test/integration/bookings/cancel.int.test.ts` |
| Cross-backend | `repo:ota/backend/test/cross-backend/m5.xb.test.ts` (built platform + OTA processes) | `pnpm --filter @velexis/ota-backend test:xb` after building both backends |
| Load (by hand) | `repo:ota/backend/test/load/README.md` (`search-load.mjs`, `booking-load.mjs`) | See its README; results in `repo:ota/docs/performance.md` |
| End to end | `repo:tools/e2e/specs/storefront`, `repo:tools/e2e/specs/ota-admin` | `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/search.e2e.ts` |

Test names end with the plan's task id and criterion (`… [OBE-031 AC2]`), which is the fastest way to find the test of
a behaviour you suspect.

## Where to change things

| To change … | Look at |
|---|---|
| An endpoint's shape, status codes, error codes, SDK method | `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` first, then `pnpm contracts:generate`, then the controller |
| Which caller/key is accepted, tenant resolution, CORS for `pk_` keys | `repo:ota/backend/src/tenancy/caller-resolver.ts`, `repo:ota/backend/src/tenancy/tenant-resolver.ts`, `repo:ota/backend/src/tenancy/api-key.verifier.ts`, `repo:ota/backend/src/common/http/cors.ts` |
| Console permissions per role, live environment rule | `repo:ota/backend/src/common/auth/roles.ts`, `repo:ota/backend/src/common/auth/permission.guard.ts` |
| Rate limits | `repo:ota/backend/src/common/http/rate-limits.ts` |
| Redis key names and TTLs | `repo:ota/backend/src/common/redis/redis.keys.ts` |
| Error envelope, unknown errors | `repo:ota/backend/src/common/http/error.filter.ts` |
| Idempotency behaviour | `repo:ota/backend/src/common/http/idempotency.service.ts` |
| Customer sign-up, sign-in, sessions, lockout, password rules | `repo:ota/backend/src/identity/sign-up.service.ts`, `repo:ota/backend/src/identity/sign-in.service.ts`, `repo:ota/backend/src/identity/sessions.service.ts`, `repo:ota/backend/src/identity/lockout.ts`, `repo:ota/backend/src/identity/password-policy.ts` |
| Staff console sign-in and sessions | `repo:ota/backend/src/identity/staff/staff-auth.service.ts`, `repo:ota/backend/src/identity/staff/staff-sessions.ts` |
| Account deletion and erasure | `repo:ota/backend/src/account/account.service.ts`, `repo:ota/backend/src/account/erasure.service.ts` |
| Search, result filters, facets, offers per search | `repo:ota/backend/src/shopping/searches.service.ts`, `repo:ota/backend/src/shopping/facets.ts`, `repo:ota/backend/src/shopping/offers.mapper.ts` |
| Pricing, upsell, fare rules, ancillaries | `repo:ota/backend/src/shopping/priced-offers.service.ts`, `repo:ota/backend/src/shopping/upsell.service.ts`, `repo:ota/backend/src/checkout/ancillaries.service.ts` |
| Markups and fees (selling prices) | `repo:ota/backend/src/pricing/pricing-engine.ts`, `repo:ota/backend/src/pricing/rule-matcher.ts`, `repo:ota/backend/src/payments/card-fees.ts` |
| Checkout steps, traveller validation, expiry | `repo:ota/backend/src/checkout/checkout.service.ts`, `repo:ota/backend/src/checkout/requirements.ts`, `repo:ota/backend/src/checkout/traveler-documents.ts`, `repo:ota/backend/src/checkout/checkout-expiry.processor.ts` |
| Payment creation, Stripe calls, payment state rules | `repo:ota/backend/src/payments/payments.service.ts`, `repo:ota/backend/src/payments/stripe/stripe.gateway.ts`, `repo:ota/backend/src/payments/payment-state.ts` |
| Airline card validation, limits, completion | `repo:ota/backend/src/payments/airline-card/airline-card-completion.service.ts`, `repo:ota/backend/src/payments/airline-card/card-validation.ts`, `repo:ota/backend/src/payments/airline-card/abuse-limits.ts` |
| Stripe webhooks and their processing | `repo:ota/backend/src/payments/webhooks/webhook-receiver.service.ts`, `repo:ota/backend/src/payments/stripe-events.processor.ts` |
| Capture retry, void, refunds jobs | `repo:ota/backend/src/payments/payments.processor.ts`, `repo:ota/backend/src/payments/refunds-sweep.processor.ts` |
| Booking creation (claim, order, record, capture, issue) | `repo:ota/backend/src/bookings/booking-orchestrator.service.ts`, `repo:ota/backend/src/bookings/order-request.builder.ts`, `repo:ota/backend/src/bookings/order-recorder.ts` |
| Booking reference format, VELEXIS remark | `repo:ota/backend/src/bookings/booking-reference.ts` |
| Ticketing retries and deadlines | `repo:ota/backend/src/bookings/ticketing.service.ts`, `repo:ota/backend/src/bookings/ticketing-schedule.ts` |
| Reconciliation after a timeout | `repo:ota/backend/src/bookings/reconcile.service.ts`, `repo:ota/backend/src/console/review-closure.service.ts` |
| Booking sync and schedule changes | `repo:ota/backend/src/bookings/booking-sync.service.ts`, `repo:ota/backend/src/bookings/order-diff.ts`, `repo:ota/backend/src/bookings/sync-schedule.ts` |
| Which self-service buttons a booking shows | `repo:ota/backend/src/bookings/allowed-actions.ts` |
| Cancellation modes, refund estimate, money step | `repo:ota/backend/src/bookings/cancellation-mode.ts`, `repo:ota/backend/src/bookings/cancellation.service.ts`, `repo:ota/backend/src/bookings/cancellation-state.ts` |
| Contact changes and their e-mails | `repo:ota/backend/src/bookings/booking-changes.service.ts`, `repo:ota/backend/src/bookings/booking-updated-emails.ts` |
| Guest lookup and booking tokens | `repo:ota/backend/src/bookings/guest-access.service.ts` |
| What customers / console see of a booking | `repo:ota/backend/src/bookings/bookings.mapper.ts`, `repo:ota/backend/src/console/console-bookings.mapper.ts` |
| Console issue, cancel, patch, resync, notes | `repo:ota/backend/src/console/console-booking-actions.service.ts` |
| PNR lookup and import, office isolation | `repo:ota/backend/src/console/pnr-import.service.ts`, `repo:ota/backend/src/console/raw-amadeus.service.ts` |
| Queues view and poller | `repo:ota/backend/src/console/queues.service.ts`, `repo:ota/backend/src/console/queue-poller.processor.ts` |
| Console payments (capture, refund) | `repo:ota/backend/src/console/console-payments.service.ts` |
| Audit rows | `repo:ota/backend/src/console/staff-actions.writer.ts` |
| Storefront settings, pages, assets, templates (console) | `repo:ota/backend/src/settings/storefront-settings.service.ts`, `repo:ota/backend/src/settings/pages.service.ts`, `repo:ota/backend/src/settings/assets.service.ts`, `repo:ota/backend/src/settings/templates.service.ts`, `repo:ota/backend/src/settings/pricing-rules.service.ts` |
| `storefront.get` answer and its cache | `repo:ota/backend/src/storefront/storefront.service.ts`, `repo:ota/backend/src/storefront/storefront.mapper.ts` |
| Content page Markdown subset | `repo:ota/backend/src/storefront/markdown-subset.parser.ts` |
| E-mail texts (code defaults), allowed variables | `repo:ota/backend/src/notifications/templates`, `repo:ota/backend/src/notifications/templates/registry.ts` |
| E-mail rendering, sending, recipients of staff alerts | `repo:ota/backend/src/notifications/renderer.ts`, `repo:ota/backend/src/notifications/notifications.processor.ts`, `repo:ota/backend/src/notifications/staff-recipients.ts` |
| PDF layout | `repo:ota/backend/src/documents/renderers/itinerary.renderer.ts`, `repo:ota/backend/src/documents/renderers/e-ticket-receipt.renderer.ts` |
| Signed download URLs | `repo:ota/backend/src/documents/signed-url.ts`, `repo:ota/backend/src/documents/files.controller.ts` |
| Amadeus timeouts, buckets, retries, error mapping | `repo:ota/backend/src/amadeus/limits.ts`, `repo:ota/backend/src/amadeus/rate-limiter.ts`, `repo:ota/backend/src/amadeus/error-mapper.ts`, `repo:ota/backend/src/amadeus/token-provider.ts`, `repo:ota/backend/src/amadeus/connection-resolver.ts` |
| Schedules (cron, statuses), batch sizes | `repo:ota/backend/src/jobs/schedulers.ts`, `repo:ota/backend/src/jobs/limits.ts`, `repo:ota/backend/src/jobs/fan-out.ts` |
| Retention purges | `repo:ota/backend/src/jobs/retention.repository.ts`, `repo:ota/backend/src/shopping/offers-purge.processor.ts` |
| Provisioning, tenant seeds (default settings, markup, templates) | `repo:ota/backend/src/provisioning/provisioning.service.ts`, `repo:ota/backend/src/provisioning/seeds/storefront-settings.seed.ts`, `repo:ota/backend/src/provisioning/seeds/markup-rules.seed.ts`, `repo:ota/backend/src/provisioning/seeds/templates.seed.ts` |
| Suspend / resume behaviour | `repo:ota/backend/src/provisioning/housekeeping.service.ts` |
| A tenant table or column (DB fix) | a new file in `repo:ota/backend/migrations/tenant` (never edit a merged one; read `repo:ota/backend/migrations/README.md`), then `pnpm db:migrate:tenants` and `pnpm db:codegen` |
| Demo data | `repo:ota/backend/src/dev/dev-seed.command.ts` |
| Environment variables | `repo:ota/backend/src/config.ts`, `repo:ota/backend/.env.example` |

## Further reading

- Component spec: `repo:ota/backend/README.md`; contract change logs `repo:ota/docs/api-changes.md`,
  `repo:ota/docs/api-changes-console-and-internal.md`
- Design: `repo:ota/docs/architecture.md`, `repo:ota/docs/architecture-booking.md`, `repo:ota/docs/data-model.md`,
  `repo:ota/docs/scope.md`, `repo:ota/docs/security-review.md`, `repo:ota/docs/performance.md`
- Flows: `repo:ota/docs/flows/search-and-price.md`, `repo:ota/docs/flows/checkout-stripe.md`,
  `repo:ota/docs/flows/checkout-airline-card.md`, `repo:ota/docs/flows/ticketing-and-documents.md`,
  `repo:ota/docs/flows/change-and-cancel.md`, `repo:ota/docs/flows/my-bookings-and-guest-lookup.md`,
  `repo:ota/docs/flows/console-operations.md`, `repo:ota/docs/flows/amadeus-connection-and-tokens.md`,
  `repo:ota/docs/flows/tenant-provisioning-worker.md`
- Runbooks: `repo:ota/docs/runbooks/README.md`, `repo:ota/docs/runbooks/supplier-timeout-and-reconciliation.md`,
  `repo:ota/docs/runbooks/ticketing-failures.md`, `repo:ota/docs/runbooks/stripe-incidents.md`,
  `repo:ota/docs/runbooks/tenant-migration-failures.md`, `repo:ota/docs/runbooks/jwt-key-rotation.md`
- ADRs: `repo:ota/docs/adr/README.md` (OADR-0001 Amadeus client … OADR-0018), platform-wide
  `repo:docs/mvp/adr/0004-postgresql-schema-per-tenant.md`, `repo:docs/mvp/adr/0009-background-jobs-bullmq.md`,
  `repo:docs/mvp/adr/0011-payments-stripe-and-airline-card.md`; database conventions `repo:docs/velexis-sdk/db/README.md`
