// The deletes of `retention.daily` (OBE-056; ota/docs/data-model.md §6, db README §6 "Retention purges", architecture
// §6): the tenant rows that are kept only for a while, each table by the index its purge was given in the baseline.
//
//   Table                        Deleted when                                         Index
//   supplier_requests            created_at before the cut-off (90 days)              supplier_requests_created_idx
//   queue_snapshots              fetched_at before the cut-off (30 days)              queue_snapshots_fetched_idx
//   idempotency_keys             expires_at reached (24 hours after the request)      idempotency_keys_expires_idx
//   customer_sessions            expires_at before the cut-off (expired 7 days ago)   customer_sessions_expires_idx
//   customer_password_resets     expires_at before the cut-off (expired 7 days ago)   customer_password_resets_expires_idx
//   booking_access_tokens        expires_at before the cut-off (expired 7 days ago)   booking_access_tokens_expires_idx
//
// Each method deletes at most `limit` rows of one table in one statement and answers how many it deleted. The rows
// are chosen without an order (any rows past the limit will do, and the index scan stops at `limit`) and locked
// `FOR UPDATE SKIP LOCKED`, so a row another transaction holds (an idempotency record whose retention ended being
// replaced by a new request, a session row being refreshed) is left to the next run instead of making the job wait.
// The two tables indexed per environment name both environments, so their index's leading column is bound.
//
// What a delete touches besides its rows is what the baseline's foreign keys say: a purged supplier request is
// unlinked from the booking events and queue snapshots that named it (`supplier_request_id`, ON DELETE SET NULL; the
// event itself stays), a purged session from the older generation that names it as its replacement (`replaced_by_id`,
// SET NULL; a family's generations expire together, so they normally go in one batch). Nothing here
// deletes a booking, payment, refund, event, document, staff action, customer or notification. Like every tenant
// repository it takes the `tenantTx` transaction first, never opens one and never names a tenant schema.
import { Injectable } from "@nestjs/common";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** Both environments of a tenant: the leading column of the per-environment indexes. */
const ENVIRONMENTS = ["test", "live"];

@Injectable()
export class RetentionRepository {
  /** Supplier requests (Amadeus calls) made before `createdBefore`. */
  async supplierRequests(trx: TenantTransaction, createdBefore: Date, limit: number): Promise<number> {
    const batch = trx
      .selectFrom("supplier_requests")
      .select("id")
      .where("environment", "in", ENVIRONMENTS)
      .where("created_at", "<", createdBefore)
      .limit(limit)
      .forUpdate()
      .skipLocked();
    const result = await trx.deleteFrom("supplier_requests").where("id", "in", batch).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Queue snapshots (Queue List answers) fetched before `fetchedBefore`. */
  async queueSnapshots(trx: TenantTransaction, fetchedBefore: Date, limit: number): Promise<number> {
    const batch = trx
      .selectFrom("queue_snapshots")
      .select("id")
      .where("environment", "in", ENVIRONMENTS)
      .where("fetched_at", "<", fetchedBefore)
      .limit(limit)
      .forUpdate()
      .skipLocked();
    const result = await trx.deleteFrom("queue_snapshots").where("id", "in", batch).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Idempotency records whose retention has ended at `now` (`expires_at` reached), as the idempotency service treats
   * them: a key past its retention starts afresh (common/http/idempotency.service.ts).
   */
  async idempotencyKeys(trx: TenantTransaction, now: Date, limit: number): Promise<number> {
    const batch = trx
      .selectFrom("idempotency_keys")
      .select("id")
      .where("expires_at", "<=", now)
      .limit(limit)
      .forUpdate()
      .skipLocked();
    const result = await trx.deleteFrom("idempotency_keys").where("id", "in", batch).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Customer sessions (refresh token generations) that expired before `expiredBefore`. A generation expires with its
   * family (`expires_at = family_expires_at`, sessions.repository.ts), so a live family keeps all its rows and the
   * reuse detection of its rotated tokens.
   */
  async customerSessions(trx: TenantTransaction, expiredBefore: Date, limit: number): Promise<number> {
    const batch = trx
      .selectFrom("customer_sessions")
      .select("id")
      .where("expires_at", "<", expiredBefore)
      .limit(limit)
      .forUpdate()
      .skipLocked();
    const result = await trx.deleteFrom("customer_sessions").where("id", "in", batch).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Password reset tokens, used or not, that expired before `expiredBefore`. */
  async passwordResets(trx: TenantTransaction, expiredBefore: Date, limit: number): Promise<number> {
    const batch = trx
      .selectFrom("customer_password_resets")
      .select("id")
      .where("expires_at", "<", expiredBefore)
      .limit(limit)
      .forUpdate()
      .skipLocked();
    const result = await trx
      .deleteFrom("customer_password_resets")
      .where("id", "in", batch)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Guest booking access tokens, revoked or not, that expired before `expiredBefore`. */
  async bookingAccessTokens(trx: TenantTransaction, expiredBefore: Date, limit: number): Promise<number> {
    const batch = trx
      .selectFrom("booking_access_tokens")
      .select("id")
      .where("expires_at", "<", expiredBefore)
      .limit(limit)
      .forUpdate()
      .skipLocked();
    const result = await trx.deleteFrom("booking_access_tokens").where("id", "in", batch).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
