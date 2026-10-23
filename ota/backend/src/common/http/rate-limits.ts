// The rate limits of the OTA API (OBE-013; ota/docs/architecture.md §8, §3 step 10 and §10): `@nestjs/throttler` with
// its counters in Redis (common/redis/throttler-storage.ts), one named throttler per limit of the architecture's
// table, and `429 RATE_LIMITED` with `Retry-After` (seconds until the window ends).
//
// Which limits a request counts against follows from its operation (`@OpenApiOperation`): OPERATION_RATE_LIMITS
// names the operations of each row, and every `x-scope: console` operation of the operations index also counts
// against `console`. Handlers that bind no operation (health) and the 501 routes of pending operations count against
// nothing. A limit counts only the callers its row is about (`callers`): the shopping limit counts the edge and
// publishable keys, whose calls come from browsers, not the secret keys of storefront servers; the customer
// operations' limits never meet the anonymous caller, which only public and webhook routes have. Each limit counts
// per tracker:
//
// - `ip`: the end user's IP (architecture §8). Caddy's client address (`req.ip`, `trust proxy loopback`) for the edge,
//   publishable keys and public routes; for a secret key the valid `X-Velexis-End-User-IP` its server forwards (the
//   contract's CustomerEndUserIp), else the connection's address, so one storefront server does not put every visitor
//   in one bucket; for the OTA admin's service caller the staff member's `X-Velexis-End-User-IP`, which the caller guard
//   requires and checks (OBE-060, OADR-0011 point 9), so the console sign-ins of every OTA, which all arrive from the
//   admin server, never share one bucket. An IPv6 address counts for its /64, as @nestjs/throttler's own tracker does:
//   one IPv6 user holds a whole /64;
// - `email`: the request body's `email`, trimmed and lower-cased (a body without one is not counted by that limit);
// - `tenant`: the resolved tenant (tenant guard);
// - `principal`: the staff session (`asn_…`) of a request with a signed-in staff member (the staff guard, OBE-059),
//   whatever its key; else the API key (`key_…`) of a key-only call (OBE-060, OADR-0011 point 9: 600 per minute per
//   staff session or key). A service request without a staff member (console.auth.signIn, refresh, a sign-out by
//   refresh token) has none and is not counted by it;
// - `reference`: the tenant and the body's `bookingReference` (the lookup failures, counted by OBE-047).
//
// Trackers are SHA-256 digests in the Redis keys (`rl:<throttler>:<digest>`), so no IP or e-mail address is stored in
// clear. Throttler names start with `ota_`: the platform API counts its own `rl:sign_in:…` on the same Redis server,
// and a portal sign-in must not use up a storefront's. A window is fixed: it starts with the first hit and lasts the
// limit's period.
//
// Two rows are not request counters and are counted where the outcome is known: the `bookings.lookup` failures
// (`counts: "failures"`, OBE-047, with RedisThrottlerStorage and `trackerDigest`), and the customer sign-in lockout and
// the airline card's three attempts per checkout, which have keys of their own (`authfail`, `acChk` of redis.keys.ts;
// OBE-033, OBE-051). The public downloads limit counts the signed document downloads (`downloadFile`, OBE-054), and
// gets the public images when `getPublicAsset` is served (OBE-071).
//
// The guard runs after the caller, tenant, scope and CSRF guards (architecture §3 steps 4–9, app.module.ts), and, as a
// guard, before validation: invalid requests count too. Each `429 RATE_LIMITED` is one `rate_limit.exceeded` line with
// the operation, the limit, the caller's type and the staff member or key when the request has them (`stf_…`,
// `key_…`), never an address, a tracker or a request value; a refused console call writes no `staff_actions` row
// (OADR-0011 point 8 as decided on 2026-10-21), so a client asking again and again cannot fill the audit table. While
// Redis is down every rate-limited route refuses with `503 SERVICE_UNAVAILABLE` (architecture §10; logged as
// `throttler.store_unavailable`); a limit that cannot be counted is never skipped.
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Injectable, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  DEFAULT_IPV6_SUBNET_PREFIX,
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  normalizeIp,
  ThrottlerGuard,
  ThrottlerModule,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { AppError, isAppError } from "@velexis/errors";
