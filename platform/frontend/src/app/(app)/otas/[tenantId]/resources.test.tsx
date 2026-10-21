// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import type { ReactElement, ReactNode } from "react";
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

/**
 * React's `cache()` as Next.js runs it on the server: one memo per request (see ota-dashboard.test.tsx). The client
 * build of React that a component test loads makes `cache()` a pass-through; with this the layout and the page of
 * one request share their `getTenant` call. Every `routes()` call starts a new request.
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

import AmadeusPage from "@/app/(app)/otas/[tenantId]/amadeus/page";
import BillingPage from "@/app/(app)/otas/[tenantId]/billing/page";
import DomainsPage from "@/app/(app)/otas/[tenantId]/domains/page";
import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import PaymentsPage from "@/app/(app)/otas/[tenantId]/payments/page";
import { amadeusSummary, byEnvironment, paymentSummary } from "@/components/connection-card";
import { formatDateTime } from "@/components/date-time";
import { dnsCheckMessage } from "@/components/dns-records-table";
import { SideNav } from "@/components/side-nav";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { AccountMembership, MilestoneFeatures, TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  AMADEUS_STRINGS,
  BILLING_STRINGS,
  CONNECTION_STRINGS,
  DNS_CHECK_ERRORS,
  DOMAINS_STRINGS,
  ERROR_MESSAGES,
  NOT_ALLOWED_STRINGS,
  PAYMENTS_STRINGS,
  ROLE_LABELS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) -------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type Account = Schemas["Account"];
type Domain = Schemas["Domain"];
type AmadeusConnection = Schemas["AmadeusConnection"];
type PaymentConnection = Schemas["PaymentConnection"];
type Subscription = Schemas["Subscription"];

const ACCESS_TOKEN = "pfe013-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-013 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TIME_ZONE = "Europe/Oslo";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const ME_PATH = "/v1/me";
const DOMAINS_PATH = `${TENANT_PATH}/domains`;
const AMADEUS_PATH = `${TENANT_PATH}/amadeus-connections`;
const PAYMENTS_PATH = `${TENANT_PATH}/payment-connections`;
const SUBSCRIPTION_PATH = `${TENANT_PATH}/subscription`;
/** A value the API must never answer and the page never show (a secret's or ciphertext's stand-in). */
const NEVER_SHOWN = "pfe013-never-shown-value";

/** The fixtures' instants are relative to the start of the file, never a calendar date. */
const START = Date.now();
const DAY_MS = 86_400_000;
function daysFromStart(days: number): string {
  return new Date(START + days * DAY_MS).toISOString();
}

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
    timeZone: TIME_ZONE,
    supportEmail: null,
    storefrontEnvironment: "test",
    liveEnabledAt: null,
    primaryHost: "acme.ota.example.com",
    schemaVersion: "0002_m1",
    createdAt: daysFromStart(-6),
    activatedAt: daysFromStart(-6),
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

function account(features: Partial<MilestoneFeatures> = {}): Account {
  return {
    id: "acc_01JA2Z5K8N3Q6S9V2X5Z8B1D4F",
    email: "owner@example.com",
    emailVerified: true,
    fullName: "Ines Owner",
    locale: "en",
    timeZone: "UTC",
    mfaEnabled: true,
    mfaEnabledAt: daysFromStart(-5),
    isPlatformAdmin: false,
    createdAt: daysFromStart(-7),
    version: 2,
    memberships: [membership("owner")],
    features: { ...FEATURES_OFF, ...features },
  };
}

/** The Velexis sub-domain as provisioning creates it: verified and primary, without DNS records. */
function subdomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "dom_01JA2Z7Q4M9R2T6V0X3Z8B1D6G",
    hostname: "acme.ota.example.com",
    kind: "subdomain",
    purpose: "storefront",
    isPrimary: true,
    verificationStatus: "verified",
    dnsRecords: [],
    verificationDeadlineAt: null,
    lastCheckedAt: null,
    lastCheckError: null,
    tlsStatus: "pending",
    tlsExpiresAt: null,
    createdAt: daysFromStart(-6),
    ...overrides,
  };
}

/** A custom domain (M5) whose TXT record was not found yet. */
function customDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "dom_01JA2ZC4E8G2J6M0Q4S8V2X6Z0",
    hostname: "travel.acme.com",
    kind: "custom",
    purpose: "storefront",
    isPrimary: false,
    verificationStatus: "pending",
    dnsRecords: [
      { type: "TXT", name: "_velexis.travel.acme.com", value: "velexis-verify=pfe013dummytoken" },
      { type: "CNAME", name: "travel.acme.com", value: "acme.ota.example.com" },
    ],
    verificationDeadlineAt: daysFromStart(2),
    lastCheckedAt: daysFromStart(-0.01),
    lastCheckError: "txt_missing",
    tlsStatus: "pending",
    tlsExpiresAt: null,
    createdAt: daysFromStart(-1),
    ...overrides,
  };
}

/** The test connection of provisioning's `assign_amadeus_office` (flows/amadeus-connection.md §B). */
function amadeusConnection(overrides: Partial<AmadeusConnection> = {}): AmadeusConnection {
  return {
    id: "sc_01JA2ZB9C3E7G1J5M9Q3S7V1X5",
    environment: "test",
    credentialSource: "velexis",
    status: "active",
    officeIds: ["NCE1A0955"],
    defaultOfficeId: "NCE1A0955",
    queuingOfficeId: "NCE1A0955",
    ownerOfficeId: "NCE1A0955",
    clientId: null,
    ticketingDefaults: {},
    monitoredQueues: [],
    lastVerifiedAt: daysFromStart(-6),
    lastError: null,
    pendingSubmission: null,
    version: 1,
    ...overrides,
  };
}

