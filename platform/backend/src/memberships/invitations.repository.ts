// The `tenant_invitations` repository (platform/docs/architecture.md §2.1: MembershipsModule owns the table, and
// `tenant_memberships`; PBE-026, flows/team-and-ota-admin-sso.md §A). Kysely on the process's `PLATFORM_DB` (the API's
// pool, or the worker's for `invitations.expire`), schema-qualified tables (ADR-0005). Only the SHA-256 of an
// invitation token is stored (`token_hash`, unique); the token itself exists only in the e-mail's link, which the
// outbox keeps encrypted until the e-mail is sent.
//
// It also holds the writes of an accepted invitation to `tenant_memberships` (a new membership, or a `removed` one
// made active again), next to the invitation they come from, and reads what the invitation routes show or decide on,
// read only, as the operations' `x-platform-tables` say (resource modules of one layer never import each other,
// architecture §2.2): the inviter's and the invitee's account (`accounts`), the OTA and its plan's `staffSeats`
// (`tenants`, `plans`) and the primary storefront host (`tenant_domains`).
//
// E-mail addresses are stored as typed (trimmed) and compared lower-cased, as the unique index
// `tenant_invitations_pending_uq` on `(tenant_id, lower(email)) WHERE status = 'pending'` does. Times are the
// service's `Clock`, never the database's `now()`, so expiry follows the FakeClock in tests.
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import type { TenantRole } from "../common/auth/tenant-role.guard";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import type { MemberRecord, MembershipStatus } from "./memberships.repository";

/** A `platform.tenant_invitations` row as the platform reads it. */
export type InvitationRecord = Selectable<PlatformDatabase["platform.tenant_invitations"]>;

/** The states of `tenant_invitations.status` (migration 0001). */
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/** An invitation with the inviter's name, as the list and the answers show it (`null` once the account is gone). */
export interface InvitationWithInviter extends InvitationRecord {
  readonly inviter_full_name: string | null;
}

/** An invitation found by its token, with what the accept page shows and what acceptance decides on. */
export interface InvitationByToken extends InvitationWithInviter {
  readonly tenant_name: string;
  readonly tenant_status: string;
  readonly tenant_deleted_at: Date | null;
}

/** A new invitation: `pending`, with the hash of its token. */
export interface NewInvitation {
  /** `ivt_…`. */
  readonly id: string;
  readonly tenantId: string;
  /** The address as typed, trimmed. */
  readonly email: string;
  readonly role: TenantRole;
  /** `sha256Hex` of the token. */
  readonly tokenHash: string;
  readonly invitedByAccountId: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

/** The caller's membership as a change of the invitations sees it once locked, with the caller's name. */
export interface LockedInviter {
  readonly role: string;
  readonly status: string;
  readonly full_name: string;
}

/** What decides whether an OTA may send one more invitation: its name and its plan's `limits`. */
export interface TenantSeatState {
  readonly name: string;
  /** `plans.limits` of the tenant's plan (`staffSeats` among them); `null` when the plan row is missing. */
  readonly limits: unknown;
}

/** The account that accepts an invitation, as acceptance checks it. */
export interface AcceptingAccount {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly email_verified_at: Date | null;
  readonly deleted_at: Date | null;
}

/** An invitation that `expireDue` set `expired`. */
export interface ExpiredInvitation {
  readonly id: string;
  readonly tenant_id: string;
  readonly email: string;
  readonly role: string;
}

/** The OTA of an accepted invitation, as `TenantSummary` shows it (TenantsRepository's `TenantListRow`). */
export interface AcceptedTenantRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: string;
  readonly plan_code: string;
  readonly storefront_environment: string;
  readonly role: string;
  readonly primary_host: string | null;
}

/** The membership an accepted invitation inserts or makes active again. */
export interface AcceptedMembership {
  /** `stf_…` of a new membership; a removed one keeps its own id. */
  readonly newId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly role: TenantRole;
  readonly invitedByAccountId: string | null;
  readonly now: Date;
}

