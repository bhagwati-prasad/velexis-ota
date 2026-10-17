// OutboxService.queue (PBE-011; PADR-0013 items 1, 2 and 7, ADR-0009, ADR-0017): every platform e-mail starts as an
// `email_outbox` row written in the transaction of the business change that causes it, and is sent later by the worker
// (email.processor.ts), so an SMTP outage never fails a sign-up or an invitation:
//
//   await runInTransaction(platformDb, async (trx) => {
//     const account = await accounts.insert(trx, …);
//     await outbox.queue(trx, {
//       templateKey: "auth.verify_email",
//       to: account.email,
//       accountId: account.id,
//       data: { fullName: account.fullName },
//       secretData: { verifyUrl: outbox.portalLink("/verify-email", { token }) },
//     });
//   });
//
// - The variables are checked against the template's allow-list (templates.ts) and every link (`…Url`) must start with
//   PUBLIC_PORTAL_URL or PUBLIC_PLATFORM_ADMIN_URL (PADR-0013 item 7); a bad call throws inside the transaction, so
//   the business change rolls back with it.
// - `secretData` (links with tokens) is envelope-encrypted into `secret_payload_ciphertext` with the associated data
//   `platform.email_outbox.secret_payload_ciphertext:<id>`; it is never stored in clear, logged or queued.
// - After the commit, the job `email.send {emailId}` goes to `platform-emails` with the e-mail id as the BullMQ job id:
//   the only field of the message (ADR-0009). Redis down does not fail the caller: the enqueue gives up after
//   ENQUEUE_TIMEOUT_MS, and the processor's sweep enqueues every `pending` row older than 2 minutes whose job is
//   missing (PADR-0013 item 2).
// - With an `idempotencyKey`, the e-mail's id is derived from the template, the recipient and the key, so queuing the
//   same e-mail again (a retried job, a redelivered event) finds the row and queues nothing, also in two concurrent
//   transactions (the primary key). Rows are deleted 30 days after they were sent (PADR-0013 item 8); the key holds
//   as long as its row exists.
import { createHash } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { EnvelopeService, type CiphertextPlace } from "../common/crypto.provider";
import { IdGenerator } from "../common/ids";
import { PLATFORM_QUEUE } from "../common/queues/queue-names";
import { afterCommit } from "../common/redis/invalidation.publisher";
import { EMAIL_ADDRESS, type PlatformBackendConfig } from "../config";
import { OutboxRepository, type OutboxTransaction } from "./outbox.repository";
import {
  checkEmailVariables,
  EMAIL_TEMPLATES,
  isEmailTemplateKey,
  isLinkVariable,
  type EmailTemplateKey,
} from "./templates";

/** The name of the job that sends one e-mail. */
export const EMAIL_SEND_JOB = "email.send";

/** The payload of `email.send`: the e-mail's id, nothing else (ADR-0009). */
export interface EmailSendJobData {
  readonly emailId: string;
}

/** The place of an e-mail's secret variables, for the envelope's associated data. */
export function secretPayloadPlace(emailId: string): CiphertextPlace {
  return { table: "email_outbox", column: "secret_payload_ciphertext", rowId: emailId };
}

/** How long the enqueue after the commit may take before the sweep is left to do it. */
export const ENQUEUE_TIMEOUT_MS = 2000;

/** The longest idempotency key, in characters. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** One e-mail to queue. */
export interface QueueEmailInput {
  readonly templateKey: EmailTemplateKey;
  /** One plain e-mail address (EMAIL_ADDRESS). */
  readonly to: string;
  /** The recipient's account, when there is one. */
  readonly accountId?: string;
  /** The OTA the e-mail is about. */
  readonly tenantId?: string;
  /** Exactly the template's non-secret variables, as strings. */
  readonly data: Readonly<Record<string, string>>;
  /** Exactly the template's secret variables (links with tokens), as strings; none for most templates. */
  readonly secretData?: Readonly<Record<string, string>>;
  /** Queue this e-mail (template and recipient) at most once for this key, e.g. `job_…` for `tenant.welcome`. */
  readonly idempotencyKey?: string;
}

