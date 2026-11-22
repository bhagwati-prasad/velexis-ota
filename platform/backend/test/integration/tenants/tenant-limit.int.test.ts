// `listTenants`' tenant limit (FIX-W69-LIMIT, known issue KI-010, 2026-11-22; scope PF-10 AC4;
// provisioning/lifecycle.service.ts, `listTenants` in its file header) through the HTTP pipeline (createTestApp) on this
// file's database clone and Redis database, with MAX_TENANTS_PER_ACCOUNT = 2. `tenantLimit.owned` counts the caller's
// OTAs exactly as createTenant counts them (createTenant's own `countOwnedTenants`): its `owner` memberships that are
// not `removed`, of OTAs that are not `failed`. So the list says "at the limit" exactly when createTenant answers `422
// UNPROCESSABLE` (`tenant_limit`), and a count above the limit after an accepted owner invitation (known issue KI-046:
// becoming an owner checks no limit) is answered as it is. Every answer is checked against the platform document.
//
// Rows come from the builders, with ids, keys and addresses of this file only. The owner invitation is accepted through
// `acceptInvitation`, with an invitation row whose token the test knows (only its hash is stored, as the service does).
import { randomUUID } from "node:crypto";
import { generateToken } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { insertAccount, insertRow, testId, type PlatformRow } from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** This file's MAX_TENANTS_PER_ACCOUNT: small, so an owner reaches it with two OTAs. */
const LIMIT = 2;
/** Documentation addresses (RFC 5737) only. */
const PERSON_IP = "203.0.113.69";
/** A zone of the reference data for createTenant; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
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
}, 60_000);

afterAll(async () => {
  await t?.close();
});

afterEach(async () => {
  // A job a creation left active must not stay dispatched for a later test.
  await pool.query(
    "UPDATE platform.provisioning_jobs SET status = 'canceled', locked_until = NULL WHERE status IN ('queued', 'running')",
  );
});

// ---- Calls --------------------------------------------------------------------------------------------------------

async function portalHeaders(account: { readonly id: string }): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: account.id,
    sid: testId("asn", 6900 + next++),
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

interface TenantLimitBody {
  readonly max: number;
  readonly owned: number;
}

/** listTenants as `account`, checked against the document; its `tenantLimit` and the ids it lists. */
async function listed(account: {
  readonly id: string;
}): Promise<{ readonly tenantLimit: TenantLimitBody; readonly ids: string[] }> {
  const res = await t.http.get("/v1/tenants").set(await portalHeaders(account));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expectResponseToMatch("listTenants", res, { document: "platform" });
  const body = res.body as { data: Array<{ id: string }>; tenantLimit: TenantLimitBody };
  return { tenantLimit: body.tenantLimit, ids: body.data.map((tenant) => tenant.id) };
}

/** createTenant of a new OTA (`Idempotency-Key` new each time). */
async function create(account: { readonly id: string }): Promise<Response> {
  const res = await t.http
    .post("/v1/tenants")
    .set(await portalHeaders(account))
    .set("Idempotency-Key", randomUUID())
    .send({
      key: `kilimit${next++}`,
      name: "Limit Travel",
      countryCode: "FR",
      defaultCurrency: "EUR",
      timeZone: TIME_ZONE,
    });
  expectResponseToMatch("createTenant", res, { document: "platform" });
  return res;
}

/** `<status> <code> <reason>` of an error answer; `<status>` alone for a success. */
function outcomeOf(res: Response): string {
  const { error } = (res.body ?? {}) as { error?: { code: string; details?: { reason?: string } } };
  return error === undefined
    ? String(res.status)
    : [res.status, error.code, error.details?.reason].filter(Boolean).join(" ");
}

// ---- Arrangement --------------------------------------------------------------------------------------------------

/** An account of this test (active, verified). */
async function account(label: string): Promise<PlatformRow<"accounts">> {
  const n = next++;
  return insertAccount(pool, { id: testId("acc", 6900 + n), email: uniqueEmail(`ki010-${label}${n}`) });
}

