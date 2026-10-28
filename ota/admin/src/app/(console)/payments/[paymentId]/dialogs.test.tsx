// @vitest-environment happy-dom
// The capture and refund dialogs as a payment's page renders them (OAD-011): the booking page's dialogs
// (payment-dialogs.tsx, on OAD-004's ConfirmDialog) with this page's server actions, mocked here (README §12). What the
// real actions answer is in actions.test.ts; this file checks what staff see of an answer and what the dialogs post:
// the refusal of a refund above what is still refundable shown in the dialog with its request id and on the amount,
// and the payment, its version and the key the page rendered sent to this page's actions, never the booking page's.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pageActions = vi.hoisted(() => ({ capturePayment: vi.fn(), refundPayment: vi.fn() }));
const bookingActions = vi.hoisted(() => ({
  issueTickets: vi.fn(),
  cancelBooking: vi.fn(),
  patchBooking: vi.fn(),
  resyncBooking: vi.fn(),
  addNote: vi.fn(),
  capturePayment: vi.fn(),
  refundPayment: vi.fn(),
}));
vi.mock("./actions", () => pageActions);
vi.mock("@/app/(console)/bookings/[bookingId]/actions", () => bookingActions);
// The environment badge's module imports the switch's server actions; the dialogs never call them.
vi.mock("@/app/(console)/env-actions", () => ({ switchEnvironment: vi.fn(), resetEnvironment: vi.fn() }));

import {
  CaptureDialog,
  PAYMENT_STRINGS,
  RefundDialog,
} from "@/app/(console)/bookings/[bookingId]/payment-dialogs";
import { CONFIRM_STRINGS } from "@/components/confirm-dialog";
import type { ActionState } from "@/lib/action-state";

import { capturePayment, refundPayment } from "./actions";

const PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
/** Keys the page rendered (dummy UUIDs). */
const KEY = "0b6c9a1e-2f3d-4c5b-8a79-6e5d4c3b2a10";
const OTHER_KEY = "5d4c3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

/** What the refund action answers for `422 UNPROCESSABLE` `amount_exceeds_captured` (actions.test.ts). */
const AMOUNT_EXCEEDS_CAPTURED = "The amount is above what can still be refunded. Reload the page to see it.";

/**
 * How long a step that opens a Radix dialog or runs a (fake) server action through React's action queue may take
 * before a wait gives up: quick alone, slower on a busy CI runner than Testing Library's default of one second.
 */
const UI_WAIT = { timeout: 3_000 } as const;

const eur = (amount: string) => ({ amount, currency: "EUR" });

/** Opens the dialog of the trigger named `name` and returns it with its form. */
async function open(name: string): Promise<{ dialog: HTMLElement; form: HTMLFormElement }> {
  fireEvent.click(screen.getByRole("button", { name }));
  const dialog = await screen.findByRole("dialog", {}, UI_WAIT);
  const form = dialog.querySelector("form");
  if (form === null) {
    throw new Error("the dialog has no form");
  }
  return { dialog, form };
}

/** The value of a hidden field of a form. */
function hidden(form: HTMLFormElement, name: string): string | undefined {
  return form.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)?.value;
}

/** Types a reason and submits the dialog's form. */
function confirm(dialog: HTMLElement, form: HTMLFormElement): void {
  fireEvent.change(within(dialog).getByLabelText(CONFIRM_STRINGS.reasonLabel), {
    target: { value: "Checked with the traveller" },
  });
  fireEvent.submit(form);
}

/** What a mocked action received on its last call. */
function lastForm(action: ReturnType<typeof vi.fn>): FormData {
  const form = action.mock.calls.at(-1)?.[1];
  if (!(form instanceof FormData)) {
    throw new Error("the action was not called with a form");
  }
  return form;
}

function refundDialog(bookingId?: string) {
  return (
    <RefundDialog
      paymentId={PAYMENT_ID}
      bookingId={bookingId}
      environment="test"
      idempotencyKey={OTHER_KEY}
      action={refundPayment}
      refundable={eur("1264.06")}
    />
  );
}