import type { Request } from "express";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { ClsService } from "nestjs-cls";
import { CallerContext, type Caller } from "../../tenancy/caller-resolver";
import { TenancyModule } from "../../tenancy/tenancy.module";
import { TenantContext } from "../../tenancy/tenant-context";
import { StaffContext } from "../auth/staff.guard";
import { REDIS_CLIENT } from "../redis/redis.module";
import { RateLimitStoreUnavailableError, RedisThrottlerStorage } from "../redis/throttler-storage";
import { OPENAPI_OPERATION } from "./openapi-operation.decorator";

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** What a limit counts per; see the file header. */
export type RateLimitTracker = "ip" | "email" | "tenant" | "principal" | "reference";

/** The callers a limit can count: the caller guard's types, with keys told apart by kind. */
export type RateLimitedCaller = "edge" | "service" | "publishable" | "secret" | "anonymous";

/** One limit of the table of architecture §8. */
export interface RateLimit {
  /** The throttler name: `rl:<name>:<tracker digest>` in Redis. */
  readonly name: string;
  /** Requests (or failures) allowed per window; the next one answers 429. */
  readonly limit: number;
  readonly windowSeconds: number;
  readonly by: RateLimitTracker;
  /** The callers the limit counts; others pass it uncounted. */
  readonly callers: readonly RateLimitedCaller[];
  /** `requests`: counted by the guard before the handler; `failures`: counted by the handler on a failure. */
  readonly counts: "requests" | "failures";
  /** The row of architecture §8 the limit implements. */
  readonly row: string;
}

/** The callers of customer operations: the edge and both kinds of keys. */
const CUSTOMER_CALLERS = Object.freeze(["edge", "publishable", "secret"] as const);

/** The limits of architecture §8, one named throttler each. */
export const RATE_LIMITS = Object.freeze({
  signIn: {
    name: "ota_sign_in",
    limit: 10,
    windowSeconds: MINUTE,
    by: "ip",
    // The service caller reaches console.auth.signIn only (the scope guard refuses it auth.signIn).
    callers: Object.freeze([...CUSTOMER_CALLERS, "service"] as const),
    counts: "requests",
    row: "auth.signIn, console.auth.signIn",
  },
  accountMailPerIp: {
    name: "ota_account_mail_ip",
    limit: 5,
    windowSeconds: HOUR,
    by: "ip",
    callers: CUSTOMER_CALLERS,
    counts: "requests",
    row: "auth.signUp, auth.requestPasswordReset, auth.resendVerification",
  },
  accountMailPerEmail: {
    name: "ota_account_mail_email",
    limit: 3,
    windowSeconds: HOUR,
    by: "email",
    callers: CUSTOMER_CALLERS,
    counts: "requests",
    row: "auth.signUp, auth.requestPasswordReset, auth.resendVerification",
  },
  shopping: {
    name: "ota_shopping",
    limit: 30,
    windowSeconds: MINUTE,
    by: "ip",
    callers: Object.freeze(["edge", "publishable"] as const),
    counts: "requests",
    row: "flights.search, flights.upsell, flights.price",
  },
  lookupFailuresPerIp: {
    name: "ota_lookup_ip",
    limit: 5,
    windowSeconds: 15 * MINUTE,
    by: "ip",
    callers: CUSTOMER_CALLERS,
    counts: "failures",
    row: "bookings.lookup",
  },
  lookupFailuresPerReference: {
    name: "ota_lookup_reference",
    limit: 5,
    windowSeconds: 15 * MINUTE,
    by: "reference",
    callers: CUSTOMER_CALLERS,
    counts: "failures",
    row: "bookings.lookup",
  },
  checkoutPayment: {
    name: "ota_checkout_payment",
    limit: 10,
    windowSeconds: MINUTE,
    by: "ip",
    callers: CUSTOMER_CALLERS,
    counts: "requests",
    row: "checkout.createPayment, checkout.complete",
  },
  airlineCardPerIp: {
    name: "ota_airline_card_ip",
    limit: 5,
    windowSeconds: MINUTE,
    by: "ip",
    callers: Object.freeze(["edge"] as const),
    counts: "requests",
    row: "checkout.completeWithAirlineCard",
  },
  airlineCardPerTenant: {
    name: "ota_airline_card_tenant",
    limit: 60,
    windowSeconds: HOUR,
    by: "tenant",
    callers: Object.freeze(["edge"] as const),
    counts: "requests",
    row: "checkout.completeWithAirlineCard",
  },
  console: {
    name: "ota_console",
    limit: 600,
    windowSeconds: MINUTE,
    by: "principal",
    callers: Object.freeze(["secret", "service"] as const),
    counts: "requests",
    row: "Console operations",
  },
  publicDownloads: {
    name: "ota_downloads",
    limit: 120,
    windowSeconds: MINUTE,
    by: "ip",
    callers: Object.freeze(["anonymous", "edge", "publishable", "secret"] as const),
    counts: "requests",
    row: "/v1/assets/*, /v1/files/*",
  },
} as const satisfies Record<string, RateLimit>);

