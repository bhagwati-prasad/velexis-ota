// @vitest-environment happy-dom
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
  /** As Next.js's: rethrows what `redirect()` and `notFound()` above throw, and nothing else. */
  unstable_rethrow: vi.fn((error: unknown): void => {
    if (error instanceof Error && /^NEXT_(REDIRECT|NOT_FOUND)/.test(error.message)) {
      throw error;
    }
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/otas/new",
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

import {
  continueToPayment,
  retryPayment,
  retrySetup,
  type SetupRetry,
} from "@/app/(app)/otas/[tenantId]/setup/actions";
import { CheckoutForm } from "@/app/(app)/otas/[tenantId]/setup/checkout-form";
import SetupPage from "@/app/(app)/otas/[tenantId]/setup/page";
import { createOta, type CreateOtaState } from "@/app/(app)/otas/new/actions";
import { KEY_CHECK_DELAY_MS } from "@/app/(app)/otas/new/key-availability-field";
import NewOtaPage from "@/app/(app)/otas/new/page";
import { Wizard, type WizardProps } from "@/app/(app)/otas/new/wizard";
import { formatMoney } from "@/components/money";
import { SETUP_POLL_INTERVAL_MS } from "@/components/provisioning-progress";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { TENANT_ROLES, type TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  ERROR_MESSAGES,
  PRICING_STRINGS,
  SETUP_STEP_LABELS,
  SETUP_STRINGS,
  WIZARD_STEP_LABELS,
  WIZARD_STRINGS,
} from "@/lib/strings";

/**
 * PFE-020: the plan step and the Stripe Checkout hand-off of the create-OTA wizard, and the payment states of the
 * set-up page (flow signup-and-create-ota.md steps 5–8 and "Failure handling"; billing flow §B and §H; PF-71). The
 * wizard's M1 behaviour has its own file (wizard.test.tsx, PFE-008); this one checks what M5 adds, and that the switch
 * off keeps M1's.
 */

// ---- Builders (dummy values only: no real token, key or Stripe session) -------------------------------------------

type Schemas = components["schemas"];
type Account = Schemas["Account"];
type Plan = Schemas["Plan"];
type Tenant = Schemas["Tenant"];
type ProvisioningJob = Schemas["ProvisioningJob"];
type ProvisioningStatus = Schemas["ProvisioningStatus"];
type Subscription = Schemas["Subscription"];

const ACCESS_TOKEN = "pfe020-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-020 test)";
const TENANT_ID = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const JOB_ID = "job_01JB3K4N9Q3S7V1X5Z9B3D7F1H";
const WIZARD_KEY = "6f1c2b9e-4d3a-4c5b-8e7f-0a1b2c3d4e5f";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const PROVISIONING_PATH = `${TENANT_PATH}/provisioning`;
const RETRY_PATH = `${TENANT_PATH}/provisioning/retry`;
const SUBSCRIPTION_PATH = `${TENANT_PATH}/subscription`;
const CHECKOUT_SESSION_PATH = `${TENANT_PATH}/billing/checkout-session`;
const SETUP_PATH = `/otas/${TENANT_ID}/setup`;

/**
 * Stripe Checkout URLs as the API answers them (dummy session ids): each test's answer differs, so a redirect can only
 * match the answer it followed. Stripe's URLs carry a fragment the page needs, so it must survive.
 */
const CHECKOUT_URL =
  "https://checkout.stripe.com/c/pay/cs_test_PFE020wizardDummySession#fidPFE020dummyFragmentA";
const CONTINUE_URL =
  "https://checkout.stripe.com/c/pay/cs_test_PFE020continueDummySession#fidPFE020dummyFragmentB";
const RETRY_URL = "https://checkout.stripe.com/c/pay/cs_test_PFE020retryDummySession#fidPFE020dummyFragmentC";

/** The API's own texts, which must never reach the page (README §5). */
const RAW_API_MESSAGE = "The API's own text, never shown";

const FEATURES_OFF: Account["features"] = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};
const FEATURES_M5: Account["features"] = { ...FEATURES_OFF, stripeBilling: true };

function account(features: Account["features"] = FEATURES_OFF): Account {
  return {
    id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "anna.berg@example.com",
    emailVerified: true,
    fullName: "Anna Berg",
    locale: "en",
    timeZone: "Europe/Oslo",
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaEnrolmentRequired: false,
    isPlatformAdmin: false,
    createdAt: "2026-10-01T10:02:17Z",
    version: 3,
    memberships: [],
    features,
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

/** A plan Checkout can start monthly and yearly, with a 14-day trial. */
const STARTER = plan({
  code: "starter",
  name: "Starter",
  monthlyPrice: { amount: "49.00", currency: "EUR" },
  annualPrice: { amount: "490.00", currency: "EUR" },
  trialDays: 14,
  limits: { staffSeats: 3, apiKeys: 5, customDomains: 1, liveMode: true },
  checkoutAvailable: { month: true, year: true },
});
/** A plan with a monthly Stripe price only, without a trial. */
const GROWTH = plan({
  code: "growth",
  name: "Growth",
  monthlyPrice: { amount: "149.00", currency: "EUR" },
  limits: { staffSeats: 10, apiKeys: 20, customDomains: 3, liveMode: true },
  checkoutAvailable: { month: true, year: false },
});
/** The plan of M1, without any Stripe price. */
const EARLY_ACCESS = plan({ code: "early_access", name: "Early access", trialDays: 90 });
/** The public plans in the API's order. */
const PLANS = [STARTER, EARLY_ACCESS, GROWTH];

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_ID,
    key: "nordic",
    name: "Nordic Fares",
    legalName: null,
    status: "provisioning",
    suspensionReason: null,
    billingNotice: null,
    planCode: "starter",
    defaultCurrency: "EUR",
    countryCode: "NO",
    timeZone: "Europe/Oslo",
    supportEmail: null,
    storefrontEnvironment: "test",
    liveEnabledAt: null,
    primaryHost: "nordic.ota.example.com",
    schemaVersion: null,
    createdAt: new Date().toISOString(),
    activatedAt: null,
    version: 1,
    myRole: "owner",
    ...overrides,
  };
}

/** `createTenant`'s answer: the OTA, its job waiting for Checkout (M5) and the Checkout URL, or none. */
function tenantCreated(
  checkoutUrl: string | null,
  checkoutError?: Schemas["CheckoutError"],
): Schemas["TenantCreated"] {
  return {
    tenant: tenant(),
    provisioningJob: { id: JOB_ID, status: "queued" },
    checkoutUrl,
    ...(checkoutError === undefined ? {} : { checkoutError }),
  };
}

function job(overrides: Partial<ProvisioningJob> = {}): ProvisioningJob {
  return {
    id: JOB_ID,
    kind: "provision",
    status: "queued",
    step: null,
    steps: [],
    attempt: 0,
    maxAttempts: 5,
    error: null,
    ...overrides,
  };
}

/** A new OTA of M5 whose job waits for the payment: queued, never dispatched. */
function waitingForPayment(): ProvisioningStatus {
  return { tenantStatus: "provisioning", job: job(), initialKeysAvailable: false };
}

/** The set-up runs: the payment was confirmed and the job went out. */
function running(): ProvisioningStatus {
  return {
    tenantStatus: "provisioning",
    job: job({
      status: "running",
      step: "run_migrations",
      attempt: 1,
      steps: [
        {
          step: "create_schema",
          status: "succeeded",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ],
    }),
    initialKeysAvailable: false,
  };
}

/** The OTA failed because its Checkout was abandoned: the job canceled, never dispatched (billing flow §H). */
function abandoned(): ProvisioningStatus {
  return { tenantStatus: "failed", job: job({ status: "canceled" }), initialKeysAvailable: false };
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_01JB3K4P0R4T8W2Y6A0C4E8G2J",
    planCode: "starter",
    planName: "Starter",
    status: "incomplete",
    billingProvider: "stripe",
    billingInterval: "year",
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    banner: null,
    canManageInStripe: true,
    ...overrides,
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
        message: RAW_API_MESSAGE,
        status,
        requestId: "req_api_pfe020",
        ...(options.details === undefined ? {} : { details: options.details }),
        ...(options.fieldErrors === undefined
          ? {}
          : {
              fieldErrors: options.fieldErrors.map((fieldError) => ({
                ...fieldError,
                message: RAW_API_MESSAGE,
              })),
            }),
      },
    },
    status,
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

/**
 * Answers each call by `METHOD /path`. By default: an account before M5, the public plans, every key free, and an
 * owner's new OTA of M5 that waits for its payment.
 */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    "GET /v1/me": () => json(account(), 200),
    "GET /v1/plans": () => json({ data: PLANS }, 200),
    "GET /v1/tenants/key-availability": (request) => {
      const key = new URL(request.url).searchParams.get("key") ?? "";
      return json({ key, available: true, storefrontHost: `${key}.${settings.STOREFRONT_BASE_DOMAIN}` }, 200);
    },
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${PROVISIONING_PATH}`]: () => json(waitingForPayment(), 200),
    [`GET ${SUBSCRIPTION_PATH}`]: () => json(subscription(), 200),
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
      "x-request-id": "req_pfe020_portal",
    }),
  );
  nextHeaders.cookies.mockResolvedValue({
    get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
    has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
    set: vi.fn(),
  });
  routes();
}

// ---- Rendering, typing and waiting ---------------------------------------------------------------------------------

/**
 * Next.js handles the `redirect()` of a server action by navigating; in a component test the action runs in the page,
 * so its redirect error reaches this boundary, which shows where the browser would go.
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
 * The budget of a hook that opens `/otas/new` itself: its server render and first browser render build some 850
 * options (the countries, currencies and time zones) in happy-dom, a few hundred milliseconds alone and several times
 * that on a loaded CI runner. Only a hook that hangs runs out of it; the test bodies hold the steps they check.
 */
const OPEN_PAGE_TIMEOUT_MS = 30_000;

/**
 * How long a test waits for what a server action answers (a key check, a submit): a round trip through the real
 * `lib/api.ts` over the mocked fetch and a re-render. Testing Library's 1 s default is enough on an idle machine, not
 * always on a loaded CI runner; the test's own 5 s budget is unchanged.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

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

/** Presses the wizard's main button ("Continue" or the submit), as a click on it would. */
function press(name: string): void {
  const button = screen.getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

/** The heading of the wizard step on screen (hidden steps are not in the accessibility tree). */
function currentStep(): string {
  const [heading, ...more] = screen
    .getAllByRole("heading", { level: 2 })
    .filter((element) => element.id.startsWith("wizard-step-"));
  if (heading === undefined || more.length > 0) {
    throw new Error("Not exactly one step is on screen.");
  }
  return heading.textContent ?? "";
}

/** The live status of the key field. */
function keyStatus(): HTMLElement {
  const status = document.getElementById("key-availability-status");
  if (status === null) {
    throw new Error("The key field has no status.");
  }
  return status;
}

/** Fills step 1 (the time zone is preselected) with Nordic Fares, `nordic`, Norway and EUR, its key checked. */
async function fillDetails(): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    type(WIZARD_STRINGS.nameLabel, "Nordic Fares");
    type(WIZARD_STRINGS.keyLabel, "nordic");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEY_CHECK_DELAY_MS);
    });
  } finally {
    vi.useRealTimers();
  }
  type(WIZARD_STRINGS.countryLabel, "NO");
  type(WIZARD_STRINGS.currencyLabel, "EUR");
  await waitFor(() => expect(keyStatus().dataset["status"]).toBe("available"), ACTION_WAIT);
}

/** The interval switch of the plan step (M5). */
function annualSwitch(): HTMLInputElement {
  return screen.getByRole("switch", { name: WIZARD_STRINGS.annualBilling }) as HTMLInputElement;
}

/** The plan radios as `[code, enabled, checked]`. */
function planRadios(): [string, boolean, boolean][] {
  return (screen.getAllByRole("radio") as HTMLInputElement[]).map((radio) => [
    radio.value,
    !radio.disabled,
    radio.checked,
  ]);
}

/** The card of a plan: its radio's label. */
function planCard(code: string): HTMLElement {
  const radio = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${code}"]`);
  const label = radio === null ? null : document.querySelector<HTMLElement>(`label[for="${radio.id}"]`);
  if (label === null) {
    throw new Error(`No plan ${code} on screen.`);
  }
  return label;
}

