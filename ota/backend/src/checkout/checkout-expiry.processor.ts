// `checkouts.expire` (OBE-056; ota/docs/architecture.md §6, OADR-0014 points 2, 4 and 5, OADR-0003 point 10, db README
// §6): every minute, per tenant (`active` and `suspended`: a suspended OTA's checkouts expire and their authorisations
// are released all the same, OADR-0014 point 4; jobs/schedulers.ts fans it out), one job expires the checkouts that
// can no longer be finished and asks the payments queue to release what they hold.
//
// The expiry, in one tenant transaction (`expireDueCheckouts`):
//
//   1. at most JOB_BATCH_LIMITS.checkoutExpiry (50) `open` or `payment_pending` checkouts past `expires_at`, the oldest
//      first (`checkouts_expiry_idx`), are locked `FOR UPDATE SKIP LOCKED`: the lock the claim of checkout.complete and
//      every step that changes a checkout take, so a checkout a request holds is left to the next run instead of
//      making the job wait (or deadlock with the account deletion, which locks a customer's checkouts in id order). A
//      checkout held by a booking is left out of the selection, so it never uses up the batch: `pending`, the order is
//      being created or may exist after a `504 SUPPLIER_TIMEOUT` (OADR-0003 points 9 and 10), its status and its
//      authorisation stay for the reconciliation (OBE-043), the only one that voids or captures it; any other booking
//      holding it would mean the checkout is completed (`CheckoutService.refuseWhileCompleting` refuses both). Once the
//      reconciliation decided (a `failed` booking clears its `checkout_id`), the checkout past `expires_at` is expired
//      like any other.
//   2. the bookings of the locked checkouts are read again in a statement of their own, as `refuseWhileCompleting`
//      does under the lock: the selection's `NOT EXISTS` saw the bookings of its snapshot, so a claim that committed
//      after the snapshot and before the row lock (the claim locks the checkout and inserts the booking, it never
//      updates the checkout row) is seen here, and its checkout is left as it is. A claim that comes after the lock
//      waits for this transaction, reads the checkout again, finds it changed (`expired`, a new `version`) and claims
//      nothing; its next attempt answers `410 CHECKOUT_EXPIRED` (the checkout is past `expires_at` in any case).
//   3. the others become `expired` (`version` + 1, `updated_at` = the job's now, which marks when they expired).
//
// The voids, after the commit (conventions §2: jobs are queued after the commit): `payment.void {tenantId, id}` on
// `ota-payments` with the producers' job id `payment-void-<pay_id>` (`paymentJob`) for the Stripe payments of expired
// checkouts whose PaymentIntent may still hold or take the traveller's money (`VOIDABLE_STATUSES`: not confirmed yet,
// so a confirmation in the browser after the expiry cannot authorise money nobody releases, or `authorized`) and that
// pay for no order (no booking, or a `failed` one): the payments the account deletion voids for the checkouts it
// abandons (account.repository.ts). An airline-card payment, or one that never reached Stripe, has nothing to void.
// They are read from the database, not carried over from step 3: every job queues the voids of the checkouts expired
// in the last VOID_LOOKBACK_MS, newest expiry first (those it just expired lead), at most EXPIRY_VOID_BATCH. BullMQ
// holds one job per payment under that id (a finished one for a day at least, ADR-0009), so each void runs once
// however often it is asked for, and a void whose add was lost (Redis failed the add, which fails this job and BullMQ
// runs it again; the process stopped after the commit) is queued by the next job. The void job reads the payment
// again and voids only what is still voidable and pays for no standing order (payments.processor.ts); a void that
// fails for good alerts the staff there, and the daily authorisation watch still sees the payment.
//
// A full batch asks for more (the runner re-enqueues the job, fan-out.ts). The job logs `checkouts.expired` with the
// counts, never an id of a checkout, customer or payment.
//
// The suspension's expiry (`tenant.suspend`, OBE-074, provisioning/housekeeping.service.ts; OADR-0007 point 8) uses
// the same rule: the same selection of checkouts (`open` or `payment_pending`, held by no booking, checked again after
// the lock by `expireLockedCheckouts`) and the same voidable payments, only without the `expires_at` cut-off, in id
// order and waiting for the row locks (`lockOpenCheckouts`), and with the voids of exactly the checkouts it expired
// (`voidablePaymentsOfCheckouts`).
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { TenantJob, type TenantJobHandler, type TenantJobOutcome } from "../jobs/fan-out";
import { JOB_BATCH_LIMITS } from "../jobs/limits";
import { PAYMENT_JOB, paymentJob, VOIDABLE_STATUSES } from "../payments/payments.processor";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";

/** The schedule and job name (jobs/schedulers.ts). */
export const CHECKOUTS_EXPIRE_JOB = "checkouts.expire";

/** The checkout states that expire once past `expires_at` (`checkouts_expiry_idx`). */
export const EXPIRING_CHECKOUT_STATUSES: readonly string[] = Object.freeze(["open", "payment_pending"]);

