// `payments.authorisation_watch` (OBE-040; OADR-0008 point 6, ota/docs/architecture.md §6): every day at 06:15 UTC, per
// tenant (`active` and `suspended`: the authorisations of a suspended OTA's bookings lapse all the same, OADR-0014
// point 4; jobs/schedulers.ts fans it out), one job alerts the OTA's staff about its authorised, uncaptured Stripe
// payments whose authorisation is older than 5 days. Stripe releases an uncaptured authorisation after about 7 days, so
// a `manual_review` booking (OADR-0008 point 1) must be issued, which captures it, or the payment voided before then.
//
// Each payment is alerted once: the job writes a `payment.authorisation_expiring` payment event with the outbox alert
// (`staff.manual_review` to `ops_alert_email`, else the owners, else OPS_ALERT_EMAIL; dedupe key
// `staff.authorisation_watch:<pay_id>`), in one transaction, and the next runs leave out payments that have the event.
// The batch (at most AUTHORISATION_WATCH_BATCH payments, oldest authorisation first) is locked with `FOR UPDATE SKIP
// LOCKED`, so two jobs of one tenant at once (a continuation and a new run) alert different payments; a full batch of
// candidates that alerted at least one payment asks the runner for more (a candidate another job holds is skipped, and
// the next run finds it).
// The alert's outbox row references the payment's booking, so the bookings are locked (`FOR KEY SHARE`) before the
// payments: the lock order of a transaction that locks a booking and its payment (OADR-0003 point 11).
// The time comes from `Clock`. The job logs counts only.
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { TenantJob, type TenantJobHandler, type TenantJobOutcome } from "../jobs/fan-out";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { PaymentAlerts } from "./payments.processor";
import { PaymentsRepository } from "./payments.repository";

/** The schedule and job name (jobs/schedulers.ts). */
export const AUTHORISATION_WATCH_JOB = "payments.authorisation_watch";

const DAY_MS = 24 * 60 * 60_000;

/** An authorisation older than this is alerted (OADR-0008 point 6). */
export const AUTHORISATION_WATCH_AGE_MS = 5 * DAY_MS;

/** About when Stripe releases an uncaptured authorisation of a card payment. */
export const AUTHORISATION_LIFETIME_MS = 7 * DAY_MS;

/** The payments one job alerts at most. */
export const AUTHORISATION_WATCH_BATCH = 100;

/** The payment event that records the alert, and keeps the payment out of the next runs. */
export const AUTHORISATION_EXPIRING_EVENT = "payment.authorisation_expiring";

/** An authorised, uncaptured Stripe payment the watch alerts about. */
export interface DueAuthorisation {
  readonly id: string;
  readonly environment: string;
  readonly bookingId: string | null;
  readonly currency: string;
  readonly amountAuthorized: string;
  /** `authorized_at`, or `created_at` for a row without it. */
  readonly authorizedAt: Date;
}

/** What `dueAuthorisations` found. */
export interface DueAuthorisations {
  /** The payments locked for the alerts. */
  readonly payments: DueAuthorisation[];
  /** The candidates filled the batch (`limit`): more payments may be due after them. */
  readonly full: boolean;
}

/**
 * At most `limit` authorised, uncaptured Stripe payments of the transaction's tenant authorised at `cutoff` or before
 * and not alerted yet, oldest first, locked `FOR UPDATE SKIP LOCKED`. Their bookings are locked first (`FOR KEY
 * SHARE`, `lockBookings`; see the file header): the candidates are read without a lock, their bookings locked, then
 * the payments locked and checked again; a payment another job holds is skipped.
 */
