// The page footer (partials/footer.html, ota/frontend/README.md §5.1 point 3, §8 Help, docs/pages-account.md §7): the
// OTA's legal links, its content pages and its support contacts, in the same place on every page (WCAG 3.2.6). The
// partial's static links work without JavaScript; this component adds the links of `config.legal`, the published
// content pages that have `showInFooter` (`storefront.listPages`, OFE-020) and the help centre, and fills the support
// item from `config.support`. Everything is built with createElement and textContent, and every URL is checked
// (`https:` or a same-origin path for pages, `/p/<slug>` for content pages, `mailto:` and `tel:` for contacts).
//
// - A support address on the reserved `.invalid` domain (RFC 2606) is the API's placeholder until the OTA sets its own
//   address: it is never shown.
// - Content pages: `storefront.listPages` once per 5 minutes (its answer kept in sessionStorage like the configuration,
//   OADR-0012 point 7, OADR-0015 point 7; storage that the browser refuses changes nothing). Its failure is ignored:
//   the footer keeps its other links. A page that a legal link already names (`/p/<slug>` on one of the OTA's hosts) is
//   not listed twice. The link to the page being shown carries `aria-current="page"`.

import { pageStorage } from "../lib/config-cache.js";
import { t } from "../lib/i18n.js";
import { isPageSlug, pageHref, pageSlugFromPath, safeUrl } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontConfig"]} StorefrontConfig */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontSupport"]} StorefrontSupport */
/** @typedef {import("../lib/config-cache.js").ConfigStorage} PagesStorage */
/** @typedef {{ slug: string, title: string }} FooterPage */
/** @typedef {{ storefront?: Partial<Pick<VelexisClient["storefront"], "listPages">> }} FooterClient */
/**
 * @typedef {object} FooterProps
 * @property {StorefrontConfig} config the storefront configuration
 * @property {FooterClient | null} [client] the SDK client; without `storefront.listPages` no content page is listed
 * @property {PagesStorage | null} [storage] where the list is kept (default sessionStorage; `null` for none)
 * @property {() => number} [now] the clock (tests)
 */

/** The legal links of `config.legal` in footer order, with their text keys. */
const LEGAL_LINKS = /** @type {const} */ ([
  ["termsUrl", "footer.terms"],
  ["privacyUrl", "footer.privacy"],
  ["cookiePolicyUrl", "footer.cookies"],
  ["refundPolicyUrl", "footer.refunds"],
  ["imprintUrl", "footer.imprint"],
  ["accessibilityUrl", "footer.accessibility"],
]);

/** The sessionStorage key of the footer's content pages. */
export const PAGES_STORAGE_KEY = "vx.storefront.pages";
/** How long the cached content pages are used: 5 minutes, as the configuration (lib/config.js). */
export const PAGES_TTL_MS = 5 * 60 * 1000;
/** The longest page title the footer shows (`StorefrontPageSummary.title`). */
const MAX_TITLE_LENGTH = 120;

const ADDED = "footerLink";
const LINK_CLASS = "underline-offset-4 hover:underline";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The support e-mail address to show, or `null` when there is none or it is the API's placeholder on the reserved
 * `.invalid` domain.
 * @param {Partial<StorefrontSupport> | null | undefined} support
 * @returns {string | null}
 */
export function supportEmail(support) {
  const email = typeof support?.email === "string" ? support.email.trim() : "";
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) {
    return null;
  }
  const domain = email
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  return domain === "invalid" || domain.endsWith(".invalid") ? null : email;
}

/**
 * The content pages the footer lists, from a `storefront.listPages` answer: those with `showInFooter`, a valid slug
 * and a title, in the API's order (`sortOrder`, then `slug`), each slug once.
 * @param {unknown} answer `StorefrontPageList`
 * @returns {FooterPage[]}
 */
