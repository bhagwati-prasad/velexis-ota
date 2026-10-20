// The fare families of the offer page (ota/frontend/docs/pages.md §5, partials/templates/fare-family.html): one card per
// fare of the same flights, each with its name, its total, the difference to the fare chosen on the results page and
// what it includes (bags, changes, refunds, seats, meals … as the API returns them). Several fares are a radio group
// (`name="fare"`) inside the page's fare form; a single fare (no upsell, or an upsell that failed or found nothing) is
// shown as the one card, without a radio button.
//
// - `familiesFromUpsell(upsell)` reads `flights.upsell`'s side-by-side comparison: its columns (base offer first, then
//   the airline's other fare families by price) and its rows (one per feature, one cell per column).
// - `familyFromOffer(offer)` describes the offer's own fare from its summary and the amenities of its lead traveller.
//
// Prices and differences are the API's own amounts, formatted with lib/format.js; nothing is added or subtracted here
// (README §7). A feature's status is always written out ("Included", "For a fee", …), never shown by colour alone.

import { clone, fill } from "../lib/dom.js";
import { formatMoney } from "../lib/format.js";
import { t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["FlightOffer"]} FlightOffer */
/** @typedef {import("@velexis/ota-sdk").Schemas["UpsellResult"]} UpsellResult */
/** @typedef {import("@velexis/ota-sdk").Schemas["BagAllowance"]} BagAllowance */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {"included" | "chargeable" | "not_offered" | "unknown"} FeatureStatus */
/**
 * One feature of a fare.
 * @typedef {object} FareFeature
 * @property {string} label what it is ("Checked bags", "Refund", an amenity text of the airline)
 * @property {FeatureStatus} status
 * @property {string | null} detail a short detail ("1 bag of 23 kg", "Fee from €70")
 */
/**
 * One fare family, as the cards show it.
 * @typedef {object} FareFamily
 * @property {string} offerId the offer to price for this fare (`off_…`)
 * @property {string} name the fare family ("ECONOMY FLEX"), else the cabin
 * @property {Money} price the API's selling total of the offer
 * @property {Money | null} difference the API's difference to the base fare (`null` for the base fare)
 * @property {boolean} isBase whether this is the fare chosen on the results page
 * @property {FareFeature[]} features
 */

/** The statuses of a comparison cell; anything else counts as `unknown`. */
const STATUSES = new Set(["included", "chargeable", "not_offered", "unknown"]);
/** Traveller types that stand for the offer (the API's lead traveller of the comparison). */
const ADULT_TYPES = new Set(["ADULT", "SENIOR", "YOUNG", "STUDENT"]);
/** A decimal amount of zero ("0", "0.00", "-0.00"). */
const ZERO = /^-?0+(?:\.0+)?$/;

/**
 * The distinct non-empty strings of a list, in order.
 * @param {Array<string | null | undefined>} values
 * @returns {string[]}
 */
const distinct = (values) => [
  ...new Set(values.filter((value) => typeof value === "string" && value.trim() !== "")),
];

/**
 * A bag allowance as text: "1 bag of 23 kg", "2 bags", "20 kg in total", "None", or `null` when unknown.
 * @param {BagAllowance | null | undefined} bags
 * @returns {string | null}
 */
export function bagText(bags) {
  if (!bags) {
    return null;
  }
  const quantity = typeof bags.quantity === "number" ? bags.quantity : null;
  const weight = typeof bags.weight === "number" && bags.weight > 0 ? bags.weight : null;
  const unit =
    typeof bags.weightUnit === "string" && bags.weightUnit.trim() !== ""
      ? bags.weightUnit.trim().toLowerCase()
      : "kg";
  if (quantity !== null && quantity > 0) {
    return weight === null
      ? t("bags.pieces", { count: quantity })
      : t("bags.piecesWeight", { count: quantity, weight, unit });
  }
  if (weight !== null) {
    return t("bags.weight", { weight, unit });
  }
  return quantity === 0 ? t("bags.none") : null;
}

/**
 * The feature of a bag allowance: included with its detail, not included (none), or unknown.
 * @param {string} label
 * @param {BagAllowance | null | undefined} bags
 * @returns {FareFeature}
 */
