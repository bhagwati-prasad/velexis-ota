# Platform backend (`@velexis/platform-backend`)

This is the NestJS 11 control-plane backend of Velexis: the API that the portal and the platform admin call from their servers, the Stripe webhook receivers, Caddy's TLS `ask` endpoint, and a worker process for queues and schedules. This page is the component specification: folder tree, modules, environment variables, jobs, commands, the OpenAPI document and tests. Design and decisions are in [`../docs/`](../docs/README.md); start with [`../docs/architecture.md`](../docs/architecture.md).

Related: [`../docs/api-inventory.md`](../docs/api-inventory.md) (endpoints), [`../docs/data-model.md`](../docs/data-model.md) (schema), [`.env.example`](.env.example), [MVP tech stack](../../docs/mvp/tech-stack.md#platform-backend-platformbackend-velexisplatform-backend), [conventions](../../docs/mvp/conventions.md#2-nestjs-backends).

## 1. At a glance

| Item | Value |
|---|---|
| Runtime | Node.js 22, TypeScript 5.6 strict, CommonJS output |
| Framework | NestJS 11 (Express 5), `nestjs-pino`, `nestjs-cls`, `@nestjs/bullmq`, `@nestjs/throttler` |
| Data | PostgreSQL 16 schemas `platform` and `reference` through `@velexis/db` (Kysely), role `velexis_platform_app` |
| Processes | API `dist/main.js` on `127.0.0.1:3100`; worker `dist/worker.js` with health on `127.0.0.1:3101`; CLI `dist/cli.js` |
| Public host | `https://api.platform.example.com` (Caddy); `/internal/*` blocked publicly |
| Contract | `openapi/velexis-platform-api.openapi.yaml` (created in M1 from the [API inventory](../docs/api-inventory.md)) |
| systemd units | `velexis-platform-api.service`, `velexis-platform-worker.service` ([ADR-0007](../../docs/mvp/adr/0007-single-vm-without-docker.md)) |

## 2. Folder tree

```
platform/backend/
├── package.json                    @velexis/platform-backend
├── nest-cli.json, tsconfig.json, tsconfig.build.json
├── vitest.config.ts, vitest.int.config.ts       unit and integration tests, compiled by tsc (decorator metadata)
├── .env.example
├── openapi/                                    shipped with dist/ (package.json `files`): the API validates requests with it
│   ├── README.md                               slices, conventions, x- extensions, how to change it (PBE-005)
│   └── velexis-platform-api.openapi.yaml       source of truth for every endpoint (ADR-0006)
├── migrations/
│   ├── README.md                               naming, headers, expand/contract, how to run (X-012)
│   ├── platform/
│   │   ├── 0001_baseline.sql                   byte copy of docs/velexis-sdk/db/platform.sql
│   │   ├── 0002_add_mvp_platform_deltas.sql    ../docs/data-model-migration-0002*.md
│   │   └── R__ota_read_access.sql              repeatable: SELECT grants of velexis_ota_app (ADR-0021)
│   └── reference/
│       └── 0001_baseline.sql                   byte copy of docs/velexis-sdk/db/reference.sql
├── src/
│   ├── main.ts                     HTTP entry (helmet, cookie-parser, trust proxy loopback, Nest's body parser off)
│   ├── worker.ts                   BullMQ processors and schedulers, health server on HEALTH_PORT
│   ├── cli.ts                      admin:grant, admin:reset-mfa, dev:seed
│   ├── app.module.ts, worker.module.ts
│   ├── config.ts                   @velexis/config schema of every variable below
│   ├── common/
│   │   ├── auth/                   portal-auth, admin-auth, internal-only, tenant-role, recent-mfa, feature guards + decorators
│   │   ├── http/                   request context, end-user IP (PADR-0019), JSON body parser with the raw body on
│   │   │                           /webhooks/*, @OpenApiOperation, OpenAPI validation interceptor, error filter,
│   │   │                           idempotency interceptor (PBE-009)
│   │   ├── stripe/                 Stripe client factory (pinned apiVersion), signature guard, stripe_events inbox
│   │   ├── credentials/            credential_submissions repository
│   │   ├── redis/                  ioredis client, vx:invalidate publisher, Redis key helpers
│   │   ├── queues/                 queue names, producers, @velexis/api-types/jobs validation
│   │   ├── clock.ts, ids.ts        injectable Clock and prefixed-ULID generator (`IdGenerator.new("ten")`)
│   │   └── common.module.ts        CommonModule.forApi() and API_REQUEST_MIDDLEWARE (the middleware order)
│   ├── audit/                      AuditService.record(tx, …), audit-actions.ts (union of action names), queries, CSV
│   ├── notifications/              outbox service, email.processor.ts, mailer.gateway.ts, templates/<key>.{subject,html,txt}.hbs
│   ├── auth/                       sign-up, verification, sign-in, MFA challenge, refresh, sign-out, reset, step-up, token signing
│   ├── accounts/                   /v1/me, profile, password, MFA set-up, recovery codes, sessions
│   ├── tenants/                    tenants repository, key rules and reserved list, profile, key availability
│   ├── memberships/                members, invitations, console token, tenant-roles.ts (role matrix)
│   ├── api-keys/                   generator, CRUD, roll, revoke, usage-flush.processor.ts
│   ├── domains/                    domains CRUD, hostname rules, dns.gateway.ts, domain-checks.processor.ts, tls-probe, tls-ask.controller.ts
│   ├── supplier-connections/       Amadeus accounts, office pool, tenant connections, amadeus-oauth.gateway.ts, verification processor
│   ├── payment-connections/        velexis rows, Connect OAuth, API-key mode, connect-accounts webhook handler
│   ├── billing/                    plans, billing customers, subscriptions, invoices, stripe-billing.gateway.ts, price checks
│   │   └── sync/                   billing webhook controller, stripe-events.processor.ts, handlers/, dunning and trial schedulers
│   ├── settlements/                generator, settlements.processor.ts, payout accounts, IBAN validation, CSV
│   ├── provisioning/               lifecycle service (create OTA, go-live, suspend, resume, migrate), dispatcher,
│   │                               tenant-events.processor.ts, post-steps/, reconciler, onboarding checklist
│   ├── admin/                      admin auth controller, one controller per admin area, dashboard, queue inspector
│   └── health/
└── test/
    ├── support/app.ts              createTestApp(): the API on a test database clone and Redis, for Supertest (PBE-008)
    ├── builders/                   test data builders (accounts, tenants, plans, …)
    ├── fixtures/stripe/            signed Stripe event fixtures (Billing and Connect)
    ├── integration/<module>/*.int.test.ts
    └── contract/                   OpenAPI document and error catalogue, route parity and pending-operations.ts, jobs
                                    schemas, baseline checksums
```

There is no reference-data folder and no reference loader in this package. The vendored datasets and their loader live in `tools/reference-data` (`@velexis/reference-data`) and run through `pnpm db:seed:reference` with this backend's database role ([ADR-0024](../../docs/mvp/adr/0024-reference-data-sources-and-loader.md)). The backend owns the `reference` migrations and only reads the tables.

Each module follows [`conventions.md` §2](../../docs/mvp/conventions.md#layout-one-module-per-bounded-context): thin controllers bound to an `operationId`, services owning transactions, Kysely repositories, gateways for external calls, processors for jobs. The module list, layers and responsibilities are in [`../docs/architecture.md`](../docs/architecture.md) §2.

## 3. Environment variables

Loaded and validated by `src/config.ts` (`@velexis/config`); the process refuses to start on a missing or invalid value. On the VM both processes read `/etc/velexis/platform-backend.env` (template [`deploy/env/platform-backend.env.example`](../../deploy/env/platform-backend.env.example)); the worker also reads the optional overlay `/etc/velexis/platform-worker.env`, which only overrides values for the worker. Locally they come from `.env.local` based on [`.env.example`](.env.example). "New" marks variables this document adds to the [configuration matrix](../../docs/mvp/architecture.md#6-configuration-matrix); the task that first reads one adds it to the matrix, the root `.env.example` and `deploy/env/` ([`conventions.md` §8](../../docs/mvp/conventions.md#8-configuration)).

| Variable | Required | Example (placeholder) | Purpose | Since |
|---|---|---|---|---|
| `APP_ENV` | yes | `development` \| `test` \| `production` | Environment name | M0 |
| `LOG_LEVEL` | no (`info`) | `info` | pino level | M0 |
| `PORT` | no (`3100`) | `3100` | API port (127.0.0.1); the unit sets it | M0 |
| `HEALTH_PORT` | no (`3101`) | `3101` | Worker health port (127.0.0.1); the unit sets it | M0 |
| `TRUST_PROXY` | no (`loopback`) | `loopback` | Express trust proxy, so client IPs come from Caddy: a comma-separated list of `loopback`, `linklocal`, `uniquelocal` and IP addresses or subnets, never `true` or a hop count (new) | M0 (read), M1 (env files) |
| `DATABASE_URL` | yes | `postgres://velexis_platform_app:…@127.0.0.1:5432/velexis` | App role | M0 |
| `DATABASE_MIGRATOR_URL` | migrations only | `postgres://velexis_migrator:…@127.0.0.1:5432/velexis` | `pnpm db:migrate` and deploy | M0 |
| `REDIS_URL` | yes | `redis://:…@127.0.0.1:6379/0` | BullMQ, caches, tokens | M0 |
| `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT` | yes | `/etc/velexis/keys/platform`, `local:v1` | Envelope encryption KEK ([ADR-0010](../../docs/mvp/adr/0010-secrets-envelope-encryption.md)); the platform zone's key folder ([ADR-0026](../../docs/mvp/adr/0026-system-users-per-trust-zone.md)) | M1 |
| `API_KEY_PEPPER_FILE` | yes | `/etc/velexis/keys/platform/api-key-pepper` | HMAC pepper for API keys (an identical copy of the OTA backend's) | M1 |
| `JWT_PRIVATE_KEY_FILE` | yes | `/etc/velexis/keys/platform/platform-jwt-ed25519.pem` | Portal and admin token signing; `kid` = JWK thumbprint | M1 |
| `SMTP_URL`, `MAIL_FROM` | yes | `smtp://127.0.0.1:1025`, `"Velexis" <no-reply@mail.platform.example.com>` | Platform e-mails | M1 |
| `OPS_ALERT_EMAIL` | yes | `ops@example.com` | Recipient of `ops.alert` e-mails (new) | M1 |
| `PUBLIC_PORTAL_URL` | yes | `https://platform.example.com` | Links in e-mails, Checkout and Connect redirects | M1 |
| `PUBLIC_PLATFORM_ADMIN_URL` | yes | `https://admin.platform.example.com` | Links in ops e-mails | M1 |
| `PUBLIC_OTA_ADMIN_URL` | yes | `https://admin.ota.example.com` | SSO hand-off target returned with console tokens | M4 |
| `STOREFRONT_BASE_DOMAIN` | yes | `ota.example.com` | `<key>.<base>` sub-domains, `ask` rule | M1 |
| `STOREFRONT_IPV4`, `STOREFRONT_IPV6` | M5 | `203.0.113.10`, `2001:db8::10` | Apex records shown to owners and checked by DNS verification (new) | M5 |
| `DNS_RESOLVERS` | M5 | `1.1.1.1,8.8.8.8` | Resolvers for domain verification (new) | M5 |
| `AMADEUS_BASE_URL_TEST`, `AMADEUS_BASE_URL_LIVE` | no | `https://test.travel.api.amadeus.com`, `https://travel.api.amadeus.com` | Hosts used to verify OTA-owned credentials; the stub `http://127.0.0.1:4900` in development (same names as the OTA backend) | M5 |
| `STRIPE_SECRET_KEY` | M5 | `sk_test_dummy` | Velexis account: Billing, Connect token exchange, balance transactions | M5 |
| `STRIPE_BILLING_WEBHOOK_SECRET` | M5 | `whsec_dummy_billing` | `/webhooks/stripe/billing` | M5 |
| `STRIPE_CONNECT_CLIENT_ID` | M5 | `ca_dummy` | Connect Standard OAuth | M5 |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | M5 | `whsec_dummy_connect` | `/webhooks/stripe/connect-accounts` (new) | M5 |
| `PLATFORM_BFF_KEY` | yes | (generated, 32+ random bytes) | Shared first-party key of the portal and admin servers. Only a loopback request that carries it in `X-Velexis-Bff-Key` may forward the end user's IP and user agent ([PADR-0019](../docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)) (new) | M1 |
| `MAX_TENANTS_PER_ACCOUNT` | no (`3`) | `3` | Non-failed OTAs one account may own (new) | M1 |
| `FEATURE_STRIPE_BILLING`, `FEATURE_OWN_STRIPE`, `FEATURE_SETTLEMENTS`, `FEATURE_OWN_AMADEUS`, `FEATURE_CUSTOM_DOMAINS`, `FEATURE_LIVE_SWITCH` | no (`false`) | `false` | Milestone switches ([PADR-0015](../docs/adr/0015-milestone-feature-switches.md)) (new) | M1 |
| `STORAGE_DRIVER`, `STORAGE_DIR` | no | `local`, `/var/lib/velexis/storage` | Listed for the platform in the configuration matrix; not read by the MVP code (CSV exports are streamed) | — |
| `SENTRY_DSN` | no | (empty) | Error tracking, off when empty | M6 |

Never in environment variables: the shared Amadeus credentials (encrypted in `platform.amadeus_accounts`), OTA credentials, MFA secrets.

## 4. Queues, jobs and schedules

Full table in [`../docs/architecture.md`](../docs/architecture.md) §5. Summary:

| Queue | Role of this backend | Processor (folder) |
|---|---|---|
| `ota-tenant-ops` | Producer (`tenant.provision`, `tenant.migrate`, `tenant.suspend`, `tenant.resume`) | — (OTA worker) |
| `platform-tenant-events` | Consumer | `provisioning/tenant-events.processor.ts` |
| `platform-emails` | Both | `notifications/email.processor.ts` |
| `platform-stripe-events` | Both | `billing/sync/stripe-events.processor.ts` (billing) and `payment-connections/` (Connect account events) |
| `platform-domains` | Both | `domains/domain-checks.processor.ts` |
| `platform-connections` | Both | `supplier-connections/verification.processor.ts`, `payment-connections/` |
| `platform-settlements` | Both | `settlements/settlements.processor.ts` |
| `platform-maintenance` | Both | schedulers: reconciler, usage flush, purges, pool level, invitations expiry, Stripe event sweep, billing jobs |

Schedulers are declared with `upsertJobScheduler` at worker start-up; schedulers of features whose switch is off are not registered.

## 5. Commands

Run from the repository root (`pnpm --filter @velexis/platform-backend <script>`), or the root shortcuts of [`AGENTS.md`](../../AGENTS.md#10-commands-cheat-sheet).

| Command | Does |
|---|---|
| `pnpm --filter @velexis/platform-backend dev` | API and worker in watch mode: one build, then `dev:tsc` (`tsc --watch` into `dist/`), `dev:api` and `dev:worker` (`node --watch` on `dist/main.js` and `dist/worker.js`) run in parallel |
| `pnpm --filter @velexis/platform-backend build` | `dist/main.js`, `dist/worker.js`, `dist/cli.js` (`tsc -b` builds the workspace packages it references first; the script fails when an entry point is missing) |
| `pnpm --filter @velexis/platform-backend test` | Unit and contract tests (Vitest) |
| `pnpm --filter @velexis/platform-backend test:int` | Integration tests (PostgreSQL 16, Redis 7, Mailpit, Amadeus stub running) |
| `pnpm db:migrate` | Apply `migrations/platform` and `migrations/reference` with `DATABASE_MIGRATOR_URL` |
| `pnpm db:codegen` | Regenerate Kysely types after a migration |
| `pnpm contracts:lint` / `pnpm contracts:generate` | Lint the OpenAPI document / regenerate `@velexis/api-types/platform` and `@velexis/errors/platform` |
| `pnpm dev:keys` | Create local key files in `.local/keys/` (master key, pepper, JWT keys) |
| `pnpm --filter @velexis/platform-backend ref:load` | Shortcut for `pnpm db:seed:reference`: loads the vendored datasets of `tools/reference-data` into `reference` (idempotent upserts, [ADR-0024](../../docs/mvp/adr/0024-reference-data-sources-and-loader.md)). The backend has no loader of its own. |
| `pnpm --filter @velexis/platform-backend dev:seed` | Development only (refused when `APP_ENV=production`): an admin account with MFA (prints its TOTP set-up URI), a Velexis test Amadeus account pointing at the stub, 10 test offices. The `early_access` plan comes from migration `0002`. |
| `node dist/cli.js help` | List the CLI commands. Exit codes: `0` done, `1` the command failed, `2` no or unknown command |
| `node dist/cli.js admin:grant <email>` | Grant platform admin (account must be verified with MFA); audited as `system` |
| `node dist/cli.js admin:reset-mfa <email>` | Emergency MFA reset of an admin; audited as `system` |
| `stripe listen --forward-to localhost:3100/webhooks/stripe/billing` | Forward test billing events |
| `stripe listen --forward-connect-to localhost:3100/webhooks/stripe/connect-accounts --events account.updated,account.application.deauthorized` | Forward test Connect account events |

## 6. Local development

1. Install Node 22, pnpm 9, PostgreSQL 16, Redis 7, Mailpit and the Stripe CLI natively; run `deploy/scripts/dev-setup.sh` (roles and database) and `pnpm install`.
2. `pnpm dev:keys`, copy `.env.example` to `.env.local`, then `pnpm db:migrate`, `pnpm db:seed:reference` (the same as `ref:load`) and `dev:seed`.
3. Start the Amadeus stub (`pnpm stub:amadeus`) and the OTA worker when working on provisioning; `pnpm --filter @velexis/platform-backend dev`.
4. Mailpit UI at `http://127.0.0.1:8025` shows every platform e-mail.

## 7. OpenAPI document

- Location: `openapi/velexis-platform-api.openapi.yaml` (OpenAPI 3.1), as [ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md) names it. The first M1 backend task (PBE-005) created it from [`../docs/api-inventory.md`](../docs/api-inventory.md) and its two companion parts, with the error catalogue, `x-scope` on every operation and `x-internal: true` on webhooks and internal endpoints. [`openapi/README.md`](openapi/README.md) explains its slices, conventions, extensions and contract test, and how to change it.
- Every endpoint change starts in the document; `pnpm contracts:generate` updates the types; controllers bind to `operationId`s with `@OpenApiOperation("signUp")`; the route parity test fails on drift.
- **Runtime validation** (PBE-008). The API reads the document from `openapi/` next to `dist/` (the package ships it) once per process. At start-up `OpenApiValidationInterceptor` compiles Ajv 2020 validators (with `ajv-formats`, strict for unknown keywords) for the path, query and header parameters and the JSON body of every bound operation; an `operationId` that the document lacks stops the start. A request that fails answers `400 VALIDATION_FAILED` with `fieldErrors[]` of `{path, code, message}`: `path` is a JSON pointer into the body (`/email`, `""` for the body itself) or `/<in>/<name>` for a parameter (`/query/limit`, `/path/tenantId`, `/header/Idempotency-Key`), `code` the failed rule, and `message` never contains the submitted value. Unknown body properties fail (request bodies are closed); undocumented query parameters are ignored. Handlers read the coerced parameters (with their defaults) through `@Validated("query")`. Responses are validated in the integration tests only.
- **Route parity** (PADR-0016 item 2). [`test/contract/route-parity.contract.test.ts`](test/contract/route-parity.contract.test.ts) walks the API's module graph and fails when a route has no `@OpenApiOperation`, binds an operation the document lacks or with another method or path, when two routes bind one operation, or when an operation is neither bound nor listed in [`test/contract/pending-operations.ts`](test/contract/pending-operations.ts), or both. Each pending entry names the plan task that implements it; that task removes the entry when it binds the route.
- Queue message contracts are not in this document: they live in `@velexis/api-types/jobs` ([`../docs/architecture.md`](../docs/architecture.md) §6.1).

## 8. Tests

| Level | What | Notes |
|---|---|---|
| Unit | Key generator, hostname rules, IBAN, settlement formula, role matrix, price check, token claims, redaction of new fields | Next to the code |
| Integration | Every endpoint: success, validation, auth failure, role failure (`404` for non-members), main business errors; response validated with Ajv against the document | Real PostgreSQL and Redis; Stripe and Amadeus through mocks or the stub; Mailpit API for e-mails |
| Contract | Route parity, generated types up to date, baseline checksum equals `docs/velexis-sdk/db/*.sql`, jobs JSON Schemas, error catalogue | CI |
| Cross-backend | Provisioning with the OTA worker; API key created here accepted by the OTA API; console token redeemed by the OTA API | `test:xb`, run in CI after the `Build` step because it starts the built OTA worker ([PADR-0017](../docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md)) |
| End-to-end | Portal and admin journeys | `tools/e2e` ([`../frontend/README.md`](../frontend/README.md), [`../admin/README.md`](../admin/README.md)) |

Integration tests that call the API start it with `createTestApp()` of [`test/support/app.ts`](test/support/app.ts) (PBE-008): the application of `main.ts` (AppModule, helmet, cookie-parser, the request pipeline), compiled with `@nestjs/testing` so providers can be replaced (`overrides: [{ provide: X, useValue: … }]`), on the file's own database clone (`createTestDatabase()`) and the worker's Redis database (`useRedis()`), listening on an ephemeral port of `127.0.0.1`. It returns `{ app, http, db, redis, clock, logs, config, bffHeaders, close }`: `http` is Supertest, `clock` the `FakeClock` that replaces `Clock`, `logs` the parsed log lines, and `bffHeaders(ip)` the three PADR-0019 headers of a portal or admin call. Test-only controllers go in `controllers` and get the same pipeline. Call it once per test file: `useRedis()` empties the worker's Redis database.

## 9. Operations

- Health: `GET /health/live`, `GET /health/ready` on both processes: the API on `127.0.0.1:3100`, the worker's small `node:http` server on `127.0.0.1:3101` (any other path there answers the `404 NOT_FOUND` error envelope). Both answers carry `Cache-Control: no-store`, and `/health/*` writes no request log line.
  - `live` answers `200 {"status":"ok"}` while the process serves requests; it checks nothing else.
  - `ready` runs `SELECT 1` on a `createPool` pool (role `velexis_platform_app`) and `PING` on Redis in parallel, each within 2 seconds, and answers `200 {"status":"ok","checks":{"postgres":"ok","redis":"ok"}}`, or `503` with `"status":"unavailable"` and `"down"` for each dependency that failed. The cause is never answered: it is logged as `health.dependency_down` (warn, with the `dependency`, the `err` and the request's `requestId`). The age of the oldest waiting job per platform queue ([`api-inventory-admin.md`](../docs/api-inventory-admin.md), `healthReady`) is not in the report yet: the queues arrive with PBE-009.
- Start-up: an invalid configuration logs one `fatal` line `config.invalid` whose `ConfigError` names every variable (never a value) and exits `1`; so does a failure to build the module graph or bind the port (`api.start_failed`, `worker.start_failed`).
- Logs: pino JSON to journald with the standard fields and the redaction list of [ADR-0016](../../docs/mvp/adr/0016-observability.md) plus the platform additions in [`../docs/architecture.md`](../docs/architecture.md) §8 (`x-velexis-bff-key` since PBE-008). Nest's own lines (start-up) go through the same logger, and every line written inside a request carries its `requestId`. `configureApiApp` flushes Nest's start-up buffer as soon as the logger is in place, so these lines are written also when `listen()` fails or a request test only runs `init()`.
- Errors: every error answer is the envelope of `@velexis/errors` with the `requestId` (also in `X-Request-Id`). `ErrorFilter` answers Nest's own HTTP exceptions (an unknown route, a guard's `401`) with the generic code of their status and never their message, and uses the platform document's message for a code both catalogues list. An unknown error answers `500 INTERNAL_ERROR` and is logged as `http.unhandled_error` (error, with `err` and its stack, never in the body); an `AppError` of 5xx is logged as `http.server_error` with its `code`.
- Request pipeline (PBE-008, [`../docs/architecture.md`](../docs/architecture.md) §3): `helmet` and `cookie-parser`, pino-http (request id and request line), the JSON body parser (100 KB; 1 MB and the raw body on `/webhooks/*`; a body that cannot be read answers `400 VALIDATION_FAILED` without quoting it), the request context (`nestjs-cls`: `requestId`, `ip`, `userAgent`, `actor`), the end user of PADR-0019 (`X-Velexis-End-User-IP` and `X-Velexis-End-User-Agent` believed only from loopback, without `X-Forwarded-For` and with `X-Velexis-Bff-Key` equal to `PLATFORM_BFF_KEY` in constant time; a believed request without a valid IP answers `400`; a key sent but not believed is logged as `request_context.bff_key_ignored` with the reason only), then guards, the validation interceptor, the handler and the error filter. Services read the IP and user agent from `RequestContext`, never `req.ip`.
- Deploy order: migrations, then restart the worker, then the API ([ADR-0007](../../docs/mvp/adr/0007-single-vm-without-docker.md)).