/** A limit of RATE_LIMITS, by its key. */
export type RateLimitId = keyof typeof RATE_LIMITS;

/** The request limits of the operations of architecture §8's rows; console operations get `console` on top. */
export const OPERATION_RATE_LIMITS: Readonly<Partial<Record<OtaOperationId, readonly RateLimitId[]>>> =
  Object.freeze({
    signIn: ["signIn"],
    consoleSignIn: ["signIn"],
    signUp: ["accountMailPerIp", "accountMailPerEmail"],
    requestPasswordReset: ["accountMailPerIp", "accountMailPerEmail"],
    resendEmailVerification: ["accountMailPerIp", "accountMailPerEmail"],
    createFlightSearch: ["shopping"],
    upsellFlightOffer: ["shopping"],
    priceFlightOffers: ["shopping"],
    createCheckoutPayment: ["checkoutPayment"],
    completeCheckout: ["checkoutPayment"],
    completeCheckoutWithAirlineCard: ["airlineCardPerIp", "airlineCardPerTenant"],
    downloadFile: ["publicDownloads"],
  });

const CONSOLE_OPERATIONS: ReadonlySet<string> = new Set(
  otaOperations
    .filter((operation) => operation.scope === "console")
    .map((operation) => operation.operationId),
);

/** The request limits of an operation: its row's, plus `console` for a console operation. */
export function rateLimitsOf(operationId: OtaOperationId): readonly RateLimitId[] {
  const own = OPERATION_RATE_LIMITS[operationId] ?? [];
  return CONSOLE_OPERATIONS.has(operationId) ? [...own, "console"] : own;
}

/** The caller as the limits tell callers apart. */
export function rateLimitedCaller(caller: Caller): RateLimitedCaller {
  return caller.type === "key" ? caller.kind : caller.type;
}

/** `X-Velexis-End-User-IP`, lower case as Node gives header names. */
export const END_USER_IP_HEADER = "x-velexis-end-user-ip";

/** What the IP helpers read from an Express request. */
export interface AddressedRequest {
  /** Express' client address: the right-most `X-Forwarded-For` entry from Caddy (`trust proxy loopback`). */
  readonly ip?: string | undefined;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** The address the request came from: Caddy's client address, else the socket peer. */
export function connectionIp(request: AddressedRequest): string {
  return request.ip ?? request.socket?.remoteAddress ?? "unknown";
}

/**
 * The end user's IP of a request (architecture §8): a secret key's valid `X-Velexis-End-User-IP` (the contract
 * ignores an invalid one), the OTA admin's (the service caller's, which the caller guard requires valid), else the
 * connection's address. Other callers' headers are ignored.
 */
export function endUserIp(request: AddressedRequest, caller: Caller): string {
  if (caller.type === "service" || (caller.type === "key" && caller.kind === "secret")) {
    const value = request.headers[END_USER_IP_HEADER];
    const forwarded = typeof value === "string" ? value.trim() : "";
    if (isIP(forwarded) !== 0) {
      return forwarded;
    }
  }
  return connectionIp(request);
}

/** What the trackers read from a request. */
export interface TrackerSources {
  readonly caller: Caller;
  /** The tenant the tenant guard resolved, when there is one. */
  readonly tenantId: string | undefined;
  /** The staff session (`asn_…`) of the signed-in staff member the staff guard found, when there is one. */
  readonly staffSessionId?: string | undefined;
  /** `endUserIp` of the request. */
  readonly ip: string;
  /** The parsed request body. */
  readonly body: unknown;
}

/** A string property of a JSON body, trimmed; `undefined` when absent, empty or not a string. */
function bodyText(body: unknown, property: string): string | undefined {
  const value =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)[property]
      : undefined;
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? undefined : text;
}

