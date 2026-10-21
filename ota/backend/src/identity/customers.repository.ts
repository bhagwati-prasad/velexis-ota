// The customer rows of the identity module (OBE-033 for sign-in, OBE-032 for sign-up and e-mail verification):
// `customers`, the password identities of `customer_identities` with their verification tokens (db README §7),
// `customer_preferences`, the `customer_consents` log, the guest bookings an e-mail verification attaches to its
// customer (`bookings.customer_id` and a `booking_events` row each), and the storefront settings sign-up and sign-in
// read. Kysely on the caller's tenant transaction (`TenantTx`, search_path `tenant_<key>`); tables are never
// schema-qualified. Times come from the service's `Clock`, never the database's `now()`. Password hashes leave this
// file only towards the sign-in's Argon2id verification, never towards a log or an answer; verification tokens are
// only ever stored and looked up as their SHA-256.
//
// Locks: a change of a customer's verification state or address takes the customer's `FOR UPDATE` lock first
// (`lockCustomer`), then writes the identity and the bookings, the order of the sign-in (customer, then identity) and of
// SessionsService (the customer before its sessions), so two of these transactions never wait for each other in a
// cycle.
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

type Db = TenantDatabase;

/** The `customers` columns an answer shows (`Customer` of the document), `date_of_birth` as `YYYY-MM-DD` text. */
export interface CustomerRecord {
  readonly id: string;
  readonly email: string;
  readonly email_verified_at: Date | null;
  readonly pending_email: string | null;
  readonly first_name: string | null;
  readonly last_name: string | null;
  /** `YYYY-MM-DD` (read with `to_char`, never through node-pg's local-time `Date`). */
  readonly date_of_birth: string | null;
  readonly phone_country_code: string | null;
  readonly phone_number: string | null;
  readonly status: string;
  readonly marketing_consent: boolean;
  readonly marketing_consent_updated_at: Date | null;
  readonly marketing_consent_source: string | null;
  readonly terms_accepted_version: string | null;
  readonly last_sign_in_at: Date | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly version: number;
}

/** A password identity found by its address, with the state of its customer: what the sign-in decides on. */
export interface PasswordIdentity {
  /** `cid_…` */
  readonly identityId: string;
  /** `cus_…` */
  readonly customerId: string;
  /** The Argon2id hash in PHC format. Never logged or answered. */
  readonly passwordHash: string;
  readonly customerStatus: string;
  readonly customerDeletedAt: Date | null;
}

/** The storefront settings sign-up and the verification e-mails read (`storefront_settings`). */
export interface AccountSettings {
  readonly customerAccountsEnabled: boolean;
  /** Customers verify their address before checkout (`storefront.auth.emailVerification`). */
  readonly requireEmailVerification: boolean;
  /** `terms_version`, as stored (storefront.mapper.ts `legalOf` publishes it, or the fallback). */
  readonly termsVersion: string | null;
  readonly privacyVersion: string | null;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly defaultCurrency: string;
  readonly supportedCurrencies: readonly string[];
  /** When the settings row was seeded: the day the legal versions fall back to. */
  readonly createdAt: Date;
}

/** A new customer of sign-up, with its password identity, preferences and consent events. */
export interface NewCustomerAccount {
  readonly customer: Insertable<Db["customers"]>;
  readonly identity: Insertable<Db["customer_identities"]>;
  readonly preferences: Insertable<Db["customer_preferences"]>;
  readonly consents: readonly Insertable<Db["customer_consents"]>[];
}

/** A customer's enabled password identity and the state of its verification token. */
export interface VerificationIdentity {
  /** `cid_…` */
  readonly identityId: string;
  /** `cus_…` */
  readonly customerId: string;
  /** When this identity's address (the one its last token was for) was verified. */
  readonly emailVerifiedAt: Date | null;
  /** When the last token was issued; a token is used once `emailVerifiedAt` is at or after it. */
  readonly tokenSentAt: Date | null;
  readonly tokenExpiresAt: Date | null;
}

/** The token of a new verification e-mail, as stored: its SHA-256, never the token. */
export interface VerificationToken {
  readonly tokenHash: string;
  readonly sentAt: Date;
  readonly expiresAt: Date;
}

