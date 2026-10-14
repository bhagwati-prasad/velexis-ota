// Request validation of the Amadeus stub against the Amadeus specifications in docs/amadeus-api (X-026, ADR-0015):
// a malformed request from our client fails loudly with a 400 in the Amadeus error format, one issue per failing
// parameter or body field.
//
// Eight specifications are Swagger 2.0 (JSON Schema draft 4 subset), Queue List is OpenAPI 3.0. Each document is read
// once, normalised and registered with Ajv (draft-07 mode, `strict: false`, ajv-formats) under its own `$id`, so
// every `#/definitions/...`, `#/components/...` or `#/parameters/...` reference resolves inside its own document.
// Normalisation, on a copy:
//   - draft-4 boolean `exclusiveMinimum` / `exclusiveMaximum` become the draft-6+ numeric form;
//   - a `$ref` that points nowhere becomes `{}` (FlightOffersSearch references the undefined `LoyaltyProgram` and
//     `commissionValue`); `danglingRefs()` lists them;
//   - a schema with `properties` but no `type` gets `type: "object"` (FlightOffersSearch's `GetFlightOffersQuery` has
//     none, so a body of `null`, `[]` or a double-encoded JSON string would otherwise pass);
//   - `date-time` accepts local date-times without an offset (`2027-01-15T07:15:00`), which Amadeus uses everywhere.
// Query, header and path parameters are validated as one object `{ path, query, header }` compiled per operation.
// Query values are coerced by the parameter's declared type (`integer`, `number`, `boolean`, `array` with its
// `collectionFormat`) before validation; a query parameter that the specification does not declare is an error.
// The JSON body is validated without any coercion. Validators are compiled on first use and cached.
//
// Issues never quote a value (a request may carry personal data); they name the parameter (`source.parameter`) or the
// body field (`source.pointer`, a JSON pointer) and the rule that failed.
import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join, resolve } from "node:path";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { AMADEUS_ERROR_CODES, type AmadeusIssue } from "./scenarios";

/** docs/amadeus-api of the repository (this file is `src/*.ts` or `dist/*.js` of tools/amadeus-stub). */
export const AMADEUS_SPEC_DIR = resolve(__dirname, "..", "..", "..", "docs", "amadeus-api");

/** Where an operation is in its specification. */
export interface OperationSpec {
  /** File name in docs/amadeus-api. */
  readonly specFile: string;
  /** The key of the operation's path in the document's `paths` (as written there). */
  readonly specPath: string;
  /** The HTTP method, upper case. */
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
}

/** The parts of an HTTP request that the specifications constrain. */
export interface RequestParts {
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly pathParams: Readonly<Record<string, string>>;
  /** The raw body (empty for none). */
  readonly body: string;
}

/** A request that passed validation: its query parameters coerced to their declared types, and its parsed body. */
export interface ValidRequest {
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
}

export type ValidationResult =
  | { readonly ok: true; readonly request: ValidRequest }
  | { readonly ok: false; readonly issues: readonly [AmadeusIssue, ...AmadeusIssue[]] };

/** One Ajv problem of a response body (`validateResponse`). */
export interface ResponseProblem {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
}

type JsonObject = Record<string, unknown>;
type ParamLocation = "path" | "query" | "header";

interface ParameterInfo {
  readonly name: string;
  readonly in: ParamLocation;
  readonly required: boolean;
  /** The declared type used to coerce a query or path value (`items` type for arrays). */
  readonly type: string | undefined;
  readonly itemsType: string | undefined;
  /** Swagger 2.0 `collectionFormat` of an array (`csv` by default; `multi` repeats the parameter). */
  readonly collectionFormat: string;
  readonly schema: JsonObject;
}

interface CompiledOperation {
  readonly parameters: readonly ParameterInfo[];
  readonly validateParameters: ValidateFunction;
  readonly body: { readonly required: boolean; readonly validate: ValidateFunction } | undefined;
}

