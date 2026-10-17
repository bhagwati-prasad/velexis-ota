// The reference endpoints against PostgreSQL 16 and Redis 7 (OBE-015; ota/docs/scope.md §3.1, ADR-0024): the API on
// this file's database clone and Redis database, called as the hosted storefront (edge headers), with a secret key and
// with a publishable key. The clone's reference fixture (@velexis/testing: no cities, no time zones) is completed here
// as the loader would write it (as velexis_migrator, the owner of the reference tables), with the rows the ranking,
// filter, localisation and paging tests need. Every answer is checked against the OTA document, and a query log on the
// API's pool shows which relations the reference requests read.
import { hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  sql,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../../../src/common/ids";
import { REFERENCE_CACHE_CONTROL } from "../../../src/reference/reference.controller";
import { OTA_POOL, type OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALLOWED_ORIGIN = "https://shop.alpha-travel.example";

type Mode = "edge" | "secret key" | "publishable key";
const MODES: readonly Mode[] = ["edge", "secret key", "publishable key"];

/** One statement the API's pool ran: its text and bound values. */
interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
/** velexis_migrator: the owner of the platform and reference tables, writing what the platform and the loader write. */
let migrator: Kysely<PlatformDatabase & ReferenceDatabase>;
const credentials = {} as Record<Mode, Readonly<Record<string, string>>>;
/** Every statement of the API's pool since the last `beforeEach`. */
let statements: Statement[] = [];

/** Issues a key of the tenant as the platform does. */
async function issueKey(tenantId: string, kind: "pk" | "sk"): Promise<string> {
  const key = newApiKey(kind);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: kind === "pk" ? "Storefront (test)" : "Server (test)",
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...(kind === "pk" ? { allowed_origins: [ALLOWED_ORIGIN] } : {}),
    })
    .execute();
  return key;
}

/** Completes the reference fixture: time zones, cities, coordinates and ranks, and the rows of the tests. */
async function loadReferenceRows(): Promise<void> {
  await migrator
    .insertInto("reference.currencies")
    .values([
      { code: "JPY", numeric_code: "392", name: "Japanese Yen", symbol: null, minor_units: 0 },
      { code: "ADP", name: "Andorran Peseta", symbol: null, minor_units: 0, is_active: false },
    ])
    .execute();
  await migrator
    .insertInto("reference.countries")
    .values([
      {
        code: "DE",
        alpha3: "DEU",
        name: "Germany",
        continent_code: "EU",
        currency_code: "EUR",
        calling_code: "49",
      },
      {
        code: "IT",
        alpha3: "ITA",
        name: "Italy",
        continent_code: "EU",
        currency_code: "EUR",
        calling_code: "39",
      },
      // No calling code: the document's Country cannot carry it, so it is not listed.
      {
        code: "AQ",
        alpha3: "ATA",
        name: "Antarctica",
        continent_code: "AN",
        currency_code: null,
        calling_code: null,
      },
    ])
    .execute();
  await migrator
    .insertInto("reference.time_zones")
    .values([
      { name: "Europe/Paris", country_code: "FR", utc_offset_minutes: 60, dst_offset_minutes: 120 },
      { name: "Europe/Rome", country_code: "IT", utc_offset_minutes: 60, dst_offset_minutes: 120 },
      { name: "Europe/Berlin", country_code: "DE", utc_offset_minutes: 60, dst_offset_minutes: 120 },
      { name: "Europe/London", country_code: "GB", utc_offset_minutes: 0, dst_offset_minutes: 60 },
      { name: "America/New_York", country_code: "US", utc_offset_minutes: -300, dst_offset_minutes: -240 },
    ])
    .execute();
  await migrator
    .insertInto("reference.cities")
    .values([
      city("PAR", "Paris", "FR", "Europe/Paris", 606_694),
      city("MIL", "Milan", "IT", "Europe/Rome", 400_000),
      city("BER", "Berlin", "DE", "Europe/Berlin", 450_000),
      city("LON", "London", "GB", "Europe/London", 700_000),
      { ...city("NYC", "New York", "US", "America/New_York", 650_000), state_code: "NY" },
    ])
    .execute();
  for (const [code, cityCode, timeZone, rank] of [
    ["CDG", "PAR", "Europe/Paris", 565_101],
    ["ORY", "PAR", "Europe/Paris", 251_847],
    ["LHR", "LON", "Europe/London", 600_000],
    ["JFK", "NYC", "America/New_York", 500_000],
  ] as const) {
    await migrator
      .updateTable("reference.airports")
      .set({
        city_code: cityCode,
        time_zone: timeZone,
        latitude: "48.000000",
        longitude: "2.000000",
        search_rank: rank,
      })
      .where("iata_code", "=", code)
      .execute();
  }
  await migrator
    .insertInto("reference.airports")
    .values([
      // More popular than every Paris row: only the exact code puts PAR before it.
      airport("PMF", "Parma Airport", "MIL", "Milan", "IT", "Europe/Rome", 999_999),
      // Not offered by the search: a heliport, a closed airport, and one without a time zone.
      {
        ...airport("JDP", "Paris Issy-les-Moulineaux Heliport", "PAR", "Paris", "FR", "Europe/Paris", 0),
        kind: "heliport",
      },
      {
        ...airport("TXL", "Berlin Tegel Airport", "BER", "Berlin", "DE", "Europe/Berlin", 300_000),
        is_active: false,
      },
      {
        ...airport("BVA", "Paris Beauvais Airport", "PAR", "Paris", "FR", "Europe/Paris", 44_304),
        time_zone: null,
      },
      // 25 matches of "zebra" for the paging test, by falling rank.
      ...Array.from({ length: 25 }, (_, index) =>
        airport(
          `QZ${String.fromCharCode(65 + index)}`,
          `Zebra Field ${index + 1}`,
          null,
          "Zebraville",
          "US",
          "America/New_York",
          10_000 - index,
        ),
      ),
    ])
    .execute();
  await migrator
    .insertInto("reference.airlines")
    .values([
      { iata_code: "U2", icao_code: "EZY", name: "easyJet", country_code: "GB", is_low_cost: true },
      { iata_code: "9X", name: "Defunct Air", is_active: false },
    ])
    .execute();
}

