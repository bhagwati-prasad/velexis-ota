// OutboxService.enqueue (OBE-030; OADR-0013 items 1 and 3, ADR-0017, db README §6 and §8): every e-mail of an OTA
// starts as a `notifications` row written in the tenant transaction of the business change that causes it, and the
// worker sends it later (notifications.processor.ts), so an SMTP outage never fails a sign-up or a booking:
//
//   await this.tx.run(async (trx) => {
//     const customer = await this.customers.insert(trx, …);
//     await this.outbox.enqueue(trx, {
//       templateKey: "auth.verify_email",
//       to: customer.email,
//       locale: customer.locale,
//       customerId: customer.id,
//       data: { customer: { firstName: customer.firstName }, expiresAt },
//       secretData: { token },                         // only ever encrypted
//       dedupeKey: `auth.verify_email:${verificationId}`,
//     });
//   });
//
// - The call is checked against the key's allow-list (templates/registry.ts): `data` holds exactly the key's caller
//   variables and `secretData` exactly its secrets; the recipient is one plain address. A bad call throws
//   `InvalidNotificationError` inside the transaction, so the business change rolls back with it.
// - `secretData` (the tokens that only a link built by the renderer holds) is envelope-encrypted into
//   `secret_payload_ciphertext` with the associated data `tenant_<key>.notifications.secret_payload_ciphertext:<id>`
//   (ADR-0010); it is never stored in clear, logged or queued. `payload` is `data` after the shared redactor of
//   `@velexis/logger` (db README §8), which must leave it unchanged: a value it would mask is a secret in the wrong place.
// - A `dedupeKey` (`booking.ticketed:bkg_…:v3`) makes the e-mail once only: a second call with the same key inserts
//   nothing and answers `queued: false` (`notifications_dedupe_uq`).
// - After the commit (`afterCommit` of TenantTx), `notify {tenantId}` goes to `ota-notifications`: the tenant id is
//   the only field of the message (ADR-0009). Redis down does not fail the caller: the enqueue gives up after
//   ENQUEUE_TIMEOUT_MS, and the `notifications.sweep` schedule notices the due row within a minute (OADR-0013 item 1).
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { aadFor, encryptValue, LocalFileKeyProvider, type KeyProvider } from "@velexis/crypto";
import type { TenantSchema } from "@velexis/db";
import { redactPayload } from "@velexis/logger";
import type { JobsOptions, Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { EMAIL_ADDRESS, type SharedConfig } from "../config";
import { TenantContext } from "../tenancy/tenant-context";
import { afterCommit, type TenantTransaction } from "../tenancy/tenant-tx";
import { OutboxRepository, type RecipientType } from "./outbox.repository";
import { checkSecretData, checkTemplateData } from "./renderer";
import { isTemplateKey, TEMPLATE_CHANNEL, TEMPLATE_REGISTRY, type TemplateKey } from "./templates/registry";

/** The name of the job that drains a tenant's outbox. */
export const NOTIFY_JOB = "notify";

/** The payload of `notify`: the tenant, nothing else (ADR-0009). */
export interface NotifyJobData {
  readonly tenantId: string;
}

/** How long the enqueue after the commit may take before the sweep is left to do it. */
export const ENQUEUE_TIMEOUT_MS = 2000;

/** The longest dedupe key, in characters. */
export const MAX_DEDUPE_KEY_LENGTH = 200;

/** A BCP 47 tag as the storefront and the accounts store them: `en`, `en-GB`, `pt-BR`, `zh-Hant-TW`. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** A customer or booking id as the tenant tables hold them. */
const ROW_ID = /^(?:cus|bkg)_[0-9A-Za-z]{1,60}$/;

/** Injection token of the KEKs that seal `secret_payload_ciphertext` (MASTER_KEY_DIR, MASTER_KEY_CURRENT). */
export const NOTIFICATIONS_KEY_PROVIDER = "NOTIFICATIONS_KEY_PROVIDER";

/**
 * The KEKs of MASTER_KEY_DIR, MASTER_KEY_CURRENT wrapping new data keys (ADR-0010, ADR-0026). Nest awaits the factory,
 * so neither process starts without them (a `KeyProviderError` names the file, never its content).
 */
export const notificationsKeyProvider: FactoryProvider<Promise<KeyProvider>> = {
  provide: NOTIFICATIONS_KEY_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<SharedConfig, true>) =>
    LocalFileKeyProvider.fromDir(
      config.get("MASTER_KEY_DIR", { infer: true }),
      config.get("MASTER_KEY_CURRENT", { infer: true }),
    ),
};

