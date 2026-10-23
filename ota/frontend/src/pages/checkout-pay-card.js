// Entry module of the card payment page (checkout/pay-card.html, ota/frontend/docs/pages.md §8, flow
// ota/docs/flows/checkout-stripe.md §2 steps 4–5, OADR-0015 point 9). The checkout page opens it with
// `/checkout/pay-card.html?id=chk_…&payment=pay_…` after `checkout.createPayment({ method: "card" })`. It is the only
// page of the storefront with Stripe.js: a static `<script src="https://js.stripe.com/v3/">` tag in its HTML, never
// bundled. The traveller types the card into Stripe's Payment Element, which lives in Stripe's iframes: this page has
// no form control of its own and never reads card data (README §10).
//
// 1. `checkout.getPayment({ paymentId })` and `checkout.get({ checkoutId })`: the payment's `clientSecret` and
//    `providerPublicKey`, and the checkout's trip and totals. The Stripe account (`accountId`, Connect mode), the
//    merchant name, the statement descriptor and the accepted brands come from `config.payment` (storefront.get).
// 2. `Stripe(providerPublicKey, { stripeAccount: accountId })` (the option only in Connect mode), `elements({
//    clientSecret, appearance })` with the OTA's colours (the palette lib/theme.js applies), and the Payment Element.
// 3. "Review total": `elements.submit()` (Stripe checks the form), `stripe.createConfirmationToken({ elements })`, then
//    `checkout.updatePayment({ paymentId, card: { brand } })` with the Amadeus brand of
//    `payment_method_preview.card.brand` (`config.payment.pspCardBrands`), then `elements.fetchUpdates()`. The review
//    shows the final total, the card fee, the merchant name and the statement descriptor; a change in the card form
//    drops it.
// 4. "Pay": `stripe.confirmPayment({ clientSecret, confirmParams: { confirmation_token, return_url }, redirect:
//    "if_required" })` with the return URL `/checkout/complete.html?id=…&payment=…`; without a redirect the page opens
//    that URL itself. 3-D Secure runs in Stripe's own frame.
//
// States (pages.md §8): a declined card or a failed 3-D Secure shows Stripe's message under the element, and the
// traveller reviews again (the payment stays `requires_payment_method`); `409 PAYMENT_NOT_UPDATABLE` and a payment
// that failed or was cancelled create a new payment (`checkout.createPayment`) and mount the element again; `409
// PRICE_CHANGED` on `updatePayment` shows the new total next to the old one and starts a new payment, so Pay needs a
// new review; `502 PAYMENT_PROVIDER_ERROR` offers Retry; and when Stripe.js did not load (or its element cannot), "Card
// payment is unavailable", with the airline card offered when the OTA has it. A payment already being processed or
// authorised goes to the complete page, a completed checkout to its confirmation, an expired one says so.

import { boot, renderState } from "../boot.js";
import { airlineLabel, renderItinerary } from "../components/itinerary.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatMoney, formatTimestamp } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { signInHref } from "../lib/session.js";
import { resolvePalette } from "../lib/theme.js";
import { withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Checkout"]} Checkout */
/** @typedef {import("@velexis/ota-sdk").Schemas["Payment"]} Payment */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontBranding"]} StorefrontBranding */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontCardBrand"]} StorefrontCardBrand */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontPaymentConfig"]} PaymentConfig */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {Pick<VelexisClient, "checkout">} PageClient */

/**
 * The parts of Stripe.js this page uses (https://docs.stripe.com/js). Stripe.js is a global of the static script tag;
 * tests pass a fake.
 * @typedef {{ message?: string, type?: string, code?: string, payment_intent?: { status?: string } }} StripeError
 * @typedef {{ id: string, payment_method_preview?: { type?: string, card?: { brand?: string } | null } }} ConfirmationToken
 * @typedef {object} StripePaymentElement
 * @property {(target: HTMLElement) => void} mount
 * @property {(event: "ready" | "change" | "loaderror", handler: (event: unknown) => void) => void} on
 * @property {() => void} destroy
 * @typedef {object} StripeElements
 * @property {(type: "payment", options?: Record<string, unknown>) => StripePaymentElement} create
 * @property {() => Promise<{ error?: StripeError }>} submit
 * @property {() => Promise<{ error?: StripeError }>} fetchUpdates
 * @typedef {object} StripeInstance
 * @property {(options: { clientSecret: string, appearance: StripeAppearance, locale?: string }) => StripeElements} elements
 * @property {(options: { elements: StripeElements }) => Promise<{ error?: StripeError, confirmationToken?: ConfirmationToken }>} createConfirmationToken
 * @property {(options: { clientSecret: string, confirmParams: { confirmation_token: string, return_url: string }, redirect: "if_required" }) => Promise<{ error?: StripeError, paymentIntent?: { status?: string } }>} confirmPayment
 * @typedef {(publishableKey: string, options?: { stripeAccount: string }) => StripeInstance} StripeConstructor
 * @typedef {{ theme: "stripe", variables: Record<string, string> }} StripeAppearance
 */

