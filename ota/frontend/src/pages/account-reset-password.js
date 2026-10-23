// Entry module of the new-password page (account/reset-password.html?token=…, ota/frontend/docs/pages-account.md §5,
// SDK guide B1 §3.6). The password-reset e-mail links here (OADR-0015 point 5).
//
// 1. The token is read once and taken out of the address bar with `history.replaceState` (lib/url.js `takeParam`)
//    before anything else runs, so no later request, history entry or bookmark carries it. It stays in this module's
//    memory, so the customer can try another password after `422 PASSWORD_TOO_WEAK` (the token stays usable), and is
//    never stored or logged. A missing or malformed token offers a new link at once. The requests made before this
//    module runs carry only the origin in their `Referer`: reset-password.html sets `<meta name="referrer"
//    content="strict-origin">` first in its head (account-verify.js says why not `no-referrer`).
// 2. The new password, with the OTA's rules shown up front (`config.auth.passwordPolicy`), goes to
//    `auth.resetPassword({ token, newPassword, signIn: true })`: every older session ends, and the API opens a new
//    one in its httpOnly cookies (`session: null` in cookie mode). The page asks `auth.getSession` whether it did:
//    signed in, on to `next` or the account page; otherwise "Your new password is saved" with a sign-in link.
// 3. States: `400 PASSWORD_RESET_TOKEN_INVALID` (expired or used) with a link to request a new one, `422
//    PASSWORD_TOO_WEAK` on the password field (the broken rule, never the password), `400` field errors, `429` the
//    shared message, any other failure "Something went wrong" with the request id. Without customer accounts the form
//    is not offered.

import { boot, renderState } from "../boot.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { clearFieldErrors, serialize, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import {
  FORGOT_PASSWORD_PATH,
  authState,
  decorateState,
  failureState,
  keepNext,
  loadSession,
  nextTarget,
  passwordFieldErrors,
  passwordRules,
} from "../lib/session.js";
import { takeParam } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("../lib/session.js").StateAction} StateAction */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {{ auth: Pick<VelexisClient["auth"], "resetPassword" | "getSession"> }} PageClient */

/** A password-reset token as the contract writes it (`PasswordResetConfirmRequest.token`). */
export const RESET_TOKEN = /^pr_[A-Za-z0-9_-]{32,64}$/;

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
 * Runs the new-password page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the
 * page has no such area, else `{ done, destroy }`.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, history?: History, navigate?: (url: string) => void, token?: string | null }} [env]
 *   `token` when the page module took it before boot(); else it is taken from the address here. The rest for tests.
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-reset-password-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const history = env.history ?? view.history;
  const navigate = env.navigate ?? ((/** @type {string} */ url) => location.assign(url));
  const token = env.token !== undefined ? env.token : takeParam("token", { location, history });
  const { config, client } = context;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);
  const form = /** @type {HTMLFormElement} */ (main.querySelector("form[data-auth-form]"));
  const stateBox = /** @type {HTMLElement} */ (main.querySelector("[data-auth-state]"));
  const content = /** @type {HTMLElement} */ (main.querySelector("[data-auth-content]"));
  const doneSection = /** @type {HTMLElement} */ (main.querySelector("[data-reset-done]"));
  const target = nextTarget(location.search);
  keepNext(main, location.search);
  const finished = { done: Promise.resolve(), destroy: () => live.clear() };

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
  const newLink = { label: t("auth.requestNewLink"), href: FORGOT_PASSWORD_PATH };

  if (config?.features?.customerAccounts === false) {
    content.hidden = true;
    show(authState("feature-disabled", t("state.feature-disabled")));
    return finished;
  }
  if (token === null || !RESET_TOKEN.test(token)) {
    content.hidden = true;
    show(
      token === null
        ? authState("no-token", t("auth.resetNoToken"))
        : authState("token-invalid", t("auth.resetToken")),
      { hint: token === null ? t("auth.resetNoTokenHint") : t("auth.resetTokenHint"), actions: [newLink] },
    );
    return finished;
  }

  const policy = config?.auth?.passwordPolicy;
  const password = /** @type {HTMLInputElement} */ (form.querySelector('input[name="newPassword"]'));
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

  /**
   * Shows what a failed reset means.
   * @param {unknown} error
   */
  const fail = (error) => {
    if (isAborted(error)) {
      return;
    }
    const state = pageStateFor(error);
    if (state.code === "PASSWORD_RESET_TOKEN_INVALID") {
      content.hidden = true;
      show(authState("token-invalid", t("auth.resetToken")), {
        hint: t("auth.resetTokenHint"),
        actions: [newLink],
      });
      return;
    }
    if (state.code === "PASSWORD_TOO_WEAK") {
      showFieldErrors(form, passwordFieldErrors(error, "/newPassword"));
      return;
    }
    if (state.name === "validation" && state.fieldErrors.length > 0) {
      showFieldErrors(form, state.fieldErrors);
      return;
    }
    if (state.code === "FEATURE_DISABLED") {
      content.hidden = true;
    }
    const failure = failureState(error);
    show(failure.state, { requestId: failure.requestId, contact: true });
  };

  /** @param {SubmitEvent} event */
  const onSubmit = (event) => {
    event.preventDefault();
    withSubmitState(form, async () => {
      clearFieldErrors(form);
      stateBox.replaceChildren();
      const newPassword = String(serialize(form)["newPassword"] ?? "");
      if (newPassword === "") {
        showFieldErrors(form, [{ path: "/newPassword", code: "required" }]);
        return;
      }
      try {
        await client.auth.resetPassword({ token, newPassword, signIn: true });
      } catch (error) {
        fail(error);
        return;
      }
      password.value = "";
      if (await loadSession(client)) {
        live.announce(t("auth.signedIn"));
        navigate(target);
        return;
      }
      content.hidden = true;
      doneSection.hidden = false;
      /** @type {HTMLElement | null} */ (doneSection.querySelector('[tabindex="-1"]'))?.focus();
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

// Before boot(): from here on no request of the page carries the token in its `Referer`.
const pageToken = takeParam("token");

boot().then((context) => {
  try {
    start(
      /** @type {{ config: StorefrontConfig, client: PageClient, session: SessionInfo | null }} */ (
        /** @type {unknown} */ (context)
      ),
      { token: pageToken },
    );
  } catch (error) {
    report(error);
  }
});
