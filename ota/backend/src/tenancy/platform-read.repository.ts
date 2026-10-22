// The read-only platform repository of the OTA backend (OADR-0009 points 4 and 5, platform architecture §6.2). The
// OTA backend reads the platform tables it needs as velexis_ota_app, which has SELECT on them and nothing else
// (ADR-0004), and never writes one (ADR-0003). Each method runs one short read-only transaction on `platformDb`, so
// a lookup holds no lock and no connection longer than its query; the tenancy caches (platform-cache.ts, OBE-012) sit
// in front of it, and when Redis is down the lookups come here directly. API keys joined in OBE-011 (`apiKeyByPrefix`,
// for the key verifier), verified storefront domains in OBE-012 (`tenantIdByStorefrontHost`, for the tenant
// resolver), the Amadeus connection and the shared Amadeus account in OBE-017 (`amadeusConnection`,
// `amadeusAccountById`, for the connection resolver of src/amadeus/), the tenants a scheduled job fans out to in
// OBE-024 (`tenantIdsByStatus`, for src/jobs/fan-out.ts), the default payment connection of an environment in OBE-038
// (`paymentConnection`, for the Stripe gateway of src/payments/), a staff member's membership with its account in
// OBE-059 (`staffMember`, for the staff sessions of src/identity/staff/), and the account modes of a tenant's payment
// connections in OBE-068 (`paymentConnectionModes`, for console.payments of src/console/).
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
  type TenantStatus,
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

/** `platform.supplier_connections.environment` and `platform.amadeus_accounts.environment`. */
export const AMADEUS_ENVIRONMENTS = ["test", "live"] as const;
export type AmadeusEnvironment = (typeof AMADEUS_ENVIRONMENTS)[number];

/**
 * `platform.supplier_connections.credential_source` (ADR-0012): `velexis`, the Velexis shared account of the
 * environment through the tenant's assigned office; `tenant`, the OTA's own credentials (M5, OBE-079).
 */
