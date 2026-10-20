// The tables of the notifications module (OBE-030; OADR-0013 items 1–3, db README §6 and §8): the outbox
// `notifications`, the tenant's `notification_templates` and the sender columns of `storefront_settings`. Every method
// takes the caller's tenant transaction first (`TenantTx.run`, never a schema-qualified name), as conventions §2 says.
//
// The life of an outbox row:
//
//   insert (pending, in the business transaction) ──claimDue──▶ pending with a lease ──markSent──▶ sent
//                                                                    │
//                                                                    ├──markRetry──▶ pending, due again later
//                                                                    ├──release────▶ pending, due again (no attempt)
//                                                                    └──markFailed─▶ failed
//
// A claim is a lease, not a status: `claimDue` takes due `pending` rows with `FOR UPDATE SKIP LOCKED` and moves their
// `next_attempt_at` to the end of the lease (OADR-0014 point 6, "claims instead of long locks"), in a transaction of
// its own that commits before anything is sent. The row stays `pending` (`sending` is not used), so the partial index
// `notifications_outbox_idx` (next_attempt_at WHERE status = 'pending') also finds the claim of a worker that stopped
// once its lease is over, and no other query is needed to recover it. The lease's end is the claim's fencing token:
// every later update of the row names it, so a worker whose lease ran out and was taken over changes nothing.
//
// `markSent` and `markFailed` erase `secret_payload_ciphertext` in the same update that sets the final status
// (`notifications_secret_purge_ck` refuses anything else), and record when in `secrets_purged_at`.
import { Injectable } from "@nestjs/common";
import { sql, type Selectable, type TenantDatabase } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** A row of `notifications`. */
export type NotificationRow = Selectable<TenantDatabase["notifications"]>;

/** A row of `notification_templates`. */
export type NotificationTemplateRow = Selectable<TenantDatabase["notification_templates"]>;

/** Who receives a notification (`notifications.recipient_type`). */
export type RecipientType = "customer" | "guest" | "staff";

/** A new outbox row. */
export interface NotificationInsert {
  /** `ntf_…` */
  readonly id: string;
  readonly templateKey: string;
  readonly channel: "email";
  readonly recipient: string;
  readonly recipientType: RecipientType;
  readonly customerId: string | null;
  readonly bookingId: string | null;
  readonly locale: string;
  /** The JSON text of the redacted, non-secret variables (jsonb columns are written as JSON text). */
  readonly payloadJson: string;
  readonly secretPayloadCiphertext: Buffer | null;
  /** The KEK of the ciphertext; `null` with it. */
  readonly encryptionKeyId: string | null;
  readonly dedupeKey: string | null;
  /** `created_at`, `updated_at` and the first `next_attempt_at`. */
  readonly now: Date;
}

/** A claimed row and the lease that fences it. */
export interface Lease {
  readonly id: string;
  /** The `next_attempt_at` the claim wrote: the end of the lease. */
  readonly until: Date;
}

/** The sender columns of the tenant's `storefront_settings`. */
export interface SenderSettings {
  readonly brandName: string;
  readonly supportEmail: string | null;
  readonly supportPhone: string | null;
}