/** The connection of a pool that was empty at set-up (PF-50 AC2): pending, without an office. */
function pendingAmadeusConnection(): AmadeusConnection {
  return amadeusConnection({
    status: "pending_verification",
    officeIds: [],
    defaultOfficeId: null,
    queuingOfficeId: null,
    ownerOfficeId: null,
    lastVerifiedAt: null,
  });
}

/** The test row of provisioning (flows/stripe-payments-account.md §A): Velexis mode, active. */
function paymentConnection(overrides: Partial<PaymentConnection> = {}): PaymentConnection {
  return {
    id: "ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6X",
    environment: "test",
    provider: "stripe",
    accountMode: "velexis",
    status: "active",
    accountReference: null,
    publishableKey: null,
    statementDescriptorSuffix: "ACME TRAVEL",
    capabilities: {},
    connectedAt: null,
    disconnectedAt: null,
    webhookUrl: null,
    pendingSubmission: null,
    version: 1,
    ...overrides,
  };
}

/** The manual trial of an OTA created before M5 (flows/subscription-billing.md §G): 90 days from its creation. */
function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_01JA2Z7R5N0S3V7X1Z4B9D2F6H",
    planCode: "early_access",
    planName: "Early access",
    status: "trialing",
    billingProvider: "manual",
    billingInterval: "month",
    trialEndsAt: daysFromStart(84),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    banner: null,
    canManageInStripe: false,
    ...overrides,
  };
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(code: string, status: number): Response {
  return json(
    { error: { code, message: "The API's own text, never shown", status, requestId: "req_api_pfe013" } },
    status,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/**
 * Answers each call by `METHOD /path`: by default an active owner's OTA with its sub-domain, the M5 switches off, the
 * Velexis test connections and the manual trial. A new answer table is a new request, with nothing cached from the
 * one before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${ME_PATH}`]: () => json(account(), 200),
    [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain()] }, 200),
    [`GET ${AMADEUS_PATH}`]: () => json({ data: [amadeusConnection()] }, 200),
    [`GET ${PAYMENTS_PATH}`]: () => json({ data: [paymentConnection()] }, 200),
    [`GET ${SUBSCRIPTION_PATH}`]: () => json(subscription(), 200),
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

/** `routes()` for an OTA in which the caller has `role`. */
function routesAs(role: TenantRole, overrides: Record<string, Route> = {}): void {
  routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ myRole: role }), 200), ...overrides });
}

/** The calls of `METHOD /path` so far. */
function calls(method: string, path: string): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.method === method && new URL(input.url).pathname === path);
}

/** The paths of every call so far, in order. */
function calledPaths(): string[] {
  return fetchMock.mock.calls.map(([input]) => `${input.method} ${new URL(input.url).pathname}`);
}

/** Every call carries the session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The route params of `/otas/[tenantId]/…`, as Next.js 15 passes them. */
function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

// ---- Rendering --------------------------------------------------------------------------------------------------

type ResourcePage = (props: { params: Promise<{ tenantId: string }> }) => Promise<ReactElement | null>;

const PAGES = {
  domains: DomainsPage,
  amadeus: AmadeusPage,
  payments: PaymentsPage,
  billing: BillingPage,
} as const satisfies Record<string, ResourcePage>;

type PageName = keyof typeof PAGES;

/** One page as the OTA layout and the page render it for one request. */
async function openPage(name: PageName): Promise<void> {
  const page: ResourcePage = PAGES[name];
  render(await OtaLayout({ children: await page({ params: params() }), params: params() }));
}

/** The element of one page, as Next.js renders it below the layout. */
async function pageElement(name: PageName): Promise<ReactElement> {
  const page: ResourcePage = PAGES[name];
  const element = await page({ params: params() });
  if (element === null) {
    throw new Error(`The ${name} page rendered nothing.`);
  }
  return element;
}

/** The card of one environment's connection. */
function card(environment: "test" | "live"): HTMLElement {
  return screen.getByRole("region", { name: CONNECTION_STRINGS.title(environment) });
}

/** The text of one detail (`data-detail`) inside `container`, or `undefined` without it. */
function detail(container: HTMLElement, id: string): string | undefined {
  return container.querySelector(`[data-detail="${id}"] dd`)?.textContent ?? undefined;
}

/** The ids of the details inside `container`, in order. */
function detailIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-detail]")].map(
    (element) => element.dataset["detail"] ?? "",
  );
}

