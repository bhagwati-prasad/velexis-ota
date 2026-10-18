// The `tenant_memberships` repository (platform/docs/architecture.md §2.1: MembershipsModule owns the table). It brings
// the read of TenantRoleGuard (PBE-017): the caller's **active** membership of an OTA that members may see; the team
// routes (PBE-025): the member list, the rows a role change or a removal locks, and its two writes; and the create-OTA
// transaction (PBE-018): the owner membership of a new OTA and the count of the OTAs an account owns (the tenant limit
// of scope PF-10 AC4). The membership of an accepted invitation comes with PBE-026. Kysely on the API's `PLATFORM_DB`,
// schema-qualified tables (ADR-0005). The member reads join `platform.accounts` for what the `Member` schema shows
// next to the membership (name, e-mail address, MFA flag), read only, as the operations' `x-platform-tables` say.
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import {
  isTenantRole,
  MEMBER_VISIBLE_TENANT_STATUSES,
  TenantMembershipLookup,
  type TenantMembership,
  type TenantRole,
} from "../common/auth/tenant-role.guard";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** A member as the team routes show it: the membership row and the account's name, e-mail address and MFA flag. */
export interface MemberRecord {
  /** `stf_…`. */
  readonly id: string;
  readonly tenant_id: string;
  readonly account_id: string;
  readonly role: string;
  readonly status: string;
  readonly version: number;
  readonly created_at: Date;
  readonly full_name: string;
  readonly email: string;
  readonly mfa_enabled: boolean;
}

/** A membership locked by `lockForChange`, with the MFA flag of its account (the step-up of granting `owner`). */
export interface LockedMembership {
  readonly id: string;
  readonly account_id: string;
  readonly role: string;
  readonly status: string;
  readonly version: number;
  readonly mfa_enabled: boolean;
}

/** The membership states of migration 0001; only `active` members are on the team. */
export type MembershipStatus = "active" | "suspended" | "removed";

/** The owner membership of a new OTA: its founder, invited by nobody. */
export interface NewOwnerMembership {
  /** `stf_…`. */
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  /** The time of the creation: `created_at` and `updated_at`. */
  readonly now: Date;
}

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

  /** The active members of `tenantId`, oldest first (then by id, so the order is stable). */
  async listActive(tenantId: string): Promise<MemberRecord[]> {
    return this.members(this.db)
      .where("m.tenant_id", "=", tenantId)
      .where("m.status", "=", "active")
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
  }

  /** The membership `memberId` of `tenantId` in any state, read on `db` (the pool, or the caller's transaction). */
  async findMember(
    tenantId: string,
    memberId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<MemberRecord | undefined> {
    return this.members(db)
      .where("m.tenant_id", "=", tenantId)
      .where("m.id", "=", memberId)
      .executeTakeFirst();
  }

  /**
   * Locks for the rest of `trx` (`FOR UPDATE`) the memberships `ids` of `tenantId` (the member changed and the caller)
   * and every **active owner** of the tenant, and returns them in any state; an id of another tenant is not returned.
   *
   * The owners are locked so that the last-owner rule (`409 LAST_OWNER`) holds under concurrency: two owners who
   * demote or remove each other, or leave, at the same time are serialised, and the second sees the first's committed
   * change (READ COMMITTED re-checks a locked row's new version, so an owner demoted or removed meanwhile is no longer
   * returned as one). The rows are locked in id order, so two such changes never deadlock.
   */
  async lockForChange(
    trx: PlatformTransaction,
    tenantId: string,
    ids: readonly string[],
  ): Promise<LockedMembership[]> {
    return trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(["m.id", "m.account_id", "m.role", "m.status", "m.version", "a.mfa_enabled"])
      .where("m.tenant_id", "=", tenantId)
      .where((eb) =>
        eb.or([
          eb("m.id", "in", [...ids]),
          eb.and([eb("m.role", "=", "owner"), eb("m.status", "=", "active")]),
        ]),
      )
      .orderBy("m.id")
      .forUpdate("m")
      .execute();
  }

  /**
   * Sets the role of a membership locked by `lockForChange`, with `version + 1` and `updated_at = now`, in `trx`.
   * Throws (and so rolls the change back) when no row has the id: `returning` gives the throw a row to miss.
   */
  async updateRole(trx: PlatformTransaction, memberId: string, role: TenantRole, now: Date): Promise<void> {
    await trx
      .updateTable("platform.tenant_memberships")
      .set({ role, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", memberId)
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  /**
   * Sets the status of a membership locked by `lockForChange`, with `version + 1` and `updated_at = now`, in `trx`. A
   * removed membership keeps its row: its `stf_` id is referenced by value in the OTA's `staff_actions`. Throws when no
   * row has the id, as `updateRole` does.
   */
  async updateStatus(
    trx: PlatformTransaction,
    memberId: string,
    status: MembershipStatus,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.tenant_memberships")
      .set({ status, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", memberId)
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  /**
   * Inserts the `owner` membership of a new OTA in `trx`: `active`, no inviter (`invited_by_account_id` is NULL for
   * the founder, migration 0001).
   */
  async insertOwner(trx: PlatformTransaction, membership: NewOwnerMembership): Promise<void> {
    await trx
      .insertInto("platform.tenant_memberships")
      .values({
        id: membership.id,
        tenant_id: membership.tenantId,
        account_id: membership.accountId,
        role: "owner" satisfies TenantRole,
        status: "active" satisfies MembershipStatus,
        created_at: membership.now,
        updated_at: membership.now,
      })
      .execute();
  }

  /**
   * The number of OTAs that `accountId` owns and that are not `failed`, read in `trx`: its `owner` memberships that are
   * not `removed` (a suspended membership still holds its OTA) of tenants in any status but `failed` (scope PF-10
   * AC4: a failed OTA keeps its key but no longer counts). The caller holds the account's row lock, so two creations
   * of one account count one after the other.
   */
  async countOwnedTenants(trx: PlatformTransaction, accountId: string): Promise<number> {
    const row = await trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.tenants as t", "t.id", "m.tenant_id")
      .select((eb) => eb.fn.countAll<string>().as("owned"))
      .where("m.account_id", "=", accountId)
      .where("m.role", "=", "owner" satisfies TenantRole)
      .where("m.status", "<>", "removed" satisfies MembershipStatus)
      .where("t.status", "<>", "failed")
      .executeTakeFirstOrThrow();
    return Number(row.owned);
  }

  /** The member columns of a membership and its account. */
  private members(db: PlatformDb | PlatformTransaction) {
    return db
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select([
        "m.id",
        "m.tenant_id",
        "m.account_id",
        "m.role",
        "m.status",
        "m.version",
        "m.created_at",
        "a.full_name",
        "a.email",
        "a.mfa_enabled",
      ]);
  }
}
