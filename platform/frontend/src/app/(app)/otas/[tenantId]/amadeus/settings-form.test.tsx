// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import type { ReactElement } from "react";
import type * as ReactModule from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ActionsModule from "@/app/(app)/otas/[tenantId]/amadeus/actions";

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

/** The server action as the form calls it, counted: a form that is not sent must never reach it. */
const actionCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/app/(app)/otas/[tenantId]/amadeus/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof ActionsModule>();
  return {
    ...actual,
    saveAmadeusSettings: (...args: Parameters<typeof actual.saveAmadeusSettings>) => {
      actionCalls.count += 1;
      return actual.saveAmadeusSettings(...args);
    },
  };
});

import {
  saveAmadeusSettings,
  type AmadeusSettingsState,
  type AmadeusSettingsValues,
} from "@/app/(app)/otas/[tenantId]/amadeus/actions";
import AmadeusPage from "@/app/(app)/otas/[tenantId]/amadeus/page";
import { MONITORED_QUEUES_MAX, valuesOf } from "@/app/(app)/otas/[tenantId]/amadeus/settings-form";
import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import { AMADEUS_SETTINGS_STRINGS, ERROR_MESSAGES, FORM_STRINGS } from "@/lib/strings";

const STRINGS = AMADEUS_SETTINGS_STRINGS;
const PROBLEMS = STRINGS.problems;

// ---- Builders (dummy values only: no real token, key or account) -------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type AmadeusConnection = Schemas["AmadeusConnection"];
type Environment = "test" | "live";

const ACCESS_TOKEN = "pfe018-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-018 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const AMADEUS_PATH = `${TENANT_PATH}/amadeus-connections`;
const TEST_PATH = `${AMADEUS_PATH}/test`;
const LIVE_PATH = `${AMADEUS_PATH}/live`;
/** The text of an API answer; it must never reach the page. */
const API_TEXT = "The API's own text";

const NICE = "NCE1A0955";
const NICE_2 = "NCE1A0956";
const OSLO = "OSLN12345";

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
    planCode: "early_access",
    defaultCurrency: "EUR",
    countryCode: "NO",
    timeZone: "Europe/Oslo",
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

/**
 * The test connection on the Velexis account with two offices, a ticketing agreement, one automated process and one
 * monitored queue, at version 3.
 */
function testConnection(overrides: Partial<AmadeusConnection> = {}): AmadeusConnection {
  return {
    id: "sc_01JA2ZB9C3E7G1J5M9Q3S7V1X5",
    environment: "test",
    credentialSource: "velexis",
    status: "active",
    officeIds: [NICE, NICE_2],
    defaultOfficeId: NICE,
    queuingOfficeId: NICE,
    ownerOfficeId: NICE_2,
    clientId: null,
    ticketingDefaults: {
      ticketingAgreement: { option: "DELAY_TO_CANCEL", delay: "2D" },
      automatedProcess: [{ code: "IMMEDIATE", queue: { number: "8", category: "0" }, officeId: NICE }],
      issue: false,
    },
    monitoredQueues: [{ officeId: NICE, queueId: 8, category: 0 }],
    lastVerifiedAt: daysFromStart(-1),
    lastError: null,
    pendingSubmission: null,
    version: 3,
    ...overrides,
  };
}

/** The live connection of the OTA's own credentials, with one office and no settings yet, at version 7. */
function liveConnection(overrides: Partial<AmadeusConnection> = {}): AmadeusConnection {
  return testConnection({
    id: "sc_01JA2ZF7H1K5N9Q3T7W1Y5A9C3",
    environment: "live",
    credentialSource: "tenant",
    officeIds: [OSLO],
    defaultOfficeId: OSLO,
    queuingOfficeId: OSLO,
    ownerOfficeId: OSLO,
    clientId: "pfe018-dummy-client-id",
    ticketingDefaults: {},
    monitoredQueues: [],
    version: 7,
    ...overrides,
  });
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An error envelope of the platform API; its `message` and the field errors' messages must never reach the page. */
function apiError(
  code: string,
  status: number,
  fieldErrors?: readonly { path: string; code: string }[],
): Response {
  return json(
    {
      error: {
        code,
        message: `${API_TEXT}, never shown`,
        status,
        requestId: "req_api_pfe018",
        ...(fieldErrors === undefined
          ? {}
          : {
              fieldErrors: fieldErrors.map((fieldError) => ({
                ...fieldError,
                message: `${API_TEXT} of a field`,
              })),
            }),
      },
    },
    status,
  );
}

/** The body of a call, read from a copy so the request stays readable. */
async function bodyOf(request: Request | undefined): Promise<unknown> {
  if (request === undefined) {
    throw new Error("No such call.");
  }
  return request.clone().json();
}

/**
 * The API's answer to `updateAmadeusConnection` for `connection`: every field sent replaces the stored one, and the
 * version is the one after the one in `If-Match` (the API checks that it is the connection's).
 */
async function updated(request: Request, connection: AmadeusConnection): Promise<Response> {
  const body = (await bodyOf(request)) as Partial<AmadeusConnection>;
  const version = Number((request.headers.get("if-match") ?? "").replaceAll('"', ""));
  return json({ ...connection, ...body, version: version + 1 }, 200);
}

type Route = (request: Request) => Response | Promise<Response>;

/**
 * Answers each call by `METHOD /path`: by default an active owner's OTA with its test connection, which saves any
 * settings. A new answer table is a new request, with nothing cached from the one before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${AMADEUS_PATH}`]: () => json({ data: [testConnection()] }, 200),
    [`PATCH ${TEST_PATH}`]: (request) => updated(request, testConnection()),
    [`PATCH ${LIVE_PATH}`]: (request) => updated(request, liveConnection()),
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

/** Every call carries the session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The route params of `/otas/[tenantId]/amadeus`, as Next.js 15 passes them. */
function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/** The Amadeus page as the OTA layout and the page render it for one request. */
async function openAmadeus(): Promise<void> {
  render(await OtaLayout({ children: await AmadeusPage({ params: params() }), params: params() }));
}

/** The Amadeus page's element, as Next.js renders it below the layout. */
async function pageElement(): Promise<ReactElement> {
  const element = await AmadeusPage({ params: params() });
  if (element === null) {
    throw new Error("The Amadeus page rendered nothing.");
  }
  return element;
}

/** The settings section of one environment's connection. */
function section(environment: Environment = "test"): HTMLElement {
  return screen.getByRole("region", { name: STRINGS.title(environment) });
}

/** The settings form of one environment's connection. */
function form(environment: Environment = "test"): HTMLFormElement {
  return within(section(environment)).getByRole("form", { name: STRINGS.title(environment) });
}

/** A field of the form by its label (the fields outside the rows have labels of their own). */
function field<Element extends HTMLElement = HTMLSelectElement>(
  label: string,
  environment: Environment = "test",
): Element {
  return within(form(environment)).getByLabelText(label);
}

/** The rows of the automated processes or the monitored queues. */
function automatedRows(environment: Environment = "test"): HTMLElement[] {
  return [...form(environment).querySelectorAll<HTMLElement>("[data-automated-row]")];
}

function queueRows(environment: Environment = "test"): HTMLElement[] {
  return [...form(environment).querySelectorAll<HTMLElement>("[data-queue-row]")];
}

/** A field of a row by its label. */
function rowField<Element extends HTMLElement = HTMLInputElement>(
  row: HTMLElement | undefined,
  label: string,
): Element {
  if (row === undefined) {
    throw new Error("No such row.");
  }
  return within(row).getByLabelText(label);
}

/** The values of a select's options, in order. */
function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value);
}