/** An `ops.alert` e-mail to OPS_ALERT_EMAIL. */
export interface OpsAlertInput {
  /** One line, e.g. `Fewer than 3 test offices are available`. */
  readonly title: string;
  /** What happened and what to do, as plain text. */
  readonly message: string;
  /** The OTA the alert is about. */
  readonly tenantId?: string;
  readonly idempotencyKey?: string;
}

/** What `queue` did. */
export interface QueuedEmail {
  readonly emailId: string;
  /** False when an e-mail with the same idempotency key was queued before: nothing was queued now. */
  readonly queued: boolean;
}

/** A call of `queue` that can never give an e-mail: a programming error, so the caller's transaction rolls back. */
export class InvalidEmailError extends Error {
  override readonly name = "InvalidEmailError";
}

/** Crockford's base32, as ULIDs use it. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The id of an e-mail queued with an idempotency key: `eml_` and 26 Crockford base32 characters of the SHA-256 of the
 * template, the lower-cased recipient and the key (128 bits, encoded as a ULID encodes its 128 bits).
 */
export function idempotentEmailId(templateKey: string, to: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(["email_outbox", templateKey, to.toLowerCase(), idempotencyKey].join("\u0000"), "utf8")
    .digest();
  let value = 0n;
  for (const byte of digest.subarray(0, 16)) {
    value = (value << 8n) | BigInt(byte);
  }
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = `${CROCKFORD[Number(value & 31n)] ?? "0"}${encoded}`;
    value >>= 5n;
  }
  return `eml_${encoded}`;
}

/** A path of a link: segments of letters, digits and `._~-` after single slashes; no query, no fragment. */
const LINK_PATH = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/;

