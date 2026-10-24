// The airline-card payment page (ota/frontend/docs/pages.md §9, flow ota/docs/flows/checkout-airline-card.md §3,
// OADR-0017): checkout/pay-airline.html with its partials expanded by the build's include plugin, run by
// src/pages/checkout-pay-airline.js against a fake SDK. It covers the form (no `name`, the `cc-*` tokens, a form that
// posts nowhere), the state taken only from the address and a fresh `storefront.get`, the card-fee quote with brand and
// BIN only, Pay with a new idempotency key and 90 s, the inputs emptied after success, decline and `pagehide`, no
// storage, cookie, address, history or console holding a card value, the states of §9, and on the production build
// (vite build into a scratch folder) the page's single bundle within 30 KB gzip and the headers `vite preview` sends
// it, compared with deploy/caddy/Caddyfile. Card numbers are Stripe's documented test numbers.
import {
  ConflictError,
  ConnectionError,
  ExpiredError,
  PaymentError,
  PermissionError,
  PriceChangedError,
  RateLimitError,
  ServerError,
  SoldOutError,
  SupplierError,
  ValidationError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { preview } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BUDGETS, KB, PAGE_JS_BUDGETS, checkBudgets, passes } from "../scripts/check-budgets.mjs";
import { STOREFRONT_HEADERS, includePartials } from "../scripts/vite-plugins.js";
import { COMPLETION_TIMEOUT_MS, TEXT, airlineCardOffered, start } from "../src/pages/checkout-pay-airline.js";
import {
  NAVIGATION,
  REPO_ROOT,
  STOREFRONT_ROOT,
  VITE_CONFIG,
  baseUrl,
  buildStorefront,
  filesIn,
  httpRequest,
  removeScratch,
  scratchDir,
} from "./helpers/storefront.js";

const CHECKOUT_ID = "chk_01JPAYAIRLINECHECKOUT";
const PAYMENT_ID = "pay_01JPAYAIRLINEPAYMENT1";
const BASE_ID = "prc_01JPAYAIRLINEPRICED01";
const BOOKING_ID = "bkg_01JPAYAIRLINEBOOKING1";
const PAGE = "checkout/pay-airline.html";
const QUERY = `id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`;
/** Stripe's documented test numbers (Visa, Mastercard, American Express). */
const VISA = "4242424242424242";
const MASTERCARD = "5555555555554444";
const AMEX = "378282246310005";
/** An expiry three years ahead, so the card is valid whatever the date of the run. */
const YEAR = new Date().getUTCFullYear() + 3;

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });
/** @param {string} amount */
const money = (amount) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(Number(amount));
/** An ISO timestamp `seconds` from now. */
const fromNow = (/** @type {number} */ seconds) => new Date(Date.now() + seconds * 1000).toISOString();

const CONFIG = Object.freeze({
  name: "Demo Travel",
  environment: "test",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { ancillaries: true, guestCheckout: true, customerAccounts: true },
  branding: { cornerRadius: "large" },
  payment: {
    provider: "stripe",
    environment: "test",
    accountMode: "velexis",
    publishableKey: "pk_test_fake_storefront_fixture",
    accountId: null,
    merchantName: "Velexis on behalf of Demo Travel",
    statementDescriptor: "DEMO TRAVEL",
    supportedMethods: ["card", "airline_card"],
    cardBrands: ["VISA", "MASTERCARD"],
    pspCardBrands: [],
    airlineCard: {
      enabled: true,
      cardBrands: [
        { amadeus: "VISA", psp: "visa", label: "Visa" },
        { amadeus: "MASTERCARD", psp: "mastercard", label: "Mastercard" },
      ],
      chargedBy: "airline",
      notice: "The airline charges your card. The price is the airline's price.",
    },
  },
});

/** @param {Record<string, unknown>} [overrides] */
function checkout(overrides = {}) {
  return {
    id: CHECKOUT_ID,
    status: "payment_pending",
    pricingMode: "net",
    basePricedOfferId: BASE_ID,
    totals: {
      currency: "EUR",
      offer: eur("412.30"),
      ancillaries: eur("0.00"),
      cardFee: null,
      total: eur("412.30"),
    },
    ancillaries: [],
    itineraries: [
      { index: 0, originCode: "CDG", destinationCode: "JFK", departureAt: "2026-12-01T10:00:00" },
    ],
    bookingId: null,
    version: 4,
    expiresAt: fromNow(15 * 60),
    ...overrides,
  };
}

/** @param {Record<string, unknown>} [overrides] */
function payment(overrides = {}) {
  return {
    id: PAYMENT_ID,
    checkoutId: CHECKOUT_ID,
    bookingId: null,
    purpose: "booking",
    provider: "airline",
    method: "airline_card",
    status: "requires_payment_method",
    amount: eur("412.30"),
    cardFee: null,
    cardHint: null,
    clientSecret: null,
    providerPublicKey: null,
    nextAction: { type: "airline_card_form", redirectUrl: null },
    ...overrides,
  };
}

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({
    code,
    message: `${code} from the fake API`,
    status,
    requestId: "req_payairline",
    ...body,
  });

/**
 * A fake API: `updatePayment` quotes a card fee of €6.20 on the same payment, `completeWithAirlineCard` books.
 * @param {{ config?: object, checkout?: object, payment?: object } & Record<string, Function | object | undefined>} [options]
 */
