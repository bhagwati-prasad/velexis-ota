// UI strings of the storefront (ota/frontend/README.md §7, conventions §4). The MVP is English only: every text a page
// shows lives here, so a translation can come later without touching pages. `t(key, params)` fills `{name}`
// placeholders and picks the plural form of an entry with `one` / `other` forms through `Intl.PluralRules` for the
// `count` parameter. Texts are always set with `textContent`, so parameters are never parsed as HTML.
//
// Money, dates and durations are formatted with `Intl` in lib/format.js (the OTA's `defaultLocale`); the plural rules
// and the numbers inside these strings follow the language of the strings themselves (English).

/** The language of the strings below (and of their plural rules). */
export const LANGUAGE = "en";

/** @typedef {{ one: string, other: string }} PluralEntry */
/** @typedef {string | PluralEntry} Entry */

/** @type {Readonly<Record<string, Entry>>} */
export const STRINGS = Object.freeze({
  // Generic texts.
  "app.loading": "Loading",
  "app.retry": "Try again",
  "app.submitting": "Please wait…",

  // Counts.
  "results.count": { one: "{count} flight", other: "{count} flights" },

  // Header, account menu and footer (src/components/header.js, footer.js, lib/session.js).
  "header.currency": "Currency",
  "header.currencyOption": "{code} ({symbol})",
  "header.currencyChanged": "Prices will be shown in {currency} from your next search",
  "account.signIn": "Sign in",
  "account.account": "My account",
  "footer.terms": "Terms and conditions",
  "footer.privacy": "Privacy policy",
  "footer.cookies": "Cookie policy",
  "footer.refunds": "Cancellation and refunds",
  "footer.imprint": "Legal notice",
  "footer.accessibility": "Accessibility",
  "footer.helpCenter": "Help centre",
  "footer.support": "Support:",
  "footer.supportHours": "({hours})",

  // Durations (lib/format.js): "7 h 35 min".
  "duration.hours": "{hours} h",
  "duration.minutes": "{minutes} min",
  "duration.hoursMinutes": "{hours} h {minutes} min",

  // Forms (lib/forms.js): the error summary and the messages of `fieldErrors[].code` (Ajv keywords and the codes
  // of the API's own checks). A message never repeats the rejected value: it may be a card number or a password.
  "form.errorSummary.title": { one: "There is {count} problem", other: "There are {count} problems" },
  "field.invalid": "Check this field",
  "field.required": "Fill in this field",
  "field.type": "Enter a valid value",
  "field.format": "Enter a value in the right format",
  "field.pattern": "Enter a value in the right format",
  "field.enum": "Choose one of the options",
  "field.const": "Choose one of the options",
  "field.minLength": "This is too short",
  "field.maxLength": "This is too long",
  "field.minimum": "This number is too small",
  "field.maximum": "This number is too large",
  "field.exclusiveMinimum": "This number is too small",
  "field.exclusiveMaximum": "This number is too large",
  "field.minItems": "Add more entries",
  "field.maxItems": "Remove some entries",
  "field.additionalProperties": "This field is not allowed",
  "field.luhn": "Check the card number",
  "field.expired": "The card has expired",
  // TravelerFieldErrorCode: business rules of TRAVELER_DATA_INVALID, CONTACT_DATA_INVALID and CHECKOUT_INCOMPLETE.
  "field.REQUIRED": "Fill in this field",
  "field.INVALID_FORMAT": "Enter a value in the right format",
  "field.INVALID_CHARACTERS": "Use only Latin letters, spaces, hyphens and apostrophes",
  "field.NAME_TOO_LONG": "This name is too long for the airline",
  "field.AGE_MISMATCH_TRAVELER_TYPE": "The date of birth does not match this passenger type",
  "field.INFANT_OLDER_THAN_ADULT": "An infant must be younger than the adult travelling with them",
  "field.UNKNOWN_TRAVELER_ID": "This passenger is not part of the booking",
  "field.DUPLICATE_TRAVELER": "This passenger is entered twice",
  "field.SAVED_TRAVELER_NOT_FOUND": "This saved passenger no longer exists",
  "field.DOCUMENT_EXPIRED": "This document has expired",
  "field.DOCUMENT_EXPIRES_BEFORE_RETURN": "This document expires before the last flight",
  "field.DOCUMENT_TYPE_NOT_ACCEPTED": "The airline does not accept this type of document",
  "field.DISCOUNT_DATA_REQUIRED": "The airline needs the discount details",
  "field.EMAIL_INVALID": "Enter a valid e-mail address",
  "field.PHONE_INVALID": "Enter a valid phone number",
  "field.MOBILE_PHONE_REQUIRED": "Enter a mobile phone number",
  "field.COUNTRY_CALLING_CODE_REQUIRED": "Choose the country calling code",
  "field.PRIMARY_CONTACT_REQUIRED": "Add a contact for this booking",
  "field.INVOICE_ADDRESS_REQUIRED": "Add an invoice address",
  "field.POSTAL_CODE_REQUIRED": "Enter the postal code",
  "field.TOO_MANY_CONTACTS": "Remove a contact",
  "field.REJECTED_BY_AIRLINE": "The airline did not accept this value",

  // Page states (lib/errors.js, ota/frontend/docs/pages.md §2 and the pages' state tables).
  "state.suspended": "This travel site is temporarily unavailable",
  "state.unknown-host": "This storefront does not exist",
  "state.unavailable": "The service is not available right now. Nothing is lost: try again in a moment.",
  "state.rate-limited": "Busy, try again in a few seconds",
  "state.supplier-not-configured": "Flight search is not available yet",
  "state.supplier-unavailable": "Airlines are not answering right now",
  "state.supplier-timeout": "Airlines are not answering right now",
  "state.supplier-error": "The airline could not complete this request",
  "state.search-expired": "Prices have expired",
  "state.offer-expired": "This fare is no longer available",
  "state.checkout-expired": "Your session expired",
  "state.expired": "This page has expired",
  "state.price-changed": "The airline changed the price",
  "state.sold-out": "This flight just sold out",
  "state.stale": "This was updated in another tab. Reload to see the latest version.",
  "state.conflict": "This could not be done in its current state",
  "state.payment-failed": "The payment did not go through",
  "state.not-found": "We could not find what you are looking for",
  "state.signed-out": "Sign in to continue",
  "state.email-not-verified": "Verify your e-mail address to continue",
  "state.feature-disabled": "This is not available on this site",
  "state.forbidden": "You cannot do this",
  "state.validation": "Check the highlighted fields",
  "state.aborted": "Cancelled",
  "state.unexpected": "Something went wrong. Please try again.",
  // A second line under some state titles (src/boot.js renderState).
  "stateHint.suspended": "Please come back later.",
  "stateHint.unknown-host":
    "Check the address in your browser. If you followed a link, it may be out of date.",
  "stateHint.supplier-not-configured": "This travel site is still being set up. Please come back later.",
});

