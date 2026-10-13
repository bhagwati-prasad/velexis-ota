// Tenant schema names (ADR-0004, db README §5): `tenant_<key>`, validated before any SQL runs.

declare const tenantSchemaBrand: unique symbol;

/** A schema name that passed `assertTenantSchema`: `tenant_` + a lowercase key of 2 to 40 characters. */
export type TenantSchema = string & { readonly [tenantSchemaBrand]: true };

/**
 * The only accepted shape of a tenant schema name (ADR-0004): `tenant_`, a lowercase letter, then 1 to 39
 * lowercase letters, digits or underscores. At most 47 characters, well inside PostgreSQL's 63-byte limit,
 * and never in need of quoting, so `public`, `platform`, `reference`, `pg_*` and anything with quotes,
 * spaces, semicolons or upper case are rejected.
 */
export const TENANT_SCHEMA_PATTERN = /^tenant_[a-z][a-z0-9_]{1,39}$/;

/** Thrown when a value is not a valid tenant schema name. Nothing has been sent to the database. */
export class InvalidTenantSchemaError extends Error {
  override readonly name = "InvalidTenantSchemaError";

  constructor(value: unknown) {
    super(`Invalid tenant schema name ${describe(value)}: it must match ${String(TENANT_SCHEMA_PATTERN)}`);
  }
}

/** True when `value` is a valid tenant schema name. */
export function isTenantSchema(value: unknown): value is TenantSchema {
  return typeof value === "string" && TENANT_SCHEMA_PATTERN.test(value);
}

/** Throws `InvalidTenantSchemaError` unless `value` is a valid tenant schema name. */
export function assertTenantSchema(value: unknown): asserts value is TenantSchema {
  if (!isTenantSchema(value)) {
    throw new InvalidTenantSchemaError(value);
  }
}

const MAX_SHOWN = 64;

/** The rejected value for the error message: a quoted, shortened string, or its type. */
function describe(value: unknown): string {
  if (typeof value !== "string") {
    return value === null ? "(null)" : `(${typeof value})`;
  }
  return value.length > MAX_SHOWN ? `${JSON.stringify(value.slice(0, MAX_SHOWN))}…` : JSON.stringify(value);
}
