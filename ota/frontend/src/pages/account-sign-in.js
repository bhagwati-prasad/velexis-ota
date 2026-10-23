// Entry module of the sign-in page (account/sign-in.html?next=…, ota/frontend/docs/pages-account.md §1 and §5, flow
// ota/docs/flows/my-bookings-and-guest-lookup.md §3 step 3 and §4, SDK guide B1 §3.3). The SDK runs in cookie mode:
// `auth.signIn({ email, password, rememberMe })` answers the session metadata, and the session itself goes into the
// API's httpOnly cookies, so this page never holds a token.
//
// - A customer who is already signed in goes on at once: to `next`, else to the account page (lib/session.js
//   `nextTarget`: a `next` that is not a path on this storefront, such as `https://evil.example`, leads to `/`).
// - Success goes to the same place. The links to the password reset and to sign-up keep `next`.
// - States: `401 INVALID_CREDENTIALS` one generic message for a wrong address and a wrong password (with the attempts
//   left before the lockout when few remain), `423 ACCOUNT_LOCKED` the time sign-in opens again and a password-reset
//   link, `403 EMAIL_NOT_VERIFIED` "confirm your e-mail" with a button that sends the link again
//   (`auth.resendVerification`), `400` field errors with the focused error summary, `429` the shared message, and
//   any other failure "Something went wrong" with the request id. Without customer accounts
//   (`features.customerAccounts = false`) the form is not offered.
//
// The form is `method="post"` without an action, so a submit that never reaches this script puts no password into an
// address. The password is read from the form for the one call and never stored or logged.

import { boot, renderState } from "../boot.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatTimestamp } from "../lib/format.js";
import { clearFieldErrors, serialize, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import {
  FORGOT_PASSWORD_PATH,
  authState,
  decorateState,
  failureState,
  keepNext,
  nextTarget,
  returnPathOf,
  withNext,
} from "../lib/session.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("../lib/session.js").StateAction} StateAction */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {{ auth: Pick<VelexisClient["auth"], "signIn"> & Partial<Pick<VelexisClient["auth"], "resendVerification">> }} PageClient */

/** Below this many attempts left, the invalid-credentials message says how many remain. */
const FEW_ATTEMPTS = 3;

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
 * Runs the sign-in page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page has
 * no sign-in area, else `{ done, destroy }`.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, navigate?: (url: string) => void, replace?: (url: string) => void }} [env]
 *   for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-sign-in-page]"));
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
  const target = nextTarget(location.search);
  const resetHref = withNext(FORGOT_PASSWORD_PATH, location.search);
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

  const days = config?.auth?.refreshTokenTtlDays;
  const daysText = main.querySelector("[data-remember-days]");
  if (daysText && Number.isInteger(days) && Number(days) > 0) {
    daysText.textContent = String(days);
  }

  /**
   * Sends the verification link again from the "confirm your e-mail" state, and says that it did (the same text
   * whatever the API did, as the API answers alike).
   * @param {HTMLButtonElement} button
   * @param {string} email
   */
  const resendLink = async (button, email) => {
    const resend = client.auth.resendVerification;
    if (typeof resend !== "function" || button.getAttribute("aria-disabled") === "true") {
      return;
    }
    button.setAttribute("aria-disabled", "true");
    let status = /** @type {HTMLElement | null} */ (stateBox.querySelector("[data-resend-status]"));
    if (!status) {
      status = doc.createElement("p");
      status.className = "mt-2 font-medium";
      status.dataset.resendStatus = "";
      button.closest("p")?.after(status);
    }
    const returnPath = returnPathOf(location.search);
    /** @type {string} */
    let message;
    try {
      await resend.call(client.auth, { email, ...(returnPath ? { returnPath } : {}) });
      message = t("auth.resent");
    } catch (error) {
      message =
        pageStateFor(error).name === "rate-limited" ? t("state.rate-limited") : t("auth.resendFailed");
    } finally {
      button.removeAttribute("aria-disabled");
    }
    status.textContent = message;
    live.announce(message);
  };

  /**
   * Shows what a failed sign-in means.
   * @param {unknown} error
   * @param {string} email the address of the attempt (for the resend button)
   */
  const fail = (error, email) => {
    if (isAborted(error)) {
      return;
    }
    const state = pageStateFor(error);
    const resetLink = { label: t("auth.resetPassword"), href: resetHref };
    if (state.code === "INVALID_CREDENTIALS") {
      const left = state.details?.["remainingAttempts"];
      show(authState("invalid-credentials", t("auth.invalidCredentials")), {
        hint:
          typeof left === "number" && left > 0 && left <= FEW_ATTEMPTS
            ? t("auth.remainingAttempts", { count: left })
            : null,
        actions: [resetLink],
      });
      return;
    }
    if (state.code === "ACCOUNT_LOCKED") {
      const until = state.details?.["lockedUntil"];
      show(authState("account-locked", t("auth.locked")), {
        hint:
          typeof until === "string" && !Number.isNaN(Date.parse(until))
            ? t("auth.lockedUntil", { time: formatTimestamp(until, config?.defaultLocale, config?.timeZone) })
            : t("auth.lockedHint"),
        actions: [resetLink],
      });
      return;
    }
    if (state.code === "EMAIL_NOT_VERIFIED") {
      const canResend = typeof client.auth.resendVerification === "function";
      show(authState("email-not-verified", t("auth.emailNotVerified")), {
        hint: t("auth.emailNotVerifiedHint"),
        actions: canResend
          ? [
              {
                label: t("auth.resend"),
                action: "resend",
                onClick: (button) => void resendLink(button, email).catch(report),
              },
            ]
          : [],
      });
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
      const values = serialize(form);
      const email = String(values["email"] ?? "").trim();
      const password = String(values["password"] ?? "");
      const missing = [
        ...(email === "" ? [{ path: "/email", code: "required" }] : []),
        ...(password === "" ? [{ path: "/password", code: "required" }] : []),
      ];
      if (missing.length > 0) {
        showFieldErrors(form, missing);
        return;
      }
      try {
        await client.auth.signIn({ email, password, rememberMe: values["rememberMe"] !== undefined });
      } catch (error) {
        fail(error, email);
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
