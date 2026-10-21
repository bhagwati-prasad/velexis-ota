// Guest booking tokens and bookings.lookup (OBE-047; ota/docs/flows/my-bookings-and-guest-lookup.md §2, §3 step 8 and
// §4, OADR-0006 points 1, 4 and 6, ota/docs/api-changes.md §2.2, the contract's lookupBooking and CheckoutCompletion):
// how a traveller without an account gets back to one booking.
//
// **Tokens.** A guest booking token is `vxbt_<environment>_` and 256 random bits in base64url (`newBookingToken`);
// only its SHA-256 is stored (`booking_access_tokens.token_hash`, booking-access.guard.ts `bookingTokenHash`), with
// `issued_via` and `expires_at`, and the token itself exists only in the answer that hands it out (and in the
// idempotency record's ciphertext, for that answer's replays). `issue` writes the row in the caller's transaction:
//
//   checkout.complete of a guest booking (booking-orchestrator.service.ts; `booking_created`): the `201`, and the
//   `504 SUPPLIER_TIMEOUT` of a booking whose order may exist (so the guest can poll it), valid for 30 days or until
//   7 days after the last flight, whichever is later (`completionTokenExpiry`, the contract's
//   `bookingTokenExpiresAt`), so it covers the whole trip;
//   bookings.lookup (`lookup`): 24 hours.
//
// `deliver` hands an issued token to the caller once its transaction has committed (OADR-0006 points 1 and 4): the
// storefront edge gets it in `__Host-vx_bt` (cookie-writer.ts `addBookingToken`: prepended to the entries the request
// sent, at most five, newest first, HttpOnly) and `bookingToken: null` in the body; a key caller gets it in the body
// (`X-Booking-Token` from then on) and never a `Set-Cookie`. The response comes from the request of the context
// (nestjs-cls keeps it; Express links it to its response), so the orchestrator needs no handle of its own.
//
// **bookings.lookup** (`POST /v1/bookings/lookup`, `Idempotency-Key`): `bookingReference` (trimmed, upper case: stored
// references and record locators are upper case) against `bookings.reference`, `bookings.record_locator` and
// `booking_associated_records.reference`, only among the bookings of the request's environment (the storefront's, or
// the key's: a test booking is never found from a live storefront) that are not `failed`; `lastName` against the last
// name of any traveller of the booking (`booking_travelers.last_name`, and the lead traveller's `lead_last_name` of a
// booking that has no travellers yet), case- and accent-insensitive (`nameKey`). The newest matching booking wins. A
// match issues a 24-hour token, writes the staff-only event `booking.lookup` and answers `200` with the booking's card
// (`BookingSummary`); every mismatch (an unknown reference, a wrong name, a booking of the other environment, a failed
// booking) answers the same `404 NOT_FOUND` with the same message, so the answers differ in `requestId` only.
//
// **Brute force** (architecture §8, `RATE_LIMITS.lookupFailuresPerIp` and `lookupFailuresPerReference`): at most 5
// failed lookups per 15 minutes per end-user IP (the edge's client, a secret key's `X-Velexis-End-User-IP`) and per
// tenant and reference; with 5 counted on either, a lookup answers `429 RATE_LIMITED` with `Retry-After` (the rest of
// the window) without being matched, so the sixth failure, and any lookup after it, is refused. `LookupAttempts`
// counts an attempt **before** it is matched, in one Lua script that checks both counters and counts on both at once,
// and takes it back when the lookup succeeded (or failed for another reason than a mismatch): a burst of parallel
// guesses never gets more than five matches per window. The counters are the throttler keys `rl:ota_lookup_ip:<digest>`
// and `rl:ota_lookup_reference:<digest>` (redis.keys.ts `throttle`, rate-limits.ts `trackerDigest`: no IP or reference
// in clear), always with their TTL. A Redis that cannot answer refuses the lookup with `503 SERVICE_UNAVAILABLE`: a
// limit that cannot be counted is never skipped.
//
// Neither tokens nor the name or reference a visitor typed are ever logged.
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { sql, type Insertable, type TenantDatabase } from "@velexis/db";
import { AppError } from "@velexis/errors";
import type { Request } from "express";
import type { Redis } from "ioredis";
import { CLS_REQ, ClsService } from "nestjs-cls";
import { PinoLogger } from "nestjs-pino";
import { bookingTokenHash } from "../common/auth/booking-access.guard";
import { Clock } from "../common/clock";
import { CookieWriter, STOREFRONT_COOKIES } from "../common/http/cookie-writer";
import { RATE_LIMITS, trackerDigest, trackerValue } from "../common/http/rate-limits";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { redisKeys, type RedisKey } from "../common/redis/redis.keys";
import { PaymentsRepository } from "../payments/payments.repository";
import { CallerContext, type Caller } from "../tenancy/caller-resolver";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { toBookingSummary, type BookingSummary } from "./bookings.mapper";
import { BookingsRepository } from "./bookings.repository";
import { eventActorOf, OrderRecorder } from "./order-recorder";

