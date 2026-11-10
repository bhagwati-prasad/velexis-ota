// Shared start-up of every storefront page (ota/frontend/README.md §5.1, docs/pages.md §2, docs/pages-account.md §8).
// A page's module awaits `boot()` and runs with what it returns:
//
//   const { config, session, client } = await boot();
//
// 1. The configuration: `storefront.get` through lib/config.js (5 minutes in sessionStorage). While it loads, the live
//    region says "Loading" (only when it takes a moment).
// 2. On the sign-in and sign-up pages of the OTA's sub-domain, when its primary host is a custom domain: the same page
//    on that host (lib/primary-host.js, OFE-021, OADR-0006 Follow-ups), before any session is created. boot() then
//    never resolves, so the page module does not run, and `location.replace` keeps the sub-domain's page out of the
//    history. Every other page works on both hosts.
// 3. Then, at once: the theme (lib/theme.js), the header (name, logo, currency selector, account menu), the footer
//    (legal links, the content pages of `storefront.listPages` with `showInFooter` once they arrive, their failure
//    ignored, support contacts), the environment (`applyEnvironment`: only `environment = live` hides the test banner
//    and takes away the `noindex` of a test storefront; `test`, and any value this build does not know, shows the
//    banner and adds `noindex`; the banner is fixed to the bottom of the window with its space after the end of the
//    page, so showing it this late moves nothing already painted, OFE-028), and `auth.getSession` for the account menu
//    (`401` = signed out; called only when the SDK has the `auth` namespace, SDK-008, and the OTA has customer
//    accounts). A component that fails is reported and skipped: it never stops the page.
// 4. `client` is the SDK client for the page's calls: with the currency the traveller chose in the header
//    (`localStorage`, `client.withOptions({ currency })`, sent as `X-Currency`), else the shared client. Choosing
//    another currency stores it and dispatches `vx:currency-change` on the document with `{ currency, client }`; the
//    pages that show prices decide whether to search again (README §7).
//
// When `storefront.get` fails, the page content is replaced by a full-page state (partials/states.html) and the page
// module does not run: "temporarily unavailable" for `403 TENANT_SUSPENDED`, "this storefront does not exist" for
// `403 HOST_NOT_ALLOWED` (both final, kept out of search engines), and for `503`, connection failures, `429` and any
// other error a state with Retry (enabled after `Retry-After` for `429`). A successful retry puts the page content
// back, untouched, and boot() carries on. Pages render the same states for their own calls with `renderState`.

import { mount as mountFooter, supportEmail } from "./components/footer.js";
import { mount as mountHeader } from "./components/header.js";
import { mount as mountLiveRegion } from "./components/live-region.js";
import { mount as mountTestBanner } from "./components/test-banner.js";
import { client as storefrontClient } from "./lib/client.js";
import { clearCachedConfig, loadConfig } from "./lib/config.js";
import { clone, fill } from "./lib/dom.js";
import { pageStateFor } from "./lib/errors.js";
import { hasString, t } from "./lib/i18n.js";
import { primaryHostRedirect } from "./lib/primary-host.js";
import { loadSession } from "./lib/session.js";
import { applyTheme } from "./lib/theme.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("./lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("./lib/config.js").ConfigStorage} ConfigStorage */
/** @typedef {import("./lib/errors.js").PageState} PageState */
/** @typedef {import("./lib/session.js").SessionInfo} SessionInfo */
/** @typedef {import("./lib/session.js").SessionClient} SessionClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontSupport"]} StorefrontSupport */
/** @typedef {Pick<VelexisClient, "storefront" | "withOptions"> & SessionClient} BootClient */
/** @typedef {Pick<Storage, "getItem" | "setItem">} PreferenceStorage */
/**
 * What a page module runs with.
 * @typedef {object} BootContext
 * @property {StorefrontConfig} config the storefront configuration
 * @property {SessionInfo | null} session the customer session, `null` for a visitor
 * @property {BootClient} client the SDK client for the page's calls, with the chosen currency
 */

/** The localStorage key of the traveller's currency choice. */
export const CURRENCY_STORAGE_KEY = "vx.currency";
/** The document event of a currency change: `detail` is `{ currency, client }`. */
export const CURRENCY_CHANGE_EVENT = "vx:currency-change";

/** The states boot shows for a failed `storefront.get`; any other error is `unexpected`. */
const BOOT_STATES = new Set(["suspended", "unknown-host", "unavailable", "rate-limited", "unexpected"]);
/** Boot states without Retry: the storefront is suspended or unknown, and trying again changes nothing. */
const FINAL_STATES = new Set(["suspended", "unknown-host"]);

/**
 * Reports an error of an optional part of the page (the browser's console and `error` event) without stopping boot.
 * @param {unknown} error
 */
