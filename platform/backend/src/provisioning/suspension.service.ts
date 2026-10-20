// Suspension and resume of an OTA, and the switch of one of its connections (PBE-030; PADR-0014, platform/docs/flows/
// provisioning.md §5 and platform-admin-operations.md §B, api-inventory-admin.md §3, scope PF-82). One service for every
// caller: the platform admin's routes (AdminTenantsController) and, from M5, billing sync, which suspends for `billing`
// and resumes when the subscription is paid again (ADR-0013). The worker uses it for the OTA worker's answers.
//
// `suspend(tenantId, reason, actor)`, PADR-0014 item 2:
//
// 1. One transaction (`runInTransaction`) locks the tenant's row. An unknown tenant, or one being deprovisioned or
//    deleted (no `TenantStatus`), answers `404 NOT_FOUND`; any status but `active` `409 CONFLICT` (`details.reason =
//    not_active`). Then `active → suspended` with `suspended_at`, `suspension_reason` and `version + 1`; a new
//    `suspend` job (`queued`, payload `{reason}`, requested by the admin; none for the system); one `tenant.suspended`
//    audit row (`actor_type = 'platform_admin'` with the admin's written reason, or `system` with its label); the
//    e-mail `tenant.suspended` to every active owner (keyed by the job id, so one per owner and job; the worker sends it
//    after the commit); and the `tenant` invalidation, published after the commit, so the storefront and the OTA API
//    answer `TENANT_SUSPENDED` within 60 seconds. `billing` is billing sync's reason only (PADR-0014 item 1): the
//    document refuses it on the admin's route, and the service refuses it for a platform admin.
// 2. After the commit the job is dispatched as `tenant.suspend {reason}` (dispatcher.ts). The dispatch never fails the
//    call: the status switch is the effect, and the reconciler dispatches a job left `queued`.
// 3. The answer is the tenant and the job as they are then.
//
// `resume(tenantId, actor)` mirrors it (PADR-0014 item 4): only a `suspended` tenant (`409`, `not_suspended`); a
// `billing` suspension only while the tenant's current subscription is `trialing` or `active` (`409`,
// `subscription_not_active`), and a suspension for another reason only by a platform admin (`409`,
// `not_billing_suspension`, for billing sync). `suspended → active`, the suspension fields cleared, `version + 1`, a
// `resume` job (payload `{}`), `tenant.resumed` audited, the e-mail `tenant.resumed`, the invalidation, and
// `tenant.resume` after the commit.
//
// The answers of the OTA worker: `markAnswered` takes `tenant.suspended` and `tenant.resumed` of the job's current
// attempt from the tenant-event consumer and marks the job `succeeded`, whatever the tenant's status is now (PADR-0014
// item 7: the OTA worker acts on the current state, so a late answer still ends its job). Until the OTA consumer exists
// (OBE-074, M4) the real OTA worker rejects these messages; the reconciler then counts each attempt as lost and, after
// the last one, the failure handler fails the job with an `ops.alert` and leaves `tenants.status` as it is (PADR-0001
// item 7). The job's state shows in the platform admin.
//
// A new suspension (or resume) while the previous job of its kind still waits for its answer (suspend, resume, suspend
// again within the attempts of the first job) supersedes that job: it is `canceled` with the error `SUPERSEDED: …`
// naming the new job, in the same transaction, because the partial unique index `provisioning_jobs_active_uq` allows
// one active job of a kind per tenant. The old job's late answer is then ignored, and the new job carries the
// housekeeping of the tenant's current state. The audit row names the superseded job.
//
// `setConnectionStatus(tenantId, change, actor)` (adminSetConnectionStatus): the platform admin disables the Amadeus
// (`supplier_connections`) or payment (`payment_provider_connections`) connection of one environment, or re-enables a
// disabled one (flows/amadeus-connection.md "Abuse on a shared office", PADR-0014 "Negative"). One transaction locks
// the connection's row (`404 NOT_FOUND` without one, or for a tenant without a `TenantStatus`):
// - `disabled` on a connection that is not disabled sets it `disabled` (`version + 1`); on a disabled one it changes
//   nothing and answers the connection as it is (no audit row, no invalidation, as adminUpdateTenant does);
// - `active` only on a `disabled` connection (`409 CONFLICT`, `not_disabled`), and only when the connection can work
//   again: an Amadeus connection with at least one office (`no_office`), a payment connection whose OTA account was not
//   deauthorised in Stripe (`disconnected_at` empty; `deauthorized`);
// - a change writes one `connection.status_changed` audit row (`actor_type = 'platform_admin'`, the status before and
//   after, the kind, the environment and the reason) and publishes `{type: "connection", tenantId}` after the commit,
//   so the OTA backend reloads the connection.
//
// "Now" is the injected Clock's time, as in the rest of provisioning.
import { Inject, Injectable } from "@nestjs/common";
import type { TenantSuspensionReason } from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService, type AuditEntry } from "../audit/audit.service";
import { SubscriptionsRepository } from "../billing/subscriptions.repository";
import { MEMBER_VISIBLE_TENANT_STATUSES } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { MembershipsRepository } from "../memberships/memberships.repository";
import { OutboxService } from "../notifications/outbox.service";
import {
  PaymentConnectionsRepository,
  type PaymentConnectionView,
} from "../payment-connections/payment-connections.repository";
import {
  SupplierConnectionsRepository,
  type SupplierConnectionView,
} from "../supplier-connections/supplier-connections.repository";
import { TenantsRepository, type TenantRecord, type TenantWithHost } from "../tenants/tenants.repository";
import { ProvisioningDispatcher } from "./dispatcher";
import {
  ProvisioningJobsRepository,
  type AdminJobListRow,
  type ProvisioningJobKind,
} from "./provisioning-jobs.repository";

