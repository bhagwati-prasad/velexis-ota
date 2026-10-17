// The team routes of the portal (PBE-025; platform/docs/api-inventory.md §8, flows/team-and-ota-admin-sso.md §B, scope
// §1.2 and PF-21) through the HTTP pipeline (createTestApp) on this file's database clone: the member list, role
// changes with If-Match and the step-up of granting owner, removals and leaving, the last-owner rule (also for
// concurrent requests, which the row locks of lockForChange serialise), the audit rows, and the `membership`
// invalidation after the commit that the OTA admin's cache relies on. Accounts, OTAs and memberships are written with
// the builders; tokens come from the application's TokenService. Every answer is checked against the platform
// document. TenantRoleGuard's `404` for non-members on these routes is tested with every tenant route in
// test/integration/tenants/tenants.int.test.ts.
//
// Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same time,
// so the subscriber keeps only the events of this file's tenants.
import {
  INVALIDATION_CHANNEL,
  validateInvalidation,
  type InvalidationEvent,
  type MembershipInvalidation,
} from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import { insertAccount, testId } from "../../builders/platform-rows";
import { insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

const MINUTE = 60;
const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.25";

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

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;

/** A membership event of this file's tenants, with the member's row as PostgreSQL had it when the event arrived. */
interface Delivery {
  readonly event: MembershipInvalidation;
  row?: MembershipState | undefined;
}
const received: Delivery[] = [];
const watched = new Set<string>();

/** Every token this file signed, to check that none reaches a log line. */
const signed: string[] = [];

/** A member of an OTA: the account and its membership. */
interface Person {
  readonly accountId: string;
  readonly memberId: string;
  readonly fullName: string;
  readonly email: string;
  readonly createdAt: Date;
}

interface MembershipState {
  readonly role: string;
  readonly status: string;
  readonly version: number;
}

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (event.type === "membership" && watched.has(event.tenantId)) {
      const delivery: Delivery = { event };
      received.push(delivery);
      void pool
        .query(
          "SELECT role, status, version FROM platform.tenant_memberships WHERE tenant_id = $1 AND account_id = $2",
          [event.tenantId, event.accountId],
        )
        .then(({ rows }) => {
          delivery.row = rows[0] as MembershipState | undefined;
        });
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
  // The database clone and the Nest module graph (Ajv compilation of the document included) are the expensive part,
  // and CI runs every package at once on 4 CPUs.
}, 60_000);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
});

/** A new OTA (active, with its sub-domain) whose membership events the subscriber keeps. */
async function newOta(): Promise<string> {
  const { tenant } = await insertOta(pool);
  watched.add(tenant.id);
  return tenant.id;
}

/** A new account with a membership of `tenantId`: active and with MFA on unless `options` say otherwise. */
async function join(
  tenantId: string,
  role: TenantRole,
  options: { status?: "active" | "suspended" | "removed"; mfa?: boolean; createdAt?: Date } = {},
): Promise<Person> {
  const account = await insertAccount(pool, { mfa_enabled: options.mfa ?? true });
  const membership = await insertMembership(
    pool,
    { id: tenantId },
    account,
    options.createdAt === undefined
      ? { role, status: options.status ?? "active" }
      : { role, status: options.status ?? "active", created_at: options.createdAt },
  );
  return {
    accountId: account.id,
    memberId: membership.id,
    fullName: account.full_name,
    email: account.email,
    createdAt: membership.created_at,
  };
}

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** The claims of a TOTP verification `seconds` ago. */
const mfaAgo = (seconds: number): Partial<AccessTokenInput> => ({
  amr: ["pwd", "otp"],
  mfa_at: nowSeconds() - seconds,
});

/** `Authorization: Bearer` with a fresh portal token of the application's TokenService, at the FakeClock's time. */
async function bearer(
  person: Person,
  claims: Partial<AccessTokenInput> = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: person.accountId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
    ...claims,
  });
  signed.push(token);
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** The error code of an envelope answer, with the request id in the body and the header. */
function errorOf(res: Response): string {
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.code;
}

