import { decodeTime, incrementBase32 } from "ulid";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { newId, type IdPrefix } from "./index.js";

const BKG_ID = /^bkg_[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The 10-character timestamp part of a prefixed ULID. */
const timePart = (id: string) => id.slice(id.indexOf("_") + 1, id.indexOf("_") + 11);
/** The 16-character (80-bit) random part of a prefixed ULID. */
const randomPart = (id: string) => id.slice(id.indexOf("_") + 11);

afterEach(() => {
  vi.useRealTimers();
});

describe("newId", () => {
  it('gives 10,000 unique "bkg" ids that match ^bkg_[0-9A-HJKMNP-TV-Z]{26}$ [X-005 AC3]', () => {
    const ids = Array.from({ length: 10_000 }, () => newId("bkg"));

    expect(new Set(ids).size).toBe(10_000);
    expect(new Set(ids.map(randomPart)).size).toBe(10_000);
    for (const id of ids) {
      expect(id).toMatch(BKG_ID);
    }
  });

  it("never draws from Math.random, which is not a CSPRNG", () => {
    const mathRandom = vi.spyOn(Math, "random");
    try {
      for (let i = 0; i < 100; i += 1) {
        newId("srch");
      }
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      mathRandom.mockRestore();
    }
  });

  it("gives two ids made in the same millisecond different, unrelated random parts [X-005 AC3]", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-13T09:30:00.123Z") });

    const first = newId("bkg");
    const second = newId("bkg");
    expect(timePart(first)).toBe(timePart(second));
    expect(randomPart(first)).not.toBe(randomPart(second));
    // A monotonic ULID factory would give the second id the first id's random part plus one.
    expect(randomPart(second)).not.toBe(incrementBase32(randomPart(first)));
  });

  it("draws every id's 80 random bits fresh, never monotonically, within one millisecond [X-005 AC3]", () => {
    const now = new Date("2026-10-13T09:30:00.123Z");
    const ids = Array.from({ length: 2_000 }, () => newId("bkg", now));
    const randoms = ids.map(randomPart);

    expect(new Set(ids.map(timePart)).size).toBe(1);
    expect(new Set(randoms).size).toBe(ids.length);
    for (let i = 1; i < randoms.length; i += 1) {
      expect(randoms[i]).not.toBe(incrementBase32(randoms[i - 1]!));
    }
    // A monotonic factory keeps the leading random characters fixed within one millisecond. Here every
    // one of the 16 positions takes all 32 values: with 2,000 uniform draws, the chance that any value is
    // missing at any position is below 16 × 32 × (31/32)^2000 ≈ 1.4e-25.
    for (let position = 0; position < 16; position += 1) {
      const seen = new Set(randoms.map((random) => random.charAt(position)));
      expect([...seen].sort().join(""), `position ${position}`).toBe([...CROCKFORD].sort().join(""));
    }
  });

  it("puts the current time, or the given now, into the time-sortable timestamp part", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-13T09:30:00.123Z") });
    expect(decodeTime(newId("bkg").slice("bkg_".length))).toBe(Date.parse("2026-10-13T09:30:00.123Z"));

    const earlier = newId("bkg", new Date("2026-10-13T09:29:59.999Z"));
    const later = newId("bkg", new Date("2026-10-13T09:30:00.000Z"));
    expect(decodeTime(earlier.slice("bkg_".length))).toBe(Date.parse("2026-10-13T09:29:59.999Z"));
    expect(earlier < later).toBe(true);
  });

  it("accepts prefixes of 2 to 4 lower-case letters and refuses anything else", () => {
    expect(newId("sc")).toMatch(/^sc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId("srch")).toMatch(/^srch_[0-9A-HJKMNP-TV-Z]{26}$/);

    for (const prefix of ["", "b", "BKG", "bkg_", "bk1", "booking", "bk-g", " bkg", "bkg\n"]) {
      expect(() => newId(prefix as IdPrefix<"bkg">), JSON.stringify(prefix)).toThrow(TypeError);
    }
    expect(() => newId(undefined as unknown as IdPrefix<"bkg">)).toThrow(TypeError);
  });

  it("refuses an invalid now instead of silently using the current time", () => {
    for (const now of [new Date(Number.NaN), new Date(0), new Date(-1), new Date(2 ** 48)]) {
      expect(() => newId("bkg", now), String(now.getTime())).toThrow(TypeError);
    }
    expect(() => newId("bkg", 1_760_000_000_000 as unknown as Date)).toThrow(TypeError);
  });

  it("checks prefixes at compile time with IdPrefix", () => {
    expectTypeOf<IdPrefix<"bkg">>().toEqualTypeOf<"bkg">();
    expectTypeOf<IdPrefix<"sc">>().toEqualTypeOf<"sc">();
    expectTypeOf<IdPrefix<"srch">>().toEqualTypeOf<"srch">();
    expectTypeOf<IdPrefix<"bkg" | "ten">>().toEqualTypeOf<"bkg" | "ten">();
    expectTypeOf<IdPrefix<"bkg" | "BKG">>().toEqualTypeOf<"bkg">();
    expectTypeOf<IdPrefix<"BKG">>().toEqualTypeOf<never>();
    expectTypeOf<IdPrefix<"b">>().toEqualTypeOf<never>();
    expectTypeOf<IdPrefix<"booking">>().toEqualTypeOf<never>();
    expectTypeOf<IdPrefix<"bk_">>().toEqualTypeOf<never>();
    expectTypeOf<IdPrefix<"bk1">>().toEqualTypeOf<never>();
    expectTypeOf<IdPrefix<string>>().toEqualTypeOf<never>();

    // An application's own id generator can wrap newId and keep the compile-time check.
    const generator = { new: <P extends string>(prefix: IdPrefix<P>): string => newId(prefix) };
    expect(generator.new("ten")).toMatch(/^ten_[0-9A-HJKMNP-TV-Z]{26}$/);

    // @ts-expect-error upper-case letters are not a prefix
    expect(() => newId("BKG")).toThrow(TypeError);
    // @ts-expect-error a prefix has at most 4 letters
    expect(() => generator.new("booking")).toThrow(TypeError);
  });
});
