// The `credential_submissions` repository (PBE-052; platform/docs/architecture.md §2.1: CommonModule owns the table as
// a shared repository; PADR-0010, data-model-migration-0002.md). A submission holds the OTA's own Amadeus credentials
// or Stripe API keys while a worker job verifies them: the non-secret fields in `public_data`, the secrets in
// `secret_ciphertext` and `webhook_secret_ciphertext`, each envelope-encrypted with the associated data
// `platform.credential_submissions.<column>:<id>` (ADR-0010, `secretPlace`). Kysely on the process's `PLATFORM_DB`,
// schema-qualified tables (ADR-0005).
//
// - **One open submission** (`pending`, `verifying`) per tenant, kind and environment: the partial unique index
//   `credential_submissions_open_uq`. A new submission takes the slot's transaction-level advisory lock first
//   (`lockSlot`), so two submissions at the same time run one after the other and the second supersedes the first
//   instead of failing on the index.
// - **Secrets are erased** in the same UPDATE that sets a final status (`applied`, `failed`, `superseded`), as the
//   CHECK `credential_submissions_secret_purge_ck` requires.
// - Every read that answers the API selects the row without its ciphertexts (`CredentialSubmissionView`); only
//   `startAttempt`, the worker's first step of a verification attempt, returns them.
// - The submitter's e-mail reads the account and its active membership of the tenant, and the OTA's name and key, read
//   only (`emailRecipient`, `tenantLabel`), as payout-accounts.repository.ts reads the owners.
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../../audit/audit.repository";
import type { CiphertextPlace } from "../crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../database";

/** A `platform.credential_submissions` row with its ciphertexts: decrypt them in the worker only, never answer them. */
export type CredentialSubmissionRecord = Selectable<PlatformDatabase["platform.credential_submissions"]>;

/** A submission row without its ciphertexts: what the API may read to answer. */
export type CredentialSubmissionView = Omit<
  CredentialSubmissionRecord,
  "secret_ciphertext" | "webhook_secret_ciphertext"
>;

/** The kinds of `credential_submissions.kind` (PADR-0010 item 1). */
export const CREDENTIAL_KINDS = Object.freeze(["amadeus", "stripe_api_keys"] as const);

/** A kind of CREDENTIAL_KINDS: own Amadeus credentials or own Stripe API keys. */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** The environments of `credential_submissions.environment`. */
export type CredentialEnvironment = "test" | "live";

/** The open statuses, which hold the secrets (PADR-0010 item 2). */
export const OPEN_SUBMISSION_STATUSES = Object.freeze(["pending", "verifying"] as const);

/** The final statuses, which hold no secret (PADR-0010 item 3). */
export const FINAL_SUBMISSION_STATUSES = Object.freeze(["applied", "failed", "superseded"] as const);

/** A status of `credential_submissions.status`. */
export type CredentialSubmissionStatus =
  (typeof OPEN_SUBMISSION_STATUSES)[number] | (typeof FINAL_SUBMISSION_STATUSES)[number];

/** The two ciphertext columns, by the secret they hold. */
export const SECRET_COLUMNS = Object.freeze({
  /** The Amadeus client secret or the Stripe secret (or restricted) key. */
  secret: "secret_ciphertext",
  /** The Stripe webhook signing secret (`stripe_api_keys` only). */
  webhookSecret: "webhook_secret_ciphertext",
} as const);

/** A ciphertext column of the table. */
export type SecretColumn = (typeof SECRET_COLUMNS)[keyof typeof SECRET_COLUMNS];

/** The place of a submission's secret, for the envelope's associated data. */
export function secretPlace(column: SecretColumn, submissionId: string): CiphertextPlace {
  return { table: "credential_submissions", column, rowId: submissionId };
}

/** True for `kind` values of CREDENTIAL_KINDS. */
export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === "string" && (CREDENTIAL_KINDS as readonly string[]).includes(value);
}

/** The columns of a `CredentialSubmissionView`: every column but the two ciphertexts. */
const VIEW_COLUMNS = [
  "id",
  "tenant_id",
  "kind",
  "environment",
  "public_data",
  "encryption_key_id",
  "status",
  "error_code",
  "error_message",
  "attempts",
  "submitted_by_account_id",
  "finished_at",
  "created_at",
  "updated_at",
] as const;

