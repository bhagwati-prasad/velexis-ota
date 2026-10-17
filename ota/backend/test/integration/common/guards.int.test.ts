// The scope guard, the CSRF guard, the rate limits and the key-usage counter in the API's pipeline (OBE-013;
// architecture §3 steps 7–10 and §8, OADR-0006 point 3, OADR-0009 point 6), against PostgreSQL 16 and Redis 7: the API
// on this file's database clone and Redis database, with a tenant and its API keys inserted as the platform writes
// them (as velexis_migrator) and read by the API through the platform caches. Probe routes are bound to operations of
// the document, so every guard applies to them as to the real handlers; they answer with the request's scope.
//
// Edge requests come "through Caddy": `X-Forwarded-For` carries the client address, which Express takes as `req.ip`
// from the loopback peer (`trust proxy loopback`). Addresses are documentation ranges (RFC 5737, RFC 3849); every test
// uses its own, so the rate-limit buckets of one test never meet another's.
import { randomUUID } from "node:crypto";
import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  type Insertable,
  type Kysely,
  type PlatformDatabase,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import type { Redis } from "ioredis";
import { ClsService } from "nestjs-cls";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Clock } from "../../../src/common/clock";
import { OpenApiOperation } from "../../../src/common/http/openapi-operation.decorator";
import { trackerDigest } from "../../../src/common/http/rate-limits";
import { RequestContext } from "../../../src/common/http/request-context";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { REDIS_CLIENT } from "../../../src/common/redis/redis.module";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import {
  edgeHeaders,
  edgeWriteHeaders,
  newApiKey,
  newCsrfToken,
  testApiCredentials,
} from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const HOST = "alpha.ota.example.com";
const CHECKOUT_ID = "chk_01JA2Z9W5K7Q3M8N4P6R";

/** The document's SIMPLE-mode example of flights.search. */
const SEARCH = {
  mode: "simple",
  originLocationCode: "PAR",
  destinationLocationCode: "NYC",
  departureDate: "2026-11-20",
  returnDate: "2026-11-27",
  adults: 1,
  travelClass: "ECONOMY",
  currencyCode: "EUR",
};

/** Probe routes bound to operations of the document; each answers with the scope its request ran in. */
@Controller("__guards")
class GuardProbe {
  constructor(private readonly cls: ClsService) {}

  private answer(): { consoleScope: boolean } {
    return { consoleScope: new RequestContext(this.cls).isConsoleScope() };
  }

  /** flights.search: both scopes, rate-limited per IP for the edge and pk_ keys. */
  @Post("flight-searches")
  @HttpCode(202)
  @OpenApiOperation("createFlightSearch")
  search(): { consoleScope: boolean } {
    return this.answer();
  }

  /** reference.listAirlines: both scopes, no rate limit. */
  @Get("airlines")
  @OpenApiOperation("listAirlines")
  airlines(): { consoleScope: boolean } {
    return this.answer();
  }

  /** checkout.completeWithAirlineCard: x-edge-only. */
  @Post("checkouts/:checkoutId/airline-card-completion")
  @OpenApiOperation("completeCheckoutWithAirlineCard")
  airlineCard(): { consoleScope: boolean } {
    return this.answer();
  }

