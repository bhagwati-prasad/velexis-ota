// Reference rows → the schemas of the OTA document (`Location`, `Airport`, `Airline`, `Country`, `Currency` and their
// pages), plus the pure parts of the reference use cases: cursors, page limits, the search keyword and the display
// language of `Accept-Language`.
//
// Names: the reference data has English names only (ADR-0024). `Accept-Language` picks localised country and
// currency names where ICU has them (Node's CLDR data, the source of those two tables), so `listCountries`,
// `listCurrencies` and the country of `getAirport` answer in the visitor's language; airport, city and airline names
// stay as the data has them, and the location search answers in English as the document says. An English or
// unsupported language gives the names of the reference data. `Country.nativeName` is the country's name in the main
// language of the country (CLDR likely subtags: `und-DE` → German, so `Deutschland`).
//
// Images: the data has no airline logos and no flags (ota/docs/adr/0015-storefront-build-urls-and-hosting.md point 8:
// no logos in the MVP), but `Airline.logoUrl`, `Airline.logoSquareUrl` and `Country.flagUrl` are required URIs. They
// are small SVG badges with the code, as `data:` URIs: valid for the document, shown under the storefront's CSP
// (`img-src 'self' data:`), and never a broken link to a host that does not exist. An airline row's own `logo_url` is
// used when it is an https URL.
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import type {
  AirlineRow,
  AirportRow,
  CityAirportRow,
  CityRow,
  CountryRow,
  CurrencyRow,
  LocationSubType,
} from "./reference.repository";

type Schemas = components["schemas"];
export type Location = Schemas["Location"];
export type LocationPage = Schemas["LocationPage"];
export type Airport = Schemas["Airport"];
export type Airline = Schemas["Airline"];
export type AirlinePage = Schemas["AirlinePage"];
export type Country = Schemas["Country"];
export type CountryPage = Schemas["CountryPage"];
export type Currency = Schemas["Currency"];
export type CurrencyPage = Schemas["CurrencyPage"];

/** Page size when the request gives none (the `Limit` parameter's default). */
export const DEFAULT_PAGE_LIMIT = 20;
/** The location search answers at most this many locations per page (an autocomplete list). */
export const LOCATION_SEARCH_MAX_LIMIT = 20;
/** `listAirlines` with `iataCodes` (at most 100) answers them in one page unless the request asks for fewer. */
export const AIRLINE_CODES_DEFAULT_LIMIT = 100;
/**
 * The largest offset a cursor may carry (the search and the country list): far beyond any real list (about 250
 * countries; a two-letter keyword matches a few hundred locations), so a larger one was not issued here and is refused.
 */
const MAX_CURSOR_OFFSET = 10_000;
/** Longer cursors are refused without decoding. */
const MAX_CURSOR_LENGTH = 512;

/* ------------------------------------------------------------------------------------------------
 * Cursors and limits
 * ---------------------------------------------------------------------------------------------- */

/** `400 VALIDATION_FAILED` for a cursor this list did not issue. */
export function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "is not a cursor of this list" }],
  });
}

/** An opaque cursor: base64url of a small JSON object. */
export function encodeCursor(position: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/** The JSON object of a cursor, or `undefined` when it is not one this API issued. */
function decodeCursorObject(cursor: string): Record<string, unknown> | undefined {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The offset of an offset cursor (`{"o": 20}`); 0 without a cursor. Throws `invalidCursor()` otherwise. */
export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const value = decodeCursorObject(cursor);
  const offset = value?.["o"];
  if (
    value === undefined ||
    Object.keys(value).length !== 1 ||
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    offset > MAX_CURSOR_OFFSET
  ) {
    throw invalidCursor();
  }
  return offset;
}

/** The fields of a keyset cursor (`{"c": "EUR"}`, `{"n": "air france", "c": "AF"}`); throws `invalidCursor()`. */
export function decodeKeysetCursor<K extends string>(
  cursor: string,
  keys: readonly K[],
): Readonly<Record<K, string>> {
  const value = decodeCursorObject(cursor);
  if (value === undefined || Object.keys(value).length !== keys.length) {
    throw invalidCursor();
  }
  const fields = {} as Record<K, string>;
  for (const key of keys) {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0 || field.length > 200) {
      throw invalidCursor();
    }
    fields[key] = field;
  }
  return fields;
}