/** What a verification of `customerId`'s address writes. */
export interface VerifiedAddress {
  readonly customerId: string;
  readonly identityId: string;
  readonly now: Date;
}

/** The guest bookings a verification attaches: of the environment, without a customer, with the verified address. */
export interface ClaimGuestBookings {
  readonly customerId: string;
  /** The verified address; compared lower-cased with `contact_email` (`bookings_contact_email_idx`). */
  readonly email: string;
  readonly environment: "test" | "live";
  readonly now: Date;
  /** A new `evt_…` id for each booking event. */
  readonly newEventId: () => string;
  /** The request's `X-Request-Id`, kept on the events. */
  readonly requestId: string | null;
}

/** The `booking_events.type` of a guest booking attached to the customer who verified its contact address. */
export const BOOKING_CLAIMED_EVENT = "booking.claimed";

@Injectable()
export class CustomersRepository {
  /**
   * The enabled password identity whose subject is `normalisedEmail` (the address trimmed and in lower case, as
   * identities store it), with its customer; `undefined` when there is none. A disabled identity (an erased account,
   * one disabled by staff) frees its subject (`customer_identities_subject_uq`) and is never found.
   */
  async findPasswordIdentity(
    trx: TenantTransaction,
    normalisedEmail: string,
  ): Promise<PasswordIdentity | undefined> {
    const row = await trx
      .selectFrom("customer_identities as i")
      .innerJoin("customers as c", "c.id", "i.customer_id")
      .select(["i.id as identity_id", "i.customer_id", "i.password_hash", "c.status", "c.deleted_at"])
      .where("i.provider", "=", "password")
      .where("i.provider_subject", "=", normalisedEmail)
      .where("i.disabled_at", "is", null)
      .executeTakeFirst();
    if (row === undefined || row.password_hash === null) {
      return undefined;
    }
    return {
      identityId: row.identity_id,
      customerId: row.customer_id,
      passwordHash: row.password_hash,
      customerStatus: row.status,
      customerDeletedAt: row.deleted_at,
    };
  }

  /** Customer `customerId` as answers show it; `undefined` when there is none. */
  async findCustomer(trx: TenantTransaction, customerId: string): Promise<CustomerRecord | undefined> {
    return this.customerQuery(trx).where("id", "=", customerId).executeTakeFirst();
  }

  /**
   * Customer `customerId` as answers show it, locked `FOR UPDATE` until `trx` ends (see the file header): the first lock
   * of every change of its verification state or address. `undefined` when there is none.
   */
  async lockCustomer(trx: TenantTransaction, customerId: string): Promise<CustomerRecord | undefined> {
    return this.customerQuery(trx).where("id", "=", customerId).forUpdate().executeTakeFirst();
  }

  /** The `customers` columns of `CustomerRecord`. */
  private customerQuery(trx: TenantTransaction) {
    return trx
      .selectFrom("customers")
      .select([
        "id",
        "email",
        "email_verified_at",
        "pending_email",
        "first_name",
        "last_name",
        sql<string | null>`to_char(date_of_birth, 'YYYY-MM-DD')`.as("date_of_birth"),
        "phone_country_code",
        "phone_number",
        "status",
        "marketing_consent",
        "marketing_consent_updated_at",
        "marketing_consent_source",
        "terms_accepted_version",
        "last_sign_in_at",
        "deleted_at",
        "created_at",
        "updated_at",
        "version",
      ]);
  }

  /**
   * Records a successful password sign-in at `now`: `customers.last_sign_in_at` and the identity's `last_used_at`. The
   * customer's `version` and `updated_at` stay: a sign-in does not change the profile, so it never makes an
   * `If-Match` of account.update stale.
   */
  async recordSignIn(
    trx: TenantTransaction,
    customerId: string,
    identityId: string,
    now: Date,
  ): Promise<void> {
    await trx.updateTable("customers").set({ last_sign_in_at: now }).where("id", "=", customerId).execute();
    await trx
      .updateTable("customer_identities")
      .set({ last_used_at: now, updated_at: now })
      .where("id", "=", identityId)
      .execute();
  }

