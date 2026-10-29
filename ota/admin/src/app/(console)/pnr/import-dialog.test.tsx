// @vitest-environment happy-dom
// The import dialog of the PNR lookup (OAD-009: import-dialog.tsx) in a DOM, with its server actions mocked (README
// §12): the hidden fields and the rendered idempotency key it posts, the pricing modes (a selling total for an
// override only, in the order's currency), the customer search, the existing booking it links after `409
// ORDER_ALREADY_IMPORTED`, the new booking it opens after a success (or links, with the API's warnings), and that no
// input asks for a card.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ importBooking: vi.fn(), searchCustomers: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
vi.mock("./actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// The environment badge's module imports the switch's server actions; the dialog never calls them.
vi.mock("@/app/(console)/env-actions", () => ({ switchEnvironment: vi.fn(), resetEnvironment: vi.fn() }));

import { CONFIRM_STRINGS } from "@/components/confirm-dialog";
import type { ActionState } from "@/lib/action-state";

import { IMPORT_STRINGS, ImportDialog } from "./import-dialog";
import type { CustomerSearchState, ImportState } from "./import-rules";

const FLIGHT_ORDER_ID = "eJzTd9cPNfX09DUFAAsGAkT";
const NEW_BOOKING_ID = "bkg_01JA4H9Z1B3D5F7H9K1M3P5R7V";
const EXISTING_BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const CUSTOMER_ID = "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
/** The key the page rendered (a dummy UUID). */
const KEY = "0b6c9a1e-2f3d-4c5b-8a79-6e5d4c3b2a10";

/**
 * How long a step that opens a Radix dialog or runs a (fake) server action through React's action queue may take
 * before a wait gives up: quick alone, slower on a busy CI runner than Testing Library's default of one second.
 */
const UI_WAIT = { timeout: 3_000 } as const;

/** Words of a card form: none of the admin's inputs may be named, labelled or autofilled like one. */
const CARD_FIELD = /card|cvc|cvv|csc|security.?code|holder|expir|cc-(?:name|number|exp|csc|type)|\bpan\b/i;

function dialog(overrides: { currency?: string | null; canSearchCustomers?: boolean } = {}) {
  return (
    <ImportDialog
      reference="L2P9XC"
      flightOrderId={FLIGHT_ORDER_ID}
      currency={overrides.currency === undefined ? "EUR" : overrides.currency}
      net={{ amount: "142.30", currency: "EUR" }}
      environment="test"
      idempotencyKey={KEY}
      canSearchCustomers={overrides.canSearchCustomers ?? true}
    />
  );
}

/** Opens the dialog and returns it with its form. */
async function open(): Promise<{ dialog: HTMLElement; form: HTMLFormElement }> {
  fireEvent.click(screen.getByRole("button", { name: IMPORT_STRINGS.trigger }));
  const opened = await screen.findByRole("dialog", {}, UI_WAIT);
  const form = opened.querySelector("form");
  if (form === null) {
    throw new Error("the dialog has no form");
  }
  return { dialog: opened, form };
}

/** The value of a hidden field of a form. */
function hidden(form: HTMLFormElement, name: string): string | undefined {
  return form.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)?.value;
}

/** Types a reason and submits the dialog's form. */
function confirm(opened: HTMLElement, form: HTMLFormElement): void {
  fireEvent.change(within(opened).getByLabelText(CONFIRM_STRINGS.reasonLabel), {
    target: { value: "Terminal booking made by phone" },
  });
  fireEvent.submit(form);
}

