// Entry module of the checkout data page (checkout.html, ota/frontend/docs/pages.md §7, flow
// ota/docs/flows/checkout-stripe.md §2 steps 1–3, SDK guide B3 §2). The price page opens it with
// `/checkout.html?id=chk_…&step=travellers` after `checkout.create`. One page, four steps (`step=`): travellers,
// contacts, extras (only when the OTA sells extras, `features.ancillaries`) and payment; each step is a history
// entry, so Back and Forward move between them, and the stepper shows the progress from `checkout.progress`.
//
// 1. `checkout.get({ checkoutId })` on load (with `reference.countries.list` for the nationality, issuing-country and
//    address selects): requirements, travellers, contacts, extras, totals, `version`, `expiresAt`, progress. A
//    completed checkout goes to its confirmation, an expired one says so with a link to price the flight again.
// 2. Travellers (components/traveller-form.js): `checkout.setTravelers({ checkoutId, ifMatch, travelers })` with the
//    fields of `requirements.travelers`.
// 3. Contacts (components/contact-form.js): `checkout.setContacts({ checkoutId, ifMatch, contacts })`, pre-filled
//    from the first adult traveller and, for customers, the account.
// 4. Extras (components/ancillary-picker.js): `flights.getAncillaries({ pricedOfferId: basePricedOfferId })`, then
//    `checkout.setAncillaries({ checkoutId, ifMatch, selections, expectedTotal })` when the choice changed, and
//    `checkout.setRemarks({ checkoutId, ifMatch, remarks })` for special requests. The expected total is the total on
//    the screen: the page never adds prices, so the airline's new total comes back as `409 PRICE_CHANGED`, is shown,
//    and is confirmed with a second call whose `expectedTotal` is that new total.
// 5. Payment: the methods of `config.payment.supportedMethods` (card, and the airline card only when listed, with its
//    notice), the total, the fare's conditions at a glance (`checkout.conditions`), the terms, privacy and fare-rules
//    links and "I accept"; then `checkout.createPayment({ checkoutId, method, termsAccepted: true, returnUrl })` (only
//    with the box ticked) and the card or airline-card page with `payment=pay_…`.
//
// Every `set*` call sends `ifMatch` with the version of the checkout on the screen. `412 PRECONDITION_FAILED` (another
// tab changed the checkout) reloads the checkout and applies the step once more on the new version, saying so. The
// states of pages.md §7: field errors with the focused error summary (components/error-summary.js), `409
// PRICE_CHANGED` and `422 ANCILLARY_NOT_AVAILABLE` on extras, `410 CHECKOUT_EXPIRED`, `422 CHECKOUT_INCOMPLETE` (jump
// to the first incomplete step), `424 PAYMENT_PROVIDER_NOT_CONFIGURED`, `403 FEATURE_DISABLED` for the airline card,
// and `409 CHECKOUT_BEING_COMPLETED` / `CHECKOUT_ALREADY_COMPLETED` (the booking's confirmation). The page loads no
// third-party script: card data is entered on the payment pages only. The step forms are `method="post"` without an
// action, so a submit that never reaches this script puts no traveller data into an address.

import { boot, renderState } from "../boot.js";
import { mount as mountAncillaries, sameSelections, selectionsOf } from "../components/ancillary-picker.js";
import { mount as mountContacts } from "../components/contact-form.js";
import {
  errorsOfStep,
  firstStepWithErrors,
  mount as mountErrorSummary,
  remapTravellerPointers,
} from "../components/error-summary.js";
import { airlineLabel, renderItinerary } from "../components/itinerary.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import {
  checkoutSteps,
  firstIncompleteStep,
  isReachable,
  isStep,
  mount as mountStepper,
  stepToShow,
} from "../components/stepper.js";
import { mount as mountTravellers, travellerTitle } from "../components/traveller-form.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatMoney, formatTimestamp } from "../lib/format.js";
import { withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import { signInHref } from "../lib/session.js";
import { safeUrl, withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Checkout"]} Checkout */
/** @typedef {import("@velexis/ota-sdk").Schemas["AncillaryCatalogue"]} AncillaryCatalogue */
/** @typedef {import("@velexis/ota-sdk").Schemas["AncillarySelection"]} AncillarySelection */
/** @typedef {import("@velexis/ota-sdk").Schemas["RemarkInput"]} RemarkInput */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("@velexis/ota-sdk").Schemas["FieldError"]} FieldError */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontPaymentConfig"]} PaymentConfig */
/** @typedef {import("@velexis/ota-sdk").Schemas["Customer"]} Customer */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("../components/stepper.js").CheckoutStep} CheckoutStep */
/** @typedef {import("../components/traveller-form.js").CountryOption} CountryOption */
/** @typedef {Pick<VelexisClient, "checkout" | "flights" | "reference">} PageClient */
/** @typedef {"card" | "airline_card"} PaymentMethod */

/** A checkout id as the API writes it. */
export const CHECKOUT_ID = /^chk_[0-9A-Za-z]{16,40}$/;
const PAYMENT_ID = /^pay_[0-9A-Za-z]{16,40}$/;
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
const PRICED_OFFER_ID = /^prc_[0-9A-Za-z]{16,40}$/;
/** At most this many special requests (RemarkInput, `checkout.setRemarks`). */
export const MAX_REMARKS = 5;
/** The payment page of each method this storefront can start. */
export const PAYMENT_PAGES = Object.freeze({
  card: "/checkout/pay-card.html",
  airline_card: "/checkout/pay-airline.html",
});
/** Page size and page limit of the country list (about 250 countries). */
const COUNTRY_PAGE_SIZE = 100;
const MAX_COUNTRY_PAGES = 5;
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
 * The address of a step of a checkout.
 * @param {string} checkoutId
 * @param {CheckoutStep} step
 */
export const checkoutHref = (checkoutId, step) => withQuery("/checkout.html", { id: checkoutId, step });

/**
 * The confirmation page of a booking (`pending=1` while the airline order is being confirmed).
 * @param {string} bookingId
 * @param {boolean} [pending]
 */
export const confirmationHref = (bookingId, pending = false) =>
  withQuery("/confirmation.html", { booking: bookingId, pending: pending ? 1 : null });

