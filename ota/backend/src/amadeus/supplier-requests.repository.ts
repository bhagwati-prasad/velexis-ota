// The `supplier_requests` rows of the tenant (db README §8, flows/amadeus-connection-and-tokens.md §6, OADR-0001
// point 9; OBE-018): one row per Amadeus call, written by the client in a short tenant transaction of its own after
// the call. Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a
// schema (ADR-0004).
//
// Bodies are stored as `supplierRequestBody` makes them (the column comments of tenant.sql):
//   1. the shared redactor of @velexis/logger (`redactPayload`): document, discount and card numbers masked to their
//      last 4, security codes, birth places and issuance locations dropped, tokens and secrets `[REDACTED]`;
//   2. plus, for this table, e-mail addresses and phone numbers masked (`maskContactData`): the first character and
//      the domain of an address (`a***@example.com`) in e-mail fields and in any other text (remarks), the last 4
//      digits of a number in phone fields;
//   3. a body whose JSON is longer than 64 KB is replaced by `{ truncated: true, bytes, preview }`, `preview` being
//      the first part of its JSON text, and the row's `truncated` is set.
// A card's raw object never reaches this file: callers that send one pass a copy redacted before the call
// (`redactedRequest`, OADR-0004), and it goes through the same steps again.
import { Injectable } from "@nestjs/common";
import type { Insertable, TenantDatabase, Transaction } from "@velexis/db";
import { redactPayload } from "@velexis/logger";
import type { AmadeusOutcome } from "./error-mapper";
import type { AmadeusApi } from "./limits";

/** The open tenant transaction (`tenantTx`). */
export type TenantTransaction = Transaction<TenantDatabase>;

/** The longest body stored as it is, in bytes of its JSON text (flow §6). */
export const SUPPLIER_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;

/** What the client records of one call (`supplier_requests`, without `id` defaults). */
export interface SupplierRequestRecord {
  /** `sreq_…` */
  readonly id: string;
  readonly environment: "test" | "live";
  /** The Velexis use case or SDK method (`flights.search`). */
  readonly operation: string;
  /** `Authorization` or the specification of the operation. */
  readonly amadeusApi: AmadeusApi | "Authorization";
  readonly amadeusOperationId: string;
  readonly httpMethod: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path and query after the base URL; no host, no secret. */
  readonly path: string;
  readonly officeId: string | null;
  /** `null` when no answer came (timeout, network error). */
  readonly httpStatus: number | null;
  readonly outcome: AmadeusOutcome;
  readonly errorCodes: readonly number[];
  readonly durationMs: number;
  /** `ama-request-id` of the answer. */
  readonly correlationId: string | null;
  readonly requestId: string | null;
  /** The request body (or the query of a call without one), before `supplierRequestBody`. */
  readonly requestBody: unknown;
  /** The parsed response body, before `supplierRequestBody`; `undefined` for none. */
  readonly responseBody: unknown;
  readonly bookingId: string | null;
  readonly searchId: string | null;
  readonly staffId: string | null;
}

/** A body as it is stored: the JSON text for the jsonb column (`null` for none), and whether it was truncated. */
export interface StoredBody {
  readonly json: string | null;
  readonly truncated: boolean;
}

