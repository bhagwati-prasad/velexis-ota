// The checkout data page (ota/frontend/docs/pages.md §7) and the price page's Continue (§6, step 4): checkout.html and
// price.html with their partials expanded by the build's include plugin, run by src/pages/checkout.js and
// src/pages/price.js against a fake SDK. It covers the four steps (travellers from `requirements` with the countries,
// contacts pre-filled from the first adult and the account, extras with the airline's new total confirmed, special
// requests, payment methods and terms), `ifMatch` with the displayed version on every `set*` call and the `412`
// re-apply, field errors with the focused error summary, the airline-card option only when listed, the other states
// of §7, the history entries of the steps, and the page's script inventory.
import {
  ConflictError,
  ExpiredError,
  PermissionError,
  PriceChangedError,
  ServerError,
  SupplierError,
  ValidationError,
  VelexisError,
  AuthenticationError,
  ConnectionError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { optionGroups, sameSelections, selectionsOf } from "../src/components/ancillary-picker.js";
import { contactDefaults } from "../src/components/contact-form.js";
import { remapTravellerPointers, stepOfPointer } from "../src/components/error-summary.js";
import { checkoutSteps, firstIncompleteStep, isReachable, stepToShow } from "../src/components/stepper.js";
import { formatMoney } from "../src/lib/format.js";
import {
  CHECKOUT_ID as CHECKOUT_ID_PATTERN,
  loadCountries,
  paymentMethods,
  readRemarks,
  sameRemarks,
  start,
} from "../src/pages/checkout.js";
import { start as startPrice } from "../src/pages/price.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** What the mocked boot() of the page modules resolves with; `null` keeps it waiting (the static imports above). */
const pageBoot = vi.hoisted(() => ({ context: /** @type {unknown} */ (null) }));
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    boot: () => (pageBoot.context ? Promise.resolve(pageBoot.context) : new Promise(() => {})),
  };
});

const CHECKOUT_ID = "chk_01JCHECKOUTPAGE00001";
const BASE_ID = "prc_01JCHECKOUTBASE00001";
const CHILD_ID = "prc_01JCHECKOUTEXTRAS001";
const OFFER_ID = "off_01JCHECKOUTOFFER0001";
const PAYMENT_ID = "pay_01JCHECKOUTPAY000001";
const BOOKING_ID = "bkg_01JCHECKOUTBOOK00001";
const BAG_ID = "anc_01JCHECKOUTBAG000001";
const BAG_TWO_ID = "anc_01JCHECKOUTBAG000002";
const PRIORITY_ID = "anc_01JCHECKOUTPRIO00001";
/** How long the polite live region waits before it speaks (components/live-region.js), with a margin. */
const ANNOUNCED_MS = 200;

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });
/** @param {string} amount */
const money = (amount) => formatMoney(eur(amount), "en-GB");

/**
 * A `YYYY-MM-DD` date some days from today (negative: in the past).
 * @param {number} days
 */
function dateFromToday(days) {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days))
    .toISOString()
    .slice(0, 10);
}
/** An ISO timestamp `seconds` from now. */
const fromNow = (/** @type {number} */ seconds) => new Date(Date.now() + seconds * 1000).toISOString();

