// The consumer of `ota-ticketing` and the `ticketing.scan` schedule (OBE-044; OADR-0008 points 4, 5 and 8, OADR-0014
// points 1, 4, 5 and 6, ota/docs/architecture.md §6, ota/docs/flows/ticketing-and-documents.md §2). They run in the
// worker only (BookingsWorkerModule).
//
// `ticketing.scan` (every 5 minutes, jobs/schedulers.ts) runs per tenant on `ota-maintenance`, for `active` and
// `suspended` tenants (a suspended OTA's paid travellers still get their tickets): it lists the bookings whose
// issuance is due (ticketing.service.ts, TicketingRepository.dueBookingIds: a retry whose time has come, or a claim
// abandoned for more than 5 minutes; never an airline-card booking; for a suspended tenant only paid ones), at most
// TICKETING_SCAN_BATCH, the longest waiting first, and enqueues `ticketing.issue {tenantId, bookingId}` for each with
// the deterministic id `ticketing.issue:<bookingId>:<minute bucket>`, so two runs of one scheduler iteration add each
// booking once. It never continues itself: a claimed booking is no longer due, so the next run takes the rest. A
// booking whose window closed while the worker was down is enqueued all the same: its job re-reads the order and gives
// up with the staff alert (the scan's "deadline alerts").
//
// `ticketing.issue {tenantId, bookingId}` (concurrency 2): the payload is checked (exactly the two ids, else the job
// fails at once with `UnrecoverableError`), the tenant is resolved through the platform cache and skipped unless it is
// `active` or `suspended`, and TicketingService.attempt runs in the tenant's job context. The job trusts nothing but
// the two ids: the attempt claims the booking and checks everything again. A database error fails the job, which
// BullMQ retries with the defaults of ADR-0009; Amadeus failures never do (they are recorded on the booking).
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import {
  jobTenant,
  minuteBucket,
  parseTenantJobData,
  TenantJob,
  type TenantJobHandler,
  type TenantJobOutcome,
} from "../jobs/fan-out";
import { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import { TicketingRepository, TicketingService, type TicketingOutcome } from "./ticketing.service";

/** The job of `ota-ticketing` (architecture §6). */
export const TICKETING_ISSUE_JOB = "ticketing.issue";

/** The schedule of the scan (jobs/schedulers.ts) and the name of its per-tenant jobs. */
export const TICKETING_SCAN_JOB = "ticketing.scan";

/** The tenant statuses whose bookings are ticketed (OADR-0008 point 8, OADR-0014 point 4). */
export const TICKETING_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** Bookings one scan job enqueues per tenant at most; the next run (5 minutes later) takes the rest. */
export const TICKETING_SCAN_BATCH = 100;

/** A tenant id as the platform writes it (`ten_` and a ULID). */
const TENANT_ID = /^ten_[0-9A-Za-z]{1,60}$/;

/** A booking id (`bkg_` and a ULID). */
const BOOKING_ID = /^bkg_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The payload of `ticketing.issue`: the tenant and the booking, nothing else (ADR-0009). */
export interface TicketingJobData {
  readonly tenantId: string;
  readonly bookingId: string;
}

/** The payload of a `ticketing.issue` job, or `undefined` when it is not one (extra fields included). */
export function parseTicketingJobData(data: unknown): TicketingJobData | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data) || Object.keys(data).length !== 2) {
    return undefined;
  }
  const { tenantId, bookingId } = data as Record<string, unknown>;
  return typeof tenantId === "string" &&
    TENANT_ID.test(tenantId) &&
    typeof bookingId === "string" &&
    BOOKING_ID.test(bookingId)
    ? { tenantId, bookingId }
    : undefined;
}

/** The id of the `ticketing.issue` job a scan of minute `bucket` adds for a booking. */
export function ticketingJobId(bookingId: string, bucket: number): string {
  return `${TICKETING_ISSUE_JOB}:${bookingId}:${bucket}`;
}