  /** console.bookings.list: console scope, x-permission bookings:read. */
  @Get("console/bookings")
  @OpenApiOperation("consoleListBookings")
  consoleBookings(): { consoleScope: boolean } {
    return this.answer();
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

/** Issues an API key of the tenant as the platform does. */
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

/** A storefront search from the client address `ip`, through Caddy, with the given extra headers. */
function edgeSearch(ip: string, headers: Record<string, string> = edgeWriteHeaders(HOST)) {
  return request(api.server)
    .post("/__guards/flight-searches")
    .set(headers)
    .set("X-Forwarded-For", ip)
    .set("Idempotency-Key", randomUUID())
    .send(SEARCH);
}

/** A search with an API key from the client address `ip`. */
function keySearch(key: string, ip: string, headers: Record<string, string> = {}) {
  return request(api.server)
    .post("/__guards/flight-searches")
    .set("X-Api-Key", key)
    .set("X-Forwarded-For", ip)
    .set("Idempotency-Key", randomUUID())
    .set(headers)
    .send(SEARCH);
}

// Starting the application parses and compiles the OTA document, and the first expectResponseToMatch parses it again:
// one-time work that takes seconds while every package's tests run at once, so it happens here with the budget of
// test/helpers/openapi.ts, as do the database clone and the tenant's rows.
beforeAll(async () => {
  preloadOpenApiDocument();
  responseChecker("ota");
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
  api = await createTestApp({ database: db, redis, controllers: [GuardProbe] });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

describe("the CSRF guard on edge requests", () => {
  it("answers 403 CSRF_TOKEN_INVALID to an edge POST without the header, with a different one or a foreign Origin [OBE-013 AC1] [OF-03 AC2 groundwork]", async () => {
    const token = newCsrfToken();
    const page = edgeWriteHeaders(HOST, token);
    const { "X-CSRF-Token": _header, ...withoutHeader } = page;
    const { Cookie: _cookie, ...withoutCookie } = page;

    const answers = {
      withoutHeader: await edgeSearch("192.0.2.11", withoutHeader),
      withoutCookie: await edgeSearch("192.0.2.11", withoutCookie),
      otherHeader: await edgeSearch("192.0.2.11", { ...page, "X-CSRF-Token": newCsrfToken() }),
      foreignOrigin: await edgeSearch("192.0.2.11", { ...page, Origin: "https://attacker.example" }),
      otherStorefront: await edgeSearch("192.0.2.11", { ...page, Origin: "https://beta.ota.example.com" }),
      sameSiteWithoutOrigin: await edgeSearch("192.0.2.11", {
        ...withoutOrigin(page),
        "Sec-Fetch-Site": "same-site",
      }),
    };

    expect(
      Object.fromEntries(
        Object.entries(answers).map(([name, res]) => [
          name,
          [res.status, res.body.error?.code, res.body.error?.details],
        ]),
      ),
    ).toEqual({
      withoutHeader: [403, "CSRF_TOKEN_INVALID", { reason: "token_missing" }],
      withoutCookie: [403, "CSRF_TOKEN_INVALID", { reason: "token_missing" }],
      otherHeader: [403, "CSRF_TOKEN_INVALID", { reason: "token_mismatch" }],
      foreignOrigin: [403, "CSRF_TOKEN_INVALID", { reason: "origin_mismatch" }],
      otherStorefront: [403, "CSRF_TOKEN_INVALID", { reason: "origin_mismatch" }],
      sameSiteWithoutOrigin: [403, "CSRF_TOKEN_INVALID", { reason: "origin_mismatch" }],
    });
    for (const res of Object.values(answers)) {
      expectResponseToMatch("createFlightSearch", res);
    }
    // The CSRF guard runs before the rate limits (architecture §3 steps 9 and 10): a forged request uses up nothing.
    expect(await redis.client.exists(`rl:ota_shopping:${trackerDigest("ip", "192.0.2.11")}`)).toBe(0);
  });

  it("passes the matching pair from the storefront's origin, or same-origin without Origin [OBE-013 AC1]", async () => {
    const page = edgeWriteHeaders(HOST);

    const withOrigin = await edgeSearch("192.0.2.12", page);
    const sameOrigin = await edgeSearch("192.0.2.12", {
      ...withoutOrigin(page),
      "Sec-Fetch-Site": "same-origin",
    });

    expect([withOrigin.status, withOrigin.body]).toEqual([202, { consoleScope: false }]);
    expect(sameOrigin.status).toBe(202);
  });

  it("needs no header on GET, and never checks key callers [OBE-013 AC1]", async () => {
    const { key } = await issueKey("sk");

    const get = await request(api.server).get("/__guards/airlines").set(edgeHeaders(HOST));
    const keyPost = await keySearch(key, "192.0.2.13");

    expect([get.status, get.body]).toEqual([200, { consoleScope: false }]);
    expect(keyPost.status).toBe(202);
  });
});

describe("the rate limits", () => {
  it("answer the 31st search in a minute from one IP with 429 and Retry-After [OBE-013 AC2]", async () => {
    const statuses: number[] = [];
    for (let search = 1; search <= 30; search += 1) {
      statuses.push((await edgeSearch("203.0.113.7")).status);
    }
    const limited = await edgeSearch("203.0.113.7");
    const otherIp = await edgeSearch("203.0.113.8");

    expect(statuses).toEqual(Array.from({ length: 30 }, () => 202));
    expect([limited.status, limited.body.error.code]).toEqual([429, "RATE_LIMITED"]);
    expectResponseToMatch("createFlightSearch", limited);
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60).toBe(true);
    // No X-RateLimit-* headers, and no Retry-After on the answers that passed.
    expect(Object.keys(limited.headers).filter((name) => name.startsWith("x-ratelimit"))).toEqual([]);
    expect(otherIp.status).toBe(202);
    expect(otherIp.headers["retry-after"]).toBeUndefined();
  });

  it("keep the counter in Redis under the IP's digest for the minute of the window", async () => {
    const counter = `rl:ota_shopping:${trackerDigest("ip", "203.0.113.9")}`;

    const statuses = [(await edgeSearch("203.0.113.9")).status, (await edgeSearch("203.0.113.9")).status];

    expect(statuses).toEqual([202, 202]);
    expect(await redis.client.get(counter)).toBe("2");
    const ttl = await redis.client.pttl(counter);
    expect(ttl > 0 && ttl <= 60_000).toBe(true);
    expect((await redis.client.keys("rl:*")).join(" ")).not.toContain("203.0.113.9");
  });

  it("count a publishable key's searches by IP with the edge's, and not a secret key's (its server's visitors)", async () => {
    const publishable = await issueKey("pk");
    const secret = await issueKey("sk");
    const ip = "203.0.113.10";

    // Fifteen searches from the storefront and fifteen with the publishable key, from one browser address.
    const statuses: number[] = [];
    for (let search = 1; search <= 15; search += 1) {
      statuses.push((await edgeSearch(ip)).status, (await keySearch(publishable.key, ip)).status);
    }
    const fromBrowser = await keySearch(publishable.key, ip);
    const fromStorefront = await edgeSearch(ip);
    const fromServer = await keySearch(secret.key, ip);

    expect(statuses).toEqual(Array.from({ length: 30 }, () => 202));
    expect([fromBrowser.status, fromBrowser.body.error?.code]).toEqual([429, "RATE_LIMITED"]);
    expect([fromStorefront.status, fromStorefront.body.error?.code]).toEqual([429, "RATE_LIMITED"]);
    expect(fromServer.status).toBe(202);
  });

  it("count an IPv6 client for its /64", async () => {
    const statuses: number[] = [];
    for (let search = 1; search <= 31; search += 1) {
      statuses.push((await edgeSearch(`2001:db8:0:7::${search.toString(16)}`)).status);
    }
    const otherNetwork = await edgeSearch("2001:db8:0:8::1");

    expect(statuses.slice(0, 30).every((status) => status === 202)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(otherNetwork.status).toBe(202);
  });
});

describe("the scope guard", () => {
  it("keeps edge-only operations to the edge: 403 SCOPE_NOT_ALLOWED for pk_ and sk_ keys", async () => {
    const publishable = await issueKey("pk");
    const secret = await issueKey("sk");
    const path = `/__guards/checkouts/${CHECKOUT_ID}/airline-card-completion`;

    const keys = [
      await request(api.server).post(path).set("X-Api-Key", publishable.key).send({}),
      await request(api.server).post(path).set("X-Api-Key", secret.key).send({}),
    ];
    // The edge passes the scope and CSRF guards; the empty body then fails validation.
    const edge = await request(api.server)
      .post(path)
      .set(edgeWriteHeaders(HOST))
      .set("X-Forwarded-For", "192.0.2.21")
      .send({});

    for (const res of keys) {
      expect([res.status, res.body.error.code, res.body.error.details]).toEqual([
        403,
        "SCOPE_NOT_ALLOWED",
        { reason: "edge_only" },
      ]);
      expectResponseToMatch("completeCheckoutWithAirlineCard", res);
    }
    expect([edge.status, edge.body.error.code]).toEqual([400, "VALIDATION_FAILED"]);
  });

  it("refuses console operations to the edge, pk_ keys and secret keys without console access", async () => {
    const publishable = await issueKey("pk");
    const storefront = await issueKey("sk", { scopes: ["storefront"] });
    const consoleKey = await issueKey("sk", { scopes: ["console"] });
    const automation = await issueKey("sk", { scopes: ["console:automation", "queues:read"] });
    const path = "/__guards/console/bookings";

    const answers = [
      await request(api.server).get(path).set(edgeHeaders(HOST)),
      await request(api.server).get(path).set("X-Api-Key", publishable.key),
      await request(api.server).get(path).set("X-Api-Key", storefront.key),
      await request(api.server).get(path).set("X-Api-Key", consoleKey.key),
      await request(api.server).get(path).set("X-Api-Key", automation.key),
    ];

    expect(answers.map((res) => [res.status, res.body.error?.code, res.body.error?.details])).toEqual([
      [403, "SCOPE_NOT_ALLOWED", { reason: "console_operation" }],
      [403, "SCOPE_NOT_ALLOWED", { reason: "console_operation" }],
      [403, "SCOPE_NOT_ALLOWED", { reason: "storefront_key" }],
      [403, "SCOPE_NOT_ALLOWED", { requiredScope: "console:automation" }],
      [403, "FORBIDDEN", { requiredPermission: "bookings:read" }],
    ]);
    for (const res of answers) {
      expectResponseToMatch("consoleListBookings", res);
    }
  });

  it("runs a console:automation key's call in console scope, on console operations and when it asks on shared ones", async () => {
    const automation = await issueKey("sk", { scopes: ["console:automation", "bookings:read"] });
    const plain = await issueKey("sk");

    const consoleCall = await request(api.server)
      .get("/__guards/console/bookings")
      .set("X-Api-Key", automation.key);
    const asked = await keySearch(automation.key, "192.0.2.31", { "X-Velexis-Scope": "console" });
    const notAsked = await keySearch(automation.key, "192.0.2.31");
    const plainAsked = await keySearch(plain.key, "192.0.2.31", { "X-Velexis-Scope": "console" });

    expect([consoleCall.status, consoleCall.body]).toEqual([200, { consoleScope: true }]);
    expect([asked.status, asked.body]).toEqual([202, { consoleScope: true }]);
    expect([notAsked.status, notAsked.body]).toEqual([202, { consoleScope: false }]);
    expect([plainAsked.status, plainAsked.body.error.details]).toEqual([
      403,
      { requiredScope: "console:automation" },
    ]);
  });
});

describe("API key usage", () => {
  /** Spies on the API's Redis client; the result lists the `SET` calls that wrote `apikey:used:<keyId>` since. */
  function spyOnUsageWrites() {
    const set = vi.spyOn(api.app.get<string, Redis>(REDIS_CLIENT), "set");
    return (keyId: string) => set.mock.calls.filter(([key]) => key === redisKeys.apiKeyUsed(keyId).key);
  }

  it("writes apikey:used:<keyId> once for ten requests with one key within a minute [OBE-013 AC3]", async () => {
    const { key, id } = await issueKey("sk");
    const writes = spyOnUsageWrites();

    const statuses: number[] = [];
    for (let call = 0; call < 10; call += 1) {
      const res = await request(api.server)
        .get("/__guards/airlines")
        .set("X-Api-Key", key)
        .set("X-Forwarded-For", "198.51.100.41");
      statuses.push(res.status);
    }
    const stored = await vi.waitFor(async () => {
      const value = await redis.client.get(redisKeys.apiKeyUsed(id).key);
      expect(value).not.toBeNull();
      return JSON.parse(String(value)) as { at: string; ip: string };
    });

    expect(statuses).toEqual(Array.from({ length: 10 }, () => 200));
    expect(writes(id)).toHaveLength(1);
    expect(stored).toEqual({
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      ip: "198.51.100.41",
    });
    const ttl = await redis.client.ttl(redisKeys.apiKeyUsed(id).key);
    expect(ttl > 86_000 && ttl <= 86_400).toBe(true);
  });

  it("writes again once the minute is over, and nothing for refused or failed requests [OBE-013 AC3]", async () => {
    const used = await issueKey("sk");
    const refused = await issueKey("sk", { scopes: ["storefront"] });
    const writes = spyOnUsageWrites();
    const clock = api.app.get(Clock);
    const start = Date.now();
    const now = vi.spyOn(clock, "now").mockImplementation(() => new Date(start));

    await request(api.server).get("/__guards/airlines").set("X-Api-Key", used.key);
    await vi.waitFor(() => expect(writes(used.id)).toHaveLength(1));
    now.mockImplementation(() => new Date(start + 61_000));
    await request(api.server).get("/__guards/airlines").set("X-Api-Key", used.key);
    await vi.waitFor(() => expect(writes(used.id)).toHaveLength(2));
    // A guard's refusal (403) and a validation failure (400) are not uses.
    const forbidden = await request(api.server)
      .get("/__guards/console/bookings")
      .set("X-Api-Key", refused.key);
    const invalid = await request(api.server)
      .post("/__guards/flight-searches")
      .set("X-Api-Key", refused.key)
      .send({});
    // A successful request of another key after them has been recorded, so theirs would have been by now.
    const other = await issueKey("sk");
    await request(api.server).get("/__guards/airlines").set("X-Api-Key", other.key);
    await vi.waitFor(() => expect(writes(other.id)).toHaveLength(1));

    expect([forbidden.status, invalid.status]).toEqual([403, 400]);
    expect(writes(refused.id)).toEqual([]);
    expect(await redis.client.exists(redisKeys.apiKeyUsed(refused.id).key)).toBe(0);
    const stored = JSON.parse(String(await redis.client.get(redisKeys.apiKeyUsed(used.id).key))) as {
      at: string;
    };
    expect(stored.at).toBe(new Date(start + 61_000).toISOString());
  });
});

describe("with Redis down", () => {
  let down: TestApp;

  // A second application whose REDIS_URL points where nothing listens (createTestApp's default); its platform reads
  // fall back to PostgreSQL. Starting it waits for the first vx:invalidate connection attempt.
  beforeAll(async () => {
    down = await createTestApp({ database: db, controllers: [GuardProbe] });
  }, OPENAPI_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await down?.close();
  });

  it("refuses rate-limited routes with 503 SERVICE_UNAVAILABLE and serves the others", async () => {
    const limited = await request(down.server)
      .post("/__guards/flight-searches")
      .set(edgeWriteHeaders(HOST))
      .set("Idempotency-Key", randomUUID())
      .send(SEARCH);
    const unlimited = await request(down.server).get("/__guards/airlines").set(edgeHeaders(HOST));

    expect([limited.status, limited.body.error.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expectResponseToMatch("createFlightSearch", limited);
    expect(unlimited.status).toBe(200);
    expect(down.sink.records()).toContainEqual(
      expect.objectContaining({ msg: "throttler.store_unavailable", throttler: "ota_shopping" }),
    );
  });
});

/** `headers` without `Origin`. */
function withoutOrigin(headers: Readonly<Record<string, string>>): Record<string, string> {
  const { Origin: _origin, ...rest } = headers;
  return rest;
}
