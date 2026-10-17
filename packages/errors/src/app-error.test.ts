import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AppError,
  ERROR_CATALOGUE,
  FIELD_ERROR_CODES,
  OTA_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  httpStatusFor,
  isAppError,
  isErrorCode,
  isFieldErrorCode,
  type ErrorCode,
  type OtaErrorCode,
  type PlatformErrorCode,
} from "./index.js";

// Tests of task X-009: the generated catalogue and AppError. The catalogue is compared with the
// `x-error-catalogue` of the documents themselves (parsed here with `yaml`), so a stale catalogue.ts fails.
// The compile-time checks use `// @ts-expect-error` (checked by `tsc` in `typecheck` and `build`) and the same
// snippets compiled here with the TypeScript compiler API, so the test proves them on its own.

const PACKAGE_DIR = join(__dirname, "..");
const REPO_ROOT = join(PACKAGE_DIR, "..", "..");
const OTA_DOCUMENT = join(REPO_ROOT, "ota/backend/openapi/velexis-ota-booking-api.openapi.yaml");
const PLATFORM_DOCUMENT = join(REPO_ROOT, "platform/backend/openapi/velexis-platform-api.openapi.yaml");
const API_TYPES_DIR = dirname(require.resolve("@velexis/api-types/package.json"));

// Compiling the package with the 22,000-line generated OTA types takes a few seconds (more on a busy runner).
const COMPILE_TIMEOUT_MS = 120_000;

interface CatalogueEntry {
  status: number;
  description: string;
}

/** The `x-error-catalogue` of a document, in document order; empty when the document does not exist. */
function documentCatalogue(file: string): Array<[string, CatalogueEntry]> {
  if (!existsSync(file)) {
    return [];
  }
  const document = parse(readFileSync(file, "utf8")) as {
    "x-error-catalogue": Record<string, CatalogueEntry>;
  };
  return Object.entries(document["x-error-catalogue"]);
}

/** A TypeScript program over the package sources and in-memory snippets in src/. */
function createProgram(snippets: ReadonlyMap<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
    lib: ["lib.es2023.d.ts"],
    // The contract types from their sources, so the test does not depend on a build of @velexis/api-types.
    paths: { "@velexis/api-types": [join(API_TYPES_DIR, "src", "index.ts")] },
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = snippets.get(fileName);
    return text === undefined
      ? getSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, text, languageVersion);
  };
  host.fileExists = (fileName) => snippets.has(fileName) || fileExists(fileName);
  return ts.createProgram({
    rootNames: [join(PACKAGE_DIR, "src", "index.ts"), ...snippets.keys()],
    options,
    host,
  });
}

function diagnosticsOf(program: ts.Program, file: string): string[] {
  const sourceFile = program.getSourceFile(file);
  if (sourceFile === undefined) {
    throw new Error(`${file} is not part of the program`);
  }
  return [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)].map(
    (diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
  );
}

