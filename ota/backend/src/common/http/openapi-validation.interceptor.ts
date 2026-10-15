// Request validation against the OTA document (ADR-0006 "Runtime validation", architecture §3 step 6, conventions §2
// and §6). At start-up the API parses ota/backend/openapi/velexis-ota-booking-api.openapi.yaml once and compiles, for
// every operation, one Ajv validator per parameter location (path, query, header, cookie) and one for the JSON body.
// The interceptor runs them for each request whose handler carries `@OpenApiOperation(...)` and answers
// `400 VALIDATION_FAILED` with `fieldErrors` holding JSON pointers and Ajv keywords, never the rejected values (a body
// may hold a password or a card number). Responses are not validated at run time; the tests do that
// (`expectResponseToMatch` of @velexis/testing).
//
// The schemas are OpenAPI 3.1, so JSON Schema 2020-12: Ajv 2020 with ajv-formats, in strict mode for unknown keywords
// (a misspelt keyword in the document fails the start-up instead of being ignored), with the OpenAPI annotations and
// the document's `x-*` extensions declared as annotation keywords. These are the options of @velexis/testing's
// response check, so a request and a response are judged by the same rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { AppError, type FieldError } from "@velexis/errors";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Request } from "express";
import type { Observable } from "rxjs";
import { parse } from "yaml";
import { APP_DIR } from "../../config";
import { OPENAPI_OPERATION, VALIDATED_INPUT, type ValidatedInput } from "./openapi-operation.decorator";
import { RequestContext, type OperationScope } from "./request-context";

/** The OTA document, in the package (`openapi/` is part of the release folder, ADR-0023). */
export const OTA_OPENAPI_DOCUMENT = join(APP_DIR, "openapi", "velexis-ota-booking-api.openapi.yaml");

/** At most this many field errors are returned; the request is refused either way. */
export const MAX_FIELD_ERRORS = 50;

export type ParameterLocation = "path" | "query" | "header" | "cookie";
const PARAMETER_LOCATIONS: readonly ParameterLocation[] = ["path", "query", "header", "cookie"];

type JsonObject = Record<string, unknown>;

/** One parameter of an operation, after `$ref`s and path-level parameters are resolved. */
export interface ParameterSpec {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required: boolean;
  readonly schema: unknown;
  /** Whether array values come as repeated keys (`?a=1&a=2`) rather than one comma-separated value. */
  readonly explode: boolean;
}

/** What the validators need to know about one operation of the document. */
export interface OperationSpec {
  readonly operationId: string;
  readonly method: string;
  /** The path template of the document, `/v1/bookings/{bookingId}`. */
  readonly path: string;
  readonly scope: OperationScope | null;
  readonly internal: boolean;
  readonly parameters: readonly ParameterSpec[];
  /** The `application/json` request body, when the operation has one. */
  readonly body: { readonly required: boolean; readonly schema: unknown } | undefined;
}

/** The raw parts of a request the validator reads. */
export interface RawRequest {
  /** Path parameters as the router decoded them. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Query parameters as Express parsed them: a string, or an array for a repeated key. */
  readonly query: Readonly<Record<string, unknown>>;
  /** Header values by lower-case name, as Node gives them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Cookies as cookie-parser gives them. */
  readonly cookies?: Readonly<Record<string, unknown>> | undefined;
  /** The parsed body: JSON, a Buffer on the raw webhook routes, or `undefined` when nothing was parsed. */
  readonly body: unknown;
  /** True when the request carries a body (`Content-Length` above 0 or `Transfer-Encoding`). */
  readonly bodySent: boolean;
}

/** The validated parts of a request: parameters by their documented names, coerced to their schema types. */
export interface ValidatedParts {
  readonly path: JsonObject;
  readonly query: JsonObject;
  readonly headers: JsonObject;
  readonly cookies: JsonObject;
  readonly body: unknown;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const SCHEMA_REF_PREFIX = "#/components/schemas/";
const ROOT_ID = "https://velexis.invalid/ota-backend/openapi/components.json";
/** OpenAPI's Schema Object fields that are not JSON Schema keywords: annotations for Ajv. */
const OPENAPI_ANNOTATIONS = ["discriminator", "example", "xml", "externalDocs"];
const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A JSON pointer segment (RFC 6901). */
export const escapePointer = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");
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
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteRefs);
  }
  if (!isObject(value)) {
    return value;
  }
  const copy: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      if (!child.startsWith(SCHEMA_REF_PREFIX)) {
        throw new Error(`OTA document: a schema $ref that is not into components.schemas: ${child}`);
      }
      copy[key] = `${ROOT_ID}#/$defs/${child.slice(SCHEMA_REF_PREFIX.length)}`;
    } else {
      copy[key] = rewriteRefs(child);
    }
  }
  return copy;
}

