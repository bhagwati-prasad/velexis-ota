// The `@throws` JSDoc of the client's methods against the working OpenAPI document (lead decision (9e) of 2026-11-06,
// FIX-W45-OTA): each method's operation lists in `x-error-codes` the codes the API can answer it, the generic refusals
// of the guards included (the document's info.description, **Generic refusals**), and the SDK throws each code as the
// class `errorClassFor` gives it for its catalogue status (src/internal/errors.js, ota/sdk/README.md §5.3). So the
// JSDoc of every method must:
//
//   - name a `@throws` class for every class its operation's codes map to;
//   - name each generic refusal its operation lists (`GENERIC`) in the `@throws` tag of that code's class, as
//     FIX-W39-OTA named `SERVICE_UNAVAILABLE` on storefront.get;
//   - name only catalogue codes its operation lists, each in the tag of the class it maps to; a deferred operation may
//     name `NOT_IMPLEMENTED` (501, the route-parity answer of `x-milestone`, never in `x-error-codes`) under
//     `ServerError`, and the only other classes are the client's own: `TypeError` (refused before any request) and
//     `ConnectionError` (no response).
//
// The methods and their JSDoc come from the TypeScript checker on src/ (the program tsc --checkJs builds): the
// properties of `createVelexisClient`'s result, walked down the namespaces, and the `@throws` tags of each method's
// declaration. Backticked words that are not catalogue codes (field codes, client codes such as `ABORTED`) are prose.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { errorClassFor } from "../../src/internal/errors.js";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
/** The working contract. */
const DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

/**
 * The generic refusals of the guards whose code the JSDoc names where the operation lists them (info.description,
 * **Generic refusals**): the caller guard's, the scope guard's, the session guards' and the permission guard's.
 */
const GENERIC = [
  "VALIDATION_FAILED",
  "INVALID_REQUEST",
  "INVALID_API_KEY",
  "ORIGIN_NOT_ALLOWED",
  "SCOPE_NOT_ALLOWED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
];

/** Classes of failures the client raises itself, which no API code maps to. */
const CLIENT_CLASSES = ["TypeError", "ConnectionError"];

/** A backticked public error code in a tag's text. */
const CODE = /`([A-Z][A-Z0-9_]+)`/g;

/**
 * Parsing the 50,000-line document and building the checker's program over src/ (about 25 files with the DOM lib) take
 * a second or two alone and much longer while Turborepo runs every package's tests at once on a CI runner, so the hook
 * gets its own budget; the tests only compare what it read.
 */
const SETUP_TIMEOUT_MS = 60_000;

/**
 * @typedef {object} Operation
 * @property {string[]} codes the operation's `x-error-codes`
 * @property {boolean} deferred `x-milestone: deferred`
 */

/** @typedef {{ cls: string, text: string }} ThrowsTag */

/** @type {Record<string, { status: number }>} */
let catalogue = {};
/** @type {string} */
let introduction = "";
/** The SDK operations of the document by `x-sdk-method`. @type {Map<string, Operation>} */
const operations = new Map();
/** The `@throws` tags of each client method by its dotted path. @type {Map<string, ThrowsTag[]>} */
const methods = new Map();

/** The SDK operations of a parsed document (no `x-internal` or `x-sdk-exclude` operation has a method). */
function readOperations(document) {
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (
        operation !== undefined &&
        typeof operation["x-sdk-method"] === "string" &&
        operation["x-internal"] !== true &&
        operation["x-sdk-exclude"] !== true
      ) {
        operations.set(operation["x-sdk-method"], {
          codes: operation["x-error-codes"] ?? [],
          deferred: operation["x-milestone"] === "deferred",
        });
      }
    }
  }
}

/** The `@throws` tags of every method of a client, read by the TypeScript checker from src/. */
function readThrowsTags() {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(SDK_ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) {
    throw new Error("tsconfig.json could not be read");
  }
  const entry = join(SDK_ROOT, "src", "index.js");
  const program = ts.createProgram({ rootNames: [entry], options: parsed.options });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  const create =
    moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.name === "createVelexisClient");
  if (!source || !create) {
    throw new Error("src/index.js exports no createVelexisClient");
  }
  const client = checker.getTypeOfSymbolAtLocation(create, source).getCallSignatures()[0]?.getReturnType();
  if (!client) {
    throw new Error("createVelexisClient has no call signature");
  }
  const walk = (type, path) => {
    for (const property of type.getProperties()) {
      const propertyType = checker.getTypeOfSymbolAtLocation(property, source);
      const name = [...path, property.name];
      if (propertyType.getCallSignatures().length > 0) {
        const declaration = property.declarations?.[0];
        const tags = declaration ? ts.getJSDocTags(declaration) : [];
        methods.set(
          name.join("."),
          tags
            .filter((tag) => tag.tagName.text === "throws")
            .map((tag) => ({
              cls: ts.isJSDocThrowsTag(tag) && tag.typeExpression ? tag.typeExpression.type.getText() : "",
              text: ts.getTextOfJSDocComment(tag.comment) ?? "",
            })),
        );
      } else if (path.length < 3) {
        // Namespaces (`console`) and their groups (`console.settings.markupRules`): methods sit at most four deep.
        walk(propertyType, name);
      }
    }
  };
  walk(client, []);
}

