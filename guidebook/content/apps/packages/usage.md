---
id: usage
title: Shared packages and tools — usage guide
summary: How to use and test the foundation of every Velexis app — config, logging and redaction, envelope encryption, tenantTx and migrations, the error catalogue, the API contract types, the test harness — and the tools around it (Amadeus stub, Playwright stack, reference data, CI checks, plan-lint, perf, dev keys), with what to check in PostgreSQL, Redis and Mailpit.
---

## What it is

Two halves, one guide:

- **Half A — shared packages (`repo:packages`).** Seven TypeScript libraries that the backends (and partly the
  Next.js apps) import. They own the cross-cutting rules: typed configuration ([[define-config]]), logging and
  redaction ([[redact-paths]], [[redact-payload]]), secrets at rest ([[envelope-encryption]]), tenant isolation
  ([[tenant-tx]], [[platform-db]]) and migrations ([[migration-runner]]), one error model ([[error-catalogue]],
  [[app-error]], [[error-envelope]]), the API contract types ([[operations-index]], [[job-envelope]]) and test support
  ([[test-template-database]]).
- **Half B — tools (`repo:tools`).** The [[amadeus-stub]] (a fake Amadeus on port 4900), the Playwright
  [[e2e-stack]], the [[reference-data-snapshot]] and its [[reference-loader]], CI's own checks
  ([[check-package-json]], [[check-no-hardcoded-hosts]], [[repository-guards]], [[pci-refs-checker]]),
  [[plan-lint]], the [[platform-smoke]] performance test and [[dev-keys]].

None of this has screens of its own. Bugs found while walking through the apps often land here: a wrong error
message (catalogue), a leaked value in a log line (redaction), a "relation does not exist" (tenantTx / search_path), a
missing airport (reference data), a migration that did not run (ledger), a flaky journey (e2e harness).

```diagram
neighbours
```

| Package / tool | Folder | One-line job | Runs on the VM? |
|---|---|---|---|
| `@velexis/config` | `repo:packages/config` | Validate env vars and key files at start; the only reader of `process.env` | Inside every Node app |
| `@velexis/logger` | `repo:packages/logger` | pino JSON lines, request ids, the single redaction list | Inside every Node app |
| `@velexis/crypto` | `repo:packages/crypto` | Envelope encryption, KEK files, re-wrap, tokens, API-key HMAC, signed URLs, ids | Inside both backends |
| `@velexis/db` | `repo:packages/db` | Pools, `platformDb`, `tenantTx`, migration runner + `migrate.js`, storage, table types | Inside both backends; `migrate.js` at deploy |
| `@velexis/errors` | `repo:packages/errors` | Generated error catalogue, `AppError`, `toErrorEnvelope` | Inside backends and Next.js apps |
| `@velexis/api-types` | `repo:packages/api-types` | Types generated from both OpenAPI documents, operations index, queue messages | Inside every app (types erased) |
| `@velexis/testing` | `repo:packages/testing` | Test databases, Redis, clock, builders, response check, Mailpit, stub, Stripe | Never (devDependency only) |
| `@velexis/amadeus-stub` | `repo:tools/amadeus-stub` | Amadeus OAuth + 12 operations from fixtures, scenarios | Never (refuses production) |
| `@velexis/e2e` | `repo:tools/e2e` | Playwright journeys against the built stack | Never |
| `@velexis/reference-data` | `repo:tools/reference-data` | Vendored airports/airlines/… CSVs + loader | Loader runs at deploy |
| `tools/ci`, `tools/plan-lint` | `repo:tools/ci`, `repo:tools/plan-lint` | CI checks, plan validation and progress | Never |
| `tools/perf`, `tools/dev` | `repo:tools/perf`, `repo:tools/dev` | Perf smoke test, GC observer, unit heap flags; local keys, Stripe forwarding | Never |

## Before you start

Everything here is local development. Passwords below are the **committed development values** of
`repo:.env.example` and `repo:deploy/scripts/dev-setup.sh` — development only, never production.

```try
command: pnpm install && cp .env.example .env.local && bash deploy/scripts/dev-setup.sh && pnpm dev:keys
expect: roles velexis_migrator/dev_migrator, velexis_provisioner/dev_provisioner, velexis_platform_app/dev_platform, velexis_ota_app/dev_ota, velexis_test_admin/dev_test_admin; database velexis; .local/keys/ with five files (mode 0600)
```

