#!/usr/bin/env node
// @ts-check
// fetch.mjs: build the vendored reference datasets of @velexis/reference-data (task X-017, ADR-0024).
//
// Usage (plain Node 22, no dependencies):
//   node tools/reference-data/scripts/fetch.mjs --check   validate the committed files offline and exit (CI-safe)
//   node tools/reference-data/scripts/fetch.mjs           download the sources and rewrite data/*.csv and SOURCES.md
//
// The download is run BY HAND for the quarterly refresh, never in CI, deploys or tests (ADR-0024). Behind an HTTPS
// proxy, run it with NODE_USE_ENV_PROXY=1 so that Node's fetch uses HTTPS_PROXY.
//
// Options: --data <dir> (default: tools/reference-data/data), --cldr <tag> (cldr-json release, default CLDR_TAG).
//
// The download mode fetches the OpenTravelData and Unicode CLDR files of sourcesFor(), re-checks their licence
// statements, maps them to the exact columns of docs/velexis-sdk/db/reference.sql, validates the result with
// validate.mjs and only then writes deterministic CSV files (header row, LF, sorted by key) and SOURCES.md with the
// URL, licence and SHA-256 of every raw download. overrides.csv is created empty once and never rewritten.
//
// --check validates the committed files with validate.mjs, checks that every generated file still has the SHA-256
// recorded in SOURCES.md (generated files are never edited by hand; urgent fixes go to overrides.csv) and that
// data/ stays under MAX_DATA_BYTES. It never touches the network.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DEFAULT_DATA_DIR,
  LOAD_ORDER,
  OVERRIDES_FILE,
  OVERRIDES_HEADER,
  TABLES,
  formatCsv,
  reportValidation,
  validateData,
  validateDataDir,
} from "./validate.mjs";

/** @typedef {import("./validate.mjs").TableName} TableName */
/** @typedef {Record<string, string | number | boolean | null>} Row */

/** Step 6 of X-017: the vendored data stays small (ADR-0024 expects 1-2 MB per snapshot). */
export const MAX_DATA_BYTES = 3 * 1024 * 1024;
/** The cldr-json release the snapshot is built from; bump it on a refresh after reading the CLDR release notes. */
export const CLDR_TAG = "48.2.0";
export const ATTRIBUTION = "Contains data from OpenTravelData (CC BY 4.0)";

const OPTD_BASE = "https://raw.githubusercontent.com/opentraveldata/opentraveldata/master";
/** @param {string} tag */
const cldrBase = (tag) => `https://raw.githubusercontent.com/unicode-org/cldr-json/${tag}`;

const OPTD_LICENCE = {
  name: "CC BY 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
  // The licence statement of the OPTD README ("# Licensing"), re-checked on every download.
  marker: /governed by the\s+\[CC-BY license\]\(https?:\/\/creativecommons\.org\/licenses\/by\/4\.0\/?\)/,
};
const CLDR_LICENCE = {
  name: "Unicode License v3",
  url: "https://www.unicode.org/license.txt",
  marker: /^UNICODE LICENSE V3\s/,
};

/**
 * @typedef {{
 *   id: string, file: string, publisher: "OpenTravelData" | "Unicode CLDR", url: string,
 *   licence: string, usedFor: string,
 * }} Source
 */

/**
 * Every raw download, in download order.
 * @param {string} cldrTag
 * @returns {Source[]}
 */
export function sourcesFor(cldrTag) {
  const cldr = `${cldrBase(cldrTag)}/cldr-json`;
  /** @type {(id: string, file: string, url: string, usedFor: string) => Source} */
  const optd = (id, file, url, usedFor) => ({
    id,
    file,
    url,
    usedFor,
    publisher: "OpenTravelData",
    licence: OPTD_LICENCE.name,
  });
  /** @type {(id: string, file: string, url: string, usedFor: string) => Source} */
  const unicode = (id, file, url, usedFor) => ({
    id,
    file,
    url,
    usedFor,
    publisher: "Unicode CLDR",
    licence: CLDR_LICENCE.name,
  });
  return [
    optd(
      "por",
      "optd_por_public.csv",
      `${OPTD_BASE}/opentraveldata/optd_por_public.csv`,
      "airports, cities (IATA codes, names, coordinates, IANA zone, page rank, elevation)",
    ),
    optd("airlines", "optd_airlines.csv", `${OPTD_BASE}/opentraveldata/optd_airlines.csv`, "airlines"),
    optd("aircraft", "optd_aircraft.csv", `${OPTD_BASE}/opentraveldata/optd_aircraft.csv`, "aircraft"),
    optd(
      "countries",
      "optd_countries.csv",
      `${OPTD_BASE}/opentraveldata/optd_countries.csv`,
      "countries: continent_code, calling_code",
    ),
    optd("readme", "README.md", `${OPTD_BASE}/README.md`, "licence statement (re-checked)"),
    unicode(
      "territories",
      "territories.json",
      `${cldr}/cldr-localenames-full/main/en/territories.json`,
      "countries: English names",
    ),
    unicode(
      "codeMappings",
      "codeMappings.json",
      `${cldr}/cldr-core/supplemental/codeMappings.json`,
      "countries: alpha-3 and numeric codes; currencies: numeric codes",
    ),
    unicode(
      "currencyData",
      "currencyData.json",
      `${cldr}/cldr-core/supplemental/currencyData.json`,
      "currencies: minor units, is_active; countries: main currency",
    ),
    unicode(
      "currencies",
      "currencies.json",
      `${cldr}/cldr-numbers-full/main/en/currencies.json`,
      "currencies: English names and symbols",
    ),
    unicode(
      "timezones",
      "timezone.json",
      `${cldr}/cldr-bcp47/bcp47/timezone.json`,
      "time_zones: IANA names and their country",
    ),
    unicode("licence", "LICENSE", `${cldrBase(cldrTag)}/LICENSE`, "licence text (re-checked)"),
  ];
}

// ---- Small helpers --------------------------------------------------------------------------------------

/** @param {Uint8Array | string} data */
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * Plain code-unit order, the same in every locale (sort order is part of the file format).
 * @param {string} a
 * @param {string} b
 */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// eslint-disable-next-line no-control-regex -- the point is to replace control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * One-line, trimmed, NFC text; "" when nothing is left.
 * @param {string | undefined | null} value
 */
