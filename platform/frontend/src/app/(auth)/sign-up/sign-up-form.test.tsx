// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js, the configuration and the platform API ---------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sign-up",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
}));

const api = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  PATCH: vi.fn(),
  DELETE: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  platformApi: vi.fn(() => Promise.resolve(api)),
  createPlatformApi: vi.fn(() => api),
}));

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import CheckEmailPage from "@/app/(auth)/sign-up/check-email/page";
import SignUpPage from "@/app/(auth)/sign-up/page";
import { ResendVerificationForm, SignUpForm } from "@/app/(auth)/sign-up/sign-up-form";
import { continueAfterVerification, resendVerificationLink } from "@/app/(auth)/verify-pending/actions";
import VerifyPendingPage from "@/app/(auth)/verify-pending/page";
import { fieldId } from "@/components/form-field";
import type { ApiError } from "@/lib/api";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, type PortalSession } from "@/lib/session";
import { ERROR_MESSAGES, SIGN_UP_STRINGS, VERIFICATION_STRINGS } from "@/lib/strings";
import { termsVersion } from "@/lib/terms";

// ---- Builders ------------------------------------------------------------------------------------------------

/** A password the portal accepts (the API may still refuse it); a dummy, never a real one. */
const LONG_PASSWORD = "Northern-Lights-2026";

function apiError(
  code: ApiError["code"],
  status: number,
  fieldErrors: ApiError["fieldErrors"] = [],
): { error: ApiError } {
  return { error: { code, status, fieldErrors, details: {} } };
}

type Account = PortalSession["account"];

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "anna.berg@example.com",
    emailVerified: false,
    fullName: "Anna Berg",
    locale: "en",
    timeZone: "Europe/Oslo",
    mfaEnabled: false,
    mfaEnabledAt: null,
    isPlatformAdmin: false,
    createdAt: "2026-10-01T10:02:17Z",
    version: 1,
    memberships: [],
    features: {
      stripeBilling: false,
      ownStripe: false,
      settlements: false,
      ownAmadeus: false,
      customDomains: false,
      liveSwitch: false,
    },
    ...overrides,
  };
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

function accessToken(emailVerified: boolean): string {
  return jwt({
    sub: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    exp: Math.floor(Date.now() / 1000) + 900,
    ev: emailVerified,
  });
}

let counter = 0;
/** A refresh token no other test uses: the single-flight map of `lib/session.ts` lives for the whole file. */
function uniqueRefreshToken(): string {
  counter += 1;
  return `refresh-token-${counter}-${Math.random().toString(36).slice(2)}`;
}

function renewedSession(emailVerified: boolean): PortalSession {
  return {
    accessToken: accessToken(emailVerified),
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "rotated-refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
    account: account({ emailVerified }),
  };
}

/** The cookie store of `cookies()`: the given cookies, and a record of every write. */
function cookieStore(values: Record<string, string> = {}) {
  const store = {
    get: vi.fn((name: string) => (name in values ? { name, value: values[name] } : undefined)),
    set: vi.fn(),
  };
  nextHeaders.cookies.mockResolvedValue(store);
  nextHeaders.headers.mockResolvedValue(new Headers());
  return store;
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: HTMLElement): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
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

