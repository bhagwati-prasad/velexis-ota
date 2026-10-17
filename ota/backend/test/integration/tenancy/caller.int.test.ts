// Caller classification against PostgreSQL 16 (OBE-011; OADR-0009 point 1, PADR-0005): the API on this file's
// database clone, with `platform.api_keys` rows inserted as the platform writes them (as velexis_migrator, the owner of
// the platform tables): `key_hash = hex(HMAC-SHA-256(pepper, key))` with the pepper file the API was started with. The
// API reads them through TenancyModule as velexis_ota_app. A probe route returns the caller the guard put in the
// request context; pending operations of the document show the envelopes against the document. The API caches the
// rows for 60 s (OBE-012): a test that changes a row publishes the `api_key` invalidation, as the platform does.
import { Controller, Get } from "@nestjs/common";
import { INVALIDATION_CHANNEL } from "@velexis/api-types/jobs";
import { hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
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
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { CallerContext, type Caller } from "../../../src/tenancy/caller-resolver";
import { PlatformReadRepository } from "../../../src/tenancy/platform-read.repository";
import { OTA_POOL, TenancyModule, type OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, testApiCredentials, withCharacterChanged } from "../../helpers/api-env";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/** A pending operation of the document (OBE-015) that documents 400, 401 and 403. */
const SEARCH_LOCATIONS = "/v1/reference/locations?keyword=par";
const ALLOWED_ORIGIN = "https://travel.example.net";

@Controller("__callers")
class CallerProbe {
  constructor(private readonly callers: CallerContext) {}

  @Get()
  get(): { caller: Caller | null } {
    return { caller: this.callers.get() ?? null };
  }
}

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
/** velexis_migrator, the owner of the platform tables: what writes the file's tenant and keys. */
let migrator: Kysely<PlatformDatabase>;
let tenantId: string;

type ApiKeyInsert = Insertable<PlatformDatabase["platform.api_keys"]>;

/** Issues a key as the platform does: a row with the prefix, the HMAC under the shared pepper and the last 4. */
async function issueKey(
  kind: "pk" | "sk",
  values: Partial<ApiKeyInsert> = {},
): Promise<{ key: string; id: string }> {
  const key = newApiKey(kind);
  const id = newId("key");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id,
      tenant_id: tenantId,
      name: kind === "pk" ? "Storefront (test)" : "Server (test)",
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...values,
    })
    .execute();
  return { key, id };
}

/**
 * Publishes the `api_key` invalidation the platform sends after it changed a key (platform architecture §6.3), and
 * waits until the API has dropped its cached row.
 */
async function invalidateKey(prefix: string): Promise<void> {
  await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify({ v: 1, type: "api_key", prefix }));
  await vi.waitFor(async () => {
    expect(await redis.client.exists(redisKeys.apiKey(prefix).key)).toBe(0);
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id: tenantId, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  api = await createTestApp({
    database: db,
    redis,
    controllers: [CallerProbe],
    imports: [TenancyModule.forApi()],
  });
});

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

