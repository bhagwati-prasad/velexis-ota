// The traveller's session on the storefront (ota/frontend/README.md §5.1 point 3, ota/frontend/docs/pages-account.md
// §1 and §5, OADR-0006). Sessions are httpOnly cookies set by the API; the page only learns the outcome through
// `auth.getSession`: the customer and session metadata, or `401` when nobody is signed in. Nothing here reads, stores
// or logs a token.
//
// `auth.getSession` arrives with the `auth` namespace of the SDK (SDK-008): a client without it treats everybody as a
// visitor and makes no request. The account menu of the header comes from the session: a sign-in link back to the
// current page when signed out; the customer's first name, a link to the account page and "Sign out" when signed in
// (`auth.signOut`, then the home page, as the account page's sign-out does).
//
// The authentication pages (sign-in, sign-up, e-mail verification, forgotten and new password, OFE-009) share the rest
// of this module: where a page goes once the customer is signed in (`nextTarget`: a `next` parameter only when it is
// a path on this storefront, anything else goes to `/`, and `/account/` without one), the links between those pages
// that keep `next`, the password rules shown up front, the field errors of `422 PASSWORD_TOO_WEAK`, and the hint and
// links that complete a page state of src/boot.js `renderState`.

import { mount as mountLiveRegion } from "../components/live-region.js";
import { pageStateFor } from "./errors.js";
import { t } from "./i18n.js";
import { currentPath, getParam, safeNext, withQuery } from "./url.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["AuthSessionInfo"]} SessionInfo */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontPasswordPolicy"]} PasswordPolicy */
/** @typedef {import("@velexis/ota-sdk").Schemas["FieldError"]} FieldError */
/** @typedef {import("./errors.js").PageState} PageState */
/**
 * The SDK client as far as sessions need it: `auth.getSession` for the session, `auth.signOut` for the account menu;
 * both optional (without them everybody is a visitor, and the menu offers no sign-out).
 * @typedef {{ auth?: { getSession?: (params?: object, options?: object) => Promise<SessionInfo>, signOut?: (params?: object, options?: object) => Promise<void> } }} SessionClient
 */
/**
 * A link or a button that a page adds under a state (`decorateState`).
 * @typedef {{ label: string, href: string } | { label: string, action: string, onClick: (button: HTMLButtonElement) => void }} StateAction
 */

/** The sign-in page. */
export const SIGN_IN_PATH = "/account/sign-in.html";
/** The sign-up page. */
export const SIGN_UP_PATH = "/account/sign-up.html";
/** The page that sends a password-reset link. */
export const FORGOT_PASSWORD_PATH = "/account/forgot-password.html";
/** The account page (account/index.html). */
export const ACCOUNT_PATH = "/account/";
/** Where the account menu's sign-out leads (pages-account.md §6). */
export const HOME_PATH = "/";
/** `returnPath` of the contract's `SignUpRequest`, `PasswordResetRequest` and `EmailVerificationResendRequest`. */
const RETURN_PATH = /^\/([A-Za-z0-9][A-Za-z0-9._~%/?=&_-]*)?$/;
const MAX_RETURN_PATH_LENGTH = 512;
/** The page states the authentication pages show as they are (`failureState`). */
const SHOWN_STATES = new Set([
  "suspended",
  "unknown-host",
  "unavailable",
  "rate-limited",
  "feature-disabled",
]);
/** The field-error codes of lib/i18n.js for the rules in `details.violations` of `422 PASSWORD_TOO_WEAK`. */
const VIOLATION_CODES = Object.freeze({
  minLength: "PASSWORD_TOO_SHORT",
  maxLength: "PASSWORD_TOO_LONG",
  breached: "PASSWORD_BREACHED",
  sameAsCurrent: "PASSWORD_SAME_AS_CURRENT",
});

/**
 * Reports an error of an optional part of the page (the browser's console and `error` event) without breaking it.
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
 * Where an authentication page sends the customer once signed in: the `next` parameter of `search` when it is a path
 * on this storefront (lib/url.js `safeNext`: `next=https://evil.example` and every other way off it give `/`), and
 * the account page when there is no `next` at all.
 * @param {string | URLSearchParams} [search] default: the current page's
 * @returns {string}
 */