function report(error) {
  try {
    globalThis.reportError?.(error);
  } catch {
    // Nothing else to do: the page carries on without that part.
  }
}

/**
 * Runs one optional step of boot; a failure is reported and gives `null`.
 * @template T
 * @param {() => T} step
 * @returns {T | null}
 */
function safely(step) {
  try {
    return step();
  } catch (error) {
    report(error);
    return null;
  }
}

/**
 * The page's localStorage for preferences, or `null` when the browser refuses it.
 * @returns {PreferenceStorage | null}
 */
function preferenceStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The traveller's remembered currency when the storefront still offers it, else `null` (the default currency).
 * @param {StorefrontConfig} config
 * @param {PreferenceStorage | null} [storage]
 * @returns {string | null}
 */
export function rememberedCurrency(config, storage = preferenceStorage()) {
  /** @type {string | null} */
  let code = null;
  try {
    code = storage?.getItem(CURRENCY_STORAGE_KEY) ?? null;
  } catch {
    // Storage refused: the default currency.
  }
  const offered = Array.isArray(config.currencies) ? config.currencies : [];
  return code !== null && offered.some((currency) => currency.code === code) ? code : null;
}

/**
 * Remembers the currency choice; a storage that refuses it changes nothing (the choice lasts for this page).
 * @param {string} code
 * @param {PreferenceStorage | null} storage
 */
function rememberCurrency(code, storage) {
  try {
    storage?.setItem(CURRENCY_STORAGE_KEY, code);
  } catch {
    // Quota exceeded, private mode or storage blocked.
  }
}

/**
 * The client that sends `currency` as `X-Currency`, or `client` itself without a currency (or if the SDK refuses it).
 * @param {BootClient} client
 * @param {string | null} currency
 * @returns {BootClient}
 */
function clientFor(client, currency) {
  if (currency === null) {
    return client;
  }
  try {
    return client.withOptions({ currency });
  } catch (error) {
    report(error);
    return client;
  }
}

/**
 * Adds `noindex` to the page's robots meta tag (created when the page has none).
 * @param {Document} doc
 */
export function markNoindex(doc) {
  let meta = /** @type {HTMLMetaElement | null} */ (doc.head.querySelector('meta[name="robots"]'));
  if (!meta) {
    meta = doc.createElement("meta");
    meta.name = "robots";
    doc.head.append(meta);
  }
  const directives = meta.content
    .split(",")
    .map((directive) => directive.trim().toLowerCase())
    .filter((directive) => directive !== "" && directive !== "index" && directive !== "all");
  meta.content = [...new Set(["noindex", ...directives])].join(", ");
}

/**
 * The attribute boot puts on the robots meta tag when it marks a test storefront `noindex`: its value is what the
 * page's own tag said before (empty when the page had none, so boot created the tag).
 */
const TEST_NOINDEX_ATTRIBUTE = "data-vx-test-noindex";

/**
 * Shows the storefront's environment on the page (README §2 point 4, OADR-0012 point 8, OFE-021). Only
 * `environment = live` hides the "Test mode" banner and takes away the `noindex` that a test storefront's pages get;
 * `test`, and any value this build does not know, shows the banner and adds `noindex`, so a storefront never looks real
 * unless the API says it is live. The page's own robots meta tag (the private and short-lived pages carry `noindex` in
 * their HTML) is kept in both environments: live gives it back as the page had it. The banner shows over the bottom of
 * the window, with its height as space after the page (components/test-banner.js, OFE-028), so the page painted before
 * `storefront.get` answered does not move; a live storefront keeps no such space.
 * @param {Document} doc
 * @param {unknown} environment `config.environment`
 */
export function applyEnvironment(doc, environment) {
  const live = environment === "live";
  safely(() => mountTestBanner(doc.body, { environment: live ? "live" : "test" }));
  safely(() => {
    const marked = doc.head.querySelector(`meta[name="robots"][${TEST_NOINDEX_ATTRIBUTE}]`);
    if (live) {
      const own = marked?.getAttribute(TEST_NOINDEX_ATTRIBUTE) ?? "";
      if (marked && own === "") {
        marked.remove();
      } else if (marked) {
        marked.setAttribute("content", own);
        marked.removeAttribute(TEST_NOINDEX_ATTRIBUTE);
      }
    } else if (!marked) {
      const own = doc.head.querySelector('meta[name="robots"]')?.getAttribute("content")?.trim() ?? "";
      markNoindex(doc);
      doc.head.querySelector('meta[name="robots"]')?.setAttribute(TEST_NOINDEX_ATTRIBUTE, own);
    }
  });
}

/**
 * Sends the page to `target` on the OTA's primary custom domain (lib/primary-host.js) and keeps it from being used
 * meanwhile: the main content is made inert and busy, and the live region keeps saying "Loading". Returns `false` when
 * the browser refuses the navigation (reported): the page is given back and starts here.
 * @param {Document} doc
 * @param {string} target
 * @param {(url: string) => void} navigate
 * @returns {boolean}
 */
