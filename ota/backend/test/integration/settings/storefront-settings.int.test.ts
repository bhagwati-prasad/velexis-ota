// console.settings.storefront.get and update through the API's whole pipeline (OBE-070; api-changes part 2 §2.3,
// OADR-0012 points 1, 4, 6 and 7, OADR-0008 point 2, OADR-0004 point 1), against PostgreSQL 16 and Redis 7: the
// settings row with its 0002 columns, If-Match and ETag, the rules that need the database (reference currencies, time
// zones and countries, assets by kind, content pages), the airline-card switch and warning, the staff_actions row, and
// storefront.get after a change: its cache entries of both environments are deleted, so the next call reads the row.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha and beta in test, accounts and memberships of the roles used, a secret test key of alpha
// for storefront.get. Staff sign in through the OTA admin's service key with portal tokens, as
// console-access.int.test.ts does, each admin client with an end-user IP address of its own. The settings rows are
// seeded as provisioning seeds them, the default markup rule (0 %) too; alpha gets three uploaded images and a content
// page as the OTA admin will create them (OBE-071, OBE-072). The template's reference fixture has no time zones: UTC
// and Europe/London are added as the reference loader writes them, with two currencies the settings refuse (KWD with
// 3 minor units, the historic DEM). Every answer is checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { hashApiKey, sha256Hex } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { StorefrontRepository } from "../../../src/storefront/storefront.repository";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "viewer";
type Schema = "tenant_alpha" | "tenant_beta";
type Json = Record<string, unknown>;

const SETTINGS = "/v1/console/settings/storefront";
const ALPHA_HOST = "alpha.ota.example.com";
/** PUBLIC_OTA_API_URL of the test configuration (test/helpers/api-env.ts). */
const PUBLIC_API = "http://localhost:4000";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase & ReferenceDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let betaId: string;
let alphaSk: string;
let logoId: string;
let faviconId: string;
let ogImageId: string;
let settingsReads: MockInstance;

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one end user. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
};

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A portal token in the platform's format (PADR-0007 item 1): `ptk_` and 43 random base62 characters. */
function newPortalToken(): string {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  return token;
}

/** Inserts an active test tenant of a provisioned test schema. */
async function insertTenant(key: "alpha" | "beta"): Promise<string> {
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenantId,
      key,
      name: `${key} Travel`,
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/London",
      storefront_environment: "test",
    })
    .execute();
  return tenantId;
}

/** A portal account and its membership in one tenant. */
interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly role: Role;
}

/** Inserts an active account with MFA and its membership with `role` in `tenantId`. */
async function insertMember(tenantId: string, role: Role): Promise<Member> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `staff.${randomBytes(4).toString("hex")}@example.com`,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/London",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, tenantId, role };
}

/** A staff member signed in through the OTA admin: its admin client's headers and the access token. */
interface Staff {
  readonly member: Member;
  readonly get: () => request.Test;
  readonly patch: (body: unknown, ifMatch?: string) => request.Test;
}

/** Signs a new member with `role` in through a new admin client (its own end-user IP); fails unless it answers 200. */
async function signIn(tenantId: string, role: Role): Promise<Staff> {
  const member = await insertMember(tenantId, role);
  const portalToken = newPortalToken();
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId,
    membershipId: member.staffId,
    role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(
    await redis.client.set(redisKeys.portalToken(sha256Hex(portalToken)).key, value, "EX", 60, "NX"),
  ).toBe("OK");
  const headers = {
    "X-Api-Key": testApiCredentials().serviceKey,
    "X-Velexis-End-User-IP": newIp(),
    "X-Velexis-End-User-Agent": `Mozilla/5.0 (OTA admin settings test ${randomBytes(3).toString("hex")})`,
    "X-Velexis-Environment": "test",
  };
  const res = await request(api.server)
    .post("/v1/console/auth/sign-in")
    .set({ ...headers, "Idempotency-Key": randomUUID() })
    .send({ grantType: "portal_token", portalToken });
  expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
  const authorization = `Bearer ${(res.body.session as { accessToken: string }).accessToken}`;
  return {
    member,
    get: () => request(api.server).get(SETTINGS).set(headers).set("Authorization", authorization),
    patch: (body, ifMatch) => {
      const req = request(api.server)
        .patch(SETTINGS)
        .set(headers)
        .set("Authorization", authorization)
        .send(body as object);
      return ifMatch === undefined ? req : req.set("If-Match", ifMatch);
    },
  };
}

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The settings of `staff` and their ETag; fails unless it answers 200. */
async function current(staff: Staff): Promise<{ settings: Json; etag: string }> {
  const res = await staff.get();
  expect(answer(res)).toEqual([200, undefined]);
  return { settings: res.body as Json, etag: res.headers["etag"] as string };
}

