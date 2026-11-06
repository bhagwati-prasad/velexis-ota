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
//      the first part of its JSON text and `bytes` the size of the body's JSON text as the client hands it over
//      (before steps 1 and 2; the redacted copy's size for a body JSON cannot write as it is, such as one with a
//      cycle), and the row's `truncated` is set.
// A card's raw object never reaches this file: callers that send one pass a copy redacted before the call
// (`redactedRequest`, OADR-0004), and it goes through the same steps again.
//
// A large body (a search answer of 250 offers is about 300 KB) is not redacted as a whole only to keep its first
// 64 KB (OBE-092; ota/docs/performance.md §4): `firstPartOf` copies the first part of it, a little more than the row
// keeps, in the order of its JSON text, and steps 1 and 2 run on that copy. Both steps decide each value by the keys
// above it alone, so the copy's redacted JSON text, without the brackets that close what was cut, is the first part of
// the whole body's redacted JSON text: the stored preview is the one the whole body would give, and everything stored
// went through the redactor. When the redaction leaves that first part at 64 KB or less (it dropped or shortened
// much of it), the copy is taken again twice as long, up to the whole body.
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

/** Normalised keys already seen: the keys of Amadeus bodies are few and repeat in every offer and segment. */
const NORMALISED = new Map<string, string>();
/** Keeps the cache bounded whatever keys a body brings (dictionary codes, free-form maps). */
const NORMALISED_MAX = 4096;
/**
 * Only keys up to this length are kept in the cache: the names of Amadeus bodies are short, and a body's own long
 * keys (a free-form map) must not stay in memory after the call, 4096 of them at a time.
 */
const NORMALISED_KEY_MAX_LENGTH = 64;