function bagFeature(label, bags) {
  const text = bagText(bags);
  if (text === null) {
    return { label, status: "unknown", detail: null };
  }
  return text === t("bags.none")
    ? { label, status: "not_offered", detail: null }
    : { label, status: "included", detail: text };
}

/**
 * The feature of a known (or unknown) condition: refundable, changeable.
 * @param {string} label
 * @param {boolean | null | undefined} known
 * @returns {FareFeature}
 */
const conditionFeature = (label, known) => ({
  label,
  status: known === true ? "included" : known === false ? "not_offered" : "unknown",
  detail: null,
});

/**
 * The name of an offer's fare: its fare families ("ECONOMY FLEX"), else its cabins ("Economy"), else "Your fare".
 * @param {FlightOffer["summary"]} summary
 */
export function fareName(summary) {
  const brands = distinct((summary.brandedFares ?? []).map((brand) => brand.label ?? brand.code));
  if (brands.length > 0) {
    return brands.join(" / ");
  }
  const cabins = distinct((summary.cabins ?? []).map((cabin) => t(`cabin.${cabin}`)));
  return cabins.length > 0 ? cabins.join(" / ") : t("fares.fare");
}

/**
 * The offer's own fare as one family: its total, its bags, refund and change from the summary, then the amenities
 * of its lead traveller as the airline names them (each once, included or for a fee).
 * @param {FlightOffer} offer
 * @returns {FareFamily}
 */
export function familyFromOffer(offer) {
  const { summary } = offer;
  /** @type {FareFeature[]} */
  const features = [bagFeature(t("fares.checkedBags"), summary.includedCheckedBags)];
  if (summary.includedCabinBags) {
    features.push(bagFeature(t("fares.cabinBag"), summary.includedCabinBags));
  }
  features.push(
    conditionFeature(t("fares.refund"), summary.refundable),
    conditionFeature(t("fares.change"), summary.changeable),
  );
  const pricings = offer.travelerPricings ?? [];
  const lead = pricings.find((pricing) => ADULT_TYPES.has(pricing.travelerType)) ?? pricings[0];
  const seen = new Set();
  for (const segment of lead?.segments ?? []) {
    for (const amenity of segment.amenities ?? []) {
      const label = typeof amenity.description === "string" ? amenity.description.trim() : "";
      if (label === "" || seen.has(label.toUpperCase())) {
        continue;
      }
      seen.add(label.toUpperCase());
      features.push({
        label,
        status: amenity.status === "chargeable" ? "chargeable" : "included",
        detail: null,
      });
    }
  }
  return {
    offerId: offer.id,
    name: fareName(summary),
    price: offer.price.total,
    difference: null,
    isBase: true,
    features,
  };
}

/**
 * The fare families of an upsell: one per comparison column (base offer first), each with one feature per row. An
 * upsell with fewer than two columns (the airline publishes no other fare) gives no families.
 * @param {UpsellResult | null | undefined} upsell
 * @returns {FareFamily[]}
 */
export function familiesFromUpsell(upsell) {
  const columns = Array.isArray(upsell?.comparison?.columns) ? upsell.comparison.columns : [];
  const rows = Array.isArray(upsell?.comparison?.rows) ? upsell.comparison.rows : [];
  const usable = columns.filter(
    (column) => typeof column?.offerId === "string" && column.offerId !== "" && column.price,
  );
  if (usable.length < 2) {
    return [];
  }
  return usable.map((column) => {
    const index = columns.indexOf(column);
    const cabin = typeof column.cabin === "string" ? t(`cabin.${column.cabin}`) : null;
    return {
      offerId: column.offerId,
      name: distinct([column.brandedFareLabel, column.brandedFare, cabin, t("fares.fare")])[0] ?? "",
      price: column.price,
      difference: column.isBaseOffer ? null : (column.priceDifference ?? null),
      isBase: column.isBaseOffer === true,
      features: rows
        .filter((row) => typeof row?.label === "string" && row.label.trim() !== "")
        .map((row) => {
          const values = Array.isArray(row.values) ? row.values : [];
          const cell = values.find((value) => value?.offerId === column.offerId) ?? values[index];
          const status = /** @type {FeatureStatus} */ (
            STATUSES.has(String(cell?.status)) ? cell?.status : "unknown"
          );
          const detail = typeof cell?.detail === "string" && cell.detail.trim() !== "" ? cell.detail : null;
          return { label: row.label.trim(), status, detail };
        }),
    };
  });
}

