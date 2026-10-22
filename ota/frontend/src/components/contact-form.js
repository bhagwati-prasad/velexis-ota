// The booking contact of the checkout page (ota/frontend/docs/pages.md §7 step 3, B3 §2.3): the static fields of the
// contacts step in checkout.html, filled and read here.
//
// - The primary contact receives the confirmation and the e-tickets: name, e-mail (always required) and a mobile phone
//   (required when the airline asks for one, `requirements.contact`). A postal address is asked for only when the
//   airline requires it (`mailingAddressRequired`), and an invoice contact with its address when it requires one
//   (`invoiceAddressRequired`) or the traveller asks for an invoice.
// - Pre-fill (WCAG 3.3.7, no redundant entry): the checkout's own primary contact when it has one; else the first adult
//   traveller's name and, for a signed-in customer, the account's name, e-mail and phone.
// - Controls are named after the request's JSON pointers (`contacts.0.emailAddress`), with `data-error-path` for the
//   pointers of whole parts (`/contacts/0/phones`, `/contacts/0/address`), so lib/forms.js marks the field of every
//   `CONTACT_DATA_INVALID` error. Hidden parts are disabled, so the browser neither checks nor sends them.
// - `read()` gives the `contacts` of `checkout.setContacts`: the primary STANDARD contact first, then the INVOICE
//   contact. Phone numbers are sent as digits only and the calling code without "+", as Amadeus expects.

import { ADULT_TYPES, fillCountrySelect } from "./traveller-form.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["CheckoutContactRequirements"]} ContactRequirements */
/** @typedef {import("@velexis/ota-sdk").Schemas["Contact"]} Contact */
/** @typedef {import("@velexis/ota-sdk").Schemas["ContactInput"]} ContactInput */
/** @typedef {import("@velexis/ota-sdk").Schemas["Traveler"]} Traveller */
/** @typedef {import("@velexis/ota-sdk").Schemas["Customer"]} Customer */
/** @typedef {import("@velexis/ota-sdk").Schemas["AmadeusAddress"]} Address */
/** @typedef {import("./traveller-form.js").CountryOption} CountryOption */
/** @typedef {HTMLInputElement | HTMLSelectElement} Control */

/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * The values the contact step starts with: the checkout's contacts, else the first adult traveller and the account.
 * @param {{ contacts: ReadonlyArray<Contact>, travelers: ReadonlyArray<Traveller>, account: Customer | null }} data
 * @returns {Record<string, string>} values by control name
 */
export function contactDefaults({ contacts, travelers, account }) {
  const primary =
    contacts.find((contact) => contact.isPrimary && contact.purpose !== "INVOICE") ??
    contacts.find((contact) => contact.purpose !== "INVOICE") ??
    null;
  const invoice = contacts.find((contact) => contact.purpose === "INVOICE") ?? null;
  /** @type {Record<string, string>} */
  const values = {};
  /**
   * @param {string} prefix
   * @param {Address | null | undefined} address
   */
  const addAddress = (prefix, address) => {
    values[`${prefix}.address.lines.0`] = text(address?.lines?.[0]);
    values[`${prefix}.address.postalCode`] = text(address?.postalCode);
    values[`${prefix}.address.cityName`] = text(address?.cityName);
    values[`${prefix}.address.countryCode`] = text(address?.countryCode);
  };
  if (primary) {
    values["contacts.0.addresseeName.firstName"] = text(primary.addresseeName?.firstName);
    values["contacts.0.addresseeName.lastName"] = text(primary.addresseeName?.lastName);
    values["contacts.0.emailAddress"] = text(primary.emailAddress);
    values["contacts.0.phones.0.countryCallingCode"] = text(primary.phones?.[0]?.countryCallingCode);
    values["contacts.0.phones.0.number"] = text(primary.phones?.[0]?.number);
    addAddress("contacts.0", primary.address);
  } else {
    const adult = travelers.find(
      (traveller) => ADULT_TYPES.has(String(traveller.travelerType)) && text(traveller.name?.lastName) !== "",
    );
    const first = adult ? text(adult.name?.firstName) : text(account?.firstName);
    const last = adult ? text(adult.name?.lastName) : text(account?.lastName);
    values["contacts.0.addresseeName.firstName"] = first;
    values["contacts.0.addresseeName.lastName"] = last;
    values["contacts.0.emailAddress"] = text(account?.email);
    values["contacts.0.phones.0.countryCallingCode"] = text(account?.phone?.countryCallingCode);
    values["contacts.0.phones.0.number"] = text(account?.phone?.number);
  }
  if (invoice) {
    values["contacts.1.companyName"] = text(invoice.companyName);
    values["contacts.1.emailAddress"] = text(invoice.emailAddress);
    addAddress("contacts.1", invoice.address);
  }
  return values;
}

/**
 * Mounts the contact step on its form: fills it from the checkout, sets what is required and shows the address parts
 * the airline asks for. `read()` gives the `contacts` of `checkout.setContacts`.
 * @param {HTMLFormElement} form
 * @param {{ requirements: ContactRequirements, contacts: ReadonlyArray<Contact>, travelers: ReadonlyArray<Traveller>, account: Customer | null, countries: ReadonlyArray<CountryOption> | null, language?: string | null }} props
 */
