import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CsvError } from "./csv.js";
import {
  deactivateSql,
  LOAD_ORDER,
  loadReferenceData,
  OVERRIDES_FILE,
  OVERRIDES_HEADER,
  readReferenceData,
  ReferenceDataError,
  ReferenceLoadError,
  REFERENCE_TABLES,
  releaseSql,
  upsertSql,
  type ReferenceTable,
} from "./load.js";

const PACKAGE_DIR = resolve(__dirname, "..");
const REFERENCE_SQL = join(PACKAGE_DIR, "..", "..", "docs", "velexis-sdk", "db", "reference.sql");

interface DdlColumn {
  readonly name: string;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly notNull: boolean;
  readonly references: string | undefined;
}

/** The tables of reference.sql in file order, with their columns (one column per line, inline constraints). */
async function ddlTables(): Promise<Map<string, DdlColumn[]>> {
  const ddl = await readFile(REFERENCE_SQL, "utf8");
  const tables = new Map<string, DdlColumn[]>();
  for (const match of ddl.matchAll(/^CREATE TABLE reference\.([a-z_]+) \(\n([\s\S]*?)\n\);/gm)) {
    const columns: DdlColumn[] = [];
    for (const line of (match[2] ?? "").split("\n")) {
      const definition = line.replace(/--.*$/, "");
      const column = /^\s+([a-z_0-9]+)\s/.exec(definition);
      if (column?.[1] === undefined) {
        continue;
      }
      columns.push({
        name: column[1],
        primaryKey: /PRIMARY KEY/.test(definition),
        unique: /\bUNIQUE\b/.test(definition),
        notNull: /NOT NULL/.test(definition),
        references: /REFERENCES reference\.([a-z_]+)/.exec(definition)?.[1],
      });
    }
    tables.set(match[1] ?? "", columns);
  }
  return tables;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A minimal, consistent data set: one or two rows per table. */
const VALID: Readonly<Record<string, readonly string[]>> = {
  "currencies.csv": [
    "code,numeric_code,name,symbol,minor_units,is_active",
    "EUR,978,Euro,€,2,true",
    "USD,840,US Dollar,$,2,true",
  ],
  "countries.csv": [
    "code,alpha3,numeric_code,name,official_name,continent_code,currency_code,calling_code,is_eu",
    "FR,FRA,250,France,,EU,EUR,33,true",
  ],
  "time_zones.csv": ["name,country_code,utc_offset_minutes,dst_offset_minutes", "Europe/Paris,FR,60,120"],
  "cities.csv": [
    "iata_code,name,country_code,state_code,time_zone,latitude,longitude,search_rank",
    "PAR,Paris,FR,,Europe/Paris,48.85341,2.3488,606694",
  ],
  "airports.csv": [
    "iata_code,icao_code,name,city_code,city_name,country_code,time_zone,latitude,longitude,elevation_ft,kind,is_active,search_rank",
    "CDG,LFPG,Paris Charles de Gaulle Airport,PAR,Paris,FR,Europe/Paris,49.01278,2.55,390,airport,true,565101",
    'ORY,LFPO,"Paris Orly Airport, Terminal ""4""",PAR,Paris,FR,Europe/Paris,48.72333,2.37944,291,airport,true,0',
  ],
  "airlines.csv": [
    "iata_code,icao_code,name,common_name,country_code,accounting_code,alliance,is_low_cost,is_active,logo_url",
    "AF,AFR,Air France,,FR,057,skyteam,false,true,",
  ],
  "aircraft.csv": [
    "iata_code,icao_code,name,manufacturer,body_type",
    "320,A320,Airbus A320-100/200,Airbus,narrow",
  ],
  "overrides.csv": ["table,key,column,value"],
};

/** Writes VALID with `changes` (file name -> lines, or null to leave the file out) to a new temporary folder. */
async function dataDir(changes: Record<string, readonly string[] | null> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-reference-unit-"));
  tempDirs.push(dir);
  for (const [file, lines] of Object.entries({ ...VALID, ...changes })) {
    if (lines !== null) {
      await writeFile(join(dir, file), `${lines.join("\n")}\n`);
    }
  }
  return dir;
}

const overrides = (...lines: string[]) => ({ [OVERRIDES_FILE]: [OVERRIDES_HEADER.join(","), ...lines] });

async function refusal(dir: string): Promise<ReferenceDataError> {
  const error = await readReferenceData(dir).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ReferenceDataError);
  return error as ReferenceDataError;
}