/** `200`, or the status and the error code: `403 FORBIDDEN`. */
function outcomeOf(res: Response): string {
  return res.status < 300 ? String(res.status) : `${res.status} ${errorOf(res)}`;
}

const membersUrl = (tenantId: string): string => `/v1/tenants/${tenantId}/members`;
const memberUrl = (tenantId: string, memberId: string): string => `${membersUrl(tenantId)}/${memberId}`;

/** PATCH the member's role, with `If-Match` of `version` (none for `null`). */
async function setRole(
  tenantId: string,
  caller: Person,
  memberId: string,
  role: string,
  options: { version?: number | null; claims?: Partial<AccessTokenInput> } = {},
): Promise<Response> {
  const request = t.http.patch(memberUrl(tenantId, memberId)).set(await bearer(caller, options.claims));
  const version = options.version === undefined ? 1 : options.version;
  if (version !== null) {
    request.set("If-Match", `"${version}"`);
  }
  const res = await request.send({ role });
  expectResponseToMatch("updateMember", res, { document: "platform" });
  return res;
}

async function removeMember(tenantId: string, caller: Person, memberId: string): Promise<Response> {
  const res = await t.http.delete(memberUrl(tenantId, memberId)).set(await bearer(caller));
  expectResponseToMatch("removeMember", res, { document: "platform" });
  return res;
}

async function stateOf(memberId: string): Promise<MembershipState> {
  const { rows } = await pool.query(
    "SELECT role, status, version FROM platform.tenant_memberships WHERE id = $1",
    [memberId],
  );
  return rows[0] as MembershipState;
}

/** The audit rows of `action` about the membership `memberId`. */
async function auditOf(action: string, memberId: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, target_type, target_id, tenant_id, tenant_key, request_id, ip_address, details " +
      "FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, memberId],
  );
  return rows;
}

/** How many active owners the OTA has. */
async function activeOwners(tenantId: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM platform.tenant_memberships " +
      "WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'",
    [tenantId],
  );
  return (rows[0] as { n: number }).n;
}

/** The membership events of `tenantId` received so far, in the order they arrived. */
const eventsOf = (tenantId: string): Delivery[] =>
  received.filter(({ event }) => event.tenantId === tenantId);

/** How many sessions of this file's database wait for a lock. */
async function waitingOnLocks(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return (rows[0] as { waiting: number }).waiting;
}

/**
 * Sends `requests` while a transaction of the test holds the membership rows `memberIds` (`FOR UPDATE`), and lets them
 * go once every request waits for a lock. So the requests overlap however fast each one is: the service locks these
 * rows (lockForChange) and waits there; without that lock each request would read both owners first and wait only at
 * its UPDATE, and both changes would commit. Answers in the order of `requests`.
 */
async function whileRowsHeld(
  memberIds: readonly string[],
  requests: ReadonlyArray<() => Promise<Response>>,
): Promise<Response[]> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM platform.tenant_memberships WHERE id = ANY($1) FOR UPDATE", [
      [...memberIds],
    ]);
    const answers = Promise.all(requests.map((send) => send()));
    // Awaited below; a failure before then must not count as unhandled.
    void answers.catch(() => undefined);
    await expect.poll(waitingOnLocks, { timeout: 10_000, interval: 20 }).toBe(requests.length);
    await holder.query("COMMIT");
    return await answers;
  } catch (error) {
    await holder.query("ROLLBACK");
    throw error;
  } finally {
    holder.release();
  }
}

