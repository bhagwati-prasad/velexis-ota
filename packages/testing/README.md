# `@velexis/testing`

Shared test support for every package and app ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md), [ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md)):

- **test databases**: one migrated template database per Vitest run, cloned once per test file, with `tenant_alpha` and `tenant_beta` for isolation tests;
- **Redis**: one database per Vitest worker, emptied when a file starts;
- **`FakeClock`**, the clock tests inject instead of the backends' `Clock`;
- **`defineBuilder`**, typed factories for test rows and payloads;
- **`expectResponseToMatch`**, the OpenAPI response check of every integration test that calls an endpoint ([ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md));
- **Mailpit** (`@velexis/testing/mailpit`): `waitForMessage`, `uniqueEmail` and `extractLinks` over Mailpit's API, for the e-mails the code under test sends ([ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md) "E-mail", [ADR-0017](../../docs/mvp/adr/0017-email-documents-storage.md));
- **Amadeus stub** (`@velexis/testing/amadeus`): `startAmadeusStub` runs the stub of [`tools/amadeus-stub`](../../tools/amadeus-stub/README.md) in the test's own process on a free port, and `stubScenario` builds the header that picks a scenario ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md) item 5).

> **devDependency only.** List `@velexis/testing` under `devDependencies`, never under `dependencies` or `peerDependencies` ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md) item 2). [`tools/ci/check-package-json.mjs`](../../tools/ci/check-package-json.mjs) fails CI otherwise (X-019), and `pnpm deploy --prod` would leave it out of a release anyway. Nothing in an app's `src/` outside its tests may import it.

| Part | Task | State |
|---|---|---|
| Test databases, Redis, `FakeClock`, builders, `expectResponseToMatch`, the Vitest global setup, [`deploy/postgres/schemas.sql`](../../deploy/postgres/schemas.sql) | [X-015](../../docs/mvp/plans/foundation-tasks.md) | Done (this page) |
| `@velexis/testing/mailpit` | [X-025](../../docs/mvp/plans/foundation-tasks.md) | Done (this page) |
| `@velexis/testing/amadeus` (starts `tools/amadeus-stub` in-process) | [X-027](../../docs/mvp/plans/foundation-tasks.md) | Done (this page) |
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

## Mailpit: `@velexis/testing/mailpit`

