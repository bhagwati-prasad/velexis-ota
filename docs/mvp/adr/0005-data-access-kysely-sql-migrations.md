# ADR-0005: Data access with Kysely and plain SQL migrations

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Lead architect. Decided during planning; revisit when query code becomes a maintenance burden or a managed database needs a different driver.

## Context

The database design already exists as validated SQL ([`docs/velexis-sdk/db/`](../../velexis-sdk/db/)). Requests run inside a transaction whose `search_path` points at one tenant schema ([ADR-0004](0004-postgresql-schema-per-tenant.md)), and the same table types apply to every tenant schema. We need typed queries that agents can write correctly, explicit transactions, and migrations that stay plain SQL so they match the reference DDL line for line.

## Decision

### Query layer

1. **Kysely** is the query builder, on the **`pg`** driver (node-postgres). There is no ORM: no entities, no lazy loading, no generated migrations.
2. **Table types are generated** with `kysely-codegen` from a freshly migrated local database into `packages/db/src/generated/`: one file each for `platform`, `reference` and the tenant schema (introspected from a template schema). The files are committed. CI regenerates them and fails on a diff.
3. **`@velexis/db`** provides:
   - one `pg.Pool` per app and role (DSN from config);
   - `platformDb` (schema-qualified `platform.*` and `reference.*` queries, short transactions);
   - `tenantTx(fn)`: the only way to touch tenant tables. It opens a transaction, sets the `search_path` with `set_config(…, true)`, sets `statement_timeout`, then runs `fn` with a Kysely transaction typed for the tenant schema;
   - the migration runner (below).
4. **Repositories** in each NestJS module wrap Kysely queries. Controllers and application services never build queries. Complex queries use Kysely's `sql` template tag with bound parameters; string concatenation of SQL is forbidden.
5. **Type parsers:** `numeric` stays a **string** (money is a decimal string in the API, and arithmetic uses `decimal.js`, never JS floats); `int8` stays a string; `timestamptz` becomes `Date`; `jsonb` is parsed.

### Migrations

1. Migrations are **plain SQL files**, `NNNN_snake_case_name.sql`, forward-only. There are no down migrations. A bad migration is fixed by a new one.
2. Locations: `platform/backend/migrations/{platform,reference}/` and `ota/backend/migrations/tenant/` ([ADR-0004](0004-postgresql-schema-per-tenant.md)).
3. **Baselines:** `0001_baseline.sql` of each set is a byte-for-byte copy of `docs/velexis-sdk/db/platform.sql`, `reference.sql` and `tenant.sql`. A unit test asserts that the checksums match, so the reference DDL and the migration cannot drift. Later changes ("deltas" in the plans) are new numbered files.
4. **The runner** (`@velexis/db/migrate`) follows db README §4:
   - every schema has a `schema_migrations` ledger (`id`, `checksum`, `phase`, `applied_at`). The tenant baseline already contains it; the runner creates it for `platform` and `reference` before applying `0001`;
   - applied files are verified by SHA-256 checksum, so an edited file fails the run;
   - each file runs in its own transaction with `lock_timeout = 5s`, unless it starts with `-- velexis:no-transaction` (for `CREATE INDEX CONCURRENTLY`);
   - tenant fan-out takes `pg_advisory_xact_lock(hashtext(schema))`, applies pending files per schema with bounded concurrency (4 at a time on the single VM), records results and continues past a failed schema;
   - the `phase` column records `expand`, `migrate` or `contract` from a header comment `-- velexis:phase expand`.
5. **Expand / contract rule:** code must work with schema versions N-1 and N. Destructive changes ship in a later release than the code that stops using the old shape ([`../conventions.md`](../conventions.md)).
6. **Commands** (names fixed by the foundation plan): `pnpm db:migrate` (platform and reference), `pnpm db:migrate:tenants` (fan-out), `pnpm db:codegen` (regenerate types).

## Consequences

### Positive

- SQL in migrations reads exactly like the reviewed reference DDL.
- Kysely gives compile-time checks on table and column names without hiding SQL, and it works naturally inside an explicit transaction with `search_path` set.
- One table type set serves every tenant schema.

### Negative

- Hand-written SQL migrations need care with locks and long operations. The runner's timeouts and the expand/contract rule limit the damage.
- Generated types depend on a migrated local database, so `pnpm db:codegen` needs PostgreSQL running.
- No down migrations: rolling back code past a migration requires the N-1 compatibility rule to hold.

### Follow-ups

- The foundation plan (M0) builds the runner, the baseline checksum test and `pnpm db:codegen`. The tenant fan-out with ledger mirroring through `platform-tenant-events` lands with provisioning in M1 ([ADR-0009](0009-background-jobs-bullmq.md)).

## Alternatives considered

- **Prisma.** Generates its own migrations, does not fit schema-per-tenant routing with `SET LOCAL search_path`, and adds a query engine binary.
- **TypeORM / MikroORM.** Entity models duplicate the DDL, and their migration generators would fight the reference SQL.
- **Drizzle.** A good typed builder, but its schema-first model means re-declaring 65 tables in TypeScript. Kysely introspects them instead.
- **Raw `pg` only.** No type safety on columns, so agents make more mistakes.
- **node-pg-migrate, Flyway.** The custom runner is about 200 lines and supports the tenant fan-out and both ledgers that db README §4 specifies.

## References

- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §2.1, §4, §5
- [ADR-0004](0004-postgresql-schema-per-tenant.md), [`../conventions.md`](../conventions.md) (migrations section)
- Kysely: <https://kysely.dev>
