// The `tenant_payout_accounts` repository (platform/docs/architecture.md §2.1: SettlementsModule owns the table;
// PADR-0003 item 10, flows/stripe-payments-account.md §B). One row per tenant (the primary key is `tenant_id`): the bank
// account where Velexis pays the OTA's settlements in `velexis` mode. The bank identifiers are one envelope-encrypted
// JSON value (`bank_details_ciphertext`, associated data `platform.tenant_payout_accounts.bank_details_ciphertext:
// <tenant id>`, ADR-0010); only `last4` is kept in clear. Kysely on the process's `PLATFORM_DB`, schema-qualified
// tables (ADR-0005).
//
// Every read that answers the portal or the admin selects the row without its ciphertext (`PayoutAccountView`); only
// `findWithDetails`, for the admin's reveal, and `lockWithDetailsForTenant`, for the owner's change (which compares
// the stored identifiers with the typed ones in memory, FIX-W35-PLATFORM), select it. The owners' e-mail of a review
// reads their active owner memberships and accounts (`activeOwners`), and the ops alert the OTA's name and key
// (`tenantLabel`), read only, as the operations' `x-platform-tables` say (as billing-customers.repository.ts reads
// the tenant and the account).
import { Inject, Injectable } from "@nestjs/common";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** A `platform.tenant_payout_accounts` row with its ciphertext: decrypt it for the reveal only, never answer it. */
export type PayoutAccountRecord = Selectable<PlatformDatabase["platform.tenant_payout_accounts"]>;

/** A payout account row without its ciphertext: what the API may read to answer. */
export type PayoutAccountView = Omit<PayoutAccountRecord, "bank_details_ciphertext">;

/** The schemes of `tenant_payout_accounts.scheme`. */
export type PayoutScheme = "iban" | "local";

/** The review states of `tenant_payout_accounts.status`. */
export type PayoutAccountStatus = "pending_review" | "verified" | "rejected";

/** The columns of a `PayoutAccountView`: every column but the ciphertext, which is never selected for an answer. */
const PAYOUT_ACCOUNT_VIEW_COLUMNS = [
  "tenant_id",
  "account_holder_name",
  "country_code",
  "currency",
  "scheme",
  "encryption_key_id",
  "last4",
  "status",
  "review_note",
  "reviewed_by_account_id",
  "reviewed_at",
  "updated_by_account_id",
  "version",
  "created_at",
  "updated_at",
] as const;

/** The columns an owner's `setPayoutAccount` writes. */
export interface PayoutAccountWrite {
  readonly tenantId: string;
  readonly accountHolderName: string;
  readonly countryCode: string;
  readonly currency: string;
  readonly scheme: PayoutScheme;
  /** The envelope of the bank identifiers' JSON, bound to the row (`bankDetailsPlace` of the service). */
  readonly bankDetailsCiphertext: Buffer;
  /** The KEK that wraps its data key. */
  readonly encryptionKeyId: string;
  readonly last4: string;
  /** The owner who set it. */
  readonly updatedByAccountId: string;
  readonly now: Date;
}

/** An admin's review of a locked row. */
export interface PayoutAccountReview {
  readonly tenantId: string;
  readonly status: "verified" | "rejected";
  /** The note of a rejection; `null` for a verification. */
  readonly reviewNote: string | null;
  readonly reviewedByAccountId: string;
  readonly now: Date;
}

/** An active owner of a tenant, as the review e-mail addresses them. */
export interface PayoutAccountOwner {
  readonly account_id: string;
  readonly email: string;
  readonly full_name: string;
}

/** The OTA's name and key, as the e-mails name it. */
export interface TenantLabel {
  readonly name: string;
  readonly key: string;
}

