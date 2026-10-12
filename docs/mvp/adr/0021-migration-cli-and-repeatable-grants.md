# ADR-0021: Migration CLI and repeatable grant files

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform/DevOps engineer (foundation plan). Decided during planning; revisit when a managed database or a second cluster changes how migrations are run, or when more than one repeatable file per set is needed.

## Context

[ADR-0005](0005-data-access-kysely-sql-migrations.md) fixes the migration runner: forward-only `NNNN_name.sql` files, checksums in a `schema_migrations` ledger per schema, `0001_baseline.sql` as a **byte-for-byte** copy of the reference DDL, and a tenant fan-out. Two details were left open:

1. **How the VM runs migrations.** The VM has no repository checkout and no `pnpm`, only the release folder ([ADR-0023](0023-release-artefact-and-deploy-user.md)). `velexis-deploy`, `pnpm db:migrate`, the OTA provisioning job and the test harness all need the same entry point.
2. **Where the OTA backend's read grants on baseline platform tables live.** [ADR-0004](0004-postgresql-schema-per-tenant.md) gives `velexis_ota_app` `SELECT` on nine baseline tables (column-level on `accounts`). They cannot go into `0001_baseline.sql` (it must equal `platform.sql`). The platform plan already uses `0002` for its MVP deltas ([`platform/docs/data-model.md`](../../../platform/docs/data-model.md)), lands it in M1, and expects the baseline grants from the foundation tasks. The bootstrap script cannot grant on tables that do not exist yet. Default privileges cover the platform role (DML on everything) but cannot express "SELECT on these nine tables only".

## Decision

### One CLI for every caller

`@velexis/db` ships `dist/cli/migrate.js`:

| Command | Use |
|---|---|
| `migrate.js platform --dir <path>` | Platform set, schema-qualified files |
| `migrate.js reference --dir <path>` | Reference set |
| `migrate.js tenants --dir <path> [--concurrency 4] [--max-failure-ratio 0.1] [--report <file>]` | Fan-out over `platform.tenants` with status `provisioning`, `active` or `suspended` |
| `migrate.js tenant --schema tenant_<key> --dir <path> [--create]` | One schema: provisioning, tests, repairs |

- The DSN comes from `DATABASE_MIGRATOR_URL` only (role `velexis_migrator`). There is no `--url` flag, so DSNs never appear in process lists.
- Exit codes: `0` success, `1` error, `2` checksum mismatch of an applied file, `3` tenant failure ratio exceeded. Output is one JSON line per file to stdout; `--report` writes the per-tenant summary.
- `pnpm db:migrate` and `pnpm db:migrate:tenants` call it with the repository paths; `velexis-deploy` calls it with the release paths; the OTA worker and `@velexis/testing` call the same library functions (`runMigrations`, `migrateTenants`, `migrateTenantSchema`).

### Repeatable grant files

- The platform and reference sets may contain **repeatable** files named `R__<snake_name>.sql`.
- The runner applies them **after** all numbered files, in name order, whenever their SHA-256 differs from the ledger row. The ledger id is the file name and the phase is `repeatable`.
- A repeatable file may contain only idempotent statements: `GRANT`, `REVOKE`, `COMMENT ON`. No table, column or data changes; those stay numbered files.
- Unlike numbered files, a repeatable file **may be edited**; the edit is re-applied on the next run.
- The tenant set has no repeatable files: tenant privileges are granted by the provisioning step per schema.

The first and only planned file is `platform/backend/migrations/platform/R__ota_read_access.sql` (task X-012). It grants `velexis_ota_app` `SELECT` on `tenants`, `tenant_domains`, `api_keys`, `api_key_tenant_grants`, `tenant_memberships`, `plans`, `supplier_connections`, `payment_provider_connections`, and column-level `SELECT` on the identity and MFA columns of `accounts`. A later platform migration that adds a table or column the OTA backend must read either grants it in that migration ([`conventions.md`](../conventions.md) §9) or extends this file in the same pull request.

Base privileges stay in [`deploy/postgres/bootstrap.sql`](../../../deploy/postgres/bootstrap.sql): schema `USAGE`, default DML privileges for `velexis_platform_app` on `platform` and `reference`, default `SELECT` for `velexis_ota_app` on `reference`.

## Consequences

### Positive

- The platform plan's `0002_add_mvp_platform_deltas.sql` keeps its number, and the foundation baseline stays a pure copy of the reference DDL.
- The OTA read surface is one reviewable file, rather than grants scattered across migrations.
- One entry point for deploys, local development, provisioning and tests, so they cannot drift.

### Negative

- A second kind of migration file to understand. The rules are narrow (privileges and comments only), and the runner rejects other statements by a simple keyword check.
- Repeatable files re-run after every numbered file of a release, so a `REVOKE` there can surprise someone who granted the same privilege in a numbered migration. Code review and the integration test on the OTA role's privileges catch it.

### Follow-ups

- X-011 implements the CLI and the repeatable mechanism; X-012 adds `R__ota_read_access.sql` and an integration test that lists `velexis_ota_app`'s privileges and compares them with ADR-0004.

## Alternatives considered

- **Number the grants `0002` and renumber the platform deltas to `0003`.** It works, but it conflicts with the platform plan written in parallel, and every later grant change would still need its own numbered file.
- **Run a grants script from `deploy.sh` after the migrations.** Outside the ledger, so the test harness, the provisioning job and local development would each need to remember it.
- **Grant `SELECT` on all platform tables to the OTA role, then revoke.** Fails open when a new sensitive table is added.
- **Put the grants in tenant provisioning.** Wrong owner: platform tables belong to the platform backend ([ADR-0003](0003-six-components-two-nestjs-backends.md)).

## References

- [ADR-0004](0004-postgresql-schema-per-tenant.md), [ADR-0005](0005-data-access-kysely-sql-migrations.md), [ADR-0023](0023-release-artefact-and-deploy-user.md)
- [`../deployment-single-vm.md`](../deployment-single-vm.md) §9, [`../../../packages/README.md`](../../../packages/README.md) (`@velexis/db`)
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §4 (runner design)
- Flyway repeatable migrations (the naming convention reused here)
