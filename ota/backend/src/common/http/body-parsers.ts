// Body parsing (architecture §3, step 2): the raw bytes on `/webhooks/*`, whose handlers verify the provider's
// signature on exactly what was sent; JSON with a 256 KB limit everywhere else; a smaller limit on the routes that
// `main.ts` names (`JSON_BODY_LIMITS`: the 10 KB of the airline-card route, OBE-051); and `multipart/form-data` on the
// routes `main.ts` names (`MULTIPART_BODY_LIMITS`: the asset upload, OBE-071) and nowhere else. Nest's own parsers are
// off (`bodyParser: false` in createApiApp), so these are the only ones, and they run after the request context, so a
// refused body is answered in the error envelope with the request id like any other error.
//
// A multipart route takes `multipart/form-data` only (another media type is `400 INVALID_REQUEST`, `details.reason =
// "unsupported_media_type"`; a body that does not parse is `malformed_multipart`). Its body is read into memory up to
// the route's limit and parsed by Node's own `Response.formData()` (undici, no extra dependency) into a
// `MultipartBody`: the parts in the order sent, a file part with the file name the client gave and its bytes (its
// declared `Content-Type` is not kept: the handler reads the type from the bytes). A body larger than the limit (a
// `Content-Length` above it, or more bytes than it as they arrive) is not read further, its rest discarded, and becomes
// a `MultipartBody` marked `tooLarge` without parts, for the handler to answer in its own terms (the upload's `422
// ASSET_INVALID`, `size`) after the guards. The validation interceptor passes the `MultipartBody` on as the validated
// body, so the idempotency hash covers the parts (OBE-071's `hashInput` hook), and the handler checks them.
import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { AppError, isAppError } from "@velexis/errors";
import express, { type Request, type RequestHandler, type Response } from "express";

/** The JSON body limit of every route without its own (architecture §3). */
export const JSON_BODY_LIMIT_BYTES = 256 * 1024;

/** The raw body limit of the webhook receivers; provider events are far smaller. */
export const WEBHOOK_BODY_LIMIT_BYTES = 512 * 1024;

/** Requests under this prefix get the raw body (a Buffer) instead of parsed JSON. */
export const WEBHOOK_PATH_PREFIX = "/webhooks/";

/** JSON body limits in bytes that differ from the default, by operation. */
export type JsonBodyLimits = Readonly<Partial<Record<OtaOperationId, number>>>;

/** The operations whose body is `multipart/form-data`, with the most bytes their body may have. */
export type MultipartBodyLimits = Readonly<Partial<Record<OtaOperationId, number>>>;

/** Options of the HTTP pipeline that the entry point decides (main.ts). */
export interface HttpPipelineOptions {
  /** Per-operation JSON body limits (`main.ts` `JSON_BODY_LIMITS`). */
  readonly jsonBodyLimits?: JsonBodyLimits | undefined;
  /** The multipart routes and their body limits (`main.ts` `MULTIPART_BODY_LIMITS`); no other route parses one. */
  readonly multipartBodyLimits?: MultipartBodyLimits | undefined;
}

/** A text part of a multipart body. */
export interface MultipartField {
  readonly type: "field";
  readonly name: string;
  readonly value: string;
}

/** A file part of a multipart body: its part name, the file name the client gave (may be empty) and its bytes. */
export interface MultipartFile {
  readonly type: "file";
  readonly name: string;
  readonly fileName: string;
  readonly bytes: Buffer;
}

export type MultipartPart = MultipartField | MultipartFile;

/**
 * A `multipart/form-data` body as the multipart parser hands it on (`req.body`, then the validated body): its parts
 * in the order sent, or none and `tooLarge` when the body was larger than `limitBytes` (see the file header).
 */
export class MultipartBody {
  constructor(
    readonly parts: readonly MultipartPart[],
    readonly tooLarge: boolean,
    readonly limitBytes: number,
  ) {}
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

/** The media type of a multipart route. */
const MULTIPART_TYPE = "multipart/form-data";

/** True when the request announces a body: a `Transfer-Encoding`, or a `Content-Length` above 0. */
function announcesBody(headers: Request["headers"]): boolean {
  const length = headers["content-length"];
  return headers["transfer-encoding"] !== undefined || (typeof length === "string" && Number(length) > 0);
}

/** `400 INVALID_REQUEST` of a multipart route, with `details.reason`. */
function multipartRefusal(reason: string, message: string): AppError {
  return new AppError("INVALID_REQUEST", { message, details: { reason } });
}

/**
 * The body's bytes, read up to `limitBytes`; `undefined` once more arrive, after which the rest is discarded. An
 * aborted or failed request is `400 INVALID_REQUEST` (`body_incomplete`).
 */
function readUpTo(req: Request, limitBytes: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onIncomplete);
      req.off("close", onClose);
      outcome();
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > limitBytes) {
        // Not read further: what is left is discarded as it arrives.
        finish(() => {
          req.resume();
          resolve(undefined);
        });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      finish(() => resolve(Buffer.concat(chunks, received)));
    };
    const onIncomplete = (): void => {
      finish(() => reject(multipartRefusal("body_incomplete", "The request body is incomplete.")));
    };
    const onClose = (): void => {
      if (!req.complete) {
        onIncomplete();
      }
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onIncomplete);
    req.on("close", onClose);
  });
}

