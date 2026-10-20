// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { Component, type ReactElement, type ReactNode } from "react";
import type * as ReactModule from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the configuration; the real API client talks to a mocked fetch ----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/dashboard",
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

/**
 * React's `cache()` as Next.js runs it on the server: one memo per request. The client build of React that a
 * component test loads makes `cache()` a pass-through, so without this no test could see the layout and the page of
 * one request share their `getTenant` call. Every `routes()` call starts a new request (`requestScope.next()`).
 */
const requestScope = vi.hoisted(() => {
  const memos = new Set<Map<string, unknown>>();
  return {
    memos,
    next(): void {
      for (const memo of memos) {
        memo.clear();
      }
    },
  };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    cache: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
      const memo = new Map<string, unknown>();
      requestScope.memos.add(memo);
      return (...args: Args): Result => {
        const key = JSON.stringify(args);
        if (!memo.has(key)) {
          memo.set(key, fn(...args));
        }
        return memo.get(key) as Result;
      };
    },
  };
});

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import OtaDashboardPage from "@/app/(app)/otas/[tenantId]/page";
import { saveOtaProfile, type SettingsState } from "@/app/(app)/otas/[tenantId]/settings/actions";
import OtaSettingsPage from "@/app/(app)/otas/[tenantId]/settings/page";
import { fieldId } from "@/components/form-field";
import { checklistLink } from "@/components/onboarding-checklist";
import { SideNav } from "@/components/side-nav";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { AccountMembership, MilestoneFeatures, TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  ERROR_MESSAGES,
  NOT_ALLOWED_STRINGS,
  ONBOARDING_STRINGS,
  OTA_DASHBOARD_STRINGS,
  OTA_STRINGS,
  ROLE_LABELS,
  SETTINGS_STRINGS,
  TENANT_BANNER_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token) -----------------------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type OnboardingItem = Schemas["OnboardingItem"];

const ACCESS_TOKEN = "pfe010-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-010 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const ONBOARDING_PATH = `/v1/tenants/${TENANT_ID}/onboarding`;

const FEATURES_OFF: MilestoneFeatures = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_ID,
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

function membership(role: TenantRole): AccountMembership {
  return {
    membershipId: "stf_01JA2ZA1C5E9G3J7K2M6P0R4T8",
    tenantId: TENANT_ID,
    tenantKey: "acme",
    tenantName: "Acme Travel",
    tenantStatus: "active",
    role,
  };
}

/** The M1 items of PADR-0018 as `getOnboarding` answers them, in its order; three of them done. */
function onboardingItems(): OnboardingItem[] {
  return [
    {
      id: "email_verified",
      label: "Verify your e-mail",
      done: true,
      href: "/verify-pending",
      milestone: "M1",
    },
    {
      id: "mfa_enabled",
      label: "Turn on two-factor sign-in",
      done: false,
      href: "/account/security",
      milestone: "M1",
    },
    { id: "ota_active", label: "OTA set up", done: true, href: `/otas/${TENANT_ID}/setup`, milestone: "M1" },
    {
      id: "api_key",
      label: "Get your API keys",
      done: false,
      href: `/otas/${TENANT_ID}/api-keys`,
      milestone: "M1",
    },
    {
      id: "storefront_open",
      label: "Open your storefront",
      done: true,
      href: "https://acme.ota.example.com/",
      milestone: "M1",
    },
    {
      id: "amadeus_test",
      label: "Amadeus test office active",
      done: false,
      href: `/otas/${TENANT_ID}/amadeus`,
      milestone: "M1",
    },
    {
      id: "team_invited",
      label: "Invite your team",
      done: false,
      href: `/otas/${TENANT_ID}/team`,
      milestone: "M1",
    },
  ];
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(
  code: string,
  status: number,
  options: { details?: Record<string, unknown>; fieldErrors?: { path: string; code: string }[] } = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pfe010",
        ...(options.details === undefined ? {} : { details: options.details }),
        ...(options.fieldErrors === undefined
          ? {}
          : {
              fieldErrors: options.fieldErrors.map((fieldError) => ({
                ...fieldError,
                message: "The API's own field text",
              })),
            }),
      },
    },
    status,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/**
 * Answers each call by `METHOD /path`: by default the OTA (an active owner's) and its checklist. A new answer table
 * is a new request, with nothing cached from the one before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${ONBOARDING_PATH}`]: () => json({ items: onboardingItems() }, 200),
    ...overrides,
  };
  fetchMock.mockImplementation(async (input) => {
    const route = table[`${input.method} ${new URL(input.url).pathname}`];
    if (route === undefined) {
      throw new Error(`unexpected call ${input.method} ${input.url}`);
    }
    return route(input);
  });
}

/** The calls of `METHOD /path` so far. */
function calls(method: string, path: string): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.method === method && new URL(input.url).pathname === path);
}

