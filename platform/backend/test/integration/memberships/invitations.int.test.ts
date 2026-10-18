// Invitations (PBE-026; platform/docs/api-inventory.md §8, flows/team-and-ota-admin-sso.md §A, scope §1.2 and PF-20)
// through the HTTP pipeline (createTestApp) on this file's database clone: creating an invitation within the role
// matrix and the plan's staff seats (also for two requests that compete for the last seat, which the advisory lock of
// the tenant's invitations serialises), the list, resend and revoke, the public lookup with its rate limit, and the
// acceptance: the verified address, the 7-day expiry, the membership inserted or made active again, the audit rows and
// the `membership` invalidation after the commit. The last group starts the worker's module graph (WorkerModule, as
// dist/worker.js builds it, with the same FakeClock) for the `invitations.expire` job and the delivery of the
// invitation e-mail to Mailpit. Every answer is checked against the platform document. TenantRoleGuard's `404` for
// non-members on the tenant routes is tested with every tenant route in test/integration/tenants/tenants.int.test.ts.
//
// The tests read an invitation's token the way only the worker may: by decrypting the outbox row's secret data with
// the application's EnvelopeService (the API never answers or logs it). So the worker, which sends the e-mails and
// erases that ciphertext, starts only in the last group. Every invited address is a `uniqueEmail`, because the worker
// then sends every queued invitation to the shared Mailpit. Redis pub/sub is not scoped to a database index: the
// subscriber keeps only the membership events of this file's tenants.
import { resolve } from "node:path";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  INVALIDATION_CHANNEL,
  type InvalidationEvent,
  type MembershipInvalidation,
} from "@velexis/api-types/jobs";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { extractLinks, uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES, type PlatformBackendConfig } from "../../../src/config";
import {
  INVITATIONS_EXPIRE_JOB,
  InvitationsExpireScheduler,
} from "../../../src/memberships/invitations-expire.scheduler";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import { secretPayloadPlace } from "../../../src/notifications/outbox.service";
import { WorkerModule } from "../../../src/worker.module";
import { insertAccount, insertPlan, insertRow, testId } from "../../builders/platform-rows";
import { insertMembership, insertOta, TEST_BASE_DOMAIN } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone (or the worker's module graph) and parsing the platform document take seconds;
 * the bound allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker (a job, an e-mail in Mailpit) or for an invalidation event. */
const WAIT_MS = 20_000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
/** PUBLIC_PORTAL_URL of the test applications (TEST_MAIL_ENV). */
const PORTAL = "http://localhost:3000";
const ACCEPT_LINK = `${PORTAL}/invitations/accept`;
const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.31";

/**
 * Scope §1.2 written out: the roles each role may invite ("Invite and manage agent, finance and viewer members":
 * owners and admins; "Grant or remove owner and admin roles": owners only).
 */
const INVITES: Readonly<Record<TenantRole, readonly TenantRole[]>> = {
  owner: ["owner", "admin", "agent", "finance", "viewer"],
  admin: ["agent", "finance", "viewer"],
  agent: [],
  finance: [],
  viewer: [],
};

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let envelope: EnvelopeService;
let subscriber: Redis;

/** A membership event of this file's tenants, with the member's row as PostgreSQL had it when the event arrived. */
interface Delivery {
  readonly event: MembershipInvalidation;
  row?: { readonly role: string; readonly status: string } | undefined;
}
const received: Delivery[] = [];
const watched = new Set<string>();

/** Every invitation token and access token this file saw, for the log scan. */
const secrets = new Set<string>();

let nextInvitation = 900_000;
let nextIp = 0;

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  envelope = t.app.get(EnvelopeService);
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (event.type === "membership" && watched.has(event.tenantId)) {
      const delivery: Delivery = { event };
      received.push(delivery);
      void pool
        .query(
          "SELECT role, status FROM platform.tenant_memberships WHERE tenant_id = $1 AND account_id = $2",
          [event.tenantId, event.accountId],
        )
        .then(({ rows }) => {
          delivery.row = rows[0] as Delivery["row"];
        });
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

// ---- Arrange -----------------------------------------------------------------------------------------------------

/** An OTA of this file: active, with its sub-domain, on a plan with `staffSeats` seats (50 unless given). */
interface Ota {
  readonly tenantId: string;
  readonly key: string;
  readonly name: string;
}

async function newOta(staffSeats = 50): Promise<Ota> {
  const plan = await insertPlan(pool, {
    limits: { staffSeats, apiKeys: 10, customDomains: 0, liveMode: false },
  });
  const { tenant } = await insertOta(pool, { tenant: { plan_code: plan.code } });
  watched.add(tenant.id);
  return { tenantId: tenant.id, key: tenant.key, name: tenant.name };
}

/** A person: an account, and its membership of an OTA when it has one. */
interface Person {
  readonly accountId: string;
  readonly memberId: string;
  readonly fullName: string;
  readonly email: string;
}

/** A new account (verified unless `verified: false`) with an address of its own. */
async function newAccount(
  options: { email?: string; verified?: boolean; label?: string } = {},
): Promise<Omit<Person, "memberId">> {
  const account = await insertAccount(pool, {
    email: options.email ?? uniqueEmail(options.label ?? "person"),
    ...(options.verified === false ? { status: "pending_verification", email_verified_at: null } : {}),
  });
  return { accountId: account.id, fullName: account.full_name, email: account.email };
}

/** A new account with a membership of `ota` (active unless `status` says otherwise). */
async function join(
  ota: Ota,
  role: TenantRole,
  options: { status?: "active" | "suspended" | "removed"; email?: string } = {},
): Promise<Person> {
  const account = await newAccount(options.email === undefined ? {} : { email: options.email });
  const membership = await insertMembership(
    pool,
    { id: ota.tenantId },
    { id: account.accountId },
    { role, status: options.status ?? "active" },
  );
  return { ...account, memberId: membership.id };
}

/** Writes an invitation row directly, with a token the test knows (only its hash is stored, as the service does). */
async function insertInvitation(
  ota: Ota,
  values: {
    email?: string;
    role?: TenantRole;
    status?: "pending" | "accepted" | "revoked" | "expired";
    invitedBy?: string | null;
    expiresAt?: Date;
    createdAt?: Date;
  } = {},
): Promise<{ readonly id: string; readonly token: string; readonly email: string }> {
  const { token, hash } = generateToken("iv");
  secrets.add(token);
  const createdAt = values.createdAt ?? t.clock.now();
  nextInvitation += 1;
  const row = await insertRow(pool, "tenant_invitations", {
    id: testId("ivt", nextInvitation),
    tenant_id: ota.tenantId,
    email: values.email ?? uniqueEmail("direct"),
    role: values.role ?? "agent",
    token_hash: hash,
    status: values.status ?? "pending",
    invited_by_account_id: values.invitedBy ?? null,
    expires_at: values.expiresAt ?? new Date(createdAt.getTime() + SEVEN_DAYS_MS),
    created_at: createdAt,
    updated_at: createdAt,
  });
  return { id: row.id, token, email: row.email };
}

/** A documentation IP (RFC 5737) of its own, so the per-IP lookup limit of one test never touches another. */
function freshIp(): string {
  nextIp += 1;
  return `198.51.100.${nextIp}`;
}

// ---- Act ---------------------------------------------------------------------------------------------------------

/** `Authorization: Bearer` with a fresh portal token of the application's TokenService, at the FakeClock's time. */
async function bearer(
  accountId: string,
  claims: Partial<AccessTokenInput> = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
    ...claims,
  });
  secrets.add(token);
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

const invitationsUrl = (ota: Ota): string => `/v1/tenants/${ota.tenantId}/invitations`;

async function invite(
  ota: Ota,
  caller: { accountId: string },
  email: string,
  role: string,
): Promise<Response> {
  const res = await t.http
    .post(invitationsUrl(ota))
    .set(await bearer(caller.accountId))
    .send({ email, role });
  expectResponseToMatch("createInvitation", res, { document: "platform" });
  return res;
}

async function list(ota: Ota, caller: { accountId: string }): Promise<Response> {
  const res = await t.http.get(invitationsUrl(ota)).set(await bearer(caller.accountId));
  expectResponseToMatch("listInvitations", res, { document: "platform" });
  return res;
}

async function resend(ota: Ota, caller: { accountId: string }, invitationId: string): Promise<Response> {
  const res = await t.http
    .post(`${invitationsUrl(ota)}/${invitationId}/resend`)
    .set(await bearer(caller.accountId));
  expectResponseToMatch("resendInvitation", res, { document: "platform" });
  return res;
}

async function revoke(ota: Ota, caller: { accountId: string }, invitationId: string): Promise<Response> {
  const res = await t.http
    .delete(`${invitationsUrl(ota)}/${invitationId}`)
    .set(await bearer(caller.accountId));
  expectResponseToMatch("revokeInvitation", res, { document: "platform" });
  return res;
}

async function lookup(token: unknown, ip = freshIp()): Promise<Response> {
  const res = await t.http.post("/v1/invitations/lookup").set(t.bffHeaders(ip)).send({ token });
  expectResponseToMatch("lookupInvitation", res, { document: "platform" });
  return res;
}

async function accept(
  accountId: string,
  token: string,
  claims: Partial<AccessTokenInput> = {},
): Promise<Response> {
  const res = await t.http
    .post("/v1/invitations/accept")
    .set(await bearer(accountId, claims))
    .send({ token });
  expectResponseToMatch("acceptInvitation", res, { document: "platform" });
  return res;
}

// ---- Assert ------------------------------------------------------------------------------------------------------

/** The error code of an envelope answer, with the request id in the body and the header. */
function errorOf(res: Response): string {
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.code;
}

/** `201`, or the status and the error code: `403 FORBIDDEN`. */
function outcomeOf(res: Response): string {
  return res.status < 300 ? String(res.status) : `${res.status} ${errorOf(res)}`;
}

interface InvitationState {
  readonly status: string;
  readonly token_hash: string;
  readonly expires_at: Date;
  readonly accepted_account_id: string | null;
  readonly accepted_at: Date | null;
  readonly revoked_at: Date | null;
}

async function invitationState(invitationId: string): Promise<InvitationState> {
  const { rows } = await pool.query(
    "SELECT status, token_hash, expires_at, accepted_account_id, accepted_at, revoked_at " +
      "FROM platform.tenant_invitations WHERE id = $1",
    [invitationId],
  );
  return rows[0] as InvitationState;
}

/** The tokens of every `team.invitation` e-mail queued to `email`, from the outbox's encrypted secret data. */
async function tokensSentTo(email: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string; secret_payload_ciphertext: Buffer | null }>(
    "SELECT id, secret_payload_ciphertext FROM platform.email_outbox WHERE template = 'team.invitation' AND to_email = $1",
    [email],
  );
  const found: string[] = [];
  for (const row of rows) {
    expect(row.secret_payload_ciphertext, "the secret data is still encrypted in the outbox").not.toBeNull();
    const secret = (await envelope.decryptJson(
      row.secret_payload_ciphertext as Buffer,
      secretPayloadPlace(row.id),
    )) as { acceptUrl: string };
    const url = new URL(secret.acceptUrl);
    expect(`${url.origin}${url.pathname}`).toBe(ACCEPT_LINK);
    expect([...url.searchParams.keys()]).toEqual(["token"]);
    const token = url.searchParams.get("token") ?? "";
    secrets.add(token);
    found.push(token);
  }
  return found;
}

