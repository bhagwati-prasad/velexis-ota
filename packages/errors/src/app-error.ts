// AppError: the one error class that backend code throws for an API error (conventions §6, task X-009). It takes
// a code of the generated catalogue, so only codes that a document's `x-error-catalogue` lists compile; the HTTP
// status and the default message come from the catalogue. toErrorEnvelope (envelope.ts) turns it into the API's
// error envelope. Pure TypeScript: each backend wraps it in its own NestJS exception filter.
import type { components } from "@velexis/api-types";
import { ERROR_CATALOGUE, type ErrorCatalogueEntry, type ErrorCode } from "./generated/catalogue.js";

/** One `fieldErrors[]` item of the envelope: `path` (a JSON pointer into the request), `code`, `message?`. */
export type FieldError = components["schemas"]["FieldError"];

/** The underlying Amadeus error of a supplier failure; the envelope shows it only in console scope. */
export type SupplierIssue = components["schemas"]["SupplierIssue"];

/**
 * The codes whose envelope may carry `fieldErrors`. `VALIDATION_FAILED` is the request validation of every
 * operation (conventions §6). The others are the codes the OTA document answers with `fieldErrors` in its
 * response examples, and that the SDK contract (docs/velexis-sdk/sdk/src/bookings.d.ts) documents with them:
 * traveller, contact and checkout data, and the password and e-mail checks of the customer account. A test keeps
 * this list in step with the document's examples. `new AppError(code, { fieldErrors })` does not compile when
 * `code` is any other literal code; a `code` typed as the whole `ErrorCode` union compiles, so toErrorEnvelope
 * also drops them at run time for every other code.
 */
export const FIELD_ERROR_CODES = Object.freeze([
  "VALIDATION_FAILED",
  "TRAVELER_DATA_INVALID",
  "CONTACT_DATA_INVALID",
  "CHECKOUT_INCOMPLETE",
  "EMAIL_ALREADY_REGISTERED",
  "PASSWORD_TOO_WEAK",
  "CURRENT_PASSWORD_INCORRECT",
] as const satisfies readonly ErrorCode[]);

/** A code whose envelope may carry `fieldErrors` (FIELD_ERROR_CODES). */
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

/** The options of `new AppError(code, options)`. Nothing here may hold a card number, a token or a password. */
export interface AppErrorOptions<C extends ErrorCode = ErrorCode> {
  /**
   * A human-readable message that is safe to show to the client. Default: the catalogue description of the code.
   * Never echo a rejected value: it may be a card number or a password.
   */
  readonly message?: string;
  /** Code-specific structured details, for example `newPrice` for `PRICE_CHANGED`. Ids and small values only. */
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * Per-field problems of a code of FIELD_ERROR_CODES (it does not compile for another literal code, and
   * toErrorEnvelope drops it for another code). Each `message` says what is wrong without the value.
   */
  readonly fieldErrors?: C extends FieldErrorCode ? readonly FieldError[] : never;
  /** The Amadeus error behind a supplier code; the envelope shows it only in console scope. */
  readonly supplier?: SupplierIssue;
  /** The underlying error, for the logs only. It never reaches the envelope. */
  readonly cause?: unknown;
}

/** True when `value` is a code of the catalogue (an own key of ERROR_CATALOGUE). */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CATALOGUE, value);
}

/** True when the envelope of `code` may carry `fieldErrors`. */
export function isFieldErrorCode(code: ErrorCode): code is FieldErrorCode {
  return (FIELD_ERROR_CODES as readonly ErrorCode[]).includes(code);
}

/** The HTTP status of a code, from the catalogue. */
export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CATALOGUE[code].status;
}

/** The catalogue entry of a code; a code from outside the catalogue (a JavaScript caller, a cast) throws. */
function entryOf(code: unknown): ErrorCatalogueEntry {
  if (!isErrorCode(code)) {
    throw new TypeError(
      `AppError: ${JSON.stringify(String(code).slice(0, 64))} is not a code of the error catalogue`,
    );
  }
  return ERROR_CATALOGUE[code];
}

/**
 * An API error with a catalogue code. `status` comes from the catalogue and `message` defaults to the catalogue
 * description:
 *
 *   throw new AppError("PRICE_CHANGED", { details: { newPrice } });
 *   throw new AppError("VALIDATION_FAILED", { fieldErrors: [{ path: "/email", code: "format", message: "Enter a valid e-mail address." }] });
 *
 * `new AppError("NOT_A_CODE")` does not compile. The `cause` is kept on the error for the logs; toErrorEnvelope
 * never returns it, nor the stack.
 */
export class AppError<C extends ErrorCode = ErrorCode> extends Error {
  override readonly name = "AppError";
  /** The catalogue code. */
  readonly code: C;
  /** The HTTP status of the code, from the catalogue. */
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly fieldErrors: readonly FieldError[] | undefined;
  readonly supplier: SupplierIssue | undefined;

  constructor(code: C, options: AppErrorOptions<C> = {}) {
    const entry = entryOf(code);
    super(
      options.message ?? entry.description,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.status = entry.status;
    this.details = options.details;
    this.fieldErrors = options.fieldErrors;
    this.supplier = options.supplier;
  }
}

/** True when `value` is an AppError. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
