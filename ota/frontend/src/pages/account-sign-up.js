// Entry module of the sign-up page (account/sign-up.html?next=…, ota/frontend/docs/pages-account.md §1 and §5, flow
// ota/docs/flows/my-bookings-and-guest-lookup.md §3 step 1, SDK guide B1 §3.1). The SDK runs in cookie mode: an opened
// session goes into the API's httpOnly cookies and `auth.signUp` resolves with `session: null`.
//
// - A customer who is already signed in goes on at once, to `next` or the account page (lib/session.js `nextTarget`).
// - The form asks for the name, the e-mail address and a password, with the OTA's password rules shown before the
//   customer types (`config.auth.passwordPolicy`); the terms and the privacy policy are linked from the configuration
//   (`config.legal`) and must be accepted (a ticked box; the call sends `legal.termsVersion`), and marketing e-mails
//   are an unticked opt-in. `auth.signUp({ email, password, firstName, lastName, termsVersion, marketingConsent,
//   returnPath })`.
// - Success: when the API opens a session (every policy but `required_before_sign_in`), on to `next`; otherwise
//   "Check your e-mail" with the address the link went to.
// - States: `409 EMAIL_ALREADY_REGISTERED` with sign-in and password-reset links, `422 PASSWORD_TOO_WEAK` on the
//   password field (the broken rule, never the password), `400` field errors (an outdated terms version also forgets
//   the cached configuration, so a reload shows the current terms), `429` the shared message, any other failure
//   "Something went wrong" with the request id. Without customer accounts the form is not offered.
//
// The form is `method="post"` without an action, so a submit that never reaches this script puts no password into an
// address.

import { boot, renderState } from "../boot.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { clearCachedConfig } from "../lib/config.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { clearFieldErrors, serialize, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import {
  FORGOT_PASSWORD_PATH,
  SIGN_IN_PATH,
  authState,
  decorateState,
  failureState,
  keepNext,
  nextTarget,
  passwordFieldErrors,
  passwordRules,
  returnPathOf,
  withNext,
} from "../lib/session.js";
import { safeUrl } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["SignUpRequest"]} SignUpRequest */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("../lib/session.js").StateAction} StateAction */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {{ auth: Pick<VelexisClient["auth"], "signUp"> }} PageClient */

/** Where a legal link may lead: https pages and pages of this storefront. */
const LEGAL_SCHEMES = ["https:"];

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
 * Fills the legal paragraph: "Please read the terms and conditions and the privacy policy (each opens in a new tab)",
 * each a link when the configuration has a safe address for it.
 * @param {HTMLElement} paragraph
 * @param {Partial<StorefrontConfig["legal"]> | null | undefined} legal
 */
function renderLegalLinks(paragraph, legal) {
  const doc = paragraph.ownerDocument;
  /** @param {unknown} url @param {string} label */
  const part = (url, label) => {
    const href = typeof url === "string" ? safeUrl(url, LEGAL_SCHEMES) : null;
    if (href === null) {
      return doc.createTextNode(label);
    }
    const link = doc.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "font-medium text-primary underline underline-offset-4";
    link.textContent = label;
    return link;
  };
  paragraph.replaceChildren(
    doc.createTextNode(t("checkout.readBefore")),
    part(legal?.termsUrl, t("checkout.terms")),
    doc.createTextNode(t("checkout.listLast")),
    part(legal?.privacyUrl, t("checkout.privacy")),
    doc.createTextNode(t("checkout.newTab")),
  );
}

