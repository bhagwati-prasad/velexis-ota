// The offer card of the results page (ota/frontend/docs/pages.md §4, partials/templates/offer-card.html): highlight
// tags, one row per bound (itinerary.js), the selling total and the "per adult" price, fare facts (fare family or
// cabin, included bags, refundability, changes, seats left), the flight details in a disclosure, and the link to
// `/offer.html?offer=off_…`.
//
// Prices are the API's own totals, formatted with lib/format.js: the card never adds, multiplies or converts an amount
// (README §7). Everything reaches the page through `clone()` and `fill()` (textContent and allowlisted attributes).

import { clone, fill } from "../lib/dom.js";
import { formatMoney } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { withQuery } from "../lib/url.js";
import { renderItinerary, renderSegments } from "./itinerary.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["FlightOffer"]} FlightOffer */
/** @typedef {import("@velexis/ota-sdk").Schemas["BagAllowance"]} BagAllowance */
/**
 * @typedef {import("./itinerary.js").RenderContext & { travellers: number | null }} CardContext
 * `travellers`: the number of travellers of the search (from its summary), for "Total for 3 travellers"
 */

/** How many placeholder cards the searching state shows. */
export const SKELETON_CARDS = 3;
/** "3 seats left" appears at this number of bookable seats or fewer. */
export const FEW_SEATS = 4;

/**
 * The distinct non-empty strings of a list, in order.
 * @param {Array<string | null | undefined>} values
 * @returns {string[]}
 */
const distinct = (values) => [
  ...new Set(values.filter((value) => typeof value === "string" && value !== "")),
];

/**
 * The fare of the offer: its fare families ("ECONOMY LIGHT"), else its cabins ("Economy").
 * @param {FlightOffer["summary"]} summary
 */
function fareText(summary) {
  const brands = distinct((summary.brandedFares ?? []).map((brand) => brand.label ?? brand.code));
  if (brands.length > 0) {
    return brands.join(" / ");
  }
  return distinct((summary.cabins ?? []).map((cabin) => t(`cabin.${cabin}`))).join(" / ");
}

/**
 * "1 checked bag included", "No checked bag included", or `null` when unknown.
 * @param {BagAllowance | null | undefined} bags
 */
function bagsText(bags) {
  if (!bags) {
    return null;
  }
  if (typeof bags.quantity === "number") {
    return bags.quantity > 0 ? t("offer.checkedBags", { count: bags.quantity }) : t("offer.noCheckedBag");
  }
  // A weight allowance without pieces counts as one bag.
  return typeof bags.weight === "number" && bags.weight > 0 ? t("offer.checkedBags", { count: 1 }) : null;
}

/**
 * The fare facts of an offer, as short texts (each says what it means, never by colour alone).
 * @param {FlightOffer["summary"]} summary
 * @returns {string[]}
 */
export function offerFacts(summary) {
  const seats = summary.numberOfBookableSeats;
  return [
    fareText(summary),
    bagsText(summary.includedCheckedBags),
    summary.refundable === true
      ? t("offer.refundable")
      : summary.refundable === false
        ? t("offer.nonRefundable")
        : null,
    summary.changeable === true
      ? t("offer.changeable")
      : summary.changeable === false
        ? t("offer.notChangeable")
        : null,
    typeof seats === "number" && seats > 0 && seats <= FEW_SEATS
      ? t("offer.seatsLeft", { count: seats })
      : null,
  ].filter((fact) => typeof fact === "string" && fact !== "");
}

/**
 * Appends one filled clone of `templateId` per text to `list`, and hides the list when there are none.
 * @param {Element | null} list
 * @param {string} templateId
 * @param {string[]} texts
 * @param {Document} doc
 */
function appendTexts(list, templateId, texts, doc) {
  if (!list) {
    return;
  }
  for (const text of texts) {
    list.append(fill(clone(templateId, doc), { text }));
  }
  /** @type {HTMLElement} */ (list).hidden = texts.length === 0;
}

/**
 * The card of one offer (an `<li>` for the results list).
 * @param {FlightOffer} offer
 * @param {CardContext} context
 * @returns {HTMLElement}
 */
export function renderOfferCard(offer, context) {
  const { doc, locale, travellers } = context;
  const price = formatMoney(offer.price.total, locale);
  const perAdult =
    travellers !== null && travellers > 1 && offer.price.perAdult
      ? t("offer.perAdult", { price: formatMoney(offer.price.perAdult, locale) })
      : null;
  const airlines = distinct(offer.summary.marketingCarriers ?? []).map((code) => context.airline(code));
  const card = fill(clone("tpl-offer-card", doc), {
    id: offer.id,
    label: t("offer.label", { airlines: airlines.join(", "), price }),
    price,
    priceNote: travellers === null ? null : t("offer.totalFor", { count: travellers }),
    perAdult,
    noPerAdult: perAdult === null,
    href: withQuery("/offer.html", { offer: offer.id }),
    selectLabel: t("offer.selectLabel", { price }),
  });

  appendTexts(
    card.querySelector("[data-offer-tags]"),
    "tpl-offer-tag",
    (offer.summary.tags ?? []).map((tag) => t(`offer.tag.${tag}`)),
    doc,
  );
  appendTexts(card.querySelector("[data-offer-facts]"), "tpl-offer-fact", offerFacts(offer.summary), doc);

  const rows = card.querySelector("[data-itineraries]");
  const details = card.querySelector("[data-offer-segments]");
  for (const itinerary of offer.itineraries) {
    rows?.append(renderItinerary(itinerary, context));
    details?.append(renderSegments(itinerary, context));
  }
  return card;
}

/**
 * Placeholder cards for the searching state (hidden from assistive technology; the live region speaks instead).
 * @param {Document} doc
 * @param {number} [count]
 * @returns {HTMLElement[]}
 */
export const renderSkeletons = (doc, count = SKELETON_CARDS) =>
  Array.from({ length: count }, () => clone("tpl-offer-skeleton", doc));