Development and CI send e-mail to [Mailpit](https://mailpit.axllent.org/) (SMTP on `127.0.0.1:1025`, UI and API on `:8025`; [`local-development.md`](../../docs/mvp/local-development.md) §4). Integration and end-to-end tests read what the code under test sent through Mailpit's API v1 at `MAILPIT_API_URL`, with `fetch` only ([ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md) "E-mail"):

```ts
import { extractLinks, mailpit, uniqueEmail } from "@velexis/testing/mailpit";

it("sends the verification e-mail", async () => {
  const email = uniqueEmail("signup");                                  // signup+<uuid>@example.com
  await request(app.server).post("/v1/auth/sign-up").send({ email, password });
  const message = await mailpit.waitForMessage({ to: email, subject: /Verify/ });
  const [link] = extractLinks(message).filter((url) => url.includes("/verify-email"));
  expect(link).toBeDefined();
});
```

**One recipient per test.** Test files run in parallel against one Mailpit, and other runs (another checkout, another agent, the end-to-end suite) may share it. Every test sends to its own `uniqueEmail(label)` address and looks for mail by that address only, so it never reads another test's e-mail. Nothing in a test empties Mailpit: `clear()` would delete the other files' mail while they wait for it.

| Export | Does |
|---|---|
| `mailpit.waitForMessage({ to, subject, timeoutMs = 5000 })` (also exported as `waitForMessage`) | Checks Mailpit at once, then every 100 ms, until a message to `to` with `subject` is there, and returns the newest such message in full (`get`). No fixed sleep: it returns as soon as the message is there. After `timeoutMs` it throws a `MailpitTimeoutError` that lists the messages to `to` it did see (subject, time and ID; never the content) |
| `mailpit.search({ to, subject })` | `GET /api/v1/search?query=…`: the matching messages (headers and a snippet), the newest first, at most 50 |
| `mailpit.get(id)` | `GET /api/v1/message/{id}`: the whole message, with `Text` and `HTML` (Mailpit marks it read) |
| `mailpit.clear()` | `DELETE /api/v1/messages`: **every** message in that Mailpit. For a manual reset or a suite that runs alone, never in a test file that runs next to others |
| `uniqueEmail(label)` | `label+<uuid>@example.com`. The label (1 to 27 of `a-z`, `0-9`, `.`, `_`, `-`, starting and ending with a letter or a digit, no `..`; lower case, so a backend that lower-cases addresses keeps them equal) shows in Mailpit's UI what the address was for. `example.com` is reserved (RFC 2606) |
| `extractLinks(message)` | The `href`s of the `<a>` elements of the HTML part (character references such as `&amp;` decoded), then the `http(s)` URLs of the text part (without the `.`, `,`, `)` … that end a sentence), each once, in that order |
| `createMailpitClient({ apiUrl, fetch, timer })` | A client for another Mailpit; `fetch` and `timer` are for unit tests |

How it matches:

- **`to`** is a recipient in the To header, compared in full and case-insensitively. Mailpit's own `to:` search matches a substring (`to:a@example.com` also finds `aa@example.com`), so the client sends `to:"…"` to narrow the list and then keeps the exact matches. Cc and Bcc recipients are not searched; `waitForMessage` requires `to`. Each check of `waitForMessage` reads the newest 50 messages to `to` only, which a `uniqueEmail` address never exceeds.
- **`subject`**: a string must equal the decoded subject; a `RegExp` must match it (the `g` and `y` flags are ignored, so a pattern reused across checks still matches). A string goes to Mailpit as `subject:"…"` (its longest part without a double quote); a `RegExp` is matched in the client only, so `search` needs `to` or a string `subject`.
- Messages are `MailpitMessageSummary` (search) and `MailpitMessage` (get), with Mailpit's field names (`ID`, `MessageID`, `From`, `To`, `Subject`, `Created`, `Text`, `HTML`, …). The lists Mailpit sends as `null` when empty (`To`, `Cc`, `Bcc`, `ReplyTo`, `Tags`) are empty arrays.

A timeout reads:

```text
waitForMessage: no message to signup+0d3c…@example.com with a subject matching /Verify/ arrived within 5000 ms (Mailpit at http://127.0.0.1:8025, 51 checks).
Messages to that address it did see (1):
  - "Welcome to Velexis", received 2026-10-14T06:37:57.896Z, ID ZVXC4iXLkfGYhmpVxh7K2w
```

Other failures throw a `MailpitError` that names the call and the cause: Mailpit not running (`ECONNREFUSED`, with a pointer to `local-development.md` §4), no answer within 5 s, an error status, or an answer that is not Mailpit's (`MAILPIT_API_URL` pointing at the SMTP port, for example). A user and password in `MAILPIT_API_URL` (Mailpit's `--ui-auth-file`) are sent as a Basic `Authorization` header and never appear in `apiUrl` or in an error; a path (`--webroot`) is kept.

`waitForMessage` waits in real time: it keeps the real `setTimeout` and `performance.now` from when the module loads, so a test that turned on `vi.useFakeTimers()` does not stall it. Mailpit tags every message sent to a `+` address with the part after the `+` (plus-address tags); the UUID tags of `uniqueEmail` are harmless.

## Amadeus stub: `@velexis/testing/amadeus`

Tests never call Amadeus ([ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md) "Amadeus stub server"). They start the stub of [`tools/amadeus-stub`](../../tools/amadeus-stub/README.md) (`@velexis/amadeus-stub`) in their own process, on a free port of `127.0.0.1`, and point the code under test at it. The stub validates every request against the Amadeus specifications, issues tokens and answers from fixtures; its README lists the routes, scenarios and error codes.

