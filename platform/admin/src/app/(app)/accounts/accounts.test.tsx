// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The backend's own lists of audit actions and target kinds (PADR-0006 Audit item 6): the admin's filter must offer
// the same names, so the copies in audit-filters.ts are compared with them.
import {
  AUDIT_ACTIONS as BACKEND_AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES as BACKEND_AUDIT_TARGET_TYPES,
} from "../../../../../backend/src/audit/audit-actions";

// ---- Mocks: the request scope, navigation and cache of Next.js and the configuration; the real API client talks ----
// ---- to a mocked fetch, so the tests see the query and the body of every call the pages, actions and route send ----

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

import { AccountActions } from "@/app/(app)/accounts/[accountId]/account-actions";
import {
  disableAccount,
  enableAccount,
  resetAccountMfa,
  unlockAccount,
  type AccountActionState,
} from "@/app/(app)/accounts/[accountId]/actions";
import AccountPage from "@/app/(app)/accounts/[accountId]/page";
import { AccountTable } from "@/app/(app)/accounts/account-table";
import AccountsPage from "@/app/(app)/accounts/page";
import { grantAdmin, revokeAdmin, type AdminActionState } from "@/app/(app)/admins/actions";
import { AdminList } from "@/app/(app)/admins/admin-list";
import AdminsPage from "@/app/(app)/admins/page";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "@/app/(app)/audit/audit-filters";
import { AuditTable } from "@/app/(app)/audit/audit-table";
import { GET as exportCsv, HEAD as exportCsvHead } from "@/app/(app)/audit/export.csv/route";
import AuditPage from "@/app/(app)/audit/page";
import { FilterBar } from "@/components/filter-bar";
import * as tableComponents from "@/components/ui/table";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "@/lib/session";
import {
  ACCOUNT_ACTION_STRINGS,
  ACCOUNT_DETAIL_STRINGS,
  ACCOUNT_LIST_STRINGS,
  ADMIN_LIST_STRINGS,
  AUDIT_STRINGS,
  ERROR_MESSAGES,
  REASON_STRINGS,
  STATUS_LABELS,
  STEP_UP_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) ---------------------------------------------------

type Schemas = components["schemas"];
type AdminAccount = Schemas["AdminAccount"];
type AdminAccountDetail = Schemas["AdminAccountDetail"];
type AuditEntry = Schemas["AuditEntry"];
type PlatformAdmin = Schemas["PlatformAdmin"];

const ACCESS_TOKEN = "pad009-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-009 test)";
/** The signed-in admin. */
const SELF_ID = "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9";
const OTHER_ADMIN_ID = "acc_01JB0F5G9J3M7Q1T5W9Z3C7F1H";
/** The account of the support case. */
const ACCOUNT_ID = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const REASON = "Identity confirmed on a video call with the passport (SUP-431).";
const TOTP_CODE = "492039";
const ACCOUNT_PATH = `/v1/admin/accounts/${ACCOUNT_ID}`;

/**
 * The budget of the warm-up hook: the first render of these pages in a fresh worker loads the module graph of the
 * tables, the filter bar and the dialogs, and the first dialog and server action run React's action queue for the
 * first time. On a loaded runner that takes seconds; the hook only stops one that hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * How long a step that runs a server action (a round trip through the real `lib/api.ts`) and re-renders the forms
 * may take. Testing Library's 1 s default is enough on an idle machine, not on a loaded CI runner; each test's own
 * 5 s budget is unchanged.
 */
const UI_WAIT = { timeout: 3_000 } as const;

function account(overrides: Partial<AdminAccount> = {}): AdminAccount {
  return {
    id: ACCOUNT_ID,
    email: "anna.berg@example.com",
    emailVerified: true,
    fullName: "Anna Berg",
    locale: "en",
    timeZone: "Europe/Oslo",
    status: "active",
    mfaEnabled: true,
    mfaEnabledAt: "2026-10-03T09:12:44Z",
    isPlatformAdmin: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: "2026-10-21T07:58:12Z",
    createdAt: "2026-10-01T10:02:17Z",
    version: 3,
    ...overrides,
  };
}

function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "1042",
    tenantId: TENANT_ID,
    tenantKey: "acme",
    actorType: "account",
    actorAccountId: ACCOUNT_ID,
    actorLabel: "anna.berg@example.com",
    action: "invitation.created",
    targetType: "invitation",
    targetId: "ivt_01JA2ZF4H8K2M6P0R4T8W2Y6A0",
    requestId: "req_01JA2ZF4H8K2M6P0R4T8W2Y6A1",
    ipAddress: "198.51.100.23",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15",
    details: { email: "jo@acme-travel.example.com", role: "agent" },
    createdAt: "2026-10-14T09:00:00Z",
    ...overrides,
  };
}

/** A row about the account written by an admin: a lockout cleared. */
function adminAuditEntry(): AuditEntry {
  return auditEntry({
    id: "1187",
    tenantId: null,
    tenantKey: null,
    actorType: "platform_admin",
    actorAccountId: SELF_ID,
    actorLabel: "lena.holm@velexis.example.com",
    action: "account.unlocked",
    targetType: "account",
    targetId: ACCOUNT_ID,
    details: { before: { failedLoginCount: 5 }, after: { failedLoginCount: 0 } },
    createdAt: "2026-10-20T07:33:05Z",
  });
}

function detail(accountOverrides: Partial<AdminAccount> = {}): AdminAccountDetail {
  return {
    account: account(accountOverrides),
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
    activeSessions: 2,
    recentAudit: [adminAuditEntry(), auditEntry()],
  };
}

function me(): Schemas["AdminMe"] {
  return {
    id: SELF_ID,
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
  };
}

function platformAdmin(overrides: Partial<PlatformAdmin> = {}): PlatformAdmin {
  return {
    accountId: OTHER_ADMIN_ID,
    email: "jonas.dahl@velexis.example.com",
    fullName: "Jonas Dahl",
    mfaEnabled: true,
    lastLoginAt: "2026-10-20T08:02:19Z",
    ...overrides,
  };
}

