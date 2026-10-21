// The retry schedule of a failed issuance (OBE-044; OADR-0008 points 4 and 5, ota/docs/flows/ticketing-and-documents.md
// §3 steps 2–4 and §4). Pure functions: no I/O, no clock (the caller passes the instants).
//
//   attempt 1        inside checkout.complete (booking-orchestrator.service.ts, order-recorder.ts); a failure sets
//                    `ticketing_attempts = 1` and the next attempt 5 minutes later (FIRST_TICKETING_RETRY_MS)
//   attempt 2        5 minutes after the failure of attempt 1
//   attempt 3        15 minutes after the failure of attempt 2
//   attempt 4        1 hour after the failure of attempt 3
//   attempts 5–8     2 hours after the failure of the attempt before
//   give up          after the 8th failed attempt (MAX_TICKETING_ATTEMPTS), when the next attempt would be later than
//                    `ticketing_deadline_at − 2 h` (never after it), or at once after a failure for payment reasons
//                    (`PAYMENT_DECLINED`: the form of payment was refused, retrying cannot fix it)
//
// Each delay counts from the failure of the attempt before, not from the first failure. A booking without a ticketing
// deadline is bounded by the number of attempts only. `nextTicketingAttempt` decides after a failure;
// `ticketingAttemptRefusal` decides when a claimed booking is about to start an attempt (a worker that was down may
// take a booking after its window closed: then the attempt only re-reads the order and gives up without issuing).

/** The delays after the failure of attempts 1, 2 and 3 (OADR-0008 point 4). */
export const TICKETING_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
]);

/** The delay after the failure of the 4th attempt and of every later one. */
export const TICKETING_RETRY_INTERVAL_MS = 2 * 60 * 60_000;

/** Attempts of one booking at most, the first one (inside checkout.complete) included. */
export const MAX_TICKETING_ATTEMPTS = 8;

/** No attempt starts later than this before `ticketing_deadline_at`. */
export const TICKETING_DEADLINE_MARGIN_MS = 2 * 60 * 60_000;

/** The `ticketing_error_code`s of failures for payment reasons: never retried automatically (flow §4). */
export const PAYMENT_FAILURE_CODES: ReadonlySet<string> = new Set(["PAYMENT_DECLINED"]);

/** Why no further automatic attempt is made. */
export type TicketingStop =
  /** MAX_TICKETING_ATTEMPTS attempts were made. */
  | "attempts_exhausted"
  /** The next attempt would be later than `ticketing_deadline_at − 2 h`. */
  | "deadline"
  /** The last failure was for payment reasons. */
  | "payment";

/** After a failure: when the next attempt is due, or why there is none. */
export type TicketingNext =
  { readonly kind: "retry"; readonly at: Date } | { readonly kind: "stop"; readonly reason: TicketingStop };

/** What the schedule reads of a booking after a failed attempt. */
export interface FailedAttempt {
  /** `ticketing_attempts`: the attempts made so far, the failed one included (1 or more). */
  readonly attempts: number;
  /** When the attempt failed. */
  readonly failedAt: Date;
  /** `ticketing_deadline_at`, or `null` when the order gave none. */
  readonly deadlineAt: Date | null;
  /** `ticketing_error_code` of the failure. */
  readonly errorCode: string | null;
}

/** What the schedule reads of a booking before a new attempt starts. */
export interface AttemptStart {
  /** `ticketing_attempts`: the attempts made so far (before the new one). */
  readonly attempts: number;
  /** When the new attempt would start. */
  readonly at: Date;
  readonly deadlineAt: Date | null;
  /** `ticketing_error_code` of the last failure. */
  readonly lastErrorCode: string | null;
}

function checkAttempts(attempts: number, what: string): void {
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new RangeError(`${what}: attempts must be a whole number, 0 or more`);
  }
}

function checkInstant(instant: Date | null, what: string): void {
  if (instant !== null && !Number.isFinite(instant.getTime())) {
    throw new RangeError(`${what}: not a valid instant`);
  }
}

/** The wait after the failure of attempt number `attempts` (1 → 5 min, 2 → 15 min, 3 → 1 h, then 2 h). */
export function ticketingRetryDelayMs(attempts: number): number {
  checkAttempts(attempts, "ticketingRetryDelayMs");
  return TICKETING_RETRY_DELAYS_MS[Math.max(attempts, 1) - 1] ?? TICKETING_RETRY_INTERVAL_MS;
}

/** The latest instant at which an attempt may start: `deadlineAt − 2 h`, or `null` without a deadline. */
export function lastAttemptStart(deadlineAt: Date | null): Date | null {
  checkInstant(deadlineAt, "lastAttemptStart");
  return deadlineAt === null ? null : new Date(deadlineAt.getTime() - TICKETING_DEADLINE_MARGIN_MS);
}

/** Whether a failure with this code was for payment reasons (never retried automatically). */
export function isPaymentFailure(code: string | null): boolean {
  return code !== null && PAYMENT_FAILURE_CODES.has(code);
}

/**
 * After a failed attempt: the next attempt, `failedAt + ticketingRetryDelayMs(attempts)`, unless the failure was for
 * payment reasons, MAX_TICKETING_ATTEMPTS attempts were made, or that instant is later than `deadlineAt − 2 h`.
 */
export function nextTicketingAttempt(failed: FailedAttempt): TicketingNext {
  checkAttempts(failed.attempts, "nextTicketingAttempt");
  checkInstant(failed.failedAt, "nextTicketingAttempt");
  if (isPaymentFailure(failed.errorCode)) {
    return { kind: "stop", reason: "payment" };
  }
  if (failed.attempts >= MAX_TICKETING_ATTEMPTS) {
    return { kind: "stop", reason: "attempts_exhausted" };
  }
  const at = new Date(failed.failedAt.getTime() + ticketingRetryDelayMs(failed.attempts));
  const latest = lastAttemptStart(failed.deadlineAt);
  if (latest !== null && at.getTime() > latest.getTime()) {
    return { kind: "stop", reason: "deadline" };
  }
  return { kind: "retry", at };
}

/**
 * Whether a new attempt may start at `start.at`: `undefined` when it may, else why not (the last failure was for
 * payment reasons, every attempt was made, or the deadline is less than 2 hours away).
 */
export function ticketingAttemptRefusal(start: AttemptStart): TicketingStop | undefined {
  checkAttempts(start.attempts, "ticketingAttemptRefusal");
  checkInstant(start.at, "ticketingAttemptRefusal");
  if (isPaymentFailure(start.lastErrorCode)) {
    return "payment";
  }
  if (start.attempts >= MAX_TICKETING_ATTEMPTS) {
    return "attempts_exhausted";
  }
  const latest = lastAttemptStart(start.deadlineAt);
  if (latest !== null && start.at.getTime() > latest.getTime()) {
    return "deadline";
  }
  return undefined;
}
