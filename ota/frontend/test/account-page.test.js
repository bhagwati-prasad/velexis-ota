// The account page (ota/frontend/docs/pages-account.md §1 and §6, README §5.2 and §8): account/index.html with its
// partials expanded by the build's include plugin, run by src/pages/account-index.js against a fake SDK in cookie
// mode, and the native dialog of src/components/dialog.js. It covers the profile with `account.update` and `ifMatch`
// (a stale version keeps the typed values and reloads), the e-mail change and the deletion with re-authentication
// (OBE-035's contract: 409, 422, the 429 lockout of `password_attempts`, no `exportData`), the password change, sign
// out everywhere, the account menu after deletion, the redirect of visitors and the absence of saved travellers.
import {
  AuthenticationError,
  ConflictError,
  RateLimitError,
  ServerError,
  ValidationError,
  VelexisError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { mount as mountDialog } from "../src/components/dialog.js";
import { mount as mountHeader } from "../src/components/header.js";
import { formatTimestamp } from "../src/lib/format.js";
import {
  SIGN_IN_TARGET,
  profileRequest,
  profileValues,
  start as startAccount,
} from "../src/pages/account-index.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** What the mocked boot() of the page module resolves with: never, unless a test that imports it afresh sets it. */
const bootMock = vi.hoisted(() => ({ /** @type {object | null} */ context: null }));
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    boot: () => (bootMock.context === null ? new Promise(() => {}) : Promise.resolve(bootMock.context)),
  };
});

const PAGE = "account/index.html";
const PATH = "/account/";
/** Passwords the fake API is typed with; fixtures, not credentials. */
const PASSWORD = "fixture-password-1";
const NEW_PASSWORD = "fixture-new-password-2";
const EMAIL = "ada.lovelace@example.com";
const NEW_EMAIL = "ada.byron@example.com";
const BLOCKING_BOOKINGS = ["bkg_01JACCOUNTBLOCKING1", "bkg_01JACCOUNTBLOCKING2"];

const CONFIG = Object.freeze({
  name: "Demo Travel",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { customerAccounts: true, guestCheckout: true, savedTravelers: false },
  auth: {
    emailVerification: "required_before_checkout",
    passwordPolicy: {
      minLength: 12,
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
});

/** The customer as `account.get` answers it. */
const CUSTOMER = Object.freeze({
  id: "cus_01JACCOUNTPAGECUST01",
  email: EMAIL,
  emailVerified: true,
  emailVerifiedAt: "2026-10-01T08:20:41Z",
  pendingEmail: null,
  firstName: "Ada",
  lastName: "Lovelace",
  phone: { deviceType: "MOBILE", countryCallingCode: "44", number: "7700900123" },
  dateOfBirth: "1990-12-10",
  status: "active",
  marketingConsent: { granted: false, updatedAt: "2026-10-01T08:12:00Z", source: "sign_up" },
  termsAcceptedVersion: "2026-10-01",
  lastSignInAt: "2026-10-02T08:30:00Z",
  createdAt: "2026-10-01T08:12:00Z",
  updatedAt: "2026-10-01T09:05:00Z",
  version: 3,
});
/** A customer session as `auth.getSession` answers it (no token fields). */
const SESSION = Object.freeze({
  customer: CUSTOMER,
  session: { id: "ses_01JACCOUNTPAGESESSION", rememberMe: true, authMethod: "password" },
});
const DELETION = Object.freeze({
  status: "scheduled",
  requestedAt: "2026-10-02T12:00:00Z",
  erasureDueBy: "2026-11-01T12:00:00Z",
  dataExport: null,
  retainedRecords: [],
});

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({
    code,
    message: `${code} from the fake API`,
    status,
    requestId: "req_accountpage",
    ...body,
  });

/** The `429` of a re-authentication lockout (OBE-035): `details.reason`, and `Retry-After` as the SDK reads it. */
const lockedOut = (/** @type {string} */ reason, /** @type {number} */ retryAfterSeconds) =>
  new RateLimitError(
    { code: "RATE_LIMITED", message: "RATE_LIMITED from the fake API", status: 429, details: { reason } },
    { retryAfterSeconds },
  );

/**
 * A fake SDK client in cookie mode: the `account` and `auth` methods of the page, each replaceable, and the deferred
 * account namespaces (which the page must never call).
 * @param {Record<string, Function>} [overrides]
 */
function fakeClient(overrides = {}) {
  /** @type {Record<string, any>} */
  let current = structuredClone(CUSTOMER);
  return {
    account: {
      get: vi.fn(overrides.get ?? (async () => structuredClone(current))),
      update: vi.fn(
        overrides.update ??
          (async (/** @type {Record<string, any>} */ params) => {
            const { ifMatch, currentPassword, email, ...changes } = params;
            void ifMatch;
            void currentPassword;
            current = {
              ...current,
              ...changes,
              ...(email === undefined ? {} : { pendingEmail: email === current.email ? null : email }),
              ...(changes.marketingConsent === undefined
                ? {}
                : { marketingConsent: { ...current.marketingConsent, granted: changes.marketingConsent } }),
              version: current.version + 1,
            };
            return structuredClone(current);
          }),
      ),
      delete: vi.fn(overrides.delete ?? (async () => structuredClone(DELETION))),
      preferences: { get: vi.fn(), update: vi.fn() },
      savedTravelers: { list: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn() },
      dataExports: { create: vi.fn(), get: vi.fn() },
    },
    auth: {
      changePassword: vi.fn(overrides.changePassword ?? (async () => SESSION)),
      signOut: vi.fn(overrides.signOut ?? (async () => undefined)),
      resendVerification: vi.fn(
        overrides.resendVerification ??
          (async () => ({ status: "accepted", message: "Accepted by the fake API" })),
      ),
      getSession: vi.fn(async () => SESSION),
    },
  };
}

/** @type {Browser | undefined} */
let browser;
/** @type {Document | undefined} */
let pageDocument;
/** The test window's address and title before each test. */
const original = { address: "", title: "" };
/** Views started by the current test, destroyed after it. */
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands account/index.html with the build's include plugin and parses it once in a happy-dom browser; each test
  // imports a fresh copy of its body into the test document.
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
  const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, PAGE), "utf8"), {
    path: `/${PAGE}`,
  });
  const page = browser.newPage();
  page.url = `${location.origin}${PATH}`;
  page.content = html;
  pageDocument = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // a file read, the include plugin and one happy-dom browser; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
  if (original.title !== "") {
    document.title = original.title;
  }
  if (original.address !== "") {
    history.replaceState(null, "", original.address);
  }
});

