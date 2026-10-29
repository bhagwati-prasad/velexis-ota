// @vitest-environment happy-dom
import type { ColumnDef } from "@tanstack/react-table";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the platform API -------------------------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/dashboard",
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
}));

const api = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  PATCH: vi.fn(),
  DELETE: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ platformApi: vi.fn(() => Promise.resolve(api)) }));

import SignedInLayout from "@/app/(app)/layout";
import { stepUp } from "@/app/(app)/step-up-actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { DataTable } from "@/components/data-table";
import { DateTime, formatDateTime } from "@/components/date-time";
import { FormErrorSummary } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Money, formatMoney } from "@/components/money";
import { OtaSwitcher } from "@/components/ota-switcher";
import { SecretRevealPanel } from "@/components/secret-reveal-panel";
import { SideNav } from "@/components/side-nav";
import { StatusBadge } from "@/components/status-badge";
import { StepUpDialog, useStepUpAction } from "@/components/step-up-dialog";
import { TenantBanner } from "@/components/tenant-banner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ApiError } from "@/lib/api";
import type { AccountMembership, MilestoneFeatures, TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, type PortalSession } from "@/lib/session";
import { ERROR_MESSAGES, SECRET_STRINGS, STEP_UP_STRINGS } from "@/lib/strings";

// ---- Builders ------------------------------------------------------------------------------------------------

const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const SECOND_TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5G";

const FEATURES_OFF: MilestoneFeatures = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

function membership(overrides: Partial<AccountMembership> = {}): AccountMembership {
  return {
    membershipId: "stf_01JA2ZA1C5E9G3J7K2M6P0R4T8",
    tenantId: TENANT_ID,
    tenantKey: "acme",
    tenantName: "Acme Travel",
    tenantStatus: "active",
    role: "owner",
    ...overrides,
  };
}

type Account = PortalSession["account"];

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "anna.berg@example.com",
    emailVerified: true,
    fullName: "Anna Berg",
    locale: "en",
    timeZone: "Europe/Oslo",
    mfaEnabled: true,
    mfaEnabledAt: "2026-10-03T09:12:44Z",
    isPlatformAdmin: false,
    createdAt: "2026-10-01T10:02:17Z",
    version: 3,
    memberships: [membership()],
    features: FEATURES_OFF,
    ...overrides,
  };
}

/** A new session as `stepUp` answers it; the token values are dummies. */
function steppedUpSession(): PortalSession {
  return {
    accessToken: "stepped-up-access-token",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "stepped-up-refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
    account: account(),
  };
}

