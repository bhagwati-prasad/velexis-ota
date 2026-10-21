// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope, navigation and cache of Next.js and the configuration; the real API client talks ----
// ---- to a mocked fetch, so the tests see the query, the headers and the body of every call the pages send ----------

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
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import {
  AccountActions,
  CreateAccountForm,
  PENDING_REFRESH_LIMIT,
  REFRESH_INTERVAL_MS,
  type AccountActionsProps,
} from "@/app/(app)/amadeus/accounts/account-form";
import {
  createAmadeusAccount,
  disableAmadeusAccount,
  rotateAmadeusAccountSecret,
  updateAmadeusAccountDetails,
  verifyAmadeusAccount,
  type AccountActionState,
} from "@/app/(app)/amadeus/accounts/actions";
import AmadeusAccountsPage from "@/app/(app)/amadeus/accounts/page";
import {
  addOffices,
  assignOfficeToTenant,
  retireOffice,
  saveOfficeNotes,
  type AddOfficesState,
} from "@/app/(app)/amadeus/offices/actions";
import { AddOfficesForm } from "@/app/(app)/amadeus/offices/add-offices-form";
import { OfficeTable } from "@/app/(app)/amadeus/offices/office-table";
import AmadeusOfficesPage from "@/app/(app)/amadeus/offices/page";
import { FilterBar } from "@/components/filter-bar";
import * as tableComponents from "@/components/ui/table";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "@/lib/session";
import {
  ADD_OFFICES_STRINGS as ADD,
  AMADEUS_ACCOUNT_FORM_STRINGS as F,
  AMADEUS_ACCOUNT_STRINGS as A,
  AMADEUS_OFFICE_STRINGS as O,
  ASSIGN_OFFICE_STRINGS,
  DASHBOARD_STRINGS,
  ERROR_MESSAGES,
  OFFICE_ACTION_STRINGS as X,
  REASON_STRINGS,
  STEP_UP_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real credential, token or account) -------------------------------------------

type Schemas = components["schemas"];
type Account = Schemas["AdminAmadeusAccount"];
type Office = Schemas["AdminAmadeusOffice"];
type Tenant = Schemas["AdminTenantSummary"];

const ACCESS_TOKEN = "pad007-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-007 test)";

const TEST_ACCOUNT_ID = "ama_01JA2Y8K3M7P1R5T9W3Z7C1F5H";
const LIVE_ACCOUNT_ID = "ama_01JC4N8Q2S6V0X4Z8B2D6F0H4K";
/** A dummy client id: the page shows its last four characters only. */
const CLIENT_ID = "pad007DummyClientIdAB0042";
/** Dummy secrets, never sent anywhere but the mocked API. */
const CLIENT_SECRET = "pad007-dummy-client-secret-not-real";
const NEW_SECRET = "pad007-dummy-rotated-secret-not-real";
const TOTP_CODE = "492039";

const NORDIC_ID = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const ACME_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const NORDICAIR_ID = "ten_01JC9S7V1X5Z9B3D7F1H5K9N3Q";

const AVAILABLE_ROW = "amo_01JC8R6T0W4Y8A2C6E0G4J8M2P";
const ASSIGNED_ROW = "amo_01JA2Y9N4Q8S2V6X0Z4B8D2G6J";
const RELEASING_ROW = "amo_01JB5P2R6T0W4Y8A2C6E0G4J8M";
const RETIRED_ROW = "amo_01JB6Q3S7V1X5Z9B3D7F1H5K9N";
const NEW_ROW = "amo_01JC8R6T0W4Y8A2C6E0G4J8M3Q";

const ACCOUNTS_PATH = "/v1/admin/amadeus-accounts";
const OFFICES_PATH = "/v1/admin/amadeus-offices";
const REASON = "Amadeus closed this office id at the end of the contract year.";

/**
 * The budget of the warm-up hook: the first render of these pages in a fresh worker loads the module graph of the
 * table, the filter bar and the dialogs, and the first dialog and server action run React's action queue for the
 * first time. On a loaded runner that takes seconds; the hook only stops one that hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * How long a step that runs a server action (a round trip through the real `lib/api.ts`) and re-renders the forms
 * may take. Testing Library's 1 s default is enough on an idle machine, not on a loaded CI runner; each test's own
 * 5 s budget is unchanged.
 */
const UI_WAIT = { timeout: 3_000 } as const;

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: TEST_ACCOUNT_ID,
    name: "Velexis test",
    environment: "test",
    baseUrl: "https://test.travel.api.amadeus.com",
    clientId: CLIENT_ID,
    status: "active",
    lastVerifiedAt: "2026-10-20T06:00:04Z",
    lastError: null,
    officeCounts: { available: 6, assigned: 17, releasing: 0, retired: 1 },
    createdAt: "2026-10-02T09:15:00Z",
    version: 3,
    ...overrides,
  };
}

function liveAccount(overrides: Partial<Account> = {}): Account {
  return account({
    id: LIVE_ACCOUNT_ID,
    name: "Velexis live",
    environment: "live",
    baseUrl: "https://travel.api.amadeus.com",
    status: "invalid_credentials",
    lastVerifiedAt: null,
    lastError: "HTTP 401 invalid_client",
    officeCounts: { available: 2, assigned: 1, releasing: 0, retired: 0 },
    version: 2,
    ...overrides,
  });
}

function office(overrides: Partial<Office> = {}): Office {
  return {
    id: AVAILABLE_ROW,
    amadeusAccountId: TEST_ACCOUNT_ID,
    officeId: "PAR1A0001",
    environment: "test",
    status: "available",
    assignedTenant: null,
    assignedAt: null,
    releaseRequestedAt: null,
    releasedAt: null,
    notes: "Ordered with the October batch.",
    createdAt: "2026-10-12T10:05:00Z",
    version: 1,
    ...overrides,
  };
}

/** The pool: an available, an assigned, a releasing and a retired office, oldest first. */
function pool(): Office[] {
  return [
    office({
      id: ASSIGNED_ROW,
      officeId: "NCE1A0955",
      status: "assigned",
      assignedTenant: { id: ACME_ID, key: "acme" },
      assignedAt: "2026-10-14T08:20:15Z",
      notes: null,
      createdAt: "2026-10-02T09:20:00Z",
      version: 2,
    }),
    office({
      id: RELEASING_ROW,
      officeId: "MUC1A0100",
      status: "releasing",
      assignedTenant: { id: NORDICAIR_ID, key: "nordicair" },
      assignedAt: "2026-10-05T08:00:00Z",
      releaseRequestedAt: "2026-10-18T12:00:00Z",
      notes: null,
      createdAt: "2026-10-03T09:20:00Z",
      version: 3,
    }),
    office({
      id: RETIRED_ROW,
      officeId: "LON1A0042",
      status: "retired",
      notes: "Closed by Amadeus.",
      createdAt: "2026-10-04T09:20:00Z",
      version: 2,
    }),
    office(),
  ];
}

function tenant(id: string, key: string): Tenant {
  return {
    id,
    key,
    name: `${key} travel`,
    status: "active",
    planCode: "early_access",
    ownerEmail: `owner@${key}.example.com`,
    createdAt: "2026-10-14T08:20:11Z",
    activatedAt: "2026-10-14T08:20:16Z",
  };
}

const TENANTS: readonly Tenant[] = [
  tenant(NORDICAIR_ID, "nordicair"),
  tenant(NORDIC_ID, "nordic"),
  tenant(ACME_ID, "acme"),
];

/** The Velexis connection of an OTA after an assignment, as the API answers it. */
function activeConnection(officeId: string): Schemas["AmadeusConnection"] {
  return {
    id: "sc_01JC9S7V1X5Z9B3D7F1H5K9N3Q",
    environment: "test",
    credentialSource: "velexis",
    status: "active",
    officeIds: [officeId],
    defaultOfficeId: officeId,
    queuingOfficeId: officeId,
    ownerOfficeId: officeId,
    clientId: null,
    ticketingDefaults: {},
    monitoredQueues: [],
    lastVerifiedAt: null,
    lastError: null,
    pendingSubmission: null,
    version: 2,
  };
}

