// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import type { ReactElement } from "react";
import type * as ReactModule from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ActionsModule from "@/app/(app)/otas/[tenantId]/payments/actions";

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

/**
 * The server action as the form calls it, counted: a suffix the browser refuses must never reach it (the action would
 * refuse it too, without an API call, so the API's calls alone cannot tell where it was refused).
 */
const actionCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/app/(app)/otas/[tenantId]/payments/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof ActionsModule>();
  return {
    ...actual,
    saveStatementDescriptor: (...args: Parameters<typeof actual.saveStatementDescriptor>) => {
      actionCalls.count += 1;
      return actual.saveStatementDescriptor(...args);
    },
  };
});

import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import { saveStatementDescriptor, type DescriptorState } from "@/app/(app)/otas/[tenantId]/payments/actions";
import {
  DESCRIPTOR_SUFFIX_MAX_LENGTH,
  DESCRIPTOR_SUFFIX_MIN_LENGTH,
  descriptorSuffixProblem,
  STATEMENT_LINE_MAX_LENGTH,
  statementLine,
  STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS,
  SUFFIX_SHOWN_IN_FULL,
} from "@/app/(app)/otas/[tenantId]/payments/descriptor-rules";
import PaymentsPage from "@/app/(app)/otas/[tenantId]/payments/page";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  CONNECTION_STRINGS,
  DESCRIPTOR_STRINGS,
  ERROR_MESSAGES,
  FORM_STRINGS,
  NOT_ALLOWED_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) -------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type PaymentConnection = Schemas["PaymentConnection"];

const ACCESS_TOKEN = "pfe016-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-016 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const PAYMENTS_PATH = `${TENANT_PATH}/payment-connections`;
const TEST_PATH = `${PAYMENTS_PATH}/test`;
const LIVE_PATH = `${PAYMENTS_PATH}/live`;
/** The text of an API answer; it must never reach the page. */
const API_TEXT = "The API's own text";

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

/** The test row of provisioning (flows/stripe-payments-account.md §A): Velexis mode, active, a derived suffix. */
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

