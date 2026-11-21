// The owner's retry of a failed setup and MAX_TENANTS_PER_ACCOUNT (FIX-W67-KI002, lead decision (36e) of 2026-11-21;
// known issue KI-002; scope PF-10 AC4, PF-11 AC2; provisioning/lifecycle.service.ts, `retryProvisioning` in its file
// header) through the HTTP pipeline (createTestApp) on this file's database clone and Redis database, with a limit of
// 2. A failed OTA does not count, so the retry counts the OTAs of its owners and refuses with createTenant's exact
// error when one of them owns the limit already, changing nothing; the platform admin's retry stays exempt. Every
// answer is checked against the platform document.
//
// Concurrency is made deterministic as in create-tenant.int.test.ts: a transaction of the test holds a row (an
// account's, or the failed OTA's) while the requests start, and lets it go once each request waits for a lock or has
// answered, so the requests overlap however fast each one is. Rows come from the builders, with ids, keys and
// addresses of this file only; the jobs a retry leaves active are canceled after each test.
import { randomUUID } from "node:crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  insertAccount,
  insertRow,
  insertSubscription,
  insertTenant,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** This file's MAX_TENANTS_PER_ACCOUNT: small, so an owner reaches it with two OTAs. */
const LIMIT = 2;
/** Documentation addresses (RFC 5737) only. */
const PERSON_IP = "203.0.113.67";
const ADMIN_IP = "198.51.100.67";
/** A zone of the reference data for createTenant; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
/** How long a test waits for a request to reach its lock: well under the 5-second bound of a test. */
const LOCK_WAIT_MS = 3000;

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let admin: PlatformRow<"accounts">;
/** Ids of this file's rows: each test writes rows of its own. */
let next = 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the Nest module graph and the platform document that
  // expectResponseToMatch parses on first use. 60 s covers a slow CI runner.
  t = await createTestApp({ env: { MAX_TENANTS_PER_ACCOUNT: String(LIMIT) } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120) ON CONFLICT DO NOTHING",
    [TIME_ZONE],
  );
  responseChecker("platform");
  admin = await insertAccount(pool, {
    id: testId("acc", 6700),
    email: uniqueEmail("ki002-admin"),
    is_platform_admin: true,
    mfa_enabled: true,
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

afterEach(async () => {
  // A job a retry left active must not stay dispatched for a later test.
  await pool.query(
    "UPDATE platform.provisioning_jobs SET status = 'canceled', locked_until = NULL WHERE status IN ('queued', 'running')",
  );
});

// ---- Calls --------------------------------------------------------------------------------------------------------

async function portalHeaders(account: { readonly id: string }): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: account.id,
    sid: testId("asn", 6700 + next++),
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: testId("asn", 6699),
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

/** The owner's retry (`retryProvisioning`). */
async function retry(account: { readonly id: string }, tenant: { readonly id: string }): Promise<Response> {
  return t.http.post(`/v1/tenants/${tenant.id}/provisioning/retry`).set(await portalHeaders(account));
}

/** createTenant of a new OTA with `key` (`Idempotency-Key` new each time). */
async function create(account: { readonly id: string }, key: string): Promise<Response> {
  return t.http
    .post("/v1/tenants")
    .set(await portalHeaders(account))
    .set("Idempotency-Key", randomUUID())
    .send({ key, name: "Limit Travel", countryCode: "FR", defaultCurrency: "EUR", timeZone: TIME_ZONE });
}

/** An invitation of the OTA's owner (`createInvitation`), to a new address. */
async function invite(account: { readonly id: string }, tenant: { readonly id: string }): Promise<Response> {
  return t.http
    .post(`/v1/tenants/${tenant.id}/invitations`)
    .set(await portalHeaders(account))
    .send({ email: uniqueEmail(`ki002-invitee${next++}`), role: "agent" });
}

/** `<status> <code>` of an answer; `<status>` alone for a success. */
function outcomeOf(res: Response): string {
  const { error } = (res.body ?? {}) as { error?: { code: string } };
  return error === undefined ? String(res.status) : `${res.status} ${error.code}`;
}

/** The error envelope of an answer, without its request id (which differs between two answers). */
function errorOf(res: Response): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = (res.body as { error: Record<string, unknown> }).error;
  return rest;
}

// ---- Arrangement --------------------------------------------------------------------------------------------------

/** An account of this test (active, verified). */
async function account(label: string): Promise<PlatformRow<"accounts">> {
  const n = next++;
  return insertAccount(pool, { id: testId("acc", 6700 + n), email: uniqueEmail(`ki002-${label}${n}`) });
}

/** `count` OTAs that are not failed (active, with a manual trial) owned by `owner`. */
async function ownActiveOtas(owner: { readonly id: string }, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const n = next++;
    const tenant = await insertTenant(pool, { id: testId("ten", 6700 + n), key: `kitwoactive${n}` });
    await insertMember(pool, tenant, owner, "owner");
    await insertSubscription(pool, tenant, { id: testId("sub", 6700 + n) });
  }
}

