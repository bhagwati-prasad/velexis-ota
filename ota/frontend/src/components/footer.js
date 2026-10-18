// The page footer (partials/footer.html, ota/frontend/README.md §5.1 point 3, §8 Help): the OTA's legal links and its
// support contacts, in the same place on every page (WCAG 3.2.6). The partial's static links work without JavaScript;
// this component adds the links of `config.legal` and fills the support item from `config.support`. Everything is
// built with createElement and textContent, and every URL is checked (`https:` or a same-origin path for pages,
// `mailto:` and `tel:` for contacts).
//
// A support address on the reserved `.invalid` domain (RFC 2606) is the API's placeholder until the OTA sets its own
// address: it is never shown. Content pages with `showInFooter` (`storefront.listPages`, M4) join with OFE-020.

import { t } from "../lib/i18n.js";
import { safeUrl } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontConfig"]} StorefrontConfig */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontSupport"]} StorefrontSupport */

/** The legal links of `config.legal` in footer order, with their text keys. */
const LEGAL_LINKS = /** @type {const} */ ([
  ["termsUrl", "footer.terms"],
  ["privacyUrl", "footer.privacy"],
  ["cookiePolicyUrl", "footer.cookies"],
  ["refundPolicyUrl", "footer.refunds"],
  ["imprintUrl", "footer.imprint"],
  ["accessibilityUrl", "footer.accessibility"],
]);

const ADDED = "footerLink";
const LINK_CLASS = "underline-offset-4 hover:underline";

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
 * The footer's link items for the legal pages and the help centre.
 * @param {Document} doc
 * @param {StorefrontConfig} config
 * @returns {HTMLLIElement[]}
 */
function legalItems(doc, config) {
  /** @type {Array<[unknown, string]>} */
  const entries = [
    ...LEGAL_LINKS.map(([field, key]) => /** @type {[unknown, string]} */ ([config.legal?.[field], t(key)])),
    [config.support?.helpCenterUrl, t("footer.helpCenter")],
  ];
  return entries.flatMap(([url, text]) => {
    const anchor = link(doc, url, text, ["https:"]);
    if (!anchor) {
      return [];
    }
    const item = doc.createElement("li");
    item.dataset[ADDED] = "";
    item.append(anchor);
    return [item];
  });
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
 * Mounts the footer component on the page's `<footer>` (partials/footer.html).
 * @param {HTMLElement} root
 * @param {{ config: StorefrontConfig }} props
 * @returns {{ update: (props: { config: StorefrontConfig }) => void, destroy: () => void }}
 */
export function mount(root, props) {
  const doc = root.ownerDocument;
  const list = root.querySelector('[data-slot="footer-links"]');
  const support = /** @type {HTMLElement | null} */ (root.querySelector('[data-slot="support"]'));

  const clear = () => {
    for (const item of root.querySelectorAll("[data-footer-link]")) {
      item.remove();
    }
  };
  const render = (/** @type {{ config: StorefrontConfig }} */ { config }) => {
    clear();
    if (list) {
      const items = legalItems(doc, config);
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

  render(props);
  return {
    update: render,
    destroy() {
      clear();
      if (support) {
        support.replaceChildren();
        support.hidden = true;
      }
    },
  };
}
