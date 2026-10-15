// The rate limits of the platform API (PBE-009; platform/docs/api-inventory.md §2 "Rate limits", architecture §3 step
// 4, PADR-0019): `@nestjs/throttler` with its counters in Redis, so the limits hold across processes and restarts,
// one named throttler per limit of the inventory's table, and `429 RATE_LIMITED` with `Retry-After` (seconds).
//
// Which limits a route has follows from its operation (`@OpenApiOperation`), as the inventory lists them:
// OPERATION_RATE_LIMITS names the operations of the specific rows, and every other request of an authenticated
// account counts against `authenticated` ("everything else authenticated"). Each limit counts per tracker:
//
// - `ip`: the end user's IP of the request context (PBE-008, PADR-0019): the IP the portal or admin server forwards
//   with the BFF key, else Caddy's client address. Never `req.ip`, which is the portal server for portal calls;
//   one bucket per person, not one for everybody behind the portal. An IPv6 address counts for its /64, as
//   @nestjs/throttler's own tracker does (`normalizeIp`): one IPv6 user holds a whole /64 and could otherwise take a
//   fresh bucket with every address of it;
// - `email`: the `email` of the request body, trimmed and lower-cased;
// - `account`: the authenticated account of the request context (set by the auth guard, PBE-012);
// - `domain`: the `domainId` path parameter.
//
// Trackers are SHA-256 digests in the Redis keys (`rl:<throttler>:<digest>`), so no IP or e-mail address is stored in
// clear. A window is fixed: it starts with the first hit and lasts the limit's period; the hit after the limit answers
// 429 until the window ends, and `Retry-After` says when. A request whose tracker is unknown (a public call to a
// per-account limit, a body without `email`) is not counted by that limit.
//
// Two global guards apply them, because the account is known only after authentication: RateLimitGuard counts the
// `ip`, `email` and `domain` limits before the auth guards (architecture §3 step 4), AccountRateLimitGuard the
// `account` limits right after them. While Redis is down, the limits of the specific rows refuse the request with
// `503 SERVICE_UNAVAILABLE` (architecture §9), and `authenticated` lets it through with a warning
// (`throttler.store_unavailable`), so a Redis outage does not take every signed-in page down.
import { createHash } from "node:crypto";
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
import type { PlatformOperationId } from "@velexis/api-types/operations";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { incrementInWindow, redisKeys, type RedisWriter } from "../redis/redis-keys";
import { REDIS_CLIENT } from "../redis/redis.module";
import { boundOperationId } from "./openapi-operation.decorator";
import { RequestContext } from "./request-context";

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** What a limit counts per. */
export type RateLimitTracker = "ip" | "email" | "account" | "domain";

/** One limit of the rate-limit table of api-inventory §2. */
export interface RateLimit {
  /** The throttler name: `rl:<name>:<tracker>` in Redis. */
  readonly name: string;
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
  readonly by: RateLimitTracker;
  /** The row of api-inventory §2 the limit implements. */
  readonly row: string;
  /** While Redis is down: refuse with `503 SERVICE_UNAVAILABLE`, or let the request through (logged). */
  readonly whenStoreDown: "refuse" | "allow";
}

/** The limits of api-inventory §2, one named throttler each. */
export const RATE_LIMITS = Object.freeze({
  signUp: {
    name: "sign_up",
    limit: 5,
    windowSeconds: HOUR,
    by: "ip",
    row: "Sign-up",
    whenStoreDown: "refuse",
  },
  signIn: {
    name: "sign_in",
    limit: 10,
    windowSeconds: MINUTE,
    by: "ip",
    row: "Sign-in, admin sign-in",
    whenStoreDown: "refuse",
  },
  mfa: {
    name: "mfa",
    limit: 10,
    windowSeconds: 10 * MINUTE,
    by: "account",
    row: "MFA verify, step-up",
    whenStoreDown: "refuse",
  },
  emailLinksPerEmail: {
    name: "email_links_email",
    limit: 3,
    windowSeconds: HOUR,
    by: "email",
    row: "Password reset request, resend verification",
    whenStoreDown: "refuse",
  },
  emailLinksPerIp: {
    name: "email_links_ip",
    limit: 10,
    windowSeconds: HOUR,
    by: "ip",
    row: "Password reset request, resend verification",
    whenStoreDown: "refuse",
  },
  invitationLookup: {
    name: "invitation_lookup",
    limit: 20,
    windowSeconds: HOUR,
    by: "ip",
    row: "Invitation lookup",
    whenStoreDown: "refuse",
  },
  keyAvailability: {
    name: "key_availability",
    limit: 30,
    windowSeconds: MINUTE,
    by: "account",
    row: "Key availability",
    whenStoreDown: "refuse",
  },
  consoleToken: {
    name: "console_token",
    limit: 30,
    windowSeconds: MINUTE,
    by: "account",
    row: "Console token",
    whenStoreDown: "refuse",
  },
  domainCheck: {
    name: "domain_check",
    limit: 1,
    windowSeconds: MINUTE,
    by: "domain",
    row: "Domain check now",
    whenStoreDown: "refuse",
  },
  authenticated: {
    name: "authenticated",
    limit: 300,
    windowSeconds: MINUTE,
    by: "account",
    row: "Everything else authenticated",
    whenStoreDown: "allow",
  },
} as const satisfies Record<string, RateLimit>);