interface FailedOta {
  readonly tenant: PlatformRow<"tenants">;
  readonly failedJobId: string;
}

/** A failed OTA owned by `owners` (a manual trial, a failed `provision` job), as a setup that gave up leaves it. */
async function failedOta(owners: ReadonlyArray<{ readonly id: string }>): Promise<FailedOta> {
  const n = next++;
  const tenant = await insertTenant(pool, {
    id: testId("ten", 6700 + n),
    key: `kitwofailed${n}`,
    name: `Failed ${n} Travel`,
    status: "failed",
    activated_at: null,
  });
  for (const owner of owners) {
    await insertMember(pool, tenant, owner, "owner");
  }
  await insertSubscription(pool, tenant, { id: testId("sub", 6700 + n) });
  const failedJobId = testId("job", 6700 + n);
  await insertRow(pool, "provisioning_jobs", {
    id: failedJobId,
    tenant_id: tenant.id,
    kind: "provision",
    status: "failed",
    attempt: 5,
    error: "run_migrations failed: LOCK_TIMEOUT: canceling statement due to lock timeout",
    finished_at: t.clock.now(),
  });
  return { tenant, failedJobId };
}

async function tenantRow(tenantId: string): Promise<PlatformRow<"tenants">> {
  const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]);
  return rows[0] as PlatformRow<"tenants">;
}

/** The ids and statuses of the OTA's jobs, oldest first. */
async function jobsOf(tenantId: string): Promise<Array<{ id: string; status: string }>> {
  const { rows } = await pool.query(
    "SELECT id, status FROM platform.provisioning_jobs WHERE tenant_id = $1 ORDER BY created_at, id",
    [tenantId],
  );
  return rows as Array<{ id: string; status: string }>;
}

async function auditOf(tenantId: string, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id",
    [tenantId, action],
  );
  return rows as Array<Record<string, unknown>>;
}

/** The OTAs `accountId` owns that are not failed, as the limit counts them. */
async function ownedNotFailed(accountId: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM platform.tenant_memberships m JOIN platform.tenants t ON t.id = m.tenant_id " +
      "WHERE m.account_id = $1 AND m.role = 'owner' AND m.status <> 'removed' AND t.status <> 'failed'",
    [accountId],
  );
  return (rows[0] as { n: number }).n;
}

/** How many sessions of this file's database wait for a lock. */
async function waitingOnLocks(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return (rows[0] as { waiting: number }).waiting;
}

/** A request sent now, whose answer is awaited later, and whether it has answered yet. */
interface InFlight {
  readonly answer: Promise<Response>;
  done(): boolean;
}

function send(request: () => Promise<Response>): InFlight {
  let answered = false;
  const answer = request().finally(() => {
    answered = true;
  });
  // Awaited by the test; a failure before then must not count as unhandled.
  void answer.catch(() => undefined);
  return { answer, done: () => answered };
}

/**
 * Runs `work` while a transaction of the test holds a row lock taken by `lockSql` (with `[id]`), and lets the lock go
 * (COMMIT, nothing was written) once `work` returns.
 */
async function whileHeld<T>(lockSql: string, id: string, work: () => Promise<T>): Promise<T> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(lockSql, [id]);
    const result = await work();
    await holder.query("COMMIT");
    return result;
  } catch (error) {
    await holder.query("ROLLBACK");
    throw error;
  } finally {
    holder.release();
  }
}

