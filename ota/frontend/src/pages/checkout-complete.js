// Entry module of the complete page (checkout/complete.html, ota/frontend/docs/pages.md §10, flow
// ota/docs/flows/checkout-stripe.md §2 steps 5–6 and §3, SDK guide B3 §2.7). The card payment page opens it after
// Stripe confirmed the payment, and Stripe returns to it after 3-D Secure (`return_url`):
// `/checkout/complete.html?id=chk_…&payment=pay_…`. It turns the authorised payment into a booking. It has no Stripe.js
// and no form control: it only talks to the API.
//
// 1. `checkout.getPayment({ paymentId })`, again every 2 s while the payment is `processing` or `requires_action` (the
//    bank is still confirming it), for at most 60 s.
// 2. `authorized` or `captured`: `checkout.complete({ checkoutId, paymentId, expectedTotal: payment.amount }, {
//    idempotencyKey: "complete-<checkoutId>-<paymentId>", timeoutMs: 90000 })`. The key is derived from the ids, never
//    generated: a reload, a Retry or the SDK's own retries send the same key, and the API replays the outcome of the
//    first request instead of booking twice (B3 §2.7, OADR-0003).
// 3. Success: `location.replace("/confirmation.html?booking=bkg_…")`, so Back does not lead here again.
//
// States (pages.md §10): a payment that failed, was cancelled or still needs a card says "Payment did not go through"
// with the way back to the card page (never an automatic redirect, so a payment the API refuses cannot bounce between
// the two pages); `402` likewise; `409 PRICE_CHANGED` shows the new total and the way back to the payment step for a
// new payment; `409 SOLD_OUT` and the airline's other refusals say that nothing was charged; `409
// CHECKOUT_ALREADY_COMPLETED` opens the confirmation of `details.bookingId`; `504 SUPPLIER_TIMEOUT` and `409
// CHECKOUT_BEING_COMPLETED` open it in pending mode (`pending=1`): the order may exist, so `complete` is never called
// with a new key; `410 CHECKOUT_EXPIRED` says the session expired and the authorisation is released. Transient
// failures (the service, the airline or the payment service not answering, `429`, a request still running) offer
// Retry, which sends the same key again.
//
// Stripe's return adds `payment_intent`, `payment_intent_client_secret` and `redirect_status` to the address; the page
// module takes them out with `history.replaceState` before boot() runs, so no request of the page carries the client
// secret in its `Referer`, and they stay out of the history and bookmarks even when boot() shows a full-page state.

