// The price breakdown of the price page (ota/frontend/docs/pages.md §6, OADR-0005 point 7): what the confirmed selling
// price of a priced offer is made of, as the API states it (`SellingPrice` with its `breakdown`). Lines are clones of
// `tpl-price-section` and `tpl-price-line` (partials/templates/price-line.html) filled with `fill()`, so API data only
// ever becomes text.
//
// - "Price per traveller": one line per traveller type ("2 adults, €441.20 each", with fare, taxes and fees), or one
//   line per traveller when the travellers of a type do not pay the same. Grouping compares the API's amounts as text;
//   nothing is multiplied.
// - "What the total includes": fares, taxes and charges, every fee line with its label (the fee rule's label for
//   the OTA's service fees, the fee type for the airline's), extras already priced in, and the API's `total`, which is
//   never computed from the lines.
//
// `compareDecimal` and `lowestPrice` compare decimal amounts exactly (digit by digit, never as JavaScript numbers),
// for "from" prices such as the cheapest extra bag.

import { clone, fill } from "../lib/dom.js";
import { formatMoney } from "../lib/format.js";
import { hasString, t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("@velexis/ota-sdk").Schemas["SellingPrice"]} SellingPrice */
/** @typedef {import("@velexis/ota-sdk").Schemas["PriceBreakdownTraveler"]} BreakdownTraveller */
/** @typedef {import("@velexis/ota-sdk").Schemas["PriceBreakdownFee"]} BreakdownFee */
/**
 * One line of the breakdown, ready for `tpl-price-line`.
 * @typedef {object} PriceLine
 * @property {"traveller" | "base" | "taxes" | "fee" | "service" | "total"} kind
 * @property {string} label
 * @property {string | null} detail a second line under the label
 * @property {string} amount the formatted amount
 */
/** @typedef {{ name: "travellers" | "details", title: string, lines: PriceLine[] }} PriceSection */

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const ZERO = /^-?0+(?:\.0+)?$/;

/**
 * Whether an API amount is zero ("0.00", "-0").
 * @param {Money | null | undefined} money
 */
export const isZero = (money) => typeof money?.amount === "string" && ZERO.test(money.amount);

/**
 * Whether two API amounts are the same amount in the same currency, compared as text ("12.5" equals "12.50").
 * @param {Money | null | undefined} a
 * @param {Money | null | undefined} b
 */
export const sameMoney = (a, b) =>
  Boolean(a && b) &&
  /** @type {Money} */ (a).currency === /** @type {Money} */ (b).currency &&
  compareDecimal(/** @type {Money} */ (a).amount, /** @type {Money} */ (b).amount) === 0;

/**
 * Compares two decimal strings ("35.00", "-12.5") exactly, digit by digit: -1, 0 or 1, or `null` when either is not
 * a decimal. No JavaScript number is involved, so no rounding can happen.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1 | null}
 */
export function compareDecimal(a, b) {
  const x = typeof a === "string" ? DECIMAL.exec(a) : null;
  const y = typeof b === "string" ? DECIMAL.exec(b) : null;
  if (!x || !y) {
    return null;
  }
  const signX = x[1] === "-" && !ZERO.test(/** @type {string} */ (a)) ? -1 : 1;
  const signY = y[1] === "-" && !ZERO.test(/** @type {string} */ (b)) ? -1 : 1;
  if (signX !== signY) {
    return signX < signY ? -1 : 1;
  }
  const integerX = /** @type {string} */ (x[2]).replace(/^0+(?=\d)/, "");
  const integerY = /** @type {string} */ (y[2]).replace(/^0+(?=\d)/, "");
  /** @type {-1 | 0 | 1} */
  let magnitude = 0;
  if (integerX.length !== integerY.length) {
    magnitude = integerX.length < integerY.length ? -1 : 1;
  } else if (integerX !== integerY) {
    magnitude = integerX < integerY ? -1 : 1;
  } else {
    const digits = Math.max((x[3] ?? "").length, (y[3] ?? "").length);
    const fractionX = (x[3] ?? "").padEnd(digits, "0");
    const fractionY = (y[3] ?? "").padEnd(digits, "0");
    magnitude = fractionX === fractionY ? 0 : fractionX < fractionY ? -1 : 1;
  }
  return /** @type {-1 | 0 | 1} */ (signX * magnitude || 0);
}