export function clean(value) {
  return (value ?? "").normalize("NFC").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

/** @param {string | undefined | null} value */
const cleanOrNull = (value) => clean(value) || null;

/**
 * An ISO numeric code as three digits: CLDR drops the leading zeros of currency codes ("8" for ALL's 008).
 * @param {string | undefined} value
 * @returns {string | null}
 */
export const numericCode = (value) =>
  /^[0-9]{1,3}$/.test(value ?? "") ? String(value).padStart(3, "0") : null;

/**
 * A coordinate rounded to numeric(9,6), without trailing zeros; null when missing or out of range.
 * @param {string} value
 * @param {number} limit 90 or 180
 */
export function coordinate(value, limit) {
  if (clean(value) === "") {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) {
    return null;
  }
  const text = n.toFixed(6).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

/**
 * OPTD page rank (0..1) as an integer search_rank: page rank x 1,000,000, rounded (0 when missing).
 * @param {string} pageRank
 */
export function searchRank(pageRank) {
  const n = Number(pageRank);
  return clean(pageRank) === "" || !Number.isFinite(n) || n < 0 ? 0 : Math.round(n * 1_000_000);
}

/**
 * Whether a validity end date (YYYY-MM-DD or "") is still open on the snapshot date.
 * @param {string} until
 * @param {string} today YYYY-MM-DD
 */
const isOpen = (until, today) => clean(until) === "" || until >= today;

/**
 * Parse a caret-separated OpenTravelData file (no quoting) into objects keyed by the header.
 * @param {string} text
 * @param {string} name file name, for messages
 * @param {readonly string[]} required columns the mapping reads
 * @returns {Record<string, string>[]}
 */
export function parseCaretFile(text, name, required) {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const header = (lines.shift() ?? "").split("^");
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(`${name}: the source format changed, missing columns ${missing.join(", ")}`);
  }
  /** @type {Record<string, string>[]} */
  const rows = [];
  lines.forEach((line, i) => {
    if (line === "") {
      return;
    }
    const fields = line.split("^");
    if (fields.length !== header.length) {
      throw new Error(`${name}:${i + 2}: ${fields.length} fields, expected ${header.length}`);
    }
    rows.push(Object.fromEntries(header.map((h, j) => [h, fields[j]])));
  });
  return rows;
}

/**
 * Keep one row per key: `better(a, b) < 0` when a should win. Rows without a valid key are dropped.
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string | null} keyOf
 * @param {(a: T, b: T) => number} better
 * @returns {Map<string, T>}
 */
function pickPerKey(rows, keyOf, better) {
  /** @type {Map<string, T>} */
  const best = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) {
      continue;
    }
    const current = best.get(key);
    if (current === undefined || better(row, current) < 0) {
      best.set(key, row);
    }
  }
  return best;
}

/**
 * Drop a UNIQUE value from every row but the first one (the most relevant row keeps it).
 * @param {Row[]} rows already in priority order
 * @param {string} key the key column, for the notes
 * @param {string} column
 * @returns {string[]} "<key> (<value> stays with <key>)" for every dropped value
 */
function dedupeUnique(rows, key, column) {
  /** @type {Map<unknown, unknown>} */
  const owner = new Map();
  /** @type {string[]} */
  const dropped = [];
  for (const row of rows) {
    const value = row[column];
    if (value === null) {
      continue;
    }
    if (owner.has(value)) {
      dropped.push(`${row[key]} (${value} stays with ${owner.get(value)})`);
      row[column] = null;
    } else {
      owner.set(value, row[key]);
    }
  }
  return dropped.sort(byCode);
}

/**
 * A note of the snapshot: a count, what happened, and the codes concerned (at most 40).
 * @param {string} what
 * @param {string[]} codes
 */
const note = (what, codes) =>
  `${codes.length} ${what}: ${codes.slice(0, 40).join(", ")}${codes.length > 40 ? ", …" : ""}`;

// ---- Currencies (Unicode CLDR) --------------------------------------------------------------------------

/**
 * @typedef {Record<string, Array<Record<string, {_from?: string, _to?: string, _tender?: string}>>>} CurrencyRegions
 */

/**
 * The parts of the CLDR JSON documents that the mapping reads. JSON.parse does not check them: a changed layout
 * throws a TypeError, which stops the refresh before anything is written.
 * @typedef {{ main: { en: { numbers: {
 *   currencies: Record<string, { displayName?: string, symbol?: string }> } } } }} CldrCurrencyNames
 * @typedef {{ supplemental: { codeMappings: Record<string, { _alpha3?: string, _numeric?: string }> } }} CldrCodeMappings
 * @typedef {{ supplemental: { currencyData: {
 *   fractions: Record<string, { _digits?: string }>, region: CurrencyRegions } } }} CldrCurrencyData
 * @typedef {{ main: { en: { localeDisplayNames: { territories: Record<string, string> } } } }} CldrTerritories
 * @typedef {{ _alias?: string, _deprecated?: boolean | string, _region?: string }} CldrTimeZoneKey
 * @typedef {{ keyword: { u: { tz: Record<string, CldrTimeZoneKey | string> } } }} CldrTimeZones
 */

/**
 * The current legal tenders of each region on the snapshot date (CLDR currencyData.region lists them in order of
 * preference; `_tender: "false"` marks funds codes such as USN or CLF).
 * @param {CurrencyRegions} regions
 * @param {string} today
 * @returns {Map<string, string[]>} region -> current tenders, the main currency first
 */
export function currentTenders(regions, today) {
  /** @type {Map<string, string[]>} */
  const tenders = new Map();
  for (const region of Object.keys(regions).sort(byCode)) {
    const codes = regions[region].flatMap((entry) =>
      Object.entries(entry)
        .filter(
          ([, info]) =>
            info._tender !== "false" &&
            (!info._from || info._from <= today) &&
            (!info._to || info._to >= today),
        )
        .map(([code]) => code),
    );
    tenders.set(region, [...new Set(codes)]);
  }
  return tenders;
}

/**
 * Currencies: every ISO 4217 code with an English CLDR name. is_active = legal tender in some region on the
 * snapshot date, so historic currencies, funds codes and X-codes (XAU, XDR, XTS, XXX) are inactive.
 * @param {{ currencies: CldrCurrencyNames, codeMappings: CldrCodeMappings, currencyData: CldrCurrencyData }} cldr
 * @param {string} today
 * @returns {Row[]}
 */