const CONFIG = Object.freeze({
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { ancillaries: true, seatSelection: false, guestCheckout: true, customerAccounts: true },
  legal: { termsUrl: "https://demo-travel.example/terms", privacyUrl: "/p/privacy" },
  payment: {
    provider: "stripe",
    supportedMethods: ["card"],
    pspCardBrands: [
      { amadeus: "VISA", psp: "visa", label: "Visa" },
      { amadeus: "MASTERCARD", psp: "mastercard", label: "Mastercard" },
    ],
    airlineCard: null,
  },
});
const AIRLINE_CARD_NOTICE = "The airline charges your card. The price is the airline's price.";
const AIRLINE_CONFIG = Object.freeze({
  ...CONFIG,
  payment: {
    ...CONFIG.payment,
    supportedMethods: ["card", "airline_card"],
    airlineCard: { enabled: true, cardBrands: [], chargedBy: "airline", notice: AIRLINE_CARD_NOTICE },
  },
});
const NO_EXTRAS_CONFIG = Object.freeze({ ...CONFIG, features: { ...CONFIG.features, ancillaries: false } });
/** A signed-in customer: the account pre-fills the contact. */
const SESSION = Object.freeze({
  customer: {
    id: "cus_01JCHECKOUTCUSTOMER1",
    email: "anna.berg@example.com",
    firstName: "Anna",
    lastName: "Berg",
    phone: { deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" },
  },
  session: { id: "ses_01JCHECKOUTSESSION01" },
});

const INCOMPLETE = Object.freeze({
  travelersComplete: false,
  contactsComplete: false,
  paymentReady: false,
  readyToComplete: false,
  missing: [],
});
const COMPLETE = Object.freeze({ ...INCOMPLETE, travelersComplete: true, contactsComplete: true });

/** The flight: one way Paris–New York. */
const ITINERARY = Object.freeze({
  index: 0,
  originCode: "CDG",
  destinationCode: "JFK",
  departureAt: `${dateFromToday(30)}T10:00:00`,
  arrivalAt: `${dateFromToday(30)}T12:20:00`,
  duration: "PT8H20M",
  durationMinutes: 500,
  stops: 0,
  stopAirports: [],
  arrivalDayOffset: 0,
  marketingCarriers: ["AF"],
  segments: [],
});

/**
 * One traveller of the checkout, as the API returns it.
 * @param {string} travelerId
 * @param {string} travelerType
 * @param {Record<string, unknown>} [data]
 */
const traveller = (travelerId, travelerType, data = {}) => ({
  id: `ctr_01JCHECKOUTTRAV0000${travelerId}`,
  travelerId,
  travelerType,
  associatedAdultId: travelerType === "HELD_INFANT" ? "1" : null,
  name: null,
  dateOfBirth: null,
  gender: null,
  documents: [],
  discountEligibility: [],
  complete: false,
  ...data,
});

/**
 * The checkout: an adult with a passport or ID card and an infant on her lap, at version 3.
 * @param {Record<string, unknown>} [overrides]
 */
function checkout(overrides = {}) {
  return {
    id: CHECKOUT_ID,
    status: "open",
    customerId: null,
    isGuest: true,
    channel: "storefront",
    pricedOfferId: BASE_ID,
    basePricedOfferId: BASE_ID,
    offerIds: [OFFER_ID],
    currency: "EUR",
    totals: {
      currency: "EUR",
      offer: eur("412.30"),
      ancillaries: eur("0.00"),
      cardFee: null,
      total: eur("412.30"),
    },
    priceChange: null,
    requirements: {
      contact: {
        emailRequired: true,
        mobilePhoneRequired: true,
        phoneRequired: false,
        phoneCountryCodeRequired: true,
        invoiceAddressRequired: false,
        mailingAddressRequired: false,
        postalCodeRequired: false,
        maxContacts: 3,
      },
      travelers: [
        {
          travelerId: "1",
          travelerType: "ADULT",
          associatedAdultId: null,
          dateOfBirthMin: null,
          dateOfBirthMax: dateFromToday(-12 * 365),
          requiredFields: ["name", "dateOfBirth", "gender", "documents"],
          documentTypes: ["PASSPORT", "IDENTITY_CARD"],
        },
        {
          travelerId: "2",
          travelerType: "HELD_INFANT",
          associatedAdultId: "1",
          dateOfBirthMin: dateFromToday(-700),
          dateOfBirthMax: dateFromToday(-1),
          requiredFields: ["name", "dateOfBirth"],
          documentTypes: ["PASSPORT"],
        },
      ],
      threeDomainSecureRequired: false,
      paymentCardRequired: false,
    },
    progress: INCOMPLETE,
    travelers: [traveller("1", "ADULT"), traveller("2", "HELD_INFANT")],
    contacts: [],
    ancillaries: [],
    remarks: [],
    payment: null,
    itineraries: [ITINERARY],
    summary: { tripType: "one_way" },
    conditions: null,
    ticketing: {
      policy: "issue_after_payment",
      paymentTiming: "authorize_before_booking",
      instantTicketingRequired: false,
      lastTicketingDate: null,
    },
    bookingId: null,
    version: 3,
    expiresAt: fromNow(30 * 60),
    createdAt: fromNow(-60),
    updatedAt: fromNow(-60),
    ...overrides,
  };
}

/**
 * One option of the extras catalogue.
 * @param {string} id
 * @param {"CHECKED_BAGS" | "OTHER_SERVICES"} type
 * @param {string} label
 * @param {string} price
 * @param {Record<string, unknown>} [extra]
 */
const option = (id, type, label, price, extra = {}) => ({
  id,
  type,
  name: type === "CHECKED_BAGS" ? "CHECKED_BAG" : "PRIORITY_BOARDING",
  label,
  offerId: OFFER_ID,
  travelerIds: ["1"],
  segmentIds: ["1"],
  serviceName: type === "OTHER_SERVICES" ? "PRIORITY_BOARDING" : null,
  requiresSeatNumber: false,
  price: eur(price),
  amadeus: {},
  ...extra,
});

/** The extras of the adult: one or two extra bags on the flight, and priority boarding. */
function catalogue() {
  return {
    pricedOfferId: BASE_ID,
    currency: "EUR",
    travelers: [
      { travelerId: "1", travelerType: "ADULT" },
      { travelerId: "2", travelerType: "HELD_INFANT" },
    ],
    segments: [
      {
        segmentId: "1",
        offerId: OFFER_ID,
        itineraryIndex: 0,
        originCode: "CDG",
        destinationCode: "JFK",
        flightNumber: "AF1234",
      },
    ],
    checkedBags: [
      option(BAG_ID, "CHECKED_BAGS", "1 extra checked bag (23 kg)", "35.00"),
      option(BAG_TWO_ID, "CHECKED_BAGS", "2 extra checked bags (23 kg each)", "60.00"),
    ],
    cabinBags: [],
    otherServices: [option(PRIORITY_ID, "OTHER_SERVICES", "Priority boarding", "12.00")],
    seats: [],
    seatsSupported: false,
    expiresAt: fromNow(30 * 60),
  };
}

/** The countries in two pages, as `reference.countries.list` pages them. */
function countriesPage() {
  return {
    data: [
      { code: "FR", name: "France" },
      { code: "SE", name: "Sweden" },
    ],
    page: { nextCursor: "c_2", limit: 100 },
    next: async () => ({
      data: [{ code: "GB", name: "United Kingdom" }],
      page: { nextCursor: null, limit: 100 },
      next: async () => null,
    }),
  };
}

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({
    code,
    message: `${code} from the fake API`,
    status,
    requestId: "req_checkoutpage",
    ...body,
  });

/**
 * A fake API with the checkout as state: every change returns the whole checkout at the next version, as the API does.
 * Each method can be replaced.
 * @param {{ checkout?: ReturnType<typeof checkout>, catalogue?: object | null } & Record<string, Function | undefined>} [options]
 */
function fakeApi({ checkout: initial = checkout(), catalogue: extras = catalogue(), ...overrides } = {}) {
  const api = { current: initial };
  /** @param {Record<string, unknown>} changes */
  const bump = (changes) => {
    api.current = { ...api.current, ...changes, version: api.current.version + 1 };
    return api.current;
  };
  const client = {
    checkout: {
      get: vi.fn(overrides.get ?? (async () => api.current)),
      setTravelers: vi.fn(
        overrides.setTravelers ??
          (async (/** @type {{ travelers: Array<Record<string, any>> }} */ { travelers }) =>
            bump({
              travelers: travelers.map((input) => ({
                ...traveller(input.travelerId, input.travelerId === "1" ? "ADULT" : "HELD_INFANT"),
                name: input.name ?? null,
                dateOfBirth: input.dateOfBirth ?? null,
                gender: input.gender ?? null,
                // Responses carry the masked number only.
                documents: (input.documents ?? []).map((/** @type {Record<string, string>} */ document) => {
                  const { number, ...rest } = document;
                  return { ...rest, numberMasked: `•••••${String(number ?? "0000").slice(-4)}` };
                }),
                complete: true,
              })),
              progress: { ...api.current.progress, travelersComplete: true },
            })),
      ),
      setContacts: vi.fn(
        overrides.setContacts ??
          (async (/** @type {{ contacts: Array<Record<string, unknown>> }} */ { contacts }) =>
            bump({
              contacts: contacts.map((contact, index) => ({
                id: `cco_01JCHECKOUTCONTACT0${index}`,
                ...contact,
              })),
              progress: { ...api.current.progress, contactsComplete: true },
            })),
      ),
      setAncillaries: vi.fn(
        overrides.setAncillaries ??
          (async (
            /** @type {{ selections: Array<Record<string, string>>, expectedTotal: object }} */ {
              selections,
              expectedTotal,
            },
          ) =>
            bump({
              pricedOfferId: CHILD_ID,
              ancillaries: selections.map((selection, index) => ({
                id: `can_01JCHECKOUTEXTRA000${index}`,
                optionId: selection.optionId,
                type: "CHECKED_BAGS",
                label: "1 extra checked bag (23 kg)",
                travelerId: selection.travelerId,
                segmentIds: ["1"],
                price: eur("35.00"),
              })),
              totals: { ...api.current.totals, ancillaries: eur("35.00"), total: expectedTotal },
            })),
      ),
      setRemarks: vi.fn(
        overrides.setRemarks ??
          (async (/** @type {{ remarks: Array<Record<string, unknown>> }} */ { remarks }) =>
            bump({
              remarks: remarks.map((remark, index) => ({
                id: `crm_01JCHECKOUTREMARK00${index}`,
                kind: "general",
                subType: "GENERAL_MISCELLANEOUS",
                text: String(remark.text).toUpperCase(),
                travelerIds: remark.travelerIds ?? [],
                source: "customer",
                createdAt: fromNow(0),
              })),
            })),
      ),
      createPayment: vi.fn(
        overrides.createPayment ??
          (async (/** @type {{ method: string }} */ { method }) => ({
            id: PAYMENT_ID,
            checkoutId: CHECKOUT_ID,
            method,
            status: "requires_payment_method",
          })),
      ),
    },
    flights: { getAncillaries: vi.fn(overrides.getAncillaries ?? (async () => extras)) },
    reference: { countries: { list: vi.fn(overrides.listCountries ?? (async () => countriesPage())) } },
  };
  return { api, client };
}

/** @type {Browser | undefined} */
let browser;
/** The parsed pages, by file. @type {Record<string, Document>} */
const pageDocuments = {};
/** The expanded HTML of checkout.html (the script inventory test). */
let checkoutHtml = "";
/** The test window's address and title before each test. */
const original = { address: "", title: "" };
/** Views started by the current test, destroyed after it. */
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands checkout.html and price.html with the build's include plugin and parses them once in a happy-dom browser;
  // each test imports a fresh copy of a page's body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  for (const file of ["checkout.html", "price.html"]) {
    const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, file), "utf8"), {
      path: `/${file}`,
    });
    if (file === "checkout.html") {
      checkoutHtml = html;
    }
    const page = browser.newPage();
    page.url = `${location.origin}/${file}`;
    page.content = html;
    pageDocuments[file] = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
  }
}, 15_000); // file reads, the include plugin and one happy-dom browser with two pages; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
  if (original.title !== "") {
    document.title = original.title;
  }
  if (original.address !== "") {
    history.replaceState(null, "", original.address);
  }
});

/**
 * Puts a fresh copy of a page's body into the test document at `path`.
 * @param {string} file
 * @param {string} path
 */
function showPage(file, path) {
  original.address ||= `${location.pathname}${location.search}`;
  original.title ||= document.title;
  const source = /** @type {Document} */ (pageDocuments[file]);
  document.body.replaceChildren(
    ...Array.from(source.body.childNodes, (node) => document.importNode(node, true)),
  );
  document.title = source.title;
  history.replaceState(null, "", path);
}

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
};

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const texts = (/** @type {string} */ selector) => Array.from(document.querySelectorAll(selector), text);
const field = (/** @type {string} */ name) =>
  /** @type {HTMLInputElement | HTMLSelectElement} */ (document.querySelector(`[name="${name}"]`));
const shownStep = () =>
  Array.from(document.querySelectorAll("section[data-step]"))
    .filter((section) => !(/** @type {HTMLElement} */ (section).hidden))
    .map((section) => section.getAttribute("data-step"));
const stepForm = (/** @type {string} */ step) =>
  /** @type {HTMLFormElement} */ (document.querySelector(`form[data-step-form="${step}"]`));
const stepper = () =>
  Array.from(document.querySelectorAll("[data-stepper-list] > li"), (item) => [
    text(item.querySelector('[data-field="label"]')),
    item.getAttribute("data-status"),
    item.querySelector("a[data-step-link]")?.getAttribute("href") ?? null,
  ]);

/**
 * Sets a control's value as the traveller would (an `input` and a `change` event).
 * @param {string} name
 * @param {string} value
 */
