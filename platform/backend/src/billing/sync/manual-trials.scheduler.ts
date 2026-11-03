// `billing.manual_trials` (PBE-047; platform/docs/architecture.md §5, daily at 08:10 UTC, registered by
// scheduler.registry.ts only while FEATURE_STRIPE_BILLING is on; subscription-billing flow §G, PADR-0002 item 9,
// ADR-0013 point 4, scope PF-75 AC1): the OTAs created before M5 run on a manual trial (`billing_provider = 'manual'`,
// `trialing`, `trial_ends_at` set, changeable by admins). From M5 their owners are asked to choose a plan through
// Checkout (subscription-billing flow §B), and an OTA that does not is suspended for `billing` 14 days after the end.
//
// The days are UTC calendar days of the Clock's now and of `trial_ends_at` (`utcDay`), so the run's time of day never
// moves a step, and a run that comes late (the worker was down, BullMQ retried) does the step that is due then. For each
// manual trial (`manualTrialStep`, pure):
//
// | The row, and today against the trial's end day      | What the run does                                          |
// |-----------------------------------------------------|------------------------------------------------------------|
// | `trialing`, 14 to 4 days before the end              | `billing.trial_ending` to every active owner (the 14-day notice), `billing_notice = 'trial_ending'` |
// | `trialing`, 3 to 1 days before the end               | `billing.trial_ending` (the 3-day notice), the banner      |
// | `trialing`, on or after the end day                  | the row `past_due` (`version + 1`), the banner             |
// | `past_due`, 14 days after the end and 14 days after it became `past_due` | the row `canceled` (`canceled_at`), the OTA suspended with reason `billing` |
// | `trialing`, more than 14 days before the end         | the trial banner cleared (an admin moved the end later)    |
// | `active` (an admin set it: paid outside Stripe)      | the trial banner cleared                                   |
//
// Each notice goes out once per owner, trial end and notice (the outbox's idempotency key `trial_ending:<sub>:<end
// day>:<14|3>`), so a second run on the same day, or the next days of the window, queue nothing new; a trial whose end
// an admin moved gets the notices of its new end. A notice the run missed (the trial began less than 4 days before its
// end, or the run came late) is not sent afterwards: only the notice of the window the day is in. The suspension also
// waits until the row has been `past_due` for 14 days (its `updated_at`, set when the run moved it): a trial that ended
// before the switch went on (or before an admin moved its end into the past) shows the banner for 14 days before its OTA
// is suspended, never on the first run. The row's step after `past_due` is the suspension's: SuspensionService (PADR-0014)
// suspends an `active` OTA only, writes its `suspend` job, the `tenant.suspended` audit row, the owners' e-mail and the
// invalidation in this transaction, and its job is dispatched after the commit. Choosing a plan at any time goes through
// Checkout, which replaces the manual row (and resumes a `billing` suspension, PBE-045).
//
// Only the trials of `active` OTAs are moved: one that is suspended (for abuse, a request or an admin) waits, and the
// first run after its resume does the step that is due. Each trial in a transaction of its own, which locks the
// tenant's row first, then the subscription's (billing's lock order, subscription-billing flow §D; a completed Checkout
// and the admin's manual edit lock in the same order), and reads both again before it writes. A change writes one
// `subscription.updated` audit row (actor `system`, label `billing.manual_trials`; the status and the banner before and
// after, the trial's end and the notice) and a changed banner publishes `tenant` after the commit, so the portal and the
// OTA admin show it. The e-mails queue in the same transaction and go out after its commit.
//
// The run logs `billing.manual_trials` with its counts (never a name or an e-mail address) and returns them, which
// BullMQ keeps with the job. A trial whose transaction fails is logged (`billing.manual_trial_failed`) and the run goes
// on with the others, then fails, so BullMQ tries it again with the defaults of ADR-0009; the steps done before are not
// done twice. The worker provides the handler (BillingSyncModule.forWorker()), and the one processor of
// `platform-maintenance` runs it.
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../../audit/audit.repository";
import { AuditService } from "../../audit/audit.service";
import { Clock } from "../../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../../common/database";
import { MaintenanceJob, type MaintenanceJobHandler } from "../../common/queues/maintenance.processor";
import {
  afterCommit,
  InvalidationPublisher,
  runInTransaction,
} from "../../common/redis/invalidation.publisher";
import { MembershipsRepository } from "../../memberships/memberships.repository";
import { OutboxService } from "../../notifications/outbox.service";
import { SuspensionService, type LifecycleActor } from "../../provisioning/suspension.service";
import { TenantsRepository, type TenantRecord } from "../../tenants/tenants.repository";
import {
  MANUAL_PAID_STATUS,
  MANUAL_TRIAL_STATUSES,
  SubscriptionsRepository,
  type LockedManualTrial,
  type ManualTrialRef,
} from "../subscriptions.repository";