```try
command: pnpm build && pnpm db:migrate && pnpm db:seed:reference
expect: one JSON line per applied migration file (none on a second run), then one reference.loaded line
```

```try
command: pnpm stub:amadeus
url: http://127.0.0.1:4900
expect: "amadeus-stub: listening on http://127.0.0.1:4900 (ready in … ms …"; GET / answers 404 code 38196 (no route) — that is normal
```

```try
command: mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
url: http://127.0.0.1:8025
expect: Mailpit UI; integration and e2e tests send here
```

```diagram
flow-local-setup
```

Prerequisites: Node 24 (`.nvmrc`), pnpm, PostgreSQL 16, Redis 7 (password `dev_redis`), Mailpit. Use
`REDISCLI_AUTH=dev_redis redis-cli` (not `redis-cli -u`) to look into Redis. The one-click tour of the whole stack is
[[journey:run-the-stack]]; the system overview is [[page:getting-started]].

## Tour

### Half A — the shared packages

#### `@velexis/config` — typed configuration

| What to try | Command / action | What should happen |
|---|---|---|
| Unit tests | `pnpm --filter @velexis/config test` | Green, including type tests (`expectTypeOf`) |
| Missing variable | Start a backend with `DATABASE_URL` removed from `.env.local` | Start-up stops with `ConfigError: Invalid configuration (1 problem):` (or `(N problems)`) and the line `  - DATABASE_URL is required but missing` — **never a value** |
| Loose key file | `chmod 644 .local/keys/api-key-pepper` then start the platform API | `  - API_KEY_PEPPER_FILE must name a valid key file: the file is accessible by group or others (mode 0644); restrict it to mode 0400 or 0600`. `pnpm dev:keys` fixes it and prints `kept     .local/keys/api-key-pepper (mode 644 tightened to 600)` |
| Empty optional | `SENTRY_DSN=` | Counts as unset (feature off), not an error |
| Production guard | `APP_ENV=production` with only `.env.local` | `loadDevEnvFiles` reads nothing; every required variable is reported missing |

Precedence (code, `repo:packages/config/src/dev-env-files.ts`): the real environment, then `<app>/.env.local`,
then the root `.env.local` (each file only fills variables still unset).

#### `@velexis/logger` — logs and redaction

| What to try | Command / action | What should happen |
|---|---|---|
| Tests | `pnpm --filter @velexis/logger test` | `redaction.test.ts` and `redact-payload.test.ts` green |
| Request id | `curl -si -H 'X-Request-Id: bughunt-0001' http://127.0.0.1:4000/v1/storefront` (OTA API running) | Response header `X-Request-Id: bughunt-0001`; one log line with `requestId":"bughunt-0001"`, `route`, `status`, `durationMs` |
| Invalid request id | `-H 'X-Request-Id: x'` (shorter than 8) | Replaced by a UUID in the response header and the log |
| Health is quiet | `curl http://127.0.0.1:4000/health/ready` | No request log line |
| Secrets censored | Any log line that would carry `password`, `token`, `authorization`, `cookie`, `card`, `cvc`, `iban`… | `[REDACTED]`; bodies, headers and query strings never appear |

#### `@velexis/crypto` — secrets at rest, tokens, ids

| What to try | Command / action | What should happen |
|---|---|---|
| Tests | `pnpm --filter @velexis/crypto test` | Round trip, tampering, AAD, rotation, key files, "no third-party crypto" |
| Stored ciphertext | `psql postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis -c "SELECT id, encryption_key_id, length(client_secret_ciphertext) FROM platform.amadeus_accounts"` (after the platform `dev:seed`) | `encryption_key_id = local:v1`; length = secret length + 98 bytes (90 bytes of envelope + the 8 characters of `local:v1`); never plaintext |
| Signed document URL | Download a booking document from the storefront; edit `exp` or `sig` in the URL | Always the same `403` whatever the reason ([[signed-url]]) |
| Ids | Any new row id | `<prefix>_<26 Crockford base32>` (e.g. `bkg_01J…`); never sequential within a millisecond |

#### `@velexis/db` — pools, tenancy, migrations, storage

