// The rows of the customer account operations (OBE-035; the document's getAccount, updateAccount and deleteAccount,
// db README §7 "End-customer erasure inside a tenant" and §8): what account.update and account.delete write of
// `customers`, `customer_identities`, `customer_consents` and `customer_password_resets`, the customer's open
// `checkouts` a deletion abandons, and the `bookings` (with their `payments` and `refunds`) that hold a deletion back.
// The customer rows that the identity module already reads (`CustomersRepository`: the customer, its lock, its
// verification identity, the address checks) are read there; the sessions are revoked through `SessionsService`.
//
// Kysely on the caller's tenant transaction (`TenantTx`, search_path `tenant_<key>`); tables are never
// schema-qualified. Times come from the service's `Clock`, never the database's `now()`. Password hashes leave this
// file only towards the Argon2id verification of the current password, never towards a log or an answer.
//
// Locks (account.service.ts): a deletion locks the customer's open checkouts first (`lockOpenCheckouts`, `FOR UPDATE`
// in id order), then the customer (`CustomersRepository.lockCustomer`), then abandons the checkouts
// (`abandonOpenCheckouts`) and writes the identity, the sessions, the reset tokens and the consent log: the checkout
// comes before everything a checkout completion or a payment locks after it (the booking and the payment, whose inserts
// take the customer's `FOR KEY SHARE`), and the customer before its identity and sessions, as the identity module
// orders them. checkout.create takes them the other way round (its insert holds the customer's `FOR KEY SHARE` while it
// abandons the customer's other open checkouts of the same offer): the service runs the deletion's transaction again
// when PostgreSQL ends that cycle with a deadlock. The bookings, payments and refunds that may hold a deletion back
// are read without a lock: a booking claimed for one of the locked checkouts is either committed before the lock was
// granted (and seen here) or waits for this transaction and finds its checkout abandoned. A checkout whose booking is
// still `pending` (a test booking that does not hold back a deletion in the live environment) is locked but never
// abandoned: nothing of it changes until the reconciliation decides (OADR-0003 point 10). The payments of the
// abandoned checkouts whose authorisation may still hold money (`voidablePaymentsOf`) are read in the same
// transaction, for the `payment.void` jobs the service queues after the commit.
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase, type Updateable } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import { isLiveGeneration } from "../identity/sessions.service";
import { VOIDABLE_STATUSES } from "../payments/payments.processor";

type Db = TenantDatabase;

/** The checkout states a deletion abandons: the customer can no longer finish them. */
export const OPEN_CHECKOUT_STATUSES: readonly string[] = Object.freeze(["open", "payment_pending"]);

/** The booking ticketing states that still wait for tickets (the document: "awaiting ticketing"). */
export const AWAITING_TICKETING_STATUSES: readonly string[] = Object.freeze([
  "pending",
  "in_progress",
  "partially_issued",
  "failed",
  "manual_review",
]);

/** The payment states that still wait for the money to move (the document: "awaiting payment"). */
export const AWAITING_PAYMENT_STATUSES: readonly string[] = Object.freeze([
  "requires_action",
  "processing",
  "authorized",
]);

/** The refund states that still wait for the provider (the document: "awaiting a refund"). */
export const AWAITING_REFUND_STATUSES: readonly string[] = Object.freeze(["pending", "processing"]);

/** The most booking ids a refused deletion names (`details.bookingIds`). */
export const MAX_BLOCKING_BOOKINGS = 50;

/** A customer's enabled password identity, with its hash: what the re-authentication verifies against. */
export interface AccountPasswordIdentity {
  /** `cid_…` */
  readonly identityId: string;
  /** The address as identities store it (trimmed, lower case): the key of the sign-in lockout. */
  readonly subject: string;
  /** The Argon2id hash in PHC format. Never logged or answered. */
  readonly passwordHash: string;
}

/** The `customers` columns account.update may change (the service bumps `version` and `updated_at` with them). */
export type ProfileUpdate = Pick<
  Updateable<Db["customers"]>,
  | "first_name"
  | "last_name"
  | "phone_country_code"
  | "phone_number"
  | "date_of_birth"
  | "marketing_consent"
  | "marketing_consent_updated_at"
  | "marketing_consent_source"
  | "pending_email"
>;

/** What a deletion writes into `customers`. */
export interface DeletedCustomer {
  readonly customerId: string;
  /** `<hex>@deleted.invalid`, the value `customers_deleted_ck` asks for. */
  readonly placeholder: string;
  readonly now: Date;
}

