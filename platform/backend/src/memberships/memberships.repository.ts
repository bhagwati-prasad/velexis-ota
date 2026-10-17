// The `tenant_memberships` repository (platform/docs/architecture.md §2.1: MembershipsModule owns the table). This
// task brings the read of TenantRoleGuard: the caller's **active** membership of an OTA that members may see.
// Later tasks add the member list, role changes, removals and the owner membership of a new OTA (PBE-018, PBE-025,
// PBE-026). Kysely on the API's `PLATFORM_DB`, schema-qualified tables (ADR-0005).
import { Inject, Injectable } from "@nestjs/common";
import {
  isTenantRole,
  MEMBER_VISIBLE_TENANT_STATUSES,
  TenantMembershipLookup,
  type TenantMembership,
} from "../common/auth/tenant-role.guard";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

@Injectable()
export class MembershipsRepository implements TenantMembershipLookup {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * The membership of `accountId` in `tenantId` when it is `active` and the tenant is visible to members (one indexed
   * read by the unique `(tenant_id, account_id)`); `undefined` otherwise, also for an id that is no tenant id at all.
   */
  async findActive(tenantId: string, accountId: string): Promise<TenantMembership | undefined> {
    const row = await this.db
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.tenants as t", "t.id", "m.tenant_id")
      .select(["m.id", "m.tenant_id", "m.account_id", "m.role"])
      .where("m.tenant_id", "=", tenantId)
      .where("m.account_id", "=", accountId)
      .where("m.status", "=", "active")
      .where("t.status", "in", MEMBER_VISIBLE_TENANT_STATUSES)
      .where("t.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined || !isTenantRole(row.role)) {
      return undefined;
    }
    return { membershipId: row.id, tenantId: row.tenant_id, accountId: row.account_id, role: row.role };
  }
}
