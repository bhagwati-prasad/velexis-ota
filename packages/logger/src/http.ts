import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Options } from "pino-http";
import { LOG_SERIALIZERS, pathOf, routeOf, type Logger } from "./create-logger.js";

/** The request id header set by Caddy and returned in every response (ADR-0016). */
export const REQUEST_ID_HEADER = "x-request-id";

/** A client-supplied request id is kept only when it matches this pattern, as in the Caddyfile. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** Returns the incoming `X-Request-Id` when it is valid, otherwise a new random UUID. */
export function resolveRequestId(header: string | readonly string[] | undefined): string {
  return typeof header === "string" && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

/** `/health` and everything below it: the health checks poll often and are never logged. */
export function isHealthPath(url: unknown): boolean {
  const path = pathOf(url)?.toLowerCase();
  return path === "/health" || path?.startsWith("/health/") === true;
}

export interface PinoHttpOptionsInput {
  /** Process name; it must match the `app` of the logger when the logger has one. */
  readonly app: string;
  /** The process logger from `createLogger`. */
  readonly logger: Logger;
}

function originalUrlOf(req: IncomingMessage): unknown {
  // Express keeps the full URL in `originalUrl` and rewrites `url` inside routers.
  const originalUrl: unknown = Reflect.get(req, "originalUrl");
  return originalUrl ?? req.url;
}

function durationOf(value: unknown): number | undefined {
  const duration: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "durationMs") : undefined;
  return typeof duration === "number" ? duration : undefined;
}

function requestLine(req: IncomingMessage, res: ServerResponse, value: unknown): Record<string, unknown> {
  return { method: req.method, route: routeOf(req), status: res.statusCode, durationMs: durationOf(value) };
}

function loggerForApp(app: string, logger: Logger): Logger {
  const bound: unknown = logger.bindings()["app"];
  if (bound === undefined) {
    return logger.child({ app });
  }
  if (bound !== app) {
    throw new Error(`pinoHttpOptions: app "${app}" does not match the logger's app "${String(bound)}"`);
  }
  return logger;
}

/**
 * Options for `pino-http` (and `nestjs-pino`'s `pinoHttp`):
 * - keeps a valid incoming `X-Request-Id`, otherwise generates a UUID, and returns it in the response;
 * - binds `requestId` to `req.log`, so every line logged during the request carries it;
 * - logs one line per request with `method`, `route` (the template), `status` and `durationMs`;
 * - never logs headers, query strings or bodies, and never logs `/health/*`.
 */
export function pinoHttpOptions(input: PinoHttpOptionsInput): Options<IncomingMessage, ServerResponse> {
  return {
    logger: loggerForApp(input.app, input.logger),
    genReqId: (req, res) => {
      const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
      res.setHeader("X-Request-Id", requestId);
      return requestId;
    },
    customAttributeKeys: { reqId: "requestId", responseTime: "durationMs" },
    quietReqLogger: true,
    quietResLogger: true,
    wrapSerializers: false,
    serializers: { ...LOG_SERIALIZERS },
    autoLogging: { ignore: (req) => isHealthPath(originalUrlOf(req)) },
    customLogLevel: (_req, res, err) => (err !== undefined || res.statusCode >= 500 ? "error" : "info"),
    customSuccessObject: (req, res, value: unknown) => requestLine(req, res, value),
    customErrorObject: (req, res, err, value: unknown) => ({ ...requestLine(req, res, value), err }),
  };
}
