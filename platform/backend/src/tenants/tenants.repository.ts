// The `tenants` repository (platform/docs/architecture.md §2.1: TenantsModule owns the table): the key check, the
// lists and reads of the portal and the profile update (PBE-017), the row of a new OTA, which ProvisioningModule
// writes in the create-OTA transaction (PBE-018), the two writes of its post-steps (PBE-022): the mirrored schema
// version and the activation, and the failure of a provisioning and the owner's retry (PBE-023). Kysely on the
// process's `PLATFORM_DB`, schema-qualified tables
// (ADR-0005). The reads join what an answer shows next to the tenant row: the caller's role from the active
// membership (listTenants) and the primary storefront host from `tenant_domains`, read only. `reference.countries`,
// `reference.currencies` and `reference.time_zones` are read for the checks of a new OTA and a profile update (the
// reference tables are read directly, architecture §2.1).
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { MEMBER_VISIBLE_TENANT_STATUSES } from "../common/auth/tenant-role.guard";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** A `platform.tenants` row as the API reads it. */
export type TenantRecord = Selectable<PlatformDatabase["platform.tenants"]>;

/** A tenant row with its primary storefront host (`tenant_domains`, `purpose = 'storefront'`, `is_primary`). */
export interface TenantWithHost extends TenantRecord {
  /** The hostname of the primary storefront domain; `null` when the tenant has none (yet). */
  readonly primary_host: string | null;
}

/** One OTA of an account's list: the tenant, the caller's role and the primary host. */
export interface TenantListRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: string;
  readonly plan_code: string;
  readonly storefront_environment: string;
  readonly role: string;
  readonly primary_host: string | null;
}

/** A new OTA, as createTenant writes it. */
export interface NewTenant {
  /** `ten_…`. */
  readonly id: string;
  /** A key that follows the key rules and is not reserved (tenant-key.ts); `schema_name` is `tenant_<key>`. */
  readonly key: string;
  readonly name: string;
  readonly planCode: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly timeZone: string;
  readonly createdByAccountId: string;
  /** The time of the creation: `created_at` and `updated_at`. */
  readonly now: Date;
}

/** The unique constraints of `tenants` that a new OTA's key can break: the key and the schema name derived from it. */
export const TENANT_KEY_CONSTRAINTS: readonly string[] = Object.freeze([
  "tenants_key_key",
  "tenants_schema_name_key",
]);

/** The profile fields of `updateTenant`, as columns; an absent field is not changed. */
export interface TenantProfileChanges {
  readonly name?: string;
  readonly legal_name?: string | null;
  readonly support_email?: string | null;
  readonly country_code?: string;
  readonly time_zone?: string;
}

