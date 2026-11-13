// The authentication pages and the account menu (ota/frontend/docs/pages-account.md §1 and §5, README §8 and §10):
// account/sign-in.html, sign-up.html, verify.html, forgot-password.html and reset-password.html with their partials
// expanded by the build's include plugin, run by src/pages/account-*.js against a fake SDK in cookie mode, and the
// header's account menu of lib/session.js (below lg one compact "Account" disclosure, OFE-031, OFE-032). It covers
// the one-time tokens taken out of the address bar with history.replaceState, `next` that leaves the storefront going to
// `/`, paste and password managers on every password field, and the states of §5 (INVALID_CREDENTIALS,
// ACCOUNT_LOCKED, EMAIL_NOT_VERIFIED, EMAIL_ALREADY_REGISTERED, PASSWORD_TOO_WEAK, expired or used tokens, field errors
// with the focused summary, 429).
import {
  AuthenticationError,
  ConflictError,
  PermissionError,
  RateLimitError,
  ServerError,
  ValidationError,
  VelexisError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { compile as compileTailwind } from "tailwindcss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { mount as mountHeader } from "../src/components/header.js";
import { CONFIG_STORAGE_KEY } from "../src/lib/config.js";
import { formatTimestamp } from "../src/lib/format.js";
import {
  GREETING_CAP_CLASSES,
  nextTarget,
  passwordFieldErrors,
  passwordRules,
  renderAccountMenu,
  returnPathOf,
  withNext,
} from "../src/lib/session.js";
import { start as startForgot } from "../src/pages/account-forgot-password.js";
import { start as startReset } from "../src/pages/account-reset-password.js";
import { start as startSignIn } from "../src/pages/account-sign-in.js";
import { start as startSignUp } from "../src/pages/account-sign-up.js";
import { start as startVerify } from "../src/pages/account-verify.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/**
 * What the mocked boot() of the page modules saw (the address at each call) and what it resolves with: never, so the
 * tests start the pages themselves, unless a test that imports a page module afresh sets `context`.
 */
const bootMock = vi.hoisted(() => ({
  /** @type {string[]} */
  addresses: [],
  /** @type {object | null} */
  context: null,
}));
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    boot: () => {
      bootMock.addresses.push(location.href);
      return bootMock.context === null ? new Promise(() => {}) : Promise.resolve(bootMock.context);
    },
  };
});

const PAGES = Object.freeze({
  signIn: "account/sign-in.html",
  signUp: "account/sign-up.html",
  verify: "account/verify.html",
  forgot: "account/forgot-password.html",
  reset: "account/reset-password.html",
});
/** One-time tokens of the contract's shape; fixtures, not credentials. */
const VERIFY_TOKEN = "vt_fakeVerificationToken0000000000000001";
const RESET_TOKEN = "pr_fakePasswordResetToken000000000000001";
/** Passwords the fake API is typed with; long enough for the form's own `minlength`. */
const PASSWORD = "fixture-password-1";
const NEW_PASSWORD = "fixture-new-password-2";
const EMAIL = "ada.lovelace@example.com";
const PRICE_PATH = "/price.html?priced=prc_01JAUTHPAGESPRICED01";

const CONFIG = Object.freeze({
  name: "Demo Travel",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { customerAccounts: true, guestCheckout: true, savedTravelers: false },
  auth: {
    emailVerification: "required_before_checkout",
    passwordPolicy: {
      minLength: 10,
      maxLength: 128,
      requireUppercase: false,
      requireLowercase: false,
      requireDigit: false,
      requireSymbol: false,
      rejectBreached: true,
    },
    accessTokenTtlSeconds: 900,
    refreshTokenTtlDays: 30,
  },
  legal: {
    termsUrl: "https://demo-travel.example/terms",
    termsVersion: "2026-10-01",
    privacyUrl: "/p/privacy",
    privacyVersion: "2026-10-01",
    cookiePolicyUrl: "https://demo-travel.example/cookies",
    refundPolicyUrl: "https://demo-travel.example/refunds",
  },
});
const NO_ACCOUNTS = Object.freeze({ ...CONFIG, features: { ...CONFIG.features, customerAccounts: false } });

const CUSTOMER = Object.freeze({
  id: "cus_01JAUTHPAGESCUSTOMER1",
  email: EMAIL,
  emailVerified: false,
  firstName: "Ada",
  lastName: "Lovelace",
  status: "active",
  version: 1,
});
/** A customer session as `auth.getSession` answers it (no token fields). */
const SESSION = Object.freeze({
  customer: CUSTOMER,
  session: { id: "ses_01JAUTHPAGESSESSION1", rememberMe: true, authMethod: "password" },
});

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_authpages", ...body });

/**
 * A fake SDK client in cookie mode: the `auth` methods the pages call, each replaceable.
 * @param {Record<string, Function>} [overrides]
 */
function fakeClient(overrides = {}) {
  const accepted = async () => ({ status: "accepted", message: "Accepted by the fake API" });
  return {
    auth: {
      signIn: vi.fn(overrides.signIn ?? (async () => SESSION)),
      signUp: vi.fn(
        overrides.signUp ??
          (async () => ({
            customer: CUSTOMER,
            session: null,
            emailVerification: {
              policy: "required_before_checkout",
              verified: false,
              sentTo: "a•••@example.com",
              expiresAt: null,
            },
          })),
      ),
      verifyEmail: vi.fn(
        overrides.verifyEmail ??
          (async () => ({
            customer: { ...CUSTOMER, emailVerified: true },
            verifiedEmail: EMAIL,
            emailChanged: false,
            claimedGuestBookings: 0,
            returnPath: null,
          })),
      ),
      resendVerification: vi.fn(overrides.resendVerification ?? accepted),
      requestPasswordReset: vi.fn(overrides.requestPasswordReset ?? accepted),
      resetPassword: vi.fn(overrides.resetPassword ?? (async () => ({ customer: CUSTOMER, session: null }))),
      getSession: vi.fn(overrides.getSession ?? (async () => SESSION)),
      signOut: vi.fn(overrides.signOut ?? (async () => undefined)),
    },
  };
}

/** @type {Browser | undefined} */
let browser;
/** The parsed pages, by file. @type {Record<string, Document>} */
const pageDocuments = {};
/** The test window's address and title before each test. */
const original = { address: "", title: "" };
/** Views started by the current test, destroyed after it. */
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands the five pages (and index.html for the header) with the build's include plugin and parses them once in a
  // happy-dom browser; each test imports a fresh copy of a page's body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  for (const file of [...Object.values(PAGES), "index.html"]) {
    const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, file), "utf8"), {
      path: `/${file}`,
    });
    const page = browser.newPage();
    page.url = `${location.origin}/${file}`;
    page.content = html;
    pageDocuments[file] = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
  }
}, 15_000); // file reads, the include plugin and one happy-dom browser with six pages; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
  try {
    sessionStorage.clear();
  } catch {
    // Nothing stored.
  }
  if (original.title !== "") {
    document.title = original.title;
  }
  if (original.address !== "") {
    history.replaceState(null, "", original.address);
  }
});

/**
 * Puts a fresh copy of a page's body into the test document at `path`.
 * @param {string} file
 * @param {string} path
 */
function showPage(file, path) {
  original.address ||= `${location.pathname}${location.search}`;
  original.title ||= document.title;
  const source = /** @type {Document} */ (pageDocuments[file]);
  document.body.replaceChildren(
    ...Array.from(source.body.childNodes, (node) => document.importNode(node, true)),
  );
  document.title = source.title;
  history.replaceState(null, "", path);
}

/**
 * Loads a page module afresh, as the browser does, with the page at `path`: its own boot() call resolves with
 * `context`. Returns the addresses boot() was called at.
 * @param {string} file
 * @param {string} path
 * @param {() => Promise<unknown>} load the module's dynamic import
 * @param {object} context what boot() resolves with
 */
async function loadPageModule(file, path, load, context) {
  showPage(file, path);
  bootMock.addresses.length = 0;
  bootMock.context = context;
  vi.resetModules();
  try {
    await load();
  } finally {
    bootMock.context = null;
  }
  await settle();
  return [...bootMock.addresses];
}

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 60; i += 1) {
    await Promise.resolve();
  }
};

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const input = (/** @type {string} */ name) =>
  /** @type {HTMLInputElement} */ (document.querySelector(`main [name="${name}"]`));
const authForm = () => /** @type {HTMLFormElement} */ ($("form[data-auth-form]"));
/** The page state shown above the form. */
const shownState = () => $("[data-auth-state] [data-state]");

/**
 * Fills text inputs and checkboxes by name.
 * @param {Record<string, string | boolean>} values
 */
