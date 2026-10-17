// The `platform.email_outbox` repository (PBE-011; PADR-0013 items 1 to 4, migration 0002). NotificationsModule owns
// the table. Every method takes the executor first: the caller's transaction when an e-mail is queued with a business
// change, the worker's `platformDb` when the processor moves a row through its states:
//
//   pending ──claim──▶ sending ──markSent──▶ sent            (secrets erased in the same update)
//                         │
//                         ├──release──▶ pending              (SMTP failed, BullMQ tries again)
//                         └──markFailed──▶ failed            (last attempt, or an e-mail that can never be sent;
//                                                             secrets erased in the same update)
//
// A CHECK of the table refuses a `sent`, `failed` or `canceled` row that still holds a ciphertext
// (`email_outbox_secret_purge_ck`), so the updates that finalise a row always erase it.
import { Injectable } from "@nestjs/common";
import type { Kysely, PlatformDatabase, ReferenceDatabase, Selectable, Transaction } from "@velexis/db";

type PlatformSchemas = PlatformDatabase & ReferenceDatabase;

/** A transaction on the platform and reference schemas (`runInTransaction(platformDb, …)`). */
export type OutboxTransaction = Transaction<PlatformSchemas>;

/** Where the repository runs its statements: the caller's transaction or the process's `platformDb`. */
export type OutboxExecutor = Kysely<PlatformSchemas> | OutboxTransaction;

/** A row of `platform.email_outbox`. */
export type EmailOutboxRow = Selectable<PlatformDatabase["platform.email_outbox"]>;

/** The states of a row (the table's CHECK). */
export type EmailStatus = "pending" | "sending" | "sent" | "failed" | "canceled";

/** A new row, with the column names of the table. */
export interface EmailOutboxInsert {
  readonly id: string;
  readonly template: string;
  readonly toEmail: string;
  readonly accountId: string | null;
  readonly tenantId: string | null;
  /** The JSON text of the non-secret variables (jsonb columns are written as JSON text). */
  readonly dataJson: string;
  /** The envelope of the secret variables, or `null` when the template has none. */
  readonly secretPayloadCiphertext: Buffer | null;
  /** The KEK of `secretPayloadCiphertext`; `null` with it. */
  readonly encryptionKeyId: string | null;
  /** `created_at` and `updated_at`. */
  readonly now: Date;
}

/** What the sweep looks for. */
export interface SweepCriteria {
  /** `pending` rows created before this time. */
  readonly pendingBefore: Date;
  /** `sending` rows last changed before this time (a worker stopped while it sent them). */
  readonly sendingBefore: Date;
  readonly limit: number;
}

@Injectable()
export class OutboxRepository {
  /**
   * Inserts a `pending` row, unless a row with the same id exists (an e-mail queued with the same idempotency key):
   * `true` when this call inserted it. A concurrent transaction that inserts the same id makes this one wait for its
   * end (the primary key), so the same e-mail is never queued twice.
   */
  async insertIfAbsent(executor: OutboxExecutor, row: EmailOutboxInsert): Promise<boolean> {
    const inserted = await executor
      .insertInto("platform.email_outbox")
      .values({
        id: row.id,
        template: row.template,
        to_email: row.toEmail,
        account_id: row.accountId,
        tenant_id: row.tenantId,
        data: row.dataJson,
        secret_payload_ciphertext: row.secretPayloadCiphertext,
        encryption_key_id: row.encryptionKeyId,
        status: "pending",
        created_at: row.now,
        updated_at: row.now,
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .returning("id")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** The row, or `undefined`. */
  async find(executor: OutboxExecutor, id: string): Promise<EmailOutboxRow | undefined> {
    return executor.selectFrom("platform.email_outbox").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /**
   * Takes a row for one send attempt: a `pending` row, or a `sending` row whose worker stopped during the send (BullMQ
   * gives its job to a worker again), becomes `sending` with one more attempt. `undefined` when the row does not exist
   * or is final already (`sent`, `failed`, `canceled`).
   */
  async claim(executor: OutboxExecutor, id: string, now: Date): Promise<EmailOutboxRow | undefined> {
    return executor
      .updateTable("platform.email_outbox")
      .set((eb) => ({ status: "sending", attempts: eb("attempts", "+", 1), updated_at: now }))
      .where("id", "=", id)
      .where("status", "in", ["pending", "sending"])
      .returningAll()
      .executeTakeFirst();
  }

  /** `sending` → `sent`, with the Message-ID, and the secrets erased in the same update. False if not `sending`. */
  async markSent(executor: OutboxExecutor, id: string, messageId: string, now: Date): Promise<boolean> {
    const result = await executor
      .updateTable("platform.email_outbox")
      .set((eb) => ({
        status: "sent",
        sent_at: now,
        provider_message_id: messageId,
        secret_payload_ciphertext: null,
        secrets_purged_at: eb
          .case()
          .when("secret_payload_ciphertext", "is not", null)
          .then(now)
          .else(eb.ref("secrets_purged_at"))
          .end(),
        updated_at: now,
      }))
      .where("id", "=", id)
      .where("status", "=", "sending")
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** `sending` → `pending` after a failed attempt that BullMQ retries; `error` holds no secret. */
  async release(executor: OutboxExecutor, id: string, error: string, now: Date): Promise<boolean> {
    const result = await executor
      .updateTable("platform.email_outbox")
      .set({ status: "pending", last_error: error, updated_at: now })
      .where("id", "=", id)
      .where("status", "=", "sending")
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * `pending` or `sending` → `failed`, with the secrets erased in the same update: the last attempt failed, or the
   * e-mail can never be sent. `error` holds no secret.
   */
  async markFailed(executor: OutboxExecutor, id: string, error: string, now: Date): Promise<boolean> {
    const result = await executor
      .updateTable("platform.email_outbox")
      .set((eb) => ({
        status: "failed",
        last_error: error,
        secret_payload_ciphertext: null,
        secrets_purged_at: eb
          .case()
          .when("secret_payload_ciphertext", "is not", null)
          .then(now)
          .else(eb.ref("secrets_purged_at"))
          .end(),
        updated_at: now,
      }))
      .where("id", "=", id)
      .where("status", "in", ["pending", "sending"])
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * The ids of the rows the sweep re-enqueues, oldest first: `pending` rows created before `pendingBefore`, and
   * `sending` rows last changed before `sendingBefore` (the partial index `email_outbox_open_idx` holds both).
   */
  async sweepCandidates(executor: OutboxExecutor, criteria: SweepCriteria): Promise<string[]> {
    const rows = await executor
      .selectFrom("platform.email_outbox")
      .select("id")
      .where("status", "in", ["pending", "sending"])
      .where((eb) =>
        eb.or([
          eb.and([eb("status", "=", "pending"), eb("created_at", "<", criteria.pendingBefore)]),
          eb.and([eb("status", "=", "sending"), eb("updated_at", "<", criteria.sendingBefore)]),
        ]),
      )
      .orderBy("created_at")
      .limit(criteria.limit)
      .execute();
    return rows.map((row) => row.id);
  }
}
