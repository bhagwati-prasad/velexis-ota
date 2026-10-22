// Query-string helpers and safe redirects for the storefront (ota/frontend/README.md §4, §10, OADR-0015 point 3).
// Pages are addressed by their `.html` path and dynamic values travel in the query string (`?search=srch_…`,
// `?offer=off_…`); lists are comma-separated (`stops=0,1&carriers=AF,KL`). A `next` parameter is only ever followed
// when it is a path on this storefront: one leading `/`, anything else goes to `/`.

/** Where an unsafe or missing `next` sends the visitor. */
export const DEFAULT_NEXT = "/";
/** Longest `next` that is followed; longer values go to `/`. */
const MAX_NEXT_LENGTH = 2048;
/** A base URL that no real page has, to resolve relative paths against. */
const PROBE_ORIGIN = "https://storefront.invalid";

/** @typedef {string | number | boolean | null | undefined | ReadonlyArray<string | number>} QueryValue */

/**
 * Whether `text` holds a character that URL parsers strip or reinterpret: C0 controls and space (tab and new line
 * inside a URL are removed, so "/\t/evil.example" becomes "//evil.example"), DEL, C1 controls, and the backslash
 * (read as `/` in http and https URLs).
 * @param {string} text
 */
export function hasUnsafeUrlCharacter(text) {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || char === "\\") {
      return true;
    }
  }
  return false;
}

/**
 * The URL when it is safe to put in a link or image: a same-origin path (one leading `/`), a query (`?…`) or a fragment
 * (`#…`), or an absolute URL with one of `schemes` (for example `["https:", "mailto:", "tel:"]`; never `javascript:`
 * or `data:` unless listed). `null` otherwise.
 * @param {string} text
 * @param {readonly string[]} schemes
 * @returns {string | null}
 */
