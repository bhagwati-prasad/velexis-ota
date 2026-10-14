# `@velexis/testing`

Shared test support for every package and app ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md), [ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md)):

- **test databases**: one migrated template database per Vitest run, cloned once per test file, with `tenant_alpha` and `tenant_beta` for isolation tests;
- **Redis**: one database per Vitest worker, emptied when a file starts;
- **`FakeClock`**, the clock tests inject instead of the backends' `Clock`;
- **`defineBuilder`**, typed factories for test rows and payloads;
- **`expectResponseToMatch`**, the OpenAPI response check of every integration test that calls an endpoint ([ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md)).

> **devDependency only.** List `@velexis/testing` under `devDependencies`, never under `dependencies` or `peerDependencies` ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md) item 2). [`tools/ci/check-package-json.mjs`](../../tools/ci/check-package-json.mjs) fails CI otherwise (X-019), and `pnpm deploy --prod` would leave it out of a release anyway. Nothing in an app's `src/` outside its tests may import it.

| Part | Task | State |
|---|---|---|
| Test databases, Redis, `FakeClock`, builders, `expectResponseToMatch`, the Vitest global setup, [`deploy/postgres/schemas.sql`](../../deploy/postgres/schemas.sql) | [X-015](../../docs/mvp/plans/foundation-tasks.md) | Done (this page) |
| `@velexis/testing/mailpit` | X-025 | Not yet |
| `@velexis/testing/amadeus` (starts `tools/amadeus-stub` in-process) | X-027 | Not yet |
| `@velexis/testing/stripe` (signed webhook events) | X-028 | Not yet |

## Use it in a package or app

```jsonc
// package.json
"devDependencies": { "@velexis/testing": "workspace:*" },
"scripts": { "test:int": "vitest run --config vitest.int.config.ts" }
```

```ts
// vitest.int.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.int.test.ts"],
    globalSetup: ["@velexis/testing/vitest-global-setup"], // builds the template once per run
  },
});
```

```ts
// test/integration/bookings.int.test.ts
import { createTestDatabase, expectResponseToMatch, FakeClock, useRedis,
         type TestDatabase, type TestRedis } from "@velexis/testing";

let db: TestDatabase;
let redis: TestRedis;
beforeAll(async () => {
  db = await createTestDatabase();   // this file's own clone, well under 1 s
  redis = await useRedis();          // this worker's Redis database, flushed
  app = await startApi({ env: { DATABASE_URL: db.urlFor("ota"), REDIS_URL: redis.url } });
});
afterAll(async () => {
  await app.close();
  await redis.close();
  await db.drop();                   // also works while pools are still open
});

it("returns the booking", async () => {
  const res = await request(app.server).get(`/v1/bookings/${id}`).set(headers);
  expectResponseToMatch("getBooking", res); // status and body against the OTA document
});
```

The packages of this repository are CommonJS, so test files have no top-level `await`: create databases and Redis clients in `beforeAll`. `@velexis/testing` is built to `dist/` like every package; Turborepo builds it before the tests of the packages that depend on it.

## Test databases

```ts
const db = await createTestDatabase();
db.name;               // "velexis_test_<runId>_<random>"
db.urlFor("ota");      // DSN of velexis_ota_app on this database; also "migrator", "provisioner", "platform"
await db.drop();       // DROP DATABASE … WITH (FORCE); idempotent
```

### The template (once per run)

`@velexis/testing/vitest-global-setup` runs once per Vitest run, in the main process, and builds `velexis_test_tpl_<runId>` as `TEST_DATABASE_ADMIN_URL` (role `velexis_test_admin`: `LOGIN CREATEDB`, member of `velexis_migrator`, created by [`dev-setup.sh`](../../deploy/scripts/dev-setup.sh) and the CI bootstrap, never on the VM):

1. `CREATE DATABASE … OWNER velexis_migrator` (UTF-8, `C.UTF-8`, from `template0`) with the database-level grants of [`bootstrap.sql`](../../deploy/postgres/bootstrap.sql): nothing for `PUBLIC`, `CONNECT` and `TEMPORARY` for `velexis_platform_app` and `velexis_ota_app`, `CREATE` as well for `velexis_provisioner`, everything for `velexis_migrator`;
2. [`deploy/postgres/schemas.sql`](../../deploy/postgres/schemas.sql) as `velexis_migrator`: `public` closed, the `platform` and `reference` schemas, their `USAGE` grants and default privileges;
3. the platform and reference sets with `runMigrations`, and `tenant_alpha` and `tenant_beta` with `migrateTenantSchema({ create: true })`: the real runner of [`@velexis/db/migrate`](../db/README.md), as `velexis_migrator`, from `platform/backend/migrations/` and `ota/backend/migrations/tenant/`;
4. the reference fixture `REFERENCE_FIXTURE` as `velexis_platform_app` (the role of `pnpm db:seed:reference`): 3 currencies (EUR, GBP, USD), 3 countries (FR, GB, US), 5 airports (CDG, ORY, LHR, JFK, LAX) and 3 airlines (AF, BA, AA). Cities and time zones stay empty, so `city_code` and `time_zone` are `NULL`.

