// The staff guard (OBE-059; architecture §3 step 8, OADR-0011 point 3): which operations take a staff token, read from
// the OTA document's `security` alternatives, and what the guard does with the bearer token of a key caller in
// console scope, with a minimal execution context, the tokens of the test process's key file, a FakeClock and the
// session checks stubbed (staff-auth.service.test.ts tests them; the whole pipeline against PostgreSQL and Redis is
// test/integration/console/staff-auth.int.test.ts).
import type { ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { AppError, isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { beforeAll, describe, expect, it } from "vitest";
import { testApiCredentials } from "../../../test/helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS } from "../../../test/helpers/openapi";
import type { Clock } from "../clock";
import type { ApiConfig } from "../../config";
import {
  STAFF_FAMILY_LIFETIME_MS,
  StaffTokens,
  type AuthenticatedStaff,
  type StaffSessions,
  type StaffTokenClaims,
} from "../../identity/staff/staff-sessions";
import { TokenService } from "../../identity/token.service";
import type { Caller, CallerContext, EdgeCaller, KeyCaller } from "../../tenancy/caller-resolver";
import type { PlatformStaffMember } from "../../tenancy/platform-read.repository";
import type { ContextActor, RequestTenant, TenantContext } from "../../tenancy/tenant-context";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import { loadOpenApiDocument, type OpenApiDocument } from "../http/openapi-validation.interceptor";
import type { RequestContext } from "../http/request-context";
import {
  StaffGuard,
  staffRequirementOf,
  staffRequirements,
  type EndedStaffSession,
  type StaffContext,
  type StaffPrincipal,
} from "./staff.guard";

const TENANT_A = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1A";
const TENANT_B = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1B";
const STAFF_ID = "stf_01JA2Z9W5K7Q3M8N4P6R2T0V1D";
const ACCOUNT_ID = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1C";
const FAMILY_ID = "asn_01JA2Z9W5K7Q3M8N4P6R2T0V1F";
const START = "2026-10-18T09:00:00.000Z";

const KEY: KeyCaller = Object.freeze({
  type: "key",
  id: "key_01JA2Z9W5K7Q3M8N4P6R2T0V1K",
  keyId: "key_01JA2Z9W5K7Q3M8N4P6R2T0V1K",
  kind: "secret",
  tenantId: TENANT_A,
  environment: "test",
  scopes: ["console"],
});
const EDGE: EdgeCaller = Object.freeze({ type: "edge", id: "edge", host: "alpha.ota.example.com" });

const MEMBER: PlatformStaffMember = {
  id: STAFF_ID,
  tenantId: TENANT_A,
  accountId: ACCOUNT_ID,
  role: "agent",
  status: "active",
  lastActiveAt: null,
  createdAt: START,
  account: {
    email: "maria.lopez@example.com",
    fullName: "Maria Lopez",
    locale: "en",
    timeZone: "UTC",
    mfaEnabled: false,
    status: "active",
    deletedAt: null,
  },
  tenantTimeZone: "UTC",
};

let document: OpenApiDocument;

// The OTA document is parsed and its validators compiled once per test process (about 1.5 s alone, much more while
// every package's tests run at once): here, with the budget of test/helpers/openapi.ts.
beforeAll(() => {
  document = loadOpenApiDocument();
}, OPENAPI_SETUP_TIMEOUT_MS);

/** Handlers bound to operations of the document, and one that is not. */
class Handlers {
  consoleGetMe(): void {}
  consoleSignOut(): void {}
  consoleSignIn(): void {}
  consoleListBookings(): void {}
  unbound(): void {}
}
for (const operationId of [
  "consoleGetMe",
  "consoleSignOut",
  "consoleSignIn",
  "consoleListBookings",
] as const) {
  Reflect.defineMetadata(OPENAPI_OPERATION, operationId, Handlers.prototype[operationId]);
}
type HandlerName = keyof Handlers;

const configWith = (path: string) => ({ get: () => path }) as unknown as ConfigService<ApiConfig, true>;

interface Harness {
  readonly guard: StaffGuard;
  readonly actors: ContextActor[];
  readonly principals: StaffPrincipal[];
  readonly authenticated: StaffTokenClaims[];
  readonly refusals: unknown[];
  readonly expired: { count: number };
  readonly ended: EndedStaffSession[];
  readonly tokens: StaffTokens;
  readonly clock: FakeClock;
}

interface HarnessOptions {
  readonly caller?: Caller;
  readonly consoleScope?: boolean;
  /** What the session checks answer; the default accepts every session. */
  readonly authenticate?: (claims: StaffTokenClaims) => Promise<AuthenticatedStaff>;
}

function harness(options: HarnessOptions = {}): Harness {
  const actors: ContextActor[] = [];
  const principals: StaffPrincipal[] = [];
  const authenticated: StaffTokenClaims[] = [];
  const refusals: unknown[] = [];
  const expired = { count: 0 };
  const ended: EndedStaffSession[] = [];
  const clock = new FakeClock(START);
  const tokens = new StaffTokens(configWith(testApiCredentials().jwtKeyFile), clock as unknown as Clock);
  const sessions = {
    authenticate: (claims: StaffTokenClaims) => {
      authenticated.push(claims);
      return (
        options.authenticate?.(claims) ??
        Promise.resolve({
          family: {
            id: claims.sid,
            staffId: claims.sub,
            accountId: ACCOUNT_ID,
            tenantId: claims.tid,
            role: claims.role,
            createdAt: new Date(START),
            expiresAt: new Date(Date.parse(START) + STAFF_FAMILY_LIFETIME_MS),
            userAgent: null,
          },
          member: MEMBER,
        })
      );
    },
  } as unknown as StaffSessions;
  const guard = new StaffGuard(
    new Reflector(),
    { get: () => options.caller ?? KEY } as unknown as CallerContext,
    {
      require: () => ({ tenantId: TENANT_A }) as RequestTenant,
      setActor: (actor: ContextActor) => actors.push(actor),
    } as unknown as TenantContext,
    { isConsoleScope: () => options.consoleScope ?? true } as unknown as RequestContext,
    tokens,
    sessions,
    {
      set: (principal: StaffPrincipal) => principals.push(principal),
      markExpiredToken: () => {
        expired.count += 1;
      },
      markEndedSession: (session: EndedStaffSession) => ended.push(session),
    } as unknown as StaffContext,
    document,
    { info: (fields: { reason: unknown }) => refusals.push(fields.reason) } as unknown as PinoLogger,
  );
  return { guard, actors, principals, authenticated, refusals, expired, ended, tokens, clock };
}

/** An execution context of `handler` with the request's headers. */
function execution(handler: HandlerName, headers: Record<string, string> = {}): ExecutionContext {
  const req = { headers };
  return {
    getType: () => "http",
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** A staff token of `tid` from `tokens`. */
async function staffToken(tokens: StaffTokens, tid = TENANT_A): Promise<string> {
  return (await tokens.sign({ sub: STAFF_ID, tid, sid: FAMILY_ID, role: "agent" })).token;
}

/** The refusal of `canActivate` as `<status> <code>`. */
async function refusal(promise: Promise<boolean>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) {
      return `${error.status} ${error.code}`;
    }
    throw error;
  }
  return "allowed";
}

describe("staffRequirementOf", () => {
  it("reads the requirement from the key alternatives of an operation's security", () => {
    expect(staffRequirementOf([{ apiKey: [], staffAuth: [] }])).toBe("required");
    expect(staffRequirementOf([{ apiKey: [], staffAuth: [] }, { apiKey: [] }])).toBe("optional");
    expect(staffRequirementOf([{ apiKey: [] }])).toBe("none");
    expect(staffRequirementOf([{ storefrontEdge: [] }])).toBe("none");
    expect(staffRequirementOf(undefined)).toBe("none");
  });

  it("requires a staff token on console.auth.me, takes one on signOut, and reads none on signIn and refresh", () => {
    const requirements = staffRequirements(document.document);

    expect(requirements.get("consoleGetMe")).toBe("required");
    expect(requirements.get("consoleSignOut")).toBe("optional");
    expect(requirements.get("consoleSignIn")).toBe("none");
    expect(requirements.get("consoleRefreshSession")).toBe("none");
    expect(requirements.get("consoleListBookings")).toBe("optional");
    expect(requirements.get("getSession")).toBe("none");
  });
});

describe("StaffGuard", () => {
  it("accepts a staff token of the tenant, checks its session and makes the staff member the actor", async () => {
    const h = harness();
    const token = await staffToken(h.tokens);

    expect(await h.guard.canActivate(execution("consoleGetMe", bearer(token)))).toBe(true);

    expect(h.authenticated).toEqual([
      expect.objectContaining({ sub: STAFF_ID, sid: FAMILY_ID, role: "agent" }),
    ]);
    expect(h.actors).toEqual([{ type: "staff", id: STAFF_ID }]);
    expect(h.principals).toEqual([
      expect.objectContaining({
        member: MEMBER,
        family: expect.objectContaining({ id: FAMILY_ID }),
        accessTokenExpiresAt: new Date("2026-10-18T09:15:00.000Z"),
      }),
    ]);
  });

  it("answers 401 UNAUTHENTICATED without a token where one is required, and lets optional operations through", async () => {
    const h = harness();

    expect(await refusal(h.guard.canActivate(execution("consoleGetMe")))).toBe("401 UNAUTHENTICATED");
    expect(await h.guard.canActivate(execution("consoleSignOut"))).toBe(true);
    expect(await h.guard.canActivate(execution("consoleListBookings"))).toBe(true);
    expect(h.principals).toEqual([]);
  });

  it("refuses a customer token, another tenant's token and a malformed one with 401 UNAUTHENTICATED", async () => {
    const h = harness();
    const customers = new TokenService(
      configWith(testApiCredentials().jwtKeyFile),
      h.clock as unknown as Clock,
    );
    const customer = await customers.signCustomerToken({
      sub: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
      tid: TENANT_A,
      sid: "ses_01JA2Z9W5K7Q3M8N4P6R2T0V1S",
    });
    const otherTenant = await staffToken(h.tokens, TENANT_B);

    for (const token of [customer.token, otherTenant, "not.a.jwt"]) {
      expect(await refusal(h.guard.canActivate(execution("consoleGetMe", bearer(token))))).toBe(
        "401 UNAUTHENTICATED",
      );
      expect(await refusal(h.guard.canActivate(execution("consoleSignOut", bearer(token))))).toBe(
        "401 UNAUTHENTICATED",
      );
    }
    expect(h.refusals).toEqual([
      "claims",
      "claims",
      "other_tenant",
      "other_tenant",
      "malformed",
      "malformed",
    ]);
    expect(h.authenticated).toEqual([]);
  });

  it("answers 401 TOKEN_EXPIRED for an expired token, except on signOut, where it counts as none", async () => {
    const h = harness();
    const token = await staffToken(h.tokens);
    h.clock.advance(16 * 60_000);

    expect(await refusal(h.guard.canActivate(execution("consoleGetMe", bearer(token))))).toBe(
      "401 TOKEN_EXPIRED",
    );
    expect(await refusal(h.guard.canActivate(execution("consoleListBookings", bearer(token))))).toBe(
      "401 TOKEN_EXPIRED",
    );
    expect(await h.guard.canActivate(execution("consoleSignOut", bearer(token)))).toBe(true);
    expect(h.expired.count).toBe(1);
    expect(h.principals).toEqual([]);
  });

  it("passes on what the session checks answer: a revoked session or an inactive member", async () => {
    const revoked = harness({ authenticate: () => Promise.reject(new AppError("UNAUTHENTICATED")) });
    const removed = harness({
      authenticate: () => Promise.reject(new AppError("STAFF_MEMBERSHIP_INACTIVE")),
    });

    expect(
      await refusal(
        revoked.guard.canActivate(execution("consoleGetMe", bearer(await staffToken(revoked.tokens)))),
      ),
    ).toBe("401 UNAUTHENTICATED");
    expect(
      await refusal(
        removed.guard.canActivate(execution("consoleGetMe", bearer(await staffToken(removed.tokens)))),
      ),
    ).toBe("403 STAFF_MEMBERSHIP_INACTIVE");
    expect(revoked.actors).toEqual([]);
    expect(removed.principals).toEqual([]);
  });

  it("takes a valid token whose session has ended as none on signOut only, never a failure to check", async () => {
    const revoked = harness({ authenticate: () => Promise.reject(new AppError("UNAUTHENTICATED")) });
    const removed = harness({
      authenticate: () => Promise.reject(new AppError("STAFF_MEMBERSHIP_INACTIVE")),
    });
    const down = harness({ authenticate: () => Promise.reject(new AppError("SERVICE_UNAVAILABLE")) });

    for (const h of [revoked, removed]) {
      const token = await staffToken(h.tokens);
      expect(await h.guard.canActivate(execution("consoleSignOut", bearer(token)))).toBe(true);
      expect(h.ended).toEqual([{ familyId: FAMILY_ID, staffId: STAFF_ID }]);
      expect(h.principals).toEqual([]);
      expect(h.actors).toEqual([]);
      expect(h.expired.count).toBe(0);
    }
    // Every other operation answers what the checks answer, an optional one included.
    expect(
      await refusal(
        revoked.guard.canActivate(execution("consoleListBookings", bearer(await staffToken(revoked.tokens)))),
      ),
    ).toBe("401 UNAUTHENTICATED");
    expect(
      await refusal(
        removed.guard.canActivate(execution("consoleListBookings", bearer(await staffToken(removed.tokens)))),
      ),
    ).toBe("403 STAFF_MEMBERSHIP_INACTIVE");
    expect(
      await refusal(
        down.guard.canActivate(execution("consoleSignOut", bearer(await staffToken(down.tokens)))),
      ),
    ).toBe("503 SERVICE_UNAVAILABLE");
    expect(down.ended).toEqual([]);
  });

  it("leaves customer scope, the edge, signIn and unbound handlers alone", async () => {
    const customerScope = harness({ consoleScope: false });
    const edge = harness({ caller: EDGE });
    const h = harness();
    const token = "anything";

    expect(await customerScope.guard.canActivate(execution("consoleGetMe", bearer(token)))).toBe(true);
    expect(await edge.guard.canActivate(execution("consoleGetMe", bearer(token)))).toBe(true);
    expect(await h.guard.canActivate(execution("consoleSignIn", bearer(token)))).toBe(true);
    expect(await h.guard.canActivate(execution("unbound", bearer(token)))).toBe(true);
    expect([...customerScope.authenticated, ...edge.authenticated, ...h.authenticated]).toEqual([]);
  });
});
