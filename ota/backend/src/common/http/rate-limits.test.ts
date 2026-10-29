// The rate-limit table and its trackers (OBE-013; architecture §8): the limits as the architecture lists them, which
// operations and callers each one counts, the end user's IP, and the trackers' digests; the guard's
// `rate_limit.exceeded` line of a 429 over a storage that refuses (FIX-W25-AUDIT, OADR-0011 point 8 as decided on
// 2026-10-21). The guard against Redis, with 429 and 503: test/integration/common/guards.int.test.ts.
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ThrottlerOptions, ThrottlerStorage } from "@nestjs/throttler";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it } from "vitest";
import type { StaffContext, StaffPrincipal } from "../auth/staff.guard";
import type { Caller, CallerContext } from "../../tenancy/caller-resolver";
import { newId } from "../ids";
import { redisKeys } from "../redis/redis.keys";
import { OPENAPI_OPERATION } from "./openapi-operation.decorator";
import {
  endUserIp,
  OPERATION_RATE_LIMITS,
  RATE_LIMITS,
  RateLimitGuard,
  rateLimitOptions,
  rateLimitRefusal,
  rateLimitsOf,
  trackerDigest,
  trackerValue,
  type RateLimitId,
  type TrackerSources,
} from "./rate-limits";

const TENANT_ID = newId("ten");
const EDGE: Caller = { type: "edge", id: "edge", host: "demo.ota.example.com" };

function key(kind: "publishable" | "secret"): Caller & { type: "key" } {
  const keyId = newId("key");
  return { type: "key", id: keyId, keyId, kind, tenantId: TENANT_ID, environment: "test", scopes: [] };
}

const PUBLISHABLE = key("publishable");
const SECRET = key("secret");
const ANONYMOUS: Caller = { type: "anonymous", id: "anonymous" };

describe("RATE_LIMITS", () => {
  it("holds the limits of architecture §8 [OBE-013]", () => {
    const table = Object.fromEntries(
      Object.entries(RATE_LIMITS).map(([id, limit]) => [
        id,
        [limit.limit, limit.windowSeconds, limit.by, limit.counts],
      ]),
    );

    expect(table).toEqual({
      signIn: [10, 60, "ip", "requests"],
      accountMailPerIp: [5, 3600, "ip", "requests"],
      accountMailPerEmail: [3, 3600, "email", "requests"],
      shopping: [30, 60, "ip", "requests"],
      lookupFailuresPerIp: [5, 900, "ip", "failures"],
      lookupFailuresPerReference: [5, 900, "reference", "failures"],
      checkoutPayment: [10, 60, "ip", "requests"],
      airlineCardPerIp: [5, 60, "ip", "requests"],
      airlineCardPerTenant: [60, 3600, "tenant", "requests"],
      console: [600, 60, "principal", "requests"],
      publicDownloads: [120, 60, "ip", "requests"],
    });
    expect(RATE_LIMITS.shopping.callers).toEqual(["edge", "publishable"]);
  });

  it("names each throttler once, with the ota_ prefix, as a valid rl:<throttler> key part", () => {
    const names = Object.values(RATE_LIMITS).map((limit) => limit.name);

    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^ota_/);
      expect(redisKeys.throttle(name, trackerDigest("ip", "203.0.113.7"), 60).key).toMatch(/^rl:ota_/);
    }
  });
});

