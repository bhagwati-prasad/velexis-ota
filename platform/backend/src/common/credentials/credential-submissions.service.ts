// Credential submissions (PBE-052; PADR-0010, flows/amadeus-connection.md §D, flows/stripe-payments-account.md §D):
// the OTA's own Amadeus credentials or Stripe API keys wait in a submission while a worker job verifies them, so a
// typo never breaks a working connection. This service is the API's side, for the operations that submit (PBE-053
// `submitAmadeusCredentials`, PBE-057 `submitStripeApiKeys`) and for the portal's read (`getCredentialSubmission`):
//
//   await runInTransaction(platformDb, async (trx) => {
//     // the operation's own checks (format, tenant active, …) first
//     const submission = await submissions.submit(trx, {
//       tenantId, kind: "amadeus", environment, publicData: { clientId, officeIds, … },
//       secrets: { secret: body.clientSecret }, submittedBy: caller.accountId,
//     });
//     return toCredentialSubmission(submission); // 202 {submission}
//   });
//
// `submit(trx, …)`, in the caller's transaction (opened with `runInTransaction`):
//
// 1. Takes the slot's advisory lock (tenant, kind, environment) and marks the open submission of that slot
//    `superseded`, its secrets erased in the same UPDATE (PADR-0010 items 2 and 3).
// 2. Inserts the new submission `pending`, each secret envelope-encrypted at once with the associated data
//    `platform.credential_submissions.<column>:<id>` (ADR-0010): the client secret or Stripe secret key in
//    `secret_ciphertext`, the Stripe webhook signing secret in `webhook_secret_ciphertext` (`stripe_api_keys` only,
//    and required there). `public_data` holds the non-secret fields only: a field named like a secret is refused.
// 3. Writes the audit row of the kind (`amadeus.credentials_submitted`, `payments.api_keys_submitted`; actor the
//    submitting account, target the submission) with the kind, the environment, the public fields and the superseded
//    submission, never a secret (the audit service redacts too).
// 4. After the commit, enqueues `credentials.verify {submissionId}` on `platform-connections` with the submission id as
//    the BullMQ job id: the only field of the message (ADR-0009 point 10). Redis down does not fail the committed
//    request: the enqueue gives up after VERIFY_ENQUEUE_TIMEOUT_MS (`credentials.enqueue_failed`,
//    `credentials.enqueue_timeout`), the submission stays `pending`, and a new submission supersedes it.
//
// A call that can never give a submission (an unknown kind, a missing or extra webhook secret, an empty secret, a
// secret-named public field) throws `InvalidCredentialSubmissionError` inside the transaction, so the caller's change
// rolls back with it. The secrets are never logged, audited, queued or answered.
//
// `supersedeOpen(trx, slot)` (PBE-057) ends the open submission of a slot without a new one, its secrets erased, for
// an operation that makes it moot (`useVelexisPayments`); the caller audits it with its own change. `lockSlot(trx,
// slot)` (PBE-057) takes the slot's lock early, for an operation that reads the slot's earlier submissions before it
// calls `submit` (`submitStripeApiKeys`).
//
// `get(tenantId, submissionId)` answers the submission of `getCredentialSubmission` (`toCredentialSubmission`): status
// and error, never a secret nor the public fields; a submission of another OTA answers `404 NOT_FOUND`.
// `pendingByEnvironment(tenantId, kind, db?)` reads what every answered connection shows as its `pendingSubmission`
// (pending-submissions.ts: the one query and the one mapper of the Amadeus and the Stripe connections alike; PBE-053,
// PBE-057, FIX-W39-PLATFORM).
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../../audit/audit.repository";
import { AuditService } from "../../audit/audit.service";
import type { AuditAction } from "../../audit/audit-actions";
import { Clock } from "../clock";
import { EnvelopeService } from "../crypto.provider";
import type { PlatformDb } from "../database";
import type { Feature } from "../features";
import { IdGenerator } from "../ids";
import { PLATFORM_QUEUE } from "../queues/queue-names";
import { afterCommit } from "../redis/invalidation.publisher";
import {
  CredentialSubmissionsRepository,
  isCredentialKind,
  secretPlace,
  SECRET_COLUMNS,
  type CredentialEnvironment,
  type CredentialKind,
  type CredentialSubmissionView,
  type SupersededSubmission,
} from "./credential-submissions.repository";
import {
  toPendingSubmission,
  type PendingCredentialSubmission,
  type PendingSubmissions,
} from "./pending-submissions";

