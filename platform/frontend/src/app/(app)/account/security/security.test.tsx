// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { create } from "qrcode";
import { Component, type ReactElement, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the configuration; the real API client talks to a mocked fetch ----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/account/security",
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

import { saveProfile, type ProfileState } from "@/app/(app)/account/actions";
import AccountPage from "@/app/(app)/account/page";
import {
  beginMfaSetup,
  changeAccountPassword,
  confirmMfaSetup,
  replaceRecoveryCodes,
  revokeAccountSession,
  signOutEverywhere,
  turnOffMfa,
} from "@/app/(app)/account/security/actions";
import SecurityPage from "@/app/(app)/account/security/page";
import { deviceOf } from "@/app/(app)/account/security/sessions-table";
import { fieldId } from "@/components/form-field";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { QR_MAX_TEXT_LENGTH, QR_QUIET_ZONE, qrCode } from "@/lib/qr";
import {
  ACCESS_TOKEN_COOKIE,
  MFA_CHALLENGE_COOKIE,
  NEXT_PATH_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from "@/lib/session";
import {
  ACCOUNT_STRINGS,
  ERROR_MESSAGES,
  SECRET_STRINGS,
  SECURITY_STRINGS,
  SIGN_UP_STRINGS,
  STEP_UP_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, secret, password or recovery code) -------------------------------

type Schemas = components["schemas"];
type Account = Schemas["Account"];
type AccountSession = Schemas["AccountSession"];

const ACCESS_TOKEN = "pfe007-dummy-access-token";
const REFRESH_TOKEN = "pfe007-dummy-refresh-token";
const STEPPED_UP_ACCESS_TOKEN = "pfe007-stepped-up-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-007 test)";

/** A pending TOTP secret and its URI as `startMfaSetup` answers them (base32 letters only: a dummy). */
const TOTP_SECRET = "PFEZEROSEVENDUMMYSECRETNEVERREAL";
const OTPAUTH_URL = `otpauth://totp/Velexis:anna.berg%40example.com?secret=${TOTP_SECRET}&issuer=Velexis&algorithm=SHA1&digits=6&period=30`;
/** Ten recovery codes in the document's format (Crockford base32); dummies. */
const RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `PF0${index}-7D7M-MYRC-0DE${index}`);
const NEW_RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `NEW${index}-7D7M-MYRC-0DE${index}`);
/** Passwords typed into the form; dummies that never reach a fixture of the API. */
const CURRENT_PASSWORD = "pfe007-current-password";
const NEW_PASSWORD = "pfe007-new-password-long-enough";

/** The dates the pages show; the tests never read their text, so any instant will do (no fixed calendar date). */
const NOW = Date.now();
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const FEATURES_OFF: Schemas["MilestoneFeatures"] = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

/** The signed-in account (`getMe`), version 3, MFA off unless the test says otherwise. */
function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "anna.berg@example.com",
    emailVerified: true,
    fullName: "Anna Berg",
    locale: "en-GB",
    timeZone: "Europe/Oslo",
    mfaEnabled: false,
    mfaEnabledAt: null,
    isPlatformAdmin: false,
    createdAt: iso(-90 * DAY_MS),
    version: 3,
    memberships: [],
    features: FEATURES_OFF,
    ...overrides,
  };
}

const MFA_ON: Partial<Account> = { mfaEnabled: true, mfaEnabledAt: iso(-10 * DAY_MS) };

/** The session of this browser, another browser of the account, and a platform admin session. */
const THIS_SESSION: AccountSession = {
  familyId: "asn_01JA2ZB4N8Q6R1T5V9X3Z7C2E6",
  audience: "portal",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15",
  ipAddress: "203.0.113.24",
  createdAt: iso(-2 * DAY_MS),
  lastUsedAt: iso(-HOUR_MS),
  current: true,
};
const OTHER_SESSION: AccountSession = {
  familyId: "asn_01J9XK2M5P8R3T6V1X4Z7B0D3F",
  audience: "portal",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  ipAddress: "2001:db8::7",
  createdAt: iso(-12 * DAY_MS),
  lastUsedAt: null,
  current: false,
};
const ADMIN_SESSION: AccountSession = {
  familyId: "asn_01J9XK2M5P8R3T6V1X4Z7B0D3G",
  audience: "platform_admin",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ipAddress: null,
  createdAt: iso(-20 * DAY_MS),
  lastUsedAt: iso(-3 * DAY_MS),
  current: false,
};
const SESSIONS = [THIS_SESSION, OTHER_SESSION, ADMIN_SESSION] as const;

/** A new session as `stepUp` answers it; the token values are dummies. */
function steppedUpSession(): Schemas["PortalSession"] {
  return {
    accessToken: STEPPED_UP_ACCESS_TOKEN,
    accessTokenExpiresAt: iso(15 * 60 * 1000),
    refreshToken: "pfe007-stepped-up-refresh-token",
    refreshTokenExpiresAt: iso(7 * DAY_MS),
    account: account(MFA_ON),
  };
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

/** One call the portal made: what the tests check (the body is read before the route answers). */
interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();
let sent: Call[] = [];

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An empty `204`, as the API sends it (Express writes `Content-Length: 0`). */
function empty(): Response {
  return new Response(null, { status: 204, headers: { "content-length": "0" } });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(
  code: string,
  status: number,
  extra: { details?: Record<string, unknown>; fieldErrors?: { path: string; code: string }[] } = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pfe007",
        ...extra,
      },
    },
    status,
  );
}

type Route = (call: Call) => Response | Promise<Response>;

/** The routes of the pages: the account (MFA off) and its three sessions. */
function defaultRoutes(): Record<string, Route> {
  return {
    "GET /v1/me": () => json(account(), 200, { etag: '"3"' }),
    "GET /v1/me/sessions": () => json({ data: SESSIONS }, 200),
  };
}

/** Answers each call by `METHOD /path`; a call without a route fails the test. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = { ...defaultRoutes(), ...overrides };
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

/** The calls of `METHOD /path` so far. */
function calls(method: string, path: string): Call[] {
  return sent.filter((call) => call.method === method && call.path === path);
}