/** Resolves once `ready()` holds, asking every 20 ms, for at most LOCK_WAIT_MS. */
async function until(ready: () => Promise<boolean>): Promise<void> {
  await expect.poll(ready, { timeout: LOCK_WAIT_MS, interval: 20 }).toBe(true);
}

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("retryProvisioning and MAX_TENANTS_PER_ACCOUNT", () => {
  it("[FIX-W67-KI002 AC1] an owner at the limit gets createTenant's 422 tenant_limit on retry; the OTA stays failed with no new job and no audit row [PF-10 AC4]", async () => {
    const owner = await account("owner");
    await ownActiveOtas(owner, LIMIT);
    const { tenant, failedJobId } = await failedOta([owner]);

    const res = await retry(owner, tenant);

    expect(outcomeOf(res)).toBe("422 UNPROCESSABLE");
    expectResponseToMatch("retryProvisioning", res, { document: "platform" });
    expect(errorOf(res)).toMatchObject({ details: { reason: "tenant_limit", limit: LIMIT } });
    // Exactly createTenant's error for the same owner.
    const created = await create(owner, `kitwonew${next++}`);
    expect(outcomeOf(created)).toBe("422 UNPROCESSABLE");
    expect(errorOf(res)).toEqual(errorOf(created));
    // Nothing changed.
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "failed", version: tenant.version });
    expect(await jobsOf(tenant.id)).toEqual([{ id: failedJobId, status: "failed" }]);
    expect(await auditOf(tenant.id, "provisioning_job.retried")).toEqual([]);
    expect(await ownedNotFailed(owner.id)).toBe(LIMIT);
  });

  it("[FIX-W67-KI002 AC1] counts every owner of the failed OTA: a co-owner at the limit refuses the caller's retry too", async () => {
    const caller = await account("caller");
    const coOwner = await account("coowner");
    await ownActiveOtas(coOwner, LIMIT);
    const { tenant, failedJobId } = await failedOta([caller, coOwner]);

    const res = await retry(caller, tenant);

    expect(outcomeOf(res)).toBe("422 UNPROCESSABLE");
    expect(errorOf(res)).toMatchObject({ details: { reason: "tenant_limit", limit: LIMIT } });
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "failed" });
    expect(await jobsOf(tenant.id)).toEqual([{ id: failedJobId, status: "failed" }]);
  });

  it("[FIX-W67-KI002 AC1] an owner below the limit retries as before: the OTA reopens with a new job and the retry is audited", async () => {
    const owner = await account("below");
    await ownActiveOtas(owner, LIMIT - 1);
    const { tenant, failedJobId } = await failedOta([owner]);

    const res = await retry(owner, tenant);

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("retryProvisioning", res, { document: "platform" });
    const { job } = res.body as { job: { id: string } };
    expect(job.id).not.toBe(failedJobId);
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "provisioning", version: tenant.version + 1 });
    // The failed job stays as history beside the new one.
    const jobs = await jobsOf(tenant.id);
    expect(jobs).toHaveLength(2);
    expect(jobs).toEqual(
      expect.arrayContaining([
        { id: failedJobId, status: "failed" },
        expect.objectContaining({ id: job.id }),
      ]),
    );
    expect(await auditOf(tenant.id, "provisioning_job.retried")).toHaveLength(1);
    expect(await ownedNotFailed(owner.id)).toBe(LIMIT);
  });

  it("[FIX-W67-KI002 AC3] the platform admin's retry still reopens a failed OTA whose owner is at the limit", async () => {
    const owner = await account("adminretry");
    await ownActiveOtas(owner, LIMIT);
    const { tenant, failedJobId } = await failedOta([owner]);

    const res = await t.http
      .post(`/v1/admin/provisioning-jobs/${failedJobId}/retry`)
      .set(await adminHeaders());

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("adminRetryProvisioningJob", res, { document: "platform" });
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "provisioning" });
    // Exempt by decision: the owner now has one OTA more than the limit allows.
    expect(await ownedNotFailed(owner.id)).toBe(LIMIT + 1);
    // The owner's own retry of another failed OTA is still refused.
    const other = await failedOta([owner]);
    expect(outcomeOf(await retry(owner, other.tenant))).toBe("422 UNPROCESSABLE");
  });
});

