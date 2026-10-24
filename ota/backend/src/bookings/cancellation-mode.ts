// What cancelling a booking now would do (OBE-049; ota/docs/flows/change-and-cancel.md §3 steps 3 and 5, OADR-0005
// point 7): the mode of bookings.quoteCancellation and bookings.cancel and the customer's refund estimate. Pure: no
// I/O, no clock (the caller passes `now`), money as decimal strings computed with decimal.js (conventions §1).
//
// Modes, the first that applies:
//
//   not_allowed    the booking's `canCancel` is false (allowed-actions.ts, the same rule the storefront shows):
//                  `cancelled`, `flown` (a segment flown or departed), `too_close_to_departure` (3 hours or less
//                  before the first remaining departure), `disabled_by_ota` (self-service cancellation off in the
//                  storefront settings), and `pending` for a booking that is not live (`pending`, `failed`) or has no
//                  Amadeus order yet
//   release        nothing is ticketed: no ticket that still holds a seat (every stored ticket `VOID` or `REFUNDED`,
//                  or none) and a ticketing state that does not say otherwise; Flight Order Management DELETE cancels
//                  the order
//   void           every ticket that holds a seat was issued today in the OTA's time zone
//                  (`storefront_settings.time_zone`): DELETE voids them; `voidDeadlineAt` is the next midnight there
//   request_only   anything else: a ticket issued before today (outside the void window), a ticket whose issue time
//                  is unknown, or a ticketing state `issued`/`partially_issued` without stored tickets. The MVP has no
//                  automatic airline refund: the request goes to the staff
//
// Refund estimate (release and void): what the money step gives back of the booking's payment.
//
//   Stripe, captured     what can still be refunded (captured − refunded − refunds in flight), less what the OTA
//                        keeps: the booking's non-refundable fees (`fee_rules.refundable = false` when it was priced,
//                        from the priced offer's snapshot: `keptFeesOf`), the `cancellation` fees of the engine on the
//                        booking total (OADR-0005 point 7) and the payment's card fee unless its line is refundable
//                        (`keptCardFee`, lead decision (2) of 2026-10-23, second batch: card-fees.ts `keptCardFeeOf`;
//                        the Amadeus credit-card fee is never refundable), never below zero
//   Stripe, authorised   the same split of the authorisation (lead decision (1) of 2026-10-23, second batch): the money
//                        step captures the amount kept and Stripe releases the rest, which is the refund; only a kept
//                        amount of zero voids the authorisation (everything back)
//   airline card         what the airline charged: a void reverses its charge (no OTA fee in net pricing; the OTA
//                        holds no money it could keep)
//   none                 0
//
// `request_only` and `not_allowed` estimate 0: the staff decide the refund of a request (flow §3 step 6). Every amount
// has the currency's minor units; the airline penalty of release and void is 0.
import type { components } from "@velexis/api-types";
import { Money, type MoneyValue } from "../pricing/pricing.types";
import { distribute } from "../shopping/offers.mapper";
import { allowedActionsOf, type ActionSegment } from "./allowed-actions";

type Schemas = components["schemas"];

/** CancellationQuote.mode as the MVP computes it (no automatic `refund` mode: scope.md §3.3). */
export type CancellationMode = Extract<
  Schemas["CancellationQuote"]["mode"],
  "release" | "void" | "request_only" | "not_allowed"
>;

/** CancellationQuote.notAllowedReason. */
export type NotAllowedReason = NonNullable<Schemas["CancellationQuote"]["notAllowedReason"]>;

/** The modes in which bookings.cancel calls Flight Order Management DELETE. */
export const DELETE_MODES: ReadonlySet<CancellationMode> = new Set<CancellationMode>(["release", "void"]);

/** Ticket statuses (Amadeus `documentStatus`) of a ticket that no longer holds a seat or money. */
export const SETTLED_TICKET_STATUSES: ReadonlySet<string> = new Set(["VOID", "REFUNDED"]);

/** Ticketing states that say the booking has tickets, whatever `booking_tickets` holds. */
const TICKETED_STATES: ReadonlySet<string> = new Set(["issued", "partially_issued"]);