/** The review's list of values, as `{term: description}`. */
function reviewValues(): Record<string, string> {
  const list = document.querySelector("section[aria-labelledby='wizard-step-review'] dl");
  const terms = Array.from(list?.querySelectorAll("dt") ?? []);
  return Object.fromEntries(
    terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]),
  );
}

/** The wizard of M5 with small option lists (the page's own lists are checked in wizard.test.tsx). */
function renderWizard(props: Partial<WizardProps> = {}): void {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(
    <RedirectBoundary>
      <Wizard
        idempotencyKey={WIZARD_KEY}
        storefrontBaseDomain={settings.STOREFRONT_BASE_DOMAIN}
        countries={[{ value: "NO", label: "Norway" }]}
        currencies={[{ value: "EUR", label: "Euro (EUR)" }]}
        timeZones={[{ value: "Europe/Oslo", label: "Europe/Oslo" }]}
        defaultTimeZone="Europe/Oslo"
        plans={PLANS}
        defaultPlanCode=""
        stripeBilling
        {...props}
      />
    </RedirectBoundary>,
  );
}

/** Renders `/otas/new` as the page builds it, inside the redirect boundary. */
async function openNewOtaPage(): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await NewOtaPage();
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/** The set-up page as the server renders it for `query`. */
async function setupPage(query: Record<string, string> = {}): Promise<ReactElement> {
  return SetupPage({
    params: Promise.resolve({ tenantId: TENANT_ID }),
    searchParams: Promise.resolve(query),
  });
}

