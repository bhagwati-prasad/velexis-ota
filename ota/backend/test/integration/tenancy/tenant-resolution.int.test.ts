// Tenant resolution against PostgreSQL 16 and Redis 7 (OBE-012; OADR-0009 points 2–5, PADR-0014 point 5, db README
// §5): the API on this file's database clone and Redis database, with platform rows inserted as the platform writes
// them (as velexis_migrator, the owner of the platform tables) and read by the API as velexis_ota_app through the
// Redis caches. A probe route bound to an operation of the document (so the tenant guard runs) answers with the tenant
// context and the schema and statement timeout its TenantTx transaction ran with; a second one reads the tenant's rows
// on a pool of one connection (the pool-of-one test of db README §5). The platform's `vx:invalidate` events are
// published on this Redis server as the platform publishes them.
import { Controller, Get } from "@nestjs/common";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  type Insertable,
  type Kysely,
  type PlatformDatabase,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenApiOperation } from "../../../src/common/http/openapi-operation.decorator";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { PlatformReadRepository } from "../../../src/tenancy/platform-read.repository";
import { TenantContext, type RequestTenant } from "../../../src/tenancy/tenant-context";
import { TenantTx } from "../../../src/tenancy/tenant-tx";
import { TenancyModule, type OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { freePort } from "../../helpers/ports";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/** A priced offer id of the probe's operation (getPricedOfferFareRules: 401, 403, 503 documented). */
const PRICED_OFFER_ID = "prc_0123456789ABCDEFGHJK";
const PROBE = `/__tenants/${PRICED_OFFER_ID}`;
const OPERATION = "getPricedOfferFareRules";

interface ProbeAnswer {
  readonly tenant: RequestTenant;
  /** `current_schema()` inside the request's TenantTx transaction. */
  readonly schema: string | null;
  /** `current_setting('statement_timeout')` inside that transaction. */
  readonly statementTimeout: string | null;
}

/** The pool-of-one test's `TenantTx` over a pool of one connection, which its probe route uses while it is set. */
let poolOfOneTx: TenantTx | undefined;

@Controller("__tenants")
class TenantProbe {
  constructor(
    private readonly tenants: TenantContext,
    private readonly tx: TenantTx,
  ) {}

  @Get(":pricedOfferId")
  @OpenApiOperation("getPricedOfferFareRules")
  async get(): Promise<ProbeAnswer> {
    const tenant = this.tenants.require();
    const { schema, statementTimeout } = await this.tx.run(async (trx) => {
      const { rows } = await sql<{ schema: string | null; statementTimeout: string | null }>`
        SELECT current_schema() AS schema, current_setting('statement_timeout') AS "statementTimeout"
      `.execute(trx);
      return rows[0] ?? { schema: null, statementTimeout: null };
    });
    return { tenant, schema, statementTimeout };
  }

  /** The probe rows of the request's tenant, read on the pool of one connection (`poolOfOneTx`). */
  @Get("pool-of-one/:pricedOfferId")
  @OpenApiOperation("getPricedOfferFareRules")
  async poolOfOne(): Promise<{ tenantId: string; keys: string[] }> {
    if (poolOfOneTx === undefined) {
      throw new Error("the pool-of-one probe runs only inside its test");
    }
    const keys = await poolOfOneTx.run(async (trx) => {
      const rows = await trx
        .selectFrom("notification_templates")
        .select("key")
        .where("key", "like", "probe.%")
        .execute();
      await sql`SELECT pg_sleep(0.001)`.execute(trx);
      return rows.map((row) => row.key);
    });
    // Read after the transaction: the request's context survived the wait for the one connection.
    return { tenantId: this.tenants.require().tenantId, keys };
  }
}

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
/** velexis_migrator, the owner of the platform tables: what writes the file's tenants, domains and keys. */
let migrator: Kysely<PlatformDatabase>;

type TenantInsert = Insertable<PlatformDatabase["platform.tenants"]>;

/** Inserts a tenant as the platform does; `alpha` and `beta` have their schemas in the template database. */
async function insertTenant(key: string, values: Partial<TenantInsert> = {}): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access", ...values })
    .execute();
  return id;
}

