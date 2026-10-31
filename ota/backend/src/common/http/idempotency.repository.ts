// The tenant repository of the idempotency records (`idempotency_keys`, architecture-booking.md §5.1, db README §8).
// Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a schema, so
// a record is only ever read or written in the schema of the request's tenant (ADR-0004). The idempotency service
// (idempotency.service.ts) runs each call in a short transaction of its own, never in the handler's.
//
// A record is identified by `(scope, key)` (`idempotency_keys_scope_key_uq`): the scope is
// `<environment>:<principal>:<operationId>`, the key the client's `Idempotency-Key`. Its `status` is `processing`
// while a request holds its lease (`locked_until`), then `completed` (a 2xx answer) or `failed` (a final error);
// transient outcomes delete it. `locked_until` doubles as the holder's token: an outcome is written, and the lease
// renewed while the handler runs (`extendLease`, FIX-W30-OTA), only by the request whose lease is still the record's,
// so a request that lost its lease to a retry never overwrites the retry's outcome nor renews its lease.
import { Injectable } from "@nestjs/common";
import type { Selectable, TenantDatabase, Transaction } from "@velexis/db";

/** The open tenant transaction (`TenantTx.run`). */
type TenantTransaction = Transaction<TenantDatabase>;

/** An `idempotency_keys` row as the pool reads it (jsonb parsed, timestamptz as `Date`, bytea as `Buffer`). */
export type IdempotencyRow = Selectable<TenantDatabase["idempotency_keys"]>;

/** The two final states of a record; `processing` is the state of a record in flight. */
export type IdempotencyFinalStatus = "completed" | "failed";

/** A new record in flight. */
export interface NewIdempotencyRecord {
  /** `idk_…` */
  readonly id: string;
  readonly scope: string;
  readonly key: string;
  readonly requestMethod: string;
  readonly requestPath: string;
  /** SHA-256 (hex) of the canonical request. */
  readonly requestHash: string;
  /** The end of the lease of the request that runs it. */
  readonly lockedUntil: Date;
  /** The end of the retention, also of a record left in flight by a process that died. */
  readonly expiresAt: Date;
  readonly now: Date;
}

/** The outcome of a request, as stored for its replays. */
export interface IdempotencyOutcome {
  readonly status: IdempotencyFinalStatus;
  readonly responseStatus: number;
  /** The replayed headers (no credential, no cookie), or `null` when there are none. */
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  /** The body after the shared redactor, as JSON; `null` for an answer without a body. */
  readonly responseBody: unknown;
  /** The envelope ciphertext of the verbatim answer when it carries a token or unmasked data; else `null`. */
  readonly responseCiphertext: Buffer | null;
  /** The KEK of `responseCiphertext` (`local:v1`); `null` exactly when there is no ciphertext. */
  readonly encryptionKeyId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly expiresAt: Date;
  readonly now: Date;
}

/** A JSON value as a jsonb parameter: its text, so node-postgres never turns an array into a PostgreSQL array. */
function jsonb(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

@Injectable()
export class IdempotencyRepository {
  /**
   * Inserts a record in flight unless `(scope, key)` already has one. Resolves to `true` when this call inserted it,
   * `false` when the key was seen (the caller then reads the existing record with `lockByScopeAndKey`).
   */
  async insertProcessing(trx: TenantTransaction, record: NewIdempotencyRecord): Promise<boolean> {
    const inserted = await trx
      .insertInto("idempotency_keys")
      .values({
        id: record.id,
        scope: record.scope,
        key: record.key,
        request_method: record.requestMethod,
        request_path: record.requestPath,
        request_hash: record.requestHash,
        status: "processing",
        locked_until: record.lockedUntil,
        expires_at: record.expiresAt,
        created_at: record.now,
        updated_at: record.now,
      })
      .onConflict((conflict) => conflict.constraint("idempotency_keys_scope_key_uq").doNothing())
      .returning("id")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** The record of `(scope, key)`, locked until the transaction ends, or `undefined`. */
  async lockByScopeAndKey(
    trx: TenantTransaction,
    scope: string,
    key: string,
  ): Promise<IdempotencyRow | undefined> {
    return await trx
      .selectFrom("idempotency_keys")
      .selectAll()
      .where("scope", "=", scope)
      .where("key", "=", key)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Gives a record in flight whose lease ran out to a new request: its lease becomes `lockedUntil`. */
  async renewLease(trx: TenantTransaction, id: string, lockedUntil: Date, now: Date): Promise<void> {
    await trx
      .updateTable("idempotency_keys")
      .set({ locked_until: lockedUntil, updated_at: now })
      .where("id", "=", id)
      .where("status", "=", "processing")
      .execute();
  }

  /**
   * Renews the lease of the request that holds `lease` while its handler runs (FIX-W30-OTA): the record's
   * `locked_until` becomes `next`, which is the holder's token from then on. Resolves to `false` when the record is no
   * longer that request's (its lease ran out and a waiting request took it over, or the record is gone), and nothing is
   * written then: a lost lease is never renewed by the request that lost it.
   */
  async extendLease(
    trx: TenantTransaction,
    id: string,
    lease: Date,
    next: Date,
    now: Date,
  ): Promise<boolean> {
    const result = await trx
      .updateTable("idempotency_keys")
      .set({ locked_until: next, updated_at: now })
      .where("id", "=", id)
      .where("status", "=", "processing")
      .where("locked_until", "=", lease)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Stores the outcome of the request that holds the lease `lease`. Resolves to `false` when the record is no longer
   * that request's (its lease went to a retry, or the record is gone), and nothing is written then.
   */
  async complete(
    trx: TenantTransaction,
    id: string,
    lease: Date,
    outcome: IdempotencyOutcome,
  ): Promise<boolean> {
    const result = await trx
      .updateTable("idempotency_keys")
      .set({
        status: outcome.status,
        locked_until: null,
        response_status: outcome.responseStatus,
        response_headers: jsonb(outcome.responseHeaders),
        response_body: jsonb(outcome.responseBody),
        response_ciphertext: outcome.responseCiphertext,
        encryption_key_id: outcome.encryptionKeyId,
        resource_type: outcome.resourceType,
        resource_id: outcome.resourceId,
        expires_at: outcome.expiresAt,
        updated_at: outcome.now,
      })
      .where("id", "=", id)
      .where("status", "=", "processing")
      .where("locked_until", "=", lease)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Deletes the record in flight of the request that holds `lease` (a transient outcome: the same key may be sent
   * again). Resolves to `false` when the record is no longer that request's.
   */
  async release(trx: TenantTransaction, id: string, lease: Date): Promise<boolean> {
    const result = await trx
      .deleteFrom("idempotency_keys")
      .where("id", "=", id)
      .where("status", "=", "processing")
      .where("locked_until", "=", lease)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Deletes a record whose retention ended, so its key starts afresh. */
  async deleteExpired(trx: TenantTransaction, id: string, now: Date): Promise<void> {
    await trx.deleteFrom("idempotency_keys").where("id", "=", id).where("expires_at", "<=", now).execute();
  }
}