export function nextTarget(search = globalThis.location?.search ?? "") {
  const next = getParam("next", search);
  return next === null ? ACCOUNT_PATH : safeNext(next);
}

/**
 * `path` with the `next` of `search` when it has one (as `nextTarget` would follow it), so the links between sign-in,
 * sign-up and the password reset lead to the same place in the end.
 * @param {string} path
 * @param {string | URLSearchParams} [search] default: the current page's
 */
export function withNext(path, search = globalThis.location?.search ?? "") {
  const next = getParam("next", search);
  return next === null ? path : withQuery(path, { next: safeNext(next) });
}

/**
 * The `returnPath` that sign-up and the e-mail requests send: the safe `next` of `search` when it fits the contract's
 * `returnPath` (`SignUpRequest`: at most 512 characters of `^/([A-Za-z0-9][A-Za-z0-9._~%/?=&_-]*)?$`, so no comma
 * list or fragment), else `undefined`. The API does not keep it (the e-mail links are fixed, OADR-0015 point 5): a
 * value it would refuse is left out rather than failing the request.
 * @param {string | URLSearchParams} [search] default: the current page's
 * @returns {string | undefined}
 */
export function returnPathOf(search = globalThis.location?.search ?? "") {
  const next = getParam("next", search);
  const path = next === null ? null : safeNext(next);
  return path !== null && path.length <= MAX_RETURN_PATH_LENGTH && RETURN_PATH.test(path) ? path : undefined;
}

/**
 * Points every `a[data-keep-next]` inside `root` at its own page with the `next` of `search` (`withNext`).
 * @param {ParentNode} root
 * @param {string | URLSearchParams} [search] default: the current page's
 */
export function keepNext(root, search = globalThis.location?.search ?? "") {
  for (const link of root.querySelectorAll("a[data-keep-next]")) {
    const path = link.getAttribute("href");
    if (path !== null && path.startsWith("/")) {
      link.setAttribute("href", withNext(path.split("?")[0] ?? path, search));
    }
  }
}

/**
 * A page state of the authentication pages for src/boot.js `renderState` (inline, with the text of lib/i18n.js); the
 * name becomes the element's `data-state` (`invalid-credentials`, `account-locked`, …).
 * @param {string} name
 * @param {string} message
 * @returns {Pick<PageState, "name" | "scope" | "message">}
 */
export const authState = (name, message) =>
  /** @type {Pick<PageState, "name" | "scope" | "message">} */ ({ name, scope: "inline", message });

/**
 * The state an authentication page shows for a failure that no code of its own explains: the shared states of
 * pages.md §2 as they are (unavailable, `429` with the shared message, suspended, unknown host, `403
 * FEATURE_DISABLED`), anything else "Something went wrong" with the request id to quote to support.
 * @param {unknown} error
 * @returns {{ state: PageState, requestId: string | null }}
 */
export function failureState(error) {
  const state = pageStateFor(error);
  if (SHOWN_STATES.has(state.name)) {
    return { state: { ...state, scope: "inline" }, requestId: null };
  }
  const requestId =
    error instanceof Error &&
    "requestId" in error &&
    typeof error.requestId === "string" &&
    error.requestId !== ""
      ? error.requestId
      : null;
  return {
    state: { ...state, name: "unexpected", scope: "inline", message: t("state.unexpected") },
    requestId,
  };
}

/**
 * The password rules of the OTA as one text for the hint next to a new password (shown before the customer types,
 * pages-account.md §5): the length, any composition rule, and that common or leaked passwords are refused.
 * @param {Partial<PasswordPolicy> | null | undefined} policy `config.auth.passwordPolicy`
 * @returns {string}
 */
export function passwordRules(policy) {
  const min = typeof policy?.minLength === "number" && policy.minLength > 0 ? policy.minLength : 10;
  const rules = [t("auth.rule.minLength", { count: min })];
  if (policy?.requireUppercase) {
    rules.push(t("auth.rule.uppercase"));
  }
  if (policy?.requireLowercase) {
    rules.push(t("auth.rule.lowercase"));
  }
  if (policy?.requireDigit) {
    rules.push(t("auth.rule.digit"));
  }
  if (policy?.requireSymbol) {
    rules.push(t("auth.rule.symbol"));
  }
  if (policy?.rejectBreached !== false) {
    rules.push(t("auth.rule.breached"));
  }
  return rules.join(" ");
}

