// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { Component, type ReactNode } from "react";
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
  // As Next.js's own does for a real redirect() or notFound(): throws them again, returns for anything else.
  unstable_rethrow: vi.fn((error: unknown): void => {
    if (error instanceof Error && /^NEXT_(REDIRECT|NOT_FOUND)/.test(error.message)) {
      throw error;
    }
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
  notFound: navigation.notFound,
  unstable_rethrow: navigation.unstable_rethrow,
}));

const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => nextCache);

/**
 * React's `cache()` as Next.js runs it on the server: one memo per request (see ota-dashboard.test.tsx). Every
 * `routes()` call starts a new request.
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

/** The server actions as the page's components call them, counted: a form that is not sent must never reach them. */
const actionCalls = vi.hoisted(() => ({ connect: 0, keys: 0, poll: 0, velexis: 0 }));
vi.mock("@/app/(app)/otas/[tenantId]/payments/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof ActionsModule>();
  return {
    ...actual,
    connectStripe: (...args: Parameters<typeof actual.connectStripe>) => {
      actionCalls.connect += 1;
      return actual.connectStripe(...args);
    },
    submitStripeKeys: (...args: Parameters<typeof actual.submitStripeKeys>) => {
      actionCalls.keys += 1;
      return actual.submitStripeKeys(...args);
    },
    getKeysSubmissionStatus: (...args: Parameters<typeof actual.getKeysSubmissionStatus>) => {
      actionCalls.poll += 1;
      return actual.getKeysSubmissionStatus(...args);
    },
    switchToVelexis: (...args: Parameters<typeof actual.switchToVelexis>) => {
      actionCalls.velexis += 1;
      return actual.switchToVelexis(...args);
    },
  };
});

import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import {
  connectStripe,
  getKeysSubmissionStatus,
  submitStripeKeys,
  switchToVelexis,
  type ConnectState,
  type StripeKeysState,
  type UseVelexisState,
} from "@/app/(app)/otas/[tenantId]/payments/actions";
import PaymentsPage from "@/app/(app)/otas/[tenantId]/payments/page";
import {
  STRIPE_CONNECT_OUTCOMES,
  STRIPE_CONNECT_QUERY,
  paymentsPath,
  stripeConnectOutcomeOf,
} from "@/app/(app)/otas/[tenantId]/payments/stripe-connect";
import { SUBMISSION_POLL_INTERVAL_MS } from "@/components/submission-status";
import { contentSecurityPolicy } from "@/lib/csp";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { MilestoneFeatures, TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE, STRIPE_CONNECT_COOKIE } from "@/lib/session";
import {
  CONNECTION_STRINGS,
  ERROR_MESSAGES,
  FORM_STRINGS,
  STEP_UP_STRINGS,
  STRIPE_ACCOUNT_STRINGS,
  STRIPE_CONNECT_OUTCOME_STRINGS,
  STRIPE_KEYS_STRINGS,
  STRIPE_KEYS_SUBMISSION_STRINGS,
  USE_VELEXIS_STRINGS,
} from "@/lib/strings";

const ACCOUNT = STRIPE_ACCOUNT_STRINGS;
const KEYS = STRIPE_KEYS_STRINGS;
const SUBMISSION = STRIPE_KEYS_SUBMISSION_STRINGS;
const VELEXIS = USE_VELEXIS_STRINGS;

// ---- Builders (dummy values only: no real key, secret, code or account) -------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type Account = Schemas["Account"];
type PaymentConnection = Schemas["PaymentConnection"];
type CredentialSubmission = Schemas["CredentialSubmission"];
type Environment = "test" | "live";

const ACCESS_TOKEN = "pfe024-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-024 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const ME_PATH = "/v1/me";
const STEP_UP_PATH = "/v1/auth/step-up";
const PAYMENTS_PATH = `${TENANT_PATH}/payment-connections`;
const START_PATH = `${PAYMENTS_PATH}/stripe-connect/start`;
const keysPath = (environment: Environment) => `${PAYMENTS_PATH}/${environment}/api-keys`;
const useVelexisPath = (environment: Environment) => `${PAYMENTS_PATH}/${environment}/use-velexis`;
const SUBMISSION_ID = "crs_01JD4R7W1Y5A9C3E7G1J5M9Q3S";
const OTHER_SUBMISSION_ID = "crs_01JD4Q2S6V0X4Z8B2D6F0H4K8N";
const submissionPath = (id = SUBMISSION_ID) => `${TENANT_PATH}/credential-submissions/${id}`;
const PAYMENTS_PAGE = `/otas/${TENANT_ID}/payments`;
/** The text of an API answer; it must never reach the page. */
const API_TEXT = "The API's own text";

/** Stand-ins for an OTA's Stripe keys: the secrets may go to the API's body and nowhere else. */
const PUBLISHABLE_KEY = "pk_test_PFE024DummyPublishable01";
const SECRET_KEY = "rk_test_PFE024DummyRestrictedSecret01";
const WEBHOOK_SECRET = "whsec_PFE024DummyWebhookSigning01";
const LIVE_PUBLISHABLE_KEY = "pk_live_PFE024DummyPublishable02";
const CONNECTION_ID = "ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6X";
const LIVE_CONNECTION_ID = "ppc_01JA2ZH9K3N7Q1T5W9Z3B7D1F5";
const WEBHOOK_URL = `https://api.ota.example.com/webhooks/stripe/c/${CONNECTION_ID}`;
const WEBHOOK_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "payment_intent.amount_capturable_updated",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;
/** Stripe's authorize page with a dummy client id and state, as `startStripeConnect` answers it. */
const AUTHORIZE_URL =
  "https://connect.stripe.com/oauth/authorize?response_type=code&client_id=ca_PFE024DummyClient&scope=read_write&state=Xq7Lm2Np9Rt4Vw8Yb3Dc6Fg1Hj5Kk0Zs2Ae7Ui4Ow9Pq&redirect_uri=https%3A%2F%2Fplatform.example.com%2Fconnect%2Fstripe%2Fcallback";

/** The fixtures' instants are relative to the start of the file, never a calendar date. */
const START = Date.now();
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
function at(ms: number): string {
  return new Date(START + ms).toISOString();
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
    planCode: "growth",
    defaultCurrency: "EUR",
    countryCode: "NO",
    timeZone: "Europe/Oslo",
    supportEmail: null,
    storefrontEnvironment: "test",
    liveEnabledAt: null,
    primaryHost: "acme.ota.example.com",
    schemaVersion: "0002_m1",
    createdAt: at(-6 * DAY_MS),
    activatedAt: at(-6 * DAY_MS),
    version: 4,
    myRole: "owner",
    ...overrides,
  };
}

const M5_ON: MilestoneFeatures = {
  stripeBilling: true,
  ownStripe: true,
  settlements: true,
  ownAmadeus: true,
  customDomains: true,
  liveSwitch: true,
};

function account(features: Partial<MilestoneFeatures> = {}): Account {
  return {
    id: "acc_01JA2Z5K8N3Q6S9V2X5Z8B1D4F",
    email: "owner@example.com",
    emailVerified: true,
    fullName: "Ines Owner",
    locale: "en",
    timeZone: "UTC",
    mfaEnabled: true,
    mfaEnabledAt: at(-5 * DAY_MS),
    mfaEnrolmentRequired: false,
    isPlatformAdmin: false,
    createdAt: at(-7 * DAY_MS),
    version: 2,
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
    features: { ...M5_ON, ...features },
  };
}

/** The test connection on the Velexis account, as provisioning made it. */
function velexisConnection(overrides: Partial<PaymentConnection> = {}): PaymentConnection {
  return {
    id: CONNECTION_ID,
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
    version: 2,
    ...overrides,
  };
}

/** The test connection on the OTA's own account through Stripe Connect. */
function connectConnection(overrides: Partial<PaymentConnection> = {}): PaymentConnection {
  return velexisConnection({
    accountMode: "connect_standard",
    accountReference: "acct_1QPFE024Dummy",
    statementDescriptorSuffix: null,
    capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    connectedAt: at(-2 * DAY_MS),
    version: 3,
    ...overrides,
  });
}

/** The Connect connection Velexis was disconnected from in Stripe (`account.application.deauthorized`). */
function deauthorizedConnection(overrides: Partial<PaymentConnection> = {}): PaymentConnection {
  return connectConnection({ status: "disabled", disconnectedAt: at(-DAY_MS), version: 4, ...overrides });
}

