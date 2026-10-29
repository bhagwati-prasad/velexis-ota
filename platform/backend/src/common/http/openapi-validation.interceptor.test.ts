import type { IncomingHttpHeaders } from "node:http";
import { Controller, Get, Patch, Post, type CallHandler, type Type } from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import type { PlatformOperationId } from "@velexis/api-types/operations";
import { AppError, toErrorEnvelope } from "@velexis/errors";
import { lastValueFrom, of } from "rxjs";
import { beforeAll, describe, expect, it } from "vitest";
import { OpenApiOperation, VALIDATED_REQUEST, validatedRequestOf } from "./openapi-operation.decorator";
import {
  MAX_FIELD_ERRORS,
  OpenApiRequestValidator,
  OpenApiValidationInterceptor,
  PlatformOpenApi,
  requestInputOf,
} from "./openapi-validation.interceptor";

// Test data only: a made-up password.
const TEST_PASSWORD = "Northern-Lights-Test-2026!";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";

/** A valid signUp body (the document's example, with a test password). */
function signUpBody(): Record<string, unknown> {
  return {
    email: "anna.berg@example.com",
    password: TEST_PASSWORD,
    fullName: "Anna Berg",
    acceptTerms: true,
    termsVersion: "2026-10-01",
  };
}

/** Test-only handlers bound to operations of the platform document. */
@Controller("test-validation")
class ValidationTestController {
  @Post("sign-up")
  @OpenApiOperation("signUp")
  signUp(): string {
    return "handled";
  }

  @Get("tenants")
  @OpenApiOperation("adminListTenants")
  adminListTenants(): string {
    return "handled";
  }

  @Get("tenants/:tenantId")
  @OpenApiOperation("getTenant")
  getTenant(): string {
    return "handled";
  }

  @Post("tenants")
  @OpenApiOperation("createTenant")
  createTenant(): string {
    return "handled";
  }

  @Patch("tenants/:tenantId")
  @OpenApiOperation("updateTenant")
  updateTenant(): string {
    return "handled";
  }

  @Post("sign-out-everywhere")
  @OpenApiOperation("signOutEverywhere")
  signOutEverywhere(): string {
    return "handled";
  }

  // Pending until PBE-040 binds it in the API: bound here only to run its request validation.
  @Patch("tenants/:tenantId/amadeus-connections/:environment")
  @OpenApiOperation("updateAmadeusConnection")
  updateAmadeusConnection(): string {
    return "handled";
  }

  @Get("unbound")
  unbound(): string {
    return "handled";
  }
}

@Controller("test-validation-rogue")
class RogueController {
  @Post("rogue")
  @OpenApiOperation("rogueOperation" as PlatformOperationId)
  rogue(): void {}
}

/** A DiscoveryService that knows only the given controllers. */
function discoveryOf(...controllers: Type[]): DiscoveryService {
  return {
    getControllers: () => controllers.map((metatype) => ({ metatype, name: metatype.name })),
  } as unknown as DiscoveryService;
}

interface FakeRequest {
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  body?: unknown;
}

function request(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return { params: {}, query: {}, headers: {}, ...overrides };
}

const handled: CallHandler = { handle: () => of("handled") };

let api: PlatformOpenApi;
let interceptor: OpenApiValidationInterceptor;

beforeAll(() => {
  api = PlatformOpenApi.load();
  interceptor = new OpenApiValidationInterceptor(
    api,
    discoveryOf(ValidationTestController),
    new MetadataScanner(),
  );
  interceptor.onModuleInit();
});

/** Runs the interceptor for `handler` of ValidationTestController: the handler's answer, or the thrown AppError. */
async function run(
  handler: keyof ValidationTestController,
  req: FakeRequest,
): Promise<{ answer?: unknown; error?: AppError }> {
  const context = new ExecutionContextHost(
    [req, {}, () => undefined],
    ValidationTestController,
    ValidationTestController.prototype[handler],
  );
  try {
    return { answer: await lastValueFrom(interceptor.intercept(context, handled)) };
  } catch (error) {
    if (error instanceof AppError) {
      return { error };
    }
    throw error;
  }
}

