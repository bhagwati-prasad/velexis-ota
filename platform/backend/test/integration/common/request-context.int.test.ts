// The HTTP pipeline of the platform API through createTestApp (PBE-008): the request context with the end user's IP
// and user agent of PADR-0019, the error filter, request validation against the document, the JSON body parser with
// the raw body on /webhooks/* only, helmet, and the FakeClock and id generator of CommonModule. The application runs
// on this file's own database clone and Redis database and listens on 127.0.0.1, so Supertest calls from loopback,
// as the portal and admin servers do.
import { Body, Controller, Get, Module, Post, Req, type DynamicModule } from "@nestjs/common";
import { expectResponseToMatch } from "@velexis/testing";
import type { PlatformOperationId } from "@velexis/api-types/operations";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Clock } from "../../../src/common/clock";
import { OpenApiOperation, Validated } from "../../../src/common/http/openapi-operation.decorator";
import { rawBodyOf, type RawBodyRequest } from "../../../src/common/http/raw-body";
import { RequestContext } from "../../../src/common/http/request-context";
import { IdGenerator } from "../../../src/common/ids";
import { AppModule } from "../../../src/app.module";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { createApiApp } from "../../../src/main";
import { createTestApp, LogSink, TEST_BFF_KEY, type TestApp } from "../../support/app";

// Test values only: documentation addresses (RFC 5737, RFC 3849) and a made-up password.
const PERSON_IP = "203.0.113.7";
const OTHER_PERSON_IP = "2001:db8::42";
const PERSON_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Safari/605.1.15";
const SERVER_AGENT = "node-fetch/test";
const TEST_PASSWORD = "Northern-Lights-Test-2026!";

interface ContextAnswer {
  readonly requestId: string;
  readonly ip: string;
  readonly userAgent: string | null;
  readonly now: string;
  readonly tenantId: string;
}

/** Test-only routes behind the API's pipeline. */
@Controller("test/pipeline")
class PipelineTestController {
  constructor(
    private readonly context: RequestContext,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  @Get("context")
  current(): ContextAnswer {
    return {
      requestId: this.context.requestId ?? "",
      ip: this.context.ip ?? "",
      userAgent: this.context.userAgent ?? null,
      now: this.clock.now().toISOString(),
      tenantId: this.ids.new("ten"),
    };
  }

  @Get("fail")
  fail(): never {
    throw new TypeError("Cannot read properties of undefined (reading 'secret-detail-5')");
  }

  /** Bound to signUp, so its body is validated against SignUpRequest; answers what signUp answers. */
  @Post("sign-up")
  @OpenApiOperation("signUp")
  signUp(@Validated("body") body: { email: string }): { email: string } {
    return { email: body.email };
  }

  @Post("raw")
  raw(@Req() req: RawBodyRequest, @Body() body: unknown): { raw: string | null; body: unknown } {
    return { raw: rawBodyOf(req)?.toString("utf8") ?? null, body };
  }
}

/** Binds an operation the document lacks (a cast gets it past the compiler): the application must not start. */
@Controller("test/rogue")
class RogueTestController {
  @Post()
  @OpenApiOperation("rogueOperation" as PlatformOperationId)
  rogue(): void {}
}

@Controller("webhooks/test")
class WebhookTestController {
  @Post()
  receive(@Req() req: RawBodyRequest, @Body() body: unknown): { raw: string | null; body: unknown } {
    return { raw: rawBodyOf(req)?.toString("utf8") ?? null, body };
  }
}

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ controllers: [PipelineTestController, WebhookTestController] });
});

afterAll(async () => {
  await t.close();
});

function contextOf(res: { body: unknown }): ContextAnswer {
  return res.body as ContextAnswer;
}

