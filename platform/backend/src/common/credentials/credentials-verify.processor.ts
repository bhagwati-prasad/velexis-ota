// `credentials.verify {submissionId}` on `platform-connections` (PBE-052; PADR-0010 items 2 to 6, architecture §5):
// the worker's side of a credential submission. BullMQ hands any job of a queue to any of its workers, so the queue
// keeps its one processor (supplier-connections/verification.processor.ts), which runs this job with
// `CredentialsVerifyProcessor.process(job)`. The job's options are the defaults of ADR-0009 (5 attempts, exponential
// backoff from 30 s).
//
// **Verifiers.** The provider check and the switch of the connection belong to the module that owns the connection:
// PBE-053 registers the Amadeus verifier (`amadeus`), PBE-057 the Stripe API keys verifier (`stripe_api_keys`). A
// verifier is any object with `check` and `apply` (`CredentialVerifier`), registered once per kind in the worker's one
// `CredentialVerifiers` registry from its own `onModuleInit`, in a worker module that imports
// `CredentialSubmissionsModule.forWorker()` (the one static worker module, whoever imports it):
//
//   constructor(private readonly verifiers: CredentialVerifiers) {}
//   onModuleInit(): void { this.verifiers.register("amadeus", this); }
//
// The verifier's `apply` runs with the submission locked: it locks the connection rows it changes after that, so an
// operation that submits must not hold a lock on those rows while it calls `submit` (lock order: submission, then
// connection).
//
// **One attempt:**
//
// 1. The submission becomes `verifying` with `attempts + 1` (`startAttempt`): a `pending` one, or one left `verifying`
//    by a crash or by an earlier attempt, so a retry always finds it. A final or missing submission is left alone
//    (`credentials.verify_skipped`): a newer submission superseded it, or an earlier attempt finished it.
//    **The kind's switch** (FIX-W39-PLATFORM, lead decision (2b) of 2026-11-02): while the milestone switch of the kind
//    is off in this worker (`amadeus`: FEATURE_OWN_AMADEUS, `stripe_api_keys`: FEATURE_OWN_STRIPE; SUBMISSION_FEATURES),
//    the submission is not applied: nothing is decrypted, the provider is not asked, and the attempt goes straight to
//    step 3's failure with FEATURE_DISABLED (final at once, as a rejection; audit details `reason: feature_disabled`
//    and the switch), its secrets erased.
// 2. Outside any transaction, the secrets are decrypted (associated data
//    `platform.credential_submissions.<column>:<id>`) and handed to the verifier's `check`, which asks the provider:
//    - `verified` (with an optional `result` for `apply`);
//    - `rejected` with a stable error code (`AMADEUS_CREDENTIALS_INVALID`, `STRIPE_KEY_INVALID`,
//      `STRIPE_LIVEMODE_MISMATCH`, …) and a sanitised message (the provider's HTTP status and error code, never a body
//      or a secret): final at once;
//    - `unavailable` (timeout, 5xx, 429): the job fails and BullMQ tries again; the submission stays `verifying` and no
//      error is written (the portal shows an error only once the submission is `failed`). On the last attempt the
//      submission fails with `PROVIDER_UNAVAILABLE`.
//    An attempt that cannot complete for another reason (no verifier registered for the kind, a secret that does not
//    decrypt, a `check` or `apply` that throws, a result that breaks the contract) counts as `unavailable`: retried,
//    then `PROVIDER_UNAVAILABLE` ("try again later" for the portal), so a submission never keeps its secrets past its
//    last attempt.
// 3. In one transaction, with the submission locked (`FOR UPDATE`) and still `verifying` (a newer submission may have
//    superseded it meanwhile, or the sweep failed it: then nothing is written, `credentials.verify_superseded`, and the
//    job's result is the status the submission has):
//    - verified: the verifier's `apply(trx, …)` switches the connection (it may throw `CredentialRejection` to fail the
//      submission instead: its writes roll back); the submission becomes `applied`;
//    - otherwise: the submission becomes `failed` with `error_code` and `error_message`;
//    in both cases both secret columns are erased in the same UPDATE, `finished_at` is set, the audit row of the kind
//    is written (`amadeus.credentials_applied` / `…_rejected`, `payments.api_keys_applied` / `…_rejected`; actor
//    `system`, label `credentials.verify`, target the submission; the verifier's `apply` adds what it changed), and
//    the submitter gets `connection.credentials_applied` or `connection.credentials_failed` (PADR-0013 item 5) while
//    the account is active and still a member of the OTA (idempotency key `credentials:<submissionId>`). A crash
//    inside this transaction rolls it back, and the retry finds the submission `verifying` (amadeus flow, "Worker
//    crash during apply").
//
// **A lost job** (FIX-W38-PLATFORM, lead decision (2f) of 2026-10-31): the sweep of credentials-sweep.ts, every 5
// minutes, queues `credentials.verify` again for a submission `pending` for more than 10 minutes, and fails one left
// `verifying` for more than an hour with `failStuck` (PROVIDER_UNAVAILABLE, the secrets erased, the `*_rejected` audit
// row and the `connection.credentials_failed` e-mail, under the same lock and status guard as step 3). A `pending` one
// whose kind's switch is off is not queued again but failed with `failSwitchedOff` (FEATURE_DISABLED, the same writes;
// FIX-W39-PLATFORM, lead decision (2b) of 2026-11-02).
//
// Neither a secret nor a provider body is logged, stored, queued or returned: the job data is the submission id, the
// result is the id and the status, the errors BullMQ keeps are fixed texts, and the log lines carry ids, the kind,
// the environment, the attempt, the outcome and the error code. Any text taken from a verifier's error (its message
// in a log line, the stored `error_message`) has every secret of the submission replaced first.
import { Inject, Injectable } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../../audit/audit.repository";
import { AuditService, type AuditDetails, type AuditValues } from "../../audit/audit.service";
import { isLastTry, type JobTries } from "../../notifications/email.processor";
import { OutboxService } from "../../notifications/outbox.service";
import { MEMBER_VISIBLE_TENANT_STATUSES } from "../auth/tenant-role.guard";
import { Clock } from "../clock";
import { EnvelopeService } from "../crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../database";
import { FeatureSwitches } from "../features";
import { runInTransaction } from "../redis/invalidation.publisher";
import {
  CredentialSubmissionsRepository,
  isCredentialKind,
  secretPlace,
  SECRET_COLUMNS,
  type CredentialEnvironment,
  type CredentialKind,
  type CredentialSubmissionRecord,
  type CredentialSubmissionStatus,
  type CredentialSubmissionView,
} from "./credential-submissions.repository";
import {
  CREDENTIALS_SWEEP_JOB,
  CREDENTIALS_VERIFY_JOB,
  SUBMISSION_AUDIT_ACTIONS,
  SUBMISSION_FEATURES,
  type CredentialSecrets,
  type CredentialsVerifyJobData,
} from "./credential-submissions.service";

