// `settlements.monthly` (PBE-059; platform/docs/architecture.md §5, `0 5 3 * *` in UTC, registered while
// FEATURE_SETTLEMENTS is on; flows/stripe-payments-account.md §F item 1, PADR-0003 item 2): on day 3 at 05:00 UTC,
// two days after the month ended so late events have arrived, it queues `settlement.generate {periodStart}` for the
// previous calendar month (UTC) of the Clock's now on `platform-settlements` (settlements.processor.ts), for every
// tenant. The schedule is declared with the others in scheduler.registry.ts, which the worker registers when it starts;
// this is its handler, which the one processor of `platform-maintenance` runs (SettlementsModule.forWorker()).
//
// When the job cannot be queued (Redis down or too slow) the run fails, and BullMQ tries it again with the defaults of
// ADR-0009 (5 attempts, backoff from 30 s); a platform admin can queue the month at any time with
// `adminGenerateSettlements`. A job queued twice for one month is harmless: the generation rebuilds the same drafts.
import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { MaintenanceJob, type MaintenanceJobHandler } from "../common/queues/maintenance.processor";
import { previousMonthStart } from "./settlement-generator";
import { SettlementJobs } from "./settlements.processor";

/** The schedule and job name (scheduler.registry.ts). */
export const SETTLEMENTS_MONTHLY_JOB = "settlements.monthly";

/** What a finished run returns (BullMQ keeps it with the job). */
export interface SettlementsMonthlyResult {
  /** The month queued, ISO 8601 (`2026-10-01T00:00:00.000Z`). */
  readonly periodStart: string;
}

/** The job could not be queued: the run fails, and BullMQ tries it again. */
export class SettlementEnqueueError extends Error {
  override readonly name = "SettlementEnqueueError";

  constructor() {
    super("settlement.generate could not be queued on platform-settlements");
  }
}

@Injectable()
@MaintenanceJob(SETTLEMENTS_MONTHLY_JOB)
export class SettlementsMonthlyScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly jobs: SettlementJobs,
    private readonly clock: Clock,
    @InjectPinoLogger(SettlementsMonthlyScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<SettlementsMonthlyResult> {
    const result: SettlementsMonthlyResult = {
      periodStart: previousMonthStart(this.clock.now()).toISOString(),
    };
    if (!(await this.jobs.enqueue({ periodStart: result.periodStart }))) {
      throw new SettlementEnqueueError();
    }
    this.logger.info({ ...result }, "settlements.monthly_queued");
    return result;
  }
}
