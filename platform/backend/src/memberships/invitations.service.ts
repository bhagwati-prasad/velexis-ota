// Invitations to join an OTA (PBE-026; platform/docs/api-inventory.md §8, flows/team-and-ota-admin-sso.md §A, scope
// §1.2 and PF-20). TenantRoleGuard lets owners and admins through to the routes under `/v1/tenants/{tenantId}`
// (memberships/tenant-roles.ts); the rules finer than a role are this service's, checked in the transaction of the
// change:
//
// - createInvitation: only owners invite owners or admins (`canManageRole`, `403 FORBIDDEN`); the address must not
//   belong to a member who has not been removed (`409 ALREADY_MEMBER`, letter case ignored) nor have a pending
//   invitation (`409 INVITATION_PENDING`); the `active` members plus the `pending` invitations must stay below the
//   plan's `limits.staffSeats` (`422 PLAN_LIMIT_REACHED` with `details.limit` and `details.used`). Creations of one OTA
//   are serialised by a transaction-level advisory lock, so two of them never take the last seat or invite one address
//   twice. The invitation stores the SHA-256 of a 256-bit token (`iv_…`, `generateToken` of @velexis/crypto) and
//   expires 7 days later; the e-mail `team.invitation` carries the link `PUBLIC_PORTAL_URL/invitations/accept?token=…`
//   as the outbox's encrypted secret data (PADR-0013), never in an answer, a log, a job or an audit row.
// - listInvitations: the `pending` invitations, newest first.
// - resendInvitation: a `pending` invitation gets a new token and 7 more days from now, and the e-mail with the new
//   link; the old link stops working at once. revokeInvitation sets it `revoked`. Both answer `409 CONFLICT`
//   (`details.reason = "not_pending"`) for an invitation that is not `pending`, and follow the role matrix for the
//   invited role, as createInvitation does.
// - lookupInvitation (public) and acceptInvitation (`portal`): the invitation must be `pending`, unexpired and of an
//   OTA members can see (`400 INVITATION_INVALID` otherwise, without saying why); acceptance also needs the signed-in
//   account's **verified** address to equal the invited one, letter case ignored (`403 INVITATION_EMAIL_MISMATCH`). In
//   one transaction it inserts the membership with the invited role, or makes a `removed` one active again with it
//   (`409 ALREADY_MEMBER` for an account that is still a member), sets the invitation `accepted` and audits
//   `membership.created`; after the commit it publishes `{type: "membership", accountId, tenantId}` on
//   `vx:invalidate`. The invitation row is locked first, so one link accepted twice at once gives one membership.
//
// Expiry is decided at use: a `pending` invitation past its `expires_at` cannot be looked up or accepted, and the
// hourly `invitations.expire` job (invitations-expire.scheduler.ts) sets it `expired`. Until then it is still pending:
// it is listed, holds its seat and its address, and can be resent (the accept page of an expired link asks the inviter
// to resend, flow "Failure handling") or revoked.
//
// Every change writes one audit row in its transaction (`invitation.created`, `invitation.resent`,
// `invitation.revoked`, `membership.created`) with the invited address and role, never the token.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import {
  MEMBER_VISIBLE_TENANT_STATUSES,
  isTenantRole,
  type TenantMembership,
  type TenantRole,
} from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import { OutboxService } from "../notifications/outbox.service";
import { storefrontHost } from "../tenants/tenant-key";
import {
  InvitationsRepository,
  type AcceptedTenantRow,
  type InvitationByToken,
  type InvitationRecord,
  type InvitationStatus,
  type InvitationWithInviter,
  type LockedInviter,
} from "./invitations.repository";
import { membershipInvalidation, toMember } from "./members.service";
import type { MembershipStatus } from "./memberships.repository";
import { canManageRole } from "./tenant-roles";

export type Invitation = components["schemas"]["Invitation"];
export type InvitationList = components["schemas"]["InvitationList"];
export type CreateInvitationRequest = components["schemas"]["CreateInvitationRequest"];
export type InvitationTokenRequest = components["schemas"]["InvitationTokenRequest"];
export type InvitationPreview = components["schemas"]["InvitationPreview"];
export type InvitationAccepted = components["schemas"]["InvitationAccepted"];
type TenantSummary = components["schemas"]["TenantSummary"];

/** How long an invitation link works, from its creation or its last resend (flow §A, scope PF-20 AC3). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The portal page the link opens (flow §A step 2): it moves the token into a cookie and out of the URL at once. */
export const INVITATION_ACCEPT_PATH = "/invitations/accept";

/** The prefix of invitation tokens (`iv_` and 43 base64url characters, 256 bits). */
export const INVITATION_TOKEN_PREFIX = "iv";

