// Where a booking's cancellation stands, from its rows (OBE-049; FIX-W28-CANCEL): the events a cancellation writes
// (`booking_events`), the flag of a Flight Order Management DELETE without an answer and what it held, the state of a
// live booking's cancellation (none, undecided, not applied, a request waiting for the staff), and the facts the
// `cancellation` block of bookings.get and console.bookings.get is built from (bookings.mapper.ts `cancellationOf`).
// cancellation.service.ts writes these events and decides with the same state; it re-exports what it always exported.
//
// The reads are tenant queries that take the `tenantTx` transaction first and never name a tenant schema, like every
// tenant repository; the rest is pure.
//
// The money facts of a cancelled booking (`CancellationFacts.payments`): the payments its `booking.cancelled` event
// names, the authorisation voided after the commit (`voidPaymentId`) and the authorisation the cancellation captured
// the kept amount of (`capturePaymentId`, lead decision (1) of 2026-10-23, second batch): their status, and for the
// capture whether the payments queue's retry gave up on it (`payment.capture_failed` with `final`, which handed it to
// the staff). bookings.mapper.ts reads `refundStatus` from them.
import { sql } from "@velexis/db";
import type { ContextActor } from "../tenancy/tenant-context";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type { CancellationMode, RefundEstimate } from "./cancellation-mode";

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The booking events of a cancellation. */
export const CANCELLATION_EVENTS = Object.freeze({
  /** Customer-visible: the booking was cancelled (OrderRecorder.event asks for the cancelled itinerary). */
  cancelled: "booking.cancelled",
  /** Customer-visible: the cancellation was handed to the staff (`request_only`, a refusal). */
  requested: "booking.cancellation_requested",
  /** Staff-only: Flight Order Management DELETE got no answer that decides it; the flag the worker checks. */
  timeout: "booking.cancellation_timeout",
  /** Staff-only: the worker found the order still active after a DELETE without an answer. */
  notApplied: "booking.cancellation_not_applied",
  /** Staff-only: still undecided at the deadline; the staff decide. */
  manualReview: "booking.cancellation_manual_review",
} as const);

/** The event types of a live booking's cancellation state (CANCELLATION_EVENTS but `cancelled`). */
export const CANCELLATION_STATE_EVENTS: readonly string[] = Object.freeze([
  CANCELLATION_EVENTS.requested,
  CANCELLATION_EVENTS.timeout,
  CANCELLATION_EVENTS.notApplied,
  CANCELLATION_EVENTS.manualReview,
]);

/** The payment event the payments queue writes when its capture of a cancellation's kept amount gives up. */
export const CAPTURE_FAILED_EVENT = "payment.capture_failed";

/** A booking event of a cancellation, newest first. */
export interface CancellationEventRow {
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly data: unknown;
  readonly createdAt: Date;
}

/** What a cancellation flag (the `booking.cancellation_timeout` event) holds: the request, to decide it later. */
export interface CancellationFlag {
  readonly mode: CancellationMode;
  readonly reasonCode: string;
  readonly comment: string | null;
  readonly estimate: RefundEstimate;
  readonly currency: string;
  readonly requestedAt: string;
  readonly until: string;
  readonly actor: ContextActor;
  readonly requestId: string;
  /** Who asked: the customer (bookings.cancel), or the staff (console.bookings.cancel, OBE-063: data `cancelledBy`). */
  readonly cancelledBy: "customer" | "staff";
}