function leaveFor(doc, target, navigate) {
  const main = doc.querySelector("main");
  main?.setAttribute("inert", "");
  main?.setAttribute("aria-busy", "true");
  try {
    navigate(target);
    return true;
  } catch (error) {
    report(error);
    main?.removeAttribute("inert");
    main?.removeAttribute("aria-busy");
    return false;
  }
}

/**
 * The state element when the page has no states partial: its title and, with `onRetry`, a Retry button.
 * @param {Document} doc
 * @param {"page" | "inline"} scope
 * @param {string} title
 */
function fallbackStateElement(doc, scope, title) {
  const element = doc.createElement(scope === "page" ? "section" : "div");
  element.dataset.state = "";
  const heading = doc.createElement(scope === "page" ? "h1" : "p");
  heading.tabIndex = -1;
  heading.dataset.field = "title";
  heading.textContent = title;
  const button = doc.createElement("button");
  button.type = "button";
  button.dataset.action = "retry";
  button.textContent = t("app.retry");
  element.append(heading, button);
  return element;
}

/**
 * Renders a page state into `container` (replacing its content) from partials/states.html: `tpl-state-page` (an `h1`,
 * for boot's full-page states) or `tpl-state-inline`. The title is the state's text of lib/i18n.js, with a hint for
 * some states; the support address appears when given and real (never the `.invalid` placeholder), the request id when
 * given (for "Something went wrong"), and a Retry button when `onRetry` is given. For `rate-limited` the button is
 * enabled after `retryAfterSeconds`. Returns the state element.
 * @param {Element} container
 * @param {Pick<PageState, "name" | "message" | "scope"> & Partial<PageState>} state from `pageStateFor(error)`
 * @param {{ scope?: "page" | "inline", support?: Partial<StorefrontSupport> | null, requestId?: string | null, onRetry?: () => void, focus?: boolean }} [options]
 *   `focus` moves the focus to the state's title (after a Retry that failed again)
 * @returns {HTMLElement}
 */
export function renderState(container, state, options = {}) {
  const { scope = state.scope, support = null, requestId = null, onRetry, focus = false } = options;
  const doc = container.ownerDocument;
  const email = supportEmail(support);
  const hintKey = `stateHint.${state.name}`;
  const hint = hasString(hintKey) ? t(hintKey) : null;
  const retry = typeof onRetry === "function";
  /** @type {HTMLElement} */
  let element;
  try {
    element = clone(scope === "page" ? "tpl-state-page" : "tpl-state-inline", doc);
  } catch {
    element = fallbackStateElement(doc, scope, state.message);
  }
  fill(element, {
    name: state.name,
    title: state.message,
    hint,
    noHint: hint === null,
    supportEmail: email,
    supportHref: email === null ? null : `mailto:${email}`,
    noSupport: email === null,
    requestId: requestId || null,
    noRequestId: !requestId,
    noRetry: !retry,
  });
  const button = /** @type {HTMLButtonElement | null} */ (element.querySelector('[data-action="retry"]'));
  if (button && !retry) {
    button.remove();
  } else if (button && onRetry) {
    const wait = state.name === "rate-limited" ? (state.retryAfterSeconds ?? 0) : 0;
    if (wait > 0) {
      button.disabled = true;
      setTimeout(() => {
        button.disabled = false;
      }, wait * 1000);
    }
    button.addEventListener("click", () => {
      if (!button.disabled) {
        button.disabled = true;
        onRetry();
      }
    });
  }
  container.replaceChildren(element);
  if (focus) {
    /** @type {HTMLElement | null} */ (element.querySelector('[tabindex="-1"]'))?.focus();
  }
  return element;
}

/**
 * Takes over the page's `<main>` for boot's full-page states: its content, the document title and the header and
 * footer navigation are put aside until `restore()` gives them back unchanged.
 * @param {Document} doc
 */
function fullPage(doc) {
  const main = /** @type {HTMLElement} */ (doc.querySelector("main") ?? doc.body);
  const content = doc.createDocumentFragment();
  content.append(...main.childNodes);
  const title = doc.title;
  const navigation = Array.from(
    doc.querySelectorAll("body > header nav, body > footer nav"),
    (nav) => /** @type {HTMLElement} */ (nav),
  ).filter((nav) => !nav.hidden);
  for (const nav of navigation) {
    nav.hidden = true;
  }
  return {
    main,
    /**
     * @param {PageState} state
     * @param {{ requestId?: string | null, onRetry?: () => void, focus?: boolean }} options
     */
    show(state, options) {
      doc.title = state.message;
      doc.body.dataset.pageState = state.name;
      return renderState(main, state, { ...options, scope: "page" });
    },
    restore() {
      main.replaceChildren(content);
      doc.title = title;
      delete doc.body.dataset.pageState;
      for (const nav of navigation) {
        nav.hidden = false;
      }
    },
  };
}