/** The call carries the session's bearer token and the end-user headers of PADR-0019. */
function expectSessionHeaders(call: Call | undefined, accessToken = ACCESS_TOKEN): void {
  expect(call?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  expect(call?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(call?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(call?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The cookies of the request: a jar the actions write to as a browser would keep them. */
const jar = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string, options: { maxAge: number }) => {
  if (options.maxAge === 0) {
    jar.delete(name);
  } else {
    jar.set(name, value);
  }
});

function cookieStore() {
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) ?? "" } : undefined),
    has: (name: string) => jar.has(name),
    set: cookieSet,
  };
}

/** The cookies written with `maxAge: 0`, by name. */
function deletedCookies(): string[] {
  return cookieSet.mock.calls.filter(([, , options]) => options.maxAge === 0).map(([name]) => name);
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
 * The budget of the hooks that open a page first: the first render in a fresh worker loads the page's modules (Radix,
 * TanStack Table, the actions, the QR encoder) and the profile's some 430 time zones, and is the slowest by far on a
 * busy CI runner.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/** `/account` for one request, inside the redirect boundary. */
async function openAccount(): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await AccountPage();
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

/** `/account/security` for one request, inside the redirect boundary. */
async function openSecurity(): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await SecurityPage();
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

async function redirectedTo(): Promise<string> {
  const status = await screen.findByText(/^Redirected to /, {}, ACTION_WAIT);
  return status.textContent?.replace(/^Redirected to /, "") ?? "";
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

/** Types `value` into the field labelled `label`. */
function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Opens the confirmation of the button named `trigger` and confirms it with the button named `confirm`. */
async function confirmWith(trigger: string, confirm: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  const dialog = await screen.findByRole("alertdialog", {}, ACTION_WAIT);
  fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
}

/** Answers the step-up dialog with a code. */
async function stepUpWith(code: string): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
  fireEvent.change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), { target: { value: code } });
  submit(STEP_UP_STRINGS.submit);
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: Element): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** The value of the field labelled `label`. */
function valueOf(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value;
}

/** The sessions table (its caption names it), and the row of a device in it. */
function sessionsTable(): HTMLElement {
  return screen.getByRole("table", { name: SECURITY_STRINGS.sessionsCaption });
}

function rowOf(device: string): HTMLElement | null {
  return within(sessionsTable()).queryByText(device)?.closest("tr") ?? null;
}

/** Nothing of a secret was written where it could outlive the page. */
function expectNothingStored(historyLength: number): void {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(document.cookie).toBe("");
  expect(window.history.length).toBe(historyLength);
  expect(window.location.href).not.toContain(TOTP_SECRET);
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

/** A fresh mocked platform API: the default routes, the session cookies, the end user's headers. */
function resetPlatformApi(): void {
  fetchMock.mockReset();
  sent = [];
  vi.stubGlobal("fetch", fetchMock);
  navigation.redirect.mockClear();
  nextCache.revalidatePath.mockReset();
  cookieSet.mockClear();
  jar.clear();
  jar.set(ACCESS_TOKEN_COOKIE, ACCESS_TOKEN);
  jar.set(REFRESH_TOKEN_COOKIE, REFRESH_TOKEN);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe007_portal",
    }),
  );
  nextHeaders.cookies.mockImplementation(() => Promise.resolve(cookieStore()));
  window.localStorage.clear();
  window.sessionStorage.clear();
  routes();
}

/**
 * Once per file, before any test: the first render of both pages, a profile save and the start of an MFA set-up
 * through their actions. The first run of those paths in a fresh worker is the slowest, and on a busy CI runner it
 * otherwise lands in the first test's own five seconds; here it has the hook's budget. Nothing of it stays: each test
 * gets a fresh API, fresh mocks and globals (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({
    "PATCH /v1/me": () => json(account({ fullName: "Anna Berg-Lund", version: 4 }), 200),
    "POST /v1/me/mfa/setup": () =>
      json({ secret: TOTP_SECRET, otpauthUrl: OTPAUTH_URL, expiresIn: 600 }, 200),
  });
  await openAccount();
  type(ACCOUNT_STRINGS.fullNameLabel, "Anna Berg-Lund");
  submit(ACCOUNT_STRINGS.submit);
  await screen.findByText(ACCOUNT_STRINGS.saved, {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openSecurity();
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

// ---- lib/qr.ts --------------------------------------------------------------------------------------------------

/** The dark modules of a `qrCode` path, as `row:column` of the symbol (the quiet zone taken off). */
function darkModulesOf(path: string): Set<string> {
  const dark = new Set<string>();
  const commands = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let consumed = 0;
  for (const match of path.matchAll(commands)) {
    const [whole, x, y, run, back] = match;
    expect(back).toBe(run);
    consumed += whole.length;
    for (let offset = 0; offset < Number(run); offset += 1) {
      dark.add(`${Number(y) - QR_QUIET_ZONE}:${Number(x) - QR_QUIET_ZONE + offset}`);
    }
  }
  // Nothing but these commands: no markup, no other path syntax.
  expect(consumed).toBe(path.length);
  return dark;
}

describe("lib/qr.ts", () => {
  it("[PFE-007 AC1] draws exactly the dark modules of the qrcode package's symbol, inside a 4-module quiet zone", () => {
    const qr = qrCode(OTPAUTH_URL);
    const { modules } = create(OTPAUTH_URL, { errorCorrectionLevel: "M" });

    expect(qr.size).toBe(modules.size + 2 * QR_QUIET_ZONE);
    const expected = new Set<string>();
    for (let row = 0; row < modules.size; row += 1) {
      for (let column = 0; column < modules.size; column += 1) {
        if (modules.get(row, column) !== 0) {
          expected.add(`${row}:${column}`);
        }
      }
    }
    expect(darkModulesOf(qr.path)).toEqual(expected);
    // The three finder patterns: a dark corner module at the top left, top right and bottom left of the symbol.
    for (const corner of ["0:0", `0:${modules.size - 1}`, `${modules.size - 1}:0`]) {
      expect(expected.has(corner)).toBe(true);
    }
    // The same text always gives the same code; another text another one.
    expect(qrCode(OTPAUTH_URL)).toEqual(qr);
    expect(qrCode(`${OTPAUTH_URL}x`).path).not.toBe(qr.path);
  });

  it("refuses an empty or over-long text", () => {
    expect(() => qrCode("")).toThrow(RangeError);
    expect(() => qrCode("x".repeat(QR_MAX_TEXT_LENGTH + 1))).toThrow(RangeError);
    expect(qrCode("x".repeat(QR_MAX_TEXT_LENGTH)).size).toBeGreaterThan(2 * QR_QUIET_ZONE);
  });
});