/** The admins by name: Jonas Dahl, then the signed-in Lena Holm. */
function admins(): PlatformAdmin[] {
  return [
    platformAdmin(),
    platformAdmin({
      accountId: SELF_ID,
      email: "lena.holm@velexis.example.com",
      fullName: "Lena Holm",
      lastLoginAt: "2026-10-21T07:41:03Z",
    }),
  ];
}

function accountSummaries(): Schemas["AdminAccountSummary"][] {
  return [
    {
      id: ACCOUNT_ID,
      email: "anna.berg@example.com",
      fullName: "Anna Berg",
      status: "active",
      mfaEnabled: true,
      isPlatformAdmin: false,
      lastLoginAt: "2026-10-21T07:58:12Z",
      createdAt: "2026-10-01T10:02:17Z",
    },
    {
      id: "acc_01JB3K2H6K0N4Q8S2V6X0Z4B8D",
      email: "mikael.lind@nordic-fares.example.com",
      fullName: "Mikael Lind",
      status: "disabled",
      mfaEnabled: false,
      isPlatformAdmin: false,
      lastLoginAt: null,
      createdAt: "2026-10-16T13:35:02Z",
    },
  ];
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
  details?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pad009",
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
    headers,
  );
}

/** The session `adminStepUp` answers. */
function steppedUpSession(): Response {
  return json(
    {
      accessToken: "pad009-stepped-up-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshToken: "pad009-stepped-up-refresh-token",
      refreshTokenExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      admin: me(),
    },
    200,
  );
}