function change(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

function click(element: HTMLElement): void {
  fireEvent.click(element);
}

function submit(environment: Environment = "test"): void {
  const target = form(environment);
  fireEvent.submit(target, {
    submitter: within(target).getByText(STRINGS.submit, { selector: "button" }),
  });
}

/** The hidden `If-Match` version of a form. */
function formVersion(environment: Environment = "test"): string {
  return form(environment).querySelector<HTMLInputElement>('input[name="version"]')?.value ?? "";
}

/** The "saved" notice of a form, or `null`. */
function savedNotice(environment: Environment = "test"): HTMLElement | null {
  return form(environment).querySelector<HTMLElement>("[data-saved]");
}

/** The error summary of a form, or `null`. */
function summary(environment: Environment = "test"): HTMLElement | null {
  return within(form(environment)).queryByRole("alert", { name: FORM_STRINGS.errorSummaryTitle });
}

/** The entries of the error summary of a form. */
function summaryItems(environment: Environment = "test"): string[] {
  const element = summary(environment);
  return element === null ? [] : [...element.querySelectorAll("li")].map((item) => item.textContent ?? "");
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: Element): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

/** The form values of the rows and fields as the form shows them. */
function shownValues(environment: Environment = "test"): AmadeusSettingsValues {
  return {
    defaultOfficeId: field(STRINGS.defaultOfficeLabel, environment).value,
    queuingOfficeId: field(STRINGS.queuingOfficeLabel, environment).value,
    ownerOfficeId: field(STRINGS.ownerOfficeLabel, environment).value,
    agreementOption: field(STRINGS.agreementLabel, environment).value,
    agreementDelay: field<HTMLInputElement>(STRINGS.delayLabel, environment).value,
    issue: field(STRINGS.issueLabel, environment).value,
    automatedProcess: automatedRows(environment).map((row) => ({
      code: rowField<HTMLSelectElement>(row, STRINGS.automatedCodeLabel).value,
      queueNumber: rowField(row, STRINGS.queueNumberLabel).value,
      queueCategory: rowField(row, STRINGS.queueCategoryLabel).value,
      officeId: rowField<HTMLSelectElement>(row, STRINGS.officeLabel).value,
      delay: rowField(row, STRINGS.automatedDelayLabel).value,
      text: rowField(row, STRINGS.textLabel).value,
    })),
    monitoredQueues: queueRows(environment).map((row) => ({
      officeId: rowField<HTMLSelectElement>(row, STRINGS.officeLabel).value,
      queueId: rowField(row, STRINGS.queueIdLabel).value,
      category: rowField(row, STRINGS.categoryLabel).value,
    })),
  };
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

// ---- The action's form data ------------------------------------------------------------------------------------------

/** The automated process of `testConnection()` as the form sends it. */
const AUTOMATED_ROW = {
  code: "IMMEDIATE",
  queueNumber: "8",
  queueCategory: "0",
  officeId: NICE,
  delay: "",
  text: "",
} as const;

/** The settings of `testConnection()` as the form sends them. */
const TEST_VALUES: AmadeusSettingsValues = {
  defaultOfficeId: NICE,
  queuingOfficeId: NICE,
  ownerOfficeId: NICE_2,
  agreementOption: "DELAY_TO_CANCEL",
  agreementDelay: "2",
  issue: "false",
  automatedProcess: [AUTOMATED_ROW],
  monitoredQueues: [{ officeId: NICE, queueId: "8", category: "0" }],
};

const HIDDEN = { tenantId: TENANT_ID, environment: "test", version: "3" } as const;

/** The form data of a submission of `values` with the hidden fields, as the form posts them (rows repeat names). */
function formData(
  values: AmadeusSettingsValues = TEST_VALUES,
  hidden: Readonly<Record<string, string>> = HIDDEN,
): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(hidden)) {
    data.set(name, value);
  }
  for (const name of [
    "defaultOfficeId",
    "queuingOfficeId",
    "ownerOfficeId",
    "agreementOption",
    "agreementDelay",
    "issue",
  ] as const) {
    data.set(name, values[name]);
  }
  for (const row of values.automatedProcess) {
    data.append("automatedCode", row.code);
    data.append("automatedQueueNumber", row.queueNumber);
    data.append("automatedQueueCategory", row.queueCategory);
    data.append("automatedOfficeId", row.officeId);
    data.append("automatedDelay", row.delay);
    data.append("automatedText", row.text);
  }
  for (const row of values.monitoredQueues) {
    data.append("queueOfficeId", row.officeId);
    data.append("queueId", row.queueId);
    data.append("queueCategory", row.category);
  }
  return data;
}

