// bookings.quoteCancellation and bookings.cancel (quoteBookingCancellation, cancelBooking, `x-scope: customer`; OBE-049,
// OF-08 AC2; ota/docs/flows/change-and-cancel.md §2, §3 steps 3–7, §4, OADR-0003 point 7): what the owning customer,
// or the guest holding the booking's token, may cancel of a booking themselves, and the money that goes back. The
// booking access guard let the request in (`BookingAccessContext.require`); the validation interceptor checked the
// input. The mode and the refund estimate are cancellation-mode.ts's (pure).
//
// **Quote** (`quote`). The booking's order is read again first, with its refund fare rules: the refresh of
// CustomerBookingsService (Flight Order Management GET `fareRules=refunds`, throttled to one per booking and minute
// with bookings.get and getFareRules; a throttled call uses the stored order), which records the snapshot and the
// tickets. Then, read in one transaction: the mode (cancellation-mode.ts), the payment the money step would act on
// (`moneyOf`: a Stripe payment `captured`/`partially_refunded`, else one `authorized`, else an airline-card payment),
// the booking's non-refundable fees (its priced offer's pricing snapshot, `keptFeesOf`; every OTA fee of the booking
// when the snapshot cannot be read), the `cancellation` fees of the markup and fee engine on the booking total
// (OADR-0005 point 7; the facts come from the booking's own rows, `pricingInputOfBooking`) and the payment's card fee
// unless its stored line is refundable (card-fees.ts `keptCardFeeOf`; lead decision (2) of 2026-10-23, second batch,
// FIX-W28-CANCEL), the estimate split over the
// travellers, and the REFUND and CANCELLATION fare rules behind it (customer scope: the airline's `refundingPreview`
// is net and never shown). The quote is cached for 10 minutes in `t:<tenantId>:<env>:cxq:<bookingId>` (the contract's
// `cxq:{bookingId}` under the tenant prefix every tenant key has, redis.keys.ts) with the booking's `version`; a Redis
// that does not answer only loses the cache.
//
// **Cancel** (`cancel`), `If-Match` and `Idempotency-Key` (the interceptor replays a stored answer, and a same-key
// request waits for the first one, so the handler runs once per key):
//
//   1. Checks without a lock (T0), so that a stale request costs no Amadeus call: `409 BOOKING_ALREADY_CANCELLED`,
//      `412 PRECONDITION_FAILED` (`details.currentVersion`), `403 FEATURE_DISABLED` (`details.feature =
//      "selfServiceCancellation"`) when the storefront has self-service cancellation off, `409 BOOKING_NOT_MODIFIABLE`
//      (`details.reason = "pending"`) while an earlier cancellation is undecided (a DELETE without an answer, below) or
//      a cancellation request waits for the staff.
//   2. The quote: the cached one when it was made for the booking's current `version` and is still valid (a void
//      window that has closed is not, nor is a `not_allowed` quote: quoteValid), else a new one (the refresh above; a
//      timeout of that read answers `503 SUPPLIER_UNAVAILABLE`, as nothing was sent that could cancel). `not_allowed`
//      answers its reason (`409 BOOKING_NOT_MODIFIABLE`, `details.reason`, `details.action = "canCancel"`). A missing
//      or different `expectedRefund` answers `409 REFUND_AMOUNT_CHANGED` with `details.expectedRefund` and
//      `details.newRefund`, and nothing is cancelled.
//   3. The claim (T1): the booking locked `FOR NO KEY UPDATE SKIP LOCKED` (OADR-0014 point 6, lead addition to OBE-049:
//      a booking another claim or writer holds is skipped and answered `503 SERVICE_UNAVAILABLE` with `Retry-After`
//      (`retryAfterOf`, lead decision (8) of 2026-10-23, second batch), which the idempotency layer does not keep, so
//      the same key can be sent again; a transaction that only holds the booking's `FOR KEY
//      SHARE`, the foreign-key lock of an event, outbox or document insert, never makes it skip), every check of step 1
//      again against the locked row (and the quote's `version`), then `version + 1`, its marker. A second request with
//      the same ETag (another key, another tab) answers `503` while T1 holds the booking and `412` once it committed, so
//      Flight Order Management DELETE is sent once per version. In `request_only` mode T1 records the request itself
//      (below) and answers `202`.
//   4. `release` and `void`: Flight Order Management DELETE with no transaction open (OADR-0003 point 1):
//      - `204`: the record step (T2, `CancellationRecorder.recordCancelled`) and the money step in the same
//        transaction, then `200`; a T2 that fails (the order is gone, nothing was recorded) is answered and decided like
//        an unknown outcome (below, the flag's `reason` is `record_failed`), never a `500`;
//      - Amadeus 2552: `409 VERSION_CONFLICT`, nothing recorded;
//      - a business refusal of the airline (an Amadeus `4xx` of OADR-0003 point 9's refusals, such as tickets outside
//        the void window) and an order Amadeus no longer has (`404`, cancelled or purged outside Velexis: the staff
//        check it, no money moves) become a request (`recordRequest`, `202`);
//      - an error raised before the request left the backend, or a `401`/`403`/`429` that Amadeus refused it with
//        (OADR-0003 point 9, "not sent"): its code, nothing recorded (a timeout of the token request as
//        `503 SUPPLIER_UNAVAILABLE`);
//      - an unknown outcome (a timeout, an Amadeus `5xx`, a cut connection: the order may be cancelled): the booking is
//        flagged (`recordUnknownOutcome`: the staff event `booking.cancellation_timeout` with what was asked and the
//        deadline, 15 minutes), `booking.cancellation_check` is queued for the worker (first run 30 s later) and the
//        answer is `504 SUPPLIER_TIMEOUT` (`details.bookingId`), which the idempotency layer keeps with the booking. A
//        same-key retry never calls Amadeus (CancelBookingIdempotencyHooks): it replays the `504`
//        (`details.replayed: true`) until the worker decides, then the final `200` (the booking cancelled by this
//        request) or the final error (`502 SUPPLIER_ERROR`: the airline did not cancel; `409
//        BOOKING_ALREADY_CANCELLED`: someone else did).
//   5. The answer: CancellationResult (`cancellation`, and the booking in customer scope with that cancellation) with
//      the booking's new `ETag`; `200` when cancelled, `202` when pending. The cancellation is the block bookings.get
//      shows (bookings.mapper.ts `cancellationOf`, FIX-W28-CANCEL), so both always say the same.
//
// **Record** (`CancellationRecorder.recordCancelled`, T2 of the request and of the worker's check; the booking locked
// `FOR NO KEY UPDATE` by the caller and still live): `cancelled`, `cancelled_at`, `cancelled_by = customer`,
// `cancel_reason` (the typed reason code), no further ticketing attempt, `version + 1`; every segment `CANCELLED`,
// every ticket that still held a seat `VOID` (the order is gone: a DELETE Amadeus accepted voided them), the booked
// services `cancelled`; the customer-visible event `booking.cancelled` through OrderRecorder.event (the cancelled
// itinerary follows it, OBE-053); the traveller's `booking.cancelled` e-mail with the refund (once per booking). Then
// the money step, once: the status changes in the same transaction and every caller checks it under the lock first.
//
//   Stripe, captured     a `refunds` row (RefundsRepository.create, OBE-040: `pending`, the reason from the reason code,
//                        `requested_by` the customer) for the estimate (never more than can still be refunded), the
//                        customer-visible booking event `refund.requested` (lead decision 6 of 2026-10-22: worded as
//                        asked for; only Stripe's answer, the webhook's `refund.succeeded`, says it was refunded), and
//                        `refund.submit` queued after the commit (its claim and the key `refund:<rfd_id>` make one
//                        Stripe refund of any number of jobs). `refundStatus: pending`. A refund the repository refuses
//                        (refunded meanwhile) alerts the staff: `manual_review`, the cancellation stands
//   Stripe, authorised   lead decision (1) of 2026-10-23, second batch (FIX-W28-CANCEL): the amount the OTA keeps (the
//                        authorisation less the estimate: `authorisationSettlementOf`) is captured after the commit
//                        (`captureKept`, `pi:capture:<pay_id>:cancellation:<amount>`) and Stripe releases the rest;
//                        what Stripe reports is recorded with the capture paths' events and the release (a `refunds`
//                        row `succeeded`, RefundsRepository.recordRelease, and `refund.succeeded`). A capture that
//                        fails is recorded, alerted and retried by `payment.capture_retry` 10 minutes later; it never
//                        undoes the cancellation. `refundStatus: pending`, then `succeeded` with the release as
//                        `refund` (`manual_review` when the retry gives up). Only an authorisation of which nothing is
//                        kept is voided after the commit (`pi:cancel:<pay_id>`, `payment.voided`; a void that fails is
//                        queued as `payment.void`, OBE-040): `refundStatus: authorization_voided`, `pending` while it is
//                        queued. The event's `voidPaymentId`, or `capturePaymentId`, `captureAmount` and
//                        `releaseAmount`, let a later answer (a replay after a `504`, bookings.get) and the capture
//                        retry read which it is
//   airline card         `payment_events` `airline.void_expected` only (the airline reverses its charge; no Stripe
//                        call, no `refunds` row). `refundStatus: not_applicable`
//
// Lock order (OADR-0003 point 11: checkout, booking, payment, refund; a foreign-key lock counts as a lock of the
// parent). No transaction here locks the checkout. T1 claims the booking `FOR NO KEY UPDATE SKIP LOCKED`, T2 locks it
// `FOR NO KEY UPDATE` and waits (OADR-0014 point 6: the foreign-key `FOR KEY SHARE` of another transaction's event,
// outbox or document insert never conflicts with either);
// T2's refund request locks the payment after it (RefundsRepository.create), then inserts the refund; the payment
// event of an airline card references the payment after the booking. The void's record locks the payment only. The
// capture of a kept amount locks the booking `FOR UPDATE` (its `amount_paid`), then the payment, then inserts the
// release's refund row; its failure locks the booking `FOR KEY SHARE` (events, the alert's outbox row), then the
// payment. The worker's check claims the booking `FOR NO KEY UPDATE SKIP LOCKED` (a booking another transaction holds
// is checked at its next run) before its money step.
//
// **Request** (`recordRequest`: `request_only`, a refusal, an order not found): the booking stays as it is
// (`version + 1`); the customer-visible event `booking.cancellation_requested`, the traveller's
// `booking.cancellation_requested` e-mail and a staff alert (`staff.manual_review` through StaffAlerts to
// `ops_alert_email`, else the owners, else, in the worker, Velexis ops: notifications/staff-recipients.ts; flow §3 step
// 6). The staff finish it from the console. `refundStatus: manual_review` (paid) or
// `not_applicable`.
//
// **The worker's check** (`booking.cancellation_check {tenantId, bookingId}` on `ota-bookings`, CancellationChecks,
// handed over by the queue's consumer reconcile.processor.ts): the claim (`FOR NO KEY UPDATE SKIP LOCKED`, a booking
// still live with an undecided flag), Flight Order Management GET with no transaction open, then under the lock again:
// an order Amadeus no longer has (`404`) or whose every segment is `CANCELLED` was cancelled by the DELETE: the record
// step and the money step as after a `204`; an order still active was not: the staff event
// `booking.cancellation_not_applied` (the customer may try again); a read that fails leaves it undecided and the job
// comes back a minute later, until the deadline (15 minutes after the DELETE), when the staff event
// `booking.cancellation_manual_review` and a staff alert hand it to the staff. A booking someone else cancelled
// meanwhile ends the check (the staff alert of that path covers the money). A lost enqueue of the first check is swept
// by `bookings.reconcile_scan` (reconcile.processor.ts, FIX-W28-CANCEL), under the flag's own job id, and a chain that
// lost a later check (a flag still undecided 5 minutes after its deadline) gets its last check (run
// CANCELLATION_CHECK_MAX_RUNS) from the same scan.
//
// Log lines carry ids, modes and codes, never an amount with a person's data, an address or an Amadeus body.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import { sql } from "@velexis/db";
import { AppError, isAppError, toErrorEnvelope, type OtaErrorCode } from "@velexis/errors";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { BookingAccessContext } from "../common/auth/booking-access.guard";
import { Clock } from "../common/clock";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotencyRecord,
  type IdempotencyResource,
  type IdempotencyResponse,
} from "../common/http/idempotency.service";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { CANCELLATION_QUOTE_TTL_SECONDS, redisKeys, type RedisKey } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { SharedConfig } from "../config";
import { jobTenant } from "../jobs/fan-out";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import { AIRLINE_PROVIDER } from "../payments/airline-card/airline-card.gateway";
import {
  PAYMENT_GATEWAY,
  type GatewayContext,
  type GatewayPayment,
  type GatewayState,
  type PaymentGateway,
} from "../payments/payment-gateway";
import { providerStateUpdate } from "../payments/payment-state";
import { keptCardFeeOf } from "../payments/card-fees";
import { cancellationCaptureRetryJob, PAYMENT_JOB, paymentJob } from "../payments/payments.processor";
import { PaymentsRepository, type PaymentRow } from "../payments/payments.repository";
import {
  REFUNDABLE_PAYMENT_STATUSES,
  refundableAmount,
  RefundsRepository,
  type RefundReason,
} from "../payments/refunds.repository";
import { priceOffer } from "../pricing/pricing-engine";
import {
  Money,
  PricingInputError,
  TRIP_TYPES,
  type MoneyValue,
  type PricingInput,
  type TripType,
} from "../pricing/pricing.types";
import { RulesRepository } from "../pricing/rules.repository";
import { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext, type ContextActor, type RequestTenant } from "../tenancy/tenant-context";
import { afterCommit, TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  CAPTURE_RETRY_DELAY_MS,
  createFailureKind,
  pendingBookingOf,
  replayedTimeout,
} from "./booking-orchestrator.service";
import {
  bookingEtagOf,
  snapshotOffersOf,
  storedFareRulesOf,
  toBookingFareRules,
  type BookingFareRule,
} from "./bookings.mapper";
import { BookingsRepository, type BookingChildren, type BookingRow } from "./bookings.repository";
import {
  cancellationModeOf,
  expectedRefundMatches,
  keptFeesOf,
  refundEstimateOf,
  refundLinesOf,
  SETTLED_TICKET_STATUSES,
  type CancellationMode,
  type EstimatePayment,
  type LineTraveler,
  type NotAllowedReason,
  type RefundEstimate,
} from "./cancellation-mode";
import {
  CANCELLATION_EVENTS,
  cancellationEventsOf,
  cancellationStateOf,
  cancelledEventOf,
  flagOf,
  undecidedFlags,
  type CancellationEventRow,
  type CancellationFlag,
  type CancellationState,
  type UndecidedFlagRow,
} from "./cancellation-state";
import { CustomerBookingsService, ORDER_NOT_FOUND_WARNING } from "./customer-bookings.service";
import { eventActorOf, OrderRecorder, type Booking, type Warning } from "./order-recorder";
import { StaffAlerts } from "./staff-alerts";
import { jobRequestId } from "./ticketing.processor";