/** The fixed messages of the common keywords; built from the schema, never from the rejected value. */
function messageOf(error: ErrorObject, property: string | undefined): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
    case "dependentRequired":
      return `${property ?? "This field"} is required`;
    case "additionalProperties":
    case "unevaluatedProperties":
      return `${property ?? "This property"} is not allowed`;
    case "type":
      return `must be of type ${String(params["type"])}`;
    case "format":
      return `must be a valid ${String(params["format"])}`;
    case "pattern":
      return "does not have the expected format";
    case "enum": {
      const allowed = Array.isArray(params["allowedValues"]) ? params["allowedValues"] : [];
      const shown = allowed.slice(0, 10).map((value) => JSON.stringify(value));
      return `must be one of ${shown.join(", ")}${allowed.length > shown.length ? ", …" : ""}`;
    }
    case "const":
      return `must be ${JSON.stringify(params["allowedValue"])}`;
    case "oneOf":
      return "must match exactly one of the allowed shapes";
    case "anyOf":
      return "must match one of the allowed shapes";
    default:
      // Ajv builds its messages from the schema (limits, keywords), never from the data.
      return error.message ?? "is not valid";
  }
}

/** Ajv's errors as field errors: a JSON pointer into the request (`prefix` + the instance path) and the keyword. */
export function toFieldErrors(errors: readonly ErrorObject[], prefix = ""): FieldError[] {
  const seen = new Set<string>();
  const fieldErrors: FieldError[] = [];
  for (const error of errors) {
    const params = error.params as Record<string, unknown>;
    const child =
      error.keyword === "required" || error.keyword === "dependentRequired"
        ? params["missingProperty"]
        : error.keyword === "additionalProperties"
          ? params["additionalProperty"]
          : error.keyword === "unevaluatedProperties"
            ? params["unevaluatedProperty"]
            : undefined;
    const property = typeof child === "string" ? child : undefined;
    const path = `${prefix}${error.instancePath}${property === undefined ? "" : `/${escapePointer(property)}`}`;
    const key = `${path}\u0000${error.keyword}`;
    if (!seen.has(key)) {
      seen.add(key);
      fieldErrors.push({ path, code: error.keyword, message: messageOf(error, property) });
    }
  }
  return fieldErrors;
}

/** True when the request announces a body: a `Transfer-Encoding`, or a `Content-Length` above 0. */
export function requestHasBody(headers: RawRequest["headers"]): boolean {
  const length = headers["content-length"];
  return (
    headers["transfer-encoding"] !== undefined ||
    (typeof length === "string" && NUMERIC.test(length) && Number(length) > 0)
  );
}

/**
 * One parsed OpenAPI 3.1 document with its Ajv instance: the operations it lists and their request validators,
 * all compiled when it is built.
 */
export class OpenApiDocument {
  private readonly ajv: Ajv2020;
  private readonly operations = new Map<string, OperationSpec>();
  private readonly validators = new Map<string, RequestValidator>();

  constructor(
    readonly document: JsonObject,
    readonly label = "OTA document",
  ) {
    if (typeof document["openapi"] !== "string" || !document["openapi"].startsWith("3.1.")) {
      throw new Error(`${label} is not OpenAPI 3.1, whose schemas are JSON Schema draft 2020-12`);
    }
    this.ajv = new Ajv2020({
      strict: true,
      strictTypes: false,
      strictRequired: false,
      allErrors: true,
      logger: false,
    });
    addFormats(this.ajv);
    for (const keyword of [...OPENAPI_ANNOTATIONS, ...extensionKeys(document)]) {
      this.ajv.addKeyword({ keyword });
    }
    const components = isObject(document["components"]) ? document["components"] : {};
    this.ajv.addSchema({ $id: ROOT_ID, $defs: rewriteRefs(components["schemas"] ?? {}) });
    this.indexOperations();
    for (const operation of this.operations.values()) {
      this.validators.set(operation.operationId, new RequestValidator(operation, this));
    }
  }

