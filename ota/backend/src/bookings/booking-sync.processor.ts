// The `booking.sync` jobs of `ota-bookings` and the `bookings.sync_scan` schedule (OBE-045; ota/docs/flows/
// ticketing-and-documents.md §3 step 5, OADR-0014 points 1, 2, 4 and 5, OADR-0008 point 8, ota/docs/architecture.md
// §6). They run in the worker only (BookingsWorkerModule).
//
// `bookings.sync_scan` (every 10 minutes, jobs/schedulers.ts) runs per tenant on `ota-maintenance`, for `active` and
// `suspended` tenants (a suspended OTA's paid travellers are kept informed): it lists the bookings due for a sync
// (booking-sync.service.ts, BookingSyncRepository.dueBookingIds: active, with an order, the trip not over, not synced
// for 6 hours, or for 1 hour in the 24 hours before the ticketing deadline of one that waits for tickets, nor claimed
// for 30 minutes; for a suspended tenant only paid ones), at most BOOKING_SYNC_SCAN_BATCH (20, OADR-0014 point 2), the
// oldest synced first, and enqueues `booking.sync {tenantId, bookingId}` on `ota-bookings` for
// each, with the deterministic id `booking.sync:<bkg_…>:<minute bucket>`, so two runs of one scheduler iteration add
// each booking once, and the BullMQ priority BOOKING_SYNC_PRIORITY: BullMQ takes a queue's jobs without a priority
// first, so the reconciliation's `booking.reconcile` jobs, which decide the money of pending bookings within minutes,
// never wait behind a tenant's syncs. It never continues itself: the next run, 10 minutes later, takes the next oldest
// (a claimed booking is no longer due).
//
// `booking.sync {tenantId, bookingId}`: `ota-bookings` has one consumer per process, reconcile.processor.ts's
// ReconcileProcessor (BullMQ hands any job of a queue to any of its workers), which hands the jobs named
// `booking.sync` to BookingSyncJobs here. The payload is checked (exactly the two ids, else the job fails at once with
// `UnrecoverableError`), the tenant is resolved through the platform cache and skipped unless it is `active` or
// `suspended`, and BookingSyncService.attempt runs in the tenant's job context. The job trusts nothing but the two ids:
// the attempt claims the booking and checks everything again. A database error fails the job, which BullMQ retries with
// the defaults of ADR-0009 (a retry after the claim was committed finds it and stands back: the booking is due again
// 30 minutes after its claim); Amadeus failures never do (they are recorded on the booking).
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { OTA_QUEUE } from "../common/queues/queue-names";
import {
  jobTenant,
  minuteBucket,
  parseTenantJobData,
  TenantJob,
  type TenantJobHandler,
  type TenantJobOutcome,
} from "../jobs/fan-out";
import { JOB_BATCH_LIMITS } from "../jobs/limits";
import { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import { BookingSyncRepository, BookingSyncService, type BookingSyncOutcome } from "./booking-sync.service";
import { jobRequestId } from "./ticketing.processor";

/** The job of `ota-bookings` that synchronises one booking (architecture §6). */
export const BOOKING_SYNC_JOB = "booking.sync";

/** The schedule of the scan (jobs/schedulers.ts) and the name of its per-tenant jobs. */
export const BOOKINGS_SYNC_SCAN_JOB = "bookings.sync_scan";

/** The tenant statuses whose bookings are synchronised (OADR-0008 point 8, OADR-0014 point 4). */
export const BOOKING_SYNC_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** Bookings one scan job enqueues per tenant at most (OADR-0014 point 2); the next run takes the next oldest. */
export const BOOKING_SYNC_SCAN_BATCH = JOB_BATCH_LIMITS.bookingSync;

/** The BullMQ priority of `booking.sync` jobs: after every job of `ota-bookings` without one (see the file header). */
export const BOOKING_SYNC_PRIORITY = 10;

/** A tenant id as the platform writes it (`ten_` and a ULID). */
const TENANT_ID = /^ten_[0-9A-Za-z]{1,60}$/;

/** A booking id (`bkg_` and a ULID). */
const BOOKING_ID = /^bkg_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The payload of `booking.sync`: the tenant and the booking, nothing else (ADR-0009). */
export interface BookingSyncJobData {
  readonly tenantId: string;
  readonly bookingId: string;
}

/** The payload of a `booking.sync` job, or `undefined` when it is not one (extra fields included). */
export function parseBookingSyncJobData(data: unknown): BookingSyncJobData | undefined {
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

/** The id of the `booking.sync` job a scan of minute `bucket` adds for a booking (three parts, as BullMQ wants). */
export function bookingSyncJobId(bookingId: string, bucket: number): string {
  return `${BOOKING_SYNC_JOB}:${bookingId}:${bucket}`;
}

/** The `booking.sync` job of a booking, as `Queue.add`/`addBulk` take it. */
export function bookingSyncJob(
  tenantId: string,
  bookingId: string,
  bucket: number,
): {
  readonly name: string;
  readonly data: BookingSyncJobData;
  readonly opts: { readonly jobId: string; readonly priority: number };
} {
  return {
    name: BOOKING_SYNC_JOB,
    data: { tenantId, bookingId },
    opts: { jobId: bookingSyncJobId(bookingId, bucket), priority: BOOKING_SYNC_PRIORITY },
  };
}

/** What a finished `booking.sync` job returns (BullMQ keeps it with the job). */
export type BookingSyncJobResult =
  | ({ readonly tenantId: string; readonly bookingId: string } & BookingSyncOutcome)
  | {
      readonly tenantId: string;
      readonly bookingId: string;
      readonly outcome: "tenant_skipped";
      readonly reason: string;
    };

/** Runs the `booking.sync` jobs that the `ota-bookings` consumer (ReconcileProcessor) hands over (see the header). */
@Injectable()
export class BookingSyncJobs {
  constructor(
    private readonly sync: BookingSyncService,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    @InjectPinoLogger(BookingSyncJobs.name) private readonly logger: PinoLogger,
  ) {}

  async process(job: Job): Promise<BookingSyncJobResult> {
    const data = job.name === BOOKING_SYNC_JOB ? parseBookingSyncJobData(job.data) : undefined;
    if (data === undefined) {
      this.logger.error(
        { queue: job.queueName, jobId: job.id, jobName: String(job.name).slice(0, 64) },
        "bookings.sync_job_invalid",
      );
      throw new UnrecoverableError("the job is not booking.sync {tenantId, bookingId}");
    }
    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !BOOKING_SYNC_TENANT_STATUSES.includes(tenant.status)) {
      const reason = tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`;
      this.logger.debug({ tenantId: data.tenantId, reason }, "bookings.sync_tenant_skipped");
      return { ...data, outcome: "tenant_skipped", reason };
    }
    const requestId = jobRequestId(job);
    const outcome = await this.tenants.run({ ...jobTenant(tenant, job), requestId }, () =>
      this.sync.attempt(tenant, data.bookingId, requestId),
    );
    return { ...data, ...outcome };
  }
}

/**
 * `bookings.sync_scan` for one tenant (every 10 minutes, fanned out by jobs/fan-out.ts): enqueues `booking.sync` for
 * the bookings due (see the file header).
 */
@Injectable()
@TenantJob(BOOKINGS_SYNC_SCAN_JOB)
export class BookingSyncScan implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: BookingSyncRepository,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.bookings) private readonly queue: Queue,
  ) {}

  async run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome> {
    const now = this.clock.now();
    const due = await this.tx.run((trx) =>
      this.repository.dueBookingIds(trx, {
        now,
        paidOnly: tenant.status === "suspended",
        limit: BOOKING_SYNC_SCAN_BATCH,
      }),
    );
    if (due.length > 0) {
      // The runner validated the payload; the bucket of the fan-out makes the ids of this run's jobs.
      const bucket = parseTenantJobData(job.data)?.bucket ?? minuteBucket(now);
      await this.queue.addBulk(due.map((bookingId) => bookingSyncJob(tenant.id, bookingId, bucket)));
    }
    return { more: false, counts: { due: due.length } };
  }
}