// The cancellation's events and state moved to cancellation-state.ts (FIX-W28-CANCEL: bookings.get reads them too); they
// are still read from here.
export {
  CANCELLATION_EVENTS,
  cancellationStateOf,
  flagOf,
  type CancellationEventRow,
  type CancellationFlag,
  type CancellationState,
};

type Schemas = components["schemas"];
export type CancellationQuote = Schemas["CancellationQuote"];
export type CancellationRequest = Schemas["CancellationRequest"];
export type Cancellation = Schemas["Cancellation"];
export type CancellationResult = Schemas["CancellationResult"];
type MoneyAmount = Schemas["Money"];
type CancellationReasonCode = Schemas["CancellationReason"];
type RefundStatus = Cancellation["refundStatus"];
type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

// ---- Names ----------------------------------------------------------------------------------------------------------

/** `supplier_requests.operation` of the quote's read, the cancellation's DELETE, and the worker's check. */
export const QUOTE_OPERATION = "bookings.quoteCancellation";
export const CANCEL_OPERATION = "bookings.cancel";
export const CANCELLATION_CHECK_OPERATION = "booking.cancellationCheck";

/** The job of the worker's check after a DELETE without an answer (`ota-bookings`). */
export const CANCELLATION_CHECK_JOB = "booking.cancellation_check";

/** `Cache-Control` of both operations (the document: `no-store`). */
export const CANCELLATION_CACHE_CONTROL = "no-store";

/** `details.feature` of `403 FEATURE_DISABLED` when the storefront has self-service cancellation off. */
export const SELF_SERVICE_CANCELLATION_FEATURE = "selfServiceCancellation";

/** The `payment_events.type` of an airline-card booking's cancellation (flow §3 step 5). */
export const AIRLINE_VOID_EXPECTED_EVENT = "airline.void_expected";

/** How long after a DELETE without an answer the worker looks for its outcome (OADR-0003 point 7: 15 minutes). */
export const CANCELLATION_CHECK_WINDOW_MS = 15 * 60_000;
/** The first check comes 30 s after the DELETE, the next ones a minute apart. */
export const CANCELLATION_CHECK_FIRST_DELAY_MS = 30_000;
export const CANCELLATION_CHECK_INTERVAL_MS = 60_000;

/** The refunds reason of each customer reason code (CancellationReason's description). */
export function refundReasonOf(reasonCode: string): RefundReason {
  if (reasonCode === "schedule_change") {
    return "schedule_change";
  }
  return reasonCode === "duplicate_booking" ? "duplicate" : "customer_request";
}

/** The codes of the client's errors bookings.cancel passes on; any other becomes `502 SUPPLIER_ERROR`. */
const DOCUMENTED_SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  "VERSION_CONFLICT",
  "SUPPLIER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "SUPPLIER_ERROR",
  "SERVICE_UNAVAILABLE",
  "SUPPLIER_UNAVAILABLE",
]);

/** A BCP 47 tag the outbox accepts as a locale (outbox.service.ts). */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** Redis connection states in which the cache is skipped. */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

/** A tenant id and a booking id (the OTA document's `bkg_…` pattern, as documents.processor.ts reads its jobs). */
const TENANT_ID = /^ten_[0-9A-Za-z]{1,60}$/;
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;

/** The statuses of a booking that can still be cancelled. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["confirmed", "ticketed", "partially_ticketed"]);

// ---- Pure helpers ---------------------------------------------------------------------------------------------------

/** `amount` in `currency` with the currency's minor units. */
function money(amount: string, currency: string, minorUnits: number): MoneyAmount {
  return { amount: new Money(amount).toFixed(minorUnits), currency };
}

/** The storefront switches a cancellation reads (`storefront_settings.features`). */
export function selfServiceCancellationOf(features: unknown): boolean {
  // Off unless the OTA turns it on: a cancellation moves money (customer-bookings.service.ts featuresOf).
  return isRecord(features) && features["selfServiceCancellation"] === true;
}

/** The payment the money step acts on, and what the estimate sees of it (see the file header). */
export interface MoneyPayment {
  readonly row: PaymentRow;
  readonly estimate: EstimatePayment;
}

/**
 * The payment of a booking the money step acts on: a Stripe payment `captured` or `partially_refunded` with something
 * left to refund (`inFlight`: its refunds `pending` or `processing`), else a Stripe payment `authorized`, else an
 * airline-card payment the airline charged; `undefined` when none.
 */
export function moneyOf(
  payments: readonly PaymentRow[],
  inFlight: ReadonlyMap<string, string>,
): MoneyPayment | undefined {
  for (const row of payments) {
    if (row.provider === "stripe" && REFUNDABLE_PAYMENT_STATUSES.includes(row.status)) {
      const refundable = refundableAmount(row, inFlight.get(row.id) ?? "0");
      if (new Money(refundable).greaterThan(0)) {
        return { row, estimate: { kind: "stripe_captured", captured: row.amountCaptured, refundable } };
      }
    }
  }
  const authorised = payments.find((row) => row.provider === "stripe" && row.status === "authorized");
  if (authorised !== undefined) {
    return {
      row: authorised,
      estimate: { kind: "stripe_authorized", authorized: authorised.amountAuthorized },
    };
  }
  const airline = payments.find(
    (row) => row.provider === AIRLINE_PROVIDER && (row.status === "captured" || row.status === "authorized"),
  );
  return airline === undefined
    ? undefined
    : { row: airline, estimate: { kind: "airline", charged: airline.amountCaptured } };
}

/**
 * The facts of the booking for the markup and fee engine (OADR-0005 point 2), from its own rows, so a booking whose
 * priced offer is gone is priced the same way: the net amount, the route and its countries, the carriers and cabins of
 * its segments, its travellers by type, the trip type and the channel.
 */
export function pricingInputOfBooking(input: {
  readonly booking: BookingRow;
  readonly children: BookingChildren;
  readonly countryOf: (code: string) => string | null;
  readonly minorUnits: number;
  readonly at: Date;
}): PricingInput {
  const { booking, children } = input;
  const segments = children.segments;
  const origin = booking.originIata ?? segments[0]?.departureIata ?? "";
  const destination = booking.destinationIata ?? segments.at(-1)?.arrivalIata ?? "";
  const travelers: Record<string, number> = {};
  for (const traveler of children.travelers) {
    travelers[traveler.travelerType] = (travelers[traveler.travelerType] ?? 0) + 1;
  }
  const distinct = (values: readonly (string | null)[]): string[] =>
    [...new Set(values.filter((value): value is string => value !== null && value !== ""))].sort();
  return {
    at: input.at,
    currency: booking.currency,
    minorUnits: input.minorUnits,
    netTotal: new Money(booking.netAmount).toFixed(input.minorUnits),
    origin,
    destination,
    originCountry: input.countryOf(origin),
    destinationCountry: input.countryOf(destination),
    validatingCarriers: distinct([booking.validatingCarrier]),
    marketingCarriers: distinct(segments.map((segment) => segment.carrierCode)),
    cabins: distinct(segments.map((segment) => segment.cabin)),
    travelers: Object.keys(travelers).length === 0 ? { ADULT: 1 } : travelers,
    segmentCount: Math.max(1, segments.length),
    tripType: (TRIP_TYPES as readonly string[]).includes(booking.tripType ?? "")
      ? (booking.tripType as TripType)
      : "one_way",
    source: booking.originSystemCode ?? "GDS",
    channel: booking.channel === "console" ? "console" : "storefront",
  };
}

/** Each traveller's total over the snapshot's offers (`travelerPricings[].price.total`), the weights of the lines. */
function travelerTotalsOf(snapshot: unknown): Map<string, string> {
  const totals = new Map<string, MoneyValue>();
  for (const offer of isRecord(snapshot) ? records(snapshot["flightOffers"]) : []) {
    for (const pricing of records(offer["travelerPricings"])) {
      const id = text(pricing["travelerId"]);
      const price = isRecord(pricing["price"]) ? text(pricing["price"]["total"]) : undefined;
      if (id !== undefined && price !== undefined && /^\d+(?:\.\d+)?$/.test(price)) {
        totals.set(id, (totals.get(id) ?? new Money(0)).plus(price));
      }
    }
  }
  return new Map([...totals].map(([id, total]) => [id, total.toString()]));
}

/** The travellers of the booking as its refund lines show them (lines of a ticketed booking name the ticket). */
function lineTravelersOf(children: BookingChildren, snapshot: unknown): LineTraveler[] {
  const totals = travelerTotalsOf(snapshot);
  return children.travelers.map((traveler) => ({
    travelerId: traveler.amadeusTravelerId,
    travelerName: `${traveler.firstName} ${traveler.lastName}`,
    ticketNumber:
      children.tickets.find(
        (ticket) =>
          ticket.amadeusTravelerId === traveler.amadeusTravelerId &&
          ticket.documentType === "ETICKET" &&
          !SETTLED_TICKET_STATUSES.has(ticket.status),
      )?.documentNumber ?? null,
    weight: totals.get(traveler.amadeusTravelerId) ?? "0",
  }));
}

/** The answer's refund status of a cancellation that was handed to the staff. */
const requestRefundStatus = (estimate: RefundEstimate): RefundStatus =>
  new Money(estimate.amountPaid).greaterThan(0) ? "manual_review" : "not_applicable";

/** `409 BOOKING_NOT_MODIFIABLE` for a booking that cannot be cancelled, with its reason. */
function notCancellable(reason: NotAllowedReason): AppError {
  if (reason === "cancelled") {
    return new AppError("BOOKING_ALREADY_CANCELLED");
  }
  if (reason === "disabled_by_ota") {
    return new AppError("FEATURE_DISABLED", {
      message: "This booking cannot be cancelled online: please contact the travel agency.",
      details: { feature: SELF_SERVICE_CANCELLATION_FEATURE },
    });
  }
  return new AppError("BOOKING_NOT_MODIFIABLE", {
    message:
      reason === "flown"
        ? "This trip has started: the booking can no longer be cancelled online."
        : reason === "too_close_to_departure"
          ? "The flight leaves too soon to cancel online: please contact the travel agency."
          : "The booking cannot be cancelled online right now.",
    details: { reason, action: "canCancel" },
  });
}

/** The cause of the `503` of a booking another claim or writer holds (`bookingBusy`). */
export class BookingBusyError extends Error {
  override readonly name = "BookingBusyError";
}

/** The `Retry-After` of that `503`: the claims' and writers' transactions hold a booking for a moment only. */
export const BOOKING_BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * The claim found the booking held by another claim or writer (`FOR NO KEY UPDATE SKIP LOCKED`, OADR-0014 point 6): a
 * transient `503` with `Retry-After` (lead decision (8) of 2026-10-23, second batch), which the idempotency layer does
 * not keep, so the same key can be sent again a moment later.
 */