function fakeApi({
  config = CONFIG,
  checkout: initialCheckout = checkout(),
  payment: initialPayment = payment(),
  ...overrides
} = {}) {
  const api = {
    config,
    checkout: initialCheckout,
    payment: /** @type {Record<string, any>} */ (initialPayment),
  };
  const client = {
    storefront: {
      get: vi.fn(/** @type {Function} */ (overrides["storefrontGet"]) ?? (async () => api.config)),
    },
    checkout: {
      get: vi.fn(/** @type {Function} */ (overrides["get"]) ?? (async () => api.checkout)),
      getPayment: vi.fn(/** @type {Function} */ (overrides["getPayment"]) ?? (async () => api.payment)),
      updatePayment: vi.fn(
        /** @type {Function} */ (overrides["updatePayment"]) ??
          (async (/** @type {{ card: object }} */ params) => {
            api.payment = {
              ...api.payment,
              cardHint: params.card,
              cardFee: eur("6.20"),
              amount: eur("418.50"),
            };
            return api.payment;
          }),
      ),
      completeWithAirlineCard: vi.fn(
        /** @type {Function} */ (overrides["complete"]) ??
          (async () => ({
            checkoutId: CHECKOUT_ID,
            booking: { id: BOOKING_ID, status: "ticketed" },
            bookingToken: null,
            bookingTokenExpiresAt: null,
          })),
      ),
    },
  };
  return { api, client };
}

/** @type {Browser | undefined} */
let browser;
/** @type {Document | undefined} */
let pageDocument;
let pageHtml = "";
const original = { address: "", title: "" };
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands the page with the build's include plugin and parses it once in a happy-dom browser; each test imports a
  // fresh copy of its body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  pageHtml = await transform.handler(readFileSync(join(STOREFRONT_ROOT, PAGE), "utf8"), { path: `/${PAGE}` });
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  const page = browser.newPage();
  page.url = `${location.origin}/${PAGE}`;
  page.content = pageHtml;
  pageDocument = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // a file read, the include plugin and one happy-dom browser page; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
  if (original.title !== "") {
    document.title = original.title;
  }
  if (original.address !== "") {
    history.replaceState(null, "", original.address);
  }
});

/** Puts a fresh copy of the page's body into the test document at `path`. */
function showPage(/** @type {string} */ path) {
  original.address ||= `${location.pathname}${location.search}`;
  original.title ||= document.title;
  const source = /** @type {Document} */ (pageDocument);
  document.body.replaceChildren(
    ...Array.from(source.body.childNodes, (node) => document.importNode(node, true)),
  );
  document.title = source.title;
  history.replaceState(null, "", path);
}

/** Waits until queued promise callbacks have run (the fakes answer at once). */
const settle = async () => {
  for (let i = 0; i < 60; i += 1) {
    await Promise.resolve();
  }
};

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const field = (/** @type {string} */ name) =>
  /** @type {HTMLInputElement} */ (document.querySelector(`input[data-card-input="${name}"]`));
const cardInputs = () =>
  Array.from(
    document.querySelectorAll("input[data-card-input]"),
    (el) => /** @type {HTMLInputElement} */ (el),
  );
const payButton = () => /** @type {HTMLButtonElement} */ ($("button[data-pay-button]"));

