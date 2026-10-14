// FakeClock (X-015; conventions §2 "Time and randomness", ADR-0015 "Time"): a clock that only moves when the test
// says so. It has the shape of the backends' injectable `Clock` (`now(): Date`), so a test module provides it with
// `{ provide: Clock, useValue: new FakeClock() }`.

/** The instant a `FakeClock` starts at when none is given: fixed, so test output never depends on today. */
export const FAKE_CLOCK_DEFAULT_START = "2026-01-15T10:00:00.000Z";

function toEpochMs(instant: Date | string | number, what: string): number {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError(`FakeClock: ${what} is not a valid instant`);
  }
  return ms;
}

/** A controllable clock: `now()` returns the same instant until `advance(ms)` or `set(instant)` moves it. */
export class FakeClock {
  #epochMs: number;

  /** @param start the first instant (a `Date`, an ISO 8601 string or epoch milliseconds); default 2026-01-15 10:00 UTC. */
  constructor(start: Date | string | number = FAKE_CLOCK_DEFAULT_START) {
    this.#epochMs = toEpochMs(start, "the start");
  }

  /** The current fake instant, as a new `Date` (changing it does not move the clock). */
  now(): Date {
    return new Date(this.#epochMs);
  }

  /** Moves the clock forward by `ms` milliseconds (0 or more) and returns the new instant. */
  advance(ms: number): Date {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("FakeClock.advance: ms must be a finite number of milliseconds, 0 or more");
    }
    this.#epochMs += ms;
    return this.now();
  }

  /** Jumps to `instant`, forwards or backwards (for example to just before a deadline), and returns it. */
  set(instant: Date | string | number): Date {
    this.#epochMs = toEpochMs(instant, "the instant");
    return this.now();
  }
}