const IDLE: AmadeusSettingsState = {
  status: "idle",
  version: 3,
  connection: testConnection(),
  fieldErrors: {},
};

/**
 * The wait for what a server action renders: the action runs the real `lib/api.ts` over the mocked fetch, which on a
 * busy CI runner can outlast Testing Library's 1 s default. It stays well inside the test's own budget.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  actionCalls.count = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = `/otas/${TENANT_ID}/amadeus`;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe018_portal",
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
 * client, Testing Library and React's DOM on their first run) and the first save through the action are the slowest,
 * and on a busy CI runner they otherwise land in the first test's own five seconds. The hook only stops if it hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: the page opened, a setting changed and saved through the action, and the page
 * rendered on the server and hydrated, so the test bodies hold only the steps they check. Nothing of it stays: each
 * test gets a fresh API (`resetPlatformApi`), fresh mocks and globals (`restoreMocks`, `unstubGlobals`) and an empty
 * document.
 */
beforeAll(async () => {
  resetPlatformApi();
  await openAmadeus();
  change(field(STRINGS.defaultOfficeLabel), NICE_2);
  submit();
  await waitFor(() => expect(formVersion()).toBe("4"), { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  routes({ [`GET ${AMADEUS_PATH}`]: () => json({ data: [testConnection(), liveConnection()] }, 200) });
  const { root } = await serverRenderAndHydrate(await pageElement());
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The office selects --------------------------------------------------------------------------------------------

describe("the office selects", () => {
  it("[PFE-018 AC1] offer only the connection's offices, in every select of each connection [PF-53 AC1]", async () => {
    routes({ [`GET ${AMADEUS_PATH}`]: () => json({ data: [liveConnection(), testConnection()] }, 200) });
    await openAmadeus();

    // The three office defaults: the connection's offices and nothing else, its stored office chosen.
    for (const [label, chosen] of [
      [STRINGS.defaultOfficeLabel, NICE],
      [STRINGS.queuingOfficeLabel, NICE],
      [STRINGS.ownerOfficeLabel, NICE_2],
    ] as const) {
      const select = field(label);
      expect([label, optionValues(select)]).toEqual([label, [NICE, NICE_2]]);
      expect(select.value).toBe(chosen);
      expect(optionValues(field(label, "live"))).toEqual([OSLO]);
    }
    // An automated process may name no office; a monitored queue must name one of the connection's.
    expect(optionValues(rowField(automatedRows()[0], STRINGS.officeLabel))).toEqual(["", NICE, NICE_2]);
    expect(optionValues(rowField(queueRows()[0], STRINGS.officeLabel))).toEqual([NICE, NICE_2]);

    // New rows offer the same offices; a new queue starts on the default office.
    click(within(form("live")).getByRole("button", { name: STRINGS.addAutomated }));
    click(within(form("live")).getByRole("button", { name: STRINGS.addQueue }));
    expect(optionValues(rowField(automatedRows("live")[0], STRINGS.officeLabel))).toEqual(["", OSLO]);
    const queueOffice = rowField<HTMLSelectElement>(queueRows("live")[0], STRINGS.officeLabel);
    expect(optionValues(queueOffice)).toEqual([OSLO]);
    expect(queueOffice.value).toBe(OSLO);
    expect(writes()).toEqual([]);
  });

  it("[PFE-018 AC1] puts a placeholder before the offices while none of them is chosen, and drops it once one is [PF-53 AC1]", async () => {
    // An office that is not set, or no longer one of the connection's, is never offered.
    routes({
      [`GET ${AMADEUS_PATH}`]: () =>
        json(
          {
            data: [
              testConnection({
                queuingOfficeId: null,
                ownerOfficeId: "PARIS0001",
                monitoredQueues: [{ officeId: "PARIS0001", queueId: 3, category: 1 }],
              }),
            ],
          },
          200,
        ),
    });
    await openAmadeus();

    const queuing = field(STRINGS.queuingOfficeLabel);
    expect(optionValues(queuing)).toEqual(["", NICE, NICE_2]);
    expect(queuing.value).toBe("");
    expect(queuing.options[0]?.textContent).toBe(STRINGS.officePlaceholder);
    expect(optionValues(field(STRINGS.ownerOfficeLabel))).toEqual(["", NICE, NICE_2]);
    const queueOffice = rowField<HTMLSelectElement>(queueRows()[0], STRINGS.officeLabel);
    expect(optionValues(queueOffice)).toEqual(["", NICE, NICE_2]);

    change(queuing, NICE_2);
    expect(optionValues(field(STRINGS.queuingOfficeLabel))).toEqual([NICE, NICE_2]);
    // A queue still without an office is refused at its field, without a call.
    submit();
    await waitFor(() => expect(summaryItems()).toEqual([PROBLEMS.office]), ACTION_WAIT);
    const queueOfficeAgain = rowField<HTMLSelectElement>(queueRows()[0], STRINGS.officeLabel);
    expect(queueOfficeAgain.getAttribute("aria-invalid")).toBe("true");
    expect(writes()).toEqual([]);

    // An office not chosen is left out of the body, so the API keeps what it has.
    change(queueOfficeAgain, NICE);
    submit();
    await waitFor(() => expect(calls("PATCH", TEST_PATH)).toHaveLength(1), ACTION_WAIT);
    const body = (await bodyOf(calls("PATCH", TEST_PATH)[0])) as Record<string, unknown>;
    expect(body["queuingOfficeId"]).toBe(NICE_2);
    expect(Object.hasOwn(body, "ownerOfficeId")).toBe(false);
    expect(body["monitoredQueues"]).toEqual([{ officeId: NICE, queueId: 3, category: 1 }]);
  });
});

// ---- Saving --------------------------------------------------------------------------------------------------------

describe("saving the settings", () => {
  it("[PFE-018 AC1] an owner saves offices, ticketing defaults and queues with If-Match, and the form shows the saved values [PF-53 AC1]", async () => {
    await openAmadeus();
    expect(shownValues()).toEqual(TEST_VALUES);

    change(field(STRINGS.defaultOfficeLabel), NICE_2);
    change(field(STRINGS.ownerOfficeLabel), NICE);
    change(field(STRINGS.agreementLabel), "DELAY_TO_QUEUE");
    change(field(STRINGS.delayLabel), "03");
    change(field(STRINGS.issueLabel), "true");
    change(rowField(automatedRows()[0], STRINGS.queueNumberLabel), "12");
    click(within(form()).getByRole("button", { name: STRINGS.addAutomated }));
    const added = automatedRows()[1];
    change(rowField(added, STRINGS.automatedCodeLabel), "ERROR");
    change(rowField(added, STRINGS.officeLabel), NICE_2);
    change(rowField(added, STRINGS.textLabel), "  Check the fare  ");
    click(within(form()).getByRole("button", { name: STRINGS.addQueue }));
    const queue = queueRows()[1];
    change(rowField(queue, STRINGS.officeLabel), NICE_2);
    change(rowField(queue, STRINGS.queueIdLabel), "45");
    change(rowField(queue, STRINGS.categoryLabel), "1");
    click(within(form()).getByRole("button", { name: STRINGS.removeQueue(1) }));
    submit();
    await waitFor(() => expect(savedNotice()?.textContent).toBe(STRINGS.saved), ACTION_WAIT);

    const [call, ...more] = calls("PATCH", TEST_PATH);
    expect(more).toHaveLength(0);
    expectSessionHeaders(call);
    expect(call?.headers.get("if-match")).toBe('"3"');
    expect(await bodyOf(call)).toEqual({
      defaultOfficeId: NICE_2,
      queuingOfficeId: NICE,
      ownerOfficeId: NICE,
      ticketingDefaults: {
        ticketingAgreement: { option: "DELAY_TO_QUEUE", delay: "3D" },
        automatedProcess: [
          { code: "IMMEDIATE", queue: { number: "12", category: "0" }, officeId: NICE },
          { code: "ERROR", officeId: NICE_2, text: "Check the fare" },
        ],
        issue: true,
      },
      monitoredQueues: [{ officeId: NICE_2, queueId: 45, category: 1 }],
    });
    // The settings as the API saved them, the new version for the next save, and the page rendered again.
    expect(shownValues()).toEqual({
      defaultOfficeId: NICE_2,
      queuingOfficeId: NICE,
      ownerOfficeId: NICE,
      agreementOption: "DELAY_TO_QUEUE",
      agreementDelay: "3",
      issue: "true",
      automatedProcess: [
        { code: "IMMEDIATE", queueNumber: "12", queueCategory: "0", officeId: NICE, delay: "", text: "" },
        {
          code: "ERROR",
          queueNumber: "",
          queueCategory: "",
          officeId: NICE_2,
          delay: "",
          text: "Check the fare",
        },
      ],
      monitoredQueues: [{ officeId: NICE_2, queueId: "45", category: "1" }],
    });
    expect(formVersion()).toBe("4");
    expect(savedNotice()?.getAttribute("role")).toBe("status");
    expect(summary()).toBeNull();
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/otas/${TENANT_ID}/amadeus`);
    expect(writes()).toEqual([`PATCH ${TEST_PATH}`]);
    expect(actionCalls.count).toBe(1);

    // The next save carries the new version.
    change(field(STRINGS.defaultOfficeLabel), NICE);
    submit();
    await waitFor(() => expect(formVersion()).toBe("5"), ACTION_WAIT);
    expect(calls("PATCH", TEST_PATH)[1]?.headers.get("if-match")).toBe('"4"');
  });

  it("[PFE-018 AC1] shows the settings the API answers after a save, not only what was sent [PF-53 AC1]", async () => {
    // Someone's change of the same save's moment is in the answer: the form shows what the connection now holds.
    const stored = testConnection({
      defaultOfficeId: NICE_2,
      ticketingDefaults: { ticketingAgreement: { option: "CONFIRM" } },
      monitoredQueues: [
        { officeId: NICE, queueId: 8, category: 0 },
        { officeId: NICE_2, queueId: 99, category: 254 },
      ],
      version: 4,
    });
    routes({ [`PATCH ${TEST_PATH}`]: () => json(stored, 200) });
    await openAmadeus();
    change(field(STRINGS.defaultOfficeLabel), NICE_2);
    submit();
    await waitFor(() => expect(formVersion()).toBe("4"), ACTION_WAIT);

    expect(shownValues()).toEqual(valuesOf(stored));
    expect(queueRows()).toHaveLength(2);
    expect(field<HTMLInputElement>(STRINGS.delayLabel).disabled).toBe(true);
    expect(savedNotice()?.textContent).toBe(STRINGS.saved);
  });

  it("[PFE-018 AC1] an admin saves the live connection with that connection's own version, and each connection has a form of its own [PF-53 AC1]", async () => {
    routesAs("admin", {
      [`GET ${AMADEUS_PATH}`]: () => json({ data: [liveConnection(), testConnection()] }, 200),
    });
    await openAmadeus();

    expect(
      [...document.querySelectorAll<HTMLElement>("[data-amadeus-settings-form]")].map(
        (element) => element.dataset["amadeusSettingsForm"],
      ),
    ).toEqual(["test", "live"]);
    expect(field(STRINGS.defaultOfficeLabel).id).not.toBe(field(STRINGS.defaultOfficeLabel, "live").id);
    expect([formVersion("test"), formVersion("live")]).toEqual(["3", "7"]);

    change(field(STRINGS.issueLabel, "live"), "false");
    submit("live");
    await waitFor(() => expect(formVersion("live")).toBe("8"), ACTION_WAIT);

    const [call] = calls("PATCH", LIVE_PATH);
    expectSessionHeaders(call);
    expect(call?.headers.get("if-match")).toBe('"7"');
    expect(await bodyOf(call)).toEqual({
      defaultOfficeId: OSLO,
      queuingOfficeId: OSLO,
      ownerOfficeId: OSLO,
      ticketingDefaults: { issue: false },
      monitoredQueues: [],
    });
    expect(writes()).toEqual([`PATCH ${LIVE_PATH}`]);
    expect(savedNotice("live")?.textContent).toBe(STRINGS.saved);
    expect(savedNotice("test")).toBeNull();
    expect(formVersion("test")).toBe("3");
  });

  it("[PFE-018 AC1] shows the reload message for a stale version, and keeps what was typed and the version [PF-53 AC1]", async () => {
    routes({ [`PATCH ${TEST_PATH}`]: () => apiError("PRECONDITION_FAILED", 412) });
    await openAmadeus();
    change(field(STRINGS.defaultOfficeLabel), NICE_2);
    click(within(form()).getByRole("button", { name: STRINGS.addQueue }));
    change(rowField(queueRows()[1], STRINGS.queueIdLabel), "12");
    submit();

    await waitFor(() => expect(summaryItems()).toEqual([STRINGS.stale]), ACTION_WAIT);
    await waitFor(() => expect(document.activeElement).toBe(summary()), ACTION_WAIT);
    const reload = within(form()).getByRole("link", { name: STRINGS.reload });
    // A full reload of the page, which shows the settings someone else saved and their version.
    expect(reload.getAttribute("href")).toBe(`/otas/${TENANT_ID}/amadeus`);
    expect(field(STRINGS.defaultOfficeLabel).value).toBe(NICE_2);
    expect(queueRows()).toHaveLength(2);
    expect(rowField(queueRows()[1], STRINGS.queueIdLabel).value).toBe("12");
    expect(formVersion()).toBe("3");
    expect(savedNotice()).toBeNull();
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(API_TEXT);
  });

  it("sends a cleared agreement and issue as unset, and a delay only with a delayed agreement", async () => {
    await openAmadeus();
    // The stored delay shows in days; a confirmed agreement takes none, so its field is disabled and not sent.
    expect(field<HTMLInputElement>(STRINGS.delayLabel).value).toBe("2");
    change(field(STRINGS.agreementLabel), "CONFIRM");
    expect(field<HTMLInputElement>(STRINGS.delayLabel).disabled).toBe(true);
    submit();
    await waitFor(() => expect(calls("PATCH", TEST_PATH)).toHaveLength(1), ACTION_WAIT);
    expect(
      ((await bodyOf(calls("PATCH", TEST_PATH)[0])) as Record<string, unknown>)["ticketingDefaults"],
    ).toEqual({
      ticketingAgreement: { option: "CONFIRM" },
      automatedProcess: [{ code: "IMMEDIATE", queue: { number: "8", category: "0" }, officeId: NICE }],
      issue: false,
    });
    await waitFor(() => expect(formVersion()).toBe("4"), ACTION_WAIT);

    // Nothing set, and every row removed: an empty object and an empty list stop the defaults and the polling.
    change(field(STRINGS.agreementLabel), "");
    change(field(STRINGS.issueLabel), "");
    click(within(form()).getByRole("button", { name: STRINGS.removeAutomated(1) }));
    // Each list's "Add" button takes the focus of the removed row's button.
    expect(document.activeElement).toBe(within(form()).getByRole("button", { name: STRINGS.addAutomated }));
    click(within(form()).getByRole("button", { name: STRINGS.removeQueue(1) }));
    expect(document.activeElement).toBe(within(form()).getByRole("button", { name: STRINGS.addQueue }));
    expect(within(form()).getByText(STRINGS.automatedNone)).toBeTruthy();
    expect(within(form()).getByText(STRINGS.queuesNone)).toBeTruthy();
    submit();
    await waitFor(() => expect(calls("PATCH", TEST_PATH)).toHaveLength(2), ACTION_WAIT);
    expect(await bodyOf(calls("PATCH", TEST_PATH)[1])).toEqual({
      defaultOfficeId: NICE,
      queuingOfficeId: NICE,
      ownerOfficeId: NICE_2,
      ticketingDefaults: {},
      monitoredQueues: [],
    });
  });
});

// ---- Finance members -------------------------------------------------------------------------------------------------

describe("finance members", () => {
  it("see the same values read-only, without a form, a field or a write", async () => {
    const stored = testConnection();
    routesAs("finance", {
      [`GET ${AMADEUS_PATH}`]: () =>
        json(
          {
            data: [
              testConnection({
                ticketingDefaults: {
                  ...stored.ticketingDefaults,
                  automatedProcess: [
                    ...(stored.ticketingDefaults.automatedProcess ?? []),
                    { code: "DELAYED", delay: "1D", text: "Check the fare" },
                  ],
                },
              }),
              liveConnection(),
            ],
          },
          200,
        ),
    });
    await openAmadeus();

    const setting = (environment: Environment, id: string) =>
      section(environment).querySelector(`[data-setting="${id}"] dd`)?.textContent;
    for (const environment of ["test", "live"] as const) {
      const element = section(environment);
      expect(within(element).queryByRole("form")).toBeNull();
      expect(within(element).queryByRole("textbox")).toBeNull();
      expect(within(element).queryByRole("combobox")).toBeNull();
      expect(within(element).queryByRole("button")).toBeNull();
      expect(within(element).getByText(STRINGS.roleNote)).toBeTruthy();
    }
    expect(setting("test", "defaultOffice")).toBe(NICE);
    expect(setting("test", "queuingOffice")).toBe(NICE);
    expect(setting("test", "ownerOffice")).toBe(NICE_2);
    expect(setting("test", "agreement")).toBe("Cancel the order after a delay, after 2 days");
    expect(setting("test", "issue")).toBe("No");
    // Each automated process in words, every field it has: its queue, office, delay and remark.
    expect(
      [...section("test").querySelectorAll('[data-setting="automatedProcess"] li')].map(
        (item) => item.textContent,
      ),
    ).toEqual([
      `At once, queue 8, category 0, office ${NICE}`,
      "After a delay, after 1 day, remark “Check the fare”",
    ]);
    const table = within(section("test")).getByRole("table", {
      name: STRINGS.monitoredCaption("test"),
    });
    expect(
      [...table.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      ),
    ).toEqual([[NICE, "8", "0"]]);

    expect(setting("live", "agreement")).toBe(STRINGS.notSet);
    expect(setting("live", "issue")).toBe(STRINGS.notSet);
    expect(setting("live", "automatedProcess")).toBe(STRINGS.automatedNone);
    expect(within(section("live")).getByText(STRINGS.queuesNone)).toBeTruthy();
    expect(writes()).toEqual([]);
  });
});

// ---- The rows ----------------------------------------------------------------------------------------------------------

describe("the rows of the lists", () => {
  it("adds and removes monitored queues, at most 20, each row with its own legend and remove button", async () => {
    await openAmadeus();
    const add = () => within(form()).getByRole("button", { name: STRINGS.addQueue });
    for (let count = 1; count < MONITORED_QUEUES_MAX; count += 1) {
      click(add());
    }
    expect(queueRows()).toHaveLength(MONITORED_QUEUES_MAX);
    expect(add()).toHaveProperty("disabled", true);
    expect(within(form()).getByText(STRINGS.queuesFull)).toBeTruthy();
    click(add());
    expect(queueRows()).toHaveLength(MONITORED_QUEUES_MAX);

    // Removing the fifth queue renumbers the rows after it; a queue can be added again.
    change(rowField(queueRows()[5], STRINGS.queueIdLabel), "66");
    click(within(form()).getByRole("button", { name: STRINGS.removeQueue(5) }));
    expect(queueRows()).toHaveLength(MONITORED_QUEUES_MAX - 1);
    // The removed row's button is gone: the focus moves to "Add a queue", enabled again below the limit.
    expect(document.activeElement).toBe(add());
    expect(within(form()).getByRole("group", { name: STRINGS.queueRow(5) })).toBe(queueRows()[4]);
    expect(rowField(queueRows()[4], STRINGS.queueIdLabel).value).toBe("66");
    expect(
      within(form()).queryByRole("button", { name: STRINGS.removeQueue(MONITORED_QUEUES_MAX) }),
    ).toBeNull();
    expect(add()).toHaveProperty("disabled", false);
    expect(within(form()).queryByText(STRINGS.queuesFull)).toBeNull();
    expect(writes()).toEqual([]);
  });
});

// ---- The action's checks -----------------------------------------------------------------------------------------------

describe("the checks of the action", () => {
  it("refuses values the document does not take at their fields, in the portal's words, without a call", async () => {
    await openAmadeus();
    change(field(STRINGS.delayLabel), "1000");
    change(rowField(automatedRows()[0], STRINGS.queueNumberLabel), "abc");
    change(rowField(automatedRows()[0], STRINGS.textLabel), "x".repeat(201));
    change(rowField(queueRows()[0], STRINGS.queueIdLabel), "100");
    click(within(form()).getByRole("button", { name: STRINGS.addQueue }));
    change(rowField(queueRows()[1], STRINGS.queueIdLabel), "8");
    click(within(form()).getByRole("button", { name: STRINGS.addQueue }));
    change(rowField(queueRows()[2], STRINGS.queueIdLabel), "08");
    click(within(form()).getByRole("button", { name: STRINGS.addQueue }));
    change(rowField(queueRows()[3], STRINGS.queueIdLabel), "9");
    change(rowField(queueRows()[3], STRINGS.categoryLabel), "255");
    submit();

    // The summary lists them in form order and links each to its field; the API is never called.
    await waitFor(
      () =>
        expect(summaryItems()).toEqual([
          PROBLEMS.delay,
          PROBLEMS.queueNumber,
          PROBLEMS.text,
          PROBLEMS.monitoredQueueId,
          PROBLEMS.duplicate,
          PROBLEMS.monitoredCategory,
        ]),
      ACTION_WAIT,
    );
    const links = [...(summary()?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href"));
    expect(links).toEqual([
      `#${field(STRINGS.delayLabel).id}`,
      `#${rowField(automatedRows()[0], STRINGS.queueNumberLabel).id}`,
      `#${rowField(automatedRows()[0], STRINGS.textLabel).id}`,
      `#${rowField(queueRows()[0], STRINGS.queueIdLabel).id}`,
      `#${rowField(queueRows()[2], STRINGS.queueIdLabel).id}`,
      `#${rowField(queueRows()[3], STRINGS.categoryLabel).id}`,
    ]);
    // "08" is the same queue as "8": the later row is refused.
    expect(descriptionsOf(rowField(queueRows()[2], STRINGS.queueIdLabel)).at(-1)).toBe(PROBLEMS.duplicate);
    expect(rowField(queueRows()[1], STRINGS.queueIdLabel).getAttribute("aria-invalid")).toBeNull();
    expect(rowField(queueRows()[3], STRINGS.categoryLabel).getAttribute("aria-invalid")).toBe("true");
    // What was typed stays.
    expect(rowField(queueRows()[3], STRINGS.categoryLabel).value).toBe("255");
    expect(writes()).toEqual([]);
    expect(actionCalls.count).toBe(1);

    // A removed row takes its problem with it; the others keep theirs.
    click(within(form()).getByRole("button", { name: STRINGS.removeQueue(3) }));
    expect(rowField(queueRows()[2], STRINGS.categoryLabel).getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses a forged form at its fields, and a form without its hidden fields or whole rows as expired, without a call", async () => {
    const lowerOffice = await saveAmadeusSettings(
      IDLE,
      formData({ ...TEST_VALUES, defaultOfficeId: "nce1a0955" }),
    );
    expect(lowerOffice).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      version: 3,
      values: { ...TEST_VALUES, defaultOfficeId: "nce1a0955" },
      fieldErrors: { defaultOfficeId: PROBLEMS.office },
    });

    const automated = AUTOMATED_ROW;
    const cases: [AmadeusSettingsValues, string, string][] = [
      [{ ...TEST_VALUES, agreementOption: "LATER" }, "agreementOption", PROBLEMS.agreementOption],
      [{ ...TEST_VALUES, issue: "maybe" }, "issue", PROBLEMS.issue],
      [
        { ...TEST_VALUES, automatedProcess: [{ ...automated, code: "SOMETIMES" }] },
        "automatedProcess.0.code",
        PROBLEMS.automatedCode,
      ],
      [
        { ...TEST_VALUES, automatedProcess: [{ ...automated, delay: "1D" }] },
        "automatedProcess.0.delay",
        PROBLEMS.delay,
      ],
      [
        { ...TEST_VALUES, monitoredQueues: [{ officeId: "", queueId: "1", category: "0" }] },
        "monitoredQueues.0.officeId",
        PROBLEMS.office,
      ],
      [
        { ...TEST_VALUES, monitoredQueues: [{ officeId: NICE, queueId: "", category: "0" }] },
        "monitoredQueues.0.queueId",
        PROBLEMS.monitoredQueueId,
      ],
      [
        {
          ...TEST_VALUES,
          monitoredQueues: Array.from({ length: MONITORED_QUEUES_MAX + 1 }, (_, index) => ({
            officeId: NICE,
            queueId: String(index),
            category: "0",
          })),
        },
        "monitoredQueues",
        PROBLEMS.tooManyQueues,
      ],
    ];
    for (const [values, key, message] of cases) {
      const state = await saveAmadeusSettings(IDLE, formData(values));
      expect([key, state.status, state.fieldErrors[key]]).toEqual([key, "failed", message]);
    }

    // Without a valid OTA, environment or version, or with rows whose fields do not line up, the save could not name
    // its connection or its rows: an expired form.
    const broken = formData();
    broken.append("queueId", "9");
    for (const data of [
      formData(TEST_VALUES, { ...HIDDEN, tenantId: "" }),
      formData(TEST_VALUES, { ...HIDDEN, tenantId: "ten_not-an-id" }),
      formData(TEST_VALUES, { ...HIDDEN, environment: "staging" }),
      formData(TEST_VALUES, { ...HIDDEN, version: "0" }),
      formData(TEST_VALUES, { ...HIDDEN, version: "" }),
      broken,
    ]) {
      const state = await saveAmadeusSettings(IDLE, data);
      expect([state.status, state.message, state.reload]).toEqual(["failed", STRINGS.formExpired, true]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- The API's answers ---------------------------------------------------------------------------------------------

describe("the answers of updateAmadeusConnection", () => {
  it("puts the API's office errors at their fields, in the portal's words", async () => {
    routes({
      [`PATCH ${TEST_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, [
          { path: "/defaultOfficeId", code: "unknown" },
          { path: "/ticketingDefaults/automatedProcess/0/officeId", code: "unknown" },
          { path: "/monitoredQueues/0/officeId", code: "unknown" },
        ]),
    });
    await openAmadeus();
    submit();

    await waitFor(
      () => expect(summaryItems()).toEqual([PROBLEMS.office, PROBLEMS.office, PROBLEMS.office]),
      ACTION_WAIT,
    );
    for (const element of [
      field(STRINGS.defaultOfficeLabel),
      rowField(automatedRows()[0], STRINGS.officeLabel),
      rowField(queueRows()[0], STRINGS.officeLabel),
    ]) {
      expect(element.getAttribute("aria-invalid")).toBe("true");
      expect(descriptionsOf(element).at(-1)).toBe(PROBLEMS.office);
    }
    expect(within(form()).queryByRole("link", { name: STRINGS.reload })).toBeNull();
    expect(document.body.textContent).not.toContain(API_TEXT);
  });

  it("maps the API's list errors to their list, and a path the form has no field for to an expired form", async () => {
    for (const [fieldErrors, expected] of [
      [[{ path: "/monitoredQueues", code: "uniqueItems" }], { monitoredQueues: PROBLEMS.duplicate }],
      [[{ path: "/monitoredQueues", code: "maxItems" }], { monitoredQueues: PROBLEMS.tooManyQueues }],
      [
        [{ path: "/monitoredQueues/0/queueId", code: "maximum" }],
        { "monitoredQueues.0.queueId": PROBLEMS.monitoredQueueId },
      ],
      [
        [{ path: "/ticketingDefaults/ticketingAgreement/delay", code: "pattern" }],
        { agreementDelay: PROBLEMS.delay },
      ],
      [
        [{ path: "/ticketingDefaults/automatedProcess/0/queue/number", code: "pattern" }],
        { "automatedProcess.0.queueNumber": PROBLEMS.queueNumber },
      ],
      [[{ path: "/ticketingDefaults/issue", code: "type" }], { issue: PROBLEMS.issue }],
    ] as const) {
      routes({ [`PATCH ${TEST_PATH}`]: () => apiError("VALIDATION_FAILED", 400, fieldErrors) });
      const state = await saveAmadeusSettings(IDLE, formData());
      expect([fieldErrors, state]).toEqual([
        fieldErrors,
        {
          status: "failed",
          code: "VALIDATION_FAILED",
          version: 3,
          values: TEST_VALUES,
          fieldErrors: expected,
        },
      ]);
    }

    for (const path of [
      "/header/If-Match",
      "/path/environment",
      "",
      "/monitoredQueues/1/queueId",
      "/ticketingDefaults/automatedProcess/0/queue",
    ]) {
      routes({
        [`PATCH ${TEST_PATH}`]: () => apiError("VALIDATION_FAILED", 400, [{ path, code: "pattern" }]),
      });
      const state = await saveAmadeusSettings(IDLE, formData());
      expect([path, state]).toEqual([
        path,
        {
          status: "failed",
          code: "VALIDATION_FAILED",
          version: 3,
          values: TEST_VALUES,
          fieldErrors: {},
          message: STRINGS.formExpired,
          reload: true,
        },
      ]);
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("explains the other refusals, an unavailable API, and follows the session's end", async () => {
    for (const [code, status, message, reload] of [
      ["TENANT_NOT_ACTIVE", 409, STRINGS.notActive, true],
      ["FORBIDDEN", 403, STRINGS.forbidden, true],
      ["NOT_FOUND", 404, STRINGS.removed, true],
      ["RATE_LIMITED", 429, STRINGS.rateLimited, false],
      ["INTERNAL_ERROR", 500, ERROR_MESSAGES.INTERNAL_ERROR, false],
    ] as const) {
      routes({ [`PATCH ${TEST_PATH}`]: () => apiError(code, status) });
      const state = await saveAmadeusSettings(IDLE, formData());
      expect([code, state]).toEqual([
        code,
        {
          status: "failed",
          code,
          version: 3,
          values: TEST_VALUES,
          fieldErrors: {},
          message,
          ...(reload ? { reload: true } : {}),
        },
      ]);
    }

    // An API that cannot be reached reads as unavailable, in the portal's words.
    routes({
      [`PATCH ${TEST_PATH}`]: () => {
        throw new TypeError("fetch failed");
      },
    });
    const unreachable = await saveAmadeusSettings(IDLE, formData());
    expect(unreachable).toMatchObject({ status: "failed", code: "SERVICE_UNAVAILABLE" });
    expect(unreachable.message).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);

    for (const code of ["UNAUTHENTICATED", "TOKEN_EXPIRED"]) {
      routes({ [`PATCH ${TEST_PATH}`]: () => apiError(code, 401) });
      await expect(saveAmadeusSettings(IDLE, formData())).rejects.toThrow(
        `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Famadeus`,
      );
    }
    routes({ [`PATCH ${TEST_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(saveAmadeusSettings(IDLE, formData())).rejects.toThrow("NEXT_REDIRECT /verify-pending");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });
});

// ---- The page -----------------------------------------------------------------------------------------------------------

describe("the settings on the page", () => {
  it("disables the form with the reason while the OTA is not active, and sends nothing", async () => {
    for (const status of ["suspended", "provisioning", "failed"] as const) {
      routesAs("owner", {}, status);
      await openAmadeus();
      const notice = form().querySelector("[data-settings-read-only]");
      expect(notice?.textContent).toContain(STRINGS.readOnlyTitle);
      expect(notice?.textContent).toContain(STRINGS.readOnly[status]);
      // Every field, select and row button sits in the disabled fieldset that holds the whole form, which disables
      // every control inside it (nested fieldsets included).
      const fieldset = [...form().children].find((child) => child.tagName === "FIELDSET");
      expect(fieldset?.hasAttribute("disabled")).toBe(true);
      for (const control of [
        field(STRINGS.defaultOfficeLabel),
        field(STRINGS.delayLabel),
        rowField(queueRows()[0], STRINGS.queueIdLabel),
        within(form()).getByRole("button", { name: STRINGS.addQueue }),
        within(form()).getByRole("button", { name: STRINGS.removeAutomated(1) }),
      ]) {
        expect(fieldset?.contains(control)).toBe(true);
      }
      expect(within(form()).getByText(STRINGS.submit, { selector: "button" })).toHaveProperty(
        "disabled",
        true,
      );
      submit();
      expect(actionCalls.count).toBe(0);
      expect(writes()).toEqual([]);
      cleanup();
    }
  });

  it("has nothing to change for a connection without an office yet", async () => {
    routes({
      [`GET ${AMADEUS_PATH}`]: () =>
        json(
          {
            data: [
              testConnection({
                status: "pending_verification",
                officeIds: [],
                defaultOfficeId: null,
                queuingOfficeId: null,
                ownerOfficeId: null,
                ticketingDefaults: {},
                monitoredQueues: [],
                lastVerifiedAt: null,
              }),
            ],
          },
          200,
        ),
    });
    await openAmadeus();
    expect(within(section()).getByText(STRINGS.noOffices)).toBeTruthy();
    expect(within(section()).queryByRole("form")).toBeNull();
    expect(within(section()).queryByRole("combobox")).toBeNull();
  });

  it("reads the stored settings into the form's values: days without the D, offices of the connection only", () => {
    expect(valuesOf(testConnection())).toEqual(TEST_VALUES);
    expect(
      valuesOf(
        testConnection({
          defaultOfficeId: null,
          ticketingDefaults: {
            issue: true,
            automatedProcess: [{ code: "DELAYED", delay: "10D", officeId: "PARIS0001", text: "Hold" }],
          },
          monitoredQueues: [],
        }),
      ),
    ).toEqual({
      ...TEST_VALUES,
      defaultOfficeId: "",
      agreementOption: "",
      agreementDelay: "",
      issue: "true",
      automatedProcess: [
        { code: "DELAYED", queueNumber: "", queueCategory: "", officeId: "", delay: "10", text: "Hold" },
      ],
      monitoredQueues: [],
    });
  });

  it("renders the page with both forms on the server and hydrates it without an error or a change", async () => {
    routes({ [`GET ${AMADEUS_PATH}`]: () => json({ data: [testConnection(), liveConnection()] }, 200) });
    const rendered = await serverRenderAndHydrate(await pageElement());
    try {
      expect(rendered.errors).toEqual([]);
      // The hydrated page is the server's page: same markup, nothing replaced in the browser.
      expect(rendered.container.innerHTML).toBe(rendered.serverDom);
      expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
      expect(rendered.container.querySelectorAll("[data-amadeus-settings-form]")).toHaveLength(2);
    } finally {
      act(() => rendered.root.unmount());
    }
  });
});
