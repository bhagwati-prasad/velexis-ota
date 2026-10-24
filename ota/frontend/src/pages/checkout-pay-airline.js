// Entry module of the airline-card payment page (checkout/pay-airline.html, ota/frontend/docs/pages.md §9, flow
// ota/docs/flows/checkout-airline-card.md §3, OADR-0017). The checkout page opens it with
// `/checkout/pay-airline.html?id=chk_…&payment=pay_…` after `checkout.createPayment({ method: "airline_card" })`. The
// traveller types the card into this page's own form and the airline charges it through Amadeus: the only page of the
// storefront that holds card values, so it is built on its own (vite.config.js) and runs nothing but this module, the
// SDK and a few lib/ helpers, within 30 KB gzip, under its own CSP without any Stripe host.
//
// 1. State only from the address (`id`, `payment`) and the API: a fresh `storefront.get` (never the sessionStorage copy
//    of lib/config.js, nor anything else that other pages of the origin can write), `checkout.get` and
//    `checkout.getPayment`. The form is shown only when `storefront.get` offers the airline card (its edge-only
//    `supportedMethods`, which leave it out while the method is switched off or suspended) and the payment awaits a
//    card. This page does not use boot(): header and footer are the static partials.
// 2. Six digits typed: the brand is detected locally (lib/card-brand.js) and `checkout.updatePayment({ paymentId, card:
//    { brand, bin } })` quotes the airline's card fee; the review shows the amount the airline charges.
// 3. Pay: the inputs are read into one local object passed straight to `checkout.completeWithAirlineCard` with a new
//    idempotency key per submit and 90 s; the SDK never retries it. Success opens `/confirmation.html?booking=…`;
//    `504 SUPPLIER_TIMEOUT` (and a lost connection that left a booking) opens it in pending mode, and the card is never
//    sent again.
//
// Card values are never written to storage, cookies, the address, `history.state`, an event, the console or an error
// report: this module calls none of them. The inputs have no `name` (a submit without this script sends nothing) and
// are emptied after success, after every answer of the completion and on `pagehide`, so neither Back nor the
// back-forward cache shows them again. The texts live here rather than in lib/i18n.js, which would not fit the page's
// budget (README §9).

import { VelexisError } from "@velexis/ota-sdk";

import { mount as mountLiveRegion } from "../components/live-region.js";
import { mount as mountTestBanner } from "../components/test-banner.js";
import {
  BIN_LENGTH,
  acceptedCardBrand,
  cardDigits,
  cardExpired,
  cardNetwork,
  luhnValid,
  securityCodeValid,
} from "../lib/card-brand.js";
import { client as storefrontClient } from "../lib/client.js";
import { clone, fill } from "../lib/dom.js";
import { applyTheme } from "../lib/theme.js";
import { withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Checkout"]} Checkout */
/** @typedef {import("@velexis/ota-sdk").Schemas["Payment"]} Payment */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontPaymentConfig"]} PaymentConfig */
/** @typedef {Awaited<ReturnType<VelexisClient["storefront"]["get"]>>} StorefrontConfig */
/** @typedef {{ storefront: Pick<VelexisClient["storefront"], "get">, checkout: Pick<VelexisClient["checkout"], "get" | "getPayment" | "updatePayment" | "completeWithAirlineCard"> }} PageClient */
/** @typedef {"holder" | "number" | "expiry" | "csc"} CardField */
/** @typedef {import("../lib/card-brand.js").AmadeusBrand} AmadeusBrand */
/** @typedef {Parameters<VelexisClient["checkout"]["completeWithAirlineCard"]>[0]["card"]} CardInput */
/**
 * A state shown in place of the form (`block`) or above it (`notice`).
 * @typedef {object} State
 * @property {string} name its `data-state`
 * @property {string} title
 * @property {string | null} [hint]
 * @property {"page" | "inline"} [scope]
 * @property {string | null} [requestId]
 * @property {Array<{ label: string, href: string }>} [links]
 * @property {(() => void) | null} [retry]
 * @property {number} [retryAfter] seconds before Retry is enabled
 */

const CHECKOUT_ID = /^chk_[0-9A-Za-z]{16,40}$/;
const PAYMENT_ID = /^pay_[0-9A-Za-z]{16,40}$/;
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
const PRICED_OFFER_ID = /^prc_[0-9A-Za-z]{16,40}$/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
/** The holder name as the API takes it: 2 to 64 letters, spaces, `.`, `'` and `-`. */
const HOLDER = /^[A-Za-z .'-]{2,64}$/;
/** `checkout.completeWithAirlineCard` waits up to 90 s (the airline books and charges in one call). */
export const COMPLETION_TIMEOUT_MS = 90_000;
/** Payment statuses that take a card: awaiting one, or declined (the same payment takes the next card). */
const OPEN_STATUSES = new Set(["requires_payment_method", "failed"]);
/** The completion's field errors, by the request's JSON pointer. */
const FIELD_BY_PATH = /** @type {Record<string, CardField>} */ ({
  "/card/holderName": "holder",
  "/card/number": "number",
  "/card/brand": "number",
  "/card/expiryMonth": "expiry",
  "/card/expiryYear": "expiry",
  "/card/securityCode": "csc",
});

/** The page's texts (English, README §7). */
export const TEXT = Object.freeze({
  title: "Pay with your card – Checkout",
  loading: "Loading your payment…",
  ready: "Type your card. The airline's total is shown before you pay.",
  missing: "We could not find this payment",
  notOffered: "Paying with the airline card is not available",
  notOfferedHint: "Choose another way to pay. Nothing was charged.",
  otherMethod: "Choose another payment method",
  inactive: "This payment can no longer be used",
  inactiveHint: "Start the payment again from the payment step. Nothing was charged.",
  expired: "Your session expired",
  expiredHint: "Prices are held for a short time only. Price the flight again to see the current price.",
  priceAgain: "Price this flight again",
  searchFlights: "Search flights",
  signedOut: "Sign in to continue",
  signIn: "Sign in",
  suspended: "This travel site is temporarily unavailable",
  suspendedHint: "Please come back later.",
  unknownHost: "This storefront does not exist",
  unavailable: "The service is not available right now. Nothing is lost: try again in a moment.",
  rateLimited: "Busy, try again in a few seconds",
  unexpected: "Something went wrong. Please try again.",
  card: "{brand} card",
  brandNotAccepted: "We cannot take this card. Pay with one of these cards: {brands}.",
  brandNotAcceptedNone: "We cannot take this card. Please choose another payment method.",
  quoting: "Checking the airline's card fee…",
  quoted: "The airline charges {price}",
  quoteFailed: "We could not check the airline's card fee",
  quotePriceChanged: "The airline changed the price",
  quotePriceChangedHint: "Go back to the payment step to see the new total. Nothing was charged.",
  noCardFee: "No card fee",
  review: "Review the total",
  reviewHint: "Check the total, then pay.",
  pay: "Pay {price}",
  paying: "Booking your flight with the airline. Do not close this page.",
  booked: "Your booking is confirmed. Opening your confirmation…",
  heldUntil: "We hold this price until {time}.",
  errorHolder: "Enter the name as it is written on the card",
  errorNumber: "Check the card number",
  errorExpiry: "Enter the expiry month (MM) and year (YYYY) of the card",
  errorExpired: "This card has expired",
  errorCsc: "Enter the security code: 3 digits, or 4 on an American Express card",
  declined: "The airline declined the card",
  declinedHint:
    "Nothing was booked. Check the card details or use another card: a booking takes at most three attempts.",
  attemptsExceeded: "Too many attempts",
  attemptsExceededHint:
    "This booking can no longer be paid with the airline card. Pay by card, or start a new booking.",
  payByCard: "Pay by card",
  priceChanged: "The airline changed the price",
  newTotal: "The new total is {new} (before: {old}). Type your card again to pay it.",
  newTotalOnly: "The new total is {new}. Type your card again to pay it.",
  amountChanged: "The total changed. Type your card again to see the final total.",
  soldOut: "This flight sold out",
  soldOutHint: "Nothing was booked and your card was not charged. Choose another flight.",
  notBooked: "Your booking did not go through",
  notBookedHint: "The airline could not confirm it. Your card was not charged.",
  incomplete: "Some details are still missing",
  incompleteHint: "Your card was not charged. Check your details, then pay again.",
  checkDetails: "Check your details",
  notConfigured: "Flight booking is not available yet",
  notSent: "The payment did not go through. Nothing was charged. Type your card again.",
  emailNotVerified: "Verify your e-mail address to book",
  emailNotVerifiedHint: "Open the link in the e-mail we sent you, then type your card again.",
  confirming: "We are confirming your booking with the airline",
  confirmingHint: "Do not pay again. Check again in a moment, or wait for our e-mail.",
  outcomeUnknown: "We could not check whether your booking went through",
  outcomeUnknownHint: "Do not pay again until we know. Check your connection, then check again.",
  checkAgain: "Check again",
});

/**
 * `text` with its `{name}` placeholders filled.
 * @param {string} text
 * @param {Record<string, string>} [params]
 */
const format = (text, params = {}) =>
  text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(params, key) ? String(params[key]) : match));