export const CREDENTIAL_SOURCES = ["velexis", "tenant"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** The `status` of a supplier connection and of a shared Amadeus account: the health of its credentials. */
export const AMADEUS_CREDENTIAL_STATUSES = [
  "pending_verification",
  "active",
  "invalid_credentials",
  "disabled",
] as const;
export type AmadeusCredentialStatus = (typeof AMADEUS_CREDENTIAL_STATUSES)[number];

/**
 * A tenant's Amadeus connection of one environment (`platform.supplier_connections`, provider `amadeus`), as far as
 * the connection resolver relies on it (OBE-017): plain and JSON-safe, so the `conn:amadeus:` cache stores it as it
 * is. The client secret stays the platform's envelope ciphertext, as base64 text; it is never decrypted to be read or
 * cached. With `credentialSource = velexis` the four credential fields are `null` and `amadeusAccountId` names the
 * shared account (the CHECK `supplier_connections_source_ck`); with `tenant` it is the other way round.
 */
export interface PlatformAmadeusConnection {
  /** `sc_` + ULID: the credential id of a `tenant` connection. */
  readonly id: string;
  readonly tenantId: string;
  readonly environment: AmadeusEnvironment;
  readonly credentialSource: CredentialSource;
  /** `ama_` + ULID, the shared account of the environment (`velexis` only). */
  readonly amadeusAccountId: string | null;
  readonly baseUrl: string | null;
  readonly clientId: string | null;
  /** base64 of `client_secret_ciphertext` (`tenant` only). */
  readonly clientSecretCiphertext: string | null;
  /** The offices the connection may act for. */
  readonly officeIds: readonly string[];
  /** The office of queue reads and PNR retrieval when the caller names none. */
  readonly defaultOfficeId: string | null;
  /** `queuingOfficeId` of new flight orders. */
  readonly queuingOfficeId: string | null;
  /** `ownerOfficeId` of new flight orders. */
  readonly ownerOfficeId: string | null;
  readonly status: AmadeusCredentialStatus;
}

/** The columns of `platform.supplier_connections` that `PlatformAmadeusConnection` maps. */
const AMADEUS_CONNECTION_COLUMNS = [
  "id",
  "tenant_id",
  "environment",
  "credential_source",
  "amadeus_account_id",
  "base_url",
  "client_id",
  "client_secret_ciphertext",
  "office_ids",
  "default_office_id",
  "queuing_office_id",
  "owner_office_id",
  "status",
] as const;

type AmadeusConnectionRow = Pick<
  Selectable<PlatformDatabase["platform.supplier_connections"]>,
  (typeof AMADEUS_CONNECTION_COLUMNS)[number]
>;

/**
 * The Velexis shared Amadeus account of one environment (`platform.amadeus_accounts`, ADR-0012), as the connection
 * resolver relies on it: plain and JSON-safe for the `amadeus:acct:` cache, the client secret as base64 ciphertext.
 */
export interface PlatformAmadeusAccount {
  /** `ama_` + ULID: the credential id of every connection on the shared account. */
  readonly id: string;
  readonly environment: AmadeusEnvironment;
  /** The Amadeus host (`https://…`), or the loopback stub in development. */
  readonly baseUrl: string;
  readonly clientId: string;
  /** base64 of `client_secret_ciphertext`, encrypted by the platform for `platform.amadeus_accounts.<column>:<id>`. */
  readonly clientSecretCiphertext: string;
  readonly status: AmadeusCredentialStatus;
}

/** The columns of `platform.amadeus_accounts` that `PlatformAmadeusAccount` maps. */
const AMADEUS_ACCOUNT_COLUMNS = [
  "id",
  "environment",
  "base_url",
  "client_id",
  "client_secret_ciphertext",
  "status",
] as const;

type AmadeusAccountRow = Pick<
  Selectable<PlatformDatabase["platform.amadeus_accounts"]>,
  (typeof AMADEUS_ACCOUNT_COLUMNS)[number]
>;

/** `platform.payment_provider_connections.provider` (the baseline CHECK). */
export const PAYMENT_PROVIDERS = ["stripe", "adyen", "checkout_com", "paypal", "manual"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * `platform.payment_provider_connections.account_mode` (ADR-0011 (A)): whose Stripe account takes the payments, the
 * Velexis account (`velexis`, M3) or the OTA's own (`connect_standard`, `api_keys`, M5).
 */
export const PAYMENT_ACCOUNT_MODES = ["velexis", "connect_standard", "api_keys"] as const;
export type PaymentAccountMode = (typeof PAYMENT_ACCOUNT_MODES)[number];

/** `platform.payment_provider_connections.status`: the health of the connection. */
export const PAYMENT_CONNECTION_STATUSES = ["pending", "active", "disabled", "error"] as const;
export type PaymentConnectionStatus = (typeof PAYMENT_CONNECTION_STATUSES)[number];

/** `platform.payment_provider_connections.capture_mode`. */
export const PAYMENT_CAPTURE_MODES = ["automatic", "manual"] as const;
export type PaymentCaptureMode = (typeof PAYMENT_CAPTURE_MODES)[number];

/**
 * A tenant's default payment connection of one environment (`platform.payment_provider_connections`, OADR-0010 point
 * 1), as far as the payment gateway relies on it (OBE-038): plain and JSON-safe, so the `conn:payment:` cache stores it
 * as it is. The secret columns (`secret_ciphertext`, `webhook_secret_ciphertext`, which only the `api_keys` mode of M5
 * fills) are never selected; the `velexis` mode uses Velexis's keys from the environment file.
 */
export interface PlatformPaymentConnection {
  /** `ppc_` + ULID. */
  readonly id: string;
  readonly tenantId: string;
  readonly provider: PaymentProvider;
  readonly environment: AmadeusEnvironment;
  readonly accountMode: PaymentAccountMode;
  /** The OTA's `acct_…` (`connect_standard`, `api_keys`); `null` in `velexis` mode. */
  readonly accountReference: string | null;
  /** The OTA's own publishable key (`api_keys` mode only). */
  readonly publishableKey: string | null;
  /** The methods enabled on the connection (`card`, …). */
  readonly supportedMethods: readonly string[];
  readonly captureMode: PaymentCaptureMode;
  readonly status: PaymentConnectionStatus;
  /** The card statement descriptor suffix with the OTA's brand (`velexis` mode), or `null`. */
  readonly statementDescriptorSuffix: string | null;
}

/** The columns of `platform.payment_provider_connections` that `PlatformPaymentConnection` maps. */
const PAYMENT_CONNECTION_COLUMNS = [
  "id",
  "tenant_id",
  "provider",
  "environment",
  "account_mode",
  "account_reference",
  "publishable_key",
  "supported_methods",
  "capture_mode",
  "status",
  "statement_descriptor_suffix",
] as const;

type PaymentConnectionRow = Pick<
  Selectable<PlatformDatabase["platform.payment_provider_connections"]>,
  (typeof PAYMENT_CONNECTION_COLUMNS)[number]
>;

/** `platform.tenant_memberships.role`: the console roles (scope §1.3), the contract's `StaffRole`. */
export const STAFF_ROLES = ["owner", "admin", "agent", "finance", "viewer"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** `platform.tenant_memberships.status`. Only `active` members hold staff sessions (OADR-0011 point 3). */
export const MEMBERSHIP_STATUSES = ["active", "suspended", "removed"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** `platform.accounts.status`. Only `active` accounts sign in to the console. */
export const ACCOUNT_STATUSES = ["pending_verification", "active", "locked", "disabled", "deleted"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * The portal account of a staff member (`platform.accounts`), as far as the console shows it. Only the columns
 * velexis_ota_app may read (R__ota_read_access.sql): never the password hash, the TOTP secret or the security counters.
 */
export interface PlatformStaffAccount {
  readonly email: string;
  readonly fullName: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly mfaEnabled: boolean;
  readonly status: AccountStatus;
  /** ISO 8601 instant of the erasure, or `null`. */
  readonly deletedAt: string | null;
}

/**
 * A staff member of one tenant (`platform.tenant_memberships` with its `platform.accounts` row) and the tenant's
 * business time zone (`platform.tenants.time_zone`, which `PlatformTenant` does not carry), as the staff sessions rely
 * on them (OBE-059): plain and JSON-safe, so the `member:<accountId>:<tenantId>` cache stores it as it is. The
 * `membership` and `account` invalidations delete that entry; a time zone change of the tenant shows within the
 * cache's 60 s.
 */
export interface PlatformStaffMember {
  /** `stf_` + ULID: the subject of the staff tokens. */
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly role: StaffRole;
  readonly status: MembershipStatus;
  /** ISO 8601 instant of the last console activity the platform recorded, or `null`. */
  readonly lastActiveAt: string | null;
  /** ISO 8601 instant of the membership's creation. */
  readonly createdAt: string;
  readonly account: PlatformStaffAccount;
  /** `platform.tenants.time_zone`, an IANA zone (`ConsoleTenant.timeZone`). */
  readonly tenantTimeZone: string;
}

/** The row `staffMember` reads: the membership, its account's readable columns and the tenant's time zone. */
interface StaffMemberRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly account_id: string;
  readonly role: string;
  readonly status: string;
  readonly last_active_at: Date | null;
  readonly created_at: Date;
  readonly email: string;
  readonly full_name: string;
  readonly locale: string;
  readonly account_time_zone: string;
  readonly mfa_enabled: boolean;
  readonly account_status: string;
  readonly deleted_at: Date | null;
  readonly tenant_time_zone: string;
}

/** A tenant id as the platform writes it (`ten_` and a ULID); anything else is unknown without a query. */
const TENANT_ID_PATTERN = /^ten_[0-9A-Za-z]{1,60}$/;
/** An account id (`acc_` and a ULID). */
const ACCOUNT_ID_PATTERN = /^acc_[0-9A-Za-z]{1,60}$/;
/** A shared Amadeus account id (`ama_` and a ULID). */
const AMADEUS_ACCOUNT_ID_PATTERN = /^ama_[0-9A-Za-z]{1,60}$/;
/** A payment connection id (`ppc_` and a ULID). */
const PAYMENT_CONNECTION_ID_PATTERN = /^ppc_[0-9A-Za-z]{1,60}$/;

/**
 * A host name as `platform.tenant_domains.hostname` stores it (PADR-0004 item 1, the rule of `redis.keys.ts`): lower
 * case, labels of letters, digits and inner hyphens, at least two labels, no trailing dot, not an IP address.
 */
export const STOREFRONT_HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
   * The ids of the tenants whose status is one of `statuses`, in id order: the targets of the worker's scheduled
   * fan-outs (OADR-0014 point 1, OBE-024), which resolve each tenant through the cache afterwards. No status, no
   * query; a status outside the CHECK list of `platform.tenants.status` is a programming error (TypeError).
   */
  async tenantIdsByStatus(statuses: readonly TenantStatus[]): Promise<string[]> {
    const wanted = [...new Set(statuses)];
    const unknown = wanted.find((status) => !isOneOf(status, TENANT_STATUSES));
    if (unknown !== undefined) {
      throw new TypeError(`tenantIdsByStatus: ${JSON.stringify(unknown)} is not a tenant status`);
    }
    if (wanted.length === 0) {
      return [];
    }
    const rows = await this.read((trx) =>
      trx.selectFrom("platform.tenants").select("id").where("status", "in", wanted).orderBy("id").execute(),
    );
    return rows.map((row) => row.id);
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
   * The tenant id of a storefront host: a `platform.tenant_domains` row with this host name, `purpose = storefront`
   * and `verification_status = verified` (OADR-0009 point 2), or `null`. A pending or failed domain, one of another
   * purpose, and an unknown one are all `null`; the tenant's status is the resolver's check. A value that cannot be a
   * stored host name is unknown without a query.
   */
  async tenantIdByStorefrontHost(hostname: string): Promise<string | null> {
    if (!STOREFRONT_HOST_PATTERN.test(hostname)) {
      return null;
    }
    const row = await this.read((trx) =>
      trx
        .selectFrom("platform.tenant_domains")
        .select("tenant_id")
        .where("hostname", "=", hostname)
        .where("purpose", "=", "storefront")
        .where("verification_status", "=", "verified")
        .executeTakeFirst(),
    );
    return row === undefined ? null : row.tenant_id;
  }

  /**
   * The tenant's Amadeus connection of `environment` (`platform.supplier_connections`, one row per tenant, provider
   * and environment), whatever its status, or `null` when there is none: status and credential source are the
   * connection resolver's checks (OBE-017). A value that cannot be a tenant id or an environment is unknown without a
   * query.
   */
  async amadeusConnection(
    tenantId: string,
    environment: AmadeusEnvironment,
  ): Promise<PlatformAmadeusConnection | null> {
    if (!TENANT_ID_PATTERN.test(tenantId) || !isOneOf(environment, AMADEUS_ENVIRONMENTS)) {
      return null;
    }
    const row = await this.read((trx) =>
      trx
        .selectFrom("platform.supplier_connections")
        .select(AMADEUS_CONNECTION_COLUMNS)
        .where("tenant_id", "=", tenantId)
        .where("provider", "=", "amadeus")
        .where("environment", "=", environment)
        .executeTakeFirst(),
    );
    return row === undefined ? null : toPlatformAmadeusConnection(row);
  }

  /**
   * The Velexis shared Amadeus account with this id (`ama_…`), whatever its status, or `null` when there is none. A
   * value that cannot be an account id is unknown without a query.
   */
  async amadeusAccountById(id: string): Promise<PlatformAmadeusAccount | null> {
    if (!AMADEUS_ACCOUNT_ID_PATTERN.test(id)) {
      return null;
    }
    const row = await this.read((trx) =>
      trx
        .selectFrom("platform.amadeus_accounts")
        .select(AMADEUS_ACCOUNT_COLUMNS)
        .where("id", "=", id)
        .executeTakeFirst(),
    );
    return row === undefined ? null : toPlatformAmadeusAccount(row);
  }

  /**
   * The tenant's default payment connection of `environment` (`platform.payment_provider_connections`, `is_default`:
   * one per tenant and environment, `payment_provider_connections_default_uq`), whatever its provider, mode and status,
   * or `null` when there is none: those are the payment gateway's checks (OBE-038). The secret columns are not read. A
   * value that cannot be a tenant id or an environment is unknown without a query.
   */
  async paymentConnection(
    tenantId: string,
    environment: AmadeusEnvironment,
  ): Promise<PlatformPaymentConnection | null> {
    if (!TENANT_ID_PATTERN.test(tenantId) || !isOneOf(environment, AMADEUS_ENVIRONMENTS)) {
      return null;
    }
    const row = await this.read((trx) =>
      trx
        .selectFrom("platform.payment_provider_connections")
        .select(PAYMENT_CONNECTION_COLUMNS)
        .where("tenant_id", "=", tenantId)
        .where("environment", "=", environment)
        .where("is_default", "=", true)
        .executeTakeFirst(),
    );
    return row === undefined ? null : toPlatformPaymentConnection(row);
  }

  /**
   * The account mode of each of the tenant's payment connections `ids` (`platform.payment_provider_connections`,
   * whatever their status or default flag), by id (OBE-068: `ConsolePayment.providerConnection` of the connection a
   * payment was created with). A connection of another tenant, an unknown id or a value that cannot be a connection id
   * is left out; nothing but the id and the mode is read. A mode outside the CHECK list throws
   * `UnexpectedPlatformValueError`.
   */
  async paymentConnectionModes(
    tenantId: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, PaymentAccountMode>> {
    const wanted = [...new Set(ids)].filter((id) => PAYMENT_CONNECTION_ID_PATTERN.test(id));
    if (!TENANT_ID_PATTERN.test(tenantId) || wanted.length === 0) {
      return new Map();
    }
    const rows = await this.read((trx) =>
      trx
        .selectFrom("platform.payment_provider_connections")
        .select(["id", "account_mode"])
        .where("tenant_id", "=", tenantId)
        .where("id", "in", wanted)
        .execute(),
    );
    return new Map(
      rows.map((row) => [
        row.id,
        oneOf(
          row.account_mode,
          PAYMENT_ACCOUNT_MODES,
          "platform.payment_provider_connections.account_mode",
          row.id,
        ),
      ]),
    );
  }

  /**
   * The membership of account `accountId` in tenant `tenantId` (`tenant_memberships_tenant_account_uq`: at most one)
   * with its account and the tenant's time zone, whatever their states, or `null` when there is none: status, role and
   * account checks are the staff sessions' (OBE-059). A value that cannot be an account or tenant id is unknown
   * without a query. Only the `accounts` columns granted to velexis_ota_app are named.
   */
  async staffMember(accountId: string, tenantId: string): Promise<PlatformStaffMember | null> {
    if (!ACCOUNT_ID_PATTERN.test(accountId) || !TENANT_ID_PATTERN.test(tenantId)) {
      return null;
    }
    const row: StaffMemberRow | undefined = await this.read((trx) =>
      trx
        .selectFrom("platform.tenant_memberships as m")
        .innerJoin("platform.accounts as a", "a.id", "m.account_id")
        .innerJoin("platform.tenants as t", "t.id", "m.tenant_id")
        .select([
          "m.id",
          "m.tenant_id",
          "m.account_id",
          "m.role",
          "m.status",
          "m.last_active_at",
          "m.created_at",
          "a.email",
          "a.full_name",
          "a.locale",
          "a.time_zone as account_time_zone",
          "a.mfa_enabled",
          "a.status as account_status",
          "a.deleted_at",
          "t.time_zone as tenant_time_zone",
        ])
        .where("m.account_id", "=", accountId)
        .where("m.tenant_id", "=", tenantId)
        .executeTakeFirst(),
    );
    return row === undefined ? null : toPlatformStaffMember(row);
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

/**
 * Maps a `platform.supplier_connections` row. An environment, credential source or status outside the CHECK lists
 * throws `UnexpectedPlatformValueError`; the ciphertext becomes base64 text, the office list a frozen copy.
 */
function toPlatformAmadeusConnection(row: AmadeusConnectionRow): PlatformAmadeusConnection {
  const column = (name: string) => `platform.supplier_connections.${name}`;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    environment: oneOf(row.environment, AMADEUS_ENVIRONMENTS, column("environment"), row.id),
    credentialSource: oneOf(row.credential_source, CREDENTIAL_SOURCES, column("credential_source"), row.id),
    amadeusAccountId: row.amadeus_account_id,
    baseUrl: row.base_url,
    clientId: row.client_id,
    clientSecretCiphertext:
      row.client_secret_ciphertext === null ? null : row.client_secret_ciphertext.toString("base64"),
    officeIds: Object.freeze([...row.office_ids]),
    defaultOfficeId: row.default_office_id,
    queuingOfficeId: row.queuing_office_id,
    ownerOfficeId: row.owner_office_id,
    status: oneOf(row.status, AMADEUS_CREDENTIAL_STATUSES, column("status"), row.id),
  });
}

/** Maps a `platform.amadeus_accounts` row, as `toPlatformAmadeusConnection` does. */
function toPlatformAmadeusAccount(row: AmadeusAccountRow): PlatformAmadeusAccount {
  const column = (name: string) => `platform.amadeus_accounts.${name}`;
  return Object.freeze({
    id: row.id,
    environment: oneOf(row.environment, AMADEUS_ENVIRONMENTS, column("environment"), row.id),
    baseUrl: row.base_url,
    clientId: row.client_id,
    clientSecretCiphertext: row.client_secret_ciphertext.toString("base64"),
    status: oneOf(row.status, AMADEUS_CREDENTIAL_STATUSES, column("status"), row.id),
  });
}

/**
 * Maps a `platform.payment_provider_connections` row. A provider, environment, mode, capture mode or status outside the
 * CHECK lists throws `UnexpectedPlatformValueError`; the method list becomes a frozen copy.
 */
function toPlatformPaymentConnection(row: PaymentConnectionRow): PlatformPaymentConnection {
  const column = (name: string) => `platform.payment_provider_connections.${name}`;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    provider: oneOf(row.provider, PAYMENT_PROVIDERS, column("provider"), row.id),
    environment: oneOf(row.environment, AMADEUS_ENVIRONMENTS, column("environment"), row.id),
    accountMode: oneOf(row.account_mode, PAYMENT_ACCOUNT_MODES, column("account_mode"), row.id),
    accountReference: row.account_reference,
    publishableKey: row.publishable_key,
    supportedMethods: Object.freeze([...row.supported_methods]),
    captureMode: oneOf(row.capture_mode, PAYMENT_CAPTURE_MODES, column("capture_mode"), row.id),
    status: oneOf(row.status, PAYMENT_CONNECTION_STATUSES, column("status"), row.id),
    statementDescriptorSuffix: row.statement_descriptor_suffix,
  });
}

/**
 * Maps a membership row. A role or a membership or account status outside the CHECK lists throws
 * `UnexpectedPlatformValueError`; the timestamps become ISO strings.
 */
function toPlatformStaffMember(row: StaffMemberRow): PlatformStaffMember {
  const membership = (name: string) => `platform.tenant_memberships.${name}`;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    role: oneOf(row.role, STAFF_ROLES, membership("role"), row.id),
    status: oneOf(row.status, MEMBERSHIP_STATUSES, membership("status"), row.id),
    lastActiveAt: row.last_active_at === null ? null : row.last_active_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    account: Object.freeze({
      email: row.email,
      fullName: row.full_name,
      locale: row.locale,
      timeZone: row.account_time_zone,
      mfaEnabled: row.mfa_enabled,
      status: oneOf(row.account_status, ACCOUNT_STATUSES, "platform.accounts.status", row.account_id),
      deletedAt: row.deleted_at === null ? null : row.deleted_at.toISOString(),
    }),
    tenantTimeZone: row.tenant_time_zone,
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