/** The error code of a provider that could not answer, and of an attempt that could not complete (file header). */
export const PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE";

/** The shape of a submission's `error_code` (the OpenAPI document's `CredentialSubmission.errorCode`). */
export const SUBMISSION_ERROR_CODE = /^[A-Z][A-Z0-9_]+$/;

/** The longest `error_message`, in characters (the OpenAPI document's `maxLength`). */
export const MAX_SUBMISSION_ERROR_LENGTH = 500;

/** The message of a submission that failed because its verification could not complete. */
export const VERIFICATION_INCOMPLETE_MESSAGE = "The verification could not be completed. Try again later.";

/** What replaces a secret in a text taken from a verifier's error. */
export const SECRET_PLACEHOLDER = "[secret]";

/** The actor label of the job's audit rows. */
const ACTOR_LABEL = CREDENTIALS_VERIFY_JOB;

/** The reason in the audit row of a submission the sweep failed (`failStuck`). */
export const VERIFICATION_TIMEOUT_REASON = "verification_timeout";

/**
 * The error code of a submission whose kind's milestone switch was off when the worker took it (FIX-W39-PLATFORM, lead
 * decision (2b) of 2026-11-02): the code the API answers for the switched-off operation.
 */
export const FEATURE_DISABLED = "FEATURE_DISABLED";

/** The reason in the audit row of a submission failed because its kind's switch is off. */
export const FEATURE_DISABLED_REASON = "feature_disabled";

/** The stored message of a submission failed because its kind's switch is off, by kind. */
export const FEATURE_DISABLED_MESSAGES: Readonly<Record<CredentialKind, string>> = Object.freeze({
  amadeus:
    "Own Amadeus credentials are switched off at Velexis, so these were not applied. Nothing changed; submit them again once they are switched on.",
  stripe_api_keys:
    "Own Stripe accounts are switched off at Velexis, so these keys were not applied. Nothing changed; submit them again once they are switched on.",
});

/** The e-mails to the submitter (PADR-0013 item 5). */
export const CREDENTIALS_APPLIED_TEMPLATE = "connection.credentials_applied";
export const CREDENTIALS_FAILED_TEMPLATE = "connection.credentials_failed";

/** How the e-mails name each kind, and the portal page of its connection. */
export const KIND_PRESENTATION: Readonly<
  Record<CredentialKind, { readonly credentials: string; readonly page: string }>
