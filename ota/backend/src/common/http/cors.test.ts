// CORS of the OTA API (OBE-097, cors.ts; Vary: Origin on every answer but the edge's, lead decision (17e) of
// 2026-11-11, FIX-W49-OTA) in the API's own pipeline, in process with dummy services: probe controllers stand for
// operations, and the platform repository is spied on, so a key row or a tenant is whatever a test sets (an edge
// request or a preflight never reaches it). The lists of allowed and exposed headers are checked against the OTA
// document and the SDK's source. The same answers against PostgreSQL and Redis: test/integration/m6/cors.int.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Body, Controller, Get, Header, Patch, Post } from "@nestjs/common";
import { hashApiKey } from "@velexis/crypto";
import request, { type Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../../test/helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../../test/helpers/openapi";
import { createTestApp, type TestApp } from "../../../test/support/create-test-app";
import type { Caller } from "../../tenancy/caller-resolver";
import { PlatformReadRepository, type PlatformApiKey } from "../../tenancy/platform-read.repository";
import type { PlatformTenant } from "../../tenancy/platform-read.types";
import { TenancyModule } from "../../tenancy/tenancy.module";
import { PublicRoute } from "../auth/caller.guard";
import { newId } from "../ids";
import {
  allowCorsAnswer,
  corsAnswerOrigin,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  CORS_MAX_AGE_SECONDS,
  isEdgeRequest,
  isSerializedOrigin,
  preflightOrigin,
  varyByOrigin,
} from "./cors";
import { loadOpenApiDocument } from "./openapi-validation.interceptor";
import { OpenApiOperation } from "./openapi-operation.decorator";

const TENANT_ID = newId("ten");
/** The page origin the publishable key lists, and one it does not. */
const SHOP = "https://shop.alpha-travel.example";
const OTHER = "https://evil.example.com";
const PUBLISHABLE_KEY = newApiKey("pk");
const SECRET_KEY = newApiKey("sk");
/** A probe bound to updatePayment (no Idempotency-Key, no rate limit), so its body is validated after the guards. */
const PAYMENT_PROBE = "/__cors/payments/pay_0123456789ABCDEFGHJK";
const PAYMENT_UPDATE = { card: { brand: "VISA", bin: "424242" } };

/** The CORS headers an answer may carry, lower case as Supertest gives them. */
const CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-max-age",
] as const;

@Controller("__cors")
class CorsProbe {
  @Get("key")
  key(): { ok: true } {
    return { ok: true };
  }

  /** As the reference operations: a cacheable answer whose `Vary` the handler sets anew after the guards. */
  @Get("cacheable")
  @Header("Cache-Control", "public, max-age=3600")
  @Header("Vary", "Accept-Language")
  cacheable(): { ok: true } {
    return { ok: true };
  }

  @Patch("payments/:paymentId")
  @OpenApiOperation("updatePayment")
  updatePayment(@Body() _body: unknown): { ok: true } {
    return { ok: true };
  }

  @Get("public")
  @PublicRoute()
  public(): { ok: true } {
    return { ok: true };
  }

  /** A route whose body the parsers read: a body they refuse is answered before the caller guard. */
  @Post("body")
  @PublicRoute()
  body(@Body() _body: unknown): { ok: true } {
    return { ok: true };
  }
}

let api: TestApp;