/**
 * Runs the sign-up page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page has
 * no sign-up area, else `{ done, destroy }`.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, navigate?: (url: string) => void, replace?: (url: string) => void }} [env]
 *   for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-sign-up-page]"));
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
  const form = /** @type {HTMLFormElement} */ (main.querySelector("form[data-auth-form]"));
  const stateBox = /** @type {HTMLElement} */ (main.querySelector("[data-auth-state]"));
  const content = /** @type {HTMLElement} */ (main.querySelector("[data-auth-content]"));
  const checkEmail = /** @type {HTMLElement} */ (main.querySelector("[data-check-email]"));
  const target = nextTarget(location.search);
  keepNext(main, location.search);
  const finished = { done: Promise.resolve(), destroy: () => live.clear() };

  if (context.session) {
    replace(target);
    return finished;
  }

  /**
   * Shows a state above the form and moves the focus to it; `contact` adds the support address (failures only).
   * @param {Pick<PageState, "name" | "scope" | "message"> & Partial<PageState>} state
   * @param {{ hint?: string | null, actions?: StateAction[], requestId?: string | null, contact?: boolean }} [extras]
   */
  const show = (state, { hint = null, actions = [], requestId = null, contact = false } = {}) => {
    const element = renderState(stateBox, state, {
      scope: "inline",
      support: contact ? support : null,
      requestId,
      focus: true,
    });
    decorateState(element, { hint, actions });
    return element;
  };

  if (config?.features?.customerAccounts === false) {
    content.hidden = true;
    show(authState("feature-disabled", t("state.feature-disabled")));
    return finished;
  }

  const policy = config?.auth?.passwordPolicy;
  const password = /** @type {HTMLInputElement} */ (form.querySelector('input[name="password"]'));
  if (typeof policy?.minLength === "number" && policy.minLength > 0) {
    password.minLength = policy.minLength;
  }
  if (typeof policy?.maxLength === "number" && policy.maxLength > 0) {
    password.maxLength = policy.maxLength;
  }
  const rules = main.querySelector("[data-password-rules]");
  if (rules) {
    rules.textContent = passwordRules(policy);
  }
  const legalLinks = /** @type {HTMLElement | null} */ (main.querySelector("[data-legal-links]"));
  if (legalLinks) {
    renderLegalLinks(legalLinks, config?.legal);
  }

  /**
   * Shows what a failed sign-up means.
   * @param {unknown} error
   */
  const fail = (error) => {
    if (isAborted(error)) {
      return;
    }
    const state = pageStateFor(error);
    if (state.code === "EMAIL_ALREADY_REGISTERED") {
      show(authState("already-registered", t("auth.alreadyRegistered")), {
        hint: t("auth.alreadyRegisteredHint"),
        actions: [
          { label: t("auth.signIn"), href: withNext(SIGN_IN_PATH, location.search) },
          { label: t("auth.resetPassword"), href: withNext(FORGOT_PASSWORD_PATH, location.search) },
        ],
      });
      return;
    }
    if (state.code === "PASSWORD_TOO_WEAK") {
      showFieldErrors(form, passwordFieldErrors(error, "/password"));
      return;
    }
    if (state.name === "validation" && state.fieldErrors.length > 0) {
      if (state.fieldErrors.some((fieldError) => fieldError.path === "/termsVersion")) {
        // The terms changed while the configuration was cached: the next page load asks the API again.
        clearCachedConfig();
      }
      showFieldErrors(form, state.fieldErrors);
      return;
    }
    if (state.code === "FEATURE_DISABLED") {
      content.hidden = true;
    }
    const failure = failureState(error);
    show(failure.state, { requestId: failure.requestId, contact: true });
  };

  /**
   * "Check your e-mail" instead of the form, with the (masked) address the link went to.
   * @param {string} sentTo
   */
  const showCheckEmail = (sentTo) => {
    content.hidden = true;
    stateBox.replaceChildren();
    const text = checkEmail.querySelector("[data-check-email-text]");
    if (text) {
      text.textContent = t("auth.checkEmail", { email: sentTo });
    }
    checkEmail.hidden = false;
    /** @type {HTMLElement | null} */ (checkEmail.querySelector('[tabindex="-1"]'))?.focus();
  };

  /** @param {SubmitEvent} event */
  const onSubmit = (event) => {
    event.preventDefault();
    withSubmitState(form, async () => {
      clearFieldErrors(form);
      stateBox.replaceChildren();
      const values = serialize(form);
      const text = (/** @type {string} */ name) => String(values[name] ?? "").trim();
      const email = text("email");
      const missing = [
        ...["firstName", "lastName", "email"]
          .filter((name) => text(name) === "")
          .map((name) => ({ path: `/${name}`, code: "required" })),
        ...(String(values["password"] ?? "") === "" ? [{ path: "/password", code: "required" }] : []),
        ...(values["termsAccepted"] === undefined
          ? [{ path: "/termsAccepted", code: "TERMS_NOT_ACCEPTED" }]
          : []),
      ];
      if (missing.length > 0) {
        showFieldErrors(form, missing);
        return;
      }
      const termsVersion = config?.legal?.termsVersion;
      const returnPath = returnPathOf(location.search);
      /** @type {SignUpRequest} */
      const request = {
        email,
        password: String(values["password"]),
        firstName: text("firstName"),
        lastName: text("lastName"),
        marketingConsent: values["marketingConsent"] !== undefined,
        ...(typeof termsVersion === "string" && termsVersion !== "" ? { termsVersion } : {}),
        ...(returnPath ? { returnPath } : {}),
      };
      /** @type {Awaited<ReturnType<VelexisClient["auth"]["signUp"]>>} */
      let result;
      try {
        result = await client.auth.signUp(request);
      } catch (error) {
        fail(error);
        return;
      }
      if (result?.emailVerification?.policy === "required_before_sign_in") {
        const sentTo = result.emailVerification.sentTo;
        showCheckEmail(typeof sentTo === "string" && sentTo !== "" ? sentTo : email);
        return;
      }
      live.announce(t("auth.signedIn"));
      navigate(target);
    }).catch(report);
  };
  form.addEventListener("submit", onSubmit);

  return {
    done: Promise.resolve(),
    destroy() {
      form.removeEventListener("submit", onSubmit);
      live.clear();
    },
  };
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
