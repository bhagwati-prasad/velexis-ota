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
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/otas/new",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
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

import DashboardPage from "@/app/(app)/dashboard/page";
import { checkKeyAvailability, createOta, type CreateOtaState } from "@/app/(app)/otas/new/actions";
import { KEY_CHECK_DELAY_MS, keyFromName } from "@/app/(app)/otas/new/key-availability-field";
import NewOtaPage from "@/app/(app)/otas/new/page";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  DASHBOARD_STRINGS,
  ERROR_MESSAGES,
  ROLE_LABELS,
  WIZARD_STEP_LABELS,
  WIZARD_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token) -----------------------------------------------------------------

type Schemas = components["schemas"];
type Account = Schemas["Account"];
type Plan = Schemas["Plan"];
type TenantSummary = Schemas["TenantSummary"];

const ACCESS_TOKEN = "pfe008-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-008 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const SECOND_TENANT_ID = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const FEATURES_OFF: Account["features"] = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "anna.berg@example.com",
    emailVerified: true,
    fullName: "Anna Berg",
    locale: "en",
    timeZone: "Europe/Oslo",
    mfaEnabled: false,
    mfaEnabledAt: null,
    isPlatformAdmin: false,
    createdAt: "2026-10-01T10:02:17Z",
    version: 3,
    memberships: [],
    features: FEATURES_OFF,
    ...overrides,
  };
}

function plan(overrides: Partial<Plan> & Pick<Plan, "code" | "name">): Plan {
  return {
    description: null,
    monthlyPrice: { amount: "0.00", currency: "EUR" },
    annualPrice: null,
    trialDays: 0,
    limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: false },
    features: {},
    checkoutAvailable: { month: false, year: false },
    ...overrides,
  };
}

const EARLY_ACCESS = plan({
  code: "early_access",
  name: "Early access",
  description: "Free plan for OTAs created before paid plans open. Test mode only.",
  trialDays: 90,
});
const STARTER = plan({
  code: "starter",
  name: "Starter",
  monthlyPrice: { amount: "49.00", currency: "EUR" },
  limits: { staffSeats: 3, apiKeys: 5, customDomains: 1, liveMode: true },
});
const GROWTH = plan({
  code: "growth",
  name: "Growth",
  monthlyPrice: { amount: "149.00", currency: "EUR" },
  limits: { staffSeats: 10, apiKeys: 20, customDomains: 3, liveMode: true },
});
/** The public plans in the API's order; early access is not first, so a filter that takes the first would show. */
const PLANS = [STARTER, EARLY_ACCESS, GROWTH];

function tenantSummary(overrides: Partial<TenantSummary> = {}): TenantSummary {
  return {
    id: TENANT_ID,
    key: "acme",
    name: "Acme Travel",
    status: "active",
    role: "owner",
    planCode: "early_access",
    storefrontUrl: "https://acme.ota.example.com/",
    storefrontEnvironment: "test",
    ...overrides,
  };
}