/** Puts a fresh copy of the page's body into the test document at the account page's address. */
function showPage() {
  original.address ||= `${location.pathname}${location.search}`;
  original.title ||= document.title;
  const source = /** @type {Document} */ (pageDocument);
  document.body.replaceChildren(
    ...Array.from(source.body.childNodes, (node) => document.importNode(node, true)),
  );
  document.title = source.title;
  history.replaceState(null, "", PATH);
}

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 80; i += 1) {
    await Promise.resolve();
  }
};

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const form = (/** @type {string} */ name) => /** @type {HTMLFormElement} */ ($(`form[data-${name}-form]`));
const field = (/** @type {string} */ formName, /** @type {string} */ name) =>
  /** @type {HTMLInputElement} */ (form(formName).querySelector(`[name="${name}"]`));
const dialog = () => /** @type {HTMLDialogElement} */ ($("dialog[data-delete-dialog]"));
const shownState = (/** @type {string} */ box) => $(`[data-${box}-state] [data-state]`);
const shownNotice = (/** @type {string} */ box) => $(`[data-${box}-state] [data-notice]`);
const menu = () => $('body > header [data-slot="account-menu"]');

/**
 * Fills the profile form's controls by name.
 * @param {string} formName
 * @param {Record<string, string | boolean>} values
 */
function fill(formName, values) {
  for (const [name, value] of Object.entries(values)) {
    const control = field(formName, name);
    if (typeof value === "boolean") {
      control.checked = value;
    } else {
      control.value = value;
    }
  }
}

/** Submits a form the way its submit button does. */
async function submit(/** @type {string} */ formName) {
  const target = form(formName);
  target.requestSubmit(/** @type {HTMLButtonElement} */ (target.querySelector('button[type="submit"]')));
  await settle();
}

/**
 * Opens the page and starts its module with a fake SDK.
 * @param {{ config?: object, session?: object | null, client?: ReturnType<typeof fakeClient> }} [options]
 */
async function open({ config = CONFIG, session = SESSION, client = fakeClient() } = {}) {
  showPage();
  const navigate = vi.fn();
  const replace = vi.fn();
  const view = startAccount(/** @type {never} */ ({ config, client, session }), { navigate, replace });
  if (!view) {
    throw new Error(`${PAGE} did not start`);
  }
  views.push(view);
  await view.done;
  await settle();
  return { client, navigate, replace, view };
}