/**
 * The state boot shows for an error of `storefront.get`.
 * @param {unknown} error
 * @returns {PageState}
 */
function bootState(error) {
  const state = pageStateFor(error);
  return BOOT_STATES.has(state.name)
    ? { ...state, scope: "page" }
    : { ...state, name: "unexpected", scope: "page", message: t("state.unexpected"), retry: true };
}

/**
 * The configuration, after as many Retries as the traveller needs. A final state (suspended, unknown host) never
 * resolves: the page module does not run.
 * @param {{ client: BootClient, storage: ConfigStorage | null | undefined, doc: Document, live: ReturnType<typeof mountLiveRegion> }} deps
 * @returns {Promise<StorefrontConfig>}
 */
async function configOrState({ client, storage, doc, live }) {
  /** @type {ReturnType<typeof fullPage> | null} */
  let view = null;
  let retried = false;
  for (;;) {
    try {
      const config = await loadConfig({ client, storage });
      if (view) {
        view.restore();
        if (retried) {
          view.main.focus();
        }
      }
      return config;
    } catch (error) {
      const state = bootState(error);
      view ??= fullPage(doc);
      live.announce(state.message);
      const requestId =
        state.name === "unexpected" && error instanceof Error && "requestId" in error
          ? /** @type {{ requestId: unknown }} */ (error).requestId
          : null;
      if (FINAL_STATES.has(state.name)) {
        markNoindex(doc);
        view.show(state, { focus: retried });
        return new Promise(() => {});
      }
      await new Promise((resolve) => {
        view?.show(state, {
          requestId: typeof requestId === "string" ? requestId : null,
          onRetry: () => resolve(undefined),
          focus: retried,
        });
      });
      retried = true;
      if (storage !== null) {
        clearCachedConfig(storage);
      }
    }
  }
}

/**
 * Starts the page: configuration, the primary-host redirect of the sign-in and sign-up pages, theme, header, footer,
 * environment and session (see the top of this file). Resolves with what the page module runs with; never rejects.
 * When the storefront is suspended or unknown it never resolves, and the page shows that state instead; nor when the
 * page goes to the OTA's primary custom domain.
 * @param {object} [deps] for tests; the defaults are the page's own
 * @param {BootClient} [deps.client] the SDK client (lib/client.js)
 * @param {ConfigStorage | null} [deps.storage] the configuration cache (sessionStorage; `null` for none)
 * @param {PreferenceStorage | null} [deps.preferences] where the currency choice is kept (localStorage)
 * @param {Document} [deps.doc] the page
 * @param {(url: string) => void} [deps.navigate] how the page goes to the primary host (`location.replace`)
 * @returns {Promise<BootContext>}
 */
export async function boot({
  client = storefrontClient,
  storage = undefined,
  preferences = preferenceStorage(),
  doc = document,
  navigate = (url) => doc.defaultView?.location.replace(url),
} = {}) {
  const live = mountLiveRegion(doc.body);
  live.announce(t("app.loading"));
  const config = await configOrState({ client, storage, doc, live });
  const location = doc.defaultView?.location;

  const redirect = location ? safely(() => primaryHostRedirect(config, location)) : null;
  if (redirect && leaveFor(doc, redirect, navigate)) {
    return new Promise(() => {});
  }
  live.clear();

  const sessionRequest =
    config.features?.customerAccounts === false ? Promise.resolve(null) : loadSession(client);
  const currency = rememberedCurrency(config, preferences);
  const pageClient = clientFor(client, currency);

  safely(() => applyTheme(config.branding, { doc }));
  const headerRoot = /** @type {HTMLElement | null} */ (doc.querySelector("body > header"));
  const header = headerRoot
    ? safely(() =>
        mountHeader(headerRoot, {
          config,
          session: null,
          currency,
          client,
          ...(location ? { location } : {}),
          onCurrencyChange(code) {
            rememberCurrency(code, preferences);
            const detail = { currency: code, client: clientFor(client, code) };
            live.announce(t("header.currencyChanged", { currency: code }));
            const View = doc.defaultView ?? globalThis;
            doc.dispatchEvent(new View.CustomEvent(CURRENCY_CHANGE_EVENT, { detail }));
          },
        }),
      )
    : null;
  const footerRoot = /** @type {HTMLElement | null} */ (doc.querySelector("body > footer"));
  if (footerRoot) {
    safely(() => mountFooter(footerRoot, { config, client }));
  }
  applyEnvironment(doc, config.environment);

  const session = await sessionRequest;
  if (session && header) {
    safely(() => header.update({ session }));
  }
  return { config, session, client: pageClient };
}
