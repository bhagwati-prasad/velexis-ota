// The auth guards of the platform API (PBE-012, platform/docs/architecture.md §3 steps 5, 7 and 8), run in the order of
// API_GUARDS against handlers bound to real operations of the platform document, with real tokens of TokenService
// (a fresh key file, a FakeClock), a real request context and a stand-in for the account read. A copy of the
// document tags `listDomains` with `x-feature: custom_domains`, since no M1 operation carries a switch yet.
// test/integration/common/auth-guards.int.test.ts runs the same rules through the HTTP pipeline and PostgreSQL.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type { ConfigService } from "@nestjs/config";
import type { CanActivate } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { platformOperations, type ApiOperation } from "@velexis/api-types/operations";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { ClsService } from "nestjs-cls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createTestJwtKeyFile } from "../../../test/support/jwt-key";
import { TokenService, type AccessTokenClaims, type AccessTokenInput } from "../../auth/token.service";
import type { PlatformBackendConfig } from "../../config";
import { API_GUARDS } from "../common.module";
import {
  featuresFor,
  FeatureSwitches,
  FEATURES,
  FEATURE_VARIABLES,
  type Feature as FeatureName,
} from "../features";
import { OpenApiOperation } from "../http/openapi-operation.decorator";
import { PLATFORM_OPENAPI_FILE, PlatformOpenApi } from "../http/openapi-validation.interceptor";
import { RequestContext, type RequestActor, type RequestContextStore } from "../http/request-context";
import { AccountRateLimitGuard, RateLimitGuard } from "../http/throttler.config";
import {
  AdminAuthGuard,
  type AccountAuthState,
  type AccountAuthStates,
  type AccountStatus,
} from "./admin-auth.guard";
import { accessTokenOf, Feature, OperationPolicies, RequireRecentMfa } from "./decorators";
import { FeatureGuard } from "./feature.guard";
import { InternalOnlyGuard } from "./internal-only.guard";
import { mayUsePortalToken, PortalAuthGuard } from "./portal-auth.guard";
import { MFA_STEP_UP_WINDOW_SECONDS, RecentMfaGuard } from "./recent-mfa.guard";
import { TenantRoleGuard } from "./tenant-role.guard";

const START = "2026-10-15T09:00:00.000Z";
const NOW = Date.parse(START) / 1000;
const MINUTE = 60;

// Made-up ids in the shape of the platform's (acc_ and asn_ + 26 Crockford characters).
const PERSON = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1A";
const UNVERIFIED = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1B";
const NO_MFA = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1C";
const ADMIN = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1D";
const FORMER_ADMIN = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1E";
const DISABLED_ADMIN = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1F";
const FAMILY = "asn_01JA2Z9W5K7Q3M8N4P6R2T0V1G";
// The portal accounts of PBE-067's states, each with MFA, so a step-up would let them through.
const LOCKED = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1H";
const DISABLED = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1J";
const DELETED = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1K";
/** An account AccountAuthStates does not find: erased (`deleted_at` set), or never written. */
const ERASED = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1M";

/** The accounts as `platform.accounts` would hold them. */
const ACCOUNTS: ReadonlyMap<string, AccountAuthState> = new Map([
  [PERSON, { status: "active", isPlatformAdmin: false, mfaEnabled: true }],
  [UNVERIFIED, { status: "pending_verification", isPlatformAdmin: false, mfaEnabled: false }],
  [NO_MFA, { status: "active", isPlatformAdmin: false, mfaEnabled: false }],
  [ADMIN, { status: "active", isPlatformAdmin: true, mfaEnabled: true }],
  [FORMER_ADMIN, { status: "active", isPlatformAdmin: false, mfaEnabled: true }],
  [DISABLED_ADMIN, { status: "disabled", isPlatformAdmin: true, mfaEnabled: true }],
  [LOCKED, { status: "locked", isPlatformAdmin: false, mfaEnabled: true }],
  [DISABLED, { status: "disabled", isPlatformAdmin: false, mfaEnabled: true }],
  [DELETED, { status: "deleted", isPlatformAdmin: false, mfaEnabled: true }],
]);

let withFeature: PlatformOpenApi | undefined;

