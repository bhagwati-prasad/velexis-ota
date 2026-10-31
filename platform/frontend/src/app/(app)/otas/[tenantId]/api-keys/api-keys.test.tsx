// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { Component, type ReactElement, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the configuration; the real API client talks to a mocked fetch ----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => `/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/api-keys`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
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
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import {
  createKey,
  revokeKey,
  rollKey,
  updateKey,
  type CreateKeyState,
} from "@/app/(app)/otas/[tenantId]/api-keys/actions";
import ApiKeysPage from "@/app/(app)/otas/[tenantId]/api-keys/page";
import { formatDateTime } from "@/components/date-time";
import { MAX_ALLOWED_ORIGINS, originProblem } from "@/components/origins-field";
import { CONSOLE_API_KEY_SCOPES, STAFF_PERMISSIONS, scopeProblem } from "@/components/scope-picker";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  API_KEY_KIND_LABELS,
  API_KEY_SCOPE_STRINGS,
  API_KEYS_STRINGS,
  ERROR_MESSAGES,
  KEY_EXPIRY_LABELS,
  NOT_ALLOWED_STRINGS,
  ROLE_LABELS,
  ROLL_EXPIRY_LABELS,
  SECRET_STRINGS,
  STEP_UP_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real key or token) ----------------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type ApiKey = Schemas["ApiKey"];

const ACCESS_TOKEN = "pfe011-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-011 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const KEYS_PATH = `${TENANT_PATH}/api-keys`;
const PAGE_PATH = `/otas/${TENANT_ID}/api-keys`;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** When the file started: the fixtures' instants are relative to it and never name a calendar date. */
const STARTED_AT = Date.now();

/** An instant `ms` before or after the start of the file, the same for every call. */
function at(ms: number): string {
  return new Date(STARTED_AT + ms).toISOString();
}

/**
 * A full key as the API answers it once (`<pk|sk>_test_` and 40 base62 characters, PADR-0005): its first 6 secret
 * characters (the end of the prefix), a filler that says it is a dummy, and its last 4. Never a real key.
 */
function dummyKey(kind: "pk" | "sk", start: string, last4: string): string {
  return `${kind}_test_${start}PFE011DummyValueNeverARealKey0${last4}`;
}

const NEW_SECRET_KEY = dummyKey("sk", "Nw11Sc", "Sc44");
const NEW_PUBLISHABLE_KEY = dummyKey("pk", "Nw11Pb", "Pb55");
const ROLLED_KEY = dummyKey("sk", "Rl22Nw", "Rl66");
const NEW_KEY_ID = "key_01JB3KF5J9M3P7S1V5Y9B3D7F1";
const ROLLED_KEY_ID = "key_01JB3KG7K1N5Q9T3W7Y1A5C9E3";

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
    createdAt: at(-10 * DAY_MS),
    activatedAt: at(-10 * DAY_MS),
    version: 4,
    myRole: "owner",
    ...overrides,
  };
}

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key_01JB3KA2C6E0G4J8M2P6S0V4X8",
    name: "Storefront production",
    kind: "secret",
    environment: "test",
    prefix: "sk_test_Qw34Er",
    last4: "Df90",
    allowedOrigins: [],
    scopes: ["storefront"],
    createdAt: at(-5 * DAY_MS),
    createdBy: { accountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X", fullName: "Anna Berg" },
    lastUsedAt: at(-3 * MINUTE_MS),
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/** The keys `listApiKeys` answers by default, newest first: one of each kind of row. */
function listed(): ApiKey[] {
  return [
    apiKey(),
    apiKey({
      id: "key_01JB3KC9F3H7K1N5Q9T3W7Y1A5",
      name: "Nightly export",
      prefix: "sk_test_Au70Mx",
      last4: "Jb31",
      scopes: ["console:automation", "bookings:read", "queues:read"],
      lastUsedAt: null,
      expiresAt: at(30 * DAY_MS),
    }),
    apiKey({
      id: "key_01JA2ZD8E2G6J0K4N8Q2S6W0Y4",
      name: "Website",
      kind: "publishable",
      prefix: "pk_test_Zy98Xw",
      last4: "Hg10",
      allowedOrigins: ["https://www.acme-travel.example.com", "http://localhost:5173"],
      scopes: [],
      createdBy: null,
      lastUsedAt: null,
    }),
    apiKey({
      id: "key_01JB3KD1G5J9M3P7S1V5Y9B3D7",
      name: "Old storefront",
      prefix: "sk_test_Ex99Pq",
      last4: "Zz12",
      expiresAt: at(-HOUR_MS),
    }),
    apiKey({
      id: "key_01JB3KE3H7K1N5Q9T3W7Y1A5C9",
      name: "Leaked key",
      prefix: "sk_test_Rv55Lk",
      last4: "Kk77",
      revokedAt: at(-2 * DAY_MS),
    }),
  ];
}

const SECRET_MASKED = "sk_test_Qw34Er…Df90";
const PUBLISHABLE_MASKED = "pk_test_Zy98Xw…Hg10";

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
  options: { details?: Record<string, unknown>; fieldErrors?: { path: string; code: string }[] } = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pfe011",
        ...(options.details === undefined ? {} : { details: options.details }),
        ...(options.fieldErrors === undefined
          ? {}
          : {
              fieldErrors: options.fieldErrors.map((fieldError) => ({
                ...fieldError,
                message: "The API's own field text",
              })),
            }),
      },
    },
    status,
  );
}

