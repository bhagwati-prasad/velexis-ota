// The consumer of `platform-connections` (platform/docs/architecture.md §5, concurrency 2): the verification jobs of
// supplier and payment credentials. BullMQ hands any job of a queue to any of its workers, so this is the queue's one
// processor; it dispatches on the job name: `amadeus_account.verify {amadeusAccountId}` (PBE-020,
// flows/amadeus-connection.md §A step 2) here, and `credentials.verify {submissionId}`, the verification of the OTA's
// own credentials (PBE-052, PADR-0010), with CredentialsVerifyProcessor of common/credentials, whose registry holds the
// verifier of each kind (PBE-053, PBE-057). A job of another name fails at once (`UnrecoverableError`).
//
// `amadeus_account.verify`, queued by the admin's create, update and verify of a Velexis Amadeus account:
//
// 1. Read the account and decrypt its client secret (associated data
//    `platform.amadeus_accounts.client_secret_ciphertext:<id>`); the plaintext lives in memory for the one request.
//    A `disabled` account is left alone (`superseded`, no request): it was disabled after the job was queued, for
//    example while the job waited for a retry, and a job queued before the disable must not undo it.
//    adminVerifyAmadeusAccount takes a disabled account to `pending_verification` before it queues its job.
// 2. Request an OAuth token from the account's host (AmadeusOAuthGateway: 10-second timeout, token discarded), outside
//    any transaction.
// 3. In one transaction, with the row locked, write the outcome, unless the host, client id, secret or status changed
//    while the request ran (an update queued its own verification; a disabled account stays disabled): the result is
//    about the credentials it tested.
//    - a token: `active`, `last_verified_at`, no `last_error`; audit `amadeus_account.verified`;
//    - refused (`rejected`, or a secret that does not decrypt): `invalid_credentials` with the short `last_error` (HTTP
//      status and Amadeus code, never the body); audit `amadeus_account.verification_failed`;
//    - Amadeus unavailable (5xx, 429, timeout, network): `last_error` only, and the job fails, so BullMQ tries again
//      (5 attempts, backoff from 30 s). After the last attempt the account becomes `invalid_credentials`, except an
//      `active` one: its credentials worked before, and an Amadeus outage is no reason to stop every OTA on the shared
//      account (the OTA backend refuses an account that is not `active`); it keeps `active` with the `last_error`.
//    A changed status is published as an `amadeus_account` invalidation after the commit, so the OTA backend drops
//    its cached account at once.
//
// Neither the secret nor the token is logged, stored, queued or returned: the job data is the account id, the result
// is the id and the status, and the log lines carry the id, the environment, the outcome and the short error.
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../audit/audit.service";
import { Clock } from "../common/clock";
import { CREDENTIALS_VERIFY_JOB } from "../common/credentials/credential-submissions.service";
import {
  CredentialsVerifyProcessor,
  type CredentialsVerifyResult,
} from "../common/credentials/credentials-verify.processor";
import { EnvelopeService } from "../common/crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { PLATFORM_QUEUE, platformWorkerOptions } from "../common/queues/queue-names";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { isLastTry } from "../notifications/email.processor";
import {
  AmadeusAccountsRepository,
  CLIENT_SECRET_COLUMN,
  type AmadeusAccountRecord,
  type AmadeusAccountStatus,
  type AmadeusAccountVerification,
} from "./amadeus-accounts.repository";
import { AmadeusOAuthGateway, type AmadeusTokenCheck } from "./amadeus-oauth.gateway";

/** The job that verifies a Velexis Amadeus account. */
export const AMADEUS_ACCOUNT_VERIFY_JOB = "amadeus_account.verify";

/** The payload of `amadeus_account.verify`: the account's id, nothing else (ADR-0009). */
export interface AmadeusAccountVerifyJobData {
  readonly amadeusAccountId: string;
}

