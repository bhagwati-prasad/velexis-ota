# Tenant migrations

The SQL migrations of the tenant schemas. Every OTA has its own schema `tenant_<key>`, and every tenant schema gets the same files, in the same order, from `0001`. The migration runner of `@velexis/db` applies them ([`packages/db/README.md`](../../../packages/db/README.md#migrations-velexisdbmigrate-and-migratejs)). The `platform` and `reference` schemas have their own sets in [`platform/backend/migrations/`](../../../platform/backend/migrations/README.md).

Design: [ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md) (schema per tenant, roles, migration ownership), [ADR-0005](../../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) (plain SQL, baselines, runner), [ADR-0021](../../../docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md) (CLI), [OADR-0007](../../docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md) (provisioning worker), [db README §3–§4](../../../docs/velexis-sdk/db/README.md), [`conventions.md` §9](../../../docs/mvp/conventions.md#9-database-migrations), [`../../docs/data-model.md`](../../docs/data-model.md).

## Files

| File | What |
|---|---|
| `tenant/0001_baseline.sql` | Byte-for-byte copy of [`docs/velexis-sdk/db/tenant.sql`](../../../docs/velexis-sdk/db/tenant.sql): the 42 tenant tables, including the schema's own ledger `schema_migrations` |
| `tenant/0002_add_mvp_tenant_deltas.sql` | All MVP tenant deltas, phase `expand` (OBE-008): the SQL block of [`data-model-migration-0002.md`](../../docs/data-model-migration-0002.md) §2, byte for byte (airline-card payments, checkout pricing mode, booking reconciliation, storefront settings columns, the tables `storefront_assets` and `storefront_pages`); the reasons are in [`data-model.md`](../../docs/data-model.md) §3 |

The file and its document never drift apart: change both in the same commit, before the file is merged (never after). Changes found later take the next free number (`0003_…`).

The ledger of each schema is its own `schema_migrations` table, created by the baseline: one row per applied file (the file name without `.sql`, the description, the SHA-256 of the file, the phase, the status and the timing). It is the source of truth and travels with the schema in dumps. The platform keeps a mirror in `platform.tenant_schema_migrations`, fed by the OTA worker's `tenant.provisioned` and `tenant.migrated` events ([OADR-0007](../../docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md)); the OTA backend never writes it.

## Naming

- `NNNN_verb_object.sql`: four digits and a snake_case name, with the next free number of the set (`0002_add_mvp_tenant_deltas.sql`). Files are applied in name order. Two files with the same number fail the run.
- There are **no repeatable files** (`R__…`) in the tenant set: the runner rejects them. Tenant privileges are granted per schema by provisioning, not by migrations.
- Any other `.sql` name is an error. Other files are ignored.

## Headers

Every file starts with its phase and a one-line description:

```sql
-- velexis:phase expand
-- Add the MVP tenant deltas
```

- The phase is `expand`, `migrate` or `contract` (below). It is stored in the ledger.
- Add `-- velexis:no-transaction` to the header for `CREATE INDEX CONCURRENTLY`. The runner then runs the statements one by one outside the schema's transaction and records the file afterwards, so write them idempotently (`IF NOT EXISTS`).
- Any other `-- velexis:` line in the header is an error. A file never contains `BEGIN`, `COMMIT`, `ROLLBACK` or another transaction statement: the runner owns the transaction.
- `0001_baseline.sql` is the exception: it is a byte copy of the reference DDL, so it has **no** header and counts as `expand`.

## Writing a migration

- **Unqualified names** (`bookings`, not `tenant_acme.bookings`). The runner sets the schema with `set_config('search_path', '<schema>, reference', true)` for the transaction. A migration never sets `search_path` itself, never names another schema except `reference`, and only refers to `reference` rows by value: no foreign key leaves the tenant schema.
- **No grants.** Tables belong to `velexis_provisioner`, and provisioning sets default privileges that give `velexis_ota_app` `SELECT, INSERT, UPDATE, DELETE` on every table, and access to every sequence, created later. A migration never names a role.
- It must run on an **empty** schema (a new OTA) and on a **populated** one (an OTA with bookings).
- Statuses are `text` + `CHECK`, never PostgreSQL enums. Every new table and column gets a `COMMENT ON`, in the style of the reference DDL.
- **Expand / migrate / contract.** The fan-out runs while the previous release still serves requests, so the code must work with schema versions N-1 and N:
  - *expand*: add nullable columns, tables and indexes (`CONCURRENTLY` on large tables); extend a CHECK list by adding the new constraint `NOT VALID`, then `VALIDATE CONSTRAINT`;
  - *migrate*: the code writes both shapes; backfills of tenant data run as batched jobs per tenant, **not** inside the migration;
  - *contract*: drop old columns or constraints in a **later release**, once every tenant reports the version.
- **Never edit a merged file.** The runner verifies the checksum of every applied file. An edited file fails that schema: provisioning reports it as non-retryable, and the fan-out counts the schema as failed. Fix forward with a new file.
- **Never edit the baseline** or `docs/velexis-sdk/db/tenant.sql`. The unit test `packages/db/src/migrate/baselines.test.ts` and the CI guard (`cmp`) fail when the baseline differs from its reference file by one byte.

## How they are applied

Each schema is migrated in **one transaction** of its own (ADR-0005, db README §4); only a `no-transaction` file runs outside it (Headers above):

1. `SET LOCAL ROLE velexis_provisioner`, so every tenant object has one owner whoever connects (ADR-0021);
2. `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '10min'`;
3. `pg_advisory_xact_lock(hashtext(schema))`;
4. `set_config('search_path', schema || ', reference', true)`;
5. verify the checksums of the applied files, apply the pending ones, insert their ledger rows, `COMMIT`.

A new OTA's schema is created in the same transaction (`CREATE SCHEMA … AUTHORIZATION velexis_provisioner`, then the grants and default privileges for `velexis_ota_app`), so a schema is complete or absent.

| Command | Does |
|---|---|
| `pnpm db:migrate:tenants` | Applies the pending files to every tenant schema whose tenant is `provisioning`, `active` or `suspended`, 4 schemas at a time. It continues past a failed schema and exits `3` when more than 10 % fail. |
| `node dist/cli/migrate.js tenants --dir <release>/migrations/tenant` | The same fan-out, run by `velexis-deploy` after the platform and reference sets and before the apps restart |
| `node dist/cli/migrate.js tenant --schema tenant_<key> --dir … [--create]` | One schema: provisioning, tests, repairs |

The `tenants` and `tenant` commands call the library functions `migrateTenants` and `migrateTenantSchema` ([`packages/db/README.md`](../../../packages/db/README.md#tenant-schemas-migratetenantschema-and-migratetenants), X-013). The OTA worker calls `migrateTenantSchema` with `DATABASE_PROVISIONER_URL` when it provisions an OTA; the CLI connects with `DATABASE_MIGRATOR_URL` only. Run `pnpm db:migrate` (platform and reference) first.

Every migration pull request runs `pnpm db:migrate:tenants` on a fresh schema and on one at the previous version, commits the regenerated table types (`pnpm db:codegen`) and adds or updates an integration test that uses the change ([`conventions.md` §9](../../../docs/mvp/conventions.md#9-database-migrations)).

## Tests

- `packages/db/src/migrate/baselines.test.ts`: the baseline has the SHA-256 of `tenant.sql`, and the runner accepts the folder.
- `packages/db/test/integration/baselines.int.test.ts`: applied to `tenant_alpha` on a fresh database, the set gives the 42 tables of the baseline and the 2 of `0002`, owned by `velexis_provisioner`, and their ledger rows; with the provisioning grants `velexis_ota_app` writes and reads a tenant table, and `velexis_platform_app` has no privilege at all on the schema. The grants and default privileges of provisioning itself are tested with `migrateTenantSchema` in `packages/db/test/integration/tenants.int.test.ts` (X-013).
- [`../test/contract/migration-0002.contract.test.ts`](../test/contract/migration-0002.contract.test.ts) (`pnpm --filter @velexis/ota-backend test`): `0002` is the SQL block of its document byte for byte (it fails on a one-character difference and names the line), starts with `-- velexis:phase expand`, ends with one newline, is read by the runner as a transactional `expand` file, follows the rules above (no `GRANT` or role, no `search_path`, no other schema, no transaction statement, expand only: an allow-list of statement kinds on unqualified names, a default for every `NOT NULL` column it adds, nothing dropped but the replaced CHECKs, every new CHECK validated; a `COMMENT ON` for every new table and column), and the generated table types contain its tables and columns.
- [`../test/integration/migrations/tenant-0002.int.test.ts`](../test/integration/migrations/tenant-0002.int.test.ts) (`pnpm --filter @velexis/ota-backend test:int`): the tests of [`data-model-migration-0002.md`](../../docs/data-model-migration-0002.md) §3 (from scratch against the generated types; the upgrade of a schema at N-1 with rows by the deploy fan-out, which ends with the catalogue of a fresh schema; the airline-card CHECK; the `RESTRICT` asset references; page uniqueness and `published_at`; the ledger row), and a tenant provisioned by the worker after it, whose `velexis_ota_app` writes `storefront_assets` and `storefront_pages` through the default privileges of provisioning.
