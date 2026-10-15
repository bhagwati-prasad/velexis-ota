// The error filter of the platform API (platform/docs/architecture.md §3 step 12, conventions §6). Every error answer
// is the envelope of `toErrorEnvelope` from @velexis/errors, with the request id in the body and in `X-Request-Id`:
//
// - an AppError answers its catalogue status and code;
// - Nest's own HTTP exceptions (an unknown route, a malformed path, a guard's 401 or 403, the throttler's 429) answer
//   the generic code of their status, never their message, which may quote the request;
// - anything else is `500 INTERNAL_ERROR`, logged with its stack and never answered with it.
//
// A code that both catalogues list keeps the OTA document's description as AppError's default message
// (packages/errors/README.md); the filter answers the platform document's description instead, so platform clients
// never read OTA wording. A message an AppError was given on purpose is kept.
import { Catch, HttpException, Injectable, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { AppError, ERROR_CATALOGUE, isAppError, toErrorEnvelope, type ErrorCode } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PlatformOpenApi } from "./openapi-validation.interceptor";
import { requestIdOf } from "./request-context";

/** The generic code of each status Nest's own HTTP exceptions use (conventions §6). */
const CODE_OF_STATUS: Readonly<Record<number, ErrorCode>> = Object.freeze({
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  412: "PRECONDITION_FAILED",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
  503: "SERVICE_UNAVAILABLE",
});

/**
 * The AppError a thrown value is answered as: itself, the generic code of a Nest HTTP exception (another 4xx is a bad
 * request, another 5xx an internal error), or `undefined` for anything else.
 */
export function appErrorOf(exception: unknown): AppError | undefined {
  if (isAppError(exception)) {
    return exception;
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code =
      CODE_OF_STATUS[status] ?? (status >= 400 && status < 500 ? "VALIDATION_FAILED" : "INTERNAL_ERROR");
    return new AppError(code);
  }
  return undefined;
}

/** The parts of the request and response the filter uses. */
interface HttpRequest {
  readonly id?: unknown;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

@Catch()
@Injectable()
export class ErrorFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly api: PlatformOpenApi,
    @InjectPinoLogger(ErrorFilter.name) private readonly logger: PinoLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res: unknown = http.getResponse();
    const requestId = requestIdOf(req);
    const appError = appErrorOf(exception);
    const { status, body } = toErrorEnvelope(appError, requestId, { exposeSupplier: false });

    if (appError === undefined || (exception instanceof HttpException && status >= 500)) {
      // `err` keeps type, message, stack, code and the cause chain, never request or response bodies.
      this.logger.error({ err: exception }, "http.unhandled_error");
    } else if (status >= 500) {
      this.logger.error({ err: exception, code: appError.code }, "http.server_error");
    }

    const error = body.error;
    const platformMessage = this.api.errorMessage(error.code);
    if (
      platformMessage !== undefined &&
      error.message === ERROR_CATALOGUE[error.code as ErrorCode].description
    ) {
      error.message = platformMessage;
    }

    const { httpAdapter } = this.adapterHost;
    if (httpAdapter.isHeadersSent(res)) {
      // The answer has started: nothing can be added to it. The error is logged above when it is a server error.
      httpAdapter.end(res);
      return;
    }
    httpAdapter.setHeader(res, "X-Request-Id", requestId);
    httpAdapter.reply(res, body, status);
  }
}