export function buildCurrencies(cldr, today) {
  const names = cldr.currencies.main.en.numbers.currencies;
  const mappings = cldr.codeMappings.supplemental.codeMappings;
  const { fractions, region } = cldr.currencyData.supplemental.currencyData;
  const tenders = new Set([...currentTenders(region, today).values()].flat());
  const defaultDigits = Number(fractions.DEFAULT._digits);
  return Object.keys(names)
    .filter((code) => /^[A-Z]{3}$/.test(code))
    .sort(byCode)
    .map((code) => ({
      code,
      numeric_code: numericCode(mappings[code]?._numeric),
      name: clean(names[code].displayName) || code,
      symbol: cleanOrNull(names[code].symbol),
      minor_units: Number(fractions[code]?._digits ?? defaultDigits),
      is_active: tenders.has(code),
    }));
}

// ---- Countries (Unicode CLDR + OpenTravelData) ----------------------------------------------------------

/** The 27 EU member states (ISO 3166-1 alpha-2), for countries.is_eu. Update by hand when membership changes. */
export const EU_MEMBERS = new Set(
  "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK".split(" "),
);

/**
 * The calling code of an OPTD tel_pfx ("33", "+1-268", "+44-1481", "+1-809 and 1-829"): the leading country code.
 * @param {string} tel
 */
export function callingCode(tel) {
  const match = /^\+?([0-9]{1,4})(?:$|[^0-9])/.exec(clean(tel));
  return match ? match[1] : null;
}

/**
 * Countries: every ISO 3166-1 code CLDR maps to an alpha-3 and a numeric code below 900 (the officially assigned
 * ones), plus the user-assigned codes that OpenTravelData's country list also carries (XK, Kosovo), which get no
 * alpha-3 or numeric code because ISO defines none.
 * @param {{ territories: CldrTerritories, codeMappings: CldrCodeMappings, currencyData: CldrCurrencyData }} cldr
 * @param {Record<string, string>[]} optdCountries
 * @param {Set<string>} currencyCodes
 * @param {string} today
 * @returns {Row[]}
 */
export function buildCountries(cldr, optdCountries, currencyCodes, today) {
  const names = cldr.territories.main.en.localeDisplayNames.territories;
  const mappings = cldr.codeMappings.supplemental.codeMappings;
  const mainCurrency = currentTenders(cldr.currencyData.supplemental.currencyData.region, today);
  const optd = new Map(optdCountries.map((r) => [r.iso_2char_code, r]));
  /** @param {string} code */
  const isoAssigned = (code) => {
    const m = mappings[code];
    const numeric = numericCode(m?._numeric);
    return /^[A-Z]{3}$/.test(m?._alpha3 ?? "") && numeric !== null && Number(numeric) < 900;
  };
  return Object.keys(names)
    .filter((code) => /^[A-Z]{2}$/.test(code) && (isoAssigned(code) || optd.has(code)))
    .sort(byCode)
    .map((code) => {
      const iso = isoAssigned(code);
      const row = optd.get(code);
      const currency = mainCurrency.get(code)?.[0] ?? null;
      const continent = clean(row?.cont_code);
      return {
        code,
        alpha3: iso ? (mappings[code]._alpha3 ?? null) : null,
        numeric_code: iso ? numericCode(mappings[code]._numeric) : null,
        name: clean(names[code]),
        official_name: null,
        continent_code: /^(AF|AN|AS|EU|NA|OC|SA)$/.test(continent) ? continent : null,
        currency_code: currency !== null && currencyCodes.has(currency) ? currency : null,
        calling_code: row ? callingCode(row.tel_pfx) : null,
        is_eu: EU_MEMBERS.has(code),
      };
    });
}

// ---- Time zones (Unicode CLDR + Intl) -------------------------------------------------------------------

/**
 * The UTC offset of an IANA zone at an instant, in minutes, from Intl ("GMT+05:30" -> 330).
 * @param {string} zone
 * @param {Date} instant
 */
export function utcOffsetMinutes(zone, instant) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  if (part === "GMT") {
    return 0;
  }
  const match = /^GMT([+-])([0-9]{2}):([0-9]{2})$/.exec(part ?? "");
  if (!match) {
    throw new Error(`cannot read the UTC offset of ${zone} (${part})`);
  }
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** The two instants the offsets are computed at (mid-January and mid-July of the snapshot year, 12:00 UTC). */
export const offsetInstants = (/** @type {number} */ year) => [
  new Date(Date.UTC(year, 0, 15, 12)),
  new Date(Date.UTC(year, 6, 15, 12)),
];

/**
 * Every IANA name of the CLDR bcp47 time zone keys (aliases included, so that OPTD's names always resolve), with
 * the country of the key and the standard / daylight offsets of the snapshot year. Standard is the smaller of
 * the January and July offsets, daylight the larger one, NULL when they are equal.
 * @param {CldrTimeZones} bcp47 cldr-bcp47 timezone.json
 * @param {Set<string>} countryCodes
 * @param {number} year
 * @returns {Row[]}
 */
export function buildTimeZones(bcp47, countryCodes, year) {
  const keys = bcp47.keyword.u.tz;
  const [january, july] = offsetInstants(year);
  /** @type {Map<string, Row>} */
  const zones = new Map();
  for (const key of Object.keys(keys).sort(byCode)) {
    const entry = keys[key];
    if (
      key.startsWith("_") ||
      typeof entry === "string" ||
      entry._deprecated ||
      !entry._alias ||
      key === "unk"
    ) {
      continue; // metadata, deprecated keys (their names live on under the preferred key), Etc/Unknown
    }
    // UTS #35: the first two letters of a five-letter key (a UN/LOCODE, "frpar") are its region unless _region
    // overrides them; keys of another length ("gldkshvn", "utcw05") have a region only through _region.
    let country = entry._region ?? (/^[a-z]{5}$/.test(key) ? key.slice(0, 2).toUpperCase() : null);
    if (country !== null && !countryCodes.has(country)) {
      country = null;
    }
    for (const name of String(entry._alias).split(" ")) {
      if (zones.has(name) || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name)) {
        continue;
      }
      const a = utcOffsetMinutes(name, january);
      const b = utcOffsetMinutes(name, july);
      zones.set(name, {
        name,
        country_code: country,
        utc_offset_minutes: Math.min(a, b),
        dst_offset_minutes: a === b ? null : Math.max(a, b),
      });
    }
  }
  return [...zones.values()];
}

