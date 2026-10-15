// The error half of the HTTP pipeline: every error leaves in the envelope of the OTA document, with the request id of
// the X-Request-Id header, no stack, and the supplier issue only in console scope. In process, with probe controllers
// bound to real operations (no PostgreSQL or Redis).
import {
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  ServiceUnavailableException,
  UnauthorizedException,
  type ArgumentsHost,
} from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { expectResponseToMatch } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp, type TestApp } from "../../../test/support/create-test-app";
import type { LogLine } from "../../../test/helpers/log-sink";
import { PublicRoute } from "../auth/caller.guard";
import { ErrorFilter, fromHttpException } from "./error.filter";
import { OpenApiOperation } from "./openapi-operation.decorator";
import type { RequestContext } from "./request-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUPPLIER = {
  provider: "amadeus" as const,
  status: 400,
  code: 477,
  title: "INVALID FORMAT",
  detail: "bad",
};
const BOOKING_ID = "bkg_01JA2Z9W5K7Q3M8N4P6R";

// Public: the envelope is rendered the same for every caller; the caller guard is common/auth/caller.guard.test.ts.
@Controller("__probe")
@PublicRoute()
class FailingController {
  @Get("type-error/:bookingId")
  @OpenApiOperation("getBooking")
  typeError(): never {
    throw new TypeError("Cannot read properties of undefined (reading 'secretCardNumber')");
  }

  @Get("supplier/customer/:bookingId")
  @OpenApiOperation("getBooking")
  supplierCustomer(): never {
    throw new AppError("SUPPLIER_REJECTED", { supplier: SUPPLIER, details: { errors: [] } });
  }

  @Get("supplier/console/:queueId")
  @OpenApiOperation("consoleListQueue")
  supplierConsole(): never {
    throw new AppError("SUPPLIER_REJECTED", { supplier: SUPPLIER, details: { errors: [] } });
  }

  @Get("timeout/:bookingId")
  @OpenApiOperation("getBooking")
  timeout(): never {
    throw new AppError("SUPPLIER_TIMEOUT", { cause: new Error("socket hang up") });
  }

  @Get("http/:status")
  http(@Param("status") status: string): never {
    switch (status) {
      case "401":
        throw new UnauthorizedException("Bearer token for anna.berg@example.com expired");
      case "404":
        throw new NotFoundException("Booking bkg_secret not found");
      case "418":
        throw new HttpException("teapot", 418);
      case "503":
        throw new ServiceUnavailableException();
      default:
        throw new HttpException("internal detail", 500);
    }
  }

  @Get("items/:id")
  item(@Param("id") id: string): object {
    return { id };
  }
}

let api: TestApp;

beforeAll(async () => {
  api = await createTestApp({ controllers: [FailingController] });
});

afterAll(async () => {
  await api.close();
});

/** The lines logged for one request id; pino-http writes its line when the response finishes. */
async function linesOf(requestId: string, msg: string): Promise<LogLine[]> {
  return vi.waitFor(() => {
    const lines = api.sink.records().filter((line) => line["requestId"] === requestId);
    expect(lines.map((line) => line["msg"])).toContain(msg);
    return lines;
  });
}

