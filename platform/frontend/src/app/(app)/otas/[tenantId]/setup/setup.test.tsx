// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import type * as NextNavigation from "next/navigation";
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
  /** As Next.js's: rethrows what `redirect()` and `notFound()` above throw, and nothing else. */
  unstable_rethrow: vi.fn((error: unknown): void => {
    if (error instanceof Error && /^NEXT_(REDIRECT|NOT_FOUND)/.test(error.message)) {
      throw error;
    }
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/setup",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
  notFound: navigation.notFound,
  unstable_rethrow: navigation.unstable_rethrow,
}));

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import { getSetupProgress, retrySetup, revealSetupKeys } from "@/app/(app)/otas/[tenantId]/setup/actions";
import SetupPage from "@/app/(app)/otas/[tenantId]/setup/page";
import { SETUP_POLL_INTERVAL_MS } from "@/components/provisioning-progress";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { TENANT_ROLES, type TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import { ERROR_MESSAGES, SECRET_STRINGS, SETUP_STEP_LABELS, SETUP_STRINGS } from "@/lib/strings";

// ---- Builders (dummy values only: no real token or key) ----------------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type ProvisioningJob = Schemas["ProvisioningJob"];
type ProvisioningStatus = Schemas["ProvisioningStatus"];
type ProvisioningStep = Schemas["ProvisioningStep"];

const ACCESS_TOKEN = "pfe009-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-009 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const JOB_ID = "job_01JA2ZC3D7F1H5K9M3P7R1T5V9";
const RETRY_JOB_ID = "job_01JB3K8Q3S7V1X5Z9B3D7F1H5K";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const PROVISIONING_PATH = `${TENANT_PATH}/provisioning`;
const RETRY_PATH = `${TENANT_PATH}/provisioning/retry`;
const REVEAL_PATH = `${TENANT_PATH}/initial-keys/reveal`;
const SETUP_PATH = `/otas/${TENANT_ID}/setup`;

/** The test keys of the reveal: the shape of `ApiKeySecret`, dummy values. */
const PUBLISHABLE_KEY = "pk_test_PFE009publishableDummyValueNeverReal0000";
const SECRET_KEY = "sk_test_PFE009secretDummyValueNeverRealNotAKey00";

/** Texts of the API that must never reach the page (README §5). */
const RAW_JOB_ERROR = "assign_amadeus_office failed: LOCK_TIMEOUT: raw job error text, never shown";
const RAW_STEP_ERROR = "raw step error text, never shown";

/** The nine steps in the order they run. */
const STEPS = Object.keys(SETUP_STEP_LABELS);

/** The steps' timestamps: the page shows none, so any instant will do (no fixed calendar date). */
const NOW = new Date().toISOString();

function finishedSteps(count: number): ProvisioningStep[] {
  return STEPS.slice(0, count).map((step) => ({
    step,
    status: "succeeded",
    startedAt: NOW,
    finishedAt: NOW,
  }));
}

/** One entry of the step log; a failed one carries the step's error, which the page never shows. */
function logEntry(step: string, status: ProvisioningStep["status"]): ProvisioningStep {
  return {
    step,
    status,
    startedAt: NOW,
    finishedAt: NOW,
    ...(status === "failed" ? { error: { code: "LOCK_TIMEOUT", message: RAW_STEP_ERROR } } : {}),
  };
}

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_ID,
    key: "acme",
    name: "Acme Travel",
    legalName: null,
    status: "provisioning",
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
    schemaVersion: null,
    createdAt: NOW,
    activatedAt: null,
    version: 1,
    myRole: "owner",
    ...overrides,
  };
}

function job(overrides: Partial<ProvisioningJob> = {}): ProvisioningJob {
  return {
    id: JOB_ID,
    kind: "provision",
    status: "running",
    step: "dispatch",
    steps: [],
    attempt: 1,
    maxAttempts: 5,
    error: null,
    ...overrides,
  };
}

/** The OTA worker and the first `done` steps finished; the job runs. */
function running(done: number): ProvisioningStatus {
  return {
    tenantStatus: "provisioning",
    job: job({ step: STEPS[done] ?? "notify", steps: finishedSteps(done) }),
    initialKeysAvailable: false,
  };
}

/** Every step finished; the test keys wait for their reveal unless `initialKeysAvailable` is false. */
function active(initialKeysAvailable = true): ProvisioningStatus {
  return {
    tenantStatus: "active",
    job: job({ status: "succeeded", step: "notify", steps: finishedSteps(STEPS.length) }),
    initialKeysAvailable,
  };
}