// ---- Cities and airports (OpenTravelData points of reference) -------------------------------------------

export const POR_COLUMNS = [
  "iata_code",
  "icao_code",
  "envelope_id",
  "geoname_id",
  "name",
  "asciiname",
  "latitude",
  "longitude",
  "fcode",
  "page_rank",
  "date_from",
  "date_until",
  "country_code",
  "iso31662",
  "elevation",
  "timezone",
  "city_code_list",
  "city_detail_list",
  "location_type",
];

/** States are kept where Amadeus addresses use them (reference.sql: "where relevant (US, CA, AU, BR)"). */
const STATE_CODES = {
  US: /^[A-Z]{2}$/,
  CA: /^[A-Z]{2}$/,
  BR: /^[A-Z]{2}$/,
  AU: /^(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)$/,
};

/**
 * The airports.kind of an OPTD location type (A airport, H heliport, R rail, B bus; C city, O off-line point and
 * P port are not airports), refined by the GeoNames feature code (AIRS seaplane base, AIRH heliport).
 * @param {Record<string, string>} row
 * @returns {string | null}
 */
export function airportKind(row) {
  const type = row.location_type;
  if (type.includes("A")) {
    return row.fcode === "AIRS" ? "seaplane_base" : row.fcode === "AIRH" ? "heliport" : "airport";
  }
  if (type.includes("H")) {
    return "heliport";
  }
  if (type.includes("R")) {
    return "rail_station";
  }
  if (type.includes("B")) {
    return "bus_station";
  }
  return null;
}

/**
 * The served cities of an OPTD row: city_detail_list is "code|geonameid|name|asciiname|country|adm1=...".
 * @param {Record<string, string>} row
 * @returns {{ code: string, name: string }[]}
 */
function cityDetails(row) {
  return clean(row.city_detail_list)
    ? row.city_detail_list.split("=").map((entry) => {
        const f = entry.split("|");
        return { code: f[0] ?? "", name: clean(f[2]) || clean(f[3]) };
      })
    : [];
}

/**
 * Which of two OPTD rows with the same code describes it better: open (not closed) rows first, then the higher
 * page rank, the newer validity start, the current envelope, then a stable tie-break.
 * @param {string} today
 */
const porPreference =
  (today) => (/** @type {Record<string, string>} */ a, /** @type {Record<string, string>} */ b) =>
    Number(isOpen(b.date_until, today)) - Number(isOpen(a.date_until, today)) ||
    searchRank(b.page_rank) - searchRank(a.page_rank) ||
    byCode(b.date_from, a.date_from) ||
    byCode(b.date_until, a.date_until) ||
    byCode(a.envelope_id, b.envelope_id) ||
    byCode(a.geoname_id, b.geoname_id) ||
    byCode(a.name, b.name);

/** @param {string} value metres, as text */
const feet = (value) =>
  /^-?[0-9]+(\.[0-9]+)?$/.test(clean(value)) ? Math.round(Number(value) / 0.3048) : null;

/**
 * @param {Record<string, string>[]} por rows of optd_por_public.csv
 * @param {{ countryCodes: Set<string>, timeZones: Set<string>, today: string }} context
 * @returns {{ cities: Row[], airports: Row[], notes: string[] }}
 */
export function buildPlaces(por, { countryCodes, timeZones, today }) {
  const notes = [];
  const prefer = porPreference(today);
  const usable = por.filter((r) => /^[A-Z]{3}$/.test(r.iata_code) && countryCodes.has(r.country_code));
  const droppedCountry = por.filter(
    (r) => /^[A-Z]{3}$/.test(r.iata_code) && !countryCodes.has(r.country_code),
  );
  if (droppedCountry.length > 0) {
    notes.push(
      note(
        "OPTD locations skipped, their country is not in countries.csv",
        droppedCountry.map((r) => `${r.iata_code} (${r.country_code})`).sort(byCode),
      ),
    );
  }
  /** @type {Set<string>} */
  const unknownZones = new Set();
  /**
   * The IANA zone of a location, or null when it is not in time_zones.csv (noted, so that a refresh shows it).
   * @param {string} code
   * @param {string} zone
   */
  const zoneOf = (code, zone) => {
    if (timeZones.has(zone)) {
      return zone;
    }
    if (clean(zone) !== "") {
      unknownZones.add(`${code} (${clean(zone)})`);
    }
    return null;
  };

  const cityRows = pickPerKey(
    usable.filter((r) => r.location_type.includes("C")),
    (r) => r.iata_code,
    prefer,
  );
  /** @type {Row[]} */
  const cities = [...cityRows.keys()].sort(byCode).map((code) => {
    const row = /** @type {Record<string, string>} */ (cityRows.get(code));
    const own = cityDetails(row).find((d) => d.code === code);
    // A pure city row is named after the city; a combined row (city + airport, rail...) is named after the
    // location, so its city name comes from its own entry of the served-cities list.
    const name = row.location_type === "C" ? clean(row.name) || own?.name : own?.name || clean(row.name);
    const statePattern = STATE_CODES[/** @type {keyof typeof STATE_CODES} */ (row.country_code)];
    const state = clean(row.iso31662);
    return {
      iata_code: code,
      name: name || clean(row.asciiname) || code,
      country_code: row.country_code,
      state_code: statePattern && statePattern.test(state) ? state : null,
      time_zone: zoneOf(code, row.timezone),
      latitude: coordinate(row.latitude, 90),
      longitude: coordinate(row.longitude, 180),
      search_rank: searchRank(row.page_rank),
    };
  });
  const cityCodes = new Set(cities.map((c) => /** @type {string} */ (c.iata_code)));

  const airportRows = pickPerKey(
    usable.filter((r) => airportKind(r) !== null && (clean(r.name) || clean(r.asciiname))),
    (r) => r.iata_code,
    prefer,
  );
  /** @type {string[]} */
  const noCity = [];
  /** @type {Row[]} */
  const airports = [...airportRows.keys()].sort(byCode).map((code) => {
    const row = /** @type {Record<string, string>} */ (airportRows.get(code));
    const details = cityDetails(row);
    const cityCode = row.city_code_list.split(",").find((c) => cityCodes.has(c)) ?? null;
    if (cityCode === null) {
      noCity.push(code);
    }
    const city = details.find((d) => d.code === cityCode) ?? details[0];
    const icao = clean(row.icao_code);
    return {
      iata_code: code,
      icao_code: /^[A-Z0-9]{4}$/.test(icao) ? icao : null,
      name: clean(row.name) || clean(row.asciiname),
      city_code: cityCode,
      city_name: city?.name || null,
      country_code: row.country_code,
      time_zone: zoneOf(code, row.timezone),
      latitude: coordinate(row.latitude, 90),
      longitude: coordinate(row.longitude, 180),
      elevation_ft: feet(row.elevation),
      kind: airportKind(row),
      is_active: isOpen(row.date_until, today),
      search_rank: searchRank(row.page_rank),
    };
  });
  if (noCity.length > 0) {
    notes.push(note("airports keep city_code empty, OPTD names no served city that is a city", noCity));
  }
  if (unknownZones.size > 0) {
    notes.push(
      note(
        "cities and airports keep time_zone empty, their IANA zone is not in time_zones.csv",
        [...unknownZones].sort(byCode),
      ),
    );
  }
  // airports.icao_code is UNIQUE: the open, higher-ranked location keeps a shared ICAO code.
  const byRelevance = [...airports].sort(
    (a, b) =>
      Number(b.is_active) - Number(a.is_active) ||
      Number(b.search_rank) - Number(a.search_rank) ||
      byCode(String(a.iata_code), String(b.iata_code)),
  );
  const droppedIcao = dedupeUnique(byRelevance, "iata_code", "icao_code");
  if (droppedIcao.length > 0) {
    notes.push(note("airports lose an ICAO code that a more relevant airport keeps (UNIQUE)", droppedIcao));
  }
  return { cities, airports, notes };
}

