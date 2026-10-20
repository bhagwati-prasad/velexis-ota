// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope and navigation of Next.js and the configuration; the real API client talks to a ------
// ---- mocked fetch, so the tests see the query each page sends -------------------------------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/",
  searchParams: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() },
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
  redirect: navigation.redirect,
  notFound: navigation.notFound,
}));

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import DashboardPage from "@/app/(app)/page";
import TenantDetailPage from "@/app/(app)/tenants/[tenantId]/page";
import { TenantTabs } from "@/app/(app)/tenants/[tenantId]/tabs";
import TenantsPage from "@/app/(app)/tenants/page";
import { TenantTable } from "@/app/(app)/tenants/tenant-table";
import { FilterBar } from "@/components/filter-bar";
import * as tableComponents from "@/components/ui/table";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  DASHBOARD_STRINGS,
  ERROR_MESSAGES,
  TENANT_DETAIL_STRINGS,
  TENANT_LIST_STRINGS,
  TENANT_TAB_LABELS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) ---------------------------------------------------

type Schemas = components["schemas"];

const ACCESS_TOKEN = "pad004-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-004 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const OTHER_TENANT_ID = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const OWNER_EMAIL = "anna.berg@example.com";
const TENANT_PATH = `/v1/admin/tenants/${TENANT_ID}`;

/**
 * The budget of the warm-up hook: the first render of these pages in a fresh worker loads the module graph of the
 * tables, tabs and filter bar, which can take seconds on a loaded runner. The hook only stops one that hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

function dashboard(overrides: Partial<Schemas["AdminDashboard"]> = {}): Schemas["AdminDashboard"] {
  return {
    tenantsByStatus: { provisioning: 1, active: 14, suspended: 1, failed: 2 },
    provisioningFailed24h: 1,
    jobsFailedByQueue: {
      "platform-tenant-events": 0,
      "platform-emails": 2,
      "platform-stripe-events": 0,
      "platform-domains": 0,
      "platform-connections": 0,
      "platform-settlements": 0,
      "platform-maintenance": 0,
    },
    officePool: [
      { environment: "test", available: 2, assigned: 17 },
      { environment: "live", available: 3, assigned: 9 },
    ],
    domainsPending: null,
    settlementsToReview: null,
    stripeEventsFailed: null,
    subscriptionsPastDue: null,
    ...overrides,
  };
}

function summaries(): Schemas["AdminTenantSummary"][] {
  return [
    {
      id: OTHER_TENANT_ID,
      key: "nordic",
      name: "Nordic Fares",
      status: "failed",
      planCode: "early_access",
      ownerEmail: "mikael.lind@nordic-fares.example.com",
      createdAt: "2026-10-16T13:40:02Z",
      activatedAt: null,
    },
    {
      id: TENANT_ID,
      key: "acme",
      name: "Acme Travel",
      status: "active",
      planCode: "growth",
      ownerEmail: OWNER_EMAIL,
      createdAt: "2026-10-14T08:20:11Z",
      activatedAt: "2026-10-14T08:20:16Z",
    },
  ];
}

function plan(code: string, name: string, isActive = true): Schemas["AdminPlan"] {
  return {
    code,
    name,
    description: null,
    currency: "EUR",
    monthlyPrice: { amount: "0.00", currency: "EUR" },
    annualPrice: null,
    trialDays: 90,
    limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: false },
    features: {},
    checkoutAvailable: { month: false, year: false },
    isPublic: true,
    isActive,
    sortOrder: 10,
    settlementFeeBps: 0,
    stripeProductId: null,
    stripePriceIdMonth: null,
    stripePriceIdYear: null,
    priceWarnings: [],
    tenantCount: 1,
    version: 1,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-01T09:00:00Z",
  };
}

const PLANS = [plan("early_access", "Early access"), plan("growth", "Growth"), plan("pilot", "Pilot", false)];

/** Values that look like a client id, a Stripe account and a publishable key; the page must mask all three. */
const CLIENT_ID = "pad004DummyClientIdValue7Q2X";
const ACCOUNT_REFERENCE = "acct_1PAD004DummyAccount9Kz";
const PUBLISHABLE_KEY = "pk_live_PAD004DummyPublishableKeyy4Fq";

