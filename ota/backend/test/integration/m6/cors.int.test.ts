// CORS of the OTA API against PostgreSQL 16 and Redis 7 (OBE-097; lead decision (15h) of 2026-11-11, decisions.md §5,
// common/http/cors.ts, the document's `info.description` "Browsers on other origins"): a browser page on its own origin
// calls the API with a publishable key.
//
//   preflight (OPTIONS with Origin and Access-Control-Request-Method)  204 on any path, the origin echoed, the methods,
//                                                                      the SDK's headers, Max-Age, Vary: Origin; no key
//   publishable key, Origin it lists                                   the answer is opened to that origin
//                                                                      (Allow-Origin, Expose-Headers, Vary: Origin),
//                                                                      the later guards' refusals (401, 429) included
//   publishable key, Origin it does not list                           403 ORIGIN_NOT_ALLOWED, no CORS header
//   publishable key without Origin, secret key, refused key, the edge  no CORS header
//
// and `Access-Control-Allow-Credentials` on no answer at all. Every answer but the edge's varies by `Origin` (lead
// decision (17e) of 2026-11-11, FIX-W49-OTA), with or without an `Origin` and whatever answers it: the body parsers,
// the router's `404`, a refused key, a guard or the operation; the edge's answers do not change. The file clones the
// @velexis/testing template and writes alpha's platform rows as the platform does: an active OTA on its test
// storefront, its storefront settings, a publishable test key that lists the page's origin, a revoked one that lists
// it too, and a secret key scoped `storefront`. All requests run in a `beforeAll` hook; the tests read what the API
// answered.
import { randomUUID } from "node:crypto";
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
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORS_ALLOWED_HEADERS } from "../../../src/common/http/cors";
import { RATE_LIMITS } from "../../../src/common/http/rate-limits";
import { newId } from "../../../src/common/ids";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { newApiKey, TEST_STOREFRONT_BASE_DOMAIN, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const HOST = `alpha.${TEST_STOREFRONT_BASE_DOMAIN}`;
/** The OTA's own frontend, which its publishable key lists, and an origin the key does not list. */
const SHOP = "https://shop.alpha-travel.example";
const OTHER = "https://evil.example.com";
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/** About forty-five requests: well under a second; the budget only stops a hang. */
const REQUESTS_TIMEOUT_MS = 60_000;

/** The CORS response headers, lower case as Supertest gives them. */
const CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-max-age",
] as const;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId = "";
let publishableKey = "";
let revokedKey = "";
let secretKey = "";

async function issueKey(kind: "pk" | "sk", options: { revoked?: boolean } = {}): Promise<string> {
  const key = newApiKey(kind);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: alphaId,
      name: kind === "pk" ? "Own frontend (test)" : "Own server (test)",
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      scopes: kind === "pk" ? [] : ["storefront"],
      ...(kind === "pk" ? { allowed_origins: [SHOP, "http://localhost:5500"] } : {}),
      ...(options.revoked === true ? { revoked_at: new Date() } : {}),
    })
    .execute();
  return key;
}

// ---- Requests -------------------------------------------------------------------------------------------------------

/** A browser's preflight from `origin` of a `method` call with the SDK's headers. */
const preflight = (path: string, origin: string, method: string): Promise<Response> =>
  request(api.server)
    .options(path)
    .set({
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "accept,content-type,idempotency-key,x-api-key,x-currency",
      // Caddy's forwarding headers, as on api.ota.example.com.
      "X-Forwarded-For": "203.0.113.97",
      "X-Forwarded-Host": "api.ota.example.com",
    })
    .then();

/** A browser on `origin` (or a server, without it) calling with `key`, through Caddy from `ip`. */
function keyCaller(key: string, origin: string | undefined, ip = "203.0.113.98"): Record<string, string> {
  return {
    "X-Api-Key": key,
    ...(origin === undefined ? {} : { Origin: origin }),
    "X-Forwarded-For": ip,
    "X-Forwarded-Host": "api.ota.example.com",
  };
}

/** The hosted storefront of alpha through Caddy (same origin). */
const edge = (): Record<string, string> => ({
  "X-Velexis-Edge": testApiCredentials().edgeSecret,
  "X-Velexis-Host": HOST,
  "X-Forwarded-For": "203.0.113.99",
  "X-Forwarded-Host": HOST,
  Origin: `https://${HOST}`,
});

const get = (path: string, headers: Record<string, string>): Promise<Response> =>
  request(api.server).get(path).set(headers).then();
const post = (path: string, headers: Record<string, string>, body: unknown = []): Promise<Response> =>
  request(api.server)
    .post(path)
    .set({ ...headers, "Idempotency-Key": randomUUID() })
    .send(body as object)
    .then();