@Injectable()
export class OutboxRepository {
  /**
   * Inserts a `pending` row, due at once. With a `dedupeKey` that another row holds already (`notifications_dedupe_uq`)
   * nothing is inserted and it returns false; a concurrent transaction inserting the same key makes this one wait for
   * its end, so one key never gives two e-mails.
   */
  async insert(trx: TenantTransaction, row: NotificationInsert): Promise<boolean> {
    const inserted = await trx
      .insertInto("notifications")
      .values({
        id: row.id,
        template_key: row.templateKey,
        channel: row.channel,
        recipient: row.recipient,
        recipient_type: row.recipientType,
        customer_id: row.customerId,
        booking_id: row.bookingId,
        locale: row.locale,
        payload: row.payloadJson,
        secret_payload_ciphertext: row.secretPayloadCiphertext,
        encryption_key_id: row.encryptionKeyId,
        dedupe_key: row.dedupeKey,
        status: "pending",
        next_attempt_at: row.now,
        created_at: row.now,
        updated_at: row.now,
      })
      .onConflict((conflict) => conflict.column("dedupe_key").where("dedupe_key", "is not", null).doNothing())
      .returning("id")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** The id of the row that holds `dedupeKey`, or `undefined`. */
  async idByDedupeKey(trx: TenantTransaction, dedupeKey: string): Promise<string | undefined> {
    const row = await trx
      .selectFrom("notifications")
      .select("id")
      .where("dedupe_key", "=", dedupeKey)
      .executeTakeFirst();
    return row?.id;
  }

  /** The row, or `undefined`. */
  async find(trx: TenantTransaction, id: string): Promise<NotificationRow | undefined> {
    return trx.selectFrom("notifications").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /**
   * Claims at most `limit` rows that are due at `now` (`pending`, `next_attempt_at <= now`), the oldest due first,
   * skipping rows another transaction holds, and moves their `next_attempt_at` to `leaseUntil`. Returns them as they
   * were claimed (with the new `next_attempt_at`).
   */
  async claimDue(
    trx: TenantTransaction,
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<NotificationRow[]> {
    const due = trx
      .selectFrom("notifications")
      .select("id")
      .where("status", "=", "pending")
      .where("next_attempt_at", "<=", now)
      .orderBy("next_attempt_at")
      .orderBy("id")
      .limit(limit)
      .forUpdate()
      .skipLocked();
    const rows = await trx
      .updateTable("notifications")
      .set({ next_attempt_at: leaseUntil, updated_at: now })
      .where("id", "in", due)
      .returningAll()
      .execute();
    // UPDATE … RETURNING keeps no order: the batch is sent oldest first.
    return rows.sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** True when the tenant has at least one `pending` row due at `now` (the sweep's question). */
  async hasDue(trx: TenantTransaction, now: Date): Promise<boolean> {
    const row = await trx
      .selectFrom("notifications")
      .select(sql<number>`1`.as("due"))
      .where("status", "=", "pending")
      .where("next_attempt_at", "<=", now)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The claimed row was sent: `sent`, one more attempt, the rendered subject, the template used, the provider and its
   * message id, and the secrets erased in the same update. False when the lease is no longer this claim's.
   */
  async markSent(
    trx: TenantTransaction,
    lease: Lease,
    sent: {
      readonly subject: string;
      readonly templateId: string | null;
      readonly provider: string;
      readonly providerMessageId: string;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const result = await trx
      .updateTable("notifications")
      .set((eb) => ({
        status: "sent",
        attempts: eb("attempts", "+", 1),
        subject: sent.subject,
        template_id: sent.templateId,
        provider: sent.provider,
        provider_message_id: sent.providerMessageId,
        sent_at: sent.now,
        last_error: null,
        secret_payload_ciphertext: null,
        secrets_purged_at: eb
          .case()
          .when("secret_payload_ciphertext", "is not", null)
          .then(sent.now)
          .else(eb.ref("secrets_purged_at"))
          .end(),
        updated_at: sent.now,
      }))
      .where("id", "=", lease.id)
      .where("status", "=", "pending")
      .where("next_attempt_at", "=", lease.until)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * An attempt of the claimed row failed and another one is due at `nextAttemptAt`: one more attempt and the error,
   * which holds no secret. False when the lease is no longer this claim's.
   */
  async markRetry(
    trx: TenantTransaction,
    lease: Lease,
    retry: { readonly error: string; readonly nextAttemptAt: Date; readonly now: Date },
  ): Promise<boolean> {
    const result = await trx
      .updateTable("notifications")
      .set((eb) => ({
        attempts: eb("attempts", "+", 1),
        last_error: retry.error,
        next_attempt_at: retry.nextAttemptAt,
        updated_at: retry.now,
      }))
      .where("id", "=", lease.id)
      .where("status", "=", "pending")
      .where("next_attempt_at", "=", lease.until)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * The claimed row was not tried (SMTP is down, or the batch ran out of time): due again at `nextAttemptAt`, without
   * an attempt. False when the lease is no longer this claim's.
   */
  async release(trx: TenantTransaction, lease: Lease, nextAttemptAt: Date, now: Date): Promise<boolean> {
    const result = await trx
      .updateTable("notifications")
      .set({ next_attempt_at: nextAttemptAt, updated_at: now })
      .where("id", "=", lease.id)
      .where("status", "=", "pending")
      .where("next_attempt_at", "=", lease.until)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * The claimed row will never be sent (its last attempt failed, or it cannot be rendered): `failed` with the error,
   * which holds no secret, one more attempt when `attempted`, and the secrets erased in the same update. False when the
   * lease is no longer this claim's.
   */
  async markFailed(
    trx: TenantTransaction,
    lease: Lease,
    failure: {
      readonly error: string;
      readonly attempted: boolean;
      readonly templateId?: string | null | undefined;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const result = await trx
      .updateTable("notifications")
      .set((eb) => ({
        status: "failed",
        attempts: failure.attempted ? eb("attempts", "+", 1) : eb.ref("attempts"),
        last_error: failure.error,
        ...(failure.templateId === undefined ? {} : { template_id: failure.templateId }),
        secret_payload_ciphertext: null,
        secrets_purged_at: eb
          .case()
          .when("secret_payload_ciphertext", "is not", null)
          .then(failure.now)
          .else(eb.ref("secrets_purged_at"))
          .end(),
        updated_at: failure.now,
      }))
      .where("id", "=", lease.id)
      .where("status", "=", "pending")
      .where("next_attempt_at", "=", lease.until)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** The active tenant templates of `key` and `channel` in any of `locales`. */
  async activeTemplates(
    trx: TenantTransaction,
    key: string,
    channel: string,
    locales: readonly string[],
  ): Promise<NotificationTemplateRow[]> {
    if (locales.length === 0) {
      return [];
    }
    return trx
      .selectFrom("notification_templates")
      .selectAll()
      .where("key", "=", key)
      .where("channel", "=", channel)
      .where("locale", "in", [...locales])
      .where("is_active", "=", true)
      .execute();
  }

  /** The sender columns of the tenant's settings row, or `undefined` before the tenant is seeded. */
  async senderSettings(trx: TenantTransaction): Promise<SenderSettings | undefined> {
    const row = await trx
      .selectFrom("storefront_settings")
      .select(["brand_name", "support_email", "support_phone"])
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { brandName: row.brand_name, supportEmail: row.support_email, supportPhone: row.support_phone };
  }
}
