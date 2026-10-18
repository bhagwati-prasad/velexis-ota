// Tiny DOM helpers of the storefront (ota/frontend/README.md §5.2, conventions §4). Markup lives in HTML: repeated
// items are `<template>` elements that pages `clone()` and `fill()`. Data only ever reaches the page as text
// (`textContent`) or through an allowlist of attributes, so API data can never become markup or script: `innerHTML`
// with data is forbidden and fails lint (ESLint `no-unsanitized`).
//
// fill(el, data) reads, on `el` and every element inside it:
//   data-field="origin.cityName"        textContent = the value at that path of `data`
//   data-field-<attribute>="path"       one attribute from the allowlist below, for example
//                                       data-field-href="detailsUrl", data-field-aria-label="label",
//                                       data-field-hidden="isDirect" (boolean), data-field-data-offer-id="id";
//                                       `href` on <a> and <area> only, `src` on <img> only
// A path that `data` does not contain leaves the template's own text or attribute; `null` empties the text or
// removes the attribute. Objects are refused (format money, dates and durations with lib/format.js first).

import { safeUrl } from "./url.js";

/** Attributes whose value is plain text. */
const TEXT_ATTRIBUTES = new Set([
  "alt",
  "title",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-valuenow",
  "aria-valuemin",
  "aria-valuemax",
  "aria-current",
  "aria-expanded",
  "aria-pressed",
  "aria-selected",
  "datetime",
  "value",
  "min",
  "max",
  "lang",
]);
/** Boolean attributes: present when the value is truthy. */
const BOOLEAN_ATTRIBUTES = new Set(["hidden", "disabled", "checked", "selected", "open"]);
/**
 * URL attributes: the elements that may carry each (a link, an image; never a script, frame, form or stylesheet) and
 * the absolute schemes it accepts. Same-origin paths (`/…`), `?…` and `#…` are always fine.
 * @type {ReadonlyMap<string, { tags: ReadonlySet<string>, schemes: readonly string[] }>}
 */
const URL_ATTRIBUTES = new Map([
  ["href", { tags: new Set(["A", "AREA"]), schemes: ["https:", "mailto:", "tel:"] }],
  ["src", { tags: new Set(["IMG"]), schemes: [] }],
]);
/** `data-*` attributes other than fill's own `data-field…`. */
const DATA_ATTRIBUTE = /^data-(?!field(?:-|$))[a-z][a-z0-9-]*$/;
const FIELD_ATTRIBUTE_PREFIX = "data-field-";

/**
 * The first element matching `selector` inside `root` (default: the document), or `null`.
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element | null}
 */
export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Every element matching `selector` inside `root` (default: the document), as an array.
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element[]}
 */
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * A deep copy of the single root element of `<template id="templateId">`. Throws when there is no such template or
 * when it does not hold exactly one element (a template is one repeated item).
 * @param {string} templateId
 * @param {Document} [doc]
 * @returns {HTMLElement}
 */
export function clone(templateId, doc = document) {
  const template = doc.getElementById(templateId);
  if (!template || template.tagName !== "TEMPLATE") {
    throw new Error(`clone: there is no <template id="${templateId}">`);
  }
  const { content } = /** @type {HTMLTemplateElement} */ (template);
  if (content.childElementCount !== 1 || !content.firstElementChild) {
    throw new Error(`clone: <template id="${templateId}"> must hold exactly one element`);
  }
  return /** @type {HTMLElement} */ (content.firstElementChild.cloneNode(true));
}

/**
 * The value at a dotted path of `data` (own properties only), or `undefined` when the path is missing.
 * @param {unknown} data
 * @param {string} path
 * @returns {unknown}
 */
function valueAt(data, path) {
  /** @type {unknown} */
  let value = data;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = /** @type {Record<string, unknown>} */ (value)[key];
  }
  return value;
}

/**
 * A primitive as text; objects and functions are refused, because they would render as "[object Object]".
 * @param {unknown} value
 * @param {string} path
 */
function textOf(value, path) {
  if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`fill: "${path}" is not text; format it before filling the template`);
  }
  return String(value);
}