/** What a finished `amadeus_account.verify` job returns (BullMQ keeps it): the id and what happened. */
export interface AmadeusAccountVerifyResult {
  readonly amadeusAccountId: string;
  /** The status written, or `missing` (no such account) or `superseded` (the account changed meanwhile). */
  readonly status: AmadeusAccountStatus | "missing" | "superseded";
}

const AMADEUS_ACCOUNT_ID = /^ama_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The account id of an `amadeus_account.verify` payload, or `undefined` when it is not `{ amadeusAccountId }`. */
export function amadeusAccountIdOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const id = (data as Partial<AmadeusAccountVerifyJobData>).amadeusAccountId;
  return Object.keys(data).length === 1 && typeof id === "string" && AMADEUS_ACCOUNT_ID.test(id)
    ? id
    : undefined;
}

/** The place of an account's client secret, for the envelope's associated data. */
export function clientSecretPlace(accountId: string) {
  return { ...CLIENT_SECRET_COLUMN, rowId: accountId };
}

/** The Amadeus answer, or the error that stopped the check before it asked (a secret that does not decrypt). */
type CheckOutcome = AmadeusTokenCheck | { readonly outcome: "undecryptable"; readonly error: string };

/** The fields the verification depends on: when one of them changed meanwhile, its result is not written. */
function sameCredentials(a: AmadeusAccountRecord, b: AmadeusAccountRecord): boolean {
  return (
    a.base_url === b.base_url &&
    a.client_id === b.client_id &&
    a.status === b.status &&
    Buffer.from(a.client_secret_ciphertext).equals(Buffer.from(b.client_secret_ciphertext))
  );
}

/**
 * The verification fields to write for `check` on an account in `status`, or `undefined` to write nothing but the
 * error of an attempt that BullMQ tries again (see the file header).
 */
export function verificationOutcome(
  check: CheckOutcome,
  status: string,
  final: boolean,
  now: Date,
): { readonly fields: AmadeusAccountVerification; readonly retry: boolean } {
  switch (check.outcome) {
    case "verified":
      return { fields: { status: "active", last_error: null, last_verified_at: now }, retry: false };
    case "rejected":
    case "undecryptable":
      return { fields: { status: "invalid_credentials", last_error: check.error }, retry: false };
    case "unavailable": {
      const keep = !final || status === "active";
      return {
        fields: {
          status: keep ? (status as AmadeusAccountStatus) : "invalid_credentials",
          last_error: check.error,
        },
        retry: !final,
      };
    }
  }
}

/** An attempt that BullMQ tries again: Amadeus could not answer. The message holds the short error only. */
export class AmadeusUnavailableError extends Error {
  override readonly name = "AmadeusUnavailableError";
}