/**
 * Money as the API gives it (`{ amount: "412.30", currency: "EUR" }`), formatted with `Intl` from the decimal text.
 * @param {Money | null | undefined} money
 * @param {string | undefined} locale
 */
function formatMoney(money, locale) {
  if (!money || typeof money.amount !== "string" || typeof money.currency !== "string") {
    return "";
  }
  if (DECIMAL.test(money.amount)) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: money.currency }).format(
        /** @type {number} */ (/** @type {unknown} */ (money.amount)),
      );
    } catch {
      // An unknown locale or currency: the plain text below.
    }
  }
  return `${money.amount} ${money.currency}`;
}

/**
 * An `Intl.DateTimeFormat` result, or `null` for a date or option the browser refuses.
 * @param {Date} date
 * @param {string | undefined} locale
 * @param {Intl.DateTimeFormatOptions} options
 */
function formatDate(date, locale, options) {
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return null;
  }
}

/**
 * Whether the OTA offers the airline card on this storefront: `supportedMethods` lists it and its configuration is
 * not switched off.
 * @param {Partial<PaymentConfig> | null | undefined} payment `storefront.get` `payment`
 */
export const airlineCardOffered = (payment) =>
  Array.isArray(payment?.supportedMethods) &&
  payment.supportedMethods.includes("airline_card") &&
  payment.airlineCard?.enabled === true;

/** @param {unknown} error */
const codeOf = (error) => (error instanceof VelexisError ? error.code : "UNEXPECTED");
/** @param {unknown} error @returns {Record<string, unknown>} */
const detailsOf = (error) => (error instanceof VelexisError && error.details ? error.details : {});
/** @param {unknown} error */
const requestIdOf = (error) => (error instanceof VelexisError ? error.requestId : null);
/** @param {unknown} value */
const bookingIdOf = (value) => (typeof value === "string" && BOOKING_ID.test(value) ? value : null);

/**
 * The confirmation page of a booking (`pending=1` while the airline order is being confirmed).
 * @param {string} bookingId
 * @param {boolean} [pending]
 */
const confirmationHref = (bookingId, pending = false) =>
  withQuery("/confirmation.html", { booking: bookingId, pending: pending ? 1 : null });