/**
 * How long after its checkout expired a voidable payment is still given its `payment.void`: a day, no longer than
 * BullMQ keeps the finished void job whose id makes a later add a no-op (ADR-0009), so a void runs once. A payment
 * still voidable after that (a void that failed for good) is the staff's, alerted by the void job and the watch.
 */
export const VOID_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * The `payment.void` jobs one run asks for at most: room for every payment of a full batch of checkouts (one live
 * payment each, sometimes an earlier one whose release is still due), the rest by the next job.
 */
export const EXPIRY_VOID_BATCH = 2 * JOB_BATCH_LIMITS.checkoutExpiry;

/** What one expiry transaction did with the checkouts it locked. */
export interface CheckoutExpiryBatch {
  /** The checkouts the selection locked: a full batch asks for more. */
  readonly locked: number;
  /** The checkouts that became `expired`, in id order. */
  readonly expired: readonly string[];
  /** Locked, but held by a booking by the time of the lock (a claim committed meanwhile): left as they were. */
  readonly held: readonly string[];
}

/**
 * The checkouts an expiry may take (this job's and the suspension's of OBE-074, OADR-0007 point 8): `open` or
 * `payment_pending`, held by no booking in the statement's snapshot. Steps 2 and 3 (`expireLockedCheckouts`) check
 * the bookings again once the rows are locked.
 */
function expiringCheckouts(trx: TenantTransaction) {
  return trx
    .selectFrom("checkouts as c")
    .select("c.id")
    .where("c.status", "in", [...EXPIRING_CHECKOUT_STATUSES])
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("bookings as b")
            .select(sql<number>`1`.as("held"))
            .whereRef("b.checkout_id", "=", "c.id"),
        ),
      ),
    );
}

/**
 * Step 1: locks at most `limit` checkouts that are `open` or `payment_pending` past their `expires_at` at `now` and
 * that no booking holds (in the statement's snapshot), oldest expiry first, `FOR UPDATE SKIP LOCKED`; answers their
 * ids in that order.
 */
export async function lockDueCheckouts(trx: TenantTransaction, now: Date, limit: number): Promise<string[]> {
  const rows = await expiringCheckouts(trx)
    .where("c.expires_at", "<=", now)
    .orderBy("c.expires_at")
    .orderBy("c.id")
    .limit(limit)
    .forUpdate("c")
    .skipLocked()
    .execute();
  return rows.map((row) => row.id);
}

/**
 * Step 1 of the suspension's expiry (`tenant.suspend`, OBE-074; OADR-0007 point 8,
 * provisioning/housekeeping.service.ts): locks at most `limit` checkouts that are `open` or `payment_pending` and that
 * no booking holds (in the statement's snapshot), whatever their `expires_at`, in id order after `after` (the last id
 * of the previous batch), and answers their ids in that order. It locks `FOR UPDATE` and waits for a lock a request
 * holds (a checkout step, or the claim of checkout.complete, both short transactions that commit before any Amadeus or
 * Stripe call), so a suspension leaves no checkout behind; the tenant transaction's statement_timeout bounds the wait.
 * The rows are locked in id order, as the account deletion locks a customer's checkouts, so the two never deadlock.
 * Steps 2 and 3 are this job's (`expireLockedCheckouts`): a claim that committed while the statement waited for its
 * lock leaves its checkout as it was.
 */
export async function lockOpenCheckouts(
  trx: TenantTransaction,
  after: string | undefined,
  limit: number,
): Promise<string[]> {
  let selection = expiringCheckouts(trx);
  if (after !== undefined) {
    selection = selection.where("c.id", ">", after);
  }
  const rows = await selection.orderBy("c.id").limit(limit).forUpdate("c").execute();
  return rows.map((row) => row.id);
}

/**
 * Steps 2 and 3, in the transaction that locked `checkoutIds` (`lockDueCheckouts`): reads their bookings again in a
 * statement of its own and leaves a checkout a booking holds as it is; the others become `expired` at `now`.
 */
export async function expireLockedCheckouts(
  trx: TenantTransaction,
  checkoutIds: readonly string[],
  now: Date,
): Promise<Omit<CheckoutExpiryBatch, "locked">> {
  if (checkoutIds.length === 0) {
    return { expired: [], held: [] };
  }
  const holders = await trx
    .selectFrom("bookings")
    .select("checkout_id as checkoutId")
    .where("checkout_id", "in", [...checkoutIds])
    .execute();
  const heldIds = new Set(holders.map((row) => row.checkoutId));
  const due = checkoutIds.filter((id) => !heldIds.has(id));
  const expired =
    due.length === 0
      ? []
      : await trx
          .updateTable("checkouts")
          .set({ status: "expired", version: sql<number>`version + 1`, updated_at: now })
          .where("id", "in", due)
          .where("status", "in", [...EXPIRING_CHECKOUT_STATUSES])
          .returning("id")
          .execute();
  return {
    expired: expired.map((row) => row.id).sort(),
    held: checkoutIds.filter((id) => heldIds.has(id)).sort(),
  };
}