/** Ids as the API writes them. */
export const CHECKOUT_ID = /^chk_[0-9A-Za-z]{16,40}$/;
export const PAYMENT_ID = /^pay_[0-9A-Za-z]{16,40}$/;
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
const PRICED_OFFER_ID = /^prc_[0-9A-Za-z]{16,40}$/;
/** The address of Stripe.js in pay-card.html (Stripe's only supported source). */
export const STRIPE_JS_URL = "https://js.stripe.com/v3/";
/** The language of Stripe's element: the storefront's UI is English (README §7). */
const STRIPE_LOCALE = "en";
/** `branding.cornerRadius` → the Appearance API's `borderRadius` (px: Stripe's iframe has its own root font size). */
export const STRIPE_RADIUS = Object.freeze({ none: "0px", small: "4px", medium: "8px", large: "16px" });
/** Payment statuses for which the card form is shown. */
const OPEN_STATUSES = new Set(["requires_payment_method", "requires_action"]);
/** Payment statuses after which this payment can never be used: a new one is created. */
const DEAD_STATUSES = new Set(["failed", "cancelled"]);
/** Stripe statuses of a PaymentIntent that the traveller already confirmed. */
const CONFIRMED_INTENT = new Set(["requires_capture", "succeeded", "processing"]);
/** States after which the same call cannot do better: no Retry. */
const FINAL_STATES = new Set([
  "suspended",
  "unknown-host",
  "supplier-not-configured",
  "feature-disabled",
  "forbidden",
  "signed-out",
  "not-found",
  "validation",
]);

/**
 * Reports an error of the page (the browser's console and `error` event) without breaking it.
 * @param {unknown} error
 */
function report(error) {
  try {
    globalThis.reportError?.(error);
  } catch {
    // Nothing else to do.
  }
}

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * This page for a checkout and a payment.
 * @param {string} checkoutId
 * @param {string} paymentId
 */
export const payCardHref = (checkoutId, paymentId) =>
  withQuery("/checkout/pay-card.html", { id: checkoutId, payment: paymentId });

/**
 * The complete page (also Stripe's `return_url`) of a checkout and a payment.
 * @param {string} checkoutId
 * @param {string} paymentId
 */
export const completeHref = (checkoutId, paymentId) =>
  withQuery("/checkout/complete.html", { id: checkoutId, payment: paymentId });

/**
 * The payment step of the checkout page, where the method is chosen.
 * @param {string} checkoutId
 */
export const paymentStepHref = (checkoutId) =>
  withQuery("/checkout.html", { id: checkoutId, step: "payment" });

/**
 * The confirmation page of a booking (`pending=1` while the airline order is being confirmed).
 * @param {string} bookingId
 * @param {boolean} [pending]
 */
const confirmationHref = (bookingId, pending = false) =>
  withQuery("/confirmation.html", { booking: bookingId, pending: pending ? 1 : null });

/**
 * The Appearance API options of the Payment Element: the OTA's colours as the page applies them (lib/theme.js: the
 * neutral palette when a colour is invalid or a pair fails its contrast) and its corner radius.
 * @param {Partial<StorefrontBranding> | null | undefined} branding `config.branding`
 * @returns {StripeAppearance}
 */
export function stripeAppearance(branding) {
  const { palette } = resolvePalette(branding?.colors);
  const radius = branding?.cornerRadius;
  return {
    theme: "stripe",
    variables: {
      colorPrimary: palette.primary,
      colorBackground: palette.background,
      colorText: palette.text,
      colorTextSecondary: palette.mutedText,
      colorDanger: palette.error,
      colorSuccess: palette.success,
      colorWarning: palette.warning,
      borderRadius:
        typeof radius === "string" && Object.hasOwn(STRIPE_RADIUS, radius)
          ? STRIPE_RADIUS[/** @type {keyof typeof STRIPE_RADIUS} */ (radius)]
          : STRIPE_RADIUS.medium,
    },
  };
}

/**
 * The accepted brand of a card the Payment Element reported (`payment_method_preview.card.brand`, Stripe's name, for
 * example `visa`), from `config.payment.pspCardBrands`; `null` for a brand the OTA does not accept.
 * @param {ReadonlyArray<Partial<StorefrontCardBrand>> | null | undefined} brands `config.payment.pspCardBrands`
 * @param {unknown} stripeBrand
 * @returns {{ amadeus: StorefrontCardBrand["amadeus"], label: string } | null}
 */
export function acceptedBrand(brands, stripeBrand) {
  if (typeof stripeBrand !== "string" || stripeBrand === "") {
    return null;
  }
  const brand = list(brands).find(
    (entry) => typeof entry?.psp === "string" && entry.psp.toLowerCase() === stripeBrand.toLowerCase(),
  );
  return brand && typeof brand.amadeus === "string"
    ? { amadeus: brand.amadeus, label: typeof brand.label === "string" ? brand.label : brand.amadeus }
    : null;
}