/** The tracker value of `by`, or `undefined` when the request has none (see the file header). */
export function trackerValue(by: RateLimitTracker, sources: TrackerSources): string | undefined {
  switch (by) {
    case "ip":
      return normalizeIp(sources.ip, DEFAULT_IPV6_SUBNET_PREFIX);
    case "email":
      return bodyText(sources.body, "email")?.toLowerCase();
    case "tenant":
      return sources.tenantId;
    case "principal":
      if (sources.staffSessionId !== undefined) {
        return `staff:${sources.staffSessionId}`;
      }
      return sources.caller.type === "key" ? sources.caller.keyId : undefined;
    case "reference": {
      const reference = bodyText(sources.body, "bookingReference")?.toUpperCase();
      return sources.tenantId === undefined || reference === undefined
        ? undefined
        : `${sources.tenantId}:${reference}`;
    }
  }
}

/** The digest that stands for a tracker value in the Redis key. */
export function trackerDigest(by: RateLimitTracker, value: string): string {
  return createHash("sha256").update(`${by}:${value}`, "utf8").digest("hex");
}

/** What the throttlers read from the request context. */
export interface RateLimitSources {
  readonly reflector: Reflector;
  readonly callers: Pick<CallerContext, "get">;
  readonly tenants: Pick<TenantContext, "get">;
  /** The signed-in staff member (OBE-060); without it no request counts per staff session. */
  readonly staff?: Pick<StaffContext, "get"> | undefined;
}

/** The tracker digest of limit `id` for the request in `execution`, or `undefined` when the limit does not count it. */
function trackerOf(
  id: RateLimitId,
  execution: ExecutionContext,
  sources: RateLimitSources,
): string | undefined {
  if (execution.getType() !== "http") {
    return undefined;
  }
  const operationId = sources.reflector.get<OtaOperationId | undefined>(
    OPENAPI_OPERATION,
    execution.getHandler(),
  );
  if (operationId === undefined || !rateLimitsOf(operationId).includes(id)) {
    return undefined;
  }
  const caller = sources.callers.get();
  if (caller === undefined) {
    throw new Error("rate limits: no caller in the request context; CallerGuard must run first");
  }
  const limit: RateLimit = RATE_LIMITS[id];
  if (!limit.callers.includes(rateLimitedCaller(caller))) {
    return undefined;
  }
  const req = execution.switchToHttp().getRequest<Request>();
  const value = trackerValue(limit.by, {
    caller,
    tenantId: sources.tenants.get()?.tenantId,
    staffSessionId: sources.staff?.get()?.family.id,
    ip: endUserIp(req, caller),
    body: req.body,
  });
  return value === undefined ? undefined : trackerDigest(limit.by, value);
}

/** The throttler options of the API: the request limits of RATE_LIMITS as named throttlers, counted in `storage`. */
export function rateLimitOptions(
  sources: RateLimitSources,
  storage: ThrottlerStorage,
): ThrottlerModuleOptions {
  const ids = (Object.keys(RATE_LIMITS) as RateLimitId[]).filter(
    (id) => RATE_LIMITS[id].counts === "requests",
  );
  const throttlers = ids.map((id): ThrottlerOptions => ({
    name: RATE_LIMITS[id].name,
    limit: RATE_LIMITS[id].limit,
    ttl: RATE_LIMITS[id].windowSeconds * 1000,
    skipIf: (execution) => trackerOf(id, execution, sources) === undefined,
    getTracker: (_req, execution) => {
      const tracker = trackerOf(id, execution, sources);
      if (tracker === undefined) {
        throw new Error(`rate limits: ${id} has no tracker for this request`);
      }
      return tracker;
    },
  }));
  return {
    throttlers,
    storage,
    // One bucket per limit and tracker across all the limit's routes (search, upsell and price share one).
    generateKey: (_execution, tracker) => tracker,
    // No X-RateLimit-* headers; the guard answers `Retry-After` with the 429.
    setHeaders: false,
  };
}

