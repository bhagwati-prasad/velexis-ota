// Tests of scripts/validate.mjs (task X-017): the CHECK constraints, foreign keys, key order and file format of the
// vendored datasets, on a small hand-written data set. Nothing here touches the network or the committed files,
// except the last block, which compares the column rules with docs/velexis-sdk/db/reference.sql.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  DATA_FILES,
  LOAD_ORDER,
  MIN_ROWS,
  PACKAGE_DIR,
  TABLES,
  formatCsv,
  parseCsv,
  validateData,
  valueProblem,
} from "./validate.mjs";

/** A minimal, valid data set: two rows per table, every foreign key resolving. */
const VALID = Object.freeze({
  "currencies.csv": [
    "code,numeric_code,name,symbol,minor_units,is_active",
    "EUR,978,Euro,€,2,true",
    "USD,840,US Dollar,$,2,true",
  ],
  "countries.csv": [
    "code,alpha3,numeric_code,name,official_name,continent_code,currency_code,calling_code,is_eu",
    "FR,FRA,250,France,,EU,EUR,33,true",
    "US,USA,840,United States,,NA,USD,1,false",
  ],
  "time_zones.csv": [
    "name,country_code,utc_offset_minutes,dst_offset_minutes",
    "America/New_York,US,-300,-240",
    "Europe/Paris,FR,60,120",
  ],
  "cities.csv": [
    "iata_code,name,country_code,state_code,time_zone,latitude,longitude,search_rank",
    "NYC,New York City,US,NY,America/New_York,40.71427,-74.00597,735272",
    "PAR,Paris,FR,,Europe/Paris,48.85341,2.3488,606694",
  ],
  "airports.csv": [
    "iata_code,icao_code,name,city_code,city_name,country_code,time_zone,latitude,longitude,elevation_ft,kind,is_active,search_rank",
    "CDG,LFPG,Paris Charles de Gaulle Airport,PAR,Paris,FR,Europe/Paris,49.01278,2.55,390,airport,true,565101",
    'JFK,KJFK,"John F. Kennedy International Airport, Queens",NYC,New York City,US,America/New_York,40.63983,-73.77874,10,airport,true,589976',
    "ORY,LFPO,Paris Orly Airport,PAR,Paris,FR,Europe/Paris,48.72333,2.37944,291,airport,false,0",
  ],
  "airlines.csv": [
    "iata_code,icao_code,name,common_name,country_code,accounting_code,alliance,is_low_cost,is_active,logo_url",
    "AF,AFR,Air France,,FR,057,skyteam,false,true,",
    "UA,UAL,United Airlines,,US,016,star_alliance,false,true,",
  ],
  "aircraft.csv": [
    "iata_code,icao_code,name,manufacturer,body_type",
    "320,A320,Airbus A320-100/200,Airbus,narrow",
    "77W,B77W,Boeing 777-300ER,Boeing,wide",
  ],
  "overrides.csv": ["table,key,column,value"],
});

/**
 * The valid data set as file contents, with some lines replaced: { "airports.csv": { 2: "new line" } } replaces
 * line 2 (1 = header); null deletes the line; an array value replaces the whole file.
 * @param {Record<string, Record<number, string | null> | string[]>} [changes]
 * @returns {Record<string, string>}
 */
function dataSet(changes = {}) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const [file, lines] of Object.entries(VALID)) {
    const change = changes[file];
    const edited = Array.isArray(change)
      ? change
      : lines
          .map((line, i) => (change && Object.hasOwn(change, i + 1) ? change[i + 1] : line))
          .filter((line) => line !== null);
    files[file] = `${edited.join("\n")}\n`;
  }
  return files;
}

/** @param {Record<string, string | Uint8Array | undefined>} files */
const problemsOf = (files) => validateData(files, { minRows: null }).problems;