/**
 * The lowest of some API prices (`null` entries and unreadable amounts are skipped; only the currency of the first
 * readable price counts), or `null` when there is none.
 * @param {ReadonlyArray<Money | null | undefined>} prices
 * @returns {Money | null}
 */
export function lowestPrice(prices) {
  /** @type {Money | null} */
  let lowest = null;
  for (const price of prices) {
    if (!price || typeof price.currency !== "string" || compareDecimal(price.amount, "0") === null) {
      continue;
    }
    if (lowest === null) {
      lowest = price;
    } else if (price.currency === lowest.currency && compareDecimal(price.amount, lowest.amount) === -1) {
      lowest = price;
    }
  }
  return lowest;
}

/**
 * "Fare €380.00 · Taxes and charges €56.20 · Fees €5.00" for one traveller (fees only when there are any).
 * @param {BreakdownTraveller} traveller
 * @param {string | undefined} locale
 */
function travellerDetail(traveller, locale) {
  const parts = [
    t("breakdown.fare", { price: formatMoney(traveller.base, locale) }),
    t("breakdown.taxes", { price: formatMoney(traveller.taxes, locale) }),
  ];
  if (traveller.fees && !isZero(traveller.fees)) {
    parts.push(t("breakdown.fees", { price: formatMoney(traveller.fees, locale) }));
  }
  return parts.join(t("results.separator"));
}

/**
 * Whether two travellers pay the same: total, fare, taxes and fees.
 * @param {BreakdownTraveller} a
 * @param {BreakdownTraveller} b
 */
const samePrice = (a, b) =>
  sameMoney(a.total, b.total) &&
  sameMoney(a.base, b.base) &&
  sameMoney(a.taxes, b.taxes) &&
  (sameMoney(a.fees, b.fees) || (isZero(a.fees) && isZero(b.fees)));

/**
 * "2 adults", "1 child", "1 infant on a lap" (a type without its own text: "2 travellers").
 * @param {string} type
 * @param {number} count
 */
const groupLabel = (type, count) =>
  hasString(`breakdown.travellers.${type}`)
    ? t(`breakdown.travellers.${type}`, { count })
    : t("breakdown.travellers.other", { count });

/**
 * The lines of "Price per traveller": one per traveller type in the API's order, with the amount each traveller of
 * the type pays; one per traveller ("Adult 1", "Adult 2") when the travellers of a type pay different amounts.
 * @param {ReadonlyArray<BreakdownTraveller> | null | undefined} travellers `price.breakdown.travelers`
 * @param {string | undefined} [locale]
 * @returns {PriceLine[]}
 */
export function travellerLines(travellers, locale) {
  /** @type {Map<string, BreakdownTraveller[]>} */
  const groups = new Map();
  for (const traveller of Array.isArray(travellers) ? travellers : []) {
    const type = String(traveller.travelerType);
    groups.set(type, [...(groups.get(type) ?? []), traveller]);
  }
  /** @type {PriceLine[]} */
  const lines = [];
  for (const [type, members] of groups) {
    const first = /** @type {BreakdownTraveller} */ (members[0]);
    if (members.every((member) => samePrice(member, first))) {
      const price = formatMoney(first.total, locale);
      lines.push({
        kind: "traveller",
        label: groupLabel(type, members.length),
        detail: travellerDetail(first, locale),
        amount: members.length > 1 ? t("breakdown.each", { price }) : price,
      });
      continue;
    }
    const name = hasString(`traveller.${type}`) ? t(`traveller.${type}`) : groupLabel(type, 1);
    members.forEach((member, index) => {
      lines.push({
        kind: "traveller",
        label: t("breakdown.traveller", { type: name, number: index + 1 }),
        detail: travellerDetail(member, locale),
        amount: formatMoney(member.total, locale),
      });
    });
  }
  return lines;
}