/** The staff_actions rows of `staffId` in `schema`, oldest first. */
async function staffActions(schema: Schema, staffId: string): Promise<Json[]> {
  return tenantTx(tenantDb, schema as TenantSchema, (trx) =>
    trx
      .selectFrom("staff_actions")
      .selectAll()
      .where("staff_id", "=", staffId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  ) as Promise<Json[]>;
}

/** The storefront.get cache keys of a tenant, in both environments. */
async function cacheKeys(tenantId: string): Promise<string[]> {
  return (await redis.client.keys(`t:${tenantId}:*:sf:*`)).sort();
}

const storefrontEdge = () => request(api.server).get("/v1/storefront").set(edgeHeaders(ALPHA_HOST));
const storefrontKey = () => request(api.server).get("/v1/storefront").set("X-Api-Key", alphaSk);

/** Inserts an uploaded image of alpha as the asset upload does (OBE-071). */
function assetRow(id: string, kind: string, contentType: string, extension: string) {
  const hash = randomBytes(32).toString("hex");
  return {
    id,
    kind,
    content_type: contentType,
    file_extension: extension,
    file_name: `${kind}.${extension}`,
    size_bytes: 2048,
    width: 400,
    height: 120,
    storage_key: `tenant_alpha/assets/${hash}.${extension}`,
    content_hash: hash,
  };
}

// Cloning the template and building the API's module graph (Nest, pools, Redis, the OTA document's validators) take
// several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own budget, and
// the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase & ReferenceDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = await insertTenant("alpha");
  betaId = await insertTenant("beta");
  alphaSk = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: alphaId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: alphaSk.slice(0, 14),
      key_hash: hashApiKey(alphaSk, testApiCredentials().pepper),
      last4: alphaSk.slice(-4),
    })
    .execute();
  await migrator
    .insertInto("reference.time_zones")
    .values([
      { name: "UTC", country_code: null, utc_offset_minutes: 0, dst_offset_minutes: null },
      { name: "Europe/London", country_code: "GB", utc_offset_minutes: 0, dst_offset_minutes: 60 },
    ])
    .execute();
  // Two currencies the settings refuse, as the reference loader writes them: one with 3 minor units, one historic.
  await migrator
    .insertInto("reference.currencies")
    .values([
      { code: "KWD", numeric_code: "414", name: "Kuwaiti Dinar", symbol: "KWD", minor_units: 3 },
      {
        code: "DEM",
        numeric_code: "276",
        name: "German Mark",
        symbol: null,
        minor_units: 2,
        is_active: false,
      },
    ])
    .execute();
  logoId = newId("ast");
  faviconId = newId("ast");
  ogImageId = newId("ast");
  await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
    await trx
      .insertInto("storefront_assets")
      .values([
        assetRow(logoId, "logo", "image/png", "png"),
        assetRow(faviconId, "favicon", "image/x-icon", "ico"),
        assetRow(ogImageId, "og_image", "image/jpeg", "jpg"),
      ])
      .execute();
    await trx
      .insertInto("storefront_pages")
      .values({ id: newId("stp"), slug: "terms", locale: "en", kind: "terms", title: "Terms and conditions" })
      .execute();
  });
  await tenantTx(tenantDb, "tenant_beta", (trx) =>
    seedStorefrontSettings(trx, { name: "Beta Trips", defaultCurrency: "GBP", defaultLocale: "en-GB" }),
  );
  api = await createTestApp({ database: db, redis });
  // The first sign-in, read and write of a process open the pools' connections and warm the token and validation
  // code; done once here, so that no test pays for it.
  const warmUp = await signIn(alphaId, "owner");
  const { settings, etag } = await current(warmUp);
  expect((await warmUp.patch({ brand: settings["brand"] }, etag)).status).toBe(200);
  expect((await storefrontEdge()).status).toBe(200);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