/**
 * The field errors to show for `422 PASSWORD_TOO_WEAK`: one on the password field (the API's pointer, else `pointer`)
 * whose code names the first broken rule of `details.violations` (lib/i18n.js says it without quoting the password),
 * and the API's other field errors.
 * @param {unknown} error
 * @param {string} pointer the password field's JSON pointer (`/password`, `/newPassword`)
 * @returns {FieldError[]}
 */
export function passwordFieldErrors(error, pointer) {
  const { details, fieldErrors } = pageStateFor(error);
  const violations = Array.isArray(details?.["violations"]) ? details["violations"] : [];
  const rule = violations.find((violation) => Object.hasOwn(VIOLATION_CODES, String(violation)));
  const code =
    rule === undefined
      ? "PASSWORD_TOO_WEAK"
      : VIOLATION_CODES[/** @type {keyof typeof VIOLATION_CODES} */ (rule)];
  const own = fieldErrors.find((fieldError) => fieldError.code === "too_weak");
  const path = typeof own?.path === "string" ? own.path : pointer;
  return [
    { path, code, message: "" },
    ...fieldErrors.filter((fieldError) => fieldError !== own && fieldError.path !== path),
  ];
}

/**
 * Completes a state element of src/boot.js `renderState`: its hint line (`[data-field="hint"]`), and links or buttons
 * in one paragraph before its Retry button (or at its end). Everything is built with createElement and textContent.
 * Returns the paragraph of the actions, or `null` without any.
 * @param {HTMLElement} element
 * @param {{ hint?: string | null, actions?: ReadonlyArray<StateAction> }} extras
 * @returns {HTMLParagraphElement | null}
 */
export function decorateState(element, { hint = null, actions = [] }) {
  const doc = element.ownerDocument;
  if (hint !== null && hint !== "") {
    /** @type {HTMLElement | null} */
    let line = element.querySelector('[data-field="hint"]');
    if (!line) {
      line = doc.createElement("p");
      line.dataset.field = "hint";
      element.querySelector('[data-field="title"]')?.after(line);
    }
    line.textContent = hint;
    line.hidden = false;
  }
  if (actions.length === 0) {
    return null;
  }
  const paragraph = doc.createElement("p");
  paragraph.className = "mt-3 flex flex-wrap gap-x-6 gap-y-2";
  paragraph.dataset.stateActions = "";
  for (const entry of actions) {
    if ("href" in entry) {
      const link = doc.createElement("a");
      link.href = entry.href;
      link.className = "min-h-6 font-medium text-primary underline underline-offset-4";
      link.textContent = entry.label;
      paragraph.append(link);
    } else {
      const button = doc.createElement("button");
      button.type = "button";
      button.dataset.action = entry.action;
      button.className = "min-h-6 font-medium text-primary underline underline-offset-4";
      button.textContent = entry.label;
      button.addEventListener("click", () => entry.onClick(button));
      paragraph.append(button);
    }
  }
  const retry = element.querySelector('[data-action="retry"]')?.closest("p");
  if (retry) {
    retry.before(paragraph);
  } else {
    element.append(paragraph);
  }
  return paragraph;
}

/**
 * The name the account menu greets the customer with: the first name, else nothing.
 * @param {SessionInfo["customer"] | null | undefined} customer
 * @returns {string | null}
 */
function firstNameOf(customer) {
  const name = typeof customer?.firstName === "string" ? customer.firstName.trim() : "";
  return name === "" ? null : name;
}

/** The id of the signed-in account menu's panel, which its toggle button controls (one header per page). */
export const ACCOUNT_MENU_PANEL_ID = "vx-account-menu";