describe("error envelope", () => {
  it("answers a thrown TypeError with 500 INTERNAL_ERROR, the requestId and no stack [OBE-010 AC2]", async () => {
    const res = await request(api.server).get(`/__probe/type-error/${BOOKING_ID}`);

    const requestId = res.headers["x-request-id"];
    expect(requestId).toMatch(UUID);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected error; quote the requestId to support.",
        status: 500,
        requestId,
      },
    });
    expect(res.text).not.toMatch(/TypeError|secretCardNumber|stack|\.ts:\d+/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectResponseToMatch("getBooking", res);

    // The stack goes to the log, with the same request id.
    const lines = await linesOf(String(requestId), "http.unhandled_error");
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: "http.unhandled_error",
        err: expect.objectContaining({ type: "TypeError", stack: expect.stringContaining("TypeError") }),
      }),
    );
  });

  it("keeps a valid incoming X-Request-Id as the envelope's requestId [OBE-010 AC2]", async () => {
    const res = await request(api.server)
      .get(`/__probe/type-error/${BOOKING_ID}`)
      .set("X-Request-Id", "caddy-req-0042");

    expect(res.headers["x-request-id"]).toBe("caddy-req-0042");
    expect(res.body.error.requestId).toBe("caddy-req-0042");
  });

  it("shows the supplier issue in console scope only", async () => {
    const customer = await request(api.server).get(`/__probe/supplier/customer/${BOOKING_ID}`);
    const staff = await request(api.server).get("/__probe/supplier/console/3");

    expect(customer.status).toBe(422);
    expect(customer.body.error.code).toBe("SUPPLIER_REJECTED");
    expect(customer.body.error).not.toHaveProperty("supplier");
    expect(staff.status).toBe(422);
    expect(staff.body.error.supplier).toEqual(SUPPLIER);
    expectResponseToMatch("consoleListQueue", staff);
  });

  it("logs an AppError of status 500 and above with its code and cause, and answers with its code", async () => {
    const res = await request(api.server).get(`/__probe/timeout/${BOOKING_ID}`);

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("SUPPLIER_TIMEOUT");
    expect(res.text).not.toContain("socket hang up");
    expectResponseToMatch("getBooking", res);
    const lines = await linesOf(String(res.headers["x-request-id"]), "http.request_failed");
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 40,
        code: "SUPPLIER_TIMEOUT",
        status: 504,
        err: expect.objectContaining({ message: "socket hang up" }),
      }),
    );
  });

  it("answers Nest's HTTP exceptions with the catalogue code of their status and never their message", async () => {
    const answers = await Promise.all(
      ["401", "404", "418", "503", "500"].map((status) => request(api.server).get(`/__probe/http/${status}`)),
    );

    expect(answers.map((res) => [res.status, res.body.error.code])).toEqual([
      [401, "UNAUTHENTICATED"],
      [404, "NOT_FOUND"],
      [400, "INVALID_REQUEST"],
      [503, "SERVICE_UNAVAILABLE"],
      [500, "INTERNAL_ERROR"],
    ]);
    for (const res of answers) {
      expect(res.text).not.toMatch(/anna\.berg|bkg_secret|teapot|internal detail/);
      expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
    }
  });

  it("answers an unknown route with 404 NOT_FOUND in the envelope, without echoing the path", async () => {
    const res = await request(api.server).get("/v1/unknown-route-with-a-token-abc123");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The resource does not exist in this OTA or is not visible to the caller.",
        status: 404,
        requestId: res.headers["x-request-id"],
      },
    });
  });

  it("answers a path that Express cannot decode with 400 INVALID_REQUEST and an X-Request-Id", async () => {
    // The router fails before any middleware ran, pino-http included: the filter sets the header itself.
    const res = await request(api.server).get("/__probe/items/%E0%A4%A");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(res.headers["x-request-id"]).toMatch(UUID);
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("sends helmet's security headers on errors and successes", async () => {
    const error = await request(api.server).get("/v1/unknown");
    const ok = await request(api.server).get("/__probe/items/1");

    for (const res of [error, ok]) {
      expect(res.headers).toMatchObject({
        "content-security-policy": "default-src 'none';frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "strict-transport-security": "max-age=31536000",
      });
    }
  });
});

describe("fromHttpException", () => {
  it("maps statuses to catalogue codes and leaves server errors without a code of their own unknown", () => {
    expect(fromHttpException(new HttpException("x", 400))?.code).toBe("INVALID_REQUEST");
    expect(fromHttpException(new HttpException("x", 403))?.code).toBe("FORBIDDEN");
    expect(fromHttpException(new HttpException("x", 409))?.code).toBe("CONFLICT");
    expect(fromHttpException(new HttpException("x", 412))?.code).toBe("PRECONDITION_FAILED");
    expect(fromHttpException(new HttpException("x", 413))?.code).toBe("INVALID_REQUEST");
    expect(fromHttpException(new HttpException("x", 429))?.code).toBe("RATE_LIMITED");
    expect(fromHttpException(new HttpException("x", 501))?.code).toBe("NOT_IMPLEMENTED");
    expect(fromHttpException(new HttpException("x", 502))).toBeUndefined();
  });
});

describe("ErrorFilter without a request context", () => {
  function hostFor(res: object, req: object): ArgumentsHost {
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res, getNext: () => undefined }),
    } as unknown as ArgumentsHost;
  }

  const context = { requestId: () => undefined, isConsoleScope: () => false } as unknown as RequestContext;
  const logger = { setContext: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;

  it("takes the request id of pino-http from the request", () => {
    const res = {
      headersSent: false,
      getHeader: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(),
      json: vi.fn(),
    };
    res.status.mockReturnValue(res);

    new ErrorFilter(context, logger).catch(
      new AppError("NOT_FOUND"),
      hostFor(res, { id: "req-from-pino", headers: {} }),
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: "NOT_FOUND", requestId: "req-from-pino" }),
    });
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", "req-from-pino");
  });

  it("cuts the connection when the response has already started", () => {
    const res = { headersSent: true, destroy: vi.fn(), status: vi.fn(), json: vi.fn() };

    new ErrorFilter(context, logger).catch(new Error("late"), hostFor(res, { id: "r", headers: {} }));

    expect(res.destroy).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