const NOT_ALLOWED_REASONS: ReadonlySet<string> = new Set<NotAllowedReason>([
  "cancelled",
  "flown",
  "pending",
  "disabled_by_ota",
  "too_close_to_departure",
]);

/** A stored ticket as the mode reads it. */
export interface ModeTicket {
  readonly status: string;
  /** When it was issued (`booking_tickets.issued_at`), `null` when unknown. */
  readonly issuedAt: Date | null;
}

/** What the mode reads of a booking. */
export interface CancellationModeInput {
  readonly status: string;
  readonly ticketingStatus: string;
  readonly amadeusOrderId: string | null;
  readonly lastArrivalAt: Date;
  readonly segments: readonly ActionSegment[];
  readonly tickets: readonly ModeTicket[];
  /** `storefront_settings.features.selfServiceCancellation`. */
  readonly selfServiceCancellation: boolean;
  /** `storefront_settings.time_zone` (IANA); UTC when it is not one the runtime knows. */
  readonly timeZone: string;
  readonly now: Date;
}

/** The mode, why cancellation is not allowed, and the end of the void window. */
export interface CancellationModeResult {
  readonly mode: CancellationMode;
  readonly notAllowedReason: NotAllowedReason | null;
  /** In `void` mode the next midnight in the OTA's time zone, the end of the void window; else `null`. */
  readonly voidDeadlineAt: Date | null;
}

/** The mode of a cancellation of the booking at `input.now` (see the file header). */
export function cancellationModeOf(input: CancellationModeInput): CancellationModeResult {
  const allowed = allowedActionsOf({
    status: input.status,
    ticketingStatus: input.ticketingStatus,
    amadeusOrderId: input.amadeusOrderId,
    lastArrivalAt: input.lastArrivalAt,
    segments: input.segments,
    documentsReady: false,
    features: { selfServiceCancellation: input.selfServiceCancellation, ancillaries: false },
    lastRefreshAt: null,
    now: input.now,
  });
  if (!allowed.canCancel) {
    const reason = allowed.reasons["canCancel"];
    return {
      mode: "not_allowed",
      notAllowedReason:
        reason !== undefined && NOT_ALLOWED_REASONS.has(reason) ? (reason as NotAllowedReason) : "pending",
      voidDeadlineAt: null,
    };
  }
  if (input.amadeusOrderId === null) {
    return { mode: "not_allowed", notAllowedReason: "pending", voidDeadlineAt: null };
  }
  const live = input.tickets.filter((ticket) => !SETTLED_TICKET_STATUSES.has(ticket.status));
  if (live.length === 0) {
    return TICKETED_STATES.has(input.ticketingStatus)
      ? { mode: "request_only", notAllowedReason: null, voidDeadlineAt: null }
      : { mode: "release", notAllowedReason: null, voidDeadlineAt: null };
  }
  const day = localDayOf(input.now, input.timeZone);
  const issuedToday = live.every(
    (ticket) =>
      ticket.issuedAt !== null &&
      ticket.issuedAt.getTime() >= day.startsAt.getTime() &&
      ticket.issuedAt.getTime() < day.endsAt.getTime(),
  );
  return issuedToday
    ? { mode: "void", notAllowedReason: null, voidDeadlineAt: day.endsAt }
    : { mode: "request_only", notAllowedReason: null, voidDeadlineAt: null };
}

// ---- The OTA's day -----------------------------------------------------------------------------------------------

/** A calendar day in a time zone: its first instant and the first instant of the next day. */
export interface LocalDay {
  /** `YYYY-MM-DD` in the zone. */
  readonly date: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** The zone, or UTC when the runtime does not know it. */
function knownZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** The wall clock of `at` in `timeZone` as the epoch milliseconds of the same wall clock in UTC (whole seconds). */
function wallClockMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
}

/** The instant whose wall clock in `timeZone` is the UTC wall clock `wall` (the later one of a repeated hour). */
function instantOfWallClock(wall: number, timeZone: string): Date {
  const first = wall - (wallClockMs(new Date(wall), timeZone) - wall);
  const second = wall - (wallClockMs(new Date(first), timeZone) - first);
  return new Date(second);
}

