import { describe, expect, it } from "vitest";
import { FAKE_CLOCK_DEFAULT_START, FakeClock } from "./clock.js";

// Tests of task X-015 step 4: FakeClock (`now()`, `advance(ms)`), the clock tests inject instead of the backends'
// `Clock` (conventions §2, ADR-0015 "Time").

/** What the backends' injectable `Clock` offers (ota/backend/src/common/clock.ts). */
interface ClockLike {
  now(): Date;
}

/** A tiny piece of code under test: is a token issued at `issuedAt` expired, given a TTL? */
function isExpired(clock: ClockLike, issuedAt: Date, ttlMs: number): boolean {
  return clock.now().getTime() >= issuedAt.getTime() + ttlMs;
}

describe("FakeClock", () => {
  it("starts at a fixed instant and stands still until told to move", () => {
    const clock = new FakeClock();
    expect(clock.now().toISOString()).toBe(FAKE_CLOCK_DEFAULT_START);
    expect(FAKE_CLOCK_DEFAULT_START).toBe("2026-01-15T10:00:00.000Z");
    expect(clock.now().getTime()).toBe(clock.now().getTime());
  });

  it("starts at a Date, an ISO 8601 string or epoch milliseconds", () => {
    const at = "2026-10-12T09:30:00.000Z";
    expect(new FakeClock(new Date(at)).now().toISOString()).toBe(at);
    expect(new FakeClock(at).now().toISOString()).toBe(at);
    expect(new FakeClock(Date.parse(at)).now().toISOString()).toBe(at);
    expect(() => new FakeClock("not a date")).toThrow(
      new RangeError("FakeClock: the start is not a valid instant"),
    );
    expect(() => new FakeClock(Number.NaN)).toThrow(RangeError);
  });

  it("advance(ms) moves the clock forward and returns the new instant", () => {
    const clock = new FakeClock("2026-10-12T09:00:00.000Z");
    expect(clock.advance(1_500).toISOString()).toBe("2026-10-12T09:00:01.500Z");
    expect(clock.now().toISOString()).toBe("2026-10-12T09:00:01.500Z");
    expect(clock.advance(0).toISOString()).toBe("2026-10-12T09:00:01.500Z");
    expect(clock.advance(24 * 60 * 60 * 1_000).toISOString()).toBe("2026-10-13T09:00:01.500Z");
  });

  it("refuses to move backwards or by a non-finite amount with advance", () => {
    const clock = new FakeClock();
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => clock.advance(ms)).toThrow(
        new RangeError("FakeClock.advance: ms must be a finite number of milliseconds, 0 or more"),
      );
    }
    expect(clock.now().toISOString()).toBe(FAKE_CLOCK_DEFAULT_START);
  });

  it("set(instant) jumps forwards or backwards", () => {
    const clock = new FakeClock("2026-10-12T09:00:00.000Z");
    expect(clock.set("2026-12-24T18:00:00.000Z").toISOString()).toBe("2026-12-24T18:00:00.000Z");
    expect(clock.set(new Date("2026-01-01T00:00:00.000Z")).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(() => clock.set("never")).toThrow(new RangeError("FakeClock: the instant is not a valid instant"));
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("hands out copies: changing a returned Date does not move the clock", () => {
    const clock = new FakeClock();
    const now = clock.now();
    now.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe(FAKE_CLOCK_DEFAULT_START);
    const advanced = clock.advance(1);
    advanced.setTime(0);
    expect(clock.now().getTime()).toBe(Date.parse(FAKE_CLOCK_DEFAULT_START) + 1);
  });

  it("stands in for the backends' Clock, so time-dependent code is tested without waiting", () => {
    const clock = new FakeClock();
    const issuedAt = clock.now();
    const ttlMs = 15 * 60 * 1_000;
    expect(isExpired(clock, issuedAt, ttlMs)).toBe(false);
    clock.advance(ttlMs - 1);
    expect(isExpired(clock, issuedAt, ttlMs)).toBe(false);
    clock.advance(1);
    expect(isExpired(clock, issuedAt, ttlMs)).toBe(true);
  });
});
