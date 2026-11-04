// @vitest-environment happy-dom
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

/** One router for the whole file, as Next.js keeps one per app: `CheckoutConfirmation` refreshes the page with it. */
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
const navigation = vi.hoisted(() => ({
  pathname: "/dashboard",
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  // As Next.js's own does for a real redirect() or notFound(): throws them again, returns for anything else.
  unstable_rethrow: vi.fn((error: unknown): void => {
    if (error instanceof Error && /^NEXT_(REDIRECT|NOT_FOUND)/.test(error.message)) {
      throw error;
    }
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => router,
  redirect: navigation.redirect,
  notFound: navigation.notFound,
  unstable_rethrow: navigation.unstable_rethrow,
}));

const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => nextCache);

/**
 * React's `cache()` as Next.js runs it on the server: one memo per request (see ota-dashboard.test.tsx), so the layout
 * and the page of one request share their `getTenant` and `getSubscription` calls. Every `routes()` call starts a new
 * request.
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
  getCheckoutSync,
  openCustomerPortal,
  startCheckout,
  type CheckoutSyncPoll,
  type ChoosePlanState,
  type PortalState,
} from "@/app/(app)/otas/[tenantId]/billing/actions";
import {
  CHECKOUT_POLL_INTERVAL_MS,
  CheckoutConfirmation,
} from "@/app/(app)/otas/[tenantId]/billing/billing-forms";
import {
  checkoutReturnOf,
  followableUrl,
  isConfirmedSubscription,
  planChoiceOffered,
} from "@/app/(app)/otas/[tenantId]/billing/billing-rules";
import BillingPage from "@/app/(app)/otas/[tenantId]/billing/page";
import DomainsPage from "@/app/(app)/otas/[tenantId]/domains/page";
import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import OtaDashboardPage from "@/app/(app)/otas/[tenantId]/page";
import SetupPage from "@/app/(app)/otas/[tenantId]/setup/page";
import TeamPage from "@/app/(app)/otas/[tenantId]/team/page";
import { formatDateTime } from "@/components/date-time";
import { formatMoney } from "@/components/money";
import { TenantBanner, trialDaysLeft } from "@/components/tenant-banner";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { MilestoneFeatures, TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  BILLING_STRINGS,
  ERROR_MESSAGES,
  STATUS_LABELS,
  TENANT_BANNER_STRINGS,
  WIZARD_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key, card or account) ---------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type Account = Schemas["Account"];
type Subscription = Schemas["Subscription"];
type Invoice = Schemas["Invoice"];
type Plan = Schemas["Plan"];
type ProvisioningStatus = Schemas["ProvisioningStatus"];

const ACCESS_TOKEN = "pfe021-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-021 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TIME_ZONE = "Europe/Oslo";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const ME_PATH = "/v1/me";
const PLANS_PATH = "/v1/plans";
const SUBSCRIPTION_PATH = `${TENANT_PATH}/subscription`;
const INVOICES_PATH = `${TENANT_PATH}/invoices`;
const CHECKOUT_PATH = `${TENANT_PATH}/billing/checkout-session`;
const PORTAL_PATH = `${TENANT_PATH}/billing/portal-session`;
const ONBOARDING_PATH = `${TENANT_PATH}/onboarding`;
const DOMAINS_PATH = `${TENANT_PATH}/domains`;
const MEMBERS_PATH = `${TENANT_PATH}/members`;
const INVITATIONS_PATH = `${TENANT_PATH}/invitations`;
const PROVISIONING_PATH = `${TENANT_PATH}/provisioning`;
const BILLING_PAGE = `/otas/${TENANT_ID}/billing`;
/** The API's own message: it must never reach the page. */
const RAW_API_MESSAGE = "The API's own text, never shown";

/** Stripe's pages as the API answers them (dummy session ids); a Checkout URL carries a fragment the page needs. */
const CHECKOUT_URL =
  "https://checkout.stripe.com/c/pay/cs_test_pfe021DummySession#fidkdWxOYHwnPyd1blpxYHZxWjA0";
const PORTAL_URL = "https://billing.stripe.com/p/session/test_pfe021DummyPortalSession";
const HOSTED_URL = "https://invoice.stripe.com/i/acct_1Velexis/test_pfe021HostedInvoice";
const PDF_URL = "https://pay.stripe.com/invoice/acct_1Velexis/test_pfe021HostedInvoice/pdf";

/** The fixtures' instants are relative to the start of the file, never a calendar date. */
const START = Date.now();
const DAY_MS = 86_400_000;
function daysFromStart(days: number): string {
  return new Date(START + days * DAY_MS).toISOString();
}

const FEATURES_M5: MilestoneFeatures = {
  stripeBilling: true,
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
    createdAt: daysFromStart(-60),
    activatedAt: daysFromStart(-60),
    version: 4,
    myRole: "owner",
    ...overrides,
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
    mfaEnabledAt: daysFromStart(-50),
    isPlatformAdmin: false,
    createdAt: daysFromStart(-61),
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
    features: { ...FEATURES_M5, ...features },
  };
}

/** The manual trial of an OTA created before M5 (flows/subscription-billing.md §G). */
function manualTrial(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_01JA2Z7R5N0S3V7X1Z4B9D2F6H",
    planCode: "early_access",
    planName: "Early access",
    status: "trialing",
    billingProvider: "manual",
    billingInterval: "month",
    trialEndsAt: daysFromStart(20),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    banner: null,
    canManageInStripe: false,
    ...overrides,
  };
}

/** A Stripe subscription to Growth, billed yearly. */
function stripeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_01JA2Z7R5N0S3V7X1Z4B9D2F7J",
    planCode: "growth",
    planName: "Growth",
    status: "active",
    billingProvider: "stripe",
    billingInterval: "year",
    trialEndsAt: null,
    currentPeriodEnd: daysFromStart(300),
    cancelAtPeriodEnd: false,
    banner: null,
    canManageInStripe: true,
    ...overrides,
  };
}

function plan(overrides: Partial<Plan> & Pick<Plan, "code" | "name">): Plan {
  return {
    description: null,
    monthlyPrice: { amount: "49.00", currency: "EUR" },
    annualPrice: { amount: "490.00", currency: "EUR" },
    trialDays: 14,
    limits: { staffSeats: 5, apiKeys: 5, customDomains: 1, liveMode: true },
    features: {},
    checkoutAvailable: { month: true, year: true },
    ...overrides,
  };
}

/** `listPlans`: early access (no Stripe price), Growth (both intervals) and Scale (monthly only). */
function plans(): Plan[] {
  return [
    plan({
      code: "early_access",
      name: "Early access",
      monthlyPrice: { amount: "0.00", currency: "EUR" },
      annualPrice: null,
      trialDays: 90,
      checkoutAvailable: { month: false, year: false },
    }),
    plan({ code: "growth", name: "Growth" }),
    plan({
      code: "scale",
      name: "Scale",
      monthlyPrice: { amount: "149.00", currency: "EUR" },
      annualPrice: null,
      checkoutAvailable: { month: true, year: false },
    }),
  ];
}