/** The test connection on the OTA's own account through its API keys. */
function apiKeysConnection(overrides: Partial<PaymentConnection> = {}): PaymentConnection {
  return velexisConnection({
    accountMode: "api_keys",
    accountReference: "acct_1QPFE024Keys",
    publishableKey: PUBLISHABLE_KEY,
    statementDescriptorSuffix: null,
    connectedAt: at(-DAY_MS),
    webhookUrl: WEBHOOK_URL,
    version: 5,
    ...overrides,
  });
}

function submission(overrides: Partial<CredentialSubmission> = {}): CredentialSubmission {
  return {
    id: SUBMISSION_ID,
    kind: "stripe_api_keys",
    environment: "test",
    status: "pending",
    errorCode: null,
    errorMessage: null,
    createdAt: at(0),
    finishedAt: null,
    ...overrides,
  };
}

/** A failed submission as `getCredentialSubmission` answers it; its `errorMessage` must never reach the page. */
function failedSubmission(errorCode: string): CredentialSubmission {
  return submission({
    status: "failed",
    errorCode,
    errorMessage: `${API_TEXT}: Stripe answered 401 (api_key_invalid).`,
    finishedAt: at(MINUTE_MS),
  });
}

function keysSubmitted(environment: Environment = "test"): Response {
  return json(
    {
      submission: submission({ environment }),
      webhookUrl:
        environment === "test" ? WEBHOOK_URL : WEBHOOK_URL.replace(CONNECTION_ID, LIVE_CONNECTION_ID),
      webhookEvents: [...WEBHOOK_EVENTS],
    },
    202,
  );
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An error envelope of the platform API; its `message` and the field errors' messages must never reach the page. */
function apiError(
  code: string,
  status: number,
  extra: {
    readonly fieldErrors?: readonly { path: string; code: string }[];
    readonly details?: Record<string, unknown>;
    readonly headers?: Record<string, string>;
  } = {},
): Response {
  return json(
    {
      error: {
        code,
        message: `${API_TEXT}, never shown`,
        status,
        requestId: "req_api_pfe024",
        ...(extra.details === undefined ? {} : { details: extra.details }),
        ...(extra.fieldErrors === undefined
          ? {}
          : {
              fieldErrors: extra.fieldErrors.map((fieldError) => ({
                ...fieldError,
                message: `${API_TEXT} of a field`,
              })),
            }),
      },
    },
    status,
    extra.headers,
  );
}

/** A new portal session, as `POST /v1/auth/step-up` answers it (dummy tokens). */
function steppedUpSession(): Response {
  return json(
    {
      accessToken: "pfe024-dummy-stepped-up-access-token",
      accessTokenExpiresAt: at(15 * MINUTE_MS),
      refreshToken: "pfe024-dummy-stepped-up-refresh-token",
      refreshTokenExpiresAt: at(DAY_MS),
      account: {
        id: "acc_01JA2Z5K8N3Q6S9V2X5Z8B1D4F",
        email: "owner@example.com",
        fullName: "Ines Owner",
        emailVerified: true,
        mfaEnabled: true,
      },
    },
    200,
  );
}

/** The body of a call, read from a copy so the request stays readable. */
async function bodyOf(request: Request | undefined): Promise<unknown> {
  if (request === undefined) {
    throw new Error("No such call.");
  }
  return request.clone().json();
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call of `routes` in turn, the last one again for every call after. */
function inTurn(...answers: readonly Route[]): Route {
  let call = 0;
  return (request) => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer === undefined) {
      throw new Error("inTurn needs an answer");
    }
    return answer(request);
  };
}

/**
 * Answers each call by `METHOD /path`: by default an active owner's OTA with the M5 switches on and its Velexis test
 * connection; the start of Stripe Connect, the keys and the switch back accepted. A new answer table is a new request,
 * with nothing cached from the one before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${ME_PATH}`]: () => json(account(), 200),
    [`GET ${PAYMENTS_PATH}`]: () => json({ data: [velexisConnection()] }, 200),
    [`POST ${START_PATH}`]: () => json({ authorizeUrl: AUTHORIZE_URL, expiresAt: at(10 * MINUTE_MS) }, 200),
    [`PUT ${keysPath("test")}`]: () => keysSubmitted("test"),
    [`PUT ${keysPath("live")}`]: () => keysSubmitted("live"),
    [`GET ${submissionPath()}`]: () => json(submission(), 200),
    [`POST ${useVelexisPath("test")}`]: () => json(velexisConnection({ version: 4 }), 200),
    [`POST ${useVelexisPath("live")}`]: () => json(velexisConnection({ environment: "live" }), 200),
    [`POST ${STEP_UP_PATH}`]: () => steppedUpSession(),
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

/** `routes()` with these payment connections. */
function routesWith(connections: readonly PaymentConnection[], overrides: Record<string, Route> = {}): void {
  routes({ [`GET ${PAYMENTS_PATH}`]: () => json({ data: connections }, 200), ...overrides });
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

// ---- Rendering, timers and waiting ---------------------------------------------------------------------------------

/** The payments page inside the OTA layout, as the server renders it for one request. */
async function pageTree(query: Record<string, string> = {}): Promise<ReactNode> {
  return OtaLayout({
    children: await PaymentsPage({ params: params(), searchParams: Promise.resolve(query) }),
    params: params(),
  });
}

/**
 * Next.js handles `redirect()` by navigating; in a component test a server action runs in the page, so its error
 * reaches this boundary, which shows where the browser would go.
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
      <p role="status" data-redirected-to={this.state.target}>
        Redirected to {this.state.target}
      </p>
    );
  }
}

/** Opens the payments page (a page load), inside the redirect boundary. */
async function openPayments(query: Record<string, string> = {}): Promise<ReturnType<typeof render>> {
  return render(<RedirectBoundary>{await pageTree(query)}</RedirectBoundary>);
}

/**
 * The page rendered again for a new request in the same browser page, as a revalidation does: the client components
 * keep their state, the server parts show the API's new answers.
 */
async function refresh(
  view: ReturnType<typeof render>,
  overrides: Record<string, Route> = {},
): Promise<void> {
  routes(overrides);
  const tree = await pageTree();
  view.rerender(<RedirectBoundary>{tree}</RedirectBoundary>);
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
 * under fake timers: it ends with a `setTimeout(0)`, which never fires then. At most 200 turns: a bounded wait.
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
 * The wait for what a server action renders, in the tests that run on real timers: the action runs the real
 * `lib/api.ts` over the mocked fetch, which on a busy CI runner can outlast Testing Library's 1 s default. It stays
 * well inside the test's own budget.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/** The connection card of an environment. */
function card(environment: Environment = "test"): HTMLElement {
  return screen.getByRole("region", { name: CONNECTION_STRINGS.title(environment) });
}

/** The own Stripe account section, or `null`. */
function ownStripe(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-own-stripe]");
}

/** The "Connect with Stripe" part. */
function connectPart(): HTMLElement {
  return screen.getByRole("group", { name: ACCOUNT.connectTitle });
}

/** The keys part of an environment. */
function keysPart(environment: Environment = "test"): HTMLElement {
  return screen.getByRole("group", { name: KEYS.title(environment) });
}

/** Opens the keys form of an environment and answers it. */
function openKeysForm(environment: Environment = "test"): HTMLElement {
  const part = keysPart(environment);
  fireEvent.click(within(part).getByRole("button", { name: /Stripe keys$/ }));
  return within(part).getByRole("form", { name: KEYS.title(environment) });
}

function field(container: HTMLElement, label: string): HTMLInputElement {
  return within(container).getByLabelText(label);
}

function change(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

/** Fills the keys form with the OTA's test keys, as pasted (with stray spaces at the ends). */
function fillKeys(form: HTMLElement): void {
  change(field(form, KEYS.publishableKeyLabel), ` ${PUBLISHABLE_KEY} `);
  change(field(form, KEYS.secretKeyLabel), `${SECRET_KEY}\n`);
  change(field(form, KEYS.webhookSecretLabel), WEBHOOK_SECRET);
}

function submitForm(form: HTMLElement, name: string): void {
  fireEvent.submit(form, { submitter: within(form).getByRole("button", { name }) });
}

/** The status block of the keys submission an environment follows, or `null`. */
function statusBlock(environment: Environment = "test"): HTMLElement | null {
  // From the document: while the step-up dialog is open, the rest of the page is hidden from the accessibility tree.
  return document.querySelector<HTMLElement>(`[data-stripe-keys="${environment}"] [data-submission-status]`);
}

/** The entries of an error summary inside `container`. */
function summaryItems(container: HTMLElement): string[] {
  const element = within(container).queryByRole("alert", { name: FORM_STRINGS.errorSummaryTitle });
  return element === null ? [] : [...element.querySelectorAll("li")].map((item) => item.textContent ?? "");
}

/** Answers the open step-up dialog with a code. */
async function answerStepUp(code = "492039"): Promise<void> {
  let dialog: HTMLElement | undefined;
  await eventually(() => {
    dialog = screen.getByRole("dialog", { name: STEP_UP_STRINGS.title });
  });
  if (dialog === undefined) {
    throw new Error("no step-up dialog");
  }
  change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), code);
  const confirm = within(dialog).getByRole("button", { name: STEP_UP_STRINGS.submit });
  const form = confirm.closest("form");
  if (form === null) {
    throw new Error("The step-up button is in no form.");
  }
  fireEvent.submit(form, { submitter: confirm });
}