function normalise(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/** Keys whose string value is an e-mail address. */
const EMAIL_KEYS: ReadonlySet<string> = new Set(["email", "emailaddress", "emailaddresses"]);
/** Keys whose value is a phone number wherever they appear (or objects with a phone `number`, Amadeus `phones[]`). */
const PHONE_KEYS: ReadonlySet<string> = new Set([
  "phone",
  "phones",
  "phonenumber",
  "mobile",
  "mobilenumber",
  "fax",
  "faxnumber",
]);
/** Parents under which `number` is a phone number (Amadeus `phones[]`, `emergencyContact`). */
const PHONE_PARENTS: ReadonlySet<string> = new Set(["phone", "phones", "emergencycontact"]);
/**
 * An e-mail address anywhere in a string. A match starts only after a character that cannot be part of an address
 * (or at the start), and the domain's labels cannot overlap, so the scan stays linear in the length of the text: the
 * bodies hold Amadeus text of up to 64 KB, and an unanchored local part would make it quadratic.
 */
const EMAIL_IN_TEXT =
  /(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** `a***@example.com`: the first character and the domain of each address in the text. */
export function maskEmail(value: string): string {
  return value.replace(
    EMAIL_IN_TEXT,
    (_match, before: string, first: string, domain: string) => `${before}${first}***@${domain}`,
  );
}

/** The last 4 digits of a phone number, as the redactor keeps the last 4 of a document number. */
export function maskPhone(value: string | number): string {
  const digits = String(value).replace(/\D/g, "");
  return digits.length <= 4
    ? "*".repeat(digits.length)
    : `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * The value of an e-mail field: its addresses masked; a value without a recognisable address (`alex@localhost`) keeps
 * its first character only, because it is still what the traveller typed as an address.
 */
export function maskEmailField(value: string): string {
  const masked = maskEmail(value);
  return masked !== value || value === "" ? masked : `${value.slice(0, 1)}***`;
}

/** A contact field's value masked with `mask`; an object below it (`phone: { number }`) is walked as a phone parent. */
function maskValue(value: unknown, mask: (raw: string) => string, phoneParent: boolean): unknown {
  if (typeof value === "string") {
    return mask(value);
  }
  if (typeof value === "number") {
    return mask(String(value));
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => maskValue(item, mask, phoneParent));
  }
  return maskContactData(value, phoneParent);
}

/**
 * A copy of an already redacted payload with e-mail addresses and phone numbers masked (step 2 of the file header).
 * The input is the redactor's output: plain JSON without cycles. An address inside any other text (a remark, a
 * free-text field of Amadeus) is masked too.
 */
export function maskContactData(value: unknown, phoneParent = false): unknown {
  if (typeof value === "string") {
    return maskEmail(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => maskContactData(item, phoneParent));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const name = normalise(key);
    let masked: unknown;
    if (EMAIL_KEYS.has(name)) {
      masked = maskValue(child, maskEmailField, false);
    } else if (PHONE_KEYS.has(name) || (phoneParent && name === "number")) {
      masked = maskValue(child, maskPhone, true);
    } else {
      masked = maskContactData(child, PHONE_PARENTS.has(name));
    }
    // defineProperty keeps a `__proto__` key of parsed JSON as data, as the redactor does.
    Object.defineProperty(copy, key, { value: masked, enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

/** The first `bytes` bytes of a UTF-8 text, without a character cut in half. */
function utf8Prefix(text: string, bytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, bytes).toString("utf8").replace(/�+$/, "");
}

/** Room for the wrapper of a truncated body around its preview. */
const TRUNCATION_WRAPPER_BYTES = 256;

/**
 * A body as `supplier_requests` stores it (steps 1 to 3 of the file header). `undefined` and `null` are no body.
 */
export function supplierRequestBody(value: unknown): StoredBody {
  if (value === undefined || value === null) {
    return { json: null, truncated: false };
  }
  const redacted = maskContactData(redactPayload(value));
  const json = JSON.stringify(redacted);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= SUPPLIER_REQUEST_BODY_LIMIT_BYTES) {
    return { json, truncated: false };
  }
  // The preview is cut so that the wrapper with its escaped text stays within the limit.
  let preview = utf8Prefix(json, SUPPLIER_REQUEST_BODY_LIMIT_BYTES - TRUNCATION_WRAPPER_BYTES);
  let wrapped = JSON.stringify({ truncated: true, bytes, preview });
  while (Buffer.byteLength(wrapped, "utf8") > SUPPLIER_REQUEST_BODY_LIMIT_BYTES) {
    const excess = Buffer.byteLength(wrapped, "utf8") - SUPPLIER_REQUEST_BODY_LIMIT_BYTES;
    preview = utf8Prefix(preview, Buffer.byteLength(preview, "utf8") - excess);
    wrapped = JSON.stringify({ truncated: true, bytes, preview });
  }
  return { json: wrapped, truncated: true };
}

/** A foreign key violation (`booking_id` or `search_id` naming a row the tenant does not have, or not yet). */
export function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503";
}

@Injectable()
export class SupplierRequestsRepository {
  /** Inserts the row of one call; its bodies go through `supplierRequestBody`. */
  async insert(trx: TenantTransaction, record: SupplierRequestRecord): Promise<void> {
    const request = supplierRequestBody(record.requestBody);
    const response = supplierRequestBody(record.responseBody);
    const row: Insertable<TenantDatabase["supplier_requests"]> = {
      id: record.id,
      environment: record.environment,
      provider: "amadeus",
      operation: record.operation,
      amadeus_api: record.amadeusApi,
      amadeus_operation_id: record.amadeusOperationId,
      http_method: record.httpMethod,
      path: record.path,
      office_id: record.officeId,
      http_status: record.httpStatus,
      outcome: record.outcome,
      error_codes: [...record.errorCodes],
      duration_ms: record.durationMs,
      correlation_id: record.correlationId,
      request_id: record.requestId,
      redacted: true,
      request_body: request.json,
      response_body: response.json,
      truncated: request.truncated || response.truncated,
      booking_id: record.bookingId,
      search_id: record.searchId,
      staff_id: record.staffId,
    };
    await trx.insertInto("supplier_requests").values(row).execute();
  }
}