/** The day of `at` in `timeZone` (UTC when unknown), with its bounds (see LocalDay). */
export function localDayOf(at: Date, timeZone: string): LocalDay {
  const zone = knownZone(timeZone);
  const wall = new Date(wallClockMs(at, zone));
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const next = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  return {
    date: new Date(midnight).toISOString().slice(0, 10),
    startsAt: instantOfWallClock(midnight, zone),
    endsAt: instantOfWallClock(next, zone),
  };
}

// ---- The refund estimate -----------------------------------------------------------------------------------------

/** The payment the money step acts on (see the file header). */
export type EstimatePayment =
  | { readonly kind: "none" }
  /**
   * A Stripe payment `captured` or `partially_refunded`: what it captured, and what can still be refunded of it
   * (captured − refunded − refunds in flight).
   */
  | { readonly kind: "stripe_captured"; readonly captured: string; readonly refundable: string }
  /** A Stripe payment `authorized` and not captured: the amount it holds. */
  | { readonly kind: "stripe_authorized"; readonly authorized: string }
  /** An airline-card payment: what the airline charged. */
  | { readonly kind: "airline"; readonly charged: string };

/** What the estimate is computed from. */
export interface RefundEstimateInput {
  readonly mode: CancellationMode;
  readonly minorUnits: number;
  readonly payment: EstimatePayment;
  /** The booking's OTA fees that are not refunded (`keptFeesOf`), a decimal string. */
  readonly keptFees: string;
  /** The amounts of the engine's `cancellation` fee lines on the booking total. */
  readonly cancellationFees: readonly string[];
  /** The part of the payment's card fee that is kept (card-fees.ts `keptCardFeeOf`), a decimal string. */
  readonly keptCardFee: string;
}

/** CancellationQuote's amounts, decimal strings with the currency's minor units. */
export interface RefundEstimate {
  /** What the customer paid (CancellationQuote.amountPaid: captured, else authorised, else charged by the airline). */
  readonly amountPaid: string;
  readonly estimatedRefund: string;
  /** The airline's penalty (0 in release and void). */
  readonly penalty: string;
  /** The OTA fees kept: non-refundable fees, the card fee unless refundable and the cancellation fee (`otaFee`). */
  readonly otaFee: string;
}

const sumOf = (amounts: readonly string[]): MoneyValue =>
  amounts.reduce((total, amount) => total.plus(amount), new Money(0));

/** The refund estimate of a cancellation (see the file header). */
export function refundEstimateOf(input: RefundEstimateInput): RefundEstimate {
  const fixed = (value: MoneyValue): string => value.toFixed(input.minorUnits);
  const zero = new Money(0);
  const { payment } = input;
  const paid =
    payment.kind === "stripe_captured"
      ? new Money(payment.captured)
      : payment.kind === "stripe_authorized"
        ? new Money(payment.authorized)
        : payment.kind === "airline"
          ? new Money(payment.charged)
          : zero;
  if (!DELETE_MODES.has(input.mode) || payment.kind === "none") {
    return {
      amountPaid: fixed(paid),
      estimatedRefund: fixed(zero),
      penalty: fixed(zero),
      otaFee: fixed(zero),
    };
  }
  if (payment.kind === "airline") {
    // The airline reverses its whole charge.
    return {
      amountPaid: fixed(paid),
      estimatedRefund: fixed(paid),
      penalty: fixed(zero),
      otaFee: fixed(zero),
    };
  }
  // What is left to refund of a capture, or the authorisation, less what the OTA keeps (never more than there is).
  const base = payment.kind === "stripe_captured" ? new Money(payment.refundable) : paid;
  const kept = Money.min(
    base,
    new Money(input.keptFees).plus(sumOf(input.cancellationFees)).plus(input.keptCardFee),
  );
  return {
    amountPaid: fixed(paid),
    estimatedRefund: fixed(Money.max(zero, base.minus(kept))),
    penalty: fixed(zero),
    otaFee: fixed(Money.max(zero, kept)),
  };
}

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fee lines of a pricing snapshot list that the cancellation keeps (`refundable: false`), with their amounts. */
function keptLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const amounts: string[] = [];
  for (const line of value) {
    if (!isRecord(line) || typeof line["amount"] !== "string" || !/^\d+(?:\.\d+)?$/.test(line["amount"])) {
      return undefined;
    }
    if (line["refundable"] !== true) {
      amounts.push(line["amount"]);
    }
  }
  return amounts;
}