describe("OpenApiValidationInterceptor", () => {
  it("[PBE-008 AC1] answers 400 VALIDATION_FAILED for a body with an unknown property, naming its path in fieldErrors and never the submitted value", async () => {
    const body = { ...signUpBody(), passwordConfirmation: TEST_PASSWORD };

    const { error } = await run("signUp", request({ body, headers: { "content-type": "application/json" } }));

    expect(error?.code).toBe("VALIDATION_FAILED");
    expect(error?.status).toBe(400);
    expect(error?.fieldErrors).toEqual([
      { path: "/passwordConfirmation", code: "additionalProperties", message: "This field is not allowed." },
    ]);
    const envelope = toErrorEnvelope(error, "req-validation-ac1", { exposeSupplier: false });
    expect(envelope.status).toBe(400);
    expect(envelope.body.error.fieldErrors?.map((fieldError) => fieldError.path)).toEqual([
      "/passwordConfirmation",
    ]);
    expect(JSON.stringify(envelope)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(error?.fieldErrors)).not.toContain(TEST_PASSWORD);
  });

  it("[PBE-008 AC1] never echoes a rejected password, whatever rule it breaks", async () => {
    const tooLong = `${TEST_PASSWORD}${"x".repeat(300)}`;
    const cases: Array<[unknown, string]> = [
      [tooLong, "maxLength"],
      [12345678901, "type"],
      ["", "minLength"],
    ];

    for (const [password, code] of cases) {
      const { error } = await run("signUp", request({ body: { ...signUpBody(), password } }));

      expect(error?.fieldErrors).toEqual([expect.objectContaining({ path: "/password", code })]);
      expect(JSON.stringify(error?.fieldErrors)).not.toContain(String(password).slice(0, 12) || "\u0000");
    }
  });

  it("lets a valid request through and keeps the validated request for the handler", async () => {
    const req = request({ body: signUpBody() });

    const { answer, error } = await run("signUp", req);

    expect(error).toBeUndefined();
    expect(answer).toBe("handled");
    expect(validatedRequestOf(req)).toEqual({ path: {}, query: {}, header: {}, body: signUpBody() });
  });

  it("names every problem of a body: missing, mistyped and malformed fields", async () => {
    const { error } = await run("signUp", request({ body: { email: "not-an-address", acceptTerms: false } }));

    expect(error?.fieldErrors).toEqual(
      expect.arrayContaining([
        { path: "/email", code: "format", message: "Must be a valid email." },
        { path: "/password", code: "required", message: "This field is required." },
        { path: "/fullName", code: "required", message: "This field is required." },
        { path: "/termsVersion", code: "required", message: "This field is required." },
        { path: "/acceptTerms", code: "const", message: "Must be true." },
      ]),
    );
    expect(JSON.stringify(error?.fieldErrors)).not.toContain("not-an-address");
  });

  it("requires the JSON body of an operation that has one, and refuses a body that is not JSON", async () => {
    expect((await run("signUp", request())).error?.fieldErrors).toEqual([
      { path: "", code: "required", message: "A JSON request body is required." },
    ]);
    const textBody = request({ headers: { "content-type": "text/plain", "content-length": "12" } });
    expect((await run("signUp", textBody)).error?.fieldErrors).toEqual([
      { path: "", code: "mediaType", message: "The request body must be JSON (application/json)." },
    ]);
    expect((await run("signUp", request({ body: [signUpBody()] }))).error?.fieldErrors).toEqual([
      { path: "", code: "type", message: "Must be of type object." },
    ]);
  });

  it("accepts no body or an empty one on an operation without a body, and refuses any other", async () => {
    expect((await run("signOutEverywhere", request())).answer).toBe("handled");
    expect((await run("signOutEverywhere", request({ body: {} }))).answer).toBe("handled");
    expect(
      (await run("signOutEverywhere", request({ body: { refreshToken: "x" } }))).error?.fieldErrors,
    ).toEqual([{ path: "", code: "body", message: "This operation takes no request body." }]);
  });

  it("coerces query parameters to their types and applies their defaults, without touching the request", async () => {
    const page = request({ query: { limit: "20", cursor: "abc", unknown: "kept-out" } });
    const defaults = request();

    await run("adminListTenants", page);
    await run("adminListTenants", defaults);

    expect(validatedRequestOf(page).query).toEqual({ limit: 20, cursor: "abc" });
    expect(page.query).toEqual({ limit: "20", cursor: "abc", unknown: "kept-out" });
    expect(validatedRequestOf(defaults).query).toEqual({ limit: 50 });
  });

  it("names a bad parameter as /<in>/<name> with the document's spelling", async () => {
    const limits = await run("adminListTenants", request({ query: { limit: "abc" } }));
    const tooMany = await run("adminListTenants", request({ query: { limit: "201" } }));
    const tenant = await run("getTenant", request({ params: { tenantId: "ten_<script>" } }));
    const noKey = await run("createTenant", request({ body: {} }));

    expect(limits.error?.fieldErrors).toEqual([
      { path: "/query/limit", code: "type", message: "Must be of type integer." },
    ]);
    expect(tooMany.error?.fieldErrors).toEqual([
      { path: "/query/limit", code: "maximum", message: "Must be at most 200." },
    ]);
    expect(tenant.error?.fieldErrors).toEqual([
      { path: "/path/tenantId", code: "pattern", message: "Has an invalid format." },
    ]);
    expect(noKey.error?.fieldErrors).toEqual(
      expect.arrayContaining([
        { path: "/header/Idempotency-Key", code: "required", message: "This parameter is required." },
      ]),
    );
    expect(JSON.stringify(tenant.error?.fieldErrors)).not.toContain("<script>");
  });

  it("[FIX-W32-PLATFORM AC1] refuses a monitored queue numbered above 99 with 400 VALIDATION_FAILED at the queue's path, and takes 0 to 99", async () => {
    const settings = (queueId: number) =>
      request({
        params: { tenantId: TENANT_ID, environment: "test" },
        headers: { "if-match": '"2"' },
        body: {
          monitoredQueues: [
            { officeId: "NCE1A0955", queueId: 8, category: 0 },
            { officeId: "NCE1A0955", queueId, category: 1 },
          ],
        },
      });

    for (const queueId of [0, 99]) {
      expect([queueId, await run("updateAmadeusConnection", settings(queueId))]).toEqual([
        queueId,
        { answer: "handled" },
      ]);
    }
    for (const queueId of [100, 512]) {
      const { error } = await run("updateAmadeusConnection", settings(queueId));
      expect(error?.code).toBe("VALIDATION_FAILED");
      expect(error?.status).toBe(400);
      expect(error?.fieldErrors).toEqual([
        { path: "/monitoredQueues/1/queueId", code: "maximum", message: "Must be at most 99." },
      ]);
      // The message names the rule, never the value.
      expect(JSON.stringify(error?.fieldErrors)).not.toContain(String(queueId));
    }
  });

  it("reads header parameters case-insensitively, as Node lower-cases header names", async () => {
    const req = request({
      params: { tenantId: TENANT_ID },
      headers: { "if-match": '"3"' },
      body: { name: "Nordic Trips" },
    });

    const { error } = await run("updateTenant", req);

    expect(error).toBeUndefined();
    expect(validatedRequestOf(req).header).toEqual({ "if-match": '"3"' });
    expect(validatedRequestOf(req).path).toEqual({ tenantId: TENANT_ID });
  });

  it(`answers at most ${MAX_FIELD_ERRORS} field errors`, async () => {
    const body = {
      ...signUpBody(),
      ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`extra${i}`, i])),
    };

    const { error } = await run("signUp", request({ body }));

    expect(error?.fieldErrors).toHaveLength(MAX_FIELD_ERRORS);
  });

  it("does not validate a handler without @OpenApiOperation", async () => {
    const req = request({ body: { anything: TEST_PASSWORD } });

    expect((await run("unbound", req)).answer).toBe("handled");
    expect(Reflect.get(req, VALIDATED_REQUEST)).toBeUndefined();
  });

  it("refuses to start when a handler binds an operation the document does not have", () => {
    const rogue = new OpenApiValidationInterceptor(
      api,
      discoveryOf(ValidationTestController, RogueController),
      new MetadataScanner(),
    );

    expect(() => rogue.onModuleInit()).toThrow(
      '@OpenApiOperation("rogueOperation") on RogueController.rogue: The platform document has no operation "rogueOperation"',
    );
  });
});