/** The platform document with `x-feature: custom_domains` on listDomains (parsed once per file). */
function documentWithFeature(): PlatformOpenApi {
  if (withFeature !== undefined) {
    return withFeature;
  }
  const document = parse(readFileSync(PLATFORM_OPENAPI_FILE, "utf8")) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const listDomains = document.paths["/v1/tenants/{tenantId}/domains"]?.["get"];
  if (listDomains?.["operationId"] !== "listDomains") {
    throw new Error("the document has no listDomains at GET /v1/tenants/{tenantId}/domains");
  }
  listDomains["x-feature"] = "custom_domains";
  withFeature = PlatformOpenApi.fromDocument(document);
  return withFeature;
}

/** Handlers bound to operations of each scope, as controllers bind them. */
class Routes {
  @OpenApiOperation("listPlans")
  plans(): void {}

  @OpenApiOperation("getMe")
  me(): void {}

  @OpenApiOperation("getTenant")
  tenant(): void {}

  @OpenApiOperation("adminGetMe")
  adminMe(): void {}

  @OpenApiOperation("healthReady")
  ready(): void {}

  @OpenApiOperation("disableMfa")
  disableMfa(): void {}

  @OpenApiOperation("adminGrantAdmin")
  grantAdmin(): void {}

  @OpenApiOperation("listDomains")
  domains(): void {}

  /** `x-feature: settlements` and `x-mfa-step-up` in the document. */
  @OpenApiOperation("setPayoutAccount")
  setPayoutAccount(): void {}

  /** `x-feature: own_stripe` and `x-mfa-step-up` in the document. */
  @OpenApiOperation("startStripeConnect")
  startStripeConnect(): void {}

  @Feature("live_switch")
  @OpenApiOperation("getMe")
  meBehindLiveSwitch(): void {}

  @RequireRecentMfa()
  @OpenApiOperation("getTenant")
  tenantWithStepUp(): void {}

  @RequireRecentMfa()
  @OpenApiOperation("listPlans")
  publicWithStepUp(): void {}

  /** No @OpenApiOperation: a test-only route (the route parity test refuses such routes in the API). */
  unbound(): void {}
}

type RouteName = Exclude<keyof Routes, "constructor">;

interface Call {
  readonly headers?: Record<string, string>;
  readonly peer?: string;
}

interface Outcome {
  /** `passed`, or the code of the AppError a guard threw. */
  readonly result: string;
  readonly error?: AppError;
  readonly actor: RequestActor | undefined;
  readonly token: AccessTokenClaims | undefined;
}

const keyFile = createTestJwtKeyFile();

afterAll(() => {
  keyFile.remove();
});

// Parsing the platform document is the slow part of the first harness(): a few hundred milliseconds on an idle CPU,
// close to 4 s when CI runs every package at once on 4 CPUs. It is done once here, with a budget of its own.
beforeAll(() => {
  documentWithFeature();
}, 60_000);

/** The guards of API_GUARDS, built as Nest builds them, with switches from `features` and FEATURE_* otherwise off. */
function harness(features: Partial<Record<FeatureName, boolean>> = {}) {
  const clock = new FakeClock(START);
  const values: Record<string, unknown> = { JWT_PRIVATE_KEY_FILE: keyFile.path };
  for (const feature of FEATURES) {
    values[FEATURE_VARIABLES[feature]] = features[feature] ?? false;
  }
  const config = { get: (key: string) => values[key] } as unknown as ConfigService<
    PlatformBackendConfig,
    true
  >;
  const tokens = new TokenService(config, clock);
  /** The account of every read of `platform.accounts` the guards made, in order. */
  const reads: string[] = [];
  const accounts = {
    read: (id: string) => {
      reads.push(id);
      return Promise.resolve(ACCOUNTS.get(id));
    },
  } as unknown as AccountAuthStates;
  const cls = new ClsService<RequestContextStore>(new AsyncLocalStorage());
  const context = new RequestContext(cls);
  const policies = new OperationPolicies(documentWithFeature());
  const guards: CanActivate[] = [
    new InternalOnlyGuard(policies),
    new PortalAuthGuard(policies, tokens, accounts, context),
    new AdminAuthGuard(policies, tokens, accounts, context),
    new FeatureGuard(policies, new FeatureSwitches(config)),
    new RecentMfaGuard(policies, accounts, clock),
  ];

  /** A bearer header with a fresh token. */
  async function bearer(input: Partial<AccessTokenInput> & Pick<AccessTokenInput, "aud" | "sub">) {
    const { token } = await tokens.sign({
      sid: FAMILY,
      ev: true,
      amr: input.aud === "platform_admin" ? ["pwd", "otp"] : ["pwd"],
      ...input,
    });
    return { authorization: `Bearer ${token}` };
  }

  /** Runs the guards in order for `route`, as Nest does, inside a request context. */
  function call(route: RouteName, { headers = {}, peer = "127.0.0.1" }: Call = {}): Promise<Outcome> {
    const request = { headers, socket: { remoteAddress: peer } };
    const execution = new ExecutionContextHost(
      [request, {}, () => undefined],
      Routes,
      Routes.prototype[route],
    );
    return cls.run(async () => {
      cls.set("requestId", "req-guards-test");
      let result = "passed";
      let error: AppError | undefined;
      try {
        for (const guard of guards) {
          await guard.canActivate(execution);
        }
      } catch (thrown) {
        if (!(thrown instanceof AppError)) {
          throw thrown;
        }
        error = thrown;
        result = thrown.code;
      }
      return {
        result,
        ...(error === undefined ? {} : { error }),
        actor: context.actor,
        token: accessTokenOf(request),
      };
    });
  }

  return { clock, tokens, reads, bearer, call };
}