  /** Every operation, in document order. */
  operationList(): readonly OperationSpec[] {
    return [...this.operations.values()];
  }

  /** The operation `operationId`; throws for an id the document does not have. */
  operation(operationId: string): OperationSpec {
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      throw new Error(`${this.label} has no operation "${operationId}"`);
    }
    return operation;
  }

  /** The compiled request validator of `operationId`. */
  validator(operationId: string): RequestValidator {
    const validator = this.validators.get(operationId);
    if (validator === undefined) {
      throw new Error(`${this.label} has no operation "${operationId}"`);
    }
    return validator;
  }

  /** Compiles any schema of the document (`$ref`s into `components.schemas` resolve). */
  compile(schema: unknown): ValidateFunction {
    return this.ajv.compile(rewriteRefs(schema) as JsonObject);
  }

  /** The value at a local reference `#/a/b`, following `$ref` chains of the document. */
  resolve(value: unknown): unknown {
    let current = value;
    for (let depth = 0; isObject(current) && typeof current["$ref"] === "string"; depth += 1) {
      const ref = current["$ref"];
      if (depth > 10 || !ref.startsWith("#/")) {
        throw new Error(`${this.label}: cannot resolve the $ref ${ref}`);
      }
      let target: unknown = this.document;
      for (const segment of ref.slice(2).split("/")) {
        const key = unescapePointer(decodeURIComponent(segment));
        if (!isObject(target) || !(key in target)) {
          throw new Error(`${this.label}: the $ref ${ref} resolves to nothing`);
        }
        target = target[key];
      }
      current = target;
    }
    return current;
  }

  private indexOperations(): void {
    const paths = isObject(this.document["paths"]) ? this.document["paths"] : {};
    for (const [path, item] of Object.entries(paths)) {
      if (!isObject(item)) {
        continue;
      }
      const shared = this.parameters(item["parameters"]);
      for (const method of HTTP_METHODS) {
        const operation = item[method];
        if (!isObject(operation) || typeof operation["operationId"] !== "string") {
          continue;
        }
        const operationId = operation["operationId"];
        const own = this.parameters(operation["parameters"]);
        // An operation's parameter overrides a path-level one with the same name and location.
        const merged = [
          ...shared.filter((p) => !own.some((o) => o.name === p.name && o.in === p.in)),
          ...own,
        ];
        const scope = operation["x-scope"];
        this.operations.set(operationId, {
          operationId,
          method,
          path,
          scope: scope === "customer" || scope === "console" || scope === "both" ? scope : null,
          internal: operation["x-internal"] === true,
          parameters: merged,
          body: this.requestBody(operationId, operation["requestBody"]),
        });
      }
    }
  }

  private parameters(list: unknown): ParameterSpec[] {
    if (!Array.isArray(list)) {
      return [];
    }
    return list.map((raw) => {
      const parameter = this.resolve(raw);
      if (!isObject(parameter) || typeof parameter["name"] !== "string") {
        throw new Error(`${this.label}: a parameter without a name`);
      }
      const location = parameter["in"];
      if (!PARAMETER_LOCATIONS.includes(location as ParameterLocation)) {
        throw new Error(`${this.label}: parameter ${parameter["name"]} has an unknown location`);
      }
      if (parameter["content"] !== undefined || parameter["schema"] === undefined) {
        throw new Error(
          `${this.label}: parameter ${parameter["name"]} has no schema (content parameters are not supported)`,
        );
      }
      // OpenAPI's defaults: style `form` for query and cookie parameters, `simple` for path and header ones;
      // `explode` is true for `form` only.
      const style =
        typeof parameter["style"] === "string"
          ? parameter["style"]
          : location === "query" || location === "cookie"
            ? "form"
            : "simple";
      const explode = typeof parameter["explode"] === "boolean" ? parameter["explode"] : style === "form";
      return {
        name: parameter["name"],
        in: location as ParameterLocation,
        required: parameter["required"] === true || location === "path",
        schema: parameter["schema"],
        explode,
      };
    });
  }

  private requestBody(operationId: string, raw: unknown): OperationSpec["body"] {
    if (raw === undefined) {
      return undefined;
    }
    const body = this.resolve(raw);
    const content = isObject(body) && isObject(body["content"]) ? body["content"] : {};
    const media = content["application/json"];
    if (!isObject(media) || media["schema"] === undefined) {
      throw new Error(`${this.label}: the request body of ${operationId} has no application/json schema`);
    }
    return { required: isObject(body) && body["required"] === true, schema: media["schema"] };
  }
}

