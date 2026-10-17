// The API key routes of the portal (PBE-021; platform/docs/api-inventory-resources.md §1, flows/api-keys.md,
// PADR-0005; scope PF-30) through the HTTP pipeline (createTestApp) on this file's database clone: create (shown
// once, only the HMAC stored), the origin and scope rules, the plan limit, live keys and their step-up, update, roll
// and revoke with their audit rows and `api_key` invalidations, and the generator's own writes (the initial test keys
// of provisioning, a prefix that exists already). Accounts and OTAs are written with the builders;
// tokens come from the application's TokenService; every answer is checked against the platform document.
//
// Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same time,
// so the subscriber keeps only the events of this file's keys.
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { readKeyFile } from "@velexis/config";
import { verifyApiKey } from "@velexis/crypto";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyGenerator } from "../../../src/api-keys/api-key-generator";
import { ApiKeysRepository } from "../../../src/api-keys/api-keys.repository";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import {
  PLATFORM_API_POOL_MAX,
  PLATFORM_DB,
  PLATFORM_POOL,
  type PlatformDb,
  type PlatformPool,
} from "../../../src/common/database";
import { runInTransaction } from "../../../src/common/redis/invalidation.publisher";
import { insertAccount, insertPlan, insertRow, testId } from "../../builders/platform-rows";
import { insertOta, type OtaOptions } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.7";
const HOUR_MS = 60 * 60 * 1000;
/** How long a test waits for an invalidation to arrive. */
const WAIT_MS = 10_000;

