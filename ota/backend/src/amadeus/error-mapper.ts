// Amadeus errors → API error codes (OADR-0001 point 8, flows/amadeus-connection-and-tokens.md §5; OBE-018). The table
// below is the initial one of flow §5, a unit-tested constant (error-mapper.test.ts); M2 confirms it against recorded
// fixtures of the Amadeus test environment.
//
//   Amadeus                                                 API code
//   timeout of the client                                   504 SUPPLIER_TIMEOUT   ("may have happened" for writes)
//   connection reset while waiting for the answer           504 SUPPLIER_TIMEOUT
//   any other network error (refused, DNS)                  503 SUPPLIER_UNAVAILABLE
//   HTTP 502, 503                                           503 SUPPLIER_UNAVAILABLE
//   HTTP 504 (Amadeus's gateway gave up)                    504 SUPPLIER_TIMEOUT
//   HTTP 500 (141 SYSTEM ERROR) and any other 5xx           502 SUPPLIER_ERROR
//   HTTP 429 (the shared quota; the buckets are too large)  503 SUPPLIER_UNAVAILABLE (the client logs an ops alert)
//   34651 segment sell failure                              409 SOLD_OUT
//   37200 price discrepancy                                 409 PRICE_CHANGED
//   2552 simultaneous update                                409 VERSION_CONFLICT
//   9112 ticketing                                          502 TICKETING_FAILED
//   1304 credit card not accepted (form of payment)         402 PAYMENT_DECLINED   (airline card only)
//   4926 invalid data, 32171 mandatory data missing,
//     with a `source.pointer` into `/data/travelers`        422 TRAVELER_DATA_INVALID (fieldErrors from the pointers)
//     otherwise                                             422 SUPPLIER_REJECTED
//   HTTP 403 (an office Amadeus refuses, e.g. Queue List)   403 OFFICE_NOT_ALLOWED
//   HTTP 401 (after the client's one retry with a new token) 502 SUPPLIER_ERROR
//   any other 4xx                                           422 SUPPLIER_REJECTED
//   anything else (another status, a 2xx that is not JSON)  502 SUPPLIER_ERROR
//
// The codes of the table apply to `4xx` answers, the first issue with a code of the table deciding. The first issue
// of the answer is kept in `error.supplier`, which the error filter shows in console scope only (conventions §6); all
// issues stay on the error's cause (`AmadeusCallError.issues`) for the console's raw calls, which return them in
// `details.errors`. Neither the message nor the cause quotes a request or response body: the logs keep the cause's
// name, message and code only (@velexis/logger's `err` serializer).
import { AppError, type FieldError, type OtaErrorCode, type SupplierIssue } from "@velexis/errors";

/** `supplier_requests.outcome`. */
export type AmadeusOutcome = "success" | "client_error" | "server_error" | "timeout" | "network_error";

/** One entry of an Amadeus `errors` (or `warnings`) array, the specifications' `Issue`. */
export interface AmadeusIssue {
  readonly status?: number;
  readonly code?: number;
  readonly title?: string;
  readonly detail?: string;
  readonly source?: { readonly pointer?: string; readonly parameter?: string; readonly example?: string };
}

/** How a call failed, as the client saw it. */
export type AmadeusFailure =
  /** The client's timeout (AbortController) fired before the answer was complete. */
  | { readonly kind: "timeout" }
  /** `fetch` failed: `code` is the socket error of its cause (`ECONNRESET`, `ECONNREFUSED`, …). */
  | { readonly kind: "network"; readonly code?: string | undefined }
  /** Amadeus answered with a status that is not 2xx; `issues` is its `errors` array (empty when it had none). */
  | { readonly kind: "http"; readonly status: number; readonly issues: readonly AmadeusIssue[] };

/** Amadeus canned-message codes with a code of their own (flow §5). */
export const AMADEUS_ERROR_CODES = Object.freeze({
  segmentSellFailure: 34651,
  priceDiscrepancy: 37200,
  simultaneousUpdate: 2552,
  ticketing: 9112,
  creditCardNotAccepted: 1304,
  invalidData: 4926,
  mandatoryDataMissing: 32171,
  systemError: 141,
} as const);