/** The `details.reason` of `409 CONFLICT` for an invitation that is no longer pending. */
export const NOT_PENDING = "not_pending";

const PENDING: InvitationStatus = "pending";

/** The `Invitation` of the OpenAPI document for a row and its inviter: never the token or its hash. */
export function toInvitation(row: InvitationWithInviter): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as TenantRole,
    status: row.status as Invitation["status"],
    invitedBy:
      row.invited_by_account_id === null || row.inviter_full_name === null
        ? null
        : { accountId: row.invited_by_account_id, fullName: row.inviter_full_name },
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The `staffSeats` quota of a plan's `limits` column: a whole number of at least 0, or 0 when the plan does not set it
 * (the rule of `PlanLimits` in listPlans, so a plan with incomplete limits never grants more than it shows).
 */
export function staffSeatLimit(limits: unknown): number {
  const value =
    limits !== null && typeof limits === "object" && !Array.isArray(limits)
      ? (limits as Record<string, unknown>)["staffSeats"]
      : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * True when the invitation found by a token can be looked up and accepted at `now`: `pending`, not expired, and of an
 * OTA that members can see (not being deprovisioned or deleted).
 */
export function isUsableInvitation(
  row: Pick<InvitationByToken, "status" | "expires_at" | "tenant_status" | "tenant_deleted_at"> | undefined,
  now: Date,
): row is InvitationByToken {
  return (
    row !== undefined &&
    row.status === PENDING &&
    row.expires_at.getTime() > now.getTime() &&
    (MEMBER_VISIBLE_TENANT_STATUSES as readonly string[]).includes(row.tenant_status) &&
    row.tenant_deleted_at === null
  );
}

/** The account states that may not join an OTA at all: the request is treated as unauthenticated. */
const CLOSED_ACCOUNT_STATUSES: ReadonlySet<string> = new Set(["disabled", "deleted"]);

@Injectable()
export class InvitationsService {
  private readonly baseDomain: string;

  constructor(
    private readonly invitations: InvitationsRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** listInvitations: the pending invitations of the caller's OTA, newest first. */
  async list(caller: TenantMembership): Promise<InvitationList> {
    const rows = await this.invitations.listPending(caller.tenantId);
    return { data: rows.map(toInvitation) };
  }

  /**
   * createInvitation: in this order `403 FORBIDDEN` (the role matrix for the invited role), `409 ALREADY_MEMBER`, `409
   * INVITATION_PENDING`, `422 PLAN_LIMIT_REACHED`; then the invitation, its e-mail and the `invitation.created` audit
   * row in one transaction.
   */
  async create(caller: TenantMembership, request: CreateInvitationRequest): Promise<Invitation> {
    const { tenantId } = caller;
    const email = request.email.trim();
    const role = request.role;
    return runInTransaction(this.db, async (trx) => {
      await this.invitations.lockTenantInvitations(trx, tenantId);
      const inviter = await this.lockInviter(trx, caller);
      if (!canManageRole(inviter.role, role)) {
        throw new AppError("FORBIDDEN");
      }
      if (await this.invitations.isMemberEmail(trx, tenantId, email)) {
        throw new AppError("ALREADY_MEMBER");
      }
      if (await this.invitations.hasPending(trx, tenantId, email)) {
        throw new AppError("INVITATION_PENDING");
      }
      const tenant = await this.invitations.tenantSeatState(trx, tenantId);
      if (tenant === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const limit = staffSeatLimit(tenant.limits);
      const used = await this.invitations.countSeatsUsed(trx, tenantId);
      if (used + 1 > limit) {
        throw new AppError("PLAN_LIMIT_REACHED", { details: { limit, used } });
      }
      const now = this.clock.now();
      const invitationId = this.ids.new("ivt");
      const { token, hash } = generateToken(INVITATION_TOKEN_PREFIX);
      await this.invitations.insert(trx, {
        id: invitationId,
        tenantId,
        email,
        role,
        tokenHash: hash,
        invitedByAccountId: caller.accountId,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        now,
      });
      await this.sendLink(trx, { tenantId, email, role, tenantName: tenant.name, inviter, token });
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: caller.accountId,
        action: "invitation.created",
        targetType: "invitation",
        targetId: invitationId,
        tenantId,
        details: { email, role },
      });
      return toInvitation(await this.reread(trx, tenantId, invitationId));
    });
  }

  /**
   * resendInvitation: a new token and 7 more days for the pending invitation `invitationId`, and the e-mail with the
   * new link. In this order `404 NOT_FOUND`, `403 FORBIDDEN`, `409 CONFLICT` (`not_pending`).
   */
  async resend(caller: TenantMembership, invitationId: string): Promise<void> {
    const { tenantId } = caller;
    await runInTransaction(this.db, async (trx) => {
      const { inviter, invitation } = await this.lockForChange(trx, caller, invitationId);
      const tenant = await this.invitations.tenantSeatState(trx, tenantId);
      if (tenant === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const now = this.clock.now();
      const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
      const { token, hash } = generateToken(INVITATION_TOKEN_PREFIX);
      await this.invitations.renewToken(trx, invitation.id, hash, expiresAt, now);
      await this.sendLink(trx, {
        tenantId,
        email: invitation.email,
        role: invitation.role as TenantRole,
        tenantName: tenant.name,
        inviter,
        token,
      });
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: caller.accountId,
        action: "invitation.resent",
        targetType: "invitation",
        targetId: invitation.id,
        tenantId,
        before: { expiresAt: invitation.expires_at.toISOString() },
        after: { expiresAt: expiresAt.toISOString() },
        details: { email: invitation.email, role: invitation.role },
      });
    });
  }

  /**
   * revokeInvitation: sets the pending invitation `invitationId` `revoked`; its link stops working and it frees its
   * seat. In this order `404 NOT_FOUND`, `403 FORBIDDEN`, `409 CONFLICT` (`not_pending`).
   */
  async revoke(caller: TenantMembership, invitationId: string): Promise<void> {
    const { tenantId } = caller;
    await runInTransaction(this.db, async (trx) => {
      const { invitation } = await this.lockForChange(trx, caller, invitationId);
      await this.invitations.markRevoked(trx, invitation.id, this.clock.now());
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: caller.accountId,
        action: "invitation.revoked",
        targetType: "invitation",
        targetId: invitation.id,
        tenantId,
        before: { status: PENDING },
        after: { status: "revoked" satisfies InvitationStatus },
        details: { email: invitation.email, role: invitation.role },
      });
    });
  }

  /** lookupInvitation: what the accept page shows, for a usable token; `400 INVITATION_INVALID` otherwise. Reads only. */
  async lookup(token: string): Promise<InvitationPreview> {
    const row = await this.invitations.findByTokenHash(this.db, sha256Hex(token));
    if (!isUsableInvitation(row, this.clock.now())) {
      throw new AppError("INVITATION_INVALID");
    }
    return {
      tenantName: row.tenant_name,
      role: row.role as TenantRole,
      email: row.email,
      inviterName: row.invited_by_account_id === null ? null : row.inviter_full_name,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /**
   * acceptInvitation: the account `accountId` joins the OTA of the invitation `token` (see the file header). In this
   * order `400 INVITATION_INVALID`, `401 UNAUTHENTICATED` (the account is gone or disabled), `403 EMAIL_NOT_VERIFIED`,
   * `403 INVITATION_EMAIL_MISMATCH`, `409 ALREADY_MEMBER`.
   */
  async accept(accountId: string, token: string): Promise<InvitationAccepted> {
    const tokenHash = sha256Hex(token);
    return runInTransaction(this.db, async (trx) => {
      const now = this.clock.now();
      const invitation = await this.invitations.findByTokenHash(trx, tokenHash, { lock: true });
      if (!isUsableInvitation(invitation, now) || !isTenantRole(invitation.role)) {
        throw new AppError("INVITATION_INVALID");
      }
      const account = await this.invitations.findAccount(trx, accountId);
      if (
        account === undefined ||
        account.deleted_at !== null ||
        CLOSED_ACCOUNT_STATUSES.has(account.status)
      ) {
        throw new AppError("UNAUTHENTICATED");
      }
      if (account.email_verified_at === null) {
        throw new AppError("EMAIL_NOT_VERIFIED");
      }
      if (account.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new AppError("INVITATION_EMAIL_MISMATCH");
      }
      const { tenant_id: tenantId, role } = invitation;
      const membership = {
        role,
        invitedByAccountId: invitation.invited_by_account_id,
        now,
      };
      const existing = await this.invitations.lockMembershipOf(trx, tenantId, accountId);
      let memberId: string;
      if (existing === undefined) {
        const inserted = await this.invitations.insertMembership(trx, {
          ...membership,
          newId: this.ids.new("stf"),
          tenantId,
          accountId,
        });
        if (inserted === undefined) {
          throw new AppError("ALREADY_MEMBER");
        }
        memberId = inserted;
      } else if (existing.status === ("removed" satisfies MembershipStatus)) {
        await this.invitations.reactivateMembership(trx, existing.id, membership);
        memberId = existing.id;
      } else {
        throw new AppError("ALREADY_MEMBER");
      }
      await this.invitations.markAccepted(trx, invitation.id, accountId, now);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "membership.created",
        targetType: "membership",
        targetId: memberId,
        tenantId,
        ...(existing === undefined ? {} : { before: { status: existing.status } }),
        after: { role, status: "active" satisfies MembershipStatus },
        details: {
          accountId,
          invitationId: invitation.id,
          invitedByAccountId: invitation.invited_by_account_id,
          reactivated: existing !== undefined,
        },
      });
      this.invalidations.publishAfterCommit(trx, membershipInvalidation(accountId, tenantId));
      const member = await this.invitations.findMember(trx, tenantId, memberId);
      const tenant = await this.invitations.findAcceptedTenant(trx, tenantId, memberId);
      if (member === undefined || tenant === undefined) {
        throw new Error("acceptInvitation: the membership just written cannot be read back");
      }
      return { membership: toMember(member), tenant: this.toTenantSummary(tenant) };
    });
  }

  /** The `TenantSummary` of an accepted invitation's OTA, as listTenants shows it. */
  private toTenantSummary(row: AcceptedTenantRow): TenantSummary {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      status: row.status as TenantSummary["status"],
      role: row.role as TenantRole,
      planCode: row.plan_code,
      // Every OTA gets its verified sub-domain as primary at creation (PF-40); the sub-domain name is the fallback.
      storefrontUrl: `https://${row.primary_host ?? storefrontHost(row.key, this.baseDomain)}/`,
      storefrontEnvironment: row.storefront_environment as TenantSummary["storefrontEnvironment"],
    };
  }

  /** Queues `team.invitation` to `email` with the accept link of `token`, in `trx`. */
  private async sendLink(
    trx: PlatformTransaction,
    link: {
      readonly tenantId: string;
      readonly email: string;
      readonly role: TenantRole;
      readonly tenantName: string;
      readonly inviter: LockedInviter;
      readonly token: string;
    },
  ): Promise<void> {
    await this.outbox.queue(trx, {
      templateKey: "team.invitation",
      to: link.email,
      tenantId: link.tenantId,
      data: { tenantName: link.tenantName, inviterName: link.inviter.full_name, role: link.role },
      secretData: { acceptUrl: this.outbox.portalLink(INVITATION_ACCEPT_PATH, { token: link.token }) },
    });
  }

  /**
   * The caller's membership locked and read again in `trx`: a removal of the caller committed since TenantRoleGuard's
   * read answers `404 NOT_FOUND`, as the guard answers a non-member, and a role change committed since then decides.
   */
  private async lockInviter(
    trx: PlatformTransaction,
    caller: TenantMembership,
  ): Promise<LockedInviter & { role: TenantRole }> {
    const inviter = await this.invitations.lockInviter(trx, caller.tenantId, caller.membershipId);
    if (
      inviter === undefined ||
      inviter.status !== ("active" satisfies MembershipStatus) ||
      !isTenantRole(inviter.role)
    ) {
      throw new AppError("NOT_FOUND");
    }
    return { ...inviter, role: inviter.role };
  }

  /**
   * The caller and the invitation `invitationId` of the caller's OTA, both locked, for a resend or a revocation: `404
   * NOT_FOUND` for an unknown invitation (or one of another OTA), `403 FORBIDDEN` when the caller may not manage the
   * invited role, `409 CONFLICT` (`not_pending`) when the invitation is not pending.
   */
  private async lockForChange(
    trx: PlatformTransaction,
    caller: TenantMembership,
    invitationId: string,
  ): Promise<{
    readonly inviter: LockedInviter & { role: TenantRole };
    readonly invitation: InvitationRecord;
  }> {
    const inviter = await this.lockInviter(trx, caller);
    const invitation = await this.invitations.lockForChange(trx, caller.tenantId, invitationId);
    if (invitation === undefined || !isTenantRole(invitation.role)) {
      throw new AppError("NOT_FOUND");
    }
    if (!canManageRole(inviter.role, invitation.role)) {
      throw new AppError("FORBIDDEN");
    }
    if (invitation.status !== PENDING) {
      throw new AppError("CONFLICT", { details: { reason: NOT_PENDING } });
    }
    return { inviter, invitation };
  }

  /** The invitation `invitationId` of `tenantId` with its inviter, read again in `trx` after a write. */
  private async reread(
    trx: PlatformTransaction,
    tenantId: string,
    invitationId: string,
  ): Promise<InvitationWithInviter> {
    const row = await this.invitations.find(tenantId, invitationId, trx);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return row;
  }
}
