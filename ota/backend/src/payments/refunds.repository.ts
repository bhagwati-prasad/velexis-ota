// The tenant repository of refunds (OBE-040; OADR-0010 points 3 and 6, ota/docs/flows/change-and-cancel.md §3 steps
// 4–5, db README §2.1): the `refunds` rows that a cancellation (OBE-049) or a member of staff (OBE-068) asks for, and the
// claim with which the `refund.submit` job of the payments queue (payments.processor.ts) sends each one to Stripe once.
// Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a tenant
// schema; amounts are read as text (`numeric::text`) and checked with decimal.js, never as JavaScript numbers.
//
// A refund is asked for with `create` in the caller's transaction, which then queues `refund.submit {tenantId, id}` after
// its commit (`paymentJob` of payments.processor.ts):
//
//   - the payment is locked (`FOR UPDATE`), so two requests for one payment are checked one after the other; the
//     booking the refund row references is locked first (`FOR KEY SHARE`, which that row's foreign key takes anyway),
//     the lock order of a transaction that locks a booking and its payment (OADR-0003 point 11);
//   - only a Stripe payment that is `captured` or `partially_refunded` can be refunded (an airline-card payment is
//     refunded by the airline: `refund_via_airline`);
//   - the amount is a positive decimal with at most the currency's minor units, and at most what is still refundable:
//     the captured amount, less the refunded amount Stripe reported, less the refunds still in flight (`pending` or
//     `processing`), whose amounts are not in the refunded amount yet; a refund in flight that Stripe already counts is
//     subtracted twice for a moment, which can only refuse a refund, never allow one too many;
//   - the row is inserted `pending` with the requester (`requested_by_type`: `customer`, `staff` or `system`, and the
//     `cus_`/`stf_` id), the reason, and a `refund.requested` payment event.
//
// The refund's final state (`succeeded`, `failed`, `canceled`) and the payment's refunded amount come from the Stripe
// webhooks (OBE-039, stripe-events.processor.ts), which find the row by its Stripe id or by the `refund_id` that the
// gateway writes into the refund's metadata.
//
// The claim (OADR-0014 point 6: claims instead of long locks). `refund.submit` moves a `pending` row to `processing` in a
// short transaction and commits before it calls Stripe; the Stripe refund's id is recorded after the call. A `processing`
// row without a Stripe id is a submission in flight: another job leaves it alone, unless the claim is older than
// REFUND_CLAIM_LEASE_MS, which means the job that took it was lost (a stopped worker) and its submission may be sent
// again, with the same idempotency key `refund:<rfd_id>`. A submission whose answer never came releases its claim (the
// row is `pending` again) before its job is retried. Every transaction of the job that writes a payment event or a
// staff alert (the claim, the record of the submission, a refusal) takes `lockParents` before the refund's lock: the
// payment's booking and the payment first, then the refund (lead decision of 2026-10-21, OADR-0003 point 11), as the
// webhook's transaction locks the payment, then its refunds.
//
// The release (FIX-W28-CANCEL, lead decision (1) of 2026-10-23, second batch). A cancellation of a booking whose payment
// is only authorised captures the amount the OTA keeps and Stripe releases the rest of the authorisation; once Stripe
// reports the capture, `recordRelease` records that rest as the customer's refund: a `refunds` row `succeeded` at once
// (no Stripe refund: `provider_refund_id` stays empty, `reason_note` RELEASE_NOTE, the kept amount as
// `penalty_amount`), with a `payment.released` payment event, once per payment. Neither `refund.submit` nor the sweep
// ever sends such a row (it is final), and the webhooks never match it (no Stripe id, no `refund_id` in a Stripe
// refund's metadata); it is what bookings.cancel's `refund` and `refundStatus: succeeded` show.
//
// The sweep (FIX-W27-FOLLOWUPS, lead decision (4) of 2026-10-23). A row whose `refund.submit` enqueue was lost (Redis
// down at the commit, or the after-commit task failed) is still `pending` at NEW_REFUND_VERSION: a claim, and the release
// of a claim, bump the version, so such a row was never sent to Stripe. `unclaimedRefundIds` lists those rows for the
// `refunds.sweep` schedule (refunds-sweep.processor.ts), which queues the producers' own job for each again.
// Since FIX-W28-FOLLOWUPS (lead decision (7) of 2026-10-23, second batch) the sweep also re-sends such a row whose
// `refund.submit` job finished without claiming it (failed for good before its claim, or completed without one):
// `stillUnclaimed` reads those rows again just before the sweep replaces their finished job.
import { Injectable } from "@nestjs/common";
import { sql, type TenantDatabase, type Updateable } from "@velexis/db";
import { newId } from "../common/ids";
import { Money } from "../pricing/pricing.types";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import { AIRLINE_PROVIDER } from "./airline-card/airline-card.gateway";