beforeAll(() => {
  const document = parse(readFileSync(DOCUMENT, "utf8"));
  catalogue = document["x-error-catalogue"];
  introduction = String(document.info.description);
  readOperations(document);
  readThrowsTags();
}, SETUP_TIMEOUT_MS);

/** The class the SDK throws a catalogue code as (its status in the document's catalogue). */
const classOf = (code) => errorClassFor(catalogue[code].status, code).name;

/** The catalogue codes a tag names. */
const codesOf = (tag) =>
  [...tag.text.matchAll(CODE)].map((match) => match[1]).filter((code) => code in catalogue);

describe("the @throws JSDoc of the client's methods (FIX-W45-OTA)", () => {
  it("[FIX-W45-OTA AC3] reads the @throws tags of every client method that the document has an operation for", () => {
    expect(operations.size).toBeGreaterThanOrEqual(128);
    const missing = [...operations.keys()].filter((name) => (methods.get(name) ?? []).length === 0);
    expect(missing).toEqual([]);
    // Every tag names its class.
    const unnamed = [...methods].flatMap(([name, tags]) =>
      tags.filter((tag) => tag.cls === "").map(() => name),
    );
    expect(unnamed).toEqual([]);
  });

  it("[FIX-W45-OTA AC3] maps the generic refusals to the classes the API's statuses give them", () => {
    expect(GENERIC.map((code) => [code, classOf(code)])).toEqual([
      ["VALIDATION_FAILED", "ValidationError"],
      ["INVALID_REQUEST", "ValidationError"],
      ["INVALID_API_KEY", "AuthenticationError"],
      ["ORIGIN_NOT_ALLOWED", "PermissionError"],
      ["SCOPE_NOT_ALLOWED", "PermissionError"],
      ["UNAUTHENTICATED", "AuthenticationError"],
      ["FORBIDDEN", "PermissionError"],
    ]);
    // The document's introduction says how it lists them.
    for (const code of GENERIC) {
      expect([code, introduction.includes(code)]).toEqual([code, true]);
    }
  });

  it("[FIX-W45-OTA AC3] names a @throws class for every class its operation's x-error-codes map to", () => {
    const missing = [];
    for (const [name, operation] of operations) {
      const named = new Set((methods.get(name) ?? []).map((tag) => tag.cls));
      const needed = new Map();
      for (const code of operation.codes) {
        needed.set(classOf(code), [...(needed.get(classOf(code)) ?? []), code]);
      }
      for (const [cls, codes] of needed) {
        if (!named.has(cls)) {
          missing.push(`${name}: @throws {${cls}} for ${codes.join(", ")}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("[FIX-W45-OTA AC3] names each generic refusal its operation lists in the @throws tag of its class", () => {
    const missing = [];
    for (const [name, operation] of operations) {
      const tags = methods.get(name) ?? [];
      for (const code of GENERIC.filter((generic) => operation.codes.includes(generic))) {
        if (!tags.some((tag) => tag.cls === classOf(code) && codesOf(tag).includes(code))) {
          missing.push(`${name}: ${code} in @throws {${classOf(code)}}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // The 18 operations that OBE-095 gave their 400 name it with ValidationError (VALIDATION_FAILED, INVALID_REQUEST).
    for (const name of [
      "storefront.get",
      "auth.getSession",
      "account.get",
      "account.preferences.get",
      "account.dataExports.get",
      "account.savedTravelers.get",
      "account.savedTravelers.delete",
      "reference.airports.get",
      "reference.airlines.get",
      "flights.getSearch",
      "flights.getOffer",
      "flights.getPricedOffer",
      "flights.getAncillaries",
      "flights.getFareRules",
      "checkout.get",
      "checkout.getPayment",
      "bookings.quoteCancellation",
      "bookings.getAncillaries",
    ]) {
      const validation = (methods.get(name) ?? []).find((tag) => tag.cls === "ValidationError");
      expect([name, validation ? codesOf(validation) : []]).toEqual([
        name,
        expect.arrayContaining(["VALIDATION_FAILED", "INVALID_REQUEST"]),
      ]);
    }
  });

  it("[FIX-W45-OTA AC3] names only codes its operation lists, each under the class the SDK throws it as", () => {
    const problems = [];
    for (const [name, operation] of operations) {
      const mapped = new Set(operation.codes.map(classOf));
      for (const tag of methods.get(name) ?? []) {
        const allowed = mapped.has(tag.cls) || CLIENT_CLASSES.includes(tag.cls);
        const deferredServer = operation.deferred && tag.cls === "ServerError";
        if (!allowed && !deferredServer) {
          problems.push(`${name}: @throws {${tag.cls}} matches none of its codes`);
        }
        for (const code of codesOf(tag)) {
          if (code === "NOT_IMPLEMENTED" && operation.deferred && tag.cls === "ServerError") {
            continue;
          }
          if (!operation.codes.includes(code)) {
            problems.push(`${name}: names ${code}, which its operation does not list`);
          } else if (classOf(code) !== tag.cls) {
            problems.push(`${name}: names ${code} under ${tag.cls}; the SDK throws it as ${classOf(code)}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