function tenantCreated(): Schemas["TenantCreated"] {
  return {
    tenant: {
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
      createdAt: "2026-10-14T08:20:11Z",
      activatedAt: null,
      version: 1,
      myRole: "owner",
    },
    provisioningJob: { id: "job_01JA2ZC3D7F1H5K9M3P7R1T5V9", status: "running" },
    checkoutUrl: null,
  };
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
        requestId: "req_api_pfe008",
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

type Route = (request: Request) => Response | Promise<Response>;

/** The answer of a key check: `taken` for `nordic`, `reserved` for `admin`, otherwise available. */
function keyAvailability(request: Request): Response {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  const host = `${key}.${settings.STOREFRONT_BASE_DOMAIN}`;
  if (key === "nordic") {
    return json({ key, available: false, reason: "taken", storefrontHost: host }, 200);
  }
  if (key === "admin") {
    return json({ key, available: false, reason: "reserved", storefrontHost: host }, 200);
  }
  return json({ key, available: true, storefrontHost: host }, 200);
}

/** Answers each call by `METHOD /path`, with the account, the plans and the key check by default. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    "GET /v1/me": () => json(account(), 200),
    "GET /v1/plans": () => json({ data: PLANS }, 200),
    "GET /v1/tenants/key-availability": keyAvailability,
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

/** The cookie store of `cookies()`: the session's access token. */
function cookieStore() {
  const store = {
    get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
    has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
    set: vi.fn(),
  };
  nextHeaders.cookies.mockResolvedValue(store);
  return store;
}

// ---- Rendering and typing ----------------------------------------------------------------------------------------

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

/**
 * The budget of a hook that opens the wizard. Its server render and first browser render build some 850 options (the
 * countries, currencies and time zones) in happy-dom: a few hundred milliseconds alone, several times that on a
 * loaded CI runner next to the other packages' tests. The tests that need the wizard as it opens with the default
 * account and plans (or with routes the page itself never calls) get it from a `beforeEach` with this budget, which
 * only stops a hook that hangs, so the test bodies hold the steps they check.
 */
const OPEN_WIZARD_TIMEOUT_MS = 30_000;

/**
 * How long a test waits for what a server action answers: the live key check (`checkKeyAvailability`) or a submit
 * (`createOta`), each a round trip through the real `lib/api.ts` and a re-render of the wizard (not of its select
 * options, which are memoised).
 * Testing Library's 1 s default is enough on an idle machine, but not on a loaded CI runner next to the other
 * packages' tests (it ran out once at the tenant-limit alert). The test's own 5 s budget is unchanged; this only
 * lets a wait that is going to succeed finish inside it.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/** Renders `/otas/new` inside the redirect boundary; React reports a caught redirect on the console. */
async function openWizard(): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await NewOtaPage();
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

async function redirectedTo(): Promise<string> {
  const status = await screen.findByText(/^Redirected to /, {}, ACTION_WAIT);
  return status.textContent?.replace(/^Redirected to /, "") ?? "";
}

/** The control labelled `label`. */
function control(label: string): HTMLInputElement | HTMLSelectElement {
  return screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
}

function type(label: string, value: string): void {
  fireEvent.change(control(label), { target: { value } });
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: Element): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

/** The live status of the key field. */
function keyStatus(): HTMLElement {
  const status = document.getElementById("key-availability-status");
  if (status === null) {
    throw new Error("The key field has no status.");
  }
  return status;
}

/** The wizard's hidden Idempotency-Key. */
function idempotencyKey(): string {
  return document.querySelector<HTMLInputElement>('input[name="idempotencyKey"]')?.value ?? "";
}

/** The heading of the step on screen (hidden steps are not in the accessibility tree). */
function stepHeading(): HTMLElement {
  const [heading, ...more] = screen
    .getAllByRole("heading", { level: 2 })
    .filter((element) => element.id.startsWith("wizard-step-"));
  if (heading === undefined || more.length > 0) {
    throw new Error("Not exactly one step is on screen.");
  }
  return heading;
}

function currentStep(): string {
  return stepHeading().textContent ?? "";
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

/** Presses the wizard's main button ("Continue" or "Create OTA"), as a click on it would. */
function press(name: string): void {
  const button = screen.getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

/**
 * Types `key` and lets the typing pause pass: the debounce timer is faked, so exactly one check starts, for the key
 * now in the field. The check itself (a server action over the mocked fetch) then runs on real promises.
 */
async function typeKey(key: string): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    type(WIZARD_STRINGS.keyLabel, key);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEY_CHECK_DELAY_MS);
    });
  } finally {
    vi.useRealTimers();
  }
}

interface Details {
  readonly name?: string;
  readonly key?: string;
  readonly countryCode?: string;
  readonly defaultCurrency?: string;
}

/** Fills step 1 (the time zone is preselected from the account) and waits until the key is checked. */
async function fillDetails(details: Details = {}): Promise<void> {
  // The prefilled key from the name is replaced before its check would start (fake timers, never advanced).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    type(WIZARD_STRINGS.nameLabel, details.name ?? "Acme Travel");
  } finally {
    vi.useRealTimers();
  }
  await typeKey(details.key ?? "acme");
  type(WIZARD_STRINGS.countryLabel, details.countryCode ?? "NO");
  type(WIZARD_STRINGS.currencyLabel, details.defaultCurrency ?? "EUR");
  await waitFor(() => expect(keyStatus().dataset["status"]).not.toBe("checking"), ACTION_WAIT);
}

/** Fills step 1, accepts the preselected plan and lands on the review. */
async function goToReview(details: Details = {}): Promise<void> {
  await fillDetails(details);
  press(WIZARD_STRINGS.next);
  expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan);
  press(WIZARD_STRINGS.next);
  expect(currentStep()).toBe(WIZARD_STEP_LABELS.review);
}

/** The wizard's form data as a submit would send it. */
function wizardFormData(): FormData {
  const form = document.querySelector("form");
  if (form === null) {
    throw new Error("No wizard form.");
  }
  return new FormData(form);
}

const IDLE: CreateOtaState = { status: "idle", fieldErrors: {} };

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
async function serverRenderAndHydrate(element: ReactElement): Promise<{ errors: unknown[]; root: Root }> {
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
  // The hydrated page is the server's page: same markup, nothing replaced in the browser.
  expect(container.innerHTML).toBe(serverDom);
  return { errors, root };
}

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.redirect.mockClear();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe008_portal",
    }),
  );
  cookieStore();
  routes();
}