function type(name, value) {
  const control = field(name);
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Submits a step's form as its Continue button does, then lets the fake SDK answer. */
async function submit(/** @type {string} */ step) {
  const target = stepForm(step);
  target.requestSubmit(/** @type {HTMLButtonElement} */ (target.querySelector('button[type="submit"]')));
  await settle();
}

/** The adult's and the infant's data. */
function fillTravellers() {
  type("travelers.0.name.firstName", "Anna");
  type("travelers.0.name.lastName", "Berg");
  type("travelers.0.dateOfBirth", "1985-04-12");
  type("travelers.0.gender", "FEMALE");
  type("travelers.0.documents.0.documentType", "PASSPORT");
  type("travelers.0.documents.0.number", "X1234567");
  type("travelers.0.documents.0.expiryDate", dateFromToday(2000));
  type("travelers.0.documents.0.issuanceCountry", "SE");
  type("travelers.0.documents.0.nationality", "SE");
  type("travelers.1.name.firstName", "Leo");
  type("travelers.1.name.lastName", "Berg");
  type("travelers.1.dateOfBirth", dateFromToday(-200));
}

/**
 * The primary contact's data.
 * @param {string} [email]
 */
function fillContact(email = "anna@example.com") {
  type("contacts.0.addresseeName.firstName", "Anna");
  type("contacts.0.addresseeName.lastName", "Berg");
  type("contacts.0.emailAddress", email);
  type("contacts.0.phones.0.countryCallingCode", "+46");
  type("contacts.0.phones.0.number", "701234567");
}

/**
 * Starts the checkout page at `/checkout.html?<query>` with a fake SDK.
 * @param {{ query?: string, fake?: ReturnType<typeof fakeApi>, config?: object, session?: object | null }} [options]
 */
async function openCheckout({
  query = `id=${CHECKOUT_ID}&step=travellers`,
  fake = fakeApi(),
  config = CONFIG,
  session = null,
} = {}) {
  showPage("checkout.html", `/checkout.html?${query}`);
  const navigate = vi.fn();
  const replace = vi.fn();
  const view = start(
    {
      config: /** @type {never} */ (config),
      client: /** @type {never} */ (fake.client),
      session: /** @type {never} */ (session),
    },
    { navigate, replace },
  );
  if (!view) {
    throw new Error("the checkout page did not start");
  }
  views.push(view);
  await view.done;
  await settle();
  return { view, ...fake, navigate, replace };
}

describe("checkout page: steps and data", () => {
  it("[OFE-011] shows the travellers step with the fields of the requirements and the countries", async () => {
    const { client } = await openCheckout();

    expect(client.checkout.get).toHaveBeenCalledWith(
      { checkoutId: CHECKOUT_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Both pages of the country list are read, with the OTA's locale.
    expect(client.reference.countries.list).toHaveBeenCalledWith(
      { limit: 100 },
      expect.objectContaining({ locale: "en-GB" }),
    );
    expect(shownStep()).toEqual(["travellers"]);
    expect(document.title).toBe("Travellers – Checkout");
    expect(stepper()).toEqual([
      ["1. Travellers", "current", `/checkout.html?id=${CHECKOUT_ID}&step=travellers`],
      ["2. Contact details", "locked", null],
      ["3. Extras", "locked", null],
      ["4. Payment", "locked", null],
    ]);
    expect($('[data-step-link][aria-current="step"]')).not.toBeNull();

    const fieldsets = document.querySelectorAll("[data-travellers] > fieldset[data-traveller]");
    expect(fieldsets).toHaveLength(2);
    expect(texts("[data-travellers] > fieldset > legend")).toEqual([
      "Traveller 1: Adult",
      "Traveller 2: Infant on a lap",
    ]);
    expect(text(fieldsets[1]?.querySelector('[data-field="hint"]'))).toBe(
      "Travels on the lap of traveller 1.",
    );
    // The adult: name, date of birth, gender and a passport or ID card; the infant: name and date of birth only.
    expect(fieldsets[0]?.querySelectorAll("[data-section]")).toHaveLength(3);
    expect(field("travelers.0.gender")).not.toBeNull();
    expect(field("travelers.1.gender")).toBeNull();
    expect(field("travelers.1.documents.0.number")).toBeNull();
    expect(field("travelers.1.dateOfBirth").getAttribute("min")).toBe(dateFromToday(-700));
    expect(field("travelers.1.dateOfBirth").getAttribute("max")).toBe(dateFromToday(-1));
    expect(
      Array.from(
        /** @type {HTMLSelectElement} */ (field("travelers.0.documents.0.documentType")).options,
        (o) => o.text,
      ),
    ).toEqual(["Passport", "ID card"]);
    const nationality = /** @type {HTMLSelectElement} */ (field("travelers.0.documents.0.nationality"));
    expect(Array.from(nationality.options, (o) => [o.value, o.text])).toEqual([
      ["", "Choose a country"],
      ["FR", "France"],
      ["SE", "Sweden"],
      ["GB", "United Kingdom"],
    ]);
    expect(field("travelers.0.documents.0.issuanceCountry").tagName).toBe("SELECT");
    // One autofill section per traveller; document numbers are never autofilled.
    expect(field("travelers.0.name.firstName").getAttribute("autocomplete")).toBe(
      "section-traveller-1 given-name",
    );
    expect(field("travelers.1.name.lastName").getAttribute("autocomplete")).toBe(
      "section-traveller-2 family-name",
    );
    expect(field("travelers.0.documents.0.number").getAttribute("autocomplete")).toBe("off");
    // The summary: the API's totals and the hold time; Back leads to the price page.
    expect(text($("[data-total]"))).toBe(money("412.30"));
    expect($("[data-total-card-fee-row]").hidden).toBe(true);
    expect(text($("[data-checkout-expiry]"))).toMatch(/^We hold this price until /);
    expect($("a[data-back-link]").getAttribute("href")).toBe(`/price.html?priced=${BASE_ID}`);
  });

  it("[OFE-011] a stored document keeps its number: the field is optional and the number is not sent", async () => {
    const stored = checkout({
      travelers: [
        traveller("1", "ADULT", {
          name: { firstName: "Anna", lastName: "Berg" },
          dateOfBirth: "1985-04-12",
          gender: "FEMALE",
          documents: [
            {
              documentType: "PASSPORT",
              numberMasked: "•••••4567",
              expiryDate: dateFromToday(2000),
              issuanceCountry: "SE",
              nationality: "SE",
            },
          ],
        }),
        traveller("2", "HELD_INFANT", {
          name: { firstName: "Leo", lastName: "Berg" },
          dateOfBirth: dateFromToday(-200),
        }),
      ],
    });
    const { client } = await openCheckout({ fake: fakeApi({ checkout: stored }) });

    const number = /** @type {HTMLInputElement} */ (field("travelers.0.documents.0.number"));
    expect(number.value).toBe("");
    expect(number.required).toBe(false);
    const hint = document.getElementById(/** @type {string} */ (number.getAttribute("aria-describedby")));
    expect(text(hint)).toContain("•••••4567");
    expect(field("travelers.0.documents.0.nationality").value).toBe("SE");
    expect(field("travelers.0.name.firstName").value).toBe("Anna");
    expect(texts("[data-travellers] > fieldset > legend")[0]).toBe("Traveller 1: Anna Berg, adult");

    // Another issuing country is another document: its number is needed again.
    type("travelers.0.documents.0.issuanceCountry", "FR");
    expect(number.required).toBe(true);
    type("travelers.0.documents.0.issuanceCountry", "SE");
    expect(number.required).toBe(false);

    await submit("travellers");
    const [params] = /** @type {[{ travelers: Array<Record<string, any>> }]} */ (
      client.checkout.setTravelers.mock.calls[0]
    );
    expect(params.travelers[0]).toEqual({
      travelerId: "1",
      name: { firstName: "Anna", lastName: "Berg" },
      dateOfBirth: "1985-04-12",
      gender: "FEMALE",
      documents: [
        {
          documentType: "PASSPORT",
          expiryDate: dateFromToday(2000),
          issuanceCountry: "SE",
          nationality: "SE",
          holder: true,
        },
      ],
    });
  });

  it("[OFE-011 AC1] every set* call sends ifMatch with the displayed version, through all four steps", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeApi();
    // The page sends the total on the screen; the airline's total with the bag comes back as a price change. After
    // the confirmation the fake answers as the API does.
    const confirmed = /** @type {import("vitest").Mock} */ (fake.client.checkout.setAncillaries);
    confirmed.mockRejectedValueOnce(
      apiError(PriceChangedError, "PRICE_CHANGED", 409, {
        details: { oldPrice: eur("412.30"), newPrice: eur("447.30"), pricedOfferId: CHILD_ID },
      }),
    );
    const pushState = vi.spyOn(history, "pushState");
    const { client } = await openCheckout({ fake, session: SESSION });

    // 1. Travellers, at version 3.
    fillTravellers();
    await submit("travellers");
    expect(client.checkout.setTravelers).toHaveBeenCalledTimes(1);
    expect(client.checkout.setTravelers).toHaveBeenCalledWith({
      checkoutId: CHECKOUT_ID,
      ifMatch: 3,
      travelers: [
        {
          travelerId: "1",
          name: { firstName: "Anna", lastName: "Berg" },
          dateOfBirth: "1985-04-12",
          gender: "FEMALE",
          documents: [
            {
              documentType: "PASSPORT",
              number: "X1234567",
              expiryDate: dateFromToday(2000),
              issuanceCountry: "SE",
              nationality: "SE",
              holder: true,
            },
          ],
        },
        { travelerId: "2", name: { firstName: "Leo", lastName: "Berg" }, dateOfBirth: dateFromToday(-200) },
      ],
    });
    // The saved travellers come back without the number: the field is empty again.
    expect(field("travelers.0.documents.0.number").value).toBe("");

    // 2. Contacts, at version 4: pre-filled from the first adult and the account.
    expect(shownStep()).toEqual(["contacts"]);
    expect(document.activeElement).toBe($("#step-contacts-title"));
    expect(field("contacts.0.addresseeName.firstName").value).toBe("Anna");
    expect(field("contacts.0.addresseeName.lastName").value).toBe("Berg");
    expect(field("contacts.0.emailAddress").value).toBe("anna.berg@example.com");
    expect(field("contacts.0.phones.0.countryCallingCode").value).toBe("46");
    expect(field("contacts.0.phones.0.number").value).toBe("701234567");
    expect(field("contacts.0.phones.0.number").required).toBe(true);
    type("contacts.0.phones.0.number", "70 123 45 67");
    await submit("contacts");
    expect(client.checkout.setContacts).toHaveBeenCalledWith({
      checkoutId: CHECKOUT_ID,
      ifMatch: 4,
      contacts: [
        {
          purpose: "STANDARD",
          isPrimary: true,
          addresseeName: { firstName: "Anna", lastName: "Berg" },
          emailAddress: "anna.berg@example.com",
          phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
          language: "en",
        },
      ],
    });

    // 3. Extras, at version 5, from the base priced offer's catalogue.
    expect(shownStep()).toEqual(["extras"]);
    expect(client.flights.getAncillaries).toHaveBeenCalledWith(
      { pricedOfferId: BASE_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const bag = /** @type {HTMLInputElement} */ (
      document.querySelector(`input[data-ancillary-input][value="${BAG_ID}"]`)
    );
    expect(bag.type).toBe("radio");
    bag.checked = true;
    bag.dispatchEvent(new Event("change", { bubbles: true }));
    type("remarks.0.text", "Child meal for Leo if possible");
    await submit("extras");
    expect(confirmed).toHaveBeenNthCalledWith(1, {
      checkoutId: CHECKOUT_ID,
      ifMatch: 5,
      selections: [{ optionId: BAG_ID, travelerId: "1" }],
      expectedTotal: eur("412.30"),
    });
    // The new total is shown and waits for confirmation; the checkout (and its total) are unchanged.
    expect($("[data-extras-change]").hidden).toBe(false);
    expect(text($("[data-extras-change-text]"))).toBe(
      `With these extras the airline's total is ${money("447.30")} (before: ${money("412.30")}).`,
    );
    expect(text($("button[data-extras-submit]"))).toBe(`Confirm the new total, ${money("447.30")}`);
    expect(text($("[data-total]"))).toBe(money("412.30"));
    expect(bag.checked).toBe(true);
    expect(client.checkout.setRemarks).not.toHaveBeenCalled();
    expect(shownStep()).toEqual(["extras"]);

    await submit("extras");
    expect(confirmed).toHaveBeenNthCalledWith(2, {
      checkoutId: CHECKOUT_ID,
      ifMatch: 5,
      selections: [{ optionId: BAG_ID, travelerId: "1" }],
      expectedTotal: eur("447.30"),
    });
    // Then the special request, at version 6.
    expect(client.checkout.setRemarks).toHaveBeenCalledWith({
      checkoutId: CHECKOUT_ID,
      ifMatch: 6,
      remarks: [{ text: "Child meal for Leo if possible" }],
    });

    // 4. Payment: the API's new total.
    expect(shownStep()).toEqual(["payment"]);
    expect(text($("[data-payment-total]"))).toBe(money("447.30"));
    expect(text($("[data-total]"))).toBe(money("447.30"));
    expect(text($("[data-total-extras]"))).toBe(money("35.00"));
    // Each step was its own history entry.
    expect(pushState.mock.calls.map((call) => call[2])).toEqual([
      `/checkout.html?id=${CHECKOUT_ID}&step=contacts`,
      `/checkout.html?id=${CHECKOUT_ID}&step=extras`,
      `/checkout.html?id=${CHECKOUT_ID}&step=payment`,
    ]);
    expect(location.search).toBe(`?id=${CHECKOUT_ID}&step=payment`);
    vi.advanceTimersByTime(ANNOUNCED_MS);
    expect(text($("[data-live-region]"))).toBe(`Extras saved. Your total is ${money("447.30")}`);
  });

  it("[OFE-011 AC1] a 412 reloads the checkout and applies the step again on the reloaded version", async () => {
    const fake = fakeApi();
    const setTravelers = /** @type {import("vitest").Mock} */ (fake.client.checkout.setTravelers);
    setTravelers.mockRejectedValueOnce(apiError(VelexisError, "PRECONDITION_FAILED", 412));
    await openCheckout({ fake });

    fillTravellers();
    // Another tab saved the checkout meanwhile: the reload reads version 9.
    fake.api.current = { ...fake.api.current, version: 9 };
    await submit("travellers");

    expect(setTravelers.mock.calls.map(([params]) => params.ifMatch)).toEqual([3, 9]);
    // The same travellers both times: the step is applied again, not lost.
    expect(setTravelers.mock.calls[1]?.[0].travelers).toEqual(setTravelers.mock.calls[0]?.[0].travelers);
    expect(fake.client.checkout.get).toHaveBeenCalledTimes(2);
    expect(shownStep()).toEqual(["contacts"]);
    expect(text($("[data-step-notice] [data-state]"))).toContain("This checkout was changed in another tab.");
  });

  it("[OFE-011 AC1] a second 412 in a row offers Reload, which shows the saved checkout", async () => {
    const fake = fakeApi({
      setContacts: async () => Promise.reject(apiError(VelexisError, "PRECONDITION_FAILED", 412)),
    });
    fake.api.current = checkout({ progress: { ...INCOMPLETE, travelersComplete: true } });
    await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=contacts` });

    fillContact("anna.berg@example.com");
    await submit("contacts");

    expect(fake.client.checkout.setContacts).toHaveBeenCalledTimes(2);
    const state = $("[data-step-notice] [data-state]");
    expect(state.getAttribute("data-state")).toBe("stale");
    expect(text(state.querySelector('[data-field="title"]'))).toBe(
      "This checkout was changed in another tab again. Reload to see the latest version.",
    );
    const reload = /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]'));
    expect(text(reload)).toBe("Reload");
    const calls = fake.client.checkout.get.mock.calls.length;
    reload.click();
    await settle();
    expect(fake.client.checkout.get.mock.calls.length).toBe(calls + 1);
    expect(shownStep()).toEqual(["contacts"]);
  });

  it("[OFE-011 AC2] fieldErrors mark the right fields with aria-invalid and focus the error summary", async () => {
    const fake = fakeApi({
      setTravelers: async () =>
        Promise.reject(
          apiError(ValidationError, "TRAVELER_DATA_INVALID", 422, {
            fieldErrors: [
              {
                path: "/travelers/0/name/firstName",
                code: "INVALID_CHARACTERS",
                message: "Latin letters only.",
              },
              {
                path: "/travelers/0/documents/0/expiryDate",
                code: "DOCUMENT_EXPIRES_BEFORE_RETURN",
                message: "The document expires before the last flight.",
              },
              { path: "/travelers/1/dateOfBirth", code: "AGE_MISMATCH_TRAVELER_TYPE", message: "Too old." },
              { path: "/travelers/0/loyaltyPrograms", code: "REQUIRED", message: "Not on this form." },
            ],
          }),
        ),
    });
    await openCheckout({ fake });
    fillTravellers();
    await submit("travellers");

    const invalid = Array.from(document.querySelectorAll('[aria-invalid="true"]'), (control) =>
      control.getAttribute("name"),
    );
    expect(invalid).toEqual([
      "travelers.0.name.firstName",
      "travelers.0.documents.0.expiryDate",
      "travelers.1.dateOfBirth",
    ]);
    for (const name of invalid) {
      const control = field(/** @type {string} */ (name));
      const message = document.getElementById(
        /** @type {string} */ ((control.getAttribute("aria-describedby") ?? "").split(" ").pop()),
      );
      expect(message?.hasAttribute("data-field-error"), String(name)).toBe(true);
    }
    expect(
      text(
        document.getElementById(
          /** @type {string} */ (field("travelers.0.name.firstName").getAttribute("aria-describedby")),
        ),
      ),
    ).toBe("Use only Latin letters, spaces, hyphens and apostrophes");
    const summary = /** @type {HTMLElement} */ (stepForm("travellers").querySelector("[data-error-summary]"));
    expect(document.activeElement).toBe(summary);
    expect(summary.hidden).toBe(false);
    expect(text(summary.querySelector("h2"))).toBe("There are 4 problems");
    // The error without a field of this form is listed without a link.
    expect(summary.querySelectorAll("li a")).toHaveLength(3);
    expect(summary.querySelectorAll("li")).toHaveLength(4);
    // The messages never repeat the typed values.
    expect(text(summary)).not.toContain("Anna");
    expect(shownStep()).toEqual(["travellers"]);
  });

  it("[OFE-011 AC2] contact errors of whole parts mark their field (the phone of /contacts/0/phones)", async () => {
    const fake = fakeApi({
      setContacts: async () =>
        Promise.reject(
          apiError(ValidationError, "CONTACT_DATA_INVALID", 422, {
            fieldErrors: [
              {
                path: "/contacts/0/phones",
                code: "MOBILE_PHONE_REQUIRED",
                message: "Add a mobile phone number.",
              },
              {
                path: "/contacts/0/emailAddress",
                code: "EMAIL_INVALID",
                message: "Enter a valid e-mail address.",
              },
            ],
          }),
        ),
    });
    fake.api.current = checkout({ progress: { ...INCOMPLETE, travelersComplete: true } });
    await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=contacts` });
    fillContact();
    await submit("contacts");

    expect(field("contacts.0.phones.0.number").getAttribute("aria-invalid")).toBe("true");
    expect(field("contacts.0.emailAddress").getAttribute("aria-invalid")).toBe("true");
    expect(field("contacts.0.phones.0.countryCallingCode").hasAttribute("aria-invalid")).toBe(false);
    expect(document.activeElement).toBe(stepForm("contacts").querySelector("[data-error-summary]"));
    expect(texts("[data-step-form=contacts] [data-error-summary] li")).toEqual([
      "Enter a mobile phone number",
      "Enter a valid e-mail address",
    ]);
  });

  it("[OFE-011 AC2] 422 CHECKOUT_INCOMPLETE on createPayment jumps to the first incomplete step with its fields marked", async () => {
    const fake = fakeApi({
      createPayment: async () =>
        Promise.reject(
          apiError(ValidationError, "CHECKOUT_INCOMPLETE", 422, {
            fieldErrors: [
              // Pointers into the checkout, whose travellers are listed infant first here.
              {
                path: "/travelers/1/documents",
                code: "REQUIRED",
                message: "An identity document is required.",
              },
            ],
          }),
        ),
    });
    fake.api.current = checkout({ progress: COMPLETE });
    await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=payment`, config: NO_EXTRAS_CONFIG });
    expect(shownStep()).toEqual(["payment"]);
    // Meanwhile the checkout lost the adult's document (another tab); its travellers come in another order.
    fake.api.current = checkout({
      progress: { ...COMPLETE, travelersComplete: false },
      travelers: [traveller("2", "HELD_INFANT"), traveller("1", "ADULT")],
    });
    /** @type {HTMLInputElement} */ ($("input[data-terms]")).checked = true;
    await submit("payment");

    expect(shownStep()).toEqual(["travellers"]);
    expect(location.search).toBe(`?id=${CHECKOUT_ID}&step=travellers`);
    expect(field("travelers.0.documents.0.number").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(stepForm("travellers").querySelector("[data-error-summary]"));
    expect(stepper().map(([, status]) => status)).toEqual(["current", "locked", "locked"]);
  });

  it("[OFE-011 AC3] the airline-card option is shown only when supportedMethods includes it", async () => {
    const card = await openCheckout({
      fake: fakeApi({ checkout: checkout({ progress: COMPLETE }) }),
      query: `id=${CHECKOUT_ID}&step=payment`,
    });
    expect(
      Array.from(
        document.querySelectorAll("input[data-payment-method]"),
        (input) => /** @type {HTMLInputElement} */ (input).value,
      ),
    ).toEqual(["card"]);
    expect(text($("[data-payment-method-list]"))).toContain("Accepted: Visa, Mastercard");
    expect(text($("[data-payment-method-list]"))).not.toContain(AIRLINE_CARD_NOTICE);
    // The links to read before accepting: terms, privacy and the fare rules on the price page, in a new tab.
    expect(
      Array.from(document.querySelectorAll("a[data-payment-link]"), (link) => [
        text(link),
        link.getAttribute("href"),
        link.getAttribute("target"),
      ]),
    ).toEqual([
      ["terms and conditions", "https://demo-travel.example/terms", "_blank"],
      ["privacy policy", "/p/privacy", "_blank"],
      ["fare rules", `/price.html?priced=${BASE_ID}#fare-rules`, "_blank"],
    ]);
    expect(text($("[data-payment-total-note]"))).toBe(
      "A card fee may be added on the next page, depending on your card.",
    );
    /** @type {HTMLInputElement} */ ($("input[data-terms]")).checked = true;
    await submit("payment");
    expect(card.client.checkout.createPayment).toHaveBeenCalledWith({
      checkoutId: CHECKOUT_ID,
      method: "card",
      termsAccepted: true,
      returnUrl: `${location.origin}/checkout/complete.html?id=${CHECKOUT_ID}`,
    });
    expect(card.navigate).toHaveBeenCalledWith(
      `/checkout/pay-card.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
    );
    card.view.destroy();

    const airline = await openCheckout({
      fake: fakeApi({ checkout: checkout({ progress: COMPLETE }) }),
      query: `id=${CHECKOUT_ID}&step=payment`,
      config: AIRLINE_CONFIG,
    });
    const methods = /** @type {HTMLInputElement[]} */ (
      Array.from(document.querySelectorAll("input[data-payment-method]"))
    );
    expect(methods.map((input) => input.value)).toEqual(["card", "airline_card"]);
    expect(texts("[data-payment-method-list] > li")[1]).toBe(
      `Card, charged by the airline ${AIRLINE_CARD_NOTICE}`,
    );
    const airlineInput = /** @type {HTMLInputElement} */ (methods[1]);
    airlineInput.checked = true;
    airlineInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(text($("[data-payment-total-note]"))).toBe(
      "The airline charges your card at its own price, shown on the next page.",
    );
    /** @type {HTMLInputElement} */ ($("input[data-terms]")).checked = true;
    await submit("payment");
    expect(airline.client.checkout.createPayment).toHaveBeenCalledWith({
      checkoutId: CHECKOUT_ID,
      method: "airline_card",
      termsAccepted: true,
    });
    expect(airline.navigate).toHaveBeenCalledWith(
      `/checkout/pay-airline.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
    );

    // An airline card switched off in the configuration is not offered either.
    expect(
      paymentMethods({ supportedMethods: ["card", "airline_card"], airlineCard: { enabled: false } }),
    ).toEqual(["card"]);
    expect(paymentMethods({ supportedMethods: ["airline_card", "apple_pay"] })).toEqual(["airline_card"]);
  });

  it("[OFE-011] 403 FEATURE_DISABLED for the airline card hides it; the card stays", async () => {
    const { client, navigate } = await openCheckout({
      fake: fakeApi({
        checkout: checkout({ progress: COMPLETE }),
        createPayment: async () =>
          Promise.reject(
            apiError(PermissionError, "FEATURE_DISABLED", 403, { details: { feature: "airlineCard" } }),
          ),
      }),
      query: `id=${CHECKOUT_ID}&step=payment`,
      config: AIRLINE_CONFIG,
    });
    const airline = /** @type {HTMLInputElement} */ ($('input[data-payment-method][value="airline_card"]'));
    airline.checked = true;
    /** @type {HTMLInputElement} */ ($("input[data-terms]")).checked = true;
    await submit("payment");

    expect(client.checkout.createPayment).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(
      Array.from(document.querySelectorAll("input[data-payment-method]"), (input) => [
        /** @type {HTMLInputElement} */ (input).value,
        /** @type {HTMLInputElement} */ (input).checked,
      ]),
    ).toEqual([["card", true]]);
    expect(text($("[data-payment-state] [data-field='title']"))).toBe(
      "Paying the airline by card is not available. You can pay by card.",
    );
  });

  it("[OFE-011] 424 PAYMENT_PROVIDER_NOT_CONFIGURED says that payments are not available yet", async () => {
    const { navigate } = await openCheckout({
      fake: fakeApi({
        checkout: checkout({ progress: COMPLETE }),
        createPayment: async () =>
          Promise.reject(apiError(SupplierError, "PAYMENT_PROVIDER_NOT_CONFIGURED", 424)),
      }),
      query: `id=${CHECKOUT_ID}&step=payment`,
    });
    /** @type {HTMLInputElement} */ ($("input[data-terms]")).checked = true;
    await submit("payment");

    const state = $("[data-payment-state] [data-state]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Payments are not available yet");
    expect(state.querySelector('[data-action="retry"]')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("[OFE-011] the payment step shows the fare's conditions and sends termsAccepted only with the box ticked", async () => {
    const { client, navigate } = await openCheckout({
      fake: fakeApi({
        checkout: checkout({ progress: COMPLETE, conditions: { refundable: false, changeable: true } }),
      }),
      query: `id=${CHECKOUT_ID}&step=payment`,
    });
    // The conditions stay on this page: the price page behind the fare-rules link may have expired meanwhile.
    expect($("[data-payment-conditions]").hidden).toBe(false);
    expect(text($("[data-payment-conditions]"))).toBe("This fare: Non-refundable · Changes allowed.");

    // A submit that bypasses the browser's own check of the box still sends nothing.
    const terms = /** @type {HTMLInputElement} */ ($("input[data-terms]"));
    expect(terms.checked).toBe(false);
    stepForm("payment").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(client.checkout.createPayment).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(terms.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(stepForm("payment").querySelector("[data-error-summary]"));
    expect(texts("[data-step-form=payment] [data-error-summary] li")).toEqual([
      "Accept the terms and conditions, the privacy policy and the fare rules to continue",
    ]);

    terms.checked = true;
    await submit("payment");
    expect(client.checkout.createPayment).toHaveBeenCalledTimes(1);
    expect(terms.hasAttribute("aria-invalid")).toBe(false);
    expect(navigate).toHaveBeenCalledWith(`/checkout/pay-card.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`);
  });

  it("[OFE-011] CHECKOUT_ALREADY_COMPLETED without a booking id loads the checkout, which opens its confirmation", async () => {
    const fake = fakeApi({
      createPayment: async () => Promise.reject(apiError(ConflictError, "CHECKOUT_ALREADY_COMPLETED", 409)),
    });
    fake.api.current = checkout({ progress: COMPLETE });
    const { client, replace } = await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=payment` });
    // Another tab completed the checkout meanwhile.
    fake.api.current = checkout({ progress: COMPLETE, status: "completed", bookingId: BOOKING_ID });
    /** @type {HTMLInputElement} */ ($("input[data-terms]")).checked = true;
    await submit("payment");

    expect(client.checkout.get).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
    // No Retry of a step that cannot succeed.
    expect($("[data-step-notice] [data-action='retry']")).toBeNull();
  });

  it("[OFE-011] CHECKOUT_INCOMPLETE without field errors marks what progress.missing names", async () => {
    const fake = fakeApi({
      createPayment: async () => Promise.reject(apiError(ValidationError, "CHECKOUT_INCOMPLETE", 422)),
    });
    fake.api.current = checkout({ progress: COMPLETE });
    await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=payment`, config: NO_EXTRAS_CONFIG });
    fake.api.current = checkout({
      progress: {
        ...COMPLETE,
        travelersComplete: false,
        missing: [{ path: "/travelers/0/documents", code: "REQUIRED", message: "A document is required." }],
      },
    });
    /** @type {HTMLInputElement} */ ($("input[data-terms]")).checked = true;
    await submit("payment");

    expect(shownStep()).toEqual(["travellers"]);
    expect(field("travelers.0.documents.0.number").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(stepForm("travellers").querySelector("[data-error-summary]"));
  });

  it("[OFE-011] a field error of a special request marks the field it was typed in", async () => {
    const stored = {
      id: "crm_01JCHECKOUTREMARK000",
      kind: "general",
      subType: "GENERAL_MISCELLANEOUS",
      text: "WHEELCHAIR AT THE GATE",
      travelerIds: [],
      source: "customer",
      createdAt: fromNow(-30),
    };
    const fake = fakeApi({
      setRemarks: async () =>
        Promise.reject(
          apiError(ValidationError, "VALIDATION_FAILED", 400, {
            fieldErrors: [{ path: "/remarks/0/text", code: "pattern", message: "Not allowed." }],
          }),
        ),
    });
    fake.api.current = checkout({ progress: COMPLETE, remarks: [stored] });
    const { client } = await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=extras` });
    expect(field("remarks.0.text").value).toBe("WHEELCHAIR AT THE GATE");
    // The stored request is removed and a new one typed into the second field: the request has one entry.
    type("remarks.0.text", "");
    type("remarks.1.text", "Vegetarian meal");
    await submit("extras");

    expect(client.checkout.setRemarks).toHaveBeenCalledWith(
      expect.objectContaining({ remarks: [{ text: "Vegetarian meal" }] }),
    );
    expect(field("remarks.1.text").getAttribute("aria-invalid")).toBe("true");
    expect(field("remarks.0.text").hasAttribute("aria-invalid")).toBe(false);
  });

  it("[OFE-011] a price change at createPayment shows the new total to check before continuing", async () => {
    const fake = fakeApi({
      createPayment: vi.fn().mockRejectedValueOnce(
        apiError(PriceChangedError, "PRICE_CHANGED", 409, {
          details: { oldPrice: eur("412.30"), newPrice: eur("419.80"), pricedOfferId: CHILD_ID },
        }),
      ),
    });
    fake.api.current = checkout({ progress: COMPLETE });
    const { client, navigate } = await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=payment` });
    fake.api.current = checkout({
      progress: COMPLETE,
      version: 8,
      totals: {
        currency: "EUR",
        offer: eur("419.80"),
        ancillaries: eur("0.00"),
        cardFee: null,
        total: eur("419.80"),
      },
    });
    /** @type {HTMLInputElement} */ ($("input[data-terms]")).checked = true;
    await submit("payment");

    expect($("[data-payment-change]").hidden).toBe(false);
    expect(text($("[data-payment-change-text]"))).toBe(
      `The new total is ${money("419.80")} (before: ${money("412.30")}). Check it, then continue to the payment.`,
    );
    expect(text($("[data-payment-total]"))).toBe(money("419.80"));
    expect(navigate).not.toHaveBeenCalled();
    expect(client.checkout.createPayment).toHaveBeenCalledTimes(1);
  });

  it("[OFE-011] 422 ANCILLARY_NOT_AVAILABLE removes the option and says so next to the extras", async () => {
    const fake = fakeApi({
      setAncillaries: async () =>
        Promise.reject(
          apiError(ValidationError, "ANCILLARY_NOT_AVAILABLE", 422, {
            details: { selectionIndex: 1, reason: "rejected_by_airline" },
          }),
        ),
    });
    fake.api.current = checkout({ progress: COMPLETE });
    const { client } = await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=extras` });
    const choose = (/** @type {string} */ id) => {
      const input = /** @type {HTMLInputElement} */ ($(`input[data-ancillary-input][value="${id}"]`));
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    choose(BAG_ID);
    choose(PRIORITY_ID);
    await submit("extras");

    expect(client.checkout.setAncillaries).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [
          { optionId: BAG_ID, travelerId: "1" },
          { optionId: PRIORITY_ID, travelerId: "1" },
        ],
      }),
    );
    // The second selection (priority boarding) is gone; the bag stays chosen.
    expect($(`input[data-ancillary-input][value="${PRIORITY_ID}"]`)).toBeNull();
    expect(
      /** @type {HTMLInputElement} */ ($(`input[data-ancillary-input][value="${BAG_ID}"]`)).checked,
    ).toBe(true);
    expect($("[data-extras-message]").hidden).toBe(false);
    expect(text($("[data-extras-message]"))).toBe(
      "Priority boarding is no longer available and was removed. Check your extras and continue.",
    );
    expect(shownStep()).toEqual(["extras"]);
  });

  it("[OFE-011] a flight sold out while adding extras says so, with a link to search again", async () => {
    const fake = fakeApi({
      setAncillaries: async () => Promise.reject(apiError(ConflictError, "SOLD_OUT", 409)),
      setRemarks: async () => Promise.reject(apiError(ValidationError, "UNPROCESSABLE", 422)),
    });
    fake.api.current = checkout({ progress: COMPLETE });
    await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=extras` });
    // A request the API refuses without a field error: the summary says so.
    type("remarks.0.text", "Wheelchair at the gate");
    await submit("extras");
    expect(text(stepForm("extras").querySelector("[data-error-summary]"))).toContain(
      "This could not be saved. Check the details and try again.",
    );
    expect(document.activeElement).toBe(stepForm("extras").querySelector("[data-error-summary]"));

    const bag = /** @type {HTMLInputElement} */ ($(`input[data-ancillary-input][value="${BAG_ID}"]`));
    bag.checked = true;
    await submit("extras");
    const state = $("[data-checkout-state] [data-state]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("This flight just sold out");
    const link = /** @type {HTMLAnchorElement} */ (state.querySelector("a[data-state-link]"));
    expect([text(link), link.getAttribute("href")]).toEqual(["Search flights", "/"]);
  });

  it("[OFE-011] extras that cannot be loaded leave the special requests; Continue goes on without extras", async () => {
    const fake = fakeApi({
      getAncillaries: async () => Promise.reject(apiError(SupplierError, "SUPPLIER_TIMEOUT", 504)),
    });
    fake.api.current = checkout({ progress: COMPLETE });
    const { client } = await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=extras` });

    const state = $("[data-extras-state] [data-state]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Extras cannot be added right now");
    expect(state.querySelector('[data-action="retry"]')).not.toBeNull();
    expect(document.querySelectorAll("input[data-remark-input]")).toHaveLength(1);
    await submit("extras");
    expect(client.checkout.setAncillaries).not.toHaveBeenCalled();
    expect(client.checkout.setRemarks).not.toHaveBeenCalled();
    expect(shownStep()).toEqual(["payment"]);
  });

  it("[OFE-011] without features.ancillaries the extras step is skipped", async () => {
    const fake = fakeApi();
    fake.api.current = checkout({ progress: { ...INCOMPLETE, travelersComplete: true } });
    const { client } = await openCheckout({
      fake,
      query: `id=${CHECKOUT_ID}&step=contacts`,
      config: NO_EXTRAS_CONFIG,
    });
    expect(stepper().map(([label]) => label)).toEqual(["1. Travellers", "2. Contact details", "3. Payment"]);
    fillContact();
    await submit("contacts");

    expect(shownStep()).toEqual(["payment"]);
    expect(client.flights.getAncillaries).not.toHaveBeenCalled();
    // A step the storefront does not have is never shown, even from the address.
    expect(stepToShow("extras", checkoutSteps(NO_EXTRAS_CONFIG.features), COMPLETE)).toBe("travellers");
  });

  it("[OFE-011] Back and Forward move between the steps, which open only once the data before them is complete", async () => {
    const fake = fakeApi();
    // The address asks for the payment step, but the travellers are not complete: the travellers step is shown.
    await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=payment` });
    expect(shownStep()).toEqual(["travellers"]);
    expect(location.search).toBe(`?id=${CHECKOUT_ID}&step=travellers`);

    fillTravellers();
    await submit("travellers");
    expect(shownStep()).toEqual(["contacts"]);

    history.back();
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await settle();
    expect(shownStep()).toEqual(["travellers"]);
    expect(document.activeElement).toBe($("#step-travellers-title"));

    history.forward();
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await settle();
    expect(shownStep()).toEqual(["contacts"]);

    // The stepper's links move too (a history entry each).
    const link = /** @type {HTMLAnchorElement} */ ($('a[data-step-link="travellers"]'));
    link.click();
    expect(shownStep()).toEqual(["travellers"]);
    expect(location.search).toBe(`?id=${CHECKOUT_ID}&step=travellers`);
  });

  it("[OFE-011] 410 CHECKOUT_EXPIRED says the session expired, with a link back to the price page", async () => {
    const fake = fakeApi({
      setTravelers: async () => Promise.reject(apiError(ExpiredError, "CHECKOUT_EXPIRED", 410)),
    });
    await openCheckout({ fake });
    fillTravellers();
    await submit("travellers");

    expect($("[data-checkout-content]").hidden).toBe(true);
    expect($("[data-stepper]").hidden).toBe(true);
    const state = $("[data-checkout-state] [data-state]");
    expect(state.getAttribute("data-state")).toBe("checkout-expired");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Your session expired");
    expect(text(state)).toContain("Price the flight again to see the current price.");
    const link = /** @type {HTMLAnchorElement} */ (state.querySelector("a[data-state-link]"));
    expect(text(link)).toBe("Price this flight again");
    expect(link.getAttribute("href")).toBe(`/price.html?priced=${BASE_ID}`);
    expect(document.title).toBe("Your session expired");

    // An expired checkout says the same when the page opens.
    views.splice(0).forEach((view) => view.destroy());
    await openCheckout({ fake: fakeApi({ checkout: checkout({ status: "expired" }) }) });
    expect(text($("[data-checkout-state] [data-field='title']"))).toBe("Your session expired");
  });

  it("[OFE-011] a completed checkout opens its confirmation; one being completed opens the pending confirmation", async () => {
    const done = await openCheckout({
      fake: fakeApi({ checkout: checkout({ status: "completed", bookingId: BOOKING_ID }) }),
    });
    expect(done.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
    done.view.destroy();

    const pending = await openCheckout({
      fake: fakeApi({
        setTravelers: async () =>
          Promise.reject(
            apiError(ConflictError, "CHECKOUT_BEING_COMPLETED", 409, { details: { bookingId: BOOKING_ID } }),
          ),
      }),
    });
    fillTravellers();
    await submit("travellers");
    expect(pending.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);
  });

  it("[OFE-011] a failure of a step shows its state with Retry; an unknown checkout says so", async () => {
    const fake = fakeApi();
    const setTravelers = /** @type {import("vitest").Mock} */ (fake.client.checkout.setTravelers);
    setTravelers.mockRejectedValueOnce(apiError(ConnectionError, "NETWORK_ERROR", 0));
    await openCheckout({ fake });
    fillTravellers();
    await submit("travellers");
    const state = $("[data-step-notice] [data-state]");
    expect(state.getAttribute("data-state")).toBe("unavailable");
    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]')).click();
    await settle();
    expect(setTravelers).toHaveBeenCalledTimes(2);
    expect(shownStep()).toEqual(["contacts"]);
    views.splice(0).forEach((view) => view.destroy());

    const missing = await openCheckout({
      fake: fakeApi({ get: async () => Promise.reject(apiError(VelexisError, "NOT_FOUND", 404)) }),
    });
    expect(text($("[data-checkout-state] [data-field='title']"))).toBe("We could not find this checkout");
    missing.view.destroy();

    // An address without a valid checkout id makes no call.
    const invalid = fakeApi();
    await openCheckout({ fake: invalid, query: "id=chk_short" });
    expect(invalid.client.checkout.get).not.toHaveBeenCalled();
    expect(text($("[data-checkout-state] [data-field='title']"))).toBe("We could not find this checkout");
  });

  it("[OFE-011] without the country list the country fields take two-letter codes", async () => {
    const { client } = await openCheckout({
      fake: fakeApi({
        listCountries: async () => Promise.reject(apiError(ServerError, "INTERNAL_ERROR", 500)),
      }),
    });
    const nationality = field("travelers.0.documents.0.nationality");
    expect(nationality.tagName).toBe("INPUT");
    expect(nationality.getAttribute("pattern")).toBe("[A-Za-z]{2}");
    expect(nationality.required).toBe(true);
    fillTravellers();
    type("travelers.0.documents.0.nationality", "se");
    await submit("travellers");
    expect(client.checkout.setTravelers.mock.calls[0]?.[0].travelers[0].documents[0].nationality).toBe("SE");
  });

  it("[OFE-011] the invoice contact is required when the airline asks for one", async () => {
    const fake = fakeApi();
    fake.api.current = checkout({
      progress: { ...INCOMPLETE, travelersComplete: true },
      requirements: {
        ...checkout().requirements,
        contact: {
          ...checkout().requirements.contact,
          invoiceAddressRequired: true,
          postalCodeRequired: true,
        },
      },
    });
    const { client } = await openCheckout({ fake, query: `id=${CHECKOUT_ID}&step=contacts` });
    const toggle = /** @type {HTMLInputElement} */ ($("input[data-invoice-toggle]"));
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect($("[data-invoice]").hidden).toBe(false);
    expect($("[data-invoice-required]").hidden).toBe(false);
    expect(field("contacts.1.address.postalCode").required).toBe(true);
    // The mailing address of the primary contact is not asked for: its fields are disabled.
    expect(field("contacts.0.address.cityName").disabled).toBe(true);

    fillContact();
    type("contacts.1.companyName", "Nordic Design AB");
    type("contacts.1.address.lines.0", "Sveavagen 44");
    type("contacts.1.address.postalCode", "11134");
    type("contacts.1.address.cityName", "Stockholm");
    type("contacts.1.address.countryCode", "SE");
    await submit("contacts");
    expect(client.checkout.setContacts.mock.calls[0]?.[0].contacts).toEqual([
      {
        purpose: "STANDARD",
        isPrimary: true,
        addresseeName: { firstName: "Anna", lastName: "Berg" },
        emailAddress: "anna@example.com",
        phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
        language: "en",
      },
      {
        purpose: "INVOICE",
        isPrimary: false,
        companyName: "Nordic Design AB",
        address: { lines: ["Sveavagen 44"], postalCode: "11134", cityName: "Stockholm", countryCode: "SE" },
      },
    ]);
  });

  it("[OFE-011] the page loads no third-party script: its own module only", () => {
    const scripts = [...checkoutHtml.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(scripts).toEqual(['<script type="module" src="/src/pages/checkout.js">']);
    expect(checkoutHtml).not.toMatch(/https:\/\/js\.stripe\.com/);
    // No card field anywhere on this page.
    expect(checkoutHtml).not.toMatch(/autocomplete="[^"]*cc-/);
    // A submit without the script never puts traveller data (document numbers) into an address.
    const forms = /** @type {Document} */ (pageDocuments["checkout.html"]).querySelectorAll(
      "form[data-step-form]",
    );
    expect(Array.from(forms, (form) => [form.getAttribute("method"), form.hasAttribute("action")])).toEqual([
      ["post", false],
      ["post", false],
      ["post", false],
      ["post", false],
    ]);
  });
});

