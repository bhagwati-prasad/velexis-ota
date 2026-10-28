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
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import { requestPasswordReset } from "@/app/(auth)/forgot-password/actions";
import { ForgotPasswordForm } from "@/app/(auth)/forgot-password/forgot-password-form";
import ForgotPasswordPage from "@/app/(auth)/forgot-password/page";
import { confirmPasswordReset } from "@/app/(auth)/reset-password/actions";
import ResetPasswordPage from "@/app/(auth)/reset-password/page";
import { signIn } from "@/app/(auth)/sign-in/actions";
import { verifyMfa } from "@/app/(auth)/sign-in/mfa/actions";
import MfaPage from "@/app/(auth)/sign-in/mfa/page";
import SignInPage from "@/app/(auth)/sign-in/page";
import { SignInForm } from "@/app/(auth)/sign-in/sign-in-form";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import {
  ACCESS_TOKEN_COOKIE,
  MFA_CHALLENGE_COOKIE,
  NEXT_PATH_COOKIE,
  PASSWORD_RESET_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from "@/lib/session";
import {
  ERROR_MESSAGES,
  MFA_STRINGS,
  PASSWORD_RESET_STRINGS,
  SIGN_IN_STRINGS,
  SIGN_UP_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real password, token or code) ----------------------------------------------

const EMAIL = "anna.berg@example.com";
const PASSWORD = "Northern-Lights-2026";
const MFA_CHALLENGE = "Mc8vR2kP5wQ9zT3xL7nB4hY1dF6sG0jA8eU2iO5mK3c";
const RECOVERY_CODE = "7KQ4-M2XP-9TRW-H5ZD";
const RESET_TOKEN = "pr_Pr2xL9qW5mT8vK3cN7bZ4hY1dF6sJ0aG2eU8iO5rQ1k";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-006 test)";
/**
 * How long a test waits for the focus that the error summary takes after a server action answered: React commits the
 * answer, then runs the summary's focus effect, outside the test's own act(). Testing Library's 1 s default is enough
 * on an idle machine, not on a loaded CI runner (the same check of the sign-up form ran out once). The test's own 5 s
 * budget is unchanged.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;
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
        requestId: "req_api_pfe006",
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

/** An empty `202` or `204`, as the API sends it (Express writes `Content-Length: 0`). */
function empty(status: 202 | 204): Response {
  return new Response(null, { status, headers: { "content-length": "0" } });
}

function portalSession(emailVerified = true): Record<string, unknown> {
  return {
    accessToken: "new-access-token",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "new-refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
    account: { id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X", email: EMAIL, emailVerified },
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
      "x-request-id": "req_pfe006_portal",
    }),
  );
  cookieStore();
});

afterEach(() => {
  cleanup();
});

// ---- /sign-in ---------------------------------------------------------------------------------------------------