describe("the guard order", () => {
  // FeatureGuard before RecentMfaGuard since FIX-W38-PLATFORM (lead decision (2i) of 2026-10-31, second batch); the
  // step-up came first before.
  it("[FIX-W38-PLATFORM AC6] runs RateLimitGuard, the auth guards of the scope, AccountRateLimitGuard, TenantRoleGuard, then FeatureGuard, then RecentMfaGuard (architecture §3)", () => {
    expect(API_GUARDS).toEqual([
      RateLimitGuard,
      InternalOnlyGuard,
      PortalAuthGuard,
      AdminAuthGuard,
      AccountRateLimitGuard,
      TenantRoleGuard,
      FeatureGuard,
      RecentMfaGuard,
    ]);
  });

  it("[FIX-W38-PLATFORM AC6] answers FEATURE_DISABLED before the step-up of setPayoutAccount and startStripeConnect", async () => {
    const off = harness();
    const on = harness({ settlements: true, own_stripe: true });
    // An MFA account without a recent step-up, and an account without MFA: the step-up would refuse both.
    const callers: ReadonlyArray<Partial<AccessTokenInput> & Pick<AccessTokenInput, "aud" | "sub">> = [
      { aud: "portal", sub: PERSON, amr: ["pwd", "otp"], mfa_at: NOW - 20 * MINUTE },
      { aud: "portal", sub: NO_MFA },
    ];

    for (const [route, feature] of [
      ["setPayoutAccount", "settlements"],
      ["startStripeConnect", "own_stripe"],
    ] as const) {
      for (const caller of callers) {
        const refused = await off.call(route, { headers: await off.bearer(caller) });
        expect([route, refused.result, refused.error?.details]).toEqual([
          route,
          "FEATURE_DISABLED",
          { feature },
        ]);
      }
      // With the switch on, the step-up answers as before.
      const outcomes = await Promise.all(
        callers.map(async (caller) => (await on.call(route, { headers: await on.bearer(caller) })).result),
      );
      expect([route, outcomes]).toEqual([route, ["REAUTH_REQUIRED", "MFA_REQUIRED"]]);
    }
  });
});