/** Every answer the tests read, by a label that says what it is. */
const answers = new Map<string, Response>();
const answerOf = (label: string): Response => {
  const res = answers.get(label);
  if (res === undefined) {
    throw new Error(`no answer ${label}`);
  }
  return res;
};

/** The CORS headers of an answer, by lower-case name. */
function corsOf(res: Response): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of CORS_HEADERS) {
    const value = res.headers[name] as string | undefined;
    if (value !== undefined) {
      found[name] = value;
    }
  }
  return found;
}

const varyOf = (res: Response): string[] =>
  String(res.headers["vary"] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");

const codeOf = (res: Response): string | undefined =>
  (res.body as { error?: { code?: string } } | undefined)?.error?.code;

/** An actual answer opened to `origin`. */
function expectOpenedTo(res: Response, origin: string): void {
  expect(corsOf(res)).toEqual({
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "X-Request-Id, Retry-After, ETag, Location",
  });
  expect(varyOf(res)).toContain("origin");
}

/** An answer of the API that is not opened to any page: no CORS header, but varying by Origin (17e). */
function expectClosed(res: Response): void {
  expect(corsOf(res)).toEqual({});
  expect(varyOf(res)).toContain("origin");
}

/** An answer of the hosted storefront's edge: no CORS header and not varying by Origin, as before OBE-097. */
function expectEdgeAnswer(res: Response): void {
  expect(corsOf(res)).toEqual({});
  expect(varyOf(res)).not.toContain("origin");
}

const PREFLIGHT_PATHS: ReadonlyArray<readonly [string, string]> = [
  ["/v1/storefront", "GET"],
  ["/v1/flight-searches", "POST"],
  ["/v1/checkouts/chk_0123456789ABCDEFGHJK/travelers", "PUT"],
  ["/v1/account", "PATCH"],
  ["/v1/account", "DELETE"],
  ["/v1/no-such-path", "GET"],
];

beforeAll(async () => {
  preloadOpenApiDocument();
  responseChecker("ota");
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
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
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: alphaId,
      key: "alpha",
      name: "Alpha Travel",
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/Madrid",
      storefront_environment: "test",
    })
    .execute();
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" }),
  );
  publishableKey = await issueKey("pk");
  revokedKey = await issueKey("pk", { revoked: true });
  secretKey = await issueKey("sk");
  api = await createTestApp({ database: db, redis });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

beforeAll(async () => {
  for (const origin of [SHOP, OTHER]) {
    for (const [path, method] of PREFLIGHT_PATHS) {
      answers.set(`preflight ${origin} ${method} ${path}`, await preflight(path, origin, method));
    }
  }
  answers.set(
    "edge preflight",
    await request(api.server)
      .options("/v1/storefront")
      .set({
        ...edge(),
        "Access-Control-Request-Method": "GET",
      }),
  );

  answers.set("listed", await get("/v1/storefront", keyCaller(publishableKey, SHOP)));
  answers.set(
    "listed local",
    await get("/v1/storefront", keyCaller(publishableKey, "http://localhost:5500")),
  );
  answers.set("unlisted", await get("/v1/storefront", keyCaller(publishableKey, OTHER)));
  answers.set("no origin", await get("/v1/storefront", keyCaller(publishableKey, undefined)));
  answers.set("revoked", await get("/v1/storefront", keyCaller(revokedKey, SHOP)));
  answers.set("unknown key", await get("/v1/storefront", keyCaller(newApiKey("pk"), SHOP)));
  answers.set("secret", await get("/v1/storefront", keyCaller(secretKey, SHOP)));
  answers.set("secret no origin", await get("/v1/storefront", keyCaller(secretKey, undefined)));
  answers.set("edge", await get("/v1/storefront", edge()));
  answers.set("edge reference", await get("/v1/reference/currencies", edge()));
  answers.set("edge no operation", await get("/v1/no-such-path", edge()));
  // Answers given before the key is checked, or without any key (17e).
  answers.set("no operation", await get("/v1/no-such-path", keyCaller(publishableKey, SHOP)));
  answers.set("no operation no origin", await get("/v1/no-such-path", keyCaller(secretKey, undefined)));
  // Before any middleware: the router cannot decode the path, and the error filter answers.
  answers.set("undecodable path", await get("/v1/%E0%A4%A", keyCaller(publishableKey, SHOP)));
  answers.set(
    "malformed body",
    await request(api.server)
      .post("/v1/flight-searches")
      .set({
        ...keyCaller(publishableKey, SHOP),
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      })
      .send("{not json"),
  );
  answers.set("no key", await get("/v1/storefront", { Origin: SHOP, "X-Forwarded-For": "203.0.113.98" }));
  answers.set("health", await get("/health/live", { Origin: SHOP }));
  answers.set("secret reference", await get("/v1/reference/currencies", keyCaller(secretKey, undefined)));
  // A cacheable answer whose handler sets Vary itself (the reference operations' `@Header("Vary", "Accept-Language")`).
  answers.set("reference", await get("/v1/reference/currencies", keyCaller(publishableKey, SHOP)));
  // A later guard's refusal: account.get needs a signed-in customer.
  answers.set("unauthenticated", await get("/v1/account", keyCaller(publishableKey, SHOP)));
  // The sign-in limit (10 a minute per address) used up from the page with bodies the validation refuses, as in
  // rate-limits.int.test.ts: ten 400s, then the 429.
  for (let index = 1; index <= RATE_LIMITS.signIn.limit; index += 1) {
    answers.set(
      `sign-in ${index}`,
      await post("/v1/auth/sign-in", keyCaller(publishableKey, SHOP, "192.0.2.97")),
    );
  }
  answers.set("limited", await post("/v1/auth/sign-in", keyCaller(publishableKey, SHOP, "192.0.2.97")));
}, REQUESTS_TIMEOUT_MS);

