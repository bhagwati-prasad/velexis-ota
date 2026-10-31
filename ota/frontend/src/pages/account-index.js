// Entry module of the account page (account/index.html, `/account/`; ota/frontend/docs/pages-account.md §1 and §6,
// ota/docs/scope.md §2.2, SDK guide B1 §3.6 and §4). The SDK runs in cookie mode: the session lives in the API's
// httpOnly cookies, and this page never holds a token. Passwords are read from their form for the one call and never
// stored or logged; every form is `method="post"` without an action, so a submit that never reaches this script puts
// nothing into an address.
//
// - Who may open it: without customer accounts (`features.customerAccounts = false`) the page says so; a visitor
//   (no session from boot()) goes to `/account/sign-in.html?next=/account/`, and so does a `401` of `account.get`.
// - Profile: `account.get` fills the form (names, date of birth, mobile phone, marketing e-mails); Save sends only the
//   fields that changed, with `account.update({ ifMatch: version, … })`. `412 PRECONDITION_FAILED` (the profile was
//   changed in another tab or by staff) says "updated elsewhere, reload" and keeps what was typed: Reload reads the
//   account again, takes its new version and its values for the fields the customer did not touch, and leaves the
//   typed ones in place to be saved again.
// - E-mail address: `account.update({ ifMatch, email, currentPassword })`; the new address becomes `pendingEmail`
//   until the link sent to it is opened (the banner says so, with "Send the link again", `auth.resendVerification`,
//   which a signed-in customer calls without an address). `409 EMAIL_ALREADY_REGISTERED` and `422
//   CURRENT_PASSWORD_INCORRECT` mark their fields; `429 RATE_LIMITED` with `details.reason: password_attempts` (the
//   re-authentication lockout of OBE-035) says how long to wait, with a password-reset link, and with
//   `verification_email` that a link was sent a moment ago.
// - Password: `auth.changePassword({ currentPassword, newPassword, signOutOtherSessions })`, the rules of
//   `config.auth.passwordPolicy` shown up front; the API rotates the session cookies. `422 PASSWORD_TOO_WEAK` names
//   the broken rule, `423 ACCOUNT_LOCKED` when the customer may try again.
// - Signing out: `auth.signOut()` and "Sign out everywhere", `auth.signOut({ scope: "all" })`; both show the
//   signed-out account menu and go to `/` (a `401` counts as already signed out).
// - Deletion: a native `<dialog>` (components/dialog.js) asks for the password (re-authentication, as the contract
//   requires) and an optional reason, then `account.delete({ currentPassword, reason })`. `exportData` is never sent:
//   data exports are deferred and the API answers `403 FEATURE_DISABLED` to it (scope §3.1), so the page asks the
//   customer to write to the OTA for a copy instead. `409 ACCOUNT_DELETION_BLOCKED` names the bookings that hold it
//   back (`details.bookingIds`, linked to their pages) with the support contact. On success the account menu shows
//   "Sign in" and the page goes to `/` signed out (the API revoked every session and cleared the cookies).
// - Saved travellers and preferences are not offered (`features.savedTravelers = false`; their operations are
//   deferred), and the page links to neither.
//
// Any other failure shows its state next to the form it belongs to: the shared states (unavailable, `429`, suspended,
// `403 FEATURE_DISABLED`) as they are, anything else "Something went wrong" with the request id and the support
// address; a session that ended meanwhile offers sign-in and keeps what was typed.

