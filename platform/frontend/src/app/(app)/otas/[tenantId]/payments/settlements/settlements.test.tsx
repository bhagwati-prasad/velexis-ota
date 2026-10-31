// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import type { ReactElement } from "react";
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

import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import {
  savePayoutAccount,
  type PayoutState,
} from "@/app/(app)/otas/[tenantId]/payments/payout-account/actions";
import PayoutAccountPage from "@/app/(app)/otas/[tenantId]/payments/payout-account/page";
import {
  GET as downloadLines,
  HEAD as headLines,
} from "@/app/(app)/otas/[tenantId]/payments/settlements/[settlementId]/lines.csv/route";
import SettlementPage from "@/app/(app)/otas/[tenantId]/payments/settlements/[settlementId]/page";
import SettlementsPage from "@/app/(app)/otas/[tenantId]/payments/settlements/page";
import {
  feeRate,
  statementFileName,
  statementMonth,
} from "@/app/(app)/otas/[tenantId]/payments/settlements/statements";
import { formatDateTime } from "@/components/date-time";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  ERROR_MESSAGES,
  FORM_STRINGS,
  NOT_ALLOWED_STRINGS,
  PAYOUT_ACCOUNT_STRINGS,
  ROLE_LABELS,
  SETTLEMENTS_STRINGS,
  STATUS_LABELS,
  STEP_UP_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, bank account or statement) ----------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type PayoutAccount = Schemas["PayoutAccount"];
type SettlementSummary = Schemas["SettlementSummary"];
type Settlement = Schemas["Settlement"];

const ACCESS_TOKEN = "pfe025-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-025 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const PAYOUT_PATH = `${TENANT_PATH}/payout-account`;
const SETTLEMENTS_PATH = `${TENANT_PATH}/settlements`;
const STEP_UP_PATH = "/v1/auth/step-up";
const PAYOUT_PAGE = `/otas/${TENANT_ID}/payments/payout-account`;
const SETTLEMENTS_PAGE = `/otas/${TENANT_ID}/payments/settlements`;
/** The text of an API answer; it must never reach the page. */
const API_TEXT = "The API's own text";

/** A valid Norwegian test IBAN (the document's example) as a person types it, and as the API stores it. */
const TYPED_IBAN = " no93 8601 1117 947 ";
const NORMALISED_IBAN = "NO9386011117947";
/** The same IBAN with one digit changed: its mod-97 check fails. */
const WRONG_CHECKSUM_IBAN = "NO93 8601 1117 948";
const ACCOUNT_NUMBER = "000123456789";
const ROUTING_NUMBER = "110000000";

/** Statement ids (`stl_` + ULID). */
const PAID_ID = "stl_01JC7T1V5X9Z3B7D1F5H9K3N7Q";
const APPROVED_ID = "stl_01JD9W3Y7A1C5E9G3J7M1Q5S9V";
const CARRIED_ID = "stl_01JB5R9T3V7X1Z5B9D3F7H1K5M";
const DRAFT_ID = "stl_01JE1A2B3C4D5E6F7G8H9J0K1M";

/** The fixtures' instants are relative to the start of the file, never a calendar date. */
const START = Date.now();
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
function at(offsetMs: number): string {
  return new Date(START + offsetMs).toISOString();
}

/** The first instant (UTC) of the calendar month `monthsBack` months before the file's start. */
function monthStart(monthsBack: number): string {
  const now = new Date(START);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1)).toISOString();
}

/** The month of a period as the pages name it, worked out here with `Intl` in UTC. */
function monthLabel(periodStart: string): string {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    Date.parse(periodStart),
  );
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
    planCode: "early_access",
    defaultCurrency: "NOK",
    countryCode: "NO",
    timeZone: "Europe/Oslo",
    supportEmail: null,
    storefrontEnvironment: "test",
    liveEnabledAt: null,
    primaryHost: "acme.ota.example.com",
    schemaVersion: "0002_m1",
    createdAt: at(-60 * DAY_MS),
    activatedAt: at(-60 * DAY_MS),
    version: 4,
    myRole: "owner",
    ...overrides,
  };
}

/** The masked account of `getPayoutAccount`: never a bank number, `last4` only. */
function payoutAccount(overrides: Partial<PayoutAccount> = {}): PayoutAccount {
  return {
    accountHolderName: "Acme Travel AS",
    countryCode: "NO",
    currency: "NOK",
    scheme: "iban",
    last4: "7947",
    status: "pending_review",
    reviewNote: null,
    updatedAt: at(-2 * DAY_MS),
    version: 1,
    ...overrides,
  };
}

const MONEY = (amount: string): Schemas["Money"] => ({ amount, currency: "EUR" });

/** The statements of `listSettlements`, newest period first. */
const PAID_PERIOD = monthStart(2);
const APPROVED_PERIOD = monthStart(1);
const CARRIED_PERIOD = monthStart(3);

function summary(overrides: Partial<SettlementSummary> = {}): SettlementSummary {
  return {
    id: PAID_ID,
    periodStart: PAID_PERIOD,
    periodEnd: APPROVED_PERIOD,
    currency: "EUR",
    status: "paid",
    netAmount: MONEY("8935.10"),
    paidAt: new Date(Date.parse(APPROVED_PERIOD) + 6 * DAY_MS).toISOString(),
    ...overrides,
  };
}

const STATEMENTS: readonly SettlementSummary[] = [
  summary({
    id: APPROVED_ID,
    periodStart: APPROVED_PERIOD,
    periodEnd: monthStart(0),
    status: "approved",
    netAmount: MONEY("11204.87"),
    paidAt: null,
  }),
  summary(),
  summary({
    id: CARRIED_ID,
    periodStart: CARRIED_PERIOD,
    periodEnd: PAID_PERIOD,
    status: "carried_forward",
    netAmount: MONEY("-79.48"),
    paidAt: null,
  }),
];

/** The paid statement with its totals (the document's example amounts). */
function settlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    ...summary(),
    grossAmount: MONEY("9600.00"),
    refundsAmount: MONEY("249.00"),
    disputesAmount: MONEY("0.00"),
    stripeFeesAmount: MONEY("139.40"),
    velexisFeesAmount: MONEY("187.02"),
    adjustmentsAmount: MONEY("-89.48"),
    feeBps: 200,
    lineCount: 41,
    payoutReference: "VX-SETTLE-ACME-0001",
    notes: "Includes the balance carried from the statement before.",
    ...overrides,
  };
}

/** The CSV of `downloadSettlementLines` (the document's columns; dummy ids). */
const CSV_TEXT = [
  "type,occurredAt,amount,stripeFee,paymentIntentId,velexisPaymentId,checkoutId,description",
  `charge,${PAID_PERIOD},1249.00,18.36,pi_3QDummyCharge01,pay_01JC2H6K0N4Q8S2V6X0Z4B8D2F,chk_01JC2H5J9M3P7R1T5W9Y3A7C1E,Booking 7Q4M2X`,
  `refund,${PAID_PERIOD},-249.00,0.00,pi_3QDummyCharge01,pay_01JC2H6K0N4Q8S2V6X0Z4B8D2F,chk_01JC2H5J9M3P7R1T5W9Y3A7C1E,Partial refund`,
  "",
].join("\r\n");

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An error envelope of the platform API; its `message` and the field errors' messages must never reach the page. */
function apiError(
  code: string,
  status: number,
  options: { fieldErrors?: readonly { path: string; code: string }[]; headers?: Record<string, string> } = {},
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: `${API_TEXT}, never shown`,
        status,
        requestId: "req_api_pfe025",
        ...(options.fieldErrors === undefined
          ? {}
          : {
              fieldErrors: options.fieldErrors.map((fieldError) => ({
                ...fieldError,
                message: `${API_TEXT} of a field`,
              })),
            }),
      },
    }),
    { status, headers: { "content-type": "application/json", ...options.headers } },
  );
}

