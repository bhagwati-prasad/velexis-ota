// `credentials.sweep` on `platform-connections` (FIX-W38-PLATFORM, lead decision (2f) of 2026-10-31, second batch;
// PADR-0010 items 2 to 4): the follow-up of PBE-052 for a submission whose `credentials.verify` job was lost, so no
// submission waits for ever or keeps its secrets past its verification.
//
// - **Schedule.** One BullMQ job scheduler on `platform-connections`, id and job name `credentials.sweep`, every 5
//   minutes (`every: 300000`, first run at worker start), registered by CredentialsSweepScheduler when the worker
//   starts, in the background, as EmailSweepScheduler registers `email.sweep` on its own queue (PADR-0013 item 2). It
//   is not in PLATFORM_SCHEDULES (those live on `platform-maintenance`), so JobSchedulerRegistry never removes it, and
//   it is registered whatever the switches say: a submission made while `FEATURE_OWN_AMADEUS` or `FEATURE_OWN_STRIPE`
//   was on must still lose its secrets after the switch is turned off. The one processor of the queue
//   (supplier-connections/verification.processor.ts) runs each job with `CredentialsSweep.run()`.
// - **Pending for more than 10 minutes** (`updated_at`, which nothing changes while a submission is `pending`): the
//   enqueue after the commit was lost (Redis down, `credentials.enqueue_failed`), or its job ended before the attempt
//   could start. `credentials.verify {submissionId}` is queued again with the submission id as the job id, so a job
//   that still waits, is delayed or runs is left alone (the submission is its), and two sweeps never queue one twice;
//   a finished job of the id (completed, or failed for good) is removed first, because BullMQ ignores an add whose job
//   id it still keeps.
// - **Verifying for more than 1 hour** (`updated_at`, which every attempt's first step sets: the five attempts and
//   their backoff of 30 s to 240 s take minutes): the job died with the submission `verifying`. It fails with
//   PROVIDER_UNAVAILABLE (`CredentialsVerifyProcessor.failStuck`): both secret columns erased, the kind's `*_rejected`
//   audit row and the submitter's `connection.credentials_failed` e-mail, in one transaction with the row locked and a
//   status guard (still `verifying`, no attempt started since), so a job that finishes at the same time wins or loses
//   cleanly.
//
// At most CREDENTIALS_SWEEP_BATCH_SIZE submissions of each kind per run, oldest first; the next run takes the rest.
// Nothing here decrypts a secret: the sweep reads ids, and its log lines (`credentials.sweep_requeued`,
// `credentials.sweep_failed`, `credentials.sweep`) carry ids, the tenant, kind, environment and counts only. "Now" is
// the injected Clock's time.
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../clock";
import { PLATFORM_QUEUE } from "../queues/queue-names";
import { CredentialSubmissionsRepository } from "./credential-submissions.repository";
import {
  CREDENTIALS_SWEEP_JOB,
  CREDENTIALS_VERIFY_JOB,
  type CredentialsVerifyJobData,
} from "./credential-submissions.service";
import { CredentialsVerifyProcessor } from "./credentials-verify.processor";

/** How often the sweep runs: every 5 minutes. */
export const CREDENTIALS_SWEEP_EVERY_MS = 5 * 60_000;

/** A `pending` submission unchanged for longer than this gets its `credentials.verify` job again. */
export const SWEEP_PENDING_AGE_MS = 10 * 60_000;

/** A `verifying` submission unchanged for longer than this fails with PROVIDER_UNAVAILABLE. */
export const SWEEP_VERIFYING_AGE_MS = 60 * 60_000;

/** The most submissions of each kind (pending, verifying) one run handles; the next run takes the rest. */
export const CREDENTIALS_SWEEP_BATCH_SIZE = 100;

/** The states in which a BullMQ job will still run: the sweep leaves its submission to it. */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "delayed",
  "active",
  "prioritized",
  "waiting-children",
]);

/** What a finished `credentials.sweep` job returns: counts only. */
export interface CredentialsSweepResult {
  /** `credentials.verify` jobs queued again for `pending` submissions. */
  readonly requeued: number;
  /** `verifying` submissions failed with PROVIDER_UNAVAILABLE. */
  readonly failed: number;
}

