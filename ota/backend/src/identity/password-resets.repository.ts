// The password rows of the identity module (OBE-034; the document's requestPasswordReset, resetPassword and
// changePassword, ADR-0008 "Passwords" and "E-mail verification and password reset", db README §7 and §8 "Hashed
// tokens"): the reset tokens of `customer_password_resets`, the password of a customer's identity in
// `customer_identities`, and what the reset e-mail reads of `customers`, `customer_preferences` and
// `storefront_settings`.
//
// - A reset token (`pr_…`, 256 bits) is stored only as its SHA-256 (`token_hash`, unique), with its end (`expires_at`,
//   one hour after the request) and its use (`used_at`). A new request ends the customer's earlier open tokens at once
//   (`expires_at` set to the request time), so only the newest link of a customer works; a used token keeps its row
//   (`used_at`), so presenting it again is told apart from an unknown one. The daily retention purge removes rows past
//   `expires_at` (db README §5, `customer_password_resets_expires_idx`).
// - A password is only ever written as an Argon2id hash (`password_hash`, with `password_updated_at`). A change can
//   require the hash it verified the current password against (`expectedHash`), so a password that changed meanwhile
//   is never overwritten unseen.
//
// Locks: every change of a customer's password or reset tokens takes the customer's `FOR UPDATE` lock first
// (`lockCustomer`), then the reset row (`lockByTokenHash`), the identity and the sessions, the order of the sign-in
// (customer, then identity), of e-mail verification and of SessionsService (the customer before its sessions), so two
// of these transactions never wait for each other in a cycle.
//
// Kysely on the caller's tenant transaction (`TenantTx`, search_path `tenant_<key>`); tables are never
// schema-qualified. Times come from the service's `Clock`, never the database's `now()`, so expiry follows a fake clock
// in tests. Hashes leave this file only towards the Argon2id verification of the current password, never towards a log
// or an answer.
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** A `customer_password_resets` row as the reset reads it. */
export interface PasswordResetRecord {
  /** `pwr_…` */
  readonly id: string;
  /** `cus_…` */
  readonly customerId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/** A new reset token, as stored: its SHA-256, never the token. */
export interface NewPasswordReset {
  /** `pwr_…` */
  readonly id: string;
  readonly customerId: string;
  /** `sha256Hex` of the token. */
  readonly tokenHash: string;
  /** The end user's IP that asked for it, when it is a valid address. */
  readonly requestedIp: string | null;
  readonly expiresAt: Date;
  readonly now: Date;
}

/** The customer columns a password change reads under the customer's lock. */
export interface PasswordCustomer {
  readonly id: string;
  readonly email: string;
  readonly first_name: string | null;
  readonly status: string;
  readonly deleted_at: Date | null;
}

/** A customer's enabled password identity, with its hash: what a reset writes and a change verifies against. */
export interface CustomerPasswordIdentity {
  /** `cid_…` */
  readonly identityId: string;
  /** `cus_…` */
  readonly customerId: string;
  /** The address as identities store it (trimmed, lower case): the key of the sign-in lockout. */
  readonly subject: string;
  /** The Argon2id hash in PHC format. Never logged or answered. */
  readonly passwordHash: string;
}

/** What a new password writes. */
export interface NewPassword {
  readonly identityId: string;
  /** The Argon2id hash of the new password. */
  readonly passwordHash: string;
  readonly now: Date;
  /** The hash the current password was verified against: the update happens only while it is still the stored one. */
  readonly expectedHash?: string | undefined;
}

/** The locales of the reset e-mail: the customer's preference and the storefront's default. */
export interface MailLocales {
  readonly preferred: string | null;
  readonly storefrontDefault: string | null;
}

@Injectable()
export class PasswordResetsRepository {
  /**
   * The customer `customerId` with what a password change reads of it, locked `FOR UPDATE` until `trx` ends: the first
   * lock of every change of its password, reset tokens and sessions. `undefined` when there is none.
   */
  async lockCustomer(trx: TenantTransaction, customerId: string): Promise<PasswordCustomer | undefined> {
    return trx
      .selectFrom("customers")
      .select(["id", "email", "first_name", "status", "deleted_at"])
      .where("id", "=", customerId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * The enabled password identity of `customerId`; `undefined` when it has none (an erased account, one disabled by
   * staff, a customer without a password).
   */
  async passwordIdentityOf(
    trx: TenantTransaction,
    customerId: string,
  ): Promise<CustomerPasswordIdentity | undefined> {
    const row = await trx
      .selectFrom("customer_identities")
      .select(["id", "customer_id", "provider_subject", "password_hash"])
      .where("customer_id", "=", customerId)
      .where("provider", "=", "password")
      .where("disabled_at", "is", null)
      .executeTakeFirst();
    if (row === undefined || row.password_hash === null) {
      return undefined;
    }
    return {
      identityId: row.id,
      customerId: row.customer_id,
      subject: row.provider_subject,
      passwordHash: row.password_hash,
    };
  }

  /** The reset whose token hashes to `tokenHash`, read without a lock; `undefined` when there is none. */
  async findByTokenHash(trx: TenantTransaction, tokenHash: string): Promise<PasswordResetRecord | undefined> {
    return this.resetQuery(trx).where("token_hash", "=", tokenHash).executeTakeFirst();
  }

  /**
   * The reset whose token hashes to `tokenHash`, locked `FOR UPDATE` until `trx` ends (after the customer's lock), so
   * two confirmations with one token run one after the other and the second sees the first's use.
   */
  async lockByTokenHash(trx: TenantTransaction, tokenHash: string): Promise<PasswordResetRecord | undefined> {
    return this.resetQuery(trx).where("token_hash", "=", tokenHash).forUpdate().executeTakeFirst();
  }

  /** How many resets `customerId` asked for at or after `since` (the limit of reset e-mails per hour). */
  async countRequestedSince(trx: TenantTransaction, customerId: string, since: Date): Promise<number> {
    const row = await trx
      .selectFrom("customer_password_resets")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("customer_id", "=", customerId)
      .where("created_at", ">=", since)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Ends every open token of `customerId` at `now` (unused and not yet expired: `expires_at` becomes `now`); returns
   * how many. A new request, a reset and a password change do this, so no older link works afterwards.
   */
  async expireOpen(trx: TenantTransaction, customerId: string, now: Date): Promise<number> {
    const rows = await trx
      .updateTable("customer_password_resets")
      .set({ expires_at: now, updated_at: now })
      .where("customer_id", "=", customerId)
      .where("used_at", "is", null)
      .where("expires_at", ">", now)
      .returning("id")
      .execute();
    return rows.length;
  }

  /** Inserts `reset` in `trx`. */
  async insert(trx: TenantTransaction, reset: NewPasswordReset): Promise<void> {
    await trx
      .insertInto("customer_password_resets")
      .values({
        id: reset.id,
        customer_id: reset.customerId,
        token_hash: reset.tokenHash,
        requested_ip: reset.requestedIp,
        expires_at: reset.expiresAt,
        created_at: reset.now,
        updated_at: reset.now,
      })
      .execute();
  }

  /** Marks reset `id` used at `now`. */
  async markUsed(trx: TenantTransaction, id: string, now: Date): Promise<void> {
    await trx
      .updateTable("customer_password_resets")
      .set({ used_at: now, updated_at: now })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Stores the new password of identity `identityId` (`password_hash`, `password_updated_at`) and clears the
   * identity's own failure columns. With `expectedHash` only while that is still the stored hash. Returns whether the
   * identity was updated.
   */
  async setPassword(trx: TenantTransaction, password: NewPassword): Promise<boolean> {
    let query = trx
      .updateTable("customer_identities")
      .set({
        password_hash: password.passwordHash,
        password_updated_at: password.now,
        failed_attempts: 0,
        locked_until: null,
        updated_at: password.now,
      })
      .where("id", "=", password.identityId)
      .where("disabled_at", "is", null);
    if (password.expectedHash !== undefined) {
      query = query.where("password_hash", "=", password.expectedHash);
    }
    const rows = await query.returning("id").execute();
    return rows.length === 1;
  }

  /**
   * Records at `now` that the customer proved its inbox (a reset link was opened): `customers.email_verified_at` and
   * `pending_verification` → `active` with `version` + 1 when the address was not verified yet (a verified customer's
   * row and `version` stay as they are), and the identity's `email_verified_at` when it has none. A pending address
   * change (`pending_email`) is not verified by it: the link went to the current address.
   */
  async markEmailVerified(
    trx: TenantTransaction,
    customerId: string,
    identityId: string,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("customers")
      .set({
        email_verified_at: now,
        status: sql<string>`case when status = 'pending_verification' then 'active' else status end`,
        version: sql<number>`version + 1`,
        updated_at: now,
      })
      .where("id", "=", customerId)
      .where("email_verified_at", "is", null)
      .execute();
    await trx
      .updateTable("customer_identities")
      .set({ email_verified_at: now, updated_at: now })
      .where("id", "=", identityId)
      .where("email_verified_at", "is", null)
      .execute();
  }

  /** The locales the reset e-mail of `customerId` is rendered in: its preference, else the storefront's default. */
  async mailLocales(trx: TenantTransaction, customerId: string): Promise<MailLocales> {
    const preference = await trx
      .selectFrom("customer_preferences")
      .select("locale")
      .where("customer_id", "=", customerId)
      .executeTakeFirst();
    const settings = await trx.selectFrom("storefront_settings").select("default_locale").executeTakeFirst();
    return { preferred: preference?.locale ?? null, storefrontDefault: settings?.default_locale ?? null };
  }

  /** The reset columns of `PasswordResetRecord`. */
  private resetQuery(trx: TenantTransaction) {
    return trx
      .selectFrom("customer_password_resets")
      .select(["id", "customer_id as customerId", "expires_at as expiresAt", "used_at as usedAt"]);
  }
}