describe("checkout page: helpers", () => {
  it("[OFE-011] steps open in order, and the first incomplete step is the one to show", () => {
    const steps = checkoutSteps({ ancillaries: true });
    expect(steps).toEqual(["travellers", "contacts", "extras", "payment"]);
    expect(isReachable("contacts", steps, INCOMPLETE)).toBe(false);
    expect(isReachable("contacts", steps, { ...INCOMPLETE, travelersComplete: true })).toBe(true);
    expect(isReachable("payment", steps, { ...INCOMPLETE, travelersComplete: true })).toBe(false);
    expect(isReachable("payment", steps, COMPLETE)).toBe(true);
    expect(firstIncompleteStep(steps, { ...INCOMPLETE, travelersComplete: true })).toBe("contacts");
    expect(firstIncompleteStep(steps, COMPLETE)).toBeNull();
    expect(stepToShow("nonsense", steps, COMPLETE)).toBe("travellers");
    expect(stepToShow("payment", steps, COMPLETE)).toBe("payment");
  });

  it("[OFE-011] pointers find their step, and checkout pointers follow the travellers into the form's order", () => {
    expect(stepOfPointer("/travelers/0/name")).toBe("travellers");
    expect(stepOfPointer("/contacts/1/address/postalCode")).toBe("contacts");
    expect(stepOfPointer("/selections/0/seatNumber")).toBe("extras");
    expect(stepOfPointer("/remarks/0/text")).toBe("extras");
    expect(stepOfPointer("/termsAccepted")).toBeNull();
    expect(
      remapTravellerPointers(
        [
          { path: "/travelers/0/documents", code: "REQUIRED" },
          { path: "/travelers/1", code: "REQUIRED" },
          { path: "/contacts/0", code: "REQUIRED" },
        ],
        ["2", "1"],
        ["1", "2"],
      ).map((error) => error.path),
    ).toEqual(["/travelers/1/documents", "/travelers/0", "/contacts/0"]);
  });

  it("[OFE-011] extras: bags are one choice per traveller and flights, selections compare in any order", () => {
    const groups = optionGroups(/** @type {never} */ (catalogue()), "1");
    expect(groups.map((group) => [group.title, group.radio, group.options.length])).toEqual([
      ["Extra checked bags: CDG–JFK", true, 2],
      ["Services", false, 1],
    ]);
    expect(optionGroups(/** @type {never} */ (catalogue()), "2")).toEqual([]);
    expect(
      sameSelections(
        [
          { optionId: BAG_ID, travelerId: "1" },
          { optionId: PRIORITY_ID, travelerId: "1" },
        ],
        [
          { optionId: PRIORITY_ID, travelerId: "1" },
          { optionId: BAG_ID, travelerId: "1" },
        ],
      ),
    ).toBe(true);
    expect(sameSelections([{ optionId: BAG_ID, travelerId: "1" }], [])).toBe(false);
    // An extra chosen without a catalogue option is kept with its own fields.
    expect(
      selectionsOf([
        {
          id: "can_1",
          optionId: null,
          type: "CHECKED_BAGS",
          label: "",
          travelerId: "1",
          segmentIds: ["1"],
          quantity: 1,
          weight: 23,
          weightUnit: "KG",
          price: eur("30.00"),
        },
      ]),
    ).toEqual([
      { type: "CHECKED_BAGS", travelerId: "1", segmentIds: ["1"], quantity: 1, weight: 23, weightUnit: "KG" },
    ]);
  });

  it("[OFE-011] the contact defaults prefer the checkout's contact, then the first adult and the account", () => {
    const adult = traveller("1", "ADULT", { name: { firstName: "Anna", lastName: "Berg" } });
    expect(
      contactDefaults({ contacts: [], travelers: [traveller("2", "HELD_INFANT"), adult], account: null }),
    ).toMatchObject({ "contacts.0.addresseeName.firstName": "Anna", "contacts.0.emailAddress": "" });
    expect(
      contactDefaults({
        contacts: [{ id: "cco_1", purpose: "STANDARD", isPrimary: true, emailAddress: "stored@example.com" }],
        travelers: [adult],
        account: /** @type {never} */ (SESSION.customer),
      }),
    ).toMatchObject({
      "contacts.0.emailAddress": "stored@example.com",
      "contacts.0.addresseeName.firstName": "",
    });
  });

  it("[OFE-011] special requests: only filled fields are sent, compared with the stored ones without case", () => {
    const input = (/** @type {string} */ value) => /** @type {HTMLInputElement} */ ({ value });
    const remarks = readRemarks([input(" Wheelchair at the gate "), input("")], [["1"], null]);
    expect(remarks).toEqual([{ text: "Wheelchair at the gate", travelerIds: ["1"] }]);
    expect(sameRemarks(remarks, [{ text: "WHEELCHAIR AT THE GATE", travelerIds: ["1"] }])).toBe(true);
    expect(sameRemarks(remarks, [])).toBe(false);
    expect(CHECKOUT_ID_PATTERN.test(CHECKOUT_ID)).toBe(true);
  });

  it("[OFE-011] the country list follows its pages and gives null when it cannot be loaded", async () => {
    const list = vi.fn(async () => countriesPage());
    expect(await loadCountries(/** @type {never} */ ({ reference: { countries: { list } } }))).toEqual([
      { code: "FR", name: "France" },
      { code: "SE", name: "Sweden" },
      { code: "GB", name: "United Kingdom" },
    ]);
    const failing = vi.fn(async () => Promise.reject(new Error("down")));
    expect(
      await loadCountries(/** @type {never} */ ({ reference: { countries: { list: failing } } })),
    ).toBeNull();
  });
});