@Processor(PLATFORM_QUEUE.connections, platformWorkerOptions(PLATFORM_QUEUE.connections))
export class VerificationProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly accounts: AmadeusAccountsRepository,
    private readonly gateway: AmadeusOAuthGateway,
    private readonly envelope: EnvelopeService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(VerificationProcessor.name) private readonly logger: PinoLogger,
    private readonly credentials: CredentialsVerifyProcessor,
  ) {
    super();
  }

  async process(job: Job): Promise<AmadeusAccountVerifyResult | CredentialsVerifyResult> {
    switch (job.name) {
      case AMADEUS_ACCOUNT_VERIFY_JOB:
        return this.verifyAccount(job);
      case CREDENTIALS_VERIFY_JOB:
        return this.credentials.process(job);
      default:
        this.logger.error({ queue: PLATFORM_QUEUE.connections, job: job.name }, "connections.unknown_job");
        throw new UnrecoverableError("platform-connections has no job of this name");
    }
  }

  /** Errors of the worker itself (its Redis connections); job failures are logged by the job. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: PLATFORM_QUEUE.connections, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }

  /** One attempt of `amadeus_account.verify` (see the file header). */
  async verifyAccount(job: Job): Promise<AmadeusAccountVerifyResult> {
    const amadeusAccountId = amadeusAccountIdOf(job.data);
    if (amadeusAccountId === undefined) {
      this.logger.error({ queue: PLATFORM_QUEUE.connections, job: job.name }, "amadeus_account.invalid_job");
      throw new UnrecoverableError(
        "amadeus_account.verify needs { amadeusAccountId: ama_… } and nothing else",
      );
    }
    const tested = await this.accounts.find(amadeusAccountId);
    if (tested === undefined) {
      this.logger.warn({ amadeusAccountId }, "amadeus_account.verify_skipped");
      return { amadeusAccountId, status: "missing" };
    }
    if (tested.status === "disabled") {
      // Disabled after this job was queued (see the file header): the admin's disable wins, and no secret is sent.
      this.logger.info(
        { amadeusAccountId, environment: tested.environment, attempt: job.attemptsMade + 1 },
        "amadeus_account.verify_superseded",
      );
      return { amadeusAccountId, status: "superseded" };
    }
    const check = await this.check(tested);
    const final = isLastTry(job);
    const outcome = verificationOutcome(check, tested.status, final, this.clock.now());
    const context = {
      amadeusAccountId,
      environment: tested.environment,
      outcome: check.outcome,
      attempt: job.attemptsMade + 1,
    };

    const written = await runInTransaction(this.db, async (trx) => {
      const current = await this.accounts.lock(trx, amadeusAccountId);
      if (current === undefined || !sameCredentials(current, tested)) {
        return undefined;
      }
      const row = await this.accounts.recordVerification(
        trx,
        amadeusAccountId,
        outcome.fields,
        this.clock.now(),
      );
      if (!outcome.retry) {
        await this.audit.record(trx, {
          actorType: "system",
          actorLabel: AMADEUS_ACCOUNT_VERIFY_JOB,
          action:
            check.outcome === "verified" ? "amadeus_account.verified" : "amadeus_account.verification_failed",
          targetType: "amadeus_account",
          targetId: amadeusAccountId,
          before: { status: current.status },
          after: { status: row.status },
          details: {
            environment: row.environment,
            outcome: check.outcome,
            ...(row.last_error === null ? {} : { lastError: row.last_error }),
          },
        });
      }
      if (row.status !== current.status) {
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "amadeus_account", id: amadeusAccountId });
      }
      return row;
    });

    if (written === undefined) {
      this.logger.info(context, "amadeus_account.verify_superseded");
      return { amadeusAccountId, status: "superseded" };
    }
    if (check.outcome === "verified") {
      this.logger.info(context, "amadeus_account.verified");
      return { amadeusAccountId, status: "active" };
    }
    this.logger.warn(
      { ...context, final: !outcome.retry, error: check.error, status: written.status },
      "amadeus_account.verification_failed",
    );
    if (outcome.retry) {
      throw new AmadeusUnavailableError(`Amadeus unavailable: ${check.error}`);
    }
    if (check.outcome === "unavailable") {
      // The last attempt: the job ends failed, so the queue views show it, with the outcome written above.
      throw new UnrecoverableError(`Amadeus unavailable: ${check.error}`);
    }
    return { amadeusAccountId, status: written.status as AmadeusAccountStatus };
  }

  /** Decrypts the secret and requests a token with it; the secret's bytes are zeroed when the request is sent. */
  private async check(account: AmadeusAccountRecord): Promise<CheckOutcome> {
    let plaintext: Buffer;
    try {
      plaintext = await this.envelope.decrypt(
        account.client_secret_ciphertext,
        clientSecretPlace(account.id),
      );
    } catch {
      return { outcome: "undecryptable", error: "the stored client secret cannot be decrypted" };
    }
    try {
      return await this.gateway.checkCredentials({
        baseUrl: account.base_url,
        clientId: account.client_id,
        clientSecret: plaintext.toString("utf8"),
      });
    } finally {
      plaintext.fill(0);
    }
  }
}
