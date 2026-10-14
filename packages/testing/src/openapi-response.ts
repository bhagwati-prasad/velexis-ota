// expectResponseToMatch (X-015; ADR-0006 "Response conformance", ADR-0015 "Contract tests"): checks an HTTP response
// against the OpenAPI document of its API. The status must be one the operation documents (exact, `2XX`-style range,
// or `default`), and the body must validate, with Ajv 2020 and ajv-formats, against that response's JSON schema.
// A failure names every failing path of the body.
//
// The documents are OpenAPI 3.1, whose schemas are JSON Schema draft 2020-12. Ajv gets one schema built from
// `components.schemas` (as `$defs`, with the `#/components/schemas/` references rewritten, as the error-envelope tests
// of @velexis/errors do) and compiles each response schema against it once. Ajv runs in strict mode for unknown
// keywords, so a misspelt keyword in a document fails loudly; the OpenAPI annotations (`discriminator`, `example`,
// `xml`, `externalDocs`) and the `x-*` extensions are declared as annotation keywords. `strictTypes` and
// `strictRequired` are off: they judge how a schema is written (`properties` without `type: object`, `required` in
// another `allOf` branch), not what it accepts, and the schemas copied from the Amadeus specifications use both.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OtaOperationId, PlatformOperationId } from "@velexis/api-types/operations";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";

/** The two API documents, relative to the repository root (the `apis` of packages/api-types/redocly.yaml). */
export const API_DOCUMENTS = Object.freeze({
  ota: "ota/backend/openapi/velexis-ota-booking-api.openapi.yaml",
  platform: "platform/backend/openapi/velexis-platform-api.openapi.yaml",
} as const);
export type ApiDocumentName = keyof typeof API_DOCUMENTS;

const DOCUMENT_LABELS: Readonly<Record<ApiDocumentName, string>> = { ota: "OTA", platform: "platform" };

/** The repository root (this file is `packages/testing/src/*.ts` or `packages/testing/dist/*.js`). */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** What is checked of a response: a Supertest response, or `{ status, body }` built from a `fetch` response. */
export interface ResponseLike {
  readonly status: number;
  /** The parsed JSON body. Supertest gives `{}` when there is no body. */
  readonly body?: unknown;
}

/** One reason a response does not match. */
export interface ResponseProblem {
  /** JSON pointer into the body (`/travelers/0/id`); `""` for the body itself and for the status. */
  readonly path: string;
  /** The JSON Schema keyword that failed (`required`, `type`, `pattern`, …), or `status` / `body`. */
  readonly keyword: string;
  /** What is wrong, without the value (a body may hold personal data or tokens). */
  readonly message: string;
}

export interface ExpectResponseOptions {
  /** The API document: `ota` (default) or `platform`. */
  readonly document?: ApiDocumentName | undefined;
}

/** The response does not match the document. `problems` lists every failing path. */
export class ResponseMismatchError extends Error {
  override readonly name = "ResponseMismatchError";
  readonly operationId: string;
  readonly status: number;
  readonly problems: readonly ResponseProblem[];

  constructor(message: string, operationId: string, status: number, problems: readonly ResponseProblem[]) {
    super(message);
    this.operationId = operationId;
    this.status = status;
    this.problems = Object.freeze(problems.map((problem) => Object.freeze({ ...problem })));
  }
}

/** Response checks against one parsed OpenAPI 3.1 document. */
export interface ResponseChecker {
  /** `OTA`, `platform` or the label given to `createResponseChecker`. */
  readonly label: string;
  /** Every `operationId` of the document, in document order. */
  operationIds(): readonly string[];
  /** The problems of `res` for `operationId`: empty when it matches. Throws on an unknown `operationId`. */
  check(operationId: string, res: ResponseLike): readonly ResponseProblem[];
  /** Throws `ResponseMismatchError` naming every problem when `res` does not match. */
  expectToMatch(operationId: string, res: ResponseLike): void;
}

type JsonObject = Record<string, unknown>;

