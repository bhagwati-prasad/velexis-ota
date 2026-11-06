// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { Component, type ReactNode } from "react";
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
  usePathname: () => "/mfa-enrolment",
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

import { changeAccountPassword, type PasswordState } from "@/app/(app)/account/security/actions";
import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import { acceptInvitation } from "@/app/(auth)/invitations/accept/actions";
import { beginEnrolment, confirmEnrolment } from "@/app/(auth)/mfa-enrolment/actions";
import MfaEnrolmentPage from "@/app/(auth)/mfa-enrolment/page";
import {
  MFA_ENROLMENT_PATH,
  isMfaEnrolmentRequired,
  leaveForMfaEnrolment,
  mfaEnrolmentPath,
} from "@/lib/errors";
import { qrCode } from "@/lib/qr";
import {
  ACCESS_TOKEN_COOKIE,
  INVITATION_COOKIE,
  REFRESH_TOKEN_COOKIE,
  REQUESTED_PAGE_HEADER,
} from "@/lib/session";
import { ERROR_MESSAGES, MFA_ENROLMENT_STRINGS, SECRET_STRINGS, SECURITY_STRINGS } from "@/lib/strings";

// ---- Builders (dummy values only: no real token, secret, password or recovery code) -------------------------------

type Account = components["schemas"]["Account"];

const ACCESS_TOKEN = "pfe030-dummy-access-token";
const REFRESH_TOKEN = "pfe030-dummy-refresh-token";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const OTA_PAGE = `/otas/${TENANT_ID}/team`;

/** A pending TOTP secret and its URI as `startMfaSetup` answers them (base32 letters only: a dummy). */
const TOTP_SECRET = "PFEZEROTHIRTYDUMMYSECRETNOTREAL";
const OTPAUTH_URL = `otpauth://totp/Velexis:ada.admin%40example.com?secret=${TOTP_SECRET}&issuer=Velexis&algorithm=SHA1&digits=6&period=30`;
/** Ten recovery codes in the document's format (Crockford base32); dummies. */
const RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `PF3${index}-7D7M-MYRC-0DE${index}`);

const FEATURES_OFF: components["schemas"]["MilestoneFeatures"] = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

/** The signed-in account (`getMe`): an admin of a live OTA without MFA unless the test says otherwise. */
function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "ada.admin@example.com",
    emailVerified: true,
    fullName: "Ada Admin",
    locale: "en",
    timeZone: "Europe/Oslo",
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaEnrolmentRequired: true,
    isPlatformAdmin: false,
    createdAt: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
    version: 2,
    memberships: [
      {
        membershipId: "stf_01JA2ZA1C5E9G3J7K2M6P0R4T8",
        tenantId: TENANT_ID,
        tenantKey: "acme",
        tenantName: "Acme Travel",
        tenantStatus: "active",
        role: "admin",
      },
    ],
    features: FEATURES_OFF,
    ...overrides,
  };
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();
let sent: Call[] = [];

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(code: string, status: number, details?: Record<string, unknown>): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pfe030",
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );
}

/** The API's MFA enrolment gate (PBE-071): `403 MFA_REQUIRED` with `details.reason = enrolment_required`. */
const enrolmentRequired = (): Response => apiError("MFA_REQUIRED", 403, { reason: "enrolment_required" });

type Route = (call: Call) => Response | Promise<Response>;