function detail(): Schemas["AdminTenantDetail"] {
  return {
    tenant: {
      id: TENANT_ID,
      key: "acme",
      name: "Acme Travel",
      legalName: "Acme Travel AS",
      status: "suspended",
      suspensionReason: "abuse",
      suspendedAt: "2026-10-19T10:00:00Z",
      billingNotice: null,
      planCode: "early_access",
      defaultCurrency: "EUR",
      countryCode: "NO",
      timeZone: "Europe/Oslo",
      supportEmail: "support@acme-travel.example.com",
      storefrontEnvironment: "test",
      liveEnabledAt: null,
      primaryHost: "acme.ota.example.com",
      schemaVersion: "0001_baseline",
      notes: "Pilot customer; contact Anna for anything urgent.",
      createdAt: "2026-10-14T08:20:11Z",
      activatedAt: "2026-10-14T08:20:16Z",
      version: 3,
    },
    members: [
      {
        id: "stf_01JA2ZA1C5E9G3J7K2M6P0R4T8",
        accountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
        fullName: "Anna Berg",
        email: OWNER_EMAIL,
        role: "owner",
        status: "active",
        mfaEnabled: true,
        createdAt: "2026-10-14T08:20:11Z",
        version: 1,
      },
      {
        id: "stf_01JA2ZA1C5E9G3J7K2M6P0R4T9",
        accountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1Y",
        fullName: "Ola Nordmann",
        email: "ola@acme-travel.example.com",
        role: "finance",
        status: "active",
        mfaEnabled: false,
        createdAt: "2026-10-15T08:00:00Z",
        version: 2,
      },
    ],
    invitations: [
      {
        id: "ivt_01JA2ZF4H8K2M6P0R4T8W2Y6A0",
        email: "jo@acme-travel.example.com",
        role: "agent",
        status: "pending",
        invitedBy: { accountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X", fullName: "Anna Berg" },
        expiresAt: "2026-10-21T09:00:00Z",
        createdAt: "2026-10-14T09:00:00Z",
      },
    ],
    subscription: {
      id: "sub_01JA2Z7R5N0S3V7X1Z4B9D2F6H",
      planCode: "early_access",
      planName: "Early access",
      status: "trialing",
      billingProvider: "manual",
      billingInterval: "month",
      trialEndsAt: "2027-01-12T08:20:11Z",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      banner: null,
      canManageInStripe: false,
    },
    amadeusConnections: [
      {
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
        lastVerifiedAt: "2026-10-14T08:20:15Z",
        lastError: null,
        pendingSubmission: null,
        version: 1,
      },
      {
        id: "sc_01JA2ZB9C3E7G1J5M9Q3S7V1X6",
        environment: "live",
        credentialSource: "tenant",
        status: "invalid_credentials",
        officeIds: ["OSLN12345"],
        defaultOfficeId: "OSLN12345",
        queuingOfficeId: null,
        ownerOfficeId: null,
        clientId: CLIENT_ID,
        ticketingDefaults: {},
        monitoredQueues: [],
        lastVerifiedAt: null,
        lastError: "HTTP 401 invalid_client",
        pendingSubmission: {
          id: "crs_01JD4Q2S6V0X4Z8B2D6F0H4K8N",
          status: "failed",
          errorCode: "AMADEUS_CREDENTIALS_INVALID",
        },
        version: 4,
      },
    ],
    paymentConnections: [
      {
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
      },
      {
        id: "ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6Y",
        environment: "live",
        provider: "stripe",
        accountMode: "api_keys",
        status: "pending",
        accountReference: ACCOUNT_REFERENCE,
        publishableKey: PUBLISHABLE_KEY,
        statementDescriptorSuffix: null,
        capabilities: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true },
        connectedAt: "2026-10-18T12:00:00Z",
        disconnectedAt: null,
        webhookUrl: "https://api.ota.example.com/webhooks/stripe/c/ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6Y",
        pendingSubmission: null,
        version: 2,
      },
    ],
    domains: [
      {
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
        tlsStatus: "issued",
        tlsExpiresAt: "2027-01-12T08:21:00Z",
        createdAt: "2026-10-14T08:20:11Z",
      },
    ],
    recentJobs: [
      {
        id: "job_01JB3M0S5V9X3Z7B1D5F9H3K7N",
        tenantId: TENANT_ID,
        tenantKey: "acme",
        kind: "suspend",
        status: "running",
        step: "dispatch",
        attempt: 2,
        maxAttempts: 5,
        error: "OTA worker did not answer within 30 seconds.",
        scheduledAt: "2026-10-19T10:00:30Z",
        startedAt: "2026-10-19T10:00:01Z",
        finishedAt: null,
      },
      {
        id: "job_01JA2ZC3D7F1H5K9M3P7R1T5V9",
        tenantId: TENANT_ID,
        tenantKey: "acme",
        kind: "provision",
        status: "succeeded",
        step: "notify",
        attempt: 1,
        maxAttempts: 5,
        error: null,
        scheduledAt: "2026-10-14T08:20:11Z",
        startedAt: "2026-10-14T08:20:12Z",
        finishedAt: "2026-10-14T08:20:16Z",
      },
    ],
    recentAudit: [
      {
        id: "1042",
        tenantId: TENANT_ID,
        tenantKey: "acme",
        actorType: "account",
        actorAccountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
        actorLabel: OWNER_EMAIL,
        action: "invitation.created",
        targetType: "invitation",
        targetId: "ivt_01JA2ZF4H8K2M6P0R4T8W2Y6A0",
        requestId: "req_01JA2ZF4H8K2M6P0R4T8W2Y6A1",
        ipAddress: "198.51.100.23",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15",
        details: { email: "jo@acme-travel.example.com", role: "agent" },
        createdAt: "2026-10-14T09:00:00Z",
      },
    ],
  };
}

/**
 * Values that an API answer must never carry (secrets, ciphertexts, hashes, tokens), put into the answer as properties
 * the document does not have: if one ever arrived, the page must still not show it.
 */
