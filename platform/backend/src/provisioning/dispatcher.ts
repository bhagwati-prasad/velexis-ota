// The dispatch of a provisioning job to the OTA worker (PBE-019; platform/docs/flows/provisioning.md §1, PADR-0001 items
// 2, 3, 4 and 8). One function for every caller: the API right after createTenant commits (PBE-018), and later the
// owner's retry and the reconciler (PBE-023), the suspend, resume and migrate actions (PBE-030) and the Checkout
// webhook (M5).
//
// `dispatch(jobId)`, in order:
//
// 1. One short transaction (`runInTransaction`):
//    - the job is read with its tenant's status and the tenant's current subscription, and its row is locked, so two
//      dispatches of one job run one after the other and the second finds the job `running`;
//    - nothing is changed or enqueued when the job does not exist, is not `queued`, is not due yet (`scheduled_at`
//      after now), has a kind without an `ota-tenant-ops` message (`export`, `delete`, `restore`, `rotate_secrets`
//      stay post-MVP), or is a `provision` job whose gate is closed: the tenant must be `provisioning` and its
//      current subscription `trialing`, `active` or manual (`billing_provider = 'manual'`). Before M5 every new OTA
//      has a manual trial, so the gate is open; from M5 it stays closed while a Stripe subscription is `incomplete`.
//      Only `provision` jobs have a gate: a `migrate`, `suspend` or `resume` job goes out whatever the subscription;
//    - the conditional update `queued → running`, `attempt + 1`, `step = 'dispatch'`, `started_at = coalesce(
//      started_at, now)`, `locked_until = now + 15 min`, where the job is still `queued` and `scheduled_at <= now`;
//    - the message is built and checked with `validateJob` of `@velexis/api-types/jobs` (PBE-004), so an invalid
//      message rolls the update back instead of leaving a `running` job that nothing will answer.
// 2. After the commit, `queue.add(<name>, message, {jobId: "<jobId>-<attempt>", attempts: 3, backoff: exponential
//    from 30 s})` on `ota-tenant-ops`. BullMQ ignores an add with an id it already holds, so a repeated add of one
//    attempt adds nothing, and a re-dispatch after a failure is a new BullMQ job. BullMQ retries transient errors
//    inside the attempt; the platform counts the attempts (5) and re-queues them (PADR-0001 item 4, PBE-023).
//
// The add never fails the caller: a Redis error, or no answer within DISPATCH_ENQUEUE_TIMEOUT_MS, is logged
// (`provisioning.enqueue_failed`, `provisioning.enqueue_timeout`) and the job stays `running` without a BullMQ job.
// The reconciler finds it once the lease has ended and counts it as a retryable failure (PADR-0001 item 6).
//
// The message carries ids only (ADR-0009 item 10): `{v: 1, name, jobId, tenantId, requestedAt, requestId, payload}`,
// where `payload` is the job's `payload` column (`{}` for `provision` and `resume`, `{targetVersion?}` for `migrate`,
// `{reason}` for `suspend`). `requestId` is the caller's, else the HTTP request's (RequestContext, in the API), else a
// new one, so the OTA worker's log lines and its answer carry the id of what caused them. "Now" is the injected
// Clock's time, never the database's `now()`, as in the other repositories, so leases follow the FakeClock in tests.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  bullmqJobId,
  JOB_CONTRACT_VERSION,
  validateJob,
  type TenantOpsJob,
  type TenantOpsJobName,
} from "@velexis/api-types/jobs";
import { resolveRequestId } from "@velexis/logger";
import type { JobsOptions, Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { RequestContext } from "../common/http/request-context";
import { PLATFORM_QUEUE } from "../common/queues/queue-names";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import {
  ProvisioningJobsRepository,
  type DispatchCandidateRow,
  type ProvisioningJobKind,
  type ProvisioningJobStatus,
} from "./provisioning-jobs.repository";

/** How long a dispatched attempt holds its lease (`locked_until`) before the reconciler looks at it. */
export const DISPATCH_LEASE_MS = 15 * 60 * 1000;

/** The tries BullMQ gives one attempt in the OTA worker (transient errors only; PADR-0001 item 4). */
export const TENANT_OPS_JOB_ATTEMPTS = 3;

/** The backoff between those tries: 30 s, then 60 s. */
export const TENANT_OPS_JOB_BACKOFF = Object.freeze({ type: "exponential", delay: 30_000 } as const);

/** How long the add after the commit may take before the reconciler is left to recover the attempt. */
export const DISPATCH_ENQUEUE_TIMEOUT_MS = 2000;

/** The `ota-tenant-ops` message of each job kind that has one; the other kinds are post-MVP. */
export const TENANT_OPS_MESSAGE_OF_KIND: Readonly<Partial<Record<ProvisioningJobKind, TenantOpsJobName>>> =
  Object.freeze({
    provision: "tenant.provision",
    migrate: "tenant.migrate",
    suspend: "tenant.suspend",
    resume: "tenant.resume",
  });

/** The statuses of a Stripe subscription that open the gate; a manual one opens it in any current status. */
const GATE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["trialing", "active"]);

