// The customer guard (OBE-031 step 4; architecture §3 step 8, OADR-0006 points 1 and 5): which operations need a
// customer, read from the OTA document's `security` alternatives, and what the guard does with the bearer token of a
// key caller and the `__Host-vx_at` cookie of the storefront edge, with a minimal execution context, the tokens of the
// test process's key file and a FakeClock. The guard in the API's pipeline, against PostgreSQL:
// test/integration/identity/sessions.int.test.ts.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { otaOperations } from "@velexis/api-types/operations";
import { isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { ClsService } from "nestjs-cls";
import type { PinoLogger } from "nestjs-pino";
import { beforeAll, describe, expect, it } from "vitest";
import { testApiCredentials } from "../../../test/helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS } from "../../../test/helpers/openapi";
import type { ApiConfig } from "../../config";
import { ACCESS_TOKEN_TTL_SECONDS, CLOCK_SKEW_SECONDS, TokenService } from "../../identity/token.service";
import type { CallerContext, EdgeCaller, KeyCaller, Caller } from "../../tenancy/caller-resolver";
import type { ContextActor, RequestTenant, TenantContext } from "../../tenancy/tenant-context";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import { loadOpenApiDocument, type OpenApiDocument } from "../http/openapi-validation.interceptor";
import type { RequestContext } from "../http/request-context";
import {
  CustomerContext,
  CustomerGuard,
  customerRequirementOf,
  customerRequirements,
  type CustomerPrincipal,
} from "./customer.guard";

const TENANT_A = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1A";
const TENANT_B = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1B";
const CUSTOMER = "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const SESSION = "ses_01JA2Z9W5K7Q3M8N4P6R2T0V1S";
const START = "2026-10-18T09:00:00.000Z";

const EDGE: EdgeCaller = Object.freeze({ type: "edge", id: "edge", host: "alpha.ota.example.com" });
const KEY: KeyCaller = Object.freeze({
  type: "key",
  id: "key_01JA2Z9W5K7Q3M8N4P6R2T0V1K",
  keyId: "key_01JA2Z9W5K7Q3M8N4P6R2T0V1K",
  kind: "publishable",
  tenantId: TENANT_A,
  environment: "test",
  scopes: [],
});

let document: OpenApiDocument;

// The OTA document is parsed and its validators compiled once per test process (about 1.5 s alone, much more while
// every package's tests run at once): here, with the budget of test/helpers/openapi.ts.
beforeAll(() => {
  document = loadOpenApiDocument();
}, OPENAPI_SETUP_TIMEOUT_MS);

/** Handlers bound to operations of the document, and one that is not. */
class Handlers {
  getSession(): void {}
  createFlightSearch(): void {}
  signIn(): void {}
  signOut(): void {}
  getBooking(): void {}
  unbound(): void {}
}
for (const operationId of ["getSession", "createFlightSearch", "signIn", "signOut", "getBooking"] as const) {
  Reflect.defineMetadata(OPENAPI_OPERATION, operationId, Handlers.prototype[operationId]);
}
type HandlerName = keyof Handlers;

const configWith = (path: string) => ({ get: () => path }) as unknown as ConfigService<ApiConfig, true>;

/** The token service of the test process's key file at `clock`. */
const tokensAt = (clock: FakeClock): TokenService =>
  new TokenService(configWith(testApiCredentials().jwtKeyFile), clock);

interface Harness {
  readonly guard: CustomerGuard;
  /** The actors the guard set, in order. */
  readonly actors: ContextActor[];
  /** The customers the guard put into the request context, in order. */
  readonly customers: CustomerPrincipal[];
  /** The reasons of the refusals it logged. */
  readonly refusals: unknown[];
  /** How often it recorded an expired token that it let through as none. */
  readonly expired: { count: number };
}

interface HarnessOptions {
  readonly caller?: Caller | undefined;
  readonly tenantId?: string;
  readonly consoleScope?: boolean;
  readonly clock?: FakeClock;
}

function harness(options: HarnessOptions = {}): Harness {
  const actors: ContextActor[] = [];
  const customers: CustomerPrincipal[] = [];
  const refusals: unknown[] = [];
  const expired = { count: 0 };
  const caller = "caller" in options ? options.caller : KEY;
  const tenants = {
    require: () => ({ tenantId: options.tenantId ?? TENANT_A }) as RequestTenant,
    setActor: (actor: ContextActor) => actors.push(actor),
  } as unknown as TenantContext;
  const guard = new CustomerGuard(
    new Reflector(),
    { get: () => caller } as unknown as CallerContext,
    tenants,
    { isConsoleScope: () => options.consoleScope ?? false } as unknown as RequestContext,
    tokensAt(options.clock ?? new FakeClock(START)),
    {
      set: (customer: CustomerPrincipal) => customers.push(customer),
      markExpiredToken: () => {
        expired.count += 1;
      },
    } as unknown as CustomerContext,
    document,
    { info: (fields: { reason: unknown }) => refusals.push(fields.reason) } as unknown as PinoLogger,
  );
  return { guard, actors, customers, refusals, expired };
}

/** An execution context of `handler` with the request's headers and cookies. */
function execution(
  handler: HandlerName,
  request: { headers?: Record<string, string>; cookies?: Record<string, string> } = {},
): ExecutionContext {
  const req = { headers: request.headers ?? {}, cookies: request.cookies ?? {} };
  return {
    getType: () => "http",
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** A customer access token of `tenantId` issued at `issuedAt`. */
async function accessToken(tenantId = TENANT_A, issuedAt = START): Promise<string> {
  const { token } = await tokensAt(new FakeClock(issuedAt)).signCustomerToken({
    sub: CUSTOMER,
    tid: tenantId,
    sid: SESSION,
  });
  return token;
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const cookie = (token: string) => ({ cookies: { "__Host-vx_at": token } });

/** The AppError code `run` rejects with, or `"passed"`. */
async function outcome(run: Promise<boolean>): Promise<string> {
  try {
    expect(await run).toBe(true);
    return "passed";
  } catch (error) {
    if (isAppError(error)) {
      return `${error.status} ${error.code}`;
    }
    throw error;
  }
}

describe("the customer requirement of an operation", () => {
  it("comes from the document's security alternatives of each kind of caller", () => {
    const requirements = customerRequirements(document.document);

    expect(requirements.get("getSession")).toEqual({ key: "required", edge: "required" });
    expect(requirements.get("getAccount")).toEqual({ key: "required", edge: "required" });
    expect(requirements.get("changePassword")).toEqual({ key: "required", edge: "required" });
    expect(requirements.get("createFlightSearch")).toEqual({ key: "optional", edge: "optional" });
    expect(requirements.get("signOut")).toEqual({ key: "optional", edge: "optional" });
    expect(requirements.get("getBooking")).toEqual({ key: "optional", edge: "optional" });
    expect(requirements.get("completeCheckoutWithAirlineCard")).toEqual({ key: "none", edge: "optional" });
    expect(requirements.get("signIn")).toEqual({ key: "none", edge: "none" });
    expect(requirements.get("getStorefront")).toEqual({ key: "none", edge: "none" });
    expect(requirements.get("consoleGetMe")).toEqual({ key: "none", edge: "none" });
    // Every operation of the generated index has one.
    expect([...requirements.keys()].sort()).toEqual(
      otaOperations.map((operation) => operation.operationId).sort(),
    );
  });

  it("counts only the alternatives of the caller's own scheme", () => {
    const security = [{ apiKey: [], customerAuth: [] }, { storefrontEdge: [] }];

    expect(customerRequirementOf(security, "key")).toBe("required");
    expect(customerRequirementOf(security, "edge")).toBe("none");
    expect(customerRequirementOf([{ storefrontEdge: [], customerAuth: [] }], "edge")).toBe("none");
    expect(customerRequirementOf(undefined, "key")).toBe("none");
    expect(customerRequirementOf([], "edge")).toBe("none");
  });
});

describe("CustomerGuard", () => {
  it("makes the customer of a key caller's bearer token the actor and puts the session into the request context", async () => {
    const { guard, actors, customers } = harness();

    expect(await outcome(guard.canActivate(execution("getSession", bearer(await accessToken()))))).toBe(
      "passed",
    );

    expect(actors).toEqual([{ type: "customer", id: CUSTOMER }]);
    expect(customers).toEqual([
      {
        customerId: CUSTOMER,
        sessionId: SESSION,
        accessTokenExpiresAt: new Date(Date.parse(START) + ACCESS_TOKEN_TTL_SECONDS * 1000),
      },
    ]);
  });

  it("reads the edge's __Host-vx_at cookie", async () => {
    const { guard, actors } = harness({ caller: EDGE });

    expect(await outcome(guard.canActivate(execution("getSession", cookie(await accessToken()))))).toBe(
      "passed",
    );
    expect(actors).toEqual([{ type: "customer", id: CUSTOMER }]);
  });

  it("answers 401 UNAUTHENTICATED to a token of tenant A presented at tenant B, by key or edge [OBE-031 AC1] [OF-01 AC2]", async () => {
    const token = await accessToken(TENANT_A);
    const byKey = harness({ tenantId: TENANT_B });
    const byEdge = harness({ caller: EDGE, tenantId: TENANT_B });

    expect(await outcome(byKey.guard.canActivate(execution("getSession", bearer(token))))).toBe(
      "401 UNAUTHENTICATED",
    );
    expect(await outcome(byEdge.guard.canActivate(execution("getSession", cookie(token))))).toBe(
      "401 UNAUTHENTICATED",
    );
    // An optional operation refuses it too: a presented token must be valid.
    expect(await outcome(byKey.guard.canActivate(execution("createFlightSearch", bearer(token))))).toBe(
      "401 UNAUTHENTICATED",
    );
    expect([...byKey.refusals, ...byEdge.refusals]).toEqual(["other_tenant", "other_tenant", "other_tenant"]);
    expect([...byKey.actors, ...byEdge.actors]).toEqual([]);
  });

  it("answers 401 TOKEN_EXPIRED for an expired token of the tenant, after the 30 s of clock skew", async () => {
    const token = await accessToken();
    const clock = new FakeClock(Date.parse(START) + (ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_SECONDS) * 1000);
    const { guard, refusals } = harness({ clock });

    expect(await outcome(guard.canActivate(execution("getSession", bearer(token))))).toBe(
      "401 TOKEN_EXPIRED",
    );
    expect(await outcome(guard.canActivate(execution("createFlightSearch", bearer(token))))).toBe(
      "401 TOKEN_EXPIRED",
    );
    expect(refusals).toEqual(["expired", "expired"]);
    clock.set(clock.now().getTime() - 1000);
    expect(await outcome(guard.canActivate(execution("getSession", bearer(token))))).toBe("passed");
  });

  it("takes an expired token as none on auth.signOut only, which ends the session by its refresh token (OBE-033)", async () => {
    const token = await accessToken();
    const clock = new FakeClock(Date.parse(START) + (ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_SECONDS) * 1000);
    const key = harness({ clock });
    const edge = harness({ caller: EDGE, clock });

    expect(await outcome(key.guard.canActivate(execution("signOut", bearer(token))))).toBe("passed");
    expect(await outcome(edge.guard.canActivate(execution("signOut", cookie(token))))).toBe("passed");
    // Neither became the request's customer; the guard recorded the expired token for the handler.
    expect([key.customers, key.actors, edge.customers, edge.actors]).toEqual([[], [], [], []]);
    expect([key.expired.count, edge.expired.count, key.refusals]).toEqual([1, 1, []]);
    // Any other refusal stays one on auth.signOut: a token of another tenant, a forged one.
    const other = await accessToken(TENANT_B);
    const fresh = harness();
    expect(await outcome(fresh.guard.canActivate(execution("signOut", bearer(other))))).toBe(
      "401 UNAUTHENTICATED",
    );
    expect(await outcome(fresh.guard.canActivate(execution("signOut", bearer("garbage"))))).toBe(
      "401 UNAUTHENTICATED",
    );
    expect(fresh.expired.count).toBe(0);
  });

  it("answers 401 UNAUTHENTICATED without a token on a required operation, and lets a guest through an optional one", async () => {
    const { guard, actors, customers } = harness();

    expect(await outcome(guard.canActivate(execution("getSession")))).toBe("401 UNAUTHENTICATED");
    expect(await outcome(guard.canActivate(execution("createFlightSearch")))).toBe("passed");
    expect(await outcome(guard.canActivate(execution("getBooking")))).toBe("passed");
    expect([actors, customers]).toEqual([[], []]);
  });

  it("ignores cookies of a key caller and the Authorization header of the edge (OADR-0006 point 1)", async () => {
    const token = await accessToken();
    const key = harness();
    const edge = harness({ caller: EDGE });

    expect(await outcome(key.guard.canActivate(execution("getSession", cookie(token))))).toBe(
      "401 UNAUTHENTICATED",
    );
    expect(await outcome(edge.guard.canActivate(execution("getSession", bearer(token))))).toBe(
      "401 UNAUTHENTICATED",
    );
    // On an optional operation the ignored credential leaves a guest.
    expect(await outcome(key.guard.canActivate(execution("createFlightSearch", cookie(token))))).toBe(
      "passed",
    );
    expect([...key.actors, ...edge.actors]).toEqual([]);
  });

  it("refuses a malformed or forged token with 401 UNAUTHENTICATED", async () => {
    const { guard, refusals } = harness();
    const token = await accessToken();
    const [header = "", payload = ""] = token.split(".");

    for (const value of ["garbage", `${header}.${payload}.AAAA`]) {
      expect(await outcome(guard.canActivate(execution("getSession", bearer(value))))).toBe(
        "401 UNAUTHENTICATED",
      );
    }
    expect(refusals).toEqual(["malformed", "signature"]);
  });

  it("does not read a token on operations without a customer, nor in console scope, nor for the anonymous caller", async () => {
    const plain = harness();
    const console = harness({ consoleScope: true });
    const anonymous = harness({ caller: { type: "anonymous", id: "anonymous" } });

    expect(await outcome(plain.guard.canActivate(execution("signIn", bearer("garbage"))))).toBe("passed");
    expect(await outcome(plain.guard.canActivate(execution("unbound", bearer("garbage"))))).toBe("passed");
    expect(await outcome(console.guard.canActivate(execution("getSession", bearer("staff-token"))))).toBe(
      "passed",
    );
    expect(await outcome(anonymous.guard.canActivate(execution("getSession")))).toBe("passed");
    expect([...plain.actors, ...console.actors, ...anonymous.actors]).toEqual([]);
  });

  it("fails loudly when it runs before the caller guard", async () => {
    const { guard } = harness({ caller: undefined });

    await expect(guard.canActivate(execution("getSession"))).rejects.toThrow(/CallerGuard must run first/);
  });
});

describe("CustomerContext", () => {
  const principal: CustomerPrincipal = {
    customerId: CUSTOMER,
    sessionId: SESSION,
    accessTokenExpiresAt: new Date(START),
  };

  it("keeps the request's customer, and answers 401 UNAUTHENTICATED to require() for a guest", async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    const customers = new CustomerContext(cls);

    const signedIn = cls.run(() => {
      customers.set(principal);
      return customers.require();
    });
    const guest = await cls.run(async () => [
      customers.get(),
      await outcome(Promise.resolve().then(() => customers.require() && true)),
    ]);

    expect(signedIn).toEqual(principal);
    expect(guest).toEqual([undefined, "401 UNAUTHENTICATED"]);
    expect(customers.get()).toBeUndefined();
    expect(() => customers.set(principal)).toThrow(/outside a request context/);
  });

  it("remembers, for the request only, that an expired token was taken as none", () => {
    const cls = new ClsService(new AsyncLocalStorage());
    const customers = new CustomerContext(cls);

    const marked = cls.run(() => {
      const before = customers.presentedExpiredToken();
      customers.markExpiredToken();
      return [before, customers.presentedExpiredToken(), customers.get()];
    });
    const other = cls.run(() => customers.presentedExpiredToken());

    expect(marked).toEqual([false, true, undefined]);
    expect([other, customers.presentedExpiredToken()]).toEqual([false, false]);
    expect(() => customers.markExpiredToken()).toThrow(/outside a request context/);
  });
});