const bookingBusy = (): AppError =>
  new AppError("SERVICE_UNAVAILABLE", {
    message: "The booking is being updated. Please try again in a moment.",
    cause: new BookingBusyError("another claim or writer holds the booking"),
  });

/** The seconds of `Retry-After` of a bookings.cancel error, or `undefined` when it has none (the controller's). */
export function retryAfterOf(error: unknown): number | undefined {
  return isAppError(error) && error.cause instanceof BookingBusyError
    ? BOOKING_BUSY_RETRY_AFTER_SECONDS
    : undefined;
}

/** The cancellation of a booking is undecided, or waits for the staff: no second one until it is settled. */
const cancellationPending = (): AppError =>
  new AppError("BOOKING_NOT_MODIFIABLE", {
    message: "A cancellation of this booking is already being processed.",
    details: { reason: "pending", action: "canCancel" },
  });

/** How a Flight Order Management DELETE ended (see the file header). */
export type DeleteOutcome =
  | { readonly kind: "cancelled"; readonly supplierRequestId: string | null }
  | { readonly kind: "order_not_found" }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "version_conflict"; readonly error: unknown }
  | { readonly kind: "not_sent"; readonly error: unknown }
  | { readonly kind: "unknown"; readonly error: unknown };

/** The outcome of a DELETE that failed with `error` (OADR-0003 point 9, applied to a cancellation). */
export function deleteFailureOf(error: unknown): DeleteOutcome {
  if (isAppError(error) && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404) {
    return { kind: "order_not_found" };
  }
  if (isAppError(error) && error.code === "VERSION_CONFLICT") {
    return { kind: "version_conflict", error };
  }
  const kind = createFailureKind(error);
  if (kind === "rejected") {
    return { kind: "refused", code: isAppError(error) ? error.code : "SUPPLIER_REJECTED" };
  }
  return kind === "not_sent" ? { kind: "not_sent", error } : { kind: "unknown", error };
}

/**
 * The answer of an error that changed nothing at Amadeus, in the operation's codes: a timeout (of the token request,
 * or of the quote's read) is `503 SUPPLIER_UNAVAILABLE` (a `504` would tell the client a cancellation may have
 * happened), an office the connection may not use `424 SUPPLIER_NOT_CONFIGURED`, the documented codes as they are,
 * any other `502 SUPPLIER_ERROR`.
 */
export function unsentAnswer(error: unknown): unknown {
  if (!isAppError(error)) {
    return error;
  }
  if (error.code === "SUPPLIER_TIMEOUT") {
    return new AppError("SUPPLIER_UNAVAILABLE", { cause: error });
  }
  if (error.code === "OFFICE_NOT_ALLOWED") {
    return new AppError("SUPPLIER_NOT_CONFIGURED", { cause: error });
  }
  if (DOCUMENTED_SUPPLIER_CODES.has(error.code)) {
    return error;
  }
  return new AppError("SUPPLIER_ERROR", {
    ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
    cause: error,
  });
}

/** `504 SUPPLIER_TIMEOUT` of a DELETE without an answer, linked to its booking for the replays. */
function cancellationTimeout(bookingId: string, cause: unknown): AppError {
  return new AppError("SUPPLIER_TIMEOUT", {
    message:
      "The airline did not confirm in time. We are checking the booking; do not repeat the request with a new key.",
    details: { bookingId, replayed: false },
    cause,
  });
}

/** The final error of a cancellation whose DELETE the worker found was not applied. */
export function cancellationNotApplied(bookingId: string): AppError {
  return new AppError("SUPPLIER_ERROR", {
    message: "The airline did not cancel the booking. Nothing was changed or refunded; you can try again.",
    details: { bookingId, cancellation: "not_applied" },
  });
}

// ---- The quote cache ------------------------------------------------------------------------------------------------

/** A cached quote: the answer, and the booking version it was made for. */
export interface CachedQuote {
  readonly v: 1;
  readonly version: number;
  readonly quote: CancellationQuote;
}

function decodeCachedQuote(raw: string, bookingId: string): CachedQuote | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) &&
      value["v"] === 1 &&
      Number.isInteger(value["version"]) &&
      isRecord(value["quote"]) &&
      value["quote"]["bookingId"] === bookingId
      ? (value as unknown as CachedQuote)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a cached quote still answers for the booking at `version` and `now`. A `not_allowed` quote never does: what
 * made it so (a cancellation undecided when it was made, decided since by the worker) can change without the booking's
 * `version`, so bookings.cancel computes it again.
 */
export function quoteValid(cached: CachedQuote, version: number, now: Date): boolean {
  const { quote } = cached;
  return (
    cached.version === version &&
    quote.mode !== "not_allowed" &&
    Date.parse(quote.expiresAt) > now.getTime() &&
    (quote.voidDeadlineAt === null ||
      quote.voidDeadlineAt === undefined ||
      Date.parse(quote.voidDeadlineAt) > now.getTime())
  );
}

// ---- The repository -------------------------------------------------------------------------------------------------

/**
 * The storefront settings a cancellation reads. No alert address: StaffRecipients chooses the recipients of a staff
 * alert (notifications/staff-recipients.ts, OADR-0013).
 */
export interface CancellationSettingsRow {
  readonly features: unknown;
  readonly timeZone: string;
  readonly defaultLocale: string;
}

/**
 * What a cancellation reads and writes besides BookingsRepository and PaymentsRepository. Like every tenant repository
 * it takes the `tenantTx` transaction first and never names a tenant schema.
 */
@Injectable()
export class CancellationRepository {
  /**
   * Locks the booking `FOR NO KEY UPDATE` (waiting, or `SKIP LOCKED` for a claim); answers whether it holds it. The
   * caller reads the row in a statement after the lock, so it sees what a transaction it waited for committed.
   */
  async lock(trx: TenantTransaction, bookingId: string, skipLocked = false): Promise<boolean> {
    const query = trx.selectFrom("bookings").select("id").where("id", "=", bookingId).forNoKeyUpdate();
    const row = await (skipLocked ? query.skipLocked() : query).executeTakeFirst();
    return row !== undefined;
  }

  async settings(trx: TenantTransaction): Promise<CancellationSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select(["features", "time_zone as timeZone", "default_locale as defaultLocale"])
      .executeTakeFirst();
  }

  /** The stored answer of a priced offer (`priced_offers.response`), `undefined` once it is purged. */
  async pricedOfferResponse(trx: TenantTransaction, pricedOfferId: string): Promise<unknown> {
    const row = await trx
      .selectFrom("priced_offers")
      .select("response")
      .where("id", "=", pricedOfferId)
      .executeTakeFirst();
    return row?.response ?? undefined;
  }

  /** The events of a cancellation's state (CANCELLATION_EVENTS but `cancelled`), newest first, at most 50. */
  async cancellationEvents(trx: TenantTransaction, bookingId: string): Promise<CancellationEventRow[]> {
    return await cancellationEventsOf(trx, bookingId);
  }

  /** The newest `booking.cancelled` event of the booking, or `undefined`. */
  async cancelledEvent(trx: TenantTransaction, bookingId: string): Promise<CancellationEventRow | undefined> {
    return await cancelledEventOf(trx, bookingId);
  }

  /** The live bookings whose cancellation flag is undecided (cancellation-state.ts `undecidedFlags`). */
  async undecidedFlags(
    trx: TenantTransaction,
    window: Parameters<typeof undecidedFlags>[1],
  ): Promise<UndecidedFlagRow[]> {
    return await undecidedFlags(trx, window);
  }

  /** The cancellation recorded on the booking, `version + 1` (see the file header). */
  async markCancelled(
    trx: TenantTransaction,
    bookingId: string,
    values: { readonly reasonCode: string; readonly now: Date },
  ): Promise<void> {
    await trx
      .updateTable("bookings")
      .set({
        status: "cancelled",
        cancelled_at: values.now,
        cancelled_by: "customer",
        cancel_reason: values.reasonCode,
        ticketing_status: sql<string>`case when ticketing_status in ('pending', 'in_progress', 'failed',
          'manual_review') then 'not_applicable' else ticketing_status end`,
        ticketing_next_attempt_at: null,
        updated_at: values.now,
        version: sql`version + 1`,
      })
      .where("id", "=", bookingId)
      .execute();
  }

  /** Every segment `CANCELLED`, every ticket that held a seat `VOID`, every booked service `cancelled`. */
  async cancelChildren(trx: TenantTransaction, bookingId: string, now: Date): Promise<number> {
    await trx
      .updateTable("booking_segments")
      .set({ status: "CANCELLED", updated_at: now })
      .where("booking_id", "=", bookingId)
      .where("status", "<>", "CANCELLED")
      .execute();
    const voided = await trx
      .updateTable("booking_tickets")
      .set({ status: "VOID", updated_at: now })
      .where("booking_id", "=", bookingId)
      .where("status", "not in", [...SETTLED_TICKET_STATUSES])
      .executeTakeFirst();
    await trx
      .updateTable("booking_ancillaries")
      .set({ status: "cancelled", updated_at: now })
      .where("booking_id", "=", bookingId)
      .where("status", "in", ["requested", "confirmed", "issued"])
      .execute();
    return Number(voided.numUpdatedRows);
  }

  /** `version + 1` (the claim of a cancellation, and the record of a request). */
  async bumpVersion(trx: TenantTransaction, bookingId: string, now: Date): Promise<void> {
    await trx
      .updateTable("bookings")
      .set({ updated_at: now, version: sql`version + 1` })
      .where("id", "=", bookingId)
      .execute();
  }
}

// ---- The record step and the money step (both processes) ------------------------------------------------------------

/** What a cancellation was asked with: the quote's mode and estimate, and who asked. */
export interface CancellationAsk {
  readonly mode: CancellationMode;
  readonly reasonCode: string;
  readonly comment: string | null;
  readonly estimate: RefundEstimate;
  readonly currency: string;
  readonly actor: ContextActor;
  /** When the customer asked (the request's time). */
  readonly requestedAt: Date;
}

/** What the record step did with the money. */
export interface RecordedMoney {
  readonly refundStatus: RefundStatus;
  /** The `refunds` row asked for (`pending`). */
  readonly refund: {
    readonly id: string;
    readonly paymentId: string;
    readonly amount: string;
    readonly currency: string;
  } | null;
  /** The Stripe payment to void after the commit (an authorisation of which nothing is kept). */
  readonly voidPayment: PaymentRow | null;
  /** The Stripe authorisation of which the kept amount is captured after the commit, the rest released. */
  readonly capture: KeptCapture | null;
}

/**
 * The capture of the amount a cancellation keeps of an authorisation (lead decision (1) of 2026-10-23, second batch):
 * `amount` is captured with `pi:capture:<pay_id>:cancellation:<amount>`, Stripe releases `release`.
 */
export interface KeptCapture {
  readonly payment: PaymentRow;
  /** What the OTA keeps: the cancellation fee, the fees that are not refunded, any airline penalty. */
  readonly amount: string;
  /** What goes back to the customer: the authorisation less `amount`. */
  readonly release: string;
  readonly reason: RefundReason;
  /** The customer who cancelled (`cus_…`), or `null` for a guest. */
  readonly customerId: string | null;
}

/**
 * How a cancellation settles a Stripe authorisation of `authorized` when the customer gets `estimatedRefund` back:
 * the amount kept (`authorized − refund`, never below zero) is captured and the rest released; nothing kept voids it.
 */
export function authorisationSettlementOf(
  authorized: string,
  estimatedRefund: string,
  minorUnits: number,
):
  | { readonly kind: "void" }
  | { readonly kind: "capture"; readonly amount: string; readonly release: string } {
  const whole = new Money(authorized);
  const release = Money.max(Money.min(new Money(estimatedRefund), whole), 0);
  const kept = whole.minus(release);
  return kept.greaterThan(0)
    ? { kind: "capture", amount: kept.toFixed(minorUnits), release: release.toFixed(minorUnits) }
    : { kind: "void" };
}

/** What `recordCancelled` did. */
export type RecordedCancellation =
  | { readonly kind: "cancelled"; readonly money: RecordedMoney; readonly ticketsVoided: boolean }
  /** The booking is no longer live (someone else cancelled it). */
  | { readonly kind: "not_live"; readonly status: string };

/** The tenant a recorder call works for: the request's, or the job's. */
export interface CancellationTenant {
  readonly tenantId: string;
  readonly key: string;
  readonly environment: "test" | "live";
  readonly requestId: string;
}

/**
 * The writes of a cancellation, shared by the API (bookings.cancel) and the worker (the check after a DELETE without
 * an answer): the record step and the money step, a request handed to the staff, the flag of an unknown outcome and
 * its decisions, and the void of an authorisation (see the file header).
 */
