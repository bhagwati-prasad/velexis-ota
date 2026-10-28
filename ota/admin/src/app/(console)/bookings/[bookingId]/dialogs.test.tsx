// @vitest-environment happy-dom
// The dialogs and forms of a booking's actions (OAD-008: issue-dialog.tsx, cancel-dialog.tsx, payment-dialogs.tsx,
// patch-form.tsx, note-form.tsx) in a DOM, with their server actions mocked (README §12): what each dialog offers for
// the booking it is given, the hidden fields it posts (the idempotency key the page rendered, `version` for `ifMatch`),
// the action's field errors on their fields, and that no input of any of them asks for a card (OADR-0018 point 8).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  issueTickets: vi.fn(),
  cancelBooking: vi.fn(),
  patchBooking: vi.fn(),
  resyncBooking: vi.fn(),
  addNote: vi.fn(),
  capturePayment: vi.fn(),
  refundPayment: vi.fn(),
}));
vi.mock("./actions", () => actions);
// The environment badge's module imports the switch's server actions; the dialogs never call them.
vi.mock("@/app/(console)/env-actions", () => ({ switchEnvironment: vi.fn(), resetEnvironment: vi.fn() }));

import { CONFIRM_STRINGS } from "@/components/confirm-dialog";
import type { ActionState } from "@/lib/action-state";

import type { CancelPlan, IssuePlan } from "./action-rules";
import { CANCEL_STRINGS, CancelDialog } from "./cancel-dialog";
import { ISSUE_STRINGS, IssueDialog } from "./issue-dialog";
import { NOTE_STRINGS, NoteForm } from "./note-form";
import { BookingEditPanel, PATCH_STRINGS, RESYNC_STRINGS, ResyncForm } from "./patch-form";
import { CaptureDialog, PAYMENT_STRINGS, RefundDialog } from "./payment-dialogs";

const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
/** Keys the page rendered (dummy UUIDs). */
const KEY = "0b6c9a1e-2f3d-4c5b-8a79-6e5d4c3b2a10";
const OTHER_KEY = "5d4c3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

/**
 * How long a step that opens a Radix dialog or runs a (fake) server action through React's action queue may take
 * before a wait gives up: quick alone, slower on a busy CI runner than Testing Library's default of one second.
 */
const UI_WAIT = { timeout: 3_000 } as const;

/** Words of a card form: none of the admin's inputs may be named, labelled or autofilled like one. */
const CARD_FIELD = /card|cvc|cvv|csc|security.?code|holder|expir|cc-(?:name|number|exp|csc|type)|\bpan\b/i;

const eur = (amount: string) => ({ amount, currency: "EUR" });

/** Opens the dialog of the trigger named `name` and returns it with its form. */
async function open(name: string | RegExp): Promise<{ dialog: HTMLElement; form: HTMLFormElement }> {
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
  const call = action.mock.calls.at(-1);
  const form = call?.[1];
  if (!(form instanceof FormData)) {
    throw new Error("the action was not called with a form");
  }
  return form;
}

/** Every control of `root` as text: its name, autocomplete, type and label. */
function controlsOf(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLInputElement>("input, select, textarea")].map((control) => {
    const labels = [...(control.labels ?? [])].map((label) => label.textContent ?? "");
    return [
      control.getAttribute("name") ?? "",
      control.getAttribute("autocomplete") ?? "",
      control.getAttribute("type") ?? control.tagName.toLowerCase(),
      control.getAttribute("placeholder") ?? "",
      ...labels,
    ].join(" | ");
  });
}

const STRIPE_CAPTURE: IssuePlan = { kind: "capture", amount: eur("1414.06") };
const AIRLINE: IssuePlan = { kind: "airline_card", flightOfferIds: ["1", "2"] };

function issueDialog(plan: IssuePlan, canAllowUnpaid = false, key = KEY) {
  return (
    <IssueDialog
      bookingId={BOOKING_ID}
      reference="VX7K2Q"
      version={3}
      environment="test"
      idempotencyKey={key}
      plan={plan}
      canAllowUnpaid={canAllowUnpaid}
    />
  );
}