/** The body of a call, read from a copy so the request stays readable. */
async function bodyOf(request: Request | undefined): Promise<Record<string, unknown>> {
  if (request === undefined) {
    throw new Error("No such call.");
  }
  return (await request.clone().json()) as Record<string, unknown>;
}

/**
 * The API's answer to `setPayoutAccount` for `before` (the stored account, or none): the masked account of the body
 * sent, back in `pending_review` with the next version and no review note, as a change is saved.
 */
async function saved(request: Request, before: PayoutAccount | null): Promise<Response> {
  const body = await bodyOf(request);
  const number = String(body["iban"] ?? body["accountNumber"] ?? "").replace(/[^A-Za-z0-9]/g, "");
  return json(
    payoutAccount({
      accountHolderName: String(body["accountHolderName"]),
      countryCode: String(body["countryCode"]),
      currency: String(body["currency"]),
      scheme: body["scheme"] === "local" ? "local" : "iban",
      last4: number.slice(-4).toUpperCase(),
      status: "pending_review",
      reviewNote: null,
      updatedAt: at(0),
      version: (before?.version ?? 0) + 1,
    }),
    200,
  );
}

/** A new portal session, as `POST /v1/auth/step-up` answers it (dummy tokens). */
function steppedUpSession(): Response {
  return json(
    {
      accessToken: "pfe025-dummy-stepped-up-access-token",
      accessTokenExpiresAt: at(15 * MINUTE_MS),
      refreshToken: "pfe025-dummy-stepped-up-refresh-token",
      refreshTokenExpiresAt: at(DAY_MS),
      account: {
        id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
        email: "anna@acme-travel.example.com",
        fullName: "Anna Berg",
        emailVerified: true,
        mfaEnabled: true,
      },
    },
    200,
  );
}

/** `downloadSettlementLines`: the CSV text with the API's headers. */
function csvAnswer(): Response {
  return new Response(CSV_TEXT, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="velexis-statement-2000-01-EUR.csv"',
      "cache-control": "no-store",
    },
  });
}

type Route = (request: Request) => Response | Promise<Response>;

/**
 * Answers each call by `METHOD /path`: by default an active owner's OTA with a pending payout account, the three
 * statements, each statement's totals and its CSV, and a save of any account. A new answer table is a new request,
 * with nothing cached and no call counted from the one before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  fetchMock.mockClear();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${PAYOUT_PATH}`]: () => json(payoutAccount(), 200),
    [`PUT ${PAYOUT_PATH}`]: (request) => saved(request, payoutAccount()),
    [`POST ${STEP_UP_PATH}`]: () => steppedUpSession(),
    [`GET ${SETTLEMENTS_PATH}`]: () => json({ data: STATEMENTS }, 200),
    [`GET ${SETTLEMENTS_PATH}/${PAID_ID}`]: () => json(settlement(), 200),
    [`GET ${SETTLEMENTS_PATH}/${PAID_ID}/lines.csv`]: () => csvAnswer(),
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

/** Every call so far other than the layout's `getTenant`, as `METHOD /path`. */
function callsBesidesTenant(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => `${input.method} ${new URL(input.url).pathname}`)
    .filter((call) => call !== `GET ${TENANT_PATH}`);
}

/** Every call carries the session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined, token = ACCESS_TOKEN): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

function statementParams(
  settlementId: string,
  tenantId = TENANT_ID,
): Promise<{ tenantId: string; settlementId: string }> {
  return Promise.resolve({ tenantId, settlementId });
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/** One page as the OTA layout and the page render it for one request. */
async function openPage(page: Promise<ReactElement | null>): Promise<void> {
  render(await OtaLayout({ children: await page, params: params() }));
}

const openPayout = () => openPage(PayoutAccountPage({ params: params() }));
const openList = () => openPage(SettlementsPage({ params: params() }));
const openStatement = (settlementId = PAID_ID) =>
  openPage(SettlementPage({ params: statementParams(settlementId) }));

/** A page's element, as Next.js renders it below the layout. */
async function elementOf(page: Promise<ReactElement | null>): Promise<ReactElement> {
  const element = await page;
  if (element === null) {
    throw new Error("The page rendered nothing.");
  }
  return element;
}

/** The text of the masked account's detail called `term`. */
function detail(term: string): string {
  const terms = [...document.querySelectorAll("[data-payout-account] dt")];
  const found = terms.find((element) => element.textContent === term);
  return found?.nextElementSibling?.textContent ?? `<no ${term}>`;
}

/** The owners' form. */
function payoutForm(): HTMLFormElement {
  return screen.getByRole("form", {
    name: new RegExp(`^(${PAYOUT_ACCOUNT_STRINGS.formTitleAdd}|${PAYOUT_ACCOUNT_STRINGS.formTitleChange})$`),
  });
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
  return within(payoutForm()).getByLabelText(label);
}

function type(label: string, value: string): void {
  fireEvent.change(field(label), { target: { value } });
}

function chooseScheme(label: string): void {
  fireEvent.click(within(payoutForm()).getByLabelText(label));
}

/** Submits the form of `button` as a click on it would. */
function submit(button: HTMLElement): void {
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is in no form.");
  }
  fireEvent.submit(form, { submitter: button });
}

function savePayout(): void {
  submit(within(payoutForm()).getByRole("button", { name: PAYOUT_ACCOUNT_STRINGS.submit }));
}

/** Fills the IBAN account of the document's example: holder, country, currency, IBAN and BIC. */
function fillIbanAccount(): void {
  type(PAYOUT_ACCOUNT_STRINGS.holderLabel, "  Acme Travel AS ");
  type(PAYOUT_ACCOUNT_STRINGS.countryLabel, "NO");
  type(PAYOUT_ACCOUNT_STRINGS.currencyLabel, "NOK");
  chooseScheme(PAYOUT_ACCOUNT_STRINGS.schemeIban);
  type(PAYOUT_ACCOUNT_STRINGS.ibanLabel, TYPED_IBAN);
  type(PAYOUT_ACCOUNT_STRINGS.bicLabel, "dnbanokk");
}

/**
 * The notice after a save (a status message), or `null`. Read from the document: while the step-up dialog is open, the
 * page behind it is hidden from the accessibility tree, so the form cannot be found by its role.
 */
function savedNotice(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-payout-form] [data-saved]");
}

/** The error summary of the form, or `null`. */
function summaryOfForm(): HTMLElement | null {
  return within(payoutForm()).queryByRole("alert", { name: FORM_STRINGS.errorSummaryTitle });
}

function summaryItems(): string[] {
  const element = summaryOfForm();
  return element === null ? [] : [...element.querySelectorAll("li")].map((item) => item.textContent ?? "");
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: Element): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

