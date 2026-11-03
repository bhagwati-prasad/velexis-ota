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
  pathname: "/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/go-live",
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

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import ApiKeysPage from "@/app/(app)/otas/[tenantId]/api-keys/page";
import { goLiveNow, type GoLiveState } from "@/app/(app)/otas/[tenantId]/go-live/actions";
import GoLivePage from "@/app/(app)/otas/[tenantId]/go-live/page";
import {
  checkedFromMissing,
  initialStates,
  LIVE_PRECONDITIONS,
  preconditionHref,
  statesAfterAnswer,
  type LivePrecondition,
} from "@/app/(app)/otas/[tenantId]/go-live/preconditions";
import { formatDateTime } from "@/components/date-time";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  API_KEYS_STRINGS,
  ERROR_MESSAGES,
  GO_LIVE_STRINGS,
  NOT_ALLOWED_STRINGS,
  ROLE_LABELS,
  STEP_UP_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real key, token or code) ----------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type Account = Schemas["Account"];
type MilestoneFeatures = Schemas["MilestoneFeatures"];
type OnboardingItem = Schemas["OnboardingItem"];
type ApiKey = Schemas["ApiKey"];

const STRINGS = GO_LIVE_STRINGS;
const ACCESS_TOKEN = "pfe026-dummy-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-026 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const GO_LIVE_PATH = `${TENANT_PATH}/go-live`;
const ONBOARDING_PATH = `${TENANT_PATH}/onboarding`;
const KEYS_PATH = `${TENANT_PATH}/api-keys`;
const ME_PATH = "/v1/me";
const STEP_UP_PATH = "/v1/auth/step-up";
const PAGE_PATH = `/otas/${TENANT_ID}/go-live`;
const HOST = "acme.ota.example.com";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** When the file started: the fixtures' instants are relative to it and never name a calendar date. */
const STARTED_AT = Date.now();

/** An instant `ms` before or after the start of the file, the same for every call. */
function at(ms: number): string {
  return new Date(STARTED_AT + ms).toISOString();
}

const LIVE_SINCE = at(-2 * DAY_MS);

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
    primaryHost: HOST,
    schemaVersion: "0002_m1",
    createdAt: at(-30 * DAY_MS),
    activatedAt: at(-30 * DAY_MS),
    version: 6,
    myRole: "owner",
    ...overrides,
  };
}

/** The tenant as `goLive` answers it: live, with its new version. */
function liveTenant(): Tenant {
  return tenant({ storefrontEnvironment: "live", liveEnabledAt: LIVE_SINCE, version: 7 });
}

const M5_ON: MilestoneFeatures = {
  stripeBilling: true,
  ownStripe: true,
  settlements: true,
  ownAmadeus: true,
  customDomains: true,
  liveSwitch: true,
};

function account(overrides: { features?: Partial<MilestoneFeatures>; mfaEnabled?: boolean } = {}): Account {
  const mfaEnabled = overrides.mfaEnabled ?? true;
  return {
    id: "acc_01JA2Z5K8N3Q6S9V2X5Z8B1D4F",
    email: "owner@example.com",
    emailVerified: true,
    fullName: "Ines Owner",
    locale: "en",
    timeZone: "UTC",
    mfaEnabled,
    mfaEnabledAt: mfaEnabled ? at(-20 * DAY_MS) : null,
    isPlatformAdmin: false,
    createdAt: at(-40 * DAY_MS),
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
    features: { ...M5_ON, ...overrides.features },
  };
}

/** The M5 items of `getOnboarding` that the page reads; `liveRequested` is the `live_requested` item. */
function onboarding(liveRequested: boolean): { items: OnboardingItem[] } {
  return {
    items: [
      {
        id: "mfa_enabled",
        label: "Turn on two-factor sign-in",
        done: true,
        href: "/account/security",
        milestone: "M1",
      },
      {
        id: "plan_chosen",
        label: "Choose a plan",
        done: true,
        href: `/otas/${TENANT_ID}/billing`,
        milestone: "M5",
      },
      {
        id: "payments_ready",
        label: "Set up payouts or your own Stripe",
        done: true,
        href: `/otas/${TENANT_ID}/payments`,
        milestone: "M5",
      },
      { id: "live_requested", label: "Go live", done: liveRequested, href: PAGE_PATH, milestone: "M5" },
    ],
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
function apiError(code: string, status: number, details?: Record<string, unknown>): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pfe026",
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );
}