/**
 * Sets one allowlisted attribute from data. Throws for an attribute outside the allowlist (an event handler, `style`,
 * `srcdoc`, `class`, …) or a URL attribute on another element (`src` of a script or frame, `href` of a stylesheet),
 * because that is a template bug.
 * @param {Element} element
 * @param {string} name
 * @param {unknown} value
 * @param {string} path
 */
function setAttributeFromData(element, name, value, path) {
  if (BOOLEAN_ATTRIBUTES.has(name)) {
    element.toggleAttribute(name, Boolean(value));
    return;
  }
  const urlRule = URL_ATTRIBUTES.get(name);
  if (
    urlRule ? !urlRule.tags.has(element.tagName) : !TEXT_ATTRIBUTES.has(name) && !DATA_ATTRIBUTE.test(name)
  ) {
    throw new Error(
      `fill: ${FIELD_ATTRIBUTE_PREFIX}${name} is not an attribute fill may set on <${element.localName}>`,
    );
  }
  if (value === null) {
    element.removeAttribute(name);
    return;
  }
  const text = textOf(value, path);
  const safe = urlRule ? safeUrl(text, urlRule.schemes) : text;
  if (safe === null) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, safe);
  }
}

/**
 * Fills `el` and the elements inside it from `data`: `data-field` sets `textContent`, `data-field-<attribute>` sets
 * an allowlisted attribute (URLs checked by `safeUrl` of lib/url.js). Returns `el`.
 * @template {Element} E
 * @param {E} el
 * @param {Record<string, unknown>} data
 * @returns {E}
 */
export function fill(el, data) {
  for (const element of [el, ...el.querySelectorAll("*")]) {
    for (const { name, value: path } of Array.from(element.attributes)) {
      if (name !== "data-field" && !name.startsWith(FIELD_ATTRIBUTE_PREFIX)) {
        continue;
      }
      const value = valueAt(data, path);
      if (value === undefined) {
        continue;
      }
      if (name === "data-field") {
        element.textContent = value === null ? "" : textOf(value, path);
      } else {
        setAttributeFromData(element, name.slice(FIELD_ATTRIBUTE_PREFIX.length), value, path);
      }
    }
  }
  return el;
}

/**
 * Whether `node` is `target` or inside it, by walking up the parents (a target that is not a node, such as `window`,
 * holds everything).
 * @param {EventTarget} target
 * @param {Node} node
 */
function isInside(target, node) {
  if (!("nodeType" in target)) {
    return true;
  }
  /** @type {Node | null} */
  let current = node;
  while (current) {
    if (current === target) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Adds an event listener and returns the function that removes it. With a selector, the listener is delegated: it
 * runs for events inside `target` whose origin is (or is inside) an element matching `selector`, with that element as
 * the second argument.
 *
 *   on(button, "click", () => …)
 *   on(list, "click", "[data-action=remove]", (event, item) => …)
 *
 * @param {EventTarget} target
 * @param {string} type
 * @param {string | ((event: Event) => void)} selectorOrListener
 * @param {((event: Event, matched: Element) => void) | AddEventListenerOptions | boolean} [listenerOrOptions]
 * @param {AddEventListenerOptions | boolean} [options]
 * @returns {() => void}
 */
export function on(target, type, selectorOrListener, listenerOrOptions, options) {
  if (typeof selectorOrListener !== "string") {
    const listener = selectorOrListener;
    const listenerOptions = /** @type {AddEventListenerOptions | boolean | undefined} */ (listenerOrOptions);
    target.addEventListener(type, listener, listenerOptions);
    return () => target.removeEventListener(type, listener, listenerOptions);
  }
  const selector = selectorOrListener;
  if (typeof listenerOrOptions !== "function") {
    throw new TypeError("on: a delegated listener needs a function after the selector");
  }
  const listener = listenerOrOptions;
  /** @param {Event} event */
  const delegate = (event) => {
    const origin = /** @type {Element | null} */ (event.target);
    const matched = origin && typeof origin.closest === "function" ? origin.closest(selector) : null;
    if (matched && isInside(target, matched)) {
      listener(event, matched);
    }
  };
  target.addEventListener(type, delegate, options);
  return () => target.removeEventListener(type, delegate, options);
}
