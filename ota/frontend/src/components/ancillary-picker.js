// The extras of the checkout page (ota/frontend/docs/pages.md §7 step 4, B3 §2.4): the options of
// `flights.getAncillaries({ pricedOfferId: checkout.basePricedOfferId })`, per traveller, to choose before
// `checkout.setAncillaries` re-prices the checkout with the airline.
//
// - Bags (extra checked bags, extra cabin bags) are one radio group per traveller and set of flights, "No extra bag"
//   first, because one traveller can buy one bag option per flight. Other services (priority boarding, airport
//   check-in, fast track) are checkboxes. Seats appear only where the storefront sells them (`features.seatSelection`
//   and `seatsSupported`) and are bought by seat number: there is no seat map.
// - Each option shows the API's label, the flights it covers and the API's price per traveller (`null` until the
//   airline prices it, for seats). The picker never adds prices: the new total comes from the API.
// - The checkout's current extras (`checkout.ancillaries`) start selected. Extras chosen elsewhere without a catalogue
//   option (`optionId` null) cannot be shown here and are sent back unchanged with the selections.
// - `read()` gives the `selections` of `checkout.setAncillaries` (`{ optionId, travelerId }`, plus `seatNumber` for a
//   seat), in a stable order; `removeOption()` takes an option away after `ANCILLARY_NOT_AVAILABLE`.

import { clone, fill } from "../lib/dom.js";
import { formatMoney } from "../lib/format.js";
import { hasString, t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["AncillaryCatalogue"]} AncillaryCatalogue */
/** @typedef {import("@velexis/ota-sdk").Schemas["AncillaryOption"]} AncillaryOption */
/** @typedef {import("@velexis/ota-sdk").Schemas["AncillarySelection"]} AncillarySelection */
/** @typedef {import("@velexis/ota-sdk").Schemas["CheckoutAncillary"]} CheckoutAncillary */
/** @typedef {"CHECKED_BAGS" | "CABIN_BAGS" | "SEATS" | "OTHER_SERVICES"} AncillaryType */
/** @typedef {{ key: string, type: AncillaryType, title: string, radio: boolean, options: AncillaryOption[] }} OptionGroup */

/** The kinds of extras in the order they are shown. */
const KINDS = /** @type {const} */ (["CHECKED_BAGS", "CABIN_BAGS", "OTHER_SERVICES", "SEATS"]);
/** The catalogue list of each kind. */
const LIST_OF_KIND = /** @type {const} */ ({
  CHECKED_BAGS: "checkedBags",
  CABIN_BAGS: "cabinBags",
  OTHER_SERVICES: "otherServices",
  SEATS: "seats",
});

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The selections of the checkout's current extras: `{ optionId, travelerId }` (and the seat) for a catalogue option,
 * the explicit fields for an extra chosen without one.
 * @param {ReadonlyArray<CheckoutAncillary> | null | undefined} ancillaries
 * @returns {AncillarySelection[]}
 */
export function selectionsOf(ancillaries) {
  return list(ancillaries).map((/** @type {CheckoutAncillary} */ extra) => {
    if (typeof extra.optionId === "string") {
      return {
        optionId: extra.optionId,
        travelerId: extra.travelerId,
        ...(typeof extra.seatNumber === "string" ? { seatNumber: extra.seatNumber } : {}),
      };
    }
    /** @type {AncillarySelection} */
    const selection = { type: extra.type, travelerId: extra.travelerId };
    if (list(extra.segmentIds).length > 0) {
      selection.segmentIds = [...extra.segmentIds];
    }
    for (const field of /** @type {const} */ (["quantity", "weight"])) {
      if (typeof extra[field] === "number") {
        selection[field] = /** @type {number} */ (extra[field]);
      }
    }
    if (extra.weightUnit === "KG" || extra.weightUnit === "LB") {
      selection.weightUnit = extra.weightUnit;
    }
    if (typeof extra.serviceName === "string") {
      selection.serviceName = extra.serviceName;
    }
    if (typeof extra.seatNumber === "string") {
      selection.seatNumber = extra.seatNumber;
    }
    return selection;
  });
}

/**
 * A text that identifies a selection (option, traveller, seat and the explicit fields).
 * @param {AncillarySelection} selection
 */
export const selectionKey = (selection) =>
  JSON.stringify([
    selection.optionId ?? null,
    selection.travelerId,
    selection.seatNumber ?? null,
    selection.type ?? null,
    selection.serviceName ?? null,
    list(selection.segmentIds).join(","),
    selection.quantity ?? null,
    selection.weight ?? null,
    selection.weightUnit ?? null,
  ]);

/**
 * Whether two lists hold the same selections, in any order.
 * @param {ReadonlyArray<AncillarySelection>} first
 * @param {ReadonlyArray<AncillarySelection>} second
 */
export function sameSelections(first, second) {
  const keys = (/** @type {ReadonlyArray<AncillarySelection>} */ items) => items.map(selectionKey).sort();
  return first.length === second.length && keys(first).every((key, index) => key === keys(second)[index]);
}

