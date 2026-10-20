/**
 * The country, currency and time zone options of the portal's forms: the create-OTA wizard (`/otas/new`) and the
 * OTA settings (`/otas/[tenantId]/settings`). Built on the server, so the server's markup and the browser's
 * hydration use the same lists. Plain data without secrets.
 */

/** One option of a select: an ISO code or a time zone, and its name in the portal's English. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The ISO 3166-1 alpha-2 codes of the reference data the API checks `countryCode` against (`reference.countries`,
 * tools/reference-data/data/countries.csv; `wizard.test.tsx` and `ota-dashboard.test.tsx` keep the two equal).
 * Their names come from `Intl.DisplayNames`, so the list holds codes only.
 */
export const COUNTRY_CODES: readonly string[] = Object.freeze(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO " +
    "FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE " +
    "JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO " +
    "MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW " +
    "PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM " +
    "TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
  ).split(" "),
);

/**
 * The active ISO 4217 codes of the reference data the API checks `defaultCurrency` against (`reference.currencies`
 * with `is_active`; `wizard.test.tsx` keeps the two equal). Withdrawn currencies stay out: an OTA's currency never
 * changes.
 */
export const CURRENCY_CODES: readonly string[] = Object.freeze(
  (
    "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY " +
    "COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR " +
    "ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK " +
    "MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF " +
    "SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS " +
    "VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
  ).split(" "),
);

/** The portal's locale (English only, ADR-0014). */
const LOCALE = "en";

/** The `TimeZone` pattern of the platform document. */
export const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** The zone preselected when the one to preselect is not offered. */
export const FALLBACK_TIME_ZONE = "UTC";

/** `codes` with their English names (`Intl.DisplayNames`), sorted by name. */
export function namedOptions(codes: readonly string[], type: "region" | "currency"): SelectOption[] {
  const names = new Intl.DisplayNames([LOCALE], { type, fallback: "code" });
  return codes
    .map((code) => {
      const name = names.of(code) ?? code;
      return { value: code, label: type === "currency" && name !== code ? `${name} (${code})` : name };
    })
    .sort((left, right) => left.label.localeCompare(right.label, LOCALE));
}

/**
 * The time zones a form offers: the canonical IANA zones of the server's `Intl`, `UTC`, and `current` (the account's
 * or the OTA's own zone, which the API accepted before, so it can stay selected), sorted by name.
 */
export function timeZoneOptions(current: string): SelectOption[] {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.add(FALLBACK_TIME_ZONE);
  if (TIME_ZONE_PATTERN.test(current)) {
    zones.add(current);
  }
  return [...zones].sort().map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }));
}