describe("price page: Continue opens the checkout", () => {
  const PRICED_ID = "prc_01JCHECKOUTPRICED0001";

  /** A priced offer with what the price page shows. */
  const pricedOffer = () => ({
    id: PRICED_ID,
    status: "active",
    offerIds: [OFFER_ID],
    offers: [
      {
        id: OFFER_ID,
        summary: {
          tripType: "one_way",
          originCode: "CDG",
          destinationCode: "JFK",
          cabins: ["ECONOMY"],
          brandedFares: [],
        },
        itineraries: [ITINERARY],
        travelerPricings: [{ travelerId: "1", travelerType: "ADULT" }],
      },
    ],
    price: {
      currency: "EUR",
      total: eur("412.30"),
      base: eur("350.00"),
      taxes: eur("52.30"),
      fees: eur("10.00"),
      breakdown: { travelers: [], fees: [], additionalServices: [] },
    },
    priceChange: { changed: false },
    bookingRequirements: { emailAddressRequired: true },
    conditions: null,
    fareRules: null,
    dictionaries: {},
    expiresAt: fromNow(19 * 60),
  });

  /**
   * Starts the price page with a fake SDK whose `checkout.create` answers `create`.
   * @param {{ create?: Function, config?: object, session?: object | null, hash?: string }} [options]
   */
  async function openPrice({
    create = async () => ({ id: CHECKOUT_ID }),
    config = CONFIG,
    session = null,
    hash = "",
  } = {}) {
    showPage("price.html", `/price.html?priced=${PRICED_ID}${hash}`);
    const client = {
      flights: {
        getPricedOffer: vi.fn(async () => pricedOffer()),
        getAncillaries: vi.fn(async () => null),
        getFareRules: vi.fn(async () => ({
          available: false,
          summary: null,
          categories: [],
          fareComponents: [],
        })),
      },
      checkout: { create: vi.fn(create) },
      auth: { resendVerification: vi.fn(async () => ({ status: "accepted", message: "Sent." })) },
    };
    const navigate = vi.fn();
    const view = startPrice(
      {
        config: /** @type {never} */ (config),
        client: /** @type {never} */ (client),
        session: /** @type {never} */ (session),
      },
      { referrer: "", navigate },
    );
    if (!view) {
      throw new Error("the price page did not start");
    }
    views.push(view);
    await view.done;
    await settle();
    return { client, navigate, view };
  }

  const clickContinue = async () => {
    const form = /** @type {HTMLFormElement} */ ($("form[data-continue-form]"));
    form.requestSubmit(/** @type {HTMLButtonElement} */ ($("button[data-continue]")));
    await settle();
  };

  it("[OFE-011] Continue creates the checkout and opens its travellers step", async () => {
    const { client, navigate } = await openPrice();
    const button = /** @type {HTMLButtonElement} */ ($("button[data-continue]"));
    expect(button.disabled).toBe(false);
    await clickContinue();

    expect(client.checkout.create).toHaveBeenCalledTimes(1);
    expect(client.checkout.create).toHaveBeenCalledWith({ pricedOfferId: PRICED_ID });
    expect(navigate).toHaveBeenCalledWith(`/checkout.html?id=${CHECKOUT_ID}&step=travellers`);
  });

  it("[OFE-011] without guest checkout a visitor signs in first and comes back to the price", async () => {
    const config = { ...CONFIG, features: { ...CONFIG.features, guestCheckout: false } };
    const visitor = await openPrice({ config });
    await clickContinue();
    expect(visitor.client.checkout.create).not.toHaveBeenCalled();
    expect(visitor.navigate).toHaveBeenCalledWith(
      `/account/sign-in.html?next=${encodeURIComponent(`/price.html?priced=${PRICED_ID}`)}`,
    );
    visitor.view.destroy();

    // A signed-in customer goes straight on.
    const customer = await openPrice({ config, session: SESSION });
    await clickContinue();
    expect(customer.client.checkout.create).toHaveBeenCalledTimes(1);

    // A 401 (the guest checkout was switched off meanwhile) also leads to sign-in.
    const refused = await openPrice({
      create: async () => Promise.reject(apiError(AuthenticationError, "UNAUTHENTICATED", 401)),
    });
    await clickContinue();
    expect(refused.navigate).toHaveBeenCalledWith(
      `/account/sign-in.html?next=${encodeURIComponent(`/price.html?priced=${PRICED_ID}`)}`,
    );
  });

  it("[OFE-011] 403 EMAIL_NOT_VERIFIED asks to verify the e-mail address and can send the link again", async () => {
    const { client, navigate } = await openPrice({
      create: async () => Promise.reject(apiError(PermissionError, "EMAIL_NOT_VERIFIED", 403)),
      session: SESSION,
    });
    await clickContinue();

    expect(navigate).not.toHaveBeenCalled();
    const state = $("[data-continue-state] [data-state]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Verify your e-mail address to book");
    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="resend"]')).click();
    await settle();
    expect(client.auth.resendVerification).toHaveBeenCalledWith({
      returnPath: `/price.html?priced=${PRICED_ID}`,
    });
    expect(text(state.querySelector("[data-resend-status]"))).toBe(
      "If your e-mail address still needs verifying, we have sent you a new link.",
    );
  });

  it("[OFE-011] an expired fare at Continue shows the expired state; a failure shows Retry next to the button", async () => {
    const expired = await openPrice({
      create: async () => Promise.reject(apiError(ExpiredError, "OFFER_EXPIRED", 410)),
    });
    await clickContinue();
    expect(text($("[data-price-state] [data-field='title']"))).toBe("This fare is no longer available");
    expect($("[data-price-content]").hidden).toBe(true);
    expired.view.destroy();

    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(ServerError, "SERVICE_UNAVAILABLE", 503))
      .mockResolvedValueOnce({ id: CHECKOUT_ID });
    const busy = await openPrice({ create });
    await clickContinue();
    const state = $("[data-continue-state] [data-state]");
    expect(state.getAttribute("data-state")).toBe("unavailable");
    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]')).click();
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(busy.navigate).toHaveBeenCalledWith(`/checkout.html?id=${CHECKOUT_ID}&step=travellers`);
  });

  it("[OFE-011] the address #fare-rules opens the Changes and refunds disclosure", async () => {
    await openPrice({ hash: "#fare-rules" });
    expect(/** @type {HTMLDetailsElement} */ ($("details#fare-rules")).open).toBe(true);
  });
});