@Injectable()
export class CredentialsSweep {
  constructor(
    private readonly submissions: CredentialSubmissionsRepository,
    private readonly verify: CredentialsVerifyProcessor,
    private readonly clock: Clock,
    @InjectQueue(PLATFORM_QUEUE.connections) private readonly queue: Queue,
    @InjectPinoLogger(CredentialsSweep.name) private readonly logger: PinoLogger,
  ) {}

  /** One run of `credentials.sweep` (see the file header). */
  async run(): Promise<CredentialsSweepResult> {
    const now = this.clock.now().getTime();
    const pendingBefore = new Date(now - SWEEP_PENDING_AGE_MS);
    const verifyingBefore = new Date(now - SWEEP_VERIFYING_AGE_MS);

    let requeued = 0;
    for (const submissionId of await this.submissions.staleIds(
      "pending",
      pendingBefore,
      CREDENTIALS_SWEEP_BATCH_SIZE,
    )) {
      if (await this.requeue(submissionId)) {
        requeued += 1;
        this.logger.info({ submissionId }, "credentials.sweep_requeued");
      }
    }

    let failed = 0;
    for (const submissionId of await this.submissions.staleIds(
      "verifying",
      verifyingBefore,
      CREDENTIALS_SWEEP_BATCH_SIZE,
    )) {
      const row = await this.verify.failStuck(submissionId, verifyingBefore);
      if (row !== undefined) {
        failed += 1;
        this.logger.warn(
          {
            submissionId,
            tenantId: row.tenant_id,
            kind: row.kind,
            environment: row.environment,
            errorCode: row.error_code,
          },
          "credentials.sweep_failed",
        );
      }
    }

    if (requeued > 0 || failed > 0) {
      this.logger.info({ requeued, failed }, "credentials.sweep");
    }
    return { requeued, failed };
  }

  /**
   * Queues `credentials.verify {submissionId}` again (job id = submission id) unless a job of the id will still run;
   * a finished one is removed first. Answers whether a job was queued.
   */
  private async requeue(submissionId: string): Promise<boolean> {
    const existing = await this.queue.getJob(submissionId);
    if (existing !== undefined) {
      if (LIVE_JOB_STATES.has(await existing.getState())) {
        return false;
      }
      await existing.remove();
    }
    const data: CredentialsVerifyJobData = { submissionId };
    await this.queue.add(CREDENTIALS_VERIFY_JOB, data, { jobId: submissionId });
    return true;
  }
}

/** How long a shutting-down worker waits at most for the sweep's registration (Redis down: for ever). */
export const CREDENTIALS_SWEEP_REGISTRATION_SETTLE_MS = 1000;

/**
 * Registers the `credentials.sweep` job scheduler on `platform-connections` when the worker starts (every 5 minutes;
 * its first run is at once, so a restart picks up what a lost job left behind), in the background so the worker
 * starts while Redis is down. Logs `credentials.sweep_registered` or `credentials.sweep_registration_failed`.
 */
@Injectable()
export class CredentialsSweepScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private registration: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectQueue(PLATFORM_QUEUE.connections) private readonly queue: Queue,
    @InjectPinoLogger(CredentialsSweepScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** Upserts the scheduler `credentials.sweep`: one repeatable job, whatever the number of worker starts. */
  async register(): Promise<void> {
    await this.queue.upsertJobScheduler(
      CREDENTIALS_SWEEP_JOB,
      { every: CREDENTIALS_SWEEP_EVERY_MS },
      { name: CREDENTIALS_SWEEP_JOB, data: {} },
    );
  }

  onApplicationBootstrap(): void {
    this.registration = this.register().then(
      () => {
        this.logger.info({ everyMs: CREDENTIALS_SWEEP_EVERY_MS }, "credentials.sweep_registered");
      },
      (error: unknown) => {
        // A shutdown that closes the queue while Redis is still away ends the registration: not worth an error.
        if (!this.stopping) {
          this.logger.error({ err: error }, "credentials.sweep_registration_failed");
        }
      },
    );
  }

  /** Lets a registration under way finish before the queue closes, for at most CREDENTIALS_SWEEP_REGISTRATION_SETTLE_MS. */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.registration === undefined) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, CREDENTIALS_SWEEP_REGISTRATION_SETTLE_MS);
    });
    try {
      await Promise.race([this.registration, timeout]);
    } finally {
      clearTimeout(timer);
      this.stopping = true;
    }
  }
}
