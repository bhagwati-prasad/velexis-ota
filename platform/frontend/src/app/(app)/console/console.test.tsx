// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the configuration; the real API client talks to a mocked fetch ----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/console",
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
  notFound: navigation.notFound,
}));

const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => nextCache);

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import SecurityPage from "@/app/(app)/account/security/page";
import ConsolePickerPage from "@/app/(app)/console/page";
import DashboardPage from "@/app/(app)/dashboard/page";
import OtaDashboardPage from "@/app/(app)/otas/[tenantId]/page";
import { consoleProblemOf, consoleProblemPath } from "@/components/open-console-button";
import type { TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import { CONSOLE_STRINGS, ERROR_MESSAGES, TENANT_BANNER_STRINGS } from "@/lib/strings";

// ---- Builders (dummy values only: no real token) -----------------------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type TenantSummary = Schemas["TenantSummary"];

const ACCESS_TOKEN = "pfe017-dummy-access-token";
const ACME = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const NORDIC = "ten_01JA2ZC3D7F1H5K9M3P7S1V5X9";
const ATLAS = "ten_01JA2ZD8E2G6J0K4N8Q2S6W0Y4";

function summary(id: string, name: string, overrides: Partial<TenantSummary> = {}): TenantSummary {
  return {
    id,
    key: name.toLowerCase().replace(/[^a-z]/g, ""),
    name,
    status: "active",
    role: "owner",
    planCode: "early_access",
    storefrontUrl: `https://${name.toLowerCase().replace(/[^a-z]/g, "")}.ota.example.com/`,
    storefrontEnvironment: "test",
    ...overrides,
  };
}

const THREE_OTAS = [
  summary(ACME, "Acme Travel"),
  summary(NORDIC, "Nordic Trips", { role: "agent" }),
  summary(ATLAS, "Atlas Flights", { role: "viewer", status: "suspended" }),
];

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: ACME,
    key: "acme",
    name: "Acme Travel",
    legalName: null,
    status: "active",
    suspensionReason: null,
    billingNotice: null,
    planCode: "early_access",
    defaultCurrency: "EUR",
    countryCode: "NO",
    timeZone: "Europe/Oslo",
    supportEmail: null,
    storefrontEnvironment: "test",
    liveEnabledAt: null,
    primaryHost: "acme.ota.example.com",
    schemaVersion: "0002_m1",
    createdAt: "2026-10-14T08:20:11Z",
    activatedAt: "2026-10-14T08:21:02Z",
    version: 4,
    myRole: "owner",
    ...overrides,
  };
}

