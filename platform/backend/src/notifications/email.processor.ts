// The consumer of `platform-emails` (PBE-011; PADR-0013 items 2 to 4, ADR-0017, ADR-0009). It runs in the worker only
// (WorkerModule imports `NotificationsModule.forWorker()`), with the queue's concurrency of 4 and the retention of
// ADR-0009. Two jobs:
//
// `email.send {emailId}` sends one outbox e-mail:
//   1. claim the row: `pending` (or `sending`, when a worker stopped during an earlier attempt) becomes `sending` with
//      one more attempt; a row that is missing or final already is skipped, so a job that runs twice sends once;
//   2. decrypt the secret variables, check every variable against the template's allow-list and render the subject,
//      HTML and text in strict mode (templates.ts);
//   3. send through SMTP (mailer.gateway.ts), outside any transaction;
//   4. mark the row `sent`, with `sent_at` and the Message-ID, and erase the ciphertext in the same update.
//   An SMTP failure puts the row back to `pending` with `last_error`, and BullMQ tries again (5 attempts, exponential
//   backoff from 30 s); the last attempt marks it `failed` and erases the ciphertext. An e-mail that can never be sent
//   (unknown template, variables outside the allow-list, a ciphertext that does not decrypt, an invalid recipient)
//   becomes `failed` at once and its job fails with `UnrecoverableError`.
//
// `email.sweep` (every minute, a job scheduler of this queue registered when the worker starts) enqueues
// `email.send` for every `pending` row older than 2 minutes, and every `sending` row unchanged for 10 minutes, whose
// BullMQ job is missing or finished: a lost enqueue (Redis down at the commit) only delays an e-mail.
//
// Log lines carry the e-mail id, the template, the attempt and the SMTP error code; never the recipient, a variable or
// the rendered message.
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { EnvelopeService } from "../common/crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { PLATFORM_QUEUE, platformWorkerOptions } from "../common/queues/queue-names";
import type { PlatformBackendConfig } from "../config";
import { MailerError, MailerGateway } from "./mailer.gateway";
import { OutboxRepository, type EmailOutboxRow } from "./outbox.repository";
import { EMAIL_SEND_JOB, publicBase, secretPayloadPlace, type EmailSendJobData } from "./outbox.service";
import { EmailTemplates, isEmailTemplateKey, type BuiltInVariables, type RenderedEmail } from "./templates";

/** The name of the sweep job, and the id of its job scheduler. */
export const EMAIL_SWEEP_JOB = "email.sweep";

/** How often the sweep runs (PADR-0013 item 2: every minute). */
export const EMAIL_SWEEP_EVERY_MS = 60_000;

/** A `pending` row older than this whose job is missing is enqueued again (PADR-0013 item 2). */
export const SWEEP_PENDING_AGE_MS = 2 * 60_000;

/**
 * A `sending` row unchanged for this long belongs to a worker that stopped during the send: an attempt takes at most
 * the SMTP timeouts of mailer.gateway.ts (well under a minute).
 */
export const SWEEP_SENDING_AGE_MS = 10 * 60_000;

/** The most rows one sweep enqueues; the next sweep takes the rest. */
export const SWEEP_BATCH_SIZE = 100;

/** The states in which a BullMQ job will still run: the sweep leaves its row to it. */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "delayed",
  "active",
  "prioritized",
  "waiting-children",
]);

/** The e-mail ids the platform generates (`IdGenerator`) or derives (`idempotentEmailId`). */
const EMAIL_ID = /^eml_[0-9A-HJKMNP-TV-Z]{26}$/;

/** What a finished `email.send` job returns (BullMQ keeps it with the job): never the recipient or a variable. */
export interface EmailSendResult {
  readonly emailId: string;
  /** `sent`, or `skipped` when the row was missing or final already. */
  readonly status: "sent" | "skipped";
}

/** What a finished `email.sweep` job returns. */
export interface EmailSweepResult {
  readonly enqueued: number;
}

/** The parts of a BullMQ job that say whether BullMQ tries it again after a failure. */
export type JobTries = Pick<Job, "attemptsMade"> & { readonly opts: Pick<Job["opts"], "attempts"> };

