// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The environment badge's module imports the switch's server actions; the dialog never calls them.
vi.mock("@/app/(console)/env-actions", () => ({
  switchEnvironment: vi.fn(),
  resetEnvironment: vi.fn(),
}));

import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/action-state";
import { ERROR_MESSAGES } from "@/lib/errors";

import {
  ACTION_KEY_FIELD,
  CONFIRM_STRINGS,
  ConfirmDialog,
  REASON_FIELD,
  reasonLength,
  reasonProblem,
  SCROLLING_DIALOG_CLASS,
  type ConfirmAction,
} from "./confirm-dialog";

/** The key the page rendered once for this dialog (a dummy UUID). */
const KEY = "8f1d2c3b-4a5e-4f60-9a7b-1c2d3e4f5a6b";
/** Keys a server action hands back after a final refusal, and the key of the page's next render (dummy UUIDs). */
const NEXT_KEY = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const LATER_KEY = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const RENDERED_AGAIN_KEY = "4c5d6e7f-8a9b-4c0d-a1e2-f3a4b5c6d7e8";
const BOOKING_ID = "bkg_01JBT7A1B2C3D4E5F6G7H8J9K0";

/**
 * How long a step that opens the Radix dialog or runs the (fake) server action through React's action queue may take
 * before a wait gives up: quick alone, slower on a busy CI runner than Testing Library's default of one second.
 */
const UI_WAIT = { timeout: 3_000 } as const;

/** What the fake action received: the form fields of each submission. */
interface Submission {
  readonly key: FormDataEntryValue | null;
  readonly reason: FormDataEntryValue | null;
  readonly bookingId: FormDataEntryValue | null;
  readonly version: FormDataEntryValue | null;
}

function dialogOf(action: ConfirmAction, environment: "test" | "live" = "test", key: string = KEY) {
  return (
    <ConfirmDialog
      trigger={<Button>Issue tickets</Button>}
      title="Issue the tickets of VX-7K2M9Q?"
      summary={<p>Captures EUR 412.50 and issues 2 tickets.</p>}
      confirmLabel="Issue tickets"
      environment={environment}
      action={action}
      idempotencyKey={key}
      fields={{ bookingId: BOOKING_ID, version: "7" }}
    />
  );
}

function renderDialog(action: ConfirmAction, environment: "test" | "live" = "test") {
  return render(dialogOf(action, environment));
}

/** Opens the dialog and returns it with its reason field and its form. */
async function open(): Promise<{ dialog: HTMLElement; reason: HTMLElement; form: HTMLFormElement }> {
  fireEvent.click(screen.getByRole("button", { name: "Issue tickets" }));
  const dialog = await screen.findByRole("dialog", { name: /Issue the tickets of VX-7K2M9Q\?/ }, UI_WAIT);
  const reason = within(dialog).getByLabelText(CONFIRM_STRINGS.reasonLabel);
  const form = reason.closest("form");
  if (form === null) {
    throw new Error("the reason is not in a form");
  }
  return { dialog, reason, form };
}

/** A fake server action that records each submission and answers `answer`. */
function recordingAction(answer: (call: number) => ActionState | Promise<ActionState>) {
  const submissions: Submission[] = [];
  const action = vi.fn(async (_state: ActionState, formData: FormData) => {
    submissions.push({
      key: formData.get(ACTION_KEY_FIELD),
      reason: formData.get(REASON_FIELD),
      bookingId: formData.get("bookingId"),
      version: formData.get("version"),
    });
    return answer(submissions.length);
  });
  return { action, submissions };
}

/** The ids `aria-describedby` of `element` points at, as their texts. */
function descriptionsOf(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? "");
}