```ts
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";

let stub: AmadeusStub;
beforeAll(async () => {
  stub = await startAmadeusStub();                                 // http://127.0.0.1:<free port>, well under 1 s
  app = await startApi({ env: { AMADEUS_BASE_URL_TEST: stub.url } });
});
afterAll(async () => {
  await app.close();
  await stub.stop();                                               // frees the port
});

it("maps an Amadeus server error", async () => {
  // The OTA backend's Amadeus client forwards X-Stub-Scenario outside production (OBE-018).
  await request(app.server).post("/v1/flight-searches").set(stubScenario("server-error")).send(simpleSearch);
  expect(stub.requests().at(-1)).toMatchObject({ operation: "getFlightOffers", scenario: "server-error", status: 500 });
});
```

| Export | Does |
|---|---|
| `startAmadeusStub({ port = 0, defaultScenario, credentials, clock, timers })` | Starts the stub (`createStubServer` of `@velexis/amadeus-stub`) and resolves when it listens. `port: 0` (the default) picks a free port, so test files run in parallel. The other options go to the stub unchanged: `defaultScenario` (default `success`), `credentials` (only this `{ clientId, clientSecret }` gets a token; default any non-empty pair), `clock` (token expiry and `receivedAt`; the `FakeClock` above fits) and `timers` (the `timeout` scenario's 30 s hold, so a test fires it itself) |
| `stub.url`, `stub.port` | `http://127.0.0.1:<port>`: the value of `AMADEUS_BASE_URL_TEST` for the code under test (any dummy client id and secret works) |
| `stub.requests()` | The recorded requests, oldest first, at most the last 1000 (`AmadeusStubRequest`): `method`, `path` (no query string), `query`, `headers` (lower-case names; `authorization`, `proxy-authorization` and `cookie` are `[REDACTED]`), `operation` (`oauth2Token`, the `AmadeusClient` method name such as `getFlightOffers`, or `undefined` for a 404), `scenario`, `status` (`undefined` while held or when the client went away), `receivedAt`, `durationMs`. Bodies are never recorded, so a client secret or a token never lands in a test's output. `stub.clearRequests()` empties it |
| `stub.setDefaultScenario(name)` | The scenario of every request without the header from now on, token requests included; `"success"` goes back to normal |
| `stub.stop()` | Stops listening, drops the responses the `timeout` scenario holds and every open connection, and resolves when the port is free. Idempotent. Call it in `afterAll`; a stub left running keeps its port until the worker exits |
| `stubScenario(name)` | `{ "X-Stub-Scenario": name }` for `fetch` headers or Supertest's `.set()`. `name` is the stub's `StubScenario` (`success`, `server-error`, `rate-limited`, `timeout`, and `sold-out` and `price-changed` of pricing and upsell since OBE-019; OBE-041 adds the order scenarios), so a misspelt name does not compile, and throws a `TypeError` at run time |
| `STUB_SCENARIOS`, `SCENARIO_HEADER`, `OAUTH_TOKEN_PATH`, `TOKEN_OPERATION`, `TOKEN_EXPIRES_IN`, `TIMEOUT_HOLD_MS`, `NO_OFFERS_DESTINATION`, and the types `StubScenario`, `StubCredentials`, `StubClock`, `StubTimers` | Re-exported from the stub, so a package that uses `@velexis/testing/amadeus` does not list `@velexis/amadeus-stub` itself |

Each stub has its own tokens, request log and default scenario: a token of one stub is `401` (code 38190) at another, as a revoked token would be at Amadeus. A header beats the default scenario, so `stubScenario("success")` lets one request opt out of `setDefaultScenario("rate-limited")`. Code under test that does not forward the header (the platform's credential check of PBE-020, for example) is driven with `setDefaultScenario` instead.

`@velexis/amadeus-stub` is a **devDependency** of this package ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md) item 2; [`tools/ci/check-package-json.mjs`](../../tools/ci/check-package-json.mjs) enforces it), like `@velexis/testing` is of its users. pnpm installs the dev dependencies of every workspace package, so `@velexis/testing/amadeus` finds the stub through this package's own `node_modules`. Turborepo builds the stub before this package (`^build`). The stub loads the specifications of `docs/amadeus-api/` once per process, on the first `startAmadeusStub`.