// ---- Airlines (OpenTravelData) --------------------------------------------------------------------------

export const AIRLINE_COLUMNS = [
  "pk",
  "env_id",
  "validity_from",
  "validity_to",
  "3char_code",
  "2char_code",
  "num_code",
  "name",
  "alliance_code",
  "alliance_status",
  "flt_freq",
  "bases",
];

const ALLIANCES = /** @type {Record<string, string>} */ ({
  "star alliance": "star_alliance",
  oneworld: "oneworld",
  skyteam: "skyteam",
});

/**
 * The country of an airline's bases ("FRA=MUC"): the one country of every base that countryOf knows, or null
 * when there is none or the bases lie in several countries (the source has no country of registration, and the
 * first base is not always the home one: Jet Airways lists AMS before its Indian hubs).
 * @param {string} bases
 * @param {(code: string) => string | null} countryOf
 * @returns {{ country: string | null, countries: string[] }}
 */
function baseCountry(bases, countryOf) {
  /** @type {Set<string>} */
  const countries = new Set();
  for (const base of clean(bases).split("=")) {
    const country = base ? countryOf(base) : null;
    if (country !== null) {
      countries.add(country);
    }
  }
  const sorted = [...countries].sort(byCode);
  return { country: sorted.length === 1 ? sorted[0] : null, countries: sorted };
}

/**
 * @param {Record<string, string>[]} rows rows of optd_airlines.csv
 * @param {{ countryOf: (code: string) => string | null, today: string }} context countryOf maps an airport or
 *   city code to its country
 * @returns {{ airlines: Row[], notes: string[] }}
 */
export function buildAirlines(rows, { countryOf, today }) {
  const notes = [];
  /** @type {string[]} */
  const multiCountry = [];
  // Carriers only: airlines, rail and bus operators. GDS (gds-), technical (tec-) and alliance (alc-) codes are
  // not carriers that Amadeus returns as carrierCode.
  const carriers = rows.filter((r) => /^(air|trn|bus)-/.test(r.pk) && /^[A-Z0-9]{2}$/.test(r["2char_code"]));
  const best = pickPerKey(
    carriers,
    (r) => r["2char_code"],
    (a, b) =>
      Number(isOpen(b.validity_to, today)) - Number(isOpen(a.validity_to, today)) ||
      (Number(b.flt_freq) || 0) - (Number(a.flt_freq) || 0) ||
      byCode(b.validity_from, a.validity_from) ||
      byCode(b.validity_to, a.validity_to) ||
      byCode(a.pk, b.pk),
  );
  /** @type {Row[]} */
  const airlines = [...best.keys()].sort(byCode).map((code) => {
    const row = /** @type {Record<string, string>} */ (best.get(code));
    const icao = clean(row["3char_code"]);
    const num = clean(row.num_code);
    const status = clean(row.alliance_status);
    const alliance =
      status === "Member" || status === "Affiliate"
        ? (ALLIANCES[clean(row.alliance_code).toLowerCase()] ?? null)
        : null;
    const { country, countries } = baseCountry(row.bases, countryOf);
    if (countries.length > 1) {
      multiCountry.push(`${code} (${countries.join(", ")})`);
    }
    return {
      iata_code: code,
      icao_code: /^[A-Z]{3}$/.test(icao) ? icao : null,
      name: clean(row.name) || code,
      common_name: null,
      country_code: country,
      // OPTD drops leading zeros ("57" for Air France's 057); 0 means unknown.
      accounting_code: /^[0-9]{1,3}$/.test(num) && Number(num) > 0 ? num.padStart(3, "0") : null,
      alliance,
      is_low_cost: false,
      is_active: isOpen(row.validity_to, today),
      logo_url: null,
      _freq: Number(row.flt_freq) || 0,
    };
  });
  if (multiCountry.length > 0) {
    notes.push(note("airlines keep country_code empty, their bases lie in several countries", multiCountry));
  }
  const byRelevance = [...airlines].sort(
    (a, b) =>
      Number(b.is_active) - Number(a.is_active) ||
      Number(b._freq) - Number(a._freq) ||
      byCode(String(a.iata_code), String(b.iata_code)),
  );
  const droppedIcao = dedupeUnique(byRelevance, "iata_code", "icao_code");
  if (droppedIcao.length > 0) {
    notes.push(note("airlines lose an ICAO code that a more relevant airline keeps (UNIQUE)", droppedIcao));
  }
  for (const airline of airlines) {
    delete airline._freq;
  }
  return { airlines, notes };
}

// ---- Aircraft (OpenTravelData) --------------------------------------------------------------------------

