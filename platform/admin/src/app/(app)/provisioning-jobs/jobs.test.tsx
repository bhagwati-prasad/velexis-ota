// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OTA_QUEUES, OTA_TENANT_OPS, PLATFORM_QUEUES, bullmqJobId } from "@velexis/api-types/jobs";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope, navigation and cache of Next.js and the configuration; the real API client talks ----
// ---- to a mocked fetch, so the tests see the query and the body of every call the pages and actions send ----------

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
  cancelProvisioningJob,
  retryProvisioningJob,
  type JobActionState,
} from "@/app/(app)/provisioning-jobs/[jobId]/actions";
import { JobActions } from "@/app/(app)/provisioning-jobs/[jobId]/job-actions";
import ProvisioningJobPage from "@/app/(app)/provisioning-jobs/[jobId]/page";
import { JobTable } from "@/app/(app)/provisioning-jobs/job-table";
import ProvisioningJobsPage from "@/app/(app)/provisioning-jobs/page";
import { retryQueueJob, type QueueRetryState } from "@/app/(app)/queues/[queue]/actions";
import { FailedJobList } from "@/app/(app)/queues/[queue]/failed-jobs";
import QueuePage from "@/app/(app)/queues/[queue]/page";
import QueuesPage from "@/app/(app)/queues/page";
import { FilterBar } from "@/components/filter-bar";
import * as tableComponents from "@/components/ui/table";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "@/lib/session";
import {
  ERROR_MESSAGES,
  JOB_ACTION_STRINGS,
  JOB_DETAIL_STRINGS,
  JOB_LIST_STRINGS,
  QUEUE_DETAIL_STRINGS,
  QUEUE_LIST_STRINGS,
  REASON_STRINGS,
  STEP_UP_STRINGS,
  formatAge,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) ---------------------------------------------------

type Schemas = components["schemas"];
type Job = Schemas["AdminProvisioningJob"];
type JobDetail = Schemas["AdminProvisioningJobDetail"];

const ACCESS_TOKEN = "pad006-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-006 test)";
const TENANT_ID = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const OTHER_TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const FAILED_JOB_ID = "job_01JB3K9R4T8W2Y6A0C4E8G2J6M";
const RETRIED_JOB_ID = "job_01JC6P4R8T2W6Y0A4C8E2G6J0M";
const QUEUED_JOB_ID = "job_01JC7Q5S9V3X7Z1B5D9F3H7K1N";
const RUNNING_JOB_ID = "job_01JB3M0S5V9X3Z7B1D5F9H3K7N";
/**
 * The BullMQ job of the failed job's last dispatch attempt on `ota-tenant-ops`, written by the contract's own
 * `bullmqJobId`: the pages match its `<jobId>-<attempt>` shape without loading the jobs module (and its Ajv validators)
 * into the Next.js bundle, so the fixtures come from the contract and the tests fail if the shape changes.
 */
const DISPATCH_ATTEMPT_ID = bullmqJobId(FAILED_JOB_ID, 5);
const JOBS_PATH = "/v1/admin/provisioning-jobs";
const REASON = "The owner asked to stop the set-up; the OTA comes back under another key.";
const LOCK_TIMEOUT = "LOCK_TIMEOUT: the tenant schema lock was not granted within 30 seconds.";

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

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: FAILED_JOB_ID,
    tenantId: TENANT_ID,
    tenantKey: "nordic",
    kind: "provision",
    status: "failed",
    step: "run_migrations",
    attempt: 5,
    maxAttempts: 5,
    error: LOCK_TIMEOUT,
    scheduledAt: "2026-10-16T14:31:12Z",
    startedAt: "2026-10-16T13:40:03Z",
    finishedAt: "2026-10-16T14:31:44Z",
    ...overrides,
  };
}

/** The jobs of the list: a failed set-up, a running suspension, a queued migration of another OTA. */
function jobs(): Job[] {
  return [
    job(),
    job({
      id: RUNNING_JOB_ID,
      kind: "suspend",
      status: "running",
      step: "dispatch",
      attempt: 2,
      error: "OTA worker did not answer within 30 seconds.",
      finishedAt: null,
    }),
    job({
      id: QUEUED_JOB_ID,
      tenantId: OTHER_TENANT_ID,
      tenantKey: "acme",
      kind: "migrate",
      status: "queued",
      step: null,
      attempt: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    }),
  ];
}

function detail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    ...job(),
    steps: [
      {
        step: "create_schema",
        status: "succeeded",
        startedAt: "2026-10-16T14:31:13Z",
        finishedAt: "2026-10-16T14:31:13Z",
      },
      {
        step: "run_migrations",
        status: "failed",
        startedAt: "2026-10-16T14:31:13Z",
        finishedAt: "2026-10-16T14:31:44Z",
        error: { code: "LOCK_TIMEOUT", message: "The tenant schema lock was not granted within 30 seconds." },
      },
    ],
    payload: { planCode: "early_access", ownerAccountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X" },
    result: null,
    lockedUntil: null,
    bullmqState: "failed",
    ...overrides,
  };
}

/** A detail in `status`, with what a job of that status has. */
function detailIn(status: Job["status"]): JobDetail {
  switch (status) {
    case "queued":
      return detail({
        id: QUEUED_JOB_ID,
        status,
        step: null,
        attempt: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
        steps: [],
        bullmqState: null,
      });
    case "running":
      return detail({
        id: RUNNING_JOB_ID,
        status,
        step: "dispatch",
        attempt: 2,
        finishedAt: null,
        lockedUntil: "2026-10-16T14:46:13Z",
        bullmqState: "active",
      });
    case "succeeded":
      return detail({
        status,
        step: "notify",
        error: null,
        result: { apiKeyIds: ["key_01JB3KA2C6E0G4J8M2P6S0V4X8"] },
      });
    case "canceled":
      return detail({
        id: QUEUED_JOB_ID,
        status,
        step: null,
        attempt: 0,
        error: null,
        steps: [],
        bullmqState: null,
      });
    case "failed":
      return detail();
  }
}