/** Every call carries the session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The route params of `/otas/[tenantId]`, as Next.js 15 passes them. */
function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/**
 * Next.js handles the `redirect()` of a server action by navigating; in a component test the action runs in the
 * page, so its redirect error reaches this boundary, which shows where the browser would go.
 */
class RedirectBoundary extends Component<{ readonly children: ReactNode }, { readonly target?: string }> {
  override state: { readonly target?: string } = {};

  static getDerivedStateFromError(error: unknown): { target: string } {
    const match = error instanceof Error ? /^NEXT_REDIRECT (.+)$/.exec(error.message) : null;
    return { target: match?.[1] ?? `not a redirect: ${String(error)}` };
  }

  override render(): ReactNode {
    return this.state.target === undefined ? (
      this.props.children
    ) : (
      <p role="status">Redirected to {this.state.target}</p>
    );
  }
}

/** The OTA dashboard as the layout and the page render it for one request. */
async function openDashboard(): Promise<void> {
  render(await OtaLayout({ children: await OtaDashboardPage({ params: params() }), params: params() }));
}

/**
 * The budget of a hook that opens the settings page. Its render builds some 670 options (the countries and the time
 * zones) in happy-dom: a few hundred milliseconds alone, several times that on a loaded CI runner next to the other
 * packages' tests. The tests that need the opened page get it from a `beforeEach` with this budget, which only stops
 * a hook that hangs, so the test bodies hold the steps they check.
 */
const OPEN_SETTINGS_TIMEOUT_MS = 30_000;

/** Renders `/otas/<id>/settings` inside the redirect boundary; React reports a caught redirect on the console. */
async function openSettings(): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await OtaSettingsPage({ params: params() });
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/** The control labelled `label`. */
function control(label: string): HTMLInputElement | HTMLSelectElement {
  return screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
}

function type(label: string, value: string): void {
  fireEvent.change(control(label), { target: { value } });
}

/**
 * The settings form's button named `name`. The settings page holds some 670 options, and a role query computes the
 * role and name of every element, so its tests find elements by text, label or selector instead.
 */
function button(name: string): HTMLButtonElement {
  const found = screen.getByText(name, { selector: "button" });
  return found as HTMLButtonElement;
}

/** The text of the elements matching `selector`. */
function texts(selector: string): string[] {
  return [...document.querySelectorAll(selector)].map((element) => element.textContent ?? "");
}

function submit(name: string): void {
  const form = button(name).closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button(name) });
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: Element): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

/** The settings form's hidden `If-Match` version. */
function formVersion(): string {
  return document.querySelector<HTMLInputElement>('input[name="version"]')?.value ?? "";
}

/** The settings form's data as a submit would send it. */
function settingsFormData(): FormData {
  const form = document.querySelector("form");
  if (form === null) {
    throw new Error("No settings form.");
  }
  return new FormData(form);
}

/**
 * The repository root: the nearest folder above the working directory with `pnpm-workspace.yaml` (a DOM test's
 * `import.meta.url` is a dev-server URL, not a file URL).
 */
function repositoryRoot(): string {
  let folder = process.cwd();
  while (!existsSync(join(folder, "pnpm-workspace.yaml"))) {
    const parent = dirname(folder);
    if (parent === folder) {
      throw new Error("No pnpm-workspace.yaml above the working directory.");
    }
    folder = parent;
  }
  return folder;
}

/**
 * The HTML parser of happy-dom 17 keeps some character references React writes in attribute values (`&#x27;`,
 * `&lt;`, `&gt;`) as text, where a browser decodes them (see pricing.test.tsx); the shadcn/ui class names hold them.
 */
function decodeAttributeReferences(root: Element): void {
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const decoded = attribute.value
        .replaceAll("&#x27;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">");
      if (decoded !== attribute.value) {
        element.setAttribute(attribute.name, decoded);
      }
    }
  }
}

/**
 * Renders `element` as a browser gets it (`renderToString`, then `hydrateRoot`) and collects every error React or the
 * window reports on the way (hydration mismatches, recoverable, caught and uncaught errors).
 */
async function serverRenderAndHydrate(
  element: ReactElement,
): Promise<{ errors: unknown[]; root: Root; serverDom: string; container: HTMLElement }> {
  const errors: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(["console.error", ...args]);
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    errors.push(["console.warn", ...args]);
  });
  const container = document.createElement("div");
  container.innerHTML = renderToString(element);
  decodeAttributeReferences(container);
  document.body.append(container);
  const serverDom = container.innerHTML;
  let root: Root | undefined;
  await act(async () => {
    root = hydrateRoot(container, element, {
      onRecoverableError: (error) => errors.push(["recoverable", error]),
      onCaughtError: (error) => errors.push(["caught", error]),
      onUncaughtError: (error) => errors.push(["uncaught", error]),
    });
    await Promise.resolve();
  });
  if (root === undefined) {
    throw new Error("hydrateRoot did not run");
  }
  return { errors, root, serverDom, container };
}

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = `/otas/${TENANT_ID}`;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe010_portal",
    }),
  );
  nextHeaders.cookies.mockResolvedValue({
    get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
    has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
    set: vi.fn(),
  });
  routes();
}

