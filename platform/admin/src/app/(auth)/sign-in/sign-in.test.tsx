// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the configuration; the real API client talks to a mocked fetch ----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sign-in",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
}));

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PLATFORM_ADMIN_URL: "https://admin.platform.example.com",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import { signIn, type SignInState } from "@/app/(auth)/sign-in/actions";
import { verifyMfa, type MfaState } from "@/app/(auth)/sign-in/mfa/actions";
import { MfaForm } from "@/app/(auth)/sign-in/mfa/mfa-form";
import MfaPage from "@/app/(auth)/sign-in/mfa/page";
import SignInPage from "@/app/(auth)/sign-in/page";
import { SignInForm } from "@/app/(auth)/sign-in/sign-in-form";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE, MFA_CHALLENGE_COOKIE, REFRESH_TOKEN_COOKIE } from "@/lib/session";
import { ERROR_MESSAGES, MFA_STRINGS, SIGN_IN_STRINGS } from "@/lib/strings";

// ---- Builders (dummy values only: no real password, token or code) ----------------------------------------------

const EMAIL = "lena.holm@example.com";
const PASSWORD = "Harbour-Lantern-2026";
const MFA_CHALLENGE = "Ma3kT8wQ1zR6xL4nB9hY2dF7sG5jA0eU3iO8mK1cP4v";
const RECOVERY_CODE = "W4KD-9PMX-2TQR-H7ZB";
/** The browser sent a forged left-most entry; Caddy appended the real address. */
const FORWARDED_FOR = "6.6.6.6, 203.0.113.7";
const END_USER_IP = "203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-002 test)";

const IDLE_SIGN_IN: SignInState = { status: "idle", fieldErrors: {}, values: { email: "" } };
const IDLE_MFA: MfaState = { status: "idle", method: "totp" };
/** Return paths whose dot segments the URL parser turns into the protocol-relative `//evil.example` (FIX-W26-SECURITY). */
const DOT_SEGMENT_REDIRECTS = [
  "/.//evil.example",
  "/a/..//evil.example",
  "/%2e//evil.example",
  "/%2E%2E//evil.example",
] as const;

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
  options: { headers?: Record<string, string>; fieldErrors?: { path: string; code: string }[] } = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pad002",
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
    options.headers,
  );
}

/** `AdminMfaChallenge`: the only answer of a correct admin password. */
function challenge(expiresIn = 300): Response {
  return json({ mfaChallengeToken: MFA_CHALLENGE, expiresIn }, 200);
}

/** `AdminSession`, the answer of adminVerifyMfa. */
function adminSession(): Record<string, unknown> {
  return {
    accessToken: "new-admin-access-token",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "new-admin-refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    admin: {
      id: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
      email: EMAIL,
      fullName: "Lena Holm",
      features: {
        stripeBilling: false,
        ownStripe: false,
        settlements: false,
        ownAmadeus: false,
        customDomains: false,
        liveSwitch: false,
      },
    },
  };
}

/** Answers each call by its path; a call to any other path fails the test. */
function answer(answers: Record<string, () => Response>): void {
  fetchMock.mockImplementation((input) => {
    const { pathname } = new URL(input.url);
    const respond = answers[pathname];
    return respond === undefined
      ? Promise.reject(new Error(`unexpected call ${input.method} ${pathname}`))
      : Promise.resolve(respond());
  });
}

function onlyCall(path: string): Request {
  const calls = fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => new URL(input.url).pathname === path);
  expect(calls).toHaveLength(1);
  return calls[0] as Request;
}

/** The cookie store of `cookies()`: the given cookies, and a record of every write. */
function cookieStore(values: Record<string, string> = {}) {
  const store = {
    get: vi.fn((name: string) => (name in values ? { name, value: values[name] } : undefined)),
    has: vi.fn((name: string) => name in values),
    set: vi.fn(),
  };
  nextHeaders.cookies.mockResolvedValue(store);
  return store;
}

/** The cookie writes of `store` as `[name, value, maxAge]`. */
function writes(store: ReturnType<typeof cookieStore>): [string, string, number][] {
  return store.set.mock.calls.map(([name, value, options]) => [name, value, options.maxAge]);
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

function submit(name: string | RegExp): void {
  const button = screen.getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label, { exact: false }) as HTMLInputElement;
}

function type(label: string, value: string): void {
  fireEvent.change(input(label), { target: { value } });
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: HTMLElement): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

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

