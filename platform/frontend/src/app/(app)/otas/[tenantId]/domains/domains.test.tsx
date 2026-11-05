// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import type { ReactNode } from "react";
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
 * React's `cache()` as Next.js runs it on the server: one memo per request (see ota-dashboard.test.tsx). Every
 * `routes()` call starts a new request.
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

import {
  addDomain,
  changeDomain,
  type AddDomainState,
  type DomainActionState,
} from "@/app/(app)/otas/[tenantId]/domains/actions";
import { domainActionsOf } from "@/app/(app)/otas/[tenantId]/domains/domain-actions";
import DomainsPage from "@/app/(app)/otas/[tenantId]/domains/page";
import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import { formatDateTime } from "@/components/date-time";
import { DnsRecordsTable, dnsCheckMessage } from "@/components/dns-records-table";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { MilestoneFeatures, TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  DNS_CHECK_ERRORS,
  DOMAINS_STRINGS,
  ERROR_MESSAGES,
  FORM_STRINGS,
  STATUS_LABELS,
  TLS_STATUS_NOTES,
} from "@/lib/strings";

const STRINGS = DOMAINS_STRINGS;

// ---- Builders (dummy values only: no real token, key or account) -------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type Account = Schemas["Account"];
type Plan = Schemas["Plan"];
type Domain = Schemas["Domain"];

const ACCESS_TOKEN = "pfe022-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-022 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TIME_ZONE = "Europe/Oslo";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const ME_PATH = "/v1/me";
const PLANS_PATH = "/v1/plans";
const DOMAINS_PATH = `${TENANT_PATH}/domains`;
const DOMAINS_PAGE = `/otas/${TENANT_ID}/domains`;
const BILLING_PAGE = `/otas/${TENANT_ID}/billing`;
/** The text of an API answer; it must never reach the page. */
const API_TEXT = "The API's own text";

const SUBDOMAIN_ID = "dom_01JA2Z7Q4M9R2T6V0X3Z8B1D6G";
const TRAVEL_ID = "dom_01JB3K5N9Q3S7W1Y5A9C3E7G1J";
const APEX_ID = "dom_01JB3K6P0R4T8X2Z6B0D4F8H2K";
const FLY_ID = "dom_01JB3K7Q1S5V9Y3A7C1E5G9J3M";
const SHOP_ID = "dom_01JB3K8R2T6W0Z4B8D2F6H0K4N";
const TOKEN = "vx-verify-K7Q4M2XP9TRWH5ZDB3NV8QKE1MZT6RYC";
const domainPath = (id: string) => `${DOMAINS_PATH}/${id}`;
const checkPath = (id: string) => `${DOMAINS_PATH}/${id}/check`;
const primaryPath = (id: string) => `${DOMAINS_PATH}/${id}/make-primary`;

/** The fixtures' instants are relative to the start of the file, never a calendar date. */
const START = Date.now();
const DAY_MS = 86_400_000;
function daysFromStart(days: number): string {
  return new Date(START + days * DAY_MS).toISOString();
}

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_ID,
    key: "acme",
    name: "Acme Travel",
    legalName: null,
    status: "active",
    suspensionReason: null,
    billingNotice: null,
    planCode: "growth",
    defaultCurrency: "EUR",
    countryCode: "NO",
    timeZone: TIME_ZONE,
    supportEmail: null,
    storefrontEnvironment: "test",
    liveEnabledAt: null,
    primaryHost: "acme.ota.example.com",
    schemaVersion: "0002_m1",
    createdAt: daysFromStart(-30),
    activatedAt: daysFromStart(-30),
    version: 4,
    myRole: "owner",
    ...overrides,
  };
}

const FEATURES_ON: MilestoneFeatures = {
  stripeBilling: true,
  ownStripe: true,
  settlements: true,
  ownAmadeus: true,
  customDomains: true,
  liveSwitch: true,
};

function account(features: Partial<MilestoneFeatures> = {}): Account {
  return {
    id: "acc_01JA2Z5K8N3Q6S9V2X5Z8B1D4F",
    email: "owner@example.com",
    emailVerified: true,
    fullName: "Ines Owner",
    locale: "en",
    timeZone: "UTC",
    mfaEnabled: true,
    mfaEnabledAt: daysFromStart(-29),
    mfaEnrolmentRequired: false,
    isPlatformAdmin: false,
    createdAt: daysFromStart(-31),
    version: 2,
    memberships: [
      {
        membershipId: "stf_01JA2ZA1C5E9G3J7K2M6P0R4T8",
        tenantId: TENANT_ID,
        tenantKey: "acme",
        tenantName: "Acme Travel",
        tenantStatus: "active",
        role: "owner",
      },
    ],
    features: { ...FEATURES_ON, ...features },
  };
}

function plan(code: string, customDomains: number): Plan {
  return {
    code,
    name: code === "growth" ? "Growth" : "Starter",
    description: null,
    monthlyPrice: { amount: "49.00", currency: "EUR" },
    annualPrice: null,
    trialDays: 0,
    limits: { staffSeats: 10, apiKeys: 10, customDomains, liveMode: true },
    features: {},
    checkoutAvailable: { month: true, year: false },
  };
}

/** The Velexis sub-domain as provisioning creates it: verified and primary, without DNS records. */
function subdomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: SUBDOMAIN_ID,
    hostname: "acme.ota.example.com",
    kind: "subdomain",
    purpose: "storefront",
    isPrimary: true,
    verificationStatus: "verified",
    dnsRecords: [],
    verificationDeadlineAt: null,
    lastCheckedAt: null,
    lastCheckError: null,
    tlsStatus: "issued",
    tlsExpiresAt: daysFromStart(60),
    createdAt: daysFromStart(-30),
    ...overrides,
  };
}

/** The records `addDomain` answers for `host`: the TXT record and both routing options (AAAA only when asked). */
function records(host: string, withAaaa = true): Domain["dnsRecords"] {
  return [
    { type: "TXT", name: `_velexis.${host}`, value: TOKEN },
    { type: "CNAME", name: host, value: "acme.ota.example.com" },
    { type: "A", name: host, value: "203.0.113.10" },
    ...(withAaaa ? [{ type: "AAAA" as const, name: host, value: "2001:db8::10" }] : []),
  ];
}

