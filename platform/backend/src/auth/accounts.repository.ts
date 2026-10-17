// The `accounts` repository of AuthModule (platform/docs/architecture.md §2.1: AuthModule owns the credentials and the
// status of an account; AccountsModule, PBE-015 and PBE-016, the profile and the MFA settings). Kysely on the API's
// `PLATFORM_DB`, schema-qualified tables (ADR-0005); every method takes the caller's transaction or the pool.
//
// E-mail addresses are stored as the person typed them (trimmed) and compared lower-cased: the unique index
// `accounts_email_lower_uq` is on `lower(email)`, so `Anna@Example.com` and `anna@example.com` are one account.
import { Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import type { PlatformDb } from "../common/database";

/** A `platform.accounts` row as the API reads it. */
export type AccountRecord = Selectable<PlatformDatabase["platform.accounts"]>;

/** The lifecycle states of `accounts.status` (migration 0001). */
export type AccountStatus = "pending_verification" | "active" | "locked" | "disabled" | "deleted";

/** The fields of an account that sign-up and verification read. */
export type AccountIdentity = Pick<
  AccountRecord,
  "id" | "email" | "full_name" | "status" | "email_verified_at"
>;

/** A new account of a sign-up: `pending_verification`, with the terms the person accepted. */
export interface NewAccount {
  readonly id: string;
  /** The address as typed, trimmed. */
  readonly email: string;
  readonly fullName: string;
  /** The Argon2id hash (PasswordPolicy.hash). */
  readonly passwordHash: string;
  readonly termsVersion: string;
  /** The time of the sign-up: `terms_accepted_at`, `created_at` and `updated_at`. */
  readonly now: Date;
}

const IDENTITY_COLUMNS = ["id", "email", "full_name", "status", "email_verified_at"] as const;

@Injectable()
export class AccountsRepository {
  /**
   * Inserts `account` unless an account with the same address (lower-cased) exists, in `trx`. Returns `true` when the
   * row was written, `false` when the address was taken, also by a sign-up committed meanwhile (ON CONFLICT on
   * `lower(email)` waits for a concurrent insert of the same address and then does nothing).
   */
  async insertIfEmailFree(trx: PlatformTransaction, account: NewAccount): Promise<boolean> {
    const inserted = await trx
      .insertInto("platform.accounts")
      .values({
        id: account.id,
        email: account.email,
        full_name: account.fullName,
        password_hash: account.passwordHash,
        status: "pending_verification" satisfies AccountStatus,
        terms_accepted_at: account.now,
        terms_version: account.termsVersion,
        created_at: account.now,
        updated_at: account.now,
      })
      .onConflict((conflict) => conflict.expression(sql`lower(email)`).doNothing())
      .returning("id")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /**
   * The account whose address equals `email` ignoring letter case, read on `db` (a transaction or the pool). Both
   * sides go through PostgreSQL's `lower`, as the unique index `accounts_email_lower_uq` does, so this finds exactly
   * the account an `ON CONFLICT (lower(email))` insert ran into.
   */
  async findByEmail(
    db: PlatformTransaction | PlatformDb,
    email: string,
  ): Promise<AccountIdentity | undefined> {
    return db
      .selectFrom("platform.accounts")
      .select(IDENTITY_COLUMNS)
      .where(sql<string>`lower(email)`, "=", sql<string>`lower(${email})`)
      .executeTakeFirst();
  }

  /** The account `accountId`, locked for the rest of the caller's transaction (`FOR UPDATE`). */
  async lockForUpdate(trx: PlatformTransaction, accountId: string): Promise<AccountIdentity | undefined> {
    return trx
      .selectFrom("platform.accounts")
      .select(IDENTITY_COLUMNS)
      .where("id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Marks the address of a `pending_verification` account verified at `now` and makes the account `active`, with
   * `version + 1`, in `trx`. Returns `false` when the account is not `pending_verification` (nothing changed).
   */
  async markEmailVerified(trx: PlatformTransaction, accountId: string, now: Date): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.accounts")
      .set({
        email_verified_at: now,
        status: "active" satisfies AccountStatus,
        version: sql<number>`version + 1`,
        updated_at: now,
      })
      .where("id", "=", accountId)
      .where("status", "=", "pending_verification" satisfies AccountStatus)
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }
}