describe("OpenApiRequestValidator", () => {
  it("compiles the validators of every operation of the document (strict Ajv, so a misspelt keyword fails here)", () => {
    const validator = new OpenApiRequestValidator(api);

    for (const operation of api.operations()) {
      expect(() => validator.compile(operation.operationId), operation.operationId).not.toThrow();
    }
    expect(api.operations().length).toBeGreaterThanOrEqual(98);
  });

  it("merges path-item parameters into the operation's", () => {
    expect(api.operation("getTenant")?.parameters).toEqual([
      expect.objectContaining({ name: "tenantId", in: "path", required: true }),
    ]);
  });

  it("reads the platform catalogue's messages", () => {
    expect(api.errorMessage("NOT_FOUND")).toBe(
      "The resource does not exist or is not visible to the caller.",
    );
    expect(api.errorMessage("NOT_A_CODE")).toBeUndefined();
  });

  it("refuses a document that is not OpenAPI 3.1 and a request body that is not JSON", () => {
    expect(() => PlatformOpenApi.fromDocument({ openapi: "3.0.3", paths: {} })).toThrow(/not OpenAPI 3\.1/);
    expect(() =>
      PlatformOpenApi.fromDocument({
        openapi: "3.1.0",
        paths: {
          "/upload": {
            post: {
              operationId: "upload",
              requestBody: { content: { "text/csv": { schema: { type: "string" } } } },
              responses: {},
            },
          },
        },
      }),
    ).toThrow("upload: the API reads JSON request bodies only (application/json)");
  });
});

describe("requestInputOf", () => {
  it("flags body bytes the JSON parser did not read", () => {
    expect(requestInputOf(request({ headers: { "content-length": "5" } })).unreadBody).toBe(true);
    expect(requestInputOf(request({ headers: { "transfer-encoding": "chunked" } })).unreadBody).toBe(true);
    expect(requestInputOf(request({ headers: { "content-length": "0" } })).unreadBody).toBe(false);
    expect(requestInputOf(request({ headers: { "content-length": "5" }, body: {} })).unreadBody).toBe(false);
    expect(requestInputOf(request()).unreadBody).toBe(false);
  });
});
