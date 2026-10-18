// The traveller's session on the storefront (ota/frontend/README.md §5.1 point 3, ota/frontend/docs/pages-account.md
// §1, OADR-0006). Sessions are httpOnly cookies set by the API; the page only learns the outcome through
// `auth.getSession`: the customer and session metadata, or `401` when nobody is signed in. Nothing here reads, stores
// or logs a token.
//
// `auth.getSession` arrives with the `auth` namespace of the SDK (SDK-008, M3): until the client has it, everybody is a
// visitor and no request is made. The account menu of the header comes from the session: a sign-in link back to the
// current page when signed out, a link to the account page when signed in (OFE-009 adds the name and sign-out).

import { t } from "./i18n.js";
import { currentPath, withQuery } from "./url.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["AuthSessionInfo"]} SessionInfo */
/**
 * The SDK client as far as sessions need it: `auth.getSession` is optional until SDK-008.
 * @typedef {{ auth?: { getSession?: (params?: object, options?: object) => Promise<SessionInfo> } }} SessionClient
 */

/** The sign-in page. */
export const SIGN_IN_PATH = "/account/sign-in.html";
/** The account page (account/index.html). */
export const ACCOUNT_PATH = "/account/";

/**
 * The current customer session, or `null` for a visitor. `null` too when the client has no `auth.getSession` yet,
 * when the API answers `401` (signed out; the SDK has already tried one refresh), and on any other failure: the
 * account menu then offers sign-in, and the pages that need a customer ask again.
 * @param {SessionClient} client
 * @returns {Promise<SessionInfo | null>}
 */
export async function loadSession(client) {
  const getSession = client.auth?.getSession;
  if (typeof getSession !== "function") {
    return null;
  }
  try {
    return (await getSession.call(client.auth)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The sign-in link of the current page: `/account/sign-in.html?next=<path and query>`, without `next` on the account
 * pages themselves (sign-in, sign-up, …), whose `next` would lead back to a form.
 * @param {Location} [location]
 */
export function signInHref(location = globalThis.location) {
  const here = currentPath(location);
  return location.pathname.startsWith("/account/") || here === "/"
    ? SIGN_IN_PATH
    : withQuery(SIGN_IN_PATH, { next: here });
}

/**
 * Fills the header's account menu slot (`[data-slot="account-menu"]`) for the session: a sign-in link when signed out,
 * a link to the account page when signed in. Built with createElement and textContent.
 * @param {Element} slot
 * @param {SessionInfo | null} session
 * @param {{ location?: Location }} [options]
 */
export function renderAccountMenu(slot, session, { location = globalThis.location } = {}) {
  const link = slot.ownerDocument.createElement("a");
  link.className = "underline-offset-4 hover:underline";
  if (session) {
    link.href = ACCOUNT_PATH;
    link.textContent = t("account.account");
    link.dataset.signedIn = "true";
  } else {
    link.href = signInHref(location);
    link.textContent = t("account.signIn");
  }
  slot.replaceChildren(link);
}