/** The account list as the API answers it, filtered by `status` and `q` (part of the e-mail address or name). */
function listAccounts(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const q = query.get("q")?.toLowerCase();
  const data = accountSummaries().filter(
    (row) =>
      (query.get("status") === null || row.status === query.get("status")) &&
      (q === undefined || row.email.includes(q) || row.fullName.toLowerCase().includes(q)),
  );
  return json({ data, page: { nextCursor: null, limit: 50 } }, 200);
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call by `METHOD /path`; unexpected calls fail the test. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    "GET /v1/admin/me": () => json(me(), 200),
    "GET /v1/admin/accounts": listAccounts,
    [`GET ${ACCOUNT_PATH}`]: () => json(detail(), 200),
    "GET /v1/admin/admins": () => json({ data: admins() }, 200),
    "GET /v1/admin/audit-log": () =>
      json({ data: [adminAuditEntry(), auditEntry()], page: { nextCursor: null, limit: 50 } }, 200),
    "POST /v1/admin/auth/step-up": steppedUpSession,
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
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pad009_admin",
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

async function openAccounts(search = ""): Promise<void> {
  setUrl("/accounts", search);
  render(await AccountsPage({ searchParams: searchParamsOf(search) }));
}

async function accountPage(accountId: string): Promise<ReactElement> {
  return AccountPage({ params: Promise.resolve({ accountId }) });
}

/** Renders `/accounts/<id>`; `rerender` renders it again as Next.js does after an action revalidated it. */
async function openAccount(accountId: string = ACCOUNT_ID): Promise<{ rerender: () => Promise<void> }> {
  setUrl(`/accounts/${accountId}`);
  const view = render(await accountPage(accountId));
  return {
    rerender: async () => {
      view.rerender(await accountPage(accountId));
    },
  };
}

/** Renders `/admins`; `rerender` renders it again as Next.js does after an action revalidated it. */
async function openAdmins(): Promise<{ rerender: () => Promise<void> }> {
  setUrl("/admins");
  const view = render(await AdminsPage());
  return {
    rerender: async () => {
      view.rerender(await AdminsPage());
    },
  };
}

async function auditPage(search: string): Promise<ReactElement> {
  return AuditPage({ searchParams: searchParamsOf(search) });
}

async function openAudit(search = ""): Promise<void> {
  setUrl("/audit", search);
  render(await auditPage(search));
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

/** The actions section of the account page. */
function actionsSection(): HTMLElement {
  return screen.getByRole("region", { name: ACCOUNT_ACTION_STRINGS.sectionTitle });
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

/** Answers the step-up dialog with a code and waits until every dialog is closed. */
async function answerStepUp(): Promise<void> {
  const stepUp = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
  fireEvent.change(within(stepUp).getByLabelText(STEP_UP_STRINGS.codeLabel), {
    target: { value: TOTP_CODE },
  });
  submit(STEP_UP_STRINGS.submit, stepUp);
  // The modal dialog hides the rest of the page from the accessibility tree until it closes.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** The client components these pages render: Next.js sends their props, not their output, to the browser. */
const CLIENT_COMPONENTS: ReadonlySet<unknown> = new Set<unknown>([
  AccountTable,
  AccountActions,
  AdminList,
  AuditTable,
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
      type:
        typeof type === "string"
          ? type
          : type === Link
            ? "next/link"
            : CLIENT_COMPONENTS.has(type)
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

/** Every element of a payload whose `props` satisfy `match`. */
function payloadElements(
  payload: unknown,
  match: (props: Record<string, unknown>) => boolean,
): { type: unknown; props: Record<string, unknown> }[] {
  const found: { type: unknown; props: Record<string, unknown> }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value !== null && typeof value === "object") {
      const node = value as { type?: unknown; props?: unknown };
      if (node.props !== null && typeof node.props === "object" && "type" in node) {
        const props = node.props as Record<string, unknown>;
        if (match(props)) {
          found.push({ type: node.type, props });
        }
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(payload);
  return found;
}

// ---- The platform document ---------------------------------------------------------------------------------------

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
  const lines = platformDocument;
  const start = lines.findIndex((line) => line.trim() === `operationId: ${operationId}`);
  expect(start).toBeGreaterThan(-1);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // The next operation of the path, or the next path.
    if (/^\s+operationId:/.test(line) || /^ {2}\//.test(line)) {
      break;
    }
    block.push(line.trim());
  }
  return { reason: block.includes("x-reason-required: true"), stepUp: block.includes("x-mfa-step-up: true") };
}

/**
 * Once per file, before any test: the first render of these pages in a fresh worker (the tables, the filter bar,
 * the dialogs) and the first server action through the real API client are the slowest steps, and on a busy CI
 * runner they would otherwise land in the first test's own five seconds. Nothing of it stays: each test gets a fresh
 * API and an empty document.
 */
beforeAll(async () => {
  platformDocument = readFileSync(
    join(repositoryRoot(), "platform/backend/openapi/velexis-platform-api.openapi.yaml"),
    "utf8",
  ).split("\n");
  resetPlatformApi();
  routes({
    [`POST ${ACCOUNT_PATH}/disable`]: () => apiError("FORBIDDEN", 403, { reason: "last_admin" }),
  });
  await openAccounts("status=active");
  cleanup();
  await openAccount();
  fireEvent.click(within(actionsSection()).getByRole("button", { name: ACCOUNT_ACTION_STRINGS.disable }));
  const dialog = await screen.findByRole("dialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: REASON } });
  submit(ACCOUNT_ACTION_STRINGS.disableConfirm, dialog);
  await screen.findByText(ACCOUNT_ACTION_STRINGS.lastAdmin, {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openAdmins();
  fireEvent.click(screen.getByRole("button", { name: ADMIN_LIST_STRINGS.grant }));
  await screen.findByRole("dialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openAudit("from=2026-10-01&to=2026-10-31");
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The account search --------------------------------------------------------------------------------------------

describe("accounts/page.tsx: the account search", () => {
  it("searches with the filters of the URL and links each account to its support page", async () => {
    await openAccounts("q=berg&status=active");

    expect(queryOfCall("/v1/admin/accounts")).toEqual([
      ["q", "berg"],
      ["status", "active"],
    ]);
    expectSessionHeaders(calls("GET", "/v1/admin/accounts")[0]);
    const table = screen.getByRole("table", { name: ACCOUNT_LIST_STRINGS.caption });
    expect(hrefOf(link("Anna Berg", table))).toBe(`/accounts/${ACCOUNT_ID}`);
    expect(within(table).queryByText("Mikael Lind")).toBeNull();
    expect(
      (screen.getByRole("searchbox", { name: ACCOUNT_LIST_STRINGS.searchLabel }) as HTMLInputElement).value,
    ).toBe("berg");

    // Another status keeps the search and goes into the URL.
    fireEvent.change(screen.getByRole("combobox", { name: ACCOUNT_LIST_STRINGS.statusLabel }), {
      target: { value: "disabled" },
    });
    const [href] = navigation.router.push.mock.calls[0] as [string];
    expect(sortedQuery(new URL(href, "https://admin.invalid").search)).toEqual([
      ["q", "berg"],
      ["status", "disabled"],
    ]);
  });

  it("shows a notice for filters the API would refuse, and does not ask it for a list", async () => {
    for (const search of ["status=frozen", "status=active&status=locked", `q=${"a".repeat(255)}`]) {
      await openAccounts(search);
      expect(screen.getByText(ACCOUNT_LIST_STRINGS.invalidFilters)).toBeTruthy();
      expect(hrefOf(link(ACCOUNT_LIST_STRINGS.showAll))).toBe("/accounts");
      cleanup();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ "GET /v1/admin/accounts": () => apiError("VALIDATION_FAILED", 400) });
    await openAccounts("cursor=stale");
    expect(screen.getByText(ACCOUNT_LIST_STRINGS.invalidFilters)).toBeTruthy();
  });
});

// ---- The account page ----------------------------------------------------------------------------------------------

describe("accounts/[accountId]/page.tsx: one account for support", () => {
  it("shows the account, its sessions, memberships and recent audit with links to the full log", async () => {
    await openAccount();

    expect(screen.getByRole("heading", { level: 1, name: /Anna Berg/ })).toBeTruthy();
    const fields = screen.getByRole("region", { name: ACCOUNT_DETAIL_STRINGS.accountTitle });
    expect(within(fields).getByText(ACCOUNT_ID)).toBeTruthy();
    expect(within(fields).getByText("Europe/Oslo")).toBeTruthy();
    expect(within(fields).getByText(ACCOUNT_DETAIL_STRINGS.notLocked)).toBeTruthy();
    const sessions = screen.getByRole("region", { name: ACCOUNT_DETAIL_STRINGS.sessionsTitle });
    expect(within(sessions).getByText("2 active sessions")).toBeTruthy();
    const memberships = screen.getByRole("region", { name: ACCOUNT_DETAIL_STRINGS.membershipsTitle });
    expect(hrefOf(link("acme", memberships))).toBe(`/tenants/${TENANT_ID}`);
    expect(within(memberships).getByText("Owner")).toBeTruthy();

    const audit = screen.getByRole("region", { name: ACCOUNT_DETAIL_STRINGS.auditTitle });
    const details = within(audit).getByRole("region", { name: AUDIT_STRINGS.detailsOf("1187") });
    expect(JSON.parse(details.textContent ?? "")).toEqual({
      before: { failedLoginCount: 5 },
      after: { failedLoginCount: 0 },
    });
    expect(hrefOf(link("lena.holm@velexis.example.com", audit))).toBe(`/accounts/${SELF_ID}`);
    expect(hrefOf(link(ACCOUNT_DETAIL_STRINGS.actorAudit, audit))).toBe(
      `/audit?actorAccountId=${ACCOUNT_ID}`,
    );
    expect(hrefOf(link(ACCOUNT_DETAIL_STRINGS.targetAudit, audit))).toBe(
      `/audit?targetType=account&targetId=${ACCOUNT_ID}`,
    );
  });

  it("hands the actions only the account's id, name and the flags that decide what is offered", async () => {
    const payload = serverPayload(await accountPage(ACCOUNT_ID));
    const [actions, ...more] = payloadElements(payload, (props) => props["accountId"] === ACCOUNT_ID);
    expect(more).toHaveLength(0);
    expect(actions?.props).toEqual({
      accountId: ACCOUNT_ID,
      name: "Anna Berg",
      status: "active",
      mfaEnabled: true,
      isPlatformAdmin: false,
      locked: false,
      self: false,
    });
  });

  it("renders the not-found page for an unknown account, and for a value that is no account id without a call", async () => {
    for (const accountId of ["anna", "acc_01ja2z9w5k7q3m8n4p6r2t0v1x", `${ACCOUNT_ID}x`]) {
      await expect(accountPage(accountId)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`GET ${ACCOUNT_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await expect(accountPage(ACCOUNT_ID)).rejects.toThrow("NEXT_NOT_FOUND");
    routes({ [`GET ${ACCOUNT_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(accountPage(ACCOUNT_ID)).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });

  it("offers each action only in the states the API allows it", async () => {
    const offered = async (overrides: Partial<AdminAccount>, accountId = ACCOUNT_ID): Promise<string[]> => {
      routes({
        [`GET /v1/admin/accounts/${accountId}`]: () => json(detail({ ...overrides, id: accountId }), 200),
      });
      await openAccount(accountId);
      const names = within(actionsSection())
        .queryAllByRole("button")
        .map((button) => button.textContent ?? "");
      cleanup();
      return names;
    };

    expect(await offered({})).toEqual([S.disable, S.resetMfa]);
    expect(
      await offered({ status: "locked", failedLoginCount: 5, lockedUntil: "2026-10-21T08:15:00Z" }),
    ).toEqual([S.unlock, S.disable, S.resetMfa]);
    expect(await offered({ status: "disabled", mfaEnabled: false, mfaEnabledAt: null })).toEqual([S.enable]);
    expect(await offered({ status: "deleted" })).toEqual([]);
    // A platform admin's two-factor authentication is reset by revoking the rights first, or on the VM.
    expect(await offered({ isPlatformAdmin: true })).toEqual([S.disable]);

    // The admin's own account: no Disable, and no reset (an admin), each with its note.
    routes({
      [`GET /v1/admin/accounts/${SELF_ID}`]: () => json(detail({ id: SELF_ID, isPlatformAdmin: true }), 200),
    });
    await openAccount(SELF_ID);
    expect(within(actionsSection()).queryAllByRole("button")).toHaveLength(0);
    expect(within(actionsSection()).getByText(S.selfNote)).toBeTruthy();
    expect(within(actionsSection()).getByText(S.adminResetNote)).toBeTruthy();
  });
});

// ---- The account actions -------------------------------------------------------------------------------------------

interface ActionCase {
  readonly operationId: string;
  readonly path: string;
  readonly trigger: string;
  readonly title: string;
  readonly confirm: string;
  readonly done: string;
  /** The account in a state that offers the action, and after it. */
  readonly before: Partial<AdminAccount>;
  readonly after: Partial<AdminAccount>;
}

const S = ACCOUNT_ACTION_STRINGS;
const ACTION_CASES: readonly ActionCase[] = [
  {
    operationId: "adminUnlockAccount",
    path: `${ACCOUNT_PATH}/unlock`,
    trigger: S.unlock,
    title: S.unlockTitle("Anna Berg"),
    confirm: S.unlockConfirm,
    done: S.unlocked,
    before: { status: "locked", failedLoginCount: 5, lockedUntil: "2026-10-21T08:15:00Z" },
    after: { status: "active", failedLoginCount: 0, lockedUntil: null },
  },
  {
    operationId: "adminDisableAccount",
    path: `${ACCOUNT_PATH}/disable`,
    trigger: S.disable,
    title: S.disableTitle("Anna Berg"),
    confirm: S.disableConfirm,
    done: S.disabled,
    before: {},
    after: { status: "disabled" },
  },
  {
    operationId: "adminEnableAccount",
    path: `${ACCOUNT_PATH}/enable`,
    trigger: S.enable,
    title: S.enableTitle("Anna Berg"),
    confirm: S.enableConfirm,
    done: S.enabled,
    before: { status: "disabled" },
    after: { status: "active" },
  },
  {
    operationId: "adminResetAccountMfa",
    path: `${ACCOUNT_PATH}/reset-mfa`,
    trigger: S.resetMfa,
    title: S.resetMfaTitle("Anna Berg"),
    confirm: S.resetMfaConfirm,
    done: S.mfaReset,
    before: {},
    after: { mfaEnabled: false, mfaEnabledAt: null },
  },
];

describe("accounts/[accountId]/actions.ts: unlock, disable, enable and reset two-factor", () => {
  it("the contract: unlock needs nothing, disable and enable a reason, reset a reason and a step-up [PAD-009 AC1]", () => {
    expect(
      ACTION_CASES.map((action) => [action.operationId, operationRequirements(action.operationId)]),
    ).toEqual([
      ["adminUnlockAccount", { reason: false, stepUp: false }],
      ["adminDisableAccount", { reason: true, stepUp: false }],
      ["adminEnableAccount", { reason: true, stepUp: false }],
      ["adminResetAccountMfa", { reason: true, stepUp: true }],
    ]);
  });

  it.each(ACTION_CASES)(
    "$operationId asks for exactly the reason and the step-up the API requires [PAD-009 AC1]",
    async (action) => {
      const required = operationRequirements(action.operationId);
      let attempts = 0;
      let current = account(action.before);
      routes({
        [`GET ${ACCOUNT_PATH}`]: () => json({ ...detail(), account: current }, 200),
        // The API as the contract says: a step-up operation answers REAUTH_REQUIRED until the admin has stepped up.
        [`POST ${action.path}`]: () => {
          attempts += 1;
          if (required.stepUp && attempts === 1) {
            return apiError("REAUTH_REQUIRED", 401);
          }
          current = account({ ...action.before, ...action.after });
          return json(current, 200);
        },
      });
      const view = await openAccount();
      fireEvent.click(within(actionsSection()).getByRole("button", { name: action.trigger }));

      if (required.reason) {
        const dialog = await screen.findByRole("dialog", { name: action.title }, UI_WAIT);
        // The reason is mandatory: a short one is refused at the field and nothing is sent.
        fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: "spam" } });
        submit(action.confirm, dialog);
        expect(within(dialog).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
        expect(calls("POST", action.path)).toHaveLength(0);
        fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: REASON } });
        submit(action.confirm, dialog);
      } else {
        const dialog = await screen.findByRole("alertdialog", { name: action.title }, UI_WAIT);
        expect(within(dialog).queryByLabelText(REASON_STRINGS.label)).toBeNull();
        expect(within(dialog).queryByRole("textbox")).toBeNull();
        fireEvent.click(within(dialog).getByRole("button", { name: action.confirm }));
      }

      if (required.stepUp) {
        await answerStepUp();
        expect(await bodies("POST", "/v1/admin/auth/step-up")).toEqual([{ code: TOTP_CODE }]);
        expect(cookieStore.set.mock.calls.map(([name]) => name as string)).toEqual([
          ACCESS_TOKEN_COOKIE,
          REFRESH_TOKEN_COOKIE,
        ]);
      }
      const done = await notice("done", actionsSection());
      expect(within(done).getByText(action.done)).toBeTruthy();
      // No step-up was asked for where the API requires none.
      expect(screen.queryByRole("dialog", { name: STEP_UP_STRINGS.title })).toBeNull();
      expect(calls("POST", "/v1/admin/auth/step-up")).toHaveLength(required.stepUp ? 1 : 0);
      const body = required.reason ? { reason: REASON } : null;
      expect(await bodies("POST", action.path)).toEqual(required.stepUp ? [body, body] : [body]);
      expectSessionHeaders(calls("POST", action.path)[0]);
      expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/accounts/${ACCOUNT_ID}`);

      // The revalidated page shows the account as it is now.
      await view.rerender();
      const fields = screen.getByRole("region", { name: ACCOUNT_DETAIL_STRINGS.accountTitle });
      expect(within(fields).getByText(ACCOUNT_DETAIL_STRINGS.status).nextElementSibling?.textContent).toBe(
        STATUS_LABELS.account[current.status],
      );
    },
  );

  it("words the refusals of the API by their reason, never with the API's text", async () => {
    routes({
      [`POST ${ACCOUNT_PATH}/disable`]: () => apiError("FORBIDDEN", 403, { reason: "last_admin" }),
      [`POST ${ACCOUNT_PATH}/enable`]: () => apiError("CONFLICT", 409, { reason: "not_disabled" }),
      [`POST ${ACCOUNT_PATH}/reset-mfa`]: () => apiError("FORBIDDEN", 403, { reason: "platform_admin" }),
      [`POST ${ACCOUNT_PATH}/unlock`]: () =>
        apiError("RATE_LIMITED", 429, undefined, { "retry-after": "30" }),
    });
    const idle: AccountActionState = { status: "idle" };
    const reasoned = formData({ accountId: ACCOUNT_ID, reason: REASON });

    expect(await disableAccount(idle, reasoned)).toEqual({
      status: "failed",
      code: "FORBIDDEN",
      message: S.lastAdmin,
    });
    expect(await resetAccountMfa(idle, reasoned)).toMatchObject({
      code: "FORBIDDEN",
      message: S.platformAdmin,
    });
    expect(await unlockAccount(idle, formData({ accountId: ACCOUNT_ID }))).toMatchObject({
      code: "RATE_LIMITED",
      message: S.rateLimitedFor(30),
    });
    const refused = await enableAccount(idle, reasoned);
    expect(refused).toMatchObject({ code: "CONFLICT", message: S.notDisabled });
    expect(JSON.stringify(refused)).not.toContain("never shown");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("checks the form before calling the API, and sends an ended session to sign-in and back", async () => {
    const idle: AccountActionState = { status: "idle" };
    for (const [action, values, message] of [
      [disableAccount, { accountId: "acc_x", reason: REASON }, S.formExpired],
      [disableAccount, { accountId: ACCOUNT_ID, reason: "  abc  " }, REASON_STRINGS.tooShort],
      [resetAccountMfa, { accountId: ACCOUNT_ID }, REASON_STRINGS.required],
      [resetAccountMfa, { accountId: ACCOUNT_ID, reason: "x".repeat(501) }, REASON_STRINGS.tooLong],
      [unlockAccount, { accountId: TENANT_ID }, S.formExpired],
    ] as const) {
      expect(await action(idle, formData(values))).toEqual({
        status: "failed",
        code: "VALIDATION_FAILED",
        message,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`POST ${ACCOUNT_PATH}/unlock`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(unlockAccount(idle, formData({ accountId: ACCOUNT_ID }))).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: `/accounts/${ACCOUNT_ID}` }).toString()}`,
    );
  });
});

// ---- Platform admins -----------------------------------------------------------------------------------------------

describe("admins/page.tsx and admins/actions.ts: grant and revoke platform admin rights", () => {
  const A = ADMIN_LIST_STRINGS;

  /** The row of an admin in the list. */
  function row(accountId: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-admin="${accountId}"]`);
    if (element === null) {
      throw new Error(`no row of ${accountId}`);
    }
    return element;
  }

  it("does not offer to revoke oneself, and revokes another admin after the step-up [PAD-009 AC2]", async () => {
    let attempts = 0;
    let list = admins();
    routes({
      "GET /v1/admin/admins": () => json({ data: list }, 200),
      [`DELETE /v1/admin/admins/${OTHER_ADMIN_ID}`]: () => {
        attempts += 1;
        if (attempts === 1) {
          return apiError("REAUTH_REQUIRED", 401);
        }
        list = list.filter((admin) => admin.accountId !== OTHER_ADMIN_ID);
        return new Response(null, { status: 204 });
      },
    });
    const view = await openAdmins();

    // The admin's own row: marked, its button disabled with the reason, and no dialog behind it.
    const own = row(SELF_ID);
    expect(within(own).getByText(A.you)).toBeTruthy();
    const ownButton = within(own).getByRole("button", { name: `${A.revoke}${A.revokeSuffix("Lena Holm")}` });
    expect((ownButton as HTMLButtonElement).disabled).toBe(true);
    expect(ownButton.getAttribute("aria-describedby")).toBe(within(own).getByText(A.selfNote).id);
    fireEvent.click(ownButton);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Another admin: confirm, step up, and the same revocation goes again.
    const other = within(row(OTHER_ADMIN_ID)).getByRole("button", {
      name: `${A.revoke}${A.revokeSuffix("Jonas Dahl")}`,
    });
    expect((other as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(other);
    const dialog = await screen.findByRole("alertdialog", { name: A.revokeTitle("Jonas Dahl") }, UI_WAIT);
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: A.revokeConfirm }));
    await answerStepUp();
    const done = await notice("done");
    expect(done.textContent).toBe(A.revoked("Jonas Dahl"));
    const revocations = calls("DELETE", `/v1/admin/admins/${OTHER_ADMIN_ID}`);
    expect(revocations).toHaveLength(2);
    expect(revocations.map((request) => new URL(request.url).search)).toEqual(["", ""]);
    expectSessionHeaders(revocations[0]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/admins");
    expect(calls("DELETE", `/v1/admin/admins/${SELF_ID}`)).toHaveLength(0);

    // Now the last admin: still not revocable.
    await view.rerender();
    expect(document.querySelector(`[data-admin="${OTHER_ADMIN_ID}"]`)).toBeNull();
    expect((within(row(SELF_ID)).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables revoke for the last admin and hands the list only the fields it shows [PAD-009 AC2]", async () => {
    routes({ "GET /v1/admin/admins": () => json({ data: [admins()[1]] }, 200) });
    const payload = serverPayload(await AdminsPage());
    const [list] = payloadElements(payload, (props) => Array.isArray(props["admins"]));
    expect(list?.props["admins"]).toEqual([
      {
        accountId: SELF_ID,
        email: "lena.holm@velexis.example.com",
        fullName: "Lena Holm",
        mfaEnabled: true,
        lastLoginAt: "2026-10-21T07:41:03Z",
        revoke: "self",
      },
    ]);

    // A list whose only admin is someone else (the signed-in admin's rights were revoked meanwhile): the last admin.
    routes({
      "GET /v1/admin/admins": () => json({ data: [platformAdmin()] }, 200),
    });
    await openAdmins();
    const only = row(OTHER_ADMIN_ID);
    expect((within(only).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(within(only).getByText(A.lastAdminNote)).toBeTruthy();
  });

  it("grants admin rights by e-mail address with a reason, after the step-up", async () => {
    let attempts = 0;
    routes({
      "POST /v1/admin/admins": () => {
        attempts += 1;
        return attempts === 1
          ? apiError("REAUTH_REQUIRED", 401)
          : json(
              platformAdmin({
                accountId: ACCOUNT_ID,
                email: "anna.berg@example.com",
                fullName: "Anna Berg",
                lastLoginAt: null,
              }),
              201,
            );
      },
    });
    await openAdmins();
    fireEvent.click(screen.getByRole("button", { name: A.grant }));
    const dialog = await screen.findByRole("dialog", { name: A.grantTitle }, UI_WAIT);
    fireEvent.change(within(dialog).getByLabelText(A.emailLabel), {
      target: { value: " anna.berg@example.com " },
    });
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: REASON } });
    submit(A.grantConfirm, dialog);
    await answerStepUp();

    const done = await notice("done");
    expect(done.textContent).toBe(A.granted("Anna Berg"));
    expect(await bodies("POST", "/v1/admin/admins")).toEqual([
      { email: "anna.berg@example.com", reason: REASON },
      { email: "anna.berg@example.com", reason: REASON },
    ]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/admins");
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/accounts/${ACCOUNT_ID}`);
  });

  it("checks the grant before calling the API and words its refusals by reason", async () => {
    const idle: AdminActionState = { status: "idle" };
    expect(await grantAdmin(idle, formData({ email: "anna.berg", reason: REASON }))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: A.emailInvalid,
    });
    expect(await grantAdmin(idle, formData({ email: "anna.berg@example.com", reason: "abc" }))).toMatchObject(
      {
        message: REASON_STRINGS.tooShort,
      },
    );
    expect(await revokeAdmin(idle, formData({ accountId: "acc_1", name: "Jonas Dahl" }))).toMatchObject({
      message: A.formExpired,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const answers: Record<string, Response> = {
      mfa: apiError("UNPROCESSABLE", 422, { reason: "mfa_not_enabled" }),
      verified: apiError("UNPROCESSABLE", 422, { reason: "email_not_verified" }),
      admin: apiError("CONFLICT", 409, { reason: "already_admin" }),
      none: apiError("NOT_FOUND", 404),
    };
    let answer = "mfa";
    routes({ "POST /v1/admin/admins": () => answers[answer] ?? apiError("INTERNAL_ERROR", 500) });
    const grant = formData({ email: "anna.berg@example.com", reason: REASON });
    expect(await grantAdmin(idle, grant)).toMatchObject({ code: "UNPROCESSABLE", message: A.mfaNotEnabled });
    answer = "verified";
    expect(await grantAdmin(idle, grant)).toMatchObject({ message: A.emailNotVerified });
    answer = "admin";
    expect(await grantAdmin(idle, grant)).toMatchObject({ message: A.alreadyAdmin });
    answer = "none";
    expect(await grantAdmin(idle, grant)).toMatchObject({ message: A.noAccount });

    // The API's `EmailAddress` has the last word on the address: its refusal is about what the admin typed.
    const refusedField = (path: string): Response =>
      json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: "The API's own text, never shown",
            status: 400,
            fieldErrors: [{ path, code: "format", message: "The API's own text, never shown" }],
          },
        },
        400,
      );
    answers["address"] = refusedField("/email");
    answers["other"] = refusedField("/reason");
    answer = "address";
    expect(await grantAdmin(idle, grant)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: A.emailInvalid,
    });
    answer = "other";
    expect(await grantAdmin(idle, grant)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: A.formExpired,
    });

    // A name is counted in code points, as the document's `maxLength` of 200 counts them.
    routes({ [`DELETE /v1/admin/admins/${OTHER_ADMIN_ID}`]: () => new Response(null, { status: 204 }) });
    const longName = "\u{1F600}".repeat(200);
    expect(await revokeAdmin(idle, formData({ accountId: OTHER_ADMIN_ID, name: longName }))).toEqual({
      status: "done",
      action: "revoke",
      accountId: OTHER_ADMIN_ID,
      name: longName,
    });
    expect(
      await revokeAdmin(idle, formData({ accountId: OTHER_ADMIN_ID, name: `${longName}a` })),
    ).toMatchObject({ message: A.formExpired });
    expect(calls("DELETE", `/v1/admin/admins/${OTHER_ADMIN_ID}`)).toHaveLength(1);

    // The API refuses one's own rights too (the page never offers it).
    routes({ [`DELETE /v1/admin/admins/${SELF_ID}`]: () => apiError("FORBIDDEN", 403, { reason: "self" }) });
    expect(await revokeAdmin(idle, formData({ accountId: SELF_ID, name: "Lena Holm" }))).toMatchObject({
      code: "FORBIDDEN",
      message: A.self,
    });
  });
});

