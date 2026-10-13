#!/usr/bin/env node
// @ts-check
// validate.mjs: offline checks of the vendored reference datasets of @velexis/reference-data (task X-017, ADR-0024).
//
// Usage (plain Node 22, no dependencies, no network):
//   node tools/reference-data/scripts/validate.mjs [--data <dir>] [--no-min-rows]
//   (default <dir>: tools/reference-data/data; fetch.mjs runs the same checks before it writes a snapshot and with --check)
//
// It exits 1 and lists every problem when:
//   1. a file is missing, is not UTF-8, has a byte order mark, CR characters, a blank line, no final newline or is
//      not in the canonical CSV form that fetch.mjs writes (header row, comma separator, RFC 4180 quoting only
//      where needed);
//   2. the header is not exactly the column list of the table in docs/velexis-sdk/db/reference.sql (without
//      created_at and updated_at, which the loader sets);
//   3. a value breaks the column type or a CHECK constraint (code regexes, latitude and longitude ranges, the kind,
//      alliance, body type and continent lists), a NOT NULL column is empty, or a text has control characters,
//      surrounding spaces or is not in Unicode NFC;
//   4. keys are not unique or not sorted, or a UNIQUE column (countries.alpha3, airports.icao_code,
//      airlines.icao_code) repeats a value;
//   5. a foreign key does not resolve inside the files (for example airport -> city, country, time zone);
//   6. overrides.csv (table,key,column,value) names an unknown table, column or key, changes a key, or its value
//      breaks the column rules; foreign keys and UNIQUE columns are checked after the overrides are applied;
//   7. a table has fewer rows than its plausibility minimum (MIN_ROWS; skipped with --no-min-rows).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_DATA_DIR = path.join(PACKAGE_DIR, "data");

/**
 * One column of a dataset. `type` is the PostgreSQL type family; `pattern`, `values`, `min` and `max` mirror the
 * CHECK constraints and the type limits of reference.sql; `ref` is a foreign key to another table's key.
 * @typedef {{
 *   name: string,
 *   type: "text" | "int" | "smallint" | "numeric" | "bool",
 *   required?: boolean,
 *   pattern?: RegExp,
 *   values?: readonly string[],
 *   min?: number,
 *   max?: number,
 *   ref?: TableName,
 *   unique?: boolean,
 * }} Column
 * @typedef {"currencies" | "countries" | "time_zones" | "cities" | "airports" | "airlines" | "aircraft"} TableName
 * @typedef {{ file: string, key: string, columns: readonly Column[] }} Table
 */

const LATITUDE = /** @type {const} */ ({ type: "numeric", min: -90, max: 90 });
const LONGITUDE = /** @type {const} */ ({ type: "numeric", min: -180, max: 180 });
/** Sanity range of a UTC offset in minutes (the real ones run from -12:00 to +14:00). */
const OFFSET = /** @type {const} */ ({ type: "int", min: -18 * 60, max: 18 * 60 });

