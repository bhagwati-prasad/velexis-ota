// Entry module of the guest lookup page (lookup.html, ota/frontend/docs/pages-account.md §1 and §4, flow
// ota/docs/flows/my-bookings-and-guest-lookup.md §2 and §3 step 8, SDK guide B3 §4.1). Anybody may use it: a guest
// who lost the booking's cookie, a traveller on another device, a customer who booked as a guest.
//
// - The form takes the booking reference (or the airline's record locator) and the last name of any traveller.
//   `bookings.lookup({ bookingReference, lastName })` goes out with a new idempotency key for every submit: the API
//   keeps an answer under its key for 24 hours, so a corrected name sent with the key of the first try would replay
//   that try's `404` (or, with another body, answer `409 IDEMPOTENCY_KEY_REUSED`). The SDK's own retries of one submit
//   keep its key.
// - The SDK runs in cookie mode: the API adds the booking's guest token to the httpOnly `__Host-vx_bt` cookie and the
//   result says `bookingToken: null`, so the page never holds a token. Success opens `/booking.html?id=bkg_…`.
// - Every mismatch is one message, "We could not find a booking with these details": the API answers a wrong
//   reference and a wrong name with the same `404`, and the page never marks either field or says more for a `404`,
//   whatever its body carries. Only the format checks (a reference of 5 to 10 letters and digits, a last name of at
//   most 60 characters, nothing empty), made before any request, and the API's `400` mark a field.
// - `429 RATE_LIMITED` (5 failed lookups in 15 minutes per visitor and per reference) says how long to wait from
//   `retryAfterSeconds` and disables the button until then; the button comes back with "You can try again now" in
//   the live region. A `429` without a wait says "try again later" and leaves the button on.
// - Any other failure shows the shared state ("not available right now", "Something went wrong" with the request id).
//
// The form is `method="post"` without an action, so a submit that never reaches this script puts nothing into an
// address. Below the form, a visitor of an OTA with customer accounts gets a sign-in link to My bookings, a signed-in
// customer a link to My bookings.

import { boot, renderState } from "../boot.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { clearFieldErrors, serialize, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import { authState, decorateState, failureState } from "../lib/session.js";
import { withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["FieldError"]} FieldError */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {{ bookings: Pick<VelexisClient["bookings"], "lookup"> }} PageClient */

/** The booking page a successful lookup opens. */
export const BOOKING_PATH = "/booking.html";
/** `BookingLookupResult.bookingId`: the only id the page follows. */
export const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
/** `BookingLookupRequest.bookingReference`: a booking reference or a record locator. */
export const REFERENCE = /^[A-Za-z0-9]{5,10}$/;
/** `BookingLookupRequest.lastName`: at most this many characters. */
export const LAST_NAME_MAX_LENGTH = 60;
/** The longest delay `setTimeout` keeps (a WebIDL `long`): a longer one overflows and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
 * The reference as the API takes it: without the spaces a copy from an e-mail may bring, in capitals (the API compares
 * it case-insensitively).
 * @param {unknown} value
 */
export const normaliseReference = (value) =>
  String(value ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();

/**
 * What the form says before any request: the field errors of the format checks (never of a match, which only the API
 * knows), or none.
 * @param {string} bookingReference normalised
 * @param {string} lastName trimmed
 * @returns {FieldError[]}
 */
export function formatErrors(bookingReference, lastName) {
  /** @type {FieldError[]} */
  const errors = [];
  if (bookingReference === "") {
    errors.push({ path: "/bookingReference", code: "required", message: "" });
  } else if (!REFERENCE.test(bookingReference)) {
    errors.push({ path: "/bookingReference", code: "BOOKING_REFERENCE_FORMAT", message: "" });
  }
  if (lastName === "") {
    errors.push({ path: "/lastName", code: "required", message: "" });
  } else if (lastName.length > LAST_NAME_MAX_LENGTH) {
    errors.push({ path: "/lastName", code: "maxLength", message: "" });
  }
  return errors;
}

/**
 * The title of the `429` state: the wait in whole seconds (rounded up) under a minute, else in whole minutes rounded
 * up, else "later". A wait that rounds up to 60 seconds is "1 minute".
 * @param {number | undefined} seconds `retryAfterSeconds`
 */
export function waitMessage(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return t("lookup.tooManyAttempts");
  }
  const whole = Math.ceil(seconds);
  return whole < 60
    ? t("lookup.tooManyAttemptsSeconds", { count: whole })
    : t("lookup.tooManyAttemptsMinutes", { count: Math.ceil(whole / 60) });
}