/** The parts of a multipart body, in the order sent; `400 INVALID_REQUEST` (`malformed_multipart`) when it does not parse. */
async function partsOf(bytes: Buffer, contentType: string): Promise<MultipartPart[]> {
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw multipartRefusal("malformed_multipart", "The request body is not well-formed multipart/form-data.");
  }
  const parts: MultipartPart[] = [];
  for (const [name, value] of form.entries()) {
    parts.push(
      typeof value === "string"
        ? { type: "field", name, value }
        : { type: "file", name, fileName: value.name, bytes: Buffer.from(await value.arrayBuffer()) },
    );
  }
  return parts;
}

/**
 * The `MultipartBody` of a request to a multipart route (see the file header), or `undefined` when it sends no body.
 * Throws `400 INVALID_REQUEST` for another media type or encoding, a body that does not parse, or one cut short.
 */
export async function readMultipartBody(
  req: Request,
  limitBytes: number,
): Promise<MultipartBody | undefined> {
  if (!announcesBody(req.headers)) {
    return undefined;
  }
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || req.is(MULTIPART_TYPE) !== MULTIPART_TYPE) {
    throw multipartRefusal("unsupported_media_type", "The request body must be multipart/form-data.");
  }
  const encoding = req.headers["content-encoding"]?.trim().toLowerCase() ?? "identity";
  if (encoding !== "identity") {
    throw multipartRefusal("unsupported_encoding", "The request body uses an unsupported encoding.");
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limitBytes) {
    // Larger than the route allows: not read at all, discarded as it arrives.
    req.resume();
    return new MultipartBody([], true, limitBytes);
  }
  const bytes = await readUpTo(req, limitBytes);
  if (bytes === undefined) {
    return new MultipartBody([], true, limitBytes);
  }
  return new MultipartBody(await partsOf(bytes, contentType), false, limitBytes);
}

const multipartParser = (limitBytes: number): Parser => ({
  handler: (req, _res, next) => {
    readMultipartBody(req, limitBytes).then(
      (body) => {
        if (body !== undefined) {
          req.body = body;
        }
        next();
      },
      (error: unknown) => {
        next(error);
      },
    );
  },
  limitBytes,
});

/** One route with a parser of its own: its method and path matcher. */
interface RouteParser {
  readonly method: string;
  readonly pattern: RegExp;
  readonly parser: Parser;
}

/** The routes of `limits` (by operation) with the parser `build` makes for each limit; a wrong entry fails the start. */
function routeParsers(
  kind: string,
  limits: Readonly<Partial<Record<OtaOperationId, number>>> | undefined,
  build: (limitBytes: number) => Parser,
): RouteParser[] {
  return Object.entries(limits ?? {}).map(([operationId, limitBytes]) => {
    const operation = otaOperations.find((entry) => entry.operationId === operationId);
    if (operation === undefined) {
      throw new Error(`${kind} body limit for an unknown operation: ${operationId}`);
    }
    if (typeof limitBytes !== "number" || !Number.isInteger(limitBytes) || limitBytes <= 0) {
      throw new Error(`The ${kind} body limit of ${operationId} must be a positive number of bytes`);
    }
    return {
      method: operation.method.toUpperCase(),
      pattern: routePattern(operation.path),
      parser: build(limitBytes),
    };
  });
}

/**
 * Chooses the parser of each request: raw on `/webhooks/*`, multipart on the multipart routes, the route's own JSON
 * limit, or the default.
 */
@Injectable()
export class BodyParsersMiddleware implements NestMiddleware {
  private readonly json = jsonParser(JSON_BODY_LIMIT_BYTES);
  private readonly raw: Parser = {
    handler: express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT_BYTES }),
    limitBytes: WEBHOOK_BODY_LIMIT_BYTES,
  };
  private readonly overrides: readonly RouteParser[];

  constructor(@Inject(HTTP_PIPELINE_OPTIONS) options: HttpPipelineOptions) {
    // The multipart routes first: a route is multipart or JSON, never both.
    this.overrides = [
      ...routeParsers("multipart", options.multipartBodyLimits, multipartParser),
      ...routeParsers("JSON", options.jsonBodyLimits, jsonParser),
    ];
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
      // The multipart parser's refusals are AppErrors already; body-parser's errors are translated.
      next(
        error === undefined ? undefined : isAppError(error) ? error : toBodyError(error, parser.limitBytes),
      );
    });
  }
}