  /**
   * Whether customers may sign up and sign in (`storefront_settings.customer_accounts_enabled`); the column's default
   * (true) when the settings row is missing, which provisioning never leaves so.
   */
  async customerAccountsEnabled(trx: TenantTransaction): Promise<boolean> {
    const row = await trx
      .selectFrom("storefront_settings")
      .select("customer_accounts_enabled")
      .executeTakeFirst();
    return row?.customer_accounts_enabled ?? true;
  }

  /** The settings of sign-up and of the verification e-mails; `undefined` when the row is missing (not provisioned). */
  async accountSettings(trx: TenantTransaction): Promise<AccountSettings | undefined> {
    return trx
      .selectFrom("storefront_settings")
      .select([
        "customer_accounts_enabled as customerAccountsEnabled",
        "require_email_verification as requireEmailVerification",
        "terms_version as termsVersion",
        "privacy_version as privacyVersion",
        "default_locale as defaultLocale",
        "supported_locales as supportedLocales",
        "default_currency as defaultCurrency",
        "supported_currencies as supportedCurrencies",
        "created_at as createdAt",
      ])
      .where("id", "=", "sfs_default")
      .executeTakeFirst();
  }

  /** The customer's preferred locale (`customer_preferences.locale`), or `null`. */
  async preferredLocale(trx: TenantTransaction, customerId: string): Promise<string | null> {
    const row = await trx
      .selectFrom("customer_preferences")
      .select("locale")
      .where("customer_id", "=", customerId)
      .executeTakeFirst();
    return row?.locale ?? null;
  }

  /**
   * True when `normalisedEmail` (trimmed, lower case) is the address of a customer (`customers_email_lower_uq`) or the
   * subject of an enabled password identity (`customer_identities_subject_uq`), other than `exceptCustomerId`'s.
   */
  async addressTaken(
    trx: TenantTransaction,
    normalisedEmail: string,
    exceptCustomerId?: string,
  ): Promise<boolean> {
    let customers = trx
      .selectFrom("customers")
      .select("id")
      .where(sql<string>`lower(email)`, "=", normalisedEmail);
    let identities = trx
      .selectFrom("customer_identities")
      .select("customer_id as id")
      .where("provider", "=", "password")
      .where("provider_subject", "=", normalisedEmail)
      .where("disabled_at", "is", null);
    if (exceptCustomerId !== undefined) {
      customers = customers.where("id", "<>", exceptCustomerId);
      identities = identities.where("customer_id", "<>", exceptCustomerId);
    }
    const row = await customers.union(identities).limit(1).executeTakeFirst();
    return row !== undefined;
  }

  /** Inserts a signed-up customer with its identity, preferences and consent events, in this order. */
  async insertAccount(trx: TenantTransaction, account: NewCustomerAccount): Promise<void> {
    await trx.insertInto("customers").values(account.customer).execute();
    await trx.insertInto("customer_identities").values(account.identity).execute();
    await trx.insertInto("customer_preferences").values(account.preferences).execute();
    if (account.consents.length > 0) {
      await trx
        .insertInto("customer_consents")
        .values([...account.consents])
        .execute();
    }
  }

  /** The identity whose current verification token has the SHA-256 `tokenHash`; `undefined` when there is none. */
  async findByVerificationHash(
    trx: TenantTransaction,
    tokenHash: string,
  ): Promise<{ readonly identityId: string; readonly customerId: string } | undefined> {
    return trx
      .selectFrom("customer_identities")
      .select(["id as identityId", "customer_id as customerId"])
      .where("verification_token_hash", "=", tokenHash)
      .executeTakeFirst();
  }

  /**
   * The enabled password identity of `customerId` with its verification state; `undefined` when it has none (an erased
   * or staff-disabled identity). Read under the customer's lock (`lockCustomer`), the state cannot change meanwhile.
   */
  async verificationIdentityOf(
    trx: TenantTransaction,
    customerId: string,
  ): Promise<VerificationIdentity | undefined> {
    return trx
      .selectFrom("customer_identities")
      .select([
        "id as identityId",
        "customer_id as customerId",
        "email_verified_at as emailVerifiedAt",
        "verification_sent_at as tokenSentAt",
        "verification_expires_at as tokenExpiresAt",
      ])
      .where("customer_id", "=", customerId)
      .where("provider", "=", "password")
      .where("disabled_at", "is", null)
      .executeTakeFirst();
  }