describe("/sign-in: SignInForm and the signIn action", () => {
  it("[PFE-006 AC1] shows the wait time from Retry-After when the account is locked [PF-03 AC2]", async () => {
    answer({
      "/v1/auth/sign-in": () => apiError("ACCOUNT_LOCKED", 423, { headers: { "retry-after": "840" } }),
    });
    render(<SignInForm />);
    type(SIGN_IN_STRINGS.emailLabel, EMAIL);
    type(SIGN_IN_STRINGS.passwordLabel, PASSWORD);
    submit(SIGN_IN_STRINGS.submit);

    const summary = await screen.findByRole("alert", {}, ACTION_WAIT);
    // 840 seconds of Retry-After: 14 minutes.
    expect(within(summary).getByRole("listitem").textContent).toBe(SIGN_IN_STRINGS.lockedFor(840));
    expect(summary.textContent).toContain("try again in 14 minutes");
    expect(summary.textContent).not.toContain("The API's own text");
    // The summary takes the focus in an effect, which may run after the render the wait above saw.
    await waitFor(() => expect(document.activeElement).toBe(summary), ACTION_WAIT);
    // The address stays, the password does not; nothing was stored and nobody was redirected.
    expect(input(SIGN_IN_STRINGS.emailLabel).value).toBe(EMAIL);
    expect(input(SIGN_IN_STRINGS.passwordLabel).value).toBe("");
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("[PFE-006 AC1] counts a short lock in seconds and falls back to the general message without Retry-After", async () => {
    answer({
      "/v1/auth/sign-in": () => apiError("ACCOUNT_LOCKED", 423, { headers: { "retry-after": "45" } }),
    });
    const short = await signIn(
      { status: "idle", fieldErrors: {}, values: { email: "" } },
      formData({ email: EMAIL, password: PASSWORD }),
    );
    expect(short).toMatchObject({ status: "failed", code: "ACCOUNT_LOCKED" });
    expect(short.message).toBe(SIGN_IN_STRINGS.lockedFor(45));
    expect(short.message).toContain("try again in 45 seconds");

    answer({
      "/v1/auth/sign-in": () => apiError("ACCOUNT_LOCKED", 423, { headers: { "retry-after": "60" } }),
    });
    const minute = await signIn(short, formData({ email: EMAIL, password: PASSWORD }));
    expect(minute.message).toContain("try again in 1 minute,");

    answer({ "/v1/auth/sign-in": () => apiError("ACCOUNT_LOCKED", 423) });
    const unknown = await signIn(short, formData({ email: EMAIL, password: PASSWORD }));
    expect(unknown.message).toBe(ERROR_MESSAGES.ACCOUNT_LOCKED);
  });

  it("shows INVALID_CREDENTIALS and ACCOUNT_DISABLED in the portal's words [PF-03 AC2]", async () => {
    answer({ "/v1/auth/sign-in": () => apiError("INVALID_CREDENTIALS", 401) });
    render(<SignInForm />);
    type(SIGN_IN_STRINGS.emailLabel, EMAIL);
    type(SIGN_IN_STRINGS.passwordLabel, "Wrong-password-123");
    submit(SIGN_IN_STRINGS.submit);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(ERROR_MESSAGES.INVALID_CREDENTIALS),
    );
    expect(input(SIGN_IN_STRINGS.passwordLabel).value).toBe("");

    answer({ "/v1/auth/sign-in": () => apiError("ACCOUNT_DISABLED", 403) });
    type(SIGN_IN_STRINGS.passwordLabel, PASSWORD);
    submit(SIGN_IN_STRINGS.submit);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(ERROR_MESSAGES.ACCOUNT_DISABLED),
    );
    expect(screen.getByRole("alert").textContent).not.toContain("The API's own text");
  });

  it("calls signIn as a public operation: no bearer token, the end-user headers of PADR-0019", async () => {
    cookieStore({ [ACCESS_TOKEN_COOKIE]: "an-older-access-token" });
    answer({ "/v1/auth/sign-in": () => apiError("INVALID_CREDENTIALS", 401) });

    await signIn(
      { status: "idle", fieldErrors: {}, values: { email: "" } },
      formData({ email: ` ${EMAIL} `, password: PASSWORD }),
    );

    const call = onlyCall("/v1/auth/sign-in");
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://127.0.0.1:3100/v1/auth/sign-in");
    expect(await call.json()).toEqual({ email: EMAIL, password: PASSWORD });
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
    expect(call.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
    expect(call.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
  });

  it("asks for the address and the password before calling the API", async () => {
    render(<SignInForm />);
    type(SIGN_IN_STRINGS.emailLabel, "anna");
    submit(SIGN_IN_STRINGS.submit);

    await waitFor(() =>
      expect(descriptionsOf(input(SIGN_IN_STRINGS.emailLabel))).toContain(SIGN_IN_STRINGS.emailInvalid),
    );
    expect(descriptionsOf(input(SIGN_IN_STRINGS.passwordLabel))).toContain(SIGN_IN_STRINGS.passwordRequired);
    expect(input(SIGN_IN_STRINGS.passwordLabel).getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the per-network rate limit and other failures without the API's text", async () => {
    answer({ "/v1/auth/sign-in": () => apiError("RATE_LIMITED", 429, { headers: { "retry-after": "60" } }) });
    const limited = await signIn(
      { status: "idle", fieldErrors: {}, values: { email: "" } },
      formData({ email: EMAIL, password: PASSWORD }),
    );
    expect(limited.message).toBe(SIGN_IN_STRINGS.rateLimited);

    fetchMock.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3100"));
    const unreachable = await signIn(limited, formData({ email: EMAIL, password: PASSWORD }));
    expect(unreachable).toMatchObject({ code: "SERVICE_UNAVAILABLE", values: { email: EMAIL } });
    expect(unreachable.message).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(JSON.stringify(unreachable)).not.toContain(PASSWORD);
  });

  it("stores the session in httpOnly cookies and continues to the validated next path [PF-03 AC1]", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: "an-abandoned-challenge" });
    answer({ "/v1/auth/sign-in": () => json(portalSession(), 200) });
    renderWithRedirects(<SignInForm next="/otas/ten_1/team?tab=invitations" />);
    type(SIGN_IN_STRINGS.emailLabel, EMAIL);
    type(SIGN_IN_STRINGS.passwordLabel, PASSWORD);
    submit(SIGN_IN_STRINGS.submit);

    expect(await redirectedTo()).toBe("/otas/ten_1/team?tab=invitations");
    expect(writes(store)).toEqual([
      [ACCESS_TOKEN_COOKIE, "new-access-token", expect.any(Number)],
      [REFRESH_TOKEN_COOKIE, "new-refresh-token", expect.any(Number)],
      [MFA_CHALLENGE_COOKIE, "", 0],
    ]);
    for (const [, , options] of store.set.mock.calls.slice(0, 2)) {
      expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    }
  });

  it("drops a next value that leaves the portal, and sends an unverified account to /verify-pending", async () => {
    answer({ "/v1/auth/sign-in": () => json(portalSession(), 200) });
    for (const next of ["https://evil.example/x", "//evil.example", "/\\evil.example"]) {
      await expect(
        signIn(
          { status: "idle", fieldErrors: {}, values: { email: "" } },
          formData({ email: EMAIL, password: PASSWORD, next }),
        ),
      ).rejects.toThrow("NEXT_REDIRECT /dashboard");
    }

    answer({ "/v1/auth/sign-in": () => json(portalSession(false), 200) });
    await expect(
      signIn(
        { status: "idle", fieldErrors: {}, values: { email: "" } },
        formData({ email: EMAIL, password: PASSWORD }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT /verify-pending");
  });

  it("[PFE-002 AC2] [FIX-W26-SECURITY AC2] stays on the portal for a next whose dot segments normalise to //evil.example, with or without MFA", async () => {
    for (const next of DOT_SEGMENT_REDIRECTS) {
      // Signed in at once: the default page, never the other host.
      cookieStore();
      answer({ "/v1/auth/sign-in": () => json(portalSession(), 200) });
      await expect(
        signIn(
          { status: "idle", fieldErrors: {}, values: { email: "" } },
          formData({ email: EMAIL, password: PASSWORD, next }),
        ),
      ).rejects.toThrow(/^NEXT_REDIRECT \/dashboard$/);

      // With MFA: no return path is kept for the code step ...
      const store = cookieStore();
      answer({
        "/v1/auth/sign-in": () =>
          json({ mfaRequired: true, mfaChallengeToken: MFA_CHALLENGE, expiresIn: 300 }, 200),
      });
      await expect(
        signIn(
          { status: "idle", fieldErrors: {}, values: { email: "" } },
          formData({ email: EMAIL, password: PASSWORD, next }),
        ),
      ).rejects.toThrow(/^NEXT_REDIRECT \/sign-in\/mfa$/);
      expect(writes(store), next).toEqual([[MFA_CHALLENGE_COOKIE, MFA_CHALLENGE, 300]]);

      // ... and one the cookie still holds (written by an earlier release) is checked again after the code.
      cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE, [NEXT_PATH_COOKIE]: next });
      answer({ "/v1/auth/mfa/verify": () => json(portalSession(), 200) });
      await expect(
        verifyMfa({ status: "idle", method: "totp" }, formData({ method: "totp", code: "492039" })),
      ).rejects.toThrow(/^NEXT_REDIRECT \/dashboard$/);
    }
  });

  it("keeps an MFA challenge in a SameSite=Strict cookie with the return path, and continues to /sign-in/mfa [PF-04 AC2]", async () => {
    const store = cookieStore();
    answer({
      "/v1/auth/sign-in": () =>
        json({ mfaRequired: true, mfaChallengeToken: MFA_CHALLENGE, expiresIn: 300 }, 200),
    });

    await expect(
      signIn(
        { status: "idle", fieldErrors: {}, values: { email: "" } },
        formData({ email: EMAIL, password: PASSWORD, next: "/account/security" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT /sign-in/mfa");

    // No session yet: only the challenge (5 minutes at most) and the validated return path.
    expect(writes(store)).toEqual([
      [MFA_CHALLENGE_COOKIE, MFA_CHALLENGE, 300],
      [NEXT_PATH_COOKIE, "/account/security", 900],
    ]);
    expect(store.set.mock.calls[0]?.[2]).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict" });
  });
});

describe("/sign-in page", () => {
  it("renders one h1, the form and the links to sign-up and to the password reset", async () => {
    await renderSignInPage();

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      SIGN_IN_STRINGS.title,
    ]);
    expect(screen.getByRole("main").id).toBe("main-content");
    expect(screen.getByRole("link", { name: SIGN_IN_STRINGS.signUp }).getAttribute("href")).toBe("/sign-up");
    expect(screen.getByRole("link", { name: SIGN_IN_STRINGS.forgotPassword }).getAttribute("href")).toBe(
      "/forgot-password",
    );
    expect(input(SIGN_IN_STRINGS.emailLabel).getAttribute("autocomplete")).toBe("username");
    expect(input(SIGN_IN_STRINGS.passwordLabel).getAttribute("autocomplete")).toBe("current-password");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("carries only a relative next path into the form", async () => {
    await renderSignInPage({ next: "/otas/ten_1?tab=keys" });
    expect(document.querySelector<HTMLInputElement>('input[name="next"]')?.value).toBe(
      "/otas/ten_1?tab=keys",
    );
    cleanup();

    for (const next of ["https://evil.example/x", "//evil.example", ["/a", "/b"]]) {
      await renderSignInPage({ next });
      expect(document.querySelector('input[name="next"]')).toBeNull();
      cleanup();
    }
  });

  it("[PFE-002 AC2] [FIX-W26-SECURITY AC2] carries no next into the form or the sign-up link when its dot segments normalise to //evil.example", async () => {
    for (const next of DOT_SEGMENT_REDIRECTS) {
      await renderSignInPage({ next });
      expect(document.querySelector('input[name="next"]'), next).toBeNull();
      expect(screen.getByRole("link", { name: SIGN_IN_STRINGS.signUp }).getAttribute("href"), next).toBe(
        "/sign-up",
      );
      cleanup();
    }
  });

  it("shows the notice of where the visitor came from, and nothing for unknown values", async () => {
    const notices: [SearchParams, string][] = [
      [{ verified: "1" }, SIGN_IN_STRINGS.verified],
      [{ reset: "1" }, SIGN_IN_STRINGS.passwordChanged],
      [{ signedOut: "1" }, SIGN_IN_STRINGS.signedOut],
    ];
    for (const [params, text] of notices) {
      await renderSignInPage(params);
      expect(screen.getByRole("status").textContent).toBe(text);
      cleanup();
    }

    await renderSignInPage({ mfa: "expired" });
    expect(screen.getByRole("alert").textContent).toBe(ERROR_MESSAGES.MFA_CHALLENGE_INVALID);
    cleanup();

    await renderSignInPage({ verified: "<script>", mfa: "no" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ---- /sign-in/mfa -----------------------------------------------------------------------------------------------

describe("/sign-in/mfa: MfaForm and the verifyMfa action", () => {
  it("[PFE-006 AC2] accepts a recovery code: sends it with the challenge, stores the session and clears the challenge [PF-04 AC2]", async () => {
    const store = cookieStore({
      [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE,
      [NEXT_PATH_COOKIE]: "/account/security",
    });
    answer({ "/v1/auth/mfa/verify": () => json(portalSession(), 200) });
    renderWithRedirects(await MfaPage());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(MFA_STRINGS.title);
    expect(input(MFA_STRINGS.codeLabel)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: MFA_STRINGS.useRecoveryCode }));
    // The recovery code field replaces the code field and takes the focus.
    const recovery = input(MFA_STRINGS.recoveryLabel);
    await waitFor(() => expect(document.activeElement).toBe(recovery));
    expect(screen.queryByLabelText(MFA_STRINGS.codeLabel, { exact: false })).toBeNull();
    expect(screen.getByText(MFA_STRINGS.recoveryIntro)).toBeTruthy();
    type(MFA_STRINGS.recoveryLabel, ` ${RECOVERY_CODE.toLowerCase()} `);
    submit(MFA_STRINGS.submit);

    expect(await redirectedTo()).toBe("/account/security");
    const call = onlyCall("/v1/auth/mfa/verify");
    expect(await call.json()).toEqual({
      mfaChallengeToken: MFA_CHALLENGE,
      recoveryCode: RECOVERY_CODE.toLowerCase(),
    });
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
    // The session is stored; the challenge and the return path are deleted.
    expect(writes(store)).toEqual([
      [ACCESS_TOKEN_COOKIE, "new-access-token", expect.any(Number)],
      [REFRESH_TOKEN_COOKIE, "new-refresh-token", expect.any(Number)],
      [MFA_CHALLENGE_COOKIE, "", 0],
      [NEXT_PATH_COOKIE, "", 0],
    ]);
  });

  it("[PFE-006 AC2] shows a refused recovery code at its field and keeps the challenge", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/auth/mfa/verify": () => apiError("MFA_CODE_INVALID", 401) });
    render(await MfaPage());
    fireEvent.click(screen.getByRole("button", { name: MFA_STRINGS.useRecoveryCode }));
    type(MFA_STRINGS.recoveryLabel, RECOVERY_CODE);
    submit(MFA_STRINGS.submit);

    await waitFor(() =>
      expect(descriptionsOf(input(MFA_STRINGS.recoveryLabel))).toContain(MFA_STRINGS.recoveryInvalid),
    );
    expect(store.set).not.toHaveBeenCalled();

    // A malformed recovery code never reaches the API.
    fetchMock.mockClear();
    type(MFA_STRINGS.recoveryLabel, "not-a-code");
    submit(MFA_STRINGS.submit);
    await waitFor(() =>
      expect(descriptionsOf(input(MFA_STRINGS.recoveryLabel))).toContain(MFA_STRINGS.recoveryFormat),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs in with a TOTP code of the authenticator app, spaces dropped, to /dashboard", async () => {
    cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/auth/mfa/verify": () => json(portalSession(), 200) });

    await expect(
      verifyMfa({ status: "idle", method: "totp" }, formData({ method: "totp", code: "492 039" })),
    ).rejects.toThrow("NEXT_REDIRECT /dashboard");

    expect(await onlyCall("/v1/auth/mfa/verify").json()).toEqual({
      mfaChallengeToken: MFA_CHALLENGE,
      code: "492039",
    });
  });

  it("shows a wrong TOTP code at the field, and a malformed one without calling the API", async () => {
    cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({ "/v1/auth/mfa/verify": () => apiError("MFA_CODE_INVALID", 401) });
    render(await MfaPage());
    type(MFA_STRINGS.codeLabel, "123456");
    submit(MFA_STRINGS.submit);
    await waitFor(
      () => expect(descriptionsOf(input(MFA_STRINGS.codeLabel))).toContain(ERROR_MESSAGES.MFA_CODE_INVALID),
      ACTION_WAIT,
    );
    // The summary takes the focus in an effect, which may run after the render the wait above saw.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")), ACTION_WAIT);

    fetchMock.mockClear();
    type(MFA_STRINGS.codeLabel, "12345");
    submit(MFA_STRINGS.submit);
    await waitFor(() =>
      expect(descriptionsOf(input(MFA_STRINGS.codeLabel))).toContain(MFA_STRINGS.codeFormat),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an expired or used-up challenge back to sign-in with its return path, deleting the cookies [PF-04 AC2]", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE, [NEXT_PATH_COOKIE]: "/otas/ten_1" });
    answer({ "/v1/auth/mfa/verify": () => apiError("MFA_CHALLENGE_INVALID", 401) });

    await expect(
      verifyMfa({ status: "idle", method: "totp" }, formData({ method: "totp", code: "492039" })),
    ).rejects.toThrow("NEXT_REDIRECT /sign-in?mfa=expired&next=%2Fotas%2Ften_1");
    expect(writes(store)).toEqual([
      [MFA_CHALLENGE_COOKIE, "", 0],
      [NEXT_PATH_COOKIE, "", 0],
    ]);
  });

  it("shows the wait of Retry-After when too many codes were tried, and keeps the challenge", async () => {
    const store = cookieStore({ [MFA_CHALLENGE_COOKIE]: MFA_CHALLENGE });
    answer({
      "/v1/auth/mfa/verify": () => apiError("RATE_LIMITED", 429, { headers: { "retry-after": "420" } }),
    });

    const state = await verifyMfa(
      { status: "idle", method: "totp" },
      formData({ method: "totp", code: "492039" }),
    );

    expect(state).toEqual({
      status: "failed",
      code: "RATE_LIMITED",
      method: "totp",
      message: MFA_STRINGS.rateLimitedFor(420),
    });
    expect(state.message).toContain("Try again in 7 minutes.");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("sends a visitor without a challenge back to sign-in", async () => {
    cookieStore();
    await expect(MfaPage()).rejects.toThrow("NEXT_REDIRECT /sign-in?mfa=expired");
    await expect(
      verifyMfa({ status: "idle", method: "totp" }, formData({ method: "totp", code: "492039" })),
    ).rejects.toThrow("NEXT_REDIRECT /sign-in?mfa=expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- /forgot-password ---------------------------------------------------------------------------------------------

describe("/forgot-password: ForgotPasswordForm and the requestPasswordReset action", () => {
  it("confirms the same way for every address and calls the API without a bearer token [PF-05 AC1]", async () => {
    answer({ "/v1/auth/password-reset": () => empty(202) });
    render(<ForgotPasswordPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(PASSWORD_RESET_STRINGS.forgotTitle);

    type(PASSWORD_RESET_STRINGS.emailLabel, ` ${EMAIL} `);
    submit(PASSWORD_RESET_STRINGS.requestSubmit);
    expect((await screen.findByRole("status")).textContent).toBe(PASSWORD_RESET_STRINGS.sent);
    const call = onlyCall("/v1/auth/password-reset");
    expect(await call.json()).toEqual({ email: EMAIL });
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);

    const other = await requestPasswordReset(
      { status: "idle", email: "" },
      formData({ email: "nobody@example.com" }),
    );
    expect(other).toEqual({
      status: "sent",
      message: PASSWORD_RESET_STRINGS.sent,
      email: "nobody@example.com",
    });
  });

  it("shows the 3-per-hour message on RATE_LIMITED and asks for a valid address first", async () => {
    answer({ "/v1/auth/password-reset": () => apiError("RATE_LIMITED", 429) });
    render(<ForgotPasswordForm />);
    type(PASSWORD_RESET_STRINGS.emailLabel, EMAIL);
    submit(PASSWORD_RESET_STRINGS.requestSubmit);
    expect((await screen.findByRole("alert")).textContent).toBe(PASSWORD_RESET_STRINGS.requestRateLimited);
    expect(input(PASSWORD_RESET_STRINGS.emailLabel).value).toBe(EMAIL);

    fetchMock.mockClear();
    type(PASSWORD_RESET_STRINGS.emailLabel, "anna@");
    submit(PASSWORD_RESET_STRINGS.requestSubmit);
    await waitFor(() =>
      expect(descriptionsOf(input(PASSWORD_RESET_STRINGS.emailLabel))).toContain(
        SIGN_IN_STRINGS.emailInvalid,
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- /reset-password ----------------------------------------------------------------------------------------------

describe("/reset-password: the page and the confirmPasswordReset action", () => {
  it("[PFE-006 AC3] shows the new-password form only with the token cookie, and never renders the token [PF-05 AC1]", async () => {
    cookieStore({ [PASSWORD_RESET_COOKIE]: RESET_TOKEN });
    render(await ResetPasswordPage());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(PASSWORD_RESET_STRINGS.resetTitle);
    const password = input(PASSWORD_RESET_STRINGS.newPasswordLabel);
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    // The token stays in its httpOnly cookie: it is in no field, attribute or text of the page.
    const form = password.closest("form") as HTMLFormElement;
    expect([...new FormData(form).keys()]).toEqual(["newPassword"]);
    expect(document.documentElement.outerHTML).not.toContain(RESET_TOKEN);
    cleanup();

    cookieStore();
    render(await ResetPasswordPage());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      PASSWORD_RESET_STRINGS.linkMissingTitle,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText(PASSWORD_RESET_STRINGS.newPasswordLabel, { exact: false })).toBeNull();
    expect(
      screen.getByRole("link", { name: PASSWORD_RESET_STRINGS.requestNewLink }).getAttribute("href"),
    ).toBe("/forgot-password");
  });

  it("[PFE-006 AC3] sends the token of the cookie with the new password, then deletes it and the session [PF-05 AC2]", async () => {
    const store = cookieStore({
      [PASSWORD_RESET_COOKIE]: RESET_TOKEN,
      [ACCESS_TOKEN_COOKIE]: "an-access-token",
      [REFRESH_TOKEN_COOKIE]: "a-refresh-token",
    });
    answer({ "/v1/auth/password-reset/confirm": () => empty(204) });
    renderWithRedirects(await ResetPasswordPage());
    type(PASSWORD_RESET_STRINGS.newPasswordLabel, "Silver-Fjord-Morning-7");
    submit(PASSWORD_RESET_STRINGS.resetSubmit);

    expect(await redirectedTo()).toBe("/sign-in?reset=1");
    const call = onlyCall("/v1/auth/password-reset/confirm");
    expect(await call.json()).toEqual({ token: RESET_TOKEN, newPassword: "Silver-Fjord-Morning-7" });
    // A public operation: the old session's bearer token is not sent.
    expect(call.headers.get("authorization")).toBeNull();
    expect(writes(store)).toEqual([
      [PASSWORD_RESET_COOKIE, "", 0],
      [ACCESS_TOKEN_COOKIE, "", 0],
      [REFRESH_TOKEN_COOKIE, "", 0],
    ]);
  });

  it("shows PASSWORD_TOO_WEAK at the field and keeps the token for another try", async () => {
    const store = cookieStore({ [PASSWORD_RESET_COOKIE]: RESET_TOKEN });
    answer({
      "/v1/auth/password-reset/confirm": () =>
        apiError("PASSWORD_TOO_WEAK", 422, { fieldErrors: [{ path: "/newPassword", code: "breached" }] }),
    });
    render(await ResetPasswordPage());
    type(PASSWORD_RESET_STRINGS.newPasswordLabel, "qwertyuiop");
    submit(PASSWORD_RESET_STRINGS.resetSubmit);

    const password = input(PASSWORD_RESET_STRINGS.newPasswordLabel);
    await waitFor(() => expect(descriptionsOf(password)).toContain(SIGN_UP_STRINGS.passwordBreached));
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(password.value).toBe("");
    expect(store.set).not.toHaveBeenCalled();

    // A short password never reaches the API.
    fetchMock.mockClear();
    type(PASSWORD_RESET_STRINGS.newPasswordLabel, "short-pw");
    submit(PASSWORD_RESET_STRINGS.resetSubmit);
    await waitFor(() =>
      expect(descriptionsOf(input(PASSWORD_RESET_STRINGS.newPasswordLabel))).toContain(
        SIGN_UP_STRINGS.passwordTooShort,
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers a new link when the token is used or expired, and deletes its cookie", async () => {
    const store = cookieStore({ [PASSWORD_RESET_COOKIE]: RESET_TOKEN });
    answer({ "/v1/auth/password-reset/confirm": () => apiError("PASSWORD_RESET_TOKEN_INVALID", 400) });
    render(await ResetPasswordPage());
    type(PASSWORD_RESET_STRINGS.newPasswordLabel, "Silver-Fjord-Morning-7");
    submit(PASSWORD_RESET_STRINGS.resetSubmit);

    expect((await screen.findByRole("alert")).textContent).toBe(ERROR_MESSAGES.PASSWORD_RESET_TOKEN_INVALID);
    expect(
      screen.getByRole("link", { name: PASSWORD_RESET_STRINGS.requestNewLink }).getAttribute("href"),
    ).toBe("/forgot-password");
    expect(screen.queryByLabelText(PASSWORD_RESET_STRINGS.newPasswordLabel, { exact: false })).toBeNull();
    expect(writes(store)).toEqual([[PASSWORD_RESET_COOKIE, "", 0]]);
  });

  it("answers without the cookie that the link has to be opened again, without calling the API", async () => {
    cookieStore();
    const state = await confirmPasswordReset(
      { status: "idle" },
      formData({ newPassword: "Silver-Fjord-Morning-7" }),
    );
    expect(state).toMatchObject({ status: "expired", code: "PASSWORD_RESET_TOKEN_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