/** The invitation columns with the inviter's name. */
const INVITATION_COLUMNS = [
  "i.id",
  "i.tenant_id",
  "i.email",
  "i.role",
  "i.token_hash",
  "i.status",
  "i.invited_by_account_id",
  "i.accepted_account_id",
  "i.expires_at",
  "i.accepted_at",
  "i.revoked_at",
  "i.created_at",
  "i.updated_at",
  "inviter.full_name as inviter_full_name",
] as const;

@Injectable()
export class InvitationsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * Waits until no other transaction holds the invitations lock of `tenantId`, and holds it until `trx` ends
   * (`pg_advisory_xact_lock`), so the seat check and the insert of an invitation happen as one step per tenant: two
   * concurrent invitations cannot both take the last free seat, nor both pass the pending-invitation check.
   */
  async lockTenantInvitations(trx: PlatformTransaction, tenantId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`platform.tenant_invitations:${tenantId}`}, 0))`.execute(
      trx,
    );
  }

  /**
   * The caller's membership `membershipId` of `tenantId` with the caller's full name, locked for the rest of `trx`
   * (`FOR SHARE`: a role change or removal of the caller waits for this change, and this change sees one committed
   * before it); `undefined` when there is no such membership.
   */
  async lockInviter(
    trx: PlatformTransaction,
    tenantId: string,
    membershipId: string,
  ): Promise<LockedInviter | undefined> {
    return trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(["m.role", "m.status", "a.full_name"])
      .where("m.id", "=", membershipId)
      .where("m.tenant_id", "=", tenantId)
      .forShare("m")
      .executeTakeFirst();
  }

  /** The OTA's name and its plan's limits; `undefined` when there is no such tenant. */
  async tenantSeatState(trx: PlatformTransaction, tenantId: string): Promise<TenantSeatState | undefined> {
    return trx
      .selectFrom("platform.tenants as t")
      .leftJoin("platform.plans as p", "p.code", "t.plan_code")
      .select(["t.name", "p.limits"])
      .where("t.id", "=", tenantId)
      .executeTakeFirst();
  }

  /** The seats the OTA uses: its `active` members and its `pending` invitations (flow §A step 1). */
  async countSeatsUsed(trx: PlatformTransaction, tenantId: string): Promise<number> {
    const row = await trx
      .selectNoFrom((eb) => [
        eb
          .selectFrom("platform.tenant_memberships")
          .select((inner) => inner.fn.countAll<string>().as("n"))
          .where("tenant_id", "=", tenantId)
          .where("status", "=", "active" satisfies MembershipStatus)
          .as("members"),
        eb
          .selectFrom("platform.tenant_invitations")
          .select((inner) => inner.fn.countAll<string>().as("n"))
          .where("tenant_id", "=", tenantId)
          .where("status", "=", "pending" satisfies InvitationStatus)
          .as("invitations"),
      ])
      .executeTakeFirstOrThrow();
    return Number(row.members ?? 0) + Number(row.invitations ?? 0);
  }

  /**
   * True when an account whose address equals `email` ignoring letter case is a member of `tenantId` that has not
   * been removed (`active`, or `suspended`: still on the team, and an invitation cannot make it active again).
   */
  async isMemberEmail(trx: PlatformTransaction, tenantId: string, email: string): Promise<boolean> {
    const row = await trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(sql<number>`1`.as("found"))
      .where("m.tenant_id", "=", tenantId)
      .where("m.status", "<>", "removed" satisfies MembershipStatus)
      .where(sql<string>`lower(a.email)`, "=", sql<string>`lower(${email})`)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** True when `tenantId` has a `pending` invitation for `email` (ignoring letter case). */
  async hasPending(trx: PlatformTransaction, tenantId: string, email: string): Promise<boolean> {
    const row = await trx
      .selectFrom("platform.tenant_invitations")
      .select(sql<number>`1`.as("found"))
      .where("tenant_id", "=", tenantId)
      .where("status", "=", "pending" satisfies InvitationStatus)
      .where(sql<string>`lower(email)`, "=", sql<string>`lower(${email})`)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Inserts `invitation` (`pending`) in `trx`. */
  async insert(trx: PlatformTransaction, invitation: NewInvitation): Promise<void> {
    await trx
      .insertInto("platform.tenant_invitations")
      .values({
        id: invitation.id,
        tenant_id: invitation.tenantId,
        email: invitation.email,
        role: invitation.role,
        token_hash: invitation.tokenHash,
        status: "pending" satisfies InvitationStatus,
        invited_by_account_id: invitation.invitedByAccountId,
        expires_at: invitation.expiresAt,
        created_at: invitation.now,
        updated_at: invitation.now,
      })
      .execute();
  }

  /** The `pending` invitations of `tenantId`, newest first (then by id, so the order is stable), with the inviter. */
  async listPending(tenantId: string): Promise<InvitationWithInviter[]> {
    return this.withInviter(this.db)
      .where("i.tenant_id", "=", tenantId)
      .where("i.status", "=", "pending" satisfies InvitationStatus)
      .orderBy("i.created_at", "desc")
      .orderBy("i.id", "desc")
      .execute();
  }

  /** The invitation `invitationId` of `tenantId` with the inviter, in any state, read on `db`. */
  async find(
    tenantId: string,
    invitationId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<InvitationWithInviter | undefined> {
    return this.withInviter(db)
      .where("i.tenant_id", "=", tenantId)
      .where("i.id", "=", invitationId)
      .executeTakeFirst();
  }

  /** The invitation `invitationId` of `tenantId`, locked for the rest of `trx` (`FOR UPDATE`), in any state. */
  async lockForChange(
    trx: PlatformTransaction,
    tenantId: string,
    invitationId: string,
  ): Promise<InvitationRecord | undefined> {
    return trx
      .selectFrom("platform.tenant_invitations")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("id", "=", invitationId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Sets a locked `pending` invitation `revoked` at `now`, in `trx`. Throws when no row has the id. */
  async markRevoked(trx: PlatformTransaction, invitationId: string, now: Date): Promise<void> {
    await trx
      .updateTable("platform.tenant_invitations")
      .set({ status: "revoked" satisfies InvitationStatus, revoked_at: now, updated_at: now })
      .where("id", "=", invitationId)
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  /**
   * Gives a locked `pending` invitation a new token hash and expiry, in `trx`: the old link stops working at once.
   * Throws when no row has the id.
   */
  async renewToken(
    trx: PlatformTransaction,
    invitationId: string,
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.tenant_invitations")
      .set({ token_hash: tokenHash, expires_at: expiresAt, updated_at: now })
      .where("id", "=", invitationId)
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  /**
   * The invitation whose token hash is `tokenHash`, with the inviter's name and the OTA's name and state, in any
   * state, read on `db`; `undefined` for an unknown token. With `lock`, the invitation row is locked for the rest of
   * the transaction (`FOR UPDATE`), so two acceptances of one link run one after the other.
   */
  async findByTokenHash(
    db: PlatformDb | PlatformTransaction,
    tokenHash: string,
    options: { readonly lock?: boolean } = {},
  ): Promise<InvitationByToken | undefined> {
    const query = this.withInviter(db)
      .innerJoin("platform.tenants as t", "t.id", "i.tenant_id")
      .select(["t.name as tenant_name", "t.status as tenant_status", "t.deleted_at as tenant_deleted_at"])
      .where("i.token_hash", "=", tokenHash);
    return (options.lock === true ? query.forUpdate("i") : query).executeTakeFirst();
  }

  /** The account `accountId` as acceptance checks it; `undefined` when there is none. */
  async findAccount(trx: PlatformTransaction, accountId: string): Promise<AcceptingAccount | undefined> {
    return trx
      .selectFrom("platform.accounts")
      .select(["id", "email", "status", "email_verified_at", "deleted_at"])
      .where("id", "=", accountId)
      .executeTakeFirst();
  }

  /** The membership of `accountId` in `tenantId` in any state, locked for the rest of `trx` (`FOR UPDATE`). */
  async lockMembershipOf(
    trx: PlatformTransaction,
    tenantId: string,
    accountId: string,
  ): Promise<{ readonly id: string; readonly status: string } | undefined> {
    return trx
      .selectFrom("platform.tenant_memberships")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("account_id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Inserts the `active` membership of an accepted invitation in `trx`, unless the account has a membership of the
   * OTA already (`ON CONFLICT (tenant_id, account_id) DO NOTHING`, which waits for a concurrent insert of the same
   * pair). Returns the new id, or `undefined` when the pair existed.
   */
  async insertMembership(
    trx: PlatformTransaction,
    membership: AcceptedMembership,
  ): Promise<string | undefined> {
    const row = await trx
      .insertInto("platform.tenant_memberships")
      .values({
        id: membership.newId,
        tenant_id: membership.tenantId,
        account_id: membership.accountId,
        role: membership.role,
        status: "active" satisfies MembershipStatus,
        invited_by_account_id: membership.invitedByAccountId,
        created_at: membership.now,
        updated_at: membership.now,
      })
      .onConflict((conflict) => conflict.columns(["tenant_id", "account_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    return row?.id;
  }

  /**
   * Makes the locked `removed` membership `memberId` active again with the invitation's role and inviter, with
   * `version + 1`, in `trx`. Throws when the row is not `removed` (nothing changes).
   */
  async reactivateMembership(
    trx: PlatformTransaction,
    memberId: string,
    membership: Omit<AcceptedMembership, "newId" | "tenantId" | "accountId">,
  ): Promise<void> {
    await trx
      .updateTable("platform.tenant_memberships")
      .set({
        status: "active" satisfies MembershipStatus,
        role: membership.role,
        invited_by_account_id: membership.invitedByAccountId,
        version: sql<number>`version + 1`,
        updated_at: membership.now,
      })
      .where("id", "=", memberId)
      .where("status", "=", "removed" satisfies MembershipStatus)
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  /** Sets a locked `pending` invitation `accepted` by `accountId` at `now`, in `trx`. Throws when no row has the id. */
  async markAccepted(
    trx: PlatformTransaction,
    invitationId: string,
    accountId: string,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.tenant_invitations")
      .set({
        status: "accepted" satisfies InvitationStatus,
        accepted_account_id: accountId,
        accepted_at: now,
        updated_at: now,
      })
      .where("id", "=", invitationId)
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  /** The membership `memberId` of `tenantId` with the account's name, e-mail address and MFA flag, read in `trx`. */
  async findMember(
    trx: PlatformTransaction,
    tenantId: string,
    memberId: string,
  ): Promise<MemberRecord | undefined> {
    return trx
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
      ])
      .where("m.tenant_id", "=", tenantId)
      .where("m.id", "=", memberId)
      .executeTakeFirst();
  }

  /** The OTA of an accepted invitation with the new member's role and the primary storefront host, read in `trx`. */
  async findAcceptedTenant(
    trx: PlatformTransaction,
    tenantId: string,
    memberId: string,
  ): Promise<AcceptedTenantRow | undefined> {
    return trx
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
      .where("m.id", "=", memberId)
      .where("m.tenant_id", "=", tenantId)
      .executeTakeFirst();
  }

  /**
   * Sets at most `limit` `pending` invitations whose `expires_at` is at or before `now` `expired`, in `trx`, and
   * returns them. Rows another transaction holds (an acceptance or a resend under way) are skipped (`SKIP LOCKED`):
   * that transaction decides on them, and a later run takes those still due.
   */
  async expireDue(trx: PlatformTransaction, now: Date, limit: number): Promise<ExpiredInvitation[]> {
    return trx
      .updateTable("platform.tenant_invitations")
      .set({ status: "expired" satisfies InvitationStatus, updated_at: now })
      .where("id", "in", (eb) =>
        eb
          .selectFrom("platform.tenant_invitations")
          .select("id")
          .where("status", "=", "pending" satisfies InvitationStatus)
          .where("expires_at", "<=", now)
          .orderBy("id")
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .returning(["id", "tenant_id", "email", "role"])
      .execute();
  }

  /** The invitation columns with the inviter's full name (`null` once the account is gone). */
  private withInviter(db: PlatformDb | PlatformTransaction) {
    return db
      .selectFrom("platform.tenant_invitations as i")
      .leftJoin("platform.accounts as inviter", "inviter.id", "i.invited_by_account_id")
      .select(INVITATION_COLUMNS);
  }
}
