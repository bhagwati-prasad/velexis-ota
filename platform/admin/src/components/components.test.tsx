// @vitest-environment happy-dom
import type { ColumnDef } from "@tanstack/react-table";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope and navigation of Next.js, the configuration and the platform API ---------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/",
  searchParams: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() },
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
  redirect: navigation.redirect,
}));

const settings = vi.hoisted(() => ({ APP_ENV: "production" as "development" | "test" | "production" }));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

const api = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  PATCH: vi.fn(),
  DELETE: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ platformApi: vi.fn(() => Promise.resolve(api)) }));

import ConsoleLayout from "@/app/(app)/layout";
import { stepUp } from "@/app/(app)/step-up-actions";
import {
  AdminShell,
  adminNavigation,
  currentNavEntry,
  type MilestoneFeatures,
} from "@/components/admin-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, listHref } from "@/components/data-table";
import { DateTime, formatDateTime } from "@/components/date-time";
import { FilterBar, SEARCH_MAX_LENGTH, filteredHref, type FilterField } from "@/components/filter-bar";
import { JsonView, formatJson } from "@/components/json-view";
import { MaskedValue } from "@/components/masked-value";
import { Money, formatMoney } from "@/components/money";
import { ReasonDialog, reasonLength, reasonProblem } from "@/components/reason-dialog";
import { REVEAL_DURATION_MS, RevealPanel } from "@/components/reveal-panel";
import { StatusBadge } from "@/components/status-badge";
import { StepUpDialog, useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ApiError } from "@/lib/api";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, type AdminSession } from "@/lib/session";
import {
  ERROR_MESSAGES,
  FILTER_STRINGS,
  JSON_STRINGS,
  REASON_STRINGS,
  REVEAL_STRINGS,
  SHELL_STRINGS,
  STEP_UP_STRINGS,
  TABLE_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, code or bank account) ------------------------------------------

const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";

/**
 * How long a step that runs a (mocked) server action and re-renders the dialogs may take before the wait gives up.
 * React's action queue, Radix's focus handling and happy-dom are quick alone, but slower on a busy CI runner than
 * Testing Library's default of one second.
 */
const UI_WAIT = { timeout: 3_000 } as const;

const FEATURES_OFF: MilestoneFeatures = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

const ADMIN = { fullName: "Lena Holm", email: "lena.holm@velexis.example.com" } as const;

function adminMe(features: MilestoneFeatures = FEATURES_OFF) {
  return { id: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9", ...ADMIN, features };
}

/** A new session as `adminStepUp` answers it; the token values are dummies. */
function steppedUpSession(): AdminSession {
  return {
    accessToken: "stepped-up-admin-access-token",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "stepped-up-admin-refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    admin: adminMe(),
  };
}

function apiError(
  code: ApiError["code"],
  status: number,
  extra: Partial<ApiError> = {},
): { error: ApiError } {
  return { error: { code, status, fieldErrors: [], details: {}, ...extra } };
}

/** The cookie store of `cookies()` in a server action: records every write. */
function cookieStore() {
  const store = { set: vi.fn(), get: vi.fn(() => undefined) };
  nextHeaders.cookies.mockResolvedValue(store);
  return store;
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: HTMLElement): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

function linkNames(container: HTMLElement): string[] {
  return within(container)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** Submits the form of the button named `name`, with that button as the submitter. */
function submit(name: string | RegExp, container: HTMLElement = document.body): void {
  const button = within(container).getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

/** The query of a URL the router was sent to, as sorted entries (order-independent). */
function queryOf(href: string): [string, string][] {
  return [...new URL(href, "https://admin.invalid").searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
}

function resetNavigation(pathname = "/", query = ""): void {
  navigation.pathname = pathname;
  navigation.searchParams = new URLSearchParams(query);
  for (const method of Object.values(navigation.router)) {
    method.mockReset();
  }
  navigation.redirect.mockClear();
}

/** A form whose action may ask for a step-up, with a reason dialog that dispatches it. */
type SuspendState = { readonly suspended: boolean; readonly stepUp?: true };

function SuspendControl({
  action,
}: {
  readonly action: (state: SuspendState, payload: FormData) => Promise<SuspendState>;
}) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(action, { suspended: false });
  return (
    <>
      <ReasonDialog
        trigger={
          <Button variant="destructive" disabled={isPending}>
            Suspend
          </Button>
        }
        title="Suspend Acme Travel?"
        description="The storefront and the OTA admin stop within 60 seconds."
        confirmLabel="Suspend OTA"
        onConfirm={dispatch}
      >
        <input type="hidden" name="tenantId" value={TENANT_ID} />
      </ReasonDialog>
      {state.suspended ? <p role="status">Suspended</p> : null}
      {stepUpDialog}
    </>
  );
}

/** Opens the reason dialog of `SuspendControl`, types `reason` and confirms. */
async function suspendWithReason(reason: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
  const dialog = await screen.findByRole("dialog", { name: "Suspend Acme Travel?" }, UI_WAIT);
  fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: reason } });
  submit("Suspend OTA", dialog);
  return dialog;
}

