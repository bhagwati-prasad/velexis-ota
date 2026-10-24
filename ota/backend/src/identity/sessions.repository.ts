// The `customer_sessions` repository of the identity module (OBE-031; ota/docs/architecture.md §3.2, ADR-0008
// "Refresh tokens", db README §8 "Hashed tokens"). One row per refresh token **generation**: a sign-in (or a sign-up or
// password reset that opens a session) writes the first row of a rotation **family**, whose `id` is also its
// `family_id`, the session id `ses_…` of `AuthSessionDetails.id` and the `sid` of its access tokens. Every refresh
// marks the presented row `rotated_at` / `replaced_by_id` and writes the family's next row. Only the SHA-256 of a
// refresh token is stored (`refresh_token_hash`, unique).
//
// - `family_expires_at` is the family's absolute end (12 hours, 30 days with `remember_me`), copied into every
//   generation and never extended; `expires_at` of a generation is the same instant (the refresh token lives as long
//   as its family);
// - `revoked_at` with `revoke_reason` ends a row; revoking a family revokes every row of it, rotated ones included.
//
// Kysely on the caller's tenant transaction (`TenantTx`, search_path `tenant_<key>`); tables are never
// schema-qualified. Times are the service's `Clock`, never the database's `now()`, so expiry follows a fake clock in
// tests.
import { Injectable } from "@nestjs/common";
import type { Selectable, TenantDatabase } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** A `customer_sessions` row as the API reads it. */
export type CustomerSessionRecord = Selectable<TenantDatabase["customer_sessions"]>;

/** Why a row was revoked (`customer_sessions.revoke_reason`, tenant baseline). */
export type SessionRevokeReason =
  "logout" | "rotation_reuse" | "password_change" | "admin" | "expired" | "account_deleted";

/** A new row: the first of a family, or the next generation of one. */
export interface NewCustomerSession {
  /** `ses_…` */
  readonly id: string;
  readonly customerId: string;
  /** The identity used to sign in (`cid_…`), when there is one. */
  readonly identityId: string | null;
  /** The family: the row's own `id` for the first row, the family's for a rotation. */
  readonly familyId: string;
  /** `sha256Hex` of the refresh token. */
  readonly refreshTokenHash: string;
  readonly rememberMe: boolean;
  /** The absolute end of the family; also the expiry of this generation's refresh token. */
  readonly familyExpiresAt: Date;
  /** The end user's user agent at sign-in, at most 512 characters. */
  readonly userAgent: string | null;
  /** The country of the sign-in IP (two capital letters), when known. The IP itself is not stored. */
  readonly ipCountry: string | null;
  readonly now: Date;
}

/** The customer columns a session change reads under its lock. */
export interface SessionCustomer {
  readonly id: string;
  readonly status: string;
  readonly deleted_at: Date | null;
}

@Injectable()
export class SessionsRepository {
  /** Inserts `session` in `trx`. */
  async insert(trx: TenantTransaction, session: NewCustomerSession): Promise<void> {
    await trx
      .insertInto("customer_sessions")
      .values({
        id: session.id,
        customer_id: session.customerId,
        identity_id: session.identityId,
        family_id: session.familyId,
        refresh_token_hash: session.refreshTokenHash,
        remember_me: session.rememberMe,
        family_expires_at: session.familyExpiresAt,
        expires_at: session.familyExpiresAt,
        user_agent: session.userAgent,
        ip_address: null,
        ip_country: session.ipCountry,
        created_at: session.now,
        updated_at: session.now,
      })
      .execute();
  }

  /** The row whose refresh token hashes to `refreshTokenHash`, read without a lock; `undefined` when there is none. */
  async findByTokenHash(
    trx: TenantTransaction,
    refreshTokenHash: string,
  ): Promise<CustomerSessionRecord | undefined> {
    return trx
      .selectFrom("customer_sessions")
      .selectAll()
      .where("refresh_token_hash", "=", refreshTokenHash)
      .executeTakeFirst();
  }