type Schemas = components["schemas"];
export type BookingLookupRequest = Schemas["BookingLookupRequest"];
export type BookingLookupResult = Schemas["BookingLookupResult"];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How a token was issued (`booking_access_tokens.issued_via`). */
export type BookingTokenIssuedVia = "booking_created" | "lookup";

/** A lookup token lives 24 hours (the contract's `BookingLookupResult.expiresAt`). */
export const LOOKUP_TOKEN_TTL_MS = 24 * HOUR_MS;

/** A completion token lives at least 30 days … */
export const COMPLETION_TOKEN_MIN_TTL_MS = 30 * DAY_MS;

/** … and at least until 7 days after the last flight (the contract's `bookingTokenExpiresAt`). */
export const COMPLETION_TOKEN_AFTER_TRIP_MS = 7 * DAY_MS;

/** The random bytes of a token: 256 bits (architecture §3.2). */
export const BOOKING_TOKEN_BYTES = 32;

/** The bookings a reference can name at most (a reference, a record locator reused by Amadeus, an airline locator). */
const MAX_LOOKUP_CANDIDATES = 20;

/** The one message of every lookup mismatch: the answers differ in `requestId` only. */
export const LOOKUP_NOT_FOUND_MESSAGE = "No booking matches this reference and last name.";

/** A token `issue` wrote: the token itself exists only here and in the answer `deliver` builds. */
export interface IssuedBookingToken {
  readonly bookingId: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/** The token fields of an answer: the body's token for key callers, `null` for the edge (it is in the cookie). */
export interface DeliveredBookingToken {
  readonly bookingToken: string | null;
  readonly bookingTokenExpiresAt: string | null;
}

/** The token fields of an answer without a token (a customer's booking, the edge). */
export const NO_BOOKING_TOKEN: DeliveredBookingToken = Object.freeze({
  bookingToken: null,
  bookingTokenExpiresAt: null,
});

/** A new guest token of `environment`: `vxbt_<environment>_` and 256 random bits in base64url (43 characters). */
export function newBookingToken(environment: "test" | "live"): string {
  const random = randomBytes(BOOKING_TOKEN_BYTES);
  try {
    return `vxbt_${environment}_${random.toString("base64url")}`;
  } finally {
    random.fill(0);
  }
}

/** When a token issued at `now` for a booking whose last flight lands at `lastArrivalAt` ends (checkout.complete). */
export function completionTokenExpiry(now: Date, lastArrivalAt: Date): Date {
  return new Date(
    Math.max(
      now.getTime() + COMPLETION_TOKEN_MIN_TTL_MS,
      lastArrivalAt.getTime() + COMPLETION_TOKEN_AFTER_TRIP_MS,
    ),
  );
}

/**
 * A name as lookups compare it: compatibility-decomposed with its accents dropped, upper case (`ß` becomes `SS`, as
 * airline names write it), inner white space as one space, trimmed. `Müller`, `MULLER` and ` muller ` are equal.
 */
export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/** A reference as lookups compare it: trimmed, upper case. */
export function referenceKey(reference: string): string {
  return reference.trim().toUpperCase();
}

/** What a lookup compares of one candidate booking. */
export interface LookupCandidate {
  readonly id: string;
  readonly leadLastName: string;
  /** The last names of the booking's travellers. */
  readonly lastNames: readonly string[];
}

/** True when `lastName` (as typed) is the last name of a traveller of `candidate` (see `nameKey`). */
export function lastNameMatches(candidate: LookupCandidate, lastName: string): boolean {
  const wanted = nameKey(lastName);
  if (wanted === "") {
    return false;
  }
  const names = candidate.lastNames.length > 0 ? candidate.lastNames : [candidate.leadLastName];
  return names.some((name) => nameKey(name) === wanted);
}

/** The error of every lookup mismatch (see the file header). */
export function lookupNotFound(): AppError {
  return new AppError("NOT_FOUND", { message: LOOKUP_NOT_FOUND_MESSAGE });
}

// ---- Persistence -----------------------------------------------------------------------------------------------------

/** The `booking_access_tokens` rows and the lookup's match (tenant tables, through `tenantTx`). */
@Injectable()
export class GuestAccessRepository {
  async insertToken(
    trx: TenantTransaction,
    row: Insertable<TenantDatabase["booking_access_tokens"]>,
  ): Promise<void> {
    await trx.insertInto("booking_access_tokens").values(row).execute();
  }