/** What the import action received on its last call. */
function lastForm(): FormData {
  const form = actions.importBooking.mock.calls.at(-1)?.[1];
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

const imported = (overrides: Partial<ImportState> = {}): ImportState => ({
  ok: true,
  message: "Imported as booking VX8M2Q.",
  booking: { id: NEW_BOOKING_ID, reference: "VX8M2Q" },
  ...overrides,
});

// Once per file: the first render, the first Radix dialog with its focus trap and React's first action are the slowest
// in a fresh worker; on a busy CI runner they would otherwise land in the first test's own five seconds. Nothing of it
// stays: the document is emptied and the mocks forgotten.
beforeAll(async () => {
  actions.importBooking.mockResolvedValue({ ok: false, message: "Warm-up." } satisfies ActionState);
  render(dialog());
  const { dialog: opened, form } = await open();
  confirm(opened, form);
  await waitFor(() => expect(actions.importBooking).toHaveBeenCalled(), UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  actions.importBooking.mockReset();
  actions.importBooking.mockResolvedValue(imported());
  actions.searchCustomers.mockReset();
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("ImportDialog", () => {
  it("[OAD-009 AC1] posts the match's order, the rendered key and the OTA's markup rules by default, then opens the new booking", async () => {
    render(dialog());
    const { dialog: opened, form } = await open();

    expect(within(opened).getByRole("heading", { name: "Import L2P9XC as a booking?" })).toBeTruthy();
    expect(opened.textContent).toContain("Net price of the order: €142.30.");
    expect(hidden(form, "reference")).toBe("L2P9XC");
    expect(hidden(form, "flightOrderId")).toBe(FLIGHT_ORDER_ID);
    expect(hidden(form, "currency")).toBe("EUR");
    expect(hidden(form, "actionKey")).toBe(KEY);
    const modes = within(opened)
      .getAllByRole("radio")
      .filter((radio) => radio.getAttribute("name") === "pricingMode");
    expect(
      modes.map((radio) => [(radio as HTMLInputElement).value, (radio as HTMLInputElement).checked]),
    ).toEqual([
      ["markup_rules", true],
      ["net", false],
      ["override", false],
    ]);
    // A selling total only for an override.
    expect(within(opened).queryByLabelText("Selling total (EUR)")).toBeNull();

    confirm(opened, form);

    await waitFor(() => expect(actions.importBooking).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(lastForm().get("pricingMode")).toBe("markup_rules");
    expect(lastForm().get("actionKey")).toBe(KEY);
    expect(lastForm().get("customerId")).toBe("");
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/bookings/${NEW_BOOKING_ID}`), UI_WAIT);
  });

  it("[OAD-009 AC1] posts an override with the selling total it asks for, and the net mode without one", async () => {
    render(dialog());
    const { dialog: opened, form } = await open();

    fireEvent.click(within(opened).getByLabelText("A selling total of my own"));
    const total = await within(opened).findByLabelText("Selling total (EUR)", {}, UI_WAIT);
    fireEvent.change(total, { target: { value: "1450.00" } });
    confirm(opened, form);
    await waitFor(() => expect(actions.importBooking).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(lastForm().get("pricingMode")).toBe("override");
    expect(lastForm().get("sellingTotal")).toBe("1450.00");
    expect(lastForm().get("currency")).toBe("EUR");

    cleanup();
    document.body.replaceChildren();
    render(dialog());
    const second = await open();
    fireEvent.click(within(second.dialog).getByLabelText("The net price"));
    confirm(second.dialog, second.form);
    await waitFor(() => expect(actions.importBooking).toHaveBeenCalledTimes(2), UI_WAIT);
    expect(lastForm().get("pricingMode")).toBe("net");
    expect(lastForm().get("sellingTotal")).toBeNull();
  });

  it("[OAD-009 AC1] a second import links the existing booking that the API names (409 ORDER_ALREADY_IMPORTED)", async () => {
    actions.importBooking.mockResolvedValueOnce({
      ok: false,
      code: "ORDER_ALREADY_IMPORTED",
      message: "This order is already booking VX7K2Q.",
      requestId: "req_409",
      booking: { id: EXISTING_BOOKING_ID, reference: "VX7K2Q" },
      nextActionKey: "5d4c3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
    } satisfies ImportState);
    render(dialog());
    const { dialog: opened, form } = await open();

    confirm(opened, form);

    const link = await within(opened).findByRole("link", { name: "Open booking VX7K2Q" }, UI_WAIT);
    expect(link.getAttribute("href")).toBe(`/bookings/${EXISTING_BOOKING_ID}`);
    expect(within(opened).getByRole("alert").textContent).toContain("This order is already booking VX7K2Q.");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("stays after a success with the API's warnings and links the new booking", async () => {
    actions.importBooking.mockResolvedValueOnce(
      imported({
        message: "Imported as booking VX8M2Q. Tell the traveller yourself.",
        warnings: ["Tell the traveller yourself."],
      }),
    );
    render(dialog());
    const { dialog: opened, form } = await open();

    confirm(opened, form);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    expect(screen.getByRole("status").textContent).toBe(
      "Imported as booking VX8M2Q. Tell the traveller yourself.",
    );
    expect(screen.getByRole("link", { name: "Open booking VX8M2Q" }).getAttribute("href")).toBe(
      `/bookings/${NEW_BOOKING_ID}`,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("finds a customer and posts the one chosen; Enter in the search never sends the import", async () => {
    actions.searchCustomers.mockResolvedValue({
      ok: true,
      customers: [{ id: CUSTOMER_ID, email: "claire.moreau@example.com", name: "Claire Moreau" }],
    } satisfies CustomerSearchState);
    render(dialog());
    const { dialog: opened, form } = await open();

    const search = within(opened).getByLabelText(IMPORT_STRINGS.customerSearch);
    fireEvent.change(search, { target: { value: "claire" } });
    fireEvent.keyDown(search, { key: "Enter" });
    const choice = await within(opened).findByLabelText(
      "Claire Moreau (claire.moreau@example.com)",
      {},
      UI_WAIT,
    );
    expect(actions.searchCustomers).toHaveBeenCalledWith("claire");
    expect(actions.importBooking).not.toHaveBeenCalled();
    fireEvent.click(choice);

    confirm(opened, form);
    await waitFor(() => expect(actions.importBooking).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(lastForm().get("customerId")).toBe(CUSTOMER_ID);
    // The search text is never posted.
    expect([...lastForm().values()]).not.toContain("claire");
  });

  it("shows the action's field errors on their fields, offers no override without the order's currency and no customer search without customers:read", async () => {
    actions.importBooking.mockResolvedValueOnce({
      ok: false,
      code: "UNPROCESSABLE",
      message: "The order has no e-mail address: enter the booking's contact e-mail.",
      fieldErrors: { contactEmail: "The order has no e-mail address: enter the booking's contact e-mail." },
    } satisfies ActionState);
    render(dialog({ currency: null, canSearchCustomers: false }));
    const { dialog: opened, form } = await open();

    expect(within(opened).queryByLabelText("A selling total of my own")).toBeNull();
    expect(within(opened).queryByLabelText(IMPORT_STRINGS.customerSearch)).toBeNull();
    expect(hidden(form, "currency")).toBeUndefined();
    confirm(opened, form);

    const email = within(opened).getByLabelText(IMPORT_STRINGS.contactEmail);
    await waitFor(() => expect(email.getAttribute("aria-invalid")).toBe("true"), UI_WAIT);
    expect(email.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("asks for no card: no input is named, labelled or autofilled like a card's", async () => {
    render(dialog());
    const { dialog: opened } = await open();
    fireEvent.click(within(opened).getByLabelText("A selling total of my own"));
    await within(opened).findByLabelText("Selling total (EUR)", {}, UI_WAIT);

    expect(controlsOf(opened).filter((control) => CARD_FIELD.test(control))).toEqual([]);
    // This dialog's own inputs (the reason is ConfirmDialog's) offer nothing a browser saved either.
    const own = opened.querySelectorAll(
      "input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea:not([name=reason])",
    );
    expect(own.length).toBeGreaterThan(0);
    for (const control of own) {
      expect(control.getAttribute("autocomplete"), control.getAttribute("name") ?? "").toBe("off");
    }
  });
});