describe("PortalAuthGuard and AdminAuthGuard", () => {
  it("[PBE-012 AC1] refuse a portal token on an admin route and an admin token on a portal route (401)", async () => {
    const h = harness();

    const portalOnAdmin = await h.call("adminMe", { headers: await h.bearer({ aud: "portal", sub: ADMIN }) });
    const adminOnPortal = await h.call("tenant", {
      headers: await h.bearer({ aud: "platform_admin", sub: ADMIN }),
    });
    const adminOnUnverifiedScope = await h.call("me", {
      headers: await h.bearer({ aud: "platform_admin", sub: ADMIN }),
    });

    for (const outcome of [portalOnAdmin, adminOnPortal, adminOnUnverifiedScope]) {
      expect(outcome).toMatchObject({ result: "UNAUTHENTICATED", actor: undefined, token: undefined });
      expect(outcome.error?.status).toBe(401);
    }
  });

  it("[PBE-012 AC1] let each token through on its own surface and put the actor into the request context", async () => {
    const h = harness();

    const portal = await h.call("tenant", { headers: await h.bearer({ aud: "portal", sub: PERSON }) });
    const admin = await h.call("adminMe", { headers: await h.bearer({ aud: "platform_admin", sub: ADMIN }) });

    expect(portal).toMatchObject({ result: "passed", actor: { type: "account", accountId: PERSON } });
    expect(portal.token).toMatchObject({ aud: "portal", sub: PERSON, sid: FAMILY });
    expect(admin).toMatchObject({ result: "passed", actor: { type: "platform_admin", accountId: ADMIN } });
  });

  it("[PBE-012 AC2] let an unverified token reach portal_unverified routes and answer 403 EMAIL_NOT_VERIFIED on portal routes", async () => {
    const h = harness();
    const headers = await h.bearer({ aud: "portal", sub: UNVERIFIED, ev: false });

    const me = await h.call("me", { headers });
    const tenant = await h.call("tenant", { headers });

    expect(me).toMatchObject({ result: "passed", actor: { type: "account", accountId: UNVERIFIED } });
    expect(tenant.result).toBe("EMAIL_NOT_VERIFIED");
    expect(tenant.error?.status).toBe(403);
  });

  it("answer 401 UNAUTHENTICATED without a token or with another scheme, and TOKEN_EXPIRED for an expired one", async () => {
    const h = harness();
    const portal = await h.bearer({ aud: "portal", sub: PERSON });
    const admin = await h.bearer({ aud: "platform_admin", sub: ADMIN });

    expect((await h.call("me")).result).toBe("UNAUTHENTICATED");
    expect((await h.call("adminMe")).result).toBe("UNAUTHENTICATED");
    expect((await h.call("me", { headers: { authorization: "Basic dXNlcjpwYXNz" } })).result).toBe(
      "UNAUTHENTICATED",
    );
    h.clock.advance(15 * MINUTE * 1000);
    expect((await h.call("me", { headers: portal })).result).toBe("TOKEN_EXPIRED");
    expect((await h.call("adminMe", { headers: admin })).result).toBe("TOKEN_EXPIRED");
  });

  it("AdminAuthGuard re-reads the account: a revoked or disabled admin and an unknown account answer 401", async () => {
    const h = harness();

    for (const sub of [FORMER_ADMIN, DISABLED_ADMIN, "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1Z"]) {
      const outcome = await h.call("adminMe", { headers: await h.bearer({ aud: "platform_admin", sub }) });
      expect(outcome, sub).toMatchObject({ result: "UNAUTHENTICATED", actor: undefined });
    }
  });

  it("need no token on public routes and on handlers without an operation", async () => {
    const h = harness();

    expect(await h.call("plans")).toMatchObject({ result: "passed", actor: undefined, token: undefined });
    expect(await h.call("unbound", { peer: "203.0.113.7" })).toMatchObject({ result: "passed" });
  });
});