/** The set-up failed for good at `assign_amadeus_office`, after its last attempt. */
function failed(): ProvisioningStatus {
  return {
    tenantStatus: "failed",
    job: job({
      status: "failed",
      step: "assign_amadeus_office",
      steps: [
        ...finishedSteps(4),
        {
          step: "assign_amadeus_office",
          status: "failed",
          startedAt: NOW,
          finishedAt: NOW,
          error: { code: "LOCK_TIMEOUT", message: RAW_STEP_ERROR },
        },
      ],
      attempt: 5,
      error: RAW_JOB_ERROR,
    }),
    initialKeysAvailable: false,
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
function apiError(code: string, status: number, headers: Record<string, string> = {}): Response {
  return json(
    { error: { code, message: "The API's own text, never shown", status, requestId: "req_api_pfe009" } },
    status,
    headers,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call with the next of `answers`, and with the last one from then on. */
function sequence(...answers: Route[]): Route {
  let index = 0;
  return (request) => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer === undefined) {
      throw new Error("sequence() needs at least one answer");
    }
    return answer(request);
  };
}

/** Answers each call by `METHOD /path`: by default an owner's OTA in set-up, four steps done. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${PROVISIONING_PATH}`]: () => json(running(4), 200),
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

/** The call carries the session and the end-user headers of PADR-0019. */
function expectPortalHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe009_portal",
    }),
  );
  nextHeaders.cookies.mockResolvedValue({
    get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
    has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
    set: vi.fn(),
  });
  routes();
}

// ---- Rendering, timers and waiting ---------------------------------------------------------------------------------

/**
 * Next.js handles `redirect()` and `notFound()` by navigating; in a component test a server action runs in the page,
 * so its error reaches this boundary, which shows where the browser would go.
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

/** The page as the server renders it for `TENANT_ID`. */
async function setupPage(tenantId = TENANT_ID): Promise<ReactElement> {
  return SetupPage({ params: Promise.resolve({ tenantId }) });
}

/** Renders `/otas/<id>/setup` in the DOM (a page load, or a reload). */
async function openSetup(): Promise<void> {
  const page = await setupPage();
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/**
 * The polling runs on `setTimeout`, which these tests fake, so the 2 seconds pass only when a test says so. Nothing
 * else is faked: the server actions over the mocked fetch run on real promises and macrotasks.
 */
function fakePollTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** Lets `ms` of fake time pass (and the timers due in it run). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Waits until `check` passes, turning the event loop between tries (`setImmediate`, which is not faked), so the
 * promise chain of a server action started by a timer or a click settles. Testing Library's `waitFor` cannot be used
 * here: it ends with a `setTimeout(0)`, which never fires under fake timers.
 */
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

/**
 * The wait for what a click's server action renders, in the tests that run on real timers: the action runs the real
 * `lib/api.ts` over the mocked fetch, which on a busy CI runner can outlast Testing Library's 1 s default. It stays
 * well inside the test's own budget.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/** The summary of the progress (a live region). */
function summary(): string {
  return document.getElementById("setup-summary")?.textContent ?? "";
}

/** The steps on screen, as `[step, state]`. */
function stepStates(): [string, string][] {
  return Array.from(document.querySelectorAll<HTMLElement>("li[data-step]")).map((item) => [
    item.dataset["step"] ?? "",
    item.dataset["state"] ?? "",
  ]);
}

function retryButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: SETUP_STRINGS.retry });
}

function revealButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: SETUP_STRINGS.reveal });
}

