// Content-page blocks → DOM (ota/frontend/docs/pages-account.md §7, OADR-0012 point 5, OADR-0015 point 4). The OTA API
// parses a page's Markdown subset on the server and `storefront.getPage` answers its body as blocks (`heading`,
// `paragraph`, `list`, `image`) holding inline nodes (`text`, `strong`, `em`, `link`). This module builds them with
// `createElement`, `createTextNode` and property assignments only: nothing is ever parsed as HTML (no `innerHTML` or
// any other HTML sink; ESLint `no-unsanitized`, test/blocks.test.js), so a page's text can never become markup.
//
// The API checked the page when staff saved it; the browser checks again what it puts into an attribute:
// - links: `https:`, `mailto:` and `tel:` URLs and the storefront's own content pages `/p/<slug>`, at most 2048
//   characters, without control characters, white space or backslashes; `https:` links get `rel="noopener
//   noreferrer"`. A link that fails (`javascript:`, `data:`, `http:`, another relative path, …) is rendered as its
//   plain text, without an `<a>`;
// - images: only the OTA API's same-origin asset paths (`/api/v1/assets/<tenantKey>/<assetId>.<ext>`, getPublicAsset),
//   of this OTA when its key is known; any other image is left out (the CSP allows `img-src 'self'` only anyway);
// - unknown block or inline types are skipped, heading levels stay 2 to 4 (the page title is the only `h1`), and a
//   block without any text is left out.

import { hasUnsafeUrlCharacter, isPageSlug } from "./url.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontPageBlock"]} StorefrontPageBlock */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontPageInline"]} StorefrontPageInline */

/** The storefront path of a content page, `/p/<slug>` (OADR-0015 point 4; the slug as `PAGE_SLUG` of lib/url.js). */
const PAGE_PATH = /^\/p\/([^/]+)$/;
/** The longest link a block may carry (`StorefrontPageLink.href`). */
export const MAX_LINK_LENGTH = 2048;
/** The absolute link schemes of a block (`StorefrontPageLink.href`). */
export const LINK_SCHEMES = Object.freeze(["https:", "mailto:", "tel:"]);
/** The OTA API's public image path on the storefront's origin (getPublicAsset; OADR-0012 point 3). */
const ASSET_PATH =
  /^\/api\/v1\/assets\/([a-z][a-z0-9-]{1,39})\/ast_[0-9A-Za-z]{16,40}\.(?:png|jpg|webp|ico)$/;
/** Inline nodes nested deeper than this are left out (the Markdown subset nests a few levels at most). */
const MAX_INLINE_DEPTH = 16;