describe("the operations of each limit", () => {
  it("are operations of the document, mapped to request limits only", () => {
    const known = new Set(otaOperations.map((operation) => operation.operationId));
    for (const [operationId, ids] of Object.entries(OPERATION_RATE_LIMITS)) {
      expect([operationId, known.has(operationId as OtaOperationId)]).toEqual([operationId, true]);
      for (const id of ids ?? []) {
        expect([operationId, id, RATE_LIMITS[id].counts]).toEqual([operationId, id, "requests"]);
      }
    }
  });

  it("follow the rows: searches, upsells and prices share one limit; console operations count per principal", () => {
    expect(rateLimitsOf("createFlightSearch")).toEqual(["shopping"]);
    expect(rateLimitsOf("upsellFlightOffer")).toEqual(["shopping"]);
    expect(rateLimitsOf("priceFlightOffers")).toEqual(["shopping"]);
    expect(rateLimitsOf("signUp")).toEqual(["accountMailPerIp", "accountMailPerEmail"]);
    expect(rateLimitsOf("completeCheckoutWithAirlineCard")).toEqual([
      "airlineCardPerIp",
      "airlineCardPerTenant",
    ]);
    expect(rateLimitsOf("consoleSignIn")).toEqual(["signIn", "console"]);
    expect(rateLimitsOf("consoleListBookings")).toEqual(["console"]);
    expect(rateLimitsOf("getBooking")).toEqual([]);
    expect(rateLimitsOf("getFlightSearch")).toEqual([]);
  });

  it("leave only the failure counters without an operation", () => {
    const used = new Set(otaOperations.flatMap((operation) => rateLimitsOf(operation.operationId)));
    const unused = (Object.keys(RATE_LIMITS) as RateLimitId[]).filter((id) => !used.has(id));

    expect(unused.sort()).toEqual(["lookupFailuresPerIp", "lookupFailuresPerReference"]);
  });

  it("count the signed document downloads against the public downloads limit [OBE-054]", () => {
    expect(rateLimitsOf("downloadFile")).toEqual(["publicDownloads"]);
  });

  it("count the public images against the same public downloads limit, 120 per minute per IP [OBE-071]", () => {
    expect(rateLimitsOf("getPublicAsset")).toEqual(["publicDownloads"]);
    expect(RATE_LIMITS.publicDownloads).toMatchObject({ limit: 120, windowSeconds: 60, by: "ip" });
    expect(RATE_LIMITS.publicDownloads.callers).toEqual(["anonymous", "edge", "publishable", "secret"]);
  });
});

describe("endUserIp", () => {
  const request = (headers: Record<string, string> = {}) => ({
    ip: "198.51.100.23",
    socket: { remoteAddress: "127.0.0.1" },
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
  });

  it("is the forwarded X-Velexis-End-User-IP of a secret key, IPv4 or IPv6", () => {
    expect(endUserIp(request({ "X-Velexis-End-User-IP": "203.0.113.7" }), SECRET)).toBe("203.0.113.7");
    expect(endUserIp(request({ "X-Velexis-End-User-IP": " 2001:db8::42 " }), SECRET)).toBe("2001:db8::42");
  });

  it("is the OTA admin's forwarded X-Velexis-End-User-IP for the service caller [OBE-060]", () => {
    const service: Caller = { type: "service", id: "service" };

    expect(endUserIp(request({ "X-Velexis-End-User-IP": "203.0.113.9" }), service)).toBe("203.0.113.9");
    expect(endUserIp(request({ "X-Velexis-End-User-IP": "2001:db8::9" }), service)).toBe("2001:db8::9");
  });

  it("is the connection's address for an invalid header, and for every other caller whatever it sends", () => {
    for (const value of ["", "not-an-ip", "203.0.113.7, 198.51.100.1", "203.0.113.300"]) {
      expect(endUserIp(request({ "X-Velexis-End-User-IP": value }), SECRET)).toBe("198.51.100.23");
    }
    for (const caller of [EDGE, PUBLISHABLE, ANONYMOUS]) {
      expect(endUserIp(request({ "X-Velexis-End-User-IP": "203.0.113.7" }), caller)).toBe("198.51.100.23");
    }
    expect(endUserIp({ socket: { remoteAddress: "::1" }, headers: {} }, EDGE)).toBe("::1");
  });
});