/** The budget of the file-level warm-up below (see there). */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: a first render of the page, a poll and a reveal. The first run of those paths in a
 * fresh worker (the module graph of Next.js, React and happy-dom) is the slowest; on a busy CI runner it would
 * otherwise land in the first test's own five seconds. Nothing of it stays: each test gets a fresh API, fresh mocks
 * and globals (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({
    [`GET ${PROVISIONING_PATH}`]: () => json(active(), 200),
    [`POST ${REVEAL_PATH}`]: () => json({ keys: [] }, 200),
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await openSetup();
  await getSetupProgress(TENANT_ID);
  await revealSetupKeys(TENANT_ID);
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

// ---- AC1: polling until a final state ------------------------------------------------------------------------------

describe("/otas/[tenantId]/setup: ProvisioningProgress polling", () => {
  it("[PFE-009 AC1] polls getProvisioning every 2 seconds, one read at a time, and stops once the OTA is active [PF-11 AC1]", async () => {
    routes({
      [`GET ${PROVISIONING_PATH}`]: sequence(
        () => json(running(4), 200),
        () => json(running(6), 200),
        () => json(active(), 200),
      ),
    });
    fakePollTimers();
    await openSetup();

    // The page read the progress once on the server; the steps show where the set-up stands.
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(1);
    expect(summary()).toBe(SETUP_STRINGS.summaryRunning(4, STEPS.length));
    expect(stepStates()).toEqual([
      ...STEPS.slice(0, 4).map((step) => [step, "succeeded"]),
      ["assign_amadeus_office", "running"],
      ...STEPS.slice(5).map((step) => [step, "waiting"]),
    ]);
    const firstStep = document.querySelector('li[data-step="create_schema"]');
    expect(firstStep?.textContent).toContain(SETUP_STEP_LABELS["create_schema"]);
    // A finished step shows as a StatusBadge.
    expect(firstStep?.querySelector('[data-slot="badge"][data-status="succeeded"]')?.textContent).toBe(
      "Done",
    );

    // Nothing is read before 2 seconds have passed.
    await advance(SETUP_POLL_INTERVAL_MS - 1);
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(1);
    await advance(1);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryRunning(6, STEPS.length)));
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2);
    expectPortalHeaders(calls("GET", PROVISIONING_PATH)[1]);

    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryActive));
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(3);
    expect(stepStates()).toEqual(STEPS.map((step) => [step, "succeeded"]));
    expect(screen.getByRole("heading", { level: 2, name: SETUP_STRINGS.readyTitle })).toBeTruthy();
    expect(screen.getByRole("link", { name: SETUP_STRINGS.storefrontLink }).getAttribute("href")).toBe(
      "https://acme.ota.example.com/",
    );
    expect(screen.getByRole("link", { name: SETUP_STRINGS.dashboardLink }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}`,
    );

    // Active is final: no timer is left and a minute later nothing more was read.
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(3);
  });

  it("[PFE-009 AC1] stops polling at a failed set-up", async () => {
    routes({
      [`GET ${PROVISIONING_PATH}`]: sequence(
        () => json(running(4), 200),
        () => json(failed(), 200),
      ),
    });
    fakePollTimers();
    await openSetup();
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryFailed));
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2);

    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2);
  });

  it.each<[string, () => ProvisioningStatus, string]>([
    ["active", () => active(), SETUP_STRINGS.summaryActive],
    ["failed", () => failed(), SETUP_STRINGS.summaryFailed],
    [
      "canceled job",
      () => ({ ...running(0), job: job({ status: "canceled", attempt: 0 }) }),
      SETUP_STRINGS.summaryCanceled,
    ],
  ])(
    "[PFE-009 AC1] never polls a page that opens on a final state (%s)",
    async (_state, answer, expected) => {
      routes({ [`GET ${PROVISIONING_PATH}`]: () => json(answer(), 200) });
      fakePollTimers();
      await openSetup();
      expect(summary()).toBe(expected);
      expect(vi.getTimerCount()).toBe(0);
      await advance(60_000);
      expect(calls("GET", PROVISIONING_PATH)).toHaveLength(1);
    },
  );

  it("[PFE-009 AC1] keeps polling through a rate limit (waiting its Retry-After) and an unavailable API, and stops with the portal's message when the OTA is gone", async () => {
    routes({
      [`GET ${PROVISIONING_PATH}`]: sequence(
        () => json(running(2), 200),
        () => apiError("RATE_LIMITED", 429, { "retry-after": "5" }),
        () => apiError("SERVICE_UNAVAILABLE", 503),
        () => json(running(3), 200),
        () => apiError("NOT_FOUND", 404),
      ),
    });
    fakePollTimers();
    await openSetup();

    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(screen.getByText(SETUP_STRINGS.pollFailed)).toBeTruthy());
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2);
    // The rate limit asked for 5 seconds: nothing after 2, the next read after 5.
    await advance(SETUP_POLL_INTERVAL_MS);
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2);
    await advance(3_000);
    await eventually(() => expect(calls("GET", PROVISIONING_PATH)).toHaveLength(3));
    // The 503 keeps the note; the next answer clears it.
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryRunning(3, STEPS.length)));
    expect(screen.queryByText(SETUP_STRINGS.pollFailed)).toBeNull();
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(4);

    // A 404 (the account is no longer a member) stops the polling with the portal's message.
    await advance(SETUP_POLL_INTERVAL_MS);
    const alert = await (async () => {
      let found: HTMLElement | undefined;
      await eventually(() => {
        found = screen.getByRole("alert");
      });
      return found;
    })();
    expect(alert?.textContent).toContain(SETUP_STRINGS.pollStoppedTitle);
    expect(alert?.textContent).toContain(ERROR_MESSAGES.NOT_FOUND);
    expect(document.body.textContent).not.toContain("The API's own text");
    await advance(60_000);
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(5);
  });

  it("shows a retried attempt that waits for its next try, and keeps polling", async () => {
    routes({
      [`GET ${PROVISIONING_PATH}`]: () =>
        json(
          {
            tenantStatus: "provisioning",
            job: job({ status: "queued", attempt: 2, error: RAW_JOB_ERROR }),
            initialKeysAvailable: false,
          },
          200,
        ),
    });
    fakePollTimers();
    await openSetup();
    expect(summary()).toBe(SETUP_STRINGS.summaryRetrying(2, 5));
    expect(stepStates().every(([, state]) => state === "waiting")).toBe(true);
    expect(document.body.textContent).not.toContain(RAW_JOB_ERROR);
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2));
  });

  it("shows each step once, with its latest outcome, when a retry appended it to the step log again", async () => {
    // The log only grows (flow provisioning.md, "Failure handling"): attempt 1 of the OTA worker failed at
    // run_migrations, attempt 2 built the schema, and assign_amadeus_office failed once before its retry went through.
    const log = [
      logEntry("create_schema", "succeeded"),
      logEntry("run_migrations", "failed"),
      ...finishedSteps(4),
      logEntry("assign_amadeus_office", "failed"),
      logEntry("assign_amadeus_office", "succeeded"),
    ];
    const progress = (status: ProvisioningJob["status"], steps: ProvisioningStep[]): ProvisioningStatus => ({
      tenantStatus: "provisioning",
      job: job({ status, attempt: status === "queued" ? 1 : 2, steps, error: RAW_JOB_ERROR }),
      initialKeysAvailable: false,
    });
    routes({
      [`GET ${PROVISIONING_PATH}`]: sequence(
        () => json(progress("queued", log.slice(0, 2)), 200),
        () => json(progress("running", log.slice(0, 2)), 200),
        () => json(progress("running", log.slice(0, 7)), 200),
        () => json(progress("running", log), 200),
        () =>
          json(
            {
              tenantStatus: "active",
              job: job({ status: "succeeded", attempt: 2, steps: [...log, ...finishedSteps(9).slice(5)] }),
              initialKeysAvailable: true,
            },
            200,
          ),
      ),
    });
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    fakePollTimers();
    await openSetup();

    // Waiting for attempt 2: the failed step of attempt 1 shows as failed.
    expect(summary()).toBe(SETUP_STRINGS.summaryRetrying(1, 5));
    expect(stepStates()).toEqual([
      ["create_schema", "succeeded"],
      ["run_migrations", "failed"],
      ...STEPS.slice(2).map((step) => [step, "waiting"]),
    ]);

    // Attempt 2 runs: the step that failed runs again.
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryRunning(1, STEPS.length)));
    expect(stepStates()).toEqual([
      ["create_schema", "succeeded"],
      ["run_migrations", "running"],
      ...STEPS.slice(2).map((step) => [step, "waiting"]),
    ]);

    // A post-step failed and is tried again; then it went through.
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryRunning(4, STEPS.length)));
    expect(stepStates()).toEqual([
      ...STEPS.slice(0, 4).map((step) => [step, "succeeded"]),
      ["assign_amadeus_office", "running"],
      ...STEPS.slice(5).map((step) => [step, "waiting"]),
    ]);
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryRunning(5, STEPS.length)));
    expect(stepStates()).toEqual([
      ...STEPS.slice(0, 5).map((step) => [step, "succeeded"]),
      ["create_payment_connection", "running"],
      ...STEPS.slice(6).map((step) => [step, "waiting"]),
    ]);

    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryActive));
    expect(stepStates()).toEqual(STEPS.map((step) => [step, "succeeded"]));
    expect(document.body.textContent).not.toContain(RAW_STEP_ERROR);
    // One list item per step: React never saw two children with the same key.
    expect(errors).toEqual([]);
  });

  it("leaves for sign-in, with the way back, when the session ends while polling, retrying or revealing", async () => {
    const signIn = `Redirected to /sign-in?${new URLSearchParams({ next: SETUP_PATH }).toString()}`;
    // React reports the redirect its error boundary caught; that report is not under test here.
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Polling: the redirect of the action reaches the router's boundary, and no read follows.
    routes({
      [`GET ${PROVISIONING_PATH}`]: sequence(
        () => json(running(4), 200),
        () => apiError("UNAUTHENTICATED", 401),
      ),
    });
    fakePollTimers();
    await openSetup();
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(screen.getByText(signIn)).toBeTruthy());
    expect(screen.queryByText(SETUP_STRINGS.pollFailed)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2);
    vi.useRealTimers();
    cleanup();

    // The retry of a failed set-up.
    resetPlatformApi();
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(failed(), 200),
      [`POST ${RETRY_PATH}`]: () => apiError("TOKEN_EXPIRED", 401),
    });
    await openSetup();
    fireEvent.click(retryButton() as HTMLElement);
    await eventually(() => expect(screen.getByText(signIn)).toBeTruthy());
    expect(screen.queryByText(ERROR_MESSAGES.SERVICE_UNAVAILABLE)).toBeNull();
    cleanup();

    // The reveal of the test keys.
    resetPlatformApi();
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "active" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(active(true), 200),
      [`POST ${REVEAL_PATH}`]: () => apiError("UNAUTHENTICATED", 401),
    });
    await openSetup();
    fireEvent.click(revealButton() as HTMLElement);
    await eventually(() => expect(screen.getByText(signIn)).toBeTruthy());
    expect(screen.queryByText(ERROR_MESSAGES.SERVICE_UNAVAILABLE)).toBeNull();

    // The mock of `unstable_rethrow` above behaves as Next.js's own does with a real redirect().
    const actual = await vi.importActual<typeof NextNavigation>("next/navigation");
    let redirectError: unknown;
    try {
      actual.redirect("/sign-in");
    } catch (error) {
      redirectError = error;
    }
    expect(() => actual.unstable_rethrow(redirectError)).toThrow();
    expect(() => actual.unstable_rethrow(new TypeError("Failed to fetch"))).not.toThrow();
  });

  it("getSetupProgress sends an ended session to sign-in and back, an unverified account to /verify-pending, and refuses what is not an OTA id without a call", async () => {
    routes({ [`GET ${PROVISIONING_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(getSetupProgress(TENANT_ID)).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: SETUP_PATH }).toString()}`,
    );
    routes({ [`GET ${PROVISIONING_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(getSetupProgress(TENANT_ID)).rejects.toThrow("NEXT_REDIRECT /verify-pending");

    fetchMock.mockClear();
    for (const value of ["ten_short", "../../v1/me", 42, undefined]) {
      expect(await getSetupProgress(value)).toEqual({
        status: "failed",
        code: "NOT_FOUND",
        message: ERROR_MESSAGES.NOT_FOUND,
        transient: false,
      });
      expect(await retrySetup(value)).toMatchObject({ status: "failed", code: "NOT_FOUND" });
      expect(await revealSetupKeys(value)).toMatchObject({ status: "failed", code: "NOT_FOUND" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- AC2: retry for owners ----------------------------------------------------------------------------------------

describe("/otas/[tenantId]/setup: a failed set-up", () => {
  it('[PFE-009 AC2] shows owners the error summary and "Retry the set-up" [PF-11 AC2]', async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(failed(), 200),
    });
    await openSetup();

    expect(summary()).toBe(SETUP_STRINGS.summaryFailed);
    const section = screen.getByRole("region", { name: SETUP_STRINGS.failedTitle });
    expect(section.textContent).toContain(
      SETUP_STRINGS.failedAt(SETUP_STEP_LABELS["assign_amadeus_office"] ?? ""),
    );
    expect(section.textContent).toContain(SETUP_STRINGS.failedAttempts(5, 5));
    expect(section.textContent).toContain(SETUP_STRINGS.failedReference(JOB_ID));
    expect(retryButton()).toBeTruthy();
    expect(stepStates()).toEqual([
      ...STEPS.slice(0, 4).map((step) => [step, "succeeded"]),
      ["assign_amadeus_office", "failed"],
      ...STEPS.slice(5).map((step) => [step, "not_run"]),
    ]);
    // The job's and the step's error texts stay on the server.
    expect(document.body.textContent).not.toContain(RAW_JOB_ERROR);
    expect(document.body.textContent).not.toContain(RAW_STEP_ERROR);
    expect(document.body.textContent).not.toContain("LOCK_TIMEOUT");
  });

  it("names the first step that did not finish when the OTA worker's failure recorded no step", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () =>
        json(
          {
            tenantStatus: "failed",
            job: job({ status: "failed", step: "dispatch", steps: [], attempt: 1, error: RAW_JOB_ERROR }),
            initialKeysAvailable: false,
          },
          200,
        ),
    });
    await openSetup();
    expect(screen.getByRole("region", { name: SETUP_STRINGS.failedTitle }).textContent).toContain(
      SETUP_STRINGS.failedAt(SETUP_STEP_LABELS["create_schema"] ?? ""),
    );
    expect(stepStates()).toEqual([
      ["create_schema", "failed"],
      ...STEPS.slice(1).map((step) => [step, "not_run"]),
    ]);
    expect(document.body.textContent).not.toContain(RAW_JOB_ERROR);
  });

  it("names where the last attempt stopped when an earlier attempt failed further on", async () => {
    // Attempt 1 failed at run_migrations and was retried; the last attempt failed for good at create_schema.
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () =>
        json(
          {
            tenantStatus: "failed",
            job: job({
              status: "failed",
              step: "create_schema",
              steps: [
                logEntry("create_schema", "succeeded"),
                logEntry("run_migrations", "failed"),
                logEntry("create_schema", "failed"),
              ],
              attempt: 5,
              error: RAW_JOB_ERROR,
            }),
            initialKeysAvailable: false,
          },
          200,
        ),
    });
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    await openSetup();
    expect(screen.getByRole("region", { name: SETUP_STRINGS.failedTitle }).textContent).toContain(
      SETUP_STRINGS.failedAt(SETUP_STEP_LABELS["create_schema"] ?? ""),
    );
    expect(stepStates()).toEqual([
      ["create_schema", "failed"],
      ...STEPS.slice(1).map((step) => [step, "not_run"]),
    ]);
    expect(document.body.textContent).not.toContain(RAW_STEP_ERROR);
    expect(errors).toEqual([]);
  });

  it.each(TENANT_ROLES.filter((role): role is Exclude<TenantRole, "owner"> => role !== "owner"))(
    '[PFE-009 AC2] does not offer "Retry the set-up" to a member with the role %s [PF-11 AC2]',
    async (role) => {
      routes({
        [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed", myRole: role }), 200),
        [`GET ${PROVISIONING_PATH}`]: () => json(failed(), 200),
      });
      await openSetup();
      expect(summary()).toBe(SETUP_STRINGS.summaryFailed);
      expect(screen.getByRole("region", { name: SETUP_STRINGS.failedTitle }).textContent).toContain(
        SETUP_STRINGS.failedReference(JOB_ID),
      );
      expect(retryButton()).toBeNull();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(screen.getByText(SETUP_STRINGS.retryOwnerOnly)).toBeTruthy();
    },
  );

  it("[PFE-009 AC2] a retry starts a new job and polling starts again until it is active", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: sequence(
        () => json(failed(), 200),
        () =>
          json(
            {
              ...active(),
              job: job({ id: RETRY_JOB_ID, status: "succeeded", step: "notify", steps: finishedSteps(9) }),
            },
            200,
          ),
      ),
      [`POST ${RETRY_PATH}`]: () =>
        json(
          {
            job: job({ id: RETRY_JOB_ID, status: "running", step: "dispatch", steps: [] }),
            checkoutUrl: null,
          },
          202,
        ),
    });
    fakePollTimers();
    await openSetup();
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.click(retryButton() as HTMLElement);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryRunning(0, STEPS.length)));
    const [retry, ...more] = calls("POST", RETRY_PATH);
    expect(more).toHaveLength(0);
    expectPortalHeaders(retry);
    expect(retryButton()).toBeNull();
    expect(stepStates()).toEqual([
      ["create_schema", "running"],
      ...STEPS.slice(1).map((step) => [step, "waiting"]),
    ]);

    // Polling started again for the new job, and stops once it is active.
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryActive));
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[PFE-009 AC2] PROVISIONING_NOT_RETRYABLE shows its message and the current progress; a refused role keeps the button", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: sequence(
        () => json(failed(), 200),
        // Another owner retried in the meantime.
        () => json(running(1), 200),
      ),
      [`POST ${RETRY_PATH}`]: () => apiError("PROVISIONING_NOT_RETRYABLE", 409),
    });
    fakePollTimers();
    await openSetup();
    fireEvent.click(retryButton() as HTMLElement);
    await eventually(() => expect(summary()).toBe(SETUP_STRINGS.summaryRunning(1, STEPS.length)));
    expect(screen.getByRole("alert").textContent).toBe(ERROR_MESSAGES.PROVISIONING_NOT_RETRYABLE);
    expect(calls("POST", RETRY_PATH)).toHaveLength(1);
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2);
    // The progress runs again, so it is polled.
    await advance(SETUP_POLL_INTERVAL_MS);
    await eventually(() => expect(calls("GET", PROVISIONING_PATH)).toHaveLength(3));
    vi.useRealTimers();
    cleanup();

    resetPlatformApi();
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(failed(), 200),
      [`POST ${RETRY_PATH}`]: () => apiError("FORBIDDEN", 403),
    });
    await openSetup();
    fireEvent.click(retryButton() as HTMLElement);
    const alert = await screen.findByRole("alert", {}, ACTION_WAIT);
    expect(alert.textContent).toBe(ERROR_MESSAGES.FORBIDDEN);
    // The button is back once the attempt ended ("Starting a new attempt…" while it runs).
    expect(await screen.findByRole("button", { name: SETUP_STRINGS.retry }, ACTION_WAIT)).toBeTruthy();
    expect(summary()).toBe(SETUP_STRINGS.summaryFailed);
  });
});

