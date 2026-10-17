// The request half of the HTTP pipeline, in process (no PostgreSQL or Redis): body parsing, OpenAPI validation and the
// validated input. Probe controllers are bound to real operations of the OTA document on paths of their own (the
// interceptor validates by operation, not by path); the error envelope itself is error.filter.test.ts.
import { Body, Controller, Get, Headers, Param, Post, Query, Req } from "@nestjs/common";
import { otaOperations } from "@velexis/api-types/operations";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Request } from "express";
import { ClsService } from "nestjs-cls";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { edgeHeaders } from "../../../test/helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../../test/helpers/openapi";
import { createTestApp, type TestApp } from "../../../test/support/create-test-app";
import { PublicRoute, WebhookRoute } from "../auth/caller.guard";
import { JSON_BODY_LIMIT_BYTES, routePattern, toBodyError, WEBHOOK_BODY_LIMIT_BYTES } from "./body-parsers";
import { OpenApiInput, OpenApiOperation, type ValidatedInput } from "./openapi-operation.decorator";
import { loadOpenApiDocument, MAX_FIELD_ERRORS, toFieldErrors } from "./openapi-validation.interceptor";
import { RequestContext } from "./request-context";

const IDEMPOTENCY_KEY = "0b9d1c5e-6f3a-4c2b-9e7d-1a2b3c4d5e6f";
const SIGN_IN = { email: "anna.berg@example.com", password: "Fjord-Lights-2026", rememberMe: true };
/** A password-like value a client might send in a misspelt field: it must never come back or reach the log. */
const SECRET = "Hunter2-Secret-Value-77";

const handled = vi.fn();

// Public: validation runs the same for every caller; the caller guard before it is common/auth/caller.guard.test.ts.
@Controller("__probe")
@PublicRoute()
class ProbeController {
  constructor(private readonly cls: ClsService) {}

  @Post("sign-in")
  @OpenApiOperation("signIn")
  signIn(@OpenApiInput() input: ValidatedInput<"signIn">, @Body() body: unknown): object {
    handled("signIn");
    return { input, body, consoleScope: new RequestContext(this.cls).isConsoleScope() };
  }

  @Get("queues/:queueId")
  @OpenApiOperation("consoleListQueue")
  listQueue(
    @OpenApiInput() input: ValidatedInput<"consoleListQueue">,
    @Param("queueId") queueId: unknown,
    @Query("limit") limit: unknown,
    @Headers("x-velexis-environment") environment: unknown,
  ): object {
    handled("consoleListQueue");
    const context = new RequestContext(this.cls);
    return {
      input,
      queueId,
      limit,
      environment,
      consoleScope: context.isConsoleScope(),
      operationId: context.operationId(),
    };
  }

  @Get("bookings")
  @OpenApiOperation("consoleListBookings")
  listBookings(@OpenApiInput() input: ValidatedInput<"consoleListBookings">): object {
    handled("consoleListBookings");
    return { input };
  }

  @Get("bookings/:bookingId")
  @OpenApiOperation("getBooking")
  getBooking(@OpenApiInput() input: ValidatedInput<"getBooking">, @Query() query: unknown): object {
    handled("getBooking");
    return { input, query };
  }

  @Post("upsell/:offerId")
  @OpenApiOperation("upsellFlightOffer")
  upsell(@OpenApiInput() input: ValidatedInput<"upsellFlightOffer">): object {
    handled("upsellFlightOffer");
    return { body: input.body ?? null };
  }

  @Get("unbound")
  unbound(@Req() req: Request): object {
    return { body: req.body ?? null };
  }

  @Post("unbound")
  unboundPost(@Req() req: Request): object {
    return { body: req.body as unknown, cookies: req.cookies as unknown };
  }
}

@Controller("webhooks")
@WebhookRoute()
class WebhookProbeController {
  @Post("probe/:kind")
  receive(@Req() req: Request): object {
    const body: unknown = req.body;
    return { raw: Buffer.isBuffer(body), length: Buffer.isBuffer(body) ? body.length : null };
  }
}

let api: TestApp;

// Starting the application parses and compiles the OTA document, and the first expectResponseToMatch parses it again
// for the response checker: one-time work that takes several seconds while every package's tests run at once, so it
// happens here, with the budget of test/helpers/openapi.ts, and not in the first test.
beforeAll(async () => {
  preloadOpenApiDocument();
  responseChecker("ota");
  api = await createTestApp({ controllers: [ProbeController, WebhookProbeController] });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
});