/** The `ticketing.issue` job of a booking, as `Queue.add`/`addBulk` take it. */
export function ticketingJob(
  tenantId: string,
  bookingId: string,
  bucket: number,
): { readonly name: string; readonly data: TicketingJobData; readonly opts: { readonly jobId: string } } {
  return {
    name: TICKETING_ISSUE_JOB,
    data: { tenantId, bookingId },
    opts: { jobId: ticketingJobId(bookingId, bucket) },
  };
}

/** A request id (REQUEST_ID_PATTERN of @velexis/logger) for a job: its id with every other character as `.`. */
export function jobRequestId(job: Pick<Job, "id" | "name">): string {
  const id = String(job.id ?? job.name)
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .slice(0, 128);
  return id.length >= 8 ? id : `job.${id}`.padEnd(8, ".");
}

/** What a finished `ticketing.issue` job returns (BullMQ keeps it with the job). */
export type TicketingJobResult =
  | ({ readonly tenantId: string; readonly bookingId: string } & TicketingOutcome)
  | {
      readonly tenantId: string;
      readonly bookingId: string;
      readonly outcome: "tenant_skipped";
      readonly reason: string;
    };

/**
 * The consumer of `ota-ticketing` (architecture §6, concurrency 2): `ticketing.issue {tenantId, bookingId}` runs one
 * issuance attempt (see the file header); any other job fails at once.
 */
@Processor(OTA_QUEUE.ticketing, otaWorkerOptions(OTA_QUEUE.ticketing))
export class TicketingProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly ticketing: TicketingService,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    @InjectPinoLogger(TicketingProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<TicketingJobResult> {
    const data = job.name === TICKETING_ISSUE_JOB ? parseTicketingJobData(job.data) : undefined;
    if (data === undefined) {
      this.logger.error(
        { queue: job.queueName, jobId: job.id, jobName: String(job.name).slice(0, 64) },
        "bookings.ticketing_job_invalid",
      );
      throw new UnrecoverableError("the job is not ticketing.issue {tenantId, bookingId}");
    }
    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !TICKETING_TENANT_STATUSES.includes(tenant.status)) {
      const reason = tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`;
      this.logger.debug({ tenantId: data.tenantId, reason }, "bookings.ticketing_tenant_skipped");
      return { ...data, outcome: "tenant_skipped", reason };
    }
    const requestId = jobRequestId(job);
    const outcome = await this.tenants.run({ ...jobTenant(tenant, job), requestId }, () =>
      this.ticketing.attempt(tenant, data.bookingId, requestId),
    );
    return { ...data, ...outcome };
  }

  /** A job failed: logged with its id and attempt and the error's name, never the error (it may quote SQL). */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      { queue: OTA_QUEUE.ticketing, jobId: job?.id, attempt: job?.attemptsMade, code: error.name },
      "bookings.ticketing_job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections); job failures are the `failed` events above. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: OTA_QUEUE.ticketing, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}

/**
 * `ticketing.scan` for one tenant (every 5 minutes, fanned out by jobs/fan-out.ts): enqueues `ticketing.issue` for
 * each booking whose issuance is due (see the file header).
 */
@Injectable()
@TenantJob(TICKETING_SCAN_JOB)
export class TicketingScan implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: TicketingRepository,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.ticketing) private readonly queue: Queue,
  ) {}

  async run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome> {
    const now = this.clock.now();
    const due = await this.tx.run((trx) =>
      this.repository.dueBookingIds(trx, {
        now,
        paidOnly: tenant.status === "suspended",
        limit: TICKETING_SCAN_BATCH,
      }),
    );
    if (due.length > 0) {
      // The runner validated the payload; the bucket of the fan-out makes the ids of this run's jobs.
      const bucket = parseTenantJobData(job.data)?.bucket ?? minuteBucket(now);
      await this.queue.addBulk(due.map((bookingId) => ticketingJob(tenant.id, bookingId, bucket)));
    }
    return { more: false, counts: { due: due.length } };
  }
}