## Environment

| Variable | Used by | From |
|---|---|---|
| `TEST_DATABASE_ADMIN_URL` | the global setup, `createTestDatabase`, `drop()` | the environment (CI services), else the `.env.local` files of the package under test and of the repository root (`loadDevEnvFiles`, never in production) |
| `REDIS_URL` | `useRedis` | the same |
| `MAILPIT_API_URL` | `mailpit` and `waitForMessage`, read on first use (`http://127.0.0.1:8025` in the root `.env.example`) | the same |
| `SMTP_URL` | this package's Mailpit integration tests, which send with nodemailer (`smtp://127.0.0.1:1025`) | the same |
| `VITEST_POOL_ID` | `useRedis` | set by Vitest in every worker |

All are read through [`@velexis/config`](../config/README.md); values are never printed. Turborepo passes all but `VITEST_POOL_ID` through to `pnpm test:int` (`turbo.json`). The role passwords are not variables: see the table above.

## Commands

| Command | Does |
|---|---|
| `pnpm --filter @velexis/testing build` | `tsc -b` to `dist/` |
| `pnpm --filter @velexis/testing test` | Unit tests (no PostgreSQL, Redis or Mailpit): the response check on the OTA document and on fixtures, `schemas.sql`, roles, clock, builders, Redis indexes, the Mailpit client against a fake Mailpit and a fake timer |
| `pnpm --filter @velexis/testing test:int` | Integration tests on PostgreSQL 16, Redis 7, Mailpit and the in-process Amadeus stub (`vitest.int.config.ts`, with the package's own global setup). Build the workspace first (`pnpm build`): the tests load `@velexis/db` and `@velexis/amadeus-stub` from their `dist/` (`pnpm test:int` at the root builds them through Turborepo) |
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

The integration config runs the files in parallel in four forked workers, always four (`minForks` = `maxForks`): each file gets a fresh fork, and when a file ends Tinypool starts a new fork only while there are fewer forks than `minForks` or than queued files, busy forks included. With `minForks: 2`, the fast files could end while two files waited for their queued partners (two busy forks, two queued files), so no fork was started until the waiting files gave up (found with X-027's sixth file). The barrier waits at most 60 s for the other file, so run the two `test-database` files together (`pnpm test:int` does).

## Tests of X-025

| Acceptance criterion | Test |
|---|---|
| AC1: an integration test sends one e-mail with `nodemailer` to Mailpit and finds it with `waitForMessage` by recipient and subject regex, with its verification link extracted | [`mailpit.int.test.ts`](test/integration/mailpit.int.test.ts) `finds an e-mail sent with nodemailer by recipient and subject regex, with its link`: nodemailer to `SMTP_URL`, `waitForMessage({ to: uniqueEmail("verify"), subject: /^Verify your e-mail/ })` returns the e-mail with nodemailer's Message-ID, and `extractLinks` gives the link of the HTML and text parts once; `search` and `get` find the same e-mail |
| AC2: `waitForMessage` for a recipient that never gets mail fails after the timeout with a readable message | [`mailpit.int.test.ts`](test/integration/mailpit.int.test.ts): `fails after the timeout with a readable message for a recipient that never gets mail` (a `MailpitTimeoutError` after 300 ms, not before, with the message above) and `lists the messages to the recipient that it did see when none has the subject`; [`mailpit.test.ts`](src/mailpit.test.ts) checks the exact message, the 100 ms polling, the default 5 s and the last wait cut to the deadline on a fake timer |
| AC3: two parallel test files using `uniqueEmail` never see each other's messages | [`mailpit.int.test.ts`](test/integration/mailpit.int.test.ts) and [`mailpit-parallel.int.test.ts`](test/integration/mailpit-parallel.int.test.ts): each file sends to its own `uniqueEmail("parallel")` address with the **same** subject, waits until the other file's e-mail is in Mailpit too (the subject carries the run id, so Mailpit is the meeting point and the files provably run at the same time; [`mailpit-isolation.ts`](test/integration/mailpit-isolation.ts)), and then finds only its own e-mail by its address, with `waitForMessage` and `search` |

The unit tests ([`mailpit.test.ts`](src/mailpit.test.ts)) also cover the exact recipient and subject matching over Mailpit's substring search, the query and path of each call, credentials and `--webroot` in the URL, the errors for a Mailpit that is down, slow or not Mailpit, `uniqueEmail`'s labels, `extractLinks` on every way of writing a link, `waitForMessage` under `vi.useFakeTimers()`, and the `./mailpit` export. Like the `test-database` files, run the two `mailpit` files together: each waits at most 60 s for the other (`pnpm test:int` does).

## Tests of X-027

| Acceptance criterion | Test |
|---|---|
| AC1: an integration test starts the stub on a random port, gets a token, runs a search with and without `stubScenario("server-error")`, and asserts on `requests()` | [`amadeus.int.test.ts`](test/integration/amadeus.int.test.ts) `starts the stub on a random port, gets a token and searches with and without stubScenario("server-error"), asserting on requests()`: `startAmadeusStub()` on port 0, a client-credentials token, `GET /v2/shopping/flight-offers` answered `200` with two offers (`max=2`), the same search with `stubScenario("server-error")` answered `500` code 141, and `requests()` holding the three requests with method, path, query, redacted `authorization`, the scenario header, operation, scenario and status, and neither the token nor the client secret |
| AC2: `stop()` frees the port, so the same test can run twice in one process | [`amadeus.int.test.ts`](test/integration/amadeus.int.test.ts) `stop() frees the port, so the same test runs twice in one process`: runs the AC1 steps, holds a token request with the `timeout` scenario, stops (twice: idempotent), sees the held request dropped, nothing listening and the port free (a plain `net` server listens on it), then runs the AC1 steps again on a new stub on **that** port, where the first stub's token is `401` code 38190, and stops it too |

The same file also checks `setDefaultScenario` (token requests included, and the header winning), that `defaultScenario`, `credentials`, `clock` (token expiry on a `FakeClock`, code 38192) and `timers` (a manual timer fires the 30 s hold, `504`) reach the stub, `stubScenario` for every scenario (a misspelt name fails `tsc` through `@ts-expect-error`, and throws at run time), the `./amadeus` export, the re-exported names, and that the stub is a devDependency only.

## Dependencies

| Package | Version | Why |
|---|---|---|
| `@velexis/config`, `@velexis/db`, `@velexis/api-types` | workspace | Environment, the migration runner and `tenantTx`, the typed `operationId`s |
| `pg` | 8.23.1 | Creating, cloning and dropping databases (as in `@velexis/db`) |
| `ioredis` | 5.11.1 | `useRedis` (as in the backends, [`tech-stack.md`](../../docs/mvp/tech-stack.md)) |
| `ajv`, `ajv-formats` | 8.20.0, 3.0.1 | Response validation ([`tech-stack.md`](../../docs/mvp/tech-stack.md) §2, ADR-0006) |
| `yaml` | 2.9.1 | Parsing the OpenAPI documents |
| `vitest` | 3.2.7 (peer and dev) | `inject` for the template's name. A peer, so the test files and this package share one Vitest; it is ESM-only, so this CommonJS package loads it with `import()` |
| `@velexis/amadeus-stub` | workspace (dev) | The Amadeus stub that `@velexis/testing/amadeus` starts ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md) item 5); a devDependency only (item 2) |
| `nodemailer`, `@types/nodemailer` | 6.10.1, 6.4.24 (dev) | Sending the e-mails of this package's Mailpit integration tests, as the backends send theirs ([`tech-stack.md`](../../docs/mvp/tech-stack.md): `nodemailer` 6.x). `@velexis/testing/mailpit` itself needs no library: Node's `fetch` |
