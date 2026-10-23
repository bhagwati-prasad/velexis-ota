// The card payment page (ota/frontend/docs/pages.md §8, flow ota/docs/flows/checkout-stripe.md §2 steps 4–5,
// OADR-0015 point 9): checkout/pay-card.html with its partials expanded by the build's include plugin, run by
// src/pages/checkout-pay-card.js against a fake SDK and a fake Stripe.js. It covers the Payment Element (the payment's
// key and client secret, the Connect account, the OTA's colours in the Appearance API), "Review total" (submit,
// confirmation token, `checkout.updatePayment` with the Amadeus brand, `elements.fetchUpdates`, the final total with
// card fee, merchant name and statement descriptor), Pay (`confirmPayment` with the complete page as return URL), the
// states of §8, and on the production build (vite build into a scratch folder) the page's two scripts and the absence
// of any form control outside Stripe's iframe.
import {
  ConflictError,
  ConnectionError,
  ExpiredError,
  NotFoundError,
  PriceChangedError,
  SupplierError,
  ValidationError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { formatMoney } from "../src/lib/format.js";
import { NEUTRAL_PALETTE } from "../src/lib/theme.js";
import {
  STRIPE_JS_URL,
  acceptedBrand,
  airlineCardOffered,
  completeHref,
  start,
  stripeAppearance,
} from "../src/pages/checkout-pay-card.js";
import {
  STOREFRONT_ROOT,
  buildStorefront,
  filesIn,
  removeScratch,
  scratchDir,
} from "./helpers/storefront.js";

/** What the mocked boot() of the page module resolves with; `null` keeps it waiting (the static import above). */
const pageBoot = vi.hoisted(() => ({ context: /** @type {unknown} */ (null) }));
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    boot: () => (pageBoot.context ? Promise.resolve(pageBoot.context) : new Promise(() => {})),
  };
});

const CHECKOUT_ID = "chk_01JPAYCARDCHECKOUT01";
const PAYMENT_ID = "pay_01JPAYCARDPAYMENT001";
const NEW_PAYMENT_ID = "pay_01JPAYCARDPAYMENT002";
const BASE_ID = "prc_01JPAYCARDPRICED0001";
const BOOKING_ID = "bkg_01JPAYCARDBOOKING01";
/** Fake values in the shapes of Stripe's: a publishable test key, client secrets, a Connect account, a token. */
const PUBLIC_KEY = "pk_test_fake_storefront_fixture";
const CLIENT_SECRET = "pi_fake_paycard_secret_fixture";
const NEW_CLIENT_SECRET = "pi_fake_paycard_secret_renewed";
const ACCOUNT_ID = "acct_fake_connect_fixture";
const TOKEN_ID = "ctoken_fake_paycard_fixture";
const PAGE = "checkout/pay-card.html";

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });
/** @param {string} amount */
const money = (amount) => formatMoney(eur(amount), "en-GB");
/** An ISO timestamp `seconds` from now. */
const fromNow = (/** @type {number} */ seconds) => new Date(Date.now() + seconds * 1000).toISOString();

/** A dark brand palette that passes every contrast rule (test/theme.test.js). */
const BRAND_COLORS = Object.freeze({
  primary: "#93C5FD",
  onPrimary: "#ffffff",
  secondary: "#000000",
  accent: "#5eead4",
  background: "#111827",
  surface: "#1f2937",
  text: "#f9fafb",
  mutedText: "#d1d5db",
  success: "#86efac",
  warning: "#fcd34d",
  error: "#fca5a5",
});

const CONFIG = Object.freeze({
  name: "Demo Travel",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { ancillaries: true, guestCheckout: true, customerAccounts: true },
  branding: { colors: BRAND_COLORS, cornerRadius: "large" },
  payment: {
    provider: "stripe",
    environment: "test",
    accountMode: "velexis",
    publishableKey: PUBLIC_KEY,
    accountId: null,
    merchantName: "Velexis on behalf of Demo Travel",
    statementDescriptor: "DEMO TRAVEL",
    supportedMethods: ["card"],
    cardBrands: ["VISA", "MASTERCARD"],
    pspCardBrands: [
      { amadeus: "VISA", psp: "visa", label: "Visa" },
      { amadeus: "MASTERCARD", psp: "mastercard", label: "Mastercard" },
    ],
    airlineCard: null,
  },
});
/** Connect mode: the OTA's own Stripe account takes the payment. */
const CONNECT_CONFIG = Object.freeze({
  ...CONFIG,
  payment: {
    ...CONFIG.payment,
    accountMode: "connect_standard",
    accountId: ACCOUNT_ID,
    statementDescriptor: null,
  },
});
/** The airline card is offered too. */
const AIRLINE_CONFIG = Object.freeze({
  ...CONFIG,
  payment: {
    ...CONFIG.payment,
    supportedMethods: ["card", "airline_card"],
    airlineCard: {
      enabled: true,
      cardBrands: [],
      chargedBy: "airline",
      notice: "The airline charges your card.",
    },
  },
});

/**
 * The checkout: one way Paris–New York, card fee not known yet.
 * @param {Record<string, unknown>} [overrides]
 */
function checkout(overrides = {}) {
  return {
    id: CHECKOUT_ID,
    status: "payment_pending",
    isGuest: true,
    pricedOfferId: BASE_ID,
    basePricedOfferId: BASE_ID,
    currency: "EUR",
    totals: {
      currency: "EUR",
      offer: eur("412.30"),
      ancillaries: eur("0.00"),
      cardFee: null,
      total: eur("412.30"),
    },
    ancillaries: [],
    itineraries: [
      {
        index: 0,
        originCode: "CDG",
        destinationCode: "JFK",
        departureAt: "2026-12-01T10:00:00",
        arrivalAt: "2026-12-01T12:20:00",
        duration: "PT8H20M",
        durationMinutes: 500,
        stops: 0,
        stopAirports: [],
        arrivalDayOffset: 0,
        marketingCarriers: ["AF"],
        segments: [],
      },
    ],
    summary: { tripType: "one_way" },
    bookingId: null,
    version: 7,
    expiresAt: fromNow(15 * 60),
    ...overrides,
  };
}