function fillForm(values) {
  for (const [name, value] of Object.entries(values)) {
    const control = input(name);
    if (typeof value === "boolean") {
      control.checked = value;
    } else {
      control.value = value;
    }
  }
}

/** Submits a form the way its submit button does. */
async function submit(form = authForm()) {
  form.requestSubmit(/** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]')));
  await settle();
}

/**
 * Opens a page and starts its module with a fake SDK.
 * @param {(context: any, env: any) => ({ done: Promise<unknown>, destroy: () => void } | null)} startPage
 * @param {string} file
 * @param {string} path
 * @param {{ config?: object, session?: object | null, client?: ReturnType<typeof fakeClient>, env?: object }} [options]
 */
async function open(
  startPage,
  file,
  path,
  { config = CONFIG, session = null, client = fakeClient(), env = {} } = {},
) {
  showPage(file, path);
  const navigate = vi.fn();
  const replace = vi.fn();
  const view = startPage({ config, client, session }, { navigate, replace, ...env });
  if (!view) {
    throw new Error(`${file} did not start`);
  }
  views.push(view);
  await view.done;
  await settle();
  return { client, navigate, replace, view };
}

describe("lib/session.js helpers", () => {
  it("[OFE-009 AC2] next leads only to paths on this storefront; without it the account page", () => {
    expect(nextTarget("?next=https://evil.example")).toBe("/");
    expect(nextTarget("?next=//evil.example/path")).toBe("/");
    expect(nextTarget("?next=/.//evil.example")).toBe("/");
    expect(nextTarget("?next=javascript:alert(1)")).toBe("/");
    expect(nextTarget(`?next=${encodeURIComponent(PRICE_PATH)}`)).toBe(PRICE_PATH);
    expect(nextTarget("")).toBe("/account/");
    expect(withNext("/account/sign-up.html", "?next=%2Fbookings.html")).toBe(
      "/account/sign-up.html?next=%2Fbookings.html",
    );
    expect(withNext("/account/sign-up.html", "?next=https://evil.example")).toBe(
      "/account/sign-up.html?next=%2F",
    );
    expect(withNext("/account/sign-up.html", "")).toBe("/account/sign-up.html");
  });

  it("[OFE-009] returnPath is the safe next only when the contract accepts it", () => {
    expect(returnPathOf(`?next=${encodeURIComponent(PRICE_PATH)}`)).toBe(PRICE_PATH);
    // A comma list (search filters) does not fit the contract's pattern: left out instead of a 400.
    expect(returnPathOf(`?next=${encodeURIComponent("/search.html?stops=0,1")}`)).toBeUndefined();
    expect(returnPathOf("?next=https://evil.example")).toBe("/");
    expect(returnPathOf("")).toBeUndefined();
  });

  it("[OFE-009] password rules come from the policy; PASSWORD_TOO_WEAK names the broken rule only", () => {
    expect(passwordRules(CONFIG.auth.passwordPolicy)).toBe(
      "Use at least 10 characters. Common passwords and passwords found in data breaches are refused.",
    );
    expect(
      passwordRules({
        ...CONFIG.auth.passwordPolicy,
        minLength: 12,
        requireDigit: true,
        rejectBreached: false,
      }),
    ).toBe("Use at least 12 characters. Include a digit.");
    const weak = apiError(ValidationError, "PASSWORD_TOO_WEAK", 422, {
      details: { violations: ["breached"] },
      fieldErrors: [{ path: "/newPassword", code: "too_weak", message: `${PASSWORD} is too common` }],
    });
    expect(passwordFieldErrors(weak, "/newPassword")).toEqual([
      { path: "/newPassword", code: "PASSWORD_BREACHED", message: "" },
    ]);
  });
});

describe("sign-in page", () => {
  const signInPath = (/** @type {string} */ query = "") => `/account/sign-in.html${query}`;

  it("[OFE-009] signs in with rememberMe in cookie mode and goes on to next", async () => {
    const { client, navigate } = await open(
      startSignIn,
      PAGES.signIn,
      signInPath(`?next=${encodeURIComponent(PRICE_PATH)}`),
    );
    expect(input("rememberMe").checked).toBe(true);
    fillForm({ email: ` ${EMAIL} `, password: PASSWORD });
    await submit();

    expect(client.auth.signIn).toHaveBeenCalledTimes(1);
    expect(client.auth.signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD, rememberMe: true });
    expect(navigate).toHaveBeenCalledWith(PRICE_PATH);
  });

  it("[OFE-009] rememberMe unticked asks for the short session; without next the account page", async () => {
    const { client, navigate } = await open(startSignIn, PAGES.signIn, signInPath());
    fillForm({ email: EMAIL, password: PASSWORD, rememberMe: false });
    await submit();

    expect(client.auth.signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD, rememberMe: false });
    expect(navigate).toHaveBeenCalledWith("/account/");
  });

  it("[OFE-009 AC2] next=https://evil.example redirects to /", async () => {
    const { navigate } = await open(startSignIn, PAGES.signIn, signInPath("?next=https://evil.example"));
    fillForm({ email: EMAIL, password: PASSWORD });
    await submit();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/");

    // A customer who is already signed in goes on at once, through the same check.
    const signedIn = await open(startSignIn, PAGES.signIn, signInPath("?next=https://evil.example"), {
      session: SESSION,
    });
    expect(signedIn.replace).toHaveBeenCalledWith("/");
    expect(signedIn.client.auth.signIn).not.toHaveBeenCalled();
  });

  it("[OFE-009] a signed-in customer goes on to next or the account page at once", async () => {
    const withNextParam = await open(startSignIn, PAGES.signIn, signInPath("?next=%2Fbookings.html"), {
      session: SESSION,
    });
    expect(withNextParam.replace).toHaveBeenCalledWith("/bookings.html");
    const plain = await open(startSignIn, PAGES.signIn, signInPath(), { session: SESSION });
    expect(plain.replace).toHaveBeenCalledWith("/account/");
  });

  it("[OFE-009] the links to the password reset and to sign-up keep next", async () => {
    await open(startSignIn, PAGES.signIn, signInPath("?next=%2Fbookings.html"));
    expect($('a[href^="/account/forgot-password.html"]').getAttribute("href")).toBe(
      "/account/forgot-password.html?next=%2Fbookings.html",
    );
    expect($('main a[href^="/account/sign-up.html"]').getAttribute("href")).toBe(
      "/account/sign-up.html?next=%2Fbookings.html",
    );
  });

  it("[OFE-009] 401 INVALID_CREDENTIALS shows one generic message with the attempts left and a reset link", async () => {
    const { navigate } = await open(startSignIn, PAGES.signIn, signInPath(), {
      client: fakeClient({
        signIn: async () =>
          Promise.reject(
            apiError(AuthenticationError, "INVALID_CREDENTIALS", 401, { details: { remainingAttempts: 2 } }),
          ),
      }),
    });
    fillForm({ email: EMAIL, password: PASSWORD });
    await submit();

    const state = shownState();
    expect(state.getAttribute("data-state")).toBe("invalid-credentials");
    expect(text(state.querySelector('[data-field="title"]'))).toBe(
      "The e-mail address or the password is not right",
    );
    expect(text(state.querySelector('[data-field="hint"]'))).toBe(
      "2 more attempts before sign-in is paused for 15 minutes.",
    );
    expect(state.querySelector('a[href="/account/forgot-password.html"]')).not.toBeNull();
    expect(document.activeElement).toBe(state.querySelector('[data-field="title"]'));
    expect(navigate).not.toHaveBeenCalled();
    // The typed values stay, the password included (paste and password managers are not fought).
    expect(input("email").value).toBe(EMAIL);
  });

  it("[OFE-009] 423 ACCOUNT_LOCKED says when sign-in opens again and offers a password reset", async () => {
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await open(startSignIn, PAGES.signIn, signInPath("?next=%2Fbookings.html"), {
      client: fakeClient({
        signIn: async () =>
          Promise.reject(apiError(VelexisError, "ACCOUNT_LOCKED", 423, { details: { lockedUntil } })),
      }),
    });
    fillForm({ email: EMAIL, password: PASSWORD });
    await submit();

    const state = shownState();
    expect(state.getAttribute("data-state")).toBe("account-locked");
    expect(text(state.querySelector('[data-field="title"]'))).toBe(
      "Too many attempts: sign-in is paused for 15 minutes",
    );
    expect(text(state.querySelector('[data-field="hint"]'))).toBe(
      `You can try again after ${formatTimestamp(lockedUntil, "en-GB", "Europe/London")}, or reset your password now.`,
    );
    expect(
      state.querySelector('a[href="/account/forgot-password.html?next=%2Fbookings.html"]'),
    ).not.toBeNull();
  });

  it("[OFE-009] 403 EMAIL_NOT_VERIFIED asks to confirm the address and sends the link again", async () => {
    const { client } = await open(
      startSignIn,
      PAGES.signIn,
      signInPath(`?next=${encodeURIComponent(PRICE_PATH)}`),
      {
        client: fakeClient({
          signIn: async () => Promise.reject(apiError(PermissionError, "EMAIL_NOT_VERIFIED", 403)),
        }),
      },
    );
    fillForm({ email: EMAIL, password: PASSWORD });
    await submit();

    const state = shownState();
    expect(state.getAttribute("data-state")).toBe("email-not-verified");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Confirm your e-mail address first");
    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="resend"]')).click();
    await settle();
    expect(client.auth.resendVerification).toHaveBeenCalledWith({ email: EMAIL, returnPath: PRICE_PATH });
    expect(text(state.querySelector("[data-resend-status]"))).toBe(
      "If your e-mail address still needs confirming, we have sent you a new link.",
    );
  });

  it("[OFE-009] 400 field errors mark the fields with aria-invalid and focus the error summary", async () => {
    await open(startSignIn, PAGES.signIn, signInPath(), {
      client: fakeClient({
        signIn: async () =>
          Promise.reject(
            apiError(ValidationError, "VALIDATION_FAILED", 400, {
              fieldErrors: [{ path: "/email", code: "format", message: "must match format email" }],
            }),
          ),
      }),
    });
    fillForm({ email: "ada@example", password: PASSWORD });
    await submit();

    expect(input("email").getAttribute("aria-invalid")).toBe("true");
    const summary = $("form[data-auth-form] [data-error-summary]");
    expect(summary.hidden).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(text(summary)).toContain("Enter a value in the right format");
    expect(shownState()).toBeNull();
  });

  it("[OFE-009] 429 shows the shared message; another failure shows the request id", async () => {
    const signIn = vi
      .fn()
      .mockRejectedValueOnce(apiError(RateLimitError, "RATE_LIMITED", 429))
      .mockRejectedValueOnce(apiError(ServerError, "INTERNAL_ERROR", 500));
    await open(startSignIn, PAGES.signIn, signInPath(), { client: fakeClient({ signIn }) });
    fillForm({ email: EMAIL, password: PASSWORD });
    await submit();
    expect(shownState().getAttribute("data-state")).toBe("rate-limited");
    expect(text(shownState().querySelector('[data-field="title"]'))).toBe("Busy, try again in a few seconds");

    await submit();
    expect(shownState().getAttribute("data-state")).toBe("unexpected");
    expect(text(shownState())).toContain("req_authpages");
    expect(text(shownState())).toContain("help@demo-travel.example");
  });

  it("[OFE-009] without customer accounts no form is offered", async () => {
    const { client } = await open(startSignIn, PAGES.signIn, signInPath(), { config: NO_ACCOUNTS });
    expect($("[data-auth-content]").hidden).toBe(true);
    expect(shownState().getAttribute("data-state")).toBe("feature-disabled");
    expect(client.auth.signIn).not.toHaveBeenCalled();
  });
});