export function safeUrl(text, schemes) {
  if (text === "" || hasUnsafeUrlCharacter(text)) {
    return null;
  }
  if ((text.startsWith("/") && !text.startsWith("//")) || text.startsWith("?") || text.startsWith("#")) {
    return text;
  }
  try {
    const url = new URL(text);
    return schemes.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The query parameters of `search` (default: the current page's).
 * @param {string | URLSearchParams} [search]
 */
export const queryParams = (search = globalThis.location?.search ?? "") => new URLSearchParams(search);

/**
 * One query parameter (the first if repeated), or `null`.
 * @param {string} name
 * @param {string | URLSearchParams} [search]
 * @returns {string | null}
 */
export const getParam = (name, search) => queryParams(search).get(name);

/**
 * A comma-separated list parameter (`stops=0,1`, or repeated `stops=0&stops=1`): the trimmed, non-empty items.
 * @param {string} name
 * @param {string | URLSearchParams} [search]
 * @returns {string[]}
 */
export const getList = (name, search) =>
  queryParams(search)
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((item) => item.trim())
    .filter((item) => item !== "");

/**
 * One parameter value as query text, or `null` when it should be left out (`null`, `undefined`, `""`, `[]`).
 * @param {QueryValue} value
 * @returns {string | null}
 */
function queryText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = Array.isArray(value) ? value.join(",") : String(value);
  return text === "" ? null : text;
}

/** @param {string} text */
const encode = (text) => encodeURIComponent(text).replace(/%2C/g, ",");

/**
 * A query string without `?` from a record: arrays are joined with commas, `null`, `undefined`, `""` and `[]` are left
 * out, keys keep their order. `toQuery({ from: "PAR", stops: [0, 1] })` → "from=PAR&stops=0,1".
 * @param {Record<string, QueryValue> | Iterable<[string, QueryValue]>} params
 * @returns {string}
 */
export function toQuery(params) {
  const entries = Symbol.iterator in params ? Array.from(params) : Object.entries(params);
  return entries
    .map(([key, value]) => [key, queryText(value)])
    .filter((entry) => entry[1] !== null)
    .map(([key, text]) => `${encode(String(key))}=${encode(String(text))}`)
    .join("&");
}

/**
 * `path` with the query string of `params` (and no `?` when it is empty).
 * @param {string} path
 * @param {Record<string, QueryValue> | Iterable<[string, QueryValue]>} params
 */
export function withQuery(path, params) {
  const query = toQuery(params);
  return query === "" ? path : `${path}?${query}`;
}

/**
 * Changes the current page's query string in place with `history.replaceState`, so reload and Back reuse it (for
 * example the `search=srch_…` id after a search). `null`, `undefined`, `""` and `[]` remove a parameter; the others
 * are set, in the place of the parameter's first occurrence (new ones at the end); parameters not named keep their
 * values, repeated ones included (`stops=0&stops=1`), and their order. Returns the new path with its query and
 * fragment.
 * @param {Record<string, QueryValue>} changes
 * @param {{ location?: Location, history?: History }} [env]
 * @returns {string}
 */
export function replaceQuery(changes, { location = globalThis.location, history = globalThis.history } = {}) {
  /** @type {Array<[string, QueryValue]>} */
  const entries = [];
  /** @type {Set<string>} */
  const placed = new Set();
  for (const [key, value] of new URLSearchParams(location.search)) {
    if (!Object.hasOwn(changes, key)) {
      entries.push([key, value]);
    } else if (!placed.has(key)) {
      placed.add(key);
      entries.push([key, changes[key]]);
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (!placed.has(key)) {
      entries.push([key, value]);
    }
  }
  const target = `${withQuery(location.pathname, entries)}${location.hash}`;
  history.replaceState(history.state, "", target);
  return target;
}

/**
 * Reads a one-time parameter (an e-mail verification or password reset token) and removes it from the address bar
 * with `history.replaceState`, so it is not kept in the history, bookmarks or the `Referer` of later requests.
 * @param {string} name
 * @param {{ location?: Location, history?: History }} [env]
 * @returns {string | null}
 */
export function takeParam(name, env = {}) {
  const location = env.location ?? globalThis.location;
  const value = new URLSearchParams(location.search).get(name);
  if (value !== null) {
    replaceQuery({ [name]: null }, { location, history: env.history ?? globalThis.history });
  }
  return value;
}

/**
 * Whether `text` is a path on this storefront: exactly one leading `/` (`//host` is protocol-relative), and no control
 * character, white space or backslash.
 * @param {string} text
 */
const isStorefrontPath = (text) =>
  text.startsWith("/") && !text.startsWith("//") && !hasUnsafeUrlCharacter(text) && !/\s/.test(text);

/**
 * A redirect target that stays on this storefront: a path with exactly one leading `/`, before and after its dot
 * segments are resolved (its query and fragment kept). Anything else (`//evil.example`, `/.//evil.example`,
 * `/\evil.example`, `https://…`, `javascript:…`, a path without the leading `/`, control characters or white space, a
 * missing value) gives `/`.
 * @param {unknown} value
 * @returns {string}
 */
export function safeNext(value) {
  if (typeof value !== "string" || value.length > MAX_NEXT_LENGTH || !isStorefrontPath(value)) {
    return DEFAULT_NEXT;
  }
  try {
    const url = new URL(value, PROBE_ORIGIN);
    const target = `${url.pathname}${url.search}${url.hash}`;
    // Dot segments are resolved here, so "/.//evil.example" and "/a/..//evil.example" come out as "//evil.example":
    // the normalised path is checked again, with the same rule (FIX-W26-SECURITY).
    return url.origin === PROBE_ORIGIN && isStorefrontPath(target) ? target : DEFAULT_NEXT;
  } catch {
    return DEFAULT_NEXT;
  }
}

/**
 * The safe `next` parameter of `search` (default: the current page's), `/` when it is missing or unsafe.
 * @param {string | URLSearchParams} [search]
 */
export const nextParam = (search) => safeNext(getParam("next", search));

/**
 * The current page's path and query, for a `next=` link back to it (for example from the sign-in link).
 * @param {Location} [location]
 */
export const currentPath = (location = globalThis.location) => `${location.pathname}${location.search}`;