/** The table and column of the sealed secrets. */
const SECRET_TABLE = "notifications";
const SECRET_COLUMN = "secret_payload_ciphertext";

/** The associated data of a notification's secret values: `tenant_<key>.notifications.secret_payload_ciphertext:<id>`. */
export function secretPayloadAad(schema: TenantSchema, notificationId: string): string {
  return aadFor(schema, SECRET_TABLE, SECRET_COLUMN, notificationId);
}

/** One e-mail to queue. */
export interface EnqueueNotificationInput {
  readonly templateKey: TemplateKey;
  /** One plain e-mail address (EMAIL_ADDRESS of config.ts). */
  readonly to: string;
  /** The rendering locale (BCP 47), such as the customer's or the storefront's. */
  readonly locale: string;
  /** Exactly the key's caller variables (`callerVariables`): JSON values, never a secret. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Exactly the key's secret values (`TEMPLATE_REGISTRY[key].secrets`); none for most keys. */
  readonly secretData?: Readonly<Record<string, string>> | undefined;
  /** Sends the e-mail once per key, such as `booking.ticketed:bkg_…:v3`; `null` when every call is a new e-mail. */
  readonly dedupeKey: string | null;
  /** Default: `staff` for staff keys, `customer` with a `customerId` or for account keys, else `guest`. */
  readonly recipientType?: RecipientType | undefined;
  readonly customerId?: string | null | undefined;
  readonly bookingId?: string | null | undefined;
}

/** What `enqueue` did. */
export interface EnqueuedNotification {
  /** The `ntf_…` id of the row: the new one, or the one that holds the dedupe key already. */
  readonly notificationId: string;
  /** False when another row holds the dedupe key: nothing was queued now. */
  readonly queued: boolean;
}

/** A call of `enqueue` that can never give an e-mail: a programming error, so the caller's transaction rolls back. */
export class InvalidNotificationError extends Error {
  override readonly name = "InvalidNotificationError";
}

/** The BullMQ job of `notify` for a tenant; `jobId` only for the sweep, whose ids are deterministic. */
export function notifyJob(
  tenantId: string,
  jobId?: string,
): { readonly name: string; readonly data: NotifyJobData; readonly opts: JobsOptions } {
  return { name: NOTIFY_JOB, data: { tenantId }, opts: jobId === undefined ? {} : { jobId } };
}