/** The flag of `row`, or `undefined` when its data cannot be read. */
export function flagOf(row: CancellationEventRow): CancellationFlag | undefined {
  const data = isRecord(row.data) ? row.data : {};
  const estimate = isRecord(data["estimate"]) ? data["estimate"] : {};
  const amounts = ["amountPaid", "estimatedRefund", "penalty", "otaFee"].map((key) => text(estimate[key]));
  const actor = isRecord(data["actor"]) ? data["actor"] : {};
  const mode = data["mode"];
  if (
    (mode !== "release" && mode !== "void") ||
    typeof data["reasonCode"] !== "string" ||
    typeof data["until"] !== "string" ||
    typeof data["currency"] !== "string" ||
    amounts.some((amount) => amount === undefined || !/^\d+(?:\.\d+)?$/.test(amount))
  ) {
    return undefined;
  }
  const [amountPaid, estimatedRefund, penalty, otaFee] = amounts as [string, string, string, string];
  const actorType = actor["type"];
  return {
    mode,
    reasonCode: data["reasonCode"],
    comment: text(data["comment"]) ?? null,
    estimate: { amountPaid, estimatedRefund, penalty, otaFee },
    currency: data["currency"],
    requestedAt: text(data["requestedAt"]) ?? data["until"],
    until: data["until"],
    actor: {
      type: actorType === "customer" || actorType === "guest" ? actorType : "system",
      id: text(actor["id"]) ?? null,
    },
    requestId: text(data["requestId"]) ?? "unknown",
    cancelledBy: data["cancelledBy"] === "staff" ? "staff" : "customer",
  };
}

/** Where a booking's cancellation stands, from its events (newest first). */
export type CancellationState =
  | { readonly kind: "none" }
  /** A DELETE without an answer, not decided yet. */
  | { readonly kind: "undecided"; readonly flag: CancellationFlag; readonly flaggedAt: Date }
  /** The worker found the order still active after the DELETE without an answer. */
  | { readonly kind: "not_applied" }
  /** A cancellation request waits for the staff (`event` is its `booking.cancellation_requested`). */
  | { readonly kind: "requested"; readonly event?: CancellationEventRow };

/** The state of a live booking's cancellation (see CancellationState); the events newest first. */
export function cancellationStateOf(events: readonly CancellationEventRow[]): CancellationState {
  const latest = events[0];
  if (latest === undefined) {
    return { kind: "none" };
  }
  if (latest.type === CANCELLATION_EVENTS.requested) {
    return { kind: "requested", event: latest };
  }
  if (latest.type === CANCELLATION_EVENTS.notApplied) {
    return { kind: "not_applied" };
  }
  if (latest.type === CANCELLATION_EVENTS.timeout || latest.type === CANCELLATION_EVENTS.manualReview) {
    const flagRow = events.find((event) => event.type === CANCELLATION_EVENTS.timeout);
    const flag = flagRow === undefined ? undefined : flagOf(flagRow);
    return flag === undefined || flagRow === undefined
      ? { kind: "none" }
      : { kind: "undecided", flag, flaggedAt: flagRow.createdAt };
  }
  return { kind: "none" };
}

/** Whether a cancellation of the live booking is undecided or waits for the staff: no second one until it is settled. */
export function cancellationPendingOf(state: CancellationState): boolean {
  return state.kind === "undecided" || state.kind === "requested";
}

// ---- Reads -------------------------------------------------------------------------------------------------------

/** The events of a cancellation's state (CANCELLATION_STATE_EVENTS), newest first, at most 50. */
export async function cancellationEventsOf(
  trx: TenantTransaction,
  bookingId: string,
): Promise<CancellationEventRow[]> {
  return await trx
    .selectFrom("booking_events")
    .select(["type", "actor_type as actorType", "actor_id as actorId", "data", "created_at as createdAt"])
    .where("booking_id", "=", bookingId)
    .where("type", "in", [...CANCELLATION_STATE_EVENTS])
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(50)
    .execute();
}

/** The newest `booking.cancelled` event of the booking, or `undefined`. */
export async function cancelledEventOf(
  trx: TenantTransaction,
  bookingId: string,
): Promise<CancellationEventRow | undefined> {
  return await trx
    .selectFrom("booking_events")
    .select(["type", "actor_type as actorType", "actor_id as actorId", "data", "created_at as createdAt"])
    .where("booking_id", "=", bookingId)
    .where("type", "=", CANCELLATION_EVENTS.cancelled)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
}

/** A payment a cancellation's money step acted on, as the `cancellation` block reads it. */
export interface CancellationPaymentFact {
  /** `payments.status`. */
  readonly status: string;
  /** The payments queue gave up capturing the kept amount and alerted the staff (`payment.capture_failed`, `final`). */
  readonly captureReviewed: boolean;
}