// ---- /account -----------------------------------------------------------------------------------------------------

describe("/account", () => {
  it("[PFE-007 AC3] a stale profile edit shows the reload message and keeps what was typed [PF-07 AC1]", async () => {
    routes({ "PATCH /v1/me": () => apiError("PRECONDITION_FAILED", 412) });
    await openAccount();

    type(ACCOUNT_STRINGS.fullNameLabel, "Anna Berg-Lund");
    submit(ACCOUNT_STRINGS.submit);

    const summary = await screen.findByRole("alert", {}, ACTION_WAIT);
    expect(summary.textContent).toContain(ACCOUNT_STRINGS.stale);
    expect(document.activeElement).toBe(summary);
    const reload = screen.getByRole("link", { name: ACCOUNT_STRINGS.reload });
    expect(reload.getAttribute("href")).toBe("/account");
    // What was typed stays, and so does the version: a save after a reload is checked against the current one.
    expect(valueOf(ACCOUNT_STRINGS.fullNameLabel)).toBe("Anna Berg-Lund");
    expect(document.querySelector<HTMLInputElement>('input[name="version"]')?.value).toBe("3");
    const [patch, ...more] = calls("PATCH", "/v1/me");
    expect(more).toHaveLength(0);
    expect(patch?.headers.get("if-match")).toBe('"3"');
    expectSessionHeaders(patch);
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("saves the name, language and time zone with If-Match, then the next save sends the new version", async () => {
    let version = 3;
    routes({
      "PATCH /v1/me": (call) => {
        version += 1;
        const body = call.body as { fullName: string; locale: string; timeZone: string };
        return json(account({ ...body, version }), 200, { etag: `"${version}"` });
      },
    });
    await openAccount();

    type(ACCOUNT_STRINGS.fullNameLabel, "  Anna Berg-Lund  ");
    type(ACCOUNT_STRINGS.localeLabel, "en-US");
    type(ACCOUNT_STRINGS.timeZoneLabel, "America/New_York");
    submit(ACCOUNT_STRINGS.submit);

    expect(await screen.findByText(ACCOUNT_STRINGS.saved, {}, ACTION_WAIT)).toBeTruthy();
    expect(valueOf(ACCOUNT_STRINGS.fullNameLabel)).toBe("Anna Berg-Lund");
    expect(document.querySelector<HTMLInputElement>('input[name="version"]')?.value).toBe("4");
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/", "layout");

    type(ACCOUNT_STRINGS.timeZoneLabel, "Europe/Oslo");
    submit(ACCOUNT_STRINGS.submit);
    await waitFor(
      () => expect(document.querySelector<HTMLInputElement>('input[name="version"]')?.value).toBe("5"),
      ACTION_WAIT,
    );

    const [first, second, ...more] = calls("PATCH", "/v1/me");
    expect(more).toHaveLength(0);
    expect(first?.headers.get("if-match")).toBe('"3"');
    // The trimmed name; the e-mail address is never sent.
    expect(first?.body).toEqual({
      fullName: "Anna Berg-Lund",
      locale: "en-US",
      timeZone: "America/New_York",
    });
    expect(second?.headers.get("if-match")).toBe('"4"');
    expect(second?.body).toEqual({ fullName: "Anna Berg-Lund", locale: "en-US", timeZone: "Europe/Oslo" });
  });

  it("shows the profile: one h1, the address read-only, the account's language and zone preselected", async () => {
    await openAccount();

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      ACCOUNT_STRINGS.title,
    ]);
    expect(document.querySelector('[data-field="email"]')?.textContent).toBe("anna.berg@example.com");
    expect(document.querySelector('input[name="email"]')).toBeNull();
    expect(valueOf(ACCOUNT_STRINGS.fullNameLabel)).toBe("Anna Berg");
    expect(valueOf(ACCOUNT_STRINGS.localeLabel)).toBe("en-GB");
    expect(valueOf(ACCOUNT_STRINGS.timeZoneLabel)).toBe("Europe/Oslo");
    const locales = screen.getByLabelText(ACCOUNT_STRINGS.localeLabel) as HTMLSelectElement;
    expect([...locales.options].map((option) => option.value)).toEqual(["en", "en-GB", "en-US"]);
    const [me, ...more] = calls("GET", "/v1/me");
    expect(more).toHaveLength(0);
    expectSessionHeaders(me);
  });

  it("keeps another valid language of the account among the options", async () => {
    routes({ "GET /v1/me": () => json(account({ locale: "nb-NO" }), 200) });
    await openAccount();

    const locales = screen.getByLabelText(ACCOUNT_STRINGS.localeLabel) as HTMLSelectElement;
    expect([...locales.options].map((option) => option.value)).toEqual(["en", "en-GB", "en-US", "nb-NO"]);
    expect(locales.value).toBe("nb-NO");
  });

  it("checks the form before any call, and puts the API's field errors at their fields", async () => {
    routes({
      "PATCH /v1/me": () =>
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/timeZone", code: "unknown" }] }),
    });
    await openAccount();

    type(ACCOUNT_STRINGS.fullNameLabel, "   ");
    submit(ACCOUNT_STRINGS.submit);
    const name = await screen.findByLabelText(ACCOUNT_STRINGS.fullNameLabel);
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"), ACTION_WAIT);
    expect(descriptionsOf(name)).toContain(ACCOUNT_STRINGS.fullNameRequired);
    expect(calls("PATCH", "/v1/me")).toHaveLength(0);

    type(ACCOUNT_STRINGS.fullNameLabel, "Anna Berg");
    submit(ACCOUNT_STRINGS.submit);
    const zone = screen.getByLabelText(ACCOUNT_STRINGS.timeZoneLabel);
    await waitFor(() => expect(descriptionsOf(zone)).toContain(ACCOUNT_STRINGS.timeZoneUnknown), ACTION_WAIT);
    expect(zone.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").querySelector(`a[href="#${fieldId("timeZone")}"]`)).not.toBeNull();
  });

  it("refuses a form without a version or with a broken locale without a call, and reads other refusals", async () => {
    const idle: ProfileState = {
      status: "idle",
      version: 3,
      values: { fullName: "", locale: "", timeZone: "" },
      fieldErrors: {},
    };
    const profile = (values: Record<string, string>) =>
      formData({ fullName: "Anna Berg", locale: "en", timeZone: "UTC", version: "3", ...values });

    expect(await saveProfile(idle, profile({ version: "" }))).toMatchObject({
      status: "failed",
      message: ACCOUNT_STRINGS.formExpired,
    });
    expect((await saveProfile(idle, profile({ locale: "English" }))).fieldErrors).toEqual({
      locale: ACCOUNT_STRINGS.localeUnknown,
    });
    expect((await saveProfile(idle, profile({ fullName: "n".repeat(201) }))).fieldErrors).toEqual({
      fullName: ACCOUNT_STRINGS.fullNameTooLong,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    routes({ "PATCH /v1/me": () => apiError("RATE_LIMITED", 429) });
    expect((await saveProfile(idle, profile({}))).message).toBe(ACCOUNT_STRINGS.rateLimited);
    routes({
      "PATCH /v1/me": () =>
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/header/If-Match", code: "pattern" }] }),
    });
    expect((await saveProfile(idle, profile({}))).message).toBe(ACCOUNT_STRINGS.formExpired);
    routes({ "PATCH /v1/me": () => apiError("UNAUTHENTICATED", 401) });
    await expect(saveProfile(idle, profile({}))).rejects.toThrow("NEXT_REDIRECT /sign-in?next=%2Faccount");
  });

  it("sends an ended session to sign-in and back, and shows the portal's message for other failures", async () => {
    routes({ "GET /v1/me": () => apiError("TOKEN_EXPIRED", 401) });
    await expect(AccountPage()).rejects.toThrow("NEXT_REDIRECT /sign-in?next=%2Faccount");

    routes({ "GET /v1/me": () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openAccount();
    expect(screen.getByText(ACCOUNT_STRINGS.unavailableTitle)).toBeTruthy();
    expect(screen.getByText(ERROR_MESSAGES.SERVICE_UNAVAILABLE)).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.querySelector("form")).toBeNull();
  });

  describe("rendered on the server", () => {
    let rendered: Awaited<ReturnType<typeof serverRenderAndHydrate>> | undefined;

    beforeEach(async () => {
      rendered = await serverRenderAndHydrate(await AccountPage());
    }, WARM_UP_TIMEOUT_MS);

    afterEach(() => {
      const root = rendered?.root;
      if (root !== undefined) {
        act(() => root.unmount());
      }
      rendered = undefined;
    });

    it("hydrates in the browser without an error or a change", () => {
      expect(rendered?.errors).toEqual([]);
      expect(rendered?.container.innerHTML).toBe(rendered?.serverDom);
      expect(rendered?.container.querySelector<HTMLInputElement>('input[name="version"]')?.value).toBe("3");
    });
  });
});

// ---- /account/security: two-factor authentication -----------------------------------------------------------------

describe("/account/security two-factor authentication", () => {
  it("[PFE-007 AC1] enabling MFA shows the recovery codes once; reloading the page does not show them again [PF-04 AC1]", async () => {
    routes({
      "POST /v1/me/mfa/setup": () =>
        json({ secret: TOTP_SECRET, otpauthUrl: OTPAUTH_URL, expiresIn: 600 }, 200, {
          "cache-control": "no-store",
        }),
      "POST /v1/me/mfa/enable": () =>
        json({ recoveryCodes: RECOVERY_CODES }, 200, { "cache-control": "no-store" }),
    });
    const historyLength = window.history.length;
    await openSecurity();
    // The page itself never holds the secret or a code.
    expect(document.body.innerHTML).not.toContain(TOTP_SECRET);
    expect(calls("POST", "/v1/me/mfa/setup")).toHaveLength(0);

    submit(SECURITY_STRINGS.mfaStart);
    const qr = await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, ACTION_WAIT);
    // The QR code is the server's geometry of the otpauth URI, drawn as an inline SVG; the URI never reaches the page.
    const expected = qrCode(OTPAUTH_URL);
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(qr.getAttribute("viewBox")).toBe(`0 0 ${expected.size} ${expected.size}`);
    expect(qr.querySelector("path")?.getAttribute("d")).toBe(expected.path);
    expect(document.body.innerHTML).not.toContain("otpauth");
    expect(valueOf(SECURITY_STRINGS.mfaSecretLabel)).toBe(TOTP_SECRET);
    expect(screen.getByText(SECURITY_STRINGS.mfaExpiresIn(10))).toBeTruthy();
    expectSessionHeaders(calls("POST", "/v1/me/mfa/setup")[0]);

    type(SECURITY_STRINGS.mfaCodeLabel, "492 039");
    submit(SECURITY_STRINGS.mfaConfirm);

    // The ten codes, once, with the shown-once warning.
    const panel = (
      await screen.findByRole("heading", { name: SECURITY_STRINGS.recoveryCodesTitle }, ACTION_WAIT)
    ).closest("section");
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByText(SECRET_STRINGS.warningTitle)).toBeTruthy();
    RECOVERY_CODES.forEach((code, index) => {
      expect(valueOf(SECURITY_STRINGS.recoveryCodeLabel(index + 1))).toBe(code);
    });
    const [enable, ...more] = calls("POST", "/v1/me/mfa/enable");
    expect(more).toHaveLength(0);
    expect(enable?.body).toEqual({ code: "492039" });
    expectSessionHeaders(enable);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/account/security");
    // The set-up is over: no QR code or secret any more, and MFA reads as on.
    expect(screen.queryByRole("img", { name: SECURITY_STRINGS.mfaQrLabel })).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOTP_SECRET);
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.turnOff })).toBeTruthy();
    expectNothingStored(historyLength);
    for (const code of RECOVERY_CODES) {
      expect(window.location.href).not.toContain(code);
      expect(jar.size).toBe(2);
      expect([...jar.values()]).not.toContain(code);
    }

    // A reload renders the page from getMe again: MFA on, and none of the codes.
    cleanup();
    document.body.replaceChildren();
    routes({ "GET /v1/me": () => json(account(MFA_ON), 200) });
    await openSecurity();
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.replaceCodes })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: SECURITY_STRINGS.recoveryCodesTitle })).toBeNull();
    for (const code of RECOVERY_CODES) {
      expect(document.body.innerHTML).not.toContain(code);
    }
    expect(document.body.innerHTML).not.toContain(TOTP_SECRET);
  });

  it("[PFE-007 AC1] replacing the codes asks for a step-up, shows the new codes once, and 'I have stored it' removes them", async () => {
    let replacements = 0;
    routes({
      "GET /v1/me": () => json(account(MFA_ON), 200),
      "POST /v1/me/mfa/recovery-codes": () => {
        replacements += 1;
        return replacements === 1
          ? apiError("REAUTH_REQUIRED", 401)
          : json({ recoveryCodes: NEW_RECOVERY_CODES }, 200, { "cache-control": "no-store" });
      },
      "POST /v1/auth/step-up": () => json(steppedUpSession(), 200, { "cache-control": "no-store" }),
    });
    const historyLength = window.history.length;
    await openSecurity();
    await confirmWith(SECURITY_STRINGS.replaceCodes, SECURITY_STRINGS.replaceCodesConfirm);
    await stepUpWith("492039");

    expect(
      await screen.findByRole("heading", { name: SECURITY_STRINGS.newRecoveryCodesTitle }, ACTION_WAIT),
    ).toBeTruthy();
    expect(screen.getByText(SECURITY_STRINGS.codesReplaced)).toBeTruthy();
    expect(valueOf(SECURITY_STRINGS.recoveryCodeLabel(10))).toBe(NEW_RECOVERY_CODES[9]);
    // The same replacement ran again, now with the stepped-up session the dialog stored in the cookies.
    const [first, second, ...more] = calls("POST", "/v1/me/mfa/recovery-codes");
    expect(more).toHaveLength(0);
    expectSessionHeaders(first);
    expectSessionHeaders(second, STEPPED_UP_ACCESS_TOKEN);
    expect(calls("POST", "/v1/auth/step-up")[0]?.body).toEqual({ code: "492039" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: SECRET_STRINGS.dismiss }));
    for (const code of NEW_RECOVERY_CODES) {
      expect(document.body.innerHTML).not.toContain(code);
    }
    expectNothingStored(historyLength);
    expect([...jar.values()].some((value) => NEW_RECOVERY_CODES.includes(value))).toBe(false);
  });

  it("[PFE-007 AC2] turning MFA off asks for a step-up and succeeds after it [PF-04 AC3]", async () => {
    let disables = 0;
    routes({
      "GET /v1/me": () => json(account(MFA_ON), 200),
      "POST /v1/me/mfa/disable": () => {
        disables += 1;
        return disables === 1 ? apiError("REAUTH_REQUIRED", 401) : empty();
      },
      "POST /v1/auth/step-up": () => json(steppedUpSession(), 200, { "cache-control": "no-store" }),
    });
    await openSecurity();

    await confirmWith(SECURITY_STRINGS.turnOff, SECURITY_STRINGS.turnOffConfirm);
    await stepUpWith("492039");

    expect(await screen.findByText(SECURITY_STRINGS.turnedOff, {}, ACTION_WAIT)).toBeTruthy();
    expect(calls("POST", "/v1/auth/step-up")[0]?.body).toEqual({ code: "492039" });
    // The same change ran again, now with the stepped-up session the dialog stored in the cookies.
    const [first, second, ...more] = calls("POST", "/v1/me/mfa/disable");
    expect(more).toHaveLength(0);
    expectSessionHeaders(first);
    expectSessionHeaders(second, STEPPED_UP_ACCESS_TOKEN);
    expect(jar.get(ACCESS_TOKEN_COOKIE)).toBe(STEPPED_UP_ACCESS_TOKEN);
    // MFA reads as off, and it can be set up again.
    expect(screen.queryByRole("button", { name: SECURITY_STRINGS.turnOff })).toBeNull();
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.mfaStart })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/account/security");
  });

  it("[PFE-007 AC2] keeps MFA on when the step-up is cancelled, and turns nothing off before the confirmation", async () => {
    routes({
      "GET /v1/me": () => json(account(MFA_ON), 200),
      "POST /v1/me/mfa/disable": () => apiError("REAUTH_REQUIRED", 401),
    });
    await openSecurity();

    // Cancelling the confirmation makes no call.
    fireEvent.click(screen.getByRole("button", { name: SECURITY_STRINGS.turnOff }));
    const confirmation = await screen.findByRole("alertdialog", {}, ACTION_WAIT);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(calls("POST", "/v1/me/mfa/disable")).toHaveLength(0);

    await confirmWith(SECURITY_STRINGS.turnOff, SECURITY_STRINGS.turnOffConfirm);
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: STEP_UP_STRINGS.cancel }));

    expect(await screen.findByText(SECURITY_STRINGS.turnOffCancelled, {}, ACTION_WAIT)).toBeTruthy();
    expect(calls("POST", "/v1/me/mfa/disable")).toHaveLength(1);
    expect(calls("POST", "/v1/auth/step-up")).toHaveLength(0);
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.turnOff })).toBeTruthy();
  });

  it("keeps a wrong code at its field, and offers a new set-up once the pending one expired", async () => {
    let enables = 0;
    routes({
      "POST /v1/me/mfa/setup": () =>
        json({ secret: TOTP_SECRET, otpauthUrl: OTPAUTH_URL, expiresIn: 600 }, 200),
      "POST /v1/me/mfa/enable": () => {
        enables += 1;
        return enables === 1 ? apiError("MFA_CODE_INVALID", 401) : apiError("MFA_SETUP_EXPIRED", 400);
      },
    });
    await openSecurity();
    submit(SECURITY_STRINGS.mfaStart);
    await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, ACTION_WAIT);

    // A code of the wrong shape never reaches the API.
    type(SECURITY_STRINGS.mfaCodeLabel, "12345");
    submit(SECURITY_STRINGS.mfaConfirm);
    await waitFor(
      () =>
        expect(descriptionsOf(screen.getByLabelText(SECURITY_STRINGS.mfaCodeLabel))).toContain(
          SECURITY_STRINGS.mfaCodeFormat,
        ),
      ACTION_WAIT,
    );
    expect(enables).toBe(0);

    type(SECURITY_STRINGS.mfaCodeLabel, "111111");
    submit(SECURITY_STRINGS.mfaConfirm);
    await waitFor(
      () =>
        expect(descriptionsOf(screen.getByLabelText(SECURITY_STRINGS.mfaCodeLabel))).toContain(
          SECURITY_STRINGS.mfaCodeInvalid,
        ),
      ACTION_WAIT,
    );
    // The set-up stays, so the next code can be tried.
    expect(screen.getByRole("img", { name: SECURITY_STRINGS.mfaQrLabel })).toBeTruthy();

    type(SECURITY_STRINGS.mfaCodeLabel, "222222");
    submit(SECURITY_STRINGS.mfaConfirm);
    expect(await screen.findByText(SECURITY_STRINGS.mfaSetupExpired, {}, ACTION_WAIT)).toBeTruthy();
    expect(screen.queryByRole("img", { name: SECURITY_STRINGS.mfaQrLabel })).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOTP_SECRET);
    submit(SECURITY_STRINGS.mfaStartAgain);
    expect(await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, ACTION_WAIT)).toBeTruthy();
    expect(calls("POST", "/v1/me/mfa/setup")).toHaveLength(2);
  });

  it("cancels a set-up without a call, and explains MFA turned on elsewhere with a reload link", async () => {
    let setups = 0;
    routes({
      "POST /v1/me/mfa/setup": () => {
        setups += 1;
        return setups === 1
          ? json({ secret: TOTP_SECRET, otpauthUrl: OTPAUTH_URL, expiresIn: 600 }, 200)
          : apiError("MFA_ALREADY_ENABLED", 409);
      },
    });
    await openSecurity();
    submit(SECURITY_STRINGS.mfaStart);
    await screen.findByRole("img", { name: SECURITY_STRINGS.mfaQrLabel }, ACTION_WAIT);
    fireEvent.click(screen.getByRole("button", { name: SECURITY_STRINGS.mfaCancel }));
    expect(screen.queryByRole("img", { name: SECURITY_STRINGS.mfaQrLabel })).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOTP_SECRET);

    submit(SECURITY_STRINGS.mfaStart);
    expect(await screen.findByText(SECURITY_STRINGS.mfaAlreadyEnabled, {}, ACTION_WAIT)).toBeTruthy();
    expect(screen.getByRole("link", { name: SECURITY_STRINGS.sessionsReload }).getAttribute("href")).toBe(
      "/account/security",
    );
    expect(calls("POST", "/v1/me/mfa/enable")).toHaveLength(0);
  });

  it("shows a platform admin no way to turn MFA off, and the action reads the API's refusal", async () => {
    routes({ "GET /v1/me": () => json(account({ ...MFA_ON, isPlatformAdmin: true }), 200) });
    await openSecurity();

    expect(screen.queryByRole("button", { name: SECURITY_STRINGS.turnOff })).toBeNull();
    expect(document.querySelector('[data-notice="platform-admin"]')?.textContent).toBe(
      SECURITY_STRINGS.platformAdminKeepsMfa,
    );
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.replaceCodes })).toBeTruthy();

    routes({
      "POST /v1/me/mfa/disable": () => apiError("FORBIDDEN", 403, { details: { reason: "platform_admin" } }),
    });
    expect(await turnOffMfa({ status: "idle" }, new FormData())).toEqual({
      status: "failed",
      code: "FORBIDDEN",
      message: SECURITY_STRINGS.platformAdminKeepsMfa,
    });
  });

  it("answers the step-up, MFA_REQUIRED, malformed answers and ended sessions of the MFA actions", async () => {
    routes({ "POST /v1/me/mfa/recovery-codes": () => apiError("REAUTH_REQUIRED", 401) });
    expect(await replaceRecoveryCodes({ status: "idle" }, new FormData())).toEqual({
      status: "failed",
      code: "REAUTH_REQUIRED",
      message: SECURITY_STRINGS.replaceCancelled,
      stepUp: true,
    });
    routes({ "POST /v1/me/mfa/recovery-codes": () => apiError("MFA_REQUIRED", 403) });
    expect((await replaceRecoveryCodes({ status: "idle" }, new FormData())).message).toBe(
      SECURITY_STRINGS.mfaNotEnabled,
    );
    // An answer that is not the document's never reaches the page.
    routes({ "POST /v1/me/mfa/recovery-codes": () => json({ recoveryCodes: ["not-a-code"] }, 200) });
    expect(await replaceRecoveryCodes({ status: "idle" }, new FormData())).toEqual({
      status: "failed",
      code: "INTERNAL_ERROR",
      message: ERROR_MESSAGES.INTERNAL_ERROR,
    });
    routes({
      "POST /v1/me/mfa/setup": () =>
        json({ secret: TOTP_SECRET, otpauthUrl: "https://evil.example/qr", expiresIn: 600 }, 200),
    });
    expect(await beginMfaSetup({ status: "idle" }, new FormData())).toEqual({
      status: "failed",
      code: "INTERNAL_ERROR",
      message: ERROR_MESSAGES.INTERNAL_ERROR,
    });

    routes({ "POST /v1/me/mfa/enable": () => apiError("UNAUTHENTICATED", 401) });
    await expect(confirmMfaSetup({ status: "idle" }, formData({ code: "123456" }))).rejects.toThrow(
      "NEXT_REDIRECT /sign-in?next=%2Faccount%2Fsecurity",
    );
    routes({ "POST /v1/me/mfa/disable": () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(turnOffMfa({ status: "idle" }, new FormData())).rejects.toThrow(
      "NEXT_REDIRECT /verify-pending",
    );
  });
});