/** A public base URL without its trailing slash, query or fragment: `https://platform.example.com`. */
export function publicBase(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * Queues the platform's e-mails in the caller's transaction (see the file header). NotificationsModule provides it to
 * the API and the worker.
 */
@Injectable()
export class OutboxService {
  private readonly portalBase: string;
  private readonly adminBase: string;
  private readonly opsAlertEmail: string;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly envelope: EnvelopeService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectQueue(PLATFORM_QUEUE.emails) private readonly emails: Queue,
    @InjectPinoLogger(OutboxService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.portalBase = publicBase(config.get("PUBLIC_PORTAL_URL", { infer: true }));
    this.adminBase = publicBase(config.get("PUBLIC_PLATFORM_ADMIN_URL", { infer: true }));
    this.opsAlertEmail = config.get("OPS_ALERT_EMAIL", { infer: true });
  }

  /** A link into the portal: PUBLIC_PORTAL_URL, `path` and the query, e.g. `/verify-email?token=…`. */
  portalLink(path: string, query: Readonly<Record<string, string>> = {}): string {
    return this.link(this.portalBase, path, query);
  }

  /** A link into the platform admin: PUBLIC_PLATFORM_ADMIN_URL, `path` and the query. */
  adminLink(path: string, query: Readonly<Record<string, string>> = {}): string {
    return this.link(this.adminBase, path, query);
  }

  /**
   * Inserts the e-mail as a `pending` row in `trx`, which must be an open transaction of `runInTransaction`, and
   * enqueues `email.send` after its commit. Throws `InvalidEmailError` (or `EmailVariablesError`) for a call that can
   * never give an e-mail, and `NotInTransactionError` for another transaction.
   */
  async queue(trx: OutboxTransaction, input: QueueEmailInput): Promise<QueuedEmail> {
    const { templateKey } = input;
    this.check(input);
    const now = this.clock.now();
    const emailId =
      input.idempotencyKey === undefined
        ? this.ids.new("eml")
        : idempotentEmailId(templateKey, input.to, input.idempotencyKey);
    const secrets = input.secretData ?? {};
    const encrypted =
      Object.keys(secrets).length === 0
        ? undefined
        : await this.envelope.encryptJson(secrets, secretPayloadPlace(emailId));
    const inserted = await this.repository.insertIfAbsent(trx, {
      id: emailId,
      template: templateKey,
      toEmail: input.to,
      accountId: input.accountId ?? null,
      tenantId: input.tenantId ?? null,
      dataJson: JSON.stringify(input.data),
      secretPayloadCiphertext: encrypted?.ciphertext ?? null,
      encryptionKeyId: encrypted?.kekId ?? null,
      now,
    });
    if (inserted) {
      afterCommit(trx, async () => {
        await this.enqueue(emailId, templateKey);
      });
    }
    return { emailId, queued: inserted };
  }

  /** Queues an `ops.alert` e-mail to OPS_ALERT_EMAIL, as `queue` does. */
  queueOpsAlert(trx: OutboxTransaction, alert: OpsAlertInput): Promise<QueuedEmail> {
    return this.queue(trx, {
      templateKey: "ops.alert",
      to: this.opsAlertEmail,
      data: { title: alert.title, message: alert.message },
      ...(alert.tenantId === undefined ? {} : { tenantId: alert.tenantId }),
      ...(alert.idempotencyKey === undefined ? {} : { idempotencyKey: alert.idempotencyKey }),
    });
  }

  /**
   * Adds `email.send {emailId}` (job id = e-mail id) to `platform-emails`. Never throws: a failure or a Redis that
   * does not answer within ENQUEUE_TIMEOUT_MS is logged (`email.enqueue_failed`, `email.enqueue_timeout`), and the
   * sweep enqueues the row later.
   */
  async enqueue(emailId: string, template: string): Promise<boolean> {
    const data: EmailSendJobData = { emailId };
    let timer: NodeJS.Timeout | undefined;
    const added = this.emails.add(EMAIL_SEND_JOB, data, { jobId: emailId }).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ emailId, template, err: error }, "email.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn({ emailId, template, timeoutMs: ENQUEUE_TIMEOUT_MS }, "email.enqueue_timeout");
        return false;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private link(base: string, path: string, query: Readonly<Record<string, string>>): string {
    if (!LINK_PATH.test(path)) {
      throw new InvalidEmailError("A link path starts with one /, has no empty segment, query or fragment");
    }
    const search = new URLSearchParams(query).toString();
    return `${base}${path}${search === "" ? "" : `?${search}`}`;
  }

  /** True when `value` is a link into the portal or the platform admin. */
  private isPublicLink(value: string): boolean {
    return [this.portalBase, this.adminBase].some(
      (base) =>
        value === base ||
        value.startsWith(`${base}/`) ||
        value.startsWith(`${base}?`) ||
        value.startsWith(`${base}#`),
    );
  }

  /** The checks of `queue`; every message names fields, never values. */
  private check(input: QueueEmailInput): void {
    if (!isEmailTemplateKey(input.templateKey)) {
      throw new InvalidEmailError("The template key is not one of EMAIL_TEMPLATE_KEYS");
    }
    if (typeof input.to !== "string" || !EMAIL_ADDRESS.test(input.to)) {
      throw new InvalidEmailError(
        `E-mail ${input.templateKey}: the recipient is not one plain e-mail address`,
      );
    }
    if (
      input.idempotencyKey !== undefined &&
      (typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.length === 0 ||
        input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
    ) {
      throw new InvalidEmailError(
        `E-mail ${input.templateKey}: the idempotency key must have 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }
    const secretData = input.secretData ?? {};
    checkEmailVariables(input.templateKey, { data: input.data, secretData });
    const template = EMAIL_TEMPLATES[input.templateKey];
    const links = [...template.variables, ...template.secretVariables].filter(isLinkVariable);
    const outside = links.filter((name) => {
      const value = name in secretData ? secretData[name] : input.data[name];
      return typeof value !== "string" || !this.isPublicLink(value);
    });
    if (outside.length > 0) {
      throw new InvalidEmailError(
        `E-mail ${input.templateKey}: the links ${outside.join(", ")} must start with PUBLIC_PORTAL_URL or ` +
          "PUBLIC_PLATFORM_ADMIN_URL",
      );
    }
  }
}