/** Who suspends or resumes: a platform admin with a written reason, or the system (billing sync, M5). */
export type LifecycleActor =
  | {
      readonly type: "platform_admin";
      /** `acc_…` of the admin. */
      readonly accountId: string;
      /** The admin's written reason (5–500 characters), kept in the audit row. */
      readonly reason: string;
    }
  | {
      readonly type: "system";
      /** What acted, for the audit row's `actor_label`, e.g. `billing`. */
      readonly label: string;
      /** The request id of the job run that caused it, for the audit row and the message. */
      readonly requestId?: string;
    };

/** The tenant and the job after a suspend or resume. */
export interface TenantLifecycleResult {
  readonly tenant: TenantWithHost;
  readonly job: AdminJobListRow;
}

/** The connection kinds of adminSetConnectionStatus. */
export type ConnectionKind = "amadeus" | "payment";

/** The statuses an admin may set on a connection. */
export type ConnectionTargetStatus = "active" | "disabled";

/** The change of adminSetConnectionStatus. */
export interface ConnectionStatusChange {
  readonly kind: ConnectionKind;
  readonly environment: "test" | "live";
  readonly status: ConnectionTargetStatus;
  /** The admin's written reason, kept in the audit row. */
  readonly reason: string;
}

/** The connection after adminSetConnectionStatus, read without its secrets. */
export type ConnectionStatusResult =
  | { readonly kind: "amadeus"; readonly connection: SupplierConnectionView }
  | { readonly kind: "payment"; readonly connection: PaymentConnectionView };

/** What a connection's current state allows for a status change. */
export type ConnectionStatusDecision =
  | { readonly action: "update" }
  | { readonly action: "unchanged" }
  | { readonly action: "conflict"; readonly reason: "not_disabled" | "no_office" | "deauthorized" };

/** Why an answer of the OTA worker left its job as it was. */
export type AnswerIgnoredReason =
  "unknown_job" | "other_kind" | "stale_attempt" | "unknown_attempt" | "finished";

/** What `markAnswered` did. */
export type AnswerOutcome =
  { readonly outcome: "succeeded" } | { readonly outcome: "ignored"; readonly reason: AnswerIgnoredReason };

/** The statuses of a current subscription that let a billing suspension end (PADR-0014 item 4). */
const RESUMABLE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["trialing", "active"]);