// PBE-067 (lead decision (5a) of 2026-11-05, security review F-1): PortalAuthGuard re-reads the account behind the
// token on every request. One test per state of `platform.accounts.status`, and the erased account, which
// AccountAuthStates does not find. Each token would pass everything else: a verified e-mail and a TOTP step-up now,
// with the settlements switch on, so `setPayoutAccount` (x-feature: settlements, x-mfa-step-up) reaches its step-up.
describe("PortalAuthGuard and the account's state", () => {
  /** The portal routes of both scopes and two sensitive actions (x-mfa-step-up). */
  const PORTAL_ROUTES = ["me", "tenant", "disableMfa", "setPayoutAccount"] as const;

  /** A portal token of `sub` with a verified e-mail and a TOTP step-up now. */
  const steppedUp = (sub: string): Partial<AccessTokenInput> & Pick<AccessTokenInput, "aud" | "sub"> => ({
    aud: "portal",
    sub,
    amr: ["pwd", "otp"],
    mfa_at: NOW,
  });

  it.each([
    ["a disabled", DISABLED],
    ["a deleted", DELETED],
    ["an erased (or unknown)", ERASED],
  ])(
    "[PBE-067 AC1] answers 401 UNAUTHENTICATED for the unexpired token of %s account on every portal route, sensitive actions included",
    async (_state, sub) => {
      const h = harness({ settlements: true });
      const headers = await h.bearer(steppedUp(sub));

      for (const route of PORTAL_ROUTES) {
        const outcome = await h.call(route, { headers });
        expect([route, outcome.result, outcome.error?.status]).toEqual([route, "UNAUTHENTICATED", 401]);
        // Refused before the request gets an actor or claims, as AdminAuthGuard refuses.
        expect(outcome, route).toMatchObject({ actor: undefined, token: undefined });
      }
      // One read of the account per request, by the portal guard; the step-up guard never ran.
      expect(h.reads).toEqual(PORTAL_ROUTES.map(() => sub));
    },
  );

  it("[PBE-067 AC1] refuses a disabled account before the e-mail check", async () => {
    const h = harness();

    const outcome = await h.call("tenant", {
      headers: await h.bearer({ aud: "portal", sub: DISABLED, ev: false }),
    });

    expect([outcome.result, outcome.error?.status]).toEqual(["UNAUTHENTICATED", 401]);
  });

  it.each([
    ["an active", PERSON],
    ["a locked", LOCKED],
  ])(
    "[PBE-067 AC2] lets the token of %s account through, reading the account once per request",
    async (_state, sub) => {
      const h = harness({ settlements: true });
      const headers = await h.bearer(steppedUp(sub));

      for (const route of PORTAL_ROUTES) {
        const outcome = await h.call(route, { headers });
        expect([route, outcome.result]).toEqual([route, "passed"]);
        expect(outcome.actor, route).toEqual({ type: "account", accountId: sub });
      }
      // The portal guard reads it on each request; the step-up guard reads it again for its two operations.
      expect(h.reads).toEqual([sub, sub, sub, sub, sub, sub]);
    },
  );

  it("[PBE-067 AC2] keeps the answers of a pending_verification account: portal_unverified passes, portal answers 403 EMAIL_NOT_VERIFIED", async () => {
    const h = harness();
    const headers = await h.bearer({ aud: "portal", sub: UNVERIFIED, ev: false });

    const me = await h.call("me", { headers });
    const tenant = await h.call("tenant", { headers });

    expect(me).toMatchObject({ result: "passed", actor: { type: "account", accountId: UNVERIFIED } });
    expect([tenant.result, tenant.error?.status]).toEqual(["EMAIL_NOT_VERIFIED", 403]);
    expect(h.reads).toEqual([UNVERIFIED, UNVERIFIED]);
  });

  it("[PBE-067 AC1] lets only active, pending_verification and locked accounts use a portal token, and fails closed on any other state", () => {
    const stateOf = (status: string): AccountAuthState => ({
      // A value the column's CHECK does not list yet stands for a state a later migration adds.
      status: status as AccountStatus,
      isPlatformAdmin: false,
      mfaEnabled: true,
    });
    const statuses = ["active", "pending_verification", "locked", "disabled", "deleted", "suspended"];

    expect(statuses.map((status) => [status, mayUsePortalToken(stateOf(status))])).toEqual([
      ["active", true],
      ["pending_verification", true],
      ["locked", true],
      ["disabled", false],
      ["deleted", false],
      ["suspended", false],
    ]);
    // AccountAuthStates finds no account, or an erased one (`deleted_at` set).
    expect(mayUsePortalToken(undefined)).toBe(false);
  });

  it("[PBE-067 AC2] reads no account on public and admin routes, and a portal token stays refused on the admin surface", async () => {
    const h = harness();

    expect((await h.call("plans")).result).toBe("passed");
    const portalOnAdmin = await h.call("adminMe", {
      headers: await h.bearer({ aud: "portal", sub: PERSON }),
    });

    expect(portalOnAdmin.result).toBe("UNAUTHENTICATED");
    // AdminAuthGuard verifies the token's audience first and never reads the account of a portal token.
    expect(h.reads).toEqual([]);
  });
});