/** A custom domain (M5) just added: pending, not checked yet. */
function customDomain(overrides: Partial<Domain> = {}): Domain {
  const hostname = overrides.hostname ?? "travel.acme.com";
  return {
    id: TRAVEL_ID,
    hostname,
    kind: "custom",
    purpose: "storefront",
    isPrimary: false,
    verificationStatus: "pending",
    dnsRecords: records(hostname),
    verificationDeadlineAt: daysFromStart(3),
    lastCheckedAt: null,
    lastCheckError: null,
    tlsStatus: "pending",
    tlsExpiresAt: null,
    createdAt: daysFromStart(0),
    ...overrides,
  };
}

/** A verified custom domain with an issued certificate. */
function verifiedDomain(overrides: Partial<Domain> = {}): Domain {
  return customDomain({
    id: APEX_ID,
    hostname: "acme.com",
    verificationStatus: "verified",
    lastCheckedAt: daysFromStart(-1),
    tlsStatus: "issued",
    tlsExpiresAt: daysFromStart(80),
    ...overrides,
  });
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An error envelope of the platform API; its `message` and the field errors' messages must never reach the page. */
function apiError(
  code: string,
  status: number,
  extra: {
    readonly fieldErrors?: readonly { path: string; code: string }[];
    readonly details?: Record<string, unknown>;
    readonly headers?: Record<string, string>;
  } = {},
): Response {
  return json(
    {
      error: {
        code,
        message: `${API_TEXT}, never shown`,
        status,
        requestId: "req_api_pfe022",
        ...(extra.details === undefined ? {} : { details: extra.details }),
        ...(extra.fieldErrors === undefined
          ? {}
          : {
              fieldErrors: extra.fieldErrors.map((fieldError) => ({
                ...fieldError,
                message: `${API_TEXT} of a field`,
              })),
            }),
      },
    },
    status,
    extra.headers,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/**
 * Answers each call by `METHOD /path`: by default an active owner's OTA on a plan with three custom domains, the M5
 * switches on, the sub-domain only, and every change accepted. A new answer table is a new request, with nothing
 * cached from the one before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${ME_PATH}`]: () => json(account(), 200),
    [`GET ${PLANS_PATH}`]: () => json({ data: [plan("starter", 0), plan("growth", 3)] }, 200),
    [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain()] }, 200),
    [`POST ${DOMAINS_PATH}`]: () => json(customDomain(), 201),
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

/** `routes()` for an OTA in which the caller has `role` (and, optionally, another status). */
function routesAs(
  role: TenantRole,
  overrides: Record<string, Route> = {},
  status: Tenant["status"] = "active",
): void {
  routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ myRole: role, status }), 200), ...overrides });
}

/** `routes()` with these domains listed. */
function routesWith(domains: readonly Domain[], overrides: Record<string, Route> = {}): void {
  routes({ [`GET ${DOMAINS_PATH}`]: () => json({ data: domains }, 200), ...overrides });
}

/** The calls of `METHOD /path` so far. */
function calls(method: string, path: string): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.method === method && new URL(input.url).pathname === path);
}

/** Every write so far (anything but a GET). */
function writes(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.method !== "GET")
    .map((input) => `${input.method} ${new URL(input.url).pathname}`);
}

/** The body of a call, read from a copy so the request stays readable. */
async function bodyOf(request: Request | undefined): Promise<unknown> {
  if (request === undefined) {
    throw new Error("No such call.");
  }
  return request.clone().json();
}

/** Every call carries the session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The route params of `/otas/[tenantId]/domains`, as Next.js 15 passes them. */
function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

// ---- Rendering and waiting -----------------------------------------------------------------------------------------

/** The domains page inside the OTA layout, as the server renders it for one request. */
async function pageTree(): Promise<ReactNode> {
  return OtaLayout({ children: await DomainsPage({ params: params() }), params: params() });
}

/** Opens the domains page (a page load). */
async function openDomains(): Promise<ReturnType<typeof render>> {
  return render(await pageTree());
}

/**
 * The page rendered again for a new request in the same browser page, as a revalidation does: the client components
 * keep their state, the server parts show the API's new answers.
 */
async function refresh(
  view: ReturnType<typeof render>,
  overrides: Record<string, Route> = {},
): Promise<void> {
  routes(overrides);
  view.rerender(await pageTree());
}

/**
 * The wait for what a server action renders: the action runs the real `lib/api.ts` over the mocked fetch, which on a
 * busy CI runner can outlast Testing Library's 1 s default. It stays well inside the test's own budget.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/** The list item of a domain. */
function item(hostname: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`li[data-domain="${hostname}"]`);
  if (element === null) {
    throw new Error(`No domain ${hostname} on the page.`);
  }
  return element;
}

/** The names of the buttons inside `container`, in order. */
function buttonNames(container: HTMLElement): string[] {
  return within(container)
    .queryAllByRole("button")
    .map((button) => button.textContent ?? "");
}

/** An action's button of a domain, by its label (the domain is read with it). */
function actionButton(hostname: string, label: string): HTMLElement {
  return within(item(hostname)).getByRole("button", { name: `${label}${STRINGS.actionTarget(hostname)}` });
}

/** The rows of a records table: type, name and value of each. */
function recordRows(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
}

/** The text of one detail (`data-detail`) of a domain, or `undefined` without it. */
function detail(container: HTMLElement, id: string): string | undefined {
  return container.querySelector(`[data-detail="${id}"] dd`)?.textContent ?? undefined;
}

/** The text of one certificate detail (`data-tls-detail`) of a domain, or `undefined` without it. */
function tlsDetail(container: HTMLElement, id: string): string | undefined {
  return container.querySelector(`[data-tls-detail="${id}"] dd`)?.textContent ?? undefined;
}

/** The words of the notice's outcome, without its reload link. */
function noticeMessage(): string {
  return notice().querySelector("[data-notice-message]")?.textContent ?? "";
}

/** The notice of the domain actions (the outcome of the last one). */
function notice(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-domain-notice]");
  if (element === null) {
    throw new Error("No domain notice on the page.");
  }
  return element;
}

/** The add form. */
function addForm(): HTMLElement {
  return screen.getByRole("form", { name: STRINGS.addTitle });
}

