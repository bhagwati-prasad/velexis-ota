// Request validation against the platform OpenAPI document (ADR-0006 "Runtime validation", platform/docs/
// architecture.md §3 step 9). The document is read once per process from `openapi/` next to `dist/` (the package
// ships it). At start-up the interceptor finds every handler bound with @OpenApiOperation, refuses to start when an
// `operationId` is not in the document, and compiles Ajv 2020 validators (with ajv-formats) for the operation's path,
// query and header parameters and its JSON body. Each request of a bound handler is then validated before the handler
// runs; any problem answers `400 VALIDATION_FAILED` with `fieldErrors`, whose messages never contain a submitted value
// (it may be a password or a card number). Responses are not validated at run time; the integration tests do that
// (`expectResponseToMatch` of @velexis/testing).
//
// `fieldErrors[].path` is a JSON pointer: into the body for body problems (`/email`, `""` for the body itself), as the
// document's examples show, and `/<in>/<name>` for a parameter (`/query/limit`, `/path/tenantId`,
// `/header/Idempotency-Key`), with the parameter's name as the document writes it.
//
// Every admin reason is trimmed here, before it is validated (FIX-W35-PLATFORM, lead decision (2j) of 2026-10-30): a
// string of a schema of `TRIMMED_SCHEMAS` (the document's `AdminReason`, which every admin operation's `reason` is, in
// a body or as `adminRevokeAdmin`'s query parameter) loses the white space at either end before `minLength` and
// `maxLength` count it, so a reason of only spaces answers `400 VALIDATION_FAILED` (`minLength`), and the handler, and
// with it the audit row and the stored reason, gets the trimmed value. The parameters are validated as copies anyway;
// a body that can hold such a string is validated, trimmed and handed on as a copy, so the request is never changed.
import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type OnModuleInit,
} from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { AppError, type FieldError } from "@velexis/errors";
import Ajv2020, { type ErrorObject, type FuncKeywordDefinition, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Observable } from "rxjs";
import { parse } from "yaml";
import { APP_DIR } from "../../config";
import { boundOperationId, VALIDATED_REQUEST, type ValidatedRequest } from "./openapi-operation.decorator";

/** The platform document, shipped in the package next to `dist/` (package.json `files`). */
export const PLATFORM_OPENAPI_FILE = join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml");

/** At most this many field errors are answered; a body with thousands of unknown properties gets the first ones. */
export const MAX_FIELD_ERRORS = 50;

/**
 * The component schemas whose strings are trimmed before they are validated (see the file header): `AdminReason`, the
 * schema of every admin reason (PADR-0006 item 5), whose 5–500 characters count after trimming.
 */
export const TRIMMED_SCHEMAS: readonly string[] = Object.freeze(["AdminReason"]);

/** The Ajv keyword the validator adds to each schema of TRIMMED_SCHEMAS (a name the document cannot use). */
const TRIM_KEYWORD = "velexisTrim";

/**
 * Trims the string it validates in place, in the object or list that holds it, and is always valid. It is an untyped
 * keyword, so Ajv runs it before the string keywords (`minLength`, `maxLength`, `pattern`), and `modifying`, so those
 * read the trimmed value. A string that is the whole validated value has no holder and is left as it is.
 */
const TRIM_KEYWORD_DEFINITION: FuncKeywordDefinition = {
  keyword: TRIM_KEYWORD,
  schemaType: "boolean",
  modifying: true,
  errors: false,
  validate: (
    trim: unknown,
    data: unknown,
    _parentSchema?: unknown,
    context?: { readonly parentData?: unknown; readonly parentDataProperty?: string | number },
  ): boolean => {
    const holder = context?.parentData;
    const key = context?.parentDataProperty;
    if (
      trim === true &&
      typeof data === "string" &&
      holder !== null &&
      typeof holder === "object" &&
      key !== undefined
    ) {
      Reflect.set(holder, key, data.trim());
    }
    return true;
  },
};

type JsonObject = Record<string, unknown>;

/** Where a parameter is, as OpenAPI writes it. */
export type ParameterLocation = "path" | "query" | "header" | "cookie";
const LOCATIONS: readonly ParameterLocation[] = ["path", "query", "header", "cookie"];