/** What the `cancellation` block of a booking is built from besides its row, its tickets and its refunds. */
export interface CancellationFacts {
  /** The newest `booking.cancelled` event. */
  readonly cancelled: CancellationEventRow | undefined;
  /** The state of a live booking's cancellation. */
  readonly state: CancellationState;
  /** The payments the `booking.cancelled` event names (`voidPaymentId`, `capturePaymentId`), by id. */
  readonly payments: ReadonlyMap<string, CancellationPaymentFact>;
}

/** The ids of the payments a `booking.cancelled` event names. */
function namedPaymentIds(event: CancellationEventRow | undefined): string[] {
  const data = isRecord(event?.data) ? event.data : {};
  return [text(data["voidPaymentId"]), text(data["capturePaymentId"])].filter(
    (id): id is string => id !== undefined,
  );
}

/** The facts of the booking's `cancellation` block (see the file header), read in `trx`. */
export async function cancellationFactsOf(
  trx: TenantTransaction,
  bookingId: string,
): Promise<CancellationFacts> {
  const cancelled = await cancelledEventOf(trx, bookingId);
  const state = cancellationStateOf(await cancellationEventsOf(trx, bookingId));
  const payments = new Map<string, CancellationPaymentFact>();
  for (const id of namedPaymentIds(cancelled)) {
    const row = await trx
      .selectFrom("payments")
      .select("status")
      .where("id", "=", id)
      .where("booking_id", "=", bookingId)
      .executeTakeFirst();
    if (row === undefined) {
      continue;
    }
    const reviewed =
      row.status === "authorized" &&
      (await trx
        .selectFrom("payment_events")
        .select("id")
        .where("payment_id", "=", id)
        .where("type", "=", CAPTURE_FAILED_EVENT)
        .where(sql<string>`payload ->> 'final'`, "=", "true")
        .executeTakeFirst()) !== undefined;
    payments.set(id, { status: row.status, captureReviewed: reviewed });
  }
  return { cancelled, state, payments };
}

/** A live booking whose cancellation flag is still undecided (the reconcile scan's sweep of lost checks). */
export interface UndecidedFlagRow {
  readonly bookingId: string;
  /** The flag's deadline (`data.until`), the `<deadline>` of its check jobs' ids. */
  readonly until: Date;
}

/**
 * The live bookings with an Amadeus order whose newest cancellation event is a flag (`booking.cancellation_timeout`)
 * written at `flaggedBefore` or earlier, of the bookings changed since `changedSince` (the claim of a cancellation bumps
 * the booking before its flag, so a flag of that window has its booking in it), the oldest flag first, at most `limit`.
 * A flag the staff were handed (`booking.cancellation_manual_review`) or that a check decided is not one of them.
 * Read without a lock: the check job claims the booking itself.
 */
export async function undecidedFlags(
  trx: TenantTransaction,
  window: { readonly changedSince: Date; readonly flaggedBefore: Date; readonly limit: number },
): Promise<UndecidedFlagRow[]> {
  const { rows } = await sql<{ bookingId: string; until: string | null }>`
    SELECT b.id AS "bookingId", e.data ->> 'until' AS until
    FROM bookings b
    CROSS JOIN LATERAL (
      SELECT type, data, created_at, id FROM booking_events
      WHERE booking_id = b.id AND type IN (${sql.join([...CANCELLATION_STATE_EVENTS])})
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) e
    WHERE b.status IN ('confirmed', 'ticketed', 'partially_ticketed')
      AND b.amadeus_order_id IS NOT NULL
      AND b.updated_at >= ${window.changedSince}
      AND e.type = ${CANCELLATION_EVENTS.timeout}
      AND e.created_at <= ${window.flaggedBefore}
    ORDER BY e.created_at, b.id
    LIMIT ${window.limit}`.execute(trx);
  return rows.flatMap((row) => {
    const until = row.until === null ? Number.NaN : Date.parse(row.until);
    return Number.isNaN(until) ? [] : [{ bookingId: row.bookingId, until: new Date(until) }];
  });
}
