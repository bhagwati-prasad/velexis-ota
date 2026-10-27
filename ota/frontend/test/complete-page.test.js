// The complete page (ota/frontend/docs/pages.md §10, flow ota/docs/flows/checkout-stripe.md §2 steps 5–6 and §3, SDK
// guide B3 §2.7): checkout/complete.html with its partials expanded by the build's include plugin, run by
// src/pages/checkout-complete.js against a fake SDK. It covers the payment read again every 2 s while the bank
// confirms it (fake timers, at most 60 s), `checkout.complete` with the idempotency key derived from the ids and 90 s,
// the same key on a reload and on Retry, the confirmation on success, the states of §10 (pending mode after `504
// SUPPLIER_TIMEOUT` and `409 CHECKOUT_BEING_COMPLETED`, never a new key), Stripe's return parameters taken out of the
// address bar, and a page without Stripe.js or form controls.
import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  ExpiredError,
  NotFoundError,
  PaymentError,
  PriceChangedError,
  RateLimitError,
  ServerError,
  SoldOutError,
  SupplierError,
  ValidationError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { formatMoney } from "../src/lib/format.js";
import { COMPLETE_TIMEOUT_MS, PAYMENT_POLL_MS, completeKey, start } from "../src/pages/checkout-complete.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/**
 * The mocked boot() of the page module records the address it was called at and never resolves, so the tests start
 * the page themselves.
 */
const bootMock = vi.hoisted(() => ({ /** @type {string[]} */ addresses: [] }));
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    boot: () => {
      bootMock.addresses.push(`${location.pathname}${location.search}`);
      return new Promise(() => {});
    },
  };
});

const CHECKOUT_ID = "chk_01JCOMPLETECHECKOUT1";
const OTHER_CHECKOUT_ID = "chk_01JCOMPLETECHECKOUT2";
const PAYMENT_ID = "pay_01JCOMPLETEPAYMENT01";
const BOOKING_ID = "bkg_01JCOMPLETEBOOKING01";
const PAGE = "checkout/complete.html";
const KEY = `complete-${CHECKOUT_ID}-${PAYMENT_ID}`;

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });
/** @param {string} amount */
const money = (amount) => formatMoney(eur(amount), "en-GB");

const CONFIG = Object.freeze({
  name: "Demo Travel",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { ancillaries: true, guestCheckout: true, customerAccounts: true },
});

/**
 * The card payment, authorised by Stripe.
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
    status: "authorized",
    captureMethod: "manual",
    amount: eur("420.55"),
    cardFee: eur("8.25"),
    clientSecret: null,
    providerPublicKey: "pk_test_fake_storefront_fixture",
    ...overrides,
  };
}

/** The booking `checkout.complete` made. */
const completion = () => ({
  checkoutId: CHECKOUT_ID,
  booking: { id: BOOKING_ID, reference: "VX7K2Q", status: "ticketed" },
  bookingToken: null,
  bookingTokenExpiresAt: null,
});

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_complete", ...body });

/**
 * A fake API: `getPayment` answers the payments of `payments` in turn (the last one again and again), `complete`
 * answers `complete` (a function) or the booking.
 * @param {{ payments?: object[], complete?: Function, checkout?: object | Function }} [options]
 */
