// console.bookings.closeReview (consoleCloseBookingReview; OBE-099, lead decision (15l) of 2026-11-11; OADR-0003 point
// 5 and its follow-up "The console's booking actions … settle a booking in `reconcile_outcome = manual_review`",
// ota/docs/runbooks/supplier-timeout-and-reconciliation.md §4.3): the staff close a booking that the reconciliation of
// a lost Flight Create Orders answer handed to them. Such a booking is `pending` with `reconcile_outcome =
// manual_review`, its checkout locked (CHECKOUT_BEING_COMPLETED) and its Stripe authorisation or airline-card payment
// held; issue, cancel and resync refuse it (`pending`), so before this operation it stayed in the Reconciliation review
// view and went to Velexis ops. The permission guard checked `bookings:cancel` and the environment before this runs
// (OBE-060); a booking of the other environment, or an unknown id, answers `404 NOT_FOUND`. No transaction is open
// during the Amadeus call (OADR-0003 point 1), and Flight Create Orders is never sent (OADR-0003 point 2).
//
//   1. The request (`refuseClosureRequest`, before anything is read): `order_found` needs `recordLocator`, `not_booked`
//      needs a `note` and takes no record locator, and a note never holds a card number (`holdsCardNumber`: 12 to 19
//      digits, grouped or not and wherever they stand among other digits, that pass the Luhn check): `400
//      VALIDATION_FAILED` at `/body/recordLocator` or `/body/note`.
//   2. T1 (`check`): the booking of the request's environment, its `If-Match` (`412 PRECONDITION_FAILED`), the review
//      (`pending` with `reconcile_outcome = manual_review`, else `409 CONFLICT`, `details.reason = not_in_review`), and
//      for `order_found` a booking of the environment that already holds the record locator (`409
//      ORDER_ALREADY_IMPORTED`, as console.bookings.import answers it, before Amadeus is called).
//   3. `order_found`: Get Flight Order By Record Locator (`readOrder`) in the booking's queuing office (`orderOffice`,
//      the office its order was sent to, as the reconciliation's search names it), the orders of offices that are not
//      the tenant's withheld from the answer and from the tenant's `supplier_requests` row (PNR import's office rule,
//      `withheldResponseOf`; none left: `403 OFFICE_NOT_ALLOWED`), and the order accepted only when it carries the
//      remark `VELEXIS {reference}` of sub-type BACKOFFICE of this booking (reconcile.service.ts `orderOfBooking`, the
//      reconciliation's own proof: `409 CONFLICT`, `remark_mismatch`, otherwise; one that carries it but cannot be
//      recorded: `422 UNPROCESSABLE`, `order_not_recordable`). Amadeus without an order for the record locator answers
//      `404 NOT_FOUND` with `error.supplier`. Then T2 (`recordOrderFound`): the checkout, then the booking locked
//      (OADR-0003 point 11), still in review in that checkout and at the version of T1, no other booking holding the
//      order by its id or one of its records (the unique indexes catch a concurrent import: `409
//      ORDER_ALREADY_IMPORTED`), and the reconciliation's found decision (`recordFoundOrder`: the order recorded by
//      the staff member, `reconcile_outcome = found`, the checkout `completed`, the staff event
//      `booking.reconcile_closed` as the decision's event, an airline-card payment settled as the airline charged it).
//      The money follows as after an automatic find, through the payments job: the capture safety net of the record
//      step (`capture-retry-<pay_id>`, 10 minutes) is added before the commit, and promoted to run now after it
//      (`captureNow`), so `payment.capture_retry` captures the booking's total within the authorisation and then makes
//      the issuance of the `issue_after_payment` policy due (PaymentsRepository.requestIssuanceAfterPayment), which the
//      ticketing job takes. A Redis that does not take the promotion leaves the net, which runs 10 minutes later.
//   4. `not_booked`: T2 (`recordNotBooked`): the checkout, the booking and its payments locked, still in review at the
//      version of T1, and the reconciliation's not-found decision (`failNotFoundBooking`: `failed`, `failure_code =
//      SUPPLIER_TIMEOUT`, `reconcile_outcome = not_found`, the checkout reopened or expired). A Stripe authorisation is
//      voided by `payment.void` after the commit (on the account that created it, payments.processor.ts) and the
//      traveller gets `booking.not_confirmed`. An airline-card booking has nothing to void: Velexis never charged the
//      card, so its payment becomes `failed`, the traveller gets no e-mail (the template says nothing was charged and a
//      hold is released, which the airline card cannot promise), and its `booking.reconcile_closed` event records that
//      the agent asks the airline about a charge (AIRLINE_CARD_CHARGE_NOTE; never a card value).
//   5. Both: the staff event `booking.reconcile_closed` (staff-only; the outcome and the record locator, the staff
//      member as its actor, no other personal data), the note as a staff-only `staff.note` and the `staff_actions` row
//      `booking.reconcile_close` (before and after, the note as its reason), in T2. No staff alert: the staff decided.
//      The answer is the console booking (ConsoleBookingsService.get). A refusal changes nothing; the audit
//      interceptor writes its `failed` (or `denied`) row. The idempotency interceptor replays the first answer for the
//      same key; a new key after the closure meets `not_in_review`.
//
// Log lines carry ids, codes and outcomes, never a name, a note or a body.
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import { AppError, isAppError, type FieldError, type OtaErrorCode } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { ConnectionResolver } from "../amadeus/connection-resolver";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { BookingsRepository } from "../bookings/bookings.repository";
import { eventActorOf, OrderRecorder, type CreatedOrder } from "../bookings/order-recorder";
import {
  CAPTURE_RETRY_DELAY_MS,
  failNotFoundBooking,
  NOT_CONFIRMED_SUMMARY,
  orderOfBooking,
  readFoundOrderInput,
  ReconcileRepository,
  recordFoundOrder,
  type DecisionEvent,
  type NotConfirmedEmailDeps,
  type ReconcileDecisionDeps,
  type ReconcilePaymentRow,
} from "../bookings/reconcile.service";
import { CheckoutRepository } from "../checkout/checkout.repository";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { TravelerDocuments } from "../checkout/traveler-documents";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE } from "../common/queues/queue-names";
import type { SharedConfig } from "../config";
import { OutboxService } from "../notifications/outbox.service";
import { luhnValid } from "../payments/airline-card/card-validation";
import { addSafetyNet, PAYMENT_JOB, paymentJob, safetyNetJob } from "../payments/payments.processor";
import { PaymentsRepository } from "../payments/payments.repository";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { afterCommit, TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import type { ConsoleBooking } from "./console-bookings.mapper";
import { STAFF_NOTE_EVENT } from "./console-bookings.repository";
import { ConsoleBookingsService } from "./console-bookings.service";
import {
  partitionOrders,
  PnrImportRepository,
  withheldResponseOf,
  type AttachedBooking,
} from "./pnr-import.service";
import { StaffActionsWriter } from "./staff-actions.writer";

type Schemas = components["schemas"];
export type ReviewClosureRequest = Schemas["ConsoleBookingReviewClosureRequest"];
type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- Names ----------------------------------------------------------------------------------------------------------

/** The staff-only booking event of a closed review (`booking_events.type`). */
export const REVIEW_CLOSED_EVENT = "booking.reconcile_closed";

/** The `staff_actions.action` of a closed review. */
export const REVIEW_CLOSE_ACTION = "booking.reconcile_close";

/** `supplier_requests.operation` of the closure's Amadeus call (its SDK method). */
export const REVIEW_CLOSE_OPERATION = "console.bookings.closeReview";

/** The originating system of every Velexis order (Get Flight Order by Record Locator supports only this one). */
const ORIGIN_SYSTEM_CODE = "GDS";

/** `bookings.reconcile_outcome` of a booking the reconciliation handed to the staff. */
const MANUAL_REVIEW = "manual_review";

/** What the `booking.reconcile_closed` event of an airline-card booking closed as not booked records (step 4). */
export const AIRLINE_CARD_CHARGE_NOTE =
  "Paid by airline card: Velexis never charged the card, and the agent asks the airline whether it charged it and has " +
  "any charge refunded.";

/** The customer-visible `booking.not_confirmed` of an airline-card booking: nothing about a release of a hold. */
export const AIRLINE_CARD_NOT_CONFIRMED_SUMMARY =
  "The airline did not confirm your booking. The travel agency will contact you about any charge on your card.";

/** The unique indexes a concurrent import of the same order hits when the order is recorded here. */
const ORDER_UNIQUE: ReadonlySet<string> = new Set([
  "bookings_amadeus_order_uq",
  "bookings_record_locator_uq",
]);

/**
 * The client's errors the operation passes on (its `x-error-codes`), plus `503 SERVICE_UNAVAILABLE`; any other becomes
 * `502 SUPPLIER_ERROR`. `OFFICE_NOT_ALLOWED` is the resolver's refusal of a released office (`403`).
 */
const SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  "OFFICE_NOT_ALLOWED",
  "SUPPLIER_REJECTED",
  "SUPPLIER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "SUPPLIER_ERROR",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
]);