/** The token of the one invitation e-mail queued to `email`. */
async function tokenSentTo(email: string): Promise<string> {
  const found = await tokensSentTo(email);
  expect(found).toHaveLength(1);
  return found[0] ?? "";
}

/** The audit rows of `action` about `targetId`. */
async function auditOf(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, actor_label, target_type, target_id, tenant_id, request_id, ip_address, " +
      "details FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

/** How many sessions of this file's database wait for a lock (row and advisory locks alike). */
async function waitingOnLocks(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return (rows[0] as { waiting: number }).waiting;
}

/**
 * Sends `requests` while a transaction of the test holds the lock `lockSql` takes, and lets them go once every request
 * waits for a lock, so the requests overlap however fast each one is. Answers in the order of `requests`.
 */
async function whileLockHeld(
  lockSql: string,
  parameters: readonly unknown[],
  requests: ReadonlyArray<() => Promise<Response>>,
): Promise<Response[]> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(lockSql, [...parameters]);
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

/** Runs `fn` with the FakeClock moved forward by `ms`, and puts it back afterwards. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const start = t.clock.now();
  t.clock.advance(ms);
  try {
    return await fn();
  } finally {
    t.clock.set(start);
  }
}

// ---- Tests -------------------------------------------------------------------------------------------------------

describe("createInvitation", () => {
  it.each(TENANT_ROLES)(
    "[PBE-026 AC1] follows the role matrix for the caller role %s: owners invite every role, admins invite agents, finance members and viewers, others nobody [PF-20 AC1]",
    async (callerRole) => {
      const ota = await newOta();
      const caller = await join(ota, callerRole);
      const outcomes: Record<string, string> = {};
      const expected: Record<string, string> = {};
      for (const role of TENANT_ROLES) {
        const email = uniqueEmail(`matrix-${role}`);

        const res = await invite(ota, caller, email, role);

        outcomes[role] = outcomeOf(res);
        expected[role] = INVITES[callerRole].includes(role) ? "201" : "403 FORBIDDEN";
      }

      expect(outcomes).toEqual(expected);
      const { rows } = await pool.query(
        "SELECT role FROM platform.tenant_invitations WHERE tenant_id = $1 ORDER BY role",
        [ota.tenantId],
      );
      expect(rows.map((row: { role: string }) => row.role)).toEqual([...INVITES[callerRole]].sort());
    },
  );

  it("[PBE-026 AC1] stores only the SHA-256 of the token for 7 days, queues team.invitation with the link as encrypted secret data, and audits invitation.created", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const email = uniqueEmail("invite-new");

    const res = await invite(ota, owner, email, "finance");

    expect(res.status).toBe(201);
    const body = res.body as { id: string };
    expect(body).toEqual({
      id: expect.stringMatching(/^ivt_[0-9A-HJKMNP-TV-Z]{26}$/) as unknown,
      email,
      role: "finance",
      status: "pending",
      invitedBy: { accountId: owner.accountId, fullName: owner.fullName },
      expiresAt: new Date(t.clock.now().getTime() + SEVEN_DAYS_MS).toISOString(),
      createdAt: t.clock.now().toISOString(),
    });
    const state = await invitationState(body.id);
    expect(state).toMatchObject({
      status: "pending",
      expires_at: new Date(t.clock.now().getTime() + SEVEN_DAYS_MS),
    });
    const token = await tokenSentTo(email);
    expect(token).toMatch(/^iv_[A-Za-z0-9_-]{43}$/);
    expect(state.token_hash).toBe(sha256Hex(token));
    expect(res.text).not.toContain(token);
    const { rows } = await pool.query(
      "SELECT tenant_id, account_id, data::text AS data FROM platform.email_outbox WHERE to_email = $1",
      [email],
    );
    expect(rows).toEqual([
      { tenant_id: ota.tenantId, account_id: null, data: expect.any(String) as unknown },
    ]);
    const data = (rows[0] as { data: string }).data;
    expect(JSON.parse(data)).toEqual({ tenantName: ota.name, inviterName: owner.fullName, role: "finance" });
    expect(data).not.toContain(token);
    expect(await auditOf("invitation.created", body.id)).toEqual([
      {
        actor_type: "account",
        actor_account_id: owner.accountId,
        actor_label: owner.email,
        target_type: "invitation",
        target_id: body.id,
        tenant_id: ota.tenantId,
        request_id: res.headers["x-request-id"],
        ip_address: PERSON_IP,
        details: { email, role: "finance" },
      },
    ]);
  });

  it("answers 409 ALREADY_MEMBER for a member's address in any letter case and 409 INVITATION_PENDING for a pending one; a removed member can be invited", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const member = await join(ota, "agent");
    const suspended = await join(ota, "viewer", { status: "suspended" });
    const removed = await join(ota, "viewer", { status: "removed" });
    const elsewhere = await join(await newOta(), "agent");
    const pendingEmail = uniqueEmail("pending");

    const asMember = await invite(ota, owner, member.email.toUpperCase(), "viewer");
    const asSuspended = await invite(ota, owner, suspended.email, "viewer");
    const first = await invite(ota, owner, pendingEmail, "agent");
    const again = await invite(ota, owner, pendingEmail.toUpperCase(), "viewer");
    const asRemoved = await invite(ota, owner, removed.email, "agent");
    const asOtherOtasMember = await invite(ota, owner, elsewhere.email, "agent");

    expect(outcomeOf(asMember)).toBe("409 ALREADY_MEMBER");
    expect(outcomeOf(asSuspended)).toBe("409 ALREADY_MEMBER");
    expect(outcomeOf(first)).toBe("201");
    expect(outcomeOf(again)).toBe("409 INVITATION_PENDING");
    expect(outcomeOf(asRemoved)).toBe("201");
    expect(outcomeOf(asOtherOtasMember)).toBe("201");
  });

  it("[PBE-026 AC2] with staffSeats = 3, two members and one pending invitation, a new invitation answers 422 PLAN_LIMIT_REACHED; a revocation frees the seat [PF-20 AC2]", async () => {
    const ota = await newOta(3);
    const owner = await join(ota, "owner");
    await join(ota, "agent");
    // Neither a removed member nor a revoked, accepted or expired invitation holds a seat.
    await join(ota, "viewer", { status: "removed" });
    for (const status of ["revoked", "accepted", "expired"] as const) {
      await insertInvitation(ota, { status });
    }

    const third = await invite(ota, owner, uniqueEmail("seat-third"), "agent");
    const fourth = await invite(ota, owner, uniqueEmail("seat-fourth"), "agent");
    const revoked = await revoke(ota, owner, (third.body as { id: string }).id);
    const afterRevoke = await invite(ota, owner, uniqueEmail("seat-again"), "agent");

    expect(outcomeOf(third)).toBe("201");
    expect(outcomeOf(fourth)).toBe("422 PLAN_LIMIT_REACHED");
    expect(fourth.body).toMatchObject({ error: { details: { limit: 3, used: 3 } } });
    expect(revoked.status).toBe(204);
    expect(outcomeOf(afterRevoke)).toBe("201");
  });

  it("[PBE-026 AC2] serialises two invitations that compete for the last seat: one is created, the other answers PLAN_LIMIT_REACHED [PF-20 AC2]", async () => {
    // Two members of three seats: one seat is free.
    const ota = await newOta(3);
    const owner = await join(ota, "owner");
    const admin = await join(ota, "admin");

    // Both requests wait for the lock of the OTA's invitations, which the test holds, and run one after the other.
    const raced = await whileLockHeld(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`platform.tenant_invitations:${ota.tenantId}`],
      [
        () => invite(ota, owner, uniqueEmail("race-one"), "agent"),
        () => invite(ota, admin, uniqueEmail("race-two"), "viewer"),
      ],
    );

    expect(raced.map(outcomeOf).sort()).toEqual(["201", "422 PLAN_LIMIT_REACHED"]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM platform.tenant_invitations WHERE tenant_id = $1 AND status = 'pending'",
      [ota.tenantId],
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("answers 400 VALIDATION_FAILED for an invalid address or role without echoing them, and 401 without a token", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");

    const badEmail = await invite(ota, owner, "not-an-address", "agent");
    const badRole = await invite(ota, owner, uniqueEmail("bad-role"), "superuser");
    const anonymous = await t.http
      .post(invitationsUrl(ota))
      .send({ email: uniqueEmail("anon"), role: "agent" });

    expect(outcomeOf(badEmail)).toBe("400 VALIDATION_FAILED");
    expect(badEmail.body).toMatchObject({ error: { fieldErrors: [{ path: "/email" }] } });
    expect(badEmail.text).not.toContain("not-an-address");
    expect(outcomeOf(badRole)).toBe("400 VALIDATION_FAILED");
    expect(badRole.body).toMatchObject({ error: { fieldErrors: [{ path: "/role" }] } });
    expect(badRole.text).not.toContain("superuser");
    expect(outcomeOf(anonymous)).toBe("401 UNAUTHENTICATED");
    expectResponseToMatch("createInvitation", anonymous, { document: "platform" });
  });
});

describe("listInvitations", () => {
  it("lists the pending invitations newest first with their inviters; other states are left out; only owners and admins see it", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const admin = await join(ota, "admin");
    const agent = await join(ota, "agent");
    const at = (minute: number): Date => new Date(t.clock.now().getTime() - (60 - minute) * MINUTE_MS);
    const older = await insertInvitation(ota, {
      invitedBy: owner.accountId,
      createdAt: at(1),
      role: "viewer",
    });
    // An inviter whose account is gone (`ON DELETE SET NULL`).
    const orphan = await insertInvitation(ota, { invitedBy: null, createdAt: at(2), role: "finance" });
    const newer = await insertInvitation(ota, {
      invitedBy: admin.accountId,
      createdAt: at(3),
      role: "agent",
    });
    for (const status of ["accepted", "revoked", "expired"] as const) {
      await insertInvitation(ota, { status, invitedBy: owner.accountId, createdAt: at(4) });
    }
    await insertInvitation(await newOta(), { invitedBy: owner.accountId });
    const shown = (row: { id: string; email: string }, role: string, invitedBy: unknown, minute: number) => ({
      id: row.id,
      email: row.email,
      role,
      status: "pending",
      invitedBy,
      expiresAt: new Date(at(minute).getTime() + SEVEN_DAYS_MS).toISOString(),
      createdAt: at(minute).toISOString(),
    });
    const expected = {
      data: [
        shown(newer, "agent", { accountId: admin.accountId, fullName: admin.fullName }, 3),
        shown(orphan, "finance", null, 2),
        shown(older, "viewer", { accountId: owner.accountId, fullName: owner.fullName }, 1),
      ],
    };

    const byOwner = await list(ota, owner);
    const byAdmin = await list(ota, admin);
    const byAgent = await list(ota, agent);

    expect([byOwner.status, byOwner.body]).toEqual([200, expected]);
    expect([byAdmin.status, byAdmin.body]).toEqual([200, expected]);
    expect(outcomeOf(byAgent)).toBe("403 FORBIDDEN");
    expect(byOwner.text).not.toContain("token");
  });
});

describe("resendInvitation and revokeInvitation", () => {
  it("[PBE-026 AC4] after a resend the old link fails and the new one works, for 7 more days from the resend [PF-20 AC4]", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const invitee = await newAccount({ label: "resend" });
    const created = await invite(ota, owner, invitee.email, "agent");
    const invitationId = (created.body as { id: string }).id;
    const oldToken = await tokenSentTo(invitee.email);

    await later(3 * DAY_MS, async () => {
      const resent = await resend(ota, owner, invitationId);

      expect(resent.status).toBe(202);
      expect(resent.text).toBe("");
      const newTokens = (await tokensSentTo(invitee.email)).filter((token) => token !== oldToken);
      expect(newTokens).toHaveLength(1);
      const newToken = newTokens[0] ?? "";
      expect(await invitationState(invitationId)).toMatchObject({
        status: "pending",
        token_hash: sha256Hex(newToken),
        expires_at: new Date(t.clock.now().getTime() + SEVEN_DAYS_MS),
      });
      expect(outcomeOf(await lookup(oldToken))).toBe("400 INVITATION_INVALID");
      expect(outcomeOf(await accept(invitee.accountId, oldToken))).toBe("400 INVITATION_INVALID");
      expect(outcomeOf(await lookup(newToken))).toBe("200");
      // Past the first link's 7 days, the new one still works.
      t.clock.advance(5 * DAY_MS);
      expect(outcomeOf(await accept(invitee.accountId, newToken))).toBe("200");
      expect(await auditOf("invitation.resent", invitationId)).toEqual([
        expect.objectContaining({
          actor_type: "account",
          actor_account_id: owner.accountId,
          target_type: "invitation",
          tenant_id: ota.tenantId,
          request_id: resent.headers["x-request-id"],
          details: {
            email: invitee.email,
            role: "agent",
            before: { expiresAt: new Date(t.clock.now().getTime() - DAY_MS).toISOString() },
            after: { expiresAt: new Date(t.clock.now().getTime() + 2 * DAY_MS).toISOString() },
          },
        }),
      ]);
    });
  });

  it("[PBE-026 AC4] a revoked invitation cannot be looked up or accepted, frees its address, and is audited [PF-20 AC4]", async () => {
    const ota = await newOta();
    const admin = await join(ota, "admin");
    const invitee = await newAccount({ label: "revoke" });
    const created = await invite(ota, admin, invitee.email, "viewer");
    const invitationId = (created.body as { id: string }).id;
    const token = await tokenSentTo(invitee.email);

    const revoked = await revoke(ota, admin, invitationId);

    expect([revoked.status, revoked.text]).toEqual([204, ""]);
    expect(await invitationState(invitationId)).toMatchObject({
      status: "revoked",
      revoked_at: t.clock.now(),
    });
    expect(outcomeOf(await lookup(token))).toBe("400 INVITATION_INVALID");
    expect(outcomeOf(await accept(invitee.accountId, token))).toBe("400 INVITATION_INVALID");
    expect(await auditOf("invitation.revoked", invitationId)).toEqual([
      expect.objectContaining({
        actor_type: "account",
        actor_account_id: admin.accountId,
        tenant_id: ota.tenantId,
        request_id: revoked.headers["x-request-id"],
        details: {
          email: invitee.email,
          role: "viewer",
          before: { status: "pending" },
          after: { status: "revoked" },
        },
      }),
    ]);
    expect(outcomeOf(await invite(ota, admin, invitee.email, "viewer"))).toBe("201");
  });

  it("answers 409 CONFLICT (not_pending) for an invitation that is not pending, 403 to an admin for an owner's or admin's invitation, and 404 for another OTA's or an unknown one", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const admin = await join(ota, "admin");
    const agent = await join(ota, "agent");
    const forAdmin = await insertInvitation(ota, { role: "admin", invitedBy: owner.accountId });
    const forOwner = await insertInvitation(ota, { role: "owner", invitedBy: owner.accountId });
    const other = await insertInvitation(await newOta());
    const notPending = [];
    for (const status of ["accepted", "revoked", "expired"] as const) {
      notPending.push(await insertInvitation(ota, { status }));
    }

    type Case = readonly [label: string, send: () => Promise<Response>];
    const cases: Case[] = [
      ["admin resends admin", () => resend(ota, admin, forAdmin.id)],
      ["admin revokes owner", () => revoke(ota, admin, forOwner.id)],
      ["agent revokes", () => revoke(ota, agent, forAdmin.id)],
      ["resend other OTA", () => resend(ota, owner, other.id)],
      ["revoke unknown", () => revoke(ota, owner, testId("ivt", 1))],
      ...notPending.flatMap((invitation, index): Case[] => [
        [`resend not pending ${index}`, () => resend(ota, owner, invitation.id)],
        [`revoke not pending ${index}`, () => revoke(ota, owner, invitation.id)],
      ]),
      ["owner resends admin", () => resend(ota, owner, forAdmin.id)],
      ["owner revokes owner", () => revoke(ota, owner, forOwner.id)],
    ];
    const outcomes: Record<string, string> = {};
    for (const [label, send] of cases) {
      const res = await send();
      outcomes[label] = outcomeOf(res);
      if (res.status === 409) {
        expect(res.body).toMatchObject({ error: { details: { reason: "not_pending" } } });
      }
    }

    expect(outcomes).toEqual({
      "admin resends admin": "403 FORBIDDEN",
      "admin revokes owner": "403 FORBIDDEN",
      "agent revokes": "403 FORBIDDEN",
      "resend other OTA": "404 NOT_FOUND",
      "revoke unknown": "404 NOT_FOUND",
      "resend not pending 0": "409 CONFLICT",
      "revoke not pending 0": "409 CONFLICT",
      "resend not pending 1": "409 CONFLICT",
      "revoke not pending 1": "409 CONFLICT",
      "resend not pending 2": "409 CONFLICT",
      "revoke not pending 2": "409 CONFLICT",
      "owner resends admin": "202",
      "owner revokes owner": "204",
    });
    expect((await invitationState(other.id)).status).toBe("pending");
  });
});

describe("lookupInvitation", () => {
  it("shows the OTA, the role, the address, the inviter and the expiry of a usable link; inviterName is null once the inviter is gone", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const withInviter = await insertInvitation(ota, { role: "finance", invitedBy: owner.accountId });
    const orphan = await insertInvitation(ota, { role: "viewer", invitedBy: null });

    const shown = await lookup(withInviter.token);
    const orphaned = await lookup(orphan.token);

    expect([shown.status, shown.body]).toEqual([
      200,
      {
        tenantName: ota.name,
        role: "finance",
        email: withInviter.email,
        inviterName: owner.fullName,
        expiresAt: new Date(t.clock.now().getTime() + SEVEN_DAYS_MS).toISOString(),
      },
    ]);
    expect(orphaned.body).toMatchObject({ inviterName: null, role: "viewer" });
    // Reads only.
    expect(await invitationState(withInviter.id)).toMatchObject({ status: "pending" });
  });

  it("answers 400 INVITATION_INVALID alike to an unknown, accepted, revoked, expired or out-of-date token and to an OTA being deleted, and 400 VALIDATION_FAILED without a token", async () => {
    const ota = await newOta();
    const now = t.clock.now();
    const invalid = [
      generateToken("iv").token,
      (await insertInvitation(ota, { status: "accepted" })).token,
      (await insertInvitation(ota, { status: "revoked" })).token,
      (await insertInvitation(ota, { status: "expired" })).token,
      (await insertInvitation(ota, { expiresAt: now })).token,
      (await insertInvitation(ota, { expiresAt: new Date(now.getTime() - DAY_MS) })).token,
    ];
    const deleting = await newOta();
    invalid.push((await insertInvitation(deleting)).token);
    await pool.query("UPDATE platform.tenants SET status = 'deprovisioning' WHERE id = $1", [
      deleting.tenantId,
    ]);

    const answers = [];
    for (const token of invalid) {
      answers.push(await lookup(token));
    }
    const missing = await lookup(undefined);
    const empty = await lookup("");

    expect(answers.map(outcomeOf)).toEqual(invalid.map(() => "400 INVITATION_INVALID"));
    const messages = new Set(
      answers.map((res) => (res.body as { error: { message: string } }).error.message),
    );
    expect(messages.size).toBe(1);
    expect(outcomeOf(missing)).toBe("400 VALIDATION_FAILED");
    expect(outcomeOf(empty)).toBe("400 VALIDATION_FAILED");
  });

  it("allows 20 lookups per end-user IP per hour, then answers 429 RATE_LIMITED with Retry-After", async () => {
    const ota = await newOta();
    const { token } = await insertInvitation(ota);
    const ip = freshIp();

    const answers = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      answers.push(await lookup(token, ip));
    }
    const otherIp = await lookup(token);

    expect(answers.slice(0, 20).map((res) => res.status)).toEqual(Array.from({ length: 20 }, () => 200));
    const limited = answers[20] as Response;
    expect(outcomeOf(limited)).toBe("429 RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(otherIp.status).toBe(200);
  });
});

describe("acceptInvitation", () => {
  it("[PBE-026 AC3] joins the OTA with the invited role in one transaction, for the invited address in any letter case, and publishes the membership invalidation after the commit [PF-20 AC3]", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const email = uniqueEmail("accept-new");
    const invitee = await newAccount({ email });
    const created = await invite(ota, owner, email.toUpperCase(), "finance");
    const invitationId = (created.body as { id: string }).id;
    const token = await tokenSentTo(email.toUpperCase());

    const res = await accept(invitee.accountId, token);

    expect(res.status).toBe(200);
    const body = res.body as { membership: { id: string } };
    expect(body).toEqual({
      membership: {
        id: expect.stringMatching(/^stf_[0-9A-HJKMNP-TV-Z]{26}$/) as unknown,
        accountId: invitee.accountId,
        fullName: invitee.fullName,
        email,
        role: "finance",
        status: "active",
        mfaEnabled: false,
        createdAt: t.clock.now().toISOString(),
        version: 1,
      },
      tenant: {
        id: ota.tenantId,
        key: ota.key,
        name: ota.name,
        status: "active",
        role: "finance",
        planCode: expect.stringMatching(/^plan_/) as unknown,
        storefrontUrl: `https://${ota.key}.${TEST_BASE_DOMAIN}/`,
        storefrontEnvironment: "test",
      },
    });
    const { rows } = await pool.query(
      "SELECT role, status, invited_by_account_id FROM platform.tenant_memberships WHERE id = $1",
      [body.membership.id],
    );
    expect(rows).toEqual([{ role: "finance", status: "active", invited_by_account_id: owner.accountId }]);
    expect(await invitationState(invitationId)).toMatchObject({
      status: "accepted",
      accepted_account_id: invitee.accountId,
      accepted_at: t.clock.now(),
    });
    expect(await auditOf("membership.created", body.membership.id)).toEqual([
      {
        actor_type: "account",
        actor_account_id: invitee.accountId,
        actor_label: email,
        target_type: "membership",
        target_id: body.membership.id,
        tenant_id: ota.tenantId,
        request_id: res.headers["x-request-id"],
        ip_address: PERSON_IP,
        details: {
          accountId: invitee.accountId,
          invitationId,
          invitedByAccountId: owner.accountId,
          reactivated: false,
          after: { role: "finance", status: "active" },
        },
      },
    ]);
    // The event follows the commit: the subscriber reads the new membership when it arrives.
    await vi.waitFor(
      () => expect(received.find(({ event }) => event.accountId === invitee.accountId)?.row).toBeDefined(),
      { timeout: WAIT_MS, interval: 20 },
    );
    const delivery = received.find(({ event }) => event.accountId === invitee.accountId);
    expect(delivery?.event).toEqual({
      v: 1,
      type: "membership",
      accountId: invitee.accountId,
      tenantId: ota.tenantId,
    });
    expect(delivery?.row).toEqual({ role: "finance", status: "active" });
    // The new member sees the OTA's team.
    const members = await t.http
      .get(`/v1/tenants/${ota.tenantId}/members`)
      .set(await bearer(invitee.accountId));
    expect(members.status).toBe(200);
  });

  it("[PBE-026 AC3] accepting with another verified e-mail answers 403 INVITATION_EMAIL_MISMATCH; an 8-day-old link answers 400 INVITATION_INVALID [PF-20 AC3]", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const invitee = await newAccount({ label: "invitee" });
    const someoneElse = await newAccount({ label: "someone-else" });
    const created = await invite(ota, owner, invitee.email, "agent");
    const invitationId = (created.body as { id: string }).id;
    const token = await tokenSentTo(invitee.email);

    const mismatch = await accept(someoneElse.accountId, token);
    const { tooLate, lookedUp } = await later(8 * DAY_MS, async () => ({
      tooLate: await accept(invitee.accountId, token),
      lookedUp: await lookup(token),
    }));
    // A day before the 7 days end, the same link still works.
    const inTime = await later(6 * DAY_MS, () => accept(invitee.accountId, token));

    expect(outcomeOf(mismatch)).toBe("403 INVITATION_EMAIL_MISMATCH");
    expect(outcomeOf(tooLate)).toBe("400 INVITATION_INVALID");
    expect(outcomeOf(lookedUp)).toBe("400 INVITATION_INVALID");
    expect(outcomeOf(inTime)).toBe("200");
    expect((await invitationState(invitationId)).accepted_account_id).toBe(invitee.accountId);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM platform.tenant_memberships WHERE tenant_id = $1 AND account_id = $2",
      [ota.tenantId, someoneElse.accountId],
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it("makes a removed membership active again with the invited role and keeps its staff id", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const former = await join(ota, "viewer", { status: "removed" });
    const created = await invite(ota, owner, former.email, "admin");
    const token = await tokenSentTo(former.email);

    const res = await accept(former.accountId, token);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      membership: { id: former.memberId, role: "admin", status: "active", version: 2 },
      tenant: { id: ota.tenantId, role: "admin" },
    });
    expect(await auditOf("membership.created", former.memberId)).toEqual([
      expect.objectContaining({
        details: {
          accountId: former.accountId,
          invitationId: (created.body as { id: string }).id,
          invitedByAccountId: owner.accountId,
          reactivated: true,
          before: { status: "removed" },
          after: { role: "admin", status: "active" },
        },
      }),
    ]);
  });

  it("answers 409 ALREADY_MEMBER to a member, 403 EMAIL_NOT_VERIFIED without a verified address, 401 without a token, and 400 INVITATION_INVALID to a link used once", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const member = await join(ota, "agent");
    const suspended = await join(ota, "agent", { status: "suspended" });
    const forMember = await insertInvitation(ota, { email: member.email, invitedBy: owner.accountId });
    const forSuspended = await insertInvitation(ota, { email: suspended.email, invitedBy: owner.accountId });
    const unverified = await newAccount({ label: "unverified", verified: false });
    const forUnverified = await insertInvitation(ota, {
      email: unverified.email,
      invitedBy: owner.accountId,
    });
    const invitee = await newAccount({ label: "once" });
    const forInvitee = await insertInvitation(ota, { email: invitee.email, invitedBy: owner.accountId });

    const asMember = await accept(member.accountId, forMember.token);
    const asSuspended = await accept(suspended.accountId, forSuspended.token);
    // A token from before the verification, and a token that claims a verification the account does not have.
    const unverifiedToken = await accept(unverified.accountId, forUnverified.token, { ev: false });
    const unverifiedAccount = await accept(unverified.accountId, forUnverified.token);
    const anonymous = await t.http.post("/v1/invitations/accept").send({ token: forInvitee.token });
    const first = await accept(invitee.accountId, forInvitee.token);
    const second = await accept(invitee.accountId, forInvitee.token);

    expect(outcomeOf(asMember)).toBe("409 ALREADY_MEMBER");
    expect(outcomeOf(asSuspended)).toBe("409 ALREADY_MEMBER");
    expect(outcomeOf(unverifiedToken)).toBe("403 EMAIL_NOT_VERIFIED");
    expect(outcomeOf(unverifiedAccount)).toBe("403 EMAIL_NOT_VERIFIED");
    expect(outcomeOf(anonymous)).toBe("401 UNAUTHENTICATED");
    expectResponseToMatch("acceptInvitation", anonymous, { document: "platform" });
    expect(outcomeOf(first)).toBe("200");
    expect(outcomeOf(second)).toBe("400 INVITATION_INVALID");
    for (const invitation of [forMember, forSuspended, forUnverified]) {
      expect((await invitationState(invitation.id)).status).toBe("pending");
    }
    const { rows } = await pool.query("SELECT status FROM platform.tenant_memberships WHERE id = $1", [
      suspended.memberId,
    ]);
    expect(rows).toEqual([{ status: "suspended" }]);
  });

  it("answers 401 UNAUTHENTICATED to an account disabled or deleted while its access token is still valid, and joins nobody", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const disabled = await newAccount({ label: "disabled" });
    const deleted = await newAccount({ label: "deleted" });
    const forDisabled = await insertInvitation(ota, { email: disabled.email, invitedBy: owner.accountId });
    const forDeleted = await insertInvitation(ota, { email: deleted.email, invitedBy: owner.accountId });
    // The access token does not carry the account's state: only acceptance's own read of the account sees the change.
    await pool.query("UPDATE platform.accounts SET status = 'disabled' WHERE id = $1", [disabled.accountId]);
    await pool.query("UPDATE platform.accounts SET status = 'deleted', deleted_at = $2 WHERE id = $1", [
      deleted.accountId,
      t.clock.now(),
    ]);

    const asDisabled = await accept(disabled.accountId, forDisabled.token);
    const asDeleted = await accept(deleted.accountId, forDeleted.token);

    expect(outcomeOf(asDisabled)).toBe("401 UNAUTHENTICATED");
    expect(outcomeOf(asDeleted)).toBe("401 UNAUTHENTICATED");
    for (const invitation of [forDisabled, forDeleted]) {
      expect((await invitationState(invitation.id)).status).toBe("pending");
    }
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM platform.tenant_memberships WHERE tenant_id = $1 AND account_id = ANY($2)",
      [ota.tenantId, [disabled.accountId, deleted.accountId]],
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it("gives one membership for one link accepted twice at the same time", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const invitee = await newAccount({ label: "twice" });
    const invitation = await insertInvitation(ota, { email: invitee.email, invitedBy: owner.accountId });

    const answers = await whileLockHeld(
      "SELECT id FROM platform.tenant_invitations WHERE id = $1 FOR UPDATE",
      [invitation.id],
      [() => accept(invitee.accountId, invitation.token), () => accept(invitee.accountId, invitation.token)],
    );

    expect(answers.map(outcomeOf).sort()).toEqual(["200", "400 INVITATION_INVALID"]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM platform.tenant_memberships WHERE tenant_id = $1 AND account_id = $2",
      [ota.tenantId, invitee.accountId],
    );
    expect((rows[0] as { n: number }).n).toBe(1);
    expect(
      await auditOf(
        "membership.created",
        (answers.find((res) => res.status === 200)?.body as { membership: { id: string } }).membership.id,
      ),
    ).toHaveLength(1);
  });
});

describe("invitations.expire and the invitation e-mail (worker)", () => {
  let worker: TestingModule;
  let maintenance: Queue;
  const workerLogs = new LogSink();

  /** The development SMTP_URL (Mailpit) of the environment. */
  function mailpitSmtpUrl(): string {
    loadDevEnvFiles({ appDir: resolve(__dirname, "..", "..", "..") });
    return defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:"] }) }).SMTP_URL;
  }

  beforeAll(async () => {
    // The worker of dist/worker.js on the same database, Redis, key folder and clock, sending to Mailpit. Its job
    // schedulers are not registered (JobSchedulerRegistry is replaced), so no run starts on its own during a test.
    const config: PlatformBackendConfig = { ...t.config, SMTP_URL: mailpitSmtpUrl() };
    const logger = createProcessLogger(PLATFORM_PROCESSES.worker, config, workerLogs);
    worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config, logger)] })
      .overrideProvider(Clock)
      .useValue(t.clock)
      .overrideProvider(JobSchedulerRegistry)
      .useValue({})
      .compile();
    await worker.init();
    maintenance = worker.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await worker?.close();
  }, SETUP_TIMEOUT_MS);

  it("sets pending invitations past their expiry expired through the platform-maintenance job, audits invitation.expired as the system, and leaves the others", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const now = t.clock.now();
    const due = await insertInvitation(ota, {
      expiresAt: new Date(now.getTime() - MINUTE_MS),
      role: "viewer",
    });
    const dueNow = await insertInvitation(ota, { expiresAt: now });
    const fresh = await insertInvitation(ota, { expiresAt: new Date(now.getTime() + HOUR_MS) });
    const acceptedLate = await insertInvitation(ota, {
      status: "accepted",
      expiresAt: new Date(now.getTime() - DAY_MS),
    });
    const revokedLate = await insertInvitation(ota, {
      status: "revoked",
      expiresAt: new Date(now.getTime() - DAY_MS),
    });

    // The run the job scheduler starts every hour: a job named after the schedule on `platform-maintenance`.
    const job = await maintenance.add(INVITATIONS_EXPIRE_JOB, {});
    const deadline = Date.now() + WAIT_MS;
    while ((await job.getState()) !== "completed") {
      expect(Date.now(), "the expire job to complete").toBeLessThan(deadline);
      await new Promise((done) => setTimeout(done, 50));
    }

    const finished = await maintenance.getJob(job.id ?? "");
    expect((finished?.returnvalue as { expired: number }).expired).toBeGreaterThanOrEqual(2);
    expect((await invitationState(due.id)).status).toBe("expired");
    expect((await invitationState(dueNow.id)).status).toBe("expired");
    expect((await invitationState(fresh.id)).status).toBe("pending");
    expect((await invitationState(acceptedLate.id)).status).toBe("accepted");
    expect((await invitationState(revokedLate.id)).status).toBe("revoked");
    expect(await auditOf("invitation.expired", due.id)).toEqual([
      {
        actor_type: "system",
        actor_account_id: null,
        actor_label: INVITATIONS_EXPIRE_JOB,
        target_type: "invitation",
        target_id: due.id,
        tenant_id: ota.tenantId,
        request_id: null,
        ip_address: null,
        details: {
          email: due.email,
          role: "viewer",
          before: { status: "pending" },
          after: { status: "expired" },
        },
      },
    ]);
    // Expired invitations leave the list and free their addresses; a second run finds nothing more of this OTA.
    const listed = await list(ota, owner);
    expect((listed.body as { data: Array<{ id: string }> }).data.map(({ id }) => id)).toEqual([fresh.id]);
    expect(outcomeOf(await invite(ota, owner, due.email, "viewer"))).toBe("201");
    const again = await worker.get(InvitationsExpireScheduler, { strict: false }).run();
    expect(again).toEqual({ expired: 0 });
  });

  it("delivers team.invitation to the invited address with the accept link, whose token opens the invitation", async () => {
    const ota = await newOta();
    const owner = await join(ota, "owner");
    const email = uniqueEmail("invite-mail");

    const created = await invite(ota, owner, email, "agent");
    const message = await waitForMessage({
      to: email,
      subject: `${owner.fullName} invited you to ${ota.name} on Velexis`,
      timeoutMs: WAIT_MS,
    });

    expect(created.status).toBe(201);
    const link = extractLinks(message).find((url) => url.startsWith(`${ACCEPT_LINK}?token=`));
    expect(link).toBeDefined();
    const token = new URL(link ?? "").searchParams.get("token") ?? "";
    secrets.add(token);
    expect(message.Text).toContain(`with the role agent`);
    const shown = await lookup(token);
    expect([shown.status, (shown.body as { email: string }).email]).toEqual([200, email]);
  });

  it("never writes an invitation token or an access token to a log line of the API or the worker", () => {
    expect(secrets.size).toBeGreaterThan(10);
    const lines = [...t.logs.lines, ...workerLogs.lines].map((line) => JSON.stringify(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      for (const line of lines) {
        expect(line.includes(secret), "a log line holds a token").toBe(false);
      }
    }
  });
});