  /** Replaces the identity's verification token (an earlier one stops working: its hash is gone). */
  async setVerificationToken(
    trx: TenantTransaction,
    identityId: string,
    token: VerificationToken,
  ): Promise<void> {
    await trx
      .updateTable("customer_identities")
      .set({
        verification_token_hash: token.tokenHash,
        verification_sent_at: token.sentAt,
        verification_expires_at: token.expiresAt,
        updated_at: token.sentAt,
      })
      .where("id", "=", identityId)
      .execute();
  }

  /**
   * Records the verification of the customer's current address at `now`: `customers.email_verified_at` (kept when it
   * was set already), `pending_verification` becomes `active`, `version` + 1; the identity's `email_verified_at`, which
   * also marks its token used. The token's hash stays, so presenting it again is told apart from an unknown one.
   */
  async markEmailVerified(trx: TenantTransaction, verified: VerifiedAddress): Promise<void> {
    await trx
      .updateTable("customers")
      .set({
        email_verified_at: sql<Date>`coalesce(email_verified_at, ${verified.now})`,
        status: sql<string>`case when status = 'pending_verification' then 'active' else status end`,
        version: sql<number>`version + 1`,
        updated_at: verified.now,
      })
      .where("id", "=", verified.customerId)
      .execute();
    await trx
      .updateTable("customer_identities")
      .set({ email_verified_at: verified.now, updated_at: verified.now })
      .where("id", "=", verified.identityId)
      .execute();
  }

  /**
   * Moves the customer's `pending_email` (`email`, as stored there) into `customers.email`, verified at `now`, and the
   * password identity's subject and address with it (`pending_verification` becomes `active`, `version` + 1). The
   * caller checked that no other customer holds the address; a concurrent one fails on the unique indexes.
   */
  async confirmPendingEmail(
    trx: TenantTransaction,
    verified: VerifiedAddress & { readonly email: string; readonly normalisedEmail: string },
  ): Promise<void> {
    await trx
      .updateTable("customers")
      .set({
        email: verified.email,
        pending_email: null,
        email_verified_at: verified.now,
        status: sql<string>`case when status = 'pending_verification' then 'active' else status end`,
        version: sql<number>`version + 1`,
        updated_at: verified.now,
      })
      .where("id", "=", verified.customerId)
      .execute();
    await trx
      .updateTable("customer_identities")
      .set({
        provider_subject: verified.normalisedEmail,
        email: verified.email,
        email_verified_at: verified.now,
        updated_at: verified.now,
      })
      .where("id", "=", verified.identityId)
      .execute();
  }

  /**
   * Attaches the guest bookings of the environment whose contact address is the verified one and that have no
   * customer to `customerId`, each with a `booking.claimed` event the customer sees; returns how many. The bookings'
   * `version` stays: nothing an `If-Match` of bookings.update covers changes.
   */
  async claimGuestBookings(trx: TenantTransaction, claim: ClaimGuestBookings): Promise<number> {
    const claimed = await trx
      .updateTable("bookings")
      .set({ customer_id: claim.customerId, updated_at: claim.now })
      .where("environment", "=", claim.environment)
      .where(sql<string>`lower(contact_email)`, "=", claim.email.trim().toLowerCase())
      .where("customer_id", "is", null)
      .returning("id")
      .execute();
    if (claimed.length > 0) {
      await trx
        .insertInto("booking_events")
        .values(
          claimed.map((booking) => ({
            id: claim.newEventId(),
            booking_id: booking.id,
            type: BOOKING_CLAIMED_EVENT,
            actor_type: "customer",
            actor_id: claim.customerId,
            summary: "Added to your account after you confirmed your e-mail address.",
            data: JSON.stringify({}),
            visible_to_customer: true,
            request_id: claim.requestId,
            created_at: claim.now,
            updated_at: claim.now,
          })),
        )
        .execute();
    }
    return claimed.length;
  }
}