function cancelDialog(plan: CancelPlan) {
  return (
    <CancelDialog
      bookingId={BOOKING_ID}
      reference="VX7K2Q"
      version={3}
      environment="test"
      idempotencyKey={KEY}
      plan={plan}
    />
  );
}

// Once per file: the first render, the first Radix dialog with its focus trap and React's first action are the slowest
// in a fresh worker; on a busy CI runner they would otherwise land in the first test's own five seconds. Nothing of it
// stays: the document is emptied and the mock forgotten.
beforeAll(async () => {
  actions.issueTickets.mockResolvedValue({ ok: true });
  render(issueDialog(STRIPE_CAPTURE));
  const { dialog, form } = await open(ISSUE_STRINGS.trigger);
  confirm(dialog, form);
  await waitFor(() => expect(actions.issueTickets).toHaveBeenCalled(), UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  for (const action of Object.values(actions)) {
    action.mockReset();
    action.mockResolvedValue({ ok: true, message: "Done." } satisfies ActionState);
  }
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("IssueDialog", () => {
  it("posts the booking, the displayed version and the key the page rendered; the next render brings its own", async () => {
    const { rerender } = render(issueDialog(STRIPE_CAPTURE));
    const { dialog, form } = await open(ISSUE_STRINGS.trigger);

    expect(within(dialog).getByText(/The authorised payment is captured first/)).toBeTruthy();
    expect(hidden(form, "bookingId")).toBe(BOOKING_ID);
    expect(hidden(form, "version")).toBe("3");
    expect(hidden(form, "actionKey")).toBe(KEY);
    confirm(dialog, form);
    await waitFor(() => expect(actions.issueTickets).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(lastForm(actions.issueTickets).get("actionKey")).toBe(KEY);
    expect(lastForm(actions.issueTickets).get("notifyCustomer")).toBe("true");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);

    // The page's render after the success gives the dialog a new key.
    rerender(issueDialog(STRIPE_CAPTURE, false, OTHER_KEY));
    const reopened = await open(ISSUE_STRINGS.trigger);
    expect(hidden(reopened.form, "actionKey")).toBe(OTHER_KEY);
  });

  it("offers an airline-card booking only the OTA's CASH or ACCOUNT settlement, and no card input", async () => {
    render(issueDialog(AIRLINE, true));
    const { dialog, form } = await open(ISSUE_STRINGS.trigger);

    expect(within(dialog).getByText(ISSUE_STRINGS.airlineCard)).toBeTruthy();
    const radios = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => [radio.name, radio.value])).toEqual([
      ["settlement", "ACCOUNT"],
      ["settlement", "CASH"],
    ]);
    expect(hidden(form, "flightOfferIds")).toBe("1,2");
    // Not even an owner gets `allowUnpaid` here: the airline card took the money.
    expect(within(dialog).queryByLabelText(ISSUE_STRINGS.allowUnpaid)).toBeNull();
    expect(controlsOf(dialog).filter((control) => CARD_FIELD.test(control))).toEqual([]);

    fireEvent.click(within(dialog).getByLabelText(/CASH/));
    confirm(dialog, form);
    await waitFor(() => expect(actions.issueTickets).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(lastForm(actions.issueTickets).get("settlement")).toBe("CASH");
  });

  it("offers allowUnpaid for an unpaid booking to an owner or an admin only", async () => {
    render(issueDialog({ kind: "unpaid" }, true));
    let { dialog } = await open(ISSUE_STRINGS.trigger);
    expect(within(dialog).getByLabelText(ISSUE_STRINGS.allowUnpaid)).toBeTruthy();
    cleanup();
    document.body.replaceChildren();

    render(issueDialog({ kind: "unpaid" }, false));
    ({ dialog } = await open(ISSUE_STRINGS.trigger));
    expect(within(dialog).queryByLabelText(ISSUE_STRINGS.allowUnpaid)).toBeNull();
    expect(within(dialog).getByText(new RegExp(ISSUE_STRINGS.unpaidRefused))).toBeTruthy();
  });

  it("shows a stale version's answer (412: reload) and an API field error on its field", async () => {
    actions.issueTickets.mockResolvedValueOnce({
      ok: false,
      code: "PRECONDITION_FAILED",
      message: "This record changed; reload to see the latest version.",
      requestId: "req_412",
    } satisfies ActionState);
    actions.issueTickets.mockResolvedValueOnce({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Some values were not accepted. Check the highlighted fields and try again.",
      fieldErrors: { settlement: "Use CASH or ACCOUNT." },
    } satisfies ActionState);
    render(issueDialog(AIRLINE));
    const { dialog, form } = await open(ISSUE_STRINGS.trigger);

    confirm(dialog, form);
    const alert = await within(dialog).findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain("This record changed; reload to see the latest version.");
    expect(alert.textContent).toContain("req_412");

    fireEvent.submit(form);
    const message = await within(dialog).findByText("Use CASH or ACCOUNT.", {}, UI_WAIT);
    const group = message.closest("fieldset");
    expect(group?.getAttribute("aria-invalid")).toBe("true");
    expect(group?.getAttribute("aria-describedby")).toContain(message.id);
    // The retry carried the same key: the API replays instead of issuing twice.
    expect(actions.issueTickets.mock.calls.map(([, sent]) => (sent as FormData).get("actionKey"))).toEqual([
      KEY,
      KEY,
    ]);
  });
});

describe("CancelDialog", () => {
  const captured: CancelPlan = {
    supplier: "void",
    money: { kind: "captured", refundable: eur("1414.06") },
    modes: ["none", "full", "amount"],
    currency: "EUR",
  };

  it("says what Amadeus and the money will do, and asks for an amount only for mode amount", async () => {
    render(cancelDialog(captured));
    const { dialog, form } = await open(CANCEL_STRINGS.trigger);

    expect(within(dialog).getByText(CANCEL_STRINGS.supplier.void)).toBeTruthy();
    const radios = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(["none", "full", "amount"]);
    expect(radios[0]?.checked).toBe(true);
    expect(within(dialog).queryByLabelText(CANCEL_STRINGS.amount("EUR"))).toBeNull();

    fireEvent.click(within(dialog).getByLabelText("Refund an amount"));
    const amount = await within(dialog).findByLabelText(CANCEL_STRINGS.amount("EUR"), {}, UI_WAIT);
    fireEvent.change(amount, { target: { value: "120.50" } });
    fireEvent.change(within(dialog).getByLabelText(CANCEL_STRINGS.reasonCode), {
      target: { value: "customer_request" },
    });
    confirm(dialog, form);
    await waitFor(() => expect(actions.cancelBooking).toHaveBeenCalledTimes(1), UI_WAIT);

    const sent = lastForm(actions.cancelBooking);
    expect(Object.fromEntries([...sent.entries()].filter(([name]) => name !== "reason"))).toEqual({
      bookingId: BOOKING_ID,
      version: "3",
      currency: "EUR",
      actionKey: KEY,
      reasonCode: "customer_request",
      refundMode: "amount",
      amount: "120.50",
      notifyCustomer: "true",
    });
  });

  it("offers an airline-card booking no refund, and release or capture for an authorisation", async () => {
    render(
      cancelDialog({
        supplier: "request_only",
        money: { kind: "airline" },
        modes: ["none"],
        currency: "EUR",
      }),
    );
    let { dialog } = await open(CANCEL_STRINGS.trigger);
    expect((within(dialog).getAllByRole("radio") as HTMLInputElement[]).map((radio) => radio.value)).toEqual([
      "none",
    ]);
    expect(within(dialog).getByText("No refund from the console")).toBeTruthy();
    expect(within(dialog).getByText(CANCEL_STRINGS.supplier.request_only)).toBeTruthy();
    cleanup();
    document.body.replaceChildren();

    render(
      cancelDialog({
        supplier: "release",
        money: { kind: "authorized", authorized: eur("500.00") },
        modes: ["full", "amount", "none"],
        currency: "EUR",
      }),
    );
    ({ dialog } = await open(CANCEL_STRINGS.trigger));
    expect((within(dialog).getAllByRole("radio") as HTMLInputElement[]).map((radio) => radio.value)).toEqual([
      "full",
      "amount",
      "none",
    ]);
    expect(within(dialog).getByText(/Release the whole authorisation/)).toBeTruthy();
  });

  it("shows the action's field error on the amount", async () => {
    actions.cancelBooking.mockResolvedValueOnce({
      ok: false,
      code: "UNPROCESSABLE",
      message: "The amount is above what can still be refunded. Reload the page to see it.",
      fieldErrors: { amount: "The amount is above what can still be refunded. Reload the page to see it." },
    } satisfies ActionState);
    render(cancelDialog(captured));
    const { dialog, form } = await open(CANCEL_STRINGS.trigger);
    fireEvent.click(within(dialog).getByLabelText("Refund an amount"));
    fireEvent.change(await within(dialog).findByLabelText(CANCEL_STRINGS.amount("EUR"), {}, UI_WAIT), {
      target: { value: "9999.00" },
    });
    confirm(dialog, form);

    await waitFor(
      () =>
        expect(within(dialog).getByLabelText(CANCEL_STRINGS.amount("EUR")).getAttribute("aria-invalid")).toBe(
          "true",
        ),
      UI_WAIT,
    );
  });
});

describe("CaptureDialog and RefundDialog", () => {
  it("post the payment, its version (capture), the currency and the key the page rendered", async () => {
    render(
      <>
        <CaptureDialog
          paymentId={PAYMENT_ID}
          bookingId={BOOKING_ID}
          environment="live"
          idempotencyKey={KEY}
          version={2}
          authorized={eur("1414.06")}
        />
        <RefundDialog
          paymentId={PAYMENT_ID}
          bookingId={BOOKING_ID}
          environment="live"
          idempotencyKey={OTHER_KEY}
          refundable={eur("100.00")}
        />
      </>,
    );

    let { dialog, form } = await open(PAYMENT_STRINGS.capture);
    expect(within(dialog).getByText(CONFIRM_STRINGS.liveWarning)).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: CONFIRM_STRINGS.liveConfirm(PAYMENT_STRINGS.capture) }),
    );
    expect([hidden(form, "paymentId"), hidden(form, "version"), hidden(form, "currency")]).toEqual([
      PAYMENT_ID,
      "2",
      "EUR",
    ]);
    expect(hidden(form, "actionKey")).toBe(KEY);
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);

    ({ dialog, form } = await open(PAYMENT_STRINGS.refund));
    expect(hidden(form, "version")).toBeUndefined();
    expect(hidden(form, "actionKey")).toBe(OTHER_KEY);
    fireEvent.change(within(dialog).getByLabelText(PAYMENT_STRINGS.refundAmount("EUR")), {
      target: { value: "40.00" },
    });
    fireEvent.change(within(dialog).getByLabelText(PAYMENT_STRINGS.refundReason), {
      target: { value: "goodwill" },
    });
    confirm(dialog, form);
    await waitFor(() => expect(actions.refundPayment).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(lastForm(actions.refundPayment).get("amount")).toBe("40.00");
    expect(lastForm(actions.refundPayment).get("refundReason")).toBe("goodwill");
    expect(lastForm(actions.refundPayment).get("actionKey")).toBe(OTHER_KEY);
  });
});

