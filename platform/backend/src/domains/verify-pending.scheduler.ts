// `domains.verify_pending` (PBE-050; platform/docs/architecture.md §5, every 5 minutes in UTC, registered while
// FEATURE_CUSTOM_DOMAINS is on; flows/custom-domains.md step 2, PADR-0004 item 4): queues one `domain.verify` job on
// `platform-domains` for every `pending` custom domain, oldest deadline first. The job does the checks, stores the
// result, verifies the domain or, past its 72-hour deadline, fails it (domain-checks.processor.ts), so a domain whose
// window ended is failed by the first run after its deadline. The schedule is declared with the others in
// scheduler.registry.ts, which the worker registers when it starts; this is its handler, which the one processor of
// `platform-maintenance` runs (DomainsModule.forWorker()).
//
// Each job id names the domain and the 5-minute slot of the Clock's now when the run (or its retry) starts
// (`domain.verify.<domainId>.<slot>`), so a second try within the same slot adds no second job for a domain queued
// already, and a later run adds a new one. When a job cannot be queued (Redis down or too slow) the run fails after
// trying every domain, and BullMQ tries it again with the defaults of ADR-0009 (5 attempts, backoff from 30 s); a retry
// that falls into the next slot may queue a domain once more, which only costs one more check of it (a job leaves a
// domain that is no longer pending alone), and the next run comes five minutes later anyway.
import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { MaintenanceJob, type MaintenanceJobHandler } from "../common/queues/maintenance.processor";
import { DomainJobs } from "./domain-checks.processor";
import { DomainsRepository } from "./domains.repository";

/** The schedule and job name (scheduler.registry.ts). */
export const DOMAINS_VERIFY_PENDING_JOB = "domains.verify_pending";

/** The length of one run's slot: the schedule's interval. */
export const VERIFY_PENDING_SLOT_MS = 5 * 60 * 1000;

/** The BullMQ job id of a domain's `domain.verify` in the run of `now` (no `:`, which BullMQ refuses in ids). */
export function verifyPendingJobId(domainId: string, now: Date): string {
  return `domain.verify.${domainId}.${Math.floor(now.getTime() / VERIFY_PENDING_SLOT_MS)}`;
}

/** What a finished run returns (BullMQ keeps it with the job): counts only. */
export interface VerifyPendingResult {
  /** The pending custom domains found. */
  readonly pending: number;
  /** The jobs queued (or found queued by an earlier try of the same run). */
  readonly queued: number;
}

/** Some jobs could not be queued: the run fails, and BullMQ tries it again. */
export class DomainVerifyEnqueueError extends Error {
  override readonly name = "DomainVerifyEnqueueError";

  constructor(failed: number, pending: number) {
    super(
      `domain.verify could not be queued for ${failed} of ${pending} pending domains on platform-domains`,
    );
  }
}

@Injectable()
@MaintenanceJob(DOMAINS_VERIFY_PENDING_JOB)
export class VerifyPendingScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly domains: DomainsRepository,
    private readonly jobs: DomainJobs,
    private readonly clock: Clock,
    @InjectPinoLogger(VerifyPendingScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<VerifyPendingResult> {
    const now = this.clock.now();
    const ids = await this.domains.pendingCustomDomainIds();
    let queued = 0;
    for (const domainId of ids) {
      if (await this.jobs.enqueueVerify(domainId, verifyPendingJobId(domainId, now))) {
        queued += 1;
      }
    }
    const result: VerifyPendingResult = { pending: ids.length, queued };
    if (queued < ids.length) {
      throw new DomainVerifyEnqueueError(ids.length - queued, ids.length);
    }
    this.logger.info({ ...result }, "domains.verify_pending_queued");
    return result;
  }
}