/**
 * Once per file, before any test: the paths every dialog test runs first (the shell's render, a Radix dialog opening
 * with its focus trap, React's action queue). Their first run in a fresh worker is the slowest, and on a busy CI runner
 * it would otherwise land in the first test's own five seconds. Nothing of it stays: each test gets fresh mocks and an
 * empty document.
 */
beforeAll(async () => {
  render(
    <AdminShell admin={ADMIN} features={FEATURES_OFF} environment="test">
      <SuspendControl action={() => Promise.resolve({ suspended: false, stepUp: true })} />
    </AdminShell>,
  );
  await suspendWithReason("Warm-up reason");
  await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  resetNavigation();
  settings.APP_ENV = "production";
  for (const method of Object.values(api)) {
    method.mockReset();
  }
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

// ---- Shell and navigation -----------------------------------------------------------------------------------------

/** Every M1 area of README §2 with its URL, in display order. */
const M1_ENTRIES: [string, string][] = [
  ["Dashboard", "/"],
  ["Tenants", "/tenants"],
  ["Provisioning jobs", "/provisioning-jobs"],
  ["Queues", "/queues"],
  ["Plans", "/plans"],
  ["Subscriptions", "/subscriptions"],
  ["Amadeus accounts", "/amadeus/accounts"],
  ["Office pool", "/amadeus/offices"],
  ["Accounts", "/accounts"],
  ["Platform admins", "/admins"],
  ["Audit log", "/audit"],
];

function navEntries(): [string, string][] {
  return within(screen.getByRole("navigation", { name: SHELL_STRINGS.navigationLabel }))
    .getAllByRole("link")
    .map((link) => [link.textContent ?? "", link.getAttribute("href") ?? ""]);
}

describe("(app) layout and AdminShell", () => {
  it("loads adminGetMe once and renders the navigation of every M1 area, the admin, the environment and the page", async () => {
    api.GET.mockResolvedValue({ data: adminMe() });

    render(await ConsoleLayout({ children: <p>Page body</p> }));

    expect(api.GET).toHaveBeenCalledTimes(1);
    expect(api.GET).toHaveBeenCalledWith("/v1/admin/me");
    expect(navEntries()).toEqual(M1_ENTRIES);
    for (const hidden of ["Invoices", "Stripe events", "Settlements", "Domains"]) {
      expect(screen.queryByRole("link", { name: hidden })).toBeNull();
    }
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(main.textContent).toBe("Page body");
    expect(screen.getByText(ADMIN.email)).toBeTruthy();
    expect(screen.getByText(ADMIN.fullName)).toBeTruthy();
    const badge = screen.getByText("Production");
    expect(badge.closest("[data-environment]")?.getAttribute("data-environment")).toBe("production");
    expect(badge.closest("[data-environment]")?.textContent).toBe("Environment: Production");
    const signOut = screen.getByRole("button", { name: SHELL_STRINGS.signOut }).closest("form");
    expect(signOut?.getAttribute("action")).toBe("/sign-out");
    expect(signOut?.getAttribute("method")).toBe("post");
  });

  it("takes the milestone switches from adminGetMe and the environment from APP_ENV", async () => {
    settings.APP_ENV = "test";
    api.GET.mockResolvedValue({ data: adminMe({ ...FEATURES_OFF, customDomains: true }) });

    render(await ConsoleLayout({ children: <p>Page body</p> }));

    expect(screen.getByRole("link", { name: "Domains" }).getAttribute("href")).toBe("/domains");
    for (const hidden of ["Invoices", "Stripe events", "Settlements"]) {
      expect(screen.queryByRole("link", { name: hidden })).toBeNull();
    }
    expect(screen.getByText("Test").closest("[data-environment]")?.getAttribute("data-environment")).toBe(
      "test",
    );
  });

  it("shows each M5 area only while one of its milestone switches is on (PADR-0015 item 3)", () => {
    const cases: [Partial<MilestoneFeatures>, string[]][] = [
      [{}, []],
      [{ stripeBilling: true }, ["Invoices", "Stripe events"]],
      [{ ownStripe: true }, ["Stripe events"]],
      [{ settlements: true }, ["Settlements"]],
      [{ customDomains: true }, ["Domains"]],
      [{ ownAmadeus: true, liveSwitch: true }, []],
      [
        {
          stripeBilling: true,
          ownStripe: true,
          settlements: true,
          ownAmadeus: true,
          customDomains: true,
          liveSwitch: true,
        },
        ["Invoices", "Stripe events", "Settlements", "Domains"],
      ],
    ];
    const m1 = new Set(M1_ENTRIES.map(([label]) => label));
    for (const [switches, expected] of cases) {
      render(
        <AdminShell admin={ADMIN} features={{ ...FEATURES_OFF, ...switches }} environment="test">
          <p>Page</p>
        </AdminShell>,
      );
      const m5 = navEntries()
        .map(([label]) => label)
        .filter((label) => !m1.has(label));
      expect(m5, JSON.stringify(switches)).toEqual(expected);
      cleanup();
    }
    expect(
      adminNavigation({ ...FEATURES_OFF, settlements: true, customDomains: true })
        .flatMap((section) => section.entries)
        .filter((entry) => entry.id === "settlements" || entry.id === "domains"),
    ).toEqual([
      { id: "settlements", href: "/settlements" },
      { id: "domains", href: "/domains" },
    ]);
  });

  it("groups the navigation and leaves out a group whose areas are all switched off", () => {
    expect(adminNavigation(FEATURES_OFF).map((section) => section.id)).toEqual([
      "overview",
      "tenants",
      "billing",
      "amadeus",
      "people",
    ]);
    expect(adminNavigation({ ...FEATURES_OFF, customDomains: true }).map((section) => section.id)).toContain(
      "payments",
    );
  });

  it("marks the current page, the most specific entry, and the dashboard only on /", () => {
    const sections = adminNavigation(FEATURES_OFF);
    expect(currentNavEntry(sections, "/")?.id).toBe("dashboard");
    expect(currentNavEntry(sections, `/tenants/${TENANT_ID}`)?.id).toBe("tenants");
    expect(currentNavEntry(sections, "/amadeus/offices")?.id).toBe("amadeusOffices");
    expect(currentNavEntry(sections, "/tenantsx")).toBeUndefined();
    expect(currentNavEntry(sections, "/sign-in")).toBeUndefined();

    navigation.pathname = `/tenants/${TENANT_ID}`;
    render(
      <AdminShell admin={ADMIN} features={FEATURES_OFF} environment="development">
        <p>Page</p>
      </AdminShell>,
    );
    expect(screen.getByRole("link", { name: "Tenants" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBeNull();
    expect(
      screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page"),
    ).toHaveLength(1);
    expect(screen.getByText("Development")).toBeTruthy();
  });

  it("sends a session the API refuses to /sign-in", async () => {
    for (const code of ["UNAUTHENTICATED", "TOKEN_EXPIRED"] as const) {
      api.GET.mockResolvedValueOnce(apiError(code, 401));
      await expect(ConsoleLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT /sign-in");
    }
  });

  it("shows the admin's message and a sign-out button, not the shell, when the admin cannot be loaded", async () => {
    api.GET.mockResolvedValue(apiError("SERVICE_UNAVAILABLE", 503));

    render(await ConsoleLayout({ children: <p>Page body</p> }));

    const main = screen.getByRole("main");
    expect(main.textContent).toContain(SHELL_STRINGS.unavailableTitle);
    expect(main.textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(screen.queryByText("Page body")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(
      screen.getByRole("button", { name: SHELL_STRINGS.signOut }).closest("form")?.getAttribute("action"),
    ).toBe("/sign-out");
  });
});

// ---- Reason --------------------------------------------------------------------------------------------------------

describe("ReasonDialog", () => {
  function renderDialog(onConfirm: (data: FormData) => void) {
    render(
      <ReasonDialog
        trigger={<Button>Resume</Button>}
        title="Resume Acme Travel?"
        description="The storefront and the OTA admin work again within 60 seconds."
        confirmLabel="Resume OTA"
        destructive={false}
        onConfirm={onConfirm}
      >
        <input type="hidden" name="tenantId" value={TENANT_ID} />
      </ReasonDialog>,
    );
  }

  async function open(): Promise<{ dialog: HTMLElement; reason: HTMLElement }> {
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume Acme Travel?" }, UI_WAIT);
    return { dialog, reason: within(dialog).getByLabelText(REASON_STRINGS.label) };
  }

  it("[PAD-003 AC1] refuses a reason of 4 characters and accepts one of 5", async () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);
    const { dialog, reason } = await open();

    fireEvent.change(reason, { target: { value: "abcd" } });
    submit("Resume OTA", dialog);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(reason.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionsOf(reason)).toEqual([REASON_STRINGS.hint, REASON_STRINGS.tooShort]);
    expect(document.activeElement).toBe(reason);

    fireEvent.change(reason, { target: { value: "abcde" } });
    expect(reason.getAttribute("aria-invalid")).toBeNull();
    submit("Resume OTA", dialog);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const sent = onConfirm.mock.calls[0]?.[0] as FormData;
    expect(sent.get("reason")).toBe("abcde");
    // The other fields of the dialog's form travel with the reason.
    expect(sent.get("tenantId")).toBe(TENANT_ID);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
  });

  it("counts the reason without its surrounding spaces and sends it trimmed", async () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);
    const { dialog, reason } = await open();

    fireEvent.change(reason, { target: { value: "   abcd   " } });
    submit("Resume OTA", dialog);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(descriptionsOf(reason)).toContain(REASON_STRINGS.tooShort);

    fireEvent.change(reason, { target: { value: "  Paid by bank transfer  " } });
    submit("Resume OTA", dialog);
    expect((onConfirm.mock.calls[0]?.[0] as FormData).get("reason")).toBe("Paid by bank transfer");
  });

  it("refuses an empty reason and one of more than 500 characters, and accepts exactly 500", async () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);
    const { dialog, reason } = await open();

    submit("Resume OTA", dialog);
    expect(descriptionsOf(reason)).toContain(REASON_STRINGS.required);

    fireEvent.change(reason, { target: { value: "x".repeat(501) } });
    submit("Resume OTA", dialog);
    expect(descriptionsOf(reason)).toContain(REASON_STRINGS.tooLong);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(reason, { target: { value: "x".repeat(500) } });
    submit("Resume OTA", dialog);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("counts characters as AdminReason does (code points, not UTF-16 units)", () => {
    expect(reasonLength("✈️✈️")).toBe(4);
    expect(reasonLength("😀😀😀😀")).toBe(4);
    expect(reasonProblem("😀😀😀😀")).toBe(REASON_STRINGS.tooShort);
    expect(reasonProblem("😀😀😀😀😀")).toBeUndefined();
    expect(reasonProblem("😀".repeat(500))).toBeUndefined();
    expect(reasonProblem("😀".repeat(501))).toBe(REASON_STRINGS.tooLong);
  });

  it("runs nothing when cancelled, and starts empty when opened again", async () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);
    const first = await open();
    fireEvent.change(first.reason, { target: { value: "Changed my mind" } });
    fireEvent.click(within(first.dialog).getByRole("button", { name: REASON_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);

    const second = await open();
    expect((second.reason as HTMLTextAreaElement).value).toBe("");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ---- Step-up -------------------------------------------------------------------------------------------------------

describe("StepUpDialog and the stepUp action", () => {
  it("[PAD-003 AC2] retries the action after a successful step-up, with the new tokens and the same reason", async () => {
    const order: string[] = [];
    const store = cookieStore();
    store.set.mockImplementation((name: string) => order.push(`cookie ${name}`));
    api.POST.mockImplementation((path: string) => {
      order.push(`POST ${path}`);
      return Promise.resolve({ data: steppedUpSession() });
    });
    const payloads: FormData[] = [];
    const suspend = vi.fn((_state: SuspendState, payload: FormData): Promise<SuspendState> => {
      payloads.push(payload);
      order.push(`suspend ${payloads.length}`);
      return Promise.resolve(
        payloads.length === 1 ? { suspended: false, stepUp: true } : { suspended: true },
      );
    });
    render(<SuspendControl action={suspend} />);

    await suspendWithReason("Card testing reported by Stripe");
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    expect(suspend).toHaveBeenCalledTimes(1);
    fireEvent.change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), {
      target: { value: "492039" },
    });
    submit(STEP_UP_STRINGS.submit, dialog);

    expect(await screen.findByText("Suspended", {}, UI_WAIT)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    // The code went to adminStepUp, the new session reached the cookies, and only then the action ran again.
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(api.POST).toHaveBeenCalledWith("/v1/admin/auth/step-up", { body: { code: "492039" } });
    expect(order).toEqual([
      "suspend 1",
      "POST /v1/admin/auth/step-up",
      `cookie ${ACCESS_TOKEN_COOKIE}`,
      `cookie ${REFRESH_TOKEN_COOKIE}`,
      "suspend 2",
    ]);
    const access = store.set.mock.calls.find(([name]) => name === ACCESS_TOKEN_COOKIE);
    expect(access?.[1]).toBe("stepped-up-admin-access-token");
    expect(access?.[2]).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    // The re-submission carries the original submission's data: the same reason and tenant.
    expect(suspend).toHaveBeenCalledTimes(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(payloads[1]?.get("reason")).toBe("Card testing reported by Stripe");
    expect(payloads[1]?.get("tenantId")).toBe(TENANT_ID);
  });

  it("keeps the dialog open with the message at the field when the code is wrong, and does not retry", async () => {
    cookieStore();
    api.POST.mockResolvedValue(apiError("MFA_CODE_INVALID", 401));
    const suspend = vi.fn((): Promise<SuspendState> => Promise.resolve({ suspended: false, stepUp: true }));
    render(<SuspendControl action={suspend} />);

    await suspendWithReason("Card testing reported by Stripe");
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    const code = within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel);
    fireEvent.change(code, { target: { value: "000000" } });
    submit(STEP_UP_STRINGS.submit, dialog);

    await waitFor(() => expect(descriptionsOf(code)).toContain(ERROR_MESSAGES.MFA_CODE_INVALID), UI_WAIT);
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("dialog", { name: STEP_UP_STRINGS.title })).toBeTruthy();
    expect(nextHeaders.cookies).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it("closes without retrying when cancelled, and opens again on the next step-up request", async () => {
    const suspend = vi.fn((): Promise<SuspendState> => Promise.resolve({ suspended: false, stepUp: true }));
    render(<SuspendControl action={suspend} />);

    await suspendWithReason("Card testing reported by Stripe");
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(api.POST).not.toHaveBeenCalled();

    await suspendWithReason("Card testing reported by Stripe, again");
    expect(await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT)).toBeTruthy();
    expect(suspend).toHaveBeenCalledTimes(2);
  });

  it("reports a verification once, however often the parent re-renders", async () => {
    cookieStore();
    api.POST.mockResolvedValue({ data: steppedUpSession() });
    const onVerified = vi.fn();
    const { rerender } = render(<StepUpDialog open onVerified={() => onVerified()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(STEP_UP_STRINGS.codeLabel), { target: { value: "492039" } });
    submit(STEP_UP_STRINGS.submit);
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1), UI_WAIT);
    rerender(<StepUpDialog open onVerified={() => onVerified()} onCancel={vi.fn()} />);
    rerender(<StepUpDialog open onVerified={() => onVerified()} onCancel={vi.fn()} />);

    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it("refuses a code that is not 6 digits without calling the API, and accepts one typed with spaces", async () => {
    expect(await stepUp({ status: "idle" }, formData({ code: "12ab" }))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      fieldError: STEP_UP_STRINGS.codeFormat,
    });
    expect(api.POST).not.toHaveBeenCalled();

    cookieStore();
    api.POST.mockResolvedValue({ data: steppedUpSession() });
    expect(await stepUp({ status: "idle" }, formData({ code: " 492 039 " }))).toEqual({ status: "verified" });
    expect(api.POST).toHaveBeenCalledWith("/v1/admin/auth/step-up", { body: { code: "492039" } });
  });

  it("shows other failures above the field, the wait of a rate limit, and never stores an answer without tokens", async () => {
    api.POST.mockResolvedValueOnce(apiError("UNAUTHENTICATED", 401));
    expect(await stepUp({ status: "idle" }, formData({ code: "492039" }))).toEqual({
      status: "failed",
      code: "UNAUTHENTICATED",
      message: ERROR_MESSAGES.UNAUTHENTICATED,
    });

    api.POST.mockResolvedValueOnce(apiError("RATE_LIMITED", 429, { retryAfterSeconds: 540 }));
    expect(await stepUp({ status: "idle" }, formData({ code: "492039" }))).toEqual({
      status: "failed",
      code: "RATE_LIMITED",
      message: STEP_UP_STRINGS.rateLimitedFor(540),
    });
    expect(STEP_UP_STRINGS.rateLimitedFor(540)).toContain("9 minutes");

    const store = cookieStore();
    api.POST.mockResolvedValueOnce({ data: { admin: adminMe() } });
    expect(await stepUp({ status: "idle" }, formData({ code: "492039" }))).toEqual({
      status: "failed",
      code: "INTERNAL_ERROR",
      message: ERROR_MESSAGES.INTERNAL_ERROR,
    });
    expect(store.set).not.toHaveBeenCalled();
  });
});

// ---- Revealed details ----------------------------------------------------------------------------------------------

describe("RevealPanel", () => {
  const IBAN = "NO93 8601 1117 947";
  const FIELDS = [
    { label: "Account holder", value: "Acme Travel AS" },
    { label: "IBAN", value: IBAN },
  ] as const;

  it("[PAD-003 AC3] clears its content after 60 seconds", () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    render(<RevealPanel title="Payout account of Acme Travel" fields={FIELDS} onHide={onHide} />);

    const panel = screen.getByRole("region", { name: "Payout account of Acme Travel" });
    expect(panel.textContent).toContain(IBAN);
    expect(panel.textContent).toContain(REVEAL_STRINGS.hidesIn(60));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("region").textContent).toContain(REVEAL_STRINGS.hidesIn(30));

    act(() => {
      vi.advanceTimersByTime(REVEAL_DURATION_MS - 30_000 - 1);
    });
    expect(document.body.textContent).toContain(IBAN);
    expect(onHide).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.body.innerHTML).not.toContain(IBAN);
    expect(document.body.innerHTML).not.toContain("Acme Travel AS");
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(REVEAL_STRINGS.hidden);
    expect(onHide).toHaveBeenCalledTimes(1);

    // Nothing restarts it: the details stay hidden.
    act(() => {
      vi.advanceTimersByTime(REVEAL_DURATION_MS);
    });
    expect(document.body.innerHTML).not.toContain(IBAN);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("hides at once on 'Hide now' and shows a new reveal again for 60 seconds", () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    const { rerender } = render(<RevealPanel title="Payout account" fields={FIELDS} onHide={onHide} />);

    fireEvent.click(screen.getByRole("button", { name: REVEAL_STRINGS.hideNow }));
    expect(document.body.innerHTML).not.toContain(IBAN);
    expect(onHide).toHaveBeenCalledTimes(1);

    // A second reveal (a new array from the reveal action) shows the details again.
    rerender(<RevealPanel title="Payout account" fields={[...FIELDS]} onHide={onHide} />);
    expect(document.body.textContent).toContain(IBAN);
    act(() => {
      vi.advanceTimersByTime(REVEAL_DURATION_MS);
    });
    expect(document.body.innerHTML).not.toContain(IBAN);
    expect(onHide).toHaveBeenCalledTimes(2);
  });

  it("keeps the 60 seconds when the parent re-renders, and offers no copy or form field of the value", () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    const urlBefore = location.href;
    const { rerender } = render(
      <RevealPanel title="Payout account" fields={FIELDS} onHide={() => undefined} />,
    );

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    rerender(<RevealPanel title="Payout account" fields={FIELDS} onHide={() => undefined} />);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(document.body.innerHTML).not.toContain(IBAN);

    rerender(<RevealPanel title="Payout account" fields={[...FIELDS]} />);
    const panel = screen.getByRole("region");
    expect(within(panel).queryByRole("button", { name: /copy/i })).toBeNull();
    expect(panel.querySelector("input, textarea")).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
    expect(location.href).toBe(urlBefore);
  });
});

// ---- Filters and tables --------------------------------------------------------------------------------------------

const TENANT_FILTERS: readonly FilterField[] = [
  { kind: "search", name: "q", label: "Search", placeholder: "Key, name or owner e-mail" },
  {
    kind: "select",
    name: "status",
    label: "Status",
    options: [
      { value: "provisioning", label: "Setting up" },
      { value: "active", label: "Active" },
      { value: "suspended", label: "Suspended" },
      { value: "failed", label: "Set-up failed" },
    ],
  },
  {
    kind: "select",
    name: "planCode",
    label: "Plan",
    options: [
      { value: "early_access", label: "Early access" },
      { value: "pro", label: "Pro" },
    ],
  },
];

describe("FilterBar", () => {
  it("[PAD-003 AC4] changing a filter updates the URL and keeps the other filters", () => {
    resetNavigation("/tenants", "q=acme&status=active&planCode=early_access&limit=50&cursor=c_page2");
    render(<FilterBar fields={TENANT_FILTERS} />);

    const search = screen.getByRole("search", { name: FILTER_STRINGS.label });
    fireEvent.change(within(search).getByLabelText("Status"), { target: { value: "suspended" } });

    expect(navigation.router.push).toHaveBeenCalledTimes(1);
    const [href, options] = navigation.router.push.mock.calls[0] as [string, unknown];
    expect(href.startsWith("/tenants?")).toBe(true);
    expect(queryOf(href)).toEqual([
      ["limit", "50"],
      ["planCode", "early_access"],
      ["q", "acme"],
      ["status", "suspended"],
    ]);
    // A new filter starts on the first page: the cursor is gone.
    expect(href).not.toContain("cursor");
    expect(options).toEqual({ scroll: false });
  });

  it("[PAD-003 AC4] applies a search on submit, keeps the selected filters and removes an emptied one", () => {
    resetNavigation("/tenants", "status=suspended&planCode=pro");
    render(<FilterBar fields={TENANT_FILTERS} />);

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "  anna.berg@example.com " } });
    expect(navigation.router.push).not.toHaveBeenCalled();
    submit(FILTER_STRINGS.search);

    expect(queryOf(navigation.router.push.mock.calls[0]?.[0] as string)).toEqual([
      ["planCode", "pro"],
      ["q", "anna.berg@example.com"],
      ["status", "suspended"],
    ]);

    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "" } });
    expect(navigation.router.push.mock.calls[1]?.[0]).toBe(
      "/tenants?q=anna.berg%40example.com&status=suspended",
    );
  });

  it("shows the filters of the URL, follows the URL when it changes, and links to the unfiltered list", () => {
    resetNavigation("/tenants", "status=failed&tab=jobs");
    const { rerender } = render(<FilterBar fields={TENANT_FILTERS} />);

    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("failed");
    expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("");
    // The longest e-mail address an owner search may need fits: `q` takes 254 characters.
    expect((screen.getByLabelText("Search") as HTMLInputElement).maxLength).toBe(SEARCH_MAX_LENGTH);
    expect(SEARCH_MAX_LENGTH).toBe(254);
    expect(screen.getByRole("link", { name: FILTER_STRINGS.clear }).getAttribute("href")).toBe(
      "/tenants?tab=jobs",
    );
    // Without JavaScript the GET form keeps the other parameters as hidden fields.
    const form = screen.getByRole("search") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/tenants");
    expect([...new FormData(form).entries()]).toEqual([
      ["tab", "jobs"],
      ["q", ""],
      ["status", "failed"],
      ["planCode", ""],
    ]);

    navigation.searchParams = new URLSearchParams("q=nordic");
    rerender(<FilterBar fields={TENANT_FILTERS} />);
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("nordic");

    navigation.searchParams = new URLSearchParams("");
    rerender(<FilterBar fields={TENANT_FILTERS} />);
    expect(screen.queryByRole("link", { name: FILTER_STRINGS.clear })).toBeNull();
  });

  it("builds list URLs that keep unrelated parameters, repeated ones included", () => {
    const current = new URLSearchParams("tag=a&tag=b&status=active&cursor=c1");
    expect(listHref("/audit", current, { cursor: "c2" })).toBe("/audit?tag=a&tag=b&status=active&cursor=c2");
    expect(listHref("/audit", current, { status: null, cursor: "" })).toBe("/audit?tag=a&tag=b");
    expect(listHref("/audit", new URLSearchParams(), {})).toBe("/audit");
    expect(filteredHref("/audit", current, TENANT_FILTERS, { q: " x ", status: "", planCode: "pro" })).toBe(
      "/audit?tag=a&tag=b&q=x&planCode=pro",
    );
  });
});