/** An OTA in `status` with `owner` as its active owner. */
async function ownedOta(
  owner: { readonly id: string },
  status: "provisioning" | "active" | "suspended" | "failed" = "active",
): Promise<PlatformRow<"tenants">> {
  const n = next++;
  const { tenant } = await insertOta(pool, {
    tenant: {
      id: testId("ten", 6900 + n),
      key: `kitenlimit${n}`,
      status,
      ...(status === "active" || status === "suspended" ? {} : { activated_at: null }),
      ...(status === "suspended" ? { suspension_reason: "admin" } : {}),
    },
    subscription: { id: testId("sub", 6900 + n) },
    members: [[owner, "owner"]],
  });
  return tenant;
}

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("listTenants: tenantLimit", () => {
  it("[FIX-W69-LIMIT AC1] counts an owner of 3 OTAs with one failed as owning 2, as createTenant counts: at the limit both say so", async () => {
    const owner = await account("owner");
    const active = await ownedOta(owner, "active");
    const settingUp = await ownedOta(owner, "provisioning");
    const failed = await ownedOta(owner, "failed");
    // Neither counts: an admin membership of another OTA, and the removed owner membership of a third.
    const otherOwner = await account("other");
    await insertMember(pool, await ownedOta(otherOwner), owner, "admin");
    await insertMembership(pool, await ownedOta(otherOwner), owner, { role: "owner", status: "removed" });

    const atLimit = await listed(owner);

    expect(atLimit.tenantLimit).toEqual({ max: LIMIT, owned: 2 });
    // The failed OTA is listed (it keeps its key and its set-up page) but does not count.
    expect(atLimit.ids).toEqual(expect.arrayContaining([active.id, settingUp.id, failed.id]));
    // createTenant counts the same two: the list's "at the limit" is createTenant's refusal.
    const refused = await create(owner);
    expect(outcomeOf(refused)).toBe("422 UNPROCESSABLE tenant_limit");
    expect((refused.body as { error: { details: unknown } }).error.details).toEqual({
      reason: "tenant_limit",
      limit: LIMIT,
    });

    // Once the OTA in set-up has failed too, one OTA counts: below the limit, and createTenant creates the second.
    await pool.query("UPDATE platform.tenants SET status = 'failed' WHERE id = $1", [settingUp.id]);
    expect((await listed(owner)).tenantLimit).toEqual({ max: LIMIT, owned: 1 });
    expect(outcomeOf(await create(owner))).toBe("202");
    expect((await listed(owner)).tenantLimit).toEqual({ max: LIMIT, owned: 2 });
  });

  it("[FIX-W69-LIMIT AC1] counts a suspended OTA and a suspended owner membership, as createTenant does", async () => {
    const owner = await account("suspended");
    await ownedOta(owner, "suspended");
    const other = await account("suspender");
    await insertMembership(pool, await ownedOta(other), owner, { role: "owner", status: "suspended" });

    // The suspended membership's OTA is not listed (the list shows active memberships only), but it counts.
    const answer = await listed(owner);
    expect(answer.tenantLimit).toEqual({ max: LIMIT, owned: 2 });
    expect(answer.ids).toHaveLength(1);
    expect(outcomeOf(await create(owner))).toBe("422 UNPROCESSABLE tenant_limit");
  });

  it("[FIX-W69-LIMIT AC1] answers owned 0 to an account without OTAs, and owned above max after an accepted owner invitation (KI-046)", async () => {
    const owner = await account("invited");
    expect(await listed(owner)).toEqual({ tenantLimit: { max: LIMIT, owned: 0 }, ids: [] });

    await ownedOta(owner);
    await ownedOta(owner);
    expect((await listed(owner)).tenantLimit).toEqual({ max: LIMIT, owned: LIMIT });

    // Another owner invites this account as an owner of a third OTA; accepting checks no limit (KI-046).
    const inviter = await account("inviter");
    const third = await ownedOta(inviter);
    const { token, hash } = generateToken("iv");
    const now = t.clock.now();
    await insertRow(pool, "tenant_invitations", {
      id: testId("ivt", 6900 + next++),
      tenant_id: third.id,
      email: owner.email,
      role: "owner",
      token_hash: hash,
      status: "pending",
      invited_by_account_id: inviter.id,
      expires_at: new Date(now.getTime() + SEVEN_DAYS_MS),
      created_at: now,
      updated_at: now,
    });
    const accepted = await t.http
      .post("/v1/invitations/accept")
      .set(await portalHeaders(owner))
      .send({ token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    // Answered as counted, never capped at max; createTenant still refuses.
    const above = await listed(owner);
    expect(above.tenantLimit).toEqual({ max: LIMIT, owned: LIMIT + 1 });
    expect(above.ids).toContain(third.id);
    expect(outcomeOf(await create(owner))).toBe("422 UNPROCESSABLE tenant_limit");
  });
});