/** The JSON Schema types a parameter schema allows, following `$ref`s; empty when it does not say. */
function schemaTypes(document: OpenApiDocument, schema: unknown): ReadonlySet<string> {
  const resolved = document.resolve(schema);
  const type = isObject(resolved) ? resolved["type"] : undefined;
  return new Set(typeof type === "string" ? [type] : Array.isArray(type) ? type.map(String) : []);
}

/** A string from the query or a header as the schema's type: numbers and booleans are coerced, nothing else. */
function coerceScalar(value: string, types: ReadonlySet<string>): unknown {
  if (types.has("string")) {
    return value;
  }
  if ((types.has("integer") || types.has("number")) && NUMERIC.test(value)) {
    return Number(value);
  }
  if (types.has("boolean") && (value === "true" || value === "false")) {
    return value === "true";
  }
  return value;
}

/** The compiled validators of one operation. */
export class RequestValidator {
  private readonly locations: ReadonlyArray<{
    readonly location: ParameterLocation;
    readonly parameters: ReadonlyArray<{
      readonly spec: ParameterSpec;
      readonly types: ReadonlySet<string>;
      readonly itemTypes: ReadonlySet<string>;
    }>;
    readonly validate: ValidateFunction;
  }>;
  private readonly body: { readonly required: boolean; readonly validate: ValidateFunction } | undefined;

  constructor(
    readonly operation: OperationSpec,
    document: OpenApiDocument,
  ) {
    this.locations = PARAMETER_LOCATIONS.map((location) => {
      const specs = operation.parameters.filter((parameter) => parameter.in === location);
      const schema = {
        type: "object",
        properties: Object.fromEntries(specs.map((spec) => [spec.name, spec.schema])),
        required: specs.filter((spec) => spec.required).map((spec) => spec.name),
      };
      return {
        location,
        parameters: specs.map((spec) => {
          const types = schemaTypes(document, spec.schema);
          const resolved = document.resolve(spec.schema);
          const items = isObject(resolved) ? resolved["items"] : undefined;
          return {
            spec,
            types,
            itemTypes: items === undefined ? new Set<string>() : schemaTypes(document, items),
          };
        }),
        validate: document.compile(schema),
      };
    });
    this.body =
      operation.body === undefined
        ? undefined
        : { required: operation.body.required, validate: document.compile(operation.body.schema) };
  }

  /**
   * Validates a request and returns its parameters coerced to their schema types. Throws `AppError`:
   * `INVALID_REQUEST` (`details.reason = "unsupported_media_type"`) for a body that is not JSON, and
   * `VALIDATION_FAILED` with every field error (paths `/path/<name>`, `/query/<name>`, `/header/<name>`,
   * `/cookie/<name>` for parameters, pointers into the body for the body), never with a value.
   */
  validate(request: RawRequest): ValidatedParts {
    if (this.body !== undefined && request.body === undefined && request.bodySent) {
      throw new AppError("INVALID_REQUEST", {
        message: "The request body must be JSON (Content-Type: application/json).",
        details: { reason: "unsupported_media_type" },
      });
    }
    const fieldErrors: FieldError[] = [];
    const parts: Record<ParameterLocation, JsonObject> = { path: {}, query: {}, header: {}, cookie: {} };
    for (const { location, parameters, validate } of this.locations) {
      const values = parts[location];
      for (const { spec, types, itemTypes } of parameters) {
        const raw = rawValue(request, location, spec.name);
        if (raw !== undefined) {
          values[spec.name] = coerce(raw, spec, types, itemTypes);
        }
      }
      if (!validate(values)) {
        fieldErrors.push(...toFieldErrors(validate.errors ?? [], `/${location}`));
      }
    }
    let body: unknown = request.body;
    if (this.body === undefined) {
      body = undefined;
    } else if (request.body === undefined) {
      if (this.body.required) {
        fieldErrors.push({ path: "", code: "required", message: "The request body is required" });
      }
    } else if (!Buffer.isBuffer(request.body) && !this.body.validate(request.body)) {
      // A Buffer is the raw body of a webhook route; its handler checks the signature and parses it itself.
      fieldErrors.push(...toFieldErrors(this.body.validate.errors ?? []));
    }
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors: fieldErrors.slice(0, MAX_FIELD_ERRORS) });
    }
    return { path: parts.path, query: parts.query, headers: parts.header, cookies: parts.cookie, body };
  }
}

