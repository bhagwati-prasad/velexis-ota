// The idempotency interceptor (architecture §3 step 11, architecture-booking.md §5.1, OBE-014): global, registered in
// HttpModule after the OpenAPI validation interceptor, so it runs after the guards (the tenant and the actor are in
// the request context) and after validation (the key and the body are valid, and a refused request writes no
// record). It applies to every handler bound to an operation whose `Idempotency-Key` header parameter the document
// marks required, and to nothing else (the 501 routes of pending operations carry no operation binding). The records
// live in the tenant's schema: a request without a tenant (an anonymous caller, which only reaches a public or webhook
// route, never one of these operations outside test probes) cannot reach tenant data either, and passes through.
//
// - a missing key is `400 VALIDATION_FAILED` (`/header/Idempotency-Key`), as the validation interceptor answers it;
// - the service claims the key (idempotency.service.ts): a stored answer is replayed with its status, its replayed
//   headers, its cookies and its body, and the handler does not run;
// - otherwise the handler runs once, its lease renewed while it runs (`IdempotencyService.keepLease`, FIX-W30-OTA: a
//   handler slower than the 2-minute lease keeps it, so a same-key request waits for it and never runs it twice), and
//   its answer (or the error envelope the error filter will send) is settled once the renewals have ended: stored for
//   replays, or released when it is transient.
//
// Handlers of these operations return their body (with `@Res({ passthrough: true })` at most): an answer the handler
// wrote itself cannot be replayed, and its record is released.
import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { AppError, toErrorEnvelope } from "@velexis/errors";
import type { Request, Response } from "express";
import { PinoLogger } from "nestjs-pino";
import { defer, lastValueFrom, type Observable } from "rxjs";
import { fromHttpException } from "./error.filter";
import {
  EDGE_PRINCIPAL_COOKIE,
  IdempotencyService,
  type IdempotencyResponse,
  type IdempotentInput,
} from "./idempotency.service";
import { OPENAPI_OPERATION, VALIDATED_INPUT, type ValidatedInput } from "./openapi-operation.decorator";
import { RequestContext, requestIdOf } from "./request-context";

/** The request header, lower case as Node gives it. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * The response headers stored with an answer and set again on its replays: those the document gives the idempotent
 * operations, except `X-Request-Id` (each request has its own) and `Set-Cookie` (kept only in the ciphertext).
 */
export const REPLAYED_HEADERS = ["location", "etag", "cache-control", "retry-after"] as const;

/** The request after the validation interceptor ran. */
type ValidatedRequest = Request & { [VALIDATED_INPUT]?: ValidatedInput };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The `Idempotency-Key` of a request; a missing or empty one is `400 VALIDATION_FAILED`, without a value. */
export function idempotencyKeyOf(headers: Request["headers"]): string {
  const value = headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof value !== "string" || value === "") {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        { path: "/header/Idempotency-Key", code: "required", message: "Idempotency-Key is required" },
      ],
    });
  }
  return value;
}

/** The replayed headers that `res` has, by lower-case name. */
function replayedHeadersOf(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of REPLAYED_HEADERS) {
    const value = res.getHeader(name);
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return headers;
}

/** The `Set-Cookie` values that `res` has. */
function setCookieOf(res: Response): string[] {
  const value = res.getHeader("set-cookie");
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** Sends a stored answer: its status, headers and cookies on `res`; Nest sends the returned body. */
function applyReplay(res: Response, response: IdempotencyResponse): void {
  res.status(response.status);
  for (const [name, value] of Object.entries(response.headers)) {
    res.setHeader(name, value);
  }
  if (response.setCookie.length > 0) {
    res.append("Set-Cookie", [...response.setCookie]);
  }
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
    private readonly context: RequestContext,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(IdempotencyInterceptor.name);
  }

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operationId =
      execution.getType() === "http"
        ? this.reflector.get<OtaOperationId | undefined>(OPENAPI_OPERATION, execution.getHandler())
        : undefined;
    if (
      operationId === undefined ||
      !this.idempotency.isIdempotent(operationId) ||
      !this.idempotency.hasTenant()
    ) {
      return next.handle();
    }
    const http = execution.switchToHttp();
    return defer(() =>
      this.run(operationId, http.getRequest<ValidatedRequest>(), http.getResponse<Response>(), next),
    );
  }

  private async run(
    operationId: OtaOperationId,
    req: ValidatedRequest,
    res: Response,
    next: CallHandler,
  ): Promise<unknown> {
    const key = idempotencyKeyOf(req.headers);
    const validated = req[VALIDATED_INPUT];
    if (validated === undefined) {
      throw new Error(`${operationId}: the idempotency interceptor ran before the validation interceptor`);
    }
    const input: IdempotentInput = {
      path: isObject(validated.path) ? validated.path : {},
      query: isObject(validated.query) ? validated.query : {},
      body: validated.body,
    };
    const cookie: unknown = isObject(req.cookies) ? req.cookies[EDGE_PRINCIPAL_COOKIE] : undefined;
    const claim = await this.idempotency.claim({
      operationId,
      key,
      method: req.method,
      path: req.originalUrl.split("?", 1)[0] ?? req.originalUrl,
      input,
      csrfCookie: typeof cookie === "string" ? cookie : undefined,
    });
    if (claim.kind === "replay") {
      applyReplay(res, claim.response);
      return claim.response.body;
    }
    // The lease is renewed while the handler runs (FIX-W30-OTA), and the renewals end before the outcome is settled.
    const renewal = this.idempotency.keepLease(claim.ticket);
    let body: unknown;
    let failure: { readonly error: unknown } | undefined;
    try {
      body = await lastValueFrom(next.handle(), { defaultValue: undefined });
    } catch (error) {
      failure = { error };
    } finally {
      await renewal.stop();
    }
    if (failure !== undefined) {
      await this.idempotency.settle(claim.ticket, this.errorResponse(failure.error, req, res));
      throw failure.error;
    }
    if (res.headersSent) {
      this.logger.warn({ operationId }, "idempotency.answer_not_captured");
      await this.idempotency.release(claim.ticket);
      return body;
    }
    await this.idempotency.settle(claim.ticket, {
      status: res.statusCode,
      headers: replayedHeadersOf(res),
      setCookie: setCookieOf(res),
      body,
    });
    return body;
  }

  /** The answer the error filter sends for `error` (error.filter.ts), with its `Cache-Control: no-store`. */
  private errorResponse(error: unknown, req: Request, res: Response): IdempotencyResponse {
    const appError = error instanceof HttpException ? fromHttpException(error) : error;
    const requestId = this.context.requestId() ?? requestIdOf(req);
    const { status, body } = toErrorEnvelope(appError, requestId, {
      exposeSupplier: this.context.isConsoleScope(),
    });
    return {
      status,
      headers: { ...replayedHeadersOf(res), "cache-control": "no-store" },
      setCookie: setCookieOf(res),
      body,
    };
  }
}