// ---- The rules, without I/O -----------------------------------------------------------------------------------------

/** A run of digit groups joined by single spaces or dashes (`4111 1111 1111 1111 123`), or one group alone. */
const DIGIT_RUN = /\d+(?:[ -]\d+)*/g;

/** The lengths of a payment card number (ISO/IEC 7812). */
const CARD_DIGITS = { min: 12, max: 19 } as const;

/** The first digit of a payment card's issuer number (ISO/IEC 7812: 2 to 6 for the card brands the OTAs take). */
const CARD_FIRST_DIGIT = /^[2-6]/;

/**
 * Whether `text` holds a card number: 12 to 19 digits, grouped by single spaces or dashes or not, that start as a card
 * brand's number does and pass the Luhn check. Every span of whole consecutive groups of a run is tried, so a number
 * next to other digits (a security code or an expiry after it, a reference before it: `4111 1111 1111 1111 123`) is
 * found too. A note never keeps one (ADR-0011, OADR-0004). Phones, amounts, dates and the ticket numbers of the
 * airline codes that start with 0, 1 or 7 to 9 (`057-…`) are never taken for one; a ticket number of an airline code
 * from 2 to 6 is refused like a card number when its 13 digits pass the Luhn check (one in ten of them).
 */
export function holdsCardNumber(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    const groups = match[0].split(/[ -]/);
    for (let start = 0; start < groups.length; start += 1) {
      let digits = "";
      for (let end = start; end < groups.length && digits.length < CARD_DIGITS.max; end += 1) {
        digits += groups[end] ?? "";
        if (
          digits.length >= CARD_DIGITS.min &&
          digits.length <= CARD_DIGITS.max &&
          CARD_FIRST_DIGIT.test(digits) &&
          luhnValid(digits)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * The refusals of a closure request that need nothing else (`400 VALIDATION_FAILED`, see the file header): the
 * record locator of `order_found`, the note of `not_booked`, and a note without a card number.
 */
export function refuseClosureRequest(body: ReviewClosureRequest): void {
  const fieldErrors: FieldError[] = [];
  const note = body.note?.trim() ?? "";
  if (body.outcome === "order_found" && body.recordLocator === undefined) {
    fieldErrors.push({
      path: "/body/recordLocator",
      code: "required",
      message: "Give the record locator of the order that was found.",
    });
  }
  if (body.outcome === "not_booked" && body.recordLocator !== undefined) {
    fieldErrors.push({
      path: "/body/recordLocator",
      code: "not_allowed",
      message: "A booking closed as not booked has no record locator.",
    });
  }
  if (body.outcome === "not_booked" && note === "") {
    fieldErrors.push({
      path: "/body/note",
      code: "required",
      message: "Say what was looked for and found before closing the booking as not booked.",
    });
  }
  if (body.note !== undefined && holdsCardNumber(body.note)) {
    fieldErrors.push({
      path: "/body/note",
      code: "card_data",
      message: "A note never holds a card number: remove it.",
    });
  }
  if (fieldErrors.length > 0) {
    throw new AppError("VALIDATION_FAILED", { fieldErrors });
  }
}

/** The review state of a booking as the closure reads it. */
export interface ReviewState {
  readonly status: string;
  readonly reconcileOutcome: string | null;
}

/** Whether the booking is in Reconciliation review: `pending` with `reconcile_outcome = manual_review`. */
export function inReview(state: ReviewState): boolean {
  return state.status === "pending" && state.reconcileOutcome === MANUAL_REVIEW;
}

/** `409 CONFLICT` of a booking that is not in review (`not_in_review`), with its status and outcome. */
export function notInReview(state: ReviewState): AppError {
  return new AppError("CONFLICT", {
    message: "This booking is not in Reconciliation review.",
    details: { reason: "not_in_review", status: state.status, reconcileOutcome: state.reconcileOutcome },
  });
}

/** `409 CONFLICT` of an order read by record locator that does not carry the booking's remark (`remark_mismatch`). */
export function remarkMismatch(reference: string): AppError {
  return new AppError("CONFLICT", {
    message: `No order with this record locator carries the remark VELEXIS ${reference} of this booking.`,
    details: { reason: "remark_mismatch" },
  });
}

/** `409 ORDER_ALREADY_IMPORTED` of an order another booking of the environment holds (as the PNR import answers). */
export function orderHeldBy(booking: Pick<AttachedBooking, "id" | "reference">): AppError {
  return new AppError("ORDER_ALREADY_IMPORTED", {
    message: `This order is already booking ${booking.reference}.`,
    details: { bookingId: booking.id, reference: booking.reference },
  });
}

/** What the closure did with the booking's payments (the staff action's after). */
export type ClosurePaymentAction =
  /** `order_found`, Stripe: `payment.capture_retry` captures it now. */
  | "capture_queued"
  /** `order_found`, airline card, every ticket back: the airline charged the card (`captured`). */
  | "airline_charged"
  /** `order_found`, airline card without every ticket: the payment stays `processing`, ticketing `manual_review`. */
  | "airline_not_ticketed"
  /** `not_booked`, Stripe: `payment.void` releases the authorisation. */
  | "void_queued"
  /** `not_booked`, airline card: the payment `failed`; the agent asks the airline about a charge. */
  | "airline_failed"
  /** Nothing to capture or void (the `manual_review` policy without a ticket, a payment captured or gone). */
  | "none";

/** The staff event `booking.reconcile_closed` of a closure (see the file header): no personal data but the locator. */
export function closureEventOf(input: {
  readonly outcome: ReviewClosureRequest["outcome"];
  readonly reference: string;
  readonly recordLocator: string | null;
  readonly airlineCard: boolean;
}): DecisionEvent {
  if (input.outcome === "order_found") {
    return {
      type: REVIEW_CLOSED_EVENT,
      summary:
        `Reconciliation review closed by the travel agency: the order of booking ${input.reference} was found ` +
        `(record locator ${input.recordLocator ?? ""}) and recorded.`,
      data: { outcome: "order_found", recordLocator: input.recordLocator },
    };
  }
  return {
    type: REVIEW_CLOSED_EVENT,
    summary:
      `Reconciliation review closed by the travel agency: booking ${input.reference} was not booked at the airline.` +
      (input.airlineCard ? ` ${AIRLINE_CARD_CHARGE_NOTE}` : ""),
    data: {
      outcome: "not_booked",
      recordLocator: null,
      ...(input.airlineCard ? { airlineCard: true, airlineChargeCheck: "agent_asks_airline" } : {}),
    },
  };
}

/** An Amadeus `404`: the record locator names no order. */
function isOrderNotFound(error: unknown): error is AppError {
  return (
    error instanceof AppError && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404
  );
}

/** The answer of a failed by-reference read (see SUPPLIER_CODES): `404` with the supplier error, the codes, or a `502`. */
export function closureSupplierAnswerOf(error: unknown): unknown {
  if (isOrderNotFound(error)) {
    return new AppError("NOT_FOUND", {
      message: "Amadeus has no order with this record locator.",
      ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
      cause: error,
    });
  }
  if (!isAppError(error) || SUPPLIER_CODES.has(error.code)) {
    return error;
  }
  return new AppError("SUPPLIER_ERROR", {
    ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
    cause: error,
  });
}

/** The PostgreSQL unique violation of one of `constraints`. */
function uniqueViolation(error: unknown, constraints: ReadonlySet<string>): boolean {
  return (
    isRecord(error) &&
    error["code"] === "23505" &&
    typeof error["constraint"] === "string" &&
    constraints.has(error["constraint"])
  );
}

// ---- The repository -------------------------------------------------------------------------------------------------

/** What T1 reads of the booking. */
export interface ReviewBookingRow extends ReviewState {
  readonly id: string;
  readonly environment: string;
  readonly reference: string;
  readonly checkoutId: string | null;
  readonly queuingOfficeId: string | null;
  readonly version: number;
}

/** The closure's own read (tenant repository: the `tenantTx` transaction first, never a schema name). */
@Injectable()
export class ReviewClosureRepository {
  /** The booking `id` as T1 reads it (no lock: T2 locks and checks again), or `undefined`. */
  async booking(trx: TenantTransaction, id: string): Promise<ReviewBookingRow | undefined> {
    return await trx
      .selectFrom("bookings")
      .select([
        "id",
        "environment",
        "reference",
        "status",
        "reconcile_outcome as reconcileOutcome",
        "checkout_id as checkoutId",
        "queuing_office_id as queuingOfficeId",
        "version",
      ])
      .where("id", "=", id)
      .executeTakeFirst();
  }
}

// ---- The service ----------------------------------------------------------------------------------------------------

/** What T1 found. */
interface ReviewClaim {
  readonly booking: ReviewBookingRow;
  /**
   * The booking's checkout, which its completion locked; `null` only for a booking in review without one (none of
   * checkout.complete's, which always have it), which `not_booked` closes as the not-found decision closes it.
   */
  readonly checkoutId: string | null;
}

/** The order read by record locator, with its call. */
interface ReadOrder {
  readonly order: CreatedOrder;
  readonly supplierRequestId: string | null;
}

@Injectable()
export class ReviewClosureService {
  private readonly baseDomain: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly repository: ReviewClosureRepository,
    private readonly bookings: BookingsRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly documents: TravelerDocuments,
    private readonly payments: PaymentsRepository,
    private readonly recorder: OrderRecorder,
    private readonly reconcile: ReconcileRepository,
    private readonly pnr: PnrImportRepository,
    private readonly amadeus: AmadeusClient,
    private readonly connections: ConnectionResolver,
    private readonly outbox: OutboxService,
    private readonly audit: StaffActionsWriter,
    private readonly consoleBookings: ConsoleBookingsService,
    private readonly tenants: TenantContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.payments) private readonly paymentsQueue: Queue,
    config: ConfigService<SharedConfig, true>,
    @InjectPinoLogger(ReviewClosureService.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** Closes the booking's review with what the staff found (see the file header); answers the booking. */
  async close(bookingId: string, ifMatch: string, body: ReviewClosureRequest): Promise<ConsoleBooking> {
    refuseClosureRequest(body);
    const tenant = this.tenants.require();
    const claim = await this.tx.run((trx) => this.check(trx, tenant, bookingId, ifMatch, body));
    if (body.outcome === "order_found") {
      const { checkoutId } = claim;
      if (checkoutId === null) {
        // The record step records the order from the checkout's travellers and contacts (reconcile.service.ts), so
        // nothing is asked of Amadeus first. Every booking checkout.complete hands to the review keeps its checkout.
        throw new Error("a booking in review without its checkout cannot record its order");
      }
      const read = await this.readOrder(tenant, claim, body.recordLocator ?? "");
      await this.recordOrderFound(tenant, { ...claim, checkoutId }, body, read);
    } else {
      await this.recordNotBooked(tenant, claim, body);
    }
    this.logger.info({ bookingId, outcome: body.outcome }, "console.bookings.review_closed");
    return await this.consoleBookings.get(bookingId, { refresh: false });
  }

  // ---- T1 ----------------------------------------------------------------------------------------------------------

  private async check(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    ifMatch: string,
    body: ReviewClosureRequest,
  ): Promise<ReviewClaim> {
    const booking = await this.repository.booking(trx, bookingId);
    if (booking === undefined || booking.environment !== tenant.environment) {
      throw new AppError("NOT_FOUND");
    }
    if (!ifMatchSatisfied(ifMatch, booking.version)) {
      throw new AppError("PRECONDITION_FAILED", { details: { currentVersion: booking.version } });
    }
    if (!inReview(booking)) {
      throw notInReview(booking);
    }
    if (body.outcome === "order_found") {
      // A known record locator is refused before Amadeus is called (as console.bookings.import refuses it).
      const held = await this.heldBy(trx, tenant, bookingId, {
        records: [{ reference: body.recordLocator ?? "", originSystemCode: ORIGIN_SYSTEM_CODE }],
        orderIds: [],
      });
      if (held !== undefined) {
        throw orderHeldBy(held);
      }
    }
    return { booking, checkoutId: booking.checkoutId };
  }

  /** Another booking of the environment holding one of `records` or `orderIds`, or `undefined`. */
  private async heldBy(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    order: {
      readonly records: readonly { readonly reference: string; readonly originSystemCode: string }[];
      readonly orderIds: readonly string[];
    },
  ): Promise<AttachedBooking | undefined> {
    const attached = await this.pnr.attachedBookings(trx, tenant.environment, order.records, order.orderIds);
    return attached.find((booking) => booking.id !== bookingId);
  }

  // ---- order_found -------------------------------------------------------------------------------------------------

  /** The order of the record locator that carries the booking's remark (see the file header; no transaction open). */
  private async readOrder(
    tenant: RequestTenant,
    claim: ReviewClaim,
    recordLocator: string,
  ): Promise<ReadOrder> {
    const { booking } = claim;
    let reply: Awaited<ReturnType<AmadeusClient["getFlightOrderByReference"]>>;
    let orderOfficeIds: readonly string[];
    try {
      ({ orderOfficeIds } = await this.connections.tenantOffices(tenant.tenantId, tenant.environment));
      reply = await this.amadeus.getFlightOrderByReference(
        this.callContext(tenant, booking),
        { query: { reference: recordLocator, originSystemCode: ORIGIN_SYSTEM_CODE } },
        // Another office's orders never reach the tenant's supplier log (PNR import's office rule).
        { recordedResponse: withheldResponseOf(orderOfficeIds) },
      );
    } catch (error) {
      this.logger.warn({ bookingId: booking.id, code: codeOf(error) }, "console.bookings.review_read_failed");
      throw closureSupplierAnswerOf(error);
    }
    const body = isRecord(reply.body) ? reply.body : undefined;
    if (body === undefined) {
      throw new AppError("SUPPLIER_ERROR", {
        message: "Amadeus answered with something that is not an order.",
      });
    }
    const orders = (
      Array.isArray(body["data"]) ? body["data"] : isRecord(body["data"]) ? [body["data"]] : []
    ).filter(isRecord);
    if (orders.length === 0) {
      throw new AppError("NOT_FOUND", { message: "Amadeus has no order with this record locator." });
    }
    const { allowed, withheld } = partitionOrders(orders, orderOfficeIds);
    if (allowed.length === 0) {
      this.logger.warn(
        { bookingId: booking.id, withheldOrders: withheld.length },
        "console.bookings.review_office_not_allowed",
      );
      throw new AppError("OFFICE_NOT_ALLOWED", {
        message: "This record locator belongs to an office outside this OTA.",
      });
    }
    const order = orderOfBooking({ data: allowed, dictionaries: body["dictionaries"] }, booking.reference);
    if (order === undefined) {
      throw remarkMismatch(booking.reference);
    }
    if (order === null) {
      throw new AppError("UNPROCESSABLE", {
        message: "The order with this booking's remark cannot be recorded: check it in Amadeus.",
        details: { reason: "order_not_recordable" },
      });
    }
    return { order, supplierRequestId: reply.call.supplierRequestId };
  }

  /** T2 of `order_found` (see the file header). */
  private async recordOrderFound(
    tenant: RequestTenant,
    claim: ReviewClaim & { readonly checkoutId: string },
    body: ReviewClosureRequest,
    read: ReadOrder,
  ): Promise<void> {
    const { order } = read;
    const id = claim.booking.id;
    // What the record step needs, read (and decrypted) before the decision's transaction.
    const found = await readFoundOrderInput(
      this.tx,
      { bookings: this.bookings, checkouts: this.checkouts, documents: this.documents },
      tenant.schemaName,
      claim.checkoutId,
    );
    try {
      await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const current = await this.lockInReview(trx, claim);
        const held = await this.heldBy(trx, tenant, id, {
          records: order.records.map((record) => ({
            reference: record.reference,
            originSystemCode: record.originSystemCode,
          })),
          orderIds: [order.id],
        });
        if (held !== undefined) {
          throw orderHeldBy(held);
        }
        const booking = await this.bookings.booking(trx, id);
        if (booking === undefined) {
          throw new AppError("NOT_FOUND");
        }
        const recordLocator = order.records[0]?.reference ?? null;
        const decided = await recordFoundOrder(trx, this.decisionDeps(), {
          schema: tenant.schemaName,
          tenantKey: tenant.key,
          booking,
          order,
          found,
          actor: tenant.actor,
          event: closureEventOf({
            outcome: "order_found",
            reference: booking.reference,
            recordLocator,
            airlineCard: false,
          }),
          source: "api",
          requestId: this.requestId(tenant),
          supplierRequestId: read.supplierRequestId,
          now,
        });
        let action: ClosurePaymentAction = "none";
        if (decided.airline !== undefined) {
          action = decided.airline.captured ? "airline_charged" : "airline_not_ticketed";
        } else if (decided.capture !== undefined) {
          action = "capture_queued";
          await this.queueCapture(trx, tenant, id, decided.capture.id);
        }
        await this.finish(trx, tenant, body, {
          bookingId: id,
          before: current,
          after: { status: decided.result.status, reconcileOutcome: "found", recordLocator },
          payments: [
            {
              id: decided.airline?.paymentId ?? decided.capture?.id ?? null,
              action,
            },
          ],
          now: new Date(now.getTime() + 3),
        });
      });
    } catch (error) {
      if (uniqueViolation(error, ORDER_UNIQUE)) {
        // A concurrent import or closure of the same order committed first.
        const held = await this.tx.run((trx) =>
          this.heldBy(trx, tenant, id, {
            records: order.records.map((record) => ({
              reference: record.reference,
              originSystemCode: record.originSystemCode,
            })),
            orderIds: [order.id],
          }),
        );
        throw held === undefined ? error : orderHeldBy(held);
      }
      throw error;
    }
  }

  /**
   * The capture of a found order's Stripe payment through the payments job (see the file header): the record step's
   * safety net (`capture-retry-<pay_id>`, delayed CAPTURE_RETRY_DELAY_MS) added before the commit, then, after the
   * commit, the same job made to run now. Never throws.
   */
  private async queueCapture(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    paymentId: string,
  ): Promise<void> {
    const net = safetyNetJob("capture", tenant.tenantId, paymentId, CAPTURE_RETRY_DELAY_MS);
    const outcome = await addSafetyNet(this.paymentsQueue, net);
    if (outcome !== "added") {
      this.logger.warn(
        { bookingId, jobId: net.opts.jobId, outcome },
        "console.bookings.capture_net_not_queued",
      );
    }
    afterCommit(trx, () => this.captureNow(bookingId, net));
  }

  /**
   * Makes the capture job run now, after the commit: added without a delay when the net is missing (BullMQ ignores the
   * add while it holds the net), then promoted while it is delayed. A failure leaves the net, logged.
   */
  private async captureNow(bookingId: string, net: ReturnType<typeof safetyNetJob>): Promise<void> {
    try {
      await this.paymentsQueue.add(net.name, net.data, {
        jobId: net.opts.jobId,
        removeOnComplete: net.opts.removeOnComplete,
      });
      const job = await this.paymentsQueue.getJob(net.opts.jobId);
      if (job !== undefined && (await job.isDelayed())) {
        await job.promote();
      }
    } catch (error) {
      this.logger.warn(
        { bookingId, jobId: net.opts.jobId, err: error },
        "console.bookings.capture_not_promoted",
      );
    }
  }

  // ---- not_booked --------------------------------------------------------------------------------------------------

  /** T2 of `not_booked` (see the file header). */
  private async recordNotBooked(
    tenant: RequestTenant,
    claim: ReviewClaim,
    body: ReviewClosureRequest,
  ): Promise<void> {
    const id = claim.booking.id;
    await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const current = await this.lockInReview(trx, claim);
      const checkout =
        claim.checkoutId === null ? undefined : await this.checkouts.checkout(trx, claim.checkoutId);
      const booking = await this.reconcile.lock(trx, id, { skipLocked: false });
      if (booking === undefined) {
        throw new AppError("NOT_FOUND");
      }
      // The payments last (OADR-0003 point 11: the checkout, the booking, the payment).
      const payments = await this.reconcile.lockPayments(trx, id);
      const airlineCard = payments.some((payment) => payment.method === "airline_card");
      const settings = await this.bookings.settings(trx);
      const actor = eventActorOf(tenant.actor);
      const requestId = this.requestId(tenant);
      const { voidable } = await failNotFoundBooking(trx, this.decisionDeps(), {
        tenant: { key: tenant.key, defaultLocale: settings?.defaultLocale ?? "en" },
        booking,
        checkout,
        payments,
        settings,
        actor,
        failureMessage:
          "console.bookings.closeReview: the travel agency found no order after the reconciliation's review",
        failed: {
          summary: `Booking ${booking.reference} not confirmed: the travel agency found no order after the review.`,
          data: { code: "SUPPLIER_TIMEOUT", reconcileOutcome: "not_found", closedBy: "staff" },
        },
        traveller: airlineCard
          ? { summary: AIRLINE_CARD_NOT_CONFIRMED_SUMMARY, email: false }
          : { summary: NOT_CONFIRMED_SUMMARY, email: true },
        requestId,
        now,
      });
      const failed = await this.failAirlineCardPayments(trx, booking.id, payments, now);
      const event = closureEventOf({
        outcome: "not_booked",
        reference: booking.reference,
        recordLocator: null,
        airlineCard,
      });
      await this.recorder.event(trx, id, {
        type: event.type,
        actor,
        statusFrom: "pending",
        statusTo: "failed",
        summary: event.summary,
        data: { ...event.data, paymentVoidQueued: voidable.length > 0 },
        visibleToCustomer: false,
        requestId,
        // After the not-found decision's `booking.failed` and `booking.not_confirmed`.
        now: new Date(now.getTime() + 2),
      });
      await this.finish(trx, tenant, body, {
        bookingId: id,
        before: current,
        after: { status: "failed", reconcileOutcome: "not_found", recordLocator: null },
        payments: [
          ...voidable.map((payment) => ({ id: payment.id, action: "void_queued" as const })),
          ...failed.map((paymentId) => ({ id: paymentId, action: "airline_failed" as const })),
          ...(voidable.length + failed.length === 0 ? [{ id: null, action: "none" as const }] : []),
        ],
        now: new Date(now.getTime() + 3),
      });
      for (const payment of voidable) {
        // `payment.void` of the authorisation, on the account that created it (payments.processor.ts), after the commit.
        const job = paymentJob(PAYMENT_JOB.void, tenant.tenantId, payment.id);
        afterCommit(trx, () =>
          this.paymentsQueue.add(job.name, job.data, job.opts).then(
            () => undefined,
            (error: unknown) => {
              this.logger.warn({ paymentId: payment.id, err: error }, "console.bookings.enqueue_failed");
            },
          ),
        );
      }
    });
  }

  /**
   * The airline-card payments of a booking closed as not booked, locked by the caller: `failed` (`SUPPLIER_TIMEOUT`)
   * with a `payment.failed` event that names the booking and nothing of the card. Answers their ids.
   */
  private async failAirlineCardPayments(
    trx: TenantTransaction,
    bookingId: string,
    payments: readonly ReconcilePaymentRow[],
    now: Date,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const row of payments) {
      if (row.method !== "airline_card" || ["failed", "canceled", "captured"].includes(row.status)) {
        continue;
      }
      const payment = await this.payments.payment(trx, row.id, true);
      if (payment === undefined) {
        continue;
      }
      await this.payments.updatePayment(trx, payment.id, payment.version, {
        status: "failed",
        failure_code: "SUPPLIER_TIMEOUT",
        failure_message: null,
        updated_at: now,
      });
      await this.payments.insertEvent(trx, {
        id: this.ids.newId("pev"),
        payment_id: payment.id,
        type: "payment.failed",
        source: "api",
        status_from: payment.status,
        status_to: "failed",
        amount: payment.amount,
        currency: payment.currency,
        payload: JSON.stringify({ bookingId, code: "SUPPLIER_TIMEOUT", reason: "not_booked" }),
        created_at: now,
        updated_at: now,
      });
      ids.push(payment.id);
    }
    return ids;
  }

  // ---- Shared ------------------------------------------------------------------------------------------------------

  /**
   * T2's locks and checks (see the file header): the checkout, then the booking (`FOR UPDATE`), still in review in
   * that checkout at the version T1 checked. Answers the booking as T2 found it.
   */
  private async lockInReview(trx: TenantTransaction, claim: ReviewClaim): Promise<ReviewBookingRow> {
    if (claim.checkoutId !== null) {
      await this.checkouts.checkout(trx, claim.checkoutId, true);
    }
    await this.reconcile.lock(trx, claim.booking.id, { skipLocked: false });
    const current = await this.repository.booking(trx, claim.booking.id);
    if (current === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (!inReview(current) || current.checkoutId !== claim.checkoutId) {
      throw notInReview(current);
    }
    if (current.version !== claim.booking.version) {
      throw new AppError("PRECONDITION_FAILED", { details: { currentVersion: current.version } });
    }
    return current;
  }

  /** The staff note and the `staff_actions` row of a closure, in its T2. */
  private async finish(
    trx: TenantTransaction,
    tenant: RequestTenant,
    body: ReviewClosureRequest,
    closure: {
      readonly bookingId: string;
      readonly before: ReviewBookingRow;
      readonly after: {
        readonly status: string;
        readonly reconcileOutcome: string;
        readonly recordLocator: string | null;
      };
      readonly payments: readonly { readonly id: string | null; readonly action: ClosurePaymentAction }[];
      readonly now: Date;
    },
  ): Promise<void> {
    const note = body.note?.trim() ?? "";
    let noteId: string | null = null;
    if (note !== "") {
      noteId = this.ids.newId("evt");
      const actor = eventActorOf(tenant.actor);
      // As console.bookings.addNote writes a note: staff only, its text in the event (never in the staff action's
      // after), whose data passes the shared redactor.
      await this.bookings.insertEvent(trx, {
        id: noteId,
        booking_id: closure.bookingId,
        type: STAFF_NOTE_EVENT,
        actor_type: actor.type,
        actor_id: actor.id,
        summary: note,
        data: JSON.stringify(redactPayload({ text: note })),
        visible_to_customer: false,
        request_id: this.requestId(tenant),
        created_at: closure.now,
        updated_at: closure.now,
      });
    }
    await this.audit.record(trx, {
      action: REVIEW_CLOSE_ACTION,
      targetType: "booking",
      targetId: closure.bookingId,
      bookingId: closure.bookingId,
      reason: note === "" ? null : note,
      before: {
        status: closure.before.status,
        reconcileOutcome: closure.before.reconcileOutcome,
        version: closure.before.version,
      },
      after: {
        outcome: body.outcome,
        ...closure.after,
        payments: closure.payments,
        noteId,
      },
    });
  }

  /** The providers the reconciliation's decisions write with, the API's (OBE-099). */
  private decisionDeps(): ReconcileDecisionDeps & NotConfirmedEmailDeps {
    return {
      bookings: this.bookings,
      checkouts: this.checkouts,
      payments: this.payments,
      recorder: this.recorder,
      ids: this.ids,
      outbox: this.outbox,
      reconcile: this.reconcile,
      baseDomain: this.baseDomain,
      onEmailRefused: (bookingId) => {
        this.logger.error(
          { bookingId, template: "booking.not_confirmed" },
          "console.bookings.review_email_invalid",
        );
      },
    };
  }

  /** The call context of the by-reference read: the booking and its queuing office (the reconciliation's own). */
  private callContext(tenant: RequestTenant, booking: ReviewBookingRow): AmadeusCallContext {
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: REVIEW_CLOSE_OPERATION,
      requestId: this.requestId(tenant),
      bookingId: booking.id,
      ...(tenant.actor.type === "staff" && tenant.actor.id !== null ? { staffId: tenant.actor.id } : {}),
      ...(booking.queuingOfficeId === null ? {} : { orderOffice: booking.queuingOfficeId }),
    };
  }

  private requestId(tenant: RequestTenant): string {
    return this.tenants.requestId() ?? tenant.requestId;
  }
}

/** The API code of a failed call, for the log. */
function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : "INTERNAL_ERROR";
}
