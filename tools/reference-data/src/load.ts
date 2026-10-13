// loadReferenceData: upserts the vendored datasets of data/ into the `reference` schema (task X-018, ADR-0024).
//
// It reads and checks every file before it connects, then runs one transaction as the DSN's role (the platform
// role velexis_platform_app, which has DML on `reference`; ADR-0004). Per table, in foreign-key order:
//   1. release: a UNIQUE code (countries.alpha3, airports.icao_code, airlines.icao_code) that the file now gives to
//      another key is cleared on the row that holds it, so a code that moved between rows never breaks the UNIQUE
//      constraint in the middle of the upsert;
//   2. upsert: INSERT ... ON CONFLICT (<key>) DO UPDATE SET ..., updated_at = now() WHERE the row changed;
//   3. deactivate: the codes missing from the file get is_active = false where the table has that column.
// Rows are never deleted: tenant rows reference the codes by value. The values of overrides.csv replace the file
// values before the upsert, so they win over the files and a second run still changes nothing. Every SQL
// statement is schema-qualified; the loader never sets search_path.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { CsvError, parseCsvFile, type CsvTable } from "./csv.js";

/** The seven tables of docs/velexis-sdk/db/reference.sql in foreign-key order, the order of the load. */
export const LOAD_ORDER = [
  "currencies",
  "countries",
  "time_zones",
  "cities",
  "airports",
  "airlines",
  "aircraft",
] as const;
export type ReferenceTable = (typeof LOAD_ORDER)[number];

/** How one table is loaded. Every name is a constant of this file, never read from a data file. */
export interface ReferenceTableSpec {
  /** The dataset file in the data folder. */
  readonly file: string;
  /** The primary key: a natural code (ISO, IANA or IATA). */
  readonly key: string;
  /** The header of the file and the loaded columns: the DDL columns in order, without created_at and updated_at. */
  readonly columns: readonly string[];
  /** The UNIQUE columns besides the key (all nullable), released before the upsert. */
  readonly unique: readonly string[];
  /** True when the table has is_active, so the codes missing from the file are deactivated. */
  readonly deactivates: boolean;
}

function spec(file: string, columns: readonly string[], unique: readonly string[] = []): ReferenceTableSpec {
  const [key] = columns;
  if (key === undefined) {
    throw new TypeError(`${file}: a table needs at least its key column`);
  }
  return Object.freeze({
    file,
    key,
    columns: Object.freeze([...columns]),
    unique: Object.freeze([...unique]),
    deactivates: columns.includes("is_active"),
  });
}

/** The tables as reference.sql defines them (a unit test compares the two). The key is the first column. */
export const REFERENCE_TABLES: Readonly<Record<ReferenceTable, ReferenceTableSpec>> = Object.freeze({
  currencies: spec("currencies.csv", ["code", "numeric_code", "name", "symbol", "minor_units", "is_active"]),
  countries: spec(
    "countries.csv",
    [
      "code",
      "alpha3",
      "numeric_code",
      "name",
      "official_name",
      "continent_code",
      "currency_code",
      "calling_code",
      "is_eu",
    ],
    ["alpha3"],
  ),
  time_zones: spec("time_zones.csv", ["name", "country_code", "utc_offset_minutes", "dst_offset_minutes"]),
  cities: spec("cities.csv", [
    "iata_code",
    "name",
    "country_code",
    "state_code",
    "time_zone",
    "latitude",
    "longitude",
    "search_rank",
  ]),
  airports: spec(
    "airports.csv",
    [
      "iata_code",
      "icao_code",
      "name",
      "city_code",
      "city_name",
      "country_code",
      "time_zone",
      "latitude",
      "longitude",
      "elevation_ft",
      "kind",
      "is_active",
      "search_rank",
    ],
    ["icao_code"],
  ),
  airlines: spec(
    "airlines.csv",
    [
      "iata_code",
      "icao_code",
      "name",
      "common_name",
      "country_code",
      "accounting_code",
      "alliance",
      "is_low_cost",
      "is_active",
      "logo_url",
    ],
    ["icao_code"],
  ),
  aircraft: spec("aircraft.csv", ["iata_code", "icao_code", "name", "manufacturer", "body_type"]),
});

/** Manual fixes between two snapshots: one changed value per line (README "Overrides"). */
export const OVERRIDES_FILE = "overrides.csv";
export const OVERRIDES_HEADER: readonly string[] = Object.freeze(["table", "key", "column", "value"]);

/** The schema the loader writes. Constant: tenants and the platform schema are never touched. */
const SCHEMA = "reference";

