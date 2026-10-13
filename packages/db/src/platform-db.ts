// Kysely over a pool for the platform and reference schemas (ADR-0005 item 3).
import { Kysely, PostgresDialect } from "kysely";
import type pg from "pg";

/**
 * A Kysely instance for platform and reference queries. Table names are always schema-qualified
 * (`platform.tenants`, `reference.airports`): the role default `search_path` is `pg_catalog`, so an
 * unqualified name never resolves. Keep transactions short (`db.transaction().execute(...)`).
 *
 * The pool stays the caller's: Kysely's `destroy()` ends it, so when the same pool also serves a tenant
 * database, end it once with `pool.end()` instead.
 */
export function createPlatformDb<DB>(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