/**
 * Runs the lookup page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page has
 * no lookup area, else `{ done, destroy }`.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, navigate?: (url: string) => void, newKey?: () => string }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-lookup-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const navigate = env.navigate ?? ((/** @type {string} */ url) => view.location.assign(url));
  const newKey = env.newKey ?? (() => view.crypto.randomUUID());
  const { config, client, session = null } = context;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);
  const form = /** @type {HTMLFormElement} */ (main.querySelector("form[data-lookup-form]"));
  const stateBox = /** @type {HTMLElement} */ (main.querySelector("[data-lookup-state]"));
  const button = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
  /** The wait of a `429`: the button is disabled until it ends. @type {ReturnType<typeof setTimeout> | undefined} */
  let waitTimer;

  // Below the form: sign-in for a visitor, My bookings for a customer, nothing without customer accounts.
  const accounts = config?.features?.customerAccounts !== false;
  const signIn = /** @type {HTMLElement} */ (main.querySelector("[data-lookup-sign-in]"));
  const myBookings = /** @type {HTMLElement} */ (main.querySelector("[data-lookup-my-bookings]"));
  signIn.hidden = !accounts || session !== null;
  myBookings.hidden = !accounts || session === null;

  /**
   * Shows a state above the form and moves the focus to it; `contact` adds the support address.
   * @param {Pick<PageState, "name" | "scope" | "message"> & Partial<PageState>} state
   * @param {{ hint?: string | null, requestId?: string | null, contact?: boolean }} [extras]
   */
  const show = (state, { hint = null, requestId = null, contact = false } = {}) => {
    const element = renderState(stateBox, state, {
      scope: "inline",
      support: contact ? support : null,
      requestId,
      focus: true,
    });
    decorateState(element, { hint });
    return element;
  };

  /**
   * Disables the button for a `429`'s wait; when it ends, the state goes, the button comes back and the live region
   * says so. A wait longer than a timer holds (about 24.8 days) keeps the button disabled for that long instead of
   * overflowing into an immediate end.
   * @param {number} seconds
   */
  const waitBeforeRetry = (seconds) => {
    clearTimeout(waitTimer);
    button.disabled = true;
    waitTimer = setTimeout(
      () => {
        waitTimer = undefined;
        button.disabled = false;
        stateBox.replaceChildren();
        live.announce(t("lookup.canTryAgain"));
      },
      Math.min(seconds * 1000, MAX_TIMER_MS),
    );
  };

  /**
   * Shows what a failed lookup means.
   * @param {unknown} error
   */
  const fail = (error) => {
    if (isAborted(error)) {
      return;
    }
    const state = pageStateFor(error);
    if (state.name === "not-found") {
      // One message for a wrong reference and a wrong name: no field is marked, nothing of the answer is shown.
      show(authState("not-found", t("lookup.notFound")), { hint: t("lookup.notFoundHint") });
      return;
    }
    if (state.name === "rate-limited") {
      const seconds = state.retryAfterSeconds;
      show(authState("rate-limited", waitMessage(seconds)), { hint: t("lookup.tooManyAttemptsHint") });
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
        waitBeforeRetry(seconds);
      }
      return;
    }
    if (state.name === "validation" && state.fieldErrors.length > 0) {
      showFieldErrors(form, state.fieldErrors);
      return;
    }
    const failure = failureState(error);
    show(failure.state, { requestId: failure.requestId, contact: true });
  };

  /** @param {SubmitEvent} event */
  const onSubmit = (event) => {
    event.preventDefault();
    if (button.disabled) {
      // A `429`'s wait is running: a submit by the Enter key or a script does nothing either.
      return;
    }
    withSubmitState(form, async () => {
      clearFieldErrors(form);
      stateBox.replaceChildren();
      const values = serialize(form);
      const bookingReference = normaliseReference(values["bookingReference"]);
      const lastName = String(values["lastName"] ?? "").trim();
      const errors = formatErrors(bookingReference, lastName);
      if (errors.length > 0) {
        showFieldErrors(form, errors);
        return;
      }
      /** @type {Awaited<ReturnType<PageClient["bookings"]["lookup"]>>} */
      let result;
      try {
        result = await client.bookings.lookup({ bookingReference, lastName }, { idempotencyKey: newKey() });
      } catch (error) {
        fail(error);
        return;
      }
      const bookingId = result?.bookingId;
      if (typeof bookingId !== "string" || !BOOKING_ID.test(bookingId)) {
        fail(new Error("bookings.lookup answered without a booking id"));
        return;
      }
      live.announce(t("lookup.found"));
      navigate(withQuery(BOOKING_PATH, { id: bookingId }));
    }).catch(report);
  };
  form.addEventListener("submit", onSubmit);

  return {
    done: Promise.resolve(),
    destroy() {
      form.removeEventListener("submit", onSubmit);
      clearTimeout(waitTimer);
      live.clear();
    },
  };
}

document.documentElement.dataset.js = "on";

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
