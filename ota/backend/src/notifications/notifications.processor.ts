// The consumer of `ota-notifications` and the `notifications.sweep` schedule (OBE-030; OADR-0013 items 1 and 2,
// OADR-0014 points 2, 4, 5 and 6, db README §6 and §8, ADR-0017). They run in the worker only.
//
// `notify {tenantId}` (OutboxService after a commit, the sweep, or the job itself when it filled its batch) drains the
// tenant's outbox, one batch per job:
//   1. resolve the tenant through the platform cache and re-check its status: `active` or `suspended` (a suspended
//      OTA's travellers still get their e-mails, OADR-0014 point 4); any other tenant is skipped;
//   2. claim at most 100 due rows (`FOR UPDATE SKIP LOCKED`, outbox.repository.ts: a 5-minute lease, committed before
//      anything is sent) and read, in the same transaction, the tenant's sender settings and templates, and the
//      attachment plan of the booking e-mails that attach documents (attachments.ts, OBE-055);
//   3. per row, outside any transaction: decrypt the secret values, read the attachments of an `attach` plan, render
//      (renderer.ts, `documents.attached` as the plan decided), send with `From: "<brand name>" <MAIL_FROM address>`
//      and `Reply-To: <support e-mail>` (mailer.gateway.ts);
//   4. per row, in a short transaction fenced by the lease:
//        waiting        → its documents are not ready and the 2 minutes since they were asked for are not over:
//                         `pending` again for ATTACHMENT_RECHECK_MS without an attempt (released, `deferred`);
//        sent           → `sent`, secrets erased in the same update;
//        SMTP failed    → one more attempt; `pending` again after 1, 2, 4 and 8 minutes, `failed` (secrets erased)
//                         after the 5th failed attempt (RETRY_BACKOFF_MS, MAX_ATTEMPTS);
//        cannot render  → `failed` at once (an unknown key, data outside the allow-list, a ciphertext that does not
//                         decrypt, a code default that fails): retrying cannot fix a bug;
//      a failure of the connection to SMTP (down, refused, timed out, bad credentials) ends the batch: the rows not yet
//      tried go back to `pending` for a minute without an attempt, so an outage costs one attempt per row and never
//      ties a worker to 100 timeouts; a batch that runs longer than BATCH_TIME_BUDGET_MS releases the rest the same
//      way, well inside the lease;
//   5. a full batch, or one cut short by the time budget, enqueues the next `notify` at the back of the queue; a batch
//      that deferred e-mails for their documents enqueues a delayed `notify` for the earliest of them (job id
//      `notify:<tenantId>:w<due in ATTACHMENT_RECHECK_MS steps>`, one per tenant and step), so a waiting confirmation
//      goes out seconds after its itinerary is ready instead of at the next sweep.
//
// `notifications.sweep` (every minute, jobs/schedulers.ts) runs per tenant on `ota-maintenance` and enqueues
// `notify {tenantId}` (id `notify:<tenantId>:<minute bucket>`) when the tenant has a due row: e-mails whose enqueue was
// lost (Redis down at the commit), retries that became due, and claims of a worker that stopped.
//
// Log lines carry the notification id, the template, the attempt and the error code; never the recipient, a variable
// or the rendered message.
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { decryptValue, DecryptionError, type KeyProvider } from "@velexis/crypto";
import type { TenantSchema } from "@velexis/db";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import {
  jobTenant,
  parseTenantJobData,
  TenantJob,
  type TenantJobHandler,
  type TenantJobOutcome,
} from "../jobs/fan-out";
import { JOB_BATCH_LIMITS } from "../jobs/limits";
import { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  ATTACHMENT_RECHECK_MS,
  NotificationAttachments,
  waitUntil,
  type AttachmentPlan,
} from "./attachments";
import {
  MailerError,
  MailerGateway,
  SMTP_PROVIDER,
  type EmailAttachment,
  type SentEmail,
} from "./mailer.gateway";
import { OutboxRepository, type Lease, type NotificationRow } from "./outbox.repository";
import {
  NOTIFICATIONS_KEY_PROVIDER,
  NOTIFY_JOB,
  notifyJob,
  secretPayloadAad,
  type NotifyJobData,
} from "./outbox.service";
import {
  NotificationDataError,
  NotificationRenderer,
  type RenderBatch,
  type RenderedNotification,
} from "./renderer";
import { TemplateInvalidError, TemplateMissingError, TemplateRenderError } from "./template.service";

