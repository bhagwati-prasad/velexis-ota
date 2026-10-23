// `ifMatch` across the namespaces (FIX-W27-FOLLOWUPS, internal/if-match.js): every SDK method whose route-table entry
// takes `If-Match` either requires it, and then refuses a call without a valid `ifMatch` with SDK-012's `TypeError`
// before any request (also a call without params, which an operation without a path parameter would otherwise send
// without `If-Match`: `account.update()`, `account.preferences.update()`, `console.settings.storefront.update()`), or
// takes it only when given (the checkout steps and `console.settings.templates.put`, tested with their namespaces).
// The helper itself is checked too. Requests go to the fake fetch only, and none is expected.
import { describe, expect, it, vi } from "vitest";

import { createVelexisClient } from "../../src/index.js";
import { ifMatchValue, optionalIfMatch, requireIfMatch } from "../../src/internal/if-match.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch } from "../helpers/fake-fetch.js";

/** Fake keys and tokens with the right shapes; none of them works anywhere. */
const PK = "pk_test_fixw27_fake";
const AT = "at_fixw27_fake_customer";
const SK = "sk_test_fixw27_fake_secret";
const STAFF_AT = "at_fixw27_fake_staff";

/** @typedef {import("../../src/index.js").VelexisClient} VelexisClient */
/** @typedef {import("../../src/internal/operations.js").Operation} Operation */
/** @typedef {(params?: unknown, options?: unknown) => Promise<unknown>} AnyMethod */

/**
 * The methods whose operation requires `If-Match`, by `x-sdk-method`, with what the version belongs to as the
 * `TypeError` names it.
 * @type {Record<string, string>}
 */
const REQUIRED = {
  "account.update": "account",
  "account.preferences.update": "preferences",
  "account.savedTravelers.update": "saved traveler",
  "bookings.update": "booking",
  "bookings.addAncillaries": "booking",
  "bookings.cancel": "booking",
  "console.bookings.patch": "booking",
  "console.bookings.issue": "booking",
  "console.bookings.cancel": "booking",
  "console.payments.capture": "payment",
  "console.settings.markupRules.update": "markup rule",
  "console.settings.markupRules.delete": "markup rule",
  "console.settings.feeRules.update": "fee rule",
  "console.settings.feeRules.delete": "fee rule",
  "console.settings.pages.update": "page",
  "console.settings.pages.delete": "page",
  "console.settings.storefront.update": "storefront settings",
};

/** The methods that send `If-Match` only when `ifMatch` is given (namespaces-checkout and -console-settings tests). */
const OPTIONAL = [
  "checkout.setTravelers",
  "checkout.setContacts",
  "checkout.setAncillaries",
  "checkout.setRemarks",
  "console.settings.templates.put",
];

/**
 * The route-table entry of a method.
 * @param {string} method its `x-sdk-method`
 * @returns {Operation}
 */
const entryOf = (method) => op[/** @type {keyof typeof op} */ (method.replace(/\./g, "_"))];

/**
 * The method of a client at a dotted path, or `undefined`.
 * @param {VelexisClient} client
 * @param {string} path
 * @returns {AnyMethod | undefined}
 */
function methodAt(client, path) {
  /** @type {unknown} */
  let current = client;
  for (const name of path.split(".")) {
    current =
      current !== null && typeof current === "object"
        ? /** @type {Record<string, unknown>} */ (current)[name]
        : undefined;
  }
  return typeof current === "function" ? /** @type {AnyMethod} */ (current) : undefined;
}

/**
 * The client a method is called with: a staff client in server mode for `console.*`, a customer's in token or cookie
 * mode for the others (cookie mode without a CSRF cookie, so a request would start with the CSRF request).
 * @param {string} method
 * @param {"token" | "cookie"} mode
 * @param {typeof globalThis.fetch} fetch
 */
function clientFor(method, mode, fetch) {
  if (method.startsWith("console.")) {
    return createVelexisClient({ secretKey: SK, accessToken: STAFF_AT, sessionKind: "staff", fetch });
  }
  if (mode === "cookie") {
    vi.stubGlobal("document", { cookie: "" });
    return createVelexisClient({ session: "cookie", fetch });
  }
  return createVelexisClient({ publishableKey: PK, accessToken: AT, fetch });
}

/**
 * The `TypeError` message of a method called without a valid `ifMatch` (SDK-012's).
 * @param {string} method
 */
function messageOf(method) {
  const entry = entryOf(method);
  return `Velexis SDK: ${entry.method} ${entry.path} needs "ifMatch", the ${REQUIRED[method]} version (a whole number) or its ETag (a string)`;
}