describe("sign-up page", () => {
  const signUpPath = (/** @type {string} */ query = "") => `/account/sign-up.html${query}`;
  const typeAccount = (/** @type {Record<string, string | boolean>} */ extra = {}) =>
    fillForm({
      firstName: "Ada",
      lastName: "Lovelace",
      email: EMAIL,
      password: PASSWORD,
      termsAccepted: true,
      ...extra,
    });

  it("[OFE-009] signs up with the configuration's terms version and goes on to next when a session opens", async () => {
    const { client, navigate } = await open(
      startSignUp,
      PAGES.signUp,
      signUpPath(`?next=${encodeURIComponent(PRICE_PATH)}`),
    );
    expect(input("marketingConsent").checked).toBe(false);
    typeAccount();
    await submit();

    expect(client.auth.signUp).toHaveBeenCalledTimes(1);
    expect(client.auth.signUp).toHaveBeenCalledWith({
      email: EMAIL,
      password: PASSWORD,
      firstName: "Ada",
      lastName: "Lovelace",
      marketingConsent: false,
      termsVersion: "2026-10-01",
      returnPath: PRICE_PATH,
    });
    expect(navigate).toHaveBeenCalledWith(PRICE_PATH);
  });

  it("[OFE-009] marketing e-mails are an opt-in; without next the account page", async () => {
    const { client, navigate } = await open(startSignUp, PAGES.signUp, signUpPath());
    typeAccount({ marketingConsent: true });
    await submit();
    expect(client.auth.signUp).toHaveBeenCalledWith(expect.objectContaining({ marketingConsent: true }));
    expect(client.auth.signUp.mock.calls[0]?.[0]).not.toHaveProperty("returnPath");
    expect(navigate).toHaveBeenCalledWith("/account/");
  });

  it("[OFE-009] 'Check your e-mail' when the OTA verifies the address before the first sign-in", async () => {
    const { navigate } = await open(startSignUp, PAGES.signUp, signUpPath(), {
      client: fakeClient({
        signUp: async () => ({
          customer: { ...CUSTOMER, status: "pending_verification" },
          session: null,
          emailVerification: {
            policy: "required_before_sign_in",
            verified: false,
            sentTo: "a•••@example.com",
            expiresAt: null,
          },
        }),
      }),
    });
    typeAccount();
    await submit();

    expect(navigate).not.toHaveBeenCalled();
    expect($("[data-auth-content]").hidden).toBe(true);
    const section = $("[data-check-email]");
    expect(section.hidden).toBe(false);
    expect(text(section.querySelector("[data-check-email-text]"))).toBe(
      "We have sent a link to a•••@example.com. Open it to confirm your e-mail address, then sign in.",
    );
    expect(document.activeElement).toBe(section.querySelector("h2"));
  });

  it("[OFE-009] terms and privacy links come from the configuration and must be accepted", async () => {
    const { client } = await open(startSignUp, PAGES.signUp, signUpPath(), {
      config: { ...CONFIG, legal: { ...CONFIG.legal, privacyUrl: "javascript:alert(1)" } },
    });
    const links = Array.from(document.querySelectorAll("[data-legal-links] a"), (link) => [
      text(link),
      link.getAttribute("href"),
      link.getAttribute("target"),
      link.getAttribute("rel"),
    ]);
    // An unsafe address is no link at all.
    expect(links).toEqual([
      ["terms and conditions", "https://demo-travel.example/terms", "_blank", "noopener noreferrer"],
    ]);
    expect(text($("[data-legal-links]"))).toBe(
      "Please read the terms and conditions and the privacy policy (each opens in a new tab).",
    );

    typeAccount({ termsAccepted: false });
    // A submit that bypasses the browser's own check of the box still sends nothing.
    authForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(client.auth.signUp).not.toHaveBeenCalled();
    expect(input("termsAccepted").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe($("form[data-auth-form] [data-error-summary]"));
  });

  it("[OFE-009] the password rules are shown up front from the configuration", async () => {
    await open(startSignUp, PAGES.signUp, signUpPath(), {
      config: {
        ...CONFIG,
        auth: {
          ...CONFIG.auth,
          passwordPolicy: { ...CONFIG.auth.passwordPolicy, minLength: 12, maxLength: 64 },
        },
      },
    });
    const password = input("password");
    expect(password.minLength).toBe(12);
    expect(password.maxLength).toBe(64);
    const rules = $("[data-password-rules]");
    expect(text(rules)).toBe(
      "Use at least 12 characters. Common passwords and passwords found in data breaches are refused.",
    );
    expect(password.getAttribute("aria-describedby")).toBe(rules.id);
  });

  it("[OFE-009] 409 EMAIL_ALREADY_REGISTERED offers sign-in and a password reset, keeping next", async () => {
    await open(startSignUp, PAGES.signUp, signUpPath("?next=%2Fbookings.html"), {
      client: fakeClient({
        signUp: async () =>
          Promise.reject(
            apiError(ConflictError, "EMAIL_ALREADY_REGISTERED", 409, {
              fieldErrors: [{ path: "/email", code: "taken", message: "Already registered" }],
            }),
          ),
      }),
    });
    typeAccount();
    await submit();

    const state = shownState();
    expect(state.getAttribute("data-state")).toBe("already-registered");
    expect(text(state.querySelector('[data-field="title"]'))).toBe(
      "An account with this e-mail address already exists",
    );
    expect(
      Array.from(state.querySelectorAll("[data-state-actions] a"), (link) => [
        text(link),
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Sign in", "/account/sign-in.html?next=%2Fbookings.html"],
      ["Reset your password", "/account/forgot-password.html?next=%2Fbookings.html"],
    ]);
    expect(document.activeElement).toBe(state.querySelector('[data-field="title"]'));
  });

  it("[OFE-009] 422 PASSWORD_TOO_WEAK marks the password with the broken rule and focuses the summary", async () => {
    await open(startSignUp, PAGES.signUp, signUpPath(), {
      client: fakeClient({
        signUp: async () =>
          Promise.reject(
            apiError(ValidationError, "PASSWORD_TOO_WEAK", 422, {
              details: { violations: ["breached"] },
              fieldErrors: [{ path: "/password", code: "too_weak", message: "Too common" }],
            }),
          ),
      }),
    });
    typeAccount();
    await submit();

    const password = input("password");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    const message = document.getElementById(
      String(password.getAttribute("aria-describedby")).split(" ").at(-1) ?? "",
    );
    expect(text(message)).toBe(
      "This password is too common or has appeared in a data breach. Choose another one.",
    );
    const summary = $("form[data-auth-form] [data-error-summary]");
    expect(document.activeElement).toBe(summary);
    // The rules hint stays linked, and no message quotes the password.
    expect(password.getAttribute("aria-describedby")).toContain("sign-up-password-rules");
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it("[OFE-009] an outdated terms version marks the box and forgets the cached configuration", async () => {
    sessionStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ storedAt: Date.now(), config: CONFIG }));
    await open(startSignUp, PAGES.signUp, signUpPath(), {
      client: fakeClient({
        signUp: async () =>
          Promise.reject(
            apiError(ValidationError, "VALIDATION_FAILED", 400, {
              fieldErrors: [{ path: "/termsVersion", code: "outdated", message: "The terms have changed" }],
            }),
          ),
      }),
    });
    typeAccount();
    await submit();

    expect(input("termsAccepted").getAttribute("aria-invalid")).toBe("true");
    expect(text($("form[data-auth-form] [data-error-summary]"))).toContain(
      "The terms have just changed: reload the page to read them, then accept them",
    );
    expect(sessionStorage.getItem(CONFIG_STORAGE_KEY)).toBeNull();
  });

  it("[OFE-009] a signed-in customer goes on at once; without customer accounts no form", async () => {
    const signedIn = await open(startSignUp, PAGES.signUp, signUpPath("?next=%2Fbookings.html"), {
      session: SESSION,
    });
    expect(signedIn.replace).toHaveBeenCalledWith("/bookings.html");

    const off = await open(startSignUp, PAGES.signUp, signUpPath(), { config: NO_ACCOUNTS });
    expect($("[data-auth-content]").hidden).toBe(true);
    expect(shownState().getAttribute("data-state")).toBe("feature-disabled");
    expect(off.client.auth.signUp).not.toHaveBeenCalled();
  });
});

describe("verify page", () => {
  it("[OFE-009 AC1] takes the token out of the address bar with history.replaceState before verifying", async () => {
    const client = fakeClient();
    /** @type {string[]} */
    const addressesAtCall = [];
    client.auth.verifyEmail.mockImplementation(async () => {
      addressesAtCall.push(location.href);
      return {
        customer: { ...CUSTOMER, emailVerified: true },
        verifiedEmail: EMAIL,
        emailChanged: false,
        claimedGuestBookings: 0,
        returnPath: null,
      };
    });
    showPage(PAGES.verify, `/account/verify.html?token=${VERIFY_TOKEN}&utm_source=email`);
    const replaceState = vi.spyOn(history, "replaceState");
    const view = startVerify({ config: CONFIG, client, session: null }, {});
    if (!view) {
      throw new Error("the verify page did not start");
    }
    views.push(view);
    await view.done;
    await settle();

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]?.[2]).toBe("/account/verify.html?utm_source=email");
    expect(location.search).toBe("?utm_source=email");
    expect(location.href).not.toContain(VERIFY_TOKEN);
    // The one call has the token; the address had lost it already.
    expect(client.auth.verifyEmail).toHaveBeenCalledWith({ token: VERIFY_TOKEN });
    expect(addressesAtCall).toHaveLength(1);
    expect(addressesAtCall[0]).not.toContain(VERIFY_TOKEN);
    expect(document.body.innerHTML).not.toContain(VERIFY_TOKEN);
  });

  it("[OFE-009 AC1] the page module takes the token out of the address before boot() and verifies with it", async () => {
    const client = fakeClient();
    const addresses = await loadPageModule(
      PAGES.verify,
      `/account/verify.html?token=${VERIFY_TOKEN}`,
      () => import("../src/pages/account-verify.js"),
      { config: CONFIG, client, session: null },
    );

    // boot() (the page's first request) already ran without the token in the address.
    expect(addresses).toEqual([`${location.origin}/account/verify.html`]);
    expect(location.href).not.toContain(VERIFY_TOKEN);
    expect(client.auth.verifyEmail).toHaveBeenCalledTimes(1);
    expect(client.auth.verifyEmail).toHaveBeenCalledWith({ token: VERIFY_TOKEN });
    expect($("[data-verified]").hidden).toBe(false);
  });

  it("[OFE-009] verify.html and reset-password.html send only the origin as Referer before their module runs", () => {
    for (const file of [PAGES.verify, PAGES.reset]) {
      const children = Array.from(/** @type {Document} */ (pageDocuments[file]).head.children);
      const policies = children.filter((element) => element.matches('meta[name="referrer"]'));
      // `strict-origin`, not `no-referrer`: with it the SDK's same-origin writes would send `Origin: null`.
      expect(
        policies.map((element) => element.getAttribute("content")),
        file,
      ).toEqual(["strict-origin"]);
      const firstRequest = children.findIndex((element) => element.matches("link, script, style, base"));
      expect(firstRequest, file).toBeGreaterThan(-1);
      expect(children.indexOf(/** @type {Element} */ (policies[0])), file).toBeLessThan(firstRequest);
    }
  });

  it("[OFE-009] shows the confirmed address, the claimed guest bookings and the way on", async () => {
    const claimed = fakeClient({
      verifyEmail: async () => ({
        customer: { ...CUSTOMER, emailVerified: true },
        verifiedEmail: EMAIL,
        emailChanged: false,
        claimedGuestBookings: 2,
        returnPath: null,
      }),
    });
    await open(startVerify, PAGES.verify, "/account/verify.html", {
      client: claimed,
      env: { token: VERIFY_TOKEN },
    });
    const done = $("[data-verified]");
    expect(done.hidden).toBe(false);
    expect(text(done.querySelector("h2"))).toBe(`${EMAIL} is confirmed`);
    expect(document.activeElement).toBe(done.querySelector("h2"));
    expect(text(done.querySelector('[data-field="claimed"]'))).toBe(
      "2 earlier bookings made with this address now appear in My bookings.",
    );
    expect(done.querySelector('[data-field="emailChanged"]')?.hasAttribute("hidden")).toBe(true);
    const next = /** @type {HTMLAnchorElement} */ (done.querySelector("a[data-continue]"));
    expect([text(next), next.getAttribute("href")]).toEqual(["Sign in", "/account/sign-in.html"]);

    // A confirmed address change, signed in, without guest bookings.
    const changed = fakeClient({
      verifyEmail: async () => ({
        customer: { ...CUSTOMER, emailVerified: true },
        verifiedEmail: "ada@new.example.com",
        emailChanged: true,
        claimedGuestBookings: 0,
        returnPath: null,
      }),
    });
    await open(startVerify, PAGES.verify, "/account/verify.html", {
      client: changed,
      session: SESSION,
      env: { token: VERIFY_TOKEN },
    });
    expect(text($('[data-verified] [data-field="emailChanged"]'))).toBe(
      "From now on, sign in with ada@new.example.com.",
    );
    expect($('[data-verified] [data-field="claimed"]').closest("p")?.hasAttribute("hidden")).toBe(true);
    const account = /** @type {HTMLAnchorElement} */ ($("[data-verified] a[data-continue]"));
    expect([text(account), account.getAttribute("href")]).toEqual(["Go to my account", "/account/"]);
  });

  it("[OFE-009] an expired or used link offers a new one, sent with resendVerification({ email })", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client } = await open(startVerify, PAGES.verify, "/account/verify.html", {
      client: fakeClient({
        verifyEmail: async () =>
          Promise.reject(
            apiError(ValidationError, "VERIFICATION_TOKEN_INVALID", 400, { details: { reason: "expired" } }),
          ),
      }),
      env: { token: VERIFY_TOKEN },
    });
    // The live region does not announce "Confirming…" after the answer.
    vi.runAllTimers();
    expect(text($("[data-live-region]"))).toBe("");
    vi.useRealTimers();
    expect(shownState().getAttribute("data-state")).toBe("token-expired");
    expect(text(shownState().querySelector('[data-field="title"]'))).toBe("This link has expired");
    expect($("[data-verified]").hidden).toBe(true);
    const resend = $("[data-resend]");
    expect(resend.hidden).toBe(false);
    expect($("[data-resend-email]").hidden).toBe(false);

    fillForm({ email: EMAIL });
    await submit(/** @type {HTMLFormElement} */ ($("form[data-resend-form]")));
    expect(client.auth.resendVerification).toHaveBeenCalledWith({ email: EMAIL });
    const status = $("[data-resend-status]");
    expect(status.hidden).toBe(false);
    expect(text(status)).toBe("If your e-mail address still needs confirming, we have sent you a new link.");

    // A used link, signed in: the API knows the address, so the form asks for none.
    const used = await open(startVerify, PAGES.verify, "/account/verify.html", {
      client: fakeClient({
        verifyEmail: async () =>
          Promise.reject(
            apiError(ValidationError, "VERIFICATION_TOKEN_INVALID", 400, { details: { reason: "used" } }),
          ),
      }),
      session: SESSION,
      env: { token: VERIFY_TOKEN },
    });
    expect(shownState().getAttribute("data-state")).toBe("token-used");
    expect(text(shownState().querySelector('[data-field="hint"]'))).toBe(
      "Your e-mail address may already be confirmed: try to sign in.",
    );
    expect($("[data-resend-email]").hidden).toBe(true);
    await submit(/** @type {HTMLFormElement} */ ($("form[data-resend-form]")));
    expect(used.client.auth.resendVerification).toHaveBeenCalledWith({});
  });

  it("[OFE-009] without a token, or with one of another shape, no request is made and a new link is offered", async () => {
    const missing = await open(startVerify, PAGES.verify, "/account/verify.html");
    expect(missing.client.auth.verifyEmail).not.toHaveBeenCalled();
    expect(shownState().getAttribute("data-state")).toBe("no-token");
    expect($("[data-resend]").hidden).toBe(false);

    const malformed = await open(startVerify, PAGES.verify, "/account/verify.html?token=not-a-token");
    expect(malformed.client.auth.verifyEmail).not.toHaveBeenCalled();
    expect(location.search).toBe("");
    expect(shownState().getAttribute("data-state")).toBe("token-unknown");
  });

  it("[OFE-009] a failure that may pass offers Retry, which verifies with the same token", async () => {
    const verifyEmail = vi
      .fn()
      .mockRejectedValueOnce(apiError(ServerError, "SERVICE_UNAVAILABLE", 503))
      .mockResolvedValueOnce({
        customer: CUSTOMER,
        verifiedEmail: EMAIL,
        emailChanged: false,
        claimedGuestBookings: 0,
        returnPath: null,
      });
    await open(startVerify, PAGES.verify, "/account/verify.html", {
      client: fakeClient({ verifyEmail }),
      env: { token: VERIFY_TOKEN },
    });
    expect(shownState().getAttribute("data-state")).toBe("unavailable");
    /** @type {HTMLButtonElement} */ (shownState().querySelector('[data-action="retry"]')).click();
    await settle();
    expect(verifyEmail).toHaveBeenCalledTimes(2);
    expect(verifyEmail).toHaveBeenLastCalledWith({ token: VERIFY_TOKEN });
    expect($("[data-verified]").hidden).toBe(false);
  });
});

