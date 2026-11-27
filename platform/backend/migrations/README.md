# Platform and reference migrations

The SQL migrations of the `platform` and `reference` schemas. They are applied once per database, as `velexis_migrator`, by the migration runner of `@velexis/db` ([`packages/db/README.md`](../../../packages/db/README.md#migrations-velexisdbmigrate-and-migratejs)). The tenant schemas have their own set in [`ota/backend/migrations/`](../../../ota/backend/migrations/README.md).

Design: [ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md) (roles, migration ownership), [ADR-0005](../../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) (plain SQL, baselines), [ADR-0021](../../../docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md) (CLI, repeatable grant files), [`conventions.md` §9](../../../docs/mvp/conventions.md#9-database-migrations), [`../../docs/data-model.md`](../../docs/data-model.md).

## Files

| File | What |
|---|---|
| `platform/0001_baseline.sql` | Byte-for-byte copy of [`docs/velexis-sdk/db/platform.sql`](../../../docs/velexis-sdk/db/platform.sql): the 16 platform tables |
| `platform/0002_add_mvp_platform_deltas.sql` | Every planned MVP delta in one `expand` migration (PBE-002): 11 new tables, the new columns and constraints of the baseline tables, the `early_access` plan, the grants of the new tables and the append-only audit log. Byte-for-byte concatenation of the SQL blocks of [`data-model-migration-0002.md`](../../docs/data-model-migration-0002.md), [part 2](../../docs/data-model-migration-0002-part2.md) and [part 3](../../docs/data-model-migration-0002-part3.md); the reasons are in [`data-model.md`](../../docs/data-model.md) §4 |
| `platform/0003_add_billing_customer_attempts.sql` | The first delta found during implementation (FIX-W29-PLATFORM): `billing_customer_attempts`, the attempt of a tenant's Stripe Customer creation after a Stripe failure that spent its idempotency key, with DML for `velexis_platform_app` and nothing for the OTA role ([`data-model.md`](../../docs/data-model.md) §4.10, [PADR-0002](../../docs/adr/0002-stripe-billing-integration.md) item 3) |
| `platform/0004_add_plan_price_warnings.sql` | The second delta (FIX-W42-PLATFORM, lead decision (4c) of 2026-11-04, second set): `plans.price_warnings`, the price warnings of a plan's last comparison with its Stripe prices (`jsonb`, a JSON array, empty by default), which the admin's plan reads take from the plan instead of the comparison's audit row; no grant (the table-level privileges on `plans` cover it) and no backfill ([`data-model.md`](../../docs/data-model.md) §4.10, [PADR-0002](../../docs/adr/0002-stripe-billing-integration.md) item 2) |
| `platform/0005_add_supplier_registry.sql` | The supply registry (PBE-078; [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) items 2, 3 and 11, [PADR-0020](../../docs/adr/0020-supplier-registry-switches-and-suppliers-page.md) items 7 to 9): four tables, `suppliers` (seeded `amadeus`, `pkfare`), `supplier_environments` (the global switch, seeded), `supply_sources` (`ssr_` ids, owner, stop) and `supply_source_ids` (`sup_` ids, unique for ever); on `supplier_connections` the supply source (nullable) and the per-tenant switch (on by default), a foreign key of `provider` to `suppliers` in place of its CHECK (its default stays), the credential source in the unique key and the source CHECK rewritten for other suppliers; on `amadeus_accounts` the account's source; the backfill of the rows of its day (a source and a supply id per Velexis Amadeus account and per `tenant` connection, drawn from `gen_random_uuid()`); DML for `velexis_platform_app` and column grants for `velexis_ota_app` ([`data-model.md`](../../docs/data-model.md) §4.11) |
| `platform/R__ota_read_access.sql` | Repeatable: `SELECT` for `velexis_ota_app` on the eight baseline platform tables of ADR-0004 and on the listed `accounts` columns, never on the secrets, hashes or security counters of `accounts`. The rest of ADR-0004's list is granted by the numbered file that adds it: the shared Amadeus account tables of [ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md) by `0002`, the listed columns of the supply registry by `0005` |
| `reference/0001_baseline.sql` | Byte-for-byte copy of [`docs/velexis-sdk/db/reference.sql`](../../../docs/velexis-sdk/db/reference.sql): the 7 reference tables |

**`platform/0002_add_mvp_platform_deltas.sql` holds every planned MVP delta of the `platform` schema**, including the tables first used in M5, so later milestones need no schema work for what the plan already decided. It is generated from its three documents, never written by hand: change the SQL in the documents, then copy the three blocks again, in order and with nothing between them. Once merged it is never edited (its checksum is in every ledger). Changes found during implementation are later numbered files: `0003_add_billing_customer_attempts.sql` is the first and `0004_add_plan_price_warnings.sql` the second; `0005_add_supplier_registry.sql` (PBE-078) is the first of the multi-supplier milestone M7. **The next platform delta is `0006_…`**. The `reference` set has no delta in the MVP.

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

- `packages/db/src/migrate/baselines.test.ts`: each baseline has the SHA-256 of its reference file, the runner accepts the folders, and `R__ota_read_access.sql` grants exactly the baseline tables and `accounts` columns of the ADR-0004 list.
- `packages/db/test/integration/baselines.int.test.ts`: on a fresh database prepared like `bootstrap.sql`, the sets apply (16 platform tables plus the 11 of `0002`, the one of `0003` and the four of `0005`, `0004` adding a column and no table, and 7 reference tables, each set with its ledger), and `velexis_ota_app` and `velexis_platform_app` hold exactly the privileges of ADR-0004: for the OTA role, the eight baseline tables and the `accounts` columns of `R__ota_read_access.sql`, the two Amadeus account tables that `0002` grants and the registry columns that `0005` grants. Every denied table and column, those of the registry and all of `suppliers` included, is checked with a real `permission denied` error, and every write on the registry too.
- [`../test/contract/migration-0002.contract.test.ts`](../test/contract/migration-0002.contract.test.ts) (`pnpm --filter @velexis/platform-backend test`): `0002` is the byte-for-byte concatenation of the SQL blocks of its three documents (it fails on a one-character difference and names the line), starts with `-- velexis:phase expand`, ends with one newline, is read by the runner as a transactional `expand` file, and the generated table types contain its tables and columns.
- [`../test/integration/migrations/migrate-0002.int.test.ts`](../test/integration/migrations/migrate-0002.int.test.ts) (`pnpm --filter @velexis/platform-backend test:int`): `0002` applies from scratch (the `@velexis/testing` template) and as an upgrade of a database at `0001` holding a tenant and a subscription, which survive; everything it creates and its ledger row share one transaction id. The later numbered files are expected in its ledgers too.
- [`../test/contract/migration-0003.contract.test.ts`](../test/contract/migration-0003.contract.test.ts) and [`../test/integration/migrations/migrate-0003.int.test.ts`](../test/integration/migrations/migrate-0003.int.test.ts): the runner reads `0003` as the third file (`expand`, one transaction, every column commented, DML for the platform role only) and the generated types carry its table; it applies from scratch and as an upgrade of a database at `0002` holding a tenant, which survives (the later numbered files follow it); `velexis_platform_app` writes the table within its CHECK and foreign key, `velexis_ota_app` cannot read it.
- [`../test/contract/migration-0004.contract.test.ts`](../test/contract/migration-0004.contract.test.ts) and [`../test/integration/migrations/migrate-0004.int.test.ts`](../test/integration/migrations/migrate-0004.int.test.ts): the runner reads `0004` as the fourth file (`expand`, one transaction, one commented column of `plans`, no table, grant or row) and the generated types carry `plans.price_warnings`; it applies from scratch and as an upgrade of a database at `0003` holding a plan (only it, then the later numbered files), which survives with no warning and its version; `velexis_platform_app` stores a JSON array only (the CHECK and NOT NULL refuse an object, a string, a number, JSON `null` and SQL `NULL`), `velexis_ota_app` reads it with the rest of `plans`.
- [`../test/contract/migration-0005.contract.test.ts`](../test/contract/migration-0005.contract.test.ts) and [`../test/integration/migrations/migrate-0005.int.test.ts`](../test/integration/migrations/migrate-0005.int.test.ts): the runner reads `0005` as the fifth file (`expand`, one transaction, every new table and column commented, the `provider` foreign key and the rewritten source CHECK added `NOT VALID` and then validated, the grants above) and the generated types carry its tables and columns; on an empty database (the template) it seeds the suppliers and their switches, its constraints refuse what the code must never write (an unknown supplier, a second row of one credential source, a Velexis row of another supplier without its source, a connection on a source of another supplier, environment or credential source, an account on a source of another environment, a stop without its time or reason, a supply id that is not `sup_` and 16 base32 characters, a second current id), and the connection repository names the supplier and points a `velexis` row at its account's source; as an upgrade of a database at `0004` holding the rows of today's seeds, it alone is applied, every connection then has a source and is switched on, every source one `sup_` id of its own, and the rows keep their other columns, `version` and `updated_at`. `migrate-0002.int.test.ts` reads the two catalog rows of `0002` that `0005` writes again (the pg_class row of `amadeus_accounts` and `supplier_connections_source_ck`) with `0005`'s transaction id.