describe("BookingEditPanel and ResyncForm", () => {
  /** The stored contacts the page hands the dialogs (`kept`), as action-rules.ts `keptFieldOf` writes them. */
  const TRAVELLER_KEPT = JSON.stringify({ address: { countryCode: "SE" } });
  const CONTACT_KEPT = JSON.stringify({ companyName: "BERG AB", address: { stateName: "Stockholms lan" } });

  function panel() {
    return (
      <BookingEditPanel
        bookingId={BOOKING_ID}
        version={3}
        environment="test"
        idempotencyKeys={{ "traveler:1": KEY, "contact:STANDARD": OTHER_KEY, remark: KEY, agreement: KEY }}
        travelers={[
          {
            travelerId: "1",
            label: "ANNA BERG",
            firstName: "ANNA",
            lastName: "BERG",
            dateOfBirth: "1988-04-12",
            gender: "FEMALE",
            email: "anna.berg@example.com",
            phoneCountryCode: "46",
            phoneNumber: "701234567",
            kept: TRAVELLER_KEPT,
          },
        ]}
        contacts={[
          {
            purpose: "STANDARD",
            companyName: "BERG AB",
            email: "anna.berg@example.com",
            language: "en",
            kept: CONTACT_KEPT,
          },
        ]}
        agreement={{ option: "DELAY_TO_QUEUE", delay: "2D" }}
      />
    );
  }

  it("edits one traveller with its own hidden fields and prefilled values", async () => {
    render(panel());
    const { dialog, form } = await open(PATCH_STRINGS.editTraveler("ANNA BERG"));

    expect([hidden(form, "element"), hidden(form, "travelerId"), hidden(form, "version")]).toEqual([
      "traveler",
      "1",
      "3",
    ]);
    expect((within(dialog).getByLabelText(PATCH_STRINGS.lastName) as HTMLInputElement).value).toBe("BERG");
    fireEvent.change(within(dialog).getByLabelText(PATCH_STRINGS.lastName), {
      target: { value: "BERG-LUND" },
    });
    confirm(dialog, form);
    await waitFor(() => expect(actions.patchBooking).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(lastForm(actions.patchBooking).get("lastName")).toBe("BERG-LUND");
    expect(lastForm(actions.patchBooking).get("dateOfBirth")).toBe("1988-04-12");
    // The stored contact goes with the edit: the API replaces the traveller's contact whole.
    expect(lastForm(actions.patchBooking).get("kept")).toBe(TRAVELLER_KEPT);
  });

  it("keeps a contact's language and stored parts, prefills its company and the agreement", async () => {
    render(panel());
    let { dialog, form } = await open(PATCH_STRINGS.editContact("Standard"));
    expect([
      hidden(form, "element"),
      hidden(form, "purpose"),
      hidden(form, "language"),
      hidden(form, "kept"),
    ]).toEqual(["contact", "STANDARD", "en", CONTACT_KEPT]);
    expect((within(dialog).getByLabelText(PATCH_STRINGS.companyName) as HTMLInputElement).value).toBe(
      "BERG AB",
    );
    expect(hidden(form, "actionKey")).toBe(OTHER_KEY);
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);

    ({ dialog, form } = await open(PATCH_STRINGS.agreement));
    expect((within(dialog).getByLabelText(PATCH_STRINGS.agreementOption) as HTMLSelectElement).value).toBe(
      "DELAY_TO_QUEUE",
    );
    expect((within(dialog).getByLabelText(PATCH_STRINGS.agreementDelay) as HTMLInputElement).value).toBe(
      "2D",
    );
  });

  it("lists the changes a resync applied", async () => {
    actions.resyncBooking.mockResolvedValueOnce({
      ok: true,
      message: "Synchronised with Amadeus: 1 change.",
      changes: [{ path: "/status", label: "Status", before: "confirmed", after: "ticketed" }],
    });
    render(<ResyncForm bookingId={BOOKING_ID} />);

    fireEvent.click(screen.getByRole("button", { name: RESYNC_STRINGS.button }));

    const list = await screen.findByRole("list", { name: RESYNC_STRINGS.changes }, UI_WAIT);
    expect(list.textContent).toBe("Status: confirmed → ticketed");
    expect(lastForm(actions.resyncBooking).get("bookingId")).toBe(BOOKING_ID);
  });
});