/** `LIVE_PRECONDITIONS_UNMET` with `missing`, as `goLive` answers it. */
function unmet(missing: readonly string[]): Response {
  return apiError("LIVE_PRECONDITIONS_UNMET", 422, { missing });
}

/** The new session of a step-up (dummy tokens). */
function steppedUp(): Response {
  return json(
    {
      accessToken: "pfe026-dummy-stepped-up-access-token",
      accessTokenExpiresAt: at(15 * MINUTE_MS),
      refreshToken: "pfe026-dummy-stepped-up-refresh-token",
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

type Route = (request: Request) => Response | Promise<Response>;

/**
 * Answers each call by `METHOD /path`: by default an active owner's OTA in test mode, every M5 switch on, an account
 * with MFA, and an onboarding checklist without a live connection; `goLive` answers that a step-up is needed.
 */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(tenant(), 200),
    [`GET ${ME_PATH}`]: () => json(account(), 200),
    [`GET ${ONBOARDING_PATH}`]: () => json(onboarding(false), 200),
    [`POST ${GO_LIVE_PATH}`]: () => apiError("REAUTH_REQUIRED", 401),
    [`POST ${STEP_UP_PATH}`]: () => steppedUp(),
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

/** Answers `goLive` with each of `answers` in turn (the last one again for later calls). */
function goLiveAnswers(...answers: (() => Response)[]): Route {
  let call = 0;
  return () => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer === undefined) {
      throw new Error("No answer for goLive.");
    }
    return answer();
  };
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

// ---- Rendering --------------------------------------------------------------------------------------------------

/** Shows where the browser would go when an action redirects (Next.js navigates; here the error reaches this). */
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

/** The go-live page's tree for one request (never `null`: the layout's own failures are not this file's). */
async function pageTree(): Promise<ReactElement> {
  const page = await GoLivePage({ params: params() });
  if (page === null) {
    throw new Error("The page rendered nothing.");
  }
  return page;
}

/** `/otas/<id>/go-live` as the server renders it for one request. */
async function openGoLive(): Promise<void> {
  const page = await GoLivePage({ params: params() });
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/** `/otas/<id>/api-keys` as the server renders it for one request. */
async function openApiKeys(): Promise<void> {
  const page = await ApiKeysPage({ params: params() });
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/**
 * The wait for what a server action renders: the action runs the real `lib/api.ts` over the mocked fetch, which on a
 * busy CI runner can outlast Testing Library's 1 s default. It stays well inside the test's own budget.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/** The budget of the file's warm-up hook (the first render and action of a fresh worker are the slowest). */
const WARM_UP_TIMEOUT_MS = 30_000;

function checklist(): HTMLElement {
  return screen.getByRole("region", { name: STRINGS.checklistTitle });
}

/** The checklist item of `precondition`. */
function itemOf(precondition: LivePrecondition): HTMLElement {
  const item = checklist().querySelector<HTMLElement>(`li[data-precondition="${precondition}"]`);
  if (item === null) {
    throw new Error(`No checklist item for ${precondition}.`);
  }
  return item;
}

/** The state of each precondition in words, in the list's order. */
function statesInWords(): Record<string, string> {
  return Object.fromEntries(
    [...checklist().querySelectorAll<HTMLElement>("li[data-precondition]")].map((item) => [
      item.dataset["precondition"] ?? "",
      item.querySelector("[data-state-label]")?.textContent ?? "",
    ]),
  );
}

/** The link of each precondition, in the list's order. */
function linksOfChecklist(): Record<string, string | null> {
  return Object.fromEntries(
    LIVE_PRECONDITIONS.map((precondition) => [
      precondition,
      within(itemOf(precondition))
        .getByRole("link", { name: STRINGS.preconditions[precondition].link })
        .getAttribute("href"),
    ]),
  );
}

/** "Go live", then the confirmation's own "Go live". */
function goLiveAndConfirm(): void {
  const switchArea = document.querySelector<HTMLElement>('[data-go-live="switch"]');
  if (switchArea === null) {
    throw new Error("No go-live switch.");
  }
  fireEvent.click(within(switchArea).getByRole("button", { name: STRINGS.goLive }));
  const confirm = screen.getByRole("alertdialog", { name: STRINGS.confirmTitle });
  expect(within(confirm).getByText(STRINGS.confirmText)).toBeTruthy();
  fireEvent.click(within(confirm).getByRole("button", { name: STRINGS.confirmLabel }));
}

/** Submits the form of `button` as a click on it does. */
function submit(button: HTMLElement): void {
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

/** Answers the step-up dialog with a code (a dummy six-digit code; the mocked API accepts it). */
async function stepUpWithCode(): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
  fireEvent.change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), { target: { value: "492039" } });
  submit(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.submit }));
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
  expect(container.innerHTML).toBe(serverDom);
  return { errors, root };
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
      "x-request-id": "req_pfe026_portal",
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
 * Once per file, before any test: the page's render, a confirmed switch up to the step-up dialog, the action, and the
 * page rendered on the server and hydrated. The first run of those paths in a fresh worker is the slowest, and on a
 * busy CI runner it otherwise lands in the first test's own five seconds; here it has the hook's own budget. Nothing of
 * it stays: each test gets a fresh API, fresh mocks and globals (`restoreMocks`, `unstubGlobals`) and an empty
 * document.
 */
beforeAll(async () => {
  resetPlatformApi();
  await openGoLive();
  goLiveAndConfirm();
  await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await goLiveNow({ status: "idle" }, new FormData());
  const { root } = await serverRenderAndHydrate(await pageTree());
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The checklist and the switch (PF-14) ---------------------------------------------------------------------------

describe("/otas/[tenantId]/go-live: the checklist and the switch", () => {
  it("[PFE-026 AC1] lists the missing preconditions with links to the pages that complete them [PF-14 AC1]", async () => {
    routes({
      [`POST ${GO_LIVE_PATH}`]: goLiveAnswers(
        () => apiError("REAUTH_REQUIRED", 401),
        () => unmet(["amadeus_live", "payout_account", "subscription"]),
      ),
    });
    await openGoLive();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(STRINGS.title);
    // The six preconditions in the platform document's order, each with what it needs and a link to its page.
    expect([...checklist().querySelectorAll("li")].map((item) => item.dataset["precondition"])).toEqual([
      ...LIVE_PRECONDITIONS,
    ]);
    for (const precondition of LIVE_PRECONDITIONS) {
      expect(within(itemOf(precondition)).getByText(STRINGS.preconditions[precondition].title)).toBeTruthy();
    }
    expect(linksOfChecklist()).toEqual({
      amadeus_live: `/otas/${TENANT_ID}/amadeus`,
      payments_live: `/otas/${TENANT_ID}/payments`,
      payout_account: `/otas/${TENANT_ID}/payments/payout-account`,
      plan_live_mode: `/otas/${TENANT_ID}/billing`,
      subscription: `/otas/${TENANT_ID}/billing`,
      mfa: "/account/security",
    });
    // Before the first try only what is certain: no live Amadeus connection yet, and the owner's MFA is on.
    expect(statesInWords()).toEqual({
      amadeus_live: STRINGS.states.missing,
      payments_live: STRINGS.states.unchecked,
      payout_account: STRINGS.states.unchecked,
      plan_live_mode: STRINGS.states.unchecked,
      subscription: STRINGS.states.unchecked,
      mfa: STRINGS.states.met,
    });
    // Reading the page changes nothing.
    expect(calls("POST", GO_LIVE_PATH)).toHaveLength(0);

    goLiveAndConfirm();
    await stepUpWithCode();

    const summary = await screen.findByText(STRINGS.unmet(3), {}, ACTION_WAIT);
    expect(summary.closest("[role=alert]")?.textContent).toContain(STRINGS.unmetTitle);
    await waitFor(
      () => expect(document.activeElement).toBe(document.querySelector("[data-go-live-unmet]")),
      ACTION_WAIT,
    );
    // The API's answer decides all six: the missing ones are listed, still with their links; the others are done.
    expect(statesInWords()).toEqual({
      amadeus_live: STRINGS.states.missing,
      payments_live: STRINGS.states.met,
      payout_account: STRINGS.states.missing,
      plan_live_mode: STRINGS.states.met,
      subscription: STRINGS.states.missing,
      mfa: STRINGS.states.met,
    });
    expect(within(itemOf("payout_account")).getByRole("link").getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/payments/payout-account`,
    );
    expect(document.body.textContent).not.toContain("The API's own text");

    // The switch was tried twice with `{confirm: true}`: before and after the step-up, with the new session.
    const [refused, checked, ...more] = calls("POST", GO_LIVE_PATH);
    expect(more).toHaveLength(0);
    expect(await bodyOf(refused)).toEqual({ confirm: true });
    expect(await bodyOf(checked)).toEqual({ confirm: true });
    expectSessionHeaders(refused);
    expect(calls("POST", STEP_UP_PATH)).toHaveLength(1);
    // Nothing changed, so nothing is revalidated.
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("[PFE-026 AC1] the switch succeeds once the preconditions are met, and shows the live storefront within 60 seconds [PF-14 AC2]", async () => {
    let met = false;
    routes({
      [`POST ${GO_LIVE_PATH}`]: () =>
        met ? json(liveTenant(), 200, { etag: '"7"' }) : unmet(["payments_live"]),
      [`GET ${ONBOARDING_PATH}`]: () => json(onboarding(true), 200),
    });
    await openGoLive();
    // A live connection exists (requested), so nothing is known to be missing before the first try.
    expect(statesInWords()["amadeus_live"]).toBe(STRINGS.states.unchecked);

    goLiveAndConfirm();
    await screen.findByText(STRINGS.unmet(1), {}, ACTION_WAIT);
    expect(statesInWords()["payments_live"]).toBe(STRINGS.states.missing);

    // The owner completes the missing one and goes live again (the step-up of the last 15 minutes still counts).
    met = true;
    goLiveAndConfirm();

    const live = await screen.findByRole("region", { name: STRINGS.liveTitle }, ACTION_WAIT);
    expect(within(live).getByRole("status").textContent).toBe(STRINGS.liveNow);
    const storefront = within(live).getByRole("link", { name: `https://${HOST}/` });
    expect(storefront.getAttribute("href")).toBe(`https://${HOST}/`);
    expect(
      within(live).getByText(formatDateTime(LIVE_SINCE, { timeZone: "Europe/Oslo" }) ?? ""),
    ).toBeTruthy();
    expect(within(live).getByRole("link", { name: STRINGS.liveKeysLink }).getAttribute("href")).toBe(
      `/otas/${TENANT_ID}/api-keys`,
    );
    // The view takes the focus; the checklist and the switch are gone.
    const heading = within(live).getByRole("heading", { name: STRINGS.liveTitle });
    await waitFor(() => expect(document.activeElement).toBe(heading), ACTION_WAIT);
    expect(screen.queryByRole("region", { name: STRINGS.checklistTitle })).toBeNull();
    expect(screen.queryByRole("button", { name: STRINGS.goLive })).toBeNull();
    // Every page below the OTA layout is rendered again (banner, the API keys' live tab, this page): the pattern is the
    // layout file's route, route group included, as Next.js tags the pages below it (`/(app)/otas/[tenantId]/layout`).
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/(app)/otas/[tenantId]", "layout");
    expect(
      existsSync(join(repositoryRoot(), "platform/frontend/src/app/(app)/otas/[tenantId]/layout.tsx")),
    ).toBe(true);
    expect(calls("POST", GO_LIVE_PATH)).toHaveLength(2);

    // A reload of a live OTA shows its live storefront and since when, without the switch or a call to the checklist.
    cleanup();
    fetchMock.mockClear();
    routes({ [`GET ${TENANT_PATH}`]: () => json(liveTenant(), 200) });
    await openGoLive();
    const reloaded = screen.getByRole("region", { name: STRINGS.liveTitle });
    expect(within(reloaded).queryByRole("status")).toBeNull();
    expect(within(reloaded).getByText(STRINGS.liveSince)).toBeTruthy();
    expect(screen.queryByRole("button", { name: STRINGS.goLive })).toBeNull();
    expect(calls("GET", ONBOARDING_PATH)).toHaveLength(0);
  });

  it("names a missing precondition the portal has no words for, and says a cancelled step-up changed nothing", async () => {
    routes({
      [`POST ${GO_LIVE_PATH}`]: goLiveAnswers(
        () => apiError("REAUTH_REQUIRED", 401),
        () => apiError("REAUTH_REQUIRED", 401),
        () => unmet(["subscription", "contract_signed"]),
      ),
    });
    await openGoLive();
    goLiveAndConfirm();
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.cancel }));
    expect(screen.queryByRole("dialog", { name: STEP_UP_STRINGS.title })).toBeNull();
    expect(document.querySelector('[data-go-live-problem="REAUTH_REQUIRED"]')?.textContent).toContain(
      STRINGS.stepUpCancelled,
    );
    expect(calls("POST", GO_LIVE_PATH)).toHaveLength(1);

    goLiveAndConfirm();
    await stepUpWithCode();
    await screen.findByText(STRINGS.otherMissing, {}, ACTION_WAIT);
    expect(screen.getByText(STRINGS.unmet(1))).toBeTruthy();
    expect(calls("POST", GO_LIVE_PATH)).toHaveLength(3);
    // The cancelled step-up's message gave way to the answer.
    expect(document.querySelector("[data-go-live-problem]")).toBeNull();
    expect(statesInWords()["subscription"]).toBe(STRINGS.states.missing);
    expect(document.body.textContent).not.toContain("contract_signed");
  });

  it("explains each refusal of the switch in the portal's words", async () => {
    const cases: { code: string; status: number; message: string; link?: [string, string] }[] = [
      {
        code: "MFA_REQUIRED",
        status: 403,
        message: STRINGS.mfaRequired,
        link: [STRINGS.securityLink, "/account/security"],
      },
      {
        code: "FEATURE_DISABLED",
        status: 403,
        message: STRINGS.featureDisabled,
        link: [STRINGS.reload, PAGE_PATH],
      },
      {
        code: "TENANT_NOT_ACTIVE",
        status: 409,
        message: STRINGS.notActive,
        link: [STRINGS.reload, PAGE_PATH],
      },
      { code: "FORBIDDEN", status: 403, message: STRINGS.forbidden, link: [STRINGS.reload, PAGE_PATH] },
      { code: "RATE_LIMITED", status: 429, message: STRINGS.rateLimited },
      { code: "SERVICE_UNAVAILABLE", status: 503, message: ERROR_MESSAGES.SERVICE_UNAVAILABLE },
    ];
    for (const { code, status, message, link } of cases) {
      resetPlatformApi();
      routes({ [`POST ${GO_LIVE_PATH}`]: () => apiError(code, status) });
      await openGoLive();
      goLiveAndConfirm();
      const shown = await screen.findByText(message, {}, ACTION_WAIT);
      const problem = shown.closest<HTMLElement>(`[data-go-live-problem="${code}"]`);
      if (problem === null) {
        throw new Error(`The message of ${code} is not in its alert.`);
      }
      if (link === undefined) {
        expect(within(problem).queryByRole("link")).toBeNull();
      } else {
        expect(within(problem).getByRole("link", { name: link[0] }).getAttribute("href")).toBe(link[1]);
      }
      if (code === "MFA_REQUIRED") {
        // Without two-factor sign-in the API says so before anything else: the checklist marks it.
        expect(statesInWords()["mfa"]).toBe(STRINGS.states.missing);
      }
      expect(document.body.textContent).not.toContain("The API's own text");
      cleanup();
    }
  });

  it("sends an ended session to sign-in and back, and refuses a form without its OTA without a call", async () => {
    const idle: GoLiveState = { status: "idle" };
    expect(await goLiveNow(idle, new FormData())).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: STRINGS.formExpired,
      reload: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const form = new FormData();
    form.set("tenantId", TENANT_ID);
    routes({ [`POST ${GO_LIVE_PATH}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(goLiveNow(idle, form)).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent(PAGE_PATH)}`,
    );
    routes({ [`POST ${GO_LIVE_PATH}`]: () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(goLiveNow(idle, form)).rejects.toThrow("NEXT_REDIRECT /verify-pending");

    routes({ [`GET ${ME_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(GoLivePage({ params: params() })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent(PAGE_PATH)}`,
    );
  });
});

describe("/otas/[tenantId]/go-live: who sees what", () => {
  it("gives admins, agents, finance members and viewers the not-allowed page without another call", async () => {
    for (const role of ["admin", "agent", "finance", "viewer"] as const) {
      resetPlatformApi();
      routes({ [`GET ${TENANT_PATH}`]: () => json(tenant({ myRole: role }), 200) });
      await openGoLive();
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(NOT_ALLOWED_STRINGS.title);
      expect(screen.getByText(NOT_ALLOWED_STRINGS.intro(ROLE_LABELS[role]))).toBeTruthy();
      expect(screen.queryByRole("button", { name: STRINGS.goLive })).toBeNull();
      expect(fetchMock.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([TENANT_PATH]);
      cleanup();
    }
  });

  it("offers nothing while the live switch is off, and shows the portal's message when the account cannot be read", async () => {
    routes({ [`GET ${ME_PATH}`]: () => json(account({ features: { liveSwitch: false } }), 200) });
    await openGoLive();
    expect(screen.getByRole("heading", { name: STRINGS.switchOffTitle })).toBeTruthy();
    expect(screen.queryByRole("region", { name: STRINGS.checklistTitle })).toBeNull();
    expect(screen.queryByRole("button", { name: STRINGS.goLive })).toBeNull();
    cleanup();

    routes({ [`GET ${ME_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openGoLive();
    expect(screen.getByRole("alert").textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(screen.queryByRole("button", { name: STRINGS.goLive })).toBeNull();
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("disables the switch with the reason while the OTA is not active, and marks two-factor sign-in when it is off", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(tenant({ status: "suspended", suspensionReason: "billing" }), 200),
      [`GET ${ME_PATH}`]: () => json(account({ mfaEnabled: false }), 200),
      [`GET ${ONBOARDING_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503),
    });
    await openGoLive();
    expect(document.querySelector("[data-go-live-read-only]")?.textContent).toContain(
      STRINGS.readOnly.suspended,
    );
    const button = screen.getByRole("button", { name: STRINGS.goLive });
    expect(button.hasAttribute("disabled")).toBe(true);
    // Without the onboarding checklist only the account's MFA is known.
    expect(statesInWords()).toEqual({
      amadeus_live: STRINGS.states.unchecked,
      payments_live: STRINGS.states.unchecked,
      payout_account: STRINGS.states.unchecked,
      plan_live_mode: STRINGS.states.unchecked,
      subscription: STRINGS.states.unchecked,
      mfa: STRINGS.states.missing,
    });
  });

  it("renders on the server and hydrates without an error or a change", async () => {
    const { errors, root } = await serverRenderAndHydrate(await pageTree());
    expect(errors).toEqual([]);
    act(() => root.unmount());

    routes({ [`GET ${TENANT_PATH}`]: () => json(liveTenant(), 200) });
    const live = await serverRenderAndHydrate(await pageTree());
    expect(live.errors).toEqual([]);
    act(() => live.root.unmount());
  });
});

describe("the preconditions", () => {
  it("are the six of the platform document's goLive, in its order", () => {
    const document = readFileSync(
      join(repositoryRoot(), "platform/backend/openapi/velexis-platform-api.openapi.yaml"),
      "utf8",
    );
    const start = document.indexOf("operationId: goLive");
    expect(start).toBeGreaterThan(-1);
    const description = document.slice(start, document.indexOf("**Effect**", start));
    const positions = LIVE_PRECONDITIONS.map((precondition) => description.indexOf(`\`${precondition}\``));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("start from what is certain and take every answer's decision", () => {
    expect(initialStates({ mfaEnabled: true, onboarding: undefined })).toEqual({
      amadeus_live: "unchecked",
      payments_live: "unchecked",
      payout_account: "unchecked",
      plan_live_mode: "unchecked",
      subscription: "unchecked",
      mfa: "met",
    });
    // Done onboarding items that differ from their precondition decide nothing.
    const fromOnboarding = initialStates({ mfaEnabled: true, onboarding: onboarding(false).items });
    expect(fromOnboarding.amadeus_live).toBe("missing");
    expect(fromOnboarding.subscription).toBe("unchecked");
    expect(fromOnboarding.payments_live).toBe("unchecked");

    const answer = checkedFromMissing(["mfa"]);
    expect(answer.otherMissing).toBe(false);
    expect(statesAfterAnswer(fromOnboarding, answer.checked)).toEqual({
      amadeus_live: "met",
      payments_live: "met",
      payout_account: "met",
      plan_live_mode: "met",
      subscription: "met",
      mfa: "missing",
    });
    expect(statesAfterAnswer(fromOnboarding, { mfa: "missing" }).amadeus_live).toBe("missing");
    // An answer without a list (or with nothing the portal knows) must not look as if everything were met: without a
    // list it decides nothing, and with only unknown values it says that something else is missing.
    expect(checkedFromMissing(undefined)).toEqual({ checked: {}, otherMissing: true });
    expect(checkedFromMissing([])).toEqual({ checked: {}, otherMissing: true });
    expect(checkedFromMissing("subscription")).toEqual({ checked: {}, otherMissing: true });
    expect(checkedFromMissing(["contract_signed"]).otherMissing).toBe(true);
    expect(preconditionHref("ten_01JB0000000000000000000000", "mfa")).toBe("/account/security");
  });
});

// ---- Live API keys (PF-30 AC6) ------------------------------------------------------------------------------------

/**
 * A full key as the API answers it once (`<pk|sk>_<environment>_` and 40 base62 characters, PADR-0005), built from its
 * parts: a filler that says it is a dummy, never a real key.
 */
function dummyKey(environment: "test" | "live", start: string, last4: string): string {
  return ["sk", environment, `${start}PFE026DummyValueNeverARealKey0${last4}`].join("_");
}

const LIVE_KEY = dummyKey("live", "Lv26Sc", "Lv44");

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key_01JB3KA2C6E0G4J8M2P6S0V4X8",
    name: "Storefront test",
    kind: "secret",
    environment: "test",
    prefix: dummyKey("test", "Qw34Er", "Df90").slice(0, 14),
    last4: "Df90",
    allowedOrigins: [],
    scopes: ["storefront"],
    createdAt: at(-5 * DAY_MS),
    createdBy: { accountId: "acc_01JA2Z5K8N3Q6S9V2X5Z8B1D4F", fullName: "Ines Owner" },
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("/otas/[tenantId]/api-keys: live keys", () => {
  it("[PFE-026 AC2] a live OTA gets the live tab, and creating a live secret key asks for a step-up [PF-30 AC6]", async () => {
    let first = true;
    routes({
      [`GET ${TENANT_PATH}`]: () => json(liveTenant(), 200),
      [`GET ${KEYS_PATH}`]: () => json({ data: [apiKey()] }, 200),
      [`POST ${KEYS_PATH}`]: async (request) => {
        if (first) {
          first = false;
          return apiError("REAUTH_REQUIRED", 401);
        }
        const body = (await request.clone().json()) as { name: string };
        return json(
          {
            apiKey: apiKey({
              id: "key_01JB3KF5J9M3P7S1V5Y9B3D7F1",
              name: body.name,
              environment: "live",
              prefix: LIVE_KEY.slice(0, 14),
              last4: LIVE_KEY.slice(-4),
              createdAt: at(0),
            }),
            key: LIVE_KEY,
          },
          201,
          { "cache-control": "no-store" },
        );
      },
    });
    await openApiKeys();

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      API_KEYS_STRINGS.tab("test"),
      API_KEYS_STRINGS.tab("live"),
    ]);
    fireEvent.mouseDown(screen.getByRole("tab", { name: API_KEYS_STRINGS.tab("live") }), { button: 0 });
    const create = await screen.findByRole("region", { name: API_KEYS_STRINGS.createTitle("live") });
    // The live tab lists no test key.
    expect(screen.getByText(API_KEYS_STRINGS.empty)).toBeTruthy();

    fireEvent.change(within(create).getByLabelText(API_KEYS_STRINGS.nameLabel), {
      target: { value: "Storefront production" },
    });
    submit(within(create).getByRole("button", { name: API_KEYS_STRINGS.submit }));
    await stepUpWithCode();

    const panel = await screen.findByRole(
      "region",
      { name: API_KEYS_STRINGS.createdTitle("secret", "live") },
      ACTION_WAIT,
    );
    const field = within(panel).getByLabelText(
      API_KEYS_STRINGS.createdKeyLabel("Storefront production"),
    ) as HTMLInputElement;
    expect(field.value).toBe(LIVE_KEY);
    const [refused, repeated, ...more] = calls("POST", KEYS_PATH);
    expect(more).toHaveLength(0);
    expect(await bodyOf(refused)).toEqual({
      name: "Storefront production",
      kind: "secret",
      environment: "live",
      scopes: ["storefront"],
    });
    expect(await bodyOf(repeated)).toEqual(await bodyOf(refused));
    expect(calls("POST", STEP_UP_PATH)).toHaveLength(1);
    expectSessionHeaders(repeated);
  });

  it("[PFE-026 AC2] an OTA in test mode has the test tab only", async () => {
    routes({ [`GET ${KEYS_PATH}`]: () => json({ data: [apiKey()] }, 200) });
    await openApiKeys();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([API_KEYS_STRINGS.tab("test")]);
  });
});