function signIn(body: unknown, headers: Record<string, string> = { "Idempotency-Key": IDEMPOTENCY_KEY }) {
  const call = request(api.server).post("/__probe/sign-in").set(headers);
  return body === undefined ? call : call.send(body as object);
}

describe("request validation (OpenAPI interceptor)", () => {
  it("answers 400 with the path of an unknown body property and never echoes its value [OBE-010 AC1]", async () => {
    handled.mockClear();
    const before = api.sink.lines.length;

    const res = await signIn({ ...SIGN_IN, passwordConfirmation: SECRET });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "The request body, query or headers failed validation; see fieldErrors.",
        status: 400,
        requestId: res.headers["x-request-id"],
        fieldErrors: [
          {
            path: "/passwordConfirmation",
            code: "additionalProperties",
            message: "passwordConfirmation is not allowed",
          },
        ],
      },
    });
    expectResponseToMatch("signIn", res);
    expect(handled).not.toHaveBeenCalled();
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain(SIGN_IN.password);
    await vi.waitFor(() => expect(api.sink.lines.length).toBeGreaterThan(before));
    expect(api.sink.lines.slice(before).join("\n")).not.toContain(SECRET);
    expect(api.sink.lines.slice(before).join("\n")).not.toContain(SIGN_IN.password);
  });

  it("never echoes a rejected value in any field error (type, pattern, format, length) [OBE-010 AC1]", async () => {
    const res = await signIn(
      { email: `${SECRET}@`, password: { value: SECRET }, rememberMe: SECRET },
      { "Idempotency-Key": "short", "X-CSRF-Token": SECRET },
    );

    expect(res.status).toBe(400);
    expect(res.text).not.toContain(SECRET);
    expect(res.body.error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/email", code: "format" }),
        expect.objectContaining({ path: "/password", code: "type" }),
        expect.objectContaining({ path: "/rememberMe", code: "type" }),
        expect.objectContaining({ path: "/header/Idempotency-Key", code: "minLength" }),
        expect.objectContaining({ path: "/header/X-CSRF-Token", code: "pattern" }),
      ]),
    );
  });

  it("hands a valid request to the handler with the validated body and headers", async () => {
    handled.mockClear();

    const res = await signIn(SIGN_IN, { "Idempotency-Key": IDEMPOTENCY_KEY, "Accept-Language": "en-GB" });

    expect(res.status).toBe(201);
    expect(handled).toHaveBeenCalledWith("signIn");
    expect(res.body).toEqual({
      input: {
        operationId: "signIn",
        path: {},
        query: {},
        headers: { "Idempotency-Key": IDEMPOTENCY_KEY, "Accept-Language": "en-GB" },
        body: SIGN_IN,
      },
      body: SIGN_IN,
      consoleScope: false,
    });
  });

  it("names a missing required header and a missing required body", async () => {
    const res = await signIn(undefined, {});

    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors).toEqual([
      { path: "/header/Idempotency-Key", code: "required", message: "Idempotency-Key is required" },
      { path: "", code: "required", message: "The request body is required" },
    ]);
  });

  it("names every missing required body property", async () => {
    const res = await signIn({ rememberMe: false });

    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors).toEqual([
      { path: "/email", code: "required", message: "email is required" },
      { path: "/password", code: "required", message: "password is required" },
    ]);
  });

  it("accepts an optional body that was not sent, and validates it when it was", async () => {
    const without = await request(api.server)
      .post("/__probe/upsell/off_01JA2Z9W5K7Q3M8N4P6R")
      .set("Idempotency-Key", IDEMPOTENCY_KEY);
    const invalid = await request(api.server)
      .post("/__probe/upsell/off_01JA2Z9W5K7Q3M8N4P6R")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ unknownField: true });

    expect(without.status).toBe(201);
    expect(without.body).toEqual({ body: null });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.fieldErrors).toContainEqual(
      expect.objectContaining({ path: "/unknownField", code: "additionalProperties" }),
    );
  });

  it("coerces path and query parameters to their schema types, also for @Param() and @Query()", async () => {
    const res = await request(api.server)
      .get("/__probe/queues/7?category=3&limit=10&cursor=abc")
      .set("X-Velexis-Environment", "test");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      input: {
        operationId: "consoleListQueue",
        path: { queueId: 7 },
        query: { category: 3, limit: 10, cursor: "abc" },
        headers: { "X-Velexis-Environment": "test" },
      },
      queueId: 7,
      limit: 10,
      environment: "test",
    });
  });

  it("splits non-exploded array parameters and coerces booleans", async () => {
    const lists = await request(api.server).get("/__probe/bookings?source=storefront,import&limit=5");
    const booking = await request(api.server).get(
      "/__probe/bookings/bkg_01JA2Z9W5K7Q3M8N4P6R?refresh=true&include=bags&extra=kept",
    );

    expect(lists.status).toBe(200);
    expect(lists.body.input.query).toEqual({ source: ["storefront", "import"], limit: 5 });
    expect(booking.status).toBe(200);
    expect(booking.body.input.query).toEqual({ refresh: true, include: ["bags"] });
    // Undocumented query parameters are tolerated and left as they came.
    expect(booking.body.query).toEqual({ refresh: true, include: ["bags"], extra: "kept" });
  });

  it("answers parameter errors with /path, /query and /header pointers", async () => {
    const queue = await request(api.server)
      .get("/__probe/queues/100?limit=0&officeId=nice&category=x")
      .set("X-Velexis-Environment", "staging");
    const booking = await request(api.server).get("/__probe/bookings/nope?refresh=maybe&include=bags,seats");
    const repeated = await request(api.server).get("/__probe/queues/1?limit=1&limit=2");

    expect(queue.status).toBe(400);
    expect(queue.body.error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/path/queueId", code: "maximum" }),
        expect.objectContaining({ path: "/query/limit", code: "minimum" }),
        expect.objectContaining({ path: "/query/officeId", code: "pattern" }),
        expect.objectContaining({ path: "/query/category", code: "type" }),
        expect.objectContaining({ path: "/header/X-Velexis-Environment", code: "enum" }),
      ]),
    );
    expect(booking.status).toBe(400);
    expect(booking.body.error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/path/bookingId", code: "pattern" }),
        expect.objectContaining({ path: "/query/refresh", code: "type" }),
        expect.objectContaining({ path: "/query/include/1", code: "enum" }),
      ]),
    );
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/query/limit", code: "type" }),
    ]);
    expectResponseToMatch("consoleListQueue", queue);
    expectResponseToMatch("getBooking", booking);
  });

  it("puts console operations in console scope and records the operation", async () => {
    const queue = await request(api.server).get("/__probe/queues/1");
    const customer = await signIn(SIGN_IN);

    expect(queue.body).toMatchObject({ consoleScope: true, operationId: "consoleListQueue" });
    expect(customer.body).toMatchObject({ consoleScope: false });
  });

  it(`returns at most ${MAX_FIELD_ERRORS} field errors`, async () => {
    const extra = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`field${index}`, index]));

    const res = await signIn({ ...SIGN_IN, ...extra });

    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors).toHaveLength(MAX_FIELD_ERRORS);
  });

  it("escapes property names in field error pointers (RFC 6901)", () => {
    const errors = toFieldErrors(
      [
        {
          keyword: "additionalProperties",
          instancePath: "/a~1b",
          schemaPath: "#/additionalProperties",
          params: { additionalProperty: "c/d~e" },
        },
      ],
      "",
    );

    expect(errors).toEqual([
      { path: "/a~1b/c~1d~0e", code: "additionalProperties", message: "c/d~e is not allowed" },
    ]);
  });
});