/** True when the admin can see a tenant of `status` (the statuses of `TenantStatus`). */
export function isShownTenantStatus(status: string): boolean {
  return (MEMBER_VISIBLE_TENANT_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether a connection in `current` may become `target` (see the file header): `ready` says whether it can work again
 * (an Amadeus connection with an office, a payment connection that was not deauthorised).
 */
export function connectionStatusDecision(
  kind: ConnectionKind,
  current: string,
  target: ConnectionTargetStatus,
  ready: boolean,
): ConnectionStatusDecision {
  if (target === "disabled") {
    return current === "disabled" ? { action: "unchanged" } : { action: "update" };
  }
  if (current !== "disabled") {
    return { action: "conflict", reason: "not_disabled" };
  }
  if (!ready) {
    return { action: "conflict", reason: kind === "amadeus" ? "no_office" : "deauthorized" };
  }
  return { action: "update" };
}

/** The audit row's actor fields of `actor`. */
function actorOf(actor: LifecycleActor): Pick<AuditEntry, "actorType" | "actorAccountId" | "actorLabel"> {
  return actor.type === "platform_admin"
    ? { actorType: "platform_admin", actorAccountId: actor.accountId }
    : { actorType: "system", actorLabel: actor.label };
}

/** The admin's written reason for the audit row's details; nothing for the system. */
function reasonOf(actor: LifecycleActor): { readonly reason?: string } {
  return actor.type === "platform_admin" ? { reason: actor.reason } : {};
}

/** The job written by a suspend or resume: its id and the active job of its kind that it superseded, if any. */
interface QueuedLifecycleJob {
  readonly id: string;
  readonly superseded: readonly string[];
}

@Injectable()
export class SuspensionService {
  constructor(
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly dispatcher: ProvisioningDispatcher,
    private readonly supplierConnections: SupplierConnectionsRepository,
    private readonly paymentConnections: PaymentConnectionsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(SuspensionService.name) private readonly logger: PinoLogger,
  ) {}

  /** Suspends the active OTA `tenantId` for `reason` (see the file header). */
  async suspend(
    tenantId: string,
    reason: TenantSuspensionReason,
    actor: LifecycleActor,
  ): Promise<TenantLifecycleResult> {
    if (actor.type === "platform_admin" && reason === "billing") {
      throw new Error("SuspensionService.suspend: `billing` is set by billing sync only (PADR-0014 item 1)");
    }
    const jobId = await runInTransaction(this.db, async (trx) => {
      const tenant = await this.lockShownTenant(trx, tenantId);
      const now = this.clock.now();
      if (tenant.status !== "active" || !(await this.tenants.suspend(trx, tenantId, reason, now))) {
        throw new AppError("CONFLICT", { details: { reason: "not_active", status: tenant.status } });
      }
      const job = await this.queueJob(trx, tenant, "suspend", { reason }, actor, now);
      await this.audit.record(trx, {
        ...actorOf(actor),
        action: "tenant.suspended",
        targetType: "tenant",
        targetId: tenantId,
        tenantId,
        tenantKey: tenant.key,
        before: { status: "active" },
        after: { status: "suspended", suspensionReason: reason },
        details: {
          jobId: job.id,
          suspensionReason: reason,
          ...reasonOf(actor),
          ...(job.superseded.length === 0 ? {} : { supersededJobIds: [...job.superseded] }),
        },
        ...(actor.type === "system" && actor.requestId !== undefined ? { requestId: actor.requestId } : {}),
      });
      await this.notifyOwners(trx, tenant, "tenant.suspended", job.id);
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: tenantId });
      return job.id;
    });
    return this.afterCommit(tenantId, jobId, actor);
  }

  /** Resumes the suspended OTA `tenantId` (see the file header). */
  async resume(tenantId: string, actor: LifecycleActor): Promise<TenantLifecycleResult> {
    const jobId = await runInTransaction(this.db, async (trx) => {
      const tenant = await this.lockShownTenant(trx, tenantId);
      if (tenant.status !== "suspended") {
        throw new AppError("CONFLICT", { details: { reason: "not_suspended", status: tenant.status } });
      }
      if (tenant.suspension_reason === "billing") {
        const subscription = await this.subscriptions.findShownForTenant(tenantId, trx);
        if (subscription === undefined || !RESUMABLE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
          throw new AppError("CONFLICT", {
            details: {
              reason: "subscription_not_active",
              subscriptionStatus: subscription?.status ?? null,
            },
          });
        }
      } else if (actor.type === "system") {
        // Only a platform admin lifts a suspension for abuse, a request or an admin decision (PADR-0014 item 4).
        throw new AppError("CONFLICT", {
          details: { reason: "not_billing_suspension", suspensionReason: tenant.suspension_reason },
        });
      }
      const now = this.clock.now();
      if (!(await this.tenants.resume(trx, tenantId, now))) {
        throw new AppError("CONFLICT", { details: { reason: "not_suspended", status: tenant.status } });
      }
      const job = await this.queueJob(trx, tenant, "resume", {}, actor, now);
      await this.audit.record(trx, {
        ...actorOf(actor),
        action: "tenant.resumed",
        targetType: "tenant",
        targetId: tenantId,
        tenantId,
        tenantKey: tenant.key,
        before: {
          status: "suspended",
          suspensionReason: tenant.suspension_reason,
          suspendedAt: tenant.suspended_at?.toISOString() ?? null,
        },
        after: { status: "active" },
        details: {
          jobId: job.id,
          ...reasonOf(actor),
          ...(job.superseded.length === 0 ? {} : { supersededJobIds: [...job.superseded] }),
        },
        ...(actor.type === "system" && actor.requestId !== undefined ? { requestId: actor.requestId } : {}),
      });
      await this.notifyOwners(trx, tenant, "tenant.resumed", job.id);
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: tenantId });
      return job.id;
    });
    return this.afterCommit(tenantId, jobId, actor);
  }

  /** Sets the status of one connection of `tenantId` for the platform admin `accountId` (see the file header). */
  async setConnectionStatus(
    tenantId: string,
    change: ConnectionStatusChange,
    accountId: string,
  ): Promise<ConnectionStatusResult> {
    return runInTransaction(this.db, async (trx): Promise<ConnectionStatusResult> => {
      const tenant = await this.tenants.findWithHost(tenantId, trx);
      if (tenant === undefined || !isShownTenantStatus(tenant.status)) {
        throw new AppError("NOT_FOUND");
      }
      const now = this.clock.now();
      let current: { readonly id: string; readonly status: string };
      let result: ConnectionStatusResult;
      if (change.kind === "amadeus") {
        const row = await this.supplierConnections.lockForTenant(trx, tenantId, change.environment);
        if (row === undefined) {
          throw new AppError("NOT_FOUND");
        }
        const decision = this.decide(change, row.status, row.office_ids.length > 0);
        if (decision === "unchanged") {
          return { kind: "amadeus", connection: row };
        }
        current = row;
        result = {
          kind: "amadeus",
          connection: await this.supplierConnections.setStatus(trx, row.id, change.status, now),
        };
      } else {
        const row = await this.paymentConnections.lockForTenant(trx, tenantId, change.environment);
        if (row === undefined) {
          throw new AppError("NOT_FOUND");
        }
        const decision = this.decide(change, row.status, row.disconnected_at === null);
        if (decision === "unchanged") {
          return { kind: "payment", connection: row };
        }
        current = row;
        result = {
          kind: "payment",
          connection: await this.paymentConnections.setStatus(trx, row.id, change.status, now),
        };
      }
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: accountId,
        action: "connection.status_changed",
        targetType: change.kind === "amadeus" ? "supplier_connection" : "payment_connection",
        targetId: current.id,
        tenantId,
        tenantKey: tenant.key,
        before: { status: current.status },
        after: { status: change.status },
        details: { kind: change.kind, environment: change.environment, reason: change.reason },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
      return result;
    });
  }

  /**
   * The OTA worker's answer (`tenant.suspended` or `tenant.resumed`) of attempt `attempt` of the `kind` job `jobId`:
   * the job becomes `succeeded` when it is still active at that attempt (re-checked under its row lock), whatever the
   * tenant's status is now (PADR-0014 item 7).
   */
  async markAnswered(answer: {
    readonly jobId: string;
    readonly attempt: number;
    readonly kind: Extract<ProvisioningJobKind, "suspend" | "resume">;
  }): Promise<AnswerOutcome> {
    return runInTransaction(this.db, async (trx): Promise<AnswerOutcome> => {
      const job = await this.jobs.lockForLifecycle(trx, answer.jobId);
      if (job === undefined) {
        return { outcome: "ignored", reason: "unknown_job" };
      }
      if (job.kind !== answer.kind) {
        return { outcome: "ignored", reason: "other_kind" };
      }
      if (answer.attempt !== job.attempt) {
        return {
          outcome: "ignored",
          reason: answer.attempt < job.attempt ? "stale_attempt" : "unknown_attempt",
        };
      }
      if (job.status !== "queued" && job.status !== "running") {
        return { outcome: "ignored", reason: "finished" };
      }
      const succeeded = await this.jobs.markSucceeded(trx, {
        jobId: job.id,
        attempt: job.attempt,
        now: this.clock.now(),
      });
      return succeeded ? { outcome: "succeeded" } : { outcome: "ignored", reason: "finished" };
    });
  }

  /** The tenant row locked for the change; `404 NOT_FOUND` for none, or one without a `TenantStatus`. */
  private async lockShownTenant(trx: PlatformTransaction, tenantId: string): Promise<TenantRecord> {
    const tenant = await this.tenants.lockForUpdate(trx, tenantId);
    if (tenant === undefined || !isShownTenantStatus(tenant.status)) {
      throw new AppError("NOT_FOUND");
    }
    return tenant;
  }

  /** `update` or `unchanged` for `change`; throws `409 CONFLICT` with the reason otherwise. */
  private decide(change: ConnectionStatusChange, current: string, ready: boolean): "update" | "unchanged" {
    const decision = connectionStatusDecision(change.kind, current, change.status, ready);
    if (decision.action === "conflict") {
      throw new AppError("CONFLICT", { details: { reason: decision.reason, status: current } });
    }
    return decision.action;
  }

  /**
   * Queues the `kind` job of a suspend or resume in `trx`, after superseding the active job of that kind (see the file
   * header).
   */
  private async queueJob(
    trx: PlatformTransaction,
    tenant: TenantRecord,
    kind: Extract<ProvisioningJobKind, "suspend" | "resume">,
    payload: Readonly<Record<string, unknown>>,
    actor: LifecycleActor,
    now: Date,
  ): Promise<QueuedLifecycleJob> {
    const id = this.ids.new("job");
    const superseded = await this.jobs.supersedeActive(trx, {
      tenantId: tenant.id,
      kind,
      supersededBy: id,
      now,
    });
    await this.jobs.insertQueued(trx, {
      id,
      tenantId: tenant.id,
      kind,
      requestedByAccountId: actor.type === "platform_admin" ? actor.accountId : null,
      now,
      payload,
    });
    if (superseded.length > 0) {
      this.logger.info({ tenantId: tenant.id, kind, jobId: id, superseded }, "provisioning.job_superseded");
    }
    return { id, superseded };
  }

  /** Queues `templateKey` to every active owner of `tenant` in `trx`, once per owner and job. */
  private async notifyOwners(
    trx: PlatformTransaction,
    tenant: TenantRecord,
    templateKey: "tenant.suspended" | "tenant.resumed",
    jobId: string,
  ): Promise<void> {
    const owners = (await this.memberships.listActive(tenant.id, trx)).filter(
      (member) => member.role === "owner",
    );
    for (const owner of owners) {
      await this.outbox.queue(trx, {
        templateKey,
        to: owner.email,
        accountId: owner.account_id,
        tenantId: tenant.id,
        data: { fullName: owner.full_name, tenantName: tenant.name, tenantKey: tenant.key },
        idempotencyKey: jobId,
      });
    }
  }

  /**
   * After the commit: dispatches the job (never failing the call; the reconciler takes a job left `queued`) and reads
   * the tenant and the job back.
   */
  private async afterCommit(
    tenantId: string,
    jobId: string,
    actor: LifecycleActor,
  ): Promise<TenantLifecycleResult> {
    try {
      await this.dispatcher.dispatch(
        jobId,
        actor.type === "system" && actor.requestId !== undefined ? { requestId: actor.requestId } : {},
      );
    } catch (error) {
      this.logger.warn({ jobId, tenantId, err: error }, "provisioning.dispatch_failed");
    }
    const tenant = await this.tenants.findWithHost(tenantId);
    const job = await this.jobs.findForAdmin(jobId);
    if (tenant === undefined || job === undefined) {
      throw new Error("SuspensionService: the tenant or the job written in this request cannot be read back");
    }
    return { tenant, job };
  }
}