/** Every required method in each mode it runs in: console in server mode, the others in token and cookie mode. */
const CALLS = Object.keys(REQUIRED).flatMap((method) =>
  method.startsWith("console.")
    ? [/** @type {const} */ ([method, "token"])]
    : [/** @type {const} */ ([method, "token"]), /** @type {const} */ ([method, "cookie"])],
);

describe("the methods that take ifMatch", () => {
  it("[FIX-W27-FOLLOWUPS AC4] are exactly those whose route-table entry has an If-Match header, each required or optional", () => {
    const withIfMatch = Object.keys(op)
      .filter((key) => "ifMatch" in op[/** @type {keyof typeof op} */ (key)].headerParams)
      .map((key) => key.replace(/_/g, "."))
      .sort();

    expect(withIfMatch).toEqual([...Object.keys(REQUIRED), ...OPTIONAL].sort());
    const client = clientFor("account.get", "token", createFakeFetch().fetch);
    for (const method of withIfMatch) {
      expect(methodAt(client, method), method).toBeTypeOf("function");
    }
  });

  it.each(CALLS)(
    "[FIX-W27-FOLLOWUPS AC4] %s (%s mode) refuses a call without params with SDK-012's TypeError, before any request",
    async (method, mode) => {
      const fake = createFakeFetch();
      const call = /** @type {AnyMethod} */ (methodAt(clientFor(method, mode, fake.fetch), method));

      const error = await call().catch((/** @type {unknown} */ caught) => caught);

      expect(error).toBeInstanceOf(TypeError);
      expect(/** @type {TypeError} */ (error).message).toBe(messageOf(method));
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each(CALLS)(
    "[FIX-W27-FOLLOWUPS AC4] %s (%s mode) refuses its path parameters without ifMatch with the same TypeError, before any request",
    async (method, mode) => {
      const fake = createFakeFetch();
      const call = /** @type {AnyMethod} */ (methodAt(clientFor(method, mode, fake.fetch), method));
      const params = Object.fromEntries(entryOf(method).pathParams.map((name) => [name, `${name}_1`]));

      for (const ifMatch of [undefined, null, "", -1]) {
        const error = await call({ ...params, ifMatch }).catch((/** @type {unknown} */ caught) => caught);
        expect(error, String(ifMatch)).toBeInstanceOf(TypeError);
        expect(/** @type {TypeError} */ (error).message).toBe(messageOf(method));
      }
      expect(fake.requests).toHaveLength(0);
    },
  );
});

describe("internal/if-match.js", () => {
  const entry = entryOf("account.update");

  it("turns a version into its ETag and keeps an ETag; anything else is no If-Match value", () => {
    expect([0, 12, '"12"', 'W/"12"', "*"].map(ifMatchValue)).toEqual(['"0"', '"12"', '"12"', 'W/"12"', "*"]);
    for (const bad of [
      undefined,
      null,
      "",
      "  ",
      -1,
      1.5,
      Number.NaN,
      "a\nb",
      '"3€"',
      { version: 3 },
      ["1"],
    ]) {
      expect(ifMatchValue(bad), String(bad)).toBeUndefined();
    }
  });

  it("requireIfMatch copies the params with the header value, and refuses missing params and a missing ifMatch", () => {
    const params = { ifMatch: 7, firstName: "Ada" };
    expect(requireIfMatch(entry, "account", params)).toEqual({ ifMatch: '"7"', firstName: "Ada" });
    expect(params.ifMatch).toBe(7);
    expect(() => requireIfMatch(entry, "account", undefined)).toThrow(TypeError);
    expect(() => requireIfMatch(entry, "account", {})).toThrow(
      'Velexis SDK: PATCH /v1/account needs "ifMatch", the account version (a whole number) or its ETag (a string)',
    );
  });

  it("requireIfMatch passes params that are not a plain object on, for core.call's own TypeError", () => {
    const notPlain = new (class Params {
      ifMatch = 1;
    })();
    expect(requireIfMatch(entry, "account", notPlain)).toBe(notPlain);
    expect(requireIfMatch(entry, "account", /** @type {never} */ (null))).toBeNull();
  });

  it("optionalIfMatch leaves params without ifMatch as they are and refuses a malformed one", () => {
    const template = entryOf("console.settings.templates.put");
    const without = { channel: "email" };
    expect(optionalIfMatch(template, "template", without)).toBe(without);
    expect(optionalIfMatch(template, "template", { ifMatch: null })).toEqual({ ifMatch: null });
    expect(optionalIfMatch(template, "template", undefined)).toBeUndefined();
    expect(optionalIfMatch(template, "template", { ifMatch: 3 })).toEqual({ ifMatch: '"3"' });
    expect(() => optionalIfMatch(template, "template", { ifMatch: "" })).toThrow(
      `Velexis SDK: ${template.method} ${template.path}: "ifMatch", when given, must be the template version (a whole number) or its ETag (a string)`,
    );
  });
});
