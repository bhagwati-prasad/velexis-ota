// The `accounts` repository of AuthModule (platform/docs/architecture.md §2.1: AuthModule owns the credentials and the
// status of an account; AccountsModule, PBE-015 and PBE-016, the profile and the MFA settings). Kysely on the API's
// `PLATFORM_DB`, schema-qualified tables (ADR-0005); every method takes the caller's transaction or the pool.
//
// E-mail addresses are stored as the person typed them (trimmed) and compared lower-cased: the unique index
// `accounts_email_lower_uq` is on `lower(email)`, so `Anna@Example.com` and `anna@example.com` are one account.
//
// Sign-in (PBE-014) reads the credentials and the lockout counters here and keeps them: `recordFailedSignIn` and
// `recordSignIn` change `failed_login_count`, `locked_until` and `last_login_at` in one statement each, and only while
// the account is not locked out, so concurrent attempts cannot slip past a lockout. These bookkeeping columns are not
// part of the `Account` the API shows, so they leave `version` (the `ETag` of the profile) alone. `findPortalAccount`
// reads the account as `PortalSession.account` shows it, with its active memberships (`tenant_memberships` and
// `tenants`, read only, as MembershipsRepository reads `accounts` next to a membership). The MFA settings (PBE-015)
// are read and changed here for AccountsModule's MfaService: `enableMfa` and `disableMfa` change what the `Account`
// shows, so they add one to `version`, as `grantPlatformAdmin` (the admin bootstrap, PBE-028) does.
//
// The platform admin's account support (PBE-032, admin/admin-accounts.service.ts) reads accounts as `AdminAccount`
// shows them (`searchForAdmin`, `findAdminAccount`, `lockAdminAccount`, `listPlatformAdmins`) and changes their status
// (`setStatus`, `version + 1`), their lockout (`clearLockout`, bookkeeping like the sign-in counters, so `version`
// stays) and their admin flag (`revokePlatformAdmin`, `version + 1`). `lockActivePlatformAdmins` locks every active
// platform admin, so two admins who disable or revoke each other at the same time run one after the other and never
// leave Velexis without an admin.
import { Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { MEMBER_VISIBLE_TENANT_STATUSES } from "../common/auth/tenant-role.guard";
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

/** What sign-in reads of an account: its credentials, its status, its MFA flag and its lockout counters. */
export type SignInAccount = Pick<
  AccountRecord,
  | "id"
  | "email"
  | "status"
  | "password_hash"
  | "email_verified_at"
  | "mfa_enabled"
  | "failed_login_count"
  | "locked_until"
  | "deleted_at"
>;

const SIGN_IN_COLUMNS = [
  "id",
  "email",
  "status",
  "password_hash",
  "email_verified_at",
  "mfa_enabled",
  "failed_login_count",
  "locked_until",
  "deleted_at",
] as const;

/**
 * What a password reset or change (PBE-016) reads of an account: who it is and where its e-mails go, whether it may
 * hold a session, and its password hash.
 */
export type CredentialsAccount = Pick<
  AccountRecord,
  "id" | "email" | "full_name" | "status" | "password_hash" | "deleted_at"
>;

const CREDENTIALS_COLUMNS = ["id", "email", "full_name", "status", "password_hash", "deleted_at"] as const;

/** The profile of an account as `updateMe` (PBE-016) changes it, with its status and its version (the `ETag`). */
export type ProfileAccount = Pick<
  AccountRecord,
  "id" | "full_name" | "locale" | "time_zone" | "status" | "version"
>;

const PROFILE_COLUMNS = ["id", "full_name", "locale", "time_zone", "status", "version"] as const;

/** The profile columns `updateMe` writes; only the ones that change. */
export type AccountProfileChanges = Partial<Pick<AccountRecord, "full_name" | "locale" | "time_zone">>;

/** The counters after a failed sign-in that `recordFailedSignIn` counted. */
export interface FailedSignIn {
  /** Consecutive failures since the last successful sign-in (or the last unlock), this one included. */
  readonly failedLoginCount: number;
  /** The end of the lockout this failure started; `null` when it started none. */
  readonly lockedUntil: Date | null;
}

/** An active membership of an account, with what `AccountMembership` shows of its OTA. */
export interface AccountMembershipRecord {
  /** `stf_…`. */
  readonly membership_id: string;
  readonly tenant_id: string;
  readonly tenant_key: string;
  readonly tenant_name: string;
  readonly tenant_status: string;
  readonly role: string;
}

/** The account as `PortalSession.account` shows it, before mapping. */
export type PortalAccountRecord = Pick<
  AccountRecord,
  | "id"
  | "email"
  | "email_verified_at"
  | "full_name"
  | "locale"
  | "time_zone"
  | "mfa_enabled"
  | "mfa_enabled_at"
  | "is_platform_admin"
  | "status"
  | "created_at"
  | "version"
> & { readonly memberships: readonly AccountMembershipRecord[] };

const PORTAL_ACCOUNT_COLUMNS = [
  "id",
  "email",
  "email_verified_at",
  "full_name",
  "locale",
  "time_zone",
  "mfa_enabled",
  "mfa_enabled_at",
  "is_platform_admin",
  "status",
  "created_at",
  "version",
] as const;

/**
 * What the MFA steps (PBE-015, AccountsModule's MfaService) read of an account: who it is, whether it may hold a
 * session, whether it is a platform admin, and its MFA settings with the envelope of its TOTP secret.
 */
export type MfaAccount = Pick<
  AccountRecord,
  | "id"
  | "email"
  | "full_name"
  | "status"
  | "is_platform_admin"
  | "mfa_enabled"
  | "mfa_secret_ciphertext"
  | "deleted_at"
>;

const MFA_ACCOUNT_COLUMNS = [
  "id",
  "email",
  "full_name",
  "status",
  "is_platform_admin",
  "mfa_enabled",
  "mfa_secret_ciphertext",
  "deleted_at",
] as const;

/** The TOTP secret of an account that enables MFA, envelope-encrypted for `platform.accounts.mfa_secret_ciphertext`. */
export interface EnabledMfa {
  readonly secretCiphertext: Uint8Array;
  /** The KEK that wraps its data key (`encryption_key_id`). */
  readonly kekId: string;
  readonly now: Date;
}

/** An account as the platform admin's `AdminAccount` shows it, with its erasure time (PBE-032). */
export type AdminAccountRecord = Pick<
  AccountRecord,
  | "id"
  | "email"
  | "email_verified_at"
  | "full_name"
  | "locale"
  | "time_zone"
  | "status"
  | "mfa_enabled"
  | "mfa_enabled_at"
  | "is_platform_admin"
  | "failed_login_count"
  | "locked_until"
  | "last_login_at"
  | "created_at"
  | "version"
  | "deleted_at"
>;

const ADMIN_ACCOUNT_COLUMNS = [
  "id",
  "email",
  "email_verified_at",
  "full_name",
  "locale",
  "time_zone",
  "status",
  "mfa_enabled",
  "mfa_enabled_at",
  "is_platform_admin",
  "failed_login_count",
  "locked_until",
  "last_login_at",
  "created_at",
  "version",
  "deleted_at",
] as const;

/** The filters of the admin's account search. */
export interface AdminAccountSearch {
  /** Part of the e-mail address or the name, matched ignoring letter case; `%`, `_` and `\` match themselves. */
  readonly q?: string | undefined;
  readonly status?: AccountStatus | undefined;
}

/** `text` as a LIKE pattern that matches it anywhere: `%`, `_` and the escape character `\` stand for themselves. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The condition "not locked out at `now`": `locked_until` is unset or has passed. */
function notLockedOutAt(now: Date) {
  return sql<boolean>`(locked_until IS NULL OR locked_until <= ${now})`;
}

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

  /**
   * What sign-in needs of the account whose address equals `email` ignoring letter case (as `findByEmail` compares
   * it), read on `db`; `undefined` when there is none.
   */
  async findForSignIn(
    db: PlatformTransaction | PlatformDb,
    email: string,
  ): Promise<SignInAccount | undefined> {
    return db
      .selectFrom("platform.accounts")
      .select(SIGN_IN_COLUMNS)
      .where(sql<string>`lower(email)`, "=", sql<string>`lower(${email})`)
      .executeTakeFirst();
  }

  /**
   * Takes a `FOR KEY SHARE` lock on account `accountId` for the rest of `trx`: the lock a change of one of its session
   * families holds, so it waits for a "sign out everywhere" in progress (`lockForUpdate`) and the reverse, while
   * sign-ins and other families of the account go on. Returns `false` when there is no such account.
   */
  async lockForSessionChange(trx: PlatformTransaction, accountId: string): Promise<boolean> {
    const row = await trx
      .selectFrom("platform.accounts")
      .select("id")
      .where("id", "=", accountId)
      .forKeyShare()
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The end of the account's lockout, or `null` when it has none (also for an unknown account). */
  async lockedUntil(db: PlatformTransaction | PlatformDb, accountId: string): Promise<Date | null> {
    const row = await db
      .selectFrom("platform.accounts")
      .select("locked_until")
      .where("id", "=", accountId)
      .executeTakeFirst();
    return row?.locked_until ?? null;
  }

  /**
   * Counts a failed sign-in of `accountId` at `now`, in `trx`, unless the account is locked out at `now`: one more
   * consecutive failure, and when the count reaches `threshold`, a lockout until `lockedUntil`. The count keeps
   * growing until a sign-in succeeds or an admin unlocks the account, so once the threshold is reached every further
   * failure after a lockout starts the next one. Returns the new counters, or `undefined` when the account was locked
   * out (by a concurrent failure, say) and nothing was counted.
   */
  async recordFailedSignIn(
    trx: PlatformTransaction,
    accountId: string,
    now: Date,
    lockout: { readonly threshold: number; readonly lockedUntil: Date },
  ): Promise<FailedSignIn | undefined> {
    const reachesThreshold = sql<boolean>`failed_login_count + 1 >= ${lockout.threshold}`;
    const row = await trx
      .updateTable("platform.accounts")
      .set({
        failed_login_count: sql<number>`failed_login_count + 1`,
        locked_until: sql<Date | null>`CASE WHEN ${reachesThreshold} THEN ${lockout.lockedUntil}::timestamptz ELSE locked_until END`,
        updated_at: now,
      })
      .where("id", "=", accountId)
      .where(notLockedOutAt(now))
      .returning(["failed_login_count", "locked_until"])
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    // RETURNING reads the new values: a count at the threshold means this failure set the lockout.
    const startedLockout = row.failed_login_count >= lockout.threshold;
    return {
      failedLoginCount: row.failed_login_count,
      lockedUntil: startedLockout ? row.locked_until : null,
    };
  }

  /**
   * Records a correct password of `accountId` at `now`, in `trx`, unless the account is locked out at `now`: the
   * failure count and the lockout are cleared, and with `signedIn` (the sign-in is complete, not waiting for a TOTP
   * code) `last_login_at` becomes `now`. Returns `false` when the account was locked out (nothing changed).
   */
  async recordSignIn(
    trx: PlatformTransaction,
    accountId: string,
    now: Date,
    options: { readonly signedIn: boolean },
  ): Promise<boolean> {
    const row = await trx
      .updateTable("platform.accounts")
      .set({
        failed_login_count: 0,
        locked_until: null,
        ...(options.signedIn ? { last_login_at: now } : {}),
        updated_at: now,
      })
      .where("id", "=", accountId)
      .where(notLockedOutAt(now))
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The MFA state of account `accountId`, read on `db`; `undefined` when there is no such account. */
  async findMfaAccount(
    db: PlatformTransaction | PlatformDb,
    accountId: string,
  ): Promise<MfaAccount | undefined> {
    return db
      .selectFrom("platform.accounts")
      .select(MFA_ACCOUNT_COLUMNS)
      .where("id", "=", accountId)
      .executeTakeFirst();
  }

  /** The MFA state of account `accountId`, locked for the rest of `trx` (`FOR UPDATE`). */
  async lockMfaAccount(trx: PlatformTransaction, accountId: string): Promise<MfaAccount | undefined> {
    return trx
      .selectFrom("platform.accounts")
      .select(MFA_ACCOUNT_COLUMNS)
      .where("id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Turns MFA on for account `accountId` with the encrypted TOTP secret, in `trx`: `mfa_enabled`, `mfa_enabled_at`,
   * `mfa_secret_ciphertext`, `encryption_key_id`, and `version + 1` (the `Account` shows `mfaEnabled` and
   * `mfaEnabledAt`). Returns `false` when MFA was on already (nothing changed).
   */
  async enableMfa(trx: PlatformTransaction, accountId: string, mfa: EnabledMfa): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.accounts")
      .set({
        mfa_enabled: true,
        mfa_enabled_at: mfa.now,
        mfa_secret_ciphertext: Buffer.from(mfa.secretCiphertext),
        encryption_key_id: mfa.kekId,
        version: sql<number>`version + 1`,
        updated_at: mfa.now,
      })
      .where("id", "=", accountId)
      .where("mfa_enabled", "=", false)
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }

  /**
   * Turns MFA off for account `accountId` at `now`, in `trx`: the flag, its time, the TOTP secret and its key id are
   * cleared, with `version + 1`. Returns `false` when MFA was off already (nothing changed).
   */
  async disableMfa(trx: PlatformTransaction, accountId: string, now: Date): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.accounts")
      .set({
        mfa_enabled: false,
        mfa_enabled_at: null,
        mfa_secret_ciphertext: null,
        encryption_key_id: null,
        version: sql<number>`version + 1`,
        updated_at: now,
      })
      .where("id", "=", accountId)
      .where("mfa_enabled", "=", true)
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }

  /**
   * Makes account `accountId` a platform admin at `now`, in `trx` (the admin bootstrap of dist/cli.js, PBE-028; the
   * admin's grant, PBE-032), with `version + 1` (the `Account` shows `isPlatformAdmin`). Returns `false` when it was a
   * platform admin already (nothing changed).
   */
  async grantPlatformAdmin(trx: PlatformTransaction, accountId: string, now: Date): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.accounts")
      .set({ is_platform_admin: true, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", accountId)
      .where("is_platform_admin", "=", false)
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }

  /**
   * The account `accountId` as `PortalSession.account` shows it, with its **active** memberships of OTAs that members
   * may see (oldest first), read on `db`; `undefined` when there is no such account.
   */
  async findPortalAccount(
    db: PlatformTransaction | PlatformDb,
    accountId: string,
  ): Promise<PortalAccountRecord | undefined> {
    const account = await db
      .selectFrom("platform.accounts")
      .select(PORTAL_ACCOUNT_COLUMNS)
      .where("id", "=", accountId)
      .executeTakeFirst();
    if (account === undefined) {
      return undefined;
    }
    return { ...account, memberships: await this.listActiveMemberships(db, accountId) };
  }

  /**
   * The **active** memberships of account `accountId` in OTAs that members may see, oldest first, with what
   * `AccountMembership` shows of each OTA, read on `db` (the portal's account and the admin's account detail).
   */
  async listActiveMemberships(
    db: PlatformTransaction | PlatformDb,
    accountId: string,
  ): Promise<AccountMembershipRecord[]> {
    return db
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.tenants as t", "t.id", "m.tenant_id")
      .select([
        "m.id as membership_id",
        "m.tenant_id",
        "t.key as tenant_key",
        "t.name as tenant_name",
        "t.status as tenant_status",
        "m.role",
      ])
      .where("m.account_id", "=", accountId)
      .where("m.status", "=", "active")
      .where("t.status", "in", MEMBER_VISIBLE_TENANT_STATUSES)
      .where("t.deleted_at", "is", null)
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
  }

  /** The credentials of account `accountId`, read on `db`; `undefined` when there is no such account. */
  async findCredentials(
    db: PlatformTransaction | PlatformDb,
    accountId: string,
  ): Promise<CredentialsAccount | undefined> {
    return db
      .selectFrom("platform.accounts")
      .select(CREDENTIALS_COLUMNS)
      .where("id", "=", accountId)
      .executeTakeFirst();
  }

  /**
   * The credentials of account `accountId`, locked for the rest of `trx` (`FOR UPDATE`): the lock of a password reset
   * or change, which also waits for every change of the account's session families (`lockForSessionChange`).
   */
  async lockCredentials(
    trx: PlatformTransaction,
    accountId: string,
  ): Promise<CredentialsAccount | undefined> {
    return trx
      .selectFrom("platform.accounts")
      .select(CREDENTIALS_COLUMNS)
      .where("id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Stores the Argon2id hash of a new password of `accountId` at `now`, in `trx`, with `password_changed_at` (the
   * cut-off for older OTA staff sessions, architecture §6.4). The password is not part of the `Account` the API shows,
   * so `version` stays as it is.
   */
  async setPassword(
    trx: PlatformTransaction,
    accountId: string,
    passwordHash: string,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.accounts")
      .set({ password_hash: passwordHash, password_changed_at: now, updated_at: now })
      .where("id", "=", accountId)
      .execute();
  }

  /** The profile of account `accountId`, locked for the rest of `trx` (`FOR UPDATE`). */
  async lockProfile(trx: PlatformTransaction, accountId: string): Promise<ProfileAccount | undefined> {
    return trx
      .selectFrom("platform.accounts")
      .select(PROFILE_COLUMNS)
      .where("id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Writes the profile `changes` of an account locked by `lockProfile`, with `version + 1` and `updated_at = now`, in
   * `trx`. Returns the new version.
   */
  async updateProfile(
    trx: PlatformTransaction,
    accountId: string,
    changes: AccountProfileChanges,
    now: Date,
  ): Promise<number> {
    const row = await trx
      .updateTable("platform.accounts")
      .set({ ...changes, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", accountId)
      .returning("version")
      .executeTakeFirstOrThrow();
    return row.version;
  }

  /**
   * True when `name` is a zone of `reference.time_zones`: `accounts.time_zone` refers to it by value, as
   * `tenants.time_zone` does (read only, architecture §2.1).
   */
  async timeZoneExists(db: PlatformTransaction | PlatformDb, name: string): Promise<boolean> {
    const row = await db
      .selectFrom("reference.time_zones")
      .select("name")
      .where("name", "=", name)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Up to `limit` accounts of the admin's search, newest first (`created_at`, then id), read on `db`: `q` matches
   * part of the e-mail address or the name ignoring letter case, `status` filters, and with `afterId` only the
   * accounts after that one in this order are read (the cursor's account; the comparison runs in SQL, so the
   * microseconds of `created_at` count).
   */
  async searchForAdmin(
    db: PlatformTransaction | PlatformDb,
    search: AdminAccountSearch,
    afterId: string | undefined,
    limit: number,
  ): Promise<AdminAccountRecord[]> {
    let query = db.selectFrom("platform.accounts").select(ADMIN_ACCOUNT_COLUMNS);
    if (search.q !== undefined) {
      const pattern = containsPattern(search.q);
      query = query.where((eb) => eb.or([eb("email", "ilike", pattern), eb("full_name", "ilike", pattern)]));
    }
    if (search.status !== undefined) {
      query = query.where("status", "=", search.status);
    }
    if (afterId !== undefined) {
      query = query.where(
        sql<boolean>`(created_at, id) < (SELECT anchor.created_at, anchor.id FROM platform.accounts AS anchor WHERE anchor.id = ${afterId})`,
      );
    }
    return query.orderBy("created_at", "desc").orderBy("id", "desc").limit(limit).execute();
  }

  /** The account `accountId` as `AdminAccount` shows it, read on `db`; `undefined` when there is no such account. */
  async findAdminAccount(
    db: PlatformTransaction | PlatformDb,
    accountId: string,
  ): Promise<AdminAccountRecord | undefined> {
    return db
      .selectFrom("platform.accounts")
      .select(ADMIN_ACCOUNT_COLUMNS)
      .where("id", "=", accountId)
      .executeTakeFirst();
  }

  /** The account `accountId` as `AdminAccount` shows it, locked for the rest of `trx` (`FOR UPDATE`). */
  async lockAdminAccount(
    trx: PlatformTransaction,
    accountId: string,
  ): Promise<AdminAccountRecord | undefined> {
    return trx
      .selectFrom("platform.accounts")
      .select(ADMIN_ACCOUNT_COLUMNS)
      .where("id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** How many active platform admins there are (`active`, not erased, `is_platform_admin`), read on `db`. */
  async countActivePlatformAdmins(db: PlatformTransaction | PlatformDb): Promise<number> {
    const row = await db
      .selectFrom("platform.accounts")
      .select((eb) => eb.fn.countAll<string>().as("admins"))
      .where("is_platform_admin", "=", true)
      .where("status", "=", "active" satisfies AccountStatus)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number(row.admins);
  }

  /**
   * Locks every active platform admin for the rest of `trx` (`FOR UPDATE`, in id order, so two callers never wait
   * for each other in a cycle) and returns their ids. A row that stops being an active admin while the lock is awaited
   * is left out (PostgreSQL checks the condition again on the new row version).
   */
  async lockActivePlatformAdmins(trx: PlatformTransaction): Promise<string[]> {
    const rows = await trx
      .selectFrom("platform.accounts")
      .select("id")
      .where("is_platform_admin", "=", true)
      .where("status", "=", "active" satisfies AccountStatus)
      .where("deleted_at", "is", null)
      .orderBy("id")
      .forUpdate()
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Moves account `accountId` from one of the states `from` to `to` at `now`, with `version + 1` (the `AdminAccount`
   * shows the status), in `trx`. Returns `false` when the account is in none of the states `from` (nothing changed).
   */
  async setStatus(
    trx: PlatformTransaction,
    accountId: string,
    from: readonly AccountStatus[],
    to: AccountStatus,
    now: Date,
  ): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.accounts")
      .set({ status: to, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", accountId)
      .where("status", "in", from)
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }

  /**
   * Ends the sign-in lockout of `accountId` at `now`, in `trx` (adminUnlockAccount): the failure count and
   * `locked_until` are cleared, so the next sign-in with the right password works. Bookkeeping, like the sign-in
   * counters: `version` stays.
   */
  async clearLockout(trx: PlatformTransaction, accountId: string, now: Date): Promise<void> {
    await trx
      .updateTable("platform.accounts")
      .set({ failed_login_count: 0, locked_until: null, updated_at: now })
      .where("id", "=", accountId)
      .execute();
  }

  /**
   * Takes the platform admin rights from `accountId` at `now`, with `version + 1`, in `trx` (adminRevokeAdmin).
   * Returns `false` when it was not a platform admin (nothing changed).
   */
  async revokePlatformAdmin(trx: PlatformTransaction, accountId: string, now: Date): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.accounts")
      .set({ is_platform_admin: false, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", accountId)
      .where("is_platform_admin", "=", true)
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }

  /** Every account with `is_platform_admin`, by name (then id), read on `db` (adminListAdmins). */
  async listPlatformAdmins(db: PlatformTransaction | PlatformDb): Promise<AdminAccountRecord[]> {
    return db
      .selectFrom("platform.accounts")
      .select(ADMIN_ACCOUNT_COLUMNS)
      .where("is_platform_admin", "=", true)
      .orderBy("full_name")
      .orderBy("id")
      .execute();
  }
}
