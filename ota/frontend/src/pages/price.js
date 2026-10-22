// Entry module of the price page (price.html, ota/frontend/docs/pages.md §6, flow ota/docs/flows/search-and-price.md,
// SDK guide B2 §5–§6). The offer page opens it with `/price.html?priced=prc_…` after `flights.price`:
//
// 1. `flights.getPricedOffer({ pricedOfferId })`: the confirmed selling price (src/components/price-breakdown.js: per
//    traveller type, taxes, every fee line with its label, OADR-0005 point 7, and the API's total), `priceChange`,
//    the booking requirements, the conditions at a glance and `expiresAt`.
// 2. Only when `features.ancillaries` is on: `flights.getAncillaries({ pricedOfferId })`, shown as "Available in
//    checkout" with the lowest price of each kind and no selection (extras are chosen in checkout, M3). Optional: a
//    failure leaves the list out, without an error banner.
// 3. `flights.getFareRules({ pricedOfferId })` in the "Changes and refunds" disclosure. A failure keeps the rules the
//    priced offer embeds (it was priced with `detailed-fare-rules`), else says so with a Retry for the rules alone.
// 4. `priceChange.changed` shows the expected price (`oldPrice`: the results total plus the fees added at pricing, so
//    a fee never reads as a change) and the confirmed price side by side ("The airline changed the price"), and
//    Continue names the new price. A countdown from `expiresAt` (`role="timer"`, announced once five
//    minutes before and at the end) ends in "Price expired" with Re-price, back to the offer page that prices again.
// 5. Continue (enabled once the price is shown, disabled again when it expires): `checkout.create({ pricedOfferId })`
//    and `/checkout.html?id=chk_…&step=travellers` (OFE-011). Without guest checkout (`features.guestCheckout`
//    off) a visitor goes to `/account/sign-in.html?next=…` first, as after a `401` of `checkout.create`.
//
// States (pages.md §6): `410 OFFER_EXPIRED` (also a `404` priced offer, which the purge removes after it expired) as
// on the offer page, "This fare is no longer available", with a link back to the flight to price it again (else the
// home page); `503`, connection failures and `429` the shared states with Retry, which loads the price again. At
// Continue: `403 EMAIL_NOT_VERIFIED` asks to verify the e-mail address, with "Send the link again"
// (`auth.resendVerification`), and other failures show their state next to the button, with Retry where it may help.
// The address `#fare-rules` (the checkout's payment step links to it) opens the "Changes and refunds" disclosure.
// Every amount is the API's own: the page never adds, subtracts or multiplies prices.

import { boot, renderState } from "../boot.js";
import { fareName } from "../components/fare-families.js";
import { airlineLabel, itineraryTitle, renderItinerary } from "../components/itinerary.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { passengerSummary } from "../components/passenger-picker.js";
import { isZero, lowestPrice, mount as mountBreakdown } from "../components/price-breakdown.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatLocalDate, formatMoney } from "../lib/format.js";
import { withSubmitState } from "../lib/forms.js";
import { hasString, t } from "../lib/i18n.js";
import { signInHref } from "../lib/session.js";
import { currentPath, withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["PricedOffer"]} PricedOffer */
/** @typedef {import("@velexis/ota-sdk").Schemas["FlightOffer"]} FlightOffer */
/** @typedef {import("@velexis/ota-sdk").Schemas["AncillaryCatalogue"]} AncillaryCatalogue */
/** @typedef {import("@velexis/ota-sdk").Schemas["AncillaryOption"]} AncillaryOption */
/** @typedef {import("@velexis/ota-sdk").Schemas["FareRuleSet"]} FareRuleSet */
/** @typedef {import("@velexis/ota-sdk").Schemas["FareRuleSummary"]} FareRuleSummary */
/** @typedef {import("@velexis/ota-sdk").Schemas["FareRuleCategory"]} FareRuleCategory */
/** @typedef {import("@velexis/ota-sdk").Schemas["PricingBookingRequirements"]} BookingRequirements */
/** @typedef {import("@velexis/ota-sdk").Schemas["Dictionaries"]} Dictionaries */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/**
 * The SDK client as far as the page needs it: `checkout.create` for Continue, and `auth.resendVerification` when the
 * customer's e-mail address still needs verifying.
 * @typedef {Pick<VelexisClient, "flights" | "checkout"> & { auth?: Partial<Pick<VelexisClient["auth"], "resendVerification">> }} PageClient
 */
/** @typedef {{ label: string, detail: string | null }} ItemLine */
/** @typedef {{ category: string, label: string, status: string, detail: string | null }} RuleLine */