/** A parameter of an operation, `$ref`s resolved. */
export interface OpenApiParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required: boolean;
  readonly schema: unknown;
}

/** One operation of the document, with the path item's parameters merged into its own. */
export interface OpenApiOperationDefinition {
  readonly operationId: string;
  /** Lower case, as in the document. */
  readonly method: string;
  /** The path template of the document (`/v1/tenants/{tenantId}`). */
  readonly path: string;
  readonly parameters: readonly OpenApiParameter[];
  /** The JSON request body; `undefined` when the operation takes none. */
  readonly requestBody: { readonly required: boolean; readonly schema: unknown } | undefined;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const SCHEMA_REF_PREFIX = "#/components/schemas/";
const ROOT_ID = "https://velexis.invalid/openapi/platform-components.json";
/** OpenAPI's Schema Object fields that are not JSON Schema keywords: annotations for Ajv. */
const OPENAPI_ANNOTATIONS = ["discriminator", "example", "xml", "externalDocs"];

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

/** A deep copy of a schema whose `#/components/schemas/X` references point into the Ajv root schema. */
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
        throw new Error(
          `The platform document has a schema $ref that is not into components.schemas: ${child}`,
        );
      }
      copy[key] = `${ROOT_ID}#/$defs/${child.slice(SCHEMA_REF_PREFIX.length)}`;
    } else {
      copy[key] = rewriteRefs(child);
    }
  }
  return copy;
}

/**
 * The platform OpenAPI document, indexed by `operationId`. `load()` reads and parses the file once per process (the
 * API and every test application of a test file share it).
 */
export class PlatformOpenApi {
  private static readonly loaded = new Map<string, PlatformOpenApi>();

  private readonly byId = new Map<string, OpenApiOperationDefinition>();
  private readonly errorMessages = new Map<string, string>();

  private constructor(readonly document: JsonObject) {
    if (typeof document["openapi"] !== "string" || !document["openapi"].startsWith("3.1.")) {
      throw new Error(
        "The platform document is not OpenAPI 3.1, whose schemas are JSON Schema draft 2020-12",
      );
    }
    const paths = isObject(document["paths"]) ? document["paths"] : {};
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
        const own = this.parameters(operation["parameters"]);
        const parameters = [
          ...shared.filter((p) => !own.some((o) => o.in === p.in && o.name === p.name)),
          ...own,
        ];
        this.byId.set(operation["operationId"], {
          operationId: operation["operationId"],
          method,
          path,
          parameters,
          requestBody: this.requestBody(operation["operationId"], operation["requestBody"]),
        });
      }
    }
    const catalogue = isObject(document["x-error-catalogue"]) ? document["x-error-catalogue"] : {};
    for (const [code, entry] of Object.entries(catalogue)) {
      if (isObject(entry) && typeof entry["description"] === "string") {
        this.errorMessages.set(code, entry["description"]);
      }
    }
  }

  /** The document of `file` (default: the shipped platform document), parsed once per process. */
  static load(file: string = PLATFORM_OPENAPI_FILE): PlatformOpenApi {
    let api = PlatformOpenApi.loaded.get(file);
    if (api === undefined) {
      api = PlatformOpenApi.fromDocument(parse(readFileSync(file, "utf8")));
      PlatformOpenApi.loaded.set(file, api);
    }
    return api;
  }

  /** An already parsed document (tests use small ones). */
  static fromDocument(document: unknown): PlatformOpenApi {
    if (!isObject(document)) {
      throw new Error("The platform document is not an object");
    }
    return new PlatformOpenApi(document);
  }

  /** The operation `operationId`, or `undefined`. */
  operation(operationId: string): OpenApiOperationDefinition | undefined {
    return this.byId.get(operationId);
  }

  /** Every operation, in document order. */
  operations(): readonly OpenApiOperationDefinition[] {
    return [...this.byId.values()];
  }

  /** The platform catalogue's message of an error code (`x-error-catalogue`), or `undefined`. */
  errorMessage(code: string): string | undefined {
    return this.errorMessages.get(code);
  }

  /** The value at a local reference `#/a/b` of the document, following `$ref` chains. */
  private resolve(value: unknown): unknown {
    let current = value;
    for (let depth = 0; isObject(current) && typeof current["$ref"] === "string"; depth += 1) {
      const ref = current["$ref"];
      if (depth > 10 || !ref.startsWith("#/")) {
        throw new Error(`The platform document has a $ref that cannot be followed: ${ref}`);
      }
      current = ref
        .slice(2)
        .split("/")
        .reduce<unknown>((node, segment) => {
          const key = unescapePointer(decodeURIComponent(segment));
          if (!isObject(node) || !(key in node)) {
            throw new Error(`The platform document has a $ref that resolves to nothing: ${ref}`);
          }
          return node[key];
        }, this.document);
    }
    return current;
  }

  private parameters(value: unknown): OpenApiParameter[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => {
      const parameter = this.resolve(item);
      if (
        !isObject(parameter) ||
        typeof parameter["name"] !== "string" ||
        !LOCATIONS.includes(parameter["in"] as ParameterLocation) ||
        parameter["schema"] === undefined
      ) {
        throw new Error("The platform document has a parameter without a name, a location or a schema");
      }
      return {
        name: parameter["name"],
        in: parameter["in"] as ParameterLocation,
        required: parameter["in"] === "path" || parameter["required"] === true,
        schema: parameter["schema"],
      };
    });
  }

  private requestBody(operationId: string, value: unknown): OpenApiOperationDefinition["requestBody"] {
    if (value === undefined) {
      return undefined;
    }
    const body = this.resolve(value);
    const content = isObject(body) && isObject(body["content"]) ? body["content"] : {};
    const media = content["application/json"];
    if (!isObject(body) || !isObject(media) || Object.keys(content).length !== 1) {
      throw new Error(`${operationId}: the API reads JSON request bodies only (application/json)`);
    }
    return { required: body["required"] === true, schema: media["schema"] ?? {} };
  }
}

