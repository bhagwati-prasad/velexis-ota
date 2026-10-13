// Tenant data access (ADR-0004, ADR-0005, db README §5): one transaction per use case whose search_path is
// set with set_config(..., true), the parameterised form of SET LOCAL. tenantTx is the only way in.
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import type pg from "pg";
import { assertTenantSchema } from "./tenant-schema.js";

/** `statement_timeout` of a tenant transaction unless the caller passes another one. */
export const DEFAULT_TENANT_STATEMENT_TIMEOUT_MS = 5000;

/** PostgreSQL's integer settings (statement_timeout) stop at 2^31 - 1 milliseconds. */
const MAX_PG_INT = 2_147_483_647;

export interface CreateTenantDbOptions {
  /**
   * `APP_ENV` of the process. The search_path leak guard runs in every environment except `production`,
   * and also when no value is given.
   */
  readonly appEnv?: string | undefined;
}

export interface TenantTxOptions {
  /** `statement_timeout` of this transaction in milliseconds (transaction-local). Default 5000. */
  readonly statementTimeoutMs?: number | undefined;
}

/**
 * The leak guard found a pooled connection whose `search_path` is not the role default at the start of a
 * tenant transaction: some code ran a session-level `SET search_path` (or `set_config(…, false)`) on it.
 * Only thrown outside production. The connection keeps the leaked value, so fix the code that set it.
 */
export class SearchPathLeakError extends Error {
  override readonly name = "SearchPathLeakError";
  /** The connection's `search_path` when `tenantTx` started. */
  readonly searchPath: string;
  /** The role default it must be back to (`pg_catalog` for `velexis_ota_app`). */
  readonly roleDefault: string;

  constructor(searchPath: string, roleDefault: string) {
    super(
      `tenantTx found search_path ${JSON.stringify(searchPath)} on a pooled connection instead of the role ` +
        `default ${JSON.stringify(roleDefault)}: a session-level SET search_path leaked. Reach tenant data ` +
        "only through tenantTx (ADR-0004).",
    );
    this.searchPath = searchPath;
    this.roleDefault = roleDefault;
  }
}

interface TenantDbInternals<DB> {
  readonly kysely: Kysely<DB>;
  readonly leakGuard: boolean;
}

let newTenantDb!: <DB>(pool: pg.Pool, leakGuard: boolean) => TenantDb<DB>;
let internalsOf!: <DB>(db: TenantDb<DB>) => TenantDbInternals<DB>;

declare const tenantTables: unique symbol;

/**
 * An opaque handle on a pool for tenant transactions, created by `createTenantDb`. It has no query methods:
 * tenant tables are reachable only inside `tenantTx`, never through an unscoped Kysely instance.
 */
export class TenantDb<DB> {
  /** Type-only: the tenant table types, so handles of different databases do not mix. Never set. */
  declare readonly [tenantTables]?: DB;
  readonly #kysely: Kysely<DB>;
  readonly #leakGuard: boolean;

  private constructor(kysely: Kysely<DB>, leakGuard: boolean) {
    this.#kysely = kysely;
    this.#leakGuard = leakGuard;
  }

  static {
    newTenantDb = <DB>(pool: pg.Pool, leakGuard: boolean): TenantDb<DB> =>
      new TenantDb<DB>(new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }), leakGuard);
    internalsOf = <DB>(db: TenantDb<DB>): TenantDbInternals<DB> => ({
      kysely: db.#kysely,
      leakGuard: db.#leakGuard,
    });
  }
}

/**
 * Creates the tenant database handle over `pool` (the OTA backend's pool, role `velexis_ota_app`). The pool
 * stays the caller's: end it with `pool.end()` at shutdown.
 */
export function createTenantDb<DB>(pool: pg.Pool, options: CreateTenantDbOptions = {}): TenantDb<DB> {
  return newTenantDb<DB>(pool, options.appEnv !== "production");
}

/**
 * Runs `fn` in one transaction on the tenant schema `schema` (`tenant_<key>`, from the resolved tenant, never
 * from user input):
 *
 * 1. the schema name is validated (`assertTenantSchema`) before any SQL runs;
 * 2. outside production, the leak guard checks that the connection's `search_path` is the role default;
 * 3. `SELECT set_config('search_path', $1, true)` with `"<schema>, reference"`, then the same for
 *    `statement_timeout`: both end with the transaction, so the pooled connection carries no tenant;
 * 4. `fn(trx)`; the transaction commits when it resolves and rolls back when it throws.
 *
 * No identifier is ever concatenated into SQL: the schema travels as a bound parameter.
 */
export async function tenantTx<DB, T>(
  db: TenantDb<DB>,
  schema: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
  options: TenantTxOptions = {},
): Promise<T> {
  assertTenantSchema(schema);
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_TENANT_STATEMENT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1 ||
    statementTimeoutMs > MAX_PG_INT
  ) {
    throw new TypeError(`tenantTx: statementTimeoutMs must be an integer from 1 to ${MAX_PG_INT}`);
  }
  const { kysely, leakGuard } = internalsOf(db);
  return await kysely.transaction().execute(async (trx) => {
    if (leakGuard) {
      await assertNoSearchPathLeak(trx);
    }
    await sql`SELECT set_config('search_path', ${schema + ", reference"}, true)`.execute(trx);
    await sql`SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`.execute(trx);
    return await fn(trx);
  });
}

interface SearchPathRow {
  readonly search_path: string;
  readonly role_default: string;
}

/**
 * The leak guard: the connection's current `search_path` must equal its reset value, the role default
 * (`ALTER ROLE velexis_ota_app SET search_path = pg_catalog`). Anything else means a session-level change
 * survived on a pooled connection.
 */
async function assertNoSearchPathLeak<DB>(trx: Transaction<DB>): Promise<void> {
  const { rows } = await sql<SearchPathRow>`
    SELECT current_setting('search_path') AS search_path, reset_val AS role_default
    FROM pg_catalog.pg_settings
    WHERE name = 'search_path'
  `.execute(trx);
  const [row] = rows;
  if (row === undefined) {
    throw new Error("tenantTx: pg_catalog.pg_settings has no search_path row");
  }
  if (row.search_path !== row.role_default) {
    throw new SearchPathLeakError(row.search_path, row.role_default);
  }
}
