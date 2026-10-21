// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope, navigation and cache of Next.js and the configuration; the real API client talks ----
// ---- to a mocked fetch, so the tests see the query, the headers and the body of every call the pages and actions ---
// ---- send ------------------------------------------------------------------------------------------------------------

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

const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => nextCache);

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import PlanPage from "@/app/(app)/plans/[planCode]/page";
import { createPlan, setPlanActive, updatePlan, type PlanFormState } from "@/app/(app)/plans/actions";
import PlansPage from "@/app/(app)/plans/page";
import {
  CreatePlanForm,
  EditPlanForm,
  PlanBadge,
  PlanStatus,
  PlanStatusForm,
  PricingState,
} from "@/app/(app)/plans/plan-form";
import { ManualSubscriptionForm } from "@/app/(app)/subscriptions/[subscriptionId]/manual-subscription-form";
import SubscriptionPage from "@/app/(app)/subscriptions/[subscriptionId]/page";
import { updateManualSubscription, type ManualSubscriptionState } from "@/app/(app)/subscriptions/actions";
import SubscriptionsPage from "@/app/(app)/subscriptions/page";
import { SubscriptionTable } from "@/app/(app)/subscriptions/subscription-table";
import { FilterBar } from "@/components/filter-bar";
import * as tableComponents from "@/components/ui/table";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  ERROR_MESSAGES,
  MANUAL_SUBSCRIPTION_STRINGS,
  PLAN_DETAIL_STRINGS,
  PLAN_FORM_STRINGS,
  PLAN_LIST_STRINGS,
  PLAN_STRINGS,
  REASON_STRINGS,
  STEP_UP_STRINGS,
  SUBSCRIPTION_DETAIL_STRINGS,
  SUBSCRIPTION_LIST_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) ---------------------------------------------------

type Schemas = components["schemas"];
type AdminPlan = Schemas["AdminPlan"];
type AdminSubscription = Schemas["AdminSubscription"];

const ACCESS_TOKEN = "pad008-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-008 test)";
const PRICING_URL = "https://platform.example.com/pricing";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const OTHER_TENANT_ID = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const MANUAL_ID = "sub_01JA2Z7R5N0S3V7X1Z4B9D2F6H";
const STRIPE_ID = "sub_01JE4N7P1R5T9W3Y7A1C5E9G3J";
const PLANS_PATH = "/v1/admin/plans";
const SUBSCRIPTIONS_PATH = "/v1/admin/subscriptions";
const REASON = "Pilot extended by one month as agreed with the owner on the phone.";

/**
 * The budget of the warm-up hook: the first render of these pages in a fresh worker loads the module graph of the
 * forms, the tables, the filter bar and the dialogs, and the first server action runs React's action queue for the
 * first time. On a loaded runner that takes seconds; the hook only stops one that hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * How long a step that runs a server action (a round trip through the real `lib/api.ts`) and re-renders the forms may
 * take. Testing Library's 1 s default is enough on an idle machine, not on a loaded CI runner; each test's own 5 s
 * budget is unchanged.
 */
const UI_WAIT = { timeout: 3_000 } as const;

function adminPlan(overrides: Partial<AdminPlan> = {}): AdminPlan {
  return {
    code: "growth",
    name: "Growth",
    description: "For OTAs selling live with up to 15 staff.",
    currency: "EUR",
    monthlyPrice: { amount: "149.00", currency: "EUR" },
    annualPrice: { amount: "1490.00", currency: "EUR" },
    trialDays: 14,
    limits: { staffSeats: 15, apiKeys: 25, customDomains: 1, liveMode: true },
    features: { queues: true },
    checkoutAvailable: { month: false, year: false },
    isPublic: true,
    isActive: true,
    sortOrder: 20,
    settlementFeeBps: 150,
    stripeProductId: null,
    stripePriceIdMonth: null,
    stripePriceIdYear: null,
    priceWarnings: [],
    tenantCount: 3,
    version: 2,
    createdAt: "2026-10-18T09:30:00Z",
    updatedAt: "2026-10-19T11:02:41Z",
    ...overrides,
  };
}

/** The plans of the fleet: the free early-access plan, a public paid one and a retired private one. */
function initialPlans(): AdminPlan[] {
  return [
    adminPlan({
      code: "early_access",
      name: "Early access",
      description: "Free plan for OTAs created before paid plans open. Test mode only.",
      monthlyPrice: { amount: "0.00", currency: "EUR" },
      annualPrice: null,
      trialDays: 90,
      limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: false },
      features: {},
      sortOrder: 0,
      settlementFeeBps: 0,
      tenantCount: 17,
      version: 1,
    }),
    adminPlan(),
    adminPlan({
      code: "pilot",
      name: "Pilot",
      description: null,
      isPublic: false,
      isActive: false,
      sortOrder: 30,
      tenantCount: 1,
      version: 4,
    }),
  ];
}

function subscription(overrides: Partial<AdminSubscription> = {}): AdminSubscription {
  return {
    id: MANUAL_ID,
    tenantId: TENANT_ID,
    tenantKey: "acme",
    tenantName: "Acme Travel",
    planCode: "early_access",
    planName: "Early access",
    status: "trialing",
    billingProvider: "manual",
    billingInterval: "month",
    trialEndsAt: "2027-01-12T08:20:11Z",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    createdAt: "2026-10-14T08:20:11Z",
    version: 1,
    ...overrides,
  };
}

function stripeSubscription(): AdminSubscription {
  return subscription({
    id: STRIPE_ID,
    tenantId: OTHER_TENANT_ID,
    tenantKey: "nordic",
    tenantName: "Nordic Trips",
    planCode: "growth",
    planName: "Growth",
    status: "active",
    billingProvider: "stripe",
    trialEndsAt: null,
    currentPeriodStart: "2027-03-01T00:00:00Z",
    currentPeriodEnd: "2027-04-01T00:00:00Z",
    providerCustomerId: "cus_Qx7Lm2Np9Rt4Vw",
    providerSubscriptionId: "sub_1QxLm2Np9Rt4VwY6Za8Bc0De",
    createdAt: "2027-02-01T10:12:40Z",
    version: 4,
  });
}

const INVOICE: Schemas["AdminInvoice"] = {
  id: "inv_01JE4N8Q2S6V0X4Z8B2D6F0H4K",
  tenantId: OTHER_TENANT_ID,
  subscriptionId: STRIPE_ID,
  number: "VX-2027-000312",
  status: "paid",
  subtotal: { amount: "149.00", currency: "EUR" },
  taxAmount: { amount: "0.00", currency: "EUR" },
  total: { amount: "149.00", currency: "EUR" },
  amountPaid: { amount: "149.00", currency: "EUR" },
  amountDue: { amount: "0.00", currency: "EUR" },
  periodStart: "2027-03-01T00:00:00Z",
  periodEnd: "2027-04-01T00:00:00Z",
  issuedAt: "2027-03-01T01:04:12Z",
  dueAt: null,
  paidAt: "2027-03-01T01:04:15Z",
  hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1Velexis/test_YWNjdF8xVmVsZXhpcw",
  invoicePdfUrl: "https://pay.stripe.com/invoice/acct_1Velexis/test_YWNjdF8xVmVsZXhpcw/pdf",
  providerInvoiceId: "in_1QyMn3Oq0Su5Wx",
  createdAt: "2027-03-01T01:04:13Z",
};

/** The state the plan actions start from when a test calls them directly. */
const IDLE_PLAN_FORM: PlanFormState = {
  status: "idle",
  version: 2,
  values: {
    code: "",
    name: "",
    description: "",
    currency: "",
    monthlyPrice: "",
    annualPrice: "",
    trialDays: "",
    staffSeats: "",
    apiKeys: "",
    customDomains: "",
    liveMode: false,
    features: [],
    isPublic: false,
    sortOrder: "",
    settlementFeeBps: "",
  },
  fieldErrors: {},
};

/** The fields of a valid plan form, without its code (create) or its plan code and version (edit). */
const VALID_PLAN_FIELDS: Readonly<Record<string, string>> = {
  name: "Growth",
  currency: "EUR",
  monthlyPrice: "149.00",
  trialDays: "14",
  staffSeats: "15",
  apiKeys: "25",
  customDomains: "1",
  sortOrder: "20",
  settlementFeeBps: "150",
};

const STRIPE_EVENT: Schemas["AdminStripeEvent"] = {
  id: "evt_1QyMn3Oq0Su5WxZ7Ab9Cd1Ef",
  endpoint: "billing",
  type: "invoice.paid",
  status: "processed",
  attempts: 1,
  lastError: null,
  tenantId: OTHER_TENANT_ID,
  receivedAt: "2027-03-01T01:04:16Z",
  processedAt: "2027-03-01T01:04:18Z",
};