describe("listMembers", () => {
  it("lists the active members oldest first with name, e-mail, role, MFA flag and version, to every role", async () => {
    const tenantId = await newOta();
    const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 1, 9, minute));
    const people: Record<TenantRole, Person> = {
      // Inserted out of order: the list is by the time each person joined.
      viewer: await join(tenantId, "viewer", { createdAt: at(5), mfa: false }),
      owner: await join(tenantId, "owner", { createdAt: at(1) }),
      admin: await join(tenantId, "admin", { createdAt: at(2), mfa: false }),
      agent: await join(tenantId, "agent", { createdAt: at(3) }),
      finance: await join(tenantId, "finance", { createdAt: at(4), mfa: false }),
    };
    await join(tenantId, "admin", { status: "removed", createdAt: at(6) });
    await join(tenantId, "agent", { status: "suspended", createdAt: at(7) });
    const elsewhere = await newOta();
    await join(elsewhere, "owner");
    const expected = (["owner", "admin", "agent", "finance", "viewer"] as const).map((role) => ({
      id: people[role].memberId,
      accountId: people[role].accountId,
      fullName: people[role].fullName,
      email: people[role].email,
      role,
      status: "active",
      mfaEnabled: role === "owner" || role === "agent",
      createdAt: people[role].createdAt.toISOString(),
      version: 1,
    }));

    for (const role of TENANT_ROLES) {
      const res = await t.http.get(membersUrl(tenantId)).set(await bearer(people[role]));

      expect(res.status, role).toBe(200);
      expectResponseToMatch("listMembers", res, { document: "platform" });
      expect(res.body, role).toEqual({ data: expected });
    }
  });

  it("answers 401 without a token, 403 EMAIL_NOT_VERIFIED before verification and 404 to a removed member", async () => {
    const tenantId = await newOta();
    const owner = await join(tenantId, "owner");
    const removed = await join(tenantId, "agent", { status: "removed" });

    const anonymous = await t.http.get(membersUrl(tenantId));
    const unverified = await t.http.get(membersUrl(tenantId)).set(await bearer(owner, { ev: false }));
    const gone = await t.http.get(membersUrl(tenantId)).set(await bearer(removed));

    expect(outcomeOf(anonymous)).toBe("401 UNAUTHENTICATED");
    expect(outcomeOf(unverified)).toBe("403 EMAIL_NOT_VERIFIED");
    expect(outcomeOf(gone)).toBe("404 NOT_FOUND");
    for (const res of [anonymous, unverified, gone]) {
      expectResponseToMatch("listMembers", res, { document: "platform" });
    }
  });
});

