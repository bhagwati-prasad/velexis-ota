// The pure parts of the reference endpoints (OBE-015): reference rows → the document's schemas (checked against the
// OTA document with the same check as the integration tests), cursors, limits, the search keyword and the display
// language of `Accept-Language`.
import { isAppError } from "@velexis/errors";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  airportLocation,
  cityLocation,
  codeBadge,
  decodeKeysetCursor,
  decodeOffsetCursor,
  displayLanguage,
  encodeCursor,
  locationKeyword,
  locationSubTypes,
  pageLimit,
  ReferenceNames,
  toAirline,
  toAirport,
  toCountry,
  toCurrency,
} from "./reference.mapper";
import type { AirlineRow, AirportRow, CityRow, CountryRow, CurrencyRow } from "./reference.repository";

// Parsing the OTA document for the response check takes about 0.5 s alone, several times that while every package's
// tests run at once on a 4-CPU runner: paid once here, with a budget that only stops a hang.
beforeAll(() => {
  responseChecker("ota");
}, 60_000);

const ENGLISH = new ReferenceNames(undefined);
const GERMAN = new ReferenceNames("de");

const PARIS: CityRow = {
  iataCode: "PAR",
  name: "Paris",
  countryCode: "FR",
  countryName: "France",
  stateCode: null,
  timeZone: "Europe/Paris",
  latitude: "48.853410",
  longitude: "2.348800",
};

const CDG: AirportRow = {
  iataCode: "CDG",
  icaoCode: "LFPG",
  name: "Paris Charles de Gaulle Airport",
  cityCode: "PAR",
  cityName: "Paris",
  servedCityName: "Paris",
  stateCode: null,
  countryCode: "FR",
  countryName: "France",
  timeZone: "Europe/Paris",
  latitude: "49.009722",
  longitude: "2.547778",
  isActive: true,
};

const AIR_FRANCE: AirlineRow = {
  iataCode: "AF",
  icaoCode: "AFR",
  name: "Air France",
  alliance: "skyteam",
  countryCode: "FR",
  logoUrl: null,
  isActive: true,
};

const FRANCE: CountryRow = {
  code: "FR",
  alpha3: "FRA",
  name: "France",
  continentCode: "EU",
  currencyCode: "EUR",
  callingCode: "33",
};

const EURO: CurrencyRow = { code: "EUR", name: "Euro", symbol: "€", minorUnits: 2 };