// ---- The mocked platform API: a small in-memory platform that keeps what the actions change -------------------------

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
  details?: Record<string, unknown>,
  fieldErrors?: { path: string; code: string }[],
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pad008",
        ...(details === undefined ? {} : { details }),
        ...(fieldErrors === undefined ? {} : { fieldErrors }),
      },
    },
    status,
    headers,
  );
}

/** The plans and subscriptions as the API holds them; each test starts from the same fleet. */
const fleet = {
  plans: initialPlans(),
  subscriptions: [subscription(), stripeSubscription()],
};

function resetFleet(): void {
  fleet.plans = initialPlans();
  fleet.subscriptions = [subscription(), stripeSubscription()];
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  return (await request.clone().json()) as Record<string, unknown>;
}

/** `adminCreatePlan`: an active plan from the request, as the API stores it (`409 code_taken` for a used code). */
async function createRoute(request: Request): Promise<Response> {
  const body = (await bodyOf(request)) as Schemas["CreatePlanRequest"];
  if (fleet.plans.some((plan) => plan.code === body.code)) {
    return apiError("CONFLICT", 409, { reason: "code_taken" });
  }
  const created = adminPlan({
    code: body.code,
    name: body.name,
    description: body.description ?? null,
    currency: body.currency,
    monthlyPrice: body.monthlyPrice,
    annualPrice: body.annualPrice ?? null,
    trialDays: body.trialDays,
    limits: body.limits,
    features: body.features,
    isPublic: body.isPublic,
    isActive: true,
    sortOrder: body.sortOrder,
    settlementFeeBps: body.settlementFeeBps,
    tenantCount: 0,
    version: 1,
  });
  fleet.plans.push(created);
  return json(created, 201, { etag: '"1"' });
}

/** `adminUpdatePlan`: the fields of the request, a new version, `412` for a stale `If-Match`. */
async function updateRoute(request: Request): Promise<Response> {
  const code = new URL(request.url).pathname.split("/").at(-1);
  const index = fleet.plans.findIndex((plan) => plan.code === code);
  const current = fleet.plans[index];
  if (current === undefined) {
    return apiError("NOT_FOUND", 404);
  }
  if (request.headers.get("if-match") !== `"${current.version}"`) {
    return apiError("PRECONDITION_FAILED", 412);
  }
  const updated: AdminPlan = { ...current, ...(await bodyOf(request)), version: current.version + 1 };
  fleet.plans[index] = updated;
  return json(updated, 200, { etag: `"${updated.version}"` });
}

/** `adminUpdateManualSubscription`, with the rules of the platform document. */
async function updateSubscriptionRoute(request: Request): Promise<Response> {
  const id = new URL(request.url).pathname.split("/").at(-1);
  const index = fleet.subscriptions.findIndex((row) => row.id === id);
  const current = fleet.subscriptions[index];
  if (current === undefined) {
    return apiError("NOT_FOUND", 404);
  }
  if (request.headers.get("if-match") !== `"${current.version}"`) {
    return apiError("PRECONDITION_FAILED", 412);
  }
  if (current.billingProvider !== "manual") {
    return apiError("CONFLICT", 409, { reason: "stripe_billed" });
  }
  const body = (await bodyOf(request)) as Schemas["UpdateManualSubscriptionRequest"];
  let next: AdminSubscription = { ...current, version: current.version + 1 };
  if (body.planCode !== undefined) {
    const plan = fleet.plans.find((candidate) => candidate.code === body.planCode && candidate.isActive);
    if (plan === undefined) {
      return apiError("UNPROCESSABLE", 422, { reason: "plan_not_active" });
    }
    next = { ...next, planCode: plan.code, planName: plan.name };
  }
  if (body.trialEndsAt !== undefined) {
    next = { ...next, trialEndsAt: body.trialEndsAt };
  }
  if (body.status !== undefined) {
    next = {
      ...next,
      status: body.status,
      canceledAt: body.status === "canceled" ? "2026-10-21T10:00:00Z" : null,
    };
  }
  fleet.subscriptions[index] = next;
  return json(next, 200, { etag: `"${next.version}"` });
}

function subscriptionDetail(id: string): Response {
  const row = fleet.subscriptions.find((candidate) => candidate.id === id);
  if (row === undefined) {
    return apiError("NOT_FOUND", 404);
  }
  const stripe = row.billingProvider === "stripe";
  return json(
    { subscription: row, invoices: stripe ? [INVOICE] : [], events: stripe ? [STRIPE_EVENT] : [] },
    200,
    { etag: `"${row.version}"` },
  );
}

/** The list as the API answers it: newest first, filtered by `status`, `provider` and `planCode`. */
function listSubscriptions(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const data = fleet.subscriptions.filter(
    (row) =>
      (query.get("status") === null || row.status === query.get("status")) &&
      (query.get("provider") === null || row.billingProvider === query.get("provider")) &&
      (query.get("planCode") === null || row.planCode === query.get("planCode")),
  );
  return json({ data, page: { nextCursor: null, limit: 50 } }, 200);
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call by `METHOD /path`; unexpected calls fail the test. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    [`GET ${PLANS_PATH}`]: () =>
      json({ data: [...fleet.plans].sort((a, b) => a.sortOrder - b.sortOrder) }, 200),
    [`POST ${PLANS_PATH}`]: createRoute,
    [`PATCH ${PLANS_PATH}/growth`]: updateRoute,
    [`GET ${SUBSCRIPTIONS_PATH}`]: listSubscriptions,
    [`GET ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: () => subscriptionDetail(MANUAL_ID),
    [`GET ${SUBSCRIPTIONS_PATH}/${STRIPE_ID}`]: () => subscriptionDetail(STRIPE_ID),
    [`PATCH ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: updateSubscriptionRoute,
    [`PATCH ${SUBSCRIPTIONS_PATH}/${STRIPE_ID}`]: updateSubscriptionRoute,
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

/** The JSON bodies of the calls of `METHOD /path` so far. */
async function bodies(method: string, path: string): Promise<unknown[]> {
  return Promise.all(calls(method, path).map(async (request) => (await request.clone().json()) as unknown));
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

/** The cookie store of the request; `set` records the cookies a step-up writes. */
const cookieStore = {
  get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
  has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
  set: vi.fn(),
};

function resetPlatformApi(): void {
  resetFleet();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pad008_admin",
    }),
  );
  cookieStore.set.mockReset();
  nextHeaders.cookies.mockResolvedValue(cookieStore);
  nextCache.revalidatePath.mockReset();
  for (const method of Object.values(navigation.router)) {
    method.mockReset();
  }
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  routes();
}

// ---- Rendering and interaction --------------------------------------------------------------------------------------

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

/** A rendered page; `rerender` renders it again as Next.js does after an action revalidated it. */
interface View {
  readonly rerender: () => Promise<void>;
}

async function openPage(pathname: string, page: () => Promise<ReactElement>): Promise<View> {
  setUrl(pathname);
  const view = render(await page());
  return {
    rerender: async () => {
      view.rerender(await page());
    },
  };
}

function openPlans(): Promise<View> {
  return openPage("/plans", () => PlansPage());
}

function planPage(planCode: string): Promise<ReactElement> {
  return PlanPage({ params: Promise.resolve({ planCode }) });
}

function openPlan(planCode = "growth"): Promise<View> {
  return openPage(`/plans/${planCode}`, () => planPage(planCode));
}

async function openSubscriptions(search = ""): Promise<void> {
  setUrl("/subscriptions", search);
  render(await SubscriptionsPage({ searchParams: searchParamsOf(search) }));
}

function subscriptionPage(subscriptionId: string): Promise<ReactElement> {
  return SubscriptionPage({ params: Promise.resolve({ subscriptionId }) });
}

function openSubscription(subscriptionId = MANUAL_ID): Promise<View> {
  return openPage(`/subscriptions/${subscriptionId}`, () => subscriptionPage(subscriptionId));
}

function link(name: string | RegExp, container: HTMLElement = document.body): HTMLAnchorElement {
  return within(container).getByRole("link", { name }) as HTMLAnchorElement;
}

function hrefOf(element: HTMLAnchorElement): string | null {
  return element.getAttribute("href");
}