/** Renders `/otas/<id>/setup?<query>` in the DOM. */
async function openSetup(query: Record<string, string> = {}): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await setupPage(query);
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/** Submits the form of the button named `name` (a form action of the page). */
function submitForm(name: string): void {
  const form = screen.getByRole("button", { name }).closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form);
}

/** The form data "Continue to payment" sends, as the page rendered it. */
function paymentFormData(): FormData {
  const form = screen.getByRole("button", { name: SETUP_STRINGS.continueToPayment }).closest("form");
  if (form === null) {
    throw new Error("No payment form.");
  }
  return new FormData(form);
}

/**
 * Waits until `check` passes, turning the event loop between tries (`setImmediate`, which is not faked), so a server
 * action started by a fake timer settles. Testing Library's `waitFor` ends with a `setTimeout(0)`, which never fires
 * under fake timers.
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

const IDLE: CreateOtaState = { status: "idle", fieldErrors: {} };

/** The wizard's form fields of M5, as a submit sends them. */
function wizardForm(fields: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const values: Record<string, string> = {
    idempotencyKey: WIZARD_KEY,
    name: "Nordic Fares",
    key: "nordic",
    countryCode: "NO",
    defaultCurrency: "EUR",
    timeZone: "Europe/Oslo",
    planCode: "starter",
    billingInterval: "month",
    ...fields,
  };
  for (const [name, value] of Object.entries(values)) {
    formData.set(name, value);
  }
  return formData;
}

/** The form "Continue to payment" posts. */
function continueForm(fields: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const values: Record<string, string> = {
    idempotencyKey: WIZARD_KEY,
    planCode: "starter",
    billingInterval: "year",
    ...fields,
  };
  for (const [name, value] of Object.entries(values)) {
    formData.set(name, value);
  }
  return formData;
}

