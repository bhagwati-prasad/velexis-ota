// storefront.get against PostgreSQL 16 and Redis 7 (OBE-016; ota/docs/flows/search-and-price.md §2 step 1,
// OADR-0006, OADR-0012 points 3 and 7): the API on this file's database clone and Redis database, called as the hosted
// storefront (edge headers), with a publishable key and with secret keys. The tenants are inserted as the platform
// writes them (as velexis_migrator); their settings rows as provisioning seeds them, then configured as the OTA admin
// will (OBE-070), through `tenantTx` as velexis_ota_app. Every answer is checked against the OTA document.
import { hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { CSRF_TOKEN_PATTERN } from "../../../src/common/auth/csrf.guard";
import { newId } from "../../../src/common/ids";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { EDGE_CACHE_CONTROL, KEY_CACHE_CONTROL } from "../../../src/storefront/storefront.controller";
import { StorefrontRepository } from "../../../src/storefront/storefront.repository";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, newCsrfToken, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALLOWED_ORIGIN = "https://shop.alpha-travel.example";
const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";
const OPS_ALERT_EMAIL = "ops-alerts@alpha-travel.example";
/** PUBLIC_OTA_API_URL of the test configuration (test/helpers/api-env.ts). */
const PUBLIC_API = "http://localhost:4000";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenants: TenantDb;
let alphaId: string;
let betaId: string;
let alphaPk: string;
let alphaSk: string;
let betaSk: string;
let logoId: string;
let faviconId: string;
let settingsReads: MockInstance;

async function insertTenant(key: string, name: string): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name, status: "active", plan_code: "early_access" })
    .execute();
  return id;
}

/** Issues a test key of a tenant as the platform does. */
async function issueKey(tenantId: string, kind: "pk" | "sk"): Promise<string> {
  const key = newApiKey(kind);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: kind === "pk" ? "Storefront (test)" : "Server (test)",
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...(kind === "pk" ? { allowed_origins: [ALLOWED_ORIGIN] } : {}),
    })
    .execute();
  return key;
}

/** Alpha's settings as the OTA admin configures them: a logo and a favicon, two locales, operational columns. */
async function configureAlpha(): Promise<void> {
  logoId = newId("ast");
  faviconId = newId("ast");
  await tenantTx(tenants, "tenant_alpha", async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    const asset = (id: string, kind: string, contentType: string, extension: string, hash: string) => ({
      id,
      kind,
      content_type: contentType,
      file_extension: extension,
      file_name: `${kind}.${extension}`,
      size_bytes: 1024,
      storage_key: `tenant_alpha/assets/${hash}.${extension}`,
      content_hash: hash,
    });
    await trx
      .insertInto("storefront_assets")
      .values([
        asset(logoId, "logo", "image/png", "png", "a".repeat(64)),
        asset(faviconId, "favicon", "image/x-icon", "ico", "b".repeat(64)),
      ])
      .execute();
    await trx
      .updateTable("storefront_settings")
      .set({
        supported_locales: ["en", "fr-FR"],
        supported_currencies: ["EUR", "GBP"],
        support_email: "help@alpha-travel.example",
        ops_alert_email: OPS_ALERT_EMAIL,
        booking_queue_number: 42,
        booking_queue_category: 7,
        logo_asset_id: logoId,
        favicon_asset_id: faviconId,
      })
      .execute();
  });
}

const get = (headers: Readonly<Record<string, string>>) =>
  request(api.server).get("/v1/storefront").set(headers);

const alphaEdge = (extra: Readonly<Record<string, string>> = {}) =>
  get({ ...edgeHeaders(ALPHA_HOST), ...extra });
const alphaPublishable = () => get({ "X-Api-Key": alphaPk, Origin: ALLOWED_ORIGIN });
const alphaSecret = (extra: Readonly<Record<string, string>> = {}) => get({ "X-Api-Key": alphaSk, ...extra });