It provides the template's name to the test files with Vitest's `provide` and `inject`. When the run ends it drops the clones of this run that are still there (`velexis_test_<runId>_*`, left by a test file that crashed before its `afterAll`; `dropRunClones`), then the template. Building it takes about 1 s locally.

### One clone per test file

`createTestDatabase()` runs `CREATE DATABASE velexis_test_<runId>_<random> TEMPLATE velexis_test_tpl_<runId> OWNER velexis_migrator` and then the database-level grants again: PostgreSQL copies everything **inside** a database (schemas, tables, rows, grants, default privileges) but not the database's own ACL (`pg_database.datacl`), which a clone gets as the default, where `PUBLIC` may connect. A clone takes 0.1 to 0.4 s locally (16 MB, `STRATEGY WAL_LOG`, the default), so test files run in parallel, each on its own data.

`urlFor(role)` takes host and port from `TEST_DATABASE_ADMIN_URL` and the login from [`src/roles.ts`](src/roles.ts):

| Role | User | Password (test-only) | Same as |
|---|---|---|---|
| `migrator` | `velexis_migrator` | `dev_migrator` | `DATABASE_MIGRATOR_URL` of the root `.env.example` |
| `provisioner` | `velexis_provisioner` | `dev_provisioner` | `DATABASE_PROVISIONER_URL` of the root `.env.example` |
| `platform` | `velexis_platform_app` | `dev_platform` | `DATABASE_URL` of `platform/backend/.env.example` |
| `ota` | `velexis_ota_app` | `dev_ota` | `DATABASE_URL` of `ota/backend/.env.example` |

These are the development values that `dev-setup.sh` and the CI bootstrap set, never production passwords ([ADR-0010](../../docs/mvp/adr/0010-secrets-envelope-encryption.md)); `roles.test.ts` fails when they and the `.env.example` files differ. The URLs carry the password: never log them.

### `drop()` with connections still open

`velexis_test_admin` may terminate only the sessions of roles it is a member of (`velexis_migrator`, and through it `velexis_provisioner`), not those of `velexis_platform_app` or `velexis_ota_app`: `DROP DATABASE … WITH (FORCE)` alone would fail with `permission denied to terminate process` while an app pool is open. `drop()` (and `dropDatabase(adminUrl, name)`) therefore:

1. sets `ALLOW_CONNECTIONS false`, so pools cannot reconnect;
2. logs in as each app role that still has sessions there (to the maintenance database of `TEST_DATABASE_ADMIN_URL`, `postgres`) and terminates that role's own sessions, which every role may do, waiting until each has exited (`pg_terminate_backend(pid, 5000)`): `WITH (FORCE)` refuses while a session it may not signal is still listed, even one that is already exiting;
3. runs `DROP DATABASE … WITH (FORCE)`, which ends the remaining sessions and waits for them;
4. retries a few times, after a short pause, if a session slipped in meanwhile.

Close your pools first when you can; `drop()` copes when you cannot (a failed test, a pool held by the app under test).

### After an interrupted run

A run stopped with Ctrl-C may leave `velexis_test_*` databases behind, because the teardown never ran (a test file that crashed is covered: the teardown drops its clone). They are harmless; to remove them:

```bash
psql "$TEST_DATABASE_ADMIN_URL" -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'velexis\_test\_%'"
psql "$TEST_DATABASE_ADMIN_URL" -c 'DROP DATABASE "velexis_test_…" WITH (FORCE)'   # one by one, when no run is active
```

### `deploy/postgres/schemas.sql`

The in-database part of [`bootstrap.sql`](../../deploy/postgres/bootstrap.sql), from `REVOKE ALL ON SCHEMA public FROM PUBLIC;` to the end, byte for byte and without psql meta-commands. `bootstrap.sql` stays whole because [`provision-vm.sh`](../../deploy/scripts/provision-vm.sh) feeds it to psql on stdin, where `\ir schemas.sql` would not resolve. [`src/schemas-sql.test.ts`](src/schemas-sql.test.ts) fails when `bootstrap.sql` does not end with `schemas.sql` verbatim, when `bootstrap.sql` has a statement after `\connect :db_name` that `schemas.sql` lacks, or when `schemas.sql` holds a meta-command or a psql variable. **Change both files in the same commit.**

