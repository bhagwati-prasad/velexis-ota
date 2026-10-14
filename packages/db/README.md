# `@velexis/db`

Data access and tenancy for both backends:

- `pg` pools with the Velexis type parsers;
- `platformDb` for the schema-qualified `platform` and `reference` tables;
- `tenantTx`, the **only** way to reach a tenant schema;
- the migration runner `@velexis/db/migrate` and its CLI `dist/cli/migrate.js`: the `platform` and `reference` sets, one tenant schema (provisioning) and the tenant fan-out;
- the `StorageAdapter` for documents and uploads;
- the table types `PlatformDatabase`, `ReferenceDatabase` and `TenantDatabase`, generated from the migrations by `pnpm db:codegen` (X-014).

Design: [ADR-0004](../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md) (schema per tenant, roles, leak guards), [ADR-0005](../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) (Kysely on `pg`, type parsers, migrations), [ADR-0021](../../docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md) (migration CLI, repeatable grant files), [ADR-0017](../../docs/mvp/adr/0017-email-documents-storage.md) (storage), [db README §4, §5 and §8](../../docs/velexis-sdk/db/README.md).

## Usage

```ts
import { createLogger } from "@velexis/logger";
import { createPlatformDb, createPool, createTenantDb, tenantTx, sql, type Selectable, type TenantDatabase } from "@velexis/db";

const logger = createLogger({ app: "ota-api", env: config.APP_ENV, level: config.LOG_LEVEL });

// One pool per app and role (velexis_ota_app here). The pool belongs to the app: end it once at shutdown.
const pool = createPool(config.DATABASE_URL, { applicationName: "ota-api", logger, max: 20 });

// Platform and reference tables: always schema-qualified (the role default search_path is pg_catalog).
const platformDb = createPlatformDb(pool); // Kysely<PlatformDatabase & ReferenceDatabase>
const tenant = await platformDb
  .selectFrom("platform.tenants")
  .select(["id", "schema_name"])
  .where("id", "=", tenantId)
  .executeTakeFirst();

// Tenant tables: only inside tenantTx. The handle has no query methods of its own.
const tenants = createTenantDb(pool, { appEnv: config.APP_ENV }); // TenantDb<TenantDatabase>
const booking = await tenantTx(
  tenants,
  tenant.schema_name, // from the resolved tenant (cache or platform.tenants), never from user input
  (trx) => trx.selectFrom("bookings").selectAll().where("id", "=", bookingId).executeTakeFirst(),
  { statementTimeoutMs: 5000 }, // the default
);
type Booking = Selectable<TenantDatabase["bookings"]>; // a row: total_amount is a string, created_at a Date

await pool.end(); // at shutdown, once (Kysely's destroy() would end the same pool)
```