// ---- /account/security: sessions ----------------------------------------------------------------------------------

describe("/account/security sessions", () => {
  it("[PFE-007 AC3] the sessions table marks the current session, and revoking another removes it [PF-06 AC1]", async () => {
    routes({ [`DELETE /v1/me/sessions/${OTHER_SESSION.familyId}`]: () => empty() });
    await openSecurity();

    const current = rowOf("Safari on macOS");
    const other = rowOf("Firefox on Windows");
    const admin = rowOf("Chrome on Linux");
    // This browser is marked and has no "Revoke"; the others have one each.
    expect(current?.querySelector('[data-current="true"]')?.textContent).toBe(SECURITY_STRINGS.thisBrowser);
    expect(current?.querySelector("button")).toBeNull();
    expect(other?.querySelector('[data-current="true"]')).toBeNull();
    expect(within(other as HTMLElement).getByRole("button").textContent).toContain(SECURITY_STRINGS.revoke);
    expect(within(admin as HTMLElement).getByRole("button")).toBeTruthy();
    // Device, where it signs in to, IP address and the times.
    expect(other?.textContent).toContain("2001:db8::7");
    expect(other?.textContent).toContain(SECURITY_STRINGS.notUsedYet);
    expect(admin?.textContent).toContain(SECURITY_STRINGS.audiences.platform_admin);
    expect(admin?.textContent).toContain(SECURITY_STRINGS.unknownIp);
    expect(current?.textContent).toContain(SECURITY_STRINGS.audiences.portal);
    expect(current?.querySelectorAll("time")).toHaveLength(2);
    expect(current?.querySelector("time")?.getAttribute("dateTime")).toBe(THIS_SESSION.createdAt);

    await confirmWith(
      `${SECURITY_STRINGS.revoke}${SECURITY_STRINGS.revokeWhich("Firefox on Windows")}`,
      SECURITY_STRINGS.revokeConfirm,
    );

    expect(await screen.findByText(SECURITY_STRINGS.revoked, {}, ACTION_WAIT)).toBeTruthy();
    expect(rowOf("Firefox on Windows")).toBeNull();
    expect(rowOf("Safari on macOS")).not.toBeNull();
    expect(rowOf("Chrome on Linux")).not.toBeNull();
    const [revoke, ...more] = calls("DELETE", `/v1/me/sessions/${OTHER_SESSION.familyId}`);
    expect(more).toHaveLength(0);
    expectSessionHeaders(revoke);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/account/security");
    // This browser's session stays.
    expect(jar.get(ACCESS_TOKEN_COOKIE)).toBe(ACCESS_TOKEN);
  });

  it("drops a session that had already ended, keeps a row a refusal did not revoke, and revokes nothing unconfirmed", async () => {
    routes({
      [`DELETE /v1/me/sessions/${OTHER_SESSION.familyId}`]: () => apiError("NOT_FOUND", 404),
      [`DELETE /v1/me/sessions/${ADMIN_SESSION.familyId}`]: () => apiError("RATE_LIMITED", 429),
    });
    await openSecurity();

    fireEvent.click(
      screen.getByRole("button", {
        name: `${SECURITY_STRINGS.revoke}${SECURITY_STRINGS.revokeWhich("Chrome on Linux")}`,
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog", {}, ACTION_WAIT)).getByRole("button", { name: "Cancel" }),
    );
    expect(sent.filter((call) => call.method === "DELETE")).toHaveLength(0);

    await confirmWith(
      `${SECURITY_STRINGS.revoke}${SECURITY_STRINGS.revokeWhich("Firefox on Windows")}`,
      SECURITY_STRINGS.revokeConfirm,
    );
    expect(await screen.findByText(SECURITY_STRINGS.alreadyEnded, {}, ACTION_WAIT)).toBeTruthy();
    expect(rowOf("Firefox on Windows")).toBeNull();

    await confirmWith(
      `${SECURITY_STRINGS.revoke}${SECURITY_STRINGS.revokeWhich("Chrome on Linux")}`,
      SECURITY_STRINGS.revokeConfirm,
    );
    expect(await screen.findByText(SECURITY_STRINGS.rateLimited, {}, ACTION_WAIT)).toBeTruthy();
    expect(rowOf("Chrome on Linux")).not.toBeNull();
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("signs out everywhere: one call, the session cookies deleted, then sign-in [PF-06 AC2]", async () => {
    jar.set(NEXT_PATH_COOKIE, "/dashboard");
    routes({ "POST /v1/auth/sign-out-everywhere": () => empty() });
    await openSecurity();

    await confirmWith(SECURITY_STRINGS.signOutEverywhere, SECURITY_STRINGS.signOutEverywhereConfirm);

    expect(await redirectedTo()).toBe("/sign-in?signedOut=1");
    const [call, ...more] = calls("POST", "/v1/auth/sign-out-everywhere");
    expect(more).toHaveLength(0);
    expectSessionHeaders(call);
    expect(deletedCookies()).toEqual([ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, NEXT_PATH_COOKIE]);
    expect(jar.size).toBe(0);
    for (const [, , options] of cookieSet.mock.calls) {
      expect(options).toMatchObject({ httpOnly: true, secure: true, path: "/", maxAge: 0 });
    }
    expect(deletedCookies()).not.toContain(MFA_CHALLENGE_COOKIE);
  });

  it("keeps the session when signing out everywhere is refused, and ends a dead one at sign-in", async () => {
    routes({ "POST /v1/auth/sign-out-everywhere": () => apiError("SERVICE_UNAVAILABLE", 503) });
    expect(await signOutEverywhere({ status: "idle" }, new FormData())).toEqual({
      status: "failed",
      code: "SERVICE_UNAVAILABLE",
      message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
    });
    expect(deletedCookies()).toEqual([]);

    routes({ "POST /v1/auth/sign-out-everywhere": () => apiError("UNAUTHENTICATED", 401) });
    await expect(signOutEverywhere({ status: "idle" }, new FormData())).rejects.toThrow(
      "NEXT_REDIRECT /sign-in?next=%2Faccount%2Fsecurity",
    );
    // A forged family id makes no call.
    fetchMock.mockClear();
    expect(await revokeAccountSession({ status: "idle" }, formData({ familyId: "../me" }))).toMatchObject({
      status: "failed",
      message: SECURITY_STRINGS.formExpired,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the device of a user agent", () => {
    expect(deviceOf(THIS_SESSION.userAgent)).toBe("Safari on macOS");
    expect(deviceOf(OTHER_SESSION.userAgent)).toBe("Firefox on Windows");
    expect(deviceOf(ADMIN_SESSION.userAgent)).toBe("Chrome on Linux");
    expect(
      deviceOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      ),
    ).toBe("Edge on Windows");
    expect(
      deviceOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(
      deviceOf(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
    expect(deviceOf("curl/8.9.1")).toBe(SECURITY_STRINGS.unknownDevice);
    expect(deviceOf(null)).toBe(SECURITY_STRINGS.unknownDevice);
  });
});

// ---- /account/security: password and the page ---------------------------------------------------------------------

describe("/account/security password and page", () => {
  it("changes the password, says the other sessions were signed out, and empties the fields", async () => {
    routes({ "POST /v1/me/password": () => empty() });
    await openSecurity();

    type(SECURITY_STRINGS.currentPasswordLabel, CURRENT_PASSWORD);
    type(SECURITY_STRINGS.newPasswordLabel, NEW_PASSWORD);
    submit(SECURITY_STRINGS.passwordSubmit);

    expect(await screen.findByText(SECURITY_STRINGS.passwordChanged, {}, ACTION_WAIT)).toBeTruthy();
    const [change, ...more] = calls("POST", "/v1/me/password");
    expect(more).toHaveLength(0);
    expect(change?.body).toEqual({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD });
    expectSessionHeaders(change);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/account/security");
    await waitFor(() => expect(valueOf(SECURITY_STRINGS.currentPasswordLabel)).toBe(""), ACTION_WAIT);
    expect(valueOf(SECURITY_STRINGS.newPasswordLabel)).toBe("");
    expect(document.body.innerHTML).not.toContain(NEW_PASSWORD);
    expect(document.body.innerHTML).not.toContain(CURRENT_PASSWORD);
  });

  it("puts a wrong current password and a weak new one at their fields, and checks the form before any call", async () => {
    let changes = 0;
    routes({
      "POST /v1/me/password": () => {
        changes += 1;
        return changes === 1
          ? apiError("CURRENT_PASSWORD_INCORRECT", 422)
          : apiError("PASSWORD_TOO_WEAK", 422, { fieldErrors: [{ path: "/newPassword", code: "breached" }] });
      },
    });
    await openSecurity();

    type(SECURITY_STRINGS.newPasswordLabel, "short");
    submit(SECURITY_STRINGS.passwordSubmit);
    await waitFor(
      () =>
        expect(descriptionsOf(screen.getByLabelText(SECURITY_STRINGS.newPasswordLabel))).toContain(
          SIGN_UP_STRINGS.passwordTooShort,
        ),
      ACTION_WAIT,
    );
    expect(descriptionsOf(screen.getByLabelText(SECURITY_STRINGS.currentPasswordLabel))).toEqual([
      SECURITY_STRINGS.currentPasswordRequired,
    ]);
    expect(changes).toBe(0);

    type(SECURITY_STRINGS.currentPasswordLabel, CURRENT_PASSWORD);
    type(SECURITY_STRINGS.newPasswordLabel, NEW_PASSWORD);
    submit(SECURITY_STRINGS.passwordSubmit);
    await waitFor(
      () =>
        expect(descriptionsOf(screen.getByLabelText(SECURITY_STRINGS.currentPasswordLabel))).toEqual([
          SECURITY_STRINGS.currentPasswordIncorrect,
        ]),
      ACTION_WAIT,
    );
    // A refused change keeps no password in the form.
    expect(valueOf(SECURITY_STRINGS.currentPasswordLabel)).toBe("");

    type(SECURITY_STRINGS.currentPasswordLabel, CURRENT_PASSWORD);
    type(SECURITY_STRINGS.newPasswordLabel, NEW_PASSWORD);
    submit(SECURITY_STRINGS.passwordSubmit);
    await waitFor(
      () =>
        expect(descriptionsOf(screen.getByLabelText(SECURITY_STRINGS.newPasswordLabel))).toContain(
          SIGN_UP_STRINGS.passwordBreached,
        ),
      ACTION_WAIT,
    );
    expect(changes).toBe(2);
    expect(document.body.textContent).not.toContain("The API's own text");

    routes({ "POST /v1/me/password": () => apiError("EMAIL_NOT_VERIFIED", 403) });
    await expect(
      changeAccountPassword(
        { status: "idle", fieldErrors: {} },
        formData({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT /verify-pending");
  });

  it("reads the account and the sessions once each, with one h1 and the sections in order", async () => {
    await openSecurity();

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      SECURITY_STRINGS.title,
    ]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      SECURITY_STRINGS.passwordTitle,
      SECURITY_STRINGS.mfaTitle,
      SECURITY_STRINGS.sessionsTitle,
    ]);
    for (const path of ["/v1/me", "/v1/me/sessions"]) {
      const [call, ...more] = calls("GET", path);
      expect(more).toHaveLength(0);
      expectSessionHeaders(call);
    }
    expect(sent).toHaveLength(2);
  });

  it("sends an ended session to sign-in and back, and keeps the other sections when a list fails", async () => {
    routes({ "GET /v1/me/sessions": () => apiError("UNAUTHENTICATED", 401) });
    await expect(SecurityPage()).rejects.toThrow("NEXT_REDIRECT /sign-in?next=%2Faccount%2Fsecurity");
    routes({ "GET /v1/me": () => apiError("TOKEN_EXPIRED", 401) });
    await expect(SecurityPage()).rejects.toThrow("NEXT_REDIRECT /sign-in?next=%2Faccount%2Fsecurity");

    routes({ "GET /v1/me/sessions": () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openSecurity();
    expect(screen.getByText(SECURITY_STRINGS.sessionsUnavailableTitle)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.signOutEverywhere })).toBeTruthy();
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.mfaStart })).toBeTruthy();
    cleanup();

    routes({ "GET /v1/me": () => apiError("RATE_LIMITED", 429) });
    await openSecurity();
    expect(screen.getByText(SECURITY_STRINGS.mfaUnavailableTitle)).toBeTruthy();
    expect(screen.queryByRole("button", { name: SECURITY_STRINGS.mfaStart })).toBeNull();
    expect(screen.getByRole("table", { name: SECURITY_STRINGS.sessionsCaption })).toBeTruthy();
    expect(screen.getByRole("button", { name: SECURITY_STRINGS.passwordSubmit })).toBeTruthy();
  });

  describe("rendered on the server", () => {
    let rendered: Awaited<ReturnType<typeof serverRenderAndHydrate>> | undefined;

    beforeEach(async () => {
      routes({ "GET /v1/me": () => json(account(MFA_ON), 200) });
      rendered = await serverRenderAndHydrate(await SecurityPage());
    }, WARM_UP_TIMEOUT_MS);

    afterEach(() => {
      const root = rendered?.root;
      if (root !== undefined) {
        act(() => root.unmount());
      }
      rendered = undefined;
    });

    it("hydrates in the browser without an error or a change", () => {
      expect(rendered?.errors).toEqual([]);
      expect(rendered?.container.innerHTML).toBe(rendered?.serverDom);
      expect(rendered?.serverDom).toContain(SECURITY_STRINGS.replaceCodes);
    });
  });
});