describe("body parsing", () => {
  it("refuses malformed JSON without quoting it, in the log either", async () => {
    const before = api.sink.lines.length;

    const res = await request(api.server)
      .post("/__probe/sign-in")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .set("Content-Type", "application/json")
      .send(`{"email":"anna.berg@example.com","password":"${SECRET}"`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "The request body is not valid JSON.",
        status: 400,
        requestId: res.headers["x-request-id"],
        details: { reason: "malformed_json" },
      },
    });
    expectResponseToMatch("signIn", res);
    await vi.waitFor(() => expect(api.sink.lines.length).toBeGreaterThan(before));
    expect(api.sink.lines.slice(before).join("\n")).not.toContain(SECRET);
  });

  it("refuses a body that is not JSON on an operation with a JSON body", async () => {
    const res = await request(api.server)
      .post("/__probe/sign-in")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .set("Content-Type", "text/plain")
      .send(`email=anna.berg@example.com&password=${SECRET}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "unsupported_media_type" },
    });
    expect(res.text).not.toContain(SECRET);
  });

  it(`refuses JSON bodies over ${JSON_BODY_LIMIT_BYTES} bytes and accepts one just under`, async () => {
    const padding = (size: number): string => "x".repeat(size);
    const envelope = JSON.stringify({ padding: "" }).length;

    const over = await request(api.server)
      .post("/__probe/unbound")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: padding(JSON_BODY_LIMIT_BYTES - envelope + 1) }));
    const under = await request(api.server)
      .post("/__probe/unbound")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: padding(JSON_BODY_LIMIT_BYTES - envelope) }));

    expect(over.status).toBe(400);
    expect(over.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "body_too_large", limitBytes: JSON_BODY_LIMIT_BYTES },
    });
    expect(under.status).toBe(201);
  });

  it("keeps the raw bytes on /webhooks/* whatever the content type", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });

    const json = await request(api.server)
      .post("/webhooks/probe/stripe")
      .set("Content-Type", "application/json")
      .send(payload);
    const text = await request(api.server)
      .post("/webhooks/probe/other")
      .set("Content-Type", "text/plain")
      .send("hi");
    const tooLarge = await request(api.server)
      .post("/webhooks/probe/stripe")
      .set("Content-Type", "application/json")
      .send("x".repeat(WEBHOOK_BODY_LIMIT_BYTES + 1));

    expect(json.body).toEqual({ raw: true, length: Buffer.byteLength(payload) });
    expect(text.body).toEqual({ raw: true, length: 2 });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error.details).toEqual({
      reason: "body_too_large",
      limitBytes: WEBHOOK_BODY_LIMIT_BYTES,
    });
  });

  it("applies a per-operation JSON limit on every spelling of the operation's route", async () => {
    const limited = await createTestApp({ jsonBodyLimits: { signIn: 1024 } });
    try {
      const big = { ...SIGN_IN, password: "p".repeat(1100) };
      const small = SIGN_IN;
      // The storefront's edge credential: the pending routes answer 501 to an accepted caller (OBE-011).
      const answers = await Promise.all([
        request(limited.server).post("/v1/auth/sign-in").set(edgeHeaders()).send(big),
        request(limited.server).post("/V1/Auth/Sign-In/").set(edgeHeaders()).send(big),
        request(limited.server).post("/v1/auth/sign-in").set(edgeHeaders()).send(small),
        // Another route keeps the default limit.
        request(limited.server).post("/v1/auth/sign-up").set(edgeHeaders()).send(big),
      ]);

      expect(answers.map((res) => res.status)).toEqual([400, 400, 501, 501]);
      expect(answers[0]?.body.error.details).toEqual({ reason: "body_too_large", limitBytes: 1024 });
      expect(answers[1]?.body.error.details).toEqual({ reason: "body_too_large", limitBytes: 1024 });
    } finally {
      await limited.close();
    }
  });

  it("refuses a JSON limit for an operation the document does not have", async () => {
    await expect(
      createTestApp({ jsonBodyLimits: { notAnOperation: 10 } as unknown as Record<"signIn", number> }),
    ).rejects.toThrow(/unknown operation: notAnOperation/);
  });

  it("drops a parser failure it does not know, whose message and body may hold the request body", () => {
    const failure = Object.assign(new SyntaxError(`Unexpected token in "${SECRET}"`), {
      type: "stream.encoding.set",
      body: SECRET,
    });

    const error = toBodyError(failure, 10);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Body parsing failed (stream.encoding.set)" });
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(Object.keys(error)).not.toContain("body");
  });

  it("matches a route template the way Express routes it", () => {
    const pattern = routePattern("/v1/checkouts/{checkoutId}/complete");

    for (const path of ["/v1/checkouts/chk_1/complete", "/V1/CHECKOUTS/chk_1/Complete/"]) {
      expect([path, pattern.test(path)]).toEqual([path, true]);
    }
    for (const path of [
      "/v1/checkouts/chk_1/x/complete",
      "/v1/checkouts//complete",
      "/v1/checkouts/chk_1/completed",
    ]) {
      expect([path, pattern.test(path)]).toEqual([path, false]);
    }
  });

  it("parses cookies and leaves requests without a bound operation unvalidated", async () => {
    const res = await request(api.server)
      .post("/__probe/unbound")
      .set("Cookie", "__Host-vx_csrf=abc; __Host-vx_at=tok%20en")
      .send({ anything: SECRET });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      body: { anything: SECRET },
      cookies: { "__Host-vx_csrf": "abc", "__Host-vx_at": "tok en" },
    });
  });
});

describe("the compiled document", () => {
  it("compiles every operation of the OTA document once per process", () => {
    const document = loadOpenApiDocument();

    expect(loadOpenApiDocument()).toBe(document);
    expect(document.operationList().map((operation) => operation.operationId)).toEqual(
      otaOperations.map((operation) => operation.operationId),
    );
    for (const operation of otaOperations) {
      expect(document.validator(operation.operationId).operation.path).toBe(operation.path);
    }
  });

  it("refuses an operation id the document does not have", () => {
    expect(() => loadOpenApiDocument().operation("notAnOperation")).toThrow(/no operation "notAnOperation"/);
  });
});
