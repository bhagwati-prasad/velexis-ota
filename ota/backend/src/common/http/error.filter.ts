// The error filter (architecture §3, step 13; conventions §6): every error of the API leaves in the one envelope of
// the OTA document, `{ error: { code, message, status, requestId, details?, fieldErrors?, supplier? } }`, built by
// `toErrorEnvelope` of @velexis/errors.
//
// - An `AppError` keeps its catalogue code and status. Its `supplier` issue (the raw Amadeus error) is shown only when
//   the request is in console scope (RequestContext), never to a customer.
// - Nest's own HTTP exceptions (the router's 404, a malformed path parameter) become the catalogue code of their
//   status, with the catalogue's message: Nest's messages may quote the request.
// - Anything else is `500 INTERNAL_ERROR` with the generic message and the `requestId`; the error and its stack go to
//   the log, never to the client.
//
// The filter is global (`APP_FILTER` in http.module.ts), so it also answers errors of middleware (body parsing) and
// of Express' router.
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { AppError, isAppError, toErrorEnvelope, type OtaErrorCode } from "@velexis/errors";
import type { Request, Response } from "express";
import { PinoLogger } from "nestjs-pino";
import { RequestContext, requestIdOf } from "./request-context";

/**
 * The OTA catalogue code of a Nest `HttpException` status (never a platform-only code: this API answers with its own
 * document's catalogue); other 4xx statuses are `INVALID_REQUEST`.
 */
const HTTP_STATUS_CODES: Readonly<Record<number, OtaErrorCode>> = {
  400: "INVALID_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "NOT_FOUND",
  409: "CONFLICT",
  412: "PRECONDITION_FAILED",
  429: "RATE_LIMITED",
  501: "NOT_IMPLEMENTED",
  503: "SERVICE_UNAVAILABLE",
};

/**
 * The `AppError` a Nest `HttpException` stands for, or `undefined` for a status of 500 and above that has no code of
 * its own (it is then an unknown error). Only the status is used.
 */
export function fromHttpException(exception: HttpException): AppError | undefined {
  const status = exception.getStatus();
  const code = HTTP_STATUS_CODES[status] ?? (status >= 400 && status < 500 ? "INVALID_REQUEST" : undefined);
  return code === undefined ? undefined : new AppError(code, { cause: exception });
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(
    private readonly context: RequestContext,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ErrorFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const error = exception instanceof HttpException ? fromHttpException(exception) : exception;
    const requestId = this.context.requestId() ?? requestIdOf(req);
    const { status, body } = toErrorEnvelope(error, requestId, {
      exposeSupplier: this.context.isConsoleScope(),
    });

    if (!isAppError(error)) {
      this.logger.error({ err: exception }, "http.unhandled_error");
    } else if (status >= 500) {
      this.logger.warn({ code: error.code, status, err: error.cause }, "http.request_failed");
    }

    if (res.headersSent) {
      // Part of the answer is on its way; the only safe end is to cut the connection.
      res.destroy();
      return;
    }
    // pino-http sets X-Request-Id; an error raised before it ran (a path Express cannot decode) gets it here.
    if (res.getHeader("X-Request-Id") === undefined) {
      res.setHeader("X-Request-Id", requestId);
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(status).json(body);
  }
}