describe("preflights", () => {
  it("[OBE-097 AC1] answers a preflight on any path from any origin 204 with the origin, the methods, the SDK's headers, Max-Age and Vary: Origin", () => {
    for (const origin of [SHOP, OTHER]) {
      for (const [path, method] of PREFLIGHT_PATHS) {
        const res = answerOf(`preflight ${origin} ${method} ${path}`);

        expect([origin, method, path, res.status, res.text]).toEqual([origin, method, path, 204, ""]);
        expect(corsOf(res)).toEqual({
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
          "access-control-allow-headers": CORS_ALLOWED_HEADERS.join(", "),
          "access-control-max-age": "7200",
        });
        expect(varyOf(res)).toEqual(["origin"]);
      }
    }
  });

  it("[OBE-097 AC1] allows every header the SDK sends", () => {
    const allowed = String(
      answerOf(`preflight ${SHOP} POST /v1/flight-searches`).headers["access-control-allow-headers"],
    )
      .split(", ")
      .map((name) => name.toLowerCase());

    expect(allowed).toEqual(
      expect.arrayContaining([
        "x-api-key",
        "authorization",
        "x-booking-token",
        "idempotency-key",
        "if-match",
        "content-type",
        "accept-language",
        "x-currency",
      ]),
    );
  });

  it("[OBE-097 AC1] leaves the storefront edge's preflights as they were: 404 without CORS headers", () => {
    const res = answerOf("edge preflight");

    expect([res.status, codeOf(res)]).toEqual([404, "NOT_FOUND"]);
    expectEdgeAnswer(res);
  });
});