/** The page size of a request: its `limit` (validated 1–100) or `fallback`, at most `max`. */
export function pageLimit(limit: number | undefined, fallback = DEFAULT_PAGE_LIMIT, max = 100): number {
  return Math.min(limit ?? fallback, max);
}

/* ------------------------------------------------------------------------------------------------
 * The search keyword
 * ---------------------------------------------------------------------------------------------- */

/** What the location search looks for. */
export interface LocationKeyword {
  /**
   * The keyword with the LIKE wildcards `\`, `%` and `_` escaped, for `lower(name) LIKE lower(<namePrefix>) || '%'`
   * (reference.sql): PostgreSQL lower-cases both sides with the same function.
   */
  readonly namePrefix: string;
  /** The keyword as an IATA code when it is three letters (`par` → `PAR`). */
  readonly exactCode: string | undefined;
}

/**
 * The search terms of a keyword (validated 2–50 characters): trimmed, inner white space collapsed, LIKE wildcards
 * escaped, so `%` or `_` match themselves. `undefined` when fewer than two characters remain.
 */
export function locationKeyword(keyword: string): LocationKeyword | undefined {
  const normalised = keyword.trim().replace(/\s+/g, " ");
  if (normalised.length < 2) {
    return undefined;
  }
  return {
    namePrefix: normalised.replace(/[\\%_]/g, (character) => `\\${character}`),
    exactCode: /^[A-Za-z]{3}$/.test(normalised) ? normalised.toUpperCase() : undefined,
  };
}

/** The `subType` filter: both types unless the request names some. */
export function locationSubTypes(subTypes: readonly LocationSubType[] | undefined): Set<LocationSubType> {
  return new Set(subTypes === undefined || subTypes.length === 0 ? ["AIRPORT", "CITY"] : subTypes);
}

/* ------------------------------------------------------------------------------------------------
 * Display language
 * ---------------------------------------------------------------------------------------------- */

/** At most this many `Accept-Language` entries are looked at. */
const MAX_LANGUAGE_RANGES = 20;

/**
 * The display language of an `Accept-Language` value: its preferred language range (by `q`, then order) that ICU
 * has display names for, canonicalised (`de-ch` → `de-CH`), or `undefined` for English, `*`, nothing usable or no
 * header, which all mean the English names of the reference data.
 */