describe("trackers", () => {
  const sources = (change: Partial<TrackerSources> = {}): TrackerSources => ({
    caller: EDGE,
    tenantId: TENANT_ID,
    ip: "203.0.113.7",
    body: undefined,
    ...change,
  });

  it("count an IPv6 address for its /64 and an IPv4-mapped address as IPv4", () => {
    expect(trackerValue("ip", sources())).toBe("203.0.113.7");
    expect(trackerValue("ip", sources({ ip: "2001:db8:0:7::1" }))).toBe(
      trackerValue("ip", sources({ ip: "2001:db8:0:7::ff" })),
    );
    expect(trackerValue("ip", sources({ ip: "2001:db8:0:7::1" }))).not.toBe(
      trackerValue("ip", sources({ ip: "2001:db8:0:8::1" })),
    );
    expect(trackerValue("ip", sources({ ip: "::ffff:203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("read the e-mail trimmed and in lower case, and the booking reference of the tenant", () => {
    expect(trackerValue("email", sources({ body: { email: "  Anna.Berg@Example.com " } }))).toBe(
      "anna.berg@example.com",
    );
    for (const body of [undefined, null, [], {}, { email: "" }, { email: 42 }]) {
      expect(trackerValue("email", sources({ body }))).toBeUndefined();
    }
    expect(trackerValue("reference", sources({ body: { bookingReference: "vx7k2m" } }))).toBe(
      `${TENANT_ID}:VX7K2M`,
    );
    expect(
      trackerValue("reference", sources({ body: { bookingReference: "VX7K2M" }, tenantId: undefined })),
    ).toBeUndefined();
  });

  it("count a signed-in staff member's session as the principal, whatever the key or service [OBE-060]", () => {
    const service: Caller = { type: "service", id: "service" };
    const session = "asn_01JA2Z9W5K7Q3M8N4P6R2T0V1F";

    expect(trackerValue("principal", sources({ caller: SECRET, staffSessionId: session }))).toBe(
      `staff:${session}`,
    );
    expect(trackerValue("principal", sources({ caller: service, staffSessionId: session }))).toBe(
      `staff:${session}`,
    );
    // The service caller without a staff member (sign-in, refresh) counts against no console principal.
    expect(trackerValue("principal", sources({ caller: service }))).toBeUndefined();
    expect(RATE_LIMITS.console.callers).toEqual(["secret", "service"]);
    expect(RATE_LIMITS.signIn.callers).toContain("service");
  });

  it("count a key as its principal, and the tenant of the request", () => {
    expect(trackerValue("principal", sources({ caller: SECRET }))).toBe(SECRET.keyId);
    expect(trackerValue("principal", sources())).toBeUndefined();
    expect(trackerValue("tenant", sources())).toBe(TENANT_ID);
  });

  it("are digests that hold no IP or e-mail address", () => {
    const digest = trackerDigest("ip", "203.0.113.7");

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(trackerDigest("email", "203.0.113.7"));
  });
});

describe("rateLimitOptions", () => {
  class Handlers {
    search(): void {}
    unbound(): void {}
  }
  Reflect.defineMetadata(OPENAPI_OPERATION, "createFlightSearch", Handlers.prototype.search);

  const storage = {} as ThrottlerStorage;

  function throttlers(caller: Caller): ThrottlerOptions[] {
    const options = rateLimitOptions(
      {
        reflector: new Reflector(),
        callers: { get: () => caller },
        tenants: { get: () => undefined },
      },
      storage,
    );
    return Array.isArray(options) ? options : options.throttlers;
  }

  function execution(handler: () => void): ExecutionContext {
    const req = { ip: "203.0.113.7", socket: {}, headers: {}, body: {} };
    return {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => Handlers,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
  }

  it("has one throttler per request limit, and none for the failure counters", () => {
    expect(throttlers(EDGE).map((throttler) => throttler.name)).toEqual(
      Object.values(RATE_LIMITS)
        .filter((limit) => limit.counts === "requests")
        .map((limit) => limit.name),
    );
  });

  it("counts a search of the edge and a pk_ key by IP, and skips a secret key and unbound routes", async () => {
    for (const caller of [EDGE, PUBLISHABLE]) {
      const shopping = throttlers(caller).find((throttler) => throttler.name === "ota_shopping");
      expect(shopping?.skipIf?.(execution(Handlers.prototype.search))).toBe(false);
      expect(await shopping?.getTracker?.({}, execution(Handlers.prototype.search))).toBe(
        trackerDigest("ip", "203.0.113.7"),
      );
      expect(shopping?.skipIf?.(execution(Handlers.prototype.unbound))).toBe(true);
    }
    const secret = throttlers(SECRET).find((throttler) => throttler.name === "ota_shopping");
    expect(secret?.skipIf?.(execution(Handlers.prototype.search))).toBe(true);
    const signIn = throttlers(EDGE).find((throttler) => throttler.name === "ota_sign_in");
    expect(signIn?.skipIf?.(execution(Handlers.prototype.search))).toBe(true);
  });
});

describe("the rate_limit.exceeded line", () => {
  class Handlers {
    list(): void {}
    signIn(): void {}
  }
  Reflect.defineMetadata(OPENAPI_OPERATION, "consoleListBookings", Handlers.prototype.list);
  Reflect.defineMetadata(OPENAPI_OPERATION, "consoleSignIn", Handlers.prototype.signIn);

  const STAFF_ID = "stf_01JA2Z9W5K7Q3M8N4P6R2T0V1D";
  const SESSION_ID = "asn_01JA2Z9W5K7Q3M8N4P6R2T0V1F";
  const END_USER_IP = "203.0.113.77";

  /** The guard over a storage that refuses every request, with the request's caller and staff member. */
  async function refusingGuard(caller: Caller, staff: boolean) {
    const lines: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const record = (fields: Record<string, unknown>, msg: string) => lines.push({ fields, msg });
    const principal = { family: { id: SESSION_ID, staffId: STAFF_ID } } as unknown as StaffPrincipal;
    const storage = {
      increment: () =>
        Promise.resolve({ totalHits: 601, timeToExpire: 30, isBlocked: true, timeToBlockExpire: 30 }),
    } as unknown as ThrottlerStorage;
    const callers = { get: () => caller } as unknown as CallerContext;
    const staffContext = { get: () => (staff ? principal : undefined) } as unknown as StaffContext;
    const reflector = new Reflector();
    const guard = new RateLimitGuard(
      rateLimitOptions(
        { reflector, callers, tenants: { get: () => undefined }, staff: staffContext },
        storage,
      ),
      storage,
      reflector,
      callers,
      staffContext,
      { info: record, warn: record } as unknown as PinoLogger,
    );
    await guard.onModuleInit();
    return { guard, lines };
  }

  function execution(handler: () => void): ExecutionContext {
    const req = {
      ip: END_USER_IP,
      socket: {},
      headers: { "x-velexis-end-user-ip": END_USER_IP, authorization: "Bearer not-logged" },
      body: { email: "anna.berg@example.com" },
    };
    const res = { setHeader: () => undefined };
    return {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => Handlers,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
  }

  it("names the staff member, the key, the operation and the limit, and nothing else [FIX-W25-AUDIT AC2]", async () => {
    const withStaff = await refusingGuard(SECRET, true);
    const keyOnly = await refusingGuard(SECRET, false);
    const service = await refusingGuard({ type: "service", id: "service" }, false);

    for (const { guard } of [withStaff, keyOnly]) {
      await expect(guard.canActivate(execution(Handlers.prototype.list))).rejects.toMatchObject({
        code: "RATE_LIMITED",
        status: 429,
      });
    }
    await expect(service.guard.canActivate(execution(Handlers.prototype.signIn))).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    expect(withStaff.lines).toEqual([
      {
        msg: "rate_limit.exceeded",
        fields: {
          operationId: "consoleListBookings",
          limit: "ota_console",
          maxRequests: 600,
          windowSeconds: 60,
          callerType: "key",
          staffId: STAFF_ID,
          keyId: SECRET.keyId,
        },
      },
    ]);
    expect(keyOnly.lines.map((line) => line.fields)).toEqual([
      expect.not.objectContaining({ staffId: expect.anything() }),
    ]);
    expect(keyOnly.lines[0]?.fields).toMatchObject({ keyId: SECRET.keyId, limit: "ota_console" });
    // The OTA admin's sign-in: counted per end-user IP, which the line never holds.
    expect(service.lines).toEqual([
      {
        msg: "rate_limit.exceeded",
        fields: {
          operationId: "consoleSignIn",
          limit: "ota_sign_in",
          maxRequests: 10,
          windowSeconds: 60,
          callerType: "service",
        },
      },
    ]);
    const text = JSON.stringify([...withStaff.lines, ...keyOnly.lines, ...service.lines]);
    for (const value of [END_USER_IP, "anna.berg@example.com", "not-logged", SESSION_ID]) {
      expect(text).not.toContain(value);
    }
  });

  it("describes a limit it does not know by its name alone", () => {
    expect(rateLimitRefusal(undefined, "other", undefined, undefined)).toEqual({
      operationId: null,
      limit: "other",
      maxRequests: null,
      windowSeconds: null,
      callerType: null,
    });
  });
});