describe("ERROR_CATALOGUE and AppError", () => {
  const ota = documentCatalogue(OTA_DOCUMENT);
  const platform = documentCatalogue(PLATFORM_DOCUMENT);

  it("maps every catalogue code of the documents to its status, and AppError takes it from there [X-009 AC1]", () => {
    // The OTA document has 66 codes today; codes are only added (ADR-0006), so this never counts them exactly.
    expect(ota.length).toBeGreaterThanOrEqual(66);
    expect(OTA_ERROR_CODES).toEqual(ota.map(([code]) => code));
    expect(PLATFORM_ERROR_CODES).toEqual(platform.map(([code]) => code));
    const otaCodes = new Set<string>(OTA_ERROR_CODES);
    const platformOnly = PLATFORM_ERROR_CODES.filter((code) => !otaCodes.has(code));
    expect(Object.keys(ERROR_CATALOGUE)).toEqual([...OTA_ERROR_CODES, ...platformOnly]);

    for (const [code, { status, description }] of ota) {
      expect(isErrorCode(code)).toBe(true);
      expect(ERROR_CATALOGUE[code as ErrorCode]).toEqual({ status, description, source: "ota" });
      expect(httpStatusFor(code as ErrorCode)).toBe(status);
      const err = new AppError(code as ErrorCode);
      expect([err.code, err.status, err.message]).toEqual([code, status, description]);
    }
    for (const [code, { status, description }] of platform) {
      const source = otaCodes.has(code) ? "ota" : "platform";
      expect(ERROR_CATALOGUE[code as ErrorCode]).toMatchObject({ status, source });
      if (source === "platform") {
        expect(ERROR_CATALOGUE[code as ErrorCode].description).toBe(description);
      }
      expect(new AppError(code as ErrorCode).status).toBe(status);
    }

    // A few codes the backends rely on, by name (each line also compiles only with a catalogue code).
    expect(httpStatusFor("VALIDATION_FAILED")).toBe(400);
    expect(httpStatusFor("UNAUTHENTICATED")).toBe(401);
    expect(httpStatusFor("NOT_FOUND")).toBe(404);
    expect(httpStatusFor("PRICE_CHANGED")).toBe(409);
    expect(httpStatusFor("TRAVELER_DATA_INVALID")).toBe(422);
    expect(httpStatusFor("RATE_LIMITED")).toBe(429);
    expect(httpStatusFor("INTERNAL_ERROR")).toBe(500);
    expect(httpStatusFor("SUPPLIER_TIMEOUT")).toBe(504);
  });

  it("keeps every code to the Error schema's pattern and every status to an HTTP error status", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOGUE)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(Number.isInteger(entry.status) && entry.status >= 400 && entry.status <= 599).toBe(true);
      expect(entry.description.trim()).not.toBe("");
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ERROR_CATALOGUE)).toBe(true);
    expect(Object.values(ERROR_CATALOGUE).every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(Object.isFrozen(OTA_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(PLATFORM_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(FIELD_ERROR_CODES)).toBe(true);
  });

  it("types the code unions from the documents", () => {
    const otaCode: OtaErrorCode = "SOLD_OUT";
    const code: ErrorCode = otaCode;
    // `never` until the platform document exists (M1); the platform plan's codes then join ErrorCode.
    const platformCodes: readonly PlatformErrorCode[] = PLATFORM_ERROR_CODES;
    expect([code, platformCodes.length]).toEqual(["SOLD_OUT", platform.length]);
  });
});

