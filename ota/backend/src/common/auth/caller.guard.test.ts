// The caller guard in the API's own pipeline (OBE-011; OADR-0009 point 1, architecture §3.1), in process with dummy
// services: probe controllers return the caller the guard put in the request context, and pending operations of the
// document (501 behind the guard) show the envelopes against the document. The platform repository and the pool are
// spied on: an edge request never reaches either. Keys against PostgreSQL rows: test/integration/tenancy.
import { Body, Controller, Get, Post } from "@nestjs/common";
import { hashApiKey } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { edgeHeaders, edgeWriteHeaders, newApiKey, testApiCredentials } from "../../../test/helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../../test/helpers/openapi";
import { freePort } from "../../../test/helpers/ports";
import { createTestApp, type TestApp } from "../../../test/support/create-test-app";
import {
  CallerContext,
  isDirectLocalRequest,
  isLoopbackAddress,
  type Caller,
} from "../../tenancy/caller-resolver";
import { PlatformReadRepository, type PlatformApiKey } from "../../tenancy/platform-read.repository";
import type { PlatformTenant } from "../../tenancy/platform-read.types";
import { OTA_POOL, TenancyModule, type OtaPool } from "../../tenancy/tenancy.module";
import { newId } from "../ids";
import { OpenApiOperation } from "../http/openapi-operation.decorator";
import { LocalRoute, PublicRoute, WebhookRoute } from "./caller.guard";

const TENANT_ID = newId("ten");
/** Keys in the platform's format, built at run time; valid only against the rows these tests build. */
const SECRET_KEY = newApiKey("sk");
const PUBLISHABLE_KEY = newApiKey("pk");
/** A pending operation of the document (OBE-015) that documents 400, 401 and 403. */
const SEARCH_LOCATIONS = "/v1/reference/locations?keyword=par";
/**
 * A body of verifyEmail, the operation of the validation probe below: a customer operation without a rate limit
 * (OBE-013), so the probe needs no Redis, which these tests do not have.
 */
const VERIFY_EMAIL = { token: "vt_0123456789abcdefghijklmnopqrstuv" };

@Controller("__callers")
class CallerProbe {
  constructor(private readonly callers: CallerContext) {}

  @Get("authenticated")
  authenticated(): { caller: Caller | null } {
    return { caller: this.callers.get() ?? null };
  }

  @Post("verify-email")
  @OpenApiOperation("verifyEmail")
  verifyEmail(@Body() _body: unknown): { caller: Caller | null } {
    return { caller: this.callers.get() ?? null };
  }

  @Get("public")
  @PublicRoute()
  public(): { caller: Caller | null } {
    return { caller: this.callers.get() ?? null };
  }

  @Post("webhook")
  @WebhookRoute()
  webhook(): { caller: Caller | null } {
    return { caller: this.callers.get() ?? null };
  }

  @Get("local")
  @LocalRoute()
  local(): { caller: Caller | null } {
    return { caller: this.callers.get() ?? null };
  }
}

@Controller("__callers/public-controller")
@PublicRoute()
class PublicControllerProbe {
  constructor(private readonly callers: CallerContext) {}

  @Get()
  get(): { caller: Caller | null } {
    return { caller: this.callers.get() ?? null };
  }
}

let api: TestApp;

// Starting the application parses and compiles the OTA document, and the first expectResponseToMatch parses it again
// for the response checker: one-time work that takes several seconds while every package's tests run at once, so it
// happens here, with the budget of test/helpers/openapi.ts, and not in the first test.
beforeAll(async () => {
  preloadOpenApiDocument();
  responseChecker("ota");
  api = await createTestApp({
    controllers: [CallerProbe, PublicControllerProbe],
    imports: [TenancyModule.forApi()],
  });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
});

/** Spies on every lookup of the platform repository and on the pool under it. */
function spyOnDatabase() {
  const repository = api.app.get(PlatformReadRepository);
  const pool = api.app.get<string, OtaPool>(OTA_POOL);
  return {
    apiKeyByPrefix: vi.spyOn(repository, "apiKeyByPrefix"),
    tenantById: vi.spyOn(repository, "tenantById"),
    tenantByKey: vi.spyOn(repository, "tenantByKey"),
    connect: vi.spyOn(pool, "connect"),
    query: vi.spyOn(pool, "query"),
  };
}

