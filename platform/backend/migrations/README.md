# Platform and reference migrations

The SQL migrations of the `platform` and `reference` schemas. They are applied once per database, as `velexis_migrator`, by the migration runner of `@velexis/db` ([`packages/db/README.md`](../../../packages/db/README.md#migrations-velexisdbmigrate-and-migratejs)). The tenant schemas have their own set in [`ota/backend/migrations/`](../../../ota/backend/migrations/README.md).

Design: [ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md) (roles, migration ownership), [ADR-0005](../../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) (plain SQL, baselines), [ADR-0021](../../../docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md) (CLI, repeatable grant files), [`conventions.md` §9](../../../docs/mvp/conventions.md#9-database-migrations), [`../../docs/data-model.md`](../../docs/data-model.md).

## Files

| File | What |
|---|---|
| `platform/0001_baseline.sql` | Byte-for-byte copy of [`docs/velexis-sdk/db/platform.sql`](../../../docs/velexis-sdk/db/platform.sql): the 16 platform tables |
| `platform/R__ota_read_access.sql` | Repeatable: `SELECT` for `velexis_ota_app` on the eight platform tables of ADR-0004 and on the listed `accounts` columns, never on the secrets, hashes or security counters of `accounts` |
| `reference/0001_baseline.sql` | Byte-for-byte copy of [`docs/velexis-sdk/db/reference.sql`](../../../docs/velexis-sdk/db/reference.sql): the 7 reference tables |

The platform deltas start at **`platform/0002_add_mvp_platform_deltas.sql`**, which the platform plan creates in M1 from [`data-model-migration-0002.md`](../../docs/data-model-migration-0002.md) and its two companion parts. The `reference` set has no delta in the MVP. Changes found later take the next free number (`0003_…`).

The runner creates `<schema>.schema_migrations` before the first file of each set. It holds one row per numbered file and per repeatable file: the file name without `.sql`, the description, the SHA-256 of the file, the phase, the status and the timing.

## Naming

- **Numbered files:** `NNNN_verb_object.sql`, four digits and a snake_case name, with the next free number of the set (`0002_add_mvp_platform_deltas.sql`). They are applied once, in name order. Two files with the same number fail the run.
- **Repeatable files:** `R__snake_name.sql` (`R__ota_read_access.sql`), `platform` and `reference` only.
- Any other `.sql` name is an error. Other files (this README) are ignored.

## Headers

Every numbered file starts with its phase and a one-line description:

```sql
-- velexis:phase expand
-- Add the MVP platform deltas
```

- The phase is `expand`, `migrate` or `contract` (below). It is stored in the ledger.
- Add `-- velexis:no-transaction` to the header for `CREATE INDEX CONCURRENTLY`. The runner then runs the statements one by one outside a transaction and records the file afterwards, so write them idempotently (`IF NOT EXISTS`).
- Any other `-- velexis:` line in the header is an error. A numbered file never contains `BEGIN`, `COMMIT`, `ROLLBACK` or another transaction statement: the runner opens and commits each file's transaction.
- `0001_baseline.sql` is the exception: it is a byte copy of the reference DDL, so it has **no** header and counts as `expand`.
- A repeatable file has no phase header (its phase is `repeatable`) and no `no-transaction`.

## Writing a migration

- **Schema-qualified SQL** (`platform.tenants`, `reference.airports`). A platform migration never touches a tenant schema ([ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md)).
- **OTA read access.** A new table or column that the OTA backend must read gets `GRANT SELECT … TO velexis_ota_app` in the same migration, or an entry in `R__ota_read_access.sql` in the same pull request. Grant only what the OTA backend reads. A table with columns the OTA backend must never read is granted column by column, never as a whole table: `accounts` is, so its password hash, TOTP secret and security counters stay out ([ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md)). A column added to `accounts` later is not readable until a grant names it. `velexis_platform_app` gets DML on new tables automatically (default privileges of `deploy/postgres/bootstrap.sql`).
- Statuses are `text` + `CHECK`, never PostgreSQL enums. Every new table and column gets a `COMMENT ON`, in the style of the reference DDL.
- **Expand / migrate / contract.** The code must work with schema versions N-1 and N:
  - *expand*: add nullable columns, tables and indexes (`CONCURRENTLY` on large tables); extend a CHECK list by adding the new constraint `NOT VALID`, then `VALIDATE CONSTRAINT`;
  - *migrate*: the code writes both shapes and data is backfilled;
  - *contract*: drop old columns or constraints in a **later release** than the code that stops using them.
- **Never edit a merged numbered file.** The runner verifies the checksum of every applied file: an edited file stops the next run with exit code `2` before anything is applied. Fix forward with a new numbered file.
- **Never edit the baselines** or `docs/velexis-sdk/db/*.sql`. The unit test `packages/db/src/migrate/baselines.test.ts` and the CI guard (`cmp`) fail when a baseline differs from its reference file by one byte.

### The repeatable file

`R__ota_read_access.sql` holds only `GRANT`, `REVOKE` and `COMMENT ON` statements; the runner rejects anything else. It runs after all numbered files of a run, and only when its checksum differs from its ledger row: on a fresh database, then again after each edit. So unlike a numbered file it **may** be edited, and an unchanged file does not run again: a numbered file that drops and re-creates a table listed there grants it again itself. `GRANT` only adds: deleting a name from the file revokes nothing, so withdraw a privilege with an explicit `REVOKE`. Check the numbered files first, because a `REVOKE` here would undo their grants on every fresh database.

## Running them

| Command | Does |
|---|---|
| `pnpm db:migrate` | Builds `@velexis/db`, then runs `migrate.js platform --dir platform/backend/migrations/platform` and `migrate.js reference --dir platform/backend/migrations/reference` with `DATABASE_MIGRATOR_URL` (`.env.local` locally) |
| `pnpm db:migrate:tenants` | Applies the tenant set to every tenant schema ([`ota/backend/migrations/`](../../../ota/backend/migrations/README.md); the `tenants` command of the CLI, X-013) |
| `node dist/cli/migrate.js platform --dir <release>/migrations/platform` | What `velexis-deploy` runs on the VM, from the release's `db/` folder, before the reference set and the tenant fan-out |

- stdout has one JSON line per file applied (`"status":"applied"`), failed or changed, and **nothing** when everything is up to date. Notices and errors go to stderr.
- Exit codes: `0` success, `1` error (invalid files, a failing file: it is rolled back and the files before it stay applied), `2` an applied file was edited.
- Deploy order: platform and reference migrations, then the tenant fan-out, then the apps restart ([ADR-0007](../../../docs/mvp/adr/0007-single-vm-without-docker.md)).

Every migration pull request runs `pnpm db:migrate` on a fresh database and on one at the previous version, commits the regenerated table types (`pnpm db:codegen`) and adds or updates an integration test that uses the change ([`conventions.md` §9](../../../docs/mvp/conventions.md#9-database-migrations)).

## Tests

- `packages/db/src/migrate/baselines.test.ts`: each baseline has the SHA-256 of its reference file, the runner accepts the folders, and `R__ota_read_access.sql` grants exactly the ADR-0004 list.
- `packages/db/test/integration/baselines.int.test.ts`: on a fresh database prepared like `bootstrap.sql`, the sets apply (16 platform and 7 reference tables, each with its ledger), and `velexis_ota_app` and `velexis_platform_app` hold exactly the privileges of ADR-0004. Every denied table and `accounts` column is checked with a real `permission denied` error.