interface IndexedOperation {
  readonly method: string;
  readonly path: string;
  readonly responses: JsonObject;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const SCHEMA_REF_PREFIX = "#/components/schemas/";
const ROOT_ID = "https://velexis.invalid/openapi/components.json";
/** OpenAPI's Schema Object fields that are not JSON Schema keywords: annotations for Ajv. */
const OPENAPI_ANNOTATIONS = ["discriminator", "example", "xml", "externalDocs"];
/** How many problems the error message lists; `problems` keeps them all. */
const MESSAGE_PROBLEM_LIMIT = 40;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const escapePointer = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");
const unescapePointer = (segment: string): string => segment.replaceAll("~1", "/").replaceAll("~0", "~");

/** Every `x-*` key of the document, at any depth: declared to Ajv as annotations. */
function extensionKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => extensionKeys(item, found));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("x-")) {
        found.add(key);
      }
      extensionKeys(child, found);
    }
  }
  return found;
}

/** A deep copy of a schema whose `#/components/schemas/X` references point to `$defs/X` of the Ajv root schema. */
function rewriteRefs(value: unknown, label: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRefs(item, label));
  }
  if (!isObject(value)) {
    return value;
  }
  const copy: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      if (!child.startsWith(SCHEMA_REF_PREFIX)) {
        throw new Error(
          `The ${label} document has a schema $ref that is not into components.schemas: ${child}`,
        );
      }
      copy[key] = `${ROOT_ID}#/$defs/${child.slice(SCHEMA_REF_PREFIX.length)}`;
    } else {
      copy[key] = rewriteRefs(child, label);
    }
  }
  return copy;
}

/** The value at a local reference `#/a/b` of the document. */
function resolvePointer(document: JsonObject, ref: string, label: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`The ${label} document has a $ref that is not local: ${ref}`);
  }
  let current: unknown = document;
  for (const segment of ref.slice(2).split("/")) {
    const key = unescapePointer(decodeURIComponent(segment));
    if (!isObject(current) || !(key in current)) {
      throw new Error(`The ${label} document has a $ref that resolves to nothing: ${ref}`);
    }
    current = current[key];
  }
  return current;
}

/** A Response Object, following `$ref`s (`#/components/responses/…`). */
function resolveResponse(document: JsonObject, response: unknown, label: string): JsonObject {
  let current = response;
  for (let depth = 0; isObject(current) && typeof current["$ref"] === "string"; depth += 1) {
    if (depth > 10) {
      throw new Error(`The ${label} document has a $ref cycle at ${String(current["$ref"])}`);
    }
    current = resolvePointer(document, current["$ref"], label);
  }
  if (!isObject(current)) {
    throw new Error(`The ${label} document has a response that is not an object`);
  }
  return current;
}

/** The documented response key of `status`: the exact code, its `2XX`-style range, or `default`. */
function responseKey(responses: JsonObject, status: number): string | undefined {
  const exact = String(status);
  const range = `${exact.charAt(0)}XX`;
  return [exact, range, range.toLowerCase(), "default"].find((key) => key in responses);
}

/** `application/json` or another `…+json` media type of a response's content, ignoring parameters. */
function jsonMediaType(content: JsonObject): string | undefined {
  const types = Object.keys(content);
  return (
    types.find((type) => type.split(";")[0]?.trim().toLowerCase() === "application/json") ??
    types.find((type) => /^application\/[\w.+-]+\+json$/i.test(type.split(";")[0]?.trim() ?? ""))
  );
}

/** Supertest answers `{}` for a response without a body, `fetch` users pass `undefined`, `null` or `""`. */
function isEmptyBody(body: unknown): boolean {
  return (
    body === undefined || body === null || body === "" || (isObject(body) && Object.keys(body).length === 0)
  );
}

function describeValues(values: unknown): string {
  if (!Array.isArray(values)) {
    return "";
  }
  const shown = values.slice(0, 10).map((value) => JSON.stringify(value));
  return `: ${shown.join(", ")}${values.length > shown.length ? ", …" : ""}`;
}