/** The page shows the not-allowed page for `role`, with the way back, and nothing of the payout account or statements. */
function expectNotAllowed(role: TenantRole): void {
  expect(document.querySelector('[data-page="not-allowed"]')).not.toBeNull();
  expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
    NOT_ALLOWED_STRINGS.title,
  ]);
  expect(screen.getByText(NOT_ALLOWED_STRINGS.intro(ROLE_LABELS[role]))).toBeTruthy();
  expect(document.querySelector("[data-payout-account], [data-payout-form], [data-settlement]")).toBeNull();
}

/** The form data of a submission, built field by field (a forged or old form). */
function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
}

const IBAN_FORM = {
  tenantId: TENANT_ID,
  accountHolderName: "Acme Travel AS",
  countryCode: "NO",
  currency: "NOK",
  scheme: "iban",
  iban: TYPED_IBAN,
  bic: "dnbanokk",
} as const;

const LOCAL_FORM = {
  tenantId: TENANT_ID,
  accountHolderName: "Acme Travel Inc.",
  countryCode: "US",
  currency: "USD",
  scheme: "local",
  accountNumber: ACCOUNT_NUMBER,
  routingNumber: ROUTING_NUMBER,
} as const;

const IDLE: PayoutState = {
  status: "idle",
  values: { accountHolderName: "", countryCode: "NO", currency: "NOK", scheme: "iban" },
  fieldErrors: {},
};