function fakeApi({ payments = [payment()], complete, checkout } = {}) {
  let read = 0;
  const client = {
    checkout: {
      getPayment: vi.fn(async () => {
        const answer = payments[Math.min(read, payments.length - 1)];
        read += 1;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      }),
      complete: vi.fn(async (/** @type {unknown} */ params, /** @type {unknown} */ options) =>
        complete ? complete(params, options) : completion(),
      ),
      get: vi.fn(async () =>
        typeof checkout === "function"
          ? checkout()
          : (checkout ?? {
              id: CHECKOUT_ID,
              status: "payment_pending",
              bookingId: null,
              payment: { id: PAYMENT_ID },
            }),
      ),
    },
  };
  return { client };
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
const stateTitle = () => text($('[data-complete-state] [data-field="title"]'));
const stateHint = () => text($('[data-complete-state] [data-field="hint"]'));
const stateLinks = () =>
  Array.from(document.querySelectorAll("[data-complete-state] a[data-state-link]"), (link) => [
    text(link),
    link.getAttribute("href"),
  ]);
const retryButton = () =>
  /** @type {HTMLButtonElement | null} */ ($('[data-complete-state] [data-action="retry"]'));

/**
 * Starts the complete page at `/checkout/complete.html?<query>` with a fake SDK. `wait: false` returns before the
 * page settled (for fake timers).
 * @param {{ query?: string, fake?: ReturnType<typeof fakeApi>, wait?: boolean }} [options]
 */
async function openComplete({
  query = `id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
  fake = fakeApi(),
  wait = true,
} = {}) {
  showPage(`/checkout/complete.html?${query}`);
  const replace = vi.fn();
  const view = start(
    { config: /** @type {never} */ (CONFIG), client: /** @type {never} */ (fake.client), session: null },
    { replace },
  );
  if (!view) {
    throw new Error("the complete page did not start");
  }
  views.push(view);
  if (wait) {
    await view.done;
    await settle();
  }
  return { view, ...fake, replace };
}

/** The `checkout.complete` call the page makes for the payment. */
const completeCall = (/** @type {string} */ amount = "420.55") => [
  { checkoutId: CHECKOUT_ID, paymentId: PAYMENT_ID, expectedTotal: eur(amount) },
  { idempotencyKey: KEY, timeoutMs: 90_000, signal: expect.any(AbortSignal) },
];

describe("complete page: completing the checkout", () => {
  it("[OFE-013] completes an authorised payment with the key of its ids and 90 s, then opens the confirmation", async () => {
    const { client, replace } = await openComplete();

    expect(client.checkout.getPayment).toHaveBeenCalledWith(
      { paymentId: PAYMENT_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.checkout.complete.mock.calls).toEqual([completeCall()]);
    expect(completeKey(CHECKOUT_ID, PAYMENT_ID)).toBe(KEY);
    expect(COMPLETE_TIMEOUT_MS).toBe(90_000);
    // location.replace: Back does not lead to the complete page again.
    expect(replace.mock.calls).toEqual([[`/confirmation.html?booking=${BOOKING_ID}`]]);
    expect($("[data-complete-state]").children).toHaveLength(0);
  });

  it("[OFE-013 AC1] reloading the page replays the same idempotency key", async () => {
    // The first attempt loses its answer (the network drops); the traveller reloads the page.
    let attempt = 0;
    const fake = fakeApi({
      complete: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw apiError(ConnectionError, "NETWORK_ERROR", 0);
        }
        return completion();
      },
    });
    const first = await openComplete({ fake });
    expect(first.replace).not.toHaveBeenCalled();
    first.view.destroy();

    const reloaded = await openComplete({ fake });

    const keys = fake.client.checkout.complete.mock.calls.map(
      (call) => /** @type {{ idempotencyKey: string }} */ (call[1]).idempotencyKey,
    );
    expect(keys).toEqual([KEY, KEY]);
    expect(fake.client.checkout.complete.mock.calls).toEqual([completeCall(), completeCall()]);
    expect(reloaded.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] Retry after a transient failure sends the same key again", async () => {
    let attempt = 0;
    const fake = fakeApi({
      complete: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw apiError(ServerError, "SERVICE_UNAVAILABLE", 503);
        }
        if (attempt === 2) {
          throw apiError(SupplierError, "PAYMENT_PROVIDER_ERROR", 502);
        }
        return completion();
      },
    });
    const { client, replace } = await openComplete({ fake });

    expect(stateTitle()).toBe(
      "The service is not available right now. Nothing is lost: try again in a moment.",
    );
    expect($("[data-complete-progress]").hidden).toBe(true);
    retryButton()?.click();
    await settle();
    expect(stateTitle()).toBe("The payment service is not answering. Nothing was charged. Please try again.");
    expect(retryButton()).not.toBeNull();
    retryButton()?.click();
    await settle();

    expect(client.checkout.complete.mock.calls).toEqual([completeCall(), completeCall(), completeCall()]);
    // The payment is read once: Retry repeats the completion only.
    expect(client.checkout.getPayment).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] a request still running for the same key offers Retry with that key", async () => {
    let attempt = 0;
    const fake = fakeApi({
      complete: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw apiError(ConflictError, "CONFLICT", 409);
        }
        return completion();
      },
    });
    const { client, replace } = await openComplete({ fake });

    expect(stateTitle()).toBe("Your booking is still being completed");
    retryButton()?.click();
    await settle();
    expect(client.checkout.complete.mock.calls).toEqual([completeCall(), completeCall()]);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] completes a captured payment too", async () => {
    const { client, replace } = await openComplete({
      fake: fakeApi({ payments: [payment({ status: "captured" })] }),
    });
    expect(client.checkout.complete).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] takes Stripe's return parameters out of the address bar", async () => {
    const replaceState = vi.spyOn(history, "replaceState");
    await openComplete({
      query: `id=${CHECKOUT_ID}&payment=${PAYMENT_ID}&payment_intent=pi_fake_return&payment_intent_client_secret=pi_fake_return_secret_fixture&redirect_status=succeeded`,
    });

    expect(replaceState).toHaveBeenCalled();
    expect(`${location.pathname}${location.search}`).toBe(
      `/checkout/complete.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
    );
  });

  it("[OFE-013] the page module takes Stripe's return parameters out before boot() runs", async () => {
    // Loaded afresh, as the browser does after Stripe's redirect: boot()'s requests must not carry the client secret
    // in their Referer, and a page boot() replaces with a full-page state must not keep it in the address.
    showPage(
      `/checkout/complete.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}&payment_intent=pi_fake_return&payment_intent_client_secret=pi_fake_return_secret_fixture&redirect_status=succeeded`,
    );
    bootMock.addresses.length = 0;
    vi.resetModules();
    await import("../src/pages/checkout-complete.js");

    expect(bootMock.addresses).toEqual([`/checkout/complete.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`]);
    expect(location.href).not.toContain("secret");
  });

  it("[OFE-013] an address without payment= completes the checkout's active payment", async () => {
    const { client, replace } = await openComplete({ query: `id=${CHECKOUT_ID}` });

    expect(client.checkout.get).toHaveBeenCalledWith(
      { checkoutId: CHECKOUT_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(`${location.pathname}${location.search}`).toBe(
      `/checkout/complete.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
    );
    expect(client.checkout.complete.mock.calls).toEqual([completeCall()]);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });
});

describe("complete page: waiting for the bank", () => {
  it("[OFE-013] reads the payment again every 2 s while it is processing or needs 3-D Secure, then completes", async () => {
    vi.useFakeTimers();
    const fake = fakeApi({
      payments: [
        payment({ status: "processing" }),
        payment({ status: "requires_action" }),
        payment({ status: "authorized" }),
      ],
    });
    const { client, replace } = await openComplete({ fake, wait: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(client.checkout.getPayment).toHaveBeenCalledTimes(1);
    expect(text($("[data-complete-step]"))).toBe("Waiting for your bank to confirm the payment…");
    expect(client.checkout.complete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAYMENT_POLL_MS - 1);
    expect(client.checkout.getPayment).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.checkout.getPayment).toHaveBeenCalledTimes(2);
    expect(client.checkout.complete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAYMENT_POLL_MS);
    expect(client.checkout.getPayment).toHaveBeenCalledTimes(3);
    expect(client.checkout.complete.mock.calls).toEqual([completeCall()]);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] stops waiting after 60 s: the payment is not confirmed yet, with Retry and the card page", async () => {
    vi.useFakeTimers();
    const fake = fakeApi({ payments: [payment({ status: "processing" })] });
    const { client, replace } = await openComplete({ fake, wait: false });

    await vi.advanceTimersByTimeAsync(60_000);
    const reads = client.checkout.getPayment.mock.calls.length;
    // One read at once, then one every 2 s for a minute, and none after it.
    expect(reads).toBe(31);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.checkout.getPayment).toHaveBeenCalledTimes(reads);

    expect(stateTitle()).toBe("Your bank has not confirmed the payment yet");
    expect($("[data-complete-state] > [data-state]").dataset["state"]).toBe("payment-not-confirmed");
    expect(stateLinks()).toEqual([
      ["Back to the card payment", `/checkout/pay-card.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`],
    ]);
    expect(client.checkout.complete).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    // Retry waits for the bank again.
    fake.client.checkout.getPayment.mockResolvedValue(payment({ status: "authorized" }));
    retryButton()?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.checkout.complete).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] a payment that failed, was cancelled or still needs a card did not go through: back to the card page", async () => {
    for (const status of ["failed", "cancelled", "requires_payment_method"]) {
      const { client, replace, view } = await openComplete({
        fake: fakeApi({ payments: [payment({ status })] }),
      });

      expect(stateTitle(), status).toBe("Payment did not go through");
      expect(stateHint(), status).toBe(
        "Nothing was booked and your card was not charged. Try again with the same card or another one.",
      );
      expect(stateLinks(), status).toEqual([
        ["Back to the card payment", `/checkout/pay-card.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`],
      ]);
      // A link, never an automatic redirect: a payment the API refuses cannot bounce between the two pages.
      expect(replace, status).not.toHaveBeenCalled();
      expect(client.checkout.complete, status).not.toHaveBeenCalled();
      expect(document.activeElement, status).toBe($('[data-complete-state] [data-field="title"]'));
      view.destroy();
    }
  });

  it("[OFE-013] an airline-card payment belongs on its own page", async () => {
    const { client, replace } = await openComplete({
      fake: fakeApi({ payments: [payment({ method: "airline_card", provider: "airline" })] }),
    });
    expect(replace).toHaveBeenCalledWith(
      `/checkout/pay-airline.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`,
    );
    expect(client.checkout.complete).not.toHaveBeenCalled();
  });
});

describe("complete page: states", () => {
  it("[OFE-013] 504 SUPPLIER_TIMEOUT opens the confirmation in pending mode and never completes with a new key", async () => {
    vi.useFakeTimers();
    const fake = fakeApi({
      complete: async () => {
        throw apiError(SupplierError, "SUPPLIER_TIMEOUT", 504, {
          details: { bookingId: BOOKING_ID, bookingToken: null, replayed: false },
        });
      },
    });
    const { client, replace } = await openComplete({ fake, wait: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(replace.mock.calls).toEqual([[`/confirmation.html?booking=${BOOKING_ID}&pending=1`]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.checkout.complete.mock.calls).toEqual([completeCall()]);
  });

  it("[OFE-013] 409 CHECKOUT_BEING_COMPLETED opens the pending confirmation; CHECKOUT_ALREADY_COMPLETED the final one", async () => {
    const being = await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ConflictError, "CHECKOUT_BEING_COMPLETED", 409, {
            details: { bookingId: BOOKING_ID },
          });
        },
      }),
    });
    expect(being.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);
    being.view.destroy();

    const already = await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ConflictError, "CHECKOUT_ALREADY_COMPLETED", 409, {
            details: { bookingId: BOOKING_ID },
          });
        },
      }),
    });
    expect(already.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
    already.view.destroy();

    // Without the booking in the answer, the checkout names it.
    const named = await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ConflictError, "CHECKOUT_ALREADY_COMPLETED", 409);
        },
        checkout: {
          id: CHECKOUT_ID,
          status: "completed",
          bookingId: BOOKING_ID,
          payment: { id: PAYMENT_ID },
        },
      }),
    });
    expect(named.replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] a timeout without a booking id says the booking is being confirmed, and Retry keeps the key", async () => {
    let attempt = 0;
    const fake = fakeApi({
      complete: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw apiError(SupplierError, "SUPPLIER_TIMEOUT", 504);
        }
        throw apiError(SupplierError, "SUPPLIER_TIMEOUT", 504, {
          details: { bookingId: BOOKING_ID, replayed: true },
        });
      },
    });
    const { client, replace } = await openComplete({ fake });

    expect(stateTitle()).toBe("We are confirming your booking with the airline");
    expect(client.checkout.get).toHaveBeenCalledTimes(1);
    retryButton()?.click();
    await settle();
    expect(client.checkout.complete.mock.calls).toEqual([completeCall(), completeCall()]);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);
  });

  it("[OFE-013] 409 PRICE_CHANGED shows the new total and the way back to the payment step", async () => {
    const { replace } = await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(PriceChangedError, "PRICE_CHANGED", 409, {
            details: {
              oldPrice: eur("420.55"),
              newPrice: eur("438.10"),
              pricedOfferId: "prc_01JCOMPLETEPRICED002",
            },
          });
        },
      }),
    });

    expect(stateTitle()).toBe("The airline changed the price");
    expect(text($("[data-complete-state] [data-state-note]"))).toBe(
      `The new total is ${money("438.10")} (before: ${money("420.55")}).`,
    );
    expect(stateHint()).toBe("Your card has not been charged. Check the new total, then pay again.");
    expect(stateLinks()).toEqual([
      ["Back to the payment step", `/checkout.html?id=${CHECKOUT_ID}&step=payment`],
    ]);
    expect(retryButton()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("[OFE-013] 409 SOLD_OUT says nothing was charged and leads back to the search", async () => {
    await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(SoldOutError, "SOLD_OUT", 409);
        },
      }),
    });
    expect(stateTitle()).toBe("This flight just sold out");
    expect(stateHint()).toBe("Nothing was booked and you have not been charged. Choose another flight.");
    expect(stateLinks()).toEqual([["Search flights", "/"]]);
    expect(retryButton()).toBeNull();
  });

  it("[OFE-013] 410 CHECKOUT_EXPIRED says the session expired and the authorisation is released", async () => {
    await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ExpiredError, "CHECKOUT_EXPIRED", 410);
        },
      }),
    });
    expect(stateTitle()).toBe("Your session expired");
    expect(stateHint()).toBe("The amount reserved on your card is released. Search again to book.");
    expect(stateLinks()).toEqual([["Search flights", "/"]]);
  });

  it("[OFE-013] 402 PAYMENT_REQUIRED leads back to the card page", async () => {
    const { replace } = await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(PaymentError, "PAYMENT_REQUIRED", 402);
        },
      }),
    });
    expect(stateTitle()).toBe("Payment did not go through");
    expect(stateLinks()).toEqual([
      ["Back to the card payment", `/checkout/pay-card.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`],
    ]);
    expect(replace).not.toHaveBeenCalled();
  });

  it("[OFE-013] the airline's refusal says the booking did not go through and nothing was charged", async () => {
    await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(SupplierError, "SUPPLIER_ERROR", 502);
        },
      }),
    });
    expect(stateTitle()).toBe("Your booking did not go through");
    expect(stateHint()).toBe("The airline could not confirm it. You have not been charged.");
    expect(stateLinks()).toEqual([
      ["Back to the payment step", `/checkout.html?id=${CHECKOUT_ID}&step=payment`],
      ["Search flights", "/"],
    ]);
    expect(retryButton()).toBeNull();
  });

  it("[OFE-013] missing or refused traveller data leads back to the details", async () => {
    await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ValidationError, "CHECKOUT_INCOMPLETE", 422, {
            fieldErrors: [{ path: "/travelers/0/dateOfBirth", code: "REQUIRED", message: "required" }],
          });
        },
      }),
    });
    expect(stateTitle()).toBe("Some details are still missing");
    expect(stateLinks()).toEqual([
      ["Check your details", `/checkout.html?id=${CHECKOUT_ID}&step=travellers`],
    ]);
  });

  it("[OFE-013] 429 offers Retry after Retry-After; a refused request shows the request id without Retry", async () => {
    vi.useFakeTimers();
    const limited = await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(RateLimitError, "RATE_LIMITED", 429, { details: { retryAfterSeconds: 3 } });
        },
      }),
      wait: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stateTitle()).toBe("Busy, try again in a few seconds");
    expect(retryButton()?.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(retryButton()?.disabled).toBe(false);
    limited.view.destroy();

    const refused = await openComplete({
      fake: fakeApi({
        complete: async () => {
          throw apiError(ValidationError, "VALIDATION_FAILED", 400);
        },
      }),
      wait: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stateTitle()).toBe("Something went wrong. Please try again.");
    expect(text($("[data-complete-state]"))).toContain("req_complete");
    expect(retryButton()).toBeNull();
    expect(refused.client.checkout.complete).toHaveBeenCalledTimes(1);
  });

  it("[OFE-013] an address without valid ids, or a payment of another checkout, is not found", async () => {
    const bad = await openComplete({ query: "id=chk_bad&payment=pay_bad" });
    expect(stateTitle()).toBe("We could not find this payment");
    expect(stateLinks()).toEqual([["Search flights", "/"]]);
    expect(bad.client.checkout.getPayment).not.toHaveBeenCalled();
    bad.view.destroy();

    const other = await openComplete({
      fake: fakeApi({ payments: [payment({ checkoutId: OTHER_CHECKOUT_ID })] }),
    });
    expect(stateTitle()).toBe("We could not find this payment");
    expect(stateLinks()).toEqual([
      ["Back to the payment step", `/checkout.html?id=${CHECKOUT_ID}&step=payment`],
    ]);
    expect(other.client.checkout.complete).not.toHaveBeenCalled();
    other.view.destroy();

    const unknown = await openComplete({
      fake: fakeApi({ payments: [apiError(NotFoundError, "NOT_FOUND", 404)] }),
    });
    expect(stateTitle()).toBe("We could not find this payment");
    expect(unknown.client.checkout.complete).not.toHaveBeenCalled();
  });

  it("[OFE-013] a signed-out customer is asked to sign in and comes back here", async () => {
    await openComplete({
      fake: fakeApi({ payments: [apiError(AuthenticationError, "UNAUTHENTICATED", 401)] }),
    });
    expect(stateTitle()).toBe("Sign in to continue");
    expect(stateLinks()).toEqual([
      [
        "Sign in",
        `/account/sign-in.html?next=${encodeURIComponent(`/checkout/complete.html?id=${CHECKOUT_ID}&payment=${PAYMENT_ID}`)}`,
      ],
    ]);
  });

  it("[OFE-013] a payment that cannot be read offers Retry", async () => {
    const fake = fakeApi({ payments: [apiError(ConnectionError, "NETWORK_ERROR", 0), payment()] });
    const { client, replace } = await openComplete({ fake });

    expect(stateTitle()).toBe(
      "The service is not available right now. Nothing is lost: try again in a moment.",
    );
    expect(client.checkout.complete).not.toHaveBeenCalled();
    retryButton()?.click();
    await settle();
    expect(client.checkout.getPayment).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith(`/confirmation.html?booking=${BOOKING_ID}`);
  });
});

describe("complete page: the page itself", () => {
  it("[OFE-013] has no Stripe.js, no other script and no form control of its own", () => {
    const scripts = [...pageHtml.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(scripts).toEqual(['<script type="module" src="/src/pages/checkout-complete.js">']);
    expect(pageHtml).not.toContain("js.stripe.com");
    expect(pageHtml).not.toMatch(/<(?:input|select|textarea|form)\b/i);
  });

  it("[FIX-W30-OTA AC7] sends only the origin as Referer before its module takes Stripe's return parameters out", () => {
    // Stripe returns here with `payment_intent_client_secret` in the address: the requests the browser makes before
    // the page module runs (its script, the module preloads, the stylesheet) must not carry it in their Referer, as
    // account/verify.html keeps its token out. `strict-origin`, not `no-referrer`: with it the SDK's same-origin
    // writes would send `Origin: null`.
    const children = Array.from(pageDocument.head.children);
    const policies = children.filter((element) => element.matches('meta[name="referrer"]'));
    expect(policies.map((element) => element.getAttribute("content"))).toEqual(["strict-origin"]);
    const firstRequest = children.findIndex((element) => element.matches("link, script, style, base"));
    expect(firstRequest).toBeGreaterThan(-1);
    expect(children.indexOf(/** @type {Element} */ (policies[0]))).toBeLessThan(firstRequest);
  });
});
