// `queues.poll` (OBE-065; ota/docs/architecture.md §6, OADR-0014 points 1, 2, 4 and 5, db README §6 "Queue poller",
// flows/console-operations.md §2 "Queues"): every 15 minutes, per active tenant (jobs/schedulers.ts fans it out; a
// suspended tenant is skipped there and again by the job runner, as a Queue List read starts new supplier activity),
// one job reads the tenant's monitored queues and stores one `queue_snapshots` row per queue, `fetched_by_staff_id`
// null: the history console.queues.listSnapshots shows next to the staff's own reads.
//
//   platform.supplier_connections.monitored_queues  [{officeId, queueId, category}] per environment, from the portal
//     (PlatformReadRepository.monitoredQueues, read once per job: well-formed entries only, at most 20 per connection)
//   → the queues of the `active` connections, test before live, in the platform's order; another connection's queues
//     are not read (the connection resolver would answer 424) and are counted as `inactive`
//   → JOB_BATCH_LIMITS.queuePoll (5) of them per job, from where the previous job of the run stopped (the job's
//     `continuation`): a tenant with more asks the runner for the next job (fan-out.ts), so an Amadeus outage never
//     holds one of `ota-maintenance`'s two workers for long
//   → for each: a queue the poller already stored for this iteration (a retried job, a second run of the iteration;
//     known by its snapshot's supplier request, whose operation is the poller's: a staff member's or a key's read of
//     the queue does not count) is not read again; otherwise one Queue List read through the worker's Amadeus client
//     (`max` 500, the reconciliation's and the console's largest; operation `queues.poll`, which the call's
//     `supplier_requests` row carries), with no transaction open, then the snapshot in a short transaction of its own.
//
// A failed read (an office the connection does not hold, `403 OFFICE_NOT_ALLOWED`, refused by the client before any
// call; a rate limit, a timeout, an Amadeus error; an answer that is not a list of PNRs) stores nothing, is logged with
// its code and counted as `failed`, and the job goes on with the next queue: the next iteration reads it again in 15
// minutes, and a failure never makes BullMQ repeat the reads that succeeded. A connection the resolver refuses (`424
// SUPPLIER_NOT_CONFIGURED`) is not asked again in the job. A connection whose read timed out or found Amadeus
// unavailable (`504 SUPPLIER_TIMEOUT`, `503 SUPPLIER_UNAVAILABLE`, after the client's own retry of a read) is not asked
// again in the job either (FIX-W32-OTA, lead decision (1g) of 2026-10-28): its remaining queues of the batch are
// skipped, counted as `skipped` and logged once per connection (`queues.poll_skipped`, with the code and the count), so
// an Amadeus outage costs one read per connection and job, not one per queue; the next iteration (or the next job of
// the run, for the queues of a later batch) tries them again. Log lines carry ids, offices, queue numbers, codes and
// counts, never a name of a PNR.
import { Injectable } from "@nestjs/common";
import { isAppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import type { Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import { jobRequestId } from "../bookings/ticketing.processor";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { parseTenantJobData, TenantJob, type TenantJobHandler, type TenantJobOutcome } from "../jobs/fan-out";
import { JOB_BATCH_LIMITS } from "../jobs/limits";
import {
  PlatformReadRepository,
  type AmadeusEnvironment,
  type PlatformMonitoredQueues,
} from "../tenancy/platform-read.repository";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx } from "../tenancy/tenant-tx";
import { QueueSnapshotsRepository, type QueueKey } from "./queue-snapshots.repository";
import { QUEUE_POLL_OPERATION, queueEntriesOf } from "./queues.service";

/** The schedule and job name (jobs/schedulers.ts). */
export const QUEUES_POLL_JOB = "queues.poll";

/** `max` of the poller's Queue List reads: the largest the console sends (ConsoleQueueMax) and the reconciliation's. */
export const QUEUE_POLL_MAX = 500;

const MINUTE_MS = 60_000;

/**
 * The codes of a read after which the job asks the connection nothing more (see the file header): Amadeus did not answer
 * in time, or was unavailable (a network error, a `502`/`503`, its shared quota's `429`).
 */
const OUTAGE_CODES: ReadonlySet<string> = new Set(["SUPPLIER_TIMEOUT", "SUPPLIER_UNAVAILABLE"]);

/** The queues one run reads, in order: those of the `active` connections, and how many it leaves out. */
export function pollTargets(connections: readonly PlatformMonitoredQueues[]): {
  readonly targets: readonly QueueKey[];
  /** Queues of a connection that is not `active`. */
  readonly inactive: number;
  /** Entries of the lists that are not a queue the poller can read. */
  readonly invalid: number;
} {
  const targets: QueueKey[] = [];
  let inactive = 0;
  let invalid = 0;
  const ordered = [...connections].sort(
    (a, b) => environmentRank(a.environment) - environmentRank(b.environment),
  );
  for (const connection of ordered) {
    invalid += connection.invalid;
    if (connection.status !== "active") {
      inactive += connection.queues.length;
      continue;
    }
    for (const queue of connection.queues) {
      targets.push({ environment: connection.environment, ...queue });
    }
  }
  return { targets, inactive, invalid };
}

const environmentRank = (environment: AmadeusEnvironment): number => (environment === "test" ? 0 : 1);

/** What one job did. */
export interface QueuePollCounts extends Readonly<Record<string, number>> {
  /** The queues of the job's batch. */
  readonly queues: number;
  /** Snapshots stored. */
  readonly snapshots: number;
  /** Queues stored for this iteration already (a retried job), not read again. */
  readonly alreadyPolled: number;
  /** Reads that failed, or that were not tried after the connection was refused. */
  readonly failed: number;
  /** Queues not read after a timeout or an unavailable answer of their connection in this job (FIX-W32-OTA). */
  readonly skipped: number;
  /** Queues of connections that are not active (the first job of a run only). */
  readonly inactive: number;
  /** Malformed entries of the monitored lists (the first job of a run only). */
  readonly invalid: number;
}

@Injectable()
@TenantJob(QUEUES_POLL_JOB)
export class QueuePollerProcessor implements TenantJobHandler {
  constructor(
    private readonly platform: PlatformReadRepository,
    private readonly amadeus: AmadeusClient,
    private readonly tx: TenantTx,
    private readonly snapshots: QueueSnapshotsRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(QueuePollerProcessor.name) private readonly logger: PinoLogger,
  ) {}

  /** One batch of the tenant's monitored queues (the runner opened the tenant's context); more asks for the next. */
  async run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome> {
    const data = parseTenantJobData(job.data);
    const continuation = data?.continuation ?? 0;
    // The iteration's minute: a snapshot stored since then is this iteration's (fan-out.ts, the job's bucket).
    const since = data === undefined ? this.clock.now() : new Date(data.bucket * MINUTE_MS);
    const requestId = jobRequestId(job);
    const { targets, inactive, invalid } = pollTargets(await this.platform.monitoredQueues(tenant.id));
    const size = JOB_BATCH_LIMITS.queuePoll;
    const batch = targets.slice(continuation * size, (continuation + 1) * size);
    const refused = new Set<AmadeusEnvironment>();
    // The connections that timed out or were unavailable in this job: the code, and the queues skipped after it.
    const down = new Map<AmadeusEnvironment, { readonly code: string; skipped: number }>();
    let snapshots = 0;
    let alreadyPolled = 0;
    let failed = 0;
    let skipped = 0;
    for (const queue of batch) {
      if (refused.has(queue.environment)) {
        failed += 1;
        continue;
      }
      const outage = down.get(queue.environment);
      if (outage !== undefined) {
        outage.skipped += 1;
        skipped += 1;
        continue;
      }
      if (await this.tx.run((trx) => this.snapshots.polledSince(trx, queue, since, QUEUE_POLL_OPERATION))) {
        alreadyPolled += 1;
        continue;
      }
      const outcome = await this.poll(tenant, queue, requestId);
      if (outcome === "stored") {
        snapshots += 1;
      } else {
        failed += 1;
        if (outcome === "connection_refused") {
          refused.add(queue.environment);
        } else if (outcome !== "failed") {
          down.set(queue.environment, { code: outcome.outage, skipped: 0 });
        }
      }
    }
    for (const [environment, outage] of down) {
      if (outage.skipped > 0) {
        this.logger.warn(
          { tenantId: tenant.id, environment, continuation, code: outage.code, skipped: outage.skipped },
          "queues.poll_skipped",
        );
      }
    }
    const first = continuation === 0;
    const counts: QueuePollCounts = {
      queues: batch.length,
      snapshots,
      alreadyPolled,
      failed,
      skipped,
      inactive: first ? inactive : 0,
      invalid: first ? invalid : 0,
    };
    if (counts.queues > 0 || counts.inactive > 0 || counts.invalid > 0) {
      this.logger.info({ tenantId: tenant.id, continuation, ...counts }, "queues.polled");
    }
    return { more: targets.length > (continuation + 1) * size, counts };
  }

  /** One Queue List read and its snapshot (see the file header). */
  private async poll(
    tenant: PlatformTenant,
    queue: QueueKey,
    requestId: string,
  ): Promise<"stored" | "failed" | "connection_refused" | { readonly outage: string }> {
    const where = {
      tenantId: tenant.id,
      environment: queue.environment,
      officeId: queue.officeId,
      queueId: queue.queueId,
      category: queue.category,
    };
    let reply: Awaited<ReturnType<AmadeusClient["listQueue"]>>;
    try {
      reply = await this.amadeus.listQueue(
        {
          tenantId: tenant.id,
          environment: queue.environment,
          operation: QUEUE_POLL_OPERATION,
          requestId,
        },
        {
          queueId: queue.queueId,
          query: { category: queue.category, officeId: queue.officeId, max: QUEUE_POLL_MAX },
        },
      );
    } catch (error) {
      if (!isAppError(error)) {
        throw error;
      }
      this.logger.warn({ ...where, code: error.code }, "queues.poll_failed");
      if (error.code === "SUPPLIER_NOT_CONFIGURED") {
        return "connection_refused";
      }
      return OUTAGE_CODES.has(error.code) ? { outage: error.code } : "failed";
    }
    const entries = queueEntriesOf(reply.body);
    if (entries === undefined) {
      this.logger.warn(
        { ...where, code: "SUPPLIER_ERROR", supplierRequestId: reply.call.supplierRequestId },
        "queues.poll_failed",
      );
      return "failed";
    }
    const fetchedAt = this.clock.now();
    await this.tx.run((trx) =>
      this.snapshots.insert(trx, {
        id: this.ids.newId("qsn"),
        environment: queue.environment,
        officeId: queue.officeId,
        queueId: queue.queueId,
        category: queue.category,
        maxRequested: QUEUE_POLL_MAX,
        itemCount: entries.length,
        response: redactPayload(reply.body),
        fetchedByStaffId: null,
        supplierRequestId: reply.call.supplierRequestId,
        fetchedAt,
      }),
    );
    return "stored";
  }
}
