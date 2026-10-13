// Result type parsers of every pool (ADR-0005 item 5): numeric and int8 stay strings, timestamptz becomes a
// Date, json and jsonb are parsed. They live on a per-pool `types` object, so the global `pg.types` is never
// mutated, and a global change made by other code to one of these types (for example
// `setTypeParser(1700, parseFloat)`) never reaches a Velexis pool. Every other type is read through the
// global `pg.types`.
import pg from "pg";

/** PostgreSQL type OIDs with a Velexis parser (`SELECT oid, typname FROM pg_type`). */
export const PG_TYPE_OID = Object.freeze({
  INT8: 20,
  JSON: 114,
  INT8_ARRAY: 1016,
  TIMESTAMPTZ: 1184,
  NUMERIC_ARRAY: 1231,
  NUMERIC: 1700,
  JSONB: 3802,
});

/** A numeric or int8 array: decimal strings (or `null`), nested for multi-dimensional arrays. */
export type DecimalArray = Array<string | null | DecimalArray>;

type TextParser = (value: string) => unknown;

/** Keeps the value exactly as PostgreSQL printed it: money and counters are never JS numbers. */
const asString: TextParser = (value) => value;

const TIMESTAMPTZ_TEXT =
  /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?( BC)?$/;

/**
 * Parses PostgreSQL's ISO text output of a `timestamptz` (`2026-10-13 07:44:00.123456+00`, any offset of
 * the session time zone, years before 100 and BC dates) into a `Date`. Digits beyond the millisecond are
 * truncated, as `Date` cannot hold them. `infinity`, `-infinity`, values outside the `Date` range and other
 * DateStyle settings throw a `RangeError`, which fails the query instead of returning an invalid date.
 */
export function parseTimestamptz(value: string): Date {
  const match = TIMESTAMPTZ_TEXT.exec(value);
  if (match === null) {
    throw new RangeError(`Cannot read the timestamptz value ${JSON.stringify(value)} as a Date`);
  }
  const [, year, month, day, hour, minute, second, fraction, sign, offsetH, offsetM, offsetS, bc] = match;
  const isoYear = bc === undefined ? toInt(year) : 1 - toInt(year); // 1 BC is year 0
  const millis = toInt(`${fraction ?? ""}000`.slice(0, 3));
  const local = new Date(0);
  local.setUTCFullYear(isoYear, toInt(month) - 1, toInt(day));
  local.setUTCHours(toInt(hour), toInt(minute), toInt(second), millis);
  const offsetMs = (toInt(offsetH) * 3600 + toInt(offsetM) * 60 + toInt(offsetS)) * 1000;
  const date = new Date(local.getTime() - (sign === "-" ? -offsetMs : offsetMs));
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`The timestamptz value ${JSON.stringify(value)} is outside the range of a Date`);
  }
  return date;
}

/**
 * Parses the text output of a `numeric[]` or `int8[]` (`{1.50,NULL}`, `{{1,2},{3,4}}`, `[0:1]={1,2}`) into
 * nested arrays of decimal strings. Elements of these types are never quoted by PostgreSQL.
 */
export function parseDecimalArray(value: string): DecimalArray {
  // An explicit lower bound is printed as a dimension decoration before "=".
  const source = value.startsWith("[") ? value.slice(value.indexOf("=") + 1) : value;
  let index = 0;
  const fail = (): never => {
    throw new RangeError(`Cannot read the array value ${JSON.stringify(value)}`);
  };
  const readArray = (): DecimalArray => {
    if (source[index] !== "{") {
      fail();
    }
    index += 1;
    const items: DecimalArray = [];
    if (source[index] === "}") {
      index += 1;
      return items;
    }
    for (;;) {
      if (source[index] === "{") {
        items.push(readArray());
      } else {
        const start = index;
        while (index < source.length && source[index] !== "," && source[index] !== "}") {
          index += 1;
        }
        const element = source.slice(start, index);
        if (element === "" || element.includes("{") || element.includes('"')) {
          fail();
        }
        items.push(element === "NULL" ? null : element);
      }
      if (source[index] === ",") {
        index += 1;
      } else if (source[index] === "}") {
        index += 1;
        return items;
      } else {
        fail();
      }
    }
  };
  const result = readArray();
  if (index !== source.length) {
    fail();
  }
  return result;
}

const VELEXIS_TEXT_PARSERS: ReadonlyMap<number, TextParser> = new Map<number, TextParser>([
  [PG_TYPE_OID.INT8, asString],
  [PG_TYPE_OID.NUMERIC, asString],
  [PG_TYPE_OID.INT8_ARRAY, parseDecimalArray],
  [PG_TYPE_OID.NUMERIC_ARRAY, parseDecimalArray],
  [PG_TYPE_OID.TIMESTAMPTZ, parseTimestamptz],
  [PG_TYPE_OID.JSON, (value) => JSON.parse(value) as unknown],
  [PG_TYPE_OID.JSONB, (value) => JSON.parse(value) as unknown],
]);

/**
 * A fresh `types` object for one pool (`new pg.Pool({ types })`). The Velexis parsers above win for text
 * results; every other type falls back to the global `pg.types` (node-postgres' defaults).
 */
export function createTypeParsers(): pg.CustomTypesConfig {
  return {
    getTypeParser: (oid: number, format?: "text" | "binary") => {
      const parser = format === "binary" ? undefined : VELEXIS_TEXT_PARSERS.get(oid);
      return parser ?? pg.types.getTypeParser(oid, format);
    },
  };
}

function toInt(digits: string | undefined): number {
  return digits === undefined ? 0 : Number.parseInt(digits, 10);
}