// ---- AC3: the one-time reveal -------------------------------------------------------------------------------------

describe("/otas/[tenantId]/setup: the test keys", () => {
  /** The reveal as the API does it: the keys once, then `410 KEYS_ALREADY_REVEALED`; the progress follows. */
  function revealOnce(): void {
    let revealed = false;
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "active" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(active(!revealed), 200),
      [`POST ${REVEAL_PATH}`]: () => {
        if (revealed) {
          return apiError("KEYS_ALREADY_REVEALED", 410);
        }
        revealed = true;
        return json(
          {
            keys: [
              {
                id: "key_01JA2ZD8E2G6J0K4N8Q2S6W0Y5",
                kind: "secret",
                environment: "test",
                prefix: SECRET_KEY.slice(0, 14),
                key: SECRET_KEY,
              },
              {
                id: "key_01JA2ZD8E2G6J0K4N8Q2S6W0Y4",
                kind: "publishable",
                environment: "test",
                prefix: PUBLISHABLE_KEY.slice(0, 14),
                key: PUBLISHABLE_KEY,
              },
            ],
          },
          200,
          { "cache-control": "no-store" },
        );
      },
    });
  }

  it("[PFE-009 AC3] renders the revealed keys once, in memory only, and a reload no longer has them [PF-11 AC3]", async () => {
    revealOnce();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    const urlBefore = location.href;

    // The page itself never reads the keys: the server's markup holds none, and no reveal was made.
    const serverHtml = renderToString(await setupPage());
    expect(serverHtml).toContain(SETUP_STRINGS.reveal);
    expect(serverHtml).not.toContain(PUBLISHABLE_KEY);
    expect(serverHtml).not.toContain(SECRET_KEY);
    await openSetup();
    expect(calls("POST", REVEAL_PATH)).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain(SECRET_KEY);

    // The owner's click reveals both keys, publishable first, with the warning that they are shown once.
    fireEvent.click(revealButton() as HTMLElement);
    const panel = await screen.findByRole("region", { name: SETUP_STRINGS.revealedTitle }, ACTION_WAIT);
    const publishable = within(panel).getByLabelText(SETUP_STRINGS.publishableKeyLabel) as HTMLInputElement;
    const secret = within(panel).getByLabelText(SETUP_STRINGS.secretKeyLabel) as HTMLInputElement;
    expect(publishable.value).toBe(PUBLISHABLE_KEY);
    expect(secret.value).toBe(SECRET_KEY);
    expect(publishable.compareDocumentPosition(secret) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.textContent).toContain(SECRET_STRINGS.warningTitle);
    const [reveal, ...more] = calls("POST", REVEAL_PATH);
    expect(more).toHaveLength(0);
    expectPortalHeaders(reveal);
    // Once: the keys section has no reveal button any more, only the panel's own buttons.
    const keysSection = screen.getByRole("region", { name: SETUP_STRINGS.keysTitle });
    expect(
      within(keysSection)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      `${SECRET_STRINGS.copy} ${SETUP_STRINGS.publishableKeyLabel}`,
      `${SECRET_STRINGS.copy} ${SETUP_STRINGS.secretKeyLabel}`,
      SECRET_STRINGS.dismiss,
    ]);

    // Nothing of them was written anywhere: storage, cookies, the URL or the history.
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(cookieWrite).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(location.href).toBe(urlBefore);

    // A reload renders the page again from the server: the keys are gone, and so is the reveal.
    cleanup();
    document.body.replaceChildren();
    await openSetup();
    expect(document.body.innerHTML).not.toContain(PUBLISHABLE_KEY);
    expect(document.body.innerHTML).not.toContain(SECRET_KEY);
    expect(revealButton()).toBeNull();
    expect(screen.getByText(ERROR_MESSAGES.KEYS_ALREADY_REVEALED, { exact: false })).toBeTruthy();
    expect(screen.getByRole("link", { name: SETUP_STRINGS.apiKeysLink }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/api-keys`,
    );
    expect(calls("POST", REVEAL_PATH)).toHaveLength(1);
  });

  it('[PFE-009 AC3] "I have stored it" removes the keys from the page', async () => {
    revealOnce();
    await openSetup();
    fireEvent.click(revealButton() as HTMLElement);
    await screen.findByRole("region", { name: SETUP_STRINGS.revealedTitle }, ACTION_WAIT);
    fireEvent.click(screen.getByRole("button", { name: SECRET_STRINGS.dismiss }));
    expect(screen.getByText(SECRET_STRINGS.dismissed)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(PUBLISHABLE_KEY);
    expect(document.body.innerHTML).not.toContain(SECRET_KEY);
    expect(revealButton()).toBeNull();
  });

  it("[PFE-009 AC3] KEYS_ALREADY_REVEALED explains how to create keys", async () => {
    // The page still offers the reveal (another owner revealed the keys a moment ago).
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "active" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(active(true), 200),
      [`POST ${REVEAL_PATH}`]: () => apiError("KEYS_ALREADY_REVEALED", 410),
    });
    await openSetup();
    fireEvent.click(revealButton() as HTMLElement);
    const alert = await screen.findByRole("alert", {}, ACTION_WAIT);
    expect(alert.textContent).toContain(ERROR_MESSAGES.KEYS_ALREADY_REVEALED);
    expect(within(alert).getByRole("link", { name: SETUP_STRINGS.apiKeysLink }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/api-keys`,
    );
    expect(revealButton()).toBeNull();
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("[PFE-009 AC3] offers the reveal to owners only", async () => {
    for (const role of TENANT_ROLES.filter((value) => value !== "owner")) {
      resetPlatformApi();
      routes({
        [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "active", myRole: role }), 200),
        [`GET ${PROVISIONING_PATH}`]: () => json(active(true), 200),
      });
      await openSetup();
      expect(summary()).toBe(SETUP_STRINGS.summaryActive);
      expect(revealButton()).toBeNull();
      expect(screen.getByText(SETUP_STRINGS.keysOwnerOnly)).toBeTruthy();
      cleanup();
      document.body.replaceChildren();
    }
    expect(fetchMock.mock.calls.some(([input]) => new URL(input.url).pathname === REVEAL_PATH)).toBe(false);
  });
});