/** What is validated of a request. */
export interface RequestInput {
  /** Express's route parameters (strings). */
  readonly path: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly headers: IncomingHttpHeaders;
  readonly cookies?: Readonly<Record<string, unknown>> | undefined;
  /** The parsed JSON body; `undefined` when there was none or it was not JSON. */
  readonly body: unknown;
  /** True when the request carried body bytes that the JSON parser did not read (another media type). */
  readonly unreadBody: boolean;
}

interface CompiledLocation {
  readonly validate: ValidateFunction;
  /** The documented name of each property of the validated object (header names are lower case there). */
  readonly names: ReadonlyMap<string, string>;
}

interface CompiledOperation {
  readonly locations: ReadonlyMap<ParameterLocation, CompiledLocation>;
  readonly body:
    | {
        readonly required: boolean;
        readonly validate: ValidateFunction;
        /** True when the body schema reaches a schema of TRIMMED_SCHEMAS: the body is validated as a copy. */
        readonly trims: boolean;
      }
    | undefined;
}

/** A message without the value: the keyword and the schema's own parameters only. */
function messageFor(error: ErrorObject, parameter: boolean): string {
  const params = error.params as Record<string, unknown>;
  const limit = String(params["limit"]);
  switch (error.keyword) {
    case "required":
    case "dependentRequired":
      return parameter ? "This parameter is required." : "This field is required.";
    case "additionalProperties":
    case "unevaluatedProperties":
      return "This field is not allowed.";
    case "type": {
      const type = Array.isArray(params["type"]) ? params["type"].join(" or ") : String(params["type"]);
      return `Must be of type ${type}.`;
    }
    case "format":
      return `Must be a valid ${String(params["format"])}.`;
    case "pattern":
      return "Has an invalid format.";
    case "minLength":
      return `Must be at least ${limit} characters long.`;
    case "maxLength":
      return `Must be at most ${limit} characters long.`;
    case "minimum":
      return `Must be at least ${limit}.`;
    case "maximum":
      return `Must be at most ${limit}.`;
    case "exclusiveMinimum":
      return `Must be greater than ${limit}.`;
    case "exclusiveMaximum":
      return `Must be less than ${limit}.`;
    case "multipleOf":
      return `Must be a multiple of ${String(params["multipleOf"])}.`;
    case "minItems":
      return `Must have at least ${limit} items.`;
    case "maxItems":
      return `Must have at most ${limit} items.`;
    case "uniqueItems":
      return "Must not contain duplicate items.";
    case "minProperties":
      return `Must have at least ${limit} fields.`;
    case "maxProperties":
      return `Must have at most ${limit} fields.`;
    case "enum": {
      const allowed = Array.isArray(params["allowedValues"]) ? params["allowedValues"] : [];
      const shown = allowed.slice(0, 10).map((value) => JSON.stringify(value));
      return `Must be one of ${shown.join(", ")}${allowed.length > shown.length ? ", …" : ""}.`;
    }
    case "const":
      return `Must be ${JSON.stringify(params["allowedValue"])}.`;
    case "oneOf":
      return "Must match exactly one of the allowed forms.";
    case "anyOf":
      return "Must match one of the allowed forms.";
    case "not":
      return "Is not allowed.";
    default:
      // Ajv's messages name the rule, never the value.
      return error.message === undefined
        ? "Is not valid."
        : `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`;
  }
}

