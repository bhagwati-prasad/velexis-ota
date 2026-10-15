// Body parsing (architecture §3, step 2): the raw bytes on `/webhooks/*`, whose handlers verify the provider's
// signature on exactly what was sent; JSON with a 256 KB limit everywhere else; a smaller limit on the routes that
// `main.ts` names (`JSON_BODY_LIMITS`: the 10 KB of the airline-card route, OBE-051). Nest's own parsers are off
// (`bodyParser: false` in createApiApp), so these are the only ones, and they run after the request context, so a
// refused body is answered in the error envelope with the request id like any other error.
import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { AppError } from "@velexis/errors";
import express, { type Request, type RequestHandler, type Response } from "express";

/** The JSON body limit of every route without its own (architecture §3). */
export const JSON_BODY_LIMIT_BYTES = 256 * 1024;

/** The raw body limit of the webhook receivers; provider events are far smaller. */
export const WEBHOOK_BODY_LIMIT_BYTES = 512 * 1024;

/** Requests under this prefix get the raw body (a Buffer) instead of parsed JSON. */
export const WEBHOOK_PATH_PREFIX = "/webhooks/";

/** JSON body limits in bytes that differ from the default, by operation. */
export type JsonBodyLimits = Readonly<Partial<Record<OtaOperationId, number>>>;

/** Options of the HTTP pipeline that the entry point decides (main.ts). */
export interface HttpPipelineOptions {
  /** Per-operation JSON body limits (`main.ts` `JSON_BODY_LIMITS`). */
  readonly jsonBodyLimits?: JsonBodyLimits | undefined;
}

/** Injection token of the `HttpPipelineOptions`. */
export const HTTP_PIPELINE_OPTIONS = Symbol("HTTP_PIPELINE_OPTIONS");

/** The JSON media types the parser reads: `application/json` and `application/*+json`. */
const JSON_TYPES = ["application/json", "application/*+json"];

/**
 * A matcher of a document path template on the request path, with Express' defaults: case-insensitive, an optional
 * trailing slash, one segment per parameter. It must match every URL the router sends to the route, or a request could
 * reach the route with the default limit.
 */
export function routePattern(template: string): RegExp {
  const segments = template
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) =>
      /^\{[^}]+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
  return new RegExp(`^/${segments.join("/")}/?$`, "i");
}

/** The path of a request URL, without the query string. */
function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** The error body-parser reports (http-errors): its `type` names the failure. */
function failureType(error: unknown): string | undefined {
  const type: unknown = error !== null && typeof error === "object" ? Reflect.get(error, "type") : undefined;
  return typeof type === "string" ? type : undefined;
}

/**
 * A parser failure as an `AppError` (`400 INVALID_REQUEST` with `details.reason`), so the client gets the envelope and
 * never a message of the parser, which may quote the body. Other failures (of the server itself) become a plain
 * `Error` naming the parser's failure type, a `500 INTERNAL_ERROR`: the parser's own error is dropped, because its
 * message and its `body` property can hold the request body, which must not reach the log either.
 */
export function toBodyError(error: unknown, limitBytes: number): AppError | Error {
  const type = failureType(error) ?? "unknown failure";
  switch (type) {
    case "entity.parse.failed":
      return new AppError("INVALID_REQUEST", {
        message: "The request body is not valid JSON.",
        details: { reason: "malformed_json" },
      });
    case "entity.too.large":
      return new AppError("INVALID_REQUEST", {
        message: `The request body is larger than ${limitBytes} bytes.`,
        details: { reason: "body_too_large", limitBytes },
      });
    case "encoding.unsupported":
    case "charset.unsupported":
      return new AppError("INVALID_REQUEST", {
        message: "The request body uses an unsupported encoding.",
        details: { reason: "unsupported_encoding" },
      });
    case "request.size.invalid":
    case "request.aborted":
      return new AppError("INVALID_REQUEST", {
        message: "The request body is incomplete.",
        details: { reason: "body_incomplete" },
      });
    default:
      return new Error(`Body parsing failed (${type})`);
  }
}

interface Parser {
  readonly handler: RequestHandler;
  readonly limitBytes: number;
}

const jsonParser = (limitBytes: number): Parser => ({
  handler: express.json({ limit: limitBytes, type: JSON_TYPES, strict: true }),
  limitBytes,
});

/** Chooses the parser of each request: raw on `/webhooks/*`, the route's own JSON limit, or the default. */
@Injectable()
export class BodyParsersMiddleware implements NestMiddleware {
  private readonly json = jsonParser(JSON_BODY_LIMIT_BYTES);
  private readonly raw: Parser = {
    handler: express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT_BYTES }),
    limitBytes: WEBHOOK_BODY_LIMIT_BYTES,
  };
  private readonly overrides: ReadonlyArray<{ method: string; pattern: RegExp; parser: Parser }>;

  constructor(@Inject(HTTP_PIPELINE_OPTIONS) options: HttpPipelineOptions) {
    const limits = Object.entries(options.jsonBodyLimits ?? {});
    this.overrides = limits.map(([operationId, limitBytes]) => {
      const operation = otaOperations.find((entry) => entry.operationId === operationId);
      if (operation === undefined) {
        throw new Error(`JSON body limit for an unknown operation: ${operationId}`);
      }
      if (typeof limitBytes !== "number" || !Number.isInteger(limitBytes) || limitBytes <= 0) {
        throw new Error(`The JSON body limit of ${operationId} must be a positive number of bytes`);
      }
      return {
        method: operation.method.toUpperCase(),
        pattern: routePattern(operation.path),
        parser: jsonParser(limitBytes),
      };
    });
  }

  /** The parser of a request: exported for the tests. */
  parserFor(method: string, url: string): Parser {
    const path = pathOf(url);
    if (path.toLowerCase().startsWith(WEBHOOK_PATH_PREFIX)) {
      return this.raw;
    }
    const override = this.overrides.find(
      (entry) => entry.method === method.toUpperCase() && entry.pattern.test(path),
    );
    return override?.parser ?? this.json;
  }

  use(req: Request, res: Response, next: (error?: unknown) => void): void {
    const parser = this.parserFor(req.method, req.originalUrl);
    void parser.handler(req, res, (error?: unknown) => {
      next(error === undefined ? undefined : toBodyError(error, parser.limitBytes));
    });
  }
}
