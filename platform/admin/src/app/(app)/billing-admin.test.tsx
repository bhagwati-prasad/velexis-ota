// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { isValidElement, type ReactElement, type ReactNode } from "react";
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

import InvoicesPage from "@/app/(app)/invoices/page";
import PlanPage from "@/app/(app)/plans/[planCode]/page";
import { checkPlanPrices, linkStripePrices, type StripePricesState } from "@/app/(app)/plans/actions";
import { shiftDecimalPoint, StripePricesForm, stripeAmountOf } from "@/app/(app)/plans/stripe-prices-form";
import { reprocessStripeEvent } from "@/app/(app)/stripe-events/actions";
import { StripeEventTable } from "@/app/(app)/stripe-events/event-table";
import StripeEventsPage from "@/app/(app)/stripe-events/page";
import SubscriptionPage from "@/app/(app)/subscriptions/[subscriptionId]/page";
import { resyncSubscription } from "@/app/(app)/subscriptions/actions";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  CONFIRM_STRINGS,
  ERROR_MESSAGES,
  INVOICE_LIST_STRINGS as I,
  MANUAL_SUBSCRIPTION_STRINGS,
  PLAN_DETAIL_STRINGS,
  PLAN_FORM_STRINGS,
  PLAN_STRINGS,
  PRICE_WARNING_ATTRIBUTES,
  RESYNC_STRINGS as R,
  STRIPE_EVENT_ACTION_STRINGS as EA,
  STRIPE_EVENT_LIST_STRINGS as E,
  STRIPE_PRICES_STRINGS as SP,
  SUBSCRIPTION_DETAIL_STRINGS,
  TABLE_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) ---------------------------------------------------

type Schemas = components["schemas"];
type AdminPlan = Schemas["AdminPlan"];
type AdminSubscription = Schemas["AdminSubscription"];
type AdminInvoice = Schemas["AdminInvoice"];
type AdminStripeEvent = Schemas["AdminStripeEvent"];
type PlanPriceWarning = Schemas["PlanPriceWarning"];

const ACCESS_TOKEN = "pad012-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-012 test)";
const ACME_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const NORDIC_ID = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const SAKURA_ID = "ten_01JC4M5N9Q3S7V1X5Z9B3D7F1H";
const MANUAL_ID = "sub_01JA2Z7R5N0S3V7X1Z4B9D2F6H";
const STRIPE_ID = "sub_01JE4N7P1R5T9W3Y7A1C5E9G3J";
const UNLINKED_ID = "sub_01JF5P8Q2S6V0X4Z8B2D6F0H4K";
const PLANS_PATH = "/v1/admin/plans";
const GROWTH_PATH = `${PLANS_PATH}/growth`;
const CHECK_PATH = `${GROWTH_PATH}/check-prices`;
const SUBSCRIPTIONS_PATH = "/v1/admin/subscriptions";
const RESYNC_PATH = `${SUBSCRIPTIONS_PATH}/${STRIPE_ID}/resync`;
const INVOICES_PATH = "/v1/admin/invoices";
const EVENTS_PATH = "/v1/admin/stripe-events";

// The Stripe objects of the fake Stripe account the in-memory platform compares the plans with.
const PRODUCT = "prod_QxGrowth01";
const PRICE_MONTH = "price_1QxGrowthMonthEur";
const PRICE_MONTH_NEW = "price_1QxGrowthMonthNew";
const PRICE_YEAR = "price_1QxGrowthYearEur";
const PRICE_SCALE = "price_1QxScaleMonthEur";

const EVT_FAILED = "evt_1QzNo5Pr2Tv7XyA8Bc0De2Fg";
const EVT_IGNORED = "evt_1QzIg6Qs3Uw8YzB9Cd1Ef3Gh";
const EVT_RECEIVED = "evt_1QzRc7Rt4Vx9ZaC0De2Fg4Hi";
const EVT_PROCESSING = "evt_1QzPr8Su5Wy0AbD1Ef3Gh5Ij";
const EVT_PROCESSED = "evt_1QyMn3Oq0Su5WxZ7Ab9Cd1Ef";

/**
 * The budget of the warm-up hook: the first render of these pages in a fresh worker loads the module graph of the
 * forms, the tables, the filter bar and the dialogs, and the first server action runs React's action queue for the
 * first time. On a loaded runner that takes seconds; the hook only stops one that hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * How long a step that runs a server action (a round trip through the real `lib/api.ts`) and re-renders the page may
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

/** The growth plan with its product and both prices linked, as an earlier save left it. */
function linkedGrowth(overrides: Partial<AdminPlan> = {}): AdminPlan {
  return adminPlan({
    stripeProductId: PRODUCT,
    stripePriceIdMonth: PRICE_MONTH,
    stripePriceIdYear: PRICE_YEAR,
    checkoutAvailable: { month: true, year: true },
    version: 3,
    ...overrides,
  });
}

/** The plans: growth (nothing linked) and scale, whose monthly price no other plan may link. */
function initialPlans(): AdminPlan[] {
  return [
    adminPlan(),
    adminPlan({
      code: "scale",
      name: "Scale",
      monthlyPrice: { amount: "349.00", currency: "EUR" },
      annualPrice: null,
      stripeProductId: "prod_QxScale01",
      stripePriceIdMonth: PRICE_SCALE,
      checkoutAvailable: { month: true, year: false },
      sortOrder: 30,
      version: 1,
    }),
  ];
}

/** A recurring price of the fake Stripe account. */
interface FakePrice {
  readonly amount: string;
  readonly currency: string;
  readonly interval: string;
  readonly active: boolean;
}

function initialPrices(): Map<string, FakePrice> {
  return new Map<string, FakePrice>([
    [PRICE_MONTH, { amount: "149.00", currency: "EUR", interval: "month", active: true }],
    [PRICE_MONTH_NEW, { amount: "159.00", currency: "EUR", interval: "month", active: true }],
    [PRICE_YEAR, { amount: "1490.00", currency: "EUR", interval: "year", active: true }],
    [PRICE_SCALE, { amount: "349.00", currency: "EUR", interval: "month", active: true }],
  ]);
}

