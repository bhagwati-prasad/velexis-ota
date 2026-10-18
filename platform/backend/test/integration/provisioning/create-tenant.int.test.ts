// createTenant (PBE-018; platform/docs/flows/signup-and-create-ota.md steps 5 to 7 and failure handling, scope PF-10
// and PF-40, api-inventory §7) through the HTTP pipeline (createTestApp) on this file's database clone: the six rows of
// one transaction, the manual trial before M5, the tenant limit, the verified primary sub-domain, the key rules and
// the idempotency of PBE-009. Accounts and OTAs are written with the builders; tokens come from the application's
// TokenService. Every answer is checked against the platform document.
//
// Concurrency is made deterministic as in members.int.test.ts: a transaction of the test holds the accounts' rows
// while the requests start, and lets them go once every request waits for a lock.
import { randomUUID } from "node:crypto";
import { sql } from "@velexis/db";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../../../src/audit/audit.repository";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { SubscriptionsRepository } from "../../../src/billing/subscriptions.repository";
import { PLATFORM_DB, PLATFORM_POOL, type PlatformDb, type PlatformPool } from "../../../src/common/database";
import { REDIS_CLIENT } from "../../../src/common/redis/redis.module";
import {
  MembershipsRepository,
  type NewOwnerMembership,
} from "../../../src/memberships/memberships.repository";
import { TenantsRepository } from "../../../src/tenants/tenants.repository";
import { insertAccount, insertPlan, insertTenant, testId } from "../../builders/platform-rows";
import { insertMembership, insertOta, TEST_BASE_DOMAIN } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.7";
/** A zone of the reference data for the requests; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The tables createTenant writes, one row each. */
const WRITTEN_TABLES = [
  "tenants",
  "tenant_memberships",
  "subscriptions",
  "tenant_domains",
  "provisioning_jobs",
  "platform_audit_log",
] as const;
type WrittenTable = (typeof WRITTEN_TABLES)[number];

type Row = Record<string, unknown>;

interface CreateBody {
  readonly key: string;
  readonly name: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly timeZone: string;
  readonly planCode?: string;
  readonly billingInterval?: "month" | "year";
}

interface Response {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;

/** Every token this file signed, to check that none reaches a log line. */
const signed: string[] = [];

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the Nest module graph and the Ajv validators of the
  // document. 60 s covers a slow CI runner.
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120)",
    [TIME_ZONE],
  );
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function account(overrides: Parameters<typeof insertAccount>[1] = {}): Promise<string> {
  return (await insertAccount(pool, overrides)).id;
}

/** A request body for `key`: an OTA in France selling in euros. */
function body(key: string, overrides: Partial<CreateBody> = {}): CreateBody {
  return {
    key,
    name: "Acme Travel",
    countryCode: "FR",
    defaultCurrency: "EUR",
    timeZone: TIME_ZONE,
    ...overrides,
  };
}

/** `Authorization: Bearer` with a fresh portal token of `accountId`, and the portal server's headers. */
async function headers(
  accountId: string,
  input: Partial<AccessTokenInput> = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
    ...input,
  });
  signed.push(token);
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** POST /v1/tenants as `accountId` with `idempotencyKey` (a new one by default). */
async function create(
  accountId: string,
  payload: CreateBody,
  idempotencyKey: string = randomUUID(),
  input: Partial<AccessTokenInput> = {},
): Promise<Response> {
  return t.http
    .post("/v1/tenants")
    .set(await headers(accountId, input))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload);
}

/** `<status> <code>` of an answer; `<status>` alone for a success. */
function outcomeOf(res: Response): string {
  const { error } = (res.body ?? {}) as { error?: { code: string; requestId: string } };
  if (error === undefined) {
    return String(res.status);
  }
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return `${res.status} ${error.code}`;
}