describe("profile", () => {
  it("[OFE-010] reads the account with account.get and fills the profile, the address and the password rules", async () => {
    const { client } = await open();
    expect(client.account.get).toHaveBeenCalledTimes(1);
    expect($("[data-account-content]").hidden).toBe(false);
    expect($("[data-account-loading]").hidden).toBe(true);
    expect(field("profile", "firstName").value).toBe("Ada");
    expect(field("profile", "lastName").value).toBe("Lovelace");
    expect(field("profile", "dateOfBirth").value).toBe("1990-12-10");
    expect(field("profile", "phone.countryCallingCode").value).toBe("+44");
    expect(field("profile", "phone.number").value).toBe("7700900123");
    expect(field("profile", "marketingConsent").checked).toBe(false);
    expect(text($('[data-field="email"]'))).toBe(EMAIL);
    expect(text($("[data-email-status]"))).toBe("(confirmed)");
    expect($("[data-verify-banner]").hidden).toBe(true);
    // The OTA's password rules up front; no data export is offered, the support address is.
    expect(text($("[data-password-rules]"))).toBe(
      "Use at least 12 characters. Common passwords and passwords found in data breaches are refused.",
    );
    expect(field("password", "newPassword").minLength).toBe(12);
    expect(text($("[data-export-note]"))).toBe(
      "If you would like a copy of your data, write to help@demo-travel.example before you delete your account.",
    );
  });

  it("[OFE-010] Save sends only the changed fields with ifMatch the displayed version", async () => {
    const { client } = await open();
    fill("profile", {
      firstName: " Augusta Ada ",
      "phone.countryCallingCode": "+1",
      "phone.number": "202 555-0143",
      marketingConsent: true,
    });
    await submit("profile");

    expect(client.account.update).toHaveBeenCalledTimes(1);
    expect(client.account.update).toHaveBeenCalledWith({
      ifMatch: 3,
      firstName: "Augusta Ada",
      phone: { deviceType: "MOBILE", countryCallingCode: "+1", number: "2025550143" },
      marketingConsent: true,
    });
    expect(text(shownNotice("profile"))).toBe("Your profile is saved");
    expect(field("profile", "firstName").value).toBe("Augusta Ada");

    // The saved version is the new baseline: nothing changed, nothing sent; the next change carries version 4.
    await submit("profile");
    expect(client.account.update).toHaveBeenCalledTimes(1);
    expect(text(shownNotice("profile"))).toBe("There is nothing new to save");
    fill("profile", { "phone.countryCallingCode": "", "phone.number": "", dateOfBirth: "" });
    await submit("profile");
    expect(client.account.update).toHaveBeenLastCalledWith({ ifMatch: 4, dateOfBirth: null, phone: null });
  });

  it("[OFE-010 AC1] a stale version shows 'updated elsewhere, reload' and keeps the typed values", async () => {
    const client = fakeClient({
      update: async () => Promise.reject(apiError(VelexisError, "PRECONDITION_FAILED", 412)),
    });
    await open({ client });
    fill("profile", { firstName: "Augusta", "phone.number": "7700900999", marketingConsent: true });
    await submit("profile");

    expect(client.account.update).toHaveBeenCalledWith({
      ifMatch: 3,
      firstName: "Augusta",
      phone: { deviceType: "MOBILE", countryCallingCode: "+44", number: "7700900999" },
      marketingConsent: true,
    });
    const state = shownState("profile");
    expect(state.getAttribute("data-state")).toBe("stale");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Your profile was updated elsewhere");
    expect(text(state.querySelector('[data-field="hint"]'))).toBe(
      "Reload to see the latest version. What you typed stays in the form.",
    );
    expect(document.activeElement).toBe(state.querySelector('[data-field="title"]'));
    // The typed values stay in the form.
    expect(field("profile", "firstName").value).toBe("Augusta");
    expect(field("profile", "phone.number").value).toBe("7700900999");
    expect(field("profile", "marketingConsent").checked).toBe(true);

    // Reload: the latest version, its values for the untouched fields, the typed ones kept.
    client.account.get.mockImplementationOnce(async () => ({
      ...structuredClone(CUSTOMER),
      lastName: "King",
      dateOfBirth: null,
      version: 5,
    }));
    client.account.update.mockImplementation(async (/** @type {any} */ params) => ({
      ...structuredClone(CUSTOMER),
      lastName: "King",
      firstName: params.firstName,
      version: 6,
    }));
    const reload = /** @type {HTMLButtonElement} */ (state.querySelector('button[data-action="reload"]'));
    expect(text(reload)).toBe("Reload");
    reload.click();
    await settle();

    expect(client.account.get).toHaveBeenCalledTimes(2);
    expect(field("profile", "firstName").value).toBe("Augusta");
    expect(field("profile", "phone.number").value).toBe("7700900999");
    expect(field("profile", "marketingConsent").checked).toBe(true);
    expect(field("profile", "lastName").value).toBe("King");
    expect(field("profile", "dateOfBirth").value).toBe("");
    expect(text(shownNotice("profile"))).toBe(
      "We loaded the latest version of your profile and kept what you typed. Check it, then save again.",
    );
    await submit("profile");
    expect(client.account.update).toHaveBeenLastCalledWith({
      ifMatch: 5,
      firstName: "Augusta",
      phone: { deviceType: "MOBILE", countryCallingCode: "+44", number: "7700900999" },
      marketingConsent: true,
    });
  });

  it("[OFE-010] the API's field errors mark the fields and focus the summary; the form's own checks send nothing", async () => {
    const client = fakeClient({
      update: async () =>
        Promise.reject(
          apiError(ValidationError, "VALIDATION_FAILED", 400, {
            fieldErrors: [
              { path: "/dateOfBirth", code: "in_future", message: "The date of birth is in the future." },
              { path: "/phone/number", code: "pattern", message: "digits only" },
            ],
          }),
        ),
    });
    await open({ client });
    fill("profile", { "phone.number": "7700900124" });
    await submit("profile");

    const dateOfBirth = field("profile", "dateOfBirth");
    expect(dateOfBirth.getAttribute("aria-invalid")).toBe("true");
    expect(text(document.getElementById(String(dateOfBirth.getAttribute("aria-describedby"))))).toBe(
      "The date of birth cannot be in the future",
    );
    expect(field("profile", "phone.number").getAttribute("aria-invalid")).toBe("true");
    const summary = $("form[data-profile-form] [data-error-summary]");
    expect(summary.hidden).toBe(false);
    expect(document.activeElement).toBe(summary);

    // A blank name and half a phone number are caught before any request.
    client.account.update.mockClear();
    fill("profile", { lastName: "   ", "phone.countryCallingCode": "+44", "phone.number": "" });
    await submit("profile");
    expect(client.account.update).not.toHaveBeenCalled();
    expect(field("profile", "lastName").getAttribute("aria-invalid")).toBe("true");
    expect(field("profile", "phone.number").getAttribute("aria-invalid")).toBe("true");
  });

  it("[OFE-010] a session that ended meanwhile offers sign-in and keeps what was typed", async () => {
    const client = fakeClient({
      update: async () => Promise.reject(apiError(AuthenticationError, "UNAUTHENTICATED", 401)),
    });
    const { replace } = await open({ client });
    fill("profile", { firstName: "Augusta" });
    await submit("profile");
    const state = shownState("profile");
    expect(state.getAttribute("data-state")).toBe("session-ended");
    expect(state.querySelector("[data-state-actions] a")?.getAttribute("href")).toBe(SIGN_IN_TARGET);
    expect(field("profile", "firstName").value).toBe("Augusta");
    expect(replace).not.toHaveBeenCalled();
  });

  it("[OFE-010] profileRequest compares the phone without separators and refuses a malformed one", () => {
    const baseline = profileValues(/** @type {never} */ (CUSTOMER));
    expect(
      profileRequest(
        { ...baseline, "phone.number": "7700 900-123", "phone.countryCallingCode": "44" },
        baseline,
      ),
    ).toEqual({ changes: {}, problems: [] });
    expect(profileRequest({ ...baseline, "phone.countryCallingCode": "+44x" }, baseline).problems).toEqual([
      { path: "/phone/countryCallingCode", code: "pattern" },
    ]);
  });

  it("[FIX-W30-OTA AC1] profileRequest takes the US's calling code 1 and refuses four digits, as the contract does", () => {
    const baseline = profileValues(/** @type {never} */ (CUSTOMER));
    expect(
      profileRequest(
        { ...baseline, "phone.countryCallingCode": "1", "phone.number": "202 555 0143" },
        baseline,
      ),
    ).toEqual({
      changes: { phone: { deviceType: "MOBILE", countryCallingCode: "+1", number: "2025550143" } },
      problems: [],
    });
    expect(profileRequest({ ...baseline, "phone.countryCallingCode": "+1234" }, baseline).problems).toEqual([
      { path: "/phone/countryCallingCode", code: "pattern" },
    ]);
  });
});