/**
 * How a fare compares with the base fare: "Your fare from the results", "€45.00 more", "€10.00 less", "Same price".
 * The amount is the API's `priceDifference`; its sign is read from the text, never computed.
 * @param {FareFamily} family
 * @param {string | undefined} locale
 */
export function differenceText(family, locale) {
  if (family.isBase || !family.difference || typeof family.difference.amount !== "string") {
    return family.isBase ? t("fares.base") : null;
  }
  const { amount, currency } = family.difference;
  if (ZERO.test(amount)) {
    return t("fares.samePrice");
  }
  return amount.startsWith("-")
    ? t("fares.less", { amount: formatMoney({ amount: amount.slice(1), currency }, locale) })
    : t("fares.more", { amount: formatMoney({ amount, currency }, locale) });
}

/**
 * Mounts the fare cards in `root` (the page's `[data-fare-families]` list). `update({ families, selected })` renders
 * them with `selected` (an offer id) checked, else the base fare; `selected()` is the offer id to price; a change of
 * the radio group calls `onChange(offerId)`.
 * @param {HTMLElement} root
 * @param {{ locale?: string, onChange?: (offerId: string) => void }} [props]
 */
export function mount(root, { locale, onChange } = {}) {
  const doc = root.ownerDocument;
  /** @type {FareFamily[]} */
  let families = [];

  /** @param {Event} event */
  const onInput = (event) => {
    const input = /** @type {HTMLInputElement | null} */ (event.target);
    if (input?.type === "radio" && input.checked && input.name === "fare") {
      onChange?.(input.value);
    }
  };
  root.addEventListener("change", onInput);

  /** @returns {string | null} */
  const selected = () => {
    if (families.length === 1) {
      return families[0]?.offerId ?? null;
    }
    const checked = /** @type {HTMLInputElement | null} */ (root.querySelector('input[name="fare"]:checked'));
    return checked?.value ?? null;
  };

  /**
   * @param {FareFamily} family
   * @param {number} index
   * @param {string | null} chosen
   */
  const card = (family, index, chosen) => {
    const difference = differenceText(family, locale);
    const element = fill(clone("tpl-fare-family", doc), {
      offerId: family.offerId,
      name: family.name,
      price: t("fares.total", { price: formatMoney(family.price, locale) }),
      difference,
      noDifference: difference === null,
      checked: family.offerId === chosen,
    });
    const input = /** @type {HTMLInputElement | null} */ (element.querySelector('input[name="fare"]'));
    const list = /** @type {HTMLElement | null} */ (element.querySelector("[data-fare-features]"));
    for (const feature of family.features) {
      list?.append(
        fill(clone("tpl-fare-feature", doc), {
          label: t("fares.featureLabel", { label: feature.label }),
          status: feature.status,
          statusText: t(`fares.status.${feature.status}`),
          detail: feature.detail,
          noDetail: feature.detail === null,
        }),
      );
    }
    if (list) {
      list.hidden = family.features.length === 0;
      list.id = `fare-features-${index + 1}`;
    }
    if (families.length === 1) {
      input?.remove();
    } else if (input && list && !list.hidden) {
      input.setAttribute("aria-describedby", list.id);
    }
    return element;
  };

  return {
    /** @param {{ families?: FareFamily[], selected?: string | null }} props */
    update({ families: next = families, selected: wanted = selected() } = {}) {
      families = next;
      const base = families.find((family) => family.isBase) ?? families[0];
      const chosen = families.some((family) => family.offerId === wanted)
        ? /** @type {string} */ (wanted)
        : (base?.offerId ?? null);
      root.replaceChildren(...families.map((family, index) => card(family, index, chosen)));
    },
    selected,
    /** The family of an offer id, or `null`. @param {string | null} offerId */
    family: (offerId) => families.find((family) => family.offerId === offerId) ?? null,
    destroy() {
      root.removeEventListener("change", onInput);
      root.replaceChildren();
    },
  };
}
