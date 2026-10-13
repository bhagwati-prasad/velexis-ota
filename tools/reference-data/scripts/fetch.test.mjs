// Tests of scripts/fetch.mjs (task X-017). The mapping runs on small fixture sources and a fake fetch, so no test
// touches the network; the last block checks the committed snapshot in data/ and SOURCES.md, offline.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

import {
  ATTRIBUTION,
  CLDR_TAG,
  EU_MEMBERS,
  MAX_DATA_BYTES,
  airportKind,
  buildDatasets,
  callingCode,
  checkSnapshot,
  coordinate,
  recordedOutputs,
  refresh,
  searchRank,
  sha256,
  sourcesFor,
  tableCsv,
  utcOffsetMinutes,
} from "./fetch.mjs";
import { LOAD_ORDER, PACKAGE_DIR, TABLES, parseCsv, validateData } from "./validate.mjs";

const SCRIPT = path.join(PACKAGE_DIR, "scripts", "fetch.mjs");
const DATA_DIR = path.join(PACKAGE_DIR, "data");
const SOURCES_FILE = path.join(PACKAGE_DIR, "SOURCES.md");
const TODAY = "2026-10-13";

const scratch = mkdtempSync(path.join(tmpdir(), "x017-reference-data-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---- Fixture sources ------------------------------------------------------------------------------------

/** @param {string[]} header @param {Record<string, string>[]} rows */
const caret = (header, rows) =>
  [header.join("^"), ...rows.map((r) => header.map((h) => r[h] ?? "").join("^"))].join("\n") + "\n";

const POR_HEADER = (
  "iata_code^icao_code^faa_code^is_geonames^geoname_id^envelope_id^name^asciiname^latitude^longitude^fclass^fcode^" +
  "page_rank^date_from^date_until^comment^country_code^cc2^country_name^continent_name^adm1_code^adm1_name_utf^" +
  "adm1_name_ascii^adm2_code^adm2_name_utf^adm2_name_ascii^adm3_code^adm4_code^population^elevation^gtopo30^" +
  "timezone^gmt_offset^dst_offset^raw_offset^moddate^city_code_list^city_name_list^city_detail_list^tvl_por_list^" +
  "iso31662^location_type^wiki_link^alt_name_section^wac^wac_name^ccy_code^unlc_list^uic_list^geoname_lat^geoname_lon"
).split("^");

const POR = caret(POR_HEADER, [
  // Cities
  {
    iata_code: "PAR",
    geoname_id: "2988507",
    name: "Paris",
    latitude: "48.85341",
    longitude: "2.3488",
    fcode: "PPLC",
    page_rank: "0.6066943",
    country_code: "FR",
    iso31662: "IDF",
    timezone: "Europe/Paris",
    city_code_list: "PAR",
    city_detail_list: "PAR|2988507|Paris|Paris|FR|IDF",
    location_type: "C",
  },
  {
    iata_code: "NYC",
    geoname_id: "5128581",
    name: "New York City",
    latitude: "40.71427",
    longitude: "-74.00597",
    fcode: "PPL",
    page_rank: "0.7352724",
    country_code: "US",
    iso31662: "NY",
    timezone: "America/New_York",
    city_code_list: "NYC",
    city_detail_list: "NYC|5128581|New York City|New York City|US|NY",
    location_type: "C",
  },
  // A combined city + airport row: the city is named from its own served-city entry, not after the airport.
  {
    iata_code: "BER",
    icao_code: "EDDB",
    geoname_id: "1",
    name: "Berlin Brandenburg Airport",
    latitude: "52.36667",
    longitude: "13.50333",
    fcode: "AIRP",
    page_rank: "0.3",
    country_code: "DE",
    iso31662: "BB",
    elevation: "48",
    timezone: "Europe/Berlin",
    city_code_list: "BER",
    city_detail_list: "BER|2950159|Berlin|Berlin|DE|BE",
    location_type: "CA",
  },
  // Airports
  {
    iata_code: "CDG",
    icao_code: "LFPG",
    geoname_id: "6269554",
    name: "Paris Charles de Gaulle Airport",
    latitude: "49.0127799",
    longitude: "2.55",
    fcode: "AIRP",
    page_rank: "0.5651009350250907",
    country_code: "FR",
    elevation: "119",
    timezone: "Europe/Paris",
    city_code_list: "PAR",
    city_detail_list: "PAR|2988507|Paris|Paris|FR|IDF",
    location_type: "A",
  },
  {
    iata_code: "EWR",
    icao_code: "KEWR",
    geoname_id: "5101809",
    name: "Newark Liberty International Airport",
    latitude: "40.69125",
    longitude: "-74.17883",
    fcode: "AIRP",
    page_rank: "0.4686782",
    country_code: "US",
    elevation: "3",
    timezone: "America/New_York",
    city_code_list: "NYC,EWR,ZME",
    city_detail_list: "NYC|5128581|New York City|New York City|US|NY=EWR|5101798|Newark|Newark|US|NJ",
    location_type: "A",
  },
  // The same code twice: a closed airfield and the rail station that uses the code now.
  {
    iata_code: "AAW",
    geoname_id: "10",
    envelope_id: "1",
    name: "Aachen Old Airfield",
    latitude: "50.8",
    longitude: "6.1",
    fcode: "AIRF",
    date_until: "2013-02-01",
    country_code: "DE",
    timezone: "Europe/Berlin",
    city_code_list: "AAH",
    city_detail_list: "AAH|3247449|Aachen|Aachen|DE|NW",
    location_type: "A",
  },
  {
    iata_code: "AAW",
    geoname_id: "11",
    name: "Aachen West Station",
    latitude: "50.78065",
    longitude: "6.07123",
    fcode: "RSTN",
    date_from: "2016-01-01",
    country_code: "DE",
    timezone: "Europe/Berlin",
    city_code_list: "AAH",
    city_detail_list: "AAH|3247449|Aachen|Aachen|DE|NW",
    location_type: "R",
  },
  // Closed only, and it shares CDG's ICAO code: it stays inactive and loses the code.
  {
    iata_code: "QQQ",
    icao_code: "LFPG",
    geoname_id: "12",
    name: "Old Paris Field",
    latitude: "48.9",
    longitude: "2.4",
    fcode: "AIRF",
    date_until: "2010-01-01",
    country_code: "FR",
    timezone: "Europe/Paris",
    city_code_list: "PAR",
    city_detail_list: "PAR|2988507|Paris|Paris|FR|IDF",
    location_type: "A",
  },
  {
    iata_code: "SPB",
    geoname_id: "13",
    name: "Harbour Seaplane Base",
    latitude: "40.7",
    longitude: "-74.0",
    fcode: "AIRS",
    country_code: "US",
    timezone: "America/New_York",
    city_code_list: "NYC",
    city_detail_list: "NYC|5128581|New York City|New York City|US|NY",
    location_type: "A",
  },
  {
    iata_code: "JRA",
    geoname_id: "14",
    name: "West 30th Street Heliport",
    latitude: "40.75",
    longitude: "-74.0",
    fcode: "AIRH",
    country_code: "US",
    timezone: "America/New_York",
    city_code_list: "NYC",
    city_detail_list: "NYC|5128581|New York City|New York City|US|NY",
    location_type: "H",
  },
  {
    iata_code: "XBU",
    geoname_id: "15",
    name: "Port Authority Bus Terminal",
    latitude: "40.757",
    longitude: "-73.991",
    fcode: "BUSTN",
    country_code: "US",
    timezone: "Mars/Olympus",
    city_code_list: "NYC",
    city_detail_list: "NYC|5128581|New York City|New York City|US|NY",
    location_type: "B",
  },
  // Not airports: a port, an off-line point, a country outside countries.csv, an invalid code.
  {
    iata_code: "XPT",
    name: "Some Port",
    fcode: "PRT",
    country_code: "FR",
    timezone: "Europe/Paris",
    location_type: "P",
  },
  {
    iata_code: "XOF",
    name: "Offline Point",
    fcode: "PPL",
    country_code: "FR",
    timezone: "Europe/Paris",
    location_type: "O",
  },
  {
    iata_code: "ZZA",
    name: "Nowhere Airport",
    fcode: "AIRP",
    country_code: "ZZ",
    timezone: "Europe/Paris",
    location_type: "A",
  },
  {
    iata_code: "ab1",
    name: "Bad Code Airport",
    fcode: "AIRP",
    country_code: "FR",
    timezone: "Europe/Paris",
    location_type: "A",
  },
]);

const AIRLINES = caret(
  (
    "pk^env_id^validity_from^validity_to^3char_code^2char_code^num_code^name^name2^alliance_code^alliance_status^" +
    "type^wiki_link^flt_freq^alt_names^bases^key^version^parent_pk_list^successor_pk_list"
  ).split("^"),
  [
    {
      pk: "air-air-france-v1",
      "3char_code": "AFR",
      "2char_code": "AF",
      num_code: "57",
      name: "Air France",
      alliance_code: "Skyteam",
      alliance_status: "Member",
      flt_freq: "300000",
      bases: "CDG=PAR",
    },
    // Bases in two countries: the first base is not necessarily the home one, so the country stays empty.
    {
      pk: "air-two-countries-v1",
      "3char_code": "TWC",
      "2char_code": "T2",
      num_code: "0",
      name: "Two Countries Air",
      flt_freq: "10",
      bases: "CDG=EWR=NYC",
    },
    {
      pk: "air-lufthansa-cargo-v1",
      "3char_code": "GEC",
      "2char_code": "LH",
      num_code: "20",
      name: "Lufthansa Cargo",
      type: "C",
      validity_from: "1977-01-01",
    },
    {
      pk: "air-lufthansa-v1",
      "3char_code": "DLH",
      "2char_code": "LH",
      num_code: "220",
      name: "Lufthansa",
      alliance_code: "Star Alliance",
      alliance_status: "Member",
      flt_freq: "338012",
      bases: "FRA=MUC",
    },
    {
      pk: "air-american-airlines-v1",
      "3char_code": "AAL",
      "2char_code": "AA",
      num_code: "1",
      name: "American Airlines",
      alliance_code: "OneWorld",
      alliance_status: "Affiliate",
      flt_freq: "900000",
      bases: "NYC",
    },
    {
      pk: "air-former-v1",
      env_id: "1",
      validity_to: "2010-01-01",
      "3char_code": "AFR",
      "2char_code": "ZF",
      num_code: "0",
      name: "Former Airline",
      alliance_code: "Skyteam",
      alliance_status: "Former",
    },
    { pk: "trn-sncf-v1", "2char_code": "2C", num_code: "0", name: "SNCF", type: "R" },
    { pk: "gds-amadeus-v1", "2char_code": "1A", name: "Amadeus", type: "G" },
    { pk: "alc-star-alliance-v1", "2char_code": "*A", num_code: "0", name: "Star Alliance" },
  ],
);

const AIRCRAFT = caret(
  "iata_code^manufacturer^model^iata_group^iata_category^icao_code^nb_engines^aircraft_type".split("^"),
  [
    {
      iata_code: "320",
      manufacturer: "Airbus",
      model: "A320-100/200",
      iata_group: "32S",
      icao_code: "A320",
      aircraft_type: "J",
    },
    { iata_code: "330", manufacturer: "Airbus", model: "A330" },
    {
      iata_code: "351",
      manufacturer: "Airbus",
      model: "A350-1000",
      iata_group: "350",
      icao_code: "ZZZZ",
      aircraft_type: "J",
    },
    {
      iata_code: "77W",
      manufacturer: "Boeing",
      model: "777-300ER",
      iata_group: "777",
      icao_code: "B77W",
      aircraft_type: "J",
    },
    {
      iata_code: "AT7",
      manufacturer: "ATR",
      model: "ATR 72",
      iata_group: "ATR",
      icao_code: "AT72",
      aircraft_type: "T",
    },
    { iata_code: "ATR", manufacturer: "ATR", model: "ATR 42 / ATR 72" },
    {
      iata_code: "BH2",
      manufacturer: "Bell Helicopter",
      model: "Bell Helicopters",
      iata_group: "BH2",
      icao_code: "*",
      aircraft_type: "H",
    },
    { iata_code: "CNA", manufacturer: "Cessna", model: "Cessna light aircraft" },
    {
      iata_code: "CR9",
      manufacturer: "Canadair",
      model: "CRJ 900",
      iata_group: "CRJ",
      icao_code: "CRJ9",
      aircraft_type: "J",
    },
    {
      iata_code: "D42",
      manufacturer: "Diamond Aircraft",
      model: " DA42 Twin Star",
      icao_code: "DA42",
      aircraft_type: "P",
    },
    { iata_code: "HOV", model: "Surface Equipment-Hovercraft", icao_code: "0000", aircraft_type: "S" },
    { iata_code: "x1y", manufacturer: "Nobody", model: "Invalid code" },
  ],
);

const OPTD_COUNTRIES = caret(
  (
    "iso_2char_code^iso_3char_code^iso_num_code^fips^name^cptl^area^pop^cont_code^tld^ccy_code^ccy_name^tel_pfx^" +
    "zip_fmt^lang_code_list^geo_id^ngbr_ctry_code_list"
  ).split("^"),
  [
    { iso_2char_code: "CS", cont_code: "EU", tel_pfx: "381" },
    { iso_2char_code: "DE", cont_code: "EU", tel_pfx: "49" },
    { iso_2char_code: "FR", cont_code: "EU", tel_pfx: "33" },
    { iso_2char_code: "PR", cont_code: "NA", tel_pfx: "+1-787 and 1-939" },
    { iso_2char_code: "US", cont_code: "NA", tel_pfx: "1" },
    { iso_2char_code: "XK", cont_code: "EU", tel_pfx: "" },
  ],
);

const CLDR = {
  territories: {
    main: {
      en: {
        localeDisplayNames: {
          territories: {
            "001": "world",
            AC: "Ascension Island",
            DE: "Germany",
            EU: "European Union",
            FR: "France",
            PR: "Puerto Rico",
            US: "United States",
            "US-alt-short": "US",
            XK: "Kosovo",
          },
        },
      },
    },
  },
  codeMappings: {
    supplemental: {
      codeMappings: {
        AC: { _alpha3: "ASC" },
        DE: { _numeric: "276", _alpha3: "DEU" },
        EU: { _numeric: "967", _alpha3: "QUU" },
        FR: { _numeric: "250", _alpha3: "FRA" },
        PR: { _numeric: "630", _alpha3: "PRI" },
        US: { _numeric: "840", _alpha3: "USA" },
        XK: { _numeric: "983", _alpha3: "XKK" },
        AUD: { _numeric: "36" },
        BGN: { _numeric: "975" },
        EUR: { _numeric: "978" },
        JPY: { _numeric: "392" },
        USD: { _numeric: "840" },
      },
    },
  },
  currencyData: {
    supplemental: {
      currencyData: {
        fractions: { DEFAULT: { _rounding: "0", _digits: "2" }, JPY: { _rounding: "0", _digits: "0" } },
        region: {
          AU: [{ AUD: { _from: "1966-02-14" } }],
          BG: [{ EUR: { _from: "2026-01-01" } }, { BGN: { _from: "1999-07-05", _to: "2026-01-31" } }],
          DE: [{ EUR: { _from: "1999-01-01" } }, { DEM: { _from: "1948-06-20", _to: "2002-02-28" } }],
          FR: [{ EUR: { _from: "1999-01-01" } }, { FRF: { _from: "1960-01-01", _to: "2002-02-17" } }],
          JP: [{ JPY: { _from: "1871-06-01" } }],
          PR: [{ USD: { _from: "1898-12-10" } }],
          US: [{ USD: { _from: "1792-01-01" } }, { USN: { _tender: "false" } }],
          XK: [{ EUR: { _from: "2002-01-01" } }],
        },
      },
    },
  },
  currencies: {
    main: {
      en: {
        numbers: {
          currencies: {
            AUD: { displayName: "Australian Dollar", symbol: "A$" },
            BGN: { displayName: "Bulgarian Lev", symbol: "BGN" },
            DEM: { displayName: "German Mark" },
            EUR: { displayName: "Euro", symbol: "€" },
            FRF: { displayName: "French Franc" },
            JPY: { displayName: "Japanese Yen", symbol: "¥" },
            USD: { displayName: "US Dollar", symbol: "$" },
            USN: { displayName: "US Dollar (Next day)" },
            XAU: { displayName: "Gold" },
          },
        },
      },
    },
  },
  timezones: {
    keyword: {
      u: {
        tz: {
          _description: "Time zone key",
          _alias: "timezone",
          camtr: { _deprecated: true, _description: "Montreal, Canada", _preferred: "cator" },
          deber: { _description: "Berlin, Germany", _alias: "Europe/Berlin" },
          est5edt: { _description: "POSIX style time zone", _alias: "EST5EDT" },
          frpar: { _description: "Paris, France", _alias: "Europe/Paris" },
          inccu: {
            _description: "Kolkata, India",
            _alias: "Asia/Calcutta Asia/Kolkata",
            _iana: "Asia/Kolkata",
          },
          jeruslm: { _description: "Jerusalem", _alias: "Asia/Jerusalem", _region: "IL" },
          unk: { _description: "Unknown time zone", _alias: "Etc/Unknown Factory" },
          usnyc: { _description: "New York, United States", _alias: "America/New_York US/Eastern" },
          utc: { _description: "UTC", _alias: "Etc/UTC UTC" },
        },
      },
    },
  },
};

const OPTD_README =
  "# Licensing\nThe data curated and/or generated by the OPTD project are governed by the\n" +
  "[CC-BY license](http://creativecommons.org/licenses/by/4.0/).\n";
const CLDR_LICENSE =
  "UNICODE LICENSE V3\n\nCOPYRIGHT AND PERMISSION NOTICE\n\nCopyright © 1991-2025 Unicode, Inc.\n";

/** Raw text by source id, as refresh() decodes the downloads. */
const RAW = {
  por: POR,
  airlines: AIRLINES,
  aircraft: AIRCRAFT,
  countries: OPTD_COUNTRIES,
  readme: OPTD_README,
  territories: JSON.stringify(CLDR.territories),
  codeMappings: JSON.stringify(CLDR.codeMappings),
  currencyData: JSON.stringify(CLDR.currencyData),
  currencies: JSON.stringify(CLDR.currencies),
  timezones: JSON.stringify(CLDR.timezones),
  licence: CLDR_LICENSE,
};

/**
 * A fetch that serves RAW by source URL and records the calls.
 * @param {Partial<Record<string, string | null>>} [changes] text by source id; null answers 404
 */
function fakeFetch(changes = {}) {
  const byUrl = new Map(sourcesFor(CLDR_TAG).map((s) => [s.url, s.id]));
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const impl = async (input) => {
    const url = String(input);
    calls.push(url);
    const id = byUrl.get(url);
    const body =
      id === undefined
        ? null
        : Object.hasOwn(changes, id)
          ? changes[id]
          : RAW[/** @type {keyof typeof RAW} */ (id)];
    return body === null || body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body);
  };
  return { impl, calls };
}

/** @param {Record<string, string | number | boolean | null>[]} rows @param {string} key */
const byKey = (rows, key) => new Map(rows.map((r) => [String(r[key]), r]));

// ---- Helpers --------------------------------------------------------------------------------------------

describe("mapping helpers", () => {
  test("coordinates are rounded to numeric(9,6) without trailing zeros [X-017 AC1]", () => {
    expect(coordinate("49.0127799", 90)).toBe("49.01278");
    expect(coordinate("48.853410", 90)).toBe("48.85341");
    expect(coordinate("-0.0000001", 180)).toBe("0");
    expect(coordinate("2", 180)).toBe("2");
    expect(coordinate("", 90)).toBeNull();
    expect(coordinate("91", 90)).toBeNull();
    expect(coordinate("abc", 180)).toBeNull();
  });

  test("search_rank is the OPTD page rank x 1,000,000, rounded [X-017 AC1]", () => {
    expect(searchRank("0.5651009350250907")).toBe(565101);
    expect(searchRank("0.009025664692460503")).toBe(9026);
    expect(searchRank("")).toBe(0);
  });

  test("calling codes keep the country code of OPTD's telephone prefix [X-017 AC1]", () => {
    expect(callingCode("33")).toBe("33");
    expect(callingCode("+1-268")).toBe("1");
    expect(callingCode("+44-1481")).toBe("44");
    expect(callingCode("+1-809 and 1-829")).toBe("1");
    expect(callingCode("")).toBeNull();
    expect(callingCode(" ")).toBeNull();
  });

  test("UTC offsets come from Intl [X-017 AC1]", () => {
    expect(utcOffsetMinutes("Europe/Paris", new Date(Date.UTC(2026, 0, 15, 12)))).toBe(60);
    expect(utcOffsetMinutes("Europe/Paris", new Date(Date.UTC(2026, 6, 15, 12)))).toBe(120);
    expect(utcOffsetMinutes("Asia/Kolkata", new Date(Date.UTC(2026, 6, 15, 12)))).toBe(330);
    expect(utcOffsetMinutes("America/St_Johns", new Date(Date.UTC(2026, 0, 15, 12)))).toBe(-210);
    expect(utcOffsetMinutes("UTC", new Date(Date.UTC(2026, 0, 15, 12)))).toBe(0);
  });

  test("the airport kind follows the OPTD location type and feature code [X-017 AC1]", () => {
    expect(airportKind({ location_type: "A", fcode: "AIRP" })).toBe("airport");
    expect(airportKind({ location_type: "CA", fcode: "AIRF" })).toBe("airport");
    expect(airportKind({ location_type: "A", fcode: "AIRS" })).toBe("seaplane_base");
    expect(airportKind({ location_type: "A", fcode: "AIRH" })).toBe("heliport");
    expect(airportKind({ location_type: "CH", fcode: "AIRH" })).toBe("heliport");
    expect(airportKind({ location_type: "R", fcode: "RSTN" })).toBe("rail_station");
    expect(airportKind({ location_type: "CB", fcode: "BUSTN" })).toBe("bus_station");
    expect(airportKind({ location_type: "C", fcode: "PPLC" })).toBeNull();
    expect(airportKind({ location_type: "P", fcode: "PRT" })).toBeNull();
    expect(airportKind({ location_type: "O", fcode: "PPL" })).toBeNull();
  });

  test("the EU list has the 27 member states [X-017 AC1]", () => {
    expect(EU_MEMBERS.size).toBe(27);
    expect(EU_MEMBERS.has("FR")).toBe(true);
    expect(EU_MEMBERS.has("GB")).toBe(false);
  });
});

// ---- Mapping on fixture sources -------------------------------------------------------------------------

describe("buildDatasets on fixture sources", () => {
  const { tables, notes } = buildDatasets(RAW, { today: TODAY });

  test("airports: IATA-coded airports, heliports, rail and bus stations, with resolvable links [X-017 AC3]", () => {
    const airports = byKey(tables.airports, "iata_code");
    expect([...airports.keys()]).toEqual(["AAW", "BER", "CDG", "EWR", "JRA", "QQQ", "SPB", "XBU"]);
    expect(airports.get("CDG")).toEqual({
      iata_code: "CDG",
      icao_code: "LFPG",
      name: "Paris Charles de Gaulle Airport",
      city_code: "PAR",
      city_name: "Paris",
      country_code: "FR",
      time_zone: "Europe/Paris",
      latitude: "49.01278",
      longitude: "2.55",
      elevation_ft: 390,
      kind: "airport",
      is_active: true,
      search_rank: 565101,
    });
    // The open rail station wins over the closed airfield with the same code; no city AAH, so no city_code.
    expect(airports.get("AAW")).toMatchObject({
      name: "Aachen West Station",
      kind: "rail_station",
      is_active: true,
      city_code: null,
      city_name: "Aachen",
    });
    // Closed: kept as inactive, and CDG keeps the shared ICAO code.
    expect(airports.get("QQQ")).toMatchObject({ is_active: false, icao_code: null, city_code: "PAR" });
    // The first served city that is a city wins: NYC for EWR.
    expect(airports.get("EWR")).toMatchObject({
      city_code: "NYC",
      city_name: "New York City",
      elevation_ft: 10,
    });
    expect(airports.get("SPB")).toMatchObject({ kind: "seaplane_base" });
    expect(airports.get("JRA")).toMatchObject({ kind: "heliport" });
    // A zone outside time_zones.csv becomes NULL rather than a broken foreign key, and SOURCES.md names it.
    expect(airports.get("XBU")).toMatchObject({ kind: "bus_station", time_zone: null });
    expect(notes).toEqual(
      expect.arrayContaining([
        "1 OPTD locations skipped, their country is not in countries.csv: ZZA (ZZ)",
        "1 airports keep city_code empty, OPTD names no served city that is a city: AAW",
        "1 cities and airports keep time_zone empty, their IANA zone is not in time_zones.csv: XBU (Mars/Olympus)",
        "1 airports lose an ICAO code that a more relevant airport keeps (UNIQUE): QQQ (LFPG stays with CDG)",
        "1 airlines lose an ICAO code that a more relevant airline keeps (UNIQUE): ZF (AFR stays with AF)",
        "1 aircraft keep body_type empty, the source gives no type: CNA",
      ]),
    );
  });

  test("cities: the OPTD city codes, named after the city, with states for US, CA, AU and BR [X-017 AC3]", () => {
    const cities = byKey(tables.cities, "iata_code");
    expect([...cities.keys()]).toEqual(["BER", "NYC", "PAR"]);
    expect(cities.get("PAR")).toEqual({
      iata_code: "PAR",
      name: "Paris",
      country_code: "FR",
      state_code: null,
      time_zone: "Europe/Paris",
      latitude: "48.85341",
      longitude: "2.3488",
      search_rank: 606694,
    });
    expect(cities.get("NYC")).toMatchObject({ state_code: "NY", time_zone: "America/New_York" });
    expect(cities.get("BER")).toMatchObject({ name: "Berlin", state_code: null });
  });

  test("countries: ISO 3166-1 codes from CLDR plus XK, with OPTD continents and calling codes [X-017 AC2]", () => {
    const countries = byKey(tables.countries, "code");
    expect([...countries.keys()]).toEqual(["DE", "FR", "PR", "US", "XK"]);
    expect(countries.get("FR")).toEqual({
      code: "FR",
      alpha3: "FRA",
      numeric_code: "250",
      name: "France",
      official_name: null,
      continent_code: "EU",
      currency_code: "EUR",
      calling_code: "33",
      is_eu: true,
    });
    expect(countries.get("PR")).toMatchObject({ calling_code: "1", currency_code: "USD", is_eu: false });
    expect(countries.get("XK")).toMatchObject({ alpha3: null, numeric_code: null, calling_code: null });
  });

  test("currencies: CLDR names, symbols and minor units; inactive unless legal tender today [X-017 AC2]", () => {
    const currencies = byKey(tables.currencies, "code");
    expect([...currencies.keys()]).toEqual(["AUD", "BGN", "DEM", "EUR", "FRF", "JPY", "USD", "USN", "XAU"]);
    expect(currencies.get("EUR")).toEqual({
      code: "EUR",
      numeric_code: "978",
      name: "Euro",
      symbol: "€",
      minor_units: 2,
      is_active: true,
    });
    expect(currencies.get("JPY")).toMatchObject({ minor_units: 0, is_active: true });
    // CLDR drops the leading zero of 036.
    expect(currencies.get("AUD")).toMatchObject({ numeric_code: "036", symbol: "A$", is_active: true });
    // Historic, ended before the snapshot (Bulgaria moved to the euro), a funds code, a metal.
    for (const code of ["FRF", "DEM", "BGN", "USN", "XAU"]) {
      expect(currencies.get(code)?.is_active, code).toBe(false);
    }
    expect(currencies.get("FRF")).toMatchObject({ numeric_code: null, symbol: null });
  });

  test("time zones: every CLDR IANA name with its country and January / July offsets [X-017 AC3]", () => {
    const zones = byKey(tables.time_zones, "name");
    expect([...zones.keys()].sort()).toEqual(
      [
        "America/New_York",
        "Asia/Calcutta",
        "Asia/Jerusalem",
        "Asia/Kolkata",
        "EST5EDT",
        "Etc/UTC",
        "Europe/Berlin",
        "Europe/Paris",
        "US/Eastern",
        "UTC",
      ].sort(),
    );
    expect(zones.get("Europe/Paris")).toEqual({
      name: "Europe/Paris",
      country_code: "FR",
      utc_offset_minutes: 60,
      dst_offset_minutes: 120,
    });
    expect(zones.get("US/Eastern")).toMatchObject({ country_code: "US", utc_offset_minutes: -300 });
    // India is not in the fixture countries; EST5EDT is not Spain; UTC has no country.
    expect(zones.get("Asia/Kolkata")).toMatchObject({
      country_code: null,
      utc_offset_minutes: 330,
      dst_offset_minutes: null,
    });
    expect(zones.get("EST5EDT")).toMatchObject({ country_code: null });
    expect(zones.get("UTC")).toMatchObject({
      country_code: null,
      utc_offset_minutes: 0,
      dst_offset_minutes: null,
    });
  });

  test("airlines: carriers with an IATA code, one per code, open and busiest first [X-017 AC2]", () => {
    const airlines = byKey(tables.airlines, "iata_code");
    expect([...airlines.keys()]).toEqual(["2C", "AA", "AF", "LH", "T2", "ZF"]);
    expect(airlines.get("AF")).toEqual({
      iata_code: "AF",
      icao_code: "AFR",
      name: "Air France",
      common_name: null,
      country_code: "FR",
      accounting_code: "057",
      alliance: "skyteam",
      is_low_cost: false,
      is_active: true,
      logo_url: null,
    });
    expect(airlines.get("LH")).toMatchObject({
      name: "Lufthansa",
      icao_code: "DLH",
      accounting_code: "220",
      alliance: "star_alliance",
      country_code: null,
    });
    expect(airlines.get("AA")).toMatchObject({
      accounting_code: "001",
      alliance: "oneworld",
      country_code: "US",
    });
    expect(airlines.get("ZF")).toMatchObject({
      is_active: false,
      icao_code: null,
      alliance: null,
      accounting_code: null,
    });
    expect(airlines.get("2C")).toMatchObject({ name: "SNCF", icao_code: null });
    // Every base (airport or city) in one country gives that country; bases in several countries give none.
    expect(airlines.get("T2")).toMatchObject({ country_code: null, accounting_code: null });
    expect(notes).toContain(
      "1 airlines keep country_code empty, their bases lie in several countries: T2 (FR, US)",
    );
  });

  test("aircraft: names, ICAO designators without placeholders, body types [X-017 AC2]", () => {
    const aircraft = byKey(tables.aircraft, "iata_code");
    expect([...aircraft.keys()]).toEqual([
      "320",
      "330",
      "351",
      "77W",
      "AT7",
      "ATR",
      "BH2",
      "CNA",
      "CR9",
      "D42",
      "HOV",
    ]);
    expect(aircraft.get("320")).toEqual({
      iata_code: "320",
      icao_code: "A320",
      name: "Airbus A320-100/200",
      manufacturer: "Airbus",
      body_type: "narrow",
    });
    expect(Object.fromEntries([...aircraft].map(([code, a]) => [code, a.body_type]))).toEqual({
      320: "narrow",
      330: "wide",
      351: "wide",
      "77W": "wide",
      AT7: "turboprop",
      ATR: "turboprop",
      BH2: "helicopter",
      CNA: null,
      CR9: "regional",
      D42: "other",
      HOV: "other",
    });
    expect(aircraft.get("351")?.icao_code).toBeNull();
    expect(aircraft.get("BH2")).toMatchObject({ icao_code: null, name: "Bell Helicopters" });
    expect(aircraft.get("D42")).toMatchObject({ name: "Diamond Aircraft DA42 Twin Star" });
    expect(aircraft.get("HOV")).toMatchObject({ manufacturer: null, icao_code: null });
  });

  test("the result is deterministic and passes validate.mjs [X-017 AC1]", () => {
    const again = buildDatasets(RAW, { today: TODAY });
    /** @type {Record<string, string>} */
    const files = { "overrides.csv": "table,key,column,value\n" };
    for (const name of LOAD_ORDER) {
      files[TABLES[name].file] = tableCsv(name, tables[name]);
      expect(tableCsv(name, again.tables[name])).toBe(files[TABLES[name].file]);
    }
    expect(validateData(files, { minRows: null }).problems).toEqual([]);
    expect(files["airports.csv"].split("\n")[0]).toBe(
      "iata_code,icao_code,name,city_code,city_name,country_code,time_zone,latitude,longitude,elevation_ft,kind," +
        "is_active,search_rank",
    );
  });

  test("a changed source format stops the build [X-017 AC1]", () => {
    expect(() => buildDatasets({ ...RAW, por: "iata_code^name\nCDG^Paris\n" }, { today: TODAY })).toThrow(
      /optd_por_public\.csv: the source format changed, missing columns icao_code/,
    );
    expect(() => buildDatasets({ ...RAW, aircraft: `${AIRCRAFT}320^Airbus\n` }, { today: TODAY })).toThrow(
      /optd_aircraft\.csv:\d+: 2 fields, expected 8/,
    );
  });
});

// ---- The download mode, with a fake fetch ---------------------------------------------------------------

describe("refresh (download mode) with a fake fetch", () => {
  /** @param {string} name */
  const packageDir = (name) => mkdtempSync(path.join(scratch, `${name}-`));
  const quiet = () => {};

  test("writes the seven files, an empty overrides.csv and SOURCES.md with URL, licence, SHA-256 and attribution [X-017 AC4]", async () => {
    const dir = packageDir("refresh");
    const dataDir = path.join(dir, "data");
    const { impl, calls } = fakeFetch();
    await refresh({ dataDir, today: TODAY, fetchImpl: impl, minRows: null, log: quiet });

    const sources = sourcesFor(CLDR_TAG);
    expect(calls).toEqual(sources.map((s) => s.url));
    expect(readdirSync(dataDir).sort()).toEqual(
      [...LOAD_ORDER.map((t) => TABLES[t].file), "overrides.csv"].sort(),
    );
    expect(readFileSync(path.join(dataDir, "overrides.csv"), "utf8")).toBe("table,key,column,value\n");

    const markdown = readFileSync(path.join(dir, "SOURCES.md"), "utf8");
    expect(markdown).toContain(`> ${ATTRIBUTION}`);
    expect(markdown).toContain(`| Retrieval date | ${TODAY} (UTC) |`);
    for (const source of sources) {
      const bytes = Buffer.from(RAW[/** @type {keyof typeof RAW} */ (source.id)]);
      expect(markdown).toContain(
        `| ${source.publisher} | \`${source.file}\` | <${source.url}> | ${source.licence} | ${bytes.length} | ` +
          `\`${sha256(bytes)}\` |`,
      );
    }
    expect(markdown).toContain("[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)");
    expect(markdown).toContain("[Unicode License v3](https://www.unicode.org/license.txt)");
    expect(markdown).toContain(CLDR_LICENSE.trimEnd());
    const outputs = recordedOutputs(markdown);
    for (const name of LOAD_ORDER) {
      const file = TABLES[name].file;
      expect(outputs.get(file), file).toBe(sha256(readFileSync(path.join(dataDir, file))));
    }
    expect(checkSnapshot(dataDir, { minRows: null }).problems).toEqual([]);
  });

  test("a second refresh writes the same bytes and keeps overrides.csv [X-017 AC1]", async () => {
    const dir = packageDir("refresh-twice");
    const dataDir = path.join(dir, "data");
    await refresh({ dataDir, today: TODAY, fetchImpl: fakeFetch().impl, minRows: null, log: quiet });
    const first = Object.fromEntries(
      readdirSync(dataDir).map((f) => [f, readFileSync(path.join(dataDir, f))]),
    );
    const sourcesBefore = readFileSync(path.join(dir, "SOURCES.md"), "utf8");
    const override = "table,key,column,value\nairports,QQQ,name,Old Paris Airfield\n";
    writeFileSync(path.join(dataDir, "overrides.csv"), override);

    await refresh({ dataDir, today: TODAY, fetchImpl: fakeFetch().impl, minRows: null, log: quiet });
    for (const [file, bytes] of Object.entries(first)) {
      if (file !== "overrides.csv") {
        expect(readFileSync(path.join(dataDir, file)).equals(bytes), file).toBe(true);
      }
    }
    expect(readFileSync(path.join(dataDir, "overrides.csv"), "utf8")).toBe(override);
    expect(readFileSync(path.join(dir, "SOURCES.md"), "utf8")).toBe(sourcesBefore);
  });

  test.each([
    [
      "the OpenTravelData licence statement changed",
      { readme: "# Licensing\nAll rights reserved.\n" },
      /no longer states CC BY 4\.0/,
    ],
    ["the CLDR licence changed", { licence: "SOME OTHER LICENSE\n" }, /no longer the Unicode License v3/],
    ["a download failed", { aircraft: null }, /optd_aircraft\.csv: HTTP 404/],
    [
      "the result is too small",
      {},
      /the new snapshot is invalid; nothing was written:\n {2}currencies\.csv: 9 rows, fewer than/,
    ],
  ])("writes nothing when %s [X-017 AC1]", async (_label, changes, message) => {
    const dir = packageDir("refresh-refused");
    const dataDir = path.join(dir, "data");
    const minRows = Object.keys(changes).length === 0 ? undefined : null;
    await expect(
      refresh({ dataDir, today: TODAY, fetchImpl: fakeFetch(changes).impl, minRows, log: quiet }),
    ).rejects.toThrow(message);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(path.join(dir, "SOURCES.md"))).toBe(false);
  });

  test("an invalid overrides.csv stops a refresh before anything is written [X-017 AC1]", async () => {
    const dir = packageDir("refresh-bad-override");
    const dataDir = path.join(dir, "data");
    await refresh({ dataDir, today: TODAY, fetchImpl: fakeFetch().impl, minRows: null, log: quiet });
    const before = readFileSync(path.join(dir, "SOURCES.md"), "utf8");
    writeFileSync(path.join(dataDir, "overrides.csv"), "table,key,column,value\nairports,CDG,kind,port\n");
    await expect(
      refresh({ dataDir, today: "2026-10-14", fetchImpl: fakeFetch().impl, minRows: null, log: quiet }),
    ).rejects.toThrow(/overrides\.csv:2: value "port" is not one of/);
    expect(readFileSync(path.join(dir, "SOURCES.md"), "utf8")).toBe(before);
  });
});

