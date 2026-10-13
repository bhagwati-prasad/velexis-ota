import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createTypeParsers, parseDecimalArray, parseTimestamptz, PG_TYPE_OID } from "./type-parsers.js";

describe("parseTimestamptz", () => {
  it.each([
    ["2026-10-13 07:44:00+00", "2026-10-13T07:44:00.000Z"],
    ["2026-10-13 07:44:00.123456+00", "2026-10-13T07:44:00.123Z"],
    ["2026-10-13 07:44:00.5+00", "2026-10-13T07:44:00.500Z"],
    ["2026-10-13 07:44:00.999999+00", "2026-10-13T07:44:00.999Z"],
    ["2026-10-13 13:14:00+05:30", "2026-10-13T07:44:00.000Z"],
    ["2026-10-13 02:44:00-05", "2026-10-13T07:44:00.000Z"],
    ["2026-10-12 21:14:00-10:30", "2026-10-13T07:44:00.000Z"],
    ["1883-11-18 12:00:00-04:56:02", "1883-11-18T16:56:02.000Z"],
    ["2024-02-29 23:59:59+00", "2024-02-29T23:59:59.000Z"],
    ["0099-01-01 00:00:00+00", "0099-01-01T00:00:00.000Z"],
    ["0001-01-01 00:00:00+00 BC", "0000-01-01T00:00:00.000Z"],
    ["0044-03-15 12:00:00+00 BC", "-000043-03-15T12:00:00.000Z"],
    ["12026-01-01 00:00:00+00", "+012026-01-01T00:00:00.000Z"],
  ])("reads %j as %s", (text, iso) => {
    const date = parseTimestamptz(text);
    expect(date).toBeInstanceOf(Date);
    expect(date.toISOString()).toBe(iso);
  });

  it.each([
    "infinity",
    "-infinity",
    "2026-10-13",
    "2026-10-13 07:44:00",
    "2026-10-13T07:44:00Z",
    "Tue Oct 13 07:44:00 2026 UTC",
    "10/13/2026 07:44:00 UTC",
    "294276-12-31 23:59:59+00",
    "",
  ])("throws a RangeError for %j", (text) => {
    expect(() => parseTimestamptz(text)).toThrow(RangeError);
  });
});

describe("parseDecimalArray", () => {
  it.each([
    ["{}", []],
    ["{1.50}", ["1.50"]],
    ["{1.50,2.30,NULL,-0.01}", ["1.50", "2.30", null, "-0.01"]],
    ["{NaN,Infinity,-Infinity}", ["NaN", "Infinity", "-Infinity"]],
    ["{9007199254740993,-9223372036854775808}", ["9007199254740993", "-9223372036854775808"]],
    [
      "{{1,2},{3,4}}",
      [
        ["1", "2"],
        ["3", "4"],
      ],
    ],
    ["{{},{}}", [[], []]],
    ["[0:1]={1,2}", ["1", "2"]],
    [
      "[0:1][1:2]={{1,2},{3,4}}",
      [
        ["1", "2"],
        ["3", "4"],
      ],
    ],
  ])("reads %j", (text, expected) => {
    expect(parseDecimalArray(text)).toEqual(expected);
  });

  it.each(["", "1,2", "{1,2", "{1,,2}", "{1,2}}", '{"1"}', "{1}{2}", "{1,{2}"])(
    "throws a RangeError for %j",
    (text) => {
      expect(() => parseDecimalArray(text)).toThrow(RangeError);
    },
  );
});

describe("createTypeParsers", () => {
  const original = pg.types.getTypeParser(PG_TYPE_OID.NUMERIC, "text");

  afterEach(() => {
    pg.types.setTypeParser(PG_TYPE_OID.NUMERIC, "text", original);
  });

  it("keeps numeric and int8 as strings, reads timestamptz as Date and parses json and jsonb", () => {
    const { getTypeParser } = createTypeParsers();
    const parse = (oid: number, text: string): unknown =>
      (getTypeParser(oid, "text") as (v: string) => unknown)(text);

    expect(parse(PG_TYPE_OID.NUMERIC, "12.30")).toBe("12.30");
    expect(parse(PG_TYPE_OID.INT8, "9007199254740993")).toBe("9007199254740993");
    expect(parse(PG_TYPE_OID.NUMERIC_ARRAY, "{1.50,2.30}")).toEqual(["1.50", "2.30"]);
    expect(parse(PG_TYPE_OID.INT8_ARRAY, "{1,NULL}")).toEqual(["1", null]);
    expect(parse(PG_TYPE_OID.TIMESTAMPTZ, "2026-10-13 07:44:00.123+00")).toEqual(
      new Date("2026-10-13T07:44:00.123Z"),
    );
    expect(parse(PG_TYPE_OID.JSONB, '{"a":[1,"x"]}')).toEqual({ a: [1, "x"] });
    expect(parse(PG_TYPE_OID.JSON, "[true]")).toEqual([true]);
    // Every other type keeps the node-postgres default: int4 is a number, text stays text.
    expect(parse(23, "42")).toBe(42);
    expect(parse(25, "hello")).toBe("hello");
  });

  it("never mutates the global pg.types and ignores global changes for its own types", () => {
    const before = pg.types.getTypeParser(PG_TYPE_OID.NUMERIC, "text");
    const { getTypeParser } = createTypeParsers();
    expect(pg.types.getTypeParser(PG_TYPE_OID.NUMERIC, "text")).toBe(before);

    pg.types.setTypeParser(PG_TYPE_OID.NUMERIC, "text", Number.parseFloat);
    expect((getTypeParser(PG_TYPE_OID.NUMERIC, "text") as (v: string) => unknown)("12.30")).toBe("12.30");
  });

  it("returns a new object for every pool", () => {
    expect(createTypeParsers()).not.toBe(createTypeParsers());
  });
});
