// The `ifMatch` param of the SDK methods whose operation takes `If-Match` (ota/sdk/README.md §5.2; one rule for the
// `account`, `bookings` and `console` namespaces since FIX-W27-FOLLOWUPS, SDK-012's rule before that). `ifMatch` is
// the resource `version` of the last read (a whole number, sent as its ETag `"<version>"`) or the ETag itself (a
// non-blank string of visible ASCII, sent as it is). A method whose operation requires it refuses a missing or
// malformed `ifMatch` with a `TypeError` before any request (also before the CSRF request of cookie mode), and so a
// call without params: an operation without a path parameter (`account.update`, `account.preferences.update`,
// `console.settings.storefront.update`) would otherwise go out without `If-Match`. The message names the parameter and
// whose version it is, never its value. `console.settings.templates.put` takes it only when given and refuses a
// malformed one (`optionalIfMatch`); the checkout steps take it only when given too and pass it to `core.call` as it
// is (internal/client.js sends a number as its ETag).

/** @typedef {import("./operations.js").Operation} Operation */

/**
 * Whether a value is a plain object, the only kind of params `core.call` accepts.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * A character that cannot be part of a header value as `ifMatch` sends it: anything but tab and visible ASCII with
 * spaces (CR, LF and NUL would make `Headers` throw, other characters are not an ETag).
 */
const NOT_HEADER_TEXT = /[^\t\x20-\x7e]/;

/**
 * The `If-Match` value of an `ifMatch` param: a version number becomes its ETag `"<version>"`, a non-blank string of
 * visible ASCII is an ETag and is sent as it is; anything else is `undefined`.
 * @param {unknown} ifMatch
 * @returns {string | undefined}
 */
export function ifMatchValue(ifMatch) {
  if (typeof ifMatch === "number" && Number.isSafeInteger(ifMatch) && ifMatch >= 0) {
    return `"${ifMatch}"`;
  }
  if (typeof ifMatch !== "string" || ifMatch.trim() === "" || NOT_HEADER_TEXT.test(ifMatch)) {
    return undefined;
  }
  return ifMatch;
}

/**
 * The params of a call whose operation requires `If-Match`, with `ifMatch` as the header value (`ifMatchValue`).
 * Params that are neither left out nor a plain object are returned unchanged, so `core.call` refuses them with its
 * usual `TypeError`.
 * @param {Operation} operation
 * @param {string} resource what the version belongs to, as the message names it: `booking`, `account`, `markup rule` …
 * @param {{ ifMatch?: unknown } | undefined} params
 * @returns {object | undefined}
 * @throws {TypeError} without a valid `ifMatch`, a call without params included
 */
export function requireIfMatch(operation, resource, params) {
  if (params !== undefined && !isPlainObject(params)) {
    return params;
  }
  const ifMatch = ifMatchValue(params?.ifMatch);
  if (ifMatch === undefined) {
    throw new TypeError(
      `Velexis SDK: ${operation.method} ${operation.path} needs "ifMatch", the ${resource} version (a whole number) or its ETag (a string)`,
    );
  }
  return { ...params, ifMatch };
}

/**
 * The params of a call whose operation takes `If-Match` only when its resource already exists: without `ifMatch`
 * (`undefined` or `null`) they are returned unchanged and no `If-Match` is sent; a given `ifMatch` becomes the header
 * value as `requireIfMatch` makes it. Params that are not a plain object are returned unchanged, so `core.call` refuses
 * them with its usual `TypeError`.
 * @param {Operation} operation
 * @param {string} resource what the version belongs to, as the message names it
 * @param {{ ifMatch?: unknown } | undefined} params
 * @returns {object | undefined}
 * @throws {TypeError} with a malformed `ifMatch`
 */
export function optionalIfMatch(operation, resource, params) {
  if (!isPlainObject(params) || params["ifMatch"] === undefined || params["ifMatch"] === null) {
    return params;
  }
  const ifMatch = ifMatchValue(params["ifMatch"]);
  if (ifMatch === undefined) {
    throw new TypeError(
      `Velexis SDK: ${operation.method} ${operation.path}: "ifMatch", when given, must be the ${resource} version (a whole number) or its ETag (a string)`,
    );
  }
  return { ...params, ifMatch };
}