/** The redirect an action ended with (its `NEXT_REDIRECT` rejection), or what it resolved to. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    return `resolved ${JSON.stringify(await promise)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The budget of the file-level warm-up below. */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: a first render of the wizard and of the set-up page, and a server action. The first
 * run of those paths in a fresh worker (the module graph of Next.js, React and happy-dom) is the slowest; on a busy
 * CI runner it would otherwise land in the first test's own five seconds. Nothing of it stays: each test gets a fresh
 * API, fresh mocks and globals (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  renderWizard();
  await fillDetails();
  cleanup();
  await openSetup();
  await outcome(continueToPayment(TENANT_ID, continueForm()));
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

// ---- The wizard from M5 ------------------------------------------------------------------------------------------

describe("/otas/new from M5: the plan step and the Checkout hand-off", () => {
  describe("on the plan step of the M5 wizard", () => {
    beforeEach(async () => {
      renderWizard();
      await fillDetails();
      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan);
    }, OPEN_PAGE_TIMEOUT_MS);

    it("shows the public plans with the Annual billing switch, each plan's price for the interval, whether Checkout can start it, and its trial", () => {
      // Monthly first: every public plan in the API's order; one without a Stripe price cannot be chosen.
      expect(annualSwitch().checked).toBe(false);
      expect(annualSwitch().getAttribute("aria-describedby")).toBe("field-billingInterval-description");
      expect(document.getElementById("field-billingInterval-description")?.textContent).toBe(
        WIZARD_STRINGS.annualBillingHint,
      );
      expect(planRadios()).toEqual([
        ["starter", true, false],
        ["early_access", false, false],
        ["growth", true, false],
      ]);
      expect(planCard("starter").textContent).toContain(`${formatMoney(STARTER.monthlyPrice)}`);
      expect(planCard("starter").textContent).toContain(WIZARD_STRINGS.perMonth);
      expect(planCard("starter").textContent).toContain(
        `${PRICING_STRINGS.trial}: ${PRICING_STRINGS.trialDays(14)}`,
      );
      expect(planCard("growth").textContent).toContain(
        `${PRICING_STRINGS.trial}: ${PRICING_STRINGS.noTrial}`,
      );
      expect(planCard("early_access").textContent).toContain(WIZARD_STRINGS.planNotOffered("month"));
      expect(planCard("starter").textContent).not.toContain(WIZARD_STRINGS.planNotOffered("month"));
      expect(screen.getByText(WIZARD_STRINGS.checkoutNote)).toBeTruthy();

      // Annual: the yearly prices; a plan without a yearly Stripe price cannot be chosen with it.
      fireEvent.click(screen.getByRole("radio", { name: /^Growth/ }));
      expect(planRadios()[2]).toEqual(["growth", true, true]);
      fireEvent.click(annualSwitch());
      expect(annualSwitch().checked).toBe(true);
      expect(planCard("starter").textContent).toContain(
        `${formatMoney(STARTER.annualPrice ?? STARTER.monthlyPrice)}`,
      );
      expect(planCard("starter").textContent).toContain(WIZARD_STRINGS.perYear);
      expect(planCard("growth").textContent).toContain(WIZARD_STRINGS.monthlyOnly);
      expect(planCard("growth").textContent).toContain(WIZARD_STRINGS.planNotOffered("year"));
      // The chosen Growth cannot be billed yearly, so it is no longer chosen and "Continue" asks for a plan.
      expect(planRadios()).toEqual([
        ["starter", true, false],
        ["early_access", false, false],
        ["growth", false, false],
      ]);
      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan);
      expect(
        within(screen.getByRole("alert")).getByRole("link", { name: WIZARD_STRINGS.planRequired }),
      ).toBeTruthy();
      expect(calls("POST", "/v1/tenants")).toHaveLength(0);
    });

    it("[PFE-020 AC1] sends the chosen plan and interval and redirects to the Checkout URL of the API's answer, never one built in the browser [PF-71 AC1]", async () => {
      routes({ "POST /v1/tenants": () => json(tenantCreated(CHECKOUT_URL), 202) });
      fireEvent.click(screen.getByRole("radio", { name: /^Starter/ }));
      fireEvent.click(annualSwitch());
      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.review);
      expect(reviewValues()).toMatchObject({
        [WIZARD_STEP_LABELS.plan]: "Starter",
        [WIZARD_STRINGS.billing]: WIZARD_STRINGS.intervals.year,
        [WIZARD_STRINGS.freeTrial]: PRICING_STRINGS.trialDays(14),
      });
      expect(reviewValues()[WIZARD_STRINGS.price]).toContain(
        `${formatMoney({ amount: "490.00", currency: "EUR" })}`,
      );
      expect(screen.getByText(WIZARD_STRINGS.reviewCheckout)).toBeTruthy();
      // Nothing on the page points at Stripe: the only Checkout URL is the one the API answers.
      expect(document.body.innerHTML).not.toContain("stripe.com");

      press(WIZARD_STRINGS.submitCheckout);
      expect(await redirectedTo()).toBe(CHECKOUT_URL);
      expect(navigation.redirect).toHaveBeenCalledTimes(1);
      expect(navigation.redirect).toHaveBeenCalledWith(CHECKOUT_URL);

      const [post, ...more] = calls("POST", "/v1/tenants");
      expect(more).toHaveLength(0);
      expect(post?.headers.get("idempotency-key")).toBe(WIZARD_KEY);
      expectPortalHeaders(post);
      expect(await post?.json()).toEqual({
        name: "Nordic Fares",
        key: "nordic",
        countryCode: "NO",
        defaultCurrency: "EUR",
        timeZone: "Europe/Oslo",
        planCode: "starter",
        billingInterval: "year",
      });
    });

    it("[PFE-020 AC2] goes to the set-up page when the answer has no Checkout URL, saying why", async () => {
      routes({
        "POST /v1/tenants": () =>
          json(tenantCreated(null, { code: "PROVIDER_ERROR", message: RAW_API_MESSAGE }), 202),
      });
      fireEvent.click(screen.getByRole("radio", { name: /^Growth/ }));
      press(WIZARD_STRINGS.next);
      expect(reviewValues()[WIZARD_STRINGS.billing]).toBe(WIZARD_STRINGS.intervals.month);
      press(WIZARD_STRINGS.submitCheckout);
      expect(await redirectedTo()).toBe(`${SETUP_PATH}?payment=PROVIDER_ERROR`);
      expect(await calls("POST", "/v1/tenants")[0]?.json()).toMatchObject({
        planCode: "growth",
        billingInterval: "month",
      });
    });

    it("returns to the plan step when the API refuses the plan for the interval (PLAN_NOT_AVAILABLE)", async () => {
      routes({ "POST /v1/tenants": () => apiError("PLAN_NOT_AVAILABLE", 422) });
      fireEvent.click(screen.getByRole("radio", { name: /^Starter/ }));
      press(WIZARD_STRINGS.next);
      press(WIZARD_STRINGS.submitCheckout);
      await waitFor(() => expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan), ACTION_WAIT);
      const summary = screen.getByRole("alert");
      expect(within(summary).getByRole("link", { name: ERROR_MESSAGES.PLAN_NOT_AVAILABLE })).toBeTruthy();
      expect(document.body.textContent).not.toContain(RAW_API_MESSAGE);
      expect(navigation.redirect).not.toHaveBeenCalled();
    });
  });

  it("[PFE-020 AC1] createOta follows the answer's https Checkout URL exactly, and never anything else", async () => {
    // Whatever https URL the API answers is where the browser goes, fragment included.
    const other = "https://checkout.stripe.com/c/pay/cs_test_PFE020otherDummySession#fidPFE020dummyFragmentD";
    routes({ "POST /v1/tenants": () => json(tenantCreated(other), 202) });
    expect(await outcome(createOta(IDLE, wizardForm()))).toBe(`NEXT_REDIRECT ${other}`);

    // An answer that is not an https URL is never followed: the set-up page offers "Continue to payment".
    for (const unusable of [
      "http://checkout.stripe.com/c/pay/cs_test_PFE020plainHttp",
      "javascript:alert(document.cookie)",
      "https://user:secret@checkout.stripe.com/c/pay/cs_test_PFE020credentials",
      "/otas/elsewhere",
    ]) {
      routes({ "POST /v1/tenants": () => json(tenantCreated(unusable), 202) });
      expect(await outcome(createOta(IDLE, wizardForm()))).toBe(
        `NEXT_REDIRECT ${SETUP_PATH}?payment=INTERNAL_ERROR`,
      );
    }

    // No URL: the reason when it is a code of the catalogue, otherwise Stripe's failure in general.
    routes({
      "POST /v1/tenants": () =>
        json(tenantCreated(null, { code: "NOT_A_CODE", message: RAW_API_MESSAGE }), 202),
    });
    expect(await outcome(createOta(IDLE, wizardForm()))).toBe(
      `NEXT_REDIRECT ${SETUP_PATH}?payment=PROVIDER_ERROR`,
    );
  });

  it("checks the billing interval it sends, and maps the API's interval error to the plan step", async () => {
    expect(await createOta(IDLE, wizardForm({ billingInterval: "week" }))).toMatchObject({
      status: "failed",
      step: "plan",
      fieldErrors: { billingInterval: WIZARD_STRINGS.intervalInvalid },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    routes({
      "POST /v1/tenants": () =>
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/billingInterval", code: "enum" }] }),
    });
    expect(await createOta(IDLE, wizardForm())).toMatchObject({
      status: "failed",
      step: "plan",
      fieldErrors: { billingInterval: WIZARD_STRINGS.intervalInvalid },
    });
  });

  it("starts without a chosen plan when the page's default cannot be billed monthly", () => {
    renderWizard({ plans: [EARLY_ACCESS], defaultPlanCode: "early_access" });
    expect(document.querySelector<HTMLInputElement>('input[name="planCode"]')?.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>('input[name="billingInterval"]')?.value).toBe("month");
  });

  it("links the missing plan to the first plan Checkout can start with the interval, also when the API lists early access first", async () => {
    // The seed's sort order puts early_access (no Stripe price) first; a disabled radio button cannot take the focus.
    renderWizard({ plans: [EARLY_ACCESS, GROWTH, STARTER] });
    await fillDetails();
    press(WIZARD_STRINGS.next);
    press(WIZARD_STRINGS.next);
    expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan);
    const link = within(screen.getByRole("alert")).getByRole("link", { name: WIZARD_STRINGS.planRequired });
    const target = (): HTMLInputElement | null =>
      document.querySelector<HTMLInputElement>(link.getAttribute("href") ?? "#none");
    expect(target()?.value).toBe("growth");
    expect(target()?.disabled).toBe(false);
    fireEvent.click(link);
    expect(document.activeElement).toBe(target());

    // Annual: Growth cannot be billed yearly, so the link leads to Starter.
    fireEvent.click(annualSwitch());
    expect(target()?.value).toBe("starter");
    expect(target()?.disabled).toBe(false);
    expect(document.querySelectorAll(link.getAttribute("href") ?? "#none")).toHaveLength(1);
  });
});