/** The JSON pointer of the instance an Ajv error is about, within the validated value. */
function instancePointer(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const child = (name: unknown): string => `${error.instancePath}/${escapePointer(String(name))}`;
  switch (error.keyword) {
    case "required":
    case "dependentRequired":
      return child(params["missingProperty"]);
    case "additionalProperties":
      return child(params["additionalProperty"]);
    case "unevaluatedProperties":
      return child(params["unevaluatedProperty"]);
    default:
      return error.instancePath;
  }
}

/** The field errors of Ajv's errors; for a parameter location, the pointer starts with `/<in>/<documented name>`. */
function fieldErrorsOf(
  errors: readonly ErrorObject[] | null | undefined,
  location: { readonly in: ParameterLocation; readonly names: ReadonlyMap<string, string> } | undefined,
): FieldError[] {
  return (errors ?? []).map((error) => {
    let path = instancePointer(error);
    if (location !== undefined) {
      const [, first = "", ...rest] = path.split("/");
      const name = location.names.get(unescapePointer(first)) ?? unescapePointer(first);
      path = [`/${location.in}/${escapePointer(name)}`, ...rest].join("/");
    }
    return { path, code: error.keyword, message: messageFor(error, location !== undefined) };
  });
}

/** The first MAX_FIELD_ERRORS errors, each path and code once. */
function distinct(errors: readonly FieldError[]): FieldError[] {
  const seen = new Set<string>();
  return errors
    .filter((error) => {
      const key = `${error.path}\u0000${error.code}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, MAX_FIELD_ERRORS);
}

const isEmptyObject = (value: unknown): boolean => isObject(value) && Object.keys(value).length === 0;

/**
 * Validates requests against the operations of a PlatformOpenApi. Parameters are validated with type coercion
 * (`"50"` becomes `50`, one query value becomes an array where the schema wants one) and with their defaults applied;
 * the body is validated as sent. Validators are compiled once per operation.
 */
export class OpenApiRequestValidator {
  private readonly bodyAjv: Ajv2020;
  private readonly parameterAjv: Ajv2020;
  private readonly compiled = new Map<string, CompiledOperation>();
  /** The component schemas, their `$ref`s rewritten into the Ajv root schema. */
  private readonly defs: JsonObject;
  /** The rewritten `$ref`s of the schemas of TRIMMED_SCHEMAS that the document has. */
  private readonly trimmedRefs: ReadonlySet<string>;

  constructor(private readonly api: PlatformOpenApi) {
    const keywords = [...OPENAPI_ANNOTATIONS, ...extensionKeys(api.document)];
    const components = isObject(api.document["components"]) ? api.document["components"] : {};
    const rewritten = rewriteRefs(components["schemas"] ?? {});
    const defs: JsonObject = isObject(rewritten) ? { ...rewritten } : {};
    const trimmed = TRIMMED_SCHEMAS.filter((name) => isObject(defs[name]));
    for (const name of trimmed) {
      defs[name] = { ...(defs[name] as JsonObject), [TRIM_KEYWORD]: true };
    }
    this.defs = defs;
    this.trimmedRefs = new Set(trimmed.map((name) => `${ROOT_ID}#/$defs/${name}`));
    const create = (options: { coerceTypes: false | "array"; useDefaults: boolean }): Ajv2020 => {
      // Strict for unknown keywords, so a misspelt keyword in the document fails here instead of being ignored;
      // strictTypes and strictRequired judge how a schema is written, not what it accepts (as @velexis/testing).
      const ajv = new Ajv2020({
        strict: true,
        strictTypes: false,
        strictRequired: false,
        allErrors: true,
        logger: false,
        ...options,
      });
      addFormats(ajv);
      for (const keyword of keywords) {
        ajv.addKeyword({ keyword });
      }
      ajv.addKeyword(TRIM_KEYWORD_DEFINITION);
      ajv.addSchema({ $id: ROOT_ID, $defs: defs });
      return ajv;
    };
    this.bodyAjv = create({ coerceTypes: false, useDefaults: false });
    this.parameterAjv = create({ coerceTypes: "array", useDefaults: true });
  }

  /** Compiles the validators of `operationId`; throws when the document has no such operation. */
  compile(operationId: string): void {
    if (this.compiled.has(operationId)) {
      return;
    }
    const operation = this.api.operation(operationId);
    if (operation === undefined) {
      throw new Error(`The platform document has no operation "${operationId}"`);
    }
    const locations = new Map<ParameterLocation, CompiledLocation>();
    for (const location of LOCATIONS) {
      const parameters = operation.parameters.filter((parameter) => parameter.in === location);
      if (parameters.length === 0) {
        continue;
      }
      const key = (name: string): string => (location === "header" ? name.toLowerCase() : name);
      locations.set(location, {
        validate: this.parameterAjv.compile({
          type: "object",
          properties: Object.fromEntries(parameters.map((p) => [key(p.name), rewriteRefs(p.schema)])),
          required: parameters.filter((p) => p.required).map((p) => key(p.name)),
        }),
        names: new Map(parameters.map((p) => [key(p.name), p.name])),
      });
    }
    let body: CompiledOperation["body"];
    if (operation.requestBody !== undefined) {
      const schema = rewriteRefs(operation.requestBody.schema) as JsonObject;
      body = {
        required: operation.requestBody.required,
        validate: this.bodyAjv.compile(schema),
        trims: this.reachesTrimmed(schema, new Set()),
      };
    }
    this.compiled.set(operationId, { locations, body });
  }

  /** Whether `value` (a rewritten schema) refers to a schema of TRIMMED_SCHEMAS, directly or through other schemas. */
  private reachesTrimmed(value: unknown, seen: Set<string>): boolean {
    if (Array.isArray(value)) {
      return value.some((item) => this.reachesTrimmed(item, seen));
    }
    if (!isObject(value)) {
      return false;
    }
    return Object.entries(value).some(([key, child]) => {
      if (key !== "$ref" || typeof child !== "string") {
        return this.reachesTrimmed(child, seen);
      }
      if (this.trimmedRefs.has(child)) {
        return true;
      }
      if (seen.has(child) || !child.startsWith(`${ROOT_ID}#/$defs/`)) {
        return false;
      }
      seen.add(child);
      return this.reachesTrimmed(this.defs[child.slice(`${ROOT_ID}#/$defs/`.length)], seen);
    });
  }

  /**
   * The validated request and its field errors (empty when valid). The parameters are copies with the documented
   * types, and the body is a copy when one of its strings may be trimmed (TRIMMED_SCHEMAS); the input is never changed.
   */
  validate(
    operationId: string,
    input: RequestInput,
  ): { readonly validated: ValidatedRequest; readonly fieldErrors: readonly FieldError[] } {
    this.compile(operationId);
    const operation = this.compiled.get(operationId) as CompiledOperation;
    const errors: FieldError[] = [];
    const sources: Record<ParameterLocation, Readonly<Record<string, unknown>>> = {
      path: input.path,
      query: input.query,
      header: input.headers,
      cookie: input.cookies ?? {},
    };
    const validated: Record<ParameterLocation, Record<string, unknown>> = {
      path: {},
      query: {},
      header: {},
      cookie: {},
    };
    for (const [location, compiled] of operation.locations) {
      // Only the documented parameters, copied: coercion and defaults change the copy, never the request.
      const values: Record<string, unknown> = {};
      for (const name of compiled.names.keys()) {
        if (Object.hasOwn(sources[location], name)) {
          values[name] = sources[location][name];
        }
      }
      if (compiled.validate(values)) {
        validated[location] = values;
      } else {
        errors.push(...fieldErrorsOf(compiled.validate.errors, { in: location, names: compiled.names }));
      }
    }
    // A copy of a body whose admin reasons the trim keyword changes (JSON values only, so structuredClone copies all).
    const body =
      operation.body?.trims === true && input.body !== undefined ? structuredClone(input.body) : input.body;
    errors.push(...this.bodyErrors(operation, input, body));
    return {
      validated: { path: validated.path, query: validated.query, header: validated.header, body },
      fieldErrors: distinct(errors),
    };
  }

  private bodyErrors(operation: CompiledOperation, input: RequestInput, body: unknown): FieldError[] {
    if (input.unreadBody) {
      return [{ path: "", code: "mediaType", message: "The request body must be JSON (application/json)." }];
    }
    if (operation.body === undefined) {
      // A JSON content type with an empty body parses as `{}`: that is no body either.
      return body === undefined || isEmptyObject(body)
        ? []
        : [{ path: "", code: "body", message: "This operation takes no request body." }];
    }
    if (body === undefined) {
      return operation.body.required
        ? [{ path: "", code: "required", message: "A JSON request body is required." }]
        : [];
    }
    return operation.body.validate(body) ? [] : fieldErrorsOf(operation.body.validate.errors, undefined);
  }
}

/** The parts of an Express request the interceptor reads. */
interface HttpRequest {
  readonly params?: Record<string, unknown>;
  readonly query?: unknown;
  readonly headers: IncomingHttpHeaders;
  readonly cookies?: unknown;
  readonly body?: unknown;
}

/** True when the request announced body bytes (`Transfer-Encoding`, or a `Content-Length` other than 0). */
function announcesBody(headers: IncomingHttpHeaders): boolean {
  const length = headers["content-length"];
  return headers["transfer-encoding"] !== undefined || (length !== undefined && length.trim() !== "0");
}

/** The RequestInput of an Express request. */
export function requestInputOf(req: HttpRequest): RequestInput {
  return {
    path: req.params ?? {},
    query: isObject(req.query) ? req.query : {},
    headers: req.headers,
    cookies: isObject(req.cookies) ? req.cookies : undefined,
    body: req.body,
    unreadBody: req.body === undefined && announcesBody(req.headers),
  };
}

/**
 * The global validation interceptor (CommonModule). Handlers without @OpenApiOperation are not validated; the route
 * parity test makes sure every route of the API has one.
 */
@Injectable()
export class OpenApiValidationInterceptor implements NestInterceptor, OnModuleInit {
  private readonly validator: OpenApiRequestValidator;

  constructor(
    api: PlatformOpenApi,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {
    this.validator = new OpenApiRequestValidator(api);
  }

  /** Compiles the validators of every bound handler; an `operationId` the document lacks stops the start. */
  onModuleInit(): void {
    for (const wrapper of this.discovery.getControllers()) {
      const prototype: unknown = wrapper.metatype?.prototype;
      if (!isObject(prototype)) {
        continue;
      }
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const operationId = boundOperationId(prototype[name]);
        if (operationId === undefined) {
          continue;
        }
        try {
          this.validator.compile(operationId);
        } catch (error) {
          throw new Error(
            `@OpenApiOperation("${operationId}") on ${wrapper.name}.${name}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operationId = context.getType() === "http" ? boundOperationId(context.getHandler()) : undefined;
    if (operationId === undefined) {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const { validated, fieldErrors } = this.validator.validate(operationId, requestInputOf(req));
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors });
    }
    Reflect.set(req, VALIDATED_REQUEST, validated);
    return next.handle();
  }
}