/**
 * Runs the airline-card page (see the top of this file) in `doc`. Returns `null` when the page has no payment area,
 * else `{ done, destroy }`: `done` settles once the form (or a state) is shown.
 * @param {{ client: PageClient }} context
 * @param {{ doc?: Document, location?: Location, replace?: (url: string) => void, reload?: () => void, now?: () => Date, newKey?: () => string }} [env]
 *   for tests: the address, the navigation, the clock and the idempotency keys
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-pay-airline-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const replace = env.replace ?? ((/** @type {string} */ url) => location.replace(url));
  const reload = env.reload ?? (() => location.reload());
  const now = env.now ?? (() => new Date());
  const newKey = env.newKey ?? (() => view.crypto.randomUUID());
  const { client } = context;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const el = {
    back: /** @type {HTMLAnchorElement} */ (main.querySelector("a[data-back-link]")),
    state: find("[data-pay-state]"),
    loading: find("[data-pay-loading]"),
    content: find("[data-pay-content]"),
    notice: find("[data-pay-notice]"),
    airlineNotice: find("[data-airline-notice]"),
    form: /** @type {HTMLFormElement} */ (main.querySelector("form[data-card-form]")),
    accepted: find("[data-accepted-brands]"),
    acceptedList: find("[data-accepted-brand-list]"),
    errors: find("[data-card-errors]"),
    errorList: find("[data-card-error-list]"),
    brand: find("[data-card-brand]"),
    review: find("[data-review-panel]"),
    reviewCard: find("[data-review-card]"),
    reviewCardFee: find("[data-review-card-fee]"),
    reviewTotal: find("[data-review-total]"),
    reviewNotice: find("[data-review-notice]"),
    payButton: /** @type {HTMLButtonElement} */ (main.querySelector("button[data-pay-button]")),
    progress: find("[data-pay-progress]"),
    trip: find("[data-pay-trip]"),
    totalOffer: find("[data-total-offer]"),
    totalExtrasRow: find("[data-total-extras-row]"),
    totalExtras: find("[data-total-extras]"),
    totalCardFeeRow: find("[data-total-card-fee-row]"),
    totalCardFee: find("[data-total-card-fee]"),
    total: find("[data-total]"),
    expiry: find("[data-pay-expiry]"),
  };
  const input = (/** @type {string} */ name) =>
    /** @type {HTMLInputElement} */ (main.querySelector(`input[data-card-input="${name}"]`));
  const inputs = {
    holder: input("holder"),
    number: input("number"),
    month: input("month"),
    year: input("year"),
    csc: input("csc"),
  };
  /** The inputs of each field (the expiry has two). @type {Record<CardField, HTMLInputElement[]>} */
  const fieldInputs = {
    holder: [inputs.holder],
    number: [inputs.number],
    expiry: [inputs.month, inputs.year],
    csc: [inputs.csc],
  };

  const params = new URLSearchParams(location.search);
  const idParam = params.get("id");
  const paymentParam = params.get("payment");
  const checkoutId = idParam !== null && CHECKOUT_ID.test(idParam) ? idParam : null;
  const paymentId = paymentParam !== null && PAYMENT_ID.test(paymentParam) ? paymentParam : null;
  const paymentStep =
    checkoutId === null ? "/" : withQuery("/checkout.html", { id: checkoutId, step: "payment" });

  /** @type {StorefrontConfig | null} */
  let config = null;
  /** @type {Checkout | null} */
  let checkout = null;
  /** The payment on the screen (after a quote, its amount with the airline's card fee). @type {Payment | null} */
  let payment = null;
  /**
   * The card-fee quote of the first six digits on the screen: its brand, and the quoted payment once it answered.
   * @type {{ bin: string, brand: AmadeusBrand, label: string, payment: Payment | null, running: Promise<void> | null, abort: AbortController } | null}
   */
  let quote = null;
  let busy = false;
  let blocked = false;
  let leaving = false;
  let destroyed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let waitTimer;
  /** @type {Array<() => void>} */
  const cleanups = [];
  const loadAbort = new AbortController();

  const locale = () => config?.defaultLocale;
  const money = (/** @type {Money | null | undefined} */ value) => formatMoney(value, locale());
  /** The accepted brands of the airline card (`payment.airlineCard.cardBrands`). */
  const cardBrands = () => config?.payment?.airlineCard?.cardBrands ?? [];

  /** The OTA's support address, unless it is the API's `.invalid` placeholder. */
  const supportEmail = () => {
    const email = typeof config?.support?.email === "string" ? config.support.email.trim() : "";
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    return email.lastIndexOf("@") > 0 && domain !== "" && !/(?:^|\.)invalid\.?$/.test(domain) ? email : null;
  };

  /**
   * Renders a state (partials/states.html) into `container`, with its links and Retry.
   * @param {HTMLElement} container
   * @param {State} state
   */
  const renderState = (container, state) => {
    const { name, title, hint = null, scope = "inline", requestId = null, links = [], retry = null } = state;
    const email = supportEmail();
    const element = clone(scope === "page" ? "tpl-state-page" : "tpl-state-inline", doc);
    fill(element, {
      name,
      title,
      hint,
      noHint: hint === null,
      supportEmail: email,
      supportHref: email === null ? null : `mailto:${email}`,
      noSupport: email === null,
      requestId,
      noRequestId: !requestId,
      noRetry: retry === null,
    });
    const retryRow = element.querySelector('[data-action="retry"]')?.closest("p") ?? null;
    for (const link of links) {
      const row = fill(clone("tpl-state-link", doc), link);
      if (retryRow) {
        retryRow.before(row);
      } else {
        element.append(row);
      }
    }
    const button = /** @type {HTMLButtonElement | null} */ (element.querySelector('[data-action="retry"]'));
    if (button && retry) {
      const wait = state.retryAfter ?? 0;
      if (wait > 0) {
        button.disabled = true;
        setTimeout(() => {
          button.disabled = false;
        }, wait * 1000);
      }
      button.addEventListener("click", () => {
        if (!button.disabled) {
          button.disabled = true;
          retry();
        }
      });
    } else {
      button?.closest("p")?.remove();
    }
    container.replaceChildren(element);
    /** @type {HTMLElement | null} */ (element.querySelector('[tabindex="-1"]'))?.focus();
    live.announce(title);
    return element;
  };

  // ---- the card inputs --------------------------------------------------------------------------------------------

  /** Shows the button for the next step: "Review the total" until the fee is quoted, then "Pay €…". */
  const renderButton = () => {
    if (busy) {
      return;
    }
    el.payButton.textContent =
      quote?.payment && payment ? format(TEXT.pay, { price: money(payment.amount) }) : TEXT.review;
  };

  /** Forgets the card-fee quote: a new card number, an answer of the completion, or a price change. */
  const dropQuote = () => {
    quote?.abort.abort();
    quote = null;
    el.review.hidden = true;
    renderButton();
  };

  /** Empties every card input (and with them the quote): after each answer of the completion and on `pagehide`. */
  const clearCard = () => {
    for (const field of Object.values(inputs)) {
      field.value = "";
    }
    el.brand.textContent = "";
    dropQuote();
  };

  const clearFieldErrors = () => {
    el.errors.hidden = true;
    el.errorList.replaceChildren();
    for (const message of main.querySelectorAll("[data-field-error]")) {
      message.textContent = "";
      /** @type {HTMLElement} */ (message).hidden = true;
    }
    for (const field of Object.values(inputs)) {
      field.removeAttribute("aria-invalid");
    }
  };

  /**
   * Marks fields with their messages (never their values) and focuses the summary of the problems.
   * @param {Array<{ field: CardField, message: string }>} problems
   */
  const showFieldErrors = (problems) => {
    clearFieldErrors();
    for (const { field, message } of problems) {
      const [first] = fieldInputs[field];
      for (const control of fieldInputs[field]) {
        control.setAttribute("aria-invalid", "true");
      }
      const id = field === "expiry" ? "card-expiry-error" : `${first?.id}-error`;
      const text = /** @type {HTMLElement | null} */ (main.querySelector(`#${id}`));
      if (text) {
        text.textContent = message;
        text.hidden = false;
      }
      el.errorList.append(fill(clone("tpl-card-error", doc), { message, href: `#${first?.id}` }));
    }
    el.errors.hidden = false;
    el.errors.focus();
    live.announce(problems.map((problem) => problem.message).join(". "));
  };

  /** "We cannot take this card", with the accepted brands. */
  const brandMessage = () => {
    const labels = cardBrands()
      .map((brand) => brand?.label)
      .filter((label) => typeof label === "string" && label !== "");
    return labels.length > 0
      ? format(TEXT.brandNotAccepted, { brands: labels.join(", ") })
      : TEXT.brandNotAcceptedNone;
  };

  // ---- summary and review -----------------------------------------------------------------------------------------

  const renderSummary = () => {
    if (!checkout) {
      return;
    }
    const itineraries = Array.isArray(checkout.itineraries) ? checkout.itineraries : [];
    el.trip.replaceChildren(
      ...itineraries.map((itinerary) => {
        const item = doc.createElement("li");
        const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(itinerary?.departureAt ?? ""));
        const date = day
          ? formatDate(new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))), locale(), {
              weekday: "short",
              day: "numeric",
              month: "short",
              timeZone: "UTC",
            })
          : null;
        item.textContent = [`${itinerary?.originCode} → ${itinerary?.destinationCode}`, date]
          .filter(Boolean)
          .join(" · ");
        return item;
      }),
    );
    const totals = checkout.totals;
    const cardFee = payment ? (payment.cardFee ?? null) : (totals?.cardFee ?? null);
    el.totalOffer.textContent = money(totals?.offer);
    const extras = Array.isArray(checkout.ancillaries) && checkout.ancillaries.length > 0;
    el.totalExtrasRow.hidden = !extras;
    el.totalExtras.textContent = extras ? money(totals?.ancillaries) : "";
    el.totalCardFeeRow.hidden = !cardFee;
    el.totalCardFee.textContent = cardFee ? money(cardFee) : "";
    el.total.textContent = money(payment?.amount ?? totals?.total);
    const expires = new Date(String(checkout.expiresAt));
    const time = Number.isNaN(expires.getTime())
      ? null
      : formatDate(expires, locale(), { timeStyle: "short", timeZone: config?.timeZone ?? "UTC" });
    el.expiry.textContent = time === null ? "" : format(TEXT.heldUntil, { time });
  };

  /** The review: the card, the airline's card fee and the amount the airline charges. */
  const renderReview = () => {
    if (!quote?.payment || !payment) {
      return;
    }
    el.reviewCard.textContent = quote.label;
    el.reviewCardFee.textContent = payment.cardFee ? money(payment.cardFee) : TEXT.noCardFee;
    el.reviewTotal.textContent = money(payment.amount);
    el.reviewNotice.textContent = el.airlineNotice.textContent ?? "";
    el.review.hidden = false;
    renderButton();
  };

  // ---- states -----------------------------------------------------------------------------------------------------

  /**
   * Replaces the form with a state: the card cannot be taken here (or not yet). A full-page state (an unknown or
   * suspended storefront) replaces the whole of `<main>`, as boot() does on the other pages.
   * @param {State} state
   */
  const block = (state) => {
    blocked = true;
    clearCard();
    el.loading.hidden = true;
    el.content.hidden = true;
    doc.title = state.title;
    renderState(state.scope === "page" ? main : el.state, state);
  };

  /**
   * A state above the form, which stays.
   * @param {State} state
   */
  const notice = (state) => renderState(el.notice, state);

  /** The price page of the checkout's flight, to price it again; else the search. */
  const priceAgain = () =>
    checkout && PRICED_OFFER_ID.test(checkout.basePricedOfferId)
      ? { label: TEXT.priceAgain, href: withQuery("/price.html", { priced: checkout.basePricedOfferId }) }
      : { label: TEXT.searchFlights, href: "/" };

  const signInLink = () => ({
    label: TEXT.signIn,
    href: withQuery("/account/sign-in.html", { next: `${location.pathname}${location.search}` }),
  });

  /**
   * The state of a failed load, with Retry when the same call may succeed later.
   * @param {unknown} error
   */
  const loadFailed = (error) => {
    const code = codeOf(error);
    const retry = () => {
      blocked = false;
      load().catch(() => {});
    };
    if (code === "TENANT_SUSPENDED" || code === "HOST_NOT_ALLOWED") {
      block({
        name: code === "TENANT_SUSPENDED" ? "suspended" : "unknown-host",
        title: code === "TENANT_SUSPENDED" ? TEXT.suspended : TEXT.unknownHost,
        hint: code === "TENANT_SUSPENDED" ? TEXT.suspendedHint : null,
        scope: "page",
      });
    } else if (code === "NOT_FOUND") {
      block({
        name: "not-found",
        title: TEXT.missing,
        links: [{ label: TEXT.otherMethod, href: paymentStep }],
      });
    } else if (code === "CHECKOUT_EXPIRED") {
      block({ name: "checkout-expired", title: TEXT.expired, hint: TEXT.expiredHint, links: [priceAgain()] });
    } else if (error instanceof VelexisError && error.status === 401) {
      block({ name: "signed-out", title: TEXT.signedOut, links: [signInLink()] });
    } else if (code === "RATE_LIMITED") {
      const wait = /** @type {{ retryAfterSeconds?: unknown }} */ (error).retryAfterSeconds;
      block({
        name: "rate-limited",
        title: TEXT.rateLimited,
        retry,
        retryAfter: typeof wait === "number" ? wait : 0,
      });
    } else if (error instanceof VelexisError && (error.status === 0 || error.status === 503)) {
      block({ name: "unavailable", title: TEXT.unavailable, retry });
    } else {
      block({ name: "unexpected", title: TEXT.unexpected, requestId: requestIdOf(error), retry });
    }
  };

  /**
   * After an answer that leaves the outcome open (a lost connection, a timeout without its booking): the checkout says
   * whether a booking exists. It opens the booking's confirmation; without one, the card can be typed again (the API
   * never sends a card while another completion of the checkout is pending). The card is never sent from here.
   * @param {{ pending: boolean }} options `pending`: the API said the booking is pending (504), so a checkout without
   *   one is not read as "nothing happened"
   */
  const checkBooking = async ({ pending }) => {
    /** @type {Checkout} */
    let current;
    try {
      current = await client.checkout.get({ checkoutId: /** @type {string} */ (checkoutId) });
    } catch {
      if (!destroyed) {
        block({
          name: "outcome-unknown",
          title: TEXT.outcomeUnknown,
          hint: TEXT.outcomeUnknownHint,
          retry: () => checkBooking({ pending }).catch(() => {}),
        });
      }
      return;
    }
    if (destroyed) {
      return;
    }
    checkout = current;
    const bookingId = bookingIdOf(current.bookingId);
    if (bookingId !== null) {
      leaving = true;
      replace(confirmationHref(bookingId, current.status !== "completed"));
    } else if (pending) {
      block({
        name: "confirming",
        title: TEXT.confirming,
        hint: TEXT.confirmingHint,
        retry: () => checkBooking({ pending }).catch(() => {}),
      });
    } else {
      if (blocked) {
        blocked = false;
        el.state.replaceChildren();
        el.content.hidden = false;
      }
      notice({ name: "not-sent", title: TEXT.notSent });
    }
  };

  /**
   * The answer to a failed completion (pages.md §9). The inputs are already empty.
   * @param {unknown} error
   */
  const failCompletion = async (error) => {
    const code = codeOf(error);
    const details = detailsOf(error);
    const bookingId = bookingIdOf(details["bookingId"]);
    if (
      code === "SUPPLIER_TIMEOUT" ||
      code === "CHECKOUT_BEING_COMPLETED" ||
      code === "CHECKOUT_ALREADY_COMPLETED"
    ) {
      // The order may exist: its confirmation, in pending mode until it is decided. Never the card again.
      if (bookingId !== null) {
        leaving = true;
        replace(confirmationHref(bookingId, code !== "CHECKOUT_ALREADY_COMPLETED"));
        return;
      }
      await checkBooking({ pending: true });
      return;
    }
    if (code === "NETWORK_ERROR" || code === "TIMEOUT") {
      await checkBooking({ pending: false });
      return;
    }
    if (code === "PAYMENT_DECLINED") {
      notice({ name: "payment-declined", title: TEXT.declined, hint: TEXT.declinedHint });
      return;
    }
    if (code === "PAYMENT_ATTEMPTS_EXCEEDED") {
      block({
        name: "attempts-exceeded",
        title: TEXT.attemptsExceeded,
        hint: TEXT.attemptsExceededHint,
        links: [
          { label: TEXT.payByCard, href: paymentStep },
          { label: TEXT.searchFlights, href: "/" },
        ],
      });
      return;
    }
    if (code === "PRICE_CHANGED" || code === "PAYMENT_AMOUNT_MISMATCH") {
      // The checkout is on the new total and the payment awaits the card for it: read both again.
      const oldTotal = payment?.amount ?? null;
      try {
        [checkout, payment] = await Promise.all([
          client.checkout.get({ checkoutId: /** @type {string} */ (checkoutId) }),
          client.checkout.getPayment({ paymentId: /** @type {string} */ (paymentId) }),
        ]);
      } catch {
        // The totals on the screen stay; the next quote reads the payment again.
      }
      if (destroyed) {
        return;
      }
      renderSummary();
      const newPrice = /** @type {{ newPrice?: Money }} */ (error).newPrice ?? payment?.amount ?? null;
      const oldPrice = /** @type {{ oldPrice?: Money }} */ (error).oldPrice ?? oldTotal;
      notice(
        code === "PRICE_CHANGED"
          ? {
              name: "price-changed",
              title: TEXT.priceChanged,
              hint: newPrice
                ? format(oldPrice ? TEXT.newTotal : TEXT.newTotalOnly, {
                    new: money(newPrice),
                    old: money(oldPrice),
                  })
                : null,
            }
          : { name: "amount-changed", title: TEXT.amountChanged },
      );
      return;
    }
    if (code === "SOLD_OUT") {
      block({
        name: "sold-out",
        title: TEXT.soldOut,
        hint: TEXT.soldOutHint,
        links: [{ label: TEXT.searchFlights, href: "/" }],
      });
      return;
    }
    if (code === "SUPPLIER_ERROR" || code === "TICKETING_FAILED") {
      block({
        name: "not-booked",
        title: TEXT.notBooked,
        hint: TEXT.notBookedHint,
        links: [
          { label: TEXT.otherMethod, href: paymentStep },
          { label: TEXT.searchFlights, href: "/" },
        ],
      });
      return;
    }
    if (
      code === "CHECKOUT_INCOMPLETE" ||
      code === "TRAVELER_DATA_INVALID" ||
      code === "CONTACT_DATA_INVALID"
    ) {
      block({
        name: "incomplete",
        title: TEXT.incomplete,
        hint: TEXT.incompleteHint,
        links: [
          {
            label: TEXT.checkDetails,
            href: withQuery("/checkout.html", { id: checkoutId, step: "travellers" }),
          },
        ],
      });
      return;
    }
    if (code === "FEATURE_DISABLED") {
      block({
        name: "feature-disabled",
        title: TEXT.notOffered,
        hint: TEXT.notOfferedHint,
        links: [{ label: TEXT.otherMethod, href: paymentStep }],
      });
      return;
    }
    if (code === "CHECKOUT_EXPIRED" || code === "OFFER_EXPIRED") {
      block({ name: "checkout-expired", title: TEXT.expired, hint: TEXT.expiredHint, links: [priceAgain()] });
      return;
    }
    if (code === "SUPPLIER_NOT_CONFIGURED") {
      block({ name: "supplier-not-configured", title: TEXT.notConfigured });
      return;
    }
    if (code === "TENANT_SUSPENDED" || code === "HOST_NOT_ALLOWED" || code === "NOT_FOUND") {
      loadFailed(error);
      return;
    }
    if (code === "UNPROCESSABLE") {
      showFieldErrors([{ field: "number", message: brandMessage() }]);
      return;
    }
    const fieldErrors = error instanceof VelexisError ? error.fieldErrors : [];
    /** @type {Array<{ field: CardField, message: string }>} */
    const problems = [];
    for (const fieldError of fieldErrors) {
      const field = FIELD_BY_PATH[String(fieldError?.path)];
      if (field && !problems.some((problem) => problem.field === field)) {
        const message =
          field === "holder"
            ? TEXT.errorHolder
            : field === "number"
              ? TEXT.errorNumber
              : field === "csc"
                ? TEXT.errorCsc
                : fieldError.code === "expired"
                  ? TEXT.errorExpired
                  : TEXT.errorExpiry;
        problems.push({ field, message });
      }
    }
    if (code === "VALIDATION_FAILED" && problems.length > 0) {
      showFieldErrors(problems);
      return;
    }
    if (error instanceof VelexisError && error.status === 401) {
      notice({ name: "signed-out", title: TEXT.signedOut, links: [signInLink()] });
      return;
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      notice({ name: "email-not-verified", title: TEXT.emailNotVerified, hint: TEXT.emailNotVerifiedHint });
      return;
    }
    if (code === "RATE_LIMITED") {
      const wait = /** @type {{ retryAfterSeconds?: unknown }} */ (error).retryAfterSeconds;
      const seconds = typeof wait === "number" && wait > 0 ? wait : 5;
      notice({ name: "rate-limited", title: TEXT.rateLimited });
      el.payButton.setAttribute("aria-disabled", "true");
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => {
        if (!busy) {
          el.payButton.removeAttribute("aria-disabled");
        }
      }, seconds * 1000);
      return;
    }
    if (code === "SERVICE_UNAVAILABLE" || code === "SUPPLIER_UNAVAILABLE" || code === "CSRF_TOKEN_INVALID") {
      // Refused before the airline was asked: the card can be typed again.
      notice({ name: "not-sent", title: TEXT.notSent });
      return;
    }
    notice({ name: "unexpected", title: TEXT.unexpected, requestId: requestIdOf(error) });
  };

  // ---- the card-fee quote ------------------------------------------------------------------------------------------

  /**
   * A failed `checkout.updatePayment`. The quote is dropped (Pay needs a new one).
   * @param {unknown} error
   */
  const failQuote = (error) => {
    const code = codeOf(error);
    if (code === "ABORTED") {
      return;
    }
    dropQuote();
    const details = detailsOf(error);
    if (code === "UNPROCESSABLE") {
      showFieldErrors([{ field: "number", message: brandMessage() }]);
    } else if (code === "PRICE_CHANGED") {
      block({
        name: "price-changed",
        title: TEXT.quotePriceChanged,
        hint: TEXT.quotePriceChangedHint,
        links: [{ label: TEXT.otherMethod, href: paymentStep }],
      });
    } else if (code === "CHECKOUT_ALREADY_COMPLETED" || code === "CHECKOUT_BEING_COMPLETED") {
      const bookingId = bookingIdOf(details["bookingId"]);
      if (bookingId !== null) {
        leaving = true;
        replace(confirmationHref(bookingId, code === "CHECKOUT_BEING_COMPLETED"));
      } else {
        checkBooking({ pending: true }).catch(() => {});
      }
    } else if (code === "PAYMENT_NOT_UPDATABLE") {
      block({
        name: "payment-inactive",
        title: TEXT.inactive,
        hint: TEXT.inactiveHint,
        links: [{ label: TEXT.otherMethod, href: paymentStep }],
      });
    } else if (code === "CHECKOUT_EXPIRED" || code === "NOT_FOUND" || code === "TENANT_SUSPENDED") {
      loadFailed(error);
    } else if (error instanceof VelexisError && error.status === 401) {
      notice({ name: "signed-out", title: TEXT.signedOut, links: [signInLink()] });
    } else {
      notice({
        name: "quote-failed",
        title: TEXT.quoteFailed,
        requestId: requestIdOf(error),
        // The quote of the number in the field now.
        retry: () => {
          el.notice.replaceChildren();
          onNumberInput();
        },
      });
    }
  };

  /**
   * Quotes the airline's card fee for a BIN and its brand on the payment (`checkout.updatePayment`); the review shows
   * the new amount. Only the brand and the six digits leave the page.
   * @param {string} bin
   * @param {{ amadeus: AmadeusBrand, label: string }} brand
   */
  const requestQuote = (bin, brand) => {
    dropQuote();
    const abort = new AbortController();
    /** @type {NonNullable<typeof quote>} */
    const current = { bin, brand: brand.amadeus, label: brand.label, payment: null, running: null, abort };
    quote = current;
    live.announce(TEXT.quoting);
    current.running = (async () => {
      try {
        const updated = await client.checkout.updatePayment(
          {
            paymentId: /** @type {string} */ (paymentId),
            card: { brand: brand.amadeus, bin },
          },
          { signal: abort.signal },
        );
        if (quote !== current || destroyed) {
          return;
        }
        payment = updated;
        current.payment = updated;
        renderSummary();
        renderReview();
        live.announce(format(TEXT.quoted, { price: money(updated.amount) }));
      } catch (error) {
        if (quote === current && !destroyed) {
          failQuote(error);
        }
      } finally {
        current.running = null;
      }
    })();
    return current.running;
  };

  /** The number field: once six digits are typed, the brand and the airline's card fee for them. */
  const onNumberInput = () => {
    if (busy || blocked) {
      return;
    }
    const bin = (cardDigits(inputs.number.value) ?? "").slice(0, BIN_LENGTH);
    if (bin.length < BIN_LENGTH) {
      el.brand.textContent = "";
      if (quote) {
        dropQuote();
      }
      return;
    }
    const brand = acceptedCardBrand(bin, cardBrands());
    el.brand.textContent = brand ? format(TEXT.card, { brand: brand.label }) : brandMessage();
    if (!brand) {
      dropQuote();
    } else if (!quote || quote.bin !== bin || quote.brand !== brand.amadeus) {
      requestQuote(bin, brand).catch(() => {});
    }
  };

  // ---- pay ---------------------------------------------------------------------------------------------------------

  /**
   * The card as typed, read from the inputs at this submit only; passed to the API and never kept.
   */
  const readCard = () => {
    const number = cardDigits(inputs.number.value) ?? "";
    const month = inputs.month.value.trim();
    const year = inputs.year.value.trim();
    return {
      brand: acceptedCardBrand(number.slice(0, BIN_LENGTH), cardBrands())?.amadeus ?? "",
      holderName: inputs.holder.value.trim().replace(/\s+/g, " "),
      number,
      expiryMonth: /^\d{1,2}$/.test(month) ? Number(month) : 0,
      expiryYear: /^\d{4}$/.test(year) ? Number(year) : /^\d{2}$/.test(year) ? 2000 + Number(year) : 0,
      securityCode: inputs.csc.value.trim(),
    };
  };

  /**
   * The problems of a card that the API would refuse (it checks them too), by field; messages never repeat a value.
   * @param {ReturnType<typeof readCard>} card
   */
  const cardProblems = (card) => {
    /** @type {Array<{ field: CardField, message: string }>} */
    const problems = [];
    if (!HOLDER.test(card.holderName)) {
      problems.push({ field: "holder", message: TEXT.errorHolder });
    }
    if (!luhnValid(card.number)) {
      problems.push({ field: "number", message: TEXT.errorNumber });
    } else if (card.brand === "") {
      problems.push({ field: "number", message: brandMessage() });
    }
    if (card.expiryMonth < 1 || card.expiryMonth > 12 || card.expiryYear < 2000) {
      problems.push({ field: "expiry", message: TEXT.errorExpiry });
    } else if (cardExpired(card.expiryMonth, card.expiryYear, now())) {
      problems.push({ field: "expiry", message: TEXT.errorExpired });
    }
    if (!securityCodeValid(card.securityCode, cardNetwork(card.number))) {
      problems.push({ field: "csc", message: TEXT.errorCsc });
    }
    return problems;
  };

  /** @param {boolean} on */
  const setBusy = (on) => {
    busy = on;
    for (const field of Object.values(inputs)) {
      field.readOnly = on;
    }
    el.progress.hidden = !on;
    if (on) {
      el.payButton.setAttribute("aria-disabled", "true");
      el.payButton.textContent = el.payButton.getAttribute("data-busy-label") ?? TEXT.paying;
    } else {
      el.payButton.removeAttribute("aria-disabled");
      renderButton();
    }
  };

  /**
   * Pay: the reviewed card once, with a new idempotency key and 90 s. Every answer empties the inputs.
   * @param {ReturnType<typeof readCard>} card
   * @param {Money} expectedTotal
   */
  const pay = async (card, expectedTotal) => {
    setBusy(true);
    el.notice.replaceChildren();
    live.announce(TEXT.paying);
    /** @type {Awaited<ReturnType<PageClient["checkout"]["completeWithAirlineCard"]>>} */
    let completion;
    try {
      completion = await client.checkout.completeWithAirlineCard(
        {
          checkoutId: /** @type {string} */ (checkoutId),
          paymentId: /** @type {string} */ (paymentId),
          expectedTotal,
          card: /** @type {CardInput} */ (card),
        },
        { idempotencyKey: newKey(), timeoutMs: COMPLETION_TIMEOUT_MS },
      );
    } catch (error) {
      clearCard();
      setBusy(false);
      if (!destroyed) {
        await failCompletion(error);
      }
      return;
    }
    clearCard();
    const bookingId = bookingIdOf(completion?.booking?.id);
    if (bookingId === null) {
      setBusy(false);
      await checkBooking({ pending: true });
      return;
    }
    leaving = true;
    live.announce(TEXT.booked);
    replace(confirmationHref(bookingId));
  };

  /** @param {Event} event */
  const onSubmit = (event) => {
    event.preventDefault();
    if (busy || blocked || leaving || el.payButton.getAttribute("aria-disabled") === "true") {
      return;
    }
    clearFieldErrors();
    el.notice.replaceChildren();
    const card = readCard();
    const problems = cardProblems(card);
    if (problems.length > 0) {
      // Nothing was sent: the values stay in the inputs for the traveller to correct.
      showFieldErrors(problems);
      return;
    }
    const bin = card.number.slice(0, BIN_LENGTH);
    const current = quote && quote.bin === bin && quote.brand === card.brand ? quote : null;
    if (current?.payment && payment) {
      pay(card, payment.amount).catch(() => {});
      return;
    }
    // No total for this card yet: quote it and show the review first; Pay comes with the next submit.
    const brand = acceptedCardBrand(bin, cardBrands());
    const running = current?.running ?? (brand ? requestQuote(bin, brand) : null);
    running
      ?.then(() => {
        if (quote?.payment && !destroyed) {
          /** @type {HTMLElement | null} */ (el.review.querySelector("h2"))?.focus();
          live.announce(TEXT.reviewHint);
        }
      })
      .catch(() => {});
  };

  // ---- load --------------------------------------------------------------------------------------------------------

  /** Loads the configuration, the checkout and the payment, then shows the form or the state they call for. */
  const load = async () => {
    el.state.replaceChildren();
    el.content.hidden = true;
    el.loading.hidden = false;
    live.announce(TEXT.loading);
    const { signal } = loadAbort;
    try {
      config = await client.storefront.get(undefined, { signal, cache: "no-store" });
    } catch (error) {
      if (!destroyed && codeOf(error) !== "ABORTED") {
        loadFailed(error);
      }
      return;
    }
    if (destroyed) {
      return;
    }
    const brandName = doc.querySelector('body > header [data-field="brandName"]');
    if (brandName && typeof config.name === "string" && config.name !== "") {
      brandName.textContent = config.name;
    }
    mountTestBanner(doc.body, { environment: config.environment });
    try {
      applyTheme(config.branding, { doc });
    } catch {
      // The neutral palette of the stylesheet stays.
    }
    if (!airlineCardOffered(config.payment)) {
      block({
        name: "feature-disabled",
        title: TEXT.notOffered,
        hint: TEXT.notOfferedHint,
        links: [{ label: TEXT.otherMethod, href: paymentStep }],
      });
      return;
    }
    try {
      [checkout, payment] = await Promise.all([
        client.checkout.get({ checkoutId: /** @type {string} */ (checkoutId) }, { signal }),
        client.checkout.getPayment({ paymentId: /** @type {string} */ (paymentId) }, { signal }),
      ]);
    } catch (error) {
      if (!destroyed && codeOf(error) !== "ABORTED") {
        loadFailed(error);
      }
      return;
    }
    if (destroyed) {
      return;
    }
    const bookingId = bookingIdOf(checkout.bookingId) ?? bookingIdOf(payment.bookingId);
    if (payment.checkoutId !== checkoutId) {
      block({
        name: "not-found",
        title: TEXT.missing,
        links: [{ label: TEXT.otherMethod, href: paymentStep }],
      });
      return;
    }
    if (checkout.status === "completed" && bookingId !== null) {
      leaving = true;
      replace(confirmationHref(bookingId));
      return;
    }
    if (checkout.status === "expired" || checkout.status === "abandoned") {
      block({ name: "checkout-expired", title: TEXT.expired, hint: TEXT.expiredHint, links: [priceAgain()] });
      return;
    }
    if (payment.method !== "airline_card") {
      leaving = true;
      replace(withQuery("/checkout/pay-card.html", { id: checkoutId, payment: payment.id }));
      return;
    }
    if (payment.status === "processing" || payment.status === "authorized" || payment.status === "captured") {
      // A completion took the card already: its booking, never a second card.
      if (bookingId !== null) {
        leaving = true;
        replace(confirmationHref(bookingId, payment.status !== "captured"));
      } else {
        block({ name: "confirming", title: TEXT.confirming, hint: TEXT.confirmingHint, retry: reload });
      }
      return;
    }
    if (!OPEN_STATUSES.has(payment.status)) {
      block({
        name: "payment-inactive",
        title: TEXT.inactive,
        hint: TEXT.inactiveHint,
        links: [{ label: TEXT.otherMethod, href: paymentStep }],
      });
      return;
    }
    const airlineNotice = config.payment?.airlineCard?.notice;
    if (typeof airlineNotice === "string" && airlineNotice.trim() !== "") {
      el.airlineNotice.textContent = airlineNotice;
    }
    const labels = cardBrands()
      .map((brand) => brand?.label)
      .filter((label) => typeof label === "string" && label !== "");
    el.acceptedList.textContent = labels.join(", ");
    el.accepted.hidden = labels.length === 0;
    el.back.href = paymentStep;
    el.back.hidden = false;
    doc.title = TEXT.title;
    // Whatever a browser restored into the hidden inputs (a reload's form restoration) goes before they are shown.
    clearCard();
    renderSummary();
    el.loading.hidden = true;
    el.content.hidden = false;
    live.announce(TEXT.ready);
  };

  // ---- events ------------------------------------------------------------------------------------------------------

  /** @param {string} type @param {EventListener} listener @param {EventTarget} [target] */
  const listen = (type, listener, target = el.form) => {
    target.addEventListener(type, listener);
    cleanups.push(() => target.removeEventListener(type, listener));
  };
  listen("submit", onSubmit);
  listen("input", (event) => {
    if (event.target === inputs.number) {
      onNumberInput();
    }
  });
  // Back, a reload and the back-forward cache never show the card again.
  listen("pagehide", clearCard, view);
  listen(
    "pageshow",
    (event) => {
      if (/** @type {PageTransitionEvent} */ (event).persisted) {
        clearCard();
      }
    },
    view,
  );

  /** @type {Promise<void>} */
  let done = Promise.resolve();
  if (checkoutId === null || paymentId === null) {
    block({
      name: "not-found",
      title: TEXT.missing,
      links: [{ label: TEXT.otherMethod, href: paymentStep }],
    });
  } else {
    done = load().catch(() => {});
  }

  return {
    done,
    destroy() {
      destroyed = true;
      loadAbort.abort();
      clearCard();
      clearTimeout(waitTimer);
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      live.clear();
    },
  };
}

document.documentElement.dataset.js = "on";
start({ client: storefrontClient });