import { boot, renderState } from "../boot.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatMoney } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { signInHref } from "../lib/session.js";
import { replaceQuery, withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Payment"]} Payment */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {Pick<VelexisClient, "checkout">} PageClient */

/** Ids as the API writes them. */
export const CHECKOUT_ID = /^chk_[0-9A-Za-z]{16,40}$/;
export const PAYMENT_ID = /^pay_[0-9A-Za-z]{16,40}$/;
export const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
/** How often the payment is read again while the bank confirms it (pages.md §10). */
export const PAYMENT_POLL_MS = 2000;
/** How long the page waits for the bank at most before it says the payment is not confirmed yet. */
export const PAYMENT_WAIT_MS = 60_000;
/** The timeout of `checkout.complete`: Flight Create Orders, the capture and the issue can take up to a minute. */
export const COMPLETE_TIMEOUT_MS = 90_000;
/** The query parameters Stripe adds to `return_url`, taken out of the address bar. */
export const STRIPE_RETURN_PARAMS = Object.freeze([
  "payment_intent",
  "payment_intent_client_secret",
  "redirect_status",
]);
/** Payment statuses while the bank still confirms the payment: read it again. */
const WAITING_STATUSES = new Set(["processing", "requires_action"]);
/** Payment statuses of a payment that was not (or can no longer be) confirmed: back to the card page. */
const UNPAID_STATUSES = new Set(["requires_payment_method", "failed", "cancelled"]);
/** Codes of the airline's refusals at order creation: nothing was booked and the authorisation was voided. */
const NOT_BOOKED_CODES = new Set(["SUPPLIER_ERROR", "SUPPLIER_REJECTED", "TICKETING_FAILED"]);
/** Codes that send the traveller back to the checkout's data: the details the airline needs. */
const DATA_CODES = new Set(["CHECKOUT_INCOMPLETE", "TRAVELER_DATA_INVALID", "CONTACT_DATA_INVALID"]);
/** States after which the same call cannot do better: no Retry. */
const FINAL_STATES = new Set([
  "suspended",
  "unknown-host",
  "supplier-not-configured",
  "feature-disabled",
  "forbidden",
  "signed-out",
  "not-found",
  "validation",
  "email-not-verified",
]);

/**
 * Reports an error of the page (the browser's console and `error` event) without breaking it.
 * @param {unknown} error
 */
function report(error) {
  try {
    globalThis.reportError?.(error);
  } catch {
    // Nothing else to do.
  }
}

/**
 * The idempotency key of `checkout.complete` for a checkout and a payment: derived from the ids, so every attempt for
 * this payment (a reload, a Retry, the SDK's retries) replays the first one's outcome (B3 §2.7).
 * @param {string} checkoutId
 * @param {string} paymentId
 */
export const completeKey = (checkoutId, paymentId) => `complete-${checkoutId}-${paymentId}`;

/**
 * Takes Stripe's return parameters (`STRIPE_RETURN_PARAMS`) out of the address bar with `history.replaceState`; the
 * other parameters keep their values and order. The page module runs it before boot(), so no request of the page
 * carries the PaymentIntent's client secret in its `Referer`. Returns whether the address had one.
 * @param {{ location?: Location, history?: History }} [env]
 * @returns {boolean}
 */
export function dropStripeReturnParams(env = {}) {
  const location = env.location ?? globalThis.location;
  const params = new URLSearchParams(location.search);
  if (!STRIPE_RETURN_PARAMS.some((name) => params.has(name))) {
    return false;
  }
  replaceQuery(Object.fromEntries(STRIPE_RETURN_PARAMS.map((name) => [name, null])), {
    location,
    history: env.history ?? globalThis.history,
  });
  return true;
}

/**
 * This page for a checkout and a payment.
 * @param {string} checkoutId
 * @param {string} paymentId
 */
export const completeHref = (checkoutId, paymentId) =>
  withQuery("/checkout/complete.html", { id: checkoutId, payment: paymentId });

/**
 * The confirmation page of a booking (`pending=1` while the airline order is being confirmed).
 * @param {string} bookingId
 * @param {boolean} [pending]
 */
export const confirmationHref = (bookingId, pending = false) =>
  withQuery("/confirmation.html", { booking: bookingId, pending: pending ? 1 : null });

/**
 * The card payment page of a checkout and a payment.
 * @param {string} checkoutId
 * @param {string} paymentId
 */
const payCardHref = (checkoutId, paymentId) =>
  withQuery("/checkout/pay-card.html", { id: checkoutId, payment: paymentId });

/**
 * A step of the checkout page.
 * @param {string} checkoutId
 * @param {string} step
 */
const checkoutHref = (checkoutId, step) => withQuery("/checkout.html", { id: checkoutId, step });

/** @param {unknown} value */
const isMoney = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof (/** @type {{ amount?: unknown }} */ (value).amount) === "string" &&
  typeof (/** @type {{ currency?: unknown }} */ (value).currency) === "string";

/**
 * A booking id from an answer's details, when it is one.
 * @param {PageState} state
 * @returns {string | null}
 */
const bookingIdOf = (state) => {
  const value = state.details?.["bookingId"];
  return typeof value === "string" && BOOKING_ID.test(value) ? value : null;
};

/**
 * Runs the complete page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page
 * has no complete area, else `{ done, destroy }`: `done` settles once the page left for the confirmation or shows a
 * state.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, history?: History, replace?: (url: string) => void }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-complete-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const history = env.history ?? view.history;
  const replace = env.replace ?? ((/** @type {string} */ url) => location.replace(url));
  const { config, client } = context;
  const locale = config?.defaultLocale;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);

  const el = {
    progress: /** @type {HTMLElement} */ (main.querySelector("[data-complete-progress]")),
    step: /** @type {HTMLElement} */ (main.querySelector("[data-complete-step]")),
    state: /** @type {HTMLElement} */ (main.querySelector("[data-complete-state]")),
  };

  const params = new URLSearchParams(location.search);
  const idParam = params.get("id");
  const paymentParam = params.get("payment");
  const checkoutId = idParam !== null && CHECKOUT_ID.test(idParam) ? idParam : null;
  let paymentId = paymentParam !== null && PAYMENT_ID.test(paymentParam) ? paymentParam : null;
  // The page module took them out before boot(); a page started otherwise (tests) takes them out here.
  dropStripeReturnParams({ location, history });

  /** Running calls, aborted by destroy. @type {Set<AbortController>} */
  const controllers = new Set();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {(() => void) | null} */
  let wake = null;
  let destroyed = false;

  /** A new AbortController for a call, forgotten once the call settled. */
  const track = () => {
    const controller = new AbortController();
    controllers.add(controller);
    return { signal: controller.signal, done: () => controllers.delete(controller) };
  };

  /** Waits `ms`; destroy ends the wait at once. */
  const sleep = (/** @type {number} */ ms) =>
    new Promise((resolve) => {
      wake = () => resolve(undefined);
      timer = setTimeout(() => {
        wake = null;
        resolve(undefined);
      }, ms);
    });

  /** @param {unknown} error */
  const requestIdOf = (error) =>
    error instanceof Error && "requestId" in error
      ? String(/** @type {{ requestId: unknown }} */ (error).requestId ?? "") || null
      : null;

  /**
   * Shows what the page is doing in the progress panel and the live region.
   * @param {string} message
   */
  const progress = (message) => {
    el.state.replaceChildren();
    el.progress.hidden = false;
    el.step.textContent = message;
    live.announce(message);
  };

  /**
   * Replaces the progress with a state, its links and (when given) Retry; the focus moves to its title.
   * @param {Pick<PageState, "name" | "message"> & Partial<PageState>} state
   * @param {{ links?: Array<{ label: string, href: string }>, note?: string | null, onRetry?: () => void, requestId?: string | null }} [options]
   */
  const showState = (state, { links = [], note = null, onRetry, requestId = null } = {}) => {
    el.progress.hidden = true;
    doc.title = state.message;
    const element = renderState(
      el.state,
      { ...state, scope: "inline" },
      { support, requestId, focus: true, ...(onRetry ? { onRetry } : {}) },
    );
    const retry = element.querySelector('[data-action="retry"]')?.closest("p") ?? null;
    if (note) {
      const paragraph = doc.createElement("p");
      paragraph.className = "mt-2 font-medium";
      paragraph.dataset.stateNote = "";
      paragraph.textContent = note;
      element.querySelector('[data-field="title"]')?.after(paragraph);
    }
    for (const link of links) {
      const item = fill(clone("tpl-state-link", doc), link);
      if (retry) {
        retry.before(item);
      } else {
        element.append(item);
      }
    }
    live.announce(note ? `${state.message}. ${note}` : state.message);
  };

  /**
   * A state of this page that lib/errors.js does not name: its name gives it its hint (`stateHint.<name>`) and its
   * `data-state`, as the card page does for "card-unavailable".
   * @param {string} name
   * @param {string} message
   * @returns {Pick<PageState, "name" | "message">}
   */
  const pageState = (name, message) => ({
    name: /** @type {PageState["name"]} */ (/** @type {unknown} */ (name)),
    message,
  });

  const searchLink = () => ({ label: t("offerPage.searchFlights"), href: "/" });

  /** "We could not find this payment", with the payment step when the checkout is known. */
  const showMissing = () => {
    showState(
      { name: "not-found", message: t("complete.missing") },
      {
        links: [
          checkoutId === null
            ? searchLink()
            : { label: t("payCard.backToPayment"), href: checkoutHref(checkoutId, "payment") },
        ],
      },
    );
  };

  /**
   * Opens the confirmation of a booking (`pending` while the airline order is being confirmed).
   * @param {string} bookingId
   * @param {boolean} pending
   */
  const openConfirmation = (bookingId, pending) => {
    live.announce(pending ? t("complete.confirming") : t("complete.booked"));
    replace(confirmationHref(bookingId, pending));
  };

  /**
   * The checkout says where its booking is, when an answer did not: its confirmation, pending while it is not
   * `completed`. Returns whether the page left.
   */
  const openBookingOfCheckout = async () => {
    if (checkoutId === null) {
      return false;
    }
    const call = track();
    try {
      const checkout = await client.checkout.get({ checkoutId }, { signal: call.signal });
      if (destroyed) {
        return true;
      }
      if (typeof checkout?.bookingId === "string" && BOOKING_ID.test(checkout.bookingId)) {
        openConfirmation(checkout.bookingId, checkout.status !== "completed");
        return true;
      }
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return true;
      }
    } finally {
      call.done();
    }
    return false;
  };

  /**
   * A failed call outside the cases of pages.md §10: the shared states, Retry when the same call may succeed later.
   * @param {unknown} error
   * @param {() => void} again
   */
  const showFailure = (error, again) => {
    const state = pageStateFor(error);
    if (state.name === "signed-out") {
      showState(state, { links: [{ label: t("account.signIn"), href: signInHref(location) }] });
      return;
    }
    if (state.name === "not-found") {
      showMissing();
      return;
    }
    const unexpected =
      state.name === "unexpected" || state.name === "validation" || state.name === "conflict";
    const retry = !FINAL_STATES.has(state.name) && (state.retry || state.name === "unexpected");
    showState(unexpected ? { ...state, message: t("state.unexpected") } : state, {
      requestId: unexpected ? requestIdOf(error) : null,
      ...(retry ? { onRetry: again } : {}),
    });
  };

  /**
   * "Payment did not go through", with the way back to the card page (which takes the same payment again, or makes a
   * new one for a payment that failed or was cancelled).
   * @param {string} id
   */
  const showPaymentFailed = (id) => {
    showState(pageState("complete-payment-failed", t("complete.paymentFailed")), {
      links:
        checkoutId === null ? [] : [{ label: t("complete.backToCard"), href: payCardHref(checkoutId, id) }],
    });
  };

  /**
   * The payment, read again while the bank confirms it (every 2 s, at most 60 s). `null` when the page shows a state
   * or left instead.
   * @param {string} id
   * @returns {Promise<Payment | null>}
   */
  const waitForPayment = async (id) => {
    const deadline = Date.now() + PAYMENT_WAIT_MS;
    progress(t("complete.checkingPayment"));
    for (;;) {
      const call = track();
      /** @type {Payment} */
      let payment;
      try {
        payment = await client.checkout.getPayment({ paymentId: id }, { signal: call.signal });
      } catch (error) {
        if (!destroyed && !isAborted(error)) {
          showFailure(error, () => run().catch(report));
        }
        return null;
      } finally {
        call.done();
      }
      if (destroyed) {
        return null;
      }
      if (payment?.checkoutId !== checkoutId) {
        showMissing();
        return null;
      }
      if (payment.method === "airline_card") {
        replace(withQuery("/checkout/pay-airline.html", { id: checkoutId, payment: payment.id }));
        return null;
      }
      if (UNPAID_STATUSES.has(payment.status)) {
        showPaymentFailed(id);
        return null;
      }
      if (!WAITING_STATUSES.has(payment.status)) {
        return payment;
      }
      if (Date.now() + PAYMENT_POLL_MS > deadline) {
        showState(pageState("payment-not-confirmed", t("complete.notConfirmed")), {
          links:
            checkoutId === null
              ? []
              : [{ label: t("complete.backToCard"), href: payCardHref(checkoutId, id) }],
          onRetry: () => run().catch(report),
        });
        return null;
      }
      progress(t("complete.waitingForBank"));
      await sleep(PAYMENT_POLL_MS);
      if (destroyed) {
        return null;
      }
    }
  };

  /**
   * An error of `checkout.complete` (pages.md §10).
   * @param {unknown} error
   * @param {Payment} payment
   */
  const failComplete = async (error, payment) => {
    if (destroyed || isAborted(error) || checkoutId === null) {
      return;
    }
    const state = pageStateFor(error);
    const code = state.code;
    const bookingId = bookingIdOf(state);
    const again = () => completeCheckout(payment).catch(report);
    if (
      code === "SUPPLIER_TIMEOUT" ||
      code === "CHECKOUT_BEING_COMPLETED" ||
      code === "CHECKOUT_ALREADY_COMPLETED"
    ) {
      // The order exists or may exist: follow the booking, never book again with a new key.
      const pending = code !== "CHECKOUT_ALREADY_COMPLETED";
      if (bookingId !== null) {
        openConfirmation(bookingId, pending);
        return;
      }
      if (await openBookingOfCheckout()) {
        return;
      }
      showState(pageState("complete-confirming", t("complete.confirming")), { onRetry: again });
      return;
    }
    if (code === "PRICE_CHANGED") {
      const details = state.details ?? {};
      const newPrice = /** @type {{ newPrice?: unknown }} */ (error).newPrice ?? details["newPrice"];
      const oldPrice = /** @type {{ oldPrice?: unknown }} */ (error).oldPrice ?? details["oldPrice"];
      const note = isMoney(newPrice)
        ? isMoney(oldPrice)
          ? t("complete.newTotal", {
              new: formatMoney(/** @type {Money} */ (newPrice), locale),
              old: formatMoney(/** @type {Money} */ (oldPrice), locale),
            })
          : t("complete.newTotalOnly", { new: formatMoney(/** @type {Money} */ (newPrice), locale) })
        : null;
      showState(pageState("complete-price-changed", t("state.price-changed")), {
        note,
        links: [{ label: t("payCard.backToPayment"), href: checkoutHref(checkoutId, "payment") }],
      });
      return;
    }
    if (code === "SOLD_OUT") {
      showState(pageState("complete-sold-out", t("state.sold-out")), { links: [searchLink()] });
      return;
    }
    if (code === "CHECKOUT_EXPIRED") {
      showState(pageState("complete-expired", t("state.checkout-expired")), { links: [searchLink()] });
      return;
    }
    if (code === "OFFER_EXPIRED") {
      showState(pageState("complete-offer-expired", t("state.offer-expired")), { links: [searchLink()] });
      return;
    }
    if (code === "PAYMENT_REQUIRED" || code === "PAYMENT_DECLINED") {
      showPaymentFailed(payment.id);
      return;
    }
    if (NOT_BOOKED_CODES.has(code)) {
      showState(pageState("complete-not-booked", t("complete.notBooked")), {
        links: [
          { label: t("payCard.backToPayment"), href: checkoutHref(checkoutId, "payment") },
          searchLink(),
        ],
      });
      return;
    }
    if (DATA_CODES.has(code)) {
      showState(pageState("complete-incomplete", t("checkout.incomplete")), {
        links: [{ label: t("complete.checkDetails"), href: checkoutHref(checkoutId, "travellers") }],
      });
      return;
    }
    if (code === "PAYMENT_AMOUNT_MISMATCH") {
      showState(pageState("complete-amount-mismatch", t("complete.amountMismatch")), {
        links: [{ label: t("payCard.backToPayment"), href: checkoutHref(checkoutId, "payment") }],
      });
      return;
    }
    if (code === "PAYMENT_PROVIDER_ERROR") {
      // Stripe did not answer when the payment was read again: nothing was charged, and the same key runs again.
      showState(pageState("unavailable", t("payCard.providerError")), { onRetry: again });
      return;
    }
    if (code === "PAYMENT_PROVIDER_NOT_CONFIGURED") {
      showState(pageState("unavailable", t("checkout.paymentsUnavailable")));
      return;
    }
    if (code === "CONFLICT") {
      // The first request for this key is still running past the API's wait: the same key again waits for it.
      showState(pageState("complete-still-running", t("complete.stillRunning")), { onRetry: again });
      return;
    }
    if (state.name === "email-not-verified") {
      showState(state);
      return;
    }
    showFailure(error, again);
  };

  /**
   * Completes the checkout with the payment, under the key of this checkout and payment.
   * @param {Payment} payment
   */
  const completeCheckout = async (payment) => {
    if (checkoutId === null) {
      return;
    }
    progress(t("complete.booking"));
    const call = track();
    try {
      const done = await client.checkout.complete(
        { checkoutId, paymentId: payment.id, expectedTotal: payment.amount },
        {
          idempotencyKey: completeKey(checkoutId, payment.id),
          timeoutMs: COMPLETE_TIMEOUT_MS,
          signal: call.signal,
        },
      );
      if (destroyed) {
        return;
      }
      const bookingId = done?.booking?.id;
      if (typeof bookingId === "string" && BOOKING_ID.test(bookingId)) {
        openConfirmation(bookingId, false);
        return;
      }
      showState({ name: "unexpected", message: t("state.unexpected") });
    } catch (error) {
      await failComplete(error, payment);
    } finally {
      call.done();
    }
  };

  /** The payment of an address without `payment=`: the checkout's active one. */
  const paymentOfCheckout = async () => {
    if (checkoutId === null) {
      return null;
    }
    const call = track();
    try {
      const checkout = await client.checkout.get({ checkoutId }, { signal: call.signal });
      if (destroyed) {
        return null;
      }
      if (
        checkout?.status === "completed" &&
        typeof checkout.bookingId === "string" &&
        BOOKING_ID.test(checkout.bookingId)
      ) {
        openConfirmation(checkout.bookingId, false);
        return null;
      }
      const id = checkout?.payment?.id;
      if (typeof id === "string" && PAYMENT_ID.test(id)) {
        history.replaceState(null, "", completeHref(checkoutId, id));
        return id;
      }
      showMissing();
    } catch (error) {
      if (!destroyed && !isAborted(error)) {
        showFailure(error, () => run().catch(report));
      }
    } finally {
      call.done();
    }
    return null;
  };

  /** The whole page: the payment, then the booking. */
  const run = async () => {
    if (checkoutId === null) {
      showMissing();
      return;
    }
    if (paymentId === null) {
      progress(t("complete.checkingPayment"));
      paymentId = await paymentOfCheckout();
      if (paymentId === null) {
        return;
      }
    }
    const payment = await waitForPayment(paymentId);
    if (payment && !destroyed) {
      await completeCheckout(payment);
    }
  };

  const done = run().catch(report);

  return {
    done,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      wake?.();
      wake = null;
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
      live.clear();
    },
  };
}

document.documentElement.dataset.js = "on";

// Before boot(): from here on no request of the page carries Stripe's client secret in its `Referer`.
dropStripeReturnParams();

boot().then((context) => {
  try {
    start(
      /** @type {{ config: StorefrontConfig, client: PageClient, session: SessionInfo | null }} */ (
        /** @type {unknown} */ (context)
      ),
    );
  } catch (error) {
    report(error);
  }
});
