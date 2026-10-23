// Entry module of the e-mail verification page (account/verify.html?token=…, ota/frontend/docs/pages-account.md §5,
// flow ota/docs/flows/my-bookings-and-guest-lookup.md §3 step 2, SDK guide B1 §3.2). The verification e-mail links
// here (OADR-0015 point 5).
//
// 1. The token is read once and taken out of the address bar with `history.replaceState` (lib/url.js `takeParam`)
//    before anything else runs, so no later request, history entry or bookmark carries it; it lives in this module's
//    memory for the one call and is never stored or logged. The requests the browser makes before this module runs
//    (its own script, the module preloads, the stylesheet) still see the address with the token: verify.html sets
//    `<meta name="referrer" content="strict-origin">` first in its head, so their `Referer` is the origin alone and
//    the token never reaches an access log (Caddy records request headers). Not `no-referrer`: the SDK's
//    `mode: "same-origin"` writes would then send `Origin: null`, which the API's CSRF check refuses.
// 2. `auth.verifyEmail({ token })` (a token of the contract's shape only). Success says which address is confirmed,
//    that it is the sign-in address from now on when a pending change was confirmed (`emailChanged`), and how many
//    earlier guest bookings now appear in My bookings (`claimedGuestBookings`), with a link on: the account page when
//    signed in, else sign-in. No session is opened: the link may be opened on another device.
// 3. `400 VERIFICATION_TOKEN_INVALID` (`details.reason` `expired`, `used` or `unknown`; a missing or malformed token
//    counts as unknown) offers a new link: `auth.resendVerification({ email })`, or without the address for a signed-in
//    customer; the page always says the same afterwards (the API never tells whether an address has an account).
//    `409 EMAIL_ALREADY_REGISTERED` (the new address was taken meanwhile), `429` the shared message, any other failure
//    "Something went wrong" with the request id and Retry.

import { boot, renderState } from "../boot.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { clearFieldErrors, serialize, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import { ACCOUNT_PATH, SIGN_IN_PATH, authState, decorateState, failureState } from "../lib/session.js";
import { safeNext, takeParam } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["EmailVerificationResult"]} EmailVerificationResult */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("../lib/session.js").StateAction} StateAction */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {{ auth: Pick<VelexisClient["auth"], "verifyEmail"> & Partial<Pick<VelexisClient["auth"], "resendVerification">> }} PageClient */