/**
 * True when this is the job's last try: BullMQ moves a failed job to `failed` instead of retrying it once
 * `attemptsMade + 1` reaches `opts.attempts` (a job without `attempts` has one try).
 */
export function isLastTry(job: JobTries): boolean {
  return job.attemptsMade + 1 >= Math.max(1, job.opts.attempts ?? 1);
}

/** The e-mail id of an `email.send` payload, or `undefined` when the payload is not `{ emailId: "eml_…" }`. */
export function emailIdOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const keys = Object.keys(data);
  const emailId = (data as Partial<EmailSendJobData>).emailId;
  return keys.length === 1 && typeof emailId === "string" && EMAIL_ID.test(emailId) ? emailId : undefined;
}

/** An e-mail that can never be sent: the processor marks it `failed` at once. */
class UnsendableEmailError extends Error {
  override readonly name = "UnsendableEmailError";
}

/** The name of an error, for `last_error` and log lines: never its message, which might quote a value. */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

@Processor(PLATFORM_QUEUE.emails, platformWorkerOptions(PLATFORM_QUEUE.emails))
export class EmailProcessor extends WorkerHost {
  private readonly builtIns: BuiltInVariables;
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly envelope: EnvelopeService,
    private readonly templates: EmailTemplates,
    private readonly mailer: MailerGateway,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectQueue(PLATFORM_QUEUE.emails) private readonly queue: Queue,
    @InjectPinoLogger(EmailProcessor.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    super();
    this.builtIns = {
      portalUrl: publicBase(config.get("PUBLIC_PORTAL_URL", { infer: true })),
      adminUrl: publicBase(config.get("PUBLIC_PLATFORM_ADMIN_URL", { infer: true })),
    };
  }

  async process(job: Job): Promise<EmailSendResult | EmailSweepResult> {
    switch (job.name) {
      case EMAIL_SEND_JOB:
        return this.send(job);
      case EMAIL_SWEEP_JOB:
        return this.sweep();
      default:
        this.logger.error({ queue: PLATFORM_QUEUE.emails, job: job.name }, "email.unknown_job");
        throw new UnrecoverableError("platform-emails has no job of this name");
    }
  }

  /** Errors of the worker itself (its Redis connections); job failures are logged by `send`. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: PLATFORM_QUEUE.emails, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }

  /** One attempt of `email.send` (see the file header). */
  async send(job: Job): Promise<EmailSendResult> {
    const emailId = emailIdOf(job.data);
    if (emailId === undefined) {
      this.logger.error({ queue: PLATFORM_QUEUE.emails, job: job.name }, "email.invalid_job");
      throw new UnrecoverableError("email.send needs { emailId: eml_… } and nothing else");
    }
    const row = await this.repository.claim(this.db, emailId, this.clock.now());
    if (row === undefined) {
      this.logger.info({ emailId }, "email.skipped");
      return { emailId, status: "skipped" };
    }
    const context = { emailId, template: row.template, attempt: row.attempts };

    let rendered: RenderedEmail;
    try {
      rendered = await this.render(row);
    } catch (error) {
      const reason = errorName(error);
      await this.repository.markFailed(this.db, emailId, reason, this.clock.now());
      this.logger.error({ ...context, final: true, error: reason }, "email.render_failed");
      throw new UnrecoverableError(`E-mail ${emailId} cannot be rendered (${reason})`);
    }

    try {
      const sent = await this.mailer.send({ emailId, to: row.to_email, ...rendered });
      await this.repository.markSent(this.db, emailId, sent.messageId, this.clock.now());
    } catch (error) {
      if (!(error instanceof MailerError)) {
        // The database failed after the send: BullMQ tries again and the row, still `sending`, is sent again.
        throw error;
      }
      const final = isLastTry(job) || error.failure.code === "EINVALIDRECIPIENT";
      if (final) {
        await this.repository.markFailed(this.db, emailId, error.message, this.clock.now());
        this.logger.error({ ...context, final, error: error.message }, "email.send_failed");
        throw new UnrecoverableError(`E-mail ${emailId} failed: ${error.message}`);
      }
      await this.repository.release(this.db, emailId, error.message, this.clock.now());
      this.logger.warn({ ...context, final, error: error.message }, "email.send_failed");
      throw error;
    }
    this.logger.info(context, "email.sent");
    return { emailId, status: "sent" };
  }

