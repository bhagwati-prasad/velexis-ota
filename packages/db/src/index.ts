// @velexis/db: pools, platformDb and tenantTx (X-010). Migrations: @velexis/db/migrate (X-011);
// storage: @velexis/db/storage. Design: ADR-0004, ADR-0005, packages/db/README.md.
export { createPool, POOL_DEFAULTS, type CreatePoolOptions, type PoolLogger } from "./pool.js";
export {
  createTypeParsers,
  parseDecimalArray,
  parseTimestamptz,
  PG_TYPE_OID,
  type DecimalArray,
} from "./type-parsers.js";
export { createPlatformDb } from "./platform-db.js";
export {
  createTenantDb,
  tenantTx,
  SearchPathLeakError,
  DEFAULT_TENANT_STATEMENT_TIMEOUT_MS,
  type TenantDb,
  type CreateTenantDbOptions,
  type TenantTxOptions,
} from "./tenant-db.js";
export {
  assertTenantSchema,
  isTenantSchema,
  InvalidTenantSchemaError,
  TENANT_SCHEMA_PATTERN,
  type TenantSchema,
} from "./tenant-schema.js";
// Query building: the same Kysely as the pools, so apps need no second copy.
export { sql, type Kysely, type Transaction } from "kysely";