/** Queues the OTA's e-mails in the caller's transaction (see the file header). */
@Injectable()
export class OutboxService {
  constructor(
    private readonly repository: OutboxRepository,
    private readonly tenants: TenantContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(NOTIFICATIONS_KEY_PROVIDER) private readonly keys: KeyProvider,
    @InjectQueue(OTA_QUEUE.notifications) private readonly queue: Queue,
    @InjectPinoLogger(OutboxService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Inserts the e-mail as a `pending` row in `trx`, an open transaction of `TenantTx.run` for the current tenant, and
   * enqueues `notify {tenantId}` after its commit. Throws `InvalidNotificationError` for a call that can never give an
   * e-mail, and `NotInTenantTransactionError` for another transaction.
   */
  async enqueue(trx: TenantTransaction, input: EnqueueNotificationInput): Promise<EnqueuedNotification> {
    const tenant = this.tenants.require();
    const payload = this.check(input);
    const secrets = input.secretData ?? {};
    const notificationId = this.ids.newId("ntf");
    const sealed =
      Object.keys(secrets).length === 0
        ? undefined
        : await encryptValue(JSON.stringify(secrets), {
            aad: secretPayloadAad(tenant.schemaName, notificationId),
            keys: this.keys,
          });
    const inserted = await this.repository.insert(trx, {
      id: notificationId,
      templateKey: input.templateKey,
      channel: TEMPLATE_CHANNEL,
      recipient: input.to,
      recipientType: this.recipientType(input),
      customerId: input.customerId ?? null,
      bookingId: input.bookingId ?? null,
      locale: input.locale,
      payloadJson: payload,
      secretPayloadCiphertext: sealed?.ciphertext ?? null,
      encryptionKeyId: sealed?.kekId ?? null,
      dedupeKey: input.dedupeKey,
      now: this.clock.now(),
    });
    if (!inserted && input.dedupeKey !== null) {
      const existing = await this.repository.idByDedupeKey(trx, input.dedupeKey);
      return { notificationId: existing ?? notificationId, queued: false };
    }
    const tenantId = tenant.tenantId;
    afterCommit(trx, async () => {
      await this.notify(tenantId);
    });
    this.logger.debug({ notificationId, template: input.templateKey }, "notifications.queued");
    return { notificationId, queued: true };
  }

  /**
   * Adds `notify {tenantId}` to `ota-notifications`. Never throws: a failure, or a Redis that does not answer within
   * ENQUEUE_TIMEOUT_MS, is logged (`notifications.enqueue_failed`, `notifications.enqueue_timeout`), and the sweep
   * enqueues the tenant later.
   */
  async notify(tenantId: string): Promise<boolean> {
    const job = notifyJob(tenantId);
    let timer: NodeJS.Timeout | undefined;
    const added = this.queue.add(job.name, job.data, job.opts).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ tenantId, err: error }, "notifications.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn({ tenantId, timeoutMs: ENQUEUE_TIMEOUT_MS }, "notifications.enqueue_timeout");
        return false;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private recipientType(input: EnqueueNotificationInput): RecipientType {
    if (input.recipientType !== undefined) {
      return input.recipientType;
    }
    const audience = TEMPLATE_REGISTRY[input.templateKey].audience;
    if (audience === "staff") {
      return "staff";
    }
    return audience === "customer" || (input.customerId ?? null) !== null ? "customer" : "guest";
  }

  /** The checks of `enqueue`; returns the payload as JSON text. Every message names fields, never values. */
  private check(input: EnqueueNotificationInput): string {
    if (!isTemplateKey(input.templateKey)) {
      throw new InvalidNotificationError("The template key is not one of TEMPLATE_KEYS");
    }
    const key = input.templateKey;
    if (typeof input.to !== "string" || !EMAIL_ADDRESS.test(input.to)) {
      throw new InvalidNotificationError(`E-mail ${key}: the recipient is not one plain e-mail address`);
    }
    if (typeof input.locale !== "string" || !LOCALE.test(input.locale)) {
      throw new InvalidNotificationError(`E-mail ${key}: the locale is not a BCP 47 tag`);
    }
    if (
      input.dedupeKey !== null &&
      (typeof input.dedupeKey !== "string" ||
        input.dedupeKey.length === 0 ||
        input.dedupeKey.length > MAX_DEDUPE_KEY_LENGTH)
    ) {
      throw new InvalidNotificationError(
        `E-mail ${key}: the dedupe key must have 1 to ${MAX_DEDUPE_KEY_LENGTH} characters`,
      );
    }
    for (const [field, value] of [
      ["customerId", input.customerId],
      ["bookingId", input.bookingId],
    ] as const) {
      if (value !== undefined && value !== null && (typeof value !== "string" || !ROW_ID.test(value))) {
        throw new InvalidNotificationError(`E-mail ${key}: ${field} is not an id`);
      }
    }
    if (input.recipientType !== undefined && !["customer", "guest", "staff"].includes(input.recipientType)) {
      throw new InvalidNotificationError(`E-mail ${key}: the recipient type is not customer, guest or staff`);
    }
    const problems = [...checkTemplateData(key, input.data), ...checkSecretData(key, input.secretData)];
    if (problems.length > 0) {
      throw new InvalidNotificationError(`E-mail ${key}: ${problems.join("; ")}`);
    }
    const payload = JSON.stringify(input.data);
    if (JSON.stringify(redactPayload(input.data)) !== payload) {
      throw new InvalidNotificationError(
        `E-mail ${key}: the data holds a value the redaction rule masks; secrets go in secretData`,
      );
    }
    return payload;
  }
}