/** The number of rows of each table createTenant writes. */
async function counts(): Promise<Record<WrittenTable, number>> {
  const result: Partial<Record<WrittenTable, number>> = {};
  for (const table of WRITTEN_TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM platform.${table}`);
    result[table] = (rows[0] as { n: number }).n;
  }
  return result as Record<WrittenTable, number>;
}

async function rowsOf(sql: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(sql, values)).rows as Row[];
}

/** The rows of the OTA `tenantId` in each table createTenant writes. */
async function writtenFor(tenantId: string): Promise<Record<WrittenTable, Row[]>> {
  return {
    tenants: await rowsOf("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]),
    tenant_memberships: await rowsOf("SELECT * FROM platform.tenant_memberships WHERE tenant_id = $1", [
      tenantId,
    ]),
    subscriptions: await rowsOf("SELECT * FROM platform.subscriptions WHERE tenant_id = $1", [tenantId]),
    tenant_domains: await rowsOf("SELECT * FROM platform.tenant_domains WHERE tenant_id = $1", [tenantId]),
    provisioning_jobs: await rowsOf("SELECT * FROM platform.provisioning_jobs WHERE tenant_id = $1", [
      tenantId,
    ]),
    platform_audit_log: await rowsOf("SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1", [
      tenantId,
    ]),
  };
}

/** The tenant rows with `key`, in any status. */
const tenantsWithKey = (key: string): Promise<Row[]> =>
  rowsOf("SELECT * FROM platform.tenants WHERE key = $1", [key]);

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

/**
 * Sends `requests` while a transaction of the test holds the rows of `accountIds` (`FOR UPDATE`), and lets them go
 * once every request waits for a lock: createTenant locks the caller's account first, so the requests overlap however
 * fast each one is. Answers in the order of `requests`.
 */
async function whileAccountsHeld(
  accountIds: readonly string[],
  requests: ReadonlyArray<() => Promise<Response>>,
): Promise<Response[]> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM platform.accounts WHERE id = ANY($1) FOR UPDATE", [[...accountIds]]);
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

describe("createTenant", () => {
  it("[PBE-018 AC1] writes the tenant, its owner membership, subscription, sub-domain and queued job, and the audit row tenant.created, in one call [PF-10 AC2]", async () => {
    const founder = await account();
    const before = await counts();
    const now = t.clock.now();

    const res = await create(founder, body("acmetravel"));

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const answer = res.body as {
      tenant: Row & { id: string };
      provisioningJob: { id: string; status: string };
      checkoutUrl: null;
    };
    expect(answer).toEqual({
      tenant: {
        id: answer.tenant.id,
        key: "acmetravel",
        name: "Acme Travel",
        legalName: null,
        status: "provisioning",
        suspensionReason: null,
        billingNotice: null,
        planCode: "early_access",
        defaultCurrency: "EUR",
        countryCode: "FR",
        timeZone: TIME_ZONE,
        supportEmail: null,
        storefrontEnvironment: "test",
        liveEnabledAt: null,
        primaryHost: `acmetravel.${TEST_BASE_DOMAIN}`,
        schemaVersion: null,
        createdAt: now.toISOString(),
        activatedAt: null,
        version: 1,
        myRole: "owner",
      },
      provisioningJob: { id: answer.provisioningJob.id, status: "queued" },
      checkoutUrl: null,
    });

    // One row in each table, all of this OTA.
    const after = await counts();
    for (const table of WRITTEN_TABLES) {
      expect(after[table] - before[table], table).toBe(1);
    }
    const rows = await writtenFor(answer.tenant.id);
    expect(rows.tenants).toEqual([
      expect.objectContaining({
        key: "acmetravel",
        schema_name: "tenant_acmetravel",
        status: "provisioning",
        plan_code: "early_access",
        storefront_environment: "test",
        created_by_account_id: founder,
        country_code: "FR",
        default_currency: "EUR",
        time_zone: TIME_ZONE,
        activated_at: null,
        created_at: now,
      }),
    ]);
    expect(rows.tenant_memberships).toEqual([
      expect.objectContaining({
        account_id: founder,
        role: "owner",
        status: "active",
        invited_by_account_id: null,
      }),
    ]);
    expect(String(rows.tenant_memberships[0]?.["id"])).toMatch(/^stf_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(rows.subscriptions).toHaveLength(1);
    expect(rows.tenant_domains).toHaveLength(1);
    expect(rows.provisioning_jobs).toEqual([
      expect.objectContaining({
        id: answer.provisioningJob.id,
        kind: "provision",
        status: "queued",
        step: null,
        attempt: 0,
        max_attempts: 5,
        scheduled_at: now,
        started_at: null,
        requested_by_account_id: founder,
      }),
    ]);
    const subscriptionId = rows.subscriptions[0]?.["id"];
    expect(rows.platform_audit_log).toEqual([
      expect.objectContaining({
        action: "tenant.created",
        actor_type: "account",
        actor_account_id: founder,
        target_type: "tenant",
        target_id: answer.tenant.id,
        tenant_key: "acmetravel",
        request_id: res.headers["x-request-id"],
        ip_address: PERSON_IP,
        details: {
          provisioningJobId: answer.provisioningJob.id,
          subscriptionId,
          subscriptionStatus: "trialing",
          billingProvider: "manual",
          after: {
            key: "acmetravel",
            name: "Acme Travel",
            status: "provisioning",
            planCode: "early_access",
            countryCode: "FR",
            defaultCurrency: "EUR",
            timeZone: TIME_ZONE,
            storefrontEnvironment: "test",
            primaryHost: `acmetravel.${TEST_BASE_DOMAIN}`,
          },
        },
      }),
    ]);

    // The founder is the OTA's owner: getTenant answers the same OTA.
    const read = await t.http.get(`/v1/tenants/${answer.tenant.id}`).set(await headers(founder));
    expect(read.status).toBe(200);
    expect(read.body).toEqual(answer.tenant);
  });

  it("[PBE-018 AC1] leaves no row at all when an error is injected after the membership insert; a retry with the same Idempotency-Key then creates the OTA [PF-10 AC2]", async () => {
    const founder = await account();
    const memberships = t.app.get(MembershipsRepository);
    const insertOwner = memberships.insertOwner.bind(memberships);
    const seenInTransaction: number[] = [];
    const injected = vi
      .spyOn(memberships, "insertOwner")
      .mockImplementationOnce(async (trx: PlatformTransaction, membership: NewOwnerMembership) => {
        await insertOwner(trx, membership);
        const written = await trx
          .selectFrom("platform.tenant_memberships")
          .select("id")
          .where("tenant_id", "=", membership.tenantId)
          .execute();
        seenInTransaction.push(written.length);
        throw new Error("injected failure after the membership insert");
      });
    const before = await counts();
    const idempotencyKey = randomUUID();

    const failed = await create(founder, body("rollbackota"), idempotencyKey);

    expect(outcomeOf(failed)).toBe("500 INTERNAL_ERROR");
    expectResponseToMatch("createTenant", failed, { document: "platform" });
    expect(injected).toHaveBeenCalledTimes(1);
    // The tenant and the membership existed inside the transaction, and nothing survived it.
    expect(seenInTransaction).toEqual([1]);
    expect(await counts()).toEqual(before);
    expect(await tenantsWithKey("rollbackota")).toEqual([]);

    // Errors are never stored for replay, so the same key runs again.
    const retried = await create(founder, body("rollbackota"), idempotencyKey);

    expect(outcomeOf(retried)).toBe("202");
    expect(await tenantsWithKey("rollbackota")).toHaveLength(1);
  });

  it("[PBE-018 AC2] puts the OTA on a manual early_access trial before M5, whatever plan the request names [PF-10 AC3]", async () => {
    await insertPlan(pool, {
      code: "starter",
      stripe_price_id_month: "price_TestStarterMonth",
      stripe_price_id_year: "price_TestStarterYear",
    });
    const founder = await account();
    const now = t.clock.now();
    const { rows: plans } = await pool.query(
      "SELECT trial_days FROM platform.plans WHERE code = 'early_access'",
    );
    const trialDays = (plans[0] as { trial_days: number }).trial_days;

    const res = await create(founder, body("trialota", { planCode: "starter", billingInterval: "year" }));

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const { tenant, checkoutUrl } = res.body as {
      tenant: { id: string; planCode: string };
      checkoutUrl: unknown;
    };
    expect([tenant.planCode, checkoutUrl]).toEqual(["early_access", null]);
    const { subscriptions, tenants } = await writtenFor(tenant.id);
    expect(tenants[0]?.["plan_code"]).toBe("early_access");
    expect(subscriptions).toEqual([
      expect.objectContaining({
        plan_code: "early_access",
        status: "trialing",
        billing_provider: "manual",
        billing_interval: "month",
        trial_ends_at: new Date(now.getTime() + trialDays * DAY_MS),
        provider_customer_id: null,
        provider_subscription_id: null,
        provider_price_id: null,
        checkout_session_id: null,
        current_period_end: null,
        cancel_at_period_end: false,
        created_at: now,
      }),
    ]);
    expect(String(subscriptions[0]?.["id"])).toMatch(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("[PBE-018 AC2] ends the manual trial trial_days times 24 hours after its start, whatever the time zone of the database session [PF-10 AC3]", async () => {
    const db = t.app.get<PlatformDb>(PLATFORM_DB);
    const tenant = await insertTenant(pool, { status: "provisioning", activated_at: null });
    const { rows: plans } = await pool.query(
      "SELECT trial_days FROM platform.plans WHERE code = 'early_access'",
    );
    const trialDays = (plans[0] as { trial_days: number }).trial_days;
    // Summer time ends in Oslo on 2026-10-25, inside the trial: calendar days of that zone would end it an hour late.
    const start = new Date("2026-10-14T08:00:00.000Z");

    const trial = await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL TIME ZONE 'Europe/Oslo'`.execute(trx);
      return t.app.get(SubscriptionsRepository).insertManualTrial(trx, {
        id: testId("sub", 1),
        tenantId: tenant.id,
        planCode: "early_access",
        now: start,
      });
    });

    expect(trial).toEqual({
      id: testId("sub", 1),
      plan_code: "early_access",
      status: "trialing",
      billing_provider: "manual",
      trial_ends_at: new Date(start.getTime() + trialDays * DAY_MS),
    });
  });

  it("[PBE-018 AC3] answers 422 UNPROCESSABLE with details.reason tenant_limit to the fourth OTA that is not failed; failed OTAs and other memberships do not count [PF-10 AC4]", async () => {
    const founder = await account();
    // Two owned OTAs that count (active, provisioning), and three that do not: a failed one, one the founder no longer
    // owns, and one where the founder is an admin.
    await insertOta(pool, { members: [[{ id: founder }, "owner"]] });
    await insertOta(pool, {
      tenant: { status: "provisioning", activated_at: null },
      members: [[{ id: founder }, "owner"]],
    });
    await insertOta(pool, {
      tenant: { status: "failed", activated_at: null },
      members: [[{ id: founder }, "owner"]],
    });
    const left = await insertOta(pool);
    await insertMembership(pool, left.tenant, { id: founder }, { role: "owner", status: "removed" });
    await insertOta(pool, { members: [[{ id: founder }, "admin"]] });

    const third = await create(founder, body("thirdota"));
    const before = await counts();
    const fourth = await create(founder, body("fourthota"));

    expect(outcomeOf(third)).toBe("202");
    expect(outcomeOf(fourth)).toBe("422 UNPROCESSABLE");
    expectResponseToMatch("createTenant", fourth, { document: "platform" });
    expect((fourth.body as { error: { details: unknown } }).error.details).toEqual({
      reason: "tenant_limit",
      limit: t.config.MAX_TENANTS_PER_ACCOUNT,
    });
    expect(await counts()).toEqual(before);
    expect(await tenantsWithKey("fourthota")).toEqual([]);
    expect(await ownedNotFailed(founder)).toBe(3);
  });

  it("[PBE-018 AC3] counts the creations of one account one after the other: two at once beside two owned OTAs give one 202 and one 422 [PF-10 AC4]", async () => {
    const founder = await account();
    await insertOta(pool, { members: [[{ id: founder }, "owner"]] });
    await insertOta(pool, { members: [[{ id: founder }, "owner"]] });

    const answers = await whileAccountsHeld(
      [founder],
      [() => create(founder, body("racingone")), () => create(founder, body("racingtwo"))],
    );

    expect(answers.map(outcomeOf).sort()).toEqual(["202", "422 UNPROCESSABLE"]);
    expect(await ownedNotFailed(founder)).toBe(3);
  });

  it("[PBE-018 AC4] creates the storefront sub-domain verified and primary, the OTA's primary host [PF-40 AC1]", async () => {
    const founder = await account();
    const now = t.clock.now();

    const res = await create(founder, body("subdomainota"));

    expect(outcomeOf(res)).toBe("202");
    const { tenant } = res.body as { tenant: { id: string; primaryHost: string } };
    const { tenant_domains: domains } = await writtenFor(tenant.id);
    expect(domains).toEqual([
      expect.objectContaining({
        hostname: `subdomainota.${TEST_BASE_DOMAIN}`,
        kind: "subdomain",
        purpose: "storefront",
        is_primary: true,
        verification_status: "verified",
        verified_at: now,
        verification_token: null,
        verification_deadline_at: null,
        tls_status: "pending",
        created_by_account_id: null,
      }),
    ]);
    expect(String(domains[0]?.["id"])).toMatch(/^dom_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(tenant.primaryHost).toBe(`subdomainota.${TEST_BASE_DOMAIN}`);
  });

  it("[PBE-018 AC5] replays the 202 for the same Idempotency-Key and body, and answers 409 IDEMPOTENCY_KEY_REUSED to another body with that key", async () => {
    const founder = await account();
    const idempotencyKey = randomUUID();

    const first = await create(founder, body("replayota"), idempotencyKey);
    const replayed = await create(founder, body("replayota"), idempotencyKey);
    const reused = await create(founder, body("replayota", { name: "Another Name" }), idempotencyKey);

    expect([first, replayed, reused].map(outcomeOf)).toEqual(["202", "202", "409 IDEMPOTENCY_KEY_REUSED"]);
    expect(replayed.body).toEqual(first.body);
    for (const res of [first, replayed, reused]) {
      expectResponseToMatch("createTenant", res, { document: "platform" });
    }
    expect(await tenantsWithKey("replayota")).toHaveLength(1);
  });

  it("answers 409 TENANT_KEY_UNAVAILABLE to a reserved key and to the key of any tenant row, failed and deleted ones included, and 400 to a key that breaks the rule [PF-10 AC1]", async () => {
    const founder = await account();
    await insertTenant(pool, { key: "failedkey", status: "failed", activated_at: null });
    await insertTenant(pool, {
      key: "deletedkey",
      status: "deleted",
      deleted_at: new Date("2026-01-01T00:00:00Z"),
    });
    const before = await counts();

    const answers = [];
    for (const key of ["admin", "support", "failedkey", "deletedkey", "ab", "1abc", "a_bc"]) {
      const res = await create(founder, body(key));
      expectResponseToMatch("createTenant", res, { document: "platform" });
      answers.push(`${key}: ${outcomeOf(res)}`);
    }

    expect(answers).toEqual([
      "admin: 409 TENANT_KEY_UNAVAILABLE",
      "support: 409 TENANT_KEY_UNAVAILABLE",
      "failedkey: 409 TENANT_KEY_UNAVAILABLE",
      "deletedkey: 409 TENANT_KEY_UNAVAILABLE",
      "ab: 400 VALIDATION_FAILED",
      "1abc: 400 VALIDATION_FAILED",
      "a_bc: 400 VALIDATION_FAILED",
    ]);
    expect(await counts()).toEqual(before);
  });

  it("maps the unique violation of a key taken between the check and the insert to 409 TENANT_KEY_UNAVAILABLE, and writes nothing", async () => {
    const founder = await account();
    await insertTenant(pool, { key: "takenmeanwhile" });
    // The check misses the row, as it would for a creation that commits right after it.
    const checked = vi.spyOn(t.app.get(TenantsRepository), "keyExists").mockResolvedValueOnce(false);
    const before = await counts();

    const res = await create(founder, body("takenmeanwhile"));

    expect(checked).toHaveBeenCalledTimes(1);
    expect(outcomeOf(res)).toBe("409 TENANT_KEY_UNAVAILABLE");
    expectResponseToMatch("createTenant", res, { document: "platform" });
    expect(await counts()).toEqual(before);
  });

  it("gives one 202 and one 409 TENANT_KEY_UNAVAILABLE to two accounts that create the same key at once", async () => {
    const first = await account();
    const second = await account();

    const answers = await whileAccountsHeld(
      [first, second],
      [() => create(first, body("samekey")), () => create(second, body("samekey"))],
    );

    expect(answers.map(outcomeOf).sort()).toEqual(["202", "409 TENANT_KEY_UNAVAILABLE"]);
    expect(await tenantsWithKey("samekey")).toHaveLength(1);
  });

  it("answers 400 VALIDATION_FAILED to a country, currency or time zone the reference data lacks, without echoing them", async () => {
    const founder = await account();
    const before = await counts();

    const res = await create(
      founder,
      body("unknownrefs", { countryCode: "ZZ", defaultCurrency: "XXQ", timeZone: "Mars/Olympus_Mons" }),
    );

    expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const { fieldErrors } = (res.body as { error: { fieldErrors: Array<{ path: string; code: string }> } })
      .error;
    expect(fieldErrors.map(({ path, code }) => `${path} ${code}`)).toEqual([
      "/countryCode unknown",
      "/defaultCurrency unknown",
      "/timeZone unknown",
    ]);
    const text = JSON.stringify(res.body);
    for (const value of ["ZZ", "XXQ", "Mars/Olympus_Mons"]) {
      expect(text).not.toContain(value);
    }
    expect(await counts()).toEqual(before);
  });

  it("answers 401 without a token and 403 EMAIL_NOT_VERIFIED to an unverified token and to an account that is no longer verified and active", async () => {
    const verified = await account();
    const unverified = await account({ status: "pending_verification", email_verified_at: null });
    const disabled = await account({ status: "disabled" });
    const before = await counts();

    const anonymous = await t.http
      .post("/v1/tenants")
      .set(t.bffHeaders(PERSON_IP))
      .set("Idempotency-Key", randomUUID())
      .send(body("noaccount"));
    const unverifiedToken = await create(verified, body("unverifiedtoken"), randomUUID(), { ev: false });
    const staleUnverified = await create(unverified, body("staleunverified"));
    const staleDisabled = await create(disabled, body("staledisabled"));

    expect([anonymous, unverifiedToken, staleUnverified, staleDisabled].map(outcomeOf)).toEqual([
      "401 UNAUTHENTICATED",
      "403 EMAIL_NOT_VERIFIED",
      "403 EMAIL_NOT_VERIFIED",
      "403 EMAIL_NOT_VERIFIED",
    ]);
    for (const res of [anonymous, unverifiedToken, staleUnverified, staleDisabled]) {
      expectResponseToMatch("createTenant", res, { document: "platform" });
    }
    expect(await counts()).toEqual(before);
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

// Last in the file: createTestApp empties this worker's Redis database, which the application above uses.
describe("createTenant with Redis down", () => {
  let down: TestApp;

  beforeAll(async () => {
    const unreachable = new Redis("redis://127.0.0.1:1/0", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    unreachable.on("error", () => {
      // Expected: nothing listens there.
    });
    // A second application on its own database clone: the same start-up cost as the file's beforeAll.
    down = await createTestApp({ overrides: [{ provide: REDIS_CLIENT, useValue: unreachable }] });
  }, 60_000);

  afterAll(async () => {
    await down?.close();
  });

  it("[PBE-018 AC5] answers 503 SERVICE_UNAVAILABLE before writing anything", async () => {
    const downPool = down.app.get<PlatformPool>(PLATFORM_POOL);
    const founder = (await insertAccount(downPool)).id;
    const { token } = await down.app.get(TokenService).sign({
      aud: "portal",
      sub: founder,
      sid: FAMILY,
      ev: true,
      amr: ["pwd"],
    });
    const countRows = async (): Promise<number[]> => {
      const totals: number[] = [];
      for (const table of WRITTEN_TABLES) {
        const { rows } = await downPool.query(`SELECT count(*)::int AS n FROM platform.${table}`);
        totals.push((rows[0] as { n: number }).n);
      }
      return totals;
    };
    const before = await countRows();

    const res = await down.http
      .post("/v1/tenants")
      .set({ Authorization: `Bearer ${token}`, ...down.bffHeaders(PERSON_IP) })
      .set("Idempotency-Key", randomUUID())
      .send(body("redisdown"));

    expect(outcomeOf(res)).toBe("503 SERVICE_UNAVAILABLE");
    expectResponseToMatch("createTenant", res, { document: "platform" });
    expect(await countRows()).toEqual(before);
  });
});