function apiError(code: ApiError["code"], status: number): { error: ApiError } {
  return { error: { code, status, fieldErrors: [], details: {} } };
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

beforeEach(() => {
  navigation.pathname = "/dashboard";
  navigation.redirect.mockClear();
  for (const method of Object.values(api)) {
    method.mockReset();
  }
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

// ---- Navigation and shell -------------------------------------------------------------------------------------

describe("SideNav", () => {
  it.each<[TenantRole, string[]]>([
    ["owner", ["Overview", "API keys", "Domains", "Amadeus", "Payments", "Team", "Billing", "Settings"]],
    ["admin", ["Overview", "API keys", "Domains", "Amadeus", "Payments", "Team", "Settings"]],
    ["agent", ["Overview", "Domains"]],
    ["finance", ["Overview", "Domains", "Amadeus", "Payments", "Billing"]],
    ["viewer", ["Overview", "Domains"]],
  ])("[PFE-003 AC1] renders the OTA entries of the %s role", (role, expected) => {
    navigation.pathname = `/otas/${TENANT_ID}`;
    render(<SideNav memberships={[membership({ role })]} features={FEATURES_OFF} />);

    const ota = screen.getByRole("region", { name: /Acme Travel/ });
    expect(linkNames(ota)).toEqual(expected);
    if (role === "viewer") {
      for (const hidden of [/API keys/, /Team/, /Billing/, /Amadeus/, /Payments/]) {
        expect(screen.queryByRole("link", { name: hidden })).toBeNull();
      }
    }
    if (role === "finance") {
      expect(screen.getByRole("link", { name: "Billing" }).getAttribute("href")).toBe(
        `/otas/${TENANT_ID}/billing`,
      );
    }
  });

  it("shows the M5 entries only when their switches are on", () => {
    navigation.pathname = `/otas/${TENANT_ID}`;
    const { rerender } = render(<SideNav memberships={[membership()]} features={FEATURES_OFF} />);
    expect(screen.queryByRole("link", { name: "Settlements" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Go live" })).toBeNull();

    rerender(
      <SideNav
        memberships={[membership()]}
        features={{ ...FEATURES_OFF, settlements: true, liveSwitch: true }}
      />,
    );
    expect(screen.getByRole("link", { name: "Settlements" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Payout account" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go live" })).toBeTruthy();
  });

  it("marks the current page and shows only the account entries outside an OTA", () => {
    navigation.pathname = `/otas/${TENANT_ID}/team`;
    const { unmount } = render(<SideNav memberships={[membership()]} features={FEATURES_OFF} />);
    expect(screen.getByRole("link", { name: "Team" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
    unmount();

    navigation.pathname = "/account/security";
    render(<SideNav memberships={[membership()]} features={FEATURES_OFF} />);
    expect(screen.queryByRole("region", { name: /Acme Travel/ })).toBeNull();
    expect(linkNames(screen.getByRole("navigation"))).toEqual(["My OTAs", "Profile", "Security"]);
    expect(screen.getByRole("link", { name: "Security" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows no OTA entries for an OTA the account is not a member of", () => {
    navigation.pathname = `/otas/${SECOND_TENANT_ID}/api-keys`;
    render(<SideNav memberships={[membership()]} features={FEATURES_OFF} />);
    expect(screen.queryByRole("link", { name: "API keys" })).toBeNull();
  });
});

describe("OtaSwitcher", () => {
  it("lists every membership and links each OTA, the set-up page while it is being set up", async () => {
    navigation.pathname = `/otas/${TENANT_ID}/team`;
    render(
      <OtaSwitcher
        memberships={[
          membership(),
          membership({
            membershipId: "stf_01JA2ZA1C5E9G3J7K2M6P0R4T9",
            tenantId: SECOND_TENANT_ID,
            tenantKey: "nordic",
            tenantName: "Nordic Trips",
            tenantStatus: "provisioning",
            role: "viewer",
          }),
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Switch OTA: Acme Travel" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      `/otas/${TENANT_ID}`,
      `/otas/${SECOND_TENANT_ID}/setup`,
      "/dashboard",
      "/otas/new",
    ]);
    expect(items[0]?.getAttribute("aria-current")).toBe("page");
    expect(items[1]?.textContent).toContain("nordic · Viewer");
    expect(items[1]?.textContent).toContain("Setting up");
  });

  it("asks to choose an OTA outside one, and says when there is none", async () => {
    render(<OtaSwitcher memberships={[]} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Switch OTA: Choose an OTA" }), { key: "Enter" });

    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("You are not a member of any OTA yet.");
  });
});

describe("(app) layout and AppShell (the signed-in shell)", () => {
  it("loads getMe once and renders the shell with the account, the switcher, the navigation and the page", async () => {
    navigation.pathname = `/otas/${TENANT_ID}`;
    api.GET.mockResolvedValue({ data: account({ memberships: [membership({ role: "finance" })] }) });

    render(await SignedInLayout({ children: <p>Page body</p> }));

    expect(api.GET).toHaveBeenCalledTimes(1);
    expect(api.GET).toHaveBeenCalledWith("/v1/me");
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(main.textContent).toBe("Page body");
    expect(screen.getByText("anna.berg@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch OTA: Acme Travel" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Billing" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "API keys" })).toBeNull();
    const signOut = screen.getByRole("button", { name: "Sign out" }).closest("form");
    expect(signOut?.getAttribute("action")).toBe("/sign-out");
    expect(signOut?.getAttribute("method")).toBe("post");
  });

  it("sends a session the API refuses to /sign-in and an unverified account to /verify-pending", async () => {
    api.GET.mockResolvedValueOnce(apiError("UNAUTHENTICATED", 401));
    await expect(SignedInLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT /sign-in");

    api.GET.mockResolvedValueOnce({ data: account({ emailVerified: false }) });
    await expect(SignedInLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT /verify-pending");
  });

  it("shows the portal's message, not the shell, when the account cannot be loaded", async () => {
    api.GET.mockResolvedValue(apiError("SERVICE_UNAVAILABLE", 503));

    render(await SignedInLayout({ children: <p>Page body</p> }));

    expect(screen.getByRole("main").textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(screen.queryByText("Page body")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

// ---- Step-up --------------------------------------------------------------------------------------------------

type SaveState = { readonly saved: boolean; readonly stepUp?: true };

function SaveForm({
  action,
}: {
  readonly action: (state: SaveState, payload: FormData) => Promise<SaveState>;
}) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(action, { saved: false });
  return (
    <>
      <form action={dispatch}>
        <input name="legalName" defaultValue="Acme Travel AS" aria-label="Legal name" />
        <Button type="submit" disabled={isPending}>
          Save
        </Button>
        {state.saved ? <p role="status">Saved</p> : null}
      </form>
      {stepUpDialog}
    </>
  );
}

function submit(name: string | RegExp): void {
  const button = screen.getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

describe("StepUpDialog", () => {
  it("[PFE-003 AC2] asks for a TOTP code on REAUTH_REQUIRED, steps up, stores the new tokens and re-submits", async () => {
    const order: string[] = [];
    const store = cookieStore();
    store.set.mockImplementation((name: string) => order.push(`cookie ${name}`));
    api.POST.mockImplementation((path: string) => {
      order.push(`POST ${path}`);
      return Promise.resolve({ data: steppedUpSession() });
    });
    const payloads: FormData[] = [];
    const save = vi.fn((_state: SaveState, payload: FormData): Promise<SaveState> => {
      payloads.push(payload);
      order.push(`save ${payloads.length}`);
      return Promise.resolve(payloads.length === 1 ? { saved: false, stepUp: true } : { saved: true });
    });
    render(<SaveForm action={save} />);

    submit("Save");
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title });
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), {
      target: { value: "492039" },
    });
    submit(STEP_UP_STRINGS.submit);

    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The code went to stepUp, the new session reached the cookies, and only then the action ran again.
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(api.POST).toHaveBeenCalledWith("/v1/auth/step-up", { body: { code: "492039" } });
    expect(order).toEqual([
      "save 1",
      "POST /v1/auth/step-up",
      `cookie ${ACCESS_TOKEN_COOKIE}`,
      `cookie ${REFRESH_TOKEN_COOKIE}`,
      "save 2",
    ]);
    const access = store.set.mock.calls.find(([name]) => name === ACCESS_TOKEN_COOKIE);
    expect(access?.[1]).toBe("stepped-up-access-token");
    expect(access?.[2]).toMatchObject({ httpOnly: true, secure: true, path: "/" });
    // The re-submission carries the original submission's data.
    expect(save).toHaveBeenCalledTimes(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(payloads[1]?.get("legalName")).toBe("Acme Travel AS");
  });

  it("keeps the dialog open with the message at the field when the code is wrong, and does not re-submit", async () => {
    cookieStore();
    api.POST.mockResolvedValue(apiError("MFA_CODE_INVALID", 401));
    const save = vi.fn((): Promise<SaveState> => Promise.resolve({ saved: false, stepUp: true }));
    render(<SaveForm action={save} />);

    submit("Save");
    const dialog = await screen.findByRole("dialog");
    const code = within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel);
    fireEvent.change(code, { target: { value: "000000" } });
    submit(STEP_UP_STRINGS.submit);

    await waitFor(() => expect(descriptionsOf(code)).toContain(ERROR_MESSAGES.MFA_CODE_INVALID));
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(nextHeaders.cookies).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("refuses a code that is not 6 digits without calling the API", async () => {
    const result = await stepUp({ status: "idle" }, formData({ code: "12ab" }));
    expect(result).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      fieldError: STEP_UP_STRINGS.codeFormat,
    });
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("accepts a code typed with spaces and shows other failures above the field", async () => {
    api.POST.mockResolvedValue(apiError("MFA_REQUIRED", 403));
    const result = await stepUp({ status: "idle" }, formData({ code: " 492 039 " }));
    expect(api.POST).toHaveBeenCalledWith("/v1/auth/step-up", { body: { code: "492039" } });
    expect(result).toEqual({ status: "failed", code: "MFA_REQUIRED", message: ERROR_MESSAGES.MFA_REQUIRED });
  });

  it("closes without re-submitting when cancelled, and opens again on the next step-up request", async () => {
    const save = vi.fn((): Promise<SaveState> => Promise.resolve({ saved: false, stepUp: true }));
    render(<SaveForm action={save} />);

    submit("Save");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: STEP_UP_STRINGS.cancel }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
    expect(api.POST).not.toHaveBeenCalled();

    submit("Save");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("reports a verification once, however often the parent re-renders", async () => {
    cookieStore();
    api.POST.mockResolvedValue({ data: steppedUpSession() });
    const onVerified = vi.fn();
    const { rerender } = render(<StepUpDialog open onVerified={() => onVerified()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(STEP_UP_STRINGS.codeLabel), { target: { value: "492039" } });
    submit(STEP_UP_STRINGS.submit);
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    rerender(<StepUpDialog open onVerified={() => onVerified()} onCancel={vi.fn()} />);
    rerender(<StepUpDialog open onVerified={() => onVerified()} onCancel={vi.fn()} />);

    expect(onVerified).toHaveBeenCalledTimes(1);
  });
});

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

// ---- Values shown once ----------------------------------------------------------------------------------------

describe("SecretRevealPanel and CopyField", () => {
  const SECRET = "sk_test_51PFE003DummyValueNeverReal0123456789";

  it("[PFE-003 AC3] keeps the values in memory only: nothing in localStorage, sessionStorage, cookies or the URL", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const urlBefore = location.href;
    const onDismiss = vi.fn();

    render(
      <SecretRevealPanel
        title="Your new secret key"
        secrets={[
          { label: "Secret key", value: SECRET },
          { label: "Publishable key", value: "pk_test_51PFE003DummyValue" },
        ]}
        onDismiss={onDismiss}
      />,
    );
    expect((screen.getByLabelText("Secret key") as HTMLInputElement).value).toBe(SECRET);
    fireEvent.click(screen.getByRole("button", { name: "Copy Secret key" }));
    expect(await screen.findByText(SECRET_STRINGS.copied)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: SECRET_STRINGS.dismiss }));

    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(cookieWrite).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(location.href).toBe(urlBefore);
    // After "I have stored it" the values are gone from the page.
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(screen.getByRole("status").textContent).toBe(SECRET_STRINGS.dismissed);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("warns that the values cannot be shown again and never puts them in a form submission", () => {
    render(
      <form aria-label="Keys">
        <SecretRevealPanel
          title="Recovery codes"
          secrets={[{ label: "Code 1", value: "7KQ4-M2XP-9TRW-H5ZD" }]}
        >
          <p>Each code works once.</p>
        </SecretRevealPanel>
      </form>,
    );

    const panel = screen.getByRole("region", { name: "Recovery codes" });
    expect(panel.textContent).toContain(SECRET_STRINGS.warningTitle);
    expect(panel.textContent).toContain("Velexis cannot show this again.");
    expect(panel.textContent).toContain("Each code works once.");
    const field = screen.getByLabelText("Code 1") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.getAttribute("name")).toBeNull();
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect([...new FormData(screen.getByRole("form", { name: "Keys" }) as HTMLFormElement).keys()]).toEqual(
      [],
    );
  });

  it("says when copying did not work", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
    });
    render(<CopyField label="Secret key" value="sk_test_dummy" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy Secret key" }));

    expect(await screen.findByText(SECRET_STRINGS.copyFailed)).toBeTruthy();
    const input = screen.getByLabelText("Secret key");
    expect(descriptionsOf(input)).toEqual([SECRET_STRINGS.copyFailed]);
  });
});

// ---- Forms ----------------------------------------------------------------------------------------------------

describe("FormField and FormErrorSummary", () => {
  it("[PFE-003 AC4] announces every field error through aria-describedby and marks the control invalid", () => {
    const errors = {
      name: "Enter the OTA name.",
      supportEmail: "Enter a valid e-mail address.",
      country: "Choose a country.",
    };
    render(
      <form>
        <FormField label="OTA name" name="name" error={errors.name} />
        <FormField
          label="Support e-mail"
          name="supportEmail"
          type="email"
          description="Customers see this address."
          error={errors.supportEmail}
        />
        <FormField label="Country" name="country" error={errors.country}>
          {(control) => (
            <select {...control} defaultValue="">
              <option value="">Choose…</option>
              <option value="NO">Norway</option>
            </select>
          )}
        </FormField>
        <FormField label="Legal name" name="legalName" description="As registered." />
      </form>,
    );

    const cases: [string, string[]][] = [
      ["OTA name", [errors.name]],
      ["Support e-mail", ["Customers see this address.", errors.supportEmail]],
      ["Country", [errors.country]],
    ];
    for (const [label, expected] of cases) {
      const control = screen.getByLabelText(label);
      expect(descriptionsOf(control), label).toEqual(expected);
      expect(control.getAttribute("aria-invalid"), label).toBe("true");
    }
    const valid = screen.getByLabelText("Legal name");
    expect(descriptionsOf(valid)).toEqual(["As registered."]);
    expect(valid.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByLabelText("OTA name").id).toBe(fieldId("name"));
    expect(screen.getByLabelText("OTA name").getAttribute("name")).toBe("name");
  });

  it("[PFE-003 AC4] links an error that appears after a submission", () => {
    const { rerender } = render(<FormField label="OTA name" name="name" />);
    expect(screen.getByLabelText("OTA name").getAttribute("aria-describedby")).toBeNull();

    rerender(<FormField label="OTA name" name="name" error="Enter the OTA name." />);

    expect(descriptionsOf(screen.getByLabelText("OTA name"))).toEqual(["Enter the OTA name."]);
  });

  it("takes the focus when errors arrive and moves it to the field of an entry", () => {
    const errors = [
      { message: "Enter the OTA name.", fieldId: fieldId("name") },
      { message: "Try again later." },
    ];
    const { rerender } = render(
      <>
        <FormErrorSummary errors={[]} />
        <FormField label="OTA name" name="name" />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <>
        <FormErrorSummary errors={errors} />
        <FormField label="OTA name" name="name" error="Enter the OTA name." />
      </>,
    );

    const summary = screen.getByRole("alert", { name: "There is a problem" });
    expect(document.activeElement).toBe(summary);
    expect(summary.textContent).toContain("Try again later.");
    const link = within(summary).getByRole("link", { name: "Enter the OTA name." });
    expect(link.getAttribute("href")).toBe("#field-name");
    fireEvent.click(link);
    expect(document.activeElement).toBe(screen.getByLabelText("OTA name"));
  });
});

// ---- Formatting and status ------------------------------------------------------------------------------------

describe("Money and DateTime", () => {
  it("formats decimal strings with Intl without going through a float", () => {
    expect(formatMoney({ amount: "1234.50", currency: "EUR" })).toBe("€1,234.50");
    expect(formatMoney({ amount: "49", currency: "USD" })).toBe("$49.00");
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

  it("renders an amount in a data element with its exact value", () => {
    render(<Money value={{ amount: "49.00", currency: "EUR" }} />);
    const amount = screen.getByText("€49.00");
    expect(amount.tagName).toBe("DATA");
    expect(amount.getAttribute("value")).toBe("49.00");
  });

  it("falls back to the raw amount and code when they cannot be formatted", () => {
    render(<Money value={{ amount: "abc", currency: "EUR" }} />);
    expect(screen.getByText("abc EUR")).toBeTruthy();
  });

  it("formats an instant with Intl in an explicit time zone", () => {
    expect(formatDateTime("2026-10-14T08:14:03Z")).toBe("Oct 14, 2026, 08:14 AM UTC");
    expect(formatDateTime("2026-10-14T08:14:03Z", { timeZone: "Europe/Oslo" })).toBe(
      "Oct 14, 2026, 10:14 AM GMT+2",
    );
    expect(formatDateTime("2026-10-14T23:30:00Z", { mode: "date", timeZone: "Europe/Oslo" })).toBe(
      "Oct 15, 2026",
    );
    expect(formatDateTime("not a date")).toBeUndefined();
    expect(formatDateTime("2026-10-14T08:14:03Z", { timeZone: "Mars/Olympus" })).toBeUndefined();
  });

  it("renders a time element with the machine-readable instant", () => {
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
        <StatusBadge kind="tenant" status="active" />
        <StatusBadge kind="job" status="failed" />
        <StatusBadge kind="amadeusConnection" status="pending_verification" />
        <StatusBadge kind="domain" status="verified" />
        <StatusBadge kind="settlement" status="carried_forward" />
      </>,
    );
    const badge = (text: string) => screen.getByText(text);
    expect(badge("Active").getAttribute("data-tone")).toBe("success");
    expect(badge("Failed").getAttribute("data-tone")).toBe("danger");
    expect(badge("Pending").getAttribute("data-tone")).toBe("warning");
    expect(badge("Verified").getAttribute("data-tone")).toBe("success");
    expect(badge("Carried forward").getAttribute("data-tone")).toBe("neutral");
  });

  it("still renders a status the portal does not know yet", () => {
    // A newer API may add a status before the portal has its label.
    render(<StatusBadge kind="tenant" status={"archived_by_owner" as "active"} />);
    expect(screen.getByText("archived by owner").getAttribute("data-tone")).toBe("neutral");
  });
});

describe("TenantBanner", () => {
  const tenant = {
    id: TENANT_ID,
    status: "active",
    suspensionReason: null,
    billingNotice: null,
    storefrontEnvironment: "live",
  } as const;

  it("shows nothing for an active live OTA without a billing notice", () => {
    const { container } = render(<TenantBanner tenant={tenant} role="owner" />);
    expect(container.innerHTML).toBe("");
  });

  it("explains a billing suspension and links to billing for roles that see billing", () => {
    const suspended = { ...tenant, status: "suspended", suspensionReason: "billing" } as const;
    const { unmount } = render(<TenantBanner tenant={suspended} role="finance" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This OTA is suspended");
    expect(alert.textContent).toContain("A subscription payment failed.");
    expect(within(alert).getByRole("link", { name: "Go to billing" }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/billing`,
    );
    unmount();

    render(<TenantBanner tenant={suspended} role="viewer" />);
    expect(screen.getByRole("alert").textContent).toContain("A subscription payment failed.");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the reason of other suspensions, past_due, trial_ending and test mode", () => {
    render(
      <TenantBanner
        tenant={{
          ...tenant,
          status: "suspended",
          suspensionReason: "abuse",
          billingNotice: "past_due",
          storefrontEnvironment: "test",
        }}
        role="owner"
      />,
    );
    const notices = screen.getByRole("region", { name: "OTA notices" });
    expect(
      [...notices.querySelectorAll("[data-notice]")].map((notice) => notice.getAttribute("data-notice")),
    ).toEqual(["suspended", "past_due", "test_mode"]);
    expect(notices.textContent).toContain("report of misuse");
    expect(notices.textContent).toContain("A payment failed");
    expect(notices.textContent).toContain("Test mode");
    cleanup();

    render(<TenantBanner tenant={{ ...tenant, billingNotice: "trial_ending" }} role="owner" />);
    expect(screen.getByRole("status").textContent).toContain("Your trial ends soon");
  });
});

// ---- Dialogs and tables ---------------------------------------------------------------------------------------

describe("ConfirmDialog", () => {
  function renderDialog(onConfirm: () => void): void {
    render(
      <ConfirmDialog
        trigger={<Button variant="destructive">Revoke</Button>}
        title="Revoke this key?"
        description="Requests with this key stop working within 60 seconds. This cannot be undone."
        confirmLabel="Revoke key"
        onConfirm={onConfirm}
      />,
    );
  }

  it("runs the action only after confirmation", async () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Revoke this key?" });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("does nothing when cancelled", async () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("DataTable", () => {
  interface Invoice {
    readonly id: string;
    readonly number: string;
    readonly total: { readonly amount: string; readonly currency: string };
  }
  const columns: ColumnDef<Invoice, unknown>[] = [
    { accessorKey: "number", header: "Number" },
    { id: "total", header: "Total", cell: ({ row }) => <Money value={row.original.total} /> },
  ];

  it("renders a captioned table with a header row and one row per item", () => {
    render(
      <DataTable
        caption="Invoices"
        columns={columns}
        data={[
          { id: "inv_1", number: "VX-0001", total: { amount: "49.00", currency: "EUR" } },
          { id: "inv_2", number: "VX-0002", total: { amount: "490.00", currency: "EUR" } },
        ]}
        getRowId={(row) => row.id}
      />,
    );

    const table = screen.getByRole("table", { name: "Invoices" });
    const rows = within(table).getAllByRole("row");
    expect(rows.map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      ["Number", "Total"],
      ["VX-0001", "€49.00"],
      ["VX-0002", "€490.00"],
    ]);
    expect(within(table).getAllByRole("columnheader")[0]?.getAttribute("scope")).toBe("col");
  });

  it("says so when there is nothing to list", () => {
    render(<DataTable caption="Invoices" columns={columns} data={[]} emptyMessage="No invoices yet." />);
    expect(within(screen.getByRole("table")).getByText("No invoices yet.")).toBeTruthy();
  });

  it("[FIX-W31-PLATFORM AC4] scrolls a wide table in a container that takes the keyboard focus and shows it", () => {
    render(<DataTable caption="Invoices" columns={columns} data={[]} />);

    // axe `scrollable-region-focusable` (WCAG 2.1.1): the arrow keys scroll what the keyboard can focus (PFE-015).
    const container = screen.getByRole("table").parentElement as HTMLElement;
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
        <AlertTitle>The payment failed</AlertTitle>
        <AlertDescription>Stripe refused the card.</AlertDescription>
      </Alert>,
    );

    // text-destructive/90 on the card is 4.49:1, under the 4.5:1 of WCAG 1.4.3 (found by the PFE-015 journeys).
    const classes = screen.getByRole("alert").className.split(/\s+/);
    expect(classes).toContain("*:data-[slot=alert-description]:text-destructive");
    expect(classes.filter((name) => /text-destructive\/\d+$/.test(name))).toEqual([]);
    expect(screen.getByText("Stripe refused the card.").dataset["slot"]).toBe("alert-description");
  });
});

describe("DropdownMenuItem", () => {
  it("[FIX-W32-PLATFORM AC3] labels a focused destructive item in the foreground colour on its tint, never the destructive one", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Key actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Edit origins</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Revoke key</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const item = within(screen.getByRole("menu")).getByRole("menuitem", { name: "Revoke key" });
    expect(item.dataset["variant"]).toBe("destructive");
    const classes = item.className.split(/\s+/);
    // text-destructive on bg-destructive/10 over the popover is 4.0:1, under the 4.5:1 of WCAG 1.4.3; text-foreground
    // there is 16.63:1. The look stays: the red label at rest (4.76:1), the tint and the red icon on focus.
    expect(classes).toEqual(
      expect.arrayContaining([
        "data-[variant=destructive]:text-destructive",
        "data-[variant=destructive]:focus:bg-destructive/10",
        "data-[variant=destructive]:*:[svg]:!text-destructive",
        "data-[variant=destructive]:focus:text-foreground",
      ]),
    );
    expect(classes.filter((name) => /(^|:)focus:text-destructive/.test(name))).toEqual([]);
  });
});

describe("destructive Button and Badge", () => {
  it("darken on hover instead of fading, so their white text keeps 4.5:1", () => {
    render(
      <>
        <Button variant="destructive">Reset two-factor</Button>
        <Badge variant="destructive">Failed</Badge>
      </>,
    );

    // bg-destructive/90 over a white page is #ea1a23: 4.49:1 for white text, under the 4.5:1 of WCAG 1.4.3 (axe found
    // it on a hovered button in e2e run 40938272523). Mixing in 10% black is #c90008: 6.03:1; at rest 4.76:1.
    const hover = "hover:bg-[color-mix(in_oklch,var(--destructive),black_10%)]";
    const button = screen.getByRole("button", { name: "Reset two-factor" }).className.split(/\s+/);
    const badge = screen.getByText("Failed").className.split(/\s+/);
    expect(button).toContain(hover);
    expect(badge).toContain(`[a&]:${hover}`);
    expect([...button, ...badge].filter((name) => /hover:bg-destructive\/\d+$/.test(name))).toEqual([]);
  });
});

describe("Tabs", () => {
  it("[FIX-W32-PLATFORM AC3] sets the tab list's text in the foreground colour on the muted background, never the muted one", () => {
    render(
      <Tabs defaultValue="test">
        <TabsList aria-label="Environments">
          <TabsTrigger value="test">Test</TabsTrigger>
          <TabsTrigger value="live">Live</TabsTrigger>
        </TabsList>
        <TabsContent value="test">The test keys.</TabsContent>
      </Tabs>,
    );

    // text-muted-foreground on bg-muted is 4.34:1, under the 4.5:1 of WCAG 1.4.3; text-foreground there is 18.15:1.
    const list = screen.getByRole("tablist", { name: "Environments" });
    const classes = list.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["bg-muted", "text-foreground"]));
    expect(classes.filter((name) => /(^|:)text-muted-foreground$/.test(name))).toEqual([]);
    // The triggers keep the colour they had, so the tabs look as before.
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className.split(/\s+/)).toContain("text-foreground");
    }
  });
});