function queueList(): Schemas["QueueList"] {
  const counts = (
    name: string,
    owner: "platform" | "ota",
    values: [number, number, number, number],
    oldestWaitingSeconds: number | null,
  ): Schemas["QueueCounts"] => {
    const [waiting, active, delayed, failed] = values;
    return { name, owner, waiting, active, delayed, failed, oldestWaitingSeconds };
  };
  return {
    data: [
      counts("platform-tenant-events", "platform", [0, 0, 0, 0], null),
      counts("platform-emails", "platform", [3, 1, 0, 2], 4),
      counts("platform-maintenance", "platform", [1, 0, 2, 0], 7_380),
      counts("ota-tenant-ops", "ota", [0, 0, 1, 1], null),
      counts("ota-payments", "ota", [2, 0, 0, 4], 90_000),
    ],
  };
}

const EMAIL_ID = "eml_01JC3M7P1R5T9W3Y7A1C5E9G3J";

function emailFailures(): Schemas["FailedQueueJob"][] {
  return [
    {
      id: "1843",
      name: "email.send",
      failedReason: "SMTP 451: temporary local problem, try again later",
      attemptsMade: 5,
      failedAt: "2026-10-21T22:14:09Z",
      data: { emailId: EMAIL_ID },
    },
    {
      id: "1844",
      name: "email.send",
      failedReason: null,
      attemptsMade: 5,
      failedAt: null,
      data: { emailId: "eml_01JC3M7P1R5T9W3Y7A1C5E9G3K" },
    },
  ];
}