/** A submission as `getCredentialSubmission` answers it. */
export type CredentialSubmission = components["schemas"]["CredentialSubmission"];

/** The job that verifies a submission (PADR-0010 item 4). */
export const CREDENTIALS_VERIFY_JOB = "credentials.verify";

/**
 * The sweep of the submissions whose verification job was lost, and the id of its job scheduler on
 * `platform-connections` (credentials-sweep.ts; FIX-W38-PLATFORM, lead decision (2f) of 2026-10-31).
 */
export const CREDENTIALS_SWEEP_JOB = "credentials.sweep";

/** The payload of `credentials.verify`: the submission's id, nothing else (ADR-0009). */
export interface CredentialsVerifyJobData {
  readonly submissionId: string;
}

/** How long the enqueue of a verification job may take before it is given up. */
export const VERIFY_ENQUEUE_TIMEOUT_MS = 2000;

/**
 * The milestone switch of each kind (PADR-0015): the `x-feature` of the operation that submits it, and the switch
 * without which the worker refuses to apply it (FIX-W39-PLATFORM, lead decision (2b) of 2026-11-02).
 */
export const SUBMISSION_FEATURES: Readonly<Record<CredentialKind, Feature>> = Object.freeze({
  amadeus: "own_amadeus",
  stripe_api_keys: "own_stripe",
});

/** The audit actions of each kind: submitted (the API), applied and rejected (the job). */
export const SUBMISSION_AUDIT_ACTIONS: Readonly<
  Record<
    CredentialKind,
    { readonly submitted: AuditAction; readonly applied: AuditAction; readonly rejected: AuditAction }
  >
> = Object.freeze({
  amadeus: Object.freeze({
    submitted: "amadeus.credentials_submitted",
    applied: "amadeus.credentials_applied",
    rejected: "amadeus.credentials_rejected",
  }),
  stripe_api_keys: Object.freeze({
    submitted: "payments.api_keys_submitted",
    applied: "payments.api_keys_applied",
    rejected: "payments.api_keys_rejected",
  }),
});

/**
 * Field names that hold a secret: never in `public_data`. The request bodies' secret fields (PADR-0010 item 7) and
 * the generic names a caller might use by mistake, compared without case.
 */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  "clientsecret",
  "secretkey",
  "webhooksecret",
  "secret",
  "password",
  "token",
  "apikey",
]);

/** The secrets of one submission, in clear: they live in memory for the call only. */
export interface CredentialSecrets {
  /** The Amadeus client secret, or the Stripe secret (`sk_…`) or restricted (`rk_…`) key. */
  readonly secret: string;
  /** The Stripe webhook signing secret (`whsec_…`): required for `stripe_api_keys`, refused for `amadeus`. */
  readonly webhookSecret?: string;
}

/** One submission, as an operation that submits passes it. */
export interface SubmitCredentialsInput {
  readonly tenantId: string;
  readonly kind: CredentialKind;
  readonly environment: CredentialEnvironment;
  /** The non-secret fields (client id, offices, publishable key), as a plain JSON object. */
  readonly publicData: Readonly<Record<string, unknown>>;
  readonly secrets: CredentialSecrets;
  /** The owner or admin who entered them (`acc_…`). */
  readonly submittedBy: string;
}

/** A call of `submit` that can never give a submission: a programming error, so the caller's transaction rolls back. */
export class InvalidCredentialSubmissionError extends Error {
  override readonly name = "InvalidCredentialSubmissionError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Every property name in a JSON value, at any depth. */
function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(propertyNames);
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([name, child]) => [name, ...propertyNames(child)]);
  }
  return [];
}