/**
 * The wait for what a server action renders: the action runs the real `lib/api.ts` over the mocked fetch, which on a
 * busy CI runner can outlast Testing Library's 1 s default. It stays well inside the test's own budget.
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
  navigation.pathname = PAYOUT_PAGE;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe025_portal",
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
 * client, Testing Library and React's DOM on their first run, and the payout form's 400 country and currency options)
 * and the first save through the action are the slowest, and on a busy CI runner they otherwise land in the first
 * test's own five seconds. The hook only stops if it hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: the payout account page opened and an account saved through the action, the list and
 * a statement opened, the CSV route run, and the payout page rendered on the server and hydrated, so the test bodies
 * hold only the steps they check. Nothing of it stays: each test gets a fresh API (`resetPlatformApi`), fresh mocks and
 * globals (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  await openPayout();
  fillIbanAccount();
  savePayout();
  await waitFor(() => expect(savedNotice()).not.toBeNull(), { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  routes();
  await openList();
  cleanup();
  routes();
  await openStatement();
  cleanup();
  routes();
  await (
    await downloadLines(new Request("https://platform.example.com/x"), { params: statementParams(PAID_ID) })
  ).text();
  routes();
  const { root } = await serverRenderAndHydrate(await elementOf(PayoutAccountPage({ params: params() })));
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The payout account ---------------------------------------------------------------------------------------------

describe("the payout account page", () => {
  it("[PFE-025 AC1] shows the payout account masked, with its review status, to owners [PF-64 AC1]", async () => {
    await openPayout();

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      PAYOUT_ACCOUNT_STRINGS.title,
    ]);
    expect(detail(PAYOUT_ACCOUNT_STRINGS.holder)).toBe("Acme Travel AS");
    expect(detail(PAYOUT_ACCOUNT_STRINGS.country)).toBe("Norway");
    expect(detail(PAYOUT_ACCOUNT_STRINGS.currency)).toBe("NOK");
    expect(detail(PAYOUT_ACCOUNT_STRINGS.scheme)).toBe("IBAN");
    // The number is masked: the dots are hidden from screen readers, which read "Ending in 7947".
    const masked = document.querySelector<HTMLElement>("[data-masked-number]");
    expect(masked?.textContent).toBe(
      `${PAYOUT_ACCOUNT_STRINGS.endingIn}${PAYOUT_ACCOUNT_STRINGS.maskDots}7947`,
    );
    expect(masked?.querySelector('[aria-hidden="true"]')?.textContent).toBe(PAYOUT_ACCOUNT_STRINGS.maskDots);
    expect(detail(PAYOUT_ACCOUNT_STRINGS.status)).toBe(STATUS_LABELS.payoutAccount.pending_review);
    expect(document.querySelector("[data-status-explanation]")?.textContent).toBe(
      PAYOUT_ACCOUNT_STRINGS.statusExplanations["pending_review"],
    );
    expect(detail(PAYOUT_ACCOUNT_STRINGS.updatedAt)).toBe(
      formatDateTime(payoutAccount().updatedAt, { timeZone: "Europe/Oslo" }),
    );
    // No full number anywhere: the API never answers one, and the form's number fields start empty.
    expect(document.body.innerHTML).not.toContain("8601");
    expect((field(PAYOUT_ACCOUNT_STRINGS.ibanLabel) as HTMLInputElement).value).toBe("");
    // The form starts with the stored holder, country, currency and scheme.
    expect(field(PAYOUT_ACCOUNT_STRINGS.holderLabel).value).toBe("Acme Travel AS");
    expect(field(PAYOUT_ACCOUNT_STRINGS.countryLabel).value).toBe("NO");
    expect(field(PAYOUT_ACCOUNT_STRINGS.currencyLabel).value).toBe("NOK");

    const [read, ...more] = calls("GET", PAYOUT_PATH);
    expect(more).toHaveLength(0);
    expectSessionHeaders(read);
    expect(callsBesidesTenant()).toEqual([`GET ${PAYOUT_PATH}`]);
  });

  it("[PFE-025 AC1] finance members read the masked account, without a form or a write [PF-64 AC1]", async () => {
    routesAs("finance");
    await openPayout();

    expect(document.querySelector("[data-masked-number]")?.textContent).toContain("7947");
    expect(detail(PAYOUT_ACCOUNT_STRINGS.status)).toBe(STATUS_LABELS.payoutAccount.pending_review);
    expect(screen.getByText(PAYOUT_ACCOUNT_STRINGS.roleNote)).toBeTruthy();
    expect(document.querySelector("[data-payout-form]")).toBeNull();
    expect(document.querySelector("form input[name], form select")).toBeNull();
    expect(screen.queryByRole("button", { name: PAYOUT_ACCOUNT_STRINGS.submit })).toBeNull();
    expect(callsBesidesTenant()).toEqual([`GET ${PAYOUT_PATH}`]);
  });

  it("[PFE-025 AC1] the form says that saving asks for a step-up and sends the account back to pending review", async () => {
    await openPayout();
    const note = payoutForm().closest("section")?.querySelector("[data-step-up-note]");
    expect(note?.textContent).toBe(PAYOUT_ACCOUNT_STRINGS.formIntro);
    expect(PAYOUT_ACCOUNT_STRINGS.formIntro).toContain("authenticator app");
    expect(PAYOUT_ACCOUNT_STRINGS.formIntro).toContain("pending review");
    expect(PAYOUT_ACCOUNT_STRINGS.formIntro).toContain("rejected account again");
    expect(screen.getByRole("heading", { name: PAYOUT_ACCOUNT_STRINGS.formTitleChange })).toBeTruthy();
  });

  it("[PFE-025 AC1] editing needs a step-up: the save asks for a code and is sent again with it [PF-64 AC1]", async () => {
    let first = true;
    routes({
      [`PUT ${PAYOUT_PATH}`]: (request) => {
        if (first) {
          first = false;
          return apiError("REAUTH_REQUIRED", 401);
        }
        return saved(request, payoutAccount());
      },
    });
    await openPayout();
    fillIbanAccount();
    savePayout();

    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    // Nothing is saved yet: the API refused the first attempt.
    expect(savedNotice()).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), {
      target: { value: "492039" },
    });
    submit(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.submit }));

    await waitFor(
      () => expect(savedNotice()?.textContent).toBe(PAYOUT_ACCOUNT_STRINGS.savedPending),
      ACTION_WAIT,
    );
    const [stepUp, ...moreStepUps] = calls("POST", STEP_UP_PATH);
    expect(moreStepUps).toHaveLength(0);
    expect(await bodyOf(stepUp)).toEqual({ code: "492039" });
    const [refused, repeated, ...more] = calls("PUT", PAYOUT_PATH);
    expect(more).toHaveLength(0);
    expectSessionHeaders(repeated);
    // The same body both times: the holder trimmed, the IBAN without spaces in capitals, the BIC in capitals.
    expect(await bodyOf(repeated)).toEqual(await bodyOf(refused));
    expect(await bodyOf(repeated)).toEqual({
      accountHolderName: "Acme Travel AS",
      countryCode: "NO",
      currency: "NOK",
      scheme: "iban",
      iban: NORMALISED_IBAN,
      bic: "DNBANOKK",
    });
    expect(savedNotice()?.dataset["saved"]).toBe("pending_review");
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAYOUT_PAGE);
    // The bank numbers are gone from the page once saved; the other fields show the saved account.
    expect((field(PAYOUT_ACCOUNT_STRINGS.ibanLabel) as HTMLInputElement).value).toBe("");
    expect((field(PAYOUT_ACCOUNT_STRINGS.bicLabel) as HTMLInputElement).value).toBe("");
    expect(field(PAYOUT_ACCOUNT_STRINGS.holderLabel).value).toBe("Acme Travel AS");
    expect(document.body.innerHTML).not.toContain("8601");
  });

  it("a cancelled step-up saves nothing and says why", async () => {
    routes({ [`PUT ${PAYOUT_PATH}`]: () => apiError("REAUTH_REQUIRED", 401) });
    await openPayout();
    fillIbanAccount();
    savePayout();
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), ACTION_WAIT);
    expect(summaryItems()).toEqual([PAYOUT_ACCOUNT_STRINGS.stepUpCancelled]);
    expect(calls("PUT", PAYOUT_PATH)).toHaveLength(1);
    expect(calls("POST", STEP_UP_PATH)).toHaveLength(0);
    // What was typed stays, so the owner can try again.
    expect((field(PAYOUT_ACCOUNT_STRINGS.ibanLabel) as HTMLInputElement).value).toBe(TYPED_IBAN);
  });

  it("a rejected account shows the reviewer's note, and saving it again sends it back to pending review", async () => {
    const rejected = payoutAccount({
      status: "rejected",
      reviewNote: "The holder is not the OTA's company.",
      version: 3,
    });
    routes({
      [`GET ${PAYOUT_PATH}`]: () => json(rejected, 200),
      [`PUT ${PAYOUT_PATH}`]: (request) => saved(request, rejected),
    });
    await openPayout();
    expect(detail(PAYOUT_ACCOUNT_STRINGS.status)).toBe(STATUS_LABELS.payoutAccount.rejected);
    expect(document.querySelector("[data-status-explanation]")?.textContent).toBe(
      PAYOUT_ACCOUNT_STRINGS.statusExplanations["rejected"],
    );
    const note = document.querySelector<HTMLElement>("[data-review-note]");
    expect(note?.textContent).toContain(PAYOUT_ACCOUNT_STRINGS.reviewNote);
    expect(note?.textContent).toContain("The holder is not the OTA's company.");

    // The same account typed again: the API asks for a new review (FIX-W36-PLATFORM), and the page says so.
    type(PAYOUT_ACCOUNT_STRINGS.ibanLabel, TYPED_IBAN);
    savePayout();
    await waitFor(() => expect(savedNotice()?.dataset["saved"]).toBe("pending_review"), ACTION_WAIT);
    expect(savedNotice()?.textContent).toBe(PAYOUT_ACCOUNT_STRINGS.savedPending);
    expect(calls("PUT", PAYOUT_PATH)).toHaveLength(1);
  });

  it("the verified account typed again stays verified, and the page says nothing changed", async () => {
    const verified = payoutAccount({ status: "verified", version: 2 });
    routes({
      [`GET ${PAYOUT_PATH}`]: () => json(verified, 200),
      [`PUT ${PAYOUT_PATH}`]: () => json(verified, 200),
    });
    await openPayout();
    expect(document.querySelector("[data-status-explanation]")?.textContent).toBe(
      PAYOUT_ACCOUNT_STRINGS.statusExplanations["verified"],
    );
    expect(document.querySelector("[data-review-note]")).toBeNull();
    type(PAYOUT_ACCOUNT_STRINGS.ibanLabel, TYPED_IBAN);
    savePayout();
    await waitFor(
      () => expect(savedNotice()?.textContent).toBe(PAYOUT_ACCOUNT_STRINGS.savedVerified),
      ACTION_WAIT,
    );
  });

  it("an OTA without a payout account says so, and the owner adds one with the OTA's country and currency", async () => {
    routes({
      [`GET ${PAYOUT_PATH}`]: () => apiError("NOT_FOUND", 404),
      [`PUT ${PAYOUT_PATH}`]: (request) => saved(request, null),
    });
    await openPayout();
    expect(document.querySelector("[data-payout-account-none]")?.textContent).toBe(
      PAYOUT_ACCOUNT_STRINGS.none,
    );
    expect(screen.getByRole("heading", { name: PAYOUT_ACCOUNT_STRINGS.formTitleAdd })).toBeTruthy();
    expect(field(PAYOUT_ACCOUNT_STRINGS.holderLabel).value).toBe("");
    expect(field(PAYOUT_ACCOUNT_STRINGS.countryLabel).value).toBe("NO");
    expect(field(PAYOUT_ACCOUNT_STRINGS.currencyLabel).value).toBe("NOK");
    expect(
      (within(payoutForm()).getByLabelText(PAYOUT_ACCOUNT_STRINGS.schemeIban) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("a local account sends the account and routing numbers, never an IBAN", async () => {
    await openPayout();
    type(PAYOUT_ACCOUNT_STRINGS.holderLabel, "Acme Travel Inc.");
    type(PAYOUT_ACCOUNT_STRINGS.countryLabel, "US");
    type(PAYOUT_ACCOUNT_STRINGS.currencyLabel, "USD");
    chooseScheme(PAYOUT_ACCOUNT_STRINGS.schemeLocal);
    expect(within(payoutForm()).queryByLabelText(PAYOUT_ACCOUNT_STRINGS.ibanLabel)).toBeNull();
    type(PAYOUT_ACCOUNT_STRINGS.accountNumberLabel, ` ${ACCOUNT_NUMBER} `);
    type(PAYOUT_ACCOUNT_STRINGS.routingNumberLabel, ROUTING_NUMBER);
    savePayout();
    await waitFor(() => expect(savedNotice()).not.toBeNull(), ACTION_WAIT);
    expect(await bodyOf(calls("PUT", PAYOUT_PATH)[0])).toEqual({
      accountHolderName: "Acme Travel Inc.",
      countryCode: "US",
      currency: "USD",
      scheme: "local",
      accountNumber: ACCOUNT_NUMBER,
      routingNumber: ROUTING_NUMBER,
    });
    expect((field(PAYOUT_ACCOUNT_STRINGS.accountNumberLabel) as HTMLInputElement).value).toBe("");
  });

  it("checks the fields before any call and puts each problem at its field and in the focused summary", async () => {
    await openPayout();
    type(PAYOUT_ACCOUNT_STRINGS.holderLabel, "   ");
    type(PAYOUT_ACCOUNT_STRINGS.ibanLabel, WRONG_CHECKSUM_IBAN);
    type(PAYOUT_ACCOUNT_STRINGS.bicLabel, "DNB");
    savePayout();

    await waitFor(
      () =>
        expect(summaryItems()).toEqual([
          PAYOUT_ACCOUNT_STRINGS.problems.holderRequired,
          PAYOUT_ACCOUNT_STRINGS.problems.ibanChecksum,
          PAYOUT_ACCOUNT_STRINGS.problems.bicFormat,
        ]),
      ACTION_WAIT,
    );
    await waitFor(() => expect(document.activeElement).toBe(summaryOfForm()), ACTION_WAIT);
    const iban = field(PAYOUT_ACCOUNT_STRINGS.ibanLabel);
    expect(iban.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionsOf(iban)).toContain(PAYOUT_ACCOUNT_STRINGS.problems.ibanChecksum);
    // What was typed stays for the correction; the problems never repeat it.
    expect((iban as HTMLInputElement).value).toBe(WRONG_CHECKSUM_IBAN);
    expect(summaryOfForm()?.textContent).not.toContain("8601");
    expect(calls("PUT", PAYOUT_PATH)).toHaveLength(0);
  });

  it("refuses broken and forged values without a call, in form order", async () => {
    const problems = PAYOUT_ACCOUNT_STRINGS.problems;
    const refused = async (fields: Record<string, string>) =>
      (await savePayoutAccount(IDLE, formData(fields))).fieldErrors;

    expect(await refused({ ...IBAN_FORM, accountHolderName: "x".repeat(201) })).toEqual({
      accountHolderName: problems.holderTooLong,
    });
    expect(await refused({ ...IBAN_FORM, countryCode: "ZZ", currency: "EURO" })).toEqual({
      countryCode: problems.country,
      currency: problems.currency,
    });
    expect(await refused({ ...IBAN_FORM, scheme: "swift" })).toEqual({ scheme: problems.scheme });
    expect(await refused({ ...IBAN_FORM, iban: "" })).toEqual({ iban: problems.ibanRequired });
    expect(await refused({ ...IBAN_FORM, iban: "NO93-8601-1117-947" })).toEqual({
      iban: problems.ibanFormat,
    });
    expect(await refused({ ...IBAN_FORM, iban: "1293 8601 1117 947" })).toEqual({
      iban: problems.ibanFormat,
    });
    // Check digits outside 02–98 are never valid, whatever the rest.
    expect(await refused({ ...IBAN_FORM, iban: "NO00 8601 1117 947" })).toEqual({
      iban: problems.ibanChecksum,
    });
    expect(await refused({ ...IBAN_FORM, bic: "DNBANOKK1" })).toEqual({ bic: problems.bicFormat });
    expect(await refused({ ...LOCAL_FORM, accountNumber: "", routingNumber: "" })).toEqual({
      accountNumber: problems.accountNumberRequired,
      routingNumber: problems.routingNumberRequired,
    });
    expect(await refused({ ...LOCAL_FORM, accountNumber: "12-3", routingNumber: "-11" })).toEqual({
      accountNumber: problems.accountNumberFormat,
      routingNumber: problems.routingNumberFormat,
    });
    expect(
      await refused({ ...LOCAL_FORM, accountNumber: "1".repeat(35), routingNumber: "1".repeat(21) }),
    ).toEqual({
      accountNumber: problems.accountNumberFormat,
      routingNumber: problems.routingNumberFormat,
    });
    // A form without its OTA is an expired form.
    const expired = await savePayoutAccount(IDLE, formData({ ...IBAN_FORM, tenantId: "ten_bad" }));
    expect(expired.message).toBe(PAYOUT_ACCOUNT_STRINGS.formExpired);
    expect(expired.reload).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    // Valid IBANs of other countries pass the same checks (a German and a British one).
    for (const iban of ["DE89 3704 0044 0532 0130 00", "gb82west12345698765432"]) {
      routes();
      expect((await savePayoutAccount(IDLE, formData({ ...IBAN_FORM, iban, bic: "" }))).status).toBe("saved");
      expect(await bodyOf(calls("PUT", PAYOUT_PATH)[0])).not.toHaveProperty("bic");
    }
  });

  it("the action's state never holds a bank number, saved or refused", async () => {
    const savedState = await savePayoutAccount(IDLE, formData(IBAN_FORM));
    expect(savedState.status).toBe("saved");
    expect(savedState.account?.last4).toBe("7947");
    routes({ [`PUT ${PAYOUT_PATH}`]: () => apiError("RATE_LIMITED", 429) });
    const refusedState = await savePayoutAccount(IDLE, formData(LOCAL_FORM));
    const checkedState = await savePayoutAccount(IDLE, formData({ ...IBAN_FORM, iban: WRONG_CHECKSUM_IBAN }));
    for (const state of [savedState, refusedState, checkedState]) {
      const serialised = JSON.stringify(state);
      for (const secret of ["8601", "1117", ACCOUNT_NUMBER, ROUTING_NUMBER, "DNBANOKK", "dnbanokk"]) {
        expect(serialised).not.toContain(secret);
      }
    }
  });

  it("the API's field errors land at their fields; rules of the shape not sent and other paths do not", async () => {
    routes({
      [`PUT ${PAYOUT_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [
            // The local shape's complaints about an IBAN body (oneOf): never shown.
            { path: "/iban", code: "additionalProperties" },
            { path: "/accountNumber", code: "required" },
            { path: "/scheme", code: "const" },
            { path: "/iban", code: "iban_checksum" },
            { path: "/accountHolderName", code: "maxLength" },
          ],
        }),
    });
    const state = await savePayoutAccount(IDLE, formData(IBAN_FORM));
    expect(state.fieldErrors).toEqual({
      iban: PAYOUT_ACCOUNT_STRINGS.problems.ibanChecksum,
      accountHolderName: PAYOUT_ACCOUNT_STRINGS.problems.holderTooLong,
    });
    expect(state.message).toBeUndefined();

    routes({
      [`PUT ${PAYOUT_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [
            { path: "/accountNumber", code: "account_number_format" },
            { path: "/routingNumber", code: "pattern" },
            { path: "/countryCode", code: "pattern" },
          ],
        }),
    });
    expect((await savePayoutAccount(IDLE, formData(LOCAL_FORM))).fieldErrors).toEqual({
      accountNumber: PAYOUT_ACCOUNT_STRINGS.problems.accountNumberFormat,
      routingNumber: PAYOUT_ACCOUNT_STRINGS.problems.routingNumberFormat,
      countryCode: PAYOUT_ACCOUNT_STRINGS.problems.country,
    });

    // Errors only on what the form did not send (or only structural ones) read as an expired form.
    routes({
      [`PUT ${PAYOUT_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [
            { path: "/path/tenantId", code: "pattern" },
            { path: "/accountNumber", code: "pattern" },
            { path: "", code: "oneOf" },
          ],
        }),
    });
    const expired = await savePayoutAccount(IDLE, formData(IBAN_FORM));
    expect(expired.fieldErrors).toEqual({});
    expect(expired.message).toBe(PAYOUT_ACCOUNT_STRINGS.formExpired);
    expect(expired.reload).toBe(true);
    expect(JSON.stringify(expired)).not.toContain(API_TEXT);
  });

  it("shows the portal's message for each refusal, with the security link for an account without MFA", async () => {
    const cases: readonly [string, number, string, boolean][] = [
      ["MFA_REQUIRED", 403, PAYOUT_ACCOUNT_STRINGS.mfaRequired, false],
      ["FEATURE_DISABLED", 403, PAYOUT_ACCOUNT_STRINGS.featureDisabled, false],
      ["FORBIDDEN", 403, PAYOUT_ACCOUNT_STRINGS.forbidden, true],
      ["NOT_FOUND", 404, PAYOUT_ACCOUNT_STRINGS.removed, true],
      ["RATE_LIMITED", 429, PAYOUT_ACCOUNT_STRINGS.rateLimited, false],
      ["SERVICE_UNAVAILABLE", 503, ERROR_MESSAGES.SERVICE_UNAVAILABLE, false],
    ];
    for (const [code, status, message, reload] of cases) {
      routes({ [`PUT ${PAYOUT_PATH}`]: () => apiError(code, status) });
      const state = await savePayoutAccount(IDLE, formData(IBAN_FORM));
      expect({ code: state.code, message: state.message, reload: state.reload === true }).toEqual({
        code,
        message,
        reload,
      });
      expect(state.stepUp).toBeUndefined();
    }

    routes({ [`PUT ${PAYOUT_PATH}`]: () => apiError("MFA_REQUIRED", 403) });
    await openPayout();
    type(PAYOUT_ACCOUNT_STRINGS.ibanLabel, TYPED_IBAN);
    savePayout();
    const link = await within(payoutForm()).findByRole(
      "link",
      { name: PAYOUT_ACCOUNT_STRINGS.mfaLink },
      ACTION_WAIT,
    );
    expect(link.getAttribute("href")).toBe("/account/security");
    expect(document.body.textContent).not.toContain(API_TEXT);
  });

  it("sends an ended session to sign-in and back, and an unverified account to /verify-pending", async () => {
    const back = `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments%2Fpayout-account`;
    routes({ [`PUT ${PAYOUT_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(savePayoutAccount(IDLE, formData(IBAN_FORM))).rejects.toThrow(back);
    routes({ [`PUT ${PAYOUT_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(savePayoutAccount(IDLE, formData(IBAN_FORM))).rejects.toThrow(
      "NEXT_REDIRECT /verify-pending",
    );

    routes({ [`GET ${PAYOUT_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(PayoutAccountPage({ params: params() })).rejects.toThrow(back);
    routes({ [`GET ${PAYOUT_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(PayoutAccountPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT /verify-pending");
  });

  it("an account that cannot be loaded shows the portal's message and no form", async () => {
    routes({ [`GET ${PAYOUT_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openPayout();
    expect(screen.getByText(PAYOUT_ACCOUNT_STRINGS.unavailableTitle)).toBeTruthy();
    expect(screen.getByText(ERROR_MESSAGES.SERVICE_UNAVAILABLE)).toBeTruthy();
    expect(document.querySelector("[data-payout-form]")).toBeNull();
    expect(document.body.textContent).not.toContain(API_TEXT);
  });

  it("agents, admins and viewers get the not-allowed page without a payout call", async () => {
    for (const role of ["agent", "admin", "viewer"] as const) {
      routesAs(role);
      await openPayout();
      expectNotAllowed(role);
      expect(callsBesidesTenant()).toEqual([]);
      cleanup();
      fetchMock.mockClear();
    }
  });

  it("renders on the server and hydrates without an error or a change", async () => {
    const { errors, root, serverDom, container } = await serverRenderAndHydrate(
      await elementOf(PayoutAccountPage({ params: params() })),
    );
    expect(errors).toEqual([]);
    expect(container.innerHTML).toBe(serverDom);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    act(() => root.unmount());
  });
});

// ---- The settlements -------------------------------------------------------------------------------------------------

describe("the settlements pages", () => {
  it("[PFE-025 AC2] owners and finance members list the statements Velexis approved; drafts never appear [PF-63 AC3]", async () => {
    const draft = summary({ id: DRAFT_ID, status: "draft" as SettlementSummary["status"], paidAt: null });
    const voided = summary({ id: DRAFT_ID, status: "void" as SettlementSummary["status"], paidAt: null });
    for (const role of ["owner", "finance"] as const) {
      // The API never answers a draft to the portal; one that slipped into an answer would not be shown either.
      routesAs(role, {
        [`GET ${SETTLEMENTS_PATH}`]: () => json({ data: [draft, ...STATEMENTS, voided] }, 200),
      });
      navigation.pathname = SETTLEMENTS_PAGE;
      await openList();

      expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
        SETTLEMENTS_STRINGS.title,
      ]);
      const table = screen.getByRole("table", { name: SETTLEMENTS_STRINGS.caption });
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows.map((row) => row.getAttribute("data-settlement"))).toEqual([
        APPROVED_ID,
        PAID_ID,
        CARRIED_ID,
      ]);
      expect(document.querySelector(`[data-settlement="${DRAFT_ID}"]`)).toBeNull();
      expect(document.body.textContent).not.toContain(STATUS_LABELS.settlement.draft);
      expect(document.body.textContent).not.toContain(STATUS_LABELS.settlement.void);

      const cells = rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
      const paidAt = STATEMENTS[1]?.paidAt ?? "";
      expect(cells).toEqual([
        [
          monthLabel(APPROVED_PERIOD),
          "EUR",
          STATUS_LABELS.settlement.approved,
          "€11,204.87",
          SETTLEMENTS_STRINGS.notPaidYet,
        ],
        [
          monthLabel(PAID_PERIOD),
          "EUR",
          STATUS_LABELS.settlement.paid,
          "€8,935.10",
          formatDateTime(paidAt, { mode: "date", timeZone: "UTC" }),
        ],
        [
          monthLabel(CARRIED_PERIOD),
          "EUR",
          STATUS_LABELS.settlement.carried_forward,
          "-€79.48",
          SETTLEMENTS_STRINGS.noTransfer,
        ],
      ]);
      // Each period links to its statement.
      expect(
        within(rows[1] as HTMLElement)
          .getByRole("link", { name: monthLabel(PAID_PERIOD) })
          .getAttribute("href"),
      ).toBe(`${SETTLEMENTS_PAGE}/${PAID_ID}`);
      expect(rows[1]?.querySelector("data")?.getAttribute("value")).toBe("8935.10");

      const [read, ...more] = calls("GET", SETTLEMENTS_PATH);
      expect(more).toHaveLength(0);
      expectSessionHeaders(read);
      expect(callsBesidesTenant()).toEqual([`GET ${SETTLEMENTS_PATH}`]);
      cleanup();
    }
  });

  it("an empty list says so, and a list that cannot be loaded shows the portal's message", async () => {
    routes({ [`GET ${SETTLEMENTS_PATH}`]: () => json({ data: [] }, 200) });
    await openList();
    expect(document.querySelector("[data-settlements-empty]")?.textContent).toBe(SETTLEMENTS_STRINGS.empty);
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();

    routes({ [`GET ${SETTLEMENTS_PATH}`]: () => apiError("RATE_LIMITED", 429) });
    await openList();
    expect(screen.getByText(SETTLEMENTS_STRINGS.unavailableTitle)).toBeTruthy();
    expect(screen.getByText(ERROR_MESSAGES.RATE_LIMITED)).toBeTruthy();
    expect(document.body.textContent).not.toContain(API_TEXT);

    const back = `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments%2Fsettlements`;
    routes({ [`GET ${SETTLEMENTS_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(SettlementsPage({ params: params() })).rejects.toThrow(back);
    routes({ [`GET ${SETTLEMENTS_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(SettlementsPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT /verify-pending");
    routes({ [`GET ${SETTLEMENTS_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await expect(SettlementsPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("[PFE-025 AC2] a paid statement shows its totals, the transfer, the notes and the link to its CSV [PF-63 AC3]", async () => {
    for (const role of ["owner", "finance"] as const) {
      routesAs(role);
      await openStatement();

      expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
        SETTLEMENTS_STRINGS.statementTitle(monthLabel(PAID_PERIOD), "EUR"),
      ]);
      expect(document.querySelector("[data-status-explanation]")?.textContent).toBe(
        SETTLEMENTS_STRINGS.statusExplanations["paid"],
      );
      expect(screen.getByText("VX-SETTLE-ACME-0001")).toBeTruthy();
      expect(
        screen.getByText(
          formatDateTime(settlement().paidAt ?? "", { mode: "date", timeZone: "UTC" }) ?? "<none>",
        ),
      ).toBeTruthy();

      const totals = [...document.querySelectorAll<HTMLElement>("[data-total]")].map((row) => [
        row.dataset["total"],
        row.querySelector("th")?.textContent,
        row.querySelector("data")?.getAttribute("value"),
        row.querySelector("td")?.textContent,
      ]);
      expect(totals).toEqual([
        ["gross", SETTLEMENTS_STRINGS.gross, "9600.00", "€9,600.00"],
        ["refunds", SETTLEMENTS_STRINGS.refunds, "249.00", "€249.00"],
        ["disputes", SETTLEMENTS_STRINGS.disputes, "0.00", "€0.00"],
        ["stripeFees", SETTLEMENTS_STRINGS.stripeFees, "139.40", "€139.40"],
        ["velexisFees", SETTLEMENTS_STRINGS.velexisFees("2%"), "187.02", "€187.02"],
        ["adjustments", SETTLEMENTS_STRINGS.adjustments, "-89.48", "-€89.48"],
        ["net", SETTLEMENTS_STRINGS.net, "8935.10", "€8,935.10"],
      ]);
      expect(screen.getByText(SETTLEMENTS_STRINGS.formula)).toBeTruthy();
      expect(screen.getByText(settlement().notes ?? "<none>")).toBeTruthy();

      const link = screen.getByRole("link", { name: SETTLEMENTS_STRINGS.download });
      expect(link.getAttribute("href")).toBe(`${SETTLEMENTS_PAGE}/${PAID_ID}/lines.csv`);
      // A plain link: the file is an attachment (saved without leaving the page), while a refusal's plain text and
      // the way to sign-in after an ended session must render as pages, which a `download` link never does.
      expect(link.hasAttribute("download")).toBe(false);
      expect(document.body.textContent).toContain(SETTLEMENTS_STRINGS.lineCount(41));
      expect(screen.getByRole("link", { name: SETTLEMENTS_STRINGS.backToList }).getAttribute("href")).toBe(
        SETTLEMENTS_PAGE,
      );

      const [read, ...more] = calls("GET", `${SETTLEMENTS_PATH}/${PAID_ID}`);
      expect(more).toHaveLength(0);
      expectSessionHeaders(read);
      expect(callsBesidesTenant()).toEqual([`GET ${SETTLEMENTS_PATH}/${PAID_ID}`]);
      cleanup();
    }
  });

  it("an approved and a carried-forward statement say what they mean, without a transfer reference", async () => {
    routes({
      [`GET ${SETTLEMENTS_PATH}/${APPROVED_ID}`]: () =>
        json(settlement({ ...STATEMENTS[0], payoutReference: null, notes: null }), 200),
      [`GET ${SETTLEMENTS_PATH}/${CARRIED_ID}`]: () =>
        json(settlement({ ...STATEMENTS[2], payoutReference: null, notes: null, feeBps: 125 }), 200),
    });
    await openStatement(APPROVED_ID);
    expect(document.querySelector("[data-status-explanation]")?.textContent).toBe(
      SETTLEMENTS_STRINGS.statusExplanations["approved"],
    );
    expect(screen.getAllByText(SETTLEMENTS_STRINGS.notPaidYet).length).toBeGreaterThan(0);
    expect(screen.getByText(SETTLEMENTS_STRINGS.notSet)).toBeTruthy();
    expect(screen.queryByText(SETTLEMENTS_STRINGS.notesTitle)).toBeNull();
    cleanup();

    routes({
      [`GET ${SETTLEMENTS_PATH}/${CARRIED_ID}`]: () =>
        json(settlement({ ...STATEMENTS[2], payoutReference: null, notes: null, feeBps: 125 }), 200),
    });
    await openStatement(CARRIED_ID);
    expect(document.querySelector("[data-status-explanation]")?.textContent).toBe(
      SETTLEMENTS_STRINGS.statusExplanations["carried_forward"],
    );
    expect(screen.getByText(SETTLEMENTS_STRINGS.noTransfer)).toBeTruthy();
    expect(screen.getByText(SETTLEMENTS_STRINGS.velexisFees("1.25%"))).toBeTruthy();
  });

  it("[PFE-025 AC2] a draft, a voided draft or another OTA's statement is not found; a bad id makes no call", async () => {
    // The API answers 404 for drafts and voided drafts (and other OTAs' statements).
    routes({ [`GET ${SETTLEMENTS_PATH}/${DRAFT_ID}`]: () => apiError("NOT_FOUND", 404) });
    await expect(SettlementPage({ params: statementParams(DRAFT_ID) })).rejects.toThrow("NEXT_NOT_FOUND");
    // A draft that slipped into an answer is not shown either.
    routes({
      [`GET ${SETTLEMENTS_PATH}/${DRAFT_ID}`]: () =>
        json(settlement({ id: DRAFT_ID, status: "draft" as Settlement["status"] }), 200),
    });
    await expect(SettlementPage({ params: statementParams(DRAFT_ID) })).rejects.toThrow("NEXT_NOT_FOUND");

    routes();
    await expect(SettlementPage({ params: statementParams("stl_not-an-id") })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(callsBesidesTenant()).toEqual([]);

    const back = `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments%2Fsettlements%2F${PAID_ID}`;
    routes({ [`GET ${SETTLEMENTS_PATH}/${PAID_ID}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(SettlementPage({ params: statementParams(PAID_ID) })).rejects.toThrow(back);

    routes({ [`GET ${SETTLEMENTS_PATH}/${PAID_ID}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openStatement();
    expect(screen.getByText(SETTLEMENTS_STRINGS.unavailableTitle)).toBeTruthy();
    expect(screen.getByText(ERROR_MESSAGES.SERVICE_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByRole("link", { name: SETTLEMENTS_STRINGS.download })).toBeNull();
  });

  it("agents, admins and viewers get the not-allowed page on the list and a statement without a call", async () => {
    for (const role of ["agent", "admin", "viewer"] as const) {
      routesAs(role);
      await openList();
      expectNotAllowed(role);
      cleanup();
      routesAs(role);
      await openStatement();
      expectNotAllowed(role);
      expect(callsBesidesTenant()).toEqual([]);
      cleanup();
      fetchMock.mockClear();
    }
  });

  it("the list and a statement render on the server and hydrate without an error or a change", async () => {
    for (const page of [
      () => SettlementsPage({ params: params() }),
      () => SettlementPage({ params: statementParams(PAID_ID) }),
    ]) {
      resetPlatformApi();
      const { errors, root, serverDom, container } = await serverRenderAndHydrate(await elementOf(page()));
      expect(errors).toEqual([]);
      expect(container.innerHTML).toBe(serverDom);
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      act(() => root.unmount());
      vi.restoreAllMocks();
      document.body.replaceChildren();
    }
  });

  it("names statements by their month in UTC, the fee rate in words and the CSV file as the API does", () => {
    // Pure functions without a clock: the first instant of March in UTC is still the last day of February in New York.
    expect(statementMonth("2027-03-01T00:00:00Z")).toBe("March 2027");
    expect(statementMonth("not a date")).toBe("not a date");
    expect(feeRate(200)).toBe("2%");
    expect(feeRate(125)).toBe("1.25%");
    expect(feeRate(0)).toBe("0%");
    expect(statementFileName({ periodStart: "2027-01-01T00:00:00Z", currency: "EUR" })).toBe(
      "velexis-statement-2027-01-EUR.csv",
    );
    expect(statementFileName({ periodStart: "2027-12-01T00:00:00Z", currency: "NOK" })).toBe(
      "velexis-statement-2027-12-NOK.csv",
    );
    // Nothing unchecked reaches the header.
    expect(statementFileName({ periodStart: "2027-01-01T00:00:00Z", currency: 'EU"R' })).toBe(
      "velexis-statement.csv",
    );
    expect(statementFileName({ periodStart: "soon", currency: "EUR" })).toBe("velexis-statement.csv");
  });
});

// ---- The CSV route handler -------------------------------------------------------------------------------------------

describe("the lines.csv route handler", () => {
  /** A download as the browser asks for it. */
  function download(settlementId = PAID_ID, tenantId = TENANT_ID): Promise<Response> {
    return downloadLines(
      new Request(`https://platform.example.com${SETTLEMENTS_PAGE}/${settlementId}/lines.csv`),
      {
        params: statementParams(settlementId, tenantId),
      },
    );
  }

  it("[PFE-025 AC2] streams downloadSettlementLines with the user's session as an attachment [PF-63 AC3]", async () => {
    for (const role of ["owner", "finance"] as const) {
      routesAs(role);
      const response = await download();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      const start = new Date(Date.parse(PAID_PERIOD));
      const month = String(start.getUTCMonth() + 1).padStart(2, "0");
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="velexis-statement-${start.getUTCFullYear()}-${month}-EUR.csv"`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      // The file is the API's, byte for byte.
      expect(await response.text()).toBe(CSV_TEXT);

      const [statement, ...moreStatements] = calls("GET", `${SETTLEMENTS_PATH}/${PAID_ID}`);
      const [lines, ...moreLines] = calls("GET", `${SETTLEMENTS_PATH}/${PAID_ID}/lines.csv`);
      expect([moreStatements, moreLines]).toEqual([[], []]);
      // Server-side, with the session of the httpOnly cookie: no token reaches the browser.
      expectSessionHeaders(statement);
      expectSessionHeaders(lines);
      fetchMock.mockClear();
    }
  });

  it("[PFE-025 AC2] hands the file on as it arrives, before the API has sent all of it [PF-63 AC3]", async () => {
    // The API sends the header row and keeps the file open; the rest comes only once the handler has answered. A
    // handler that buffered the body would still be waiting for the end of the file here, and never answer.
    const encoder = new TextEncoder();
    const [headerRow = "", ...otherRows] = CSV_TEXT.split("\r\n");
    let sendRest: (() => void) | undefined;
    routes({
      [`GET ${SETTLEMENTS_PATH}/${PAID_ID}/lines.csv`]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`${headerRow}\r\n`));
              sendRest = () => {
                controller.enqueue(encoder.encode(otherRows.join("\r\n")));
                controller.close();
              };
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" },
          },
        ),
    });

    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="velexis-statement-/);
    expect(sendRest).toBeDefined();
    sendRest?.();
    expect(await response.text()).toBe(CSV_TEXT);
  });

  it("[PFE-025 AC2] a draft's lines never come back: the API's 404, or a draft in an answer, is a 404 without the file", async () => {
    routes({ [`GET ${SETTLEMENTS_PATH}/${DRAFT_ID}`]: () => apiError("NOT_FOUND", 404) });
    const missing = await download(DRAFT_ID);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(SETTLEMENTS_STRINGS.csvNotFound);
    expect(calls("GET", `${SETTLEMENTS_PATH}/${DRAFT_ID}/lines.csv`)).toHaveLength(0);

    routes({
      [`GET ${SETTLEMENTS_PATH}/${DRAFT_ID}`]: () =>
        json(settlement({ id: DRAFT_ID, status: "draft" as Settlement["status"] }), 200),
    });
    const draft = await download(DRAFT_ID);
    expect(draft.status).toBe(404);
    expect(calls("GET", `${SETTLEMENTS_PATH}/${DRAFT_ID}/lines.csv`)).toHaveLength(0);

    // The statement was found but its lines answer 404 (removed in between).
    routes({ [`GET ${SETTLEMENTS_PATH}/${PAID_ID}/lines.csv`]: () => apiError("NOT_FOUND", 404) });
    expect((await download()).status).toBe(404);
  });

  it("refuses other roles, bad ids, rate limits and an unreachable API in the portal's words", async () => {
    routesAs("agent", { [`GET ${SETTLEMENTS_PATH}/${PAID_ID}`]: () => apiError("FORBIDDEN", 403) });
    const forbidden = await download();
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe(SETTLEMENTS_STRINGS.csvForbidden);
    expect(forbidden.headers.get("cache-control")).toBe("no-store");

    routes({
      [`GET ${SETTLEMENTS_PATH}/${PAID_ID}/lines.csv`]: () =>
        apiError("RATE_LIMITED", 429, { headers: { "retry-after": "30" } }),
    });
    const limited = await download();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(await limited.text()).toBe(SETTLEMENTS_STRINGS.csvFailed(ERROR_MESSAGES.RATE_LIMITED));

    routes({
      [`GET ${SETTLEMENTS_PATH}/${PAID_ID}`]: () => {
        throw new TypeError("connect ECONNREFUSED");
      },
    });
    const unreachable = await download();
    expect(unreachable.status).toBe(503);
    expect(await unreachable.text()).toBe(SETTLEMENTS_STRINGS.csvFailed(ERROR_MESSAGES.SERVICE_UNAVAILABLE));

    routes();
    for (const [settlementId, tenantId] of [
      ["stl_bad", TENANT_ID],
      [PAID_ID, "ten_bad"],
    ] as const) {
      const refused = await download(settlementId, tenantId);
      expect(refused.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an ended session to sign-in and back to the statement, and answers HEAD with 405 without a call", async () => {
    routes({ [`GET ${SETTLEMENTS_PATH}/${PAID_ID}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(download()).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments%2Fsettlements%2F${PAID_ID}`,
    );
    routes({ [`GET ${SETTLEMENTS_PATH}/${PAID_ID}/lines.csv`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(download()).rejects.toThrow("NEXT_REDIRECT /verify-pending");

    routes();
    const head = headLines();
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