describe("RecentMfaGuard", () => {
  it("[PBE-012 AC3] answers 401 REAUTH_REQUIRED for an mfa_at 16 minutes old and lets 15 minutes through", async () => {
    const h = harness();

    const fresh = await h.call("disableMfa", {
      headers: await h.bearer({ aud: "portal", sub: PERSON, amr: ["pwd", "otp"], mfa_at: NOW - 15 * MINUTE }),
    });
    const stale = await h.call("disableMfa", {
      headers: await h.bearer({ aud: "portal", sub: PERSON, amr: ["pwd", "otp"], mfa_at: NOW - 16 * MINUTE }),
    });
    const never = await h.call("disableMfa", { headers: await h.bearer({ aud: "portal", sub: PERSON }) });

    expect(fresh.result).toBe("passed");
    expect(stale.result).toBe("REAUTH_REQUIRED");
    expect(stale.error?.status).toBe(401);
    expect(never.result).toBe("REAUTH_REQUIRED");
    expect(MFA_STEP_UP_WINDOW_SECONDS).toBe(15 * MINUTE);
  });

  it("[PBE-012 AC3] answers 403 MFA_REQUIRED for an account without MFA, even with a recent mfa_at", async () => {
    const h = harness();

    const outcome = await h.call("disableMfa", {
      headers: await h.bearer({ aud: "portal", sub: NO_MFA, amr: ["pwd", "otp"], mfa_at: NOW - MINUTE }),
    });

    expect(outcome.result).toBe("MFA_REQUIRED");
    expect(outcome.error?.status).toBe(403);
  });

  it("[PBE-012 AC3] applies to x-mfa-step-up admin operations too, as the window moves with the clock", async () => {
    const h = harness();
    // A refreshed token of the family copies mfa_at (PBE-014), so it outlives the token that was signed with it.
    const refreshed = () => h.bearer({ aud: "platform_admin", sub: ADMIN, mfa_at: NOW });

    expect((await h.call("grantAdmin", { headers: await refreshed() })).result).toBe("passed");
    h.clock.advance(15 * MINUTE * 1000);
    expect((await h.call("grantAdmin", { headers: await refreshed() })).result).toBe("passed");
    h.clock.advance(1000);
    expect((await h.call("grantAdmin", { headers: await refreshed() })).result).toBe("REAUTH_REQUIRED");
  });

  it("acts on @RequireRecentMfa(), and refuses it where no auth guard verified a token", async () => {
    const h = harness();
    const headers = await h.bearer({
      aud: "portal",
      sub: PERSON,
      amr: ["pwd", "otp"],
      mfa_at: NOW - 20 * MINUTE,
    });

    expect((await h.call("tenant", { headers })).result).toBe("passed");
    expect((await h.call("tenantWithStepUp", { headers })).result).toBe("REAUTH_REQUIRED");
    expect((await h.call("publicWithStepUp")).result).toBe("UNAUTHENTICATED");
  });
});

describe("FeatureGuard", () => {
  it("[PBE-012 AC4] answers 403 FEATURE_DISABLED with details.feature for x-feature: custom_domains while FEATURE_CUSTOM_DOMAINS=false", async () => {
    const off = harness({ custom_domains: false });
    const on = harness({ custom_domains: true });

    const refused = await off.call("domains", { headers: await off.bearer({ aud: "portal", sub: PERSON }) });
    const allowed = await on.call("domains", { headers: await on.bearer({ aud: "portal", sub: PERSON }) });

    expect(refused.result).toBe("FEATURE_DISABLED");
    expect(refused.error?.status).toBe(403);
    expect(refused.error?.details).toEqual({ feature: "custom_domains" });
    expect(allowed.result).toBe("passed");
  });

  it("runs after the auth guard, and acts on @Feature() too", async () => {
    const h = harness({ custom_domains: false, live_switch: false });

    expect((await h.call("domains")).result).toBe("UNAUTHENTICATED");
    const decorated = await h.call("meBehindLiveSwitch", {
      headers: await h.bearer({ aud: "portal", sub: PERSON }),
    });
    expect(decorated.error?.details).toEqual({ feature: "live_switch" });
  });
});