The type parameters default to the generated table types ([below](#table-types-pnpm-dbcodegen)); a test may still pass its own interface (`createTenantDb<{ items: Item }>(pool)`).

## API

| Export | What it does |
|---|---|
| `createPool(url, { applicationName, logger, max?, statementTimeoutMs?, idleTimeoutMillis?, connectionTimeoutMillis? })` | A `pg.Pool` with its **own** `types` object (below). The defaults are 10 connections, a session `statement_timeout` of 30 s, 10 s idle and a 10 s wait for a free connection. Errors on idle clients go to `logger.error` (`db.pool.idle_client_error`) instead of stopping the process; the URL is never logged. |
| `createPlatformDb<DB = PlatformDatabase & ReferenceDatabase>(pool)` | `Kysely<DB>` with `PostgresDialect`, for `platform.*` and `reference.*` queries by qualified name. |
| `createTenantDb<DB = TenantDatabase>(pool, { appEnv? })` | An opaque `TenantDb<DB>` handle. The leak guard is on unless `appEnv` is `"production"`. |
| `PlatformDatabase`, `ReferenceDatabase`, `TenantDatabase` | The generated table types ([below](#table-types-pnpm-dbcodegen)). |
| `tenantTx(db, schema, fn, { statementTimeoutMs = 5000 })` | Runs `fn(trx)` in one transaction on `schema` (below). Commits when `fn` resolves, rolls back and rethrows when it throws. |
| `assertTenantSchema(value)`, `isTenantSchema(value)`, `TENANT_SCHEMA_PATTERN`, `InvalidTenantSchemaError`, `TenantSchema` | The schema-name check `^tenant_[a-z][a-z0-9_]{1,39}$` (ADR-0004). |
| `SearchPathLeakError` | Thrown by the leak guard (`searchPath`, `roleDefault`). |
| `createTypeParsers()`, `parseTimestamptz`, `parseDecimalArray`, `PG_TYPE_OID` | The parsers that `createPool` installs, for code that opens its own `pg.Client`. |
| `sql`, `Kysely`, `Transaction`, `Selectable`, `Insertable`, `Updateable` | Re-exported from Kysely, so apps use the same copy. |

## `tenantTx`

Every statement on tenant data runs inside `tenantTx` (ADR-0005; [conventions §12](../../docs/mvp/conventions.md#12-security-checklist-every-pr)):

1. **Validate first.** The schema name must match `^tenant_[a-z][a-z0-9_]{1,39}$`. It is `tenant_` plus the tenant key, which has at least two characters, so `public`, `reference`, `"tenant_a; DROP TABLE x"` and even `tenant_a` are rejected with `InvalidTenantSchemaError` **before a connection is taken**. An invalid `statementTimeoutMs` is rejected the same way.
2. `BEGIN`.
3. **Leak guard** (every environment except production, see below).
4. ``sql`SELECT set_config('search_path', ${schema + ", reference"}, true)` ``: the parameterised form of `SET LOCAL`. The schema name travels as a **bound parameter**, and no identifier is ever concatenated into SQL. `reference` follows the tenant schema, so `reference.*` tables resolve unqualified.
5. The same for `statement_timeout` (default 5000 ms). A slow statement fails with `canceling statement due to statement timeout` and rolls back.
6. `fn(trx)` with a Kysely `Transaction<DB>`; then `COMMIT`, or `ROLLBACK` if `fn` throws.

Both settings end with the transaction. The pooled connection returns to the role default (`search_path = pg_catalog` for `velexis_ota_app`, set by `deploy/postgres/bootstrap.sql`), so an unqualified query outside `tenantTx` fails loudly (`relation "bookings" does not exist`) and never reaches a tenant.

`createTenantDb` returns a handle without query methods: `tenants.selectFrom("bookings")` does not compile. Do not call `tenantTx` inside another `tenantTx`: it would take a second connection, and wait for one when the pool is exhausted. Pass `trx` down instead.

### Leak guard

ADR-0004 forbids session-level `SET search_path` (and `set_config(…, false)`). CI greps for it outside `packages/db`, and the guard catches what the grep cannot see. When `appEnv` is not `production`, the first statement of every `tenantTx` is:

```sql
SELECT current_setting('search_path') AS search_path, reset_val AS role_default
FROM pg_catalog.pg_settings WHERE name = 'search_path'
```

If the two differ, a session-level change survived on that pooled connection. The guard then throws `SearchPathLeakError`, the transaction rolls back, and `fn` never runs. The leaked value stays on the connection, so the next `tenantTx` on it fails too until the code that set it is fixed.

`pg-pool` has no asynchronous `release` hook that could run a query, so the "release hook assertion" of ADR-0004 is made when a connection is next reserved for a tenant transaction. In production the guard is skipped to save a round trip; `set_config(…, true)` still scopes every transaction correctly.

## Type parsers (ADR-0005 item 5)

`createPool` gives each pool a fresh `types` object. The global `pg.types` is never changed, and a global change made by other code to one of the types below (for example `setTypeParser(1700, parseFloat)`) does not reach a Velexis pool. Every other type is read through the global `pg.types`.

| PostgreSQL type | OID | JavaScript |
|---|---|---|
| `numeric` | 1700 | `string`, exactly as PostgreSQL prints it (`"12.30"`); money uses `decimal.js`, never floats |
| `int8` / `bigint` | 20 | `string` (`"9007199254740993"`) |
| `numeric[]`, `int8[]` | 1231, 1016 | arrays of `string` (node-postgres would turn `numeric[]` into floats) |
| `timestamptz` | 1184 | `Date` (milliseconds; `infinity` and values outside the `Date` range fail the query) |
| `jsonb`, `json` | 3802, 114 | parsed with `JSON.parse` |
| everything else | | node-postgres defaults |

## Table types: `pnpm db:codegen`

`src/generated/{platform,reference,tenant}.ts` hold the Kysely table types, generated by [`kysely-codegen`](https://github.com/RobinBlomberg/kysely-codegen) from a freshly migrated database (ADR-0005 Query layer item 2). They are committed. **Never edit them**: add a migration, run `pnpm db:codegen`, commit the result. CI runs `pnpm db:migrate && pnpm db:codegen` and fails on any diff under `src/generated` (X-019).

| Type | Keys | Default of |
|---|---|---|
| `PlatformDatabase` | `platform.<table>`: the platform tables and the ledger `platform.schema_migrations` | `createPlatformDb`, together with `ReferenceDatabase` |
| `ReferenceDatabase` | `reference.<table>`: the reference tables and the ledger | |
| `TenantDatabase` | the tenant tables by unqualified name (`TenantTables`, the ledger included), the reference tables by unqualified name (`ReferenceTables`; a tenant table of the same name wins, as `schema_migrations` does) and the reference tables as `reference.<table>` | `createTenantDb` and `TenantDb` |

`TenantDatabase` is what the `search_path` of `tenantTx` (`<schema>, reference`) resolves. It has no platform table, so `trx.selectFrom("tenants")` and `trx.selectFrom("platform.tenants")` do not compile inside `tenantTx`, and `platformDb.selectFrom("bookings")` does not compile either. Each file also exports its row interfaces (`Bookings`, `PlatformTenants`, …) and kysely-codegen's helpers; use `Selectable<TenantDatabase["bookings"]>`, `Insertable<…>` and `Updateable<…>` rather than importing them. Column types follow the [type parsers](#type-parsers-adr-0005-item-5): `numeric` (`Numeric`) and `int8` (`Int8`) select as `string`, `timestamptz` (`Timestamp`) as `Date`, `jsonb` (`Json`) as parsed JSON. `numeric` is also written as a decimal string only: money is never a JS number ([conventions §1](../../docs/mvp/conventions.md#1-general)), so compute with `decimal.js` and insert `toFixed(2)`.

`pnpm db:codegen` runs `pnpm --filter @velexis/db codegen`: `precodegen` builds the package (`tsc -b`), then [`scripts/codegen.mjs`](scripts/codegen.mjs):

1. As `TEST_DATABASE_ADMIN_URL` (`velexis_test_admin`, from the environment or `.env.local`; the URL is never printed) it creates the scratch database `velexis_codegen_<pid>` with the database options and grants of `deploy/postgres/bootstrap.sql`, and runs the in-database part of `bootstrap.sql` as `velexis_migrator`.
2. With the runner library it applies `platform/backend/migrations/{platform,reference}` (`runMigrations`) and creates the schema `tenant_template` from `ota/backend/migrations/tenant` (`migrateTenantSchema({ create: true })`, as provisioning does).
3. It runs kysely-codegen's Node API once per schema: `platform.*` and `reference.*` keep their qualified names, and `tenant_template` is the default schema of its run, so tenant table names are unqualified.
4. Post-processing: every declaration and every interface member is sorted again by code unit (kysely-codegen sorts with `localeCompare`, which depends on the machine's locale); `Int8`, `Numeric` and `Timestamp` are set to the parser types above (`Numeric` is written as a string only); the `DB` interface is renamed; a "do not edit" header replaces kysely-codegen's. Any other helper type or import (a PostgreSQL enum, `interval`, `point`) fails the run with a message, so a new column type is mapped in the script on purpose. The conventions use `text` + `CHECK` instead of enums ([conventions §9](../../docs/mvp/conventions.md#9-database-migrations)).
5. It drops the scratch database, also when a step failed, then writes each file only when its content changed (`wrote` / `unchanged`). The drop is a plain `DROP DATABASE`, which stops an autovacuum worker busy in the new database; `WITH (FORCE)` is only the fallback for a session still open after PostgreSQL's 5 s wait, because a role without `pg_signal_backend` cannot terminate an autovacuum worker that way ("permission denied to terminate process"). When the drop fails, nothing is written and the message names the database to drop by hand.

The files hold no timestamp, version, database name or local path, so two runs give identical files. `node scripts/codegen.mjs --out <dir>` writes elsewhere (the integration test). `precodegen` compiles all of `src/`, `src/types.test.ts` included, so regenerate first and adapt the type test afterwards: a type test that already expects the new types stops `tsc -b`, and with it `pnpm db:codegen`. It needs PostgreSQL 16 and the roles of `bootstrap.sql` (`deploy/scripts/dev-setup.sh` locally), but not `pnpm db:migrate`: it never touches the development database.

## Migrations: `@velexis/db/migrate` and `migrate.js`

One runner for every caller ([ADR-0021](../../docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md)): `pnpm db:migrate` and `pnpm db:migrate:tenants` locally and in CI, `velexis-deploy` on the VM (`node dist/cli/migrate.js …` from the release's `db/` folder), and the library for `@velexis/testing` and the OTA worker.

```sh
pnpm db:migrate          # builds this package (premigrate: tsc -b), then applies both sets from the repository
pnpm db:migrate:tenants  # builds it, then applies ota/backend/migrations/tenant to every tenant schema
node dist/cli/migrate.js platform --dir ../../platform/backend/migrations/platform
node dist/cli/migrate.js reference --dir ../../platform/backend/migrations/reference
node dist/cli/migrate.js tenants --dir ../../ota/backend/migrations/tenant [--concurrency 4] [--max-failure-ratio 0.1] [--report <file>]
node dist/cli/migrate.js tenant --schema tenant_<key> --dir ../../ota/backend/migrations/tenant [--create]
```

```ts
import { runMigrations, MigrationError } from "@velexis/db/migrate";

const result = await runMigrations({
  set: "platform", // or "reference": the set and the schema of its ledger
  dir: "/opt/velexis/releases/<sha>/migrations/platform",
  url: config.DATABASE_MIGRATOR_URL, // velexis_migrator; never logged
  onFile: (event) => logger.info(event, "db.migrate.file"), // optional: one event per file applied, failed or changed
});
// result: { set, dir, dirExists, applied: MigrationFileEvent[], upToDate, ledgerOnly }
// Throws MigrationFilesError (1), ChecksumMismatchError (2) or MigrationFailedError (1); error.exitCode is the CLI's.
```

The tenant set ([below](#tenant-schemas-migratetenantschema-and-migratetenants)):

```ts
import { migrateTenantSchema, migrateTenants } from "@velexis/db/migrate";

// One schema: OTA provisioning (the worker's DATABASE_PROVISIONER_URL), tests, repairs.
const one = await migrateTenantSchema({
  schema: "tenant_acme", // assertTenantSchema first
  dir: "/opt/velexis/releases/<sha>/migrations/tenant",
  url: config.DATABASE_PROVISIONER_URL, // or DATABASE_MIGRATOR_URL; objects belong to velexis_provisioner either way
  create: true, // create the schema and the grants of velexis_ota_app in the same transaction
  // optional: more work in the same transaction, after the files, before COMMIT (OTA provisioning seeds here)
  beforeCommit: async ({ schema, created, db }) => {
    await seedTenant(db, tenant); // db: Kysely<TenantDatabase> on the runner's connection
  },
});
// one: { schema, dir, dirExists, created, applied: TenantMigrationFileEvent[], upToDate, ledgerOnly }
// Throws TenantSchemaError (1), TenantChecksumMismatchError (2) or TenantMigrationFailedError (1), or what
// beforeCommit threw.

// Every tenant schema: velexis-deploy, `pnpm db:migrate:tenants`.
const all = await migrateTenants({
  dir: "/opt/velexis/releases/<sha>/migrations/tenant",
  url: config.DATABASE_MIGRATOR_URL, // reads platform.tenants
  concurrency: 4, // the defaults
  maxFailureRatio: 0.1,
  report: "/var/lib/velexis/migrate-<sha>.json", // optional
});
// all: { dir, dirExists, report: { target, total, applied, failed, skipped } | null, failureRatio, exitCode: 0 | 3 }
```

### Files

| Kind | Name | Rules |
|---|---|---|
| Numbered | `^\d{4}_[a-z0-9_]+\.sql$`, e.g. `0002_add_tenant_flags.sql` | Applied once, in name order. A duplicated number fails. Starts with `-- velexis:phase expand\|migrate\|contract`, then a one-line `-- description` ([conventions §9](../../docs/mvp/conventions.md#9-database-migrations)). **Never edited once merged**: the checksum makes the next run exit 2. |
| Baseline | `0001_baseline.sql` | A byte-for-byte copy of `docs/velexis-sdk/db/<set>.sql` (X-012), so it has **no** header and counts as `expand`. Its description is the first comment line with text. |
| Repeatable | `^R__[a-z0-9_]+\.sql$`, e.g. `R__ota_read_access.sql` | `platform` and `reference` only. Every statement (comments removed) starts with `GRANT`, `REVOKE` or `COMMENT ON`; anything else is rejected. No phase header (the ledger phase is `repeatable`), no `no-transaction`. Applied after the numbered files whenever its SHA-256 changed, so it **may** be edited. |

- Header directives live in the leading comment block: `-- velexis:phase <phase>` and `-- velexis:no-transaction`. Any other `-- velexis:` line there (a typo such as `no-transation`) is an error.
- `-- velexis:no-transaction` is for `CREATE INDEX CONCURRENTLY`. The runner splits the file into statements (psql's rules: strings, `E'…'`, quoted identifiers, dollar quotes, comments, `BEGIN ATOMIC` bodies) and runs them one by one outside a transaction, then records the file. It first sets `lock_timeout = '5s'` and `statement_timeout = '10min'` again on the session, because a plain `SET` in an earlier file would otherwise still apply. A failure leaves the statements before it applied and records nothing, so write such files idempotently (`IF NOT EXISTS`) and drop an `INVALID` index that a failed `CONCURRENTLY` leaves behind before running again.
- A numbered file must not contain `BEGIN`, `COMMIT`, `ROLLBACK`, `END`, `ABORT`, `START TRANSACTION` or `PREPARE TRANSACTION`: the runner owns each file's transaction (savepoints are fine).
- Other `.sql` names, invalid UTF-8 and a byte order mark are errors; other files (`README.md`, `.gitkeep`) are ignored. The checksum is the SHA-256 of the raw bytes, so even a changed comment or line ending counts.
- Every problem of the folder is reported at once (`MigrationFilesError`), **before** a connection is opened.

### What a run does

1. Reads and validates the folder. A folder that does not exist is an **empty set**: a notice on stderr, nothing applied, no connection, exit `0` (CI runs `pnpm db:migrate` before X-012 creates the folders).
2. Opens a connection of its own (`application_name` `velexis-migrate-<set>`, session `statement_timeout = '10min'`) and takes `pg_advisory_lock(hashtext('velexis:migrate:' || set))` for the whole run. A second run of the same set waits for it (up to 10 minutes, instead of the role's 5 s `lock_timeout`), then finds nothing pending. Closing the connection releases the lock. The runner never touches `search_path`.
3. Creates `<set>.schema_migrations` when it is missing (and the schema, as the baseline would): the columns of the tenant ledger in `tenant.sql` (`id`, `description`, `checksum`, `phase`, `status`, `execution_ms`, `created_at`, `updated_at`), ids `NNNN_name` or `R__name` (the file name without `.sql`), and `repeatable` as an extra phase. It belongs to `velexis_migrator`; `bootstrap.sql`'s default privileges apply to it like to every table the migrator creates.
4. Verifies the checksums of the applied numbered files. A mismatch prints a `checksum_mismatch` line per file and exits `2` before anything is applied.
5. Applies each pending numbered file in its own transaction: `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '10min'`, the file, its ledger row, `COMMIT`. A failing file rolls back (no ledger row), the run stops with exit `1`, and the files before it stay applied.
6. Applies the repeatable files whose checksum differs from their ledger row, the same way, and updates their row (`updated_at`).

Ledger rows that have no file (for example after a rollback to an older release) are reported as a notice on stderr and otherwise ignored.

### Tenant schemas: `migrateTenantSchema` and `migrateTenants`

The tenant set (`ota/backend/migrations/tenant`) has the same files and checks, without repeatable files. Its ledger is each schema's own `schema_migrations`, which the baseline creates ([ADR-0005](../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) item 4, [db README §4](../../docs/velexis-sdk/db/README.md)).

**`migrateTenantSchema({ schema, dir, url, create, onFile, beforeCommit })`** (`migrate.js tenant --schema … --dir … [--create]`) migrates one schema:

1. `assertTenantSchema(schema)` and the folder checks, before any connection. A missing folder is an empty set: nothing is done, not even `--create`.
2. A connection of its own (`application_name` `velexis-migrate-tenant`) and **one transaction per schema**: `SET LOCAL ROLE velexis_provisioner`, `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '10min'`, `pg_advisory_xact_lock(hashtext(schema))`, then `set_config('search_path', schema || ', reference', true)` with the schema as a bound parameter. The role switch makes every tenant object belong to `velexis_provisioner`, whether the caller connects as `velexis_provisioner` (OTA worker) or as `velexis_migrator` (CLI, deploy), so the default privileges below always apply (ADR-0021). A second run on the same schema waits up to 5 s for the lock, then finds nothing pending.
3. The schema checks, under the lock. Without `create`, a missing schema is a `TenantSchemaError` (`problem: "missing"`). A schema owned by another role (`foreign_owner`), or one with relations but no ledger (`foreign_content`, OADR-0007), is never touched, even with `create`. An empty schema of the provisioner (an orphan) is completed, and gets the grants of step 4 even without `create` (`tenant` without `--create`, the fan-out): no schema gets its baseline without them.
4. With `create: true`, in the same transaction: `CREATE SCHEMA <ident> AUTHORIZATION velexis_provisioner` (the identifier quoted by `pg.escapeIdentifier`, after `assertTenantSchema`) when it does not exist; `GRANT USAGE ON SCHEMA` to `velexis_ota_app`; `ALTER DEFAULT PRIVILEGES FOR ROLE velexis_provisioner IN SCHEMA …` granting `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE, SELECT` on sequences to `velexis_ota_app`; and the same on what the schema already holds. The default privileges come first, so every table the files create, now or in a later release, is usable by `velexis_ota_app` without a `GRANT` in a migration. `velexis_platform_app` never gets anything. This is the `create_schema` + `run_migrations` step of OTA provisioning (db README §3).
5. Verifies the checksums of the applied files (`TenantChecksumMismatchError`, exit `2`, nothing applied), applies the pending files and inserts each ledger row in the same transaction (the baseline's own row right after it runs), then runs `beforeCommit` (below) and `COMMIT`s. A failing file rolls back the whole transaction, the new schema included (`TenantMigrationFailedError`, exit `1`): a schema is complete or absent. Events are emitted after `COMMIT`, so an `applied` line never names a rolled-back file.
6. A `-- velexis:no-transaction` file ends the transaction. It runs on a **dedicated** connection: `SET ROLE velexis_provisioner`, the two timeouts, the session advisory lock on the schema name and a session `search_path` of `schema, reference`; then its statements and its ledger row; then the connection is closed, which drops all of it. This runner is the only code allowed a session-level `search_path`, and never on an app pool (ADR-0004). The files after it continue in a new transaction.

**`beforeCommit({ schema, created, db })`** (library only, OBE-005) is how OTA provisioning commits its seeds with the schema ([OADR-0007](../../ota/docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md) item 2: schema, files, grants and seeds in one transaction). It runs once per run, in the run's **last** transaction (after a `no-transaction` file, in the transaction of the files after it), after the grants and every pending file with its ledger row, right before `COMMIT`; it also runs when nothing is pending, so a re-run reaches it again. Not when the folder is missing or the run failed earlier.

- `db` is a `Kysely<TenantDatabase>` on the runner's own connection, inside that transaction: tenant tables resolve unqualified through its `search_path`, as in `tenantTx`, with the role `velexis_provisioner`, the timeouts and the advisory lock of the transaction, and rows are parsed by the pools' type parsers (the runner's connection has them too). `created` is true when this run created the schema.
- The runner owns the transaction. Every statement goes through the extended query protocol (one statement per query), and `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ABORT`, `ROLLBACK` and `PREPARE TRANSACTION` (also after leading comments; `TRANSACTION_CONTROL_STATEMENT` in `src/migrate/tenant-schema.ts`) are refused with a `TypeError` before they are sent, so `db.transaction()` and `db.startTransaction()` fail too. Savepoints (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`) are fine. `db.destroy()` leaves the connection alone.
- When it throws, the transaction is rolled back, the schema it was creating included, and its error is rethrown as it is: no `applied` event is emitted for the files of that transaction.

**`migrateTenants({ dir, url, concurrency = 4, maxFailureRatio = 0.1, report })`** (`migrate.js tenants`) is the fan-out:

1. Reads the folder once, then the targets as `url` (`velexis_migrator`): `SELECT schema_name FROM platform.tenants WHERE status IN ('provisioning','active','suspended') ORDER BY key`.
2. Migrates each target with `migrateTenantSchema` **without** `create`, at most `concurrency` schemas at a time (a small worker pool, `runWithConcurrency`; no dependency), each in its own transaction on its own connection. A failed schema is reported and the others continue. A `provisioning` tenant whose schema does not exist yet is **skipped** (its provisioning applies every file); an `active` or `suspended` tenant without a schema is a failure.
3. Writes the report when `report` (`--report <file>`) is given, replacing the file atomically (mode `0600`; `velexis-deploy` copies it to root-only files):

   ```json
   {
     "target": "0002_add_mvp_tenant_deltas",
     "total": 3,
     "applied": [{ "schema": "tenant_acme", "files": [{ "set": "tenant", "schema": "tenant_acme", "file": "0002_add_mvp_tenant_deltas.sql", "status": "applied", "…": "…" }] }, { "schema": "tenant_beta", "files": [] }],
     "failed": [{ "schema": "tenant_zeta", "file": "0002_add_mvp_tenant_deltas.sql", "error": { "message": "relation \"x\" already exists", "code": "42P07" }, "exitCode": 1 }],
     "skipped": [{ "schema": "tenant_new", "reason": "the tenant is provisioning and its schema does not exist yet; provisioning applies every file" }]
   }
   ```

   `target` is the last file of the set. `applied` lists every schema that is now at `target`, with the files this run applied (none on a re-run). `failed` has the failing file (`null` when no file was at fault, for example a lock timeout) and `exitCode` `2` for a checksum mismatch. Every target is in exactly one list, in `ORDER BY key` order.
4. Returns exit code `3` when `failed / total > maxFailureRatio` (1 failure of 10 passes at the default 0.1; 1 of 3 does not), otherwise `0`. Errors before the first schema (invalid files, the targets query) throw (exit `1`).

`onSchemaStart(schema)` and `onSchemaEnd({ schema, status })` are instrumentation hooks; the concurrency test counts the schemas in flight with them. Mirroring the results into `platform.tenant_schema_migrations` is **not** done here: the OTA backend publishes them on `platform-tenant-events` from the report (PADR-0001, OADR-0007).

### CLI output and exit codes

- The DSN comes from `DATABASE_MIGRATOR_URL` only, read through `@velexis/config` (the root and package `.env.local` locally; nothing is loaded when `APP_ENV` or `NODE_ENV` is `production`). There is no `--url` flag, so a DSN never appears in a process list; the DSN is never printed.
- stdout: one JSON line per file applied, failed or changed; nothing when everything is up to date. For example:

  ```json
  {"set":"platform","file":"0002_add_tenant_flags.sql","id":"0002_add_tenant_flags","kind":"numbered","phase":"expand","status":"applied","checksum":"<sha256>","transaction":true,"executionMs":12}
  ```

  `status` is `applied`, `failed` (with `error: { message, code, line | statement }`: PostgreSQL's message and SQLSTATE, never its detail, which can quote row values) or `checksum_mismatch` (with `appliedChecksum`). Tenant lines have `"set":"tenant"` and the `schema`; the fan-out prints the lines of concurrent schemas as they come.
- stderr: notices and one error message. `tenants` prints one line per failed schema, a notice per skipped one, and a summary when a schema failed (`1 of 3 tenant schema(s) failed (33.3 %), more than --max-failure-ratio 0.1 allows`).
- Options are checked per command: `tenant` needs `--schema` (checked with `assertTenantSchema` before anything is read), only `tenant` takes `--create`, only `tenants` takes `--concurrency` (a positive integer), `--max-failure-ratio` (a number from 0 to 1) and `--report` (relative to the current folder).
- Exit codes: `0` success, `1` error (invalid files, configuration, connection, a failing file), `2` checksum mismatch of an applied file, `3` tenant failure ratio exceeded (`tenants`).

## `@velexis/db/storage`

```ts
import { createStorage, STORAGE_DRIVERS } from "@velexis/db/storage";

const storage = createStorage({
  driver: config.STORAGE_DRIVER, // env.enum(STORAGE_DRIVERS): "local" | "s3"
  dir: config.STORAGE_DIR, // /var/lib/velexis/storage on the VM, .local/storage locally
  signUrl: (key, expiresAt) => `${publicApiUrl}${signUrl(`/v1/files/${key}`, { expiresAt, key: urlKey })}`,
});
await storage.put("tenant_acme/documents/doc_01J….pdf", pdfBytes, "application/pdf");
const bytes = await storage.get("tenant_acme/documents/doc_01J….pdf"); // Buffer | null
const url = await storage.signedUrl("tenant_acme/documents/doc_01J….pdf", 300); // valid 5 minutes
```

- **Keys** are `tenant_<key>/…` (a valid tenant schema name) or `platform/…`, plus at least one more segment. Segments use `[A-Za-z0-9_][A-Za-z0-9._-]*`, at most 512 characters in total. A key containing `..`, an empty segment, a leading dot, a backslash or any other character throws `StorageKeyError`. The resolved path is checked once more to lie inside the storage directory.
- **`LocalDiskStorage(dir, { signUrl?, now? })`** writes a temporary file in the target directory (`wx`, mode 0600, `fsync`), renames it over the target and syncs the directory. Readers see the old or the new file, never a part of one. Files have mode **0600** whatever the umask, and directories created for keys have mode 0700. `get` returns `null` for a missing key, and `delete` of a missing key is a no-op.
- **`signedUrl(key, ttlSeconds)`** calls the injected `signUrl(key, expiresAt)`. The OTA backend signs `/v1/files/<key>?exp=…&sig=…` with `document-url.key` (`signUrl` of `@velexis/crypto`, X-005; ADR-0017). Without a signer it throws.
- **`createStorage({ driver, dir, signUrl })`**: `local` gives a `LocalDiskStorage`. `s3` throws "not implemented" until an S3 adapter is needed; switching then is configuration only.
- Content type, size and SHA-256 belong in the caller's rows (`booking_documents`). The local adapter checks the content type but does not store it.

## Exports map

| Subpath | Contents |
|---|---|
| `@velexis/db` | Pools, `createPlatformDb`, `createTenantDb`, `tenantTx`, schema checks, type parsers, the generated table types (X-014) and Kysely's `sql`, `Selectable`, `Insertable`, `Updateable` |
| `@velexis/db/migrate` | `runMigrations`, `readMigrationFiles`, the ledger helpers, `splitSqlStatements`, the error classes and `MIGRATE_EXIT_CODES` (X-011); `migrateTenantSchema`, `migrateTenants`, `runWithConcurrency`, the tenant error classes and the report types (X-013); `TenantBeforeCommitContext` (OBE-005) |
| `@velexis/db/storage` | `StorageAdapter`, `LocalDiskStorage`, `createStorage`, storage keys |

## Tests

- **Unit** (`pnpm --filter @velexis/db test`): schema names, type parsers, pool options, `tenantTx` against a recording fake pool (statement order, bound parameters, leak guard, rejection before any SQL), `LocalDiskStorage` in a temporary folder, migration file discovery and the CLI paths that need no database (`src/migrate/files.test.ts`, including the missing `--dir`), the statement splitter (also over the three reference DDL files) and the repeatable-file rules (`src/migrate/repeatable.test.ts`). `src/migrate/tenants.test.ts`: the concurrency limiter with hand-released tasks, the failure ratio, the tenant options of `migrate.js` and the `migrate:tenants` script. `src/migrate/tenant-schema.test.ts`: the `beforeCommit` connection against a recording fake client (the extended protocol, the refused transaction statements, `destroy()`), and no callback for a missing folder.
- **Integration** (`pnpm --filter @velexis/db test:int`, `vitest.int.config.ts`, PostgreSQL 16): `test/integration/helpers.ts` connects as `TEST_DATABASE_ADMIN_URL`, read through `@velexis/config` (the environment, or `.env.local` locally). It creates a scratch database `velexis_dbtest_<random>` owned by `velexis_migrator` with the database-level grants of `bootstrap.sql`. It adds `tenant_alpha` and `tenant_beta` owned by `velexis_provisioner`, each with an `items` table of different rows and DML for `velexis_ota_app`, plus a small `platform` and `reference` schema. It drops the database at the end. The pools log in as `velexis_ota_app` with its development password from `.env.example`, so the role default `search_path = pg_catalog` applies. The roles come from `deploy/scripts/dev-setup.sh` locally and from the CI bootstrap. `@velexis/testing` (X-015) replaces this helper.
- The isolation test of ADR-0004 runs 50 interleaved transactions of both tenants through a pool of **size 1**, with writes and rollbacks. Each transaction sees only its own tenant's rows. The plan text names the schemas `tenant_a` and `tenant_b`, but a one-letter key is not a valid schema name, so the tests use `tenant_alpha` and `tenant_beta` (the names of the X-015 template).
- The leak-guard test uses a session-level `SET search_path` on purpose; `packages/db` is the only place CI allows one.
- `test/integration/migrate.int.test.ts` gives every test a fresh `velexis_dbtest_<random>` database prepared like `bootstrap.sql` (empty `platform` and `reference` schemas with their default privileges) and runs the runner as `velexis_migrator` (`DATABASE_MIGRATOR_URL` with the database name swapped), through `runMigrateCli` and `runMigrations`. It covers ordering and re-runs, the reference baselines, the ledger columns against `tenant.sql`, the per-file timeouts, checksum mismatches, failing files, `no-transaction` files, repeatable files and two runs queued on the advisory lock.
- The repository's own migrations (X-012): `src/migrate/baselines.test.ts` checks that each `0001_baseline.sql` has the SHA-256 of its `docs/velexis-sdk/db/` file, that the `migrate` script points at the repository folders, and that `R__ota_read_access.sql` grants exactly the ADR-0004 list. `test/integration/baselines.int.test.ts` runs the in-database part of `bootstrap.sql` on a fresh database, applies the sets as `pnpm db:migrate` does and the tenant set to `tenant_alpha`, then logs in as `velexis_ota_app` and `velexis_platform_app` (development DSNs of the backends' `.env.example`) and checks every granted and denied privilege of ADR-0004 with real queries.
- The generated table types (X-014): `src/types.test.ts` is checked by `pnpm typecheck` (the default type parameters, `expectTypeOf` and the `// @ts-expect-error` lines: `trx.selectFrom("tenants")` inside `tenantTx` and `platformDb.selectFrom("bookings")` must not compile) and run by Vitest (the SQL Kysely builds on a recording fake pool; every `numeric` column of the three baselines is `Numeric`, which selects as `string`; the header, the code-unit order and no run-specific text in `src/generated`). `test/integration/codegen.int.test.ts` builds the package, runs `scripts/codegen.mjs --out <temporary folder>` twice, compares both outputs with each other and with the committed files, and checks that each run dropped its `velexis_codegen_<pid>` database and printed no DSN.
- `test/integration/tenants.int.test.ts` (X-013) gives every test a fresh database bootstrapped like `baselines.int.test.ts`, with the repository's platform and reference sets. The file builds that database once as a template (`velexis_dbtest_tpl_<random>`, in `beforeAll` with a 60 s timeout) and each test gets a copy (`CREATE DATABASE … TEMPLATE` plus the database grants, which PostgreSQL does not copy; 30 s timeout). A copy takes 0.1 to 0.4 s, where bootstrapping and migrating from `template0` for every test overran Vitest's 10 s hook timeout while the other integration test files ran in parallel. `afterAll` waits for every setup to settle and drops whatever the file created and has not dropped, also the database of a setup that outlived its hook. A drop is retried while a session `velexis_test_admin` may not terminate is still on the database (an autovacuum worker on the template, or an app role's session that is exiting), as `@velexis/testing` does. It runs `migrate.js tenant` and `tenants` as `velexis_migrator` and provisions with the `DATABASE_PROVISIONER_URL` of the root `.env.example`, as the OTA worker does. It covers the 42-table schema of `--create` and its privileges, the provisioner's denied writes on `platform` and `reference`, a later file (and a `no-transaction` index) applied by the fan-out to a table `velexis_ota_app` writes without a `GRANT`, a conflicting table in 1 of 10 schemas (exit 0) and in 1 of 3 (exit 3), the concurrency limit through the instrumentation hooks, re-runs, the target statuses, rollbacks, checksum mismatches, foreign schemas, orphan schemas completed with their grants, the role, timeouts, advisory lock and `search_path` that each file sees (in a transaction and on the dedicated connection) and two runs on one schema's advisory lock. Its `beforeCommit` tests show that the callback's rows and the ledger rows are written by one transaction (`xmin`), that a callback that throws, or tries to `COMMIT`, leaves no schema and no pending file applied, and that the callback runs once, after a `no-transaction` file and the files after it. The fan-out tests use a small baseline (the tenant ledger of `tenant.sql` and a `customers` table) to provision many schemas quickly.

## Scripts

| Command | Does |
|---|---|
| `pnpm --filter @velexis/db build` | `tsc -b` to `dist/` (CommonJS and `.d.ts`); builds `@velexis/logger` and `@velexis/config` first (project references) |
| `pnpm --filter @velexis/db test` | Unit tests (Vitest) |
| `pnpm --filter @velexis/db test:int` | Integration tests (needs PostgreSQL, `TEST_DATABASE_ADMIN_URL` and `DATABASE_MIGRATOR_URL`; the app and provisioner roles log in with the development DSNs of the `.env.example` files; the codegen test builds the package first) |
| `pnpm --filter @velexis/db migrate` (root: `pnpm db:migrate`) | Builds the package (`premigrate`), then `migrate.js platform` and `migrate.js reference` with the repository folders `platform/backend/migrations/{platform,reference}` |
| `pnpm --filter @velexis/db migrate:tenants` (root: `pnpm db:migrate:tenants`) | Builds the package (`premigrate:tenants`), then `migrate.js tenants --dir ../../ota/backend/migrations/tenant` (defaults: 4 at a time, 10 % failures allowed). Run `pnpm db:migrate` first |
| `pnpm --filter @velexis/db codegen` (root: `pnpm db:codegen`) | Builds the package (`precodegen`), then `scripts/codegen.mjs`: regenerates `src/generated/` from a scratch database ([above](#table-types-pnpm-dbcodegen)). Needs PostgreSQL and `TEST_DATABASE_ADMIN_URL` |
| `pnpm --filter @velexis/db typecheck` | `tsc --noEmit` for `src/` and for `test/` (`test/tsconfig.json`) |
| `pnpm --filter @velexis/db lint` | ESLint with the root flat config |
| `pnpm --filter @velexis/db clean` | Removes the build output |
