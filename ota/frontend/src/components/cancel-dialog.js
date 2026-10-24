// The cancellation dialog of the booking page (ota/frontend/docs/pages-account.md §3 point 5, flow
// ota/docs/flows/change-and-cancel.md §2–§4, SDK guide B3 §4.5): a native `<dialog>` (focus trap and Escape for free)
// on the `[data-cancel-dialog]` markup of booking.html.
//
// 1. Opening it asks `bookings.quoteCancellation({ bookingId })` and shows the refund preview: the mode (`release`,
//    `void` with its deadline, `refund`, `request_only`: "We will send your request to the airline; refunds follow the
//    fare rules"), the estimated refund of what was paid, what is kept (airline penalty, fees), one line per traveller
//    when there are several, and how long the quote holds. `not_allowed` replaces the form with "This booking can no
//    longer be cancelled online", its reason and the support contact.
// 2. Confirming calls `bookings.cancel({ bookingId, ifMatch: version, reasonCode, comment, expectedRefund })` with 90 s
//    and a stable idempotency key (`cancellationKey`): the booking, its version and a hash of what is sent, so a double
//    click, a Retry or a reload of the same request replays the first outcome (the airline is asked once), while a
//    request with another amount or reason after a refusal the API keeps (`409 REFUND_AMOUNT_CHANGED`) gets a new key
//    instead of `409 IDEMPOTENCY_KEY_REUSED`.
// 3. Outcomes: `cancelled` ("Your booking is cancelled" and what happens to the money) and `pending` ("Request sent",
//    `request_only`), both handed to the page with `onResult`; `409 REFUND_AMOUNT_CHANGED` shows the new amount (its
//    `details.newRefund`, the quote read again) and asks again; `412 PRECONDITION_FAILED` and `409 VERSION_CONFLICT`
//    reload the booking (with the airline for the second) and quote again; `409 BOOKING_NOT_MODIFIABLE` (with its
//    `details.reason`) and `403 FEATURE_DISABLED` say it can no longer be cancelled online, `409
//    BOOKING_ALREADY_CANCELLED` that it is cancelled, and all of them reload the booking; `504
//    SUPPLIER_TIMEOUT` says the airline has not confirmed yet and reloads the booking (its pending cancellation), never
//    sending again with a new key; any other failure keeps the form with the shared state and a Retry of the same
//    request.