/**
 * The payment methods this page offers: those of `supportedMethods` that the storefront has a payment page for
 * (`card`, and `airline_card` only when listed and its configuration is not switched off).
 * @param {Partial<PaymentConfig> | null | undefined} payment
 * @returns {PaymentMethod[]}
 */
export function paymentMethods(payment) {
  const supported = list(payment?.supportedMethods);
  return /** @type {PaymentMethod[]} */ (
    ["card", "airline_card"].filter(
      (method) =>
        supported.includes(method) && (method !== "airline_card" || payment?.airlineCard?.enabled !== false),
    )
  );
}

/**
 * Every country of `reference.countries.list` as `{ code, name }`, following the pages; `null` when the list cannot be
 * loaded (the forms then take two-letter codes).
 * @param {Pick<VelexisClient, "reference">} client
 * @param {{ signal?: AbortSignal, locale?: string }} [options]
 * @returns {Promise<CountryOption[] | null>}
 */
export async function loadCountries(client, { signal, locale } = {}) {
  try {
    /** @type {CountryOption[]} */
    const countries = [];
    let page = await client.reference.countries.list(
      { limit: COUNTRY_PAGE_SIZE },
      { ...(signal ? { signal } : {}), ...(locale ? { locale } : {}) },
    );
    for (let pages = 1; page; pages += 1) {
      for (const country of list(page.data)) {
        if (typeof country?.code === "string" && typeof country?.name === "string") {
          countries.push({ code: country.code, name: country.name });
        }
      }
      page = pages < MAX_COUNTRY_PAGES && typeof page.next === "function" ? await page.next() : null;
    }
    return countries.length > 0 ? countries : null;
  } catch {
    return null;
  }
}

/**
 * The special requests of the extras step as `RemarkInput`s: the non-empty fields in order, each with the travellers
 * of the stored request it was filled from.
 * @param {ReadonlyArray<HTMLInputElement>} inputs
 * @param {ReadonlyArray<ReadonlyArray<string> | null>} travellers the `travelerIds` of each field's stored request
 * @returns {RemarkInput[]}
 */
export function readRemarks(inputs, travellers) {
  return inputs.flatMap((input, index) => {
    const text = input.value.trim();
    const ids = travellers[index];
    return text === "" ? [] : [{ text, ...(ids && ids.length > 0 ? { travelerIds: [...ids] } : {}) }];
  });
}

/**
 * Whether the requests to send are the stored ones (text compared without case: the API upper-cases it).
 * @param {ReadonlyArray<RemarkInput>} remarks
 * @param {ReadonlyArray<{ text: string, travelerIds?: ReadonlyArray<string> }>} stored
 */
export function sameRemarks(remarks, stored) {
  const key = (/** @type {{ text: string, travelerIds?: ReadonlyArray<string> }} */ remark) =>
    `${remark.text.trim().toUpperCase()}|${list(remark.travelerIds).join(",")}`;
  return (
    remarks.length === stored.length && remarks.every((remark, index) => key(remark) === key(stored[index]))
  );
}

