// JSON body parsing of the platform API (platform/docs/architecture.md §3, step 2). The API reads JSON bodies only.
// Nest's own body parser is off (main.ts) and this middleware runs instead, after pino-http and before the request
// context (`API_REQUEST_MIDDLEWARE`), so a body that cannot be read still gets a request log line and an error
// envelope with the request id.
//
// The raw bytes are kept only for `/webhooks/*` (Express's `verify` callback), where the Stripe signature is checked
// on the exact body Stripe signed (PBE-042). Nowhere else is a copy of a body kept: it may hold a password.
//
// A body that cannot be read answers `400 VALIDATION_FAILED` with one field error on the body (path `""`), whose
// message never quotes the body: the JSON parser's own message would (`Unexpected token … "{"password":…`).
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, type FieldError } from "@velexis/errors";
import { json } from "express";

/** The path prefix of the Stripe webhook receivers, whose raw body is kept. */
export const WEBHOOK_PATH_PREFIX = "/webhooks/";
/** The largest JSON body of an API operation. */
export const JSON_BODY_LIMIT = "100kb";
/** The largest webhook body (Stripe events with many invoice lines are larger than API bodies). */
export const WEBHOOK_BODY_LIMIT = "1mb";

/** A request after the body parser: `rawBody` exists only on `/webhooks/*`. */
export interface RawBodyRequest extends IncomingMessage {
  rawBody?: Buffer;
  body?: unknown;
}

/** True when the request path (without the query string) is below `/webhooks/`. */
export function isWebhookPath(url: string | undefined): boolean {
  const path = (url ?? "").split("?", 1)[0] ?? "";
  return path.startsWith(WEBHOOK_PATH_PREFIX);
}

/** Express keeps the full URL in `originalUrl` and rewrites `url` inside mounted middleware. */
function originalUrlOf(req: IncomingMessage): string | undefined {
  const originalUrl: unknown = Reflect.get(req, "originalUrl");
  return typeof originalUrl === "string" ? originalUrl : req.url;
}

/**
 * The raw body of a webhook request, exactly as received; `undefined` on any other path or when the request had no
 * JSON body.
 */
export function rawBodyOf(req: IncomingMessage): Buffer | undefined {
  const raw: unknown = Reflect.get(req, "rawBody");
  return Buffer.isBuffer(raw) ? raw : undefined;
}

// Compressed bodies are refused (`inflate: false`): no client of the API compresses, and inflating would let a small
// request grow before the limit applies. `strict`: only objects and arrays, as every request body of the document is.
const apiJson = json({ limit: JSON_BODY_LIMIT, inflate: false, strict: true });
const webhookJson = json({
  limit: WEBHOOK_BODY_LIMIT,
  inflate: false,
  strict: true,
  verify: (req, _res, buf) => {
    (req as RawBodyRequest).rawBody = buf;
  },
});

/** The field error for a body-parser error, by its `type`; `undefined` for a server-side failure. */
function fieldErrorFor(error: unknown): FieldError | undefined {
  const type: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "type") : undefined;
  const status: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined;
  switch (type) {
    case "entity.parse.failed":
      return { path: "", code: "json", message: "The request body is not valid JSON." };
    case "entity.too.large":
      return { path: "", code: "maxSize", message: "The request body is too large." };
    case "encoding.unsupported":
    case "charset.unsupported":
      return {
        path: "",
        code: "encoding",
        message: "The request body must be uncompressed JSON in UTF-8.",
      };
    default:
      // Other client-side failures (an aborted request, a length that does not match `Content-Length`).
      return typeof status === "number" && status >= 400 && status < 500
        ? { path: "", code: "body", message: "The request body could not be read." }
        : undefined;
  }
}

/**
 * The JSON body parser of the API: `apiJson` (100 KB) everywhere, `webhookJson` (1 MB, raw body kept) on
 * `/webhooks/*`. A client-side failure becomes `400 VALIDATION_FAILED`; the parser's error, whose message may quote
 * the body, is dropped.
 */
export function jsonBodyParser(
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  const parser = isWebhookPath(originalUrlOf(req)) ? webhookJson : apiJson;
  parser(req, res, (error?: unknown) => {
    if (error === undefined || error === null) {
      next();
      return;
    }
    const fieldError = fieldErrorFor(error);
    next(fieldError === undefined ? error : new AppError("VALIDATION_FAILED", { fieldErrors: [fieldError] }));
  });
}
