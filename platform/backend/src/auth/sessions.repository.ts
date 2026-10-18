// The `account_sessions` repository of AuthModule (platform/docs/architecture.md §2.1 and §3.1, PADR-0009 item 4,
// ADR-0008 "Refresh tokens"). One row per refresh token **generation**: a sign-in writes the first row of a rotation
// **family** (`family_id` is the `asn_…` id of that first row, the `sid` of its access tokens and the `familyId` of
// listSessions), and every refresh marks the presented row `rotated_at` / `replaced_by_id` and writes the next row of
// the same family. Only the SHA-256 of a refresh token is stored (`refresh_token_hash`, unique).
//
// - `expires_at` is the idle expiry of one token (7 days for the portal, never after the family's end) and
//   `family_expires_at` the absolute end of the family (30 days for the portal, 12 hours for the admin);
// - `revoked_at` with `revoke_reason` ends a row; revoking a family revokes every row of it, rotated ones included;
// - `mfa_verified_at` is the family's last TOTP verification, copied into each new generation (the `mfa_at` claim);
//   a step-up (PBE-015) writes the next generation with a new one.
//
// Kysely on the caller's transaction, schema-qualified tables (ADR-0005). Times are the service's `Clock`, never the
// database's `now()`, so expiry follows the FakeClock in tests.
import { Injectable } from "@nestjs/common";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import type { PlatformDb } from "../common/database";

/** A `platform.account_sessions` row as the API reads it. */
export type SessionRecord = Selectable<PlatformDatabase["platform.account_sessions"]>;

/** Which surface a family belongs to (`account_sessions.audience`); the two never refresh each other. */
export type SessionAudience = "portal" | "platform_admin";

/** Why a row was revoked (`account_sessions.revoke_reason`, migration 0001). */
export type SessionRevokeReason = "logout" | "rotation_reuse" | "password_change" | "admin" | "expired";

/** A new row: the first of a family, or the next generation of one. */
export interface NewSession {
  /** `asn_…` */
  readonly id: string;
  readonly accountId: string;
  /** The family: the row's own `id` for the first row of a sign-in, the family's for a rotation. */
  readonly familyId: string;
  readonly audience: SessionAudience;
  /** `sha256Hex` of the refresh token. */
  readonly refreshTokenHash: string;
  /** The end user's user agent at sign-in (request context, PADR-0019). */
  readonly userAgent: string | null;
  /** The end user's IP at sign-in (request context, PADR-0019). */
  readonly ipAddress: string | null;
  /** The idle expiry of this token, at or before `familyExpiresAt`. */
  readonly expiresAt: Date;
  /** The absolute end of the family. */
  readonly familyExpiresAt: Date;
  /** The family's last TOTP verification, if any. */
  readonly mfaVerifiedAt: Date | null;
  readonly now: Date;
}

@Injectable()
export class SessionsRepository {
  /** Inserts `session` in `trx`. */
  async insert(trx: PlatformTransaction, session: NewSession): Promise<void> {
    await trx
      .insertInto("platform.account_sessions")
      .values({
        id: session.id,
        account_id: session.accountId,
        family_id: session.familyId,
        audience: session.audience,
        refresh_token_hash: session.refreshTokenHash,
        user_agent: session.userAgent,
        ip_address: session.ipAddress,
        expires_at: session.expiresAt,
        family_expires_at: session.familyExpiresAt,
        mfa_verified_at: session.mfaVerifiedAt,
        created_at: session.now,
        updated_at: session.now,
      })
      .execute();
  }

  /**
   * The row whose refresh token hashes to `refreshTokenHash`, locked for the rest of `trx` (`FOR UPDATE`), so two
   * refreshes with one token run one after the other and the second sees the first's rotation; `undefined` when no
   * row has that hash.
   */
  async lockByTokenHash(
    trx: PlatformTransaction,
    refreshTokenHash: string,
  ): Promise<SessionRecord | undefined> {
    return trx
      .selectFrom("platform.account_sessions")
      .selectAll()
      .where("refresh_token_hash", "=", refreshTokenHash)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Locks the first row of family `familyId` (`id = family_id`) for the rest of `trx` (`FOR UPDATE`). Every change of
   * a family (a rotation, a revocation) takes this lock first, so a revocation never misses a generation that a
   * concurrent rotation of the same family is writing. Returns `false` when the family has no such row any more.
   */
  async lockFamily(trx: PlatformTransaction, familyId: string): Promise<boolean> {
    const row = await trx
      .selectFrom("platform.account_sessions")
      .select("id")
      .where("id", "=", familyId)
      .forUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The current generation of family `familyId` (the newest row that is neither rotated nor revoked), locked for the
   * rest of `trx` (`FOR UPDATE`); `undefined` when the family has none (it was revoked). The step-up (PBE-015) rotates
   * it, as a refresh would, without the refresh token in hand.
   */
  async lockCurrentOfFamily(trx: PlatformTransaction, familyId: string): Promise<SessionRecord | undefined> {
    return trx
      .selectFrom("platform.account_sessions")
      .selectAll()
      .where("family_id", "=", familyId)
      .where("rotated_at", "is", null)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The row whose refresh token hashes to `refreshTokenHash`, read on `db`, without a lock. */
  async findByTokenHash(
    db: PlatformTransaction | PlatformDb,
    refreshTokenHash: string,
  ): Promise<SessionRecord | undefined> {
    return db
      .selectFrom("platform.account_sessions")
      .selectAll()
      .where("refresh_token_hash", "=", refreshTokenHash)
      .executeTakeFirst();
  }

  /** Marks row `id` used up at `now`: rotated, last used, and replaced by row `replacedById` (inserted before). */
  async markRotated(trx: PlatformTransaction, id: string, replacedById: string, now: Date): Promise<void> {
    await trx
      .updateTable("platform.account_sessions")
      .set({ rotated_at: now, last_used_at: now, replaced_by_id: replacedById, updated_at: now })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Revokes every row of family `familyId` that is not revoked yet, at `now` with `reason`, in `trx`. Returns how
   * many rows it revoked (0 when the family was revoked already).
   */
  async revokeFamily(
    trx: PlatformTransaction,
    familyId: string,
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<number> {
    const rows = await trx
      .updateTable("platform.account_sessions")
      .set({ revoked_at: now, revoke_reason: reason, updated_at: now })
      .where("family_id", "=", familyId)
      .where("revoked_at", "is", null)
      .returning("id")
      .execute();
    return rows.length;
  }

  /**
   * Revokes every row of every family of `accountId` (portal and admin alike) that is not revoked yet, at `now` with
   * `reason`, in `trx`. Returns how many families had a row revoked.
   */
  async revokeAllOfAccount(
    trx: PlatformTransaction,
    accountId: string,
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<number> {
    const rows = await trx
      .updateTable("platform.account_sessions")
      .set({ revoked_at: now, revoke_reason: reason, updated_at: now })
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .returning("family_id")
      .execute();
    return new Set(rows.map((row) => row.family_id)).size;
  }
}