/**
 * The flights of an option as text ("CDG–JFK, JFK–CDG"), from the catalogue's segments.
 * @param {AncillaryCatalogue} catalogue
 * @param {ReadonlyArray<string>} segmentIds
 */
export function flightsText(catalogue, segmentIds) {
  return segmentIds
    .map((id) => {
      const segment = list(catalogue.segments).find((entry) => entry.segmentId === id);
      return segment ? t("baggage.route", { from: segment.originCode, to: segment.destinationCode }) : null;
    })
    .filter((route) => route !== null)
    .join(", ");
}

/**
 * The option groups of one traveller: a radio group per kind of bag and set of flights, one group of checkboxes for
 * the other services and one for seats (`seats` only when the storefront sells them).
 * @param {AncillaryCatalogue} catalogue
 * @param {string} travelerId
 * @param {{ seats?: boolean }} [options]
 * @returns {OptionGroup[]}
 */
export function optionGroups(catalogue, travelerId, { seats = false } = {}) {
  /** @type {OptionGroup[]} */
  const groups = [];
  for (const type of KINDS) {
    if (type === "SEATS" && (!seats || catalogue.seatsSupported !== true)) {
      continue;
    }
    const options = /** @type {AncillaryOption[]} */ (list(catalogue[LIST_OF_KIND[type]])).filter(
      (option) => list(option.travelerIds).length === 0 || list(option.travelerIds).includes(travelerId),
    );
    if (type === "CHECKED_BAGS" || type === "CABIN_BAGS") {
      /** @type {Map<string, AncillaryOption[]>} */
      const byFlights = new Map();
      for (const option of options) {
        const key = list(option.segmentIds).join(",");
        byFlights.set(key, [...(byFlights.get(key) ?? []), option]);
      }
      for (const [key, same] of byFlights) {
        const flights = flightsText(catalogue, list(same[0]?.segmentIds));
        const kind = t(type === "CHECKED_BAGS" ? "extras.checkedBags" : "extras.cabinBags");
        groups.push({
          key: `${type}:${key}`,
          type,
          title: flights === "" ? kind : t("checkout.extrasGroup", { kind, flights }),
          radio: true,
          options: same,
        });
      }
    } else if (options.length > 0) {
      groups.push({
        key: type,
        type,
        title: t(type === "SEATS" ? "checkout.extrasSeats" : "checkout.extrasServices"),
        radio: false,
        options,
      });
    }
  }
  return groups;
}

/**
 * The label of an option: the API's label, else the name of its service.
 * @param {AncillaryOption} option
 */
function optionLabel(option) {
  if (typeof option.label === "string" && option.label.trim() !== "") {
    return option.label.trim();
  }
  const key = `extras.service.${option.serviceName ?? option.name}`;
  return hasString(key) ? t(key) : String(option.name);
}

/**
 * Mounts the extras of a checkout into `root` (replacing its content).
 * @param {HTMLElement} root
 * @param {{ catalogue: AncillaryCatalogue, ancillaries: ReadonlyArray<CheckoutAncillary>, titleFor: (travelerId: string) => string, locale?: string, seats?: boolean }} props
 */