/** @type {Record<TableName, Table>} The seven tables of reference.sql, in foreign-key (load) order. */
export const TABLES = {
  currencies: {
    file: "currencies.csv",
    key: "code",
    columns: [
      { name: "code", type: "text", required: true, pattern: /^[A-Z]{3}$/ },
      { name: "numeric_code", type: "text", pattern: /^[0-9]{3}$/ },
      { name: "name", type: "text", required: true },
      { name: "symbol", type: "text" },
      { name: "minor_units", type: "smallint", required: true, min: 0, max: 4 },
      { name: "is_active", type: "bool", required: true },
    ],
  },
  countries: {
    file: "countries.csv",
    key: "code",
    columns: [
      { name: "code", type: "text", required: true, pattern: /^[A-Z]{2}$/ },
      { name: "alpha3", type: "text", pattern: /^[A-Z]{3}$/, unique: true },
      { name: "numeric_code", type: "text", pattern: /^[0-9]{3}$/ },
      { name: "name", type: "text", required: true },
      { name: "official_name", type: "text" },
      { name: "continent_code", type: "text", values: ["AF", "AN", "AS", "EU", "NA", "OC", "SA"] },
      { name: "currency_code", type: "text", pattern: /^[A-Z]{3}$/, ref: "currencies" },
      { name: "calling_code", type: "text", pattern: /^[0-9]{1,4}$/ },
      { name: "is_eu", type: "bool", required: true },
    ],
  },
  time_zones: {
    file: "time_zones.csv",
    key: "name",
    columns: [
      { name: "name", type: "text", required: true, pattern: /^[A-Za-z][A-Za-z0-9_+\-/]*$/ },
      { name: "country_code", type: "text", pattern: /^[A-Z]{2}$/, ref: "countries" },
      { name: "utc_offset_minutes", ...OFFSET, required: true },
      { name: "dst_offset_minutes", ...OFFSET },
    ],
  },
  cities: {
    file: "cities.csv",
    key: "iata_code",
    columns: [
      { name: "iata_code", type: "text", required: true, pattern: /^[A-Z]{3}$/ },
      { name: "name", type: "text", required: true },
      { name: "country_code", type: "text", required: true, pattern: /^[A-Z]{2}$/, ref: "countries" },
      { name: "state_code", type: "text" },
      { name: "time_zone", type: "text", ref: "time_zones" },
      { name: "latitude", ...LATITUDE },
      { name: "longitude", ...LONGITUDE },
      { name: "search_rank", type: "int", required: true },
    ],
  },
  airports: {
    file: "airports.csv",
    key: "iata_code",
    columns: [
      { name: "iata_code", type: "text", required: true, pattern: /^[A-Z]{3}$/ },
      { name: "icao_code", type: "text", pattern: /^[A-Z0-9]{4}$/, unique: true },
      { name: "name", type: "text", required: true },
      { name: "city_code", type: "text", pattern: /^[A-Z]{3}$/, ref: "cities" },
      { name: "city_name", type: "text" },
      { name: "country_code", type: "text", required: true, pattern: /^[A-Z]{2}$/, ref: "countries" },
      { name: "time_zone", type: "text", ref: "time_zones" },
      { name: "latitude", ...LATITUDE },
      { name: "longitude", ...LONGITUDE },
      { name: "elevation_ft", type: "int" },
      {
        name: "kind",
        type: "text",
        required: true,
        values: ["airport", "heliport", "rail_station", "bus_station", "seaplane_base"],
      },
      { name: "is_active", type: "bool", required: true },
      { name: "search_rank", type: "int", required: true },
    ],
  },
  airlines: {
    file: "airlines.csv",
    key: "iata_code",
    columns: [
      { name: "iata_code", type: "text", required: true, pattern: /^[A-Z0-9]{2}$/ },
      { name: "icao_code", type: "text", pattern: /^[A-Z]{3}$/, unique: true },
      { name: "name", type: "text", required: true },
      { name: "common_name", type: "text" },
      { name: "country_code", type: "text", pattern: /^[A-Z]{2}$/, ref: "countries" },
      { name: "accounting_code", type: "text", pattern: /^[0-9]{3}$/ },
      { name: "alliance", type: "text", values: ["star_alliance", "oneworld", "skyteam"] },
      { name: "is_low_cost", type: "bool", required: true },
      { name: "is_active", type: "bool", required: true },
      { name: "logo_url", type: "text" },
    ],
  },
  aircraft: {
    file: "aircraft.csv",
    key: "iata_code",
    columns: [
      { name: "iata_code", type: "text", required: true, pattern: /^[A-Z0-9]{3}$/ },
      { name: "icao_code", type: "text", pattern: /^[A-Z0-9]{2,4}$/ },
      { name: "name", type: "text", required: true },
      { name: "manufacturer", type: "text" },
      {
        name: "body_type",
        type: "text",
        values: ["narrow", "wide", "regional", "turboprop", "helicopter", "other"],
      },
    ],
  },
};

/** @type {readonly TableName[]} Foreign-key order: the loader (X-018) inserts the tables in this order. */
export const LOAD_ORDER = /** @type {TableName[]} */ (Object.keys(TABLES));

export const OVERRIDES_FILE = "overrides.csv";
export const OVERRIDES_HEADER = ["table", "key", "column", "value"];

/** Plausibility minimums (task X-017 acceptance): a broken download or filter shows up as a short table. */
export const MIN_ROWS = /** @type {const} */ ({
  currencies: 150,
  countries: 240,
  time_zones: 300,
  cities: 5000,
  airports: 8000,
  airlines: 700,
  aircraft: 200,
});

const INT_RANGE = { int: [-2147483648, 2147483647], smallint: [-32768, 32767] };
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
// numeric(9,6): at most 3 integer digits and 6 decimals.
const NUMERIC_9_6 = /^-?(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,6})?$/;
// eslint-disable-next-line no-control-regex -- the point is to find control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// ---- CSV ------------------------------------------------------------------------------------------------