/** A limit of RATE_LIMITS, by its key. */
export type RateLimitId = keyof typeof RATE_LIMITS;

/**
 * The limits of the operations of the specific rows of api-inventory §2. Every other request counts against
 * `authenticated` when it has an authenticated account. The MFA verify steps of the sign-ins (`verifyMfa`,
 * `adminVerifyMfa`) are public: their account is known only from the challenge, so the MFA service counts `mfa` there
 * itself (PBE-015, with `RedisThrottlerStorage` and `trackerDigest("account", …)`); "5 attempts per challenge" and the
 * sign-in lockout live in the challenge and the account, not here.
 * The "Domain check now" operation arrives with the M5 slice of the document, which maps it to `domainCheck`.
 */
export const OPERATION_RATE_LIMITS: Readonly<Partial<Record<PlatformOperationId, readonly RateLimitId[]>>> =
  Object.freeze({
    signUp: ["signUp"],
    signIn: ["signIn"],
    adminSignIn: ["signIn"],
    stepUp: ["mfa"],
    adminStepUp: ["mfa"],
    requestPasswordReset: ["emailLinksPerEmail", "emailLinksPerIp"],
    resendVerification: ["emailLinksPerEmail", "emailLinksPerIp"],
    lookupInvitation: ["invitationLookup"],
    checkTenantKey: ["keyAvailability"],
    createConsoleToken: ["consoleToken"],
  });

/** The limits of a handler: those of its operation, or `authenticated`. */
export function rateLimitsOf(handler: unknown): readonly RateLimitId[] {
  const operationId = boundOperationId(handler) as PlatformOperationId | undefined;
  return (operationId === undefined ? undefined : OPERATION_RATE_LIMITS[operationId]) ?? ["authenticated"];
}

