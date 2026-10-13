import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AppError,
  ERROR_CATALOGUE,
  FIELD_ERROR_CODES,
  toErrorEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
  type FieldError,
  type SupplierIssue,
} from "./index.js";

// Tests of task X-009: toErrorEnvelope. Envelopes are validated with Ajv against the `ErrorResponse` and `Error`
// schemas of the OTA document itself (parsed here with `yaml`), the way the backends' response checks validate
// them (ADR-0006: Ajv 2020 and ajv-formats).

const REPO_ROOT = join(__dirname, "..", "..", "..");
const OTA_DOCUMENT = join(REPO_ROOT, "ota/backend/openapi/velexis-ota-booking-api.openapi.yaml");
const PLATFORM_DOCUMENT = join(REPO_ROOT, "platform/backend/openapi/velexis-platform-api.openapi.yaml");
const SCHEMA_ID = "https://velexis.invalid/ota-error-envelope.json";
const SCHEMA_REF_PREFIX = "#/components/schemas/";
const REQUEST_ID = "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X";

// Parsing the 40,000-line OTA document takes a moment on a busy runner.
const PARSE_TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;
interface OpenApiDocument {
  components: { schemas: Record<string, JsonObject> };
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Every `$ref` into components.schemas of a schema, at any depth. */
function schemaRefs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(schemaRefs);
  }
  if (!isObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    key === "$ref" && typeof child === "string" && child.startsWith(SCHEMA_REF_PREFIX)
      ? [child.slice(SCHEMA_REF_PREFIX.length)]
      : schemaRefs(child),
  );
}

/**
 * A JSON Schema (draft 2020-12, as OpenAPI 3.1) of the document's `ErrorResponse` with every schema it references,
 * verbatim, under `$defs`: only the `$ref` prefix changes from `#/components/schemas/` to `#/$defs/`.
 */
function envelopeSchema(document: OpenApiDocument): JsonObject {
  const defs: Record<string, unknown> = {};
  const pending = ["ErrorResponse"];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (name in defs) {
      continue;
    }
    const schema = document.components.schemas[name];
    if (schema === undefined) {
      throw new Error(`the OTA document has no schema ${name}`);
    }
    defs[name] = schema;
    pending.push(...schemaRefs(schema));
  }
  const rewritten = JSON.parse(
    JSON.stringify(defs).replaceAll(`"${SCHEMA_REF_PREFIX}`, '"#/$defs/'),
  ) as Record<string, unknown>;
  return { $id: SCHEMA_ID, $ref: "#/$defs/ErrorResponse", $defs: rewritten };
}

/** The codes a document's examples answer with `fieldErrors` (every `{ error: { code, fieldErrors } }`). */
function codesWithFieldErrors(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => codesWithFieldErrors(item, found));
  } else if (isObject(value)) {
    const { error } = value;
    if (isObject(error) && typeof error["code"] === "string" && error["fieldErrors"] !== undefined) {
      found.add(error["code"]);
    }
    Object.values(value).forEach((child) => codesWithFieldErrors(child, found));
  }
  return found;
}

const fieldErrors: FieldError[] = [
  {
    path: "/travelers/0/documents/0/expiryDate",
    code: "DOCUMENT_EXPIRES_BEFORE_RETURN",
    message: "Renew it.",
  },
  { path: "/contacts/0/emailAddress", code: "EMAIL_INVALID" },
];
const supplier: SupplierIssue = {
  provider: "amadeus",
  status: 400,
  code: 32171,
  title: "MANDATORY DATA MISSING",
  detail: "Missing traveler contact",
  source: { pointer: "/data/travelers[0]/contact" },
};