/** Steps 1 to 3 in the caller's transaction (see the file header). */
export async function expireDueCheckouts(
  trx: TenantTransaction,
  now: Date,
  limit: number,
): Promise<CheckoutExpiryBatch> {
  const locked = await lockDueCheckouts(trx, now, limit);
  return { locked: locked.length, ...(await expireLockedCheckouts(trx, locked, now)) };
}

/**
 * The Stripe payments an expiry voids (this job's and the suspension's): of `expired` checkouts, with a PaymentIntent
 * in a voidable status, paying for no order (no booking, or a `failed` one). Read without a lock: the void job reads
 * the payment again.
 */
function voidablePayments(trx: TenantTransaction) {
  return (
    trx
      .selectFrom("payments as p")
      .innerJoin("checkouts as c", "c.id", "p.checkout_id")
      .select("p.id")
      // Both environments, by name: the leading column of `payments_status_idx` (environment, status, created_at).
      .where("p.environment", "in", ["test", "live"])
      .where("p.status", "in", [...VOIDABLE_STATUSES])
      .where("p.provider", "=", "stripe")
      .where("p.provider_payment_id", "is not", null)
      .where("c.status", "=", "expired")
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("bookings as b")
              .select(sql<number>`1`.as("booked"))
              .whereRef("b.id", "=", "p.booking_id")
              .where("b.status", "<>", "failed"),
          ),
        ),
      )
  );
}

/**
 * The Stripe payments to void (see the file header): of checkouts that expired at `expiredSince` or later, with a
 * PaymentIntent in a voidable status, paying for no order (no booking, or a `failed` one); newest expiry first, then
 * by id, at most `limit`. Read without a lock: the void job reads the payment again.
 */
export async function voidablePaymentsOfExpiredCheckouts(
  trx: TenantTransaction,
  expiredSince: Date,
  limit: number,
): Promise<string[]> {
  const rows = await voidablePayments(trx)
    .where("c.updated_at", ">=", expiredSince)
    .orderBy("c.updated_at", "desc")
    .orderBy("p.id")
    .limit(limit)
    .execute();
  return rows.map((row) => row.id);
}

/**
 * The Stripe payments to void of the checkouts `checkoutIds` that an expiry has just made `expired` (the suspension's,
 * OBE-074), by the rule of `voidablePaymentsOfExpiredCheckouts`, in id order: all of them, since a checkout has one
 * live payment and at most a few earlier ones whose release is still due.
 */
export async function voidablePaymentsOfCheckouts(
  trx: TenantTransaction,
  checkoutIds: readonly string[],
): Promise<string[]> {
  if (checkoutIds.length === 0) {
    return [];
  }
  const rows = await voidablePayments(trx)
    .where("c.id", "in", [...checkoutIds])
    .orderBy("p.id")
    .execute();
  return rows.map((row) => row.id);
}

/** What one run did: checkouts expired, checkouts left to a booking that claimed them meanwhile, voids asked for. */
export interface CheckoutExpiryCounts extends Readonly<Record<string, number>> {
  readonly expired: number;
  readonly held: number;
  readonly voids: number;
}

/** `checkouts.expire` for one tenant (every minute, fanned out by jobs/fan-out.ts; see the file header). */
@Injectable()
@TenantJob(CHECKOUTS_EXPIRE_JOB)
export class CheckoutExpiryProcessor implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.payments) private readonly payments: Queue,
    @InjectPinoLogger(CheckoutExpiryProcessor.name) private readonly logger: PinoLogger,
  ) {}

  /** One batch for the job's tenant (the runner opened its context), then the voids; a full batch asks for more. */
  async run(tenant: PlatformTenant): Promise<TenantJobOutcome> {
    const now = this.clock.now();
    const limit = JOB_BATCH_LIMITS.checkoutExpiry;
    const batch = await this.tx.run((trx) => expireDueCheckouts(trx, now, limit));
    const voids = await this.tx.run((trx) =>
      voidablePaymentsOfExpiredCheckouts(trx, new Date(now.getTime() - VOID_LOOKBACK_MS), EXPIRY_VOID_BATCH),
    );
    if (voids.length > 0) {
      // The producers' job and job id: BullMQ adds nothing for a payment whose void it holds already.
      await this.payments.addBulk(voids.map((id) => paymentJob(PAYMENT_JOB.void, tenant.id, id)));
    }
    const counts: CheckoutExpiryCounts = {
      expired: batch.expired.length,
      held: batch.held.length,
      voids: voids.length,
    };
    if (batch.expired.length > 0 || batch.held.length > 0) {
      this.logger.info({ tenantId: tenant.id, ...counts }, "checkouts.expired");
    }
    return { more: batch.locked >= limit, counts };
  }
}
