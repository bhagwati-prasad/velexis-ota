// The travellers of the checkout page (ota/frontend/docs/pages.md §7 step 2, B3 §2.2, partials/templates/
// traveller-form.html): one fieldset per traveller of `checkout.requirements.travelers`, in that order, with exactly the
// fields the airline asks for (`requiredFields`): the name always, then date of birth (limited to
// `dateOfBirthMin`/`dateOfBirthMax`), gender, the passport or ID card (`documentTypes`, number, expiry, issuing country
// and nationality from `reference.countries.list`, place of issue), the country of residence, a redress number and
// the discount cards. Fields come pre-filled from the checkout's traveller.
//
// - Controls are named after the JSON pointer of the request (`travelers.0.name.firstName` for
//   `/travelers/0/name/firstName`), and `data-error-path` adds the pointers the API uses for a whole part
//   (`/travelers/0/name`, `/travelers/0/documents`, `/travelers/0/contact/address`), so lib/forms.js marks the right
//   control for every field error of `checkout.setTravelers` and of `progress.missing`.
// - Document numbers never come back from the API (`numberMasked` only, B3 §2.2). The number field starts empty; while
//   the stored document is kept (same document type and issuing country), an empty number keeps the stored one, so the
//   field is optional and says which number is stored. The values live in the inputs only: nothing here stores, logs
//   or announces them.
// - `readTravellers()` builds one `TravelerInput` per traveller (keyed by `travelerId`, never the `ctr_` id), leaving
//   out what is empty. Country codes are upper-cased; names are sent as typed.

import { clone, fill } from "../lib/dom.js";
import { t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["CheckoutTravelerRequirement"]} TravellerRequirement */
/** @typedef {import("@velexis/ota-sdk").Schemas["Traveler"]} Traveller */
/** @typedef {import("@velexis/ota-sdk").Schemas["TravelerInput"]} TravellerInput */
/** @typedef {import("@velexis/ota-sdk").Schemas["TravelerDocument"]} TravellerDocument */
/** @typedef {import("@velexis/ota-sdk").Schemas["TravelerDocumentInput"]} TravellerDocumentInput */
/** @typedef {import("@velexis/ota-sdk").Schemas["AmadeusDiscount"]} Discount */
/** @typedef {{ code: string, name: string }} CountryOption */
/** @typedef {HTMLInputElement | HTMLSelectElement} Control */

/** Traveller types that count as adults (the contact step's pre-fill takes the first of them). */
export const ADULT_TYPES = new Set(["ADULT", "SENIOR", "YOUNG", "STUDENT"]);
/** The sections of the template and the required field that keeps each. */
const SECTIONS = /** @type {const} */ ([
  "dateOfBirth",
  "gender",
  "documents",
  "documentIssuanceCity",
  "residence",
  "redress",
  "airFranceDiscount",
  "spanishResidentDiscount",
]);
const COUNTRY_CODE = /^[A-Z]{2}$/;

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * "Anna Berg", or `null` while the traveller has no name.
 * @param {Traveller | null | undefined} traveller
 * @returns {string | null}
 */
export function travellerName(traveller) {
  const name = [text(traveller?.name?.firstName), text(traveller?.name?.lastName)].filter(
    (part) => part !== "",
  );
  return name.length > 0 ? name.join(" ") : null;
}

/**
 * The title of a traveller: "Traveller 1: Adult", "Traveller 3: Infant on a lap", with the name once known
 * ("Traveller 1: Anna Berg, adult").
 * @param {number} position 0-based place in the checkout
 * @param {Pick<TravellerRequirement, "travelerType">} requirement
 * @param {Traveller | null | undefined} [traveller]
 */
export function travellerTitle(position, requirement, traveller) {
  const type = t(`traveller.${requirement.travelerType}`);
  const name = travellerName(traveller);
  return name === null
    ? t("checkout.travellerTitle", { number: position + 1, type })
    : t("checkout.travellerTitleNamed", { number: position + 1, name, type: type.toLowerCase() });
}

/**
 * The traveller's identity document: the one of an accepted type, else the first that is no redress number.
 * @param {Traveller | null | undefined} traveller
 * @param {ReadonlyArray<string>} documentTypes
 * @returns {TravellerDocument | null}
 */
export function identityDocument(traveller, documentTypes) {
  const documents = /** @type {TravellerDocument[]} */ (list(traveller?.documents));
  return (
    documents.find((document) => documentTypes.includes(document.documentType)) ??
    documents.find((document) => document.documentType !== "REDRESS") ??
    null
  );
}