/** The session `adminStepUp` answers (dummy tokens). */
function steppedUpSession(): Schemas["AdminSession"] {
  return {
    accessToken: "pad007-stepped-up-access-token",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "pad007-stepped-up-refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    admin: {
      id: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
      email: "lena.holm@velexis.example.com",
      fullName: "Lena Holm",
      features: {
        stripeBilling: false,
        ownStripe: false,
        settlements: false,
        ownAmadeus: false,
        customDomains: false,
        liveSwitch: false,
      },
    },
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

/** An empty `202`, as the API answers a verification request. */
function accepted(): Response {
  return new Response(null, { status: 202, headers: { "content-length": "0" } });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(
  code: string,
  status: number,
  details?: Record<string, unknown>,
  extra: { headers?: Record<string, string>; fieldErrors?: { path: string; code: string }[] } = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pad007",
        ...(details === undefined ? {} : { details }),
        ...(extra.fieldErrors === undefined ? {} : { fieldErrors: extra.fieldErrors }),
      },
    },
    status,
    extra.headers,
  );
}

/** What the mocked API holds; each test starts from these. */
let accounts: Account[] = [];
let offices: Office[] = [];

/** The pool as the API answers it: oldest first, filtered by `environment` and `status`. */
function listOffices(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const data = offices.filter(
    (row) =>
      (query.get("environment") === null || row.environment === query.get("environment")) &&
      (query.get("status") === null || row.status === query.get("status")),
  );
  return json({ data, page: { nextCursor: null, limit: 50 } }, 200);
}

/** `adminListTenants`: `q` matches part of the key, as the API does (name and owner too, which the tests leave out). */
function listTenants(request: Request): Response {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return json(
    { data: TENANTS.filter((row) => row.key.includes(q)), page: { nextCursor: null, limit: 200 } },
    200,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call by `METHOD /path`; unexpected calls fail the test. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    [`GET ${ACCOUNTS_PATH}`]: () => json({ data: accounts }, 200),
    [`GET ${OFFICES_PATH}`]: listOffices,
    "GET /v1/admin/tenants": listTenants,
    "POST /v1/admin/auth/step-up": () => json(steppedUpSession(), 200),
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

/** The JSON bodies of the calls of `METHOD /path` so far (`null` for a call without a body). */
async function bodies(method: string, path: string): Promise<unknown[]> {
  return Promise.all(
    calls(method, path).map(async (request) => {
      const text = await request.clone().text();
      return text === "" ? null : (JSON.parse(text) as unknown);
    }),
  );
}

function sortedQuery(search: string): [string, string][] {
  return [...new URLSearchParams(search).entries()].sort(([a], [b]) => a.localeCompare(b));
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
  accounts = [account(), liveAccount()];
  offices = pool();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pad007_admin",
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

/** Renders `/amadeus/accounts`; `rerender` renders it again as Next.js does after an action or a refresh. */
async function openAccounts(): Promise<{ rerender: () => Promise<void> }> {
  setUrl("/amadeus/accounts");
  const view = render(await AmadeusAccountsPage());
  return {
    rerender: async () => {
      view.rerender(await AmadeusAccountsPage());
    },
  };
}

async function officesPage(search: string): Promise<ReactElement> {
  return AmadeusOfficesPage({ searchParams: searchParamsOf(search) });
}

/** Renders `/amadeus/offices<search>`; `rerender` renders it again as Next.js does after an action revalidated it. */
async function openOffices(search = ""): Promise<{ rerender: () => Promise<void> }> {
  setUrl("/amadeus/offices", search);
  const view = render(await officesPage(search));
  return {
    rerender: async () => {
      view.rerender(await officesPage(search));
    },
  };
}

function link(name: string | RegExp, container: HTMLElement = document.body): HTMLAnchorElement {
  return within(container).getByRole("link", { name }) as HTMLAnchorElement;
}

/** The href of a link as written, relative to the admin. */
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

/** Types `value` into the field labelled `label` inside `container`. */
function fill(container: HTMLElement, label: string, value: string): HTMLInputElement {
  const field = within(container).getByLabelText(label) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
  return field;
}

/** The notice of the action that just answered (`data-notice="done"` or `"failed"`), once it shows. */
async function notice(kind: "done" | "failed", container: HTMLElement = document.body): Promise<HTMLElement> {
  return waitFor(() => {
    const element = container.querySelector<HTMLElement>(`[data-notice="${kind}"]`);
    if (element === null) {
      throw new Error(`no ${kind} notice yet`);
    }
    return element;
  }, UI_WAIT);
}

/** Answers the step-up dialog with a TOTP code and waits until every dialog is closed. */
async function stepUpWith(code: string): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
  fireEvent.change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), { target: { value: code } });
  submit(STEP_UP_STRINGS.submit, dialog);
  // The modal dialog hides the rest of the page from the accessibility tree until it closes.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
}

/** The section of one environment on the accounts page. */
function environmentSection(label: "Test" | "Live"): HTMLElement {
  return screen.getByRole("region", { name: A.environmentTitle(label) });
}