## Redis

```ts
const redis = await useRedis();
redis.db;       // 1 + (VITEST_POOL_ID % 15): 1 to 15, never 0 (the developer's pnpm dev)
redis.url;      // REDIS_URL with that database as its path, for the code under test
redis.client;   // a connected ioredis client on that database
await redis.close();
```

`useRedis()` runs `FLUSHDB` when it connects, so call it once per test file, in `beforeAll`. A Vitest worker runs its files one after another, so two files never share a database at the same time (up to 15 workers). Other test runs on the same Redis server (another checkout, another agent) use the same 15 databases: keep Redis assertions to what the file itself wrote.

## `FakeClock`

```ts
const clock = new FakeClock();                  // 2026-01-15T10:00:00.000Z, or new FakeClock("2026-10-12T09:00:00Z")
clock.now();                                    // a new Date, the same instant until the clock moves
clock.advance(15 * 60 * 1000);                  // forward only; returns the new instant
clock.set("2026-12-24T18:00:00Z");              // jump, forwards or backwards
Test.createTestingModule({ ... }).overrideProvider(Clock).useValue(clock);
```

It has the shape of the backends' injectable `Clock` (`now(): Date`, [conventions §2](../../docs/mvp/conventions.md)), so expiry, deadlines and retries are tested without waiting. It does not touch Vitest's fake timers; use `vi.useFakeTimers()` for code that waits on `setTimeout`.

## `defineBuilder`

```ts
const buildPlan = defineBuilder<PlanRow>((n) => ({ code: `plan_${n}`, name: `Plan ${n}`, monthly_price: "10.00" }));
buildPlan();                                   // { code: "plan_1", ... }
buildPlan({ name: "Starter" });                // shallow overrides; code "plan_2"
buildPlan((n) => ({ code: `custom_${n}` }));   // overrides from the sequence number
buildPlan.many(3);                             // three rows, plan_4 to plan_6
buildPlan.reset();                             // the sequence starts at 1 again
```

Defaults are a value (deep-copied with `structuredClone` on every build) or a function of the sequence number. Builders only build values; inserting them, as the right role and through `tenantTx` for tenant tables, is the test's job.

## `expectResponseToMatch`

```ts
expectResponseToMatch("getBooking", res);                         // OTA document (default)
expectResponseToMatch("listPlans", res, { document: "platform" }); // platform document (from M1)
```

`res` is anything with `status` and `body`: a Supertest response, or `{ status, body }` built from `fetch`. It throws `ResponseMismatchError` unless:

1. **the status is documented** for the operation: the exact code, else its range (`4XX`), else `default`;
2. **the body matches** that response:
   - a response documented without `content` must have no body (`undefined`, `null`, `""` or `{}`, which Supertest gives for an empty body);
   - otherwise the body of the `application/json` (or `…+json`) content must validate against its schema. Content without a JSON media type (a PDF download) cannot be checked this way, and says so.

The message names the operation, the status and every failing path, without the failing values (a body may hold personal data or tokens):

```text
getBooking (GET /v1/bookings/{bookingId}): the 200 response does not match the OTA document, 26 problems:
  - /id: required property is missing
  - /reference: required property is missing
  …
```

The error's `problems` lists every `{ path, keyword, message }`; the message shows the first 40. The `operationId` argument is typed (`OtaOperationId`, `PlatformOperationId` from `@velexis/api-types/operations`), so a misspelt id does not compile.

How it validates:

- The documents are read from the repository ([`ota/backend/openapi/`](../../ota/backend/openapi/), and `platform/backend/openapi/` once the platform plan creates it in M1), the paths that [`packages/api-types/redocly.yaml`](../api-types/redocly.yaml) lists, and parsed once per process (about 0.5 s for the OTA document).
- OpenAPI 3.1 schemas are JSON Schema draft 2020-12: **Ajv 2020** with **ajv-formats** (all formats; `date-time` requires an offset, RFC 3339). `components.schemas` becomes the `$defs` of one Ajv schema, the `#/components/schemas/` references are rewritten to it, and each response schema is compiled once, on first use.
- Ajv runs in **strict mode** for unknown keywords, so a misspelt keyword in a document fails the check instead of being ignored. The OpenAPI annotations `discriminator`, `example`, `xml` and `externalDocs` and every `x-*` extension are declared as annotation keywords. `strictTypes` and `strictRequired` are off: they judge how a schema is written (`properties` without `type: object`, `required` in another `allOf` branch), not what it accepts, and the schemas copied from the Amadeus specifications use both.
- `createResponseChecker(document, { label })` builds the same checker for any parsed OpenAPI 3.1 document (fixtures, tools), and `responseChecker("ota")` returns the cached one.

