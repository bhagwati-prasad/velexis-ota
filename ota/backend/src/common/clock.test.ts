import { afterEach, describe, expect, it, vi } from "vitest";
import { Clock } from "./clock";

afterEach(() => {
  vi.useRealTimers();
});

describe("Clock", () => {
  it("returns the current instant as a new Date on every call", () => {
    vi.useFakeTimers({ now: new Date("2026-10-13T08:30:00.000Z") });
    const clock = new Clock();

    const first = clock.now();
    vi.advanceTimersByTime(1500);
    const second = clock.now();

    expect(first.toISOString()).toBe("2026-10-13T08:30:00.000Z");
    expect(second.toISOString()).toBe("2026-10-13T08:30:01.500Z");
    expect(second).not.toBe(first);
  });
});