function tenantOpsFailures(): Schemas["FailedQueueJob"][] {
  return [
    {
      id: DISPATCH_ATTEMPT_ID,
      name: "tenant.provision",
      failedReason: LOCK_TIMEOUT,
      attemptsMade: 1,
      failedAt: "2026-10-16T14:31:44Z",
      data: { jobId: FAILED_JOB_ID, tenantId: TENANT_ID, attempt: 5 },
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

/** An empty `202`, as the API answers a queue retry (Express writes `Content-Length: 0`). */
function accepted(): Response {
  return new Response(null, { status: 202, headers: { "content-length": "0" } });
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
        requestId: "req_api_pad006",
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
    headers,
  );
}

/** The list as the API answers it: newest first, filtered by `status`, `kind` and `tenantId`. */
function listJobs(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const data = jobs().filter(
    (row) =>
      (query.get("status") === null || row.status === query.get("status")) &&
      (query.get("kind") === null || row.kind === query.get("kind")) &&
      (query.get("tenantId") === null || row.tenantId === query.get("tenantId")),
  );
  return json({ data, page: { nextCursor: null, limit: 50 } }, 200);
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call by `METHOD /path`; unexpected calls fail the test. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    [`GET ${JOBS_PATH}`]: listJobs,
    [`GET ${JOBS_PATH}/${FAILED_JOB_ID}`]: () => json(detail(), 200),
    "GET /v1/admin/queues": () => json(queueList(), 200),
    "GET /v1/admin/queues/platform-emails/failed": () => json({ data: emailFailures() }, 200),
    "GET /v1/admin/queues/ota-tenant-ops/failed": () => json({ data: tenantOpsFailures() }, 200),
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
      "x-request-id": "req_pad006_admin",
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

/** Renders `/provisioning-jobs<search>` as a browser opening that URL gets it. */
async function openJobs(search = ""): Promise<void> {
  setUrl("/provisioning-jobs", search);
  render(await ProvisioningJobsPage({ searchParams: searchParamsOf(search) }));
}

async function jobPage(jobId: string): Promise<ReactElement> {
  return ProvisioningJobPage({ params: Promise.resolve({ jobId }) });
}

/** Renders `/provisioning-jobs/<id>`; `rerender` renders it again as Next.js does after an action revalidated it. */
async function openJob(jobId: string = FAILED_JOB_ID): Promise<{ rerender: () => Promise<void> }> {
  setUrl(`/provisioning-jobs/${jobId}`);
  const view = render(await jobPage(jobId));
  return {
    rerender: async () => {
      view.rerender(await jobPage(jobId));
    },
  };
}

async function openQueues(): Promise<void> {
  setUrl("/queues");
  render(await QueuesPage());
}

async function queuePage(queue: string): Promise<ReactElement> {
  return QueuePage({ params: Promise.resolve({ queue }) });
}

/** Renders `/queues/<queue>`; `rerender` renders it again as Next.js does after the retry revalidated it. */
async function openQueue(queue: string): Promise<{ rerender: () => Promise<void> }> {
  setUrl(`/queues/${queue}`);
  const view = render(await queuePage(queue));
  return {
    rerender: async () => {
      view.rerender(await queuePage(queue));
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

/** The actions section of the job page. */
function actionsSection(): HTMLElement {
  return screen.getByRole("region", { name: JOB_ACTION_STRINGS.sectionTitle });
}

/** Clicks `trigger` and confirms the confirmation dialog named `title` with its button `confirm`. */
async function confirmWith(trigger: string | RegExp, title: string, confirm: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  const dialog = await screen.findByRole("alertdialog", { name: title }, UI_WAIT);
  fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
  return dialog;
}

/** Opens the cancel dialog of a queued job. */
async function openCancelDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: JOB_ACTION_STRINGS.cancel }));
  return screen.findByRole("dialog", { name: JOB_ACTION_STRINGS.cancelTitle }, UI_WAIT);
}

/** Types `reason` into the dialog and confirms. */
function confirmReason(dialog: HTMLElement, reason: string): void {
  fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: reason } });
  submit(JOB_ACTION_STRINGS.cancelConfirm, dialog);
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

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** The client components these pages render: Next.js sends their props, not their output, to the browser. */
const CLIENT_COMPONENTS: ReadonlySet<unknown> = new Set<unknown>([
  JobTable,
  JobActions,
  FailedJobList,
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
 * Once per file, before any test: the first render of the four pages in a fresh worker (the tables, the filter bar,
 * the dialogs) and the first server action through the real API client are the slowest steps, and on a busy CI
 * runner they would otherwise land in the first test's own five seconds. Nothing of it stays: each test gets a fresh
 * API and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({
    [`POST ${JOBS_PATH}/${FAILED_JOB_ID}/retry`]: () =>
      apiError("PROVISIONING_NOT_RETRYABLE", 409, { reason: "job_active" }),
  });
  await openJobs("status=failed");
  cleanup();
  await openJob();
  await confirmWith(JOB_ACTION_STRINGS.retry, JOB_ACTION_STRINGS.retryTitle, JOB_ACTION_STRINGS.retryConfirm);
  await screen.findByText(JOB_ACTION_STRINGS.jobActive, {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openQueues();
  cleanup();
  await openQueue("platform-emails");
  fireEvent.click(screen.getByRole("button", { name: "Retry job 1843" }));
  await screen.findByRole("alertdialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The job list --------------------------------------------------------------------------------------------------

describe("provisioning-jobs/page.tsx: the job list", () => {
  it("filters by status and kind in the URL and links every job and its OTA [PF-83]", async () => {
    await openJobs("status=failed&kind=provision");

    expect(queryOfCall(JOBS_PATH)).toEqual([
      ["kind", "provision"],
      ["status", "failed"],
    ]);
    expectSessionHeaders(calls("GET", JOBS_PATH)[0]);
    expect(screen.getByRole("heading", { level: 1, name: JOB_LIST_STRINGS.title })).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    const row = rows[1] as HTMLElement;
    expect(hrefOf(link(FAILED_JOB_ID, row))).toBe(`/provisioning-jobs/${FAILED_JOB_ID}`);
    expect(hrefOf(link("nordic", row))).toBe(`/tenants/${TENANT_ID}`);
    for (const text of ["Set-up", "Failed", "run_migrations", "5 of 5", LOCK_TIMEOUT]) {
      expect(within(row).getByText(text)).toBeTruthy();
    }

    // The selects show the URL's filters and offer every status and kind of the document.
    const status = screen.getByRole("combobox", { name: JOB_LIST_STRINGS.statusLabel }) as HTMLSelectElement;
    const kind = screen.getByRole("combobox", { name: JOB_LIST_STRINGS.kindLabel }) as HTMLSelectElement;
    expect([status.value, kind.value]).toEqual(["failed", "provision"]);
    expect([...status.options].map((option) => option.value)).toEqual([
      "",
      "queued",
      "running",
      "succeeded",
      "failed",
      "canceled",
    ]);
    expect([...kind.options].map((option) => option.value)).toEqual([
      "",
      "provision",
      "migrate",
      "suspend",
      "resume",
    ]);

    // Another kind keeps the status and goes into the URL.
    fireEvent.change(kind, { target: { value: "migrate" } });
    const [href] = navigation.router.push.mock.calls[0] as [string];
    const url = new URL(href, "https://admin.invalid");
    expect(url.pathname).toBe("/provisioning-jobs");
    expect(sortedQuery(url.search)).toEqual([
      ["kind", "migrate"],
      ["status", "failed"],
    ]);
  });

  it("links the next page with the filters, and sends the cursor of the URL", async () => {
    routes({
      [`GET ${JOBS_PATH}`]: () =>
        json({ data: jobs(), page: { nextCursor: "eyJpZCI6ImpvYl8ifQ", limit: 50 } }, 200),
    });
    await openJobs("status=failed");

    const next = new URL(hrefOf(link("Next page")) ?? "", "https://admin.invalid");
    expect(sortedQuery(next.search)).toEqual([
      ["cursor", "eyJpZCI6ImpvYl8ifQ"],
      ["status", "failed"],
    ]);
    cleanup();
    fetchMock.mockClear();
    await openJobs(next.search);
    expect(queryOfCall(JOBS_PATH)).toEqual([
      ["cursor", "eyJpZCI6ImpvYl8ifQ"],
      ["status", "failed"],
    ]);
    expect(screen.getByRole("link", { name: "First page" })).toBeTruthy();
  });

  it("lists the jobs of one OTA from its tenant page, with a way back to every OTA", async () => {
    await openJobs(`tenantId=${TENANT_ID}&status=failed`);

    expect(queryOfCall(JOBS_PATH)).toEqual([
      ["status", "failed"],
      ["tenantId", TENANT_ID],
    ]);
    const notice = screen.getByText(JOB_LIST_STRINGS.oneTenant).closest("p") as HTMLElement;
    expect(hrefOf(link(`${JOB_LIST_STRINGS.openTenant} nordic`, notice))).toBe(`/tenants/${TENANT_ID}`);
    expect(hrefOf(link(JOB_LIST_STRINGS.everyTenant, notice))).toBe("/provisioning-jobs?status=failed");

    // A filter keeps the OTA.
    fireEvent.change(screen.getByRole("combobox", { name: JOB_LIST_STRINGS.kindLabel }), {
      target: { value: "provision" },
    });
    const [href] = navigation.router.push.mock.calls[0] as [string];
    expect(sortedQuery(new URL(href, "https://admin.invalid").search)).toEqual([
      ["kind", "provision"],
      ["status", "failed"],
      ["tenantId", TENANT_ID],
    ]);
  });

  it("shows a notice for filters the API would refuse, and does not ask it for a list", async () => {
    for (const search of [
      "status=deleted",
      "kind=export",
      "tenantId=nordic",
      "status=failed&status=queued",
      `cursor=${"c".repeat(513)}`,
    ]) {
      fetchMock.mockClear();
      await openJobs(search);
      expect(screen.getByText(JOB_LIST_STRINGS.invalidFilters)).toBeTruthy();
      expect(calls("GET", JOBS_PATH)).toHaveLength(0);
      expect(screen.queryByRole("table")).toBeNull();
      expect(hrefOf(link(JOB_LIST_STRINGS.showAll))).toBe("/provisioning-jobs");
      cleanup();
    }
    // Empty parameters, as the filter bar's plain GET form sends them, are no filter.
    fetchMock.mockClear();
    await openJobs("status=&kind=&tenantId=&cursor=");
    expect(queryOfCall(JOBS_PATH)).toEqual([]);
    expect(screen.getAllByRole("row")).toHaveLength(4);
    cleanup();

    // A cursor the API refuses reads as invalid filters.
    routes({ [`GET ${JOBS_PATH}`]: () => apiError("VALIDATION_FAILED", 400) });
    await openJobs("cursor=stale");
    expect(screen.getByText(JOB_LIST_STRINGS.invalidFilters)).toBeTruthy();
  });

  it("hands the client table only the fields it shows, whatever else the answer holds", async () => {
    const sentinel = "PAD006-SENTINEL-LIST";
    routes({
      [`GET ${JOBS_PATH}`]: () =>
        json(
          { data: jobs().map((row) => ({ ...row, revealCiphertext: sentinel })), page: { nextCursor: null } },
          200,
        ),
    });
    const page = await ProvisioningJobsPage({ searchParams: searchParamsOf("") });

    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain(FAILED_JOB_ID);
    expect(payload).not.toContain(sentinel);
    render(page);
    expect(document.body.innerHTML).not.toContain(sentinel);
  });

  it("shows the admin's message when the list cannot be loaded, and sends an ended session to sign-in", async () => {
    routes({ [`GET ${JOBS_PATH}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openJobs();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(JOB_LIST_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(document.body.textContent).not.toContain("The API's own text");
    cleanup();

    routes({ [`GET ${JOBS_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(ProvisioningJobsPage({ searchParams: searchParamsOf("") })).rejects.toThrow(
      "NEXT_REDIRECT /sign-in",
    );
  });
});

// ---- The job detail ------------------------------------------------------------------------------------------------

describe("provisioning-jobs/[jobId]/page.tsx: the job detail", () => {
  it("shows the step log, attempts, errors, lease and BullMQ state of a job [PF-83]", async () => {
    routes({ [`GET ${JOBS_PATH}/${RUNNING_JOB_ID}`]: () => json(detailIn("running"), 200) });
    await openJob(RUNNING_JOB_ID);

    expect(calls("GET", `${JOBS_PATH}/${RUNNING_JOB_ID}`)).toHaveLength(1);
    expectSessionHeaders(calls("GET", `${JOBS_PATH}/${RUNNING_JOB_ID}`)[0]);
    expect(hrefOf(link(JOB_DETAIL_STRINGS.backToList))).toBe("/provisioning-jobs");

    const summary = screen.getByRole("region", { name: JOB_DETAIL_STRINGS.summaryTitle });
    expect(hrefOf(link("nordic", summary))).toBe(`/tenants/${TENANT_ID}`);
    for (const text of ["Set-up", "Running", "dispatch", "2 of 5", LOCK_TIMEOUT, "Active"]) {
      expect(within(summary).getByText(text)).toBeTruthy();
    }
    // The lease of a running job, and its BullMQ job: `<jobId>-<attempt>` on ota-tenant-ops.
    expect(summary.querySelector('time[datetime="2026-10-16T14:46:13Z"]')).not.toBeNull();
    expect(within(summary).getByText(bullmqJobId(RUNNING_JOB_ID, 2))).toBeTruthy();
    expect(hrefOf(link(OTA_TENANT_OPS, summary))).toBe(`/queues/${OTA_TENANT_OPS}`);

    // The step log, with the failed step's code and message.
    const steps = screen.getByRole("region", { name: JOB_DETAIL_STRINGS.stepsTitle });
    const rows = within(steps).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("create_schema")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Done")).toBeTruthy();
    const failedStep = rows[2] as HTMLElement;
    expect(within(failedStep).getByText("run_migrations")).toBeTruthy();
    expect(within(failedStep).getByText("Failed")).toBeTruthy();
    expect(within(failedStep).getByText("LOCK_TIMEOUT")).toBeTruthy();
    expect(
      within(failedStep).getByText("The tenant schema lock was not granted within 30 seconds."),
    ).toBeTruthy();

    // The input in JsonView; no result before the job ends.
    expect(
      screen.getByRole("region", { name: JOB_DETAIL_STRINGS.payloadLabel(RUNNING_JOB_ID) }).textContent,
    ).toContain('"planCode": "early_access"');
    const result = screen.getByRole("region", { name: JOB_DETAIL_STRINGS.resultTitle });
    expect(within(result).getByText("None")).toBeTruthy();
  });

  it("says when a job holds no lease and was never dispatched, and shows the result of a finished one", async () => {
    routes({
      [`GET ${JOBS_PATH}/${QUEUED_JOB_ID}`]: () => json(detailIn("queued"), 200),
      [`GET ${JOBS_PATH}/${FAILED_JOB_ID}`]: () => json(detailIn("succeeded"), 200),
    });
    await openJob(QUEUED_JOB_ID);
    const summary = screen.getByRole("region", { name: JOB_DETAIL_STRINGS.summaryTitle });
    expect(within(summary).getByText(JOB_DETAIL_STRINGS.noLease)).toBeTruthy();
    expect(within(summary).getByText(JOB_DETAIL_STRINGS.notDispatched)).toBeTruthy();
    expect(within(summary).queryByText(JOB_DETAIL_STRINGS.bullmqJob)).toBeNull();
    expect(screen.getByText(JOB_DETAIL_STRINGS.stepsEmpty)).toBeTruthy();
    cleanup();

    await openJob(FAILED_JOB_ID);
    expect(
      screen.getByRole("region", { name: JOB_DETAIL_STRINGS.resultLabel(FAILED_JOB_ID) }).textContent,
    ).toContain("key_01JB3KA2C6E0G4J8M2P6S0V4X8");
  });

  it("[PAD-006 AC1] offers Retry only on a failed job and Cancel only on a queued one [PF-83]", async () => {
    const statuses: Job["status"][] = ["failed", "queued", "running", "succeeded", "canceled"];
    for (const status of statuses) {
      routes({ [`GET ${JOBS_PATH}/${FAILED_JOB_ID}`]: () => json(detailIn(status), 200) });
      await openJob(FAILED_JOB_ID);
      const section = actionsSection();
      const buttons = within(section)
        .queryAllByRole("button")
        .map((button) => button.textContent);
      if (status === "failed") {
        expect(buttons).toEqual([JOB_ACTION_STRINGS.retry]);
      } else if (status === "queued") {
        expect(buttons).toEqual([JOB_ACTION_STRINGS.cancel]);
      } else {
        expect(buttons).toEqual([]);
        expect(within(section).getByText(JOB_ACTION_STRINGS.noAction)).toBeTruthy();
      }
      cleanup();
    }
    // Looking at a job calls nothing that changes it.
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("[PAD-006 AC1] retries a failed job after a confirmation and links the new job [PF-83]", async () => {
    routes({
      [`POST ${JOBS_PATH}/${FAILED_JOB_ID}/retry`]: () =>
        json(
          {
            job: job({
              id: RETRIED_JOB_ID,
              status: "running",
              step: "dispatch",
              attempt: 1,
              error: null,
              finishedAt: null,
            }),
          },
          202,
        ),
    });
    const view = await openJob();

    fireEvent.click(screen.getByRole("button", { name: JOB_ACTION_STRINGS.retry }));
    const dialog = await screen.findByRole("alertdialog", { name: JOB_ACTION_STRINGS.retryTitle }, UI_WAIT);
    // A failed set-up says that the OTA goes back to "Setting up".
    expect(within(dialog).getByText(JOB_ACTION_STRINGS.retryProvisionDescription)).toBeTruthy();
    expect(calls("POST", `${JOBS_PATH}/${FAILED_JOB_ID}/retry`)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: JOB_ACTION_STRINGS.retryConfirm }));

    const done = await notice("done", actionsSection());
    expect(done.getAttribute("role")).toBe("status");
    expect(within(done).getByText(JOB_ACTION_STRINGS.retried)).toBeTruthy();
    expect(hrefOf(link(RETRIED_JOB_ID, done))).toBe(`/provisioning-jobs/${RETRIED_JOB_ID}`);
    expect(within(done).getByText("Running")).toBeTruthy();
    expect(within(done).getByText(JOB_ACTION_STRINGS.stepOf("dispatch"))).toBeTruthy();
    expect(await bodies("POST", `${JOBS_PATH}/${FAILED_JOB_ID}/retry`)).toEqual([null]);
    expectSessionHeaders(calls("POST", `${JOBS_PATH}/${FAILED_JOB_ID}/retry`)[0]);
    // The failed job's page, the new job's, the list and the OTA's page show the jobs as they are now.
    expect(nextCache.revalidatePath.mock.calls.map(([path]) => path as string)).toEqual([
      `/provisioning-jobs/${FAILED_JOB_ID}`,
      `/provisioning-jobs/${RETRIED_JOB_ID}`,
      "/provisioning-jobs",
      `/tenants/${TENANT_ID}`,
    ]);

    // The revalidated page still shows the failed job (it stays as history), and the outcome stays.
    await view.rerender();
    expect(within(actionsSection()).getByText(JOB_ACTION_STRINGS.retried)).toBeTruthy();
  });

  it("[PAD-006 AC1] cancels a queued job with a reason, and the page then offers nothing [PF-83]", async () => {
    let current = detailIn("queued");
    routes({
      [`GET ${JOBS_PATH}/${QUEUED_JOB_ID}`]: () => json(current, 200),
      [`POST ${JOBS_PATH}/${QUEUED_JOB_ID}/cancel`]: () => {
        current = detailIn("canceled");
        return json(
          {
            job: job({
              id: QUEUED_JOB_ID,
              status: "canceled",
              step: null,
              attempt: 0,
              error: null,
              startedAt: null,
            }),
          },
          200,
        );
      },
    });
    const view = await openJob(QUEUED_JOB_ID);
    const dialog = await openCancelDialog();
    expect(within(dialog).getByText(JOB_ACTION_STRINGS.cancelDescription)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: JOB_ACTION_STRINGS.keepJob })).toBeTruthy();

    // No reason, then four characters: refused at the field, nothing is sent.
    submit(JOB_ACTION_STRINGS.cancelConfirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.required)).toBeTruthy();
    confirmReason(dialog, "Stop");
    expect(within(dialog).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
    expect(calls("POST", `${JOBS_PATH}/${QUEUED_JOB_ID}/cancel`)).toHaveLength(0);

    confirmReason(dialog, `  ${REASON}  `);
    const done = await notice("done", actionsSection());
    expect(within(done).getByText(JOB_ACTION_STRINGS.canceled)).toBeTruthy();
    expect(within(done).getByText("Canceled")).toBeTruthy();
    expect(await bodies("POST", `${JOBS_PATH}/${QUEUED_JOB_ID}/cancel`)).toEqual([{ reason: REASON }]);
    expectSessionHeaders(calls("POST", `${JOBS_PATH}/${QUEUED_JOB_ID}/cancel`)[0]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/provisioning-jobs/${QUEUED_JOB_ID}`);

    // The revalidated page shows the canceled job: no action any more, the outcome still there.
    await view.rerender();
    const section = actionsSection();
    expect(within(section).queryAllByRole("button")).toHaveLength(0);
    expect(within(section).getByText(JOB_ACTION_STRINGS.noAction)).toBeTruthy();
    expect(within(section).getByText(JOB_ACTION_STRINGS.canceled)).toBeTruthy();
  });

  it("words the refusals of the API by their reason, never with its own text", async () => {
    const retryPath = `${JOBS_PATH}/${FAILED_JOB_ID}/retry`;
    const cancelPath = `${JOBS_PATH}/${QUEUED_JOB_ID}/cancel`;
    const cases: [Route, string][] = [
      [
        () => apiError("PROVISIONING_NOT_RETRYABLE", 409, { reason: "job_active" }),
        JOB_ACTION_STRINGS.jobActive,
      ],
      [
        () => apiError("PROVISIONING_NOT_RETRYABLE", 409, { reason: "tenant_not_failed" }),
        JOB_ACTION_STRINGS.tenantNotFailed,
      ],
      [
        () => apiError("PROVISIONING_NOT_RETRYABLE", 409, { reason: "not_failed" }),
        JOB_ACTION_STRINGS.notFailed,
      ],
      [() => apiError("PROVISIONING_NOT_RETRYABLE", 409), ERROR_MESSAGES.PROVISIONING_NOT_RETRYABLE],
      [() => apiError("NOT_FOUND", 404), JOB_ACTION_STRINGS.jobGone],
      [
        () => apiError("RATE_LIMITED", 429, undefined, { "retry-after": "90" }),
        JOB_ACTION_STRINGS.rateLimitedFor(90),
      ],
    ];
    for (const [answer, message] of cases) {
      routes({ [`POST ${retryPath}`]: answer });
      const state = await retryProvisioningJob({ status: "idle" }, formData({ jobId: FAILED_JOB_ID }));
      expect(state).toMatchObject({ status: "failed", message });
    }

    routes({
      [`POST ${cancelPath}`]: () => apiError("CONFLICT", 409, { reason: "not_queued", status: "running" }),
    });
    expect(
      await cancelProvisioningJob({ status: "idle" }, formData({ jobId: QUEUED_JOB_ID, reason: REASON })),
    ).toEqual({ status: "failed", code: "CONFLICT", message: JOB_ACTION_STRINGS.notQueued });
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // Through the page: the notice shows the admin's words only.
    routes({
      [`GET ${JOBS_PATH}/${QUEUED_JOB_ID}`]: () => json(detailIn("queued"), 200),
      [`POST ${cancelPath}`]: () => apiError("CONFLICT", 409, { reason: "not_queued" }),
    });
    await openJob(QUEUED_JOB_ID);
    confirmReason(await openCancelDialog(), REASON);
    const failed = await notice("failed", actionsSection());
    expect(failed.getAttribute("data-code")).toBe("CONFLICT");
    expect(failed.textContent).toBe(JOB_ACTION_STRINGS.notQueued);
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("[PAD-006 AC1] the actions refuse a malformed job id or reason without calling the API", async () => {
    const idle: JobActionState = { status: "idle" };
    for (const jobId of ["", "job_1", `${FAILED_JOB_ID}/../x`, "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G"]) {
      expect(await retryProvisioningJob(idle, formData({ jobId }))).toEqual({
        status: "failed",
        code: "VALIDATION_FAILED",
        message: JOB_ACTION_STRINGS.formExpired,
      });
      expect(await cancelProvisioningJob(idle, formData({ jobId, reason: REASON }))).toMatchObject({
        status: "failed",
        message: JOB_ACTION_STRINGS.formExpired,
      });
    }
    const reasons: [string, string][] = [
      ["", REASON_STRINGS.required],
      ["    ", REASON_STRINGS.required],
      ["Stop", REASON_STRINGS.tooShort],
      ["x".repeat(501), REASON_STRINGS.tooLong],
    ];
    for (const [reason, message] of reasons) {
      expect(await cancelProvisioningJob(idle, formData({ jobId: QUEUED_JOB_ID, reason }))).toEqual({
        status: "failed",
        code: "VALIDATION_FAILED",
        message,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for a step-up on REAUTH_REQUIRED and cancels again with the same reason after the code", async () => {
    let attempts = 0;
    routes({
      [`GET ${JOBS_PATH}/${QUEUED_JOB_ID}`]: () => json(detailIn("queued"), 200),
      [`POST ${JOBS_PATH}/${QUEUED_JOB_ID}/cancel`]: () => {
        attempts += 1;
        return attempts === 1
          ? apiError("REAUTH_REQUIRED", 401)
          : json({ job: job({ id: QUEUED_JOB_ID, status: "canceled", step: null, attempt: 0 }) }, 200);
      },
      "POST /v1/admin/auth/step-up": () =>
        json(
          {
            accessToken: "pad006-stepped-up-access-token",
            accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
            refreshToken: "pad006-stepped-up-refresh-token",
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
    await openJob(QUEUED_JOB_ID);
    confirmReason(await openCancelDialog(), REASON);

    const stepUp = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    fireEvent.change(within(stepUp).getByLabelText(STEP_UP_STRINGS.codeLabel), {
      target: { value: "492039" },
    });
    submit(STEP_UP_STRINGS.submit, stepUp);
    // The modal dialog hides the rest of the page from the accessibility tree until it closes.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);

    const done = await notice("done", actionsSection());
    expect(within(done).getByText(JOB_ACTION_STRINGS.canceled)).toBeTruthy();
    expect(await bodies("POST", "/v1/admin/auth/step-up")).toEqual([{ code: "492039" }]);
    expect(cookieStore.set.mock.calls.map(([name]) => name as string)).toEqual([
      ACCESS_TOKEN_COOKIE,
      REFRESH_TOKEN_COOKIE,
    ]);
    expect(await bodies("POST", `${JOBS_PATH}/${QUEUED_JOB_ID}/cancel`)).toEqual([
      { reason: REASON },
      { reason: REASON },
    ]);
  });

  it("sends an ended session to sign-in: the page to sign-in, an action back to the job", async () => {
    routes({ [`GET ${JOBS_PATH}/${FAILED_JOB_ID}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(jobPage(FAILED_JOB_ID)).rejects.toThrow("NEXT_REDIRECT /sign-in");

    routes({ [`POST ${JOBS_PATH}/${FAILED_JOB_ID}/retry`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(
      retryProvisioningJob({ status: "idle" }, formData({ jobId: FAILED_JOB_ID })),
    ).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: `/provisioning-jobs/${FAILED_JOB_ID}` }).toString()}`,
    );
  });

  it("renders the not-found page for an unknown job, and for a value that is no job id without a call", async () => {
    for (const jobId of ["nordic", "job_01jb3k9r4t8w2y6a0c4e8g2j6m", `${FAILED_JOB_ID}x`]) {
      await expect(jobPage(jobId)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ [`GET ${JOBS_PATH}/${FAILED_JOB_ID}`]: () => apiError("NOT_FOUND", 404) });
    await expect(jobPage(FAILED_JOB_ID)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls("GET", `${JOBS_PATH}/${FAILED_JOB_ID}`)).toHaveLength(1);

    routes({ [`GET ${JOBS_PATH}/${FAILED_JOB_ID}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openJob();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(JOB_DETAIL_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("hands the actions only the job's id, kind and status, and renders no property the document lacks", async () => {
    const sentinel = "PAD006-SENTINEL-REVEAL-CIPHERTEXT";
    routes({
      [`GET ${JOBS_PATH}/${FAILED_JOB_ID}`]: () =>
        json({ ...detail(), revealCiphertext: sentinel, revealKekId: sentinel }, 200),
    });
    const page = await jobPage(FAILED_JOB_ID);

    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain(LOCK_TIMEOUT);
    expect(payload).not.toContain(sentinel);
    render(page);
    expect(document.body.innerHTML).not.toContain(sentinel);
  });
});

// ---- The queues ----------------------------------------------------------------------------------------------------

describe("queues/page.tsx: the queues", () => {
  it("[PAD-006 AC2] shows the counts of every queue of both backends and the oldest waiting age [PF-84]", async () => {
    await openQueues();

    expect(calls("GET", "/v1/admin/queues")).toHaveLength(1);
    expectSessionHeaders(calls("GET", "/v1/admin/queues")[0]);
    const platform = screen.getByRole("region", { name: QUEUE_LIST_STRINGS.platformTitle });
    const ota = screen.getByRole("region", { name: QUEUE_LIST_STRINGS.otaTitle });
    const namesOf = (region: HTMLElement) =>
      within(region)
        .getAllByRole("link")
        .map((element) => [element.textContent, hrefOf(element as HTMLAnchorElement)]);
    expect(namesOf(platform)).toEqual([
      ["platform-tenant-events", "/queues/platform-tenant-events"],
      ["platform-emails", "/queues/platform-emails"],
      ["platform-maintenance", "/queues/platform-maintenance"],
    ]);
    expect(namesOf(ota)).toEqual([
      ["ota-tenant-ops", "/queues/ota-tenant-ops"],
      ["ota-payments", "/queues/ota-payments"],
    ]);

    /** The cells of a queue's row: waiting, active, delayed, failed, oldest waiting. */
    const cellsOf = (region: HTMLElement, queue: string) =>
      within(within(region).getByRole("link", { name: queue }).closest("tr") as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cellsOf(platform, "platform-emails")).toEqual(["3", "1", "0", "2", "4 seconds"]);
    expect(cellsOf(platform, "platform-tenant-events")).toEqual([
      "0",
      "0",
      "0",
      "0",
      QUEUE_LIST_STRINGS.noneWaiting,
    ]);
    expect(cellsOf(platform, "platform-maintenance")).toEqual(["1", "0", "2", "0", "2 hours 3 minutes"]);
    expect(cellsOf(ota, "ota-tenant-ops")).toEqual(["0", "0", "1", "1", QUEUE_LIST_STRINGS.noneWaiting]);
    expect(cellsOf(ota, "ota-payments")).toEqual(["2", "0", "0", "4", "1 day 1 hour"]);
    // The OTA queues are introduced as view only.
    expect(within(ota).getByText(QUEUE_LIST_STRINGS.otaIntro)).toBeTruthy();
  });

  it("says when the queues cannot be read (Redis down), and sends an ended session to sign-in", async () => {
    routes({ "GET /v1/admin/queues": () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openQueues();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(QUEUE_LIST_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(QUEUE_LIST_STRINGS.unavailable);
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();

    routes({ "GET /v1/admin/queues": () => apiError("RATE_LIMITED", 429) });
    await openQueues();
    expect(screen.getByRole("alert").textContent).toContain(ERROR_MESSAGES.RATE_LIMITED);
    cleanup();

    routes({ "GET /v1/admin/queues": () => apiError("UNAUTHENTICATED", 401) });
    await expect(QueuesPage()).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });

  it("writes the age of the oldest waiting job in words", () => {
    expect(
      [0, 1, 59, 60, 61, 3_599, 3_600, 3_660, 86_399, 86_400, 90_000, 172_800].map((seconds) =>
        formatAge(seconds),
      ),
    ).toEqual([
      "0 seconds",
      "1 second",
      "59 seconds",
      "1 minute",
      "1 minute",
      "59 minutes",
      "1 hour",
      "1 hour 1 minute",
      "23 hours 59 minutes",
      "1 day",
      "1 day 1 hour",
      "2 days",
    ]);
  });
});

describe("queues/[queue]/page.tsx: the failed jobs of a queue", () => {
  it("[PAD-006 AC2] an OTA queue shows its failures with reasons and payloads but no retry button [PF-84]", async () => {
    await openQueue("ota-tenant-ops");

    expect(calls("GET", "/v1/admin/queues/ota-tenant-ops/failed")).toHaveLength(1);
    expectSessionHeaders(calls("GET", "/v1/admin/queues/ota-tenant-ops/failed")[0]);
    expect(screen.getByRole("heading", { level: 1, name: "ota-tenant-ops" })).toBeTruthy();
    expect(screen.getByText(QUEUE_DETAIL_STRINGS.otaOwner)).toBeTruthy();
    expect(screen.getByText(QUEUE_DETAIL_STRINGS.otaNotice)).toBeTruthy();
    expect(hrefOf(link(QUEUE_DETAIL_STRINGS.backToList))).toBe("/queues");

    const row = screen.getByText(DISPATCH_ATTEMPT_ID).closest("tr") as HTMLElement;
    expect(within(row).getByText("tenant.provision")).toBeTruthy();
    expect(within(row).getByText(LOCK_TIMEOUT)).toBeTruthy();
    expect(
      within(row).getByRole("region", { name: QUEUE_DETAIL_STRINGS.dataLabel(DISPATCH_ATTEMPT_ID) })
        .textContent,
    ).toContain(`"tenantId": "${TENANT_ID}"`);
    // The failed dispatch attempt links to its provisioning job, which can be retried there.
    expect(hrefOf(link(QUEUE_DETAIL_STRINGS.provisioningJob, row))).toBe(
      `/provisioning-jobs/${FAILED_JOB_ID}`,
    );
    // No retry, nor its column.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("columnheader", { name: QUEUE_DETAIL_STRINGS.columnAction })).toBeNull();
  });

  it("[PAD-006 AC2] retries a failed job of a platform queue after a confirmation [PF-84]", async () => {
    let failures = emailFailures();
    routes({
      "GET /v1/admin/queues/platform-emails/failed": () => json({ data: failures }, 200),
      "POST /v1/admin/queues/platform-emails/jobs/1843/retry": () => {
        failures = failures.filter((failure) => failure.id !== "1843");
        return accepted();
      },
    });
    const view = await openQueue("platform-emails");
    expect(screen.getByText(QUEUE_DETAIL_STRINGS.platformOwner)).toBeTruthy();

    // Every failed job of a platform queue has its own retry, named after the job.
    const row = screen.getByText("1843").closest("tr") as HTMLElement;
    expect(within(row).getByText("SMTP 451: temporary local problem, try again later")).toBeTruthy();
    expect(
      within(row).getByRole("region", { name: QUEUE_DETAIL_STRINGS.dataLabel("1843") }).textContent,
    ).toContain(EMAIL_ID);
    const other = screen.getByText("1844").closest("tr") as HTMLElement;
    expect(within(other).getByText(QUEUE_DETAIL_STRINGS.noReason)).toBeTruthy();
    expect(within(other).getByText(QUEUE_DETAIL_STRINGS.unknownTime)).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      `${QUEUE_DETAIL_STRINGS.retry}${QUEUE_DETAIL_STRINGS.retryJobSuffix("1843")}`,
      `${QUEUE_DETAIL_STRINGS.retry}${QUEUE_DETAIL_STRINGS.retryJobSuffix("1844")}`,
    ]);

    const dialog = await confirmWith(
      "Retry job 1843",
      QUEUE_DETAIL_STRINGS.retryTitle("1843"),
      QUEUE_DETAIL_STRINGS.retryConfirm,
    );
    expect(dialog.textContent).toContain(QUEUE_DETAIL_STRINGS.retryDescription);
    const done = await notice("done");
    expect(done.getAttribute("role")).toBe("status");
    expect(done.textContent).toBe(QUEUE_DETAIL_STRINGS.retried("1843"));
    expect(calls("POST", "/v1/admin/queues/platform-emails/jobs/1843/retry")).toHaveLength(1);
    expectSessionHeaders(calls("POST", "/v1/admin/queues/platform-emails/jobs/1843/retry")[0]);
    expect(nextCache.revalidatePath.mock.calls.map(([path]) => path as string)).toEqual([
      "/queues/platform-emails",
      "/queues",
    ]);

    // The revalidated page no longer lists the job; the outcome stays above the table.
    await view.rerender();
    expect(screen.queryByText("1843")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(QUEUE_DETAIL_STRINGS.retried("1843"));
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("[PAD-006 AC2] the retry action refuses an OTA queue without calling the API, and words the API's refusals", async () => {
    const idle: QueueRetryState = { status: "idle" };
    // Every OTA queue of the contract, ota-tenant-ops first: refused here, nothing is sent.
    for (const queue of OTA_QUEUES) {
      expect(await retryQueueJob(idle, formData({ queue, jobId: DISPATCH_ATTEMPT_ID }))).toEqual({
        status: "failed",
        jobId: DISPATCH_ATTEMPT_ID,
        code: "FORBIDDEN",
        message: QUEUE_DETAIL_STRINGS.otaQueue,
      });
    }
    for (const fields of [
      { queue: "", jobId: "1843" },
      { queue: "platform-Emails", jobId: "1843" },
      { queue: `platform-${"x".repeat(60)}`, jobId: "1843" },
      { queue: "platform-emails", jobId: "" },
      { queue: "platform-emails", jobId: "18/43" },
    ]) {
      expect(await retryQueueJob(idle, formData(fields))).toMatchObject({
        status: "failed",
        code: "VALIDATION_FAILED",
        message: QUEUE_DETAIL_STRINGS.formExpired,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const retryPath = "POST /v1/admin/queues/platform-emails/jobs/1843/retry";
    const cases: [Route, string][] = [
      [() => apiError("FORBIDDEN", 403, { reason: "ota_queue" }), QUEUE_DETAIL_STRINGS.otaQueue],
      [() => apiError("NOT_FOUND", 404), QUEUE_DETAIL_STRINGS.jobGone],
      [() => apiError("SERVICE_UNAVAILABLE", 503), QUEUE_DETAIL_STRINGS.unavailable],
      [
        () => apiError("RATE_LIMITED", 429, undefined, { "retry-after": "30" }),
        QUEUE_DETAIL_STRINGS.rateLimitedFor(30),
      ],
    ];
    for (const [answer, message] of cases) {
      routes({ [retryPath]: answer });
      expect(await retryQueueJob(idle, formData({ queue: "platform-emails", jobId: "1843" }))).toMatchObject({
        status: "failed",
        jobId: "1843",
        message,
      });
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    routes({ [retryPath]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(retryQueueJob(idle, formData({ queue: "platform-emails", jobId: "1843" }))).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: "/queues/platform-emails" }).toString()}`,
    );
  });

  it("[PAD-006 AC2] the retry action sends a failed job of every platform queue of the contract to the API", async () => {
    routes(
      Object.fromEntries(
        PLATFORM_QUEUES.map((queue): [string, Route] => [
          `POST /v1/admin/queues/${queue}/jobs/1843/retry`,
          accepted,
        ]),
      ),
    );
    for (const queue of PLATFORM_QUEUES) {
      expect(await retryQueueJob({ status: "idle" }, formData({ queue, jobId: "1843" }))).toEqual({
        status: "done",
        jobId: "1843",
      });
      expect(calls("POST", `/v1/admin/queues/${queue}/jobs/1843/retry`)).toHaveLength(1);
    }
  });

  it("shows the refusal of a retry above the table, in the admin's words", async () => {
    routes({ "POST /v1/admin/queues/platform-emails/jobs/1844/retry": () => apiError("NOT_FOUND", 404) });
    await openQueue("platform-emails");
    await confirmWith(
      "Retry job 1844",
      QUEUE_DETAIL_STRINGS.retryTitle("1844"),
      QUEUE_DETAIL_STRINGS.retryConfirm,
    );

    const failed = await notice("failed");
    expect(failed.getAttribute("data-code")).toBe("NOT_FOUND");
    expect(failed.textContent).toBe(QUEUE_DETAIL_STRINGS.jobGone);
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("renders the not-found page for a value that is no queue name without a call, and for an unknown queue", async () => {
    for (const queue of [
      "redis",
      "platform-Emails",
      "ota-",
      `platform-${"x".repeat(60)}`,
      "platform-emails/../x",
    ]) {
      await expect(queuePage(queue)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ "GET /v1/admin/queues/platform-unknown/failed": () => apiError("NOT_FOUND", 404) });
    await expect(queuePage("platform-unknown")).rejects.toThrow("NEXT_NOT_FOUND");
    routes({ "GET /v1/admin/queues/platform-emails/failed": () => apiError("UNAUTHENTICATED", 401) });
    await expect(queuePage("platform-emails")).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });

  it("says when the failed jobs cannot be read, shows an empty queue, and hands the list only the fields it shows", async () => {
    routes({ "GET /v1/admin/queues/platform-emails/failed": () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openQueue("platform-emails");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(QUEUE_DETAIL_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(QUEUE_DETAIL_STRINGS.unavailable);
    cleanup();

    routes({ "GET /v1/admin/queues/platform-emails/failed": () => json({ data: [] }, 200) });
    await openQueue("platform-emails");
    expect(screen.getByText(QUEUE_DETAIL_STRINGS.empty)).toBeTruthy();
    cleanup();

    const sentinel = "PAD006-SENTINEL-STACKTRACE";
    routes({
      "GET /v1/admin/queues/platform-emails/failed": () =>
        json({ data: emailFailures().map((failure) => ({ ...failure, stacktrace: [sentinel] })) }, 200),
    });
    const page = await queuePage("platform-emails");
    const payload = JSON.stringify(serverPayload(page));
    expect(payload).toContain(EMAIL_ID);
    expect(payload).not.toContain(sentinel);
  });
});