/** The `Set-Cookie` values of a response (none: an empty list). */
function setCookies(res: request.Response): string[] {
  const value = res.headers["set-cookie"] as string[] | string | undefined;
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** The storefront cache keys of a tenant in the test environment. */
async function cacheKeys(tenantId: string): Promise<string[]> {
  return (await redis.client.keys(`t:${tenantId}:test:sf:*`)).sort();
}

// One database clone, one Redis database, the platform rows, the tenants' settings and an API application (the Nest
// module graph and the OTA document's validators): several seconds while every package's tests run at once.
beforeAll(async () => {
  preloadOpenApiDocument();
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenants = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = await insertTenant("alpha", "Alpha Travel Holding");
  betaId = await insertTenant("beta", "Beta Trips");
  alphaPk = await issueKey(alphaId, "pk");
  alphaSk = await issueKey(alphaId, "sk");
  betaSk = await issueKey(betaId, "sk");
  await configureAlpha();
  await tenantTx(tenants, "tenant_beta", (trx) =>
    seedStorefrontSettings(trx, { name: "Beta Trips", defaultCurrency: "GBP", defaultLocale: "en-GB" }),
  );
  api = await createTestApp({ database: db, redis });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(async () => {
  // Every test starts without cached rows or configurations, and counts the settings reads from zero.
  await redis.client.flushdb();
  settingsReads = vi.spyOn(api.app.get(StorefrontRepository), "settings");
});

describe("the CSRF cookie", () => {
  it("is set for an edge call without one: Secure, SameSite=Lax, Path=/, no HttpOnly [OBE-016 AC1]", async () => {
    const res = await alphaEdge();

    expect(res.status).toBe(200);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    const [cookie = ""] = cookies;
    expect(cookie).toMatch(
      /^__Host-vx_csrf=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; Secure; SameSite=Lax$/,
    );
    expect(cookie).not.toMatch(/HttpOnly|Domain/i);
    const value = cookie.slice("__Host-vx_csrf=".length, cookie.indexOf(";"));
    expect(value).toMatch(CSRF_TOKEN_PATTERN);
    expect(Buffer.from(value, "base64url")).toHaveLength(32);
    expect(res.headers["cache-control"]).toBe(EDGE_CACHE_CONTROL);
    expect(res.headers["vary"]).toBe("Accept-Language");
  });

  it("is kept when the edge request has a well-formed one, and replaced when it is malformed [OBE-016 AC1]", async () => {
    const valid = await alphaEdge({ Cookie: `__Host-vx_csrf=${newCsrfToken()}` });
    const malformed = await alphaEdge({ Cookie: "__Host-vx_csrf=not-a-token" });

    expect(valid.status).toBe(200);
    expect(setCookies(valid)).toEqual([]);
    expect(malformed.status).toBe(200);
    expect(setCookies(malformed)).toHaveLength(1);
    expect(setCookies(malformed)[0]).toMatch(/^__Host-vx_csrf=[A-Za-z0-9_-]{43};/);
  });

  it("is never set for a key caller, with or without cookies [OBE-016 AC1]", async () => {
    const responses = [
      await alphaPublishable(),
      await alphaSecret(),
      await alphaSecret({ Cookie: "__Host-vx_csrf=not-a-token" }),
      await get({ "X-Api-Key": betaSk }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.headers["cache-control"]).toBe(KEY_CACHE_CONTROL);
    }
  });

  it("is set on a 304 too: the ETag is the body's, the cookie the visitor's", async () => {
    const first = await alphaSecret();
    const etag = first.headers["etag"] as string;
    const notModifiedKey = await alphaSecret({ "If-None-Match": etag });
    const edge = await alphaEdge({ Cookie: `__Host-vx_csrf=${newCsrfToken()}` });
    const notModifiedEdge = await alphaEdge({ "If-None-Match": edge.headers["etag"] as string });

    expect(etag).toBeTruthy();
    expect(notModifiedKey.status).toBe(304);
    expect(notModifiedKey.headers["set-cookie"]).toBeUndefined();
    expect(notModifiedEdge.status).toBe(304);
    expect(setCookies(notModifiedEdge)).toHaveLength(1);
    expectResponseToMatch("getStorefront", notModifiedKey);
    expectResponseToMatch("getStorefront", notModifiedEdge);
  });
});

describe("the configuration", () => {
  it("validates against StorefrontConfig and holds no internal column, for the edge and keys [OBE-016 AC2]", async () => {
    const responses = [
      await alphaEdge(),
      await alphaPublishable(),
      await alphaSecret(),
      await get(edgeHeaders(BETA_HOST)),
      await get({ "X-Api-Key": betaSk }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(200);
      expectResponseToMatch("getStorefront", res);
      expect(res.text).not.toMatch(/ops_?alert|booking_?queue/i);
      expect(res.text).not.toContain(OPS_ALERT_EMAIL);
      expect(res.text).not.toMatch(/"42"|:42\b/);
    }
    // Nor does the cache.
    for (const key of [
      ...(await cacheKeys(alphaId)),
      ...(await redis.client.keys(`t:${betaId}:test:sf:*`)),
    ]) {
      const stored = (await redis.client.get(key)) ?? "";
      expect(stored).not.toMatch(/ops_?alert|booking_?queue/i);
      expect(stored).not.toContain(OPS_ALERT_EMAIL);
    }
  });

  it("maps each tenant's own settings and environment", async () => {
    const alpha = await alphaSecret();
    const beta = await get(edgeHeaders(BETA_HOST));

    expect(alpha.body).toMatchObject({
      tenantKey: "alpha",
      name: "Alpha Travel",
      environment: "test",
      primaryUrl: "https://alpha.ota.example.com",
      defaultCurrency: "EUR",
      currencies: [
        { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
        { code: "GBP", name: "Pound Sterling", symbol: "£", decimals: 2 },
      ],
      locales: [{ code: "en" }, { code: "fr-FR" }],
      support: { email: "help@alpha-travel.example" },
      features: { savedTravelers: false },
      payment: { supportedMethods: [], airlineCard: null, merchantName: "Alpha Travel Holding" },
    });
    expect(beta.body).toMatchObject({
      tenantKey: "beta",
      name: "Beta Trips",
      defaultLocale: "en-GB",
      defaultCurrency: "GBP",
      defaultMarket: "GB",
      support: { email: "support@beta.invalid" },
    });
    // A new tenant has no uploaded images: a data: badge, never a broken link.
    expect(beta.body.branding.logoUrl).toMatch(/^data:image\/svg\+xml,/);
  });

  it("answers 403 TENANT_SUSPENDED, uncached, for a tenant whose settings row is missing", async () => {
    await tenantTx(tenants, "tenant_beta", (trx) => trx.deleteFrom("storefront_settings").execute());
    try {
      const res = await get({ "X-Api-Key": betaSk });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "TENANT_SUSPENDED" });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["set-cookie"]).toBeUndefined();
      expectResponseToMatch("getStorefront", res);
      expect(await redis.client.keys(`t:${betaId}:test:sf:*`)).toEqual([]);
    } finally {
      await tenantTx(tenants, "tenant_beta", (trx) =>
        seedStorefrontSettings(trx, { name: "Beta Trips", defaultCurrency: "GBP", defaultLocale: "en-GB" }),
      );
    }
  });
});

describe("the response cache", () => {
  it("serves a second call within 5 minutes without reading the settings row [OBE-016 AC3]", async () => {
    const first = await alphaSecret();
    const second = await alphaSecret();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(settingsReads).toHaveBeenCalledTimes(1);
    expect(await cacheKeys(alphaId)).toEqual([`t:${alphaId}:test:sf:und`]);
    const ttl = await redis.client.ttl(`t:${alphaId}:test:sf:und`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    // The edge and other keys of the tenant share the entry.
    await alphaEdge();
    await alphaPublishable();
    expect(settingsReads).toHaveBeenCalledTimes(1);
  });

  it("gives a pk_ key absolute asset URLs and the edge relative paths from one cache fill, in either order [OBE-016 AC4]", async () => {
    const logoPath = `/v1/assets/alpha/${logoId}.png`;
    const faviconPath = `/v1/assets/alpha/${faviconId}.ico`;

    const keyFirst = await alphaPublishable();
    const edgeSecond = await alphaEdge();
    expect(settingsReads).toHaveBeenCalledTimes(1);

    await redis.client.flushdb();
    const edgeFirst = await alphaEdge();
    const keySecond = await alphaPublishable();
    expect(settingsReads).toHaveBeenCalledTimes(2);

    for (const res of [keyFirst, keySecond]) {
      expectResponseToMatch("getStorefront", res);
      expect(res.body.branding.logoUrl).toBe(`${PUBLIC_API}${logoPath}`);
      expect(res.body.branding.faviconUrl).toBe(`${PUBLIC_API}${faviconPath}`);
    }
    for (const res of [edgeSecond, edgeFirst]) {
      expectResponseToMatch("getStorefront", res);
      expect(res.body.branding.logoUrl).toBe(`/api${logoPath}`);
      expect(res.body.branding.faviconUrl).toBe(`/api${faviconPath}`);
    }
    expect(keySecond.body).toEqual(keyFirst.body);
    expect(edgeFirst.body).toEqual(edgeSecond.body);
  });

  it("keeps one entry per supported locale whatever Accept-Language says", async () => {
    const french = await alphaSecret({ "Accept-Language": "fr-CA,fr;q=0.9" });
    const german = await alphaSecret({ "Accept-Language": "de-DE" });
    const english = await alphaSecret({ "Accept-Language": "en-US" });
    await alphaSecret({ "Accept-Language": "fr-FR" });
    await alphaSecret({ "Accept-Language": "xx-YY, zz;q=0.5" });

    expect(french.body.currencies[0]).toMatchObject({ code: "EUR", name: "euro" });
    expect(german.body.currencies[0]).toMatchObject({ code: "EUR", name: "Euro" });
    expect(english.body).toEqual(german.body);
    expect(french.headers["vary"]).toBe("Accept-Language, X-Api-Key");
    expect(await cacheKeys(alphaId)).toEqual([`t:${alphaId}:test:sf:fr-FR`, `t:${alphaId}:test:sf:und`]);
    expect(settingsReads).toHaveBeenCalledTimes(1);
  });

  it("never serves one tenant's entry to another", async () => {
    await alphaSecret();
    const beta = await get({ "X-Api-Key": betaSk });

    expect(beta.body).toMatchObject({ tenantKey: "beta", name: "Beta Trips" });
    expect(settingsReads).toHaveBeenCalledTimes(2);
    expect(await redis.client.keys(`t:${betaId}:test:sf:*`)).toEqual([`t:${betaId}:test:sf:und`]);
  });

  it("rebuilds an entry it cannot read", async () => {
    await alphaSecret();
    await redis.client.set(`t:${alphaId}:test:sf:und`, '{"v":99}', "EX", 300);

    const res = await alphaSecret();

    expect(res.status).toBe(200);
    expectResponseToMatch("getStorefront", res);
    expect(settingsReads).toHaveBeenCalledTimes(2);
  });
});

describe("without Redis", () => {
  let offline: TestApp;
  let offlineReads: MockInstance;

  // A second application of the same graph on a port where no Redis listens (createTestApp's default).
  beforeAll(async () => {
    offline = await createTestApp({ database: db });
  }, OPENAPI_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await offline?.close();
  });

  beforeEach(() => {
    offlineReads = vi.spyOn(offline.app.get(StorefrontRepository), "settings");
  });

  it("reads PostgreSQL on every request and still answers", async () => {
    const first = await request(offline.server).get("/v1/storefront").set({ "X-Api-Key": alphaSk });
    const second = await request(offline.server).get("/v1/storefront").set(edgeHeaders(ALPHA_HOST));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expectResponseToMatch("getStorefront", first);
    expectResponseToMatch("getStorefront", second);
    expect(offlineReads).toHaveBeenCalledTimes(2);
  });
});