/** Answers each call by `METHOD /path`; a call without a route fails the test. */
function routes(table: Record<string, Route>): void {
  fetchMock.mockImplementation(async (input) => {
    const text = input.method === "GET" ? "" : await input.clone().text();
    const call: Call = {
      method: input.method,
      path: new URL(input.url).pathname,
      headers: input.headers,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
    sent.push(call);
    const route = table[`${call.method} ${call.path}`];
    if (route === undefined) {
      throw new Error(`unexpected call ${call.method} ${input.url}`);
    }
    return route(call);
  });
}

function calls(method: string, path: string): Call[] {
  return sent.filter((call) => call.method === method && call.path === path);
}

/** The cookies of the request: the session, and nothing else unless a test adds it. */
const jar = new Map<string, string>();

/** The request headers the middleware passed on; `REQUESTED_PAGE_HEADER` is the page the request is for. */
let requestHeaders = new Headers();

function requestedPage(page: string | undefined): void {
  requestHeaders = new Headers({
    "x-forwarded-for": "203.0.113.30",
    "user-agent": "Mozilla/5.0 (PFE-030 test)",
  });
  if (page !== undefined) {
    requestHeaders.set(REQUESTED_PAGE_HEADER, page);
  }
}

function resetPlatformApi(): void {
  fetchMock.mockReset();
  sent = [];
  vi.stubGlobal("fetch", fetchMock);
  navigation.redirect.mockClear();
  nextCache.revalidatePath.mockReset();
  jar.clear();
  jar.set(ACCESS_TOKEN_COOKIE, ACCESS_TOKEN);
  jar.set(REFRESH_TOKEN_COOKIE, REFRESH_TOKEN);
  requestedPage(`${MFA_ENROLMENT_PATH}?next=${encodeURIComponent(OTA_PAGE)}`);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.cookies.mockImplementation(() =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) ?? "" } : undefined),
      has: (name: string) => jar.has(name),
      set: vi.fn(),
    }),
  );
  nextHeaders.headers.mockImplementation(() => Promise.resolve(requestHeaders));
  window.localStorage.clear();
  window.sessionStorage.clear();
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

/**
 * How long a test waits for what a server action answers (a round trip through the real `lib/api.ts` and a re-render
 * of the page). Testing Library's 1 s default is enough on an idle machine, not on a loaded CI runner; the test's own
 * 5 s budget is unchanged.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/**
 * The budget of the hook that opens the page first: the first render in a fresh worker loads the page's modules
 * (Radix, the actions, the QR encoder) and is the slowest by far on a busy CI runner.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/** `/mfa-enrolment?next=…` for one request, inside the redirect boundary. */