function typeHostname(value: string): void {
  fireEvent.change(within(addForm()).getByLabelText(STRINGS.hostnameLabel), { target: { value } });
}

function submitAdd(): void {
  const form = addForm();
  fireEvent.submit(form, { submitter: within(form).getByRole("button", { name: STRINGS.add }) });
}

/** The entries of the error summary inside `container`. */
function summaryItems(container: HTMLElement): string[] {
  const element = within(container).queryByRole("alert", { name: FORM_STRINGS.errorSummaryTitle });
  return element === null ? [] : [...element.querySelectorAll("li")].map((entry) => entry.textContent ?? "");
}

/** Replaces the clipboard with a recorder; `fail` makes every write refuse, as a browser does outside HTTPS. */
function stubClipboard(fail = false): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(() => (fail ? Promise.reject(new Error("denied")) : Promise.resolve()));
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
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
  element: ReactNode,
): Promise<{ errors: unknown[]; root: Root; serverDom: string; container: HTMLElement }> {
  const errors: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(["console.error", ...args]);
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    errors.push(["console.warn", ...args]);
  });
  const onError = (event: ErrorEvent) => errors.push(["error event", event.error]);
  window.addEventListener("error", onError);
  try {
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
  } finally {
    window.removeEventListener("error", onError);
  }
}

// ---- The actions' form data ----------------------------------------------------------------------------------------

const ADD_IDLE: AddDomainState = { status: "idle", hostname: "" };
const ACTION_IDLE: DomainActionState = { status: "idle" };

function addFormData(hostname: string, tenantId = TENANT_ID): FormData {
  const data = new FormData();
  data.set("tenantId", tenantId);
  data.set("hostname", hostname);
  return data;
}

