// MembersService without a database (PBE-025; platform/docs/scope.md §1.2 and PF-21, flows/team-and-ota-admin-sso.md
// §B): the role matrix over every pair of roles for both changes, leaving, the step-up of granting owner, the
// last-owner rule, the order of the refusals, the audit rows, and the `membership` invalidation after the commit.
//
// The repository is an in-memory stand-in with the semantics of memberships.repository.ts: `lockForChange` returns the
// rows asked for and the OTA's active owners, and a transaction works on its own copy of the rows, which replaces the
// committed rows only when the work succeeds. The audit service and the invalidation publisher are the real ones, over
// stand-ins of their repository and of the Redis client. test/integration/memberships/members.int.test.ts runs the
// same rules through HTTP and PostgreSQL, the locking included.
import type { InvalidationEvent } from "@velexis/api-types/jobs";
import { isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { describe, expect, it } from "vitest";
import type { AuditRepository, AuditRowInsert } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import type { PlatformDb } from "../common/database";
import { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import { MembersService, membershipInvalidation, toMember } from "./members.service";
import type {
  LockedMembership,
  MemberRecord,
  MembershipsRepository,
  MembershipStatus,
} from "./memberships.repository";
import { TENANT_ROLES, type TenantRole } from "./tenant-roles";

/** A prefixed ULID of the shape of the platform's ids (`acc_…`, `stf_…`, `ten_…`) for sequence number `n`. */
function id(prefix: string, n: number): string {
  return `${prefix}_01JA2ZA1C5E9G3J7K2M6P0${String(n).padStart(4, "0")}`;
}

const TENANT = id("ten", 1);
const OTHER_TENANT = id("ten", 2);

/**
 * Scope §1.2 written out: the roles of the members each role may change or remove, which are also the roles it may
 * set ("Invite and manage agent, finance and viewer members": owners and admins; "Grant or remove owner and admin
 * roles": owners only).
 */
const MANAGES: Readonly<Record<TenantRole, readonly TenantRole[]>> = {
  owner: ["owner", "admin", "agent", "finance", "viewer"],
  admin: ["agent", "finance", "viewer"],
  agent: [],
  finance: [],
  viewer: [],
};

type Row = { -readonly [K in keyof MemberRecord]: MemberRecord[K] };

/** A transaction of the stand-in database: its own copy of the rows, and the audit rows it wrote. */
interface FakeTransaction {
  readonly rows: Map<string, Row>;
  readonly audit: AuditRowInsert[];
}

const copyRows = (rows: ReadonlyMap<string, Row>): Map<string, Row> =>
  new Map([...rows].map(([key, row]) => [key, { ...row }]));

/** One OTA's members, the service over them, and what it committed and published. */
class Team {
  rows = new Map<string, Row>();
  readonly audit: AuditRowInsert[] = [];
  /** The events sent to Redis, each with the member's committed row at that moment. */
  readonly published: Array<{ event: InvalidationEvent; committed: Row | undefined }> = [];
  readonly clock = new FakeClock("2026-10-17T09:00:00Z");
  readonly service: MembersService;
  private sequence = 0;

  constructor() {
    const repository = {
      listActive: (tenantId: string) =>
        Promise.resolve(
          [...this.rows.values()]
            .filter((row) => row.tenant_id === tenantId && row.status === "active")
            .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : 1)),
        ),
      findMember: (tenantId: string, memberId: string, db?: FakeTransaction) => {
        const row = (db?.rows ?? this.rows).get(memberId);
        return Promise.resolve(row?.tenant_id === tenantId ? { ...row } : undefined);
      },
      lockForChange: (trx: FakeTransaction, tenantId: string, ids: readonly string[]) =>
        Promise.resolve(
          [...trx.rows.values()]
            .filter(
              (row) =>
                row.tenant_id === tenantId &&
                (ids.includes(row.id) || (row.role === "owner" && row.status === "active")),
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((row): LockedMembership => ({
              id: row.id,
              account_id: row.account_id,
              role: row.role,
              status: row.status,
              version: row.version,
              mfa_enabled: row.mfa_enabled,
            })),
        ),
      updateRole: (trx: FakeTransaction, memberId: string, role: TenantRole) => {
        this.write(trx, memberId, { role });
        return Promise.resolve();
      },
      updateStatus: (trx: FakeTransaction, memberId: string, status: MembershipStatus) => {
        this.write(trx, memberId, { status });
        return Promise.resolve();
      },
    };
    const db = {
      transaction: () => ({
        execute: async <T>(work: (trx: FakeTransaction) => Promise<T>): Promise<T> => {
          const trx: FakeTransaction = { rows: copyRows(this.rows), audit: [] };
          const result = await work(trx);
          this.rows = trx.rows;
          this.audit.push(...trx.audit);
          return result;
        },
      }),
    };
    const auditRepository = {
      insert: (trx: FakeTransaction, row: AuditRowInsert) => {
        trx.audit.push(row);
        return Promise.resolve({
          id: String(this.audit.length + trx.audit.length),
          createdAt: this.clock.now(),
        });
      },
    };
    const redis = {
      publish: (_channel: string, message: string) => {
        const event = JSON.parse(message) as InvalidationEvent;
        const committed = [...this.rows.values()].find(
          (row) => "accountId" in event && row.account_id === event.accountId && row.tenant_id === TENANT,
        );
        this.published.push({ event, committed: committed === undefined ? undefined : { ...committed } });
        return Promise.resolve(1);
      },
    };
    this.service = new MembersService(
      repository as unknown as MembershipsRepository,
      new AuditService(auditRepository as unknown as AuditRepository),
      new InvalidationPublisher(redis as unknown as ConstructorParameters<typeof InvalidationPublisher>[0], {
        warn: () => undefined,
      }),
      this.clock,
      db as unknown as PlatformDb,
    );
  }

  /** Adds a member of TENANT (or `tenantId`) with `role`; active and with MFA unless `options` say otherwise. */
  add(role: TenantRole, options: { status?: MembershipStatus; mfa?: boolean; tenantId?: string } = {}): Row {
    this.sequence += 1;
    const row: Row = {
      id: id("stf", this.sequence),
      tenant_id: options.tenantId ?? TENANT,
      account_id: id("acc", this.sequence),
      role,
      status: options.status ?? "active",
      version: 1,
      created_at: new Date(Date.UTC(2026, 9, 1, 9, this.sequence)),
      full_name: `Person ${this.sequence}`,
      email: `person${this.sequence}@example.com`,
      mfa_enabled: options.mfa ?? true,
    };
    this.rows.set(row.id, row);
    return row;
  }

  /** A row as committed now. */
  row(memberId: string): Row | undefined {
    const row = this.rows.get(memberId);
    return row === undefined ? undefined : { ...row };
  }

  private write(trx: FakeTransaction, memberId: string, change: Partial<Row>): void {
    const row = trx.rows.get(memberId);
    if (row === undefined) {
      throw new Error(`no row ${memberId} to write`);
    }
    Object.assign(row, change, { version: row.version + 1 });
  }
}

/** The membership TenantRoleGuard would hand the service for `row`. */
const membershipOf = (row: Row): TenantMembership => ({
  membershipId: row.id,
  tenantId: row.tenant_id,
  accountId: row.account_id,
  role: row.role as TenantRole,
});

type Claims = Pick<AccessTokenClaims, "mfa_at">;
const nowSeconds = (team: Team): number => Math.floor(team.clock.now().getTime() / 1000);
/** A TOTP verification a minute ago: the step-up of granting owner holds. */
const stepUp = (team: Team): Claims => ({ mfa_at: nowSeconds(team) - 60 });
/** A TOTP verification 16 minutes ago: older than the 15-minute window. */
const staleStepUp = (team: Team): Claims => ({ mfa_at: nowSeconds(team) - 16 * 60 });

/** `ok`, or the code of the AppError the work threw. */
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (isAppError(error)) {
      return error.code;
    }
    throw error;
  }
}