function normalise(key: string): string {
  let name = NORMALISED.get(key);
  if (name === undefined) {
    name = key.toLowerCase().replace(/[-_]/g, "");
    if (key.length <= NORMALISED_KEY_MAX_LENGTH) {
      if (NORMALISED.size >= NORMALISED_MAX) {
        NORMALISED.clear();
      }
      NORMALISED.set(key, name);
    }
  }
  return name;
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
  // Most texts of an answer hold no address, and the expression cannot match without an `@`.
  if (!value.includes("@")) {
    return value;
  }
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

/** Sets a member; defineProperty keeps a `__proto__` key of parsed JSON as data, as the redactor does. */
function setMember(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/**
 * The items of an array, each masked: into a new array, or `inPlace` into the array itself (the redactor's copy, which
 * nothing else holds).
 */
function maskItems(items: unknown[], mask: (item: unknown) => unknown, inPlace: boolean): unknown[] {
  if (!inPlace) {
    return items.map(mask);
  }
  for (let index = 0; index < items.length; index += 1) {
    items[index] = mask(items[index]);
  }
  return items;
}

/** A contact field's value masked with `mask`; an object below it (`phone: { number }`) is walked as a phone parent. */
function maskValue(
  value: unknown,
  mask: (raw: string) => string,
  phoneParent: boolean,
  inPlace: boolean,
): unknown {
  if (typeof value === "string") {
    return mask(value);
  }
  if (typeof value === "number") {
    return mask(String(value));
  }
  if (Array.isArray(value)) {
    return maskItems(value, (item) => maskValue(item, mask, phoneParent, inPlace), inPlace);
  }
  return maskContacts(value, phoneParent, inPlace);
}

/**
 * Step 2 of the file header over `value`: into a copy, or `inPlace` into the containers of the redactor's copy. In
 * place, only a plain object is written into: any other object the redactor's copy holds (a `Date`) becomes a plain
 * object of its own members, as the copy makes it, so both give the same JSON text.
 */
function maskContacts(value: unknown, phoneParent: boolean, inPlace: boolean): unknown {
  if (typeof value === "string") {
    return maskEmail(value);
  }
  if (Array.isArray(value)) {
    return maskItems(value, (item) => maskContacts(item, phoneParent, inPlace), inPlace);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> =
    inPlace && Object.getPrototypeOf(source) === Object.prototype ? source : {};
  for (const key of Object.keys(source)) {
    const child = source[key];
    const name = normalise(key);
    let masked: unknown;
    if (EMAIL_KEYS.has(name)) {
      masked = maskValue(child, maskEmailField, false, inPlace);
    } else if (PHONE_KEYS.has(name) || (phoneParent && name === "number")) {
      masked = maskValue(child, maskPhone, true, inPlace);
    } else {
      masked = maskContacts(child, PHONE_PARENTS.has(name), inPlace);
    }
    setMember(target, key, masked);
  }
  return target;
}

/**
 * A copy of an already redacted payload with e-mail addresses and phone numbers masked (step 2 of the file header).
 * The input is the redactor's output: plain JSON without cycles. An address inside any other text (a remark, a
 * free-text field of Amadeus) is masked too.
 */
export function maskContactData(value: unknown, phoneParent = false): unknown {
  return maskContacts(value, phoneParent, false);
}

/** The first `bytes` bytes of a UTF-8 text, without a character cut in half. */
function utf8Prefix(text: string, bytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, bytes).toString("utf8").replace(/�+$/, "");
}

/** Room for the wrapper of a truncated body around its preview. */
const TRUNCATION_WRAPPER_BYTES = 256;

/**
 * The first budget of `firstPartOf` for a large body, in bytes of JSON text: a little more than the row keeps, so
 * that the redacted first part is longer than the limit unless the redaction shortened it. A body whose JSON text is
 * no longer than this goes through the redactor whole.
 */
export const FIRST_PART_BUDGET_BYTES = SUPPLIER_REQUEST_BODY_LIMIT_BYTES + 8 * 1024;

/** The first part of a body, as `firstPartOf` copies it. */
export interface FirstPart {
  /**
   * The body without what comes after the cut. Every container the cut runs through is a copy holding the members
   * before it and, last, the copy of the member it runs through; every other value is the body's own.
   */
  readonly value: unknown;
  /** Whether anything was left out (`value` is then the body itself when not). */
  readonly cut: boolean;
  /** How many containers the cut runs through: the `]` and `}` that close them end the JSON text of `value`. */
  readonly closers: number;
}

/** Bytes of JSON text not yet spent while `firstPartOf` walks a body. */
interface Budget {
  left: number;
}

/** A value JSON writes as it is (a `Date`, any object with `toJSON`) or not at all (a function, a symbol). */
function isOpaque(value: object): boolean {
  return typeof Reflect.get(value, "toJSON") === "function";
}

/** What JSON leaves out of an object (and writes as `null` in an array). */
function isUnwritten(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** About the length of the JSON text of a value that is not walked; only the budget depends on it. */
function textLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length + 2;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value).length;
  }
  if (typeof value === "boolean") {
    return value ? 4 : 5;
  }
  if (typeof value === "object" && value !== null) {
    return (JSON.stringify(value) as string | undefined)?.length ?? 4;
  }
  return 4;
}

function arrayPart(array: readonly unknown[], budget: Budget): FirstPart {
  budget.left -= 2;
  for (let index = 0; index < array.length; index += 1) {
    if (budget.left <= 0) {
      return { value: array.slice(0, index), cut: true, closers: 1 };
    }
    budget.left -= index > 0 ? 1 : 0;
    const part = partOf(array[index], budget);
    if (part.cut) {
      const copy = array.slice(0, index);
      copy.push(part.value);
      return { value: copy, cut: true, closers: part.closers + 1 };
    }
  }
  return { value: array, cut: false, closers: 0 };
}

