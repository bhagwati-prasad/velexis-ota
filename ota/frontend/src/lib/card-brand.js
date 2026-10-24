// Card checks of the airline-card page (checkout/pay-airline.html, ota/frontend/docs/pages.md §9, OADR-0017 point 5):
// the brand detected locally from the first digits, so the page can quote the airline's card fee with
// `checkout.updatePayment({ paymentId, card: { brand, bin } })` before the card is sent, and the checks the API makes
// anyway (Luhn digit, expiry), so a typing mistake never costs the traveller one of the checkout's three attempts.
//
// Only the first digits (at most the six of the BIN) decide the brand. A first-digits table can tell the card network
// (Visa, Mastercard, American Express, Diners Club, Maestro, UATP) and Visa Electron, but not whether a card is a debit
// or a prepaid one (VISA_DEBIT, MASTERCARD_IXARIS, …): each network therefore lists its Amadeus brands in order of
// preference, and the first one the OTA accepts (`config.payment.airlineCard.cardBrands`) is the card's brand. The
// airline checks the card itself; this table only picks the brand of the fee quote.
//
// Nothing here keeps a value: every function takes the digits as an argument and returns a fact about them.

/** How many first digits the API takes as the BIN (PaymentCardHint `bin`). */
export const BIN_LENGTH = 6;

/** @typedef {"visa" | "mastercard" | "amex" | "diners" | "maestro" | "uatp"} CardNetwork */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontCardBrand"]} StorefrontCardBrand */
/** @typedef {StorefrontCardBrand["amadeus"]} AmadeusBrand */

/**
 * First-digits rules, most specific first: the network and its Amadeus brands in order of preference (the first one
 * the OTA accepts wins). Ranges from the networks' published IIN tables.
 * @type {ReadonlyArray<{ network: CardNetwork, prefix: RegExp, brands: readonly AmadeusBrand[] }>}
 */
const RULES = Object.freeze([
  { network: "uatp", prefix: /^1/, brands: ["UATP_AIRPLUS"] },
  { network: "amex", prefix: /^3[47]/, brands: ["AMERICAN_EXPRESS"] },
  { network: "diners", prefix: /^3(?:0[0-5]|095|[689])/, brands: ["DINERS"] },
  {
    network: "visa",
    prefix: /^4(?:026|17500|405|508|844|91[37])/,
    brands: ["VISA_ELECTRON", "VISA", "VISA_DEBIT"],
  },
  { network: "visa", prefix: /^4/, brands: ["VISA", "VISA_DEBIT", "VISA_ELECTRON", "VISA_IXARIS"] },
  {
    network: "mastercard",
    prefix: /^(?:5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/,
    brands: ["MASTERCARD", "MASTERCARD_DEBIT", "MASTERCARD_IXARIS", "MASTERCARD_AIRPLUS"],
  },
  { network: "maestro", prefix: /^(?:50|5[6-8]|6304|6759|676[1-3])/, brands: ["MAESTRO"] },
]);

/** Security code lengths by network: four digits on American Express, three elsewhere (UATP: either). */
const SECURITY_CODE_LENGTHS = Object.freeze({ amex: [4], uatp: [3, 4] });

/**
 * The digits of a typed card number, with the spaces and dashes people type between groups removed; `null` when
 * anything else is in it.
 * @param {string} text
 * @returns {string | null}
 */
export function cardDigits(text) {
  const digits = text.replace(/[\s-]/g, "");
  return /^\d*$/.test(digits) ? digits : null;
}

/**
 * The first-digits rule that `digits` starts with (as soon as there are enough digits to tell), or `null`.
 * @param {string} digits
 */
const ruleOf = (digits) => RULES.find((rule) => rule.prefix.test(digits)) ?? null;

/**
 * The card network of a number from its first digits, or `null` when they belong to none the airline card takes.
 * @param {string} digits
 * @returns {CardNetwork | null}
 */
export const cardNetwork = (digits) => ruleOf(digits)?.network ?? null;

/**
 * The brand to quote and send for a card: the first Amadeus brand of its network that the OTA accepts, with its label
 * (`{ amadeus: "VISA", label: "Visa" }`), or `null` for a network the OTA does not accept or a number that belongs to
 * none.
 * @param {string} digits the card number's digits (at least its BIN)
 * @param {ReadonlyArray<Partial<StorefrontCardBrand>> | null | undefined} accepted `config.payment.airlineCard.cardBrands`
 * @returns {{ amadeus: AmadeusBrand, label: string } | null}
 */
export function acceptedCardBrand(digits, accepted) {
  const rule = ruleOf(digits);
  const brands = Array.isArray(accepted) ? accepted : [];
  for (const amadeus of rule?.brands ?? []) {
    const entry = brands.find((brand) => brand?.amadeus === amadeus);
    if (entry) {
      return {
        amadeus,
        label: typeof entry.label === "string" && entry.label !== "" ? entry.label : amadeus,
      };
    }
  }
  return null;
}

/**
 * Whether `digits` (12 to 19 digits) end with a valid Luhn check digit (ISO/IEC 7812-1), as the API checks it.
 * @param {string} digits
 */
export function luhnValid(digits) {
  if (!/^\d{12,19}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Whether a card of `month`/`year` has expired at `now`: a card is valid until the end of its expiry month, and only a
 * month that has ended (UTC, as the API decides) has expired.
 * @param {number} month 1 to 12
 * @param {number} year four digits
 * @param {Date} now
 */
export function cardExpired(month, year, now) {
  const thisYear = now.getUTCFullYear();
  return year < thisYear || (year === thisYear && month < now.getUTCMonth() + 1);
}

/**
 * Whether a security code has the length of its network's codes (any 3 or 4 digits for an unknown network).
 * @param {string} code
 * @param {CardNetwork | null} network
 */
export function securityCodeValid(code, network) {
  const lengths =
    network === null
      ? [3, 4]
      : (SECURITY_CODE_LENGTHS[/** @type {keyof typeof SECURITY_CODE_LENGTHS} */ (network)] ?? [3]);
  return /^\d+$/.test(code) && lengths.includes(code.length);
}