  /**
   * The bookings of `environment`, not `failed`, whose reference, record locator or an associated (airline) record is
   * `reference`, newest first, with their travellers' last names.
   */
  async lookupCandidates(
    trx: TenantTransaction,
    environment: string,
    reference: string,
  ): Promise<LookupCandidate[]> {
    return await trx
      .selectFrom("bookings as b")
      .select([
        "b.id as id",
        "b.lead_last_name as leadLastName",
        sql<string[]>`array(
          SELECT t.last_name FROM booking_travelers t WHERE t.booking_id = b.id ORDER BY t.id
        )`.as("lastNames"),
      ])
      .where("b.environment", "=", environment)
      .where("b.status", "<>", "failed")
      .where((eb) =>
        eb.or([
          eb("b.reference", "=", reference),
          eb("b.record_locator", "=", reference),
          eb(
            "b.id",
            "in",
            eb
              .selectFrom("booking_associated_records as r")
              .select("r.booking_id")
              .where("r.reference", "=", reference),
          ),
        ]),
      )
      .orderBy("b.created_at", "desc")
      .orderBy("b.id", "desc")
      .limit(MAX_LOOKUP_CANDIDATES)
      .execute();
  }
}

// ---- The failure counters --------------------------------------------------------------------------------------------

/** What the counters need of the command client (`REDIS_CLIENT`). */
export type LookupRedis = Pick<Redis, "eval">;

/**
 * Takes one attempt on every counter of KEYS, each with its own window and limit (`ARGV[2i-1]`: the window of
 * `KEYS[i]` in milliseconds, `ARGV[2i]`: its limit). When one of them has its limit counted already, nothing is
 * counted and the answer is `{0, ms}` with the longest wait (a counter that somehow lost its TTL gets its window back,
 * so it never blocks for ever). Otherwise every counter is incremented, with its window as its TTL when the attempt is
 * its first (or the TTL is missing): `{1, 0}`.
 */
const TAKE_ATTEMPT = `
local wait = 0
for i = 1, #KEYS do
  local window = tonumber(ARGV[2 * i - 1])
  local limit = tonumber(ARGV[2 * i])
  local counted = tonumber(redis.call('GET', KEYS[i])) or 0
  if counted >= limit then
    local ttl = redis.call('PTTL', KEYS[i])
    if ttl < 0 then
      redis.call('PEXPIRE', KEYS[i], window)
      ttl = window
    end
    if ttl > wait then
      wait = ttl
    end
  end
end
if wait > 0 then
  return { 0, wait }
end
for i = 1, #KEYS do
  local counted = redis.call('INCR', KEYS[i])
  if counted == 1 or redis.call('PTTL', KEYS[i]) < 0 then
    redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[2 * i - 1]))
  end
end
return { 1, 0 }
`;

/**
 * Takes an attempt back on every counter of KEYS that still exists (`DECR` keeps its TTL); a counter back at 0 is
 * deleted. A counter that ended meanwhile is left alone, so none is ever created without a TTL.
 */
const RELEASE_ATTEMPT = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    if redis.call('DECR', KEYS[i]) <= 0 then
      redis.call('DEL', KEYS[i])
    end
  end
end
return 1
`;

/** One failure counter: its throttler key (with its window as `ttlSeconds`) and the failures it allows. */
export interface LookupCounter extends RedisKey {
  /** Failures allowed per window; with this many counted the next lookup answers 429 (RATE_LIMITS). */
  readonly limit: number;
}

/** The counters of one lookup: per end-user IP and per tenant and reference. */
export interface LookupCounters {
  readonly ip: LookupCounter;
  readonly reference: LookupCounter;
}

/** The outcome of `take`. */
export type LookupAttempt =
  { readonly taken: true } | { readonly taken: false; readonly retryAfterSeconds: number };

/** The counters of a lookup for a request (see the file header). */
export function lookupCounters(input: {
  readonly caller: Caller;
  readonly tenantId: string;
  readonly ip: string;
  readonly reference: string;
}): LookupCounters {
  const sources = {
    caller: input.caller,
    tenantId: input.tenantId,
    ip: input.ip,
    body: { bookingReference: input.reference },
  };
  const counter = (
    limit: (typeof RATE_LIMITS)["lookupFailuresPerIp" | "lookupFailuresPerReference"],
  ): LookupCounter => {
    const value = trackerValue(limit.by, sources);
    if (value === undefined) {
      throw new Error(`bookings.lookup: no ${limit.by} to count failures by`);
    }
    return {
      ...redisKeys.throttle(limit.name, trackerDigest(limit.by, value), limit.windowSeconds),
      limit: limit.limit,
    };
  };
  return {
    ip: counter(RATE_LIMITS.lookupFailuresPerIp),
    reference: counter(RATE_LIMITS.lookupFailuresPerReference),
  };
}

/** The failed-lookup counters (see the file header). */
@Injectable()
export class LookupAttempts {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: LookupRedis) {}

  /** Counts an attempt on both counters before it is matched, unless one of them is at its limit. */
  async take(counters: LookupCounters): Promise<LookupAttempt> {
    const { ip, reference } = counters;
    const reply = await this.command(() =>
      this.redis.eval(
        TAKE_ATTEMPT,
        2,
        ip.key,
        reference.key,
        String(ip.ttlSeconds * 1000),
        String(ip.limit),
        String(reference.ttlSeconds * 1000),
        String(reference.limit),
      ),
    );
    const [taken, waitMs] = Array.isArray(reply) ? reply.map(Number) : [];
    if ((taken !== 0 && taken !== 1) || waitMs === undefined || !Number.isFinite(waitMs)) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    return taken === 1
      ? { taken: true }
      : { taken: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  /** Takes back an attempt that was not a failed match (a match, or an error before the answer). */
  async release(counters: LookupCounters): Promise<void> {
    await this.command(() => this.redis.eval(RELEASE_ATTEMPT, 2, counters.ip.key, counters.reference.key));
  }

  /** A Redis command; a failure is `503 SERVICE_UNAVAILABLE` (the limit is never skipped). */
  private async command<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }
}

// ---- The service -----------------------------------------------------------------------------------------------------

/** A lookup match: the booking, its new token and its card, read in the match's transaction. */
interface LookupMatch {
  readonly issued: IssuedBookingToken;
  readonly summary: BookingSummary;
}

@Injectable()
export class GuestAccessService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly callers: CallerContext,
    private readonly requestContext: RequestContext,
    private readonly cookies: CookieWriter,
    private readonly cls: ClsService,
    private readonly repository: GuestAccessRepository,
    private readonly bookings: BookingsRepository,
    private readonly payments: PaymentsRepository,
    private readonly recorder: OrderRecorder,
    private readonly attempts: LookupAttempts,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(GuestAccessService.name);
  }

  // ---- Tokens ------------------------------------------------------------------------------------------------------

  /**
   * Writes a new guest token of booking `bookingId` in `trx`; the token is handed out with `deliver` once `trx` has
   * committed.
   */
  async issue(
    trx: TenantTransaction,
    input: {
      readonly bookingId: string;
      readonly environment: string;
      readonly issuedVia: BookingTokenIssuedVia;
      readonly expiresAt: Date;
    },
  ): Promise<IssuedBookingToken> {
    if (input.environment !== "test" && input.environment !== "live") {
      throw new Error("a booking token for an unknown environment");
    }
    const now = this.clock.now();
    const token = newBookingToken(input.environment);
    await this.repository.insertToken(trx, {
      id: this.ids.newId("bat"),
      booking_id: input.bookingId,
      token_hash: bookingTokenHash(token),
      issued_via: input.issuedVia,
      created_ip: this.endUserAddress(),
      expires_at: input.expiresAt,
      created_at: now,
      updated_at: now,
    });
    return Object.freeze({ bookingId: input.bookingId, token, expiresAt: input.expiresAt });
  }

  /**
   * Hands an issued token to the caller (see the file header): for the edge, `__Host-vx_bt` on the request's response
   * and no token in the body; for key callers, the token in the body.
   */
  deliver(issued: IssuedBookingToken): DeliveredBookingToken {
    if (!this.cookies.isEdge()) {
      return { bookingToken: issued.token, bookingTokenExpiresAt: issued.expiresAt.toISOString() };
    }
    const req: unknown = this.cls.isActive() ? this.cls.get(CLS_REQ) : undefined;
    const res = typeof req === "object" && req !== null ? (req as Request).res : undefined;
    if (res === undefined) {
      throw new Error("a booking token delivered to the edge outside a request");
    }
    const cookies = (req as Request).cookies as Record<string, unknown> | undefined;
    this.cookies.addBookingToken(res, cookies?.[STOREFRONT_COOKIES.bookingTokens], {
      bookingId: issued.bookingId,
      token: issued.token,
    });
    return NO_BOOKING_TOKEN;
  }

  // ---- bookings.lookup ---------------------------------------------------------------------------------------------

  /** bookings.lookup (see the file header). */
  async lookup(body: BookingLookupRequest): Promise<BookingLookupResult> {
    const tenant = this.tenants.require();
    const caller = this.callers.get();
    if (caller === undefined) {
      throw new Error("bookings.lookup without a caller in the request context");
    }
    const reference = referenceKey(body.bookingReference);
    const counters = lookupCounters({
      caller,
      tenantId: tenant.tenantId,
      ip: this.requestContext.endUser()?.ip ?? "unknown",
      reference,
    });
    const attempt = await this.attempts.take(counters);
    if (!attempt.taken) {
      this.logger.warn({ tenantId: tenant.tenantId }, "bookings.lookup_rate_limited");
      throw new AppError("RATE_LIMITED", {
        message: "Too many failed lookups. Try again later.",
        details: { retryAfterSeconds: attempt.retryAfterSeconds },
      });
    }
    let match: LookupMatch | undefined;
    try {
      match = await this.tx.run((trx) => this.match(trx, tenant, reference, body.lastName));
    } catch (error) {
      // Not a failed match: the attempt is not counted against the visitor or the reference.
      await this.releaseAttempt(counters);
      throw error;
    }
    if (match === undefined) {
      this.logger.info({ tenantId: tenant.tenantId }, "bookings.lookup_not_found");
      throw lookupNotFound();
    }
    await this.releaseAttempt(counters);
    const delivered = this.deliver(match.issued);
    this.logger.info({ bookingId: match.issued.bookingId }, "bookings.lookup_matched");
    return {
      bookingId: match.issued.bookingId,
      bookingToken: delivered.bookingToken,
      expiresAt: match.issued.expiresAt.toISOString(),
      booking: match.summary,
    };
  }

  /** The newest booking the reference and the name match, with a new token, the event and its card; or `undefined`. */
  private async match(
    trx: TenantTransaction,
    tenant: RequestTenant,
    reference: string,
    lastName: string,
  ): Promise<LookupMatch | undefined> {
    const candidates = await this.repository.lookupCandidates(trx, tenant.environment, reference);
    const found = candidates.find((candidate) => lastNameMatches(candidate, lastName));
    if (found === undefined) {
      return undefined;
    }
    const row = await this.bookings.bookingSummary(trx, tenant.environment, found.id);
    if (row === undefined) {
      return undefined;
    }
    const now = this.clock.now();
    const issued = await this.issue(trx, {
      bookingId: found.id,
      environment: tenant.environment,
      issuedVia: "lookup",
      expiresAt: new Date(now.getTime() + LOOKUP_TOKEN_TTL_MS),
    });
    await this.recorder.event(trx, found.id, {
      type: "booking.lookup",
      actor: eventActorOf(tenant.actor),
      summary: "Guest access opened by booking reference and last name.",
      data: { expiresAt: issued.expiresAt.toISOString() },
      visibleToCustomer: false,
      requestId: this.tenants.requestId() ?? tenant.requestId,
      now,
    });
    const segments = await this.bookings.summarySegments(trx, [found.id]);
    const [lead] = await this.bookings.leadTravelers(trx, [found.id]);
    const cities =
      row.destinationIata === null
        ? new Map<string, string>()
        : await this.bookings.cityNames(trx, [row.destinationIata]);
    const summary = toBookingSummary({
      row,
      segments,
      lead,
      cityName: row.destinationIata === null ? undefined : cities.get(row.destinationIata),
      minorUnits: (await this.payments.currencyMinorUnits(trx, row.currency)) ?? 2,
      now,
    });
    return { issued, summary };
  }

  /**
   * Takes back an attempt that was not a failed match. Best effort: the token may be committed already, so a Redis
   * that cannot answer now only leaves one attempt too many counted (logged), never a lost answer.
   */
  private async releaseAttempt(counters: LookupCounters): Promise<void> {
    try {
      await this.attempts.release(counters);
    } catch (error) {
      this.logger.warn({ err: error }, "bookings.lookup_attempt_not_released");
    }
  }

  /** The end user's IP address for `created_ip`, or `null` when the request names none. */
  private endUserAddress(): string | null {
    const ip = this.requestContext.endUser()?.ip;
    return ip !== undefined && isIP(ip) !== 0 ? ip : null;
  }
}