  /**
   * The row whose refresh token hashes to `refreshTokenHash`, locked for the rest of `trx` (`FOR UPDATE`), so two
   * refreshes with one token run one after the other and the second sees the first's rotation.
   */
  async lockByTokenHash(
    trx: TenantTransaction,
    refreshTokenHash: string,
  ): Promise<CustomerSessionRecord | undefined> {
    return trx
      .selectFrom("customer_sessions")
      .selectAll()
      .where("refresh_token_hash", "=", refreshTokenHash)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Takes the customer's `FOR KEY SHARE` lock for the rest of `trx` and answers its status: every change of one of its
   * families takes it first, and a change of all of them (password change, account deletion, `lockCustomerForUpdate`)
   * takes the conflicting `FOR UPDATE` lock, so a revocation of every family never misses a generation that a
   * concurrent rotation is writing. `undefined` when the customer does not exist.
   */
  async lockCustomerForSessionChange(
    trx: TenantTransaction,
    customerId: string,
  ): Promise<SessionCustomer | undefined> {
    return trx
      .selectFrom("customers")
      .select(["id", "status", "deleted_at"])
      .where("id", "=", customerId)
      .forKeyShare()
      .executeTakeFirst();
  }

  /**
   * Customer `customerId`'s state that decides whether it may hold a session (`mayHoldSession`), read without a lock:
   * the customer guard's check of every customer-scope request (identity/customer-access.ts, FIX-W29-SECURITY).
   */
  async findSessionCustomer(
    trx: TenantTransaction,
    customerId: string,
  ): Promise<SessionCustomer | undefined> {
    return trx
      .selectFrom("customers")
      .select(["id", "status", "deleted_at"])
      .where("id", "=", customerId)
      .executeTakeFirst();
  }

  /** Takes the customer's `FOR UPDATE` lock for the rest of `trx` (before revoking every family of it). */
  async lockCustomerForUpdate(
    trx: TenantTransaction,
    customerId: string,
  ): Promise<SessionCustomer | undefined> {
    return trx
      .selectFrom("customers")
      .select(["id", "status", "deleted_at"])
      .where("id", "=", customerId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Locks the first row of family `familyId` (`id = family_id`) for the rest of `trx` (`FOR UPDATE`). Every change of
   * a family (a rotation, a revocation) takes this lock after the customer's, so a revocation never misses a
   * generation that a concurrent rotation of the same family is writing. `false` when the family has no such row.
   */
  async lockFamily(trx: TenantTransaction, familyId: string): Promise<boolean> {
    const row = await trx
      .selectFrom("customer_sessions")
      .select("id")
      .where("id", "=", familyId)
      .forUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The first row of family `familyId` (its `id` is the family id), read without a lock; `undefined` without one. Its
   * customer is the family's (the ownership check of `revokeFamily`), its creation the sign-in.
   */
  async findFamilyHead(trx: TenantTransaction, familyId: string): Promise<CustomerSessionRecord | undefined> {
    return trx
      .selectFrom("customer_sessions")
      .selectAll()
      .where("id", "=", familyId)
      .where("family_id", "=", familyId)
      .executeTakeFirst();
  }

  /**
   * The family's current generation (OBE-033): its newest row that was not rotated, whose refresh token is the one
   * the customer holds; `undefined` when the family has none.
   */
  async findCurrentGeneration(
    trx: TenantTransaction,
    familyId: string,
  ): Promise<CustomerSessionRecord | undefined> {
    return trx
      .selectFrom("customer_sessions")
      .selectAll()
      .where("family_id", "=", familyId)
      .where("rotated_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  /** Sets `last_used_at` of row `id` to `now` (auth.getSession, at most once a minute; OBE-033). */
  async touch(trx: TenantTransaction, id: string, now: Date): Promise<void> {
    await trx
      .updateTable("customer_sessions")
      .set({ last_used_at: now, updated_at: now })
      .where("id", "=", id)
      .execute();
  }

  /** Marks row `id` used up at `now`: rotated, last used, and replaced by row `replacedById` (inserted before). */
  async markRotated(trx: TenantTransaction, id: string, replacedById: string, now: Date): Promise<void> {
    await trx
      .updateTable("customer_sessions")
      .set({ rotated_at: now, last_used_at: now, replaced_by_id: replacedById, updated_at: now })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Revokes every row of family `familyId` that is not revoked yet, at `now` with `reason`. Returns how many rows it
   * revoked (0 when the family was revoked already).
   */
  async revokeFamily(
    trx: TenantTransaction,
    familyId: string,
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<number> {
    const rows = await trx
      .updateTable("customer_sessions")
      .set({ revoked_at: now, revoke_reason: reason, updated_at: now })
      .where("family_id", "=", familyId)
      .where("revoked_at", "is", null)
      .returning("id")
      .execute();
    return rows.length;
  }

  /**
   * Revokes every row of every family of `customerId` that is not revoked yet, except the rows of family
   * `exceptFamilyId` (the current session of a password change), at `now` with `reason`. Returns how many families had
   * a row revoked.
   */
  async revokeAllOfCustomer(
    trx: TenantTransaction,
    customerId: string,
    reason: SessionRevokeReason,
    now: Date,
    exceptFamilyId?: string,
  ): Promise<number> {
    let query = trx
      .updateTable("customer_sessions")
      .set({ revoked_at: now, revoke_reason: reason, updated_at: now })
      .where("customer_id", "=", customerId)
      .where("revoked_at", "is", null);
    if (exceptFamilyId !== undefined) {
      query = query.where("family_id", "<>", exceptFamilyId);
    }
    const rows = await query.returning("family_id").execute();
    return new Set(rows.map((row) => row.family_id)).size;
  }
}