/**
 * The cap of the signed-in greeting in the navigation's row from `lg` (1024 px): at most 12rem (192 px) wide, a longer
 * greeting cut with an ellipsis (`truncate`: one line, `overflow: hidden`, `text-overflow: ellipsis`). The row's widest
 * content, "Find a booking", "My bookings", the greeting at its cap, "My account" and "Sign out", is then about 590 px
 * (with the bundled Inter), which leaves the OTA's name more than its 8rem beside two currencies at 1024 px, so a first
 * name of up to 60 characters never wraps the row, while "Hi, " and a 23-character first name (184 px) are not cut
 * (ota/docs/storefront-accessibility.md §3.8, lead decision (21h) of 2026-11-13). Below `lg` nothing applies: the
 * panel shows the greeting whole.
 */
export const GREETING_CAP_CLASSES = "lg:max-w-48 lg:truncate";

/**
 * What undoes the listeners of the account menu rendered into a slot (the document's, for a press outside), run before
 * the slot is rendered again.
 * @type {WeakMap<Element, () => void>}
 */
const menuCleanups = new WeakMap();

/** The chevron of the account menu's toggle (the one of the results page's "Filters" disclosure). */
const CHEVRON_PATH =
  "M5.22 7.22a.75.75 0 0 1 1.06 0L10 10.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 8.28a.75.75 0 0 1 0-1.06Z";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** What a press can give the focus to deliberately: a control or its label, or an element in the keyboard's order. */
const CONTROLS =
  'a[href], button, input, select, textarea, label, summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * The compact account menu's toggle button, shown below `lg` (1024 px; below `md` until OFE-032): "Account" and a
 * chevron, a disclosure (`aria-expanded`, `aria-controls`) at least 24 px high (2.5.8) whose negative margins keep the
 * navigation's line as high as the "Sign in" link's, so that taking that link's place moves nothing (OFE-031).
 * @param {Document} doc
 */
function accountMenuToggle(doc) {
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.dataset.accountMenuToggle = "";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", ACCOUNT_MENU_PANEL_ID);
  toggle.className =
    "group peer -my-0.5 inline-flex min-h-6 items-center gap-1 underline-offset-4 hover:underline lg:hidden";
  const label = doc.createElement("span");
  label.textContent = t("account.menu");
  const chevron = doc.createElementNS(SVG_NAMESPACE, "svg");
  chevron.setAttribute("aria-hidden", "true");
  chevron.setAttribute("focusable", "false");
  chevron.setAttribute("viewBox", "0 0 20 20");
  chevron.setAttribute("fill", "currentColor");
  chevron.setAttribute("class", "size-4 shrink-0 group-aria-expanded:rotate-180");
  const path = doc.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("d", CHEVRON_PATH);
  chevron.append(path);
  toggle.append(label, chevron);
  return toggle;
}

/**
 * Fills the header's account menu slot (`[data-slot="account-menu"]`) for the session, with createElement and
 * textContent:
 * - signed out: a sign-in link (`next` back to the current page, `signInHref`);
 * - signed in: "Hi, <first name>", a link to the account page and, when the client has `auth.signOut`, a "Sign out"
 *   button. Sign-out ends the session (`auth.signOut`: the API revokes it and clears the cookies), shows the signed-out
 *   menu and goes to the home page; a `401` (the session had already ended) counts as signed out. Any other failure
 *   keeps the menu and says so in the live region.
 *
 * From `lg` (1024 px) the signed-in links stand in the navigation's row, as they always have. Below `lg` they may
 * not fit beside "Find a booking" and "My bookings": on a phone, and from 768 to about 850 px with a long first name,
 * the row wrapped and moved the page when `auth.getSession` answered, after the first paint
 * (ota/docs/storefront-accessibility.md §2 finding 5 and §3.8). There they sit in a panel behind one compact
 * "Account" button, in the place the "Sign in" link has from the first paint (OFE-031 below `md`, OFE-032 below
 * `lg`). The button is a disclosure: it opens and closes the panel (`aria-expanded`, `aria-controls`; CSS shows the
 * panel, `peer-aria-expanded`, floating under the navigation, so opening it moves nothing either). Escape closes it
 * and puts the focus back on the button, wherever the focus was, as does a press outside (mouse, pen or touch),
 * unless it was on another control, which then takes the focus, or never became a click (a touch that scrolled the
 * page); the focus moving on past the menu closes it, so it never covers the focused element (2.4.11). One set of
 * links serves both widths: from `lg` the button is not shown and the panel is the row's inline group.
 *
 * From `lg` the greeting's width is capped (GREETING_CAP_CLASSES) and a longer first name ends in an ellipsis, so a
 * first name of up to 60 characters (the contract's longest) never wraps the navigation's row when the session
 * answers, at any width from 1024 px (lead decision (21h) of 2026-11-13, after OFE-032's review). The whole greeting
 * stays in the DOM, which screen readers read, and in the greeting's `title`; below `lg` the panel shows it whole,
 * wrapping, as before.
 * @param {Element} slot
 * @param {SessionInfo | null} session
 * @param {{ location?: Location, client?: SessionClient | null, navigate?: (url: string) => void }} [options]
 *   `navigate` for tests (default `location.assign`)
 */