/** Renders `element` inside the redirect boundary; React reports the caught redirect on the console. */
function renderWithRedirects(element: ReactNode): void {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(<RedirectBoundary>{element}</RedirectBoundary>);
}

async function redirectedTo(): Promise<string> {
  const status = await screen.findByText(/^Redirected to /);
  return status.textContent?.replace(/^Redirected to /, "") ?? "";
}

type SearchParams = Record<string, string | string[] | undefined>;

async function renderSignInPage(searchParams: SearchParams = {}): Promise<void> {
  render(await SignInPage({ searchParams: Promise.resolve(searchParams) }));
}

async function mfaPage(searchParams: SearchParams = {}): Promise<ReactNode> {
  return MfaPage({ searchParams: Promise.resolve(searchParams) });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  navigation.redirect.mockClear();
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pad002_admin",
    }),
  );
  cookieStore();
});

afterEach(() => {
  // [PAD-002 AC4] every mocked API call of every test, the sign-in calls included, carried the admin's IP from the
  // right-most X-Forwarded-For entry, the user agent and the BFF key, and never a bearer token (public operations).
  for (const [call] of fetchMock.mock.calls) {
    expect(call.headers.get(END_USER_IP_HEADER)).toBe(END_USER_IP);
    expect(call.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
    expect(call.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
    expect(call.headers.has("authorization")).toBe(false);
  }
  cleanup();
});

// ---- The two steps together -------------------------------------------------------------------------------------

describe("an admin sign-in", () => {
  it("[PAD-002 AC1] always goes through the TOTP step: the password step stores only the challenge, the code step the session [PF-80]", async () => {
    // Step 1: e-mail and password, while the browser still holds an older admin session.
    const first = cookieStore({
      [ACCESS_TOKEN_COOKIE]: "an-older-admin-access-token",
      [REFRESH_TOKEN_COOKIE]: "an-older-admin-refresh-token",
    });
    answer({ "/v1/admin/auth/sign-in": () => challenge() });
    renderWithRedirects(<SignInForm next="/tenants?status=suspended" />);
    type(SIGN_IN_STRINGS.emailLabel, EMAIL);
    type(SIGN_IN_STRINGS.passwordLabel, PASSWORD);
    submit(SIGN_IN_STRINGS.submit);

    expect(await redirectedTo()).toBe("/sign-in/mfa?next=%2Ftenants%3Fstatus%3Dsuspended");
    const signInCall = onlyCall("/v1/admin/auth/sign-in");
    expect(await signInCall.json()).toEqual({ email: EMAIL, password: PASSWORD });
    // No session cookie at all after the password: only the challenge, HttpOnly, Secure, SameSite=Strict, 5 minutes.
    expect(writes(first)).toEqual([[MFA_CHALLENGE_COOKIE, MFA_CHALLENGE, 300]]);
    expect(first.set.mock.calls[0]?.[2]).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 300,
    });
    cleanup();

    // Step 2: the code of the authenticator app completes the challenge and creates the session.
    const second = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/admin/auth/mfa/verify": () => json(adminSession(), 200) });
    renderWithRedirects(await mfaPage({ next: "/tenants?status=suspended" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(MFA_STRINGS.title);
    type(MFA_STRINGS.codeLabel, "492 039");
    submit(MFA_STRINGS.submit);

    expect(await redirectedTo()).toBe("/tenants?status=suspended");
    expect(await onlyCall("/v1/admin/auth/mfa/verify").json()).toEqual({
      mfaChallengeToken: MFA_CHALLENGE,
      code: "492039",
    });
    expect(writes(second)).toEqual([
      [ACCESS_TOKEN_COOKIE, "new-admin-access-token", expect.any(Number)],
      [REFRESH_TOKEN_COOKIE, "new-admin-refresh-token", expect.any(Number)],
      [MFA_CHALLENGE_COOKIE, "", 0],
    ]);
    // The access cookie (and the refresh cookie) are SameSite=Strict [PF-80].
    for (const [, , options] of second.set.mock.calls) {
      expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    }
  });

  it("[PAD-002 AC1] never stores a session from the password step, whatever adminSignIn answers", async () => {
    const store = cookieStore();
    // A session-shaped answer without a challenge: the admin never takes it as a session.
    answer({ "/v1/admin/auth/sign-in": () => json(adminSession(), 200) });

    const state = await signIn(IDLE_SIGN_IN, formData({ email: EMAIL, password: PASSWORD }));

    expect(state).toMatchObject({ status: "failed", code: "INTERNAL_ERROR", values: { email: EMAIL } });
    expect(state.message).toBe(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(store.set).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain("new-admin-access-token");
  });

  it("[PAD-002 AC1] without a challenge, the MFA step sends the admin back to sign in, even with a session", async () => {
    cookieStore({
      [ACCESS_TOKEN_COOKIE]: "admin-access-token",
      [REFRESH_TOKEN_COOKIE]: "admin-refresh-token",
    });

    await expect(mfaPage({ next: "/queues" })).rejects.toThrow(
      "NEXT_REDIRECT /sign-in?mfa=expired&next=%2Fqueues",
    );
    await expect(
      verifyMfa(IDLE_MFA, formData({ method: "totp", code: "492039", next: "/queues" })),
    ).rejects.toThrow("NEXT_REDIRECT /sign-in?mfa=expired&next=%2Fqueues");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[PAD-002 AC1] the sign-in page shows the password form also to an admin who has a session", async () => {
    cookieStore({
      [ACCESS_TOKEN_COOKIE]: "admin-access-token",
      [REFRESH_TOKEN_COOKIE]: "admin-refresh-token",
    });

    await renderSignInPage();

    expect(input(SIGN_IN_STRINGS.passwordLabel).getAttribute("type")).toBe("password");
    expect(navigation.redirect).not.toHaveBeenCalled();
  });
});

// ---- /sign-in ---------------------------------------------------------------------------------------------------

describe("/sign-in: SignInForm and the signIn action", () => {
  it("explains MFA_REQUIRED and links to the portal's security page", async () => {
    const store = cookieStore();
    answer({ "/v1/admin/auth/sign-in": () => apiError("MFA_REQUIRED", 403) });
    render(<SignInForm />);
    type(SIGN_IN_STRINGS.emailLabel, EMAIL);
    type(SIGN_IN_STRINGS.passwordLabel, PASSWORD);
    submit(SIGN_IN_STRINGS.submit);

    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("listitem").textContent).toContain(ERROR_MESSAGES.MFA_REQUIRED);
    expect(ERROR_MESSAGES.MFA_REQUIRED).toContain("in the portal");
    const link = within(summary).getByRole("link", { name: SIGN_IN_STRINGS.enableMfa });
    expect(link.getAttribute("href")).toBe("https://platform.example.com/account/security");
    expect(summary.textContent).not.toContain("The API's own text");
    expect(document.activeElement).toBe(summary);
    expect(store.set).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("shows the wait time from Retry-After when the account is locked", async () => {
    answer({
      "/v1/admin/auth/sign-in": () => apiError("ACCOUNT_LOCKED", 423, { headers: { "retry-after": "840" } }),
    });
    render(<SignInForm />);
    type(SIGN_IN_STRINGS.emailLabel, EMAIL);
    type(SIGN_IN_STRINGS.passwordLabel, PASSWORD);
    submit(SIGN_IN_STRINGS.submit);

    const summary = await screen.findByRole("alert");
    // 840 seconds of Retry-After: 14 minutes.
    expect(within(summary).getByRole("listitem").textContent).toBe(SIGN_IN_STRINGS.lockedFor(840));
    expect(summary.textContent).toContain("try again in 14 minutes");
    // The address stays, the password does not; nothing was stored and nobody was redirected.
    expect(input(SIGN_IN_STRINGS.emailLabel).value).toBe(EMAIL);
    expect(input(SIGN_IN_STRINGS.passwordLabel).value).toBe("");
    expect(navigation.redirect).not.toHaveBeenCalled();

    answer({ "/v1/admin/auth/sign-in": () => apiError("ACCOUNT_LOCKED", 423) });
    const unknown = await signIn(IDLE_SIGN_IN, formData({ email: EMAIL, password: PASSWORD }));
    expect(unknown.message).toBe(ERROR_MESSAGES.ACCOUNT_LOCKED);
  });

  it("shows INVALID_CREDENTIALS in the admin's words, the same for a non-admin account", async () => {
    answer({ "/v1/admin/auth/sign-in": () => apiError("INVALID_CREDENTIALS", 401) });
    render(<SignInForm />);
    type(SIGN_IN_STRINGS.emailLabel, EMAIL);
    type(SIGN_IN_STRINGS.passwordLabel, "Wrong-password-123");
    submit(SIGN_IN_STRINGS.submit);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(ERROR_MESSAGES.INVALID_CREDENTIALS),
    );
    expect(screen.getByRole("alert").textContent).not.toContain("The API's own text");
    expect(input(SIGN_IN_STRINGS.passwordLabel).value).toBe("");
  });

  it("calls adminSignIn as a public operation: no bearer token even with a session, the end-user headers of PADR-0019", async () => {
    cookieStore({ [ACCESS_TOKEN_COOKIE]: "an-older-access-token" });
    answer({ "/v1/admin/auth/sign-in": () => apiError("INVALID_CREDENTIALS", 401) });

    await signIn(IDLE_SIGN_IN, formData({ email: ` ${EMAIL} `, password: PASSWORD }));

    const call = onlyCall("/v1/admin/auth/sign-in");
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://127.0.0.1:3100/v1/admin/auth/sign-in");
    expect(await call.json()).toEqual({ email: EMAIL, password: PASSWORD });
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get(END_USER_IP_HEADER)).toBe(END_USER_IP);
    expect(call.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
    expect(call.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
    expect(call.headers.get("x-request-id")).toBe("req_pad002_admin");
  });

  it("asks for the address and the password before calling the API", async () => {
    render(<SignInForm />);
    type(SIGN_IN_STRINGS.emailLabel, "lena");
    submit(SIGN_IN_STRINGS.submit);

    await waitFor(() =>
      expect(descriptionsOf(input(SIGN_IN_STRINGS.emailLabel))).toContain(SIGN_IN_STRINGS.emailInvalid),
    );
    expect(descriptionsOf(input(SIGN_IN_STRINGS.passwordLabel))).toContain(SIGN_IN_STRINGS.passwordRequired);
    expect(input(SIGN_IN_STRINGS.passwordLabel).getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the API's field errors at their fields", async () => {
    answer({
      "/v1/admin/auth/sign-in": () =>
        apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/email", code: "format" }] }),
    });

    const state = await signIn(IDLE_SIGN_IN, formData({ email: EMAIL, password: PASSWORD }));

    expect(state.fieldErrors).toEqual({ email: SIGN_IN_STRINGS.emailInvalid });
    expect(state.message).toBeUndefined();
  });

  it("shows the per-network rate limit and an unreachable API without the API's text or the password", async () => {
    answer({
      "/v1/admin/auth/sign-in": () => apiError("RATE_LIMITED", 429, { headers: { "retry-after": "60" } }),
    });
    const limited = await signIn(IDLE_SIGN_IN, formData({ email: EMAIL, password: PASSWORD }));
    expect(limited.message).toBe(SIGN_IN_STRINGS.rateLimited);

    fetchMock.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3100"));
    const unreachable = await signIn(limited, formData({ email: EMAIL, password: PASSWORD }));
    expect(unreachable).toMatchObject({ code: "SERVICE_UNAVAILABLE", values: { email: EMAIL } });
    expect(unreachable.message).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(JSON.stringify(unreachable)).not.toContain(PASSWORD);
  });

  it("drops a next value that leaves the admin, and keeps the challenge's own lifetime when shorter", async () => {
    for (const next of ["https://evil.example/x", "//evil.example", "/\\evil.example"]) {
      const store = cookieStore();
      answer({ "/v1/admin/auth/sign-in": () => challenge(120) });
      await expect(
        signIn(IDLE_SIGN_IN, formData({ email: EMAIL, password: PASSWORD, next })),
      ).rejects.toThrow(/^NEXT_REDIRECT \/sign-in\/mfa$/);
      expect(writes(store)).toEqual([[MFA_CHALLENGE_COOKIE, MFA_CHALLENGE, 120]]);
    }
  });
});

describe("/sign-in page", () => {
  it("renders one h1, the form, and the portal's password reset link", async () => {
    await renderSignInPage();

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      SIGN_IN_STRINGS.title,
    ]);
    expect(screen.getByRole("main").id).toBe("main-content");
    expect(screen.getByRole("link", { name: SIGN_IN_STRINGS.forgotPassword }).getAttribute("href")).toBe(
      "https://platform.example.com/forgot-password",
    );
    expect(input(SIGN_IN_STRINGS.emailLabel).getAttribute("autocomplete")).toBe("username");
    expect(input(SIGN_IN_STRINGS.passwordLabel).getAttribute("autocomplete")).toBe("current-password");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("carries only a relative next path into the form", async () => {
    await renderSignInPage({ next: "/tenants/ten_1?tab=audit" });
    expect(document.querySelector<HTMLInputElement>('input[name="next"]')?.value).toBe(
      "/tenants/ten_1?tab=audit",
    );
    cleanup();

    for (const next of ["https://evil.example/x", "//evil.example", ["/a", "/b"]]) {
      await renderSignInPage({ next });
      expect(document.querySelector('input[name="next"]')).toBeNull();
      cleanup();
    }
  });

  it("[FIX-W26-SECURITY AC2] carries no next into the form when its dot segments normalise to //evil.example", async () => {
    for (const next of DOT_SEGMENT_REDIRECTS) {
      await renderSignInPage({ next });
      expect(document.querySelector('input[name="next"]'), next).toBeNull();
      cleanup();
    }
  });

  it("shows the notice of where the admin came from, and nothing for unknown values", async () => {
    await renderSignInPage({ signedOut: "1" });
    expect(screen.getByRole("status").textContent).toBe(SIGN_IN_STRINGS.signedOut);
    cleanup();

    await renderSignInPage({ mfa: "expired" });
    expect(screen.getByRole("alert").textContent).toBe(ERROR_MESSAGES.MFA_CHALLENGE_INVALID);
    cleanup();

    await renderSignInPage({ signedOut: "<script>", mfa: "no" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ---- /sign-in/mfa -----------------------------------------------------------------------------------------------

describe("/sign-in/mfa: MfaForm and the verifyMfa action", () => {
  it("accepts a recovery code: sends it with the challenge, stores the session and clears the challenge", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/admin/auth/mfa/verify": () => json(adminSession(), 200) });
    renderWithRedirects(await mfaPage());

    expect(input(MFA_STRINGS.codeLabel)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: MFA_STRINGS.useRecoveryCode }));
    // The recovery code field replaces the code field and takes the focus.
    const recovery = input(MFA_STRINGS.recoveryLabel);
    await waitFor(() => expect(document.activeElement).toBe(recovery));
    expect(screen.queryByLabelText(MFA_STRINGS.codeLabel, { exact: false })).toBeNull();
    expect(screen.getByText(MFA_STRINGS.recoveryIntro)).toBeTruthy();
    type(MFA_STRINGS.recoveryLabel, ` ${RECOVERY_CODE.toLowerCase()} `);
    submit(MFA_STRINGS.submit);

    // Without a return path the admin lands on the dashboard.
    expect(await redirectedTo()).toBe("/");
    const call = onlyCall("/v1/admin/auth/mfa/verify");
    expect(await call.json()).toEqual({
      mfaChallengeToken: MFA_CHALLENGE,
      recoveryCode: RECOVERY_CODE.toLowerCase(),
    });
    expect(writes(store)).toEqual([
      [ACCESS_TOKEN_COOKIE, "new-admin-access-token", expect.any(Number)],
      [REFRESH_TOKEN_COOKIE, "new-admin-refresh-token", expect.any(Number)],
      [MFA_CHALLENGE_COOKIE, "", 0],
    ]);
  });

  it("shows a refused recovery code at its field and keeps the challenge; a malformed one never reaches the API", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/admin/auth/mfa/verify": () => apiError("MFA_CODE_INVALID", 401) });
    render(await mfaPage());
    fireEvent.click(screen.getByRole("button", { name: MFA_STRINGS.useRecoveryCode }));
    type(MFA_STRINGS.recoveryLabel, RECOVERY_CODE);
    submit(MFA_STRINGS.submit);

    await waitFor(() =>
      expect(descriptionsOf(input(MFA_STRINGS.recoveryLabel))).toContain(MFA_STRINGS.recoveryInvalid),
    );
    expect(store.set).not.toHaveBeenCalled();

    fetchMock.mockClear();
    type(MFA_STRINGS.recoveryLabel, "not-a-code");
    submit(MFA_STRINGS.submit);
    await waitFor(() =>
      expect(descriptionsOf(input(MFA_STRINGS.recoveryLabel))).toContain(MFA_STRINGS.recoveryFormat),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a wrong TOTP code at the field, and a malformed one without calling the API", async () => {
    cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/admin/auth/mfa/verify": () => apiError("MFA_CODE_INVALID", 401) });
    render(<MfaForm />);
    type(MFA_STRINGS.codeLabel, "123456");
    submit(MFA_STRINGS.submit);
    await waitFor(() =>
      expect(descriptionsOf(input(MFA_STRINGS.codeLabel))).toContain(ERROR_MESSAGES.MFA_CODE_INVALID),
    );
    expect(document.activeElement).toBe(screen.getByRole("alert"));

    fetchMock.mockClear();
    type(MFA_STRINGS.codeLabel, "12345");
    submit(MFA_STRINGS.submit);
    await waitFor(() =>
      expect(descriptionsOf(input(MFA_STRINGS.codeLabel))).toContain(MFA_STRINGS.codeFormat),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an expired or used-up challenge back to sign-in with its return path, deleting the challenge", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/admin/auth/mfa/verify": () => apiError("MFA_CHALLENGE_INVALID", 401) });

    await expect(
      verifyMfa(IDLE_MFA, formData({ method: "totp", code: "492039", next: "/tenants/ten_1" })),
    ).rejects.toThrow("NEXT_REDIRECT /sign-in?mfa=expired&next=%2Ftenants%2Ften_1");
    expect(writes(store)).toEqual([[MFA_CHALLENGE_COOKIE, "", 0]]);
  });

  it("shows the wait of Retry-After when too many codes were tried, and keeps the challenge", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({
      "/v1/admin/auth/mfa/verify": () => apiError("RATE_LIMITED", 429, { headers: { "retry-after": "420" } }),
    });

    const state = await verifyMfa(IDLE_MFA, formData({ method: "totp", code: "492039" }));

    expect(state).toEqual({
      status: "failed",
      code: "RATE_LIMITED",
      method: "totp",
      message: MFA_STRINGS.rateLimitedFor(420),
    });
    expect(state.message).toContain("Try again in 7 minutes.");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("drops a next value that leaves the admin after the code step", async () => {
    for (const next of ["https://evil.example/x", "//evil.example"]) {
      cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
      answer({ "/v1/admin/auth/mfa/verify": () => json(adminSession(), 200) });

      await expect(verifyMfa(IDLE_MFA, formData({ method: "totp", code: "492039", next }))).rejects.toThrow(
        /^NEXT_REDIRECT \/$/,
      );
    }
  });

  it("[FIX-W26-SECURITY AC2] stays on the admin through both steps for a next whose dot segments normalise to //evil.example", async () => {
    for (const next of DOT_SEGMENT_REDIRECTS) {
      // The password step carries no return path to the code step ...
      const store = cookieStore();
      answer({ "/v1/admin/auth/sign-in": () => challenge() });
      await expect(
        signIn(IDLE_SIGN_IN, formData({ email: EMAIL, password: PASSWORD, next })),
      ).rejects.toThrow(/^NEXT_REDIRECT \/sign-in\/mfa$/);
      expect(writes(store), next).toEqual([[MFA_CHALLENGE_COOKIE, MFA_CHALLENGE, 300]]);

      // ... the code step's page puts none into its form ...
      cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
      render(await mfaPage({ next }));
      expect(document.querySelector('input[name="next"]'), next).toBeNull();
      cleanup();

      // ... and the code step itself ends on the dashboard, also for a value posted in the hidden field.
      answer({ "/v1/admin/auth/mfa/verify": () => json(adminSession(), 200) });
      await expect(verifyMfa(IDLE_MFA, formData({ method: "totp", code: "492039", next }))).rejects.toThrow(
        /^NEXT_REDIRECT \/$/,
      );
    }
  });

  it("never stores an answer of adminVerifyMfa that is not a session", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/admin/auth/mfa/verify": () => json({ admin: {} }, 200) });

    const state = await verifyMfa(IDLE_MFA, formData({ method: "totp", code: "492039" }));

    expect(state).toMatchObject({ status: "failed", code: "INTERNAL_ERROR" });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("carries only a relative next path into the form of the MFA page", async () => {
    cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    render(await mfaPage({ next: "/queues/vx-provisioning" }));
    expect(document.querySelector<HTMLInputElement>('input[name="next"]')?.value).toBe(
      "/queues/vx-provisioning",
    );
    cleanup();

    render(await mfaPage({ next: "https://evil.example/x" }));
    expect(document.querySelector('input[name="next"]')).toBeNull();
  });
});