| What to try | Command / action | What should happen |
|---|---|---|
| Unit tests | `pnpm --filter @velexis/db test` | Statement order of `tenantTx`, parsers, file rules |
| Integration tests | `pnpm --filter @velexis/db test:int` | 50 interleaved transactions of `tenant_alpha`/`tenant_beta` on a pool of size 1 never see each other's rows |
| Migrate | `pnpm db:migrate` twice | First run: JSON lines `"status":"applied"`; second run: nothing, exit 0 |
| Tenant fan-out | `pnpm db:migrate:tenants` (after the OTA `dev:seed` created `tenant_demo`) | Applies `ota/backend/migrations/tenant/*` to every tenant schema; exit 0 |
| One schema | `node packages/db/dist/cli/migrate.js tenant --schema tenant_demo --dir ota/backend/migrations/tenant` | Nothing pending → no output |
| Bad schema name | `… tenant --schema tenant_a …` | Refused before any connection (`tenant_` + at least 2 characters) |
| Table types | `pnpm db:codegen` | `unchanged` for the three files when nothing changed |
| OTA role search_path | `psql postgres://velexis_ota_app:dev_ota@127.0.0.1:5432/velexis -c 'SHOW search_path'` | `pg_catalog` — an unqualified query outside `tenantTx` must fail with `relation "bookings" does not exist` |

CLI exit codes: `0` ok, `1` error, `2` checksum mismatch of an applied file, `3` too many tenant schemas failed.

#### `@velexis/errors` — one error model

| What to try | Command / action | What should happen |
|---|---|---|
| Tests | `pnpm --filter @velexis/errors test` | Envelopes validate against the OTA `ErrorResponse` schema |
| A known error | `curl -s http://127.0.0.1:4000/v1/flight-searches/srch_doesnotexist -H 'X-Api-Key: <pk_test key from dev:seed>'` | `{ "error": { "code": …, "message": …, "status": 404, "requestId": … } }` — status from the catalogue |
| An unexpected error | Any bug that throws a `TypeError` | `500 INTERNAL_ERROR`, message "Unexpected error; quote the requestId to support.", **no stack** |
| Field errors | Sign up with a weak password on the storefront | `PASSWORD_TOO_WEAK` (or `VALIDATION_FAILED`) with `fieldErrors[{ path: "/password", code, message }]` |

The catalogue is generated: 74 OTA codes plus 29 platform-only codes (52 in the platform document).

#### `@velexis/api-types` — the contract in TypeScript

| What to try | Command | What should happen |
|---|---|---|
| Lint the documents | `pnpm contracts:lint` | No errors; no network calls (telemetry off) |
| Regenerate | `pnpm contracts:generate` | `unchanged` for every generated file on a clean tree |
| Tests | `pnpm --filter @velexis/api-types test` | Generator determinism, 96 frozen SDK operations present, job fixtures valid |
| Counts | `grep -c '^  { operationId' packages/api-types/src/generated/operations.ts` | 280 (136 OTA + 144 platform) at HEAD a68a8cd8; the file's header comment names both counts |

#### `@velexis/testing` — test support (dev only)

| What to try | Command | What should happen |
|---|---|---|
| Unit tests | `pnpm --filter @velexis/testing test` | No PostgreSQL, Redis or Mailpit needed |
| Integration tests | `pnpm --filter @velexis/testing test:int` (after `pnpm build`) | Two files run in parallel, each on its own clone with `tenant_alpha` and `tenant_beta`; two Mailpit files never see each other's e-mail |
| Leftovers | `psql "$TEST_DATABASE_ADMIN_URL" -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'velexis\_test\_%'"` | Empty after a normal run |

Helpers you will meet in every backend test: [[test-roles]] (`db.urlFor("ota")`), [[use-redis]] (Redis database
`1 + VITEST_POOL_ID % 15`), [[fake-clock]], `defineBuilder`, [[expect-response-to-match]], [[mailpit]]
(`waitForMessage`, `uniqueEmail`), `startAmadeusStub` + `stubScenario`, [[signed-stripe-event]].

### Half B — the tools

#### Amadeus stub (`pnpm stub:amadeus`, port 4900)

Every route of the stub, what to try and what should happen (fixtures under `repo:tools/amadeus-stub/fixtures`):