beforeEach(() => {
  settingsReads = vi.spyOn(api.app.get(StorefrontRepository), "settings");
});

describe("console.settings.storefront.get", () => {
  it("answers the settings with their ETag, private and uncached, to a viewer too", async () => {
    const viewer = await signIn(alphaId, "viewer");

    const res = await viewer.get();

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetStorefrontSettings", res);
    expect(res.headers["etag"]).toBe(`"${String(res.body.version)}"`);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toMatchObject({
      brand: { name: "Alpha Travel", timeZone: "UTC" },
      currencies: { default: "EUR", supported: ["EUR"] },
      policies: { paymentTiming: "authorize_before_booking", offerTtlMinutes: 30 },
      // The read-only switch (FIX-W35-OTA): off in the test configuration, so the live airline card cannot be turned on.
      airlineCard: { enabledLive: false, liveAvailable: false },
      operations: { opsAlertEmail: null, bookingQueue: { number: 50, category: 0 } },
    });
  });
});

describe("console.settings.storefront.update", () => {
  it("gives the next storefront.get the new branding: the entries of both environments are deleted [OBE-070 AC1]", async () => {
    const owner = await signIn(alphaId, "owner");
    expect((await storefrontEdge()).status).toBe(200);
    await redis.client.set(redisKeys.sf(alphaId, "live", "en").key, "{}", "EX", 300);
    await redis.client.set(redisKeys.sf(betaId, "test", "und").key, "{}", "EX", 300);
    expect(await cacheKeys(alphaId)).toEqual([`t:${alphaId}:live:sf:en`, `t:${alphaId}:test:sf:und`]);
    const { settings, etag } = await current(owner);
    const branding = {
      logoAssetId: logoId,
      logoDarkAssetId: null,
      logoSquareAssetId: null,
      faviconAssetId: faviconId,
      colors: {
        primary: "#0B5FFF",
        secondary: "#14213D",
        accent: "#FCA311",
        background: "#FFFFFF",
        text: "#1A1A1A",
      },
      fonts: { heading: "Montserrat", body: "Lato" },
      cornerRadius: "large",
    };

    const res = await owner.patch({ branding }, etag);

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleUpdateStorefrontSettings", res);
    const version = Number(settings["version"]) + 1;
    expect(res.body).toMatchObject({ version, branding, warnings: [] });
    expect(res.headers["etag"]).toBe(`"${version}"`);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(await cacheKeys(alphaId)).toEqual([]);
    // Another tenant's entry is left alone.
    expect(await redis.client.exists(redisKeys.sf(betaId, "test", "und").key)).toBe(1);

    const reads = settingsReads.mock.calls.length;
    const edge = await storefrontEdge();
    const key = await storefrontKey();
    expect(settingsReads.mock.calls.length).toBe(reads + 1);
    for (const config of [edge, key]) {
      expect(config.status).toBe(200);
      expectResponseToMatch("getStorefront", config);
      expect(config.body).toMatchObject({
        version,
        branding: {
          colors: { primary: "#0B5FFF", secondary: "#14213D", accent: "#FCA311", text: "#1A1A1A" },
          fonts: { heading: { family: "Montserrat" }, body: { family: "Lato" } },
          cornerRadius: "large",
          customCssUrl: null,
        },
      });
    }
    expect(edge.body.branding).toMatchObject({
      logoUrl: `/api/v1/assets/alpha/${logoId}.png`,
      faviconUrl: `/api/v1/assets/alpha/${faviconId}.ico`,
    });
    expect(key.body.branding.logoUrl).toBe(`${PUBLIC_API}/v1/assets/alpha/${logoId}.png`);
  });

  it("answers paymentTiming pay_later 422 UNPROCESSABLE and enabledLive true 403 FEATURE_DISABLED while the switch is off [OBE-070 AC2]", async () => {
    const owner = await signIn(alphaId, "owner");
    const { settings, etag } = await current(owner);
    const policies = settings["policies"] as Json;

    const payLater = await owner.patch({ policies: { ...policies, paymentTiming: "pay_later" } }, etag);
    const live = await owner.patch({ airlineCard: { enabledTest: false, enabledLive: true } }, etag);

    expect(answer(payLater)).toEqual([422, "UNPROCESSABLE"]);
    expect(payLater.body.error.details).toEqual({
      reason: "payment_timing_not_supported",
      path: "/policies/paymentTiming",
    });
    expectResponseToMatch("consoleUpdateStorefrontSettings", payLater);
    expect(answer(live)).toEqual([403, "FEATURE_DISABLED"]);
    expect(live.body.error.details).toEqual({ feature: "airlineCard" });
    expectResponseToMatch("consoleUpdateStorefrontSettings", live);
    const after = await current(owner);
    expect(after.etag).toBe(etag);
    expect(after.settings["policies"]).toEqual(policies);
  });

  it("[FIX-W35-OTA AC6] refuses only turning the live airline card on while the switch is off: keeping a stored true, or setting false, passes", async () => {
    const owner = await signIn(alphaId, "owner");
    const liveFlag = async () =>
      (
        await tenantTx(tenantDb, "tenant_alpha", (trx) =>
          trx.selectFrom("storefront_settings").select("airline_card_enabled_live").executeTakeFirstOrThrow(),
        )
      ).airline_card_enabled_live;
    // 1. From a stored false: refused, nothing saved.
    const before = await current(owner);
    const turnOn = await owner.patch({ airlineCard: { enabledTest: false, enabledLive: true } }, before.etag);
    expect(answer(turnOn)).toEqual([403, "FEATURE_DISABLED"]);
    expect(turnOn.body.error.details).toEqual({ feature: "airlineCard" });
    expectResponseToMatch("consoleUpdateStorefrontSettings", turnOn);
    expect((await current(owner)).etag).toBe(before.etag);
    expect(await liveFlag()).toBe(false);

    // The live card was turned on while the switch was on (written as that save would have), then the switch went off.
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.updateTable("storefront_settings").set({ airline_card_enabled_live: true }).execute(),
    );
    try {
      const stored = await current(owner);
      expect(stored.settings["airlineCard"]).toEqual({
        enabledTest: false,
        enabledLive: true,
        liveAvailable: false,
      });
      // 2. A save that keeps the stored true passes: the section sent back as get answered it, and another section.
      const kept = await owner.patch({ airlineCard: stored.settings["airlineCard"] }, stored.etag);
      expect(answer(kept)).toEqual([200, undefined]);
      expectResponseToMatch("consoleUpdateStorefrontSettings", kept);
      expect(kept.body.airlineCard).toEqual({ enabledTest: false, enabledLive: true, liveAvailable: false });
      const other = await owner.patch(
        { features: stored.settings["features"], airlineCard: { enabledTest: true, enabledLive: true } },
        kept.headers["etag"] as string,
      );
      expect(answer(other)).toEqual([200, undefined]);
      expect(await liveFlag()).toBe(true);
      // 3. Setting it false passes, and then it cannot be turned on again.
      const off = await owner.patch(
        { airlineCard: { enabledTest: true, enabledLive: false } },
        other.headers["etag"] as string,
      );
      expect(answer(off)).toEqual([200, undefined]);
      expectResponseToMatch("consoleUpdateStorefrontSettings", off);
      expect(off.body.airlineCard).toEqual({ enabledTest: true, enabledLive: false, liveAvailable: false });
      expect(await liveFlag()).toBe(false);
      const again = await owner.patch(
        { airlineCard: { enabledTest: true, enabledLive: true } },
        off.headers["etag"] as string,
      );
      expect(answer(again)).toEqual([403, "FEATURE_DISABLED"]);
    } finally {
      await tenantTx(tenantDb, "tenant_alpha", (trx) =>
        trx
          .updateTable("storefront_settings")
          .set({ airline_card_enabled_live: false, airline_card_enabled_test: false })
          .execute(),
      );
    }
  });

  it("needs If-Match, answers a stale one 412 and takes it quoted, weak or bare", async () => {
    const owner = await signIn(alphaId, "owner");
    const { settings, etag } = await current(owner);
    const version = Number(settings["version"]);
    const support = (email: string) => ({
      support: { email, phone: null, hours: null, helpCenterUrl: null, emergencyPhone: null },
    });

    const missing = await owner.patch(support("help@alpha-travel.example"));
    const stale = await owner.patch(support("help@alpha-travel.example"), `"${version - 1}"`);
    const quoted = await owner.patch(support("help@alpha-travel.example"), etag);
    const weak = await owner.patch(support("care@alpha-travel.example"), `W/"${version + 1}"`);
    const bare = await owner.patch(support("desk@alpha-travel.example"), String(version + 2));

    expect(answer(missing)).toEqual([400, "VALIDATION_FAILED"]);
    expect(missing.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/header/If-Match", code: "required" }),
    ]);
    expect(answer(stale)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("consoleUpdateStorefrontSettings", stale);
    expect([quoted, weak, bare].map((res) => [res.status, res.body.version])).toEqual([
      [200, version + 1],
      [200, version + 2],
      [200, version + 3],
    ]);
    expect((await storefrontKey()).body.support.email).toBe("desk@alpha-travel.example");
  });

  it("refuses with the schema a font outside the bundled list and TTLs out of range (400)", async () => {
    const owner = await signIn(alphaId, "owner");
    const { settings, etag } = await current(owner);
    const branding = settings["branding"] as Json;
    const policies = settings["policies"] as Json;

    const font = await owner.patch(
      { branding: { ...branding, fonts: { heading: "Comic Sans MS", body: "Inter" } } },
      etag,
    );
    const ttl = await owner.patch(
      { policies: { ...policies, offerTtlMinutes: 4, checkoutTtlMinutes: 1441 } },
      etag,
    );

    expect(answer(font)).toEqual([400, "VALIDATION_FAILED"]);
    expect(font.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/branding/fonts/heading", code: "enum" }),
    ]);
    expect(answer(ttl)).toEqual([400, "VALIDATION_FAILED"]);
    expect(ttl.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/policies/offerTtlMinutes", code: "minimum" }),
      expect.objectContaining({ path: "/policies/checkoutTtlMinutes", code: "maximum" }),
    ]);
  });

  it("checks currencies, time zones and countries against the reference data, and assets and pages against the tenant's", async () => {
    const owner = await signIn(alphaId, "owner");
    const { settings, etag } = await current(owner);
    const brand = settings["brand"] as Json;
    const branding = settings["branding"] as Json;
    const legal = settings["legal"] as Json;
    const seo = settings["seo"] as Json;
    const refusals: Array<[string, Json]> = [
      ["unknown_currency", { currencies: { default: "JPY", supported: ["JPY"] } }],
      ["unknown_currency", { currencies: { default: "EUR", supported: ["EUR", "DEM"] } }],
      ["currency_not_supported", { currencies: { default: "KWD", supported: ["KWD", "EUR"] } }],
      ["unknown_time_zone", { brand: { ...brand, timeZone: "Mars/Olympus_Mons" } }],
      ["asset_kind", { branding: { ...branding, logoAssetId: faviconId } }],
      ["asset_not_found", { seo: { ...seo, ogImageAssetId: newId("ast") } }],
      ["page_not_found", { legal: { ...legal, links: [{ kind: "other", label: "FAQ", pageSlug: "faq" }] } }],
      [
        "unknown_country",
        {
          currencies: { default: "EUR", supported: ["EUR"] },
          markets: {
            default: "DE",
            list: [{ countryCode: "DE", name: "Germany", currency: "EUR", locale: "en" }],
          },
        },
      ],
      ["default_not_supported", { currencies: { default: "EUR", supported: ["GBP"] } }],
    ];

    for (const [reason, body] of refusals) {
      const res = await owner.patch(body, etag);
      expect([reason, ...answer(res), res.body.error?.details?.reason]).toEqual([
        reason,
        422,
        "UNPROCESSABLE",
        reason,
      ]);
      expectResponseToMatch("consoleUpdateStorefrontSettings", res);
    }

    const accepted = await owner.patch(
      {
        brand: { ...brand, timeZone: "Europe/London" },
        currencies: { default: "GBP", supported: ["GBP", "EUR"] },
        markets: {
          default: "GB",
          list: [
            { countryCode: "GB", name: "United Kingdom", currency: "GBP", locale: "en" },
            { countryCode: "FR", name: "France", currency: "EUR", locale: "en" },
          ],
        },
        legal: {
          termsVersion: "2026-10",
          privacyVersion: null,
          links: [{ kind: "terms", label: "Terms", pageSlug: "terms" }],
        },
        seo: { ...seo, ogImageAssetId: ogImageId },
      },
      etag,
    );
    expect(answer(accepted)).toEqual([200, undefined]);
    const config = await storefrontKey();
    expect(config.body).toMatchObject({
      timeZone: "Europe/London",
      defaultCurrency: "GBP",
      defaultMarket: "GB",
      markets: [{ countryCode: "GB" }, { countryCode: "FR" }],
      legal: { termsUrl: "https://alpha.ota.example.com/p/terms", termsVersion: "2026-10" },
      seo: { ogImageUrl: `${PUBLIC_API}/v1/assets/alpha/${ogImageId}.jpg` },
    });
    // jsonb arrays are stored as JSON arrays, never as PostgreSQL arrays.
    const types = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      sql<{ markets: string; links: string }>`
        SELECT jsonb_typeof(markets) AS markets, jsonb_typeof(legal_links) AS links FROM storefront_settings
      `.execute(trx),
    );
    expect(types.rows).toEqual([{ markets: "array", links: "array" }]);
  });

  it("warns when the airline card is turned on while a markup or fee rule adds an amount, and not for the default 0 % rule or rules that do not apply", async () => {
    const owner = await signIn(alphaId, "owner");
    const day = 24 * 60 * 60 * 1000;
    const tenPercent = (
      id: string,
      window: { isActive: boolean; activeFrom?: Date; activeUntil?: Date },
    ) => ({
      id,
      name: "Ten percent",
      scope: JSON.stringify({}),
      calculation: "percentage",
      percentage: "10",
      priority: 10,
      stackable: false,
      is_default: false,
      is_active: window.isActive,
      active_from: window.activeFrom ?? null,
      active_until: window.activeUntil ?? null,
    });
    const ended = newId("mkr");
    const inactive = newId("mkr");
    const active = newId("mkr");
    const fee = newId("fee");
    const turnOn = { airlineCard: { enabledTest: true, enabledLive: false } };
    const turnOff = { airlineCard: { enabledTest: false, enabledLive: false } };
    /** Turns the test flag on, then off again; the answer of turning it on. */
    const toggle = async (): Promise<Response> => {
      const on = await owner.patch(turnOn, (await current(owner)).etag);
      expect((await owner.patch(turnOff, on.headers["etag"] as string)).status).toBe(200);
      return on;
    };
    try {
      const defaultOnly = await toggle();
      await tenantTx(tenantDb, "tenant_alpha", (trx) =>
        trx
          .insertInto("markup_rules")
          .values([
            tenPercent(ended, {
              isActive: true,
              activeFrom: new Date(Date.now() - 3 * day),
              activeUntil: new Date(Date.now() - day),
            }),
            tenPercent(inactive, { isActive: false }),
          ])
          .execute(),
      );
      const notApplying = await toggle();
      await tenantTx(tenantDb, "tenant_alpha", (trx) =>
        trx
          .insertInto("fee_rules")
          .values({
            id: fee,
            name: "Service fee",
            label: "Service fee",
            fee_type: "booking_service",
            calculation: "fixed",
            fixed_amount: "5.00",
            currency: "EUR",
          })
          .execute(),
      );
      const withFee = await toggle();
      await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
        await trx.deleteFrom("fee_rules").where("id", "=", fee).execute();
        await trx
          .insertInto("markup_rules")
          .values(tenPercent(active, { isActive: true }))
          .execute();
      });
      const withMarkup = await owner.patch(turnOn, (await current(owner)).etag);

      expect([defaultOnly.status, defaultOnly.body.warnings]).toEqual([200, []]);
      expect([notApplying.status, notApplying.body.warnings]).toEqual([200, []]);
      for (const res of [withFee, withMarkup]) {
        expect(answer(res)).toEqual([200, undefined]);
        expectResponseToMatch("consoleUpdateStorefrontSettings", res);
        expect(res.body.warnings).toEqual([
          { code: "airline_card_net_price", message: expect.any(String), path: "/airlineCard/enabledTest" },
        ]);
      }
      expect(withMarkup.body.airlineCard).toEqual({
        enabledTest: true,
        enabledLive: false,
        liveAvailable: false,
      });
    } finally {
      await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
        await trx.deleteFrom("fee_rules").where("id", "=", fee).execute();
        await trx.deleteFrom("markup_rules").where("id", "in", [ended, inactive, active]).execute();
      });
    }
  });

  it("lets only owners and admins write: an agent and a viewer are refused 403 FORBIDDEN", async () => {
    const admin = await signIn(alphaId, "admin");
    const { settings, etag } = await current(admin);
    const body = { features: settings["features"] };

    const agent = await (await signIn(alphaId, "agent")).patch(body, etag);
    const viewer = await (await signIn(alphaId, "viewer")).patch(body, etag);
    const allowed = await admin.patch(body, etag);

    for (const res of [agent, viewer]) {
      expect(answer(res)).toEqual([403, "FORBIDDEN"]);
      expect(res.body.error.details).toEqual({ requiredPermission: "settings:write" });
      expectResponseToMatch("consoleUpdateStorefrontSettings", res);
    }
    expect(answer(allowed)).toEqual([200, undefined]);
  });

  it("writes a staff_actions row with the sections before and after, and a failed one for a refusal", async () => {
    const owner = await signIn(alphaId, "owner");
    const { settings, etag } = await current(owner);
    const operations = {
      opsAlertEmail: "ops@alpha-travel.example",
      bookingQueue: { number: 61, category: 2 },
    };

    const saved = await owner.patch({ operations }, etag);
    const refused = await owner.patch(
      { currencies: { default: "JPY", supported: ["JPY"] } },
      saved.headers["etag"] as string,
    );

    expect(saved.status).toBe(200);
    expect(refused.status).toBe(422);
    const rows = (await staffActions("tenant_alpha", owner.member.staffId)).filter(
      (row) => row["action"] === "settings.storefront.update",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        actor_type: "staff",
        staff_role: "owner",
        outcome: "succeeded",
        target_type: "storefront_settings",
        target_id: "sfs_default",
        before: { version: settings["version"], operations: settings["operations"] },
        after: { version: Number(settings["version"]) + 1, operations },
      }),
      expect.objectContaining({ outcome: "failed", before: null, after: null }),
    ]);
  });

  it("accepts its own answer back unchanged and touches no other tenant's row", async () => {
    const owner = await signIn(alphaId, "owner");
    const { settings, etag } = await current(owner);
    const { version, updatedAt: _updatedAt, ...sections } = settings;

    const res = await owner.patch(sections, etag);

    expect(answer(res)).toEqual([200, undefined]);
    const { version: savedVersion, updatedAt: _savedAt, warnings, ...saved } = res.body as Json;
    expect([savedVersion, warnings, saved]).toEqual([Number(version) + 1, [], sections]);
    const beta = await tenantTx(tenantDb, "tenant_beta", (trx) =>
      trx.selectFrom("storefront_settings").select(["brand_name", "version"]).executeTakeFirstOrThrow(),
    );
    expect(beta).toEqual({ brand_name: "Beta Trips", version: 1 });
  });
});