describe("toMember", () => {
  it("maps a membership row and its account to the Member of the document", () => {
    const team = new Team();
    const row = team.add("finance", { mfa: false });

    expect(toMember(row)).toEqual({
      id: row.id,
      accountId: row.account_id,
      fullName: row.full_name,
      email: row.email,
      role: "finance",
      status: "active",
      mfaEnabled: false,
      createdAt: row.created_at.toISOString(),
      version: 1,
    });
  });
});

describe("list", () => {
  it("answers the active members of the caller's OTA, oldest first", async () => {
    const team = new Team();
    const owner = team.add("owner");
    team.add("admin", { status: "removed" });
    team.add("agent", { status: "suspended" });
    const viewer = team.add("viewer");
    team.add("owner", { tenantId: OTHER_TENANT });

    const list = await team.service.list(membershipOf(viewer));

    expect(list).toEqual({ data: [toMember(owner), toMember(viewer)] });
  });
});

describe("changeRole", () => {
  it("[PBE-025 AC1] follows the role matrix of scope §1.2 for every caller role, member role and new role [PF-21 AC1]", async () => {
    const outcomes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const callerRole of TENANT_ROLES) {
      for (const memberRole of TENANT_ROLES) {
        for (const newRole of TENANT_ROLES) {
          const team = new Team();
          // Another owner, so the last-owner rule never decides here.
          team.add("owner");
          const caller = team.add(callerRole);
          const member = team.add(memberRole);
          const label = `${callerRole} sets ${memberRole} to ${newRole}`;

          outcomes[label] = await outcome(
            team.service.changeRole(membershipOf(caller), stepUp(team), member.id, 1, newRole),
          );

          const allowed = MANAGES[callerRole].includes(memberRole) && MANAGES[callerRole].includes(newRole);
          expected[label] = allowed ? "ok" : "FORBIDDEN";
          expect(team.row(member.id)?.role, label).toBe(allowed ? newRole : memberRole);
          expect(team.audit.length, label).toBe(allowed && newRole !== memberRole ? 1 : 0);
        }
      }
    }

    expect(Object.keys(outcomes)).toHaveLength(125);
    expect(outcomes).toEqual(expected);
  });

  it("answers the member with the new role and version, and writes nothing for the role the member has", async () => {
    const team = new Team();
    const owner = team.add("owner");
    const agent = team.add("agent");

    const changed = await team.service.changeRole(membershipOf(owner), {}, agent.id, 1, "finance");
    const unchanged = await team.service.changeRole(membershipOf(owner), {}, agent.id, 2, "finance");

    expect(changed).toEqual({ ...toMember(agent), role: "finance", version: 2 });
    expect(unchanged).toEqual(changed);
    expect(team.audit).toHaveLength(1);
    expect(team.published).toHaveLength(1);
  });

  it("[PBE-025 AC1] needs a step-up within 15 minutes to grant owner, and none for the other changes", async () => {
    const team = new Team();
    const owner = team.add("owner");
    const ownerWithoutMfa = team.add("owner", { mfa: false });
    const admin = team.add("admin");
    const agent = team.add("agent");
    const otherOwner = team.add("owner");
    const grant = (caller: Row, claims: Claims) =>
      outcome(team.service.changeRole(membershipOf(caller), claims, agent.id, 1, "owner"));

    expect(await grant(ownerWithoutMfa, stepUp(team))).toBe("MFA_REQUIRED");
    expect(await grant(owner, {})).toBe("REAUTH_REQUIRED");
    expect(await grant(owner, staleStepUp(team))).toBe("REAUTH_REQUIRED");
    // The matrix first: an admin may never grant owner, with or without a step-up.
    expect(await grant(admin, stepUp(team))).toBe("FORBIDDEN");
    expect(team.row(agent.id)).toMatchObject({ role: "agent", version: 1 });

    expect(await grant(owner, stepUp(team))).toBe("ok");
    // Demoting an owner, setting owner on an owner and the other roles need none.
    expect(await outcome(team.service.changeRole(membershipOf(owner), {}, otherOwner.id, 1, "owner"))).toBe(
      "ok",
    );
    expect(
      await outcome(team.service.changeRole(membershipOf(ownerWithoutMfa), {}, otherOwner.id, 1, "admin")),
    ).toBe("ok");
    expect(await outcome(team.service.changeRole(membershipOf(owner), {}, admin.id, 1, "viewer"))).toBe("ok");
    expect(team.row(agent.id)?.role).toBe("owner");
    expect(team.row(otherOwner.id)?.role).toBe("admin");
  });

  it("[PBE-025 AC2] refuses to demote the last active owner with LAST_OWNER; removed and suspended owners do not count [PF-21 AC2]", async () => {
    const team = new Team();
    const owner = team.add("owner");
    team.add("owner", { status: "removed" });
    team.add("owner", { status: "suspended" });
    const admin = team.add("admin");

    expect(await outcome(team.service.changeRole(membershipOf(owner), {}, owner.id, 1, "admin"))).toBe(
      "LAST_OWNER",
    );
    expect(team.row(owner.id)).toMatchObject({ role: "owner", version: 1 });

    // With a second owner, the first may step down; then the second is the last one.
    await team.service.changeRole(membershipOf(owner), stepUp(team), admin.id, 1, "owner");
    expect(await outcome(team.service.changeRole(membershipOf(owner), {}, owner.id, 1, "admin"))).toBe("ok");
    expect(await outcome(team.service.changeRole(membershipOf(admin), {}, admin.id, 2, "viewer"))).toBe(
      "LAST_OWNER",
    );
    expect(team.audit.map((row) => row.action)).toEqual([
      "membership.role_changed",
      "membership.role_changed",
    ]);
  });

  it("refuses in this order: NOT_FOUND, FORBIDDEN, the step-up, PRECONDITION_FAILED, LAST_OWNER", async () => {
    const team = new Team();
    const owner = team.add("owner");
    const admin = team.add("admin");
    const agent = team.add("agent");
    const removed = team.add("agent", { status: "removed" });
    const suspended = team.add("agent", { status: "suspended" });
    const elsewhere = team.add("agent", { tenantId: OTHER_TENANT });
    const change = (caller: Row, memberId: string, version: number, role: TenantRole, claims: Claims = {}) =>
      outcome(team.service.changeRole(membershipOf(caller), claims, memberId, version, role));

    for (const memberId of [id("stf", 9_999), removed.id, suspended.id, elsewhere.id]) {
      expect(await change(owner, memberId, 1, "owner"), memberId).toBe("NOT_FOUND");
    }
    expect(await change(admin, owner.id, 2, "owner")).toBe("FORBIDDEN");
    expect(await change(owner, agent.id, 2, "owner")).toBe("REAUTH_REQUIRED");
    expect(await change(owner, agent.id, 2, "owner", stepUp(team))).toBe("PRECONDITION_FAILED");
    expect(await change(owner, owner.id, 2, "admin")).toBe("PRECONDITION_FAILED");
    expect(await change(owner, owner.id, 1, "admin")).toBe("LAST_OWNER");
    expect(team.audit).toEqual([]);
    expect(team.published).toEqual([]);
  });

  it("reads the caller's membership again under the lock: a removal or demotion committed since the guard's read wins", async () => {
    const team = new Team();
    team.add("owner");
    const admin = team.add("admin");
    const leaver = team.add("admin");
    const agent = team.add("agent");
    const guardRead = { admin: membershipOf(admin), leaver: membershipOf(leaver) };
    // Committed after TenantRoleGuard read the two memberships.
    await team.service.changeRole(guardRead.admin, {}, agent.id, 1, "viewer");
    Object.assign(team.rows.get(admin.id) ?? {}, { role: "agent" });
    Object.assign(team.rows.get(leaver.id) ?? {}, { status: "removed" });

    expect(await outcome(team.service.changeRole(guardRead.admin, {}, agent.id, 2, "finance"))).toBe(
      "FORBIDDEN",
    );
    expect(await outcome(team.service.changeRole(guardRead.leaver, {}, agent.id, 2, "finance"))).toBe(
      "NOT_FOUND",
    );
    expect(await outcome(team.service.remove(guardRead.leaver, agent.id))).toBe("NOT_FOUND");
    expect(team.row(agent.id)).toMatchObject({ role: "viewer", status: "active" });
  });

  it("writes one membership.role_changed audit row with the roles before and after", async () => {
    const team = new Team();
    const owner = team.add("owner");
    const agent = team.add("agent");

    await team.service.changeRole(membershipOf(owner), {}, agent.id, 1, "finance");

    expect(team.audit).toEqual([
      expect.objectContaining({
        actorType: "account",
        actorAccountId: owner.account_id,
        action: "membership.role_changed",
        targetType: "membership",
        targetId: agent.id,
        tenantId: TENANT,
      }),
    ]);
    expect(JSON.parse(team.audit[0]?.detailsJson ?? "null")).toEqual({
      accountId: agent.account_id,
      before: { role: "agent" },
      after: { role: "finance" },
    });
  });
});