/** Submits the form of the button named `name` inside `container`, with that button as the submitter. */
function submit(name: string | RegExp, container: HTMLElement = document.body): void {
  const button = within(container).getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

/** Types `value` into the field labelled `label`. */
function type(label: string, value: string, container: HTMLElement = document.body): void {
  fireEvent.change(within(container).getByLabelText(label), { target: { value } });
}

function field(label: string, container: HTMLElement = document.body): HTMLInputElement {
  return within(container).getByLabelText(label) as HTMLInputElement;
}

/** The notice of the action that just answered (`data-notice="…"`), once it shows. */
async function notice(
  kind: "done" | "saved" | "failed",
  container: HTMLElement = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    const element = container.querySelector<HTMLElement>(`[data-notice="${kind}"]`);
    if (element === null) {
      throw new Error(`no ${kind} notice yet`);
    }
    return element;
  }, UI_WAIT);
}

function formData(values: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    for (const entry of typeof value === "string" ? [value] : value) {
      data.append(name, entry);
    }
  }
  return data;
}

/** The plan form of the page (`New plan` or `Edit the plan`). */
function planForm(title: string): HTMLElement {
  return screen.getByRole("form", { name: title });
}

/** The row of the plan `code` in the plan list. */
function planRow(code: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`tr[data-plan="${code}"]`);
  if (row === null) {
    throw new Error(`no row of ${code}`);
  }
  return row;
}

/** The edit section of a manual subscription. */
function editSection(): HTMLElement {
  return screen.getByRole("region", { name: MANUAL_SUBSCRIPTION_STRINGS.title });
}

/** Opens the reason dialog of the manual subscription form. */
async function openSaveDialog(): Promise<HTMLElement> {
  fireEvent.click(within(editSection()).getByRole("button", { name: MANUAL_SUBSCRIPTION_STRINGS.save }));
  return screen.findByRole("dialog", { name: MANUAL_SUBSCRIPTION_STRINGS.confirmTitle }, UI_WAIT);
}

function confirmReason(dialog: HTMLElement, reason: string): void {
  fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: reason } });
  submit(MANUAL_SUBSCRIPTION_STRINGS.confirm, dialog);
}

/** Fills the new-plan form with a public plan with two feature flags. */
function fillNewPlan(form: HTMLElement, overrides: Readonly<Record<string, string>> = {}): void {
  const values: Record<string, string> = {
    [PLAN_FORM_STRINGS.codeLabel]: "growth_plus",
    [PLAN_FORM_STRINGS.nameLabel]: "Growth plus",
    [PLAN_FORM_STRINGS.descriptionLabel]: "For OTAs that sell live with a larger team.",
    [PLAN_FORM_STRINGS.monthlyPriceLabel("EUR")]: "199.00",
    [PLAN_FORM_STRINGS.annualPriceLabel("EUR")]: "1990.00",
    [PLAN_FORM_STRINGS.trialDaysLabel]: "14",
    [PLAN_FORM_STRINGS.staffSeatsLabel]: "20",
    [PLAN_FORM_STRINGS.apiKeysLabel]: "30",
    [PLAN_FORM_STRINGS.customDomainsLabel]: "2",
    [PLAN_FORM_STRINGS.sortOrderLabel]: "25",
    [PLAN_FORM_STRINGS.settlementFeeLabel]: "120",
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) {
    type(label, value, form);
  }
  fireEvent.click(field(PLAN_FORM_STRINGS.liveModeLabel, form));
  // Two feature flags: one on, one off.
  fireEvent.click(within(form).getByRole("button", { name: PLAN_FORM_STRINGS.addFeature }));
  type(PLAN_FORM_STRINGS.featureName(1), "queues", form);
  fireEvent.click(within(form).getByRole("button", { name: PLAN_FORM_STRINGS.addFeature }));
  type(PLAN_FORM_STRINGS.featureName(2), "customReports", form);
  fireEvent.click(field(PLAN_FORM_STRINGS.featureOn(2), form));
}

/** The client components these pages render: Next.js sends their props, not their output, to the browser. */
const CLIENT_COMPONENTS: ReadonlySet<unknown> = new Set<unknown>([
  CreatePlanForm,
  EditPlanForm,
  PlanStatusForm,
  PlanBadge,
  PlanStatus,
  PricingState,
  ManualSubscriptionForm,
  SubscriptionTable,
  FilterBar,
  Link,
  ...Object.values(tableComponents),
]);

/**
 * Roughly the React Server Components payload of a page, as in tenants.test.tsx: server components are rendered
 * (called), while host elements and client components keep their props. A value in it reaches the browser even when
 * nothing renders it.
 */
function serverPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(serverPayload);
  }
  if (isValidElement(value)) {
    const { type: elementType, props } = value as ReactElement<Record<string, unknown>>;
    if (typeof elementType === "function" && !CLIENT_COMPONENTS.has(elementType)) {
      return serverPayload((elementType as (properties: Record<string, unknown>) => unknown)(props));
    }
    return {
      type:
        typeof elementType === "string"
          ? elementType
          : CLIENT_COMPONENTS.has(elementType)
            ? "client"
            : "other",
      props: serverPayload(props),
    };
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, serverPayload(entry)]));
  }
  return value;
}