/** The `AppError` that `fn` throws. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("locationKeyword", () => {
  it("escapes the LIKE wildcards, so % and _ match themselves", () => {
    expect(locationKeyword("50%_off\\")?.namePrefix).toBe("50\\%\\_off\\\\");
  });

  it("trims and collapses white space, and keeps the case for PostgreSQL's lower()", () => {
    expect(locationKeyword("  New   York ")).toEqual({ namePrefix: "New York", exactCode: undefined });
  });

  it("looks a three-letter keyword up as an exact IATA code, in upper case", () => {
    expect(locationKeyword("par")).toEqual({ namePrefix: "par", exactCode: "PAR" });
    expect(locationKeyword(" Lhr ")?.exactCode).toBe("LHR");
    expect(locationKeyword("pa")?.exactCode).toBeUndefined();
    expect(locationKeyword("pari")?.exactCode).toBeUndefined();
    expect(locationKeyword("p r")?.exactCode).toBeUndefined();
    expect(locationKeyword("pä")?.exactCode).toBeUndefined();
  });

  it("is undefined when fewer than two characters remain", () => {
    expect(locationKeyword(" a ")).toBeUndefined();
    expect(locationKeyword("   ")).toBeUndefined();
  });
});

describe("locationSubTypes", () => {
  it("defaults to both types and keeps the requested ones", () => {
    expect([...locationSubTypes(undefined)].sort()).toEqual(["AIRPORT", "CITY"]);
    expect([...locationSubTypes([])].sort()).toEqual(["AIRPORT", "CITY"]);
    expect([...locationSubTypes(["CITY"])]).toEqual(["CITY"]);
  });
});

describe("cursors and limits", () => {
  it("round-trips offset and keyset cursors as opaque base64url", () => {
    const offset = encodeCursor({ o: 40 });
    const keyset = encodeCursor({ n: "air france", c: "AF" });
    expect(offset).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeOffsetCursor(offset)).toBe(40);
    expect(decodeOffsetCursor(undefined)).toBe(0);
    expect(decodeKeysetCursor(keyset, ["n", "c"])).toEqual({ n: "air france", c: "AF" });
    expect(decodeKeysetCursor(encodeCursor({ c: "EUR" }), ["c"])).toEqual({ c: "EUR" });
  });

  it("refuses cursors it did not issue with 400 VALIDATION_FAILED on /query/cursor", () => {
    const cursors = [
      "",
      "not a cursor",
      "%%%",
      Buffer.from("not json").toString("base64url"),
      encodeCursor({ o: 0 }),
      encodeCursor({ o: -20 }),
      encodeCursor({ o: 1_000_000 }),
      encodeCursor({ o: "20" }),
      encodeCursor({ o: 20, c: "EUR" }),
      Buffer.from("[20]").toString("base64url"),
      "a".repeat(600),
    ];
    for (const cursor of cursors) {
      const error = thrown(() => decodeOffsetCursor(cursor));
      expect(isAppError(error) ? [error.code, error.fieldErrors] : error, cursor).toEqual([
        "VALIDATION_FAILED",
        [{ path: "/query/cursor", code: "cursor", message: "is not a cursor of this list" }],
      ]);
    }
    for (const cursor of [encodeCursor({ o: 20 }), encodeCursor({ c: "" }), encodeCursor({ c: 7 })]) {
      expect(isAppError(thrown(() => decodeKeysetCursor(cursor, ["c"]))), cursor).toBe(true);
    }
    expect(isAppError(thrown(() => decodeKeysetCursor(encodeCursor({ c: "AF" }), ["n", "c"])))).toBe(true);
  });

  it("takes the request's limit or the default, never above the maximum", () => {
    expect(pageLimit(undefined)).toBe(20);
    expect(pageLimit(7)).toBe(7);
    expect(pageLimit(100)).toBe(100);
    expect(pageLimit(50, 20, 20)).toBe(20);
    expect(pageLimit(undefined, 100)).toBe(100);
  });
});

describe("displayLanguage", () => {
  it("is English (undefined) without a header, for *, for English first and for nothing usable", () => {
    for (const header of [undefined, "", "*", "en", "en-GB,de;q=0.9", "xx-YY", "de;q=0", "!!, %%"]) {
      expect(displayLanguage(header), String(header)).toBeUndefined();
    }
  });

  it("picks the preferred language that has display names, by q and then order, canonicalised", () => {
    expect(displayLanguage("de-de,de;q=0.9,en;q=0.8")).toBe("de-DE");
    expect(displayLanguage("xx-YY, fr;q=0.5")).toBe("fr");
    expect(displayLanguage("fr;q=0.4, it;q=0.8")).toBe("it");
    expect(displayLanguage("de;q=0, fr")).toBe("fr");
    expect(displayLanguage("es;q=2, pt;q=abc, it;q=0.1")).toBe("it");
    expect(displayLanguage("fr;q=0.5, en;q=0.9")).toBeUndefined();
  });
});

describe("ReferenceNames", () => {
  it("keeps the reference data's English names for English", () => {
    expect(ENGLISH.country("GB", "United Kingdom")).toBe("United Kingdom");
    expect(ENGLISH.currency("GBP", "Pound Sterling")).toBe("Pound Sterling");
  });

  it("localises country and currency names where ICU has them, else keeps the English name", () => {
    expect(GERMAN.country("FR", "France")).toBe("Frankreich");
    expect(GERMAN.currency("EUR", "Euro")).toBe("Euro");
    expect(GERMAN.currency("GBP", "Pound Sterling")).toBe("Britisches Pfund");
    expect(GERMAN.country("QQ", "Unknown Land")).toBe("Unknown Land");
  });

  it("names a country in its main language", () => {
    expect(ENGLISH.nativeCountry("DE", "Germany")).toBe("Deutschland");
    expect(GERMAN.nativeCountry("FR", "Frankreich")).toBe("France");
    expect(ENGLISH.nativeCountry("US", "United States")).toBe("United States");
    expect(ENGLISH.nativeCountry("QQ", "Unknown Land")).toBe("Unknown Land");
  });

  it("computes a country's native name once, whatever the display language", () => {
    expect(ENGLISH.nativeCountry("AT", "Austria")).toBe("Österreich");
    const displayNames = vi.spyOn(Intl, "DisplayNames");
    try {
      const names = [GERMAN.nativeCountry("AT", "Österreich"), ENGLISH.nativeCountry("AT", "Austria")];
      expect(displayNames).not.toHaveBeenCalled();
      expect(names).toEqual(["Österreich", "Österreich"]);
    } finally {
      displayNames.mockRestore();
    }
  });

  it("orders names by the language's collation", () => {
    const names = ["Österreich", "Zypern", "Albanien"];
    expect([...names].sort((a, b) => GERMAN.compare(a, b))).toEqual(["Albanien", "Österreich", "Zypern"]);
  });
});

describe("locations", () => {
  it("map a city with its airports, an airport with its city, and validate as a LocationPage [OBE-015 AC2]", () => {
    const city = cityLocation(PARIS, [
      { cityCode: "PAR", iataCode: "CDG", name: "Paris Charles de Gaulle Airport" },
      { cityCode: "LON", iataCode: "LHR", name: "London Heathrow Airport" },
      { cityCode: "PAR", iataCode: "ORY", name: "Paris Orly Airport" },
    ]);
    const airport = airportLocation(CDG);

    expect(city).toEqual({
      id: "CITY:PAR",
      subType: "CITY",
      iataCode: "PAR",
      name: "Paris",
      detailedName: "Paris, France",
      cityCode: "PAR",
      cityName: "Paris",
      countryCode: "FR",
      countryName: "France",
      stateCode: null,
      timeZone: "Europe/Paris",
      geoCode: { latitude: 48.85341, longitude: 2.3488 },
      airports: [
        { iataCode: "CDG", name: "Paris Charles de Gaulle Airport" },
        { iataCode: "ORY", name: "Paris Orly Airport" },
      ],
    });
    expect(airport).toEqual({
      id: "AIRPORT:CDG",
      subType: "AIRPORT",
      iataCode: "CDG",
      name: "Paris Charles de Gaulle Airport",
      detailedName: "Paris Charles de Gaulle Airport, Paris, France",
      cityCode: "PAR",
      cityName: "Paris",
      countryCode: "FR",
      countryName: "France",
      stateCode: null,
      timeZone: "Europe/Paris",
      geoCode: { latitude: 49.009722, longitude: 2.547778 },
      airports: [],
    });
    expectResponseToMatch("searchLocations", {
      status: 200,
      body: { data: [city, airport], page: { nextCursor: encodeCursor({ o: 2 }), limit: 2 } },
    });
  });

  it("let an airport outside the data's cities be its own city, with the best city name there is", () => {
    const own = airportLocation({ ...CDG, cityCode: null, cityName: null, servedCityName: null });
    const served = airportLocation({ ...CDG, cityName: null, servedCityName: "Paris (served)" });
    expect([own?.cityCode, own?.cityName]).toEqual(["CDG", "Paris Charles de Gaulle Airport"]);
    expect(served?.cityName).toBe("Paris (served)");
  });

  it("leave out rows without a time zone or coordinates, which the document cannot represent", () => {
    expect(cityLocation({ ...PARIS, timeZone: null }, [])).toBeUndefined();
    expect(cityLocation({ ...PARIS, latitude: null }, [])).toBeUndefined();
    expect(airportLocation({ ...CDG, longitude: null })).toBeUndefined();
    expect(airportLocation({ ...CDG, latitude: "95.000000" })).toBeUndefined();
    expect(toAirport({ ...CDG, timeZone: null }, ENGLISH)).toBeUndefined();
  });
});

describe("toAirport", () => {
  it("maps an airport with the country name in the display language and validates as an Airport [OBE-015 AC2]", () => {
    const airport = toAirport(CDG, GERMAN);
    expect(airport).toMatchObject({
      iataCode: "CDG",
      icaoCode: "LFPG",
      countryName: "Frankreich",
      detailedName: "Paris Charles de Gaulle Airport, Paris, Frankreich",
      active: true,
    });
    expectResponseToMatch("getAirport", { status: 200, body: airport });
    expectResponseToMatch("getAirport", {
      status: 200,
      body: toAirport({ ...CDG, icaoCode: null }, ENGLISH),
    });
  });
});

describe("toAirline", () => {
  it("maps an airline with code badges as data: URIs and validates as an AirlinePage [OBE-015 AC2]", () => {
    const airline = toAirline(AIR_FRANCE);
    expect(airline).toEqual({
      iataCode: "AF",
      icaoCode: "AFR",
      name: "Air France",
      alliance: "skyteam",
      countryCode: "FR",
      logoUrl: codeBadge("AF", "wide"),
      logoSquareUrl: codeBadge("AF", "square"),
      websiteUrl: null,
      active: true,
    });
    expect(airline.logoUrl).toMatch(/^data:image\/svg\+xml,%3Csvg%20/);
    expect(decodeURIComponent(airline.logoSquareUrl)).toContain(">AF</text></svg>");
    expect(decodeURIComponent(codeBadge("A<b>&'\"F", "flag"))).toContain(">AF</text></svg>");
    const defunct = toAirline({
      ...AIR_FRANCE,
      iataCode: "9X",
      icaoCode: null,
      alliance: null,
      countryCode: null,
      isActive: false,
    });
    expectResponseToMatch("listAirlines", {
      status: 200,
      body: { data: [airline, defunct], page: { nextCursor: null, limit: 100 } },
    });
    expectResponseToMatch("getAirline", { status: 200, body: defunct });
  });

  it("uses the row's own logo only when it is an https URL, and drops an alliance the schema does not know", () => {
    const logo = "https://assets.example.com/airlines/AF.svg";
    expect(toAirline({ ...AIR_FRANCE, logoUrl: logo })).toMatchObject({ logoUrl: logo, logoSquareUrl: logo });
    // Serialised, so a space or a non-ASCII character in the stored URL still gives a valid `format: uri`.
    const unencoded = toAirline({
      ...AIR_FRANCE,
      logoUrl: "https://assets.example.com/airlines/Air Fránce.svg",
    });
    expect(unencoded.logoUrl).toBe("https://assets.example.com/airlines/Air%20Fr%C3%A1nce.svg");
    expectResponseToMatch("getAirline", { status: 200, body: unencoded });
    for (const logoUrl of [
      "http://assets.example.com/AF.svg",
      "/AF.svg",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(toAirline({ ...AIR_FRANCE, logoUrl }).logoUrl, logoUrl).toBe(codeBadge("AF", "wide"));
    }
    expect(toAirline({ ...AIR_FRANCE, alliance: "value_alliance" }).alliance).toBeNull();
  });
});

describe("toCountry", () => {
  it("maps a country with localised, native and English names and validates as a CountryPage [OBE-015 AC2]", () => {
    const english = toCountry(FRANCE, ENGLISH);
    const german = toCountry(
      { ...FRANCE, code: "DE", alpha3: "DEU", name: "Germany", callingCode: "49" },
      GERMAN,
    );
    expect(english).toEqual({
      code: "FR",
      alpha3: "FRA",
      name: "France",
      nativeName: "France",
      callingCode: "33",
      currencyCode: "EUR",
      region: "Europe",
      flagUrl: codeBadge("FR", "flag"),
    });
    expect([german?.name, german?.nativeName]).toEqual(["Deutschland", "Deutschland"]);
    expectResponseToMatch("listCountries", {
      status: 200,
      body: { data: [english, german], page: { nextCursor: null, limit: 20 } },
    });
  });

  it("maps every continent to the schema's regions and leaves out an unknown one", () => {
    const regions = ["AF", "AN", "AS", "EU", "NA", "OC", "SA"].map(
      (continentCode) => toCountry({ ...FRANCE, continentCode }, ENGLISH)?.region,
    );
    expect(regions).toEqual(["Africa", "Antarctica", "Asia", "Europe", "Americas", "Oceania", "Americas"]);
    expect(toCountry({ ...FRANCE, continentCode: "XX" }, ENGLISH)).toBeUndefined();
  });
});

describe("toCurrency", () => {
  it("maps a currency with its localised name and validates as a CurrencyPage [OBE-015 AC2]", () => {
    const pound = toCurrency({ code: "GBP", name: "Pound Sterling", symbol: "£", minorUnits: 2 }, GERMAN);
    const yen = toCurrency({ code: "JPY", name: "Japanese Yen", symbol: null, minorUnits: 0 }, ENGLISH);
    expect(toCurrency(EURO, ENGLISH)).toEqual({ code: "EUR", name: "Euro", symbol: "€", decimals: 2 });
    expect(pound).toEqual({ code: "GBP", name: "Britisches Pfund", symbol: "£", decimals: 2 });
    // The code stands in for a missing symbol, as CLDR does.
    expect(yen).toEqual({ code: "JPY", name: "Japanese Yen", symbol: "JPY", decimals: 0 });
    expectResponseToMatch("listCurrencies", {
      status: 200,
      body: { data: [pound, yen], page: { nextCursor: encodeCursor({ c: "JPY" }), limit: 2 } },
    });
  });
});