/** Types `value` into a card input, as the browser reports it. */
function type(/** @type {string} */ name, /** @type {string} */ value) {
  const input = field(name);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Fills the whole card (Stripe's Visa test number by default). */
async function fillCard({
  holder = "Maria Rossi",
  number = VISA,
  month = "12",
  year = String(YEAR),
  csc = "123",
} = {}) {
  type("holder", holder);
  type("month", month);
  type("year", year);
  type("csc", csc);
  type("number", number);
  await settle();
}

/** Submits the card form (Enter or the button). */
async function submit() {
  $("form[data-card-form]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

/**
 * Starts the page at `/checkout/pay-airline.html?<query>` with a fake SDK.
 * @param {{ query?: string, fake?: ReturnType<typeof fakeApi> }} [options]
 */
async function openPage({ query = QUERY, fake = fakeApi() } = {}) {
  showPage(`/checkout/pay-airline.html?${query}`);
  const replace = vi.fn();
  const reload = vi.fn();
  let count = 0;
  const newKey = vi.fn(() => `airline-card-submit-${(count += 1)}-0f3c`);
  const view = /** @type {NonNullable<ReturnType<typeof start>>} */ (
    start({ client: /** @type {never} */ (fake.client) }, { replace, reload, newKey })
  );
  views.push(view);
  await view.done;
  await settle();
  return { ...fake, replace, reload, newKey, view };
}

/** The card the fake fills in, as the page sends it. */
const sentCard = (overrides = {}) => ({
  brand: "VISA",
  holderName: "Maria Rossi",
  number: VISA,
  expiryMonth: 12,
  expiryYear: YEAR,
  securityCode: "123",
  ...overrides,
});

describe("airline-card page: the form", () => {
  it("[OFE-014] inputs without names, with the cc-* tokens and numeric modes, in a form that posts nowhere", () => {
    const html = /** @type {Document} */ (pageDocument);
    const form = /** @type {HTMLFormElement} */ (html.querySelector("form[data-card-form]"));
    expect(form.getAttribute("method")).toBe("post");
    expect(form.hasAttribute("action")).toBe(false);
    const inputs = Array.from(html.querySelectorAll("input"));
    expect(inputs.map((input) => input.getAttribute("autocomplete"))).toEqual([
      "cc-name",
      "cc-number",
      "cc-exp-month",
      "cc-exp-year",
      "cc-csc",
    ]);
    for (const input of inputs) {
      expect(input.hasAttribute("name"), input.id).toBe(false);
      expect(input.closest("form"), input.id).toBe(form);
      expect(input.getAttribute("spellcheck"), input.id).toBe("false");
      expect(html.querySelector(`label[for="${input.id}"]`), input.id).not.toBeNull();
    }
    expect(inputs.slice(1).map((input) => input.getAttribute("inputmode"))).toEqual([
      "numeric",
      "numeric",
      "numeric",
      "numeric",
    ]);
    expect(html.querySelectorAll("select, textarea, iframe")).toHaveLength(0);
    expect(pageHtml).toMatch(/<noscript>[\s\S]*needs JavaScript[\s\S]*<\/noscript>/);
    // No third-party code, font or image: the page's own module is its only script.
    expect([...pageHtml.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0])).toEqual([
      '<script type="module" src="/src/pages/checkout-pay-airline.js">',
    ]);
    expect(pageHtml).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
  });
});

describe("airline-card page: state from the address and the API only", () => {
  it("[OFE-014] asks storefront.get afresh and never reads the sessionStorage copy other pages write", async () => {
    // A copy that offers the airline card, as another page of the origin could have written it.
    sessionStorage.setItem(
      "vx.storefront.config",
      JSON.stringify({ storedAt: Date.now(), config: { ...CONFIG, name: "Copied" } }),
    );
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    try {
      const fake = fakeApi({
        config: { ...CONFIG, payment: { ...CONFIG.payment, supportedMethods: ["card"] } },
      });
      await openPage({ fake });

      expect(fake.client.storefront.get).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ cache: "no-store" }),
      );
      expect(getItem).not.toHaveBeenCalled();
      expect(text($("[data-pay-state]"))).toContain(TEXT.notOffered);
      expect($("[data-pay-content]").hidden).toBe(true);
      expect(fake.client.checkout.get).not.toHaveBeenCalled();
      expect(text($('body > header [data-field="brandName"]'))).toBe("Demo Travel");
    } finally {
      sessionStorage.removeItem("vx.storefront.config");
    }
  });

  it("[OFE-014] shows the method only when storefront.get offers it", async () => {
    expect(airlineCardOffered(CONFIG.payment)).toBe(true);
    const refused = [
      { ...CONFIG.payment, supportedMethods: ["card"] },
      { ...CONFIG.payment, airlineCard: { ...CONFIG.payment.airlineCard, enabled: false } },
      { ...CONFIG.payment, airlineCard: null },
      null,
    ];
    for (const paymentConfig of refused) {
      expect(airlineCardOffered(/** @type {never} */ (paymentConfig))).toBe(false);
    }
    const fake = fakeApi({ config: { ...CONFIG, payment: refused[1] } });
    await openPage({ fake });
    expect($("[data-pay-state] [data-state]").dataset.state).toBe("feature-disabled");
    expect(
      Array.from(document.querySelectorAll("[data-pay-state] a[data-state-link]"), (link) =>
        link.getAttribute("href"),
      ),
    ).toEqual([`/checkout.html?id=${CHECKOUT_ID}&step=payment`]);

    const offered = await openPage();
    expect($("[data-pay-content]").hidden).toBe(false);
    expect(text($("[data-airline-notice]"))).toBe(CONFIG.payment.airlineCard.notice);
    expect(text($("[data-accepted-brands]"))).toBe("We accept: Visa, Mastercard");
    expect(text($("[data-total]"))).toBe(money("412.30"));
    expect(offered.client.checkout.getPayment).toHaveBeenCalledWith(
      { paymentId: PAYMENT_ID },
      expect.anything(),
    );
    // The test banner of a test storefront, as on every page.
    expect($('[data-slot="test-banner"]').hidden).toBe(false);
  });

  it("[OFE-014] opens the page a payment or a checkout belongs on", async () => {
    let page = await openPage({
      fake: fakeApi({ payment: payment({ method: "card", provider: "stripe" }) }),
    });
    expect(page.replace).toHaveBeenCalledWith(
      `/checkout/pay-card.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
    );

    page = await openPage({
      fake: fakeApi({ checkout: checkout({ status: "completed", bookingId: BOOKING_ID }) }),
    });
    expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);

    page = await openPage({
      fake: fakeApi({
        checkout: checkout({ bookingId: BOOKING_ID }),
        payment: payment({ status: "processing" }),
      }),
    });
    expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);

    page = await openPage({ fake: fakeApi({ checkout: checkout({ status: "expired" }) }) });
    expect(text($("[data-pay-state]"))).toContain(TEXT.expired);
    expect($("[data-pay-state] a[data-state-link]").getAttribute("href")).toBe(
      `/price.html?priced=${BASE_ID}`,
    );

    page = await openPage({ fake: fakeApi({ payment: payment({ status: "cancelled" }) }) });
    expect(text($("[data-pay-state]"))).toContain(TEXT.inactive);

    // A declined card leaves the payment `failed`: it takes the next card.
    page = await openPage({ fake: fakeApi({ payment: payment({ status: "failed" }) }) });
    expect($("[data-pay-content]").hidden).toBe(false);
  });

  it("[OFE-014] an address without valid ids, or a payment of another checkout, is not found", async () => {
    let page = await openPage({ query: `id=${CHECKOUT_ID}&payment=pay_bad` });
    expect(text($("[data-pay-state]"))).toContain(TEXT.missing);
    expect(page.client.storefront.get).not.toHaveBeenCalled();

    page = await openPage({
      fake: fakeApi({ payment: payment({ checkoutId: "chk_01JANOTHERCHECKOUT01" }) }),
    });
    expect(text($("[data-pay-state]"))).toContain(TEXT.missing);
    expect($("[data-pay-content]").hidden).toBe(true);
  });

  it("[OFE-014] a suspended storefront replaces the page; a service outage offers Retry", async () => {
    await openPage({
      fake: fakeApi({
        storefrontGet: async () => {
          throw apiError(PermissionError, "TENANT_SUSPENDED", 403);
        },
      }),
    });
    // The full-page state takes the place of the page, its title the only heading.
    expect($("main > [data-state]").dataset.state).toBe("suspended");
    expect(Array.from(document.querySelectorAll("main h1"), (heading) => text(heading))).toEqual([
      TEXT.suspended,
    ]);
    expect(document.querySelector("main form")).toBeNull();

    let calls = 0;
    const fake = fakeApi({
      storefrontGet: async () => {
        calls += 1;
        if (calls === 1) {
          throw apiError(ConnectionError, "NETWORK_ERROR", 0);
        }
        return CONFIG;
      },
    });
    await openPage({ fake });
    expect(text($("[data-pay-state]"))).toContain(TEXT.unavailable);
    /** @type {HTMLButtonElement} */ ($('[data-pay-state] [data-action="retry"]')).click();
    await settle();
    expect($("[data-pay-content]").hidden).toBe(false);
  });
});

describe("airline-card page: the card fee and Pay", () => {
  it("[OFE-014] six digits: the brand is detected locally and only brand and BIN go to updatePayment", async () => {
    const page = await openPage();
    type("number", "4242 4");
    await settle();
    expect(page.client.checkout.updatePayment).not.toHaveBeenCalled();

    type("number", "4242 42");
    await settle();
    expect(page.client.checkout.updatePayment).toHaveBeenCalledTimes(1);
    expect(page.client.checkout.updatePayment).toHaveBeenCalledWith(
      { paymentId: PAYMENT_ID, card: { brand: "VISA", bin: "424242" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(text($("[data-card-brand]"))).toBe("Visa card");

    // More digits of the same BIN: no new quote; the review shows what the airline charges.
    type("number", "4242 4242 4242 4242");
    await settle();
    expect(page.client.checkout.updatePayment).toHaveBeenCalledTimes(1);
    expect($("[data-review-panel]").hidden).toBe(false);
    expect(text($("[data-review-card-fee]"))).toBe(money("6.20"));
    expect(text($("[data-review-total]"))).toBe(money("418.50"));
    expect(text($("[data-total]"))).toBe(money("418.50"));
    expect(text(payButton())).toBe(`Pay ${money("418.50")}`);

    // Another card: a new quote for its brand and BIN, never more of the number.
    type("number", MASTERCARD);
    await settle();
    expect(page.client.checkout.updatePayment).toHaveBeenLastCalledWith(
      { paymentId: PAYMENT_ID, card: { brand: "MASTERCARD", bin: "555555" } },
      expect.anything(),
    );
    for (const [params] of page.client.checkout.updatePayment.mock.calls) {
      expect(JSON.stringify(params)).not.toMatch(/\d{7,}/);
    }
  });

  it("[OFE-014] a brand the OTA does not accept is refused before any fee quote", async () => {
    const page = await openPage();
    type("number", AMEX);
    await settle();
    expect(page.client.checkout.updatePayment).not.toHaveBeenCalled();
    expect(text($("[data-card-brand]"))).toBe(
      "We cannot take this card. Pay with one of these cards: Visa, Mastercard.",
    );
    await fillCard({ number: AMEX, csc: "1234" });
    await submit();
    expect(page.client.checkout.completeWithAirlineCard).not.toHaveBeenCalled();
    expect(field("number").getAttribute("aria-invalid")).toBe("true");
  });

  it("[OFE-014] the total is reviewed before Pay: a submit before the quote answered shows the review first", async () => {
    /** @type {(value?: unknown) => void} */
    let answer = () => {};
    const fake = fakeApi({
      updatePayment: () =>
        new Promise((resolve) => {
          answer = () => resolve(payment({ cardFee: eur("6.20"), amount: eur("418.50") }));
        }),
    });
    const page = await openPage({ fake });
    await fillCard();
    await submit();
    expect(page.client.checkout.completeWithAirlineCard).not.toHaveBeenCalled();
    answer();
    await settle();
    expect($("[data-review-panel]").hidden).toBe(false);
    expect(document.activeElement).toBe($("#review-title"));

    await submit();
    expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledTimes(1);
  });

  it("[OFE-014 AC2] success: the card goes once, with a new key and 90 s; the inputs are emptied", async () => {
    const page = await openPage();
    await fillCard();
    await submit();

    expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledTimes(1);
    expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledWith(
      { checkoutId: CHECKOUT_ID, paymentId: PAYMENT_ID, expectedTotal: eur("418.50"), card: sentCard() },
      { idempotencyKey: "airline-card-submit-1-0f3c", timeoutMs: COMPLETION_TIMEOUT_MS },
    );
    expect(COMPLETION_TIMEOUT_MS).toBe(90_000);
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
    expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-014 AC2] decline: the inputs are emptied and the next card goes with a new key", async () => {
    let calls = 0;
    const fake = fakeApi({
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          throw apiError(PaymentError, "PAYMENT_DECLINED", 402);
        }
        return {
          checkoutId: CHECKOUT_ID,
          booking: { id: BOOKING_ID },
          bookingToken: null,
          bookingTokenExpiresAt: null,
        };
      },
    });
    const page = await openPage({ fake });
    await fillCard();
    await submit();

    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
    expect(text($("[data-pay-notice]"))).toContain(TEXT.declined);
    expect($("[data-review-panel]").hidden).toBe(true);
    expect(page.replace).not.toHaveBeenCalled();

    await fillCard({ number: MASTERCARD });
    await submit();
    const keys = page.client.checkout.completeWithAirlineCard.mock.calls.map(
      (call) => call[1].idempotencyKey,
    );
    expect(keys).toEqual(["airline-card-submit-1-0f3c", "airline-card-submit-2-0f3c"]);
    expect(page.client.checkout.completeWithAirlineCard.mock.calls[1]?.[0].card).toEqual(
      sentCard({ brand: "MASTERCARD", number: MASTERCARD }),
    );
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
    expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-014 AC2] pagehide empties the card inputs (Back and the back-forward cache never show them)", async () => {
    await openPage();
    await fillCard();
    expect(field("number").value).toBe(VISA);

    window.dispatchEvent(new Event("pagehide"));
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
    expect($("[data-review-panel]").hidden).toBe(true);

    await fillCard();
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
  });

  it("[OFE-014 AC2] no storage API is called, and no cookie, address, history entry, event or console holds the card", async () => {
    const storage = ["getItem", "setItem", "removeItem", "clear", "key"].map((method) =>
      vi.spyOn(Storage.prototype, /** @type {"getItem"} */ (method)),
    );
    // The spies see every Storage call (a check that this test can fail).
    localStorage.getItem("probe");
    expect(storage[0]).toHaveBeenCalledTimes(1);
    storage[0]?.mockClear();
    const consoles = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, /** @type {"log"} */ (method)),
    );
    const cookie = document.cookie;
    let calls = 0;
    const fake = fakeApi({
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          throw apiError(PaymentError, "PAYMENT_DECLINED", 402);
        }
        return {
          checkoutId: CHECKOUT_ID,
          booking: { id: BOOKING_ID },
          bookingToken: null,
          bookingTokenExpiresAt: null,
        };
      },
    });
    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    const dispatched = vi.spyOn(EventTarget.prototype, "dispatchEvent");
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);

    const page = await openPage({ fake });
    replaceState.mockClear();
    await fillCard();
    await submit();
    await fillCard();
    await submit();
    window.dispatchEvent(new Event("pagehide"));
    // The whole flow ran: a quote, a decline, a second card and the booking.
    expect(page.client.checkout.updatePayment).toHaveBeenCalled();
    expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledTimes(2);
    expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);

    for (const spy of storage) {
      expect(spy).not.toHaveBeenCalled();
    }
    for (const spy of [...consoles, pushState, replaceState, reportError]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(document.cookie).toBe(cookie);
    expect(history.state).toBeNull();
    expect(location.href).toBe(`${location.origin}/checkout/pay-airline.html?${QUERY}`);
    for (const [event] of dispatched.mock.calls) {
      expect(event).not.toBeInstanceOf(CustomEvent);
    }
    // The module never names a store, the cookie, the history, the console or an event of its own.
    const source = readFileSync(join(STOREFRONT_ROOT, "src/pages/checkout-pay-airline.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).toContain("completeWithAirlineCard");
    expect(source).not.toMatch(
      /localStorage|sessionStorage|indexedDB|caches\.|document\.cookie|history\.|console\.|reportError|CustomEvent|postMessage|\.dispatchEvent|new\s+Error\(/,
    );
  });
});

describe("airline-card page: states of pages.md §9", () => {
  it("[OFE-014] local checks: a card the API would refuse is never sent, and its values stay for the correction", async () => {
    const page = await openPage();
    await fillCard({ holder: "M", number: "4242424242424241", month: "13", year: String(YEAR), csc: "12" });
    await submit();
    expect(page.client.checkout.completeWithAirlineCard).not.toHaveBeenCalled();
    for (const name of ["holder", "number", "month", "year", "csc"]) {
      expect(field(name).getAttribute("aria-invalid"), name).toBe("true");
    }
    expect(text($("[data-card-errors]"))).toContain(TEXT.errorNumber);
    expect(document.activeElement).toBe($("[data-card-errors]"));
    expect(field("number").value).toBe("4242424242424241");

    await fillCard({ month: "01", year: String(new Date().getUTCFullYear() - 1) });
    await submit();
    expect(text($("#card-expiry-error"))).toBe(TEXT.errorExpired);
    expect(field("holder").hasAttribute("aria-invalid")).toBe(false);
    expect(page.client.checkout.completeWithAirlineCard).not.toHaveBeenCalled();
  });

  it("[OFE-014] 400 VALIDATION_FAILED marks the fields without echoing a value", async () => {
    const fake = fakeApi({
      complete: async () => {
        throw apiError(ValidationError, "VALIDATION_FAILED", 400, {
          fieldErrors: [
            { path: "/card/number", code: "luhn", message: "The card number is not valid." },
            { path: "/card/expiryYear", code: "expired", message: "The card has expired." },
          ],
        });
      },
    });
    await openPage({ fake });
    await fillCard();
    await submit();
    expect(field("number").getAttribute("aria-invalid")).toBe("true");
    expect(field("month").getAttribute("aria-invalid")).toBe("true");
    expect(text($("#card-number-error"))).toBe(TEXT.errorNumber);
    expect(text($("#card-expiry-error"))).toBe(TEXT.errorExpired);
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
    expect(document.body.textContent).not.toContain(VISA);
  });

  it("[OFE-014] 504 SUPPLIER_TIMEOUT opens the confirmation in pending mode and never sends the card again", async () => {
    const fake = fakeApi({
      complete: async () => {
        throw apiError(SupplierError, "SUPPLIER_TIMEOUT", 504, {
          details: { bookingId: BOOKING_ID, replayed: false },
        });
      },
    });
    const page = await openPage({ fake });
    await fillCard();
    await submit();
    expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);
    expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledTimes(1);
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
    await submit();
    expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledTimes(1);
  });

  it("[OFE-014] a lost connection: the checkout's booking opens in pending mode; without one the card is typed again", async () => {
    const lost = async () => {
      throw apiError(ConnectionError, "NETWORK_ERROR", 0);
    };
    let page = await openPage({ fake: fakeApi({ complete: lost }) });
    page.api.checkout = checkout({ bookingId: BOOKING_ID });
    await fillCard();
    await submit();
    expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);

    page = await openPage({ fake: fakeApi({ complete: lost }) });
    await fillCard();
    await submit();
    expect(page.replace).not.toHaveBeenCalled();
    expect(text($("[data-pay-notice]"))).toContain(TEXT.notSent);
    expect($("[data-pay-content]").hidden).toBe(false);
    expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledTimes(1);
  });

  it("[OFE-014] 403 PAYMENT_ATTEMPTS_EXCEEDED: too many attempts, with card payment and a new booking", async () => {
    const fake = fakeApi({
      complete: async () => {
        throw apiError(PermissionError, "PAYMENT_ATTEMPTS_EXCEEDED", 403);
      },
    });
    await openPage({ fake });
    await fillCard();
    await submit();
    expect(text($("[data-pay-state]"))).toContain(TEXT.attemptsExceeded);
    expect($("[data-pay-content]").hidden).toBe(true);
    expect(
      Array.from(document.querySelectorAll("[data-pay-state] a[data-state-link]"), (link) =>
        link.getAttribute("href"),
      ),
    ).toEqual([`/checkout.html?id=${CHECKOUT_ID}&step=payment`, "/"]);
  });

  it("[OFE-014] 409 PRICE_CHANGED shows the new price; the traveller types the card again", async () => {
    const fake = fakeApi({
      complete: async () => {
        fake.api.checkout = checkout({
          totals: { ...checkout().totals, offer: eur("430.00"), total: eur("430.00") },
        });
        fake.api.payment = payment({ amount: eur("430.00") });
        throw apiError(PriceChangedError, "PRICE_CHANGED", 409, {
          details: { oldPrice: eur("412.30"), newPrice: eur("430.00") },
        });
      },
    });
    const page = await openPage({ fake });
    await fillCard();
    await submit();
    expect(text($("[data-pay-notice]"))).toContain(
      `The new total is ${money("430.00")} (before: ${money("412.30")}). Type your card again to pay it.`,
    );
    expect(text($("[data-total]"))).toBe(money("430.00"));
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
    expect(text(payButton())).toBe(TEXT.review);
    expect(page.replace).not.toHaveBeenCalled();
  });

  it("[OFE-014] 409 SOLD_OUT and 403 FEATURE_DISABLED replace the form", async () => {
    await openPage({
      fake: fakeApi({
        complete: async () => {
          throw apiError(SoldOutError, "SOLD_OUT", 409);
        },
      }),
    });
    await fillCard();
    await submit();
    expect(text($("[data-pay-state]"))).toContain(TEXT.soldOut);
    expect($("[data-pay-content]").hidden).toBe(true);

    await openPage({
      fake: fakeApi({
        complete: async () => {
          throw apiError(PermissionError, "FEATURE_DISABLED", 403, { details: { feature: "airlineCard" } });
        },
      }),
    });
    await fillCard();
    await submit();
    expect(text($("[data-pay-state]"))).toContain(TEXT.notOffered);
    expect($("[data-pay-state] a[data-state-link]").getAttribute("href")).toBe(
      `/checkout.html?id=${CHECKOUT_ID}&step=payment`,
    );
  });

  it("[OFE-014] a checkout completed or being completed meanwhile opens its confirmation", async () => {
    const page = await openPage({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ConflictError, "CHECKOUT_BEING_COMPLETED", 409, {
            details: { bookingId: BOOKING_ID },
          });
        },
      }),
    });
    await fillCard();
    await submit();
    expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);
  });

  it("[OFE-014] an answer the page cannot place shows 'Something went wrong' with the request id; the form stays", async () => {
    await openPage({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ServerError, "INTERNAL_ERROR", 500);
        },
      }),
    });
    await fillCard();
    await submit();
    expect(text($("[data-pay-notice]"))).toContain(TEXT.unexpected);
    expect(text($("[data-pay-notice]"))).toContain("req_payairline");
    expect($("[data-pay-content]").hidden).toBe(false);
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
  });

  it("[OFE-014] the other answers of Pay replace the form with their state; the card went once and the inputs are empty", async () => {
    const paymentStep = `/checkout.html?id=${CHECKOUT_ID}&step=payment`;
    const travellers = `/checkout.html?id=${CHECKOUT_ID}&step=travellers`;
    const priceAgain = `/price.html?priced=${BASE_ID}`;
    const cases = /** @type {Array<[Error, string, string, string[]]>} */ ([
      [apiError(ExpiredError, "CHECKOUT_EXPIRED", 410), "checkout-expired", TEXT.expired, [priceAgain]],
      [apiError(ExpiredError, "OFFER_EXPIRED", 410), "checkout-expired", TEXT.expired, [priceAgain]],
      [apiError(ValidationError, "CHECKOUT_INCOMPLETE", 422), "incomplete", TEXT.incomplete, [travellers]],
      [apiError(ValidationError, "TRAVELER_DATA_INVALID", 422), "incomplete", TEXT.incomplete, [travellers]],
      [apiError(ValidationError, "CONTACT_DATA_INVALID", 422), "incomplete", TEXT.incomplete, [travellers]],
      [apiError(SupplierError, "SUPPLIER_ERROR", 502), "not-booked", TEXT.notBooked, [paymentStep, "/"]],
      [apiError(SupplierError, "TICKETING_FAILED", 502), "not-booked", TEXT.notBooked, [paymentStep, "/"]],
    ]);
    for (const [error, state, title, links] of cases) {
      const page = await openPage({
        fake: fakeApi({
          complete: async () => {
            throw error;
          },
        }),
      });
      await fillCard();
      await submit();
      expect(page.client.checkout.completeWithAirlineCard, state).toHaveBeenCalledTimes(1);
      expect($("[data-pay-state] [data-state]").dataset.state, title).toBe(state);
      expect(text($("[data-pay-state]")), state).toContain(title);
      expect($("[data-pay-content]").hidden, state).toBe(true);
      expect(
        Array.from(document.querySelectorAll("[data-pay-state] a[data-state-link]"), (link) =>
          link.getAttribute("href"),
        ),
        state,
      ).toEqual(links);
      expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
      expect(page.replace).not.toHaveBeenCalled();
    }
  });

  it("[OFE-014] 409 PAYMENT_AMOUNT_MISMATCH reads the payment again; 422 UNPROCESSABLE names the accepted brands", async () => {
    let page = await openPage({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ConflictError, "PAYMENT_AMOUNT_MISMATCH", 409);
        },
      }),
    });
    await fillCard();
    await submit();
    expect(page.client.checkout.getPayment).toHaveBeenCalledTimes(2);
    expect(text($("[data-pay-notice]"))).toContain(TEXT.amountChanged);
    expect($("[data-pay-content]").hidden).toBe(false);
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
    expect(text(payButton())).toBe(TEXT.review);

    page = await openPage({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ValidationError, "UNPROCESSABLE", 422, {
            details: { reason: "card_brand_not_accepted" },
          });
        },
      }),
    });
    await fillCard();
    await submit();
    expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledTimes(1);
    expect(field("number").getAttribute("aria-invalid")).toBe("true");
    expect(text($("#card-number-error"))).toBe(
      "We cannot take this card. Pay with one of these cards: Visa, Mastercard.",
    );
    expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
  });

  it("[OFE-014] 429 RATE_LIMITED on Pay: Busy, and Pay comes back after Retry-After with a new key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let calls = 0;
      const page = await openPage({
        fake: fakeApi({
          complete: async () => {
            calls += 1;
            if (calls === 1) {
              throw apiError(RateLimitError, "RATE_LIMITED", 429, { details: { retryAfterSeconds: 3 } });
            }
            return {
              checkoutId: CHECKOUT_ID,
              booking: { id: BOOKING_ID },
              bookingToken: null,
              bookingTokenExpiresAt: null,
            };
          },
        }),
      });
      await fillCard();
      await submit();
      expect(text($("[data-pay-notice]"))).toContain(TEXT.rateLimited);
      expect(payButton().getAttribute("aria-disabled")).toBe("true");
      expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);

      // Pay stays off until Retry-After has passed.
      await fillCard();
      await submit();
      expect(page.client.checkout.completeWithAirlineCard).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_999);
      expect(payButton().getAttribute("aria-disabled")).toBe("true");
      vi.advanceTimersByTime(1);
      expect(payButton().hasAttribute("aria-disabled")).toBe(false);

      await submit();
      expect(
        page.client.checkout.completeWithAirlineCard.mock.calls.map((call) => call[1].idempotencyKey),
      ).toEqual(["airline-card-submit-1-0f3c", "airline-card-submit-2-0f3c"]);
      expect(page.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[OFE-014] the fee quote: a price change or a payment that cannot be used goes back to the payment step", async () => {
    const paymentStep = `/checkout.html?id=${CHECKOUT_ID}&step=payment`;
    const cases = /** @type {Array<[Error, string, string]>} */ ([
      [
        apiError(PriceChangedError, "PRICE_CHANGED", 409, { details: { newPrice: eur("430.00") } }),
        "price-changed",
        TEXT.quotePriceChanged,
      ],
      [apiError(ConflictError, "PAYMENT_NOT_UPDATABLE", 409), "payment-inactive", TEXT.inactive],
    ]);
    for (const [error, state, title] of cases) {
      const page = await openPage({
        fake: fakeApi({
          updatePayment: async () => {
            throw error;
          },
        }),
      });
      await fillCard();
      expect(page.client.checkout.updatePayment, state).toHaveBeenCalledTimes(1);
      expect($("[data-pay-state] [data-state]").dataset.state).toBe(state);
      expect(text($("[data-pay-state]"))).toContain(title);
      expect($("[data-pay-content]").hidden).toBe(true);
      expect($("[data-pay-state] a[data-state-link]").getAttribute("href")).toBe(paymentStep);
      expect(cardInputs().map((input) => input.value)).toEqual(["", "", "", "", ""]);
      await submit();
      expect(page.client.checkout.completeWithAirlineCard).not.toHaveBeenCalled();
    }

    // A brand the API refuses for this storefront: the number is marked, no total is quoted and nothing is paid.
    const page = await openPage({
      fake: fakeApi({
        updatePayment: async () => {
          throw apiError(ValidationError, "UNPROCESSABLE", 422, {
            details: { reason: "card_brand_not_accepted" },
          });
        },
      }),
    });
    await fillCard();
    expect(field("number").getAttribute("aria-invalid")).toBe("true");
    expect($("[data-review-panel]").hidden).toBe(true);
    expect(text(payButton())).toBe(TEXT.review);
    await submit();
    expect(page.client.checkout.completeWithAirlineCard).not.toHaveBeenCalled();
  });
});

describe("airline-card page: the production build", () => {
  /** @type {string | undefined} */
  let dist;
  /** @type {import("vite").PreviewServer | undefined} */
  let server;
  // A stand-in for the OTA API behind the preview's /api proxy: it answers like helmet does, with COOP same-origin.
  const api = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.end('{"ok":true}');
  });

  // A full `vite build` (every page, then this page on its own) and the preview server over it: a few seconds alone,
  // longer under the parallel pnpm test, so both happen in this hook with its own budget.
  beforeAll(async () => {
    await new Promise((resolve) => {
      api.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    const address = api.address();
    // `vite preview` runs the config's development proxy, which needs these (dev values, never in the bundle).
    vi.stubEnv(
      "OTA_API_URL",
      `http://127.0.0.1:${address && typeof address === "object" ? address.port : 9}`,
    );
    vi.stubEnv("VELEXIS_EDGE_SECRET", "edge-secret-marker-for-ofe-014-tests");
    vi.stubEnv("STOREFRONT_DEV_HOST", "demo.ota.example.com");
    dist = scratchDir("pay-airline");
    await buildStorefront(dist);
    server = await preview({
      configFile: VITE_CONFIG,
      logLevel: "silent",
      build: { outDir: dist },
      preview: { host: "127.0.0.1", port: 0, open: false },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await new Promise((resolve) => {
      api.close(() => resolve(undefined));
    });
    removeScratch(dist);
  });

  it("[OFE-014 AC1] the built page references only its own bundle, which imports nothing and no other page loads", () => {
    const out = /** @type {string} */ (dist);
    const html = readFileSync(join(out, PAGE), "utf8");
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(
      /^<script type="module" crossorigin src="\/assets\/checkout-pay-airline-[\w-]{8}\.js">$/,
    );
    expect(html).not.toMatch(/modulepreload/);
    const bundle = /** @type {string} */ (scripts[0]?.match(/src="\/([^"]+)"/)?.[1]);
    // Every file the page references is its own: the bundle and its stylesheet, nothing from another origin.
    expect(
      [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((url) => url?.startsWith("/assets/")),
    ).toEqual([`/${bundle}`, expect.stringMatching(/^\/assets\/checkout-pay-airline-[\w-]{8}\.css$/)]);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
    const code = readFileSync(join(out, bundle), "utf8");
    expect(code).not.toMatch(/\bimport\s*\(|\bfrom\s*["'`]|\bimport\s*["'`]/);
    for (const file of filesIn(out).filter((name) => name.endsWith(".html") && name !== PAGE)) {
      expect(readFileSync(join(out, file), "utf8"), file).not.toContain("checkout-pay-airline");
    }
    expect(html).toContain('autocomplete="cc-number"');
  });

  it("[OFE-014 AC1] the page's JavaScript is within 30 KB gzip (scripts/check-budgets.mjs)", () => {
    const result = checkBudgets(/** @type {string} */ (dist));
    const row = result.rows.find((entry) => entry.page === PAGE && entry.kind === "js");
    expect(PAGE_JS_BUDGETS[PAGE]).toBe(30 * KB);
    expect(row?.limit).toBe(30 * KB);
    expect(row?.files.map((file) => file.file)).toEqual([
      expect.stringMatching(/^assets\/checkout-pay-airline-[\w-]{8}\.js$/),
    ]);
    expect(row?.bytes).toBeLessThanOrEqual(30 * KB);
    expect(row?.ok).toBe(true);
    expect(BUDGETS.js).toBe(60 * KB);
    expect(passes(result)).toBe(true);
  });

  it("[OFE-014] vite preview sends the Caddyfile's airline-card headers on that page, and COOP on no other answer", async () => {
    const caddy = payAirlineCaddyHeaders(
      readFileSync(join(REPO_ROOT, "deploy", "caddy", "Caddyfile"), "utf8"),
    );
    expect(caddy.paths).toEqual(["/checkout/pay-airline.html", "/checkout/pay-airline"]);
    expect(caddy.headers["Content-Security-Policy"]).not.toMatch(/stripe/i);
    expect(caddy.headers["Content-Security-Policy"]).toContain("worker-src 'none'");
    expect(caddy.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(caddy.headers["Cache-Control"]).toBe("no-store");
    const url = baseUrl(/** @type {import("vite").PreviewServer} */ (server));

    for (const path of caddy.paths) {
      const response = await httpRequest(`${url}${path}?${QUERY}`, { headers: NAVIGATION });
      expect(response.status, path).toBe(200);
      expect(response.body, path).toContain("data-pay-airline-page");
      for (const [name, value] of Object.entries(caddy.headers)) {
        expect(response.headers[name.toLowerCase()], `${path} ${name}`).toBe(value);
      }
      expect(response.headers["referrer-policy"], path).toBe(STOREFRONT_HEADERS["Referrer-Policy"]);
    }
    for (const path of ["/", "/checkout/pay-card.html", "/no-such-page"]) {
      const response = await httpRequest(`${url}${path}`, { headers: NAVIGATION });
      expect(response.headers["cross-origin-opener-policy"], path).toBeUndefined();
      expect(response.headers["content-security-policy"], path).toBe(
        STOREFRONT_HEADERS["Content-Security-Policy"],
      );
      expect(response.headers["content-security-policy"], path).toContain("worker-src 'none'");
    }
    // The API answers with helmet's COOP same-origin; the storefront's /api proxy drops it, as Caddy does.
    const proxied = await httpRequest(`${url}/api/v1/storefront`);
    expect(proxied.status).toBe(200);
    expect(proxied.body).toBe('{"ok":true}');
    expect(proxied.headers["cross-origin-opener-policy"]).toBeUndefined();
  });
});

/**
 * The paths of the Caddyfile's `@pay_airline` matcher and the headers of its `header @pay_airline { … }` block (the
 * `defer` line left out). Throws when either is missing, so the comparison never passes by reading nothing.
 * @param {string} caddyfile
 */
function payAirlineCaddyHeaders(caddyfile) {
  const matcher = caddyfile.match(/^\s*@pay_airline\s+path\s+(.+)$/m);
  const block = caddyfile.match(/^\s*header\s+@pay_airline\s*\{\n([\s\S]*?)\n\s*\}/m);
  if (!matcher || !block) {
    throw new Error("Caddyfile: no @pay_airline matcher or header block");
  }
  /** @type {Record<string, string>} */
  const headers = {};
  for (const raw of (block[1] ?? "").split("\n")) {
    const line = raw.trim();
    const m = line.match(/^([A-Za-z0-9-]+)\s+"((?:[^"\\]|\\.)*)"$/);
    if (m) {
      headers[m[1] ?? ""] = m[2] ?? "";
    } else if (line !== "defer" && line !== "") {
      throw new Error(`Caddyfile: cannot read the airline-card header line ${JSON.stringify(line)}`);
    }
  }
  return { paths: (matcher[1] ?? "").trim().split(/\s+/), headers };
}