// ---- The committed snapshot (offline) -------------------------------------------------------------------

/** @param {string} file */
const committed = (file) => {
  const [header, ...rows] = parseCsv(readFileSync(path.join(DATA_DIR, file), "utf8"));
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i]])));
};

/** Run fetch.mjs with a preload that makes any network call fail. */
function runOffline(/** @type {string[]} */ ...args) {
  const preload = path.join(scratch, "no-network.mjs");
  writeFileSync(
    preload,
    'globalThis.fetch = () => { throw new Error("network access is disabled in this test"); };\n',
  );
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_USE_ENV_PROXY: "", HTTPS_PROXY: "", HTTP_PROXY: "" },
  });
}

describe("the committed snapshot", () => {
  test("`fetch.mjs --check` validates the committed files offline and exits 0 [X-017 AC1]", () => {
    const result = runOffline("--check");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/fetch --check .*: OK/);
  });

  test("`fetch.mjs --check` exits 1 when a generated file was edited by hand or breaks a CHECK [X-017 AC1]", () => {
    const dir = mkdtempSync(path.join(scratch, "check-"));
    cpSync(DATA_DIR, path.join(dir, "data"), { recursive: true });
    cpSync(SOURCES_FILE, path.join(dir, "SOURCES.md"));
    const airports = path.join(dir, "data", "airports.csv");
    const lines = readFileSync(airports, "utf8").split("\n");
    const cdg = lines.findIndex((l) => l.startsWith("CDG,"));
    const fields = lines[cdg].split(",");
    fields[7] = "95"; // latitude
    lines[cdg] = fields.join(",");
    writeFileSync(airports, lines.join("\n"));

    const result = runOffline("--check", "--data", path.join(dir, "data"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`airports.csv:${cdg + 1}: latitude 95 is outside -90..90`);
    expect(result.stderr).toContain("airports.csv: SHA-256 differs from SOURCES.md");
  });

  test("`--check` fails when SOURCES.md loses the attribution line or data/ reaches 3 MB [X-017 AC1]", () => {
    const dir = mkdtempSync(path.join(scratch, "check-limits-"));
    const dataDir = path.join(dir, "data");
    cpSync(DATA_DIR, dataDir, { recursive: true });
    const markdown = readFileSync(SOURCES_FILE, "utf8");
    writeFileSync(path.join(dir, "SOURCES.md"), markdown.replaceAll(ATTRIBUTION, "Contains data"));
    expect(checkSnapshot(dataDir).problems).toEqual([
      `SOURCES.md: the attribution line "${ATTRIBUTION}" is missing`,
    ]);

    writeFileSync(path.join(dir, "SOURCES.md"), markdown);
    writeFileSync(path.join(dataDir, "padding.bin"), Buffer.alloc(MAX_DATA_BYTES - 1_000_000));
    expect(checkSnapshot(dataDir).problems).toEqual([
      expect.stringMatching(new RegExp(`^data/: [0-9]+ bytes, the limit is ${MAX_DATA_BYTES}$`)),
    ]);
  });

  test("counts are plausible [X-017 AC2]", () => {
    const counts = Object.fromEntries(LOAD_ORDER.map((t) => [t, committed(TABLES[t].file).length]));
    expect(counts.currencies).toBeGreaterThanOrEqual(150);
    expect(counts.countries).toBeGreaterThanOrEqual(240);
    expect(counts.time_zones).toBeGreaterThanOrEqual(300);
    expect(counts.airports).toBeGreaterThanOrEqual(8000);
    expect(counts.airlines).toBeGreaterThanOrEqual(700);
    expect(counts.aircraft).toBeGreaterThanOrEqual(200);
    const airports = committed("airports.csv");
    expect(airports.every((a) => /^[A-Z]{3}$/.test(a.iata_code))).toBe(true);
    const major = new Map(airports.map((a) => [a.iata_code, a]));
    for (const code of ["CDG", "JFK", "LHR", "FRA", "DXB", "SIN", "HND", "GRU", "JNB", "SYD"]) {
      expect(major.get(code)?.is_active, code).toBe("true");
    }
  });

  test("every airport's time_zone is in time_zones.csv and every city_code is in cities.csv [X-017 AC3]", () => {
    const zones = new Set(committed("time_zones.csv").map((z) => z.name));
    const cities = new Set(committed("cities.csv").map((c) => c.iata_code));
    const countries = new Set(committed("countries.csv").map((c) => c.code));
    const airports = committed("airports.csv");
    expect(airports.filter((a) => a.time_zone !== "" && !zones.has(a.time_zone))).toEqual([]);
    expect(airports.filter((a) => a.city_code !== "" && !cities.has(a.city_code))).toEqual([]);
    expect(airports.filter((a) => !countries.has(a.country_code))).toEqual([]);
    // Nearly every airport has both links; the few without are named in SOURCES.md's notes.
    expect(airports.filter((a) => a.time_zone === "").length).toBeLessThan(10);
    expect(airports.filter((a) => a.city_code === "").length).toBeLessThan(50);
    const cdg = airports.find((a) => a.iata_code === "CDG");
    expect(cdg).toMatchObject({ city_code: "PAR", time_zone: "Europe/Paris", country_code: "FR" });
  });

  test("SOURCES.md names each source, its licence and the attribution text [X-017 AC4]", () => {
    const markdown = readFileSync(SOURCES_FILE, "utf8");
    expect(markdown).toContain(`> ${ATTRIBUTION}`);
    expect(markdown).toContain("[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)");
    expect(markdown).toContain("[Unicode License v3](https://www.unicode.org/license.txt)");
    expect(markdown).toMatch(/```text\nUNICODE LICENSE V3\n[\s\S]*COPYRIGHT AND PERMISSION NOTICE[\s\S]*```/);
    expect(markdown).toMatch(/\| Retrieval date \| \d{4}-\d{2}-\d{2} \(UTC\) \|/);
    const tag = /\| Unicode CLDR release \| cldr-json `([^`]+)` \|/.exec(markdown)?.[1];
    expect(tag).toBeDefined();
    for (const source of sourcesFor(/** @type {string} */ (tag))) {
      expect(markdown, source.file).toMatch(
        new RegExp(
          `^\\| ${source.publisher} \\| \`${source.file.replace(".", "\\.")}\` \\| <${source.url.replace(/[.?]/g, "\\$&")}> ` +
            `\\| ${source.licence} \\| [0-9]+ \\| \`[0-9a-f]{64}\` \\| `,
          "m",
        ),
      );
    }
    expect(sourcesFor(CLDR_TAG).map((s) => s.publisher)).toContain("OpenTravelData");
    expect(sourcesFor(CLDR_TAG).map((s) => s.publisher)).toContain("Unicode CLDR");
  });

  test("data/ stays under 3 MB [X-017 AC1]", () => {
    const total = readdirSync(DATA_DIR).reduce((sum, f) => sum + statSync(path.join(DATA_DIR, f)).size, 0);
    expect(total).toBeLessThan(MAX_DATA_BYTES);
    expect(MAX_DATA_BYTES).toBe(3 * 1024 * 1024);
  });
});