/** The members of `entries` before `end`, as a new object (a `__proto__` key of parsed JSON stays data). */
function objectOf(entries: ReadonlyArray<readonly [string, unknown]>, end: number): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (let index = 0; index < end; index += 1) {
    const [key, child] = entries[index] ?? ["", undefined];
    Object.defineProperty(copy, key, { value: child, enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

function objectPart(object: object, budget: Budget): FirstPart {
  budget.left -= 2;
  const entries = Object.entries(object);
  let written = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, child] = entries[index] ?? ["", undefined];
    if (isUnwritten(child)) {
      continue;
    }
    if (budget.left <= 0) {
      return { value: objectOf(entries, index), cut: true, closers: 1 };
    }
    budget.left -= key.length + 3 + (written > 0 ? 1 : 0);
    written += 1;
    const part = partOf(child, budget);
    if (part.cut) {
      const copy = objectOf(entries, index);
      Object.defineProperty(copy, key, {
        value: part.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return { value: copy, cut: true, closers: part.closers + 1 };
    }
  }
  return { value: object, cut: false, closers: 0 };
}

function partOf(value: unknown, budget: Budget): FirstPart {
  if (Array.isArray(value)) {
    return arrayPart(value, budget);
  }
  if (typeof value === "object" && value !== null && !isOpaque(value)) {
    return objectPart(value, budget);
  }
  budget.left -= textLength(value);
  return { value, cut: false, closers: 0 };
}

/**
 * The first part of a JSON value: what comes first in its JSON text, about `budgetBytes` of it, as `FirstPart` says.
 * Arrays and objects are cut between two members, through the member that crosses the budget; a string or number is
 * never cut. Plain JSON data only (the input has no cycle: `JSON.stringify` wrote it).
 */
export function firstPartOf(value: unknown, budgetBytes: number): FirstPart {
  return partOf(value, { left: budgetBytes });
}

/**
 * The JSON text of a body after steps 1 and 2 of the file header. The redactor returns a deep copy that shares no
 * object with `value`, so the masking writes into that copy instead of copying it again.
 */
function redactedJson(value: unknown): string {
  return JSON.stringify(maskContacts(redactPayload(value), false, true));
}

/** The byte length of `value`'s JSON text, or `undefined` when JSON cannot write it as it is (a cycle, a BigInt). */
function jsonBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json === undefined ? undefined : Buffer.byteLength(json, "utf8");
  } catch {
    return undefined;
  }
}

/** `{ truncated: true, bytes, preview }` of a body whose redacted JSON text starts with `text` (over the limit). */
function truncatedBody(text: string, bytes: number): StoredBody {
  // The preview is cut so that the wrapper with its escaped text stays within the limit.
  let preview = utf8Prefix(text, SUPPLIER_REQUEST_BODY_LIMIT_BYTES - TRUNCATION_WRAPPER_BYTES);
  let wrapped = JSON.stringify({ truncated: true, bytes, preview });
  while (Buffer.byteLength(wrapped, "utf8") > SUPPLIER_REQUEST_BODY_LIMIT_BYTES) {
    const excess = Buffer.byteLength(wrapped, "utf8") - SUPPLIER_REQUEST_BODY_LIMIT_BYTES;
    preview = utf8Prefix(preview, Buffer.byteLength(preview, "utf8") - excess);
    wrapped = JSON.stringify({ truncated: true, bytes, preview });
  }
  return { json: wrapped, truncated: true };
}

/** A whole redacted body: as it is within the limit, else truncated. */
function wholeBody(json: string, bytes: number | undefined): StoredBody {
  const stored = Buffer.byteLength(json, "utf8");
  return stored <= SUPPLIER_REQUEST_BODY_LIMIT_BYTES
    ? { json, truncated: false }
    : truncatedBody(json, bytes ?? stored);
}

/**
 * A body as `supplier_requests` stores it (steps 1 to 3 of the file header). `undefined` and `null` are no body.
 */
export function supplierRequestBody(value: unknown): StoredBody {
  if (value === undefined || value === null) {
    return { json: null, truncated: false };
  }
  const bytes = jsonBytes(value);
  if (bytes === undefined || bytes <= FIRST_PART_BUDGET_BYTES) {
    // Small, or not JSON as it is (the redactor writes a cycle as `[Circular]`): the whole body.
    return wholeBody(redactedJson(value), bytes);
  }
  for (let budget = FIRST_PART_BUDGET_BYTES; ; budget *= 2) {
    const first = firstPartOf(value, budget);
    const json = redactedJson(first.value);
    if (!first.cut) {
      return wholeBody(json, bytes);
    }
    // Without the brackets that close the cut containers, the text is the first part of the whole body's redacted JSON
    // text (shorter still when the redaction dropped or replaced a container the cut runs through).
    const known = json.slice(0, json.length - first.closers);
    if (Buffer.byteLength(known, "utf8") > SUPPLIER_REQUEST_BODY_LIMIT_BYTES) {
      return truncatedBody(known, bytes);
    }
  }
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
