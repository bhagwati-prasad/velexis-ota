// The team of an OTA (platform/docs/api-inventory.md §8; flows/team-and-ota-admin-sso.md §B; scope §1.2 and PF-21):
// the member list, role changes and removals. TenantRoleGuard lets through the roles of the matrix for each operation
// (memberships/tenant-roles.ts); the rules finer than a role are this service's, checked inside the transaction of the
// change on rows it has locked:
//
// - only owners touch owners and admins: admins set `agent`, `finance` or `viewer` on members who are neither, and
//   remove only those (`canManageRole`, `403 FORBIDDEN`); any member may remove themself, to leave the OTA;
// - granting `owner` needs a TOTP step-up within 15 minutes (`assertRecentMfa`: `403 MFA_REQUIRED`, `401
//   REAUTH_REQUIRED`); the other changes do not;
// - a role change carries the member's `version` (`If-Match`, `412 PRECONDITION_FAILED`);
// - the OTA always keeps an active owner: the last one can neither be demoted nor removed (`409 LAST_OWNER`).
//
// The caller's own membership is locked and read again with the member's and the active owners' (lockForChange): a
// role change or removal of the caller committed since the guard's read wins, and concurrent changes of the owners
// are serialised. Every change writes one audit row in its transaction and publishes `{type: "membership", accountId,
// tenantId}` on `vx:invalidate` after the commit (architecture §4), so the OTA admin drops the cached membership and a
// removed member loses access within seconds (PF-21 AC3). A change that changes nothing writes nothing.
import { Inject, Injectable } from "@nestjs/common";
import type { MembershipInvalidation } from "@velexis/api-types/jobs";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { assertRecentMfa } from "../common/auth/recent-mfa.guard";
import { isTenantRole, type TenantMembership, type TenantRole } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { MembershipsRepository, type LockedMembership, type MemberRecord } from "./memberships.repository";
import { canManageRole } from "./tenant-roles";

export type Member = components["schemas"]["Member"];
export type MemberList = components["schemas"]["MemberList"];
export type UpdateMemberRequest = components["schemas"]["UpdateMemberRequest"];