/**
 * Parse RFC 4180 CSV with LF record separators (a final LF ends the last record).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let record = [];
  let field = "";
  let line = 1;
  let i = 0;
  let quoted = false;
  let atFieldStart = true;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i += 1;
        if (i < text.length && text[i] !== "," && text[i] !== "\n") {
          throw new Error(`line ${line}: text after a closing quote`);
        }
        continue;
      }
      if (c === "\n") {
        line += 1;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (!atFieldStart) {
        throw new Error(`line ${line}: quote inside an unquoted field`);
      }
      quoted = true;
      atFieldStart = false;
      i += 1;
      continue;
    }
    if (c === ",") {
      record.push(field);
      field = "";
      atFieldStart = true;
      i += 1;
      continue;
    }
    if (c === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      atFieldStart = true;
      line += 1;
      i += 1;
      continue;
    }
    field += c;
    atFieldStart = false;
    i += 1;
  }
  if (quoted) {
    throw new Error(`line ${line}: unterminated quoted field`);
  }
  if (!atFieldStart || field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** @param {string} value */
const quoteCsv = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * The canonical CSV text of fetch.mjs: comma separator, quotes only where needed, LF, final newline.
 * @param {readonly (readonly string[])[]} records
 */
export const formatCsv = (records) => records.map((r) => r.map(quoteCsv).join(",")).join("\n") + "\n";

// ---- Values ---------------------------------------------------------------------------------------------

/**
 * Why `value` (the raw CSV text; "" is NULL) does not fit `column`, or null when it fits.
 * @param {Column} column
 * @param {string} value
 * @returns {string | null}
 */
export function valueProblem(column, value) {
  if (value === "") {
    return column.required ? "is empty but the column is NOT NULL" : null;
  }
  switch (column.type) {
    case "bool":
      return value === "true" || value === "false" ? null : `${JSON.stringify(value)} is not true or false`;
    case "int":
    case "smallint": {
      if (!INTEGER.test(value)) {
        return `${JSON.stringify(value)} is not an integer`;
      }
      const [lo, hi] = INT_RANGE[column.type];
      const n = Number(value);
      if (n < Math.max(lo, column.min ?? lo) || n > Math.min(hi, column.max ?? hi)) {
        return `${value} is outside ${Math.max(lo, column.min ?? lo)}..${Math.min(hi, column.max ?? hi)}`;
      }
      return null;
    }
    case "numeric": {
      if (!NUMERIC_9_6.test(value)) {
        return `${JSON.stringify(value)} is not a numeric(9,6) value`;
      }
      const n = Number(value);
      if ((column.min !== undefined && n < column.min) || (column.max !== undefined && n > column.max)) {
        return `${value} is outside ${column.min}..${column.max}`;
      }
      return null;
    }
    case "text":
      if (CONTROL.test(value)) {
        return `${JSON.stringify(value)} contains a control character`;
      }
      if (value !== value.trim()) {
        return `${JSON.stringify(value)} has leading or trailing spaces`;
      }
      if (value !== value.normalize("NFC")) {
        return `${JSON.stringify(value)} is not in Unicode NFC`;
      }
      if (column.pattern && !column.pattern.test(value)) {
        return `${JSON.stringify(value)} does not match ${column.pattern}`;
      }
      if (column.values && !column.values.includes(value)) {
        return `${JSON.stringify(value)} is not one of ${column.values.join(", ")}`;
      }
      return null;
    default:
      return `unknown column type ${String(/** @type {Column} */ (column).type)}`;
  }
}

// ---- Files and tables -----------------------------------------------------------------------------------

/**
 * Read a data file as text, or report why it cannot be used.
 * @param {string} name file name, for messages
 * @param {Uint8Array | string | undefined} content
 * @param {string[]} problems
 * @returns {string[][] | null} the parsed records, header included
 */