describe("NoteForm", () => {
  it("posts the key the page rendered, internal unless ticked, and empties the text after a success", async () => {
    render(<NoteForm bookingId={BOOKING_ID} idempotencyKey={KEY} />);
    const text = screen.getByLabelText(NOTE_STRINGS.label) as HTMLTextAreaElement;

    fireEvent.submit(text.closest("form") as HTMLFormElement);
    expect(await screen.findByText(NOTE_STRINGS.required, {}, UI_WAIT)).toBeTruthy();
    expect(actions.addNote).not.toHaveBeenCalled();

    fireEvent.change(text, { target: { value: "Called the traveller." } });
    fireEvent.click(screen.getByRole("button", { name: NOTE_STRINGS.submit }));
    await waitFor(() => expect(actions.addNote).toHaveBeenCalledTimes(1), UI_WAIT);
    const sent = lastForm(actions.addNote);
    expect([
      sent.get("bookingId"),
      sent.get("actionKey"),
      sent.get("text"),
      sent.get("visibleToCustomer"),
    ]).toEqual([BOOKING_ID, KEY, "Called the traveller.", null]);
    await waitFor(() => expect(text.value).toBe(""), UI_WAIT);
  });

  it("[FIX-W31-OTA AC2] sends the new key the action hands back after a final refusal, and keeps the key after a transient failure", async () => {
    actions.addNote
      .mockResolvedValueOnce({
        ok: false,
        code: "BOOKING_NOT_MODIFIABLE",
        message: "A cancellation of this booking is still being decided.",
        nextActionKey: OTHER_KEY,
      } satisfies ActionState)
      .mockResolvedValueOnce({
        ok: false,
        code: "SERVICE_UNAVAILABLE",
        message: "The OTA API is unavailable right now.",
      } satisfies ActionState);
    render(<NoteForm bookingId={BOOKING_ID} idempotencyKey={KEY} />);
    const text = screen.getByLabelText(NOTE_STRINGS.label) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "Called the traveller." } });
    const submit = screen.getByRole("button", { name: NOTE_STRINGS.submit });

    fireEvent.click(submit);
    await screen.findByText("A cancellation of this booking is still being decided.", {}, UI_WAIT);
    fireEvent.click(submit);
    await screen.findByText("The OTA API is unavailable right now.", {}, UI_WAIT);
    fireEvent.click(submit);
    await waitFor(() => expect(actions.addNote).toHaveBeenCalledTimes(3), UI_WAIT);

    expect(actions.addNote.mock.calls.map((call) => (call[1] as FormData).get("actionKey"))).toEqual([
      KEY,
      OTHER_KEY,
      OTHER_KEY,
    ]);
  });
});