const SENTINELS = [
  "PAD004-SENTINEL-CLIENT-SECRET",
  "PAD004-SENTINEL-CIPHERTEXT",
  "PAD004-SENTINEL-SECRET-KEY",
  "PAD004-SENTINEL-WEBHOOK-SECRET",
  "PAD004-SENTINEL-PASSWORD-HASH",
  "PAD004-SENTINEL-INVITATION-TOKEN",
  "PAD004-SENTINEL-METADATA",
] as const;

/** `detail()` as JSON, with each sentinel in a property the document does not have. */
function leakyDetail(): unknown {
  const answer = detail();
  const [clientSecret, ciphertext, secretKey, webhookSecret, passwordHash, token, metadata] = SENTINELS;
  return {
    ...answer,
    tenant: { ...answer.tenant, metadata: { secret: metadata } },
    members: answer.members.map((member) => ({ ...member, passwordHash })),
    invitations: answer.invitations.map((invitation) => ({ ...invitation, token })),
    amadeusConnections: answer.amadeusConnections.map((connection) => ({
      ...connection,
      clientSecret,
      credentialsCiphertext: ciphertext,
    })),
    paymentConnections: answer.paymentConnections.map((connection) => ({
      ...connection,
      secretKey,
      webhookSecret,
    })),
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
    { error: { code, message: "The API's own text, never shown", status, requestId: "req_api_pad004" } },
    status,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/** The OTA search as the API answers it: `q` matches part of the key, the name or the owner e-mail, in any case. */
function searchTenants(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const q = query.get("q")?.toLowerCase();
  const status = query.get("status");
  const planCode = query.get("planCode");
  const data = summaries().filter(
    (row) =>
      (q === undefined ||
        [row.key, row.name, row.ownerEmail ?? ""].some((value) => value.toLowerCase().includes(q))) &&
      (status === null || row.status === status) &&
      (planCode === null || row.planCode === planCode),
  );
  return json({ data, page: { nextCursor: null, limit: 50 } }, 200);
}

/** Answers each call by `METHOD /path`; unexpected calls fail the test. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    "GET /v1/admin/dashboard": () => json(dashboard(), 200),
    "GET /v1/admin/tenants": searchTenants,
    "GET /v1/admin/plans": () => json({ data: PLANS }, 200),
    [`GET ${TENANT_PATH}`]: () => json(detail(), 200),
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

/** The query of the one call of `GET path`, as sorted entries. */
function queryOfCall(path: string): [string, string][] {
  const [call, ...more] = calls("GET", path);
  expect(more).toHaveLength(0);
  if (call === undefined) {
    throw new Error(`no call of ${path}`);
  }
  return sortedQuery(new URL(call.url).search);
}

function sortedQuery(search: string): [string, string][] {
  return [...new URLSearchParams(search).entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Every call carries the admin session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pad004_admin",
    }),
  );
  nextHeaders.cookies.mockResolvedValue({
    get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
    has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
    set: vi.fn(),
  });
  for (const method of Object.values(navigation.router)) {
    method.mockReset();
  }
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  routes();
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/** The page's `searchParams` as Next.js 15 passes them: a repeated parameter is an array. */
function searchParamsOf(search: string): Promise<Record<string, string | string[]>> {
  const record: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(search).entries()) {
    const current = record[name];
    record[name] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  }
  return Promise.resolve(record);
}

function setUrl(pathname: string, search = ""): void {
  navigation.pathname = pathname;
  navigation.searchParams = new URLSearchParams(search);
}

async function openDashboard(): Promise<void> {
  setUrl("/");
  render(await DashboardPage());
}

/** Renders `/tenants<search>` as a browser opening that URL gets it. */
async function openTenants(search = ""): Promise<void> {
  setUrl("/tenants", search);
  render(await TenantsPage({ searchParams: searchParamsOf(search) }));
}

/** Renders `/tenants/<id><search>`. */
async function openTenant(tenantId = TENANT_ID, search = ""): Promise<void> {
  setUrl(`/tenants/${tenantId}`, search);
  render(await TenantDetailPage({ params: Promise.resolve({ tenantId }) }));
}

/** The client components these pages render: Next.js sends their props, not their output, to the browser. */
const CLIENT_COMPONENTS: ReadonlySet<unknown> = new Set<unknown>([
  TenantTabs,
  TenantTable,
  FilterBar,
  Link,
  ...Object.values(tableComponents),
]);

/**
 * Roughly what the React Server Components payload of a page holds, as Next.js would send it to the browser: server
 * components are rendered (called), while host elements and client components keep their props, every element in
 * those props resolved the same way. A value in it reaches the browser even when nothing renders it.
 */
function serverPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(serverPayload);
  }
  if (isValidElement(value)) {
    const { type, props } = value as ReactElement<Record<string, unknown>>;
    if (typeof type === "function" && !CLIENT_COMPONENTS.has(type)) {
      return serverPayload((type as (properties: Record<string, unknown>) => unknown)(props));
    }
    return {
      type: typeof type === "string" ? type : CLIENT_COMPONENTS.has(type) ? "client" : "other",
      props: serverPayload(props),
    };
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, serverPayload(entry)]));
  }
  return value;
}