describe("the table definitions", () => {
  it("match docs/velexis-sdk/db/reference.sql: tables, columns in order, key, UNIQUE columns and is_active", async () => {
    const ddl = await ddlTables();
    expect([...ddl.keys()]).toEqual([...LOAD_ORDER]);
    for (const table of LOAD_ORDER) {
      const columns = ddl.get(table) ?? [];
      const loaded = columns.filter((column) => column.name !== "created_at" && column.name !== "updated_at");
      const spec = REFERENCE_TABLES[table];
      expect(spec.columns, table).toEqual(loaded.map((column) => column.name));
      expect(columns.filter((column) => column.primaryKey).map((column) => column.name)).toEqual([spec.key]);
      expect(spec.unique, table).toEqual(
        loaded.filter((column) => column.unique).map((column) => column.name),
      );
      // The release step sets a moved UNIQUE code to NULL, so those columns must be nullable.
      for (const column of loaded.filter((c) => c.unique)) {
        expect(column.notNull, `${table}.${column.name}`).toBe(false);
      }
      expect(spec.deactivates, table).toBe(spec.columns.includes("is_active"));
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["created_at", "updated_at"]),
      );
    }
  });

  it("load every table after the tables its foreign keys point to", async () => {
    const ddl = await ddlTables();
    for (const [index, table] of LOAD_ORDER.entries()) {
      for (const column of ddl.get(table) ?? []) {
        if (column.references !== undefined) {
          expect(
            LOAD_ORDER.indexOf(column.references as ReferenceTable),
            `${table}.${column.name}`,
          ).toBeLessThan(index);
        }
      }
    }
  });

  it("are the headers of the committed data files", async () => {
    for (const table of LOAD_ORDER) {
      const { file, columns } = REFERENCE_TABLES[table];
      const text = await readFile(join(PACKAGE_DIR, "data", file), "utf8");
      expect(text.slice(0, text.indexOf("\n")), file).toBe(columns.join(","));
    }
  });
});

describe("readReferenceData", () => {
  it("reads every table with empty fields as null, in file order", async () => {
    const data = await readReferenceData(await dataDir());
    expect(data.overrides).toBe(0);
    expect(Object.keys(data.tables)).toEqual([...LOAD_ORDER]);
    expect(data.tables.countries).toEqual([
      {
        code: "FR",
        alpha3: "FRA",
        numeric_code: "250",
        name: "France",
        official_name: null,
        continent_code: "EU",
        currency_code: "EUR",
        calling_code: "33",
        is_eu: "true",
      },
    ]);
    expect(data.tables.airports.map((row) => [row["iata_code"], row["name"]])).toEqual([
      ["CDG", "Paris Charles de Gaulle Airport"],
      ["ORY", 'Paris Orly Airport, Terminal "4"'],
    ]);
    expect(Object.isFrozen(data.tables.airports[0])).toBe(true);
  });

  it("applies overrides.csv to the rows: a value, or NULL for an empty value", async () => {
    const dir = await dataDir(
      overrides("airports,ORY,name,Orly", "currencies,EUR,symbol,", "airports,CDG,is_active,false"),
    );
    const data = await readReferenceData(dir);
    expect(data.overrides).toBe(3);
    expect(data.tables.airports.map((row) => [row["iata_code"], row["name"], row["is_active"]])).toEqual([
      ["CDG", "Paris Charles de Gaulle Airport", "false"],
      ["ORY", "Orly", "true"],
    ]);
    expect(data.tables.currencies[0]).toMatchObject({ code: "EUR", symbol: null });
  });

  it.each([
    ["a missing file", { "cities.csv": null }, /^cities\.csv: missing in /],
    [
      "a header that is not the table's columns",
      { "aircraft.csv": ["iata_code,name,icao_code,manufacturer,body_type", "320,A,A320,Airbus,narrow"] },
      /^aircraft\.csv:1: header "iata_code,name,icao_code,manufacturer,body_type" is not "iata_code,icao_code,name,manufacturer,body_type"$/,
    ],
    [
      "a table without rows, which would deactivate every code",
      { "airlines.csv": [VALID["airlines.csv"]?.[0] ?? ""] },
      /^airlines\.csv: has no rows/,
    ],
    [
      "a duplicate key",
      { "currencies.csv": [...(VALID["currencies.csv"] ?? []), "EUR,978,Euro again,€,2,true"] },
      /^currencies\.csv:4: duplicate key "EUR"$/,
    ],
    [
      "an empty key",
      { "time_zones.csv": ["name,country_code,utc_offset_minutes,dst_offset_minutes", ",FR,60,120"] },
      /^time_zones\.csv:2: the key name is empty$/,
    ],
    [
      "a malformed CSV file",
      { "cities.csv": ["iata_code,name", "PAR"] },
      /^cities\.csv:2: 1 fields, expected 2$/,
    ],
    [
      "an overrides header that is wrong",
      { [OVERRIDES_FILE]: ["table,key,value"] },
      /^overrides\.csv:1: header/,
    ],
    [
      "an override of an unknown table",
      overrides("hotels,X,name,Y"),
      /^overrides\.csv:2: unknown table "hotels"/,
    ],
    [
      "an override of an unknown column",
      overrides("airports,CDG,iata,Y"),
      /unknown column "iata" of airports$/,
    ],
    ["an override of a key", overrides("airports,CDG,iata_code,XXX"), /the key column iata_code cannot be/],
    [
      "an override of a missing row",
      overrides("airports,XXX,name,Y"),
      /airports\.csv has no row with key "XXX"$/,
    ],
    [
      "two overrides of the same value",
      overrides("airports,CDG,name,A", "airports,CDG,name,B"),
      /^overrides\.csv:3: airports\.name of "CDG" is overridden twice$/,
    ],
  ])("refuses a folder with %s", async (_, changes, message) => {
    const error = await refusal(await dataDir(changes));
    expect(error.message).toMatch(message);
  });

  it("keeps the CSV error as the cause", async () => {
    const error = await refusal(await dataDir({ "aircraft.csv": ["iata_code", '"320'] }));
    expect(error.cause).toBeInstanceOf(CsvError);
  });
});