/** The parts of an Express request the trackers read. */
interface TrackedRequest {
  readonly body?: unknown;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** The digest that stands for a tracker value in the Redis key. */
export function trackerDigest(by: RateLimitTracker, value: string): string {
  return createHash("sha256").update(`${by}:${value}`, "utf8").digest("hex");
}

/**
 * The tracker value of `by` for a request, or `undefined` when the request has none (no account yet, no `email`, no
 * `domainId`). An IPv4 address is itself, an IPv6 address its /64 (`2001:db8:0:7::/64`). The IP always exists inside
 * the API's pipeline; its absence is a bug and throws.
 */
export function trackerValue(
  by: RateLimitTracker,
  req: TrackedRequest,
  context: Pick<RequestContext, "ip" | "actor">,
): string | undefined {
  switch (by) {
    case "ip": {
      const ip = context.ip;
      if (ip === undefined) {
        throw new Error(
          "rate limits: the request context has no end-user IP (EndUserMiddleware did not run)",
        );
      }
      return normalizeIp(ip, DEFAULT_IPV6_SUBNET_PREFIX);
    }
    case "account":
      return context.actor?.accountId;
    case "email": {
      const body = req.body;
      const email =
        body !== null && typeof body === "object" ? (body as Record<string, unknown>)["email"] : undefined;
      const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
      return normalized === "" ? undefined : normalized;
    }
    case "domain": {
      const domainId = req.params?.["domainId"];
      return typeof domainId === "string" && domainId !== "" ? domainId : undefined;
    }
  }
}

/** The tracker digest of limit `id` for the request in `execution`, or `undefined` when the limit does not count it. */
function trackerOf(
  id: RateLimitId,
  execution: ExecutionContext,
  context: RequestContext,
): string | undefined {
  if (execution.getType() !== "http" || !rateLimitsOf(execution.getHandler()).includes(id)) {
    return undefined;
  }
  const { by } = RATE_LIMITS[id];
  const value = trackerValue(by, execution.switchToHttp().getRequest<TrackedRequest>(), context);
  return value === undefined ? undefined : trackerDigest(by, value);
}

/** The limit of a throttler name. */
function limitNamed(name: string | undefined): RateLimit {
  const found = Object.values(RATE_LIMITS).find((limit) => limit.name === name);
  if (found === undefined) {
    throw new Error(`rate limits: no limit is named ${String(name)}`);
  }
  return found;
}

/** Redis did not answer while a limit was counted. */
export class RateLimitStoreUnavailableError extends Error {
  override readonly name = "RateLimitStoreUnavailableError";
}

/**
 * The throttler storage on Redis: one fixed-window counter per throttler and tracker (`rl:<throttler>:<digest>`,
 * `incrementInWindow` of redis-keys.ts, so the counter always has the window as its TTL). `blockDuration` is the
 * window: a tracker over the limit waits for the window to end.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly client: RedisWriter) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    const counter = redisKeys.throttle(throttlerName, key, ttl / 1000);
    let window;
    try {
      window = await incrementInWindow(this.client, counter);
    } catch (error) {
      throw new RateLimitStoreUnavailableError("the rate-limit counters in Redis cannot be reached", {
        cause: error,
      });
    }
    const secondsLeft = Math.max(1, Math.ceil(window.expiresInMs / 1000));
    const isBlocked = window.hits > limit;
    return {
      totalHits: window.hits,
      timeToExpire: secondsLeft,
      isBlocked,
      timeToBlockExpire: isBlocked ? secondsLeft : 0,
    };
  }
}

/** The throttler options of the API: RATE_LIMITS as named throttlers, counted in `storage`. */
export function throttlerOptions(context: RequestContext, storage: ThrottlerStorage): ThrottlerModuleOptions {
  const throttlers = (Object.keys(RATE_LIMITS) as RateLimitId[]).map((id): ThrottlerOptions => ({
    name: RATE_LIMITS[id].name,
    limit: RATE_LIMITS[id].limit,
    ttl: RATE_LIMITS[id].windowSeconds * 1000,
    skipIf: (execution) => trackerOf(id, execution, context) === undefined,
    getTracker: (_req, execution) => {
      const tracker = trackerOf(id, execution, context);
      if (tracker === undefined) {
        throw new Error(`rate limits: ${id} has no tracker for this request`);
      }
      return tracker;
    },
  }));
  return {
    throttlers,
    storage,
    // One bucket per limit and tracker across all its routes (sign-in and admin sign-in share one), not per handler.
    generateKey: (_execution, tracker) => tracker,
    // No X-RateLimit-* headers; the guards below answer `Retry-After` with the 429.
    setHeaders: false,
  };
}

/** `ThrottlerModule` with the options above, on the process's Redis client. CommonModule imports it. */
export function throttlerModule(): ReturnType<typeof ThrottlerModule.forRootAsync> {
  return ThrottlerModule.forRootAsync({
    inject: [RequestContext, REDIS_CLIENT],
    useFactory: (context: RequestContext, client: Redis) =>
      throttlerOptions(context, new RedisThrottlerStorage(client)),
  });
}

/** When a guard counts its limits: before the auth guards, or right after them. */
export type RateLimitPhase = "request" | "account";

/** The phase of the limits that count per `by`. */
export function phaseOf(by: RateLimitTracker): RateLimitPhase {
  return by === "account" ? "account" : "request";
}

/** The parts of an Express response the guards write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

/**
 * The global guard of the `ip`, `email` and `domain` limits, before the auth guards (architecture §3 step 4). A
 * request over a limit answers `429 RATE_LIMITED` with `Retry-After`.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected readonly phase: RateLimitPhase = "request";

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @InjectPinoLogger(RateLimitGuard.name) private readonly pino: PinoLogger,
  ) {
    super(options, storageService, reflector);
  }

  /** Keeps only the throttlers of this guard's phase. */
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter(
      (throttler) => phaseOf(limitNamed(throttler.name).by) === this.phase,
    );
  }

  /** Counts one limit; a Redis failure refuses (503) or allows the request as the limit says. */
  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (error) {
      if (!(error instanceof RateLimitStoreUnavailableError)) {
        throw error;
      }
      const limit = limitNamed(requestProps.throttler.name);
      this.pino.warn({ err: error, throttler: limit.name }, "throttler.store_unavailable");
      if (limit.whenStoreDown === "allow") {
        return true;
      }
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

/**
 * The global guard of the `account` limits, right after the auth guards, which put the account into the request
 * context. CommonModule provides the two guards in this order; the auth guards (PBE-012) go between them.
 */
@Injectable()
export class AccountRateLimitGuard extends RateLimitGuard {
  protected override readonly phase: RateLimitPhase = "account";
}