/** A priced offer id as the API writes it. */
export const PRICED_OFFER_ID = /^prc_[0-9A-Za-z]{16,40}$/;
const OFFER_ID = /^off_[0-9A-Za-z]{16,40}$/;
const CHECKOUT_ID = /^chk_[0-9A-Za-z]{16,40}$/;
/** The address of the "Changes and refunds" disclosure. */
export const FARE_RULES_HASH = "#fare-rules";
/** From how many seconds before `expiresAt` the countdown warns (announced once). */
export const EXPIRY_WARNING_SECONDS = 300;
/** States after which the same call cannot do better: no Retry. */
const FINAL_STATES = new Set([
  "suspended",
  "unknown-host",
  "supplier-not-configured",
  "feature-disabled",
  "forbidden",
  "signed-out",
  "validation",
]);
/** Traveller types counted as adults, children and infants in the summary line. */
const ADULT_TYPES = new Set(["ADULT", "SENIOR", "YOUNG", "STUDENT"]);
const INFANT_TYPES = new Set(["HELD_INFANT", "SEATED_INFANT"]);

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
 * The offer page to price this flight again: the offer page this page was opened from (a same-origin referrer at
 * `/offer.html` with a valid `offer=`, and, once known, for one of the priced offers), else the offer page of the
 * first priced offer, else `null`.
 * @param {string} referrer `document.referrer`
 * @param {string} origin the page's own origin
 * @param {ReadonlyArray<string> | null} [offerIds] the priced offers, once known
 * @returns {string | null}
 */
export function flightLink(referrer, origin, offerIds = null) {
  /** @type {URL | null} */
  let url = null;
  try {
    url = referrer ? new URL(referrer) : null;
  } catch {
    url = null;
  }
  if (url && url.origin === origin && url.pathname === "/offer.html") {
    const params = new URLSearchParams(url.search);
    const offer = params.get("offer");
    const fare = params.get("fare");
    const ours = offerIds === null || offerIds.some((id) => id === offer || (fare !== null && id === fare));
    if (offer !== null && OFFER_ID.test(offer) && ours) {
      return withQuery("/offer.html", params);
    }
  }
  const first = offerIds?.[0];
  return typeof first === "string" && OFFER_ID.test(first)
    ? withQuery("/offer.html", { offer: first })
    : null;
}

/**
 * The whole seconds left until `expiresAt` (rounded up, so the countdown reaches 0 exactly at the expiry), or `null`
 * when the timestamp cannot be read.
 * @param {unknown} expiresAt ISO 8601 timestamp
 * @param {number} now milliseconds since the epoch
 * @returns {number | null}
 */