/** What the gate of a `provision` job looks at. */
export interface ProvisionGateInput {
  readonly tenantStatus: string;
  /** The tenant's current subscription; `null` when it has none. */
  readonly subscription: { readonly status: string; readonly billingProvider: string } | null;
}

/**
 * True when a `provision` job may be dispatched (PADR-0001 item 2): the tenant is `provisioning` and its current
 * subscription is `trialing` or `active`, or manual (Velexis bills nothing, so nothing waits for a payment).
 */
export function isProvisionGateOpen(input: ProvisionGateInput): boolean {
  const { tenantStatus, subscription } = input;
  if (tenantStatus !== "provisioning" || subscription === null) {
    return false;
  }
  return GATE_SUBSCRIPTION_STATUSES.has(subscription.status) || subscription.billingProvider === "manual";
}

/** What the message of a dispatch is built from. */
export interface TenantOpsMessageInput {
  readonly name: TenantOpsJobName;
  readonly jobId: string;
  readonly tenantId: string;
  /** The job's `payload` column. */
  readonly payload: unknown;
  readonly requestedAt: Date;
  readonly requestId: string;
}

/**
 * The `ota-tenant-ops` message of a dispatch, checked against its JSON Schema.
 *
 * @throws {MessageValidationError} when it is not a valid message of that name (a payload the message does not take,
 *   an id or a request id of another shape); the error names paths and rules, never values.
 */
export function tenantOpsMessage(input: TenantOpsMessageInput): TenantOpsJob {
  return validateJob(input.name, {
    v: JOB_CONTRACT_VERSION,
    name: input.name,
    jobId: input.jobId,
    tenantId: input.tenantId,
    requestedAt: input.requestedAt.toISOString(),
    requestId: input.requestId,
    payload: input.payload,
  });
}

/** The BullMQ options of attempt `attempt` of job `jobId`; the retention comes from the queue's defaults. */
export function tenantOpsJobOptions(jobId: string, attempt: number): JobsOptions {
  return {
    jobId: bullmqJobId(jobId, attempt),
    attempts: TENANT_OPS_JOB_ATTEMPTS,
    backoff: { ...TENANT_OPS_JOB_BACKOFF },
  };
}

/** Why a dispatch changed nothing. */
export type NotDispatchedReason = "not_found" | "not_queued" | "not_due" | "unsupported_kind" | "gate_closed";

/** The job went out: it is `running` with a new attempt. */
export interface Dispatched {
  readonly dispatched: true;
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: ProvisioningJobKind;
  readonly attempt: number;
  /** `<jobId>-<attempt>`. */
  readonly bullmqJobId: string;
  /** False when the add after the commit failed or timed out: the reconciler recovers the attempt. */
  readonly enqueued: boolean;
}

/** Nothing was changed or enqueued. */
export interface NotDispatched {
  readonly dispatched: false;
  readonly jobId: string;
  readonly reason: NotDispatchedReason;
  /** The job's status as read; `null` for an unknown job. */
  readonly status: ProvisioningJobStatus | null;
}

export type DispatchResult = Dispatched | NotDispatched;

/** The options of one dispatch. */
export interface DispatchOptions {
  /** The request id the message carries; default the HTTP request's, else a new one. */
  readonly requestId?: string;
}

/** What the transaction decided: the message to add after the commit, or why nothing goes out. */
type Decision =
  | {
      readonly dispatched: true;
      readonly message: TenantOpsJob;
      readonly kind: ProvisioningJobKind;
      readonly attempt: number;
    }
  | NotDispatched;

function notDispatched(job: DispatchCandidateRow, reason: NotDispatchedReason): NotDispatched {
  return { dispatched: false, jobId: job.id, reason, status: job.status };
}

/**
 * Whether `job` may be dispatched at `now`: the name of its message, or why not (in this order: not `queued`, not due,
 * a kind without a message, a closed gate).
 */