/**
 * Whether the OTA offers the airline card on this storefront (`supportedMethods` and `airlineCard` not switched off),
 * the way out when card payment is unavailable.
 * @param {Partial<PaymentConfig> | null | undefined} payment `config.payment`
 */
export const airlineCardOffered = (payment) =>
  list(payment?.supportedMethods).includes("airline_card") && payment?.airlineCard?.enabled !== false;

/**
 * Runs the card payment page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the
 * page has no payment area, else `{ done, destroy }`: `done` settles once the card form (or a state) is shown.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, history?: History, navigate?: (url: string) => void, replace?: (url: string) => void, reload?: () => void, Stripe?: StripeConstructor | undefined }} [env]
 *   for tests; `Stripe` replaces the global of Stripe.js
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-pay-card-page]"));
  if (!main) {
    return null;
  }
  const view = /** @type {Window & { Stripe?: StripeConstructor }} */ (doc.defaultView ?? globalThis);
  const location = env.location ?? view.location;
  const history = env.history ?? view.history;
  const navigate = env.navigate ?? ((/** @type {string} */ url) => location.assign(url));
  const replace = env.replace ?? ((/** @type {string} */ url) => location.replace(url));
  const reload = env.reload ?? (() => location.reload());
  const StripeJs = "Stripe" in env ? env.Stripe : view.Stripe;
  const { config, client } = context;
  const locale = config?.defaultLocale;
  const support = config?.support ?? null;
  const paymentConfig = config?.payment;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const el = {
    back: /** @type {HTMLAnchorElement} */ (main.querySelector("a[data-back-link]")),
    state: find("[data-pay-state]"),
    loading: find("[data-pay-loading]"),
    content: find("[data-pay-content]"),
    notice: find("[data-pay-notice]"),
    priceChange: find("[data-price-change]"),
    priceChangeText: find("[data-price-change-text]"),
    element: find("[data-payment-element]"),
    stripeMessage: find("[data-stripe-message]"),
    reviewButton: /** @type {HTMLButtonElement} */ (main.querySelector("button[data-review-button]")),
    reviewPanel: find("[data-review-panel]"),
    reviewCard: find("[data-review-card]"),
    reviewCardFee: find("[data-review-card-fee]"),
    reviewTotal: find("[data-review-total]"),
    reviewMerchant: find("[data-review-merchant]"),
    reviewDescriptorRow: find("[data-review-descriptor-row]"),
    reviewDescriptor: find("[data-review-descriptor]"),
    payButton: /** @type {HTMLButtonElement} */ (main.querySelector("button[data-pay-button]")),
    itineraries: find("[data-pay-itineraries]"),
    totalOffer: find("[data-total-offer]"),
    totalExtrasRow: find("[data-total-extras-row]"),
    totalExtras: find("[data-total-extras]"),
    totalCardFeeRow: find("[data-total-card-fee-row]"),
    totalCardFee: find("[data-total-card-fee]"),
    total: find("[data-total]"),
    expiry: find("[data-pay-expiry]"),
  };
  const idleLabels = new Map(
    [el.reviewButton, el.payButton].map((button) => [button, button.textContent?.trim() ?? ""]),
  );

  // The payment's currency is fixed: the header's currency selector would change nothing here, and this page keeps no
  // form control of its own outside Stripe's frame.
  doc.querySelector('body > header [data-slot="currency"]')?.remove();

  const params = new URLSearchParams(location.search);
  const idParam = params.get("id");
  const paymentParam = params.get("payment");
  const checkoutId = idParam !== null && CHECKOUT_ID.test(idParam) ? idParam : null;
  let paymentId = paymentParam !== null && PAYMENT_ID.test(paymentParam) ? paymentParam : null;
  /** @type {Checkout | null} */
  let checkout = null;
  /** The payment on the screen (after `updatePayment`, its new amount and card fee). @type {Payment | null} */
  let payment = null;
  /** The client secret the element was mounted with. */
  let clientSecret = "";
  /** @type {{ key: string, account: string | null, stripe: StripeInstance } | null} */
  let stripeSession = null;
  /** @type {StripeElements | null} */
  let elements = null;
  /** @type {StripePaymentElement | null} */
  let paymentElement = null;
  /** The reviewed card: the confirmation token Pay confirms with. @type {{ token: string, label: string } | null} */
  let review = null;
  /** Whether a review or a payment is running (a second click is ignored). */
  let busy = false;
  /** Whether Stripe confirmed the payment and the complete page is opening. */
  let leaving = false;
  /** Running calls, aborted by destroy. @type {Set<AbortController>} */
  const controllers = new Set();
  /** @type {Array<() => void>} */
  const cleanups = [];
  let destroyed = false;

  /** A new AbortController for a call, forgotten once the call settled. */
  const track = () => {
    const controller = new AbortController();
    controllers.add(controller);
    return { signal: controller.signal, done: () => controllers.delete(controller) };
  };

  /** @param {unknown} error */
  const requestIdOf = (error) =>
    error instanceof Error && "requestId" in error
      ? String(/** @type {{ requestId: unknown }} */ (error).requestId ?? "") || null
      : null;

  /** The price page of the checkout's flight, to price it again; `null` before the checkout is known. */
  const priceHref = () =>
    checkout && PRICED_OFFER_ID.test(checkout.basePricedOfferId)
      ? withQuery("/price.html", { priced: checkout.basePricedOfferId })
      : null;

  /**
   * A link under a state.
   * @param {HTMLElement} element
   * @param {string} label
   * @param {string} href
   */
  const addLink = (element, label, href) => {
    const link = fill(clone("tpl-state-link", doc), { label, href });
    const retry = element.querySelector('[data-action="retry"]')?.closest("p");
    if (retry) {
      retry.before(link);
    } else {
      element.append(link);
    }
  };

  /** Removes the Payment Element (a new payment, or a state that replaces the page). */
  const unmountElement = () => {
    try {
      paymentElement?.destroy();
    } catch (error) {
      report(error);
    }
    paymentElement = null;
    elements = null;
    el.element.replaceChildren();
  };

  /**
   * Replaces the payment with a state (it cannot be used, or never loaded).
   * @param {Pick<PageState, "name" | "message" | "scope"> & Partial<PageState>} state
   * @param {{ link?: { label: string, href: string } | null, onRetry?: () => void, requestId?: string | null, focus?: boolean }} [options]
   */
  const showPageState = (state, { link = null, onRetry, requestId = null, focus = true } = {}) => {
    unmountElement();
    review = null;
    el.loading.hidden = true;
    el.content.hidden = true;
    doc.title = state.message;
    const element = renderState(el.state, state, {
      support,
      requestId,
      focus,
      ...(onRetry ? { onRetry } : {}),
    });
    if (link) {
      addLink(element, link.label, link.href);
    }
    live.announce(state.message);
  };

  /** "Card payment is unavailable" (Stripe.js or its element did not load), with the airline card when offered. */
  const showUnavailable = () => {
    showPageState(
      {
        // Not an API state (lib/errors.js has no such name): this page's own name gives it its own hint
        // (`stateHint.card-unavailable`) and `data-state`, as price.js does for "price-expired".
        name: /** @type {PageState["name"]} */ (/** @type {unknown} */ ("card-unavailable")),
        scope: "inline",
        message: t("payCard.unavailable"),
      },
      {
        onRetry: reload,
        link:
          checkoutId !== null && airlineCardOffered(paymentConfig)
            ? { label: t("payCard.airlineCard"), href: paymentStepHref(checkoutId) }
            : null,
      },
    );
  };

  /** "Your session expired", with a link to price the flight again. */
  const showExpired = () => {
    const href = priceHref();
    showPageState(
      { name: "checkout-expired", scope: "inline", message: t("state.checkout-expired") },
      {
        link: {
          label: href === null ? t("offerPage.searchFlights") : t("pricePage.priceAgain"),
          href: href ?? "/",
        },
      },
    );
  };

  /** "We could not find this payment", with the payment step when the checkout is known. */
  const showMissing = (/** @type {boolean} */ focus = true) => {
    showPageState(
      { name: "not-found", scope: "inline", message: t("payCard.missing") },
      {
        focus,
        link:
          checkoutId === null
            ? { label: t("offerPage.searchFlights"), href: "/" }
            : { label: t("payCard.backToPayment"), href: paymentStepHref(checkoutId) },
      },
    );
  };

  /**
   * The end of a checkout an answer reported: expired, or completed (being completed) with its booking. Returns whether
   * the page left the payment.
   * @param {PageState} state
   */
  const checkoutEnded = (state) => {
    const bookingId = state.details?.["bookingId"];
    if (state.code === "CHECKOUT_EXPIRED" || state.name === "checkout-expired") {
      showExpired();
      return true;
    }
    if (
      (state.code === "CHECKOUT_ALREADY_COMPLETED" || state.code === "CHECKOUT_BEING_COMPLETED") &&
      typeof bookingId === "string" &&
      BOOKING_ID.test(bookingId)
    ) {
      replace(confirmationHref(bookingId, state.code === "CHECKOUT_BEING_COMPLETED"));
      return true;
    }
    if (state.code === "CHECKOUT_ALREADY_COMPLETED" || state.code === "CHECKOUT_BEING_COMPLETED") {
      // Without the booking in the answer, the checkout and its payment say where to go: loading them again opens
      // the confirmation or the complete page.
      load({ focus: true }).catch(report);
      return true;
    }
    return false;
  };

  /**
   * A message under the card form (Stripe's own message when it has one).
   * @param {string} message
   */
  const showCardMessage = (message) => {
    el.stripeMessage.textContent = message;
    el.stripeMessage.hidden = false;
    live.announce(message);
  };

  const clearMessages = () => {
    el.stripeMessage.textContent = "";
    el.stripeMessage.hidden = true;
    el.notice.replaceChildren();
  };

  /** Hides the review: Pay needs a new one (another card, a new payment, a failed confirmation). */
  const dropReview = () => {
    review = null;
    el.reviewPanel.hidden = true;
  };

  /**
   * Runs one action of a button with its busy label (`aria-disabled`, so the button keeps the focus); a click while
   * any action runs is ignored.
   * @param {HTMLButtonElement} button
   * @param {() => Promise<void>} task
   */
  const withBusy = async (button, task) => {
    if (busy) {
      return;
    }
    busy = true;
    button.setAttribute("aria-disabled", "true");
    button.textContent = button.getAttribute("data-busy-label") ?? t("app.submitting");
    try {
      await task();
    } finally {
      // A confirmed payment keeps the button busy while the complete page opens: it is never confirmed twice.
      if (!leaving) {
        busy = false;
        button.removeAttribute("aria-disabled");
        button.textContent = idleLabels.get(button) ?? "";
        if (button === el.payButton && review && payment) {
          button.textContent = t("payCard.pay", { price: formatMoney(payment.amount, locale) });
        }
      }
    }
  };

  /** The trip, the totals (the payment's own amount and card fee once known) and the hold time of the summary. */
  const renderSummary = () => {
    if (!checkout) {
      return;
    }
    const tripType = checkout.summary?.tripType ?? "one_way";
    /** @type {Map<string, string>} */
    const airlines = new Map();
    for (const segment of list(checkout.itineraries).flatMap((itinerary) => list(itinerary.segments))) {
      if (typeof segment?.carrierName === "string" && segment.carrierName !== "") {
        airlines.set(segment.carrierCode, segment.carrierName);
      }
    }
    el.itineraries.replaceChildren(
      ...list(checkout.itineraries).map((itinerary) =>
        renderItinerary(itinerary, {
          doc,
          locale,
          tripType,
          airline: (code) => airlineLabel(code, airlines.get(code)),
          place: (code) => code,
        }),
      ),
    );
    const totals = checkout.totals;
    // The payment on the screen decides both the card fee and the total: its `cardFee` is null for a card without a
    // fee, which must not fall back to a fee the checkout kept from an earlier card.
    const cardFee = payment ? (payment.cardFee ?? null) : (totals.cardFee ?? null);
    el.totalOffer.textContent = formatMoney(totals.offer, locale);
    const extras = list(checkout.ancillaries).length > 0;
    el.totalExtrasRow.hidden = !extras;
    el.totalExtras.textContent = extras ? formatMoney(totals.ancillaries, locale) : "";
    el.totalCardFeeRow.hidden = !cardFee;
    el.totalCardFee.textContent = cardFee ? formatMoney(cardFee, locale) : "";
    el.total.textContent = formatMoney(payment?.amount ?? totals.total, locale);
    el.expiry.textContent = t("checkout.heldUntil", {
      time: formatTimestamp(checkout.expiresAt, locale, config?.timeZone),
    });
  };

  /** The review panel: the final total with the card fee, the merchant and the statement descriptor. */
  const renderReview = () => {
    if (!payment || !review) {
      return;
    }
    el.reviewCard.textContent = review.label;
    el.reviewCardFee.textContent = payment.cardFee
      ? formatMoney(payment.cardFee, locale)
      : t("payCard.noCardFee");
    el.reviewTotal.textContent = formatMoney(payment.amount, locale);
    el.reviewMerchant.textContent =
      typeof paymentConfig?.merchantName === "string" && paymentConfig.merchantName !== ""
        ? paymentConfig.merchantName
        : (config?.name ?? "");
    const descriptor =
      typeof paymentConfig?.statementDescriptor === "string" ? paymentConfig.statementDescriptor.trim() : "";
    el.reviewDescriptor.textContent = descriptor;
    el.reviewDescriptorRow.hidden = descriptor === "";
    el.payButton.textContent = t("payCard.pay", { price: formatMoney(payment.amount, locale) });
    el.reviewPanel.hidden = false;
  };

  /**
   * Mounts Stripe's Payment Element for the payment on the screen. Returns false (with "Card payment is unavailable"
   * shown) when Stripe.js refuses.
   * @param {Payment} current
   */
  const mountElement = (current) => {
    unmountElement();
    dropReview();
    el.reviewButton.hidden = true;
    clientSecret = /** @type {string} */ (current.clientSecret);
    const key =
      typeof current.providerPublicKey === "string" && current.providerPublicKey !== ""
        ? current.providerPublicKey
        : (paymentConfig?.publishableKey ?? "");
    const account =
      typeof paymentConfig?.accountId === "string" && paymentConfig.accountId !== ""
        ? paymentConfig.accountId
        : null;
    try {
      if (!stripeSession || stripeSession.key !== key || stripeSession.account !== account) {
        const stripe = account
          ? /** @type {StripeConstructor} */ (StripeJs)(key, { stripeAccount: account })
          : /** @type {StripeConstructor} */ (StripeJs)(key);
        stripeSession = { key, account, stripe };
      }
      const mounted = stripeSession.stripe.elements({
        clientSecret,
        appearance: stripeAppearance(config?.branding),
        locale: STRIPE_LOCALE,
      });
      const element = mounted.create("payment", { layout: "tabs" });
      elements = mounted;
      paymentElement = element;
      element.on("ready", () => {
        if (paymentElement === element && !destroyed) {
          el.reviewButton.hidden = false;
          live.announce(t("payCard.ready"));
        }
      });
      // Any change of the card (another number, brand or method) makes the reviewed total out of date.
      element.on("change", () => {
        if (paymentElement === element && review && !busy) {
          dropReview();
        }
      });
      element.on("loaderror", () => {
        if (paymentElement === element && !destroyed) {
          showUnavailable();
        }
      });
      element.mount(el.element);
      return true;
    } catch (error) {
      report(error);
      showUnavailable();
      return false;
    }
  };

  /**
   * Starts the payment again with a new one (`checkout.createPayment`, the terms were accepted on the payment step):
   * after `409 PAYMENT_NOT_UPDATABLE`, a payment that failed or was cancelled, or a price change. The address takes
   * the new `payment=`.
   * @param {{ change?: { oldPrice: Money | null, newPrice: Money } | null, notice?: string | null }} [options]
   */
  const renew = async ({ change = null, notice = null } = {}) => {
    if (checkoutId === null) {
      return;
    }
    dropReview();
    unmountElement();
    el.reviewButton.hidden = true;
    live.announce(t("payCard.restarting"));
    const returnUrl = new URL(withQuery("/checkout/complete.html", { id: checkoutId }), location.origin).href;
    /** @type {Payment} */
    let next;
    try {
      next = await client.checkout.createPayment({
        checkoutId,
        method: "card",
        termsAccepted: true,
        returnUrl,
      });
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (checkoutEnded(state)) {
        return;
      }
      const retry = !FINAL_STATES.has(state.name) && (state.retry || state.code === "PAYMENT_PROVIDER_ERROR");
      showPageState(
        { ...state, scope: "inline", message: t("payCard.restartFailed") },
        {
          link: { label: t("payCard.backToPayment"), href: paymentStepHref(checkoutId) },
          requestId: requestIdOf(error),
          ...(retry ? { onRetry: () => renew({ change, notice }).catch(report) } : {}),
        },
      );
      return;
    }
    if (destroyed) {
      return;
    }
    if (typeof next?.id !== "string" || !PAYMENT_ID.test(next.id) || typeof next.clientSecret !== "string") {
      showPageState({ name: "unexpected", scope: "inline", message: t("state.unexpected") });
      return;
    }
    payment = next;
    paymentId = next.id;
    history.replaceState(null, "", payCardHref(checkoutId, next.id));
    // The checkout's new totals (a price change); without them the summary shows the new payment's amount.
    try {
      checkout = await client.checkout.get({ checkoutId });
    } catch {
      // The payment's amount is the total to pay.
    }
    if (destroyed) {
      return;
    }
    // After a Retry of a failed restart, the card form takes the place of that state again.
    el.state.replaceChildren();
    el.loading.hidden = true;
    el.content.hidden = false;
    doc.title = t("payCard.title");
    renderSummary();
    if (change) {
      el.priceChangeText.textContent = change.oldPrice
        ? t("payCard.newTotal", {
            new: formatMoney(change.newPrice, locale),
            old: formatMoney(change.oldPrice, locale),
          })
        : t("payCard.newTotalOnly", { new: formatMoney(change.newPrice, locale) });
      el.priceChange.hidden = false;
    }
    if (!mountElement(next)) {
      return;
    }
    if (change) {
      /** @type {HTMLElement | null} */ (el.priceChange.querySelector("h2"))?.focus();
      live.announce(el.priceChangeText.textContent ?? "");
    } else if (notice) {
      renderState(el.notice, { name: "stale", scope: "inline", message: notice }, { focus: true });
      live.announce(notice);
    }
  };

  /**
   * A failed `checkout.updatePayment` (pages.md §8).
   * @param {unknown} error
   */
  const failUpdate = async (error) => {
    if (destroyed || isAborted(error)) {
      return;
    }
    const state = pageStateFor(error);
    if (checkoutEnded(state)) {
      return;
    }
    if (state.code === "PAYMENT_NOT_UPDATABLE") {
      await renew({ notice: t("payCard.restarted") });
      return;
    }
    if (state.code === "PRICE_CHANGED") {
      // The checkout is on the new price and this payment was cancelled: a new one, then a new review.
      const details = state.details ?? {};
      const newPrice = /** @type {Money | undefined} */ (
        /** @type {{ newPrice?: Money }} */ (error).newPrice ?? details["newPrice"]
      );
      const oldPrice = /** @type {Money | undefined} */ (
        /** @type {{ oldPrice?: Money }} */ (error).oldPrice ?? details["oldPrice"]
      );
      await renew(
        newPrice && typeof newPrice.amount === "string"
          ? {
              change: {
                newPrice,
                oldPrice: oldPrice && typeof oldPrice.amount === "string" ? oldPrice : null,
              },
            }
          : { notice: t("payCard.restarted") },
      );
      return;
    }
    if (state.code === "UNPROCESSABLE") {
      showCardMessage(brandMessage());
      return;
    }
    if (state.name === "signed-out") {
      const element = renderState(el.notice, state, { support, focus: true });
      element.append(
        fill(clone("tpl-state-link", doc), { label: t("account.signIn"), href: signInHref(location) }),
      );
      live.announce(state.message);
      return;
    }
    // A request the API refuses as invalid (`400`) has no field on this page to mark: the unexpected state, as at load.
    const message =
      state.code === "PAYMENT_PROVIDER_ERROR"
        ? t("payCard.providerError")
        : state.name === "validation"
          ? t("state.unexpected")
          : state.message;
    renderState(
      el.notice,
      { ...state, scope: "inline", message },
      {
        support,
        focus: true,
        requestId: state.name === "unexpected" || state.name === "validation" ? requestIdOf(error) : null,
        ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => el.reviewButton.click() }),
      },
    );
    live.announce(message);
  };

  /** "We cannot take this card", with the accepted brands. */
  const brandMessage = () => {
    const labels = list(paymentConfig?.pspCardBrands)
      .map((brand) => (typeof brand?.label === "string" ? brand.label : null))
      .filter((label) => label !== null);
    return labels.length > 0
      ? t("payCard.brandNotAccepted", { brands: labels.join(", ") })
      : t("payCard.brandNotAcceptedNone");
  };

  /**
   * Review total: Stripe checks the form and makes a confirmation token, the card fee of its brand is quoted on the
   * same payment, and the element reads the new amount; then the final total is shown.
   */
  const submitReview = () =>
    withBusy(el.reviewButton, async () => {
      if (!elements || !stripeSession || !payment || paymentId === null) {
        return;
      }
      const stripe = stripeSession.stripe;
      const form = elements;
      clearMessages();
      dropReview();
      el.priceChange.hidden = true;
      live.announce(t("payCard.reviewing"));
      const submitted = await form.submit().catch(() => ({ error: /** @type {StripeError} */ ({}) }));
      if (destroyed || form !== elements) {
        return;
      }
      if (submitted.error) {
        // Stripe shows what to correct inside its element and moves the focus there.
        live.announce(t("payCard.checkCard"));
        return;
      }
      const created = await stripe
        .createConfirmationToken({ elements: form })
        .catch(() => ({ error: /** @type {StripeError} */ ({}), confirmationToken: undefined }));
      if (destroyed || form !== elements) {
        return;
      }
      if (created.error || !created.confirmationToken || typeof created.confirmationToken.id !== "string") {
        showCardMessage(stripeMessageOf(created.error));
        return;
      }
      const token = created.confirmationToken;
      const brand = acceptedBrand(paymentConfig?.pspCardBrands, token.payment_method_preview?.card?.brand);
      if (!brand) {
        showCardMessage(brandMessage());
        return;
      }
      const call = track();
      /** @type {Payment} */
      let updated;
      try {
        updated = await client.checkout.updatePayment(
          { paymentId, card: { brand: brand.amadeus } },
          { signal: call.signal },
        );
      } catch (error) {
        call.done();
        await failUpdate(error);
        return;
      }
      call.done();
      if (destroyed || form !== elements) {
        return;
      }
      payment = updated;
      renderSummary();
      // The element shows (and wallets charge) the PaymentIntent's new amount.
      const fetched = await form.fetchUpdates().catch(() => ({ error: /** @type {StripeError} */ ({}) }));
      if (destroyed || form !== elements) {
        return;
      }
      if (fetched.error) {
        renderState(
          el.notice,
          { name: "unavailable", scope: "inline", message: t("payCard.updateFailed") },
          { support, focus: true, onRetry: () => el.reviewButton.click() },
        );
        live.announce(t("payCard.updateFailed"));
        return;
      }
      review = { token: token.id, label: brand.label };
      renderReview();
      /** @type {HTMLElement | null} */ (el.reviewPanel.querySelector("h2"))?.focus();
      live.announce(t("payCard.reviewed", { price: formatMoney(updated.amount, locale) }));
    });

  /**
   * Stripe's message of an error, else the page's own.
   * @param {StripeError | undefined} error
   */
  const stripeMessageOf = (error) =>
    typeof error?.message === "string" && error.message.trim() !== ""
      ? error.message
      : t("payCard.cardFailed");

  /** Pay: Stripe confirms the payment with the reviewed card (3-D Secure in its own frame), then the complete page. */
  const submitPay = () =>
    withBusy(el.payButton, async () => {
      if (!review || !stripeSession || checkoutId === null || paymentId === null) {
        return;
      }
      const token = review.token;
      const done = completeHref(checkoutId, paymentId);
      clearMessages();
      live.announce(t("payCard.paying"));
      const result = await stripeSession.stripe
        .confirmPayment({
          clientSecret,
          confirmParams: { confirmation_token: token, return_url: new URL(done, location.origin).href },
          redirect: "if_required",
        })
        .catch(() => ({ error: /** @type {StripeError} */ ({}), paymentIntent: undefined }));
      if (destroyed) {
        return;
      }
      if (result.error && !CONFIRMED_INTENT.has(String(result.error.payment_intent?.status))) {
        // Declined, or 3-D Secure failed: the payment stays open; the traveller reviews again (another card).
        dropReview();
        showCardMessage(stripeMessageOf(result.error));
        el.reviewButton.focus();
        return;
      }
      // Confirmed (or confirmed before, as Stripe reports): the complete page books the flight.
      leaving = true;
      live.announce(t("payCard.paid"));
      navigate(done);
    });

  /** @param {Event} event */
  const onReview = (event) => {
    event.preventDefault();
    if (el.reviewButton.getAttribute("aria-disabled") !== "true") {
      submitReview().catch(report);
    }
  };
  /** @param {Event} event */
  const onPay = (event) => {
    event.preventDefault();
    if (el.payButton.getAttribute("aria-disabled") !== "true") {
      submitPay().catch(report);
    }
  };
  el.reviewButton.addEventListener("click", onReview);
  el.payButton.addEventListener("click", onPay);
  cleanups.push(() => el.reviewButton.removeEventListener("click", onReview));
  cleanups.push(() => el.payButton.removeEventListener("click", onPay));

  /**
   * Loads the payment and the checkout, then mounts the card form (or opens the page the payment belongs on).
   * @param {{ focus?: boolean }} [options]
   */
  const load = async ({ focus = false } = {}) => {
    if (checkoutId === null || paymentId === null) {
      return;
    }
    el.state.replaceChildren();
    el.content.hidden = true;
    el.loading.hidden = false;
    live.announce(t("payCard.loading"));
    const call = track();
    /** @type {[Payment, Checkout]} */
    let loaded;
    try {
      loaded = await Promise.all([
        client.checkout.getPayment({ paymentId }, { signal: call.signal }),
        client.checkout.get({ checkoutId }, { signal: call.signal }),
      ]);
    } catch (error) {
      call.done();
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (state.name === "not-found") {
        showMissing(focus);
        return;
      }
      if (checkoutEnded(state)) {
        return;
      }
      if (state.name === "signed-out") {
        showPageState(state, { link: { label: t("account.signIn"), href: signInHref(location) }, focus });
        return;
      }
      showPageState(state.name === "validation" ? { ...state, message: t("state.unexpected") } : state, {
        ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => load({ focus: true }).catch(report) }),
        requestId: state.name === "unexpected" || state.name === "validation" ? requestIdOf(error) : null,
        focus,
      });
      return;
    }
    call.done();
    if (destroyed) {
      return;
    }
    [payment, checkout] = loaded;
    if (payment.checkoutId !== checkoutId) {
      showMissing(focus);
      return;
    }
    if (
      checkout.status === "completed" &&
      typeof checkout.bookingId === "string" &&
      BOOKING_ID.test(checkout.bookingId)
    ) {
      replace(confirmationHref(checkout.bookingId));
      return;
    }
    if (checkout.status === "expired" || checkout.status === "abandoned") {
      showExpired();
      return;
    }
    if (payment.method === "airline_card") {
      replace(withQuery("/checkout/pay-airline.html", { id: checkoutId, payment: payment.id }));
      return;
    }
    if (!OPEN_STATUSES.has(payment.status) && !DEAD_STATUSES.has(payment.status)) {
      // Confirmed already (processing, authorised, captured): the complete page finishes the booking.
      replace(completeHref(checkoutId, payment.id));
      return;
    }
    el.back.href = paymentStepHref(checkoutId);
    el.back.hidden = false;
    doc.title = t("payCard.title");
    el.loading.hidden = true;
    el.content.hidden = false;
    renderSummary();
    if (payment.provider !== "stripe") {
      showUnavailable();
      return;
    }
    if (DEAD_STATUSES.has(payment.status)) {
      await renew({ notice: t("payCard.restarted") });
      return;
    }
    if (typeof payment.clientSecret !== "string" || payment.clientSecret === "") {
      showPageState(
        { name: "unexpected", scope: "inline", message: t("state.unexpected") },
        { link: { label: t("payCard.backToPayment"), href: paymentStepHref(checkoutId) }, focus },
      );
      return;
    }
    mountElement(payment);
  };

  const done = (async () => {
    if (checkoutId === null || paymentId === null) {
      showMissing(false);
      return;
    }
    // Stripe.js comes from its own static tag; without it no card can be taken here, so nothing else is loaded.
    if (typeof StripeJs !== "function") {
      showUnavailable();
      return;
    }
    await load();
  })().catch(report);

  return {
    done,
    destroy() {
      destroyed = true;
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      unmountElement();
      live.clear();
    },
  };
}

document.documentElement.dataset.js = "on";

boot().then((context) => {
  try {
    start(
      /** @type {{ config: StorefrontConfig, client: PageClient, session: SessionInfo | null }} */ (
        /** @type {unknown} */ (context)
      ),
    );
  } catch (error) {
    report(error);
  }
});