> = Object.freeze({
  amadeus: Object.freeze({ credentials: "Amadeus credentials", page: "amadeus" }),
  stripe_api_keys: Object.freeze({ credentials: "Stripe API keys", page: "payments" }),
});

/** What a verifier is told about the submission it checks. */
export interface CredentialCheckInput {
  readonly submissionId: string;
  readonly tenantId: string;
  readonly kind: CredentialKind;
  readonly environment: CredentialEnvironment;
  /** The non-secret fields the operation stored (client id, offices, publishable key). */
  readonly publicData: Readonly<Record<string, unknown>>;
  /** The decrypted secrets: in memory for this attempt only. Never log, store or queue them. */
  readonly secrets: CredentialSecrets;
  /** The attempt, from 1. */
  readonly attempt: number;
  /** True on the job's last attempt: an `unavailable` answer then fails the submission. */
  readonly lastAttempt: boolean;
}

/** What a verifier's `apply` is told: the check's input, its result, the submitter and the time of the switch. */
export interface CredentialApplyInput extends CredentialCheckInput {
  /** The `result` of the `verified` answer (the Stripe account id, …), as `check` returned it. */
  readonly result: unknown;
  readonly submittedByAccountId: string | null;
  readonly now: Date;
}

/** The answer of a verifier's `check`. */
export type CredentialCheck =
  | { readonly outcome: "verified"; readonly result?: unknown }
  | { readonly outcome: "rejected"; readonly errorCode: string; readonly errorMessage: string }
  | { readonly outcome: "unavailable"; readonly errorMessage: string };

/** What a verifier's `apply` adds to the `…_applied` audit row: what it changed. Never a secret. */
export interface CredentialApplied {
  readonly before?: AuditValues;
  readonly after?: AuditValues;
  readonly details?: AuditDetails;
}

/**
 * The provider side of one kind of credentials. `check` runs outside any transaction and must not write; `apply` runs
 * in the job's transaction, with the submission locked and still `verifying`, and switches the connection (re-encrypting
 * the secrets with the connection's associated data, ADR-0010). Neither puts a secret in an error, a result or a log.
 */
export interface CredentialVerifier {
  check(input: CredentialCheckInput): Promise<CredentialCheck>;
  apply(trx: PlatformTransaction, input: CredentialApplyInput): Promise<CredentialApplied | undefined>;
}

/**
 * Thrown by a verifier's `check` or `apply` to fail the submission with a stable code (the same as a `rejected`
 * answer); from `apply`, its writes roll back first. The message is the sanitised one stored for the portal.
 */
export class CredentialRejection extends Error {
  override readonly name = "CredentialRejection";

  constructor(
    readonly errorCode: string,
    errorMessage: string,
  ) {
    super(errorMessage);
  }
}

/** A second verifier for one kind: a programming error of the worker's module graph. */
export class DuplicateCredentialVerifierError extends Error {
  override readonly name = "DuplicateCredentialVerifierError";
}

/**
 * The verifiers of the worker, by kind: one per kind, registered once (PBE-053 `amadeus`, PBE-057 `stripe_api_keys`;
 * tests register a test verifier). The worker's module graph provides one instance (CredentialSubmissionsModule).
 */
@Injectable()
export class CredentialVerifiers {
  private readonly byKind = new Map<CredentialKind, CredentialVerifier>();

  /** Registers the verifier of `kind`; a second one for the same kind throws. */
  register(kind: CredentialKind, verifier: CredentialVerifier): void {
    if (this.byKind.has(kind)) {
      throw new DuplicateCredentialVerifierError(
        `A credential verifier of kind ${kind} is registered already`,
      );
    }
    this.byKind.set(kind, verifier);
  }

  /** The verifier of `kind`, or `undefined` while none is registered. */
  get(kind: CredentialKind): CredentialVerifier | undefined {
    return this.byKind.get(kind);
  }

  /** The kinds with a verifier. */
  kinds(): CredentialKind[] {
    return [...this.byKind.keys()];
  }
}

/** What a finished `credentials.verify` job returns (BullMQ keeps it): the id and what happened. */
export interface CredentialsVerifyResult {
  readonly submissionId: string;
  /** The status the submission has: `applied`, `failed`, `superseded`, …, or `missing` (no such submission). */
  readonly status: CredentialSubmissionStatus | "missing";
}

/** An attempt that BullMQ tries again. The message is a fixed text: never a provider's or a verifier's words. */
export class CredentialsVerifyRetryError extends Error {
  override readonly name = "CredentialsVerifyRetryError";
}

const SUBMISSION_ID = /^crs_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The submission id of a `credentials.verify` payload, or `undefined` when it is not `{ submissionId }`. */
export function submissionIdOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const id = (data as Partial<CredentialsVerifyJobData>).submissionId;
  return Object.keys(data).length === 1 && typeof id === "string" && SUBMISSION_ID.test(id) ? id : undefined;
}

