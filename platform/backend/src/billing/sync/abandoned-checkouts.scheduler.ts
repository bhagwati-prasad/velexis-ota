// `billing.abandoned_checkouts` (PBE-047; platform/docs/architecture.md §5, daily at 03:20 UTC, registered by
// scheduler.registry.ts only while FEATURE_STRIPE_BILLING is on; subscription-billing flow §H, ADR-0013 "Negative",
// scope PF-71 AC2): an OTA created from M5 waits in `provisioning` with an `incomplete` Stripe subscription until the
// `checkout.session.completed` webhook opens its dispatch gate (PBE-044, PBE-045). When the owner never pays, the
// tenant would wait for ever, holding its key. This run ends that wait after 48 hours:
//
// - The candidates are the `provisioning` OTAs whose shown subscription (the current one, else the latest) is a Stripe
//   row `incomplete`, or `incomplete_expired` (Stripe expired a subscription whose first payment never succeeded; the
//   status rules leave a `provisioning` OTA to this run, status-rules.ts), last written at least
//   CHECKOUT_ABANDON_AFTER_MS ago: the row's `updated_at` is its creation, or the start of its latest Checkout
//   (`createCheckoutSession` records the new Session on the row), so an owner who opened a new Checkout gets 48 hours
//   from then. Oldest first, at most ABANDONED_CHECKOUTS_BATCH_SIZE a run (the next run takes the rest).
// - Each OTA in a transaction of its own, which locks the tenant's row first (billing's lock order, subscription-billing
//   flow §D: billing sync and the Checkout's start take it too, so a Checkout completed meanwhile is either seen here or
//   waits for this commit) and checks again that it is still a candidate; an OTA whose provision job is `running` is
//   left alone (something dispatched it, so it is no abandoned Checkout). Then: the row `incomplete → incomplete_expired`
//   (`version + 1`), the `queued` provision job `canceled` with the error `CHECKOUT_ABANDONED: …`, the tenant
//   `provisioning → failed` (`version + 1`), one audit row `tenant.provisioning_failed` (actor `system`, label
//   `billing.abandoned_checkouts`, the subscription, the Checkout Session and the canceled job in `details`), and after
//   the commit a `tenant` invalidation (the status changed, architecture §6.3). No e-mail: the owner sees the failed
//   setup in the portal and retries there.
// - The key stays reserved: the tenant row keeps it in any status (`TenantsRepository.keyExists`, db README §3), so
//   nobody else can take it, and `retryProvisioning` gives the owner a new `incomplete` row and a new Checkout
//   (lifecycle.service.ts). An owner who pays the old Checkout after all is handled by billing sync: the completed
//   Checkout re-dispatches a `failed` OTA as a retry would (lead decision (5) of 2026-10-24, PBE-045).
//
// The run logs `billing.abandoned_checkouts` with its counts (never a name or an e-mail address) and returns them,
// which BullMQ keeps with the job. An OTA whose transaction fails is logged (`billing.abandoned_checkout_failed`) and
// the run goes on with the others, then fails, so BullMQ tries it again with the defaults of ADR-0009; the OTAs done
// before are no candidates any more. The worker provides the handler (BillingSyncModule.forWorker()), and the one
// processor of `platform-maintenance` runs it.
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../../audit/audit.service";
import { Clock } from "../../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../../common/database";
import { MaintenanceJob, type MaintenanceJobHandler } from "../../common/queues/maintenance.processor";
import { InvalidationPublisher, runInTransaction } from "../../common/redis/invalidation.publisher";
import { ProvisioningJobsRepository } from "../../provisioning/provisioning-jobs.repository";
import { TenantsRepository } from "../../tenants/tenants.repository";
import { SubscriptionsRepository, type AbandonedCheckoutRow } from "../subscriptions.repository";

/** The schedule and job name (scheduler.registry.ts). */
export const ABANDONED_CHECKOUTS_JOB = "billing.abandoned_checkouts";

/** The audit rows' `actor_label`. */
export const ABANDONED_CHECKOUTS_ACTOR = "billing.abandoned_checkouts";

/** How long an OTA waits for its Checkout before it fails: 48 hours (ADR-0013, scope PF-71 AC2). */
export const CHECKOUT_ABANDON_AFTER_MS = 48 * 60 * 60 * 1000;

/** The most OTAs one run fails. */
export const ABANDONED_CHECKOUTS_BATCH_SIZE = 500;

/** The code of the canceled job's error and of the audit row. */
export const CHECKOUT_ABANDONED_CODE = "CHECKOUT_ABANDONED";

/** The canceled provision job's `error`. */
export const CHECKOUT_ABANDONED_ERROR = `${CHECKOUT_ABANDONED_CODE}: The Checkout was not completed within 48 hours.`;

/** Why an OTA found by the run was left as it was. */
export type AbandonedCheckoutSkip = "not_a_candidate" | "job_running";