| Route | Try | Expected |
|---|---|---|
| `POST /v1/security/oauth2/token` | `-d 'grant_type=client_credentials&client_id=x&client_secret=y'` | `200`, `expires_in: 1799`; no `grant_type` → `400` 38187; empty secret → `401 invalid_client` |
| `GET /v2/shopping/flight-offers` | `?originLocationCode=MAD&destinationLocationCode=PAR&departureDate=2027-01-15&adults=1&max=2` | `200`, 2 offers; destination `ZZZ` → `meta.count: 0` |
| `POST /v2/shopping/flight-offers` | body with `searchCriteria.maxFlightOffers`, header `X-HTTP-Method-Override: GET` | Same fixture, cut to the max |
| `POST /v1/shopping/availability/flight-availabilities` | any valid body | Seats by class; `ZZZ` → none |
| `POST /v1/shopping/flight-offers/upselling` | offer 2 of the search | BASIC 98.47, CLASSIC 126.47, FLEXIBLE 189.47 EUR |
| `POST /v1/shopping/flight-offers/pricing` | `?include=bags,detailed-fare-rules,credit-card-fees` | Offers echoed + `bookingRequirements`; card fees VISA 1.20, MASTERCARD 1.50, AMEX 3.95 EUR; `price-changed` → +10.00 per traveller pricing and warning 37200 |
| `POST /v1/booking/flight-orders` | priced offer + traveller | `201`, 6-character record locator; card `4000000000000002` → `400` 1304, nothing stored |
| `POST …/{id}/issuance` | issue twice | First `200` with e-tickets `000-0000000001…`; second `400` 9112 |
| `GET / PATCH / DELETE …/{id}` | read, replace remarks, cancel | `200`/`200`/`204`; after DELETE every read `404` 1797 |
| `GET /v1/booking/flight-orders/by-reference` | `?reference=<locator>&originSystemCode=GDS` | `200` with `data: [order]`; another system code → `400` 4926 |
| `GET /v1/office/queues/{queue-id}` | after an order with `automatedProcess` queue placement | `pnrList` entries, oldest first |

[[stub-scenario]] header `X-Stub-Scenario`: `success`, `server-error` (500 141), `rate-limited` (429 38194), `timeout`
(30 s hold → 504), `timeout-lost` (504 **without** the write), `sold-out` (400 34651), `price-changed`,
`ticketing-failed` (9112), `version-conflict` (409 2552), `cancel-refused` (400 4926). The request log
(`stub.requests()` in tests, one line per request in the CLI) never holds a body, a token or a full card number.

```diagram
flow-drive-stub
```

#### Playwright end-to-end harness (`pnpm test:e2e`)

| [[playwright-project]] | Specs | Base URL | Needs |
|---|---|---|---|
| `portal` | `specs/portal-*.e2e.ts`, `specs/console-*.e2e.ts`, smoke | http://127.0.0.1:3000 | built platform apps; `E2E_WITH_OTA=1` for journeys that provision an OTA |
| `platform-admin` | `specs/admin-*.e2e.ts`, smoke | http://127.0.0.1:3001 | built platform apps |
| `storefront` | `specs/storefront/**` (search, checkout with airline card, account and bookings, content pages, a11y, live and domains) | http://127.0.0.1:4173 | `E2E_WITH_OTA=1` |
| `ota-admin` | `specs/ota-admin/**` (SSO and bookings, PNR import, roles, settings effects, live environment, session expiry, reconciliation review, payments, a11y and headers) | http://127.0.0.1:3002 | `E2E_WITH_OTA=1` |
| `portal-stripe`, `storefront-stripe` | journeys tagged `@stripe` (`storefront-stripe` also runs `specs/ota-admin/payments.e2e.ts`) | 3000 / 4173 | `E2E_STRIPE=1` + test-mode Stripe keys + Stripe CLI; `storefront-stripe` also needs `E2E_WITH_OTA=1` (nightly and on demand) |

The 44 spec files are the best step-by-step description of what each UI should do: read the spec before you test a
journey by hand (for example `repo:tools/e2e/specs/portal-signup.e2e.ts` or
`repo:tools/e2e/specs/storefront/checkout-airline-card.e2e.ts`).

#### Reference data (`pnpm db:seed:reference`)

| What to try | Command | What should happen |
|---|---|---|
| Offline check | `node tools/reference-data/scripts/fetch.mjs --check` | Exit 0 |
| Load | `pnpm db:seed:reference` | `reference.loaded` JSON line; second run all zeros |
| Look | `SELECT iata_code, name, city_code, time_zone, is_active FROM reference.airports WHERE iata_code IN ('CDG','LHR','JFK');` | Three active rows with city and IANA zone |
| Sizes | `SELECT count(*) FROM reference.airports;` | About 11 085 rows (≥ 8 000 required); cities ≈ 10 045, airlines ≈ 1 121, countries 250, currencies 307, time zones 599, aircraft 477 |

