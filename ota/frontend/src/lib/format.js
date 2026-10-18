// Money, dates and durations for the storefront, all through `Intl` (ota/frontend/README.md §7, conventions §1).
//
// - Money arrives as `{ amount: "412.30", currency: "EUR" }`: the decimal string goes to `Intl.NumberFormat` as it
//   is (no conversion to a JavaScript number, so no rounding error), with the currency's own number of digits. The
//   storefront never adds or multiplies prices; totals always come from the API.
// - Flight times are airport-local wall-clock strings without an offset (`SegmentEndpoint.at`, "2026-11-20T08:35:00").
//   They are formatted from their parts in UTC, so the browser's time zone never shifts them.
// - Durations (`PT7H35M`) become "7 h 35 min"; booking timestamps (ISO 8601 with `Z`) use the OTA's time zone.
//
// The formatters never throw on API data: a value they cannot read comes back as plain text, so one odd field cannot
// break a page. The locale is the OTA's `config.defaultLocale`; an invalid tag falls back to English.

import { LANGUAGE, t } from "./i18n.js";

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
/** A local date or date-time: date, optional time with optional seconds and fraction, optional (ignored) offset. */
const LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** ISO 8601 durations as Amadeus sends them: days, hours, minutes, seconds (no years, months or weeks). */
const ISO_DURATION = /^P(?!$)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = MINUTES_PER_DAY * 60 * 1000;

/** @type {Map<string, Intl.NumberFormat | Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * A canonical locale tag, or English when the tag is missing or invalid.
 * @param {string | undefined} locale
 * @returns {string}
 */
function localeOf(locale) {
  try {
    return Intl.getCanonicalLocales(locale ?? LANGUAGE)[0] ?? LANGUAGE;
  } catch {
    return LANGUAGE;
  }
}

/**
 * A cached `Intl.NumberFormat`; throws `RangeError` for an invalid currency code.
 * @param {string | undefined} locale
 * @param {Intl.NumberFormatOptions} options
 */
function numberFormat(locale, options) {
  const tag = localeOf(locale);
  const key = `n|${tag}|${JSON.stringify(options)}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.NumberFormat(tag, options);
    formatters.set(key, format);
  }
  return /** @type {Intl.NumberFormat} */ (format);
}

/**
 * A cached `Intl.DateTimeFormat`; throws `RangeError` for an invalid time zone.
 * @param {string | undefined} locale
 * @param {Intl.DateTimeFormatOptions} options
 */
function dateFormat(locale, options) {
  const tag = localeOf(locale);
  const key = `d|${tag}|${JSON.stringify(options)}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(tag, options);
    formatters.set(key, format);
  }
  return /** @type {Intl.DateTimeFormat} */ (format);
}

/**
 * Formats an API money object, for example `{ amount: "412.30", currency: "EUR" }` → "412,30 €" in `de-DE`. The
 * amount string is formatted exactly (never through a JavaScript number). A malformed amount or currency comes back
 * as "<amount> <currency>"; a missing value as "".
 * @param {{ amount: string, currency: string } | null | undefined} money
 * @param {string} [locale] the OTA's `defaultLocale`
 * @returns {string}
 */
export function formatMoney(money, locale) {
  if (!money || typeof money.amount !== "string" || typeof money.currency !== "string") {
    return "";
  }
  const { amount, currency } = money;
  if (!DECIMAL.test(amount)) {
    return `${amount} ${currency}`;
  }
  try {
    // Intl.NumberFormat formats a numeric string as an exact decimal (ES2023 Intl.NumberFormat v3).
    return numberFormat(locale, { style: "currency", currency }).format(
      /** @type {number} */ (/** @type {unknown} */ (amount)),
    );
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * The wall-clock parts of an airport-local date or date-time string as a `Date` in UTC (so formatting it in UTC shows
 * exactly those parts), or `null` when the text is not a valid local date or date-time. An offset, if present, is
 * ignored: the parts are already local to the airport.
 * @param {unknown} text
 * @returns {Date | null}
 */
export function parseLocalDateTime(text) {
  const match = typeof text === "string" ? LOCAL_DATE_TIME.exec(text) : null;
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute, second));
  // Date.UTC rolls 2026-02-30 over to March: refuse values whose parts do not survive the round trip.
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute;
  return valid ? date : null;
}

/**
 * Formats the parts of a local date-time with `Intl.DateTimeFormat` in UTC; the original text when it is unreadable.
 * @param {string} text
 * @param {string | undefined} locale
 * @param {Intl.DateTimeFormatOptions} options
 */