@Injectable()
export class AccountRepository {
  /**
   * True when session (refresh family) `sessionId` of `customerId` is still live at `now`: its current generation (the
   * newest row that was not rotated) is neither revoked nor past its end (SessionsService `isLiveGeneration`). A
   * signed-out, revoked or ended session, and one of another customer, is not.
   */
  async liveSession(
    trx: TenantTransaction,
    customerId: string,
    sessionId: string,
    now: Date,
  ): Promise<boolean> {
    const current = await trx
      .selectFrom("customer_sessions")
      .select(["customer_id", "revoked_at", "expires_at", "family_expires_at"])
      .where("family_id", "=", sessionId)
      .where("rotated_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return current !== undefined && current.customer_id === customerId && isLiveGeneration(current, now);
  }

  /**
   * The enabled password identity of `customerId`; `undefined` when it has none (an erased account, one disabled by
   * staff, a customer without a password).
   */
  async passwordIdentity(
    trx: TenantTransaction,
    customerId: string,
  ): Promise<AccountPasswordIdentity | undefined> {
    const row = await trx
      .selectFrom("customer_identities")
      .select(["id", "provider_subject", "password_hash"])
      .where("customer_id", "=", customerId)
      .where("provider", "=", "password")
      .where("disabled_at", "is", null)
      .executeTakeFirst();
    if (row === undefined || row.password_hash === null) {
      return undefined;
    }
    return { identityId: row.id, subject: row.provider_subject, passwordHash: row.password_hash };
  }

  /** Writes `changes` into customer `customerId` at `now`, with `version` + 1 (the ETag of account.get changes). */
  async updateProfile(
    trx: TenantTransaction,
    customerId: string,
    changes: ProfileUpdate,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("customers")
      .set({ ...changes, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", customerId)
      .execute();
  }

  /**
   * Drops the identity's verification token at `now` (the pending address it was sent for was withdrawn): the link
   * stops working, as verification.service.ts asks of whoever clears `pending_email`. `verification_sent_at` stays, so
   * the minute between two verification e-mails still counts from the last one.
   */
  async dropVerificationToken(trx: TenantTransaction, identityId: string, now: Date): Promise<void> {
    await trx
      .updateTable("customer_identities")
      .set({ verification_token_hash: null, verification_expires_at: null, updated_at: now })
      .where("id", "=", identityId)
      .execute();
  }

  /** Appends `consent` to the customer's consent log (append-only). */
  async insertConsent(trx: TenantTransaction, consent: Insertable<Db["customer_consents"]>): Promise<void> {
    await trx.insertInto("customer_consents").values(consent).execute();
  }

  /**
   * Locks the customer's checkouts that are still open or waiting for their payment (`FOR UPDATE`, in id order): the
   * first locks of a deletion (see the file header). Answers how many.
   */
  async lockOpenCheckouts(trx: TenantTransaction, customerId: string): Promise<number> {
    const rows = await trx
      .selectFrom("checkouts")
      .select("id")
      .where("customer_id", "=", customerId)
      .where("status", "in", [...OPEN_CHECKOUT_STATUSES])
      .orderBy("id")
      .forUpdate()
      .execute();
    return rows.length;
  }

  /**
   * Marks the customer's open and payment-pending checkouts `abandoned` at `now`, except one whose booking is still
   * `pending` (OADR-0003 point 10: the order may exist, so the checkout and its authorisation wait for the
   * reconciliation); answers their ids. Run under the customer's lock, after `lockOpenCheckouts`: it also catches a
   * checkout that a checkout.create committed between the two (its insert held the customer's `FOR KEY SHARE`, which
   * the customer's lock waited for), and, as a statement of its own, sees a claim that committed while the locks were
   * awaited.
   */
  async abandonOpenCheckouts(trx: TenantTransaction, customerId: string, now: Date): Promise<string[]> {
    const rows = await trx
      .updateTable("checkouts")
      .set({ status: "abandoned", version: sql<number>`version + 1`, updated_at: now })
      .where("customer_id", "=", customerId)
      .where("status", "in", [...OPEN_CHECKOUT_STATUSES])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("bookings")
              .select("bookings.id")
              .whereRef("bookings.checkout_id", "=", "checkouts.id")
              .where("bookings.status", "=", "pending"),
          ),
        ),
      )
      .returning("id")
      .execute();
    return rows.map((row) => row.id).sort();
  }