#### CI checks, plan-lint, perf, dev

| Command | What it checks / does | Expected |
|---|---|---|
| `pnpm plan:lint` | The three task plans (`### ID · Title` blocks, fields, done markers ` ✅`, dependencies, cycles) | `ERRORS: 0`, summary blocks |
| `node tools/plan-lint/plan-lint.mjs --remaining` | Ready tasks of the lowest open milestone, critical path first | A short list or `remaining: none, every task is done` |
| `node tools/ci/check-package-json.mjs` | Exact versions, test packages dev-only, packages never depend on apps, actions pinned to SHAs | Silent, exit 0 |
| `node tools/ci/check-no-hardcoded-hosts.mjs` | No `localhost`, `127.0.0.1`, `:5432`, `:6379` in app/package code | Exit 0 |
| `node tools/ci/check-pci-refs.mjs` | Every reference of `ota/docs/pci/*.md` still points at its line | `… references checked, 0 problems` |
| `node tools/perf/platform-smoke.mjs --help` | The platform performance smoke test (scratch stack only) | Usage text |
| `node tools/perf/unit-node-options.mjs deploy/systemd/velexis-platform-api.service` | Heap flags systemd gives a unit | `--max-old-space-size=640 --max-semi-space-size=16` |
| `pnpm dev:keys` | Local key files | `kept` for every existing file |
| `bash tools/dev/stripe-listen.sh` | Stripe CLI forwarding to the local APIs (needs your Stripe test login) | Prints the `whsec_` lines for `.env.local` |

## How to …

### Half A

#### … add a migration and see it applied

1. Write the next numbered file with its phase header (`-- velexis:phase expand`), never touching a merged file.
2. `pnpm db:migrate` (or `pnpm db:migrate:tenants` for the tenant set), then `pnpm db:codegen`.
3. Check the ledger: `SELECT id, phase, status, execution_ms FROM platform.schema_migrations ORDER BY id;`
4. Commit the file with the regenerated `packages/db/src/generated/*.ts`.

```diagram
flow-add-migration
```

#### … add an error code or change an API shape

```diagram
flow-change-contract
```

#### … add a sensitive field to the logs' redaction

```diagram
flow-add-redaction
```

#### … rotate the master key (KEK)

```diagram
flow-rotate-kek
```

#### … run the tests

```diagram
flow-run-tests
```

### Half B

#### … run the end-to-end journeys

```diagram
flow-run-e2e
```

#### … record a new Amadeus fixture

```diagram
flow-record-fixture
```

#### … fix or refresh reference data

```diagram
flow-reference-data
```

#### … run CI's checks before pushing

```diagram
flow-ci-locally
```

#### … measure the platform API's performance

```diagram
flow-perf-smoke
```

## Roles and permissions

PostgreSQL roles are where these packages enforce tenancy (ADR-0004). Logins below are development values.

| Role (dev password) | Used by | May | Must fail (what you should see) |
|---|---|---|---|
| `velexis_migrator` (`dev_migrator`) | `migrate.js`, `db:codegen`, e2e harness | DDL on `platform` and `reference`; reads `platform.tenants` | — |
| `velexis_provisioner` (`dev_provisioner`) | OTA worker provisioning; runner via `SET LOCAL ROLE` | Owns `tenant_<key>` schemas | `INSERT INTO platform.…` → `permission denied` |
| `velexis_platform_app` (`dev_platform`) | Platform API/worker, reference loader | DML on `platform` and `reference` | Any `tenant_<key>` table → `permission denied for schema` |
| `velexis_ota_app` (`dev_ota`) | OTA API/worker | DML in tenant schemas (default privileges), SELECT on `reference` and listed platform tables | Unqualified query outside `tenantTx` → `relation … does not exist`; reference write → `42501` |
| `velexis_test_admin` (`dev_test_admin`) | `@velexis/testing`, e2e, codegen, perf (local/CI only) | `CREATEDB`, member of `velexis_migrator` | Never exists on the VM |

Who may run what: anyone may run tests and checks locally; only a developer records stub fixtures or refreshes
reference data (both refuse in CI or production); only the operator rotates keys on the VM.