/** `createApiKey` as the API answers it: the new key's settings from the request, and the full key once. */
async function created(request: Request): Promise<Response> {
  const body = (await request.clone().json()) as {
    name: string;
    kind: ApiKey["kind"];
    allowedOrigins?: string[];
    scopes?: string[];
    expiresAt?: string;
  };
  const key = body.kind === "secret" ? NEW_SECRET_KEY : NEW_PUBLISHABLE_KEY;
  return json(
    {
      apiKey: apiKey({
        id: NEW_KEY_ID,
        name: body.name,
        kind: body.kind,
        prefix: key.slice(0, 14),
        last4: key.slice(-4),
        allowedOrigins: body.allowedOrigins ?? [],
        scopes: body.scopes ?? [],
        createdAt: at(0),
        lastUsedAt: null,
        expiresAt: body.expiresAt ?? null,
      }),
      key,
    },
    201,
    { "cache-control": "no-store" },
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call by `METHOD /path`: by default an active owner's OTA and the keys of `listed()`. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${KEYS_PATH}`]: () => json({ data: listed() }, 200),
    [`POST ${KEYS_PATH}`]: created,
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

/** The JSON body of a call. */
async function bodyOf(request: Request | undefined): Promise<unknown> {
  return request?.clone().json();
}

/** Every call carries the session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

function formData(fields: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const each of typeof value === "string" ? [value] : value) {
      data.append(name, each);
    }
  }
  return data;
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/**
 * Next.js handles the `redirect()` of a server action by navigating; in a component test the action runs in the
 * page, so its redirect error reaches this boundary, which shows where the browser would go.
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
      <p role="status">Redirected to {this.state.target}</p>
    );
  }
}

function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

/** `/otas/<id>/api-keys` as the server renders it for one request (a page load or a reload). */
async function openPage(): Promise<void> {
  const page = await ApiKeysPage({ params: params() });
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/** A reload: the document is emptied and the page rendered again from the server. */
async function reload(): Promise<void> {
  cleanup();
  document.body.replaceChildren();
  await openPage();
}

/**
 * The wait for what a server action renders: the action runs the real `lib/api.ts` over the mocked fetch, which on a
 * busy CI runner can outlast Testing Library's 1 s default. It stays well inside the test's own budget.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/** The budget of the file's warm-up hook (the first render and action of a fresh worker are the slowest). */
const WARM_UP_TIMEOUT_MS = 30_000;

function keysTable(): HTMLElement {
  return screen.getByRole("table", { name: API_KEYS_STRINGS.listCaption("test") });
}

/** The table row of the key shown as `masked`. */
function rowOf(masked: string): HTMLElement {
  const row = within(keysTable())
    .getAllByRole("row")
    .find((candidate) => candidate.textContent?.includes(masked) === true);
  if (row === undefined) {
    throw new Error(`No row for ${masked}.`);
  }
  return row;
}

/** The text of each cell of `row`, by the column's header. */
function cellsOf(row: HTMLElement): Record<string, string> {
  const headers = within(keysTable())
    .getAllByRole("columnheader")
    .map((header) => header.textContent ?? "");
  const cells = [...row.children].map((cell) => cell.textContent ?? "");
  return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
}

function createSection(): HTMLElement {
  return screen.getByRole("region", { name: API_KEYS_STRINGS.createTitle("test") });
}

function inCreate(label: string): HTMLInputElement {
  return within(createSection()).getByLabelText(label) as HTMLInputElement;
}

/** A permission checkbox of the create form (its label holds the words and the code). */
function permissionBox(permission: string): HTMLInputElement {
  const box = document.getElementById(`create-key-test-permission-${permission.replace(":", "-")}`);
  if (!(box instanceof HTMLInputElement)) {
    throw new Error(`No checkbox for ${permission}.`);
  }
  return box;
}

function type(control: HTMLElement, value: string): void {
  fireEvent.change(control, { target: { value } });
}

/** Submits the form of `button` as a click on it does. */
function submit(button: HTMLElement): void {
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

function submitCreate(): void {
  submit(within(createSection()).getByRole("button", { name: API_KEYS_STRINGS.submit }));
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: Element): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

/** The created key's panel. */
function createdPanel(kind: ApiKey["kind"] = "secret"): Promise<HTMLElement> {
  return screen.findByRole("region", { name: API_KEYS_STRINGS.createdTitle(kind, "test") }, ACTION_WAIT);
}

/** The repository root: the nearest folder above the working directory with `pnpm-workspace.yaml`. */
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

/** The `enum` of a schema of the OTA document, in its order. */
function otaEnum(schema: string): string[] {
  const document = readFileSync(
    join(repositoryRoot(), "ota/backend/openapi/velexis-ota-booking-api.openapi.yaml"),
    "utf8",
  );
  const lines = document.split("\n");
  const start = lines.indexOf(`    ${schema}:`);
  expect(start).toBeGreaterThan(-1);
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const value = /^ {8}- (\S+)$/.exec(line)?.[1];
    if (value !== undefined) {
      values.push(value);
    } else if (values.length > 0) {
      break;
    }
  }
  return values;
}

/** happy-dom keeps some character references of attribute values as text, where a browser decodes them. */
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

/** Renders `element` as a browser gets it and collects every error React or the window reports on the way. */
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
}

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe011_portal",
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
 * Once per file, before any test: the page's render, a typed value and a create through the action, the API client
 * and the mocked API. The first run of those paths in a fresh worker is the slowest, and on a busy CI runner it
 * otherwise lands in the first test's own five seconds; here it has the hook's own budget. Nothing of it stays: each
 * test gets a fresh API, fresh mocks and globals (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  await openPage();
  type(inCreate(API_KEYS_STRINGS.nameLabel), "Warm-up key");
  submitCreate();
  await screen.findByRole(
    "region",
    { name: API_KEYS_STRINGS.createdTitle("secret", "test") },
    { timeout: WARM_UP_TIMEOUT_MS },
  );
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The page -----------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]/api-keys: the list", () => {
  it("[PFE-011 AC3] shows when each key was last used, and that a key was never used [PF-30 AC5]", async () => {
    await openPage();

    const lastUsedAt = listed()[0]?.lastUsedAt ?? "";
    expect(lastUsedAt).not.toBe("");
    expect(cellsOf(rowOf(SECRET_MASKED))[API_KEYS_STRINGS.columnLastUsed]).toBe(formatDateTime(lastUsedAt));
    // The time element carries the API's instant.
    expect(rowOf(SECRET_MASKED).querySelector(`time[datetime="${lastUsedAt}"]`)).not.toBeNull();
    // Keys that were never used say so.
    expect(cellsOf(rowOf(PUBLISHABLE_MASKED))[API_KEYS_STRINGS.columnLastUsed]).toBe(
      API_KEYS_STRINGS.neverUsed,
    );
    expect(cellsOf(rowOf("sk_test_Au70Mx…Jb31"))[API_KEYS_STRINGS.columnLastUsed]).toBe(
      API_KEYS_STRINGS.neverUsed,
    );
    // The page says how fresh the column is (up to 5 minutes).
    expect(screen.getByText(API_KEYS_STRINGS.listIntro)).toBeTruthy();
  });

  it("lists every key with its name, kind, prefix and last four, access, creator, expiry and state", async () => {
    await openPage();

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      API_KEYS_STRINGS.title,
    ]);
    const tab = screen.getByRole("tab", { name: API_KEYS_STRINGS.tab("test") });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    // Live keys get their tab with the go-live switch (PFE-026).
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    const keys = listed();
    const rows = within(keysTable()).getAllByRole("row").slice(1);
    expect(rows.map((row) => cellsOf(row)[API_KEYS_STRINGS.columnName])).toEqual(keys.map((key) => key.name));

    const secret = cellsOf(rowOf(SECRET_MASKED));
    expect(secret[API_KEYS_STRINGS.columnKind]).toBe(API_KEY_KIND_LABELS.secret);
    expect(secret[API_KEYS_STRINGS.columnKey]).toBe(SECRET_MASKED);
    expect(secret[API_KEYS_STRINGS.columnAccess]).toBe(API_KEY_SCOPE_STRINGS.storefront.label);
    expect(secret[API_KEYS_STRINGS.columnCreated]).toBe(
      `${formatDateTime(keys[0]?.createdAt ?? "", { mode: "date" }) ?? ""}${API_KEYS_STRINGS.createdBy("Anna Berg")}`,
    );
    expect(secret[API_KEYS_STRINGS.columnExpires]).toBe(API_KEYS_STRINGS.noExpiry);
    expect(secret[API_KEYS_STRINGS.columnStatus]).toBe(API_KEYS_STRINGS.stateActive);

    // A console automation key lists its permissions; its expiry is shown.
    const automation = cellsOf(rowOf("sk_test_Au70Mx…Jb31"));
    expect(automation[API_KEYS_STRINGS.columnAccess]).toBe(
      `${API_KEY_SCOPE_STRINGS["console:automation"].label}bookings:readqueues:read`,
    );
    expect(automation[API_KEYS_STRINGS.columnExpires]).toBe(formatDateTime(keys[1]?.expiresAt ?? ""));

    // A publishable key lists its origins; the keys of the set-up have no creator.
    const publishable = cellsOf(rowOf(PUBLISHABLE_MASKED));
    expect(publishable[API_KEYS_STRINGS.columnKind]).toBe(API_KEY_KIND_LABELS.publishable);
    expect(publishable[API_KEYS_STRINGS.columnAccess]).toBe(
      "https://www.acme-travel.example.comhttp://localhost:5173",
    );
    expect(publishable[API_KEYS_STRINGS.columnCreated]).toContain(API_KEYS_STRINGS.createdAtSetup);

    // An expired key still has its actions (it can be rolled or revoked); a revoked one has none.
    expect(cellsOf(rowOf("sk_test_Ex99Pq…Zz12"))[API_KEYS_STRINGS.columnStatus]).toBe(
      API_KEYS_STRINGS.stateExpired,
    );
    expect(within(rowOf("sk_test_Ex99Pq…Zz12")).getAllByRole("button")).toHaveLength(3);
    const revoked = rowOf("sk_test_Rv55Lk…Kk77");
    expect(cellsOf(revoked)[API_KEYS_STRINGS.columnStatus]).toBe(
      `${API_KEYS_STRINGS.stateRevoked}${formatDateTime(keys[4]?.revokedAt ?? "") ?? ""}`,
    );
    expect(within(revoked).queryAllByRole("button")).toHaveLength(0);

    // One listApiKeys with the revoked keys, the session and the end-user headers; the page writes nothing.
    const [call, ...more] = calls("GET", KEYS_PATH);
    expect(more).toHaveLength(0);
    expect(new URL(call?.url ?? "").searchParams.get("includeRevoked")).toBe("true");
    expectSessionHeaders(call);
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("says so when there is no key yet", async () => {
    routes({ [`GET ${KEYS_PATH}`]: () => json({ data: [] }, 200) });
    await openPage();
    expect(within(keysTable()).getByText(API_KEYS_STRINGS.empty)).toBeTruthy();
  });

  it("gives agents, finance members and viewers the not-allowed page without listing a key", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      resetPlatformApi();
      routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ myRole: role }), 200) });
      await openPage();
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(NOT_ALLOWED_STRINGS.title);
      expect(screen.getByText(NOT_ALLOWED_STRINGS.intro(ROLE_LABELS[role]))).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
      expect(document.querySelector("form")).toBeNull();
      expect(calls("GET", KEYS_PATH)).toHaveLength(0);
      cleanup();
    }
  });

  it("sends an ended session to sign-in and back to this page, and shows the portal's message when the keys cannot be loaded", async () => {
    routes({ [`GET ${KEYS_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(ApiKeysPage({ params: params() })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent(PAGE_PATH)}`,
    );
    routes({ [`GET ${KEYS_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(ApiKeysPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT /verify-pending");
    routes({ [`GET ${KEYS_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await expect(ApiKeysPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
    // An id that is no OTA id makes no call.
    fetchMock.mockClear();
    await expect(ApiKeysPage({ params: params("not-an-ota") })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`GET ${KEYS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openPage();
    expect(screen.getByRole("alert").textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(screen.queryByRole("table")).toBeNull();
    // Creating a key does not need the list.
    expect(createSection()).toBeTruthy();
  });

  it("keeps the keys read-only, with the reason, while the OTA is not active", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "suspended", suspensionReason: "admin" }), 200),
    });
    await openPage();

    expect(document.querySelector('[data-notice="read-only"]')?.textContent).toContain(
      API_KEYS_STRINGS.readOnly.suspended,
    );
    const fieldset = inCreate(API_KEYS_STRINGS.nameLabel).closest("fieldset");
    expect(fieldset?.disabled).toBe(true);
    const createButton = within(createSection()).getByRole("button", {
      name: API_KEYS_STRINGS.submit,
    }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    for (const button of within(rowOf(SECRET_MASKED)).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    submitCreate();
    expect(calls("POST", KEYS_PATH)).toHaveLength(0);
  });

  it("names the page in one h1, renders on the server and hydrates without an error or a mismatch", async () => {
    const page = await ApiKeysPage({ params: params() });
    if (page === null) {
      throw new Error("The page rendered nothing.");
    }
    const { errors, root, serverDom, container } = await serverRenderAndHydrate(page);
    expect(errors).toEqual([]);
    // Radix's roving focus makes the tab list focusable once it has mounted (`tabindex` -1 → 0): an effect after
    // hydration, not a mismatch. Everything else is the server's markup.
    const tabList = container.querySelector('[role="tablist"]');
    expect(tabList?.getAttribute("tabindex")).toBe("0");
    tabList?.setAttribute("tabindex", "-1");
    expect(container.innerHTML).toBe(serverDom);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    act(() => root.unmount());
  });
});

// ---- Creating a key -------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]/api-keys: creating a key", () => {
  it("[PFE-011 AC1] shows the created key once, in memory only, and a reload no longer has it [PF-30 AC1]", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    const urlBefore = location.href;
    await openPage();

    type(inCreate(API_KEYS_STRINGS.nameLabel), "  Storefront staging  ");
    submitCreate();
    const panel = await createdPanel();

    // The key, once, with the shown-once warning, its place in the list and the recommended set-ups.
    const field = within(panel).getByLabelText(
      API_KEYS_STRINGS.createdKeyLabel("Storefront staging"),
    ) as HTMLInputElement;
    expect(field.value).toBe(NEW_SECRET_KEY);
    expect(field.getAttribute("name")).toBeNull();
    expect(panel.textContent).toContain(SECRET_STRINGS.warningTitle);
    expect(panel.textContent).toContain(API_KEYS_STRINGS.createdListed("sk_test_Nw11Sc…Sc44"));
    expect(within(panel).getByRole("heading", { name: API_KEYS_STRINGS.recommendedTitle })).toBeTruthy();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(API_KEYS_STRINGS.recommended.length);
    expect(document.body.innerHTML.split(NEW_SECRET_KEY)).toHaveLength(2);

    // One createApiKey: a secret test key scoped storefront, the trimmed name, no expiry; then the list is renewed.
    const [create, ...more] = calls("POST", KEYS_PATH);
    expect(more).toHaveLength(0);
    expectSessionHeaders(create);
    expect(await bodyOf(create)).toEqual({
      name: "Storefront staging",
      kind: "secret",
      environment: "test",
      scopes: ["storefront"],
    });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);
    // The form starts again, so a second click does not make a second key.
    expect(inCreate(API_KEYS_STRINGS.nameLabel).value).toBe("");

    // Nothing of it was written anywhere: storage, cookies, the URL or the history.
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(cookieWrite).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(location.href).toBe(urlBefore);

    // A reload renders the page from the server: the new key is listed by its prefix, and the key itself is gone.
    const createdKey = apiKey({
      id: NEW_KEY_ID,
      name: "Storefront staging",
      prefix: NEW_SECRET_KEY.slice(0, 14),
      last4: NEW_SECRET_KEY.slice(-4),
      lastUsedAt: null,
    });
    routes({ [`GET ${KEYS_PATH}`]: () => json({ data: [createdKey, ...listed()] }, 200) });
    expect(renderToString(await ApiKeysPage({ params: params() }))).not.toContain(NEW_SECRET_KEY);
    await reload();
    expect(cellsOf(rowOf("sk_test_Nw11Sc…Sc44"))[API_KEYS_STRINGS.columnName]).toBe("Storefront staging");
    expect(document.body.innerHTML).not.toContain(NEW_SECRET_KEY);
    expect(
      screen.queryByRole("region", { name: API_KEYS_STRINGS.createdTitle("secret", "test") }),
    ).toBeNull();
    expect(calls("POST", KEYS_PATH)).toHaveLength(1);
  });

  it('[PFE-011 AC1] "I have stored it" hides the key, and the next key gets a panel of its own', async () => {
    await openPage();
    type(inCreate(API_KEYS_STRINGS.nameLabel), "First");
    submitCreate();
    const panel = await createdPanel();
    fireEvent.click(within(panel).getByRole("button", { name: SECRET_STRINGS.dismiss }));
    expect(screen.getByText(SECRET_STRINGS.dismissed)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(NEW_SECRET_KEY);

    // The next key arrives with a new id: its panel shows it, though the last one was dismissed.
    routes({
      [`POST ${KEYS_PATH}`]: async (request) => {
        const answer = (await (await created(request)).json()) as { apiKey: ApiKey; key: string };
        return json({ ...answer, apiKey: { ...answer.apiKey, id: ROLLED_KEY_ID } }, 201);
      },
    });
    type(inCreate(API_KEYS_STRINGS.nameLabel), "Second");
    submitCreate();
    const next = await createdPanel();
    expect(
      (within(next).getByLabelText(API_KEYS_STRINGS.createdKeyLabel("Second")) as HTMLInputElement).value,
    ).toBe(NEW_SECRET_KEY);
  });

  it("[PFE-011 AC1] creates a publishable key with its origins, without empty rows, and an expiry", async () => {
    await openPage();
    type(inCreate(API_KEYS_STRINGS.nameLabel), "Website");
    fireEvent.click(inCreate(API_KEYS_STRINGS.kindPublishable));
    // A publishable key takes origins and no scopes.
    expect(within(createSection()).queryByRole("group", { name: API_KEYS_STRINGS.scopesLegend })).toBeNull();
    const origins = within(createSection()).getByRole("group", { name: API_KEYS_STRINGS.originsLegend });
    expect(descriptionsOf(origins)).toEqual([API_KEYS_STRINGS.originsHint("test")]);
    type(
      within(origins).getByLabelText(API_KEYS_STRINGS.originLabel(1)),
      " https://www.acme-travel.example.com ",
    );
    fireEvent.click(within(origins).getByRole("button", { name: API_KEYS_STRINGS.addOrigin }));
    fireEvent.click(within(origins).getByRole("button", { name: API_KEYS_STRINGS.addOrigin }));
    type(within(origins).getByLabelText(API_KEYS_STRINGS.originLabel(3)), "http://localhost:5173");
    fireEvent.change(inCreate(API_KEYS_STRINGS.expiryLabel), { target: { value: "30d" } });
    expect(inCreate(API_KEYS_STRINGS.expiryLabel).value).toBe("30d");
    const before = Date.now();
    submitCreate();

    const panel = await createdPanel("publishable");
    expect(
      (within(panel).getByLabelText(API_KEYS_STRINGS.createdKeyLabel("Website")) as HTMLInputElement).value,
    ).toBe(NEW_PUBLISHABLE_KEY);
    const body = (await bodyOf(calls("POST", KEYS_PATH)[0])) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "Website",
      kind: "publishable",
      environment: "test",
      allowedOrigins: ["https://www.acme-travel.example.com", "http://localhost:5173"],
    });
    expect(body).not.toHaveProperty("scopes");
    // Thirty days from the submission (the bounds are the moments around it, not a fixed date).
    const expiresAt = Date.parse(String(body["expiresAt"]));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
    expect(Object.keys(KEY_EXPIRY_LABELS)).toEqual(["never", "7d", "30d", "90d", "365d"]);
  });

  it("[PFE-011 AC2] ScopePicker offers the permissions only with console:automation [PF-30 AC2]", async () => {
    await openPage();
    const picker = within(createSection()).getByRole("group", { name: API_KEYS_STRINGS.scopesLegend });
    const storefront = within(picker).getByLabelText(
      API_KEY_SCOPE_STRINGS.storefront.label,
    ) as HTMLInputElement;
    const consoleScope = within(picker).getByLabelText(API_KEY_SCOPE_STRINGS.console.label);
    const automation = within(picker).getByLabelText(API_KEY_SCOPE_STRINGS["console:automation"].label);
    const permissions = within(picker).getByRole("group", { name: API_KEYS_STRINGS.permissionsLegend });

    // Storefront is the default, and its permissions cannot be chosen; nor can those of "console".
    expect(storefront.checked).toBe(true);
    expect((permissions as HTMLFieldSetElement).disabled).toBe(true);
    expect(STAFF_PERMISSIONS.every((permission) => permissionBox(permission).disabled)).toBe(true);
    fireEvent.click(consoleScope);
    expect((permissions as HTMLFieldSetElement).disabled).toBe(true);
    expect(STAFF_PERMISSIONS.every((permission) => permissionBox(permission).disabled)).toBe(true);

    // Console automation opens them; leaving it clears and locks them, coming back restores the choice.
    fireEvent.click(automation);
    expect((permissions as HTMLFieldSetElement).disabled).toBe(false);
    fireEvent.click(permissionBox("queues:read"));
    fireEvent.click(permissionBox("bookings:read"));
    fireEvent.click(consoleScope);
    expect(STAFF_PERMISSIONS.some((permission) => permissionBox(permission).checked)).toBe(false);
    expect(permissionBox("bookings:read").disabled).toBe(true);
    fireEvent.click(automation);
    expect(permissionBox("bookings:read").checked).toBe(true);
    expect(permissionBox("queues:read").checked).toBe(true);

    type(inCreate(API_KEYS_STRINGS.nameLabel), "Nightly export");
    submitCreate();
    await createdPanel();
    // The use, then its permissions in the order of the OTA document.
    expect(await bodyOf(calls("POST", KEYS_PATH)[0])).toEqual({
      name: "Nightly export",
      kind: "secret",
      environment: "test",
      scopes: ["console:automation", "bookings:read", "queues:read"],
    });
  });

  it("[PFE-011 AC2] a console automation key needs a permission, and the message is at the picker", async () => {
    await openPage();
    const picker = within(createSection()).getByRole("group", { name: API_KEYS_STRINGS.scopesLegend });
    fireEvent.click(within(picker).getByLabelText(API_KEY_SCOPE_STRINGS["console:automation"].label));
    type(inCreate(API_KEYS_STRINGS.nameLabel), "Nightly export");
    submitCreate();

    await waitFor(
      () => expect(descriptionsOf(picker)).toContain(API_KEYS_STRINGS.automationNeedsPermission),
      ACTION_WAIT,
    );
    expect(screen.getByRole("alert").textContent).toContain(API_KEYS_STRINGS.automationNeedsPermission);
    expect(calls("POST", KEYS_PATH)).toHaveLength(0);
  });

  it("[PFE-011 AC2] refuses permissions without console:automation, also in a forged submission, without a call", async () => {
    for (const scope of ["storefront", "console"]) {
      const state = await createKey(
        { status: "idle", fieldErrors: {} },
        formData({
          tenantId: TENANT_ID,
          environment: "test",
          name: "Forged",
          kind: "secret",
          scope,
          permissions: ["bookings:read"],
        }),
      );
      expect(state).toEqual({
        status: "failed",
        code: "VALIDATION_FAILED",
        fieldErrors: { scopes: API_KEYS_STRINGS.permissionsWithoutAutomation },
      });
    }
    // An unknown permission or use is refused too.
    const unknown = await createKey(
      { status: "idle", fieldErrors: {} },
      formData({
        tenantId: TENANT_ID,
        environment: "test",
        name: "Forged",
        kind: "secret",
        scope: "console:automation",
        permissions: ["bookings:everything"],
      }),
    );
    expect(unknown.fieldErrors.scopes).toBe(API_KEYS_STRINGS.scopeUnknown);
    expect(fetchMock).not.toHaveBeenCalled();

    // The rules mirror PADR-0005 item 6 and the platform API's api-key-rules.ts.
    expect(scopeProblem(["storefront"])).toBeUndefined();
    expect(scopeProblem(["console"])).toBeUndefined();
    expect(scopeProblem(["console:automation", "bookings:read"])).toBeUndefined();
    expect(scopeProblem(["console", "console:automation", "payments:read"])).toBeUndefined();
    expect(scopeProblem(["console", "bookings:read"])).toBe("permissionsWithoutAutomation");
    expect(scopeProblem(["storefront", "bookings:read"])).toBe("permissionsWithoutAutomation");
    expect(scopeProblem(["storefront", "console"])).toBe("scopeCombination");
    expect(scopeProblem(["console:automation"])).toBe("automationNeedsPermission");
    expect(scopeProblem(["bookings:everything"])).toBe("unknownScope");
  });

  it("[PFE-011 AC2] puts the API's field errors next to their fields, never its text", async () => {
    routes({
      [`POST ${KEYS_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [
            { path: "/name", code: "maxLength" },
            { path: "/scopes", code: "scopeCombination" },
          ],
        }),
    });
    await openPage();
    type(inCreate(API_KEYS_STRINGS.nameLabel), "Storefront");
    submitCreate();

    const picker = within(createSection()).getByRole("group", { name: API_KEYS_STRINGS.scopesLegend });
    await waitFor(
      () => expect(descriptionsOf(picker)).toContain(API_KEYS_STRINGS.scopeCombination),
      ACTION_WAIT,
    );
    const name = inCreate(API_KEYS_STRINGS.nameLabel);
    expect(descriptionsOf(name)).toContain(API_KEYS_STRINGS.nameTooLong);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const summary = screen.getByRole("alert");
    // The summary takes the focus in an effect, which may run after the render the wait above saw.
    await waitFor(() => expect(document.activeElement).toBe(summary), ACTION_WAIT);
    expect(
      within(summary)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([API_KEYS_STRINGS.nameTooLong, API_KEYS_STRINGS.scopeCombination]);
    expect(document.body.textContent).not.toContain("The API's own");
    // A refused submission keeps what was typed.
    expect(inCreate(API_KEYS_STRINGS.nameLabel).value).toBe("Storefront");
  });

  it("[PFE-011 AC2] puts an origin's field error at the row it was typed in", async () => {
    routes({
      [`POST ${KEYS_PATH}`]: () =>
        apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [{ path: "/allowedOrigins/1", code: "insecureOrigin" }],
        }),
    });
    await openPage();
    type(inCreate(API_KEYS_STRINGS.nameLabel), "Website");
    fireEvent.click(inCreate(API_KEYS_STRINGS.kindPublishable));
    const origins = within(createSection()).getByRole("group", { name: API_KEYS_STRINGS.originsLegend });
    type(
      within(origins).getByLabelText(API_KEYS_STRINGS.originLabel(1)),
      "https://www.acme-travel.example.com",
    );
    fireEvent.click(within(origins).getByRole("button", { name: API_KEYS_STRINGS.addOrigin }));
    fireEvent.click(within(origins).getByRole("button", { name: API_KEYS_STRINGS.addOrigin }));
    type(
      within(origins).getByLabelText(API_KEYS_STRINGS.originLabel(3)),
      "https://book.acme-travel.example.com",
    );
    submitCreate();

    // The API's second origin is the form's third row: the empty second row was not sent.
    const third = within(origins).getByLabelText(API_KEYS_STRINGS.originLabel(3));
    await waitFor(
      () => expect(descriptionsOf(third)).toContain(API_KEYS_STRINGS.originInsecure("test")),
      ACTION_WAIT,
    );
    expect(third.getAttribute("aria-invalid")).toBe("true");
    expect(
      within(origins).getByLabelText(API_KEYS_STRINGS.originLabel(1)).getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("[PFE-011 AC2] reads the API's errors of the origin list by their code, and those of no field as an expired form", async () => {
    const publishable = formData({
      tenantId: TENANT_ID,
      environment: "test",
      name: "Website",
      kind: "publishable",
      allowedOrigins: ["https://www.acme-travel.example.com"],
    });
    const idle: CreateKeyState = { status: "idle", fieldErrors: {} };
    const answers: Record<string, string> = {
      maxItems: API_KEYS_STRINGS.originsTooMany,
      uniqueItems: API_KEYS_STRINGS.originDuplicate,
    };
    for (const [code, message] of Object.entries(answers)) {
      routes({
        [`POST ${KEYS_PATH}`]: () =>
          apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/allowedOrigins", code }] }),
      });
      expect((await createKey(idle, publishable)).fieldErrors).toEqual({ allowedOrigins: message });
    }
    // Origins for a secret key, or scopes for a publishable one, are nothing the form sends.
    for (const path of ["/allowedOrigins", "/scopes"]) {
      routes({
        [`POST ${KEYS_PATH}`]: () =>
          apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path, code: "notAllowed" }] }),
      });
      expect(await createKey(idle, publishable)).toEqual({
        status: "failed",
        code: "VALIDATION_FAILED",
        fieldErrors: {},
        message: API_KEYS_STRINGS.formExpired,
      });
    }
  });

  it("checks the name and the origins before any call, at their rows", async () => {
    await openPage();
    fireEvent.click(inCreate(API_KEYS_STRINGS.kindPublishable));
    const origins = within(createSection()).getByRole("group", { name: API_KEYS_STRINGS.originsLegend });
    const rows = [
      "https://*.acme-travel.example.com",
      "http://www.acme-travel.example.com",
      "https://Acme-Travel.example.com",
      "https://www.acme-travel.example.com/",
      "https://ok.acme-travel.example.com",
      "https://ok.acme-travel.example.com",
    ];
    rows
      .slice(1)
      .forEach(() =>
        fireEvent.click(within(origins).getByRole("button", { name: API_KEYS_STRINGS.addOrigin })),
      );
    rows.forEach((origin, index) =>
      type(within(origins).getByLabelText(API_KEYS_STRINGS.originLabel(index + 1)), origin),
    );
    submitCreate();

    const errorOf = (position: number): string[] =>
      descriptionsOf(within(origins).getByLabelText(API_KEYS_STRINGS.originLabel(position)));
    await waitFor(() => expect(errorOf(1)).toContain(API_KEYS_STRINGS.originWildcard), ACTION_WAIT);
    expect(errorOf(2)).toContain(API_KEYS_STRINGS.originInsecure("test"));
    expect(errorOf(3)).toContain(API_KEYS_STRINGS.originNotCanonical);
    expect(errorOf(4)).toContain(API_KEYS_STRINGS.originInvalid);
    expect(errorOf(5)).toEqual([]);
    expect(errorOf(6)).toContain(API_KEYS_STRINGS.originDuplicate);
    expect(descriptionsOf(inCreate(API_KEYS_STRINGS.nameLabel))).toContain(API_KEYS_STRINGS.nameRequired);
    expect(calls("POST", KEYS_PATH)).toHaveLength(0);

    // At most 20 origins: the 21st cannot be added.
    for (let index = rows.length; index < MAX_ALLOWED_ORIGINS; index += 1) {
      fireEvent.click(within(origins).getByRole("button", { name: API_KEYS_STRINGS.addOrigin }));
    }
    expect(
      (within(origins).getByRole("button", { name: API_KEYS_STRINGS.addOrigin }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // "Remove" takes a row out.
    fireEvent.click(
      within(origins).getByRole("button", {
        name: `${API_KEYS_STRINGS.removeOrigin}${API_KEYS_STRINGS.removeOriginTarget(20)}`,
      }),
    );
    expect(within(origins).queryByLabelText(API_KEYS_STRINGS.originLabel(20))).toBeNull();
  });

  it("checks origins as PADR-0005 item 5 says, with http only for loopback test keys", () => {
    expect(originProblem("https://www.acme-travel.example.com", "live")).toBeUndefined();
    expect(originProblem("https://www.acme-travel.example.com:8443", "live")).toBeUndefined();
    expect(originProblem("http://localhost:5173", "test")).toBeUndefined();
    expect(originProblem("http://127.0.0.1:8080", "test")).toBeUndefined();
    expect(originProblem("http://localhost:5173", "live")).toBe("insecureOrigin");
    expect(originProblem("http://localhost", "test")).toBe("insecureOrigin");
    expect(originProblem("http://www.acme-travel.example.com", "test")).toBe("insecureOrigin");
    expect(originProblem("ftp://www.acme-travel.example.com", "test")).toBe("insecureOrigin");
    expect(originProblem("https://*.acme-travel.example.com", "test")).toBe("wildcard");
    expect(originProblem("https://www.acme-travel.example.com:443", "test")).toBe("notCanonical");
    expect(originProblem("https://WWW.acme-travel.example.com", "test")).toBe("notCanonical");
    expect(originProblem("https://www.acme-travel.example.com/book", "test")).toBe("origin");
    expect(originProblem("https://user@www.acme-travel.example.com", "test")).toBe("origin");
    expect(originProblem("https://www.acme-travel.example.com?x=1", "test")).toBe("origin");
    expect(originProblem("www.acme-travel.example.com", "test")).toBe("origin");
  });

  it("names the limit and the keys in use when the plan's limit is reached", async () => {
    routes({
      [`POST ${KEYS_PATH}`]: () => apiError("PLAN_LIMIT_REACHED", 422, { details: { limit: 5, used: 5 } }),
    });
    await openPage();
    type(inCreate(API_KEYS_STRINGS.nameLabel), "One too many");
    submitCreate();
    await waitFor(
      () => expect(screen.getByRole("alert").textContent).toContain(API_KEYS_STRINGS.planLimit(5, 5)),
      ACTION_WAIT,
    );
    expect(API_KEYS_STRINGS.planLimit(5, 5)).toContain("5 working API keys");
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("asks for a step-up when the API wants one, and sends the same form again after it", async () => {
    let first = true;
    routes({
      [`POST ${KEYS_PATH}`]: (request) => {
        if (first) {
          first = false;
          return apiError("REAUTH_REQUIRED", 401);
        }
        return created(request);
      },
      "POST /v1/auth/step-up": () =>
        json(
          {
            accessToken: "pfe011-dummy-stepped-up-access-token",
            accessTokenExpiresAt: at(15 * MINUTE_MS),
            refreshToken: "pfe011-dummy-stepped-up-refresh-token",
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
        ),
    });
    await openPage();
    type(inCreate(API_KEYS_STRINGS.nameLabel), "Needs a step-up");
    submitCreate();

    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    fireEvent.change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), {
      target: { value: "492039" },
    });
    submit(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.submit }));

    await createdPanel();
    const [refused, repeated] = calls("POST", KEYS_PATH);
    expect(await bodyOf(repeated)).toEqual(await bodyOf(refused));
    expect(calls("POST", "/v1/auth/step-up")).toHaveLength(1);
  });

  it("refuses a form without its OTA or environment, and sends an ended session to sign-in and back", async () => {
    const idle: CreateKeyState = { status: "idle", fieldErrors: {} };
    expect(await createKey(idle, formData({ tenantId: "ten_bad", environment: "test", name: "x" }))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      fieldErrors: {},
      message: API_KEYS_STRINGS.formExpired,
    });
    expect(
      (await createKey(idle, formData({ tenantId: TENANT_ID, environment: "staging", name: "x" }))).message,
    ).toBe(API_KEYS_STRINGS.formExpired);
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`POST ${KEYS_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(
      createKey(
        idle,
        formData({
          tenantId: TENANT_ID,
          environment: "test",
          name: "x",
          kind: "secret",
          scope: "storefront",
        }),
      ),
    ).rejects.toThrow(`NEXT_REDIRECT /sign-in?next=${encodeURIComponent(PAGE_PATH)}`);
  });
});

// ---- Editing, rolling and revoking ----------------------------------------------------------------------------------

describe("/otas/[tenantId]/api-keys: editing, rolling and revoking", () => {
  it("edits the name and the origins of a publishable key", async () => {
    routes({
      [`PATCH ${KEYS_PATH}/key_01JA2ZD8E2G6J0K4N8Q2S6W0Y4`]: async (request) =>
        json({ ...listed()[2], ...((await request.clone().json()) as object) }, 200),
    });
    await openPage();
    fireEvent.click(
      within(rowOf(PUBLISHABLE_MASKED)).getByRole("button", {
        name: `${API_KEYS_STRINGS.edit}${API_KEYS_STRINGS.actionTarget("Website", PUBLISHABLE_MASKED)}`,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: API_KEYS_STRINGS.editTitle("Website") });
    // The form starts from the key as listed.
    expect((within(dialog).getByLabelText(API_KEYS_STRINGS.originLabel(2)) as HTMLInputElement).value).toBe(
      "http://localhost:5173",
    );
    type(within(dialog).getByLabelText(API_KEYS_STRINGS.nameLabel), "Website (new)");
    fireEvent.click(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.addOrigin }));
    type(
      within(dialog).getByLabelText(API_KEYS_STRINGS.originLabel(3)),
      "https://book.acme-travel.example.com",
    );
    submit(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.editSubmit }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), ACTION_WAIT);
    expect(within(rowOf(PUBLISHABLE_MASKED)).getByText(API_KEYS_STRINGS.saved)).toBeTruthy();
    const [patch, ...more] = calls("PATCH", `${KEYS_PATH}/key_01JA2ZD8E2G6J0K4N8Q2S6W0Y4`);
    expect(more).toHaveLength(0);
    expectSessionHeaders(patch);
    expect(await bodyOf(patch)).toEqual({
      name: "Website (new)",
      allowedOrigins: [
        "https://www.acme-travel.example.com",
        "http://localhost:5173",
        "https://book.acme-travel.example.com",
      ],
    });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);
  });

  it("renames a secret key without origins, and shows refusals in the dialog", async () => {
    let answer: () => Response = () => apiError("CONFLICT", 409, { details: { reason: "revoked" } });
    routes({ [`PATCH ${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8`]: () => answer() });
    await openPage();
    fireEvent.click(
      within(rowOf(SECRET_MASKED)).getByRole("button", {
        name: `${API_KEYS_STRINGS.edit}${API_KEYS_STRINGS.actionTarget("Storefront production", SECRET_MASKED)}`,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: API_KEYS_STRINGS.editTitle("Storefront production"),
    });
    // A secret key has no origins to edit.
    expect(within(dialog).queryByRole("group", { name: API_KEYS_STRINGS.originsLegend })).toBeNull();
    type(within(dialog).getByLabelText(API_KEYS_STRINGS.nameLabel), "Storefront prod");
    submit(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.editSubmit }));
    await waitFor(
      () =>
        expect(within(dialog).getByRole("alert").textContent).toContain(API_KEYS_STRINGS.revokedMeanwhile),
      ACTION_WAIT,
    );
    expect(await bodyOf(calls("PATCH", `${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8`)[0])).toEqual({
      name: "Storefront prod",
    });

    answer = () => json(apiKey({ name: "Storefront prod" }), 200);
    submit(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.editSubmit }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), ACTION_WAIT);
  });

  it("[PFE-011 AC3] roll shows the new key once and when the old key stops working [PF-30 AC4]", async () => {
    const oldExpiry = at(24 * HOUR_MS);
    routes({
      [`POST ${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8/roll`]: () =>
        json(
          {
            apiKey: apiKey({
              id: ROLLED_KEY_ID,
              prefix: ROLLED_KEY.slice(0, 14),
              last4: ROLLED_KEY.slice(-4),
              createdAt: at(0),
              lastUsedAt: null,
            }),
            key: ROLLED_KEY,
            previous: { id: "key_01JB3KA2C6E0G4J8M2P6S0V4X8", expiresAt: oldExpiry },
          },
          201,
          { "cache-control": "no-store" },
        ),
    });
    await openPage();
    fireEvent.click(
      within(rowOf(SECRET_MASKED)).getByRole("button", {
        name: `${API_KEYS_STRINGS.roll}${API_KEYS_STRINGS.actionTarget("Storefront production", SECRET_MASKED)}`,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: API_KEYS_STRINGS.rollTitle("Storefront production"),
    });
    // The four delays of PADR-0005 item 8; 24 hours is preselected.
    const options = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(options.map((option) => option.value)).toEqual(["now", "1h", "24h", "7d"]);
    expect(options.find((option) => option.checked)?.value).toBe("24h");
    fireEvent.click(within(dialog).getByLabelText(ROLL_EXPIRY_LABELS["1h"]));
    fireEvent.click(within(dialog).getByLabelText(ROLL_EXPIRY_LABELS["24h"]));
    submit(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.rollSubmit }));

    const panel = await screen.findByRole(
      "region",
      { name: API_KEYS_STRINGS.rolledTitle("Storefront production") },
      ACTION_WAIT,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      (within(panel).getByLabelText(API_KEYS_STRINGS.rolledKeyLabel("secret")) as HTMLInputElement).value,
    ).toBe(ROLLED_KEY);
    expect(panel.textContent).toContain(SECRET_STRINGS.warningTitle);
    // The old key's expiry, from the API's answer.
    const expiry = panel.querySelector('[data-field="previousExpiry"]');
    expect(expiry?.textContent).toBe(
      `${API_KEYS_STRINGS.oldKeyWorksUntil(SECRET_MASKED)}${formatDateTime(oldExpiry) ?? ""}. ${API_KEYS_STRINGS.oldKeySwitch}`,
    );
    expect(expiry?.querySelector("time")?.getAttribute("datetime")).toBe(oldExpiry);
    const [roll, ...more] = calls("POST", `${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8/roll`);
    expect(more).toHaveLength(0);
    expectSessionHeaders(roll);
    expect(await bodyOf(roll)).toEqual({ expireOldIn: "24h" });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);

    // After the reload the list shows both keys and the old key's expiry; the new key itself is gone.
    routes({
      [`GET ${KEYS_PATH}`]: () =>
        json(
          {
            data: [
              apiKey({
                id: ROLLED_KEY_ID,
                prefix: ROLLED_KEY.slice(0, 14),
                last4: ROLLED_KEY.slice(-4),
                lastUsedAt: null,
              }),
              apiKey({ expiresAt: oldExpiry }),
            ],
          },
          200,
        ),
    });
    await reload();
    expect(cellsOf(rowOf(SECRET_MASKED))[API_KEYS_STRINGS.columnExpires]).toBe(formatDateTime(oldExpiry));
    expect(cellsOf(rowOf("sk_test_Rl22Nw…Rl66"))[API_KEYS_STRINGS.columnName]).toBe("Storefront production");
    expect(document.body.innerHTML).not.toContain(ROLLED_KEY);
  });

  it('[PFE-011 AC3] a roll with "now" says the old key stopped, and "I have stored it" drops the new key', async () => {
    const stoppedAt = at(0);
    routes({
      [`POST ${KEYS_PATH}/key_01JA2ZD8E2G6J0K4N8Q2S6W0Y4/roll`]: () =>
        json(
          {
            apiKey: listed()[2],
            key: NEW_PUBLISHABLE_KEY,
            previous: { id: "key_01JA2ZD8E2G6J0K4N8Q2S6W0Y4", expiresAt: stoppedAt },
          },
          201,
        ),
    });
    await openPage();
    fireEvent.click(
      within(rowOf(PUBLISHABLE_MASKED)).getByRole("button", {
        name: `${API_KEYS_STRINGS.roll}${API_KEYS_STRINGS.actionTarget("Website", PUBLISHABLE_MASKED)}`,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: API_KEYS_STRINGS.rollTitle("Website") });
    fireEvent.click(within(dialog).getByLabelText(ROLL_EXPIRY_LABELS.now));
    submit(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.rollSubmit }));

    const panel = await screen.findByRole(
      "region",
      { name: API_KEYS_STRINGS.rolledTitle("Website") },
      ACTION_WAIT,
    );
    expect(panel.querySelector('[data-field="previousExpiry"]')?.textContent).toBe(
      `${API_KEYS_STRINGS.oldKeyStopped(PUBLISHABLE_MASKED)}${formatDateTime(stoppedAt) ?? ""}.`,
    );
    expect(await bodyOf(calls("POST", `${KEYS_PATH}/key_01JA2ZD8E2G6J0K4N8Q2S6W0Y4/roll`)[0])).toEqual({
      expireOldIn: "now",
    });
    fireEvent.click(within(panel).getByRole("button", { name: SECRET_STRINGS.dismiss }));
    expect(screen.getByText(SECRET_STRINGS.dismissed)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(NEW_PUBLISHABLE_KEY);
  });

  it("[PFE-011 AC3] a roll of a key that had expired says the old key stopped working at its own expiry", async () => {
    // The API never moves an expiry later: the old key keeps the expiry that had already passed.
    const expiredAt = at(-HOUR_MS);
    routes({
      [`POST ${KEYS_PATH}/key_01JB3KD1G5J9M3P7S1V5Y9B3D7/roll`]: () =>
        json(
          {
            apiKey: apiKey({
              id: ROLLED_KEY_ID,
              name: "Old storefront",
              prefix: ROLLED_KEY.slice(0, 14),
              last4: ROLLED_KEY.slice(-4),
              createdAt: at(0),
              lastUsedAt: null,
            }),
            key: ROLLED_KEY,
            previous: { id: "key_01JB3KD1G5J9M3P7S1V5Y9B3D7", expiresAt: expiredAt },
          },
          201,
        ),
    });
    await openPage();
    fireEvent.click(
      within(rowOf("sk_test_Ex99Pq…Zz12")).getByRole("button", {
        name: `${API_KEYS_STRINGS.roll}${API_KEYS_STRINGS.actionTarget("Old storefront", "sk_test_Ex99Pq…Zz12")}`,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: API_KEYS_STRINGS.rollTitle("Old storefront") });
    // The preselected 24 hours.
    submit(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.rollSubmit }));

    const panel = await screen.findByRole(
      "region",
      { name: API_KEYS_STRINGS.rolledTitle("Old storefront") },
      ACTION_WAIT,
    );
    expect(await bodyOf(calls("POST", `${KEYS_PATH}/key_01JB3KD1G5J9M3P7S1V5Y9B3D7/roll`)[0])).toEqual({
      expireOldIn: "24h",
    });
    expect(panel.querySelector('[data-field="previousExpiry"]')?.textContent).toBe(
      `${API_KEYS_STRINGS.oldKeyStopped("sk_test_Ex99Pq…Zz12")}${formatDateTime(expiredAt) ?? ""}.`,
    );
  });

  it("keeps a refused roll's message in the dialog, without a key", async () => {
    routes({
      [`POST ${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8/roll`]: () =>
        apiError("PLAN_LIMIT_REACHED", 422, { details: { limit: 2, used: 2 } }),
    });
    await openPage();
    fireEvent.click(
      within(rowOf(SECRET_MASKED)).getByRole("button", {
        name: `${API_KEYS_STRINGS.roll}${API_KEYS_STRINGS.actionTarget("Storefront production", SECRET_MASKED)}`,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: API_KEYS_STRINGS.rollTitle("Storefront production"),
    });
    submit(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.rollSubmit }));
    await waitFor(
      () =>
        expect(within(dialog).getByRole("alert").textContent).toContain(API_KEYS_STRINGS.rollPlanLimit(2)),
      ACTION_WAIT,
    );
    expect(
      screen.queryByRole("region", { name: API_KEYS_STRINGS.rolledTitle("Storefront production") }),
    ).toBeNull();
  });

  it("revokes a key only after the confirmation", async () => {
    routes({
      [`POST ${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8/revoke`]: () =>
        json(apiKey({ revokedAt: at(0) }), 200),
    });
    await openPage();
    const revoke = (): HTMLElement =>
      within(rowOf(SECRET_MASKED)).getByRole("button", {
        name: `${API_KEYS_STRINGS.revoke}${API_KEYS_STRINGS.actionTarget("Storefront production", SECRET_MASKED)}`,
      });

    fireEvent.click(revoke());
    const cancelled = await screen.findByRole("alertdialog", {
      name: API_KEYS_STRINGS.revokeTitle("Storefront production"),
    });
    expect(cancelled.textContent).toContain(API_KEYS_STRINGS.revokeDescription(SECRET_MASKED));
    fireEvent.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls("POST", `${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8/revoke`)).toHaveLength(0);

    fireEvent.click(revoke());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: API_KEYS_STRINGS.revokeConfirm }));
    await waitFor(
      () => expect(within(rowOf(SECRET_MASKED)).getByText(API_KEYS_STRINGS.revoked)).toBeTruthy(),
      ACTION_WAIT,
    );
    const [call, ...more] = calls("POST", `${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8/revoke`);
    expect(more).toHaveLength(0);
    expectSessionHeaders(call);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);
    // Until the list is renewed, the key's actions are locked.
    for (const button of within(rowOf(SECRET_MASKED)).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("shows why a revoke was refused", async () => {
    routes({
      [`POST ${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8/revoke`]: () =>
        apiError("TENANT_NOT_ACTIVE", 409, { details: { status: "suspended" } }),
    });
    await openPage();
    fireEvent.click(
      within(rowOf(SECRET_MASKED)).getByRole("button", {
        name: `${API_KEYS_STRINGS.revoke}${API_KEYS_STRINGS.actionTarget("Storefront production", SECRET_MASKED)}`,
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: API_KEYS_STRINGS.revokeConfirm,
      }),
    );
    await waitFor(
      () =>
        expect(within(rowOf(SECRET_MASKED)).getByRole("alert").textContent).toBe(API_KEYS_STRINGS.notActive),
      ACTION_WAIT,
    );
  });

  it("refuses a key action without a valid OTA or key id without a call, and ends a session at sign-in", async () => {
    const bad = formData({ tenantId: TENANT_ID, keyId: "key_lowercase", expireOldIn: "now" });
    expect((await updateKey({ status: "idle", fieldErrors: {} }, bad)).message).toBe(
      API_KEYS_STRINGS.formExpired,
    );
    expect((await rollKey({ status: "idle" }, bad)).message).toBe(API_KEYS_STRINGS.formExpired);
    expect((await revokeKey({ status: "idle" }, bad)).message).toBe(API_KEYS_STRINGS.formExpired);
    // A roll needs one of the four delays.
    expect(
      (
        await rollKey(
          { status: "idle" },
          formData({ tenantId: TENANT_ID, keyId: "key_01JB3KA2C6E0G4J8M2P6S0V4X8", expireOldIn: "2d" }),
        )
      ).message,
    ).toBe(API_KEYS_STRINGS.formExpired);
    expect(fetchMock).not.toHaveBeenCalled();

    routes({
      [`POST ${KEYS_PATH}/key_01JB3KA2C6E0G4J8M2P6S0V4X8/revoke`]: () => apiError("UNAUTHENTICATED", 401),
    });
    await expect(
      revokeKey(
        { status: "idle" },
        formData({ tenantId: TENANT_ID, keyId: "key_01JB3KA2C6E0G4J8M2P6S0V4X8" }),
      ),
    ).rejects.toThrow(`NEXT_REDIRECT /sign-in?next=${encodeURIComponent(PAGE_PATH)}`);
  });
});

// ---- The OTA contract's values ---------------------------------------------------------------------------------------

describe("ScopePicker values", () => {
  it("are the ConsoleApiKeyScope and StaffPermission values of the OTA document, in its order", () => {
    expect([...CONSOLE_API_KEY_SCOPES]).toEqual(otaEnum("ConsoleApiKeyScope"));
    expect([...STAFF_PERMISSIONS]).toEqual(otaEnum("StaffPermission"));
  });
});