export async function dueAuthorisations(
  trx: TenantTransaction,
  payments: Pick<PaymentsRepository, "lockBookings">,
  cutoff: Date,
  limit: number,
): Promise<DueAuthorisations> {
  const authorizedAt = sql<Date>`coalesce(p.authorized_at, p.created_at)`;
  const due = () =>
    trx
      .selectFrom("payments as p")
      .where("p.provider", "=", "stripe")
      .where("p.status", "=", "authorized")
      .where(sql<boolean>`p.amount_captured = 0`)
      .where(sql<boolean>`${authorizedAt} <= ${cutoff}`)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("payment_events as e")
              .select(sql<number>`1`.as("alerted"))
              .whereRef("e.payment_id", "=", "p.id")
              .where("e.type", "=", AUTHORISATION_EXPIRING_EVENT),
          ),
        ),
      )
      .orderBy(authorizedAt)
      .orderBy("p.id");
  const candidates = await due().select(["p.id as id", "p.booking_id as bookingId"]).limit(limit).execute();
  if (candidates.length === 0) {
    return { payments: [], full: false };
  }
  await payments.lockBookings(
    trx,
    candidates.flatMap((candidate) => (candidate.bookingId === null ? [] : [candidate.bookingId])),
    "key share",
  );
  const locked = await due()
    .select([
      "p.id as id",
      "p.environment as environment",
      "p.booking_id as bookingId",
      sql<string>`p.currency::text`.as("currency"),
      sql<string>`p.amount_authorized::text`.as("amountAuthorized"),
      authorizedAt.as("authorizedAt"),
    ])
    .where(
      "p.id",
      "in",
      candidates.map((candidate) => candidate.id),
    )
    .forUpdate("p")
    .skipLocked()
    .execute();
  return { payments: locked, full: candidates.length >= limit };
}

/** The reason of a payment's alert: its ids, amount and dates, and what staff should do. */
export function authorisationAlertReason(payment: DueAuthorisation): string {
  const lapses = new Date(payment.authorizedAt.getTime() + AUTHORISATION_LIFETIME_MS);
  return (
    `The card payment ${payment.id} (${payment.amountAuthorized} ${payment.currency}, ${payment.environment}) was ` +
    `authorised at ${payment.authorizedAt.toISOString()} and is still not captured. Stripe releases an uncaptured ` +
    `authorisation after about 7 days (around ${lapses.toISOString()}): issue the booking, which captures the payment, ` +
    "or void the payment before then."
  );
}

/** What one run did: the payments found and the alerts queued. */
export interface AuthorisationWatchCounts extends Readonly<Record<string, number>> {
  readonly payments: number;
  readonly alerts: number;
}

@Injectable()
@TenantJob(AUTHORISATION_WATCH_JOB)
export class AuthorisationWatchProcessor implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly payments: PaymentsRepository,
    private readonly alerts: PaymentAlerts,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    @InjectPinoLogger(AuthorisationWatchProcessor.name) private readonly logger: PinoLogger,
  ) {}

  /** One batch for the job's tenant (the runner opened its context); a full batch asks for more. */
  async run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - AUTHORISATION_WATCH_AGE_MS);
    const { counts, full } = await this.tx.run(async (trx) => {
      const due = await dueAuthorisations(trx, this.payments, cutoff, AUTHORISATION_WATCH_BATCH);
      let alerts = 0;
      for (const payment of due.payments) {
        await this.payments.insertEvent(trx, {
          id: this.ids.newId("pev"),
          payment_id: payment.id,
          type: AUTHORISATION_EXPIRING_EVENT,
          source: "system",
          amount: payment.amountAuthorized,
          currency: payment.currency,
          payload: JSON.stringify({
            authorizedAt: payment.authorizedAt.toISOString(),
            jobId: job.id ?? job.name,
          }),
          created_at: now,
          updated_at: now,
        });
        const queued = await this.alerts.send(trx, payment, {
          dedupeKey: `staff.authorisation_watch:${payment.id}`,
          reason: authorisationAlertReason(payment),
        });
        alerts += queued ? 1 : 0;
      }
      const found: AuthorisationWatchCounts = { payments: due.payments.length, alerts };
      return { counts: found, full: due.full };
    });
    if (counts.payments > 0) {
      this.logger.info({ tenantId: tenant.id, ...counts }, "payments.authorisations_expiring");
    }
    // A full batch asks for more, unless every candidate was held by another job (it alerts them, and a continuation
    // would only find them again).
    return { more: full && counts.payments > 0, counts };
  }
}