function formatLocal(text, locale, options) {
  const date = parseLocalDateTime(text);
  return date ? dateFormat(locale, { ...options, timeZone: "UTC" }).format(date) : String(text ?? "");
}

/**
 * The time of an airport-local date-time, without any time-zone conversion: "2026-11-20T08:35:00" → "08:35"
 * (`en-GB`) or "8:35 AM" (`en-US`), wherever the browser is.
 * @param {string} at `SegmentEndpoint.at` and similar local date-times
 * @param {string} [locale]
 */
export const formatLocalTime = (at, locale) => formatLocal(at, locale, { timeStyle: "short" });

/**
 * The date of an airport-local date or date-time, without time-zone conversion: "2026-11-20T23:30:00" →
 * "Fri 20 Nov" (`en-GB`). `options` replace the default parts; the time zone is always UTC (the parts as given).
 * @param {string} at
 * @param {string} [locale]
 * @param {Intl.DateTimeFormatOptions} [options]
 */
export const formatLocalDate = (at, locale, options = { weekday: "short", day: "numeric", month: "short" }) =>
  formatLocal(at, locale, options);

/**
 * Date and time of an airport-local date-time, without time-zone conversion.
 * @param {string} at
 * @param {string} [locale]
 */
export const formatLocalDateTime = (at, locale) =>
  formatLocal(at, locale, { dateStyle: "medium", timeStyle: "short" });

/**
 * The number of calendar days between two airport-local dates (for "+1" on an arrival the next day), or `null` when
 * either value is unreadable.
 * @param {string} from departure `at`
 * @param {string} to arrival `at`
 * @returns {number | null}
 */
export function localDayDifference(from, to) {
  const start = parseLocalDateTime(from);
  const end = parseLocalDateTime(to);
  if (!start || !end) {
    return null;
  }
  const dayOf = (/** @type {Date} */ date) =>
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY;
  return dayOf(end) - dayOf(start);
}

/**
 * A booking timestamp (ISO 8601 with `Z` or an offset) in the OTA's time zone (`config.timeZone`). An unknown time
 * zone falls back to UTC; an unreadable timestamp comes back as it is.
 * @param {string} timestamp
 * @param {string} [locale]
 * @param {string} [timeZone] IANA time zone, for example "Europe/London"
 */
export function formatTimestamp(timestamp, locale, timeZone = "UTC") {
  const date = typeof timestamp === "string" ? new Date(timestamp) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    return String(timestamp ?? "");
  }
  const options = /** @type {const} */ ({ dateStyle: "medium", timeStyle: "short" });
  try {
    return dateFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    return dateFormat(locale, { ...options, timeZone: "UTC" }).format(date);
  }
}

/**
 * The total minutes of an ISO 8601 duration (`PT7H35M` → 455, `P1DT2H` → 1560; seconds rounded to the nearest
 * minute), or `null` when the text is not a duration of days, hours, minutes and seconds.
 * @param {unknown} iso
 * @returns {number | null}
 */
export function durationMinutes(iso) {
  const match = typeof iso === "string" ? ISO_DURATION.exec(iso) : null;
  if (!match) {
    return null;
  }
  const [days, hours, minutes, seconds] = match.slice(1, 5).map((part) => Number(part ?? 0));
  return (days ?? 0) * MINUTES_PER_DAY + (hours ?? 0) * 60 + (minutes ?? 0) + Math.round((seconds ?? 0) / 60);
}

/**
 * A number of minutes as "7 h 35 min", "2 h" or "45 min" (layovers carry `durationMinutes`). Days count as hours
 * ("26 h 5 min"), as travellers read flight durations.
 * @param {number} total
 * @returns {string}
 */
export function formatMinutes(total) {
  if (!Number.isFinite(total) || total < 0) {
    return "";
  }
  const rounded = Math.round(total);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  if (hours === 0) {
    return t("duration.minutes", { minutes });
  }
  return minutes === 0 ? t("duration.hours", { hours }) : t("duration.hoursMinutes", { hours, minutes });
}

/**
 * An ISO 8601 duration as "7 h 35 min" (`PT7H35M`). An unreadable value comes back as it is.
 * @param {string} iso
 * @returns {string}
 */
export function formatDuration(iso) {
  const minutes = durationMinutes(iso);
  return minutes === null ? String(iso ?? "") : formatMinutes(minutes);
}
