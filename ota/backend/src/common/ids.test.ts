import { describe, expect, it } from "vitest";
import { Clock } from "./clock";
import { IdGenerator, newId } from "./ids";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The millisecond timestamp in the first 10 characters of a ULID. */
function ulidTime(id: string): number {
  const ulid = id.slice(id.indexOf("_") + 1);
  return [...ulid.slice(0, 10)].reduce((time, char) => time * 32 + CROCKFORD.indexOf(char), 0);
}

class FixedClock extends Clock {
  constructor(private readonly instant: Date) {
    super();
  }

  override now(): Date {
    return new Date(this.instant);
  }
}

describe("newId", () => {
  it("returns <prefix>_<ULID> with a fresh random part every time", () => {
    const ids = Array.from({ length: 50 }, () => newId("bkg"));

    for (const id of ids) {
      expect(id).toMatch(/^bkg_[0-9A-HJKMNP-TV-Z]{26}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stamps the given time", () => {
    const at = new Date("2026-10-13T08:30:00.000Z");

    expect(ulidTime(newId("chk", at))).toBe(at.getTime());
  });

  it("refuses a prefix that is not 2 to 4 lower-case letters, at compile time and at run time", () => {
    // @ts-expect-error Upper-case prefixes do not compile.
    expect(() => newId("BKG")).toThrow(TypeError);
    // @ts-expect-error Neither do prefixes longer than 4 letters.
    expect(() => newId("booking")).toThrow(TypeError);
  });
});

describe("IdGenerator", () => {
  it("takes the timestamp from the injected Clock, so ids sort with created_at", () => {
    const at = new Date("2026-10-13T08:30:00.000Z");
    const ids = new IdGenerator(new FixedClock(at));

    const id = ids.newId("pay");

    expect(id).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulidTime(id)).toBe(at.getTime());
  });

  it("never repeats an id made at the same instant", () => {
    const ids = new IdGenerator(new FixedClock(new Date("2026-10-13T08:30:00.000Z")));

    const made = Array.from({ length: 50 }, () => ids.newId("off"));

    expect(new Set(made).size).toBe(made.length);
  });
});