export const AIRCRAFT_COLUMNS = [
  "iata_code",
  "manufacturer",
  "model",
  "iata_group",
  "icao_code",
  "aircraft_type",
];

// Body categories by family, matched on "<manufacturer> <model>". Jets that match no family are narrow-bodies.
const WIDE_BODY = [
  /^Airbus A3(00|10|30|40|50|80)/,
  /^Boeing 7[4678]7/,
  /^McDonnell Douglas (DC-10|MD-11)/,
  /^Lockheed L-1011/,
  /^Ilyushin IL-(86|96)/,
  /Antonov An-(124|225)/,
];
const REGIONAL_JET = [
  /^Canadair CRJ/,
  /^Embraer (ERJ|EMB 1[79][05]|E19[05]-E2)/,
  /^(BAe|Avro) (146|BAE Systems 146|Avro RJ|RJX)/,
  /^Fokker (70|100|F28)/,
  /^Dornier [347]28JET/,
  /^Sukhoi Superjet/,
  /^Comac ARJ21/,
  /Antonov An-1[45]8/,
  /^Yakovlev .*Yak 40/,
];
const NARROW_BODY = [
  /^Airbus A(220|318|319|320|321)/,
  /^Boeing (7[0235]7|720)/,
  /^(McDonnell )?Douglas (DC-8|DC-9|MD-[89][0-9])/,
  /^BAC One Eleven/,
  /^Sud-Est SE\.210/,
  /^Vickers VC-10/,
  /^Tupolev Tu-(134|154|204)/,
  /^Ilyushin IL-62/,
  /^Aerospatiale .*Concorde/,
];

/**
 * The aircraft.body_type of an OPTD row from its aircraft type (J jet, T turboprop, P piston, H helicopter,
 * S surface equipment) and the family lists above; null when the source does not say.
 * @param {Record<string, string>} row
 * @param {string} name "<manufacturer> <model>"
 */
function bodyTypeOf(row, name) {
  const type = clean(row.aircraft_type);
  if (type === "H") {
    return "helicopter";
  }
  if (type === "T") {
    return "turboprop";
  }
  if (type === "P" || type === "S") {
    return "other";
  }
  if (WIDE_BODY.some((re) => re.test(name))) {
    return "wide";
  }
  if (REGIONAL_JET.some((re) => re.test(name))) {
    return "regional";
  }
  if (type === "J" || NARROW_BODY.some((re) => re.test(name))) {
    return "narrow";
  }
  return null;
}

/**
 * @param {Record<string, string>[]} rows rows of optd_aircraft.csv
 * @returns {{ aircraft: Row[], notes: string[] }}
 */
export function buildAircraft(rows) {
  const notes = [];
  const usable = rows.filter(
    (r) => /^[A-Z0-9]{3}$/.test(r.iata_code) && (clean(r.model) || clean(r.manufacturer)),
  );
  const best = pickPerKey(
    usable,
    (r) => r.iata_code,
    () => 1, // the first row of a code wins (OPTD has one per code)
  );
  /** @type {Map<string, Row>} */
  const aircraft = new Map();
  for (const code of [...best.keys()].sort(byCode)) {
    const row = /** @type {Record<string, string>} */ (best.get(code));
    const manufacturer = clean(row.manufacturer);
    const model = clean(row.model);
    const name =
      !manufacturer || model.toLowerCase().startsWith(manufacturer.toLowerCase())
        ? model || manufacturer
        : model
          ? `${manufacturer} ${model}`
          : manufacturer;
    const icao = clean(row.icao_code);
    aircraft.set(code, {
      iata_code: code,
      // "*", "ZZZZ" and "0000" are OPTD placeholders for "no ICAO designator".
      icao_code: /^[A-Z0-9]{2,4}$/.test(icao) && icao !== "ZZZZ" && icao !== "0000" ? icao : null,
      name,
      manufacturer: manufacturer || null,
      body_type: bodyTypeOf(row, `${manufacturer} ${model}`),
    });
  }
  // A generic group code (330 for every A330) without its own type takes the body type its members agree on.
  for (const [code, entry] of aircraft) {
    if (entry.body_type !== null) {
      continue;
    }
    const members = new Set(
      usable
        .filter((r) => r.iata_group === code && r.iata_code !== code)
        .map((r) => aircraft.get(r.iata_code)?.body_type ?? null),
    );
    if (members.size === 1 && !members.has(null)) {
      entry.body_type = [...members][0];
    }
  }
  const unknown = [...aircraft.values()].filter((a) => a.body_type === null).map((a) => String(a.iata_code));
  if (unknown.length > 0) {
    notes.push(note("aircraft keep body_type empty, the source gives no type", unknown));
  }
  return { aircraft: [...aircraft.values()], notes };
}

// ---- The whole snapshot ---------------------------------------------------------------------------------

/**
 * Map the raw downloads (text by source id) to the seven tables. Pure: the same input gives the same output.
 * @param {Record<string, string>} raw
 * @param {{ today: string }} options today = the snapshot date, YYYY-MM-DD (UTC)
 * @returns {{ tables: Record<TableName, Row[]>, notes: string[] }}
 */
export function buildDatasets(raw, { today }) {
  const json = (/** @type {string} */ id) => JSON.parse(raw[id]);
  const cldr = {
    territories: json("territories"),
    codeMappings: json("codeMappings"),
    currencyData: json("currencyData"),
    currencies: json("currencies"),
  };
  const currencies = buildCurrencies(cldr, today);
  const optdCountries = parseCaretFile(raw.countries, "optd_countries.csv", [
    "iso_2char_code",
    "cont_code",
    "tel_pfx",
  ]);
  const countries = buildCountries(
    cldr,
    optdCountries,
    new Set(currencies.map((c) => String(c.code))),
    today,
  );
  const countryCodes = new Set(countries.map((c) => String(c.code)));
  const timeZones = buildTimeZones(json("timezones"), countryCodes, Number(today.slice(0, 4)));
  const places = buildPlaces(parseCaretFile(raw.por, "optd_por_public.csv", POR_COLUMNS), {
    countryCodes,
    timeZones: new Set(timeZones.map((z) => String(z.name))),
    today,
  });
  const airportCountry = new Map(places.airports.map((a) => [String(a.iata_code), String(a.country_code)]));
  const cityCountry = new Map(places.cities.map((c) => [String(c.iata_code), String(c.country_code)]));
  const airlines = buildAirlines(parseCaretFile(raw.airlines, "optd_airlines.csv", AIRLINE_COLUMNS), {
    countryOf: (code) => airportCountry.get(code) ?? cityCountry.get(code) ?? null,
    today,
  });
  const aircraft = buildAircraft(parseCaretFile(raw.aircraft, "optd_aircraft.csv", AIRCRAFT_COLUMNS));
  return {
    tables: {
      currencies,
      countries,
      time_zones: timeZones,
      cities: places.cities,
      airports: places.airports,
      airlines: airlines.airlines,
      aircraft: aircraft.aircraft,
    },
    notes: [...places.notes, ...airlines.notes, ...aircraft.notes],
  };
}