// ---- The page ------------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]/setup: the page", () => {
  it("reads the OTA and its progress with the session and the end-user headers, and names the OTA", async () => {
    await openSetup();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Acme Travel");
    const [tenantCall] = calls("GET", TENANT_PATH);
    const [progressCall] = calls("GET", PROVISIONING_PATH);
    expectPortalHeaders(tenantCall);
    expectPortalHeaders(progressCall);
    expect(calls("POST", RETRY_PATH)).toHaveLength(0);
    expect(calls("POST", REVEAL_PATH)).toHaveLength(0);
  });

  it("renders the not-found page for an OTA the account is not a member of, or for what is not an OTA id", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => apiError("NOT_FOUND", 404),
      [`GET ${PROVISIONING_PATH}`]: () => apiError("NOT_FOUND", 404),
    });
    await expect(setupPage()).rejects.toThrow("NEXT_NOT_FOUND");
    fetchMock.mockClear();
    await expect(setupPage("ten_not-an-id")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an ended session to sign-in with the way back, and shows the portal's message when the API is unavailable", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => apiError("TOKEN_EXPIRED", 401),
      [`GET ${PROVISIONING_PATH}`]: () => apiError("TOKEN_EXPIRED", 401),
    });
    await expect(setupPage()).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: SETUP_PATH }).toString()}`,
    );

    routes({ [`GET ${PROVISIONING_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openSetup();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(SETUP_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("renders on the server and hydrates without an error or a change", async () => {
    fakePollTimers();
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(["console.error", ...args]);
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      errors.push(["console.warn", ...args]);
    });
    const page = await setupPage();
    const container = document.createElement("div");
    container.innerHTML = renderToString(page);
    // happy-dom's HTML parser keeps some character references in attribute values that a browser decodes (see
    // pricing.test.tsx); the shadcn/ui class names hold them.
    for (const element of Array.from(container.querySelectorAll("*"))) {
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
    document.body.append(container);
    const serverDom = container.innerHTML;
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, page, {
        onRecoverableError: (error) => errors.push(["recoverable", error]),
        onCaughtError: (error) => errors.push(["caught", error]),
        onUncaughtError: (error) => errors.push(["uncaught", error]),
      });
      await Promise.resolve();
    });
    // The hydrated page is the server's page: same markup, nothing replaced in the browser.
    expect(container.innerHTML).toBe(serverDom);
    expect(errors).toEqual([]);
    act(() => root?.unmount());
  });
});