/**
 * The card payment as `checkout.createPayment` made it.
 * @param {Record<string, unknown>} [overrides]
 */
function payment(overrides = {}) {
  return {
    id: PAYMENT_ID,
    checkoutId: CHECKOUT_ID,
    bookingId: null,
    purpose: "booking",
    provider: "stripe",
    method: "card",
    status: "requires_payment_method",
    captureMethod: "manual",
    amount: eur("412.30"),
    cardFee: null,
    cardHint: null,
    clientSecret: CLIENT_SECRET,
    providerPublicKey: PUBLIC_KEY,
    nextAction: { type: "confirm_with_provider_sdk", redirectUrl: null },
    ...overrides,
  };
}

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_paycard", ...body });

/**
 * A fake API with the payment and the checkout as state. `updatePayment` quotes a card fee of €8.25 on the same
 * payment; `createPayment` makes the next payment. `order` records the calls that must follow each other.
 * @param {{ payment?: object, checkout?: object, order?: string[] } & Record<string, Function | object | undefined>} [options]
 */
function fakeApi({
  payment: initialPayment = payment(),
  checkout: initial = checkout(),
  order = [],
  ...overrides
} = {}) {
  const api = { payment: /** @type {Record<string, any>} */ (initialPayment), checkout: initial };
  const client = {
    checkout: {
      get: vi.fn(/** @type {Function} */ (overrides["get"]) ?? (async () => api.checkout)),
      getPayment: vi.fn(/** @type {Function} */ (overrides["getPayment"]) ?? (async () => api.payment)),
      updatePayment: vi.fn(async (/** @type {{ card: object }} */ params, /** @type {unknown} */ options) => {
        order.push("updatePayment");
        const override = /** @type {Function | undefined} */ (overrides["updatePayment"]);
        if (override) {
          return override(params, options);
        }
        api.payment = { ...api.payment, cardHint: params.card, cardFee: eur("8.25"), amount: eur("420.55") };
        return api.payment;
      }),
      createPayment: vi.fn(
        /** @type {Function} */ (overrides["createPayment"]) ??
          (async () => {
            api.payment = payment({ id: NEW_PAYMENT_ID, clientSecret: NEW_CLIENT_SECRET });
            return api.payment;
          }),
      ),
    },
  };
  return { api, client, order };
}

/**
 * A fake Stripe.js: `Stripe(key, options)` gives an instance whose Payment Element mounts an empty iframe (like
 * Stripe's, whose inputs live in another origin) and says `ready`. Every call that must follow another is pushed to
 * `order`. Each method can be replaced.
 * @param {{ order?: string[], brand?: string, ready?: boolean } & Record<string, Function | string | boolean | string[] | undefined>} [options]
 */
function fakeStripe({ order = [], brand = "visa", ready = true, ...overrides } = {}) {
  /** @type {Array<Record<string, any>>} */
  const created = [];
  /** @type {Array<Record<string, any>>} */
  const instances = [];
  const stripe = {
    elements: vi.fn((/** @type {Record<string, unknown>} */ options) => {
      const elements = {
        options,
        create: vi.fn((/** @type {string} */ type, /** @type {Record<string, unknown>} */ createOptions) => {
          /** @type {Record<string, Function>} */
          const handlers = {};
          const element = {
            type,
            createOptions,
            mounted: /** @type {HTMLElement | null} */ (null),
            on: vi.fn((/** @type {string} */ event, /** @type {Function} */ handler) => {
              handlers[event] = handler;
            }),
            mount: vi.fn((/** @type {HTMLElement} */ target) => {
              element.mounted = target;
              const frame = target.ownerDocument.createElement("iframe");
              frame.setAttribute("name", "__privateStripeFrameFake");
              frame.setAttribute("title", "Secure payment input frame");
              target.append(frame);
              if (ready) {
                queueMicrotask(() => handlers["ready"]?.({ elementType: "payment" }));
              }
            }),
            destroy: vi.fn(),
            /** Fires one of the element's events, as Stripe.js would. */
            emit: (/** @type {string} */ event, /** @type {unknown} */ payload = {}) =>
              handlers[event]?.(payload),
          };
          created.push(element);
          return element;
        }),
        submit: vi.fn(async () => {
          order.push("submit");
          return typeof overrides["submit"] === "function" ? overrides["submit"]() : {};
        }),
        fetchUpdates: vi.fn(async () => {
          order.push("fetchUpdates");
          return typeof overrides["fetchUpdates"] === "function" ? overrides["fetchUpdates"]() : {};
        }),
      };
      instances.push(elements);
      return elements;
    }),
    createConfirmationToken: vi.fn(async () => {
      order.push("createConfirmationToken");
      return typeof overrides["createConfirmationToken"] === "function"
        ? overrides["createConfirmationToken"]()
        : { confirmationToken: { id: TOKEN_ID, payment_method_preview: { type: "card", card: { brand } } } };
    }),
    confirmPayment: vi.fn(async () => {
      order.push("confirmPayment");
      return typeof overrides["confirmPayment"] === "function"
        ? overrides["confirmPayment"]()
        : { paymentIntent: { id: "pi_fake_paycard", status: "requires_capture" } };
    }),
  };
  return {
    Stripe: vi.fn(() => stripe),
    stripe,
    created,
    instances,
    /** The newest Payment Element. */
    get element() {
      return /** @type {Record<string, any>} */ (created.at(-1));
    },
    /** The newest Elements group. */
    get elements() {
      return /** @type {Record<string, any>} */ (instances.at(-1));
    },
  };
}

/** @type {Browser | undefined} */
let browser;
/** The parsed page. @type {Document | undefined} */
let pageDocument;
/** The expanded HTML of the page. */
let pageHtml = "";
/** The test window's address and title before each test. */
const original = { address: "", title: "" };
/** Views started by the current test, destroyed after it. */
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