describe("actual answers", () => {
  it("[OBE-097 AC1] opens the answer to an origin the publishable key lists, with the exposed headers and Vary: Origin", () => {
    const listed = answerOf("listed");
    const local = answerOf("listed local");

    expect([listed.status, local.status]).toEqual([200, 200]);
    expectResponseToMatch("getStorefront", listed);
    expectOpenedTo(listed, SHOP);
    expectOpenedTo(local, "http://localhost:5500");
    expect(listed.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("[OBE-097 AC1] keeps Origin in Vary on a cacheable answer whose handler sets its own Vary", () => {
    const res = answerOf("reference");

    expect(res.status).toBe(200);
    expectResponseToMatch("listCurrencies", res);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expectOpenedTo(res, SHOP);
    expect(varyOf(res)).toEqual(expect.arrayContaining(["accept-language", "origin"]));
  });

  it("[OBE-097 AC1] keeps the guards' later refusals readable: 401 UNAUTHENTICATED and the 429 with its Retry-After", () => {
    const unauthenticated = answerOf("unauthenticated");
    const limited = answerOf("limited");

    expect([unauthenticated.status, codeOf(unauthenticated)]).toEqual([401, "UNAUTHENTICATED"]);
    expectOpenedTo(unauthenticated, SHOP);
    for (let index = 1; index <= RATE_LIMITS.signIn.limit; index += 1) {
      const res = answerOf(`sign-in ${index}`);
      expect([index, res.status, codeOf(res)]).toEqual([index, 400, "VALIDATION_FAILED"]);
      expectOpenedTo(res, SHOP);
    }
    expect([limited.status, codeOf(limited)]).toEqual([429, "RATE_LIMITED"]);
    expectResponseToMatch("signIn", limited);
    expectOpenedTo(limited, SHOP);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(String(limited.headers["access-control-expose-headers"])).toContain("Retry-After");
  });

  it("[OBE-097 AC1] gives an origin the key does not list none, and keeps its 403 ORIGIN_NOT_ALLOWED", () => {
    const res = answerOf("unlisted");

    expect([res.status, codeOf(res)]).toEqual([403, "ORIGIN_NOT_ALLOWED"]);
    expectResponseToMatch("getStorefront", res);
    expectClosed(res);
  });

  it("[OBE-097 AC1] gives none to a request without Origin, a secret key, or a key that is refused", () => {
    const noOrigin = answerOf("no origin");
    const secret = answerOf("secret");
    const secretNoOrigin = answerOf("secret no origin");
    const revoked = answerOf("revoked");
    const unknown = answerOf("unknown key");

    expect([noOrigin.status, secret.status, secretNoOrigin.status]).toEqual([200, 200, 200]);
    expect([revoked.status, codeOf(revoked)]).toEqual([401, "INVALID_API_KEY"]);
    expect([unknown.status, codeOf(unknown)]).toEqual([401, "INVALID_API_KEY"]);
    for (const res of [noOrigin, secret, secretNoOrigin, revoked, unknown]) {
      expectClosed(res);
    }
  });

  it("[OBE-097 AC1] leaves the hosted storefront's same-origin answers as they were", () => {
    const res = answerOf("edge");

    expect(res.status).toBe(200);
    expectResponseToMatch("getStorefront", res);
    expectEdgeAnswer(res);
  });

  it("[FIX-W49-OTA AC1] varies by Origin the answers given before the key is checked or without one: the body parsers', the router's, no key, a public route", () => {
    const noOperation = answerOf("no operation");
    const noOperationNoOrigin = answerOf("no operation no origin");
    const undecodable = answerOf("undecodable path");
    const malformed = answerOf("malformed body");
    const noKey = answerOf("no key");
    const health = answerOf("health");

    expect([noOperation.status, codeOf(noOperation)]).toEqual([404, "NOT_FOUND"]);
    expect([noOperationNoOrigin.status, codeOf(noOperationNoOrigin)]).toEqual([404, "NOT_FOUND"]);
    expect([undecodable.status, codeOf(undecodable)]).toEqual([400, "INVALID_REQUEST"]);
    expect([malformed.status, codeOf(malformed)]).toEqual([400, "INVALID_REQUEST"]);
    expect([noKey.status, codeOf(noKey)]).toEqual([401, "INVALID_API_KEY"]);
    expect(health.status).toBe(200);
    for (const res of [noOperation, noOperationNoOrigin, undecodable, malformed, noKey, health]) {
      expectClosed(res);
      expect(varyOf(res)).toEqual(["origin"]);
    }
  });

  it("[FIX-W49-OTA AC1] varies every answer without an Origin by it too, a cacheable one whose handler sets its own Vary included", () => {
    const noOrigin = answerOf("no origin");
    const secretNoOrigin = answerOf("secret no origin");
    const reference = answerOf("secret reference");

    expect([noOrigin.status, secretNoOrigin.status, reference.status]).toEqual([200, 200, 200]);
    expect(varyOf(noOrigin)).toEqual(["origin", "accept-language", "x-api-key"]);
    expect(varyOf(secretNoOrigin)).toEqual(["origin", "accept-language", "x-api-key"]);
    expectResponseToMatch("listCurrencies", reference);
    expect(reference.headers["cache-control"]).toBe("public, max-age=3600");
    expect(varyOf(reference)).toEqual(["accept-language", "origin"]);
    for (const res of [noOrigin, secretNoOrigin, reference]) {
      expectClosed(res);
    }
  });

  it("[FIX-W49-OTA AC1] leaves every answer of the storefront edge without Vary: Origin, its Origin notwithstanding", () => {
    const storefront = answerOf("edge");
    const reference = answerOf("edge reference");
    const noOperation = answerOf("edge no operation");

    expect([storefront.status, reference.status, noOperation.status]).toEqual([200, 200, 404]);
    expect(storefront.headers["vary"]).toBe("Accept-Language");
    expect(reference.headers["vary"]).toBe("Accept-Language");
    expect(noOperation.headers["vary"]).toBeUndefined();
    for (const res of [storefront, reference, noOperation, answerOf("edge preflight")]) {
      expectEdgeAnswer(res);
    }
  });

  it("[OBE-097 AC1] never sends Access-Control-Allow-Credentials", () => {
    expect(answers.size).toBeGreaterThan(30);
    for (const [label, res] of answers) {
      expect([label, res.headers["access-control-allow-credentials"]]).toEqual([label, undefined]);
    }
  });
});