function account(): Schemas["Account"] {
  return {
    id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "anna.berg@example.com",
    emailVerified: true,
    fullName: "Anna Berg",
    locale: "en-GB",
    timeZone: "Europe/Oslo",
    mfaEnabled: false,
    mfaEnabledAt: null,
    isPlatformAdmin: false,
    createdAt: "2026-07-14T08:20:11Z",
    version: 3,
    memberships: [],
    features: {
      stripeBilling: false,
      ownStripe: false,
      settlements: false,
      ownAmadeus: false,
      customDomains: false,
      liveSwitch: false,
    },
  };
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiError(code: string, status: number): Response {
  return json(
    { error: { code, message: "The API's own text, never shown", status, requestId: "req_api" } },
    status,
  );
}

type Route = () => Response;

/** Answers each call by `METHOD /path`: by default three OTAs, the account, the Acme OTA and its checklist. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    "GET /v1/tenants": () => json({ data: THREE_OTAS }, 200),
    "GET /v1/me": () => json(account(), 200),
    "GET /v1/me/sessions": () => json({ data: [] }, 200),
    "GET /v1/plans": () => json({ data: [] }, 200),
    [`GET /v1/tenants/${ACME}`]: () => json(tenant(), 200),
    [`GET /v1/tenants/${ACME}/onboarding`]: () => json({ items: [] }, 200),
    ...overrides,
  };
  fetchMock.mockImplementation((input) => {
    const route = table[`${input.method} ${new URL(input.url).pathname}`];
    return route === undefined
      ? Promise.reject(new Error(`unexpected call ${input.method} ${input.url}`))
      : Promise.resolve(route());
  });
}

function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.redirect.mockClear();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({ "x-forwarded-for": "203.0.113.7", "user-agent": "Mozilla/5.0 (PFE-017 test)" }),
  );
  nextHeaders.cookies.mockResolvedValue({
    get: (name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined),
    has: (name: string) => name === ACCESS_TOKEN_COOKIE,
    getAll: () => [{ name: ACCESS_TOKEN_COOKIE, value: ACCESS_TOKEN }],
  });
  routes();
}

/** The search parameters of a page, as Next.js 15 passes them. */
function query(values: Record<string, string>): Promise<Record<string, string>> {
  return Promise.resolve(values);
}

function params(tenantId = ACME): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

/** The "Open console" forms of the page: where each posts, with which method, and what it would send. */
function consoleForms(): { action: string; method: string; fields: number; button: string }[] {
  return [...document.querySelectorAll("form")]
    .filter((form) => form.getAttribute("action")?.endsWith("/console/launch") === true)
    .map((form) => ({
      action: form.getAttribute("action") ?? "",
      method: form.getAttribute("method") ?? "",
      fields: form.querySelectorAll("input, select, textarea").length,
      button: within(form).getByRole("button").textContent ?? "",
    }));
}

const launch = (tenantId: string) => `/otas/${tenantId}/console/launch`;

/**
 * The budget of the hook below. The first render of a page in a fresh worker compiles and loads its modules (the
 * shell components, lucide icons, the API client), a second or more alone on a loaded CI runner; the hook takes it,
 * so every test body stays within the default five seconds.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

beforeAll(async () => {
  resetPlatformApi();
  render(await OtaDashboardPage({ params: params(), searchParams: query({}) }));
  cleanup();
  render(await ConsolePickerPage({ searchParams: query({}) }));
  cleanup();
  render(await SecurityPage({ searchParams: query({}) }));
  cleanup();
  render(await DashboardPage());
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- /console ---------------------------------------------------------------------------------------------------------

describe("/console: the console picker", () => {
  it("[PFE-017 AC3] /console?tenant=<id> pre-selects that OTA: first, marked selected, with an Open console form each", async () => {
    render(await ConsolePickerPage({ searchParams: query({ tenant: NORDIC }) }));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(CONSOLE_STRINGS.pickerTitle);
    const items = within(screen.getByRole("list", { name: CONSOLE_STRINGS.pickerListLabel })).getAllByRole(
      "listitem",
    );
    expect(items.map((item) => within(item).getByRole("heading").textContent)).toEqual([
      "Nordic Trips",
      "Acme Travel",
      "Atlas Flights",
    ]);
    // Only the requested OTA is selected.
    const selected = [...document.querySelectorAll('[aria-current="true"]')];
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("aria-labelledby")).toBe(`console-${NORDIC}`);
    expect(within(items[0] as HTMLElement).getByText(CONSOLE_STRINGS.pickerSelected)).toBeTruthy();
    expect(within(items[1] as HTMLElement).queryByText(CONSOLE_STRINGS.pickerSelected)).toBeNull();
    // One POST form per OTA, to its own launch route, with no field: never a link that a prefetch could follow.
    expect(consoleForms()).toEqual([
      { action: launch(NORDIC), method: "post", fields: 0, button: "Open console for Nordic Trips" },
      { action: launch(ACME), method: "post", fields: 0, button: "Open console for Acme Travel" },
      { action: launch(ATLAS), method: "post", fields: 0, button: "Open console for Atlas Flights" },
    ]);
    expect(document.querySelector('a[href*="/console/launch"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Open console for Nordic Trips" })).toBeTruthy();
  });

  it("[PFE-017 AC3] with exactly one OTA shows a single button, selected", async () => {
    routes({ "GET /v1/tenants": () => json({ data: [THREE_OTAS[0]] }, 200) });

    render(await ConsolePickerPage({ searchParams: query({ tenant: ACME }) }));

    expect(screen.queryByRole("list")).toBeNull();
    expect(consoleForms()).toEqual([
      { action: launch(ACME), method: "post", fields: 0, button: "Open console for Acme Travel" },
    ]);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  it("keeps the API's order without a tenant, and selects none", async () => {
    render(await ConsolePickerPage({ searchParams: query({}) }));

    expect(consoleForms().map((form) => form.action)).toEqual([launch(ACME), launch(NORDIC), launch(ATLAS)]);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
    expect(document.querySelector('[data-notice="not-member"]')).toBeNull();
  });

  it("says when the requested OTA is not one of the account's, and lists the account's OTAs", async () => {
    render(await ConsolePickerPage({ searchParams: query({ tenant: "ten_01JA2ZF0G4J8M2P6S0V4Y8B2D6" }) }));

    expect(screen.getByRole("status").textContent).toBe(CONSOLE_STRINGS.pickerNotMember);
    expect(consoleForms()).toHaveLength(3);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });

  it("with one OTA and a requested OTA the account is not a member of, shows the note and the one OTA unselected", async () => {
    routes({ "GET /v1/tenants": () => json({ data: [THREE_OTAS[0]] }, 200) });

    render(await ConsolePickerPage({ searchParams: query({ tenant: NORDIC }) }));

    expect(screen.getByRole("status").textContent).toBe(CONSOLE_STRINGS.pickerNotMember);
    expect(consoleForms()).toEqual([
      { action: launch(ACME), method: "post", fields: 0, button: "Open console for Acme Travel" },
    ]);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
    expect(screen.queryByText(CONSOLE_STRINGS.pickerSelected)).toBeNull();
  });

  it("with one OTA and no requested OTA, shows that one as the choice", async () => {
    routes({ "GET /v1/tenants": () => json({ data: [THREE_OTAS[1]] }, 200) });

    render(await ConsolePickerPage({ searchParams: query({}) }));

    expect(consoleForms().map((form) => form.action)).toEqual([launch(NORDIC)]);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(screen.getByText(CONSOLE_STRINGS.pickerSelected)).toBeTruthy();
  });

  it("ignores a tenant value that is no OTA id", async () => {
    render(await ConsolePickerPage({ searchParams: query({ tenant: "acme" }) }));

    expect(document.querySelector('[data-notice="not-member"]')).toBeNull();
    expect(consoleForms()).toHaveLength(3);
  });

  it("explains an account without an OTA and links to My OTAs", async () => {
    routes({ "GET /v1/tenants": () => json({ data: [] }, 200) });

    render(await ConsolePickerPage({ searchParams: query({}) }));

    expect(screen.getByRole("heading", { name: CONSOLE_STRINGS.pickerEmptyTitle })).toBeTruthy();
    expect(screen.getByRole("link", { name: CONSOLE_STRINGS.pickerDashboardLink }).getAttribute("href")).toBe(
      "/dashboard",
    );
    expect(consoleForms()).toEqual([]);
  });

  it("sends an ended session to sign-in and back to the picker with the same OTA", async () => {
    routes({ "GET /v1/tenants": () => apiError("TOKEN_EXPIRED", 401) });

    await expect(ConsolePickerPage({ searchParams: query({ tenant: ACME }) })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent(`/console?tenant=${ACME}`)}`,
    );
  });

  it("shows the portal's message when the OTAs cannot be loaded", async () => {
    routes({ "GET /v1/tenants": () => apiError("RATE_LIMITED", 429) });

    render(await ConsolePickerPage({ searchParams: query({ tenant: ACME }) }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(CONSOLE_STRINGS.pickerUnavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.RATE_LIMITED);
    expect(alert.textContent).not.toContain("The API's own text");
    expect(consoleForms()).toEqual([]);
  });
});

// ---- The dashboards ----------------------------------------------------------------------------------------------------

describe("Open console on /dashboard and the OTA dashboard", () => {
  it("[PFE-017 AC1] every OTA row of /dashboard has an Open console form posting to its launch route", async () => {
    render(await DashboardPage());

    expect(consoleForms()).toEqual([
      { action: launch(ACME), method: "post", fields: 0, button: "Open console for Acme Travel" },
      { action: launch(NORDIC), method: "post", fields: 0, button: "Open console for Nordic Trips" },
      { action: launch(ATLAS), method: "post", fields: 0, button: "Open console for Atlas Flights" },
    ]);
  });

  it.each<TenantRole>(["owner", "admin", "agent", "finance", "viewer"])(
    "[PFE-017 AC1] the OTA dashboard has an Open console form for a %s",
    async (role) => {
      routes({ [`GET /v1/tenants/${ACME}`]: () => json(tenant({ myRole: role }), 200) });

      render(await OtaDashboardPage({ params: params(), searchParams: query({}) }));

      expect(consoleForms()).toEqual([
        { action: launch(ACME), method: "post", fields: 0, button: CONSOLE_STRINGS.openConsole },
      ]);
      expect(document.querySelector('[data-notice="console"]')).toBeNull();
    },
  );

  it("[PFE-017 AC2] explains a launch refused for a billing suspension, with the billing link for an owner [PF-22 AC3]", async () => {
    routes({
      [`GET /v1/tenants/${ACME}`]: () =>
        json(tenant({ status: "suspended", suspensionReason: "billing" }), 200),
    });

    render(
      await OtaDashboardPage({
        params: params(),
        searchParams: query({ console: "suspended", reason: "billing" }),
      }),
    );

    const notice = document.querySelector('[data-notice="console"]') as HTMLElement;
    expect(notice.textContent).toContain(CONSOLE_STRINGS.problemTitle);
    expect(notice.textContent).toContain(CONSOLE_STRINGS.problems.suspended);
    expect(notice.textContent).toContain(TENANT_BANNER_STRINGS.suspendedReasons.billing);
    expect(
      within(notice).getByRole("link", { name: TENANT_BANNER_STRINGS.billingLink }).getAttribute("href"),
    ).toBe(`/otas/${ACME}/billing`);
  });

  it("[PFE-017 AC2] tells an agent of a billing suspension whom to ask, without the billing link", async () => {
    routes({
      [`GET /v1/tenants/${ACME}`]: () =>
        json(tenant({ status: "suspended", suspensionReason: "billing", myRole: "agent" }), 200),
    });

    render(
      await OtaDashboardPage({
        params: params(),
        searchParams: query({ console: "suspended", reason: "billing" }),
      }),
    );

    const notice = document.querySelector('[data-notice="console"]') as HTMLElement;
    expect(notice.textContent).toContain(CONSOLE_STRINGS.billingAskOwner);
    expect(within(notice).queryByRole("link")).toBeNull();
  });

  it.each([
    ["provisioning", CONSOLE_STRINGS.problems.provisioning],
    ["failed", CONSOLE_STRINGS.problems.failed],
    ["not_active", CONSOLE_STRINGS.problems.not_active],
    ["rate_limited", CONSOLE_STRINGS.problems.rate_limited],
    ["unavailable", CONSOLE_STRINGS.problems.unavailable],
  ])("explains a launch refused with ?console=%s", async (problem, text) => {
    render(await OtaDashboardPage({ params: params(), searchParams: query({ console: problem }) }));

    const notice = document.querySelector('[data-notice="console"]') as HTMLElement;
    expect(notice.textContent).toContain(text);
    expect(within(notice).queryByRole("link")).toBeNull();
  });

  it("ignores a problem the portal does not know", async () => {
    render(await OtaDashboardPage({ params: params(), searchParams: query({ console: "<b>anything</b>" }) }));

    expect(document.querySelector('[data-notice="console"]')).toBeNull();
  });
});

// ---- /account/security ----------------------------------------------------------------------------------------------

describe("MFA_REQUIRED on /account/security", () => {
  it("[PFE-017 AC2] says why the console needs MFA and links back to the picker for that OTA [PF-22 AC3]", async () => {
    render(await SecurityPage({ searchParams: query({ console: "mfa_required", tenant: ACME }) }));

    const notice = document.querySelector('[data-notice="console"]') as HTMLElement;
    expect(notice.textContent).toContain(CONSOLE_STRINGS.problems.mfa_required);
    expect(within(notice).getByRole("link", { name: CONSOLE_STRINGS.openAgain }).getAttribute("href")).toBe(
      `/console?tenant=${ACME}`,
    );
    // The MFA set-up is right below it.
    expect(screen.getByRole("heading", { level: 2, name: "Two-factor authentication" })).toBeTruthy();
  });

  it("shows no console notice without the launch's parameters, nor for another problem", async () => {
    render(await SecurityPage({ searchParams: query({ console: "suspended", tenant: ACME }) }));

    expect(document.querySelector('[data-notice="console"]')).toBeNull();
  });
});

// ---- The shared vocabulary of the launch -----------------------------------------------------------------------------

describe("consoleProblemPath and consoleProblemOf", () => {
  it("round-trip every refusal, and never put anything else in the URL", () => {
    const failures = [
      { problem: "suspended", reason: "billing" },
      { problem: "suspended" },
      { problem: "provisioning" },
      { problem: "failed" },
      { problem: "not_active" },
      { problem: "rate_limited" },
      { problem: "unavailable" },
      { problem: "mfa_required" },
    ] as const;
    for (const failure of failures) {
      const url = new URL(consoleProblemPath(ACME, failure), "https://platform.example.com");
      expect(consoleProblemOf(Object.fromEntries(url.searchParams))).toEqual(failure);
      expect([...url.searchParams.keys()].every((key) => ["console", "reason", "tenant"].includes(key))).toBe(
        true,
      );
    }
    expect(consoleProblemOf({ console: "suspended", reason: "nonsense" })).toEqual({ problem: "suspended" });
    expect(consoleProblemOf({ console: "provisioning", reason: "billing" })).toEqual({
      problem: "provisioning",
    });
    expect(consoleProblemOf({ console: ["rate_limited", "unavailable"] })).toEqual({
      problem: "rate_limited",
    });
  });
});