/** @param {string | number | boolean | null | undefined} value */
const csvValue = (value) => (value === null || value === undefined ? "" : String(value));

/**
 * The CSV text of a table: the column order of TABLES, rows sorted by key.
 * @param {TableName} tableName
 * @param {Row[]} rows
 */
export function tableCsv(tableName, rows) {
  const { columns, key } = TABLES[tableName];
  const sorted = [...rows].sort((a, b) => byCode(String(a[key]), String(b[key])));
  return formatCsv([
    columns.map((c) => c.name),
    ...sorted.map((row) => columns.map((c) => csvValue(row[c.name]))),
  ]);
}

/** The text of an empty overrides.csv. */
export const EMPTY_OVERRIDES = formatCsv([OVERRIDES_HEADER]);

// ---- SOURCES.md -----------------------------------------------------------------------------------------

/**
 * @typedef {{ source: Source, bytes: number, sha256: string }} Download
 * @typedef {{ file: string, rows: number, sha256: string }} Output
 */

/**
 * @param {{ today: string, cldrTag: string, downloads: Download[], outputs: Output[], unicodeLicence: string,
 *   notes: string[] }} snapshot
 */
export function sourcesMarkdown({ today, cldrTag, downloads, outputs, unicodeLicence, notes }) {
  const year = Number(today.slice(0, 4));
  const [january, july] = offsetInstants(year).map((d) => d.toISOString().replace(".000", ""));
  const lines = [
    "# Reference data sources",
    "",
    "<!-- Generated by scripts/fetch.mjs. Do not edit: re-run the script (README.md). -->",
    "",
    `This file records where every row of [\`data/\`](data/) comes from: the snapshot of ${today} (UTC), built by ` +
      "[`scripts/fetch.mjs`](scripts/fetch.mjs) as [ADR-0024](../../docs/mvp/adr/0024-reference-data-sources-and-loader.md) " +
      "describes. `node scripts/fetch.mjs --check` verifies the files below against it offline.",
    "",
    "## Attribution",
    "",
    "OpenTravelData is licensed under CC BY 4.0, which requires attribution. The storefront's legal page and the " +
      "OTA admin's About page carry this line (ADR-0024):",
    "",
    `> ${ATTRIBUTION}`,
    "",
    "The files in `data/` are adapted from the sources below: filtered to rows with an IATA code, one row per code, " +
      "normalised to the columns of [`reference.sql`](../../docs/velexis-sdk/db/reference.sql) (README.md, " +
      '"Mapping"). Unicode CLDR data is used under the Unicode License v3; its notice is reproduced at the end.',
    "",
    "## Snapshot",
    "",
    "| Item | Value |",
    "|---|---|",
    `| Retrieval date | ${today} (UTC) |`,
    `| Unicode CLDR release | cldr-json \`${cldrTag}\` |`,
    `| OpenTravelData | \`master\` branch on the retrieval date (identified by the SHA-256 below) |`,
    `| Time zone offsets | Node.js ${process.versions.node}, ICU ${process.versions.icu}, IANA tzdata ` +
      `${process.versions.tz}; computed with \`Intl\` at ${january} and ${july} |`,
    "",
    "## Sources",
    "",
    "| Publisher | File | URL | Licence | Bytes | SHA-256 | Used for |",
    "|---|---|---|---|---:|---|---|",
    ...downloads.map(
      ({ source, bytes, sha256: hash }) =>
        `| ${source.publisher} | \`${source.file}\` | <${source.url}> | ${source.licence} | ${bytes} | ` +
        `\`${hash}\` | ${source.usedFor} |`,
    ),
    "",
    "## Licences",
    "",
    `- **OpenTravelData**: [${OPTD_LICENCE.name}](${OPTD_LICENCE.url}), as stated under "Licensing" in the ` +
      "project README (re-checked by the script on the retrieval date). Project: <https://github.com/opentraveldata/opentraveldata>.",
    `- **Unicode CLDR**: [${CLDR_LICENCE.name}](${CLDR_LICENCE.url}) (\`LICENSE\` of cldr-json \`${cldrTag}\`, ` +
      "re-checked on the retrieval date). Project: <https://cldr.unicode.org>.",
    "- **IANA time zone names** come through CLDR; the offsets are computed locally with `Intl` (tzdata is public domain).",
    "",
    "## Output files",
    "",
    "`--check` fails when a generated file no longer has this SHA-256: never edit them by hand, put urgent fixes in " +
      "`data/overrides.csv` (README.md).",
    "",
    "| File | Rows | SHA-256 |",
    "|---|---:|---|",
    ...outputs.map((o) => `| \`${o.file}\` | ${o.rows} | \`${o.sha256}\` |`),
    "",
    "## Notes of this snapshot",
    "",
    ...(notes.length > 0 ? notes.map((n) => `- ${n}`) : ["- None."]),
    "",
    "## Unicode License v3 notice",
    "",
    "```text",
    unicodeLicence.trimEnd(),
    "```",
    "",
  ];
  return lines.join("\n");
}

/**
 * The output table of SOURCES.md: file -> SHA-256.
 * @param {string} markdown
 * @returns {Map<string, string>}
 */