import { boot, renderState } from "../boot.js";
import { mount as mountDialog } from "../components/dialog.js";
import { supportEmail } from "../components/footer.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatTimestamp } from "../lib/format.js";
import { clearFieldErrors, serialize, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import {
  ACCOUNT_PATH,
  FORGOT_PASSWORD_PATH,
  HOME_PATH,
  SIGN_IN_PATH,
  authState,
  decorateState,
  failureState,
  passwordFieldErrors,
  passwordRules,
  renderAccountMenu,
} from "../lib/session.js";
import { withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Customer"]} Customer */
/** @typedef {import("@velexis/ota-sdk").Schemas["CustomerUpdateRequest"]} CustomerUpdateRequest */
/** @typedef {import("@velexis/ota-sdk").Schemas["AccountDeletionInput"]} AccountDeletionInput */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("../lib/session.js").StateAction} StateAction */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/forms.js").FieldError} FieldError */
/**
 * The SDK client as far as the page needs it.
 * @typedef {{
 *   account: Pick<VelexisClient["account"], "get" | "update" | "delete">,
 *   auth: Pick<VelexisClient["auth"], "changePassword" | "signOut"> & Partial<Pick<VelexisClient["auth"], "resendVerification">>,
 * }} PageClient
 */
/**
 * The profile form's values by control name: text as typed, the marketing box as a boolean.
 * @typedef {{ firstName: string, lastName: string, dateOfBirth: string, "phone.countryCallingCode": string, "phone.number": string, marketingConsent: boolean }} ProfileValues
 */
/** @typedef {keyof ProfileValues} ProfileField */
/** One form of the page with the element its states go into. @typedef {{ box: HTMLElement, form: HTMLFormElement | null }} Section */

/** Where a visitor without a session goes: sign-in, then back to this page. */
export const SIGN_IN_TARGET = withQuery(SIGN_IN_PATH, { next: ACCOUNT_PATH });

/** The controls of the profile form, in the order of the form. */
const PROFILE_FIELDS = /** @type {const} */ ([
  "firstName",
  "lastName",
  "dateOfBirth",
  "phone.countryCallingCode",
  "phone.number",
  "marketingConsent",
]);
/**
 * A calling code as the form takes it: an optional `+` and one to three digits, the contract's
 * `AmadeusPhone.countryCallingCode` since FIX-W30-OTA (`1` for North America included).
 */
const CALLING_CODE = /^\+?([0-9]{1,3})$/;
/** A phone number once spaces, dots, hyphens and brackets are taken out: one to fifteen digits (`AmadeusPhone`). */
const PHONE_NUMBER = /^[0-9]{1,15}$/;
/** What a typed phone number may contain besides digits. */
const PHONE_SEPARATORS = /[\s().-]/g;
/** `AccountDeletionInput.reason`. */
const DELETION_REASONS = new Set([
  "no_longer_needed",
  "privacy_concerns",
  "too_many_emails",
  "bad_experience",
  "duplicate_account",
  "other",
]);
/** A booking id of the contract (`details.bookingIds` of `409 ACCOUNT_DELETION_BLOCKED`). */
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
/** States of `account.get` that no Retry changes. */
const FINAL_STATES = new Set(["suspended", "unknown-host", "feature-disabled"]);

/**
 * Reports an error of the page (the browser's console and `error` event) without breaking it.
 * @param {unknown} error
 */
function report(error) {
  try {
    globalThis.reportError?.(error);
  } catch {
    // Nothing else to do.
  }
}

/**
 * A typed phone number without its separators (`7700 900-123` → `7700900123`).
 * @param {string} text
 */
const phoneDigits = (text) => text.trim().replace(PHONE_SEPARATORS, "");

/**
 * The digits of a calling code (`+44` → `44`), or the trimmed text when it is not one.
 * @param {string} text
 */
const callingCodeDigits = (text) => CALLING_CODE.exec(text.trim())?.[1] ?? text.trim();

/**
 * The profile form's values for a customer of `account.get` / `account.update`.
 * @param {Customer} customer
 * @returns {ProfileValues}
 */
export function profileValues(customer) {
  const code =
    typeof customer.phone?.countryCallingCode === "string" ? customer.phone.countryCallingCode : "";
  return {
    firstName: typeof customer.firstName === "string" ? customer.firstName : "",
    lastName: typeof customer.lastName === "string" ? customer.lastName : "",
    dateOfBirth: typeof customer.dateOfBirth === "string" ? customer.dateOfBirth : "",
    "phone.countryCallingCode": code === "" ? "" : `+${callingCodeDigits(code)}`,
    "phone.number": typeof customer.phone?.number === "string" ? customer.phone.number : "",
    marketingConsent: customer.marketingConsent?.granted === true,
  };
}

/**
 * Whether two values of one profile field mean the same (names trimmed, the phone without its separators and the
 * calling code without its `+`).
 * @param {ProfileField} field
 * @param {string | boolean} a
 * @param {string | boolean} b
 */
export function sameValue(field, a, b) {
  if (typeof a === "boolean" || typeof b === "boolean") {
    return a === b;
  }
  switch (field) {
    case "phone.countryCallingCode":
      return callingCodeDigits(a) === callingCodeDigits(b);
    case "phone.number":
      return phoneDigits(a) === phoneDigits(b);
    default:
      return a.trim() === b.trim();
  }
}

/**
 * The `account.update` body for what changed between `baseline` (the profile as read) and `values` (the form), and the
 * problems the form can see itself (a blank name, half a phone number, a calling code or number of another shape),
 * as field errors with JSON pointers into the request. Unchanged fields are left out: the API is sent only what the
 * customer changed.
 * @param {ProfileValues} values
 * @param {ProfileValues} baseline
 * @returns {{ changes: CustomerUpdateRequest, problems: FieldError[] }}
 */
export function profileRequest(values, baseline) {
  /** @type {CustomerUpdateRequest} */
  const changes = {};
  /** @type {FieldError[]} */
  const problems = [];
  for (const field of /** @type {const} */ (["firstName", "lastName"])) {
    const value = values[field].trim();
    if (value === "") {
      problems.push({ path: `/${field}`, code: "required" });
    } else if (!sameValue(field, values[field], baseline[field])) {
      changes[field] = value;
    }
  }
  if (!sameValue("dateOfBirth", values.dateOfBirth, baseline.dateOfBirth)) {
    const date = values.dateOfBirth.trim();
    changes.dateOfBirth = date === "" ? null : date;
  }
  const codeText = values["phone.countryCallingCode"].trim();
  const numberText = phoneDigits(values["phone.number"]);
  const phoneChanged =
    !sameValue("phone.countryCallingCode", codeText, baseline["phone.countryCallingCode"]) ||
    !sameValue("phone.number", numberText, baseline["phone.number"]);
  if (codeText === "" && numberText === "") {
    if (phoneChanged) {
      changes.phone = null;
    }
  } else {
    const code = CALLING_CODE.exec(codeText)?.[1];
    if (codeText === "") {
      problems.push({ path: "/phone/countryCallingCode", code: "required" });
    } else if (code === undefined) {
      problems.push({ path: "/phone/countryCallingCode", code: "pattern" });
    }
    if (numberText === "") {
      problems.push({ path: "/phone/number", code: "required" });
    } else if (!PHONE_NUMBER.test(numberText)) {
      problems.push({ path: "/phone/number", code: "pattern" });
    }
    if (phoneChanged && code !== undefined && PHONE_NUMBER.test(numberText)) {
      // `+` and the digits, as the form shows them; the contract takes both forms (FIX-W30-OTA: before it, its pattern
      // `[0-9+]{2,5}` refused a one-digit code such as 1 without the `+`), and the API drops the `+`.
      changes.phone = { deviceType: "MOBILE", countryCallingCode: `+${code}`, number: numberText };
    }
  }
  if (values.marketingConsent !== baseline.marketingConsent) {
    changes.marketingConsent = values.marketingConsent;
  }
  return { changes, problems };
}

/**
 * Runs the account page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page
 * has no account area, else `{ done, destroy }`; `done` settles once the account is shown (or its state is).
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, navigate?: (url: string) => void, replace?: (url: string) => void }} [env]
 *   for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-account-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const navigate = env.navigate ?? ((/** @type {string} */ url) => location.assign(url));
  const replace = env.replace ?? ((/** @type {string} */ url) => location.replace(url));
  const { config, client } = context;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);
  const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const el = {
    pageState: $("[data-account-state]"),
    loading: $("[data-account-loading]"),
    content: $("[data-account-content]"),
    banner: $("[data-verify-banner]"),
    bannerTitle: $("[data-verify-title]"),
    bannerText: $("[data-verify-text]"),
    resend: /** @type {HTMLButtonElement} */ ($('[data-action="resend-verification"]')),
    resendStatus: $("[data-resend-status]"),
    profileForm: /** @type {HTMLFormElement} */ ($("form[data-profile-form]")),
    profileState: $("[data-profile-state]"),
    email: $('[data-field="email"]'),
    emailStatus: $("[data-email-status]"),
    emailForm: /** @type {HTMLFormElement} */ ($("form[data-email-form]")),
    emailState: $("[data-email-state]"),
    passwordForm: /** @type {HTMLFormElement} */ ($("form[data-password-form]")),
    passwordState: $("[data-password-state]"),
    sessionsState: $("[data-sessions-state]"),
    signOut: /** @type {HTMLButtonElement} */ ($('[data-action="sign-out-current"]')),
    signOutAll: /** @type {HTMLButtonElement} */ ($('[data-action="sign-out-all"]')),
    exportNote: main.querySelector("[data-export-note]"),
    openDelete: /** @type {HTMLButtonElement} */ ($('[data-action="open-delete"]')),
    dialog: /** @type {HTMLDialogElement} */ ($("dialog[data-delete-dialog]")),
    deleteForm: /** @type {HTMLFormElement} */ ($("form[data-delete-form]")),
    deleteState: $("[data-delete-state]"),
  };
  const sections = {
    profile: /** @type {Section} */ ({ box: el.profileState, form: el.profileForm }),
    email: /** @type {Section} */ ({ box: el.emailState, form: el.emailForm }),
    password: /** @type {Section} */ ({ box: el.passwordState, form: el.passwordForm }),
    deletion: /** @type {Section} */ ({ box: el.deleteState, form: el.deleteForm }),
  };
  /** @type {Array<() => void>} */
  const cleanups = [() => live.clear()];
  const finished = {
    done: Promise.resolve(),
    destroy: () => cleanups.splice(0).forEach((cleanup) => cleanup()),
  };

  /**
   * Shows a state in `box` and moves the focus to it; `contact` adds the support address (failures only).
   * @param {HTMLElement} box
   * @param {Pick<PageState, "name" | "scope" | "message"> & Partial<PageState>} state
   * @param {{ hint?: string | null, actions?: StateAction[], requestId?: string | null, contact?: boolean, onRetry?: () => void, focus?: boolean }} [extras]
   */
  const show = (
    box,
    state,
    { hint = null, actions = [], requestId = null, contact = false, onRetry, focus = true } = {},
  ) => {
    const element = renderState(box, state, {
      scope: "inline",
      support: contact ? support : null,
      requestId,
      focus,
      ...(onRetry ? { onRetry } : {}),
    });
    decorateState(element, { hint, actions });
    live.announce(state.message);
    return element;
  };

  /**
   * Shows a confirmation in `box` (what was saved or sent) and announces it; the focus stays where it is.
   * @param {HTMLElement} box
   * @param {string} message
   * @param {string | null} [hint]
   */
  const notice = (box, message, hint = null) => {
    const element = doc.createElement("div");
    element.className = "my-4 rounded-ui border-2 border-success bg-panel p-4";
    element.dataset.notice = "";
    const title = doc.createElement("p");
    title.className = "font-medium";
    title.dataset.field = "title";
    title.textContent = message;
    element.append(title);
    if (hint !== null) {
      const line = doc.createElement("p");
      line.className = "mt-1 text-muted";
      line.dataset.field = "hint";
      line.textContent = hint;
      element.append(line);
    }
    box.replaceChildren(element);
    live.announce(hint === null ? message : `${message} ${hint}`);
  };

  if (config?.features?.customerAccounts === false) {
    el.content.hidden = true;
    show(el.pageState, authState("feature-disabled", t("state.feature-disabled")), { focus: false });
    return finished;
  }
  if (!context.session) {
    replace(SIGN_IN_TARGET);
    return finished;
  }

  /** The account as last read or saved. @type {Customer | null} */
  let customer = null;
  /** The profile form's values for `customer`: what "changed" is measured against. @type {ProfileValues | null} */
  let baseline = null;

  const profileControl = (/** @type {ProfileField} */ field) =>
    /** @type {HTMLInputElement} */ (el.profileForm.querySelector(`[name="${field}"]`));

  /** @returns {ProfileValues} */
  const readProfile = () => {
    const value = (/** @type {ProfileField} */ field) => profileControl(field).value;
    return {
      firstName: value("firstName"),
      lastName: value("lastName"),
      dateOfBirth: value("dateOfBirth"),
      "phone.countryCallingCode": value("phone.countryCallingCode"),
      "phone.number": value("phone.number"),
      marketingConsent: profileControl("marketingConsent").checked,
    };
  };

  /** @param {ProfileValues} values */
  const writeProfile = (values) => {
    for (const field of PROFILE_FIELDS) {
      const control = profileControl(field);
      const value = values[field];
      if (typeof value === "boolean") {
        control.checked = value;
      } else {
        control.value = value;
      }
    }
  };

  /**
   * The fields the customer changed since the profile was read, with what they typed.
   * @returns {Partial<ProfileValues>}
   */
  const editedValues = () => {
    if (baseline === null) {
      return {};
    }
    const values = readProfile();
    const from = baseline;
    return Object.fromEntries(
      PROFILE_FIELDS.filter((field) => !sameValue(field, values[field], from[field])).map((field) => [
        field,
        values[field],
      ]),
    );
  };

  /**
   * Shows `next`: the profile form (keeping what the customer typed into the fields they changed, with `keepEdits`),
   * the address and its verification state, and the banner of an unconfirmed or pending address.
   * @param {Customer} next
   * @param {{ keepEdits: boolean }} options
   */
  const apply = (next, { keepEdits }) => {
    const edits = keepEdits ? editedValues() : {};
    customer = next;
    baseline = profileValues(next);
    writeProfile({ ...baseline, ...edits });
    el.email.textContent = next.email;
    el.emailStatus.textContent = next.emailVerified
      ? t("accountPage.verified")
      : t("accountPage.notVerified");
    const pending =
      typeof next.pendingEmail === "string" && next.pendingEmail !== "" ? next.pendingEmail : null;
    if (pending !== null) {
      el.bannerTitle.textContent = t("accountPage.pendingTitle");
      el.bannerText.textContent = t("accountPage.pendingText", { pending, email: next.email });
    } else if (!next.emailVerified) {
      el.bannerTitle.textContent = t("accountPage.verifyTitle");
      el.bannerText.textContent = t("accountPage.verifyText", { email: next.email });
    }
    el.banner.hidden = pending === null && next.emailVerified === true;
  };

  /** Sends the customer to sign-in and back here once signed in. */
  const sessionEnded = (/** @type {HTMLElement} */ box) =>
    show(box, authState("session-ended", t("accountPage.sessionEnded")), {
      hint: t("accountPage.sessionEndedHint"),
      actions: [{ label: t("account.signIn"), href: SIGN_IN_TARGET }],
    });

  /**
   * The lockouts of a re-authentication: `429 RATE_LIMITED` with `details.reason` `password_attempts` (an address
   * change or a deletion) or `verification_email` (a new address within a minute of the last link), and `423
   * ACCOUNT_LOCKED` (a password change). Returns whether it showed one.
   * @param {HTMLElement} box
   * @param {PageState} state
   */
  const lockout = (box, state) => {
    const resetLink = { label: t("auth.resetPassword"), href: FORGOT_PASSWORD_PATH };
    const reason = state.details?.["reason"];
    if (state.code === "RATE_LIMITED" && reason === "password_attempts") {
      const seconds = state.retryAfterSeconds;
      show(box, authState("password-attempts", t("accountPage.tooManyPasswords")), {
        hint:
          typeof seconds === "number" && seconds > 0
            ? t("accountPage.tryAgainIn", { count: Math.ceil(seconds / 60) })
            : t("accountPage.tryAgainLater"),
        actions: [resetLink],
      });
      return true;
    }
    if (state.code === "RATE_LIMITED" && reason === "verification_email") {
      show(box, authState("link-just-sent", t("accountPage.linkJustSent")), {
        hint: t("accountPage.linkJustSentHint"),
      });
      return true;
    }
    if (state.code === "ACCOUNT_LOCKED") {
      const until = state.details?.["lockedUntil"];
      show(box, authState("account-locked", t("accountPage.tooManyPasswords")), {
        hint:
          typeof until === "string" && !Number.isNaN(Date.parse(until))
            ? t("auth.lockedUntil", { time: formatTimestamp(until, config?.defaultLocale, config?.timeZone) })
            : t("accountPage.tryAgainLater"),
        actions: [resetLink],
      });
      return true;
    }
    return false;
  };

  /**
   * Reads the account again after a `412` and shows its new version, keeping what the customer typed.
   * @param {HTMLElement} box
   * @param {HTMLButtonElement} button
   */
  const reload = async (box, button) => {
    if (button.getAttribute("aria-disabled") === "true") {
      return;
    }
    button.setAttribute("aria-disabled", "true");
    /** @type {Customer} */
    let fresh;
    try {
      fresh = await client.account.get();
    } catch (error) {
      button.removeAttribute("aria-disabled");
      fail({ box, form: null }, error);
      return;
    }
    apply(fresh, { keepEdits: true });
    notice(box, t("accountPage.reloaded"));
  };

  /**
   * Shows what a failed call of one section means (see the top of this file).
   * @param {Section} section
   * @param {unknown} error
   */
  const fail = (section, error) => {
    if (isAborted(error)) {
      return;
    }
    const { box, form } = section;
    const state = pageStateFor(error);
    if (state.name === "stale") {
      show(box, authState("stale", t("accountPage.stale")), {
        hint: t("accountPage.staleHint"),
        actions: [
          {
            label: t("accountPage.reload"),
            action: "reload",
            onClick: (button) => void reload(box, button).catch(report),
          },
        ],
      });
      return;
    }
    if (state.name === "signed-out") {
      sessionEnded(box);
      return;
    }
    if (lockout(box, state)) {
      return;
    }
    if (form && state.code === "PASSWORD_TOO_WEAK") {
      showFieldErrors(form, passwordFieldErrors(error, "/newPassword"));
      return;
    }
    if (form && state.code === "CURRENT_PASSWORD_INCORRECT") {
      showFieldErrors(
        form,
        state.fieldErrors.length > 0
          ? state.fieldErrors
          : [{ path: "/currentPassword", code: "CURRENT_PASSWORD_INCORRECT" }],
      );
      return;
    }
    if (form && state.fieldErrors.length > 0) {
      // 400 VALIDATION_FAILED, 409 EMAIL_ALREADY_REGISTERED (`/email`): the fields, with the focused summary.
      showFieldErrors(form, state.fieldErrors);
      return;
    }
    const failure = failureState(error);
    show(box, failure.state, { requestId: failure.requestId, contact: true });
  };

  /** Shows the signed-out account menu in the header and says why. */
  const signedOut = (/** @type {string} */ message) => {
    const slot = doc.querySelector('body > header [data-slot="account-menu"]');
    if (slot) {
      renderAccountMenu(slot, null, { location, client });
    }
    live.announce(message);
  };

  // The password rules and the copy of the data, from the configuration.
  const policy = config?.auth?.passwordPolicy;
  const newPassword = /** @type {HTMLInputElement} */ (el.passwordForm.querySelector('[name="newPassword"]'));
  if (typeof policy?.minLength === "number" && policy.minLength > 0) {
    newPassword.minLength = policy.minLength;
  }
  if (typeof policy?.maxLength === "number" && policy.maxLength > 0) {
    newPassword.maxLength = policy.maxLength;
  }
  const rules = el.passwordForm.querySelector("[data-password-rules]");
  if (rules) {
    rules.textContent = passwordRules(policy);
  }
  const contactEmail = supportEmail(support);
  if (el.exportNote && contactEmail !== null) {
    el.exportNote.textContent = t("accountPage.exportNote", { email: contactEmail });
  }
  const dateOfBirth = profileControl("dateOfBirth");
  dateOfBirth.max = new Date().toISOString().slice(0, 10);

  /**
   * `listener` for `type` on `target`, removed by destroy().
   * @param {EventTarget} target
   * @param {string} type
   * @param {(event: Event) => void} listener
   */
  const listen = (target, type, listener) => {
    target.addEventListener(type, listener);
    cleanups.push(() => target.removeEventListener(type, listener));
  };

  // Profile.
  listen(el.profileForm, "submit", (event) => {
    event.preventDefault();
    withSubmitState(el.profileForm, async () => {
      if (customer === null || baseline === null) {
        return;
      }
      clearFieldErrors(el.profileForm);
      el.profileState.replaceChildren();
      const { changes, problems } = profileRequest(readProfile(), baseline);
      if (problems.length > 0) {
        showFieldErrors(el.profileForm, problems);
        return;
      }
      if (Object.keys(changes).length === 0) {
        notice(el.profileState, t("accountPage.noChanges"));
        return;
      }
      /** @type {Customer} */
      let saved;
      try {
        saved = await client.account.update({ ifMatch: customer.version, ...changes });
      } catch (error) {
        fail(sections.profile, error);
        return;
      }
      apply(saved, { keepEdits: false });
      notice(el.profileState, t("accountPage.saved"));
    }).catch(report);
  });

  // E-mail address.
  listen(el.emailForm, "submit", (event) => {
    event.preventDefault();
    withSubmitState(el.emailForm, async () => {
      if (customer === null) {
        return;
      }
      clearFieldErrors(el.emailForm);
      el.emailState.replaceChildren();
      const values = serialize(el.emailForm);
      const email = String(values["email"] ?? "").trim();
      const currentPassword = String(values["currentPassword"] ?? "");
      const problems = [
        ...(email === "" ? [{ path: "/email", code: "required" }] : []),
        ...(email !== "" &&
        email.toLowerCase() === customer.email.toLowerCase() &&
        (customer.pendingEmail ?? null) === null
          ? [{ path: "/email", code: "SAME_EMAIL" }]
          : []),
        ...(currentPassword === "" ? [{ path: "/currentPassword", code: "required" }] : []),
      ];
      if (problems.length > 0) {
        showFieldErrors(el.emailForm, problems);
        return;
      }
      /** @type {Customer} */
      let saved;
      try {
        saved = await client.account.update({ ifMatch: customer.version, email, currentPassword });
      } catch (error) {
        fail(sections.email, error);
        return;
      }
      el.emailForm.reset();
      apply(saved, { keepEdits: true });
      const pending =
        typeof saved.pendingEmail === "string" && saved.pendingEmail !== "" ? saved.pendingEmail : null;
      notice(
        el.emailState,
        pending === null
          ? t("accountPage.emailKept", { email: saved.email })
          : t("accountPage.emailRequested", { email: pending }),
      );
    }).catch(report);
  });

  // The link that confirms the address (unconfirmed or pending).
  const resendVerification = client.auth.resendVerification;
  if (typeof resendVerification !== "function") {
    el.resend.closest("p")?.setAttribute("hidden", "");
  }
  listen(el.resend, "click", () => {
    if (typeof resendVerification !== "function" || el.resend.getAttribute("aria-disabled") === "true") {
      return;
    }
    el.resend.setAttribute("aria-disabled", "true");
    (async () => {
      /** @type {string} */
      let message;
      try {
        // Signed in: no address; the API sends the link to the pending address, else to the unconfirmed one.
        await resendVerification.call(client.auth, { returnPath: ACCOUNT_PATH });
        message = t("auth.resent");
      } catch (error) {
        message =
          pageStateFor(error).name === "rate-limited" ? t("state.rate-limited") : t("auth.resendFailed");
      } finally {
        el.resend.removeAttribute("aria-disabled");
      }
      el.resendStatus.textContent = message;
      live.announce(message);
    })().catch(report);
  });

  // Password.
  listen(el.passwordForm, "submit", (event) => {
    event.preventDefault();
    withSubmitState(el.passwordForm, async () => {
      clearFieldErrors(el.passwordForm);
      el.passwordState.replaceChildren();
      const values = serialize(el.passwordForm);
      const currentPassword = String(values["currentPassword"] ?? "");
      const nextPassword = String(values["newPassword"] ?? "");
      const signOutOtherSessions = values["signOutOtherSessions"] !== undefined;
      const problems = [
        ...(currentPassword === "" ? [{ path: "/currentPassword", code: "required" }] : []),
        ...(nextPassword === "" ? [{ path: "/newPassword", code: "required" }] : []),
      ];
      if (problems.length > 0) {
        showFieldErrors(el.passwordForm, problems);
        return;
      }
      try {
        await client.auth.changePassword({
          currentPassword,
          newPassword: nextPassword,
          signOutOtherSessions,
        });
      } catch (error) {
        fail(sections.password, error);
        return;
      }
      for (const name of ["currentPassword", "newPassword"]) {
        /** @type {HTMLInputElement} */ (el.passwordForm.querySelector(`[name="${name}"]`)).value = "";
      }
      notice(
        el.passwordState,
        t("accountPage.passwordChanged"),
        signOutOtherSessions ? t("accountPage.passwordChangedOthers") : null,
      );
    }).catch(report);
  });

  // Signing out, here or everywhere.
  /**
   * @param {HTMLButtonElement} button
   * @param {"current" | "all"} scope
   */
  const signOut = async (button, scope) => {
    if (button.getAttribute("aria-disabled") === "true") {
      return;
    }
    el.signOut.setAttribute("aria-disabled", "true");
    el.signOutAll.setAttribute("aria-disabled", "true");
    button.textContent = t("account.signingOut");
    el.sessionsState.replaceChildren();
    const idle = scope === "all" ? t("accountPage.signOutAll") : t("account.signOut");
    try {
      if (scope === "all") {
        await client.auth.signOut({ scope: "all" });
      } else {
        await client.auth.signOut();
      }
    } catch (error) {
      if (pageStateFor(error).name !== "signed-out") {
        el.signOut.removeAttribute("aria-disabled");
        el.signOutAll.removeAttribute("aria-disabled");
        button.textContent = idle;
        if (!isAborted(error)) {
          const failure = failureState(error);
          show(
            el.sessionsState,
            failure.state.name === "unexpected"
              ? { ...failure.state, message: t("account.signOutFailed") }
              : failure.state,
            { requestId: failure.requestId, contact: true },
          );
        }
        return;
      }
    }
    signedOut(scope === "all" ? t("accountPage.signedOutEverywhere") : t("account.signedOut"));
    navigate(HOME_PATH);
  };
  listen(el.signOut, "click", () => void signOut(el.signOut, "current").catch(report));
  listen(el.signOutAll, "click", () => void signOut(el.signOutAll, "all").catch(report));

  // Deletion, in the dialog.
  const deletePassword = /** @type {HTMLInputElement} */ (
    el.deleteForm.querySelector('[name="currentPassword"]')
  );
  let deleted = false;
  const dialog = mountDialog(el.dialog, {
    onClose: () => {
      if (!deleted) {
        // The password does not wait in a closed dialog.
        deletePassword.value = "";
        clearFieldErrors(el.deleteForm);
        el.deleteState.replaceChildren();
      }
    },
  });
  cleanups.push(() => dialog.destroy());
  listen(el.openDelete, "click", () => {
    clearFieldErrors(el.deleteForm);
    el.deleteState.replaceChildren();
    dialog.open(el.openDelete);
  });

  /**
   * Shows what a failed deletion means: the bookings that hold it back, else as the other sections do.
   * @param {unknown} error
   */
  const failDeletion = (error) => {
    const state = pageStateFor(error);
    if (state.code !== "ACCOUNT_DELETION_BLOCKED") {
      fail(sections.deletion, error);
      return;
    }
    const listed = state.details?.["bookingIds"];
    const ids = Array.isArray(listed)
      ? listed.filter((id) => typeof id === "string" && BOOKING_ID.test(id))
      : [];
    show(el.deleteState, authState("deletion-blocked", t("accountPage.deleteBlocked")), {
      hint: t("accountPage.deleteBlockedHint"),
      actions: ids.map((bookingId, index) => ({
        label: t("accountPage.blockedBooking", { number: index + 1 }),
        href: withQuery("/booking.html", { id: bookingId }),
      })),
      contact: true,
    });
  };

  listen(el.deleteForm, "submit", (event) => {
    event.preventDefault();
    withSubmitState(el.deleteForm, async () => {
      clearFieldErrors(el.deleteForm);
      el.deleteState.replaceChildren();
      const values = serialize(el.deleteForm);
      const currentPassword = String(values["currentPassword"] ?? "");
      const reason = String(values["reason"] ?? "");
      if (currentPassword === "") {
        showFieldErrors(el.deleteForm, [{ path: "/currentPassword", code: "required" }]);
        return;
      }
      /** @type {AccountDeletionInput} */
      const request = {
        currentPassword,
        ...(DELETION_REASONS.has(reason)
          ? { reason: /** @type {AccountDeletionInput["reason"]} */ (reason) }
          : {}),
      };
      dialog.setBusy(true);
      try {
        await client.account.delete(request);
      } catch (error) {
        if (!isAborted(error)) {
          if (!dialog.isOpen()) {
            // The browser closed the dialog while the request ran (a repeated Escape, components/dialog.js): it opens
            // again, so that the customer sees why the account was not deleted.
            dialog.open(el.openDelete);
          }
          failDeletion(error);
        }
        return;
      } finally {
        dialog.setBusy(false);
      }
      deleted = true;
      deletePassword.value = "";
      dialog.close("deleted");
      el.content.hidden = true;
      notice(el.pageState, t("accountPage.deleted"));
      signedOut(t("accountPage.deleted"));
      replace(HOME_PATH);
    }).catch(report);
  });

  /**
   * Reads the account and shows it; a failure shows its state with Retry where trying again may help.
   * @param {boolean} retried focus the state of a Retry that failed again
   */
  const load = async (retried = false) => {
    el.loading.hidden = false;
    live.announce(t("accountPage.loading"));
    /** @type {Customer} */
    let read;
    try {
      read = await client.account.get();
    } catch (error) {
      el.loading.hidden = true;
      if (isAborted(error)) {
        return;
      }
      if (pageStateFor(error).name === "signed-out") {
        replace(SIGN_IN_TARGET);
        return;
      }
      const failure = failureState(error);
      show(el.pageState, failure.state, {
        requestId: failure.requestId,
        contact: true,
        focus: retried,
        ...(FINAL_STATES.has(failure.state.name) ? {} : { onRetry: () => void load(true).catch(report) }),
      });
      return;
    }
    el.loading.hidden = true;
    el.pageState.replaceChildren();
    live.clear();
    apply(read, { keepEdits: false });
    el.content.hidden = false;
  };

  return { done: load().catch(report), destroy: finished.destroy };
}

document.documentElement.dataset.js = "on";

boot().then((context) => {
  try {
    start(
      /** @type {{ config: StorefrontConfig, client: PageClient, session: SessionInfo | null }} */ (
        /** @type {unknown} */ (context)
      ),
    );
  } catch (error) {
    report(error);
  }
});