/** A verification token as the contract writes it (`EmailVerificationConfirmRequest.token`). */
export const VERIFICATION_TOKEN = /^vt_[A-Za-z0-9_-]{32,64}$/;
/** The reasons of `VERIFICATION_TOKEN_INVALID` with their own text. */
const TOKEN_REASONS = new Set(["expired", "used", "unknown"]);

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
 * Runs the verification page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the
 * page has no verification area, else `{ done, destroy }`: `done` settles once the outcome is shown.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, history?: History, token?: string | null }} [env] `token` when the
 *   page module took it before boot(); else it is taken from the address here. The rest for tests.
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-verify-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const history = env.history ?? view.history;
  const token = env.token !== undefined ? env.token : takeParam("token", { location, history });
  const { config, client } = context;
  const session = context.session ?? null;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);
  const loading = /** @type {HTMLElement} */ (main.querySelector("[data-verify-loading]"));
  const stateBox = /** @type {HTMLElement} */ (main.querySelector("[data-auth-state]"));
  const verified = /** @type {HTMLElement} */ (main.querySelector("[data-verified]"));
  const resendSection = /** @type {HTMLElement} */ (main.querySelector("[data-resend]"));
  const resendForm = /** @type {HTMLFormElement} */ (main.querySelector("form[data-resend-form]"));
  const resendEmail = /** @type {HTMLElement} */ (main.querySelector("[data-resend-email]"));
  const resendStatus = /** @type {HTMLElement} */ (main.querySelector("[data-resend-status]"));
  const resendState = /** @type {HTMLElement} */ (main.querySelector("[data-resend-state]"));
  let destroyed = false;

  /**
   * Shows a state and moves the focus to it; `contact` adds the support address (failures only).
   * @param {Pick<PageState, "name" | "scope" | "message"> & Partial<PageState>} state
   * @param {{ hint?: string | null, actions?: StateAction[], requestId?: string | null, onRetry?: () => void, box?: HTMLElement, contact?: boolean }} [extras]
   */
  const show = (
    state,
    { hint = null, actions = [], requestId = null, onRetry, box = stateBox, contact = false } = {},
  ) => {
    const element = renderState(box, state, {
      scope: "inline",
      support: contact ? support : null,
      requestId,
      focus: true,
      ...(onRetry ? { onRetry } : {}),
    });
    decorateState(element, { hint, actions });
    return element;
  };

  /** Offers a new link (only while the OTA has customer accounts and the SDK can send one). */
  const offerResend = () => {
    if (
      config?.features?.customerAccounts === false ||
      typeof client.auth.resendVerification !== "function"
    ) {
      return;
    }
    // A signed-in customer gets the link for the account's own address: the API knows it from the session.
    const email = /** @type {HTMLInputElement} */ (resendEmail.querySelector("input"));
    resendEmail.hidden = session !== null;
    email.required = session === null;
    email.disabled = session !== null;
    resendSection.hidden = false;
  };

  /**
   * Shows the confirmed address and where to go next.
   * @param {EmailVerificationResult} result
   */
  const showVerified = (result) => {
    const claimed = typeof result.claimedGuestBookings === "number" ? result.claimedGuestBookings : 0;
    const returnPath = typeof result.returnPath === "string" ? safeNext(result.returnPath) : null;
    const signedIn = session !== null;
    fill(verified, {
      title: t("auth.verified", { email: result.verifiedEmail }),
      emailChanged: result.emailChanged ? t("auth.emailChanged", { email: result.verifiedEmail }) : null,
      sameEmail: !result.emailChanged,
      claimed: claimed > 0 ? t("auth.claimed", { count: claimed }) : null,
      noClaimed: claimed <= 0,
      continueLabel: signedIn ? t("auth.continueAccount") : t("auth.continueSignIn"),
      continueHref: returnPath ?? (signedIn ? ACCOUNT_PATH : SIGN_IN_PATH),
    });
    verified.hidden = false;
    /** @type {HTMLElement | null} */ (verified.querySelector('[tabindex="-1"]'))?.focus();
  };

  /**
   * The link cannot be used: says why and offers a new one.
   * @param {string} reason `expired`, `used` or `unknown`
   */
  const showTokenInvalid = (reason) => {
    const known = TOKEN_REASONS.has(reason) ? reason : "unknown";
    show(authState(`token-${known}`, t(`auth.verifyToken.${known}`)), {
      hint: known === "used" ? t("auth.verifyTokenHint.used") : t("auth.verifyTokenHint"),
      ...(known === "used" && session === null
        ? { actions: [{ label: t("auth.continueSignIn"), href: SIGN_IN_PATH }] }
        : {}),
    });
    offerResend();
  };

  /** Confirms the address with the token; resolves once the outcome is shown. */
  const verify = async () => {
    stateBox.replaceChildren();
    loading.hidden = false;
    live.announce(t("auth.verifying"));
    /** @type {EmailVerificationResult} */
    let result;
    try {
      result = await client.auth.verifyEmail({ token: /** @type {string} */ (token) });
    } catch (error) {
      loading.hidden = true;
      // "Confirming…" is over: it must not be announced after the state that says what happened.
      live.clear();
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (state.code === "VERIFICATION_TOKEN_INVALID") {
        showTokenInvalid(String(state.details?.["reason"] ?? "unknown"));
        return;
      }
      if (state.name === "validation") {
        // The API refused the token's shape: it is no token it ever sent.
        showTokenInvalid("unknown");
        return;
      }
      if (state.code === "EMAIL_ALREADY_REGISTERED") {
        show(authState("email-taken", t("auth.verifyTaken")), { hint: t("auth.verifyTakenHint") });
        return;
      }
      const failure = failureState(error);
      // The token was not used: trying again with it is safe (the call carries its own Idempotency-Key).
      show(failure.state, {
        requestId: failure.requestId,
        contact: true,
        onRetry: () => void verify().catch(report),
      });
      return;
    }
    loading.hidden = true;
    if (!destroyed) {
      live.clear();
      showVerified(result);
    }
  };

  /** @param {SubmitEvent} event */
  const onResend = (event) => {
    event.preventDefault();
    const resend = client.auth.resendVerification;
    if (typeof resend !== "function") {
      return;
    }
    withSubmitState(resendForm, async () => {
      clearFieldErrors(resendForm);
      resendState.replaceChildren();
      resendStatus.hidden = true;
      const email = String(serialize(resendForm)["email"] ?? "").trim();
      if (session === null && email === "") {
        showFieldErrors(resendForm, [{ path: "/email", code: "required" }]);
        return;
      }
      try {
        await resend.call(client.auth, session === null ? { email } : {});
      } catch (error) {
        if (isAborted(error)) {
          return;
        }
        const state = pageStateFor(error);
        if (state.name === "validation" && state.fieldErrors.length > 0) {
          showFieldErrors(resendForm, state.fieldErrors);
          return;
        }
        const failure = failureState(error);
        show(failure.state, { requestId: failure.requestId, box: resendState, contact: true });
        return;
      }
      resendStatus.textContent = t("auth.resent");
      resendStatus.hidden = false;
      live.announce(t("auth.resent"));
    }).catch(report);
  };
  resendForm.addEventListener("submit", onResend);

  const done = (async () => {
    if (token === null || !VERIFICATION_TOKEN.test(token)) {
      if (token === null) {
        show(authState("no-token", t("auth.verifyNoToken")), { hint: t("auth.verifyNoTokenHint") });
        offerResend();
      } else {
        showTokenInvalid("unknown");
      }
      return;
    }
    await verify();
  })().catch(report);

  return {
    done,
    destroy() {
      destroyed = true;
      resendForm.removeEventListener("submit", onResend);
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