export function renderAccountMenu(slot, session, options = {}) {
  const doc = slot.ownerDocument;
  const location = options.location ?? doc.defaultView?.location ?? globalThis.location;
  const { client = null } = options;
  menuCleanups.get(slot)?.();
  menuCleanups.delete(slot);
  const link = doc.createElement("a");
  link.className = "underline-offset-4 hover:underline";
  if (!session) {
    link.href = signInHref(location);
    link.textContent = t("account.signIn");
    slot.replaceChildren(link);
    return;
  }
  link.href = ACCOUNT_PATH;
  link.textContent = t("account.account");
  link.dataset.signedIn = "true";
  link.className = "underline-offset-4 hover:underline max-lg:block max-lg:min-h-6 max-lg:px-2 max-lg:py-1.5";
  const toggle = accountMenuToggle(doc);
  const group = doc.createElement("div");
  group.id = ACCOUNT_MENU_PANEL_ID;
  group.dataset.accountMenuPanel = "";
  // From lg: the navigation row's inline group. Below lg: not shown until the toggle is expanded, then a panel floating
  // under the navigation (partials/header.html: `nav` is its containing block), at its right edge and never wider.
  group.className =
    "lg:inline-flex lg:flex-wrap lg:items-baseline lg:gap-x-4 lg:gap-y-1 " +
    "max-lg:absolute max-lg:top-full max-lg:right-0 max-lg:z-20 max-lg:mt-2 max-lg:hidden max-lg:w-max " +
    "max-lg:max-w-full max-lg:flex-col max-lg:gap-1 max-lg:rounded-ui max-lg:border max-lg:border-current " +
    "max-lg:bg-secondary max-lg:p-2 max-lg:text-on-secondary max-lg:shadow-lg max-lg:peer-aria-expanded:flex";
  const name = firstNameOf(session.customer);
  if (name !== null) {
    const greeting = doc.createElement("span");
    greeting.dataset.customerName = "";
    // Below lg a long name wraps in the panel and is never cut; from lg it ends in an ellipsis at the cap, the whole
    // greeting in the DOM and in the title.
    greeting.className =
      "wrap-anywhere max-lg:block max-lg:px-2 max-lg:py-1 max-lg:font-medium " + GREETING_CAP_CLASSES;
    greeting.textContent = t("account.greeting", { name });
    greeting.title = greeting.textContent;
    group.append(greeting);
  }
  group.append(link);

  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";
  /**
   * Forgets a press outside whose click never came: a touch that became a scroll (`pointercancel`), or a press that
   * ended elsewhere before the next one began. Without this, a click long after (on the page's text, or on a button
   * of a browser that does not focus a pressed button) would take the focus back up to the toggle.
   */
  const forgetPress = () => {
    doc.removeEventListener("click", onClickAfterPress, true);
    doc.removeEventListener("pointercancel", forgetPress, true);
    doc.removeEventListener("pointerdown", forgetPress, true);
  };
  /**
   * The click that ends a press outside the menu on no control: the browser has moved the focus by then (to the body,
   * or to `main`, which only scripts focus, `tabindex="-1"`), and it goes back to the toggle unless it is on a control.
   */
  const onClickAfterPress = () => {
    forgetPress();
    const active = doc.activeElement;
    if (active === null || !active.matches(CONTROLS)) {
      toggle.focus();
    }
  };
  /**
   * A press (mouse, pen or touch) while the panel is open: outside the menu it closes the panel, before the focus
   * moves. On another control the focus is left to the browser, which gives it to that control; elsewhere the click
   * that follows gives it back to the toggle, unless the press is cancelled or another press begins first.
   * @param {Event} event
   */
  const onPressOutside = (event) => {
    const target = /** @type {Element | null} */ (event.target);
    if (target && slot.contains(target)) {
      return;
    }
    close();
    if (!(typeof target?.closest === "function" && target.closest(CONTROLS) !== null)) {
      // Listeners added while this `pointerdown` is dispatched do not run for it (DOM: the list is cloned first).
      doc.addEventListener("click", onClickAfterPress, true);
      doc.addEventListener("pointercancel", forgetPress, true);
      doc.addEventListener("pointerdown", forgetPress, true);
    }
  };
  /**
   * Closes the panel; with `focus`, the focus goes back to the toggle.
   * @param {boolean} [focus]
   */
  const close = (focus = false) => {
    doc.removeEventListener("pointerdown", onPressOutside, true);
    doc.removeEventListener("keydown", onKeyDown);
    if (!isOpen()) {
      return;
    }
    toggle.setAttribute("aria-expanded", "false");
    if (focus) {
      toggle.focus();
    }
  };
  const onToggle = () => {
    if (isOpen()) {
      close();
      return;
    }
    forgetPress();
    toggle.setAttribute("aria-expanded", "true");
    doc.addEventListener("pointerdown", onPressOutside, true);
    doc.addEventListener("keydown", onKeyDown);
  };
  /**
   * Escape while the panel is open, wherever the focus is: in the menu, or still on the page's body after a pointer
   * opened it in a browser that does not focus a pressed button (Safari, and Firefox on macOS).
   * @param {KeyboardEvent} event
   */
  const onKeyDown = (event) => {
    if (event.key === "Escape" && !event.defaultPrevented && isOpen()) {
      event.preventDefault();
      close(true);
    }
  };
  /** @param {FocusEvent} event */
  const onFocusOut = (event) => {
    const next = /** @type {Node | null} */ (event.relatedTarget);
    // Tab past "Sign out", Shift+Tab past the toggle, or a script that moves the focus elsewhere. Without a next
    // element (another window) the panel stays.
    if (next !== null && !slot.contains(next)) {
      close();
    }
  };
  toggle.addEventListener("click", onToggle);
  slot.addEventListener("focusout", onFocusOut);
  menuCleanups.set(slot, () => {
    doc.removeEventListener("pointerdown", onPressOutside, true);
    doc.removeEventListener("keydown", onKeyDown);
    forgetPress();
    slot.removeEventListener("focusout", onFocusOut);
  });

  const auth = client?.auth;
  const signOut = auth?.signOut;
  if (typeof signOut === "function") {
    const navigate = options.navigate ?? ((/** @type {string} */ url) => location.assign(url));
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.action = "sign-out";
    button.className =
      "underline-offset-4 hover:underline aria-disabled:opacity-60 " +
      "max-lg:block max-lg:min-h-6 max-lg:w-full max-lg:px-2 max-lg:py-1.5 max-lg:text-left";
    button.textContent = t("account.signOut");
    button.addEventListener("click", async () => {
      if (button.getAttribute("aria-disabled") === "true") {
        return;
      }
      const live = mountLiveRegion(doc.body);
      button.setAttribute("aria-disabled", "true");
      button.textContent = t("account.signingOut");
      try {
        await signOut.call(auth);
      } catch (error) {
        if (pageStateFor(error).name !== "signed-out") {
          report(error);
          button.removeAttribute("aria-disabled");
          button.textContent = t("account.signOut");
          live.announce(t("account.signOutFailed"));
          return;
        }
      }
      renderAccountMenu(slot, null, { location, client, navigate });
      live.announce(t("account.signedOut"));
      navigate(HOME_PATH);
    });
    group.append(button);
  }
  slot.replaceChildren(toggle, group);
}