/** `ThrottlerModule` with the options above, on the process's Redis client. app.module.ts imports it. */
export function rateLimitModule(): ReturnType<typeof ThrottlerModule.forRootAsync> {
  return ThrottlerModule.forRootAsync({
    imports: [TenancyModule.forApi()],
    inject: [Reflector, CallerContext, TenantContext, ClsService, REDIS_CLIENT],
    useFactory: (
      reflector: Reflector,
      callers: CallerContext,
      tenants: TenantContext,
      cls: ClsService,
      client: Redis,
    ) =>
      rateLimitOptions(
        // StaffContext is a typed view of the request context (nestjs-cls, global), as the staff guard's.
        { reflector, callers, tenants, staff: new StaffContext(cls) },
        new RedisThrottlerStorage(client),
      ),
  });
}

/** The parts of an Express response the guard writes. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

const LIMITS_BY_NAME: ReadonlyMap<string, RateLimit> = new Map(
  Object.values(RATE_LIMITS).map((limit: RateLimit) => [limit.name, limit]),
);

/**
 * The fields of the `rate_limit.exceeded` line of a `429 RATE_LIMITED` (OADR-0011 point 8 as decided on 2026-10-21:
 * a refused console call of a known staff member or key writes no `staff_actions` row, only this line): the operation,
 * the limit (its throttler name, requests and window), the caller's type, and the staff member (`stf_…`) and the key
 * (`key_…`) when the request has them. Never an IP address, an e-mail address, a tracker, a token or a request value.
 */
export interface RateLimitRefusal {
  readonly operationId: string | null;
  readonly limit: string;
  readonly maxRequests: number | null;
  readonly windowSeconds: number | null;
  readonly callerType: Caller["type"] | null;
  readonly staffId?: string;
  readonly keyId?: string;
}

/** The `rate_limit.exceeded` fields of a request refused by throttler `throttler` (see `RateLimitRefusal`). */
export function rateLimitRefusal(
  operationId: string | undefined,
  throttler: string,
  caller: Caller | undefined,
  staffId: string | undefined,
): RateLimitRefusal {
  const limit = LIMITS_BY_NAME.get(throttler);
  return {
    operationId: operationId ?? null,
    limit: throttler,
    maxRequests: limit?.limit ?? null,
    windowSeconds: limit?.windowSeconds ?? null,
    callerType: caller?.type ?? null,
    ...(staffId === undefined ? {} : { staffId }),
    ...(caller?.type === "key" ? { keyId: caller.keyId } : {}),
  };
}

/**
 * The global guard of the request limits (architecture §3 step 10). A request over a limit answers
 * `429 RATE_LIMITED` with `Retry-After` and logs `rate_limit.exceeded` (`rateLimitRefusal`); a limit that Redis cannot
 * count answers `503 SERVICE_UNAVAILABLE`.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly callers: CallerContext,
    private readonly staff: StaffContext,
    @InjectPinoLogger(RateLimitGuard.name) private readonly pino: PinoLogger,
  ) {
    super(options, storageService, reflector);
  }

  /** Counts one limit; a refusal is logged, and a Redis failure refuses the request (architecture §10). */
  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (error) {
      if (isAppError(error) && error.code === "RATE_LIMITED") {
        const operationId =
          requestProps.context.getType() === "http"
            ? this.reflector.get<string | undefined>(OPENAPI_OPERATION, requestProps.context.getHandler())
            : undefined;
        this.pino.info(
          rateLimitRefusal(
            operationId,
            requestProps.throttler.name ?? "default",
            this.callers.get(),
            this.staff.get()?.family.staffId,
          ),
          "rate_limit.exceeded",
        );
        throw error;
      }
      if (!(error instanceof RateLimitStoreUnavailableError)) {
        throw error;
      }
      this.pino.warn({ err: error, throttler: requestProps.throttler.name }, "throttler.store_unavailable");
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }

  /** `429 RATE_LIMITED` with `Retry-After`: the seconds until the tracker's window ends. */
  protected override throwThrottlingException(
    execution: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const res = execution.switchToHttp().getResponse<HeaderTarget>();
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(detail.timeToBlockExpire))));
    return Promise.reject(new AppError("RATE_LIMITED"));
  }
}