// Starting the application parses and compiles the OTA document: one-time work with the budget of
// test/helpers/openapi.ts, here and not in the first test. The header lists' tests read the same parsed document.
beforeAll(async () => {
  preloadOpenApiDocument();
  api = await createTestApp({ controllers: [CorsProbe], imports: [TenancyModule.forApi()] });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The `platform.api_keys` row of `key` under the test process's pepper, listing `SHOP` for a publishable key. */
function rowOf(key: string): PlatformApiKey {
  return {
    id: newId("key"),
    tenantId: TENANT_ID,
    kind: key.startsWith("pk_") ? "publishable" : "secret",
    environment: "test",
    prefix: key.slice(0, 14),
    keyHash: hashApiKey(key, testApiCredentials().pepper),
    allowedOrigins: key.startsWith("pk_") ? [SHOP] : [],
    scopes: [],
    expiresAt: null,
    revokedAt: null,
  };
}

/** Spies on the platform lookups: the key row of `key` (if any) and an OTA of `status`. */
function platform(key?: string, status: PlatformTenant["status"] = "active") {
  const repository = api.app.get(PlatformReadRepository);
  const tenant: PlatformTenant = {
    id: TENANT_ID,
    key: "alpha",
    name: "Alpha Travel",
    status,
    schemaName: "tenant_alpha" as PlatformTenant["schemaName"],
    storefrontEnvironment: "test",
    defaultCurrency: "EUR",
    defaultLocale: "en",
    billingNotice: null,
  };
  return {
    apiKeyByPrefix: vi
      .spyOn(repository, "apiKeyByPrefix")
      .mockResolvedValue(key === undefined ? null : rowOf(key)),
    tenantById: vi.spyOn(repository, "tenantById").mockResolvedValue(tenant),
    tenantByKey: vi.spyOn(repository, "tenantByKey").mockResolvedValue(tenant),
  };
}

/** A browser's preflight of a call with the SDK's headers. */
const preflight = (path: string, origin: string, method = "POST"): Promise<Response> =>
  request(api.server)
    .options(path)
    .set({
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "content-type,idempotency-key,x-api-key",
    })
    .then();

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

/** The `Vary` names of an answer, lower case. */
const varyOf = (res: Response): string[] =>
  String(res.headers["vary"] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");

/** An actual answer opened to `origin`: the origin, the exposed headers and `Vary: Origin`, never credentials. */
function expectOpenedTo(res: Response, origin: string): void {
  expect(corsOf(res)).toEqual({
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "X-Request-Id, Retry-After, ETag, Location",
  });
  expect(varyOf(res)).toContain("origin");
}

/** An answer of the API that is not opened to any page: no CORS header, but it still varies by Origin (17e). */
function expectClosed(res: Response): void {
  expect(corsOf(res)).toEqual({});
  expect(varyOf(res)).toContain("origin");
}

/** An answer of the hosted storefront's edge: no CORS header and, as before OBE-097, not varying by Origin. */
function expectEdgeAnswer(res: Response): void {
  expect(corsOf(res)).toEqual({});
  expect(varyOf(res)).not.toContain("origin");
}

const codeOf = (res: Response): string | undefined =>
  (res.body as { error?: { code?: string } } | undefined)?.error?.code;

describe("preflights", () => {
  it("[OBE-097 AC1] answers a preflight on any path 204 with the origin, methods, headers, max age and Vary: Origin, before any lookup", async () => {
    const lookups = platform(PUBLISHABLE_KEY);
    const paths = [
      "/v1/storefront",
      "/v1/checkouts/chk_0123456789ABCDEFGHJK/complete",
      "/v1/no-such-path",
      "/webhooks/stripe/velexis/test",
      "/health/live",
      PAYMENT_PROBE,
    ];

    // One after another: Supertest opens a listener per request on the one server.
    const answers: Response[] = [];
    for (const origin of [SHOP, OTHER, "http://localhost:5500"]) {
      for (const path of paths) {
        answers.push(await preflight(path, origin));
      }
    }

    for (const [index, res] of answers.entries()) {
      const origin = [SHOP, OTHER, "http://localhost:5500"][Math.floor(index / paths.length)] ?? "";
      expect([res.status, res.text]).toEqual([204, ""]);
      expect(corsOf(res)).toEqual({
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
        "access-control-allow-headers": CORS_ALLOWED_HEADERS.join(", "),
        "access-control-max-age": String(CORS_MAX_AGE_SECONDS),
      });
      expect(varyOf(res)).toEqual(["origin"]);
      // The answer has the pipeline's own headers: helmet's and the request id.
      expect(res.headers["content-security-policy"]).toBe("default-src 'none';frame-ancestors 'none'");
      expect(res.headers["x-request-id"]).toEqual(expect.any(String));
    }
    expect(lookups.apiKeyByPrefix).not.toHaveBeenCalled();
    expect(lookups.tenantById).not.toHaveBeenCalled();
  });

  it("[OBE-097 AC1] answers a preflight that carries a key the same, without looking the key up", async () => {
    const lookups = platform(PUBLISHABLE_KEY);

    const res = await request(api.server).options("/v1/storefront").set({
      Origin: OTHER,
      "Access-Control-Request-Method": "GET",
      "X-Api-Key": PUBLISHABLE_KEY,
    });

    expect(res.status).toBe(204);
    expect(corsOf(res)["access-control-allow-origin"]).toBe(OTHER);
    expect(lookups.apiKeyByPrefix).not.toHaveBeenCalled();
  });

  it("[OBE-097 AC1] does not answer an OPTIONS that is no preflight, from no serialized origin, or through the storefront edge", async () => {
    platform();

    const answers = await Promise.all([
      request(api.server).options("/v1/storefront"),
      request(api.server).options("/v1/storefront").set("Origin", SHOP),
      request(api.server)
        .options("/v1/storefront")
        .set({ Origin: "null", "Access-Control-Request-Method": "GET" }),
      request(api.server)
        .options("/v1/storefront")
        .set({ Origin: `${SHOP}/`, "Access-Control-Request-Method": "GET" }),
      request(api.server)
        .options("/v1/storefront")
        .set({ ...edgeHeaders(), Origin: SHOP, "Access-Control-Request-Method": "GET" }),
    ]);

    for (const res of answers) {
      // As before OBE-097: the router has no OPTIONS route, so the error envelope's 404.
      expect([res.status, codeOf(res)]).toEqual([404, "NOT_FOUND"]);
    }
    const edge = answers.pop();
    expect(edge).toBeDefined();
    expectEdgeAnswer(edge as Response);
    for (const res of answers) {
      expectClosed(res);
    }
  });
});

describe("actual answers", () => {
  it("[OBE-097 AC1] opens every answer to a publishable key's listed origin once the key is checked: success, validation and a later guard's refusal", async () => {
    platform(PUBLISHABLE_KEY);
    const key = { "X-Api-Key": PUBLISHABLE_KEY, Origin: SHOP };

    const ok = await request(api.server).get("/__cors/key").set(key);
    const valid = await request(api.server).patch(PAYMENT_PROBE).set(key).send(PAYMENT_UPDATE);
    const invalid = await request(api.server).patch(PAYMENT_PROBE).set(key).send({ nope: true });
    platform(PUBLISHABLE_KEY, "suspended");
    const suspended = await request(api.server).patch(PAYMENT_PROBE).set(key).send(PAYMENT_UPDATE);

    expect(ok.status).toBe(200);
    expect(valid.status).toBe(200);
    expect([invalid.status, codeOf(invalid)]).toEqual([400, "VALIDATION_FAILED"]);
    expect([suspended.status, codeOf(suspended)]).toEqual([403, "TENANT_SUSPENDED"]);
    for (const res of [ok, valid, invalid, suspended]) {
      expectOpenedTo(res, SHOP);
    }
  });

  it("[OBE-097 AC1] [FIX-W49-OTA AC1] keeps Origin in Vary when a handler sets Vary anew, on an answer it opens and on one it does not", async () => {
    platform(PUBLISHABLE_KEY);

    const opened = await request(api.server)
      .get("/__cors/cacheable")
      .set({ "X-Api-Key": PUBLISHABLE_KEY, Origin: SHOP });
    const serverCall = await request(api.server)
      .get("/__cors/cacheable")
      .set({ "X-Api-Key": PUBLISHABLE_KEY });

    expect([opened.status, serverCall.status]).toEqual([200, 200]);
    expectOpenedTo(opened, SHOP);
    expect(varyOf(opened)).toEqual(["accept-language", "origin"]);
    expectClosed(serverCall);
    expect(varyOf(serverCall)).toEqual(["accept-language", "origin"]);
  });

  it("[OBE-097 AC1] gives none to an origin the key does not list (403 ORIGIN_NOT_ALLOWED kept), a refused key, or a publishable key without Origin", async () => {
    platform(PUBLISHABLE_KEY);

    const unlisted = await request(api.server)
      .get("/__cors/key")
      .set({ "X-Api-Key": PUBLISHABLE_KEY, Origin: OTHER });
    const noOrigin = await request(api.server).get("/__cors/key").set({ "X-Api-Key": PUBLISHABLE_KEY });
    platform();
    const unknownKey = await request(api.server)
      .get("/__cors/key")
      .set({ "X-Api-Key": PUBLISHABLE_KEY, Origin: SHOP });

    expect([unlisted.status, codeOf(unlisted)]).toEqual([403, "ORIGIN_NOT_ALLOWED"]);
    expect([unknownKey.status, codeOf(unknownKey)]).toEqual([401, "INVALID_API_KEY"]);
    expect(noOrigin.status).toBe(200);
    for (const res of [unlisted, unknownKey, noOrigin]) {
      expectClosed(res);
    }
  });

  it("[OBE-097 AC1] gives none to a secret key, the storefront edge or an anonymous caller, whatever the Origin", async () => {
    platform(SECRET_KEY);

    const secret = await request(api.server)
      .get("/__cors/key")
      .set({ "X-Api-Key": SECRET_KEY, Origin: SHOP });
    const edge = await request(api.server)
      .get("/__cors/key")
      .set({ ...edgeHeaders(), Origin: "https://demo.ota.example.com" });
    const anonymous = await request(api.server).get("/__cors/public").set("Origin", SHOP);
    const noCredential = await request(api.server).get("/__cors/key").set("Origin", SHOP);

    expect([secret.status, edge.status, anonymous.status]).toEqual([200, 200, 200]);
    expect([noCredential.status, codeOf(noCredential)]).toEqual([401, "INVALID_API_KEY"]);
    for (const res of [secret, anonymous, noCredential]) {
      expectClosed(res);
    }
    expectEdgeAnswer(edge);
  });
});

describe("Vary: Origin", () => {
  it("[FIX-W49-OTA AC1] varies every answer but the edge's by Origin, with or without an Origin, whatever the key", async () => {
    // Each caller, from a server (no Origin) and from a page, on a route that needs a key, a public route and a path
    // that is no operation: the status each answers, by caller.
    const callers = [
      { label: "secret key", key: SECRET_KEY, statuses: [200, 200, 404] },
      { label: "anonymous", key: undefined, statuses: [401, 200, 404] },
      { label: "unknown key", key: newApiKey("pk"), statuses: [401, 401, 404] },
    ] as const;

    const answers: Array<readonly [string, number, Response]> = [];
    for (const { label, key, statuses } of callers) {
      // The unknown key is not in platform.api_keys.
      platform(label === "secret key" ? SECRET_KEY : undefined);
      for (const origin of [undefined, SHOP]) {
        const sent = {
          ...(key === undefined ? {} : { "X-Api-Key": key }),
          ...(origin === undefined ? {} : { Origin: origin }),
        };
        const paths = ["/__cors/key", "/__cors/public", "/v1/no-such-path"] as const;
        for (const [index, path] of paths.entries()) {
          const res = await request(api.server).get(path).set(sent);
          answers.push([`${label} ${origin ?? "without Origin"} ${path}`, statuses[index] ?? 0, res]);
        }
      }
    }

    expect(answers).toHaveLength(18);
    for (const [label, status, res] of answers) {
      expect([label, res.status, corsOf(res), varyOf(res)]).toEqual([label, status, {}, ["origin"]]);
    }
  });

  it("[FIX-W49-OTA AC1] varies by Origin the answers given before any guard, a body the parsers refuse, or before any middleware, a path Express cannot decode", async () => {
    platform();
    const malformed = await request(api.server)
      .post("/__cors/body")
      .set({ Origin: SHOP, "Content-Type": "application/json" })
      .send("{not json");
    const tooLarge = await request(api.server)
      .post("/__cors/body")
      .set({ Origin: SHOP, "Content-Type": "application/json" })
      .send(JSON.stringify({ text: "x".repeat(300 * 1024) }));
    // The router fails before any middleware ran, the CORS middleware included: the error filter adds `Origin`.
    const undecodable = await request(api.server).get("/v1/%E0%A4%A").set({ Origin: SHOP });
    const undecodableNoOrigin = await request(api.server).get("/__cors/%E0%A4%A");
    const edgeUndecodable = await request(api.server)
      .get("/v1/%E0%A4%A")
      .set({ ...edgeHeaders(), Origin: "https://demo.ota.example.com" });

    expect([malformed.status, codeOf(malformed)]).toEqual([400, "INVALID_REQUEST"]);
    expect([tooLarge.status, codeOf(tooLarge)]).toEqual([400, "INVALID_REQUEST"]);
    for (const res of [undecodable, undecodableNoOrigin, edgeUndecodable]) {
      expect([res.status, codeOf(res)]).toEqual([400, "INVALID_REQUEST"]);
    }
    for (const res of [malformed, tooLarge, undecodable, undecodableNoOrigin]) {
      expect([corsOf(res), varyOf(res)]).toEqual([{}, ["origin"]]);
    }
    expectEdgeAnswer(edgeUndecodable);
    expect(edgeUndecodable.headers["vary"]).toBeUndefined();
  });

  it("[FIX-W49-OTA AC1] leaves the storefront edge's answers as they were, an Origin and a handler's own Vary included", async () => {
    platform();

    const plain = await request(api.server)
      .get("/__cors/key")
      .set({ ...edgeHeaders(), Origin: "https://demo.ota.example.com" });
    const cacheable = await request(api.server)
      .get("/__cors/cacheable")
      .set({ ...edgeHeaders(), Origin: "https://demo.ota.example.com" });
    const noOperation = await request(api.server).get("/v1/no-such-path").set(edgeHeaders());

    expect([plain.status, cacheable.status, noOperation.status]).toEqual([200, 200, 404]);
    expect(plain.headers["vary"]).toBeUndefined();
    expect(cacheable.headers["vary"]).toBe("Accept-Language");
    expect(noOperation.headers["vary"]).toBeUndefined();
    for (const res of [plain, cacheable, noOperation]) {
      expectEdgeAnswer(res);
    }
  });
});

describe("the CORS decisions", () => {
  it("[OBE-097 AC1] takes as an origin only what a browser serializes into Origin", () => {
    for (const origin of [
      SHOP,
      "http://localhost:5500",
      "https://[::1]:8443",
      "https://xn--bcher-kva.example",
    ]) {
      expect([origin, isSerializedOrigin(origin)]).toEqual([origin, true]);
    }
    for (const value of [
      "null",
      "",
      `${SHOP}/`,
      `${SHOP}/path`,
      "https://user@shop.example",
      "https://SHOP.example",
      "ftp://shop.example",
      "https://shop.example:443",
      "*",
    ]) {
      expect([value, isSerializedOrigin(value)]).toEqual([value, false]);
    }
  });

  it("[OBE-097 AC1] sees a preflight only in an OPTIONS with an origin and a requested method, never on the edge", () => {
    const asked = { origin: SHOP, "access-control-request-method": "GET" };

    expect(preflightOrigin("OPTIONS", asked)).toBe(SHOP);
    expect(preflightOrigin("GET", asked)).toBeUndefined();
    expect(preflightOrigin("OPTIONS", { origin: SHOP })).toBeUndefined();
    expect(preflightOrigin("OPTIONS", { ...asked, "access-control-request-method": "" })).toBeUndefined();
    expect(preflightOrigin("OPTIONS", { ...asked, "x-velexis-edge": "anything" })).toBeUndefined();
    expect(preflightOrigin("OPTIONS", { ...asked, origin: [SHOP, OTHER] })).toBeUndefined();
  });

  it("[OBE-097 AC1] opens an actual answer to a publishable key's request Origin only", () => {
    const key = (kind: "publishable" | "secret"): Caller => ({
      type: "key",
      id: "key_1",
      keyId: "key_1",
      kind,
      tenantId: TENANT_ID,
      environment: "test",
      scopes: [],
    });
    const headers = new Map<string, string>();
    const varied: string[] = [];
    const res = {
      setHeader: (name: string, value: string) => headers.set(name, value),
      vary: (field: string) => varied.push(field),
      writeHead: () => undefined,
    } as unknown as Parameters<typeof allowCorsAnswer>[0];

    expect(corsAnswerOrigin(key("publishable"), SHOP)).toBe(SHOP);
    expect(corsAnswerOrigin(key("publishable"), undefined)).toBeUndefined();
    expect(corsAnswerOrigin(key("publishable"), "")).toBeUndefined();
    expect(corsAnswerOrigin(key("secret"), SHOP)).toBeUndefined();
    expect(
      corsAnswerOrigin({ type: "edge", id: "edge", host: "demo.ota.example.com" }, SHOP),
    ).toBeUndefined();
    expect(corsAnswerOrigin({ type: "service", id: "service" }, SHOP)).toBeUndefined();
    expect(corsAnswerOrigin({ type: "anonymous", id: "anonymous" }, SHOP)).toBeUndefined();

    allowCorsAnswer(res, key("secret"), SHOP);
    expect([...headers.keys(), ...varied]).toEqual([]);
    allowCorsAnswer(res, key("publishable"), SHOP);
    expect(Object.fromEntries(headers)).toEqual({
      "Access-Control-Allow-Origin": SHOP,
      "Access-Control-Expose-Headers": CORS_EXPOSED_HEADERS.join(", "),
    });
    expect(varied).toEqual(["Origin"]);
    // Once more as the headers are written, whatever set Vary in between.
    (res as unknown as { writeHead: (status: number) => void }).writeHead(200);
    expect(varied).toEqual(["Origin", "Origin"]);
  });

  it("[FIX-W49-OTA AC1] adds Origin to Vary now and once as the headers are written, however often it is asked", () => {
    const varied: string[] = [];
    const written: unknown[][] = [];
    const res = {
      setHeader: () => undefined,
      vary: (field: string) => varied.push(field),
      writeHead: (...args: unknown[]) => written.push(args),
    } as unknown as Parameters<typeof varyByOrigin>[0];

    // The middleware, then the caller guard for an opened answer.
    varyByOrigin(res);
    varyByOrigin(res);
    expect(varied).toEqual(["Origin", "Origin"]);
    (res as unknown as { writeHead: (status: number, message: string) => void }).writeHead(204, "No Content");

    expect(varied).toEqual(["Origin", "Origin", "Origin"]);
    expect(written).toEqual([[204, "No Content"]]);
  });

  it("[FIX-W49-OTA AC1] takes a request with the edge credential, whatever its value, for the storefront edge's", () => {
    expect(isEdgeRequest({ "x-velexis-edge": "anything" })).toBe(true);
    expect(isEdgeRequest({ "x-velexis-edge": "" })).toBe(true);
    expect(isEdgeRequest({ origin: SHOP, "x-api-key": PUBLISHABLE_KEY })).toBe(false);
    expect(isEdgeRequest({})).toBe(false);
  });
});

describe("the header lists", () => {
  /** Every object of the document, depth first. */
  function* walk(value: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(value)) {
      for (const item of value) {
        yield* walk(item);
      }
    } else if (typeof value === "object" && value !== null) {
      yield value as Record<string, unknown>;
      for (const child of Object.values(value)) {
        yield* walk(child);
      }
    }
  }

  const lower = (names: readonly string[]): string[] =>
    [...new Set(names.map((name) => name.toLowerCase()))].sort();

  it("[OBE-097 AC1] allows every request header of the OTA document a browser may send, Authorization, Accept, Content-Type and X-Request-Id, and nothing else", () => {
    const document = loadOpenApiDocument().document;
    const headerNames = new Set<string>();
    let bearer = false;
    for (const node of walk(document)) {
      // Header parameters and the header credentials (apiKey security schemes) both have `in` and `name`.
      if (node["in"] === "header" && typeof node["name"] === "string" && node["x-internal"] !== true) {
        headerNames.add(node["name"]);
      }
      bearer ||= node["type"] === "http" && node["scheme"] === "bearer";
    }
    // Stripe's servers sign the webhook receivers' requests; no browser sends it.
    headerNames.delete("Stripe-Signature");

    expect(bearer).toBe(true);
    expect(headerNames.has("X-Velexis-Edge")).toBe(false);
    expect(lower(CORS_ALLOWED_HEADERS)).toEqual(
      lower([...headerNames, "Authorization", "Accept", "Content-Type", "X-Request-Id"]),
    );
  });

  it("[OBE-097 AC1] allows every header the SDK's source names", () => {
    const sdk = resolve(__dirname, "../../../../sdk/src");
    const files = readdirSync(sdk, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".js"),
    );
    const named = new Set<string>();
    const pattern =
      /["'`](X-[A-Za-z-]+|Accept|Accept-Language|Authorization|Content-Type|Idempotency-Key|If-Match|If-None-Match)["'`]/g;
    for (const file of files) {
      for (const match of readFileSync(join(sdk, file), "utf8").matchAll(pattern)) {
        named.add(match[1] ?? "");
      }
    }
    // The SDK names its credential and session headers (X-Api-Key, Authorization, X-Booking-Token) at least.
    expect(files.length).toBeGreaterThan(0);
    expect([...named]).toEqual(expect.arrayContaining(["X-Api-Key", "Authorization", "X-Booking-Token"]));
    const allowed = new Set(lower(CORS_ALLOWED_HEADERS));
    expect([...named].filter((name) => !allowed.has(name.toLowerCase()))).toEqual([]);
  });

  it("[OBE-097 AC1] exposes every response header of the OTA document a page may read (Set-Cookie never is)", () => {
    const components = loadOpenApiDocument().document["components"] as { headers?: Record<string, unknown> };
    const documented = Object.keys(components.headers ?? {}).filter((name) => name !== "Set-Cookie");

    expect(lower(CORS_EXPOSED_HEADERS)).toEqual(lower(documented));
  });

  it("[OBE-097 AC1] allows the methods of the document's operations", () => {
    const paths = loadOpenApiDocument().document["paths"] as Record<string, Record<string, unknown>>;
    const methods = new Set(
      Object.values(paths).flatMap((item) =>
        Object.keys(item).filter((name) =>
          ["get", "put", "post", "delete", "patch", "head", "trace"].includes(name),
        ),
      ),
    );

    expect([...CORS_ALLOWED_METHODS].sort()).toEqual(
      [...methods].map((method) => method.toUpperCase()).sort(),
    );
  });
});