describe("remove", () => {
  it("[PBE-025 AC1] follows the role matrix of scope §1.2 for every caller role and member role, and lets every member leave [PF-21 AC1]", async () => {
    const outcomes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const callerRole of TENANT_ROLES) {
      for (const memberRole of [...TENANT_ROLES, "themself"] as const) {
        const team = new Team();
        // Another owner, so the last-owner rule never decides here.
        team.add("owner");
        const caller = team.add(callerRole);
        const member = memberRole === "themself" ? caller : team.add(memberRole);
        const label = `${callerRole} removes ${memberRole}`;

        outcomes[label] = await outcome(team.service.remove(membershipOf(caller), member.id));

        const allowed = memberRole === "themself" || MANAGES[callerRole].includes(memberRole);
        expected[label] = allowed ? "ok" : "FORBIDDEN";
        expect(team.row(member.id)?.status, label).toBe(allowed ? "removed" : "active");
      }
    }

    expect(Object.keys(outcomes)).toHaveLength(30);
    expect(outcomes).toEqual(expected);
  });

  it("[PBE-025 AC2] refuses the last active owner's leaving with LAST_OWNER; removed and suspended owners do not count [PF-21 AC2]", async () => {
    const team = new Team();
    const owner = team.add("owner");
    team.add("owner", { status: "removed" });
    team.add("owner", { status: "suspended" });
    const second = team.add("admin");

    expect(await outcome(team.service.remove(membershipOf(owner), owner.id))).toBe("LAST_OWNER");
    expect(team.row(owner.id)).toMatchObject({ status: "active", version: 1 });

    await team.service.changeRole(membershipOf(owner), stepUp(team), second.id, 1, "owner");
    expect(await outcome(team.service.remove(membershipOf(owner), owner.id))).toBe("ok");
    expect(await outcome(team.service.remove(membershipOf(second), second.id))).toBe("LAST_OWNER");
    expect(team.row(owner.id)).toMatchObject({ status: "removed", role: "owner", version: 2 });
  });

  it("answers NOT_FOUND for an unknown, removed, suspended or other OTA's member", async () => {
    const team = new Team();
    const owner = team.add("owner");
    const members = [
      id("stf", 9_999),
      team.add("agent", { status: "removed" }).id,
      team.add("agent", { status: "suspended" }).id,
      team.add("agent", { tenantId: OTHER_TENANT }).id,
    ];

    for (const memberId of members) {
      expect(await outcome(team.service.remove(membershipOf(owner), memberId)), memberId).toBe("NOT_FOUND");
    }
    expect(team.audit).toEqual([]);
  });

  it("keeps the row and writes one membership.removed audit row, which says whether the member left", async () => {
    const team = new Team();
    const owner = team.add("owner");
    const agent = team.add("agent");
    const viewer = team.add("viewer");

    await team.service.remove(membershipOf(owner), agent.id);
    await team.service.remove(membershipOf(viewer), viewer.id);

    expect(team.row(agent.id)).toMatchObject({ status: "removed", role: "agent", version: 2 });
    expect(team.audit.map((row) => [row.action, row.actorAccountId, row.targetType, row.targetId])).toEqual([
      ["membership.removed", owner.account_id, "membership", agent.id],
      ["membership.removed", viewer.account_id, "membership", viewer.id],
    ]);
    expect(team.audit.map((row) => JSON.parse(row.detailsJson) as unknown)).toEqual([
      {
        accountId: agent.account_id,
        left: false,
        before: { role: "agent", status: "active" },
        after: { status: "removed" },
      },
      {
        accountId: viewer.account_id,
        left: true,
        before: { role: "viewer", status: "active" },
        after: { status: "removed" },
      },
    ]);
  });
});