describe("no card input", () => {
  it("no dialog or form of a booking's actions has a field named, labelled or autofilled like a card's", async () => {
    render(
      <>
        {issueDialog(AIRLINE, true)}
        {cancelDialog({
          supplier: "release",
          money: { kind: "captured", refundable: eur("10.00") },
          modes: ["none", "full", "amount"],
          currency: "EUR",
        })}
        <CaptureDialog
          paymentId={PAYMENT_ID}
          bookingId={BOOKING_ID}
          environment="test"
          idempotencyKey={KEY}
          version={2}
          authorized={eur("10.00")}
        />
        <RefundDialog
          paymentId={PAYMENT_ID}
          bookingId={BOOKING_ID}
          environment="test"
          idempotencyKey={KEY}
          refundable={eur("10.00")}
        />
        <BookingEditPanel
          bookingId={BOOKING_ID}
          version={3}
          environment="test"
          idempotencyKeys={{}}
          travelers={[{ travelerId: "1", label: "ANNA BERG", firstName: "ANNA", lastName: "BERG" }]}
          contacts={[{ purpose: "STANDARD" }]}
          agreement={{}}
        />
        <NoteForm bookingId={BOOKING_ID} idempotencyKey={KEY} />
        <ResyncForm bookingId={BOOKING_ID} />
      </>,
    );
    const triggers = [
      ISSUE_STRINGS.trigger,
      CANCEL_STRINGS.trigger,
      PAYMENT_STRINGS.capture,
      PAYMENT_STRINGS.refund,
      PATCH_STRINGS.editTraveler("ANNA BERG"),
      PATCH_STRINGS.editContact("Standard"),
      PATCH_STRINGS.addRemark,
      PATCH_STRINGS.agreement,
    ];
    const seen: string[] = controlsOf(document.body);
    for (const trigger of triggers) {
      const { dialog } = await open(trigger);
      // The cancel dialog's amount appears with its mode.
      const amountMode = within(dialog).queryByLabelText("Refund an amount");
      if (amountMode !== null) {
        fireEvent.click(amountMode);
        await within(dialog).findByLabelText(CANCEL_STRINGS.amount("EUR"), {}, UI_WAIT);
      }
      seen.push(...controlsOf(dialog));
      fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_STRINGS.cancel }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    }

    // Every dialog had inputs (the reason at least), and none of them is a card's.
    expect(seen.length).toBeGreaterThan(triggers.length * 2);
    expect(seen.filter((control) => CARD_FIELD.test(control))).toEqual([]);
  });
});