/** `text` with every secret of `secrets` (of at least 4 characters) replaced by SECRET_PLACEHOLDER. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      scrubbed = scrubbed.split(secret).join(SECRET_PLACEHOLDER);
    }
  }
  return scrubbed;
}

/**
 * The `error_message` stored for a failed submission: the verifier's sanitised message on one line, at most
 * MAX_SUBMISSION_ERROR_LENGTH characters, with any secret of the submission replaced; VERIFICATION_INCOMPLETE_MESSAGE
 * when nothing is left.
 */
export function storedErrorMessage(message: string, secrets: readonly string[]): string {
  const oneLine = scrubSecrets(message, secrets).replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) {
    return VERIFICATION_INCOMPLETE_MESSAGE;
  }
  return oneLine.length > MAX_SUBMISSION_ERROR_LENGTH
    ? `${oneLine.slice(0, MAX_SUBMISSION_ERROR_LENGTH - 1)}…`
    : oneLine;
}

/** Why an attempt could not complete (file header), as the log lines and the retry errors name it. */
type IncompleteReason =
  | "provider_unavailable"
  | "no_verifier"
  | "undecryptable"
  | "verifier_error"
  | "invalid_result"
  | "apply_failed";

/** What one attempt decided before its final transaction. */
type Decision = Verified | Failure;

/** A `verified` answer, with what its apply needs. */
interface Verified {
  readonly kind: "verified";
  readonly result: unknown;
  readonly verifier: CredentialVerifier;
  readonly input: CredentialCheckInput;
}

/**
 * A rejection (final at once; `details` adds to the audit row), or an attempt that could not complete (retried, then
 * PROVIDER_UNAVAILABLE).
 */
type Failure =
  | {
      readonly kind: "rejected";
      readonly errorCode: string;
      readonly errorMessage: string;
      readonly details?: AuditDetails;
    }
  | { readonly kind: "incomplete"; readonly reason: IncompleteReason; readonly errorMessage: string };

/** The parts of a BullMQ job one attempt reads. */
export type CredentialsVerifyJob = Pick<Job, "name" | "data"> & JobTries;