describe("toErrorEnvelope", () => {
  let document: OpenApiDocument;
  let validateResponse: ValidateFunction;
  let errorProperties: string[];
  beforeAll(() => {
    document = parse(readFileSync(OTA_DOCUMENT, "utf8")) as OpenApiDocument;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    validateResponse = ajv.compile(envelopeSchema(document));
    errorProperties = Object.keys(document.components.schemas["Error"]?.["properties"] as JsonObject);
  }, PARSE_TIMEOUT_MS);

  /** Fails with Ajv's errors when the body does not match the `ErrorResponse` schema. */
  function expectValid(envelope: ErrorEnvelope): void {
    const valid = validateResponse(envelope.body);
    expect(validateResponse.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    // Nothing beyond the fields of the `Error` schema, and the status of the answer is the body's status.
    expect(Object.keys(envelope.body)).toEqual(["error"]);
    expect(Object.keys(envelope.body.error).filter((key) => !errorProperties.includes(key))).toEqual([]);
    expect(envelope.body.error.status).toBe(envelope.status);
  }

  it("builds envelopes from AppErrors that validate against the OTA document's Error schema [X-009 AC2]", () => {
    expect(errorProperties).toEqual([
      "code",
      "message",
      "status",
      "requestId",
      "details",
      "fieldErrors",
      "supplier",
    ]);
    // The validator is not vacuous: the schema's rules are in force.
    const body = { code: "NOT_FOUND", message: "Not found.", status: 404, requestId: REQUEST_ID };
    expect(validateResponse({ error: body })).toBe(true);
    expect(validateResponse({ error: { ...body, code: "not_found" } })).toBe(false);
    expect(validateResponse({ error: { ...body, requestId: undefined } })).toBe(false);
    expect(validateResponse({ error: { ...body, fieldErrors: [{ code: "format" }] } })).toBe(false);
    expect(validateResponse({ error: { ...body, supplier: { provider: "sabre" } } })).toBe(false);
    expect(validateResponse(body)).toBe(false);

    // Every field the schema has: details, fieldErrors of a field-error code, supplier in console scope.
    const full = toErrorEnvelope(
      new AppError("TRAVELER_DATA_INVALID", {
        message: "Please check the traveller details.",
        details: { offerId: "off_1", reasons: ["documents"] },
        fieldErrors,
        supplier,
      }),
      REQUEST_ID,
      { exposeSupplier: true },
    );
    expectValid(full);
    expect(full).toEqual({
      status: 422,
      body: {
        error: {
          code: "TRAVELER_DATA_INVALID",
          message: "Please check the traveller details.",
          status: 422,
          requestId: REQUEST_ID,
          details: { offerId: "off_1", reasons: ["documents"] },
          fieldErrors,
          supplier,
        },
      },
    });

    // Every code of the catalogue, with its default message and status.
    for (const code of Object.keys(ERROR_CATALOGUE) as ErrorCode[]) {
      const envelope = toErrorEnvelope(new AppError(code), REQUEST_ID, { exposeSupplier: false });
      expectValid(envelope);
      expect(envelope.body.error).toEqual({
        code,
        message: ERROR_CATALOGUE[code].description,
        status: ERROR_CATALOGUE[code].status,
        requestId: REQUEST_ID,
      });
    }
  });

  it("turns a thrown TypeError into 500 INTERNAL_ERROR with the requestId and no stack [X-009 AC3]", () => {
    let thrown: unknown;
    try {
      (JSON.parse("null") as { booking: { id: string } }).booking.id.trim();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    const stack = (thrown as TypeError).stack ?? "";
    expect(stack).toContain("TypeError");

    const envelope = toErrorEnvelope(thrown, REQUEST_ID, { exposeSupplier: true });
    expectValid(envelope);
    expect(envelope).toEqual({
      status: 500,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: ERROR_CATALOGUE.INTERNAL_ERROR.description,
          status: 500,
          requestId: REQUEST_ID,
        },
      },
    });
    const json = JSON.stringify(envelope.body);
    expect(json).not.toContain("TypeError");
    expect(json).not.toContain((thrown as TypeError).message);
    expect(json).not.toContain("stack");
    expect(json).not.toContain(".ts:");
  });

  it("gives 500 INTERNAL_ERROR with nothing of the value for anything that is not an AppError", () => {
    const lookalike = Object.assign(new Error("password=hunter2"), { code: "NOT_FOUND", status: 404 });
    const values: unknown[] = [
      "a string",
      null,
      undefined,
      42,
      { code: "NOT_FOUND", status: 404, message: "token=abc", stack: "at secret.ts:1:1" },
      lookalike,
      new RangeError("card 4111111111111111"),
      Object.assign(Object.create(AppError.prototype) as object, { code: "NOT_A_CODE", status: 418 }),
    ];
    for (const value of values) {
      const envelope = toErrorEnvelope(value, "req_other", { exposeSupplier: true });
      expectValid(envelope);
      expect(envelope.status).toBe(500);
      expect(envelope.body.error).toEqual({
        code: "INTERNAL_ERROR",
        message: ERROR_CATALOGUE.INTERNAL_ERROR.description,
        status: 500,
        requestId: "req_other",
      });
    }
  });

  it("never returns the stack or the cause of an AppError", () => {
    const cause = new Error("db password=hunter2 at 10.0.0.1");
    const err = new AppError("SUPPLIER_UNAVAILABLE", { cause, details: { retryAfterSeconds: 30 } });
    const envelope = toErrorEnvelope(err, REQUEST_ID, { exposeSupplier: true });
    expectValid(envelope);
    expect(Object.keys(envelope.body.error)).toEqual(["code", "message", "status", "requestId", "details"]);
    const json = JSON.stringify(envelope.body);
    for (const leak of ["hunter2", "cause", "stack", "AppError", "app-error"]) {
      expect(json).not.toContain(leak);
    }
  });

  it("returns fieldErrors only for the codes of FIELD_ERROR_CODES, with only path, code and message", () => {
    const validation = toErrorEnvelope(
      new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          // A careless item: the extra `value` must not reach the client (conventions §6).
          {
            path: "/card/number",
            code: "format",
            message: "Invalid card number.",
            value: "4111111111111111",
          },
          { path: "/password", code: "too_short" },
        ] as FieldError[],
      }),
      REQUEST_ID,
      { exposeSupplier: false },
    );
    expectValid(validation);
    expect(validation.status).toBe(400);
    expect(validation.body.error.fieldErrors).toEqual([
      { path: "/card/number", code: "format", message: "Invalid card number." },
      { path: "/password", code: "too_short" },
    ]);
    expect(JSON.stringify(validation.body)).not.toContain("4111111111111111");

    for (const code of FIELD_ERROR_CODES) {
      const envelope = toErrorEnvelope(new AppError(code, { fieldErrors }), REQUEST_ID, {
        exposeSupplier: false,
      });
      expectValid(envelope);
      expect(envelope.body.error.fieldErrors).toEqual(fieldErrors);
    }

    // A code without field errors drops them, even when a cast got them past the compiler.
    for (const code of ["NOT_FOUND", "CONFLICT", "INTERNAL_ERROR", "SUPPLIER_REJECTED"] as const) {
      const envelope = toErrorEnvelope(new AppError<ErrorCode>(code, { fieldErrors }), REQUEST_ID, {
        exposeSupplier: true,
      });
      expectValid(envelope);
      expect(envelope.body.error).not.toHaveProperty("fieldErrors");
    }
  });

  it("returns supplier only when exposeSupplier is true (console scope), with only the schema's fields", () => {
    const err = new AppError("SUPPLIER_REJECTED", {
      details: { errors: [{ status: 400, code: 32171 }] },
      supplier: { ...supplier, rawRequest: { card: "4111111111111111" } } as SupplierIssue,
    });

    const customer = toErrorEnvelope(err, REQUEST_ID, { exposeSupplier: false });
    expectValid(customer);
    expect(customer.body.error).not.toHaveProperty("supplier");
    expect(customer.body.error.details).toEqual({ errors: [{ status: 400, code: 32171 }] });

    const consoleScope = toErrorEnvelope(err, REQUEST_ID, { exposeSupplier: true });
    expectValid(consoleScope);
    expect(consoleScope.body.error.supplier).toEqual(supplier);
    expect(JSON.stringify(consoleScope.body)).not.toContain("4111111111111111");

    // `status` and `code` are integers in the schema: NaN (JSON null) and fractions are left out.
    const sloppy = toErrorEnvelope(
      new AppError("SUPPLIER_REJECTED", { supplier: { ...supplier, status: Number.NaN, code: 477.5 } }),
      REQUEST_ID,
      { exposeSupplier: true },
    );
    expectValid(sloppy);
    expect(sloppy.body.error.supplier).toEqual({
      provider: "amadeus",
      title: supplier.title,
      detail: supplier.detail,
      source: supplier.source,
    });
  });

  it("copies details instead of returning the AppError's object", () => {
    const details = { bookingId: "bkg_1" };
    const envelope = toErrorEnvelope(new AppError("NOT_FOUND", { details }), REQUEST_ID, {
      exposeSupplier: false,
    });
    expect(envelope.body.error.details).toEqual(details);
    expect(envelope.body.error.details).not.toBe(details);
  });

  it("takes the status from the catalogue even when an AppError was tampered with", () => {
    // An object with AppError's prototype that never ran the constructor: no message, a wrong status.
    const tampered = Object.assign(Object.create(AppError.prototype) as object, {
      code: "NOT_FOUND",
      status: 418,
    });
    const envelope = toErrorEnvelope(tampered, REQUEST_ID, { exposeSupplier: false });
    expectValid(envelope);
    expect(envelope).toEqual({
      status: 404,
      body: {
        error: {
          code: "NOT_FOUND",
          message: ERROR_CATALOGUE.NOT_FOUND.description,
          status: 404,
          requestId: REQUEST_ID,
        },
      },
    });
  });

  it("allows fieldErrors for exactly the codes the documents' examples answer with fieldErrors", () => {
    const codes = codesWithFieldErrors(document);
    if (existsSync(PLATFORM_DOCUMENT)) {
      codesWithFieldErrors(parse(readFileSync(PLATFORM_DOCUMENT, "utf8")), codes);
    }
    expect([...FIELD_ERROR_CODES].sort()).toEqual([...codes].sort());
  });
});