function actionFormData(fields: Readonly<Record<string, string>>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries({
    tenantId: TENANT_ID,
    domainId: TRAVEL_ID,
    hostname: "travel.acme.com",
    verificationStatus: "pending",
    ...fields,
  })) {
    data.set(name, value);
  }
  return data;
}

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = DOMAINS_PAGE;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe022_portal",
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
 * The budget of the file's warm-up hook. The first render of the page in a fresh worker (the page modules, the API
 * client, Testing Library, Radix's alert dialog and React's DOM on their first run) and the first runs of the actions
 * are the slowest, and on a busy CI runner they otherwise land in the first test's own five seconds. The hook only
 * stops if it hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: the page opened with every part (the add form, the actions, the remove dialog), the
 * two actions run once, and the page rendered on the server and hydrated, so the test bodies hold only the steps they
 * check. Nothing of it stays: each test gets a fresh API (`resetPlatformApi`), fresh mocks and globals (`restoreMocks`,
 * `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routesWith([subdomain(), customDomain(), verifiedDomain()]);
  await openDomains();
  fireEvent.click(actionButton("travel.acme.com", STRINGS.remove));
  await screen.findByRole("alertdialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await addDomain(ADD_IDLE, addFormData("travel.acme.com"));
  await changeDomain(ACTION_IDLE, actionFormData({ intent: "remove" }));
  const { root } = await serverRenderAndHydrate(await pageTree());
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- Adding a domain (PF-41 AC1) -----------------------------------------------------------------------------------

describe("adding a domain", () => {
  it("[PFE-022 AC1] adding a domain shows the TXT record and both routing options to create, with copy buttons [PF-41 AC1]", async () => {
    const writeText = stubClipboard();
    const view = await openDomains();
    const section = screen.getByRole("region", { name: STRINGS.customTitle });
    expect(within(section).getByText(STRINGS.customEmpty)).toBeTruthy();

    typeHostname("  Travel.Acme.com  ");
    submitAdd();

    const added = await screen.findByRole(
      "group",
      { name: STRINGS.addedTitle("travel.acme.com") },
      ACTION_WAIT,
    );
    const [request, ...more] = calls("POST", DOMAINS_PATH);
    expect(more).toHaveLength(0);
    expectSessionHeaders(request);
    // The host name as typed, trimmed; the API lower-cases and checks it.
    expect(await bodyOf(request)).toEqual({ hostname: "Travel.Acme.com" });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(DOMAINS_PAGE);
    // The records to create take the focus, and the field is empty for the next domain.
    expect(document.activeElement).toBe(added);
    expect((within(addForm()).getByLabelText(STRINGS.hostnameLabel) as HTMLInputElement).value).toBe("");

    // The TXT record and both routing options, as the API lists them, each name and value with a copy button.
    const table = within(added).getByRole("table", { name: STRINGS.recordsCaption("travel.acme.com") });
    expect(recordRows(table)).toEqual([
      ["TXT", "_velexis.travel.acme.com", TOKEN],
      ["CNAME", "travel.acme.com", "acme.ota.example.com"],
      ["A", "travel.acme.com", "203.0.113.10"],
      ["AAAA", "travel.acme.com", "2001:db8::10"],
    ]);
    expect(added.querySelector('[data-guide="ownership"]')?.textContent).toBe(STRINGS.ownershipStep);
    expect(added.querySelector('[data-guide="routing"]')?.textContent).toBe(
      STRINGS.routingStep(true, ["A", "AAAA"]),
    );
    expect(STRINGS.routingStep(true, ["A", "AAAA"])).toContain("either the CNAME record");
    expect(
      within(table)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(
      ["TXT", "CNAME", "A", "AAAA"].flatMap((type) => [STRINGS.copyName(type), STRINGS.copyValue(type)]),
    );
    // The new domain waits for its first check, until its deadline.
    expect(detail(added, "lastCheck")).toBe(STRINGS.notChecked);
    expect(detail(added, "verificationDeadlineAt")).toBe(
      formatDateTime(daysFromStart(3), { timeZone: TIME_ZONE }),
    );

    // Copying writes the value to the clipboard on request, and the live region says what was copied.
    fireEvent.click(within(table).getByRole("button", { name: STRINGS.copyValue("TXT") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN), ACTION_WAIT);
    expect((await within(added).findByRole("status", {}, ACTION_WAIT)).textContent).toBe(
      STRINGS.copiedValue("TXT"),
    );

    // The revalidated page lists the new domain with the same records; "Done" closes the answer.
    await refresh(view, {
      [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain(), customDomain()] }, 200),
    });
    expect(recordRows(within(item("travel.acme.com")).getByRole("table"))).toEqual(recordRows(table));
    fireEvent.click(within(added).getByRole("button", { name: STRINGS.addedDismiss }));
    expect(screen.queryByRole("group", { name: STRINGS.addedTitle("travel.acme.com") })).toBeNull();
    expect(writes()).toEqual([`POST ${DOMAINS_PATH}`]);
  });

  it("[PFE-022 AC1] keeps the new domain's records in view when the domain fills the plan, and the limit takes the form's place [PF-41 AC1]", async () => {
    routes({ [`GET ${PLANS_PATH}`]: () => json({ data: [plan("growth", 1)] }, 200) });
    const view = await openDomains();

    typeHostname("travel.acme.com");
    submitAdd();
    const added = await screen.findByRole(
      "group",
      { name: STRINGS.addedTitle("travel.acme.com") },
      ACTION_WAIT,
    );
    expect(document.activeElement).toBe(added);

    // The revalidated page counts one custom domain on a plan with one: no form any more, the records stay.
    await refresh(view, {
      [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain(), customDomain()] }, 200),
      [`GET ${PLANS_PATH}`]: () => json({ data: [plan("growth", 1)] }, 200),
    });
    const section = screen.getByRole("region", { name: STRINGS.addTitle });
    expect(section.querySelector("[data-plan-limit]")?.textContent).toBe(STRINGS.planLimit(1));
    expect(within(section).queryByRole("form")).toBeNull();
    const kept = within(section).getByRole("group", { name: STRINGS.addedTitle("travel.acme.com") });
    expect(kept).toBe(added);
    expect(document.activeElement).toBe(added);
    expect(recordRows(within(kept).getByRole("table")).map(([type]) => type)).toEqual([
      "TXT",
      "CNAME",
      "A",
      "AAAA",
    ]);

    // "Done" closes it; the limit stays.
    fireEvent.click(within(kept).getByRole("button", { name: STRINGS.addedDismiss }));
    expect(within(section).queryByRole("group")).toBeNull();
    expect(section.querySelector("[data-plan-limit]")).not.toBeNull();
    expect(writes()).toEqual([`POST ${DOMAINS_PATH}`]);
  });

  it("[PFE-022 AC1] names the AAAA record only when the API lists one, and says when copying did not work", async () => {
    stubClipboard(true);
    const domain = customDomain({ dnsRecords: records("travel.acme.com", false) });
    render(<DnsRecordsTable domain={domain} timeZone={TIME_ZONE} />);

    expect(recordRows(screen.getByRole("table")).map(([type]) => type)).toEqual(["TXT", "CNAME", "A"]);
    expect(document.querySelector('[data-guide="routing"]')?.textContent).toBe(
      STRINGS.routingStep(true, ["A"]),
    );
    expect(STRINGS.routingStep(true, ["A"])).not.toContain("AAAA");
    expect(screen.queryByRole("button", { name: STRINGS.copyValue("AAAA") })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: STRINGS.copyName("CNAME") }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(STRINGS.copyFailed), ACTION_WAIT);
  });

  it("refuses what is no host name at the field without a call, and keeps what was typed", async () => {
    await openDomains();

    submitAdd();
    await waitFor(() => expect(summaryItems(addForm())).toEqual([STRINGS.hostnameRequired]), ACTION_WAIT);

    typeHostname("https://travel.acme.com/");
    submitAdd();
    await waitFor(() => expect(summaryItems(addForm())).toEqual([STRINGS.hostnameNotHost]), ACTION_WAIT);
    const field = within(addForm()).getByLabelText(STRINGS.hostnameLabel) as HTMLInputElement;
    expect(field.value).toBe("https://travel.acme.com/");
    expect(field.getAttribute("aria-invalid")).toBe("true");

    expect(await addDomain(ADD_IDLE, addFormData(`${"a".repeat(250)}.com`))).toMatchObject({
      status: "failed",
      fieldError: STRINGS.hostnameTooLong,
    });
    expect(await addDomain(ADD_IDLE, addFormData("travel.acme.com", "not-an-ota"))).toMatchObject({
      status: "failed",
      message: STRINGS.formExpired,
    });
    expect(writes()).toEqual([]);
  });

  it("shows the API's refusals in the portal's words: at the field for the host name, above the form otherwise", async () => {
    const answers: [Response, Partial<AddDomainState>][] = [
      [apiError("DOMAIN_INVALID", 422), { fieldError: STRINGS.hostnameInvalid }],
      [apiError("DOMAIN_TAKEN", 409), { fieldError: STRINGS.hostnameTaken }],
      [
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/hostname", code: "maxLength" }] }),
        { fieldError: STRINGS.hostnameInvalid },
      ],
      [
        apiError("PLAN_LIMIT_REACHED", 422, { details: { limit: 1, used: 1 } }),
        { message: STRINGS.planLimit(1) },
      ],
      [apiError("TENANT_NOT_ACTIVE", 409), { message: STRINGS.notActive }],
      [apiError("FORBIDDEN", 403), { message: STRINGS.forbidden }],
      [apiError("SERVICE_UNAVAILABLE", 503), { message: ERROR_MESSAGES.SERVICE_UNAVAILABLE }],
      [apiError("FEATURE_DISABLED", 403, { details: { feature: "custom_domains" } }), { upgrade: true }],
    ];
    for (const [answer, expected] of answers) {
      routes({ [`POST ${DOMAINS_PATH}`]: () => answer });
      const state = await addDomain(ADD_IDLE, addFormData("travel.acme.com"));
      expect(state).toMatchObject({ status: "failed", hostname: "travel.acme.com", ...expected });
      expect(JSON.stringify(state)).not.toContain(API_TEXT);
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // On the page: a taken host stays in the field with the message at it.
    routes({ [`POST ${DOMAINS_PATH}`]: () => apiError("DOMAIN_TAKEN", 409) });
    await openDomains();
    typeHostname("travel.acme.com");
    submitAdd();
    await waitFor(() => expect(summaryItems(addForm())).toEqual([STRINGS.hostnameTaken]), ACTION_WAIT);
    expect((within(addForm()).getByLabelText(STRINGS.hostnameLabel) as HTMLInputElement).value).toBe(
      "travel.acme.com",
    );
    expect(document.body.textContent).not.toContain(API_TEXT);
  });

  it("[PFE-022 AC1] an answer FEATURE_DISABLED puts the upgrade hint in the form's place, with billing for owners", async () => {
    routes({ [`POST ${DOMAINS_PATH}`]: () => apiError("FEATURE_DISABLED", 403) });
    await openDomains();
    typeHostname("travel.acme.com");
    submitAdd();

    const section = screen.getByRole("region", { name: STRINGS.addTitle });
    await waitFor(() => expect(section.querySelector("[data-upgrade-hint]")).not.toBeNull(), ACTION_WAIT);
    expect(within(section).queryByRole("form")).toBeNull();
    expect(section.textContent).toContain(STRINGS.upgrade);
    expect(within(section).getByRole("link", { name: STRINGS.billingLink }).getAttribute("href")).toBe(
      BILLING_PAGE,
    );
  });
});

// ---- Plans, roles and OTA states -----------------------------------------------------------------------------------

describe("who may add a domain", () => {
  it("[PFE-022 AC1] a plan without custom domains shows the upgrade hint instead of the form; a full plan says its limit", async () => {
    routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ planCode: "starter" }), 200) });
    await openDomains();
    let section = screen.getByRole("region", { name: STRINGS.addTitle });
    expect(within(section).queryByRole("form")).toBeNull();
    expect(within(section).getByText(STRINGS.upgradeTitle)).toBeTruthy();
    expect(within(section).getByRole("link", { name: STRINGS.billingLink }).getAttribute("href")).toBe(
      BILLING_PAGE,
    );
    expect(calls("GET", PLANS_PATH)).toHaveLength(1);
    // listPlans is public: no access token goes with it.
    expect(calls("GET", PLANS_PATH)[0]?.headers.get("authorization")).toBeNull();
    cleanup();

    // Admins cannot open billing: an owner chooses the plan.
    routesAs("admin", {
      [`GET ${TENANT_PATH}`]: () => json(tenant({ planCode: "starter", myRole: "admin" }), 200),
    });
    await openDomains();
    section = screen.getByRole("region", { name: STRINGS.addTitle });
    expect(section.textContent).toContain(STRINGS.upgradeAskOwner);
    expect(within(section).queryByRole("link")).toBeNull();
    cleanup();

    // Two custom domains on a plan with two: the limit instead of the form.
    routesWith([subdomain(), customDomain(), verifiedDomain()], {
      [`GET ${PLANS_PATH}`]: () => json({ data: [plan("growth", 2)] }, 200),
    });
    await openDomains();
    section = screen.getByRole("region", { name: STRINGS.addTitle });
    expect(section.querySelector("[data-plan-limit]")?.textContent).toBe(STRINGS.planLimit(2));
    expect(within(section).queryByRole("form")).toBeNull();
    cleanup();

    // A plan listPlans does not list (or a failed call) leaves it to the API: the form shows.
    routes({ [`GET ${PLANS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openDomains();
    expect(addForm()).toBeTruthy();
  });

  it("agents, finance members and viewers read the domains without a form, an action or a plan call", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      routesAs(role, {
        [`GET ${DOMAINS_PATH}`]: () =>
          json(
            {
              data: [
                subdomain({ isPrimary: false }),
                verifiedDomain({ isPrimary: true }),
                customDomain({ id: FLY_ID, hostname: "fly.acme.com", verificationStatus: "failed" }),
              ],
            },
            200,
          ),
      });
      await openDomains();
      expect(screen.getByRole("region", { name: STRINGS.customTitle })).toBeTruthy();
      expect(screen.queryByRole("region", { name: STRINGS.addTitle })).toBeNull();
      expect(document.querySelector("[data-domain-actions]")).toBeNull();
      expect(document.querySelector("[data-domain-notice]")).toBeNull();
      // Copy buttons only: nothing that changes a domain.
      expect(
        screen.queryAllByRole("button").filter((button) => button.getAttribute("aria-label") === null),
      ).toEqual([]);
      expect(item("fly.acme.com").querySelector("[data-failed-note]")?.textContent).toBe(
        STRINGS.failedNoteReadOnly,
      );
      expect(calls("GET", PLANS_PATH)).toHaveLength(0);
      cleanup();
    }
  });

  it("says why nothing can be changed while the OTA is suspended, and asks no plan", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "suspended", suspensionReason: "billing" }), 200),
      [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain({ isPrimary: false }), verifiedDomain()] }, 200),
    });
    await openDomains();

    const section = screen.getByRole("region", { name: STRINGS.addTitle });
    expect(within(section).getByText(STRINGS.readOnlyTitle)).toBeTruthy();
    expect(within(section).getByText(STRINGS.readOnly.suspended)).toBeTruthy();
    expect(within(section).queryByRole("form")).toBeNull();
    expect(document.querySelector("[data-domain-actions]")).toBeNull();
    expect(calls("GET", PLANS_PATH)).toHaveLength(0);
  });
});

