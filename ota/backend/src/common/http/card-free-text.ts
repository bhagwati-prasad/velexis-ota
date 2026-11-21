// The console's free text never holds a card number (FIX-W67-KI001, known issue KI-001; ADR-0011, OADR-0004, lead
// decision (36) of 2026-11-21). A staff member may paste what a traveller says or writes into a note, a reason or a
// remark, and the API stores that text in the tenant's tables (booking_events, staff_actions, bookings.cancel_reason,
// refunds.reason_note, the order snapshot) and forwards a remark to Amadeus: a card number there would reach the
// database, its backups and the supplier. So every staff free-text field of the console operations below refuses one,
// with the detector of @velexis/logger (`holdsCardNumber`: 12 to 19 digits, grouped by single spaces or dashes or not,
// wherever they stand among other digits, that start with 2 to 6 and pass the Luhn check).
//
// The check runs in the request validation layer (openapi-validation.interceptor.ts), after the document's own
// validation of the request and before the idempotency interceptor and the handler: a refused request claims no
// `Idempotency-Key`, calls no supplier and writes no booking event, staff note, cancel reason, refund or use-case audit
// row. The audit interceptor (staff-actions.writer.ts), which wraps request validation, records the refusal as every
// refused console call: one `failed` row with its action and target only, never the body, the reason or the value. The
// answer is `400 VALIDATION_FAILED` with one field error per offending field of the whole request, `{ path, code:
// "card_data", message }`, where the path is the plain pointer into the body (`/text`, `/reason`,
// `/remarks/general/0/text`) as the document's own validation answers a body field, or `/query/<name>` for a query
// parameter; the message names the kind of text and never the value, which is not echoed in an error, a log line or an
// audit record.
//
// `CARD_FREE_TEXT_FIELDS` is the list of the fields checked here: every string of a console operation's request that
// is staff free text the OTA stores or forwards. card-free-text.test.ts walks every console operation of the document
// and fails for a string field (without `enum`, `format`, `const` or `pattern`) that is neither listed here nor
// classified there as no free text (ids, codes, personal data with a defined meaning, supplier data, settings content),
// so a new free-text field cannot be added to the document without a decision. One field is checked elsewhere: the
// review closure's note (console.bookings.closeReview `/note`), by `refuseClosureRequest` in
// console/review-closure.service.ts together with its outcome rules, so that a refused closure still names every
// problem of its request in one answer (OBE-099, unchanged). The operations that the API does not serve yet (`deferred` in
// pending-operations.ts: console.bookings.create and the four raw Amadeus writes) are listed too: their routes answer
// `501` before anything is read, and the check applies as soon as an implementation binds them to the document.
import type { OtaOperationId } from "@velexis/api-types/operations";
import { AppError, type FieldError } from "@velexis/errors";
import { holdsCardNumber } from "@velexis/logger";

/** The kind of a free-text field, which names it in the refusal's message. */
export type FreeTextKind = "note" | "reason" | "remark";

/** One free-text field of an operation's request. */
export interface FreeTextField {
  /**
   * The JSON pointer of the field: into the body (`/text`, `/reasonNote`), with a `*` segment for every item of an
   * array, or `/query/<name>` for a query parameter.
   */
  readonly pointer: string;
  readonly kind: FreeTextKind;
}

/** The field error code of a free text that holds a card number. */
export const CARD_DATA_CODE = "card_data";

/** The message of each kind of text: it names the field's kind, never the value. */
export const CARD_DATA_MESSAGES: Readonly<Record<FreeTextKind, string>> = Object.freeze({
  note: "A note never holds a card number: remove it.",
  reason: "A reason never holds a card number: remove it.",
  remark: "A remark never holds a card number: remove it.",
});

const note = (pointer: string): FreeTextField => ({ pointer, kind: "note" });
const reason = (pointer: string): FreeTextField => ({ pointer, kind: "reason" });
const remark = (pointer: string): FreeTextField => ({ pointer, kind: "remark" });

/** The free text of a console booking's Amadeus elements: remarks, queue process texts, emergency contacts. */
const BOOKING_ELEMENT_TEXTS: readonly FreeTextField[] = [
  remark("/remarks/general/*/text"),
  remark("/remarks/airline/*/text"),
  remark("/automatedProcess/*/text"),
  remark("/travelers/*/emergencyContact/text"),
];