## Bug-hunting checklist

```bug-hunt
**Tenancy isolation (`tenantTx`).** In `psql` as `velexis_ota_app`, `SHOW search_path` must be `pg_catalog`. Every
tenant schema must be owned by the provisioner:
`SELECT nspname, pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname LIKE 'tenant\_%';` → `velexis_provisioner`.
A `SearchPathLeakError` in an OTA log means some code ran a session-level `SET search_path` on the pool — a real bug.
Note the OTA backend's own `tenantTx` wrapper uses a 15 s statement timeout, not the package default of 5 s.
```

```bug-hunt
**Migrations and ledgers.** Compare files and ledgers:
`SELECT id, status, checksum FROM platform.schema_migrations ORDER BY id;` (expect 0001–0004 and
`R__ota_read_access`), `SELECT id FROM reference.schema_migrations;` (0001_baseline),
`SELECT id, status FROM tenant_demo.schema_migrations ORDER BY id;` (0001–0005). Every tenant schema should be at the
same last id. A `status` other than `applied`, or an exit code `2` (checksum mismatch: someone edited a merged file),
is a finding. `platform.tenant_schema_migrations` is written by the platform worker from events, not by the runner:
if it lags behind the tenant ledgers, check the `platform-tenant-events` queue.
```

```bug-hunt
**Missing migrations folder is silent.** `migrate.js` treats a `--dir` that does not exist as an empty set: stderr
`migrate: notice: the platform migrations folder <dir> does not exist; it is an empty set and nothing was applied`,
exit 0. `deploy.sh` and `pack-release.sh` also skip a set whose folder is missing. A typo in `--dir` therefore
"succeeds" with nothing applied. Try it: `node packages/db/dist/cli/migrate.js platform --dir /tmp/nope; echo $?`.
```

```bug-hunt
**Encryption.** Every `*_ciphertext` row must have an `encryption_key_id` (`SELECT count(*) FROM
platform.supplier_connections WHERE client_secret_ciphertext IS NOT NULL AND encryption_key_id IS NULL;` → 0; same for
`platform.accounts.mfa_secret_ciphertext`, `platform.amadeus_accounts`, `platform.payment_provider_connections`,
`platform.credential_submissions`, `platform.provisioning_jobs.reveal_encryption_key_id`, tenant `checkout_travelers`,
`booking_travelers`, `saved_travelers`, `saved_traveler_documents`, `notifications`). Copying a ciphertext to another
row must make it undecryptable (AAD). A decryption failure must never say why.
```

