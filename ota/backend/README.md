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
| Health ([ADR-0016](../../docs/mvp/adr/0016-observability.md)) | `GET /health/live` → `200 {"status":"ok"}`; `GET /health/ready` → `200` or `503` with `{"status":"ok"\|"unavailable","checks":{"postgres":…,"redis":…}}` (`ok`, `down` or `timeout` each, at most 2 s); on the API port and on the worker's health port, never cached, never logged |
| Public hosts | `https://api.ota.example.com` and `/api/*` on every storefront host (`<key>.ota.example.com`, verified custom domains); `/internal/*` and `/health/ready` blocked publicly |
| Contract | `openapi/velexis-ota-booking-api.openapi.yaml` (copied in M0 by X-006, extended per [`../docs/api-changes.md`](../docs/api-changes.md)) |
| systemd units | `velexis-ota-api.service`, `velexis-ota-worker.service` ([ADR-0007](../../docs/mvp/adr/0007-single-vm-without-docker.md)); env files `/etc/velexis/ota-backend.env` (both) and `/etc/velexis/ota-worker.env` (worker only, provisioner DSN) |

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
│   ├── README.md                                naming, headers, expand/contract, how to run (X-012)
│   └── tenant/
│       ├── 0001_baseline.sql                    byte copy of docs/velexis-sdk/db/tenant.sql
│       └── 0002_add_mvp_tenant_deltas.sql       ../docs/data-model-migration-0002.md
├── src/
│   ├── main.ts                     HTTP entry (raw body on /webhooks/*, trust proxy loopback, body limits)
│   ├── worker.ts                   BullMQ processors and schedulers, health server on HEALTH_PORT
│   ├── cli.ts                      dev:seed, tenants:report-migrations, amadeus:ping
│   ├── app.module.ts, worker.module.ts
│   ├── config.ts                   @velexis/config schemas of §3: one for the API, one for the worker
│   ├── common/
│   │   ├── auth/                   caller, tenant, scope, customer, staff, booking-token, csrf guards; decorators
│   │   ├── http/                   request context, OpenAPI validation and idempotency interceptors, error filter, cookie writer
│   │   ├── redis/                  RedisModule (command client + BullMQ connection), redis.keys.ts (every key, TTL, kind), rate-limit storage
│   │   ├── queues/                 QueuesModule (BullMQ, every queue), queue-names.ts (concurrency, ADR-0009 defaults), job-validation.ts
│   │   ├── clock.ts, ids.ts        injectable Clock and prefixed-ULID generator (newId, IdGenerator)
│   │   └── common.module.ts        global module providing Clock and IdGenerator to both processes
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
│   └── health/                     /health/live and /health/ready: HealthController (API), HealthServer (worker port)
└── test/
    ├── helpers/                    log sink, loopback ports, one-shot HTTP exchange, fake Redis, nestjs-pino test reset
    ├── builders/                   checkouts, bookings, payments, offers, staff tokens
    ├── fixtures/stripe/            signed Stripe event fixtures (X-028)
    ├── integration/<module>/*.int.test.ts
    └── contract/                   route parity (+ 501 allow-list), response conformance, jobs schemas, baseline checksum, error catalogue
```

Each module follows [`conventions.md` §2](../../docs/mvp/conventions.md#layout-one-module-per-bounded-context): thin controllers bound to an `operationId`, services owning transactions, Kysely repositories that take the transaction first, gateways for external calls, processors for jobs. Responsibilities and dependencies are in [`../docs/architecture.md`](../docs/architecture.md) §2.

## 3. Environment variables

Loaded and validated by `src/config.ts`; the process refuses to start on a missing or invalid value (one `ConfigError` line naming every bad variable, never a value, and exit code 1). The API and the worker validate separate schemas: a variable marked "API" or "worker" is read, required and present in the configuration of that process only, so the API's configuration never holds the provisioner DSN, even when it is set, and neither process has `DATABASE_MIGRATOR_URL`. On the VM they come from `/etc/velexis/ota-backend.env` and, for the worker only, `/etc/velexis/ota-worker.env` ([`deploy/env/`](../../deploy/env/)); locally from `.env.local` based on [`.env.example`](.env.example) and the root `.env.example`. "New" marks variables this document adds to the [configuration matrix](../../docs/mvp/architecture.md#6-configuration-matrix); the task that first reads one adds it there, to the root `.env.example` and to `deploy/env/` ([`conventions.md` §8](../../docs/mvp/conventions.md#8-configuration)).

| Variable | Required | Example (placeholder) | Purpose | Since |
|---|---|---|---|---|
| `APP_ENV` | yes | `development` \| `test` \| `production` | Environment name | M0 |
| `LOG_LEVEL` | no (`info`) | `info` | pino level | M0 |
| `PORT` | API | `4000` | API port (127.0.0.1) | M0 |
| `HEALTH_PORT` | worker | `4001` | Worker health port | M0 |
| `TRUST_PROXY` | API, no (`loopback`) | `loopback` | Express `trust proxy`: client IPs from Caddy. Presets (`loopback`, `linklocal`, `uniquelocal`), addresses or CIDR ranges; `true`, `*` and hop counts are refused (new) | M0 |
| `DATABASE_URL` | yes | `postgres://velexis_ota_app:…@127.0.0.1:5432/velexis` | App role | M0 |
| `DATABASE_PROVISIONER_URL` | worker | `postgres://velexis_provisioner:…@127.0.0.1:5432/velexis` | Tenant provisioning as `velexis_provisioner` (tenant schemas only, [ADR-0004](../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md)); `/etc/velexis/ota-worker.env`, which the API unit cannot read. `DATABASE_MIGRATOR_URL` (`velexis_migrator`) is for deploys and the local migration commands only, never for this app | M0 |
| `REDIS_URL` | yes | `redis://:…@127.0.0.1:6379/0` | Caches, tokens, rate limits, queues | M0 |
| `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT` | yes | `/etc/velexis/keys/ota`, `local:v1` | Envelope encryption ([ADR-0010](../../docs/mvp/adr/0010-secrets-envelope-encryption.md)); the OTA zone's key folder ([ADR-0026](../../docs/mvp/adr/0026-system-users-per-trust-zone.md)) | M2 |
| `API_KEY_PEPPER_FILE` | yes | `/etc/velexis/keys/ota/api-key-pepper` | HMAC pepper of API keys (an identical copy of the platform's) | M2 |
| `JWT_PRIVATE_KEY_FILE` | yes | `/etc/velexis/keys/ota/ota-jwt-ed25519.pem` | Customer and staff token signing | M3 |
| `DOCUMENT_URL_KEY_FILE` | yes | `/etc/velexis/keys/ota/document-url.key` | Signed download URLs | M3 |
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
| `TEST_DATABASE_ADMIN_URL` | tests | see root `.env.example` | Integration test harness: the `@velexis/testing` template database that `pnpm test:int` builds once per run | M1 |
| `MAILPIT_API_URL` | tests | see root `.env.example` | Integration test harness | M2 |

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

How the code uses them (OBE-002, `src/common/`):

- **`RedisModule`** (global, built once per process by whichever module imports it) holds two connections on `REDIS_URL`: `REDIS_CLIENT` for caches, locks, counters and hand-offs, which fails fast while Redis is down (one retry per command) so callers can degrade as [architecture §10](../docs/architecture.md#10-failure-behaviour) says, and `REDIS_BULLMQ_CONNECTION`, the BullMQ connection with `maxRetriesPerRequest: null`, which waits for Redis instead. Both connect on first use, log the first error of an outage once (`redis.connection_error`, never the URL), and quit after every queue and worker has closed. A connection with an attempt in flight is closed once that attempt has ended (`closeRedisConnection`): closing it during the attempt would make BullMQ 5 reject the set-ups still waiting on the shared connection after the queues have removed their listeners, unhandled rejections that stop the process. Because the BullMQ connection waits for Redis, a producer on a request path does not await `queue.add` while Redis is down (the outbox and the sweeps catch up).
- **`redis.keys.ts`** is the only place that writes a key: `redisKeys.<builder>(…)` returns `{ key, ttlSeconds, kind }` for every key of [architecture §7](../docs/architecture.md#7-redis-keys), and every write sets that TTL (Redis runs with `noeviction`). `tenant` keys (tenant data) always start with `t:<tenantId>:<env>:`; `shared` keys are those of the cross-cutting tables; `credential` keys belong to an Amadeus credential set. The builders validate every part (ids, environments, host names, SHA-256 hashes) and never echo it in an error. A key reaches the client only as a `RedisKeyName` from a builder, in a form the source scan of `redis.keys.test.ts` can read: no cast to `RedisKeyName`, a literal command name for `call`, literal command arrays for `multi([…])`, and a literal key count for `eval`.
- **`QueuesModule`** (static, imported by every module that produces or consumes jobs; no other module registers BullMQ queues) configures BullMQ once (the BullMQ connection, prefix `vx`, the job defaults of [ADR-0009](../../docs/mvp/adr/0009-background-jobs-bullmq.md): 5 attempts, exponential backoff from 30 s, failed jobs kept 30 days and completed jobs 1 day) and opens every queue of the table above (the eight the worker consumes and `platform-tenant-events`, which it produces), injectable with `@InjectQueue(<queue name>)` (`OTA_QUEUE.<topic>` for the consumed ones). A worker module declares `@Processor(OTA_QUEUE.tenantOps, otaWorkerOptions(OTA_QUEUE.tenantOps))` (the queue's concurrency of architecture §6 and the same retention) and attaches its own `error` listener to its worker. Before shutdown, its `BullmqStartupSettler` waits up to 1 s for queues and workers that are still connecting (`settleBullmqStartup`): BullMQ 5 would otherwise report a set-up interrupted by the close as an unhandled rejection, which stops the process (OBE-005).
- **`job-validation.ts`**: a processor of a cross-backend queue starts with `validateTenantOpsJob(job, logger)` (or `validateQueuedJob(job, names, logger)`). A message that is not one of the queue's names or does not match its `@velexis/api-types/jobs` schema is logged as `queue.job_invalid` (queue, job id, name, failing paths and rules; never the payload) and thrown as BullMQ's `UnrecoverableError`, so it fails at once without the remaining attempts.

The worker's modules (`worker.module.ts`): `RedisModule`, `QueuesModule`, `TenancyModule.forWorker()` and `ProvisioningModule`, which the API never imports. Provisioning (OBE-005, OBE-006, `src/provisioning/`, [flow](../docs/flows/tenant-provisioning-worker.md), [OADR-0007](../docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md)):

- **`tenant-ops.processor.ts`** consumes `ota-tenant-ops` (concurrency 2), validates each job and dispatches on its name. `tenant.provision` runs `ProvisioningService.provisionTenant` and `tenant.migrate` runs `migrateTenant(tenantId, targetVersion)`; after the transaction it publishes `tenant.provisioned` / `tenant.migrated` or the failure event. A non-retryable failure is published at once and the job fails as unrecoverable. A retryable one is thrown back to BullMQ while the job has tries left (the platform dispatches with `attempts: 3`; `tenant_ops.retrying`), and only its last try publishes `tenant.provision_failed` / `tenant.migration_failed` with `retryable: true` (the platform then re-dispatches with backoff). `tenant.suspend` and `tenant.resume` are not handled yet (M4–M5) and fail as unrecoverable. Log lines carry the error code, never the error. Worker errors are logged once per outage (`queue.worker_error`).
- **`failure-classifier.ts`** (OBE-006, [OADR-0007](../docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md) item 6, [flow §5](../docs/flows/tenant-provisioning-worker.md#5-failure-handling)) turns what a run threw into the event's `error {code, message}`, `retryable` and the migration at fault (`version`). Retryable: `LOCK_TIMEOUT` (55P03), `SERIALIZATION_FAILURE` (40001), `DEADLOCK` (40P01), `CONNECTION_LOST` (class 08, 57P01–57P03, 53300, `ECONNREFUSED`/`ECONNRESET`/…, `pg`'s connection messages), also inside a failing migration file, and any error it does not know (by its SQLSTATE, or `UNEXPECTED_ERROR`). Not retryable: `CHECKSUM_MISMATCH` (an applied file was edited), `FOREIGN_CONTENT`, `FOREIGN_OWNER`, `SCHEMA_MISSING`, `INVALID_SCHEMA_NAME`, `MIGRATION_FAILED` (a file that fails for another reason fails the same way on every try), `INVALID_MIGRATION_FILES` (an invalid or missing tenant migrations folder) and `UNEXPECTED_PLATFORM_VALUE`, besides the service's own `TENANT_NOT_FOUND`, `TENANT_NOT_PROVISIONING`, `TENANT_NOT_MIGRATABLE` and `UNKNOWN_TARGET_VERSION`. Messages are written there, capped at the 1,000 characters of the event schemas (`jobError`, which the service's own failures use too): never PostgreSQL's text, the SQL, its parameters or a value of the tenant row.
- **`provisioning.service.ts`**: `provisionTenant(tenantId)` re-reads `platform.tenants`. A `provisioning` tenant gets **one transaction** as `velexis_provisioner`: `migrateTenantSchema({ create: true })` of `@velexis/db` (schema under the advisory lock of its name, `lock_timeout` 5 s, grants and default privileges for `velexis_ota_app`, every file of `migrations/tenant` and its ledger row) and, in its `beforeCommit`, the seeds of `provisioning/seeds/` and the ledger read; a crash before `COMMIT` leaves no schema. Another status answers `tenant.provisioned` again when the schema is complete at the latest version (checked read-only through `tenantTx`), otherwise `TENANT_NOT_PROVISIONING`; an unknown tenant is `TENANT_NOT_FOUND`, a schema provisioning did not create `FOREIGN_CONTENT` or `FOREIGN_OWNER` (never dropped). `migrateTenant(tenantId, targetVersion?)` (OBE-006) runs the same transaction without creating the schema or seeding (`migrateTenantSchemaFiles`), for a `provisioning`, `active` or `suspended` tenant (otherwise `TENANT_NOT_MIGRATABLE`), applying the pending files up to `targetVersion` (`0002_add_x` or `0002`; all of them without one, `UNKNOWN_TARGET_VERSION` for a version the release does not have); its `beforeCommit` refuses an edited applied file of the release, also one after the target, and reads the full ledger for `tenant.migrated {schemaVersion, migrations[]}`. Neither method throws: failures come back classified, with the error that caused them for BullMQ. The provisioner database (`DATABASE_PROVISIONER_URL`, a pool of 2 named `ota-worker-provisioner` for the read-only check) can only be built from the worker's configuration: the API's has no provisioner DSN, so it refuses with `ProvisionerDsnMissingError`.
- **`tenant-events.producer.ts`** validates each event with `validateJob` and adds it to `platform-tenant-events` with the BullMQ id of the attempt it answers (`<jobId>-<attempt>`, the platform ignores older attempts), the message's `jobId`, `tenantId` and `requestId`, and `steps[]` (`create_schema`, `run_migrations`, `seed_defaults`: `succeeded`, or `skipped` when there was nothing to do).

## 5. Commands

Run from the repository root (`pnpm --filter @velexis/ota-backend <script>`) or with the root shortcuts of [`AGENTS.md`](../../AGENTS.md#10-commands-cheat-sheet).

The build is plain `tsc` (one TypeScript version for the whole repository, [tech stack](../../docs/mvp/tech-stack.md) §1); the Nest CLI is not a dependency. `nest-cli.json` describes the layout (`src/`, entry `main`, `tsconfig.build.json`) for anyone who runs it with `pnpm dlx @nestjs/cli@11`.

| Command | Does |
|---|---|
| `pnpm --filter @velexis/ota-backend dev` | API and worker in watch mode: one build, then `dev:tsc` (`tsc --watch` into `dist/`), `dev:api` and `dev:worker` (`node --watch` on `dist/main.js` and `dist/worker.js`) in parallel |
| `pnpm --filter @velexis/ota-backend build` | `dist/main.js`, `dist/worker.js`, `dist/cli.js` (`tsc -p tsconfig.build.json`, CommonJS with source maps; the script fails if an entry point is missing) |
| `pnpm --filter @velexis/ota-backend test` | Unit and contract tests (Vitest) |
| `pnpm --filter @velexis/ota-backend test:int` | Integration tests (PostgreSQL 16, Redis 7, Mailpit; the Amadeus stub starts in-process) |
| `pnpm --filter @velexis/ota-backend typecheck` / `lint` / `clean` | `tsc --noEmit` over `src/` and `test/` / ESLint / remove `dist/` and `coverage/` |
| `node dist/cli.js help` | List the CLI commands (`--help`, `-h`); no command or an unknown one exits 1 |
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
| Unit | `src/**/*.test.ts` | Pricing engine tables, error mapper, cookie and CSRF guards, `SensitiveCard`, Markdown parser, redaction of every persisted payload; the Redis key builders (TTL and tenant prefix of every builder) and the source scan that fails on a key written by hand outside `redis.keys.ts`, a cast to `RedisKeyName`, or a Redis call whose keys it cannot read (`src/common/redis/redis.keys.test.ts`) |
| Integration | `test/integration/<module>/*.int.test.ts` | Every endpoint: success, validation, auth failure, **tenant isolation** (two tenants), main business errors; responses validated against the OpenAPI document; both edge (cookie) and key (bearer) modes for customer operations |
| Contract | `test/contract/` | Route parity with the `x-milestone` allow-list (`501`), generated types up to date, job message schemas, baseline checksum of `0001`, tenant migration `0002` byte for byte against [`data-model-migration-0002.md`](../docs/data-model-migration-0002.md) with the tenant-migration rules and its generated types (`migration-0002.contract.test.ts`), error catalogue |
| End to end | `tools/e2e/specs/` | Storefront search → book → pay (Stripe test card, airline card in test) → e-mail; OTA admin issue and cancel |

Test names end with the plan's task id and criterion (`… [OBE-031 AC2]`). The PAN-absence test of [`../docs/flows/checkout-airline-card.md`](../docs/flows/checkout-airline-card.md) §7 runs in every CI build.

How the suites run (`vitest.config.ts`, `vitest.int.config.ts`):

- **Contract tests run with the unit tests.** `vitest.config.ts` includes `test/contract/**/*.test.ts` next to `src/**/*.test.ts`, so `pnpm --filter @velexis/ota-backend test` runs both (`test -- contract` narrows it); none of them needs a service.
- **Decorator metadata.** NestJS injects constructor dependencies by their TypeScript types, which esbuild (Vite's default transform) does not emit. Both Vitest configurations compile the package's TypeScript with the TypeScript compiler and the options of `tsconfig.json` instead, so tests run the same decorator output as the `tsc` build.
- **In-process apps.** Tests start the API and the worker with `startApi({ env, logDestination })` and `startWorker({ env, logDestination })` from `src/main.ts` and `src/worker.ts`, or build a test root module around `AppModule.forRoot(config, { logger })` (Supertest). `test/helpers/log-sink.ts` captures the log lines so tests can assert that a request line carries `requestId` and that no body, token or password is logged. `createApiApp` flushes Nest's start-up log buffer as soon as the pino logger is in place, so Nest's own lines (the exception handler's error lines included) reach the sink after `init()` too, not only after `listen()`.
- **Integration environment.** `test/integration/env.ts` reads `DATABASE_URL`, `REDIS_URL` and `DATABASE_PROVISIONER_URL` through `@velexis/config` (the CI job environment, or the root and app `.env.local` files). The `@velexis/testing` global setup of `vitest.int.config.ts` builds the run's template database as `TEST_DATABASE_ADMIN_URL` (platform and reference migrated, `tenant_alpha` and `tenant_beta` provisioned); a file that needs tenant schemas clones it with `createTestDatabase()` and drops the clone in `afterAll` (`test/integration/provisioning/seeds.int.test.ts`). A file that needs Redis takes an emptied database of its own with `useRedis()` and passes its URL to the module under test (`test/integration/common/queues.int.test.ts` runs a real `ota-tenant-ops` queue and worker there; `test/integration/provisioning/provision.int.test.ts` runs the whole worker graph on both, adds `tenant.provision` messages as the platform does and reads the events back from `platform-tenant-events`; `migrate.int.test.ts` does the same for `tenant.migrate` and the failure classes, a forced lock timeout included, and points the worker at a tenant migrations folder of its own by mocking the default of `provisioning.service.ts`). The health suite binds the units' ports `127.0.0.1:4000` and `127.0.0.1:4001`, so integration files run one after the other.
- **Outages.** The shared PostgreSQL and Redis are never stopped by a test. A dependency that is down is a free loopback port where nothing listens (`test/helpers/ports.ts`); a Redis that comes back is `test/helpers/fake-redis.ts`, a minimal RESP server started on that port.
- **nestjs-pino outside requests.** Every `PinoLogger` of a process writes to the first application's logger outside a request. One process runs one application on the VM; a test that starts several and asserts out-of-request lines calls `useNextApplicationLoggerOutsideRequests()` (`test/helpers/nest-pino.ts`) before starting the one it watches.

## 9. Deploy

- Release folder `ota-backend/` with `dist/`, `migrations/tenant/`, `openapi/` and production dependencies (`pnpm deploy --prod`), per [ADR-0023](../../docs/mvp/adr/0023-release-artefact-and-deploy-user.md).
- Deploy order: platform and reference migrations → tenant fan-out (`migrate.js tenants --dir "$REL/migrations/tenant"`, then `velexis-run ota node "$REL/ota-backend/dist/cli.js" tenants:report-migrations`, both before the switch) → restart `velexis-ota-worker`, then `velexis-ota-api` → `/health/ready` checks ([`../docs/flows/tenant-provisioning-worker.md`](../docs/flows/tenant-provisioning-worker.md) §4).
- Both units run with `MemoryMax`, `LimitCORE=0` and no swap on the VM, so card data in memory never reaches disk ([ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §C).