/** What one OTA's transaction did. */
export type AbandonedCheckoutOutcome =
  | { readonly outcome: "failed"; readonly jobIds: readonly string[] }
  | { readonly outcome: "skipped"; readonly reason: AbandonedCheckoutSkip };

/** What a finished run returns (BullMQ keeps it with the job): counts only. */
export interface AbandonedCheckoutsResult {
  /** The OTAs found. */
  readonly found: number;
  /** The OTAs this run set `failed`. */
  readonly tenantsFailed: number;
  /** The OTAs left as they were (no candidate any more, or a running provision job). */
  readonly skipped: number;
}

/** Some OTAs could not be handled: the run fails, and BullMQ tries it again. */
export class AbandonedCheckoutsError extends Error {
  override readonly name = "AbandonedCheckoutsError";

  constructor(failed: number, found: number) {
    super(`${ABANDONED_CHECKOUTS_JOB} could not handle ${failed} of ${found} OTAs`);
  }
}

@Injectable()
@MaintenanceJob(ABANDONED_CHECKOUTS_JOB)
export class AbandonedCheckoutsScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly subscriptions: SubscriptionsRepository,
    private readonly tenants: TenantsRepository,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(AbandonedCheckoutsScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<AbandonedCheckoutsResult> {
    const now = this.clock.now();
    const before = new Date(now.getTime() - CHECKOUT_ABANDON_AFTER_MS);
    const rows = await this.subscriptions.findAbandonedCheckouts(this.db, {
      before,
      limit: ABANDONED_CHECKOUTS_BATCH_SIZE,
    });
    let tenantsFailed = 0;
    let skipped = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        const outcome = await this.abandon(row, before, now);
        if (outcome.outcome === "failed") {
          tenantsFailed += 1;
        } else {
          skipped += 1;
          this.logger.info(
            { tenantId: row.tenant_id, subscriptionId: row.subscription_id, reason: outcome.reason },
            "billing.abandoned_checkout_skipped",
          );
        }
      } catch (error) {
        errors += 1;
        this.logger.error(
          { tenantId: row.tenant_id, subscriptionId: row.subscription_id, err: error },
          "billing.abandoned_checkout_failed",
        );
      }
    }
    const result: AbandonedCheckoutsResult = { found: rows.length, tenantsFailed, skipped };
    this.logger.info(
      { ...result, errors, capped: rows.length === ABANDONED_CHECKOUTS_BATCH_SIZE },
      "billing.abandoned_checkouts",
    );
    if (errors > 0) {
      throw new AbandonedCheckoutsError(errors, rows.length);
    }
    return result;
  }

  /** Fails the OTA of `found` in one transaction, when it is still a candidate (see the file header). */
  private abandon(found: AbandonedCheckoutRow, before: Date, now: Date): Promise<AbandonedCheckoutOutcome> {
    const tenantId = found.tenant_id;
    return runInTransaction(this.db, async (trx): Promise<AbandonedCheckoutOutcome> => {
      const tenant = await this.tenants.lockForUpdate(trx, tenantId);
      if (tenant === undefined || tenant.status !== "provisioning") {
        return { outcome: "skipped", reason: "not_a_candidate" };
      }
      // Again under the tenant's lock: a Checkout completed or started since the list was read changed the row.
      const [row] = await this.subscriptions.findAbandonedCheckouts(trx, { before, limit: 1, tenantId });
      if (row === undefined) {
        return { outcome: "skipped", reason: "not_a_candidate" };
      }
      const job = await this.jobs.latestProvisionJob(tenantId, trx);
      if (job?.status === "running") {
        return { outcome: "skipped", reason: "job_running" };
      }
      const expired = await this.subscriptions.expireIncomplete(trx, row.subscription_id, now);
      const jobIds = await this.jobs.cancelQueuedProvision(trx, {
        tenantId,
        error: CHECKOUT_ABANDONED_ERROR,
        now,
      });
      if (!(await this.tenants.failProvisioning(trx, tenantId, now))) {
        // The row lock is held and the tenant was `provisioning`: this cannot happen, and rolls everything back.
        throw new Error(
          "AbandonedCheckoutsScheduler: the locked provisioning tenant could not be set failed",
        );
      }
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: ABANDONED_CHECKOUTS_ACTOR,
        action: "tenant.provisioning_failed",
        targetType: "tenant",
        targetId: tenantId,
        tenantId,
        tenantKey: tenant.key,
        before: { status: "provisioning" },
        after: { status: "failed" },
        details: {
          code: CHECKOUT_ABANDONED_CODE,
          subscriptionId: row.subscription_id,
          subscriptionStatus: { before: row.status, after: expired ? "incomplete_expired" : row.status },
          checkoutSessionId: row.checkout_session_id,
          waitingSince: row.updated_at.toISOString(),
          canceledJobIds: jobIds,
        },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: tenantId });
      return { outcome: "failed", jobIds };
    });
  }
}