/**
 * Once per file, before any test: what every wizard test runs first (the page's renders, a re-render on each typed
 * value, the live key check). The first run of those paths in a fresh worker is the slowest, and on a busy CI runner
 * it otherwise lands in the first test's own five seconds; here it has the budget of a wizard hook. Nothing of it
 * stays: each test gets a fresh API (`resetPlatformApi`), fresh mocks and globals (`restoreMocks`, `unstubGlobals`)
 * and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  await openWizard();
  await fillDetails();
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
}, OPEN_WIZARD_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

// ---- The key check -------------------------------------------------------------------------------------------------

describe("/otas/new: KeyAvailabilityField and checkKeyAvailability", () => {
  describe("in the opened wizard", () => {
    beforeEach(async () => {
      await openWizard();
    }, OPEN_WIZARD_TIMEOUT_MS);

    it("[PFE-008 AC1] shows that a typed key is taken without submitting, after one check once typing pauses [PF-10 AC1]", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        for (const typed of ["nor", "nord", "nordi", "nordic"]) {
          type(WIZARD_STRINGS.keyLabel, typed);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(KEY_CHECK_DELAY_MS - 100);
          });
        }
        // Still typing: nothing was checked yet.
        expect(calls("GET", "/v1/tenants/key-availability")).toHaveLength(0);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      } finally {
        vi.useRealTimers();
      }

      await waitFor(() => expect(keyStatus().textContent).toBe(WIZARD_STRINGS.keyTaken), ACTION_WAIT);
      expect(keyStatus().textContent).toContain("taken");
      expect(keyStatus().dataset["status"]).toBe("taken");
      // The status is announced (a live region) and read with the field.
      expect(keyStatus().getAttribute("role")).toBe("status");
      expect(descriptionsOf(control(WIZARD_STRINGS.keyLabel))).toContain(WIZARD_STRINGS.keyTaken);
      expect(descriptionsOf(control(WIZARD_STRINGS.keyLabel))).toContain(
        WIZARD_STRINGS.keyAddress("nordic.ota.example.com"),
      );

      // One check, for the key in the field, with the session and the end-user headers; nothing was submitted.
      const [check, ...more] = calls("GET", "/v1/tenants/key-availability");
      expect(more).toHaveLength(0);
      expect(new URL(check?.url ?? "").searchParams.get("key")).toBe("nordic");
      expect(check?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(check?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
      expect(check?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
      expect(check?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
      expect(calls("POST", "/v1/tenants")).toHaveLength(0);

      // "Continue" keeps the person on step 1 with the message at the key, still without a submission.
      type(WIZARD_STRINGS.nameLabel, "Nordic Fares");
      type(WIZARD_STRINGS.countryLabel, "SE");
      type(WIZARD_STRINGS.currencyLabel, "SEK");
      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.details);
      const summary = await screen.findByRole("alert");
      expect(within(summary).getByRole("link", { name: WIZARD_STRINGS.keyTaken })).toBeTruthy();
      expect(control(WIZARD_STRINGS.keyLabel).getAttribute("aria-invalid")).toBe("true");
      expect(calls("POST", "/v1/tenants")).toHaveLength(0);
    });

    it("[PFE-008 AC1] reports a broken key at once without a call, a reserved key, and a free key with its address", async () => {
      await typeKey("1acme");
      expect(keyStatus().textContent).toBe(WIZARD_STRINGS.keyInvalid);
      await typeKey("ab");
      expect(keyStatus().textContent).toBe(WIZARD_STRINGS.keyInvalid);
      expect(calls("GET", "/v1/tenants/key-availability")).toHaveLength(0);

      await typeKey("admin");
      await waitFor(() => expect(keyStatus().textContent).toBe(WIZARD_STRINGS.keyReserved), ACTION_WAIT);

      await typeKey("acme");
      await waitFor(() => expect(keyStatus().textContent).toBe(WIZARD_STRINGS.keyAvailable), ACTION_WAIT);
      expect(screen.getByText(WIZARD_STRINGS.keyAddress("acme.ota.example.com"))).toBeTruthy();
      expect(
        calls("GET", "/v1/tenants/key-availability").map((call) => new URL(call.url).searchParams.get("key")),
      ).toEqual(["admin", "acme"]);
    });

    it("[PFE-008 AC1] counts only the answer for the key still in the field, even when an older answer comes last", async () => {
      // The opened page has checked no key yet (the list of checks below shows it), so holding the answers from here on
      // holds every check.
      let answerAcme: (() => void) | undefined;
      routes({
        "GET /v1/tenants/key-availability": (request) =>
          new URL(request.url).searchParams.get("key") === "acme"
            ? new Promise<Response>((resolve) => {
                answerAcme = () => resolve(keyAvailability(request));
              })
            : keyAvailability(request),
      });

      // "acme" is checked, and the person types "nordic" while that answer is still on its way.
      await typeKey("acme");
      await waitFor(() => expect(answerAcme).toBeDefined(), ACTION_WAIT);
      await typeKey("nordic");
      await waitFor(() => expect(keyStatus().textContent).toBe(WIZARD_STRINGS.keyTaken), ACTION_WAIT);

      // The late answer for "acme" (free) arrives last and changes nothing: "nordic" stays taken.
      await act(async () => {
        answerAcme?.();
        // One turn of the event loop: the answer's promise chain (fetch, parsing, the action) runs on microtasks.
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
      expect(keyStatus().textContent).toBe(WIZARD_STRINGS.keyTaken);
      expect(screen.getByText(WIZARD_STRINGS.keyAddress("nordic.ota.example.com"))).toBeTruthy();
      expect(
        calls("GET", "/v1/tenants/key-availability").map((call) => new URL(call.url).searchParams.get("key")),
      ).toEqual(["acme", "nordic"]);
      type(WIZARD_STRINGS.nameLabel, "Nordic Fares");
      type(WIZARD_STRINGS.countryLabel, "SE");
      type(WIZARD_STRINGS.currencyLabel, "SEK");
      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.details);
    });

    it("[PFE-008 AC1] prefills the key from the name until the person types a key of their own", () => {
      expect(keyFromName("Acme Travel")).toBe("acmetravel");
      expect(keyFromName("  9 Lives Tours!")).toBe("livestours");
      expect(keyFromName("Café Évasion")).toBe("cafeevasion");
      expect(keyFromName("x".repeat(40))).toHaveLength(30);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        type(WIZARD_STRINGS.nameLabel, "Acme Travel");
        expect(control(WIZARD_STRINGS.keyLabel).value).toBe("acmetravel");
        expect(screen.getByText(WIZARD_STRINGS.keyAddress("acmetravel.ota.example.com"))).toBeTruthy();
        type(WIZARD_STRINGS.keyLabel, "ACME");
        // Typed in upper case, kept in lower case; the name no longer changes it.
        expect(control(WIZARD_STRINGS.keyLabel).value).toBe("acme");
        type(WIZARD_STRINGS.nameLabel, "Acme Travel Group");
        expect(control(WIZARD_STRINGS.keyLabel).value).toBe("acme");
        // An emptied key follows the name again.
        type(WIZARD_STRINGS.keyLabel, "");
        type(WIZARD_STRINGS.nameLabel, "Nordic Fares");
        expect(control(WIZARD_STRINGS.keyLabel).value).toBe("nordicfares");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("checkKeyAvailability answers `unchecked` when the API cannot, and refuses what is not a key without a call", async () => {
    routes({ "GET /v1/tenants/key-availability": () => apiError("RATE_LIMITED", 429) });
    expect(await checkKeyAvailability("acme")).toEqual({ key: "acme", status: "unchecked" });
    expect(await checkKeyAvailability("Acme")).toEqual({ key: "Acme", status: "invalid" });
    expect(await checkKeyAvailability(42)).toEqual({ key: "", status: "invalid" });
    expect(await checkKeyAvailability("a".repeat(65))).toEqual({ key: "", status: "invalid" });
    expect(calls("GET", "/v1/tenants/key-availability")).toHaveLength(1);

    routes();
    expect(await checkKeyAvailability("nordic")).toEqual({
      key: "nordic",
      status: "taken",
      storefrontHost: "nordic.ota.example.com",
    });
  });
});

// ---- Submitting --------------------------------------------------------------------------------------------------

describe("/otas/new: the wizard and the createOta action", () => {
  describe("in the wizard opened with the account and the plans", () => {
    beforeEach(async () => {
      await openWizard();
    }, OPEN_WIZARD_TIMEOUT_MS);

    it("[PFE-008 AC2] two quick submits send the same Idempotency-Key, the one the page made, and lead to one OTA [PF-10 AC2]", async () => {
      let failFirst: ((error: Error) => void) | undefined;
      routes({
        "POST /v1/tenants": () =>
          calls("POST", "/v1/tenants").length === 1
            ? new Promise<Response>((_resolve, reject) => {
                failFirst = reject;
              })
            : json(tenantCreated(), 202),
      });
      const key = idempotencyKey();
      expect(key).toMatch(UUID_V4);
      await goToReview();
      expect(
        within(document.querySelector("dl") as HTMLElement).getByText("acme.ota.example.com"),
      ).toBeTruthy();

      // A double click: two submits of the form before React has disabled the button, the second while the first
      // is still on its way.
      const form = screen
        .getByRole("button", { name: WIZARD_STRINGS.submit })
        .closest("form") as HTMLFormElement;
      fireEvent.submit(form);
      fireEvent.submit(form);
      await waitFor(() => expect(calls("POST", "/v1/tenants")).toHaveLength(1), ACTION_WAIT);
      // The first never got an answer (the connection dropped); the queued second goes out with the same key.
      failFirst?.(new TypeError("fetch failed: socket hang up"));

      expect(await redirectedTo()).toBe(`/otas/${TENANT_ID}/setup`);
      const posts = calls("POST", "/v1/tenants");
      expect(posts).toHaveLength(2);
      expect(posts.map((post) => post.headers.get("idempotency-key"))).toEqual([key, key]);
      const bodies = await Promise.all(posts.map((post) => post.json()));
      expect(bodies[0]).toEqual({
        name: "Acme Travel",
        key: "acme",
        countryCode: "NO",
        defaultCurrency: "EUR",
        timeZone: "Europe/Oslo",
        planCode: "early_access",
      });
      expect(bodies[1]).toEqual(bodies[0]);
      for (const post of posts) {
        expect(post.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
        expect(post.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
        expect(post.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
      }
    });

    it("[PFE-008 AC2] keeps one Idempotency-Key per opened wizard: every submit repeats it, a new opening makes a new one [PF-10 AC2]", async () => {
      routes({ "POST /v1/tenants": () => json(tenantCreated(), 202) });
      const first = idempotencyKey();
      await goToReview();

      // Submits of the same wizard, however many, carry the same key and land on the same OTA (the API replays it).
      const formData = wizardFormData();
      const outcomes = await Promise.allSettled([createOta(IDLE, formData), createOta(IDLE, formData)]);
      expect(
        outcomes.map((outcome) => (outcome.status === "rejected" ? String(outcome.reason) : "")),
      ).toEqual([
        `Error: NEXT_REDIRECT /otas/${TENANT_ID}/setup`,
        `Error: NEXT_REDIRECT /otas/${TENANT_ID}/setup`,
      ]);
      expect(calls("POST", "/v1/tenants").map((post) => post.headers.get("idempotency-key"))).toEqual([
        first,
        first,
      ]);
      cleanup();

      await openWizard();
      const second = idempotencyKey();
      expect(second).toMatch(UUID_V4);
      expect(second).not.toBe(first);
    });

    it("[PFE-008 AC3] offers only early_access before M5, preselected, whatever else listPlans answers [PF-10 AC3]", async () => {
      await fillDetails();
      press(WIZARD_STRINGS.next);

      expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan);
      expect(document.activeElement).toBe(stepHeading());
      const radios = screen.getAllByRole("radio") as HTMLInputElement[];
      expect(radios.map((radio) => radio.value)).toEqual(["early_access"]);
      expect(radios[0]?.checked).toBe(true);
      expect(screen.getByRole("radio", { name: /Early access/ })).toBe(radios[0]);
      expect(screen.queryByText(STARTER.name)).toBeNull();
      expect(screen.queryByText(GROWTH.name)).toBeNull();
      expect(screen.getByText(WIZARD_STRINGS.earlyAccessOnly)).toBeTruthy();

      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.review);
      expect(within(document.querySelector("dl") as HTMLElement).getByText(EARLY_ACCESS.name)).toBeTruthy();
    });

    it("[PFE-008 AC4] shows the tenant-limit message on the review and stays there [PF-10 AC4]", async () => {
      routes({
        "POST /v1/tenants": () =>
          apiError("UNPROCESSABLE", 422, { details: { reason: "tenant_limit", limit: 3 } }),
      });
      await goToReview();
      press(WIZARD_STRINGS.submit);

      const summary = await screen.findByRole("alert", {}, ACTION_WAIT);
      expect(within(summary).getByRole("listitem").textContent).toBe(WIZARD_STRINGS.tenantLimit(3));
      expect(summary.textContent).toContain("You already own 3 OTAs");
      expect(summary.textContent).not.toContain("The API's own text");
      await waitFor(() => expect(document.activeElement).toBe(summary), ACTION_WAIT);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.review);
      expect(navigation.redirect).not.toHaveBeenCalled();

      // Without a usable limit the message still says what happened; another UNPROCESSABLE is not the tenant limit.
      routes({
        "POST /v1/tenants": () => apiError("UNPROCESSABLE", 422, { details: { reason: "tenant_limit" } }),
      });
      expect((await createOta(IDLE, wizardFormData())).message).toBe(WIZARD_STRINGS.tenantLimit(undefined));
      routes({ "POST /v1/tenants": () => apiError("UNPROCESSABLE", 422, { details: { reason: "other" } }) });
      expect((await createOta(IDLE, wizardFormData())).message).toBe(ERROR_MESSAGES.UNPROCESSABLE);
    });

    it("returns to step 1 with the message at the key when the key was taken meanwhile (TENANT_KEY_UNAVAILABLE)", async () => {
      routes({ "POST /v1/tenants": () => apiError("TENANT_KEY_UNAVAILABLE", 409) });
      await goToReview();
      press(WIZARD_STRINGS.submit);

      await waitFor(() => expect(currentStep()).toBe(WIZARD_STEP_LABELS.details), ACTION_WAIT);
      expect(descriptionsOf(control(WIZARD_STRINGS.keyLabel))).toContain(WIZARD_STRINGS.keyUnavailable);
      const summary = screen.getByRole("alert");
      expect(within(summary).getByRole("link", { name: WIZARD_STRINGS.keyUnavailable })).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(summary), ACTION_WAIT);
      // The person's details stay.
      expect(control(WIZARD_STRINGS.nameLabel).value).toBe("Acme Travel");
      expect(control(WIZARD_STRINGS.countryLabel).value).toBe("NO");

      // The refused key cannot go on again, although its live check had said it was free.
      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.details);
      expect(descriptionsOf(control(WIZARD_STRINGS.keyLabel))).toContain(WIZARD_STRINGS.keyUnavailable);

      // A new key drops the old message at the field and gets its own live check, so the person sees it is free.
      await typeKey("acmetours");
      await waitFor(() => expect(keyStatus().textContent).toBe(WIZARD_STRINGS.keyAvailable), ACTION_WAIT);
      expect(control(WIZARD_STRINGS.keyLabel).getAttribute("aria-invalid")).toBeNull();
      expect(descriptionsOf(control(WIZARD_STRINGS.keyLabel))).not.toContain(WIZARD_STRINGS.keyUnavailable);
      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan);
      expect(calls("POST", "/v1/tenants")).toHaveLength(1);
    });

    it("moves between the steps with Back and Change, keeps the values, and focuses each step's heading", async () => {
      await goToReview();
      expect(document.activeElement).toBe(stepHeading());

      fireEvent.click(
        screen.getByRole("button", { name: `${WIZARD_STRINGS.change} ${WIZARD_STEP_LABELS.details}` }),
      );
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.details);
      expect(document.activeElement).toBe(stepHeading());
      expect(control(WIZARD_STRINGS.nameLabel).value).toBe("Acme Travel");
      expect(control(WIZARD_STRINGS.keyLabel).value).toBe("acme");
      expect(screen.queryByRole("button", { name: WIZARD_STRINGS.back })).toBeNull();

      press(WIZARD_STRINGS.next);
      fireEvent.click(screen.getByRole("button", { name: WIZARD_STRINGS.back }));
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.details);
      press(WIZARD_STRINGS.next);
      press(WIZARD_STRINGS.next);
      fireEvent.click(
        screen.getByRole("button", { name: `${WIZARD_STRINGS.change} ${WIZARD_STEP_LABELS.plan}` }),
      );
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan);
      expect(calls("POST", "/v1/tenants")).toHaveLength(0);
    });

    it("maps the API's field errors to the portal's messages on their step, and ends a dead session", async () => {
      routes({
        "POST /v1/tenants": () =>
          apiError("VALIDATION_FAILED", 400, {
            fieldErrors: [
              { path: "/countryCode", code: "unknown" },
              { path: "/timeZone", code: "unknown" },
            ],
          }),
      });
      await goToReview();
      press(WIZARD_STRINGS.submit);

      await waitFor(() => expect(currentStep()).toBe(WIZARD_STEP_LABELS.details), ACTION_WAIT);
      expect(descriptionsOf(control(WIZARD_STRINGS.countryLabel))).toContain(WIZARD_STRINGS.countryUnknown);
      expect(descriptionsOf(control(WIZARD_STRINGS.timeZoneLabel))).toContain(WIZARD_STRINGS.timeZoneUnknown);
      expect(screen.getByRole("alert").textContent).not.toContain("The API's own field text");

      const formData = wizardFormData();
      routes({ "POST /v1/tenants": () => apiError("UNAUTHENTICATED", 401) });
      await expect(createOta(IDLE, formData)).rejects.toThrow("NEXT_REDIRECT /sign-in?next=%2Fotas%2Fnew");
      routes({ "POST /v1/tenants": () => apiError("EMAIL_NOT_VERIFIED", 403) });
      await expect(createOta(IDLE, formData)).rejects.toThrow("NEXT_REDIRECT /verify-pending");
      routes({ "POST /v1/tenants": () => apiError("IDEMPOTENCY_KEY_REUSED", 409) });
      expect(await createOta(IDLE, formData)).toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
        step: "review",
        message: ERROR_MESSAGES.IDEMPOTENCY_KEY_REUSED,
      });
      fetchMock.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3100"));
      expect((await createOta(IDLE, formData)).message).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);

      // Without the wizard's key the action does not call the API: such a submit would not be safe to repeat.
      fetchMock.mockClear();
      formData.delete("idempotencyKey");
      expect(await createOta(IDLE, formData)).toMatchObject({ message: WIZARD_STRINGS.formExpired });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("offers the countries, active currencies and time zones of the reference data the API checks against", () => {
      // The vendored reference data that `pnpm db:seed:reference` loads into reference.countries, currencies and
      // time_zones (tools/reference-data).
      const csv = (name: string) =>
        readFileSync(join(repositoryRoot(), "tools/reference-data/data", name), "utf8")
          .trim()
          .split("\n")
          .slice(1)
          .map((line) => line.split(","));
      const countries = csv("countries.csv").map((row) => row[0]);
      const activeCurrencies = csv("currencies.csv")
        .filter((row) => row.at(-1) === "true")
        .map((row) => row[0]);
      const timeZones = new Set(csv("time_zones.csv").map((row) => row[0]));

      const values = (label: string) =>
        [...(control(label) as HTMLSelectElement).options].map((option) => option.value).filter(Boolean);
      expect(new Set(values(WIZARD_STRINGS.countryLabel))).toEqual(new Set(countries));
      expect(new Set(values(WIZARD_STRINGS.currencyLabel))).toEqual(new Set(activeCurrencies));
      const offeredZones = values(WIZARD_STRINGS.timeZoneLabel);
      expect(offeredZones.length).toBeGreaterThan(300);
      expect(offeredZones.filter((zone) => !timeZones.has(zone))).toEqual([]);
      // Names in English, sorted by name; the account's zone is preselected.
      expect(screen.getByRole("option", { name: "Norway" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "Euro (EUR)" })).toBeTruthy();
      expect(control(WIZARD_STRINGS.timeZoneLabel).value).toBe("Europe/Oslo");
    });

    it("renders one h1 and sends an unverified account to /verify-pending and an ended session to sign-in", async () => {
      expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
        WIZARD_STRINGS.title,
      ]);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.details);
      const progress = screen.getByRole("list", { name: WIZARD_STRINGS.progressLabel });
      expect(
        within(progress)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([WIZARD_STEP_LABELS.details, WIZARD_STEP_LABELS.plan, WIZARD_STEP_LABELS.review]);
      expect(within(progress).getByText(WIZARD_STEP_LABELS.details).getAttribute("aria-current")).toBe(
        "step",
      );
      expect(screen.getByText(WIZARD_STRINGS.stepOf(1, 3))).toBeTruthy();
      cleanup();

      routes({ "GET /v1/me": () => json(account({ emailVerified: false }), 200) });
      await expect(NewOtaPage()).rejects.toThrow("NEXT_REDIRECT /verify-pending");
      routes({ "GET /v1/me": () => apiError("UNAUTHENTICATED", 401) });
      await expect(NewOtaPage()).rejects.toThrow("NEXT_REDIRECT /sign-in?next=%2Fotas%2Fnew");
      // listPlans is public: no bearer token on it.
      for (const call of calls("GET", "/v1/plans")) {
        expect(call.headers.get("authorization")).toBeNull();
        expect(call.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
      }
    });
  });

  describe("in the wizard opened while listPlans fails", () => {
    beforeEach(async () => {
      routes({
        "GET /v1/plans": () => apiError("INTERNAL_ERROR", 500),
        "POST /v1/tenants": () => json(tenantCreated(), 202),
      });
      await openWizard();
    }, OPEN_WIZARD_TIMEOUT_MS);

    it("[PFE-008 AC3] still creates on early_access before M5 when listPlans fails", async () => {
      await fillDetails();
      press(WIZARD_STRINGS.next);
      expect(screen.queryAllByRole("radio")).toHaveLength(0);
      expect(screen.getByText(WIZARD_STRINGS.plansUnavailable)).toBeTruthy();
      expect(wizardFormData().get("planCode")).toBe("early_access");
      press(WIZARD_STRINGS.next);
      press(WIZARD_STRINGS.submit);
      expect(await redirectedTo()).toBe(`/otas/${TENANT_ID}/setup`);
    });
  });

  describe("in the wizard opened with the M5 switch on", () => {
    beforeEach(async () => {
      // With features.stripeBilling on (M5), every public plan is offered, in the API's order (PFE-020 adds the interval).
      routes({
        "GET /v1/me": () => json(account({ features: { ...FEATURES_OFF, stripeBilling: true } }), 200),
      });
      await openWizard();
    }, OPEN_WIZARD_TIMEOUT_MS);

    it("[PFE-008 AC3] offers the public plans in the API's order with the M5 switch on", async () => {
      await fillDetails();
      press(WIZARD_STRINGS.next);
      expect((screen.getAllByRole("radio") as HTMLInputElement[]).map((radio) => radio.value)).toEqual([
        "starter",
        "early_access",
        "growth",
      ]);
      expect(screen.queryByText(WIZARD_STRINGS.earlyAccessOnly)).toBeNull();
    });
  });

  it("checks step 1 before going on, in form order, and calls nothing", async () => {
    routes({ "GET /v1/me": () => json(account({ timeZone: "Mars/Olympus_Mons" }), 200) });
    await openWizard();
    // An account zone the server's Intl does not know is still offered (the API accepted it for the profile).
    expect(control(WIZARD_STRINGS.timeZoneLabel).value).toBe("Mars/Olympus_Mons");
    type(WIZARD_STRINGS.timeZoneLabel, "");
    press(WIZARD_STRINGS.next);

    const summary = await screen.findByRole("alert");
    expect(
      within(summary)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      WIZARD_STRINGS.nameRequired,
      WIZARD_STRINGS.keyRequired,
      WIZARD_STRINGS.countryRequired,
      WIZARD_STRINGS.currencyRequired,
      WIZARD_STRINGS.timeZoneRequired,
    ]);
    expect(currentStep()).toBe(WIZARD_STEP_LABELS.details);
    expect(descriptionsOf(control(WIZARD_STRINGS.countryLabel))).toContain(WIZARD_STRINGS.countryRequired);
    expect(control(WIZARD_STRINGS.countryLabel).getAttribute("aria-invalid")).toBe("true");
    expect(calls("POST", "/v1/tenants")).toHaveLength(0);
    expect(calls("GET", "/v1/tenants/key-availability")).toHaveLength(0);
  });

  it("renders on the server and hydrates in the browser without an error or a change", async () => {
    // The lists and the Idempotency-Key are made once, on the server, and reach the browser as props.
    const { errors, root } = await serverRenderAndHydrate(await NewOtaPage());
    expect(errors).toEqual([]);
    expect(idempotencyKey()).toMatch(UUID_V4);
    act(() => root.unmount());
  });
});

// ---- /dashboard ------------------------------------------------------------------------------------------------

describe("/dashboard", () => {
  it("lists my OTAs with status, plan, role and the storefront link https://<key>.<STOREFRONT_BASE_DOMAIN>/", async () => {
    routes({
      "GET /v1/tenants": () =>
        json(
          {
            data: [
              tenantSummary(),
              tenantSummary({
                id: SECOND_TENANT_ID,
                key: "nordic",
                name: "Nordic Fares",
                status: "provisioning",
                role: "agent",
                planCode: "legacy_plan",
                storefrontUrl: "https://book.nordicfares.example/",
              }),
            ],
          },
          200,
        ),
    });
    render(await DashboardPage());

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      DASHBOARD_STRINGS.title,
    ]);
    expect(screen.getByRole("link", { name: DASHBOARD_STRINGS.createOta }).getAttribute("href")).toBe(
      "/otas/new",
    );
    const cards = within(screen.getByRole("list", { name: DASHBOARD_STRINGS.listLabel })).getAllByRole(
      "article",
    );
    expect(cards).toHaveLength(2);

    const [acme, nordic] = cards as [HTMLElement, HTMLElement];
    expect(within(acme).getByRole("link", { name: "Acme Travel" }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}`,
    );
    expect(within(acme).getByText("Active")).toBeTruthy();
    expect(within(acme).getByText(EARLY_ACCESS.name)).toBeTruthy();
    expect(within(acme).getByText(ROLE_LABELS.owner)).toBeTruthy();
    expect(within(acme).getByText(DASHBOARD_STRINGS.testMode)).toBeTruthy();
    expect(within(acme).getByRole("link", { name: "acme.ota.example.com" }).getAttribute("href")).toBe(
      "https://acme.ota.example.com/",
    );

    // An OTA in set-up opens its set-up page; an unknown plan shows its code; the link is the key's sub-domain.
    expect(within(nordic).getByRole("link", { name: "Nordic Fares" }).getAttribute("href")).toBe(
      `/otas/${SECOND_TENANT_ID}/setup`,
    );
    expect(within(nordic).getByText("Setting up")).toBeTruthy();
    expect(within(nordic).getByText("legacy_plan")).toBeTruthy();
    expect(within(nordic).getByText(ROLE_LABELS.agent)).toBeTruthy();
    expect(within(nordic).getByRole("link", { name: "nordic.ota.example.com" }).getAttribute("href")).toBe(
      "https://nordic.ota.example.com/",
    );

    // listTenants and getMe with the session; listPlans (for the names) as a public call.
    expect(calls("GET", "/v1/tenants")[0]?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(calls("GET", "/v1/me")[0]?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(calls("GET", "/v1/plans")[0]?.headers.get("authorization")).toBeNull();
  });

  it("hides Create an OTA from an unverified account and shows the empty dashboard", async () => {
    routes({
      "GET /v1/me": () => json(account({ emailVerified: false }), 200),
      "GET /v1/tenants": () => json({ data: [] }, 200),
    });
    render(await DashboardPage());

    expect(screen.queryByRole("link", { name: DASHBOARD_STRINGS.createOta })).toBeNull();
    expect(screen.getByText(DASHBOARD_STRINGS.verifyFirst, { exact: false })).toBeTruthy();
    expect(screen.getByRole("link", { name: DASHBOARD_STRINGS.verifyLink }).getAttribute("href")).toBe(
      "/verify-pending",
    );
    expect(screen.getByRole("heading", { name: DASHBOARD_STRINGS.emptyTitle })).toBeTruthy();
    expect(screen.queryByText(DASHBOARD_STRINGS.empty)).toBeNull();
    cleanup();

    // A verified account without OTAs gets the call to create one; a failed getMe hides it.
    routes({ "GET /v1/tenants": () => json({ data: [] }, 200) });
    render(await DashboardPage());
    expect(screen.getByRole("link", { name: DASHBOARD_STRINGS.createOta })).toBeTruthy();
    expect(screen.getByText(DASHBOARD_STRINGS.empty)).toBeTruthy();
    cleanup();

    routes({
      "GET /v1/me": () => apiError("INTERNAL_ERROR", 500),
      "GET /v1/tenants": () => json({ data: [] }, 200),
    });
    render(await DashboardPage());
    expect(screen.queryByRole("link", { name: DASHBOARD_STRINGS.createOta })).toBeNull();
  });

  it("shows the portal's message when listTenants fails, and plan codes when listPlans fails", async () => {
    routes({ "GET /v1/tenants": () => apiError("RATE_LIMITED", 429) });
    render(await DashboardPage());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(DASHBOARD_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.RATE_LIMITED);
    expect(alert.textContent).not.toContain("The API's own text");
    cleanup();

    routes({
      "GET /v1/plans": () => apiError("INTERNAL_ERROR", 500),
      "GET /v1/tenants": () => json({ data: [tenantSummary()] }, 200),
    });
    render(await DashboardPage());
    expect(screen.getByText("early_access")).toBeTruthy();
  });
});