function city(code: string, name: string, country: string, timeZone: string, rank: number) {
  return {
    iata_code: code,
    name,
    country_code: country,
    time_zone: timeZone,
    latitude: "48.853410",
    longitude: "2.348800",
    search_rank: rank,
  };
}

function airport(
  code: string,
  name: string,
  cityCode: string | null,
  cityName: string,
  country: string,
  timeZone: string,
  rank: number,
) {
  return {
    iata_code: code,
    name,
    city_code: cityCode,
    city_name: cityName,
    country_code: country,
    time_zone: timeZone,
    latitude: "44.824500",
    longitude: "10.296400",
    search_rank: rank,
  };
}

/** Records every statement the API's pool runs, on each connection as it is checked out. */
function recordStatements(pool: OtaPool): void {
  const recorded = new WeakSet<object>();
  pool.on("acquire", (client) => {
    if (recorded.has(client)) {
      return;
    }
    recorded.add(client);
    const target = client as unknown as { query: (...args: unknown[]) => unknown };
    const query = target.query.bind(client);
    target.query = (config: unknown, values?: unknown, ...rest: unknown[]) => {
      const text =
        typeof config === "string" ? config : String((config as { text?: unknown } | null)?.text ?? "");
      statements.push({ text, values: Array.isArray(values) ? values : [] });
      return query(config, values, ...rest);
    };
  });
}

/** The relations a statement reads (`from`/`join` targets), lower case, without quotes: `reference.airports`. */
function relationsOf(text: string): string[] {
  const pattern =
    /\b(?:from|join)\s+((?:"[^"]+"|[a-z_][a-z0-9_]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))?)/gi;
  return [...text.matchAll(pattern)].map((match) =>
    (match[1] ?? "").replace(/"/g, "").replace(/\s+/g, "").toLowerCase(),
  );
}

const get = (mode: Mode, path: string, headers: Readonly<Record<string, string>> = {}) =>
  request(api.server)
    .get(path)
    .set({ ...credentials[mode], ...headers });

const ids = (body: { data: Array<{ id: string }> }): string[] => body.data.map((location) => location.id);

// One database clone, one Redis database, the platform rows, the reference rows and an API application (the Nest
// module graph and the OTA document's validators): several seconds while every package's tests run at once.
beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase & ReferenceDatabase>(migratorPool);
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id: tenantId, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  credentials.edge = edgeHeaders("alpha.ota.example.com");
  credentials["secret key"] = { "X-Api-Key": await issueKey(tenantId, "sk") };
  credentials["publishable key"] = { "X-Api-Key": await issueKey(tenantId, "pk"), Origin: ALLOWED_ORIGIN };
  await loadReferenceRows();
  api = await createTestApp({ database: db, redis });
  recordStatements(api.app.get<OtaPool>(OTA_POOL));
}, 60_000);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(() => {
  statements = [];
});