@Injectable()
export class CancellationRecorder {
  private readonly baseDomain: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly bookings: BookingsRepository,
    private readonly repository: CancellationRepository,
    private readonly payments: PaymentsRepository,
    private readonly refunds: RefundsRepository,
    private readonly recorder: OrderRecorder,
    private readonly outbox: OutboxService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @InjectQueue(OTA_QUEUE.payments) private readonly paymentsQueue: Queue,
    private readonly alerts: StaffAlerts,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    config: ConfigService<SharedConfig, true>,
    @InjectPinoLogger(CancellationRecorder.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /**
   * The record step and the money step (see the file header), in `trx`, whose caller locked the booking `FOR NO KEY
   * UPDATE` and found it live. `via` says what proved the cancellation (the DELETE's `204`, or the worker's read).
   */
  async recordCancelled(
    trx: TenantTransaction,
    tenant: CancellationTenant,
    bookingId: string,
    ask: CancellationAsk,
    via: { readonly cause: "deleted" | "checked"; readonly supplierRequestId: string | null },
  ): Promise<RecordedCancellation> {
    const now = this.clock.now();
    const booking = await this.bookings.booking(trx, bookingId);
    if (booking === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (!LIVE_STATUSES.has(booking.status)) {
      return { kind: "not_live", status: booking.status };
    }
    const children = await this.bookings.children(trx, bookingId);
    await this.repository.markCancelled(trx, bookingId, { reasonCode: ask.reasonCode, now });
    const voided = await this.repository.cancelChildren(trx, bookingId, now);
    const money = await this.moneyStep(
      trx,
      tenant,
      booking,
      ask,
      via.cause === "checked" ? "system" : "api",
      now,
    );
    const actor = eventActorOf(ask.actor);
    await this.recorder.event(trx, bookingId, {
      type: CANCELLATION_EVENTS.cancelled,
      actor,
      statusFrom: booking.status,
      statusTo: "cancelled",
      summary: `Booking ${booking.reference} cancelled.`,
      data: {
        cancelledBy: "customer",
        mode: ask.mode,
        reasonCode: ask.reasonCode,
        // The reason of a refund or release this cancellation records (refunds.reason).
        refundReason: refundReasonOf(ask.reasonCode),
        ...(ask.comment === null ? {} : { comment: ask.comment }),
        requestedAt: ask.requestedAt.toISOString(),
        ticketsVoided: voided > 0,
        estimatedRefund: { amount: ask.estimate.estimatedRefund, currency: ask.currency },
        refundStatus: money.refundStatus,
        ...(money.refund === null ? {} : { refundId: money.refund.id }),
        // The authorisation voided after the commit: a later answer reads the payment for the outcome.
        ...(money.voidPayment === null ? {} : { voidPaymentId: money.voidPayment.id }),
        // The authorisation whose kept amount is captured after the commit, the rest released (FIX-W28-CANCEL): the
        // payments queue's capture retry reads the amount here, a later answer the payment and its release.
        ...(money.capture === null
          ? {}
          : {
              capturePaymentId: money.capture.payment.id,
              captureAmount: money.capture.amount,
              releaseAmount: money.capture.release,
            }),
        ...(via.cause === "checked" ? { cause: "checked_after_timeout" } : {}),
      },
      visibleToCustomer: true,
      supplierRequestId: via.supplierRequestId,
      requestId: tenant.requestId,
      now,
    });
    if (money.refund !== null) {
      // The booking's FOR NO KEY UPDATE lock is held: the event's foreign key needs nothing more.
      await this.payments.insertRefundBookingEvent(trx, {
        id: this.ids.newId("evt"),
        kind: "requested",
        bookingId,
        refundId: money.refund.id,
        paymentId: money.refund.paymentId,
        amount: money.refund.amount,
        currency: money.refund.currency,
        actor,
        requestId: tenant.requestId,
        // One millisecond after the cancellation: the timeline orders events by time.
        now: new Date(now.getTime() + 1),
      });
    }
    await this.travellerEmail(trx, tenant, booking, children, "booking.cancelled", {
      dedupeKey: `booking.cancelled:${booking.id}`,
      refund:
        money.refundStatus === "not_applicable" && new Money(ask.estimate.estimatedRefund).isZero()
          ? { amount: "", currency: "" }
          : { amount: money.refund?.amount ?? ask.estimate.estimatedRefund, currency: ask.currency },
    });
    this.logger.info(
      { bookingId, mode: ask.mode, refundStatus: money.refundStatus, cause: via.cause },
      "bookings.cancelled",
    );
    return { kind: "cancelled", money, ticketsVoided: voided > 0 };
  }

  /** The money step (see the file header), once: the caller's transaction cancelled the booking under its lock. */
  private async moneyStep(
    trx: TenantTransaction,
    tenant: CancellationTenant,
    booking: BookingRow,
    ask: CancellationAsk,
    source: "api" | "system",
    now: Date,
  ): Promise<RecordedMoney> {
    const rows: PaymentRow[] = [];
    const inFlight = new Map<string, string>();
    for (const id of await this.bookings.paymentIdsOf(trx, booking.id)) {
      const row = await this.payments.payment(trx, id);
      if (row !== undefined) {
        rows.push(row);
        inFlight.set(row.id, await this.refunds.inFlightAmount(trx, row.id));
      }
    }
    const target = moneyOf(rows, inFlight);
    const none: RecordedMoney = {
      refundStatus: "not_applicable",
      refund: null,
      voidPayment: null,
      capture: null,
    };
    if (target === undefined) {
      return none;
    }
    const { row, estimate } = target;
    switch (estimate.kind) {
      case "airline":
        // The airline reverses its charge when the order is cancelled: the expectation is recorded, nothing is sent.
        await this.payments.insertEvent(trx, {
          id: this.ids.newId("pev"),
          payment_id: row.id,
          type: AIRLINE_VOID_EXPECTED_EVENT,
          source,
          status_from: row.status,
          status_to: row.status,
          amount: row.amountCaptured,
          currency: row.currency,
          payload: JSON.stringify({ bookingId: booking.id, mode: ask.mode, reasonCode: ask.reasonCode }),
          created_at: now,
          updated_at: now,
        });
        return none;
      case "stripe_authorized": {
        // Lead decision (1) of 2026-10-23, second batch: the amount kept is captured and the rest released after the
        // commit; only an authorisation of which nothing is kept is voided.
        const settlement = authorisationSettlementOf(
          estimate.authorized,
          ask.estimate.estimatedRefund,
          (await this.payments.currencyMinorUnits(trx, row.currency)) ?? 2,
        );
        if (settlement.kind === "void") {
          return { refundStatus: "pending", refund: null, voidPayment: row, capture: null };
        }
        return {
          // Nothing goes back when the whole authorisation is kept.
          refundStatus: new Money(settlement.release).isZero() ? "not_applicable" : "pending",
          refund: null,
          voidPayment: null,
          capture: {
            payment: row,
            amount: settlement.amount,
            release: settlement.release,
            reason: refundReasonOf(ask.reasonCode),
            customerId: ask.actor.type === "customer" ? ask.actor.id : null,
          },
        };
      }
      case "none":
        return none;
      case "stripe_captured":
        break;
    }
    // Stripe, captured: the estimate, never more than can still be refunded.
    const wanted = Money.min(new Money(ask.estimate.estimatedRefund), new Money(estimate.refundable));
    if (!wanted.greaterThan(0)) {
      return none;
    }
    const created = await this.refunds.create(trx, {
      id: this.ids.newId("rfd"),
      paymentId: row.id,
      bookingId: booking.id,
      amount: wanted.toFixed(2),
      reason: refundReasonOf(ask.reasonCode),
      reasonNote: `${CANCEL_OPERATION}: ${ask.reasonCode}`,
      requestedBy: { type: "customer", id: ask.actor.type === "customer" ? ask.actor.id : null },
      now,
    });
    if (!created.ok) {
      this.logger.warn({ bookingId: booking.id, reason: created.reason }, "bookings.cancel_refund_refused");
      await this.staffAlert(trx, booking, "cancellation_refund", {
        reason:
          `The customer cancelled this booking, but its refund could not be asked for (${created.reason}): ` +
          "refund the customer from the console.",
      });
      return { refundStatus: "manual_review", refund: null, voidPayment: null, capture: null };
    }
    const job = paymentJob(PAYMENT_JOB.refundSubmit, tenant.tenantId, created.refund.id);
    afterCommit(trx, () => this.enqueue(this.paymentsQueue, job.name, job.data, job.opts));
    return {
      refundStatus: "pending",
      refund: {
        id: created.refund.id,
        paymentId: row.id,
        amount: created.refund.amount,
        currency: created.refund.currency,
      },
      voidPayment: null,
      capture: null,
    };
  }

  /**
   * A cancellation handed to the staff (`request_only`, a refusal, an order Amadeus no longer has), in `trx`, whose
   * caller locked the booking and found it live: `version + 1`, the event, the traveller's e-mail and the staff alert.
   */
  async recordRequest(
    trx: TenantTransaction,
    tenant: CancellationTenant,
    booking: BookingRow,
    ask: CancellationAsk,
    cause: "request_only" | "refused" | "order_not_found",
    supplierCode: string | null,
  ): Promise<void> {
    const now = this.clock.now();
    const children = await this.bookings.children(trx, booking.id);
    await this.repository.bumpVersion(trx, booking.id, now);
    await this.recorder.event(trx, booking.id, {
      type: CANCELLATION_EVENTS.requested,
      actor: eventActorOf(ask.actor),
      statusFrom: booking.status,
      statusTo: booking.status,
      summary: "Cancellation requested: the travel agency will confirm it.",
      data: {
        mode: ask.mode,
        cause,
        reasonCode: ask.reasonCode,
        ...(ask.comment === null ? {} : { comment: ask.comment }),
        requestedAt: ask.requestedAt.toISOString(),
        // What the customer paid (captured, else authorised): the pending cancellation's `refundStatus` reads it.
        amountPaid: ask.estimate.amountPaid,
        estimatedRefund: { amount: ask.estimate.estimatedRefund, currency: ask.currency },
        ...(supplierCode === null ? {} : { supplierCode }),
      },
      visibleToCustomer: true,
      requestId: tenant.requestId,
      now,
    });
    await this.travellerEmail(trx, tenant, booking, children, "booking.cancellation_requested", {
      dedupeKey: `booking.cancellation_requested:${booking.id}:v${booking.version + 1}`,
    });
    const why =
      cause === "request_only"
        ? "it is ticketed outside the void window"
        : cause === "refused"
          ? `the airline refused the cancellation (${supplierCode ?? "SUPPLIER_REJECTED"})`
          : "Amadeus no longer returns its order: check the office";
    await this.staffAlert(trx, booking, `cancellation_requested_v${booking.version + 1}`, {
      reason:
        `The customer asked to cancel this booking (${ask.reasonCode}) and ${why}. Cancel it at the airline and ` +
        "refund the selling amount less the penalties from the console.",
    });
    this.logger.info({ bookingId: booking.id, mode: ask.mode, cause }, "bookings.cancellation_requested");
  }

  /** The flag of a DELETE without an answer (the staff event the worker decides), in the caller's transaction. */
  async recordUnknownOutcome(
    trx: TenantTransaction,
    tenant: CancellationTenant,
    booking: BookingRow,
    ask: CancellationAsk,
    reason: string,
  ): Promise<Date> {
    const now = this.clock.now();
    const until = new Date(now.getTime() + CANCELLATION_CHECK_WINDOW_MS);
    await this.recorder.event(trx, booking.id, {
      type: CANCELLATION_EVENTS.timeout,
      actor: eventActorOf(ask.actor),
      statusFrom: booking.status,
      statusTo: booking.status,
      summary: `Amadeus did not confirm the cancellation of ${booking.reference}; the order is checked until ${until.toISOString()}.`,
      data: {
        mode: ask.mode,
        reasonCode: ask.reasonCode,
        ...(ask.comment === null ? {} : { comment: ask.comment }),
        estimate: { ...ask.estimate },
        currency: ask.currency,
        requestedAt: ask.requestedAt.toISOString(),
        until: until.toISOString(),
        actor: { type: ask.actor.type, id: ask.actor.id },
        requestId: tenant.requestId,
        reason,
      },
      visibleToCustomer: false,
      requestId: tenant.requestId,
      now,
    });
    return until;
  }

  /** The worker found the order still active after a DELETE without an answer. */
  async recordNotApplied(
    trx: TenantTransaction,
    tenant: CancellationTenant,
    booking: BookingRow,
    supplierRequestId: string | null,
  ): Promise<void> {
    await this.recorder.event(trx, booking.id, {
      type: CANCELLATION_EVENTS.notApplied,
      actor: { type: "system", id: null },
      statusFrom: booking.status,
      statusTo: booking.status,
      summary: "The airline did not cancel the booking: its order is still active.",
      data: { cause: "order_active" },
      visibleToCustomer: false,
      supplierRequestId,
      requestId: tenant.requestId,
      now: this.clock.now(),
    });
    this.logger.info({ bookingId: booking.id }, "bookings.cancellation_not_applied");
  }

  /** Still undecided at the deadline: the staff decide. */
  async recordManualReview(
    trx: TenantTransaction,
    tenant: CancellationTenant,
    booking: BookingRow,
    code: string,
  ): Promise<void> {
    await this.recorder.event(trx, booking.id, {
      type: CANCELLATION_EVENTS.manualReview,
      actor: { type: "system", id: null },
      statusFrom: booking.status,
      statusTo: booking.status,
      summary:
        "The outcome of the cancellation could not be read from Amadeus in time: staff check the order.",
      data: { code },
      visibleToCustomer: false,
      requestId: tenant.requestId,
      now: this.clock.now(),
    });
    await this.staffAlert(trx, booking, "cancellation_unknown", {
      reason:
        "Amadeus did not answer the customer's cancellation and its order could not be read for 15 minutes " +
        `(${code}): check the order in the office, then cancel and refund, or tell the customer it stands.`,
    });
    this.logger.warn({ bookingId: booking.id, code }, "bookings.cancellation_manual_review");
  }

  /**
   * The money step's part after the commit (see the file header): an authorisation of which nothing is kept is voided
   * (`voidAuthorisation`), one of which the cancellation keeps an amount is captured for that amount and the rest
   * released (`captureKept`); nothing else. No transaction is open.
   */
  async settleAuthorisation(
    tenant: CancellationTenant,
    bookingId: string,
    money: RecordedMoney,
    source: "api" | "system",
  ): Promise<void> {
    if (money.voidPayment !== null) {
      await this.voidAuthorisation(tenant, money.voidPayment);
    } else if (money.capture !== null) {
      await this.captureKept(tenant, bookingId, money.capture, source);
    }
  }

  /**
   * Voids the authorisation of a cancelled booking (`pi:cancel:<pay_id>`) with no transaction open, then records it
   * (the payment locked; no booking row is written). A void that fails is queued as `payment.void` (OBE-040). Answers
   * whether it was voided now.
   */
  async voidAuthorisation(tenant: CancellationTenant, row: PaymentRow): Promise<boolean> {
    const ctx: GatewayContext = {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      requestId: tenant.requestId,
    };
    try {
      const minorUnits = await this.minorUnits(row.currency);
      const gatewayPayment: GatewayPayment = {
        id: row.id,
        checkoutId: row.checkoutId,
        providerPaymentId: row.providerPaymentId,
        currency: row.currency,
        amount: new Money(row.amount).toFixed(minorUnits),
        minorUnits,
        version: row.version,
      };
      const state = await this.gateway.void(ctx, gatewayPayment);
      return await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const current = await this.payments.payment(trx, row.id, true);
        if (current === undefined) {
          return false;
        }
        const update = providerStateUpdate(current, state, now);
        if (update.kind === "apply") {
          await this.payments.updatePayment(trx, current.id, current.version, update.values);
          await this.payments.insertEvent(trx, {
            id: this.ids.newId("pev"),
            payment_id: current.id,
            type: "payment.voided",
            source: "api",
            status_from: current.status,
            status_to: update.status,
            amount: null,
            currency: null,
            payload: JSON.stringify({ reason: "booking_cancelled", bookingId: current.bookingId }),
            created_at: now,
            updated_at: now,
          });
        }
        return state.status === "canceled";
      });
    } catch (error) {
      this.logger.warn(
        { paymentId: row.id, code: error instanceof AppError ? error.code : undefined },
        "bookings.cancel_void_failed",
      );
      const job = paymentJob(PAYMENT_JOB.void, tenant.tenantId, row.id);
      await this.enqueue(this.paymentsQueue, job.name, job.data, job.opts);
      return false;
    }
  }

