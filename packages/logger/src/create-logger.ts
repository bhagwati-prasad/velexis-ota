import pino from "pino";
import { REDACT_CENSOR, REDACT_PATHS } from "./redact-paths.js";

export type Logger = pino.Logger;
export type LogLevel = pino.LevelWithSilent;

export interface CreateLoggerOptions {
  /** Process name, the `app` field of every line: `ota-api`, `ota-worker`, `platform-api`, `portal`, … */
  readonly app: string;
  /** `APP_ENV` of the process (`development`, `test` or `production`), the `env` field of every line. */
  readonly env: string;
  /** Lowest level written; `info` by default. */
  readonly level?: LogLevel | undefined;
  /** Where lines go. stdout by default, which systemd sends to journald; tests pass a memory stream. */
  readonly destination?: pino.DestinationStream | undefined;
}

/** What the `err` serializer keeps of an error and of each error in its `cause` chain. */
export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: SerializedError;
  errors?: SerializedError[];
}

/** Errors deeper than this in a `cause` chain are not logged. */
const MAX_CAUSE_DEPTH = 8;
/** At most this many entries of an `AggregateError` are logged. */
const MAX_AGGREGATE_ERRORS = 10;

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly stack?: unknown;
  readonly code?: unknown;
  readonly cause?: unknown;
  readonly errors?: unknown;
}

function errorType(error: object): string {
  const ctor: unknown = Object.getPrototypeOf(error)?.constructor;
  if (typeof ctor === "function" && ctor.name !== "") {
    return ctor.name;
  }
  const { name } = error as ErrorLike;
  return typeof name === "string" && name !== "" ? name : "Error";
}

function serializeErrorObject(error: object, depth: number, seen: Set<object>): SerializedError {
  seen.add(error);
  const { message, stack, code, cause, errors } = error as ErrorLike;
  const out: SerializedError = {
    type: errorType(error),
    message: typeof message === "string" ? message : "",
  };
  if (typeof stack === "string") {
    out.stack = stack;
  }
  if (typeof code === "string" || typeof code === "number") {
    out.code = code;
  }
  if (depth >= MAX_CAUSE_DEPTH) {
    return out;
  }
  if (cause !== undefined && cause !== null) {
    if (typeof cause === "object") {
      if (!seen.has(cause)) {
        out.cause = serializeErrorObject(cause, depth + 1, seen);
      }
    } else {
      // A cause that is not an object may be a raw response body: keep only its type.
      out.cause = { type: typeof cause, message: "" };
    }
  }
  if (Array.isArray(errors)) {
    const nested: SerializedError[] = [];
    for (const entry of errors.slice(0, MAX_AGGREGATE_ERRORS) as unknown[]) {
      if (typeof entry === "object" && entry !== null && !seen.has(entry)) {
        nested.push(serializeErrorObject(entry, depth + 1, seen));
      }
    }
    out.errors = nested;
  }
  return out;
}

/**
 * The `err` serializer. It keeps type, message, stack and `code` of the error and of every error in its
 * `cause` chain (and of the entries of an `AggregateError`), and nothing else: `body`, `data`, `request`,
 * `response`, `config`, `headers` and every other property are dropped, so an Amadeus or Stripe error
 * never carries a request or response body, which can hold card data, into a log line (ADR-0016).
 */
export function serializeError(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return serializeErrorObject(value, 0, new Set());
}

/** Serializer for an `error` key: the same rules as `err` for errors, other values unchanged. */
export function serializeErrorField(value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
}

interface RequestLike {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly url?: unknown;
  readonly originalUrl?: unknown;
  readonly baseUrl?: unknown;
  readonly route?: unknown;
}

/** The path of a request URL without its query string or fragment, which can carry signatures. */
export function pathOf(url: unknown): string | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * The route template of a request (`/v1/bookings/:bookingId`) once Express has matched it, otherwise
 * the request path without its query string.
 */
export function routeOf(req: object): string | undefined {
  const { route, baseUrl, originalUrl, url } = req as RequestLike;
  const template: unknown =
    typeof route === "object" && route !== null ? Reflect.get(route, "path") : undefined;
  if (typeof template === "string") {
    return (typeof baseUrl === "string" ? baseUrl : "") + template;
  }
  return pathOf(originalUrl ?? url);
}

/** `req` serializer: request id, method and route only, never headers, query strings or bodies. */
export function serializeRequest(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const { id, method } = value as RequestLike;
  return { id, method, route: routeOf(value) };
}

/** `res` serializer: the status code only, never headers or bodies. */
export function serializeResponse(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const status: unknown = Reflect.get(value, "statusCode");
  return { status: typeof status === "number" ? status : undefined };
}

/** The serializers of every Velexis logger; `pinoHttpOptions` installs the same ones. */
export const LOG_SERIALIZERS: Readonly<Record<"err" | "error" | "req" | "res", (value: unknown) => unknown>> =
  Object.freeze({
    err: serializeError,
    error: serializeErrorField,
    req: serializeRequest,
    res: serializeResponse,
  });

/**
 * Creates the pino logger of a process: JSON lines with the base fields `app` and `env`, ISO timestamps,
 * the serializers above and the central redaction list (ADR-0016).
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { app, env, level = "info", destination } = options;
  if (app.trim() === "") {
    throw new TypeError("createLogger: app must be a non-empty process name");
  }
  return pino(
    {
      level,
      base: { app, env },
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: { ...LOG_SERIALIZERS },
      redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    },
    destination,
  );
}