/** `lock_timeout` of the load transaction: a lock held elsewhere fails the load instead of stalling a deploy. */
export const LOAD_LOCK_TIMEOUT = "10s";
/** `statement_timeout` of each statement of the load (a full load takes seconds). */
export const LOAD_STATEMENT_TIMEOUT = "5min";
/** Key of the transaction advisory lock that serializes two loads of the same database. */
export const LOAD_ADVISORY_LOCK = "velexis:reference-data";
/** `application_name` of the loader's connection unless the caller passes another one. */
export const DEFAULT_APPLICATION_NAME = "velexis-reference-loader";

/** One row as the loader sends it: column name → the CSV text, or null for an empty field. */
export type ReferenceRow = Readonly<Record<string, string | null>>;

/** The datasets of a data folder, checked and with the overrides applied. */
export interface ReferenceDataSet {
  /** The rows of each table, in file order. */
  readonly tables: Readonly<Record<ReferenceTable, readonly ReferenceRow[]>>;
  /** The number of values taken from overrides.csv. */
  readonly overrides: number;
}

/** A data folder the loader refuses before it connects: a missing or malformed file, a bad override. */
export class ReferenceDataError extends Error {
  override readonly name = "ReferenceDataError";
}

/** Changes of one table in one run. Each changed row counts once. */
export interface TableCounts {
  /** Codes of the file that were not in the table. */
  readonly inserted: number;
  /** Existing rows whose values changed, including a row whose UNIQUE code moved to another row. */
  readonly updated: number;
  /** Active rows whose code is missing from the file, now is_active = false. */
  readonly deactivated: number;
}

export interface LoadReferenceDataOptions {
  /** DSN of the role that loads: velexis_platform_app (DML on `reference`). Never logged. */
  readonly url: string;
  /** The folder with the seven dataset files and overrides.csv (the package's `data/`). */
  readonly dataDir: string;
  /** `application_name` of the connection. Default `velexis-reference-loader`. */
  readonly applicationName?: string | undefined;
}

export interface LoadReferenceDataResult {
  /** Counts per table, in load order. */
  readonly tables: Readonly<Record<ReferenceTable, TableCounts>>;
  /** The number of values taken from overrides.csv. */
  readonly overrides: number;
  /** Wall time of the run (files, connection and transaction) in milliseconds. */
  readonly durationMs: number;
}

/**
 * A statement of the load failed; the transaction was rolled back, so nothing changed. `code` is PostgreSQL's
 * SQLSTATE (`42501` when the role may not write `reference`), and `cause` the driver's error.
 */
export class ReferenceLoadError extends Error {
  override readonly name = "ReferenceLoadError";
  readonly table: ReferenceTable;
  readonly code: string | undefined;

  constructor(table: ReferenceTable, step: string, cause: unknown) {
    const { message, code, detail } = (cause ?? {}) as {
      message?: unknown;
      code?: unknown;
      detail?: unknown;
    };
    const text = typeof message === "string" && message !== "" ? message : String(cause);
    const extra = typeof detail === "string" && detail !== "" ? ` (${detail})` : "";
    super(`${step} of ${SCHEMA}.${table} failed: ${text}${extra}`, { cause });
    this.table = table;
    this.code = typeof code === "string" ? code : undefined;
  }
}

export function isReferenceTable(name: string): name is ReferenceTable {
  return (LOAD_ORDER as readonly string[]).includes(name);
}

