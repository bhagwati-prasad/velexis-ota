import {
  BadRequestException,
  HttpException,
  MethodNotAllowedException,
  NotFoundException,
} from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { AppError, ERROR_CATALOGUE } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { appErrorOf, ErrorFilter } from "./error.filter";
import { PlatformOpenApi } from "./openapi-validation.interceptor";

const REQUEST_ID = "req-error-filter-0001";

interface Reply {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
  ended: boolean;
}

/** An HttpAdapterHost whose adapter records the reply. */
function adapterHost(reply: Reply, headersSent = false): HttpAdapterHost {
  return {
    httpAdapter: {
      isHeadersSent: () => headersSent,
      end: () => {
        reply.ended = true;
      },
      setHeader: (_res: unknown, name: string, value: string) => {
        reply.headers[name] = value;
      },
      reply: (_res: unknown, body: unknown, status: number) => {
        reply.status = status;
        reply.body = body;
      },
    },
  } as unknown as HttpAdapterHost;
}

let api: PlatformOpenApi;

beforeAll(() => {
  api = PlatformOpenApi.load();
});

/** Runs the filter on `exception` for a request with `req` fields; returns the reply and the logger's calls. */
function filter(
  exception: unknown,
  options: { req?: Record<string, unknown>; headersSent?: boolean } = {},
): Reply & { logged: unknown[][] } {
  const reply: Reply = { headers: {}, ended: false };
  const error = vi.fn();
  const logger = { error } as unknown as PinoLogger;
  const req = { id: REQUEST_ID, headers: {}, ...options.req };
  new ErrorFilter(adapterHost(reply, options.headersSent), api, logger).catch(
    exception,
    new ExecutionContextHost([req, {}, () => undefined]),
  );
  return { ...reply, logged: error.mock.calls };
}

describe("ErrorFilter", () => {
  it("[PBE-008 AC2] answers a thrown TypeError as 500 INTERNAL_ERROR with the requestId and no stack, and logs the stack", () => {
    const exception = new TypeError("Cannot read properties of undefined (reading 'secret-detail-1')");

    const reply = filter(exception);

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected error; quote the requestId to support.",
        status: 500,
        requestId: REQUEST_ID,
      },
    });
    expect(reply.headers).toEqual({ "X-Request-Id": REQUEST_ID });
    const answered = JSON.stringify(reply.body);
    expect(answered).not.toContain("secret-detail-1");
    expect(answered).not.toContain("TypeError");
    expect(answered).not.toMatch(/\bat .+\(.+:\d+:\d+\)/);
    expect(reply.logged).toEqual([[{ err: exception }, "http.unhandled_error"]]);
    expect(exception.stack).toMatch(/\bat /);
  });

  it("answers an AppError with its catalogue status and the platform document's message", () => {
    const reply = filter(new AppError("NOT_FOUND"));

    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The resource does not exist or is not visible to the caller.",
        status: 404,
        requestId: REQUEST_ID,
      },
    });
    // The OTA wording of the shared code is AppError's default; the platform answers its own.
    expect(ERROR_CATALOGUE.NOT_FOUND.description).not.toBe(api.errorMessage("NOT_FOUND"));
    expect(reply.logged).toEqual([]);
  });

  it("keeps a message an AppError was given, and its details and field errors", () => {
    const reply = filter(
      new AppError("VALIDATION_FAILED", {
        message: "Check the form.",
        details: { reason: "test" },
        fieldErrors: [{ path: "/email", code: "format", message: "Enter a valid e-mail address." }],
      }),
    );

    expect(reply.body).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Check the form.",
        status: 400,
        requestId: REQUEST_ID,
        details: { reason: "test" },
        fieldErrors: [{ path: "/email", code: "format", message: "Enter a valid e-mail address." }],
      },
    });
  });

  it("answers Nest's HTTP exceptions with the generic code of their status and never their message", () => {
    const unknownRoute = filter(new NotFoundException("Cannot GET /v1/nowhere?token=secret-value-2"));
    const badJson = filter(
      new BadRequestException('Unexpected token, "{"password":"secret-value-3" is not valid JSON'),
    );
    const throttled = filter(new HttpException("ThrottlerException: Too Many Requests", 429));
    const method = filter(new MethodNotAllowedException());

    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.body).toMatchObject({ error: { code: "NOT_FOUND", requestId: REQUEST_ID } });
    expect(badJson.status).toBe(400);
    expect(badJson.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(throttled.status).toBe(429);
    expect(throttled.body).toMatchObject({
      error: { code: "RATE_LIMITED", message: "Too many requests; try again after the time in Retry-After." },
    });
    expect(method.body).toMatchObject({ error: { code: "VALIDATION_FAILED", status: 400 } });
    const answered = JSON.stringify([unknownRoute.body, badJson.body, throttled.body, method.body]);
    expect(answered).not.toContain("secret-value");
    expect(answered).not.toContain("Cannot GET");
    expect([...unknownRoute.logged, ...badJson.logged, ...throttled.logged]).toEqual([]);
  });

  it("logs server errors: an HTTP exception of 5xx as unhandled, an AppError of 5xx with its code", () => {
    const gateway = new HttpException("upstream", 502);
    const unavailable = new AppError("SERVICE_UNAVAILABLE", { cause: new Error("redis down") });

    const first = filter(gateway);
    const second = filter(unavailable);

    expect(first.status).toBe(500);
    expect(first.body).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(first.logged).toEqual([[{ err: gateway }, "http.unhandled_error"]]);
    expect(second.status).toBe(503);
    expect(second.body).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(second.logged).toEqual([[{ err: unavailable, code: "SERVICE_UNAVAILABLE" }, "http.server_error"]]);
    expect(JSON.stringify(second.body)).not.toContain("redis down");
  });

  it("takes the request id from a valid X-Request-Id when pino-http has not run, else makes one", () => {
    const fromHeader = filter(new AppError("NOT_FOUND"), {
      req: { id: undefined, headers: { "x-request-id": "req-from-caddy-01" } },
    });
    const generated = filter(new AppError("NOT_FOUND"), {
      req: { id: undefined, headers: { "x-request-id": "<bad>" } },
    });

    expect(fromHeader.body).toMatchObject({ error: { requestId: "req-from-caddy-01" } });
    expect(fromHeader.headers["X-Request-Id"]).toBe("req-from-caddy-01");
    expect(generated.headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("only ends a response whose headers are already sent", () => {
    const reply = filter(new TypeError("late failure"), { headersSent: true });

    expect(reply.ended).toBe(true);
    expect(reply.status).toBeUndefined();
    expect(reply.logged).toHaveLength(1);
  });
});

describe("appErrorOf", () => {
  it("maps Nest's exceptions by status and leaves anything else unknown", () => {
    const appError = new AppError("CONFLICT");

    expect(appErrorOf(appError)).toBe(appError);
    expect(appErrorOf(new HttpException("x", 401))?.code).toBe("UNAUTHENTICATED");
    expect(appErrorOf(new HttpException("x", 403))?.code).toBe("FORBIDDEN");
    expect(appErrorOf(new HttpException("x", 412))?.code).toBe("PRECONDITION_FAILED");
    expect(appErrorOf(new HttpException("x", 503))?.code).toBe("SERVICE_UNAVAILABLE");
    expect(appErrorOf(new HttpException("x", 413))?.code).toBe("VALIDATION_FAILED");
    expect(appErrorOf(new HttpException("x", 500))?.code).toBe("INTERNAL_ERROR");
    expect(appErrorOf(new TypeError("x"))).toBeUndefined();
    expect(appErrorOf("a string")).toBeUndefined();
  });
});