  /**
   * The Stripe payments of the checkouts `checkoutIds` (just abandoned) whose PaymentIntent may still hold or take the
   * customer's money (`VOIDABLE_STATUSES` of the payments queue: not confirmed yet, or authorised) and that pay for no
   * order (no booking, or a `failed` one), in id order: the payments a deletion voids, as the checkout expiry voids an
   * expired checkout's. An airline-card payment, or one that never reached Stripe, has nothing to void.
   */
  async voidablePaymentsOf(trx: TenantTransaction, checkoutIds: readonly string[]): Promise<string[]> {
    if (checkoutIds.length === 0) {
      return [];
    }
    const rows = await trx
      .selectFrom("payments as p")
      .select("p.id")
      .where("p.checkout_id", "in", [...checkoutIds])
      .where("p.provider", "=", "stripe")
      .where("p.provider_payment_id", "is not", null)
      .where("p.status", "in", [...VOIDABLE_STATUSES])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("bookings as b")
              .select("b.id")
              .whereRef("b.id", "=", "p.booking_id")
              .where("b.status", "<>", "failed"),
          ),
        ),
      )
      .orderBy("p.id")
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * The customer's bookings of `environments` that still wait for payment, ticketing or a refund (the document's
   * `ACCOUNT_DELETION_BLOCKED`), oldest first, at most `MAX_BLOCKING_BOOKINGS`:
   *
   * - `pending`: the order is being created or reconciled, its payment authorised and not yet captured or released;
   * - `confirmed` or `partially_ticketed` while tickets are still awaited (`AWAITING_TICKETING_STATUSES`);
   * - any but a `failed` one with a payment whose money has not moved yet (`AWAITING_PAYMENT_STATUSES`: an uncaptured
   *   authorisation, a payment being processed); a failed booking booked nothing, and its authorisation is released;
   * - any with a refund that has not reached the provider's answer yet (`AWAITING_REFUND_STATUSES`).
   */
  async blockingBookings(
    trx: TenantTransaction,
    customerId: string,
    environments: readonly ("test" | "live")[],
  ): Promise<string[]> {
    const rows = await trx
      .selectFrom("bookings as b")
      .select("b.id")
      .where("b.customer_id", "=", customerId)
      .where("b.environment", "in", [...environments])
      .where((eb) =>
        eb.or([
          eb("b.status", "=", "pending"),
          eb.and([
            eb("b.status", "in", ["confirmed", "partially_ticketed"]),
            eb("b.ticketing_status", "in", [...AWAITING_TICKETING_STATUSES]),
          ]),
          eb.and([
            eb("b.status", "<>", "failed"),
            eb.exists(
              eb
                .selectFrom("payments as p")
                .select("p.id")
                .whereRef("p.booking_id", "=", "b.id")
                .where("p.status", "in", [...AWAITING_PAYMENT_STATUSES]),
            ),
          ]),
          eb.exists(
            eb
              .selectFrom("refunds as r")
              .select("r.id")
              .whereRef("r.booking_id", "=", "b.id")
              .where("r.status", "in", [...AWAITING_REFUND_STATUSES]),
          ),
        ]),
      )
      .orderBy("b.created_at")
      .orderBy("b.id")
      .limit(MAX_BLOCKING_BOOKINGS)
      .execute();
    return rows.map((row) => row.id);
  }

  /** True when the customer has a booking of any environment (the records a deletion keeps). */
  async hasBookings(trx: TenantTransaction, customerId: string): Promise<boolean> {
    const row = await trx
      .selectFrom("bookings")
      .select("id")
      .where("customer_id", "=", customerId)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Disables every enabled identity of the deleted customer at `now` (db README §7): `disabled_at`, the subject and
   * the asserted address replaced by the placeholder, the verification token dropped. A disabled identity frees its
   * subject (`customer_identities_subject_uq` covers enabled identities only), so the address can sign up again.
   */
  async disableIdentities(trx: TenantTransaction, deleted: DeletedCustomer): Promise<number> {
    const rows = await trx
      .updateTable("customer_identities")
      .set({
        disabled_at: deleted.now,
        provider_subject: deleted.placeholder,
        email: deleted.placeholder,
        verification_token_hash: null,
        verification_expires_at: null,
        updated_at: deleted.now,
      })
      .where("customer_id", "=", deleted.customerId)
      .where("disabled_at", "is", null)
      .returning("id")
      .execute();
    return rows.length;
  }

  /** Ends every open reset token of `customerId` at `now` (unused, not yet expired); answers how many. */
  async expireOpenResets(trx: TenantTransaction, customerId: string, now: Date): Promise<number> {
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

  /**
   * Records the deletion in `customers` (db README §7, `customers_deleted_ck`): `deleted`, `deleted_at`, the address
   * replaced by the placeholder, no pending address, marketing consent withdrawn (source `account`), `version` + 1.
   * Names, phone and date of birth stay until the erasure job (OBE-087) anonymises the row.
   */
  async markDeleted(trx: TenantTransaction, deleted: DeletedCustomer): Promise<void> {
    await trx
      .updateTable("customers")
      .set({
        status: "deleted",
        deleted_at: deleted.now,
        email: deleted.placeholder,
        pending_email: null,
        marketing_consent: false,
        marketing_consent_updated_at: deleted.now,
        marketing_consent_source: "account",
        version: sql<number>`version + 1`,
        updated_at: deleted.now,
      })
      .where("id", "=", deleted.customerId)
      .execute();
  }
}