describe("visitors and failures", () => {
  it("[OFE-010] a visitor goes to sign-in with next=/account/; so does a 401 of account.get", async () => {
    const visitor = await open({ session: null });
    expect(visitor.replace).toHaveBeenCalledWith(SIGN_IN_TARGET);
    expect(visitor.client.account.get).not.toHaveBeenCalled();
    const target = new URL(SIGN_IN_TARGET, location.origin);
    expect(target.pathname).toBe("/account/sign-in.html");
    expect(target.searchParams.get("next")).toBe("/account/");

    const ended = await open({
      client: fakeClient({
        get: async () => Promise.reject(apiError(AuthenticationError, "UNAUTHENTICATED", 401)),
      }),
    });
    expect(ended.replace).toHaveBeenCalledWith(SIGN_IN_TARGET);
  });

  it("[OFE-010] without customer accounts the page says so and reads nothing", async () => {
    const { client, replace } = await open({
      config: { ...CONFIG, features: { ...CONFIG.features, customerAccounts: false } },
      session: null,
    });
    expect(shownState("account").getAttribute("data-state")).toBe("feature-disabled");
    expect($("[data-account-content]").hidden).toBe(true);
    expect(client.account.get).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("[OFE-010] a failed account.get shows its state with Retry, which reads the account again", async () => {
    const client = fakeClient();
    client.account.get.mockImplementationOnce(async () =>
      Promise.reject(apiError(ServerError, "INTERNAL_ERROR", 500)),
    );
    await open({ client });
    const state = shownState("account");
    expect(state.getAttribute("data-state")).toBe("unexpected");
    expect(text(state.querySelector('[data-field="requestId"]'))).toBe("req_accountpage");
    expect($("[data-account-content]").hidden).toBe(true);

    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]')).click();
    await settle();
    expect(client.account.get).toHaveBeenCalledTimes(2);
    expect($("[data-account-content]").hidden).toBe(false);
    expect(shownState("account")).toBeNull();
  });

  it("[OFE-010] saved travellers and preferences are not offered", async () => {
    const { client } = await open();
    expect(document.querySelector('main a[href*="traveller"], main a[href*="traveler"]')).toBeNull();
    expect(text($("main"))).not.toMatch(/saved travel/i);
    for (const method of [
      client.account.preferences.get,
      client.account.preferences.update,
      ...Object.values(client.account.savedTravelers),
      ...Object.values(client.account.dataExports),
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("[OFE-010] the page module starts with boot()'s context", async () => {
    showPage();
    const client = fakeClient();
    bootMock.context = { config: CONFIG, session: SESSION, client };
    vi.resetModules();
    try {
      await import("../src/pages/account-index.js");
      await settle();
    } finally {
      bootMock.context = null;
    }
    expect(client.account.get).toHaveBeenCalledTimes(1);
    expect(field("profile", "firstName").value).toBe("Ada");
  });
});

describe("e-mail address", () => {
  it("[OFE-010] an unconfirmed address shows the banner; Send the link again asks without an address", async () => {
    const client = fakeClient({ get: async () => ({ ...structuredClone(CUSTOMER), emailVerified: false }) });
    await open({ client });
    expect($("[data-verify-banner]").hidden).toBe(false);
    expect(text($("[data-verify-title]"))).toBe("Confirm your e-mail address");
    expect(text($("[data-verify-text]"))).toBe(
      `We sent a link to ${EMAIL}. Open it to confirm your address.`,
    );
    expect(text($("[data-email-status]"))).toBe("(not confirmed yet)");

    $('[data-action="resend-verification"]').click();
    await settle();
    expect(client.auth.resendVerification).toHaveBeenCalledWith({ returnPath: "/account/" });
    expect(text($("[data-resend-status]"))).toBe(
      "If your e-mail address still needs confirming, we have sent you a new link.",
    );
  });

  it("[OFE-010] changes the address with the current password; sign-in keeps the old one until the link is opened", async () => {
    const { client } = await open();
    fill("profile", { firstName: "Augusta" });
    fill("email", { email: ` ${NEW_EMAIL} `, currentPassword: PASSWORD });
    await submit("email");

    expect(client.account.update).toHaveBeenCalledWith({
      ifMatch: 3,
      email: NEW_EMAIL,
      currentPassword: PASSWORD,
    });
    expect(text(shownNotice("email"))).toBe(`We sent a link to ${NEW_EMAIL}. Open it to finish the change.`);
    expect(text($("[data-verify-title]"))).toBe("Confirm your new e-mail address");
    expect(text($("[data-verify-text]"))).toBe(
      `We sent a link to ${NEW_EMAIL}. Until you open it, you sign in with ${EMAIL}.`,
    );
    expect(text($('[data-field="email"]'))).toBe(EMAIL);
    // The password does not stay in the form; an unsaved profile change does.
    expect(field("email", "currentPassword").value).toBe("");
    expect(field("profile", "firstName").value).toBe("Augusta");

    // The current address again, while no change is pending, is caught before any request.
    client.account.update.mockClear();
    client.account.get.mockImplementationOnce(async () => structuredClone(CUSTOMER));
    await open({ client });
    fill("email", { email: EMAIL.toUpperCase(), currentPassword: PASSWORD });
    await submit("email");
    expect(client.account.update).not.toHaveBeenCalled();
    expect(
      text(document.getElementById(String(field("email", "email").getAttribute("aria-describedby")))),
    ).toBe("This is already the address you sign in with");
  });

  it("[OFE-010] 409 EMAIL_ALREADY_REGISTERED and 422 CURRENT_PASSWORD_INCORRECT mark their fields", async () => {
    const client = fakeClient({
      update: async () =>
        Promise.reject(
          apiError(ConflictError, "EMAIL_ALREADY_REGISTERED", 409, {
            fieldErrors: [{ path: "/email", code: "taken", message: "Already registered" }],
          }),
        ),
    });
    await open({ client });
    fill("email", { email: NEW_EMAIL, currentPassword: PASSWORD });
    await submit("email");
    const email = field("email", "email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(text(document.getElementById(String(email.getAttribute("aria-describedby"))))).toBe(
      "An account with this e-mail address already exists",
    );
    expect(document.activeElement).toBe($("form[data-email-form] [data-error-summary]"));

    client.account.update.mockImplementation(async () =>
      Promise.reject(
        apiError(ValidationError, "CURRENT_PASSWORD_INCORRECT", 422, {
          fieldErrors: [
            { path: "/currentPassword", code: "incorrect", message: "Your current password is not correct." },
          ],
        }),
      ),
    );
    await submit("email");
    const password = field("email", "currentPassword");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(text(document.getElementById(String(password.getAttribute("aria-describedby"))))).toBe(
      "This is not your current password",
    );
    expect(email.hasAttribute("aria-invalid")).toBe(false);
  });

  it("[OFE-010] 429 password_attempts says how long to wait with a reset link; verification_email asks to wait", async () => {
    const client = fakeClient({ update: async () => Promise.reject(lockedOut("password_attempts", 540)) });
    await open({ client });
    fill("email", { email: NEW_EMAIL, currentPassword: PASSWORD });
    await submit("email");
    const state = shownState("email");
    expect(state.getAttribute("data-state")).toBe("password-attempts");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Too many wrong passwords");
    expect(text(state.querySelector('[data-field="hint"]'))).toBe(
      "Try again in 9 minutes, or reset your password.",
    );
    expect(state.querySelector('a[href="/account/forgot-password.html"]')).not.toBeNull();

    client.account.update.mockImplementation(async () => Promise.reject(lockedOut("verification_email", 40)));
    await submit("email");
    expect(shownState("email").getAttribute("data-state")).toBe("link-just-sent");
    expect(text(shownState("email").querySelector('[data-field="hint"]'))).toBe(
      "Wait a minute before asking for another one.",
    );
  });
});

describe("password", () => {
  it("[OFE-010] changes the password with auth.changePassword and clears both fields", async () => {
    const { client } = await open();
    fill("password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    await submit("password");
    expect(client.auth.changePassword).toHaveBeenCalledWith({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      signOutOtherSessions: true,
    });
    expect(text(shownNotice("password").querySelector('[data-field="title"]'))).toBe(
      "Your password is changed",
    );
    expect(text(shownNotice("password").querySelector('[data-field="hint"]'))).toBe(
      "You are signed out on your other devices.",
    );
    expect(field("password", "currentPassword").value).toBe("");
    expect(field("password", "newPassword").value).toBe("");

    fill("password", { currentPassword: NEW_PASSWORD, newPassword: PASSWORD, signOutOtherSessions: false });
    await submit("password");
    expect(client.auth.changePassword).toHaveBeenLastCalledWith({
      currentPassword: NEW_PASSWORD,
      newPassword: PASSWORD,
      signOutOtherSessions: false,
    });
    expect(text(shownNotice("password"))).toBe("Your password is changed");
  });

  it("[OFE-010] a wrong current password, a weak new one and 423 ACCOUNT_LOCKED", async () => {
    const client = fakeClient({
      changePassword: async () =>
        Promise.reject(
          apiError(ValidationError, "CURRENT_PASSWORD_INCORRECT", 422, {
            fieldErrors: [{ path: "/currentPassword", code: "incorrect", message: "not correct" }],
          }),
        ),
    });
    await open({ client });
    fill("password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    await submit("password");
    expect(field("password", "currentPassword").getAttribute("aria-invalid")).toBe("true");

    client.auth.changePassword.mockImplementation(async () =>
      Promise.reject(
        apiError(ValidationError, "PASSWORD_TOO_WEAK", 422, {
          details: { violations: ["sameAsCurrent"] },
          fieldErrors: [{ path: "/newPassword", code: "too_weak", message: "same as the current one" }],
        }),
      ),
    );
    await submit("password");
    const next = field("password", "newPassword");
    expect(next.getAttribute("aria-invalid")).toBe("true");
    expect(
      text(document.getElementById(String(next.getAttribute("aria-describedby")).split(" ").at(-1) ?? "")),
    ).toBe("Choose a password different from your current one");
    // The rules stay linked to the field.
    expect(String(next.getAttribute("aria-describedby")).split(" ")[0]).toBe("account-password-rules");

    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    client.auth.changePassword.mockImplementation(async () =>
      Promise.reject(apiError(VelexisError, "ACCOUNT_LOCKED", 423, { details: { lockedUntil } })),
    );
    await submit("password");
    const state = shownState("password");
    expect(state.getAttribute("data-state")).toBe("account-locked");
    expect(text(state.querySelector('[data-field="hint"]'))).toBe(
      `You can try again after ${formatTimestamp(lockedUntil, "en-GB", "Europe/London")}, or reset your password now.`,
    );
  });
});

describe("signing out", () => {
  it("[OFE-010] Sign out everywhere calls auth.signOut({ scope: 'all' }), shows Sign in and goes to /", async () => {
    const { client, navigate } = await open();
    mountHeader(/** @type {HTMLElement} */ ($("body > header")), {
      config: /** @type {never} */ (CONFIG),
      session: /** @type {never} */ (SESSION),
      client,
    });
    expect(text(menu().querySelector("[data-customer-name]"))).toBe("Hi, Ada");

    $('[data-action="sign-out-all"]').click();
    await settle();
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "all" });
    expect(text(menu().querySelector("a"))).toBe("Sign in");
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("[OFE-010] Sign out ends this session only; a 401 counts as signed out, another failure keeps the page", async () => {
    const { client, navigate } = await open();
    $('[data-action="sign-out-current"]').click();
    await settle();
    expect(client.auth.signOut.mock.calls[0]).toEqual([]);
    expect(navigate).toHaveBeenCalledWith("/");

    const ended = await open({
      client: fakeClient({
        signOut: async () => Promise.reject(apiError(AuthenticationError, "UNAUTHENTICATED", 401)),
      }),
    });
    $('[data-action="sign-out-all"]').click();
    await settle();
    expect(ended.navigate).toHaveBeenCalledWith("/");

    const failing = await open({
      client: fakeClient({
        signOut: async () => Promise.reject(apiError(ServerError, "INTERNAL_ERROR", 500)),
      }),
    });
    const button = $('[data-action="sign-out-all"]');
    button.click();
    await settle();
    expect(failing.navigate).not.toHaveBeenCalled();
    expect(text(shownState("sessions").querySelector('[data-field="title"]'))).toBe(
      "We could not sign you out. Please try again.",
    );
    expect(text(button)).toBe("Sign out everywhere");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("account deletion", () => {
  it("[OFE-010] opens a native dialog that asks for the password; Keep my account closes it and forgets the password", async () => {
    const { client } = await open();
    const opener = $('[data-action="open-delete"]');
    opener.focus();
    opener.click();
    expect(dialog().open).toBe(true);
    expect(dialog().getAttribute("aria-labelledby")).toBe("account-delete-dialog-title");
    const password = field("delete", "currentPassword");
    expect(document.activeElement).toBe(password);
    expect(password.getAttribute("autocomplete")).toBe("current-password");

    password.value = PASSWORD;
    /** @type {HTMLButtonElement} */ (dialog().querySelector("[data-dialog-close]")).click();
    expect(dialog().open).toBe(false);
    expect(password.value).toBe("");
    expect(document.activeElement).toBe(opener);
    expect(client.account.delete).not.toHaveBeenCalled();
  });

  it("[OFE-010 AC2] after deletion the account menu shows Sign in and the page goes to / signed out", async () => {
    const { client, replace } = await open();
    mountHeader(/** @type {HTMLElement} */ ($("body > header")), {
      config: /** @type {never} */ (CONFIG),
      session: /** @type {never} */ (SESSION),
      client,
    });
    expect(text(menu().querySelector("a"))).toBe("My account");

    $('[data-action="open-delete"]').click();
    fill("delete", { currentPassword: PASSWORD, reason: "no_longer_needed" });
    await submit("delete");

    // Re-authenticated with the password; no data export is asked for (exports are deferred).
    expect(client.account.delete).toHaveBeenCalledTimes(1);
    expect(client.account.delete).toHaveBeenCalledWith({
      currentPassword: PASSWORD,
      reason: "no_longer_needed",
    });
    expect(dialog().open).toBe(false);
    expect(field("delete", "currentPassword").value).toBe("");
    expect(text(menu().querySelector("a"))).toBe("Sign in");
    expect(menu().querySelector('[data-action="sign-out"]')).toBeNull();
    expect(menu().querySelector("[data-customer-name]")).toBeNull();
    expect($("[data-account-content]").hidden).toBe(true);
    expect(text($("[data-account-state] [data-notice]"))).toBe("Your account is deleted");
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("[OFE-010] without a reason only the password is sent; Escape does nothing while the deletion runs", async () => {
    /** @type {(value: unknown) => void} */
    let finish = () => undefined;
    const client = fakeClient({ delete: () => new Promise((resolve) => (finish = resolve)) });
    const { replace } = await open({ client });
    $('[data-action="open-delete"]').click();
    fill("delete", { currentPassword: PASSWORD });
    await submit("delete");
    expect(client.account.delete).toHaveBeenCalledWith({ currentPassword: PASSWORD });

    const escape = new Event("cancel", { cancelable: true });
    dialog().dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    /** @type {HTMLButtonElement} */ (dialog().querySelector("[data-dialog-close]")).click();
    expect(dialog().open).toBe(true);
    expect(dialog().getAttribute("aria-busy")).toBe("true");

    finish(structuredClone(DELETION));
    await settle();
    expect(dialog().open).toBe(false);
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("[OFE-010] a dialog the browser closed while the deletion ran opens again to show why it failed", async () => {
    /** @type {(error: unknown) => void} */
    let refuse = () => undefined;
    const client = fakeClient({ delete: () => new Promise((_resolve, reject) => (refuse = reject)) });
    const { replace } = await open({ client });
    $('[data-action="open-delete"]').click();
    fill("delete", { currentPassword: PASSWORD });
    await submit("delete");
    expect(client.account.delete).toHaveBeenCalledTimes(1);
    // A repeated Escape: the browser closes the modal dialog although its first `cancel` was cancelled.
    dialog().close();
    expect(dialog().open).toBe(false);

    refuse(
      apiError(ConflictError, "ACCOUNT_DELETION_BLOCKED", 409, {
        details: { bookingIds: BLOCKING_BOOKINGS },
      }),
    );
    await settle();
    expect(dialog().open).toBe(true);
    const state = shownState("delete");
    expect(state.getAttribute("data-state")).toBe("deletion-blocked");
    expect(document.activeElement).toBe(state.querySelector('[data-field="title"]'));
    expect(replace).not.toHaveBeenCalled();
  });

  it("[OFE-010] 409 ACCOUNT_DELETION_BLOCKED names the bookings and the support contact; the dialog stays open", async () => {
    const client = fakeClient({
      delete: async () =>
        Promise.reject(
          apiError(ConflictError, "ACCOUNT_DELETION_BLOCKED", 409, {
            details: { bookingIds: [...BLOCKING_BOOKINGS, "not a booking id"] },
          }),
        ),
    });
    const { replace } = await open({ client });
    $('[data-action="open-delete"]').click();
    fill("delete", { currentPassword: PASSWORD });
    await submit("delete");

    expect(dialog().open).toBe(true);
    const state = shownState("delete");
    expect(state.getAttribute("data-state")).toBe("deletion-blocked");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Your account cannot be deleted yet");
    expect(
      Array.from(state.querySelectorAll("[data-state-actions] a"), (link) => link.getAttribute("href")),
    ).toEqual(BLOCKING_BOOKINGS.map((id) => `/booking.html?id=${id}`));
    expect(text(state.querySelector('[data-field="supportEmail"]'))).toBe("help@demo-travel.example");
    expect(replace).not.toHaveBeenCalled();
  });

  it("[OFE-010] a wrong password marks the field; 429 password_attempts links the password reset", async () => {
    const client = fakeClient({
      delete: async () =>
        Promise.reject(
          apiError(ValidationError, "CURRENT_PASSWORD_INCORRECT", 422, {
            fieldErrors: [{ path: "/currentPassword", code: "incorrect", message: "not correct" }],
          }),
        ),
    });
    await open({ client });
    $('[data-action="open-delete"]').click();
    fill("delete", { currentPassword: PASSWORD });
    await submit("delete");
    expect(field("delete", "currentPassword").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe($("form[data-delete-form] [data-error-summary]"));

    client.account.delete.mockImplementation(async () => Promise.reject(lockedOut("password_attempts", 60)));
    await submit("delete");
    const state = shownState("delete");
    expect(state.getAttribute("data-state")).toBe("password-attempts");
    expect(text(state.querySelector('[data-field="hint"]'))).toBe(
      "Try again in 1 minute, or reset your password.",
    );
    expect(state.querySelector('a[href="/account/forgot-password.html"]')).not.toBeNull();
    expect(dialog().open).toBe(true);
  });
});

describe("forms", () => {
  it("[OFE-010] password fields allow paste and password managers; forms post without an action", async () => {
    await open();
    for (const target of Array.from(document.querySelectorAll("main form"))) {
      expect(target.getAttribute("method")).toBe("post");
      expect(target.hasAttribute("action")).toBe(false);
    }
    const passwords = /** @type {HTMLInputElement[]} */ (
      Array.from(document.querySelectorAll('main input[type="password"]'))
    );
    expect(passwords.map((input) => input.getAttribute("autocomplete"))).toEqual([
      "current-password",
      "current-password",
      "new-password",
      "current-password",
    ]);
    for (const input of passwords) {
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      input.dispatchEvent(paste);
      expect(paste.defaultPrevented).toBe(false);
    }
    expect(field("profile", "firstName").getAttribute("autocomplete")).toBe("given-name");
    expect(field("profile", "lastName").getAttribute("autocomplete")).toBe("family-name");
    expect(field("email", "email").getAttribute("autocomplete")).toBe("email");
  });

  it("[OFE-010] components/dialog.js: Escape and close buttons close it unless busy; onClose once per close", () => {
    showPage();
    const element = dialog();
    const onClose = vi.fn();
    const view = mountDialog(element, { onClose });
    views.push(view);
    view.open(null);
    expect(view.isOpen()).toBe(true);
    view.setBusy(true);
    const blocked = new Event("cancel", { cancelable: true });
    element.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    view.setBusy(false);
    expect(element.hasAttribute("aria-busy")).toBe(false);
    const escape = new Event("cancel", { cancelable: true });
    element.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    view.close("done");
    expect(view.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("done");
  });
});