/** Inserts a custom domain of a tenant, verified unless told otherwise. */
async function insertDomain(
  tenantId: string,
  hostname: string,
  values: { purpose?: string; verification_status?: string } = {},
): Promise<void> {
  await migrator
    .insertInto("platform.tenant_domains")
    .values({
      id: newId("dom"),
      tenant_id: tenantId,
      hostname,
      kind: "custom",
      verification_token: `velexis-verify-${newId("tok")}`,
      purpose: values.purpose ?? "storefront",
      verification_status: values.verification_status ?? "verified",
    })
    .execute();
}

/** Issues a secret key of a tenant as the platform does. */
async function issueKey(
  tenantId: string,
  environment: "test" | "live",
): Promise<{ key: string; id: string }> {
  const key = newApiKey("sk", environment);
  const id = newId("key");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id,
      tenant_id: tenantId,
      name: `Server (${environment})`,
      kind: "secret",
      environment,
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return { key, id };
}

async function setStatus(tenantId: string, status: "active" | "suspended"): Promise<void> {
  await migrator
    .updateTable("platform.tenants")
    .set({ status, suspension_reason: status === "suspended" ? "billing" : null })
    .where("id", "=", tenantId)
    .execute();
}

/** Publishes an event on `vx:invalidate` as the platform does after its commit. */
async function publish(event: InvalidationEvent): Promise<void> {
  await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
}

const probe = (server: TestApp["server"] = api.server) => request(server).get(PROBE);

let alphaId: string;
let betaId: string;
let gammaId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  alphaId = await insertTenant("alpha");
  betaId = await insertTenant("beta", { storefront_environment: "live", live_enabled_at: new Date() });
  gammaId = await insertTenant("gamma", { status: "suspended", suspension_reason: "billing" });
  await insertDomain(betaId, "book.beta-travel.example");
  await insertDomain(betaId, "pending.beta-travel.example", { verification_status: "pending" });
  await insertDomain(betaId, "failed.beta-travel.example", { verification_status: "failed" });
  await insertDomain(betaId, "api.beta-travel.example", { purpose: "api" });
  await insertDomain(gammaId, "book.gamma-travel.example");
  api = await createTestApp({
    database: db,
    redis,
    controllers: [TenantProbe],
    imports: [TenancyModule.forApi()],
  });
});

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

