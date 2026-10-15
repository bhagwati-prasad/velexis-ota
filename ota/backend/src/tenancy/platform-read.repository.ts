// The read-only platform repository of the OTA backend (OADR-0009 points 4 and 5, platform architecture §6.2). The
// OTA backend reads the platform tables it needs as velexis_ota_app, which has SELECT on them and nothing else
// (ADR-0004), and never writes one (ADR-0003). Each method runs one short read-only transaction on `platformDb`, so
// a lookup holds no lock and no connection longer than its query; the tenancy caches (OBE-012) sit in front of it,
// and when Redis is down the lookups come here directly. API keys joined in OBE-011 (`apiKeyByPrefix`, for the key
// verifier); later tasks add domains, memberships and connections to this class.
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

/** `platform.api_keys.kind`: `pk_`, `sk_` and `hk_` keys (the CHECK of the baseline). */
export const API_KEY_KINDS = ["publishable", "secret", "hosting"] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

/** `platform.api_keys.environment`. */
export const API_KEY_ENVIRONMENTS = ["test", "live"] as const;
export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number];

/**
 * The visible prefix of an API key, its first 14 characters (`sk_test_Ab12Cd`, PADR-0005 item 2): what
 * `apiKeyByPrefix` looks up. The rule of `redis.keys.ts` (`apikey:<prefix>`).
 */
export const API_KEY_PREFIX_PATTERN = /^(?:pk|sk|hk)_(?:test|live)_[A-Za-z0-9]{6}$/;

/**
 * A row of `platform.api_keys`, as far as the key verifier relies on it: plain and JSON-safe, so the tenancy caches
 * can store it as it is (OADR-0009 point 4). `keyHash` is the HMAC of the full key with the server pepper (PADR-0005
 * item 3); the key itself is never stored anywhere.
 */
export interface PlatformApiKey {
  /** `key_` + ULID. */
  readonly id: string;
  /** The tenant the key resolves to; `null` only for hosting keys. */
  readonly tenantId: string | null;
  readonly kind: ApiKeyKind;
  readonly environment: ApiKeyEnvironment;
  readonly prefix: string;
  /** `hex(HMAC-SHA-256(pepper, key))`, 64 lower-case hex characters. */
  readonly keyHash: string;
  /** Exact browser origins (`https://travel.example.net`) of a publishable key; empty for the others. */
  readonly allowedOrigins: readonly string[];
  /** `ConsoleApiKeyScope` and `StaffPermission` values of the OTA document (secret keys). */
  readonly scopes: readonly string[];
  /** ISO 8601 instant after which the key is refused (a rolled key), or `null`. */
  readonly expiresAt: string | null;
  /** ISO 8601 instant of the revocation, or `null` while the key is valid. */
  readonly revokedAt: string | null;
}

/** The columns of `platform.api_keys` that `PlatformApiKey` maps. */
const API_KEY_COLUMNS = [
  "id",
  "tenant_id",
  "kind",
  "environment",
  "prefix",
  "key_hash",
  "allowed_origins",
  "scopes",
  "expires_at",
  "revoked_at",
] as const;

type ApiKeyRow = Pick<Selectable<PlatformDatabase["platform.api_keys"]>, (typeof API_KEY_COLUMNS)[number]>;

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
   * The API key with this prefix (`sk_test_Ab12Cd`), or `null` when there is none. The prefix is unique (PADR-0005
   * item 2). A value that cannot be a prefix is unknown without a query. The row is returned whatever its state:
   * revocation, expiry, origins and scopes are the verifier's checks.
   */
  async apiKeyByPrefix(prefix: string): Promise<PlatformApiKey | null> {
    if (!API_KEY_PREFIX_PATTERN.test(prefix)) {
      return null;
    }
    const row = await this.read((trx) =>
      trx
        .selectFrom("platform.api_keys")
        .select(API_KEY_COLUMNS)
        .where("prefix", "=", prefix)
        .executeTakeFirst(),
    );
    return row === undefined ? null : toPlatformApiKey(row);
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

/**
 * Maps a `platform.api_keys` row. A kind or environment outside the CHECK lists throws `UnexpectedPlatformValueError`;
 * the timestamps become ISO strings and the arrays frozen copies.
 */
function toPlatformApiKey(row: ApiKeyRow): PlatformApiKey {
  const column = (name: string) => `platform.api_keys.${name}`;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    kind: oneOf(row.kind, API_KEY_KINDS, column("kind"), row.id),
    environment: oneOf(row.environment, API_KEY_ENVIRONMENTS, column("environment"), row.id),
    prefix: row.prefix,
    keyHash: row.key_hash,
    allowedOrigins: Object.freeze([...row.allowed_origins]),
    scopes: Object.freeze([...row.scopes]),
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
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