/** The schedule of the sweep (jobs/schedulers.ts) and the name of its per-tenant jobs. */
export const NOTIFICATIONS_SWEEP_JOB = "notifications.sweep";

/** The tenant statuses whose e-mails are sent (OADR-0014 point 4). */
export const NOTIFY_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** Attempts of one e-mail before it is `failed` (OADR-0013 item 2). */
export const MAX_ATTEMPTS = 5;

/** The wait before the next attempt after the first failed one; it doubles after each (1, 2, 4, 8 minutes). */
export const RETRY_BACKOFF_MS = 60_000;

/** How long a claim holds its rows (OADR-0014 point 6: a claim older than 5 minutes counts as abandoned). */
export const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * How long one batch may send before it releases the rest: well inside the lease, leaving room for one more e-mail
 * at the SMTP timeouts (mailer.gateway.ts).
 */
export const BATCH_TIME_BUDGET_MS = 2 * 60_000;

/** The longest `last_error`, in characters. */
export const MAX_ERROR_LENGTH = 500;

/** A tenant id as the platform writes it (`ten_` and a ULID). */
const TENANT_ID = /^ten_[0-9A-Za-z]{1,60}$/;

/** When the attempt after `attempts` failed attempts is due. */
export function nextAttemptAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + RETRY_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/** The payload of a `notify` job, or `undefined` when it is not one (extra fields included). */
export function parseNotifyJobData(data: unknown): NotifyJobData | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data) || Object.keys(data).length !== 1) {
    return undefined;
  }
  const { tenantId } = data as Record<string, unknown>;
  return typeof tenantId === "string" && TENANT_ID.test(tenantId) ? { tenantId } : undefined;
}

/** What one `notify` job did: counts, never more. */
export interface DrainCounts extends Readonly<Record<string, number>> {
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  readonly released: number;
  /** Released without an attempt because their documents were not ready yet (attachments.ts). */
  readonly deferred: number;
}

/** What `drain` did, and whether more is due. */
export interface DrainOutcome {
  readonly counts: DrainCounts;
  /** True when the batch was full or cut short (not by an SMTP failure): the next `notify` follows at once. */
  readonly more: boolean;
  /** When the earliest e-mail deferred for its documents is due again; `undefined` when none was deferred. */
  readonly wakeAt?: Date | undefined;
}

/**
 * The delayed `notify` of a tenant's e-mails deferred until `at` (see the file header): its job id, one per tenant and
 * ATTACHMENT_RECHECK_MS step, and when it runs, the end of the step, so it finds every e-mail due within the step.
 */
export function wakeJob(tenantId: string, at: Date): { readonly jobId: string; readonly runAt: Date } {
  const step = Math.ceil(at.getTime() / ATTACHMENT_RECHECK_MS);
  return { jobId: `${NOTIFY_JOB}:${tenantId}:w${step}`, runAt: new Date(step * ATTACHMENT_RECHECK_MS) };
}

/** What a finished `notify` job returns (BullMQ keeps it with the job). */
export type NotifyResult =
  | {
      readonly tenantId: string;
      readonly outcome: "done";
      readonly counts: DrainCounts;
      readonly continued: boolean;
    }
  | { readonly tenantId: string; readonly outcome: "skipped"; readonly reason: string };

/** How one row ended. */
type RowOutcome = "sent" | "retried" | "failed" | "released" | "deferred" | "lost";

/** A row that cannot be rendered: its error code for `last_error`, or `undefined` for an unexpected error. */
function renderFailureCode(error: unknown): string | undefined {
  if (error instanceof TemplateInvalidError) {
    return "TEMPLATE_INVALID";
  }
  if (error instanceof TemplateRenderError) {
    return "TEMPLATE_RENDER_FAILED";
  }
  if (error instanceof TemplateMissingError) {
    return "TEMPLATE_MISSING";
  }
  if (error instanceof NotificationDataError) {
    return "DATA_INVALID";
  }
  if (error instanceof DecryptionError) {
    return "SECRET_UNREADABLE";
  }
  return undefined;
}

