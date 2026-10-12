# ADR-0004: PostgreSQL schema per tenant

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (schema per OTA, ownership), lead architect (roles and MVP simplifications)

## Context

[`decisions.md`](../decisions.md) §5 chooses one PostgreSQL schema per OTA (`tenant_<key>`) as designed in [`docs/velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md). That design was validated on PostgreSQL 16 with the baseline DDL in `platform.sql` (16 tables), `reference.sql` (7) and `tenant.sql` (42). It covers provisioning, the migration runner, request routing with `SET LOCAL search_path`, background jobs, backups and security.

The design assumes one NestJS app with DML on everything. The MVP has two backends with split ownership and runs on a single VM ([ADR-0003](0003-six-components-two-nestjs-backends.md), [ADR-0007](0007-single-vm-without-docker.md)). This ADR records what we keep, what we change, and the database roles.

## Decision

### Kept from the reference design

- Schemas `platform`, `reference` and one `tenant_<key>` per OTA, no foreign key across schemas, prefixed ULID ids, `text` + `CHECK` statuses, `version` columns for optimistic locking.
- Routing as in db README §5: resolve the tenant, load it from Redis, run the use case in one transaction that first calls `SELECT set_config('search_path', '<schema>, reference', true)`. No identifier is concatenated into SQL. The schema name is validated against `^tenant_[a-z][a-z0-9_]{1,39}$`.
- Leak guards: session-level `SET search_path` is forbidden (CI grep outside `packages/db`), `ALTER ROLE velexis_ota_app SET search_path = pg_catalog`, a pool `release` hook assertion in dev and test, and an integration test that runs two tenants through a pool of size 1.
- Redis keys for tenant state are namespaced `t:<tenantId>:<env>:…`.

### Changed for the MVP

| Reference design | MVP |
|---|---|
| One app role `velexis_app` with DML on all schemas | Three login roles, one per responsibility (below) |
| Provisioning steps run by one worker that writes `platform` and the tenant schema | The platform backend writes the platform rows; the OTA worker runs `create_schema`, `run_migrations` and `seed_defaults`; results come back through a queue ([ADR-0009](0009-background-jobs-bullmq.md)) |
| Several clusters, PgBouncer, per-tenant roles | One local PostgreSQL 16, one database `velexis`, `pg.Pool` per app without PgBouncer, **no per-tenant roles** |
| Default sub-domain `<key>.velexis.app` | `<key>.ota.example.com` ([`decisions.md`](../decisions.md) §4) |
| pgBackRest WAL archiving | Nightly logical dumps copied off the VM ([ADR-0007](0007-single-vm-without-docker.md)) |

The `region` and `cluster` columns of `platform.tenants` stay, with one constant value, so a second cluster later is a data change, not a schema change.

### Database roles

| Role | Used by | Privileges |
|---|---|---|
| `velexis_migrator` | Migration commands of both backends, OTA provisioning step | Owns `platform`, `reference` and every `tenant_<key>`. `CREATE` on the database. Runs DDL only. Never used to serve requests. |
| `velexis_platform_app` | Platform backend API and worker | DML on `platform`, DML on `reference` (reference data loaders). **No privileges on tenant schemas.** |
| `velexis_ota_app` | OTA backend API and worker | DML on tenant schemas (granted per schema during provisioning, with default privileges for future tables). `SELECT` on `reference`. `SELECT` only on the platform tables it needs: `tenants`, `tenant_domains`, `api_keys`, `api_key_tenant_grants`, `tenant_memberships`, `accounts` (identity and MFA columns), `plans`, `supplier_connections`, `payment_provider_connections`, plus the shared Amadeus account tables of [ADR-0012](0012-amadeus-account-model.md). Default `search_path = pg_catalog`. |

Passwords are in the apps' environment files on the VM ([ADR-0010](0010-secrets-envelope-encryption.md)). PostgreSQL listens on `127.0.0.1` only and requires `scram-sha-256`.

### Migration ownership

- `platform/backend/migrations/platform/` and `platform/backend/migrations/reference/`: schema-qualified SQL, applied once, by the platform deploy step.
- `ota/backend/migrations/tenant/`: unqualified SQL, applied to every tenant schema by the OTA provisioning job and by the tenant fan-out on deploy.
- `0001_baseline.sql` of each set is the corresponding file from `docs/velexis-sdk/db/`, unchanged ([ADR-0005](0005-data-access-kysely-sql-migrations.md)).

## Consequences

### Positive

- The database itself enforces "the platform never writes tenant schemas" and "the OTA reads platform tables read-only".
- Each OTA can be dumped, restored or erased on its own (`pg_dump -n`, `DROP SCHEMA … CASCADE`).
- The reference design, its DDL and its checks are reused instead of redone.

### Negative

- The catalog grows by about 320 relations per tenant. That is fine for hundreds of tenants on one VM; db README §9 gives the limits.
- Tenant migrations fan out over every schema at deploy time, so deploys get slower as tenants grow.
- Without per-tenant roles, a bug that schema-qualifies another tenant's table is not stopped by the database. The `search_path` routing, the code review rule "no schema-qualified tenant SQL" and the isolation test cover it.

### Follow-ups

- Decided during planning; revisit per-tenant roles when an enterprise plan requires them, PgBouncer when the apps together hold more than about 80 connections, and a second cluster or a managed database when the VM's disk or IOPS become the bottleneck.

## Alternatives considered

- **Shared tables with `tenant_id` and row-level security.** Rejected in db README §1: one missing predicate leaks data, and per-tenant export and erasure are harder.
- **Database per tenant.** Stronger isolation but one pool per tenant. Too heavy for a single VM.
- **One app role for both backends.** Simpler, but loses the ownership boundary that `decisions.md` §5 asks for.

## References

- [`../decisions.md`](../decisions.md) §3, §5
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md), [`dictionary.json`](../../velexis-sdk/db/dictionary.json), [`er/`](../../velexis-sdk/db/er/)
- [`../../velexis-sdk/db/platform.sql`](../../velexis-sdk/db/platform.sql), [`reference.sql`](../../velexis-sdk/db/reference.sql), [`tenant.sql`](../../velexis-sdk/db/tenant.sql)
- [ADR-0005](0005-data-access-kysely-sql-migrations.md), [ADR-0009](0009-background-jobs-bullmq.md)