@Injectable()
export class PayoutAccountsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The tenant's payout account without its ciphertext, read on `db` (the pool, or the caller's transaction). */
  async findForTenant(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<PayoutAccountView | undefined> {
    return db
      .selectFrom("platform.tenant_payout_accounts")
      .select(PAYOUT_ACCOUNT_VIEW_COLUMNS)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
  }

  /**
   * The tenant's payout account **with** its ciphertext, read in `trx` with `FOR SHARE` (a change of the owner waits
   * for the reveal, or the reveal sees it): for `adminRevealPayoutAccount` only.
   */
  async findWithDetails(
    trx: PlatformTransaction,
    tenantId: string,
  ): Promise<PayoutAccountRecord | undefined> {
    return trx
      .selectFrom("platform.tenant_payout_accounts")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .forShare()
      .executeTakeFirst();
  }

  /**
   * The tenant's payout account **with** its ciphertext, locked for the rest of `trx` (`FOR UPDATE`): for
   * `setPayoutAccount` only, which decrypts it in memory to find out whether the owner typed the stored account again
   * (FIX-W35-PLATFORM, lead decision (2i) of 2026-10-30). Never answer the record: answer its view.
   */
  async lockWithDetailsForTenant(
    trx: PlatformTransaction,
    tenantId: string,
  ): Promise<PayoutAccountRecord | undefined> {
    return trx
      .selectFrom("platform.tenant_payout_accounts")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The tenant's payout account without its ciphertext, locked for the rest of `trx` (`FOR UPDATE`). */
  async lockForTenant(trx: PlatformTransaction, tenantId: string): Promise<PayoutAccountView | undefined> {
    return trx
      .selectFrom("platform.tenant_payout_accounts")
      .select(PAYOUT_ACCOUNT_VIEW_COLUMNS)
      .where("tenant_id", "=", tenantId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Sets the tenant's payout account in `trx`: a new row (version 1), or new values for the row (`version + 1`), in
   * both cases `pending_review` with the review cleared (note, reviewer and time: the review was of other details).
   * `INSERT … ON CONFLICT (tenant_id) DO UPDATE`, so two first settings at the same time give one row and two versions.
   * The row comes back without its ciphertext.
   */
  async upsert(trx: PlatformTransaction, write: PayoutAccountWrite): Promise<PayoutAccountView> {
    const values = {
      account_holder_name: write.accountHolderName,
      country_code: write.countryCode,
      currency: write.currency,
      scheme: write.scheme,
      bank_details_ciphertext: write.bankDetailsCiphertext,
      encryption_key_id: write.encryptionKeyId,
      last4: write.last4,
      status: "pending_review" satisfies PayoutAccountStatus,
      review_note: null,
      reviewed_by_account_id: null,
      reviewed_at: null,
      updated_by_account_id: write.updatedByAccountId,
      updated_at: write.now,
    };
    return trx
      .insertInto("platform.tenant_payout_accounts")
      .values({ tenant_id: write.tenantId, ...values, version: 1, created_at: write.now })
      .onConflict((conflict) =>
        conflict.column("tenant_id").doUpdateSet((eb) => ({
          ...values,
          version: eb("platform.tenant_payout_accounts.version", "+", 1),
        })),
      )
      .returning(PAYOUT_ACCOUNT_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * Records an admin's review on a row locked by `lockForTenant`, with `version + 1`, in `trx`. The bank details stay
   * as they are; the row comes back without its ciphertext.
   */
  async review(trx: PlatformTransaction, review: PayoutAccountReview): Promise<PayoutAccountView> {
    return trx
      .updateTable("platform.tenant_payout_accounts")
      .set((eb) => ({
        status: review.status,
        review_note: review.reviewNote,
        reviewed_by_account_id: review.reviewedByAccountId,
        reviewed_at: review.now,
        version: eb("version", "+", 1),
        updated_at: review.now,
      }))
      .where("tenant_id", "=", review.tenantId)
      .returning(PAYOUT_ACCOUNT_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** The name and key of the tenant `tenantId`, read on `db`; `undefined` when there is no such tenant. */
  async tenantLabel(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<TenantLabel | undefined> {
    return db
      .selectFrom("platform.tenants")
      .select(["name", "key"])
      .where("id", "=", tenantId)
      .executeTakeFirst();
  }

  /**
   * The active owners of `tenantId`, oldest membership first, with their e-mail address and name (read only), in
   * `trx`: the recipients of the review e-mail. An account that is disabled or deleted gets no e-mail.
   */
  async activeOwners(trx: PlatformTransaction, tenantId: string): Promise<PayoutAccountOwner[]> {
    return trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(["m.account_id", "a.email", "a.full_name"])
      .where("m.tenant_id", "=", tenantId)
      .where("m.role", "=", "owner")
      .where("m.status", "=", "active")
      .where("a.status", "not in", ["disabled", "deleted"])
      .where("a.deleted_at", "is", null)
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
  }
}