/** Ajv's error as a problem: the path of the failing property and a message without the value. */
function toProblem(error: ErrorObject): ResponseProblem {
  const params = error.params as Record<string, unknown>;
  const child = (name: unknown): string => `${error.instancePath}/${escapePointer(String(name))}`;
  switch (error.keyword) {
    case "required":
    case "dependentRequired":
      return {
        path: child(params["missingProperty"]),
        keyword: error.keyword,
        message: "required property is missing",
      };
    case "additionalProperties":
      return {
        path: child(params["additionalProperty"]),
        keyword: error.keyword,
        message: "property is not allowed (additionalProperties: false)",
      };
    case "unevaluatedProperties":
      return {
        path: child(params["unevaluatedProperty"]),
        keyword: error.keyword,
        message: "property is not allowed (unevaluatedProperties: false)",
      };
    case "enum":
      return {
        path: error.instancePath,
        keyword: error.keyword,
        message: `${error.message ?? "must be one of the allowed values"}${describeValues(params["allowedValues"])}`,
      };
    case "const":
      return {
        path: error.instancePath,
        keyword: error.keyword,
        message: `must be equal to ${JSON.stringify(params["allowedValue"])}`,
      };
    default:
      return { path: error.instancePath, keyword: error.keyword, message: error.message ?? "is not valid" };
  }
}

function dedupe(problems: readonly ResponseProblem[]): ResponseProblem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.path}\u0000${problem.keyword}\u0000${problem.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatMismatch(
  label: string,
  operationId: string,
  operation: IndexedOperation,
  res: ResponseLike,
  problems: readonly ResponseProblem[],
): string {
  const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
  const lines = problems.slice(0, MESSAGE_PROBLEM_LIMIT).map((problem) => {
    const where = problem.keyword === "status" ? "(status)" : problem.path === "" ? "(body)" : problem.path;
    return `  - ${where}: ${problem.message}`;
  });
  if (problems.length > MESSAGE_PROBLEM_LIMIT) {
    lines.push(`  - … and ${problems.length - MESSAGE_PROBLEM_LIMIT} more (ResponseMismatchError.problems)`);
  }
  return [
    `${operationId} (${operation.method.toUpperCase()} ${operation.path}): the ${res.status} response does not ` +
      `match the ${label} document, ${count}:`,
    ...lines,
  ].join("\n");
}

/**
 * Response checks against a parsed OpenAPI 3.1 document. `expectResponseToMatch` uses one per API document; tests of
 * other documents (fixtures) build their own.
 */
export function createResponseChecker(
  document: unknown,
  options: { readonly label: string },
): ResponseChecker {
  const { label } = options;
  if (
    !isObject(document) ||
    typeof document["openapi"] !== "string" ||
    !document["openapi"].startsWith("3.1.")
  ) {
    throw new Error(`The ${label} document is not OpenAPI 3.1, whose schemas are JSON Schema draft 2020-12`);
  }
  const operations = new Map<string, IndexedOperation>();
  for (const [path, item] of Object.entries(isObject(document["paths"]) ? document["paths"] : {})) {
    for (const method of HTTP_METHODS) {
      const operation = isObject(item) ? item[method] : undefined;
      if (isObject(operation) && typeof operation["operationId"] === "string") {
        const responses = isObject(operation["responses"]) ? operation["responses"] : {};
        operations.set(operation["operationId"], { method, path, responses });
      }
    }
  }

  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
    logger: false,
  });
  addFormats(ajv);
  for (const keyword of [...OPENAPI_ANNOTATIONS, ...extensionKeys(document)]) {
    ajv.addKeyword({ keyword });
  }
  const components = isObject(document["components"]) ? document["components"] : {};
  ajv.addSchema({ $id: ROOT_ID, $defs: rewriteRefs(components["schemas"] ?? {}, label) });
  const validators = new Map<string, ValidateFunction>();

  const check = (operationId: string, res: ResponseLike): readonly ResponseProblem[] => {
    const operation = operations.get(operationId);
    if (operation === undefined) {
      throw new Error(`expectResponseToMatch: the ${label} document has no operation "${operationId}"`);
    }
    const key = responseKey(operation.responses, res.status);
    if (key === undefined) {
      const documented = Object.keys(operation.responses).join(", ");
      return [
        {
          path: "",
          keyword: "status",
          message: `${res.status} is not a documented status of ${operationId} (documented: ${documented})`,
        },
      ];
    }
    const response = resolveResponse(document, operation.responses[key], label);
    const content = isObject(response["content"]) ? response["content"] : {};
    if (Object.keys(content).length === 0) {
      return isEmptyBody(res.body)
        ? []
        : [
            {
              path: "",
              keyword: "body",
              message: `the ${key} response is documented without a body, but it has one`,
            },
          ];
    }
    const mediaType = jsonMediaType(content);
    if (mediaType === undefined) {
      throw new Error(
        `expectResponseToMatch: the ${key} response of ${operationId} has no JSON content ` +
          `(${Object.keys(content).join(", ")}); check its body another way`,
      );
    }
    const media = content[mediaType];
    const schema = isObject(media) ? media["schema"] : undefined;
    if (schema === undefined) {
      return [];
    }
    const cacheKey = `${operationId} ${key} ${mediaType}`;
    let validate = validators.get(cacheKey);
    if (validate === undefined) {
      validate = ajv.compile(rewriteRefs(schema, label) as JsonObject);
      validators.set(cacheKey, validate);
    }
    return validate(res.body) ? [] : dedupe((validate.errors ?? []).map(toProblem));
  };

  return Object.freeze({
    label,
    operationIds: () => Object.freeze([...operations.keys()]),
    check,
    expectToMatch: (operationId: string, res: ResponseLike): void => {
      const problems = check(operationId, res);
      if (problems.length > 0) {
        const operation = operations.get(operationId) as IndexedOperation;
        throw new ResponseMismatchError(
          formatMismatch(label, operationId, operation, res, problems),
          operationId,
          res.status,
          problems,
        );
      }
    },
  });
}

