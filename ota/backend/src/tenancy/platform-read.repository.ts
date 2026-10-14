// The read-only platform repository of the OTA backend (OADR-0009 points 4 and 5, platform architecture §6.2). The
// OTA backend reads the platform tables it needs as velexis_ota_app, which has SELECT on them and nothing else
// (ADR-0004), and never writes one (ADR-0003). Each method runs one short read-only transaction on `platformDb`, so
// a lookup holds no lock and no connection longer than its query; the tenancy caches (OBE-012) sit in front of it,
// and when Redis is down the lookups come here directly. Later tasks add domains, API keys, memberships and
// connections to this class.
import { Inject, Injectable } from "@nestjs/common";
import {
  assertTenantSchema,
  isTenantSchema,
  sql,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
  type Selectable,
  type Transaction,
} from "@velexis/db";
import {
  BILLING_NOTICES,
  STOREFRONT_ENVIRONMENTS,
  TENANT_STATUSES,
  UnexpectedPlatformValueError,
  type PlatformTenant,
} from "./platform-read.types";

/** Kysely over the pool of velexis_ota_app for the schema-qualified platform and reference tables. */
export type PlatformDb = Kysely<PlatformDatabase & ReferenceDatabase>;

/** Injection token of the `PlatformDb` of `TenancyModule`. */
export const PLATFORM_DB = "PLATFORM_DB";

/**
 * `statement_timeout` of every platform read, in milliseconds (`set_config(…, true)`, so it ends with the transaction).
 * A primary-key or unique-key lookup takes well under a millisecond; one that waits longer, behind a lock or an
 * overloaded server, fails fast, and the request answers 503 instead of holding its connection.
 */
export const PLATFORM_READ_STATEMENT_TIMEOUT_MS = 2_000;

/** The columns of `platform.tenants` that `PlatformTenant` maps. */
const TENANT_COLUMNS = [
  "id",
  "key",
  "name",
  "status",
  "schema_name",
  "storefront_environment",
  "default_currency",
  "default_locale",
  "billing_notice",
] as const;

type TenantRow = Pick<Selectable<PlatformDatabase["platform.tenants"]>, (typeof TENANT_COLUMNS)[number]>;

@Injectable()
export class PlatformReadRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The tenant with this id (`ten_…`), or `null` when there is none. */
  async tenantById(id: string): Promise<PlatformTenant | null> {
    const row = await this.read((trx) =>
      trx.selectFrom("platform.tenants").select(TENANT_COLUMNS).where("id", "=", id).executeTakeFirst(),
    );
    return row === undefined ? null : toPlatformTenant(row);
  }

  /**
   * The tenant with this key, or `null` when there is none. A value that cannot be a key, because `tenant_<value>`
   * would not be a valid schema name (a host label with upper case or a dot, an empty string), is unknown without a
   * query.
   */
  async tenantByKey(key: string): Promise<PlatformTenant | null> {
    if (!isTenantSchema(`tenant_${key}`)) {
      return null;
    }
    const row = await this.read((trx) =>
      trx.selectFrom("platform.tenants").select(TENANT_COLUMNS).where("key", "=", key).executeTakeFirst(),
    );
    return row === undefined ? null : toPlatformTenant(row);
  }

  /**
   * Runs `query` in its own read-only transaction (`START TRANSACTION READ ONLY`) with the short statement timeout.
   * Rows are mapped after the commit, so a refused row never keeps the transaction open.
   */
  private read<T>(query: (trx: Transaction<PlatformDatabase & ReferenceDatabase>) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setAccessMode("read only")
      .execute(async (trx) => {
        await sql`SELECT set_config('statement_timeout', ${String(PLATFORM_READ_STATEMENT_TIMEOUT_MS)}, true)`.execute(
          trx,
        );
        return await query(trx);
      });
  }
}

/**
 * Maps a `platform.tenants` row. The schema name is checked with `assertTenantSchema` first: a malformed one throws
 * `InvalidTenantSchemaError`, so no caller ever gets it to pass to `tenantTx` or to any other SQL. A status,
 * environment or billing notice outside the CHECK lists throws `UnexpectedPlatformValueError`.
 */
function toPlatformTenant(row: TenantRow): PlatformTenant {
  const schemaName = row.schema_name;
  assertTenantSchema(schemaName);
  const column = (name: string) => `platform.tenants.${name}`;
  return Object.freeze({
    id: row.id,
    key: row.key,
    name: row.name,
    status: oneOf(row.status, TENANT_STATUSES, column("status"), row.id),
    schemaName,
    storefrontEnvironment: oneOf(
      row.storefront_environment,
      STOREFRONT_ENVIRONMENTS,
      column("storefront_environment"),
      row.id,
    ),
    defaultCurrency: row.default_currency,
    defaultLocale: row.default_locale,
    billingNotice:
      row.billing_notice === null
        ? null
        : oneOf(row.billing_notice, BILLING_NOTICES, column("billing_notice"), row.id),
  });
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

function oneOf<T extends string>(value: string, allowed: readonly T[], column: string, rowId: string): T {
  if (isOneOf(value, allowed)) {
    return value;
  }
  throw new UnexpectedPlatformValueError(column, rowId, value, allowed);
}