// ---- The page passes the switch: M1 with it off, M5 with it on ------------------------------------------------------

describe("/otas/new: the page and the M5 switch", () => {
  describe("with features.stripeBilling off (before M5)", () => {
    /** Opening the page and filling step 1 is the setup; the body holds the plan step, the review and the submit. */
    beforeEach(async () => {
      routes({
        "POST /v1/tenants": () =>
          json({ ...tenantCreated(null), tenant: tenant({ planCode: "early_access" }) }, 202),
      });
      await openNewOtaPage();
      await fillDetails();
      press(WIZARD_STRINGS.next);
    }, OPEN_PAGE_TIMEOUT_MS);

    it("[PFE-020 AC3] behaves as in M1: early access only, no interval, no Checkout, straight to the set-up page", async () => {
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.plan);
      expect(screen.queryByRole("switch")).toBeNull();
      expect(planRadios()).toEqual([["early_access", true, true]]);
      expect(screen.getByText(WIZARD_STRINGS.earlyAccessOnly)).toBeTruthy();
      expect(screen.queryByText(WIZARD_STRINGS.checkoutNote)).toBeNull();
      expect(document.querySelector('input[name="billingInterval"]')).toBeNull();

      press(WIZARD_STRINGS.next);
      expect(currentStep()).toBe(WIZARD_STEP_LABELS.review);
      expect(Object.keys(reviewValues())).not.toContain(WIZARD_STRINGS.billing);
      expect(screen.queryByText(WIZARD_STRINGS.reviewCheckout)).toBeNull();
      expect(screen.queryByRole("button", { name: WIZARD_STRINGS.submitCheckout })).toBeNull();

      press(WIZARD_STRINGS.submit);
      expect(await redirectedTo()).toBe(SETUP_PATH);
      expect(await calls("POST", "/v1/tenants")[0]?.json()).toEqual({
        name: "Nordic Fares",
        key: "nordic",
        countryCode: "NO",
        defaultCurrency: "EUR",
        timeZone: "Europe/Oslo",
        planCode: "early_access",
      });
    });
  });

  describe("with features.stripeBilling on (M5)", () => {
    beforeEach(async () => {
      routes({
        "GET /v1/me": () => json(account(FEATURES_M5), 200),
        "POST /v1/tenants": () => json(tenantCreated(CHECKOUT_URL), 202),
      });
      await openNewOtaPage();
      await fillDetails();
      press(WIZARD_STRINGS.next);
    }, OPEN_PAGE_TIMEOUT_MS);

    it("[PFE-020 AC1] offers the plans with the interval switch and hands over to the API's Checkout URL [PF-71 AC1]", async () => {
      expect(annualSwitch().checked).toBe(false);
      expect(planRadios().map(([code, enabled]) => [code, enabled])).toEqual([
        ["starter", true],
        ["early_access", false],
        ["growth", true],
      ]);
      fireEvent.click(screen.getByRole("radio", { name: /^Starter/ }));
      press(WIZARD_STRINGS.next);
      press(WIZARD_STRINGS.submitCheckout);
      expect(await redirectedTo()).toBe(CHECKOUT_URL);
      const [post] = calls("POST", "/v1/tenants");
      expect(post?.headers.get("idempotency-key")).toMatch(UUID_V4);
      expect(await post?.json()).toMatchObject({ planCode: "starter", billingInterval: "month" });
    });
  });
});