// Once per file: the first render, the first Radix dialog with its focus trap and React's first action are the slowest
// in a fresh worker; on a busy CI runner they would otherwise land in the first test's own five seconds. Nothing of it
// stays: the document is emptied and the mock forgotten.
beforeAll(async () => {
  pageActions.refundPayment.mockResolvedValue({ ok: true });
  render(refundDialog(BOOKING_ID));
  const { dialog, form } = await open(PAYMENT_STRINGS.refund);
  confirm(dialog, form);
  await waitFor(() => expect(pageActions.refundPayment).toHaveBeenCalled(), UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  for (const action of [...Object.values(pageActions), ...Object.values(bookingActions)]) {
    action.mockReset();
    action.mockResolvedValue({ ok: true, message: "Done." } satisfies ActionState);
  }
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("the payment page's dialogs", () => {
  it("[OAD-011 AC1] show a refund above what is still refundable refused with the API's message, on the amount, with the request id", async () => {
    pageActions.refundPayment.mockResolvedValue({
      ok: false,
      code: "UNPROCESSABLE",
      message: AMOUNT_EXCEEDS_CAPTURED,
      requestId: "req_fake_1",
      fieldErrors: { amount: AMOUNT_EXCEEDS_CAPTURED },
    } satisfies ActionState);
    render(refundDialog(BOOKING_ID));
    const { dialog, form } = await open(PAYMENT_STRINGS.refund);
    expect(dialog.textContent).toContain("Still refundable: €1,264.06.");

    const amount = within(dialog).getByLabelText(PAYMENT_STRINGS.refundAmount("EUR"));
    fireEvent.change(amount, { target: { value: "2000.00" } });
    fireEvent.change(within(dialog).getByLabelText(PAYMENT_STRINGS.refundReason), {
      target: { value: "goodwill" },
    });
    confirm(dialog, form);

    const alert = await within(dialog).findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain(AMOUNT_EXCEEDS_CAPTURED);
    expect(alert.textContent).toContain(CONFIRM_STRINGS.requestId("req_fake_1"));
    // The amount carries the message too, linked for screen readers; the dialog stays open to correct it.
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    const described = (amount.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain(AMOUNT_EXCEEDS_CAPTURED);
    expect(screen.getByRole("dialog")).toBeTruthy();
    // This page's action got the refund; the booking page's did not.
    expect(lastForm(pageActions.refundPayment).get("amount")).toBe("2000.00");
    expect(lastForm(pageActions.refundPayment).get("actionKey")).toBe(OTHER_KEY);
    expect(bookingActions.refundPayment).not.toHaveBeenCalled();
  });

  it("[OAD-011] post the payment, its version and the key the page rendered to this page's actions; no booking when it has none", async () => {
    render(
      <>
        <CaptureDialog
          paymentId={PAYMENT_ID}
          environment="live"
          idempotencyKey={KEY}
          action={capturePayment}
          version={2}
          authorized={eur("1414.06")}
        />
        {refundDialog(BOOKING_ID)}
      </>,
    );

    let { dialog, form } = await open(PAYMENT_STRINGS.capture);
    expect(within(dialog).getByText(CONFIRM_STRINGS.liveWarning)).toBeTruthy();
    expect([hidden(form, "paymentId"), hidden(form, "version"), hidden(form, "currency")]).toEqual([
      PAYMENT_ID,
      "2",
      "EUR",
    ]);
    // A payment whose checkout has no booking yet posts none.
    expect(hidden(form, "bookingId")).toBeUndefined();
    expect(hidden(form, "actionKey")).toBe(KEY);
    confirm(dialog, form);
    await waitFor(() => expect(pageActions.capturePayment).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(lastForm(pageActions.capturePayment).get("actionKey")).toBe(KEY);
    expect(bookingActions.capturePayment).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);

    ({ dialog, form } = await open(PAYMENT_STRINGS.refund));
    expect(hidden(form, "bookingId")).toBe(BOOKING_ID);
    expect(hidden(form, "version")).toBeUndefined();
    expect(hidden(form, "actionKey")).toBe(OTHER_KEY);
  });
});