describe("the end user of the request context (PADR-0019)", () => {
  it("[PBE-008 AC5] holds the forwarded IP and user agent with the valid key, from loopback, without X-Forwarded-For", async () => {
    const res = await t.http
      .get("/test/pipeline/context")
      .set("User-Agent", SERVER_AGENT)
      .set(t.bffHeaders(PERSON_IP, PERSON_AGENT));
    const ipv6 = await t.http.get("/test/pipeline/context").set(t.bffHeaders(OTHER_PERSON_IP, PERSON_AGENT));

    expect(res.status).toBe(200);
    expect(contextOf(res)).toMatchObject({ ip: PERSON_IP, userAgent: PERSON_AGENT });
    expect(contextOf(ipv6).ip).toBe(OTHER_PERSON_IP);
  });

  it("[PBE-008 AC5] ignores both headers with a wrong key, uses req.ip, and logs a warning without the key", async () => {
    const wrongKey = `${TEST_BFF_KEY.slice(0, -1)}X`;
    const before = t.logs.lines.length;

    const res = await t.http
      .get("/test/pipeline/context")
      .set("User-Agent", SERVER_AGENT)
      .set({ ...t.bffHeaders(PERSON_IP, PERSON_AGENT), "X-Velexis-Bff-Key": wrongKey });

    expect(res.status).toBe(200);
    expect(contextOf(res)).toMatchObject({ ip: "127.0.0.1", userAgent: SERVER_AGENT });
    const logged = t.logs.lines.slice(before);
    expect(logged.filter((line) => line["msg"] === "request_context.bff_key_ignored")).toEqual([
      expect.objectContaining({ level: 40, reason: "bff_key_invalid", requestId: contextOf(res).requestId }),
    ]);
    expect(JSON.stringify(logged)).not.toContain(wrongKey);
  });

  it("[PBE-008 AC5] ignores both headers when X-Forwarded-For is present and uses req.ip (Caddy's client address)", async () => {
    const res = await t.http
      .get("/test/pipeline/context")
      .set("User-Agent", SERVER_AGENT)
      .set("X-Forwarded-For", "198.51.100.23")
      .set(t.bffHeaders(PERSON_IP, PERSON_AGENT));

    expect(res.status).toBe(200);
    expect(contextOf(res)).toMatchObject({ ip: "198.51.100.23", userAgent: SERVER_AGENT });
  });

  it("[PBE-008 AC5] answers 400 VALIDATION_FAILED for the valid key with a missing or malformed IP", async () => {
    const missing = await t.http
      .get("/test/pipeline/context")
      .set({ "X-Velexis-Bff-Key": TEST_BFF_KEY, "X-Velexis-End-User-Agent": PERSON_AGENT });
    const malformed = await t.http
      .get("/test/pipeline/context")
      .set(t.bffHeaders("203.0.113.300-secret-value-6", PERSON_AGENT));

    for (const res of [missing, malformed]) {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: {
          code: "VALIDATION_FAILED",
          status: 400,
          requestId: res.headers["x-request-id"],
          fieldErrors: [{ path: "/header/X-Velexis-End-User-IP" }],
        },
      });
    }
    expect(missing.body.error.fieldErrors[0].code).toBe("required");
    expect(malformed.body.error.fieldErrors[0].code).toBe("format");
    expect(JSON.stringify(malformed.body)).not.toContain("secret-value-6");
    // The same 400 on an operation's route: the end user is resolved before anything else of the request runs.
    const onOperation = await t.http
      .post("/test/pipeline/sign-up")
      .set({ "X-Velexis-Bff-Key": TEST_BFF_KEY })
      .send({ email: "anna.berg@example.com" });
    expectResponseToMatch("signUp", onOperation, { document: "platform" });
    expect(onOperation.status).toBe(400);
  });

  it("uses req.ip and the request's User-Agent for a call without the key", async () => {
    const res = await t.http
      .get("/test/pipeline/context")
      .set("User-Agent", PERSON_AGENT)
      .set("X-Velexis-End-User-IP", "192.0.2.77");

    expect(contextOf(res)).toMatchObject({ ip: "127.0.0.1", userAgent: PERSON_AGENT });
  });

  it("gives every request its own context, whose id is the request id of the response and the log lines", async () => {
    const answers = await Promise.all(
      [PERSON_IP, "203.0.113.8", "203.0.113.9", OTHER_PERSON_IP].map((ip, index) =>
        t.http
          .get("/test/pipeline/context")
          .set("X-Request-Id", `req-pipeline-${index.toString().padStart(4, "0")}`)
          .set(t.bffHeaders(ip)),
      ),
    );

    expect(answers.map((res) => contextOf(res).ip)).toEqual([
      PERSON_IP,
      "203.0.113.8",
      "203.0.113.9",
      OTHER_PERSON_IP,
    ]);
    expect(answers.map((res) => contextOf(res).requestId)).toEqual([
      "req-pipeline-0000",
      "req-pipeline-0001",
      "req-pipeline-0002",
      "req-pipeline-0003",
    ]);
    expect(answers.map((res) => res.headers["x-request-id"])).toEqual(
      answers.map((res) => contextOf(res).requestId),
    );
  });
});

describe("the error filter", () => {
  it("[PBE-008 AC2] answers a thrown TypeError as 500 INTERNAL_ERROR with the requestId and no stack, and logs the stack", async () => {
    const before = t.logs.lines.length;

    const res = await t.http.get("/test/pipeline/fail").set("X-Request-Id", "req-pipeline-0500");
    const logged = await vi.waitFor(() => {
      const lines = t.logs.lines.slice(before);
      expect(lines.map((line) => line["msg"])).toContain("request errored");
      return lines;
    });

    expect(res.status).toBe(500);
    expect(res.headers["x-request-id"]).toBe("req-pipeline-0500");
    expect(res.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected error; quote the requestId to support.",
        status: 500,
        requestId: "req-pipeline-0500",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("secret-detail-5");
    expect(res.text).not.toMatch(/\bat .+:\d+:\d+/);
    expect(logged.map((line) => line["msg"])).toEqual(["http.unhandled_error", "request errored"]);
    expect(logged[0]).toMatchObject({
      level: 50,
      requestId: "req-pipeline-0500",
      err: expect.objectContaining({
        type: "TypeError",
        stack: expect.stringContaining("PipelineTestController.fail"),
      }),
    });
  });

  it("answers an unknown route with 404 NOT_FOUND in the envelope and the platform's message, without the path", async () => {
    const res = await t.http.get("/v1/nowhere?token=secret-value-7");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The resource does not exist or is not visible to the caller.",
        status: 404,
        requestId: res.headers["x-request-id"],
      },
    });
    expect(res.text).not.toContain("nowhere");
  });
});