/**
 * The non-refundable OTA fees of a booking from its priced offer's stored answer (`priced_offers.response`): the fee
 * lines of its pricing snapshot (`velexis.feeLines`, the `booking_service` and `ticketing` fees, and the
 * `ancillary_service` fees of its extras, `velexis.extras.feeLines`) whose rule was not refundable, summed; a line
 * without the flag counts as kept, as `fee_rules.refundable` defaults to false. `undefined` when the snapshot cannot be
 * read (the caller then keeps every fee of the booking).
 */
export function keptFeesOf(response: unknown, minorUnits: number): string | undefined {
  const snapshot = isRecord(response) ? response["velexis"] : undefined;
  if (!isRecord(snapshot)) {
    return undefined;
  }
  const booking = keptLines(snapshot["feeLines"]);
  const extras = isRecord(snapshot["extras"]) ? keptLines(snapshot["extras"]["feeLines"]) : [];
  if (booking === undefined || extras === undefined) {
    return undefined;
  }
  return sumOf([...booking, ...extras]).toFixed(minorUnits);
}

// ---- Lines per traveller ----------------------------------------------------------------------------------------

/** A traveller of the booking as a refund line shows it. */
export interface LineTraveler {
  /** The Amadeus traveller id. */
  readonly travelerId: string;
  readonly travelerName: string | null;
  /** The traveller's ticket that still holds a seat, `null` when not ticketed. */
  readonly ticketNumber: string | null;
  /** The share of the booking this traveller paid (a traveller pricing's total), a decimal string; any scale. */
  readonly weight: string;
}

/** One CancellationRefundLine, its amounts as decimal strings. */
export interface RefundLine {
  readonly travelerId: string;
  readonly travelerName: string | null;
  readonly ticketNumber: string | null;
  readonly paid: string;
  readonly refund: string;
  readonly penalty: string;
}

/**
 * The estimate split over the travellers in proportion to their weights (equally when none is known), each amount in
 * the currency's minor units, the lines summing exactly to the totals (largest remainders).
 */
export function refundLinesOf(
  travelers: readonly LineTraveler[],
  estimate: RefundEstimate,
  minorUnits: number,
): RefundLine[] {
  const weights = travelers.map((traveler) => new Money(traveler.weight));
  const paid = distribute(new Money(estimate.amountPaid), weights, minorUnits);
  const refund = distribute(new Money(estimate.estimatedRefund), weights, minorUnits);
  const penalty = distribute(new Money(estimate.penalty), weights, minorUnits);
  return travelers.map((traveler, index) => ({
    travelerId: traveler.travelerId,
    travelerName: traveler.travelerName,
    ticketNumber: traveler.ticketNumber,
    paid: (paid[index] ?? new Money(0)).toFixed(minorUnits),
    refund: (refund[index] ?? new Money(0)).toFixed(minorUnits),
    penalty: (penalty[index] ?? new Money(0)).toFixed(minorUnits),
  }));
}

/**
 * Whether the amount a client sent as `expectedRefund` is the quote's estimate: same currency, same amount (any
 * number of trailing zeros). A missing one never matches: bookings.cancel moves money only for an amount the customer
 * saw (`409 REFUND_AMOUNT_CHANGED` with `details.newRefund`).
 */
export function expectedRefundMatches(
  expected: { readonly amount: string; readonly currency: string } | undefined,
  quoted: { readonly amount: string; readonly currency: string },
): boolean {
  return (
    expected !== undefined &&
    expected.currency === quoted.currency &&
    /^\d+(?:\.\d+)?$/.test(expected.amount) &&
    new Money(expected.amount).equals(quoted.amount)
  );
}