export function checkDispatch(
  job: DispatchCandidateRow,
  now: Date,
): { readonly name: TenantOpsJobName } | NotDispatched {
  if (job.status !== "queued") {
    return notDispatched(job, "not_queued");
  }
  if (job.scheduled_at.getTime() > now.getTime()) {
    return notDispatched(job, "not_due");
  }
  const name = TENANT_OPS_MESSAGE_OF_KIND[job.kind];
  if (name === undefined) {
    return notDispatched(job, "unsupported_kind");
  }
  const subscription =
    job.subscription_status === null || job.billing_provider === null
      ? null
      : { status: job.subscription_status, billingProvider: job.billing_provider };
  if (job.kind === "provision" && !isProvisionGateOpen({ tenantStatus: job.tenant_status, subscription })) {
    return notDispatched(job, "gate_closed");
  }
  return { name };
}

/**
 * Dispatches provisioning jobs to the OTA worker (see the file header). ProvisioningModule provides it to the API and,
 * with the worker's tasks, to the worker.
 */
@Injectable()
export class ProvisioningDispatcher {
  constructor(
    private readonly jobs: ProvisioningJobsRepository,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    private readonly clock: Clock,
    @InjectQueue(PLATFORM_QUEUE.tenantOps) private readonly tenantOps: Queue,
    @InjectPinoLogger(ProvisioningDispatcher.name) private readonly logger: PinoLogger,
    // The request context exists in the API only; the worker's callers pass their job's request id.
    @Optional() private readonly requestContext?: RequestContext,
  ) {}

  /**
   * Dispatches job `jobId` if it is queued, due and, for a `provision` job, its gate is open. Rejects only when the
   * transaction fails (the job stays as it was); the add after the commit never rejects.
   */
  async dispatch(jobId: string, options: DispatchOptions = {}): Promise<DispatchResult> {
    const requestId = options.requestId ?? this.requestContext?.requestId ?? resolveRequestId(undefined);
    const decision = await runInTransaction(this.db, async (trx): Promise<Decision> => {
      const now = this.clock.now();
      const job = await this.jobs.lockForDispatch(trx, jobId);
      if (job === undefined) {
        return { dispatched: false, jobId, reason: "not_found", status: null };
      }
      const checked = checkDispatch(job, now);
      if ("dispatched" in checked) {
        return checked;
      }
      const attempt = await this.jobs.markDispatched(trx, {
        jobId,
        now,
        lockedUntil: new Date(now.getTime() + DISPATCH_LEASE_MS),
      });
      if (attempt === undefined) {
        // The row is locked and was `queued`, so only the time can differ: a `scheduled_at` that PostgreSQL holds
        // to the microsecond may lie inside the millisecond of `now` and still be after it.
        return notDispatched(job, "not_due");
      }
      const message = tenantOpsMessage({
        name: checked.name,
        jobId,
        tenantId: job.tenant_id,
        payload: job.payload,
        requestedAt: now,
        requestId,
      });
      return { dispatched: true, message, kind: job.kind, attempt };
    });
    if (!decision.dispatched) {
      this.logger.info(
        { jobId, reason: decision.reason, status: decision.status },
        "provisioning.not_dispatched",
      );
      return decision;
    }
    const { message, kind, attempt } = decision;
    const jobOptions = tenantOpsJobOptions(jobId, attempt);
    const bullmqId = bullmqJobId(jobId, attempt);
    const enqueued = await this.enqueue(message, jobOptions);
    if (enqueued) {
      this.logger.info(
        { jobId, tenantId: message.tenantId, kind, attempt, bullmqJobId: bullmqId, requestId },
        "provisioning.dispatched",
      );
    }
    return {
      dispatched: true,
      jobId,
      tenantId: message.tenantId,
      kind,
      attempt,
      bullmqJobId: bullmqId,
      enqueued,
    };
  }

  /** Adds the message; never rejects (see the file header). */
  private async enqueue(message: TenantOpsJob, options: JobsOptions): Promise<boolean> {
    const context = { jobId: message.jobId, tenantId: message.tenantId, bullmqJobId: options.jobId };
    let timer: NodeJS.Timeout | undefined;
    const added = this.tenantOps.add(message.name, message, options).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ ...context, err: error }, "provisioning.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), DISPATCH_ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn(
          { ...context, timeoutMs: DISPATCH_ENQUEUE_TIMEOUT_MS },
          "provisioning.enqueue_timeout",
        );
        return false;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