async function openEnrolment(query: Record<string, string> = { next: OTA_PAGE }): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await MfaEnrolmentPage({ searchParams: Promise.resolve(query) });
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/** Submits the form of the button named `name`, as a click on it would. */
function submit(name: string): void {
  const button = screen.getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function valueOf(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** The default answers of the enrolment: the account that must enrol, a set-up, and the codes for "492039". */
function enrolmentRoutes(overrides: Record<string, Route> = {}): void {
  routes({
    "GET /v1/me": () => json(account(), 200),
    "POST /v1/me/mfa/setup": () =>
      json({ secret: TOTP_SECRET, otpauthUrl: OTPAUTH_URL, expiresIn: 600 }, 200),
    "POST /v1/me/mfa/enable": (call) =>
      (call.body as { code?: string }).code === "492039"
        ? json({ recoveryCodes: RECOVERY_CODES }, 200)
        : apiError("MFA_CODE_INVALID", 422),
    ...overrides,
  });
}

/**
 * Once per file, before any test: the first render of the page and the start of a set-up through its action. The first
 * run of those paths in a fresh worker is the slowest, and on a busy CI runner it otherwise lands in the first test's
 * own five seconds; here it has the hook's budget. Nothing of it stays: each test gets fresh mocks and an empty page.
 */
beforeAll(async () => {
  resetPlatformApi();
  enrolmentRoutes();
  await openEnrolment();
  submit(SECURITY_STRINGS.mfaStart);
  await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The page ---------------------------------------------------------------------------------------------------

describe("/mfa-enrolment", () => {
  it("[PFE-030 AC1] says why, offers the set-up and 'Sign out', and holds no secret itself", async () => {
    enrolmentRoutes();
    await openEnrolment();

    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      MFA_ENROLMENT_STRINGS.title,
    ]);
    expect(main.textContent).toContain(MFA_ENROLMENT_STRINGS.intro);
    expect(main.textContent).toContain(MFA_ENROLMENT_STRINGS.why);
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.mfaStart })).toBeTruthy();
    const signOut = screen.getByRole("button", { name: MFA_ENROLMENT_STRINGS.signOut }).closest("form");
    expect(signOut?.getAttribute("action")).toBe("/sign-out");
    expect(signOut?.getAttribute("method")).toBe("post");
    // No shell: no navigation of the signed-in area, and no set-up started before the person asks.
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(calls("GET", "/v1/me")).toHaveLength(1);
    expect(calls("POST", "/v1/me/mfa/setup")).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain(TOTP_SECRET);
  });

  it("[PFE-030 AC1] enrols with a wrong and then a right code, shows the ten recovery codes once and continues to next", async () => {
    enrolmentRoutes();
    const historyLength = window.history.length;
    await openEnrolment();

    submit(SECURITY_STRINGS.mfaStart);
    // The QR code is the server's geometry of the otpauth URI, drawn as an inline SVG; the URI never reaches the page.
    const qr = await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, ACTION_WAIT);
    const expected = qrCode(OTPAUTH_URL);
    expect(qr.getAttribute("viewBox")).toBe(`0 0 ${expected.size} ${expected.size}`);
    expect(qr.querySelector("path")?.getAttribute("d")).toBe(expected.path);
    expect(document.body.innerHTML).not.toContain("otpauth");
    expect(valueOf(SECURITY_STRINGS.mfaSecretLabel)).toBe(TOTP_SECRET);

    // A wrong code stays at the field and keeps the set-up.
    type(SECURITY_STRINGS.mfaCodeLabel, "111111");
    submit(SECURITY_STRINGS.mfaConfirm);
    expect(await screen.findByText(SECURITY_STRINGS.mfaCodeInvalid, {}, ACTION_WAIT)).toBeTruthy();
    expect(screen.getByRole("img", { name: SECURITY_STRINGS.mfaQrLabel })).toBeTruthy();
    expect(screen.queryByRole("link", { name: MFA_ENROLMENT_STRINGS.continue })).toBeNull();

    // The right code turns MFA on: the ten codes, once, with the shown-once warning, and "Continue" to next.
    type(SECURITY_STRINGS.mfaCodeLabel, "492 039");
    submit(SECURITY_STRINGS.mfaConfirm);
    const enabled = await screen.findByRole(
      "heading",
      { name: MFA_ENROLMENT_STRINGS.enabledTitle },
      ACTION_WAIT,
    );
    expect(document.activeElement).toBe(enabled);
    const panel = screen
      .getByRole("heading", { name: SECURITY_STRINGS.recoveryCodesTitle })
      .closest("section");
    expect(within(panel as HTMLElement).getByText(SECRET_STRINGS.warningTitle)).toBeTruthy();
    RECOVERY_CODES.forEach((code, index) => {
      expect(valueOf(SECURITY_STRINGS.recoveryCodeLabel(index + 1))).toBe(code);
    });
    expect(calls("POST", "/v1/me/mfa/enable").map((call) => call.body)).toEqual([
      { code: "111111" },
      { code: "492039" },
    ]);
    expect(screen.getByRole("link", { name: MFA_ENROLMENT_STRINGS.continue }).getAttribute("href")).toBe(
      OTA_PAGE,
    );
    // The set-up is over, and no page was rendered again (it would have left for next before the codes were seen).
    expect(screen.queryByRole("img", { name: SECURITY_STRINGS.mfaQrLabel })).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOTP_SECRET);
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
    // Nothing of a secret was kept where it could outlive the page.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(window.history.length).toBe(historyLength);
    for (const code of RECOVERY_CODES) {
      expect(window.location.href).not.toContain(code);
    }

    // "I have stored it" removes the codes; "Continue" stays, with no message of an enrolment made elsewhere.
    fireEvent.click(screen.getByRole("button", { name: SECRET_STRINGS.dismiss }));
    expect(screen.queryByLabelText(SECURITY_STRINGS.recoveryCodeLabel(1))).toBeNull();
    expect(screen.queryByText(MFA_ENROLMENT_STRINGS.alreadyEnabled)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: MFA_ENROLMENT_STRINGS.continue }).getAttribute("href")).toBe(
      OTA_PAGE,
    );
  });

  it("[PFE-030 AC1] keeps next only when safeNextPath accepts it: an outside URL falls back to /dashboard", async () => {
    for (const next of [
      "https://evil.example/x",
      "//evil.example",
      "/\\evil.example",
      "/%2e//evil.example",
    ]) {
      enrolmentRoutes({ "GET /v1/me": () => json(account({ mfaEnrolmentRequired: false }), 200) });
      await expect(MfaEnrolmentPage({ searchParams: Promise.resolve({ next }) })).rejects.toThrow(
        "NEXT_REDIRECT /dashboard",
      );
    }
    // Never the enrolment page itself, and a missing or repeated next is no next.
    enrolmentRoutes({ "GET /v1/me": () => json(account({ mfaEnrolmentRequired: false }), 200) });
    await expect(
      MfaEnrolmentPage({ searchParams: Promise.resolve({ next: `${MFA_ENROLMENT_PATH}?next=%2Fotas` }) }),
    ).rejects.toThrow("NEXT_REDIRECT /dashboard");
    await expect(MfaEnrolmentPage({})).rejects.toThrow("NEXT_REDIRECT /dashboard");

    // A page of the portal is kept, with its query: the "Continue" of the enrolment goes there.
    enrolmentRoutes();
    await openEnrolment({ next: `${OTA_PAGE}?tab=invitations` });
    submit(SECURITY_STRINGS.mfaStart);
    await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, ACTION_WAIT);
    type(SECURITY_STRINGS.mfaCodeLabel, "492039");
    submit(SECURITY_STRINGS.mfaConfirm);
    const next = await screen.findByRole("link", { name: MFA_ENROLMENT_STRINGS.continue }, ACTION_WAIT);
    expect(next.getAttribute("href")).toBe(`${OTA_PAGE}?tab=invitations`);
  });

  it("[PFE-030 AC2] sends an account that needs no enrolment to next at once, no session to sign-in and an unverified one to /verify-pending", async () => {
    enrolmentRoutes({
      "GET /v1/me": () => json(account({ mfaEnrolmentRequired: false, mfaEnabled: true }), 200),
    });
    await expect(MfaEnrolmentPage({ searchParams: Promise.resolve({ next: OTA_PAGE }) })).rejects.toThrow(
      `NEXT_REDIRECT ${OTA_PAGE}`,
    );

    jar.clear();
    enrolmentRoutes({ "GET /v1/me": () => apiError("UNAUTHENTICATED", 401) });
    await expect(MfaEnrolmentPage({ searchParams: Promise.resolve({ next: OTA_PAGE }) })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: mfaEnrolmentPath(OTA_PAGE) }).toString()}`,
    );
    await expect(MfaEnrolmentPage({})).rejects.toThrow("NEXT_REDIRECT /sign-in?next=%2Fmfa-enrolment");

    enrolmentRoutes({ "GET /v1/me": () => json(account({ emailVerified: false }), 200) });
    await expect(MfaEnrolmentPage({})).rejects.toThrow("NEXT_REDIRECT /verify-pending");
  });

  it("shows the portal's message in place of the set-up when the account cannot be loaded, and keeps 'Sign out'", async () => {
    enrolmentRoutes({ "GET /v1/me": () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openEnrolment();

    expect(screen.getByRole("main").textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(screen.getByRole("main").textContent).not.toContain("The API's own text");
    expect(screen.queryByRole("button", { name: SECURITY_STRINGS.mfaStart })).toBeNull();
    expect(screen.getByRole("button", { name: MFA_ENROLMENT_STRINGS.signOut })).toBeTruthy();
  });

  it("offers 'Continue' when MFA was turned on in another tab, and a new set-up once the pending one expired", async () => {
    enrolmentRoutes({
      "POST /v1/me/mfa/enable": () => apiError("MFA_SETUP_EXPIRED", 422),
    });
    await openEnrolment();
    submit(SECURITY_STRINGS.mfaStart);
    await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, ACTION_WAIT);
    type(SECURITY_STRINGS.mfaCodeLabel, "492039");
    submit(SECURITY_STRINGS.mfaConfirm);
    expect(await screen.findByText(SECURITY_STRINGS.mfaSetupExpired, {}, ACTION_WAIT)).toBeTruthy();
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.mfaStartAgain })).toBeTruthy();
    cleanup();

    enrolmentRoutes({ "POST /v1/me/mfa/setup": () => apiError("MFA_ALREADY_ENABLED", 409) });
    await openEnrolment();
    submit(SECURITY_STRINGS.mfaStart);
    expect(await screen.findByText(MFA_ENROLMENT_STRINGS.alreadyEnabled, {}, ACTION_WAIT)).toBeTruthy();
    expect(screen.getByRole("link", { name: MFA_ENROLMENT_STRINGS.continue }).getAttribute("href")).toBe(
      OTA_PAGE,
    );
  });

  it("says MFA is on and to replace the recovery codes when the answer holds none of the document's shape", async () => {
    enrolmentRoutes({ "POST /v1/me/mfa/enable": () => json({ recoveryCodes: ["pfe030-not-a-code"] }, 200) });
    await openEnrolment();
    submit(SECURITY_STRINGS.mfaStart);
    await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, ACTION_WAIT);
    type(SECURITY_STRINGS.mfaCodeLabel, "492039");
    submit(SECURITY_STRINGS.mfaConfirm);

    await screen.findByRole("heading", { name: MFA_ENROLMENT_STRINGS.enabledTitle }, ACTION_WAIT);
    // An alert, not "try again": MFA is on, and the security page replaces the codes.
    expect(screen.getByRole("alert").textContent).toBe(MFA_ENROLMENT_STRINGS.codesUnavailable);
    expect(screen.queryByText(ERROR_MESSAGES.INTERNAL_ERROR)).toBeNull();
    expect(screen.queryByLabelText(SECURITY_STRINGS.recoveryCodeLabel(1))).toBeNull();
    expect(document.body.innerHTML).not.toContain("pfe030-not-a-code");
    expect(screen.getByRole("link", { name: MFA_ENROLMENT_STRINGS.continue }).getAttribute("href")).toBe(
      OTA_PAGE,
    );
  });
});

// ---- The page's actions -------------------------------------------------------------------------------------------

describe("/mfa-enrolment actions", () => {
  const idleSetup = { status: "idle" } as const;
  const idleEnable = { status: "idle" } as const;

  it("refuses a code of the wrong shape without a call, and shows nothing of an answer that is not the document's", async () => {
    enrolmentRoutes({
      "POST /v1/me/mfa/setup": () =>
        json({ secret: "not base32!", otpauthUrl: OTPAUTH_URL, expiresIn: 600 }, 200),
      "POST /v1/me/mfa/enable": () => json({ recoveryCodes: ["short"] }, 200),
    });

    expect(await confirmEnrolment(idleEnable, formData({ code: "12345" }))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      fieldError: SECURITY_STRINGS.mfaCodeFormat,
    });
    expect(calls("POST", "/v1/me/mfa/enable")).toHaveLength(0);

    const started = await beginEnrolment(idleSetup, new FormData());
    expect(started).toEqual({
      status: "failed",
      code: "INTERNAL_ERROR",
      message: ERROR_MESSAGES.INTERNAL_ERROR,
    });
    expect(JSON.stringify(started)).not.toContain("not base32");

    // MFA is on even so: the state says the codes could not be shown, and holds none of the answer.
    const enabled = await confirmEnrolment(idleEnable, formData({ code: "492039" }));
    expect(enabled).toEqual({
      status: "enabled",
      code: "INTERNAL_ERROR",
      message: MFA_ENROLMENT_STRINGS.codesUnavailable,
    });
    expect(JSON.stringify(enabled)).not.toContain("short");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("sends an ended session to sign-in and back to the enrolment with its next", async () => {
    enrolmentRoutes({
      "POST /v1/me/mfa/setup": () => apiError("TOKEN_EXPIRED", 401),
      "POST /v1/me/mfa/enable": () => apiError("UNAUTHENTICATED", 401),
    });
    const back = `/sign-in?${new URLSearchParams({ next: mfaEnrolmentPath(OTA_PAGE) }).toString()}`;

    await expect(beginEnrolment(idleSetup, new FormData())).rejects.toThrow(`NEXT_REDIRECT ${back}`);
    await expect(confirmEnrolment(idleEnable, formData({ code: "492039" }))).rejects.toThrow(
      `NEXT_REDIRECT ${back}`,
    );
    requestedPage(undefined);
    await expect(beginEnrolment(idleSetup, new FormData())).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });

  it("answers the rate limit and other refusals in the portal's words", async () => {
    enrolmentRoutes({
      "POST /v1/me/mfa/setup": () => apiError("RATE_LIMITED", 429),
      "POST /v1/me/mfa/enable": () => apiError("RATE_LIMITED", 429),
    });

    expect(await beginEnrolment(idleSetup, new FormData())).toEqual({
      status: "failed",
      code: "RATE_LIMITED",
      message: SECURITY_STRINGS.rateLimited,
    });
    expect(await confirmEnrolment(idleEnable, formData({ code: "492039" }))).toEqual({
      status: "failed",
      code: "RATE_LIMITED",
      message: SECURITY_STRINGS.mfaRateLimited,
    });
  });
});

// ---- The enrolment gate everywhere else: lib/errors.ts and the API client ---------------------------------------

describe("the API's enrolment gate leads to the page", () => {
  it("recognises only MFA_REQUIRED with details.reason enrolment_required", () => {
    expect(isMfaEnrolmentRequired({ code: "MFA_REQUIRED", details: { reason: "enrolment_required" } })).toBe(
      true,
    );
    expect(isMfaEnrolmentRequired({ code: "MFA_REQUIRED", details: {} })).toBe(false);
    expect(isMfaEnrolmentRequired({ code: "MFA_REQUIRED" })).toBe(false);
    expect(isMfaEnrolmentRequired({ code: "FORBIDDEN", details: { reason: "enrolment_required" } })).toBe(
      false,
    );
    expect(mfaEnrolmentPath()).toBe("/mfa-enrolment");
    expect(mfaEnrolmentPath(`/console?tenant=${TENANT_ID}`)).toBe(
      `/mfa-enrolment?next=${encodeURIComponent(`/console?tenant=${TENANT_ID}`)}`,
    );
    expect(() => leaveForMfaEnrolment({ code: "MFA_REQUIRED" }, OTA_PAGE)).not.toThrow();
    expect(() =>
      leaveForMfaEnrolment({ code: "MFA_REQUIRED", details: { reason: "enrolment_required" } }, OTA_PAGE),
    ).toThrow(`NEXT_REDIRECT ${mfaEnrolmentPath(OTA_PAGE)}`);
  });

  it("[PFE-030 AC1] a server action's enrolment_required answer leads to the page and back to the page it was on", async () => {
    requestedPage("/account/security");
    routes({ "POST /v1/me/password": enrolmentRequired });
    const idle: PasswordState = { status: "idle", fieldErrors: {} };
    const typed = formData({
      currentPassword: "pfe030-current-password",
      newPassword: "pfe030-new-password-1234",
    });

    await expect(changeAccountPassword(idle, typed)).rejects.toThrow(
      "NEXT_REDIRECT /mfa-enrolment?next=%2Faccount%2Fsecurity",
    );

    // Any other MFA_REQUIRED (an action that needs MFA of an account without the enrolment) keeps its own answer.
    routes({ "POST /v1/me/password": () => apiError("MFA_REQUIRED", 403) });
    const refused = await changeAccountPassword(idle, typed);
    expect(refused).toMatchObject({
      status: "failed",
      code: "MFA_REQUIRED",
      message: ERROR_MESSAGES.MFA_REQUIRED,
    });
  });

  it("[PFE-030 AC1] an OTA page whose API call meets the gate leaves for the page, even inside the shell", async () => {
    requestedPage(OTA_PAGE);
    routes({ [`GET /v1/tenants/${TENANT_ID}`]: enrolmentRequired });

    await expect(
      OtaLayout({ children: <p>Team</p>, params: Promise.resolve({ tenantId: TENANT_ID }) }),
    ).rejects.toThrow(`NEXT_REDIRECT ${mfaEnrolmentPath(OTA_PAGE)}`);
  });

  it("[PFE-030 AC1] an invitation acceptance that meets the gate enrols first and comes back to the invitation", async () => {
    // The middleware hands the acceptance its path alone (middleware.test.ts "requested page").
    requestedPage("/invitations/accept");
    jar.set(INVITATION_COOKIE, "pfe030-dummy-invitation-token");
    routes({ "POST /v1/invitations/accept": enrolmentRequired });

    await expect(acceptInvitation()).rejects.toThrow(
      "NEXT_REDIRECT /mfa-enrolment?next=%2Finvitations%2Faccept",
    );
    expect(calls("POST", "/v1/invitations/accept").map((call) => call.body)).toEqual([
      { token: "pfe030-dummy-invitation-token" },
    ]);
  });

  // The route handlers with a client of their own (the console launch, Stripe Connect's callback) answer their own
  // `303` to the page: their tests (console/launch/route.test.ts, connect/stripe/callback/route.test.ts) run in Node,
  // where a request keeps the `Origin` header that happy-dom's drops.
});