function subscription(overrides: Partial<AdminSubscription> = {}): AdminSubscription {
  return {
    id: MANUAL_ID,
    tenantId: ACME_ID,
    tenantKey: "acme",
    tenantName: "Acme Travel",
    planCode: "growth",
    planName: "Growth",
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

/** The three kinds of row: a manual trial, a Stripe subscription, and a Stripe row whose Checkout has not completed. */
function initialSubscriptions(): AdminSubscription[] {
  return [
    subscription(),
    subscription({
      id: STRIPE_ID,
      tenantId: NORDIC_ID,
      tenantKey: "nordic",
      tenantName: "Nordic Trips",
      status: "active",
      billingProvider: "stripe",
      trialEndsAt: null,
      currentPeriodStart: "2027-03-01T00:00:00Z",
      currentPeriodEnd: "2027-04-01T00:00:00Z",
      providerCustomerId: "cus_Qx7Lm2Np9Rt4Vw",
      providerSubscriptionId: "sub_1QxLm2Np9Rt4VwY6Za8Bc0De",
      createdAt: "2027-02-01T10:12:40Z",
      version: 4,
    }),
    subscription({
      id: UNLINKED_ID,
      tenantId: SAKURA_ID,
      tenantKey: "sakura",
      tenantName: "Sakura Tours",
      status: "incomplete",
      billingProvider: "stripe",
      trialEndsAt: null,
      providerCustomerId: "cus_Qy8Mn3Oq0Su5Wx",
      createdAt: "2027-04-02T07:00:00Z",
    }),
  ];
}

/** An open EUR invoice of Nordic's Stripe subscription. */
const INVOICE_EUR: AdminInvoice = {
  id: "inv_01JF5P9R3T7W1Y5A9C3E7G1J5M",
  tenantId: NORDIC_ID,
  subscriptionId: STRIPE_ID,
  number: "VX-2027-000377",
  status: "open",
  subtotal: { amount: "149.00", currency: "EUR" },
  taxAmount: { amount: "0.00", currency: "EUR" },
  total: { amount: "149.00", currency: "EUR" },
  amountPaid: { amount: "0.00", currency: "EUR" },
  amountDue: { amount: "149.00", currency: "EUR" },
  periodStart: "2027-04-01T00:00:00Z",
  periodEnd: "2027-05-01T00:00:00Z",
  issuedAt: "2027-04-01T01:03:55Z",
  dueAt: null,
  paidAt: null,
  hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1Velexis/test_YWNjdF8xVmVsZXhpczI",
  invoicePdfUrl: "https://pay.stripe.com/invoice/acct_1Velexis/test_YWNjdF8xVmVsZXhpczI/pdf",
  providerInvoiceId: "in_1QzNo4Pr1Tv6Xy",
  createdAt: "2027-04-01T01:03:56Z",
};

/** A paid JPY invoice (no decimals) without a subscription row, whose hosted page is not an `https:` URL. */
const INVOICE_JPY: AdminInvoice = {
  ...INVOICE_EUR,
  id: "inv_01JG6Q0S4V8X2Z6B0D4F8H2K6N",
  tenantId: SAKURA_ID,
  subscriptionId: null,
  number: "VX-2027-000401",
  status: "paid",
  subtotal: { amount: "5000", currency: "JPY" },
  taxAmount: { amount: "0", currency: "JPY" },
  total: { amount: "5000", currency: "JPY" },
  amountPaid: { amount: "5000", currency: "JPY" },
  amountDue: { amount: "0", currency: "JPY" },
  paidAt: "2027-04-02T09:00:00Z",
  hostedInvoiceUrl: "http://invoice.example.test/i/plain",
  invoicePdfUrl: null,
  providerInvoiceId: "in_1QzOp5Qs2Uw7Yz",
};

function stripeEvent(overrides: Partial<AdminStripeEvent>): AdminStripeEvent {
  return {
    id: EVT_PROCESSED,
    endpoint: "billing",
    type: "invoice.paid",
    status: "processed",
    attempts: 1,
    lastError: null,
    tenantId: NORDIC_ID,
    receivedAt: "2027-03-01T01:04:16Z",
    processedAt: "2027-03-01T01:04:18Z",
    ...overrides,
  };
}

/** The inbox in the API's order: failed and ignored first, then the others. */
function initialEvents(): AdminStripeEvent[] {
  return [
    stripeEvent({
      id: EVT_FAILED,
      type: "customer.subscription.updated",
      status: "failed",
      attempts: 5,
      lastError: "UNKNOWN_PRICE: price_1QzNo5Pr2Tv7XyNew is not linked to a plan",
      receivedAt: "2027-04-02T09:14:07Z",
      processedAt: "2027-04-02T09:31:40Z",
    }),
    stripeEvent({
      id: EVT_IGNORED,
      type: "customer.subscription.deleted",
      status: "ignored",
      lastError: "UNKNOWN_SUBSCRIPTION: no row names sub_1QzIg6Qs3Uw8Yz",
      tenantId: null,
      receivedAt: "2027-04-01T08:00:00Z",
    }),
    stripeEvent({ id: EVT_RECEIVED, status: "received", attempts: 0, processedAt: null }),
    stripeEvent({ id: EVT_PROCESSING, status: "processing", processedAt: null }),
    stripeEvent({ endpoint: "connect_accounts", type: "account.updated" }),
  ];
}

// ---- The mocked platform API: a small in-memory platform that keeps what the actions change -------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function noContent(status: number): Response {
  return new Response(null, { status, headers: { "content-length": "0" } });
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
        requestId: "req_api_pad012",
        ...(details === undefined ? {} : { details }),
        ...(fieldErrors === undefined ? {} : { fieldErrors }),
      },
    },
    status,
    headers,
  );
}

/** What the API holds; each test starts from the same fleet. */
const fleet = {
  plans: initialPlans(),
  prices: initialPrices(),
  subscriptions: initialSubscriptions(),
  events: initialEvents(),
  /** Stripe does not answer: comparisons answer `502 PROVIDER_ERROR`. */
  stripeDown: false,
};

function resetFleet(): void {
  fleet.plans = initialPlans();
  fleet.prices = initialPrices();
  fleet.subscriptions = initialSubscriptions();
  fleet.events = initialEvents();
  fleet.stripeDown = false;
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  return (await request.clone().json()) as Record<string, unknown>;
}

/** The comparison of PBE-048 (`price-check.ts`), as the fake Stripe account answers it. */
function compare(plan: AdminPlan): PlanPriceWarning[] {
  const warnings: PlanPriceWarning[] = [];
  const links = [
    ["stripePriceIdMonth", plan.monthlyPrice.amount, "month"],
    ["stripePriceIdYear", plan.annualPrice?.amount ?? null, "year"],
  ] as const;
  for (const [link, planAmount, interval] of links) {
    const priceId = plan[link];
    if (priceId === null) {
      continue;
    }
    const price = fleet.prices.get(priceId);
    if (price === undefined) {
      warnings.push({ field: `${link}.active`, expected: "true", actual: null });
      continue;
    }
    if (price.amount !== planAmount) {
      warnings.push({ field: `${link}.amount`, expected: planAmount, actual: price.amount });
    }
    if (price.currency !== plan.currency) {
      warnings.push({ field: `${link}.currency`, expected: plan.currency, actual: price.currency });
    }
    if (price.interval !== interval) {
      warnings.push({ field: `${link}.interval`, expected: interval, actual: price.interval });
    }
    if (!price.active) {
      warnings.push({ field: `${link}.active`, expected: "true", actual: "false" });
    }
  }
  return warnings;
}

const STRIPE_LINKS = ["stripeProductId", "stripePriceIdMonth", "stripePriceIdYear"] as const;

/**
 * `adminUpdatePlan` with the Stripe ids: `412` for a stale `If-Match`, `502` while Stripe is down, `400 same_price`,
 * `409 stripe_price_taken`, and the comparison's warnings when a link changed; a request that changes nothing keeps the
 * version.
 */
async function updatePlanRoute(request: Request): Promise<Response> {
  const code = new URL(request.url).pathname.split("/").at(-1);
  const index = fleet.plans.findIndex((plan) => plan.code === code);
  const current = fleet.plans[index];
  if (current === undefined) {
    return apiError("NOT_FOUND", 404);
  }
  if (request.headers.get("if-match") !== `"${current.version}"`) {
    return apiError("PRECONDITION_FAILED", 412);
  }
  const body = (await bodyOf(request)) as Schemas["UpdatePlanRequest"];
  const next: AdminPlan = { ...current, ...body };
  if (next.stripePriceIdMonth !== null && next.stripePriceIdMonth === next.stripePriceIdYear) {
    const path = body.stripePriceIdYear === undefined ? "/stripePriceIdMonth" : "/stripePriceIdYear";
    return apiError("VALIDATION_FAILED", 400, undefined, [{ path, code: "same_price" }]);
  }
  const others = fleet.plans.filter((plan) => plan.code !== code);
  for (const priceId of [next.stripePriceIdMonth, next.stripePriceIdYear]) {
    if (
      priceId !== null &&
      others.some((plan) => plan.stripePriceIdMonth === priceId || plan.stripePriceIdYear === priceId)
    ) {
      return apiError("CONFLICT", 409, { reason: "stripe_price_taken" });
    }
  }
  const changed = STRIPE_LINKS.some((link) => next[link] !== current[link]);
  if (!changed) {
    return json(current, 200, { etag: `"${current.version}"` });
  }
  if (fleet.stripeDown) {
    return apiError("PROVIDER_ERROR", 502, { provider: "stripe" });
  }
  const updated: AdminPlan = {
    ...next,
    checkoutAvailable: { month: next.stripePriceIdMonth !== null, year: next.stripePriceIdYear !== null },
    priceWarnings: compare(next),
    version: current.version + 1,
  };
  fleet.plans[index] = updated;
  return json(updated, 200, { etag: `"${updated.version}"` });
}

/** `adminCheckPlanPrices`: the comparison again, stored as the plan's warnings without a new version. */
function checkPricesRoute(request: Request): Response {
  const code = new URL(request.url).pathname.split("/").at(-2);
  const index = fleet.plans.findIndex((plan) => plan.code === code);
  const current = fleet.plans[index];
  if (current === undefined) {
    return apiError("NOT_FOUND", 404);
  }
  if (fleet.stripeDown) {
    return apiError("PROVIDER_ERROR", 502, { provider: "stripe" });
  }
  const warnings = compare(current);
  fleet.plans[index] = { ...current, priceWarnings: warnings };
  return json({ warnings }, 200);
}

function subscriptionDetail(id: string): Response {
  const row = fleet.subscriptions.find((candidate) => candidate.id === id);
  if (row === undefined) {
    return apiError("NOT_FOUND", 404);
  }
  const linked = row.providerSubscriptionId !== null;
  return json(
    {
      subscription: row,
      invoices: linked ? [INVOICE_EUR] : [],
      events: linked ? fleet.events.filter((event) => event.tenantId === row.tenantId) : [],
    },
    200,
    { etag: `"${row.version}"` },
  );
}