describe("retryProvisioning under concurrency", () => {
  it("[FIX-W67-KI002 AC2] a create and a retry of one account at the limit minus one, both waiting on the account's row, end with exactly one success and no deadlock", async () => {
    const owner = await account("race");
    await ownActiveOtas(owner, LIMIT - 1);
    const { tenant } = await failedOta([owner]);
    const key = `kitworace${next++}`;

    const [creating, retrying] = await whileHeld(
      "SELECT id FROM platform.accounts WHERE id = $1 FOR UPDATE",
      owner.id,
      async (): Promise<[InFlight, InFlight]> => {
        const inFlight: [InFlight, InFlight] = [
          send(() => create(owner, key)),
          send(() => retry(owner, tenant)),
        ];
        // Both wait for the account's row, so neither has counted when the holder lets it go.
        await until(async () => (await waitingOnLocks()) === 2);
        return inFlight;
      },
    );

    const outcomes = [outcomeOf(await creating.answer), outcomeOf(await retrying.answer)].sort();
    expect(outcomes).toEqual(["202", "422 UNPROCESSABLE"]);
    expect(await ownedNotFailed(owner.id)).toBe(LIMIT);
  });

  it("[FIX-W67-KI002 AC2] two retries of one owner's two failed OTAs at the limit minus one, both waiting on the account's row, end with exactly one success", async () => {
    // The owners' lock conflicts with itself (FOR NO KEY UPDATE): a shared mode (FOR SHARE, FOR KEY SHARE) would let
    // both retries count the same OTAs and both reopen.
    const owner = await account("tworetries");
    await ownActiveOtas(owner, LIMIT - 1);
    const first = await failedOta([owner]);
    const second = await failedOta([owner]);

    const [one, two] = await whileHeld(
      "SELECT id FROM platform.accounts WHERE id = $1 FOR UPDATE",
      owner.id,
      async (): Promise<[InFlight, InFlight]> => {
        const inFlight: [InFlight, InFlight] = [
          send(() => retry(owner, first.tenant)),
          send(() => retry(owner, second.tenant)),
        ];
        // Both wait for the account's row, so neither has counted when the holder lets it go.
        await until(async () => (await waitingOnLocks()) === 2);
        return inFlight;
      },
    );

    const outcomes = [outcomeOf(await one.answer), outcomeOf(await two.answer)].sort();
    expect(outcomes).toEqual(["202", "422 UNPROCESSABLE"]);
    expect(await ownedNotFailed(owner.id)).toBe(LIMIT);
    const statuses = [
      (await tenantRow(first.tenant.id)).status,
      (await tenantRow(second.tenant.id)).status,
    ].sort();
    expect(statuses).toEqual(["failed", "provisioning"]);
  });

  it("[FIX-W67-KI002 AC2] a retry holds the account while it waits for the OTA's row, so the account's create waits behind it and then meets the limit", async () => {
    const owner = await account("order");
    await ownActiveOtas(owner, LIMIT - 1);
    const { tenant } = await failedOta([owner]);

    const [retrying, creating] = await whileHeld(
      "SELECT id FROM platform.tenants WHERE id = $1 FOR UPDATE",
      tenant.id,
      async (): Promise<[InFlight, InFlight]> => {
        const retried = send(() => retry(owner, tenant));
        // The retry has locked the account (accounts first, as createTenant) and waits for the tenant's row.
        await until(async () => (await waitingOnLocks()) === 1);
        const created = send(() => create(owner, `kitwoorder${next++}`));
        // The create waits for the account the retry holds (or, without that lock, answers at once).
        await until(async () => created.done() || (await waitingOnLocks()) === 2);
        return [retried, created];
      },
    );

    expect(outcomeOf(await retrying.answer)).toBe("202");
    expect(outcomeOf(await creating.answer)).toBe("422 UNPROCESSABLE");
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "provisioning" });
    expect(await ownedNotFailed(owner.id)).toBe(LIMIT);
  });

  it("[FIX-W67-KI002 AC2] an invitation of the same owner while the retry waits for the OTA's row does not deadlock: both succeed", async () => {
    // The invitation takes a key share of the OTA's row (its foreign key) and then of the owner's account; a retry
    // holding the account `FOR UPDATE` while it waits for the OTA's row would deadlock with it. The holder takes the
    // OTA's row `FOR NO KEY UPDATE`, which makes the retry wait and lets the key shares through.
    const owner = await account("invite");
    const { tenant } = await failedOta([owner]);

    const [retrying, inviting] = await whileHeld(
      "SELECT id FROM platform.tenants WHERE id = $1 FOR NO KEY UPDATE",
      tenant.id,
      async (): Promise<[InFlight, InFlight]> => {
        const retried = send(() => retry(owner, tenant));
        await until(async () => (await waitingOnLocks()) === 1);
        const invited = send(() => invite(owner, tenant));
        await until(async () => invited.done() || (await waitingOnLocks()) === 2);
        return [retried, invited];
      },
    );

    expect(outcomeOf(await inviting.answer)).toBe("201");
    expect(outcomeOf(await retrying.answer)).toBe("202");
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "provisioning" });
  });
});