export function mount(form, { requirements, contacts, travelers, account, countries, language = null }) {
  const values = contactDefaults({ contacts, travelers, account });
  const mailing = /** @type {HTMLElement} */ (form.querySelector("[data-mailing-address]"));
  const invoice = /** @type {HTMLElement} */ (form.querySelector("[data-invoice]"));
  const toggle = /** @type {HTMLInputElement} */ (form.querySelector("input[data-invoice-toggle]"));
  const toggleNote = /** @type {HTMLElement | null} */ (form.querySelector("[data-invoice-required]"));
  const hasInvoice = contacts.some((contact) => contact.purpose === "INVOICE");

  /** @param {string} name */
  const control = (name) => /** @type {Control | null} */ (form.querySelector(`[name="${name}"]`));
  for (const select of /** @type {HTMLSelectElement[]} */ (
    Array.from(form.querySelectorAll("select[data-countries]"))
  )) {
    fillCountrySelect(select, countries, values[select.name] ?? "");
  }
  for (const [name, value] of Object.entries(values)) {
    const element = control(name);
    if (element && element.tagName !== "SELECT") {
      element.value = value;
    }
  }
  /** @param {string} name @param {boolean} required */
  const require = (name, required) => {
    const element = control(name);
    if (element) {
      element.required = required;
    }
  };
  /**
   * Shows or hides a part and enables or disables its controls with it.
   * @param {HTMLElement} part
   * @param {boolean} shown
   */
  const showPart = (part, shown) => {
    part.hidden = !shown;
    for (const element of /** @type {Control[]} */ (Array.from(part.querySelectorAll("input, select")))) {
      element.disabled = !shown;
    }
  };

  require("contacts.0.emailAddress", true);
  require("contacts.0.phones.0.number", requirements.mobilePhoneRequired || requirements.phoneRequired);
  require("contacts.0.phones.0.countryCallingCode", requirements.phoneCountryCodeRequired);
  require("contacts.0.address.postalCode", requirements.mailingAddressRequired &&
    requirements.postalCodeRequired);
  require("contacts.1.address.postalCode", requirements.postalCodeRequired);
  showPart(mailing, requirements.mailingAddressRequired);

  const syncInvoice = () => showPart(invoice, toggle.checked);
  toggle.checked = requirements.invoiceAddressRequired || hasInvoice;
  // An invoice the airline requires cannot be switched off.
  toggle.disabled = requirements.invoiceAddressRequired;
  if (toggleNote) {
    toggleNote.hidden = !requirements.invoiceAddressRequired;
  }
  toggle.addEventListener("change", syncInvoice);
  syncInvoice();

  /** @param {string} name */
  const value = (name) => {
    const element = control(name);
    return element && !element.disabled ? element.value.trim() : "";
  };
  /**
   * The address of a contact, or `undefined` when it is empty.
   * @param {string} prefix
   * @returns {Address | undefined}
   */
  const addressOf = (prefix) => {
    const line = value(`${prefix}.address.lines.0`);
    /** @type {Address} */
    const address = {
      ...(line !== "" ? { lines: [line] } : {}),
      ...(value(`${prefix}.address.postalCode`) !== ""
        ? { postalCode: value(`${prefix}.address.postalCode`) }
        : {}),
      ...(value(`${prefix}.address.cityName`) !== ""
        ? { cityName: value(`${prefix}.address.cityName`) }
        : {}),
      ...(value(`${prefix}.address.countryCode`) !== ""
        ? { countryCode: value(`${prefix}.address.countryCode`).toUpperCase() }
        : {}),
    };
    return Object.keys(address).length > 0 ? address : undefined;
  };

  return {
    /** @returns {ContactInput[]} */
    read() {
      const firstName = value("contacts.0.addresseeName.firstName");
      const lastName = value("contacts.0.addresseeName.lastName");
      const number = value("contacts.0.phones.0.number").replace(/\D/g, "");
      const callingCode = value("contacts.0.phones.0.countryCallingCode").replace(/\D/g, "");
      const address = addressOf("contacts.0");
      /** @type {ContactInput} */
      const primary = {
        purpose: "STANDARD",
        isPrimary: true,
        ...(firstName !== "" || lastName !== ""
          ? {
              addresseeName: {
                ...(firstName !== "" ? { firstName } : {}),
                ...(lastName !== "" ? { lastName } : {}),
              },
            }
          : {}),
        emailAddress: value("contacts.0.emailAddress"),
        ...(number !== ""
          ? {
              phones: [
                {
                  deviceType: "MOBILE",
                  ...(callingCode !== "" ? { countryCallingCode: callingCode } : {}),
                  number,
                },
              ],
            }
          : {}),
        ...(address ? { address } : {}),
        ...(typeof language === "string" && /^[a-z]{2}$/.test(language) ? { language } : {}),
      };
      /** @type {ContactInput[]} */
      const result = [primary];
      if (toggle.checked) {
        const company = value("contacts.1.companyName");
        const email = value("contacts.1.emailAddress");
        const invoiceAddress = addressOf("contacts.1");
        result.push({
          purpose: "INVOICE",
          isPrimary: false,
          ...(company !== "" ? { companyName: company } : {}),
          ...(email !== "" ? { emailAddress: email } : {}),
          ...(invoiceAddress ? { address: invoiceAddress } : {}),
        });
      }
      return result;
    },
    destroy() {
      toggle.removeEventListener("change", syncInvoice);
    },
  };
}