function link(name: string | RegExp): HTMLAnchorElement {
  return screen.getByRole("link", { name }) as HTMLAnchorElement;
}

/** The href of a link as written, relative to the admin. */
function hrefOf(element: HTMLAnchorElement): string | null {
  return element.getAttribute("href");
}

/** Opens a tab with the pointer, as Radix's trigger expects (`mousedown` with the main button). */
function openTab(name: string): HTMLElement {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0 });
  return screen.getByRole("tabpanel");
}

/** Submits the form of the button named `name`, with that button as the submitter. */
function submit(name: string): void {
  const button = screen.getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

/**
 * Once per file, before any test: the first render of the three pages in a fresh worker (the module graph of the
 * tables, the Radix tabs and the filter bar) is the slowest step, and on a busy CI runner it would otherwise land in
 * the first test's own five seconds. Nothing of it stays: each test gets a fresh API and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  await openDashboard();
  cleanup();
  await openTenants("q=acme");
  cleanup();
  await openTenant();
  for (const label of Object.values(TENANT_TAB_LABELS)) {
    openTab(label);
  }
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The dashboard -------------------------------------------------------------------------------------------------

describe("(app)/page.tsx: the dashboard", () => {
  it("links every count of adminGetDashboard to its filtered list", async () => {
    await openDashboard();

    expect(calls("GET", "/v1/admin/dashboard")).toHaveLength(1);
    expectSessionHeaders(calls("GET", "/v1/admin/dashboard")[0]);
    expect(screen.getByRole("heading", { level: 1, name: DASHBOARD_STRINGS.title })).toBeTruthy();

    const tenants = screen.getByRole("region", { name: DASHBOARD_STRINGS.tenantsTitle });
    expect(
      within(tenants)
        .getAllByRole("link")
        .map((element) => [element.textContent, hrefOf(element as HTMLAnchorElement)]),
    ).toEqual([
      ["1 Setting up", "/tenants?status=provisioning"],
      ["14 Active", "/tenants?status=active"],
      ["1 Suspended", "/tenants?status=suspended"],
      ["2 Set-up failed", "/tenants?status=failed"],
    ]);

    expect(hrefOf(link("1 tenant job failed in the last 24 hours"))).toBe("/provisioning-jobs?status=failed");

    const queues = screen.getByRole("region", { name: DASHBOARD_STRINGS.queuesTitle });
    const queueLinks = within(queues).getAllByRole("link") as HTMLAnchorElement[];
    expect(queueLinks).toHaveLength(7);
    expect(
      hrefOf(
        within(queues).getByRole("link", { name: "platform-emails 2 failed jobs" }) as HTMLAnchorElement,
      ),
    ).toBe("/queues/platform-emails");
    expect(
      hrefOf(
        within(queues).getByRole("link", {
          name: "platform-tenant-events 0 failed jobs",
        }) as HTMLAnchorElement,
      ),
    ).toBe("/queues/platform-tenant-events");

    const test = screen.getByRole("region", { name: "Test" });
    expect(hrefOf(within(test).getByRole("link", { name: "2 available" }) as HTMLAnchorElement)).toBe(
      "/amadeus/offices?environment=test&status=available",
    );
    expect(hrefOf(within(test).getByRole("link", { name: "17 assigned" }) as HTMLAnchorElement)).toBe(
      "/amadeus/offices?environment=test&status=assigned",
    );
    const live = screen.getByRole("region", { name: "Live" });
    expect(hrefOf(within(live).getByRole("link", { name: "3 available" }) as HTMLAnchorElement)).toBe(
      "/amadeus/offices?environment=live&status=available",
    );
  });

  it("warns below three available offices of an environment, in words", async () => {
    await openDashboard();

    const test = screen.getByRole("region", { name: "Test" });
    expect(within(test).getByText(DASHBOARD_STRINGS.poolLow("Test", 2))).toBeTruthy();
    // Exactly three is not below three.
    const live = screen.getByRole("region", { name: "Live" });
    expect(live.querySelector('[data-warning="office-pool-low"]')).toBeNull();
    expect(DASHBOARD_STRINGS.poolLow("Test", 1)).toContain("Only 1 office is available in Test.");
  });

  it("says there is no pool yet before a Velexis Amadeus account exists", async () => {
    routes({ "GET /v1/admin/dashboard": () => json(dashboard({ officePool: [] }), 200) });
    await openDashboard();

    expect(screen.getByText(DASHBOARD_STRINGS.officePoolEmpty, { exact: false })).toBeTruthy();
    expect(hrefOf(link(DASHBOARD_STRINGS.officePoolAccountsLink))).toBe("/amadeus/accounts");
  });

  it("shows the admin's message while the API is unavailable (Redis down), never the API's own text", async () => {
    routes({ "GET /v1/admin/dashboard": () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openDashboard();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(DASHBOARD_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("sends an ended session to sign-in", async () => {
    routes({ "GET /v1/admin/dashboard": () => apiError("TOKEN_EXPIRED", 401) });
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });
});

// ---- The tenant list -------------------------------------------------------------------------------------------------

describe("tenants/page.tsx: the tenant search", () => {
  it("[PAD-004 AC1] finds the tenant by its owner's e-mail address, and the URL of the search is shareable [PF-81]", async () => {
    await openTenants();
    expect(queryOfCall("/v1/admin/tenants")).toEqual([]);
    expectSessionHeaders(calls("GET", "/v1/admin/tenants")[0]);
    expect(screen.getAllByRole("row")).toHaveLength(3);

    // The admin types the owner's whole address and searches: the search goes into the URL.
    const search = screen.getByRole("searchbox", { name: TENANT_LIST_STRINGS.searchLabel });
    fireEvent.change(search, { target: { value: `  ${OWNER_EMAIL} ` } });
    submit("Search");
    expect(navigation.router.push).toHaveBeenCalledTimes(1);
    const [href] = navigation.router.push.mock.calls[0] as [string];
    const url = new URL(href, "https://admin.invalid");
    expect(url.pathname).toBe("/tenants");
    expect(sortedQuery(url.search)).toEqual([["q", OWNER_EMAIL]]);

    // Another admin opens that URL: the page reads only the URL, so it shows the same result.
    cleanup();
    fetchMock.mockClear();
    await openTenants(url.search);
    expect(queryOfCall("/v1/admin/tenants")).toEqual([["q", OWNER_EMAIL]]);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    const row = rows[1] as HTMLElement;
    expect(hrefOf(within(row).getByRole("link", { name: "Acme Travel" }) as HTMLAnchorElement)).toBe(
      `/tenants/${TENANT_ID}`,
    );
    expect(within(row).getByText(OWNER_EMAIL)).toBeTruthy();
    expect(within(row).getByText("Growth")).toBeTruthy();
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(screen.queryByText("Nordic Fares")).toBeNull();
    // The search field shows the search of the URL.
    expect(
      (screen.getByRole("searchbox", { name: TENANT_LIST_STRINGS.searchLabel }) as HTMLInputElement).value,
    ).toBe(OWNER_EMAIL);
  });

  it("[PAD-004 AC1] keeps the search in the URL when a filter changes and on the next page", async () => {
    routes({
      "GET /v1/admin/tenants": (request) => {
        const answer = searchTenants(request);
        return answer
          .json()
          .then((body: { data: unknown[] }) =>
            json({ data: body.data, page: { nextCursor: "eyJwYWdlIjoyfQ", limit: 50 } }, 200),
          );
      },
    });
    await openTenants(`q=${encodeURIComponent(OWNER_EMAIL)}`);

    // The next page keeps the search.
    const next = new URL(hrefOf(link("Next page")) ?? "", "https://admin.invalid");
    expect(next.pathname).toBe("/tenants");
    expect(sortedQuery(next.search)).toEqual([
      ["cursor", "eyJwYWdlIjoyfQ"],
      ["q", OWNER_EMAIL],
    ]);

    // A status keeps the search and starts again on the first page.
    fireEvent.change(screen.getByRole("combobox", { name: TENANT_LIST_STRINGS.statusLabel }), {
      target: { value: "active" },
    });
    const [href] = navigation.router.push.mock.calls[0] as [string];
    expect(sortedQuery(new URL(href, "https://admin.invalid").search)).toEqual([
      ["q", OWNER_EMAIL],
      ["status", "active"],
    ]);

    // Opening the filtered page of the cursor sends every filter and the cursor to the API.
    cleanup();
    fetchMock.mockClear();
    await openTenants(
      `q=${encodeURIComponent(OWNER_EMAIL)}&status=active&planCode=growth&cursor=eyJwYWdlIjoyfQ`,
    );
    expect(queryOfCall("/v1/admin/tenants")).toEqual([
      ["cursor", "eyJwYWdlIjoyfQ"],
      ["planCode", "growth"],
      ["q", OWNER_EMAIL],
      ["status", "active"],
    ]);
    expect(screen.getByRole("link", { name: "First page" })).toBeTruthy();
  });

  it("lists every plan in the plan filter, retired ones marked, and the plan names in the table", async () => {
    await openTenants();

    const select = screen.getByRole("combobox", { name: TENANT_LIST_STRINGS.planLabel });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => [option.getAttribute("value"), option.textContent]),
    ).toEqual([
      ["", "Any"],
      ["early_access", "Early access"],
      ["growth", "Growth"],
      ["pilot", TENANT_LIST_STRINGS.retiredPlan("Pilot")],
    ]);
    const status = screen.getByRole("combobox", { name: TENANT_LIST_STRINGS.statusLabel });
    expect(
      within(status)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["", "provisioning", "active", "suspended", "failed"]);
    const nordic = screen.getAllByRole("row")[1] as HTMLElement;
    expect(within(nordic).getByText("Early access")).toBeTruthy();
    expect(within(nordic).getByText("Set-up failed")).toBeTruthy();
    expect(within(nordic).getByText(TENANT_LIST_STRINGS.notYet)).toBeTruthy();
  });

  it("shows a notice for filters the API would refuse, and does not ask it for a list", async () => {
    for (const search of [
      "status=deleted",
      "planCode=Not-A-Plan",
      "q=acme&q=nordic",
      `q=${"x".repeat(255)}`,
      `cursor=${"c".repeat(513)}`,
    ]) {
      fetchMock.mockClear();
      await openTenants(search);
      expect(screen.getByText(TENANT_LIST_STRINGS.invalidFilters)).toBeTruthy();
      expect(calls("GET", "/v1/admin/tenants")).toHaveLength(0);
      expect(screen.queryByRole("table")).toBeNull();
      // The filter bar stays, with a way back to the whole list (for a bad cursor alone too).
      expect(screen.getByRole("search", { name: TENANT_LIST_STRINGS.filtersLabel })).toBeTruthy();
      expect(hrefOf(link(TENANT_LIST_STRINGS.showAll))).toBe("/tenants");
      cleanup();
    }
    // Empty parameters, as the filter bar's plain GET form sends them, are no filter; 254 characters are fine.
    fetchMock.mockClear();
    await openTenants(`q=${"x".repeat(254)}&status=&planCode=&cursor=`);
    expect(queryOfCall("/v1/admin/tenants")).toEqual([["q", "x".repeat(254)]]);
  });

  it("hands the client table only the fields it shows, whatever else the answer holds", async () => {
    const [sentinel] = SENTINELS;
    routes({
      "GET /v1/admin/tenants": () =>
        json(
          {
            data: summaries().map((row) => ({ ...row, ownerPasswordHash: sentinel })),
            page: { nextCursor: null, limit: 50, debug: sentinel },
          },
          200,
        ),
    });
    const page = await TenantsPage({ searchParams: searchParamsOf("") });

    // `TenantTable` is a client component: Next.js sends its props to the browser, rendered or not.
    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain(OWNER_EMAIL);
    expect(payload).not.toContain(sentinel);
    render(page);
    expect(document.body.innerHTML).not.toContain(sentinel);
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("still lists the OTAs when the plans cannot be loaded, and keeps the plan of the URL in its filter", async () => {
    routes({ "GET /v1/admin/plans": () => apiError("INTERNAL_ERROR", 500) });
    await openTenants("planCode=growth");

    expect(screen.getAllByRole("row")).toHaveLength(2);
    const select = screen.getByRole("combobox", { name: TENANT_LIST_STRINGS.planLabel }) as HTMLSelectElement;
    expect(select.value).toBe("growth");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["", "growth"]);
  });

  it("shows the admin's message when the list cannot be loaded, and sends an ended session to sign-in", async () => {
    routes({ "GET /v1/admin/tenants": () => apiError("RATE_LIMITED", 429) });
    await openTenants();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(TENANT_LIST_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.RATE_LIMITED);
    expect(document.body.textContent).not.toContain("The API's own text");
    cleanup();

    // A cursor the API refuses reads as invalid filters.
    routes({ "GET /v1/admin/tenants": () => apiError("VALIDATION_FAILED", 400) });
    await openTenants("cursor=stale");
    expect(screen.getByText(TENANT_LIST_STRINGS.invalidFilters)).toBeTruthy();
    cleanup();

    routes({ "GET /v1/admin/tenants": () => apiError("UNAUTHENTICATED", 401) });
    await expect(TenantsPage({ searchParams: searchParamsOf("") })).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });
});

// ---- The tenant detail ---------------------------------------------------------------------------------------------

describe("tenants/[tenantId]/page.tsx: the tenant detail", () => {
  it("[PAD-004 AC2] shows every tab with the data of adminGetTenant [PF-81]", async () => {
    await openTenant();

    // One call: every tab is the answer of adminGetTenant.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectSessionHeaders(calls("GET", TENANT_PATH)[0]);
    expect(screen.getByRole("heading", { level: 1, name: "Acme Travel" })).toBeTruthy();
    expect(hrefOf(link(TENANT_DETAIL_STRINGS.backToList))).toBe("/tenants");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      Object.values(TENANT_TAB_LABELS),
    );

    const overview = screen.getByRole("tabpanel");
    for (const text of [
      "Acme Travel AS",
      "Abuse",
      "Europe/Oslo",
      "support@acme-travel.example.com",
      "0001_baseline",
      "Pilot customer; contact Anna for anything urgent.",
      TENANT_ID,
    ]) {
      expect(within(overview).getByText(text)).toBeTruthy();
    }

    const members = openTab(TENANT_TAB_LABELS.members);
    expect(hrefOf(within(members).getByRole("link", { name: "Ola Nordmann" }) as HTMLAnchorElement)).toBe(
      "/accounts/acc_01JA2Z9W5K7Q3M8N4P6R2T0V1Y",
    );
    expect(within(members).getByText("Finance")).toBeTruthy();
    expect(within(members).getByText(TENANT_DETAIL_STRINGS.mfaOff)).toBeTruthy();
    const invitation = within(members).getByText("jo@acme-travel.example.com").closest("tr") as HTMLElement;
    expect(within(invitation).getByText("Agent")).toBeTruthy();
    expect(within(invitation).getByText("Pending")).toBeTruthy();
    expect(within(invitation).getByRole("link", { name: "Anna Berg" })).toBeTruthy();

    const subscription = openTab(TENANT_TAB_LABELS.subscription);
    expect(within(subscription).getByText("Early access")).toBeTruthy();
    expect(within(subscription).getByText("Trial")).toBeTruthy();
    expect(within(subscription).getByText("Manual (no Stripe)")).toBeTruthy();
    expect(
      hrefOf(
        within(subscription).getByRole("link", {
          name: TENANT_DETAIL_STRINGS.invoicesLink,
        }) as HTMLAnchorElement,
      ),
    ).toBe("/subscriptions/sub_01JA2Z7R5N0S3V7X1Z4B9D2F6H");

    const connections = openTab(TENANT_TAB_LABELS.connections);
    const amadeusTest = within(connections).getByRole("region", { name: "Amadeus, Test" });
    expect(within(amadeusTest).getAllByText("NCE1A0955").length).toBeGreaterThan(0);
    expect(within(amadeusTest).getByText("Velexis account, office from the pool")).toBeTruthy();
    const amadeusLive = within(connections).getByRole("region", { name: "Amadeus, Live" });
    expect(within(amadeusLive).getByText("Invalid credentials")).toBeTruthy();
    expect(within(amadeusLive).getByText("HTTP 401 invalid_client")).toBeTruthy();
    expect(within(amadeusLive).getByText("AMADEUS_CREDENTIALS_INVALID")).toBeTruthy();
    const stripeTest = within(connections).getByRole("region", { name: "Stripe, Test" });
    expect(within(stripeTest).getByText("ACME TRAVEL")).toBeTruthy();
    expect(within(stripeTest).getByText("Velexis Stripe account")).toBeTruthy();
    const stripeLive = within(connections).getByRole("region", { name: "Stripe, Live" });
    expect(within(stripeLive).getByText("The OTA's account through its own API keys")).toBeTruthy();

    const domains = openTab(TENANT_TAB_LABELS.domains);
    const domain = within(domains).getByText("acme.ota.example.com").closest("tr") as HTMLElement;
    expect(within(domain).getByText("Sub-domain")).toBeTruthy();
    expect(within(domain).getByText("Verified")).toBeTruthy();
    expect(within(domain).getByText("Issued")).toBeTruthy();

    const jobs = openTab(TENANT_TAB_LABELS.jobs);
    const suspendJob = within(jobs)
      .getByRole("link", { name: "job_01JB3M0S5V9X3Z7B1D5F9H3K7N" })
      .closest("tr") as HTMLElement;
    expect(within(suspendJob).getByText("Suspension")).toBeTruthy();
    expect(within(suspendJob).getByText("Running")).toBeTruthy();
    expect(within(suspendJob).getByText("2 of 5")).toBeTruthy();
    expect(within(suspendJob).getByText("OTA worker did not answer within 30 seconds.")).toBeTruthy();
    expect(
      hrefOf(within(jobs).getByRole("link", { name: "job_01JB3M0S5V9X3Z7B1D5F9H3K7N" }) as HTMLAnchorElement),
    ).toBe("/provisioning-jobs/job_01JB3M0S5V9X3Z7B1D5F9H3K7N");
    expect(
      hrefOf(within(jobs).getByRole("link", { name: TENANT_DETAIL_STRINGS.allJobs }) as HTMLAnchorElement),
    ).toBe(`/provisioning-jobs?tenantId=${TENANT_ID}`);

    const audit = openTab(TENANT_TAB_LABELS.audit);
    const row = within(audit).getByText("invitation.created").closest("tr") as HTMLElement;
    expect(within(row).getByText("Portal user")).toBeTruthy();
    expect(within(row).getByText(OWNER_EMAIL)).toBeTruthy();
    expect(within(row).getByText("198.51.100.23")).toBeTruthy();
    expect(
      within(row).getByRole("region", { name: TENANT_DETAIL_STRINGS.auditDetailsOf("1042") }).textContent,
    ).toContain('"email": "jo@acme-travel.example.com"');
    expect(
      hrefOf(within(audit).getByRole("link", { name: TENANT_DETAIL_STRINGS.fullAudit }) as HTMLAnchorElement),
    ).toBe(`/audit?tenantId=${TENANT_ID}`);
  });

  it("[PAD-004 AC2] shows no secret value: connections masked, properties the document lacks never rendered", async () => {
    routes({ [`GET ${TENANT_PATH}`]: () => json(leakyDetail(), 200) });
    await openTenant();

    // Every tab's panel, as the admin can open them.
    const pages: string[] = [document.body.innerHTML];
    for (const label of Object.values(TENANT_TAB_LABELS)) {
      openTab(label);
      pages.push(document.body.innerHTML);
    }
    const everything = pages.join("\n");
    for (const sentinel of SENTINELS) {
      expect(everything).not.toContain(sentinel);
    }
    // The client id, the Stripe account and the publishable key show their prefix and last four characters only.
    for (const full of [CLIENT_ID, ACCOUNT_REFERENCE, PUBLISHABLE_KEY]) {
      expect(everything).not.toContain(full);
    }
    const connections = openTab(TENANT_TAB_LABELS.connections);
    expect(within(connections).getByText("Client id ending in 7Q2X")).toBeTruthy();
    expect(within(connections).getByText("Stripe account ending in t9Kz")).toBeTruthy();
    expect(within(connections).getByText("Publishable key ending in y4Fq")).toBeTruthy();
    expect(connections.textContent).toContain("pk_live_••••y4Fq");
    expect(connections.textContent).toContain("acct_••••t9Kz");
  });

  it("[PAD-004 AC2] sends the browser no secret value: the client tabs get rendered panels, never the API answer", async () => {
    routes({ [`GET ${TENANT_PATH}`]: () => json(leakyDetail(), 200) });
    const page = await TenantDetailPage({ params: Promise.resolve({ tenantId: TENANT_ID }) });

    // What Next.js would send: every tab's panel rendered on the server, and the props of the client components.
    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain('"type":"client"');
    for (const shown of [
      "Acme Travel AS",
      "Pilot customer; contact Anna for anything urgent.",
      "7Q2X",
      "y4Fq",
    ]) {
      expect(payload).toContain(shown);
    }
    for (const hidden of [...SENTINELS, CLIENT_ID, ACCOUNT_REFERENCE, PUBLISHABLE_KEY]) {
      expect(payload).not.toContain(hidden);
    }
  });

  it("opens the tab of the URL, and writes the open tab into the URL without asking the API again", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    await openTenant(TENANT_ID, "tab=audit");

    expect(screen.getByRole("tab", { name: TENANT_TAB_LABELS.audit }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(within(screen.getByRole("tabpanel")).getByText("invitation.created")).toBeTruthy();

    openTab(TENANT_TAB_LABELS.members);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", `/tenants/${TENANT_ID}?tab=members`);
    openTab(TENANT_TAB_LABELS.overview);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", `/tenants/${TENANT_ID}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cleanup();

    // An unknown tab opens the overview.
    await openTenant(TENANT_ID, "tab=secrets");
    expect(screen.getByRole("tab", { name: TENANT_TAB_LABELS.overview }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("shows the empty states of a tenant with nothing yet", async () => {
    const answer = detail();
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(
          {
            ...answer,
            tenant: {
              ...answer.tenant,
              status: "provisioning",
              suspensionReason: null,
              suspendedAt: null,
              notes: null,
            },
            members: [],
            invitations: [],
            subscription: null,
            amadeusConnections: [],
            paymentConnections: [],
            domains: [],
            recentJobs: [],
            recentAudit: [],
          },
          200,
        ),
    });
    await openTenant();

    expect(within(screen.getByRole("tabpanel")).getByText(TENANT_DETAIL_STRINGS.noNotes)).toBeTruthy();
    expect(
      within(screen.getByRole("tabpanel")).queryByText(TENANT_DETAIL_STRINGS.suspensionReason),
    ).toBeNull();
    const expected: [string, string[]][] = [
      [
        TENANT_TAB_LABELS.members,
        [TENANT_DETAIL_STRINGS.membersEmpty, TENANT_DETAIL_STRINGS.invitationsEmpty],
      ],
      [TENANT_TAB_LABELS.subscription, [TENANT_DETAIL_STRINGS.noSubscription]],
      [
        TENANT_TAB_LABELS.connections,
        [TENANT_DETAIL_STRINGS.amadeusEmpty, TENANT_DETAIL_STRINGS.paymentsEmpty],
      ],
      [TENANT_TAB_LABELS.domains, [TENANT_DETAIL_STRINGS.domainsEmpty]],
      [TENANT_TAB_LABELS.jobs, [TENANT_DETAIL_STRINGS.jobsEmpty]],
      [TENANT_TAB_LABELS.audit, [TENANT_DETAIL_STRINGS.auditEmpty]],
    ];
    for (const [tab, texts] of expected) {
      const panel = openTab(tab);
      for (const text of texts) {
        expect(within(panel).getByText(text)).toBeTruthy();
      }
    }
  });

  it("renders the not-found page for an unknown tenant, and for a value that is no tenant id without a call", async () => {
    await expect(TenantDetailPage({ params: Promise.resolve({ tenantId: "acme" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`GET ${TENANT_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await expect(TenantDetailPage({ params: Promise.resolve({ tenantId: TENANT_ID }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(calls("GET", TENANT_PATH)).toHaveLength(1);
  });

  it("sends an ended session to sign-in and shows other failures in the admin's words", async () => {
    routes({ [`GET ${TENANT_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(TenantDetailPage({ params: Promise.resolve({ tenantId: TENANT_ID }) })).rejects.toThrow(
      "NEXT_REDIRECT /sign-in",
    );

    routes({ [`GET ${TENANT_PATH}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openTenant();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(TENANT_DETAIL_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(hrefOf(link(TENANT_DETAIL_STRINGS.backToList))).toBe("/tenants");
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