/** The ApiKey of the platform document, as the tests read it. */
interface ApiKeyBody {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly environment: string;
  readonly prefix: string;
  readonly last4: string;
  readonly allowedOrigins: string[];
  readonly scopes: string[];
  readonly createdAt: string;
  readonly createdBy: { accountId: string; fullName: string } | null;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

interface StoredKey {
  readonly id: string;
  readonly tenant_id: string;
  readonly prefix: string;
  readonly key_hash: string;
  readonly last4: string;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_by_account_id: string | null;
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let pepper: Buffer;
let subscriber: Redis;

/** The people of every OTA of this file: an owner with MFA, an admin without, an agent; and a stranger. */
const people: Record<"owner" | "admin" | "agent" | "stranger", string> = {
  owner: "",
  admin: "",
  agent: "",
  stranger: "",
};

/** The invalidation events of this file's keys, with the key's `revoked_at` and `expires_at` when they arrived. */
interface Delivery {
  readonly event: InvalidationEvent;
  row?: StoredKey | undefined;
}
const received: Delivery[] = [];
const watched = new Set<string>();

/** Every full key the API answered, to check that none reaches a row, an audit row or a log line. */
const answeredKeys: string[] = [];

beforeAll(async () => {
  // Every line at every level is captured, so "no log line holds the key" covers the debug and trace lines too.
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  const read = readKeyFile(t.config.API_KEY_PEPPER_FILE, { minBytes: 32 });
  if (!Buffer.isBuffer(read)) {
    throw new TypeError("the test pepper is not a base64 key file");
  }
  pepper = read;
  people.owner = (await insertAccount(pool, { mfa_enabled: true, full_name: "Anna Berg" })).id;
  people.admin = (await insertAccount(pool, { full_name: "Ben Admin" })).id;
  people.agent = (await insertAccount(pool)).id;
  people.stranger = (await insertAccount(pool)).id;

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (event.type === "api_key" && watched.has(event.prefix)) {
      const delivery: Delivery = { event };
      received.push(delivery);
      void storedByPrefix(event.prefix).then((row) => {
        delivery.row = row;
      });
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, 60_000);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
});

/** An active OTA (on the seeded plan with 10 keys, unless `tenant` says otherwise) with the owner, admin and agent. */
async function ota(tenant: OtaOptions["tenant"] = {}): Promise<string> {
  const { tenant: row } = await insertOta(pool, {
    tenant,
    members: [
      [{ id: people.owner }, "owner"],
      [{ id: people.admin }, "admin"],
      [{ id: people.agent }, "agent"],
    ],
  });
  return row.id;
}

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** `Authorization: Bearer` with a fresh portal token of the application's TokenService, at the FakeClock's time. */
async function bearer(
  who: keyof typeof people,
  input: Partial<AccessTokenInput> = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: people[who],
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
    ...input,
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** A token with a TOTP step-up now. */
const steppedUp = (who: keyof typeof people) => bearer(who, { amr: ["pwd", "otp"], mfa_at: nowSeconds() });

const keysUrl = (tenantId: string): string => `/v1/tenants/${tenantId}/api-keys`;

/** The error code of an envelope answer, with the request id in the body and the header. */
function errorOf(res: { body: unknown; headers: Record<string, string> }): string {
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.code;
}

async function create(
  tenantId: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const res = await t.http
    .post(keysUrl(tenantId))
    .set(headers ?? (await bearer("admin")))
    .send(body);
  expectResponseToMatch("createApiKey", res, { document: "platform" });
  if (res.status === 201) {
    const created = res.body as { apiKey: ApiKeyBody; key: string };
    answeredKeys.push(created.key);
    watched.add(created.apiKey.prefix);
  }
  return res;
}

/** Creates a key that must succeed, and answers its body. */
async function created(
  tenantId: string,
  body: Record<string, unknown> = { name: "Storefront", kind: "secret", environment: "test" },
): Promise<{ apiKey: ApiKeyBody; key: string }> {
  const res = await create(tenantId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { apiKey: ApiKeyBody; key: string };
}

async function stored(keyId: string): Promise<StoredKey | undefined> {
  const { rows } = await pool.query("SELECT * FROM platform.api_keys WHERE id = $1", [keyId]);
  return rows[0] as StoredKey | undefined;
}

async function storedByPrefix(prefix: string): Promise<StoredKey | undefined> {
  const { rows } = await pool.query("SELECT * FROM platform.api_keys WHERE prefix = $1", [prefix]);
  return rows[0] as StoredKey | undefined;
}

async function auditRows(targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT action, actor_type, actor_account_id, target_type, target_id, tenant_id, details " +
      "FROM platform.platform_audit_log WHERE target_id = $1 ORDER BY id",
    [targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

async function countKeys(tenantId: string): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM platform.api_keys WHERE tenant_id = $1", [
    tenantId,
  ]);
  return (rows[0] as { n: number }).n;
}

/**
 * Runs `work` while the test holds all but one of the API's database connections (PLATFORM_API_POOL_MAX), so a
 * request gets through only if it never needs a second connection while it holds one (a query on the pool inside its
 * transaction would wait for the pool's 10-second timeout).
 */
async function withOneFreeConnection<T>(work: () => Promise<T>): Promise<T> {
  const busy = await Promise.all(Array.from({ length: PLATFORM_API_POOL_MAX - 1 }, () => pool.connect()));
  try {
    return await work();
  } finally {
    for (const client of busy) {
      client.release();
    }
  }
}

/** Waits until an invalidation of `prefix` has arrived and its row was read, and answers it. */
async function invalidationOf(prefix: string): Promise<Delivery> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const delivery = received.find(({ event }) => event.type === "api_key" && event.prefix === prefix);
    if (delivery?.row !== undefined) {
      return delivery;
    }
    if (Date.now() > deadline) {
      throw new Error(`no api_key invalidation of ${prefix} within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe("createApiKey", () => {
  it("[PBE-021 AC1] shows the full key once, with no-store; the row holds its prefix, last4 and HMAC, never the key", async () => {
    const tenantId = await ota();

    const res = await create(
      tenantId,
      { name: "Storefront production", kind: "secret", environment: "test", scopes: ["storefront"] },
      await bearer("owner"),
    );

    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { apiKey, key } = res.body as { apiKey: ApiKeyBody; key: string };
    expect(key).toMatch(/^sk_test_[A-Za-z0-9]{40}$/);
    expect(apiKey).toEqual({
      id: expect.stringMatching(/^key_[0-9A-HJKMNP-TV-Z]{26}$/) as string,
      name: "Storefront production",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      last4: key.slice(-4),
      allowedOrigins: [],
      scopes: ["storefront"],
      createdAt: t.clock.now().toISOString(),
      createdBy: { accountId: people.owner, fullName: "Anna Berg" },
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });

    const row = await stored(apiKey.id);
    expect(row).toMatchObject({ tenant_id: tenantId, prefix: key.slice(0, 14), last4: key.slice(-4) });
    expect(verifyApiKey(key, pepper, row?.key_hash ?? "")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(key.slice(8));

    // The list shows the key without it, and nothing logged or audited holds it.
    const list = await t.http.get(keysUrl(tenantId)).set(await bearer("owner"));
    expect(list.status).toBe(200);
    expectResponseToMatch("listApiKeys", list, { document: "platform" });
    expect(list.body).toEqual({ data: [apiKey] });
    expect(JSON.stringify(list.body)).not.toContain(key);
    const audits = await auditRows(apiKey.id);
    expect(audits).toEqual([
      {
        action: "api_key.created",
        actor_type: "account",
        actor_account_id: people.owner,
        target_type: "api_key",
        target_id: apiKey.id,
        tenant_id: tenantId,
        details: { prefix: apiKey.prefix, kind: "secret", environment: "test", scopes: ["storefront"] },
      },
    ]);
    expect(JSON.stringify(t.logs.lines)).not.toContain(key.slice(8));
    expect(t.logs.lines.length).toBeGreaterThan(0);
  });

  it("gives a secret key the storefront scope by default, and a publishable key its origins and no scopes", async () => {
    const tenantId = await ota();

    const secret = await created(tenantId, { name: "Server", kind: "secret", environment: "test" });
    const publishable = await created(tenantId, {
      name: "Website",
      kind: "publishable",
      environment: "test",
      allowedOrigins: ["https://www.acme-travel.example.com", "http://localhost:5173"],
    });
    const expiring = await created(tenantId, {
      name: "Automation",
      kind: "secret",
      environment: "test",
      scopes: ["console:automation", "bookings:read", "queues:read"],
      expiresAt: new Date(t.clock.now().getTime() + 30 * 24 * HOUR_MS).toISOString(),
    });

    expect(secret.apiKey).toMatchObject({ kind: "secret", scopes: ["storefront"], allowedOrigins: [] });
    expect(secret.key).toMatch(/^sk_test_/);
    expect(publishable.apiKey).toMatchObject({
      kind: "publishable",
      prefix: publishable.key.slice(0, 14),
      scopes: [],
      allowedOrigins: ["https://www.acme-travel.example.com", "http://localhost:5173"],
      createdBy: { accountId: people.admin, fullName: "Ben Admin" },
    });
    expect(publishable.key).toMatch(/^pk_test_/);
    expect(expiring.apiKey).toMatchObject({
      scopes: ["console:automation", "bookings:read", "queues:read"],
      expiresAt: new Date(t.clock.now().getTime() + 30 * 24 * HOUR_MS).toISOString(),
    });
  });

  it("[PBE-021 AC2] answers VALIDATION_FAILED for a publishable key with https://*.acme.com and for a secret key with permissions but no console:automation", async () => {
    const tenantId = await ota();

    const wildcard = await create(tenantId, {
      name: "Website",
      kind: "publishable",
      environment: "test",
      allowedOrigins: ["https://*.acme.com"],
    });
    const permissions = await create(tenantId, {
      name: "Back office",
      kind: "secret",
      environment: "test",
      scopes: ["console", "bookings:read"],
    });

    expect([wildcard.status, errorOf(wildcard)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(wildcard.body).toMatchObject({
      error: { fieldErrors: [{ path: "/allowedOrigins/0", code: "wildcard" }] },
    });
    expect([permissions.status, errorOf(permissions)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(permissions.body).toMatchObject({
      error: { fieldErrors: [{ path: "/scopes", code: "scopeCombination" }] },
    });
    expect(await countKeys(tenantId)).toBe(0);
  });

  it("refuses the other broken rules with field errors, before writing anything", async () => {
    const tenantId = await ota();
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [
        { kind: "publishable", allowedOrigins: ["http://localhost:5173"], environment: "live" },
        "/allowedOrigins/0",
        "insecureOrigin",
      ],
      [
        { kind: "publishable", allowedOrigins: ["https://Acme.example.com"] },
        "/allowedOrigins/0",
        "notCanonical",
      ],
      [
        { kind: "publishable", allowedOrigins: ["https://acme.example.com/"] },
        "/allowedOrigins/0",
        "pattern",
      ],
      [{ kind: "publishable", scopes: ["storefront"] }, "/scopes", "notAllowed"],
      [{ kind: "secret", allowedOrigins: ["https://acme.example.com"] }, "/allowedOrigins", "notAllowed"],
      [{ kind: "secret", scopes: ["storefront", "console"] }, "/scopes", "scopeCombination"],
      [{ kind: "secret", scopes: ["console:automation"] }, "/scopes", "scopeCombination"],
      [{ kind: "secret", scopes: ["console", "everything:write"] }, "/scopes/1", "unknownScope"],
      [
        { kind: "secret", expiresAt: new Date(t.clock.now().getTime() - 1000).toISOString() },
        "/expiresAt",
        "past",
      ],
    ];
    for (const [body, path, code] of cases) {
      // A live publishable key is refused for its origin before the tenant's live mode is looked at.
      const res = await create(tenantId, { name: "Key", environment: "test", ...body });

      expect([res.status, errorOf(res)], JSON.stringify(body)).toEqual([400, "VALIDATION_FAILED"]);
      expect(res.body, JSON.stringify(body)).toMatchObject({ error: { fieldErrors: [{ path, code }] } });
    }
    expect(await countKeys(tenantId)).toBe(0);
  });

  it("[PBE-021 AC5] counts only keys that are neither revoked nor expired against plans.limits.apiKeys", async () => {
    const plan = await insertPlan(pool, {
      limits: { staffSeats: 5, apiKeys: 2, customDomains: 0, liveMode: false },
    });
    const tenantId = await ota({ plan_code: plan.code });

    const first = await created(tenantId);
    const expiring = await created(tenantId, {
      name: "Short-lived",
      kind: "secret",
      environment: "test",
      expiresAt: new Date(t.clock.now().getTime() + HOUR_MS).toISOString(),
    });
    const third = await create(tenantId, { name: "Third", kind: "secret", environment: "test" });

    expect([third.status, errorOf(third)]).toEqual([422, "PLAN_LIMIT_REACHED"]);
    expect(third.body).toMatchObject({ error: { details: { limit: 2, used: 2 } } });

    // A revoked key frees its place.
    const revoked = await t.http
      .post(`${keysUrl(tenantId)}/${first.apiKey.id}/revoke`)
      .set(await bearer("admin"));
    expect(revoked.status).toBe(200);
    await created(tenantId, { name: "Replacement", kind: "secret", environment: "test" });
    expect((await create(tenantId, { name: "Fourth", kind: "secret", environment: "test" })).status).toBe(
      422,
    );

    // So does an expired one, once its expiry has passed.
    t.clock.advance(HOUR_MS + 1000);
    const afterExpiry = await created(tenantId, {
      name: "After expiry",
      kind: "secret",
      environment: "test",
    });
    expect(afterExpiry.apiKey.id).not.toBe(expiring.apiKey.id);
    expect(await countKeys(tenantId)).toBe(4);
  });

  it("lets only one of two concurrent creations take the last free key", async () => {
    const plan = await insertPlan(pool, {
      limits: { staffSeats: 5, apiKeys: 1, customDomains: 0, liveMode: false },
    });
    const tenantId = await ota({ plan_code: plan.code });
    const headers = await bearer("admin");

    const answers = await Promise.all(
      ["One", "Two"].map((name) => create(tenantId, { name, kind: "secret", environment: "test" }, headers)),
    );

    expect(answers.map((res) => res.status).sort()).toEqual([201, 422]);
    expect(await countKeys(tenantId)).toBe(1);
  });

  it("answers 409 TENANT_NOT_ACTIVE for an OTA that is not active, and 422 LIVE_MODE_NOT_ENABLED before go-live", async () => {
    const suspended = await ota({ status: "suspended", suspension_reason: "billing" });
    const testOnly = await ota();

    const refused = await create(suspended, { name: "Key", kind: "secret", environment: "test" });
    const live = await create(testOnly, { name: "Live", kind: "publishable", environment: "live" });

    expect([refused.status, errorOf(refused)]).toEqual([409, "TENANT_NOT_ACTIVE"]);
    expect(refused.body).toMatchObject({ error: { details: { status: "suspended" } } });
    expect([live.status, errorOf(live)]).toEqual([422, "LIVE_MODE_NOT_ENABLED"]);
    // A suspended OTA's keys stay readable.
    const list = await t.http.get(keysUrl(suspended)).set(await bearer("owner"));
    expect([list.status, list.body]).toEqual([200, { data: [] }]);
  });

  it("creates live keys once the OTA is live; a live secret key needs a TOTP step-up within 15 minutes", async () => {
    const tenantId = await ota({ storefront_environment: "live", live_enabled_at: t.clock.now() });
    const body = { name: "Live server", kind: "secret", environment: "live" };

    const publishable = await create(tenantId, {
      name: "Live site",
      kind: "publishable",
      environment: "live",
    });
    const withoutStepUp = await create(tenantId, body, await bearer("owner"));
    const staleStepUp = await create(
      tenantId,
      body,
      await bearer("owner", { amr: ["pwd", "otp"], mfa_at: nowSeconds() - 16 * 60 }),
    );
    const withoutMfa = await create(tenantId, body, await steppedUp("admin"));
    const stepped = await create(tenantId, body, await steppedUp("owner"));

    expect(publishable.status).toBe(201);
    expect((publishable.body as { key: string }).key).toMatch(/^pk_live_/);
    expect([withoutStepUp.status, errorOf(withoutStepUp)]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([staleStepUp.status, errorOf(staleStepUp)]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([withoutMfa.status, errorOf(withoutMfa)]).toEqual([403, "MFA_REQUIRED"]);
    expect(stepped.status).toBe(201);
    expect((stepped.body as { key: string }).key).toMatch(/^sk_live_/);
    expect(await countKeys(tenantId)).toBe(2);
  });

  it("checks the step-up of a live secret key with one database connection, when all others of the API are busy", async () => {
    const tenantId = await ota({ storefront_environment: "live", live_enabled_at: t.clock.now() });
    const headers = await steppedUp("owner");

    const createdLive = await withOneFreeConnection(() =>
      create(tenantId, { name: "Live server", kind: "secret", environment: "live" }, headers),
    );
    expect(createdLive.status, JSON.stringify(createdLive.body)).toBe(201);
    const { apiKey } = createdLive.body as { apiKey: ApiKeyBody };
    const rolled = await withOneFreeConnection(() =>
      t.http
        .post(`${keysUrl(tenantId)}/${apiKey.id}/roll`)
        .set(headers)
        .send({ expireOldIn: "now" }),
    );

    expect(rolled.status, JSON.stringify(rolled.body)).toBe(201);
    expectResponseToMatch("rollApiKey", rolled, { document: "platform" });
    answeredKeys.push((rolled.body as { key: string }).key);
    expect(await countKeys(tenantId)).toBe(2);
  });

  it("is for owners and admins of the OTA only", async () => {
    const tenantId = await ota();
    const body = { name: "Key", kind: "secret", environment: "test" };

    const agent = await create(tenantId, body, await bearer("agent"));
    const stranger = await create(tenantId, body, await bearer("stranger"));
    const listByAgent = await t.http.get(keysUrl(tenantId)).set(await bearer("agent"));

    expect([agent.status, errorOf(agent)]).toEqual([403, "FORBIDDEN"]);
    expect([stranger.status, errorOf(stranger)]).toEqual([404, "NOT_FOUND"]);
    expect(listByAgent.status).toBe(403);
    expectResponseToMatch("listApiKeys", listByAgent, { document: "platform" });
    expect(await countKeys(tenantId)).toBe(0);
  });
});

describe("listApiKeys", () => {
  it("lists newest first, filters by environment, and shows revoked keys only with includeRevoked", async () => {
    const tenantId = await ota({ storefront_environment: "live", live_enabled_at: t.clock.now() });
    const old = await created(tenantId, { name: "Old", kind: "secret", environment: "test" });
    t.clock.advance(1000);
    const live = await created(tenantId, { name: "Live site", kind: "publishable", environment: "live" });
    t.clock.advance(1000);
    const newest = await created(tenantId, { name: "Newest", kind: "publishable", environment: "test" });
    await t.http.post(`${keysUrl(tenantId)}/${old.apiKey.id}/revoke`).set(await bearer("admin"));
    // A key of provisioning has no creator.
    await insertRow(pool, "api_keys", {
      id: testId("key", 900),
      tenant_id: tenantId,
      name: "Initial test key (secret)",
      kind: "secret",
      environment: "test",
      prefix: "sk_test_Init00",
      key_hash: "0".repeat(64),
      last4: "Ab12",
      scopes: ["storefront"],
      created_at: new Date(t.clock.now().getTime() - 24 * HOUR_MS),
    });
    const headers = await bearer("owner");

    const all = await t.http.get(keysUrl(tenantId)).set(headers);
    const test = await t.http.get(keysUrl(tenantId)).query({ environment: "test" }).set(headers);
    const withRevoked = await t.http
      .get(keysUrl(tenantId))
      .query({ includeRevoked: true, environment: "test" })
      .set(headers);

    for (const res of [all, test, withRevoked]) {
      expect(res.status).toBe(200);
      expectResponseToMatch("listApiKeys", res, { document: "platform" });
    }
    const names = (res: { body: unknown }): string[] =>
      (res.body as { data: ApiKeyBody[] }).data.map((key) => key.name);
    expect(names(all)).toEqual(["Newest", "Live site", "Initial test key (secret)"]);
    expect(names(test)).toEqual(["Newest", "Initial test key (secret)"]);
    expect(names(withRevoked)).toEqual(["Newest", "Old", "Initial test key (secret)"]);
    expect((all.body as { data: ApiKeyBody[] }).data[2]?.createdBy).toBeNull();
    expect(live.apiKey.environment).toBe("live");
    expect(newest.apiKey.environment).toBe("test");
  });
});

describe("updateApiKey", () => {
  it("renames a key and changes a publishable key's origins, with an audit row and an api_key invalidation", async () => {
    const tenantId = await ota();
    const { apiKey } = await created(tenantId, {
      name: "Website",
      kind: "publishable",
      environment: "test",
      allowedOrigins: ["https://www.acme-travel.example.com"],
    });

    const res = await t.http
      .patch(`${keysUrl(tenantId)}/${apiKey.id}`)
      .set(await bearer("owner"))
      .send({
        name: "Website and booking",
        allowedOrigins: ["https://www.acme-travel.example.com", "https://book.acme-travel.example.com"],
      });

    expect(res.status).toBe(200);
    expectResponseToMatch("updateApiKey", res, { document: "platform" });
    expect(res.body).toEqual({
      ...apiKey,
      name: "Website and booking",
      allowedOrigins: ["https://www.acme-travel.example.com", "https://book.acme-travel.example.com"],
    });
    expect((await invalidationOf(apiKey.prefix)).event).toEqual({
      v: 1,
      type: "api_key",
      prefix: apiKey.prefix,
    });
    expect((await auditRows(apiKey.id)).map(({ action, details }) => ({ action, details }))).toEqual([
      expect.objectContaining({ action: "api_key.created" }),
      {
        action: "api_key.updated",
        details: {
          prefix: apiKey.prefix,
          kind: "publishable",
          environment: "test",
          scopes: [],
          before: { name: "Website", allowedOrigins: ["https://www.acme-travel.example.com"] },
          after: {
            name: "Website and booking",
            allowedOrigins: ["https://www.acme-travel.example.com", "https://book.acme-travel.example.com"],
          },
        },
      },
    ]);
  });

  it("refuses origins on a secret key and broken origins, answers 409 for a revoked key, and writes nothing for no change", async () => {
    const tenantId = await ota();
    const secret = await created(tenantId);
    const site = await created(tenantId, { name: "Site", kind: "publishable", environment: "test" });
    const headers = await bearer("admin");
    const patch = (keyId: string, body: Record<string, unknown>) =>
      t.http
        .patch(`${keysUrl(tenantId)}/${keyId}`)
        .set(headers)
        .send(body);

    const originsOnSecret = await patch(secret.apiKey.id, { allowedOrigins: ["https://acme.example.com"] });
    const wildcard = await patch(site.apiKey.id, { allowedOrigins: ["https://*.acme.example.com"] });
    const unchanged = await patch(site.apiKey.id, { name: "Site", allowedOrigins: [] });
    await t.http.post(`${keysUrl(tenantId)}/${secret.apiKey.id}/revoke`).set(headers);
    const revoked = await patch(secret.apiKey.id, { name: "Renamed" });

    for (const res of [originsOnSecret, wildcard, unchanged, revoked]) {
      expectResponseToMatch("updateApiKey", res, { document: "platform" });
    }
    expect([originsOnSecret.status, errorOf(originsOnSecret)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(originsOnSecret.body).toMatchObject({
      error: { fieldErrors: [{ path: "/allowedOrigins", code: "notAllowed" }] },
    });
    expect([wildcard.status, errorOf(wildcard)]).toEqual([400, "VALIDATION_FAILED"]);
    expect([unchanged.status, unchanged.body]).toEqual([200, site.apiKey]);
    expect([revoked.status, errorOf(revoked)]).toEqual([409, "CONFLICT"]);
    expect(revoked.body).toMatchObject({ error: { details: { reason: "revoked" } } });
    expect((await auditRows(site.apiKey.id)).map(({ action }) => action)).toEqual(["api_key.created"]);
  });
});

describe("rollApiKey", () => {
  it("[PBE-021 AC4] rolls with 24h: a new key with the same settings, shown once, and the old key's expires_at 24 hours ahead", async () => {
    const tenantId = await ota();
    const old = await created(tenantId, {
      name: "Automation",
      kind: "secret",
      environment: "test",
      scopes: ["console:automation", "bookings:read"],
    });
    t.clock.advance(HOUR_MS);
    const rolledAt = t.clock.now();

    const res = await t.http
      .post(`${keysUrl(tenantId)}/${old.apiKey.id}/roll`)
      .set(await bearer("owner"))
      .send({ expireOldIn: "24h" });

    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectResponseToMatch("rollApiKey", res, { document: "platform" });
    const rolled = res.body as {
      apiKey: ApiKeyBody;
      key: string;
      previous: { id: string; expiresAt: string };
    };
    answeredKeys.push(rolled.key);
    const expiresAt = new Date(rolledAt.getTime() + 24 * HOUR_MS).toISOString();
    expect(rolled.previous).toEqual({ id: old.apiKey.id, expiresAt });
    expect(rolled.key).toMatch(/^sk_test_[A-Za-z0-9]{40}$/);
    expect(rolled.key).not.toBe(old.key);
    expect(rolled.apiKey).toMatchObject({
      name: "Automation",
      kind: "secret",
      environment: "test",
      prefix: rolled.key.slice(0, 14),
      scopes: ["console:automation", "bookings:read"],
      allowedOrigins: [],
      createdBy: { accountId: people.owner, fullName: "Anna Berg" },
      expiresAt: null,
      revokedAt: null,
    });
    expect((await stored(old.apiKey.id))?.expires_at?.toISOString()).toBe(expiresAt);
    const delivery = await invalidationOf(old.apiKey.prefix);
    expect(delivery.event).toEqual({ v: 1, type: "api_key", prefix: old.apiKey.prefix });
    expect(delivery.row?.expires_at?.toISOString()).toBe(expiresAt);
    expect((await auditRows(old.apiKey.id)).at(-1)).toMatchObject({
      action: "api_key.rolled",
      actor_account_id: people.owner,
      details: {
        prefix: old.apiKey.prefix,
        kind: "secret",
        environment: "test",
        scopes: ["console:automation", "bookings:read"],
        newKeyId: rolled.apiKey.id,
        newPrefix: rolled.apiKey.prefix,
        before: { expiresAt: null },
        after: { expiresAt },
      },
    });
  });

  it("expires the old key now, never extends an earlier expiry, and refuses a revoked key", async () => {
    const tenantId = await ota();
    const headers = await bearer("admin");
    const roll = (keyId: string, expireOldIn: string) =>
      t.http
        .post(`${keysUrl(tenantId)}/${keyId}/roll`)
        .set(headers)
        .send({ expireOldIn });
    const now = await created(tenantId, { name: "Now", kind: "publishable", environment: "test" });
    const soon = await created(tenantId, {
      name: "Soon",
      kind: "secret",
      environment: "test",
      expiresAt: new Date(t.clock.now().getTime() + HOUR_MS).toISOString(),
    });
    const gone = await created(tenantId);
    await t.http.post(`${keysUrl(tenantId)}/${gone.apiKey.id}/revoke`).set(headers);

    const rolledNow = await roll(now.apiKey.id, "now");
    const rolledSoon = await roll(soon.apiKey.id, "7d");
    const rolledGone = await roll(gone.apiKey.id, "1h");

    expect(rolledNow.status).toBe(201);
    expect((rolledNow.body as { previous: unknown }).previous).toEqual({
      id: now.apiKey.id,
      expiresAt: t.clock.now().toISOString(),
    });
    expect((rolledSoon.body as { previous: unknown }).previous).toEqual({
      id: soon.apiKey.id,
      expiresAt: soon.apiKey.expiresAt,
    });
    expect([rolledGone.status, errorOf(rolledGone)]).toEqual([409, "CONFLICT"]);
    expectResponseToMatch("rollApiKey", rolledGone, { document: "platform" });
    for (const res of [rolledNow, rolledSoon]) {
      answeredKeys.push((res.body as { key: string }).key);
    }
  });

  it("needs room for both keys while the old one keeps working; rolling with now needs none", async () => {
    const plan = await insertPlan(pool, {
      limits: { staffSeats: 5, apiKeys: 1, customDomains: 0, liveMode: false },
    });
    const tenantId = await ota({ plan_code: plan.code });
    const { apiKey } = await created(tenantId);
    const headers = await bearer("admin");

    const later = await t.http
      .post(`${keysUrl(tenantId)}/${apiKey.id}/roll`)
      .set(headers)
      .send({ expireOldIn: "1h" });
    const now = await t.http
      .post(`${keysUrl(tenantId)}/${apiKey.id}/roll`)
      .set(headers)
      .send({ expireOldIn: "now" });

    expect([later.status, errorOf(later)]).toEqual([422, "PLAN_LIMIT_REACHED"]);
    expect(later.body).toMatchObject({ error: { details: { limit: 1, used: 1 } } });
    expectResponseToMatch("rollApiKey", later, { document: "platform" });
    expect(now.status).toBe(201);
    answeredKeys.push((now.body as { key: string }).key);
  });

  it("replaces a working key with now even over the plan's limit, but rolls an expired key only within it", async () => {
    const limits = (apiKeys: number) => ({ staffSeats: 5, apiKeys, customDomains: 0, liveMode: false });
    const plan = await insertPlan(pool, { limits: limits(2) });
    const tenantId = await ota({ plan_code: plan.code });
    const working = await created(tenantId);
    const expiring = await created(tenantId, {
      name: "Short-lived",
      kind: "secret",
      environment: "test",
      expiresAt: new Date(t.clock.now().getTime() + HOUR_MS).toISOString(),
    });
    // A downgrade leaves the OTA with two keys that count on a plan that allows one.
    await pool.query("UPDATE platform.plans SET limits = $1 WHERE code = $2", [
      JSON.stringify(limits(1)),
      plan.code,
    ]);
    // A token signed for each call: the clock moves past the access token's lifetime below.
    const roll = async (keyId: string, expireOldIn: string) =>
      t.http
        .post(`${keysUrl(tenantId)}/${keyId}/roll`)
        .set(await bearer("admin"))
        .send({ expireOldIn });

    const later = await roll(working.apiKey.id, "1h");
    // A leaked key can still be replaced: the old key stops counting as the new one starts.
    const now = await roll(working.apiKey.id, "now");
    t.clock.advance(HOUR_MS + 1000);
    // An expired key counts no more, so its roll adds a key and needs room.
    const expired = await roll(expiring.apiKey.id, "now");

    for (const res of [later, now, expired]) {
      expectResponseToMatch("rollApiKey", res, { document: "platform" });
    }
    expect([later.status, errorOf(later)]).toEqual([422, "PLAN_LIMIT_REACHED"]);
    expect(later.body).toMatchObject({ error: { details: { limit: 1, used: 2 } } });
    expect(now.status, JSON.stringify(now.body)).toBe(201);
    answeredKeys.push((now.body as { key: string }).key);
    expect([expired.status, errorOf(expired)]).toEqual([422, "PLAN_LIMIT_REACHED"]);
    expect(expired.body).toMatchObject({ error: { details: { limit: 1, used: 1 } } });
    expect(await countKeys(tenantId)).toBe(3);
  });

  it("needs a step-up for a live secret key, and answers 404 for a key of another OTA", async () => {
    const tenantId = await ota({ storefront_environment: "live", live_enabled_at: t.clock.now() });
    const other = await ota();
    const live = (
      await create(tenantId, { name: "Live", kind: "secret", environment: "live" }, await steppedUp("owner"))
    ).body as { apiKey: ApiKeyBody };

    const withoutStepUp = await t.http
      .post(`${keysUrl(tenantId)}/${live.apiKey.id}/roll`)
      .set(await bearer("owner"))
      .send({ expireOldIn: "1h" });
    const elsewhere = await t.http
      .post(`${keysUrl(other)}/${live.apiKey.id}/roll`)
      .set(await steppedUp("owner"))
      .send({ expireOldIn: "1h" });
    const stepped = await t.http
      .post(`${keysUrl(tenantId)}/${live.apiKey.id}/roll`)
      .set(await steppedUp("owner"))
      .send({ expireOldIn: "1h" });

    expect([withoutStepUp.status, errorOf(withoutStepUp)]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([elsewhere.status, errorOf(elsewhere)]).toEqual([404, "NOT_FOUND"]);
    expect(stepped.status).toBe(201);
    expect((stepped.body as { key: string }).key).toMatch(/^sk_live_/);
    answeredKeys.push((stepped.body as { key: string }).key);
  });
});

describe("revokeApiKey", () => {
  it("[PBE-021 AC3] revokes the key and publishes {type: api_key, prefix} after the commit", async () => {
    const tenantId = await ota();
    const { apiKey } = await created(tenantId);
    const revokedAt = t.clock.now().toISOString();

    const res = await t.http.post(`${keysUrl(tenantId)}/${apiKey.id}/revoke`).set(await bearer("admin"));

    expect(res.status).toBe(200);
    expectResponseToMatch("revokeApiKey", res, { document: "platform" });
    expect(res.body).toEqual({ ...apiKey, revokedAt });
    const delivery = await invalidationOf(apiKey.prefix);
    expect(delivery.event).toEqual({ v: 1, type: "api_key", prefix: apiKey.prefix });
    // Read when the event arrived: the revocation was committed before the event was sent.
    expect(delivery.row?.revoked_at?.toISOString()).toBe(revokedAt);
    expect(await stored(apiKey.id)).toMatchObject({ revoked_by_account_id: people.admin });
    expect((await auditRows(apiKey.id)).at(-1)).toEqual({
      action: "api_key.revoked",
      actor_type: "account",
      actor_account_id: people.admin,
      target_type: "api_key",
      target_id: apiKey.id,
      tenant_id: tenantId,
      details: { prefix: apiKey.prefix, kind: "secret", environment: "test", scopes: ["storefront"] },
    });
  });

  it("answers 409 CONFLICT for a key revoked already, 404 for another OTA's key, and 409 TENANT_NOT_ACTIVE when suspended", async () => {
    const tenantId = await ota();
    const other = await ota();
    const first = await created(tenantId);
    const second = await created(tenantId);
    const headers = await bearer("owner");
    const revoke = (tenant: string, keyId: string) =>
      t.http.post(`${keysUrl(tenant)}/${keyId}/revoke`).set(headers);

    await revoke(tenantId, first.apiKey.id);
    const again = await revoke(tenantId, first.apiKey.id);
    const elsewhere = await revoke(other, second.apiKey.id);
    await pool.query(
      "UPDATE platform.tenants SET status = 'suspended', suspension_reason = 'billing' WHERE id = $1",
      [tenantId],
    );
    const suspended = await revoke(tenantId, second.apiKey.id);

    for (const res of [again, elsewhere, suspended]) {
      expectResponseToMatch("revokeApiKey", res, { document: "platform" });
    }
    expect([again.status, errorOf(again)]).toEqual([409, "CONFLICT"]);
    expect(again.body).toMatchObject({ error: { details: { reason: "revoked" } } });
    expect([elsewhere.status, errorOf(elsewhere)]).toEqual([404, "NOT_FOUND"]);
    expect([suspended.status, errorOf(suspended)]).toEqual([409, "TENANT_NOT_ACTIVE"]);
    expect((await stored(second.apiKey.id))?.revoked_at).toBeNull();
  });
});

describe("the keys of a suspended OTA", () => {
  it("are read-only: update and roll answer 409 TENANT_NOT_ACTIVE and change nothing", async () => {
    const tenantId = await ota();
    const { apiKey } = await created(tenantId);
    await pool.query(
      "UPDATE platform.tenants SET status = 'suspended', suspension_reason = 'billing' WHERE id = $1",
      [tenantId],
    );
    const headers = await bearer("owner");

    const updated = await t.http
      .patch(`${keysUrl(tenantId)}/${apiKey.id}`)
      .set(headers)
      .send({ name: "Renamed" });
    const rolled = await t.http
      .post(`${keysUrl(tenantId)}/${apiKey.id}/roll`)
      .set(headers)
      .send({ expireOldIn: "now" });

    expectResponseToMatch("updateApiKey", updated, { document: "platform" });
    expectResponseToMatch("rollApiKey", rolled, { document: "platform" });
    expect([updated.status, errorOf(updated)]).toEqual([409, "TENANT_NOT_ACTIVE"]);
    expect([rolled.status, errorOf(rolled)]).toEqual([409, "TENANT_NOT_ACTIVE"]);
    expect(await stored(apiKey.id)).toMatchObject({ expires_at: null, revoked_at: null });
    expect(await countKeys(tenantId)).toBe(1);
    expect((await auditRows(apiKey.id)).map(({ action }) => action)).toEqual(["api_key.created"]);
  });
});

describe("ApiKeyGenerator on the database", () => {
  it("issues the initial test keys of provisioning: pk_test without origins, sk_test scoped storefront, by nobody, audited by the system", async () => {
    const tenantId = await ota();
    const generator = t.app.get(ApiKeyGenerator);

    const keys = await runInTransaction(t.app.get<PlatformDb>(PLATFORM_DB), (trx) =>
      generator.issueInitialTestKeys(trx, tenantId),
    );
    answeredKeys.push(keys.publishable.key, keys.secret.key);

    expect(keys.publishable.key).toMatch(/^pk_test_[A-Za-z0-9]{40}$/);
    expect(keys.secret.key).toMatch(/^sk_test_[A-Za-z0-9]{40}$/);
    for (const issued of [keys.publishable, keys.secret]) {
      const row = await stored(issued.row.id);
      expect(row).toMatchObject({ prefix: issued.key.slice(0, 14), last4: issued.key.slice(-4) });
      expect(verifyApiKey(issued.key, pepper, row?.key_hash ?? "")).toBe(true);
      expect(await auditRows(issued.row.id)).toEqual([
        {
          action: "api_key.created",
          actor_type: "system",
          actor_account_id: null,
          target_type: "api_key",
          target_id: issued.row.id,
          tenant_id: tenantId,
          details: {
            prefix: issued.row.prefix,
            kind: issued.row.kind,
            environment: "test",
            scopes: [...issued.row.scopes],
          },
        },
      ]);
    }
    const list = await t.http.get(keysUrl(tenantId)).set(await bearer("owner"));
    expect(list.status).toBe(200);
    expectResponseToMatch("listApiKeys", list, { document: "platform" });
    const listed = (list.body as { data: ApiKeyBody[] }).data
      .map(({ name, kind, environment, allowedOrigins, scopes, createdBy }) => ({
        name,
        kind,
        environment,
        allowedOrigins,
        scopes,
        createdBy,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    expect(listed).toEqual([
      {
        name: "Initial test key (publishable)",
        kind: "publishable",
        environment: "test",
        allowedOrigins: [],
        scopes: [],
        createdBy: null,
      },
      {
        name: "Initial test key (secret)",
        kind: "secret",
        environment: "test",
        allowedOrigins: [],
        scopes: ["storefront"],
        createdBy: null,
      },
    ]);
  });

  it("keeps the transaction usable when a prefix exists already, so a new key can be tried in it", async () => {
    const tenantId = await ota();
    const existing = await created(tenantId);
    const duplicateId = testId("key", 950);

    const issued = await runInTransaction(t.app.get<PlatformDb>(PLATFORM_DB), async (trx) => {
      const now = t.clock.now();
      const duplicate = await t.app.get(ApiKeysRepository).insertIfNew(trx, {
        id: duplicateId,
        tenant_id: tenantId,
        name: "Same prefix",
        kind: "secret",
        environment: "test",
        prefix: existing.apiKey.prefix,
        key_hash: "f".repeat(64),
        last4: "Zz99",
        allowed_origins: [],
        scopes: ["storefront"],
        expires_at: null,
        created_by_account_id: null,
        created_at: now,
        updated_at: now,
      });
      expect(duplicate).toBeUndefined();
      return t.app.get(ApiKeyGenerator).issue(trx, {
        tenantId,
        name: "After a collision",
        kind: "secret",
        environment: "test",
        allowedOrigins: [],
        scopes: ["storefront"],
        expiresAt: null,
        createdByAccountId: people.owner,
      });
    });
    answeredKeys.push(issued.key);

    expect(await stored(duplicateId)).toBeUndefined();
    expect(await stored(issued.row.id)).toMatchObject({ prefix: issued.key.slice(0, 14) });
    expect(await countKeys(tenantId)).toBe(2);
  });
});

describe("the keys shown once", () => {
  it("[PBE-021 AC1] appear in no row, no audit row and no log line of this file", async () => {
    expect(answeredKeys.length).toBeGreaterThan(10);
    const { rows: keyRows } = await pool.query("SELECT * FROM platform.api_keys");
    const { rows: audits } = await pool.query("SELECT * FROM platform.platform_audit_log");
    const written = JSON.stringify([keyRows, audits, t.logs.lines]);

    for (const key of answeredKeys) {
      expect(written).not.toContain(key.slice(8));
    }
  });
});