async function readDataFile(dir: string, file: string): Promise<CsvTable> {
  let content: Buffer;
  try {
    content = await readFile(join(dir, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReferenceDataError(`${file}: missing in ${dir}`);
    }
    throw error;
  }
  try {
    return parseCsvFile(file, content);
  } catch (error) {
    if (error instanceof CsvError) {
      throw new ReferenceDataError(error.message, { cause: error });
    }
    throw error;
  }
}

function expectHeader(file: string, header: readonly string[], expected: readonly string[]): void {
  if (header.join(",") !== expected.join(",")) {
    throw new ReferenceDataError(
      `${file}:1: header ${JSON.stringify(header.join(","))} is not ${JSON.stringify(expected.join(","))}`,
    );
  }
}

type MutableRow = Record<string, string | null>;

function readRows(table: ReferenceTable, csv: CsvTable): Map<string, MutableRow> {
  const { file, key, columns } = REFERENCE_TABLES[table];
  expectHeader(file, csv.header, columns);
  if (csv.rows.length === 0) {
    // Every code of the table would be missing from the file, so every row would be deactivated.
    throw new ReferenceDataError(`${file}: has no rows (a truncated file would deactivate every code)`);
  }
  const rows = new Map<string, MutableRow>();
  csv.rows.forEach((fields, index) => {
    const row: MutableRow = {};
    columns.forEach((column, j) => {
      const value = fields[j] ?? "";
      row[column] = value === "" ? null : value;
    });
    const code = row[key];
    if (code === null || code === undefined) {
      throw new ReferenceDataError(`${file}:${index + 2}: the key ${key} is empty`);
    }
    if (rows.has(code)) {
      throw new ReferenceDataError(`${file}:${index + 2}: duplicate key ${JSON.stringify(code)}`);
    }
    rows.set(code, row);
  });
  return rows;
}

/** Applies overrides.csv to the rows in place; returns the number of values it set. */
function applyOverrides(csv: CsvTable, rows: Record<ReferenceTable, Map<string, MutableRow>>): number {
  expectHeader(OVERRIDES_FILE, csv.header, OVERRIDES_HEADER);
  const seen = new Set<string>();
  csv.rows.forEach((fields, index) => {
    const where = `${OVERRIDES_FILE}:${index + 2}`;
    const [table = "", key = "", column = "", value = ""] = fields;
    if (!isReferenceTable(table)) {
      throw new ReferenceDataError(
        `${where}: unknown table ${JSON.stringify(table)} (one of ${LOAD_ORDER.join(", ")})`,
      );
    }
    const target = REFERENCE_TABLES[table];
    if (!target.columns.includes(column)) {
      throw new ReferenceDataError(`${where}: unknown column ${JSON.stringify(column)} of ${table}`);
    }
    if (column === target.key) {
      throw new ReferenceDataError(`${where}: the key column ${column} cannot be overridden`);
    }
    const id = `${table}\u0000${key}\u0000${column}`;
    if (seen.has(id)) {
      throw new ReferenceDataError(
        `${where}: ${table}.${column} of ${JSON.stringify(key)} is overridden twice`,
      );
    }
    seen.add(id);
    const row = rows[table].get(key);
    if (row === undefined) {
      throw new ReferenceDataError(`${where}: ${target.file} has no row with key ${JSON.stringify(key)}`);
    }
    row[column] = value === "" ? null : value;
  });
  return csv.rows.length;
}

/**
 * Reads the seven dataset files and overrides.csv of `dataDir` and applies the overrides. It checks what the load
 * relies on (the CSV form, the header of each table, one row at least, non-empty unique keys, overrides that name
 * an existing table, column and row) and throws `ReferenceDataError` otherwise. Value types, CHECK constraints and
 * foreign keys are PostgreSQL's job during the load (and scripts/validate.mjs checks them before a snapshot is
 * committed).
 */
export async function readReferenceData(dataDir: string): Promise<ReferenceDataSet> {
  const dir = resolve(dataDir);
  const rows = {} as Record<ReferenceTable, Map<string, MutableRow>>;
  for (const table of LOAD_ORDER) {
    rows[table] = readRows(table, await readDataFile(dir, REFERENCE_TABLES[table].file));
  }
  const overrides = applyOverrides(await readDataFile(dir, OVERRIDES_FILE), rows);
  const tables = {} as Record<ReferenceTable, readonly ReferenceRow[]>;
  for (const table of LOAD_ORDER) {
    tables[table] = Object.freeze([...rows[table].values()].map((row) => Object.freeze(row)));
  }
  return Object.freeze({ tables: Object.freeze(tables), overrides });
}

// ---- SQL ----------------------------------------------------------------------------------------------------
// Each statement takes the table's rows as one jsonb array ($1). jsonb_populate_recordset types every value with
// the table's own column types, so the casts, the CHECK constraints and the comparisons are PostgreSQL's.

const id = (name: string): string => pg.escapeIdentifier(name);
const qualified = (table: ReferenceTable): string => `${id(SCHEMA)}.${id(table)}`;
const incoming = (table: ReferenceTable): string =>
  `jsonb_populate_recordset(NULL::${qualified(table)}, $1::jsonb)`;

/** Clears `column` on the rows that hold a code the file gives to another key; returns their keys. */
export function releaseSql(table: ReferenceTable, column: string): string {
  const { key } = REFERENCE_TABLES[table];
  return (
    `UPDATE ${qualified(table)} AS t SET ${id(column)} = NULL, updated_at = now() ` +
    `FROM ${incoming(table)} AS i ` +
    `WHERE t.${id(column)} = i.${id(column)} AND t.${id(key)} <> i.${id(key)} ` +
    `RETURNING t.${id(key)}::text AS key`
  );
}

/**
 * Inserts the new codes and updates the changed rows; returns one row per inserted or updated code. The outer
 * SELECT runs on the snapshot taken before the INSERT, so a key it cannot find there was inserted.
 */
export function upsertSql(table: ReferenceTable): string {
  const { key, columns } = REFERENCE_TABLES[table];
  const all = columns.map(id).join(", ");
  const values = columns.filter((column) => column !== key).map(id);
  return (
    `WITH upserted AS (` +
    `INSERT INTO ${qualified(table)} AS t (${all}) SELECT ${all} FROM ${incoming(table)} ` +
    `ON CONFLICT (${id(key)}) DO UPDATE SET ` +
    `${values.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}, updated_at = now() ` +
    `WHERE (${values.map((column) => `t.${column}`).join(", ")}) IS DISTINCT FROM ` +
    `(${values.map((column) => `EXCLUDED.${column}`).join(", ")}) ` +
    `RETURNING t.${id(key)}) ` +
    `SELECT u.${id(key)}::text AS key, ` +
    `NOT EXISTS (SELECT 1 FROM ${qualified(table)} AS old WHERE old.${id(key)} = u.${id(key)}) AS inserted ` +
    `FROM upserted AS u`
  );
}

/** Sets is_active = false on the active rows whose code is missing from the file; returns their keys. */
export function deactivateSql(table: ReferenceTable): string {
  const { key } = REFERENCE_TABLES[table];
  return (
    `UPDATE ${qualified(table)} AS t SET is_active = false, updated_at = now() ` +
    `WHERE t.is_active AND NOT EXISTS (SELECT 1 FROM ${incoming(table)} AS i WHERE i.${id(key)} = t.${id(key)}) ` +
    `RETURNING t.${id(key)}::text AS key`
  );
}

async function step<T>(table: ReferenceTable, name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ReferenceLoadError(table, name, error);
  }
}