/** The codes of the table that decide the API code of a `4xx` answer by themselves. */
export const AMADEUS_CODE_TABLE: Readonly<Record<number, OtaErrorCode>> = Object.freeze({
  [AMADEUS_ERROR_CODES.segmentSellFailure]: "SOLD_OUT",
  [AMADEUS_ERROR_CODES.priceDiscrepancy]: "PRICE_CHANGED",
  [AMADEUS_ERROR_CODES.simultaneousUpdate]: "VERSION_CONFLICT",
  [AMADEUS_ERROR_CODES.ticketing]: "TICKETING_FAILED",
  [AMADEUS_ERROR_CODES.creditCardNotAccepted]: "PAYMENT_DECLINED",
});

/** The data codes that become `TRAVELER_DATA_INVALID` when they point at a traveller, else `SUPPLIER_REJECTED`. */
export const AMADEUS_DATA_CODES: Readonly<Record<number, FieldError["code"]>> = Object.freeze({
  [AMADEUS_ERROR_CODES.invalidData]: "invalid",
  [AMADEUS_ERROR_CODES.mandatoryDataMissing]: "required",
});

/** The API code of an HTTP status that no issue code decided. */
export function codeForStatus(status: number): OtaErrorCode {
  if (status === 502 || status === 503 || status === 429) {
    return "SUPPLIER_UNAVAILABLE";
  }
  if (status === 504) {
    return "SUPPLIER_TIMEOUT";
  }
  if (status === 403) {
    return "OFFICE_NOT_ALLOWED";
  }
  if (status >= 400 && status < 500 && status !== 401) {
    return "SUPPLIER_REJECTED";
  }
  return "SUPPLIER_ERROR";
}

/** The `supplier_requests.outcome` of a failure. */
export function outcomeOf(failure: AmadeusFailure): AmadeusOutcome {
  switch (failure.kind) {
    case "timeout":
      return "timeout";
    case "network":
      return "network_error";
    case "http":
      // A 4xx is the request's fault; anything else (a 5xx, an unreadable 2xx) the supplier's.
      return failure.status >= 400 && failure.status < 500 ? "client_error" : "server_error";
  }
}

/** Socket errors that cut an answer off after the request may have reached Amadeus: treated as a timeout (flow §5). */
const RESET_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ECONNABORTED"]);

/** The `code`s of the issues, in order, without duplicates (`supplier_requests.error_codes`). */
export function errorCodesOf(issues: readonly AmadeusIssue[]): number[] {
  const codes = issues.map((issue) => issue.code).filter((code): code is number => Number.isInteger(code));
  return [...new Set(codes)];
}

/** A copy of the fields of the OTA document's `SupplierIssue`, with their types. */
export function supplierIssueOf(issue: AmadeusIssue, status: number): SupplierIssue {
  const copy: SupplierIssue = {
    provider: "amadeus",
    status: typeof issue.status === "number" && Number.isInteger(issue.status) ? issue.status : status,
  };
  if (typeof issue.code === "number" && Number.isInteger(issue.code)) {
    copy.code = issue.code;
  }
  if (typeof issue.title === "string") {
    copy.title = issue.title;
  }
  if (typeof issue.detail === "string") {
    copy.detail = issue.detail;
  }
  const source = issue.source;
  if (typeof source === "object" && source !== null) {
    const copied: NonNullable<SupplierIssue["source"]> = {};
    for (const key of ["pointer", "parameter", "example"] as const) {
      if (typeof source[key] === "string") {
        copied[key] = source[key];
      }
    }
    copy.source = copied;
  }
  return copy;
}

/**
 * The OTA path of an Amadeus pointer into the travellers of a request (`/data/travelers/0/documents/0/number`, also
 * written `/data/travelers[0]/…`): `/travelers/0/documents/0/number`. `undefined` for a pointer anywhere else.
 */
export function travelerPath(pointer: unknown): string | undefined {
  if (typeof pointer !== "string") {
    return undefined;
  }
  const normalised = pointer.replace(/\[(\d+)\]/g, "/$1");
  const match = /^\/data(\/travelers(?:\/.*)?)$/.exec(normalised);
  return match?.[1];
}