interface LoadedSpec {
  readonly id: string;
  readonly document: JsonObject;
}

/** The media types a JSON body may be sent with. */
const JSON_BODY = /^application\/(?:vnd\.amadeus\+)?json\s*(?:;|$)/i;
/** Amadeus date-times are local (`2027-01-15T07:15:00`); an offset or `Z` is allowed but not required. */
const AMADEUS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
/** The Swagger 2.0 parameter fields that are JSON Schema keywords. */
const PARAMETER_SCHEMA_KEYS = [
  "type",
  "format",
  "items",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "enum",
  "multipleOf",
] as const;
const COLLECTION_SEPARATORS: Readonly<Record<string, string>> = { csv: ",", ssv: " ", tsv: "\t", pipes: "|" };
/** How many issues one 400 lists at most. */
const MAX_ISSUES = 50;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const escapePointer = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");
const unescapePointer = (segment: string): string => segment.replaceAll("~1", "/").replaceAll("~0", "~");
/** A JSON pointer as a URI fragment (`{` and `}` of path templates are not allowed there unencoded). */
const pointerFragment = (segments: readonly string[]): string =>
  segments.map((segment) => encodeURIComponent(escapePointer(segment)).replaceAll("%24", "$")).join("/");

/** The segments of a local `$ref` (`#/definitions/A~1B` → `["definitions", "A/B"]`); `undefined` for any other. */
function refSegments(ref: string): string[] | undefined {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  try {
    return ref
      .slice(2)
      .split("/")
      .map((raw) => unescapePointer(decodeURIComponent(raw)));
  } catch {
    return undefined;
  }
}

function getPointer(document: unknown, ref: string): unknown {
  const segments = refSegments(ref);
  if (segments === undefined) {
    return undefined;
  }
  let current: unknown = document;
  for (const segment of segments) {
    if (!isObject(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A normalised deep copy of a specification document (see the header comment). */
function normalise(document: JsonObject, dangling: Set<string>): JsonObject {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (!isObject(value)) {
      return value;
    }
    const ref = value["$ref"];
    if (typeof ref === "string" && getPointer(document, ref) === undefined) {
      dangling.add(ref);
      return {};
    }
    const copy: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof child === "boolean") {
        const bound = key === "exclusiveMinimum" ? "minimum" : "maximum";
        if (child && typeof value[bound] === "number") {
          copy[key] = value[bound];
        }
        continue;
      }
      if (
        (key === "minimum" || key === "maximum") &&
        value[`exclusive${key === "minimum" ? "Min" : "Max"}imum`] === true
      ) {
        continue;
      }
      copy[key] = walk(child);
    }
    return copy;
  };
  const copy = walk(document) as JsonObject;
  typeObjectSchemas(copy);
  return copy;
}

/** Schema keywords whose value is one schema, a list of schemas, or a map from names to schemas. */
const SUBSCHEMA_KEYWORDS = ["items", "additionalProperties", "not"] as const;
const SUBSCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "items"] as const;
const SUBSCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "definitions"] as const;
/** Document keys whose values are example data, never schemas. */
const EXAMPLE_KEYS = new Set(["example", "examples", "x-example"]);

/**
 * Gives `type: "object"` to every schema of `document` that declares `properties` but no `type`, in place. Swagger 2.0
 * and OpenAPI 3.0 do not imply the type from `properties`, but Amadeus refuses a request whose body is not an object.
 * Only schema positions are visited (`definitions`, `components.schemas`, every `schema`, and their subschemas), so a
 * property or definition that happens to be called `properties` is never mistaken for a schema.
 */