// ---- The audit log -------------------------------------------------------------------------------------------------

describe("audit/page.tsx: the audit search", () => {
  const FILTERS = `tenantId=${TENANT_ID}&actorType=platform_admin&action=account.unlocked&targetType=account&targetId=${ACCOUNT_ID}&from=2026-10-01&to=2026-10-31`;

  it("keeps every filter in the URL and asks the API with exactly them [PAD-009 AC3]", async () => {
    routes({
      "GET /v1/admin/audit-log": () =>
        json({ data: [adminAuditEntry()], page: { nextCursor: "eyJpZCI6IjExODcifQ", limit: 50 } }, 200),
    });
    await openAudit(`${FILTERS}&cursor=eyJpZCI6IjE5MDAifQ`);

    // The days of the period become the API's instants: `to` is the start of the day after the last day.
    expect(queryOfCall("/v1/admin/audit-log")).toEqual([
      ["action", "account.unlocked"],
      ["actorType", "platform_admin"],
      ["cursor", "eyJpZCI6IjE5MDAifQ"],
      ["from", "2026-10-01T00:00:00Z"],
      ["targetId", ACCOUNT_ID],
      ["targetType", "account"],
      ["tenantId", TENANT_ID],
      ["to", "2026-11-01T00:00:00Z"],
    ]);
    expectSessionHeaders(calls("GET", "/v1/admin/audit-log")[0]);

    // The filter bar shows the URL's values.
    const filters = screen.getByRole("search", { name: AUDIT_STRINGS.filtersLabel });
    const value = (label: string) => (within(filters).getByLabelText(label) as HTMLInputElement).value;
    expect([
      value(AUDIT_STRINGS.tenantLabel),
      value(AUDIT_STRINGS.actorTypeLabel),
      value(AUDIT_STRINGS.actionLabel),
      value(AUDIT_STRINGS.targetTypeLabel),
      value(AUDIT_STRINGS.targetIdLabel),
      value(AUDIT_STRINGS.fromLabel),
      value(AUDIT_STRINGS.toLabel),
    ]).toEqual([
      TENANT_ID,
      "platform_admin",
      "account.unlocked",
      "account",
      ACCOUNT_ID,
      "2026-10-01",
      "2026-10-31",
    ]);
    const actions = within(filters).getByLabelText(AUDIT_STRINGS.actionLabel) as HTMLSelectElement;
    expect([...actions.options].map((option) => option.value)).toEqual(["", ...AUDIT_ACTIONS]);

    // The rows, with the redacted details in JsonView.
    const table = screen.getByRole("table", { name: AUDIT_STRINGS.caption });
    expect(within(table).getByText("account.unlocked")).toBeTruthy();
    expect(within(table).getByRole("region", { name: AUDIT_STRINGS.detailsOf("1187") })).toBeTruthy();
    expect(hrefOf(link(`account ${ACCOUNT_ID}`, table))).toBe(`/accounts/${ACCOUNT_ID}`);

    // The next page keeps the filters.
    const next = new URL(hrefOf(link("Next page")) ?? "", "https://admin.invalid");
    expect(next.searchParams.get("cursor")).toBe("eyJpZCI6IjExODcifQ");
    expect(sortedQuery(next.search).filter(([name]) => name !== "cursor")).toEqual(sortedQuery(FILTERS));

    // A select applies at once and keeps the others; the cursor goes.
    fireEvent.change(within(filters).getByLabelText(AUDIT_STRINGS.actorTypeLabel), {
      target: { value: "system" },
    });
    const [selected] = navigation.router.push.mock.calls[0] as [string];
    expect(sortedQuery(new URL(selected, "https://admin.invalid").search)).toEqual(
      sortedQuery(FILTERS.replace("actorType=platform_admin", "actorType=system")),
    );
  });

  it("applies the period and the text filters on submit, keeping the others [PAD-009 AC3]", async () => {
    await openAudit("actorType=account");
    const filters = screen.getByRole("search", { name: AUDIT_STRINGS.filtersLabel });
    fireEvent.change(within(filters).getByLabelText(AUDIT_STRINGS.fromLabel), {
      target: { value: "2026-09-01" },
    });
    fireEvent.change(within(filters).getByLabelText(AUDIT_STRINGS.toLabel), {
      target: { value: "2026-09-30" },
    });
    fireEvent.change(within(filters).getByLabelText(AUDIT_STRINGS.actorAccountLabel), {
      target: { value: ` ${ACCOUNT_ID} ` },
    });
    expect(navigation.router.push).not.toHaveBeenCalled();
    submit("Search", filters);

    const [href] = navigation.router.push.mock.calls[0] as [string];
    const url = new URL(href, "https://admin.invalid");
    expect(url.pathname).toBe("/audit");
    expect(sortedQuery(url.search)).toEqual([
      ["actorAccountId", ACCOUNT_ID],
      ["actorType", "account"],
      ["from", "2026-09-01"],
      ["to", "2026-09-30"],
    ]);
  });

  it("links the CSV export of the same filters with a plain link, once the period allows it [PAD-009 AC3]", async () => {
    await openAudit(`${FILTERS}&cursor=eyJpZCI6IjE5MDAifQ`);
    const exportLink = link(AUDIT_STRINGS.exportLink);
    const href = new URL(hrefOf(exportLink) ?? "", "https://admin.invalid");
    expect(href.pathname).toBe("/audit/export.csv");
    expect(sortedQuery(href.search)).toEqual(sortedQuery(FILTERS));
    cleanup();

    // A plain anchor: a next/link would prefetch the route, and so run the export, without a click.
    const payload = serverPayload(await auditPage(FILTERS));
    const anchors = payloadElements(
      payload,
      (props) => typeof props["href"] === "string" && props["href"].startsWith("/audit/export.csv"),
    );
    expect(anchors.map((anchor) => anchor.type)).toEqual(["a"]);

    // Without a period, or with one longer than a year, there is nothing to export; exactly one year is fine.
    for (const [search, text] of [
      ["from=2026-10-01", AUDIT_STRINGS.exportNeedsPeriod],
      ["from=2026-01-01&to=2027-01-01", AUDIT_STRINGS.exportTooLong],
    ] as const) {
      await openAudit(search);
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByRole("link", { name: AUDIT_STRINGS.exportLink })).toBeNull();
      cleanup();
    }
    await openAudit("from=2026-01-01&to=2026-12-31");
    expect(hrefOf(link(AUDIT_STRINGS.exportLink))).toBe("/audit/export.csv?from=2026-01-01&to=2026-12-31");
  });

  it("shows a notice for filters the API would refuse, and does not ask it for rows", async () => {
    for (const search of [
      "tenantId=acme",
      "actorAccountId=acc_1",
      "actorType=robot",
      "action=suspended",
      "targetType=Tenant",
      "targetId=a%20b",
      "from=2026-02-30",
      "to=21-10-2026",
      "actorType=system&actorType=account",
    ]) {
      await openAudit(search);
      expect(screen.getByText(AUDIT_STRINGS.invalidFilters)).toBeTruthy();
      expect(hrefOf(link(AUDIT_STRINGS.showAll))).toBe("/audit");
      expect(screen.queryByRole("link", { name: AUDIT_STRINGS.exportLink })).toBeNull();
      cleanup();
    }
    await openAudit("from=2026-10-31&to=2026-10-01");
    expect(screen.getByText(AUDIT_STRINGS.periodOrder)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers the backend's own lists of actions and target kinds", () => {
    expect(AUDIT_ACTIONS).toEqual([...BACKEND_AUDIT_ACTIONS]);
    expect(AUDIT_TARGET_TYPES).toEqual([...BACKEND_AUDIT_TARGET_TYPES]);
  });
});