describe("the membership invalidation", () => {
  it("[PBE-025 AC3] is published after the commit of a removal and of a role change, and never for a refused or unchanged one [PF-21 AC3]", async () => {
    const team = new Team();
    const owner = team.add("owner");
    const agent = team.add("agent");
    const viewer = team.add("viewer");

    await outcome(team.service.remove(membershipOf(owner), owner.id));
    await outcome(team.service.remove(membershipOf(agent), viewer.id));
    await team.service.changeRole(membershipOf(owner), {}, viewer.id, 1, "viewer");
    await team.service.changeRole(membershipOf(owner), {}, viewer.id, 1, "finance");
    await team.service.remove(membershipOf(owner), agent.id);

    expect(team.published).toEqual([
      {
        event: { v: 1, type: "membership", accountId: viewer.account_id, tenantId: TENANT },
        committed: expect.objectContaining({ role: "finance", status: "active", version: 2 }) as unknown,
      },
      {
        event: { v: 1, type: "membership", accountId: agent.account_id, tenantId: TENANT },
        committed: expect.objectContaining({ status: "removed", version: 2 }) as unknown,
      },
    ]);
  });

  it("is the event the OTA backend drops `member:<accountId>:<tenantId>` for", () => {
    expect(membershipInvalidation(id("acc", 7), TENANT)).toEqual({
      v: 1,
      type: "membership",
      accountId: id("acc", 7),
      tenantId: TENANT,
    });
  });
});
