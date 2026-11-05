// The auth guards of PBE-012 through the HTTP pipeline (createTestApp): test-only routes bound to real operations of
// the platform document (`getMe`, `getTenant`, `adminGetMe`, `disableMfa`, `listDomains`, `tlsAsk`) and the API's own
// `/health/ready`, real tokens of the application's TokenService, and accounts in this file's database clone, which
// PortalAuthGuard (since PBE-067), AdminAuthGuard and RecentMfaGuard read on every request. A copy of the document tags
// `listDomains` with `x-feature: custom_domains` (no M1 operation carries a switch yet); FEATURE_CUSTOM_DOMAINS keeps
// its default, false. The PBE-067 tests also call the API's own `createApiKey` and `setPayoutAccount` routes, as the
// probe of the security review's finding F-1 did, so the switches are the configured ones (every FEATURE_* off) with
// `settlements` on.
import { readFileSync } from "node:fs";
import { Controller, Get, Post, Req } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PlatformOperationId } from "@velexis/api-types/operations";
import { expectResponseToMatch } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { accessTokenOf } from "../../../src/common/auth/decorators";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { FeatureSwitches, type Feature, type MilestoneFeatures } from "../../../src/common/features";
import { OpenApiOperation } from "../../../src/common/http/openapi-operation.decorator";
import {
  PLATFORM_OPENAPI_FILE,
  PlatformOpenApi,
} from "../../../src/common/http/openapi-validation.interceptor";
import { RequestContext } from "../../../src/common/http/request-context";
import type { PlatformBackendConfig } from "../../../src/config";
import { insertAccount, testId } from "../../builders/platform-rows";
import { insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

const TENANT = testId("ten", 1);
const FAMILY = testId("asn", 1);
const MINUTE = 60;

/** What the test routes answer: who the guards let through. */
interface Passed {
  readonly actor: unknown;
  readonly sub: string | null;
}

/** Test-only routes on the paths of their operations, so the validation interceptor finds their parameters. */
@Controller()
class GuardedTestController {
  constructor(private readonly context: RequestContext) {}

  private passed(req: object): Passed {
    return { actor: this.context.actor ?? null, sub: accessTokenOf(req)?.sub ?? null };
  }

  @Get("v1/me")
  @OpenApiOperation("getMe")
  me(@Req() req: object): Passed {
    return this.passed(req);
  }

  @Get("v1/tenants/:tenantId")
  @OpenApiOperation("getTenant")
  tenant(@Req() req: object): Passed {
    return this.passed(req);
  }

  @Get("v1/tenants/:tenantId/domains")
  @OpenApiOperation("listDomains")
  domains(@Req() req: object): Passed {
    return this.passed(req);
  }

  @Get("v1/admin/me")
  @OpenApiOperation("adminGetMe")
  adminMe(@Req() req: object): Passed {
    return this.passed(req);
  }

  @Post("v1/me/mfa/disable")
  @OpenApiOperation("disableMfa")
  disableMfa(@Req() req: object): Passed {
    return this.passed(req);
  }

  @Get("internal/tls/ask")
  @OpenApiOperation("tlsAsk")
  tlsAsk(@Req() req: object): Passed {
    return this.passed(req);
  }
}

/** The platform document with `x-feature: custom_domains` on listDomains. */
function documentWithFeature(): PlatformOpenApi {
  const document = parse(readFileSync(PLATFORM_OPENAPI_FILE, "utf8")) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const listDomains = document.paths["/v1/tenants/{tenantId}/domains"]?.["get"];
  if (listDomains === undefined) {
    throw new Error("the document has no GET /v1/tenants/{tenantId}/domains");
  }
  listDomains["x-feature"] = "custom_domains";
  return PlatformOpenApi.fromDocument(document);
}

/** The configured switches (every FEATURE_* off here) with `settlements` on, so setPayoutAccount reaches its step-up. */
class SettlementsOn extends FeatureSwitches {
  override isEnabled(feature: Feature): boolean {
    return feature === "settlements" || super.isEnabled(feature);
  }

  override features(): MilestoneFeatures {
    return { ...super.features(), settlements: true };
  }
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
const accounts = { person: "", unverified: "", noMfa: "", admin: "" };
/** Every token this file signed, to check that none reaches a log line. */
const signed: string[] = [];

beforeAll(async () => {
  t = await createTestApp({
    controllers: [GuardedTestController],
    overrides: [
      { provide: PlatformOpenApi, useValue: documentWithFeature() },
      {
        provide: FeatureSwitches,
        useFactory: (config: ConfigService<PlatformBackendConfig, true>) => new SettlementsOn(config),
        inject: [ConfigService],
      },
    ],
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  accounts.person = (await insertAccount(pool, { mfa_enabled: true })).id;
  accounts.unverified = (
    await insertAccount(pool, { status: "pending_verification", email_verified_at: null })
  ).id;
  accounts.noMfa = (await insertAccount(pool)).id;
  accounts.admin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
});

afterAll(async () => {
  await t.close();
});

/** `Authorization: Bearer` with a fresh token of the application's TokenService, at the FakeClock's time. */
async function bearer(input: Partial<AccessTokenInput> & Pick<AccessTokenInput, "aud" | "sub">) {
  const { token } = await tokens.sign({
    sid: FAMILY,
    ev: true,
    amr: input.aud === "platform_admin" ? ["pwd", "otp"] : ["pwd"],
    ...input,
  });
  signed.push(token);
  return { Authorization: `Bearer ${token}` };
}

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** The error code of an envelope answer, with the request id in the body and the header. */
function errorOf(res: { body: unknown; headers: Record<string, string> }): string {
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.code;
}

describe("PortalAuthGuard and AdminAuthGuard", () => {
  it("[PBE-012 AC1] refuse a portal token on an admin route and an admin token on a portal route with 401", async () => {
    const portalToken = await bearer({ aud: "portal", sub: accounts.admin });
    const adminToken = await bearer({ aud: "platform_admin", sub: accounts.admin });

    const portalOnAdmin = await t.http.get("/v1/admin/me").set(portalToken).set(t.bffHeaders("203.0.113.7"));
    const adminOnPortal = await t.http
      .get(`/v1/tenants/${TENANT}`)
      .set(adminToken)
      .set(t.bffHeaders("203.0.113.7"));

    expect([portalOnAdmin.status, errorOf(portalOnAdmin)]).toEqual([401, "UNAUTHENTICATED"]);
    expect([adminOnPortal.status, errorOf(adminOnPortal)]).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("adminGetMe", portalOnAdmin, { document: "platform" });
    expectResponseToMatch("getTenant", adminOnPortal, { document: "platform" });
  });

  it("[PBE-012 AC1] let each token through on its own surface, with the actor in the request context", async () => {
    const portal = await t.http
      .get(`/v1/tenants/${TENANT}`)
      .set(await bearer({ aud: "portal", sub: accounts.person }));
    const admin = await t.http
      .get("/v1/admin/me")
      .set(await bearer({ aud: "platform_admin", sub: accounts.admin }));

    expect(portal.status).toBe(200);
    expect(portal.body).toEqual({
      actor: { type: "account", accountId: accounts.person },
      sub: accounts.person,
    });
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({
      actor: { type: "platform_admin", accountId: accounts.admin },
      sub: accounts.admin,
    });
  });

  it("AdminAuthGuard re-reads is_platform_admin on every request: a revoked admin's token stops at once", async () => {
    const revoked = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
    const headers = await bearer({ aud: "platform_admin", sub: revoked });

    expect((await t.http.get("/v1/admin/me").set(headers)).status).toBe(200);
    await pool.query("UPDATE platform.accounts SET is_platform_admin = false WHERE id = $1", [revoked]);
    const after = await t.http.get("/v1/admin/me").set(headers);

    expect([after.status, errorOf(after)]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("answer 401 UNAUTHENTICATED without a token and 401 TOKEN_EXPIRED once the token is 15 minutes old", async () => {
    const headers = await bearer({ aud: "portal", sub: accounts.person });

    const none = await t.http.get("/v1/me");
    t.clock.advance(15 * MINUTE * 1000);
    const expired = await t.http.get("/v1/me").set(headers);

    expect([none.status, errorOf(none)]).toEqual([401, "UNAUTHENTICATED"]);
    expect([expired.status, errorOf(expired)]).toEqual([401, "TOKEN_EXPIRED"]);
    expectResponseToMatch("getMe", expired, { document: "platform" });
  });

  it("[PBE-012 AC2] let an unverified token reach portal_unverified routes and answer 403 EMAIL_NOT_VERIFIED on portal routes", async () => {
    const headers = await bearer({ aud: "portal", sub: accounts.unverified, ev: false });

    const me = await t.http.get("/v1/me").set(headers);
    const tenant = await t.http.get(`/v1/tenants/${TENANT}`).set(headers);

    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ sub: accounts.unverified });
    expect([tenant.status, errorOf(tenant)]).toEqual([403, "EMAIL_NOT_VERIFIED"]);
    expectResponseToMatch("getTenant", tenant, { document: "platform" });
  });
});

describe("RecentMfaGuard", () => {
  it("[PBE-012 AC3] answers 401 REAUTH_REQUIRED for an mfa_at 16 minutes old and lets a recent one through", async () => {
    const stale = await t.http.post("/v1/me/mfa/disable").set(
      await bearer({
        aud: "portal",
        sub: accounts.person,
        amr: ["pwd", "otp"],
        mfa_at: nowSeconds() - 16 * MINUTE,
      }),
    );
    const recent = await t.http.post("/v1/me/mfa/disable").set(
      await bearer({
        aud: "portal",
        sub: accounts.person,
        amr: ["pwd", "otp"],
        mfa_at: nowSeconds() - 5 * MINUTE,
      }),
    );

    expect([stale.status, errorOf(stale)]).toEqual([401, "REAUTH_REQUIRED"]);
    expectResponseToMatch("disableMfa", stale, { document: "platform" });
    expect(recent.status).toBe(201);
  });

  it("[PBE-012 AC3] answers 403 MFA_REQUIRED for an account without MFA, read from the database", async () => {
    const res = await t.http
      .post("/v1/me/mfa/disable")
      .set(await bearer({ aud: "portal", sub: accounts.noMfa, mfa_at: nowSeconds() }));

    expect([res.status, errorOf(res)]).toEqual([403, "MFA_REQUIRED"]);
    expectResponseToMatch("disableMfa", res, { document: "platform" });
  });
});

describe("FeatureGuard", () => {
  it("[PBE-012 AC4] answers 403 FEATURE_DISABLED with details.feature for x-feature: custom_domains with FEATURE_CUSTOM_DOMAINS=false", async () => {
    expect(t.config.FEATURE_CUSTOM_DOMAINS).toBe(false);

    const res = await t.http
      .get(`/v1/tenants/${TENANT}/domains`)
      .set(await bearer({ aud: "portal", sub: accounts.person }));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: { code: "FEATURE_DISABLED", status: 403, details: { feature: "custom_domains" } },
    });
  });
});

describe("InternalOnlyGuard", () => {
  it("[PBE-012 AC5] answers 404 on /health/ready and the TLS ask route when the request carries X-Forwarded-For", async () => {
    const ready = await t.http.get("/health/ready").set("X-Forwarded-For", "198.51.100.23");
    const ask = await t.http
      .get("/internal/tls/ask")
      .query({ domain: "agency1.ota.example.com" })
      .set("X-Forwarded-For", "198.51.100.23");

    expect([ready.status, errorOf(ready)]).toEqual([404, "NOT_FOUND"]);
    expect([ask.status, errorOf(ask)]).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("tlsAsk", ask, { document: "platform" });
  });

  it("[PBE-012 AC5] lets the same calls through from loopback without X-Forwarded-For and without a token", async () => {
    const ready = await t.http.get("/health/ready");
    const ask = await t.http.get("/internal/tls/ask").query({ domain: "agency1.ota.example.com" });

    expect(ready.status).toBe(200);
    expect(ask.status).toBe(200);
    expect(ask.body).toEqual({ actor: null, sub: null });
  });
});

// PBE-067 (lead decision (5a) of 2026-11-05; platform/docs/security-review.md finding F-1): the review's probe, through
// the API. An owner with MFA holds a token with a TOTP step-up now; the token answers `getTenant`, the API's own
// `createApiKey` (a new test secret key) and `setPayoutAccount` (a new bank account); then the account is disabled or
// erased behind the token's back, and the same unexpired token answers `401 UNAUTHENTICATED` on all of them at once.
describe("PortalAuthGuard re-reads the account's state (PBE-067)", () => {
  /** A documentation address (RFC 5737) for the BFF headers of these calls. */
  const PROBE_IP = "203.0.113.67";
  /** The ISO 13616 documentation example of an IBAN and a BIC: test values only. */
  const PAYOUT_ACCOUNT = {
    accountHolderName: "Agency Travel Ltd",
    countryCode: "GB",
    currency: "GBP",
    scheme: "iban",
    iban: "GB82 WEST 1234 5698 7654 32",
    bic: "WESTGB2L",
  };
  let otas = 0;

  /** An active OTA owned by a new account with MFA, and that owner's token with a TOTP step-up now. */
  async function ownedOta(): Promise<{ owner: string; tenantId: string; headers: Record<string, string> }> {
    otas += 1;
    const owner = await insertAccount(pool, { mfa_enabled: true });
    const { tenant } = await insertOta(pool, {
      // Ids of their own, apart from the made-up TENANT of the tests above.
      tenant: { id: testId("ten", 67_000 + otas), key: `pbe067ota${otas}` },
      members: [[owner, "owner"]],
    });
    const headers = {
      ...(await bearer({ aud: "portal", sub: owner.id, amr: ["pwd", "otp"], mfa_at: nowSeconds() })),
      ...t.bffHeaders(PROBE_IP),
    };
    return { owner: owner.id, tenantId: tenant.id, headers };
  }

  /** The calls of the probe, by operation: getMe, getTenant, createApiKey and setPayoutAccount. */
  async function probe(
    tenantId: string,
    headers: Record<string, string>,
  ): Promise<Array<[PlatformOperationId, Response]>> {
    return [
      ["getMe", await t.http.get("/v1/me").set(headers)],
      ["getTenant", await t.http.get(`/v1/tenants/${tenantId}`).set(headers)],
      [
        "createApiKey",
        await t.http
          .post(`/v1/tenants/${tenantId}/api-keys`)
          .set(headers)
          .send({ name: "Probe", kind: "secret", environment: "test" }),
      ],
      [
        "setPayoutAccount",
        await t.http.put(`/v1/tenants/${tenantId}/payout-account`).set(headers).send(PAYOUT_ACCOUNT),
      ],
    ];
  }

  /** What the tenant holds that the probe writes: its API keys and its payout account's version. */
  async function written(tenantId: string): Promise<{ keys: number; payoutVersion: number | null }> {
    const keys = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.api_keys WHERE tenant_id = $1",
      [tenantId],
    );
    const payout = await pool.query<{ version: number }>(
      "SELECT version FROM platform.tenant_payout_accounts WHERE tenant_id = $1",
      [tenantId],
    );
    return { keys: keys.rows[0]?.n ?? 0, payoutVersion: payout.rows[0]?.version ?? null };
  }

  it.each([
    ["disabled", "UPDATE platform.accounts SET status = 'disabled' WHERE id = $1"],
    ["erased", "UPDATE platform.accounts SET status = 'deleted', deleted_at = now() WHERE id = $1"],
  ])(
    "[PBE-067 AC1] answers 401 UNAUTHENTICATED at once to the unexpired token of an account %s after it was signed, the step-up actions included",
    async (_state, change) => {
      const { owner, tenantId, headers } = await ownedOta();

      const before = await probe(tenantId, headers);
      expect(before.map(([operationId, res]) => [operationId, res.status])).toEqual([
        ["getMe", 200],
        ["getTenant", 200],
        ["createApiKey", 201],
        ["setPayoutAccount", 200],
      ]);
      const stored = await written(tenantId);
      expect(stored).toEqual({ keys: 1, payoutVersion: 1 });

      await pool.query(change, [owner]);
      const after = await probe(tenantId, headers);

      for (const [operationId, res] of after) {
        expect([operationId, res.status, errorOf(res)]).toEqual([operationId, 401, "UNAUTHENTICATED"]);
        expectResponseToMatch(operationId, res, { document: "platform" });
      }
      // Refused before any handler ran: no new key, no new payout account version.
      expect(await written(tenantId)).toEqual(stored);
    },
  );

  it("[PBE-067 AC2] keeps the answers of a locked account: its unexpired token still works", async () => {
    const { owner, tenantId, headers } = await ownedOta();
    // A sign-in lockout is not a revocation (lead decision (5a)): the token the account already holds goes on working.
    await pool.query(
      "UPDATE platform.accounts SET status = 'locked', locked_until = now() + interval '15 minutes' WHERE id = $1",
      [owner],
    );

    const me = await t.http.get("/v1/me").set(headers);
    const tenant = await t.http.get(`/v1/tenants/${tenantId}`).set(headers);

    expect([me.status, tenant.status]).toEqual([200, 200]);
    expect(tenant.body).toEqual({ actor: { type: "account", accountId: owner }, sub: owner });
  });
});

describe("logging", () => {
  it("never writes a token into a log line", () => {
    const logged = JSON.stringify(t.logs.lines);

    expect(signed.length).toBeGreaterThan(0);
    for (const token of signed) {
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(token.split(".")[2]);
    }
  });
});