export function footerPages(answer) {
  const data = isRecord(answer) && Array.isArray(answer["data"]) ? answer["data"] : [];
  /** @type {Set<string>} */
  const seen = new Set();
  return data.flatMap((page) => {
    if (!isRecord(page) || page["showInFooter"] !== true || !isPageSlug(page["slug"])) {
      return [];
    }
    const slug = page["slug"];
    const title = typeof page["title"] === "string" ? page["title"].trim() : "";
    if (title === "" || title.length > MAX_TITLE_LENGTH || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [{ slug, title }];
  });
}

/**
 * The cached content pages when they are younger than 5 minutes, else `null` (and a stale or unreadable entry
 * removed).
 * @param {PagesStorage | null} storage
 * @param {number} now
 * @returns {FooterPage[] | null}
 */
function readCachedPages(storage, now) {
  if (!storage) {
    return null;
  }
  try {
    const text = storage.getItem(PAGES_STORAGE_KEY);
    if (text === null) {
      return null;
    }
    let entry = null;
    try {
      entry = JSON.parse(text);
    } catch {
      // Not JSON: removed below like a stale entry.
    }
    const age = isRecord(entry) && typeof entry["storedAt"] === "number" ? now - entry["storedAt"] : -1;
    if (age >= 0 && age < PAGES_TTL_MS && isRecord(entry) && Array.isArray(entry["pages"])) {
      return footerPages({
        data: entry["pages"].map((page) => (isRecord(page) ? { ...page, showInFooter: true } : page)),
      });
    }
    storage.removeItem(PAGES_STORAGE_KEY);
  } catch {
    // Storage refused: ask the API.
  }
  return null;
}

/**
 * Keeps the content pages for the next pages; a storage that refuses them changes nothing.
 * @param {PagesStorage | null} storage
 * @param {FooterPage[]} pages
 * @param {number} now
 */
function writeCachedPages(storage, pages, now) {
  try {
    storage?.setItem(PAGES_STORAGE_KEY, JSON.stringify({ storedAt: now, pages }));
  } catch {
    // Quota exceeded, private mode or storage blocked: the next page asks the API again.
  }
}

/**
 * The content pages of the footer: from sessionStorage when cached less than 5 minutes ago, else from
 * `storefront.listPages` (then cached). `null` when the client has no such method or the call fails (the footer
 * ignores the failure, which is never cached).
 * @param {{ client?: FooterClient | null, storage?: PagesStorage | null, now?: () => number }} [deps]
 * @returns {Promise<FooterPage[] | null>}
 */
export async function loadFooterPages({ client = null, storage = pageStorage(), now = Date.now } = {}) {
  const api = client?.storefront;
  if (typeof api?.listPages !== "function") {
    return null;
  }
  const cached = readCachedPages(storage, now());
  if (cached) {
    return cached;
  }
  try {
    const pages = footerPages(await api.listPages());
    writeCachedPages(storage, pages, now());
    return pages;
  } catch {
    return null;
  }
}

/**
 * The host names of the OTA's storefront: the page's own, `primaryUrl`'s and the verified domains of `config.domains`.
 * @param {Document} doc
 * @param {StorefrontConfig} config
 */
function storefrontHosts(doc, config) {
  const hosts = new Set([doc.location?.hostname ?? ""]);
  try {
    hosts.add(new URL(String(config.primaryUrl)).hostname);
  } catch {
    // No primary URL: the page's own host and the domains.
  }
  for (const domain of Array.isArray(config.domains) ? config.domains : []) {
    if (typeof domain?.host === "string") {
      hosts.add(domain.host.toLowerCase());
    }
  }
  hosts.delete("");
  return hosts;
}

/**
 * The content page a URL names on one of the OTA's hosts (`/p/<slug>`), or `null`.
 * @param {string} href
 * @param {Document} doc
 * @param {Set<string>} hosts
 * @returns {string | null}
 */
function pageSlugOf(href, doc, hosts) {
  try {
    const url = new URL(href, doc.location?.href);
    return hosts.has(url.hostname) ? pageSlugFromPath(url.pathname) : null;
  } catch {
    return null;
  }
}

/**
 * A link element, or `null` when the URL is unsafe. Links to other origins get `rel="noopener noreferrer"`.
 * @param {Document} doc
 * @param {unknown} url
 * @param {string} text
 * @param {readonly string[]} schemes
 */
function link(doc, url, text, schemes) {
  const href = typeof url === "string" ? safeUrl(url, schemes) : null;
  if (href === null) {
    return null;
  }
  const anchor = doc.createElement("a");
  anchor.href = href;
  anchor.textContent = text;
  anchor.className = LINK_CLASS;
  if (/^https:/i.test(href) && new URL(href).origin !== doc.location?.origin) {
    anchor.rel = "noopener noreferrer";
  }
  return anchor;
}

/**
 * A footer item holding `anchor`, marked as added by this component.
 * @param {Document} doc
 * @param {HTMLAnchorElement} anchor
 * @returns {HTMLLIElement}
 */
function item(doc, anchor) {
  const li = doc.createElement("li");
  li.dataset[ADDED] = "";
  li.append(anchor);
  return li;
}

/**
 * The footer's link items: the legal pages, the content pages that no legal link names, then the help centre. A link
 * to the content page being shown, on this origin, carries `aria-current="page"`.
 * @param {Document} doc
 * @param {StorefrontConfig} config
 * @param {FooterPage[]} pages
 * @returns {HTMLLIElement[]}
 */
function linkItems(doc, config, pages) {
  const hosts = storefrontHosts(doc, config);
  const current = pageSlugFromPath(doc.location?.pathname ?? "");
  /** @type {Set<string>} */
  const linked = new Set();
  /** Marks `anchor` as the current page when it names the content page being shown on this origin. */
  const marked = (/** @type {HTMLAnchorElement} */ anchor, /** @type {string | null} */ slug) => {
    if (current !== null && slug === current) {
      try {
        if (new URL(anchor.href, doc.location?.href).origin === doc.location?.origin) {
          anchor.setAttribute("aria-current", "page");
        }
      } catch {
        // Not a URL of this page: no mark.
      }
    }
    return anchor;
  };

  const legal = LEGAL_LINKS.flatMap(([field, key]) => {
    const anchor = link(doc, config.legal?.[field], t(key), ["https:"]);
    if (!anchor) {
      return [];
    }
    const slug = pageSlugOf(anchor.href, doc, hosts);
    if (slug !== null) {
      linked.add(slug);
    }
    return [item(doc, marked(anchor, slug))];
  });
  const content = pages.flatMap(({ slug, title }) => {
    const anchor = linked.has(slug) ? null : link(doc, pageHref(slug), title, []);
    return anchor ? [item(doc, marked(anchor, slug))] : [];
  });
  const help = link(doc, config.support?.helpCenterUrl, t("footer.helpCenter"), ["https:"]);
  return [...legal, ...content, ...(help ? [item(doc, help)] : [])];
}

/**
 * Fills the support item: "Support: <e-mail>, <phone> (<hours>)", or hides it when there is nothing to show.
 * @param {HTMLElement} item
 * @param {Partial<StorefrontSupport> | null | undefined} support
 */
function renderSupport(item, support) {
  const doc = item.ownerDocument;
  const email = supportEmail(support);
  const contacts = [
    email === null ? null : link(doc, `mailto:${email}`, email, ["mailto:"]),
    typeof support?.phone === "string" && support.phone !== ""
      ? link(doc, `tel:${support.phone.replace(/[^\d+]/g, "")}`, support.phone, ["tel:"])
      : null,
  ].filter((contact) => contact !== null);
  if (contacts.length === 0) {
    item.replaceChildren();
    item.hidden = true;
    return;
  }
  /** @type {Array<Node | string>} */
  const parts = [`${t("footer.support")} `];
  contacts.forEach((contact, index) => parts.push(...(index > 0 ? [", ", contact] : [contact])));
  if (typeof support?.hours === "string" && support.hours.trim() !== "") {
    parts.push(` ${t("footer.supportHours", { hours: support.hours.trim() })}`);
  }
  item.replaceChildren(...parts);
  item.hidden = false;
}

/**
 * Mounts the footer component on the page's `<footer>` (partials/footer.html). With a client that has
 * `storefront.listPages`, the content pages join the links when they arrive (see the top of this file); `done`
 * settles then (at once without such a client) and never rejects.
 * @param {HTMLElement} root
 * @param {FooterProps} props
 * @returns {{ update: (props: { config: StorefrontConfig }) => void, destroy: () => void, done: Promise<void> }}
 */
export function mount(root, props) {
  const doc = root.ownerDocument;
  const list = root.querySelector('[data-slot="footer-links"]');
  const support = /** @type {HTMLElement | null} */ (root.querySelector('[data-slot="support"]'));
  let config = props.config;
  /** @type {FooterPage[]} */
  let pages = [];
  let destroyed = false;

  const clear = () => {
    for (const added of root.querySelectorAll("[data-footer-link]")) {
      added.remove();
    }
  };
  const render = () => {
    clear();
    if (list) {
      const items = linkItems(doc, config, pages);
      if (support && support.parentElement === list) {
        support.before(...items);
      } else {
        list.append(...items);
      }
    }
    if (support) {
      renderSupport(support, config.support);
    }
  };

  render();
  const done = loadFooterPages({
    client: props.client ?? null,
    ...(props.storage !== undefined ? { storage: props.storage } : {}),
    ...(props.now ? { now: props.now } : {}),
  }).then(
    (loaded) => {
      if (!destroyed && loaded && loaded.length > 0) {
        pages = loaded;
        render();
      }
    },
    () => undefined,
  );
  return {
    done,
    update(next) {
      config = next.config;
      if (!destroyed) {
        render();
      }
    },
    destroy() {
      destroyed = true;
      clear();
      if (support) {
        support.replaceChildren();
        support.hidden = true;
      }
    },
  };
}