/** Checks a `submit` input (see InvalidCredentialSubmissionError); the messages name fields, never a value. */
export function assertValidSubmission(input: SubmitCredentialsInput): void {
  if (!isCredentialKind(input.kind)) {
    throw new InvalidCredentialSubmissionError("kind must be amadeus or stripe_api_keys");
  }
  if (input.environment !== "test" && input.environment !== "live") {
    throw new InvalidCredentialSubmissionError("environment must be test or live");
  }
  if (typeof input.secrets.secret !== "string" || input.secrets.secret.length === 0) {
    throw new InvalidCredentialSubmissionError("secrets.secret must be a non-empty string");
  }
  const webhookSecret = input.secrets.webhookSecret;
  if (input.kind === "stripe_api_keys") {
    if (typeof webhookSecret !== "string" || webhookSecret.length === 0) {
      throw new InvalidCredentialSubmissionError("stripe_api_keys needs secrets.webhookSecret");
    }
  } else if (webhookSecret !== undefined) {
    throw new InvalidCredentialSubmissionError(`${input.kind} takes no secrets.webhookSecret`);
  }
  if (!isPlainObject(input.publicData)) {
    throw new InvalidCredentialSubmissionError("publicData must be a plain object");
  }
  const secretNamed = propertyNames(input.publicData).filter((name) =>
    SECRET_FIELD_NAMES.has(name.toLowerCase()),
  );
  if (secretNamed.length > 0) {
    throw new InvalidCredentialSubmissionError(
      `publicData holds fields named like secrets: ${secretNamed.join(", ")}`,
    );
  }
}

