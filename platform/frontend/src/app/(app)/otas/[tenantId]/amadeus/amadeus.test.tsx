// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { Component, type ReactNode } from "react";
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
const actionCalls = vi.hoisted(() => ({ live: 0, credentials: 0, poll: 0 }));
vi.mock("@/app/(app)/otas/[tenantId]/amadeus/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof ActionsModule>();
  return {
    ...actual,
    requestLiveAccess: (...args: Parameters<typeof actual.requestLiveAccess>) => {
      actionCalls.live += 1;
      return actual.requestLiveAccess(...args);
    },
    submitOwnCredentials: (...args: Parameters<typeof actual.submitOwnCredentials>) => {
      actionCalls.credentials += 1;
      return actual.submitOwnCredentials(...args);
    },
    getSubmissionStatus: (...args: Parameters<typeof actual.getSubmissionStatus>) => {
      actionCalls.poll += 1;
      return actual.getSubmissionStatus(...args);
    },
  };
});

import {
  getSubmissionStatus,
  requestLiveAccess,
  submitOwnCredentials,
  type LiveRequestState,
  type OwnCredentialsState,
} from "@/app/(app)/otas/[tenantId]/amadeus/actions";
import {
  initialCredentialValues,
  officeChoices,
  officeIdsOf,
} from "@/app/(app)/otas/[tenantId]/amadeus/own-credentials-form";
import AmadeusPage from "@/app/(app)/otas/[tenantId]/amadeus/page";
import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import { SUBMISSION_POLL_INTERVAL_MS, SubmissionStatus } from "@/components/submission-status";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import type { MilestoneFeatures, TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  AMADEUS_LIVE_STRINGS,
  CONNECTION_STRINGS,
  ERROR_MESSAGES,
  FORM_STRINGS,
  OWN_CREDENTIALS_STRINGS,
  STEP_UP_STRINGS,
  SUBMISSION_STRINGS,
} from "@/lib/strings";

const LIVE = AMADEUS_LIVE_STRINGS;
const OWN = OWN_CREDENTIALS_STRINGS;
const PROBLEMS = OWN_CREDENTIALS_STRINGS.problems;
const SUBMISSION = SUBMISSION_STRINGS;

// ---- Builders (dummy values only: no real token, key, secret or account) -------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type Account = Schemas["Account"];
type Plan = Schemas["Plan"];
type AmadeusConnection = Schemas["AmadeusConnection"];
type CredentialSubmission = Schemas["CredentialSubmission"];
type Environment = "test" | "live";

const ACCESS_TOKEN = "pfe023-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-023 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const ME_PATH = "/v1/me";
const PLANS_PATH = "/v1/plans";
const STEP_UP_PATH = "/v1/auth/step-up";
const AMADEUS_PATH = `${TENANT_PATH}/amadeus-connections`;
const LIVE_REQUEST_PATH = `${AMADEUS_PATH}/live/request`;
const credentialsPath = (environment: Environment) => `${AMADEUS_PATH}/${environment}/credentials`;
const SUBMISSION_ID = "crs_01JD4Q2S6V0X4Z8B2D6F0H4K8N";
const OTHER_SUBMISSION_ID = "crs_01JD4R7W1Y5A9C3E7G1J5M9Q3S";
const submissionPath = (id = SUBMISSION_ID) => `${TENANT_PATH}/credential-submissions/${id}`;
const AMADEUS_PAGE = `/otas/${TENANT_ID}/amadeus`;
/** The text of an API answer; it must never reach the page. */
const API_TEXT = "The API's own text";

/** A stand-in for an OTA's Amadeus client secret: it may go to the API's body and nowhere else. */
const CLIENT_SECRET = "pfe023-dummy-client-secret-0123";
const CLIENT_ID = "acme-amadeus-client";
const NICE = "NCE1A0955";
const OSLO = "OSLN12345";
const OSLO_2 = "OSLN12346";

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

function plan(code: string, liveMode: boolean): Plan {
  return {
    code,
    name: code,
    description: null,
    monthlyPrice: { amount: "49.00", currency: "EUR" },
    annualPrice: null,
    trialDays: 0,
    limits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode },
    features: {},
    checkoutAvailable: { month: true, year: false },
  };
}

/** The test connection on the Velexis account, as provisioning made it. */
function testConnection(overrides: Partial<AmadeusConnection> = {}): AmadeusConnection {
  return {
    id: "sc_01JA2ZB9C3E7G1J5M9Q3S7V1X5",
    environment: "test",
    credentialSource: "velexis",
    status: "active",
    officeIds: [NICE],
    defaultOfficeId: NICE,
    queuingOfficeId: NICE,
    ownerOfficeId: NICE,
    clientId: null,
    ticketingDefaults: {},
    monitoredQueues: [],
    lastVerifiedAt: at(-DAY_MS),
    lastError: null,
    pendingSubmission: null,
    version: 3,
    ...overrides,
  };
}

/** The test connection once the OTA's own credentials were applied. */
function ownTestConnection(overrides: Partial<AmadeusConnection> = {}): AmadeusConnection {
  return testConnection({
    credentialSource: "tenant",
    officeIds: [OSLO, OSLO_2],
    defaultOfficeId: OSLO,
    queuingOfficeId: OSLO,
    ownerOfficeId: OSLO_2,
    clientId: CLIENT_ID,
    version: 4,
    ...overrides,
  });
}

/** The live connection `requestLiveAmadeus` inserts: the Velexis live account, no office yet. */
function pendingLiveConnection(overrides: Partial<AmadeusConnection> = {}): AmadeusConnection {
  return testConnection({
    id: "sc_01JD4P2R6T0W4Y8A2C6E0G4J8M",
    environment: "live",
    status: "pending_verification",
    officeIds: [],
    defaultOfficeId: null,
    queuingOfficeId: null,
    ownerOfficeId: null,
    lastVerifiedAt: null,
    version: 1,
    ...overrides,
  });
}

function submission(overrides: Partial<CredentialSubmission> = {}): CredentialSubmission {
  return {
    id: SUBMISSION_ID,
    kind: "amadeus",
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
    errorMessage: `${API_TEXT}: Amadeus answered 401 (invalid_client).`,
    finishedAt: at(MINUTE_MS),
  });
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
        requestId: "req_api_pfe023",
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
      accessToken: "pfe023-dummy-stepped-up-access-token",
      accessTokenExpiresAt: at(15 * MINUTE_MS),
      refreshToken: "pfe023-dummy-stepped-up-refresh-token",
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
 * Answers each call by `METHOD /path`: by default an active owner's OTA on a plan with live mode, the M5 switches on,
 * the Velexis test connection, and the submissions and the live request accepted. A new answer table is a new request,
 * with nothing cached from the one before.
 */