  /**
   * One run of `email.sweep`: enqueues `email.send` for the rows of `sweepCandidates` whose job is missing or finished
   * (a finished job of a row that is not final is removed first). Logs `email.sweep` when it enqueued any.
   */
  async sweep(): Promise<EmailSweepResult> {
    const now = this.clock.now().getTime();
    const ids = await this.repository.sweepCandidates(this.db, {
      pendingBefore: new Date(now - SWEEP_PENDING_AGE_MS),
      sendingBefore: new Date(now - SWEEP_SENDING_AGE_MS),
      limit: SWEEP_BATCH_SIZE,
    });
    let enqueued = 0;
    for (const emailId of ids) {
      const existing = await this.queue.getJob(emailId);
      if (existing !== undefined) {
        if (LIVE_JOB_STATES.has(await existing.getState())) {
          continue;
        }
        await existing.remove();
      }
      const data: EmailSendJobData = { emailId };
      await this.queue.add(EMAIL_SEND_JOB, data, { jobId: emailId });
      enqueued += 1;
    }
    if (enqueued > 0) {
      this.logger.info({ enqueued }, "email.sweep");
    }
    return { enqueued };
  }

  /** Decrypts the secret variables of `row` and renders its template; throws when it can never be rendered. */
  private async render(row: EmailOutboxRow): Promise<RenderedEmail> {
    const key: string = row.template;
    if (!isEmailTemplateKey(key)) {
      throw new UnsendableEmailError("The template key is not one of EMAIL_TEMPLATE_KEYS");
    }
    const data: unknown = row.data;
    if (!isRecord(data)) {
      throw new UnsendableEmailError("The stored data is not an object");
    }
    let secretData: Record<string, unknown> = {};
    if (row.secret_payload_ciphertext !== null) {
      const decrypted = await this.envelope.decryptJson(
        row.secret_payload_ciphertext,
        secretPayloadPlace(row.id),
      );
      if (!isRecord(decrypted)) {
        throw new UnsendableEmailError("The secret variables are not an object");
      }
      secretData = decrypted;
    }
    return this.templates.render(key, { data, secretData }, this.builtIns);
  }
}

/** How long a shutting-down worker waits at most for the sweep's registration (Redis down: for ever). */
export const SWEEP_REGISTRATION_SETTLE_MS = 1000;

/**
 * Registers the `email.sweep` job scheduler on `platform-emails` when the worker starts (every minute; its first run
 * is at once, so a restart picks up what a lost enqueue left behind), in the background so the worker starts while
 * Redis is down. Logs `email.sweep_registered` or `email.sweep_registration_failed`.
 */
@Injectable()
export class EmailSweepScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private registration: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectQueue(PLATFORM_QUEUE.emails) private readonly queue: Queue,
    @InjectPinoLogger(EmailSweepScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** Upserts the scheduler `email.sweep`. */
  async register(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EMAIL_SWEEP_JOB,
      { every: EMAIL_SWEEP_EVERY_MS },
      { name: EMAIL_SWEEP_JOB, data: {} },
    );
  }

  onApplicationBootstrap(): void {
    this.registration = this.register().then(
      () => {
        this.logger.info({ everyMs: EMAIL_SWEEP_EVERY_MS }, "email.sweep_registered");
      },
      (error: unknown) => {
        // A shutdown that closes the queue while Redis is still away ends the registration: not worth an error.
        if (!this.stopping) {
          this.logger.error({ err: error }, "email.sweep_registration_failed");
        }
      },
    );
  }

  /** Lets a registration under way finish before the queue closes, for at most SWEEP_REGISTRATION_SETTLE_MS. */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.registration === undefined) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, SWEEP_REGISTRATION_SETTLE_MS);
    });
    try {
      await Promise.race([this.registration, timeout]);
    } finally {
      clearTimeout(timer);
      this.stopping = true;
    }
  }
}