function readCsvFile(name, content, problems) {
  if (content === undefined) {
    problems.push(`${name}: missing`);
    return null;
  }
  let text;
  try {
    text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    problems.push(`${name}: not valid UTF-8`);
    return null;
  }
  const before = problems.length;
  if (text.startsWith("\uFEFF")) {
    problems.push(`${name}: starts with a byte order mark`);
  }
  if (text.includes("\r")) {
    problems.push(`${name}: has CR characters; line endings must be LF`);
  }
  if (!text.endsWith("\n")) {
    problems.push(`${name}: does not end with a newline`);
  }
  if (text.startsWith("\n") || text.includes("\n\n")) {
    problems.push(`${name}: has a blank line`);
  }
  if (problems.length > before) {
    return null;
  }
  let records;
  try {
    records = parseCsv(text);
  } catch (err) {
    problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (records.length === 0) {
    problems.push(`${name}: empty (no header row)`);
    return null;
  }
  if (formatCsv(records) !== text) {
    problems.push(`${name}: not in the canonical CSV form of fetch.mjs (needless quotes)`);
    return null;
  }
  return records;
}

/**
 * @typedef {{ table: TableName, rows: Map<string, string[]> }} LoadedTable
 */

/**
 * Check one dataset file on its own: header, values, sorted unique keys. Returns its rows by key.
 * @param {TableName} tableName
 * @param {string[][]} records
 * @param {string[]} problems
 * @returns {Map<string, string[]>}
 */
function checkTableFile(tableName, records, problems) {
  const table = TABLES[tableName];
  const expected = table.columns.map((c) => c.name);
  const [header, ...rows] = records;
  /** @type {Map<string, string[]>} */
  const byKey = new Map();
  if (header.join(",") !== expected.join(",")) {
    problems.push(
      `${table.file}:1: header ${JSON.stringify(header.join(","))} is not ${JSON.stringify(expected.join(","))}`,
    );
    return byKey;
  }
  const keyIndex = expected.indexOf(table.key);
  /** @type {string | null} */
  let previousKey = null;
  rows.forEach((row, i) => {
    const line = i + 2;
    if (row.length !== expected.length) {
      problems.push(`${table.file}:${line}: ${row.length} fields, expected ${expected.length}`);
      return;
    }
    table.columns.forEach((column, j) => {
      const problem = valueProblem(column, row[j]);
      if (problem) {
        problems.push(`${table.file}:${line}: ${column.name} ${problem}`);
      }
    });
    const key = row[keyIndex];
    if (previousKey !== null && !(key > previousKey)) {
      problems.push(
        key === previousKey
          ? `${table.file}:${line}: duplicate key ${JSON.stringify(key)}`
          : `${table.file}:${line}: key ${JSON.stringify(key)} is not sorted (after ${JSON.stringify(previousKey)})`,
      );
    }
    previousKey = key;
    if (!byKey.has(key)) {
      byKey.set(key, row);
    }
  });
  return byKey;
}

/**
 * Check overrides.csv and apply it to the loaded rows (in place), so that foreign keys and UNIQUE columns are
 * checked on the data the loader will produce.
 * @param {string[][]} records
 * @param {Partial<Record<TableName, Map<string, string[]>>>} loaded
 * @param {string[]} problems
 * @returns {number} the number of override rows
 */
function applyOverrides(records, loaded, problems) {
  const [header, ...rows] = records;
  if (header.join(",") !== OVERRIDES_HEADER.join(",")) {
    problems.push(
      `${OVERRIDES_FILE}:1: header ${JSON.stringify(header.join(","))} is not ${JSON.stringify(OVERRIDES_HEADER.join(","))}`,
    );
    return 0;
  }
  const seen = new Set();
  rows.forEach((row, i) => {
    const where = `${OVERRIDES_FILE}:${i + 2}`;
    if (row.length !== OVERRIDES_HEADER.length) {
      problems.push(`${where}: ${row.length} fields, expected ${OVERRIDES_HEADER.length}`);
      return;
    }
    const [tableName, key, columnName, value] = row;
    if (!Object.hasOwn(TABLES, tableName)) {
      problems.push(`${where}: unknown table ${JSON.stringify(tableName)} (one of ${LOAD_ORDER.join(", ")})`);
      return;
    }
    const table = TABLES[/** @type {TableName} */ (tableName)];
    const columnIndex = table.columns.findIndex((c) => c.name === columnName);
    if (columnIndex < 0) {
      problems.push(`${where}: unknown column ${JSON.stringify(columnName)} of ${tableName}`);
      return;
    }
    if (columnName === table.key) {
      problems.push(`${where}: the key column ${columnName} cannot be overridden`);
      return;
    }
    const id = `${tableName}\u0000${key}\u0000${columnName}`;
    if (seen.has(id)) {
      problems.push(`${where}: ${tableName}.${columnName} of ${JSON.stringify(key)} is overridden twice`);
      return;
    }
    seen.add(id);
    const problem = valueProblem(table.columns[columnIndex], value);
    if (problem) {
      problems.push(`${where}: value ${problem}`);
      return;
    }
    const target = loaded[/** @type {TableName} */ (tableName)]?.get(key);
    if (!target) {
      problems.push(`${where}: ${tableName} has no row with key ${JSON.stringify(key)}`);
      return;
    }
    target[columnIndex] = value;
  });
  return rows.length;
}

/**
 * Foreign keys and UNIQUE columns across the (overridden) tables.
 * @param {Partial<Record<TableName, Map<string, string[]>>>} loaded
 * @param {string[]} problems
 */
function checkRelations(loaded, problems) {
  for (const tableName of LOAD_ORDER) {
    const rows = loaded[tableName];
    if (!rows) {
      continue;
    }
    const table = TABLES[tableName];
    table.columns.forEach((column, j) => {
      /** @type {Map<string, string>} */
      const uniqueValues = new Map();
      for (const [key, row] of rows) {
        const value = row[j];
        if (value === "") {
          continue;
        }
        if (column.ref) {
          const target = loaded[column.ref];
          if (target && !target.has(value)) {
            problems.push(
              `${table.file}: ${table.key} ${JSON.stringify(key)}: ${column.name} ${JSON.stringify(value)} ` +
                `is not in ${TABLES[column.ref].file}`,
            );
          }
        }
        if (column.unique) {
          const other = uniqueValues.get(value);
          if (other !== undefined) {
            problems.push(
              `${table.file}: ${column.name} ${JSON.stringify(value)} is used by ${JSON.stringify(other)} ` +
                `and ${JSON.stringify(key)} (UNIQUE)`,
            );
          } else {
            uniqueValues.set(value, key);
          }
        }
      }
    });
  }
}

/**
 * @typedef {{ minRows?: Partial<Record<TableName, number>> | null }} ValidateOptions
 * @typedef {{ problems: string[], counts: Partial<Record<TableName, number>>, overrides: number }} ValidateResult
 */

/**
 * Validate a full set of data files given as file name -> content (bytes or text). Missing files are problems.
 * @param {Record<string, Uint8Array | string | undefined>} files
 * @param {ValidateOptions} [options]
 * @returns {ValidateResult}
 */
export function validateData(files, options = {}) {
  const minRows = options.minRows === undefined ? MIN_ROWS : options.minRows;
  /** @type {string[]} */
  const problems = [];
  /** @type {Partial<Record<TableName, Map<string, string[]>>>} */
  const loaded = {};
  /** @type {Partial<Record<TableName, number>>} */
  const counts = {};
  for (const tableName of LOAD_ORDER) {
    const { file } = TABLES[tableName];
    const records = readCsvFile(file, files[file], problems);
    if (!records) {
      continue;
    }
    loaded[tableName] = checkTableFile(tableName, records, problems);
    counts[tableName] = records.length - 1;
    const minimum = minRows?.[tableName];
    if (minimum !== undefined && records.length - 1 < minimum) {
      problems.push(`${file}: ${records.length - 1} rows, fewer than the plausible minimum of ${minimum}`);
    }
  }
  let overrides = 0;
  const overrideRecords = readCsvFile(OVERRIDES_FILE, files[OVERRIDES_FILE], problems);
  if (overrideRecords) {
    overrides = applyOverrides(overrideRecords, loaded, problems);
  }
  checkRelations(loaded, problems);
  return { problems, counts, overrides };
}

/** The file names validateData reads: the seven datasets and overrides.csv. */
export const DATA_FILES = [...LOAD_ORDER.map((t) => TABLES[t].file), OVERRIDES_FILE];

/**
 * Read and validate the data files of a directory.
 * @param {string} dir
 * @param {ValidateOptions} [options]
 * @returns {ValidateResult}
 */
export function validateDataDir(dir, options) {
  /** @type {Record<string, Uint8Array | undefined>} */
  const files = {};
  for (const name of DATA_FILES) {
    const file = path.join(dir, name);
    files[name] = existsSync(file) ? readFileSync(file) : undefined;
  }
  return validateData(files, options);
}

/**
 * Print a validation result; returns the process exit code.
 * @param {ValidateResult} result
 * @param {string} label
 */
export function reportValidation(result, label) {
  const shown = result.problems.slice(0, 100);
  for (const problem of shown) {
    console.error(`  ✗ ${problem}`);
  }
  if (result.problems.length > shown.length) {
    console.error(`  … and ${result.problems.length - shown.length} more problems`);
  }
  const counts = LOAD_ORDER.map((t) => `${t} ${result.counts[t] ?? "-"}`).join(", ");
  console.log(`${label}: ${counts}; overrides ${result.overrides}`);
  if (result.problems.length > 0) {
    console.error(`${label}: ${result.problems.length} problem(s)`);
    return 1;
  }
  console.log(`${label}: OK`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: { data: { type: "string" }, "no-min-rows": { type: "boolean", default: false } },
  });
  const dir = path.resolve(values.data ?? DEFAULT_DATA_DIR);
  const result = validateDataDir(dir, values["no-min-rows"] ? { minRows: null } : {});
  process.exitCode = reportValidation(result, `validate ${path.relative(process.cwd(), dir) || "."}`);
}