export function recordedOutputs(markdown) {
  const section = markdown.split(/^## /m).find((s) => s.startsWith("Output files"));
  /** @type {Map<string, string>} */
  const outputs = new Map();
  for (const match of (section ?? "").matchAll(/^\| `([^`]+\.csv)` \| [0-9]+ \| `([0-9a-f]{64})` \|$/gm)) {
    outputs.set(match[1], match[2]);
  }
  return outputs;
}

// ---- Modes ----------------------------------------------------------------------------------------------

/** SOURCES.md lives next to the data directory (tools/reference-data/SOURCES.md for the default one). */
export const sourcesFileFor = (/** @type {string} */ dataDir) => path.join(dataDir, "..", "SOURCES.md");

/**
 * --check: offline validation of a data directory and of the SOURCES.md next to it (attribution line, SHA-256
 * of every generated file) and the size limit of data/.
 * @param {string} dataDir
 * @param {import("./validate.mjs").ValidateOptions} [options]
 * @returns {import("./validate.mjs").ValidateResult} problems empty = OK
 */
export function checkSnapshot(dataDir, options) {
  const sourcesFile = sourcesFileFor(dataDir);
  const result = validateDataDir(dataDir, options);
  const problems = result.problems;
  if (!existsSync(sourcesFile)) {
    problems.push(`${path.basename(sourcesFile)}: missing`);
  } else {
    const markdown = readFileSync(sourcesFile, "utf8");
    if (!markdown.includes(ATTRIBUTION)) {
      problems.push(`${path.basename(sourcesFile)}: the attribution line "${ATTRIBUTION}" is missing`);
    }
    const recorded = recordedOutputs(markdown);
    for (const tableName of LOAD_ORDER) {
      const { file } = TABLES[tableName];
      const expected = recorded.get(file);
      const actual = existsSync(path.join(dataDir, file))
        ? sha256(readFileSync(path.join(dataDir, file)))
        : null;
      if (expected === undefined) {
        problems.push(`${path.basename(sourcesFile)}: no SHA-256 recorded for ${file}`);
      } else if (actual !== null && actual !== expected) {
        problems.push(
          `${file}: SHA-256 differs from ${path.basename(sourcesFile)}; generated files are never edited by hand ` +
            `(re-run fetch.mjs, or put the fix in ${OVERRIDES_FILE})`,
        );
      }
    }
  }
  if (existsSync(dataDir)) {
    const total = readdirSync(dataDir).reduce(
      (sum, name) => sum + statSync(path.join(dataDir, name)).size,
      0,
    );
    if (total >= MAX_DATA_BYTES) {
      problems.push(`data/: ${total} bytes, the limit is ${MAX_DATA_BYTES}`);
    }
  }
  return result;
}

/**
 * @typedef {{
 *   dataDir: string,
 *   cldrTag?: string,
 *   today?: string,
 *   fetchImpl?: typeof fetch,
 *   minRows?: import("./validate.mjs").ValidateOptions["minRows"],
 *   log?: (line: string) => void,
 * }} RefreshOptions
 */

/**
 * The download mode: fetch every source, re-check the licences, build, validate, then write data/*.csv,
 * overrides.csv (only when missing) and SOURCES.md. Nothing is written when a download, a licence check or the
 * validation fails. The options after dataDir exist for tests (a fake fetch, a fixed date, no row minimums).
 * @param {RefreshOptions} options
 */
export async function refresh({
  dataDir,
  cldrTag = CLDR_TAG,
  today = new Date().toISOString().slice(0, 10),
  fetchImpl = fetch,
  minRows,
  log = console.log,
}) {
  /** @type {Record<string, string>} */
  const raw = {};
  /** @type {Download[]} */
  const downloads = [];
  for (const source of sourcesFor(cldrTag)) {
    log(`download ${source.url}`);
    const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) {
      throw new Error(`${source.url}: HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    raw[source.id] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    downloads.push({ source, bytes: bytes.length, sha256: sha256(bytes) });
  }
  if (!OPTD_LICENCE.marker.test(raw.readme)) {
    throw new Error(
      "the OpenTravelData README no longer states CC BY 4.0: review the licence before refreshing",
    );
  }
  if (!CLDR_LICENCE.marker.test(raw.licence)) {
    throw new Error(
      "the CLDR LICENSE is no longer the Unicode License v3: review the licence before refreshing",
    );
  }
  const { tables, notes } = buildDatasets(raw, { today });
  /** @type {Record<string, string>} */
  const files = {};
  for (const tableName of LOAD_ORDER) {
    files[TABLES[tableName].file] = tableCsv(tableName, tables[tableName]);
  }
  const overridesPath = path.join(dataDir, OVERRIDES_FILE);
  files[OVERRIDES_FILE] = existsSync(overridesPath) ? readFileSync(overridesPath, "utf8") : EMPTY_OVERRIDES;
  const result = validateData(files, { minRows });
  const total = LOAD_ORDER.reduce((sum, t) => sum + Buffer.byteLength(files[TABLES[t].file]), 0);
  if (total >= MAX_DATA_BYTES) {
    result.problems.push(`data/ would be ${total} bytes, over the ${MAX_DATA_BYTES} byte limit`);
  }
  if (result.problems.length > 0) {
    throw new Error(
      `the new snapshot is invalid; nothing was written:\n  ${result.problems.slice(0, 50).join("\n  ")}`,
    );
  }
  mkdirSync(dataDir, { recursive: true });
  /** @type {Output[]} */
  const outputs = [];
  for (const tableName of LOAD_ORDER) {
    const { file } = TABLES[tableName];
    writeFileSync(path.join(dataDir, file), files[file]);
    outputs.push({ file, rows: tables[tableName].length, sha256: sha256(files[file]) });
  }
  if (!existsSync(overridesPath)) {
    writeFileSync(overridesPath, EMPTY_OVERRIDES);
  }
  writeFileSync(
    sourcesFileFor(dataDir),
    sourcesMarkdown({ today, cldrTag, downloads, outputs, unicodeLicence: raw.licence, notes }),
  );
  for (const note of notes) {
    log(`note: ${note}`);
  }
  log(`wrote ${outputs.map((o) => `${o.file} ${o.rows}`).join(", ")} (${total} bytes) and SOURCES.md`);
  return { tables, notes, outputs };
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      data: { type: "string" },
      cldr: { type: "string", default: CLDR_TAG },
    },
  });
  const dataDir = path.resolve(values.data ?? DEFAULT_DATA_DIR);
  if (values.check) {
    const result = checkSnapshot(dataDir);
    process.exitCode = reportValidation(
      result,
      `fetch --check ${path.relative(process.cwd(), dataDir) || "."}`,
    );
  } else {
    refresh({ dataDir, cldrTag: values.cldr }).catch((err) => {
      console.error(`fetch: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
  }
}