function typeObjectSchemas(document: JsonObject): void {
  const schemaMap = (value: unknown): void => {
    if (isObject(value)) {
      Object.values(value).forEach(schema);
    }
  };
  const schema = (value: unknown): void => {
    if (!isObject(value)) {
      return;
    }
    if (value["type"] === undefined && isObject(value["properties"])) {
      value["type"] = "object";
    }
    for (const keyword of SUBSCHEMA_KEYWORDS) {
      schema(value[keyword]);
    }
    for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
      const list = value[keyword];
      if (Array.isArray(list)) {
        list.forEach(schema);
      }
    }
    for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
      schemaMap(value[keyword]);
    }
  };
  const node = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(node);
      return;
    }
    if (!isObject(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "schema") {
        schema(child);
      } else if (key === "definitions" || key === "schemas") {
        schemaMap(child);
      } else if (!EXAMPLE_KEYS.has(key)) {
        node(child);
      }
    }
  };
  node(document);
}

function coerce(raw: string, type: string | undefined): unknown {
  switch (type) {
    case "integer":
      return /^-?\d+$/.test(raw) ? Number(raw) : raw;
    case "number":
      return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : raw;
    default:
      return raw;
  }
}

function issueFor(keyword: string): Pick<AmadeusIssue, "code" | "title"> {
  switch (keyword) {
    case "required":
      return { code: AMADEUS_ERROR_CODES.mandatoryDataMissing, title: "MANDATORY DATA MISSING" };
    case "enum":
    case "const":
      return { code: AMADEUS_ERROR_CODES.invalidOption, title: "INVALID OPTION" };
    case "type":
    case "format":
    case "pattern":
      return { code: AMADEUS_ERROR_CODES.invalidFormat, title: "INVALID FORMAT" };
    default:
      return { code: AMADEUS_ERROR_CODES.invalidDataReceived, title: "INVALID DATA RECEIVED" };
  }
}

/** Ajv's message, plus the allowed values of an `enum` (values of the specification, never of the request). */
function describe(error: ErrorObject): string {
  const message = error.message ?? `fails ${error.keyword}`;
  const allowed = (error.params as { allowedValues?: unknown }).allowedValues;
  return error.keyword === "enum" && Array.isArray(allowed) ? `${message}: ${allowed.join(", ")}` : message;
}

function parameterIssue(error: ErrorObject): AmadeusIssue {
  const [location = "", ...rest] = error.instancePath.split("/").slice(1).map(unescapePointer);
  const params = error.params as { missingProperty?: string; additionalProperty?: string };
  const { code, title } = issueFor(error.keyword);
  if (rest.length === 0 && error.keyword === "required" && params.missingProperty !== undefined) {
    return {
      status: 400,
      code,
      title,
      detail: `${location} parameter ${params.missingProperty} is required`,
      source: { parameter: params.missingProperty },
    };
  }
  if (
    rest.length === 0 &&
    error.keyword === "additionalProperties" &&
    params.additionalProperty !== undefined
  ) {
    return {
      status: 400,
      code,
      title,
      detail: `${location} parameter ${params.additionalProperty} is not defined by the specification`,
      source: { parameter: params.additionalProperty },
    };
  }
  const name = rest[0] ?? location;
  return {
    status: 400,
    code,
    title,
    detail: `${location} parameter ${name} ${describe(error)}`,
    source: { parameter: name },
  };
}

function bodyIssue(error: ErrorObject): AmadeusIssue {
  const { code, title } = issueFor(error.keyword);
  const missing = (error.params as { missingProperty?: string }).missingProperty;
  if (error.keyword === "required" && missing !== undefined) {
    const pointer = `${error.instancePath}/${escapePointer(missing)}`;
    return {
      status: 400,
      code,
      title,
      detail: `request body field ${pointer} is required`,
      source: { pointer },
    };
  }
  const pointer = error.instancePath;
  const where = pointer === "" ? "request body" : `request body field ${pointer}`;
  return { status: 400, code, title, detail: `${where} ${describe(error)}`, source: { pointer } };
}