/** The schedule and job name (scheduler.registry.ts). */
export const MANUAL_TRIALS_JOB = "billing.manual_trials";

/** The audit rows' `actor_label` and the suspension's system actor. */
export const MANUAL_TRIALS_ACTOR = "billing.manual_trials";

/** The banner of a trial that ends (`tenants.billing_notice`), shown by the portal and the OTA admin. */
export const TRIAL_ENDING_NOTICE = "trial_ending";

/** The notices before the end, in days: the first from 14 days before the end, the second from 3 days before. */
export const FIRST_NOTICE_DAYS = 14;
export const SECOND_NOTICE_DAYS = 3;

/** The days a manual trial stays `past_due` after its end before the OTA is suspended. */
export const GRACE_DAYS = 14;

/** The trials one page of the run reads; the run reads every page. */
export const MANUAL_TRIALS_PAGE_SIZE = 200;

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** A notice before the end of a trial: 14 or 3 days. */
export type TrialNotice = typeof FIRST_NOTICE_DAYS | typeof SECOND_NOTICE_DAYS;

/** The UTC calendar day of `instant`, as days since 1970-01-01. */
export function utcDay(instant: Date): number {
  return Math.floor(instant.getTime() / DAY_MS);
}

/** The date (`YYYY-MM-DD`) of the UTC day `day`. */
export function utcDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** How the e-mail says when the trial ends, `daysLeft` (1 or more) days from today: `in 14 days`, `tomorrow`. */
export function timeLeftText(daysLeft: number): string {
  return daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
}

/** What the decision reads of a manual trial and its OTA. */
export interface ManualTrialState {
  /** `trialing` or `past_due`, or `active` (paid outside Stripe). */
  readonly status: string;
  /** The end of the trial; `null` for none (nothing is due then). */
  readonly trialEndsAt: Date | null;
  /** The row's last write: when the run moved it to `past_due`, unless an admin changed it since. */
  readonly updatedAt: Date;
  /** The OTA's banner (`tenants.billing_notice`). */
  readonly billingNotice: string | null;
}

/** What is due for a manual trial today (see the file header). */
export interface ManualTrialStep {
  /** The notice to e-mail to the owners (once each), or none. */
  readonly notice: TrialNotice | null;
  /** The banner the OTA shows from now: its own when the step keeps it. */
  readonly billingNotice: string | null;
  /** The row's change: `past_due` on the end day, `canceled` (and the OTA suspended) after the grace period. */
  readonly transition: "past_due" | "canceled" | null;
}

/** The banner `billingNotice` without the trial's: another banner (`past_due`) stays. */
function withoutTrialBanner(billingNotice: string | null): string | null {
  return billingNotice === TRIAL_ENDING_NOTICE ? null : billingNotice;
}

/** The step of a manual trial in `state` on the UTC day of `now` (the table of the file header). */
export function manualTrialStep(state: ManualTrialState, now: Date): ManualTrialStep {
  if (state.status === MANUAL_PAID_STATUS) {
    // An admin set the manual subscription `active` (paid outside Stripe): no trial ends, so its banner goes.
    return { notice: null, billingNotice: withoutTrialBanner(state.billingNotice), transition: null };
  }
  if (state.trialEndsAt === null) {
    return { notice: null, billingNotice: state.billingNotice, transition: null };
  }
  const today = utcDay(now);
  const sinceEnd = today - utcDay(state.trialEndsAt);
  if (state.status === "trialing") {
    if (sinceEnd >= 0) {
      return { notice: null, billingNotice: TRIAL_ENDING_NOTICE, transition: "past_due" };
    }
    if (sinceEnd >= -SECOND_NOTICE_DAYS) {
      return { notice: SECOND_NOTICE_DAYS, billingNotice: TRIAL_ENDING_NOTICE, transition: null };
    }
    if (sinceEnd >= -FIRST_NOTICE_DAYS) {
      return { notice: FIRST_NOTICE_DAYS, billingNotice: TRIAL_ENDING_NOTICE, transition: null };
    }
    // Not in the notice window (any more): an admin moved the end later, so the trial's banner goes.
    return { notice: null, billingNotice: withoutTrialBanner(state.billingNotice), transition: null };
  }
  if (state.status === "past_due") {
    const graceOver = sinceEnd >= GRACE_DAYS && today - utcDay(state.updatedAt) >= GRACE_DAYS;
    return { notice: null, billingNotice: TRIAL_ENDING_NOTICE, transition: graceOver ? "canceled" : null };
  }
  return { notice: null, billingNotice: state.billingNotice, transition: null };
}