/** The live row of a live OTA in Velexis mode (M5), at another version than the test row. */
function liveConnection(overrides: Partial<PaymentConnection> = {}): PaymentConnection {
  return paymentConnection({
    id: "ppc_01JA2ZH9K3N7Q1T5W9Z3B7D1F5",
    environment: "live",
    statementDescriptorSuffix: "ACME LIVE",
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
        requestId: "req_api_pfe016",
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
 * The API's answer to `updatePaymentConnection` for `connection`: the suffix sent, and the version after the one in
 * `If-Match` (the API checks that it is the connection's).
 */
async function updated(request: Request, connection: PaymentConnection): Promise<Response> {
  const body = (await bodyOf(request)) as { statementDescriptorSuffix: string };
  const version = Number((request.headers.get("if-match") ?? "").replaceAll('"', ""));
  return json(
    { ...connection, statementDescriptorSuffix: body.statementDescriptorSuffix, version: version + 1 },
    200,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/**
 * Answers each call by `METHOD /path`: by default an active owner's OTA with its Velexis test connection, which saves
 * any suffix. A new answer table is a new request, with nothing cached from the one before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${PAYMENTS_PATH}`]: () => json({ data: [paymentConnection()] }, 200),
    [`PATCH ${TEST_PATH}`]: (request) => updated(request, paymentConnection()),
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

/** The route params of `/otas/[tenantId]/payments`, as Next.js 15 passes them. */
function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/** The payments page as the OTA layout and the page render it for one request. */
async function openPayments(): Promise<void> {
  render(await OtaLayout({ children: await PaymentsPage({ params: params() }), params: params() }));
}

/** The payments page's element, as Next.js renders it below the layout. */
async function pageElement(): Promise<ReactElement> {
  const element = await PaymentsPage({ params: params() });
  if (element === null) {
    throw new Error("The payments page rendered nothing.");
  }
  return element;
}

/** The card of one environment's connection. */
function card(environment: "test" | "live"): HTMLElement {
  return screen.getByRole("region", { name: CONNECTION_STRINGS.title(environment) });
}

/** The suffix form inside a card. */
function form(environment: "test" | "live"): HTMLFormElement {
  return within(card(environment)).getByRole("form", { name: DESCRIPTOR_STRINGS.title });
}

/** The suffix field of a card's form. */
function field(environment: "test" | "live" = "test"): HTMLInputElement {
  return within(form(environment)).getByLabelText(DESCRIPTOR_STRINGS.label);
}

function type(value: string, environment: "test" | "live" = "test"): void {
  fireEvent.change(field(environment), { target: { value } });
}

function submit(environment: "test" | "live" = "test"): void {
  const target = form(environment);
  fireEvent.submit(target, {
    submitter: within(target).getByText(DESCRIPTOR_STRINGS.submit, { selector: "button" }),
  });
}

/** The hidden `If-Match` version of a card's form. */
function formVersion(environment: "test" | "live" = "test"): string {
  return form(environment).querySelector<HTMLInputElement>('input[name="version"]')?.value ?? "";
}

/** The statement line the preview of a card's form shows, or its text when it shows none. */
function previewLine(environment: "test" | "live" = "test"): string {
  const preview = form(environment).querySelector("[data-preview] output");
  return preview?.textContent ?? "<no preview>";
}

/** The "saved" notice of a card's form (a status message), or `null`. The preview's `<output>` is a status too. */
function savedNotice(environment: "test" | "live" = "test"): HTMLElement | null {
  return form(environment).querySelector<HTMLElement>("[data-saved]");
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: Element): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

/** The error summary of a card's form, or `null`. */
function summary(environment: "test" | "live" = "test"): HTMLElement | null {
  return within(form(environment)).queryByRole("alert", { name: FORM_STRINGS.errorSummaryTitle });
}

/** The entries of the error summary of a card's form. */
function summaryItems(environment: "test" | "live" = "test"): string[] {
  const element = summary(environment);
  return element === null ? [] : [...element.querySelectorAll("li")].map((item) => item.textContent ?? "");
}

/** The form data a submission of the form would send, with `overrides` applied (a forged or old form). */
function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
}

const VALID_FORM = {
  tenantId: TENANT_ID,
  environment: "test",
  version: "1",
  statementDescriptorSuffix: "ACME FLY",
} as const;

const IDLE: DescriptorState = { status: "idle", version: 1, suffix: "ACME TRAVEL" };

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

/** `StatementDescriptorSuffix` of the platform document: its JSON Schema rules and the description's forbidden list. */
interface DocumentSuffixSchema {
  readonly minLength: number;
  readonly maxLength: number;
  readonly pattern: RegExp;
  readonly description: string;
}

function documentSuffixSchema(): DocumentSuffixSchema {
  const lines = readFileSync(
    join(repositoryRoot(), "platform/backend/openapi/velexis-platform-api.openapi.yaml"),
    "utf8",
  ).split("\n");
  const start = lines.indexOf("    StatementDescriptorSuffix:");
  expect(start).toBeGreaterThan(-1);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {4}\S/.test(line)) {
      break;
    }
    block.push(line);
  }
  const value = (key: string): string => {
    const found = block.map((line) => new RegExp(`^ {6}${key}: (.+)$`).exec(line)?.[1]).find(Boolean);
    if (found === undefined) {
      throw new Error(`StatementDescriptorSuffix has no ${key}.`);
    }
    return found.replace(/^'(.*)'$/, "$1");
  };
  const descriptionStart = block.findIndex((line) => line.startsWith("      description:"));
  const description = block
    .slice(descriptionStart + 1)
    .filter((line) => line.startsWith("        "))
    .join(" ");
  return {
    minLength: Number(value("minLength")),
    maxLength: Number(value("maxLength")),
    // JSON Schema patterns are ECMA-262 regular expressions; the API's validator compiles them with the `u` flag.
    pattern: new RegExp(value("pattern"), "u"),
    description,
  };
}

/** The document accepts `suffix` as it is sent. */
function documentAccepts(schema: DocumentSuffixSchema, suffix: string): boolean {
  const length = [...suffix].length;
  return length >= schema.minLength && length <= schema.maxLength && schema.pattern.test(suffix);
}

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  actionCalls.count = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = `/otas/${TENANT_ID}/payments`;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe016_portal",
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
 * Once per file, before any test: the page opened, a suffix typed and saved through the action, and the page rendered
 * on the server and hydrated, so the test bodies hold only the steps they check. Nothing of it stays: each test gets a
 * fresh API (`resetPlatformApi`), fresh mocks and globals (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  await openPayments();
  type("ACME FLY");
  submit();
  await waitFor(() => expect(formVersion()).toBe("2"), { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  routes();
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

// ---- Saving --------------------------------------------------------------------------------------------------------

describe("saving the card statement suffix", () => {
  it("[PFE-016 AC1] an owner saves a valid suffix with the connection's version in If-Match [PF-60]", async () => {
    await openPayments();
    expect(field().value).toBe("ACME TRAVEL");
    expect(previewLine()).toBe("VELEXIS* ACME TRAVEL");

    // The ends are trimmed: a stray space is neither refused nor sent.
    type("  Acme Fly 24 ");
    expect(previewLine()).toBe("VELEXIS* ACME FLY 24");
    submit();
    await waitFor(() => expect(savedNotice()?.textContent).toBe(DESCRIPTOR_STRINGS.saved), ACTION_WAIT);

    const [call, ...more] = calls("PATCH", TEST_PATH);
    expect(more).toHaveLength(0);
    expectSessionHeaders(call);
    expect(call?.headers.get("if-match")).toBe('"1"');
    expect(await bodyOf(call)).toEqual({ statementDescriptorSuffix: "Acme Fly 24" });
    // The saved suffix, the new version for the next save, and the page rendered again for the card's details.
    expect(field().value).toBe("Acme Fly 24");
    expect(formVersion()).toBe("2");
    expect(summary()).toBeNull();
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/otas/${TENANT_ID}/payments`);
    expect(writes()).toEqual([`PATCH ${TEST_PATH}`]);
    expect(actionCalls.count).toBe(1);

    // The next save carries the new version.
    type("Acme Fly");
    expect(savedNotice()).toBeNull();
    submit();
    await waitFor(() => expect(calls("PATCH", TEST_PATH)).toHaveLength(2), ACTION_WAIT);
    await waitFor(() => expect(formVersion()).toBe("3"), ACTION_WAIT);
    expect(calls("PATCH", TEST_PATH)[1]?.headers.get("if-match")).toBe('"2"');
    expect(await bodyOf(calls("PATCH", TEST_PATH)[1])).toEqual({ statementDescriptorSuffix: "Acme Fly" });
  });

  it("[PFE-016 AC1] an admin saves a valid suffix too, and each Velexis-mode card has a form of its own [PF-60]", async () => {
    routesAs("admin", {
      [`GET ${PAYMENTS_PATH}`]: () => json({ data: [liveConnection(), paymentConnection()] }, 200),
    });
    await openPayments();

    // Test first, then live; one form each, with its own field, version and preview.
    expect(
      [...document.querySelectorAll<HTMLElement>("[data-descriptor-form]")].map(
        (el) => el.dataset["descriptorForm"],
      ),
    ).toEqual(["test", "live"]);
    expect(field("test").id).not.toBe(field("live").id);
    expect([formVersion("test"), formVersion("live")]).toEqual(["1", "7"]);
    expect(previewLine("live")).toBe("VELEXIS* ACME LIVE");

    type("Acme Flights", "live");
    expect(previewLine("live")).toBe("VELEXIS* ACME FLIGHTS");
    expect(previewLine("test")).toBe("VELEXIS* ACME TRAVEL");
    submit("live");
    await waitFor(() => expect(formVersion("live")).toBe("8"), ACTION_WAIT);

    const [call] = calls("PATCH", LIVE_PATH);
    expectSessionHeaders(call);
    expect(call?.headers.get("if-match")).toBe('"7"');
    expect(await bodyOf(call)).toEqual({ statementDescriptorSuffix: "Acme Flights" });
    expect(writes()).toEqual([`PATCH ${LIVE_PATH}`]);
    expect(savedNotice("live")?.getAttribute("role")).toBe("status");
    expect(savedNotice("live")?.textContent).toBe(DESCRIPTOR_STRINGS.saved);
    expect(savedNotice("test")).toBeNull();
    expect(formVersion("test")).toBe("1");
  });

  it("[PFE-016 AC1] finance members see the suffix read-only, without a form or a write [PF-60]", async () => {
    routesAs("finance", {
      [`GET ${PAYMENTS_PATH}`]: () => json({ data: [paymentConnection(), liveConnection()] }, 200),
    });
    await openPayments();

    for (const environment of ["test", "live"] as const) {
      const section = card(environment);
      expect(section.querySelector('[data-detail="statementDescriptorSuffix"] dd')?.textContent).toBe(
        environment === "test" ? "ACME TRAVEL" : "ACME LIVE",
      );
      expect(within(section).queryByRole("form")).toBeNull();
      expect(within(section).queryByRole("textbox")).toBeNull();
      expect(within(section).queryByRole("button")).toBeNull();
      expect(within(section).getByText(DESCRIPTOR_STRINGS.roleNote)).toBeTruthy();
    }
    expect(writes()).toEqual([]);
  });

  it("offers the form only on Velexis-mode cards, and only to owners and admins", async () => {
    const connect = liveConnection({
      accountMode: "connect_standard",
      accountReference: "acct_pfe016dummy",
      statementDescriptorSuffix: null,
      capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
      connectedAt: daysFromStart(-2),
    });
    routes({ [`GET ${PAYMENTS_PATH}`]: () => json({ data: [paymentConnection(), connect] }, 200) });
    await openPayments();
    expect(within(card("test")).getByRole("form", { name: DESCRIPTOR_STRINGS.title })).toBeTruthy();
    // The OTA backend sends no suffix for the OTA's own account: nothing to change or explain there.
    expect(within(card("live")).queryByRole("form")).toBeNull();
    expect(within(card("live")).queryByText(DESCRIPTOR_STRINGS.roleNote)).toBeNull();
    cleanup();

    // Agents and viewers keep the not-allowed page of PFE-013, without a connection call.
    for (const role of ["agent", "viewer"] as const) {
      fetchMock.mockClear();
      routesAs(role);
      await openPayments();
      expect(screen.getByText(NOT_ALLOWED_STRINGS.title)).toBeTruthy();
      expect(document.querySelector("[data-descriptor-form]")).toBeNull();
      expect(calls("GET", PAYMENTS_PATH)).toHaveLength(0);
      cleanup();
    }
  });

  it("starts with an empty field for a connection without a suffix, and saves the first one", async () => {
    routes({
      [`GET ${PAYMENTS_PATH}`]: () =>
        json({ data: [paymentConnection({ statementDescriptorSuffix: null })] }, 200),
    });
    await openPayments();
    expect(field().value).toBe("");
    expect(previewLine()).toBe(DESCRIPTOR_STRINGS.previewEmpty);

    type("TRAVEL 24");
    submit();
    await waitFor(() => expect(formVersion()).toBe("2"), ACTION_WAIT);
    expect(await bodyOf(calls("PATCH", TEST_PATH)[0])).toEqual({ statementDescriptorSuffix: "TRAVEL 24" });
  });

  it("disables the form with the reason while the OTA is not active, and sends nothing", async () => {
    for (const status of ["suspended", "provisioning", "failed"] as const) {
      routesAs("owner", {}, status);
      await openPayments();
      const notice = form("test").querySelector("[data-descriptor-read-only]");
      expect(notice?.textContent).toContain(DESCRIPTOR_STRINGS.readOnlyTitle);
      expect(notice?.textContent).toContain(DESCRIPTOR_STRINGS.readOnly[status]);
      expect(field().disabled || field().closest("fieldset")?.disabled).toBe(true);
      expect(
        within(form("test")).getByText(DESCRIPTOR_STRINGS.submit, { selector: "button" }),
      ).toHaveProperty("disabled", true);
      submit();
      expect(actionCalls.count).toBe(0);
      expect(writes()).toEqual([]);
      cleanup();
    }
  });
});

// ---- Refused before submit -------------------------------------------------------------------------------------------

describe("the rules in the browser", () => {
  it("[PFE-016 AC1] refuses invalid characters as they are typed and before submit, without a call [PF-60]", async () => {
    await openPayments();

    // "ACME*TRAVEL": Stripe forbids `*`; the problem shows at the field as it is typed, and the preview shows no line.
    type("ACME*TRAVEL");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(descriptionsOf(field())).toEqual([
      DESCRIPTOR_STRINGS.hint,
      DESCRIPTOR_STRINGS.problems.forbiddenCharacter,
    ]);
    expect(previewLine()).toBe(DESCRIPTOR_STRINGS.previewInvalid);
    expect(form("test").querySelector("[data-statement-line]")).toBeNull();

    // A submit is refused in the browser: the focused summary names the problem and links to the field; no call.
    submit();
    await waitFor(() => expect(summaryItems()).toEqual([DESCRIPTOR_STRINGS.problems.forbiddenCharacter]));
    expect(document.activeElement).toBe(summary());
    expect(summary()?.querySelector("a")?.getAttribute("href")).toBe(`#${field().id}`);
    expect(actionCalls.count).toBe(0);
    expect(writes()).toEqual([]);
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // Accents, punctuation and other symbols are refused the same way, each with its own words.
    for (const [suffix, problem] of [
      ["ACMÉ TRAVEL", "characters"],
      ["Acme & Co", "characters"],
      ["Acme.Travel", "characters"],
      ["<ACME>", "forbiddenCharacter"],
      ["ACME'S", "forbiddenCharacter"],
      ['ACME "24"', "forbiddenCharacter"],
      ["ACME\\24", "forbiddenCharacter"],
    ] as const) {
      type(suffix);
      expect([suffix, descriptionsOf(field()).at(-1)]).toEqual([
        suffix,
        DESCRIPTOR_STRINGS.problems[problem],
      ]);
      submit();
      await waitFor(() => expect(summaryItems()).toEqual([DESCRIPTOR_STRINGS.problems[problem]]));
    }
    expect(actionCalls.count).toBe(0);
    expect(writes()).toEqual([]);

    // Fixing the suffix clears the problem and shows the line again; then the save goes out.
    type("ACME TRAVEL 24");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(previewLine()).toBe("VELEXIS* ACME TRAVEL 2");
    submit();
    await waitFor(() => expect(calls("PATCH", TEST_PATH)).toHaveLength(1), ACTION_WAIT);
    await waitFor(() => expect(summary()).toBeNull(), ACTION_WAIT);
    expect(actionCalls.count).toBe(1);
  });

  it("[PFE-016 AC1] checks every rule of the API before a submit, and only the character rules while typing [PF-60]", async () => {
    await openPayments();

    // Typing one letter is not an error yet: more typing can fix the length.
    type("A");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(previewLine()).toBe(DESCRIPTOR_STRINGS.previewInvalid);

    for (const [suffix, problem] of [
      ["A", "minLength"],
      ["", "required"],
      ["   ", "required"],
      ["ABCDEFGHIJKLMNOPQRSTUVW", "maxLength"],
      ["1234", "letter"],
      ["24 7", "letter"],
    ] as const) {
      type(suffix);
      submit();
      await waitFor(() =>
        expect([suffix, summaryItems()]).toEqual([suffix, [DESCRIPTOR_STRINGS.problems[problem]]]),
      );
      expect(descriptionsOf(field()).at(-1)).toBe(DESCRIPTOR_STRINGS.problems[problem]);
    }
    expect(actionCalls.count).toBe(0);
    expect(writes()).toEqual([]);

    // After a refused submit every rule shows live, until the suffix follows them.
    type("ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(descriptionsOf(field()).at(-1)).toBe(DESCRIPTOR_STRINGS.problems.maxLength);
    type("ABCDEFGHIJKLMNOPQRSTUV");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("previews the statement line, cut at 22 characters with a note, and counts the characters", async () => {
    await openPayments();
    const preview = () => form("test").querySelector<HTMLElement>("[data-preview]");

    type("Acme Travel");
    expect(previewLine()).toBe("VELEXIS* ACME TRAVEL");
    expect(preview()?.querySelector("[data-length]")?.textContent).toBe(DESCRIPTOR_STRINGS.length(11));
    expect(preview()?.querySelector("[data-cut]")).toBeNull();
    // The preview is a live region tied to the field, so a screen reader hears the new line.
    const output = preview()?.querySelector("output");
    expect(output?.getAttribute("for")).toBe(field().id);
    expect(output?.getAttribute("aria-live")).toBe("polite");

    type("Acme Travel Group 24");
    expect(previewLine()).toBe("VELEXIS* ACME TRAVEL G");
    expect(previewLine()).toHaveLength(STATEMENT_LINE_MAX_LENGTH);
    expect(preview()?.querySelector("[data-cut]")?.textContent).toBe(DESCRIPTOR_STRINGS.previewCut(13));
    expect(preview()?.querySelector("[data-length]")?.textContent).toBe(DESCRIPTOR_STRINGS.length(20));

    type("");
    expect(previewLine()).toBe(DESCRIPTOR_STRINGS.previewEmpty);
  });
});

describe("the rules of descriptor-rules.ts", () => {
  /** Values around every rule: accepted and refused by the document, before and after the form trims them. */
  const SAMPLES = [
    "ACME TRAVEL",
    "Acme Travel 24",
    "AB",
    "A1",
    "1A",
    "12 A",
    "ACME  TRAVEL",
    "ABCDEFGHIJKLMNOPQRSTUV",
    "ABCDEFGHIJKLMNOPQRSTUVW",
    "A",
    "",
    "1234",
    "24 7",
    "ACME*TRAVEL",
    "<ACME>",
    "ACME'S",
    'ACME "24"',
    "ACME\\24",
    "ACMÉ TRAVEL",
    "Acme & Co",
    "Acme.Travel",
    "Acme-Travel",
    "ACME\tTRAVEL",
    "ACME\nTRAVEL",
    "ＡＣＭＥ",
    "😀 ACME",
    "ACME 😀",
    " ACME",
    "ACME ",
    "  ACME TRAVEL  ",
    "   ",
    " ABCDEFGHIJKLMNOPQRSTUV ",
  ];

  it("[PFE-016 AC1] the action's Zod schema and the browser's rules accept exactly what the document's StatementDescriptorSuffix accepts, once trimmed", async () => {
    const schema = documentSuffixSchema();
    expect([schema.minLength, schema.maxLength]).toEqual([
      DESCRIPTOR_SUFFIX_MIN_LENGTH,
      DESCRIPTOR_SUFFIX_MAX_LENGTH,
    ]);

    for (const sample of SAMPLES) {
      const sent = sample.trim();
      const accepted = documentAccepts(schema, sent);
      // The browser's check, on the trimmed value it sends.
      expect([sample, descriptorSuffixProblem(sent) === null]).toEqual([sample, accepted]);
      if (sample === sent) {
        // Without spaces at its ends, the form's verdict is the document's for the value as typed.
        expect([sample, descriptorSuffixProblem(sample) === null]).toEqual([
          sample,
          documentAccepts(schema, sample),
        ]);
      }
      // The action's Zod schema: an accepted suffix goes to the API trimmed, a refused one makes no call.
      fetchMock.mockClear();
      const state = await saveStatementDescriptor(
        IDLE,
        formData({ ...VALID_FORM, statementDescriptorSuffix: sample }),
      );
      expect([sample, state.status]).toEqual([sample, accepted ? "saved" : "failed"]);
      const patches = calls("PATCH", TEST_PATH);
      expect([sample, patches.length]).toEqual([sample, accepted ? 1 : 0]);
      if (accepted) {
        expect(await bodyOf(patches[0])).toEqual({ statementDescriptorSuffix: sent });
      } else {
        expect(state.fieldError).toBeDefined();
      }
    }
  });

  it("refuses Stripe's forbidden characters, the ones the document names", () => {
    const { description } = documentSuffixSchema();
    const named = [...description.matchAll(/`([^`])`/g)].map((match) => match[1]);
    expect([...named].sort()).toEqual([...STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS].sort());
    for (const character of STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS) {
      expect(descriptorSuffixProblem(`ACME${character}TRAVEL`)).toBe("forbiddenCharacter");
    }
  });

  it("builds the statement line of a valid suffix only", () => {
    expect(statementLine("Acme Travel")).toEqual({ line: "VELEXIS* ACME TRAVEL", cut: false });
    expect(statementLine("ABCDEFGHIJKLM")).toEqual({ line: "VELEXIS* ABCDEFGHIJKLM", cut: false });
    expect(statementLine("ABCDEFGHIJKLMN")).toEqual({ line: "VELEXIS* ABCDEFGHIJKLM", cut: true });
    // A cut after a space leaves no space at the end of the line.
    expect(statementLine("ABCDEFGHIJKL MN")).toEqual({ line: "VELEXIS* ABCDEFGHIJKL", cut: true });
    expect(SUFFIX_SHOWN_IN_FULL).toBe(13);
    for (const suffix of ["", "A", "1234", "ACME*TRAVEL", "ACMÉ"]) {
      expect([suffix, statementLine(suffix)]).toEqual([suffix, null]);
    }
  });
});

// ---- The API's answers ---------------------------------------------------------------------------------------------

describe("the answers of updatePaymentConnection", () => {
  it("[PFE-016 AC1] shows the reload message for PRECONDITION_FAILED and keeps what was typed and the version [PF-60]", async () => {
    routes({ [`PATCH ${TEST_PATH}`]: () => apiError("PRECONDITION_FAILED", 412) });
    await openPayments();
    type("ACME FLY");
    submit();

    await waitFor(() => expect(summaryItems()).toEqual([DESCRIPTOR_STRINGS.stale]), ACTION_WAIT);
    await waitFor(() => expect(document.activeElement).toBe(summary()), ACTION_WAIT);
    const reload = within(form("test")).getByRole("link", { name: DESCRIPTOR_STRINGS.reload });
    // A full reload of the page, which shows the suffix someone else saved and its version.
    expect(reload.getAttribute("href")).toBe(`/otas/${TENANT_ID}/payments`);
    expect(field().value).toBe("ACME FLY");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(formVersion()).toBe("1");
    expect(savedNotice()).toBeNull();
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(API_TEXT);
  });

  it("puts the API's field errors on the suffix at the field, in the portal's words", async () => {
    routes({
      [`PATCH ${TEST_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, [{ path: "/statementDescriptorSuffix", code: "pattern" }]),
    });
    await openPayments();
    type("ACME FLY");
    submit();

    await waitFor(() => expect(summaryItems()).toEqual([DESCRIPTOR_STRINGS.problems.rules]), ACTION_WAIT);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(descriptionsOf(field()).at(-1)).toBe(DESCRIPTOR_STRINGS.problems.rules);
    expect(field().value).toBe("ACME FLY");
    expect(within(form("test")).queryByRole("link", { name: DESCRIPTOR_STRINGS.reload })).toBeNull();
    expect(document.body.textContent).not.toContain(API_TEXT);

    // The message stays with the suffix it was about: a new suffix drops it.
    type("ACME FLIGHTS");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("maps every rule code of the API to the portal's message, and an error elsewhere to an expired form", async () => {
    for (const [code, message] of [
      ["minLength", DESCRIPTOR_STRINGS.problems.minLength],
      ["maxLength", DESCRIPTOR_STRINGS.problems.maxLength],
      ["pattern", DESCRIPTOR_STRINGS.problems.rules],
      ["forbiddenCharacter", DESCRIPTOR_STRINGS.problems.forbiddenCharacter],
      ["characters", DESCRIPTOR_STRINGS.problems.characters],
      ["letter", DESCRIPTOR_STRINGS.problems.letter],
      ["start", DESCRIPTOR_STRINGS.problems.start],
      ["a_rule_of_a_newer_api", DESCRIPTOR_STRINGS.problems.rules],
    ] as const) {
      routes({
        [`PATCH ${TEST_PATH}`]: () =>
          apiError("VALIDATION_FAILED", 400, [{ path: "/statementDescriptorSuffix", code }]),
      });
      const state = await saveStatementDescriptor(IDLE, formData(VALID_FORM));
      expect([code, state]).toEqual([
        code,
        { status: "failed", code: "VALIDATION_FAILED", version: 1, suffix: "ACME FLY", fieldError: message },
      ]);
    }

    for (const path of ["/header/If-Match", "/path/environment", ""]) {
      routes({
        [`PATCH ${TEST_PATH}`]: () => apiError("VALIDATION_FAILED", 400, [{ path, code: "pattern" }]),
      });
      const state = await saveStatementDescriptor(IDLE, formData(VALID_FORM));
      expect([path, state]).toEqual([
        path,
        {
          status: "failed",
          code: "VALIDATION_FAILED",
          version: 1,
          suffix: "ACME FLY",
          message: DESCRIPTOR_STRINGS.formExpired,
          reload: true,
        },
      ]);
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("explains the other refusals, an unavailable API, and follows the session's end", async () => {
    for (const [code, status, message, reload] of [
      ["TENANT_NOT_ACTIVE", 409, DESCRIPTOR_STRINGS.notActive, true],
      ["FORBIDDEN", 403, DESCRIPTOR_STRINGS.forbidden, true],
      ["NOT_FOUND", 404, DESCRIPTOR_STRINGS.removed, true],
      ["RATE_LIMITED", 429, DESCRIPTOR_STRINGS.rateLimited, false],
      ["INTERNAL_ERROR", 500, ERROR_MESSAGES.INTERNAL_ERROR, false],
    ] as const) {
      routes({ [`PATCH ${TEST_PATH}`]: () => apiError(code, status) });
      const state = await saveStatementDescriptor(IDLE, formData(VALID_FORM));
      expect([code, state]).toEqual([
        code,
        {
          status: "failed",
          code,
          version: 1,
          suffix: "ACME FLY",
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
    const unreachable = await saveStatementDescriptor(IDLE, formData(VALID_FORM));
    expect(unreachable).toMatchObject({ status: "failed", code: "SERVICE_UNAVAILABLE" });
    expect(unreachable.message).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);

    for (const code of ["UNAUTHENTICATED", "TOKEN_EXPIRED"]) {
      routes({ [`PATCH ${TEST_PATH}`]: () => apiError(code, 401) });
      await expect(saveStatementDescriptor(IDLE, formData(VALID_FORM))).rejects.toThrow(
        `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments`,
      );
    }
    routes({ [`PATCH ${TEST_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(saveStatementDescriptor(IDLE, formData(VALID_FORM))).rejects.toThrow(
      "NEXT_REDIRECT /verify-pending",
    );
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("[PFE-016 AC1] refuses a form posted without the browser's checks, or without its hidden fields, without a call", async () => {
    // A suffix that breaks a rule (a form posted before the page hydrated, or a forged one): Zod refuses it first.
    for (const [suffix, problem] of [
      ["ACME*TRAVEL", "forbiddenCharacter"],
      ["ACMÉ", "characters"],
      ["A", "minLength"],
      ["ABCDEFGHIJKLMNOPQRSTUVW", "maxLength"],
      ["1234", "letter"],
      ["  ", "required"],
    ] as const) {
      const state = await saveStatementDescriptor(
        IDLE,
        formData({ ...VALID_FORM, statementDescriptorSuffix: suffix }),
      );
      expect([suffix, state]).toEqual([
        suffix,
        {
          status: "failed",
          code: "VALIDATION_FAILED",
          version: 1,
          suffix,
          fieldError: DESCRIPTOR_STRINGS.problems[problem],
        },
      ]);
    }

    // Without a valid OTA, environment or version the save could not name its connection: an expired form.
    for (const fields of [
      { ...VALID_FORM, tenantId: "" },
      { ...VALID_FORM, tenantId: "ten_not-an-id" },
      { ...VALID_FORM, environment: "staging" },
      { ...VALID_FORM, environment: "" },
      { ...VALID_FORM, version: "0" },
      { ...VALID_FORM, version: "1.5" },
      { ...VALID_FORM, version: "" },
    ]) {
      const state = await saveStatementDescriptor(IDLE, formData(fields));
      expect([fields, state.status, state.message, state.reload]).toEqual([
        fields,
        "failed",
        DESCRIPTOR_STRINGS.formExpired,
        true,
      ]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- Rendered on the server ------------------------------------------------------------------------------------------

describe("rendered on the server", () => {
  it("renders the payments page with both forms and hydrates it without an error or a change", async () => {
    routes({ [`GET ${PAYMENTS_PATH}`]: () => json({ data: [paymentConnection(), liveConnection()] }, 200) });
    const rendered = await serverRenderAndHydrate(await pageElement());
    try {
      expect(rendered.errors).toEqual([]);
      // The hydrated page is the server's page: same markup, nothing replaced in the browser.
      expect(rendered.container.innerHTML).toBe(rendered.serverDom);
      expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
      expect(rendered.container.querySelectorAll("[data-descriptor-form]")).toHaveLength(2);
      expect(
        [...rendered.container.querySelectorAll("[data-statement-line]")].map((line) => line.textContent),
      ).toEqual(["VELEXIS* ACME TRAVEL", "VELEXIS* ACME LIVE"]);
    } finally {
      act(() => rendered.root.unmount());
    }
  });
});