describe("DataTable", () => {
  interface TenantRow {
    readonly id: string;
    readonly key: string;
    readonly status: "active" | "suspended";
  }
  const columns: ColumnDef<TenantRow, unknown>[] = [
    { accessorKey: "key", header: "Key" },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge kind="tenant" status={row.original.status} />,
    },
  ];
  const rows: TenantRow[] = [
    { id: TENANT_ID, key: "acme", status: "active" },
    { id: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5G", key: "nordic", status: "suspended" },
  ];

  it("renders a captioned table with a header row and one row per item", () => {
    render(<DataTable caption="Tenants" columns={columns} data={rows} getRowId={(row) => row.id} />);

    const table = screen.getByRole("table", { name: "Tenants" });
    expect(
      within(table)
        .getAllByRole("row")
        .map((row) => [...row.children].map((cell) => cell.textContent)),
    ).toEqual([
      ["Key", "Status"],
      ["acme", "Active"],
      ["nordic", "Suspended"],
    ]);
    expect(within(table).getAllByRole("columnheader")[0]?.getAttribute("scope")).toBe("col");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("links the next page by its cursor and the first page from a later one, keeping the filters", () => {
    resetNavigation("/tenants", "status=active&q=acme");
    const { rerender } = render(
      <DataTable caption="Tenants" columns={columns} data={rows} page={{ nextCursor: "c_page2" }} />,
    );
    const pages = screen.getByRole("navigation", { name: TABLE_STRINGS.paginationLabel });
    expect(linkNames(pages)).toEqual([TABLE_STRINGS.nextPage]);
    expect(within(pages).getByRole("link").getAttribute("href")).toBe(
      "/tenants?status=active&q=acme&cursor=c_page2",
    );

    navigation.searchParams = new URLSearchParams("status=active&q=acme&cursor=c_page2");
    rerender(<DataTable caption="Tenants" columns={columns} data={rows} page={{ nextCursor: null }} />);
    const last = screen.getByRole("navigation", { name: TABLE_STRINGS.paginationLabel });
    expect(linkNames(last)).toEqual([TABLE_STRINGS.firstPage]);
    expect(within(last).getByRole("link").getAttribute("href")).toBe("/tenants?status=active&q=acme");
  });

  it("says so when nothing matches", () => {
    render(<DataTable caption="Tenants" columns={columns} data={[]} page={{ nextCursor: null }} />);
    expect(within(screen.getByRole("table")).getByText(TABLE_STRINGS.empty)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("[FIX-W31-PLATFORM AC4] scrolls a wide table in a container that takes the keyboard focus and shows it", () => {
    render(<DataTable caption="Tenants" columns={columns} data={rows} getRowId={(row) => row.id} />);

    // axe `scrollable-region-focusable` (WCAG 2.1.1): the arrow keys scroll what the keyboard can focus, as the
    // portal's table does since PFE-015.
    const container = screen.getByRole("table", { name: "Tenants" }).parentElement as HTMLElement;
    expect(container.dataset["slot"]).toBe("table-container");
    expect(container.getAttribute("tabindex")).toBe("0");
    expect(container.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["overflow-x-auto", "focus-visible:ring-[3px]", "focus-visible:ring-ring/50"]),
    );
    container.focus();
    expect(document.activeElement).toBe(container);
  });
});

describe("Alert", () => {
  it("[FIX-W31-PLATFORM AC4] colours a destructive description in the full destructive colour, never a lighter one", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>The plan could not be saved</AlertTitle>
        <AlertDescription>Try again in a moment.</AlertDescription>
      </Alert>,
    );

    // text-destructive/90 on the card is 4.49:1, under the 4.5:1 of WCAG 1.4.3 (the portal's fix of PFE-015).
    const classes = screen.getByRole("alert").className.split(/\s+/);
    expect(classes).toContain("*:data-[slot=alert-description]:text-destructive");
    expect(classes.filter((name) => /text-destructive\/\d+$/.test(name))).toEqual([]);
    expect(screen.getByText("Try again in a moment.").dataset["slot"]).toBe("alert-description");
  });
});

describe("Tabs", () => {
  it("[FIX-W32-PLATFORM AC3] sets the tab list's text in the foreground colour on the muted background, never the muted one", () => {
    render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Tenant sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">The OTA&apos;s fields.</TabsContent>
      </Tabs>,
    );

    // text-muted-foreground on bg-muted is 4.34:1, under the 4.5:1 of WCAG 1.4.3; text-foreground there is 18.15:1.
    const list = screen.getByRole("tablist", { name: "Tenant sections" });
    const classes = list.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["bg-muted", "text-foreground"]));
    expect(classes.filter((name) => /(^|:)text-muted-foreground$/.test(name))).toEqual([]);
    // The triggers keep the colour they had, so the tabs look as before.
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className.split(/\s+/)).toContain("text-foreground");
    }
  });
});