describe("validate.mjs on a small data set", () => {
  test("a consistent data set has no problems and is counted per table [X-017 AC1]", () => {
    const result = validateData(dataSet(), { minRows: null });
    expect(result.problems).toEqual([]);
    expect(result.counts).toEqual({
      currencies: 2,
      countries: 2,
      time_zones: 2,
      cities: 2,
      airports: 3,
      airlines: 2,
      aircraft: 2,
    });
    expect(result.overrides).toBe(0);
  });

  test.each([
    ["aircraft.csv", 3, "77w,B77W,Boeing 777-300ER,Boeing,wide", /iata_code "77w" does not match/],
    ["currencies.csv", 2, "EUR,97,Euro,€,2,true", /numeric_code "97" does not match/],
    ["currencies.csv", 2, "EUR,978,Euro,€,5,true", /minor_units 5 is outside 0..4/],
    ["currencies.csv", 2, "EUR,978,Euro,€,2,yes", /is_active "yes" is not true or false/],
    ["currencies.csv", 2, "EUR,978,,€,2,true", /name is empty but the column is NOT NULL/],
    ["countries.csv", 2, "FR,FRA,250,France,,EU,EUR,+33,true", /calling_code "\+33" does not match/],
    ["countries.csv", 2, "FR,FRA,250,France,,EUR,EUR,33,true", /continent_code "EUR" is not one of/],
    ["countries.csv", 2, "FR,FR1,250,France,,EU,EUR,33,true", /alpha3 "FR1" does not match/],
    ["time_zones.csv", 3, "Europe/Paris,FR,60.5,120", /utc_offset_minutes "60.5" is not an integer/],
    [
      "cities.csv",
      3,
      "PAR,Paris,FR,,Europe/Paris,90.000001,2.3488,1",
      /latitude 90.000001 is outside -90..90/,
    ],
    ["cities.csv", 3, "PAR,Paris,FR,,Europe/Paris,48.8,-180.5,1", /longitude -180.5 is outside -180..180/],
    ["cities.csv", 3, "PAR,Paris,FR,,Europe/Paris,48.1234567,2.3,1", /not a numeric\(9,6\) value/],
    ["cities.csv", 3, "PAR, Paris,FR,,Europe/Paris,48.8,2.3,1", /has leading or trailing spaces/],
    ["airports.csv", 2, "CDG,LFPG,Paris CDG,PAR,Paris,FR,Europe/Paris,49,2.5,390,port,true,1", /kind "port"/],
    [
      "airports.csv",
      2,
      "CDG,LFP,Paris CDG,PAR,Paris,FR,Europe/Paris,49,2.5,390,airport,true,1",
      /icao_code "LFP"/,
    ],
    ["airports.csv", 2, "CD1,LFPG,Paris CDG,PAR,Paris,FR,Europe/Paris,49,2.5,390,airport,true,1", /"CD1"/],
    [
      "airports.csv",
      2,
      "CDG,LFPG,Paris CDG,PAR,Paris,FR,Europe/Paris,49,2.5,390,airport,true,",
      /search_rank is/,
    ],
    [
      "airlines.csv",
      2,
      "AF,AFR,Air France,,FR,57,skyteam,false,true,",
      /accounting_code "57" does not match/,
    ],
    [
      "airlines.csv",
      2,
      "AF,AFR,Air France,,FR,057,sky_team,false,true,",
      /alliance "sky_team" is not one of/,
    ],
    ["airlines.csv", 2, "A,AFR,Air France,,FR,057,skyteam,false,true,", /iata_code "A" does not match/],
    ["aircraft.csv", 2, "320,A320,Airbus A320,Airbus,jumbo", /body_type "jumbo" is not one of/],
    ["aircraft.csv", 2, "320,A3200,Airbus A320,Airbus,narrow", /icao_code "A3200" does not match/],
  ])("%s line %i breaks a CHECK constraint or a type: %s [X-017 AC1]", (file, line, text, message) => {
    const problems = problemsOf(dataSet({ [file]: { [line]: text } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${file.replace(".", "\\.")}:${line}: `));
    expect(problems[0]).toMatch(message);
  });

  test("text values must be one line, without control characters, in Unicode NFC [X-017 AC1]", () => {
    expect(valueProblem(TABLES.cities.columns[1], "Par\tis")).toMatch(/control character/);
    expect(valueProblem(TABLES.cities.columns[1], "Sa\u0303o Paulo")).toMatch(/not in Unicode NFC/);
    expect(valueProblem(TABLES.cities.columns[1], "São Paulo")).toBeNull();
    const quotedNewline = dataSet({ "cities.csv": { 3: 'PAR,"Pa\nris",FR,,Europe/Paris,48.8,2.3,1' } });
    expect(problemsOf(quotedNewline).join("\n")).toMatch(/control character/);
  });

  test("keys must be unique and sorted [X-017 AC1]", () => {
    const unsorted = dataSet({
      "aircraft.csv": [
        "iata_code,icao_code,name,manufacturer,body_type",
        "77W,B77W,Boeing 777-300ER,Boeing,wide",
        "320,A320,Airbus A320-100/200,Airbus,narrow",
      ],
    });
    expect(problemsOf(unsorted)).toEqual(['aircraft.csv:3: key "320" is not sorted (after "77W")']);
    const duplicate = dataSet({ "currencies.csv": { 3: "EUR,840,Euro again,,2,true" } });
    expect(problemsOf(duplicate)).toContain('currencies.csv:3: duplicate key "EUR"');
  });

  test("UNIQUE columns may not repeat a value [X-017 AC1]", () => {
    const files = dataSet({
      "airports.csv": {
        4: "ORY,LFPG,Paris Orly Airport,PAR,Paris,FR,Europe/Paris,48.72,2.37,291,airport,true,0",
      },
    });
    expect(problemsOf(files)).toEqual(['airports.csv: icao_code "LFPG" is used by "CDG" and "ORY" (UNIQUE)']);
  });

  test("an airport whose time zone or city is not in the files is reported [X-017 AC3]", () => {
    const files = dataSet({
      "airports.csv": {
        2: "CDG,LFPG,Paris CDG,XPA,Paris,FR,Europe/Pariss,49,2.5,390,airport,true,1",
      },
    });
    expect(problemsOf(files)).toEqual([
      'airports.csv: iata_code "CDG": city_code "XPA" is not in cities.csv',
      'airports.csv: iata_code "CDG": time_zone "Europe/Pariss" is not in time_zones.csv',
    ]);
  });

  test("every other foreign key resolves inside the files [X-017 AC3]", () => {
    const files = dataSet({
      "countries.csv": { 2: "FR,FRA,250,France,,EU,XEU,33,true" },
      "time_zones.csv": { 3: "Europe/Paris,FX,60,120" },
      "cities.csv": { 3: "PAR,Paris,DE,,Europe/Paris,48.8,2.3,1" },
      "airlines.csv": { 3: "UA,UAL,United Airlines,,ZZ,016,star_alliance,false,true," },
    });
    expect(problemsOf(files)).toEqual([
      'countries.csv: code "FR": currency_code "XEU" is not in currencies.csv',
      'time_zones.csv: name "Europe/Paris": country_code "FX" is not in countries.csv',
      'cities.csv: iata_code "PAR": country_code "DE" is not in countries.csv',
      'airlines.csv: iata_code "UA": country_code "ZZ" is not in countries.csv',
    ]);
  });

  test("files must be deterministic CSV: header, LF, final newline, no BOM, canonical quoting [X-017 AC1]", () => {
    const base = dataSet();
    expect(problemsOf({ ...base, "aircraft.csv": base["aircraft.csv"].replace(/\n/g, "\r\n") })).toEqual([
      "aircraft.csv: has CR characters; line endings must be LF",
    ]);
    expect(problemsOf({ ...base, "aircraft.csv": base["aircraft.csv"].trimEnd() })).toEqual([
      "aircraft.csv: does not end with a newline",
    ]);
    expect(problemsOf({ ...base, "aircraft.csv": `\uFEFF${base["aircraft.csv"]}` })).toEqual([
      "aircraft.csv: starts with a byte order mark",
    ]);
    // validateDataDir reads bytes, and TextDecoder drops a leading byte order mark unless told to keep it.
    const withBom = new TextEncoder().encode(`\uFEFF${base["aircraft.csv"]}`);
    expect(problemsOf({ ...base, "aircraft.csv": withBom })).toEqual([
      "aircraft.csv: starts with a byte order mark",
    ]);
    expect(
      problemsOf({ ...base, "aircraft.csv": base["aircraft.csv"].replace("Boeing,wide", '"Boeing",wide') }),
    ).toEqual(["aircraft.csv: not in the canonical CSV form of fetch.mjs (needless quotes)"]);
    expect(problemsOf({ ...base, "aircraft.csv": `${base["aircraft.csv"]}\n` })).toEqual([
      "aircraft.csv: has a blank line",
    ]);
    expect(problemsOf({ ...base, "aircraft.csv": new Uint8Array([0x69, 0xff, 0x0a]) })).toEqual([
      "aircraft.csv: not valid UTF-8",
    ]);
    expect(problemsOf({ ...base, "aircraft.csv": undefined })).toEqual(["aircraft.csv: missing"]);
  });

  test("the header must be exactly the columns of reference.sql, and rows must have every field [X-017 AC1]", () => {
    const reordered = dataSet({ "aircraft.csv": { 1: "iata_code,name,icao_code,manufacturer,body_type" } });
    expect(problemsOf(reordered)).toEqual([
      'aircraft.csv:1: header "iata_code,name,icao_code,manufacturer,body_type" is not ' +
        '"iata_code,icao_code,name,manufacturer,body_type"',
    ]);
    const short = dataSet({ "aircraft.csv": { 2: "320,A320,Airbus A320,Airbus" } });
    expect(problemsOf(short)).toEqual(["aircraft.csv:2: 4 fields, expected 5"]);
  });

  test("tables shorter than the plausible minimum are reported [X-017 AC2]", () => {
    const result = validateData(dataSet());
    expect(result.problems).toContain("airports.csv: 3 rows, fewer than the plausible minimum of 8000");
    expect(result.problems).toHaveLength(LOAD_ORDER.length);
    expect(MIN_ROWS).toMatchObject({
      currencies: 150,
      countries: 240,
      time_zones: 300,
      airports: 8000,
      airlines: 700,
      aircraft: 200,
    });
  });
});

describe("overrides.csv", () => {
  /** @param {...string} lines */
  const withOverrides = (...lines) => dataSet({ "overrides.csv": ["table,key,column,value", ...lines] });

  test("the committed file starts with the header table,key,column,value [X-017 AC1]", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "data", "overrides.csv"), "utf8");
    expect(text.split("\n")[0]).toBe("table,key,column,value");
  });

  test("a valid override is applied before foreign keys are checked [X-017 AC1]", () => {
    const ok = validateData(withOverrides("airports,ORY,is_active,true", "airports,ORY,city_name,"), {
      minRows: null,
    });
    expect(ok).toMatchObject({ problems: [], overrides: 2 });
    expect(problemsOf(withOverrides("airports,ORY,time_zone,Europe/Orly"))).toEqual([
      'airports.csv: iata_code "ORY": time_zone "Europe/Orly" is not in time_zones.csv',
    ]);
    expect(problemsOf(withOverrides("airports,ORY,icao_code,LFPG"))).toEqual([
      'airports.csv: icao_code "LFPG" is used by "CDG" and "ORY" (UNIQUE)',
    ]);
  });

  test.each([
    ["runways,CDG,name,X", /unknown table "runways"/],
    ["airports,CDG,gate,X", /unknown column "gate" of airports/],
    ["airports,CDG,iata_code,XXX", /the key column iata_code cannot be overridden/],
    ["airports,XXX,name,Somewhere", /airports has no row with key "XXX"/],
    ["airports,CDG,kind,port", /value "port" is not one of/],
    ["airports,CDG,name,", /value is empty but the column is NOT NULL/],
    ["airports,CDG,name", /3 fields, expected 4/],
  ])("the override %s is rejected [X-017 AC1]", (line, message) => {
    const problems = problemsOf(withOverrides(line));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^overrides\.csv:2: /);
    expect(problems[0]).toMatch(message);
  });

  test("the same column of a row cannot be overridden twice [X-017 AC1]", () => {
    expect(problemsOf(withOverrides("airports,CDG,name,A", "airports,CDG,name,B"))).toEqual([
      'overrides.csv:3: airports.name of "CDG" is overridden twice',
    ]);
  });
});

describe("CSV text", () => {
  test("formatCsv quotes only where needed and parseCsv reads it back [X-017 AC1]", () => {
    const records = [
      ["a", "b,c", 'd "e"', ""],
      ["São Paulo", "Washington, D.C.", "x", "y"],
    ];
    const text = formatCsv(records);
    expect(text).toBe('a,"b,c","d ""e""",\nSão Paulo,"Washington, D.C.",x,y\n');
    expect(parseCsv(text)).toEqual(records);
  });

  test("parseCsv rejects malformed quoting [X-017 AC1]", () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/unterminated quoted field/);
    expect(() => parseCsv('a,b"c\n')).toThrow(/quote inside an unquoted field/);
    expect(() => parseCsv('a,"b"c\n')).toThrow(/text after a closing quote/);
  });
});

describe("column rules match docs/velexis-sdk/db/reference.sql", () => {
  const ddl = readFileSync(
    path.join(PACKAGE_DIR, "..", "..", "docs", "velexis-sdk", "db", "reference.sql"),
    "utf8",
  );
  /** @type {Map<string, Map<string, string>>} table -> column -> definition */
  const tables = new Map();
  for (const match of ddl.matchAll(/CREATE TABLE reference\.(\w+) \(\n([\s\S]*?)\n\);/g)) {
    const columns = new Map();
    for (const line of match[2].split("\n")) {
      const column = /^\s+(\w+)\s+(.*?)(?:,)?\s*(?:-- .*)?$/.exec(line);
      if (column) {
        columns.set(column[1], column[2]);
      }
    }
    tables.set(match[1], columns);
  }

  test("every table has exactly the DDL columns, minus the timestamps the loader sets [X-017 AC1]", () => {
    expect([...tables.keys()].sort()).toEqual([...LOAD_ORDER].sort());
    for (const name of LOAD_ORDER) {
      const ddlColumns = [...(tables.get(name)?.keys() ?? [])].filter(
        (c) => c !== "created_at" && c !== "updated_at",
      );
      expect(
        TABLES[name].columns.map((c) => c.name),
        name,
      ).toEqual(ddlColumns);
    }
  });

  test("the regex and list CHECKs, NOT NULL, UNIQUE and foreign keys are the DDL's [X-017 AC1]", () => {
    for (const name of LOAD_ORDER) {
      const ddlColumns = /** @type {Map<string, string>} */ (tables.get(name));
      for (const column of TABLES[name].columns) {
        const definition = /** @type {string} */ (ddlColumns.get(column.name));
        const regex = /CHECK \(\w+ ~ '([^']+)'\)/.exec(definition);
        if (regex) {
          expect(column.pattern?.source, `${name}.${column.name}`).toBe(regex[1]);
        }
        const list = /CHECK \(\w+ IN \(([^)]+)\)\)/.exec(definition);
        if (list) {
          expect(column.values, `${name}.${column.name}`).toEqual(
            list[1].split(",").map((v) => v.trim().slice(1, -1)),
          );
        }
        const between = /CHECK \(\w+ BETWEEN (-?\d+) AND (-?\d+)\)/.exec(definition);
        if (between) {
          expect([column.min, column.max], `${name}.${column.name}`).toEqual([
            Number(between[1]),
            Number(between[2]),
          ]);
        }
        const required = /NOT NULL|PRIMARY KEY/.test(definition) && !/DEFAULT now\(\)/.test(definition);
        expect(Boolean(column.required), `${name}.${column.name} NOT NULL`).toBe(required);
        expect(Boolean(column.unique), `${name}.${column.name} UNIQUE`).toBe(/\bUNIQUE\b/.test(definition));
        const ref = /REFERENCES reference\.(\w+) \((\w+)\)/.exec(definition);
        expect(column.ref ?? null, `${name}.${column.name} REFERENCES`).toBe(ref ? ref[1] : null);
        if (ref) {
          expect(TABLES[/** @type {keyof typeof TABLES} */ (ref[1])].key).toBe(ref[2]);
        }
        const type = /^(char|text|integer|smallint|numeric|boolean)/.exec(definition)?.[1];
        const expectedType = {
          char: "text",
          text: "text",
          integer: "int",
          smallint: "smallint",
          numeric: "numeric",
          boolean: "bool",
        };
        expect(column.type, `${name}.${column.name} type`).toBe(
          expectedType[/** @type {keyof typeof expectedType} */ (type)],
        );
      }
    }
  });

  test("the data files are the seven tables plus overrides.csv [X-017 AC1]", () => {
    expect(DATA_FILES).toEqual([
      "currencies.csv",
      "countries.csv",
      "time_zones.csv",
      "cities.csv",
      "airports.csv",
      "airlines.csv",
      "aircraft.csv",
      "overrides.csv",
    ]);
  });
});