/** Classes of the elements, as complete strings so Tailwind's scanner finds them. */
const CLASSES = Object.freeze({
  h2: "mt-8 font-heading text-2xl font-semibold",
  h3: "mt-6 font-heading text-xl font-semibold",
  h4: "mt-6 font-heading text-lg font-semibold",
  p: "mt-4 max-w-prose leading-relaxed",
  ul: "mt-4 max-w-prose list-disc space-y-1 pl-6",
  ol: "mt-4 max-w-prose list-decimal space-y-1 pl-6",
  figure: "mt-6",
  img: "h-auto max-w-full rounded-ui",
  a: "font-medium text-primary underline underline-offset-4",
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * A block's link target when the browser may follow it: an `https:`, `mailto:` or `tel:` URL, or the storefront's own
 * content page `/p/<slug>`; `null` for anything else (`javascript:`, `data:`, `http:`, other relative paths,
 * protocol-relative URLs, credentials in an `https:` URL, control characters, white space, backslashes, more than 2048
 * characters).
 * @param {unknown} href
 * @returns {string | null}
 */
export function safeLinkHref(href) {
  if (
    typeof href !== "string" ||
    href === "" ||
    href.length > MAX_LINK_LENGTH ||
    hasUnsafeUrlCharacter(href)
  ) {
    return null;
  }
  if (href.startsWith("/")) {
    return isPageSlug(PAGE_PATH.exec(href)?.[1]) ? href : null;
  }
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.includes(url.protocol)) {
    return null;
  }
  if (url.protocol === "https:" && (url.hostname === "" || url.username !== "" || url.password !== "")) {
    return null;
  }
  return url.href;
}

/**
 * An image block's source when it is one of the OTA API's public images on the storefront's own origin
 * (`/api/v1/assets/<tenantKey>/<assetId>.<ext>`), of `tenantKey` when given; an absolute URL is accepted only on
 * `origin` and becomes its path. `null` for anything else.
 * @param {unknown} url
 * @param {{ origin?: string | null, tenantKey?: string | null }} [options]
 * @returns {string | null}
 */
export function safeImageSrc(url, { origin = null, tenantKey = null } = {}) {
  if (typeof url !== "string" || url === "" || hasUnsafeUrlCharacter(url)) {
    return null;
  }
  let path = url;
  if (!url.startsWith("/")) {
    try {
      const parsed = new URL(url);
      if (origin === null || parsed.origin !== origin || parsed.search !== "" || parsed.hash !== "") {
        return null;
      }
      path = parsed.pathname;
    } catch {
      return null;
    }
  }
  const match = ASSET_PATH.exec(path);
  if (!match || (typeof tenantKey === "string" && tenantKey !== "" && match[1] !== tenantKey)) {
    return null;
  }
  return path;
}

/**
 * Appends inline nodes to `parent`: text as text nodes, `strong` and `em` as their elements, links with a checked
 * target as `<a>` (a link that fails the check, or one inside another link, as its plain content).
 * @param {Node} parent
 * @param {unknown} nodes
 * @param {Document} doc
 * @param {number} depth
 * @param {boolean} inLink
 */
function appendInline(parent, nodes, doc, depth, inLink) {
  if (depth > MAX_INLINE_DEPTH) {
    return;
  }
  for (const node of list(nodes)) {
    if (!isRecord(node)) {
      continue;
    }
    if (node["type"] === "text") {
      const text = node["text"];
      if (typeof text === "string" && text !== "") {
        parent.appendChild(doc.createTextNode(text));
      }
    } else if (node["type"] === "strong" || node["type"] === "em") {
      const element = doc.createElement(node["type"]);
      appendInline(element, node["content"], doc, depth + 1, inLink);
      if (element.hasChildNodes()) {
        parent.appendChild(element);
      }
    } else if (node["type"] === "link") {
      const href = inLink ? null : safeLinkHref(node["href"]);
      if (href === null) {
        appendInline(parent, node["content"], doc, depth + 1, inLink);
        continue;
      }
      const anchor = doc.createElement("a");
      anchor.href = href;
      anchor.className = CLASSES.a;
      if (href.startsWith("https:")) {
        anchor.rel = "noopener noreferrer";
      }
      appendInline(anchor, node["content"], doc, depth + 1, true);
      if (anchor.hasChildNodes()) {
        parent.appendChild(anchor);
      }
    }
  }
}

/**
 * The inline nodes as a fragment (see appendInline).
 * @param {unknown} nodes `StorefrontPageInline[]`
 * @param {Document} [doc]
 * @returns {DocumentFragment}
 */
export function renderInline(nodes, doc = document) {
  const fragment = doc.createDocumentFragment();
  appendInline(fragment, nodes, doc, 0, false);
  return fragment;
}

/**
 * An element of `tag` with its class and the inline nodes, or `null` when they hold no text.
 * @param {Document} doc
 * @param {"h2" | "h3" | "h4" | "p" | "li"} tag
 * @param {unknown} content
 */
function textElement(doc, tag, content) {
  const element = doc.createElement(tag);
  if (tag !== "li") {
    element.className = CLASSES[tag];
  }
  appendInline(element, content, doc, 0, false);
  return element.textContent?.trim() ? element : null;
}

/**
 * One block as an element, or `null` when it is unknown, empty or unsafe.
 * @param {Document} doc
 * @param {unknown} block
 * @param {{ origin: string | null, tenantKey: string | null }} images
 * @returns {HTMLElement | null}
 */
function renderBlock(doc, block, images) {
  if (!isRecord(block)) {
    return null;
  }
  switch (block["type"]) {
    case "heading": {
      const level = block["level"] === 3 || block["level"] === 4 ? block["level"] : 2;
      return textElement(doc, `h${level}`, block["content"]);
    }
    case "paragraph":
      return textElement(doc, "p", block["content"]);
    case "list": {
      const ordered = block["ordered"] === true;
      const element = doc.createElement(ordered ? "ol" : "ul");
      element.className = ordered ? CLASSES.ol : CLASSES.ul;
      const start = block["start"];
      if (ordered && typeof start === "number" && Number.isSafeInteger(start) && start >= 0 && start !== 1) {
        /** @type {HTMLOListElement} */ (element).start = start;
      }
      for (const item of list(block["items"])) {
        const li = isRecord(item) ? textElement(doc, "li", item["content"]) : null;
        if (li) {
          element.appendChild(li);
        }
      }
      return element.hasChildNodes() ? element : null;
    }
    case "image": {
      const src = safeImageSrc(block["url"], images);
      if (src === null) {
        return null;
      }
      const figure = doc.createElement("figure");
      figure.className = CLASSES.figure;
      const img = doc.createElement("img");
      img.src = src;
      img.alt = typeof block["alt"] === "string" ? block["alt"] : "";
      img.className = CLASSES.img;
      img.loading = "lazy";
      img.decoding = "async";
      for (const dimension of /** @type {const} */ (["width", "height"])) {
        const value = block[dimension];
        if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
          img[dimension] = value;
        }
      }
      figure.appendChild(img);
      return figure;
    }
    default:
      return null;
  }
}

/**
 * A page body (`StorefrontPageContent.blocks`) as a fragment of elements, built with `createElement` and text nodes
 * only (see the top of this file).
 * @param {unknown} blocks `StorefrontPageBlock[]`
 * @param {{ doc?: Document, tenantKey?: string | null }} [options] `tenantKey` limits images to this OTA's assets
 * @returns {DocumentFragment}
 */
export function renderBlocks(blocks, { doc = document, tenantKey = null } = {}) {
  const fragment = doc.createDocumentFragment();
  const origin = doc.location?.origin;
  const images = { origin: origin && origin !== "null" ? origin : null, tenantKey };
  for (const block of list(blocks)) {
    const element = renderBlock(doc, block, images);
    if (element) {
      fragment.appendChild(element);
    }
  }
  return fragment;
}