// ---- Values --------------------------------------------------------------------------------------------------------

describe("JsonView", () => {
  it("shows an id-only payload as indented JSON in a focusable region", () => {
    const payload = { jobId: "job_01JA2ZB3D7F1H5K9M3P7R1T5W9", tenantId: TENANT_ID, attempt: 2 };
    render(<JsonView value={payload} label="Payload" />);

    const region = screen.getByRole("region", { name: "Payload" });
    expect(region.tagName).toBe("PRE");
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.textContent).toBe(JSON.stringify(payload, null, 2));
  });

  it("renders markup in a value as text", () => {
    render(<JsonView value={{ note: '<img src="x" onerror="alert(1)">' }} label="Details" />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("region").textContent).toContain('<img src=\\"x\\" onerror=\\"alert(1)\\">');
  });

  it("says when there is nothing to show or the value is not JSON", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(formatJson(circular)).toBeUndefined();
    expect(formatJson(10n)).toBeUndefined();

    render(
      <>
        <JsonView value={null} label="A" />
        <JsonView value={{}} label="B" />
        <JsonView value={circular} label="C" />
      </>,
    );
    expect(screen.getAllByText(JSON_STRINGS.empty)).toHaveLength(2);
    expect(screen.getByText(JSON_STRINGS.unreadable)).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("MaskedValue", () => {
  it("shows only the prefix and the last characters, and reads them out", () => {
    const { container } = render(
      <>
        <MaskedValue label="IBAN" last4="7947" />
        <MaskedValue label="Secret key" prefix="sk_test_4f9K" last4="Df90" />
        <MaskedValue label="Client secret" last4={null} />
      </>,
    );
    const values = [...container.querySelectorAll("[data-masked]")];
    expect(values.map((value) => value.querySelector("[aria-hidden]")?.textContent)).toEqual([
      "••••7947",
      "sk_test_4f9K••••Df90",
      "••••",
    ]);
    expect(values.map((value) => value.querySelector(".sr-only")?.textContent)).toEqual([
      "IBAN ending in 7947",
      "Secret key ending in Df90",
      "Client secret, hidden",
    ]);
  });
});

describe("Money and DateTime", () => {
  it("formats decimal strings with Intl without going through a float", () => {
    expect(formatMoney({ amount: "1234.50", currency: "EUR" })).toBe("€1,234.50");
    expect(formatMoney({ amount: "-12.30", currency: "EUR" })).toBe("-€12.30");
    expect(formatMoney({ amount: "1500", currency: "JPY" })).toBe("¥1,500");
    // A JS number would round both of these.
    expect(formatMoney({ amount: "12345678901234567.89", currency: "EUR" })).toBe(
      "€12,345,678,901,234,567.89",
    );
    expect(formatMoney({ amount: "0.1234", currency: "EUR" })).toBe("€0.1234");
    expect(formatMoney({ amount: "1e3", currency: "EUR" })).toBeUndefined();
    expect(formatMoney({ amount: "10.00", currency: "euro" })).toBeUndefined();
  });

  it("renders an amount in a data element with its exact value, or the raw value when it cannot be formatted", () => {
    render(
      <>
        <Money value={{ amount: "49.00", currency: "EUR" }} />
        <Money value={{ amount: "abc", currency: "EUR" }} />
      </>,
    );
    const amount = screen.getByText("€49.00");
    expect(amount.tagName).toBe("DATA");
    expect(amount.getAttribute("value")).toBe("49.00");
    expect(screen.getByText("abc EUR")).toBeTruthy();
  });

  it("formats an instant with Intl in an explicit time zone, UTC by default", () => {
    expect(formatDateTime("2026-10-14T08:14:03Z")).toBe("Oct 14, 2026, 08:14 AM UTC");
    expect(formatDateTime("2026-10-14T08:14:03Z", { timeZone: "Europe/Oslo" })).toBe(
      "Oct 14, 2026, 10:14 AM GMT+2",
    );
    expect(formatDateTime("2026-10-14T23:30:00Z", { mode: "date", timeZone: "Europe/Oslo" })).toBe(
      "Oct 15, 2026",
    );
    expect(formatDateTime("not a date")).toBeUndefined();
    expect(formatDateTime("2026-10-14T08:14:03Z", { timeZone: "Mars/Olympus" })).toBeUndefined();

    render(<DateTime value="2026-10-14T08:14:03Z" mode="date" />);
    const time = screen.getByText("Oct 14, 2026");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-10-14T08:14:03Z");
  });
});

describe("StatusBadge", () => {
  it("names each status in words with its tone", () => {
    render(
      <>
        <StatusBadge kind="tenant" status="suspended" />
        <StatusBadge kind="job" status="failed" />
        <StatusBadge kind="bullmq" status="waiting-children" />
        <StatusBadge kind="amadeusOffice" status="available" />
        <StatusBadge kind="stripeEvent" status="ignored" />
        <StatusBadge kind="account" status="locked" />
        <StatusBadge kind="settlement" status="carried_forward" />
      </>,
    );
    const tone = (text: string) => screen.getByText(text).getAttribute("data-tone");
    expect(tone("Suspended")).toBe("warning");
    expect(tone("Failed")).toBe("danger");
    expect(tone("Waiting for children")).toBe("neutral");
    expect(tone("Available")).toBe("success");
    expect(tone("Ignored")).toBe("warning");
    expect(tone("Locked")).toBe("warning");
    expect(tone("Carried forward")).toBe("neutral");
  });

  it("still renders a status the admin does not know yet", () => {
    // A newer API may add a status before the admin has its label.
    render(<StatusBadge kind="tenant" status={"archived_by-owner" as "active"} />);
    expect(screen.getByText("archived by owner").getAttribute("data-tone")).toBe("neutral");
  });
});

describe("ConfirmDialog", () => {
  function renderDialog(onConfirm: () => void): void {
    render(
      <ConfirmDialog
        trigger={<Button>Retry</Button>}
        title="Retry this job?"
        description="A new provision job of the same OTA starts."
        confirmLabel="Retry job"
        destructive={false}
        onConfirm={onConfirm}
      />,
    );
  }

  it("runs the action only after confirmation", async () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Retry this job?" }, UI_WAIT);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry job" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), UI_WAIT);
  });

  it("does nothing when cancelled", async () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", {}, UI_WAIT)).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), UI_WAIT);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