  /**
   * Captures the amount a cancellation keeps of an authorisation (see the file header), with no transaction open:
   * `pi:capture:<pay_id>:cancellation:<amount>` (Stripe releases the rest), then records what Stripe reports
   * (`recordKeptCapture`). A capture that fails, or whose answer is lost, never undoes the cancellation: it is
   * recorded (`payment.capture_failed`), the staff are alerted, and the payments queue captures it once more
   * CAPTURE_RETRY_DELAY_MS later with the same key (`payment.capture_retry`, payments.processor.ts), which alerts the
   * staff again when it cannot. `source` names the process (`api`: the request; `system`: the worker's check). Answers
   * whether the kept amount is captured now.
   */
  async captureKept(
    tenant: CancellationTenant,
    bookingId: string,
    capture: KeptCapture,
    source: "api" | "system",
  ): Promise<boolean> {
    const ctx: GatewayContext = {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      requestId: tenant.requestId,
    };
    const { payment } = capture;
    let code: string;
    try {
      const minorUnits = await this.minorUnits(payment.currency);
      const gatewayPayment: GatewayPayment = {
        id: payment.id,
        checkoutId: payment.checkoutId,
        providerPaymentId: payment.providerPaymentId,
        currency: payment.currency,
        amount: new Money(payment.amount).toFixed(minorUnits),
        minorUnits,
        version: payment.version,
      };
      const state = await this.gateway.capture(ctx, gatewayPayment, capture.amount, "cancellation");
      if (state.status === "captured") {
        await this.tx.run((trx) => this.recordKeptCapture(trx, tenant, bookingId, capture, state, source));
        this.logger.info({ bookingId, paymentId: payment.id }, "bookings.cancel_kept_captured");
        return true;
      }
      code = `provider_status_${state.status}`;
    } catch (error) {
      code = isAppError(error) ? error.code : "INTERNAL_ERROR";
    }
    this.logger.warn({ bookingId, paymentId: payment.id, code }, "bookings.cancel_capture_failed");
    await this.recordCaptureFailure(tenant, bookingId, capture, code, source);
    return false;
  }

  /**
   * What a capture of the kept amount that Stripe reports changes, in one transaction: the booking (`FOR UPDATE`, its
   * `amount_paid` changes), then the payment (its state through payment-state.ts, `payment.captured`), then the
   * release's refund row (OADR-0003 point 11: booking, payment, refund): the events the capture paths write (the
   * payment's `payment.captured`, the booking's `amount_paid` and `payment.captured`) and the release
   * (RefundsRepository.recordRelease, with the customer-visible `refund.succeeded`), once.
   */
  private async recordKeptCapture(
    trx: TenantTransaction,
    tenant: CancellationTenant,
    bookingId: string,
    capture: KeptCapture,
    state: GatewayState,
    source: "api" | "system",
  ): Promise<void> {
    const now = this.clock.now();
    const [booking] = await this.payments.lockBookings(trx, [bookingId], "update");
    const current = await this.payments.payment(trx, capture.payment.id, true);
    if (booking === undefined || current === undefined) {
      return;
    }
    const captured = Money.min(new Money(state.amountReceived), new Money(current.amount));
    const update = providerStateUpdate(current, state, now);
    if (update.kind === "apply") {
      await this.payments.updatePayment(trx, current.id, current.version, update.values);
      await this.payments.insertEvent(trx, {
        id: this.ids.newId("pev"),
        payment_id: current.id,
        type: "payment.captured",
        source,
        status_from: current.status,
        status_to: update.status,
        amount: captured.toFixed(2),
        currency: current.currency,
        payload: JSON.stringify({ bookingId, purpose: "cancellation", requestId: tenant.requestId }),
        created_at: now,
        updated_at: now,
      });
    }
    if (new Money(booking.amountPaid).lessThan(captured)) {
      await this.payments.setAmountPaid(trx, bookingId, captured.toFixed(2), now);
      await this.recorder.event(trx, bookingId, {
        type: "payment.captured",
        actor: { type: "system", id: null },
        summary: "The amount kept for the cancellation was charged; the rest of the payment was released.",
        data: { paymentId: current.id, amount: captured.toFixed(2), purpose: "cancellation" },
        visibleToCustomer: true,
        requestId: tenant.requestId,
        now,
      });
    }
    // What Stripe released: the authorisation less what it captured (Stripe's word, not the estimate's).
    const authorised = Money.max(new Money(current.amountAuthorized), captured);
    const released = await this.refunds.recordRelease(trx, {
      id: this.ids.newId("rfd"),
      paymentId: current.id,
      bookingId,
      amount: authorised.minus(captured).toFixed(2),
      kept: captured.toFixed(2),
      reason: capture.reason,
      requestedBy: { type: "customer", id: capture.customerId },
      source,
      now,
    });
    if (released !== undefined) {
      await this.payments.insertRefundBookingEvent(trx, {
        id: this.ids.newId("evt"),
        kind: "succeeded",
        bookingId,
        refundId: released.id,
        paymentId: current.id,
        amount: released.amount,
        currency: released.currency,
        actor: { type: "system", id: null },
        requestId: tenant.requestId,
        // One millisecond after the capture: the timeline orders events by time.
        now: new Date(now.getTime() + 1),
      });
    }
  }

  /**
   * A capture of the kept amount that did not happen (see `captureKept`): the payment's `payment.capture_failed` (the
   * amount and the purpose), the staff-only booking event `payment.capture_failed` and a staff alert in one
   * transaction (the booking `FOR KEY SHARE` for the event and the outbox row, then the payment), then the payments
   * queue's `payment.capture_retry` (job id `capture-retry-cancellation-<pay_id>`), CAPTURE_RETRY_DELAY_MS later,
   * also when that transaction failed (the retry reads the amount from the `booking.cancelled` event). Never throws.
   */
  private async recordCaptureFailure(
    tenant: CancellationTenant,
    bookingId: string,
    capture: KeptCapture,
    code: string,
    source: "api" | "system",
  ): Promise<void> {
    const { payment } = capture;
    try {
      await this.tx.run(async (trx) => {
        const now = this.clock.now();
        await this.payments.lockBookings(trx, [bookingId], "key share");
        const current = await this.payments.payment(trx, payment.id, true);
        const booking = await this.bookings.booking(trx, bookingId);
        if (current === undefined || booking === undefined) {
          return;
        }
        await this.payments.insertEvent(trx, {
          id: this.ids.newId("pev"),
          payment_id: current.id,
          type: "payment.capture_failed",
          source,
          status_from: null,
          status_to: null,
          amount: null,
          currency: null,
          payload: JSON.stringify({ bookingId, amount: capture.amount, purpose: "cancellation", code }),
          created_at: now,
          updated_at: now,
        });
        await this.recorder.event(trx, bookingId, {
          type: "payment.capture_failed",
          actor: { type: "system", id: null },
          summary:
            "The amount kept for the cancellation could not be charged; staff will review the payment.",
          data: { paymentId: current.id, amount: capture.amount, purpose: "cancellation", code },
          visibleToCustomer: false,
          requestId: tenant.requestId,
          now,
        });
        await this.staffAlert(trx, booking, "cancellation_capture_failed", {
          reason:
            `The customer cancelled this booking, but the amount it keeps (${capture.amount} ${current.currency}: ` +
            `the cancellation fee and the fees that are not refunded) could not be captured from the card payment ` +
            `${current.id} (${code}). The cancellation stands. The capture is retried once in 10 minutes; if it ` +
            "fails too, capture the kept amount from the console or release the authorisation.",
        });
      });
    } catch (error) {
      this.logger.error(
        { bookingId, paymentId: payment.id, err: error },
        "bookings.cancel_capture_not_recorded",
      );
    }
    const job = cancellationCaptureRetryJob(tenant.tenantId, payment.id);
    await this.enqueue(this.paymentsQueue, job.name, job.data, {
      ...job.opts,
      delay: CAPTURE_RETRY_DELAY_MS,
    });
  }

  private async minorUnits(currency: string): Promise<number> {
    return (await this.tx.run((trx) => this.payments.currencyMinorUnits(trx, currency))) ?? 2;
  }