describe("InternalOnlyGuard", () => {
  it("[PBE-012 AC5] answers 404 for an internal route called with X-Forwarded-For", async () => {
    const h = harness();

    const outcome = await h.call("ready", { headers: { "x-forwarded-for": "198.51.100.23" } });

    expect(outcome.result).toBe("NOT_FOUND");
    expect(outcome.error?.status).toBe(404);
  });

  it("[PBE-012 AC5] answers 404 from a peer that is not loopback and lets loopback through without a token", async () => {
    const h = harness();

    expect((await h.call("ready", { peer: "203.0.113.7" })).result).toBe("NOT_FOUND");
    expect((await h.call("ready", { peer: "10.0.0.5" })).result).toBe("NOT_FOUND");
    expect((await h.call("ready", { peer: "127.0.0.1" })).result).toBe("passed");
    expect((await h.call("ready", { peer: "::1" })).result).toBe("passed");
    expect((await h.call("ready", { peer: "::ffff:127.0.0.1" })).result).toBe("passed");
  });
});

describe("OperationPolicies", () => {
  /** A one-operation document and its index entry, to see what the policies refuse. */
  function policiesFor(operation: Record<string, unknown>, scope: string | null): OperationPolicies {
    const api = PlatformOpenApi.fromDocument({
      openapi: "3.1.0",
      paths: { "/thing": { get: { operationId: "getThing", responses: {}, ...operation } } },
    });
    const entry = {
      operationId: "getThing",
      method: "get",
      path: "/thing",
      scope,
    } as unknown as ApiOperation;
    return new OperationPolicies(api, [entry]);
  }

  it("reads the scope from the operations index and x-mfa-step-up and x-feature from the real document", () => {
    const policies = new OperationPolicies(PlatformOpenApi.load());

    expect(policies.forOperation("disableMfa")).toEqual({ scope: "portal", mfaStepUp: true, features: [] });
    expect(policies.forOperation("getMe")).toEqual({
      scope: "portal_unverified",
      mfaStepUp: false,
      features: [],
    });
    expect(policies.forOperation("adminRevokeAdmin")).toMatchObject({
      scope: "platform_admin",
      mfaStepUp: true,
    });
    expect(policies.forOperation("tlsAsk")).toMatchObject({ scope: "internal" });
    expect(policies.forOperation("healthLive")).toMatchObject({ scope: "public" });
    for (const { operationId, scope } of platformOperations) {
      expect(policies.forOperation(operationId)?.scope, operationId).toBe(scope);
    }
  });

  it("refuses to start with an unknown scope, a step-up without a token scope or an unknown switch", () => {
    expect(() => policiesFor({}, "partner")).toThrow(/getThing: the operations index gives no x-scope/);
    expect(() => policiesFor({}, null)).toThrow(/getThing: the operations index gives no x-scope/);
    expect(() => policiesFor({ "x-mfa-step-up": true }, "public")).toThrow(
      /needs a portal or platform_admin/,
    );
    expect(() => policiesFor({ "x-mfa-step-up": "yes" }, "portal")).toThrow(/must be true or false/);
    expect(() => policiesFor({ "x-feature": "teleport" }, "portal")).toThrow(/not a switch of PADR-0015/);
    expect(policiesFor({ "x-feature": "settlements" }, "portal").forOperation("getThing")).toEqual({
      scope: "portal",
      mfaStepUp: false,
      features: ["settlements"],
    });
  });

  it("refuses @Feature() with a name that is not a switch", () => {
    expect(() => Feature("teleport" as FeatureName)).toThrow(TypeError);
  });
});

describe("featuresFor", () => {
  it("builds the MilestoneFeatures object of getMe from the six switches", () => {
    const config = Object.fromEntries(
      FEATURES.map((feature) => [FEATURE_VARIABLES[feature], feature === "custom_domains"]),
    ) as Parameters<typeof featuresFor>[0];

    expect(featuresFor(config)).toEqual({
      stripeBilling: false,
      ownStripe: false,
      settlements: false,
      ownAmadeus: false,
      customDomains: true,
      liveSwitch: false,
    });
  });

  it("matches the MilestoneFeatures schema of the document, property for property", () => {
    const schema = PlatformOpenApi.load().document["components"] as {
      schemas: { MilestoneFeatures: { required: string[]; properties: Record<string, unknown> } };
    };
    const off = featuresFor(
      Object.fromEntries(FEATURES.map((feature) => [FEATURE_VARIABLES[feature], false])) as Parameters<
        typeof featuresFor
      >[0],
    );

    expect(Object.keys(off).sort()).toEqual([...schema.schemas.MilestoneFeatures.required].sort());
    expect(Object.keys(off).sort()).toEqual(Object.keys(schema.schemas.MilestoneFeatures.properties).sort());
  });
});
