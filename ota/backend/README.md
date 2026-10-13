# OTA backend (`@velexis/ota-backend`)

This is the NestJS 11 data-plane backend of Velexis: the OTA booking API used by the hosted storefront (through Caddy's same-origin `/api` proxy), by the OTA admin (server side) and by third-party frontends with API keys, the Stripe payment webhook receivers, and a worker process for provisioning, tenant migrations, ticketing, booking sync and reconciliation, notifications, documents and housekeeping. This page is the component specification: folder and module tree, environment variables, processes and workers, commands, the Amadeus stub, the OpenAPI document and tests. Design and decisions are in [`../docs/`](../docs/README.md); start with [`../docs/architecture.md`](../docs/architecture.md).

Related: [`../docs/scope.md`](../docs/scope.md), [`../docs/api-changes.md`](../docs/api-changes.md), [`../docs/data-model.md`](../docs/data-model.md), [`.env.example`](.env.example), [MVP tech stack](../../docs/mvp/tech-stack.md#ota-backend-otabackend-velexisota-backend), [conventions](../../docs/mvp/conventions.md#2-nestjs-backends), [local development](../../docs/mvp/local-development.md).

## 1. At a glance

| Item | Value |
|---|---|
| Runtime | Node.js 22, TypeScript 5.6 strict, CommonJS output |
| Framework | NestJS 11 (Express 5), `nestjs-pino`, `nestjs-cls`, `@nestjs/bullmq`, `@nestjs/throttler`, `helmet`, `cookie-parser` |
| Data | Tenant schemas `tenant_<key>` (DML, role `velexis_ota_app`), `reference` (read), selected `platform` tables (read-only, cached), through `@velexis/db` (Kysely) |
| Processes | API `dist/main.js` on `127.0.0.1:4000`; worker `dist/worker.js` with health on `127.0.0.1:4001`; CLI `dist/cli.js` |
| Public hosts | `https://api.ota.example.com` and `/api/*` on every storefront host (`<key>.ota.example.com`, verified custom domains); `/internal/*` and `/health/ready` blocked publicly |
| Contract | `openapi/velexis-ota-booking-api.openapi.yaml` (copied in M0 by X-006, extended per [`../docs/api-changes.md`](../docs/api-changes.md)) |
| systemd units | `velexis-ota-api.service`, `velexis-ota-worker.service` ([ADR-0007](../../docs/mvp/adr/0007-single-vm-without-docker.md)); env files `/etc/velexis/ota-backend.env` (both) and `/etc/velexis/ota-worker.env` (worker only, migrator DSN) |

## 2. Folder tree

```
ota/backend/
├── package.json                    @velexis/ota-backend
├── nest-cli.json, tsconfig.json, tsconfig.build.json
├── .env.example
├── openapi/
│   ├── velexis-ota-booking-api.openapi.yaml    source of truth (ADR-0006)
│   └── README.md                                how to change it (X-006)
├── migrations/
│   └── tenant/
│       ├── 0001_baseline.sql                    byte copy of docs/velexis-sdk/db/tenant.sql
│       └── 0002_add_mvp_tenant_deltas.sql       ../docs/data-model-migration-0002.md
├── src/
│   ├── main.ts                     HTTP entry (raw body on /webhooks/*, trust proxy loopback, body limits)
│   ├── worker.ts                   BullMQ processors and schedulers, health server on HEALTH_PORT
│   ├── cli.ts                      dev:seed, tenants:report-migrations, amadeus:ping
│   ├── app.module.ts, worker.module.ts
│   ├── config.ts                   @velexis/config schema of every variable of §3
│   ├── common/
│   │   ├── auth/                   caller, tenant, scope, customer, staff, booking-token, csrf guards; decorators
│   │   ├── http/                   request context, OpenAPI validation and idempotency interceptors, error filter, cookie writer
│   │   ├── redis/                  ioredis client, key helpers, rate-limit storage
│   │   ├── queues/                 queue names, producers, @velexis/api-types/jobs validation
│   │   └── clock.ts, ids.ts        injectable Clock and prefixed-ULID generator
│   ├── tenancy/                    caller resolver, platform read repository, caches, vx:invalidate subscriber, tenant context
│   ├── identity/                   customer auth (cookie + bearer), sessions, password reset, verification; staff auth (portal token), staff sessions
│   ├── account/                    profile, deletion
│   ├── storefront/                 storefront.get, pages (Markdown subset parser → blocks), public assets controller
│   ├── reference/                  locations, airports, airlines, countries, currencies
│   ├── amadeus/                    client, connection-resolver, token-provider, rate-limiter, error-mapper, generated/ (types)
│   ├── pricing/                    markup and fee engine (pure), card fees
│   ├── shopping/                   search, results, offers, upsell, pricing, ancillaries, fare rules, offers-purge.processor.ts
│   ├── checkout/                   checkout aggregate, travellers (encryption), contacts, ancillaries, remarks, checkout-expiry.processor.ts
│   ├── payments/                   payment-gateway.ts, stripe/ (gateway, client factory, webhooks), airline-card/ (gateway, SensitiveCard),
│   │                               stripe-events.processor.ts, payments.processor.ts (void, capture retry, refunds)
│   ├── bookings/                   booking-orchestrator.service.ts, customer bookings, lookup and guest tokens, cancellation,
│   │                               ticketing.processor.ts, booking-sync.processor.ts, reconcile.processor.ts
│   ├── documents/                  pdfmake renderers (itinerary, e-ticket receipt), documents.processor.ts, files.controller.ts (signed URLs)
│   ├── notifications/              outbox service, notifications.processor.ts, mailer.gateway.ts, templates/<key>.{subject,html,txt}.hbs
│   ├── console/                    bookings, imports, queues (queue-poller.processor.ts), customers, supplier log, raw Amadeus (read), payments
│   ├── settings/                   markup rules, fee rules, storefront settings, pages, assets upload, notification templates
│   ├── provisioning/               tenant-ops.processor.ts, seeds/, tenant-events.producer.ts, suspend/resume housekeeping
│   ├── jobs/                       schedulers.ts (upsertJobScheduler), fan-out, retention.processor.ts
│   └── health/
└── test/
    ├── builders/                   checkouts, bookings, payments, offers, staff tokens
    ├── fixtures/stripe/            signed Stripe event fixtures (X-028)
    ├── integration/<module>/*.int.test.ts
    └── contract/                   route parity (+ 501 allow-list), response conformance, jobs schemas, baseline checksum, error catalogue
```

Each module follows [`conventions.md` §2](../../docs/mvp/conventions.md#layout-one-module-per-bounded-context): thin controllers bound to an `operationId`, services owning transactions, Kysely repositories that take the transaction first, gateways for external calls, processors for jobs. Responsibilities and dependencies are in [`../docs/architecture.md`](../docs/architecture.md) §2.

## 3. Environment variables

Loaded and validated by `src/config.ts`; the process refuses to start on a missing or invalid value. On the VM they come from `/etc/velexis/ota-backend.env` and, for the worker only, `/etc/velexis/ota-worker.env` ([`deploy/env/`](../../deploy/env/)); locally from `.env.local` based on [`.env.example`](.env.example) and the root `.env.example`. "New" marks variables this document adds to the [configuration matrix](../../docs/mvp/architecture.md#6-configuration-matrix); the task that first reads one adds it there, to the root `.env.example` and to `deploy/env/` ([`conventions.md` §8](../../docs/mvp/conventions.md#8-configuration)).

| Variable | Required | Example (placeholder) | Purpose | Since |
|---|---|---|---|---|
| `APP_ENV` | yes | `development` \| `test` \| `production` | Environment name | M0 |
| `LOG_LEVEL` | no (`info`) | `info` | pino level | M0 |
| `PORT` | API | `4000` | API port (127.0.0.1) | M0 |
| `HEALTH_PORT` | worker | `4001` | Worker health port | M0 |
| `TRUST_PROXY` | no (`loopback`) | `loopback` | Client IPs from Caddy (new) | M2 |
| `DATABASE_URL` | yes | `postgres://velexis_ota_app:…@127.0.0.1:5432/velexis` | App role | M0 |
| `DATABASE_MIGRATOR_URL` | worker | `postgres://velexis_migrator:…@127.0.0.1:5432/velexis` | Provisioning and tenant migrations | M1 |
| `REDIS_URL` | yes | `redis://:…@127.0.0.1:6379/0` | Caches, tokens, rate limits, queues | M0 |
| `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT` | yes | `/etc/velexis/keys`, `local:v1` | Envelope encryption ([ADR-0010](../../docs/mvp/adr/0010-secrets-envelope-encryption.md)) | M2 |
| `API_KEY_PEPPER_FILE` | yes | `/etc/velexis/keys/api-key-pepper` | HMAC pepper of API keys (shared with the platform) | M2 |
| `JWT_PRIVATE_KEY_FILE` | yes | `/etc/velexis/keys/ota-jwt-ed25519.pem` | Customer and staff token signing | M3 |
| `DOCUMENT_URL_KEY_FILE` | yes | `/etc/velexis/keys/document-url.key` | Signed download URLs | M3 |
| `SMTP_URL`, `MAIL_FROM` | yes | `smtp://127.0.0.1:1025`, `"Velexis OTA" <no-reply@mail.ota.example.com>` | E-mails (the display name is replaced by the OTA brand) | M3 |
| `OPS_ALERT_EMAIL` | yes | `ops@example.com` | Velexis ops alerts (airline-card abuse, bad Amadeus credentials) (new for this app) | M3 |
| `PUBLIC_OTA_API_URL` | yes | `https://api.ota.example.com` | Absolute URLs for key callers (assets, files) | M2 |
| `PUBLIC_OTA_ADMIN_URL` | yes | `https://admin.ota.example.com` | Links in staff alert e-mails (new for this app) | M3 |
| `STOREFRONT_BASE_DOMAIN` | yes | `ota.example.com` | `<key>.<base>` host resolution | M2 |
| `VELEXIS_EDGE_SECRET` | yes | (generated) | Storefront edge credential, same value as Caddy ([ADR-0018](../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)) | M2 |
| `OTA_ADMIN_SERVICE_KEY` | yes | (generated) | OTA admin service credential ([ADR-0008](../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md)) | M4 |
| `STRIPE_SECRET_KEY_TEST`, `STRIPE_PUBLISHABLE_KEY_TEST` | M3 | `sk_test_…`, `pk_test_…` | Velexis account, `velexis` and `connect_standard` modes, test | M3 |
| `STRIPE_SECRET_KEY_LIVE`, `STRIPE_PUBLISHABLE_KEY_LIVE` | live | (empty until M6) | Same, live | M5 |
| `STRIPE_WEBHOOK_SECRET_VELEXIS_TEST`, `…_LIVE` | M3 | `whsec_…` | `/webhooks/stripe/velexis/{test,live}` | M3 |
| `STRIPE_WEBHOOK_SECRET_CONNECT_TEST`, `…_LIVE` | M5 | `whsec_…` | `/webhooks/stripe/connect/{test,live}` | M5 |
| `AMADEUS_BASE_URL_TEST`, `AMADEUS_BASE_URL_LIVE` | no | `http://127.0.0.1:4900` (stub) | Override of the Amadeus host; empty = connection or official host | M2 |
| `AIRLINE_CARD_ENABLED` | no (`false`) | `false` | Global kill switch of the airline-card method ([ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)); `true` only in development and CI until M6 | M3 |
| `STORAGE_DRIVER`, `STORAGE_DIR` | no | `local`, `/var/lib/velexis/storage` | `StorageAdapter` ([ADR-0017](../../docs/mvp/adr/0017-email-documents-storage.md)) | M3 |
| `SENTRY_DSN` | no | (empty) | Error tracking, off when empty | M6 |
| `TEST_DATABASE_ADMIN_URL`, `MAILPIT_API_URL` | tests | see root `.env.example` | Integration test harness | M2 |

Never in environment variables: Amadeus credentials (encrypted in `platform.amadeus_accounts` and `supplier_connections`), OTA-owned Stripe keys (encrypted in `payment_provider_connections`), card data. Timeouts, bucket sizes and batch sizes are constants in code (`src/amadeus/limits.ts`, `src/jobs/limits.ts`).

## 4. Processes, queues and schedules

Full tables in [`../docs/architecture.md`](../docs/architecture.md) §6 and [OADR-0014](../docs/adr/0014-per-tenant-workers-and-schedulers.md). Summary:

| Queue | Role of this backend | Processor |
|---|---|---|
| `ota-tenant-ops` | Consumer (`tenant.provision`, `tenant.migrate`, `tenant.suspend`, `tenant.resume`) | `provisioning/tenant-ops.processor.ts` |
| `platform-tenant-events` | Producer | `provisioning/tenant-events.producer.ts` |
| `ota-stripe-events` | Both | `payments/stripe-events.processor.ts` |
| `ota-payments` | Both | `payments/payments.processor.ts` |
| `ota-bookings` | Both | `bookings/reconcile.processor.ts`, `bookings/booking-sync.processor.ts` |
| `ota-ticketing` | Both | `bookings/ticketing.processor.ts` |
| `ota-notifications` | Both | `notifications/notifications.processor.ts` |
| `ota-documents` | Both | `documents/documents.processor.ts` |
| `ota-maintenance` | Both | `jobs/` fan-out, purges, queue poller |

The API process only produces jobs; every processor and scheduler runs in the worker. Schedulers are declared at worker start-up with `upsertJobScheduler`.

## 5. Commands

Run from the repository root (`pnpm --filter @velexis/ota-backend <script>`) or with the root shortcuts of [`AGENTS.md`](../../AGENTS.md#10-commands-cheat-sheet).

| Command | Does |
|---|---|
| `pnpm --filter @velexis/ota-backend dev` | API and worker in watch mode (`dev:api` + `dev:worker`) |
| `pnpm --filter @velexis/ota-backend build` | `dist/main.js`, `dist/worker.js`, `dist/cli.js` |
| `pnpm --filter @velexis/ota-backend test` | Unit and contract tests (Vitest) |
| `pnpm --filter @velexis/ota-backend test:int` | Integration tests (PostgreSQL 16, Redis 7, Mailpit; the Amadeus stub starts in-process) |
| `pnpm db:migrate:tenants` | Apply `migrations/tenant` to every tenant schema (fan-out, `DATABASE_MIGRATOR_URL`) |
| `pnpm db:codegen` | Regenerate Kysely types after a migration |
| `pnpm contracts:lint` / `pnpm contracts:generate` | Lint the OpenAPI document / regenerate `@velexis/api-types` and `@velexis/errors` |
| `pnpm --filter @velexis/ota-backend amadeus:types` | Regenerate `src/amadeus/generated/` from `docs/amadeus-api/*.json` |
| `pnpm stub:amadeus` | Start the Amadeus stub on `127.0.0.1:4900` |
| `pnpm --filter @velexis/ota-backend dev:seed` | Development only (refused when `APP_ENV=production`): provisions `tenant_demo` through the real provisioning function, with storefront host `demo.ota.example.com`, a test Amadeus connection to the stub and test API keys printed once (needs the platform's `dev:seed` first) |
| `node dist/cli.js tenants:report-migrations --report <file>` | Deploy step after the tenant fan-out: publish `tenant.migrated` / `tenant.migration_failed` per schema (`velexis-deploy` runs it through `velexis-run ota` with the release's `cli.js` and `/var/lib/velexis/migrate-<sha>.json`) |
| `node dist/cli.js amadeus:ping --tenant <key> --env test` | Token request and one cheap read for a tenant's connection (support) |
| `stripe listen --forward-to localhost:4000/webhooks/stripe/velexis/test` | Forward test payment events |

## 6. Running locally

1. Follow [`docs/mvp/local-development.md`](../../docs/mvp/local-development.md) §2 (PostgreSQL, Redis, keys, `pnpm db:migrate`, reference data).
2. Create `ota/backend/.env.local` from [`.env.example`](.env.example) (role `velexis_ota_app`, `ota-jwt-ed25519.pem`).
3. Start Mailpit and `pnpm stub:amadeus`; run the platform backend's and then this backend's `dev:seed`.
4. `pnpm --filter @velexis/ota-backend dev`. The storefront dev server (`5173`) proxies `/api` to `4000` with `X-Velexis-Edge` and `X-Velexis-Host: demo.ota.example.com`.
5. Try it: `curl -H "X-Api-Key: pk_test_…" http://localhost:4000/v1/storefront`.

## 7. Amadeus stub for development and CI

[`tools/amadeus-stub`](../../tools/) (`@velexis/amadeus-stub`, task X-026, [ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md)) is a Node `http` server on port 4900:

- implements `POST /v1/security/oauth2/token` and the 12 operations from recorded, scrubbed fixtures under `tools/amadeus-stub/fixtures/`;
- validates every request against `docs/amadeus-api/*.json` and answers `400` on a malformed request, so client bugs fail loudly;
- scenarios with `X-Stub-Scenario`: `sold-out`, `price-changed`, `ticketing-failed`, `version-conflict`, `server-error`, `timeout`; the client forwards the header only when `APP_ENV` is not `production`. End-to-end runs use magic values (destination `ZZZ` returns no offers);
- remembers created orders in memory so Flight Order Management, by-reference GET and Queue List return them (needed for reconciliation tests);
- is started in-process by integration tests through `@velexis/testing/amadeus` (random port), and as a background process in CI end-to-end jobs.

Point the backend at it with `AMADEUS_BASE_URL_TEST=http://127.0.0.1:4900`. Recording new fixtures (`pnpm --filter @velexis/amadeus-stub record <operation>`) uses the developer's own Amadeus test credentials and is never run in CI.

## 8. Tests

| Level | Where | Highlights |
|---|---|---|
| Unit | `src/**/*.test.ts` | Pricing engine tables, error mapper, cookie and CSRF guards, `SensitiveCard`, Markdown parser, redaction of every persisted payload |
| Integration | `test/integration/<module>/*.int.test.ts` | Every endpoint: success, validation, auth failure, **tenant isolation** (two tenants), main business errors; responses validated against the OpenAPI document; both edge (cookie) and key (bearer) modes for customer operations |
| Contract | `test/contract/` | Route parity with the `x-milestone` allow-list (`501`), generated types up to date, job message schemas, baseline checksum of `0001`, error catalogue |
| End to end | `tools/e2e/specs/` | Storefront search → book → pay (Stripe test card, airline card in test) → e-mail; OTA admin issue and cancel |

Test names end with the plan's task id and criterion (`… [OBE-031 AC2]`). The PAN-absence test of [`../docs/flows/checkout-airline-card.md`](../docs/flows/checkout-airline-card.md) §7 runs in every CI build.

## 9. Deploy

- Release folder `ota-backend/` with `dist/`, `migrations/tenant/`, `openapi/` and production dependencies (`pnpm deploy --prod`), per [ADR-0023](../../docs/mvp/adr/0023-release-artefact-and-deploy-user.md).
- Deploy order: platform and reference migrations → tenant fan-out (`migrate.js tenants --dir "$REL/migrations/tenant"`, then `velexis-run ota node "$REL/ota-backend/dist/cli.js" tenants:report-migrations`, both before the switch) → restart `velexis-ota-worker`, then `velexis-ota-api` → `/health/ready` checks ([`../docs/flows/tenant-provisioning-worker.md`](../docs/flows/tenant-provisioning-worker.md) §4).
- Both units run with `MemoryMax`, `LimitCORE=0` and no swap on the VM, so card data in memory never reaches disk ([ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §C).