/**
 * Puts a fresh copy of the page's body into the test document at `path`.
 * @param {string} path
 */
function showPage(path) {
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
const reviewButton = () => /** @type {HTMLButtonElement} */ ($("button[data-review-button]"));
const payButton = () => /** @type {HTMLButtonElement} */ ($("button[data-pay-button]"));

/**
 * Starts the card payment page at `/checkout/pay-card.html?<query>` with a fake SDK and a fake Stripe.js (`stripe:
 * null` for a page where Stripe.js did not load).
 * @param {{ query?: string, fake?: ReturnType<typeof fakeApi>, stripe?: ReturnType<typeof fakeStripe> | null, config?: object, before?: () => void }} [options]
 */
async function openPayCard({
  query = `id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
  fake = fakeApi(),
  stripe = fakeStripe({ order: fake.order }),
  config = CONFIG,
  before,
} = {}) {
  showPage(`/checkout/pay-card.html?${query}`);
  before?.();
  const navigate = vi.fn();
  const replace = vi.fn();
  const reload = vi.fn();
  const view = start(
    { config: /** @type {never} */ (config), client: /** @type {never} */ (fake.client), session: null },
    { navigate, replace, reload, Stripe: /** @type {never} */ (stripe?.Stripe) },
  );
  if (!view) {
    throw new Error("the card payment page did not start");
  }
  views.push(view);
  await view.done;
  await settle();
  return {
    view,
    ...fake,
    stripe: /** @type {ReturnType<typeof fakeStripe>} */ (stripe),
    navigate,
    replace,
    reload,
  };
}

/** Clicks a button and lets the fakes answer. */
async function click(/** @type {HTMLElement} */ button) {
  button.click();
  await settle();
}

/** The complete page of a payment, as the page navigates to it and as Stripe's absolute return URL. */
const complete = (/** @type {string} */ paymentId = PAYMENT_ID) =>
  `/checkout/complete.html?id=${CHECKOUT_ID}&payment=${paymentId}`;

describe("card payment page: the Payment Element", () => {
  it("[OFE-012] mounts Stripe's Payment Element with the payment's key and client secret and the OTA's colours", async () => {
    const { client, stripe } = await openPayCard();

    expect(client.checkout.getPayment).toHaveBeenCalledWith(
      { paymentId: PAYMENT_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.checkout.get).toHaveBeenCalledWith(
      { checkoutId: CHECKOUT_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // The Velexis account (no Connect account): the key alone.
    expect(stripe.Stripe.mock.calls).toEqual([[PUBLIC_KEY]]);
    expect(stripe.stripe.elements).toHaveBeenCalledTimes(1);
    expect(stripe.elements.options).toEqual({
      clientSecret: CLIENT_SECRET,
      locale: "en",
      appearance: {
        theme: "stripe",
        variables: {
          colorPrimary: "#93c5fd",
          colorBackground: "#111827",
          colorText: "#f9fafb",
          colorTextSecondary: "#d1d5db",
          colorDanger: "#fca5a5",
          colorSuccess: "#86efac",
          colorWarning: "#fcd34d",
          borderRadius: "16px",
        },
      },
    });
    expect(stripe.element.type).toBe("payment");
    expect(stripe.element.mounted).toBe($("[data-payment-element]"));
    expect($("[data-payment-element]").querySelectorAll("iframe")).toHaveLength(1);

    expect($("[data-pay-content]").hidden).toBe(false);
    expect(reviewButton().hidden).toBe(false);
    expect($("[data-review-panel]").hidden).toBe(true);
    expect(document.title).toBe("Pay by card – Checkout");
    expect(text($("[data-total]"))).toBe(money("412.30"));
    expect($("[data-total-card-fee-row]").hidden).toBe(true);
    expect($("a[data-back-link]").getAttribute("href")).toBe(`/checkout.html?id=${CHECKOUT_ID}&step=payment`);
    expect($("a[data-back-link]").hidden).toBe(false);
  });

  it("[OFE-012] passes the OTA's Stripe account as stripeAccount in Connect mode", async () => {
    const { stripe } = await openPayCard({ config: CONNECT_CONFIG });

    expect(stripe.Stripe.mock.calls).toEqual([[PUBLIC_KEY, { stripeAccount: ACCOUNT_ID }]]);
    expect(stripe.element.mounted).toBe($("[data-payment-element]"));
  });

  it("[OFE-012] the Appearance API gets the colours the page applies: neutral ones when the OTA's fail contrast", () => {
    const appearance = stripeAppearance({
      colors: { ...BRAND_COLORS, text: "#1f2937" },
      cornerRadius: "none",
    });
    expect(appearance.variables).toMatchObject({
      colorPrimary: NEUTRAL_PALETTE.primary,
      colorBackground: NEUTRAL_PALETTE.background,
      colorText: NEUTRAL_PALETTE.text,
      borderRadius: "0px",
    });
    expect(stripeAppearance(null).variables["borderRadius"]).toBe("8px");
  });

  it("[OFE-012] keeps the review button hidden until Stripe's element is ready", async () => {
    const fake = fakeApi();
    const stripe = fakeStripe({ order: fake.order, ready: false });
    await openPayCard({ fake, stripe });

    expect(reviewButton().hidden).toBe(true);
    stripe.element.emit("ready");
    expect(reviewButton().hidden).toBe(false);
  });
});

describe("card payment page: review and pay", () => {
  it("[OFE-012] Review total: a confirmation token, the card fee of its brand on the same payment, then fetchUpdates", async () => {
    const { client, stripe, order } = await openPayCard();

    await click(reviewButton());

    expect(order).toEqual(["submit", "createConfirmationToken", "updatePayment", "fetchUpdates"]);
    expect(stripe.stripe.createConfirmationToken).toHaveBeenCalledWith({ elements: stripe.elements });
    // Stripe's `visa` is sent as the Amadeus brand the OTA accepts.
    expect(client.checkout.updatePayment).toHaveBeenCalledWith(
      { paymentId: PAYMENT_ID, card: { brand: "VISA" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // The final total with the card fee, the merchant and the statement descriptor.
    expect($("[data-review-panel]").hidden).toBe(false);
    expect(text($("[data-review-card]"))).toBe("Visa");
    expect(text($("[data-review-card-fee]"))).toBe(money("8.25"));
    expect(text($("[data-review-total]"))).toBe(money("420.55"));
    expect(text($("[data-review-merchant]"))).toBe("Velexis on behalf of Demo Travel");
    expect(text($("[data-review-descriptor]"))).toBe("DEMO TRAVEL");
    expect($("[data-review-descriptor-row]").hidden).toBe(false);
    expect(text(payButton())).toBe(`Pay ${money("420.55")}`);
    expect(document.activeElement).toBe($("#review-title"));
    // The summary follows the payment.
    expect(text($("[data-total]"))).toBe(money("420.55"));
    expect(text($("[data-total-card-fee]"))).toBe(money("8.25"));
    expect($("[data-total-card-fee-row]").hidden).toBe(false);
    expect(stripe.stripe.confirmPayment).not.toHaveBeenCalled();
  });

  it("[OFE-012] Pay confirms the reviewed card with the complete page as return URL, then opens that page", async () => {
    const { stripe, navigate } = await openPayCard();
    await click(reviewButton());

    await click(payButton());

    expect(stripe.stripe.confirmPayment).toHaveBeenCalledTimes(1);
    expect(stripe.stripe.confirmPayment).toHaveBeenCalledWith({
      clientSecret: CLIENT_SECRET,
      confirmParams: { confirmation_token: TOKEN_ID, return_url: `${location.origin}${complete()}` },
      redirect: "if_required",
    });
    expect(navigate).toHaveBeenCalledWith(complete());
    expect(completeHref(CHECKOUT_ID, PAYMENT_ID)).toBe(complete());
    // While the complete page opens, the payment is never confirmed a second time.
    expect(payButton().getAttribute("aria-disabled")).toBe("true");
    await click(payButton());
    await click(reviewButton());
    expect(stripe.stripe.confirmPayment).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("[OFE-012] shows a Connect merchant without a statement descriptor", async () => {
    await openPayCard({ config: CONNECT_CONFIG });
    await click(reviewButton());

    expect(text($("[data-review-merchant]"))).toBe("Velexis on behalf of Demo Travel");
    expect($("[data-review-descriptor-row]").hidden).toBe(true);
  });

  it("[OFE-012] a declined card shows Stripe's message; the traveller reviews again with the same payment", async () => {
    const fake = fakeApi();
    const stripe = fakeStripe({
      order: fake.order,
      confirmPayment: () => ({
        error: { type: "card_error", code: "card_declined", message: "Your card was declined." },
      }),
    });
    const { client, navigate } = await openPayCard({ fake, stripe });
    await click(reviewButton());

    await click(payButton());

    expect(text($("[data-stripe-message]"))).toBe("Your card was declined.");
    expect($("[data-stripe-message]").getAttribute("role")).toBe("alert");
    expect($("[data-stripe-message]").hidden).toBe(false);
    expect($("[data-review-panel]").hidden).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(client.checkout.createPayment).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(reviewButton());

    await click(reviewButton());
    expect(client.checkout.updatePayment).toHaveBeenCalledTimes(2);
    expect(client.checkout.updatePayment).toHaveBeenLastCalledWith(
      { paymentId: PAYMENT_ID, card: { brand: "VISA" } },
      expect.anything(),
    );
    expect($("[data-stripe-message]").hidden).toBe(true);
    expect($("[data-review-panel]").hidden).toBe(false);
  });

  it("[OFE-012] a PaymentIntent that Stripe reports as confirmed already goes to the complete page", async () => {
    const fake = fakeApi();
    const stripe = fakeStripe({
      order: fake.order,
      confirmPayment: () => ({
        error: {
          type: "invalid_request_error",
          code: "payment_intent_unexpected_state",
          payment_intent: { status: "requires_capture" },
        },
      }),
    });
    const { navigate } = await openPayCard({ fake, stripe });
    await click(reviewButton());
    await click(payButton());

    expect(navigate).toHaveBeenCalledWith(complete());
  });

  it("[OFE-012] a change in the card form drops the reviewed total: Pay needs a new review", async () => {
    const { stripe } = await openPayCard();
    await click(reviewButton());
    expect($("[data-review-panel]").hidden).toBe(false);

    stripe.element.emit("change", { elementType: "payment", complete: true, empty: false });

    expect($("[data-review-panel]").hidden).toBe(true);
    await click(payButton());
    expect(stripe.stripe.confirmPayment).not.toHaveBeenCalled();
  });

  it("[OFE-012] a form Stripe finds incomplete stays in Stripe's element: no token and no fee quote", async () => {
    const fake = fakeApi();
    const stripe = fakeStripe({
      order: fake.order,
      submit: () => ({ error: { type: "validation_error", message: "Your card number is incomplete." } }),
    });
    const { client } = await openPayCard({ fake, stripe });

    await click(reviewButton());

    expect(fake.order).toEqual(["submit"]);
    expect(stripe.stripe.createConfirmationToken).not.toHaveBeenCalled();
    expect(client.checkout.updatePayment).not.toHaveBeenCalled();
    expect($("[data-review-panel]").hidden).toBe(true);
    // Stripe shows its own message inside the element.
    expect($("[data-stripe-message]").hidden).toBe(true);
  });

  it("[OFE-012] a card brand the OTA does not accept is refused before any fee quote", async () => {
    const fake = fakeApi();
    const { client } = await openPayCard({ fake, stripe: fakeStripe({ order: fake.order, brand: "amex" }) });

    await click(reviewButton());

    expect(client.checkout.updatePayment).not.toHaveBeenCalled();
    expect(text($("[data-stripe-message]"))).toBe(
      "We cannot take this card. Pay with one of these cards: Visa, Mastercard.",
    );
    expect($("[data-review-panel]").hidden).toBe(true);
  });

  it("[OFE-012] the summary's card fee follows the payment: a card without a fee shows none", async () => {
    // A traveller reviewed a Visa (with its fee) before reloading the page; now a Mastercard without a fee is reviewed.
    const reviewed = { cardHint: { brand: "VISA" }, cardFee: eur("8.25"), amount: eur("420.55") };
    const fake = fakeApi({
      payment: payment(reviewed),
      checkout: checkout({
        totals: {
          currency: "EUR",
          offer: eur("412.30"),
          ancillaries: eur("0.00"),
          cardFee: eur("8.25"),
          total: eur("420.55"),
        },
      }),
      updatePayment: async (/** @type {{ card: object }} */ { card }) =>
        payment({ cardHint: card, cardFee: null, amount: eur("412.30") }),
    });
    await openPayCard({ fake, stripe: fakeStripe({ order: fake.order, brand: "mastercard" }) });
    expect(text($("[data-total-card-fee]"))).toBe(money("8.25"));
    expect(text($("[data-total]"))).toBe(money("420.55"));

    await click(reviewButton());

    expect(text($("[data-review-card-fee]"))).toBe("No card fee");
    expect(text($("[data-review-total]"))).toBe(money("412.30"));
    expect($("[data-total-card-fee-row]").hidden).toBe(true);
    expect(text($("[data-total-card-fee]"))).toBe("");
    expect(text($("[data-total]"))).toBe(money("412.30"));
  });

  it("[OFE-012] maps Stripe's brands to the accepted Amadeus brands", () => {
    const brands = CONFIG.payment.pspCardBrands;
    expect(acceptedBrand(brands, "mastercard")).toEqual({ amadeus: "MASTERCARD", label: "Mastercard" });
    expect(acceptedBrand(brands, "Visa")).toEqual({ amadeus: "VISA", label: "Visa" });
    expect(acceptedBrand(brands, "amex")).toBeNull();
    expect(acceptedBrand(brands, undefined)).toBeNull();
    expect(acceptedBrand(null, "visa")).toBeNull();
  });
});

describe("card payment page: states", () => {
  it("[OFE-012] 409 PAYMENT_NOT_UPDATABLE creates a new payment and mounts the element again", async () => {
    let first = true;
    const fake = fakeApi({
      updatePayment: async (/** @type {{ paymentId: string, card: object }} */ { paymentId, card }) => {
        if (first) {
          first = false;
          throw apiError(ConflictError, "PAYMENT_NOT_UPDATABLE", 409, {
            details: { status: "requires_action" },
          });
        }
        return payment({ id: paymentId, clientSecret: NEW_CLIENT_SECRET, cardHint: card, cardFee: null });
      },
    });
    const { client, stripe } = await openPayCard({ fake });
    const firstElement = stripe.element;

    await click(reviewButton());

    expect(client.checkout.createPayment).toHaveBeenCalledWith({
      checkoutId: CHECKOUT_ID,
      method: "card",
      termsAccepted: true,
      returnUrl: `${location.origin}/checkout/complete.html?id=${CHECKOUT_ID}`,
    });
    expect(firstElement.destroy).toHaveBeenCalled();
    expect(stripe.instances).toHaveLength(2);
    expect(stripe.elements.options.clientSecret).toBe(NEW_CLIENT_SECRET);
    expect(stripe.element.mounted).toBe($("[data-payment-element]"));
    // One Stripe instance for the same key and account.
    expect(stripe.Stripe).toHaveBeenCalledTimes(1);
    expect(location.search).toBe(`?id=${CHECKOUT_ID}&payment=${NEW_PAYMENT_ID}`);
    expect(text($("[data-pay-notice]"))).toContain("We started the payment again.");
    expect($("[data-review-panel]").hidden).toBe(true);

    await click(reviewButton());
    expect(client.checkout.updatePayment).toHaveBeenLastCalledWith(
      { paymentId: NEW_PAYMENT_ID, card: { brand: "VISA" } },
      expect.anything(),
    );
    expect(text($("[data-review-card-fee]"))).toBe("No card fee");
    await click(payButton());
    expect(stripe.stripe.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: NEW_CLIENT_SECRET,
        confirmParams: expect.objectContaining({
          return_url: `${location.origin}${complete(NEW_PAYMENT_ID)}`,
        }),
      }),
    );
  });

  it("[OFE-012] 409 PRICE_CHANGED on updatePayment shows the new total and asks again with a new payment", async () => {
    const fake = fakeApi({
      updatePayment: async () => {
        fake.api.checkout = checkout({
          totals: {
            currency: "EUR",
            offer: eur("455.10"),
            ancillaries: eur("0.00"),
            cardFee: null,
            total: eur("455.10"),
          },
        });
        throw apiError(PriceChangedError, "PRICE_CHANGED", 409, {
          details: {
            oldPrice: eur("412.30"),
            newPrice: eur("455.10"),
            pricedOfferId: "prc_01JPAYCARDPRICED0002",
          },
        });
      },
      createPayment: async () =>
        payment({ id: NEW_PAYMENT_ID, clientSecret: NEW_CLIENT_SECRET, amount: eur("455.10") }),
    });
    const { client, stripe } = await openPayCard({ fake });

    await click(reviewButton());

    expect($("[data-price-change]").hidden).toBe(false);
    expect(text($("[data-price-change-text]"))).toBe(
      `The new total is ${money("455.10")} (before: ${money("412.30")}). Review it, then pay.`,
    );
    expect(document.activeElement).toBe($("#price-change-title"));
    expect(client.checkout.createPayment).toHaveBeenCalledTimes(1);
    expect(client.checkout.get).toHaveBeenCalledTimes(2);
    expect(text($("[data-total]"))).toBe(money("455.10"));
    expect(stripe.elements.options.clientSecret).toBe(NEW_CLIENT_SECRET);
    // Pay asks for a new review on the new payment.
    expect($("[data-review-panel]").hidden).toBe(true);
    await click(payButton());
    expect(stripe.stripe.confirmPayment).not.toHaveBeenCalled();
  });

  it("[OFE-012] 502 PAYMENT_PROVIDER_ERROR offers Retry, which reviews the card again", async () => {
    let first = true;
    const fake = fakeApi({
      updatePayment: async (/** @type {{ card: object }} */ { card }) => {
        if (first) {
          first = false;
          throw apiError(SupplierError, "PAYMENT_PROVIDER_ERROR", 502);
        }
        return payment({ cardHint: card, cardFee: eur("8.25"), amount: eur("420.55") });
      },
    });
    const { client } = await openPayCard({ fake });

    await click(reviewButton());

    expect(text($('[data-pay-notice] [data-field="title"]'))).toBe(
      "The payment service is not answering. Nothing was charged. Please try again.",
    );
    expect($("[data-review-panel]").hidden).toBe(true);
    expect(client.checkout.createPayment).not.toHaveBeenCalled();

    await click($('[data-pay-notice] [data-action="retry"]'));
    expect(client.checkout.updatePayment).toHaveBeenCalledTimes(2);
    expect($("[data-review-panel]").hidden).toBe(false);
    expect(text($("[data-review-total]"))).toBe(money("420.55"));
  });

  it("[OFE-012] a card form that cannot show the new amount offers Retry before Pay", async () => {
    let first = true;
    const fake = fakeApi();
    const stripe = fakeStripe({
      order: fake.order,
      fetchUpdates: () => {
        const answer = first ? { error: { type: "api_connection_error" } } : {};
        first = false;
        return answer;
      },
    });
    await openPayCard({ fake, stripe });

    await click(reviewButton());
    expect(text($('[data-pay-notice] [data-field="title"]'))).toBe(
      "The card form could not show the new total. Please try again.",
    );
    expect($("[data-review-panel]").hidden).toBe(true);

    await click($('[data-pay-notice] [data-action="retry"]'));
    expect($("[data-review-panel]").hidden).toBe(false);
  });

  it("[OFE-012] a new payment that cannot be created offers Retry and the way back to the payment step", async () => {
    let first = true;
    const fake = fakeApi({
      updatePayment: async () => {
        throw apiError(ConflictError, "PAYMENT_NOT_UPDATABLE", 409, {
          details: { status: "requires_action" },
        });
      },
      createPayment: async () => {
        if (first) {
          first = false;
          throw apiError(SupplierError, "PAYMENT_PROVIDER_ERROR", 502);
        }
        return payment({ id: NEW_PAYMENT_ID, clientSecret: NEW_CLIENT_SECRET });
      },
    });
    const { client, stripe } = await openPayCard({ fake });

    await click(reviewButton());

    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("We could not start the payment again");
    expect($("[data-pay-state] a[data-state-link]").getAttribute("href")).toBe(
      `/checkout.html?id=${CHECKOUT_ID}&step=payment`,
    );
    expect($("[data-pay-content]").hidden).toBe(true);

    await click($('[data-pay-state] [data-action="retry"]'));
    expect(client.checkout.createPayment).toHaveBeenCalledTimes(2);
    expect($("[data-pay-state]").children).toHaveLength(0);
    expect($("[data-pay-content]").hidden).toBe(false);
    expect(stripe.elements.options.clientSecret).toBe(NEW_CLIENT_SECRET);
    expect(reviewButton().hidden).toBe(false);
  });

  it("[OFE-012] a checkout completed meanwhile opens its confirmation", async () => {
    const withBooking = await openPayCard({
      fake: fakeApi({
        updatePayment: async () => {
          throw apiError(ConflictError, "CHECKOUT_ALREADY_COMPLETED", 409, {
            details: { bookingId: BOOKING_ID },
          });
        },
      }),
    });
    await click(reviewButton());
    expect(withBooking.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
    for (const view of views.splice(0)) {
      view.destroy();
    }

    // Without the booking in the answer, the checkout names it.
    const fake = fakeApi({
      updatePayment: async () => {
        fake.api.checkout = checkout({ status: "completed", bookingId: BOOKING_ID });
        throw apiError(ConflictError, "CHECKOUT_ALREADY_COMPLETED", 409);
      },
    });
    const { replace } = await openPayCard({ fake });
    await click(reviewButton());
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
    for (const view of views.splice(0)) {
      view.destroy();
    }

    // Being completed: the confirmation page in pending mode.
    const pending = await openPayCard({
      fake: fakeApi({
        updatePayment: async () => {
          throw apiError(ConflictError, "CHECKOUT_BEING_COMPLETED", 409, {
            details: { bookingId: BOOKING_ID },
          });
        },
      }),
    });
    await click(reviewButton());
    expect(pending.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);
    expect(pending.stripe.stripe.confirmPayment).not.toHaveBeenCalled();
  });

  it("[OFE-012] a request the API refuses as invalid shows the unexpected state, not a field message", async () => {
    const fake = fakeApi({
      updatePayment: async () => {
        throw apiError(ValidationError, "VALIDATION_FAILED", 400, {
          fieldErrors: [{ path: "/card/brand", code: "enum", message: "must be one of the brands" }],
        });
      },
    });
    await openPayCard({ fake });

    await click(reviewButton());

    // The page has no field of its own to mark: the traveller gets the generic state with the request id.
    expect(text($('[data-pay-notice] [data-field="title"]'))).toBe("Something went wrong. Please try again.");
    expect(text($("[data-pay-notice]"))).toContain("req_paycard");
    expect($('[data-pay-notice] [data-action="retry"]')).toBeNull();
    expect($("[data-review-panel]").hidden).toBe(true);
  });

  it("[OFE-012] 410 CHECKOUT_EXPIRED on updatePayment says the session expired", async () => {
    const fake = fakeApi({
      updatePayment: async () => {
        throw apiError(ExpiredError, "CHECKOUT_EXPIRED", 410);
      },
    });
    const { stripe } = await openPayCard({ fake });

    await click(reviewButton());

    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("Your session expired");
    expect($("[data-pay-state] a[data-state-link]").getAttribute("href")).toBe(
      `/price.html?priced=${BASE_ID}`,
    );
    expect($("[data-pay-content]").hidden).toBe(true);
    expect(stripe.element.destroy).toHaveBeenCalled();
  });

  it("[OFE-012] Stripe.js failed to load: 'Card payment is unavailable', with the airline card when offered", async () => {
    const withAirline = await openPayCard({ stripe: null, config: AIRLINE_CONFIG });

    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("Card payment is unavailable");
    expect(text($('[data-pay-state] [data-field="hint"]'))).toBe(
      "Nothing was charged. Please try again in a moment.",
    );
    const link = $("[data-pay-state] a[data-state-link]");
    expect(text(link)).toBe("Pay with the airline card instead");
    expect(link.getAttribute("href")).toBe(`/checkout.html?id=${CHECKOUT_ID}&step=payment`);
    // No checkout or payment call without Stripe.js; Retry loads the page (and its script tag) again.
    expect(withAirline.client.checkout.getPayment).not.toHaveBeenCalled();
    expect(withAirline.client.checkout.get).not.toHaveBeenCalled();
    await click($('[data-pay-state] [data-action="retry"]'));
    expect(withAirline.reload).toHaveBeenCalledTimes(1);
    for (const view of views.splice(0)) {
      view.destroy();
    }

    await openPayCard({ stripe: null });
    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("Card payment is unavailable");
    expect($("[data-pay-state] a[data-state-link]")).toBeNull();
  });

  it("[OFE-012] an element Stripe cannot load shows the same state", async () => {
    const { stripe } = await openPayCard({ config: AIRLINE_CONFIG });

    stripe.element.emit("loaderror", { elementType: "payment", error: { type: "invalid_request_error" } });

    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("Card payment is unavailable");
    expect(text($("[data-pay-state] a[data-state-link]"))).toBe("Pay with the airline card instead");
    expect($("[data-pay-content]").hidden).toBe(true);
    expect(stripe.element.destroy).toHaveBeenCalled();
  });

  it("[OFE-012] a payment that failed or was cancelled is replaced by a new one at load", async () => {
    for (const status of ["failed", "cancelled"]) {
      const fake = fakeApi({ payment: payment({ status, clientSecret: null }) });
      const { client, stripe } = await openPayCard({ fake });

      expect(client.checkout.createPayment, status).toHaveBeenCalledTimes(1);
      expect(stripe.elements.options.clientSecret, status).toBe(NEW_CLIENT_SECRET);
      expect(location.search, status).toBe(`?id=${CHECKOUT_ID}&payment=${NEW_PAYMENT_ID}`);
      for (const view of views.splice(0)) {
        view.destroy();
      }
    }
  });

  it("[OFE-012] opens the page a payment or a checkout belongs on", async () => {
    const cases = /** @type {Array<[string, object, object, string]>} */ ([
      ["authorised", payment({ status: "authorized", clientSecret: null }), checkout(), complete()],
      ["processing", payment({ status: "processing", clientSecret: null }), checkout(), complete()],
      [
        "completed",
        payment({ status: "captured", clientSecret: null }),
        checkout({ status: "completed", bookingId: BOOKING_ID }),
        `/confirmation.html?booking=${BOOKING_ID}`,
      ],
      [
        "airline card",
        payment({ method: "airline_card", provider: "airline", clientSecret: null }),
        checkout(),
        `/checkout/pay-airline.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
      ],
    ]);
    for (const [name, paid, stored, target] of cases) {
      const { replace, stripe } = await openPayCard({ fake: fakeApi({ payment: paid, checkout: stored }) });
      expect(replace, name).toHaveBeenCalledWith(target);
      expect(stripe.stripe.elements, name).not.toHaveBeenCalled();
      for (const view of views.splice(0)) {
        view.destroy();
      }
    }
  });

  it("[OFE-012] an expired checkout says so, with a link to price the flight again", async () => {
    const { stripe } = await openPayCard({ fake: fakeApi({ checkout: checkout({ status: "expired" }) }) });

    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("Your session expired");
    expect(text($("[data-pay-state] a[data-state-link]"))).toBe("Price this flight again");
    expect(stripe.stripe.elements).not.toHaveBeenCalled();
  });

  it("[OFE-012] an address without valid ids, or a payment of another checkout, is not found", async () => {
    const bad = await openPayCard({ query: `id=${CHECKOUT_ID}&payment=pay_x` });
    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("We could not find this payment");
    expect(bad.client.checkout.getPayment).not.toHaveBeenCalled();
    expect(bad.stripe.Stripe).not.toHaveBeenCalled();
    for (const view of views.splice(0)) {
      view.destroy();
    }

    await openPayCard({
      fake: fakeApi({ payment: payment({ checkoutId: "chk_01JPAYCARDOTHERCHK01" }) }),
    });
    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("We could not find this payment");
    expect($("[data-pay-state] a[data-state-link]").getAttribute("href")).toBe(
      `/checkout.html?id=${CHECKOUT_ID}&step=payment`,
    );
    for (const view of views.splice(0)) {
      view.destroy();
    }

    await openPayCard({
      fake: fakeApi({
        getPayment: async () => {
          throw apiError(NotFoundError, "NOT_FOUND", 404);
        },
      }),
    });
    expect(text($('[data-pay-state] [data-field="title"]'))).toBe("We could not find this payment");
  });

  it("[OFE-012] a payment that cannot be loaded offers Retry", async () => {
    let first = true;
    const fake = fakeApi({
      getPayment: async () => {
        if (first) {
          first = false;
          throw apiError(ConnectionError, "NETWORK_ERROR", 0);
        }
        return payment();
      },
    });
    const { stripe } = await openPayCard({ fake });
    expect($("[data-pay-content]").hidden).toBe(true);
    expect(stripe.stripe.elements).not.toHaveBeenCalled();

    await click($('[data-pay-state] [data-action="retry"]'));
    expect($("[data-pay-content]").hidden).toBe(false);
    expect(stripe.element.mounted).toBe($("[data-payment-element]"));
  });

  it("[OFE-012] a card brand refused by the API (422) asks for another card", async () => {
    const fake = fakeApi({
      updatePayment: async () => {
        throw apiError(ValidationError, "UNPROCESSABLE", 422);
      },
    });
    await openPayCard({ fake });

    await click(reviewButton());

    expect(text($("[data-stripe-message]"))).toBe(
      "We cannot take this card. Pay with one of these cards: Visa, Mastercard.",
    );
    expect($("[data-review-panel]").hidden).toBe(true);
  });

  it("[OFE-012] offers the airline card only when the OTA has it", () => {
    expect(airlineCardOffered(CONFIG.payment)).toBe(false);
    expect(airlineCardOffered(AIRLINE_CONFIG.payment)).toBe(true);
    expect(
      airlineCardOffered({
        ...AIRLINE_CONFIG.payment,
        airlineCard: { ...AIRLINE_CONFIG.payment.airlineCard, enabled: false },
      }),
    ).toBe(false);
    expect(airlineCardOffered(undefined)).toBe(false);
  });
});