describe("request validation", () => {
  it("refuses to start an application whose handler binds an operation the document does not have", async () => {
    // Built as main.ts builds it, on this file's services: a second createTestApp would flush the Redis database.
    @Module({})
    class RogueRootModule {
      static forRoot(): DynamicModule {
        const logger = createProcessLogger(PLATFORM_PROCESSES.api, t.config, new LogSink());
        return {
          module: RogueRootModule,
          imports: [AppModule.forRoot(t.config, logger)],
          controllers: [RogueTestController],
        };
      }
    }
    const app = await createApiApp(t.config, RogueRootModule.forRoot());
    try {
      await expect(app.init()).rejects.toThrow(
        '@OpenApiOperation("rogueOperation") on RogueTestController.rogue: The platform document has no operation "rogueOperation"',
      );
    } finally {
      await app.close();
    }
  });

  it("[PBE-008 AC1] answers 400 VALIDATION_FAILED for a body with an unknown property, with its path and without the submitted value", async () => {
    const res = await t.http.post("/test/pipeline/sign-up").send({
      email: "anna.berg@example.com",
      password: TEST_PASSWORD,
      fullName: "Anna Berg",
      acceptTerms: true,
      termsVersion: "2026-10-01",
      passwordRepeat: TEST_PASSWORD,
    });

    expect(res.status).toBe(400);
    expectResponseToMatch("signUp", res, { document: "platform" });
    expect(res.body.error).toMatchObject({
      code: "VALIDATION_FAILED",
      requestId: res.headers["x-request-id"],
      fieldErrors: [{ path: "/passwordRepeat", code: "additionalProperties" }],
    });
    expect(res.text).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(t.logs.lines)).not.toContain(TEST_PASSWORD);
  });

  it("passes a valid body to the handler", async () => {
    const res = await t.http.post("/test/pipeline/sign-up").send({
      email: "anna.berg@example.com",
      password: TEST_PASSWORD,
      fullName: "Anna Berg",
      acceptTerms: true,
      termsVersion: "2026-10-01",
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ email: "anna.berg@example.com" });
  });

  it("answers 400 for malformed JSON without quoting it, with a request log line", async () => {
    const before = t.logs.lines.length;

    const res = await t.http
      .post("/test/pipeline/sign-up")
      .set("Content-Type", "application/json")
      .set("X-Request-Id", "req-pipeline-json")
      .send(`{"password":"${TEST_PASSWORD}",`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "The request body, query or headers failed validation; see fieldErrors.",
        status: 400,
        requestId: "req-pipeline-json",
        fieldErrors: [{ path: "", code: "json", message: "The request body is not valid JSON." }],
      },
    });
    expect(res.text).not.toContain(TEST_PASSWORD);
    await vi.waitFor(() =>
      expect(t.logs.lines.slice(before)).toContainEqual(
        expect.objectContaining({ msg: "request completed", requestId: "req-pipeline-json", status: 400 }),
      ),
    );
    expect(JSON.stringify(t.logs.lines)).not.toContain(TEST_PASSWORD);
  });

  it("refuses a body that is not JSON on an operation", async () => {
    const res = await t.http.post("/test/pipeline/sign-up").set("Content-Type", "text/plain").send("hello");

    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors).toEqual([
      { path: "", code: "mediaType", message: "The request body must be JSON (application/json)." },
    ]);
  });
});

describe("the body parser", () => {
  it("keeps the raw body on /webhooks/* only", async () => {
    const text = '{"id": "evt_test_1",   "type":"invoice.paid"}';

    const webhook = await t.http.post("/webhooks/test").set("Content-Type", "application/json").send(text);
    const api = await t.http.post("/test/pipeline/raw").set("Content-Type", "application/json").send(text);

    expect(webhook.body).toEqual({ raw: text, body: { id: "evt_test_1", type: "invoice.paid" } });
    expect(api.body).toEqual({ raw: null, body: { id: "evt_test_1", type: "invoice.paid" } });
  });

  it("refuses an API body over 100 KB with 400, and accepts it on /webhooks/* (1 MB)", async () => {
    const large = { padding: "x".repeat(150 * 1024) };

    const api = await t.http.post("/test/pipeline/raw").send(large);
    const webhook = await t.http.post("/webhooks/test").send(large);

    expect(api.status).toBe(400);
    expect(api.body.error.fieldErrors).toEqual([
      { path: "", code: "maxSize", message: "The request body is too large." },
    ]);
    expect(webhook.status).toBe(201);
  });
});

describe("the application", () => {
  it("sets helmet's security headers and no X-Powered-By", async () => {
    const res = await t.http.get("/health/live");

    expectResponseToMatch("healthLive", res, { document: "platform" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("injects the FakeClock, and the id generator stamps ids with it", async () => {
    const res = await t.http.get("/test/pipeline/context");

    expect(contextOf(res).now).toBe(t.clock.now().toISOString());
    expect(contextOf(res).tenantId).toMatch(/^ten_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