export function displayLanguage(acceptLanguage: string | undefined): string | undefined {
  if (acceptLanguage === undefined) {
    return undefined;
  }
  const ranges = acceptLanguage
    .split(",")
    .slice(0, MAX_LANGUAGE_RANGES)
    .map((entry, index) => {
      const [range = "", ...parameters] = entry.split(";").map((part) => part.trim());
      const qParameter = parameters.find((parameter) => /^q=/i.test(parameter));
      const quality = qParameter === undefined ? 1 : Number(qParameter.slice(2));
      return { range, quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter(({ range, quality }) => range !== "" && range !== "*" && quality > 0 && quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { range } of ranges) {
    let locale: string | undefined;
    try {
      [locale] = Intl.getCanonicalLocales(range);
    } catch {
      continue;
    }
    if (locale === undefined) {
      continue;
    }
    if (new Intl.Locale(locale).language === "en") {
      return undefined;
    }
    if (Intl.DisplayNames.supportedLocalesOf([locale]).length > 0) {
      return locale;
    }
  }
  return undefined;
}

type DisplayType = "region" | "currency";

/** `Intl.DisplayNames` by language and type: a handful of languages in practice, so a small bounded cache. */
const displayNamesCache = new Map<string, Intl.DisplayNames>();
const DISPLAY_NAMES_CACHE_SIZE = 64;

function displayNames(language: string, type: DisplayType): Intl.DisplayNames {
  const key = `${type}:${language}`;
  let names = displayNamesCache.get(key);
  if (names === undefined) {
    names = new Intl.DisplayNames([language], { type, fallback: "none" });
    if (displayNamesCache.size >= DISPLAY_NAMES_CACHE_SIZE) {
      displayNamesCache.clear();
    }
    displayNamesCache.set(key, names);
  }
  return names;
}

/** ICU's name of `code` in `language`, or `undefined` when it has none. */
function icuName(language: string, type: DisplayType, code: string): string | undefined {
  try {
    const name = displayNames(language, type).of(code);
    return name === undefined || name === "" || name === code ? undefined : name;
  } catch {
    return undefined;
  }
}

/**
 * Native country names by code. They depend on the code only (one locale per country, and the process's ICU data never
 * changes), so each is computed once: a country list would otherwise build one `Intl.DisplayNames` per country on
 * every request (about 250, several milliseconds of CPU) and flush `displayNamesCache` each time. The codes are
 * `[A-Z]{2}` (reference.sql), so the map holds at most 26 × 26 entries.
 */
const nativeNamesCache = new Map<string, string | undefined>();

/** The name of country `code` in its main language (CLDR likely subtags: `und-DE` → `de`), or `undefined`. */
function nativeCountryName(code: string): string | undefined {
  if (!/^[A-Z]{2}$/.test(code)) {
    return undefined;
  }
  if (nativeNamesCache.has(code)) {
    return nativeNamesCache.get(code);
  }
  let name: string | undefined;
  try {
    const { language } = new Intl.Locale(`und-${code}`).maximize();
    if (language !== "und" && language !== "en") {
      const native = new Intl.DisplayNames([`${language}-${code}`], { type: "region", fallback: "none" }).of(
        code,
      );
      name = native === undefined || native === "" || native === code ? undefined : native;
    }
  } catch {
    name = undefined;
  }
  nativeNamesCache.set(code, name);
  return name;
}

/** The names of one response: localised by `language` where ICU has them, else the reference data's English names. */
export class ReferenceNames {
  private readonly collator: Intl.Collator;

  /** `language` from `displayLanguage`; `undefined` is English. */
  constructor(readonly language: string | undefined) {
    this.collator = new Intl.Collator(language ?? "en", { sensitivity: "base" });
  }

  country(code: string, englishName: string): string {
    return this.language === undefined
      ? englishName
      : (icuName(this.language, "region", code) ?? englishName);
  }

  currency(code: string, englishName: string): string {
    return this.language === undefined
      ? englishName
      : (icuName(this.language, "currency", code) ?? englishName);
  }

  /** The country's name in its main language (CLDR likely subtags), else `englishName`. */
  nativeCountry(code: string, englishName: string): string {
    return nativeCountryName(code) ?? englishName;
  }

  /** Orders names for this language (a list "sorted by localised name"). */
  compare(a: string, b: string): number {
    return this.collator.compare(a, b);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Rows → schemas
 * ---------------------------------------------------------------------------------------------- */

/** WGS 84 coordinates from `numeric(9,6)` strings, or `undefined` when either is missing or out of range. */
function geoCode(latitude: string | null, longitude: string | null): Location["geoCode"] | undefined {
  if (latitude === null || longitude === null) {
    return undefined;
  }
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? { latitude: lat, longitude: lon }
    : undefined;
}

/** A city result with its airports (by rank); `undefined` when the row lacks a time zone or coordinates. */
export function cityLocation(row: CityRow, airports: readonly CityAirportRow[]): Location | undefined {
  const coordinates = geoCode(row.latitude, row.longitude);
  if (row.timeZone === null || coordinates === undefined) {
    return undefined;
  }
  return {
    id: `CITY:${row.iataCode}`,
    subType: "CITY",
    iataCode: row.iataCode,
    name: row.name,
    detailedName: `${row.name}, ${row.countryName}`,
    cityCode: row.iataCode,
    cityName: row.name,
    countryCode: row.countryCode,
    countryName: row.countryName,
    stateCode: row.stateCode,
    timeZone: row.timeZone,
    geoCode: coordinates,
    airports: airports
      .filter((airport) => airport.cityCode === row.iataCode)
      .map((airport) => ({ iataCode: airport.iataCode, name: airport.name })),
  };
}

/** The airport fields `Location` and `Airport` share; `undefined` when the row lacks a time zone or coordinates. */
function airportFields(row: AirportRow, countryName: string) {
  const coordinates = geoCode(row.latitude, row.longitude);
  if (row.timeZone === null || coordinates === undefined) {
    return undefined;
  }
  // An airport outside the cities of the data is its own city, as IATA codes single-airport places.
  const cityCode = row.cityCode ?? row.iataCode;
  const cityName = row.cityName ?? row.servedCityName ?? row.name;
  return {
    iataCode: row.iataCode,
    name: row.name,
    detailedName: `${row.name}, ${cityName}, ${countryName}`,
    cityCode,
    cityName,
    countryCode: row.countryCode,
    countryName,
    stateCode: row.stateCode,
    timeZone: row.timeZone,
    geoCode: coordinates,
  };
}

/** An airport result of the search (English names); `undefined` when the row lacks a time zone or coordinates. */
export function airportLocation(row: AirportRow): Location | undefined {
  const fields = airportFields(row, row.countryName);
  return fields === undefined
    ? undefined
    : { id: `AIRPORT:${row.iataCode}`, subType: "AIRPORT", ...fields, airports: [] };
}

/** `getAirport`: the country name localised; `undefined` when the row lacks a time zone or coordinates. */
export function toAirport(row: AirportRow, names: ReferenceNames): Airport | undefined {
  const fields = airportFields(row, names.country(row.countryCode, row.countryName));
  return fields === undefined ? undefined : { ...fields, icaoCode: row.icaoCode, active: row.isActive };
}

const ALLIANCES: ReadonlySet<string> = new Set(["star_alliance", "oneworld", "skyteam"]);

/**
 * The code badge of an airline or a country as a `data:` URI (SVG). Codes are `[A-Z0-9]` by the CHECK constraints of
 * reference.sql; anything else is dropped, so nothing in the image comes from outside that set.
 */
export function codeBadge(code: string, shape: "wide" | "square" | "flag"): string {
  const text = code.replace(/[^A-Z0-9]/g, "");
  const [width, height, fontSize] =
    shape === "wide" ? [96, 32, 14] : shape === "square" ? [128, 128, 44] : [48, 32, 14];
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>` +
    `<rect width='${width}' height='${height}' rx='4' fill='#e5e7eb'/>` +
    `<text x='${width / 2}' y='${Math.round(height / 2 + fontSize * 0.36)}' text-anchor='middle' ` +
    `font-family='sans-serif' font-size='${fontSize}' font-weight='700' fill='#374151'>${text}</text></svg>`;
  return `data:image/svg+xml,${svg.replace(/[<>#\s]/g, (character) => encodeURIComponent(character))}`;
}

/**
 * An https URL in its serialised form (spaces and non-ASCII characters percent-encoded, as the document's
 * `format: uri` requires), or `undefined` for anything else (a relative path, another scheme, a malformed value).
 */
function httpsUrl(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function toAirline(row: AirlineRow): Airline {
  const logo = httpsUrl(row.logoUrl);
  return {
    iataCode: row.iataCode,
    icaoCode: row.icaoCode,
    name: row.name,
    alliance:
      row.alliance !== null && ALLIANCES.has(row.alliance) ? (row.alliance as Airline["alliance"]) : null,
    countryCode: row.countryCode,
    logoUrl: logo ?? codeBadge(row.iataCode, "wide"),
    logoSquareUrl: logo ?? codeBadge(row.iataCode, "square"),
    websiteUrl: null,
    active: row.isActive,
  };
}

/** `reference.countries.continent_code` → `Country.region`. */
const REGIONS: Readonly<Record<string, Country["region"]>> = Object.freeze({
  AF: "Africa",
  AN: "Antarctica",
  AS: "Asia",
  EU: "Europe",
  NA: "Americas",
  OC: "Oceania",
  SA: "Americas",
});

/** A country with its localised and native names; `undefined` for a continent the schema has no region for. */
export function toCountry(row: CountryRow, names: ReferenceNames): Country | undefined {
  const region = REGIONS[row.continentCode];
  if (region === undefined) {
    return undefined;
  }
  return {
    code: row.code,
    alpha3: row.alpha3,
    name: names.country(row.code, row.name),
    nativeName: names.nativeCountry(row.code, row.name),
    callingCode: row.callingCode,
    currencyCode: row.currencyCode,
    region,
    flagUrl: codeBadge(row.code, "flag"),
  };
}

/** A currency with its localised name; the code stands in for a missing symbol (as CLDR does). */
export function toCurrency(row: CurrencyRow, names: ReferenceNames): Currency {
  return {
    code: row.code,
    name: names.currency(row.code, row.name),
    symbol: row.symbol ?? row.code,
    decimals: row.minorUnits,
  };
}