/**
 * Fills a country select with the countries ("Choose a country" first), keeping `value` selected. Without countries
 * (the list could not be loaded) the select becomes a text field for the two-letter code. Returns the control.
 * @param {HTMLSelectElement} select
 * @param {ReadonlyArray<CountryOption> | null} countries
 * @param {string} value
 * @returns {Control}
 */
export function fillCountrySelect(select, countries, value) {
  const doc = select.ownerDocument;
  const code = value.toUpperCase();
  if (countries === null) {
    const input = doc.createElement("input");
    input.type = "text";
    input.maxLength = 2;
    input.pattern = "[A-Za-z]{2}";
    input.autocapitalize = "characters";
    input.spellcheck = false;
    input.title = t("checkout.countryCodeHint");
    input.required = select.required;
    input.className = select.className;
    for (const { name, value: attribute } of Array.from(select.attributes)) {
      if (name.startsWith("data-") || name === "name" || name === "id" || name === "autocomplete") {
        input.setAttribute(name, attribute);
      }
    }
    input.value = code;
    select.replaceWith(input);
    return input;
  }
  const empty = doc.createElement("option");
  empty.value = "";
  empty.textContent = t("checkout.chooseCountry");
  const options = countries.map((country) => {
    const option = doc.createElement("option");
    option.value = country.code;
    option.textContent = country.name;
    return option;
  });
  // A stored code the list does not know stays selectable, so it is not lost silently.
  if (COUNTRY_CODE.test(code) && !countries.some((country) => country.code === code)) {
    const option = doc.createElement("option");
    option.value = code;
    option.textContent = code;
    options.push(option);
  }
  select.replaceChildren(empty, ...options);
  select.value = COUNTRY_CODE.test(code) ? code : "";
  return select;
}

/**
 * The control name of a template input (`data-input`) for the traveller at `position`: the JSON pointer of the
 * request with dots. The redress number and the discount cards are entries of `documents` and `discountEligibility`
 * after the identity document and the other discount.
 * @param {string} key
 * @param {number} position
 * @param {{ documents: boolean, airFrance: boolean }} has
 */
function controlName(key, position, has) {
  const base = `travelers.${position}`;
  if (key === "redress") {
    return `${base}.documents.${has.documents ? 1 : 0}.number`;
  }
  const [group, field] = key.split(".");
  if (group === "airFrance") {
    return `${base}.discountEligibility.0.${field}`;
  }
  if (group === "spanishResident") {
    return `${base}.discountEligibility.${has.airFrance ? 1 : 0}.${field}`;
  }
  return `${base}.${key}`;
}

/**
 * Renders one traveller's fieldset from `tpl-traveller`.
 * @param {Document} doc
 * @param {number} position
 * @param {TravellerRequirement} requirement
 * @param {Traveller | null} traveller
 * @param {ReadonlyArray<CountryOption> | null} countries
 */