describe("searchLocations", () => {
  it("returns PAR before airports named Parma: the exact IATA code first, then prefix matches by rank [OBE-015 AC1]", async () => {
    const res = await get("edge", "/v1/reference/locations?keyword=par");

    expectResponseToMatch("searchLocations", res);
    // PMF is the most popular match, BVA has no time zone, JDP is a heliport.
    expect(ids(res.body)).toEqual(["CITY:PAR", "AIRPORT:PMF", "AIRPORT:CDG", "AIRPORT:ORY"]);
    expect(res.body.data[0]).toMatchObject({
      name: "Paris",
      detailedName: "Paris, France",
      timeZone: "Europe/Paris",
      airports: [
        { iataCode: "CDG", name: "Paris Charles de Gaulle" },
        { iataCode: "ORY", name: "Paris Orly" },
        { iataCode: "BVA", name: "Paris Beauvais Airport" },
      ],
    });
    expect(res.body.data[1]).toMatchObject({
      iataCode: "PMF",
      name: "Parma Airport",
      cityCode: "MIL",
      cityName: "Milan",
      countryName: "Italy",
      airports: [],
    });
    expect(res.body.page).toEqual({ nextCursor: null, limit: 20 });
    expect(res.headers["cache-control"]).toBe(REFERENCE_CACHE_CONTROL);
  });

  it("matches airport, city and airport-city name prefixes case-insensitively, and exact airport codes", async () => {
    const parma = await get("edge", "/v1/reference/locations?keyword=PARMA");
    const lhr = await get("edge", "/v1/reference/locations?keyword=lhr");
    const london = await get("edge", "/v1/reference/locations?keyword=Lond");
    const milan = await get("edge", "/v1/reference/locations?keyword=mil");

    expect(ids(parma.body)).toEqual(["AIRPORT:PMF"]);
    expect(ids(lhr.body)).toEqual(["AIRPORT:LHR"]);
    expect(ids(london.body)).toEqual(["CITY:LON", "AIRPORT:LHR"]);
    // MIL is the exact city code; Parma Airport serves Milan (its city name).
    expect(ids(milan.body)).toEqual(["CITY:MIL", "AIRPORT:PMF"]);
  });

  it("filters by subType and countryCode, treats LIKE wildcards literally and leaves out closed airports", async () => {
    const airports = await get("edge", "/v1/reference/locations?keyword=par&subType=AIRPORT");
    const cities = await get("edge", "/v1/reference/locations?keyword=par&subType=CITY");
    const italy = await get("edge", "/v1/reference/locations?keyword=par&countryCode=IT");
    const wildcard = await get("edge", "/v1/reference/locations?keyword=p%25r");
    const closed = await get("edge", "/v1/reference/locations?keyword=tegel");

    expect(ids(airports.body)).toEqual(["AIRPORT:PMF", "AIRPORT:CDG", "AIRPORT:ORY"]);
    expect(ids(cities.body)).toEqual(["CITY:PAR"]);
    expect(ids(italy.body)).toEqual(["AIRPORT:PMF"]);
    expect(ids(wildcard.body)).toEqual([]);
    expect(ids(closed.body)).toEqual([]);
    for (const res of [airports, cities, italy, wildcard, closed]) {
      expectResponseToMatch("searchLocations", res);
    }
  });

  it("answers at most 20 locations per page and pages with the cursor", async () => {
    const first = await get("edge", "/v1/reference/locations?keyword=zebra&limit=50");
    const second = await get(
      "edge",
      `/v1/reference/locations?keyword=zebra&limit=50&cursor=${String(first.body.page.nextCursor)}`,
    );

    expect([first.body.data.length, first.body.page.limit, typeof first.body.page.nextCursor]).toEqual([
      20,
      20,
      "string",
    ]);
    expect(second.body.page).toEqual({ nextCursor: null, limit: 20 });
    expect([...ids(first.body), ...ids(second.body)]).toEqual(
      Array.from({ length: 25 }, (_, index) => `AIRPORT:QZ${String.fromCharCode(65 + index)}`),
    );
  });

  it("refuses a keyword under two characters and a foreign cursor with 400 VALIDATION_FAILED", async () => {
    const short = await get("edge", "/v1/reference/locations?keyword=p");
    const cursor = await get("edge", "/v1/reference/locations?keyword=par&cursor=bm90LWEtY3Vyc29y");

    for (const res of [short, cursor]) {
      expectResponseToMatch("searchLocations", res);
      expect(res.status).toBe(400);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(cursor.body.error.fieldErrors).toEqual([
      { path: "/query/cursor", code: "cursor", message: "is not a cursor of this list" },
    ]);
  });
});

describe("getAirport and getAirline", () => {
  it("answer unknown IATA codes with 404 NOT_FOUND, and closed airports too [OBE-015 AC1]", async () => {
    for (const path of [
      "/v1/reference/airports/XXX",
      "/v1/reference/airports/TXL",
      // No time zone in the data: the document's Airport cannot be filled.
      "/v1/reference/airports/BVA",
    ]) {
      const res = await get("edge", path);
      expectResponseToMatch("getAirport", res);
      expect([res.status, res.body.error.code, res.headers["cache-control"]], path).toEqual([
        404,
        "NOT_FOUND",
        "no-store",
      ]);
    }
    const airline = await get("edge", "/v1/reference/airlines/ZZ");
    expectResponseToMatch("getAirline", airline);
    expect([airline.status, airline.body.error.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("return an airport of any kind with the country name in the Accept-Language language", async () => {
    const english = await get("edge", "/v1/reference/airports/CDG");
    const german = await get("edge", "/v1/reference/airports/CDG", { "Accept-Language": "de-DE,de;q=0.9" });
    const heliport = await get("edge", "/v1/reference/airports/JDP");

    for (const res of [english, german, heliport]) {
      expectResponseToMatch("getAirport", res);
      expect([res.status, res.headers["cache-control"], res.headers["vary"]]).toEqual([
        200,
        REFERENCE_CACHE_CONTROL,
        "Accept-Language",
      ]);
    }
    expect(english.body).toMatchObject({ iataCode: "CDG", icaoCode: "LFPG", cityCode: "PAR", active: true });
    expect([english.body.countryName, german.body.countryName]).toEqual(["France", "Frankreich"]);
    expect(heliport.body.name).toBe("Paris Issy-les-Moulineaux Heliport");
  });

  it("return an airline whether it operates or not", async () => {
    const res = await get("edge", "/v1/reference/airlines/9X");

    expectResponseToMatch("getAirline", res);
    expect(res.body).toMatchObject({ iataCode: "9X", name: "Defunct Air", icaoCode: null, active: false });
  });
});

describe("listAirlines", () => {
  it("pages through the active airlines alphabetically, ignoring case", async () => {
    const first = await get("edge", "/v1/reference/airlines?limit=2");
    const second = await get(
      "edge",
      `/v1/reference/airlines?limit=2&cursor=${String(first.body.page.nextCursor)}`,
    );

    for (const res of [first, second]) {
      expectResponseToMatch("listAirlines", res);
    }
    const codes = [...first.body.data, ...second.body.data].map(
      (airline: { iataCode: string }) => airline.iataCode,
    );
    expect(codes).toEqual(["AF", "AA", "BA", "U2"]);
    expect(second.body.page.nextCursor).toBeNull();
  });

  it("returns exactly the requested codes in one page, operating or not, without unknown ones", async () => {
    const res = await get("edge", "/v1/reference/airlines?iataCodes=BA,9X,QQ,AF");

    expectResponseToMatch("listAirlines", res);
    expect(res.body.data.map((airline: { iataCode: string }) => airline.iataCode)).toEqual([
      "9X",
      "AF",
      "BA",
    ]);
    expect(res.body.page).toEqual({ nextCursor: null, limit: 100 });
  });
});

describe("listCountries and listCurrencies", () => {
  it("list the countries sorted by their name in the Accept-Language language, with native names", async () => {
    const english = await get("edge", "/v1/reference/countries");
    const german = await get("edge", "/v1/reference/countries", { "Accept-Language": "de" });
    const firstPage = await get("edge", "/v1/reference/countries?limit=2");
    const secondPage = await get(
      "edge",
      `/v1/reference/countries?limit=2&cursor=${String(firstPage.body.page.nextCursor)}`,
    );

    for (const res of [english, german, firstPage, secondPage]) {
      expectResponseToMatch("listCountries", res);
      expect(res.headers["vary"]).toBe("Accept-Language");
    }
    const codes = (res: { body: { data: Array<{ code: string }> } }) =>
      res.body.data.map((country) => country.code);
    expect(codes(english)).toEqual(["FR", "DE", "IT", "GB", "US"]);
    expect(codes(german)).toEqual(["DE", "FR", "IT", "US", "GB"]);
    expect([...codes(firstPage), ...codes(secondPage)]).toEqual(["FR", "DE", "IT", "GB"]);
    expect(english.body.data[1]).toMatchObject({
      code: "DE",
      name: "Germany",
      nativeName: "Deutschland",
      region: "Europe",
    });
    expect(german.body.data[0]).toMatchObject({ code: "DE", name: "Deutschland", callingCode: "49" });
  });

  it("list the active currencies by code with localised names and the code for a missing symbol", async () => {
    const english = await get("edge", "/v1/reference/currencies");
    const german = await get("edge", "/v1/reference/currencies?limit=2", { "Accept-Language": "de-CH" });

    for (const res of [english, german]) {
      expectResponseToMatch("listCurrencies", res);
    }
    expect(english.body).toEqual({
      data: [
        { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
        { code: "GBP", name: "Pound Sterling", symbol: "£", decimals: 2 },
        { code: "JPY", name: "Japanese Yen", symbol: "JPY", decimals: 0 },
        { code: "USD", name: "US Dollar", symbol: "$", decimals: 2 },
      ],
      page: { nextCursor: null, limit: 20 },
    });
    expect(german.body.data.map((currency: { name: string }) => currency.name)).toEqual([
      "Euro",
      "Britisches Pfund",
    ]);
    expect(typeof german.body.page.nextCursor).toBe("string");
  });
});

describe("every reference operation", () => {
  const OPERATIONS = [
    ["searchLocations", "/v1/reference/locations?keyword=lon"],
    ["getAirport", "/v1/reference/airports/LHR"],
    ["getAirport", "/v1/reference/airports/QQQ"],
    ["listAirlines", "/v1/reference/airlines"],
    ["listAirlines", "/v1/reference/airlines?iataCodes=BA,U2"],
    ["getAirline", "/v1/reference/airlines/BA"],
    ["getAirline", "/v1/reference/airlines/Q9"],
    ["listCountries", "/v1/reference/countries"],
    ["listCurrencies", "/v1/reference/currencies"],
  ] as const;

  it.each(MODES)("validates against the document in %s mode [OBE-015 AC2]", async (mode) => {
    for (const [operationId, path] of OPERATIONS) {
      const res = await get(mode, path);
      expectResponseToMatch(operationId, res);
      expect(res.status, `${mode} ${path}`).toBe(path.endsWith("QQQ") || path.endsWith("Q9") ? 404 : 200);
      if (res.status === 200) {
        expect(res.headers["cache-control"]).toBe(REFERENCE_CACHE_CONTROL);
      }
    }
  });

  it("still needs a credential: 401 INVALID_API_KEY without one", async () => {
    const res = await request(api.server).get("/v1/reference/currencies");

    expectResponseToMatch("listCurrencies", res);
    expect([res.status, res.body.error.code]).toEqual([401, "INVALID_API_KEY"]);
  });

  it("touches no tenant table: the query log reads only reference, platform and catalogue relations [OBE-015 AC3]", async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'tenant_alpha'
    `.execute(migrator);
    const tenantTables = new Set(rows.map((row) => row.table_name));
    expect(tenantTables.size).toBeGreaterThan(40);

    for (const mode of MODES) {
      for (const [, path] of OPERATIONS) {
        expect([200, 404], `${mode} ${path}`).toContain((await get(mode, path)).status);
      }
    }

    const relations = new Set(statements.flatMap((statement) => relationsOf(statement.text)));
    const referenceRelations = [...relations].filter((relation) => relation.startsWith("reference."));
    expect(referenceRelations.sort()).toEqual([
      "reference.airlines",
      "reference.airports",
      "reference.cities",
      "reference.countries",
      "reference.currencies",
    ]);
    for (const relation of relations) {
      const [schema, table] = relation.includes(".") ? relation.split(".") : [undefined, relation];
      expect(schema === undefined && tenantTables.has(table ?? ""), relation).toBe(false);
      expect(["reference", "platform", "pg_catalog"], relation).toContain(schema);
    }
    // The reads ran in tenantTx transactions on the caller's tenant: search_path "<tenant schema>, reference".
    const searchPaths = statements
      .filter((statement) => statement.text.includes("set_config('search_path'"))
      .map((statement) => statement.values[0]);
    expect(searchPaths.length).toBeGreaterThanOrEqual(MODES.length * OPERATIONS.length);
    expect(new Set(searchPaths)).toEqual(new Set(["tenant_alpha, reference"]));
  });
});