// ---- The domains: last check, certificate, actions (PF-41 AC2 to AC4) ----------------------------------------------

describe("the domains", () => {
  it("[PFE-022 AC1] a pending domain shows its last check error in plain words, never the code [PF-41 AC2]", async () => {
    routesWith([
      subdomain(),
      customDomain({ lastCheckedAt: daysFromStart(-0.01), lastCheckError: "cname_wrong_target" }),
    ]);
    await openDomains();

    const pending = item("travel.acme.com");
    expect(pending.querySelector("[data-status]")?.textContent).toBe(STATUS_LABELS.domain.pending);
    expect(detail(pending, "lastCheck")).toBe(
      `${formatDateTime(daysFromStart(-0.01), { timeZone: TIME_ZONE })}: ${DNS_CHECK_ERRORS["cname_wrong_target"]}`,
    );
    expect(document.body.textContent).not.toContain("cname_wrong_target");

    // The six codes of flows/custom-domains.md, each in its own words.
    const codes = [
      "txt_missing",
      "txt_mismatch",
      "cname_missing",
      "cname_wrong_target",
      "a_wrong_address",
      "dns_timeout",
    ];
    expect(Object.keys(DNS_CHECK_ERRORS).sort()).toEqual([...codes].sort());
    expect(new Set(codes.map(dnsCheckMessage)).size).toBe(codes.length);
    for (const code of codes) {
      cleanup();
      render(
        <DnsRecordsTable
          domain={customDomain({ lastCheckedAt: daysFromStart(-0.01), lastCheckError: code })}
          timeZone={TIME_ZONE}
        />,
      );
      const words = document.querySelector("[data-check-result]")?.textContent ?? "";
      expect(words).toBe(DNS_CHECK_ERRORS[code]);
      expect(words).not.toContain(code);
    }
  });

  it("[PFE-022 AC2] a verified domain shows its certificate's status and expiry; a failed domain says how to start again [PF-41 AC3]", async () => {
    routesWith([
      subdomain(),
      verifiedDomain(),
      verifiedDomain({
        id: SHOP_ID,
        hostname: "shop.acme.com",
        tlsStatus: "expired",
        tlsExpiresAt: daysFromStart(-2),
      }),
      verifiedDomain({ id: FLY_ID, hostname: "fly.acme.com", tlsStatus: "pending", tlsExpiresAt: null }),
      customDomain({
        verificationStatus: "failed",
        lastCheckedAt: daysFromStart(-0.5),
        lastCheckError: "txt_missing",
        verificationDeadlineAt: daysFromStart(-1),
      }),
    ]);
    await openDomains();

    const issued = item("acme.com");
    expect(tlsDetail(issued, "status")).toBe(`${STATUS_LABELS.tls.issued}${TLS_STATUS_NOTES["issued"]}`);
    expect(tlsDetail(issued, "expiresAt")).toBe(formatDateTime(daysFromStart(80), { timeZone: TIME_ZONE }));
    expect(issued.querySelector('[data-tls-detail="expiresAt"] time')?.getAttribute("dateTime")).toBe(
      daysFromStart(80),
    );
    expect(issued.querySelector('[data-tls-detail="expiresAt"] dt')?.textContent).toBe(STRINGS.tlsExpires);
    // A verified domain keeps its records, with nothing left to wait for.
    expect(issued.querySelector("[data-records-guide] p")?.textContent).toBe(STRINGS.keepRecords);
    expect(issued.querySelector("[data-detail]")).toBeNull();

    const expired = item("shop.acme.com");
    expect(tlsDetail(expired, "status")).toBe(`${STATUS_LABELS.tls.expired}${TLS_STATUS_NOTES["expired"]}`);
    expect(expired.querySelector('[data-tls-detail="expiresAt"] dt')?.textContent).toBe(STRINGS.tlsExpired);

    const waiting = item("fly.acme.com");
    expect(tlsDetail(waiting, "status")).toBe(`${STATUS_LABELS.tls.pending}${TLS_STATUS_NOTES["pending"]}`);
    expect(tlsDetail(waiting, "expiresAt")).toBeUndefined();

    // A failed domain: why, its last check, and no deadline (its window has ended); no certificate yet.
    const failed = item("travel.acme.com");
    expect(failed.querySelector("[data-failed-note]")?.textContent).toBe(STRINGS.failedNote);
    expect(detail(failed, "lastCheck")).toContain(DNS_CHECK_ERRORS["txt_missing"]);
    expect(detail(failed, "verificationDeadlineAt")).toBeUndefined();
    expect(failed.querySelector("[data-tls]")).toBeNull();
    // The Velexis address shows no certificate: Velexis manages it.
    expect(item("acme.ota.example.com").querySelector("[data-tls]")).toBeNull();
  });

  it('[PFE-022 AC2] offers "Make primary" only for verified domains, and for the sub-domain whenever it is not primary [PF-41 AC4]', async () => {
    routesWith([
      subdomain({ isPrimary: false }),
      verifiedDomain({ isPrimary: true }),
      verifiedDomain({ id: SHOP_ID, hostname: "shop.acme.com" }),
      customDomain(),
      customDomain({ id: FLY_ID, hostname: "fly.acme.com", verificationStatus: "failed" }),
    ]);
    await openDomains();

    const actions = (hostname: string) =>
      buttonNames(item(hostname))
        // The copy buttons have no text of their own (their name is their label).
        .filter((name) => name !== "")
        .map((name) => name.replace(STRINGS.actionTarget(hostname), ""));
    expect(actions("acme.ota.example.com")).toEqual([STRINGS.makePrimary]);
    expect(actions("acme.com")).toEqual([STRINGS.remove]);
    expect(actions("shop.acme.com")).toEqual([STRINGS.makePrimary, STRINGS.remove]);
    expect(actions("travel.acme.com")).toEqual([STRINGS.checkNow, STRINGS.remove]);
    expect(actions("fly.acme.com")).toEqual([STRINGS.checkNow, STRINGS.remove]);

    // Going back to the sub-domain needs neither the switch nor the plan: it is offered with custom domains off too.
    cleanup();
    fetchMock.mockClear();
    routes({
      [`GET ${ME_PATH}`]: () => json(account({ customDomains: false }), 200),
      [`GET ${DOMAINS_PATH}`]: () =>
        json({ data: [subdomain({ isPrimary: false }), verifiedDomain({ isPrimary: true })] }, 200),
      [`POST ${primaryPath(SUBDOMAIN_ID)}`]: () => json(subdomain(), 200),
    });
    await openDomains();
    expect(screen.queryByRole("region", { name: STRINGS.customTitle })).toBeNull();
    fireEvent.click(actionButton("acme.ota.example.com", STRINGS.makePrimary));
    await waitFor(
      () => expect(notice().textContent).toBe(STRINGS.primaryDone("acme.ota.example.com")),
      ACTION_WAIT,
    );
    expect(writes()).toEqual([`POST ${primaryPath(SUBDOMAIN_ID)}`]);
    expect(calls("GET", PLANS_PATH)).toHaveLength(0);

    // The rule itself: verified and not primary; the sub-domain is never checked or removed.
    expect(domainActionsOf(subdomain())).toEqual({ check: false, makePrimary: false, remove: false });
    expect(domainActionsOf(subdomain({ isPrimary: false }))).toEqual({
      check: false,
      makePrimary: true,
      remove: false,
    });
    for (const status of ["pending", "failed"] as const) {
      expect(domainActionsOf(customDomain({ verificationStatus: status }))).toEqual({
        check: true,
        makePrimary: false,
        remove: true,
      });
    }
  });

  it("[PFE-022 AC2] makes a verified domain primary and says so, the outcome taking the focus [PF-41 AC4]", async () => {
    routesWith([subdomain(), verifiedDomain({ id: SHOP_ID, hostname: "shop.acme.com" })], {
      [`POST ${primaryPath(SHOP_ID)}`]: () =>
        json(verifiedDomain({ id: SHOP_ID, hostname: "shop.acme.com", isPrimary: true }), 200),
    });
    const view = await openDomains();

    fireEvent.click(actionButton("shop.acme.com", STRINGS.makePrimary));
    await waitFor(() => expect(notice().textContent).toBe(STRINGS.primaryDone("shop.acme.com")), ACTION_WAIT);
    const [request] = calls("POST", primaryPath(SHOP_ID));
    expectSessionHeaders(request);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(DOMAINS_PAGE);
    expect(notice().getAttribute("role")).toBe("status");

    // The revalidated page: the sub-domain may be made primary again, the new primary has no such button.
    await refresh(view, {
      [`GET ${DOMAINS_PATH}`]: () =>
        json(
          {
            data: [
              subdomain({ isPrimary: false }),
              verifiedDomain({ id: SHOP_ID, hostname: "shop.acme.com", isPrimary: true }),
            ],
          },
          200,
        ),
    });
    expect(item("shop.acme.com").querySelector("[data-primary]")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(notice()), ACTION_WAIT);
    expect(actionButton("acme.ota.example.com", STRINGS.makePrimary)).toBeTruthy();
    expect(writes()).toEqual([`POST ${primaryPath(SHOP_ID)}`]);

    // A custom domain whose certificate is not issued yet is linked only once it is: the outcome says so.
    routes({
      [`POST ${primaryPath(SHOP_ID)}`]: () =>
        json(
          verifiedDomain({
            id: SHOP_ID,
            hostname: "shop.acme.com",
            isPrimary: true,
            tlsStatus: "pending",
            tlsExpiresAt: null,
          }),
          200,
        ),
    });
    const waiting = await changeDomain(
      ACTION_IDLE,
      actionFormData({ intent: "makePrimary", domainId: SHOP_ID, hostname: "shop.acme.com" }),
    );
    expect(waiting).toMatchObject({ status: "done", message: STRINGS.primaryDone("shop.acme.com", true) });
    expect(STRINGS.primaryDone("shop.acme.com", true)).toContain("once its certificate is issued");
  });

  it('"Check now" queues the check, starts a new window for a failed domain, and says when to try again after a rate limit', async () => {
    routesWith(
      [
        subdomain(),
        customDomain(),
        customDomain({ id: FLY_ID, hostname: "fly.acme.com", verificationStatus: "failed" }),
      ],
      {
        [`POST ${checkPath(TRAVEL_ID)}`]: () => json(customDomain(), 202),
        [`POST ${checkPath(FLY_ID)}`]: () =>
          json(customDomain({ id: FLY_ID, hostname: "fly.acme.com" }), 202),
      },
    );
    await openDomains();

    fireEvent.click(actionButton("travel.acme.com", STRINGS.checkNow));
    await waitFor(() => expect(noticeMessage()).toBe(STRINGS.checkStarted("travel.acme.com")), ACTION_WAIT);
    expectSessionHeaders(calls("POST", checkPath(TRAVEL_ID))[0]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(DOMAINS_PAGE);
    // The result shows once the worker has checked: the notice links to a full reload of the page.
    expect(within(notice()).getByRole("link", { name: STRINGS.reload }).getAttribute("href")).toBe(
      DOMAINS_PAGE,
    );

    fireEvent.click(actionButton("fly.acme.com", STRINGS.checkNow));
    await waitFor(() => expect(noticeMessage()).toBe(STRINGS.checkRestarted("fly.acme.com")), ACTION_WAIT);

    // One check per domain per minute: the wait of Retry-After, in words.
    routesWith([subdomain(), customDomain()], {
      [`POST ${checkPath(TRAVEL_ID)}`]: () =>
        apiError("RATE_LIMITED", 429, { headers: { "Retry-After": "42" } }),
    });
    fireEvent.click(actionButton("travel.acme.com", STRINGS.checkNow));
    await waitFor(() => expect(notice().textContent).toBe(STRINGS.checkRateLimited(42)), ACTION_WAIT);
    expect(notice().getAttribute("role")).toBe("alert");
    expect(within(notice()).queryByRole("link")).toBeNull();
    expect(STRINGS.checkRateLimited(undefined)).toContain("once a minute");
    expect(document.body.textContent).not.toContain(API_TEXT);
  });

  it('"Check now" and "Make primary" answered FEATURE_DISABLED show the upgrade hint: billing for owners, an owner for admins', async () => {
    routesWith([subdomain(), customDomain()], {
      [`POST ${checkPath(TRAVEL_ID)}`]: () =>
        apiError("FEATURE_DISABLED", 403, { details: { feature: "custom_domains" } }),
    });
    await openDomains();
    fireEvent.click(actionButton("travel.acme.com", STRINGS.checkNow));
    await waitFor(
      () => expect(notice().textContent).toBe(`${STRINGS.upgrade} ${STRINGS.billingLink}`),
      ACTION_WAIT,
    );
    expect(within(notice()).getByRole("link", { name: STRINGS.billingLink }).getAttribute("href")).toBe(
      BILLING_PAGE,
    );
    cleanup();

    routesAs("admin", {
      [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain(), verifiedDomain()] }, 200),
      [`POST ${primaryPath(APEX_ID)}`]: () => apiError("FEATURE_DISABLED", 403),
    });
    await openDomains();
    fireEvent.click(actionButton("acme.com", STRINGS.makePrimary));
    await waitFor(() => expect(notice().textContent).toBe(STRINGS.upgradeAskOwner), ACTION_WAIT);
    expect(within(notice()).queryByRole("link")).toBeNull();
  });

  it('"Remove" asks first, removes after the confirmation and says so above the list', async () => {
    // The API answers once the dialog has closed and given the focus back, as the network's time does in a browser.
    let answer: (response: Response) => void = () => undefined;
    const removed = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    routesWith([subdomain(), customDomain()], { [`DELETE ${domainPath(TRAVEL_ID)}`]: () => removed });
    const view = await openDomains();

    fireEvent.click(actionButton("travel.acme.com", STRINGS.remove));
    const cancelled = await screen.findByRole(
      "alertdialog",
      { name: STRINGS.removeTitle("travel.acme.com") },
      ACTION_WAIT,
    );
    expect(cancelled.textContent).toContain(STRINGS.removeDescription);
    fireEvent.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), ACTION_WAIT);
    expect(writes()).toEqual([]);

    fireEvent.click(actionButton("travel.acme.com", STRINGS.remove));
    const dialog = await screen.findByRole("alertdialog", {}, ACTION_WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: STRINGS.removeConfirm }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), ACTION_WAIT);
    await waitFor(() => expect(calls("DELETE", domainPath(TRAVEL_ID))).toHaveLength(1), ACTION_WAIT);
    // While it runs, the button says so and every action waits.
    expect(actionButton("travel.acme.com", STRINGS.removing).hasAttribute("disabled")).toBe(true);
    expect(actionButton("travel.acme.com", STRINGS.checkNow).hasAttribute("disabled")).toBe(true);
    answer(new Response(null, { status: 204 }));
    await waitFor(
      () => expect(notice().textContent).toBe(STRINGS.removedDone("travel.acme.com")),
      ACTION_WAIT,
    );
    expectSessionHeaders(calls("DELETE", domainPath(TRAVEL_ID))[0]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(DOMAINS_PAGE);

    // The revalidated page has no such domain; the outcome stays above the list and takes the focus.
    await refresh(view);
    expect(document.querySelector('li[data-domain="travel.acme.com"]')).toBeNull();
    expect(notice().textContent).toBe(STRINGS.removedDone("travel.acme.com"));
    await waitFor(() => expect(document.activeElement).toBe(notice()), ACTION_WAIT);
    expect(writes()).toEqual([`DELETE ${domainPath(TRAVEL_ID)}`]);
  });

  it("maps every refusal of a domain action to the portal's words and refuses a form without ids without a call", async () => {
    // [intent, answer, path, words, whether the notice links to a reload (the page no longer shows the domain as it is)]
    const cases: [string, Route, string, string, boolean][] = [
      [
        "check",
        () => apiError("CONFLICT", 409, { details: { reason: "already_verified" } }),
        checkPath(TRAVEL_ID),
        STRINGS.alreadyVerified,
        true,
      ],
      ["check", () => apiError("TENANT_NOT_ACTIVE", 409), checkPath(TRAVEL_ID), STRINGS.notActive, true],
      ["check", () => apiError("NOT_FOUND", 404), checkPath(TRAVEL_ID), STRINGS.removedMeanwhile, true],
      [
        "makePrimary",
        () => apiError("DOMAIN_NOT_VERIFIED", 409),
        primaryPath(TRAVEL_ID),
        STRINGS.notVerified,
        true,
      ],
      ["makePrimary", () => apiError("FORBIDDEN", 403), primaryPath(TRAVEL_ID), STRINGS.forbidden, true],
      [
        "remove",
        () => apiError("CONFLICT", 409, { details: { reason: "subdomain" } }),
        domainPath(TRAVEL_ID),
        STRINGS.subdomainConflict,
        false,
      ],
      ["remove", () => apiError("RATE_LIMITED", 429), domainPath(TRAVEL_ID), STRINGS.rateLimited, false],
      [
        "remove",
        () => apiError("SERVICE_UNAVAILABLE", 503),
        domainPath(TRAVEL_ID),
        ERROR_MESSAGES.SERVICE_UNAVAILABLE,
        false,
      ],
    ];
    for (const [intent, answer, path, message, reload] of cases) {
      const method = intent === "remove" ? "DELETE" : "POST";
      routes({ [`${method} ${path}`]: answer });
      const state = await changeDomain(ACTION_IDLE, actionFormData({ intent }));
      expect(state).toMatchObject({ status: "failed", intent, domainId: TRAVEL_ID, message });
      expect(state.reload === true).toBe(reload);
      expect(JSON.stringify(state)).not.toContain(API_TEXT);
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    fetchMock.mockClear();
    for (const fields of [
      { intent: "check", domainId: "dom_x" },
      { intent: "rename" },
      { intent: "check", tenantId: "x" },
    ]) {
      expect(await changeDomain(ACTION_IDLE, actionFormData(fields))).toMatchObject({
        status: "failed",
        message: STRINGS.formExpired,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes to sign-in and back to the domains page when the session ended, from an action as from the page", async () => {
    const back = `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fdomains`;
    routes({ [`POST ${checkPath(TRAVEL_ID)}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(changeDomain(ACTION_IDLE, actionFormData({ intent: "check" }))).rejects.toThrow(back);
    routes({ [`POST ${DOMAINS_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(addDomain(ADD_IDLE, addFormData("travel.acme.com"))).rejects.toThrow(back);
    routes({ [`DELETE ${domainPath(TRAVEL_ID)}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(changeDomain(ACTION_IDLE, actionFormData({ intent: "remove" }))).rejects.toThrow(
      "NEXT_REDIRECT /verify-pending",
    );
  });
});

// ---- Server rendering ----------------------------------------------------------------------------------------------

describe("rendered on the server", () => {
  let rendered: Awaited<ReturnType<typeof serverRenderAndHydrate>> | undefined;

  afterEach(() => {
    const root = rendered?.root;
    if (root !== undefined) {
      act(() => root.unmount());
    }
    rendered = undefined;
  });

  it("renders the page with its form, records and actions, and hydrates it without an error or a change", async () => {
    routesWith([
      subdomain({ isPrimary: false }),
      verifiedDomain({ isPrimary: true }),
      customDomain({ lastCheckedAt: daysFromStart(-0.01), lastCheckError: "txt_mismatch" }),
    ]);
    rendered = await serverRenderAndHydrate(await DomainsPage({ params: params() }));

    expect(rendered.errors).toEqual([]);
    expect(rendered.container.innerHTML).toBe(rendered.serverDom);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("[data-add-domain-form]")).not.toBeNull();
    expect(rendered.container.querySelectorAll("[data-domain-actions]")).toHaveLength(3);
    expect(rendered.container.querySelectorAll("[data-dns-records]")).toHaveLength(2);
  });
});