describe("forgot-password page", () => {
  it("[OFE-009] says the same whether or not the address has an account", async () => {
    /** @type {string[]} */
    const answers = [];
    for (const email of [EMAIL, "nobody@example.com"]) {
      const { client } = await open(startForgot, PAGES.forgot, "/account/forgot-password.html");
      fillForm({ email });
      await submit();
      expect(client.auth.requestPasswordReset).toHaveBeenCalledWith({ email });
      expect($("[data-auth-content]").hidden).toBe(true);
      const sent = $("[data-sent]");
      expect(sent.hidden).toBe(false);
      expect(document.activeElement).toBe(sent.querySelector("h2"));
      answers.push(text(sent));
      for (const view of views.splice(0)) {
        view.destroy();
      }
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).toContain("If an account exists for this address, we have sent it a link");
    expect(answers[0]).not.toContain(EMAIL);
  });

  it("[OFE-009] field errors, the shared 429 message, and next kept as returnPath", async () => {
    const requestPasswordReset = vi
      .fn()
      .mockRejectedValueOnce(
        apiError(ValidationError, "VALIDATION_FAILED", 400, {
          fieldErrors: [{ path: "/email", code: "format", message: "must match format email" }],
        }),
      )
      .mockRejectedValueOnce(apiError(RateLimitError, "RATE_LIMITED", 429));
    await open(startForgot, PAGES.forgot, "/account/forgot-password.html?next=%2Fbookings.html", {
      client: fakeClient({ requestPasswordReset }),
    });
    expect($('main a[href^="/account/sign-in.html"]').getAttribute("href")).toBe(
      "/account/sign-in.html?next=%2Fbookings.html",
    );
    fillForm({ email: "ada@example" });
    await submit();
    expect(requestPasswordReset).toHaveBeenCalledWith({ email: "ada@example", returnPath: "/bookings.html" });
    expect(input("email").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe($("form[data-auth-form] [data-error-summary]"));

    await submit();
    expect(shownState().getAttribute("data-state")).toBe("rate-limited");
    expect($("[data-sent]").hidden).toBe(true);
  });
});

describe("reset-password page", () => {
  it("[OFE-009 AC1] takes the token out of the address bar, resets with signIn and goes on signed in", async () => {
    const client = fakeClient();
    showPage(PAGES.reset, `/account/reset-password.html?token=${RESET_TOKEN}`);
    const replaceState = vi.spyOn(history, "replaceState");
    const navigate = vi.fn();
    const view = startReset({ config: CONFIG, client, session: null }, { navigate });
    if (!view) {
      throw new Error("the reset page did not start");
    }
    views.push(view);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]?.[2]).toBe("/account/reset-password.html");
    expect(location.href).not.toContain(RESET_TOKEN);

    fillForm({ newPassword: NEW_PASSWORD });
    await submit();
    expect(client.auth.resetPassword).toHaveBeenCalledWith({
      token: RESET_TOKEN,
      newPassword: NEW_PASSWORD,
      signIn: true,
    });
    // Cookie mode answers `session: null`: the page asks whether a session opened.
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/account/");
    expect(input("newPassword").value).toBe("");
  });

  it("[OFE-009 AC1] the page module takes the token out of the address before boot() and resets with it", async () => {
    // Signed out after the reset: the page stays and says so, so nothing navigates the test window.
    const client = fakeClient({
      getSession: async () => Promise.reject(apiError(AuthenticationError, "UNAUTHENTICATED", 401)),
    });
    const addresses = await loadPageModule(
      PAGES.reset,
      `/account/reset-password.html?token=${RESET_TOKEN}`,
      () => import("../src/pages/account-reset-password.js"),
      { config: CONFIG, client, session: null },
    );

    expect(addresses).toEqual([`${location.origin}/account/reset-password.html`]);
    expect(location.href).not.toContain(RESET_TOKEN);
    fillForm({ newPassword: NEW_PASSWORD });
    await submit();
    expect(client.auth.resetPassword).toHaveBeenCalledWith({
      token: RESET_TOKEN,
      newPassword: NEW_PASSWORD,
      signIn: true,
    });
    expect($("[data-reset-done]").hidden).toBe(false);
  });

  it("[OFE-009] without a session after the reset: 'Your new password is saved' with a sign-in link", async () => {
    const { navigate } = await open(startReset, PAGES.reset, "/account/reset-password.html", {
      client: fakeClient({
        getSession: async () => Promise.reject(apiError(AuthenticationError, "UNAUTHENTICATED", 401)),
      }),
      env: { token: RESET_TOKEN },
    });
    fillForm({ newPassword: NEW_PASSWORD });
    await submit();
    expect(navigate).not.toHaveBeenCalled();
    const done = $("[data-reset-done]");
    expect(done.hidden).toBe(false);
    expect(text(done.querySelector("h2"))).toBe("Your new password is saved");
    expect(done.querySelector('a[href="/account/sign-in.html"]')).not.toBeNull();
  });

  it("[OFE-009] 422 PASSWORD_TOO_WEAK keeps the token for another try; 400 PASSWORD_RESET_TOKEN_INVALID offers a new link", async () => {
    const resetPassword = vi
      .fn()
      .mockRejectedValueOnce(
        apiError(ValidationError, "PASSWORD_TOO_WEAK", 422, {
          details: { violations: ["minLength"] },
          fieldErrors: [{ path: "/newPassword", code: "too_weak", message: "Use at least 10 characters." }],
        }),
      )
      .mockRejectedValueOnce(
        apiError(ValidationError, "PASSWORD_RESET_TOKEN_INVALID", 400, { details: { reason: "expired" } }),
      );
    await open(startReset, PAGES.reset, "/account/reset-password.html", {
      client: fakeClient({ resetPassword }),
      env: { token: RESET_TOKEN },
    });
    fillForm({ newPassword: NEW_PASSWORD });
    await submit();
    const password = input("newPassword");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(text($("form[data-auth-form] [data-error-summary]"))).toContain("This password is too short");
    expect(document.activeElement).toBe($("form[data-auth-form] [data-error-summary]"));

    fillForm({ newPassword: `${NEW_PASSWORD}-longer` });
    await submit();
    expect(resetPassword).toHaveBeenCalledTimes(2);
    expect(resetPassword).toHaveBeenLastCalledWith({
      token: RESET_TOKEN,
      newPassword: `${NEW_PASSWORD}-longer`,
      signIn: true,
    });
    expect($("[data-auth-content]").hidden).toBe(true);
    const state = shownState();
    expect(state.getAttribute("data-state")).toBe("token-invalid");
    expect(text(state.querySelector('[data-field="title"]'))).toBe(
      "This link has expired or has already been used",
    );
    expect(state.querySelector('a[href="/account/forgot-password.html"]')).not.toBeNull();
  });

  it("[OFE-009] without a token no form is offered, only a new link", async () => {
    const { client } = await open(startReset, PAGES.reset, "/account/reset-password.html");
    expect($("[data-auth-content]").hidden).toBe(true);
    expect(shownState().getAttribute("data-state")).toBe("no-token");
    expect(shownState().querySelector('a[href="/account/forgot-password.html"]')).not.toBeNull();
    expect(client.auth.resetPassword).not.toHaveBeenCalled();
  });
});