describe("updateMember", () => {
  // One test per caller role, each over every member role and new role (25 requests), so that no single test carries
  // the 125 requests of the whole matrix under CI's load.
  it.each(TENANT_ROLES)(
    "[PBE-025 AC1] follows the role matrix of scope §1.2 for the caller role %s, every member role and new role [PF-21 AC1]",
    async (callerRole) => {
      const outcomes: Record<string, string> = {};
      const expected: Record<string, string> = {};
      const tenantId = await newOta();
      // Another owner, so the last-owner rule never decides here.
      await join(tenantId, "owner");
      const caller = await join(tenantId, callerRole);
      for (const memberRole of TENANT_ROLES) {
        for (const newRole of TENANT_ROLES) {
          const member = await join(tenantId, memberRole);
          const label = `${callerRole} sets ${memberRole} to ${newRole}`;

          // With a fresh step-up, so granting owner depends on the matrix alone.
          const res = await setRole(tenantId, caller, member.memberId, newRole, { claims: mfaAgo(MINUTE) });

          outcomes[label] = outcomeOf(res);
          const allowed = MANAGES[callerRole].includes(memberRole) && MANAGES[callerRole].includes(newRole);
          expected[label] = allowed ? "200" : "403 FORBIDDEN";
          expect(await stateOf(member.memberId), label).toEqual({
            role: allowed ? newRole : memberRole,
            status: "active",
            version: allowed && newRole !== memberRole ? 2 : 1,
          });
        }
      }

      expect(Object.keys(outcomes)).toHaveLength(25);
      expect(outcomes).toEqual(expected);
    },
  );

  it("answers the member with the new role and its version as ETag; the role the member has changes nothing", async () => {
    const tenantId = await newOta();
    const owner = await join(tenantId, "owner");
    const agent = await join(tenantId, "agent", { mfa: false });

    const changed = await setRole(tenantId, owner, agent.memberId, "finance");
    const again = await setRole(tenantId, owner, agent.memberId, "finance", { version: 2 });

    expect(changed.status).toBe(200);
    expect(changed.headers["etag"]).toBe('"2"');
    expect(changed.body).toEqual({
      id: agent.memberId,
      accountId: agent.accountId,
      fullName: agent.fullName,
      email: agent.email,
      role: "finance",
      status: "active",
      mfaEnabled: false,
      createdAt: agent.createdAt.toISOString(),
      version: 2,
    });
    expect([again.status, again.headers["etag"], again.body]).toEqual([200, '"2"', changed.body]);
    expect(await auditOf("membership.role_changed", agent.memberId)).toHaveLength(1);
  });

  it("[PBE-025 AC1] needs a step-up within 15 minutes to grant owner, and none to demote an owner or set the other roles", async () => {
    const tenantId = await newOta();
    const owner = await join(tenantId, "owner");
    const ownerWithoutMfa = await join(tenantId, "owner", { mfa: false });
    const admin = await join(tenantId, "admin");
    const agent = await join(tenantId, "agent");
    const otherOwner = await join(tenantId, "owner");

    const withoutMfa = await setRole(tenantId, ownerWithoutMfa, agent.memberId, "owner", {
      claims: mfaAgo(MINUTE),
    });
    const neverSteppedUp = await setRole(tenantId, owner, agent.memberId, "owner");
    const stale = await setRole(tenantId, owner, agent.memberId, "owner", { claims: mfaAgo(20 * MINUTE) });
    const byAdmin = await setRole(tenantId, admin, agent.memberId, "owner", { claims: mfaAgo(MINUTE) });
    const unchanged = await stateOf(agent.memberId);
    const granted = await setRole(tenantId, owner, agent.memberId, "owner", { claims: mfaAgo(MINUTE) });
    const demoted = await setRole(tenantId, ownerWithoutMfa, otherOwner.memberId, "admin");
    const other = await setRole(tenantId, owner, admin.memberId, "viewer", { claims: mfaAgo(20 * MINUTE) });

    expect(outcomeOf(withoutMfa)).toBe("403 MFA_REQUIRED");
    expect(outcomeOf(neverSteppedUp)).toBe("401 REAUTH_REQUIRED");
    expect(outcomeOf(stale)).toBe("401 REAUTH_REQUIRED");
    expect(outcomeOf(byAdmin)).toBe("403 FORBIDDEN");
    expect(unchanged).toEqual({ role: "agent", status: "active", version: 1 });
    expect([granted.status, demoted.status, other.status]).toEqual([200, 200, 200]);
    expect(await stateOf(agent.memberId)).toEqual({ role: "owner", status: "active", version: 2 });
    expect(await stateOf(otherOwner.memberId)).toMatchObject({ role: "admin" });
  });

  it("answers 412 to a stale If-Match, 400 without one or for an unknown role, and 404 for a member it cannot change", async () => {
    const tenantId = await newOta();
    const owner = await join(tenantId, "owner");
    const agent = await join(tenantId, "agent");
    const removed = await join(tenantId, "agent", { status: "removed" });
    const suspended = await join(tenantId, "agent", { status: "suspended" });
    const elsewhere = await join(await newOta(), "agent");

    const stale = await setRole(tenantId, owner, agent.memberId, "viewer", { version: 2 });
    const missing = await setRole(tenantId, owner, agent.memberId, "viewer", { version: null });
    const unknownRole = await setRole(tenantId, owner, agent.memberId, "superuser");
    const malformed = await setRole(tenantId, owner, "not-a-member-id", "viewer");
    const notFound = [];
    for (const memberId of [
      testId("stf", 99_999),
      removed.memberId,
      suspended.memberId,
      elsewhere.memberId,
    ]) {
      notFound.push(await setRole(tenantId, owner, memberId, "viewer"));
    }

    expect(outcomeOf(stale)).toBe("412 PRECONDITION_FAILED");
    expect(outcomeOf(missing)).toBe("400 VALIDATION_FAILED");
    expect(missing.body).toMatchObject({ error: { fieldErrors: [{ path: "/header/If-Match" }] } });
    expect(outcomeOf(unknownRole)).toBe("400 VALIDATION_FAILED");
    expect(unknownRole.body).toMatchObject({ error: { fieldErrors: [{ path: "/role" }] } });
    expect(JSON.stringify(unknownRole.body)).not.toContain("superuser");
    expect(outcomeOf(malformed)).toBe("400 VALIDATION_FAILED");
    expect(malformed.body).toMatchObject({ error: { fieldErrors: [{ path: "/path/memberId" }] } });
    expect(notFound.map(outcomeOf)).toEqual(Array.from({ length: 4 }, () => "404 NOT_FOUND"));
    expect(await stateOf(agent.memberId)).toEqual({ role: "agent", status: "active", version: 1 });
    expect(await stateOf(elsewhere.memberId)).toEqual({ role: "agent", status: "active", version: 1 });
  });

  it("[PBE-025 AC2] answers 409 LAST_OWNER to the demotion of the last active owner; removed and suspended owners do not count [PF-21 AC2]", async () => {
    const tenantId = await newOta();
    const owner = await join(tenantId, "owner");
    await join(tenantId, "owner", { status: "removed" });
    await join(tenantId, "owner", { status: "suspended" });
    const admin = await join(tenantId, "admin");

    const alone = await setRole(tenantId, owner, owner.memberId, "admin");
    const promoted = await setRole(tenantId, owner, admin.memberId, "owner", { claims: mfaAgo(MINUTE) });
    const stepDown = await setRole(tenantId, owner, owner.memberId, "admin");
    const lastAgain = await setRole(tenantId, admin, admin.memberId, "viewer", { version: 2 });

    expect(outcomeOf(alone)).toBe("409 LAST_OWNER");
    expect([promoted.status, stepDown.status]).toEqual([200, 200]);
    expect(outcomeOf(lastAgain)).toBe("409 LAST_OWNER");
    expect(await stateOf(admin.memberId)).toEqual({ role: "owner", status: "active", version: 2 });
    expect(await activeOwners(tenantId)).toBe(1);
  });

  it("[PBE-025 AC2] serialises two owners who demote each other at the same time: the OTA keeps one owner [PF-21 AC2]", async () => {
    const tenantId = await newOta();
    const first = await join(tenantId, "owner");
    const second = await join(tenantId, "owner");

    const answers = await whileRowsHeld(
      [first.memberId, second.memberId],
      [
        () => setRole(tenantId, first, second.memberId, "admin"),
        () => setRole(tenantId, second, first.memberId, "admin"),
      ],
    );

    // The second change runs once the first has committed: its caller is no owner any more.
    expect(answers.map(outcomeOf).sort()).toEqual(["200", "403 FORBIDDEN"]);
    expect(await activeOwners(tenantId)).toBe(1);
  });

  it("writes one membership.role_changed audit row and publishes the membership invalidation after the commit", async () => {
    const tenantId = await newOta();
    const owner = await join(tenantId, "owner");
    const agent = await join(tenantId, "agent");

    const refused = await setRole(tenantId, owner, owner.memberId, "admin");
    const unchanged = await setRole(tenantId, owner, agent.memberId, "agent");
    const changed = await setRole(tenantId, owner, agent.memberId, "finance");

    expect([refused.status, unchanged.status, changed.status]).toEqual([409, 200, 200]);
    expect(await auditOf("membership.role_changed", agent.memberId)).toEqual([
      {
        actor_type: "account",
        actor_account_id: owner.accountId,
        target_type: "membership",
        target_id: agent.memberId,
        tenant_id: tenantId,
        tenant_key: expect.stringMatching(/^agency[0-9]+$/) as unknown,
        request_id: changed.headers["x-request-id"],
        ip_address: PERSON_IP,
        details: { accountId: agent.accountId, before: { role: "agent" }, after: { role: "finance" } },
      },
    ]);
    expect(await auditOf("membership.role_changed", owner.memberId)).toEqual([]);
    await vi.waitFor(() => expect(eventsOf(tenantId)[0]?.row).toBeDefined(), {
      timeout: 10_000,
      interval: 20,
    });
    // Events of one publisher arrive in order: the refused and the unchanged request published nothing before.
    expect(eventsOf(tenantId).map(({ event, row }) => ({ event, row }))).toEqual([
      {
        event: { v: 1, type: "membership", accountId: agent.accountId, tenantId },
        row: { role: "finance", status: "active", version: 2 },
      },
    ]);
  });
});