function rawValue(request: RawRequest, location: ParameterLocation, name: string): unknown {
  switch (location) {
    case "path":
      return request.params[name];
    case "query":
      return Object.prototype.hasOwnProperty.call(request.query, name) ? request.query[name] : undefined;
    case "header":
      return request.headers[name.toLowerCase()];
    case "cookie":
      return request.cookies !== undefined && Object.prototype.hasOwnProperty.call(request.cookies, name)
        ? request.cookies[name]
        : undefined;
  }
}

function coerce(
  raw: unknown,
  spec: ParameterSpec,
  types: ReadonlySet<string>,
  itemTypes: ReadonlySet<string>,
): unknown {
  if (types.has("array")) {
    const occurrences = (Array.isArray(raw) ? raw : [raw]).filter((value) => typeof value === "string");
    const items = spec.explode ? occurrences : occurrences.flatMap((value) => value.split(","));
    return items.map((item) => coerceScalar(item, itemTypes));
  }
  // A repeated query key stays an array, which the schema's type refuses.
  return typeof raw === "string" ? coerceScalar(raw, types) : raw;
}

const documents = new Map<string, OpenApiDocument>();

/** The OTA document, parsed and compiled once per process (the tests start many applications). */
export function loadOpenApiDocument(file = OTA_OPENAPI_DOCUMENT): OpenApiDocument {
  let document = documents.get(file);
  if (document === undefined) {
    const parsed: unknown = parse(readFileSync(file, "utf8"));
    if (!isObject(parsed)) {
      throw new Error(`${file} is not an OpenAPI document`);
    }
    document = new OpenApiDocument(parsed);
    documents.set(file, document);
  }
  return document;
}

/** The request after the interceptor ran. */
type ValidatedRequest = Request & { [VALIDATED_INPUT]?: ValidatedInput };

/**
 * Validates every request bound with `@OpenApiOperation` before its handler runs (global, `APP_INTERCEPTOR`).
 * Handlers without it (health, the 501 answers of pending operations) pass through. On success the validated input
 * is on the request (`@OpenApiInput()`), and `req.params` and `req.query` hold the coerced values, so `@Param()` and
 * `@Query()` see numbers and booleans too.
 */
@Injectable()
export class OpenApiValidationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly document: OpenApiDocument,
    private readonly context: RequestContext,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operationId =
      context.getType() === "http"
        ? this.reflector.get<OtaOperationId | undefined>(OPENAPI_OPERATION, context.getHandler())
        : undefined;
    if (operationId === undefined) {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<ValidatedRequest>();
    const operation = this.document.operation(operationId);
    this.context.setOperation(operationId, operation.scope);
    const parts = this.document.validator(operationId).validate({
      params: req.params,
      query: req.query,
      headers: req.headers,
      cookies: isObject(req.cookies) ? req.cookies : undefined,
      body: req.body,
      bodySent: requestHasBody(req.headers),
    });
    req[VALIDATED_INPUT] = {
      operationId,
      path: parts.path,
      query: parts.query,
      headers: parts.headers,
      body: parts.body,
    } as ValidatedInput;
    // Express 5 computes `req.query` in a getter; an own property with the coerced values shadows it.
    Object.defineProperty(req, "query", {
      value: { ...req.query, ...parts.query },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    // Typed as strings by Express; an integer path parameter (`queueId`) is a number from here on.
    req.params = { ...req.params, ...parts.path } as typeof req.params;
    return next.handle();
  }
}