function fillSignUp(values: { fullName?: string; email?: string; password?: string; terms?: boolean }): void {
  fireEvent.change(input(SIGN_UP_STRINGS.fullNameLabel), {
    target: { value: values.fullName ?? "Anna Berg" },
  });
  fireEvent.change(input(SIGN_UP_STRINGS.emailLabel), {
    target: { value: values.email ?? "anna.berg@example.com" },
  });
  fireEvent.change(input(SIGN_UP_STRINGS.passwordLabel), {
    target: { value: values.password ?? LONG_PASSWORD },
  });
  if (values.terms ?? true) {
    fireEvent.click(screen.getByRole("checkbox"));
  }
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

beforeEach(() => {
  navigation.redirect.mockClear();
  for (const method of Object.values(api)) {
    method.mockReset();
  }
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---- Sign-up ----------------------------------------------------------------------------------------------------

describe("/sign-up: SignUpForm and the signUp action", () => {
  it("[PFE-005 AC1] shows a field error for a short password, linked to the field, without calling the API", async () => {
    render(<SignUpForm />);
    fillSignUp({ password: "short-pw" });
    submit(SIGN_UP_STRINGS.submit);

    const password = input(SIGN_UP_STRINGS.passwordLabel);
    await waitFor(() => expect(descriptionsOf(password)).toContain(SIGN_UP_STRINGS.passwordTooShort));
    expect(password.getAttribute("aria-invalid")).toBe("true");
    const summary = screen.getByRole("alert");
    expect(
      within(summary).getByRole("link", { name: SIGN_UP_STRINGS.passwordTooShort }).getAttribute("href"),
    ).toBe(`#${fieldId("password")}`);
    expect(document.activeElement).toBe(summary);
    expect(api.POST).not.toHaveBeenCalled();
    // What was typed stays, except the password, which never comes back to the browser.
    expect(input(SIGN_UP_STRINGS.fullNameLabel).value).toBe("Anna Berg");
    expect(input(SIGN_UP_STRINGS.emailLabel).value).toBe("anna.berg@example.com");
    expect(password.value).toBe("");
  });

  it("[PFE-005 AC1] maps the API's PASSWORD_TOO_WEAK (too_short) to the password field", async () => {
    // The API owns the rule (PF-01 AC2): its answer is shown even for a password the portal let through.
    api.POST.mockResolvedValue(
      apiError("PASSWORD_TOO_WEAK", 422, [{ path: "/password", code: "too_short" }]),
    );
    render(<SignUpForm />);
    fillSignUp({});
    submit(SIGN_UP_STRINGS.submit);

    const password = input(SIGN_UP_STRINGS.passwordLabel);
    await waitFor(() => expect(descriptionsOf(password)).toContain(SIGN_UP_STRINGS.passwordTooShort));
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(password.value).toBe("");
    expect(
      within(screen.getByRole("alert"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([SIGN_UP_STRINGS.passwordTooShort]);
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("[PFE-005 AC1] maps the API's PASSWORD_TOO_WEAK (breached) to the password field", async () => {
    api.POST.mockResolvedValue(apiError("PASSWORD_TOO_WEAK", 422, [{ path: "/password", code: "breached" }]));
    render(<SignUpForm />);
    fillSignUp({ password: "qwertyuiop" });
    submit(SIGN_UP_STRINGS.submit);

    const password = input(SIGN_UP_STRINGS.passwordLabel);
    await waitFor(() => expect(descriptionsOf(password)).toContain(SIGN_UP_STRINGS.passwordBreached));
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(password.value).toBe("");
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(api.POST).toHaveBeenCalledWith("/v1/auth/sign-up", {
      body: {
        fullName: "Anna Berg",
        email: "anna.berg@example.com",
        password: "qwertyuiop",
        acceptTerms: true,
        termsVersion,
      },
    });
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("[PFE-005 AC1] shows PASSWORD_TOO_WEAK at the password field even when the API names no field", async () => {
    api.POST.mockResolvedValue(apiError("PASSWORD_TOO_WEAK", 422));
    render(<SignUpForm />);
    fillSignUp({});
    submit(SIGN_UP_STRINGS.submit);

    await waitFor(() =>
      expect(descriptionsOf(input(SIGN_UP_STRINGS.passwordLabel))).toContain(
        ERROR_MESSAGES.PASSWORD_TOO_WEAK,
      ),
    );
  });

  it("[PFE-005 AC1] redirects to /sign-up/check-email when the API accepts the sign-up", async () => {
    // The redirect error of the action reaches the boundary; React reports it on the console.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    api.POST.mockResolvedValue({ data: { status: "verification_sent" } });
    render(
      <RedirectBoundary>
        <SignUpForm />
      </RedirectBoundary>,
    );
    fillSignUp({ fullName: "  Anna Berg  ", email: " anna.berg@example.com " });
    submit(SIGN_UP_STRINGS.submit);

    expect((await screen.findByRole("status")).textContent).toBe("Redirected to /sign-up/check-email");
    expect(navigation.redirect).toHaveBeenCalledWith("/sign-up/check-email");
    // Trimmed by the form schema, as the API compares them.
    expect(api.POST).toHaveBeenCalledWith("/v1/auth/sign-up", {
      body: {
        fullName: "Anna Berg",
        email: "anna.berg@example.com",
        password: LONG_PASSWORD,
        acceptTerms: true,
        termsVersion,
      },
    });
  });

  it("asks for every missing field and the terms before calling the API", async () => {
    render(<SignUpForm />);
    fillSignUp({ fullName: " ", email: "not-an-address", password: "", terms: false });
    submit(SIGN_UP_STRINGS.submit);

    await waitFor(() =>
      expect(descriptionsOf(input(SIGN_UP_STRINGS.fullNameLabel))).toContain(
        SIGN_UP_STRINGS.fullNameRequired,
      ),
    );
    expect(descriptionsOf(input(SIGN_UP_STRINGS.emailLabel))).toContain(SIGN_UP_STRINGS.emailInvalid);
    expect(descriptionsOf(input(SIGN_UP_STRINGS.passwordLabel))).toContain(SIGN_UP_STRINGS.passwordTooShort);
    const terms = screen.getByRole("checkbox");
    expect(descriptionsOf(terms)).toEqual([SIGN_UP_STRINGS.termsRequired]);
    expect(terms.getAttribute("aria-invalid")).toBe("true");
    // The summary lists the problems in the order of the form.
    expect(
      within(screen.getByRole("alert"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      SIGN_UP_STRINGS.fullNameRequired,
      SIGN_UP_STRINGS.emailInvalid,
      SIGN_UP_STRINGS.passwordTooShort,
      SIGN_UP_STRINGS.termsRequired,
    ]);
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("maps the API's field errors by JSON pointer and keeps the rate limit above the form", async () => {
    api.POST.mockResolvedValueOnce(apiError("VALIDATION_FAILED", 400, [{ path: "/email", code: "format" }]));
    render(<SignUpForm />);
    fillSignUp({});
    submit(SIGN_UP_STRINGS.submit);
    await waitFor(() =>
      expect(descriptionsOf(input(SIGN_UP_STRINGS.emailLabel))).toContain(SIGN_UP_STRINGS.emailInvalid),
    );

    api.POST.mockResolvedValueOnce(apiError("RATE_LIMITED", 429));
    fireEvent.change(input(SIGN_UP_STRINGS.passwordLabel), { target: { value: LONG_PASSWORD } });
    submit(SIGN_UP_STRINGS.submit);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(SIGN_UP_STRINGS.rateLimited));
    expect(input(SIGN_UP_STRINGS.emailLabel).getAttribute("aria-invalid")).toBeNull();
  });

  it("shows the portal's own message for other failures, never the API's", async () => {
    api.POST.mockResolvedValue(apiError("SERVICE_UNAVAILABLE", 503));
    render(<SignUpForm />);
    fillSignUp({});
    submit(SIGN_UP_STRINGS.submit);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE),
    );
  });

  it("renders the page with one h1, links to the terms and to sign-in", () => {
    render(<SignUpPage />);

    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      SIGN_UP_STRINGS.title,
    ]);
    expect(screen.getByRole("main").id).toBe("main-content");
    expect(screen.getByRole("link", { name: SIGN_UP_STRINGS.termsLink }).getAttribute("href")).toBe(
      "/legal/terms",
    );
    expect(screen.getByRole("link", { name: SIGN_UP_STRINGS.privacyLink }).getAttribute("href")).toBe(
      "/legal/privacy",
    );
    expect(screen.getByRole("link", { name: SIGN_UP_STRINGS.signIn }).getAttribute("href")).toBe("/sign-in");
    expect(input(SIGN_UP_STRINGS.passwordLabel).getAttribute("autocomplete")).toBe("new-password");
    expect(input(SIGN_UP_STRINGS.passwordLabel).getAttribute("type")).toBe("password");
  });
});

// ---- Send a new link --------------------------------------------------------------------------------------------

describe("'Send a new link': ResendVerificationForm and resendVerificationLink", () => {
  it("sends a new link to the typed address and confirms without saying whether it has an account", async () => {
    api.POST.mockResolvedValue({ data: undefined });
    render(<ResendVerificationForm askForEmail />);
    fireEvent.change(input(VERIFICATION_STRINGS.resendEmailLabel), {
      target: { value: " anna.berg@example.com " },
    });
    submit(VERIFICATION_STRINGS.resend);

    expect((await screen.findByRole("status")).textContent).toBe(VERIFICATION_STRINGS.resentAnonymous);
    expect(api.POST).toHaveBeenCalledWith("/v1/auth/resend-verification", {
      body: { email: "anna.berg@example.com" },
    });
    expect(api.GET).not.toHaveBeenCalled();
  });

  it("shows the 3-per-hour message when the API answers RATE_LIMITED", async () => {
    api.POST.mockResolvedValue(apiError("RATE_LIMITED", 429));
    render(<ResendVerificationForm askForEmail />);
    fireEvent.change(input(VERIFICATION_STRINGS.resendEmailLabel), {
      target: { value: "anna.berg@example.com" },
    });
    submit(VERIFICATION_STRINGS.resend);

    expect((await screen.findByRole("alert")).textContent).toBe(VERIFICATION_STRINGS.resendRateLimited);
    expect(input(VERIFICATION_STRINGS.resendEmailLabel).value).toBe("anna.berg@example.com");
  });

  it("asks for a valid address before calling the API", async () => {
    render(<ResendVerificationForm askForEmail />);
    fireEvent.change(input(VERIFICATION_STRINGS.resendEmailLabel), { target: { value: "anna" } });
    submit(VERIFICATION_STRINGS.resend);

    await waitFor(() =>
      expect(descriptionsOf(input(VERIFICATION_STRINGS.resendEmailLabel))).toContain(
        SIGN_UP_STRINGS.emailInvalid,
      ),
    );
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("sends the link of a signed-in account to its own address, read on the server", async () => {
    api.GET.mockResolvedValue({ data: account() });
    api.POST.mockResolvedValue({ data: undefined });
    render(<ResendVerificationForm askForEmail={false} />);
    expect(screen.queryByLabelText(VERIFICATION_STRINGS.resendEmailLabel, { exact: false })).toBeNull();
    submit(VERIFICATION_STRINGS.resend);

    expect((await screen.findByRole("status")).textContent).toBe(VERIFICATION_STRINGS.resentSignedIn);
    expect(api.GET).toHaveBeenCalledWith("/v1/me");
    expect(api.POST).toHaveBeenCalledWith("/v1/auth/resend-verification", {
      body: { email: "anna.berg@example.com" },
    });
  });

  it("reports a signed-in account that cannot be loaded without calling resend", async () => {
    api.GET.mockResolvedValue(apiError("SERVICE_UNAVAILABLE", 503));

    const state = await resendVerificationLink({ status: "idle" }, new FormData());

    expect(state).toEqual({
      status: "failed",
      code: "SERVICE_UNAVAILABLE",
      message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
    });
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("shows an address the API refuses at the field", async () => {
    api.POST.mockResolvedValue(apiError("VALIDATION_FAILED", 400, [{ path: "/email", code: "format" }]));

    const state = await resendVerificationLink({ status: "idle" }, formData({ email: "anna@example" }));

    expect(state).toMatchObject({ status: "failed", fieldError: SIGN_UP_STRINGS.emailInvalid });
  });
});

// ---- /sign-up/check-email and /verify-pending --------------------------------------------------------------------

describe("/sign-up/check-email", () => {
  it("explains the next step the same way for every address and offers a new link for a typed address", () => {
    render(<CheckEmailPage />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(VERIFICATION_STRINGS.checkEmailTitle);
    expect(screen.getByRole("main").textContent).toContain(VERIFICATION_STRINGS.checkEmailIntro);
    expect(input(VERIFICATION_STRINGS.resendEmailLabel).value).toBe("");
    expect(screen.getByRole("button", { name: VERIFICATION_STRINGS.resend })).toBeTruthy();
    expect(screen.getByRole("link", { name: VERIFICATION_STRINGS.backToSignIn }).getAttribute("href")).toBe(
      "/sign-in",
    );
  });
});

type SearchParams = Record<string, string | string[] | undefined>;

async function renderVerifyPending(searchParams: SearchParams = {}): Promise<void> {
  render(await VerifyPendingPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("/verify-pending", () => {
  it("explains an expired or used link (?error=token) to a visitor and offers a new one", async () => {
    cookieStore();
    await renderVerifyPending({ error: "token" });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(VERIFICATION_STRINGS.pendingTitle);
    expect(screen.getByRole("alert").textContent).toBe(VERIFICATION_STRINGS.tokenInvalid);
    expect(input(VERIFICATION_STRINGS.resendEmailLabel)).toBeTruthy();
    expect(api.GET).not.toHaveBeenCalled();
  });

  it("ignores an error value it does not know", async () => {
    cookieStore();
    await renderVerifyPending({ error: "<script>" });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a signed-in, unverified account its address, a new link for it and sign-out", async () => {
    cookieStore({ [ACCESS_TOKEN_COOKIE]: accessToken(false) });
    api.GET.mockResolvedValue({ data: account() });
    await renderVerifyPending();

    expect(api.GET).toHaveBeenCalledWith("/v1/me");
    expect(screen.getByRole("main").textContent).toContain("anna.berg@example.com");
    expect(screen.queryByLabelText(VERIFICATION_STRINGS.resendEmailLabel, { exact: false })).toBeNull();
    expect(screen.getByRole("button", { name: VERIFICATION_STRINGS.resend })).toBeTruthy();
    const signOut = screen.getByRole("button", { name: VERIFICATION_STRINGS.signOut }).closest("form");
    expect(signOut?.getAttribute("action")).toBe("/sign-out");
    expect(signOut?.getAttribute("method")).toBe("post");
  });

  it("sends an account whose token already says verified to the dashboard", async () => {
    cookieStore({ [ACCESS_TOKEN_COOKIE]: accessToken(true) });
    api.GET.mockResolvedValue({ data: account({ emailVerified: true }) });

    await expect(renderVerifyPending()).rejects.toThrow("NEXT_REDIRECT /dashboard");
  });

  it("offers to continue when the address is verified but the token is older", async () => {
    cookieStore({ [ACCESS_TOKEN_COOKIE]: accessToken(false) });
    api.GET.mockResolvedValue({ data: account({ emailVerified: true }) });
    await renderVerifyPending();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(VERIFICATION_STRINGS.verifiedTitle);
    expect(screen.getByRole("button", { name: VERIFICATION_STRINGS.continue })).toBeTruthy();
    expect(screen.queryByRole("button", { name: VERIFICATION_STRINGS.resend })).toBeNull();
  });

  it("treats an ended session as a visitor, and says when the account cannot be loaded", async () => {
    cookieStore({ [ACCESS_TOKEN_COOKIE]: accessToken(false) });
    api.GET.mockResolvedValueOnce(apiError("UNAUTHENTICATED", 401));
    await renderVerifyPending();
    expect(input(VERIFICATION_STRINGS.resendEmailLabel)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();

    api.GET.mockResolvedValueOnce(apiError("SERVICE_UNAVAILABLE", 503));
    await renderVerifyPending();
    expect(screen.getByRole("alert").textContent).toBe(VERIFICATION_STRINGS.sessionUnavailable);
    expect(input(VERIFICATION_STRINGS.resendEmailLabel)).toBeTruthy();
  });
});

describe("continueAfterVerification", () => {
  it("renews the session so the token says verified, then continues to the dashboard", async () => {
    const refreshToken = uniqueRefreshToken();
    const store = cookieStore({ [REFRESH_TOKEN_COOKIE]: refreshToken });
    api.POST.mockResolvedValue({ data: renewedSession(true) });

    await expect(continueAfterVerification()).rejects.toThrow("NEXT_REDIRECT /dashboard");

    expect(api.POST).toHaveBeenCalledWith("/v1/auth/refresh", { body: { refreshToken } });
    expect(store.set.mock.calls.map(([name]) => name)).toEqual([ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]);
    expect(store.set.mock.calls[1]?.[1]).toBe("rotated-refresh-token");
    expect(store.set.mock.calls[1]?.[2]).toMatchObject({ httpOnly: true, secure: true, path: "/" });
  });

  it("sends a session that cannot be renewed to sign-in, deleting its cookies", async () => {
    const store = cookieStore({ [REFRESH_TOKEN_COOKIE]: uniqueRefreshToken() });
    api.POST.mockResolvedValue(apiError("REFRESH_TOKEN_REUSED", 401));

    await expect(continueAfterVerification()).rejects.toThrow("NEXT_REDIRECT /sign-in?verified=1");

    expect(store.set.mock.calls.map(([name, value, options]) => [name, value, options.maxAge])).toEqual([
      [ACCESS_TOKEN_COOKIE, "", 0],
      [REFRESH_TOKEN_COOKIE, "", 0],
    ]);
  });

  it("keeps the session and says so when renewing fails for a moment", async () => {
    const store = cookieStore({ [REFRESH_TOKEN_COOKIE]: uniqueRefreshToken() });
    api.POST.mockResolvedValue(apiError("SERVICE_UNAVAILABLE", 503));

    await expect(continueAfterVerification()).rejects.toThrow("NEXT_REDIRECT /verify-pending?error=session");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("goes to sign-in without a refresh token", async () => {
    cookieStore();

    await expect(continueAfterVerification()).rejects.toThrow("NEXT_REDIRECT /sign-in?verified=1");
    expect(api.POST).not.toHaveBeenCalled();
  });
});