import { renderState } from "../boot.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatMoney, formatTimestamp } from "../lib/format.js";
import { clearFieldErrors, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { hasString, t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Booking"]} Booking */
/** @typedef {import("@velexis/ota-sdk").Schemas["CancellationQuote"]} CancellationQuote */
/** @typedef {import("@velexis/ota-sdk").Schemas["CancellationResult"]} CancellationResult */
/** @typedef {import("@velexis/ota-sdk").Schemas["Cancellation"]} Cancellation */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontSupport"]} StorefrontSupport */
/**
 * What the dialog needs from the page.
 * @typedef {object} CancelDialogProps
 * @property {Pick<VelexisClient, "bookings">} client
 * @property {() => Booking | null} booking the booking on the page now (its id and `version`)
 * @property {(result: CancellationResult) => void} onResult a cancellation was made or requested
 * @property {(options: { refresh: boolean }) => Promise<Booking | null>} reload reloads the booking on the page;
 *   resolves with it, `null` when it could not be read
 * @property {string} [locale]
 * @property {string} [timeZone]
 * @property {Partial<StorefrontSupport> | null} [support]
 * @property {(text: string) => void} [announce] the page's live region
 */

/** How long `bookings.cancel` may take: Amadeus DELETE and the money step (SDK guide B3 §4.5). */
export const CANCEL_TIMEOUT_MS = 90_000;
/** Modes in which `bookings.cancel` cancels at once (the others are a request, or impossible). */
const REFUND_MODES = new Set(["release", "void", "refund"]);
/** Failures after which the same request cannot succeed: no Retry. */
const FINAL_STATES = new Set(["suspended", "unknown-host", "forbidden", "not-found", "signed-out"]);

/**
 * Reports an error of the component without breaking the page.
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
 * Whether a money amount is zero ("0", "0.00").
 * @param {Money | null | undefined} money
 */
export const isZeroMoney = (money) =>
  !money || typeof money.amount !== "string" || /^-?0*(?:\.0*)?$/.test(money.amount);

/**
 * The FNV-1a hash of a text, as 8 hex digits (not a secret: it only tells two requests apart).
 * @param {string} text
 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The idempotency key of a cancellation: stable for the same booking version and the same request (a double click, a
 * Retry, a reload), another one for a request that differs (a new refund amount after `409 REFUND_AMOUNT_CHANGED`,
 * another reason), so the API never answers `409 IDEMPOTENCY_KEY_REUSED`. 16 to 128 characters.
 * @param {string} bookingId
 * @param {number} version
 * @param {{ reasonCode: string, comment?: string, expectedRefund: Money }} body
 */
export function cancellationKey(bookingId, version, body) {
  const content = JSON.stringify([
    body.reasonCode,
    body.comment ?? "",
    body.expectedRefund?.amount ?? "",
    body.expectedRefund?.currency ?? "",
  ]);
  return `cancel-${bookingId}-${version}-${fnv1a(content)}`;
}

/**
 * What happens to the money of a cancellation (`Cancellation.refundStatus`), or `null` when there is nothing to say
 * (`not_applicable`).
 * @param {Pick<Cancellation, "refundStatus" | "refund" | "estimatedRefund"> | null | undefined} cancellation
 * @param {string | undefined} locale
 * @returns {string | null}
 */
export function refundText(cancellation, locale) {
  const status = cancellation?.refundStatus;
  const amount = cancellation?.refund?.amount ?? cancellation?.estimatedRefund ?? null;
  const known = amount !== null && !isZeroMoney(amount);
  switch (status) {
    case "authorization_voided":
    case "failed":
    case "manual_review":
      return t(`refundStatus.${status}`);
    case "pending":
    case "processing":
    case "succeeded":
      return known
        ? t(`refundStatus.${status}`, { amount: formatMoney(amount, locale) })
        : t(`refundStatus.${status}NoAmount`);
    default:
      return null;
  }
}

/**
 * Mounts the dialog. `open()` shows it with a new quote for the page's booking; `destroy()` removes the listeners.
 * @param {HTMLDialogElement} dialog the `[data-cancel-dialog]` element
 * @param {CancelDialogProps} props
 */
export function mount(dialog, props) {
  const { client, locale, timeZone, support = null, announce = () => {} } = props;
  const doc = dialog.ownerDocument;
  const find = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (dialog.querySelector(selector));
  const el = {
    title: find("[data-cancel-title]"),
    loading: find("[data-cancel-loading]"),
    quote: find("[data-cancel-quote]"),
    mode: find("[data-cancel-mode]"),
    refund: find("[data-cancel-refund]"),
    kept: find("[data-cancel-kept]"),
    lines: find("[data-cancel-lines]"),
    valid: find("[data-cancel-valid]"),
    notice: find("[data-cancel-notice]"),
    form: /** @type {HTMLFormElement} */ (dialog.querySelector("form[data-cancel-form]")),
    reason: /** @type {HTMLSelectElement} */ (dialog.querySelector('select[name="reasonCode"]')),
    comment: /** @type {HTMLTextAreaElement} */ (dialog.querySelector('textarea[name="comment"]')),
    confirm: /** @type {HTMLButtonElement} */ (dialog.querySelector("button[data-cancel-confirm]")),
    done: find("[data-cancel-done]"),
    doneTitle: find("[data-cancel-done-title]"),
    doneText: find("[data-cancel-done-text]"),
    close: find("[data-cancel-close]"),
  };
  /** The quote on the screen. @type {CancellationQuote | null} */
  let quote = null;
  /** A cancel request is on its way: the dialog stays open. */
  let sending = false;
  /** The quote request running, aborted when the dialog closes. @type {AbortController | null} */
  let quoting = null;

  /** @param {unknown} error */
  const requestIdOf = (error) =>
    error instanceof Error && "requestId" in error
      ? String(/** @type {{ requestId: unknown }} */ (error).requestId ?? "") || null
      : null;

  /**
   * Shows one part of the dialog: the loading line, the quote with its form, the quote without a form (not
   * cancellable), or the outcome.
   * @param {"loading" | "quote" | "not-allowed" | "done" | "failed"} part
   */
  const show = (part) => {
    el.loading.hidden = part !== "loading";
    el.quote.hidden = part !== "quote";
    el.form.hidden = part !== "quote";
    el.done.hidden = part !== "done";
    el.close.hidden = part === "quote" || part === "loading";
  };

  /**
   * Shows a message in the dialog's state slot (a page state of src/boot.js).
   * @param {Parameters<typeof renderState>[1]} state
   * @param {{ onRetry?: () => void, requestId?: string | null, focus?: boolean }} [options]
   */
  const notify = (state, options = {}) => {
    renderState(el.notice, state, { support, ...options });
    announce(state.message);
  };

  /**
   * The label of the confirm button. While the form is busy (lib/forms.js shows its busy label), the label it gets
   * back afterwards is changed instead, so a new quote shown during the request keeps its own amount.
   * @param {string} text
   */
  const setConfirmLabel = (text) => {
    if (el.confirm.hasAttribute("data-idle-label")) {
      el.confirm.setAttribute("data-idle-label", text);
    } else {
      el.confirm.textContent = text;
    }
  };

  /** One line of a list. */
  const item = (/** @type {string} */ text) => {
    const line = doc.createElement("li");
    line.textContent = text;
    return line;
  };

  /**
   * Replaces the form with "This booking can no longer be cancelled online", its reason (the quote's
   * `notAllowedReason`, or what a refusal of `bookings.cancel` says) and the support contact. A booking that is already
   * cancelled says "This booking is cancelled" instead: there is nothing left to cancel.
   * @param {string | null | undefined} reason
   * @param {{ focus?: boolean }} [options]
   */
  const showNotAllowed = (reason, { focus = false } = {}) => {
    show("not-allowed");
    if (reason === "cancelled") {
      notify({ name: "conflict", scope: "inline", message: t("booking.cancelledTitle") }, { focus });
      return;
    }
    const why = reason && hasString(`cancel.notAllowed.${reason}`) ? t(`cancel.notAllowed.${reason}`) : null;
    renderState(
      el.notice,
      { name: "cancel-unavailable", scope: "inline", message: t("cancel.notAllowed") },
      { support, focus },
    );
    const line = el.notice.querySelector('[data-field="hint"]');
    if (why !== null && line instanceof HTMLElement) {
      line.textContent = `${why} ${t("stateHint.cancel-unavailable")}`;
      line.hidden = false;
    }
    announce(t("cancel.notAllowed"));
  };

  /**
   * The reason of a refusal that means the booking cannot be cancelled online (`409 BOOKING_ALREADY_CANCELLED`, `409
   * BOOKING_NOT_MODIFIABLE` with `details.reason`, `403 FEATURE_DISABLED`), or `undefined` for any other failure.
   * @param {import("../lib/errors.js").PageState} state
   * @returns {string | null | undefined}
   */
  const refusalReasonOf = (state) => {
    if (state.code === "BOOKING_ALREADY_CANCELLED") {
      return "cancelled";
    }
    if (state.name === "feature-disabled") {
      return "disabled_by_ota";
    }
    if (state.code === "BOOKING_NOT_MODIFIABLE") {
      const reason = state.details?.["reason"];
      return typeof reason === "string" ? reason : null;
    }
    return undefined;
  };

  /**
   * Shows the quote and its form.
   * @param {CancellationQuote} next
   */
  const renderQuote = (next) => {
    quote = next;
    if (!next.cancellable || next.mode === "not_allowed") {
      showNotAllowed(next.notAllowedReason);
      return;
    }
    show("quote");
    const mode = String(next.mode);
    el.mode.textContent =
      mode === "void"
        ? t("cancel.mode.void", {
            time: next.voidDeadlineAt ? formatTimestamp(next.voidDeadlineAt, locale, timeZone) : "",
          })
        : hasString(`cancel.mode.${mode}`)
          ? t(`cancel.mode.${mode}`)
          : "";
    const refunds = REFUND_MODES.has(mode);
    el.refund.hidden = !refunds;
    el.refund.textContent = !refunds
      ? ""
      : isZeroMoney(next.estimatedRefund)
        ? t("cancel.refundNone")
        : t("cancel.refund", {
            refund: formatMoney(next.estimatedRefund, locale),
            paid: formatMoney(next.amountPaid, locale),
          });
    el.kept.replaceChildren(
      ...(refunds && !isZeroMoney(next.penalty)
        ? [item(t("cancel.penalty", { amount: formatMoney(next.penalty, locale) }))]
        : []),
      ...(refunds && !isZeroMoney(next.otaFee)
        ? [item(t("cancel.otaFee", { amount: formatMoney(next.otaFee, locale) }))]
        : []),
    );
    const lines = Array.isArray(next.lines) ? next.lines : [];
    el.lines.replaceChildren(
      ...(refunds && lines.length > 1
        ? lines.map((line) =>
            item(
              t("cancel.line", {
                name: line.travelerName ?? line.travelerId,
                refund: formatMoney(line.refund, locale),
              }),
            ),
          )
        : []),
    );
    el.valid.textContent = t("cancel.validUntil", {
      time: formatTimestamp(next.expiresAt, locale, timeZone),
    });
    setConfirmLabel(
      mode === "request_only"
        ? t("cancel.request")
        : isZeroMoney(next.estimatedRefund)
          ? t("cancel.confirm")
          : t("cancel.confirmRefund", { refund: formatMoney(next.estimatedRefund, locale) }),
    );
  };

  /**
   * Reads the quote and shows it; `message` (a changed refund, a changed booking) is shown with it.
   * @param {{ message?: string | null, fallback?: CancellationQuote | null, focus?: boolean }} [options]
   *   `fallback`: the quote to show when it cannot be read again
   */
  const loadQuote = async ({ message = null, fallback = null, focus = false } = {}) => {
    const booking = props.booking();
    if (!booking) {
      return;
    }
    quoting?.abort();
    const controller = new AbortController();
    quoting = controller;
    el.notice.replaceChildren();
    show("loading");
    announce(t("cancel.quoting"));
    /** @type {CancellationQuote} */
    let next;
    try {
      next = await client.bookings.quoteCancellation(
        { bookingId: booking.id },
        { signal: controller.signal },
      );
    } catch (error) {
      if (isAborted(error) || controller.signal.aborted) {
        return;
      }
      if (fallback) {
        next = fallback;
      } else {
        const state = pageStateFor(error);
        const refusal = refusalReasonOf(state);
        if (refusal !== undefined) {
          showNotAllowed(refusal, { focus });
          props.reload({ refresh: false }).catch(report);
          return;
        }
        show("failed");
        const unexpected = state.name === "unexpected" || state.name === "validation";
        notify(unexpected ? { ...state, message: t("state.unexpected") } : state, {
          focus,
          requestId: unexpected ? requestIdOf(error) : null,
          ...(FINAL_STATES.has(state.name)
            ? {}
            : { onRetry: () => loadQuote({ focus: true }).catch(report) }),
        });
        return;
      }
    } finally {
      if (quoting === controller) {
        quoting = null;
      }
    }
    renderQuote(next);
    if (message !== null && !el.form.hidden) {
      notify({ name: "stale", scope: "inline", message }, { focus: true });
    } else if (focus) {
      el.title.focus();
    }
  };

  /**
   * The outcome of `bookings.cancel`.
   * @param {CancellationResult} result
   */
  const showResult = (result) => {
    const cancellation = result.cancellation;
    const pending = cancellation?.status === "pending";
    el.notice.replaceChildren();
    show("done");
    el.doneTitle.textContent = pending ? t("cancel.requestSent") : t("cancel.done");
    el.doneText.textContent = pending
      ? t("cancel.requestSentText")
      : (refundText(cancellation, locale) ?? "");
    el.doneText.hidden = el.doneText.textContent === "";
    el.title.focus();
    announce(`${el.doneTitle.textContent}. ${el.doneText.textContent}`);
    props.onResult(result);
  };

  /**
   * A failure of `bookings.cancel` (see the top of this file).
   * @param {unknown} error
   * @param {Money} expectedRefund what was sent
   */
  const onCancelError = async (error, expectedRefund) => {
    if (isAborted(error)) {
      return;
    }
    const state = pageStateFor(error);
    if (state.code === "REFUND_AMOUNT_CHANGED") {
      const raw = state.details?.["newRefund"];
      const newRefund =
        raw !== null && typeof raw === "object" && typeof (/** @type {Money} */ (raw).amount) === "string"
          ? /** @type {Money} */ (raw)
          : null;
      const message = newRefund
        ? t("cancel.refundChanged", {
            old: formatMoney(expectedRefund, locale),
            new: formatMoney(newRefund, locale),
          })
        : t("cancel.stale");
      await loadQuote({
        message,
        fallback: quote && newRefund ? { ...quote, estimatedRefund: newRefund } : null,
      });
      return;
    }
    if (state.name === "stale") {
      // 412 (another change of the booking) or 409 VERSION_CONFLICT (the airline's order changed): the booking again,
      // then a new quote for its version.
      const next = await props.reload({ refresh: state.code === "VERSION_CONFLICT" });
      if (next && next.allowedActions?.canCancel === false) {
        const reason = next.allowedActions.reasons?.["canCancel"];
        showNotAllowed(next.status === "cancelled" ? "cancelled" : reason, { focus: true });
        return;
      }
      await loadQuote({ message: t("cancel.stale") });
      return;
    }
    const refusal = refusalReasonOf(state);
    if (refusal !== undefined) {
      showNotAllowed(refusal, { focus: true });
      props.reload({ refresh: false }).catch(report);
      return;
    }
    if (state.name === "supplier-timeout") {
      // The outcome is not known yet: the API decides it and replays it to the same key. Nothing is sent again.
      el.notice.replaceChildren();
      show("done");
      el.doneTitle.textContent = t("cancel.timeout");
      el.doneText.textContent = t("cancel.timeoutText");
      el.doneText.hidden = false;
      el.title.focus();
      announce(`${t("cancel.timeout")}. ${t("cancel.timeoutText")}`);
      props.reload({ refresh: false }).catch(report);
      return;
    }
    if (state.name === "validation" && state.fieldErrors.length > 0) {
      showFieldErrors(el.form, state.fieldErrors);
      announce(t("state.validation"));
      return;
    }
    const unexpected = state.name === "unexpected" || state.name === "validation";
    notify(unexpected ? { ...state, message: t("state.unexpected") } : state, {
      focus: true,
      requestId: unexpected ? requestIdOf(error) : null,
      ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => el.form.requestSubmit() }),
    });
  };

  /** Confirm: `bookings.cancel` with the refund on the screen. */
  const submit = () =>
    withSubmitState(el.form, async () => {
      const booking = props.booking();
      if (!booking || !quote) {
        return;
      }
      el.notice.replaceChildren();
      const reasonCode = el.reason.value;
      if (reasonCode === "") {
        showFieldErrors(el.form, [{ path: "/reasonCode", code: "required", message: "" }]);
        return;
      }
      const comment = el.comment.value.trim();
      const expectedRefund = quote.estimatedRefund;
      const body = {
        reasonCode: /** @type {import("@velexis/ota-sdk").Schemas["CancellationReason"]} */ (reasonCode),
        ...(comment !== "" ? { comment } : {}),
        expectedRefund,
      };
      sending = true;
      /** @type {CancellationResult} */
      let result;
      try {
        result = await client.bookings.cancel(
          { bookingId: booking.id, ifMatch: booking.version, ...body },
          {
            idempotencyKey: cancellationKey(booking.id, booking.version, body),
            timeoutMs: CANCEL_TIMEOUT_MS,
          },
        );
      } catch (error) {
        sending = false;
        await onCancelError(error, expectedRefund);
        return;
      }
      sending = false;
      showResult(result);
    });

  /** @param {SubmitEvent} event */
  const onSubmit = (event) => {
    event.preventDefault();
    submit().catch(report);
  };
  /** @param {Event} event */
  const onClick = (event) => {
    const target = /** @type {Element | null} */ (event.target);
    if (target?.closest?.('[data-action="close-dialog"]') && !sending) {
      dialog.close();
    }
  };
  /** Escape closes the dialog, except while the cancellation is on its way. */
  const onCancelEvent = (/** @type {Event} */ event) => {
    if (sending) {
      event.preventDefault();
    }
  };
  const onClose = () => {
    quoting?.abort();
    quoting = null;
  };
  el.form.addEventListener("submit", onSubmit);
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("cancel", onCancelEvent);
  dialog.addEventListener("close", onClose);

  return {
    /** Opens the dialog with a new quote for the page's booking. */
    open() {
      quote = null;
      el.notice.replaceChildren();
      el.form.reset();
      clearFieldErrors(el.form);
      el.done.hidden = true;
      if (!dialog.open) {
        dialog.showModal();
      }
      el.title.focus();
      loadQuote().catch(report);
    },
    /** Closes the dialog (not while the cancellation is on its way). */
    close() {
      if (!sending && dialog.open) {
        dialog.close();
      }
    },
    destroy() {
      quoting?.abort();
      el.form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("cancel", onCancelEvent);
      dialog.removeEventListener("close", onClose);
    },
  };
}