function routes(overrides: Record<string, Route> = {}): void {
  requestScope.next();
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${ME_PATH}`]: () => json(account(), 200),
    [`GET ${PLANS_PATH}`]: () => json({ data: [plan("starter", false), plan("growth", true)] }, 200),
    [`GET ${AMADEUS_PATH}`]: () => json({ data: [testConnection()] }, 200),
    [`POST ${LIVE_REQUEST_PATH}`]: () => json(pendingLiveConnection(), 202),
    [`PUT ${credentialsPath("test")}`]: () => json({ submission: submission() }, 202),
    [`PUT ${credentialsPath("live")}`]: () => json({ submission: submission({ environment: "live" }) }, 202),
    [`GET ${submissionPath()}`]: () => json(submission(), 200),
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

// ---- Rendering, timers and waiting ---------------------------------------------------------------------------------

/** The Amadeus page inside the OTA layout, as the server renders it for one request. */
async function pageTree(): Promise<ReactNode> {
  return OtaLayout({ children: await AmadeusPage({ params: params() }), params: params() });
}

/** Opens the Amadeus page (a page load). */
async function openAmadeus(): Promise<ReturnType<typeof render>> {
  return render(await pageTree());
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
  view.rerender(tree);
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
      <p role="status">Redirected to {this.state.target}</p>
    );
  }
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

/** A section of the page by its heading. */
function region(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function liveSection(): HTMLElement {
  return region(LIVE.title);
}

function ownSection(environment: Environment = "test"): HTMLElement {
  return region(OWN.title(environment));
}

/** The connection card of an environment. */
function card(environment: Environment = "test"): HTMLElement {
  return region(CONNECTION_STRINGS.title(environment));
}

function summaryOf(element: HTMLElement): string {
  return element.querySelector("[data-summary]")?.textContent ?? "";
}

/** Opens the own credentials form of an environment and answers it. */
function openForm(environment: Environment = "test"): HTMLElement {
  const section = ownSection(environment);
  fireEvent.click(within(section).getByRole("button", { name: /Amadeus credentials$/ }));
  return within(section).getByRole("form", { name: OWN.title(environment) });
}

function field<Element extends HTMLElement = HTMLInputElement>(form: HTMLElement, label: string): Element {
  return within(form).getByLabelText(label);
}

function change(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

/** Fills the own credentials form: two offices typed in lower case, the second one the owner office. */
function fillCredentials(form: HTMLElement): void {
  change(field(form, OWN.clientIdLabel), `  ${CLIENT_ID}  `);
  change(field(form, OWN.clientSecretLabel), CLIENT_SECRET);
  change(field<HTMLTextAreaElement>(form, OWN.officeIdsLabel), "osln12345\nOSLN12346");
  change(field<HTMLSelectElement>(form, OWN.defaultOfficeLabel), OSLO);
  change(field<HTMLSelectElement>(form, OWN.ownerOfficeLabel), OSLO_2);
}

function submitForm(form: HTMLElement, name: string): void {
  fireEvent.submit(form, { submitter: within(form).getByRole("button", { name }) });
}

/** The values of a select's options, in order. */
function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value);
}

/** The status block of the submission an own credentials section follows, or `null`. */
function statusBlock(environment: Environment = "test"): HTMLElement | null {
  // From the document: while the step-up dialog is open, the rest of the page is hidden from the accessibility tree.
  return document.querySelector<HTMLElement>(
    `[data-own-credentials="${environment}"] [data-submission-status]`,
  );
}

/** The entries of an error summary inside `container`. */
function summaryItems(container: HTMLElement): string[] {
  const element = within(container).queryByRole("alert", { name: FORM_STRINGS.errorSummaryTitle });
  return element === null ? [] : [...element.querySelectorAll("li")].map((item) => item.textContent ?? "");
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

/** The form data of the own credentials form, as the browser posts it. */
function credentialsForm(
  values: Partial<Record<string, string>> = {},
  hidden: Readonly<Record<string, string>> = { tenantId: TENANT_ID, environment: "test" },
): FormData {
  const data = new FormData();
  const all: Record<string, string> = {
    ...hidden,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    officeIds: `${OSLO}\n${OSLO_2}`,
    defaultOfficeId: OSLO,
    queuingOfficeId: "",
    ownerOfficeId: "",
  };
  for (const [name, value] of Object.entries({ ...all, ...values })) {
    if (value !== undefined) {
      data.set(name, value);
    }
  }
  return data;
}

const CREDENTIALS_IDLE: OwnCredentialsState = {
  status: "idle",
  values: { clientId: "", officeIds: "", defaultOfficeId: "", queuingOfficeId: "", ownerOfficeId: "" },
  fieldErrors: {},
};

const LIVE_IDLE: LiveRequestState = { status: "idle", note: "" };

function liveForm(note?: string, tenantId = TENANT_ID): FormData {
  const data = new FormData();
  data.set("tenantId", tenantId);
  if (note !== undefined) {
    data.set("note", note);
  }
  return data;
}

/** A fresh mocked platform API and request scope: the default routes, the session cookie, the end user's headers. */
function resetPlatformApi(): void {
  actionCalls.live = 0;
  actionCalls.credentials = 0;
  actionCalls.poll = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = AMADEUS_PAGE;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe023_portal",
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
 * client, Testing Library, Radix's dialog and React's DOM on their first run) and the first runs of the actions are
 * the slowest, and on a busy CI runner they otherwise land in the first test's own five seconds. The hook only stops if
 * it hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Once per file, before any test: the page opened with every M5 section, the three actions run once, and the page
 * rendered on the server and hydrated, so the test bodies hold only the steps they check. Nothing of it stays: each
 * test gets a fresh API (`resetPlatformApi`), fresh mocks and globals (`restoreMocks`, `unstubGlobals`) and an empty
 * document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({ [`PUT ${credentialsPath("test")}`]: () => apiError("REAUTH_REQUIRED", 401) });
  await openAmadeus();
  const form = openForm();
  fillCredentials(form);
  submitForm(form, OWN.submit);
  await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await requestLiveAccess(LIVE_IDLE, liveForm());
  await getSubmissionStatus(TENANT_ID, SUBMISSION_ID);
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

// ---- Live access (PF-51) -------------------------------------------------------------------------------------------

describe("live access", () => {
  it("[PFE-023 AC1] an owner requests live access and the page shows the pending live connection [PF-51 AC1]", async () => {
    const view = await openAmadeus();
    const section = liveSection();
    // What the request starts: the operations team, the commercial onboarding, then a live office and the e-mail.
    expect([...section.querySelectorAll("ol li")].map((item) => item.textContent)).toEqual([...LIVE.steps]);
    expect(screen.queryByRole("region", { name: CONNECTION_STRINGS.title("live") })).toBeNull();

    const form = within(section).getByRole("form", { name: LIVE.title });
    change(field<HTMLTextAreaElement>(form, LIVE.noteLabel), "  We start selling in March.  ");
    submitForm(form, LIVE.submit);

    await waitFor(() => expect(calls("POST", LIVE_REQUEST_PATH)).toHaveLength(1), ACTION_WAIT);
    const [request] = calls("POST", LIVE_REQUEST_PATH);
    expectSessionHeaders(request);
    expect(await bodyOf(request)).toEqual({ note: "We start selling in March." });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(AMADEUS_PAGE);
    // The confirmation takes the button's place (a status message) and the focus.
    const confirmation = await within(section).findByRole("status", {}, ACTION_WAIT);
    expect(confirmation.textContent).toBe(`${LIVE.requestedTitle}${LIVE.requested}`);
    expect(document.activeElement).toBe(confirmation);
    expect(within(section).queryByRole("form")).toBeNull();

    // The revalidated page: the live connection waits for its office, and the confirmation stays in view.
    await refresh(view, {
      [`GET ${AMADEUS_PATH}`]: () => json({ data: [testConnection(), pendingLiveConnection()] }, 200),
    });
    expect(summaryOf(card("live"))).toBe("Velexis live account, no office yet, pending");
    expect(card("live").querySelector('[data-notice="pending-live-office"]')?.textContent).toBe(
      CONNECTION_STRINGS.pendingLiveOffice,
    );
    expect(within(liveSection()).getByRole("status").textContent).toBe(
      `${LIVE.requestedTitle}${LIVE.requested}`,
    );
    expect(actionCalls.live).toBe(1);
    expect(writes()).toEqual([`POST ${LIVE_REQUEST_PATH}`]);
  });

  it("[PFE-023 AC1] a page load after the request shows the waiting live connection and what follows, without a form [PF-51 AC1]", async () => {
    routes({
      [`GET ${AMADEUS_PATH}`]: () => json({ data: [testConnection(), pendingLiveConnection()] }, 200),
    });
    await openAmadeus();
    const section = liveSection();
    expect(section.querySelector("[data-live-requested]")?.textContent).toBe(
      `${LIVE.requestedTitle}${LIVE.requested}`,
    );
    expect(within(section).queryByRole("form")).toBeNull();
    // The test connection keeps the pool's notice; only the live one names the commercial onboarding.
    expect(card("live").querySelector("[data-notice]")?.getAttribute("data-notice")).toBe(
      "pending-live-office",
    );
    expect(calls("GET", PLANS_PATH)).toHaveLength(0);
  });

  it("sends no note when none is typed, and refuses a note over 1000 characters without a call", async () => {
    await requestLiveAccess(LIVE_IDLE, liveForm("   "));
    expect(await bodyOf(calls("POST", LIVE_REQUEST_PATH)[0])).toEqual({});

    const tooLong = await requestLiveAccess(LIVE_IDLE, liveForm("x".repeat(1_001)));
    expect(tooLong).toMatchObject({ status: "failed", fieldError: LIVE.noteLength });
    const forged = await requestLiveAccess(LIVE_IDLE, liveForm("note", "ten_not-an-id"));
    expect(forged).toMatchObject({ status: "failed", message: LIVE.formExpired, reload: true });
    // 1000 characters (code points) is the limit, not more.
    await requestLiveAccess(LIVE_IDLE, liveForm("é".repeat(1_000)));
    expect(calls("POST", LIVE_REQUEST_PATH)).toHaveLength(2);
  });

  it("shows each refusal of the request in the portal's words, never the API's", async () => {
    const cases: [Response, Partial<LiveRequestState>][] = [
      [
        apiError("FEATURE_DISABLED", 403, { details: { feature: "live_switch" } }),
        { message: LIVE.notInPlan, billing: true },
      ],
      [
        apiError("CONFLICT", 409, { details: { reason: "live_connection_exists" } }),
        { message: LIVE.exists, reload: true },
      ],
      [
        apiError("CONFLICT", 409, { details: { reason: "live_account_missing" } }),
        { message: LIVE.accountMissing },
      ],
      [apiError("CONFLICT", 409), { message: ERROR_MESSAGES.CONFLICT, reload: true }],
      [apiError("TENANT_NOT_ACTIVE", 409), { message: LIVE.notActive, reload: true }],
      [apiError("FORBIDDEN", 403), { message: LIVE.forbidden, reload: true }],
      [apiError("NOT_FOUND", 404), { message: LIVE.removed, reload: true }],
      [apiError("RATE_LIMITED", 429), { message: LIVE.rateLimited }],
      [
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/note", code: "maxLength" }] }),
        { fieldError: LIVE.noteLength },
      ],
      [
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/path/tenantId", code: "pattern" }] }),
        { message: LIVE.formExpired, reload: true },
      ],
      [apiError("INTERNAL_ERROR", 500), { message: ERROR_MESSAGES.INTERNAL_ERROR }],
    ];
    for (const [answer, expected] of cases) {
      routes({ [`POST ${LIVE_REQUEST_PATH}`]: () => answer });
      const state = await requestLiveAccess(LIVE_IDLE, liveForm("Our note"));
      expect(state).toMatchObject({ status: "failed", note: "Our note", ...expected });
      expect(JSON.stringify(state)).not.toContain(API_TEXT);
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // An ended session signs in again and comes back to the Amadeus page.
    routes({ [`POST ${LIVE_REQUEST_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(requestLiveAccess(LIVE_IDLE, liveForm())).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent(AMADEUS_PAGE)}`,
    );
  });

  it("a plan without live mode gets the billing link instead of the request; a plan listPlans does not know gets the request", async () => {
    routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ planCode: "starter" }), 200) });
    await openAmadeus();
    const section = liveSection();
    expect(section.querySelector("[data-plan-without-live]")?.textContent).toBe(
      `${LIVE.planWithoutLive} ${LIVE.billingLink}`,
    );
    expect(within(section).getByRole("link", { name: LIVE.billingLink }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/billing`,
    );
    expect(within(section).queryByRole("form")).toBeNull();
    // listPlans is public: no access token, the end-user headers only.
    const [plans] = calls("GET", PLANS_PATH);
    expect(plans?.headers.get("authorization")).toBeNull();
    expect(plans?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
    cleanup();

    routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ planCode: "custom_plan" }), 200) });
    await openAmadeus();
    expect(within(liveSection()).getByRole("form", { name: LIVE.title })).toBeTruthy();
    cleanup();

    // FEATURE_DISABLED of the API (the plan, or the switch) links to billing from the form.
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ planCode: "custom_plan" }), 200),
      [`POST ${LIVE_REQUEST_PATH}`]: () =>
        apiError("FEATURE_DISABLED", 403, { details: { feature: "live_switch" } }),
    });
    await openAmadeus();
    const form = within(liveSection()).getByRole("form", { name: LIVE.title });
    submitForm(form, LIVE.submit);
    await waitFor(() => expect(summaryItems(form)).toEqual([LIVE.notInPlan]), ACTION_WAIT);
    expect(within(form).getByRole("link", { name: LIVE.billingLink })).toBeTruthy();
  });

  it("admins and finance members read that an owner requests live access, and the plan is not asked", async () => {
    for (const role of ["admin", "finance"] as const) {
      routesAs(role);
      await openAmadeus();
      const section = liveSection();
      expect(section.textContent).toContain(LIVE.ownerOnly);
      expect(within(section).queryByRole("form")).toBeNull();
      cleanup();
    }
    expect(calls("GET", PLANS_PATH)).toHaveLength(0);
    expect(writes()).toEqual([]);
  });

  it("is not offered while the switch is off, once the live connection has an office, or for an own live connection", async () => {
    routes({ [`GET ${ME_PATH}`]: () => json(account({ liveSwitch: false }), 200) });
    await openAmadeus();
    expect(screen.queryByRole("region", { name: LIVE.title })).toBeNull();
    cleanup();

    for (const live of [
      pendingLiveConnection({ status: "active", officeIds: ["LIVE00001"], defaultOfficeId: "LIVE00001" }),
      pendingLiveConnection({
        credentialSource: "tenant",
        status: "active",
        officeIds: [OSLO],
        clientId: CLIENT_ID,
      }),
    ]) {
      routes({ [`GET ${AMADEUS_PATH}`]: () => json({ data: [testConnection(), live] }, 200) });
      await openAmadeus();
      expect(screen.queryByRole("region", { name: LIVE.title })).toBeNull();
      cleanup();
    }
    expect(calls("GET", PLANS_PATH)).toHaveLength(0);
  });

  it("says why nothing can be requested while the OTA is suspended", async () => {
    routesAs("owner", {}, "suspended");
    await openAmadeus();
    const section = liveSection();
    expect(section.textContent).toContain(LIVE.readOnly.suspended);
    expect(within(section).queryByRole("form")).toBeNull();
  });
});