describe("removeMember", () => {
  it("[PBE-025 AC1] follows the role matrix of scope §1.2 for every caller role and member role, and lets every member leave [PF-21 AC1]", async () => {
    const outcomes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const callerRole of TENANT_ROLES) {
      const tenantId = await newOta();
      // Another owner, so the last-owner rule never decides here.
      await join(tenantId, "owner");
      const caller = await join(tenantId, callerRole);
      for (const memberRole of TENANT_ROLES) {
        const member = await join(tenantId, memberRole);
        const label = `${callerRole} removes ${memberRole}`;

        outcomes[label] = outcomeOf(await removeMember(tenantId, caller, member.memberId));

        const allowed = MANAGES[callerRole].includes(memberRole);
        expected[label] = allowed ? "204" : "403 FORBIDDEN";
        expect(await stateOf(member.memberId), label).toEqual({
          role: memberRole,
          status: allowed ? "removed" : "active",
          version: allowed ? 2 : 1,
        });
      }
      const label = `${callerRole} leaves`;
      outcomes[label] = outcomeOf(await removeMember(tenantId, caller, caller.memberId));
      expected[label] = "204";
      expect(await stateOf(caller.memberId), label).toMatchObject({ status: "removed" });
    }

    expect(Object.keys(outcomes)).toHaveLength(30);
    expect(outcomes).toEqual(expected);
  });

  it("[PBE-025 AC2] answers 409 LAST_OWNER when the last active owner leaves; removed and suspended owners do not count [PF-21 AC2]", async () => {
    const tenantId = await newOta();
    const owner = await join(tenantId, "owner");
    await join(tenantId, "owner", { status: "removed" });
    await join(tenantId, "owner", { status: "suspended" });
    const admin = await join(tenantId, "admin");

    const alone = await removeMember(tenantId, owner, owner.memberId);
    await setRole(tenantId, owner, admin.memberId, "owner", { claims: mfaAgo(MINUTE) });
    const left = await removeMember(tenantId, owner, owner.memberId);
    const lastAgain = await removeMember(tenantId, admin, admin.memberId);

    expect(outcomeOf(alone)).toBe("409 LAST_OWNER");
    expect(left.status).toBe(204);
    expect(outcomeOf(lastAgain)).toBe("409 LAST_OWNER");
    expect(await stateOf(admin.memberId)).toEqual({ role: "owner", status: "active", version: 2 });
    expect(await activeOwners(tenantId)).toBe(1);
  });

  it("[PBE-025 AC2] serialises two owners who leave at the same time: one leaves, the other gets 409 LAST_OWNER [PF-21 AC2]", async () => {
    const tenantId = await newOta();
    const first = await join(tenantId, "owner");
    const second = await join(tenantId, "owner");

    const answers = await whileRowsHeld(
      [first.memberId, second.memberId],
      [
        () => removeMember(tenantId, first, first.memberId),
        () => removeMember(tenantId, second, second.memberId),
      ],
    );

    expect(answers.map(outcomeOf).sort()).toEqual(["204", "409 LAST_OWNER"]);
    expect(await activeOwners(tenantId)).toBe(1);
  });

  it("keeps the row as removed, audits membership.removed, and ends the member's access to the OTA at once", async () => {
    const tenantId = await newOta();
    const admin = await join(tenantId, "admin");
    const agent = await join(tenantId, "agent");
    const viewer = await join(tenantId, "viewer");
    await join(tenantId, "owner");
    const agentHeaders = await bearer(agent);

    const before = await t.http.get(membersUrl(tenantId)).set(agentHeaders);
    const removed = await removeMember(tenantId, admin, agent.memberId);
    const left = await removeMember(tenantId, viewer, viewer.memberId);
    const after = await t.http.get(membersUrl(tenantId)).set(agentHeaders);
    const twice = await removeMember(tenantId, admin, agent.memberId);

    expect([before.status, removed.status, left.status]).toEqual([200, 204, 204]);
    expect(removed.body).toEqual({});
    expect(outcomeOf(after)).toBe("404 NOT_FOUND");
    expect(outcomeOf(twice)).toBe("404 NOT_FOUND");
    expect(await stateOf(agent.memberId)).toEqual({ role: "agent", status: "removed", version: 2 });
    expect(await auditOf("membership.removed", agent.memberId)).toEqual([
      {
        actor_type: "account",
        actor_account_id: admin.accountId,
        target_type: "membership",
        target_id: agent.memberId,
        tenant_id: tenantId,
        tenant_key: expect.stringMatching(/^agency[0-9]+$/) as unknown,
        request_id: removed.headers["x-request-id"],
        ip_address: PERSON_IP,
        details: {
          accountId: agent.accountId,
          left: false,
          before: { role: "agent", status: "active" },
          after: { status: "removed" },
        },
      },
    ]);
    expect(await auditOf("membership.removed", viewer.memberId)).toEqual([
      expect.objectContaining({
        actor_account_id: viewer.accountId,
        details: {
          accountId: viewer.accountId,
          left: true,
          before: { role: "viewer", status: "active" },
          after: { status: "removed" },
        },
      }),
    ]);
  });

  it("[PBE-025 AC3] publishes the membership invalidation of the removed member after the commit, for the OTA admin's cache [PF-21 AC3]", async () => {
    const tenantId = await newOta();
    const owner = await join(tenantId, "owner");
    const agent = await join(tenantId, "agent");
    const viewer = await join(tenantId, "viewer");

    const lastOwner = await removeMember(tenantId, owner, owner.memberId);
    const forbidden = await removeMember(tenantId, agent, viewer.memberId);
    const unknown = await removeMember(tenantId, owner, testId("stf", 99_998));
    const removed = await removeMember(tenantId, owner, agent.memberId);

    expect([lastOwner.status, forbidden.status, unknown.status, removed.status]).toEqual([
      409, 403, 404, 204,
    ]);
    await vi.waitFor(() => expect(eventsOf(tenantId)[0]?.row).toBeDefined(), {
      timeout: 10_000,
      interval: 20,
    });
    const [delivery, ...others] = eventsOf(tenantId);
    // Events of one publisher arrive in order: the refused removals published nothing before this one.
    expect(others).toEqual([]);
    expect(delivery?.event).toEqual({ v: 1, type: "membership", accountId: agent.accountId, tenantId });
    // The event of the contract the OTA backend validates before it drops `member:<accountId>:<tenantId>`.
    expect(validateInvalidation(delivery?.event)).toEqual(delivery?.event);
    // Sent after the commit: the row the event names is already removed.
    expect(delivery?.row).toEqual({ role: "agent", status: "removed", version: 2 });
  });
});

describe("logging", () => {
  it("never writes a token into a log line", () => {
    const logged = JSON.stringify(t.logs.lines);

    expect(signed.length).toBeGreaterThan(0);
    for (const token of signed) {
      expect(logged).not.toContain(token.split(".")[2]);
    }
  });
});