/** `CODE: message` at most MAX_ERROR_LENGTH characters; the messages name templates and variables, never values. */
function errorText(code: string, error: unknown): string {
  const message = error instanceof DecryptionError || !(error instanceof Error) ? "" : error.message;
  const text = message === "" ? code : `${code}: ${message}`;
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/** Drains the outbox of the tenant of the current context, one batch (see the file header). */
@Injectable()
export class OutboxDrainer {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly repository: OutboxRepository,
    private readonly renderer: NotificationRenderer,
    private readonly mailer: MailerGateway,
    private readonly attachments: NotificationAttachments,
    private readonly clock: Clock,
    @Inject(NOTIFICATIONS_KEY_PROVIDER) private readonly keys: KeyProvider,
    @InjectPinoLogger(OutboxDrainer.name) private readonly logger: PinoLogger,
  ) {}

  /** Claims, renders and sends one batch of `tenant`'s due rows, inside the tenant's context. */
  async drain(tenant: Pick<PlatformTenant, "id" | "key" | "name">): Promise<DrainOutcome> {
    const started = this.clock.now();
    const leaseUntil = new Date(started.getTime() + CLAIM_LEASE_MS);
    const limit = JOB_BATCH_LIMITS.notificationOutbox;
    const { rows, batch, plans } = await this.tx.run(async (trx) => {
      const claimed = await this.repository.claimDue(trx, started, leaseUntil, limit);
      if (claimed.length === 0) {
        return { rows: claimed, batch: undefined, plans: new Map<string, AttachmentPlan>() };
      }
      return {
        rows: claimed,
        batch: await this.renderer.prepare(trx, tenant, claimed),
        plans: await this.attachments.plan(trx, claimed, started),
      };
    });
    const counts = { claimed: rows.length, sent: 0, retried: 0, failed: 0, released: 0, deferred: 0 };
    let smtpDown = false;
    let outOfTime = false;
    let wakeAt: Date | undefined;
    for (const row of rows) {
      const lease: Lease = { id: row.id, until: leaseUntil };
      const now = this.clock.now();
      if (!smtpDown && now.getTime() - started.getTime() > BATCH_TIME_BUDGET_MS) {
        outOfTime = true;
      }
      let outcome: RowOutcome;
      if (smtpDown || outOfTime || batch === undefined) {
        // Not tried: due again in a minute after an SMTP failure, at once when the batch ran out of time.
        const due = smtpDown ? nextAttemptAt(now, 1) : now;
        outcome = (await this.tx.run((trx) => this.repository.release(trx, lease, due, now)))
          ? "released"
          : "lost";
      } else {
        const result = await this.sendOne(row, lease, batch, plans.get(row.id));
        outcome = result.outcome;
        smtpDown = result.smtpDown;
        if (result.deferredUntil !== undefined && (wakeAt === undefined || result.deferredUntil < wakeAt)) {
          wakeAt = result.deferredUntil;
        }
      }
      if (outcome === "lost") {
        this.logger.debug({ notificationId: row.id }, "notifications.lease_lost");
      } else {
        counts[outcome] += 1;
      }
    }
    if (counts.claimed > 0) {
      this.logger.info({ tenantId: tenant.id, ...counts }, "notifications.drained");
    }
    return { counts, more: !smtpDown && (rows.length >= limit || outOfTime), wakeAt };
  }

  /**
   * The attachments of a row with an attachment plan (see the file header): the files of an `attach` plan, none for
   * `link`, or when they are not ready, the time the row waits until (`wait`, or files of an `attach` plan that
   * could not be read inside the wait).
   */
  private async attachmentsOf(
    row: NotificationRow,
    plan: AttachmentPlan | undefined,
  ): Promise<{ readonly files: readonly EmailAttachment[] } | { readonly waitUntil: Date }> {
    if (plan === undefined || plan.kind === "link") {
      return { files: [] };
    }
    if (plan.kind === "wait") {
      return { waitUntil: plan.until };
    }
    const files = await this.attachments.load(row.id, plan.documents);
    if (files !== undefined) {
      return { files };
    }
    const until = waitUntil(plan.askedAt, this.clock.now());
    return until === undefined ? { files: [] } : { waitUntil: until };
  }

  /** Renders and sends one claimed row and records the outcome. */
  private async sendOne(
    row: NotificationRow,
    lease: Lease,
    batch: RenderBatch,
    plan: AttachmentPlan | undefined,
  ): Promise<{ readonly outcome: RowOutcome; readonly smtpDown: boolean; readonly deferredUntil?: Date }> {
    const attempt = row.attempts + 1;
    const record = (fn: (trx: TenantTransaction) => Promise<boolean>, outcome: RowOutcome) =>
      this.tx.run(fn).then((changed): RowOutcome => (changed ? outcome : "lost"));

    const attachments = await this.attachmentsOf(row, plan);
    if ("waitUntil" in attachments) {
      // The documents are not ready yet: claimed again later, without an attempt (OADR-0013 item 8).
      const now = this.clock.now();
      const outcome = await record(
        (trx) => this.repository.release(trx, lease, attachments.waitUntil, now),
        "deferred",
      );
      this.logger.debug(
        { notificationId: row.id, template: row.template_key, until: attachments.waitUntil.toISOString() },
        "notifications.waiting_for_documents",
      );
      return { outcome, smtpDown: false, deferredUntil: attachments.waitUntil };
    }
    const files = attachments.files;
    const documentsAttached = files.length > 0;

    let rendered: RenderedNotification;
    try {
      const secrets = await this.secretsOf(row);
      rendered = await batch.render(row, secrets, { documentsAttached });
    } catch (error) {
      const code = renderFailureCode(error);
      const now = this.clock.now();
      if (code === undefined) {
        // Not a known failure of the e-mail itself (a key file that cannot be read, say): an attempt, as SMTP's are.
        const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
        const failed = attempt >= MAX_ATTEMPTS;
        this.logger.error(
          { notificationId: row.id, template: row.template_key, attempt, code: name },
          failed ? "notifications.failed" : "notifications.retry_scheduled",
        );
        const outcome = await record(
          (trx) =>
            failed
              ? this.repository.markFailed(trx, lease, {
                  error: `RENDER_ERROR ${name}`,
                  attempted: true,
                  now,
                })
              : this.repository.markRetry(trx, lease, {
                  error: `RENDER_ERROR ${name}`,
                  nextAttemptAt: nextAttemptAt(now, attempt),
                  now,
                }),
          failed ? "failed" : "retried",
        );
        return { outcome, smtpDown: false };
      }
      this.logger.error({ notificationId: row.id, template: row.template_key, code }, "notifications.failed");
      const outcome = await record(
        (trx) =>
          this.repository.markFailed(trx, lease, { error: errorText(code, error), attempted: false, now }),
        "failed",
      );
      return { outcome, smtpDown: false };
    }

    let sent: SentEmail;
    try {
      sent = await this.mailer.send({
        notificationId: row.id,
        to: row.recipient,
        fromName: batch.brand.name,
        replyTo: batch.sender?.supportEmail ?? null,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: files,
      });
    } catch (error) {
      const failure = error instanceof MailerError ? error : new MailerError({ code: "ESEND" });
      const now = this.clock.now();
      const code = failure.message;
      if (failure.permanent || attempt >= MAX_ATTEMPTS) {
        this.logger.error(
          { notificationId: row.id, template: row.template_key, attempt, code },
          "notifications.failed",
        );
        const outcome = await record(
          (trx) =>
            this.repository.markFailed(trx, lease, {
              error: code,
              attempted: true,
              templateId: rendered.templateId,
              now,
            }),
          "failed",
        );
        return { outcome, smtpDown: failure.transport };
      }
      const due = nextAttemptAt(now, attempt);
      this.logger.warn(
        {
          notificationId: row.id,
          template: row.template_key,
          attempt,
          code,
          nextAttemptAt: due.toISOString(),
        },
        "notifications.retry_scheduled",
      );
      const outcome = await record(
        (trx) => this.repository.markRetry(trx, lease, { error: code, nextAttemptAt: due, now }),
        "retried",
      );
      return { outcome, smtpDown: failure.transport };
    }
    // Recorded outside the send's try: a database error here must not count as a failed send (it was sent).
    const now = this.clock.now();
    const outcome = await record(
      (trx) =>
        this.repository.markSent(trx, lease, {
          subject: rendered.subject,
          templateId: rendered.templateId,
          provider: SMTP_PROVIDER,
          providerMessageId: sent.messageId,
          now,
        }),
      "sent",
    );
    this.logger.info(
      {
        notificationId: row.id,
        template: row.template_key,
        attempt,
        ...(plan === undefined ? {} : { attachments: files.length }),
      },
      "notifications.sent",
    );
    return { outcome, smtpDown: false };
  }

  /** The decrypted secret values of a row (`{}` when it has none). The plaintext buffer is zeroed after use. */
  private async secretsOf(row: NotificationRow): Promise<Readonly<Record<string, string>>> {
    if (row.secret_payload_ciphertext === null) {
      return {};
    }
    const schema: TenantSchema = this.tenants.require().schemaName;
    const plaintext = await decryptValue(row.secret_payload_ciphertext, {
      aad: secretPayloadAad(schema, row.id),
      keys: this.keys,
    });
    try {
      const value: unknown = JSON.parse(plaintext.toString("utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !Object.values(value).every((entry) => typeof entry === "string")
      ) {
        throw new NotificationDataError("The secret values of the e-mail are not a map of strings");
      }
      return value as Record<string, string>;
    } finally {
      plaintext.fill(0);
    }
  }
}

/**
 * The consumer of `ota-notifications` (architecture §6, concurrency 4): `notify {tenantId}` drains that tenant's
 * outbox (see the file header); any other job fails at once.
 */
@Processor(OTA_QUEUE.notifications, otaWorkerOptions(OTA_QUEUE.notifications))
export class NotificationsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly drainer: OutboxDrainer,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.notifications) private readonly queue: Queue,
    @InjectPinoLogger(NotificationsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<NotifyResult> {
    const data = job.name === NOTIFY_JOB ? parseNotifyJobData(job.data) : undefined;
    if (data === undefined) {
      this.logger.error(
        { queue: job.queueName, jobId: job.id, jobName: String(job.name).slice(0, 64) },
        "notifications.job_invalid",
      );
      throw new UnrecoverableError("the job is not notify {tenantId}");
    }
    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !NOTIFY_STATUSES.includes(tenant.status)) {
      const reason = tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`;
      this.logger.debug({ tenantId: data.tenantId, reason }, "notifications.tenant_skipped");
      return { tenantId: data.tenantId, outcome: "skipped", reason };
    }
    const outcome = await this.tenants.run(jobTenant(tenant, job), () => this.drainer.drain(tenant));
    if (outcome.more) {
      const next = notifyJob(tenant.id);
      await this.queue.add(next.name, next.data, next.opts);
    }
    if (outcome.wakeAt !== undefined) {
      // The e-mails waiting for their documents: claimed again when the earliest is due (see the file header).
      const wake = wakeJob(tenant.id, outcome.wakeAt);
      const next = notifyJob(tenant.id, wake.jobId);
      await this.queue.add(next.name, next.data, {
        ...next.opts,
        delay: Math.max(0, wake.runAt.getTime() - this.clock.now().getTime()),
      });
    }
    return { tenantId: tenant.id, outcome: "done", counts: outcome.counts, continued: outcome.more };
  }

  /** A job failed: logged with its id and attempt and the error's name, never the error (it may quote SQL). */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      { queue: OTA_QUEUE.notifications, jobId: job?.id, attempt: job?.attemptsMade, code: error.name },
      "notifications.job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections); job failures are the `failed` events above. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: OTA_QUEUE.notifications, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}

/**
 * `notifications.sweep` for one tenant (every minute, fanned out by jobs/fan-out.ts): enqueues `notify {tenantId}`
 * with the deterministic id `notify:<tenantId>:<minute bucket>` when the tenant has a due row.
 */
@Injectable()
@TenantJob(NOTIFICATIONS_SWEEP_JOB)
export class NotificationsSweep implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: OutboxRepository,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.notifications) private readonly queue: Queue,
  ) {}

  async run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome> {
    const now = this.clock.now();
    const due = await this.tx.run((trx) => this.repository.hasDue(trx, now));
    if (due) {
      // The runner validated the payload; the bucket of the fan-out makes the id of this sweep's notify.
      const bucket = parseTenantJobData(job.data)?.bucket ?? Math.floor(now.getTime() / 60_000);
      const next = notifyJob(tenant.id, `${NOTIFY_JOB}:${tenant.id}:${bucket}`);
      await this.queue.add(next.name, next.data, next.opts);
    }
    return { more: false, counts: { due: due ? 1 : 0 } };
  }
}