export function mount(root, { catalogue, ancillaries, titleFor, locale, seats = false }) {
  const doc = root.ownerDocument;
  const current = selectionsOf(ancillaries);
  /** Extras of the checkout that no option of the catalogue shows: sent back unchanged. */
  const kept = current.filter((selection) => typeof selection.optionId !== "string");
  const chosen = new Set(
    current.filter((selection) => typeof selection.optionId === "string").map(selectionKey),
  );
  /** @type {Map<string, string>} the seat number of each chosen seat option, by option and traveller */
  const seatOf = new Map(
    current
      .filter(
        (selection) => typeof selection.optionId === "string" && typeof selection.seatNumber === "string",
      )
      .map((selection) => [`${selection.optionId}|${selection.travelerId}`, String(selection.seatNumber)]),
  );
  /** @type {Map<string, AncillaryOption>} */
  const options = new Map();
  let generated = 0;

  /**
   * Whether an option is chosen for a traveller (with any seat).
   * @param {AncillaryOption} option
   * @param {string} travelerId
   */
  const isChosen = (option, travelerId) =>
    chosen.has(selectionKey({ optionId: option.id, travelerId, ...seatSelection(option, travelerId) }));
  /** @param {AncillaryOption} option @param {string} travelerId */
  function seatSelection(option, travelerId) {
    const seat = seatOf.get(`${option.id}|${travelerId}`);
    return seat === undefined ? {} : { seatNumber: seat };
  }

  /**
   * One choice of a group.
   * @param {OptionGroup} group
   * @param {AncillaryOption | null} option `null` for "No extra bag"
   * @param {string} travelerId
   * @param {string} name the radio group's name
   * @param {boolean} checked
   */
  const choice = (group, option, travelerId, name, checked) => {
    // A bag group names its flights in its title; a service or seat names them on its own line.
    const flights = group.radio || option === null ? "" : flightsText(catalogue, list(option.segmentIds));
    const item = fill(clone("tpl-ancillary-choice", doc), {
      optionId: option?.id ?? "",
      label: option === null ? t("checkout.extrasNone") : optionLabel(option),
      detail: flights === "" ? null : flights,
      noDetail: flights === "",
      price:
        option === null
          ? ""
          : option.price
            ? formatMoney(option.price, locale)
            : t("checkout.extrasPriceLater"),
    });
    const input = /** @type {HTMLInputElement} */ (item.querySelector("input[data-ancillary-input]"));
    input.type = group.radio ? "radio" : "checkbox";
    input.name = name;
    input.value = option?.id ?? "";
    input.checked = checked;
    generated += 1;
    input.id = `checkout-extra-${generated}`;
    const seat = /** @type {HTMLElement | null} */ (item.querySelector("[data-seat]"));
    const seatInput = /** @type {HTMLInputElement | null} */ (item.querySelector("input[data-seat-number]"));
    if (seat && seatInput) {
      if (option?.requiresSeatNumber === true) {
        seatInput.value = seatOf.get(`${option.id}|${travelerId}`) ?? "";
        const sync = () => {
          seat.hidden = !input.checked;
          seatInput.disabled = !input.checked;
          seatInput.required = input.checked;
        };
        input.addEventListener("change", sync);
        sync();
      } else {
        seat.remove();
      }
    }
    if (option) {
      options.set(option.id, option);
    }
    return item;
  };

  const travellers = list(catalogue.travelers).map((/** @type {{ travelerId: string }} */ traveller) => {
    const { travelerId } = traveller;
    const element = fill(clone("tpl-ancillary-traveller", doc), { travelerId, title: titleFor(travelerId) });
    const container = /** @type {HTMLElement} */ (element.querySelector("[data-ancillary-groups]"));
    const groups = optionGroups(catalogue, travelerId, { seats });
    container.replaceChildren(
      ...groups.map((group) => {
        const groupElement = fill(clone("tpl-ancillary-group", doc), { title: group.title });
        const choices = /** @type {HTMLElement} */ (groupElement.querySelector("[data-ancillary-choices]"));
        const name = `extras-${travelerId}-${group.key}`;
        const any = group.options.some((option) => isChosen(option, travelerId));
        choices.replaceChildren(
          ...(group.radio ? [choice(group, null, travelerId, name, !any)] : []),
          ...group.options.map((option) =>
            choice(group, option, travelerId, name, isChosen(option, travelerId)),
          ),
        );
        return groupElement;
      }),
    );
    element.hidden = groups.length === 0;
    return element;
  });
  root.replaceChildren(...travellers);

  return {
    /** Whether any traveller has an option to choose. */
    get empty() {
      return options.size === 0;
    },
    /**
     * The selections for `checkout.setAncillaries`: the chosen options in the order shown, then the kept extras.
     * @returns {AncillarySelection[]}
     */
    read() {
      /** @type {AncillarySelection[]} */
      const selections = [];
      for (const element of travellers) {
        const travelerId = /** @type {string} */ (element.getAttribute("data-traveler-id"));
        for (const input of /** @type {HTMLInputElement[]} */ (
          Array.from(element.querySelectorAll("input[data-ancillary-input]"))
        )) {
          const option = options.get(input.value);
          if (!input.checked || !option) {
            continue;
          }
          const seat = /** @type {HTMLInputElement | null} */ (
            input.closest("[data-ancillary-choice]")?.querySelector("input[data-seat-number]") ?? null
          );
          const seatNumber = seat && !seat.disabled ? seat.value.trim().toUpperCase() : "";
          selections.push({ optionId: option.id, travelerId, ...(seatNumber !== "" ? { seatNumber } : {}) });
        }
      }
      return [...selections, ...kept];
    },
    /**
     * Takes an option away for a traveller (the airline no longer sells it): a chosen bag falls back to "No extra
     * bag". Returns the option's label, or `null` when it is not shown.
     * @param {string} optionId
     * @param {string} travelerId
     * @returns {string | null}
     */
    removeOption(optionId, travelerId) {
      const element = travellers.find((entry) => entry.getAttribute("data-traveler-id") === travelerId);
      const item = Array.from(element?.querySelectorAll("[data-ancillary-choice]") ?? []).find(
        (entry) => entry.getAttribute("data-option-id") === optionId,
      );
      const option = options.get(optionId);
      if (!item || !option) {
        return null;
      }
      const input = /** @type {HTMLInputElement | null} */ (
        item.querySelector("input[data-ancillary-input]")
      );
      const none = /** @type {HTMLInputElement | null} */ (
        item.closest("[data-ancillary-choices]")?.querySelector('input[data-ancillary-input][value=""]') ??
          null
      );
      if (input?.checked && none) {
        none.checked = true;
      }
      item.remove();
      return optionLabel(option);
    },
    destroy() {
      root.replaceChildren();
    },
  };
}