// ---- Own credentials (PF-52) ---------------------------------------------------------------------------------------

describe("own credentials", () => {
  it("[PFE-023 AC2] asks for a step-up, polls every 2 seconds and shows the rejection while the old connection stays [PF-52 AC1, AC2]", async () => {
    fakePollTimers();
    routes({
      [`PUT ${credentialsPath("test")}`]: inTurn(
        () => apiError("REAUTH_REQUIRED", 401),
        () => json({ submission: submission() }, 202),
      ),
      [`GET ${submissionPath()}`]: inTurn(
        () => json(submission({ status: "verifying" }), 200),
        () => json(failedSubmission("AMADEUS_CREDENTIALS_INVALID"), 200),
      ),
    });
    await openAmadeus();
    const form = openForm();
    // The form says before the submission that it asks for a code and that the connection keeps working.
    expect(form.querySelector("[data-step-up-note]")?.textContent).toBe(OWN.stepUpNote);
    const secret = field(form, OWN.clientSecretLabel);
    expect(secret.type).toBe("password");
    // Browsers ignore `off` on a password field: `new-password` keeps a saved portal password out of it.
    expect(secret.getAttribute("autocomplete")).toBe("new-password");
    fillCredentials(form);
    submitForm(form, OWN.submit);

    // The API asks for a step-up: the dialog takes the code, and the same submission goes again.
    let dialog: HTMLElement | undefined;
    await eventually(() => {
      dialog = screen.getByRole("dialog", { name: STEP_UP_STRINGS.title });
    });
    if (dialog === undefined) {
      throw new Error("no step-up dialog");
    }
    change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), "492039");
    const confirm = within(dialog).getByRole("button", { name: STEP_UP_STRINGS.submit });
    const stepUpForm = confirm.closest("form");
    if (stepUpForm === null) {
      throw new Error("The step-up button is in no form.");
    }
    fireEvent.submit(stepUpForm, { submitter: confirm });
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending"));

    const [stepUp, ...moreStepUps] = calls("POST", STEP_UP_PATH);
    expect(moreStepUps).toHaveLength(0);
    expect(await bodyOf(stepUp)).toEqual({ code: "492039" });
    const [refused, repeated, ...more] = calls("PUT", credentialsPath("test"));
    expect(more).toHaveLength(0);
    expectSessionHeaders(repeated);
    expect(await bodyOf(repeated)).toEqual(await bodyOf(refused));
    // The client id trimmed, the office ids upper-cased in the order typed, the queuing office left to the API.
    expect(await bodyOf(repeated)).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      officeIds: [OSLO, OSLO_2],
      defaultOfficeId: OSLO,
      ownerOfficeId: OSLO_2,
    });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(AMADEUS_PAGE);
    // The form closes, its secret is empty again and the focus is back on its button.
    expect(within(ownSection()).queryByRole("form")).toBeNull();
    expect(secret.value).toBe("");
    expect(document.activeElement?.textContent).toBe(OWN.open);
    expect(statusBlock()?.querySelector("[data-submission-message]")?.textContent).toBe(SUBMISSION.open);

    // Every 2 seconds, one read at a time, until the verification is final.
    expect(calls("GET", submissionPath())).toHaveLength(0);
    await advance(SUBMISSION_POLL_INTERVAL_MS - 1);
    expect(calls("GET", submissionPath())).toHaveLength(0);
    await advance(1);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("verifying"));
    expect(calls("GET", submissionPath())).toHaveLength(1);
    expectSessionHeaders(calls("GET", submissionPath())[0]);
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("failed"));

    // The rejection in words, never the code or the API's message, and the Velexis connection as it was.
    const block = statusBlock();
    expect(block?.querySelector("[data-submission-reason]")?.textContent).toBe(
      SUBMISSION.reasons["AMADEUS_CREDENTIALS_INVALID"],
    );
    expect(within(block ?? document.body).getByRole("status").textContent).toContain(SUBMISSION.failed);
    expect(summaryOf(card("test"))).toBe(`Velexis test account, office ${NICE}, active`);
    expect(document.body.textContent).not.toContain("AMADEUS_CREDENTIALS_INVALID");
    expect(document.body.innerHTML).not.toContain(API_TEXT);
    expect(document.body.innerHTML).not.toContain(CLIENT_SECRET);

    // Polling stopped at the final status.
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(2);
    expect(actionCalls.credentials).toBe(2);
  });

  it("[PFE-023 AC2] shows the success and, after the revalidation, the card with the OTA's own credentials [PF-52 AC2]", async () => {
    fakePollTimers();
    routes({
      [`GET ${submissionPath()}`]: () =>
        json(submission({ status: "applied", finishedAt: at(MINUTE_MS) }), 200),
    });
    const view = await openAmadeus();
    const form = openForm();
    fillCredentials(form);
    submitForm(form, OWN.submit);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending"));

    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("applied"));
    expect(statusBlock()?.querySelector("[data-submission-message]")?.textContent).toBe(
      SUBMISSION.applied("test"),
    );
    // The final answer revalidates the page (and the submission did before).
    expect(nextCache.revalidatePath).toHaveBeenCalledTimes(2);

    // The connection now uses the OTA's own credentials; the outcome stays in view.
    await refresh(view, { [`GET ${AMADEUS_PATH}`]: () => json({ data: [ownTestConnection()] }, 200) });
    expect(summaryOf(card("test"))).toBe(
      `${CONNECTION_STRINGS.amadeusAccount("tenant", "test")}, offices ${OSLO}, ${OSLO_2}, active`,
    );
    expect(card("test").querySelector('[data-detail="clientId"] dd')?.textContent).toBe(CLIENT_ID);
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("applied");
    expect(within(ownSection()).getByRole("button", { name: OWN.openOwn })).toBeTruthy();
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(1);
    expect(document.body.innerHTML).not.toContain(CLIENT_SECRET);
  });

  it("[PFE-023 AC2] follows a submission the page found, and an apply refusal shows its own words [PF-52 AC2]", async () => {
    fakePollTimers();
    routes({
      [`GET ${AMADEUS_PATH}`]: () =>
        json(
          {
            data: [
              testConnection({
                pendingSubmission: { id: SUBMISSION_ID, status: "verifying", errorCode: null },
              }),
            ],
          },
          200,
        ),
      [`GET ${submissionPath()}`]: () => json(failedSubmission("CONNECTION_DISABLED"), 200),
    });
    await openAmadeus();
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("verifying");
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("failed"));
    expect(statusBlock()?.querySelector("[data-submission-reason]")?.textContent).toBe(
      SUBMISSION.reasons["CONNECTION_DISABLED"],
    );
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(AMADEUS_PAGE);
    expect(writes()).toEqual([]);
  });

  it("keeps polling through a rate limit (after its Retry-After) and an unavailable API, and stops with the portal's message", async () => {
    fakePollTimers();
    routes({
      [`GET ${submissionPath()}`]: inTurn(
        () => apiError("RATE_LIMITED", 429, { headers: { "retry-after": "5" } }),
        () => apiError("SERVICE_UNAVAILABLE", 503),
        () => json(submission({ status: "verifying" }), 200),
        () => apiError("NOT_FOUND", 404),
      ),
    });
    render(
      <SubmissionStatus
        tenantId={TENANT_ID}
        environment="test"
        submission={{ id: SUBMISSION_ID, status: "pending", errorCode: null }}
        poll={getSubmissionStatus}
        wording={SUBMISSION}
      />,
    );
    const block = () => document.querySelector<HTMLElement>("[data-submission-status]");

    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() =>
      expect(block()?.querySelector("[data-poll-note]")?.textContent).toBe(SUBMISSION.pollFailed),
    );
    // The next read waits for the 5 seconds of Retry-After.
    await advance(4_999);
    expect(calls("GET", submissionPath())).toHaveLength(1);
    await advance(1);
    await eventually(() => expect(calls("GET", submissionPath())).toHaveLength(2));
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(block()?.dataset["submissionStatus"]).toBe("verifying"));
    expect(block()?.querySelector("[data-poll-note]")).toBeNull();
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        `${SUBMISSION.pollStoppedTitle}${ERROR_MESSAGES.NOT_FOUND}`,
      ),
    );
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(4);
    expect(document.body.innerHTML).not.toContain(API_TEXT);
  });

  it("goes to sign-in when the session ended while polling", async () => {
    fakePollTimers();
    routes({ [`GET ${submissionPath()}`]: () => apiError("UNAUTHENTICATED", 401) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <RedirectBoundary>
        <SubmissionStatus
          tenantId={TENANT_ID}
          environment="test"
          submission={{ id: SUBMISSION_ID, status: "pending", errorCode: null }}
          poll={getSubmissionStatus}
          wording={SUBMISSION}
        />
      </RedirectBoundary>,
    );
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() =>
      expect(screen.getByRole("status").textContent).toBe(
        `Redirected to /sign-in?next=${encodeURIComponent(AMADEUS_PAGE)}`,
      ),
    );
    await advance(10 * SUBMISSION_POLL_INTERVAL_MS);
    expect(calls("GET", submissionPath())).toHaveLength(1);
  });

  it("a new submission replaces the one followed, and the newer one is polled", async () => {
    fakePollTimers();
    routes({
      [`GET ${AMADEUS_PATH}`]: () =>
        json(
          {
            data: [
              testConnection({
                pendingSubmission: {
                  id: OTHER_SUBMISSION_ID,
                  status: "failed",
                  errorCode: "PROVIDER_UNAVAILABLE",
                },
              }),
            ],
          },
          200,
        ),
      [`GET ${submissionPath()}`]: () => json(submission({ status: "verifying" }), 200),
    });
    await openAmadeus();
    expect(statusBlock()?.querySelector("[data-submission-reason]")?.textContent).toBe(
      SUBMISSION.reasons["PROVIDER_UNAVAILABLE"],
    );
    const form = openForm();
    fillCredentials(form);
    submitForm(form, OWN.submit);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending"));
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("verifying"));
    expect(calls("GET", submissionPath(OTHER_SUBMISSION_ID))).toHaveLength(0);
    expect(calls("GET", submissionPath())).toHaveLength(1);
  });

  it("a cancelled step-up submits nothing and keeps what was typed", async () => {
    routes({ [`PUT ${credentialsPath("test")}`]: () => apiError("REAUTH_REQUIRED", 401) });
    await openAmadeus();
    const form = openForm();
    fillCredentials(form);
    submitForm(form, OWN.submit);
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), ACTION_WAIT);
    expect(summaryItems(form)).toEqual([OWN.stepUpCancelled]);
    expect(calls("PUT", credentialsPath("test"))).toHaveLength(1);
    expect(calls("POST", STEP_UP_PATH)).toHaveLength(0);
    expect(statusBlock()).toBeNull();
    // What was typed stays for the next try, the secret in the browser's own field only.
    expect(field(form, OWN.clientIdLabel).value).toBe(`  ${CLIENT_ID}  `);
    expect(field(form, OWN.clientSecretLabel).value).toBe(CLIENT_SECRET);
    expect(field(form, OWN.clientSecretLabel).getAttribute("value")).toBeNull();
    expect(document.body.innerHTML).not.toContain(CLIENT_SECRET);
  });

  it("the office selects offer the office ids typed, upper-cased, each once, and the action reads the text the same way", async () => {
    await openAmadeus();
    const form = openForm();
    const offices = field<HTMLSelectElement>(form, OWN.defaultOfficeLabel);
    expect(optionValues(offices)).toEqual([""]);
    expect(offices.options[0]?.textContent).toBe(OWN.officesFirst);

    const typed = "osln12345, OSLN12346;nce1a0955\n\n  OSLN12345 bad-id";
    change(field<HTMLTextAreaElement>(form, OWN.officeIdsLabel), typed);
    expect(officeIdsOf(typed)).toEqual([OSLO, OSLO_2, NICE, OSLO, "BAD-ID"]);
    expect(officeChoices(typed)).toEqual([OSLO, OSLO_2, NICE]);
    expect(optionValues(field<HTMLSelectElement>(form, OWN.defaultOfficeLabel))).toEqual([
      "",
      OSLO,
      OSLO_2,
      NICE,
    ]);
    expect(field<HTMLSelectElement>(form, OWN.defaultOfficeLabel).options[0]?.textContent).toBe(
      OWN.officePlaceholder,
    );
    for (const label of [OWN.queuingOfficeLabel, OWN.ownerOfficeLabel]) {
      const select = field<HTMLSelectElement>(form, label);
      expect(optionValues(select)).toEqual(["", OSLO, OSLO_2, NICE]);
      expect(select.options[0]?.textContent).toBe(OWN.sameAsDefault);
    }
    // A chosen office that is no longer typed reads as not chosen.
    change(field<HTMLSelectElement>(form, OWN.defaultOfficeLabel), NICE);
    expect(optionValues(field<HTMLSelectElement>(form, OWN.defaultOfficeLabel))).toEqual([
      OSLO,
      OSLO_2,
      NICE,
    ]);
    change(field<HTMLTextAreaElement>(form, OWN.officeIdsLabel), `${OSLO}\n${OSLO_2}`);
    expect(field<HTMLSelectElement>(form, OWN.defaultOfficeLabel).value).toBe("");

    // The action reads the same office ids from the same text.
    const officeText = "osln12345,\tnce1a0955";
    await submitOwnCredentials(
      CREDENTIALS_IDLE,
      credentialsForm({ officeIds: officeText, defaultOfficeId: NICE }),
    );
    const body = (await bodyOf(calls("PUT", credentialsPath("test"))[0])) as Record<string, unknown>;
    expect(body["officeIds"]).toEqual(officeIdsOf(officeText));
    expect(body["officeIds"]).toEqual(officeChoices(officeText));
  });

  it("refuses what breaks the document's rules at its field, without a call and without the secret in the state", async () => {
    await openAmadeus();
    const form = openForm();
    submitForm(form, OWN.submit);
    await waitFor(
      () =>
        expect(summaryItems(form)).toEqual([
          PROBLEMS.clientIdRequired,
          PROBLEMS.clientSecretRequired,
          PROBLEMS.officeIdsRequired,
          PROBLEMS.defaultOfficeRequired,
        ]),
      ACTION_WAIT,
    );
    const clientId = field(form, OWN.clientIdLabel);
    expect(clientId.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(clientId.getAttribute("aria-describedby")?.split(" ")[1] ?? "")?.textContent,
    ).toBe(PROBLEMS.clientIdRequired);
    expect(writes()).toEqual([]);

    const cases: [Partial<Record<string, string>>, Partial<Record<string, string>>][] = [
      [{ clientId: "acme client" }, { clientId: PROBLEMS.clientIdFormat }],
      [{ clientId: "c".repeat(201) }, { clientId: PROBLEMS.clientIdFormat }],
      [{ clientSecret: "s".repeat(513) }, { clientSecret: PROBLEMS.clientSecretLength }],
      [{ officeIds: "OSLN1234" }, { officeIds: PROBLEMS.officeIdFormat, defaultOfficeId: PROBLEMS.office }],
      [{ officeIds: `${OSLO}\nosln12345` }, { officeIds: PROBLEMS.officeIdsDuplicate }],
      [
        {
          officeIds: Array.from({ length: 51 }, (_, index) => `OSLN${String(index).padStart(5, "0")}`).join(
            "\n",
          ),
          defaultOfficeId: "OSLN00000",
        },
        { officeIds: PROBLEMS.officeIdsTooMany },
      ],
      [{ defaultOfficeId: NICE }, { defaultOfficeId: PROBLEMS.office }],
      [
        { queuingOfficeId: NICE, ownerOfficeId: "PARIS0001" },
        { queuingOfficeId: PROBLEMS.office, ownerOfficeId: PROBLEMS.office },
      ],
    ];
    for (const [values, fieldErrors] of cases) {
      const state = await submitOwnCredentials(CREDENTIALS_IDLE, credentialsForm(values));
      expect(state.status).toBe("failed");
      expect(state.fieldErrors).toEqual(fieldErrors);
      expect(JSON.stringify(state)).not.toContain(CLIENT_SECRET);
      expect(Object.keys(state.values)).not.toContain("clientSecret");
    }
    // A secret of 512 characters, any characters, goes as typed (never trimmed).
    const longest = ` ${"é".repeat(510)} `;
    await submitOwnCredentials(CREDENTIALS_IDLE, credentialsForm({ clientSecret: longest }));
    expect((await bodyOf(calls("PUT", credentialsPath("test"))[0])) as Record<string, unknown>).toMatchObject(
      {
        clientSecret: longest,
      },
    );

    // A form without its hidden fields is refused as expired.
    for (const hidden of [
      { tenantId: "ten_x", environment: "test" },
      { tenantId: TENANT_ID, environment: "staging" },
    ]) {
      const state = await submitOwnCredentials(CREDENTIALS_IDLE, credentialsForm({}, hidden));
      expect(state).toMatchObject({ status: "failed", message: OWN.formExpired, reload: true });
    }
    expect(calls("PUT", credentialsPath("test"))).toHaveLength(1);
  });

  it("[PFE-029 AC1] refuses an office list over the document's 50 with that one message, before checking any office id, without a call", async () => {
    const offices = Array.from({ length: 50 }, (_, index) => `OSLN${String(index).padStart(5, "0")}`);
    // 51 ids, one of them not an office id and one twice: neither is looked at, nor the default office.
    const oversized = await submitOwnCredentials(
      CREDENTIALS_IDLE,
      credentialsForm({
        officeIds: [...offices, "BAD", "OSLN00000"].join("\n"),
        defaultOfficeId: "PARIS0001",
      }),
    );
    expect(oversized.status).toBe("failed");
    expect(oversized.fieldErrors).toEqual({ officeIds: PROBLEMS.officeIdsTooMany });
    // The other fields keep their own checks.
    const withClientId = await submitOwnCredentials(
      CREDENTIALS_IDLE,
      credentialsForm({ officeIds: [...offices, "OSLN00050"].join("\n"), clientId: "" }),
    );
    expect(withClientId.fieldErrors).toEqual({
      clientId: PROBLEMS.clientIdRequired,
      officeIds: PROBLEMS.officeIdsTooMany,
    });

    // At the bound every office id is checked as before.
    const atBound = await submitOwnCredentials(
      CREDENTIALS_IDLE,
      credentialsForm({ officeIds: [...offices.slice(1), "BAD"].join("\n"), defaultOfficeId: "OSLN00001" }),
    );
    expect(atBound.fieldErrors).toEqual({ officeIds: PROBLEMS.officeIdFormat });
    expect(calls("PUT", credentialsPath("test"))).toHaveLength(0);
  });

  it("puts the API's field errors at their fields and shows its refusals in the portal's words", async () => {
    const fieldCases: [{ path: string; code: string }, Partial<Record<string, string>>][] = [
      [{ path: "/clientId", code: "pattern" }, { clientId: PROBLEMS.clientIdFormat }],
      [{ path: "/clientSecret", code: "minLength" }, { clientSecret: PROBLEMS.clientSecretRequired }],
      [{ path: "/clientSecret", code: "maxLength" }, { clientSecret: PROBLEMS.clientSecretLength }],
      [{ path: "/officeIds", code: "uniqueItems" }, { officeIds: PROBLEMS.officeIdsDuplicate }],
      [{ path: "/officeIds", code: "maxItems" }, { officeIds: PROBLEMS.officeIdsTooMany }],
      [{ path: "/officeIds", code: "something" }, { officeIds: PROBLEMS.rules }],
      [{ path: "/officeIds/1", code: "pattern" }, { officeIds: PROBLEMS.officeIdFormat }],
      [{ path: "/defaultOfficeId", code: "unknown" }, { defaultOfficeId: PROBLEMS.office }],
      [{ path: "/ownerOfficeId", code: "unknown" }, { ownerOfficeId: PROBLEMS.office }],
    ];
    for (const [fieldError, expected] of fieldCases) {
      routes({
        [`PUT ${credentialsPath("test")}`]: () =>
          apiError("VALIDATION_FAILED", 400, { fieldErrors: [fieldError] }),
      });
      const state = await submitOwnCredentials(CREDENTIALS_IDLE, credentialsForm());
      expect([fieldError.path, state.fieldErrors]).toEqual([fieldError.path, expected]);
    }
    const refusals: [Response, Partial<OwnCredentialsState>][] = [
      [
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/officeIds/2", code: "pattern" }] }),
        { message: OWN.formExpired, reload: true },
      ],
      [
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/path/environment", code: "enum" }] }),
        { message: OWN.formExpired, reload: true },
      ],
      [apiError("REAUTH_REQUIRED", 401), { message: OWN.stepUpCancelled, stepUp: true }],
      [apiError("MFA_REQUIRED", 403), { message: OWN.mfaRequired }],
      [
        apiError("FEATURE_DISABLED", 403, { details: { feature: "own_amadeus" } }),
        { message: OWN.featureDisabled, reload: true },
      ],
      [
        apiError("CONFLICT", 409, { details: { reason: "connection_disabled" } }),
        { message: OWN.connectionDisabled },
      ],
      [apiError("CONFLICT", 409), { message: ERROR_MESSAGES.CONFLICT, reload: true }],
      [apiError("TENANT_NOT_ACTIVE", 409), { message: OWN.notActive, reload: true }],
      [apiError("FORBIDDEN", 403), { message: OWN.forbidden, reload: true }],
      [apiError("NOT_FOUND", 404), { message: OWN.removed, reload: true }],
      [apiError("RATE_LIMITED", 429), { message: OWN.rateLimited }],
      [apiError("INTERNAL_ERROR", 500), { message: ERROR_MESSAGES.INTERNAL_ERROR }],
    ];
    for (const [answer, expected] of refusals) {
      routes({ [`PUT ${credentialsPath("test")}`]: () => answer });
      const state = await submitOwnCredentials(
        CREDENTIALS_IDLE,
        credentialsForm({ clientId: `  ${CLIENT_ID}` }),
      );
      expect(state).toMatchObject({ status: "failed", fieldErrors: {}, ...expected });
      // What was typed comes back, never the secret or the API's text.
      expect(state.values.clientId).toBe(`  ${CLIENT_ID}`);
      expect(JSON.stringify(state)).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(state)).not.toContain(API_TEXT);
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // An ended session signs in again and comes back; an unverified account verifies first.
    routes({ [`PUT ${credentialsPath("test")}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(submitOwnCredentials(CREDENTIALS_IDLE, credentialsForm())).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent(AMADEUS_PAGE)}`,
    );
    routes({ [`PUT ${credentialsPath("test")}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(submitOwnCredentials(CREDENTIALS_IDLE, credentialsForm())).rejects.toThrow(
      "NEXT_REDIRECT /verify-pending",
    );
  });

  it("MFA_REQUIRED links to the security page, and a refusal keeps the submission being verified", async () => {
    routes({
      [`GET ${AMADEUS_PATH}`]: () =>
        json(
          {
            data: [
              testConnection({
                pendingSubmission: { id: SUBMISSION_ID, status: "failed", errorCode: "PROVIDER_UNAVAILABLE" },
              }),
            ],
          },
          200,
        ),
      [`PUT ${credentialsPath("test")}`]: () => apiError("MFA_REQUIRED", 403),
    });
    await openAmadeus();
    const form = openForm();
    fillCredentials(form);
    submitForm(form, OWN.submit);
    await waitFor(() => expect(summaryItems(form)).toEqual([OWN.mfaRequired]), ACTION_WAIT);
    expect(within(form).getByRole("link", { name: OWN.mfaLink }).getAttribute("href")).toBe(
      "/account/security",
    );
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("failed");
  });

  it("a refused submission keeps following the one the API accepted before", async () => {
    fakePollTimers();
    routes({
      [`PUT ${credentialsPath("test")}`]: inTurn(
        () => json({ submission: submission() }, 202),
        () => apiError("RATE_LIMITED", 429),
      ),
      [`GET ${submissionPath()}`]: () => json(submission({ status: "verifying" }), 200),
    });
    await openAmadeus();
    const form = openForm();
    fillCredentials(form);
    submitForm(form, OWN.submit);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending"));

    // The form again, refused this time: its message shows, and the accepted submission is still followed.
    const again = openForm();
    fillCredentials(again);
    submitForm(again, OWN.submit);
    await eventually(() => expect(summaryItems(again)).toEqual([OWN.rateLimited]));
    expect(statusBlock()?.dataset["submissionStatus"]).toBe("pending");
    await advance(SUBMISSION_POLL_INTERVAL_MS);
    await eventually(() => expect(statusBlock()?.dataset["submissionStatus"]).toBe("verifying"));
    expect(calls("PUT", credentialsPath("test"))).toHaveLength(2);
    expect(calls("GET", submissionPath())).toHaveLength(1);

    // The action itself: a refusal, by the portal's checks or by the API, hands the followed submission on.
    const followed = { id: SUBMISSION_ID, status: "verifying", errorCode: null } as const;
    const previous: OwnCredentialsState = { ...CREDENTIALS_IDLE, status: "submitted", submission: followed };
    expect(await submitOwnCredentials(previous, credentialsForm({ clientId: "" }))).toMatchObject({
      status: "failed",
      submission: followed,
    });
    expect(await submitOwnCredentials(previous, credentialsForm())).toMatchObject({
      status: "failed",
      code: "RATE_LIMITED",
      submission: followed,
    });
  });

  it("the live environment takes the OTA's own credentials before it has a connection", async () => {
    await openAmadeus();
    const section = ownSection("live");
    expect(section.textContent).toContain(OWN.introNoConnection);
    const form = openForm("live");
    fillCredentials(form);
    submitForm(form, OWN.submit);
    await waitFor(() => expect(calls("PUT", credentialsPath("live"))).toHaveLength(1), ACTION_WAIT);
    expectSessionHeaders(calls("PUT", credentialsPath("live"))[0]);
    await waitFor(
      () => expect(statusBlock("live")?.dataset["submissionStatus"]).toBe("pending"),
      ACTION_WAIT,
    );
    expect(statusBlock("test")).toBeNull();
  });

  it("starts from the OTA's own client id and offices when the connection uses them, never a Velexis office", async () => {
    expect(initialCredentialValues(testConnection())).toEqual(CREDENTIALS_IDLE.values);
    expect(initialCredentialValues(null)).toEqual(CREDENTIALS_IDLE.values);
    routes({ [`GET ${AMADEUS_PATH}`]: () => json({ data: [ownTestConnection()] }, 200) });
    await openAmadeus();
    expect(ownSection().textContent).toContain(OWN.introOwn);
    const form = openForm();
    expect(field(form, OWN.clientIdLabel).value).toBe(CLIENT_ID);
    expect(field(form, OWN.clientSecretLabel).value).toBe("");
    expect(field<HTMLTextAreaElement>(form, OWN.officeIdsLabel).value).toBe(`${OSLO}\n${OSLO_2}`);
    expect(field<HTMLSelectElement>(form, OWN.defaultOfficeLabel).value).toBe(OSLO);
    // The queuing office equals the default office: "same as the default office".
    expect(field<HTMLSelectElement>(form, OWN.queuingOfficeLabel).value).toBe("");
    expect(field<HTMLSelectElement>(form, OWN.ownerOfficeLabel).value).toBe(OSLO_2);
  });

  it("says why nothing can be submitted for a disabled connection or while the OTA is suspended", async () => {
    routes({ [`GET ${AMADEUS_PATH}`]: () => json({ data: [testConnection({ status: "disabled" })] }, 200) });
    await openAmadeus();
    expect(ownSection("test").textContent).toContain(OWN.connectionDisabled);
    expect(within(ownSection("test")).queryByRole("button")).toBeNull();
    expect(within(ownSection("live")).getByRole("button", { name: OWN.open })).toBeTruthy();
    cleanup();

    routesAs("admin", {}, "suspended");
    await openAmadeus();
    for (const environment of ["test", "live"] as const) {
      expect(ownSection(environment).textContent).toContain(OWN.readOnly.suspended);
      expect(ownSection(environment).querySelector("form")).toBeNull();
    }
    expect(writes()).toEqual([]);
  });

  it("is offered to owners and admins while the switch is on, and finance members never get it", async () => {
    routesAs("admin");
    await openAmadeus();
    expect(ownSection("test")).toBeTruthy();
    expect(ownSection("live")).toBeTruthy();
    cleanup();

    routesAs("finance", {
      [`GET ${AMADEUS_PATH}`]: () =>
        json(
          {
            data: [
              testConnection({
                pendingSubmission: { id: SUBMISSION_ID, status: "verifying", errorCode: null },
              }),
            ],
          },
          200,
        ),
    });
    await openAmadeus();
    expect(screen.queryByRole("region", { name: OWN.title("test") })).toBeNull();
    // The card shows the submission's status; finance members never read the submission itself.
    expect(card("test").querySelector("[data-submission]")?.getAttribute("data-submission")).toBe(
      "verifying",
    );
    cleanup();

    routes({ [`GET ${ME_PATH}`]: () => json(account({ ownAmadeus: false }), 200) });
    await openAmadeus();
    expect(screen.queryByRole("region", { name: OWN.title("test") })).toBeNull();
    expect(liveSection()).toBeTruthy();
    expect(calls("GET", submissionPath())).toHaveLength(0);
    expect(writes()).toEqual([]);
  });

  it("[FIX-W40-PLATFORM AC7] offers the live own credentials only while the live switch is on; the test ones stay", async () => {
    routes({ [`GET ${ME_PATH}`]: () => json(account({ liveSwitch: false }), 200) });
    await openAmadeus();

    expect(ownSection("test")).toBeTruthy();
    expect(screen.queryByRole("region", { name: OWN.title("live") })).toBeNull();
    expect(document.querySelector('[data-own-credentials="live"]')).toBeNull();
    expect(writes()).toEqual([]);
    cleanup();

    routes({ [`GET ${ME_PATH}`]: () => json(account({ liveSwitch: true }), 200) });
    await openAmadeus();
    expect(ownSection("test")).toBeTruthy();
    expect(ownSection("live")).toBeTruthy();
  });
});

// ---- The verification read and the page ----------------------------------------------------------------------------

describe("the verification read and the page", () => {
  it("reads a submission with the session, revalidates only on a final status, and refuses ids that are none without a call", async () => {
    const pending = await getSubmissionStatus(TENANT_ID, SUBMISSION_ID);
    expect(pending).toEqual({
      status: "ok",
      submission: { id: SUBMISSION_ID, status: "pending", errorCode: null },
    });
    expectSessionHeaders(calls("GET", submissionPath())[0]);
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    for (const status of ["applied", "failed", "superseded"] as const) {
      routes({ [`GET ${submissionPath()}`]: () => json(submission({ status }), 200) });
      const read = await getSubmissionStatus(TENANT_ID, SUBMISSION_ID);
      // The API's errorMessage stays on the server.
      expect(read).toEqual({ status: "ok", submission: { id: SUBMISSION_ID, status, errorCode: null } });
    }
    expect(nextCache.revalidatePath).toHaveBeenCalledTimes(3);
    routes({ [`GET ${submissionPath()}`]: () => json(failedSubmission("AMADEUS_CREDENTIALS_INVALID"), 200) });
    expect(JSON.stringify(await getSubmissionStatus(TENANT_ID, SUBMISSION_ID))).not.toContain(API_TEXT);

    fetchMock.mockClear();
    for (const [tenantId, submissionId] of [
      ["ten_x", SUBMISSION_ID],
      [TENANT_ID, "crs_x"],
      [TENANT_ID, 7],
      [undefined, SUBMISSION_ID],
    ]) {
      const read = await getSubmissionStatus(tenantId, submissionId);
      expect(read).toMatchObject({ status: "failed", code: "NOT_FOUND", transient: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("viewers and agents get the not-allowed page without a connection or account call", async () => {
    for (const role of ["viewer", "agent"] as const) {
      routesAs(role);
      fetchMock.mockClear();
      await openAmadeus();
      expect(screen.queryByRole("region", { name: LIVE.title })).toBeNull();
      expect(fetchMock.mock.calls.map(([input]) => new URL(input.url).pathname)).toEqual([TENANT_PATH]);
      cleanup();
    }
  });

  it("a failed getMe hides live access and the own credentials and keeps the connections; an ended session signs in again", async () => {
    routes({ [`GET ${ME_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openAmadeus();
    expect(summaryOf(card("test"))).toBe(`Velexis test account, office ${NICE}, active`);
    expect(screen.queryByRole("region", { name: LIVE.title })).toBeNull();
    expect(screen.queryByRole("region", { name: OWN.title("test") })).toBeNull();
    cleanup();

    routes({ [`GET ${ME_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(pageTree()).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent(AMADEUS_PAGE)}`,
    );

    // Without the connections the page cannot tell what the OTA has: no M5 section.
    routes({ [`GET ${AMADEUS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openAmadeus();
    expect(screen.queryByRole("region", { name: LIVE.title })).toBeNull();
    expect(screen.queryByRole("region", { name: OWN.title("test") })).toBeNull();
  });

  it("renders on the server and hydrates without an error or a change, with every M5 section and a followed submission", async () => {
    routes({
      [`GET ${AMADEUS_PATH}`]: () =>
        json(
          {
            data: [
              testConnection({
                pendingSubmission: { id: SUBMISSION_ID, status: "failed", errorCode: "PROVIDER_UNAVAILABLE" },
              }),
            ],
          },
          200,
        ),
    });
    const { errors, root, serverDom, container } = await serverRenderAndHydrate(await pageTree());
    expect(errors).toEqual([]);
    expect(container.innerHTML).toBe(serverDom);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("[data-live-access]")).not.toBeNull();
    expect(container.querySelectorAll("[data-own-credentials]")).toHaveLength(2);
    expect(container.querySelector("[data-submission-reason]")?.textContent).toBe(
      SUBMISSION.reasons["PROVIDER_UNAVAILABLE"],
    );
    // The secret field has no value in the markup, and the page never holds a secret.
    expect(serverDom).not.toContain(CLIENT_SECRET);
    // A form sent before the page hydrated never goes out as a GET with the secret in the URL: React's guard stops it.
    const credentialForms = [...container.querySelectorAll("form[data-own-credentials-form]")];
    expect(credentialForms).toHaveLength(2);
    for (const form of credentialForms) {
      expect(form.getAttribute("action")).toMatch(/^javascript:/);
    }
    act(() => root.unmount());
  });
});