/** The page shows the not-allowed page for `role`, with the way back, and nothing of the resource. */
function expectNotAllowed(role: TenantRole): void {
  expect(document.querySelector('[data-page="not-allowed"]')).not.toBeNull();
  expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
    NOT_ALLOWED_STRINGS.title,
  ]);
  expect(screen.getByText(NOT_ALLOWED_STRINGS.intro(ROLE_LABELS[role]))).toBeTruthy();
  expect(screen.getByRole("link", { name: NOT_ALLOWED_STRINGS.backToOverview }).getAttribute("href")).toBe(
    `/otas/${TENANT_ID}`,
  );
  expect(document.querySelector("[data-connection]")).toBeNull();
  expect(screen.queryByText("Early access")).toBeNull();
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

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = `/otas/${TENANT_ID}`;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe013_portal",
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
 * The budget of the file's warm-up hook. The first render of each page in a fresh worker (the page modules, the API
 * client, Testing Library and React's DOM on their first run) is the slowest, and on a busy CI runner it otherwise
 * lands in the first test's own five seconds. The hook only stops if it hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: every page opened once and one page rendered on the server and hydrated, so the
 * test bodies hold only the steps they check. Nothing of it stays: each test gets a fresh API (`resetPlatformApi`),
 * fresh mocks and globals (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  for (const name of Object.keys(PAGES) as PageName[]) {
    routes({ [`GET ${ME_PATH}`]: () => json(account({ customDomains: true }), 200) });
    await openPage(name);
    cleanup();
  }
  routes();
  const { root } = await serverRenderAndHydrate(await pageElement("amadeus"));
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- /domains ------------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]/domains", () => {
  it("[PFE-013 AC1] shows the sub-domain as primary and verified, with a link to the storefront [PF-40 AC1]", async () => {
    await openPage("domains");

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      DOMAINS_STRINGS.title,
    ]);
    const section = screen.getByRole("region", { name: DOMAINS_STRINGS.subdomainTitle });
    const item = within(section).getByRole("listitem");
    expect(item.dataset["domain"]).toBe("acme.ota.example.com");
    // A link to the storefront at its address.
    expect(within(item).getByRole("link", { name: "acme.ota.example.com" }).getAttribute("href")).toBe(
      "https://acme.ota.example.com/",
    );
    // Primary and verified, both in words.
    expect(item.querySelector("[data-primary]")?.textContent).toBe(DOMAINS_STRINGS.primary);
    const status = item.querySelector("[data-status]");
    expect(status?.getAttribute("data-status")).toBe("verified");
    expect(status?.textContent).toBe("Verified");
    // The date it was added, in the OTA's time zone; the sub-domain has no DNS records or TLS state to show.
    expect(item.querySelector("time")?.getAttribute("dateTime")).toBe(subdomain().createdAt);
    expect(item.querySelector("time")?.textContent).toBe(
      formatDateTime(subdomain().createdAt, { mode: "date", timeZone: TIME_ZONE }),
    );
    expect(item.querySelector("[data-dns-records]")).toBeNull();

    // One getTenant (shared by the layout and the page), one listDomains and one getMe, with the session; no write.
    expect(calledPaths().sort()).toEqual(
      [`GET ${TENANT_PATH}`, `GET ${DOMAINS_PATH}`, `GET ${ME_PATH}`].sort(),
    );
    expectSessionHeaders(calls("GET", DOMAINS_PATH)[0]);
    expectSessionHeaders(calls("GET", ME_PATH)[0]);
  });

  it("[PFE-013 AC1] shows the sub-domain to every role, since every member may read the domains [PF-40 AC1]", async () => {
    for (const role of ["owner", "admin", "agent", "finance", "viewer"] as const) {
      routesAs(role);
      await openPage("domains");
      const section = screen.getByRole("region", { name: DOMAINS_STRINGS.subdomainTitle });
      expect(within(section).getByRole("link", { name: "acme.ota.example.com" })).toBeTruthy();
      expect(document.querySelector('[data-page="not-allowed"]')).toBeNull();
      cleanup();
    }
    // And the navigation offers the domains to every role.
    for (const role of ["owner", "admin", "agent", "finance", "viewer"] as const) {
      render(<SideNav memberships={[membership(role)]} features={FEATURES_OFF} />);
      expect(screen.getByRole("link", { name: "Domains" }).getAttribute("href")).toBe(
        `/otas/${TENANT_ID}/domains`,
      );
      cleanup();
    }
  });

  it("[PFE-013 AC1] has no custom-domain section while features.customDomains is off, even when the API lists one", async () => {
    routes({ [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain(), customDomain()] }, 200) });
    await openPage("domains");

    expect(screen.queryByRole("region", { name: DOMAINS_STRINGS.customTitle })).toBeNull();
    expect(document.querySelector('[data-section="custom"]')).toBeNull();
    expect(document.body.textContent).not.toContain("travel.acme.com");
    expect(screen.getByRole("link", { name: "acme.ota.example.com" })).toBeTruthy();
  });

  it("shows the custom domains with their DNS records and last check while features.customDomains is on", async () => {
    const pending = customDomain();
    const failedCheck = customDomain({
      id: "dom_01JA2ZD5F9H3K7N1R5T9W3Y7A1",
      hostname: "fly.acme.com",
      lastCheckError: "a_new_code_of_a_newer_api",
      dnsRecords: [
        { type: "TXT", name: "_velexis.fly.acme.com", value: "velexis-verify=pfe013otherdummy" },
        { type: "CNAME", name: "fly.acme.com", value: "acme.ota.example.com" },
      ],
    });
    const verified = customDomain({
      id: "dom_01JA2ZE6G0J4M8P2S6V0X4Z8B2",
      hostname: "acme.com",
      verificationStatus: "verified",
      lastCheckError: null,
      verificationDeadlineAt: null,
    });
    routes({
      [`GET ${ME_PATH}`]: () => json(account({ customDomains: true }), 200),
      [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain(), pending, failedCheck, verified] }, 200),
    });
    await openPage("domains");

    // The sub-domain keeps its own section; the custom domains are listed in the API's order.
    const subdomains = screen.getByRole("region", { name: DOMAINS_STRINGS.subdomainTitle });
    expect(within(subdomains).getAllByRole("listitem")).toHaveLength(1);
    const section = screen.getByRole("region", { name: DOMAINS_STRINGS.customTitle });
    const items = within(section)
      .getAllByRole("listitem")
      .filter((item) => item.dataset["domain"] !== undefined);
    expect(items.map((item) => item.dataset["domain"])).toEqual([
      "travel.acme.com",
      "fly.acme.com",
      "acme.com",
    ]);

    // A pending domain: the records to create, the last check in words (never its code) and the deadline.
    const [first, second, third] = items;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Three custom domains expected.");
    }
    expect(first.querySelector("[data-status]")?.getAttribute("data-status")).toBe("pending");
    expect(first.querySelector("[data-primary]")).toBeNull();
    const table = within(first).getByRole("table", {
      name: DOMAINS_STRINGS.recordsCaption("travel.acme.com"),
    });
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ["TXT", "_velexis.travel.acme.com", "velexis-verify=pfe013dummytoken"],
      ["CNAME", "travel.acme.com", "acme.ota.example.com"],
    ]);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([DOMAINS_STRINGS.recordType, DOMAINS_STRINGS.recordName, DOMAINS_STRINGS.recordValue]);
    expect(detail(first, "lastCheck")).toBe(
      `${formatDateTime(pending.lastCheckedAt ?? "", { timeZone: TIME_ZONE })}: ${DNS_CHECK_ERRORS["txt_missing"]}`,
    );
    expect(detail(first, "verificationDeadlineAt")).toBe(
      formatDateTime(pending.verificationDeadlineAt ?? "", { timeZone: TIME_ZONE }),
    );
    // A code the portal does not know yet reads as the general message.
    expect(detail(second, "lastCheck")).toContain(DOMAINS_STRINGS.checkFailed);
    expect(document.body.textContent).not.toContain("txt_missing");
    expect(document.body.textContent).not.toContain("a_new_code_of_a_newer_api");
    // A verified domain lists its records, without a check to wait for.
    expect(third.querySelector("[data-status]")?.getAttribute("data-status")).toBe("verified");
    expect(within(third).getByRole("table")).toBeTruthy();
    expect(detailIds(third)).toEqual([]);
    // A domain links to the storefront once it is verified; a pending one does not lead there yet.
    expect(within(third).getByRole("link", { name: "acme.com" }).getAttribute("href")).toBe(
      "https://acme.com/",
    );
    expect(within(first).queryByRole("link")).toBeNull();
    expect(within(second).queryByRole("link")).toBeNull();
  });

  it("shows an empty custom-domain section, and the words of every last check the API sends", async () => {
    routes({ [`GET ${ME_PATH}`]: () => json(account({ customDomains: true }), 200) });
    await openPage("domains");
    const section = screen.getByRole("region", { name: DOMAINS_STRINGS.customTitle });
    expect(within(section).getByText(DOMAINS_STRINGS.customEmpty)).toBeTruthy();

    // flows/custom-domains.md step 3 names six results; each has its own words, and nothing else is shown raw.
    for (const code of [
      "txt_missing",
      "txt_mismatch",
      "cname_missing",
      "cname_wrong_target",
      "a_wrong_address",
      "dns_timeout",
    ]) {
      expect(dnsCheckMessage(code)).toBe(DNS_CHECK_ERRORS[code]);
      expect(dnsCheckMessage(code)).not.toContain(code);
    }
    expect(Object.keys(DNS_CHECK_ERRORS)).toHaveLength(6);
    expect(dnsCheckMessage("toString")).toBe(DOMAINS_STRINGS.checkFailed);
    expect(dnsCheckMessage("")).toBe(DOMAINS_STRINGS.checkFailed);
  });

  it("keeps the sub-domain and hides the custom domains when getMe fails, and renders a strange host name as text", async () => {
    routes({
      [`GET ${ME_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503),
      [`GET ${DOMAINS_PATH}`]: () =>
        json({ data: [subdomain({ hostname: "javascript:alert(1)//acme" }), customDomain()] }, 200),
    });
    await openPage("domains");

    const section = screen.getByRole("region", { name: DOMAINS_STRINGS.subdomainTitle });
    expect(within(section).getByText("javascript:alert(1)//acme")).toBeTruthy();
    expect(within(section).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("region", { name: DOMAINS_STRINGS.customTitle })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the portal's message when the domains cannot be loaded", async () => {
    routes({ [`GET ${DOMAINS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openPage("domains");

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(DOMAINS_STRINGS.title);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(DOMAINS_STRINGS.unavailableTitle)).toBeTruthy();
    expect(within(alert).getByText(ERROR_MESSAGES.SERVICE_UNAVAILABLE)).toBeTruthy();
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(screen.queryByRole("region", { name: DOMAINS_STRINGS.subdomainTitle })).toBeNull();
  });

  it("sends an ended session to sign-in and back to the domains page, an unverified account to /verify-pending, a lost membership to the not-found page", async () => {
    const back = `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fdomains`;
    routes({ [`GET ${DOMAINS_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(DomainsPage({ params: params() })).rejects.toThrow(back);
    routes({ [`GET ${ME_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(DomainsPage({ params: params() })).rejects.toThrow(back);
    routes({ [`GET ${DOMAINS_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(DomainsPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT /verify-pending");
    routes({ [`GET ${DOMAINS_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await expect(DomainsPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");

    // An id that is no OTA id never reaches the API.
    fetchMock.mockClear();
    await expect(DomainsPage({ params: params("not-an-ota") })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- /amadeus ------------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]/amadeus", () => {
  it("[PFE-013 AC2] shows the assigned test office of the Velexis test account [PF-50 AC1]", async () => {
    await openPage("amadeus");

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      AMADEUS_STRINGS.title,
    ]);
    const test = card("test");
    expect(test.querySelector("[data-summary]")?.textContent).toBe(
      "Velexis test account, office NCE1A0955, active",
    );
    expect(test.querySelector("[data-status]")?.textContent).toBe("Active");
    expect(test.querySelector("[data-notice]")).toBeNull();
    expect(detailIds(test)).toEqual([
      "account",
      "offices",
      "defaultOffice",
      "queuingOffice",
      "ownerOffice",
      "lastVerifiedAt",
    ]);
    expect(detail(test, "account")).toBe("Velexis test account");
    expect(detail(test, "offices")).toBe("NCE1A0955");
    expect(detail(test, "defaultOffice")).toBe("NCE1A0955");
    expect(detail(test, "lastVerifiedAt")).toBe(
      formatDateTime(amadeusConnection().lastVerifiedAt ?? "", { timeZone: TIME_ZONE }),
    );
    expect(screen.queryByRole("region", { name: CONNECTION_STRINGS.title("live") })).toBeNull();

    // One listAmadeusConnections with the session, next to the layout's one getTenant; nothing is written.
    expect(calledPaths()).toEqual([`GET ${TENANT_PATH}`, `GET ${AMADEUS_PATH}`]);
    expectSessionHeaders(calls("GET", AMADEUS_PATH)[0]);
  });

  it("[PFE-013 AC2] explains that Velexis assigns an office soon when the pool was empty at set-up [PF-50 AC2]", async () => {
    routes({ [`GET ${AMADEUS_PATH}`]: () => json({ data: [pendingAmadeusConnection()] }, 200) });
    await openPage("amadeus");

    const test = card("test");
    expect(test.querySelector("[data-summary]")?.textContent).toBe(
      "Velexis test account, no office yet, pending",
    );
    expect(test.querySelector("[data-status]")?.getAttribute("data-status")).toBe("pending_verification");
    expect(test.querySelector('[data-notice="pending-office"]')?.textContent).toBe(
      CONNECTION_STRINGS.pendingOffice,
    );
    expect(within(test).getByText(/Velexis assigns an Amadeus office to your OTA soon/)).toBeTruthy();
    expect(detail(test, "offices")).toBe(CONNECTION_STRINGS.officesNone);
    expect(detail(test, "defaultOffice")).toBe(CONNECTION_STRINGS.officeNotSet);
    expect(detailIds(test)).not.toContain("lastVerifiedAt");
  });

  it("lists test before live and shows own credentials, a refused connection and a submission without a secret", async () => {
    const live = amadeusConnection({
      id: "sc_01JA2ZF7H1K5N9Q3T7W1Y5A9C3",
      environment: "live",
      credentialSource: "tenant",
      status: "invalid_credentials",
      officeIds: ["OSLN12345", "OSLN12346"],
      defaultOfficeId: "OSLN12345",
      queuingOfficeId: null,
      ownerOfficeId: "OSLN12346",
      clientId: "pfe013-dummy-client-id",
      lastError: NEVER_SHOWN,
      pendingSubmission: { id: "crs_01JA2ZG8J2M6P0S4V8Y2A6C0E4", status: "failed", errorCode: NEVER_SHOWN },
    });
    // A field the document does not have (a secret's stand-in) is never rendered.
    routes({
      [`GET ${AMADEUS_PATH}`]: () =>
        json({ data: [{ ...live, clientSecretCiphertext: NEVER_SHOWN }, amadeusConnection()] }, 200),
    });
    await openPage("amadeus");

    const cards = [...document.querySelectorAll<HTMLElement>("[data-connection]")];
    expect(cards.map((element) => element.dataset["environment"])).toEqual(["test", "live"]);
    const liveCard = card("live");
    expect(liveCard.querySelector("[data-summary]")?.textContent).toBe(
      "Your own Amadeus credentials, offices OSLN12345, OSLN12346, invalid credentials",
    );
    expect(liveCard.querySelector('[data-notice="invalid-credentials"]')?.textContent).toBe(
      CONNECTION_STRINGS.amadeusInvalid,
    );
    expect(detail(liveCard, "clientId")).toBe("pfe013-dummy-client-id");
    expect(detail(liveCard, "queuingOffice")).toBe(CONNECTION_STRINGS.officeNotSet);
    const submission = liveCard.querySelector('[data-submission="failed"]');
    expect(submission?.textContent).toContain(CONNECTION_STRINGS.submissionFailed);
    expect(document.body.textContent).not.toContain(NEVER_SHOWN);
  });

  it("explains the other states of a connection, and a status the portal does not know yet", () => {
    expect(
      amadeusSummary(amadeusConnection({ status: "disabled", officeIds: ["NCE1A0955", "NCE1A0956"] })),
    ).toBe("Velexis test account, offices NCE1A0955, NCE1A0956, disabled");
    const unknown = { ...amadeusConnection(), status: "paused_by_amadeus" } as unknown as AmadeusConnection;
    expect(amadeusSummary(unknown)).toBe("Velexis test account, office NCE1A0955, paused by amadeus");
    expect(byEnvironment([{ environment: "live" }, { environment: "test" }] as const)).toEqual([
      { environment: "test" },
      { environment: "live" },
    ]);
    // An environment of a newer API goes last, even one named like an object's own property.
    const newer = [
      { environment: "constructor" },
      { environment: "live" },
      { environment: "staging" },
      { environment: "test" },
    ] as unknown as { environment: "test" | "live" }[];
    expect(byEnvironment(newer).map((connection) => connection.environment)).toEqual([
      "test",
      "live",
      "constructor",
      "staging",
    ]);
    // Such a card reads its environment in raw words: never "undefined", and never called live.
    expect(CONNECTION_STRINGS.title("test")).toBe("Test environment");
    expect(CONNECTION_STRINGS.title("live")).toBe("Live environment");
    for (const environment of ["staging", "constructor"]) {
      const amadeus = { ...amadeusConnection(), environment } as unknown as AmadeusConnection;
      const payment = { ...paymentConnection(), environment } as unknown as PaymentConnection;
      expect(CONNECTION_STRINGS.title(amadeus.environment)).toBe(
        `${environment.charAt(0).toUpperCase()}${environment.slice(1)} environment`,
      );
      expect(amadeusSummary(amadeus)).toBe(`Velexis ${environment} account, office NCE1A0955, active`);
      expect(paymentSummary(payment)).toBe(`Velexis Stripe account, ${environment}, active`);
    }
  });

  it("[PFE-013 AC2] shows the connections to owners, admins and finance members", async () => {
    for (const role of ["owner", "admin", "finance"] as const) {
      routesAs(role);
      await openPage("amadeus");
      expect(card("test").querySelector("[data-summary]")?.textContent).toBe(
        "Velexis test account, office NCE1A0955, active",
      );
      cleanup();
    }
  });

  it("shows the portal's message when the connections cannot be loaded, and an empty list", async () => {
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["RATE_LIMITED", 429],
      ["SERVICE_UNAVAILABLE", 503],
    ] as const) {
      routes({ [`GET ${AMADEUS_PATH}`]: () => apiError(code, status) });
      await openPage("amadeus");
      const alert = screen.getByRole("alert");
      expect(within(alert).getByText(AMADEUS_STRINGS.unavailableTitle)).toBeTruthy();
      expect(within(alert).getByText(ERROR_MESSAGES[code])).toBeTruthy();
      expect(document.body.textContent).not.toContain("The API's own text");
      cleanup();
    }
    routes({ [`GET ${AMADEUS_PATH}`]: () => json({ data: [] }, 200) });
    await openPage("amadeus");
    expect(screen.getByText(AMADEUS_STRINGS.empty)).toBeTruthy();
  });

  it("sends an ended session to sign-in and back to the Amadeus page, and a lost membership to the not-found page", async () => {
    routes({ [`GET ${AMADEUS_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(AmadeusPage({ params: params() })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Famadeus`,
    );
    routes({ [`GET ${AMADEUS_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(AmadeusPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT /verify-pending");
    routes({ [`GET ${AMADEUS_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await expect(AmadeusPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

// ---- /payments -----------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]/payments", () => {
  it("[PFE-013 AC2] shows the Velexis test connection [PF-60 AC1]", async () => {
    await openPage("payments");

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      PAYMENTS_STRINGS.title,
    ]);
    const test = card("test");
    expect(test.querySelector("[data-summary]")?.textContent).toBe("Velexis Stripe account, test, active");
    expect(test.querySelector("[data-status]")?.textContent).toBe("Active");
    expect(test.querySelector("[data-notice]")).toBeNull();
    expect(within(test).getByText(CONNECTION_STRINGS.velexisMode)).toBeTruthy();
    expect(within(test).getByText(CONNECTION_STRINGS.testPayments)).toBeTruthy();
    // Velexis mode has no account, key, capabilities or webhook of the OTA's own to show.
    expect(detailIds(test)).toEqual(["account", "statementDescriptorSuffix"]);
    expect(detail(test, "account")).toBe(CONNECTION_STRINGS.paymentAccount.velexis);
    expect(detail(test, "statementDescriptorSuffix")).toBe("ACME TRAVEL");

    expect(calledPaths()).toEqual([`GET ${TENANT_PATH}`, `GET ${PAYMENTS_PATH}`]);
    expectSessionHeaders(calls("GET", PAYMENTS_PATH)[0]);
  });

  it("shows an own Stripe account with its id, capabilities and dates, and why a pending one cannot take payments", async () => {
    const live = paymentConnection({
      id: "ppc_01JA2ZH9K3N7Q1T5W9Z3B7D1F5",
      environment: "live",
      accountMode: "connect_standard",
      status: "pending",
      accountReference: "acct_pfe013dummy",
      statementDescriptorSuffix: null,
      capabilities: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true },
      connectedAt: daysFromStart(-2),
      disconnectedAt: null,
    });
    const keys = paymentConnection({
      accountMode: "api_keys",
      status: "error",
      accountReference: "acct_pfe013keys",
      publishableKey: "pk_test_pfe013dummypublishable",
      webhookUrl: "https://api.ota.example.com/webhooks/stripe/c/ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6X",
      capabilities: {},
      connectedAt: daysFromStart(-3),
      disconnectedAt: daysFromStart(-1),
      pendingSubmission: { id: "crs_01JA2ZJ0M4P8S2V6Y0B4D8G2J6", status: "verifying", errorCode: null },
    });
    routes({
      [`GET ${PAYMENTS_PATH}`]: () =>
        json({ data: [{ ...live, webhookSecretCiphertext: NEVER_SHOWN }, keys] }, 200),
    });
    await openPage("payments");

    const cards = [...document.querySelectorAll<HTMLElement>("[data-connection]")];
    expect(cards.map((element) => element.dataset["environment"])).toEqual(["test", "live"]);
    const liveCard = card("live");
    expect(liveCard.querySelector("[data-summary]")?.textContent).toBe(
      "Your Stripe account (Stripe Connect), live, pending",
    );
    expect(liveCard.querySelector('[data-notice="pending"]')?.textContent).toBe(
      CONNECTION_STRINGS.paymentPending,
    );
    expect(detail(liveCard, "accountReference")).toBe("acct_pfe013dummy");
    expect(detail(liveCard, "statementDescriptorSuffix")).toBe(CONNECTION_STRINGS.descriptorNotSet);
    expect(detail(liveCard, "chargesEnabled")).toBe(CONNECTION_STRINGS.no);
    expect(detail(liveCard, "detailsSubmitted")).toBe(CONNECTION_STRINGS.yes);
    expect(detail(liveCard, "connectedAt")).toBe(
      formatDateTime(live.connectedAt ?? "", { timeZone: TIME_ZONE }),
    );
    expect(within(liveCard).queryByText(CONNECTION_STRINGS.velexisMode)).toBeNull();
    expect(within(liveCard).queryByText(CONNECTION_STRINGS.testPayments)).toBeNull();

    const testCard = card("test");
    expect(testCard.querySelector("[data-summary]")?.textContent).toBe(
      "Your Stripe account (your API keys), test, error",
    );
    expect(testCard.querySelector('[data-notice="error"]')?.textContent).toBe(
      CONNECTION_STRINGS.paymentError,
    );
    expect(detail(testCard, "publishableKey")).toBe("pk_test_pfe013dummypublishable");
    expect(detail(testCard, "webhookUrl")).toBe(keys.webhookUrl);
    expect(within(testCard).queryByRole("link")).toBeNull();
    expect(detail(testCard, "disconnectedAt")).toBe(
      formatDateTime(keys.disconnectedAt ?? "", { timeZone: TIME_ZONE }),
    );
    expect(testCard.querySelector('[data-submission="verifying"]')?.textContent).toContain(
      CONNECTION_STRINGS.submissionOpen,
    );
    expect(document.body.textContent).not.toContain(NEVER_SHOWN);
    expect(paymentSummary(paymentConnection({ status: "disabled" }))).toBe(
      "Velexis Stripe account, test, disabled",
    );
  });

  it("[PFE-013 AC2] shows the connections to owners, admins and finance members", async () => {
    for (const role of ["owner", "admin", "finance"] as const) {
      routesAs(role);
      await openPage("payments");
      expect(card("test").querySelector("[data-summary]")?.textContent).toBe(
        "Velexis Stripe account, test, active",
      );
      cleanup();
    }
  });

  it("shows the portal's message when the connections cannot be loaded, an empty list, and the session's end", async () => {
    routes({ [`GET ${PAYMENTS_PATH}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openPage("payments");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(PAYMENTS_STRINGS.unavailableTitle)).toBeTruthy();
    expect(within(alert).getByText(ERROR_MESSAGES.INTERNAL_ERROR)).toBeTruthy();
    expect(document.body.textContent).not.toContain("The API's own text");
    cleanup();

    routes({ [`GET ${PAYMENTS_PATH}`]: () => json({ data: [] }, 200) });
    await openPage("payments");
    expect(screen.getByText(PAYMENTS_STRINGS.empty)).toBeTruthy();

    routes({ [`GET ${PAYMENTS_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(PaymentsPage({ params: params() })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments`,
    );
    routes({ [`GET ${PAYMENTS_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(PaymentsPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT /verify-pending");
    routes({ [`GET ${PAYMENTS_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await expect(PaymentsPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

// ---- /billing ------------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]/billing", () => {
  it("[PFE-013 AC3] shows the plan, the status and the trial end of the manual trial, and that paid plans arrive soon [PF-75 AC1]", async () => {
    await openPage("billing");

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      BILLING_STRINGS.title,
    ]);
    const details = screen.getByRole("region", { name: BILLING_STRINGS.subscriptionTitle });
    expect(detailIds(details)).toEqual(["plan", "status", "billingProvider", "trialEndsAt"]);
    expect(detail(details, "plan")).toBe("Early access");
    expect(details.querySelector('[data-detail="status"] [data-status]')?.getAttribute("data-status")).toBe(
      "trialing",
    );
    expect(detail(details, "status")).toBe("Trial");
    expect(detail(details, "billingProvider")).toBe(BILLING_STRINGS.provider.manual);
    // The trial end as a date in the OTA's time zone, with the API's instant in <time>.
    const trialEnd = details.querySelector('[data-detail="trialEndsAt"] time');
    expect(trialEnd?.getAttribute("dateTime")).toBe(subscription().trialEndsAt);
    expect(trialEnd?.textContent).toBe(
      formatDateTime(subscription().trialEndsAt ?? "", { mode: "date", timeZone: TIME_ZONE }),
    );
    const manual = screen.getByRole("region", { name: BILLING_STRINGS.manualTrialTitle });
    expect(manual.textContent).toContain("Paid plans arrive soon");
    expect(within(manual).getByText(BILLING_STRINGS.manualTrial)).toBeTruthy();
    // No banner, no cancellation and no action yet (PFE-021).
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector("[data-notice='cancel-at-period-end']")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();

    expect(calledPaths()).toEqual([`GET ${TENANT_PATH}`, `GET ${SUBSCRIPTION_PATH}`]);
    expectSessionHeaders(calls("GET", SUBSCRIPTION_PATH)[0]);
  });

  it("[PFE-013 AC3] shows finance members the same trial end [PF-75 AC1]", async () => {
    routesAs("finance");
    await openPage("billing");
    const details = screen.getByRole("region", { name: BILLING_STRINGS.subscriptionTitle });
    expect(details.querySelector('[data-detail="trialEndsAt"] time')?.getAttribute("dateTime")).toBe(
      subscription().trialEndsAt,
    );
    expect(screen.getByRole("region", { name: BILLING_STRINGS.manualTrialTitle })).toBeTruthy();
  });

  it("shows a Stripe subscription's interval, period end, cancellation and banner, without the manual-trial note", async () => {
    const stripe = subscription({
      planCode: "growth",
      planName: "Growth",
      status: "past_due",
      billingProvider: "stripe",
      billingInterval: "year",
      trialEndsAt: null,
      currentPeriodEnd: daysFromStart(200),
      cancelAtPeriodEnd: true,
      banner: "past_due",
      canManageInStripe: true,
    });
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripe, 200) });
    await openPage("billing");

    const details = screen.getByRole("region", { name: BILLING_STRINGS.subscriptionTitle });
    expect(detailIds(details)).toEqual([
      "plan",
      "status",
      "billingProvider",
      "billingInterval",
      "currentPeriodEnd",
    ]);
    expect(detail(details, "plan")).toBe("Growth");
    expect(detail(details, "status")).toBe("Past due");
    expect(detail(details, "billingProvider")).toBe(BILLING_STRINGS.provider.stripe);
    expect(detail(details, "billingInterval")).toBe(BILLING_STRINGS.intervals.year);
    expect(detail(details, "currentPeriodEnd")).toBe(
      formatDateTime(stripe.currentPeriodEnd ?? "", { mode: "date", timeZone: TIME_ZONE }),
    );
    expect(within(details).getByText(BILLING_STRINGS.cancelAtPeriodEnd)).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.dataset["notice"]).toBe("past_due");
    expect(within(alert).getByText(BILLING_STRINGS.banners.past_due.title)).toBeTruthy();
    expect(screen.queryByRole("region", { name: BILLING_STRINGS.manualTrialTitle })).toBeNull();
    cleanup();

    // The other banners are status messages.
    for (const banner of ["trial_ending", "canceled"] as const) {
      routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => json(subscription({ banner }), 200) });
      await openPage("billing");
      const notice = document.querySelector<HTMLElement>(`[data-notice="${banner}"]`);
      expect(notice?.getAttribute("role")).toBe("status");
      expect(notice?.textContent).toContain(BILLING_STRINGS.banners[banner].text);
      cleanup();
    }
  });

  it("leaves out a banner the portal has no words for yet, and still shows the subscription", async () => {
    const newer = { ...subscription(), banner: "pfe013_newer_banner" } as unknown as Subscription;
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => json(newer, 200) });
    await openPage("billing");

    expect(document.querySelector("[data-notice='pfe013_newer_banner']")).toBeNull();
    expect(document.body.textContent).not.toContain("pfe013_newer_banner");
    expect(screen.queryByRole("alert")).toBeNull();
    const details = screen.getByRole("region", { name: BILLING_STRINGS.subscriptionTitle });
    expect(detail(details, "plan")).toBe("Early access");
    expect(screen.getByRole("region", { name: BILLING_STRINGS.manualTrialTitle })).toBeTruthy();
  });

  it("says when the OTA has no subscription, shows the portal's message for other failures, and follows the session's end", async () => {
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await openPage("billing");
    expect(document.querySelector('[data-notice="no-subscription"]')?.textContent).toBe(BILLING_STRINGS.none);
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();

    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openPage("billing");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(BILLING_STRINGS.unavailableTitle)).toBeTruthy();
    expect(within(alert).getByText(ERROR_MESSAGES.SERVICE_UNAVAILABLE)).toBeTruthy();
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(screen.queryByRole("region", { name: BILLING_STRINGS.subscriptionTitle })).toBeNull();

    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(BillingPage({ params: params() })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fbilling`,
    );
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(BillingPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT /verify-pending");
  });
});

// ---- Who may open what ---------------------------------------------------------------------------------------------

describe("the roles of the Amadeus, payments and billing pages", () => {
  it("[PFE-013 AC3] gives a viewer the not-allowed page on /amadeus, /payments and /billing, without a call [PF-75]", async () => {
    for (const name of ["amadeus", "payments", "billing"] as const) {
      routesAs("viewer");
      await openPage(name);
      expectNotAllowed("viewer");
      // Only the layout's getTenant: the page makes no call for a role that may not see it.
      expect(calledPaths()).toEqual([`GET ${TENANT_PATH}`]);
      fetchMock.mockClear();
      cleanup();
    }
    // The navigation never links a viewer to them.
    render(<SideNav memberships={[membership("viewer")]} features={FEATURES_OFF} />);
    for (const label of ["Amadeus", "Payments", "Billing"]) {
      expect(screen.queryByRole("link", { name: label })).toBeNull();
    }
  });

  it("[PFE-013 AC3] gives an agent the not-allowed page on all three, and an admin on /billing only", async () => {
    for (const name of ["amadeus", "payments", "billing"] as const) {
      routesAs("agent");
      await openPage(name);
      expectNotAllowed("agent");
      expect(calledPaths()).toEqual([`GET ${TENANT_PATH}`]);
      fetchMock.mockClear();
      cleanup();
    }
    routesAs("admin");
    await openPage("billing");
    expectNotAllowed("admin");
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(0);
    cleanup();

    // Finance members see all three (scope §1.2), and the navigation agrees.
    for (const name of ["amadeus", "payments", "billing"] as const) {
      routesAs("finance");
      await openPage(name);
      expect(document.querySelector('[data-page="not-allowed"]')).toBeNull();
      cleanup();
    }
    render(<SideNav memberships={[membership("finance")]} features={FEATURES_OFF} />);
    for (const label of ["Amadeus", "Payments", "Billing"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
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

  it.each<[PageName, ReactNode]>([
    ["domains", DOMAINS_STRINGS.customTitle],
    ["amadeus", AMADEUS_STRINGS.title],
    ["payments", PAYMENTS_STRINGS.title],
    ["billing", BILLING_STRINGS.manualTrialTitle],
  ])("renders the %s page and hydrates it without an error or a change", async (name, text) => {
    routes({
      [`GET ${ME_PATH}`]: () => json(account({ customDomains: true }), 200),
      [`GET ${DOMAINS_PATH}`]: () => json({ data: [subdomain(), customDomain()] }, 200),
    });
    rendered = await serverRenderAndHydrate(await pageElement(name));

    expect(rendered.errors).toEqual([]);
    // The hydrated page is the server's page: same markup, nothing replaced in the browser.
    expect(rendered.container.innerHTML).toBe(rendered.serverDom);
    expect(rendered.container.textContent).toContain(text);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
  });
});