**Known document issue:** the Amadeus schemas of the OTA document declare local date-times such as `2026-11-01T10:00:00` (no offset, as Amadeus sends them) as `format: date-time`, which RFC 3339 and ajv-formats reject. Twelve examples of the document fail for that reason (`getFlightOffer`, `priceFlightOffers`, `getPricedOffer`, `consoleFindBookingByRecordLocator`, `consoleListQueue`, …), and so will real responses with those fields. The fix belongs in the document, not in this check.

## Environment

| Variable | Used by | From |
|---|---|---|
| `TEST_DATABASE_ADMIN_URL` | the global setup, `createTestDatabase`, `drop()` | the environment (CI services), else the `.env.local` files of the package under test and of the repository root (`loadDevEnvFiles`, never in production) |
| `REDIS_URL` | `useRedis` | the same |
| `VITEST_POOL_ID` | `useRedis` | set by Vitest in every worker |

All are read through [`@velexis/config`](../config/README.md); values are never printed. Turborepo passes the first two through to `pnpm test:int` (`turbo.json`). The role passwords are not variables: see the table above.

## Commands

| Command | Does |
|---|---|
| `pnpm --filter @velexis/testing build` | `tsc -b` to `dist/` |
| `pnpm --filter @velexis/testing test` | Unit tests (no PostgreSQL or Redis): the response check on the OTA document and on fixtures, `schemas.sql`, roles, clock, builders, Redis indexes |
| `pnpm --filter @velexis/testing test:int` | Integration tests on PostgreSQL 16 and Redis 7 (`vitest.int.config.ts`, with the package's own global setup) |
| `pnpm --filter @velexis/testing typecheck` / `lint` | `tsc --noEmit` (sources and `test/`) / ESLint |

`turbo.json` gives this package's `test` task its own inputs (`@velexis/testing#test`): the OpenAPI documents, `redocly.yaml`, `deploy/postgres/*.sql`, the `.env.example` files and the migration folders, so a change there reruns the tests instead of replaying a cached pass.

## Tests of X-015

| Acceptance criterion | Test |
|---|---|
| AC1: two integration test files running in parallel each get their own database with `tenant_alpha` and `tenant_beta`, and changes in one are invisible to the other | [`test-database.int.test.ts`](test/integration/test-database.int.test.ts) and [`test-database-parallel.int.test.ts`](test/integration/test-database-parallel.int.test.ts): both files clone, write customers into both tenants through `tenantTx` as `velexis_ota_app`, meet at a barrier ([`parallel-isolation.ts`](test/integration/parallel-isolation.ts)) so they provably run at the same time, and each finds only its own rows. Also: the clone's schemas, owners, ledgers and grants, every role's login, and two concurrent clones in one file |
| AC2: the template is built once per run; each clone takes less than 1 s locally | `builds the template once per run and clones it in less than 1 s` (one template per run id; four clones timed) |
| AC3: `drop()` removes the database even while connections are open | `drop() removes the database while connections of every role are open (WITH (FORCE))`: one open session per role, one of them in a transaction |
| AC4: `expectResponseToMatch("getBooking", { status: 200, body: { foo: 1 } })` fails naming the missing required properties | [`openapi-response.test.ts`](src/openapi-response.test.ts): every `required` property of `Booking` is named as `/<property>: required property is missing`; the document's own `BookingExample` passes |
| AC5: `schemas-sql.test.ts` fails when the files differ and passes on the committed files | [`schemas-sql.test.ts`](src/schemas-sql.test.ts): the committed files, then changed, dropped and added statements, comments, whitespace and meta-commands |

The integration config runs the files in parallel in at least two forked workers. The barrier waits at most 60 s for the other file, so run the two `test-database` files together (`pnpm test:int` does).

## Dependencies

| Package | Version | Why |
|---|---|---|
| `@velexis/config`, `@velexis/db`, `@velexis/api-types` | workspace | Environment, the migration runner and `tenantTx`, the typed `operationId`s |
| `pg` | 8.23.1 | Creating, cloning and dropping databases (as in `@velexis/db`) |
| `ioredis` | 5.11.1 | `useRedis` (as in the backends, [`tech-stack.md`](../../docs/mvp/tech-stack.md)) |
| `ajv`, `ajv-formats` | 8.20.0, 3.0.1 | Response validation ([`tech-stack.md`](../../docs/mvp/tech-stack.md) §2, ADR-0006) |
| `yaml` | 2.9.1 | Parsing the OpenAPI documents |
| `vitest` | 3.2.7 (peer and dev) | `inject` for the template's name. A peer, so the test files and this package share one Vitest; it is ESM-only, so this CommonJS package loads it with `import()` |