describe("password fields", () => {
  const STARTS = /** @type {const} */ ([
    [startSignIn, PAGES.signIn, "/account/sign-in.html"],
    [startSignUp, PAGES.signUp, "/account/sign-up.html"],
    [startVerify, PAGES.verify, "/account/verify.html"],
    [startForgot, PAGES.forgot, "/account/forgot-password.html"],
    [startReset, PAGES.reset, "/account/reset-password.html"],
  ]);

  it("[OFE-009 AC3] allow paste and password managers: autocomplete tokens, no paste blocking", async () => {
    /** @type {Record<string, string[]>} */
    const passwordTokens = {};
    for (const [startPage, file, path] of STARTS) {
      // The pages with their modules running: the reset page needs a token to show its form.
      await open(startPage, file, path, { env: file === PAGES.reset ? { token: RESET_TOKEN } : {} });
      const forms = Array.from(document.querySelectorAll("main form"));
      expect(forms.length, file).toBeGreaterThan(0);
      for (const form of forms) {
        // POST without an action: a submit that never reaches the script puts nothing into an address.
        expect(form.getAttribute("method"), file).toBe("post");
        expect(form.hasAttribute("action"), file).toBe(false);
        expect(form.getAttribute("autocomplete"), file).not.toBe("off");
      }
      const controls = /** @type {HTMLInputElement[]} */ (
        Array.from(document.querySelectorAll("main input"))
      );
      for (const control of controls) {
        for (const attribute of ["onpaste", "oncopy", "oncut", "ondrop", "readonly"]) {
          expect(control.hasAttribute(attribute), `${file} ${control.name} ${attribute}`).toBe(false);
        }
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        control.dispatchEvent(paste);
        expect(paste.defaultPrevented, `${file} ${control.name}`).toBe(false);
      }
      for (const email of controls.filter((control) => control.type === "email")) {
        expect(email.getAttribute("autocomplete"), file).toBe("email");
      }
      passwordTokens[file] = controls
        .filter((control) => control.type === "password")
        .map((control) => String(control.getAttribute("autocomplete")));
      for (const view of views.splice(0)) {
        view.destroy();
      }
    }
    expect(passwordTokens).toEqual({
      [PAGES.signIn]: ["current-password"],
      [PAGES.signUp]: ["new-password"],
      [PAGES.verify]: [],
      [PAGES.forgot]: [],
      [PAGES.reset]: ["new-password"],
    });
    // The sign-up form's names are filled by the browser too.
    showPage(PAGES.signUp, "/account/sign-up.html");
    expect(input("firstName").getAttribute("autocomplete")).toBe("given-name");
    expect(input("lastName").getAttribute("autocomplete")).toBe("family-name");
  });
});