/** Why a trial found by the run was left as it was. */
export type ManualTrialSkip = "tenant_not_active" | "not_a_manual_trial";

/** What one trial's transaction did. */
export type ManualTrialOutcome =
  | {
      readonly outcome: "done";
      /** The notice e-mails queued now (none when they were queued before). */
      readonly emails: number;
      readonly bannerChanged: boolean;
      readonly transition: ManualTrialStep["transition"];
    }
  | { readonly outcome: "skipped"; readonly reason: ManualTrialSkip };

/** What a finished run returns (BullMQ keeps it with the job): counts only. */
export interface ManualTrialsResult {
  /** The trials found. */
  readonly trials: number;
  /** The notice e-mails queued. */
  readonly emails: number;
  /** The OTAs whose banner changed. */
  readonly banners: number;
  /** The trials moved to `past_due`. */
  readonly pastDue: number;
  /** The trials canceled, each with its OTA suspended. */
  readonly suspended: number;
  /** The trials left as they were (the OTA not active any more, or the row changed meanwhile). */
  readonly skipped: number;
}

/** Some trials could not be handled: the run fails, and BullMQ tries it again. */
export class ManualTrialsError extends Error {
  override readonly name = "ManualTrialsError";

  constructor(failed: number, trials: number) {
    super(`${MANUAL_TRIALS_JOB} could not handle ${failed} of ${trials} manual trials`);
  }
}

/** The `reason` of the audit row of a step of a manual subscription in `status`. */
function auditReason(step: ManualTrialStep, status: string): string {
  switch (step.transition) {
    case "past_due":
      return "trial_ended";
    case "canceled":
      return "grace_period_ended";
    case null:
      if (status === MANUAL_PAID_STATUS) {
        return "subscription_active";
      }
      return step.notice === null ? "trial_not_ending" : "trial_ending";
  }
}

/** True for a row the run handles: a manual trial with an end, or a manual subscription paid outside Stripe. */
function isHandledRow(row: LockedManualTrial): boolean {
  return (
    row.status === MANUAL_PAID_STATUS ||
    (row.trial_ends_at !== null && (MANUAL_TRIAL_STATUSES as readonly string[]).includes(row.status))
  );
}

@Injectable()
@MaintenanceJob(MANUAL_TRIALS_JOB)
export class ManualTrialsScheduler implements MaintenanceJobHandler {
  private readonly actor: LifecycleActor = { type: "system", label: MANUAL_TRIALS_ACTOR };

