// Entry module of the forgotten-password page (account/forgot-password.html, ota/frontend/docs/pages-account.md §5,
// SDK guide B1 §3.6). `auth.requestPasswordReset({ email })` answers the same `202` whether or not the address has an
// account, and the page says the same in both cases: "If an account exists for this address, we have sent it a link"
// (no account probing). The e-mail links to account/reset-password.html (OADR-0015 point 5).
//
// States: `400` field errors with the focused error summary, `429` the shared message, any other failure "Something
// went wrong" with the request id. Without customer accounts the form is not offered. The link back to sign-in keeps
// `next`, which is also sent as `returnPath` when the contract accepts it.

import { boot, renderState } from "../boot.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { clearFieldErrors, serialize, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import { authState, failureState, keepNext, returnPathOf } from "../lib/session.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {{ auth: Pick<VelexisClient["auth"], "requestPasswordReset"> }} PageClient */

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
 * Runs the forgotten-password page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when
 * the page has no such area, else `{ done, destroy }`.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-forgot-password-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const { config, client } = context;
  const support = config?.support ?? null;
  const form = /** @type {HTMLFormElement} */ (main.querySelector("form[data-auth-form]"));
  const stateBox = /** @type {HTMLElement} */ (main.querySelector("[data-auth-state]"));
  const content = /** @type {HTMLElement} */ (main.querySelector("[data-auth-content]"));
  const sent = /** @type {HTMLElement} */ (main.querySelector("[data-sent]"));
  keepNext(main, location.search);

  /**
   * Shows a state above the form and moves the focus to it.
   * @param {Pick<PageState, "name" | "scope" | "message"> & Partial<PageState>} state
   * @param {string | null} [requestId]
   */
  const show = (state, requestId = null) =>
    renderState(stateBox, state, { scope: "inline", support, requestId, focus: true });

  if (config?.features?.customerAccounts === false) {
    content.hidden = true;
    show(authState("feature-disabled", t("state.feature-disabled")));
    return { done: Promise.resolve(), destroy: () => {} };
  }

  /** @param {SubmitEvent} event */
  const onSubmit = (event) => {
    event.preventDefault();
    withSubmitState(form, async () => {
      clearFieldErrors(form);
      stateBox.replaceChildren();
      const email = String(serialize(form)["email"] ?? "").trim();
      if (email === "") {
        showFieldErrors(form, [{ path: "/email", code: "required" }]);
        return;
      }
      const returnPath = returnPathOf(location.search);
      try {
        await client.auth.requestPasswordReset({ email, ...(returnPath ? { returnPath } : {}) });
      } catch (error) {
        if (isAborted(error)) {
          return;
        }
        const state = pageStateFor(error);
        if (state.name === "validation" && state.fieldErrors.length > 0) {
          showFieldErrors(form, state.fieldErrors);
          return;
        }
        if (state.code === "FEATURE_DISABLED") {
          content.hidden = true;
        }
        const failure = failureState(error);
        show(failure.state, failure.requestId);
        return;
      }
      // The same answer for every address: the page never tells whether it has an account.
      content.hidden = true;
      sent.hidden = false;
      // Its heading takes the focus, so screen readers read it.
      /** @type {HTMLElement | null} */ (sent.querySelector('[tabindex="-1"]'))?.focus();
    }).catch(report);
  };
  form.addEventListener("submit", onSubmit);

  return {
    done: Promise.resolve(),
    destroy() {
      form.removeEventListener("submit", onSubmit);
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