const checkers = new Map<ApiDocumentName, ResponseChecker>();

/** The checker of an API document of the repository, parsed once per process (the OTA document takes ~0.5 s). */
export function responseChecker(name: ApiDocumentName): ResponseChecker {
  const cached = checkers.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const label = DOCUMENT_LABELS[name];
  const file = join(REPO_ROOT, API_DOCUMENTS[name]);
  if (!existsSync(file)) {
    const when = name === "platform" ? "; the platform plan creates it in M1 (ADR-0006)" : "";
    throw new Error(
      `expectResponseToMatch: the ${label} document ${API_DOCUMENTS[name]} does not exist yet${when}`,
    );
  }
  const checker = createResponseChecker(parse(readFileSync(file, "utf8")), { label });
  checkers.set(name, checker);
  return checker;
}

/**
 * Asserts that `res` is a documented response of `operationId`: its status is listed by the operation (exact,
 * `2XX`-style range or `default`) and its body validates against that response's JSON schema (Ajv 2020 with
 * ajv-formats). Otherwise throws `ResponseMismatchError`, whose message names every failing path, for example
 * `/reference: required property is missing`. Every integration test that calls an endpoint uses it (ADR-0015).
 *
 *   expectResponseToMatch("getBooking", await request(app).get(`/v1/bookings/${id}`));
 *   expectResponseToMatch("listPlans", res, { document: "platform" });
 */
export function expectResponseToMatch(
  operationId: OtaOperationId,
  res: ResponseLike,
  options?: { readonly document?: "ota" | undefined },
): void;
export function expectResponseToMatch(
  operationId: PlatformOperationId,
  res: ResponseLike,
  options: { readonly document: "platform" },
): void;
export function expectResponseToMatch(
  operationId: string,
  res: ResponseLike,
  options: ExpectResponseOptions = {},
): void {
  responseChecker(options.document ?? "ota").expectToMatch(operationId, res);
}
