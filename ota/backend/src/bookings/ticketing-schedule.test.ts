// The retry schedule of a failed issuance (OBE-044; OADR-0008 points 4 and 5). Instants are built from FakeClock's
// fixed start, never from today.
import { FAKE_CLOCK_DEFAULT_START } from "@velexis/testing";
import { describe, expect, it } from "vitest";
import { FIRST_TICKETING_RETRY_MS } from "./order-recorder";
import {
  lastAttemptStart,
  MAX_TICKETING_ATTEMPTS,
  nextTicketingAttempt,
  ticketingAttemptRefusal,
  ticketingRetryDelayMs,
  TICKETING_DEADLINE_MARGIN_MS,
  type TicketingNext,
} from "./ticketing-schedule";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date(FAKE_CLOCK_DEFAULT_START);
const after = (ms: number): Date => new Date(T0.getTime() + ms);

/**
 * The attempts a booking gets when every attempt fails at the instant it is due: the start of each retry (attempt 2
 * onwards) as an offset from the first failure at T0, and why the schedule stopped.
 */
function run(
  deadlineAt: Date | null,
  errorCode = "TICKETING_FAILED",
): {
  readonly retries: number[];
  readonly stop: string;
} {
  const retries: number[] = [];
  let attempts = 1;
  let failedAt = T0;
  for (;;) {
    const next: TicketingNext = nextTicketingAttempt({ attempts, failedAt, deadlineAt, errorCode });
    if (next.kind === "stop") {
      return { retries, stop: next.reason };
    }
    // The attempt is allowed to start when it is due, and it fails at once.
    expect(ticketingAttemptRefusal({ attempts, at: next.at, deadlineAt, lastErrorCode: errorCode })).toBe(
      undefined,
    );
    retries.push(next.at.getTime() - T0.getTime());
    attempts += 1;
    failedAt = next.at;
  }
}

describe("the delays", () => {
  it("are 5 minutes, 15 minutes, 1 hour, then 2 hours after each failure", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(ticketingRetryDelayMs)).toEqual([
      5 * MINUTE,
      15 * MINUTE,
      HOUR,
      2 * HOUR,
      2 * HOUR,
      2 * HOUR,
      2 * HOUR,
    ]);
    // The first one is the delay checkout.complete writes after its own failed attempt.
    expect(ticketingRetryDelayMs(1)).toBe(FIRST_TICKETING_RETRY_MS);
    expect(ticketingRetryDelayMs(0)).toBe(5 * MINUTE);
  });

  it("refuse a count of attempts that is not a whole number", () => {
    for (const attempts of [-1, 1.5, Number.NaN]) {
      expect(() => ticketingRetryDelayMs(attempts)).toThrow(RangeError);
    }
  });
});

describe("nextTicketingAttempt", () => {
  it("[OBE-044 AC1] retries at +5 min, +15 min, +1 h, then every 2 h, and stops after the 8th attempt", () => {
    const { retries, stop } = run(null);

    expect(retries).toEqual([
      5 * MINUTE,
      20 * MINUTE,
      HOUR + 20 * MINUTE,
      3 * HOUR + 20 * MINUTE,
      5 * HOUR + 20 * MINUTE,
      7 * HOUR + 20 * MINUTE,
      9 * HOUR + 20 * MINUTE,
    ]);
    // The first attempt (checkout.complete) and the seven retries.
    expect(retries.length + 1).toBe(MAX_TICKETING_ATTEMPTS);
    expect(stop).toBe("attempts_exhausted");
  });

  it("[OBE-044 AC1] never schedules an attempt after the deadline − 2 h", () => {
    // Deadline 6 hours after the first failure: no attempt starts after T0 + 4 h.
    const { retries, stop } = run(after(6 * HOUR));

    expect(retries).toEqual([5 * MINUTE, 20 * MINUTE, HOUR + 20 * MINUTE, 3 * HOUR + 20 * MINUTE]);
    expect(stop).toBe("deadline");
    expect(Math.max(...retries)).toBeLessThanOrEqual(4 * HOUR);
  });

  it("schedules an attempt exactly at the deadline − 2 h, and none a millisecond later", () => {
    const failedAt = T0;
    const due = after(5 * MINUTE);

    expect(
      nextTicketingAttempt({
        attempts: 1,
        failedAt,
        deadlineAt: new Date(due.getTime() + TICKETING_DEADLINE_MARGIN_MS),
        errorCode: "TICKETING_FAILED",
      }),
    ).toEqual({ kind: "retry", at: due });
    expect(
      nextTicketingAttempt({
        attempts: 1,
        failedAt,
        deadlineAt: new Date(due.getTime() + TICKETING_DEADLINE_MARGIN_MS - 1),
        errorCode: "TICKETING_FAILED",
      }),
    ).toEqual({ kind: "stop", reason: "deadline" });
  });

  it("gives up at once after a failure for payment reasons", () => {
    expect(
      nextTicketingAttempt({ attempts: 1, failedAt: T0, deadlineAt: null, errorCode: "PAYMENT_DECLINED" }),
    ).toEqual({ kind: "stop", reason: "payment" });
    expect(run(null, "PAYMENT_DECLINED")).toEqual({ retries: [], stop: "payment" });
  });

  it("retries a timed-out issuance like any other failure (the next attempt starts with a resync)", () => {
    expect(
      nextTicketingAttempt({ attempts: 2, failedAt: T0, deadlineAt: null, errorCode: "SUPPLIER_TIMEOUT" }),
    ).toEqual({ kind: "retry", at: after(15 * MINUTE) });
  });
});

describe("ticketingAttemptRefusal", () => {
  it("lets an attempt start until the deadline − 2 h and while attempts are left", () => {
    const deadlineAt = after(10 * HOUR);
    const latest = lastAttemptStart(deadlineAt);

    expect(latest).toEqual(after(8 * HOUR));
    expect(
      ticketingAttemptRefusal({
        attempts: 3,
        at: after(8 * HOUR),
        deadlineAt,
        lastErrorCode: "TICKETING_FAILED",
      }),
    ).toBeUndefined();
    expect(
      ticketingAttemptRefusal({
        attempts: 3,
        at: after(8 * HOUR + 1),
        deadlineAt,
        lastErrorCode: "TICKETING_FAILED",
      }),
    ).toBe("deadline");
    expect(
      ticketingAttemptRefusal({
        attempts: MAX_TICKETING_ATTEMPTS,
        at: T0,
        deadlineAt: null,
        lastErrorCode: "TICKETING_FAILED",
      }),
    ).toBe("attempts_exhausted");
    expect(
      ticketingAttemptRefusal({ attempts: 1, at: T0, deadlineAt: null, lastErrorCode: "PAYMENT_DECLINED" }),
    ).toBe("payment");
    expect(lastAttemptStart(null)).toBeNull();
  });
});