/**
 * Once per file, before any test: the first render of the plan and subscription pages in a fresh worker (the forms,
 * the tables, the filter bar, the dialogs) and the first server action through the real API client are the slowest
 * steps, and on a busy CI runner they would otherwise land in the first test's own five seconds. Nothing of it stays:
 * each test gets a fresh fleet, a fresh API and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  await openPlans();
  fireEvent.click(screen.getByRole("button", { name: PLAN_FORM_STRINGS.newPlan }));
  submit(PLAN_FORM_STRINGS.create, planForm(PLAN_FORM_STRINGS.createTitle));
  await screen.findByText(PLAN_FORM_STRINGS.codeInvalid, {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openPlan();
  cleanup();
  await openSubscriptions();
  cleanup();
  await openSubscription();
  type(MANUAL_SUBSCRIPTION_STRINGS.trialEndLabel, "2027-02-12", editSection());
  fireEvent.click(within(editSection()).getByRole("button", { name: MANUAL_SUBSCRIPTION_STRINGS.save }));
  await screen.findByRole("dialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The plan list ---------------------------------------------------------------------------------------------------

describe("plans/page.tsx: the plan list", () => {
  it("lists every plan with its state, pricing page, prices, limits, OTAs and Stripe link state", async () => {
    await openPlans();

    expect(calls("GET", PLANS_PATH)).toHaveLength(1);
    expectSessionHeaders(calls("GET", PLANS_PATH)[0]);
    expect(screen.getByRole("heading", { level: 1, name: PLAN_LIST_STRINGS.title })).toBeTruthy();
    expect(hrefOf(link(PLAN_LIST_STRINGS.pricingPageLink))).toBe(PRICING_URL);

    const growth = planRow("growth");
    expect(hrefOf(link("Growth", growth))).toBe("/plans/growth");
    for (const text of [
      PLAN_STRINGS.active,
      PLAN_STRINGS.onPricingPage,
      "€149.00",
      "€1,490.00",
      "14 days",
      "15 staff seats, 25 API keys, 1 custom domain, may go live",
      PLAN_STRINGS.stripeNotLinked,
    ]) {
      expect(within(growth).getByText(text)).toBeTruthy();
    }
    // The OTAs on the plan open the tenant list filtered by it.
    expect(hrefOf(link(`${PLAN_LIST_STRINGS.tenantsOf("Growth")}: 3 OTAs`, growth))).toBe(
      "/tenants?planCode=growth",
    );

    const early = planRow("early_access");
    expect(within(early).getByText("€0.00")).toBeTruthy();
    expect(within(early).getByText(PLAN_STRINGS.noAnnual)).toBeTruthy();
    expect(
      within(early).getByText("5 staff seats, 10 API keys, 0 custom domains, test mode only"),
    ).toBeTruthy();

    // A retired private plan is listed, but the pricing page does not offer it.
    const pilot = planRow("pilot");
    expect(within(pilot).getByText(PLAN_STRINGS.retired)).toBeTruthy();
    expect(within(pilot).getByText(PLAN_STRINGS.retiredHidden)).toBeTruthy();
    expect(within(pilot).queryByText(PLAN_STRINGS.onPricingPage)).toBeNull();

    // The rows follow the pricing page's order.
    const codes = [...document.querySelectorAll("tr[data-plan]")].map((row) => row.getAttribute("data-plan"));
    expect(codes).toEqual(["early_access", "growth", "pilot"]);
  });

  it("shows the Stripe link state and the price warnings of a linked plan (M5)", async () => {
    routes({
      [`GET ${PLANS_PATH}`]: () =>
        json(
          {
            data: [
              adminPlan({
                stripeProductId: "prod_QxLm2Np9Rt4Vw",
                stripePriceIdMonth: "price_1QxLm2Np9Rt4VwMonth",
                stripePriceIdYear: "price_1QxLm2Np9Rt4VwYear",
                priceWarnings: [
                  { field: "stripePriceIdMonth.amount", expected: "149.00", actual: "159.00" },
                  { field: "stripePriceIdYear.active", expected: "true", actual: "false" },
                ],
              }),
            ],
          },
          200,
        ),
    });
    await openPlans();
    const growth = planRow("growth");
    expect(within(growth).getByText(PLAN_STRINGS.stripeLinked)).toBeTruthy();
    expect(within(growth).getByText("2 price warnings")).toBeTruthy();
    cleanup();

    await openPlan();
    const stripe = screen.getByRole("region", { name: PLAN_DETAIL_STRINGS.stripeTitle });
    expect(within(stripe).getByText("prod_QxLm2Np9Rt4Vw")).toBeTruthy();
    expect(within(stripe).getByText("stripePriceIdMonth.amount")).toBeTruthy();
    expect(within(stripe).getByText("159.00")).toBeTruthy();
  });

  it("shows the admin's message when the plans cannot be loaded, and sends an ended session to sign-in", async () => {
    routes({ [`GET ${PLANS_PATH}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openPlans();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(PLAN_LIST_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(document.body.textContent).not.toContain("The API's own text");
    cleanup();

    routes({ [`GET ${PLANS_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(PlansPage()).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });
});

// ---- Creating a plan -------------------------------------------------------------------------------------------------

describe("plans/plan-form.tsx: a new plan", () => {
  it("[PAD-008 AC1] a new public plan is active at once, so the pricing page offers it [PF-70]", async () => {
    const view = await openPlans();
    fireEvent.click(screen.getByRole("button", { name: PLAN_FORM_STRINGS.newPlan }));
    const form = planForm(PLAN_FORM_STRINGS.createTitle);
    // Structured fields only: no raw JSON for the limits or the features.
    expect(within(form).queryByDisplayValue(/[{}]/)).toBeNull();
    fillNewPlan(form);
    fireEvent.click(field(PLAN_FORM_STRINGS.isPublicLabel, form));
    submit(PLAN_FORM_STRINGS.create, form);

    const done = await notice("done");
    expect(await bodies("POST", PLANS_PATH)).toEqual([
      {
        code: "growth_plus",
        name: "Growth plus",
        description: "For OTAs that sell live with a larger team.",
        currency: "EUR",
        monthlyPrice: { amount: "199.00", currency: "EUR" },
        annualPrice: { amount: "1990.00", currency: "EUR" },
        limits: { staffSeats: 20, apiKeys: 30, customDomains: 2, liveMode: true },
        features: { queues: true, customReports: false },
        isPublic: true,
        trialDays: 14,
        settlementFeeBps: 120,
        sortOrder: 25,
      },
    ]);
    expectSessionHeaders(calls("POST", PLANS_PATH)[0]);
    // The plan is active and public: the notice says the pricing page offers it and links it and the plan.
    expect(done.getAttribute("role")).toBe("status");
    expect(within(done).getByText(PLAN_FORM_STRINGS.created("Growth plus"))).toBeTruthy();
    expect(within(done).getByText(PLAN_FORM_STRINGS.createdPublic)).toBeTruthy();
    expect(hrefOf(link(PLAN_LIST_STRINGS.pricingPageLink, done))).toBe(PRICING_URL);
    expect(hrefOf(link(/growth_plus/, done))).toBe("/plans/growth_plus");
    expect(nextCache.revalidatePath.mock.calls).toEqual([["/plans"]]);
    expect(screen.queryByRole("form", { name: PLAN_FORM_STRINGS.createTitle })).toBeNull();

    // The revalidated list shows the new plan as active and on the pricing page.
    await view.rerender();
    const row = planRow("growth_plus");
    expect(within(row).getByText(PLAN_STRINGS.active)).toBeTruthy();
    expect(within(row).getByText(PLAN_STRINGS.onPricingPage)).toBeTruthy();
    expect(within(row).getByText("€199.00")).toBeTruthy();
    expect(within(row).getByText("0 OTAs")).toBeTruthy();
  });

  it("[PAD-008 AC1] a plan that is not public, or that is retired, is not on the pricing page", async () => {
    const view = await openPlans();
    fireEvent.click(screen.getByRole("button", { name: PLAN_FORM_STRINGS.newPlan }));
    const form = planForm(PLAN_FORM_STRINGS.createTitle);
    // "Public" is not preselected: a new plan does not reach the pricing page by accident.
    expect(field(PLAN_FORM_STRINGS.isPublicLabel, form).checked).toBe(false);
    fillNewPlan(form, { [PLAN_FORM_STRINGS.codeLabel]: "partner", [PLAN_FORM_STRINGS.nameLabel]: "Partner" });
    submit(PLAN_FORM_STRINGS.create, form);

    const done = await notice("done");
    expect(await bodies("POST", PLANS_PATH)).toMatchObject([{ code: "partner", isPublic: false }]);
    expect(within(done).getByText(PLAN_FORM_STRINGS.createdHidden)).toBeTruthy();
    expect(within(done).queryByRole("link", { name: PLAN_LIST_STRINGS.pricingPageLink })).toBeNull();
    await view.rerender();
    expect(within(planRow("partner")).getByText(PLAN_STRINGS.notPublic)).toBeTruthy();
    cleanup();

    // Retiring a public plan takes it off the pricing page.
    nextCache.revalidatePath.mockClear();
    fetchMock.mockClear();
    const plan = await openPlan("growth");
    fireEvent.click(screen.getByRole("button", { name: PLAN_DETAIL_STRINGS.retire }));
    const dialog = await screen.findByRole(
      "alertdialog",
      { name: PLAN_DETAIL_STRINGS.retireTitle("Growth") },
      UI_WAIT,
    );
    expect(within(dialog).getByText(PLAN_DETAIL_STRINGS.retireDescription)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: PLAN_DETAIL_STRINGS.retireConfirm }));
    const retired = await notice("done");
    expect(retired.textContent).toBe(PLAN_DETAIL_STRINGS.retiredDone);
    expect(await bodies("PATCH", `${PLANS_PATH}/growth`)).toEqual([{ isActive: false }]);
    expect(calls("PATCH", `${PLANS_PATH}/growth`)[0]?.headers.get("if-match")).toBe('"2"');
    expect(nextCache.revalidatePath.mock.calls).toEqual([["/plans/growth"], ["/plans"]]);

    // The revalidated page shows the retired plan and offers to make it active again.
    await plan.rerender();
    const heading = screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement;
    expect(within(heading).getByText(PLAN_STRINGS.retired)).toBeTruthy();
    expect(within(heading).getByText(PLAN_STRINGS.retiredHidden)).toBeTruthy();
    expect(screen.getByText(PLAN_DETAIL_STRINGS.retiredNotice)).toBeTruthy();
    expect(screen.getByRole("button", { name: PLAN_DETAIL_STRINGS.reactivate })).toBeTruthy();
    expect(screen.queryByRole("button", { name: PLAN_DETAIL_STRINGS.retire })).toBeNull();
  });

  it("shows each problem at its field and sends nothing until the plan is valid", async () => {
    await openPlans();
    fireEvent.click(screen.getByRole("button", { name: PLAN_FORM_STRINGS.newPlan }));
    const form = planForm(PLAN_FORM_STRINGS.createTitle);
    fillNewPlan(form, {
      [PLAN_FORM_STRINGS.codeLabel]: "Growth Plus",
      [PLAN_FORM_STRINGS.monthlyPriceLabel("EUR")]: "199.999",
      [PLAN_FORM_STRINGS.trialDaysLabel]: "400",
      [PLAN_FORM_STRINGS.staffSeatsLabel]: "-1",
      [PLAN_FORM_STRINGS.settlementFeeLabel]: "10001",
    });
    // The same feature twice.
    type(PLAN_FORM_STRINGS.featureName(2), "queues", form);
    submit(PLAN_FORM_STRINGS.create, form);

    const codeField = field(PLAN_FORM_STRINGS.codeLabel, form);
    await waitFor(() => expect(codeField.getAttribute("aria-invalid")).toBe("true"), UI_WAIT);
    for (const message of [
      PLAN_FORM_STRINGS.codeInvalid,
      PLAN_FORM_STRINGS.priceInvalid,
      PLAN_FORM_STRINGS.trialDaysInvalid,
      PLAN_FORM_STRINGS.countInvalid,
      PLAN_FORM_STRINGS.settlementFeeInvalid,
      PLAN_FORM_STRINGS.featureDuplicate,
    ]) {
      expect(within(form).getByText(message)).toBeTruthy();
    }
    // The focus is on the first field with a problem, and what was typed stays.
    expect(document.activeElement).toBe(codeField);
    expect(codeField.value).toBe("Growth Plus");
    expect(field(PLAN_FORM_STRINGS.monthlyPriceLabel("EUR"), form).value).toBe("199.999");
    expect(calls("POST", PLANS_PATH)).toHaveLength(0);
  });

  it("shows a taken code and an unknown currency of the API at their fields", async () => {
    await openPlans();
    fireEvent.click(screen.getByRole("button", { name: PLAN_FORM_STRINGS.newPlan }));
    const form = planForm(PLAN_FORM_STRINGS.createTitle);
    fillNewPlan(form, { [PLAN_FORM_STRINGS.codeLabel]: "growth" });
    submit(PLAN_FORM_STRINGS.create, form);
    expect(await within(form).findByText(PLAN_FORM_STRINGS.codeTaken, {}, UI_WAIT)).toBeTruthy();
    expect(calls("POST", PLANS_PATH)).toHaveLength(1);

    routes({
      [`POST ${PLANS_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, undefined, [{ path: "/currency", code: "unknown" }]),
    });
    type(PLAN_FORM_STRINGS.codeLabel, "growth_xx", form);
    type(PLAN_FORM_STRINGS.currencyLabel, "XXX", form);
    submit(PLAN_FORM_STRINGS.create, form);
    expect(await within(form).findByText(PLAN_FORM_STRINGS.currencyUnknown, {}, UI_WAIT)).toBeTruthy();
    // The prices follow the plan's currency.
    expect((await bodies("POST", PLANS_PATH)).at(-1)).toMatchObject({
      currency: "XXX",
      monthlyPrice: { currency: "XXX" },
      annualPrice: { currency: "XXX" },
    });
    expect(document.body.textContent).not.toContain("The API's own text");
  });
});

// ---- Editing and retiring a plan ---------------------------------------------------------------------------------------

describe("plans/[planCode]/page.tsx: one plan", () => {
  it("edits the limits and the features as structured fields with If-Match, then sends the new version", async () => {
    const view = await openPlan();
    expect(calls("GET", PLANS_PATH)).toHaveLength(1);
    const summary = screen.getByRole("region", { name: PLAN_DETAIL_STRINGS.summaryTitle });
    expect(within(summary).getByText("1.50 %")).toBeTruthy();
    expect(hrefOf(link("3 OTAs", summary))).toBe("/tenants?planCode=growth");

    const form = planForm(PLAN_FORM_STRINGS.editTitle);
    // The code and the currency never change; the other fields show the plan.
    expect(within(form).queryByLabelText(PLAN_FORM_STRINGS.codeLabel)).toBeNull();
    expect(within(form).queryByLabelText(PLAN_FORM_STRINGS.currencyLabel)).toBeNull();
    expect(field(PLAN_FORM_STRINGS.nameLabel, form).value).toBe("Growth");
    expect(field(PLAN_FORM_STRINGS.monthlyPriceLabel("EUR"), form).value).toBe("149.00");
    expect(field(PLAN_FORM_STRINGS.staffSeatsLabel, form).value).toBe("15");
    expect(field(PLAN_FORM_STRINGS.liveModeLabel, form).checked).toBe(true);
    expect(field(PLAN_FORM_STRINGS.featureName(1), form).value).toBe("queues");
    expect(field(PLAN_FORM_STRINGS.featureOn(1), form).checked).toBe(true);
    expect(within(form).queryByDisplayValue(/[{}]/)).toBeNull();

    type(PLAN_FORM_STRINGS.staffSeatsLabel, "20", form);
    type(PLAN_FORM_STRINGS.annualPriceLabel("EUR"), "", form);
    fireEvent.click(
      within(form).getByRole("button", { name: `${PLAN_FORM_STRINGS.removeFeature} feature 1` }),
    );
    fireEvent.click(within(form).getByRole("button", { name: PLAN_FORM_STRINGS.addFeature }));
    type(PLAN_FORM_STRINGS.featureName(1), "customReports", form);
    fireEvent.click(field(PLAN_FORM_STRINGS.isPublicLabel, form));
    submit(PLAN_FORM_STRINGS.save, form);

    const saved = await notice("saved", form);
    expect(saved.textContent).toBe(PLAN_FORM_STRINGS.saved);
    expect(await bodies("PATCH", `${PLANS_PATH}/growth`)).toEqual([
      {
        name: "Growth",
        description: "For OTAs selling live with up to 15 staff.",
        monthlyPrice: { amount: "149.00", currency: "EUR" },
        annualPrice: null,
        limits: { staffSeats: 20, apiKeys: 25, customDomains: 1, liveMode: true },
        features: { customReports: true },
        isPublic: false,
        trialDays: 14,
        settlementFeeBps: 150,
        sortOrder: 20,
      },
    ]);
    const [first] = calls("PATCH", `${PLANS_PATH}/growth`);
    expect(first?.headers.get("if-match")).toBe('"2"');
    expectSessionHeaders(first);
    expect(nextCache.revalidatePath.mock.calls).toEqual([["/plans/growth"], ["/plans"]]);

    // The next save sends the saved version, also after the page came back revalidated.
    await view.rerender();
    type(PLAN_FORM_STRINGS.trialDaysLabel, "30", planForm(PLAN_FORM_STRINGS.editTitle));
    submit(PLAN_FORM_STRINGS.save, planForm(PLAN_FORM_STRINGS.editTitle));
    await waitFor(() => expect(calls("PATCH", `${PLANS_PATH}/growth`)).toHaveLength(2), UI_WAIT);
    expect(calls("PATCH", `${PLANS_PATH}/growth`)[1]?.headers.get("if-match")).toBe('"3"');
    expect(await bodies("PATCH", `${PLANS_PATH}/growth`)).toMatchObject([{}, { trialDays: 30 }]);
  });

  it("asks to reload the page after a stale edit (412) and keeps what was typed", async () => {
    // Someone else saved the plan after this page was rendered.
    await openPlan();
    const current = fleet.plans.find((plan) => plan.code === "growth");
    if (current !== undefined) {
      current.version = 5;
    }
    const form = planForm(PLAN_FORM_STRINGS.editTitle);
    type(PLAN_FORM_STRINGS.nameLabel, "Growth 2027", form);
    submit(PLAN_FORM_STRINGS.save, form);

    const failed = await notice("failed", form);
    expect(failed.getAttribute("data-code")).toBe("PRECONDITION_FAILED");
    expect(within(failed).getByText(PLAN_FORM_STRINGS.stale)).toBeTruthy();
    expect(hrefOf(link(PLAN_FORM_STRINGS.reload, failed))).toBe("/plans/growth");
    expect(field(PLAN_FORM_STRINGS.nameLabel, form).value).toBe("Growth 2027");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("makes a retired plan active again with If-Match, after a stale attempt asked to reload", async () => {
    routes({ [`PATCH ${PLANS_PATH}/pilot`]: updateRoute });
    const plan = await openPlan("pilot");
    expect(screen.getByText(PLAN_DETAIL_STRINGS.retiredNotice)).toBeTruthy();
    // Someone else saved the plan after this page was rendered.
    const pilot = fleet.plans.find((candidate) => candidate.code === "pilot");
    if (pilot !== undefined) {
      pilot.version = 6;
    }

    async function reactivate(): Promise<void> {
      fireEvent.click(screen.getByRole("button", { name: PLAN_DETAIL_STRINGS.reactivate }));
      const dialog = await screen.findByRole(
        "alertdialog",
        { name: PLAN_DETAIL_STRINGS.reactivateTitle("Pilot") },
        UI_WAIT,
      );
      fireEvent.click(within(dialog).getByRole("button", { name: PLAN_DETAIL_STRINGS.reactivateConfirm }));
    }

    await reactivate();
    const failed = await notice("failed");
    expect(failed.getAttribute("data-code")).toBe("PRECONDITION_FAILED");
    expect(within(failed).getByText(PLAN_FORM_STRINGS.stale)).toBeTruthy();
    expect(hrefOf(link(PLAN_FORM_STRINGS.reload, failed))).toBe("/plans/pilot");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // The page as it is now carries the new version, which the next attempt sends.
    await plan.rerender();
    await reactivate();
    const done = await notice("done");
    expect(done.textContent).toBe(PLAN_DETAIL_STRINGS.reactivatedDone);
    const patches = calls("PATCH", `${PLANS_PATH}/pilot`);
    expect(patches.map((request) => request.headers.get("if-match"))).toEqual(['"4"', '"6"']);
    expect(await bodies("PATCH", `${PLANS_PATH}/pilot`)).toEqual([{ isActive: true }, { isActive: true }]);
    expect(nextCache.revalidatePath.mock.calls).toEqual([["/plans/pilot"], ["/plans"]]);

    // Active again, but not public: the pricing page still does not offer it.
    await plan.rerender();
    const heading = screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement;
    expect(within(heading).getByText(PLAN_STRINGS.active)).toBeTruthy();
    expect(within(heading).getByText(PLAN_STRINGS.notPublic)).toBeTruthy();
    expect(screen.getByRole("button", { name: PLAN_DETAIL_STRINGS.retire })).toBeTruthy();
    expect(screen.queryByText(PLAN_DETAIL_STRINGS.retiredNotice)).toBeNull();
  });

  it("sends an ended session from each plan action to sign-in and back to its page", async () => {
    routes({
      [`POST ${PLANS_PATH}`]: () => apiError("UNAUTHENTICATED", 401),
      [`PATCH ${PLANS_PATH}/growth`]: () => apiError("TOKEN_EXPIRED", 401),
    });
    const signIn = (next: string) => `/sign-in?${new URLSearchParams({ next }).toString()}`;

    await expect(
      createPlan(IDLE_PLAN_FORM, formData({ ...VALID_PLAN_FIELDS, code: "growth_plus" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(navigation.redirect).toHaveBeenLastCalledWith(signIn("/plans"));
    await expect(
      updatePlan(IDLE_PLAN_FORM, formData({ ...VALID_PLAN_FIELDS, planCode: "growth", version: "2" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(navigation.redirect).toHaveBeenLastCalledWith(signIn("/plans/growth"));
    await expect(
      setPlanActive({ status: "idle" }, formData({ planCode: "growth", version: "2", isActive: "false" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(navigation.redirect).toHaveBeenLastCalledWith(signIn("/plans/growth"));

    expect(navigation.redirect).toHaveBeenCalledTimes(3);
    expect(calls("POST", PLANS_PATH)).toHaveLength(1);
    expect(calls("PATCH", `${PLANS_PATH}/growth`)).toHaveLength(2);
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("renders the not-found page for a value that is no plan code, without a call, and for an unknown plan", async () => {
    await expect(planPage("Growth Plus")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(planPage("platinum")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls("GET", PLANS_PATH)).toHaveLength(1);
  });

  it("the server actions refuse made-up fields without calling the API", async () => {
    const idle = IDLE_PLAN_FORM;
    const valid = VALID_PLAN_FIELDS;
    // An edit without its plan code or version, with a made-up code, or a stale-looking version.
    for (const extra of [
      {},
      { planCode: "growth" },
      { planCode: "../tenants", version: "2" },
      { planCode: "growth", version: "0" },
    ]) {
      const state = await updatePlan(idle, formData({ ...valid, ...extra }));
      expect(state).toMatchObject({
        status: "failed",
        code: "VALIDATION_FAILED",
        message: PLAN_FORM_STRINGS.formExpired,
      });
    }
    // A feature name that is no flag name, and too many features.
    const badFeature = await createPlan(
      idle,
      formData({ ...valid, code: "growth_plus", featureName: ["__proto__"], featureOn: ["0"] }),
    );
    expect(badFeature.fieldErrors).toEqual({ features: PLAN_FORM_STRINGS.featureNameInvalid });
    const many = Array.from({ length: 51 }, (_, index) => `flag${index}`);
    const tooMany = await createPlan(idle, formData({ ...valid, code: "growth_plus", featureName: many }));
    expect(tooMany.fieldErrors).toEqual({ features: PLAN_FORM_STRINGS.featuresTooMany });
    // The edit form shows no currency field: a broken hidden currency says the form is out of date, not nothing.
    const badCurrency = await updatePlan(
      idle,
      formData({ ...valid, planCode: "growth", version: "2", currency: "E1R" }),
    );
    expect(badCurrency).toMatchObject({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: PLAN_FORM_STRINGS.formExpired,
      fieldErrors: {},
    });
    // Retiring needs the code, the version and a true or false.
    for (const extra of [
      {},
      { planCode: "growth", version: "2" },
      { planCode: "growth", version: "2", isActive: "no" },
    ]) {
      expect(await setPlanActive({ status: "idle" }, formData(extra))).toMatchObject({
        status: "failed",
        code: "VALIDATION_FAILED",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the forms only the plan fields they show, whatever else the answer holds", async () => {
    const sentinel = "PAD008-SENTINEL-PLAN";
    routes({
      [`GET ${PLANS_PATH}`]: () =>
        json({ data: initialPlans().map((plan) => ({ ...plan, stripeSecret: sentinel })) }, 200),
    });
    const page = await planPage("growth");
    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain('"code":"growth"');
    expect(payload).not.toContain(sentinel);
    render(page);
    expect(document.body.innerHTML).not.toContain(sentinel);
  });
});

// ---- Subscriptions -------------------------------------------------------------------------------------------------------

describe("subscriptions/page.tsx: the subscription list", () => {
  it("filters by status, billing and plan in the URL and links every subscription and its OTA", async () => {
    await openSubscriptions("status=trialing&provider=manual&planCode=early_access");

    expect(queryOfCall(SUBSCRIPTIONS_PATH)).toEqual([
      ["planCode", "early_access"],
      ["provider", "manual"],
      ["status", "trialing"],
    ]);
    expectSessionHeaders(calls("GET", SUBSCRIPTIONS_PATH)[0]);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    const row = rows[1] as HTMLElement;
    expect(hrefOf(link(MANUAL_ID, row))).toBe(`/subscriptions/${MANUAL_ID}`);
    expect(hrefOf(link("Acme Travel", row))).toBe(`/tenants/${TENANT_ID}`);
    for (const text of ["Early access", "Trial", "Manual (no Stripe)", "Monthly"]) {
      expect(within(row).getByText(text)).toBeTruthy();
    }
    expect(row.querySelector('time[datetime="2027-01-12T08:20:11Z"]')).not.toBeNull();

    // The selects show the URL's filters; the plan filter names every plan, retired ones marked.
    const plan = screen.getByRole("combobox", {
      name: SUBSCRIPTION_LIST_STRINGS.planLabel,
    }) as HTMLSelectElement;
    expect([...plan.options].map((option) => option.textContent)).toEqual([
      "Any",
      "Early access",
      "Growth",
      SUBSCRIPTION_LIST_STRINGS.retiredPlan("Pilot"),
    ]);
    const provider = screen.getByRole("combobox", {
      name: SUBSCRIPTION_LIST_STRINGS.providerLabel,
    }) as HTMLSelectElement;
    expect(provider.value).toBe("manual");
    fireEvent.change(provider, { target: { value: "stripe" } });
    const [href] = navigation.router.push.mock.calls[0] as [string];
    expect(sortedQuery(new URL(href, "https://admin.invalid").search)).toEqual([
      ["planCode", "early_access"],
      ["provider", "stripe"],
      ["status", "trialing"],
    ]);
  });

  it("shows a notice for filters the API would refuse, and does not ask it for a list", async () => {
    for (const search of [
      "status=deleted",
      "provider=paypal",
      "planCode=Bad",
      "status=active&status=trialing",
    ]) {
      fetchMock.mockClear();
      await openSubscriptions(search);
      expect(screen.getByText(SUBSCRIPTION_LIST_STRINGS.invalidFilters)).toBeTruthy();
      expect(calls("GET", SUBSCRIPTIONS_PATH)).toHaveLength(0);
      expect(hrefOf(link(SUBSCRIPTION_LIST_STRINGS.showAll))).toBe("/subscriptions");
      cleanup();
    }
    routes({ [`GET ${SUBSCRIPTIONS_PATH}`]: () => apiError("VALIDATION_FAILED", 400) });
    await openSubscriptions("cursor=stale");
    expect(screen.getByText(SUBSCRIPTION_LIST_STRINGS.invalidFilters)).toBeTruthy();
  });

  it("hands the client table only the fields it shows", async () => {
    const sentinel = "PAD008-SENTINEL-SUBSCRIPTION";
    routes({
      [`GET ${SUBSCRIPTIONS_PATH}`]: () =>
        json(
          {
            data: fleet.subscriptions.map((row) => ({ ...row, cardFingerprint: sentinel })),
            page: { nextCursor: "eyJpZCI6InN1Yl8ifQ", limit: 50 },
          },
          200,
        ),
    });
    const page = await SubscriptionsPage({ searchParams: searchParamsOf("") });
    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain(MANUAL_ID);
    expect(payload).not.toContain(sentinel);
    setUrl("/subscriptions");
    render(page);
    expect(document.body.innerHTML).not.toContain(sentinel);
    // The next page keeps the (empty) filters.
    expect(hrefOf(link("Next page"))).toBe("/subscriptions?cursor=eyJpZCI6InN1Yl8ifQ");
  });
});

describe("subscriptions/[subscriptionId]/page.tsx: one subscription", () => {
  it("[PAD-008 AC2] moves a manual trial's end date with a reason [PF-75]", async () => {
    const view = await openSubscription();
    const summary = screen.getByRole("region", { name: SUBSCRIPTION_DETAIL_STRINGS.summaryTitle });
    expect(hrefOf(link("Acme Travel", summary))).toBe(`/tenants/${TENANT_ID}`);
    expect(hrefOf(link("Early access", summary))).toBe("/plans/early_access");
    expect(screen.getByText(SUBSCRIPTION_DETAIL_STRINGS.invoicesEmpty)).toBeTruthy();
    expect(screen.getByText(SUBSCRIPTION_DETAIL_STRINGS.eventsEmpty)).toBeTruthy();
    // The form offers the active plans only (not the retired Pilot).
    const section = editSection();
    const plan = within(section).getByLabelText(MANUAL_SUBSCRIPTION_STRINGS.planLabel) as HTMLSelectElement;
    expect([...plan.options].map((option) => option.value)).toEqual(["early_access", "growth"]);
    const day = field(MANUAL_SUBSCRIPTION_STRINGS.trialEndLabel, section);
    expect(day.value).toBe("2027-01-12");
    expect(within(section).getByText(MANUAL_SUBSCRIPTION_STRINGS.trialEndHint("08:20"))).toBeTruthy();
    // Nothing changed yet: nothing to save.
    expect(
      (within(section).getByRole("button", { name: MANUAL_SUBSCRIPTION_STRINGS.save }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    type(MANUAL_SUBSCRIPTION_STRINGS.trialEndLabel, "2027-02-12", section);
    const dialog = await openSaveDialog();
    expect(
      within(dialog).getByText(MANUAL_SUBSCRIPTION_STRINGS.changeTrialEnd("Jan 12, 2027", "Feb 12, 2027")),
    ).toBeTruthy();
    // No reason, then four characters: refused at the field, nothing is sent.
    submit(MANUAL_SUBSCRIPTION_STRINGS.confirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.required)).toBeTruthy();
    confirmReason(dialog, "Pilo");
    expect(within(dialog).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
    expect(calls("PATCH", `${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`)).toHaveLength(0);

    confirmReason(dialog, `  ${REASON}  `);
    const done = await notice("done", section);
    // Only the trial end changes, at the same time of day; the reason goes with it, the version in If-Match.
    expect(await bodies("PATCH", `${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`)).toEqual([
      { trialEndsAt: "2027-02-12T08:20:11Z", reason: REASON },
    ]);
    const [call] = calls("PATCH", `${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`);
    expect(call?.headers.get("if-match")).toBe('"1"');
    expectSessionHeaders(call);
    expect(done.getAttribute("role")).toBe("status");
    expect(within(done).getByText(MANUAL_SUBSCRIPTION_STRINGS.saved)).toBeTruthy();
    expect(done.querySelector('time[datetime="2027-02-12T08:20:11Z"]')).not.toBeNull();
    expect(nextCache.revalidatePath.mock.calls).toEqual([
      [`/subscriptions/${MANUAL_ID}`],
      ["/subscriptions"],
      [`/tenants/${TENANT_ID}`],
    ]);

    // The revalidated page shows the new end of the trial, and the form has nothing left to save.
    await view.rerender();
    const refreshed = screen.getByRole("region", { name: SUBSCRIPTION_DETAIL_STRINGS.summaryTitle });
    expect(refreshed.querySelector('time[datetime="2027-02-12T08:20:11Z"]')).not.toBeNull();
    expect(within(refreshed).getByText("2")).toBeTruthy();
    expect(field(MANUAL_SUBSCRIPTION_STRINGS.trialEndLabel, editSection()).value).toBe("2027-02-12");
  });

  it("[PAD-008 AC2] has no edit form for a Stripe-billed subscription, and shows its invoices and events", async () => {
    await openSubscription(STRIPE_ID);

    expect(screen.queryByRole("region", { name: MANUAL_SUBSCRIPTION_STRINGS.title })).toBeNull();
    expect(screen.queryByRole("button", { name: MANUAL_SUBSCRIPTION_STRINGS.save })).toBeNull();
    expect(screen.queryByLabelText(MANUAL_SUBSCRIPTION_STRINGS.trialEndLabel)).toBeNull();
    expect(screen.getByText(SUBSCRIPTION_DETAIL_STRINGS.stripeBilled)).toBeTruthy();
    // The page does not load the plans for a form it does not show.
    expect(calls("GET", PLANS_PATH)).toHaveLength(0);

    const summary = screen.getByRole("region", { name: SUBSCRIPTION_DETAIL_STRINGS.summaryTitle });
    expect(within(summary).getByText("cus_Qx7Lm2Np9Rt4Vw")).toBeTruthy();
    expect(within(summary).getByText("Stripe Billing")).toBeTruthy();
    const invoices = screen.getByRole("region", { name: SUBSCRIPTION_DETAIL_STRINGS.invoicesTitle });
    const invoice = within(invoices).getAllByRole("row")[1] as HTMLElement;
    for (const text of ["VX-2027-000312", "Paid", "€149.00", "€0.00"]) {
      expect(within(invoice).getByText(text)).toBeTruthy();
    }
    expect(hrefOf(link(/Invoice page/, invoice))).toBe(INVOICE.hostedInvoiceUrl);
    expect(hrefOf(link(/PDF/, invoice))).toBe(INVOICE.invoicePdfUrl);
    const events = screen.getByRole("region", { name: SUBSCRIPTION_DETAIL_STRINGS.eventsTitle });
    expect(within(events).getByText("invoice.paid")).toBeTruthy();
    expect(within(events).getByText("Processed", { selector: "[data-status]" })).toBeTruthy();

    // The server action is refused by the API for a Stripe-billed row, in the admin's words.
    const state = await updateManualSubscription(
      { status: "idle" },
      formData({
        subscriptionId: STRIPE_ID,
        version: "4",
        trialEndsAt: "2027-05-01T00:00:00Z",
        reason: REASON,
      }),
    );
    expect(state).toEqual({
      status: "failed",
      code: "CONFLICT",
      message: MANUAL_SUBSCRIPTION_STRINGS.stripeBilled,
    });
  });

  it("changes the plan and cancels with a reason, and words the API's refusals for the admin [PF-75]", async () => {
    await openSubscription();
    const section = editSection();
    fireEvent.change(within(section).getByLabelText(MANUAL_SUBSCRIPTION_STRINGS.planLabel), {
      target: { value: "growth" },
    });
    fireEvent.change(within(section).getByLabelText(MANUAL_SUBSCRIPTION_STRINGS.statusLabel), {
      target: { value: "canceled" },
    });
    // The plan was retired in the meantime: the API refuses it, and the message shows at the plan.
    const growth = fleet.plans.find((plan) => plan.code === "growth");
    if (growth !== undefined) {
      growth.isActive = false;
    }
    let dialog = await openSaveDialog();
    expect(
      within(dialog).getByText(MANUAL_SUBSCRIPTION_STRINGS.changePlan("Early access", "Growth")),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(MANUAL_SUBSCRIPTION_STRINGS.changeStatus("Trial", "Canceled")),
    ).toBeTruthy();
    confirmReason(dialog, REASON);
    const refused = await notice("failed", section);
    expect(refused.getAttribute("data-code")).toBe("UNPROCESSABLE");
    expect(refused.textContent).toBe(MANUAL_SUBSCRIPTION_STRINGS.planNotActive);
    expect(
      within(section).getByLabelText(MANUAL_SUBSCRIPTION_STRINGS.planLabel).getAttribute("aria-invalid"),
    ).toBe("true");

    if (growth !== undefined) {
      growth.isActive = true;
    }
    dialog = await openSaveDialog();
    confirmReason(dialog, REASON);
    const done = await notice("done", section);
    expect(await bodies("PATCH", `${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`)).toEqual([
      { planCode: "growth", status: "canceled", reason: REASON },
      { planCode: "growth", status: "canceled", reason: REASON },
    ]);
    expect(within(done).getByText("Growth")).toBeTruthy();
    expect(within(done).getByText("Canceled")).toBeTruthy();
  });

  it("shows at the status that a canceled trial cannot reopen while the OTA has another current subscription", async () => {
    const canceled = fleet.subscriptions.find((row) => row.id === MANUAL_ID);
    if (canceled !== undefined) {
      canceled.status = "canceled";
      canceled.canceledAt = "2026-10-20T09:00:00Z";
    }
    routes({
      [`PATCH ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: () =>
        apiError("CONFLICT", 409, { reason: "current_exists" }),
    });
    await openSubscription();
    const section = editSection();
    const status = within(section).getByLabelText(
      MANUAL_SUBSCRIPTION_STRINGS.statusLabel,
    ) as HTMLSelectElement;
    expect([...status.options].map((option) => option.value)).toEqual(["canceled", "trialing"]);
    fireEvent.change(status, { target: { value: "trialing" } });
    const dialog = await openSaveDialog();
    expect(
      within(dialog).getByText(MANUAL_SUBSCRIPTION_STRINGS.changeStatus("Canceled", "Trial")),
    ).toBeTruthy();
    confirmReason(dialog, REASON);

    const refused = await notice("failed", section);
    expect(refused.getAttribute("data-code")).toBe("CONFLICT");
    expect(refused.textContent).toBe(MANUAL_SUBSCRIPTION_STRINGS.currentExists);
    expect(status.getAttribute("aria-invalid")).toBe("true");
    expect(status.getAttribute("aria-describedby")).toContain(refused.id);
    expect(await bodies("PATCH", `${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`)).toEqual([
      { status: "trialing", reason: REASON },
    ]);
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("keeps only the current plan when the plans cannot be loaded, and words a subscription that cannot be read", async () => {
    routes({ [`GET ${PLANS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openSubscription();
    const section = editSection();
    expect(within(section).getByText(MANUAL_SUBSCRIPTION_STRINGS.plansUnavailable)).toBeTruthy();
    const plan = within(section).getByLabelText(MANUAL_SUBSCRIPTION_STRINGS.planLabel) as HTMLSelectElement;
    expect([...plan.options].map((option) => option.value)).toEqual(["early_access"]);
    // The trial end and the status can still change.
    type(MANUAL_SUBSCRIPTION_STRINGS.trialEndLabel, "2027-02-12", section);
    expect(
      (within(section).getByRole("button", { name: MANUAL_SUBSCRIPTION_STRINGS.save }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    cleanup();

    routes({ [`GET ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openSubscription();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(SUBSCRIPTION_DETAIL_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(screen.queryByRole("region", { name: MANUAL_SUBSCRIPTION_STRINGS.title })).toBeNull();
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("sends an ended session from the manual edit to sign-in and back to the subscription", async () => {
    routes({ [`PATCH ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(
      updateManualSubscription(
        { status: "idle" },
        formData({ subscriptionId: MANUAL_ID, version: "1", status: "canceled", reason: REASON }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(navigation.redirect).toHaveBeenCalledTimes(1);
    expect(navigation.redirect).toHaveBeenLastCalledWith(
      `/sign-in?${new URLSearchParams({ next: `/subscriptions/${MANUAL_ID}` }).toString()}`,
    );
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("asks to reload after a stale edit (412) and opens the step-up dialog when the API asks for one", async () => {
    routes({
      [`PATCH ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: () => apiError("PRECONDITION_FAILED", 412),
    });
    await openSubscription();
    type(MANUAL_SUBSCRIPTION_STRINGS.trialEndLabel, "2027-03-01", editSection());
    confirmReason(await openSaveDialog(), REASON);
    const failed = await notice("failed", editSection());
    expect(failed.getAttribute("data-code")).toBe("PRECONDITION_FAILED");
    expect(within(failed).getByText(MANUAL_SUBSCRIPTION_STRINGS.stale)).toBeTruthy();
    expect(hrefOf(link(MANUAL_SUBSCRIPTION_STRINGS.reload, failed))).toBe(`/subscriptions/${MANUAL_ID}`);
    cleanup();
    fetchMock.mockClear();

    // REAUTH_REQUIRED: the TOTP code, then the same change with the same reason.
    let asked = false;
    routes({
      [`PATCH ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: (request) => {
        if (!asked) {
          asked = true;
          return apiError("REAUTH_REQUIRED", 401);
        }
        return updateSubscriptionRoute(request);
      },
      "POST /v1/admin/auth/step-up": () =>
        json(
          {
            accessToken: "pad008-dummy-stepped-up-access-token",
            accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
            refreshToken: "pad008-dummy-stepped-up-refresh-token",
            refreshTokenExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
            admin: {
              id: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
              email: "lena.holm@velexis.example.com",
              fullName: "Lena Holm",
              features: {},
            },
          },
          200,
        ),
    });
    await openSubscription();
    type(MANUAL_SUBSCRIPTION_STRINGS.trialEndLabel, "2027-03-01", editSection());
    confirmReason(await openSaveDialog(), REASON);
    const stepUp = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    fireEvent.change(within(stepUp).getByLabelText(STEP_UP_STRINGS.codeLabel), {
      target: { value: "123456" },
    });
    submit(STEP_UP_STRINGS.submit, stepUp);
    // The step-up dialog is modal: the page is hidden from assistive technology until it closes.
    await notice("done");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await bodies("POST", "/v1/admin/auth/step-up")).toEqual([{ code: "123456" }]);
    expect(await bodies("PATCH", `${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`)).toEqual([
      { trialEndsAt: "2027-03-01T08:20:11Z", reason: REASON },
      { trialEndsAt: "2027-03-01T08:20:11Z", reason: REASON },
    ]);
  });

  it("the server action refuses a missing reason, no change and made-up fields without calling the API", async () => {
    const idle: ManualSubscriptionState = { status: "idle" };
    const base = { subscriptionId: MANUAL_ID, version: "1" };
    const cases: [Record<string, string>, string][] = [
      [{ ...base, trialEndsAt: "2027-02-12T08:20:11Z" }, REASON_STRINGS.required],
      [{ ...base, trialEndsAt: "2027-02-12T08:20:11Z", reason: "Pilo" }, REASON_STRINGS.tooShort],
      [{ ...base, reason: REASON }, MANUAL_SUBSCRIPTION_STRINGS.noChange],
      [{ ...base, trialEndsAt: "12/02/2027", reason: REASON }, MANUAL_SUBSCRIPTION_STRINGS.trialEndInvalid],
      [{ ...base, status: "active", reason: REASON }, MANUAL_SUBSCRIPTION_STRINGS.formExpired],
      [{ ...base, planCode: "Growth!", reason: REASON }, MANUAL_SUBSCRIPTION_STRINGS.planNotActive],
      [
        { subscriptionId: "sub_1", version: "1", status: "canceled", reason: REASON },
        MANUAL_SUBSCRIPTION_STRINGS.formExpired,
      ],
      [
        { subscriptionId: MANUAL_ID, status: "canceled", reason: REASON },
        MANUAL_SUBSCRIPTION_STRINGS.formExpired,
      ],
    ];
    for (const [values, message] of cases) {
      expect(await updateManualSubscription(idle, formData(values))).toMatchObject({
        status: "failed",
        code: "VALIDATION_FAILED",
        message,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the not-found page for a value that is no subscription id, without a call, and for an unknown one", async () => {
    await expect(subscriptionPage("sub_123")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
    const unknown = "sub_01JZZZZZZZZZZZZZZZZZZZZZZZ";
    routes({ [`GET ${SUBSCRIPTIONS_PATH}/${unknown}`]: () => subscriptionDetail(unknown) });
    await expect(subscriptionPage(unknown)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls("GET", `${SUBSCRIPTIONS_PATH}/${unknown}`)).toHaveLength(1);
  });

  it("hands the edit form only the fields it shows", async () => {
    const sentinel = "PAD008-SENTINEL-DETAIL";
    routes({
      [`GET ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: () =>
        json({ subscription: { ...subscription(), internalToken: sentinel }, invoices: [], events: [] }, 200),
      [`GET ${PLANS_PATH}`]: () =>
        json({ data: initialPlans().map((plan) => ({ ...plan, stripeSecret: sentinel })) }, 200),
    });
    const page = await subscriptionPage(MANUAL_ID);
    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain(MANUAL_ID);
    expect(payload).not.toContain(sentinel);
  });
});