/** The cause of a mapped error: what failed, for the logs (name, message, code), and every issue for the console. */
export class AmadeusCallError extends Error {
  override readonly name = "AmadeusCallError";
  /** The Amadeus HTTP status, or `undefined` without an answer. */
  readonly httpStatus: number | undefined;
  /** The socket error of a network failure (`ECONNRESET`), as the logger's `code`. */
  readonly code: string | undefined;
  readonly outcome: AmadeusOutcome;
  readonly errorCodes: readonly number[];
  /** Every issue of the answer (console scope only: `details.errors` of the raw console calls). */
  readonly issues: readonly SupplierIssue[];

  constructor(operation: string, failure: AmadeusFailure) {
    const status = failure.kind === "http" ? failure.status : undefined;
    const issues = failure.kind === "http" ? failure.issues : [];
    const codes = errorCodesOf(issues);
    const what =
      failure.kind === "http"
        ? `HTTP ${failure.status}${codes.length > 0 ? `, codes ${codes.join(", ")}` : ""}`
        : failure.kind === "timeout"
          ? "no answer in time"
          : `network error ${failure.code ?? "without a code"}`;
    super(`Amadeus ${operation}: ${what}`);
    this.httpStatus = status;
    this.code = failure.kind === "network" ? failure.code : undefined;
    this.outcome = outcomeOf(failure);
    this.errorCodes = Object.freeze(codes);
    this.issues = Object.freeze(issues.map((issue) => Object.freeze(supplierIssueOf(issue, status ?? 0))));
  }
}

/** The API error of a 4xx answer whose issues carry a code of the table, or `undefined`. */
function byIssueCode(
  issues: readonly AmadeusIssue[],
  status: number,
  cause: AmadeusCallError,
): AppError | undefined {
  for (const issue of issues) {
    const code = issue.code;
    if (code === undefined) {
      continue;
    }
    const mapped = AMADEUS_CODE_TABLE[code];
    if (mapped !== undefined) {
      return new AppError(mapped, { supplier: supplierIssueOf(issue, status), cause });
    }
    if (AMADEUS_DATA_CODES[code] !== undefined) {
      const fieldErrors = travelerFieldErrors(issues);
      return fieldErrors.length > 0
        ? new AppError("TRAVELER_DATA_INVALID", {
            fieldErrors,
            supplier: supplierIssueOf(issue, status),
            cause,
          })
        : new AppError("SUPPLIER_REJECTED", { supplier: supplierIssueOf(issue, status), cause });
    }
  }
  return undefined;
}

/** One field error per data issue that points at a traveller: the path, `invalid`/`required` and the title. */
function travelerFieldErrors(issues: readonly AmadeusIssue[]): FieldError[] {
  return issues.flatMap((issue) => {
    const code = issue.code === undefined ? undefined : AMADEUS_DATA_CODES[issue.code];
    const path = travelerPath(issue.source?.pointer);
    if (code === undefined || path === undefined) {
      return [];
    }
    const fieldError: FieldError = { path, code };
    if (typeof issue.title === "string") {
      fieldError.message = issue.title;
    }
    return [fieldError];
  });
}

/**
 * The `AppError` of a failed Amadeus call (see the table in the file header). `operation` is the client method
 * (`quoteAirOffers`), used in the cause's message.
 */
export function mapAmadeusError(operation: string, failure: AmadeusFailure): AppError {
  const cause = new AmadeusCallError(operation, failure);
  switch (failure.kind) {
    case "timeout":
      return new AppError("SUPPLIER_TIMEOUT", { cause });
    case "network":
      return new AppError(
        failure.code !== undefined && RESET_CODES.has(failure.code)
          ? "SUPPLIER_TIMEOUT"
          : "SUPPLIER_UNAVAILABLE",
        { cause },
      );
    case "http": {
      const { status, issues } = failure;
      const first = issues[0];
      const supplier =
        first === undefined ? { provider: "amadeus" as const, status } : supplierIssueOf(first, status);
      if (status >= 400 && status < 500) {
        const specific = byIssueCode(issues, status, cause);
        if (specific !== undefined) {
          return specific;
        }
      }
      return new AppError(codeForStatus(status), { supplier, cause });
    }
  }
}