/** The `Member` of the OpenAPI document for a membership row and its account. */
export function toMember(row: MemberRecord): Member {
  return {
    id: row.id,
    accountId: row.account_id,
    fullName: row.full_name,
    email: row.email,
    role: row.role as TenantRole,
    status: row.status as Member["status"],
    mfaEnabled: row.mfa_enabled,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/** The `membership` invalidation of a member (`member:<accountId>:<tenantId>` in the OTA's cache). */
export function membershipInvalidation(accountId: string, tenantId: string): MembershipInvalidation {
  return { v: 1, type: "membership", accountId, tenantId };
}

/** A locked membership whose role is one of the five. */
type LockedMember = LockedMembership & { readonly role: TenantRole };

/** What a change sees once its rows are locked. */
interface LockedChange {
  /** The caller's membership as it is now. */
  readonly caller: LockedMember;
  /** The member changed (the caller, for someone who leaves). */
  readonly member: LockedMember;
  /** How many active owners the OTA has, the member included. */
  readonly activeOwners: number;
}

const isActiveMember = (row: LockedMembership | undefined): row is LockedMember =>
  row !== undefined && row.status === "active" && isTenantRole(row.role);

@Injectable()
export class MembersService {
  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** listMembers: the active members of the caller's OTA, oldest first. */
  async list(caller: TenantMembership): Promise<MemberList> {
    const rows = await this.memberships.listActive(caller.tenantId);
    return { data: rows.map(toMember) };
  }

  /**
   * updateMember: sets `role` on the member `memberId` of the caller's OTA. In this order: `404 NOT_FOUND` (no active
   * member of this OTA), `403 FORBIDDEN` (the role matrix), the step-up of granting `owner` (`403 MFA_REQUIRED`, `401
   * REAUTH_REQUIRED`), `412 PRECONDITION_FAILED` (`expectedVersion` is not the member's version), then `409
   * LAST_OWNER`. Writes `membership.role_changed` and publishes the `membership` invalidation after the commit; the
   * member's own role answers it as it is.
   */
  async changeRole(
    caller: TenantMembership,
    claims: Pick<AccessTokenClaims, "mfa_at">,
    memberId: string,
    expectedVersion: number,
    role: TenantRole,
  ): Promise<Member> {
    const { tenantId } = caller;
    return runInTransaction(this.db, async (trx) => {
      const { caller: actor, member, activeOwners } = await this.lockForChange(trx, caller, memberId);
      if (!canManageRole(actor.role, member.role) || !canManageRole(actor.role, role)) {
        throw new AppError("FORBIDDEN");
      }
      if (role === "owner" && member.role !== "owner") {
        assertRecentMfa({ mfaEnabled: actor.mfa_enabled }, claims, this.clock.now());
      }
      if (member.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (role !== member.role) {
        if (member.role === "owner" && activeOwners <= 1) {
          throw new AppError("LAST_OWNER");
        }
        await this.memberships.updateRole(trx, member.id, role, this.clock.now());
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: actor.account_id,
          action: "membership.role_changed",
          targetType: "membership",
          targetId: member.id,
          tenantId,
          before: { role: member.role },
          after: { role },
          details: { accountId: member.account_id },
        });
        this.invalidations.publishAfterCommit(trx, membershipInvalidation(member.account_id, tenantId));
      }
      const row = await this.memberships.findMember(tenantId, member.id, trx);
      if (row === undefined) {
        throw new AppError("NOT_FOUND");
      }
      return toMember(row);
    });
  }

  /**
   * removeMember: sets the member `memberId` of the caller's OTA `removed` (the row stays). The caller may remove
   * themself (leave); others follow the role matrix. In this order: `404 NOT_FOUND`, `403 FORBIDDEN`, `409
   * LAST_OWNER`. Writes `membership.removed` and publishes the `membership` invalidation after the commit.
   */
  async remove(caller: TenantMembership, memberId: string): Promise<void> {
    const { tenantId } = caller;
    await runInTransaction(this.db, async (trx) => {
      const { caller: actor, member, activeOwners } = await this.lockForChange(trx, caller, memberId);
      const leaving = member.id === actor.id;
      if (!leaving && !canManageRole(actor.role, member.role)) {
        throw new AppError("FORBIDDEN");
      }
      if (member.role === "owner" && activeOwners <= 1) {
        throw new AppError("LAST_OWNER");
      }
      await this.memberships.updateStatus(trx, member.id, "removed", this.clock.now());
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: actor.account_id,
        action: "membership.removed",
        targetType: "membership",
        targetId: member.id,
        tenantId,
        before: { role: member.role, status: "active" },
        after: { status: "removed" },
        details: { accountId: member.account_id, left: leaving },
      });
      this.invalidations.publishAfterCommit(trx, membershipInvalidation(member.account_id, tenantId));
    });
  }

  /**
   * Locks the caller's membership, the member's and the OTA's active owners, and checks that the caller and the member
   * are still active members of the OTA: `404 NOT_FOUND` otherwise, as TenantRoleGuard answers a non-member and as an
   * unknown, removed or other OTA's member id answers.
   */
  private async lockForChange(
    trx: PlatformTransaction,
    caller: TenantMembership,
    memberId: string,
  ): Promise<LockedChange> {
    const rows = await this.memberships.lockForChange(trx, caller.tenantId, [caller.membershipId, memberId]);
    const actor = rows.find((row) => row.id === caller.membershipId);
    const member = rows.find((row) => row.id === memberId);
    if (!isActiveMember(actor) || !isActiveMember(member)) {
      throw new AppError("NOT_FOUND");
    }
    const activeOwners = rows.filter((row) => row.role === "owner" && row.status === "active").length;
    return { caller: actor, member, activeOwners };
  }
}