@Injectable()
export class CredentialsVerifyProcessor {
  constructor(
    private readonly submissions: CredentialSubmissionsRepository,
    private readonly verifiers: CredentialVerifiers,
    private readonly envelope: EnvelopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly features: FeatureSwitches,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(CredentialsVerifyProcessor.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * False while the milestone switch of `kind` is off in this worker (SUBMISSION_FEATURES): its submissions are not
   * applied. The sweep asks it too (FIX-W39-PLATFORM, lead decision (2b) of 2026-11-02). A kind outside
   * CREDENTIAL_KINDS has no switch (the table's CHECK allows none; an attempt fails it as `no_verifier`).
   */
  kindEnabled(kind: string): boolean {
    return !isCredentialKind(kind) || this.features.isEnabled(SUBMISSION_FEATURES[kind]);
  }

  /** One attempt of `credentials.verify` (see the file header). */
  async process(job: CredentialsVerifyJob): Promise<CredentialsVerifyResult> {
    const submissionId = submissionIdOf(job.data);
    if (submissionId === undefined) {
      this.logger.error({ job: job.name }, "credentials.invalid_job");
      throw new UnrecoverableError("credentials.verify needs { submissionId: crs_… } and nothing else");
    }
    const attempt = job.attemptsMade + 1;
    const lastAttempt = isLastTry(job);

    const started = await this.submissions.startAttempt(submissionId, this.clock.now());
    if (started === undefined) {
      const row = await this.submissions.find(submissionId);
      this.logger.info(
        { submissionId, status: row?.status ?? "missing", attempt },
        "credentials.verify_skipped",
      );
      return { submissionId, status: (row?.status as CredentialSubmissionStatus | undefined) ?? "missing" };
    }
    const context = {
      submissionId,
      tenantId: started.tenant_id,
      kind: started.kind,
      environment: started.environment,
      attempt,
    };
    this.logger.info(context, "credentials.verify_started");

    // A kind whose switch is off is never applied: no secret is decrypted and the provider is not asked.
    const switchedOff =
      this.kindEnabled(started.kind) || !isCredentialKind(started.kind)
        ? undefined
        : switchedOffFailure(started.kind);
    const secrets = switchedOff === undefined ? await this.decryptSecrets(started) : undefined;
    const secretValues = secrets === undefined ? [] : secretTexts(secrets);
    let decision: Decision =
      switchedOff ?? (await this.decide(started, secrets, secretValues, { attempt, lastAttempt }, context));
    if (decision.kind === "incomplete" && !lastAttempt) {
      throw this.retry(submissionId, attempt, decision.reason, context);
    }

    let written: CredentialSubmissionView | undefined;
    if (decision.kind === "verified") {
      try {
        written = await this.finishApplied(started, decision);
      } catch (error) {
        const failure = this.applyFailure(error, secretValues, context);
        if (failure.kind === "incomplete" && !lastAttempt) {
          throw this.retry(submissionId, attempt, failure.reason, context);
        }
        decision = failure;
        written = await this.finishFailed(started, failure, attempt);
      }
    } else {
      written = await this.finishFailed(started, decision, attempt);
    }

    if (written === undefined) {
      // Another writer finished the submission first: a newer submission superseded it, or the sweep failed it
      // (`failStuck`). The result names the status it has now, not this attempt's outcome.
      const row = await this.submissions.find(submissionId);
      const status = (row?.status as CredentialSubmissionStatus | undefined) ?? "missing";
      this.logger.info({ ...context, status }, "credentials.verify_superseded");
      return { submissionId, status };
    }
    if (written.status === "applied") {
      this.logger.info(context, "credentials.applied");
      return { submissionId, status: "applied" };
    }
    this.logger.warn(
      {
        ...context,
        errorCode: written.error_code,
        ...(decision.kind === "incomplete" ? { reason: decision.reason } : {}),
      },
      "credentials.failed",
    );
    if (decision.kind === "incomplete") {
      // The last attempt: the job ends failed, so the queue views show it, with the outcome written above.
      throw new UnrecoverableError(
        `credentials.verify of ${submissionId}: the last attempt was incomplete (${decision.reason})`,
      );
    }
    return { submissionId, status: "failed" };
  }

  /** The decision of an attempt before its final transaction: the verifier's answer, or why there is none. */
  private async decide(
    started: CredentialSubmissionRecord,
    secrets: CredentialSecrets | undefined,
    secretValues: readonly string[],
    tries: { readonly attempt: number; readonly lastAttempt: boolean },
    context: Readonly<Record<string, unknown>>,
  ): Promise<Decision> {
    if (secrets === undefined) {
      this.logger.error(context, "credentials.secret_undecryptable");
      return incomplete("undecryptable");
    }
    const kind = started.kind as CredentialKind;
    const verifier = this.verifiers.get(kind);
    if (verifier === undefined) {
      this.logger.error(context, "credentials.no_verifier");
      return incomplete("no_verifier");
    }
    const input: CredentialCheckInput = {
      submissionId: started.id,
      tenantId: started.tenant_id,
      kind,
      environment: started.environment as CredentialEnvironment,
      publicData: publicDataOf(started.public_data),
      secrets,
      attempt: tries.attempt,
      lastAttempt: tries.lastAttempt,
    };
    return this.check(verifier, input, secretValues, context);
  }

  /** The error that makes BullMQ try again: a fixed text, logged as `credentials.verify_retry`. */
  private retry(
    submissionId: string,
    attempt: number,
    reason: IncompleteReason,
    context: Readonly<Record<string, unknown>>,
  ): CredentialsVerifyRetryError {
    this.logger.warn({ ...context, reason }, "credentials.verify_retry");
    return new CredentialsVerifyRetryError(
      `credentials.verify of ${submissionId}: attempt ${attempt} incomplete (${reason}); retried`,
    );
  }

  /** The decrypted secrets of `row`, or `undefined` when one does not decrypt. The plaintext bytes are zeroed. */
  private async decryptSecrets(row: CredentialSubmissionRecord): Promise<CredentialSecrets | undefined> {
    if (row.secret_ciphertext === null) {
      return undefined;
    }
    try {
      const secret = await this.decryptText(
        row.secret_ciphertext,
        secretPlace(SECRET_COLUMNS.secret, row.id),
      );
      if (row.webhook_secret_ciphertext === null) {
        return { secret };
      }
      const webhookSecret = await this.decryptText(
        row.webhook_secret_ciphertext,
        secretPlace(SECRET_COLUMNS.webhookSecret, row.id),
      );
      return { secret, webhookSecret };
    } catch {
      return undefined;
    }
  }

  private async decryptText(ciphertext: Uint8Array, place: ReturnType<typeof secretPlace>): Promise<string> {
    const plaintext = await this.envelope.decrypt(ciphertext, place);
    try {
      return plaintext.toString("utf8");
    } finally {
      plaintext.fill(0);
    }
  }

  /** The verifier's answer as a decision; a `check` that throws or breaks the contract is an incomplete attempt. */
  private async check(
    verifier: CredentialVerifier,
    input: CredentialCheckInput,
    secrets: readonly string[],
    context: Readonly<Record<string, unknown>>,
  ): Promise<Decision> {
    let answer: CredentialCheck;
    try {
      answer = await verifier.check(input);
    } catch (error) {
      if (error instanceof CredentialRejection) {
        const decision = rejection(error.errorCode, error.message, secrets);
        if (decision !== undefined) {
          return decision;
        }
        this.logger.error(context, "credentials.invalid_result");
        return incomplete("invalid_result");
      }
      this.logVerifierError(error, secrets, context, "credentials.verifier_failed");
      return incomplete("verifier_error");
    }
    // A verifier is code of another module: its answer is checked, not trusted.
    const outcome: unknown = (answer as { readonly outcome?: unknown } | null | undefined)?.outcome;
    if (outcome === "verified") {
      return { kind: "verified", result: (answer as { readonly result?: unknown }).result, verifier, input };
    }
    if (outcome === "rejected") {
      const rejected = answer as Extract<CredentialCheck, { outcome: "rejected" }>;
      const decision = rejection(rejected.errorCode, rejected.errorMessage, secrets);
      if (decision !== undefined) {
        return decision;
      }
    } else if (outcome === "unavailable") {
      const message: unknown = (answer as { readonly errorMessage?: unknown }).errorMessage;
      return incomplete(
        "provider_unavailable",
        typeof message === "string" ? storedErrorMessage(message, secrets) : undefined,
      );
    }
    this.logger.error(context, "credentials.invalid_result");
    return incomplete("invalid_result");
  }

  /** What a failed apply transaction means: a `CredentialRejection`, or an incomplete attempt. */
  private applyFailure(
    error: unknown,
    secrets: readonly string[],
    context: Readonly<Record<string, unknown>>,
  ): Failure {
    if (error instanceof CredentialRejection) {
      const decision = rejection(error.errorCode, error.message, secrets);
      if (decision !== undefined) {
        return decision;
      }
    }
    this.logVerifierError(error, secrets, context, "credentials.apply_failed");
    return incomplete("apply_failed");
  }

  /** Logs a verifier's error by its name and its message with the submission's secrets replaced. */
  private logVerifierError(
    error: unknown,
    secrets: readonly string[],
    context: Readonly<Record<string, unknown>>,
    message: string,
  ): void {
    const name = error instanceof Error ? error.name : typeof error;
    const text = error instanceof Error ? scrubSecrets(error.message, secrets) : "";
    this.logger.error({ ...context, errorName: name, errorText: text }, message);
  }

  /**
   * The verified switch, in one transaction: the verifier's `apply`, the submission `applied` with its secrets erased,
   * the audit row and the submitter's e-mail. `undefined` when the submission is no longer `verifying`.
   */
  private async finishApplied(
    started: CredentialSubmissionRecord,
    verified: Verified,
  ): Promise<CredentialSubmissionView | undefined> {
    const { verifier, input, result } = verified;
    const kind = input.kind;
    return runInTransaction(this.db, async (trx) => {
      const current = await this.submissions.lock(trx, started.id);
      if (current === undefined || current.status !== "verifying") {
        return undefined;
      }
      const now = this.clock.now();
      const applied = await verifier.apply(trx, {
        ...input,
        result,
        submittedByAccountId: current.submitted_by_account_id,
        now,
      });
      const row = await this.submissions.finish(trx, started.id, { status: "applied" }, now);
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: ACTOR_LABEL,
        action: SUBMISSION_AUDIT_ACTIONS[kind].applied,
        targetType: "credential_submission",
        targetId: started.id,
        tenantId: started.tenant_id,
        before: { ...applied?.before, status: current.status },
        after: { ...applied?.after, status: row.status },
        details: {
          ...applied?.details,
          kind,
          environment: row.environment,
          attempt: row.attempts,
        },
      });
      await this.notify(trx, row, CREDENTIALS_APPLIED_TEMPLATE);
      return row;
    });
  }

  /**
   * The failure, in one transaction: the submission `failed` with its code and message and its secrets erased, the
   * audit row and the submitter's e-mail. `undefined` when the submission is no longer `verifying`.
   */
  private async finishFailed(
    started: CredentialSubmissionRecord,
    decision: Failure,
    attempt: number,
  ): Promise<CredentialSubmissionView | undefined> {
    const kind = started.kind as CredentialKind;
    const errorCode = decision.kind === "rejected" ? decision.errorCode : PROVIDER_UNAVAILABLE;
    return runInTransaction(this.db, async (trx) => {
      const current = await this.submissions.lock(trx, started.id);
      if (current === undefined || current.status !== "verifying") {
        return undefined;
      }
      const now = this.clock.now();
      const row = await this.submissions.finish(
        trx,
        started.id,
        { status: "failed", errorCode, errorMessage: decision.errorMessage },
        now,
      );
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: ACTOR_LABEL,
        action: SUBMISSION_AUDIT_ACTIONS[kind].rejected,
        targetType: "credential_submission",
        targetId: started.id,
        tenantId: started.tenant_id,
        before: { status: current.status },
        after: { status: row.status, errorCode },
        details: {
          kind,
          environment: row.environment,
          attempt,
          errorMessage: decision.errorMessage,
          ...(decision.kind === "incomplete" ? { reason: decision.reason } : decision.details),
        },
      });
      await this.notify(trx, row, CREDENTIALS_FAILED_TEMPLATE);
      return row;
    });
  }

  /**
   * Fails a submission the sweep found `verifying` since before `verifyingBefore` (credentials-sweep.ts;
   * FIX-W38-PLATFORM, lead decision (2f) of 2026-10-31): its job is lost, and its secrets must not outlive it. One
   * transaction with the submission locked, and only while it is still `verifying` and unchanged since
   * `verifyingBefore` (the status guard; an attempt that started meanwhile moved `updated_at`): `failed` with
   * PROVIDER_UNAVAILABLE and VERIFICATION_INCOMPLETE_MESSAGE, both secret columns erased in the same UPDATE, the
   * kind's `*_rejected` audit row (actor `system`, label `credentials.sweep`, reason `verification_timeout`) and the
   * submitter's `connection.credentials_failed` e-mail, as a last attempt writes them. A job that finishes at the same
   * time either commits first (the guard then finds a final row and nothing is written here) or finds the row `failed`
   * in its own final transaction and writes nothing (`credentials.verify_superseded`). No secret is decrypted.
   * `undefined` when nothing was written.
   */
  async failStuck(
    submissionId: string,
    verifyingBefore: Date,
  ): Promise<CredentialSubmissionView | undefined> {
    return this.failFromSweep(submissionId, "verifying", verifyingBefore, () => ({
      errorCode: PROVIDER_UNAVAILABLE,
      errorMessage: VERIFICATION_INCOMPLETE_MESSAGE,
      details: { reason: VERIFICATION_TIMEOUT_REASON },
    }));
  }

  /**
   * Fails a submission the sweep found `pending` since before `pendingBefore` while its kind's switch is off
   * (credentials-sweep.ts; FIX-W39-PLATFORM, lead decision (2b) of 2026-11-02): it would never be applied, so it is not
   * queued again, and its secrets must not wait for the switch. Under the same lock and status guard as `failStuck`
   * (still `pending`, unchanged since `pendingBefore`, and the switch still off): `failed` with FEATURE_DISABLED and
   * the kind's FEATURE_DISABLED_MESSAGES, both secret columns erased, the kind's `*_rejected` audit row (actor
   * `system`, label `credentials.sweep`, reason `feature_disabled` and the switch) and the submitter's
   * `connection.credentials_failed` e-mail. A job that starts its attempt meanwhile moves the row to `verifying`, and
   * fails it the same way itself. No secret is decrypted. `undefined` when nothing was written.
   */
  async failSwitchedOff(
    submissionId: string,
    pendingBefore: Date,
  ): Promise<CredentialSubmissionView | undefined> {
    return this.failFromSweep(submissionId, "pending", pendingBefore, (current) =>
      this.kindEnabled(current.kind) || !isCredentialKind(current.kind)
        ? undefined
        : switchedOffOutcome(current.kind),
    );
  }

  /**
   * The sweep's failure of one submission, in one transaction: the row locked, still in `status` and unchanged since
   * `before`, and `outcomeOf` answering an outcome (else nothing is written); then `failed` with its code and message,
   * both secret columns erased, the kind's `*_rejected` audit row (actor `system`, label `credentials.sweep`, the
   * outcome's details) and the submitter's `connection.credentials_failed` e-mail.
   */
  private async failFromSweep(
    submissionId: string,
    status: "pending" | "verifying",
    before: Date,
    outcomeOf: (current: CredentialSubmissionView) => SweepOutcome | undefined,
  ): Promise<CredentialSubmissionView | undefined> {
    return runInTransaction(this.db, async (trx) => {
      const current = await this.submissions.lock(trx, submissionId);
      if (
        current === undefined ||
        current.status !== status ||
        current.updated_at.getTime() >= before.getTime()
      ) {
        return undefined;
      }
      const outcome = outcomeOf(current);
      if (outcome === undefined) {
        return undefined;
      }
      const kind = current.kind as CredentialKind;
      const row = await this.submissions.finish(
        trx,
        submissionId,
        { status: "failed", errorCode: outcome.errorCode, errorMessage: outcome.errorMessage },
        this.clock.now(),
      );
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: CREDENTIALS_SWEEP_JOB,
        action: SUBMISSION_AUDIT_ACTIONS[kind].rejected,
        targetType: "credential_submission",
        targetId: submissionId,
        tenantId: current.tenant_id,
        before: { status: current.status },
        after: { status: row.status, errorCode: outcome.errorCode },
        details: {
          kind,
          environment: row.environment,
          attempt: row.attempts,
          errorMessage: outcome.errorMessage,
          ...outcome.details,
        },
      });
      await this.notify(trx, row, CREDENTIALS_FAILED_TEMPLATE);
      return row;
    });
  }

  /**
   * Queues the submitter's e-mail of `template` in `trx`, once per submission, while the account is active and still
   * a member of an OTA its members see; otherwise nothing.
   */
  private async notify(
    trx: PlatformTransaction,
    row: CredentialSubmissionView,
    template: typeof CREDENTIALS_APPLIED_TEMPLATE | typeof CREDENTIALS_FAILED_TEMPLATE,
  ): Promise<void> {
    if (row.submitted_by_account_id === null) {
      return;
    }
    const tenant = await this.submissions.tenantLabel(trx, row.tenant_id);
    if (
      tenant === undefined ||
      tenant.deleted_at !== null ||
      !(MEMBER_VISIBLE_TENANT_STATUSES as readonly string[]).includes(tenant.status)
    ) {
      return;
    }
    const recipient = await this.submissions.emailRecipient(trx, row.tenant_id, row.submitted_by_account_id);
    if (recipient === undefined) {
      this.logger.info({ submissionId: row.id, tenantId: row.tenant_id }, "credentials.notify_skipped");
      return;
    }
    const presentation = KIND_PRESENTATION[row.kind as CredentialKind];
    const common = {
      fullName: recipient.full_name,
      tenantName: tenant.name,
      tenantKey: tenant.key,
      credentials: presentation.credentials,
      environment: row.environment,
      connectionUrl: this.outbox.portalLink(`/otas/${row.tenant_id}/${presentation.page}`),
    };
    await this.outbox.queue(trx, {
      templateKey: template,
      to: recipient.email,
      accountId: recipient.account_id,
      tenantId: row.tenant_id,
      data:
        template === CREDENTIALS_FAILED_TEMPLATE
          ? { ...common, errorCode: row.error_code ?? PROVIDER_UNAVAILABLE, reason: row.error_message ?? "" }
          : common,
      idempotencyKey: `credentials:${row.id}`,
    });
  }
}