/**
 * Once per file, before any test: what the settings tests run first (the page's render, a re-render per typed value,
 * a save through the action, the API client and the mocked API). The first run of those paths in a fresh worker is
 * the slowest, and on a busy CI runner it otherwise lands in the first test's own five seconds; here it has the
 * budget of a settings hook. Nothing of it stays: each test gets a fresh API (`resetPlatformApi`), fresh mocks and
 * globals (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({ [`PATCH ${TENANT_PATH}`]: (request) => updated(request, tenant()) });
  await openSettings();
  type(SETTINGS_STRINGS.nameLabel, "Acme Travel Group");
  submit(SETTINGS_STRINGS.submit);
  await waitFor(() => expect(formVersion()).toBe("5"), { timeout: OPEN_SETTINGS_TIMEOUT_MS });
  cleanup();
  document.body.replaceChildren();
}, OPEN_SETTINGS_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The layout ---------------------------------------------------------------------------------------------------

describe("otas/[tenantId]/layout.tsx", () => {
  it("loads getTenant once, with the session and the end-user headers, and renders the page", async () => {
    render(await OtaLayout({ children: <p>Page body</p>, params: params() }));

    expect(screen.getByText("Page body")).toBeTruthy();
    const [call, ...more] = calls("GET", TENANT_PATH);
    expect(more).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectSessionHeaders(call);
  });

  it("renders the not-found page for an OTA the caller is no member of, and for an id that is none", async () => {
    routes({ [`GET ${TENANT_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await expect(OtaLayout({ children: <p>Page body</p>, params: params() })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    // The API refusing the id itself reads the same way.
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/path/tenantId", code: "pattern" }] }),
    });
    await expect(OtaLayout({ children: <p>Page body</p>, params: params() })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );

    // An id that is no OTA id never reaches the API.
    fetchMock.mockClear();
    await expect(OtaLayout({ children: null, params: params("not-an-ota") })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(OtaDashboardPage({ params: params("ten_lowercase") })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigation.notFound).toHaveBeenCalledTimes(4);
  });

  it("shares one getTenant call between the layout and the page of a request", async () => {
    await openDashboard();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Acme Travel");
    expect(calls("GET", TENANT_PATH)).toHaveLength(1);
    expect(calls("GET", ONBOARDING_PATH)).toHaveLength(1);
    cleanup();

    // The settings page of the same request reads the same answer (its element is enough: rendering its some 670
    // options belongs in a hook); the next request loads the OTA again.
    expect(await OtaSettingsPage({ params: params() })).not.toBeNull();
    expect(calls("GET", TENANT_PATH)).toHaveLength(1);
    routes();
    await openDashboard();
    expect(calls("GET", TENANT_PATH)).toHaveLength(2);
  });

  it("sends an ended session to sign-in and back to the OTA's overview, and an unverified account to /verify-pending", async () => {
    routes({ [`GET ${TENANT_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(OtaLayout({ children: null, params: params() })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}`,
    );
    // A page below reads the layout's answer; the layout redirects first, so every page names the overview.
    await expect(OtaSettingsPage({ params: params() })).rejects.toThrow(
      new RegExp(`^NEXT_REDIRECT /sign-in\\?next=%2Fotas%2F${TENANT_ID}$`),
    );
    expect(calls("GET", TENANT_PATH)).toHaveLength(1);

    routes({ [`GET ${TENANT_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(OtaLayout({ children: null, params: params() })).rejects.toThrow(
      "NEXT_REDIRECT /verify-pending",
    );
  });

  it("shows the portal's message in place of the page when the OTA cannot be loaded", async () => {
    routes({ [`GET ${TENANT_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    render(await OtaLayout({ children: <p>Page body</p>, params: params() }));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(OTA_STRINGS.unavailableTitle);
    expect(screen.getByRole("alert").textContent).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(screen.queryByText("Page body")).toBeNull();
    // The page itself leaves the failure to the layout.
    expect(await OtaDashboardPage({ params: params() })).toBeNull();
  });
});

// ---- The dashboard --------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]: the OTA dashboard", () => {
  it("[PFE-010 AC1] links every checklist item to its page and shows its done state [PF-12 AC1]", async () => {
    await openDashboard();

    const checklist = screen.getByRole("region", { name: ONBOARDING_STRINGS.title });
    const items = within(within(checklist).getByRole("list")).getAllByRole("listitem");
    const expected = onboardingItems();
    // Every item of the API, in its order, each a link to the page that completes it with its state in words.
    expect(items.map((item) => item.dataset["item"])).toEqual(expected.map((item) => item.id));
    for (const [index, item] of items.entries()) {
      const answer = expected[index];
      const link = within(item).getByRole("link", { name: answer?.label ?? "" });
      expect(link.getAttribute("href")).toBe(answer?.href);
      expect(item.dataset["done"]).toBe(String(answer?.done));
      expect(item.querySelector("[data-state]")?.textContent).toBe(
        answer?.done === true ? ONBOARDING_STRINGS.done : ONBOARDING_STRINGS.toDo,
      );
    }
    expect(within(checklist).getByText(ONBOARDING_STRINGS.progress(3, 7))).toBeTruthy();
    expect(within(checklist).queryByText(ONBOARDING_STRINGS.allDone)).toBeNull();
    // The account items lead to the account pages, the storefront item to the storefront itself.
    expect(
      within(checklist).getByRole("link", { name: "Turn on two-factor sign-in" }).getAttribute("href"),
    ).toBe("/account/security");
    expect(within(checklist).getByRole("link", { name: "Open your storefront" }).getAttribute("href")).toBe(
      "https://acme.ota.example.com/",
    );

    // getOnboarding with the session; nothing is written when the checklist is read.
    const [call, ...more] = calls("GET", ONBOARDING_PATH);
    expect(more).toHaveLength(0);
    expectSessionHeaders(call);
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("[PFE-010 AC1] shows the M5 items the API sends, and says when every step is done", async () => {
    const allDone: OnboardingItem[] = [
      ...onboardingItems().map((item) => ({ ...item, done: true })),
      {
        id: "plan_chosen",
        label: "Choose a plan",
        done: true,
        href: `/otas/${TENANT_ID}/billing`,
        milestone: "M5",
      },
    ];
    routes({ [`GET ${ONBOARDING_PATH}`]: () => json({ items: allDone }, 200) });
    await openDashboard();

    const checklist = screen.getByRole("region", { name: ONBOARDING_STRINGS.title });
    expect(within(checklist).getByRole("link", { name: "Choose a plan" }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/billing`,
    );
    expect(within(checklist).getAllByText(ONBOARDING_STRINGS.done)).toHaveLength(8);
    expect(within(checklist).getByText(ONBOARDING_STRINGS.progress(8, 8))).toBeTruthy();
    expect(within(checklist).getByText(ONBOARDING_STRINGS.allDone)).toBeTruthy();
  });

  it("[PFE-010 AC1] links only to portal paths and https: URLs, and renders any other href as text", async () => {
    expect(checklistLink("/account/security")).toEqual({ kind: "portal", href: "/account/security" });
    expect(checklistLink("https://book.acme.example/")).toEqual({
      kind: "external",
      href: "https://book.acme.example/",
    });
    for (const href of [
      "javascript:alert(1)",
      "//evil.example/x",
      "/\\evil.example",
      "http://acme.ota.example.com/",
      "https://user:secret@acme.ota.example.com/",
      "data:text/html,hello",
      "/otas/\u0000",
      "not a url",
    ]) {
      expect(checklistLink(href)).toEqual({ kind: "none" });
    }

    routes({
      [`GET ${ONBOARDING_PATH}`]: () =>
        json(
          {
            items: [
              {
                id: "api_key",
                label: "Get your API keys",
                done: false,
                href: "javascript:alert(1)",
                milestone: "M1",
              },
            ],
          },
          200,
        ),
    });
    await openDashboard();
    const checklist = screen.getByRole("region", { name: ONBOARDING_STRINGS.title });
    expect(within(checklist).getByText("Get your API keys")).toBeTruthy();
    expect(within(checklist).queryByRole("link")).toBeNull();
  });

  it("shows the OTA's name, status, storefront link, key and role, and the profile link for owners", async () => {
    await openDashboard();

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      "Acme Travel",
    ]);
    expect(screen.getByText("Active")).toBeTruthy();
    const storefront = screen.getByRole("region", { name: OTA_DASHBOARD_STRINGS.storefrontTitle });
    expect(within(storefront).getByRole("link", { name: "acme.ota.example.com" }).getAttribute("href")).toBe(
      "https://acme.ota.example.com/",
    );
    const details = screen.getByRole("region", { name: OTA_DASHBOARD_STRINGS.detailsLabel });
    expect(within(details).getByText("acme")).toBeTruthy();
    expect(within(details).getByText(ROLE_LABELS.owner)).toBeTruthy();
    expect(within(details).getByText("EUR")).toBeTruthy();
    expect(screen.getByRole("link", { name: OTA_DASHBOARD_STRINGS.editProfile }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/settings`,
    );
    // Test mode is a notice of the banner; an active OTA has no set-up notice.
    expect(screen.getByRole("region", { name: TENANT_BANNER_STRINGS.label }).textContent).toContain(
      TENANT_BANNER_STRINGS.testModeTitle,
    );
    expect(document.querySelector('[data-notice="setup"]')).toBeNull();
  });

  it("leads an OTA that is still being set up, or whose set-up failed, to its set-up page", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "provisioning", activatedAt: null }), 200),
    });
    await openDashboard();
    expect(screen.getByText("Setting up")).toBeTruthy();
    expect(document.querySelector('[data-notice="setup"]')?.textContent).toContain(
      OTA_DASHBOARD_STRINGS.setupInProgress,
    );
    expect(screen.getByRole("link", { name: OTA_DASHBOARD_STRINGS.setupLink }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/setup`,
    );
    expect(screen.getByText(OTA_DASHBOARD_STRINGS.storefrontPending)).toBeTruthy();
    cleanup();

    routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed", activatedAt: null }), 200) });
    await openDashboard();
    expect(document.querySelector('[data-notice="setup"]')?.textContent).toContain(
      OTA_DASHBOARD_STRINGS.setupFailed,
    );
  });

  it("[PFE-010 AC3] shows a suspended OTA's banner with its reason, and the billing link to roles that see billing", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(tenant({ status: "suspended", suspensionReason: "billing", billingNotice: "past_due" }), 200),
    });
    await openDashboard();

    const notices = screen.getByRole("region", { name: TENANT_BANNER_STRINGS.label });
    const suspended = notices.querySelector<HTMLElement>('[data-notice="suspended"]');
    expect(suspended?.getAttribute("role")).toBe("alert");
    expect(suspended?.textContent).toContain(TENANT_BANNER_STRINGS.suspendedTitle);
    expect(suspended?.textContent).toContain(TENANT_BANNER_STRINGS.suspendedReasons.billing);
    expect(suspended?.textContent).toContain(TENANT_BANNER_STRINGS.suspendedReadOnly);
    expect(
      within(suspended as HTMLElement)
        .getByRole("link", { name: TENANT_BANNER_STRINGS.billingLink })
        .getAttribute("href"),
    ).toBe(`/otas/${TENANT_ID}/billing`);
    expect(notices.querySelector('[data-notice="past_due"]')?.textContent).toContain(
      TENANT_BANNER_STRINGS.pastDueTitle,
    );
    expect(screen.getByText("Suspended")).toBeTruthy();
    cleanup();

    // Another reason, for an agent: the reason in words, no billing link (agents do not see billing).
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(tenant({ status: "suspended", suspensionReason: "abuse", myRole: "agent" }), 200),
    });
    await openDashboard();
    const abuse = screen
      .getByRole("region", { name: TENANT_BANNER_STRINGS.label })
      .querySelector<HTMLElement>('[data-notice="suspended"]');
    expect(abuse?.textContent).toContain(TENANT_BANNER_STRINGS.suspendedReasons.abuse);
    expect(within(abuse as HTMLElement).queryByRole("link")).toBeNull();
  });

  it("shows the portal's message when the checklist cannot be loaded, and the rest of the dashboard", async () => {
    routes({ [`GET ${ONBOARDING_PATH}`]: () => apiError("RATE_LIMITED", 429) });
    await openDashboard();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(OTA_DASHBOARD_STRINGS.checklistUnavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.RATE_LIMITED);
    expect(alert.textContent).not.toContain("The API's own text");
    expect(screen.queryByRole("region", { name: ONBOARDING_STRINGS.title })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Acme Travel");
  });
});

// ---- The settings ---------------------------------------------------------------------------------------------------

/** The `updateTenant` answer for a body: the tenant with the body applied and its version raised. */
async function updated(request: Request, base: Tenant): Promise<Response> {
  const body = (await request.clone().json()) as Partial<Tenant>;
  const version = Number(/^"(\d+)"$/.exec(request.headers.get("if-match") ?? "")?.[1]);
  return json({ ...base, ...body, version: version + 1 }, 200);
}