/** The submission as `getCredentialSubmission` answers it: status and error, never a secret or a public field. */
export function toCredentialSubmission(row: CredentialSubmissionView): CredentialSubmission {
  return {
    id: row.id,
    kind: row.kind as CredentialSubmission["kind"],
    environment: row.environment as CredentialSubmission["environment"],
    status: row.status as CredentialSubmission["status"],
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}

@Injectable()
export class CredentialSubmissionsService {
  constructor(
    private readonly submissions: CredentialSubmissionsRepository,
    private readonly envelope: EnvelopeService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    @InjectQueue(PLATFORM_QUEUE.connections) private readonly connections: Queue,
    @InjectPinoLogger(CredentialSubmissionsService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Supersedes the slot's open submission and inserts a new `pending` one with its secrets encrypted, in `trx` (an
   * open transaction of `runInTransaction`), audited without secrets; enqueues `credentials.verify` after the commit
   * (see the file header). The row comes back without its ciphertexts.
   */
  async submit(trx: PlatformTransaction, input: SubmitCredentialsInput): Promise<CredentialSubmissionView> {
    assertValidSubmission(input);
    const { tenantId, kind, environment } = input;
    const now = this.clock.now();
    const id = this.ids.new("crs");

    // Encrypted before any statement runs: the clear secrets are not needed after this.
    const secret = await this.envelope.encrypt(input.secrets.secret, secretPlace(SECRET_COLUMNS.secret, id));
    const webhookSecret =
      input.secrets.webhookSecret === undefined
        ? undefined
        : await this.envelope.encrypt(
            input.secrets.webhookSecret,
            secretPlace(SECRET_COLUMNS.webhookSecret, id),
          );
    if (webhookSecret !== undefined && webhookSecret.kekId !== secret.kekId) {
      // One encryption_key_id column wraps both: a KEK change between the two calls is a reason to stop.
      throw new InvalidCredentialSubmissionError("the two secrets were wrapped by different KEKs");
    }

    await this.submissions.lockSlot(trx, tenantId, kind, environment);
    const superseded = await this.submissions.supersedeOpen(trx, { tenantId, kind, environment, now });
    const row = await this.submissions.insert(trx, {
      id,
      tenantId,
      kind,
      environment,
      publicData: input.publicData,
      secretCiphertext: secret.ciphertext,
      webhookSecretCiphertext: webhookSecret?.ciphertext ?? null,
      encryptionKeyId: secret.kekId,
      submittedByAccountId: input.submittedBy,
      now,
    });
    await this.audit.record(trx, {
      actorType: "account",
      actorAccountId: input.submittedBy,
      action: SUBMISSION_AUDIT_ACTIONS[kind].submitted,
      targetType: "credential_submission",
      targetId: id,
      tenantId,
      after: { status: row.status, publicData: input.publicData },
      details: {
        kind,
        environment,
        ...(superseded.length === 0 ? {} : { supersededSubmissionIds: superseded.map((s) => s.id) }),
      },
    });
    // Logged once committed: a caller whose transaction rolls back after `submit` leaves no `credentials.submitted`.
    afterCommit(trx, async () => {
      this.logger.info(
        {
          submissionId: id,
          tenantId,
          kind,
          environment,
          supersededSubmissionIds: superseded.map((s) => s.id),
        },
        "credentials.submitted",
      );
      await this.enqueueVerification(id);
    });
    return row;
  }

  /** The tenant's submission as `getCredentialSubmission` answers it; `404 NOT_FOUND` for one of another OTA. */
  async get(tenantId: string, submissionId: string): Promise<CredentialSubmission> {
    const row = await this.submissions.findForTenant(tenantId, submissionId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return toCredentialSubmission(row);
  }

  /**
   * The `pendingSubmission` of the tenant's connections of `kind`, by environment (PBE-053, PBE-057): the latest
   * submission of the environment while it is `pending` or `verifying`, or after it `failed` (`toPendingSubmission`);
   * no entry once it was applied (or for an environment without submissions). Read on `db`: the pool, or the caller's
   * transaction when the answer is built inside one. Never a secret nor a public field.
   */
  async pendingByEnvironment(
    tenantId: string,
    kind: CredentialKind,
    db?: PlatformDb | PlatformTransaction,
  ): Promise<PendingSubmissions> {
    const pending: Partial<Record<CredentialEnvironment, PendingCredentialSubmission>> = {};
    for (const row of await this.submissions.latestByEnvironment(tenantId, kind, db)) {
      const submission = toPendingSubmission(row);
      if (submission !== null) {
        pending[row.environment as CredentialEnvironment] = submission;
      }
    }
    return pending;
  }

  /**
   * Adds `credentials.verify {submissionId}` to `platform-connections`, with the submission id as the job id (a
   * second add of the same submission is no new job). Never throws: a failure, or a Redis that does not answer within
   * VERIFY_ENQUEUE_TIMEOUT_MS, is logged and answers `false`.
   */
  async enqueueVerification(submissionId: string): Promise<boolean> {
    const data: CredentialsVerifyJobData = { submissionId };
    let timer: NodeJS.Timeout | undefined;
    const added = this.connections.add(CREDENTIALS_VERIFY_JOB, data, { jobId: submissionId }).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ submissionId, err: error }, "credentials.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), VERIFY_ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn(
          { submissionId, timeoutMs: VERIFY_ENQUEUE_TIMEOUT_MS },
          "credentials.enqueue_timeout",
        );
        return false;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Marks the open submission of the tenant's `kind` and `environment` `superseded` in `trx` (an open transaction of
   * `runInTransaction`), both secrets erased, after the slot's advisory lock, as `submit` does before it inserts; a
   * verification still running finds it final and writes nothing. Answers what it marked (none, or one). The caller
   * takes it before it locks the connection of the slot (lock order: submission, then connection) and audits it.
   */
  async supersedeOpen(trx: PlatformTransaction, slot: CredentialSlot): Promise<SupersededSubmission[]> {
    await this.lockSlot(trx, slot);
    return this.submissions.supersedeOpen(trx, { ...slot, now: this.clock.now() });
  }

  /**
   * Takes the advisory lock of the tenant's `kind` and `environment` slot in `trx`, held until it ends: the lock that
   * `submit` and `supersedeOpen` take. An operation that reads the slot's earlier submissions to build the new one
   * (`submitStripeApiKeys` keeps their connection id) takes it first, so a submission of the same slot at the same
   * moment waits for it and reads what it wrote; taking it again in the same transaction does not wait.
   */
  async lockSlot(trx: PlatformTransaction, slot: CredentialSlot): Promise<void> {
    await this.submissions.lockSlot(trx, slot.tenantId, slot.kind, slot.environment);
  }
}

/** A slot of submissions: the tenant, the kind and the environment (one open submission each, PADR-0010 item 2). */
export interface CredentialSlot {
  readonly tenantId: string;
  readonly kind: CredentialKind;
  readonly environment: CredentialEnvironment;
}