async function loadTable(
  client: pg.Client,
  table: ReferenceTable,
  rows: readonly ReferenceRow[],
): Promise<TableCounts> {
  const { unique, deactivates } = REFERENCE_TABLES[table];
  const json = JSON.stringify(rows);
  const updated = new Set<string>();
  let inserted = 0;

  for (const column of unique) {
    const released = await step(table, `release of ${column}`, () =>
      client.query<{ key: string }>(releaseSql(table, column), [json]),
    );
    for (const row of released.rows) {
      updated.add(row.key);
    }
  }

  const upserted = await step(table, "upsert", () =>
    client.query<{ key: string; inserted: boolean }>(upsertSql(table), [json]),
  );
  for (const row of upserted.rows) {
    if (row.inserted) {
      inserted += 1;
    } else {
      updated.add(row.key);
    }
  }

  let deactivated = 0;
  if (deactivates) {
    const result = await step(table, "deactivation", () =>
      client.query<{ key: string }>(deactivateSql(table), [json]),
    );
    for (const row of result.rows) {
      // A missing row that also lost a UNIQUE code counts once, as deactivated.
      updated.delete(row.key);
      deactivated += 1;
    }
  }
  return Object.freeze({ inserted, updated: updated.size, deactivated });
}

/**
 * Loads the datasets of `dataDir` into the `reference` schema of `url` in one transaction (ADR-0024 Loader) and
 * returns the counts per table. It is idempotent: a second run with the same files reports zero changes and
 * leaves `updated_at` alone. On any error it rolls back and throws: `ReferenceDataError` for a bad data folder
 * (before connecting), `ReferenceLoadError` for a failed statement, or the driver's error for a failed
 * connection. Errors never contain the DSN.
 */
export async function loadReferenceData(options: LoadReferenceDataOptions): Promise<LoadReferenceDataResult> {
  const started = performance.now();
  const { url, dataDir, applicationName = DEFAULT_APPLICATION_NAME } = options;
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("loadReferenceData: url must be a non-empty postgres:// connection string");
  }
  const data = await readReferenceData(dataDir);

  const client = new pg.Client({ connectionString: url, application_name: applicationName });
  // A connection dropped between queries emits 'error'; the next query rejects, so only keep it from crashing.
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
        [LOAD_LOCK_TIMEOUT, LOAD_STATEMENT_TIMEOUT],
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [LOAD_ADVISORY_LOCK]);
      const tables = {} as Record<ReferenceTable, TableCounts>;
      for (const table of LOAD_ORDER) {
        tables[table] = await loadTable(client, table, data.tables[table]);
      }
      await client.query("COMMIT");
      return Object.freeze({
        tables: Object.freeze(tables),
        overrides: data.overrides,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
