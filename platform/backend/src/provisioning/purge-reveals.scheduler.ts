// `provisioning.purge_reveals` (PBE-023; platform/docs/architecture.md §5, hourly at minute 35; flows/provisioning.md
// §4, PADR-0005): the test keys a provisioning issued wait, envelope-encrypted in `provisioning_jobs.reveal_ciphertext`,
// for one reveal by an owner (`revealInitialKeys`) during REVEAL_WINDOW_MS after the job finished. This job erases the
// ciphertext (and its KEK id) of every job that finished at least that long ago and was never revealed, so the raw
// keys exist nowhere any more; `revealInitialKeys` answers `410 KEYS_ALREADY_REVEALED` from the end of the window on,
// whether or not this job has run yet, and owners create new keys on the API keys page. The keys themselves stay
// valid: only the one copy that could still be shown goes.
//
// One UPDATE per run; a database failure fails the job and BullMQ tries again (ADR-0009 defaults). The run logs
// `provisioning.reveals_purged` with the count when it erased any, never a key or a ciphertext.
import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { MaintenanceJob, type MaintenanceJobHandler } from "../common/queues/maintenance.processor";
import { ProvisioningJobsRepository } from "./provisioning-jobs.repository";

/** The schedule and job name (scheduler.registry.ts). */
export const PURGE_REVEALS_JOB = "provisioning.purge_reveals";

/** How long after its job finished the initial keys can be revealed: 24 hours. */
export const REVEAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What a finished run returns (BullMQ keeps it with the job): the count only. */
export interface PurgeRevealsResult {
  readonly purged: number;
}

@Injectable()
@MaintenanceJob(PURGE_REVEALS_JOB)
export class PurgeRevealsScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly jobs: ProvisioningJobsRepository,
    private readonly clock: Clock,
    @InjectPinoLogger(PurgeRevealsScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<PurgeRevealsResult> {
    const now = this.clock.now();
    const purged = await this.jobs.purgeReveals(new Date(now.getTime() - REVEAL_WINDOW_MS), now);
    const result: PurgeRevealsResult = { purged: purged.length };
    if (purged.length > 0) {
      this.logger.info({ ...result, jobIds: purged }, "provisioning.reveals_purged");
    }
    return result;
  }
}