describe("audit/export.csv/route.ts: the CSV download", () => {
  const EXPORT_PATH = "/v1/admin/audit-log.csv";
  const HEADER =
    "id,createdAt,tenantId,tenantKey,actorType,actorAccountId,actorLabel,action,targetType,targetId,requestId,ipAddress,userAgent,details\n";
  const RECORD = `1187,2026-10-20T07:33:05Z,,,platform_admin,${SELF_ID},lena.holm@velexis.example.com,account.unlocked,account,${ACCOUNT_ID},,,,{}\n`;

  function exportRequest(search: string): Request {
    return new Request(`http://127.0.0.1:3001/audit/export.csv?${search}`, {
      headers: { "x-forwarded-for": FORWARDED_FOR, "user-agent": USER_AGENT },
    });
  }

  it("streams the API's file as it arrives, with the filters, the admin's token and a no-store attachment [PAD-009 AC3]", async () => {
    const encoder = new TextEncoder();
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    routes({
      [`GET ${EXPORT_PATH}`]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream = controller;
              controller.enqueue(encoder.encode(HEADER));
            },
          }),
          { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } },
        ),
    });

    // The answer arrives while the API is still sending: nothing waits for the whole file.
    const response = await exportCsv(
      exportRequest(`tenantId=${TENANT_ID}&action=account.unlocked&from=2026-10-01&to=2026-10-31`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="velexis-audit-2026-10-01-2026-11-01.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body?.getReader();
    if (reader === undefined || upstream === undefined) {
      throw new Error("no stream");
    }
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(HEADER);

    // The next batch passes through once the API sends it, and the end of the API's stream ends the file.
    upstream.enqueue(encoder.encode(RECORD));
    upstream.close();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value, { stream: true });
    }
    expect(rest).toBe(RECORD);

    expect(queryOfCall(EXPORT_PATH)).toEqual([
      ["action", "account.unlocked"],
      ["from", "2026-10-01T00:00:00Z"],
      ["tenantId", TENANT_ID],
      ["to", "2026-11-01T00:00:00Z"],
    ]);
    expectSessionHeaders(calls("GET", EXPORT_PATH)[0]);
  });

  it("aborts the download when the API's stream fails, so a cut file is never complete", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    routes({
      [`GET ${EXPORT_PATH}`]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream = controller;
              controller.enqueue(new TextEncoder().encode(HEADER));
            },
          }),
          { status: 200 },
        ),
    });
    const response = await exportCsv(exportRequest("from=2026-10-01&to=2026-10-31"));
    const reader = response.body?.getReader();
    await reader?.read();
    upstream?.error(new Error("socket hang up"));
    await expect(reader?.read()).rejects.toThrow();
  });

  it("refuses filters the page would not link, and answers the API's refusals in the admin's words", async () => {
    for (const search of [
      "",
      "from=2026-10-01",
      "from=2026-01-01&to=2027-01-01",
      "tenantId=acme&from=2026-10-01&to=2026-10-02",
      "from=2026-10-31&to=2026-10-01",
    ]) {
      const response = await exportCsv(exportRequest(search));
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe(AUDIT_STRINGS.exportInvalid);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({
      [`GET ${EXPORT_PATH}`]: () => apiError("RATE_LIMITED", 429, undefined, { "retry-after": "60" }),
    });
    const limited = await exportCsv(exportRequest("from=2026-10-01&to=2026-10-31"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    const text = await limited.text();
    expect(text).toBe(AUDIT_STRINGS.exportFailed(ERROR_MESSAGES.RATE_LIMITED));
    expect(text).not.toContain("never shown");

    routes({ [`GET ${EXPORT_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(exportCsv(exportRequest(`actorType=system&from=2026-10-01&to=2026-10-31`))).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: "/audit?actorType=system&from=2026-10-01&to=2026-10-31" }).toString()}`,
    );
  });

  it("answers HEAD with 405, so only a GET starts an export (and writes its audit row)", () => {
    const response = exportCsvHead();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