describe("account menu", () => {
  /** The header of index.html in the test document, and its account menu slot. */
  const showHeader = () => {
    showPage("index.html", "/search.html?from=PAR");
    const header = /** @type {HTMLElement} */ (document.querySelector("body > header"));
    return { header, slot: /** @type {HTMLElement} */ (header.querySelector('[data-slot="account-menu"]')) };
  };

  it("[OFE-009] signed out: Sign in back to the page; signed in: the first name, My account and Sign out", () => {
    const { header, slot } = showHeader();
    const client = fakeClient();
    const view = mountHeader(header, { config: /** @type {never} */ (CONFIG), session: null, client });
    const signIn = slot.querySelector("a");
    expect(text(signIn)).toBe("Sign in");
    expect(signIn?.getAttribute("href")).toBe("/account/sign-in.html?next=%2Fsearch.html%3Ffrom%3DPAR");
    expect(slot.querySelector('[data-action="sign-out"]')).toBeNull();

    view.update({ session: /** @type {never} */ (SESSION) });
    expect(text(slot.querySelector("[data-customer-name]"))).toBe("Hi, Ada");
    const account = slot.querySelector("a");
    expect([text(account), account?.getAttribute("href")]).toEqual(["My account", "/account/"]);
    const signOut = slot.querySelector('button[data-action="sign-out"]');
    expect(text(signOut)).toBe("Sign out");
    expect(signOut?.getAttribute("type")).toBe("button");
    view.destroy();
  });

  it("[OFE-009] boot() gives the header its client: a signed-in customer gets Sign out on every page", async () => {
    const { boot } = /** @type {typeof import("../src/boot.js")} */ (await vi.importActual("../src/boot.js"));
    const { slot } = showHeader();
    const client = {
      ...fakeClient(),
      storefront: { get: vi.fn(async () => structuredClone(CONFIG)) },
      withOptions: vi.fn(),
    };
    const preferences = { getItem: () => null, setItem: () => undefined };
    const context = await boot({
      client: /** @type {never} */ (client),
      storage: null,
      preferences,
      doc: document,
    });

    expect(context.session).toEqual(SESSION);
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(text(slot.querySelector("[data-customer-name]"))).toBe("Hi, Ada");
    expect(slot.querySelector('button[data-action="sign-out"]')).not.toBeNull();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("[OFE-009] Sign out calls auth.signOut, shows Sign in and goes to the home page", async () => {
    const { slot } = showHeader();
    const client = fakeClient();
    const navigate = vi.fn();
    renderAccountMenu(slot, /** @type {never} */ (SESSION), { client, navigate });
    /** @type {HTMLButtonElement} */ (slot.querySelector('[data-action="sign-out"]')).click();
    await settle();

    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    // Cookie mode: no refresh token in the call; the browser sends the session cookies.
    expect(client.auth.signOut.mock.calls[0]).toEqual([]);
    expect(text(slot.querySelector("a"))).toBe("Sign in");
    expect(slot.querySelector('[data-action="sign-out"]')).toBeNull();
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("[OFE-009] a 401 at sign-out counts as signed out; another failure keeps the menu", async () => {
    const { slot } = showHeader();
    const ended = fakeClient({
      signOut: async () => Promise.reject(apiError(AuthenticationError, "UNAUTHENTICATED", 401)),
    });
    const navigate = vi.fn();
    renderAccountMenu(slot, /** @type {never} */ (SESSION), { client: ended, navigate });
    /** @type {HTMLButtonElement} */ (slot.querySelector('[data-action="sign-out"]')).click();
    await settle();
    expect(text(slot.querySelector("a"))).toBe("Sign in");
    expect(navigate).toHaveBeenCalledWith("/");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failing = fakeClient({
      signOut: async () => Promise.reject(apiError(ServerError, "SERVICE_UNAVAILABLE", 503)),
    });
    const stay = vi.fn();
    renderAccountMenu(slot, /** @type {never} */ (SESSION), { client: failing, navigate: stay });
    const button = /** @type {HTMLButtonElement} */ (slot.querySelector('[data-action="sign-out"]'));
    button.click();
    await settle();
    vi.runAllTimers();
    expect(stay).not.toHaveBeenCalled();
    expect(text(button)).toBe("Sign out");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(text($("[data-live-region]"))).toBe("We could not sign you out. Please try again.");
  });
});

describe("account menu below lg: one compact button (OFE-031, OFE-032)", () => {
  /** The header of index.html with a signed-in customer's menu rendered into its slot. */
  const showSignedIn = (session = SESSION, client = fakeClient()) => {
    showPage("index.html", "/search.html?from=PAR");
    const header = /** @type {HTMLElement} */ (document.querySelector("body > header"));
    const slot = /** @type {HTMLElement} */ (header.querySelector('[data-slot="account-menu"]'));
    const navigate = vi.fn();
    renderAccountMenu(slot, /** @type {never} */ (session), { client, navigate });
    const toggle = /** @type {HTMLButtonElement} */ (slot.querySelector("button[data-account-menu-toggle]"));
    const panel = /** @type {HTMLElement} */ (slot.querySelector("[data-account-menu-panel]"));
    return { header, slot, toggle, panel, client, navigate };
  };
  const expanded = (/** @type {Element} */ toggle) => toggle.getAttribute("aria-expanded");
  /** Presses `key` on `element`; returns whether its default action was prevented. */
  const press = (/** @type {Element} */ element, /** @type {string} */ key) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  };
  /** A control of the page outside the header, focused, as a pointer would leave it. */
  const outsideControl = () => {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = "Elsewhere";
    $("main").append(control);
    return control;
  };
  const classes = (/** @type {Element | null} */ element) => Array.from(element?.classList ?? []);

  it("[OFE-031 AC2] signed in: an Account button in the Sign in link's place, a disclosure of the greeting, My account and Sign out", () => {
    showPage("index.html", "/search.html?from=PAR");
    const slot = $('body > header [data-slot="account-menu"]');
    // From the first paint the slot is as wide as the button below lg, and the navigation is the panel's containing
    // block: the button takes the link's place without moving the row, and the open panel floats under it.
    expect(classes(slot)).toContain("max-lg:min-w-20");
    expect(classes($("body > header nav"))).toContain("relative");
    expect(text(slot)).toBe("Sign in");

    const { toggle, panel } = showSignedIn();
    // One button: "Account" (whatever the name), a disclosure that controls the panel, collapsed.
    expect(toggle.type).toBe("button");
    expect(text(toggle)).toBe("Account");
    expect(expanded(toggle)).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.id).toBe("vx-account-menu");
    expect(toggle.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // Shown below lg only; at least 24 px high (2.5.8), its negative margins keep the row's line height.
    expect(classes(toggle)).toEqual(expect.arrayContaining(["lg:hidden", "min-h-6", "-my-0.5", "peer"]));
    // The panel follows it: hidden below lg until the button is expanded (CSS, `peer-aria-expanded`), then floating
    // under the navigation; from lg the row's inline group, as before.
    expect(toggle.nextElementSibling).toBe(panel);
    expect(classes(panel)).toEqual(
      expect.arrayContaining([
        "max-lg:hidden",
        "max-lg:peer-aria-expanded:flex",
        "max-lg:absolute",
        "max-lg:top-full",
        "max-lg:right-0",
        "max-lg:max-w-full",
        "lg:inline-flex",
      ]),
    );
    expect(Array.from(panel.children, (child) => text(child))).toEqual(["Hi, Ada", "My account", "Sign out"]);
    const account = /** @type {HTMLAnchorElement} */ (panel.querySelector("a"));
    expect(account.getAttribute("href")).toBe("/account/");
    // Both of the panel's controls are at least 24 px high in it.
    expect(classes(account)).toContain("max-lg:min-h-6");
    expect(classes(panel.querySelector('[data-action="sign-out"]'))).toContain("max-lg:min-h-6");
  });

  it("[OFE-031 AC2] signed out: the Sign in link alone, no disclosure", () => {
    const { slot } = showSignedIn();
    renderAccountMenu(slot, null, {});
    expect(Array.from(slot.children, (child) => child.tagName)).toEqual(["A"]);
    expect(text(slot)).toBe("Sign in");
    expect(slot.querySelector("[aria-expanded], [data-account-menu-panel]")).toBeNull();
  });

  it("[OFE-031 AC2] the button opens and closes the panel; Escape closes it and gives the focus back to the button", () => {
    const { toggle, panel } = showSignedIn();
    toggle.click();
    expect(expanded(toggle)).toBe("true");
    toggle.click();
    expect(expanded(toggle)).toBe("false");
    // Escape while closed is left alone.
    expect(press(toggle, "Escape")).toBe(false);

    toggle.click();
    const account = /** @type {HTMLAnchorElement} */ (panel.querySelector("a"));
    account.focus();
    expect(press(account, "Escape")).toBe(true);
    expect(expanded(toggle)).toBe("false");
    expect(document.activeElement).toBe(toggle);
    // Other keys change nothing.
    toggle.click();
    expect(press(toggle, "ArrowDown")).toBe(false);
    expect(expanded(toggle)).toBe("true");
  });

  /**
   * A press on `element` as a browser runs it: `pointerdown`, then the focus moves to `focused` (what the browser
   * focuses: the control pressed, `main` for its text, or nothing), then the click.
   */
  const tap = (/** @type {HTMLElement} */ element, /** @type {HTMLElement | null} */ focused) => {
    element.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    if (focused) {
      focused.focus();
    } else {
      /** @type {HTMLElement | null} */ (document.activeElement)?.blur();
    }
    element.click();
  };

  it("[OFE-031 AC2] a press outside closes the panel: the focus back on the button, unless the press was on another control", () => {
    const { toggle, panel } = showSignedIn();
    toggle.click();
    // A press inside the panel keeps it open.
    tap(/** @type {HTMLElement} */ (panel.querySelector("[data-customer-name]")), toggle);
    expect(expanded(toggle)).toBe("true");

    // A press on the page's text that leaves the focus nowhere: closed, the focus on the button.
    /** @type {HTMLButtonElement} */ (panel.querySelector('[data-action="sign-out"]')).focus();
    tap($("main h1"), null);
    expect(expanded(toggle)).toBe("false");
    expect(document.activeElement).toBe(toggle);

    // The same where the browser focuses `main` (`tabindex="-1"`, focusable by scripts and pointers only), whose
    // focus would close the panel first: the button still gets the focus.
    toggle.click();
    tap($("main h1"), $("main"));
    expect(expanded(toggle)).toBe("false");
    expect(document.activeElement).toBe(toggle);

    // A press on another control: closed, and the focus stays on that control.
    toggle.click();
    const elsewhere = outsideControl();
    tap(elsewhere, elsewhere);
    expect(expanded(toggle)).toBe("false");
    expect(document.activeElement).toBe(elsewhere);
    // A later click on the page does not take it back: the press listeners went with the closed panel.
    $("main h1").click();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("[OFE-031 AC2] a press outside whose click never comes (a touch that scrolls the page) leaves a later click alone", () => {
    const { toggle } = showSignedIn();
    const focus = vi.spyOn(toggle, "focus");
    const pointer = (/** @type {string} */ type) =>
      $("main h1").dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    toggle.click();
    // The touch closes the panel; the browser then turns it into a scroll: `pointercancel`, no click.
    pointer("pointerdown");
    expect(expanded(toggle)).toBe("false");
    pointer("pointercancel");
    // A click on the page long after does not take the focus up to the button.
    $("main h1").click();
    expect(focus).not.toHaveBeenCalled();

    // Nor when the next press begins before the first one's click came.
    toggle.click();
    pointer("pointerdown");
    pointer("pointerdown");
    $("main h1").click();
    expect(focus).not.toHaveBeenCalled();
    expect(expanded(toggle)).toBe("false");
  });

  it("[OFE-031 AC2] Escape closes the open panel wherever the focus is, as when a pressed button does not take it", () => {
    const { toggle } = showSignedIn();
    // Safari, and Firefox on macOS, leave the focus where it was when a pointer presses a button.
    toggle.click();
    /** @type {HTMLElement | null} */ (document.activeElement)?.blur();
    expect(document.activeElement).not.toBe(toggle);
    expect(press(document.body, "Escape")).toBe(true);
    expect(expanded(toggle)).toBe("false");
    expect(document.activeElement).toBe(toggle);
    // Closed, Escape is the page's again.
    expect(press(document.body, "Escape")).toBe(false);
  });

  it("[OFE-031 AC2] the focus leaving the menu closes the panel, so it never covers the focused element; within the menu it stays open", () => {
    const { toggle, panel } = showSignedIn();
    const signOut = /** @type {HTMLButtonElement} */ (panel.querySelector('[data-action="sign-out"]'));
    const leave = (/** @type {Element | null} */ next) =>
      signOut.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: next }));
    toggle.click();
    leave(toggle);
    expect(expanded(toggle)).toBe("true");
    // No next element (another window, a click on the page): the click decides.
    leave(null);
    expect(expanded(toggle)).toBe("true");
    leave(outsideControl());
    expect(expanded(toggle)).toBe("false");
  });

  it("[OFE-031 AC2] Sign out in the panel: auth.signOut, the Sign in link back in the button's place, the home page", async () => {
    const { slot, toggle, panel, client, navigate } = showSignedIn();
    toggle.click();
    /** @type {HTMLButtonElement} */ (panel.querySelector('[data-action="sign-out"]')).click();
    await settle();

    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(Array.from(slot.children, (child) => text(child))).toEqual(["Sign in"]);
    expect(navigate).toHaveBeenCalledWith("/");
    // The signed-in menu's listeners went with it: a later press on the page or Escape does not reach its button.
    const focus = vi.spyOn(toggle, "focus");
    tap($("main h1"), null);
    press(slot, "Escape");
    expect(focus).not.toHaveBeenCalled();
  });

  it("[OFE-031 AC2] a long first name: the greeting holds it whole and wraps in the panel; the button stays 'Account'", () => {
    const firstName = "Maximiliana-Alexandrina Wilhelmina Konstantinopoulou";
    const { toggle, panel } = showSignedIn({ ...SESSION, customer: { ...CUSTOMER, firstName } });
    expect(text(toggle)).toBe("Account");
    const greeting = /** @type {HTMLElement} */ (panel.querySelector("[data-customer-name]"));
    expect(text(greeting)).toBe(`Hi, ${firstName}`);
    // Never cut in the panel: no ellipsis below lg (the cap's classes are lg's only, below), and it breaks anywhere
    // rather than overflowing the panel, which is never wider than the navigation.
    expect(classes(greeting)).toContain("wrap-anywhere");
    expect(classes(greeting)).not.toContain("truncate");
    expect(classes(greeting).filter((name) => /^max-lg:(truncate|max-w-)/.test(name))).toEqual([]);
    expect(classes(panel)).toEqual(expect.arrayContaining(["max-lg:w-max", "max-lg:max-w-full"]));
  });

  /** The media queries Tailwind gives the `lg` breakpoint's variants: below 1024 px, and from 1024 px. */
  const BELOW_LG = "(width < 64rem)";
  const FROM_LG = "(width >= 64rem)";
  /** main.css compiled by Tailwind (its `compile`, as @tailwindcss/vite builds the storefront's CSS). */
  let tailwind = /** @type {{ build: (candidates: string[]) => string } | null} */ (null);

  beforeAll(async () => {
    const styles = join(STOREFRONT_ROOT, "src", "styles");
    const tailwindIndex = createRequire(import.meta.url).resolve("tailwindcss/index.css");
    tailwind = await compileTailwind(readFileSync(join(styles, "main.css"), "utf8"), {
      base: styles,
      loadStylesheet: async (/** @type {string} */ id, /** @type {string} */ base) => {
        const path = id === "tailwindcss" ? tailwindIndex : join(base, id);
        return { path, base: dirname(path), content: readFileSync(path, "utf8") };
      },
    });
  }, 10_000); // reads main.css, fonts.css and Tailwind's stylesheets and compiles them once (about 50 ms here)

  /**
   * The media query that the compiled CSS gives each responsive class (`lg:hidden`, `max-lg:min-w-20`, …) of
   * `elements`, or `null` for a class it does not generate.
   * @param {ReadonlyArray<Element | null>} elements
   * @returns {Record<string, string | null>}
   */
  const mediaQueries = (elements) => {
    const names = [...new Set(elements.flatMap((element) => classes(element)))].filter((name) =>
      /^(max-)?(sm|md|lg|xl|2xl):/.test(name),
    );
    const css = /** @type {NonNullable<typeof tailwind>} */ (tailwind).build(names);
    return Object.fromEntries(
      names.map((name) => {
        // Tailwind's selector: `.max-lg\:py-1\.5`, its rule's first line the variant's media query.
        const selector = `.${name.replace(/[^\w-]/g, (character) => `\\${character}`)}`;
        const escaped = selector.replace(/[\\.]/g, (character) => `\\${character}`);
        return [name, new RegExp(`${escaped} \\{\\s*@media (\\([^)]*\\))`).exec(css)?.[1] ?? null];
      }),
    );
  };

  it("[OFE-032 AC1] [OFE-032 AC2] the breakpoint: below 1024 px the compact button and its panel, from 1024 px the inline links, as Tailwind compiles them", () => {
    const { slot, toggle, panel } = showSignedIn();
    const queries = mediaQueries([slot, toggle, panel, ...Array.from(panel.children)]);
    // Below lg the slot keeps the button's width from the first paint, the button shows and the panel is the
    // disclosure's, floating; from lg the button is hidden and the panel is the row's inline group.
    expect(queries).toMatchObject({
      "max-lg:min-w-20": BELOW_LG,
      "lg:hidden": FROM_LG,
      "max-lg:hidden": BELOW_LG,
      "max-lg:peer-aria-expanded:flex": BELOW_LG,
      "max-lg:absolute": BELOW_LG,
      "lg:inline-flex": FROM_LG,
      "max-lg:min-h-6": BELOW_LG,
      "max-lg:py-1.5": BELOW_LG,
    });
    // Every responsive class of the menu switches at lg and nowhere else (no md left from OFE-031), and lg is 1024 px:
    // a media query's rem is the browser's initial font size, 16 px.
    expect(new Set(Object.values(queries))).toEqual(new Set([BELOW_LG, FROM_LG]));
    expect(Number(/([\d.]+)rem/.exec(BELOW_LG)?.[1]) * 16).toBe(1024);
  });

  it("[FIX-W52-OTA AC2] from lg the greeting is capped at 12rem with an ellipsis, the whole greeting in the DOM and its title; below lg nothing changes", () => {
    // The contract's longest first name (60 characters).
    const firstName = "Maximiliana-Alexandrina Wilhelmina Konstantinopoulou-Papadop";
    expect(firstName).toHaveLength(60);
    const { panel } = showSignedIn({ ...SESSION, customer: { ...CUSTOMER, firstName } });
    const greeting = /** @type {HTMLElement} */ (panel.querySelector("[data-customer-name]"));
    // The whole greeting, as a screen reader reads it and as the title shows it: the cut is CSS's only.
    expect(text(greeting)).toBe(`Hi, ${firstName}`);
    expect(greeting.title).toBe(`Hi, ${firstName}`);
    expect(GREETING_CAP_CLASSES.split(" ")).toEqual(["lg:max-w-48", "lg:truncate"]);
    expect(classes(greeting)).toEqual(expect.arrayContaining(["lg:max-w-48", "lg:truncate"]));
    // Both switch on at 1024 px and only there, as Tailwind compiles them: below lg the panel shows the greeting
    // whole, wrapping (the test above).
    expect(mediaQueries([greeting])).toMatchObject({ "lg:max-w-48": FROM_LG, "lg:truncate": FROM_LG });
    const css = /** @type {NonNullable<typeof tailwind>} */ (tailwind).build(["lg:max-w-48", "lg:truncate"]);
    const rule = (/** @type {string} */ name) =>
      new RegExp(`\\.lg\\\\:${name} \\{\\s*@media \\(width >= 64rem\\) \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    // 12rem: Tailwind's spacing step (0.25rem) times 48, the cap of GREETING_CAP_CLASSES.
    expect(rule("max-w-48")).toMatch(/max-width: calc\(var\(--spacing\) \* 48\);/);
    expect(css).toMatch(/--spacing: 0\.25rem;/);
    expect(rule("truncate")).toMatch(/overflow: hidden;/);
    expect(rule("truncate")).toMatch(/text-overflow: ellipsis;/);
    expect(rule("truncate")).toMatch(/white-space: nowrap;/);
    // A short name gets the same classes and title: the cap only shows on a name longer than it.
    const short = showSignedIn().panel.querySelector("[data-customer-name]");
    expect(short?.getAttribute("title")).toBe("Hi, Ada");
  });
});
