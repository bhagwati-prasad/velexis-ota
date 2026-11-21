---
id: architecture
title: Shared packages and tools — architecture guide
summary: How packages/* and tools/* are built — public APIs, the tenantTx and migration machinery, envelope encryption, the generated error catalogue and contract types, the template-database test harness, the Amadeus stub, the Playwright stack, the reference loader and CI's checks — with their data, flows, lifecycles and a map of where to change things.
---

## At a glance

Rules for every package (`repo:packages/README.md`): name `@velexis/<folder>`, `"private": true`, built with
`tsc -b` to `dist/` (CommonJS + `.d.ts`), exact dependency versions, never depends on an app, never reads
`process.env` (only `@velexis/config` does), never logs with `console`. Apps import the **built** packages, so run
`pnpm build` after changing one.

### Half A — packages

| Package | Entry points (`exports`) | Key source | Build / test |
|---|---|---|---|
| `@velexis/config` | `.` | `repo:packages/config/src/define-config.ts`, `env.ts`, `key-files.ts`, `dev-env-files.ts` | `pnpm --filter @velexis/config build` / `test` |
| `@velexis/logger` | `.` | `repo:packages/logger/src/create-logger.ts`, `http.ts`, `redact-paths.ts`, `redact-payload.ts`, `mask.ts`, `card-number.ts` | `… @velexis/logger test` |
| `@velexis/crypto` | `.` | `repo:packages/crypto/src/envelope.ts`, `local-file-key-provider.ts`, `rewrap-batch.ts`, `signed-url.ts`, `ids.ts` | `… @velexis/crypto test` |
| `@velexis/db` | `.`, `./migrate`, `./storage` | `repo:packages/db/src/tenant-db.ts`, `pool.ts`, `migrate/`, `cli/migrate.ts`, `storage/` | `test`, `test:int`, `migrate`, `migrate:tenants`, `codegen` |
| `@velexis/errors` | `.` | `repo:packages/errors/src/app-error.ts`, `envelope.ts`, `generated/catalogue.ts` | `generate`, `test` |
| `@velexis/api-types` | `.`, `./platform`, `./operations`, `./jobs`, `./fixtures/jobs/*.json` | `repo:packages/api-types/scripts/generate.mjs`, `src/jobs/` | `generate`, `contracts:lint`, `test` |
| `@velexis/testing` | `.`, `./vitest-global-setup`, `./mailpit`, `./amadeus`, `./stripe` | `repo:packages/testing/src/test-database.ts`, `vitest-global-setup.ts` | `test`, `test:int` |

Dependency direction: `db → config, logger`; `errors → api-types` (types only); `testing → db, config, api-types`
(+ `amadeus-stub` as devDependency). Apps depend on packages; packages never depend on apps
([[check-package-json]] enforces it).

### Half B — tools

| Tool | Kind | Entry point | Commands |
|---|---|---|---|
| `@velexis/amadeus-stub` | workspace package, Node `http` server | `repo:tools/amadeus-stub/src/cli.ts` (`dist/cli.js`), `createStubServer` | `pnpm stub:amadeus` (port 4900), `record`, `test` |
| `@velexis/e2e` | workspace package, Playwright 1.65.1 | `repo:tools/e2e/playwright.config.ts`, `repo:tools/e2e/support/stack.ts` | `pnpm test:e2e -- …`, `pnpm --filter @velexis/e2e test` |
| `@velexis/reference-data` | workspace package + plain scripts | `repo:tools/reference-data/src/cli/load.ts`, `repo:tools/reference-data/scripts/fetch.mjs` | `pnpm db:seed:reference`, `check`, `fetch`, `validate`, `test:int` |
| `tools/ci` | plain Node, no package.json | `repo:tools/ci/check-package-json.mjs`, `repo:tools/ci/check-no-hardcoded-hosts.mjs`, `repo:tools/ci/check-pci-refs.mjs`, `repo:tools/ci/fix-pci-refs.mjs` | `node --test tools/ci/*.test.mjs` |
| `tools/plan-lint` | plain Node | `repo:tools/plan-lint/plan-lint.mjs` | `pnpm plan:lint`, `--remaining`, `--graph` |
| `tools/perf` | plain Node | `repo:tools/perf/platform-smoke.mjs`, `repo:tools/perf/gc-observer.cjs`, `repo:tools/perf/unit-node-options.mjs` | `node --test tools/perf/*.test.mjs` |
| `tools/dev` | plain Node / Bash | `repo:tools/dev/dev-keys.mjs`, `repo:tools/dev/stripe-listen.sh` | `pnpm dev:keys` |

## Components

```diagram
components-packages
```

- **config** reads `process.env` once and returns a deep-frozen typed object; builders `env.string/int/port/bool/url/
  enum/dir/secretFile/list`; an empty value counts as unset. Relative `env.dir`/`env.secretFile` paths resolve against
  the workspace root.
- **logger** builds the one pino logger per process, the `pino-http` options (request id, one line per request),
  the single list [[redact-paths]] and the deep-copy [[redact-payload]] used before writing payload copies to the
  database.
- **crypto** implements [[envelope-encryption]] behind the `KeyProvider` seam ([[kek]] files today, a KMS later),
  [[associated-data]], [[kek-rotation]] (`rewrapBatch`), tokens and hashes ([[api-key-pepper]] HMAC), [[signed-url]]s
  and ULID ids (`newId`, never monotonic, because some ids grant guest access).
- **db** gives pools with its own [[type-parsers]], [[platform-db]] (qualified names), [[tenant-tx]] with the
  [[search-path-leak-guard]], the [[migration-runner]] (ledger, repeatable grants, tenant schema runner with
  [[before-commit-hook]], fan-out), the [[storage-adapter]] and the [[table-types-codegen]] output.
- **errors** holds the generated [[error-catalogue]], [[app-error]] (only catalogue codes compile) and
  `toErrorEnvelope` ([[error-envelope]], [[field-errors]]).
- **api-types** holds the generated OpenAPI types, the [[operations-index]] used by route-parity and SDK-parity
  tests and the OTA scope guard, and the hand-written [[job-envelope]] contracts with Ajv validators.
- **testing** is dev-only: [[test-template-database]], [[test-roles]], [[use-redis]], [[fake-clock]], builders,
  [[expect-response-to-match]], [[mailpit]], the in-process [[amadeus-stub]] and [[signed-stripe-event]].

```diagram
components-tools
```

- **amadeus-stub**: route table of 12 operations + OAuth, request validation against `docs/amadeus-api/`,
  [[stub-scenario]]s, in-memory [[stub-orders]], [[fixture-recording]] with scrubbing and a personal-data scan.
- **e2e**: [[e2e-stack]] global setup, [[playwright-project]]s, fixtures that arrange data through the platform API
  (`support/fixtures.ts`) or `support/seed.ts`, [[storefront-guards]] and card-leak guards, 44 spec files.
- **reference-data**: [[reference-data-snapshot]] (7 CSVs, `SOURCES.md`, [[overrides-csv]]), offline validation,
  and the [[reference-loader]].
- **ci / plan-lint / perf / dev**: [[check-package-json]], [[check-no-hardcoded-hosts]], [[pci-refs-checker]],
  workflow tests; [[plan-lint]]; [[platform-smoke]]; [[dev-keys]].

## Data

These packages own **no business tables**. They own the machinery around them: the migration ledgers, the
reference schema's contents, the ciphertext format, and scratch databases for tests.

```diagram
er-migration-ledgers
```

- **Tenancy.** One [[tenant-schema]] per OTA (`tenant_<key>`, ADR-0004). The schema name must match
  `^tenant_[a-z][a-z0-9_]{1,39}$` and comes from `platform.tenants.schema_name` of the resolved tenant, never from user
  input. Tenant data is reachable only inside `tenantTx` (`createTenantDb` returns a handle without query methods).
  `velexis_ota_app`'s role default `search_path` is `pg_catalog`, so an unqualified query outside `tenantTx` fails.
  Platform and reference tables are queried by qualified name through `platformDb`.
- **Migrations.** Three sets: `platform` and `reference` (folders under `platform/backend/migrations/`, numbered
  files + `R__` repeatable grant files) and `tenant` (`ota/backend/migrations/tenant/`, numbered only). Each set has a
  [[migration-ledger]] `schema_migrations`. Tenant schemas belong to `velexis_provisioner`; default privileges give
  `velexis_ota_app` DML on every table a later file creates ([[tenant-migration]]).

```diagram
er-reference-data
```

- **Reference schema.** Written only by the loader as `velexis_platform_app`; `velexis_ota_app` has `SELECT`.
  Codes are never deleted (tenant rows reference them by value); `currencies`, `airports` and `airlines` get
  `is_active = false` instead.

```diagram
er-ciphertext-columns
```

- **Ciphertext columns.** Format owned by `@velexis/crypto`: `0x01 | kekId length | kekId | wrapped DEK (iv 12,
  tag 16, ct 32) | iv | tag | ciphertext`; `encryption_key_id` repeats the KEK id for rotation reports.
- **Redis.** Queue names and the invalidation channel are defined in `repo:packages/api-types/src/jobs/queues.ts` and
  `repo:packages/api-types/src/jobs/invalidation.ts`: prefix `vx` ([[bullmq]] keys `vx:<queue>:…`),
  [[ota-tenant-ops]] (platform → OTA), [[platform-tenant-events]] (OTA → platform), the seven platform queues
  (`platform-tenant-events`, `-emails`, `-stripe-events`, `-domains`, `-connections`, `-settlements`, `-maintenance`)
  and the eight OTA queues (`ota-tenant-ops`, `ota-stripe-events`, `-payments`, `-bookings`, `-ticketing`,
  `-notifications`, `-documents`, `-maintenance`); channel [[vx-invalidate]] with types `tenant`, `domain`, `api_key`,
  `connection`, `membership`, `account`, `amadeus_account`, `plan`. Tests use Redis databases 1–15
  (`1 + VITEST_POOL_ID % 15`); the e2e stack uses database 15 (`E2E_REDIS_DB`, 1 to 15).
- **Scratch databases.** `velexis_test_tpl_<runId>` and its clones, `velexis_e2e_<runId>`, `velexis_codegen_<pid>`,
  `velexis_dbtest_<random>`, `velexis_perf_<ts>` — all created as `velexis_test_admin`, never on the VM.
- **Files.** Key files (`.local/keys/` or `/etc/velexis/keys/<zone>/`), storage (`.local/storage/` or
  `/var/lib/velexis/storage`; keys `tenant_<key>/…` or `platform/…`, files mode 0600), fan-out reports
  (`/var/lib/velexis-migrate/migrate-<sha>.json` on the VM, mode 0600).

## Key flows

### Half A

```diagram
seq-tenant-tx
```

```diagram
seq-migrate-set
```

```diagram
seq-migrate-tenants
```

```diagram
seq-provision-schema
```

```diagram
seq-envelope-encryption
```

```diagram
seq-kek-rotation
```

```diagram
seq-error-envelope
```

```diagram
seq-request-logging
```

```diagram
seq-job-message
```

```diagram
seq-test-database
```

### Half B

```diagram
seq-e2e-stack
```

```diagram
seq-stub-request
```

```diagram
seq-reference-load
```

## Lifecycles

```diagram
migration-file-states
```

```diagram
tenant-fanout-states
```

```diagram
kek-states
```

```diagram
test-database-states
```

```diagram
stub-order-states
```

```diagram
stub-token-states
```

```diagram
reference-row-states
```

```diagram
plan-task-states
```

```diagram
e2e-run-states
```

## Integrations

| With | Through | Contract / notes |
|---|---|---|
| OpenAPI documents | `@velexis/api-types` and `@velexis/errors` generators; `expectResponseToMatch` | `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `platform/backend/openapi/velexis-platform-api.openapi.yaml`, listed in `repo:packages/api-types/redocly.yaml` |
| SDK contract | `@velexis/api-types` name and types | `docs/velexis-sdk/sdk/src/*.d.ts` import `@velexis/api-types`; tests check its schema names are a subset |
| Reference SQL | Baselines are byte copies | `docs/velexis-sdk/db/{platform,reference,tenant}.sql` = each `0001_baseline.sql` (CI guard) |
| PostgreSQL 16 | `pg` 8.23.1 + Kysely | Roles of `repo:deploy/postgres/bootstrap.sql`; `repo:deploy/postgres/schemas.sql` is its in-database tail |
| Redis 7 | BullMQ (in the apps), `ioredis` in tests | Names from `@velexis/api-types/jobs` |
| Amadeus | The stub in dev/test/e2e; `record` against `https://test.travel.api.amadeus.com` by hand | Specifications in `docs/amadeus-api/`; the stub's route table equals the OTA document's `x-amadeus` entries |
| Stripe | `signedStripeEvent` (tests); Stripe CLI forwarders (e2e nightly, `stripe-listen.sh` locally) | Fixtures of the ten webhook event types in `repo:packages/testing/fixtures/stripe` |
| Mailpit | `@velexis/testing/mailpit` (API v1 over `fetch`) | SMTP 127.0.0.1:1025, API http://127.0.0.1:8025 |
| OpenTravelData + Unicode CLDR | `scripts/fetch.mjs`, by hand | CC BY 4.0 attribution "Contains data from OpenTravelData (CC BY 4.0)"; licences re-checked on each snapshot |
| GitHub Actions | `ci.yml` (plan-lint, build-test, integration, alt-hosts, deploy-files, systemd-units, check-vm, dev-setup, sdk-node22), `e2e.yml` | `repo:.github/workflows/ci.yml`, `repo:.github/workflows/e2e.yml` |
| The VM | `velexis-deploy` runs `migrate.js` and `load.js` as transient units | `repo:deploy/scripts/deploy.sh` sections 2 and 3 |

## Security

- **Configuration and secrets.** Only `@velexis/config` reads `process.env` (ESLint `n/no-process-env` everywhere
  else). `ConfigError` names variables, never values. [[key-file]]s must be regular files with no group/other bits
  (0400 on the VM, 0600 in dev) and the right decoded length. No URL has a default.
- **Encryption.** AES-256-GCM with a fresh DEK per value; DEKs wrapped by the [[kek]]; [[associated-data]] binds a
  ciphertext to its schema, table, column and row; `DecryptionError` always says only "Decryption failed" (no oracle).
  Node's built-in `crypto` only (a test checks `package.json`). Card data is never encrypted here because it is never
  stored.
- **Tokens and keys.** `generateToken` stores only `sha256Hex` of the token; API keys are HMAC-SHA-256 with the
  [[api-key-pepper]] and compared in constant time; `timingSafeEqualStr` for shared secrets; signed URLs sign path +
  `exp` only and every failure maps to the same 403.
- **Tenancy.** Schema names validated before any SQL; the schema is a bound parameter of `set_config(…, true)`, never
  concatenated; the leak guard outside production; CI's [[repository-guards]] reject a session-level `SET search_path`
  anywhere outside `packages/db`. The migration CLI takes the DSN only from `DATABASE_MIGRATOR_URL` (no `--url`
  flag, never printed) and prints PostgreSQL's message and SQLSTATE, never its detail (which can quote row values).
- **Logs.** One redaction list; `err` serializer drops bodies, headers and config; request and response objects are
  never bound to the logger; `/health*` not logged.
- **Errors.** Envelopes never carry a stack, a cause or an echoed input value; unknown throws become 500.
- **Test code stays out of releases.** `@velexis/testing` and `@velexis/amadeus-stub` must be devDependencies
  ([[check-package-json]]); `pnpm deploy --prod` leaves them out anyway. The stub binds 127.0.0.1 and refuses
  `APP_ENV`/`NODE_ENV=production`; `record` also refuses when `CI` is set and never prints the secret or token.
- **Supply chain.** Exact versions; GitHub Actions pinned to commit SHAs with a tag comment; [[check-no-hardcoded-hosts]]
  keeps service locations in configuration.
- **e2e.** Stripe values must be test mode (live keys refused); seed stdout (passwords, keys) is discarded; Stripe CLI
  logs are redacted.

## Configuration

| Variable | Read by | Purpose |
|---|---|---|
| `APP_ENV`, `NODE_ENV` | config, logger, `createTenantDb` | `production` disables dev env files and the leak guard |
| `LOG_LEVEL` | apps → `createLogger` | default `info` |
| `DATABASE_URL` | apps, reference loader | App role DSN (loader: `velexis_platform_app`) |
| `DATABASE_MIGRATOR_URL` | `migrate.js`, tests | `velexis_migrator`; on the VM only in `/etc/velexis/migrator.env` |
| `DATABASE_PROVISIONER_URL` | OTA worker | `velexis_provisioner` for `migrateTenantSchema` |
| `TEST_DATABASE_ADMIN_URL` | `@velexis/testing`, e2e, `db:codegen`, perf | `velexis_test_admin`; never on the VM |
| `REDIS_URL`, `VITEST_POOL_ID` | apps; `useRedis` | Redis; Vitest worker id → database index |
| `MAILPIT_API_URL`, `SMTP_URL` | testing, e2e | Mailpit API and SMTP |
| `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT` | backends → `LocalFileKeyProvider` | KEK folder and current id `local:v<N>` |
| `API_KEY_PEPPER_FILE`, `JWT_PRIVATE_KEY_FILE`, `DOCUMENT_URL_KEY_FILE` | backends → `readKeyFile` | Paths only; the config never holds key material |
| `STORAGE_DRIVER`, `STORAGE_DIR` | OTA backend → `createStorage` | `local` only (`STORAGE_DRIVERS = ["local"]`): the configuration check refuses `s3` (`STORAGE_DRIVER must be one of local`); `s3` is a planned driver (`PLANNED_STORAGE_DRIVERS`) that `createStorage` refuses as not implemented yet (ADR-0017) |
| `MIGRATE_TENANT_CONCURRENCY`, `MIGRATE_TENANT_MAX_FAILURE_RATIO` | `deploy.sh` (from `migrator.env`) | Fan-out defaults 4 and 0.1 |
| `STUB_PORT` | stub CLI | default 4900 |
| `AMADEUS_RECORD_CLIENT_ID`, `AMADEUS_RECORD_CLIENT_SECRET`, `AMADEUS_RECORD_BASE_URL` | `record` | Developer's own test credentials; never committed |
| `E2E_WITH_OTA`, `E2E_REDIS_DB`, `E2E_STRIPE`, `E2E_STRIPE_BILLING`, `E2E_STRIPE_CLI`, `E2E_CHROMIUM_EXECUTABLE`, `E2E_RESULTS_SUBDIR` | e2e harness | Which stack parts run, where results go |
| `E2E_DATABASE_NAME` | e2e test workers | Set by the global setup (`velexis_e2e_<run>`), never by hand: the workers read the stack's database from it |
| `STRIPE_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY_TEST`, `STRIPE_PUBLISHABLE_KEY_TEST` | e2e with `E2E_STRIPE=1` | Test mode only |
| `PLATFORM_BFF_KEY`, `GC_OBSERVER_INTERVAL_MS` | perf | BFF key of the scratch API; GC observer interval |

Values of secrets live in `.env.local` (dev, git-ignored) or `/etc/velexis/<app>.env` (VM, root 0600); the
`.env.example` files hold dummy development values only.

## Testing

| Where | What it proves | Run one |
|---|---|---|
| `repo:packages/db/src/tenant-db.test.ts` | `tenantTx` statement order, bound parameters, rejection before SQL | `pnpm --filter @velexis/db test -- tenant-db` |
| `repo:packages/db/test/integration/tenant-tx.int.test.ts` | 50 interleaved transactions of two tenants on a pool of size 1; leak guard | `pnpm --filter @velexis/db test:int -- tenant-tx` |
| `repo:packages/db/test/integration/baselines.int.test.ts` | Every granted and denied privilege of ADR-0004 with real role logins | `… test:int -- baselines` |
| `repo:packages/db/test/integration/tenants.int.test.ts` | Provisioning, fan-out ratios, `beforeCommit` atomicity, foreign/orphan schemas | `… test:int -- tenants` |
| `repo:packages/db/test/integration/codegen.int.test.ts` | `db:codegen` deterministic and equal to the committed files | `… test:int -- codegen` |
| `repo:packages/crypto/src/envelope.test.ts`, `rewrap-batch.test.ts` | Tampering, AAD, rotation, optimistic re-wrap | `pnpm --filter @velexis/crypto test` |
| `repo:packages/logger/src/redaction.test.ts`, `redact-payload.test.ts` | Every sensitive path censored | `pnpm --filter @velexis/logger test` |
| `repo:packages/errors/src/envelope.test.ts`, `generate.test.ts` | Envelopes match `ErrorResponse`; generator deterministic | `pnpm --filter @velexis/errors test` |
| `repo:packages/api-types/src/api-types.test.ts`, `src/jobs/jobs.test.ts` | Generated files up to date; job and invalidation schemas closed | `pnpm --filter @velexis/api-types test` |
| `repo:packages/testing/test/integration/test-database.int.test.ts` (+ parallel file) | Clones isolated in parallel, `drop()` with open connections | `pnpm --filter @velexis/testing test:int` |
| `repo:tools/amadeus-stub/test/server.test.ts`, `orders.test.ts`, `shopping.test.ts`, `fixtures-scan.test.ts` | Routes, OAuth, validation, scenarios, orders, no personal data in fixtures | `pnpm --filter @velexis/amadeus-stub test` |
| `repo:tools/reference-data/test/integration/load.int.test.ts` | Loader idempotent, codes moving between rows, never deletes | `pnpm --filter @velexis/reference-data test:int` |
| `repo:tools/e2e/test/stack.test.ts` and siblings | The harness itself (settings, env of each app, ports, guards) | `pnpm --filter @velexis/e2e test` |
| `repo:tools/ci/ci-workflow.test.mjs` and siblings | Workflow layout, pins, PCI refs, Node major (they read the workflows with `repo:tools/ci/workflow-reader.mjs`, no YAML package) | `node --test tools/ci/*.test.mjs` |
| `repo:guidebook/tools/guidebook.test.mjs` | This guidebook: the build is reproducible, `dist/content.js` is up to date, every reference and repo path resolves (CI's build-test, beside the CI checks; lead decision (35e)) | `node --test guidebook/tools/guidebook.test.mjs` |
| `repo:tools/plan-lint/test/plan-lint.test.mjs` | Plan format, done markers, `--remaining` | `node --test tools/plan-lint/test/` |

ADR-0015's levels: unit (`*.test.ts`), integration (`test/integration/**/*.int.test.ts`), contract
(`test/contract/**`), component (happy-dom), end-to-end (`tools/e2e/specs/**/*.e2e.ts`). No retries, no `.only`
(ESLint and Vitest refuse it in CI), no weakened tests.

## Where to change things

| To change … | Look at |
|---|---|
| How env vars are validated, a new builder | `repo:packages/config/src/env.ts`, `repo:packages/config/src/define-config.ts` |
| Key-file checks (mode, length, PEM) | `repo:packages/config/src/key-files.ts` |
| `.env.local` precedence | `repo:packages/config/src/dev-env-files.ts` |
| What gets redacted in logs | `repo:packages/logger/src/redact-paths.ts` + `repo:packages/logger/src/redaction.test.ts` |
| What gets redacted in stored payloads | `repo:packages/logger/src/redact-payload.ts` + `repo:packages/logger/src/redact-payload.test.ts` |
| Request id, per-request log line, health-path skipping | `repo:packages/logger/src/http.ts` |
| Whether a free text holds a card number (`holdsCardNumber`, the API's `card_data` refusal of console and customer free text) | `repo:packages/logger/src/card-number.ts` + `repo:packages/logger/src/card-number.test.ts` |
| Envelope format, AAD rules | `repo:packages/crypto/src/envelope.ts`, `repo:packages/crypto/src/aad.ts` |
| KEK loading, file rules | `repo:packages/crypto/src/local-file-key-provider.ts` |
| Re-wrap paging / reports | `repo:packages/crypto/src/rewrap-batch.ts`; callers `repo:platform/backend/src/secrets/rewrap.command.ts`, `repo:ota/backend/src/secrets/rewrap.command.ts` |
| Token, API-key hash, signed URL, id formats | `repo:packages/crypto/src/tokens.ts`, `repo:packages/crypto/src/hash.ts`, `repo:packages/crypto/src/signed-url.ts`, `repo:packages/crypto/src/ids.ts` |
| Pool defaults, numeric/date parsing | `repo:packages/db/src/pool.ts`, `repo:packages/db/src/type-parsers.ts` |
| `tenantTx`, leak guard, default 5 s timeout | `repo:packages/db/src/tenant-db.ts`, `repo:packages/db/src/tenant-schema.ts` |
| The OTA backend's tenant transactions (15 s, afterCommit) | `repo:ota/backend/src/tenancy/tenant-tx.ts`, `repo:ota/backend/src/tenancy/tenancy.module.ts` |
| Platform pool / `platformDb` wiring | `repo:platform/backend/src/common/database.ts` |
| Migration file rules, ledger, run of a set | `repo:packages/db/src/migrate/files.ts`, `repo:packages/db/src/migrate/ledger.ts`, `repo:packages/db/src/migrate/run-set.ts`, `repo:packages/db/src/migrate/repeatable.ts` |
| Tenant schema creation, grants, `beforeCommit` | `repo:packages/db/src/migrate/tenant-schema.ts`; caller `repo:ota/backend/src/provisioning/provisioning.service.ts` |
| Fan-out targets, concurrency, failure ratio, report | `repo:packages/db/src/migrate/tenants.ts`; report publisher `repo:ota/backend/src/provisioning/report-migrations.command.ts` |
| CLI options and exit codes | `repo:packages/db/src/cli/migrate.ts` |
| A schema change (new table/column) | New file in `repo:platform/backend/migrations/platform`, `repo:platform/backend/migrations/reference` or `repo:ota/backend/migrations/tenant`; then `pnpm db:codegen` |
| OTA read grants on platform tables | `repo:platform/backend/migrations/platform/R__ota_read_access.sql` |
| Table types | Regenerate with `repo:packages/db/scripts/codegen.mjs` (never edit `packages/db/src/generated/`) |
| Storage keys, atomic writes | `repo:packages/db/src/storage/local-disk-storage.ts`; caller `repo:ota/backend/src/documents/documents.module.ts` |
| Error codes, statuses, messages | The OpenAPI document's `x-error-catalogue`, then `pnpm contracts:generate` (`repo:packages/errors/scripts/generate.mjs`) |
| Which codes carry `fieldErrors`; envelope shape | `repo:packages/errors/src/app-error.ts`, `repo:packages/errors/src/envelope.ts`; filters `repo:ota/backend/src/common/http/error.filter.ts`, `repo:platform/backend/src/common/http/error.filter.ts` |
| Generated API types / operations index fields | `repo:packages/api-types/scripts/generate.mjs` (`INDEX_FIELDS`) |
| Lint rules of the documents | `repo:packages/api-types/redocly.yaml`, `repo:packages/api-types/scripts/contracts-lint.mjs` |
| Queue names, job messages, invalidation events | `repo:packages/api-types/src/jobs/queues.ts`, `repo:packages/api-types/src/jobs/tenant-ops.ts`, `repo:packages/api-types/src/jobs/tenant-events.ts`, `repo:packages/api-types/src/jobs/invalidation.ts`, `repo:packages/api-types/src/jobs/validate.ts` |
| Job fixtures shared by both backends | `repo:packages/api-types/fixtures/jobs` |
| Test database template, clone, drop | `repo:packages/testing/src/vitest-global-setup.ts`, `repo:packages/testing/src/test-database.ts` |
| Test role logins (must equal `.env.example`) | `repo:packages/testing/src/roles.ts` |
| Reference rows of the test template | `REFERENCE_FIXTURE` in `repo:packages/testing/src/test-database.ts` |
| Response check (Ajv strictness, annotations) | `repo:packages/testing/src/openapi-response.ts` |
| Mailpit matching / timeouts | `repo:packages/testing/src/mailpit.ts` |
| Stripe test fixtures | `repo:packages/testing/fixtures/stripe`, `repo:packages/testing/src/stripe.ts` |
| Stub routes / handlers | `repo:tools/amadeus-stub/src/routes.ts`, `repo:tools/amadeus-stub/src/handlers` |
| Stub scenarios, magic values, error codes | `repo:tools/amadeus-stub/src/scenarios.ts` |
| Stub orders behaviour | `repo:tools/amadeus-stub/src/orders.ts` |
| Stub request validation | `repo:tools/amadeus-stub/src/validate.ts` |
| Stub fixtures | `repo:tools/amadeus-stub/fixtures` (+ `repo:tools/amadeus-stub/fixtures/README.md`) |
| Recording and scrubbing | `repo:tools/amadeus-stub/src/record.ts`, `repo:tools/amadeus-stub/src/scrub.ts` |
| e2e stack (ports, env of each app, seeds) | `repo:tools/e2e/support/stack.ts` |
| e2e projects | `repo:tools/e2e/playwright.config.ts` |
| e2e arrangements (platform rows) / OTA helpers | `repo:tools/e2e/support/seed.ts`, `repo:tools/e2e/support/ota.ts`, `repo:tools/e2e/support/fixtures.ts` |
| Storefront guards / card-leak checks | `repo:tools/e2e/support/storefront-guards.ts`, `repo:tools/e2e/support/card-leak-guards.ts` |
| A journey | `repo:tools/e2e/specs` |
| One reference value (urgent) | `repo:tools/reference-data/data/overrides.csv` |
| Mapping of sources to reference columns | `repo:tools/reference-data/scripts/fetch.mjs` |
| Reference validation rules | `repo:tools/reference-data/scripts/validate.mjs` |
| Loader behaviour (release, upsert, deactivate) | `repo:tools/reference-data/src/load.ts` |
| CI package/workflow rules | `repo:tools/ci/check-package-json.mjs` |
| Allowed host exceptions | `ALLOWED` in `repo:tools/ci/check-no-hardcoded-hosts.mjs` |
| CI job layout (tests of the workflow) | `repo:.github/workflows/ci.yml`, `repo:tools/ci/ci-workflow.test.mjs` |
| Plan format and progress | `repo:tools/plan-lint/plan-lint.mjs` |
| Perf phases, targets, budgets | `repo:tools/perf/platform-smoke.mjs` |
| Local key files | `repo:tools/dev/dev-keys.mjs` |
| Deploy steps that run these tools | `repo:deploy/scripts/deploy.sh` |

## Further reading

- Packages: `repo:packages/README.md`, `repo:packages/config/README.md`, `repo:packages/logger/README.md`,
  `repo:packages/crypto/README.md`, `repo:packages/db/README.md`, `repo:packages/errors/README.md`,
  `repo:packages/api-types/README.md`, `repo:packages/testing/README.md`.
- Tools: `repo:tools/amadeus-stub/README.md`, `repo:tools/e2e/README.md`, `repo:tools/reference-data/README.md`,
  `repo:tools/reference-data/SOURCES.md`, `repo:tools/ci/README.md`, `repo:tools/perf/README.md`,
  `repo:tools/plan-lint/README.md`, `repo:tools/dev/README.md`.
- ADRs: `repo:docs/mvp/adr/0002-monorepo-pnpm-turborepo.md`, `repo:docs/mvp/adr/0004-postgresql-schema-per-tenant.md`,
  `repo:docs/mvp/adr/0005-data-access-kysely-sql-migrations.md`, `repo:docs/mvp/adr/0006-contract-first-openapi.md`,
  `repo:docs/mvp/adr/0010-secrets-envelope-encryption.md`, `repo:docs/mvp/adr/0015-testing-strategy.md`,
  `repo:docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md`,
  `repo:docs/mvp/adr/0022-shared-test-support-package.md`,
  `repo:docs/mvp/adr/0024-reference-data-sources-and-loader.md`.
- Guides: `repo:docs/mvp/local-development.md`, `repo:docs/mvp/runbooks/master-key-rotation.md`.
- Related apps: [[app:platform-api]], [[app:ota-api]], [[app:deploy]].

```note
Docs that disagree with the code at a68a8cd8 (code wins): `packages/README.md` still says the packages "do not exist
yet" and shows the `.env.local` order as root-then-app (the code reads the app file first);
`packages/testing/README.md` lists Vitest 3.2.7 while `package.json` pins 4.1.12; `packages/api-types/README.md`
still describes a 24-operation platform slice (the index holds 144 platform operations) and the errors/api-types
READMEs still describe the platform document as future; the reference `tenant.sql` comment says the runner mirrors
ledgers into `platform.tenant_schema_migrations`, which the runner does not do.
```