  /** An e-mail to the booking's traveller; refused calls are logged and skipped (the state is recorded all the same). */
  private async travellerEmail(
    trx: TenantTransaction,
    tenant: CancellationTenant,
    booking: BookingRow,
    children: BookingChildren,
    templateKey: "booking.cancelled" | "booking.cancellation_requested",
    extra: {
      readonly dedupeKey: string;
      readonly refund?: { readonly amount: string; readonly currency: string };
    },
  ): Promise<void> {
    const settings = await this.repository.settings(trx);
    const primary = children.contacts.find((contact) => contact.isPrimary) ?? children.contacts[0];
    const language = primary?.language ?? null;
    try {
      await this.outbox.enqueue(trx, {
        templateKey,
        to: primary?.email ?? booking.contactEmail,
        locale: language !== null && LOCALE.test(language) ? language : (settings?.defaultLocale ?? "en"),
        customerId: booking.customerId,
        bookingId: booking.id,
        dedupeKey: extra.dedupeKey,
        data: {
          booking: {
            reference: booking.reference,
            recordLocator: booking.recordLocator ?? "",
            url: `${storefrontUrl(tenant.key, this.baseDomain)}/booking.html?id=${booking.id}`,
            total: { amount: booking.totalAmount, currency: booking.currency },
            contact: { firstName: primary?.firstName ?? "", lastName: primary?.lastName ?? "" },
            travellers: children.travelers.map((traveler) => ({
              firstName: traveler.firstName,
              lastName: traveler.lastName,
            })),
            segments: children.segments.map((segment) => ({
              origin: segment.departureIata,
              destination: segment.arrivalIata,
              departureAt: segment.departureLocal,
              arrivalAt: segment.arrivalLocal,
              carrierCode: segment.carrierCode,
              flightNumber: segment.flightNumber,
            })),
          },
          ...(extra.refund === undefined ? {} : { refund: extra.refund }),
        },
      });
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error({ bookingId: booking.id, template: templateKey }, "bookings.cancel_email_invalid");
    }
  }

  /**
   * A staff alert (`staff.manual_review`) through StaffAlerts (staff-alerts.ts): to `ops_alert_email`, else the owners,
   * else, in the worker only, OPS_ALERT_EMAIL (notifications/staff-recipients.ts); skipped and logged without one, as
   * is a call the outbox refuses. Once per booking and kind.
   */
  private async staffAlert(
    trx: TenantTransaction,
    booking: BookingRow,
    kind: string,
    alert: { readonly reason: string },
  ): Promise<void> {
    const settings = await this.repository.settings(trx);
    await this.alerts.send(trx, {
      settings,
      fallbackLocale: "en",
      booking: { id: booking.id, reference: booking.reference, recordLocator: booking.recordLocator },
      dedupeKey: `staff.manual_review:${booking.id}:${kind}`,
      reason: alert.reason,
    });
  }

  /** Adds a job; never throws (a failure is logged: the payments queue's sweeps find the row). */
  async enqueue(
    queue: Queue,
    name: string,
    data: unknown,
    opts: { readonly jobId: string; readonly delay?: number },
  ): Promise<void> {
    try {
      await queue.add(name, data, { ...opts });
    } catch (error) {
      this.logger.warn({ job: name, jobId: opts.jobId, err: error }, "bookings.cancel_enqueue_failed");
    }
  }
}

// ---- bookings.quoteCancellation and bookings.cancel (the API) --------------------------------------------------------

/** The warning of a quote in `request_only` mode. */
export const REQUEST_ONLY_WARNING: Warning = Object.freeze({
  title: "CANCELLATION BY THE TRAVEL AGENCY",
  detail:
    "The tickets were issued before today: the travel agency cancels the booking with the airline and confirms the " +
    "refund.",
});

/** The fare rule categories a quote shows (CancellationQuote.conditions). */
const QUOTE_CONDITION_CATEGORIES: ReadonlySet<string> = new Set(["REFUND", "CANCELLATION"]);

/** What bookings.cancel answers: the HTTP status, the result and the booking's version for the `ETag`. */
export interface CancelAnswer {
  readonly status: 200 | 202;
  readonly result: CancellationResult;
  readonly version: number;
}

/** What the claim (T1) decided. */
type Claim =
  | { readonly kind: "requested"; readonly booking: BookingRow }
  | {
      readonly kind: "claimed";
      readonly booking: BookingRow;
      readonly orderId: string;
    };