describe("AppError", () => {
  const okSnippet = join(PACKAGE_DIR, "src", "__x009_app_error_ok.ts");
  const unknownCodeSnippet = join(PACKAGE_DIR, "src", "__x009_app_error_unknown_code.ts");
  const fieldErrorsSnippet = join(PACKAGE_DIR, "src", "__x009_app_error_field_errors.ts");
  let program: ts.Program;
  beforeAll(() => {
    program = createProgram(
      new Map([
        [
          okSnippet,
          [
            'import { AppError, type ErrorCode } from "./index.js";',
            'export const notFound = new AppError("NOT_FOUND", { details: { bookingId: "bkg_1" } });',
            'export const invalid = new AppError("VALIDATION_FAILED", { fieldErrors: [{ path: "/email", code: "format" }] });',
            'export const traveler = new AppError("TRAVELER_DATA_INVALID", { fieldErrors: [] });',
            'export function rethrow(code: ErrorCode): AppError { return new AppError(code, { message: "Safe text." }); }',
            "",
          ].join("\n"),
        ],
        [
          unknownCodeSnippet,
          [
            'import { AppError } from "./index.js";',
            'export const bad = new AppError("NOT_A_CODE");',
            "",
          ].join("\n"),
        ],
        [
          fieldErrorsSnippet,
          [
            'import { AppError } from "./index.js";',
            'export const bad = new AppError("NOT_FOUND", { fieldErrors: [{ path: "/id", code: "unknown" }] });',
            "",
          ].join("\n"),
        ],
      ]),
    );
    // Type-checking is the expensive part, and the program keeps each file's diagnostics: checking the snippets here,
    // inside the hook's budget, keeps that work out of the tests below (whose 5 s bound it passed under a full
    // parallel `pnpm test`); they read the same diagnostics.
    for (const snippet of [okSnippet, unknownCodeSnippet, fieldErrorsSnippet]) {
      diagnosticsOf(program, snippet);
    }
  }, COMPILE_TIMEOUT_MS);

  it('does not compile new AppError("NOT_A_CODE") [X-009 AC1]', () => {
    // Checked by `tsc` (typecheck and build of this package): an unused @ts-expect-error is an error itself.
    // @ts-expect-error "NOT_A_CODE" is not a code of the error catalogue
    expect(() => new AppError("NOT_A_CODE")).toThrow(TypeError);

    // The same, compiled here.
    expect(diagnosticsOf(program, okSnippet)).toEqual([]);
    const errors = diagnosticsOf(program, unknownCodeSnippet);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^TS2345: Argument of type '"NOT_A_CODE"' is not assignable to parameter of type/,
    );
  });

  it("compiles fieldErrors only for the codes of FIELD_ERROR_CODES", () => {
    // @ts-expect-error NOT_FOUND carries no fieldErrors
    const notFound = new AppError("NOT_FOUND", { fieldErrors: [{ path: "/id", code: "unknown" }] });
    expect(notFound.code).toBe("NOT_FOUND");

    const errors = diagnosticsOf(program, fieldErrorsSnippet);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^TS2322: Type '\{ path: string; code: string; \}\[\]' is not assignable to type 'undefined'/,
    );
  });

  it("takes its status and default message from the catalogue and keeps the options", () => {
    const err = new AppError("PRICE_CHANGED", {
      details: { newPrice: { amount: "10.00", currency: "EUR" } },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe("AppError");
    expect(err.code).toBe("PRICE_CHANGED");
    expect(err.status).toBe(409);
    expect(err.message).toBe(ERROR_CATALOGUE.PRICE_CHANGED.description);
    expect(err.details).toEqual({ newPrice: { amount: "10.00", currency: "EUR" } });
    expect(err.fieldErrors).toBeUndefined();
    expect(err.supplier).toBeUndefined();
    expect(err.stack).toContain("AppError");

    const fieldErrors = [{ path: "/email", code: "format", message: "Enter a valid e-mail address." }];
    const supplier = { provider: "amadeus" as const, status: 400, code: 477, title: "INVALID FORMAT" };
    const invalid = new AppError("VALIDATION_FAILED", { message: "Check the form.", fieldErrors, supplier });
    expect([invalid.message, invalid.status]).toEqual(["Check the form.", 400]);
    expect(invalid.fieldErrors).toEqual(fieldErrors);
    expect(invalid.supplier).toEqual(supplier);
  });

  it("keeps the cause for the logs, and has none without one", () => {
    const cause = new Error("connection reset by peer");
    expect(new AppError("SUPPLIER_UNAVAILABLE", { cause }).cause).toBe(cause);
    expect("cause" in new AppError("SUPPLIER_UNAVAILABLE")).toBe(false);
  });

  it("refuses a code from outside the catalogue at run time (JavaScript callers, casts)", () => {
    for (const code of ["NOT_A_CODE", "not_found", "", "toString", "constructor", "__proto__"]) {
      expect(() => new AppError(code as ErrorCode)).toThrow(TypeError);
    }
    expect(() => new AppError("NOT_A_CODE" as ErrorCode)).toThrow(
      'AppError: "NOT_A_CODE" is not a code of the error catalogue',
    );
  });

  it("recognises AppErrors, catalogue codes and field-error codes", () => {
    expect(isAppError(new AppError("CONFLICT"))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError({ name: "AppError", code: "NOT_FOUND", status: 404, message: "x" })).toBe(false);
    expect(isAppError(null)).toBe(false);

    expect(isErrorCode("SOLD_OUT")).toBe(true);
    for (const value of [
      "SOLD_OUT ",
      "sold_out",
      "toString",
      "hasOwnProperty",
      "",
      404,
      null,
      undefined,
      {},
    ]) {
      expect(isErrorCode(value)).toBe(false);
    }

    expect(FIELD_ERROR_CODES).toContain("VALIDATION_FAILED");
    expect(isFieldErrorCode("VALIDATION_FAILED")).toBe(true);
    expect(isFieldErrorCode("TRAVELER_DATA_INVALID")).toBe(true);
    expect(isFieldErrorCode("NOT_FOUND")).toBe(false);
    expect(isFieldErrorCode("INTERNAL_ERROR")).toBe(false);
  });
});