  constructor(
    private readonly subscriptions: SubscriptionsRepository,
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly suspension: SuspensionService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(ManualTrialsScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<ManualTrialsResult> {
    const now = this.clock.now();
    // A trial is in the notice window from FIRST_NOTICE_DAYS before its end day: it ends before the day after.
    const endsBefore = new Date((utcDay(now) + FIRST_NOTICE_DAYS + 1) * DAY_MS);
    const counts = { trials: 0, emails: 0, banners: 0, pastDue: 0, suspended: 0, skipped: 0 };
    let errors = 0;
    let afterId: string | undefined;
    for (;;) {
      const page = await this.subscriptions.findManualTrials({
        endsBefore,
        notice: TRIAL_ENDING_NOTICE,
        limit: MANUAL_TRIALS_PAGE_SIZE,
        ...(afterId === undefined ? {} : { afterId }),
      });
      for (const trial of page) {
        counts.trials += 1;
        try {
          const outcome = await this.advance(trial, now);
          if (outcome.outcome === "skipped") {
            counts.skipped += 1;
            continue;
          }
          counts.emails += outcome.emails;
          counts.banners += outcome.bannerChanged ? 1 : 0;
          counts.pastDue += outcome.transition === "past_due" ? 1 : 0;
          counts.suspended += outcome.transition === "canceled" ? 1 : 0;
        } catch (error) {
          errors += 1;
          this.logger.error(
            { subscriptionId: trial.id, tenantId: trial.tenant_id, err: error },
            "billing.manual_trial_failed",
          );
        }
      }
      if (page.length < MANUAL_TRIALS_PAGE_SIZE) {
        break;
      }
      afterId = page[page.length - 1]?.id;
    }
    const result: ManualTrialsResult = { ...counts };
    this.logger.info({ ...result, errors }, "billing.manual_trials");
    if (errors > 0) {
      throw new ManualTrialsError(errors, counts.trials);
    }
    return result;
  }

  /** Does the step due today for `trial` in one transaction (see the file header). */
  private advance(trial: ManualTrialRef, now: Date): Promise<ManualTrialOutcome> {
    return runInTransaction(this.db, async (trx): Promise<ManualTrialOutcome> => {
      // Billing's lock order: the tenant's row, then the subscription's.
      const tenant = await this.tenants.lockForUpdate(trx, trial.tenant_id);
      if (tenant === undefined || tenant.status !== "active") {
        return { outcome: "skipped", reason: "tenant_not_active" };
      }
      const row = await this.subscriptions.lockManualTrial(trx, trial.id);
      if (row === undefined || row.tenant_id !== tenant.id || !isHandledRow(row)) {
        return { outcome: "skipped", reason: "not_a_manual_trial" };
      }
      const trialEndsAt = row.trial_ends_at;
      const step = manualTrialStep(
        {
          status: row.status,
          trialEndsAt,
          updatedAt: row.updated_at,
          billingNotice: tenant.billing_notice,
        },
        now,
      );
      const emails =
        step.notice === null || trialEndsAt === null
          ? 0
          : await this.notifyOwners(trx, tenant, row, trialEndsAt, step.notice, now);
      const bannerChanged =
        step.billingNotice !== tenant.billing_notice &&
        (await this.tenants.setBillingNotice(trx, tenant.id, step.billingNotice, now));
      if (bannerChanged) {
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: tenant.id });
      }
      if (step.transition === "past_due") {
        await this.subscriptions.updateManual(trx, row.id, { status: "past_due" }, now);
      } else if (step.transition === "canceled") {
        await this.subscriptions.updateManual(trx, row.id, { status: "canceled", canceled_at: now }, now);
      }
      if (step.transition !== null || bannerChanged) {
        await this.audit.record(trx, {
          actorType: "system",
          actorLabel: MANUAL_TRIALS_ACTOR,
          action: "subscription.updated",
          targetType: "subscription",
          targetId: row.id,
          tenantId: tenant.id,
          tenantKey: tenant.key,
          before: {
            ...(step.transition === null ? {} : { status: row.status }),
            ...(bannerChanged ? { billingNotice: tenant.billing_notice } : {}),
          },
          after: {
            ...(step.transition === null ? {} : { status: step.transition }),
            ...(bannerChanged ? { billingNotice: step.billingNotice } : {}),
          },
          details: {
            reason: auditReason(step, row.status),
            billingProvider: "manual",
            trialEndsAt: trialEndsAt?.toISOString() ?? null,
            ...(step.notice === null ? {} : { notice: step.notice, emailsQueued: emails }),
          },
        });
      }
      if (step.transition === "canceled") {
        const jobId = await this.suspension.suspendInTransaction(trx, tenant.id, "billing", this.actor);
        afterCommit(trx, () => this.suspension.dispatchQuietly(jobId, tenant.id, this.actor));
      }
      return { outcome: "done", emails, bannerChanged, transition: step.transition };
    });
  }

  /**
   * Queues the `notice` of the trial `row` (ending at `trialEndsAt`) to every active owner of `tenant` in `trx`, once
   * per owner, trial end and notice. Returns the e-mails queued now.
   */
  private async notifyOwners(
    trx: PlatformTransaction,
    tenant: TenantRecord,
    row: LockedManualTrial,
    trialEndsAt: Date,
    notice: TrialNotice,
    now: Date,
  ): Promise<number> {
    const endDay = utcDay(trialEndsAt);
    const trialEndsOn = utcDate(endDay);
    const data = {
      tenantName: tenant.name,
      tenantKey: tenant.key,
      trialEndsOn,
      timeLeft: timeLeftText(endDay - utcDay(now)),
      suspensionOn: utcDate(endDay + GRACE_DAYS),
      billingUrl: this.outbox.portalLink(`/otas/${tenant.id}/billing`),
    };
    const owners = (await this.memberships.listActive(tenant.id, trx)).filter(
      (member) => member.role === "owner",
    );
    let queued = 0;
    for (const owner of owners) {
      const email = await this.outbox.queue(trx, {
        templateKey: "billing.trial_ending",
        to: owner.email,
        accountId: owner.account_id,
        tenantId: tenant.id,
        data: { fullName: owner.full_name, ...data },
        idempotencyKey: `trial_ending:${row.id}:${trialEndsOn}:${notice}`,
      });
      queued += email.queued ? 1 : 0;
    }
    return queued;
  }
}