@Injectable()
export class CancellationService {
  constructor(
    private readonly tx: TenantTx,
    private readonly bookings: BookingsRepository,
    private readonly repository: CancellationRepository,
    private readonly payments: PaymentsRepository,
    private readonly refunds: RefundsRepository,
    private readonly rules: RulesRepository,
    private readonly recorder: CancellationRecorder,
    private readonly customerBookings: CustomerBookingsService,
    private readonly amadeus: AmadeusClient,
    private readonly tenants: TenantContext,
    private readonly access: BookingAccessContext,
    private readonly requestContext: RequestContext,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OTA_QUEUE.bookings) private readonly bookingsQueue: Queue,
    private readonly clock: Clock,
    @InjectPinoLogger(CancellationService.name) private readonly logger: PinoLogger,
  ) {}

  // ---- bookings.quoteCancellation ----------------------------------------------------------------------------------

  /** The cancellation quote of a booking (see the file header). */
  async quote(bookingId: string): Promise<CancellationQuote> {
    this.access.require(bookingId);
    const tenant = this.tenants.require();
    return (await this.freshQuote(tenant, bookingId, QUOTE_OPERATION)).quote;
  }

  /** The order read again with its refund fare rules, the quote computed and cached (see the file header). */
  private async freshQuote(
    tenant: RequestTenant,
    bookingId: string,
    operation: string,
  ): Promise<CachedQuote> {
    let warnings: Warning[] = [];
    const outcome = await this.customerBookings.refresh(tenant, bookingId, operation, {
      fareRules: ["refunds"],
    });
    if (outcome.kind === "refreshed") {
      warnings = [...outcome.warnings];
    } else if (outcome.kind === "not_found") {
      warnings = [ORDER_NOT_FOUND_WARNING];
    }
    const cached = await this.tx.run((trx) => this.computeQuote(trx, tenant, bookingId, warnings));
    await this.writeCache(tenant, bookingId, cached);
    return cached;
  }

  /** The quote of the booking as it is stored now (see the file header). */
  private async computeQuote(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    warnings: readonly Warning[],
  ): Promise<CachedQuote> {
    const now = this.clock.now();
    const booking = await this.bookings.booking(trx, bookingId);
    const details = await this.bookings.bookingDetails(trx, bookingId);
    if (booking === undefined || details === undefined || booking.environment !== tenant.environment) {
      // The guard read it in this request: only a concurrent erasure gets here.
      throw new AppError("NOT_FOUND");
    }
    const children = await this.bookings.children(trx, bookingId);
    const settings = await this.repository.settings(trx);
    const minorUnits = (await this.payments.currencyMinorUnits(trx, booking.currency)) ?? 2;
    const computed = cancellationModeOf({
      status: booking.status,
      ticketingStatus: booking.ticketingStatus,
      amadeusOrderId: booking.amadeusOrderId,
      lastArrivalAt: booking.lastArrivalAt,
      segments: children.segments,
      tickets: children.tickets,
      selfServiceCancellation: selfServiceCancellationOf(settings?.features),
      timeZone: settings?.timeZone ?? "UTC",
      now,
    });
    const state = cancellationStateOf(await this.repository.cancellationEvents(trx, bookingId));
    // A cancellation that is undecided or waits for the staff allows no second one.
    const mode =
      computed.mode !== "not_allowed" && (state.kind === "undecided" || state.kind === "requested")
        ? { mode: "not_allowed" as const, notAllowedReason: "pending" as const, voidDeadlineAt: null }
        : computed;
    const rows: PaymentRow[] = [];
    const inFlight = new Map<string, string>();
    for (const id of await this.bookings.paymentIdsOf(trx, bookingId)) {
      const row = await this.payments.payment(trx, id);
      if (row !== undefined) {
        rows.push(row);
        inFlight.set(row.id, await this.refunds.inFlightAmount(trx, row.id));
      }
    }
    const target = moneyOf(rows, inFlight);
    const net = booking.pricingMode === "net";
    const keptFees = net
      ? "0"
      : ((booking.pricedOfferId === null
          ? undefined
          : keptFeesOf(await this.repository.pricedOfferResponse(trx, booking.pricedOfferId), minorUnits)) ??
        booking.feesAmount);
    const estimate = refundEstimateOf({
      mode: mode.mode,
      minorUnits,
      payment: target?.estimate ?? { kind: "none" },
      keptFees,
      cancellationFees: net ? [] : await this.cancellationFees(trx, booking, children, minorUnits, now),
      // The card fee unless its line is refundable (lead decision (2) of 2026-10-23, second batch).
      keptCardFee:
        target !== undefined && target.row.provider === "stripe"
          ? keptCardFeeOf(target.row, minorUnits)
          : "0",
    });
    const lines = refundLinesOf(lineTravelersOf(children, details.orderSnapshot), estimate, minorUnits);
    const stored = storedFareRulesOf(details.orderIncluded);
    const conditions: BookingFareRule[] =
      stored === undefined || !stored.types.includes("refunds")
        ? []
        : toBookingFareRules({
            booking,
            stored,
            offers: snapshotOffersOf(details.orderSnapshot),
            minorUnits,
          }).rules.filter((rule) => QUOTE_CONDITION_CATEGORIES.has(rule.category));
    const currency = booking.currency;
    const quote: CancellationQuote = {
      bookingId,
      cancellable: mode.mode !== "not_allowed",
      mode: mode.mode,
      notAllowedReason: mode.notAllowedReason,
      currency,
      amountPaid: money(estimate.amountPaid, currency, minorUnits),
      estimatedRefund: money(estimate.estimatedRefund, currency, minorUnits),
      penalty: money(estimate.penalty, currency, minorUnits),
      otaFee: money(estimate.otaFee, currency, minorUnits),
      voidDeadlineAt: mode.voidDeadlineAt?.toISOString() ?? null,
      lines: lines.map((line) => ({
        travelerId: line.travelerId,
        travelerName: line.travelerName,
        ticketNumber: line.ticketNumber,
        paid: money(line.paid, currency, minorUnits),
        refund: money(line.refund, currency, minorUnits),
        penalty: money(line.penalty, currency, minorUnits),
        refundableTaxes: null,
      })),
      conditions,
      expiresAt: new Date(now.getTime() + CANCELLATION_QUOTE_TTL_SECONDS * 1000).toISOString(),
      source: "policy",
      warnings: [...warnings, ...(mode.mode === "request_only" ? [REQUEST_ONLY_WARNING] : [])],
    };
    return { v: 1, version: booking.version, quote };
  }

  /** The amounts of the `cancellation` fee lines of the engine on the booking total (OADR-0005 point 7). */
  private async cancellationFees(
    trx: TenantTransaction,
    booking: BookingRow,
    children: BookingChildren,
    minorUnits: number,
    now: Date,
  ): Promise<string[]> {
    const codes = [
      booking.originIata,
      booking.destinationIata,
      ...children.segments.flatMap((segment) => [segment.departureIata, segment.arrivalIata]),
    ].filter((code): code is string => code !== null);
    const countries = await this.payments.airportCountries(trx, [...new Set(codes)]);
    const input = pricingInputOfBooking({
      booking,
      children,
      countryOf: (code) => countries.get(code) ?? null,
      minorUnits,
      at: now,
    });
    const active = await this.rules.loadActiveRules(trx);
    try {
      return priceOffer(input, active.markupRules, active.feeRules, {
        kind: "cancellation",
        baseAmount: new Money(booking.totalAmount).toFixed(minorUnits),
      }).feeLines.map((line) => line.amount);
    } catch (error) {
      if (!(error instanceof PricingInputError)) {
        throw error;
      }
      // A booking the engine cannot price (a currency or amount it refuses) gets no cancellation fee.
      this.logger.warn({ bookingId: booking.id, field: error.field }, "bookings.cancellation_fee_unpriced");
      return [];
    }
  }

  // ---- bookings.cancel ---------------------------------------------------------------------------------------------

  /** Cancels the booking (see the file header). */
  async cancel(bookingId: string, ifMatch: string, body: CancellationRequest): Promise<CancelAnswer> {
    this.access.require(bookingId);
    const tenant = this.tenants.require();
    const requestedAt = this.clock.now();
    // 1. The checks without a lock: no Amadeus call for a request that is refused anyway.
    const version = await this.tx.run((trx) => this.check(trx, tenant, bookingId, ifMatch, undefined));
    // 2. The quote.
    let cached = await this.readCache(tenant, bookingId);
    if (cached === undefined || !quoteValid(cached, version.version, requestedAt)) {
      try {
        cached = await this.freshQuote(tenant, bookingId, CANCEL_OPERATION);
      } catch (error) {
        throw unsentAnswer(error);
      }
    }
    const { quote } = cached;
    if (quote.mode === "not_allowed") {
      throw notCancellable(quote.notAllowedReason ?? "pending");
    }
    if (!expectedRefundMatches(body.expectedRefund, quote.estimatedRefund)) {
      throw new AppError("REFUND_AMOUNT_CHANGED", {
        message: "The refund amount changed. Please confirm the new amount.",
        details: { expectedRefund: body.expectedRefund ?? null, newRefund: quote.estimatedRefund },
      });
    }
    const ask: CancellationAsk = {
      mode: quote.mode as CancellationMode,
      reasonCode: body.reasonCode,
      comment: body.comment === undefined || body.comment.trim() === "" ? null : body.comment.trim(),
      estimate: {
        amountPaid: quote.amountPaid.amount,
        estimatedRefund: quote.estimatedRefund.amount,
        penalty: quote.penalty.amount,
        otaFee: quote.otaFee.amount,
      },
      currency: quote.currency,
      actor: tenant.actor,
      requestedAt,
    };
    const ctenant = this.cancellationTenant(tenant);
    // 3. The claim.
    const claim = await this.tx.run(async (trx): Promise<Claim> => {
      const booking = await this.check(trx, tenant, bookingId, ifMatch, cached.version);
      if (ask.mode === "request_only") {
        await this.recorder.recordRequest(trx, ctenant, booking.row, ask, "request_only", null);
        return { kind: "requested", booking: booking.row };
      }
      const orderId = booking.row.amadeusOrderId;
      if (orderId === null) {
        throw notCancellable("pending");
      }
      await this.repository.bumpVersion(trx, bookingId, this.clock.now());
      return { kind: "claimed", booking: booking.row, orderId };
    });
    if (claim.kind === "requested") {
      return await this.answer(bookingId, 202, this.pendingCancellation(bookingId, ask, quote));
    }
    // 4. Flight Order Management DELETE, no transaction open.
    let outcome: DeleteOutcome;
    try {
      const reply = await this.amadeus.cancelFlightOrder(this.callContext(tenant, claim.booking), {
        flightOrderId: claim.orderId,
      });
      outcome = { kind: "cancelled", supplierRequestId: reply.call.supplierRequestId };
    } catch (error) {
      outcome = deleteFailureOf(error);
    }
    switch (outcome.kind) {
      case "cancelled":
        return await this.recordDeleted(ctenant, bookingId, ask, outcome.supplierRequestId);
      case "order_not_found":
      case "refused": {
        const cause = outcome.kind;
        const supplierCode = outcome.kind === "refused" ? outcome.code : null;
        await this.tx.run(async (trx) => {
          const booking = await this.lockedLive(trx, bookingId);
          await this.recorder.recordRequest(trx, ctenant, booking, ask, cause, supplierCode);
        });
        this.logger.info({ bookingId, cause }, "bookings.cancel_converted_to_request");
        return await this.answer(bookingId, 202, this.pendingCancellation(bookingId, ask, quote));
      }
      case "version_conflict":
        throw outcome.error;
      case "not_sent":
        throw unsentAnswer(outcome.error);
      case "unknown":
        throw await this.unknownOutcome(
          ctenant,
          bookingId,
          ask,
          isAppError(outcome.error) ? outcome.error.code : "UNKNOWN",
          outcome.error,
        );
    }
  }

  /**
   * A cancellation whose outcome is not known (a DELETE without an answer, or a record step that failed after the
   * DELETE's `204`): the booking is flagged, the worker's check is queued after the commit, and the answer is the `504`
   * that the idempotency layer keeps with the booking (see the file header). Never throws itself: a flag that cannot be
   * written is logged, and the same `504` is answered.
   */
  private async unknownOutcome(
    tenant: CancellationTenant,
    bookingId: string,
    ask: CancellationAsk,
    reason: string,
    cause: unknown,
  ): Promise<AppError> {
    try {
      await this.tx.run(async (trx) => {
        const booking = await this.lockedLive(trx, bookingId);
        const until = await this.recorder.recordUnknownOutcome(trx, tenant, booking, ask, reason);
        const job = cancellationCheckJob(tenant.tenantId, bookingId, until.getTime(), 1);
        afterCommit(trx, () => this.recorder.enqueue(this.bookingsQueue, job.name, job.data, job.opts));
      });
    } catch (error) {
      this.logger.error({ bookingId, err: error }, "bookings.cancellation_check_not_scheduled");
    }
    return cancellationTimeout(bookingId, cause);
  }

  /**
   * The checks of bookings.cancel on the booking as `trx` reads it (see the file header); `quoteVersion` given, the
   * claim's: the booking is locked first and must still be at the quote's version.
   */
  private async check(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    ifMatch: string,
    quoteVersion: number | undefined,
  ): Promise<{ readonly row: BookingRow; readonly version: number }> {
    if (quoteVersion !== undefined && !(await this.repository.lock(trx, bookingId, true))) {
      // The claim skips a booking another claim or writer holds (OADR-0014 point 6), a transient answer.
      if ((await this.bookings.booking(trx, bookingId)) === undefined) {
        throw new AppError("NOT_FOUND");
      }
      throw bookingBusy();
    }
    const booking = await this.bookings.booking(trx, bookingId);
    if (booking === undefined || booking.environment !== tenant.environment) {
      throw new AppError("NOT_FOUND");
    }
    if (booking.status === "cancelled") {
      throw new AppError("BOOKING_ALREADY_CANCELLED");
    }
    if (!ifMatchSatisfied(ifMatch, booking.version)) {
      throw new AppError("PRECONDITION_FAILED", { details: { currentVersion: booking.version } });
    }
    const settings = await this.repository.settings(trx);
    if (!selfServiceCancellationOf(settings?.features)) {
      throw notCancellable("disabled_by_ota");
    }
    const state = cancellationStateOf(await this.repository.cancellationEvents(trx, bookingId));
    if (state.kind === "undecided" || state.kind === "requested") {
      throw cancellationPending();
    }
    if (quoteVersion !== undefined && quoteVersion !== booking.version) {
      // The booking changed after the quote (a refresh stored new tickets): its estimate may be another.
      throw new AppError("PRECONDITION_FAILED", { details: { currentVersion: booking.version } });
    }
    return { row: booking, version: booking.version };
  }

  /** The booking locked `FOR NO KEY UPDATE` and still live; `409 BOOKING_ALREADY_CANCELLED` when it is not. */
  private async lockedLive(trx: TenantTransaction, bookingId: string): Promise<BookingRow> {
    if (!(await this.repository.lock(trx, bookingId))) {
      throw new AppError("NOT_FOUND");
    }
    const booking = await this.bookings.booking(trx, bookingId);
    if (booking === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (!LIVE_STATUSES.has(booking.status)) {
      throw new AppError("BOOKING_ALREADY_CANCELLED");
    }
    return booking;
  }

  /**
   * T2 after a DELETE Amadeus accepted, then the void of an authorisation or the capture of its kept amount (no
   * transaction open); the `200` answer.
   */
  private async recordDeleted(
    tenant: CancellationTenant,
    bookingId: string,
    ask: CancellationAsk,
    supplierRequestId: string | null,
  ): Promise<CancelAnswer> {
    let recorded: RecordedCancellation;
    try {
      recorded = await this.tx.run(async (trx) => {
        if (!(await this.repository.lock(trx, bookingId))) {
          throw new AppError("NOT_FOUND");
        }
        return await this.recorder.recordCancelled(trx, tenant, bookingId, ask, {
          cause: "deleted",
          supplierRequestId,
        });
      });
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") {
        throw error;
      }
      // Amadeus cancelled the order, but T2 rolled back: the booking is still live and nothing of the money moved. It
      // is decided like a DELETE without an answer (OADR-0003 points 7 and 9): flagged, the worker's read finds the
      // order gone and records the cancellation with its money step, once; never a `500` the client would retry with
      // a stale `If-Match`.
      this.logger.error({ bookingId, err: error }, "bookings.cancel_record_failed");
      throw await this.unknownOutcome(tenant, bookingId, ask, "record_failed", error);
    }
    if (recorded.kind === "not_live") {
      throw new AppError("BOOKING_ALREADY_CANCELLED");
    }
    await this.recorder.settleAuthorisation(tenant, bookingId, recorded.money, "api");
    return await this.answer(bookingId, 200);
  }

  /** The cancellation of a booking handed to the staff (`202`). */
  private pendingCancellation(
    bookingId: string,
    ask: CancellationAsk,
    quote: CancellationQuote,
  ): Cancellation {
    return {
      bookingId,
      status: "pending",
      requestedAt: ask.requestedAt.toISOString(),
      cancelledAt: null,
      cancelledBy: "customer",
      reasonCode: ask.reasonCode as CancellationReasonCode,
      comment: ask.comment,
      ticketsVoided: false,
      estimatedRefund: quote.estimatedRefund,
      refund: null,
      refundStatus: requestRefundStatus(ask.estimate),
    };
  }

  /**
   * The answer: the booking in customer scope and its cancellation, as bookings.get shows it (bookings.mapper.ts
   * `cancellationOf`: the same block, whichever asks); `fallback` only when the booking shows none (a request the
   * staff settled in the meantime).
   */
  private async answer(bookingId: string, status: 200 | 202, fallback?: Cancellation): Promise<CancelAnswer> {
    const booking: Booking = await this.customerBookings.get(bookingId, { refresh: false });
    const cancellation = booking.cancellation ?? fallback;
    if (cancellation === undefined || cancellation === null) {
      throw new Error("a cancelled booking shows no cancellation");
    }
    return {
      status,
      result: { cancellation, booking: { ...booking, cancellation } },
      version: booking.version,
    };
  }

  // ---- Replays of a 504 (CancelBookingIdempotencyHooks) -------------------------------------------------------------

  /**
   * The answer of a same-key retry of a `504 SUPPLIER_TIMEOUT`, from the booking's state (never an Amadeus call):
   * the same `504` while the worker has not decided, then the final answer (see the file header).
   */
  async replay(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    if (record.resource?.type !== "booking" || record.response.status !== 504) {
      return undefined;
    }
    const bookingId = record.resource.id;
    const tenant = this.tenants.require();
    const decided = await this.tx.run(async (trx) => {
      const booking = await this.bookings.booking(trx, bookingId);
      if (booking === undefined || booking.environment !== tenant.environment) {
        return undefined;
      }
      const events = await this.repository.cancellationEvents(trx, bookingId);
      const flagged = events.findIndex((event) => event.type === CANCELLATION_EVENTS.timeout);
      if (booking.status === "cancelled") {
        const cancelled = await this.repository.cancelledEvent(trx, bookingId);
        const ours =
          cancelled !== undefined &&
          isRecord(cancelled.data) &&
          cancelled.data["cancelledBy"] === "customer" &&
          (flagged < 0 || cancelled.createdAt.getTime() >= (events[flagged]?.createdAt.getTime() ?? 0));
        if (!ours) {
          return { kind: "error" as const, error: new AppError("BOOKING_ALREADY_CANCELLED") };
        }
        return { kind: "cancelled" as const };
      }
      const state = cancellationStateOf(events);
      if (state.kind === "not_applied") {
        return { kind: "error" as const, error: cancellationNotApplied(bookingId) };
      }
      return { kind: "undecided" as const };
    });
    if (decided === undefined) {
      return undefined;
    }
    if (decided.kind === "undecided") {
      return replayedTimeout(record.response);
    }
    if (decided.kind === "error") {
      const { status, body } = toErrorEnvelope(decided.error, this.requestId(tenant), {
        exposeSupplier: this.requestContext.isConsoleScope(),
      });
      return { status, headers: { "cache-control": "no-store" }, setCookie: [], body };
    }
    const answer = await this.answer(bookingId, 200);
    this.logger.info({ bookingId }, "bookings.cancel_replayed");
    return {
      status: 200,
      headers: { etag: bookingEtagOf(answer.version), "cache-control": CANCELLATION_CACHE_CONTROL },
      setCookie: [],
      body: answer.result,
    };
  }

  // ---- Shared ------------------------------------------------------------------------------------------------------

  private cancellationTenant(tenant: RequestTenant): CancellationTenant {
    return {
      tenantId: tenant.tenantId,
      key: tenant.key,
      environment: tenant.environment,
      requestId: this.requestId(tenant),
    };
  }

  private callContext(tenant: RequestTenant, booking: BookingRow): AmadeusCallContext {
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: CANCEL_OPERATION,
      requestId: this.requestId(tenant),
      bookingId: booking.id,
      ...(booking.ownerOfficeId === null ? {} : { orderOffice: booking.ownerOfficeId }),
    };
  }

  private requestId(tenant: RequestTenant): string {
    return this.tenants.requestId() ?? tenant.requestId;
  }

  /** The key of the booking's quote, or `undefined` when an id cannot be a key part (the cache is then skipped). */
  private keyOf(tenant: RequestTenant, bookingId: string): RedisKey | undefined {
    try {
      return redisKeys.cxq(tenant.tenantId, tenant.environment, bookingId);
    } catch (error) {
      if (error instanceof TypeError) {
        return undefined;
      }
      throw error;
    }
  }

  /** The cached quote, or `undefined` for a miss, an unreadable entry or a Redis that does not answer. */
  private async readCache(tenant: RequestTenant, bookingId: string): Promise<CachedQuote | undefined> {
    const key = this.keyOf(tenant, bookingId);
    if (key === undefined || REDIS_DOWN.has(this.redis.status)) {
      return undefined;
    }
    let raw: string | null;
    try {
      raw = await this.redis.get(key.key);
    } catch {
      return undefined; // The connection logs the outage (redis.module.ts); the quote is computed again.
    }
    return raw === null ? undefined : decodeCachedQuote(raw, bookingId);
  }

  /** Caches a quote for 10 minutes; Redis errors are ignored (bookings.cancel then computes it again). */
  private async writeCache(tenant: RequestTenant, bookingId: string, cached: CachedQuote): Promise<void> {
    const key = this.keyOf(tenant, bookingId);
    if (key === undefined || REDIS_DOWN.has(this.redis.status)) {
      return;
    }
    try {
      await this.redis.set(key.key, JSON.stringify(cached), "EX", key.ttlSeconds);
    } catch {
      // Not cached this time.
    }
  }
}