/**
 * Runs the checkout page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page
 * has no checkout area, else `{ done, destroy }`: `done` settles once the checkout (or a state) is shown.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, history?: History, navigate?: (url: string) => void, replace?: (url: string) => void }} [env]
 *   for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-checkout-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const history = env.history ?? view.history;
  const navigate = env.navigate ?? ((/** @type {string} */ url) => location.assign(url));
  const replace = env.replace ?? ((/** @type {string} */ url) => location.replace(url));
  const { config, client } = context;
  const account = /** @type {Customer | null} */ (context.session?.customer ?? null);
  const locale = config?.defaultLocale;
  const support = config?.support ?? null;
  const features = config?.features;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const form = (/** @type {CheckoutStep} */ step) =>
    /** @type {HTMLFormElement} */ (main.querySelector(`form[data-step-form="${step}"]`));
  const el = {
    back: /** @type {HTMLAnchorElement} */ (main.querySelector("a[data-back-link]")),
    stepper: find("[data-stepper]"),
    stepperList: find("[data-stepper-list]"),
    state: find("[data-checkout-state]"),
    loading: find("[data-checkout-loading]"),
    content: find("[data-checkout-content]"),
    notice: find("[data-step-notice]"),
    travellers: find("[data-travellers]"),
    extrasLoading: find("[data-extras-loading]"),
    extrasState: find("[data-extras-state]"),
    extrasEmpty: find("[data-extras-empty]"),
    ancillaries: find("[data-ancillaries]"),
    extrasMessage: find("[data-extras-message]"),
    extrasChange: find("[data-extras-change]"),
    extrasChangeText: find("[data-extras-change-text]"),
    extrasSubmit: /** @type {HTMLButtonElement} */ (main.querySelector("button[data-extras-submit]")),
    remarks: find("[data-remarks]"),
    paymentChange: find("[data-payment-change]"),
    paymentChangeText: find("[data-payment-change-text]"),
    paymentMethods: find("[data-payment-methods]"),
    paymentMethodList: find("[data-payment-method-list]"),
    paymentUnavailable: find("[data-payment-unavailable]"),
    paymentTotal: find("[data-payment-total]"),
    paymentTotalNote: find("[data-payment-total-note]"),
    paymentConditions: find("[data-payment-conditions]"),
    paymentLinks: find("[data-payment-links]"),
    paymentState: find("[data-payment-state]"),
    terms: /** @type {HTMLInputElement} */ (main.querySelector("input[data-terms]")),
    itineraries: find("[data-checkout-itineraries]"),
    totalOffer: find("[data-total-offer]"),
    totalExtrasRow: find("[data-total-extras-row]"),
    totalExtras: find("[data-total-extras]"),
    totalCardFeeRow: find("[data-total-card-fee-row]"),
    totalCardFee: find("[data-total-card-fee]"),
    total: find("[data-total]"),
    expiry: find("[data-checkout-expiry]"),
  };
  const sections = /** @type {HTMLElement[]} */ (Array.from(main.querySelectorAll("section[data-step]")));
  const paymentSubmit = /** @type {HTMLButtonElement} */ (
    form("payment").querySelector('button[type="submit"]')
  );
  const extrasIdleLabel = el.extrasSubmit.textContent?.trim() ?? "";
  const summaries = /** @type {Record<CheckoutStep, ReturnType<typeof mountErrorSummary>>} */ ({
    travellers: mountErrorSummary(form("travellers")),
    contacts: mountErrorSummary(form("contacts")),
    extras: mountErrorSummary(form("extras")),
    payment: mountErrorSummary(form("payment")),
  });

  const idParam = new URLSearchParams(location.search).get("id");
  const checkoutId = idParam !== null && CHECKOUT_ID.test(idParam) ? idParam : null;
  /** The checkout on the screen. @type {Checkout | null} */
  let checkout = null;
  /** @type {CheckoutStep[]} */
  let steps = checkoutSteps(features);
  /** @type {CheckoutStep} */
  let current = "travellers";
  /** @type {CountryOption[] | null} */
  let countries = null;
  /** The extras catalogue: `undefined` until loaded, `null` when it could not be. @type {AncillaryCatalogue | null | undefined} */
  let catalogue;
  /** @type {ReturnType<typeof mountTravellers> | null} */
  let travellersForm = null;
  /** @type {ReturnType<typeof mountContacts> | null} */
  let contactsForm = null;
  /** @type {ReturnType<typeof mountAncillaries> | null} */
  let picker = null;
  /** The special-request fields and the travellers of the stored request each was filled from. */
  let remarkInputs = /** @type {HTMLInputElement[]} */ ([]);
  let remarkTravellers = /** @type {Array<ReadonlyArray<string> | null>} */ ([]);
  /** A new total of the extras that waits for the traveller's confirmation. @type {{ selections: AncillarySelection[], newPrice: Money } | null} */
  let pendingChange = null;
  /** Whether the traveller typed into the contact step since it was filled (a refill would lose that). */
  let contactsTyped = false;
  /** The airline card was refused (`403 FEATURE_DISABLED`): it is not offered again on this page. */
  let airlineCardRefused = false;
  /** Running calls, aborted by destroy. @type {Set<AbortController>} */
  const controllers = new Set();
  /** @type {Array<() => void>} */
  const cleanups = [];
  let destroyed = false;

  const stepper = mountStepper(el.stepperList, {
    hrefFor: (step) => checkoutHref(/** @type {string} */ (checkoutId), step),
    onSelect: (step) => goTo(step, { history: "push", focus: true }),
  });

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

  /** @param {unknown} error */
  const codeOf = (error) => pageStateFor(error).code;

  /** The price page of the checkout's flight, to price it again; `null` before the checkout is known. */
  const priceHref = () =>
    checkout && PRICED_OFFER_ID.test(checkout.basePricedOfferId)
      ? withQuery("/price.html", { priced: checkout.basePricedOfferId })
      : null;

  /**
   * A link under a state: back to the price page (or `home`, or without a price page), else the home page.
   * @param {HTMLElement} element
   * @param {string} label
   * @param {boolean} [home] link to the home page ("Search flights")
   */
  const addLink = (element, label, home = false) => {
    const href = home ? null : priceHref();
    const link = fill(clone("tpl-state-link", doc), {
      label: href === null ? t("offerPage.searchFlights") : label,
      href: href ?? "/",
    });
    const retry = element.querySelector('[data-action="retry"]')?.closest("p");
    if (retry) {
      retry.before(link);
    } else {
      element.append(link);
    }
  };

  /**
   * Replaces the checkout with a state (it cannot be used, or never loaded).
   * @param {Pick<PageState, "name" | "message" | "scope"> & Partial<PageState>} state
   * @param {{ link?: string, home?: boolean, onRetry?: () => void, requestId?: string | null, focus?: boolean }} [options]
   */
  const showPageState = (state, { link, home = false, onRetry, requestId = null, focus = true } = {}) => {
    el.loading.hidden = true;
    el.content.hidden = true;
    el.stepper.hidden = true;
    doc.title = state.message;
    const element = renderState(el.state, state, {
      support,
      requestId,
      focus,
      ...(onRetry ? { onRetry } : {}),
    });
    if (link) {
      addLink(element, link, home);
    }
    live.announce(state.message);
  };

  /** "Your session expired", with a link to price the flight again. */
  const showExpired = () => {
    pendingChange = null;
    showPageState(
      { name: "checkout-expired", scope: "inline", message: t("state.checkout-expired") },
      { link: t("pricePage.priceAgain") },
    );
  };

  /** The trip, the totals and the hold time of the summary. */
  const renderSummary = () => {
    if (!checkout) {
      return;
    }
    const tripType = checkout.summary?.tripType ?? "one_way";
    /** Airline names from the flights ("Air France (AF)"). @type {Map<string, string>} */
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
    el.totalOffer.textContent = formatMoney(totals.offer, locale);
    const extras = list(checkout.ancillaries).length > 0;
    el.totalExtrasRow.hidden = !extras;
    el.totalExtras.textContent = extras ? formatMoney(totals.ancillaries, locale) : "";
    el.totalCardFeeRow.hidden = !totals.cardFee;
    el.totalCardFee.textContent = totals.cardFee ? formatMoney(totals.cardFee, locale) : "";
    el.total.textContent = formatMoney(totals.total, locale);
    el.expiry.textContent = t("checkout.heldUntil", {
      time: formatTimestamp(checkout.expiresAt, locale, config?.timeZone),
    });
    const href = priceHref();
    el.back.href = href ?? "/";
    el.back.hidden = href === null;
  };

  /** The traveller titles by `travelerId` ("Traveller 1: Anna Berg, adult"). */
  const titleFor = (/** @type {string} */ travelerId) => {
    const requirements = list(checkout?.requirements?.travelers);
    const position = requirements.findIndex((requirement) => requirement.travelerId === travelerId);
    const traveller = list(checkout?.travelers).find((entry) => entry.travelerId === travelerId) ?? null;
    return position < 0
      ? t("checkout.travellerNumber", { number: travelerId })
      : travellerTitle(position, requirements[position], traveller);
  };

  const renderTravellers = () => {
    if (!checkout) {
      return;
    }
    travellersForm?.destroy();
    summaries.travellers.clear();
    travellersForm = mountTravellers(el.travellers, {
      requirements: list(checkout.requirements?.travelers),
      travelers: list(checkout.travelers),
      countries,
    });
  };

  const renderContacts = () => {
    if (!checkout) {
      return;
    }
    contactsForm?.destroy();
    summaries.contacts.clear();
    contactsTyped = false;
    const language = typeof locale === "string" ? locale.split("-")[0]?.toLowerCase() : null;
    contactsForm = mountContacts(form("contacts"), {
      requirements: checkout.requirements.contact,
      contacts: list(checkout.contacts),
      travelers: list(checkout.travelers),
      account,
      countries,
      language: language ?? null,
    });
  };

  /** The special-request fields: one per stored request and one empty field, at most five. */
  const renderRemarks = () => {
    const stored = list(checkout?.remarks).filter((remark) => typeof remark?.text === "string");
    const count = Math.min(MAX_REMARKS, stored.length + 1);
    remarkTravellers = Array.from({ length: count }, (_, index) => {
      const ids = list(stored[index]?.travelerIds);
      return ids.length > 0 ? ids : null;
    });
    const labels = Array.from({ length: count }, (_, index) =>
      fill(clone("tpl-remark", doc), { label: t("checkout.remarkLabel", { number: index + 1 }) }),
    );
    remarkInputs = labels.map((label, index) => {
      const input = /** @type {HTMLInputElement} */ (label.querySelector("input[data-remark-input]"));
      input.name = `remarks.${index}.text`;
      input.id = `checkout-remark-${index + 1}`;
      input.value = typeof stored[index]?.text === "string" ? stored[index].text : "";
      return input;
    });
    el.remarks.replaceChildren(...labels);
  };

  /**
   * The label of the extras' submit button; while the form is busy, the label it gets back afterwards
   * (lib/forms.js keeps it in `data-idle-label`).
   * @param {string} label
   */
  const setExtrasLabel = (label) => {
    if (el.extrasSubmit.hasAttribute("data-idle-label")) {
      el.extrasSubmit.setAttribute("data-idle-label", label);
    } else {
      el.extrasSubmit.textContent = label;
    }
  };

  /** Hides the extras' price change and puts the submit button's label back. */
  const clearPendingChange = () => {
    pendingChange = null;
    el.extrasChange.hidden = true;
    setExtrasLabel(extrasIdleLabel);
  };

  const renderExtras = () => {
    picker?.destroy();
    picker = null;
    el.extrasMessage.hidden = true;
    clearPendingChange();
    if (!checkout || !catalogue) {
      el.extrasEmpty.hidden = true;
      return;
    }
    picker = mountAncillaries(el.ancillaries, {
      catalogue,
      ancillaries: list(checkout.ancillaries),
      titleFor,
      ...(locale ? { locale } : {}),
      seats: features?.seatSelection === true,
    });
    el.extrasEmpty.hidden = !picker.empty;
  };

  /** Loads the extras catalogue once (optional: a failure leaves the step with special requests only). */
  const loadExtras = async () => {
    if (!checkout || catalogue !== undefined) {
      return;
    }
    catalogue = null;
    el.extrasState.replaceChildren();
    el.extrasLoading.hidden = false;
    const call = track();
    /** @type {unknown} */
    let failure = null;
    /** @type {AncillaryCatalogue | null} */
    let result = null;
    try {
      result = await client.flights.getAncillaries(
        { pricedOfferId: checkout.basePricedOfferId },
        { signal: call.signal },
      );
    } catch (error) {
      failure = error;
    } finally {
      call.done();
    }
    if (destroyed || (failure !== null && isAborted(failure))) {
      return;
    }
    el.extrasLoading.hidden = true;
    if (failure !== null) {
      const state = pageStateFor(failure);
      const final = FINAL_STATES.has(state.name) || state.name === "offer-expired";
      renderState(
        el.extrasState,
        { ...state, scope: "inline", message: t("checkout.extrasFailed") },
        {
          support,
          ...(final
            ? {}
            : {
                onRetry: () => {
                  catalogue = undefined;
                  loadExtras().catch(report);
                },
              }),
        },
      );
      renderExtras();
      return;
    }
    catalogue = result;
    renderExtras();
  };

  /** The payment step: the methods, the total, the links and the terms. */
  const renderPayment = () => {
    if (!checkout) {
      return;
    }
    const methods = paymentMethods(config?.payment).filter(
      (method) => method !== "airline_card" || !airlineCardRefused,
    );
    const previous = /** @type {HTMLInputElement | null} */ (
      el.paymentMethodList.querySelector("input[data-payment-method]:checked")
    )?.value;
    const selected = methods.find((method) => method === previous) ?? methods[0];
    const brands = list(config?.payment?.pspCardBrands)
      .map((brand) => (typeof brand?.label === "string" ? brand.label : null))
      .filter((label) => label !== null);
    el.paymentMethodList.replaceChildren(
      ...methods.map((method) => {
        const detail =
          method === "airline_card"
            ? (config?.payment?.airlineCard?.notice ?? null)
            : brands.length > 0
              ? t("checkout.cardBrands", { brands: brands.join(", ") })
              : null;
        return fill(clone("tpl-payment-method", doc), {
          method,
          label: t(`checkout.method.${method}`),
          detail,
          noDetail: detail === null || detail === "",
          checked: method === selected,
        });
      }),
    );
    el.paymentMethods.hidden = methods.length === 0;
    paymentSubmit.hidden = methods.length === 0;
    if (methods.length === 0) {
      renderState(el.paymentUnavailable, {
        name: "feature-disabled",
        scope: "inline",
        message: t("checkout.paymentsUnavailable"),
      });
    } else {
      el.paymentUnavailable.replaceChildren();
    }
    el.paymentTotal.textContent = formatMoney(checkout.totals.total, locale);
    renderPaymentNote();
    renderPaymentConditions();
    renderPaymentLinks();
  };

  /**
   * The fare's refund and change conditions at a glance (`checkout.conditions`), next to the links. The fare-rules link
   * opens the price page of the base priced offer, which a checkout may outlive (the price page then says the fare is
   * no longer available), so what the traveller accepts stays on this page too.
   */
  const renderPaymentConditions = () => {
    const conditions = checkout?.conditions;
    const facts = [
      conditions?.refundable === true
        ? t("offer.refundable")
        : conditions?.refundable === false
          ? t("offer.nonRefundable")
          : null,
      conditions?.changeable === true
        ? t("offer.changeable")
        : conditions?.changeable === false
          ? t("offer.notChangeable")
          : null,
    ].filter((fact) => fact !== null);
    el.paymentConditions.textContent =
      facts.length > 0 ? t("checkout.conditions", { conditions: facts.join(" · ") }) : "";
    el.paymentConditions.hidden = facts.length === 0;
  };

  /** The line under the total: the card fee that may follow, or the airline card's price notice. */
  const renderPaymentNote = () => {
    const method = /** @type {HTMLInputElement | null} */ (
      el.paymentMethodList.querySelector("input[data-payment-method]:checked")
    )?.value;
    el.paymentTotalNote.textContent =
      method === "airline_card" ? t("checkout.airlineCardTotal") : t("checkout.cardFeeNote");
  };

  /** "Read the terms and conditions, the privacy policy and the fare rules (new tab)." */
  const renderPaymentLinks = () => {
    const pricePage = priceHref();
    const links = [
      [config?.legal?.termsUrl, t("checkout.terms")],
      [config?.legal?.privacyUrl, t("checkout.privacy")],
      [pricePage === null ? null : `${pricePage}#fare-rules`, t("checkout.fareRules")],
    ]
      .map(([url, label]) => {
        const href = typeof url === "string" ? safeUrl(url, ["https:"]) : null;
        return href === null ? null : fill(clone("tpl-payment-link", doc), { label, href });
      })
      .filter((link) => link !== null);
    const parts = /** @type {Node[]} */ ([doc.createTextNode(t("checkout.readBefore"))]);
    links.forEach((link, index) => {
      if (index > 0) {
        parts.push(
          doc.createTextNode(t(index === links.length - 1 ? "checkout.listLast" : "checkout.listSeparator")),
        );
      }
      parts.push(link);
    });
    parts.push(doc.createTextNode(t("checkout.newTab")));
    el.paymentLinks.replaceChildren(...(links.length > 0 ? parts : []));
  };

  /** Re-renders what depends on the whole checkout (after any change). */
  const renderCheckout = () => {
    renderSummary();
    stepper.update({ steps, current, progress: checkout?.progress });
    if (current === "payment") {
      renderPayment();
    }
  };

  /**
   * Shows a step: the history entry (`push` for a move, `replace` to correct the address, `none` after Back or
   * Forward), the stepper, the title, and the focus on the step's heading.
   * @param {CheckoutStep} step
   * @param {{ history?: "push" | "replace" | "none", focus?: boolean }} [options]
   */
  const goTo = (step, { history: entry = "push", focus = true } = {}) => {
    if (!checkout || checkoutId === null) {
      return;
    }
    current = step;
    for (const section of sections) {
      section.hidden = section.getAttribute("data-step") !== step;
    }
    el.notice.replaceChildren();
    const href = checkoutHref(checkoutId, step);
    // The step already in the address (its own link in the stepper) adds no history entry.
    if (entry === "push" && `${location.pathname}${location.search}` !== href) {
      history.pushState({ step }, "", href);
    } else if (entry === "replace") {
      history.replaceState({ step }, "", href);
    }
    doc.title = t("checkout.title", { step: t(`checkout.step.${step}`) });
    stepper.update({ steps, current, progress: checkout.progress });
    if (step === "extras") {
      loadExtras().catch(report);
    }
    if (step === "payment") {
      renderPayment();
    }
    if (focus) {
      const heading = /** @type {HTMLElement | null} */ (
        main.querySelector(`section[data-step="${step}"] h2`)
      );
      heading?.focus();
    }
  };

  /** The step after `step` in this checkout. */
  const nextStep = (/** @type {CheckoutStep} */ step) =>
    /** @type {CheckoutStep} */ (steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)]);

  /** Back and Forward between the steps. */
  const onPopState = () => {
    if (destroyed || !checkout) {
      return;
    }
    const requested = new URLSearchParams(location.search).get("step");
    const step = stepToShow(requested, steps, checkout.progress);
    goTo(step, { history: step === requested ? "none" : "replace", focus: true });
  };
  view.addEventListener("popstate", onPopState);
  cleanups.push(() => view.removeEventListener("popstate", onPopState));

  /**
   * Sends a step's change with the version on the screen. A `412` (another tab changed the checkout) reloads the
   * checkout and sends the change once more on the reloaded version. Resolves with the new checkout, or with the
   * error the page has to show.
   * @param {(ifMatch: number) => Promise<Checkout>} send
   * @returns {Promise<{ ok: true, checkout: Checkout, reapplied: boolean } | { ok: false, error: unknown }>}
   */
  const save = async (send) => {
    let reapplied = false;
    for (;;) {
      try {
        const result = await send(/** @type {Checkout} */ (checkout).version);
        return { ok: true, checkout: result, reapplied };
      } catch (error) {
        if (reapplied || codeOf(error) !== "PRECONDITION_FAILED" || checkoutId === null) {
          return { ok: false, error };
        }
        try {
          checkout = await client.checkout.get({ checkoutId });
        } catch (reloadError) {
          return { ok: false, error: reloadError };
        }
        reapplied = true;
        renderCheckout();
      }
    }
  };

  /**
   * Takes the checkout a step answered with.
   * @param {Checkout} next
   */
  const accept = (next) => {
    checkout = next;
    renderCheckout();
  };

  /**
   * Moves on after a saved step; when the change was applied on a version from another tab, the next step says so.
   * @param {CheckoutStep} step the saved step
   * @param {boolean} reapplied
   */
  const advance = (step, reapplied) => {
    goTo(nextStep(step));
    if (reapplied) {
      renderState(el.notice, { name: "stale", scope: "inline", message: t("checkout.reapplied") });
      live.announce(t("checkout.reapplied"));
    }
  };

  /**
   * Shows a failure of a step (after its own cases): field errors on its form, the checkout's end (expired,
   * completed, being completed), or a state with Retry.
   * @param {CheckoutStep} step
   * @param {unknown} error
   * @param {() => void} retry
   */
  const fail = (step, error, retry) => {
    if (destroyed || isAborted(error)) {
      return;
    }
    const state = pageStateFor(error);
    const bookingId = state.details?.["bookingId"];
    if (state.code === "CHECKOUT_EXPIRED" || state.name === "checkout-expired") {
      showExpired();
      return;
    }
    if (
      (state.code === "CHECKOUT_ALREADY_COMPLETED" || state.code === "CHECKOUT_BEING_COMPLETED") &&
      typeof bookingId === "string" &&
      BOOKING_ID.test(bookingId)
    ) {
      replace(confirmationHref(bookingId, state.code === "CHECKOUT_BEING_COMPLETED"));
      return;
    }
    if (state.code === "CHECKOUT_ALREADY_COMPLETED") {
      // Completed meanwhile, without the booking in the answer (a payment refused under the checkout's lock): the
      // checkout itself names its booking, and loading it opens the confirmation. Retrying the step cannot succeed.
      load({ focus: true }).catch(report);
      return;
    }
    if (state.name === "validation") {
      const fieldErrors = errorsOfStep(state.fieldErrors, step);
      if (fieldErrors.length > 0) {
        summaries[step].show(fieldErrors);
        live.announce(t("state.validation"));
      } else {
        summaries[step].message(t("checkout.notSaved"));
        live.announce(t("checkout.notSaved"));
      }
      return;
    }
    if (state.name === "not-found") {
      showPageState(
        { name: "not-found", scope: "inline", message: t("checkout.missing") },
        { link: t("pricePage.priceAgain") },
      );
      return;
    }
    if (state.name === "sold-out" || state.name === "offer-expired") {
      // Sold out: another flight from the search; expired: the same flight priced again.
      showPageState(state, { link: t("pricePage.priceAgain"), home: state.name === "sold-out" });
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
    if (state.name === "stale") {
      // A second 412 in a row: Reload shows the saved checkout; what was typed in this step is replaced by it.
      const element = renderState(
        el.notice,
        { ...state, message: t("checkout.stale") },
        { support, focus: true, onRetry: () => load({ focus: true }).catch(report) },
      );
      const button = element.querySelector('[data-action="retry"]');
      if (button) {
        button.textContent = t("checkout.reload");
      }
      live.announce(t("checkout.stale"));
      return;
    }
    renderState(el.notice, state, {
      support,
      focus: true,
      requestId: state.name === "unexpected" ? requestIdOf(error) : null,
      ...(FINAL_STATES.has(state.name) ? {} : { onRetry: retry }),
    });
    live.announce(state.message);
  };

  /** Travellers: `checkout.setTravelers`, then the contacts. */
  const submitTravellers = () =>
    withSubmitState(form("travellers"), async () => {
      if (!checkout || !travellersForm || checkoutId === null) {
        return;
      }
      summaries.travellers.clear();
      el.notice.replaceChildren();
      const travelers = travellersForm.read();
      const result = await save((ifMatch) =>
        client.checkout.setTravelers({ checkoutId, ifMatch, travelers }),
      );
      if (destroyed) {
        return;
      }
      if (!result.ok) {
        fail("travellers", result.error, () => form("travellers").requestSubmit());
        return;
      }
      accept(result.checkout);
      renderTravellers();
      // The contact step takes the first adult's name, unless the traveller has typed there already.
      if (list(checkout?.contacts).length === 0 && !contactsTyped) {
        renderContacts();
      }
      live.announce(t("checkout.travellersSaved"));
      advance("travellers", result.reapplied);
    });

  /** Contacts: `checkout.setContacts`, then the extras or the payment. */
  const submitContacts = () =>
    withSubmitState(form("contacts"), async () => {
      if (!checkout || !contactsForm || checkoutId === null) {
        return;
      }
      summaries.contacts.clear();
      el.notice.replaceChildren();
      const contacts = contactsForm.read();
      const result = await save((ifMatch) => client.checkout.setContacts({ checkoutId, ifMatch, contacts }));
      if (destroyed) {
        return;
      }
      if (!result.ok) {
        fail("contacts", result.error, () => form("contacts").requestSubmit());
        return;
      }
      accept(result.checkout);
      renderContacts();
      live.announce(t("checkout.contactsSaved"));
      advance("contacts", result.reapplied);
    });

  /**
   * The extras' new total, waiting for the traveller's confirmation (`409 PRICE_CHANGED`: the checkout is unchanged).
   * @param {AncillarySelection[]} selections
   * @param {unknown} error
   * @returns {boolean} whether the error was a price change with a new total
   */
  const showExtrasChange = (selections, error) => {
    const details = pageStateFor(error).details ?? {};
    const newPrice = /** @type {Money | undefined} */ (
      /** @type {{ newPrice?: Money }} */ (error).newPrice ?? details["newPrice"]
    );
    const oldPrice = /** @type {Money | undefined} */ (
      /** @type {{ oldPrice?: Money }} */ (error).oldPrice ?? details["oldPrice"]
    );
    if (!newPrice || typeof newPrice.amount !== "string") {
      return false;
    }
    pendingChange = { selections, newPrice };
    el.extrasChangeText.textContent = oldPrice
      ? t("checkout.extrasNewTotal", {
          new: formatMoney(newPrice, locale),
          old: formatMoney(oldPrice, locale),
        })
      : t("checkout.extrasNewTotalOnly", { new: formatMoney(newPrice, locale) });
    el.extrasChange.hidden = false;
    setExtrasLabel(t("checkout.extrasConfirm", { price: formatMoney(newPrice, locale) }));
    const heading = /** @type {HTMLElement | null} */ (el.extrasChange.querySelector("h3"));
    heading?.focus();
    live.announce(el.extrasChangeText.textContent);
    return true;
  };

  /** Extras: `checkout.setAncillaries` when the choice changed, `checkout.setRemarks` when the requests did. */
  const submitExtras = () =>
    withSubmitState(form("extras"), async () => {
      if (!checkout || checkoutId === null) {
        return;
      }
      summaries.extras.clear();
      el.notice.replaceChildren();
      el.extrasMessage.hidden = true;
      const selections = picker ? picker.read() : null;
      let reapplied = false;
      if (selections !== null && !sameSelections(selections, selectionsOf(checkout.ancillaries))) {
        // The total on the screen, or the new total the traveller confirms for exactly these extras.
        const expectedTotal =
          pendingChange && sameSelections(pendingChange.selections, selections)
            ? pendingChange.newPrice
            : checkout.totals.total;
        const result = await save((ifMatch) =>
          client.checkout.setAncillaries({ checkoutId, ifMatch, selections, expectedTotal }),
        );
        if (destroyed) {
          return;
        }
        if (!result.ok) {
          const code = codeOf(result.error);
          if (code === "PRICE_CHANGED" && showExtrasChange(selections, result.error)) {
            return;
          }
          if (code === "ANCILLARY_NOT_AVAILABLE") {
            const index = pageStateFor(result.error).details?.["selectionIndex"];
            const selection = typeof index === "number" ? selections[index] : undefined;
            const label =
              selection && typeof selection.optionId === "string"
                ? picker?.removeOption(selection.optionId, selection.travelerId)
                : null;
            clearPendingChange();
            el.extrasMessage.textContent = label
              ? t("checkout.extraRemoved", { label })
              : t("checkout.extraUnavailable");
            el.extrasMessage.hidden = false;
            live.announce(el.extrasMessage.textContent);
            return;
          }
          fail("extras", result.error, () => form("extras").requestSubmit());
          return;
        }
        accept(result.checkout);
        clearPendingChange();
        reapplied = result.reapplied;
        live.announce(
          t("checkout.extrasSaved", { price: formatMoney(result.checkout.totals.total, locale) }),
        );
      }
      const remarks = readRemarks(remarkInputs, remarkTravellers);
      // The request lists the filled fields only, so each filled field answers for its own place in it.
      let position = 0;
      for (const input of remarkInputs) {
        if (input.value.trim() === "") {
          input.removeAttribute("data-error-path");
        } else {
          input.setAttribute("data-error-path", `/remarks/${position}/text /remarks/${position}`);
          position += 1;
        }
      }
      if (!sameRemarks(remarks, list(checkout.remarks))) {
        const result = await save((ifMatch) => client.checkout.setRemarks({ checkoutId, ifMatch, remarks }));
        if (destroyed) {
          return;
        }
        if (!result.ok) {
          fail("extras", result.error, () => form("extras").requestSubmit());
          return;
        }
        accept(result.checkout);
        renderRemarks();
        reapplied ||= result.reapplied;
      }
      advance("extras", reapplied);
    });

  /**
   * `422 CHECKOUT_INCOMPLETE`: the checkout again (its progress), then the first step with a problem, its fields
   * marked.
   * @param {unknown} error
   */
  const showIncomplete = async (error) => {
    if (checkoutId === null) {
      return;
    }
    try {
      checkout = await client.checkout.get({ checkoutId });
    } catch (reloadError) {
      fail("payment", reloadError, () => form("payment").requestSubmit());
      return;
    }
    if (destroyed || !checkout) {
      return;
    }
    renderCheckout();
    // The error's pointers, else what the reloaded checkout still misses (`progress.missing`, the same pointers).
    const pointers = list(pageStateFor(error).fieldErrors);
    const fieldErrors = remapTravellerPointers(
      pointers.length > 0 ? pointers : list(checkout.progress?.missing),
      list(checkout.travelers).map((traveller) => traveller.travelerId),
      list(checkout.requirements?.travelers).map((requirement) => requirement.travelerId),
    );
    const step =
      firstStepWithErrors(fieldErrors, steps) ??
      firstIncompleteStep(steps, checkout.progress) ??
      "travellers";
    goTo(step, { focus: false });
    const own = errorsOfStep(fieldErrors, step);
    if (own.length > 0) {
      summaries[step].show(own);
    } else {
      summaries[step].message(t("checkout.incomplete"));
    }
    live.announce(t("checkout.incomplete"));
  };

  /** Payment: `checkout.createPayment`, then the card or airline-card page. */
  const submitPayment = () =>
    withSubmitState(form("payment"), async () => {
      if (!checkout || checkoutId === null) {
        return;
      }
      summaries.payment.clear();
      el.notice.replaceChildren();
      el.paymentState.replaceChildren();
      el.paymentChange.hidden = true;
      const method = /** @type {PaymentMethod | undefined} */ (
        /** @type {HTMLInputElement | null} */ (
          el.paymentMethodList.querySelector("input[data-payment-method]:checked")
        )?.value
      );
      if (method !== "card" && method !== "airline_card") {
        return;
      }
      // `termsAccepted: true` is sent only for a ticked box (the browser's `required` check normally stops the submit).
      if (!el.terms.checked) {
        summaries.payment.show([{ path: "/termsAccepted", code: "TERMS_REQUIRED" }]);
        live.announce(t("state.validation"));
        return;
      }
      const returnUrl = new URL(withQuery("/checkout/complete.html", { id: checkoutId }), location.origin)
        .href;
      live.announce(t("checkout.paymentPreparing"));
      /** @type {{ id: string }} */
      let payment;
      try {
        payment = await client.checkout.createPayment({
          checkoutId,
          method,
          termsAccepted: true,
          ...(method === "card" ? { returnUrl } : {}),
        });
      } catch (error) {
        if (destroyed || isAborted(error)) {
          return;
        }
        const code = codeOf(error);
        if (code === "CHECKOUT_INCOMPLETE") {
          await showIncomplete(error);
          return;
        }
        if (code === "PAYMENT_PROVIDER_NOT_CONFIGURED") {
          renderState(
            el.paymentState,
            {
              name: "feature-disabled",
              scope: "inline",
              message: t("checkout.paymentsUnavailable"),
            },
            { focus: true },
          );
          live.announce(t("checkout.paymentsUnavailable"));
          return;
        }
        if (code === "FEATURE_DISABLED" && method === "airline_card") {
          airlineCardRefused = true;
          renderPayment();
          renderState(
            el.paymentState,
            {
              name: "feature-disabled",
              scope: "inline",
              message: t("checkout.airlineCardUnavailable"),
            },
            { focus: true },
          );
          live.announce(t("checkout.airlineCardUnavailable"));
          return;
        }
        if (code === "PRICE_CHANGED") {
          const previous = checkout.totals.total;
          try {
            checkout = await client.checkout.get({ checkoutId });
          } catch (reloadError) {
            fail("payment", reloadError, () => form("payment").requestSubmit());
            return;
          }
          if (destroyed) {
            return;
          }
          renderCheckout();
          el.paymentChangeText.textContent = t("checkout.paymentNewTotal", {
            new: formatMoney(checkout.totals.total, locale),
            old: formatMoney(previous, locale),
          });
          el.paymentChange.hidden = false;
          /** @type {HTMLElement | null} */ (el.paymentChange.querySelector("h3"))?.focus();
          live.announce(el.paymentChangeText.textContent);
          return;
        }
        if (code === "PAYMENT_PROVIDER_ERROR") {
          renderState(
            el.paymentState,
            { ...pageStateFor(error), scope: "inline", message: t("checkout.paymentProviderError") },
            { focus: true, support, onRetry: () => form("payment").requestSubmit() },
          );
          live.announce(t("checkout.paymentProviderError"));
          return;
        }
        fail("payment", error, () => form("payment").requestSubmit());
        return;
      }
      if (destroyed) {
        return;
      }
      if (typeof payment?.id !== "string" || !PAYMENT_ID.test(payment.id)) {
        fail("payment", new Error("checkout.createPayment answered without a payment id"), () =>
          form("payment").requestSubmit(),
        );
        return;
      }
      navigate(withQuery(PAYMENT_PAGES[method], { id: checkoutId, payment: payment.id }));
    });

  /**
   * Adds a submit listener to a step's form (the browser checks the native constraints first).
   * @param {CheckoutStep} step
   * @param {() => Promise<unknown>} submit
   */
  const onSubmit = (step, submit) => {
    const target = form(step);
    /** @param {Event} event */
    const listener = (event) => {
      event.preventDefault();
      submit().catch(report);
    };
    target.addEventListener("submit", listener);
    cleanups.push(() => target.removeEventListener("submit", listener));
  };
  onSubmit("travellers", submitTravellers);
  onSubmit("contacts", submitContacts);
  onSubmit("extras", submitExtras);
  onSubmit("payment", submitPayment);

  // A changed choice of extras drops a new total that waits for confirmation: it was for the previous choice.
  const onExtrasChange = (/** @type {Event} */ event) => {
    if (pendingChange && /** @type {Element} */ (event.target)?.closest?.("[data-ancillaries]")) {
      clearPendingChange();
    }
  };
  form("extras").addEventListener("change", onExtrasChange);
  cleanups.push(() => form("extras").removeEventListener("change", onExtrasChange));
  const onContactsInput = () => {
    contactsTyped = true;
  };
  form("contacts").addEventListener("input", onContactsInput);
  cleanups.push(() => form("contacts").removeEventListener("input", onContactsInput));
  const onMethodChange = () => renderPaymentNote();
  el.paymentMethodList.addEventListener("change", onMethodChange);
  cleanups.push(() => el.paymentMethodList.removeEventListener("change", onMethodChange));

  /**
   * Loads the checkout (and the countries), then shows the step of the address when it can be opened.
   * @param {{ focus?: boolean }} [options]
   */
  const load = async ({ focus = false } = {}) => {
    if (checkoutId === null) {
      return;
    }
    el.state.replaceChildren();
    el.content.hidden = true;
    el.loading.hidden = false;
    live.announce(t("checkout.loading"));
    const call = track();
    const countryList = countries
      ? Promise.resolve(countries)
      : loadCountries(client, { signal: call.signal, ...(locale ? { locale } : {}) });
    /** @type {Checkout} */
    let loaded;
    try {
      loaded = await client.checkout.get({ checkoutId }, { signal: call.signal });
    } catch (error) {
      call.done();
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (state.name === "not-found") {
        showPageState(
          { name: "not-found", scope: "inline", message: t("checkout.missing") },
          { link: t("pricePage.priceAgain"), focus },
        );
        return;
      }
      if (state.code === "CHECKOUT_EXPIRED") {
        showExpired();
        return;
      }
      showPageState(state.name === "validation" ? { ...state, message: t("state.unexpected") } : state, {
        ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => load({ focus: true }).catch(report) }),
        requestId: state.name === "unexpected" || state.name === "validation" ? requestIdOf(error) : null,
        focus,
      });
      return;
    }
    countries = await countryList;
    call.done();
    if (destroyed) {
      return;
    }
    checkout = loaded;
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
    steps = checkoutSteps(features);
    renderTravellers();
    renderContacts();
    renderRemarks();
    if (catalogue) {
      renderExtras();
    }
    el.loading.hidden = true;
    el.content.hidden = false;
    el.stepper.hidden = false;
    renderCheckout();
    const requested = new URLSearchParams(location.search).get("step");
    const step = stepToShow(requested, steps, checkout.progress);
    goTo(step, { history: step === requested ? "none" : "replace", focus });
    live.announce(t("checkout.loaded", { step: t(`checkout.step.${step}`) }));
  };

  const done = (async () => {
    if (checkoutId === null) {
      showPageState(
        { name: "not-found", scope: "inline", message: t("checkout.missing") },
        { link: t("pricePage.priceAgain"), focus: false },
      );
      return;
    }
    await load();
  })().catch(report);

  return {
    done,
    /** The step on the screen (for tests). */
    get step() {
      return current;
    },
    /** Whether a step can be opened now (for tests). */
    reachable(/** @type {unknown} */ step) {
      return isStep(step) && isReachable(step, steps, checkout?.progress);
    },
    destroy() {
      destroyed = true;
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      travellersForm?.destroy();
      contactsForm?.destroy();
      picker?.destroy();
      stepper.destroy();
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