describe("/otas/[tenantId]/settings: the OTA profile", () => {
  describe.each<TenantRole>(["owner", "admin"])("opened by an %s", (role) => {
    beforeEach(async () => {
      routes({
        [`GET ${TENANT_PATH}`]: () => json(tenant({ myRole: role }), 200),
        [`PATCH ${TENANT_PATH}`]: (request) => updated(request, tenant({ myRole: role })),
      });
      await openSettings();
    }, OPEN_SETTINGS_TIMEOUT_MS);

    it(`[PFE-010 AC2] lets an ${role} save the profile with If-Match, then save again with the new version [PF-13 AC1]`, async () => {
      expect(texts("h1")).toEqual([SETTINGS_STRINGS.title]);
      expect(control(SETTINGS_STRINGS.nameLabel).value).toBe("Acme Travel");
      expect(control(SETTINGS_STRINGS.countryLabel).value).toBe("NO");
      expect(control(SETTINGS_STRINGS.timeZoneLabel).value).toBe("Europe/Oslo");
      expect(formVersion()).toBe("4");

      type(SETTINGS_STRINGS.nameLabel, "  Acme Travel Group ");
      type(SETTINGS_STRINGS.legalNameLabel, "Acme Travel AS");
      type(SETTINGS_STRINGS.supportEmailLabel, "support@acme-travel.example.com");
      type(SETTINGS_STRINGS.countryLabel, "SE");
      type(SETTINGS_STRINGS.timeZoneLabel, "Europe/Stockholm");
      submit(SETTINGS_STRINGS.submit);

      await waitFor(() => expect(texts('[role="status"]')).toEqual([SETTINGS_STRINGS.saved]), {
        timeout: 3_000,
      });
      const [patch, ...more] = calls("PATCH", TENANT_PATH);
      expect(more).toHaveLength(0);
      expect(patch?.headers.get("if-match")).toBe('"4"');
      expectSessionHeaders(patch);
      expect(await patch?.clone().json()).toEqual({
        name: "Acme Travel Group",
        legalName: "Acme Travel AS",
        supportEmail: "support@acme-travel.example.com",
        countryCode: "SE",
        timeZone: "Europe/Stockholm",
      });
      // The saved profile stays in the form with its new version; the OTA's pages render again.
      expect(formVersion()).toBe("5");
      expect(control(SETTINGS_STRINGS.nameLabel).value).toBe("Acme Travel Group");
      expect(control(SETTINGS_STRINGS.countryLabel).value).toBe("SE");
      expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/otas/${TENANT_ID}`, "layout");

      // Clearing the legal name and the support address sends null, with the version of the last save.
      type(SETTINGS_STRINGS.legalNameLabel, "");
      type(SETTINGS_STRINGS.supportEmailLabel, " ");
      submit(SETTINGS_STRINGS.submit);
      await waitFor(() => expect(calls("PATCH", TENANT_PATH)).toHaveLength(2), { timeout: 3_000 });
      const second = calls("PATCH", TENANT_PATH)[1];
      expect(second?.headers.get("if-match")).toBe('"5"');
      expect(await second?.clone().json()).toMatchObject({ legalName: null, supportEmail: null });
      await waitFor(() => expect(formVersion()).toBe("6"), { timeout: 3_000 });
    });

    it(`shows the key and the default currency read-only to an ${role}, and offers the reference countries`, () => {
      const fixed = document.querySelector('[aria-labelledby="settings-fixed"]') as HTMLElement;
      expect(fixed.querySelector("h2")?.textContent).toBe(SETTINGS_STRINGS.fixedTitle);
      expect(fixed.querySelector('[data-field="key"]')?.textContent).toBe("acme");
      expect(fixed.querySelector('[data-field="defaultCurrency"]')?.textContent).toBe("EUR");
      // Neither is a field of the form: the API never changes them (PF-13 AC1).
      const sent = [...settingsFormData().keys()];
      expect(sent.sort()).toEqual([
        "countryCode",
        "legalName",
        "name",
        "supportEmail",
        "tenantId",
        "timeZone",
        "version",
      ]);
      expect(document.querySelector('[name="key"], [name="defaultCurrency"]')).toBeNull();

      // The countries of the reference data the API checks against, named in English; the OTA's own zone is offered.
      const countries = readFileSync(
        join(repositoryRoot(), "tools/reference-data/data/countries.csv"),
        "utf8",
      )
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.split(",")[0]);
      const options = [...(control(SETTINGS_STRINGS.countryLabel) as HTMLSelectElement).options];
      expect(new Set(options.map((option) => option.value))).toEqual(new Set(countries));
      expect(options.find((option) => option.value === "NO")?.textContent).toBe("Norway");
      const zones = [...(control(SETTINGS_STRINGS.timeZoneLabel) as HTMLSelectElement).options].map(
        (option) => option.value,
      );
      expect(zones).toContain("Europe/Oslo");
      expect(zones.length).toBeGreaterThan(300);
      expect(button(SETTINGS_STRINGS.submit).disabled).toBe(false);
    });
  });

  describe.each<TenantRole>(["agent", "finance", "viewer"])("for the %s role", (role) => {
    it(`[PFE-010 AC2] shows the ${role} role no settings link and the not-allowed page by URL [PF-13 AC1]`, async () => {
      routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ myRole: role }), 200) });

      // No link to the settings: not in the navigation, not on the dashboard.
      render(<SideNav memberships={[membership(role)]} features={FEATURES_OFF} />);
      expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
      cleanup();
      await openDashboard();
      expect(screen.queryByRole("link", { name: OTA_DASHBOARD_STRINGS.editProfile })).toBeNull();
      expect(document.querySelector(`a[href="/otas/${TENANT_ID}/settings"]`)).toBeNull();
      cleanup();

      // By URL: the not-allowed page, with the role and the way back, and no form.
      render(await OtaSettingsPage({ params: params() }));
      expect(document.querySelector('[data-page="not-allowed"]')).not.toBeNull();
      expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
        NOT_ALLOWED_STRINGS.title,
      ]);
      expect(screen.getByText(NOT_ALLOWED_STRINGS.intro(ROLE_LABELS[role]))).toBeTruthy();
      expect(
        screen.getByRole("link", { name: NOT_ALLOWED_STRINGS.backToOverview }).getAttribute("href"),
      ).toBe(`/otas/${TENANT_ID}`);
      expect(document.querySelector("form")).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(calls("PATCH", TENANT_PATH)).toHaveLength(0);
    });
  });

  it("[PFE-010 AC2] shows owners and admins the settings link in the navigation", () => {
    for (const role of ["owner", "admin"] as const) {
      render(<SideNav memberships={[membership(role)]} features={FEATURES_OFF} />);
      expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
        `/otas/${TENANT_ID}/settings`,
      );
      cleanup();
    }
  });

  describe("opened by an owner, with answers that refuse the save", () => {
    beforeEach(async () => {
      await openSettings();
    }, OPEN_SETTINGS_TIMEOUT_MS);

    it("keeps what was typed and asks to reload when someone else changed the profile (PRECONDITION_FAILED)", async () => {
      routes({ [`PATCH ${TENANT_PATH}`]: () => apiError("PRECONDITION_FAILED", 412) });
      type(SETTINGS_STRINGS.nameLabel, "Acme Holidays");
      submit(SETTINGS_STRINGS.submit);

      await waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull(), {
        timeout: 3_000,
      });
      const summary = document.querySelector('[role="alert"]') as HTMLElement;
      expect(texts('[role="alert"] li')).toEqual([SETTINGS_STRINGS.stale]);
      expect(summary.textContent).not.toContain("The API's own text");
      await waitFor(() => expect(document.activeElement).toBe(summary), { timeout: 3_000 });
      expect(screen.getByText(SETTINGS_STRINGS.reload, { selector: "a" }).getAttribute("href")).toBe(
        `/otas/${TENANT_ID}/settings`,
      );
      expect(control(SETTINGS_STRINGS.nameLabel).value).toBe("Acme Holidays");
      // The refused save changed nothing: a retry is checked against the same version.
      expect(formVersion()).toBe("4");
      expect(calls("PATCH", TENANT_PATH)[0]?.headers.get("if-match")).toBe('"4"');
      expect(nextCache.revalidatePath).not.toHaveBeenCalled();
    });

    it("checks the fields before any call, in form order, and keeps what was typed", async () => {
      type(SETTINGS_STRINGS.nameLabel, "   ");
      type(SETTINGS_STRINGS.supportEmailLabel, "not-an-address");
      type(SETTINGS_STRINGS.legalNameLabel, "x".repeat(201));
      submit(SETTINGS_STRINGS.submit);

      await waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull(), {
        timeout: 3_000,
      });
      expect(
        [...document.querySelectorAll('[role="alert"] a')].map((link) => [
          link.textContent,
          link.getAttribute("href"),
        ]),
      ).toEqual([
        [SETTINGS_STRINGS.nameRequired, `#${fieldId("name")}`],
        [SETTINGS_STRINGS.legalNameTooLong, `#${fieldId("legalName")}`],
        [SETTINGS_STRINGS.supportEmailInvalid, `#${fieldId("supportEmail")}`],
      ]);
      const email = control(SETTINGS_STRINGS.supportEmailLabel);
      expect(descriptionsOf(email)).toContain(SETTINGS_STRINGS.supportEmailInvalid);
      expect(email.getAttribute("aria-invalid")).toBe("true");
      expect(email.value).toBe("not-an-address");
      expect(calls("PATCH", TENANT_PATH)).toHaveLength(0);
    });

    it("puts the API's field errors at their fields in the portal's words", async () => {
      routes({
        [`PATCH ${TENANT_PATH}`]: () =>
          apiError("VALIDATION_FAILED", 400, {
            fieldErrors: [
              { path: "/countryCode", code: "unknown" },
              { path: "/timeZone", code: "unknown" },
            ],
          }),
      });
      submit(SETTINGS_STRINGS.submit);

      await waitFor(
        () =>
          expect(descriptionsOf(control(SETTINGS_STRINGS.countryLabel))).toContain(
            SETTINGS_STRINGS.countryUnknown,
          ),
        { timeout: 3_000 },
      );
      expect(descriptionsOf(control(SETTINGS_STRINGS.timeZoneLabel))).toContain(
        SETTINGS_STRINGS.timeZoneUnknown,
      );
      expect(document.querySelector('[role="alert"]')?.textContent).not.toContain("The API's own field text");
    });
  });

  describe.each(["provisioning", "suspended", "failed"] as const)("of an OTA that is %s", (status) => {
    beforeEach(async () => {
      routes({
        [`GET ${TENANT_PATH}`]: () =>
          json(tenant({ status, suspensionReason: status === "suspended" ? "billing" : null }), 200),
      });
      await openSettings();
    }, OPEN_SETTINGS_TIMEOUT_MS);

    it(`disables the form with the reason while the OTA is ${status}`, () => {
      const notice = document.querySelector<HTMLElement>('[data-notice="read-only"]');
      expect(notice?.textContent).toContain(SETTINGS_STRINGS.readOnlyTitle);
      expect(notice?.textContent).toContain(SETTINGS_STRINGS.readOnly[status]);
      expect(document.querySelector("fieldset")?.disabled).toBe(true);
      expect(button(SETTINGS_STRINGS.submit).disabled).toBe(true);
      // The profile is still shown.
      expect(control(SETTINGS_STRINGS.nameLabel).value).toBe("Acme Travel");
    });
  });

  describe("the saveOtaProfile action", () => {
    const idle: SettingsState = {
      status: "idle",
      version: 4,
      values: { name: "", legalName: "", supportEmail: "", countryCode: "", timeZone: "" },
      fieldErrors: {},
    };

    function profile(overrides: Record<string, string> = {}): FormData {
      const data = new FormData();
      const values = {
        tenantId: TENANT_ID,
        version: "4",
        name: "Acme Travel",
        legalName: "",
        supportEmail: "",
        countryCode: "NO",
        timeZone: "Europe/Oslo",
        ...overrides,
      };
      for (const [name, value] of Object.entries(values)) {
        data.set(name, value);
      }
      return data;
    }

    it("answers each refusal of updateTenant with the portal's message, and ends a dead session", async () => {
      const cases: [Response, string][] = [
        [
          apiError("TENANT_NOT_ACTIVE", 409, { details: { status: "suspended" } }),
          SETTINGS_STRINGS.notActive,
        ],
        [apiError("FORBIDDEN", 403), SETTINGS_STRINGS.forbidden],
        [apiError("NOT_FOUND", 404), SETTINGS_STRINGS.removed],
        [apiError("RATE_LIMITED", 429), SETTINGS_STRINGS.rateLimited],
        [
          apiError("VALIDATION_FAILED", 400, {
            fieldErrors: [{ path: "/header/If-Match", code: "pattern" }],
          }),
          SETTINGS_STRINGS.formExpired,
        ],
        [apiError("INTERNAL_ERROR", 500), ERROR_MESSAGES.INTERNAL_ERROR],
      ];
      for (const [answer, message] of cases) {
        routes({ [`PATCH ${TENANT_PATH}`]: () => answer });
        const state = await saveOtaProfile(idle, profile({ name: "Acme Holidays" }));
        expect(state).toMatchObject({ status: "failed", version: 4, message, fieldErrors: {} });
        expect(state.values.name).toBe("Acme Holidays");
      }

      routes({ [`PATCH ${TENANT_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
      await expect(saveOtaProfile(idle, profile())).rejects.toThrow(
        `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fsettings`,
      );
      routes({ [`PATCH ${TENANT_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
      await expect(saveOtaProfile(idle, profile())).rejects.toThrow("NEXT_REDIRECT /verify-pending");
      fetchMock.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3100"));
      expect((await saveOtaProfile(idle, profile())).message).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
      expect(nextCache.revalidatePath).not.toHaveBeenCalled();
    });

    it("refuses a submission without the OTA or its version, or with unknown codes, without a call", async () => {
      for (const overrides of [
        { tenantId: "" },
        { tenantId: "ten_x" },
        { version: "" },
        { version: "0" },
        { version: '"4"' },
      ]) {
        expect(await saveOtaProfile(idle, profile(overrides))).toMatchObject({
          status: "failed",
          message: SETTINGS_STRINGS.formExpired,
        });
      }
      expect((await saveOtaProfile(idle, profile({ countryCode: "Norway" }))).fieldErrors).toEqual({
        countryCode: SETTINGS_STRINGS.countryUnknown,
      });
      expect((await saveOtaProfile(idle, profile({ countryCode: "", timeZone: "" }))).fieldErrors).toEqual({
        countryCode: SETTINGS_STRINGS.countryRequired,
        timeZone: SETTINGS_STRINGS.timeZoneRequired,
      });
      expect((await saveOtaProfile(idle, profile({ name: "n".repeat(101) }))).fieldErrors).toEqual({
        name: SETTINGS_STRINGS.nameTooLong,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("rendered on the server", () => {
    let rendered: Awaited<ReturnType<typeof serverRenderAndHydrate>> | undefined;

    beforeEach(async () => {
      const page = await OtaSettingsPage({ params: params() });
      if (page === null) {
        throw new Error("The settings page rendered nothing.");
      }
      rendered = await serverRenderAndHydrate(page);
    }, OPEN_SETTINGS_TIMEOUT_MS);

    afterEach(() => {
      const root = rendered?.root;
      if (root !== undefined) {
        act(() => root.unmount());
      }
      rendered = undefined;
    });

    it("hydrates in the browser without an error or a change", () => {
      expect(rendered?.errors).toEqual([]);
      // The hydrated page is the server's page: same markup, nothing replaced in the browser.
      expect(rendered?.container.innerHTML).toBe(rendered?.serverDom);
      expect(rendered?.container.querySelector<HTMLInputElement>('input[name="version"]')?.value).toBe("4");
    });
  });
});