/** The columns a new submission writes. */
export interface CredentialSubmissionWrite {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: CredentialKind;
  readonly environment: CredentialEnvironment;
  /** The non-secret fields, as a JSON object. */
  readonly publicData: Readonly<Record<string, unknown>>;
  /** The envelope of the secret, bound to the row (`secretPlace("secret_ciphertext", id)`). */
  readonly secretCiphertext: Uint8Array;
  /** The envelope of the webhook secret, bound to the row, or `null`. */
  readonly webhookSecretCiphertext: Uint8Array | null;
  /** The KEK that wraps both data keys. */
  readonly encryptionKeyId: string;
  readonly submittedByAccountId: string;
  readonly now: Date;
}

/** A final outcome written by the worker: the verified credentials were applied, or the verification failed. */
export type CredentialSubmissionOutcome =
  | { readonly status: "applied" }
  | { readonly status: "failed"; readonly errorCode: string; readonly errorMessage: string };

/** A superseded submission: its id and the open status it had. */
export interface SupersededSubmission {
  readonly id: string;
  readonly previousStatus: string;
}

/** The submitter of a submission, as its e-mail addresses them. */
export interface SubmissionRecipient {
  readonly account_id: string;
  readonly email: string;
  readonly full_name: string;
}

/** The OTA's name, key and status, as the e-mails name it. */
export interface SubmissionTenantLabel {
  readonly name: string;
  readonly key: string;
  readonly status: string;
  readonly deleted_at: Date | null;
}