/**
 * The label of a fee line: its own (the OTA's fee rule label, OADR-0005 point 7), else its type ("Ticketing fee").
 * @param {Pick<BreakdownFee, "type" | "description">} fee
 */
export function feeLabel(fee) {
  if (typeof fee.description === "string" && fee.description.trim() !== "") {
    return fee.description.trim();
  }
  return hasString(`fee.${fee.type}`) ? t(`fee.${fee.type}`) : t("fee.other");
}

/**
 * The lines of "What the total includes": fares, taxes and charges, each fee line (else the fees as one line), the
 * extras already priced in, and the API's total.
 * @param {SellingPrice} price
 * @param {string | undefined} [locale]
 * @returns {PriceLine[]}
 */
export function detailLines(price, locale) {
  /** @type {(kind: PriceLine["kind"], label: string, money: Money | null | undefined) => PriceLine} */
  const line = (kind, label, money) => ({ kind, label, detail: null, amount: formatMoney(money, locale) });
  /** @type {PriceLine[]} */
  const lines = [];
  if (price.base) {
    lines.push(line("base", t("breakdown.base"), price.base));
  }
  if (price.taxes) {
    lines.push(line("taxes", t("breakdown.taxesLine"), price.taxes));
  }
  const fees = Array.isArray(price.breakdown?.fees) ? price.breakdown.fees : [];
  if (fees.length > 0) {
    lines.push(...fees.map((fee) => line("fee", feeLabel(fee), fee.amount)));
  } else if (price.fees && !isZero(price.fees)) {
    lines.push(line("fee", t("breakdown.feesLine"), price.fees));
  }
  const services = Array.isArray(price.breakdown?.additionalServices)
    ? price.breakdown.additionalServices
    : [];
  if (services.length > 0) {
    lines.push(
      ...services.map((service) =>
        line(
          "service",
          hasString(`service.${service.type}`) ? t(`service.${service.type}`) : t("breakdown.extras"),
          service.amount,
        ),
      ),
    );
  } else if (price.additionalServices && !isZero(price.additionalServices)) {
    lines.push(line("service", t("breakdown.extras"), price.additionalServices));
  }
  lines.push(line("total", t("breakdown.total"), price.total));
  return lines;
}

/**
 * The sections of the breakdown: per traveller (when the API has a breakdown per traveller), then what the total
 * includes.
 * @param {SellingPrice} price
 * @param {string | undefined} [locale]
 * @returns {PriceSection[]}
 */
export function breakdownSections(price, locale) {
  const travellers = travellerLines(price.breakdown?.travelers, locale);
  return [
    ...(travellers.length > 0
      ? [
          {
            name: /** @type {const} */ ("travellers"),
            title: t("breakdown.travellersTitle"),
            lines: travellers,
          },
        ]
      : []),
    {
      name: /** @type {const} */ ("details"),
      title: t("breakdown.detailsTitle"),
      lines: detailLines(price, locale),
    },
  ];
}

/**
 * Mounts the breakdown in `root` (the price page's `[data-price-breakdown]`). `update({ price })` renders the
 * sections of a `SellingPrice`; `destroy()` empties `root`.
 * @param {HTMLElement} root
 * @param {{ locale?: string }} [props]
 */
export function mount(root, { locale } = {}) {
  const doc = root.ownerDocument;
  return {
    /** @param {{ price: SellingPrice }} props */
    update({ price }) {
      root.replaceChildren(
        ...breakdownSections(price, locale).map((section) => {
          const element = fill(clone("tpl-price-section", doc), { name: section.name, title: section.title });
          /** @type {HTMLElement} */ (element.querySelector("[data-price-lines]")).replaceChildren(
            ...section.lines.map((priceLine) =>
              fill(clone("tpl-price-line", doc), { ...priceLine, noDetail: priceLine.detail === null }),
            ),
          );
          return element;
        }),
      );
    },
    destroy() {
      root.replaceChildren();
    },
  };
}