/** `refunds.reason`. */
export const REFUND_REASONS = [
  "customer_request",
  "booking_cancelled",
  "schedule_change",
  "duplicate",
  "fraud",
  "goodwill",
  "other",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** `refunds.requested_by_type`. */
export const REFUND_REQUESTERS = ["customer", "staff", "system"] as const;
export type RefundRequester = (typeof REFUND_REQUESTERS)[number];

/** The refund statuses whose amount is not final yet: asked for, or sent to Stripe. */
export const IN_FLIGHT_REFUND_STATUSES = ["pending", "processing"] as const;

/** The payment statuses that can be refunded (OBE-068: `captured` or `partially_refunded`). */
export const REFUNDABLE_PAYMENT_STATUSES: readonly string[] = Object.freeze([
  "captured",
  "partially_refunded",
]);

/** How long a claim of `refund.submit` holds a row before another job may send it again (OADR-0014 point 6). */
export const REFUND_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * The `version` of a row `create` inserts. Every change bumps it (a claim, the release of a claim, a record), so a row
 * still `pending` at this version was never claimed by a `refund.submit` job, and never sent to Stripe.
 */
export const NEW_REFUND_VERSION = 1;

/** The `payment_events.source` of a refund request, by requester. */
const EVENT_SOURCE: Readonly<Record<RefundRequester, "api" | "staff" | "system">> = Object.freeze({
  customer: "api",
  staff: "staff",
  system: "system",
});

/** A decimal amount as a request may give it: digits, and at most two decimals (`numeric(12,2)`). */
const DECIMAL = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;

/** A `refunds` row, as the payments queue reads and claims it. */
export interface RefundJobRow {
  readonly id: string;
  readonly paymentId: string;
  readonly bookingId: string | null;
  readonly currency: string;
  readonly amount: string;
  readonly status: string;
  readonly providerRefundId: string | null;
  readonly failureReason: string | null;
  readonly processedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A refund asked for by a cancellation or a member of staff. */
export interface NewRefund {
  /** `rfd_…`, from `IdGenerator`: the key of the idempotency key `refund:<rfd_id>`. */
  readonly id: string;
  readonly paymentId: string;
  /** The amount refunded to the customer, a decimal string in the payment's currency. */
  readonly amount: string;
  readonly reason: RefundReason;
  readonly reasonNote?: string | null | undefined;
  /** Who asked: the customer (`cus_…`), a member of staff (`stf_…`) or the system (no id). */
  readonly requestedBy: { readonly type: RefundRequester; readonly id: string | null };
  /** The booking concerned; the payment's booking when left out. */
  readonly bookingId?: string | null | undefined;
  /** What the airline refunds and the penalty it keeps (Amadeus refund preview), when known. */
  readonly supplierRefundAmount?: string | null | undefined;
  readonly penaltyAmount?: string | null | undefined;
  readonly now: Date;
}

/** Why a refund cannot be asked for. */
export type RefundRefusal =
  | "payment_not_found"
  | "refund_via_airline"
  | "payment_not_refundable"
  | "amount_invalid"
  | "amount_exceeds_captured";

/** What `create` did: the new row, or why there is none (with what can still be refunded, when it is known). */
export type CreateRefundResult =
  | { readonly ok: true; readonly refund: RefundJobRow }
  | { readonly ok: false; readonly reason: RefundRefusal; readonly refundable: string | null };

/** The `refunds.reason_note` of the release of an authorisation (`recordRelease`, see the file header). */
export const RELEASE_NOTE = "authorisation released: the cancellation captured the amount kept";

/** The rest of an authorisation that a cancellation's capture released (`recordRelease`). */
export interface NewRelease {
  /** `rfd_…`, from `IdGenerator`. */
  readonly id: string;
  readonly paymentId: string;
  readonly bookingId: string;
  /** What the customer gets back: the authorisation less the amount captured, a positive decimal string. */
  readonly amount: string;
  /** What the cancellation kept (captured), stored as `penalty_amount` (Refund.penalty: "Airline penalty and OTA fee retained"). */
  readonly kept: string;
  readonly reason: RefundReason;
  readonly requestedBy: { readonly type: RefundRequester; readonly id: string | null };
  /** Who recorded it: the cancellation's request (`api`) or the payments queue's capture retry (`system`). */
  readonly source: "api" | "system";
  readonly now: Date;
}

/** What a `refund.submit` job does with a row it read (see the file header). */
export type RefundSubmission = "submit" | "in_flight" | "done";

/**
 * Whether `refund.submit` sends the row at `now`: `submit` for a `pending` row and for a claim older than `leaseMs`
 * (its job was lost), `in_flight` for a fresher claim, `done` once Stripe's id is recorded or the row is final.
 */
export function refundSubmission(
  row: Pick<RefundJobRow, "status" | "providerRefundId" | "updatedAt">,
  now: Date,
  leaseMs: number = REFUND_CLAIM_LEASE_MS,
): RefundSubmission {
  if (row.providerRefundId !== null) {
    return "done";
  }
  if (row.status === "pending") {
    return "submit";
  }
  if (row.status === "processing") {
    return now.getTime() - row.updatedAt.getTime() >= leaseMs ? "submit" : "in_flight";
  }
  return "done";
}

/**
 * What can still be refunded of a payment: the captured amount, less the refunded amount and the amounts in flight,
 * never below zero. Decimal strings in, a decimal string with two decimals out.
 */
export function refundableAmount(
  payment: { readonly amountCaptured: string; readonly amountRefunded: string },
  inFlight: string,
): string {
  return Money.max(
    new Money(payment.amountCaptured).minus(payment.amountRefunded).minus(inFlight),
    0,
  ).toFixed(2);
}

/** Whether `amount` is a positive decimal with at most `minorUnits` decimals. */
export function isRefundAmount(amount: string, minorUnits: number): boolean {
  if (!DECIMAL.test(amount)) {
    return false;
  }
  const value = new Money(amount);
  return value.greaterThan(0) && value.decimalPlaces() <= minorUnits;
}

const isOptionalAmount = (value: string | null | undefined): boolean =>
  value === null || value === undefined || DECIMAL.test(value);

type Db = TenantDatabase;

@Injectable()
export class RefundsRepository {
  /**
   * Asks for a refund in `trx` (see the file header): locks the booking the row references (`FOR KEY SHARE`), then the
   * payment, checks it and the amount, and inserts the `pending` row with a `refund.requested` payment event. The
   * caller queues `refund.submit` after the commit.
   */
  async create(trx: TenantTransaction, input: NewRefund): Promise<CreateRefundResult> {
    // The booking first, then the payment (OADR-0003 point 11): the refund row's foreign key would take the booking's
    // FOR KEY SHARE after the payment's lock otherwise. A refundable payment's booking is set before its capture.
    const bookingId =
      input.bookingId === undefined
        ? ((
            await trx
              .selectFrom("payments")
              .select("booking_id as bookingId")
              .where("id", "=", input.paymentId)
              .executeTakeFirst()
          )?.bookingId ?? null)
        : input.bookingId;
    if (bookingId !== null) {
      await trx.selectFrom("bookings").select("id").where("id", "=", bookingId).forKeyShare().execute();
    }
    const payment = await trx
      .selectFrom("payments")
      .select([
        "id",
        "provider",
        "status",
        "booking_id as bookingId",
        "provider_payment_id as providerPaymentId",
        sql<string>`currency::text`.as("currency"),
        sql<string>`amount_captured::text`.as("amountCaptured"),
        sql<string>`amount_refunded::text`.as("amountRefunded"),
      ])
      .where("id", "=", input.paymentId)
      .forUpdate()
      .executeTakeFirst();
    if (payment === undefined) {
      return { ok: false, reason: "payment_not_found", refundable: null };
    }
    if (payment.provider === AIRLINE_PROVIDER) {
      return { ok: false, reason: "refund_via_airline", refundable: null };
    }
    if (
      payment.provider !== "stripe" ||
      payment.providerPaymentId === null ||
      !REFUNDABLE_PAYMENT_STATUSES.includes(payment.status)
    ) {
      return { ok: false, reason: "payment_not_refundable", refundable: null };
    }
    const minorUnits = (await this.minorUnits(trx, payment.currency)) ?? 2;
    if (
      !isRefundAmount(input.amount, minorUnits) ||
      !isOptionalAmount(input.supplierRefundAmount) ||
      !isOptionalAmount(input.penaltyAmount)
    ) {
      return { ok: false, reason: "amount_invalid", refundable: null };
    }
    const refundable = refundableAmount(payment, await this.inFlightAmount(trx, payment.id));
    if (new Money(input.amount).greaterThan(refundable)) {
      return { ok: false, reason: "amount_exceeds_captured", refundable };
    }
    const amount = new Money(input.amount).toFixed(2);
    await trx
      .insertInto("refunds")
      .values({
        id: input.id,
        payment_id: payment.id,
        booking_id: bookingId,
        currency: payment.currency,
        amount,
        supplier_refund_amount: input.supplierRefundAmount ?? null,
        penalty_amount: input.penaltyAmount ?? null,
        reason: input.reason,
        reason_note: input.reasonNote ?? null,
        status: "pending",
        requested_by_type: input.requestedBy.type,
        requested_by_id: input.requestedBy.id,
        version: NEW_REFUND_VERSION,
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    await trx
      .insertInto("payment_events")
      .values({
        id: newId("pev", input.now),
        payment_id: payment.id,
        type: "refund.requested",
        source: EVENT_SOURCE[input.requestedBy.type],
        status_to: "pending",
        amount,
        currency: payment.currency,
        payload: JSON.stringify({
          refundId: input.id,
          reason: input.reason,
          requestedByType: input.requestedBy.type,
        }),
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    const created = await this.refund(trx, input.id);
    if (created === undefined) {
      throw new Error("the refund inserted in this transaction is not readable");
    }
    return { ok: true, refund: created };
  }

  /**
   * Takes, in a `refund.submit` transaction and before it locks the refund `id` (`refund(trx, id, true)`), the locks
   * that transaction's writes take on the refund's parents (lead decision of 2026-10-21, OADR-0003 point 11: the
   * checkout, the booking, the payment, then the refund, a foreign-key lock counting as a lock of the parent): the
   * payment's booking `FOR KEY SHARE` (a staff alert's outbox row references it), then the payment `FOR KEY SHARE` (its
   * payment events reference it). A refundable payment's booking is set before its capture and does not change after
   * it. Before FIX-W25-BOOKINGS the job locked the refund first and took the payment's lock with its event's insert, the
   * reverse of the webhook's order (the payment, then its refunds). Nothing for an unknown id.
   */
  async lockParents(trx: TenantTransaction, id: string): Promise<void> {
    const parents = await trx
      .selectFrom("refunds as r")
      .innerJoin("payments as p", "p.id", "r.payment_id")
      .select(["p.id as paymentId", "p.booking_id as bookingId"])
      .where("r.id", "=", id)
      .executeTakeFirst();
    if (parents === undefined) {
      return;
    }
    if (parents.bookingId !== null) {
      await trx
        .selectFrom("bookings")
        .select("id")
        .where("id", "=", parents.bookingId)
        .forKeyShare()
        .execute();
    }
    await trx.selectFrom("payments").select("id").where("id", "=", parents.paymentId).forKeyShare().execute();
  }

  /** The refund `id`, locked `FOR UPDATE` when `lock`; `undefined` for an unknown id. */
  async refund(trx: TenantTransaction, id: string, lock = false): Promise<RefundJobRow | undefined> {
    let query = trx
      .selectFrom("refunds")
      .select([
        "id",
        "payment_id as paymentId",
        "booking_id as bookingId",
        "status",
        "provider_refund_id as providerRefundId",
        "failure_reason as failureReason",
        "processed_at as processedAt",
        "version",
        "created_at as createdAt",
        "updated_at as updatedAt",
        sql<string>`currency::text`.as("currency"),
        sql<string>`amount::text`.as("amount"),
      ])
      .where("id", "=", id);
    if (lock) {
      query = query.forUpdate();
    }
    return await query.executeTakeFirst();
  }

  /**
   * Which of the refunds `ids` are still unclaimed: `pending` at NEW_REFUND_VERSION without a Stripe id, as
   * `unclaimedRefundIds` found them, read again without a lock (every producer queues the row's one job id, and the
   * sweep asks only about rows whose job BullMQ has finished, so no job of theirs can claim them meanwhile). The sweep's
   * check before it removes a finished `refund.submit` job and queues it again (refunds-sweep.processor.ts).
   */
  async stillUnclaimed(trx: TenantTransaction, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await trx
      .selectFrom("refunds")
      .select("id")
      .where("id", "in", [...ids])
      .where("status", "=", "pending")
      .where("version", "=", NEW_REFUND_VERSION)
      .where("provider_refund_id", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * The refunds no `refund.submit` job has claimed that were asked for at `requestedBefore` or earlier: `pending` at
   * NEW_REFUND_VERSION without a Stripe id, the oldest first, at most `limit` ids after the first `offset` (the sweep's
   * continuations). Read without a lock: the job that is queued for each claims the row itself (`refunds.sweep`,
   * refunds-sweep.processor.ts).
   */
  async unclaimedRefundIds(
    trx: TenantTransaction,
    requestedBefore: Date,
    limit: number,
    offset = 0,
  ): Promise<string[]> {
    const rows = await trx
      .selectFrom("refunds")
      .select("id")
      .where("status", "=", "pending")
      .where("version", "=", NEW_REFUND_VERSION)
      .where("provider_refund_id", "is", null)
      .where("created_at", "<=", requestedBefore)
      .orderBy("created_at")
      .orderBy("id")
      .limit(limit)
      .offset(offset)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Records the release of an authorisation (see the file header) in `trx`, whose caller locked the booking and then the
   * payment (OADR-0003 point 11: the refund comes last): the `succeeded` row and its `payment.released` payment event,
   * unless the payment has its release already. Answers the new row, or `undefined` when there was one (or nothing to
   * release).
   */
  async recordRelease(trx: TenantTransaction, input: NewRelease): Promise<RefundJobRow | undefined> {
    const amount = new Money(input.amount);
    if (!amount.greaterThan(0)) {
      return undefined;
    }
    const existing = await trx
      .selectFrom("refunds")
      .select("id")
      .where("payment_id", "=", input.paymentId)
      .where("reason_note", "=", RELEASE_NOTE)
      .executeTakeFirst();
    if (existing !== undefined) {
      return undefined;
    }
    const payment = await trx
      .selectFrom("payments")
      .select(sql<string>`currency::text`.as("currency"))
      .where("id", "=", input.paymentId)
      .executeTakeFirstOrThrow();
    const released = amount.toFixed(2);
    await trx
      .insertInto("refunds")
      .values({
        id: input.id,
        payment_id: input.paymentId,
        booking_id: input.bookingId,
        currency: payment.currency,
        amount: released,
        penalty_amount: new Money(input.kept).toFixed(2),
        reason: input.reason,
        reason_note: RELEASE_NOTE,
        status: "succeeded",
        requested_by_type: input.requestedBy.type,
        requested_by_id: input.requestedBy.id,
        processed_at: input.now,
        version: NEW_REFUND_VERSION,
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    await trx
      .insertInto("payment_events")
      .values({
        id: newId("pev", input.now),
        payment_id: input.paymentId,
        type: "payment.released",
        source: input.source,
        status_to: "succeeded",
        amount: released,
        currency: payment.currency,
        payload: JSON.stringify({ refundId: input.id, bookingId: input.bookingId, kept: input.kept }),
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    return await this.refund(trx, input.id);
  }

  /** The sum of the payment's refunds in flight (`pending`, `processing`), a decimal string. */
  async inFlightAmount(trx: TenantTransaction, paymentId: string): Promise<string> {
    const row = await trx
      .selectFrom("refunds")
      .select(sql<string>`coalesce(sum(amount), 0)::text`.as("total"))
      .where("payment_id", "=", paymentId)
      .where("status", "in", [...IN_FLIGHT_REFUND_STATUSES])
      .executeTakeFirstOrThrow();
    return row.total;
  }

  /**
   * Claims the refund for a submission: `processing`, `updated_at = now`, if its `version` is still `expectedVersion`
   * and Stripe's id is not recorded. Answers the claim's version, or `undefined` when the row changed meanwhile.
   */
  async claim(
    trx: TenantTransaction,
    id: string,
    expectedVersion: number,
    now: Date,
  ): Promise<number | undefined> {
    const claimed = await this.change(trx, id, expectedVersion, { status: "processing", updated_at: now });
    return claimed ? expectedVersion + 1 : undefined;
  }

  /**
   * Releases a claim whose submission got no answer (`pending` again), if the row is still that claim; answers whether
   * it did. A row the webhook moved on (Stripe's id recorded) keeps its state.
   */
  async release(trx: TenantTransaction, id: string, claimVersion: number, now: Date): Promise<boolean> {
    return await this.change(trx, id, claimVersion, { status: "pending", updated_at: now });
  }

  /**
   * Records the Stripe refund of a submission: its id, the row `processing` (its final state comes from the webhook),
   * unless the webhook recorded it first. Answers whether it did.
   */
  async recordSubmission(
    trx: TenantTransaction,
    id: string,
    providerRefundId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await trx
      .updateTable("refunds")
      .set({
        provider_refund_id: providerRefundId,
        status: sql<string>`case when status = 'pending' then 'processing' else status end`,
        updated_at: now,
        version: sql`version + 1`,
      })
      .where("id", "=", id)
      .where("provider_refund_id", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * A submission Stripe refused: the row `failed` with the reason (a code, never a message) and `processed_at`, if it
   * is still that claim. Answers whether it did.
   */
  async markFailed(
    trx: TenantTransaction,
    id: string,
    claimVersion: number,
    failureReason: string,
    now: Date,
  ): Promise<boolean> {
    return await this.change(trx, id, claimVersion, {
      status: "failed",
      failure_reason: failureReason,
      processed_at: now,
      updated_at: now,
    });
  }

  /** `reference.currencies.minor_units` of `code`, or `null` for an unknown currency. */
  private async minorUnits(trx: TenantTransaction, code: string): Promise<number | null> {
    const row = await trx
      .selectFrom("reference.currencies")
      .select("minor_units")
      .where("code", "=", code)
      .executeTakeFirst();
    return row?.minor_units ?? null;
  }

  /** Changes a refund without Stripe's id whose `version` is still `expectedVersion`, and bumps it. */
  private async change(
    trx: TenantTransaction,
    id: string,
    expectedVersion: number,
    values: Omit<Updateable<Db["refunds"]>, "version" | "id">,
  ): Promise<boolean> {
    const result = await trx
      .updateTable("refunds")
      .set({ ...values, version: sql`version + 1` })
      .where("id", "=", id)
      .where("version", "=", expectedVersion)
      .where("provider_refund_id", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