@Injectable()
export class CredentialSubmissionsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * Waits until no other transaction holds the lock of the tenant's submissions of `kind` and `environment`, and
   * holds it until `trx` ends (`pg_advisory_xact_lock`).
   */
  async lockSlot(
    trx: PlatformTransaction,
    tenantId: string,
    kind: CredentialKind,
    environment: CredentialEnvironment,
  ): Promise<void> {
    const key = `platform.credential_submissions:${tenantId}:${kind}:${environment}`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
  }

  /**
   * Marks the open submission of the tenant, kind and environment `superseded` in `trx`, with both secrets erased and
   * `finished_at`; answers what it marked (none, or the one row the partial unique index allows).
   */
  async supersedeOpen(
    trx: PlatformTransaction,
    slot: {
      readonly tenantId: string;
      readonly kind: CredentialKind;
      readonly environment: CredentialEnvironment;
      readonly now: Date;
    },
  ): Promise<SupersededSubmission[]> {
    // The open rows are locked first (the worker's final transaction locks a submission too), then updated.
    const open = await trx
      .selectFrom("platform.credential_submissions")
      .select(["id", "status"])
      .where("tenant_id", "=", slot.tenantId)
      .where("kind", "=", slot.kind)
      .where("environment", "=", slot.environment)
      .where("status", "in", OPEN_SUBMISSION_STATUSES)
      .orderBy("id")
      .forUpdate()
      .execute();
    if (open.length === 0) {
      return [];
    }
    await trx
      .updateTable("platform.credential_submissions")
      .set({
        status: "superseded" satisfies CredentialSubmissionStatus,
        secret_ciphertext: null,
        webhook_secret_ciphertext: null,
        finished_at: slot.now,
        updated_at: slot.now,
      })
      .where(
        "id",
        "in",
        open.map((row) => row.id),
      )
      .execute();
    return open.map((row) => ({ id: row.id, previousStatus: row.status }));
  }

  /** Inserts a `pending` submission in `trx`; the row comes back without its ciphertexts. */
  async insert(
    trx: PlatformTransaction,
    write: CredentialSubmissionWrite,
  ): Promise<CredentialSubmissionView> {
    return trx
      .insertInto("platform.credential_submissions")
      .values({
        id: write.id,
        tenant_id: write.tenantId,
        kind: write.kind,
        environment: write.environment,
        public_data: JSON.stringify(write.publicData),
        secret_ciphertext: Buffer.from(write.secretCiphertext),
        webhook_secret_ciphertext:
          write.webhookSecretCiphertext === null ? null : Buffer.from(write.webhookSecretCiphertext),
        encryption_key_id: write.encryptionKeyId,
        status: "pending" satisfies CredentialSubmissionStatus,
        attempts: 0,
        submitted_by_account_id: write.submittedByAccountId,
        created_at: write.now,
        updated_at: write.now,
      })
      .returning(VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** The tenant's submission without its ciphertexts; `undefined` for a submission of another tenant or none. */
  async findForTenant(tenantId: string, submissionId: string): Promise<CredentialSubmissionView | undefined> {
    return this.db
      .selectFrom("platform.credential_submissions")
      .select(VIEW_COLUMNS)
      .where("id", "=", submissionId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
  }

  /** A submission without its ciphertexts, read on `db` (the pool, or the caller's transaction). */
  async find(
    submissionId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<CredentialSubmissionView | undefined> {
    return db
      .selectFrom("platform.credential_submissions")
      .select(VIEW_COLUMNS)
      .where("id", "=", submissionId)
      .executeTakeFirst();
  }

  /**
   * The worker's first step of an attempt: an open submission (`pending`, or `verifying` after a crash or a retry)
   * becomes `verifying` with `attempts + 1`, in one statement. The row comes back **with** its ciphertexts, for the
   * verification; `undefined` when the submission is final or gone.
   */
  async startAttempt(submissionId: string, now: Date): Promise<CredentialSubmissionRecord | undefined> {
    return this.db
      .updateTable("platform.credential_submissions")
      .set((eb) => ({
        status: "verifying" satisfies CredentialSubmissionStatus,
        attempts: eb("attempts", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", submissionId)
      .where("status", "in", OPEN_SUBMISSION_STATUSES)
      .returningAll()
      .executeTakeFirst();
  }

  /** The submission without its ciphertexts, locked for the rest of `trx` (`FOR UPDATE`). */
  async lock(trx: PlatformTransaction, submissionId: string): Promise<CredentialSubmissionView | undefined> {
    return trx
      .selectFrom("platform.credential_submissions")
      .select(VIEW_COLUMNS)
      .where("id", "=", submissionId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Writes the final outcome of a submission locked by `lock` in `trx`: `applied`, or `failed` with the error code and
   * the sanitised message, both secrets erased, `finished_at`. The row comes back without its ciphertexts.
   */
  async finish(
    trx: PlatformTransaction,
    submissionId: string,
    outcome: CredentialSubmissionOutcome,
    now: Date,
  ): Promise<CredentialSubmissionView> {
    return trx
      .updateTable("platform.credential_submissions")
      .set({
        status: outcome.status,
        error_code: outcome.status === "failed" ? outcome.errorCode : null,
        error_message: outcome.status === "failed" ? outcome.errorMessage : null,
        secret_ciphertext: null,
        webhook_secret_ciphertext: null,
        finished_at: now,
        updated_at: now,
      })
      .where("id", "=", submissionId)
      .returning(VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * The submitter, when the account is neither disabled nor deleted and still holds an active membership of the
   * tenant (read only, in `trx`): a person who left the OTA hears nothing more about its connections.
   */
  async emailRecipient(
    trx: PlatformTransaction,
    tenantId: string,
    accountId: string,
  ): Promise<SubmissionRecipient | undefined> {
    return trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(["m.account_id", "a.email", "a.full_name"])
      .where("m.tenant_id", "=", tenantId)
      .where("m.account_id", "=", accountId)
      .where("m.status", "=", "active")
      .where("a.status", "not in", ["disabled", "deleted"])
      .where("a.deleted_at", "is", null)
      .executeTakeFirst();
  }

  /** The OTA's name, key and status (read only, in `trx`). */
  async tenantLabel(trx: PlatformTransaction, tenantId: string): Promise<SubmissionTenantLabel | undefined> {
    return trx
      .selectFrom("platform.tenants")
      .select(["name", "key", "status", "deleted_at"])
      .where("id", "=", tenantId)
      .executeTakeFirst();
  }
}