/** The test's edge secret with its last character changed: same length, wrong value. */
function wrongEdgeSecret(): string {
  const secret = testApiCredentials().edgeSecret;
  return `${secret.slice(0, -1)}${secret.endsWith("0") ? "1" : "0"}`;
}

/** The `platform.api_keys` row of `key` under the test process's pepper. */
function rowOf(key: string, overrides: Partial<PlatformApiKey> = {}): PlatformApiKey {
  return {
    id: newId("key"),
    tenantId: TENANT_ID,
    kind: key.startsWith("pk_") ? "publishable" : "secret",
    environment: "test",
    prefix: key.slice(0, 14),
    keyHash: hashApiKey(key, testApiCredentials().pepper),
    allowedOrigins: [],
    scopes: [],
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("the storefront edge (rule 1.1)", () => {
  it("answers a wrong edge secret with 401 before any database query [OBE-011 AC1]", async () => {
    const database = spyOnDatabase();
    const wrong = { "X-Velexis-Edge": wrongEdgeSecret(), "X-Velexis-Host": "acme.ota.example.com" };

    const answers = await Promise.all([
      request(api.server).get(SEARCH_LOCATIONS).set(wrong),
      request(api.server).get("/__callers/authenticated").set(wrong),
      request(api.server).get("/__callers/public").set(wrong),
      // Present but empty is a wrong secret, not a missing one: on a public route it would otherwise be anonymous.
      request(api.server).get("/__callers/public").set("X-Velexis-Edge", ""),
      request(api.server).get("/__callers/authenticated").set("X-Velexis-Edge", wrongEdgeSecret()),
    ]);

    for (const res of answers) {
      expect([res.status, res.body.error?.code]).toEqual([401, "INVALID_API_KEY"]);
    }
    expectResponseToMatch("searchLocations", answers[0] ?? { status: 0, body: undefined });
    for (const spy of Object.values(database)) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(api.sink.records()).toContainEqual(
      expect.objectContaining({ level: 40, msg: "caller.edge_refused", reason: "edge_secret_mismatch" }),
    );
    expect(api.sink.text()).not.toContain(testApiCredentials().edgeSecret.slice(0, 40));
  });

  it("classifies the right secret as the edge caller of X-Velexis-Host, in lower case, without a lookup", async () => {
    const database = spyOnDatabase();

    const res = await request(api.server)
      .get("/__callers/authenticated")
      .set(edgeHeaders("Acme.OTA.example.com"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ caller: { type: "edge", id: "edge", host: "acme.ota.example.com" } });
    expect(database.apiKeyByPrefix).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("requires X-Velexis-Host with the edge secret: 400 INVALID_REQUEST", async () => {
    for (const host of [undefined, ""]) {
      const call = request(api.server)
        .get(SEARCH_LOCATIONS)
        .set("X-Velexis-Edge", testApiCredentials().edgeSecret);
      const res = await (host === undefined ? call : call.set("X-Velexis-Host", host));

      expect([res.status, res.body.error.code, res.body.error.details]).toEqual([
        400,
        "INVALID_REQUEST",
        { reason: "edge_host_missing" },
      ]);
      expectResponseToMatch("searchLocations", res);
    }
  });
});

describe("the edge header and an API key together", () => {
  it("answer 400 INVALID_REQUEST without checking either [OBE-011 AC3]", async () => {
    const database = spyOnDatabase();
    database.apiKeyByPrefix.mockResolvedValue(rowOf(SECRET_KEY));

    const answers = await Promise.all([
      request(api.server).get(SEARCH_LOCATIONS).set(edgeHeaders()).set("X-Api-Key", SECRET_KEY),
      request(api.server)
        .get("/__callers/authenticated")
        .set({ "X-Velexis-Edge": wrongEdgeSecret(), "X-Velexis-Host": "acme.ota.example.com" })
        .set("X-Api-Key", SECRET_KEY),
      request(api.server).get("/__callers/public").set(edgeHeaders()).set("X-Api-Key", "sk_svc_anything"),
      // An empty X-Api-Key is still a second credential next to the right edge secret.
      request(api.server).get("/__callers/public").set(edgeHeaders()).set("X-Api-Key", ""),
    ]);

    for (const res of answers) {
      expect([res.status, res.body.error.code, res.body.error.details]).toEqual([
        400,
        "INVALID_REQUEST",
        { reason: "edge_with_api_key" },
      ]);
    }
    expectResponseToMatch("searchLocations", answers[0] ?? { status: 0, body: undefined });
    expect(database.apiKeyByPrefix).not.toHaveBeenCalled();
    expect(api.sink.text()).not.toContain(SECRET_KEY.slice(14));
  });
});

describe("API keys (rule 1.3)", () => {
  it("puts a verified key in the request context: id, tenant, kind, environment and scopes", async () => {
    const database = spyOnDatabase();
    const row = rowOf(SECRET_KEY, { scopes: ["storefront"] });
    database.apiKeyByPrefix.mockResolvedValue(row);

    const res = await request(api.server).get("/__callers/authenticated").set("X-Api-Key", SECRET_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      caller: {
        type: "key",
        id: row.id,
        keyId: row.id,
        kind: "secret",
        tenantId: TENANT_ID,
        environment: "test",
        scopes: ["storefront"],
      },
    });
    expect(database.apiKeyByPrefix).toHaveBeenCalledExactlyOnceWith(SECRET_KEY.slice(0, 14));
    expect(api.sink.text()).not.toContain(SECRET_KEY.slice(14));
  });

  it("refuses a pk_ key from a non-listed origin with 403 ORIGIN_NOT_ALLOWED [OBE-011 AC2]", async () => {
    const database = spyOnDatabase();
    database.apiKeyByPrefix.mockResolvedValue(
      rowOf(PUBLISHABLE_KEY, { allowedOrigins: ["https://travel.example.net"] }),
    );

    const foreign = await request(api.server)
      .get(SEARCH_LOCATIONS)
      .set({ "X-Api-Key": PUBLISHABLE_KEY, Origin: "https://evil.example.com" });
    const listed = await request(api.server)
      .get("/__callers/authenticated")
      .set({ "X-Api-Key": PUBLISHABLE_KEY, Origin: "https://travel.example.net" });

    expect([foreign.status, foreign.body.error.code]).toEqual([403, "ORIGIN_NOT_ALLOWED"]);
    expectResponseToMatch("searchLocations", foreign);
    expect(listed.status).toBe(200);
    expect(listed.body.caller).toMatchObject({ type: "key", kind: "publishable" });
  });

  it("refuses an X-Api-Key that is neither pk_ nor sk_ with 401, without a lookup", async () => {
    const database = spyOnDatabase();

    for (const key of [newApiKey("hk"), "sk_svc_0123", "", "Bearer x"]) {
      const res = await request(api.server).get("/__callers/public").set("X-Api-Key", key);

      expect([key, res.status, res.body.error.code]).toEqual([key, 401, "INVALID_API_KEY"]);
    }
    expect(database.apiKeyByPrefix).not.toHaveBeenCalled();
  });

  it("answers 503 SERVICE_UNAVAILABLE when PostgreSQL cannot be reached", async () => {
    const down = await createTestApp({
      env: { DATABASE_URL: `postgres://velexis_ota_app:dummy@127.0.0.1:${await freePort()}/velexis` },
    });
    try {
      const res = await request(down.server)
        .post("/v1/flight-searches")
        .set("X-Api-Key", SECRET_KEY)
        .send({});

      expect([res.status, res.body.error.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
      expectResponseToMatch("createFlightSearch", res);
    } finally {
      await down.close();
    }
  });
});

describe("requests without a credential (rules 1.4 and 5)", () => {
  it("answer 401 INVALID_API_KEY on every route that is not marked, the routes of pending operations included", async () => {
    const answers = await Promise.all([
      request(api.server).get("/__callers/authenticated"),
      request(api.server).get(SEARCH_LOCATIONS),
      request(api.server).get("/v1/console/bookings").set("X-Velexis-Environment", "test"),
    ]);

    for (const res of answers) {
      expect([res.status, res.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
    }
    expectResponseToMatch("searchLocations", answers[1] ?? { status: 0, body: undefined });
  });

  it("are anonymous on public and webhook routes, marked on the handler or the controller", async () => {
    const answers = await Promise.all([
      request(api.server).get("/__callers/public"),
      request(api.server).get("/__callers/public-controller"),
      request(api.server).post("/__callers/webhook").set("Content-Type", "application/json").send("{}"),
      request(api.server).get("/health/live"),
    ]);

    expect(answers.map((res) => res.status)).toEqual([200, 200, 201, 200]);
    for (const res of answers.slice(0, 3)) {
      expect(res.body).toEqual({ caller: { type: "anonymous", id: "anonymous" } });
    }
  });

  it("are anonymous on a local route only on a direct loopback connection, never through a proxy", async () => {
    const direct = await request(api.server).get("/__callers/local");
    const proxied = await Promise.all([
      request(api.server).get("/__callers/local").set("X-Forwarded-For", "203.0.113.7"),
      request(api.server).get("/__callers/local").set("X-Forwarded-Host", "api.ota.example.com"),
      request(api.server).get("/health/ready").set("X-Forwarded-For", "127.0.0.1"),
    ]);

    expect([direct.status, direct.body]).toEqual([200, { caller: { type: "anonymous", id: "anonymous" } }]);
    for (const res of proxied) {
      expect([res.status, res.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
    }
  });

  it("are refused before the request is validated (the guard runs first)", async () => {
    // The probe is bound to an operation, so the tenant guard (OBE-012) resolves the edge caller's host first: an
    // active tenant behind demo.ota.example.com, from the spied repository (the dummy services have none).
    spyOnDatabase().tenantByKey.mockResolvedValue({
      id: TENANT_ID,
      key: "demo",
      name: "Demo Travel",
      status: "active",
      schemaName: "tenant_demo" as PlatformTenant["schemaName"],
      storefrontEnvironment: "test",
      defaultCurrency: "EUR",
      defaultLocale: "en",
      billingNotice: null,
    });
    // The edge requests carry the CSRF pair and Origin of a storefront page: the CSRF guard (OBE-013) runs before
    // validation too.
    const anonymous = await request(api.server).post("/__callers/verify-email").send({ nope: true });
    const edge = await request(api.server)
      .post("/__callers/verify-email")
      .set(edgeWriteHeaders())
      .send({ nope: true });
    const valid = await request(api.server)
      .post("/__callers/verify-email")
      .set(edgeWriteHeaders())
      .set("Idempotency-Key", "0b9d1c5e-6f3a-4c2b-9e7d-1a2b3c4d5e6f")
      .send(VERIFY_EMAIL);

    expect([anonymous.status, anonymous.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
    expect([edge.status, edge.body.error.code]).toEqual([400, "VALIDATION_FAILED"]);
    expect(valid.status).toBe(201);
    expect(valid.body.caller).toMatchObject({ type: "edge" });
  });
});

describe("direct local requests", () => {
  it("are loopback peers (IPv4 127/8, ::1, IPv4-mapped) without X-Forwarded-For and X-Forwarded-Host", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      expect([address, isLoopbackAddress(address)]).toEqual([address, true]);
    }
    for (const address of [
      undefined,
      "10.0.0.1",
      "::ffff:10.0.0.1",
      "fe80::1",
      "0.0.0.0",
      "127.0.0.1.example",
    ]) {
      expect([address, isLoopbackAddress(address)]).toEqual([address, false]);
    }
    expect(isDirectLocalRequest({ headers: {}, remoteAddress: "127.0.0.1" })).toBe(true);
    expect(isDirectLocalRequest({ headers: { "x-forwarded-for": "" }, remoteAddress: "127.0.0.1" })).toBe(
      false,
    );
    expect(
      isDirectLocalRequest({ headers: { "x-forwarded-host": "api.ota.example.com" }, remoteAddress: "::1" }),
    ).toBe(false);
    expect(isDirectLocalRequest({ headers: {}, remoteAddress: "192.0.2.1" })).toBe(false);
  });
});