describe("card payment page: no card data outside Stripe's iframe", () => {
  it("[OFE-012 AC2] the page has no input element of its own: card data stays in Stripe's iframe", async () => {
    // The page itself: no form control and no form, so nothing the traveller types can reach this page's code.
    expect(pageHtml).not.toMatch(/<(?:input|select|textarea|form)\b/i);
    expect(pageHtml).not.toMatch(/autocomplete="[^"]*cc-/);

    // Through the whole flow (with the header's currency selector, which this page removes), the document never
    // holds a form control: what Stripe's element shows is in its iframe.
    const { stripe, navigate } = await openPayCard({
      before: () => {
        const item = document.createElement("li");
        item.dataset.slot = "currency";
        item.append(document.createElement("select"));
        $("body > header nav ul").append(item);
      },
    });
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
    await click(reviewButton());
    await click(payButton());
    expect(navigate).toHaveBeenCalledWith(complete());
    expect(document.querySelectorAll("input, select, textarea, form")).toHaveLength(0);
    expect(Array.from($("[data-payment-element]").children, (child) => child.tagName)).toEqual(["IFRAME"]);
    expect(stripe.stripe.confirmPayment).toHaveBeenCalledTimes(1);

    // The module never reads a value or makes a form control: the card fee comes from Stripe's confirmation token.
    const source = readFileSync(join(STOREFRONT_ROOT, "src/pages/checkout-pay-card.js"), "utf8");
    expect(source).not.toMatch(/\.value\b/);
    expect(source).not.toMatch(/createElement\(\s*["'`](?:input|select|textarea|form)["'`]/);
    expect(source).not.toMatch(/\bFormData\b/);
  });
});

describe("card payment page: the production build", () => {
  /** @type {string | undefined} */
  let dist;

  beforeAll(async () => {
    dist = scratchDir("pay-card");
    await buildStorefront(dist);
  }, 60_000); // a full `vite build` of every page (about 2 s alone, longer under the parallel pnpm test)

  afterAll(() => {
    removeScratch(dist);
  });

  it("[OFE-012 AC1] the built checkout/pay-card.html references exactly two scripts: its own bundle and Stripe.js", () => {
    const out = /** @type {string} */ (dist);
    const html = readFileSync(join(out, PAGE), "utf8");

    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toBe(`<script src="${STRIPE_JS_URL}" defer>`);
    expect(scripts[1]).toMatch(
      /^<script type="module" crossorigin src="\/assets\/checkout-pay-card-[\w-]{8}\.js">$/,
    );
    // Stripe.js is a static tag from js.stripe.com, never bundled: no other external script, and the deferred tag runs
    // before the page module.
    expect([...html.matchAll(/\bsrc="([^"]+)"/g)].map((match) => match[1])).toEqual([
      STRIPE_JS_URL,
      expect.stringMatching(/^\/assets\/checkout-pay-card-[\w-]{8}\.js$/),
    ]);
    // Module preloads are the chunks the page's own bundle imports, nothing else.
    const bundle = /** @type {string} */ (scripts[1]?.match(/src="\/([^"]+)"/)?.[1]);
    const imports = [...readFileSync(join(out, bundle), "utf8").matchAll(/\bfrom\s*"\.\/([^"]+\.js)"/g)].map(
      (match) => `/assets/${match[1]}`,
    );
    const preloads = [...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*>/gi)].map(
      (match) => match[0].match(/href="([^"]+)"/)?.[1],
    );
    expect(preloads.length).toBeGreaterThan(0);
    expect(new Set(preloads)).toEqual(new Set(imports));
    // No form control on the built page either.
    expect(html).not.toMatch(/<(?:input|select|textarea|form)\b/i);
  });

  it("[OFE-012 AC1] no other page of the build loads Stripe.js or any other third-party script", () => {
    const out = /** @type {string} */ (dist);
    const pages = filesIn(out).filter((file) => file.endsWith(".html"));
    expect(pages).toContain(PAGE);
    expect(pages.filter((file) => readFileSync(join(out, file), "utf8").includes("js.stripe.com"))).toEqual([
      PAGE,
    ]);
    // Every script and module preload of the other pages is a first-party file of the build.
    for (const file of pages.filter((name) => name !== PAGE)) {
      const html = readFileSync(join(out, file), "utf8");
      const sources = [
        ...[...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gi)].map((match) => match[1]),
        ...[...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*>/gi)].map(
          (match) => match[0].match(/href="([^"]*)"/)?.[1],
        ),
      ];
      expect(sources.length, file).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source, file).toMatch(/^\/assets\/[\w-]+\.js$/);
      }
    }
  });
});