/** The row of the pool table that shows `officeId`. */
function officeRow(officeId: string): HTMLElement {
  const table = screen.getByRole("table");
  const cell = within(table).getByText(officeId);
  const row = cell.closest("tr");
  if (row === null) {
    throw new Error(`no row of ${officeId}`);
  }
  return row;
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** The fields of a new account as the create form sends them. */
function createFields(overrides: Record<string, string> = {}): FormData {
  return formData({
    environment: "test",
    name: "Velexis test",
    baseUrl: "https://test.travel.api.amadeus.com",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...overrides,
  });
}

const IDLE: AccountActionState = { status: "idle" };

/** The client components these pages render: Next.js sends their props, not their output, to the browser. */
const CLIENT_COMPONENTS: ReadonlySet<unknown> = new Set<unknown>([
  CreateAccountForm,
  AccountActions,
  AddOfficesForm,
  OfficeTable,
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

/**
 * Once per file, before any test: the first render of both pages in a fresh worker (the forms, the table, the filter
 * bar, the dialogs) and the first server action through the real API client are the slowest steps, and on a busy CI
 * runner they would otherwise land in the first test's own five seconds. Nothing of it stays: each test gets a fresh
 * API and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({ [`POST ${ACCOUNTS_PATH}/${TEST_ACCOUNT_ID}/verify`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
  await openAccounts();
  fireEvent.click(within(environmentSection("Test")).getByRole("button", { name: F.verify }));
  await screen.findByText(F.verifyUnavailable, {}, { timeout: WARM_UP_TIMEOUT_MS });
  fireEvent.click(within(environmentSection("Test")).getByRole("button", { name: F.disable }));
  await screen.findByRole("alertdialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openOffices();
  fireEvent.click(screen.getByRole("button", { name: `${X.assign}${X.officeSuffix("PAR1A0001")}` }));
  await screen.findByRole("dialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The accounts --------------------------------------------------------------------------------------------------

describe("amadeus/accounts/page.tsx: the Velexis Amadeus accounts", () => {
  it("shows each environment's account with its verification state, last error and pool, the client id masked [PF-90]", async () => {
    await openAccounts();

    expect(calls("GET", ACCOUNTS_PATH)).toHaveLength(1);
    expectSessionHeaders(calls("GET", ACCOUNTS_PATH)[0]);
    expect(screen.getByRole("heading", { level: 1, name: A.title })).toBeTruthy();

    const test = environmentSection("Test");
    for (const text of ["Velexis test", "Active", "https://test.travel.api.amadeus.com", A.secretStored]) {
      expect(within(test).getByText(text)).toBeTruthy();
    }
    expect(test.querySelector('time[datetime="2026-10-20T06:00:04Z"]')).not.toBeNull();
    // The client id shows its last four characters only, and the secret never: the API does not answer it.
    expect(within(test).getByText("Client id ending in 0042")).toBeTruthy();
    expect(document.body.textContent).not.toContain(CLIENT_ID);
    // The pool by status, each count linking to the pool filtered by it, as the dashboard does.
    expect(
      within(within(test).getByRole("list", { name: A.officesCaption("Test") }))
        .getAllByRole("link")
        .map((element) => [element.textContent, hrefOf(element as HTMLAnchorElement)]),
    ).toEqual([
      ["6 Available", "/amadeus/offices?environment=test&status=available"],
      ["17 Assigned", "/amadeus/offices?environment=test&status=assigned"],
      ["0 Releasing", "/amadeus/offices?environment=test&status=releasing"],
      ["1 Retired", "/amadeus/offices?environment=test&status=retired"],
    ]);
    expect(test.querySelector('[data-warning="office-pool-low"]')).toBeNull();

    // The live account was refused by Amadeus: its status, its short last error, and a pool below three.
    const live = environmentSection("Live");
    expect(within(live).getByText("Invalid credentials")).toBeTruthy();
    expect(within(live).getByText("HTTP 401 invalid_client")).toBeTruthy();
    expect(within(live).getByText(A.never)).toBeTruthy();
    expect(live.querySelector('[data-warning="office-pool-low"]')?.textContent).toBe(
      DASHBOARD_STRINGS.poolLow("Live", 2),
    );
    // Each account offers its actions; nothing to create where an account exists.
    expect(within(live).getByRole("button", { name: F.verify })).toBeTruthy();
    expect(within(live).queryByRole("button", { name: F.create("Live") })).toBeNull();
  });

  it("[PAD-007 AC1] creating an account asks for a step-up and then shows pending_verification, later active [PF-90]", async () => {
    accounts = [account()];
    let attempts = 0;
    routes({
      [`POST ${ACCOUNTS_PATH}`]: () => {
        attempts += 1;
        if (attempts === 1) {
          return apiError("REAUTH_REQUIRED", 401);
        }
        const created = liveAccount({
          name: "Velexis live",
          status: "pending_verification",
          lastError: null,
          officeCounts: { available: 0, assigned: 0, releasing: 0, retired: 0 },
          version: 1,
        });
        accounts = [account(), created];
        return json(created, 201, { etag: '"1"' });
      },
    });
    const view = await openAccounts();

    const live = environmentSection("Live");
    expect(within(live).getByText(`${A.noAccount("Live")} ${A.noAccountLive}`)).toBeTruthy();
    fireEvent.click(within(live).getByRole("button", { name: F.create("Live") }));
    const form = within(live).getByRole("form", { name: F.createTitle("Live") });
    // The live host is offered; the secret field is a password field that is never pre-filled.
    expect((within(form).getByLabelText(F.baseUrlLabel) as HTMLInputElement).value).toBe(
      "https://travel.api.amadeus.com",
    );
    const secretField = within(form).getByLabelText(F.clientSecretLabel) as HTMLInputElement;
    expect([secretField.type, secretField.value]).toEqual(["password", ""]);
    // Browsers ignore "off" on a password field and would fill in the admin's saved console password.
    expect(secretField.getAttribute("autocomplete")).toBe("new-password");

    fill(form, F.nameLabel, "Velexis live");
    fill(form, F.clientIdLabel, CLIENT_ID);
    fill(form, F.clientSecretLabel, `${CLIENT_SECRET}\n`);
    submit(F.save, form);

    // The API asks for a fresh TOTP code; after it, the same form data goes again.
    await stepUpWith(TOTP_CODE);
    const done = await notice("done", environmentSection("Live"));
    expect(done.getAttribute("role")).toBe("status");
    expect(done.textContent).toBe(F.created("Live"));

    const sent = {
      environment: "live",
      name: "Velexis live",
      baseUrl: "https://travel.api.amadeus.com",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    };
    expect(await bodies("POST", ACCOUNTS_PATH)).toEqual([sent, sent]);
    calls("POST", ACCOUNTS_PATH).forEach(expectSessionHeaders);
    expect(await bodies("POST", "/v1/admin/auth/step-up")).toEqual([{ code: TOTP_CODE }]);
    expect(cookieStore.set.mock.calls.map(([name]) => name as string)).toEqual([
      ACCESS_TOKEN_COOKIE,
      REFRESH_TOKEN_COOKIE,
    ]);
    expect(nextCache.revalidatePath.mock.calls.map(([path]) => path as string)).toEqual([
      "/amadeus/accounts",
      "/amadeus/offices",
      "/",
    ]);
    // The secret went to the API only: it is nowhere on the page.
    expect(document.body.innerHTML).not.toContain(CLIENT_SECRET);

    // The revalidated page shows the new account waiting for its verification, and says the page follows it.
    await view.rerender();
    const pending = environmentSection("Live");
    expect(within(pending).getByText("Not verified").getAttribute("data-status")).toBe(
      "pending_verification",
    );
    expect(within(pending).getByText(A.verifying)).toBeTruthy();
    expect(within(pending).queryByRole("button", { name: F.create("Live") })).toBeNull();

    // The verification job made it active: the next refresh of the page shows it.
    accounts = [
      account(),
      liveAccount({ status: "active", lastError: null, lastVerifiedAt: "2026-10-21T09:00:00Z" }),
    ];
    await view.rerender();
    const active = environmentSection("Live");
    expect(
      within(active)
        .getAllByText("Active")
        .some((badge) => badge.getAttribute("data-status") === "active"),
    ).toBe(true);
    expect(within(active).queryByText(A.verifying)).toBeNull();
  });

  it("[PAD-007 AC1] while an account waits for its verification the page asks the API again, for two minutes at most", () => {
    vi.useFakeTimers();
    try {
      const props: AccountActionsProps = {
        accountId: LIVE_ACCOUNT_ID,
        environment: "live",
        environmentLabel: "Live",
        status: "pending_verification",
        version: 1,
        name: "Velexis live",
        baseUrl: "https://travel.api.amadeus.com",
        clientIdLast4: "0042",
      };
      const first = render(<AccountActions {...props} />);
      expect(navigation.router.refresh).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
      });
      expect(navigation.router.refresh).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS * PENDING_REFRESH_LIMIT * 2);
      });
      expect(navigation.router.refresh).toHaveBeenCalledTimes(PENDING_REFRESH_LIMIT);
      first.unmount();

      // Once the refreshed page shows the result, the page stops asking; an active account never asks.
      navigation.router.refresh.mockClear();
      const second = render(<AccountActions {...props} />);
      act(() => {
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
      });
      second.rerender(<AccountActions {...props} status="active" version={2} />);
      act(() => {
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 10);
      });
      expect(navigation.router.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[PAD-007 AC1] rotating the secret asks for a step-up; the field is never pre-filled and the secret never comes back", async () => {
    const path = `${ACCOUNTS_PATH}/${TEST_ACCOUNT_ID}`;
    let attempts = 0;
    routes({
      [`PATCH ${path}`]: () => {
        attempts += 1;
        if (attempts === 1) {
          return apiError("REAUTH_REQUIRED", 401);
        }
        accounts = [account({ status: "pending_verification", version: 4 }), liveAccount()];
        return json(accounts[0], 200, { etag: '"4"' });
      },
    });
    const view = await openAccounts();
    const test = environmentSection("Test");
    fireEvent.click(within(test).getByRole("button", { name: F.rotate }));
    const form = within(test).getByRole("form", { name: F.rotateTitle });
    const field = within(form).getByLabelText(F.newSecretLabel) as HTMLInputElement;
    expect([field.type, field.value, field.getAttribute("value")]).toEqual(["password", "", ""]);
    expect(field.getAttribute("autocomplete")).toBe("new-password");

    fill(form, F.newSecretLabel, NEW_SECRET);
    submit(F.saveSecret, form);
    await stepUpWith(TOTP_CODE);

    const done = await notice("done", environmentSection("Test"));
    expect(done.textContent).toBe(F.rotated);
    expect(await bodies("PATCH", path)).toEqual([{ clientSecret: NEW_SECRET }, { clientSecret: NEW_SECRET }]);
    expect(calls("PATCH", path).map((request) => request.headers.get("if-match"))).toEqual(['"3"', '"3"']);
    // The form closed; the secret is nowhere on the page.
    expect(within(environmentSection("Test")).queryByRole("form", { name: F.rotateTitle })).toBeNull();
    expect(document.body.innerHTML).not.toContain(NEW_SECRET);
    // The revalidated page: the account is verified again with the new secret.
    await view.rerender();
    expect(within(environmentSection("Test")).getByText("Not verified")).toBeTruthy();
    expect(within(environmentSection("Test")).getByText(A.verifying)).toBeTruthy();

    // The action's state never carries the secret either, refused or saved.
    routes({ [`PATCH ${path}`]: () => apiError("PRECONDITION_FAILED", 412) });
    const stale = await rotateAmadeusAccountSecret(
      IDLE,
      formData({ accountId: TEST_ACCOUNT_ID, version: "3", clientSecret: NEW_SECRET }),
    );
    expect(stale).toEqual({
      status: "failed",
      code: "PRECONDITION_FAILED",
      message: F.stale,
      fieldErrors: {},
    });
    expect(JSON.stringify(stale)).not.toContain(NEW_SECRET);
  });

  it("[PAD-007 AC1] a step-up asked after an earlier save is no outcome: the form stays open and nothing says saved", async () => {
    const path = `${ACCOUNTS_PATH}/${TEST_ACCOUNT_ID}`;
    let attempts = 0;
    routes({
      [`PATCH ${path}`]: () => {
        attempts += 1;
        // The first rotation is within the step-up window; the second one comes after it.
        if (attempts === 2) {
          return apiError("REAUTH_REQUIRED", 401);
        }
        accounts = [account({ status: "pending_verification", version: 3 + attempts }), liveAccount()];
        return json(accounts[0], 200);
      },
    });
    const view = await openAccounts();
    fireEvent.click(within(environmentSection("Test")).getByRole("button", { name: F.rotate }));
    const first = within(environmentSection("Test")).getByRole("form", { name: F.rotateTitle });
    fill(first, F.newSecretLabel, NEW_SECRET);
    submit(F.saveSecret, first);
    expect((await notice("done", environmentSection("Test"))).textContent).toBe(F.rotated);
    await view.rerender();

    // The second rotation asks for a fresh code: the form stays open and no notice claims the secret is stored.
    fireEvent.click(within(environmentSection("Test")).getByRole("button", { name: F.rotate }));
    const second = within(environmentSection("Test")).getByRole("form", { name: F.rotateTitle });
    fill(second, F.newSecretLabel, `${NEW_SECRET}-2`);
    submit(F.saveSecret, second);
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    expect(document.querySelector('[data-notice="done"]')).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    // Cancelled: nothing was stored, and nothing says so; the form is still there to try again.
    expect(document.querySelector('[data-notice="done"]')).toBeNull();
    expect(within(environmentSection("Test")).getByRole("form", { name: F.rotateTitle })).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("empties a refused secret, keeps the other fields and shows the API's field errors at their fields", async () => {
    accounts = [account()];
    routes({
      [`POST ${ACCOUNTS_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, undefined, { fieldErrors: [{ path: "/baseUrl", code: "https" }] }),
    });
    await openAccounts();
    const live = environmentSection("Live");
    fireEvent.click(within(live).getByRole("button", { name: F.create("Live") }));
    const form = within(live).getByRole("form", { name: F.createTitle("Live") });
    fill(form, F.nameLabel, "Velexis live");
    fill(form, F.baseUrlLabel, "http://127.0.0.1:4900");
    fill(form, F.clientIdLabel, CLIENT_ID);
    const secretField = fill(form, F.clientSecretLabel, CLIENT_SECRET);
    submit(F.save, form);

    await waitFor(() => expect(within(form).getByText(F.baseUrlInvalid)).toBeTruthy(), UI_WAIT);
    expect(within(form).getByLabelText(F.baseUrlLabel).getAttribute("aria-invalid")).toBe("true");
    expect(secretField.value).toBe("");
    expect((within(form).getByLabelText(F.clientIdLabel) as HTMLInputElement).value).toBe(CLIENT_ID);
    expect(document.body.innerHTML).not.toContain(CLIENT_SECRET);
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("edits the name without a step-up, and asks to reload a stale page (412)", async () => {
    const path = `${ACCOUNTS_PATH}/${TEST_ACCOUNT_ID}`;
    routes({ [`PATCH ${path}`]: () => json(account({ name: "Velexis test EU", version: 4 }), 200) });
    await openAccounts();
    const test = environmentSection("Test");
    fireEvent.click(within(test).getByRole("button", { name: F.edit }));
    const form = within(test).getByRole("form", { name: F.editTitle });
    // The name and the host as they are; the client id empty, which keeps it.
    expect((within(form).getByLabelText(F.nameLabel) as HTMLInputElement).value).toBe("Velexis test");
    expect((within(form).getByLabelText(F.baseUrlLabel) as HTMLInputElement).value).toBe(
      "https://test.travel.api.amadeus.com",
    );
    expect((within(form).getByLabelText(F.clientIdLabel) as HTMLInputElement).value).toBe("");
    expect(within(form).getByText(F.clientIdKeepHint("0042"))).toBeTruthy();

    fill(form, F.nameLabel, "  Velexis test EU ");
    submit(F.saveDetails, form);
    const done = await notice("done", environmentSection("Test"));
    expect(within(done).getByText(F.edited)).toBeTruthy();
    expect(await bodies("PATCH", path)).toEqual([
      { name: "Velexis test EU", baseUrl: "https://test.travel.api.amadeus.com" },
    ]);
    expect(calls("PATCH", path)[0]?.headers.get("if-match")).toBe('"3"');
    expect(screen.queryByRole("dialog")).toBeNull();

    // Someone else changed the account meanwhile: nothing is saved, and the page offers a full reload.
    routes({ [`PATCH ${path}`]: () => apiError("PRECONDITION_FAILED", 412) });
    fireEvent.click(within(environmentSection("Test")).getByRole("button", { name: F.edit }));
    const again = within(environmentSection("Test")).getByRole("form", { name: F.editTitle });
    // A form opened again starts without the previous outcome.
    expect(again.querySelector("[data-notice]")).toBeNull();
    fill(again, F.clientIdLabel, "pad007OtherClientId9999");
    submit(F.saveDetails, again);
    const failed = await notice("failed", again);
    expect(failed.getAttribute("data-code")).toBe("PRECONDITION_FAILED");
    expect(within(failed).getByText(F.stale)).toBeTruthy();
    expect(hrefOf(link(F.reload, failed))).toBe("/amadeus/accounts");
    expect(await bodies("PATCH", path)).toContainEqual({
      name: "Velexis test",
      baseUrl: "https://test.travel.api.amadeus.com",
      clientId: "pad007OtherClientId9999",
    });
  });

  it("disables an account after a confirmation, and a disabled one offers Verify and enable", async () => {
    const path = `${ACCOUNTS_PATH}/${TEST_ACCOUNT_ID}`;
    routes({
      [`PATCH ${path}`]: () => {
        accounts = [account({ status: "disabled", version: 4 }), liveAccount()];
        return json(accounts[0], 200);
      },
      [`POST ${path}/verify`]: () => {
        accounts = [account({ status: "pending_verification", version: 4 }), liveAccount()];
        return accepted();
      },
    });
    const view = await openAccounts();
    fireEvent.click(within(environmentSection("Test")).getByRole("button", { name: F.disable }));
    const dialog = await screen.findByRole("alertdialog", { name: F.disableTitle("Test") }, UI_WAIT);
    expect(within(dialog).getByText(F.disableDescription)).toBeTruthy();
    expect(calls("PATCH", path)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: F.disableConfirm }));

    const done = await notice("done", environmentSection("Test"));
    expect(done.textContent).toBe(F.disabled);
    expect(await bodies("PATCH", path)).toEqual([{ status: "disabled" }]);
    expect(calls("PATCH", path)[0]?.headers.get("if-match")).toBe('"3"');

    // The revalidated page: no "Disable account" any more, and the verification enables the account again.
    await view.rerender();
    const test = environmentSection("Test");
    expect(within(test).queryByRole("button", { name: F.disable })).toBeNull();
    fireEvent.click(within(test).getByRole("button", { name: F.verifyAndEnable }));
    await waitFor(
      () => expect(within(environmentSection("Test")).getByText(F.verifyQueued)).toBeTruthy(),
      UI_WAIT,
    );
    expect(await bodies("POST", `${path}/verify`)).toEqual([null]);
    expectSessionHeaders(calls("POST", `${path}/verify`)[0]);
    await view.rerender();
    expect(within(environmentSection("Test")).getByText(A.verifying)).toBeTruthy();
  });

  it("words the refusals of the API, never with its own text, and sends an ended session to sign-in", async () => {
    const cases: [Route, Partial<AccountActionState>][] = [
      [
        () => apiError("CONFLICT", 409, { reason: "environment_exists" }),
        { code: "CONFLICT", message: F.environmentExists },
      ],
      [
        () => apiError("RATE_LIMITED", 429, undefined, { headers: { "retry-after": "90" } }),
        { code: "RATE_LIMITED", message: F.rateLimitedFor(90) },
      ],
      [
        () => apiError("INTERNAL_ERROR", 500),
        { code: "INTERNAL_ERROR", message: ERROR_MESSAGES.INTERNAL_ERROR },
      ],
      [
        () =>
          apiError("VALIDATION_FAILED", 400, undefined, {
            fieldErrors: [{ path: "/environment", code: "enum" }],
          }),
        { code: "VALIDATION_FAILED", message: F.formExpired },
      ],
    ];
    for (const [answer, expected] of cases) {
      routes({ [`POST ${ACCOUNTS_PATH}`]: answer });
      const state = await createAmadeusAccount(IDLE, createFields());
      expect(state).toMatchObject({ status: "failed", ...expected });
      expect(JSON.stringify(state)).not.toContain(CLIENT_SECRET);
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // A verification is its job: Redis not taking it is said so; an unknown account too.
    const verifyPath = `${ACCOUNTS_PATH}/${TEST_ACCOUNT_ID}/verify`;
    routes({ [`POST ${verifyPath}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    expect(await verifyAmadeusAccount(IDLE, formData({ accountId: TEST_ACCOUNT_ID }))).toMatchObject({
      status: "failed",
      message: F.verifyUnavailable,
    });
    routes({ [`POST ${verifyPath}`]: () => apiError("NOT_FOUND", 404) });
    expect(await verifyAmadeusAccount(IDLE, formData({ accountId: TEST_ACCOUNT_ID }))).toMatchObject({
      status: "failed",
      message: F.accountGone,
    });

    routes({ [`POST ${ACCOUNTS_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(createAmadeusAccount(IDLE, createFields())).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: "/amadeus/accounts" }).toString()}`,
    );

    // Through the page: the notice shows the admin's words only.
    routes({ [`POST ${verifyPath}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openAccounts();
    fireEvent.click(within(environmentSection("Test")).getByRole("button", { name: F.verify }));
    const failed = await notice("failed", environmentSection("Test"));
    expect(failed.textContent).toBe(F.verifyUnavailable);
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("the actions refuse invalid fields without calling the API, and never return the secret", async () => {
    const cases: [Record<string, string>, Partial<Record<string, string>>][] = [
      [{ name: "  " }, { name: F.nameRequired }],
      [{ name: "n".repeat(101) }, { name: F.nameTooLong }],
      [{ baseUrl: "http://example.com" }, { baseUrl: F.baseUrlInvalid }],
      [{ baseUrl: "https://test.travel.api.amadeus.com?x=1" }, { baseUrl: F.baseUrlInvalid }],
      [{ baseUrl: `https://${"h".repeat(300)}.example.com` }, { baseUrl: F.baseUrlInvalid }],
      [{ clientId: "" }, { clientId: F.clientIdRequired }],
      [{ clientId: "two words" }, { clientId: F.clientIdInvalid }],
      [{ clientSecret: "   " }, { clientSecret: F.clientSecretRequired }],
      [{ clientSecret: `${CLIENT_SECRET}${"s".repeat(512)}` }, { clientSecret: F.clientSecretTooLong }],
    ];
    for (const [fields, fieldErrors] of cases) {
      const state = await createAmadeusAccount(IDLE, createFields(fields));
      expect(state).toEqual({ status: "failed", code: "VALIDATION_FAILED", fieldErrors });
      expect(JSON.stringify(state)).not.toContain(CLIENT_SECRET);
    }
    expect(await createAmadeusAccount(IDLE, createFields({ environment: "staging" }))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: F.formExpired,
      fieldErrors: {},
    });

    // The updates need the account and the version of the page.
    for (const hidden of [
      { accountId: "ama_1", version: "3" },
      { accountId: TEST_ACCOUNT_ID, version: "0" },
      { accountId: TEST_ACCOUNT_ID, version: "" },
      { accountId: `${TEST_ACCOUNT_ID}/../x`, version: "3" },
    ]) {
      for (const action of [updateAmadeusAccountDetails, rotateAmadeusAccountSecret, disableAmadeusAccount]) {
        expect(
          await action(
            IDLE,
            formData({
              ...hidden,
              name: "Velexis test",
              baseUrl: "https://a.example",
              clientSecret: NEW_SECRET,
            }),
          ),
        ).toMatchObject({ status: "failed", message: F.formExpired });
      }
    }
    expect(
      await updateAmadeusAccountDetails(
        IDLE,
        formData({
          accountId: TEST_ACCOUNT_ID,
          version: "3",
          name: "Velexis",
          baseUrl: "https://a.example",
          clientId: "a b",
        }),
      ),
    ).toMatchObject({ fieldErrors: { clientId: F.clientIdInvalid } });
    expect(
      await rotateAmadeusAccountSecret(
        IDLE,
        formData({ accountId: TEST_ACCOUNT_ID, version: "3", clientSecret: "" }),
      ),
    ).toMatchObject({ fieldErrors: { clientSecret: F.clientSecretRequired } });
    expect(await verifyAmadeusAccount(IDLE, formData({ accountId: "acme" }))).toMatchObject({
      message: F.formExpired,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the client forms no more than they show: no full client id, nothing the document lacks", async () => {
    const sentinel = "PAD007-SENTINEL-CIPHERTEXT";
    routes({
      [`GET ${ACCOUNTS_PATH}`]: () =>
        json(
          {
            data: [
              { ...account(), clientSecretCiphertext: sentinel, encryptionKeyId: sentinel },
              { ...liveAccount(), clientSecret: sentinel },
            ],
          },
          200,
        ),
    });
    const page = await AmadeusAccountsPage();

    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain(TEST_ACCOUNT_ID);
    expect(payload).not.toContain(sentinel);
    expect(payload).not.toContain(CLIENT_ID);
    render(page);
    expect(document.body.innerHTML).not.toContain(sentinel);
  });

  it("shows the admin's message when the accounts cannot be loaded, and sends an ended session to sign-in", async () => {
    routes({ [`GET ${ACCOUNTS_PATH}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openAccounts();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(A.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();

    routes({ [`GET ${ACCOUNTS_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(AmadeusAccountsPage()).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });
});

// ---- The office pool -----------------------------------------------------------------------------------------------

describe("amadeus/offices/page.tsx: the office pool", () => {
  it("lists the pool with the filters of the URL and links the OTA of each assigned office [PF-90]", async () => {
    await openOffices("environment=test&status=assigned");

    expect(queryOfCall(OFFICES_PATH)).toEqual([
      ["environment", "test"],
      ["status", "assigned"],
    ]);
    expectSessionHeaders(calls("GET", OFFICES_PATH)[0]);
    expect(screen.getByRole("heading", { level: 1, name: O.title })).toBeTruthy();
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(2);
    const row = officeRow("NCE1A0955");
    expect(hrefOf(link("acme", row))).toBe(`/tenants/${ACME_ID}`);
    expect(within(row).getByText("Assigned").getAttribute("data-status")).toBe("assigned");
    expect(row.querySelector('time[datetime="2026-10-14T08:20:15Z"]')).not.toBeNull();

    // The selects show the URL's filters and offer every environment and status of the document.
    const environment = screen.getByRole("combobox", { name: O.environmentLabel }) as HTMLSelectElement;
    const status = screen.getByRole("combobox", { name: O.statusLabel }) as HTMLSelectElement;
    expect([environment.value, status.value]).toEqual(["test", "assigned"]);
    expect([...status.options].map((option) => option.value)).toEqual([
      "",
      "available",
      "assigned",
      "releasing",
      "retired",
    ]);

    // Another status keeps the environment and goes into the URL.
    fireEvent.change(status, { target: { value: "available" } });
    const [href] = navigation.router.push.mock.calls[0] as [string];
    const url = new URL(href, "https://admin.invalid");
    expect(url.pathname).toBe("/amadeus/offices");
    expect(sortedQuery(url.search)).toEqual([
      ["environment", "test"],
      ["status", "available"],
    ]);
  });

  it("[PAD-007 AC2] bulk add reports created and skipped ids [PF-90]", async () => {
    routes({
      [`POST ${OFFICES_PATH}`]: () =>
        json(
          {
            created: [office({ officeId: "PAR1A0001" }), office({ id: NEW_ROW, officeId: "PAR1A0002" })],
            skipped: ["NCE1A0955", "PAR1A0001"],
          },
          201,
        ),
    });
    await openOffices("environment=test");
    const section = screen.getByRole("region", { name: ADD.title });
    // The account of the page's environment is chosen first.
    expect((within(section).getByLabelText(ADD.accountLabel) as HTMLSelectElement).value).toBe(
      TEST_ACCOUNT_ID,
    );
    expect(
      [...(within(section).getByLabelText(ADD.accountLabel) as HTMLSelectElement).options].map(
        (option) => option.textContent,
      ),
    ).toEqual([ADD.accountOption("Velexis test", "Test"), ADD.accountOption("Velexis live", "Live")]);

    const ids = fill(section, ADD.officeIdsLabel, "nce1a0955\n\n  PAR1A0001  \r\npar1a0001\nPAR1A0002\n");
    fill(section, ADD.notesLabel, " Ordered with the October batch. ");
    submit(ADD.add, section);

    const done = await notice("done", section);
    expect(done.getAttribute("role")).toBe("status");
    const created = done.querySelector<HTMLElement>('[data-outcome="created"]') as HTMLElement;
    expect(within(created).getByText(ADD.createdTitle(2))).toBeTruthy();
    expect(
      within(within(created).getByRole("list", { name: ADD.createdCaption }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["PAR1A0001", "PAR1A0002"]);
    const skipped = done.querySelector<HTMLElement>('[data-outcome="skipped"]') as HTMLElement;
    expect(within(skipped).getByText(ADD.skippedTitle(2))).toBeTruthy();
    expect(
      within(within(skipped).getByRole("list", { name: ADD.skippedCaption }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["NCE1A0955", "PAR1A0001"]);

    // One id per line, trimmed, empty lines dropped; the API upper-cases them and skips repeats.
    expect(await bodies("POST", OFFICES_PATH)).toEqual([
      {
        amadeusAccountId: TEST_ACCOUNT_ID,
        officeIds: ["nce1a0955", "PAR1A0001", "par1a0001", "PAR1A0002"],
        notes: "Ordered with the October batch.",
      },
    ]);
    expectSessionHeaders(calls("POST", OFFICES_PATH)[0]);
    // The list is emptied, so the same ids are not sent twice; the pool, the accounts and the dashboard follow.
    expect(ids.value).toBe("");
    expect(nextCache.revalidatePath.mock.calls.map(([path]) => path as string)).toEqual([
      "/amadeus/offices",
      "/amadeus/accounts",
      "/",
    ]);
  });

  it("[PAD-007 AC2] bulk add says when nothing was new, and refuses what is no office id without calling the API", async () => {
    routes({ [`POST ${OFFICES_PATH}`]: () => json({ created: [], skipped: ["NCE1A0955"] }, 201) });
    await openOffices();
    const section = screen.getByRole("region", { name: ADD.title });
    fill(section, ADD.officeIdsLabel, "NCE1A0955");
    submit(ADD.add, section);
    const done = await notice("done", section);
    expect(within(done).getByText(ADD.createdTitle(0))).toBeTruthy();
    expect(within(done).queryByRole("list", { name: ADD.createdCaption })).toBeNull();
    expect(within(done).getByText(ADD.skippedTitle(1))).toBeTruthy();

    // Lines that are no office id are named by their number, never repeated; nothing is sent.
    fetchMock.mockClear();
    fill(section, ADD.officeIdsLabel, "NCE1A0955\nNCE 1A0955\nPAR1A0001\n<script>\n");
    submit(ADD.add, section);
    const problem = await within(section).findByText(ADD.officeIdsInvalid([2, 4]), {}, UI_WAIT);
    expect(problem.textContent).not.toContain("script");
    expect(within(section).getByLabelText(ADD.officeIdsLabel).getAttribute("aria-invalid")).toBe("true");
    expect(calls("POST", OFFICES_PATH)).toHaveLength(0);

    const idle: AddOfficesState = { status: "idle" };
    const refusals: [Record<string, string>, Record<string, string>][] = [
      [{ officeIds: " \n \n" }, { officeIds: ADD.officeIdsRequired }],
      [{ officeIds: Array.from({ length: 501 }, () => "NCE1A0955").join("\n") }, { officeIds: ADD.tooMany }],
      [{ officeIds: "NCE1A0955", notes: "n".repeat(2001) }, { notes: ADD.notesTooLong }],
      [{ officeIds: "NCE1A0955", amadeusAccountId: "ama_1" }, { amadeusAccountId: ADD.accountInvalid }],
    ];
    for (const [fields, fieldErrors] of refusals) {
      expect(await addOffices(idle, formData({ amadeusAccountId: TEST_ACCOUNT_ID, ...fields }))).toEqual({
        status: "failed",
        code: "VALIDATION_FAILED",
        message: "",
        fieldErrors,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // An account removed meanwhile, and an ended session.
    routes({ [`POST ${OFFICES_PATH}`]: () => apiError("NOT_FOUND", 404) });
    expect(
      await addOffices(idle, formData({ amadeusAccountId: TEST_ACCOUNT_ID, officeIds: "NCE1A0955" })),
    ).toMatchObject({ status: "failed", code: "NOT_FOUND", message: ADD.accountGone });
    routes({ [`POST ${OFFICES_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(
      addOffices(idle, formData({ amadeusAccountId: TEST_ACCOUNT_ID, officeIds: "NCE1A0955" })),
    ).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: "/amadeus/offices" }).toString()}`,
    );
  });

  it("keeps the list, and shows no earlier outcome, while a step-up is asked for after an earlier addition", async () => {
    let attempts = 0;
    routes({
      [`POST ${OFFICES_PATH}`]: () => {
        attempts += 1;
        return attempts === 2
          ? apiError("REAUTH_REQUIRED", 401)
          : json({ created: [office({ officeId: "PAR1A0001" })], skipped: [] }, 201);
      },
    });
    await openOffices();
    const section = screen.getByRole("region", { name: ADD.title });
    fill(section, ADD.officeIdsLabel, "PAR1A0001");
    submit(ADD.add, section);
    await notice("done", section);

    const ids = fill(section, ADD.officeIdsLabel, "PAR1A0003");
    submit(ADD.add, section);
    await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    // No answer yet: the earlier outcome is gone and the new list is still there to be sent again.
    expect(section.querySelector('[data-notice="done"]')).toBeNull();
    expect(ids.value).toBe("PAR1A0003");
  });

  it("explains the bulk form when there is no account, or when the accounts cannot be loaded", async () => {
    accounts = [];
    await openOffices();
    const section = screen.getByRole("region", { name: ADD.title });
    expect(within(section).getByText(ADD.noAccount)).toBeTruthy();
    expect(hrefOf(link(ADD.accountsLink, section))).toBe("/amadeus/accounts");
    expect(within(section).queryByRole("button")).toBeNull();
    cleanup();

    routes({ [`GET ${ACCOUNTS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openOffices();
    expect(
      within(screen.getByRole("region", { name: ADD.title })).getByText(ADD.accountsUnavailable),
    ).toBeTruthy();
    // The list still shows.
    expect(officeRow("PAR1A0001")).toBeTruthy();
  });

  it("offers Assign and Retire only on available offices, and notes on every office", async () => {
    await openOffices();
    const buttonsOf = (officeId: string) =>
      within(officeRow(officeId))
        .getAllByRole("button")
        .map((button) => button.textContent);
    expect(buttonsOf("PAR1A0001")).toEqual([
      `${X.assign}${X.officeSuffix("PAR1A0001")}`,
      `${X.retire}${X.officeSuffix("PAR1A0001")}`,
      `${X.editNotes}${X.notesSuffix("PAR1A0001")}`,
    ]);
    for (const officeId of ["NCE1A0955", "MUC1A0100", "LON1A0042"]) {
      expect(buttonsOf(officeId)).toEqual([`${X.editNotes}${X.notesSuffix(officeId)}`]);
    }
    // A releasing office names its OTA and since when it is releasing; a retired one keeps its notes.
    const releasing = officeRow("MUC1A0100");
    expect(hrefOf(link("nordicair", releasing))).toBe(`/tenants/${NORDICAIR_ID}`);
    expect(within(releasing).getByText(O.releasingSince, { exact: false })).toBeTruthy();
    expect(within(officeRow("LON1A0042")).getByText("Closed by Amadeus.")).toBeTruthy();
    // Looking at the pool changes nothing.
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("assigns an available office to an OTA by its key, and the OTA's connection becomes active [PF-90]", async () => {
    const path = `${OFFICES_PATH}/${AVAILABLE_ROW}/assign`;
    routes({
      [`POST ${path}`]: () => {
        const assigned = office({
          status: "assigned",
          assignedTenant: { id: NORDIC_ID, key: "nordic" },
          assignedAt: "2026-10-21T10:12:30Z",
          version: 2,
        });
        offices = offices.map((row) => (row.id === AVAILABLE_ROW ? assigned : row));
        return json({ office: assigned, connection: activeConnection("PAR1A0001") }, 200);
      },
    });
    const view = await openOffices();
    fireEvent.click(screen.getByRole("button", { name: `${X.assign}${X.officeSuffix("PAR1A0001")}` }));
    const dialog = await screen.findByRole("dialog", { name: X.assignTitle("PAR1A0001") }, UI_WAIT);
    expect(within(dialog).getByText(X.assignIntro)).toBeTruthy();
    fill(dialog, X.tenantLabel, " Nordic ");
    submit(X.assignConfirm, dialog);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    const done = await notice("done");
    expect(within(done).getByText(X.assigned("PAR1A0001", "nordic"))).toBeTruthy();
    expect(within(done).getByText("Active").getAttribute("data-status")).toBe("active");
    expect(hrefOf(link(`${X.openTenant} nordic`, done))).toBe(`/tenants/${NORDIC_ID}`);

    // The key found exactly "nordic" among the OTAs whose key contains it, and the API got its id.
    expect(queryOfCall("/v1/admin/tenants")).toEqual([
      ["limit", "200"],
      ["q", "nordic"],
    ]);
    expect(await bodies("POST", path)).toEqual([{ tenantId: NORDIC_ID }]);
    expectSessionHeaders(calls("POST", path)[0]);
    expect(nextCache.revalidatePath.mock.calls.map(([revalidated]) => revalidated as string)).toEqual([
      "/amadeus/offices",
      "/amadeus/accounts",
      "/",
      `/tenants/${NORDIC_ID}`,
    ]);

    // The revalidated pool shows the office assigned to the OTA, with nothing to assign or retire any more.
    await view.rerender();
    const row = officeRow("PAR1A0001");
    expect(hrefOf(link("nordic", row))).toBe(`/tenants/${NORDIC_ID}`);
    expect(within(row).queryByRole("button", { name: /^Assign/ })).toBeNull();
    expect(screen.getByText(X.assigned("PAR1A0001", "nordic"))).toBeTruthy();
  });

  it("refuses an unknown or invalid OTA at the field, takes a tenant id as it is, and words the API's conflicts", async () => {
    const path = `${OFFICES_PATH}/${AVAILABLE_ROW}/assign`;
    await openOffices();
    fireEvent.click(screen.getByRole("button", { name: `${X.assign}${X.officeSuffix("PAR1A0001")}` }));
    const dialog = await screen.findByRole("dialog", { name: X.assignTitle("PAR1A0001") }, UI_WAIT);
    // "nord" is part of two keys, but the key of no OTA.
    fill(dialog, X.tenantLabel, "nord");
    submit(X.assignConfirm, dialog);
    await waitFor(() => expect(within(dialog).getByText(X.tenantUnknown)).toBeTruthy(), UI_WAIT);
    expect(within(dialog).getByLabelText(X.tenantLabel).getAttribute("aria-invalid")).toBe("true");
    expect((within(dialog).getByLabelText(X.tenantLabel) as HTMLInputElement).value).toBe("nord");
    expect(calls("POST", path)).toHaveLength(0);

    const idle = { status: "idle" } as const;
    fetchMock.mockClear();
    for (const [value, message] of [
      ["", X.tenantRequired],
      ["Nordic Fares", X.tenantInvalid],
      ["ten_123", X.tenantInvalid],
    ] as const) {
      expect(
        await assignOfficeToTenant(idle, formData({ officeRowId: AVAILABLE_ROW, tenant: value })),
      ).toMatchObject({ status: "failed", fieldError: message });
    }
    expect(
      await assignOfficeToTenant(idle, formData({ officeRowId: "amo_1", tenant: "nordic" })),
    ).toMatchObject({
      status: "failed",
      message: X.formExpired,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const cases: [Route, string][] = [
      [() => apiError("AMADEUS_OFFICE_UNAVAILABLE", 409), ASSIGN_OFFICE_STRINGS.officeUnavailable],
      [
        () => apiError("CONFLICT", 409, { reason: "tenant_credentials" }),
        ASSIGN_OFFICE_STRINGS.tenantCredentials,
      ],
      [
        () => apiError("CONFLICT", 409, { reason: "office_already_assigned" }),
        ASSIGN_OFFICE_STRINGS.officeAlreadyAssigned,
      ],
      [() => apiError("NOT_FOUND", 404), ASSIGN_OFFICE_STRINGS.notFound],
    ];
    for (const [answer, message] of cases) {
      routes({ [`POST ${path}`]: answer });
      // A tenant id goes to the API as it is, without a lookup.
      expect(
        await assignOfficeToTenant(idle, formData({ officeRowId: AVAILABLE_ROW, tenant: ACME_ID })),
      ).toEqual({
        status: "failed",
        code: expect.any(String) as string,
        message,
        officeRowId: AVAILABLE_ROW,
      });
    }
    expect(calls("GET", "/v1/admin/tenants")).toHaveLength(0);
    expect(await bodies("POST", path)).toEqual(cases.map(() => ({ tenantId: ACME_ID })));
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("finds the OTA of a key beyond the first page of OTAs that merely contain it, and says when there are too many", async () => {
    const path = `${OFFICES_PATH}/${AVAILABLE_ROW}/assign`;
    // `q=air` matches part of many keys, names and owners, newest first: the OTA "air" itself is on the second page.
    const others = Array.from({ length: 200 }, (_, index) =>
      tenant(`ten_01JD${String(index).padStart(22, "0")}`, `air${String(index).padStart(3, "0")}`),
    );
    const AIR_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D9A";
    let endless = false;
    routes({
      "GET /v1/admin/tenants": (request) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (endless || cursor === null) {
          return json({ data: others, page: { nextCursor: `after-${cursor ?? "start"}`, limit: 200 } }, 200);
        }
        return json({ data: [tenant(AIR_ID, "air")], page: { nextCursor: null, limit: 200 } }, 200);
      },
      [`POST ${path}`]: () =>
        json(
          {
            office: office({ status: "assigned", assignedTenant: { id: AIR_ID, key: "air" }, version: 2 }),
            connection: activeConnection("PAR1A0001"),
          },
          200,
        ),
    });
    const idle = { status: "idle" } as const;
    expect(
      await assignOfficeToTenant(idle, formData({ officeRowId: AVAILABLE_ROW, tenant: "air" })),
    ).toMatchObject({
      status: "done",
      tenantId: AIR_ID,
      tenantKey: "air",
    });
    expect(
      calls("GET", "/v1/admin/tenants").map((request) => sortedQuery(new URL(request.url).search)),
    ).toEqual([
      [
        ["limit", "200"],
        ["q", "air"],
      ],
      [
        ["cursor", "after-start"],
        ["limit", "200"],
        ["q", "air"],
      ],
    ]);
    expect(await bodies("POST", path)).toEqual([{ tenantId: AIR_ID }]);

    // A key that thousands of OTAs contain is not looked up for ever: after five pages (1,000 OTAs) the field asks
    // for the tenant id instead (README §4, office pool). A "use server" module exports functions only, hence the 5.
    endless = true;
    fetchMock.mockClear();
    expect(
      await assignOfficeToTenant(idle, formData({ officeRowId: AVAILABLE_ROW, tenant: "air" })),
    ).toMatchObject({
      status: "failed",
      fieldError: X.tenantTooManyMatches,
    });
    expect(calls("GET", "/v1/admin/tenants")).toHaveLength(5);
    expect(calls("POST", path)).toHaveLength(0);
  });

  it("retires an available office with a reason [PF-90]", async () => {
    const path = `${OFFICES_PATH}/${AVAILABLE_ROW}/retire`;
    routes({
      [`POST ${path}`]: () => json(office({ status: "retired", version: 2 }), 200),
    });
    await openOffices();
    fireEvent.click(screen.getByRole("button", { name: `${X.retire}${X.officeSuffix("PAR1A0001")}` }));
    const dialog = await screen.findByRole("dialog", { name: X.retireTitle("PAR1A0001") }, UI_WAIT);
    expect(within(dialog).getByText(X.retireDescription)).toBeTruthy();

    // Four characters are refused at the field, and nothing is sent.
    fill(dialog, REASON_STRINGS.label, "Shut");
    submit(X.retireConfirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
    expect(calls("POST", path)).toHaveLength(0);

    fill(dialog, REASON_STRINGS.label, `  ${REASON} `);
    submit(X.retireConfirm, dialog);
    const done = await notice("done");
    expect(done.textContent).toBe(X.retired("PAR1A0001"));
    expect(await bodies("POST", path)).toEqual([{ reason: REASON }]);
    expectSessionHeaders(calls("POST", path)[0]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/amadeus/offices");

    // An office assigned meanwhile cannot be retired: said in the admin's words.
    routes({ [`POST ${path}`]: () => apiError("CONFLICT", 409, { reason: "not_available" }) });
    fireEvent.click(screen.getByRole("button", { name: `${X.retire}${X.officeSuffix("PAR1A0001")}` }));
    const again = await screen.findByRole("dialog", { name: X.retireTitle("PAR1A0001") }, UI_WAIT);
    fill(again, REASON_STRINGS.label, REASON);
    submit(X.retireConfirm, again);
    const failed = await notice("failed");
    expect(failed.getAttribute("data-code")).toBe("CONFLICT");
    expect(failed.textContent).toBe(X.notAvailable);
    expect(document.body.textContent).not.toContain("The API's own text");

    // Made-up fields send nothing.
    fetchMock.mockClear();
    const idle = { status: "idle" } as const;
    expect(await retireOffice(idle, formData({ officeRowId: AVAILABLE_ROW, reason: "Shut" }))).toMatchObject({
      message: REASON_STRINGS.tooShort,
    });
    expect(await retireOffice(idle, formData({ officeRowId: "PAR1A0001", reason: REASON }))).toMatchObject({
      message: X.formExpired,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("edits an office's notes with If-Match, and asks to reload a stale page (412) keeping the text", async () => {
    const path = `${OFFICES_PATH}/${ASSIGNED_ROW}`;
    let answer: Route = () =>
      json(
        office({ id: ASSIGNED_ROW, officeId: "NCE1A0955", notes: "Ticketing agreement TA-118.", version: 3 }),
        200,
      );
    routes({ [`PATCH ${path}`]: (request) => answer(request) });
    await openOffices("status=assigned");
    fireEvent.click(screen.getByRole("button", { name: `${X.editNotes}${X.notesSuffix("NCE1A0955")}` }));
    const dialog = await screen.findByRole("dialog", { name: X.notesTitle("NCE1A0955") }, UI_WAIT);
    expect((within(dialog).getByLabelText(X.notesLabel) as HTMLTextAreaElement).value).toBe("");
    fill(dialog, X.notesLabel, " Ticketing agreement TA-118. ");
    submit(X.saveNotes, dialog);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
    expect((await notice("done")).textContent).toBe(X.notesSaved("NCE1A0955"));
    expect(await bodies("PATCH", path)).toEqual([{ notes: "Ticketing agreement TA-118." }]);
    expect(calls("PATCH", path)[0]?.headers.get("if-match")).toBe('"2"');
    expectSessionHeaders(calls("PATCH", path)[0]);

    // Someone else changed the office meanwhile: the dialog keeps the text and offers a full reload of this list.
    answer = () => apiError("PRECONDITION_FAILED", 412);
    fireEvent.click(screen.getByRole("button", { name: `${X.editNotes}${X.notesSuffix("NCE1A0955")}` }));
    const again = await screen.findByRole("dialog", { name: X.notesTitle("NCE1A0955") }, UI_WAIT);
    // A dialog opened again starts without the previous outcome.
    expect(again.querySelector("[data-notice]")).toBeNull();
    fill(again, X.notesLabel, "Live onboarding signed.");
    submit(X.saveNotes, again);
    const failed = await notice("failed", again);
    expect(failed.getAttribute("data-code")).toBe("PRECONDITION_FAILED");
    expect(within(failed).getByText(X.stale)).toBeTruthy();
    expect(hrefOf(link(X.reload, failed))).toBe("/amadeus/offices?status=assigned");
    expect((within(again).getByLabelText(X.notesLabel) as HTMLTextAreaElement).value).toBe(
      "Live onboarding signed.",
    );

    // Empty notes clear them; too long ones and made-up fields send nothing.
    answer = () => json(office({ id: ASSIGNED_ROW, officeId: "NCE1A0955", notes: null, version: 4 }), 200);
    const idle = { status: "idle" } as const;
    expect(
      await saveOfficeNotes(idle, formData({ officeRowId: ASSIGNED_ROW, version: "3", notes: "   " })),
    ).toEqual({ status: "done", officeRowId: ASSIGNED_ROW, officeId: "NCE1A0955" });
    expect((await bodies("PATCH", path)).at(-1)).toEqual({ notes: null });
    fetchMock.mockClear();
    expect(
      await saveOfficeNotes(
        idle,
        formData({ officeRowId: ASSIGNED_ROW, version: "3", notes: "n".repeat(2001) }),
      ),
    ).toMatchObject({ status: "failed", fieldError: X.notesTooLong });
    expect(
      await saveOfficeNotes(idle, formData({ officeRowId: ASSIGNED_ROW, version: "x", notes: "Notes" })),
    ).toMatchObject({ status: "failed", message: X.formExpired });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the notes dialog open, with no earlier outcome, while a step-up is asked for after an earlier save", async () => {
    const path = `${OFFICES_PATH}/${ASSIGNED_ROW}`;
    let attempts = 0;
    routes({
      [`PATCH ${path}`]: () => {
        attempts += 1;
        return attempts === 2
          ? apiError("REAUTH_REQUIRED", 401)
          : json(office({ id: ASSIGNED_ROW, officeId: "NCE1A0955", notes: "First.", version: 3 }), 200);
      },
    });
    await openOffices("status=assigned");
    const editNotes = `${X.editNotes}${X.notesSuffix("NCE1A0955")}`;
    fireEvent.click(screen.getByRole("button", { name: editNotes }));
    const first = await screen.findByRole("dialog", { name: X.notesTitle("NCE1A0955") }, UI_WAIT);
    fill(first, X.notesLabel, "First.");
    submit(X.saveNotes, first);
    await notice("done");

    fireEvent.click(screen.getByRole("button", { name: editNotes }));
    const second = await screen.findByRole("dialog", { name: X.notesTitle("NCE1A0955") }, UI_WAIT);
    fill(second, X.notesLabel, "Second.");
    submit(X.saveNotes, second);
    await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    // No answer yet: the notes dialog is still there with the text (behind the modal step-up dialog, so outside the
    // accessibility tree, where its title gives it no name), and nothing says saved.
    const notesDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) =>
      element.textContent?.startsWith(X.notesTitle("NCE1A0955")),
    );
    expect(notesDialog?.querySelector("textarea")?.value).toBe("Second.");
    expect(document.querySelector('[data-notice="done"]')).toBeNull();
  });

  it("shows a notice for filters the API would refuse, and does not ask it for a list", async () => {
    for (const search of [
      "environment=staging",
      "status=deleted",
      "status=available&status=assigned",
      `cursor=${"c".repeat(513)}`,
    ]) {
      fetchMock.mockClear();
      await openOffices(search);
      expect(screen.getByText(O.invalidFilters)).toBeTruthy();
      expect(calls("GET", OFFICES_PATH)).toHaveLength(0);
      expect(screen.queryByRole("table")).toBeNull();
      expect(hrefOf(link(O.showAll))).toBe("/amadeus/offices");
      cleanup();
    }
    // Empty parameters, as the filter bar's plain GET form sends them, are no filter.
    fetchMock.mockClear();
    await openOffices("environment=&status=&cursor=");
    expect(queryOfCall(OFFICES_PATH)).toEqual([]);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(5);
    cleanup();

    // A cursor the API refuses reads as invalid filters.
    routes({ [`GET ${OFFICES_PATH}`]: () => apiError("VALIDATION_FAILED", 400) });
    await openOffices("cursor=stale");
    expect(screen.getByText(O.invalidFilters)).toBeTruthy();
  });

  it("links the next page with the filters, and hands the table only the fields it shows", async () => {
    const sentinel = "PAD007-SENTINEL-OFFICE";
    routes({
      [`GET ${OFFICES_PATH}`]: () =>
        json(
          {
            data: pool().map((row) => ({ ...row, internalCiphertext: sentinel })),
            page: { nextCursor: "eyJpZCI6ImFtb18ifQ", limit: 4 },
          },
          200,
        ),
    });
    await openOffices("environment=test");
    const next = new URL(hrefOf(link("Next page")) ?? "", "https://admin.invalid");
    expect(sortedQuery(next.search)).toEqual([
      ["cursor", "eyJpZCI6ImFtb18ifQ"],
      ["environment", "test"],
    ]);
    cleanup();

    const page = await officesPage("environment=test");
    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain(AVAILABLE_ROW);
    expect(payload).not.toContain(sentinel);
    render(page);
    expect(document.body.innerHTML).not.toContain(sentinel);
  });

  it("shows the admin's message when the pool cannot be loaded, and sends an ended session to sign-in", async () => {
    routes({ [`GET ${OFFICES_PATH}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openOffices();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(O.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(document.body.textContent).not.toContain("The API's own text");
    cleanup();

    routes({ [`GET ${OFFICES_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(officesPage("")).rejects.toThrow("NEXT_REDIRECT /sign-in");
    routes({ [`GET ${ACCOUNTS_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(officesPage("")).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });
});
