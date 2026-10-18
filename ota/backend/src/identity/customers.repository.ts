// The customer rows of the identity module (OBE-033, extended by OBE-032 for sign-up and verification): `customers`
// and the password identities of `customer_identities` (db README §7), and the one storefront setting the sign-in
// reads (`customer_accounts_enabled`). Kysely on the caller's tenant transaction (`TenantTx`, search_path
// `tenant_<key>`); tables are never schema-qualified. Times come from the service's `Clock`, never the database's
// `now()`. Password hashes leave this file only towards the sign-in's Argon2id verification, never towards a log or
// an answer.
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

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
      ])
      .where("id", "=", customerId)
      .executeTakeFirst();
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
}