/** Velexis's invoices, newest first: a paid JPY invoice, an open EUR one with its page only, and a draft. */
function invoices(): Invoice[] {
  return [
    {
      id: "inv_01JD8V2X6Z0B4D8F2H6K0N4Q8S",
      number: "VX-2027-000184",
      status: "paid",
      total: { amount: "5000", currency: "JPY" },
      amountDue: { amount: "0", currency: "JPY" },
      amountPaid: { amount: "5000", currency: "JPY" },
      periodStart: daysFromStart(-40),
      periodEnd: daysFromStart(-10),
      issuedAt: daysFromStart(-10),
      paidAt: daysFromStart(-10),
      hostedInvoiceUrl: HOSTED_URL,
      invoicePdfUrl: PDF_URL,
    },
    {
      id: "inv_01JD8V2X6Z0B4D8F2H6K0N4Q8T",
      number: "VX-2027-000150",
      status: "open",
      total: { amount: "49.00", currency: "EUR" },
      amountDue: { amount: "49.00", currency: "EUR" },
      amountPaid: { amount: "0.00", currency: "EUR" },
      periodStart: daysFromStart(-70),
      periodEnd: daysFromStart(-40),
      issuedAt: daysFromStart(-40),
      paidAt: null,
      hostedInvoiceUrl: `${HOSTED_URL}2`,
      // Never followed: not an https URL.
      invoicePdfUrl: "http://pay.stripe.com/invoice/acct_1Velexis/test_pfe021/pdf",
    },
    {
      id: "inv_01JD8V2X6Z0B4D8F2H6K0N4Q8V",
      number: "VX-2027-000149",
      status: "draft",
      total: { amount: "1290.50", currency: "EUR" },
      amountDue: { amount: "1290.50", currency: "EUR" },
      amountPaid: { amount: "0.00", currency: "EUR" },
      periodStart: null,
      periodEnd: null,
      issuedAt: null,
      paidAt: null,
      hostedInvoiceUrl: "javascript:alert(1)",
      invoicePdfUrl: null,
    },
  ];
}

/** `getProvisioning` of an OTA whose set-up is over. */
function provisioning(overrides: Partial<ProvisioningStatus> = {}): ProvisioningStatus {
  return {
    tenantStatus: "active",
    job: {
      id: "job_01JA2ZB2D6F0H4K8N2Q6S0V4X8",
      kind: "provision",
      status: "succeeded",
      step: "notify",
      steps: [],
      attempt: 1,
      maxAttempts: 5,
      error: null,
    },
    initialKeysAvailable: false,
    ...overrides,
  };
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(
  code: string,
  status: number,
  extra: { details?: Record<string, unknown>; fieldErrors?: { path: string; code: string }[] } = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      error: {
        code,
        message: RAW_API_MESSAGE,
        status,
        requestId: "req_api_pfe021",
        ...(extra.details === undefined ? {} : { details: extra.details }),
        ...(extra.fieldErrors === undefined
          ? {}
          : { fieldErrors: extra.fieldErrors.map((field) => ({ ...field, message: RAW_API_MESSAGE })) }),
      },
    },
    status,
    headers,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers the calls of one route in turn; the last answer repeats. */
function sequence(...answers: Route[]): Route {
  let next = 0;
  return (request) => {
    const answer = answers[Math.min(next, answers.length - 1)];
    next += 1;
    if (answer === undefined) {
      throw new Error("sequence without answers");
    }
    return answer(request);
  };
}

/**
 * Answers each call by `METHOD /path`: by default an active owner's OTA on its manual trial, with Stripe billing on
 * (M5), the public plans and three invoices. A new answer table is a new request, with nothing cached from the one
 * before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${ME_PATH}`]: () => json(account(), 200),
    [`GET ${SUBSCRIPTION_PATH}`]: () => json(manualTrial(), 200),
    [`GET ${INVOICES_PATH}`]: () => json({ data: invoices() }, 200),
    [`GET ${PLANS_PATH}`]: () => json({ data: plans() }, 200),
    [`GET ${ONBOARDING_PATH}`]: () => json({ items: [] }, 200),
    [`GET ${DOMAINS_PATH}`]: () => json({ data: [] }, 200),
    [`GET ${MEMBERS_PATH}`]: () => json({ data: [] }, 200),
    [`GET ${INVITATIONS_PATH}`]: () => json({ data: [] }, 200),
    [`GET ${PROVISIONING_PATH}`]: () => json(provisioning(), 200),
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

/** `routes()` for an OTA in which the caller has `role`, and other answers. */
function routesAs(role: TenantRole, overrides: Record<string, Route> = {}, base: Partial<Tenant> = {}): void {
  routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ ...base, myRole: role }), 200), ...overrides });
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

/** The route params of `/otas/[tenantId]/…`, as Next.js 15 passes them. */
function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/** The billing page as the OTA layout and the page render it for one request, with the page's query. */
async function billingTree(query: Record<string, string> = {}): Promise<ReactElement> {
  const page = await BillingPage({ params: params(), searchParams: Promise.resolve(query) });
  return OtaLayout({ children: page, params: params() });
}

async function openBilling(query: Record<string, string> = {}): Promise<void> {
  render(await billingTree(query));
}

/** Other pages of the OTA inside the layout, for the banner shown above every one of them. */
const OTHER_PAGES = {
  overview: () => OtaDashboardPage({ params: params() }),
  domains: () => DomainsPage({ params: params() }),
  team: () => TeamPage({ params: params() }),
} as const;

async function openOtherPage(name: keyof typeof OTHER_PAGES): Promise<void> {
  render(await OtaLayout({ children: await OTHER_PAGES[name](), params: params() }));
}

/** The OTA's notices above the page (`TenantBanner` in the layout). */
function notices(): HTMLElement {
  return screen.getByRole("region", { name: TENANT_BANNER_STRINGS.label });
}