/** Where the redirect boundary says the browser went, or `undefined`. */
function redirectedTo(): string | undefined {
  return document.querySelector<HTMLElement>("[data-redirected-to]")?.dataset["redirectedTo"];
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
  element: ReactNode,
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

// ---- The actions' form data ----------------------------------------------------------------------------------------

function formData(fields: Readonly<Record<string, string>>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
}

/** The form data of the keys form, as the browser posts it. */
function keysForm(values: Partial<Record<string, string>> = {}): FormData {
  const all: Record<string, string | undefined> = {
    tenantId: TENANT_ID,
    environment: "test",
    publishableKey: PUBLISHABLE_KEY,
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    ...values,
  };
  const data = new FormData();
  for (const [name, value] of Object.entries(all)) {
    if (value !== undefined) {
      data.set(name, value);
    }
  }
  return data;
}

const CONNECT_IDLE: ConnectState = { status: "idle" };
const KEYS_IDLE: StripeKeysState = { status: "idle", publishableKey: "", fieldErrors: {} };
const VELEXIS_IDLE: UseVelexisState = { status: "idle" };

/** The cookie writes of the request scope's `cookies()` so far. */
async function cookieWrites(): Promise<unknown[][]> {
  const jar = (await nextHeaders.cookies()) as { set: ReturnType<typeof vi.fn> };
  return jar.set.mock.calls;
}

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  actionCalls.connect = 0;
  actionCalls.keys = 0;
  actionCalls.poll = 0;
  actionCalls.velexis = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = PAYMENTS_PAGE;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe024_portal",
    }),
  );
  const jar = {
    get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
    has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
    set: vi.fn(),
  };
  nextHeaders.cookies.mockResolvedValue(jar);
  routes();
}