// Once per file: the first render, the first Radix dialog with its focus trap and React's first action are the slowest
// in a fresh worker, and on a busy CI runner they would otherwise land in the first test's own five seconds. Nothing of
// it stays: the document is emptied.
beforeAll(async () => {
  const { action } = recordingAction(() => ({ ok: true }));
  renderDialog(action);
  const { reason, form } = await open();
  fireEvent.change(reason, { target: { value: "Warm-up reason" } });
  fireEvent.submit(form);
  await waitFor(() => expect(action).toHaveBeenCalled(), UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("reason rules", () => {
  it("needs 3 to 500 characters after trimming, counted in code points", () => {
    expect(reasonProblem("")).toBe(CONFIRM_STRINGS.reasonRequired);
    expect(reasonProblem("   \n ")).toBe(CONFIRM_STRINGS.reasonRequired);
    expect(reasonProblem(" ab ")).toBe(CONFIRM_STRINGS.reasonTooShort(3));
    expect(reasonProblem("abc")).toBeUndefined();
    expect(reasonProblem("x".repeat(501))).toBe(CONFIRM_STRINGS.reasonTooLong(500));
    expect(reasonLength(" 🛫🛬✈ ")).toBe(3);
    expect(reasonProblem("abcd", 5)).toBe(CONFIRM_STRINGS.reasonTooShort(5));
  });
});

describe("ConfirmDialog", () => {
  it("[OAD-004 AC2] cannot be submitted without a reason", async () => {
    const { action } = recordingAction(() => ({ ok: true }));
    renderDialog(action);
    const { dialog, reason, form } = await open();

    fireEvent.click(within(dialog).getByRole("button", { name: "Issue tickets" }));
    expect(action).not.toHaveBeenCalled();
    expect(reason.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionsOf(reason)).toEqual([CONFIRM_STRINGS.reasonHint, CONFIRM_STRINGS.reasonRequired]);
    expect(document.activeElement).toBe(reason);

    // White space is no reason, and a too short one is refused too.
    fireEvent.change(reason, { target: { value: "    " } });
    fireEvent.submit(form);
    fireEvent.change(reason, { target: { value: "ok" } });
    fireEvent.submit(form);
    expect(action).not.toHaveBeenCalled();
    expect(descriptionsOf(reason)).toContain(CONFIRM_STRINGS.reasonTooShort(3));
    expect(screen.getByRole("dialog")).toBe(dialog);

    fireEvent.change(reason, { target: { value: "Customer confirmed by phone" } });
    expect(reason.getAttribute("aria-invalid")).toBeNull();
    fireEvent.submit(form);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1), UI_WAIT);
  });

  it("[OAD-004 AC2] keeps the same idempotency key on a double submit", async () => {
    let releaseFirst: (state: ActionState) => void = () => undefined;
    const first = new Promise<ActionState>((resolve) => {
      releaseFirst = resolve;
    });
    const { action, submissions } = recordingAction((call) => (call === 1 ? first : { ok: true }));
    renderDialog(action);
    const { dialog, reason, form } = await open();
    // The key is a hidden input, never shown.
    expect(form.querySelectorAll(`input[name="${ACTION_KEY_FIELD}"]`)).toHaveLength(1);
    expect(
      form.querySelector(`input[type="hidden"][name="${ACTION_KEY_FIELD}"]`)?.getAttribute("value"),
    ).toBe(KEY);
    expect(dialog.textContent).not.toContain(KEY);

    fireEvent.change(reason, { target: { value: "  Customer confirmed by phone  " } });
    // Two submissions before the first answer: a double click, or Enter pressed twice.
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1), UI_WAIT);
    // While the first runs, the confirming button is disabled.
    expect(
      (within(dialog).getByRole("button", { name: "Issue tickets" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    releaseFirst({ ok: false, code: "TIMEOUT", message: "The OTA API did not answer in time." });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2), UI_WAIT);

    expect(submissions).toEqual([
      { key: KEY, reason: "Customer confirmed by phone", bookingId: BOOKING_ID, version: "7" },
      { key: KEY, reason: "Customer confirmed by phone", bookingId: BOOKING_ID, version: "7" },
    ]);
  });

  it("[OAD-004 AC2] stays open after a failure with the message and request id, and retries with the same key", async () => {
    const { action, submissions } = recordingAction((call) =>
      call === 1
        ? {
            ok: false,
            code: "TIMEOUT",
            message: "The OTA API did not answer in time. Check the result before you try again.",
            requestId: "req_01JBT9",
          }
        : { ok: true, message: "Tickets issued" },
    );
    renderDialog(action);
    const { dialog, reason, form } = await open();
    fireEvent.change(reason, { target: { value: "Customer confirmed by phone" } });

    fireEvent.submit(form);
    const alert = await within(dialog).findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain("The OTA API did not answer in time.");
    expect(alert.textContent).toContain(CONFIRM_STRINGS.requestId("req_01JBT9"));
    expect(screen.getByRole("dialog")).toBe(dialog);

    fireEvent.submit(form);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    expect(submissions.map((submission) => submission.key)).toEqual([KEY, KEY]);
    expect(screen.getByRole("status").textContent).toBe("Tickets issued");
  });

  it("shows a field error of the API on the reason", async () => {
    const { action } = recordingAction(() => ({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Some values were not accepted.",
      fieldErrors: { reason: "Too long." },
    }));
    renderDialog(action);
    const { reason, form } = await open();
    fireEvent.change(reason, { target: { value: "Customer confirmed by phone" } });

    fireEvent.submit(form);

    await waitFor(() => expect(reason.getAttribute("aria-invalid")).toBe("true"), UI_WAIT);
    expect(descriptionsOf(reason)).toEqual([CONFIRM_STRINGS.reasonHint, "Too long."]);
  });

  it("repeats LIVE in the live environment: badge, warning and the confirming button", async () => {
    const { action } = recordingAction(() => ({ ok: true }));
    renderDialog(action, "live");
    const { dialog } = await open();

    expect(
      within(dialog).getByText("LIVE").closest("[data-environment]")?.getAttribute("data-environment"),
    ).toBe("live");
    expect(within(dialog).getByRole("note").textContent).toBe(CONFIRM_STRINGS.liveWarning);
    expect(within(dialog).getByRole("button", { name: "Issue tickets in LIVE" })).toBeTruthy();
  });

  it("[OAD-016 AC1] keeps a dialog taller than the window inside it, scrolling, so its title and buttons stay reachable", async () => {
    const { action } = recordingAction(() => ({ ok: true }));
    renderDialog(action);
    const { dialog } = await open();
    expect(dialog.className.split(" ")).toEqual(expect.arrayContaining(SCROLLING_DIALOG_CLASS.split(" ")));
    expect(SCROLLING_DIALOG_CLASS).toBe("max-h-[calc(100dvh-2rem)] overflow-y-auto");
  });

  it("shows TEST and no live warning in the test environment", async () => {
    const { action } = recordingAction(() => ({ ok: true }));
    renderDialog(action);
    const { dialog } = await open();

    expect(within(dialog).getByText("TEST")).toBeTruthy();
    expect(within(dialog).queryByRole("note")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Issue tickets" })).toBeTruthy();
  });

  it("starts with an empty reason and no old message after it was closed", async () => {
    const { action } = recordingAction(() => ({ ok: false, message: "This record changed." }));
    renderDialog(action);
    const first = await open();
    fireEvent.change(first.reason, { target: { value: "Customer confirmed by phone" } });
    fireEvent.submit(first.form);
    await within(first.dialog).findByRole("alert", {}, UI_WAIT);

    fireEvent.click(within(first.dialog).getByRole("button", { name: CONFIRM_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    const second = await open();

    expect((second.reason as HTMLTextAreaElement).value).toBe("");
    expect(within(second.dialog).queryByRole("alert")).toBeNull();
  });

  it("[FIX-W31-OTA AC2] sends the new key an action's state brings after a final refusal, keeps a key when none comes, and takes the next render's key", async () => {
    const { action, submissions } = recordingAction((call) => {
      switch (call) {
        case 1:
          // A 422 the API keeps under the key: the action hands back a new one.
          return {
            ok: false,
            code: "UNPROCESSABLE",
            message: "The amount is above what can still be refunded.",
            nextActionKey: NEXT_KEY,
          };
        case 2:
          // A 503: nothing is kept under the key, the retry sends it again.
          return { ok: false, code: "SERVICE_UNAVAILABLE", message: "The OTA API is unavailable right now." };
        case 3:
          // Another final refusal the API keeps under the key: another new one. (Before the revision of 2026-10-28 this
          // was 409 IDEMPOTENCY_KEY_REUSED, which now brings no new key: FIX-W32-OTA AC3 below.)
          return {
            ok: false,
            code: "BOOKING_NOT_MODIFIABLE",
            message: "Changed meanwhile.",
            nextActionKey: LATER_KEY,
          };
        default:
          return { ok: true, message: "Tickets issued" };
      }
    });
    const rendered = render(dialogOf(action));
    const { dialog, reason, form } = await open();
    const hiddenKey = () =>
      form.querySelector(`input[type="hidden"][name="${ACTION_KEY_FIELD}"]`)?.getAttribute("value");
    fireEvent.change(reason, { target: { value: "Customer confirmed by phone" } });

    fireEvent.submit(form);
    await waitFor(() => expect(hiddenKey()).toBe(NEXT_KEY), UI_WAIT);
    expect(within(dialog).getByRole("alert").textContent).toContain("above what can still be refunded");
    fireEvent.submit(form);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2), UI_WAIT);
    await within(dialog).findByText("The OTA API is unavailable right now.", {}, UI_WAIT);
    expect(hiddenKey()).toBe(NEXT_KEY);

    // Closed and opened again, the dialog goes on with the key it was last given.
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    const reopened = await open();
    expect(
      reopened.form.querySelector(`input[type="hidden"][name="${ACTION_KEY_FIELD}"]`)?.getAttribute("value"),
    ).toBe(NEXT_KEY);
    const reopenedKey = () =>
      reopened.form.querySelector(`input[type="hidden"][name="${ACTION_KEY_FIELD}"]`)?.getAttribute("value");
    fireEvent.change(reopened.reason, { target: { value: "Customer confirmed by phone" } });
    fireEvent.submit(reopened.form);
    // The third answer's state is rendered (its new key in the form) before the next submission, as a person who reads
    // the refusal first would send it; the button is disabled while the action runs.
    await waitFor(() => expect(reopenedKey()).toBe(LATER_KEY), UI_WAIT);
    expect(action).toHaveBeenCalledTimes(3);
    fireEvent.submit(reopened.form);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    expect(submissions.map((submission) => submission.key)).toEqual([KEY, NEXT_KEY, NEXT_KEY, LATER_KEY]);

    // The success revalidated the page: its new render brings a new key, which the next action sends.
    rendered.rerender(dialogOf(action, "test", RENDERED_AGAIN_KEY));
    const next = await open();
    fireEvent.change(next.reason, { target: { value: "Second issuance attempt" } });
    fireEvent.submit(next.form);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(5), UI_WAIT);
    expect(submissions.at(-1)?.key).toBe(RENDERED_AGAIN_KEY);
  });

  it("[FIX-W32-OTA AC3] keeps its key after 409 IDEMPOTENCY_KEY_REUSED and tells staff to reload the page", async () => {
    const message = ERROR_MESSAGES.IDEMPOTENCY_KEY_REUSED ?? "";
    // The action's state of the refusal: the reload message and no new key (lib/action-state.ts `keepsActionKey`).
    const { action, submissions } = recordingAction(() => ({
      ok: false,
      code: "IDEMPOTENCY_KEY_REUSED",
      message,
      requestId: "req_reused",
    }));
    render(dialogOf(action));
    const { dialog, reason, form } = await open();
    fireEvent.change(reason, { target: { value: "Customer confirmed by phone" } });

    fireEvent.submit(form);
    const alert = await within(dialog).findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain("may still be running");
    expect(alert.textContent).toContain("Reload the page");
    expect(
      form.querySelector(`input[type="hidden"][name="${ACTION_KEY_FIELD}"]`)?.getAttribute("value"),
    ).toBe(KEY);
    fireEvent.submit(form);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2), UI_WAIT);
    // Never a new key: only the page's next render (the reload) brings one.
    expect(submissions.map((submission) => submission.key)).toEqual([KEY, KEY]);
  });
});