```bug-hunt
**Logs and persisted payloads.** `journalctl`/`test-results/stack/*.log` lines must never contain a card number,
CVC, password, token, `Authorization`/`Cookie` header, IBAN or MFA code; a 13–19 digit run is a red flag. Check
stored copies too: `SELECT order_snapshot FROM tenant_demo.bookings ORDER BY created_at DESC LIMIT 1;` and
`tenant_demo.supplier_requests`, `staff_actions`, `idempotency_keys`, `payment_events`, `notifications` — card
numbers must be last-4 only, CVC absent, holder and expiry dropped.
```

```bug-hunt
**Error envelopes.** Every API error body must have exactly `code`, `message`, `status`, `requestId` (+ optional
`details`, `fieldErrors`, `supplier`), the HTTP status must equal `status`, and `fieldErrors` may appear only for
`VALIDATION_FAILED`, `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `CHECKOUT_INCOMPLETE`,
`EMAIL_ALREADY_REGISTERED`, `PASSWORD_TOO_WEAK`, `CURRENT_PASSWORD_INCORRECT`. A `500` must never echo an input value
or a stack. The portal and admins map codes to text: an unknown code showing raw (`SOME_CODE`) is a UI bug.
```

```bug-hunt
**Money and time types.** `numeric` and `int8` come back as **strings** ("12.30"), `timestamptz` as `Date`. A
price shown as `12.3`, `12.299999` or `NaN`, or a time off by the server's offset, usually means code converted a
string with `Number()` or formatted a `Date` in local time.
```

```bug-hunt
**Reference data.** Type a city in the storefront search (the OTA API answers from `reference.*` through
`GET /v1/reference/locations`): the suggestion order should follow `search_rank`, closed airports
(`is_active = false`) should not be offered, and a code removed from the snapshot must stay readable for old bookings. `SELECT code, is_active FROM reference.currencies WHERE code IN ('EUR','USD','XTS');` → XTS inactive.
Airlines spanning several countries have `country_code` NULL by design.
```

```bug-hunt
**Queues and cache events.** BullMQ keys are `vx:<queue>:…`: `REDISCLI_AUTH=dev_redis redis-cli --scan --pattern
'vx:ota-tenant-ops:*' | head`. A job id of a provisioning dispatch looks like `job_…-<attempt>`. Watch cache
invalidation with `REDISCLI_AUTH=dev_redis redis-cli SUBSCRIBE vx:invalidate` while you change a tenant, domain or API
key in the portal: one message per change with `v` (1), `type` and only the identifying field of that type (`id` for
`tenant` and `amadeus_account`, `hostname`, `prefix`, `tenantId` for `connection`, `accountId` (+ `tenantId` for
`membership`), `code` for `plan`); never a name, an e-mail or a secret.
```

```bug-hunt
**Test harness hygiene.** After tests: no `velexis_test_%`, `velexis_e2e_%`, `velexis_codegen_%` or
`velexis_dbtest_%` databases left (`SELECT datname FROM pg_database WHERE datname ~ '^velexis_(test|e2e|codegen|dbtest)_';`).
The e2e stack empties Redis database 15 (`E2E_REDIS_DB`) at start and end. `useRedis` gives worker n database
`1 + n % 15`, so only a run with 14 or more workers reaches 15; today the backends' integration configs run one file at
a time and `@velexis/testing` four, so the ranges do not meet. Mailpit is shared: tests must use `uniqueEmail` and never
`clear()`.
```

```bug-hunt
**Amadeus stub realism.** A request the real Amadeus would reject must be rejected by the stub too (unknown body
field on pricing/booking → `400` 4926 naming `/data/…`). If the OTA backend shows "sold out" or a price change, check
whether an `X-Stub-Scenario` header (forwarded outside production) or a `setDefaultScenario` caused it:
`stub.requests()` shows the scenario of each request. A restarted stub forgets every order and token.
```

```bug-hunt
**Signed URLs.** A document link must stop working after its `exp` (5 minutes), with any changed character, and with
any extra query parameter — always the same `403`, never a hint of why.
```

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `ConfigError: … is required but missing` | `.env.local` missing a value | Compare with `.env.example`; set it in `<app>/.env.local` |
| `… must name a valid key file …` | Key file missing or mode not 0400/0600 | `pnpm dev:keys` |
| `relation "bookings" does not exist` | Tenant query outside `tenantTx` | Use the OTA `TenantTx.run` / `tenantTx`; never set `search_path` |
| `SearchPathLeakError` | A session-level `SET search_path` on a pooled connection | Find and remove it (CI guards grep for it outside `packages/db`) |
| `InvalidTenantSchemaError` | Schema name not `tenant_<2–40 chars>` | Use the resolved tenant's `schema_name` |
| `migrate.js` exit 2 | A merged migration file was edited | Restore it; put the change in a new file |
| `migrate.js tenants` exit 3 | More than 10 % of schemas failed | Read the report's `failed[]` (file, SQLSTATE) |
| `permission denied for table …` as the OTA role | Read grant missing | `pnpm db:migrate` (re-applies `R__ota_read_access.sql`) |
| Stale types after a contract or migration change | Generated files not rebuilt | `pnpm contracts:generate`, `pnpm db:codegen`, `pnpm build` |
| Integration tests hang | PostgreSQL/Redis/Mailpit down or `TEST_DATABASE_ADMIN_URL` wrong | `pg_isready`, `REDISCLI_AUTH=dev_redis redis-cli ping`, Mailpit at :8025 |
| `MailpitError … ECONNREFUSED` | Mailpit not running | `mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025` |
| `port 3000 (portal) is in use` (e2e) | `pnpm dev` or another run | Stop it; one e2e run per machine |
| `Project(s) "storefront" not found` | Project needs the OTA stack | `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront` |
| Stub `401` 38190 | Token from another/restarted stub | Request a new token |
| Stub `400` 90001 | Misspelt `X-Stub-Scenario` | Use a name from the list above |
| `reference.load_failed` with `42501` | Loader ran as `velexis_ota_app` | `DATABASE_URL` must be the platform role |
| `fetch.mjs --check` fails on SHA-256 | A CSV was edited by hand | Revert; use `data/overrides.csv` |
