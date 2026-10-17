// The `account_tokens` repository of AuthModule (platform/docs/architecture.md §2.1; ADR-0008, PADR-0008 item 3):
// single-use e-mail verification (24 h) and password reset (1 h) tokens. Only the SHA-256 of a token is stored
// (`token_hash`, unique); the token itself exists only in the e-mail's link, which the outbox keeps encrypted until the
// e-mail is sent. Kysely on the caller's transaction, schema-qualified tables (ADR-0005).
//
// Times are the service's `Clock`, never the database's `now()`, so expiry follows the FakeClock in tests.
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";

/** What a token is for (`account_tokens.purpose`). */
export type AccountTokenPurpose = "email_verification" | "password_reset";

/** A new token row. */
export interface NewAccountToken {
  /** `atk_…` */
  readonly id: string;
  readonly accountId: string;
  readonly purpose: AccountTokenPurpose;
  /** `sha256Hex` of the token. */
  readonly tokenHash: string;
  /** The address the link is sent to. */
  readonly email: string;
  readonly expiresAt: Date;
  /** The end user's IP of the request (request context, PADR-0019); `null` outside a request. */
  readonly ipAddress: string | null;
  readonly now: Date;
}

/** The token a `consume` used up: whose it is and the address it was sent to. */
export interface ConsumedAccountToken {
  readonly id: string;
  readonly accountId: string;
  readonly email: string;
}

@Injectable()
export class AccountTokensRepository {
  /** Inserts `token` in `trx`. */
  async insert(trx: PlatformTransaction, token: NewAccountToken): Promise<void> {
    await trx
      .insertInto("platform.account_tokens")
      .values({
        id: token.id,
        account_id: token.accountId,
        purpose: token.purpose,
        token_hash: token.tokenHash,
        email: token.email,
        expires_at: token.expiresAt,
        ip_address: token.ipAddress,
        created_at: token.now,
        updated_at: token.now,
      })
      .execute();
  }

  /**
   * The account of the token of `purpose` whose hash is `tokenHash` when it is unused and has not expired at `now`,
   * without locking or using it up; `undefined` for an unknown, used or expired token. A caller that changes the
   * account locks the account with it and only then calls `consume`: every use of an account's tokens takes the
   * account's lock first, so two of its links used at the same time wait for each other instead of deadlocking.
   */
  async accountOfUsable(
    trx: PlatformTransaction,
    purpose: AccountTokenPurpose,
    tokenHash: string,
    now: Date,
  ): Promise<string | undefined> {
    const row = await trx
      .selectFrom("platform.account_tokens")
      .select("account_id")
      .where("token_hash", "=", tokenHash)
      .where("purpose", "=", purpose)
      .where("consumed_at", "is", null)
      .where("expires_at", ">", now)
      .executeTakeFirst();
    return row?.account_id;
  }

  /**
   * Uses up the token of `purpose` whose hash is `tokenHash` when it is unused and has not expired at `now`, in one
   * statement, so two concurrent uses cannot both succeed. Returns the token, or `undefined` for an unknown, used or
   * expired token (the three are not told apart). Lock the token's account first (`accountOfUsable`).
   */
  async consume(
    trx: PlatformTransaction,
    purpose: AccountTokenPurpose,
    tokenHash: string,
    now: Date,
  ): Promise<ConsumedAccountToken | undefined> {
    const row = await trx
      .updateTable("platform.account_tokens")
      .set({ consumed_at: now, updated_at: now })
      .where("token_hash", "=", tokenHash)
      .where("purpose", "=", purpose)
      .where("consumed_at", "is", null)
      .where("expires_at", ">", now)
      .returning(["id", "account_id", "email"])
      .executeTakeFirst();
    return row === undefined ? undefined : { id: row.id, accountId: row.account_id, email: row.email };
  }

  /** Uses up every unused token of `purpose` of the account at `now`, in `trx`. Returns how many there were. */
  async consumeAllOf(
    trx: PlatformTransaction,
    accountId: string,
    purpose: AccountTokenPurpose,
    now: Date,
  ): Promise<number> {
    const rows = await trx
      .updateTable("platform.account_tokens")
      .set({ consumed_at: now, updated_at: now })
      .where("account_id", "=", accountId)
      .where("purpose", "=", purpose)
      .where("consumed_at", "is", null)
      .returning("id")
      .execute();
    return rows.length;
  }
}
