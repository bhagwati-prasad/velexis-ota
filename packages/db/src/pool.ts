// One pg.Pool per app and role (ADR-0004, ADR-0005), with the Velexis type parsers on the pool itself.
import type { Logger } from "@velexis/logger";
import pg from "pg";
import { createTypeParsers } from "./type-parsers.js";

/** The logger methods a pool needs: idle client errors are logged, never thrown. */
export type PoolLogger = Pick<Logger, "error">;

export interface CreatePoolOptions {
  /** `application_name` of every connection (`pg_stat_activity`): `ota-api`, `ota-worker`, `platform-api`, … */
  readonly applicationName: string;
  /** Where idle client errors go (a dropped connection, a PostgreSQL restart). The connection URL is never logged. */
  readonly logger: PoolLogger;
  /** Maximum number of connections. Default 10. */
  readonly max?: number | undefined;
  /**
   * Session `statement_timeout` in milliseconds for queries outside `tenantTx` (platformDb, health checks).
   * `tenantTx` sets its own per transaction. Default 30 000.
   */
  readonly statementTimeoutMs?: number | undefined;
  /** How long an unused connection stays open, in milliseconds. Default 10 000. */
  readonly idleTimeoutMillis?: number | undefined;
  /** How long a caller waits for a free connection before an error, in milliseconds. Default 10 000. */
  readonly connectionTimeoutMillis?: number | undefined;
}

export const POOL_DEFAULTS = Object.freeze({
  max: 10,
  statementTimeoutMs: 30_000,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

/** PostgreSQL's integer settings (statement_timeout) stop at 2^31 - 1 milliseconds. */
const MAX_PG_INT = 2_147_483_647;

/**
 * Creates a `pg.Pool` for `url` (a `postgres://` DSN from `@velexis/config`). The type parsers are installed
 * on this pool's own `types` object (numeric and int8 as strings, timestamptz as `Date`, jsonb parsed); the
 * global `pg.types` stays untouched. Idle client errors are logged instead of crashing the process. The
 * caller owns the pool and ends it once at shutdown (`await pool.end()`).
 */
export function createPool(url: string, options: CreatePoolOptions): pg.Pool {
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("createPool: url must be a non-empty postgres:// connection string");
  }
  const { applicationName, logger } = options;
  if (typeof applicationName !== "string" || applicationName.trim() === "") {
    throw new TypeError("createPool: applicationName must be a non-empty process name");
  }
  const max = positiveInt("max", options.max ?? POOL_DEFAULTS.max);
  const statementTimeoutMs = positiveInt(
    "statementTimeoutMs",
    options.statementTimeoutMs ?? POOL_DEFAULTS.statementTimeoutMs,
  );
  const idleTimeoutMillis = positiveInt(
    "idleTimeoutMillis",
    options.idleTimeoutMillis ?? POOL_DEFAULTS.idleTimeoutMillis,
  );
  const connectionTimeoutMillis = positiveInt(
    "connectionTimeoutMillis",
    options.connectionTimeoutMillis ?? POOL_DEFAULTS.connectionTimeoutMillis,
  );

  const pool = new pg.Pool({
    connectionString: url,
    application_name: applicationName,
    max,
    statement_timeout: statementTimeoutMs,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    types: createTypeParsers(),
  });
  // Without a listener an error on an idle client (PostgreSQL restarted, connection dropped) is an unhandled
  // 'error' event and stops the process. pg-pool has already discarded that client.
  pool.on("error", (err) => {
    logger.error({ err, applicationName }, "db.pool.idle_client_error");
  });
  return pool;
}

function positiveInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PG_INT) {
    throw new TypeError(`createPool: ${name} must be an integer from 1 to ${MAX_PG_INT}`);
  }
  return value;
}