const plurals = new Intl.PluralRules(LANGUAGE);
const numbers = new Intl.NumberFormat(LANGUAGE);

/**
 * Whether a string with this key exists.
 * @param {string} key
 */
export const hasString = (key) => Object.hasOwn(STRINGS, key);

/**
 * A parameter as text: numbers with the grouping of the strings' language, everything else with `String`.
 * @param {unknown} value
 */
const asText = (value) =>
  typeof value === "number" && Number.isFinite(value) ? numbers.format(value) : String(value);

/**
 * The UI string `key` with its `{name}` placeholders filled from `params`. An entry with plural forms is chosen by
 * `params.count` (`Intl.PluralRules`). An unknown key comes back as the key itself, so a missing string shows up in
 * review instead of an empty element; a placeholder without a parameter stays as it is.
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params = {}) {
  if (!hasString(key)) {
    return key;
  }
  const entry = /** @type {Entry} */ (STRINGS[key]);
  const template =
    typeof entry === "string"
      ? entry
      : plurals.select(Number(params["count"])) === "one"
        ? entry.one
        : entry.other;
  return template.replace(/\{(\w+)\}/g, (placeholder, /** @type {string} */ name) =>
    Object.hasOwn(params, name) ? asText(params[name]) : placeholder,
  );
}

/**
 * The message of one API field error, from its `code` (never from the rejected value). Codes without a string of their
 * own get the generic "Check this field"; the API's English `message` is written for developers and is not shown.
 * @param {{ code?: unknown }} fieldError
 * @returns {string}
 */
export function fieldErrorMessage(fieldError) {
  const key = `field.${String(fieldError.code)}`;
  return hasString(key) ? t(key) : t("field.invalid");
}