function renderTraveller(doc, position, requirement, traveller, countries) {
  const required = new Set(list(requirement.requiredFields));
  const types = list(requirement.documentTypes).filter((type) => typeof type === "string");
  const adult =
    requirement.travelerType === "HELD_INFANT" && typeof requirement.associatedAdultId === "string"
      ? requirement.associatedAdultId
      : null;
  const element = fill(clone("tpl-traveller", doc), {
    travelerId: requirement.travelerId,
    title: travellerTitle(position, requirement, traveller),
    hint: adult === null ? null : t("checkout.infantWith", { number: adult }),
    noHint: adult === null,
  });
  for (const section of SECTIONS) {
    const keep =
      section === "documentIssuanceCity"
        ? required.has("documents") && required.has(section)
        : required.has(section);
    if (!keep) {
      element.querySelector(`[data-section="${section}"]`)?.remove();
    }
  }
  const has = { documents: required.has("documents"), airFrance: required.has("airFranceDiscount") };
  const document = identityDocument(traveller, types);
  const redress = list(traveller?.documents).find((entry) => entry?.documentType === "REDRESS") ?? null;
  const discounts = /** @type {Discount[]} */ (list(traveller?.discountEligibility));
  const airFrance = discounts.find((discount) => discount.subType?.startsWith("AIR_FRANCE_") === true);
  const spanish = discounts.find((discount) => discount.subType === "SPANISH_RESIDENT");
  /** @type {Record<string, string>} */
  const values = {
    "name.firstName": text(traveller?.name?.firstName),
    "name.lastName": text(traveller?.name?.lastName),
    dateOfBirth: text(traveller?.dateOfBirth),
    gender: text(traveller?.gender),
    "documents.0.documentType": text(document?.documentType),
    "documents.0.expiryDate": text(document?.expiryDate),
    "documents.0.issuanceCountry": text(document?.issuanceCountry),
    "documents.0.nationality": text(document?.nationality),
    "documents.0.issuanceLocation": text(document?.issuanceLocation),
    "contact.address.countryCode": text(traveller?.contact?.address?.countryCode),
    "airFrance.subType": text(airFrance?.subType),
    "spanishResident.cityName": text(spanish?.cityName),
  };
  const prefix = `checkout-traveller-${position + 1}`;
  for (const control of /** @type {Control[]} */ (Array.from(element.querySelectorAll("[data-input]")))) {
    const key = /** @type {string} */ (control.getAttribute("data-input"));
    control.name = controlName(key, position, has);
    control.id = `${prefix}-${key.replace(/\./g, "-")}`;
    const autocomplete = control.getAttribute("data-autocomplete");
    if (autocomplete) {
      // One autofill section per traveller, so a browser never fills one person into every traveller.
      control.setAttribute("autocomplete", `section-traveller-${position + 1} ${autocomplete}`);
    }
    const suffixes = (control.getAttribute("data-error-suffix") ?? "").split(/\s+/).filter((s) => s !== "");
    if (suffixes.length > 0) {
      control.setAttribute(
        "data-error-path",
        suffixes.map((suffix) => `/travelers/${position}${suffix}`).join(" "),
      );
    }
    let current = /** @type {Control} */ (control);
    if (control.hasAttribute("data-document-types")) {
      control.replaceChildren(
        ...types.map((type) => {
          const option = doc.createElement("option");
          option.value = type;
          option.textContent = t(`document.${type}`);
          return option;
        }),
      );
    }
    if (control.hasAttribute("data-countries") && control.tagName === "SELECT") {
      current = fillCountrySelect(/** @type {HTMLSelectElement} */ (control), countries, values[key] ?? "");
    } else if (Object.hasOwn(values, key) && values[key] !== "") {
      current.value = /** @type {string} */ (values[key]);
    }
    if (key === "dateOfBirth") {
      const input = /** @type {HTMLInputElement} */ (current);
      if (typeof requirement.dateOfBirthMin === "string") {
        input.min = requirement.dateOfBirthMin;
      }
      if (typeof requirement.dateOfBirthMax === "string") {
        input.max = requirement.dateOfBirthMax;
      }
    }
  }
  const documentType = /** @type {HTMLSelectElement | null} */ (
    element.querySelector('[data-input="documents.0.documentType"]')
  );
  if (documentType && documentType.value === "" && types.length > 0) {
    documentType.value = /** @type {string} */ (types[0]);
  }
  // The stored number: shown masked, and kept while the field stays empty and the document keeps its type and issuing
  // country (the API matches the stored document by both). Another type or country needs the number again.
  const number = /** @type {HTMLInputElement | null} */ (element.querySelector("[data-document-number]"));
  const stored = /** @type {HTMLElement | null} */ (element.querySelector("[data-document-stored]"));
  if (number && stored && typeof document?.numberMasked === "string" && document.numberMasked !== "") {
    const storedType = text(document.documentType);
    const storedCountry = text(document.issuanceCountry).toUpperCase();
    stored.id = `${prefix}-document-stored`;
    stored.textContent = t("checkout.documentStored", { number: document.numberMasked });
    number.setAttribute("aria-describedby", stored.id);
    const sync = () => {
      const keeps =
        valueOf(element, "documents.0.documentType") === storedType &&
        valueOf(element, "documents.0.issuanceCountry").toUpperCase() === storedCountry;
      number.required = !keeps;
      stored.hidden = !keeps;
    };
    element.addEventListener("change", (event) => {
      const key = /** @type {Element | null} */ (event.target)?.getAttribute?.("data-input");
      if (key === "documents.0.documentType" || key === "documents.0.issuanceCountry") {
        sync();
      }
    });
    sync();
  }
  const redressInput = /** @type {HTMLInputElement | null} */ (
    element.querySelector('[data-input="redress"]')
  );
  if (redressInput && typeof redress?.numberMasked === "string" && redress.numberMasked !== "") {
    redressInput.placeholder = redress.numberMasked;
    redressInput.dataset.stored = "true";
  }
  return element;
}

/**
 * The value of a template input of one traveller's fieldset ("" when it is missing or empty).
 * @param {Element} fieldset
 * @param {string} key
 */
function valueOf(fieldset, key) {
  const control = /** @type {Control | null} */ (fieldset.querySelector(`[data-input="${key}"]`));
  return control && !control.disabled ? control.value.trim() : "";
}