/**
 * The idempotency hooks of bookings.cancel (OBE-014 hooks, as checkout.complete's of OBE-043): a `504
 * SUPPLIER_TIMEOUT` is linked to its booking and kept, and its same-key replays are answered from the booking
 * (`CancellationService.replay`).
 */
@Injectable()
@IdempotencyHooksFor(["cancelBooking"])
export class CancelBookingIdempotencyHooks implements IdempotencyHooks {
  constructor(private readonly cancellations: CancellationService) {}

  resourceOf(response: IdempotencyResponse): IdempotencyResource | undefined {
    return pendingBookingOf(response);
  }

  resolveReplay(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    return this.cancellations.replay(record);
  }
}

// ---- The worker's check after a DELETE without an answer --------------------------------------------------------------

/** The payload of `booking.cancellation_check`: the tenant and the booking, nothing else (ADR-0009). */
export interface CancellationCheckJobData {
  readonly tenantId: string;
  readonly bookingId: string;
}

/** The payload of a `booking.cancellation_check` job, or `undefined` when it is not one (extra fields included). */
export function parseCancellationCheckJobData(data: unknown): CancellationCheckJobData | undefined {
  if (!isRecord(data) || Object.keys(data).length !== 2) {
    return undefined;
  }
  const { tenantId, bookingId } = data;
  return typeof tenantId === "string" &&
    TENANT_ID.test(tenantId) &&
    typeof bookingId === "string" &&
    BOOKING_ID.test(bookingId)
    ? { tenantId, bookingId }
    : undefined;
}

/**
 * The `run`-th check of a flag of a booking: job id `booking.cancellation_check:<bkg_…>:<deadline>-<run>` (three
 * parts, as BullMQ wants a custom id with `:`; `<deadline>` is the flag's deadline in epoch milliseconds, so a later
 * flag of the same booking starts a chain of its own while BullMQ still keeps the jobs of the earlier one), the first
 * 30 s after the DELETE, the next ones a minute apart.
 */
export function cancellationCheckJob(
  tenantId: string,
  bookingId: string,
  deadlineMs: number,
  run: number,
): {
  readonly name: string;
  readonly data: CancellationCheckJobData;
  readonly opts: { readonly jobId: string; readonly delay: number };
} {
  return {
    name: CANCELLATION_CHECK_JOB,
    data: { tenantId, bookingId },
    opts: {
      jobId: `${CANCELLATION_CHECK_JOB}:${bookingId}:${deadlineMs}-${run}`,
      delay: run === 1 ? CANCELLATION_CHECK_FIRST_DELAY_MS : CANCELLATION_CHECK_INTERVAL_MS,
    },
  };
}

/** The flag deadline and the run of a check job from its id (`{0, 1}` when it cannot be read). */
export function checkRunOf(job: Pick<Job, "id">): { readonly deadlineMs: number; readonly run: number } {
  const match = /:(\d{1,15})-(\d{1,4})$/.exec(String(job.id ?? ""));
  return match === null ? { deadlineMs: 0, run: 1 } : { deadlineMs: Number(match[1]), run: Number(match[2]) };
}

/** The runs of one flag's chain at most: a booking another transaction keeps holding is not checked for ever. */
export const CANCELLATION_CHECK_MAX_RUNS = 30;

/** The tenant statuses whose cancellations are checked (as the reconciliation's, OADR-0014 point 4). */
const CHECK_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** What a finished `booking.cancellation_check` job returns (BullMQ keeps it with the job). */
export interface CancellationCheckResult {
  readonly tenantId: string;
  readonly bookingId: string;
  readonly outcome:
    | "cancelled"
    | "not_applied"
    | "manual_review"
    | "rescheduled"
    | "gave_up"
    | "nothing_to_check"
    | "tenant_skipped";
}

/** What the claim of a check read. */
type CheckClaim =
  | { readonly kind: "busy" }
  | { readonly kind: "nothing" }
  | {
      readonly kind: "claimed";
      readonly booking: BookingRow;
      readonly orderId: string;
      readonly flag: CancellationFlag;
    };

/** How the order read of a check ended. */
type OrderState =
  | { readonly kind: "cancelled"; readonly supplierRequestId: string | null }
  | { readonly kind: "active"; readonly supplierRequestId: string | null }
  | { readonly kind: "unreadable"; readonly code: string };

/** Whether every segment of every offer of an order's `data` is `CANCELLED` (and there is at least one). */
export function orderCancelled(data: unknown): boolean {
  const statuses = (isRecord(data) ? records(data["flightOffers"]) : []).flatMap((offer) =>
    records(offer["itineraries"]).flatMap((itinerary) =>
      records(itinerary["segments"]).map((segment) => segment["bookingStatus"]),
    ),
  );
  return statuses.length > 0 && statuses.every((status) => status === "CANCELLED");
}

/**
 * `booking.cancellation_check` (worker only; reconcile.processor.ts hands the jobs of `ota-bookings` over): decides a
 * cancellation whose DELETE got no answer (see the file header).
 */
@Injectable()
export class CancellationChecks {
  constructor(
    private readonly tx: TenantTx,
    private readonly bookings: BookingsRepository,
    private readonly repository: CancellationRepository,
    private readonly recorder: CancellationRecorder,
    private readonly amadeus: AmadeusClient,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    @InjectQueue(OTA_QUEUE.bookings) private readonly queue: Queue,
    private readonly clock: Clock,
    @InjectPinoLogger(CancellationChecks.name) private readonly logger: PinoLogger,
  ) {}

  /** One job (the payload checked first: exactly the two ids, else it fails at once with `UnrecoverableError`). */
  async process(job: Job): Promise<CancellationCheckResult> {
    const data = parseCancellationCheckJobData(job.data);
    if (data === undefined) {
      this.logger.error({ queue: job.queueName, jobId: job.id }, "bookings.cancellation_check_job_invalid");
      throw new UnrecoverableError("the job is not booking.cancellation_check {tenantId, bookingId}");
    }
    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !CHECK_TENANT_STATUSES.includes(tenant.status)) {
      return { ...data, outcome: "tenant_skipped" };
    }
    const requestId = jobRequestId(job);
    const outcome = await this.tenants.run({ ...jobTenant(tenant, job), requestId }, () =>
      this.check(tenant, data.bookingId, requestId, checkRunOf(job)),
    );
    return { ...data, outcome };
  }

  /** One check of a booking (see the file header). */
  async check(
    tenant: PlatformTenant,
    bookingId: string,
    requestId: string,
    chain: { readonly deadlineMs: number; readonly run: number },
  ): Promise<CancellationCheckResult["outcome"]> {
    const claim = await this.tx.run(async (trx): Promise<CheckClaim> => {
      if (!(await this.repository.lock(trx, bookingId, true))) {
        return { kind: "busy" };
      }
      const booking = await this.bookings.booking(trx, bookingId);
      if (booking === undefined || !LIVE_STATUSES.has(booking.status) || booking.amadeusOrderId === null) {
        return { kind: "nothing" };
      }
      const state = cancellationStateOf(await this.repository.cancellationEvents(trx, bookingId));
      return state.kind === "undecided"
        ? { kind: "claimed", booking, orderId: booking.amadeusOrderId, flag: state.flag }
        : { kind: "nothing" };
    });
    if (claim.kind === "nothing") {
      return "nothing_to_check";
    }
    if (claim.kind === "busy") {
      return await this.reschedule(tenant, bookingId, chain);
    }
    const { booking, flag } = claim;
    const environment = booking.environment === "live" ? "live" : "test";
    const ctenant: CancellationTenant = { tenantId: tenant.id, key: tenant.key, environment, requestId };
    const order = await this.readOrder(ctenant, booking, claim.orderId);
    const now = this.clock.now();
    if (order.kind === "unreadable") {
      if (now.getTime() < Date.parse(flag.until)) {
        return await this.reschedule(tenant, bookingId, {
          deadlineMs: Date.parse(flag.until),
          run: chain.run,
        });
      }
      await this.tx.run(async (trx) => {
        if (await this.stillUndecided(trx, bookingId)) {
          const current = await this.bookings.booking(trx, bookingId);
          if (current !== undefined) {
            await this.recorder.recordManualReview(trx, ctenant, current, order.code);
          }
        }
      });
      return "manual_review";
    }
    if (order.kind === "active") {
      await this.tx.run(async (trx) => {
        if (await this.stillUndecided(trx, bookingId)) {
          const current = await this.bookings.booking(trx, bookingId);
          if (current !== undefined) {
            await this.recorder.recordNotApplied(trx, ctenant, current, order.supplierRequestId);
          }
        }
      });
      return "not_applied";
    }
    const ask: CancellationAsk = {
      mode: flag.mode,
      reasonCode: flag.reasonCode,
      comment: flag.comment,
      estimate: flag.estimate,
      currency: flag.currency,
      actor: flag.actor,
      requestedAt: new Date(flag.requestedAt),
    };
    const recorded = await this.tx.run(async (trx) => {
      if (!(await this.stillUndecided(trx, bookingId))) {
        return undefined;
      }
      return await this.recorder.recordCancelled(trx, ctenant, bookingId, ask, {
        cause: "checked",
        supplierRequestId: order.supplierRequestId,
      });
    });
    if (recorded?.kind === "cancelled") {
      await this.recorder.settleAuthorisation(ctenant, bookingId, recorded.money, "system");
    }
    return recorded?.kind === "cancelled" ? "cancelled" : "nothing_to_check";
  }

  /** Locks the booking (waiting) and answers whether it is still live with an undecided flag. */
  private async stillUndecided(trx: TenantTransaction, bookingId: string): Promise<boolean> {
    if (!(await this.repository.lock(trx, bookingId))) {
      return false;
    }
    const booking = await this.bookings.booking(trx, bookingId);
    return (
      booking !== undefined &&
      LIVE_STATUSES.has(booking.status) &&
      cancellationStateOf(await this.repository.cancellationEvents(trx, bookingId)).kind === "undecided"
    );
  }

  /** Flight Order Management GET of the order, no transaction open. */
  private async readOrder(
    tenant: CancellationTenant,
    booking: BookingRow,
    orderId: string,
  ): Promise<OrderState> {
    const context: AmadeusCallContext = {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: CANCELLATION_CHECK_OPERATION,
      requestId: tenant.requestId,
      bookingId: booking.id,
      ...(booking.ownerOfficeId === null ? {} : { orderOffice: booking.ownerOfficeId }),
    };
    try {
      const reply = await this.amadeus.getFlightOrder(context, { flightOrderId: orderId });
      const body: unknown = reply.body;
      const data = isRecord(body) ? body["data"] : undefined;
      if (!isRecord(data)) {
        return { kind: "unreadable", code: "SUPPLIER_ERROR" };
      }
      return orderCancelled(data)
        ? { kind: "cancelled", supplierRequestId: reply.call.supplierRequestId }
        : { kind: "active", supplierRequestId: reply.call.supplierRequestId };
    } catch (error) {
      if (isAppError(error) && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404) {
        // The order is gone: the DELETE that got no answer cancelled it.
        return { kind: "cancelled", supplierRequestId: null };
      }
      this.logger.warn(
        { bookingId: booking.id, code: isAppError(error) ? error.code : "INTERNAL_ERROR", err: error },
        "bookings.cancellation_check_read_failed",
      );
      return { kind: "unreadable", code: isAppError(error) ? error.code : "INTERNAL_ERROR" };
    }
  }

  /** Queues the next check of the chain a minute later, up to CANCELLATION_CHECK_MAX_RUNS runs. */
  private async reschedule(
    tenant: PlatformTenant,
    bookingId: string,
    chain: { readonly deadlineMs: number; readonly run: number },
  ): Promise<CancellationCheckResult["outcome"]> {
    if (chain.run >= CANCELLATION_CHECK_MAX_RUNS) {
      this.logger.warn(
        { tenantId: tenant.id, bookingId, run: chain.run },
        "bookings.cancellation_check_gave_up",
      );
      return "gave_up";
    }
    const job = cancellationCheckJob(tenant.id, bookingId, chain.deadlineMs, chain.run + 1);
    await this.recorder.enqueue(this.queue, job.name, job.data, job.opts);
    return "rescheduled";
  }
}