@Injectable()
export class TenantsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * True when any tenant row, in any status (deleted and failed ones included), has `key`, read on `db` (the pool, or
   * the caller's transaction).
   */
  async keyExists(key: string, db: PlatformDb | PlatformTransaction = this.db): Promise<boolean> {
    const row = await db
      .selectFrom("platform.tenants")
      .select(sql<number>`1`.as("found"))
      .where("key", "=", key)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The OTAs in which `accountId` has an active membership, in the statuses members see, oldest first, with the role
   * and the primary storefront host.
   */
  async listForMember(accountId: string): Promise<TenantListRow[]> {
    return this.db
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.tenants as t", "t.id", "m.tenant_id")
      .leftJoin("platform.tenant_domains as d", (join) =>
        join
          .onRef("d.tenant_id", "=", "t.id")
          .on("d.purpose", "=", "storefront")
          .on("d.is_primary", "=", true),
      )
      .select([
        "t.id",
        "t.key",
        "t.name",
        "t.status",
        "t.plan_code",
        "t.storefront_environment",
        "m.role",
        "d.hostname as primary_host",
      ])
      .where("m.account_id", "=", accountId)
      .where("m.status", "=", "active")
      .where("t.status", "in", MEMBER_VISIBLE_TENANT_STATUSES)
      .where("t.deleted_at", "is", null)
      .orderBy("t.created_at")
      .orderBy("t.id")
      .execute();
  }

  /** The tenant `tenantId` with its primary storefront host, read on `db` (the pool, or the caller's transaction). */
  async findWithHost(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<TenantWithHost | undefined> {
    return db
      .selectFrom("platform.tenants as t")
      .leftJoin("platform.tenant_domains as d", (join) =>
        join
          .onRef("d.tenant_id", "=", "t.id")
          .on("d.purpose", "=", "storefront")
          .on("d.is_primary", "=", true),
      )
      .selectAll("t")
      .select("d.hostname as primary_host")
      .where("t.id", "=", tenantId)
      .executeTakeFirst();
  }

  /**
   * Inserts a new OTA in `trx`: `provisioning`, storefront environment `test`, no schema version yet (the provisioning
   * post-steps mirror it, PBE-022). A key that a row has, or had, fails on one of TENANT_KEY_CONSTRAINTS; the CHECK
   * constraints refuse a key that breaks the key rules.
   */
  async insert(trx: PlatformTransaction, tenant: NewTenant): Promise<void> {
    await trx
      .insertInto("platform.tenants")
      .values({
        id: tenant.id,
        key: tenant.key,
        name: tenant.name,
        status: "provisioning",
        plan_code: tenant.planCode,
        country_code: tenant.countryCode,
        default_currency: tenant.defaultCurrency,
        time_zone: tenant.timeZone,
        storefront_environment: "test",
        created_by_account_id: tenant.createdByAccountId,
        created_at: tenant.now,
        updated_at: tenant.now,
      })
      .execute();
  }

  /** The tenant row, locked for the rest of the caller's transaction (`FOR UPDATE`). */
  async lockForUpdate(trx: PlatformTransaction, tenantId: string): Promise<TenantRecord | undefined> {
    return trx
      .selectFrom("platform.tenants")
      .selectAll()
      .where("id", "=", tenantId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Writes the profile `changes` of a row locked by `lockForUpdate`, with `version + 1` and `updated_at = now`, in
   * `trx`. Returns the new version.
   */
  async updateProfile(
    trx: PlatformTransaction,
    tenantId: string,
    changes: TenantProfileChanges,
    now: Date,
  ): Promise<number> {
    const row = await trx
      .updateTable("platform.tenants")
      .set({ ...changes, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", tenantId)
      .returning("version")
      .executeTakeFirstOrThrow();
    return row.version;
  }

  /**
   * Sets the tenant's `schema_version`, the mirror of the latest migration of its schema (PBE-022, record_migrations),
   * in `trx`. The optimistic-locking `version` stays: the owner's profile edits do not conflict with the mirror.
   */
  async setSchemaVersion(
    trx: PlatformTransaction,
    tenantId: string,
    schemaVersion: string,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.tenants")
      .set({ schema_version: schemaVersion, updated_at: now })
      .where("id", "=", tenantId)
      .execute();
  }

  /**
   * The activation of a provisioned OTA in `trx` (PBE-022, activate): `provisioning → active`, `activated_at`,
   * `version + 1`, only while the tenant is `provisioning`. Returns the tenant's status after the call: `active` when
   * this call activated it, otherwise the status it has (`undefined` for no such tenant).
   */
  async activateProvisioned(
    trx: PlatformTransaction,
    tenantId: string,
    now: Date,
  ): Promise<{ readonly activated: boolean; readonly status: string | undefined }> {
    const activated = await trx
      .updateTable("platform.tenants")
      .set({ status: "active", activated_at: now, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", tenantId)
      .where("status", "=", "provisioning")
      .returning("status")
      .executeTakeFirst();
    if (activated !== undefined) {
      return { activated: true, status: activated.status };
    }
    const current = await trx
      .selectFrom("platform.tenants")
      .select("status")
      .where("id", "=", tenantId)
      .executeTakeFirst();
    return { activated: false, status: current?.status };
  }

  /**
   * The failure of a provisioning (PBE-023, PADR-0001 item 7) in `trx`: `provisioning → failed`, `version + 1`, only
   * while the tenant is `provisioning`, so a lost or rejected job of another kind can never fail an active or suspended
   * tenant. True when this call changed the tenant.
   */
  async failProvisioning(trx: PlatformTransaction, tenantId: string, now: Date): Promise<boolean> {
    const row = await trx
      .updateTable("platform.tenants")
      .set({ status: "failed", version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", tenantId)
      .where("status", "=", "provisioning")
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The owner's retry of a failed setup (PBE-023, `retryProvisioning`) in `trx`: `failed → provisioning`,
   * `version + 1`, only while the tenant is `failed`. True when this call changed the tenant.
   */
  async reopenFailed(trx: PlatformTransaction, tenantId: string, now: Date): Promise<boolean> {
    const row = await trx
      .updateTable("platform.tenants")
      .set({ status: "provisioning", version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", tenantId)
      .where("status", "=", "failed")
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  /** True when `code` is a country of `reference.countries`. */
  async countryExists(code: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("reference.countries")
      .select("code")
      .where("code", "=", code)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** True when `code` is a currency of `reference.currencies`. */
  async currencyExists(code: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("reference.currencies")
      .select("code")
      .where("code", "=", code)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * True when `name` is a zone of `reference.time_zones`, spelled exactly as there (IANA names, aliases included, so
   * `Europe/Kyiv` and `Europe/Kiev` are both zones). `tenants.time_zone` holds such a name by value: the OTA worker
   * copies it into the tenant's `storefront_settings.time_zone`, which is checked against the same table.
   */
  async timeZoneExists(name: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("reference.time_zones")
      .select("name")
      .where("name", "=", name)
      .executeTakeFirst();
    return row !== undefined;
  }
}