/**
 * The staff free-text fields of the console operations, by operation (see the file header). The review closure's
 * `/note` is `refuseClosureRequest`'s (review-closure.service.ts).
 */
export const CARD_FREE_TEXT_FIELDS: Readonly<Partial<Record<OtaOperationId, readonly FreeTextField[]>>> =
  Object.freeze({
    consoleAddBookingNote: [note("/text")],
    consoleImportBooking: [note("/note"), reason("/reason")],
    consoleCancelBooking: [reason("/reason")],
    consoleIssueBooking: [reason("/reason")],
    consolePatchBooking: [...BOOKING_ELEMENT_TEXTS, reason("/reason")],
    consoleCreateBooking: [...BOOKING_ELEMENT_TEXTS, note("/note"), reason("/reason")],
    consoleCapturePayment: [reason("/reason")],
    consoleRefundPayment: [reason("/reasonNote")],
    consoleAmadeusSearchFlightOffers: [reason("/reason")],
    consoleAmadeusSearchFlightAvailabilities: [reason("/reason")],
    consoleAmadeusUpsellAirOffers: [reason("/reason")],
    consoleAmadeusQuoteAirOffers: [reason("/reason")],
    consoleAmadeusCreateFlightOrders: [reason("/reason")],
    consoleAmadeusIssueFlightOrder: [reason("/reason")],
    consoleAmadeusPatchFlightOrder: [reason("/reason")],
    consoleAmadeusCancelFlightOrder: [reason("/query/reason")],
  });

/** The validated parts of a request the check reads. */
export interface FreeTextInput {
  readonly body: unknown;
  readonly query: Readonly<Record<string, unknown>>;
}

const QUERY_PREFIX = "/query/";

/** A JSON pointer segment (RFC 6901). */
const escapeSegment = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");

/** Every string at `segments` below `value` with its concrete pointer; `*` stands for every item of an array. */
function stringsAt(
  value: unknown,
  segments: readonly string[],
  pointer: string,
  found: Array<{ readonly pointer: string; readonly text: string }>,
): void {
  if (segments.length === 0) {
    if (typeof value === "string") {
      found.push({ pointer, text: value });
    }
    return;
  }
  const [segment, ...rest] = segments as [string, ...string[]];
  if (segment === "*") {
    if (Array.isArray(value)) {
      value.forEach((item, index) => stringsAt(item, rest, `${pointer}/${index}`, found));
    }
    return;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, segment)) {
    stringsAt(
      (value as Record<string, unknown>)[segment],
      rest,
      `${pointer}/${escapeSegment(segment)}`,
      found,
    );
  }
}

/** The values of one listed field in a request, each with the pointer it is answered at. */
function valuesOf(
  field: FreeTextField,
  input: FreeTextInput,
): Array<{ readonly pointer: string; readonly text: string }> {
  const found: Array<{ pointer: string; text: string }> = [];
  if (field.pointer.startsWith(QUERY_PREFIX)) {
    const name = field.pointer.slice(QUERY_PREFIX.length);
    const value = Object.hasOwn(input.query, name) ? input.query[name] : undefined;
    if (typeof value === "string") {
      found.push({ pointer: field.pointer, text: value });
    }
    return found;
  }
  stringsAt(input.body, field.pointer.split("/").slice(1), "", found);
  return found;
}

/**
 * The field errors of the free-text fields of `operationId` that hold a card number, in the order of the list and of
 * the items; `[]` for an operation without free text or a request without a card number. Never carries a value.
 */
export function cardDataErrors(
  operationId: string,
  input: FreeTextInput,
  fields: Readonly<Partial<Record<string, readonly FreeTextField[]>>> = CARD_FREE_TEXT_FIELDS,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of fields[operationId] ?? []) {
    for (const { pointer, text } of valuesOf(field, input)) {
      if (holdsCardNumber(text)) {
        errors.push({ path: pointer, code: CARD_DATA_CODE, message: CARD_DATA_MESSAGES[field.kind] });
      }
    }
  }
  return errors;
}

/**
 * Refuses a request whose free text holds a card number: `400 VALIDATION_FAILED` with every such field (see the file
 * header). Called by the request validation layer after the document's validation passed, before anything else runs.
 */
export function refuseCardData(operationId: string, input: FreeTextInput): void {
  const fieldErrors = cardDataErrors(operationId, input);
  if (fieldErrors.length > 0) {
    throw new AppError("VALIDATION_FAILED", { fieldErrors });
  }
}