function dedupe(issues: readonly AmadeusIssue[]): AmadeusIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([issue.code, issue.detail, issue.source]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * The Amadeus specifications of a folder, with request validators compiled per operation on first use. One instance
 * can serve many stub servers; `createStubServer` shares one per process unless it is given its own.
 */
export class AmadeusSpecs {
  readonly specDir: string;
  readonly #ajv: Ajv;
  readonly #specs = new Map<string, LoadedSpec>();
  readonly #operations = new Map<string, CompiledOperation>();
  readonly #responses = new Map<string, ValidateFunction>();
  readonly #dangling = new Set<string>();

  constructor(specDir: string = AMADEUS_SPEC_DIR) {
    this.specDir = specDir;
    this.#ajv = new Ajv({ strict: false, allErrors: true, logger: false });
    addFormats(this.#ajv);
    this.#ajv.addFormat("date-time", AMADEUS_DATE_TIME);
  }

  /** The `$ref`s of the loaded documents that point nowhere and were replaced by `{}`, as `<file><ref>`. */
  danglingRefs(): readonly string[] {
    return [...this.#dangling].sort();
  }

  /** Compiles the validators of `operation` now (the server does this at start for its implemented operations). */
  prepare(operation: OperationSpec): void {
    this.#compiled(operation);
  }

  /** Validates a request of `operation`: its parameters, its content type and its JSON body. */
  validateRequest(operation: OperationSpec, request: RequestParts): ValidationResult {
    const compiled = this.#compiled(operation);
    const issues: AmadeusIssue[] = [];
    const values: Record<ParamLocation, JsonObject> = { path: {}, query: {}, header: {} };

    const declared = new Set(compiled.parameters.filter((p) => p.in === "query").map((p) => p.name));
    for (const parameter of compiled.parameters) {
      if (parameter.in === "header") {
        const value = headerValue(request.headers, parameter.name);
        if (value !== undefined) {
          values.header[parameter.name] = value;
        }
      } else if (parameter.in === "path") {
        const value = request.pathParams[parameter.name];
        if (value !== undefined) {
          values.path[parameter.name] = coerce(value, parameter.type);
        }
      } else {
        const raw = request.query.getAll(parameter.name);
        if (raw.length === 0) {
          continue;
        }
        if (parameter.type === "array") {
          const separator = COLLECTION_SEPARATORS[parameter.collectionFormat];
          const items =
            parameter.collectionFormat === "multi" || separator === undefined
              ? raw
              : raw.flatMap((value) => value.split(separator));
          values.query[parameter.name] = items.map((item) => coerce(item, parameter.itemsType));
        } else if (raw.length > 1) {
          issues.push({
            status: 400,
            code: AMADEUS_ERROR_CODES.invalidDataReceived,
            title: "INVALID DATA RECEIVED",
            detail: `query parameter ${parameter.name} must not be repeated`,
            source: { parameter: parameter.name },
          });
        } else {
          values.query[parameter.name] = coerce(raw[0] ?? "", parameter.type);
        }
      }
    }
    for (const name of new Set(request.query.keys())) {
      if (!declared.has(name)) {
        values.query[name] = request.query.get(name);
      }
    }
    if (!compiled.validateParameters(values)) {
      issues.push(...(compiled.validateParameters.errors ?? []).map(parameterIssue));
    }

    let body: unknown;
    if (compiled.body !== undefined) {
      const result = this.#validateBody(compiled.body, request);
      issues.push(...result.issues);
      body = result.body;
    }

    const [first, ...others] = dedupe(issues).slice(0, MAX_ISSUES);
    if (first !== undefined) {
      return { ok: false, issues: [first, ...others] };
    }
    return { ok: true, request: { query: values.query, body } };
  }

  /** The problems of `body` as the `status` response of `operation` (empty when it matches the specification). */
  validateResponse(operation: OperationSpec, status: number, body: unknown): readonly ResponseProblem[] {
    const key = `${operation.specFile} ${operation.method} ${operation.specPath} ${status}`;
    let validate = this.#responses.get(key);
    if (validate === undefined) {
      const { id, document } = this.#spec(operation.specFile);
      const responsesPointer = [...this.#operationPointer(operation), "responses"];
      let pointer = [...responsesPointer, String(status)];
      let response = getPointer(document, `#/${pointerFragment(pointer)}`);
      const responseRef = isObject(response) ? response["$ref"] : undefined;
      if (typeof responseRef === "string") {
        pointer = refSegments(responseRef) ?? [];
        response = getPointer(document, responseRef);
      }
      if (!isObject(response)) {
        throw new Error(
          `${operation.specFile}: ${operation.method} ${operation.specPath} has no ${status} response`,
        );
      }
      const schemaPointer = isObject(response["schema"])
        ? [...pointer, "schema"]
        : [...pointer, "content", "application/json", "schema"];
      validate = this.#ajv.compile({ $ref: `${id}#/${pointerFragment(schemaPointer)}` });
      this.#responses.set(key, validate);
    }
    return validate(body)
      ? []
      : (validate.errors ?? []).map((error) => ({
          instancePath: error.instancePath,
          keyword: error.keyword,
          message: error.message ?? error.keyword,
          params: { ...error.params },
        }));
  }

  #validateBody(
    body: NonNullable<CompiledOperation["body"]>,
    request: RequestParts,
  ): { readonly body: unknown; readonly issues: readonly AmadeusIssue[] } {
    if (request.body.trim() === "") {
      return body.required
        ? {
            body: undefined,
            issues: [
              {
                status: 400,
                code: AMADEUS_ERROR_CODES.mandatoryDataMissing,
                title: "MANDATORY DATA MISSING",
                detail: "the request body is required",
              },
            ],
          }
        : { body: undefined, issues: [] };
    }
    const contentType = headerValue(request.headers, "content-type");
    if (contentType === undefined || !JSON_BODY.test(contentType)) {
      return {
        body: undefined,
        issues: [
          {
            status: 400,
            code: AMADEUS_ERROR_CODES.invalidFormat,
            title: "INVALID FORMAT",
            detail: "header Content-Type must be application/vnd.amadeus+json or application/json",
            source: { parameter: "Content-Type" },
          },
        ],
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      return {
        body: undefined,
        issues: [
          {
            status: 400,
            code: AMADEUS_ERROR_CODES.invalidFormat,
            title: "INVALID FORMAT",
            detail: "the request body is not valid JSON",
          },
        ],
      };
    }
    return body.validate(parsed)
      ? { body: parsed, issues: [] }
      : { body: parsed, issues: (body.validate.errors ?? []).map(bodyIssue) };
  }

  #spec(specFile: string): LoadedSpec {
    let spec = this.#specs.get(specFile);
    if (spec === undefined) {
      const raw = JSON.parse(readFileSync(join(this.specDir, specFile), "utf8")) as unknown;
      if (!isObject(raw) || !isObject(raw["paths"])) {
        throw new Error(`${specFile} is not a Swagger 2.0 or OpenAPI 3 document`);
      }
      const dangling = new Set<string>();
      const id = `https://amadeus.invalid/specs/${encodeURIComponent(specFile)}`;
      const document = { ...normalise(raw, dangling), $id: id };
      this.#ajv.addSchema(document);
      for (const ref of dangling) {
        this.#dangling.add(`${specFile}${ref}`);
      }
      spec = { id, document };
      this.#specs.set(specFile, spec);
    }
    return spec;
  }

  #operationPointer(operation: OperationSpec): string[] {
    return ["paths", operation.specPath, operation.method.toLowerCase()];
  }

  #compiled(operation: OperationSpec): CompiledOperation {
    const key = `${operation.specFile} ${operation.method} ${operation.specPath}`;
    let compiled = this.#operations.get(key);
    if (compiled === undefined) {
      compiled = this.#compile(operation);
      this.#operations.set(key, compiled);
    }
    return compiled;
  }

  #compile(operation: OperationSpec): CompiledOperation {
    const { id, document } = this.#spec(operation.specFile);
    const pathItem = getPointer(document, `#/${pointerFragment(["paths", operation.specPath])}`);
    const op = isObject(pathItem) ? pathItem[operation.method.toLowerCase()] : undefined;
    if (!isObject(pathItem) || !isObject(op)) {
      throw new Error(`${operation.specFile} has no operation ${operation.method} ${operation.specPath}`);
    }

    // Path-level parameters first, then the operation's, which override them by name and location.
    const located = new Map<string, { readonly parameter: JsonObject; readonly pointer: string[] }>();
    const collect = (list: unknown, base: string[]): void => {
      if (!Array.isArray(list)) {
        return;
      }
      list.forEach((entry: unknown, index) => {
        let parameter = entry;
        let pointer = [...base, String(index)];
        const ref = isObject(entry) ? entry["$ref"] : undefined;
        if (typeof ref === "string") {
          parameter = getPointer(document, ref);
          pointer = refSegments(ref) ?? [];
        }
        if (
          isObject(parameter) &&
          typeof parameter["name"] === "string" &&
          typeof parameter["in"] === "string"
        ) {
          located.set(`${parameter["in"]} ${parameter["name"]}`, { parameter, pointer });
        }
      });
    };
    collect(pathItem["parameters"], ["paths", operation.specPath, "parameters"]);
    collect(op["parameters"], [...this.#operationPointer(operation), "parameters"]);

    const parameters: ParameterInfo[] = [];
    let body: CompiledOperation["body"];
    for (const { parameter, pointer } of located.values()) {
      const location = parameter["in"];
      if (location === "body") {
        body = {
          required: parameter["required"] === true,
          validate: this.#ajv.compile({ $ref: `${id}#/${pointerFragment([...pointer, "schema"])}` }),
        };
        continue;
      }
      if (location !== "query" && location !== "header" && location !== "path") {
        continue;
      }
      // OpenAPI 3: the schema is in `schema`; Swagger 2.0: the parameter object holds the keywords itself.
      const schema: JsonObject = isObject(parameter["schema"])
        ? { $ref: `${id}#/${pointerFragment([...pointer, "schema"])}` }
        : Object.fromEntries(
            PARAMETER_SCHEMA_KEYS.filter((k) => k in parameter).map((k) => [k, parameter[k]]),
          );
      const openApi3 = isObject(parameter["schema"]);
      const typed = openApi3 ? (parameter["schema"] as JsonObject) : parameter;
      const items = typed["items"];
      parameters.push({
        name: parameter["name"] as string,
        in: location,
        required: location === "path" || parameter["required"] === true,
        type: typeof typed["type"] === "string" ? typed["type"] : undefined,
        itemsType: isObject(items) && typeof items["type"] === "string" ? items["type"] : undefined,
        // OpenAPI 3 query arrays are `form` style, exploded (repeated) unless `explode: false`.
        collectionFormat: openApi3
          ? parameter["explode"] === false
            ? "csv"
            : "multi"
          : typeof parameter["collectionFormat"] === "string"
            ? parameter["collectionFormat"]
            : "csv",
        schema,
      });
    }

    const objectOf = (location: ParamLocation, closed: boolean): JsonObject => {
      const own = parameters.filter((p) => p.in === location);
      return {
        type: "object",
        properties: Object.fromEntries(own.map((p) => [p.name, p.schema])),
        required: own.filter((p) => p.required).map((p) => p.name),
        ...(closed ? { additionalProperties: false } : {}),
      };
    };
    const validateParameters = this.#ajv.compile({
      type: "object",
      properties: {
        path: objectOf("path", false),
        query: objectOf("query", true),
        header: objectOf("header", false),
      },
    });
    return { parameters, validateParameters, body };
  }
}