export function secondsLeft(expiresAt, now) {
  const at = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/**
 * A countdown as "19:59", or "1:02:03" from one hour on.
 * @param {number} seconds
 */
export function countdownText(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * What the airline needs at booking, as a list for the traveller (names always; the rest as the requirements say).
 * @param {BookingRequirements | null | undefined} requirements
 * @returns {string[]}
 */
export function requirementTexts(requirements) {
  const texts = [t("requirements.names")];
  if (!requirements) {
    return texts;
  }
  const travellers = list(requirements.travelerRequirements);
  /** @param {string} key */
  const anyTraveller = (key) =>
    travellers.some((requirement) => /** @type {Record<string, unknown>} */ (requirement)[key] === true);
  /** @type {Array<[boolean | undefined, string]>} */
  const rules = [
    [requirements.emailAddressRequired, "requirements.email"],
    [requirements.mobilePhoneNumberRequired, "requirements.mobilePhone"],
    [!requirements.mobilePhoneNumberRequired && requirements.phoneNumberRequired, "requirements.phone"],
    [anyTraveller("dateOfBirthRequired"), "requirements.dateOfBirth"],
    [anyTraveller("genderRequired"), "requirements.gender"],
    [anyTraveller("documentRequired"), "requirements.document"],
    [anyTraveller("documentIssuanceCityRequired"), "requirements.documentCity"],
    [anyTraveller("residenceRequired"), "requirements.residence"],
    [anyTraveller("redressRequiredIfAny"), "requirements.redress"],
    [anyTraveller("spanishResidentDiscountRequired"), "requirements.spanishResident"],
    [anyTraveller("airFranceDiscountRequired"), "requirements.airFranceDiscount"],
    [requirements.postalCodeRequired, "requirements.postalCode"],
    [requirements.invoiceAddressRequired, "requirements.invoiceAddress"],
    [requirements.mailingAddressRequired, "requirements.mailingAddress"],
  ];
  for (const [required, key] of rules) {
    if (required === true) {
      texts.push(t(key));
    }
  }
  return texts;
}

/**
 * The extras the checkout sells, one line per kind with its lowest price ("Extra checked bags", "from €35.00"):
 * checked and cabin bags, each other service (priority boarding, …), and seats only where the storefront offers seat
 * selection (`features.seatSelection`, off in the MVP). Nothing to choose here.
 * @param {AncillaryCatalogue | null | undefined} catalogue
 * @param {{ locale?: string, seats?: boolean }} [options]
 * @returns {ItemLine[]}
 */
export function extrasLines(catalogue, { locale, seats = false } = {}) {
  if (!catalogue) {
    return [];
  }
  /** @type {ItemLine[]} */
  const lines = [];
  /**
   * @param {string} label
   * @param {AncillaryOption[]} options
   */
  const add = (label, options) => {
    if (options.length === 0) {
      return;
    }
    const lowest = lowestPrice(options.map((option) => option.price));
    lines.push({ label, detail: lowest ? t("extras.from", { price: formatMoney(lowest, locale) }) : null });
  };
  add(t("extras.checkedBags"), list(catalogue.checkedBags));
  add(t("extras.cabinBags"), list(catalogue.cabinBags));
  /** @type {Map<string, AncillaryOption[]>} */
  const services = new Map();
  for (const option of /** @type {AncillaryOption[]} */ (list(catalogue.otherServices))) {
    const key = String(option.serviceName ?? option.name);
    services.set(key, [...(services.get(key) ?? []), option]);
  }
  for (const [key, options] of services) {
    const own = /** @type {AncillaryOption} */ (options[0]).label;
    const label = hasString(`extras.service.${key}`)
      ? t(`extras.service.${key}`)
      : typeof own === "string" && own.trim() !== ""
        ? own.trim()
        : key;
    add(label, options);
  }
  if (seats && catalogue.seatsSupported === true && list(catalogue.seats).length > 0) {
    lines.push({ label: t("extras.seats"), detail: null });
  }
  return lines;
}

/**
 * A condition at a glance: allowed (free, or with its maximum fee per traveller), not allowed, or not known.
 * @param {boolean | null | undefined} allowed
 * @param {Money | null | undefined} penalty
 * @param {string | undefined} locale
 */
function conditionText(allowed, penalty, locale) {
  if (allowed === false) {
    return t("rules.notAllowed");
  }
  if (allowed !== true) {
    return t("rules.unknown");
  }
  if (!penalty) {
    return t("rules.allowed");
  }
  return isZero(penalty) ? t("rules.free") : t("rules.feeUpTo", { price: formatMoney(penalty, locale) });
}

/**
 * The refund and change lines of a fare rule summary.
 * @param {FareRuleSummary | null | undefined} summary
 * @param {string | undefined} [locale]
 * @returns {RuleLine[]}
 */
export function summaryLines(summary, locale) {
  if (!summary) {
    return [];
  }
  return [
    {
      category: "REFUND",
      label: t("rules.label", { label: t("rules.refund") }),
      status: conditionText(summary.refundable, summary.refundPenalty, locale),
      detail: null,
    },
    {
      category: "EXCHANGE",
      label: t("rules.label", { label: t("rules.change") }),
      status: conditionText(summary.changeable, summary.changePenalty, locale),
      detail: null,
    },
  ];
}

/**
 * One line per rule category of the airline: allowed or not, its fee, its circumstances and texts (airline text, as
 * it is).
 * @param {ReadonlyArray<FareRuleCategory> | null | undefined} categories
 * @param {string | undefined} [locale]
 * @returns {RuleLine[]}
 */
export function categoryLines(categories, locale) {
  return list(categories).map((/** @type {FareRuleCategory} */ rule) => {
    const name = hasString(`rules.category.${rule.category}`)
      ? t(`rules.category.${rule.category}`)
      : String(rule.category);
    let status = t("rules.allowed");
    if (rule.applicable === false) {
      status = t("rules.notAllowed");
    } else if (rule.chargeable === true) {
      status =
        rule.maxPenalty && !isZero(rule.maxPenalty)
          ? t("rules.categoryFeeUpTo", { price: formatMoney(rule.maxPenalty, locale) })
          : t("rules.forFee");
    } else if (rule.chargeable === false) {
      status = t("rules.free");
    }
    const texts = [
      rule.circumstances,
      ...list(rule.texts).map((/** @type {{ text?: unknown }} */ text) => text?.text),
    ].filter((text) => typeof text === "string" && text.trim() !== "");
    return {
      category: String(rule.category),
      label: t("rules.label", { label: name }),
      status,
      detail: texts.length > 0 ? texts.join("\n") : null,
    };
  });
}

/**
 * Runs the price page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page has
 * no price area, else `{ done, destroy }`: `done` settles once the price (or a state), its extras and its fare rules
 * are shown.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, referrer?: string, navigate?: (url: string) => void }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-price-page]"));
  if (!main) {
    return null;
  }
  const location = env.location ?? doc.defaultView?.location ?? globalThis.location;
  const referrer = env.referrer ?? doc.referrer;
  const navigate = env.navigate ?? ((/** @type {string} */ url) => location.assign(url));
  const { config, client } = context;
  const session = context.session ?? null;
  const locale = config?.defaultLocale;
  const support = config?.support ?? null;
  const features = config?.features;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const el = {
    back: /** @type {HTMLAnchorElement | null} */ (main.querySelector("a[data-back-link]")),
    title: find("[data-price-title]"),
    summary: find("[data-price-summary]"),
    state: find("[data-price-state]"),
    loading: find("[data-price-loading]"),
    content: find("[data-price-content]"),
    changed: find("[data-price-changed]"),
    oldPrice: find("[data-price-old]"),
    newPrice: find("[data-price-new]"),
    difference: find("[data-price-difference]"),
    itineraries: find("[data-price-itineraries]"),
    fare: find("[data-price-fare]"),
    breakdown: find("[data-price-breakdown]"),
    extras: find("[data-price-extras]"),
    extrasList: find("[data-price-extras-list]"),
    requirements: find("[data-price-requirements]"),
    requirementsList: find("[data-price-requirements-list]"),
    rulesLoading: find("[data-rules-loading]"),
    rulesSummary: find("[data-rules-summary]"),
    rulesCategories: find("[data-rules-categories]"),
    rulesUnavailable: find("[data-rules-unavailable]"),
    rulesNotes: find("[data-rules-notes]"),
    rulesNotesList: find("[data-rules-notes-list]"),
    rulesState: find("[data-rules-state]"),
    total: find("[data-price-total]"),
    totalNote: find("[data-price-total-note]"),
    conditions: find("[data-price-conditions]"),
    countdown: find("[data-price-countdown]"),
    expired: find("[data-price-expired]"),
    continue: /** @type {HTMLButtonElement} */ (main.querySelector("button[data-continue]")),
    continueForm: /** @type {HTMLFormElement} */ (main.querySelector("form[data-continue-form]")),
    continueState: find("[data-continue-state]"),
    fareRules: /** @type {HTMLDetailsElement | null} */ (main.querySelector("details[data-fare-rules]")),
  };
  const pageTitle = doc.title;

  const idParam = new URLSearchParams(location.search).get("priced");
  const pricedOfferId = idParam !== null && PRICED_OFFER_ID.test(idParam) ? idParam : null;
  /** The link to price the flight again (the offer page), once known. */
  let flight = flightLink(referrer, location.origin);
  /** Airport and airline names by code, from the dictionaries and the flights. @type {Map<string, string>} */
  const places = new Map();
  /** @type {Map<string, string>} */
  const airlines = new Map();
  /** Running calls, aborted by destroy. @type {Set<AbortController>} */
  const controllers = new Set();
  /** The countdown's next tick. @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** The priced offer on the screen, once loaded. @type {PricedOffer | null} */
  let shown = null;
  let destroyed = false;
  const breakdown = mountBreakdown(el.breakdown, locale ? { locale } : {});

  /** @param {string} code */
  const place = (code) => {
    const name = places.get(code);
    return name ? t("results.place", { name, code }) : code;
  };
  /** @param {string} code */
  const airline = (code) => airlineLabel(code, airlines.get(code));

  /** A new AbortController for a call, forgotten once the call settled. */
  const track = () => {
    const controller = new AbortController();
    controllers.add(controller);
    return {
      signal: controller.signal,
      done: () => controllers.delete(controller),
    };
  };

  const renderBackLink = () => {
    if (el.back) {
      el.back.href = flight ?? "/";
      el.back.hidden = flight === null;
    }
  };
  renderBackLink();

  /** Learns place and airline names from dictionaries and flights. */
  const learn = (
    /** @type {Dictionaries | null | undefined} */ dictionaries,
    /** @type {ReadonlyArray<FlightOffer>} */ offers,
  ) => {
    for (const [code, entry] of Object.entries(dictionaries?.locations ?? {})) {
      const name = entry?.airportName ?? entry?.cityName;
      if (typeof name === "string" && name !== "" && !places.has(code)) {
        places.set(code, name);
      }
    }
    for (const [code, carrier] of Object.entries(dictionaries?.carriers ?? {})) {
      if (typeof carrier?.name === "string" && carrier.name !== "" && !airlines.has(code)) {
        airlines.set(code, carrier.name);
      }
    }
    for (const segment of offers.flatMap((offer) => list(offer.itineraries).flatMap((it) => it.segments))) {
      if (
        typeof segment.carrierName === "string" &&
        segment.carrierName !== "" &&
        !airlines.has(segment.carrierCode)
      ) {
        airlines.set(segment.carrierCode, segment.carrierName);
      }
    }
  };

  /**
   * A link under a state: back to the flight to price it again, or the home page.
   * @param {HTMLElement} element the state
   * @param {string} label the link's text when it leads to the flight
   */
  const addLink = (element, label) => {
    const link = fill(clone("tpl-state-link", doc), {
      label: flight === null ? t("offerPage.searchFlights") : label,
      href: flight ?? "/",
    });
    const retry = element.querySelector('[data-action="retry"]')?.closest("p");
    if (retry) {
      retry.before(link);
    } else {
      element.append(link);
    }
  };

  /** @param {unknown} error */
  const requestIdOf = (error) =>
    error instanceof Error && "requestId" in error
      ? String(/** @type {{ requestId: unknown }} */ (error).requestId ?? "") || null
      : null;

  /** A state for a failure the page has no own state for: validation reads as "Something went wrong". */
  const stateOf = (/** @type {unknown} */ error) => {
    const state = pageStateFor(error);
    return state.name === "validation" ? { ...state, message: t("state.unexpected") } : state;
  };

  /**
   * Replaces the price with a state (the price cannot be used, or never loaded).
   * @param {Pick<PageState, "name" | "message" | "scope"> & Partial<PageState>} state
   * @param {{ link?: string, onRetry?: () => void, requestId?: string | null, focus?: boolean }} [options]
   */
  const showPageState = (state, { link, onRetry, requestId = null, focus = false } = {}) => {
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
      addLink(element, link);
    }
    live.announce(state.message);
  };

  /** The trip line: the route, the date of each bound and the travellers. */
  const renderSummary = (/** @type {PricedOffer} */ priced) => {
    const offer = list(priced.offers)[0];
    if (!offer) {
      el.summary.textContent = "";
      return;
    }
    const { summary } = offer;
    const from = place(summary.originCode);
    const to = place(summary.destinationCode);
    const route =
      summary.tripType === "multi_city"
        ? t("offerPage.titleMulti")
        : t(summary.tripType === "round_trip" ? "offerPage.titleReturn" : "offerPage.title", { from, to });
    const parts = [
      route,
      ...list(offer.itineraries).map((itinerary) =>
        t("offerPage.boundDate", {
          title: itineraryTitle(itinerary.index, summary.tripType),
          date: formatLocalDate(itinerary.departureAt, locale),
        }),
      ),
    ];
    const pricings = list(offer.travelerPricings);
    if (pricings.length > 0) {
      const count = (/** @type {(type: string) => boolean} */ match) =>
        pricings.filter((pricing) => match(String(pricing.travelerType))).length;
      parts.push(
        passengerSummary({
          adults: count((type) => ADULT_TYPES.has(type)),
          children: count((type) => type === "CHILD"),
          infants: count((type) => INFANT_TYPES.has(type)),
        }),
      );
    }
    el.summary.textContent = parts.join(t("results.separator"));
  };

  /** The bounds of the priced flights and the fare's name. */
  const renderFlights = (/** @type {PricedOffer} */ priced) => {
    const offers = list(priced.offers);
    el.itineraries.replaceChildren(
      ...offers.flatMap((offer) =>
        list(offer.itineraries).map((itinerary) =>
          renderItinerary(itinerary, { doc, locale, tripType: offer.summary.tripType, airline, place }),
        ),
      ),
    );
    const names = [...new Set(offers.map((offer) => fareName(offer.summary)))];
    el.fare.textContent = names.length > 0 ? t("pricePage.fare", { name: names.join(" / ") }) : "";
  };

  /**
   * "The airline changed the price": the expected price and the confirmed price, side by side. The API's `oldPrice`
   * is the results total plus the fees added at pricing (OADR-0005 point 7), not the total the results showed, so the
   * page calls it the expected price.
   */
  const renderPriceChange = (/** @type {PricedOffer} */ priced) => {
    const change = priced.priceChange;
    const changed = change?.changed === true;
    el.changed.hidden = !changed;
    el.continue.textContent = changed
      ? t("pricePage.continueNewPrice", { price: formatMoney(change.newPrice, locale) })
      : t("pricePage.continue");
    if (!changed) {
      return;
    }
    el.oldPrice.textContent = formatMoney(change.oldPrice, locale);
    el.newPrice.textContent = formatMoney(change.newPrice, locale);
    const amount = change.difference?.amount;
    // The direction comes from the API, the amount is its `difference` without the sign: nothing is computed.
    el.difference.textContent =
      typeof amount === "string" && (change.direction === "up" || change.direction === "down")
        ? t(change.direction === "up" ? "pricePage.more" : "pricePage.less", {
            amount: formatMoney(
              { amount: amount.replace(/^-/, ""), currency: change.difference.currency },
              locale,
            ),
          })
        : "";
  };

  /** The total box: the API's total, the travellers it is for, the refund and change conditions at a glance. */
  const renderTotal = (/** @type {PricedOffer} */ priced) => {
    el.total.textContent = formatMoney(priced.price.total, locale);
    const travellers =
      list(priced.price.breakdown?.travelers).length || list(list(priced.offers)[0]?.travelerPricings).length;
    el.totalNote.textContent = travellers > 0 ? t("offer.totalFor", { count: travellers }) : "";
    const conditions = priced.conditions;
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
    el.conditions.replaceChildren(...facts.map((text) => fill(clone("tpl-text-item", doc), { text })));
  };

  const renderRequirements = (/** @type {PricedOffer} */ priced) => {
    const texts = requirementTexts(priced.bookingRequirements);
    el.requirementsList.replaceChildren(...texts.map((text) => fill(clone("tpl-text-item", doc), { text })));
    el.requirements.hidden = texts.length === 0;
  };

  /** "Price expired" with Re-price: the offer page, which prices the flight again. */
  const expire = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    el.countdown.hidden = true;
    el.countdown.textContent = "";
    el.continue.disabled = true;
    el.continueState.replaceChildren();
    const element = renderState(el.expired, {
      // A state of this page only: no error code maps to it (lib/errors.js names the states of SDK errors), and its
      // name gives it its own hint (`stateHint.price-expired`) and `data-state`.
      name: /** @type {PageState["name"]} */ (/** @type {unknown} */ ("price-expired")),
      scope: "inline",
      message: t("pricePage.expired"),
    });
    addLink(element, t("pricePage.reprice"));
  };

  /**
   * The countdown from `expiresAt`: updated every second ("Price held for 19:59"), announced once when five minutes
   * or less are left, then "Price expired". An unreadable `expiresAt` shows no countdown. Returns what the first tick
   * would announce (the page announces it with the price), or `null`.
   * @param {PricedOffer} priced
   * @returns {string | null}
   */
  const startCountdown = (priced) => {
    let warned = false;
    /** @param {boolean} first */
    const tick = (first) => {
      timer = null;
      if (destroyed) {
        return null;
      }
      const now = Date.now();
      const left = secondsLeft(priced.expiresAt, now);
      if (left === null) {
        el.countdown.hidden = true;
        return null;
      }
      /** @type {string | null} */
      let message = null;
      if (left <= 0 || priced.status === "expired") {
        expire();
        message = t("pricePage.expired");
      } else {
        el.countdown.textContent = t("pricePage.heldFor", { time: countdownText(left) });
        el.countdown.hidden = false;
        if (left <= EXPIRY_WARNING_SECONDS && !warned) {
          warned = true;
          el.countdown.dataset.expiring = "";
          message = t("pricePage.expiringSoon", { count: Math.ceil(EXPIRY_WARNING_SECONDS / 60) });
        }
        // The next tick when the shown second changes: once the time left is (left - 1) whole seconds.
        const remaining = Date.parse(priced.expiresAt) - now;
        timer = setTimeout(() => tick(false), Math.max(1, remaining - (left - 1) * 1000));
      }
      if (message !== null && !first) {
        live.announce(message);
      }
      return message;
    };
    if (timer !== null) {
      clearTimeout(timer);
    }
    el.expired.replaceChildren();
    delete el.countdown.dataset.expiring;
    return tick(true);
  };

  /** @param {ItemLine[]} lines */
  const renderExtras = (lines) => {
    el.extrasList.replaceChildren(
      ...lines.map((line) => fill(clone("tpl-price-item", doc), { ...line, noDetail: line.detail === null })),
    );
    el.extras.hidden = lines.length === 0;
  };

  /**
   * "Available in checkout", only when the storefront sells extras. Optional: a failure leaves the list out.
   * @param {PricedOffer} priced
   */
  const loadExtras = async (priced) => {
    if (features?.ancillaries !== true || typeof client.flights.getAncillaries !== "function") {
      renderExtras([]);
      return;
    }
    const call = track();
    /** @type {AncillaryCatalogue | null} */
    let catalogue;
    try {
      catalogue = await client.flights.getAncillaries({ pricedOfferId: priced.id }, { signal: call.signal });
    } catch {
      catalogue = null;
    } finally {
      call.done();
    }
    if (destroyed) {
      return;
    }
    renderExtras(
      extrasLines(catalogue, { ...(locale ? { locale } : {}), seats: features?.seatSelection === true }),
    );
  };

  /** @param {RuleLine[]} lines */
  const ruleItems = (lines) =>
    lines.map((line) => fill(clone("tpl-rule", doc), { ...line, noDetail: line.detail === null }));

  /**
   * The "Changes and refunds" disclosure: the conditions at a glance, the airline's rule categories and its fare
   * notes.
   * @param {FareRuleSet | null} rules
   * @param {FareRuleSummary | null | undefined} fallback the priced offer's conditions, while no rules are known
   */
  const renderRules = (rules, fallback) => {
    el.rulesSummary.replaceChildren(...ruleItems(summaryLines(rules?.summary ?? fallback, locale)));
    el.rulesCategories.replaceChildren(...ruleItems(categoryLines(rules?.categories, locale)));
    const notes = list(rules?.fareComponents).filter((component) => list(component.notes).length > 0);
    el.rulesNotesList.replaceChildren(
      ...notes.map((component) => {
        const name = [component.name, component.category].find(
          (text) => typeof text === "string" && text.trim() !== "",
        );
        const title =
          name && component.fareBasis
            ? t("rules.noteTitle", { name, fareBasis: component.fareBasis })
            : (name ?? component.fareBasis ?? component.key);
        const element = fill(clone("tpl-rule-note", doc), { title });
        /** @type {HTMLElement} */ (element.querySelector("[data-rule-note-texts]")).replaceChildren(
          ...list(component.notes)
            .filter((note) => typeof note?.text === "string" && note.text.trim() !== "")
            .map((note) => fill(clone("tpl-rule-text", doc), { text: note.text })),
        );
        return element;
      }),
    );
    el.rulesNotes.hidden = notes.length === 0;
    el.rulesUnavailable.hidden = rules?.available !== false;
  };

  /**
   * Loads the fare rules into the disclosure. A failure keeps the rules the priced offer embeds, else shows a
   * message with a Retry for the rules alone.
   * @param {PricedOffer} priced
   */
  const loadRules = async (priced) => {
    el.rulesState.replaceChildren();
    el.rulesLoading.hidden = Boolean(priced.fareRules);
    const call = track();
    /** @type {FareRuleSet | null} */
    let rules = null;
    /** @type {unknown} */
    let failure = null;
    try {
      rules = await client.flights.getFareRules({ pricedOfferId: priced.id }, { signal: call.signal });
    } catch (error) {
      failure = error;
    } finally {
      call.done();
    }
    if (destroyed || (failure !== null && isAborted(failure))) {
      return;
    }
    el.rulesLoading.hidden = true;
    if (failure === null || priced.fareRules) {
      renderRules(rules ?? priced.fareRules ?? null, priced.conditions);
      return;
    }
    const state = stateOf(failure);
    // A priced offer that expired or vanished meanwhile has no rules to load any more: no Retry.
    const final =
      FINAL_STATES.has(state.name) || state.name === "offer-expired" || state.name === "not-found";
    renderRules(null, priced.conditions);
    renderState(
      el.rulesState,
      { ...state, scope: "inline", message: t("rules.failed") },
      {
        support,
        requestId: state.name === "unexpected" ? requestIdOf(failure) : null,
        ...(final ? {} : { onRetry: () => loadRules(priced).catch(report) }),
      },
    );
  };

  const render = (/** @type {PricedOffer} */ priced) => {
    learn(priced.dictionaries, list(priced.offers));
    for (const offer of list(priced.offers)) {
      learn(offer.dictionaries, [offer]);
    }
    doc.title = pageTitle;
    renderSummary(priced);
    renderPriceChange(priced);
    renderFlights(priced);
    breakdown.update({ price: priced.price });
    renderTotal(priced);
    renderRequirements(priced);
    renderRules(priced.fareRules ?? null, priced.conditions);
    shown = priced;
    el.continue.disabled = false;
    el.continueState.replaceChildren();
    el.state.replaceChildren();
    el.loading.hidden = true;
    el.content.hidden = false;
    if (location.hash === FARE_RULES_HASH && el.fareRules) {
      el.fareRules.open = true;
      el.fareRules.scrollIntoView?.();
    }
  };

  /**
   * `403 EMAIL_NOT_VERIFIED` at Continue: "Verify your e-mail address to book", with "Send the link again" when the
   * SDK has `auth.resendVerification`.
   */
  const showVerifyEmail = () => {
    const element = renderState(
      el.continueState,
      { name: "email-not-verified", scope: "inline", message: t("pricePage.verifyEmail") },
      { focus: true },
    );
    live.announce(t("pricePage.verifyEmail"));
    const resend = client.auth?.resendVerification;
    if (typeof resend !== "function") {
      return;
    }
    const button = doc.createElement("button");
    button.type = "button";
    button.className =
      "mt-4 rounded-ui bg-primary px-4 py-2 font-medium text-on-primary hover:opacity-90 disabled:opacity-60";
    button.textContent = t("pricePage.resend");
    button.dataset.action = "resend";
    const message = doc.createElement("p");
    message.className = "mt-2 text-sm";
    message.setAttribute("role", "status");
    message.dataset.resendStatus = "";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await resend.call(client.auth, { returnPath: currentPath(location) });
        message.textContent = t("pricePage.resent");
        button.remove();
      } catch {
        message.textContent = t("pricePage.resendFailed");
        button.disabled = false;
      }
    });
    element.append(button, message);
  };

  /**
   * Continue: opens the checkout of the priced offer (`checkout.create`) and goes to its travellers step. Without guest
   * checkout, a visitor signs in first and comes back to this page.
   */
  const startCheckout = () =>
    withSubmitState(el.continueForm, async () => {
      const priced = shown;
      if (!priced || destroyed || el.continue.disabled) {
        return;
      }
      el.continueState.replaceChildren();
      if (features?.guestCheckout === false && session === null) {
        navigate(signInHref(location));
        return;
      }
      live.announce(t("pricePage.opening"));
      /** @type {{ id: string }} */
      let checkout;
      try {
        checkout = await client.checkout.create({ pricedOfferId: priced.id });
      } catch (error) {
        if (destroyed || isAborted(error)) {
          return;
        }
        const state = stateOf(error);
        if (state.name === "signed-out") {
          navigate(signInHref(location));
          return;
        }
        if (state.name === "offer-expired" || state.name === "not-found") {
          showPageState(
            { name: "offer-expired", scope: "inline", message: t("state.offer-expired") },
            { link: t("pricePage.priceAgain"), focus: true },
          );
          return;
        }
        if (state.name === "email-not-verified") {
          showVerifyEmail();
          return;
        }
        renderState(el.continueState, state, {
          support,
          focus: true,
          requestId: state.name === "unexpected" ? requestIdOf(error) : null,
          ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => startCheckout().catch(report) }),
        });
        live.announce(state.message);
        return;
      }
      if (destroyed) {
        return;
      }
      if (typeof checkout?.id !== "string" || !CHECKOUT_ID.test(checkout.id)) {
        renderState(
          el.continueState,
          { name: "unexpected", scope: "inline", message: t("state.unexpected") },
          { support, focus: true, onRetry: () => startCheckout().catch(report) },
        );
        return;
      }
      navigate(withQuery("/checkout.html", { id: checkout.id, step: "travellers" }));
    });

  /** @param {Event} event */
  const onContinue = (event) => {
    event.preventDefault();
    startCheckout().catch(report);
  };
  el.continueForm.addEventListener("submit", onContinue);

  /**
   * Loads the priced offer, then its extras and fare rules.
   * @param {{ focus?: boolean }} [options] `focus` moves the focus to what follows a Retry
   */
  const load = async ({ focus = false } = {}) => {
    el.state.replaceChildren();
    el.content.hidden = true;
    el.loading.hidden = false;
    live.announce(t("pricePage.loading"));
    const call = track();
    /** @type {PricedOffer} */
    let priced;
    try {
      priced = await client.flights.getPricedOffer(
        { pricedOfferId: /** @type {string} */ (pricedOfferId) },
        { signal: call.signal },
      );
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = stateOf(error);
      if (state.name === "offer-expired" || state.name === "not-found") {
        showPageState(
          { name: "offer-expired", scope: "inline", message: t("state.offer-expired") },
          { link: t("pricePage.priceAgain"), focus },
        );
        return;
      }
      showPageState(state, {
        ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => load({ focus: true }).catch(report) }),
        requestId: state.name === "unexpected" ? requestIdOf(error) : null,
        focus,
      });
      return;
    } finally {
      call.done();
    }
    if (destroyed) {
      return;
    }
    flight = flightLink(referrer, location.origin, list(priced.offerIds)) ?? flight;
    renderBackLink();
    render(priced);
    const expiry = startCountdown(priced);
    const change = priced.priceChange;
    const loaded =
      change?.changed === true
        ? t("pricePage.changed", {
            old: formatMoney(change.oldPrice, locale),
            new: formatMoney(change.newPrice, locale),
          })
        : t("pricePage.loaded", { price: formatMoney(priced.price.total, locale) });
    live.announce(expiry === null ? loaded : `${loaded}. ${expiry}`);
    if (focus) {
      el.title.tabIndex = -1;
      el.title.focus();
    }
    await Promise.all([loadExtras(priced), loadRules(priced)]);
  };

  const done = (async () => {
    if (pricedOfferId === null) {
      showPageState(
        { name: "not-found", scope: "inline", message: t("pricePage.missing") },
        { link: t("pricePage.priceAgain") },
      );
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
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      el.continueForm.removeEventListener("submit", onContinue);
      breakdown.destroy();
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