// ---- The set-up page: payment states (M5) --------------------------------------------------------------------------

describe("/otas/[tenantId]/setup from M5: the payment of a new OTA", () => {
  it("[PFE-020 AC2] a missing checkoutUrl shows Continue to payment instead of the steps, which redirects after createCheckoutSession", async () => {
    // The wizard's answer had no Checkout URL: the set-up page names the reason and offers the payment.
    await openSetup({ payment: "PROVIDER_ERROR" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Nordic Fares");
    expect(screen.getByRole("heading", { level: 2, name: SETUP_STRINGS.paymentTitle })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(SETUP_STRINGS.paymentUnavailable);
    // Instead of the steps: no progress, no polling.
    expect(screen.queryByRole("heading", { name: SETUP_STRINGS.stepsTitle })).toBeNull();
    expect(document.getElementById("setup-summary")).toBeNull();
    const panel = screen.getByRole("region", { name: SETUP_STRINGS.paymentTitle });
    expect(within(panel).getByText("Starter")).toBeTruthy();
    expect(within(panel).getByText(SETUP_STRINGS.intervals.year)).toBeTruthy();
    expectPortalHeaders(calls("GET", SUBSCRIPTION_PATH)[0]);

    // The form carries the plan and interval of the incomplete subscription and the page's Idempotency-Key.
    const formData = paymentFormData();
    expect(formData.get("planCode")).toBe("starter");
    expect(formData.get("billingInterval")).toBe("year");
    expect(String(formData.get("idempotencyKey"))).toMatch(UUID_V4);

    routes({
      [`POST ${CHECKOUT_SESSION_PATH}`]: () =>
        json({ url: CONTINUE_URL, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, 201),
    });
    submitForm(SETUP_STRINGS.continueToPayment);
    expect(await redirectedTo()).toBe(CONTINUE_URL);
    const [post, ...more] = calls("POST", CHECKOUT_SESSION_PATH);
    expect(more).toHaveLength(0);
    expectPortalHeaders(post);
    expect(post?.headers.get("idempotency-key")).toBe(formData.get("idempotencyKey"));
    expect(await post?.json()).toEqual({ planCode: "starter", billingInterval: "year" });
    expect(document.body.textContent).not.toContain(RAW_API_MESSAGE);
  });

  it("continueToPayment sends a double click with one key, and comes back with the reason when Stripe is not reached", async () => {
    routes({
      [`POST ${CHECKOUT_SESSION_PATH}`]: () =>
        json({ url: CONTINUE_URL, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, 201),
    });
    const form = continueForm();
    expect(
      await Promise.all([
        outcome(continueToPayment(TENANT_ID, form)),
        outcome(continueToPayment(TENANT_ID, form)),
      ]),
    ).toEqual([`NEXT_REDIRECT ${CONTINUE_URL}`, `NEXT_REDIRECT ${CONTINUE_URL}`]);
    expect(calls("POST", CHECKOUT_SESSION_PATH).map((post) => post.headers.get("idempotency-key"))).toEqual([
      WIZARD_KEY,
      WIZARD_KEY,
    ]);

    for (const [answer, code] of [
      [() => apiError("PROVIDER_ERROR", 502), "PROVIDER_ERROR"],
      [() => apiError("CONFLICT", 409, { details: { reason: "stripe_subscription_active" } }), "CONFLICT"],
      [() => apiError("PLAN_NOT_AVAILABLE", 422), "PLAN_NOT_AVAILABLE"],
      [() => apiError("FORBIDDEN", 403), "FORBIDDEN"],
      [
        () => json({ url: "javascript:alert(1)", expiresAt: new Date().toISOString() }, 201),
        "INTERNAL_ERROR",
      ],
    ] as const) {
      routes({ [`POST ${CHECKOUT_SESSION_PATH}`]: answer });
      expect(await outcome(continueToPayment(TENANT_ID, form))).toBe(
        `NEXT_REDIRECT ${SETUP_PATH}?payment=${code}`,
      );
    }

    // An ended session signs in again and comes back to the set-up page.
    routes({ [`POST ${CHECKOUT_SESSION_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    expect(await outcome(continueToPayment(TENANT_ID, form))).toBe(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: SETUP_PATH }).toString()}`,
    );

    // A form that is not the page's is refused without a call.
    fetchMock.mockClear();
    for (const broken of [
      { idempotencyKey: "short" },
      { planCode: "Not A Plan" },
      { billingInterval: "week" },
    ]) {
      expect(await outcome(continueToPayment(TENANT_ID, continueForm(broken)))).toBe(
        `NEXT_REDIRECT ${SETUP_PATH}?payment=VALIDATION_FAILED`,
      );
    }
    await expect(continueToPayment("ten_not-an-id", form)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the portal's words for the reason a payment did not start, and ignores what is not a code", async () => {
    await openSetup({ payment: "PLAN_NOT_AVAILABLE" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(SETUP_STRINGS.planUnavailable);
    expect(within(alert).getByRole("link", { name: SETUP_STRINGS.billingLink }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/billing`,
    );
    cleanup();

    await openSetup({ payment: "CONFLICT" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('[data-payment-notice="CONFLICT"]')?.getAttribute("role")).toBe("status");
    expect(document.body.textContent).toContain(SETUP_STRINGS.paymentAlreadyDone);
    cleanup();

    await openSetup({ payment: "<script>alert(1)</script>" });
    expect(document.querySelector("[data-payment-notice]")).toBeNull();
    expect(screen.getByRole("button", { name: SETUP_STRINGS.continueToPayment })).toBeTruthy();
    expect(document.body.textContent).not.toContain(RAW_API_MESSAGE);
  });

  it("back from Stripe (?checkout=success) keeps polling and explains that the confirmation can take a minute [PF-71 AC1]", async () => {
    routes({
      [`GET ${PROVISIONING_PATH}`]: sequence(
        () => json(waitingForPayment(), 200),
        () => json(waitingForPayment(), 200),
        () => json(running(), 200),
      ),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await openSetup({ checkout: "success" });
    // The webhook, not the redirect, starts the set-up: the page follows the progress instead of offering a payment.
    const note = document.querySelector('[data-checkout="success"]');
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.textContent).toBe(SETUP_STRINGS.checkoutConfirming);
    expect(screen.queryByRole("button", { name: SETUP_STRINGS.continueToPayment })).toBeNull();
    expect(document.getElementById("setup-summary")?.textContent).toBe(SETUP_STRINGS.summaryQueued);
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(0);
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_INTERVAL_MS);
    });
    await eventually(() => expect(calls("GET", PROVISIONING_PATH)).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_INTERVAL_MS);
    });
    await eventually(() =>
      expect(document.getElementById("setup-summary")?.textContent).toBe(
        SETUP_STRINGS.summaryRunning(1, Object.keys(SETUP_STEP_LABELS).length),
      ),
    );
    expect(calls("GET", PROVISIONING_PATH)).toHaveLength(3);
  });

  it("offers Continue to payment to owners only: finance members read who continues, other roles follow the progress", async () => {
    for (const role of TENANT_ROLES.filter(
      (value): value is Exclude<TenantRole, "owner"> => value !== "owner",
    )) {
      resetPlatformApi();
      routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ myRole: role }), 200) });
      await openSetup();
      expect(screen.queryByRole("button", { name: SETUP_STRINGS.continueToPayment })).toBeNull();
      if (role === "finance") {
        // Finance members read the subscription (viewBilling) but cannot pay (manageBilling).
        expect(screen.getByRole("heading", { level: 2, name: SETUP_STRINGS.paymentTitle })).toBeTruthy();
        expect(screen.getByText(SETUP_STRINGS.paymentOwnerOnly)).toBeTruthy();
      } else {
        // The subscription is not theirs to read: the page is the set-up progress, as in M1.
        expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(0);
        expect(document.getElementById("setup-summary")?.textContent).toBe(SETUP_STRINGS.summaryQueued);
      }
      cleanup();
      document.body.replaceChildren();
    }
  });

  it("an OTA failed by an abandoned Checkout offers Retry, which redirects to the new Checkout URL", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(abandoned(), 200),
      [`GET ${SUBSCRIPTION_PATH}`]: () => json(subscription({ status: "incomplete_expired" }), 200),
      [`POST ${RETRY_PATH}`]: () => json({ job: job(), checkoutUrl: RETRY_URL }, 202),
    });
    await openSetup();
    expect(screen.getByRole("heading", { level: 2, name: SETUP_STRINGS.abandonedTitle })).toBeTruthy();
    expect(screen.getByText(SETUP_STRINGS.abandonedText)).toBeTruthy();
    // Not the generic failure: no "Retry the set-up", no steps.
    expect(screen.queryByRole("button", { name: SETUP_STRINGS.retry })).toBeNull();
    expect(screen.queryByRole("heading", { name: SETUP_STRINGS.stepsTitle })).toBeNull();

    submitForm(SETUP_STRINGS.retryPayment);
    expect(await redirectedTo()).toBe(RETRY_URL);
    expect(calls("POST", RETRY_PATH)).toHaveLength(1);
    expectPortalHeaders(calls("POST", RETRY_PATH)[0]);
    cleanup();

    // Other roles read who can retry.
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed", myRole: "finance" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(abandoned(), 200),
      [`GET ${SUBSCRIPTION_PATH}`]: () => json(subscription({ status: "incomplete_expired" }), 200),
    });
    await openSetup();
    expect(screen.queryByRole("button", { name: SETUP_STRINGS.retryPayment })).toBeNull();
    expect(screen.getByText(SETUP_STRINGS.retryPaymentOwnerOnly)).toBeTruthy();
  });

  it("retryPayment without a new Checkout URL, or refused, comes back to the set-up page", async () => {
    routes({ [`POST ${RETRY_PATH}`]: () => json({ job: job(), checkoutUrl: null }, 202) });
    expect(await outcome(retryPayment(TENANT_ID, new FormData()))).toBe(`NEXT_REDIRECT ${SETUP_PATH}`);

    routes({ [`POST ${RETRY_PATH}`]: () => apiError("PROVISIONING_NOT_RETRYABLE", 409) });
    expect(await outcome(retryPayment(TENANT_ID, new FormData()))).toBe(
      `NEXT_REDIRECT ${SETUP_PATH}?payment=PROVISIONING_NOT_RETRYABLE`,
    );

    // The progress's own retry (ProvisioningProgress) follows a Checkout URL only when it is an https URL.
    routes({ [`POST ${RETRY_PATH}`]: () => json({ job: job(), checkoutUrl: RETRY_URL }, 202) });
    expect(await outcome(retrySetup(TENANT_ID))).toBe(`NEXT_REDIRECT ${RETRY_URL}`);
    navigation.redirect.mockClear();
    routes({ [`POST ${RETRY_PATH}`]: () => json({ job: job(), checkoutUrl: "javascript:alert(1)" }, 202) });
    const retried: SetupRetry = await retrySetup(TENANT_ID);
    expect(retried.status).toBe("ok");
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("before M5 (a manual trial) a waiting or failed set-up is the progress, as in M1", async () => {
    routes({
      [`GET ${SUBSCRIPTION_PATH}`]: () =>
        json(subscription({ status: "trialing", billingProvider: "manual", planCode: "early_access" }), 200),
    });
    await openSetup();
    expect(screen.queryByRole("heading", { name: SETUP_STRINGS.paymentTitle })).toBeNull();
    expect(document.getElementById("setup-summary")?.textContent).toBe(SETUP_STRINGS.summaryQueued);
    cleanup();

    // A subscription that cannot be read changes nothing either.
    routes({ [`GET ${SUBSCRIPTION_PATH}`]: () => apiError("NOT_FOUND", 404) });
    await openSetup();
    expect(document.getElementById("setup-summary")?.textContent).toBe(SETUP_STRINGS.summaryQueued);
    cleanup();

    // A running set-up never asks for the subscription.
    fetchMock.mockClear();
    routes({ [`GET ${PROVISIONING_PATH}`]: () => json(running(), 200) });
    await openSetup();
    expect(calls("GET", SUBSCRIPTION_PATH)).toHaveLength(0);
  });

  it("hands over to Stripe only through React: the payment forms are never forms a browser posts natively", async () => {
    // A server action as React sees it while rendering on the server (`$$FORM_ACTION`). Passed straight to a form, it
    // makes a form the browser posts natively before hydration, whose 303 to Stripe `form-action 'self'` blocks.
    const serverAction = Object.assign((_formData: FormData): Promise<void> => Promise.resolve(), {
      $$FORM_ACTION: () => ({
        name: "$ACTION_ID_pfe020",
        action: "",
        encType: "multipart/form-data",
        method: "POST",
      }),
    });
    expect(
      renderToString(
        <form action={serverAction}>
          <button type="submit">Pay</button>
        </form>,
      ),
    ).toContain('name="$ACTION_ID_pfe020"');
    // CheckoutForm renders a form React replays after hydration instead: no action id, no native POST.
    const html = renderToString(
      <CheckoutForm action={serverAction}>
        <button type="submit">Pay</button>
      </CheckoutForm>,
    );
    expect(html).not.toContain("$ACTION_ID_pfe020");
    expect(html).not.toMatch(/method="post"/i);
    expect(html).toContain('action="javascript:throw');

    // Both payment forms of the page are CheckoutForms.
    await openSetup();
    expect(
      screen.getByRole("button", { name: SETUP_STRINGS.continueToPayment }).closest("form")?.dataset["form"],
    ).toBe("checkout");
    cleanup();
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "failed" }), 200),
      [`GET ${PROVISIONING_PATH}`]: () => json(abandoned(), 200),
      [`GET ${SUBSCRIPTION_PATH}`]: () => json(subscription({ status: "incomplete_expired" }), 200),
    });
    await openSetup();
    expect(
      screen.getByRole("button", { name: SETUP_STRINGS.retryPayment }).closest("form")?.dataset["form"],
    ).toBe("checkout");
  });

  it("renders the payment panel on the server and hydrates it without an error or a change", async () => {
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
    expect(container.innerHTML).toBe(serverDom);
    expect(errors).toEqual([]);
    expect(screen.getByRole("button", { name: SETUP_STRINGS.continueToPayment })).toBeTruthy();
    act(() => root?.unmount());
  });
});