/** What the sweep writes when it fails a submission: the code, the stored message and the audit row's details. */
interface SweepOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly details: AuditDetails;
}

/** The outcome of a submission whose kind's switch is off: FEATURE_DISABLED, its message, the switch in the audit row. */
function switchedOffOutcome(kind: CredentialKind): SweepOutcome {
  return {
    errorCode: FEATURE_DISABLED,
    errorMessage: FEATURE_DISABLED_MESSAGES[kind],
    details: { reason: FEATURE_DISABLED_REASON, feature: SUBMISSION_FEATURES[kind] },
  };
}

/** The failure of an attempt whose kind's switch is off: a rejection with FEATURE_DISABLED (final at once). */
function switchedOffFailure(kind: CredentialKind): Failure {
  const outcome = switchedOffOutcome(kind);
  return { kind: "rejected", ...outcome };
}

/** The clear secrets of a submission, for scrubbing texts. */
function secretTexts(secrets: CredentialSecrets): string[] {
  return secrets.webhookSecret === undefined ? [secrets.secret] : [secrets.secret, secrets.webhookSecret];
}

/** The stored `public_data` as a plain object (`{}` for anything else). */
function publicDataOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * An incomplete attempt: on the last one, PROVIDER_UNAVAILABLE with the provider's sanitised message (an unavailable
 * provider) or VERIFICATION_INCOMPLETE_MESSAGE.
 */
function incomplete(reason: IncompleteReason, errorMessage = VERIFICATION_INCOMPLETE_MESSAGE): Failure {
  return { kind: "incomplete", reason, errorMessage };
}

/** A rejection with a valid code and its stored message; `undefined` when the code breaks the contract. */
function rejection(
  errorCode: unknown,
  errorMessage: unknown,
  secrets: readonly string[],
): Failure | undefined {
  if (
    typeof errorCode !== "string" ||
    !SUBMISSION_ERROR_CODE.test(errorCode) ||
    typeof errorMessage !== "string"
  ) {
    return undefined;
  }
  return { kind: "rejected", errorCode, errorMessage: storedErrorMessage(errorMessage, secrets) };
}