/**
 * The `TravelerInput` of one traveller's fieldset.
 * @param {Element} fieldset
 * @param {TravellerRequirement} requirement
 * @returns {TravellerInput}
 */
export function readTraveller(fieldset, requirement) {
  const value = (/** @type {string} */ key) => valueOf(fieldset, key);
  const upper = (/** @type {string} */ key) => value(key).toUpperCase();
  const has = (/** @type {string} */ section) =>
    fieldset.querySelector(`[data-section="${section}"]`) !== null;
  /** @type {TravellerInput} */
  const input = { travelerId: requirement.travelerId };
  const firstName = value("name.firstName");
  const lastName = value("name.lastName");
  if (firstName !== "" || lastName !== "") {
    input.name = {
      ...(firstName !== "" ? { firstName } : {}),
      ...(lastName !== "" ? { lastName } : {}),
    };
  }
  if (has("dateOfBirth") && value("dateOfBirth") !== "") {
    input.dateOfBirth = value("dateOfBirth");
  }
  if (has("gender") && value("gender") !== "") {
    input.gender = /** @type {NonNullable<TravellerInput["gender"]>} */ (value("gender"));
  }
  /** @type {TravellerDocumentInput[]} */
  const documents = [];
  if (has("documents")) {
    /** @type {Record<string, string>} */
    const fields = {
      documentType: value("documents.0.documentType"),
      number: upper("documents.0.number"),
      expiryDate: value("documents.0.expiryDate"),
      issuanceCountry: upper("documents.0.issuanceCountry"),
      nationality: upper("documents.0.nationality"),
      issuanceLocation: has("documentIssuanceCity") ? value("documents.0.issuanceLocation") : "",
    };
    documents.push(
      /** @type {TravellerDocumentInput} */ ({
        ...Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== "")),
        holder: true,
      }),
    );
  }
  if (has("redress")) {
    const number = upper("redress");
    const stored = /** @type {HTMLElement | null} */ (fieldset.querySelector('[data-input="redress"]'))
      ?.dataset.stored;
    if (number !== "" || stored === "true") {
      documents.push(
        /** @type {TravellerDocumentInput} */ ({
          documentType: "REDRESS",
          ...(number !== "" ? { number } : {}),
        }),
      );
    }
  }
  if (documents.length > 0) {
    input.documents = documents;
  }
  if (has("residence") && upper("contact.address.countryCode") !== "") {
    input.contact = { address: { countryCode: upper("contact.address.countryCode") } };
  }
  /** @type {Discount[]} */
  const discounts = [];
  if (has("airFranceDiscount")) {
    discounts.push(
      /** @type {Discount} */ ({
        ...(value("airFrance.subType") !== "" ? { subType: value("airFrance.subType") } : {}),
        ...(upper("airFrance.cardNumber") !== "" ? { cardNumber: upper("airFrance.cardNumber") } : {}),
      }),
    );
  }
  if (has("spanishResidentDiscount")) {
    discounts.push(
      /** @type {Discount} */ ({
        subType: "SPANISH_RESIDENT",
        ...(value("spanishResident.cityName") !== "" ? { cityName: upper("spanishResident.cityName") } : {}),
        ...(upper("spanishResident.cardNumber") !== ""
          ? { cardNumber: upper("spanishResident.cardNumber") }
          : {}),
      }),
    );
  }
  if (discounts.length > 0) {
    input.discountEligibility = discounts;
  }
  return input;
}

/**
 * Mounts the travellers of a checkout into `root` (replacing its content): one fieldset per requirement, pre-filled
 * from the checkout's travellers. `read()` gives the `travelers` of `checkout.setTravelers`, in the same order.
 * @param {HTMLElement} root
 * @param {{ requirements: ReadonlyArray<TravellerRequirement>, travelers: ReadonlyArray<Traveller>, countries: ReadonlyArray<CountryOption> | null }} props
 */
export function mount(root, { requirements, travelers, countries }) {
  const doc = root.ownerDocument;
  const fieldsets = requirements.map((requirement, position) =>
    renderTraveller(
      doc,
      position,
      requirement,
      travelers.find((traveller) => traveller.travelerId === requirement.travelerId) ?? null,
      countries,
    ),
  );
  root.replaceChildren(...fieldsets);
  return {
    /** @returns {TravellerInput[]} */
    read() {
      return requirements.map((requirement, position) =>
        readTraveller(/** @type {Element} */ (fieldsets[position]), requirement),
      );
    },
    destroy() {
      root.replaceChildren();
    },
  };
}