describe("the SQL of the load", () => {
  const all = LOAD_ORDER.flatMap((table) => [
    upsertSql(table),
    deactivateSql(table),
    ...REFERENCE_TABLES[table].unique.map((column) => releaseSql(table, column)),
  ]);

  it("names the reference schema on every table and never sets search_path", () => {
    for (const sql of all) {
      expect(sql).not.toMatch(/search_path/i);
      for (const match of sql.matchAll(/\b(?:INTO|UPDATE|FROM|NULL::)\s*("?[a-z_]+"?)(\.)?/g)) {
        if (match[1] !== "jsonb_populate_recordset" && match[1] !== "upserted") {
          expect(`${match[1]}${match[2] ?? ""}`, sql).toBe('"reference".');
        }
      }
    }
  });

  it("upserts on the key, compares every other column and sets updated_at only on a change", () => {
    const sql = upsertSql("airlines");
    expect(sql).toContain('INSERT INTO "reference"."airlines" AS t ("iata_code", "icao_code", "name"');
    expect(sql).toContain('ON CONFLICT ("iata_code") DO UPDATE SET "icao_code" = EXCLUDED."icao_code"');
    expect(sql).toContain('"logo_url" = EXCLUDED."logo_url", updated_at = now() WHERE (t."icao_code", ');
    expect(sql).toContain('t."logo_url") IS DISTINCT FROM (EXCLUDED."icao_code", ');
    expect(sql).not.toMatch(/DELETE/i);
    expect(sql).not.toContain('"iata_code" = EXCLUDED."iata_code"');
  });

  it("deactivates instead of deleting", () => {
    expect(deactivateSql("airports")).toMatch(/^UPDATE "reference"\."airports" AS t SET is_active = false, /);
    for (const sql of all) {
      expect(sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i);
    }
  });
});

describe("loadReferenceData", () => {
  it("checks the data folder before it connects", async () => {
    const dir = await dataDir({ "airports.csv": null });
    // Port 1 on loopback: a connection attempt would fail with ECONNREFUSED, not with ReferenceDataError.
    const error = await loadReferenceData({ url: "postgres://nobody@127.0.0.1:1/none", dataDir: dir }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ReferenceDataError);
  });

  it("refuses an empty DSN", async () => {
    await expect(loadReferenceData({ url: " ", dataDir: await dataDir() })).rejects.toThrow(TypeError);
  });
});

describe("ReferenceLoadError", () => {
  it("names the table and the step, keeps the SQLSTATE and the driver's detail", () => {
    const cause = Object.assign(new Error('insert or update on table "airports" violates foreign key'), {
      code: "23503",
      detail: 'Key (city_code)=(QQQ) is not present in table "cities".',
    });
    const error = new ReferenceLoadError("airports", "upsert", cause);
    expect(error.message).toBe(
      'upsert of reference.airports failed: insert or update on table "airports" violates foreign key ' +
        '(Key (city_code)=(QQQ) is not present in table "cities".)',
    );
    expect(error).toMatchObject({ name: "ReferenceLoadError", table: "airports", code: "23503", cause });
  });
});