/**
 * The budget of the file's warm-up hook. The first render of the page in a fresh worker (the page modules, the API
 * client, Testing Library, Radix's dialogs and React's DOM on their first run) and the first runs of the actions are
 * the slowest, and on a busy CI runner they otherwise land in the first test's own five seconds. The hook only stops
 * if it hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: the page opened with every M5 part, the keys form sent to its step-up, the four
 * actions run once, and the page rendered on the server and hydrated, so the test bodies hold only the steps they
 * check. Nothing of it stays: each test gets a fresh API (`resetPlatformApi`), fresh mocks and globals
 * (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routesWith([connectConnection(), velexisConnection({ id: LIVE_CONNECTION_ID, environment: "live" })], {
    [`PUT ${keysPath("test")}`]: () => apiError("REAUTH_REQUIRED", 401),
  });
  await openPayments();
  const form = openKeysForm();
  fillKeys(form);
  submitForm(form, KEYS.submit);
  await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  routes();
  await connectStripe(CONNECT_IDLE, formData({ tenantId: TENANT_ID })).catch(() => undefined);
  await submitStripeKeys(KEYS_IDLE, keysForm());
  await getKeysSubmissionStatus(TENANT_ID, SUBMISSION_ID);
  await switchToVelexis(VELEXIS_IDLE, formData({ tenantId: TENANT_ID, environment: "test" }));
  routesWith([connectConnection()]);
  const { root } = await serverRenderAndHydrate(await pageTree());
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

// ---- Stripe Connect (PF-61) ------------------------------------------------------------------------------------------

describe("Stripe Connect", () => {
  it("[PFE-024 AC1] Connect Stripe asks for a step-up, then sends the browser to the authorize URL the API answered [PF-61 AC1]", async () => {
    routes({
      [`POST ${START_PATH}`]: inTurn(
        () => apiError("REAUTH_REQUIRED", 401),
        () => json({ authorizeUrl: AUTHORIZE_URL, expiresAt: at(10 * MINUTE_MS) }, 200),
      ),
    });
    await openPayments();
    const part = connectPart();
    expect(within(part).getByText(ACCOUNT.connectStepUpNote)).toBeTruthy();
    const form = part.querySelector<HTMLFormElement>("[data-connect-stripe-form]");
    if (form === null) {
      throw new Error("no Connect form");
    }
    submitForm(form, ACCOUNT.connect);
    await answerStepUp();

    await eventually(() => expect(redirectedTo()).toBe(AUTHORIZE_URL));
    // The same start twice: refused for the step-up, then answered; the step-up in between, once.
    const [refused, started, ...more] = calls("POST", START_PATH);
    expect(more).toHaveLength(0);
    expect(refused).toBeDefined();
    expectSessionHeaders(started);
    expect(calls("POST", STEP_UP_PATH)).toHaveLength(1);
    expect(actionCalls.connect).toBe(2);
    // The OTA is remembered for the callback in the httpOnly Stripe Connect cookie: its id only, for an hour.
    expect(await cookieWrites()).toContainEqual([
      STRIPE_CONNECT_COOKIE,
      TENANT_ID,
      { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3600 },
    ]);
  });

  it("[PFE-024 AC1] never sends the browser to a URL that is not Stripe's authorize page, and remembers nothing then [PF-61 AC1]", async () => {
    for (const authorizeUrl of [
      "http://connect.stripe.com/oauth/authorize?state=x",
      "https://connect.stripe.com.evil.example/oauth/authorize?state=x",
      "https://user:secret@connect.stripe.com/oauth/authorize?state=x",
      "https://connect.stripe.com/oauth/authorize",
      "https://connect.stripe.com/oauth/authorize?state=x#fragment",
      "https://connect.stripe.com/oauth/authorize/../../evil?state=x",
      "https://evil.example/?next=https://connect.stripe.com/oauth/authorize?state=x",
      "javascript:alert(1)//https://connect.stripe.com/oauth/authorize?",
    ]) {
      routes({ [`POST ${START_PATH}`]: () => json({ authorizeUrl, expiresAt: at(MINUTE_MS) }, 200) });
      const state = await connectStripe(CONNECT_IDLE, formData({ tenantId: TENANT_ID }));
      expect([authorizeUrl, state]).toEqual([
        authorizeUrl,
        { status: "failed", code: "INTERNAL_ERROR", message: ACCOUNT.invalidAnswer },
      ]);
    }
    expect(navigation.redirect).not.toHaveBeenCalled();
    expect(await cookieWrites()).toEqual([]);
  });

  it("the CSP lets the browser leave for Stripe: the action redirects, no form posts to Stripe and no directive restricts navigation", async () => {
    await openPayments();
    const form = connectPart().querySelector("form");
    // The form posts to the portal's own server action, never to Stripe: `form-action 'self'` is all it needs.
    expect(form?.getAttribute("action") ?? "").not.toContain("stripe.com");
    await expect(connectStripe(CONNECT_IDLE, formData({ tenantId: TENANT_ID }))).rejects.toThrow(
      `NEXT_REDIRECT ${AUTHORIZE_URL}`,
    );
    // The policy restricts frames, form posts and fetches, not a top-level navigation (README §7).
    const policy = contentSecurityPolicy({
      nonce: "bm9uY2Utb2YtdGhlLW1pZGRsZXdhcmU=",
      otaAdminUrl: settings.PUBLIC_OTA_ADMIN_URL,
      development: false,
    });
    const directives = policy.split(";").map((directive) => directive.trim().split(/\s+/)[0]);
    expect(directives).not.toContain("navigate-to");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("explains each refusal of the start in the portal's words and follows the session's end", async () => {
    const cases = [
      ["MFA_REQUIRED", 403, ACCOUNT.mfaRequired],
      ["FEATURE_DISABLED", 403, ACCOUNT.featureDisabled],
      ["TENANT_NOT_ACTIVE", 409, ACCOUNT.notActive],
      ["FORBIDDEN", 403, ACCOUNT.forbidden],
      ["NOT_FOUND", 404, ACCOUNT.removed],
      ["RATE_LIMITED", 429, ACCOUNT.rateLimited],
      ["SERVICE_UNAVAILABLE", 503, ACCOUNT.unavailable],
      ["INTERNAL_ERROR", 500, ERROR_MESSAGES.INTERNAL_ERROR],
    ] as const;
    for (const [code, status, message] of cases) {
      routes({ [`POST ${START_PATH}`]: () => apiError(code, status) });
      const state = await connectStripe(CONNECT_IDLE, formData({ tenantId: TENANT_ID }));
      expect([code, state.code, state.message]).toEqual([code, code, message]);
    }
    routes({ [`POST ${START_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(connectStripe(CONNECT_IDLE, formData({ tenantId: TENANT_ID }))).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments`,
    );
    // A form without its OTA makes no call.
    fetchMock.mockClear();
    const expired = await connectStripe(CONNECT_IDLE, formData({ tenantId: "ten_x" }));
    expect(expired).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: ACCOUNT.formExpired,
      reload: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await cookieWrites()).toEqual([]);
  });

  it("MFA_REQUIRED on the page links to the security page; a cancelled step-up says nothing happened", async () => {
    routes({ [`POST ${START_PATH}`]: () => apiError("MFA_REQUIRED", 403) });
    await openPayments();
    const form = connectPart().querySelector<HTMLFormElement>("form");
    if (form === null) {
      throw new Error("no Connect form");
    }
    submitForm(form, ACCOUNT.connect);
    await waitFor(
      () => expect(within(connectPart()).getByRole("link", { name: ACCOUNT.mfaLink })).toBeTruthy(),
      ACTION_WAIT,
    );
    expect(within(connectPart()).getByText(ACCOUNT.mfaRequired)).toBeTruthy();
    cleanup();

    routes({ [`POST ${START_PATH}`]: () => apiError("REAUTH_REQUIRED", 401) });
    await openPayments();
    submitForm(connectPart().querySelector("form") as HTMLFormElement, ACCOUNT.connect);
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), ACTION_WAIT);
    expect(within(connectPart()).getByText(ACCOUNT.stepUpCancelled)).toBeTruthy();
    expect(redirectedTo()).toBeUndefined();
    expect(calls("POST", STEP_UP_PATH)).toHaveLength(0);
  });

  // One page load per outcome, each in its own test, so no single test renders the page fifteen times.
  it.each(STRIPE_CONNECT_OUTCOMES)(
    "[PFE-024 AC1] shows the outcome %s the callback names in the portal's words [PF-61 AC1]",
    async (outcome) => {
      await openPayments({ [STRIPE_CONNECT_QUERY]: outcome });
      const notice = document.querySelector<HTMLElement>("[data-stripe-connect-outcome]");
      const words = STRIPE_CONNECT_OUTCOME_STRINGS[outcome];
      expect(notice?.dataset["stripeConnectOutcome"]).toBe(outcome);
      expect(notice?.textContent).toBe(`${words.title}${words.text}`);
      expect(notice?.getAttribute("role")).toBe(words.tone === "error" ? "alert" : "status");
      expect(writes()).toEqual([]);
    },
  );

  it("[PFE-024 AC1] shows nothing for an outcome name it does not know, and words the step's three errors [PF-61 AC1]", async () => {
    // Errors map to "try again", the account of another OTA and a declined connection (the step's three).
    expect(STRIPE_CONNECT_OUTCOME_STRINGS.state_invalid.text).toContain("Try again");
    expect(STRIPE_CONNECT_OUTCOME_STRINGS.already_connected.text).toContain("another OTA");
    expect(STRIPE_CONNECT_OUTCOME_STRINGS.denied.text).toContain("declined");

    for (const value of ["<script>alert(1)</script>", "CONNECT_STATE_INVALID", "connected?x=1", ""]) {
      routes();
      await openPayments({ [STRIPE_CONNECT_QUERY]: value });
      expect(document.querySelector("[data-stripe-connect-outcome]")).toBeNull();
      expect(document.body.innerHTML).not.toContain("<script>alert");
      cleanup();
    }
    expect(stripeConnectOutcomeOf({ [STRIPE_CONNECT_QUERY]: ["denied", "connected"] })).toBe("denied");
    expect(paymentsPath(TENANT_ID, "connected")).toBe(`${PAYMENTS_PAGE}?stripeConnect=connected`);
    expect(paymentsPath(TENANT_ID)).toBe(PAYMENTS_PAGE);
  });

  it("[PFE-024 AC2] a connection Velexis was disconnected from in Stripe explains it and shows the reconnect choice [PF-61 AC2]", async () => {
    routesWith([deauthorizedConnection()]);
    await openPayments();

    const test = card("test");
    expect(test.querySelector('[data-notice="disabled"]')?.textContent).toBe(
      CONNECTION_STRINGS.paymentDisabled,
    );
    const notice = test.querySelector<HTMLElement>('[data-own-account-notice="deauthorized"]');
    expect(notice?.textContent).toContain(ACCOUNT.deauthorized);
    // The two ways on: connect again (the section's button, "Connect Stripe again") or use Velexis payments.
    const reconnect = within(notice ?? test).getByRole("link", { name: ACCOUNT.reconnectLink });
    expect(reconnect.getAttribute("href")).toBe("#connect-stripe");
    expect(document.getElementById("connect-stripe")).toBe(connectPart());
    expect(within(connectPart()).getByRole("button", { name: ACCOUNT.reconnect })).toBeTruthy();
    expect(within(test).getByRole("button", { name: VELEXIS.button })).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("[PFE-024 AC2] admins get the reconnect choice and read that owners switch back; finance members read it only [PF-61 AC2]", async () => {
    routesAs("admin", { [`GET ${PAYMENTS_PATH}`]: () => json({ data: [deauthorizedConnection()] }, 200) });
    await openPayments();
    let test = card("test");
    expect(within(test).getByRole("link", { name: ACCOUNT.reconnectLink })).toBeTruthy();
    expect(within(test).getByText(VELEXIS.ownerOnly)).toBeTruthy();
    expect(within(test).queryByRole("button", { name: VELEXIS.button })).toBeNull();
    cleanup();

    routesAs("finance", { [`GET ${PAYMENTS_PATH}`]: () => json({ data: [deauthorizedConnection()] }, 200) });
    await openPayments();
    test = card("test");
    expect(test.querySelector('[data-own-account-notice="deauthorized"]')?.textContent).toContain(
      ACCOUNT.deauthorizedReadOnly,
    );
    expect(within(test).queryByRole("link")).toBeNull();
    expect(within(test).queryByRole("button")).toBeNull();
    expect(ownStripe()?.querySelector("[data-own-stripe-role-note]")?.textContent).toBe(ACCOUNT.roleNote);
    expect(ownStripe()?.querySelector("form, input")).toBeNull();
  });

  it("a Connect account Stripe has not enabled yet says what to finish in Stripe", async () => {
    routesWith([
      connectConnection({
        status: "pending",
        capabilities: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false },
      }),
    ]);
    await openPayments();
    const test = card("test");
    expect(test.querySelector('[data-notice="pending"]')?.textContent).toBe(
      CONNECTION_STRINGS.paymentPending,
    );
    expect(test.querySelector('[data-own-account-notice="pending"]')?.textContent).toBe(
      ACCOUNT.connectPending,
    );
    expect(test.querySelector('[data-detail="chargesEnabled"] dd')?.textContent).toBe(CONNECTION_STRINGS.no);
    // Still connected: the section offers "Connect Stripe", not the reconnect.
    expect(within(connectPart()).getByRole("button", { name: ACCOUNT.connect })).toBeTruthy();
  });

  it("a connection a platform admin disabled sends to support, and nothing can be connected or submitted for it", async () => {
    routesWith([velexisConnection({ status: "disabled", disconnectedAt: null })]);
    await openPayments();
    expect(card("test").querySelector('[data-own-account-notice="disabled-by-velexis"]')?.textContent).toBe(
      ACCOUNT.disabledByVelexis,
    );
    expect(within(connectPart()).getByText(ACCOUNT.connectDisabledByVelexis)).toBeTruthy();
    expect(connectPart().querySelector("form")).toBeNull();
    expect(within(keysPart("test")).getByText(KEYS.connectionDisabled)).toBeTruthy();
    expect(keysPart("test").querySelector("form")).toBeNull();
    // The live environment has no connection: its keys can be submitted.
    expect(keysPart("live").querySelector("form")).not.toBeNull();
  });

  it("is not offered while the switch is off or getMe fails, and says why while the OTA is suspended", async () => {
    routes({ [`GET ${ME_PATH}`]: () => json(account({ ownStripe: false }), 200) });
    await openPayments();
    expect(ownStripe()).toBeNull();
    cleanup();
    routes({ [`GET ${ME_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openPayments();
    expect(ownStripe()).toBeNull();
    expect(card("test")).toBeTruthy();
    cleanup();
    routes({ [`GET ${ME_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(PaymentsPage({ params: params() })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments`,
    );

    routesAs(
      "owner",
      { [`GET ${PAYMENTS_PATH}`]: () => json({ data: [connectConnection()] }, 200) },
      "suspended",
    );
    await openPayments();
    expect(within(connectPart()).getByText(ACCOUNT.readOnly.suspended)).toBeTruthy();
    expect(within(keysPart("test")).getByText(KEYS.readOnly.suspended)).toBeTruthy();
    expect(ownStripe()?.querySelector("form")).toBeNull();
    // The switch back is disabled too, with why (the API answers TENANT_NOT_ACTIVE then).
    expect(within(card("test")).getByRole("button", { name: VELEXIS.button })).toHaveProperty(
      "disabled",
      true,
    );
    expect(card("test").querySelector("[data-use-velexis-read-only]")?.textContent).toBe(
      VELEXIS.readOnly.suspended,
    );
    expect(writes()).toEqual([]);
  });
});

// ---- Own Stripe keys (PF-62) -----------------------------------------------------------------------------------------

describe("own Stripe keys", () => {
  it("[PFE-024 AC2] asks for a step-up, shows the webhook URL and the events to enable, and polls to success [PF-62 AC1]", async () => {
    fakePollTimers();
    routes({
      [`PUT ${keysPath("test")}`]: inTurn(
        () => apiError("REAUTH_REQUIRED", 401),
        () => keysSubmitted("test"),
      ),
      [`GET ${submissionPath()}`]: inTurn(
        () => json(submission({ status: "verifying" }), 200),
        () => json(submission({ status: "applied", finishedAt: at(MINUTE_MS) }), 200),
      ),
    });
    const view = await openPayments();
    const form = openKeysForm();
    // Password fields for the secrets; the permissions a restricted key needs, Account: read included.
    expect(field(form, KEYS.secretKeyLabel).type).toBe("password");
    expect(field(form, KEYS.webhookSecretLabel).type).toBe("password");
    expect(field(form, KEYS.publishableKeyLabel).type).not.toBe("password");
    // Browsers ignore `off` on a password field: `new-password` keeps a saved portal password out of both.
    expect(field(form, KEYS.secretKeyLabel).getAttribute("autocomplete")).toBe("new-password");
    expect(field(form, KEYS.webhookSecretLabel).getAttribute("autocomplete")).toBe("new-password");
    expect(
      [...form.querySelectorAll("[data-restricted-permissions] li")].map((item) => item.textContent),
    ).toEqual([
      "PaymentIntents: write",
      "Refunds: write",
      "Charges: read",
      "Disputes: read",
      "Account: read",
    ]);
    expect(form.querySelector("[data-step-up-note]")?.textContent).toBe(KEYS.stepUpNote);
    fillKeys(form);
    submitForm(form, KEYS.submit);
    await answerStepUp();
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending"));

    // The same keys twice: refused for the step-up, then accepted; trimmed at their ends.
    const [refused, accepted, ...more] = calls("PUT", keysPath("test"));
    expect(more).toHaveLength(0);
    expectSessionHeaders(accepted);
    expect(await bodyOf(accepted)).toEqual(await bodyOf(refused));
    expect(await bodyOf(accepted)).toEqual({
      publishableKey: PUBLISHABLE_KEY,
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
    });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAYMENTS_PAGE);

    // The webhook endpoint to create in Stripe: its URL, the events and the reminder to send a test event.
    const webhook = document.querySelector<HTMLElement>('[data-webhook-setup="test"]');
    expect(webhook).not.toBeNull();
    expect(within(webhook ?? document.body).getByLabelText(KEYS.webhookUrlLabel)).toHaveProperty(
      "value",
      WEBHOOK_URL,
    );
    expect(
      [...(webhook?.querySelectorAll("[data-webhook-events] li") ?? [])].map((item) => item.textContent),
    ).toEqual([...WEBHOOK_EVENTS]);
    expect(webhook?.querySelector("[data-test-event-reminder]")?.textContent).toBe(KEYS.testEventReminder);
    // The form closes, the secrets are empty again, and neither is anywhere in the page.
    expect(keysPart().querySelector("form")?.hidden).toBe(true);
    expect(field(keysPart(), KEYS.secretKeyLabel).value).toBe("");
    expect(field(keysPart(), KEYS.webhookSecretLabel).value).toBe("");
    expect(document.body.innerHTML).not.toContain(SECRET_KEY);
    expect(document.body.innerHTML).not.toContain(WEBHOOK_SECRET);

    // Every 2 seconds, one read at a time, until the verification is final.
    expect(calls("GET", submissionPath())).toHaveLength(0);
    await advance(SUBMISSION_POLL_INTERVAL_MS - 1);
    expect(calls("GET", submissionPath())).toHaveLength(0);
    await advance(1);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("verifying"));
    expectSessionHeaders(calls("GET", submissionPath())[0]);
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("applied"));
    expect(statusBlock()?.querySelector("[data-submission-message]")?.textContent).toBe(
      SUBMISSION.applied("test"),
    );
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(2);

    // The revalidated page shows the OTA's own account, with the webhook URL, and the outcome stays in view.
    await refresh(view, { [`GET ${PAYMENTS_PATH}`]: () => json({ data: [apiKeysConnection()] }, 200) });
    expect(card("test").querySelector("[data-summary]")?.textContent).toBe(
      "Your Stripe account (your API keys), test, active",
    );
    expect(card("test").querySelector('[data-detail="webhookUrl"] dd')?.textContent).toBe(WEBHOOK_URL);
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("applied");
    expect(actionCalls.keys).toBe(2);
  });

  it("[PFE-024 AC2] polls to the failure and says why in words while the connection stays as it was [PF-62 AC1]", async () => {
    fakePollTimers();
    routes({
      [`GET ${submissionPath()}`]: () => json(failedSubmission("STRIPE_KEY_INVALID"), 200),
    });
    await openPayments();
    const form = openKeysForm();
    fillKeys(form);
    submitForm(form, KEYS.submit);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending"));
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("failed"));

    const block = statusBlock();
    expect(block?.querySelector("[data-submission-reason]")?.textContent).toBe(
      SUBMISSION.reasons["STRIPE_KEY_INVALID"],
    );
    expect(within(block ?? document.body).getByRole("status").textContent).toContain(SUBMISSION.failed);
    expect(card("test").querySelector("[data-summary]")?.textContent).toBe(
      "Velexis Stripe account, test, active",
    );
    expect(document.body.textContent).not.toContain("STRIPE_KEY_INVALID");
    expect(document.body.innerHTML).not.toContain(API_TEXT);
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(1);
  });

  it("[PFE-024 AC2] follows a submission the page found, and keeps polling through a rate limit [PF-62 AC1]", async () => {
    fakePollTimers();
    routes({
      [`GET ${PAYMENTS_PATH}`]: () =>
        json(
          {
            data: [
              velexisConnection({
                pendingSubmission: { id: SUBMISSION_ID, status: "verifying", errorCode: null },
              }),
            ],
          },
          200,
        ),
      [`GET ${submissionPath()}`]: inTurn(
        () => apiError("RATE_LIMITED", 429, { headers: { "retry-after": "5" } }),
        () => json(failedSubmission("STRIPE_LIVEMODE_MISMATCH"), 200),
      ),
    });
    await openPayments();
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("verifying");
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() =>
      expect(statusBlock()?.querySelector("[data-poll-note]")?.textContent).toBe(SUBMISSION.pollFailed),
    );
    // The Retry-After of 5 seconds, not the 2 seconds.
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(1);
    await advance(3_000);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("failed"));
    expect(statusBlock()?.querySelector("[data-submission-reason]")?.textContent).toBe(
      SUBMISSION.reasons["STRIPE_LIVEMODE_MISMATCH"],
    );
    expect(statusBlock()?.querySelector("[data-poll-note]")).toBeNull();
  });

  it("[PFE-024 AC2] keeps polling through an unavailable API or portal, and stops with the portal's words on another refusal [PF-62 AC1]", async () => {
    fakePollTimers();
    routesWith(
      [velexisConnection({ pendingSubmission: { id: SUBMISSION_ID, status: "pending", errorCode: null } })],
      {
        [`GET ${submissionPath()}`]: inTurn(
          () => apiError("SERVICE_UNAVAILABLE", 503),
          () => apiError("NOT_FOUND", 404),
        ),
      },
    );
    await openPayments();
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending");

    // The API unavailable: a note, and the next read 2 seconds later.
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() =>
      expect(statusBlock()?.querySelector("[data-poll-note]")?.textContent).toBe(SUBMISSION.pollFailed),
    );
    expect(calls("GET", submissionPath())).toHaveLength(1);

    // The portal itself unreachable (the action's own call fails, here before it reaches the API): tried again.
    nextHeaders.headers.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(actionCalls.poll).toBe(2));
    expect(calls("GET", submissionPath())).toHaveLength(1);
    expect(statusBlock()?.querySelector("[data-poll-note]")?.textContent).toBe(SUBMISSION.pollFailed);

    // Any other refusal stops polling with the portal's message, never the API's text.
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() =>
      expect(within(statusBlock() ?? document.body).getByRole("alert").textContent).toBe(
        `${SUBMISSION.pollStoppedTitle}${ERROR_MESSAGES.NOT_FOUND}`,
      ),
    );
    expect(statusBlock()?.querySelector("[data-poll-note]")).toBeNull();
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending");
    expect(document.body.innerHTML).not.toContain(API_TEXT);
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(2);
    expect(actionCalls.poll).toBe(3);
  });

  it("an ended session while the keys are verified goes to sign-in and back, and reads no more", async () => {
    fakePollTimers();
    // React reports the redirect it hands to the boundary; that report is not what this test checks.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    routesWith(
      [velexisConnection({ pendingSubmission: { id: SUBMISSION_ID, status: "verifying", errorCode: null } })],
      { [`GET ${submissionPath()}`]: () => apiError("UNAUTHENTICATED", 401) },
    );
    await openPayments();
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(redirectedTo()).toBe(`/sign-in?next=${encodeURIComponent(PAYMENTS_PAGE)}`));
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(1);
    expect(actionCalls.poll).toBe(1);
  });

  it("[PFE-024 AC2] a submission refused after an accepted one keeps following the accepted one [PF-62 AC1]", async () => {
    fakePollTimers();
    routes({
      [`PUT ${keysPath("test")}`]: inTurn(
        () => keysSubmitted("test"),
        () => apiError("RATE_LIMITED", 429),
      ),
      [`GET ${submissionPath()}`]: inTurn(
        () => json(submission({ status: "verifying" }), 200),
        () => json(submission({ status: "superseded", finishedAt: at(MINUTE_MS) }), 200),
      ),
    });
    await openPayments();
    const form = openKeysForm();
    fillKeys(form);
    submitForm(form, KEYS.submit);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending"));

    // The form again, refused this time: its message shows, the webhook endpoint stays, and the accepted submission
    // is still followed and read.
    const again = openKeysForm();
    fillKeys(again);
    submitForm(again, KEYS.submit);
    await eventually(() => expect(summaryItems(again)).toEqual([KEYS.rateLimited]));
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending");
    expect(document.querySelector('[data-webhook-setup="test"]')).not.toBeNull();
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("verifying"));
    // Newer keys of the same environment replaced it (another tab): it says so and polling ends.
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("superseded"));
    expect(statusBlock()?.querySelector("[data-submission-message]")?.textContent).toBe(
      SUBMISSION.superseded,
    );
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("PUT", keysPath("test"))).toHaveLength(2);
    expect(calls("GET", submissionPath())).toHaveLength(2);

    // The action itself: a refusal, by the portal's checks or by the API, hands the followed submission on.
    const followed = { id: SUBMISSION_ID, status: "verifying", errorCode: null } as const;
    const webhook = { url: WEBHOOK_URL, events: [...WEBHOOK_EVENTS] };
    const previous: StripeKeysState = { ...KEYS_IDLE, status: "submitted", submission: followed, webhook };
    expect(await submitStripeKeys(previous, keysForm({ webhookSecret: "" }))).toMatchObject({
      status: "failed",
      code: "VALIDATION_FAILED",
      submission: followed,
      webhook,
    });
    routes({ [`PUT ${keysPath("test")}`]: () => apiError("RATE_LIMITED", 429) });
    expect(await submitStripeKeys(previous, keysForm())).toMatchObject({
      status: "failed",
      code: "RATE_LIMITED",
      submission: followed,
      webhook,
    });
  });

  it("refuses keys that break the rules at their fields, without a call and without a secret in the state", async () => {
    const cases: readonly [Partial<Record<string, string>>, Partial<Record<string, string>>][] = [
      [
        { publishableKey: "", secretKey: "", webhookSecret: "" },
        {
          publishableKey: KEYS.problems.publishableKeyRequired,
          secretKey: KEYS.problems.secretKeyRequired,
          webhookSecret: KEYS.problems.webhookSecretRequired,
        },
      ],
      [{ publishableKey: LIVE_PUBLISHABLE_KEY }, { publishableKey: KEYS.problems.publishableKey("test") }],
      [{ secretKey: "sk_live_PFE024Dummy" }, { secretKey: KEYS.problems.secretKey("test") }],
      [{ secretKey: PUBLISHABLE_KEY }, { secretKey: KEYS.problems.secretKey("test") }],
      [{ secretKey: "sk_test_has spaces" }, { secretKey: KEYS.problems.secretKey("test") }],
      [{ webhookSecret: "whsec_short" }, { webhookSecret: KEYS.problems.webhookSecret }],
      [{ webhookSecret: "whsec_Has+Plus/Slash=" }, { webhookSecret: KEYS.problems.webhookSecret }],
      [{ secretKey: `sk_test_${"a".repeat(250)}` }, { secretKey: KEYS.problems.tooLong }],
    ];
    for (const [values, fieldErrors] of cases) {
      const state = await submitStripeKeys(KEYS_IDLE, keysForm(values));
      expect([values, state.status, state.code, state.fieldErrors]).toEqual([
        values,
        "failed",
        "VALIDATION_FAILED",
        fieldErrors,
      ]);
      const text = JSON.stringify(state);
      expect(text).not.toContain(SECRET_KEY);
      expect(text).not.toContain(WEBHOOK_SECRET);
    }
    // The live form takes the live keys' prefixes.
    const live = await submitStripeKeys(
      KEYS_IDLE,
      keysForm({ environment: "live", publishableKey: PUBLISHABLE_KEY, secretKey: "sk_live_PFE024Dummy" }),
    );
    expect(live.fieldErrors).toEqual({ publishableKey: KEYS.problems.publishableKey("live") });
    // Without its OTA or environment the form could not name its connection: an expired form.
    for (const hidden of [{ tenantId: "" }, { environment: "staging" }]) {
      const expired = await submitStripeKeys(KEYS_IDLE, keysForm(hidden));
      expect([hidden, expired.message, expired.reload]).toEqual([hidden, KEYS.formExpired, true]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts the API's field errors at their fields and shows its refusals in the portal's words", async () => {
    routes({
      [`PUT ${keysPath("test")}`]: () =>
        apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [
            { path: "/secretKey", code: "environment" },
            { path: "/webhookSecret", code: "maxLength" },
          ],
        }),
    });
    let state = await submitStripeKeys(KEYS_IDLE, keysForm());
    expect(state.fieldErrors).toEqual({
      secretKey: KEYS.problems.secretKey("test"),
      webhookSecret: KEYS.problems.tooLong,
    });
    expect(state.publishableKey).toBe(PUBLISHABLE_KEY);
    expect(JSON.stringify(state)).not.toContain(SECRET_KEY);

    const cases = [
      [
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/environment", code: "enum" }] }),
        KEYS.formExpired,
      ],
      [apiError("REAUTH_REQUIRED", 401), KEYS.stepUpCancelled],
      [apiError("MFA_REQUIRED", 403), KEYS.mfaRequired],
      [apiError("FEATURE_DISABLED", 403), KEYS.featureDisabled],
      [apiError("CONFLICT", 409, { details: { reason: "connection_disabled" } }), KEYS.connectionDisabled],
      [apiError("CONFLICT", 409), ERROR_MESSAGES.CONFLICT],
      [apiError("TENANT_NOT_ACTIVE", 409), KEYS.notActive],
      [apiError("FORBIDDEN", 403), KEYS.forbidden],
      [apiError("NOT_FOUND", 404), KEYS.removed],
      [apiError("RATE_LIMITED", 429), KEYS.rateLimited],
      [apiError("SERVICE_UNAVAILABLE", 503), ERROR_MESSAGES.SERVICE_UNAVAILABLE],
    ] as const;
    for (const [answer, message] of cases) {
      routes({ [`PUT ${keysPath("test")}`]: () => answer.clone() });
      state = await submitStripeKeys(KEYS_IDLE, keysForm());
      expect([state.code, state.message]).toEqual([state.code, message]);
      expect(state.fieldErrors).toEqual({});
    }
    routes({ [`PUT ${keysPath("test")}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(submitStripeKeys(KEYS_IDLE, keysForm())).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fpayments`,
    );
  });

  it("shows a refusal in the form's summary, keeps the secrets for the correction, and links MFA_REQUIRED to security", async () => {
    routes({ [`PUT ${keysPath("test")}`]: () => apiError("MFA_REQUIRED", 403) });
    await openPayments();
    const form = openKeysForm();
    fillKeys(form);
    submitForm(form, KEYS.submit);
    await waitFor(() => expect(summaryItems(form)).toEqual([KEYS.mfaRequired]), ACTION_WAIT);
    expect(within(form).getByRole("link", { name: KEYS.mfaLink }).getAttribute("href")).toBe(
      "/account/security",
    );
    // A password field drops the line break of the paste on its own; the action trims the ends again.
    expect(field(form, KEYS.secretKeyLabel).value).toBe(SECRET_KEY);
    expect(field(form, KEYS.webhookSecretLabel).value).toBe(WEBHOOK_SECRET);
    expect(field(form, KEYS.publishableKeyLabel).value).toBe(PUBLISHABLE_KEY);
    expect(statusBlock()).toBeNull();
  });

  it("the live environment takes its own keys before it has a connection, and an api_keys connection is replaced", async () => {
    routesWith([apiKeysConnection()]);
    await openPayments();
    expect(within(keysPart("test")).getByText(KEYS.introOwn)).toBeTruthy();
    expect(within(keysPart("test")).getByRole("button", { name: KEYS.openOwn })).toBeTruthy();
    expect(within(keysPart("live")).getByText(KEYS.introNoConnection)).toBeTruthy();
    const form = openKeysForm("live");
    change(field(form, KEYS.publishableKeyLabel), LIVE_PUBLISHABLE_KEY);
    change(field(form, KEYS.secretKeyLabel), "sk_live_PFE024DummySecret");
    change(field(form, KEYS.webhookSecretLabel), WEBHOOK_SECRET);
    submitForm(form, KEYS.submit);
    await waitFor(
      () => expect(statusBlock("live")?.dataset["submissionStatus"]).toBe("pending"),
      ACTION_WAIT,
    );
    expect(calls("PUT", keysPath("live"))).toHaveLength(1);
    expect(document.querySelector('[data-webhook-setup="live"]')).not.toBeNull();
  });

  it("[FIX-W40-PLATFORM AC7] offers the live own keys only while the live switch is on; the test keys stay", async () => {
    routes({ [`GET ${ME_PATH}`]: () => json(account({ liveSwitch: false }), 200) });
    await openPayments();

    expect(keysPart("test")).toBeTruthy();
    expect(screen.queryByRole("group", { name: KEYS.title("live") })).toBeNull();
    // "Connect with Stripe" stays: one OAuth serves both environments, and go-live copies it to live.
    expect(document.querySelector("[data-connect-stripe]")).not.toBeNull();
    expect(writes()).toEqual([]);
    cleanup();

    routes({ [`GET ${ME_PATH}`]: () => json(account({ liveSwitch: true }), 200) });
    await openPayments();
    expect(keysPart("test")).toBeTruthy();
    expect(keysPart("live")).toBeTruthy();
  });

  it("reads a submission with the session, revalidates only on a final status, and refuses ids that are none without a call", async () => {
    routes({ [`GET ${submissionPath()}`]: () => json(submission({ status: "verifying" }), 200) });
    expect(await getKeysSubmissionStatus(TENANT_ID, SUBMISSION_ID)).toEqual({
      status: "ok",
      submission: { id: SUBMISSION_ID, status: "verifying", errorCode: null },
    });
    expectSessionHeaders(calls("GET", submissionPath())[0]);
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
    routes({ [`GET ${submissionPath()}`]: () => json(submission({ status: "superseded" }), 200) });
    await getKeysSubmissionStatus(TENANT_ID, SUBMISSION_ID);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAYMENTS_PAGE);

    fetchMock.mockClear();
    for (const [tenantId, submissionId] of [
      [TENANT_ID, "crs_x"],
      [TENANT_ID, `${OTHER_SUBMISSION_ID}/../x`],
      ["ten_x", SUBMISSION_ID],
      [TENANT_ID, 42],
    ] as const) {
      const poll = await getKeysSubmissionStatus(tenantId, submissionId);
      expect(poll).toEqual({
        status: "failed",
        code: "NOT_FOUND",
        message: ERROR_MESSAGES.NOT_FOUND,
        transient: false,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- Back to Velexis payments ----------------------------------------------------------------------------------------

describe("back to Velexis payments", () => {
  it("[PFE-024 AC3] asks for a confirmation and a step-up, then switches, and the confirmation stays in view", async () => {
    routes({
      [`GET ${PAYMENTS_PATH}`]: () => json({ data: [connectConnection()] }, 200),
      [`POST ${useVelexisPath("test")}`]: inTurn(
        () => apiError("REAUTH_REQUIRED", 401),
        () => json(velexisConnection({ version: 4 }), 200),
      ),
    });
    const view = await openPayments();
    fireEvent.click(within(card("test")).getByRole("button", { name: VELEXIS.button }));

    // The confirmation warns that payments taken before stay on their account, and that Velexis disconnects itself.
    const confirm = await screen.findByRole("alertdialog", { name: VELEXIS.title("test") }, ACTION_WAIT);
    expect(confirm.textContent).toContain(VELEXIS.description);
    expect(confirm.textContent).toContain(VELEXIS.connectNote);
    expect(confirm.textContent).toContain(VELEXIS.stepUpNote);
    expect(confirm.textContent).not.toContain(VELEXIS.liveNote);
    expect(writes()).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: VELEXIS.confirm }));
    await answerStepUp();
    await eventually(() => expect(calls("POST", useVelexisPath("test"))).toHaveLength(2));
    await eventually(() => expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAYMENTS_PAGE));

    const [refused, switched] = calls("POST", useVelexisPath("test"));
    expect(refused).toBeDefined();
    expectSessionHeaders(switched);
    expect(calls("POST", STEP_UP_PATH)).toHaveLength(1);
    expect(actionCalls.velexis).toBe(2);

    // The revalidated page: the card is on the Velexis account, and the switch's confirmation stays where it was.
    await refresh(view, {
      [`GET ${PAYMENTS_PATH}`]: () => json({ data: [velexisConnection({ version: 4 })] }, 200),
    });
    await eventually(() =>
      expect(card("test").querySelector('[data-use-velexis-done="test"]')?.textContent).toBe(
        VELEXIS.switched("test"),
      ),
    );
    expect(card("test").querySelector("[data-summary]")?.textContent).toBe(
      "Velexis Stripe account, test, active",
    );
    expect(within(card("test")).queryByRole("button", { name: VELEXIS.button })).toBeNull();
  });

  it("[PFE-024 AC3] cancelling the confirmation or the step-up switches nothing", async () => {
    routes({
      [`GET ${PAYMENTS_PATH}`]: () => json({ data: [apiKeysConnection()] }, 200),
      [`POST ${useVelexisPath("test")}`]: () => apiError("REAUTH_REQUIRED", 401),
    });
    await openPayments();
    fireEvent.click(within(card("test")).getByRole("button", { name: VELEXIS.button }));
    let confirm = await screen.findByRole("alertdialog", { name: VELEXIS.title("test") }, ACTION_WAIT);
    // An API-keys connection: no disconnection in Stripe to mention.
    expect(confirm.textContent).not.toContain(VELEXIS.connectNote);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), ACTION_WAIT);
    expect(writes()).toEqual([]);

    fireEvent.click(within(card("test")).getByRole("button", { name: VELEXIS.button }));
    confirm = await screen.findByRole("alertdialog", { name: VELEXIS.title("test") }, ACTION_WAIT);
    fireEvent.click(within(confirm).getByRole("button", { name: VELEXIS.confirm }));
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), ACTION_WAIT);
    expect(within(card("test")).getByText(VELEXIS.stepUpCancelled)).toBeTruthy();
    expect(calls("POST", useVelexisPath("test"))).toHaveLength(1);
    expect(calls("POST", STEP_UP_PATH)).toHaveLength(0);
  });

  it("the live switch needs a verified payout account, and the refusal links to it", async () => {
    routes({
      [`GET ${PAYMENTS_PATH}`]: () =>
        json(
          {
            data: [velexisConnection(), connectConnection({ id: LIVE_CONNECTION_ID, environment: "live" })],
          },
          200,
        ),
      [`POST ${useVelexisPath("live")}`]: () => apiError("PAYOUT_ACCOUNT_REQUIRED", 422),
    });
    await openPayments();
    fireEvent.click(within(card("live")).getByRole("button", { name: VELEXIS.button }));
    const confirm = await screen.findByRole("alertdialog", { name: VELEXIS.title("live") }, ACTION_WAIT);
    expect(confirm.textContent).toContain(VELEXIS.liveNote);
    fireEvent.click(within(confirm).getByRole("button", { name: VELEXIS.confirm }));
    await waitFor(
      () => expect(within(card("live")).getByText(VELEXIS.payoutAccountRequired)).toBeTruthy(),
      ACTION_WAIT,
    );
    expect(
      within(card("live")).getByRole("link", { name: VELEXIS.payoutAccountLink }).getAttribute("href"),
    ).toBe(`${PAYMENTS_PAGE}/payout-account`);
    // The Velexis-mode test card offers no switch.
    expect(within(card("test")).queryByRole("button", { name: VELEXIS.button })).toBeNull();
  });

  it("is the owners' alone, is offered without the switch, and explains the API's refusals", async () => {
    routes({
      [`GET ${ME_PATH}`]: () => json(account({ ownStripe: false }), 200),
      [`GET ${PAYMENTS_PATH}`]: () => json({ data: [connectConnection()] }, 200),
    });
    await openPayments();
    // `useVelexisPayments` is behind no switch: an OTA can always come back.
    expect(within(card("test")).getByRole("button", { name: VELEXIS.button })).toBeTruthy();
    cleanup();
    for (const role of ["admin", "finance"] as const) {
      routesAs(role, { [`GET ${PAYMENTS_PATH}`]: () => json({ data: [connectConnection()] }, 200) });
      await openPayments();
      expect([role, within(card("test")).queryByRole("button", { name: VELEXIS.button })]).toEqual([
        role,
        null,
      ]);
      cleanup();
    }

    const cases = [
      ["MFA_REQUIRED", 403, VELEXIS.mfaRequired],
      ["TENANT_NOT_ACTIVE", 409, VELEXIS.notActive],
      ["FORBIDDEN", 403, VELEXIS.forbidden],
      ["NOT_FOUND", 404, VELEXIS.removed],
      ["RATE_LIMITED", 429, VELEXIS.rateLimited],
      ["INTERNAL_ERROR", 500, ERROR_MESSAGES.INTERNAL_ERROR],
    ] as const;
    for (const [code, status, message] of cases) {
      routes({ [`POST ${useVelexisPath("test")}`]: () => apiError(code, status) });
      const state = await switchToVelexis(
        VELEXIS_IDLE,
        formData({ tenantId: TENANT_ID, environment: "test" }),
      );
      expect([code, state.code, state.message]).toEqual([code, code, message]);
    }
    fetchMock.mockClear();
    const expired = await switchToVelexis(
      VELEXIS_IDLE,
      formData({ tenantId: TENANT_ID, environment: "staging" }),
    );
    expect([expired.message, expired.reload]).toEqual([VELEXIS.formExpired, true]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- The page ----------------------------------------------------------------------------------------------------------

describe("the page", () => {
  it("every action and the page send an ended session to sign-in and back, and an unverified account to /verify-pending", async () => {
    const signIn = `NEXT_REDIRECT /sign-in?next=${encodeURIComponent(PAYMENTS_PAGE)}`;
    const verifyPending = "NEXT_REDIRECT /verify-pending";
    const runs = [
      [`POST ${START_PATH}`, () => connectStripe(CONNECT_IDLE, formData({ tenantId: TENANT_ID }))],
      [`PUT ${keysPath("test")}`, () => submitStripeKeys(KEYS_IDLE, keysForm())],
      [`GET ${submissionPath()}`, () => getKeysSubmissionStatus(TENANT_ID, SUBMISSION_ID)],
      [
        `POST ${useVelexisPath("test")}`,
        () => switchToVelexis(VELEXIS_IDLE, formData({ tenantId: TENANT_ID, environment: "test" })),
      ],
      [`GET ${ME_PATH}`, () => PaymentsPage({ params: params() })],
    ] as const;
    for (const [route, run] of runs) {
      for (const [code, status, target] of [
        ["UNAUTHENTICATED", 401, signIn],
        ["TOKEN_EXPIRED", 401, signIn],
        ["EMAIL_NOT_VERIFIED", 403, verifyPending],
      ] as const) {
        routes({ [route]: () => apiError(code, status) });
        await expect(run(), `${route} ${code}`).rejects.toThrow(target);
      }
    }
    // Nothing was remembered for a callback that will never come.
    expect(await cookieWrites()).toEqual([]);
  });

  it("reads the connections and the switches with the session, and writes nothing on a page load", async () => {
    await openPayments();
    expectSessionHeaders(calls("GET", PAYMENTS_PATH)[0]);
    expectSessionHeaders(calls("GET", ME_PATH)[0]);
    expect(writes()).toEqual([]);
    expect(ownStripe()).not.toBeNull();
    expect(
      [...document.querySelectorAll("[data-stripe-keys]")].map((part) =>
        part.getAttribute("data-stripe-keys"),
      ),
    ).toEqual(["test", "live"]);
  });

  it("renders on the server and hydrates without an error or a change, with every part of the own account", async () => {
    routesWith([
      deauthorizedConnection({
        pendingSubmission: { id: SUBMISSION_ID, status: "failed", errorCode: "STRIPE_KEY_INVALID" },
      }),
      connectConnection({ id: LIVE_CONNECTION_ID, environment: "live", status: "pending" }),
    ]);
    const rendered = await serverRenderAndHydrate(await pageTree({ [STRIPE_CONNECT_QUERY]: "pending" }));
    try {
      expect(rendered.errors).toEqual([]);
      expect(rendered.container.innerHTML).toBe(rendered.serverDom);
      expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
      expect(rendered.container.querySelector("[data-stripe-connect-outcome]")).not.toBeNull();
      expect(rendered.container.querySelector('[data-own-account-notice="deauthorized"]')).not.toBeNull();
      expect(rendered.container.querySelector('[data-own-account-notice="pending"]')).not.toBeNull();
      expect(rendered.container.querySelectorAll("[data-use-velexis]")).toHaveLength(2);
      expect(rendered.container.querySelector("[data-connect-stripe-form]")).not.toBeNull();
      expect(rendered.container.querySelectorAll("[data-stripe-keys-form]")).toHaveLength(2);
      expect(rendered.container.querySelector('[data-submission-status="failed"]')).not.toBeNull();
      // A form sent before the page hydrated never goes out natively (a GET with the keys in the URL): React's guard
      // is the action of the keys forms and of "Connect Stripe" in the server's markup.
      const serverMarkup = document.createElement("div");
      serverMarkup.innerHTML = rendered.serverDom;
      const forms = [
        ...serverMarkup.querySelectorAll("form[data-stripe-keys-form], form[data-connect-stripe-form]"),
      ];
      expect(forms).toHaveLength(3);
      for (const form of forms) {
        expect(form.getAttribute("action")).toMatch(/^javascript:/);
      }
      // The secret fields (two per environment) have no value in the markup.
      const secrets = [...serverMarkup.querySelectorAll('input[type="password"]')];
      expect(secrets).toHaveLength(4);
      for (const input of secrets) {
        expect(input.hasAttribute("value")).toBe(false);
      }
    } finally {
      act(() => rendered.root.unmount());
    }
  });
});