/** `adminResyncSubscription`: Stripe says the subscription is past due now; manual and unlinked rows answer `409`. */
function resyncRoute(request: Request): Response {
  const id = new URL(request.url).pathname.split("/").at(-2);
  const index = fleet.subscriptions.findIndex((row) => row.id === id);
  const current = fleet.subscriptions[index];
  if (current === undefined) {
    return apiError("NOT_FOUND", 404);
  }
  if (current.billingProvider === "manual") {
    return apiError("CONFLICT", 409, { reason: "manual" });
  }
  if (current.providerSubscriptionId === null) {
    return apiError("CONFLICT", 409, { reason: "not_linked" });
  }
  const resynced: AdminSubscription = {
    ...current,
    status: "past_due",
    currentPeriodStart: "2027-04-01T00:00:00Z",
    currentPeriodEnd: "2027-05-01T00:00:00Z",
    version: current.version + 1,
  };
  fleet.subscriptions[index] = resynced;
  return json(resynced, 200, { etag: `"${resynced.version}"` });
}

/** `adminListInvoices`: newest first, filtered by `status` and `tenantId`; a second page behind a cursor. */
function listInvoices(request: Request): Response {
  const query = new URL(request.url).searchParams;
  if (query.get("cursor") !== null) {
    return json({ data: [], page: { nextCursor: null, limit: 50 } }, 200);
  }
  const data = [INVOICE_EUR, INVOICE_JPY].filter(
    (invoice) =>
      (query.get("status") === null || invoice.status === query.get("status")) &&
      (query.get("tenantId") === null || invoice.tenantId === query.get("tenantId")),
  );
  return json({ data, page: { nextCursor: "inv_page_2", limit: 50 } }, 200);
}

/** `adminListStripeEvents`: failed and ignored first, filtered by `status`, `type` and `tenantId`. */
function listEvents(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const data = fleet.events.filter(
    (event) =>
      (query.get("status") === null || event.status === query.get("status")) &&
      (query.get("type") === null || event.type === query.get("type")) &&
      (query.get("tenantId") === null || event.tenantId === query.get("tenantId")),
  );
  return json({ data, page: { nextCursor: null, limit: 50 } }, 200);
}