describe("API keys against platform.api_keys", () => {
  it("accepts a valid sk_test key: the key's tenant, environment and scopes in the request context [OBE-011 AC2]", async () => {
    const { key, id } = await issueKey("sk", { scopes: ["console"] });

    const res = await request(api.server).get("/__callers").set("X-Api-Key", key);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      caller: {
        type: "key",
        id,
        keyId: id,
        kind: "secret",
        tenantId,
        environment: "test",
        scopes: ["console"],
      },
    });
  });

  it("refuses the same key revoked, expired or with a one-character change with 401 [OBE-011 AC2]", async () => {
    const { key, id } = await issueKey("sk");
    const before = await request(api.server).get("/__callers").set("X-Api-Key", key);
    expect(before.status).toBe(200);

    const changed = await Promise.all(
      // In the 6 secret characters of the prefix, in the middle and at the end of the secret.
      [10, 25, key.length - 1].map((index) =>
        request(api.server).get(SEARCH_LOCATIONS).set("X-Api-Key", withCharacterChanged(key, index)),
      ),
    );
    await migrator
      .updateTable("platform.api_keys")
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where("id", "=", id)
      .execute();
    await invalidateKey(key.slice(0, 14));
    const expired = await request(api.server).get(SEARCH_LOCATIONS).set("X-Api-Key", key);
    await migrator
      .updateTable("platform.api_keys")
      .set({ expires_at: null, revoked_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
    await invalidateKey(key.slice(0, 14));
    const revoked = await request(api.server).get(SEARCH_LOCATIONS).set("X-Api-Key", key);

    for (const res of [...changed, expired, revoked]) {
      expect([res.status, res.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
      expectResponseToMatch("searchLocations", res);
    }
    const reasons = api.sink
      .records()
      .filter((line) => line["msg"] === "caller.api_key_refused")
      .map((line) => line["reason"]);
    expect(reasons).toEqual(expect.arrayContaining(["unknown", "hash_mismatch", "expired", "revoked"]));
    expect(api.sink.text()).not.toContain(key.slice(14));
  });

  it("accepts a key whose expiry is still ahead (a rolled key in its grace period)", async () => {
    const { key } = await issueKey("sk", { expires_at: new Date(Date.now() + 3_600_000) });

    const res = await request(api.server).get("/__callers").set("X-Api-Key", key);

    expect([res.status, res.body.caller.type]).toEqual([200, "key"]);
  });

  it("refuses a pk_ key from a non-listed origin with 403 and accepts it from a listed one [OBE-011 AC2]", async () => {
    const { key } = await issueKey("pk", { allowed_origins: [ALLOWED_ORIGIN] });

    const foreign = await request(api.server)
      .get(SEARCH_LOCATIONS)
      .set({ "X-Api-Key": key, Origin: "https://evil.example.com" });
    const listed = await request(api.server)
      .get("/__callers")
      .set({ "X-Api-Key": key, Origin: ALLOWED_ORIGIN });
    const server = await request(api.server).get("/__callers").set("X-Api-Key", key);

    expect([foreign.status, foreign.body.error.code]).toEqual([403, "ORIGIN_NOT_ALLOWED"]);
    expectResponseToMatch("searchLocations", foreign);
    expect([listed.status, listed.body.caller.kind]).toEqual([200, "publishable"]);
    expect([server.status, server.body.caller.kind]).toEqual([200, "publishable"]);
  });

  it("cannot hold a row whose prefix contradicts its environment: the baseline CHECK backs the verifier's check", async () => {
    await expect(issueKey("sk", { prefix: newApiKey("sk", "live").slice(0, 14) })).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("reads the row by prefix as velexis_ota_app, unknown prefixes as null and malformed ones without a query", async () => {
    const { key, id } = await issueKey("pk", { allowed_origins: [ALLOWED_ORIGIN] });
    const repository = api.app.get(PlatformReadRepository);
    const pool = api.app.get<string, OtaPool>(OTA_POOL);

    await expect(repository.apiKeyByPrefix(key.slice(0, 14))).resolves.toEqual({
      id,
      tenantId,
      kind: "publishable",
      environment: "test",
      prefix: key.slice(0, 14),
      keyHash: hashApiKey(key, testApiCredentials().pepper),
      allowedOrigins: [ALLOWED_ORIGIN],
      scopes: [],
      expiresAt: null,
      revokedAt: null,
    });
    await expect(repository.apiKeyByPrefix("pk_test_000000")).resolves.toBeNull();
    const connect = vi.spyOn(pool, "connect");
    await expect(repository.apiKeyByPrefix("pk_test_00000'")).resolves.toBeNull();
    await expect(repository.apiKeyByPrefix(key)).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("the storefront edge", () => {
  it("answers a wrong edge secret with 401 without any database query [OBE-011 AC1]", async () => {
    const repository = api.app.get(PlatformReadRepository);
    const pool = api.app.get<string, OtaPool>(OTA_POOL);
    const lookups = [
      vi.spyOn(repository, "apiKeyByPrefix"),
      vi.spyOn(repository, "tenantById"),
      vi.spyOn(repository, "tenantByKey"),
      vi.spyOn(pool, "connect"),
      vi.spyOn(pool, "query"),
    ];
    const secret = testApiCredentials().edgeSecret;
    const wrong = `${secret.slice(0, -1)}${secret.endsWith("0") ? "1" : "0"}`;

    const res = await request(api.server)
      .get(SEARCH_LOCATIONS)
      .set({ "X-Velexis-Edge": wrong, "X-Velexis-Host": "alpha.ota.example.com" });

    expect([res.status, res.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
    expectResponseToMatch("searchLocations", res);
    for (const spy of lookups) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("answers the edge header together with X-Api-Key with 400, even with a valid key [OBE-011 AC3]", async () => {
    const { key } = await issueKey("sk");

    const res = await request(api.server).get(SEARCH_LOCATIONS).set(edgeHeaders()).set("X-Api-Key", key);

    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([
      400,
      "INVALID_REQUEST",
      { reason: "edge_with_api_key" },
    ]);
    expectResponseToMatch("searchLocations", res);
  });

  it("classifies the right secret as the edge caller of the host", async () => {
    const res = await request(api.server).get("/__callers").set(edgeHeaders("alpha.ota.example.com"));

    expect(res.body).toEqual({ caller: { type: "edge", id: "edge", host: "alpha.ota.example.com" } });
  });
});

describe("requests without a credential", () => {
  it("answer 401 on an operation and pass /health/ready on a direct local connection", async () => {
    const operation = await request(api.server).get(SEARCH_LOCATIONS);
    const ready = await request(api.server).get("/health/ready");
    const proxied = await request(api.server).get("/health/ready").set("X-Forwarded-For", "203.0.113.7");

    expect([operation.status, operation.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
    expect(ready.status).toBe(200);
    expect([proxied.status, proxied.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
  });
});
