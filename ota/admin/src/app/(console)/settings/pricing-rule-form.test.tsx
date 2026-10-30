// @vitest-environment happy-dom
// The shared form of the markup and fee rules and their delete dialog (OAD-013: pricing-rule-form.tsx) in a DOM, with
// the server actions mocked (README §12): the fields a calculation uses, the field errors on their fields, the API's
// warnings after a save, the new rule opened after a create (or linked, with its warnings), the rendered idempotency
// key and the new one a final refusal brings, and the delete dialog, which asks no reason (the contract's `DELETE`
// takes none) and posts the rule and its version.
import type { MarkupRule } from "@velexis/ota-sdk";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  createMarkupRule: vi.fn(),
  updateMarkupRule: vi.fn(),
  deleteMarkupRule: vi.fn(),
  createFeeRule: vi.fn(),
  updateFeeRule: vi.fn(),
  deleteFeeRule: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
vi.mock("./pricing-actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// The environment badge's module imports the switch's server actions; the dialogs never call them.
vi.mock("@/app/(console)/env-actions", () => ({ switchEnvironment: vi.fn(), resetEnvironment: vi.fn() }));
// The booking page's field components come with that page's server actions, which these tests never call.
vi.mock("@/app/(console)/bookings/[bookingId]/actions", () => ({}));

import { CONFIRM_STRINGS } from "@/components/confirm-dialog";
import type { ActionState } from "@/lib/action-state";

import { DeleteRuleDialog, PricingRuleForm } from "./pricing-rule-form";

const MARKUP_ID = "mkr_01JA4H9Z1B3D5F7H9K1M3P5R7V";
/** The key the page rendered, and the one an action hands back after a final refusal (dummy UUIDs). */
const KEY = "0b6c9a1e-2f3d-4c5b-8a79-6e5d4c3b2a10";
const NEXT_KEY = "7d1e2f3a-4b5c-4d6e-8f70-1a2b3c4d5e6f";

/** How long a step that runs a (fake) server action through React's action queue or opens a dialog may take. */
const UI_WAIT = { timeout: 3_000 } as const;

const RULE: MarkupRule = {
  id: MARKUP_ID,
  name: "Long-haul economy",
  description: null,
  scope: { originCountries: ["FR"] },
  calculation: "percentage",
  percentage: "4.0000",
  fixed: null,
  appliesPer: "traveler",
  min: null,
  max: null,
  priority: 100,
  stackable: false,
  isDefault: false,
  isActive: true,
  activeFrom: null,
  activeUntil: null,
  version: 7,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
};

/** What a mocked action received: the fields of each submission. */
function submissions(action: ReturnType<typeof vi.fn>): FormData[] {
  return action.mock.calls.map((call) => call[1] as FormData);
}

/** The wrapper (`hidden` while the calculation does not use it) of the input named `name`. */
function wrapperOf(name: string): HTMLElement {
  const wrapper = document.querySelector(`input[name="${name}"]`)?.parentElement?.parentElement;
  if (wrapper === null || wrapper === undefined) {
    throw new Error(`no wrapper for ${name}`);
  }
  return wrapper;
}

// Once per file: the first render of the form and of a Radix dialog, and the first action through React's action
// queue, are the slowest in a fresh worker; on a busy CI runner they would otherwise land in the first test's own five
// seconds.
beforeAll(async () => {
  actions.updateMarkupRule.mockResolvedValue({ ok: false, message: "Warm-up." } satisfies ActionState);
  render(
    <PricingRuleForm kind="markup" mode="edit" rule={RULE} timeZone="Europe/Oslo" defaultCurrency="EUR" />,
  );
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(actions.updateMarkupRule).toHaveBeenCalled(), UI_WAIT);
  cleanup();
  render(
    <DeleteRuleDialog
      kind="markup"
      ruleId={MARKUP_ID}
      ruleName="Warm-up"
      version={1}
      environment="test"
      idempotencyKey={KEY}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
  await screen.findByRole("dialog", {}, UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  for (const action of Object.values(actions)) {
    action.mockReset();
  }
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("PricingRuleForm", () => {
  it("offers the percentage or the fixed amount as the calculation uses them, keeping what was typed", () => {
    render(
      <PricingRuleForm
        kind="markup"
        mode="create"
        idempotencyKey={KEY}
        timeZone="Europe/Oslo"
        defaultCurrency="EUR"
      />,
    );

    expect(wrapperOf("percentage").hidden).toBe(false);
    expect(wrapperOf("fixed.amount").hidden).toBe(true);

    fireEvent.change(screen.getByLabelText("Percentage"), { target: { value: "4.5" } });
    fireEvent.click(screen.getByLabelText("Fixed amount", { selector: '[type="radio"]' }));
    expect(wrapperOf("percentage").hidden).toBe(true);
    expect(wrapperOf("fixed.amount").hidden).toBe(false);

    fireEvent.click(
      screen.getByLabelText("Percentage of the net price plus a fixed amount", {
        selector: '[type="radio"]',
      }),
    );
    expect(wrapperOf("percentage").hidden).toBe(false);
    expect(wrapperOf("fixed.amount").hidden).toBe(false);
    expect((screen.getByLabelText("Percentage") as HTMLInputElement).value).toBe("4.5");
    // The window is typed in the OTA's time zone.
    expect(screen.getByLabelText("Active from (Europe/Oslo)").getAttribute("type")).toBe("datetime-local");
  });

  it("posts the rendered key; a final refusal's new key is sent next, and its field errors are on their fields", async () => {
    actions.createMarkupRule.mockResolvedValueOnce({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Some values were not accepted. Check the highlighted fields and try again.",
      requestId: "req_1",
      fieldErrors: { percentage: "Enter the percentage.", "scope.origins": "Not in the expected format." },
      nextActionKey: NEXT_KEY,
    } satisfies ActionState);
    actions.createMarkupRule.mockResolvedValueOnce({
      ok: false,
      message: "Try again.",
    } satisfies ActionState);
    render(
      <PricingRuleForm
        kind="markup"
        mode="create"
        idempotencyKey={KEY}
        timeZone="Europe/Oslo"
        defaultCurrency="EUR"
      />,
    );
    const form = screen.getByRole("form", { name: "Create markup rule" });

    fireEvent.submit(form);
    await waitFor(() => expect(actions.createMarkupRule).toHaveBeenCalledTimes(1), UI_WAIT);
    const alert = await screen.findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain("Request id req_1");
    const percentage = screen.getByLabelText("Percentage");
    expect(percentage.getAttribute("aria-invalid")).toBe("true");
    const describedBy = percentage.getAttribute("aria-describedby") ?? "";
    const error = describedBy
      .split(" ")
      .map((id) => document.getElementById(id))
      .find((element) => element?.textContent === "Enter the percentage.");
    expect(error).toBeDefined();
    expect(screen.getByLabelText("Origins").getAttribute("aria-invalid")).toBe("true");

    fireEvent.submit(form);
    await waitFor(() => expect(actions.createMarkupRule).toHaveBeenCalledTimes(2), UI_WAIT);
    expect(submissions(actions.createMarkupRule).map((posted) => posted.get("actionKey"))).toEqual([
      KEY,
      NEXT_KEY,
    ]);
  });

  it("opens a new rule without warnings at once, and stays to show a new rule's warnings with a link to it", async () => {
    actions.createMarkupRule.mockResolvedValueOnce({
      ok: true,
      message: "Markup rule created.",
      rule: { id: MARKUP_ID, name: "Long-haul economy" },
    });
    const view = render(
      <PricingRuleForm
        kind="markup"
        mode="create"
        idempotencyKey={KEY}
        timeZone="Europe/Oslo"
        defaultCurrency="EUR"
      />,
    );
    fireEvent.submit(screen.getByRole("form", { name: "Create markup rule" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/settings/markups/${MARKUP_ID}`), UI_WAIT);
    view.unmount();

    actions.createFeeRule.mockResolvedValueOnce({
      ok: true,
      message: "Fee rule created.",
      rule: { id: "fee_01JA4H9Z1B3D5F7H9K1M3P5R7W", name: "Card fee" },
      warnings: [
        {
          code: "fixed_currency_not_default",
          message: "The rule's amounts are not in the storefront's default currency.",
          path: "/fixed/currency",
        },
      ],
    });
    render(
      <PricingRuleForm
        kind="fee"
        mode="create"
        idempotencyKey={KEY}
        timeZone="Europe/Oslo"
        defaultCurrency="EUR"
      />,
    );
    fireEvent.submit(screen.getByRole("form", { name: "Create fee rule" }));

    const note = await screen.findByRole("note", {}, UI_WAIT);
    expect(note.textContent).toContain("Saved with warnings:");
    expect(note.textContent).toContain("The rule's amounts are not in the storefront's default currency.");
    expect(screen.getByRole("link", { name: "Open Card fee" }).getAttribute("href")).toBe(
      "/settings/fees/fee_01JA4H9Z1B3D5F7H9K1M3P5R7W",
    );
    expect(screen.queryByRole("form")).toBeNull();
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("saves a rule's page with its id, version and the rule as rendered, and shows the API's warnings", async () => {
    actions.updateMarkupRule.mockResolvedValueOnce({
      ok: true,
      message: "Saved. The change applies to the next search; offers already shown keep their prices.",
      rule: { id: MARKUP_ID, name: "Long-haul economy" },
      warnings: [
        {
          code: "sells_below_net",
          message: "The rule can make a negative markup: matching offers can be sold below the net price.",
          path: "/percentage",
        },
      ],
    });
    render(
      <PricingRuleForm kind="markup" mode="edit" rule={RULE} timeZone="Europe/Oslo" defaultCurrency="EUR" />,
    );
    fireEvent.change(screen.getByLabelText("Percentage"), { target: { value: "-5" } });

    fireEvent.submit(screen.getByRole("form", { name: "Save changes: Long-haul economy" }));

    const note = await screen.findByRole("note", {}, UI_WAIT);
    expect(note.textContent).toContain("matching offers can be sold below the net price");
    expect(screen.getByRole("status").textContent).toContain("Saved.");
    const [posted] = submissions(actions.updateMarkupRule);
    expect(posted?.get("ruleId")).toBe(MARKUP_ID);
    expect(posted?.get("version")).toBe("7");
    expect(JSON.parse(String(posted?.get("original")))).toMatchObject({
      percentage: "4.0000",
      priority: 100,
    });
    expect(posted?.get("percentage")).toBe("-5");
    expect(posted?.get("actionKey")).toBeNull();
  });
});

describe("the default markup rule's form", () => {
  /** The seeded default rule as the API answers it. */
  const DEFAULT_RULE: MarkupRule = {
    ...RULE,
    id: "mkr_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    name: "Default",
    scope: {},
    percentage: "0.0000",
    priority: 1000,
    isDefault: true,
    version: 3,
  };

  it("[FIX-W34-OTA AC3] shows its priority, active flag and window read-only, with why, and never offers or sends them", async () => {
    actions.updateMarkupRule.mockResolvedValueOnce({ ok: true, message: "Saved." } satisfies ActionState);
    render(
      <PricingRuleForm
        kind="markup"
        mode="edit"
        rule={DEFAULT_RULE}
        timeZone="Europe/Oslo"
        defaultCurrency="EUR"
      />,
    );
    const form = screen.getByRole("form", { name: "Save changes: Default" });

    // No control for what stays fixed: no scope, priority, active flag or window inputs.
    for (const name of [
      "priority",
      "isActive",
      "activeFrom",
      "activeUntil",
      "scope.carriers",
      "scope.minNet",
    ]) {
      expect([name, form.querySelector(`[name="${name}"]`)]).toEqual([name, null]);
    }
    expect(within(form).queryByLabelText("Priority")).toBeNull();
    expect(within(form).queryByLabelText("Active")).toBeNull();
    expect(within(form).queryByLabelText(/^Active from/)).toBeNull();
    // Shown read-only, with the explanation.
    expect(form.textContent).toContain(
      "The default rule always matches, so every offer gets a base markup: it stays active, has no validity window and keeps priority 1000 (rules with a lower number are checked before it). Its name, notes, calculation, amounts, unit, caps and stacking can still change.",
    );
    const fixed = within(form).getByText("1000").closest("dl");
    expect(
      [...(fixed?.querySelectorAll("dt") ?? [])].map((term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]),
    ).toEqual([
      ["Priority", "1000"],
      ["Status", "Active"],
      ["Validity", "Always"],
    ]);
    // What may change is still offered.
    expect(within(form).getByLabelText("Name")).toBeDefined();
    expect(within(form).getByLabelText("Percentage")).toBeDefined();
    expect(within(form).getByLabelText(/^Stackable/)).toBeDefined();

    fireEvent.change(within(form).getByLabelText("Percentage"), { target: { value: "2" } });
    fireEvent.submit(form);

    await waitFor(() => expect(actions.updateMarkupRule).toHaveBeenCalledTimes(1), UI_WAIT);
    const [posted] = submissions(actions.updateMarkupRule);
    expect(posted?.get("defaultRule")).toBe("true");
    expect(posted?.get("percentage")).toBe("2");
    for (const name of ["priority", "isActive", "activeFrom", "activeUntil"]) {
      expect([name, posted?.has(name)]).toEqual([name, false]);
    }
  });

  it("[FIX-W34-OTA AC3] keeps offering them for every other rule, without the default rule's marker", () => {
    render(
      <PricingRuleForm kind="markup" mode="edit" rule={RULE} timeZone="Europe/Oslo" defaultCurrency="EUR" />,
    );
    const form = screen.getByRole("form", { name: "Save changes: Long-haul economy" });

    for (const name of ["priority", "isActive", "activeFrom", "activeUntil"]) {
      expect([name, form.querySelector(`[name="${name}"]`)?.tagName]).toEqual([name, "INPUT"]);
    }
    expect(form.querySelector('[name="defaultRule"]')).toBeNull();
  });
});

describe("DeleteRuleDialog", () => {
  it("asks no reason, warns that both environments share the rule, and posts the rule and its version", async () => {
    actions.deleteMarkupRule.mockResolvedValueOnce({
      ok: false,
      message: "This record changed; reload to see the latest version.",
    });
    render(
      <DeleteRuleDialog
        kind="markup"
        ruleId={MARKUP_ID}
        ruleName="Long-haul economy"
        version={7}
        environment="live"
        idempotencyKey={KEY}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
    const dialog = await screen.findByRole(
      "dialog",
      { name: /Delete the markup rule Long-haul economy\?/ },
      UI_WAIT,
    );
    expect(within(dialog).queryByLabelText(CONFIRM_STRINGS.reasonLabel)).toBeNull();
    expect(dialog.textContent).toContain("Rules are shared by the test and live environments.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete rule in LIVE" }));
    await waitFor(() => expect(actions.deleteMarkupRule).toHaveBeenCalledTimes(1), UI_WAIT);
    const [posted] = submissions(actions.deleteMarkupRule);
    expect(posted?.get("ruleId")).toBe(MARKUP_ID);
    expect(posted?.get("version")).toBe("7");
    expect(posted?.get("reason")).toBeNull();
    expect((await within(dialog).findByRole("alert", {}, UI_WAIT)).textContent).toContain("reload");
  });
});