/** `adminReprocessStripeEvent`: a failed or ignored event goes back to received; any other status answers `409`. */
function reprocessRoute(request: Request): Response {
  const id = new URL(request.url).pathname.split("/").at(-2);
  const index = fleet.events.findIndex((event) => event.id === id);
  const current = fleet.events[index];
  if (current === undefined) {
    return apiError("NOT_FOUND", 404);
  }
  if (current.status !== "failed" && current.status !== "ignored") {
    return apiError("CONFLICT", 409, { reason: current.status });
  }
  fleet.events[index] = { ...current, status: "received" };
  return noContent(202);
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call by `METHOD /path`; unexpected calls fail the test. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    [`GET ${PLANS_PATH}`]: () => json({ data: [...fleet.plans] }, 200),
    [`PATCH ${GROWTH_PATH}`]: updatePlanRoute,
    [`POST ${CHECK_PATH}`]: checkPricesRoute,
    [`GET ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}`]: () => subscriptionDetail(MANUAL_ID),
    [`GET ${SUBSCRIPTIONS_PATH}/${STRIPE_ID}`]: () => subscriptionDetail(STRIPE_ID),
    [`GET ${SUBSCRIPTIONS_PATH}/${UNLINKED_ID}`]: () => subscriptionDetail(UNLINKED_ID),
    [`POST ${RESYNC_PATH}`]: resyncRoute,
    [`POST ${SUBSCRIPTIONS_PATH}/${MANUAL_ID}/resync`]: resyncRoute,
    [`GET ${INVOICES_PATH}`]: listInvoices,
    [`GET ${EVENTS_PATH}`]: listEvents,
    ...Object.fromEntries(
      [EVT_FAILED, EVT_IGNORED, EVT_RECEIVED, EVT_PROCESSING, EVT_PROCESSED].map((id) => [
        `POST ${EVENTS_PATH}/${id}/reprocess`,
        reprocessRoute,
      ]),
    ),
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

/** The bodies of the calls of `METHOD /path` so far; `null` for a call without one. */
async function bodies(method: string, path: string): Promise<unknown[]> {
  return Promise.all(
    calls(method, path).map(async (request) => {
      const text = await request.clone().text();
      return text === "" ? null : (JSON.parse(text) as unknown);
    }),
  );
}

/** The query of the one call of `GET path`, as sorted entries. */
function queryOfCall(path: string): [string, string][] {
  const [call, ...more] = calls("GET", path);
  expect(more).toHaveLength(0);
  if (call === undefined) {
    throw new Error(`no call of ${path}`);
  }
  return [...new URL(call.url).searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Every call carries the admin session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The cookie store of the request. */
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
      "x-request-id": "req_pad012_admin",
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

async function openPage(pathname: string, search: string, page: () => Promise<ReactElement>): Promise<View> {
  setUrl(pathname, search);
  const view = render(await page());
  return {
    rerender: async () => {
      view.rerender(await page());
    },
  };
}

function planPage(planCode = "growth"): Promise<ReactElement> {
  return PlanPage({ params: Promise.resolve({ planCode }) });
}

function openPlan(): Promise<View> {
  return openPage("/plans/growth", "", () => planPage());
}

function subscriptionPage(subscriptionId: string): Promise<ReactElement> {
  return SubscriptionPage({ params: Promise.resolve({ subscriptionId }) });
}

function openSubscription(subscriptionId: string): Promise<View> {
  return openPage(`/subscriptions/${subscriptionId}`, "", () => subscriptionPage(subscriptionId));
}

function invoicesPage(search = ""): Promise<ReactElement> {
  return InvoicesPage({ searchParams: searchParamsOf(search) });
}

function openInvoices(search = ""): Promise<View> {
  return openPage("/invoices", search, () => invoicesPage(search));
}

function eventsPage(search = ""): Promise<ReactElement> {
  return StripeEventsPage({ searchParams: searchParamsOf(search) });
}

function openEvents(search = ""): Promise<View> {
  return openPage("/stripe-events", search, () => eventsPage(search));
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

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.append(name, value);
  }
  return data;
}

/** The notice of the action that just answered (`data-notice="…"`), once it shows. */
async function notice(
  kind: "done" | "saved" | "checked" | "failed",
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

function revalidated(): string[] {
  return nextCache.revalidatePath.mock.calls.map(([path]) => path as string);
}

/** "Link Stripe prices" on the plan's page. */
function stripeSection(): HTMLElement {
  return screen.getByRole("region", { name: SP.title });
}

/** The field of the Stripe form named `name`, with its hint, its message and its warnings. */
function stripeField(name: "stripeProductId" | "stripePriceIdMonth" | "stripePriceIdYear"): HTMLElement {
  const element = stripeSection().querySelector<HTMLElement>(`[data-stripe-field="${name}"]`);
  if (element === null) {
    throw new Error(`no field ${name}`);
  }
  return element;
}

function stripeInput(name: "stripeProductId" | "stripePriceIdMonth" | "stripePriceIdYear"): HTMLInputElement {
  const input = stripeField(name).querySelector<HTMLInputElement>("input");
  if (input === null) {
    throw new Error(`no input ${name}`);
  }
  return input;
}

function typeId(name: "stripeProductId" | "stripePriceIdMonth" | "stripePriceIdYear", value: string): void {
  fireEvent.change(stripeInput(name), { target: { value } });
}

/** The warnings shown next to a price, as the `data-warning` fields of their items. */
function warningFields(name: "stripePriceIdMonth" | "stripePriceIdYear"): (string | null)[] {
  return [...stripeField(name).querySelectorAll("[data-warning]")].map((item) =>
    item.getAttribute("data-warning"),
  );
}

/**
 * The one row of the table that shows `text` (an invoice number, an event id); the text may show more than once in it
 * (an event's button names its event for screen readers).
 */
function rowWith(text: string): HTMLElement {
  const rows = new Set(screen.getAllByText(text).map((element) => element.closest("tr")));
  const [row, ...more] = [...rows];
  if (row === undefined || row === null || more.length > 0) {
    throw new Error(`no single row with ${text}`);
  }
  return row;
}

/** Opens the confirmation of the button named `name` in `container` and answers it with `answer`. */
async function confirmWith(
  name: string,
  answer: string,
  container: HTMLElement = document.body,
): Promise<HTMLElement> {
  fireEvent.click(within(container).getByRole("button", { name }));
  const dialog = await screen.findByRole("alertdialog", {}, UI_WAIT);
  fireEvent.click(within(dialog).getByRole("button", { name: answer }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), UI_WAIT);
  return dialog;
}

/** The props of every element of `component` in a server component's output (the client props Next.js would send). */
function propsOf(node: ReactNode, component: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isValidElement(value)) {
      const { type, props } = value as ReactElement<Record<string, unknown>>;
      if (type === component) {
        found.push(props);
      }
      visit(props["children"]);
    }
  };
  visit(node);
  return found;
}

// ---- The platform document -------------------------------------------------------------------------------------------

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

/** The lines of the platform OpenAPI document, read once by the warm-up hook (it is large). */
let platformDocument: readonly string[] = [];

/**
 * What an operation of the platform document requires of the admin (PADR-0006 items 4 and 5): `x-reason-required`
 * (a reason in the body) and `x-mfa-step-up` (a TOTP verification in the last 15 minutes), read from its block.
 */
function operationRequirements(operationId: string): { reason: boolean; stepUp: boolean } {
  const start = platformDocument.findIndex((text) => text.trim() === `operationId: ${operationId}`);
  expect(start).toBeGreaterThan(-1);
  const block: string[] = [];
  for (const text of platformDocument.slice(start + 1)) {
    // The next operation of the path, or the next path.
    if (/^\s+operationId:/.test(text) || /^ {2}\//.test(text)) {
      break;
    }
    block.push(text.trim());
  }
  return { reason: block.includes("x-reason-required: true"), stepUp: block.includes("x-mfa-step-up: true") };
}

// ---- Hooks -------------------------------------------------------------------------------------------------------------

/**
 * Once per file, before any test: reading the platform document, the first render of these pages in a fresh worker
 * (the Stripe form, the tables, the filter bar, the dialogs) and the first server action through the real API client
 * are the slowest steps, and on a busy CI runner they would otherwise land in the first test's own five seconds.
 * Nothing of it stays: each test gets a fresh platform and an empty document.
 */
beforeAll(async () => {
  platformDocument = readFileSync(
    join(repositoryRoot(), "platform/backend/openapi/velexis-platform-api.openapi.yaml"),
    "utf8",
  ).split("\n");
  resetPlatformApi();
  await openPlan();
  typeId("stripeProductId", "not a product");
  submit(SP.save, stripeSection());
  await screen.findByText(SP.productInvalid, {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openSubscription(STRIPE_ID);
  fireEvent.click(screen.getByRole("button", { name: R.resync }));
  await screen.findByRole("alertdialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openInvoices();
  cleanup();
  await openEvents();
  cleanup();
  await linkStripePrices(
    {
      status: "idle",
      values: { stripeProductId: "", stripePriceIdMonth: "", stripePriceIdYear: "" },
      fieldErrors: {},
    },
    formData({ planCode: "growth", version: "2", stripeProductId: PRODUCT }),
  );
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The state "Link Stripe prices" starts from when a test calls the action directly. */
const IDLE_LINK: StripePricesState = {
  status: "idle",
  values: { stripeProductId: "", stripePriceIdMonth: "", stripePriceIdYear: "" },
  fieldErrors: {},
};

// ---- /plans/[planCode]: Link Stripe prices ----------------------------------------------------------------------------

describe("plans/[planCode]/page.tsx: Link Stripe prices", () => {
  it("[PAD-012 AC1] a price warning shows next to its price and does not block the save [PF-88]", async () => {
    const view = await openPlan();
    const section = stripeSection();
    // Nothing is linked yet: no warning, and nothing to compare.
    expect(within(section).getByText(SP.checkNothingLinked)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: SP.check })).toBeNull();

    typeId("stripeProductId", PRODUCT);
    typeId("stripePriceIdMonth", PRICE_MONTH_NEW);
    typeId("stripePriceIdYear", PRICE_YEAR);
    submit(SP.save, section);

    // The save is a save: the warning comes with it.
    expect((await notice("saved", section)).textContent).toBe(SP.savedWithWarnings(1));
    const [patch] = calls("PATCH", GROWTH_PATH);
    expectSessionHeaders(patch);
    expect(patch?.headers.get("if-match")).toBe('"2"');
    // Exactly the three ids: neither a reason nor a step-up is asked for, and no other field of the plan is sent.
    expect(await bodies("PATCH", GROWTH_PATH)).toEqual([
      { stripeProductId: PRODUCT, stripePriceIdMonth: PRICE_MONTH_NEW, stripePriceIdYear: PRICE_YEAR },
    ]);
    expect(revalidated()).toEqual(["/plans/growth", "/plans"]);
    expect(fleet.plans[0]).toMatchObject({ stripePriceIdMonth: PRICE_MONTH_NEW, version: 3 });

    // Next to the monthly price, in words, the amounts as money in the plan's currency; none next to the yearly one.
    expect(warningFields("stripePriceIdMonth")).toEqual(["stripePriceIdMonth.amount"]);
    const month = stripeField("stripePriceIdMonth");
    expect(within(month).getByText(SP.warningCount(1))).toBeTruthy();
    expect(within(month).getByText(PRICE_WARNING_ATTRIBUTES.amount)).toBeTruthy();
    expect(within(month).getByText("€149.00")).toBeTruthy();
    expect(within(month).getByText("€159.00")).toBeTruthy();
    // The field tells a screen reader about its warnings.
    const describedBy = stripeInput("stripePriceIdMonth").getAttribute("aria-describedby") ?? "";
    const warningsId = month.querySelector("[data-warnings]")?.getAttribute("id") ?? "";
    expect(describedBy.split(" ")).toContain(warningsId);
    expect(warningFields("stripePriceIdYear")).toEqual([]);
    expect(within(stripeField("stripePriceIdYear")).getByText(SP.noWarning)).toBeTruthy();
    // The saved fields stay, and the revalidated page shows Checkout of both intervals open, with the same warning.
    expect(stripeInput("stripePriceIdMonth").value).toBe(PRICE_MONTH_NEW);
    await view.rerender();
    const summary = screen.getByRole("region", { name: PLAN_DETAIL_STRINGS.stripeTitle });
    expect(within(summary).getAllByText(PLAN_DETAIL_STRINGS.checkoutOpen)).toHaveLength(2);
    expect(within(summary).queryByText(PLAN_DETAIL_STRINGS.checkoutClosed)).toBeNull();
    expect(warningFields("stripePriceIdMonth")).toEqual(["stripePriceIdMonth.amount"]);
    expect(stripeInput("stripePriceIdMonth").value).toBe(PRICE_MONTH_NEW);

    // A second save with the warning still there is not refused: it sends the new version and clears the warning.
    typeId("stripePriceIdMonth", PRICE_MONTH);
    submit(SP.save, stripeSection());
    await waitFor(() => expect(calls("PATCH", GROWTH_PATH)).toHaveLength(2), UI_WAIT);
    expect(calls("PATCH", GROWTH_PATH)[1]?.headers.get("if-match")).toBe('"3"');
    await waitFor(() => expect(within(section).getByText(SP.saved)).toBeTruthy(), UI_WAIT);
    expect(warningFields("stripePriceIdMonth")).toEqual([]);
    expect(fleet.plans[0]).toMatchObject({ stripePriceIdMonth: PRICE_MONTH, priceWarnings: [], version: 4 });
  });

  it("[PAD-012 AC1] Check prices compares the saved prices again and shows the new warnings next to them [PF-88]", async () => {
    fleet.plans[0] = linkedGrowth();
    const view = await openPlan();
    const section = stripeSection();
    expect(warningFields("stripePriceIdYear")).toEqual([]);

    // The yearly price was archived in the Stripe dashboard.
    fleet.prices.set(PRICE_YEAR, { amount: "1490.00", currency: "EUR", interval: "year", active: false });
    fireEvent.click(within(section).getByRole("button", { name: SP.check }));

    expect((await notice("checked", section)).textContent).toBe(SP.checkedSome(1));
    expect(await bodies("POST", CHECK_PATH)).toEqual([null]);
    expectSessionHeaders(calls("POST", CHECK_PATH)[0]);
    expect(revalidated()).toEqual(["/plans/growth", "/plans"]);
    expect(warningFields("stripePriceIdYear")).toEqual(["stripePriceIdYear.active"]);
    const year = stripeField("stripePriceIdYear");
    expect(within(year).getByText(PRICE_WARNING_ATTRIBUTES.active)).toBeTruthy();
    expect(within(year).getByText(SP.archived)).toBeTruthy();
    expect(warningFields("stripePriceIdMonth")).toEqual([]);

    // A check does not change the version: the next save still sends the one the page was rendered with.
    await view.rerender();
    expect(warningFields("stripePriceIdYear")).toEqual(["stripePriceIdYear.active"]);
    typeId("stripePriceIdYear", "");
    submit(SP.save, stripeSection());
    expect((await notice("saved", stripeSection())).textContent).toBe(SP.saved);
    expect(calls("PATCH", GROWTH_PATH)[0]?.headers.get("if-match")).toBe('"3"');
    expect(warningFields("stripePriceIdYear")).toEqual([]);

    // Stripe does not answer: the warnings shown stay those of the last comparison.
    fleet.prices.set(PRICE_MONTH, { amount: "149.00", currency: "EUR", interval: "month", active: false });
    fleet.stripeDown = true;
    fireEvent.click(within(stripeSection()).getByRole("button", { name: SP.check }));
    const failed = await notice("failed", stripeSection());
    expect(failed.textContent).toBe(SP.checkProviderError);
    expect(failed.getAttribute("data-code")).toBe("PROVIDER_ERROR");
    expect(warningFields("stripePriceIdMonth")).toEqual([]);
  });

  it("shows the stored warnings of every attribute in words next to their price, and only there [FIX-W43-PLATFORM AC2]", async () => {
    fleet.plans[0] = linkedGrowth({
      annualPrice: null,
      priceWarnings: [
        { field: "stripePriceIdMonth.amount", expected: "149.00", actual: "159.00" },
        { field: "stripePriceIdMonth.currency", expected: "EUR", actual: "USD" },
        { field: "stripePriceIdMonth.interval", expected: "month", actual: "3 month" },
        { field: "stripePriceIdYear.amount", expected: null, actual: "1490.00" },
        { field: "stripePriceIdYear.active", expected: "true", actual: null },
      ],
    });
    await openPlan();

    const month = stripeField("stripePriceIdMonth");
    expect(warningFields("stripePriceIdMonth")).toEqual([
      "stripePriceIdMonth.amount",
      "stripePriceIdMonth.currency",
      "stripePriceIdMonth.interval",
    ]);
    expect(within(month).getByText(SP.warningCount(3))).toBeTruthy();
    // Stripe's amount is in the price's own currency, which the currency warning names: $159.00, never €159.00.
    for (const text of ["€149.00", "$159.00", "EUR", "USD", "Monthly", SP.everyN("3", "month")]) {
      expect(within(month).getByText(text)).toBeTruthy();
    }
    expect(within(month).queryByText("€159.00")).toBeNull();
    const year = stripeField("stripePriceIdYear");
    expect(warningFields("stripePriceIdYear")).toEqual([
      "stripePriceIdYear.amount",
      "stripePriceIdYear.active",
    ]);
    expect(within(year).getByText(SP.warningCount(2))).toBeTruthy();
    // A plan without a yearly price says so in the hint and in the warning; a price Stripe does not know is named.
    expect(within(year).getByText(SP.yearHintNoAnnual)).toBeTruthy();
    expect(within(year).getByText(SP.noAnnualPrice)).toBeTruthy();
    expect(within(year).getByText("€1,490.00")).toBeTruthy();
    expect(within(year).getByText(PRICE_WARNING_ATTRIBUTES.active)).toBeTruthy();
    expect(within(year).getByText(SP.unknownPrice)).toBeTruthy();
    // The Stripe summary above only counts the same comparison: its raw table of the warnings is gone, so they show in
    // words next to their price only (lead decision (5k) of 2026-11-05) [FIX-W43-PLATFORM AC2].
    const summary = screen.getByRole("region", { name: PLAN_DETAIL_STRINGS.stripeTitle });
    expect(within(summary).getByText(PLAN_STRINGS.priceWarnings(5))).toBeTruthy();
    expect(within(summary).queryByRole("table")).toBeNull();
    expect(within(summary).queryByText("stripePriceIdYear.active")).toBeNull();
    expect(screen.queryAllByText(/^stripePrice(?:IdMonth|IdYear)\.[a-z]+$/)).toEqual([]);
  });

  it("reads Stripe's amount of a price in another currency back with that currency's decimals", async () => {
    // The API answers both amounts with the plan currency's decimals: a JPY price of 5000 yen on an EUR plan comes as
    // "50.00" (subscription-billing flow §A, note of PBE-048), a EUR price of 149.00 on a JPY plan as "14900".
    expect(shiftDecimalPoint("50.00", 2)).toBe("5000");
    expect(shiftDecimalPoint("14900", -2)).toBe("149.00");
    expect(shiftDecimalPoint("5", -3)).toBe("0.005");
    expect(shiftDecimalPoint("0.5", 1)).toBe("5");
    expect(shiftDecimalPoint("149.00", 0)).toBe("149.00");
    expect(stripeAmountOf("50.00", "EUR", "JPY")).toEqual({ amount: "5000", currency: "JPY" });
    expect(stripeAmountOf("14900", "JPY", "EUR")).toEqual({ amount: "149.00", currency: "EUR" });
    expect(stripeAmountOf("1.490", "KWD", "EUR")).toEqual({ amount: "14.90", currency: "EUR" });
    expect(stripeAmountOf("159.00", "EUR", "USD")).toEqual({ amount: "159.00", currency: "USD" });
    expect(stripeAmountOf("159.00", "EUR", "EUR")).toEqual({ amount: "159.00", currency: "EUR" });

    fleet.plans[0] = linkedGrowth({
      priceWarnings: [
        { field: "stripePriceIdMonth.amount", expected: "149.00", actual: "50.00" },
        { field: "stripePriceIdMonth.currency", expected: "EUR", actual: "JPY" },
        // Without a currency warning the price is in the plan's currency.
        { field: "stripePriceIdYear.amount", expected: "1490.00", actual: "1590.00" },
      ],
    });
    await openPlan();
    const month = stripeField("stripePriceIdMonth");
    expect(within(month).getByText("€149.00")).toBeTruthy();
    expect(within(month).getByText("¥5,000")).toBeTruthy();
    expect(within(month).queryByText("€50.00")).toBeNull();
    const year = stripeField("stripePriceIdYear");
    expect(within(year).getByText("€1,490.00")).toBeTruthy();
    expect(within(year).getByText("€1,590.00")).toBeTruthy();
  });

  it("refuses an invalid id and one price for both intervals at their fields, without calling the API", async () => {
    await openPlan();
    const section = stripeSection();
    typeId("stripeProductId", "price_1QxGrowthMonthEur");
    typeId("stripePriceIdMonth", "price 1");
    submit(SP.save, section);
    await within(section).findByText(SP.productInvalid, {}, UI_WAIT);
    expect(within(stripeField("stripePriceIdMonth")).getByText(SP.priceInvalid)).toBeTruthy();
    expect(stripeInput("stripeProductId").getAttribute("aria-invalid")).toBe("true");
    // The focus moves to the first field with a problem.
    await waitFor(() => expect(document.activeElement).toBe(stripeInput("stripeProductId")), UI_WAIT);

    typeId("stripeProductId", PRODUCT);
    typeId("stripePriceIdMonth", PRICE_MONTH);
    typeId("stripePriceIdYear", ` ${PRICE_MONTH} `);
    submit(SP.save, section);
    await within(stripeField("stripePriceIdYear")).findByText(SP.samePrice, {}, UI_WAIT);
    expect(within(section).queryByText(SP.productInvalid)).toBeNull();
    // What was typed stays.
    expect(stripeInput("stripePriceIdYear").value).toBe(` ${PRICE_MONTH} `);
    expect(calls("PATCH", GROWTH_PATH)).toHaveLength(0);
  });

  it("words the API's refusals: another plan's price, same_price, a stale version and a Stripe failure", async () => {
    await openPlan();
    const section = stripeSection();

    // A price another plan links.
    typeId("stripePriceIdMonth", PRICE_SCALE);
    submit(SP.save, section);
    const taken = await notice("failed", section);
    expect(taken.textContent).toBe(SP.priceTaken);
    expect(taken.getAttribute("data-code")).toBe("CONFLICT");
    expect(stripeInput("stripePriceIdMonth").value).toBe(PRICE_SCALE);

    // Stripe does not answer: nothing is saved.
    fleet.stripeDown = true;
    typeId("stripePriceIdMonth", PRICE_MONTH);
    submit(SP.save, section);
    await waitFor(() => expect(within(section).getByText(SP.saveProviderError)).toBeTruthy(), UI_WAIT);
    expect(fleet.plans[0]?.stripePriceIdMonth).toBeNull();
    fleet.stripeDown = false;

    // The API's same_price lands at its field.
    routes({
      [`PATCH ${GROWTH_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, undefined, [{ path: "/stripePriceIdMonth", code: "same_price" }]),
    });
    submit(SP.save, section);
    await within(stripeField("stripePriceIdMonth")).findByText(SP.samePrice, {}, UI_WAIT);

    // Someone saved the plan meanwhile: reload, with a link that reloads the page fully.
    routes();
    fleet.plans[0] = adminPlan({ version: 5 });
    submit(SP.save, section);
    await waitFor(() => expect(within(section).getByText(SP.stale)).toBeTruthy(), UI_WAIT);
    expect(hrefOf(link(SP.reload, section))).toBe("/plans/growth");
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("words a Stripe failure of Edit the plan: a new price of a linked plan is compared before the save", async () => {
    fleet.plans[0] = linkedGrowth();
    routes({ [`PATCH ${GROWTH_PATH}`]: () => apiError("PROVIDER_ERROR", 502, { provider: "stripe" }) });
    await openPlan();
    const form = screen.getByRole("form", { name: PLAN_FORM_STRINGS.editTitle });
    const price = within(form).getByLabelText(PLAN_FORM_STRINGS.monthlyPriceLabel("EUR")) as HTMLInputElement;
    fireEvent.change(price, { target: { value: "159.00" } });
    submit(PLAN_FORM_STRINGS.save, form);

    const failed = await notice("failed", form);
    expect(failed.getAttribute("data-code")).toBe("PROVIDER_ERROR");
    expect(within(failed).getByText(PLAN_FORM_STRINGS.providerError)).toBeTruthy();
    // Nothing was saved: what was typed stays, and nothing is revalidated.
    expect(price.value).toBe("159.00");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("takes a newer plan of the page unless the admin typed, whose save is then refused as stale", async () => {
    const view = await openPlan();
    // Another admin linked the prices meanwhile; the revalidated page brings them into the untouched form.
    fleet.plans[0] = linkedGrowth();
    await view.rerender();
    expect(stripeInput("stripePriceIdMonth").value).toBe(PRICE_MONTH);
    expect(within(stripeSection()).getByRole("button", { name: SP.check })).toBeTruthy();

    // Typed ids are kept when a newer plan arrives, with the version they were typed on: the save is stale.
    typeId("stripeProductId", "prod_QxGrowthOther");
    fleet.plans[0] = linkedGrowth({ version: 4 });
    await view.rerender();
    expect(stripeInput("stripeProductId").value).toBe("prod_QxGrowthOther");
    submit(SP.save, stripeSection());
    const stale = await notice("failed", stripeSection());
    expect(stale.textContent).toContain(SP.stale);
    expect(calls("PATCH", GROWTH_PATH)[0]?.headers.get("if-match")).toBe('"3"');
    expect(fleet.plans[0]?.stripeProductId).toBe(PRODUCT);
  });

  it("unlinks with empty fields, after which there is nothing to compare", async () => {
    fleet.plans[0] = linkedGrowth();
    await openPlan();
    const section = stripeSection();
    for (const name of ["stripeProductId", "stripePriceIdMonth", "stripePriceIdYear"] as const) {
      typeId(name, "");
    }
    submit(SP.save, section);
    expect((await notice("saved", section)).textContent).toBe(SP.savedNoPrice);
    expect(await bodies("PATCH", GROWTH_PATH)).toEqual([
      { stripeProductId: null, stripePriceIdMonth: null, stripePriceIdYear: null },
    ]);
    expect(within(section).queryByRole("button", { name: SP.check })).toBeNull();
    expect(within(section).getByText(SP.checkNothingLinked)).toBeTruthy();
  });

  it("the server actions refuse made-up fields without a call, and send an ended session to sign-in and back", async () => {
    for (const fields of [
      { stripePriceIdMonth: PRICE_MONTH },
      { planCode: "../tenants", version: "2", stripePriceIdMonth: PRICE_MONTH },
      { planCode: "growth", version: "0", stripePriceIdMonth: PRICE_MONTH },
    ]) {
      expect(await linkStripePrices(IDLE_LINK, formData(fields))).toMatchObject({
        status: "failed",
        code: "VALIDATION_FAILED",
        message: SP.formExpired,
      });
    }
    expect(await checkPlanPrices({ status: "idle" }, formData({ planCode: "Growth Plus" }))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: SP.formExpired,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    routes({
      [`PATCH ${GROWTH_PATH}`]: () => apiError("TOKEN_EXPIRED", 401),
      [`POST ${CHECK_PATH}`]: () => apiError("UNAUTHENTICATED", 401),
    });
    const signIn = `/sign-in?${new URLSearchParams({ next: "/plans/growth" }).toString()}`;
    await expect(
      linkStripePrices(IDLE_LINK, formData({ planCode: "growth", version: "2", stripeProductId: PRODUCT })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(navigation.redirect).toHaveBeenLastCalledWith(signIn);
    await expect(checkPlanPrices({ status: "idle" }, formData({ planCode: "growth" }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(navigation.redirect).toHaveBeenLastCalledWith(signIn);

    // A step-up request keeps what was typed, so the same ids go again after the code.
    routes({ [`PATCH ${GROWTH_PATH}`]: () => apiError("REAUTH_REQUIRED", 401) });
    const stepUp = await linkStripePrices(
      IDLE_LINK,
      formData({ planCode: "growth", version: "2", stripePriceIdMonth: PRICE_MONTH }),
    );
    expect(stepUp).toMatchObject({ stepUp: true, values: { stripePriceIdMonth: PRICE_MONTH } });
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("hands the Stripe form only the plan fields it shows, whatever else the answer holds", async () => {
    const sentinel = "PAD012-SENTINEL-PLAN";
    routes({
      [`GET ${PLANS_PATH}`]: () =>
        json(
          {
            data: [
              {
                ...linkedGrowth({
                  priceWarnings: [
                    { field: "stripePriceIdMonth.amount", expected: "149.00", actual: "159.00" },
                  ],
                }),
                stripeSecret: sentinel,
                priceWarnings: [
                  { field: "stripePriceIdMonth.amount", expected: "149.00", actual: "159.00", raw: sentinel },
                ],
              },
            ],
          },
          200,
        ),
    });
    const page = await planPage();
    const [props, ...more] = propsOf(page, StripePricesForm);
    expect(more).toHaveLength(0);
    expect(props).toEqual({
      planCode: "growth",
      currency: "EUR",
      hasAnnualPrice: true,
      link: {
        stripeProductId: PRODUCT,
        stripePriceIdMonth: PRICE_MONTH,
        stripePriceIdYear: PRICE_YEAR,
        priceWarnings: [{ field: "stripePriceIdMonth.amount", expected: "149.00", actual: "159.00" }],
        version: 3,
      },
    });
    expect(JSON.stringify(props)).not.toContain(sentinel);
  });
});

// ---- /subscriptions/[subscriptionId]: Resync from Stripe --------------------------------------------------------------

describe("subscriptions/[subscriptionId]/page.tsx: Resync from Stripe, invoices and Stripe events", () => {
  it("[PAD-012 AC2] offers Resync from Stripe only on a Stripe row with a Stripe subscription [PF-89]", async () => {
    await openSubscription(STRIPE_ID);
    expect(screen.getByRole("button", { name: R.resync })).toBeTruthy();
    expect(screen.getByText(SUBSCRIPTION_DETAIL_STRINGS.stripeBilled)).toBeTruthy();
    cleanup();

    // A manual trial is edited, never resynced.
    await openSubscription(MANUAL_ID);
    expect(screen.queryByRole("button", { name: R.resync })).toBeNull();
    expect(screen.getByRole("region", { name: MANUAL_SUBSCRIPTION_STRINGS.title })).toBeTruthy();
    cleanup();

    // A Stripe row whose Checkout has not completed has nothing to fetch.
    await openSubscription(UNLINKED_ID);
    expect(screen.queryByRole("button", { name: R.resync })).toBeNull();
    expect(screen.getByText(R.notLinked)).toBeTruthy();
    expect(calls("POST", `${SUBSCRIPTIONS_PATH}/${UNLINKED_ID}/resync`)).toHaveLength(0);
  });

  it("[PAD-012 AC2] resyncs after a confirmation, without a body, and shows the status Stripe has now [PF-89]", async () => {
    const view = await openSubscription(STRIPE_ID);
    fireEvent.click(screen.getByRole("button", { name: R.resync }));
    const dialog = await screen.findByRole("alertdialog", { name: R.confirmTitle }, UI_WAIT);
    expect(dialog.textContent).toContain(R.confirmDescription);
    // Cancelling sends nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), UI_WAIT);
    expect(calls("POST", RESYNC_PATH)).toHaveLength(0);

    await confirmWith(R.resync, R.confirm);
    const done = await notice("done");
    expect(done.textContent).toContain(R.done);
    expect(within(done).getByText("Past due")).toBeTruthy();
    expect(await bodies("POST", RESYNC_PATH)).toEqual([null]);
    expectSessionHeaders(calls("POST", RESYNC_PATH)[0]);
    expect(revalidated()).toEqual([
      `/subscriptions/${STRIPE_ID}`,
      "/subscriptions",
      `/tenants/${NORDIC_ID}`,
      "/",
    ]);

    // The revalidated page shows the row as Stripe has it now.
    await view.rerender();
    const summary = screen.getByRole("region", { name: SUBSCRIPTION_DETAIL_STRINGS.summaryTitle });
    expect(within(summary).getByText("Past due")).toBeTruthy();
  });

  it("words every refusal of a resync, so the admin knows what to fix", async () => {
    const input = formData({ subscriptionId: STRIPE_ID, tenantId: NORDIC_ID });
    const cases: [Response, string, string][] = [
      [apiError("CONFLICT", 409, { reason: "manual" }), "CONFLICT", R.conflicts["manual"] ?? ""],
      [apiError("CONFLICT", 409, { reason: "not_linked" }), "CONFLICT", R.conflicts["not_linked"] ?? ""],
      [
        apiError("CONFLICT", 409, { reason: "unknown_price" }),
        "CONFLICT",
        R.conflicts["unknown_price"] ?? "",
      ],
      [
        apiError("CONFLICT", 409, { reason: "subscription_busy" }),
        "CONFLICT",
        R.conflicts["subscription_busy"] ?? "",
      ],
      [
        apiError("CONFLICT", 409, { reason: "tenant_not_billable" }),
        "CONFLICT",
        R.conflicts["tenant_not_billable"] ?? "",
      ],
      [apiError("CONFLICT", 409, { reason: "some_new_reason" }), "CONFLICT", R.otherConflict],
      [apiError("PROVIDER_ERROR", 502, { provider: "stripe" }), "PROVIDER_ERROR", R.providerError],
      [apiError("NOT_FOUND", 404), "NOT_FOUND", R.subscriptionGone],
      [
        apiError("RATE_LIMITED", 429, {}, undefined, { "retry-after": "30" }),
        "RATE_LIMITED",
        R.rateLimitedFor(30),
      ],
    ];
    for (const [answer, code, message] of cases) {
      expect(message).not.toBe("");
      routes({ [`POST ${RESYNC_PATH}`]: () => answer.clone() });
      expect(await resyncSubscription({ status: "idle" }, input)).toEqual({
        status: "failed",
        code,
        message,
      });
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // Through the page: the refusal shows in the admin's words, never the API's.
    routes({ [`POST ${RESYNC_PATH}`]: () => apiError("CONFLICT", 409, { reason: "unknown_price" }) });
    await openSubscription(STRIPE_ID);
    await confirmWith(R.resync, R.confirm);
    const failed = await notice("failed");
    expect(failed.textContent).toBe(R.conflicts["unknown_price"]);
    expect(failed.getAttribute("data-code")).toBe("CONFLICT");
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("the resync refuses made-up ids without a call and sends an ended session to sign-in and back", async () => {
    for (const fields of [
      { subscriptionId: STRIPE_ID },
      { subscriptionId: "sub_123", tenantId: NORDIC_ID },
      { subscriptionId: STRIPE_ID, tenantId: "../admins" },
    ]) {
      expect(await resyncSubscription({ status: "idle" }, formData(fields))).toEqual({
        status: "failed",
        code: "VALIDATION_FAILED",
        message: R.formExpired,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`POST ${RESYNC_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(
      resyncSubscription({ status: "idle" }, formData({ subscriptionId: STRIPE_ID, tenantId: NORDIC_ID })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(navigation.redirect).toHaveBeenLastCalledWith(
      `/sign-in?${new URLSearchParams({ next: `/subscriptions/${STRIPE_ID}` }).toString()}`,
    );
  });

  it("links the OTA's invoices and Stripe events, and opens Stripe's pages without opener or referrer", async () => {
    await openSubscription(STRIPE_ID);
    expect(hrefOf(link(SUBSCRIPTION_DETAIL_STRINGS.allInvoicesOfOta))).toBe(
      `/invoices?tenantId=${NORDIC_ID}`,
    );
    expect(hrefOf(link(SUBSCRIPTION_DETAIL_STRINGS.allEventsOfOta))).toBe(
      `/stripe-events?tenantId=${NORDIC_ID}`,
    );
    const invoices = screen.getByRole("region", { name: SUBSCRIPTION_DETAIL_STRINGS.invoicesTitle });
    for (const anchor of within(invoices).getAllByRole("link", { name: /of invoice/ })) {
      expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
      expect(anchor.getAttribute("href")?.startsWith("https://")).toBe(true);
    }
    const events = screen.getByRole("region", { name: SUBSCRIPTION_DETAIL_STRINGS.eventsTitle });
    expect(within(events).getByText(EVT_FAILED)).toBeTruthy();
    expect(
      within(events).getByText(SUBSCRIPTION_DETAIL_STRINGS.eventsReprocessHint, { exact: false }),
    ).toBeTruthy();
  });
});

// ---- /invoices ---------------------------------------------------------------------------------------------------------

describe("invoices/page.tsx: the invoices of every OTA", () => {
  it("[PAD-012] lists every OTA's invoices with their amounts in their currency and their Stripe links [PF-89]", async () => {
    await openInvoices();
    expect(queryOfCall(INVOICES_PATH)).toEqual([]);
    expectSessionHeaders(calls("GET", INVOICES_PATH)[0]);
    expect(screen.getByRole("heading", { level: 1, name: I.title })).toBeTruthy();

    const eur = rowWith(INVOICE_EUR.number);
    for (const text of ["Open", "in_1QzNo4Pr1Tv6Xy", "€0.00"]) {
      expect(within(eur).getByText(text)).toBeTruthy();
    }
    expect(within(eur).getAllByText("€149.00")).toHaveLength(2);
    expect(hrefOf(link(NORDIC_ID, eur))).toBe(`/tenants/${NORDIC_ID}?tab=subscription`);
    expect(hrefOf(link(STRIPE_ID, eur))).toBe(`/subscriptions/${STRIPE_ID}`);
    for (const [name, href] of [
      [I.invoicePage, INVOICE_EUR.hostedInvoiceUrl],
      [I.invoicePdf, INVOICE_EUR.invoicePdfUrl],
    ] as const) {
      const anchor = link(`${name}${I.invoiceOf(INVOICE_EUR.number)}`, eur);
      expect(hrefOf(anchor)).toBe(href);
      expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    }

    // A currency without decimals keeps none; a link that is not https is not a link; no subscription row says so.
    const jpy = rowWith(INVOICE_JPY.number);
    expect(within(jpy).getAllByText("¥5,000")).toHaveLength(2);
    expect(within(jpy).getByText("¥0")).toBeTruthy();
    expect(within(jpy).getByText(I.noSubscription)).toBeTruthy();
    expect(within(jpy).queryByRole("link", { name: /of invoice/ })).toBeNull();
    expect(document.body.innerHTML).not.toContain("invoice.example.test");

    // The next page keeps the filters of the URL.
    expect(hrefOf(link(TABLE_STRINGS.nextPage))).toBe("/invoices?cursor=inv_page_2");
  });

  it("filters by status and OTA in the URL, and the pages keep the filters", async () => {
    await openInvoices(`status=open&tenantId=${NORDIC_ID}`);
    expect(queryOfCall(INVOICES_PATH)).toEqual([
      ["status", "open"],
      ["tenantId", NORDIC_ID],
    ]);
    expect(screen.queryByText(INVOICE_JPY.number)).toBeNull();
    expect(screen.getByText(INVOICE_EUR.number)).toBeTruthy();
    const filters = screen.getByRole("search", { name: I.filtersLabel });
    expect((within(filters).getByLabelText(I.statusLabel) as HTMLSelectElement).value).toBe("open");
    expect((within(filters).getByLabelText(I.tenantLabel) as HTMLInputElement).value).toBe(NORDIC_ID);
    // The list of one OTA links the OTA and the same filters for every OTA.
    expect(screen.getByText(I.oneTenant)).toBeTruthy();
    expect(hrefOf(link(I.everyTenant))).toBe("/invoices?status=open");
    expect(hrefOf(link(TABLE_STRINGS.nextPage))).toBe(
      `/invoices?status=open&tenantId=${NORDIC_ID}&cursor=inv_page_2`,
    );
    cleanup();

    // On a later page, "First page" keeps the filters and drops the cursor.
    fetchMock.mockClear();
    await openInvoices("status=open&cursor=inv_page_2");
    expect(queryOfCall(INVOICES_PATH)).toEqual([
      ["cursor", "inv_page_2"],
      ["status", "open"],
    ]);
    expect(hrefOf(link(TABLE_STRINGS.firstPage))).toBe("/invoices?status=open");
    expect(screen.getByText(I.empty)).toBeTruthy();
  });

  it("refuses filters the API would refuse without a call, and words failures and an ended session", async () => {
    for (const search of [
      "status=refunded",
      "tenantId=acme",
      "status=open&status=paid",
      `cursor=${"x".repeat(513)}`,
    ]) {
      await openInvoices(search);
      expect(screen.getByText(I.invalidFilters)).toBeTruthy();
      expect(hrefOf(link(I.showAll))).toBe("/invoices");
      cleanup();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`GET ${INVOICES_PATH}`]: () => apiError("VALIDATION_FAILED", 400, undefined, []) });
    await openInvoices("cursor=stale");
    expect(screen.getByText(I.invalidFilters)).toBeTruthy();
    cleanup();

    routes({ [`GET ${INVOICES_PATH}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openInvoices();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(I.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.INTERNAL_ERROR);
    cleanup();

    routes({ [`GET ${INVOICES_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(invoicesPage()).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });
});

// ---- /stripe-events ----------------------------------------------------------------------------------------------------

describe("stripe-events/page.tsx: the Stripe webhook inbox", () => {
  it("[PAD-012 AC2] lists failed and ignored events first and offers Reprocess on those only [PF-89]", async () => {
    await openEvents();
    expect(queryOfCall(EVENTS_PATH)).toEqual([]);
    expectSessionHeaders(calls("GET", EVENTS_PATH)[0]);

    // The API's order: failed and ignored first.
    const ids = [...document.querySelectorAll("tbody tr")].map(
      (row) => row.querySelector(".font-mono")?.textContent,
    );
    expect(ids).toEqual([EVT_FAILED, EVT_IGNORED, EVT_RECEIVED, EVT_PROCESSING, EVT_PROCESSED]);

    const failed = rowWith(EVT_FAILED);
    for (const text of ["customer.subscription.updated", "Failed", "5", "Billing"]) {
      expect(within(failed).getByText(text)).toBeTruthy();
    }
    expect(within(failed).getByText(/UNKNOWN_PRICE: price_1QzNo5Pr2Tv7XyNew is not linked/)).toBeTruthy();
    expect(hrefOf(link(NORDIC_ID, failed))).toBe(`/tenants/${NORDIC_ID}?tab=subscription`);
    expect(within(rowWith(EVT_IGNORED)).getByText(E.noTenant)).toBeTruthy();
    expect(within(rowWith(EVT_PROCESSED)).getByText("Connect accounts")).toBeTruthy();

    // Reprocess only where the API takes it.
    const offered = [EVT_FAILED, EVT_IGNORED, EVT_RECEIVED, EVT_PROCESSING, EVT_PROCESSED].filter(
      (id) =>
        within(rowWith(id)).queryByRole("button", { name: `${EA.reprocess}${EA.eventSuffix(id)}` }) !== null,
    );
    expect(offered).toEqual([EVT_FAILED, EVT_IGNORED]);
    // Looking at the inbox changes nothing.
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("[PAD-012 AC2] reprocesses a failed event after a confirmation, without a body, and shows it queued [PF-89]", async () => {
    const path = `${EVENTS_PATH}/${EVT_FAILED}/reprocess`;
    const view = await openEvents();
    const name = `${EA.reprocess}${EA.eventSuffix(EVT_FAILED)}`;
    const dialog = await confirmWith(name, EA.confirm, rowWith(EVT_FAILED));
    expect(dialog.textContent).toContain(EA.confirmTitle(EVT_FAILED));
    expect(dialog.textContent).toContain(EA.confirmDescription("customer.subscription.updated"));

    expect((await notice("done")).textContent).toBe(EA.done(EVT_FAILED));
    expect(await bodies("POST", path)).toEqual([null]);
    expectSessionHeaders(calls("POST", path)[0]);
    expect(revalidated()).toEqual(["/stripe-events", "/"]);

    // The revalidated inbox shows the event received again, with nothing more to reprocess.
    await view.rerender();
    const row = rowWith(EVT_FAILED);
    expect(within(row).getByText("Received")).toBeTruthy();
    expect(within(row).queryByRole("button", { name })).toBeNull();
    expect(screen.getByText(EA.done(EVT_FAILED))).toBeTruthy();
  });

  it("words the 409 of an event the worker or another admin moved, a gone event and a rate limit", async () => {
    for (const [id, status] of [
      [EVT_RECEIVED, "received"],
      [EVT_PROCESSING, "processing"],
      [EVT_PROCESSED, "processed"],
    ] as const) {
      expect(await reprocessStripeEvent({ status: "idle" }, formData({ eventId: id }))).toEqual({
        status: "failed",
        code: "CONFLICT",
        message: EA.conflicts[status],
      });
    }
    const gone = "evt_1QzGone0000000000000000";
    routes({ [`POST ${EVENTS_PATH}/${gone}/reprocess`]: () => apiError("NOT_FOUND", 404) });
    expect(await reprocessStripeEvent({ status: "idle" }, formData({ eventId: gone }))).toEqual({
      status: "failed",
      code: "NOT_FOUND",
      message: EA.eventGone,
    });
    routes({
      [`POST ${EVENTS_PATH}/${EVT_FAILED}/reprocess`]: () =>
        apiError("RATE_LIMITED", 429, {}, undefined, { "retry-after": "20" }),
    });
    expect(await reprocessStripeEvent({ status: "idle" }, formData({ eventId: EVT_FAILED }))).toEqual({
      status: "failed",
      code: "RATE_LIMITED",
      message: EA.rateLimitedFor(20),
    });
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // Through the page: the worker took the event between the render and the click.
    routes();
    await openEvents();
    fleet.events[0] = { ...(fleet.events[0] as AdminStripeEvent), status: "processing" };
    await confirmWith(`${EA.reprocess}${EA.eventSuffix(EVT_FAILED)}`, EA.confirm, rowWith(EVT_FAILED));
    const failed = await notice("failed");
    expect(failed.textContent).toBe(EA.conflicts["processing"]);
    expect(document.body.textContent).not.toContain("The API's own text");

    // Made-up ids send nothing; an ended session signs in again and comes back to the inbox.
    fetchMock.mockClear();
    for (const eventId of ["", "evt_", "evt_../admins", `evt_${"a".repeat(260)}`]) {
      expect(await reprocessStripeEvent({ status: "idle" }, formData({ eventId }))).toEqual({
        status: "failed",
        code: "VALIDATION_FAILED",
        message: EA.formExpired,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    routes({ [`POST ${EVENTS_PATH}/${EVT_FAILED}/reprocess`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(reprocessStripeEvent({ status: "idle" }, formData({ eventId: EVT_FAILED }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(navigation.redirect).toHaveBeenLastCalledWith(
      `/sign-in?${new URLSearchParams({ next: "/stripe-events" }).toString()}`,
    );
  });

  it("filters by status, exact type and OTA in the URL; filters the API would refuse call nothing", async () => {
    await openEvents(`status=failed&type=customer.subscription.updated&tenantId=${NORDIC_ID}`);
    expect(queryOfCall(EVENTS_PATH)).toEqual([
      ["status", "failed"],
      ["tenantId", NORDIC_ID],
      ["type", "customer.subscription.updated"],
    ]);
    expect(rowWith(EVT_FAILED)).toBeTruthy();
    expect(screen.queryByText(EVT_IGNORED)).toBeNull();
    const filters = screen.getByRole("search", { name: E.filtersLabel });
    expect((within(filters).getByLabelText(E.typeLabel) as HTMLInputElement).value).toBe(
      "customer.subscription.updated",
    );
    cleanup();

    fetchMock.mockClear();
    for (const search of [
      "status=done",
      "type=invoice",
      "type=Invoice.Paid",
      "tenantId=nordic",
      "status=failed&status=ignored",
    ]) {
      await openEvents(search);
      expect(screen.getByText(E.invalidFilters)).toBeTruthy();
      expect(hrefOf(link(E.showAll))).toBe("/stripe-events");
      cleanup();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`GET ${EVENTS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openEvents();
    expect(screen.getByRole("alert").textContent).toContain(E.unavailableTitle);
    cleanup();
    routes({ [`GET ${EVENTS_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(eventsPage()).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });

  it("hands the client table only the fields it shows", async () => {
    const sentinel = "PAD012-SENTINEL-EVENT";
    routes({
      [`GET ${EVENTS_PATH}`]: () =>
        json(
          {
            data: initialEvents().map((event) => ({ ...event, payload: sentinel })),
            page: { nextCursor: null, limit: 50 },
          },
          200,
        ),
    });
    const page = await eventsPage();
    const [props, ...more] = propsOf(page, StripeEventTable);
    expect(more).toHaveLength(0);
    expect(JSON.stringify(props)).not.toContain(sentinel);
    expect(Object.keys((props?.["events"] as Record<string, unknown>[])[0] ?? {}).sort()).toEqual([
      "attempts",
      "endpoint",
      "id",
      "lastError",
      "processedAt",
      "receivedAt",
      "status",
      "tenantId",
      "type",
    ]);
  });
});

// ---- The operations ------------------------------------------------------------------------------------------------

describe("the operations of the platform document", () => {
  it("ask for neither a reason nor a step-up, so the actions send none", () => {
    for (const operationId of [
      "adminUpdatePlan",
      "adminCheckPlanPrices",
      "adminResyncSubscription",
      "adminReprocessStripeEvent",
      "adminListInvoices",
      "adminListStripeEvents",
    ]) {
      expect(operationRequirements(operationId)).toEqual({ reason: false, stepUp: false });
    }
  });
});