describe("edge requests", () => {
  it("resolve the tenant from a verified host, in the tenant's storefront environment [OBE-012 AC1] [OF-01 AC1]", async () => {
    const alpha = await probe().set(edgeHeaders("alpha.ota.example.com"));
    const betaSubdomain = await probe().set(edgeHeaders("beta.ota.example.com"));
    const betaDomain = await probe().set(edgeHeaders("book.beta-travel.example"));

    expect([alpha.status, alpha.body]).toEqual([
      200,
      {
        tenant: {
          tenantId: alphaId,
          key: "alpha",
          schemaName: "tenant_alpha",
          environment: "test",
          caller: { type: "edge", id: "edge" },
          actor: { type: "guest", id: null },
          requestId: alpha.headers["x-request-id"],
        },
        schema: "tenant_alpha",
        // TenantTx's transaction-local statement timeout (architecture §4).
        statementTimeout: "15s",
      },
    ]);
    for (const res of [betaSubdomain, betaDomain]) {
      expect([res.status, res.body.tenant.tenantId, res.body.tenant.environment, res.body.schema]).toEqual([
        200,
        betaId,
        "live",
        "tenant_beta",
      ]);
    }
  });

  it("answer 403 HOST_NOT_ALLOWED for unknown, unverified and other-purpose hosts, and custom domains of a suspended tenant", async () => {
    for (const host of [
      "zeta.ota.example.com",
      "book.unknown-travel.example",
      "pending.beta-travel.example",
      "failed.beta-travel.example",
      "api.beta-travel.example",
      "book.gamma-travel.example",
      "a.alpha.ota.example.com",
      "ota.example.com",
    ]) {
      const res = await probe().set(edgeHeaders(host));

      expect([host, res.status, res.body.error.code, res.body.error.details]).toEqual([
        host,
        403,
        "HOST_NOT_ALLOWED",
        { reason: "unknown" },
      ]);
      expectResponseToMatch(OPERATION, res);
    }
  });

  it("are refused before the request is validated (the tenant guard runs before validation)", async () => {
    const malformed = "/__tenants/not-a-priced-offer";

    const unknown = await request(api.server).get(malformed).set(edgeHeaders("zeta.ota.example.com"));
    const known = await request(api.server).get(malformed).set(edgeHeaders("alpha.ota.example.com"));

    expect([unknown.status, unknown.body.error.code]).toEqual([403, "HOST_NOT_ALLOWED"]);
    expect([known.status, known.body.error.code]).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch(OPERATION, unknown);
  });

  it("leave the routes of pending operations to their 501, without a lookup", async () => {
    const repository = api.app.get(PlatformReadRepository);
    const lookups = [vi.spyOn(repository, "tenantByKey"), vi.spyOn(repository, "tenantIdByStorefrontHost")];

    // resolveStorefrontHost is deferred: its route answers 501 through the MVP.
    const res = await request(api.server)
      .get("/v1/storefront/resolve?host=www.example.com")
      .set(edgeHeaders("nobody.ota.example.com"));

    expect([res.status, res.body.error.code]).toEqual([501, "NOT_IMPLEMENTED"]);
    for (const spy of lookups) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("answer 403 TENANT_SUSPENDED on the sub-domain of a suspended tenant, so the storefront can show it", async () => {
    const res = await probe().set(edgeHeaders("gamma.ota.example.com"));

    expect([res.status, res.body.error.code]).toEqual([403, "TENANT_SUSPENDED"]);
    expectResponseToMatch(OPERATION, res);
  });
});

describe("key requests", () => {
  it("resolve the key's tenant in the key's environment [OBE-012 AC1]", async () => {
    const test = await issueKey(alphaId, "test");
    const live = await issueKey(alphaId, "live");

    const viaTest = await probe().set("X-Api-Key", test.key);
    const viaLive = await probe().set("X-Api-Key", live.key);

    expect([viaTest.status, viaTest.body.tenant]).toEqual([
      200,
      {
        tenantId: alphaId,
        key: "alpha",
        schemaName: "tenant_alpha",
        environment: "test",
        caller: { type: "key", id: test.id },
        actor: { type: "api_key", id: test.id },
        requestId: viaTest.headers["x-request-id"],
      },
    ]);
    expect([viaLive.status, viaLive.body.tenant.environment, viaLive.body.schema]).toEqual([
      200,
      "live",
      "tenant_alpha",
    ]);
  });

  it("answer 403 TENANT_SUSPENDED for a key of a suspended tenant", async () => {
    const { key } = await issueKey(gammaId, "test");

    const res = await probe().set("X-Api-Key", key);

    expect([res.status, res.body.error.code]).toEqual([403, "TENANT_SUSPENDED"]);
    expectResponseToMatch(OPERATION, res);
  });
});

describe("suspension", () => {
  it("answers 403 TENANT_SUSPENDED within one second of the tenant invalidation [OBE-012 AC2] [OF-01 AC3]", async () => {
    const deltaId = await insertTenant("delta");
    const { key } = await issueKey(deltaId, "test");
    const host = edgeHeaders("delta.ota.example.com");
    expect((await probe().set(host)).status).toBe(200);
    expect((await probe().set("X-Api-Key", key)).status).toBe(200);

    await setStatus(deltaId, "suspended");
    // Cached: the change alone is not visible yet.
    expect((await probe().set(host)).status).toBe(200);
    const publishedAt = Date.now();
    await publish({ v: 1, type: "tenant", id: deltaId });

    await vi.waitFor(
      async () => {
        expect((await probe().set(host)).status).toBe(403);
      },
      { timeout: 1000, interval: 20 },
    );
    expect(Date.now() - publishedAt).toBeLessThan(1000);
    const edge = await probe().set(host);
    const viaKey = await probe().set("X-Api-Key", key);
    expect([edge.status, edge.body.error.code, viaKey.status, viaKey.body.error.code]).toEqual([
      403,
      "TENANT_SUSPENDED",
      403,
      "TENANT_SUSPENDED",
    ]);

    // Resumed: the same way back.
    await setStatus(deltaId, "active");
    await publish({ v: 1, type: "tenant", id: deltaId });
    // Not the criterion's bound: a generous one, well under the 60 s the cached row would otherwise live.
    await vi.waitFor(
      async () => {
        expect((await probe().set(host)).status).toBe(200);
      },
      { timeout: 5000, interval: 20 },
    );
  });

  it("is visible without an invalidation once the cached row's TTL of at most 60 s has run out [OBE-012 AC2] [OF-01 AC3]", async () => {
    const epsilonId = await insertTenant("epsilon");
    const host = edgeHeaders("epsilon.ota.example.com");
    expect((await probe().set(host)).status).toBe(200);
    const cached = redisKeys.tenant(epsilonId).key;

    const ttl = await redis.client.ttl(cached);
    await setStatus(epsilonId, "suspended");
    const stillCached = await probe().set(host);
    // The end of the TTL, without waiting for it: Redis expires the entry as it would after at most 60 s.
    await redis.client.pexpire(cached, 1);
    await vi.waitFor(async () => {
      expect(await redis.client.exists(cached)).toBe(0);
    });
    const expired = await probe().set(host);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(stillCached.status).toBe(200);
    expect([expired.status, expired.body.error.code]).toEqual([403, "TENANT_SUSPENDED"]);
  });
});

describe("the caches", () => {
  it("keep unknown hosts and tenant keys for 10 s and known ones for 60 s; a domain invalidation ends it at once [OBE-012 AC3]", async () => {
    const repository = api.app.get(PlatformReadRepository);
    const byHost = vi.spyOn(repository, "tenantIdByStorefrontHost");
    const byKey = vi.spyOn(repository, "tenantByKey");
    const unknownHost = "book.eta-travel.example";

    const first = await Promise.all([
      probe().set(edgeHeaders(unknownHost)),
      probe().set(edgeHeaders("eta.ota.example.com")),
    ]);
    const again = await Promise.all([
      probe().set(edgeHeaders(unknownHost)),
      probe().set(edgeHeaders("eta.ota.example.com")),
    ]);

    for (const res of [...first, ...again]) {
      expect([res.status, res.body.error.code]).toEqual([403, "HOST_NOT_ALLOWED"]);
    }
    expect(byHost).toHaveBeenCalledOnce();
    expect(byKey).toHaveBeenCalledOnce();
    for (const key of [redisKeys.host(unknownHost).key, redisKeys.tenantByKey("eta").key]) {
      const ttl = await redis.client.ttl(key);
      expect([key, ttl > 0 && ttl <= 10]).toEqual([key, true]);
    }
    const known = await redis.client.ttl(redisKeys.host("book.beta-travel.example").key);
    expect(known).toBeGreaterThan(10);
    expect(known).toBeLessThanOrEqual(60);

    // The platform verifies the domain and publishes it: the negative entry goes at once.
    await insertDomain(betaId, unknownHost);
    await publish({ v: 1, type: "domain", hostname: unknownHost });
    await vi.waitFor(
      async () => {
        expect((await probe().set(edgeHeaders(unknownHost))).body.tenant?.tenantId).toBe(betaId);
      },
      // Shorter than the 10 s the negative entry would otherwise live, without a tight wall-clock bound.
      { timeout: 5000, interval: 20 },
    );
  });

  it("keep an unknown API key prefix for 10 s, so a scan of keys reaches PostgreSQL once per prefix", async () => {
    const repository = api.app.get(PlatformReadRepository);
    const byPrefix = vi.spyOn(repository, "apiKeyByPrefix");
    // A well-formed key that the platform never issued, built at run time (test/helpers/api-env.ts).
    const unknown = newApiKey("sk", "test");

    const answers = [await probe().set("X-Api-Key", unknown), await probe().set("X-Api-Key", unknown)];

    for (const res of answers) {
      expect([res.status, res.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
      expectResponseToMatch(OPERATION, res);
    }
    expect(byPrefix).toHaveBeenCalledOnce();
    const ttl = await redis.client.ttl(redisKeys.apiKey(unknown.slice(0, 14)).key);
    expect(ttl > 0 && ttl <= 10).toBe(true);
  });

  it("cache rows as JSON with the ids and states only, never the key itself", async () => {
    const { key } = await issueKey(alphaId, "test");
    expect((await probe().set("X-Api-Key", key)).status).toBe(200);

    const stored = await redis.client.get(redisKeys.apiKey(key.slice(0, 14)).key);
    const tenantRow = await redis.client.get(redisKeys.tenant(alphaId).key);

    expect(JSON.parse(stored ?? "null")).toMatchObject({ v: 1, value: { prefix: key.slice(0, 14) } });
    expect(stored).not.toContain(key.slice(14));
    expect(JSON.parse(tenantRow ?? "null")).toEqual({
      v: 1,
      value: expect.objectContaining({ id: alphaId, schemaName: "tenant_alpha", status: "active" }),
    });
  });

  it("replace an entry that does not parse, reading PostgreSQL again", async () => {
    const zetaId = await insertTenant("zetaa");
    await redis.client.set(redisKeys.tenantByKey("zetaa").key, '{"v":1,"value":"not-a-tenant-id"}', "EX", 60);

    const res = await probe().set(edgeHeaders("zetaa.ota.example.com"));

    expect([res.status, res.body.tenant.tenantId]).toEqual([200, zetaId]);
    expect(JSON.parse((await redis.client.get(redisKeys.tenantByKey("zetaa").key)) ?? "null")).toEqual({
      v: 1,
      value: zetaId,
    });
    expect(api.sink.records()).toContainEqual(
      expect.objectContaining({ level: 40, msg: "platform_cache.entry_unreadable", cache: "tenantkey" }),
    );
  });
});

describe("degraded mode", () => {
  it("reads PostgreSQL directly while Redis is down", async () => {
    const noRedis = await createTestApp({
      database: db,
      controllers: [TenantProbe],
      imports: [TenancyModule.forApi()],
    });
    try {
      const repository = noRedis.app.get(PlatformReadRepository);
      const byKey = vi.spyOn(repository, "tenantByKey");

      const answers = [
        await probe(noRedis.server).set(edgeHeaders("alpha.ota.example.com")),
        await probe(noRedis.server).set(edgeHeaders("alpha.ota.example.com")),
      ];

      for (const res of answers) {
        expect([res.status, res.body.tenant.tenantId, res.body.schema]).toEqual([
          200,
          alphaId,
          "tenant_alpha",
        ]);
      }
      expect(byKey).toHaveBeenCalledTimes(2);
    } finally {
      await noRedis.close();
    }
  });

  it("answers 503 SERVICE_UNAVAILABLE when PostgreSQL cannot be reached and nothing is cached", async () => {
    const noDatabase = await createTestApp({
      redis,
      controllers: [TenantProbe],
      imports: [TenancyModule.forApi()],
      env: { DATABASE_URL: `postgres://velexis_ota_app:dummy@127.0.0.1:${await freePort()}/velexis` },
    });
    try {
      const res = await probe(noDatabase.server).set(edgeHeaders("iota.ota.example.com"));

      expect([res.status, res.body.error.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
      expectResponseToMatch(OPERATION, res);
    } finally {
      await noDatabase.close();
    }
  });
});

describe("tenant isolation", () => {
  it("never resolves a host of tenant A to tenant B, under interleaved requests", async () => {
    const { key } = await issueKey(betaId, "test");
    const calls: Array<[() => request.Test, string, string]> = [
      [() => probe().set(edgeHeaders("alpha.ota.example.com")), alphaId, "tenant_alpha"],
      [() => probe().set(edgeHeaders("beta.ota.example.com")), betaId, "tenant_beta"],
      [() => probe().set(edgeHeaders("book.beta-travel.example")), betaId, "tenant_beta"],
      [() => probe().set("X-Api-Key", key), betaId, "tenant_beta"],
    ];
    // Five rounds of eight concurrent requests, the four callers interleaved in each.
    const answers: request.Response[] = [];
    for (let round = 0; round < 5; round += 1) {
      answers.push(...(await Promise.all([...calls, ...calls].map(([call]) => call()))));
    }

    expect(answers.map((res) => [res.status, res.body.tenant.tenantId, res.body.schema])).toEqual(
      Array.from({ length: 10 }, () => calls.map(([, tenantId, schema]) => [200, tenantId, schema])).flat(),
    );
  });

  it("serves interleaved transactions and requests of two tenants on a pool of one connection, each on its own rows", async () => {
    const pool = createPool(db.urlFor("ota"), {
      applicationName: "ota-test-pool-of-one",
      logger: { error: () => undefined },
      max: 1,
    });
    try {
      const tenants = api.app.get(TenantContext);
      const tx = new TenantTx(createTenantDb(pool, { appEnv: "test" }), tenants);
      const contextOf = (tenantId: string, key: "alpha" | "beta"): RequestTenant => ({
        tenantId,
        key,
        schemaName: `tenant_${key}` as RequestTenant["schemaName"],
        environment: "test",
        caller: { type: "edge", id: "edge" },
        actor: { type: "system", id: null },
        requestId: newId("req"),
      });
      const alpha = contextOf(alphaId, "alpha");
      const beta = contextOf(betaId, "beta");
      for (const tenant of [alpha, beta]) {
        await tenants.run(tenant, () =>
          tx.run((trx) =>
            trx
              .insertInto("notification_templates")
              .values({
                id: newId("ntt"),
                key: `probe.${tenant.key}`,
                channel: "sms",
                locale: "en",
                body_text: `${tenant.key} only`,
              })
              .execute(),
          ),
        );
      }

      // 30 transactions, alternating tenants, all queued at once on the single connection.
      const order = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? alpha : beta));
      const seen = await Promise.all(
        order.map((tenant) =>
          tenants.run(tenant, () =>
            tx.run(async (trx) => {
              const rows = await trx
                .selectFrom("notification_templates")
                .select("key")
                .where("key", "like", "probe.%")
                .execute();
              await sql`SELECT pg_sleep(0.001)`.execute(trx);
              return rows.map((row) => row.key);
            }),
          ),
        ),
      );

      expect(seen).toEqual(order.map((tenant) => [`probe.${tenant.key}`]));

      // The same through HTTP: three rounds of eight concurrent requests, the two tenants' hosts alternating (eight,
      // as in the test above: Supertest adds listeners to the server per request in flight); the tenant guard resolves
      // each one, and its TenantTx transaction queues for the one connection.
      poolOfOneTx = tx;
      const hosts: ReadonlyArray<readonly [string, string, string]> = [
        ["alpha.ota.example.com", alphaId, "probe.alpha"],
        ["beta.ota.example.com", betaId, "probe.beta"],
      ];
      const round = Array.from({ length: 4 }, () => hosts).flat();
      const answers: request.Response[] = [];
      for (let index = 0; index < 3; index += 1) {
        answers.push(
          ...(await Promise.all(
            round.map(([host]) =>
              request(api.server).get(`/__tenants/pool-of-one/${PRICED_OFFER_ID}`).set(edgeHeaders(host)),
            ),
          )),
        );
      }

      expect(answers.map((res) => [res.status, res.body])).toEqual(
        [...round, ...round, ...round].map(([, tenantId, key]) => [200, { tenantId, keys: [key] }]),
      );
      // The one connection is back in the pool without a tenant: SET LOCAL ended with each transaction.
      const { rows } = await pool.query<{ path: string }>("SELECT current_setting('search_path') AS path");
      expect(rows).toEqual([{ path: "pg_catalog" }]);
    } finally {
      poolOfOneTx = undefined;
      await pool.end();
    }
  });

  it("has no tenant outside a resolved request: TenantTx refuses before any SQL", async () => {
    const tx = api.app.get(TenantTx);

    await expect(tx.run(() => Promise.resolve("never"))).rejects.toThrow(/no tenant in the request context/);
  });
});
