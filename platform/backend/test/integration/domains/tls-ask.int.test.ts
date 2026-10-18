// Caddy's TLS `ask` endpoint (PBE-027; ADR-0018, PADR-0004 item 6, api-inventory-admin.md §9, scope PF-40 and PF-42)
// through the HTTP pipeline (createTestApp) on this file's database clone and Redis database: the rules for sub-domains
// by tenant status and for custom domains by verification, tenant status, plan and switch; the loopback-only gate; the
// 60-second positive answers in Redis and the in-process refusals, both dropped by `vx:invalidate` events within a
// second; and a flood of random names that leaves no `tlsask:` key in Redis and never more than 10 000 refusals in the
// process. OTAs and domains are written with the builders, and invalidations go through the application's
// InvalidationPublisher, so they travel through Redis pub/sub to the API's subscriber like the platform's own.
//
// Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same time.
// Their events only make the subscriber forget hosts this file never asks for.
import { randomBytes } from "node:crypto";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { InvalidationPublisher } from "../../../src/common/redis/invalidation.publisher";
import { TlsAskNegativeCache } from "../../../src/domains/tls-ask.negative-cache";
import { insertPlan, insertTenantDomain } from "../../builders/platform-rows";
import { insertOta, TEST_BASE_DOMAIN, type InsertedOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

const ASK = "/internal/tls/ask";
/** How long a `domain` invalidation may take to reach the cache (PBE-027 AC3). */
const INVALIDATION_DEADLINE_MS = 1000;
/**
 * How long the checks that are no acceptance criterion wait for the subscriber (a tenant event needs a database read
 * first): more generous, so a loaded CI machine does not fail them, and still within Vitest's 5-second test timeout.
 */
const SUBSCRIBER_WAIT_MS = 4000;

let t: TestApp;
let pool: PlatformPool;
let refusals: TlsAskNegativeCache;
/** The plan with one custom domain that the OTAs with custom domains are on. */
let customPlanCode: string;

beforeAll(async () => {
  t = await createTestApp({ env: { FEATURE_CUSTOM_DOMAINS: "true" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  refusals = t.app.get(TlsAskNegativeCache);
  customPlanCode = (await insertPlan(pool, { limits: { customDomains: 1, staffSeats: 5, apiKeys: 10 } }))
    .code;
  // The database clone and the Nest module graph (Ajv compilation of the document included) are the expensive part,
  // and CI runs every package at once on 4 CPUs.
}, 60_000);

afterAll(async () => {
  await t?.close();
});

/** Caddy's question for `domain`, from loopback. */
function ask(domain: string | undefined, app: TestApp = t): Promise<Response> {
  const request = app.http.get(ASK);
  return domain === undefined ? request : request.query({ domain });
}

/** The status of the answer, after checking it against the document. */
async function answer(domain: string | undefined, app: TestApp = t): Promise<number> {
  const res = await ask(domain, app);
  expectResponseToMatch("tlsAsk", res, { document: "platform" });
  return res.status;
}

/** A verification value of the shape addDomain gives (`vx-verify-` and 32 base32 characters). */
function verificationToken(): string {
  return `vx-verify-${randomBytes(20).toString("hex").slice(0, 32).toUpperCase()}`;
}

/** An OTA (active unless `status` says otherwise) on the plan with one custom domain. */
function customOta(status = "active", app: TestApp = t, planCode = customPlanCode): Promise<InsertedOta> {
  return insertOta(app.app.get<PlatformPool>(PLATFORM_POOL), { tenant: { status, plan_code: planCode } });
}

/** A custom storefront domain of `ota`, verified unless `verification_status` says otherwise. */
async function customDomain(
  ota: InsertedOta,
  hostname: string,
  verificationStatus = "verified",
  app: TestApp = t,
): Promise<void> {
  await insertTenantDomain(app.app.get<PlatformPool>(PLATFORM_POOL), ota.tenant, {
    hostname,
    kind: "custom",
    verification_status: verificationStatus,
    verification_token: verificationToken(),
    verified_at: verificationStatus === "verified" ? new Date("2026-10-02T09:00:00Z") : null,
  });
}

/** Publishes `event` on `vx:invalidate` from the application, as the platform's services do after a commit. */
async function publish(event: InvalidationEvent): Promise<void> {
  expect(await t.app.get(InvalidationPublisher).publish(event)).toBe(true);
}

/** True while Redis holds a positive answer for `host`. */
async function cachedYes(host: string): Promise<boolean> {
  return (await t.redis.client.exists(`tlsask:${host}`)) === 1;
}

/** Every `tlsask:` key of this file's Redis database (SCAN, never KEYS). */
async function tlsAskKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await t.redis.client.scan(cursor, "MATCH", "tlsask:*", "COUNT", 1000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys.sort();
}

/** Counts the connections the API takes from its pool while `work` runs: one per database query outside a transaction. */
async function poolCheckouts(work: () => Promise<void>): Promise<number> {
  let checkouts = 0;
  const count = (): void => {
    checkouts += 1;
  };
  pool.on("acquire", count);
  try {
    await work();
  } finally {
    pool.off("acquire", count);
  }
  return checkouts;
}

describe("GET /internal/tls/ask: sub-domains", () => {
  it("[PBE-027 AC1] answers 200 for the sub-domain of an active, provisioning or suspended OTA and 404 for a failed one", async () => {
    const statuses: Record<string, number> = {};
    for (const status of ["active", "provisioning", "suspended", "failed"]) {
      const { tenant } = await insertOta(pool, { tenant: { status } });
      statuses[status] = await answer(`${tenant.key}.${TEST_BASE_DOMAIN}`);
    }

    expect(statuses).toEqual({ active: 200, provisioning: 200, suspended: 200, failed: 404 });
  });

  it("[PBE-027 AC1] answers 200 with an empty body, and reads the host case-insensitively", async () => {
    const { tenant } = await insertOta(pool);

    const res = await ask(`${tenant.key.toUpperCase()}.OTA.Example.COM`);

    expect(res.status).toBe(200);
    expect(res.text).toBe("");
    expectResponseToMatch("tlsAsk", res, { document: "platform" });
  });

  it("answers 404 for an unknown key, a host below a sub-domain, the base domain and other parents", async () => {
    const { tenant } = await insertOta(pool);

    for (const host of [
      `nobody.${TEST_BASE_DOMAIN}`,
      `www.${tenant.key}.${TEST_BASE_DOMAIN}`,
      TEST_BASE_DOMAIN,
      `${tenant.key}.ota.example.org`,
    ]) {
      expect(await answer(host), host).toBe(404);
    }
  });
});

describe("GET /internal/tls/ask: custom domains", () => {
  it("[PBE-027 AC2] answers 200 only for a verified custom domain of an active OTA whose plan has custom domains", async () => {
    const active = await customOta();
    await customDomain(active, "travel.example.net");
    await customDomain(active, "pending.example.net", "pending");
    await customDomain(active, "failed.example.net", "failed");
    const suspended = await customOta("suspended");
    await customDomain(suspended, "paused.example.net");
    // early_access, the seeded plan, has `customDomains: 0`.
    const noPlan = await insertOta(pool);
    await customDomain(noPlan, "noplan.example.net");

    expect({
      verified: await answer("travel.example.net"),
      pending: await answer("pending.example.net"),
      failed: await answer("failed.example.net"),
      suspendedTenant: await answer("paused.example.net"),
      planWithoutCustomDomains: await answer("noplan.example.net"),
      unknown: await answer("unknown.example.net"),
    }).toEqual({
      verified: 200,
      pending: 404,
      failed: 404,
      suspendedTenant: 404,
      planWithoutCustomDomains: 404,
      unknown: 404,
    });
  });

  it("[PBE-027 AC2] answers 404 to a request with X-Forwarded-For, even for a host it allows", async () => {
    const ota = await customOta();
    await customDomain(ota, "forwarded.example.net");

    const forwarded = await t.http
      .get(ASK)
      .query({ domain: "forwarded.example.net" })
      .set("X-Forwarded-For", "203.0.113.7");
    const subdomain = await t.http
      .get(ASK)
      .query({ domain: `${ota.tenant.key}.${TEST_BASE_DOMAIN}` })
      .set("X-Forwarded-For", "127.0.0.1");

    for (const res of [forwarded, subdomain]) {
      expect([res.status, (res.body as { error?: { code?: string } }).error?.code]).toEqual([
        404,
        "NOT_FOUND",
      ]);
      expectResponseToMatch("tlsAsk", res, { document: "platform" });
    }
    expect(await answer("forwarded.example.net")).toBe(200);
  });

  it("[PBE-027 AC4] answers 404 to a missing or malformed host without touching Redis or PostgreSQL", async () => {
    const host300 = `${"a".repeat(296)}.com`;
    const keysBefore = await tlsAskKeys();
    const refusalsBefore = refusals.size;

    const checkouts = await poolCheckouts(async () => {
      for (const domain of [
        host300,
        undefined,
        "",
        "192.0.2.10",
        "[2001:db8::10]",
        "localhost",
        "acme.ota.example.com.",
      ]) {
        expect(await answer(domain), String(domain).slice(0, 40)).toBe(404);
      }
      // A repeated `domain` arrives as a list: refused by the handler like any malformed value (PADR-0004 item 6), not
      // turned into a `400` by the request validation.
      const repeated = await t.http.get(`${ASK}?domain=repeated.example.net&domain=repeated.example.net`);
      expect([repeated.status, (repeated.body as { error?: { code?: string } }).error?.code]).toEqual([
        404,
        "NOT_FOUND",
      ]);
      expectResponseToMatch("tlsAsk", repeated, { document: "platform" });
    });

    expect(host300).toHaveLength(300);
    expect(checkouts).toBe(0);
    expect(await tlsAskKeys()).toEqual(keysBefore);
    expect(refusals.size).toBe(refusalsBefore);
  });
});

describe("GET /internal/tls/ask: caching and invalidation", () => {
  it("keeps a 200 in Redis for 60 seconds and answers it from there without PostgreSQL", async () => {
    const ota = await customOta();
    await customDomain(ota, "cached.example.net");

    expect(await answer("cached.example.net")).toBe(200);
    const ttl = await t.redis.client.ttl("tlsask:cached.example.net");
    const checkouts = await poolCheckouts(async () => {
      expect(await answer("cached.example.net")).toBe(200);
    });

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(checkouts).toBe(0);
  });

  it("[PBE-027 AC3] drops a cached answer on a domain invalidation within one second", async () => {
    const ota = await customOta();
    await customDomain(ota, "removed.example.net");
    expect(await answer("removed.example.net")).toBe(200);
    await pool.query("DELETE FROM platform.tenant_domains WHERE hostname = $1", ["removed.example.net"]);
    // Still cached: the row is gone, but nothing told the API yet.
    expect(await answer("removed.example.net")).toBe(200);

    await publish({ v: 1, type: "domain", hostname: "removed.example.net" });

    await vi.waitFor(async () => expect(await cachedYes("removed.example.net")).toBe(false), {
      timeout: INVALIDATION_DEADLINE_MS,
      interval: 10,
    });
    expect(await answer("removed.example.net")).toBe(404);
  });

  it("[PBE-027 AC3] accepts a host refused a moment before right after its domain is verified", async () => {
    const ota = await customOta();
    await customDomain(ota, "fresh.example.net", "pending");
    expect(await answer("fresh.example.net")).toBe(404);
    expect(refusals.has("fresh.example.net")).toBe(true);
    await pool.query(
      "UPDATE platform.tenant_domains SET verification_status = 'verified', verified_at = now() WHERE hostname = $1",
      ["fresh.example.net"],
    );
    // Still refused from the process's cache: the domain job publishes the event after its commit.
    expect(await answer("fresh.example.net")).toBe(404);

    await publish({ v: 1, type: "domain", hostname: "fresh.example.net" });

    await vi.waitFor(async () => expect(await answer("fresh.example.net")).toBe(200), {
      timeout: INVALIDATION_DEADLINE_MS,
      interval: 10,
    });
  });

  it("forgets every host of an OTA on its tenant invalidation", async () => {
    const ota = await customOta();
    await customDomain(ota, "suspend-me.example.net");
    const subdomain = `${ota.tenant.key}.${TEST_BASE_DOMAIN}`;
    expect(await answer("suspend-me.example.net")).toBe(200);
    expect(await answer(subdomain)).toBe(200);
    const failed = await customOta("failed");
    const failedSubdomain = `${failed.tenant.key}.${TEST_BASE_DOMAIN}`;
    expect(await answer(failedSubdomain)).toBe(404);

    await pool.query("UPDATE platform.tenants SET status = 'suspended' WHERE id = $1", [ota.tenant.id]);
    await pool.query("UPDATE platform.tenants SET status = 'provisioning' WHERE id = $1", [failed.tenant.id]);
    await publish({ v: 1, type: "tenant", id: ota.tenant.id });
    await publish({ v: 1, type: "tenant", id: failed.tenant.id });

    await vi.waitFor(
      async () => {
        expect(await answer("suspend-me.example.net")).toBe(404);
        expect(await answer(failedSubdomain)).toBe(200);
      },
      { timeout: SUBSCRIBER_WAIT_MS, interval: 10 },
    );
    // A suspended OTA keeps its sub-domain, so its "suspended" page is served over HTTPS.
    expect(await answer(subdomain)).toBe(200);
  });

  it("subscribes at start-up and refuses a message that is not an invalidation event", async () => {
    expect(t.logs.withMessage("invalidation.subscribed")).toEqual([
      expect.objectContaining({ channel: INVALIDATION_CHANNEL }),
    ]);

    await t.redis.client.publish(INVALIDATION_CHANNEL, "{not json");
    await t.redis.client.publish(
      INVALIDATION_CHANNEL,
      JSON.stringify({ v: 1, type: "domain", hostname: "Bad Host" }),
    );

    await vi.waitFor(() => expect(t.logs.withMessage("invalidation.refused")).toHaveLength(2), {
      timeout: SUBSCRIBER_WAIT_MS,
      interval: 10,
    });
    expect(t.logs.withMessage("invalidation.refused").map((line) => line["reason"])).toEqual([
      "malformed_json",
      "invalid_event",
    ]);
    expect(JSON.stringify(t.logs.withMessage("invalidation.refused"))).not.toContain("Bad Host");
  });
});

describe("GET /internal/tls/ask: a flood of unknown names", () => {
  /**
   * How many random hosts the flood asks for: the bound of the refusal cache, then more. An answer read while an
   * invalidation arrived is not cached, and other packages' tests may publish on `vx:invalidate` during the flood, so
   * MORE leaves a margin for refusals that never reach the cache.
   */
  const FLOOD = 10_000;
  const MORE = 1_000;
  /** Requests in flight at once, as Caddy would send them for parallel handshakes. */
  const PARALLEL = 25;

  let statuses: Map<number, number>;
  let largestRefusals = 0;
  let sizeAfterFlood = 0;
  let keysBefore: string[];
  let keysAfter: string[];

  /** Asks for every host, PARALLEL at a time, noting the statuses and the largest size of the refusal cache. */
  async function askAll(hosts: readonly string[]): Promise<void> {
    for (let start = 0; start < hosts.length; start += PARALLEL) {
      const batch = hosts.slice(start, start + PARALLEL);
      const answers = await Promise.all(batch.map((host) => ask(host)));
      for (const res of answers) {
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
      largestRefusals = Math.max(largestRefusals, refusals.size);
    }
  }

  /** Random well-formed names: half sub-domain lookups (`<key>.<base>`), half custom-domain lookups. */
  function randomHosts(count: number): string[] {
    return Array.from({ length: count }, (_value, n) => {
      const random = randomBytes(6).toString("hex");
      return n % 2 === 0 ? `f${random}.${TEST_BASE_DOMAIN}` : `${random}.flood${n % 7}.example.net`;
    });
  }

  // 11 000 requests through the whole HTTP pipeline, each with one indexed lookup in PostgreSQL: several seconds, many
  // more under a full parallel run on CI. They run once, here, with their own timeout; the tests below compare results.
  beforeAll(async () => {
    statuses = new Map();
    // The positive answers the tests above cached would expire during a flood that outlasts their 60 s: drop them
    // first, so that the SCAN after the flood must find no `tlsask:` key at all, however long it took.
    const cached = await tlsAskKeys();
    if (cached.length > 0) {
      await t.redis.client.del(...cached);
    }
    keysBefore = await tlsAskKeys();
    await askAll(randomHosts(FLOOD));
    sizeAfterFlood = refusals.size;
    await askAll(randomHosts(MORE));
    keysAfter = await tlsAskKeys();
  }, 300_000);

  it("[PBE-027 AC4] answers 404 to every random name and creates no tlsask: key in Redis", () => {
    expect(Object.fromEntries(statuses)).toEqual({ 404: FLOOD + MORE });
    expect(keysBefore).toEqual([]);
    expect(keysAfter).toEqual([]);
  });

  it("[PBE-027 AC4] never holds more than 10 000 refusals in the process", () => {
    expect(sizeAfterFlood).toBeLessThanOrEqual(10_000);
    expect(largestRefusals).toBe(10_000);
    expect(refusals.size).toBe(10_000);
  });

  it("[PBE-027 AC4] answers a 300-character host with 404 without a database query, also after the flood", async () => {
    const checkouts = await poolCheckouts(async () => {
      expect(await answer(`${"b".repeat(296)}.net`)).toBe(404);
    });

    expect(checkouts).toBe(0);
  });
});

describe("GET /internal/tls/ask with the custom_domains switch off", () => {
  let off: TestApp;

  // A second application with the default switches, on a database clone of its own. It empties this worker's Redis
  // database when it starts, which the tests above no longer need.
  beforeAll(async () => {
    off = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await off?.close();
  });

  it("[PBE-027 AC2] answers 404 for a verified custom domain while FEATURE_CUSTOM_DOMAINS is off, and 200 for sub-domains", async () => {
    const offPool = off.app.get<PlatformPool>(PLATFORM_POOL);
    const plan = await insertPlan(offPool, { limits: { customDomains: 1, staffSeats: 5, apiKeys: 10 } });
    const ota = await customOta("active", off, plan.code);
    await customDomain(ota, "switched-off.example.net", "verified", off);

    expect(await answer("switched-off.example.net", off)).toBe(404);
    expect(await answer(`${ota.tenant.key}.${TEST_BASE_DOMAIN}`, off)).toBe(200);
  });
});
