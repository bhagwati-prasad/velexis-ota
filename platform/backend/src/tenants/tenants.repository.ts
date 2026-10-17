// The `tenants` repository (platform/docs/architecture.md §2.1: TenantsModule owns the table): the key check, the
// lists and reads of the portal and the profile update. Kysely on the API's `PLATFORM_DB`, schema-qualified tables
// (ADR-0005). The reads join what an answer shows next to the tenant row: the caller's role from the active
// membership (listTenants) and the primary storefront host from `tenant_domains`, read only. `reference.countries` and
// `reference.time_zones` are read for the checks of a profile update (the reference tables are read directly,
// architecture §2.1).
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

  /** True when any tenant row, in any status (deleted and failed ones included), has `key`. */
  async keyExists(key: string): Promise<boolean> {
    const row = await this.db
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

  /** True when `code` is a country of `reference.countries`. */
  async countryExists(code: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("reference.countries")
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