/** A section of the billing page by its `data-section`, or `null`. */
function section(name: "choose-plan" | "manage-in-stripe" | "invoices"): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-section="${name}"]`);
}

function chooseForm(): HTMLFormElement {
  const form = section("choose-plan")?.querySelector<HTMLFormElement>('form[data-form="choose-plan"]');
  if (form === null || form === undefined) {
    throw new Error("no Choose a plan form");
  }
  return form;
}

/** The radio button of a plan in "Choose a plan" (its name starts with the plan's name). */
function planRadio(name: string): HTMLInputElement {
  return within(chooseForm()).getByRole<HTMLInputElement>("radio", { name: new RegExp(`^${name}`) });
}

/** The table rows of the invoices, header excluded. */
function invoiceRows(): HTMLElement[] {
  const table = within(section("invoices") ?? document.body).getByRole("table", {
    name: BILLING_STRINGS.invoicesCaption,
  });
  return within(table).getAllByRole("row").slice(1);
}

/** Waits for what a server action renders, without fake timers (see amadeus.test.tsx). */
async function eventually(check: () => void): Promise<void> {
  let failure: unknown;
  for (let turn = 0; turn < 200; turn += 1) {
    try {
      check();
      return;
    } catch (error) {
      failure = error;
    }
    await act(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });
  }
  throw failure;
}

/** Lets `ms` of fake time pass (and the timers due in it run), then lets the answers settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * A stand-in for `getCheckoutSync` bound to the OTA, for `CheckoutConfirmation` on its own: answers its reads in
 * turn (the last answer repeats) and counts them.
 */
function pollOf(...answers: (() => Promise<CheckoutSyncPoll>)[]): {
  readonly poll: () => Promise<CheckoutSyncPoll>;
  readonly reads: () => number;
} {
  let reads = 0;
  return {
    poll: () => {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      if (answer === undefined) {
        throw new Error("pollOf without answers");
      }
      return answer();
    },
    reads: () => reads,
  };
}

/**
 * Next.js handles `redirect()` by navigating; here the error `CheckoutConfirmation` throws again while rendering
 * reaches this boundary, which shows where the browser would go (as in components/submission-status.test.tsx).
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
      <p data-redirected="">{this.state.target}</p>
    );
  }
}

/**
 * The wait for what a server action renders, in the tests that run on real timers: the action runs the real
 * `lib/api.ts` over the mocked fetch, which on a busy CI runner can outlast Testing Library's 1 s default. It stays
 * well inside the test's own budget.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

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
  navigation.pathname = BILLING_PAGE;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  router.refresh.mockClear();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe021_portal",
    }),
  );
  nextHeaders.cookies.mockResolvedValue({
    get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
    has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
    set: vi.fn(),
  });
  routes();
}

/** A form of the page's fields, as a submit of "Choose a plan" sends it. */
function choosePlanForm(fields: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const values: Record<string, string> = {
    idempotencyKey: "0f8d2c1e-7b3a-4c5d-9e6f-a1b2c3d4e5f6",
    planCode: "growth",
    billingInterval: "year",
    ...fields,
  };
  for (const [name, value] of Object.entries(values)) {
    formData.set(name, value);
  }
  return formData;
}

const CHOOSE_IDLE: ChoosePlanState = { status: "idle" };
const PORTAL_IDLE: PortalState = { status: "idle" };

/**
 * The budget of the file's warm-up hook. The first render of the billing page in a fresh worker (the page modules,
 * the API client, TanStack Table, Testing Library and React's DOM on their first run), the other pages' first renders
 * and the first runs of the actions are the slowest, and on a busy CI runner they otherwise land in the first test's own
 * five seconds. The hook only stops if it hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: the billing page with every M5 section, the other pages of the banner test, the three
 * actions run once, and the page rendered on the server and hydrated, so the test bodies hold only the steps they
 * check. Nothing of it stays: each test gets a fresh API (`resetPlatformApi`), fresh mocks and globals
 * (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripeSubscription({ status: "canceled" }), 200) });
  await openBilling();
  cleanup();
  for (const name of Object.keys(OTHER_PAGES) as (keyof typeof OTHER_PAGES)[]) {
    routes();
    await openOtherPage(name);
    cleanup();
  }
  routes({
    [`POST ${CHECKOUT_PATH}`]: () => apiError("PROVIDER_ERROR", 502),
    [`POST ${PORTAL_PATH}`]: () => apiError("PROVIDER_ERROR", 502),
  });
  await startCheckout(TENANT_ID, CHOOSE_IDLE, choosePlanForm());
  await openCustomerPortal(TENANT_ID, PORTAL_IDLE, new FormData());
  await getCheckoutSync(TENANT_ID);
  routes();
  const { root } = await serverRenderAndHydrate(await billingTree());
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

// ---- TenantBanner above every page of the OTA (PF-74) ----------------------------------------------------------

describe("TenantBanner above every OTA page", () => {
  it("[PFE-021 AC2] shows a past_due OTA's banner, with the billing link, above every OTA page [PF-74 AC1]", async () => {
    const pastDue = { billingNotice: "past_due" } as const;
    for (const name of Object.keys(OTHER_PAGES) as (keyof typeof OTHER_PAGES)[]) {
      routesAs("owner", {}, pastDue);
      await openOtherPage(name);
      const alert = notices().querySelector<HTMLElement>('[data-notice="past_due"]');
      expect(alert?.getAttribute("role")).toBe("alert");
      // Once, from the layout: no page adds a banner of its own.
      expect(document.querySelectorAll('[data-notice="past_due"]')).toHaveLength(1);
      expect(alert?.textContent).toContain(TENANT_BANNER_STRINGS.pastDueTitle);
      // "Update your card", with the way to billing.
      expect(alert?.textContent).toContain(TENANT_BANNER_STRINGS.pastDue);
      expect(
        within(alert as HTMLElement)
          .getByRole("link", { name: TENANT_BANNER_STRINGS.billingLink })
          .getAttribute("href"),
      ).toBe(BILLING_PAGE);
      cleanup();
    }

    // The billing page too, where the subscription's own past_due notice is not shown a second time.
    routesAs(
      "owner",
      {
        [`GET ${SUBSCRIPTION_PATH}`]: () =>
          json(stripeSubscription({ status: "past_due", banner: "past_due" }), 200),
      },
      pastDue,
    );
    await openBilling();
    expect(notices().querySelector('[data-notice="past_due"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-notice="past_due"]')).toHaveLength(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    cleanup();

    // Every member reads it; the billing link only for the roles that see billing (an agent's page has none).
    routesAs("agent", {}, pastDue);
    await openOtherPage("overview");
    const alert = notices().querySelector<HTMLElement>('[data-notice="past_due"]');
    expect(alert?.textContent).toContain(TENANT_BANNER_STRINGS.pastDue);
    expect(within(alert as HTMLElement).queryByRole("link")).toBeNull();
    // A billing suspension says so with the billing link.
    cleanup();
    routesAs("finance", {}, { status: "suspended", suspensionReason: "billing" });
    await openOtherPage("domains");
    const suspended = notices().querySelector<HTMLElement>('[data-notice="suspended"]');
    expect(suspended?.textContent).toContain(TENANT_BANNER_STRINGS.suspendedReasons.billing);
    expect(
      within(suspended as HTMLElement)
        .getByRole("link", { name: TENANT_BANNER_STRINGS.billingLink })
        .getAttribute("href"),
    ).toBe(BILLING_PAGE);
  });

  it("tells owners and finance members how many days of an ending trial are left, while its end is ahead", async () => {
    const ending = { billingNotice: "trial_ending" } as const;
    const endsSoon = manualTrial({ trialEndsAt: new Date(Date.now() + 4.5 * DAY_MS).toISOString() });
    routesAs("owner", { [`GET ${SUBSCRIPTION_PATH}`]: () => json(endsSoon, 200) }, ending);
    await openOtherPage("overview");
    const notice = notices().querySelector<HTMLElement>('[data-notice="trial_ending"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain(TENANT_BANNER_STRINGS.trialEndingTitle);
    expect(notice?.textContent).toContain(TENANT_BANNER_STRINGS.trialEnding);
    expect(notice?.querySelector("[data-days-left]")?.textContent).toBe(
      TENANT_BANNER_STRINGS.trialDaysLeft(5),
    );
    expect(
      within(notice as HTMLElement).getByRole("link", { name: TENANT_BANNER_STRINGS.billingLink }),
    ).toBeTruthy();
    const [read, ...more] = calls("GET", SUBSCRIPTION_PATH);
    expect(more).toHaveLength(0);
    expectSessionHeaders(read);
    cleanup();

    // The billing page of a finance member: one getSubscription for the layout's banner and the page together.
    routesAs("finance", { [`GET ${SUBSCRIPTION_PATH}`]: () => json(endsSoon, 200) }, ending);
    fetchMock.mockClear();
    await openBilling();
    expect(notices().querySelector("[data-days-left]")?.textContent).toBe(
      TENANT_BANNER_STRINGS.trialDaysLeft(5),
    );
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(1);
    // The subscription's own trial_ending notice is the banner's, so the page does not repeat it.
    expect(document.querySelectorAll('[data-notice="trial_ending"]')).toHaveLength(1);
    cleanup();

    // After the end the words still hold, and no number is given.
    routesAs(
      "owner",
      {
        [`GET ${SUBSCRIPTION_PATH}`]: () =>
          json(manualTrial({ trialEndsAt: daysFromStart(-2), status: "past_due" }), 200),
      },
      ending,
    );
    await openOtherPage("overview");
    expect(notices().querySelector('[data-notice="trial_ending"]')?.textContent).toContain(
      TENANT_BANNER_STRINGS.trialEndingTitle,
    );
    expect(notices().querySelector("[data-days-left]")).toBeNull();
    cleanup();

    // Agents never read the subscription: the notice without a number, and no call.
    routesAs("agent", {}, ending);
    fetchMock.mockClear();
    await openOtherPage("overview");
    expect(notices().querySelector('[data-notice="trial_ending"]')).not.toBeNull();
    expect(notices().querySelector("[data-days-left]")).toBeNull();
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(0);
    cleanup();

    // A subscription that cannot be read leaves the notice without a number.
    routesAs("owner", { [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) }, ending);
    await openOtherPage("overview");
    expect(notices().querySelector('[data-notice="trial_ending"]')).not.toBeNull();
    expect(notices().querySelector("[data-days-left]")).toBeNull();
  });

  it("counts the days left up to the end, and none once the end is past or unknown", () => {
    const now = START;
    expect(trialDaysLeft(new Date(now + 4.5 * DAY_MS).toISOString(), now)).toBe(5);
    expect(trialDaysLeft(new Date(now + 2 * 3_600_000).toISOString(), now)).toBe(1);
    expect(trialDaysLeft(new Date(now + 14 * DAY_MS).toISOString(), now)).toBe(14);
    for (const value of [
      new Date(now).toISOString(),
      new Date(now - DAY_MS).toISOString(),
      "not a date",
      null,
      undefined,
    ]) {
      expect(trialDaysLeft(value, now)).toBeUndefined();
    }
    expect(TENANT_BANNER_STRINGS.trialDaysLeft(1)).toBe("The trial ends within a day.");
    expect(TENANT_BANNER_STRINGS.trialDaysLeft(5)).toBe("The trial ends in 5 days.");

    render(
      <TenantBanner
        tenant={{
          id: TENANT_ID,
          status: "active",
          suspensionReason: null,
          billingNotice: "trial_ending",
          storefrontEnvironment: "live",
        }}
        role="owner"
        trialEndsAt={new Date(now + 2 * DAY_MS).toISOString()}
        now={now}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(TENANT_BANNER_STRINGS.trialDaysLeft(2));
  });
});

// ---- The actions by role and state (PF-72) -----------------------------------------------------------------------

/** The states of the subscription and what an owner is offered in each. */
const STATES: readonly {
  readonly name: string;
  readonly answer: () => Response;
  readonly choose: boolean;
  readonly manage: boolean;
}[] = [
  { name: "a manual trial", answer: () => json(manualTrial(), 200), choose: true, manage: false },
  {
    name: "a manual trial that ended",
    answer: () => json(manualTrial({ status: "past_due", trialEndsAt: daysFromStart(-3) }), 200),
    choose: true,
    manage: false,
  },
  {
    name: "a manual subscription billed outside Stripe",
    answer: () => json(manualTrial({ status: "active", trialEndsAt: null }), 200),
    choose: false,
    manage: false,
  },
  {
    name: "an active Stripe subscription",
    answer: () => json(stripeSubscription(), 200),
    choose: false,
    manage: true,
  },
  {
    name: "a past_due Stripe subscription",
    answer: () => json(stripeSubscription({ status: "past_due" }), 200),
    choose: false,
    manage: true,
  },
  {
    name: "a canceled Stripe subscription",
    answer: () => json(stripeSubscription({ status: "canceled", banner: "canceled" }), 200),
    choose: true,
    manage: true,
  },
  {
    name: "an abandoned Checkout",
    answer: () => json(stripeSubscription({ status: "incomplete_expired" }), 200),
    choose: true,
    manage: true,
  },
  { name: "no subscription", answer: () => apiError("NOT_FOUND", 404), choose: true, manage: false },
];

describe("/otas/[tenantId]/billing: the actions", () => {
  it.each(STATES)(
    "[PFE-021 AC1] offers owners the actions of $name, and finance members neither [PF-72 AC1]",
    async (state) => {
      routesAs("owner", { [`GET ${SUBSCRIPTION_PATH}`]: state.answer });
      await openBilling();
      const choose = section("choose-plan");
      const manage = section("manage-in-stripe");
      expect(choose !== null).toBe(state.choose);
      expect(manage !== null).toBe(state.manage);
      if (state.choose) {
        expect(
          within(choose as HTMLElement).getByRole("button", { name: BILLING_STRINGS.continueToPayment }),
        ).toBeTruthy();
        expect(calls("GET", PLANS_PATH)).toHaveLength(1);
      } else {
        expect(calls("GET", PLANS_PATH)).toHaveLength(0);
      }
      if (state.manage) {
        expect(
          within(manage as HTMLElement).getByRole("button", { name: BILLING_STRINGS.manageInStripe }),
        ).toBeTruthy();
      }
      expect(document.querySelector('[data-notice="owner-only"]')).toBeNull();
      cleanup();

      routesAs("finance", { [`GET ${SUBSCRIPTION_PATH}`]: state.answer });
      fetchMock.mockClear();
      await openBilling();
      expect(section("choose-plan")).toBeNull();
      expect(section("manage-in-stripe")).toBeNull();
      expect(screen.queryByRole("button", { name: BILLING_STRINGS.continueToPayment })).toBeNull();
      expect(screen.queryByRole("button", { name: BILLING_STRINGS.manageInStripe })).toBeNull();
      expect(calls("GET", PLANS_PATH)).toHaveLength(0);
      // Where an owner acts, finance members read who does; they read the invoices all the same.
      expect(document.querySelector('[data-notice="owner-only"]')?.textContent ?? null).toBe(
        state.choose || state.manage ? BILLING_STRINGS.ownerOnly : null,
      );
      expect(section("invoices")).not.toBeNull();
    },
  );

  it("offers no plan before M5: the manual trial says paid plans arrive soon, and no invoice or plan is read", async () => {
    routes({ [`GET ${ME_PATH}`]: () => json(account({ stripeBilling: false }), 200) });
    await openBilling();
    expect(section("choose-plan")).toBeNull();
    expect(section("invoices")).toBeNull();
    expect(screen.getByRole("region", { name: BILLING_STRINGS.manualTrialTitle })).toBeTruthy();
    expect(calls("GET", PLANS_PATH)).toHaveLength(0);
    expect(calls("GET", INVOICES_PATH)).toHaveLength(0);
    cleanup();

    // A failed getMe leaves the switch off; the subscription still shows.
    routes({ [`GET ${ME_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openBilling();
    expect(section("choose-plan")).toBeNull();
    expect(screen.getByRole("region", { name: BILLING_STRINGS.subscriptionTitle })).toBeTruthy();
    cleanup();

    // From M5 the manual trial's note gives way to the plan choice.
    routes();
    await openBilling();
    expect(screen.queryByRole("region", { name: BILLING_STRINGS.manualTrialTitle })).toBeNull();
    expect(section("choose-plan")).not.toBeNull();
  });

  it("lists the plans Stripe Checkout can start under the Annual billing switch, from listPlans without an access token", async () => {
    await openBilling();
    const form = chooseForm();
    // Early access has no Stripe price: it is not offered here.
    expect(
      within(form)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["growth", "scale"]);
    expect(planRadio("Growth").textContent).toBe("");
    expect(planRadio("Growth").closest("div")?.textContent).toContain(
      formatMoney({ amount: "49.00", currency: "EUR" }),
    );
    expect(planRadio("Scale").disabled).toBe(false);

    // Annual billing: Scale bills monthly only, so it is shown disabled with the reason.
    fireEvent.click(within(form).getByRole("switch", { name: WIZARD_STRINGS.annualBilling }));
    expect(planRadio("Scale").disabled).toBe(true);
    expect(planRadio("Scale").closest("div")?.textContent).toContain(WIZARD_STRINGS.planNotOffered("year"));
    expect(planRadio("Growth").closest("div")?.textContent).toContain(
      formatMoney({ amount: "490.00", currency: "EUR" }),
    );

    // listPlans is public: no access token, the end-user headers.
    const [request] = calls("GET", PLANS_PATH);
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
    expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
    cleanup();

    // No plan to offer: the form says why and has no button.
    routes({ [`GET ${PLANS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openBilling();
    expect(section("choose-plan")?.textContent).toContain(BILLING_STRINGS.plansUnavailable);
    expect(screen.queryByRole("button", { name: BILLING_STRINGS.continueToPayment })).toBeNull();
    cleanup();
    routes({ [`GET ${PLANS_PATH}`]: () => json({ data: [plans()[0]] }, 200) });
    await openBilling();
    expect(section("choose-plan")?.textContent).toContain(BILLING_STRINGS.noPlans);
    expect(screen.queryByRole("button", { name: BILLING_STRINGS.continueToPayment })).toBeNull();
  });

  it("asks for a plan without a call, then sends the chosen plan and interval with the page's Idempotency-Key", async () => {
    routes({ [`POST ${CHECKOUT_PATH}`]: () => apiError("PLAN_NOT_AVAILABLE", 422) });
    await openBilling();
    const form = chooseForm();
    fireEvent.submit(form);
    expect(within(form).getByText(BILLING_STRINGS.planRequired)).toBeTruthy();
    expect(calls("POST", CHECKOUT_PATH)).toHaveLength(0);

    fireEvent.click(within(form).getByRole("switch", { name: WIZARD_STRINGS.annualBilling }));
    fireEvent.click(planRadio("Growth"));
    expect(within(form).queryByText(BILLING_STRINGS.planRequired)).toBeNull();
    fireEvent.submit(form);

    await waitFor(() => expect(calls("POST", CHECKOUT_PATH)).toHaveLength(1), ACTION_WAIT);
    const [request] = calls("POST", CHECKOUT_PATH);
    expectSessionHeaders(request);
    expect(request?.headers.get("idempotency-key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await request?.clone().json()).toEqual({ planCode: "growth", billingInterval: "year" });
    // The refusal shows at the plans, in the portal's words.
    await waitFor(
      () => expect(within(form).getByText(BILLING_STRINGS.checkoutFailures.planNotAvailable)).toBeTruthy(),
      ACTION_WAIT,
    );
    expect(document.body.textContent).not.toContain(RAW_API_MESSAGE);
  });

  it("shows a refused Checkout in the portal's words, with a reload where the page is out of date", async () => {
    routes({
      [`POST ${CHECKOUT_PATH}`]: () =>
        apiError("CONFLICT", 409, { details: { reason: "stripe_subscription_active" } }),
    });
    await openBilling();
    const form = chooseForm();
    fireEvent.click(planRadio("Growth"));
    fireEvent.submit(form);
    const problem = await within(form).findByRole("alert", {}, ACTION_WAIT);
    expect(problem.textContent).toBe(BILLING_STRINGS.checkoutFailures.subscriptionActive);
    expect(problem.getAttribute("data-checkout-problem")).toBe("CONFLICT");
    expect(within(form).getByRole("link", { name: BILLING_STRINGS.reload }).getAttribute("href")).toBe(
      BILLING_PAGE,
    );
    expect(document.body.textContent).not.toContain(RAW_API_MESSAGE);
  });

  it("answers each refusal of createCheckoutSession with the portal's words", async () => {
    const F = BILLING_STRINGS.checkoutFailures;
    const cases: [Response, Partial<ChoosePlanState>][] = [
      [apiError("FEATURE_DISABLED", 403), { message: F.featureDisabled, reload: true }],
      [apiError("PLAN_NOT_AVAILABLE", 422), { fieldErrors: { planCode: F.planNotAvailable } }],
      [
        apiError("CONFLICT", 409, { details: { reason: "stripe_subscription_active" } }),
        { message: F.subscriptionActive, reload: true },
      ],
      [apiError("CONFLICT", 409), { message: F.conflict, reload: true }],
      [apiError("IDEMPOTENCY_KEY_REUSED", 409), { message: F.formExpired, reload: true }],
      [apiError("FORBIDDEN", 403), { message: F.forbidden, reload: true }],
      [apiError("NOT_FOUND", 404), { message: F.notFound, reload: true }],
      [apiError("PROVIDER_ERROR", 502), { message: F.unavailable }],
      [apiError("SERVICE_UNAVAILABLE", 503), { message: F.unavailable }],
      [apiError("RATE_LIMITED", 429, {}, { "retry-after": "30" }), { message: ERROR_MESSAGES.RATE_LIMITED }],
      [
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/planCode", code: "pattern" }] }),
        { fieldErrors: { planCode: F.planNotAvailable } },
      ],
      [
        apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [{ path: "/header/Idempotency-Key", code: "pattern" }],
        }),
        { message: F.formExpired, reload: true },
      ],
    ];
    for (const [answer, expected] of cases) {
      routes({ [`POST ${CHECKOUT_PATH}`]: () => answer.clone() });
      const state = await startCheckout(TENANT_ID, CHOOSE_IDLE, choosePlanForm());
      expect(state).toEqual({ status: "failed", code: expect.any(String), ...expected });
      expect(JSON.stringify(state)).not.toContain(RAW_API_MESSAGE);
    }
  });

  it("[PFE-021 AC1] follows exactly the https Checkout URL of the answer, and never another", async () => {
    routes({
      [`POST ${CHECKOUT_PATH}`]: () => json({ url: CHECKOUT_URL, expiresAt: daysFromStart(1) }, 201),
    });
    await expect(startCheckout(TENANT_ID, CHOOSE_IDLE, choosePlanForm())).rejects.toThrow(
      `NEXT_REDIRECT ${CHECKOUT_URL}`,
    );
    expect(navigation.redirect).toHaveBeenCalledWith(CHECKOUT_URL);

    for (const url of [
      "http://checkout.stripe.com/c/pay/cs_test_pfe021",
      "javascript:alert(1)",
      "https://user:secret@checkout.stripe.com/c/pay/cs_test_pfe021",
      "/otas/elsewhere",
    ]) {
      routes({ [`POST ${CHECKOUT_PATH}`]: () => json({ url, expiresAt: daysFromStart(1) }, 201) });
      navigation.redirect.mockClear();
      expect(await startCheckout(TENANT_ID, CHOOSE_IDLE, choosePlanForm())).toEqual({
        status: "failed",
        code: "INTERNAL_ERROR",
        message: BILLING_STRINGS.checkoutFailures.unavailable,
      });
      expect(navigation.redirect).not.toHaveBeenCalled();
    }

    // A form that is not the page's makes no call: no key, no interval, no plan, no OTA.
    fetchMock.mockClear();
    for (const [tenantId, form] of [
      [TENANT_ID, choosePlanForm({ idempotencyKey: "" })],
      [TENANT_ID, choosePlanForm({ billingInterval: "week" })],
      [TENANT_ID, choosePlanForm({ planCode: "" })],
      ["ten_not-an-ota", choosePlanForm()],
    ] as const) {
      const state = await startCheckout(tenantId, CHOOSE_IDLE, form);
      expect(state.status).toBe("failed");
    }
    expect(await startCheckout(TENANT_ID, CHOOSE_IDLE, choosePlanForm({ planCode: "" }))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      fieldErrors: { planCode: BILLING_STRINGS.planRequired },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // An ended session signs in again and comes back to the billing page.
    routes({ [`POST ${CHECKOUT_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(startCheckout(TENANT_ID, CHOOSE_IDLE, choosePlanForm())).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fbilling`,
    );
  });

  it("[PFE-021 AC1] Manage in Stripe opens the Customer Portal of the answer's URL for owners [PF-72 AC1]", async () => {
    routes({
      [`POST ${PORTAL_PATH}`]: () => json({ url: PORTAL_URL }, 201, { "cache-control": "no-store" }),
    });
    await expect(openCustomerPortal(TENANT_ID, PORTAL_IDLE, new FormData())).rejects.toThrow(
      `NEXT_REDIRECT ${PORTAL_URL}`,
    );
    const [request] = calls("POST", PORTAL_PATH);
    expectSessionHeaders(request);

    const P = BILLING_STRINGS.portalFailures;
    const cases: [Response, Partial<PortalState>][] = [
      [
        apiError("CONFLICT", 409, { details: { reason: "no_stripe_customer" } }),
        { message: P.noCustomer, reload: true },
      ],
      [apiError("FEATURE_DISABLED", 403), { message: P.featureDisabled, reload: true }],
      [apiError("FORBIDDEN", 403), { message: P.forbidden, reload: true }],
      [apiError("NOT_FOUND", 404), { message: P.notFound, reload: true }],
      [apiError("PROVIDER_ERROR", 502), { message: P.unavailable }],
      [apiError("RATE_LIMITED", 429), { message: ERROR_MESSAGES.RATE_LIMITED }],
      [json({ url: "http://billing.stripe.com/p/session/test_pfe021" }, 201), { message: P.unavailable }],
    ];
    for (const [answer, expected] of cases) {
      routes({ [`POST ${PORTAL_PATH}`]: () => answer.clone() });
      const state = await openCustomerPortal(TENANT_ID, PORTAL_IDLE, new FormData());
      expect(state).toEqual({ status: "failed", code: expect.any(String), ...expected });
    }
    fetchMock.mockClear();
    expect((await openCustomerPortal("ten_not-an-ota", PORTAL_IDLE, new FormData())).status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();

    // The page's button: a refusal shows under it, with a reload.
    routes({
      [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripeSubscription(), 200),
      [`POST ${PORTAL_PATH}`]: () => apiError("CONFLICT", 409, { details: { reason: "no_stripe_customer" } }),
    });
    await openBilling();
    const manage = section("manage-in-stripe") as HTMLElement;
    fireEvent.click(within(manage).getByRole("button", { name: BILLING_STRINGS.manageInStripe }));
    const problem = await within(manage).findByRole("alert", {}, ACTION_WAIT);
    expect(problem.textContent).toBe(P.noCustomer);
    expect(within(manage).getByRole("link", { name: BILLING_STRINGS.reload })).toBeTruthy();
  });
});

// ---- The invoices (PF-73) ----------------------------------------------------------------------------------------

describe("/otas/[tenantId]/billing: the invoices", () => {
  it.each<TenantRole>(["owner", "finance"])(
    "[PFE-021 AC2] lists number, period, total, status and the Stripe links of each invoice (role: %s) [PF-73 AC2]",
    async (role) => {
      routesAs(role, { [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripeSubscription(), 200) });
      await openBilling();
      const rows = invoiceRows();
      expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
        "VX-2027-000184",
        "VX-2027-000150",
        "VX-2027-000149",
      ]);
      const [paid, open, draft] = rows as [HTMLElement, HTMLElement, HTMLElement];
      const cells = (row: HTMLElement) => within(row).getAllByRole("cell");

      // The billed period: its days in the OTA's time zone, the API's instants in <time>.
      const [first, last] = [...(cells(paid)[1]?.querySelectorAll("time") ?? [])];
      const [paidInvoice] = invoices() as [Invoice];
      expect(first?.getAttribute("dateTime")).toBe(paidInvoice.periodStart);
      expect(last?.getAttribute("dateTime")).toBe(paidInvoice.periodEnd);
      expect(cells(paid)[1]?.textContent).toBe(
        `${formatDateTime(paidInvoice.periodStart ?? "", { mode: "date", timeZone: TIME_ZONE })}${BILLING_STRINGS.periodTo}${formatDateTime(paidInvoice.periodEnd ?? "", { mode: "date", timeZone: TIME_ZONE })}`,
      );
      expect(cells(draft)[1]?.textContent).toBe(BILLING_STRINGS.noPeriod);

      // The totals with Money, from the API's decimal strings: 5000 JPY has no decimals, 49.00 EUR two.
      expect(cells(paid)[2]?.querySelector("data")?.getAttribute("value")).toBe("5000");
      expect(cells(paid)[2]?.textContent).toBe(formatMoney({ amount: "5000", currency: "JPY" }));
      expect(cells(paid)[2]?.textContent).toContain("5,000");
      expect(cells(open)[2]?.querySelector("data")?.getAttribute("value")).toBe("49.00");
      expect(cells(open)[2]?.textContent).toBe("€49.00");
      expect(cells(draft)[2]?.textContent).toBe("€1,290.50");

      // The status in words.
      expect(cells(paid)[3]?.textContent).toBe(STATUS_LABELS.invoice.paid);
      expect(cells(open)[3]?.textContent).toBe(STATUS_LABELS.invoice.open);
      expect(cells(draft)[3]?.textContent).toBe(STATUS_LABELS.invoice.draft);
      expect(cells(paid)[3]?.querySelector("[data-status]")?.getAttribute("data-status")).toBe("paid");

      // Stripe's invoice page and PDF, in a new tab without an opener or a referrer.
      const view = within(paid).getByRole("link", { name: /^View invoice VX-2027-000184/ });
      expect(view.getAttribute("href")).toBe(HOSTED_URL);
      expect(view.getAttribute("target")).toBe("_blank");
      expect(view.getAttribute("rel")).toBe("noopener noreferrer");
      expect(view.textContent).toContain("opens Stripe in a new tab");
      const pdf = within(paid).getByRole("link", { name: /^Download PDF VX-2027-000184/ });
      expect(pdf.getAttribute("href")).toBe(PDF_URL);
      expect(pdf.getAttribute("rel")).toBe("noopener noreferrer");
      // An http: PDF link is never offered; a javascript: page link neither.
      expect(
        within(open)
          .getAllByRole("link")
          .map((link) => link.getAttribute("href")),
      ).toEqual([`${HOSTED_URL}2`]);
      expect(within(draft).queryByRole("link")).toBeNull();
      expect(cells(draft)[4]?.textContent).toBe(BILLING_STRINGS.noLinks);

      const [request, ...more] = calls("GET", INVOICES_PATH);
      expect(more).toHaveLength(0);
      expectSessionHeaders(request);
    },
  );

  it("says when there is no invoice yet, and shows the portal's message when they cannot be loaded", async () => {
    routes({ [`GET ${INVOICES_PATH}`]: () => json({ data: [] }, 200) });
    await openBilling();
    expect(within(section("invoices") as HTMLElement).getByText(BILLING_STRINGS.invoicesEmpty)).toBeTruthy();
    cleanup();

    routes({ [`GET ${INVOICES_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openBilling();
    const alert = within(section("invoices") as HTMLElement).getByRole("alert");
    expect(alert.textContent).toContain(BILLING_STRINGS.invoicesUnavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(document.body.textContent).not.toContain(RAW_API_MESSAGE);
    // The rest of the page stays.
    expect(screen.getByRole("region", { name: BILLING_STRINGS.subscriptionTitle })).toBeTruthy();
    expect(section("choose-plan")).not.toBeNull();
    cleanup();

    // A Stripe subscription's invoices show even with the switch off.
    routes({
      [`GET ${ME_PATH}`]: () => json(account({ stripeBilling: false }), 200),
      [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripeSubscription(), 200),
    });
    await openBilling();
    expect(invoiceRows()).toHaveLength(3);
  });
});

// ---- Back from Stripe (PFE-021 note of 2026-11-03) ----------------------------------------------------------------

describe("/otas/[tenantId]/billing: back from Stripe", () => {
  it("?checkout=canceled shows a neutral notice and keeps the plan choice", async () => {
    await openBilling({ checkout: "canceled" });
    const notice = document.querySelector<HTMLElement>('[data-checkout="canceled"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toBe(BILLING_STRINGS.checkoutCanceled);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(section("choose-plan")).not.toBeNull();
    cleanup();

    // Any other value of the query shows nothing.
    await openBilling({ checkout: "<script>alert(1)</script>" });
    expect(document.querySelector("[data-checkout]")).toBeNull();
    expect(checkoutReturnOf({ checkout: ["success", "canceled"] })).toBeUndefined();
  });

  it("?checkout=success confirms the payment, reading the subscription every 2 seconds until it is Stripe's, then renders the page again", async () => {
    routes({
      [`GET ${SUBSCRIPTION_PATH}`]: sequence(
        () => json(manualTrial(), 200), // the page
        () => json(manualTrial(), 200), // the first read: the webhook has not arrived
        () => apiError("RATE_LIMITED", 429, {}, { "retry-after": "5" }),
        () => json(stripeSubscription({ status: "trialing", trialEndsAt: daysFromStart(14) }), 200),
      ),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await openBilling({ checkout: "success" });

    // No success yet: the payment is being confirmed, and no plan can be chosen meanwhile.
    const notice = document.querySelector<HTMLElement>('[data-checkout="confirming"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain(BILLING_STRINGS.checkoutConfirming);
    expect(section("choose-plan")).toBeNull();
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS);
    });
    await eventually(() => expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(2));
    expectSessionHeaders(calls("GET", SUBSCRIPTION_PATH)[1]);

    // One read at a time: the rate limit's answer comes next, and its Retry-After is waited out with a note.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS);
    });
    await eventually(() => expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(3));
    await eventually(() =>
      expect(document.querySelector("[data-poll-note]")?.textContent).toBe(BILLING_STRINGS.pollFailed),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS);
    });
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 - CHECKOUT_POLL_INTERVAL_MS);
    });
    await eventually(() => expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(4));

    // The Stripe subscription arrived: the page is rendered again, and reading stops.
    await eventually(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-checkout="confirmed"]')?.textContent).toContain(
      BILLING_STRINGS.checkoutConfirmed,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS * 3);
    });
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(4);
  });

  it("?checkout=success with a confirmed subscription shows it, and leads an OTA whose set-up starts again to its set-up page", async () => {
    routesAs(
      "owner",
      { [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripeSubscription({ status: "trialing" }), 200) },
      { status: "provisioning", activatedAt: null },
    );
    await openBilling({ checkout: "success" });
    const notice = document.querySelector<HTMLElement>('[data-checkout="confirmed"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain(BILLING_STRINGS.checkoutConfirmed);
    expect(notice?.textContent).toContain(BILLING_STRINGS.checkoutSetup);
    expect(
      within(notice as HTMLElement)
        .getByRole("link", { name: BILLING_STRINGS.setupLink })
        .getAttribute("href"),
    ).toBe(`/otas/${TENANT_ID}/setup`);
    expect(document.querySelector('[data-checkout="confirming"]')).toBeNull();
    expect(screen.getByRole("region", { name: BILLING_STRINGS.subscriptionTitle }).textContent).toContain(
      "Growth",
    );
    cleanup();

    // An active OTA has no set-up to follow.
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripeSubscription(), 200) });
    await openBilling({ checkout: "success" });
    expect(document.querySelector('[data-checkout="confirmed"]')?.textContent).not.toContain(
      BILLING_STRINGS.checkoutSetup,
    );
    expect(isConfirmedSubscription(stripeSubscription({ status: "past_due" }))).toBe(false);
    expect(isConfirmedSubscription(manualTrial())).toBe(false);
  });

  it("stops following on a refusal with the portal's message, and an ended session signs in again", async () => {
    routes({
      [`GET ${SUBSCRIPTION_PATH}`]: sequence(
        () => json(manualTrial(), 200),
        () => apiError("FORBIDDEN", 403),
      ),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await openBilling({ checkout: "success" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS);
    });
    await eventually(() =>
      expect(document.querySelector("[data-poll-stopped]")?.textContent).toContain(ERROR_MESSAGES.FORBIDDEN),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS * 3);
    });
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(2);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(RAW_API_MESSAGE);
    vi.useRealTimers();

    // The read itself: no subscription yet is not confirmed; a rate limit may pass; the session's end signs in again.
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("NOT_FOUND", 404) });
    expect(await getCheckoutSync(TENANT_ID)).toEqual({ status: "ok", confirmed: false });
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("RATE_LIMITED", 429, {}, { "retry-after": "7" }) });
    expect(await getCheckoutSync(TENANT_ID)).toEqual({
      status: "failed",
      code: "RATE_LIMITED",
      message: ERROR_MESSAGES.RATE_LIMITED,
      transient: true,
      retryAfterSeconds: 7,
    });
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(getCheckoutSync(TENANT_ID)).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fbilling`,
    );
    fetchMock.mockClear();
    expect((await getCheckoutSync("ten_not-an-ota")).status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads one at a time: no read starts while an answer is awaited, and none once the confirmation goes away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answer: (result: CheckoutSyncPoll) => void = () => undefined;
    const { poll, reads } = pollOf(
      () =>
        new Promise<CheckoutSyncPoll>((resolve) => {
          answer = resolve;
        }),
      () => Promise.resolve({ status: "ok", confirmed: false }),
    );
    const view = render(<CheckoutConfirmation poll={poll} />);

    await advance(CHECKOUT_POLL_INTERVAL_MS - 1);
    expect(reads()).toBe(0);
    await advance(1);
    expect(reads()).toBe(1);
    // The answer takes longer than the interval: no second read meanwhile.
    await advance(5 * CHECKOUT_POLL_INTERVAL_MS);
    expect(reads()).toBe(1);
    await act(async () => {
      answer({ status: "ok", confirmed: false });
      await Promise.resolve();
    });
    // The next read comes 2 seconds after the answer.
    await advance(CHECKOUT_POLL_INTERVAL_MS - 1);
    expect(reads()).toBe(1);
    await advance(1);
    expect(reads()).toBe(2);

    view.unmount();
    await advance(10 * CHECKOUT_POLL_INTERVAL_MS);
    expect(reads()).toBe(2);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("keeps reading through an unavailable API and the portal out of reach, with a note, and goes where an ended session's redirect() goes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { poll, reads } = pollOf(
      () =>
        Promise.resolve({
          status: "failed",
          code: "SERVICE_UNAVAILABLE",
          message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
          transient: true,
        }),
      () => Promise.reject(new Error("fetch failed")),
      () => Promise.resolve({ status: "ok", confirmed: false }),
      () => Promise.reject(new Error(`NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fbilling`)),
    );
    render(
      <RedirectBoundary>
        <CheckoutConfirmation poll={poll} />
      </RedirectBoundary>,
    );
    const note = () => document.querySelector("[data-poll-note]")?.textContent ?? null;

    // An unavailable API: a note, and the next read 2 seconds later.
    await advance(CHECKOUT_POLL_INTERVAL_MS);
    expect(reads()).toBe(1);
    expect(note()).toBe(BILLING_STRINGS.pollFailed);
    await advance(CHECKOUT_POLL_INTERVAL_MS - 1);
    expect(reads()).toBe(1);
    await advance(1);
    // The portal itself out of reach: the note stays, and reading goes on.
    expect(reads()).toBe(2);
    expect(note()).toBe(BILLING_STRINGS.pollFailed);
    await advance(CHECKOUT_POLL_INTERVAL_MS);
    // An answer again: the note goes, the confirmation goes on, nothing stopped.
    expect(reads()).toBe(3);
    expect(note()).toBeNull();
    expect(document.querySelector('[data-checkout="confirming"]')).not.toBeNull();
    expect(document.querySelector("[data-poll-stopped]")).toBeNull();

    // The session ended: the router goes where the action's redirect() goes, and no read follows.
    await advance(CHECKOUT_POLL_INTERVAL_MS);
    expect(document.querySelector("[data-redirected]")?.textContent).toBe(
      `/sign-in?next=%2Fotas%2F${TENANT_ID}%2Fbilling`,
    );
    await advance(10 * CHECKOUT_POLL_INTERVAL_MS);
    expect(reads()).toBe(4);
    expect(router.refresh).not.toHaveBeenCalled();
    vi.useRealTimers();

    // The action words an unavailable API and an internal error as reads that may pass.
    for (const [answer, code] of [
      [apiError("SERVICE_UNAVAILABLE", 503), "SERVICE_UNAVAILABLE"],
      [apiError("INTERNAL_ERROR", 500), "INTERNAL_ERROR"],
    ] as const) {
      routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => answer.clone() });
      expect(await getCheckoutSync(TENANT_ID)).toEqual({
        status: "failed",
        code,
        message: ERROR_MESSAGES[code],
        transient: true,
      });
    }
  });

  it("?checkout=success of an OTA without a subscription yet confirms without telling it to contact support", async () => {
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("NOT_FOUND", 404) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await openBilling({ checkout: "success" });
    expect(document.querySelector('[data-checkout="confirming"]')).not.toBeNull();
    expect(document.querySelector('[data-notice="no-subscription"]')).toBeNull();
    expect(document.body.textContent).not.toContain(BILLING_STRINGS.none);
    expect(section("choose-plan")).toBeNull();
    cleanup();
    vi.useRealTimers();

    // Without the way back from Stripe, the page says that there is no subscription.
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await openBilling();
    expect(document.querySelector('[data-notice="no-subscription"]')?.textContent).toBe(BILLING_STRINGS.none);
  });

  it("the set-up page sends Stripe's success URL of an OTA that is not in set-up on to the billing page", async () => {
    const openSetup = () =>
      SetupPage({ params: params(), searchParams: Promise.resolve({ checkout: "success" }) });

    // An OTA failed by an abandoned Checkout and paid from the billing page: the billing page confirms the payment.
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed", activatedAt: null }), 200),
      [`GET ${PROVISIONING_PATH}`]: () =>
        json(
          provisioning({
            tenantStatus: "failed",
            job: { ...provisioning().job, status: "canceled", attempt: 0, step: null },
          }),
          200,
        ),
    });
    await expect(openSetup()).rejects.toThrow(`NEXT_REDIRECT ${BILLING_PAGE}?checkout=success`);

    // An active OTA that chose a plan on the billing page likewise.
    routes();
    await expect(openSetup()).rejects.toThrow(`NEXT_REDIRECT ${BILLING_PAGE}?checkout=success`);

    // A new OTA whose test keys wait for their reveal, an OTA in set-up and a role without billing stay.
    for (const [overrides, role] of [
      [
        { [`GET ${PROVISIONING_PATH}`]: () => json(provisioning({ initialKeysAvailable: true }), 200) },
        "owner",
      ],
      [
        {
          [`GET ${PROVISIONING_PATH}`]: () =>
            json(
              provisioning({
                tenantStatus: "provisioning",
                job: { ...provisioning().job, status: "queued", attempt: 0, step: null },
              }),
              200,
            ),
          [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripeSubscription({ status: "incomplete" }), 200),
        },
        "owner",
      ],
      [{}, "agent"],
    ] as const) {
      routesAs(role, overrides);
      navigation.redirect.mockClear();
      render(await openSetup());
      expect(navigation.redirect).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

// ---- The rules and the server rendering ------------------------------------------------------------------------

describe("the billing page's rules", () => {
  it("offers a plan for a manual trial, a canceled or unpaid Checkout, never for a current Stripe subscription", () => {
    const offered = (subscription: Pick<Subscription, "billingProvider" | "status">) =>
      planChoiceOffered(subscription);
    for (const status of ["trialing", "past_due", "canceled"] as const) {
      expect(offered({ billingProvider: "manual", status })).toBe(true);
    }
    expect(offered({ billingProvider: "manual", status: "active" })).toBe(false);
    for (const status of ["canceled", "incomplete", "incomplete_expired"] as const) {
      expect(offered({ billingProvider: "stripe", status })).toBe(true);
    }
    for (const status of ["trialing", "active", "past_due", "paused", "unpaid"] as const) {
      expect(offered({ billingProvider: "stripe", status })).toBe(false);
    }
  });

  it("follows only absolute https URLs without credentials, exactly as answered", () => {
    expect(followableUrl(CHECKOUT_URL)).toBe(CHECKOUT_URL);
    expect(followableUrl(PORTAL_URL)).toBe(PORTAL_URL);
    for (const value of [
      "http://checkout.stripe.com/",
      "javascript:alert(1)",
      "data:text/html,hello",
      "https://user:secret@billing.stripe.com/",
      "//billing.stripe.com/p",
      "/otas",
      "",
      null,
      42,
    ]) {
      expect(followableUrl(value)).toBeUndefined();
    }
  });

  it("renders the billing page on the server and hydrates it without an error or a change", async () => {
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => json(stripeSubscription({ status: "canceled" }), 200) });
    const { errors, root, serverDom, container } = await serverRenderAndHydrate(await billingTree());
    try {
      expect(errors).toEqual([]);
      expect(container.innerHTML).toBe(serverDom);
      expect(within(container).getByRole("button", { name: BILLING_STRINGS.continueToPayment })).toBeTruthy();
      expect(within(container).getByRole("button", { name: BILLING_STRINGS.manageInStripe })).toBeTruthy();
      expect(within(container).getAllByRole("row")).toHaveLength(4);
    } finally {
      act(() => root.unmount());
    }
  });
});
