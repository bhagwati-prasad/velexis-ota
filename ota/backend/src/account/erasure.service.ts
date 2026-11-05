// The erasure of deleted customers (OBE-087; db README §7 "End-customer erasure inside a tenant",
// ota/docs/data-model.md §6, ota/docs/scope.md §3.1 `account.delete`, OADR-0014 points 2, 4 and 5; lead decisions (5f),
// (5g) and (5h) of 2026-11-05, FIX-W43-OTA, and (7a) and (7b) of 2026-11-05, second set, FIX-W44-OTA). account.delete
// deletes an account at once (account.service.ts: sessions revoked, identities disabled, the address replaced by the
// `…@deleted.invalid` placeholder, a marketing withdrawal in the consent log, `customers.status = 'deleted'` and
// `deleted_at`); its answer promises the erasure of the rest of the customer's personal data within 30 days
// (`erasureDueBy`, account.mapper.ts `ERASURE_DUE_AFTER_MS`; the `account.deleted` e-mail says the same, OADR-0013
// point 4). The hourly `customers.erase` job (erasure.processor.ts, fanned out per tenant by jobs/schedulers.ts,
// `active` and `suspended` tenants) erases them:
//
// - Due: `status = 'deleted'` and `deleted_at` at least ERASURE_CUTOFF_AFTER_MS (30 days less one hour and five
//   minutes: one run interval and ERASURE_MARGIN_MS) before the job's instant (`Clock`, one instant per job), so a
//   customer deleted 29 days ago is left as it is, and one becomes due one hour and five minutes before its
//   `erasureDueBy`. The status is final (no writer ever turns a deleted customer back), so a customer due once stays
//   due.
// - When: the job runs every hour (minute 50), so the first run at or after a customer's cut-off starts within the
//   hour that follows it, more than five minutes before its `erasureDueBy`: the erasure lands before the date the
//   deletion promised, between 30 days less one hour and five minutes and 30 days after the deletion, where a daily
//   run could land up to a day after it (lead decision (5f) of 2026-11-05). The five minutes (lead decision (7b) of
//   2026-11-05, second set) are for a run that starts late (a busy `ota-maintenance` queue, a worker restart) or works
//   through a full batch and its continuations slowly: it still erases before `erasureDueBy`. The cut-off is computed
//   from the job's own instant, so a run that starts late erases all that is due by then, and a continuation takes
//   its own.
// - Batches: at most ERASURE_BATCH (100) customers per job, oldest deletion first; a full batch asks for more and the
//   runner queues the job again (jobs/fan-out.ts, at most MAX_CONTINUATIONS times per run). Each customer is erased in
//   a short transaction of its own (`tenantTx`), so one customer's erasure never waits for another's, and what was
//   erased stays erased if a later one fails.
// - One erasure (`CustomerErasureRepository.erase`), in this order: the customer is checked to be due (without a lock);
//   its checkouts are detached (`customer_id` set to NULL), and of those that never became bookings (no `bookings` row
//   names them: abandoned or expired, as account.delete and the expiry left them) the travellers and contacts are
//   deleted (`checkout_travelers` with their names, contact details and encrypted documents, whose ancillary selections
//   go with them by their ON DELETE CASCADE, and `checkout_contacts`), and so are their special requests
//   (`checkout_remarks`, free text the customer or staff typed: it may name the traveller or a health need), and the
//   checkouts' own request data is cleared: `ip_address` (nullable) becomes NULL and `metadata` (NOT NULL, default
//   `{}`) becomes `{}`, on the rows that hold either (lead decision (7a) of 2026-11-05, second set; the reference
//   schema is unchanged); its bookings are detached, each with a `customer.erased` booking event (a marker without
//   personal data: no actor, no data, staff only; identity/customers.repository.ts CUSTOMER_ERASED_EVENT), so
//   `claimGuestBookings` never attaches the booking to an account again, not even to a new one of the same address
//   (lead decision (5h)); then its payments are detached. The detachments follow the lock order of checkout, booking,
//   payment, and nothing else of those rows changes, neither `version` nor `updated_at`, an amount, a reference or a
//   status (a never-booked checkout loses only its request data besides); a guest flag stays as it was. Then the
//   customer's account e-mails (its `notifications` whose template is one of ACCOUNT_EMAIL_TEMPLATE_KEYS: the
//   verification, password reset, address change and deletion e-mails, every key of the `customer` audience) lose their
//   recipient address (ERASED_RECIPIENT, a neutral placeholder for the NOT NULL column), their variables (`payload`
//   `{}`), their rendered subject (a tenant's template may name the customer) and any secret still held; a row still
//   `pending` becomes `cancelled`, so nothing is ever sent to the placeholder (lead decision (5g)). The rows stay as
//   the record that an e-mail was sent. Then its saved traveller documents and saved travellers, preferences, data
//   exports, sessions (refresh tokens with their IP addresses and user agents), password reset tokens, consent log and
//   identities are deleted; last the customer row itself (names, phone, date of birth, the placeholder address,
//   metadata), which locks it and whose foreign keys detach what remains (`notifications` and `flight_searches` rows:
//   ON DELETE SET NULL) or would delete what a statement above missed (ON DELETE CASCADE).
// - What stays: bookings, payments and refunds keep their amounts, references, travellers and contacts: they are the
//   financial record the deletion kept (account.mapper.ts `RETAINED_BOOKING_RECORDS`), and their traveller data stays
//   for the legal retention period (db README §7; data-model §6: kept until the tenant is deleted). So do the
//   travellers, contacts, special requests, IP address and metadata of the checkouts that became bookings (their
//   special requests became the booking's `booking_remarks`), and the booking e-mails. Booking events and refunds keep
//   the `cus_…` id by value of the customer who caused them; it names no row any more. Data exports are deferred in
//   the MVP (scope §3.1: account.dataExports.* answer 501, `exportData` is refused), so `customer_data_exports` holds
//   no row and no file; the task that brings them deletes an export's file with its row. The bookings' customer
//   indexes are partial (by status), so their detachment reads the table, as the foreign key's own SET NULL would: a
//   job of at most 100 customers.
// - Idempotent: everything of one customer is erased in one transaction, and an erased customer has no row, so a
//   second run (a job run again after a failure, a duplicate, the next hour's) finds nothing to do, writes no second
//   marker and clears nothing more; a customer another job erased meanwhile is not counted (that job's commit left
//   nothing for these statements to find).
// - A customer whose erasure fails is logged (`customer.erasure_failed`, the error's code only) and the job goes on
//   with the next one; at the end the job fails (`ErasureIncompleteError`), so BullMQ tries it again with the defaults
//   of ADR-0009 and the failed-job counts show it, while the others stay erased.
// - Logs: `customer.erased` per erasure with the tenant, the customer id and the counts per table, and
//   `customers.erasure_done` per job with the totals; never a name, an address, a phone number, a date of birth, a
//   token hash or anything else of the row.
//
// Like every tenant repository, CustomerErasureRepository takes the `tenantTx` transaction first, never opens one and
// never names a tenant schema (ADR-0004).
import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { newId } from "../common/ids";
import { CUSTOMER_ERASED_EVENT } from "../identity/customers.repository";
import { TEMPLATE_KEYS, TEMPLATE_REGISTRY, type TemplateKey } from "../notifications/templates/registry";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { ERASURE_DUE_AFTER_MS } from "./account.mapper";

/** The customers one `customers.erase` job erases at most (OADR-0014 point 2); a full batch continues in the next. */
export const ERASURE_BATCH = 100;

/** The `customers.status` account.delete leaves: the only one the erasure takes. */
export const DELETED_CUSTOMER_STATUS = "deleted";

/** How often `customers.erase` runs (jobs/schedulers.ts: minute 50 of every hour). */
export const ERASURE_RUN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The time the cut-off keeps in hand beyond one run interval (five minutes): the run that first finds a customer due
 * starts more than this long before its `erasureDueBy`, so one that starts late (a busy `ota-maintenance` queue, a
 * worker restart) or works through a full batch and its continuations slowly still erases before the promised date
 * (lead decision (7b) of 2026-11-05, second set).
 */
export const ERASURE_MARGIN_MS = 5 * 60 * 1000;

/**
 * How long after its deletion a customer is due: 30 days (`erasureDueBy`) less one run interval and ERASURE_MARGIN_MS
 * (30 days less one hour and five minutes), so the hourly run that first finds it due starts more than five minutes
 * before the promised date (lead decisions (5f) and (7b) of 2026-11-05).
 */
export const ERASURE_CUTOFF_AFTER_MS = ERASURE_DUE_AFTER_MS - ERASURE_RUN_INTERVAL_MS - ERASURE_MARGIN_MS;

/**
 * The latest deletion instant (`customers.deleted_at`) whose erasure is due at `now`: ERASURE_CUTOFF_AFTER_MS (30 days
 * less one hour and five minutes) earlier.
 */
export function erasureCutoff(now: Date): Date {
  const ms = now.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError("erasureCutoff: not a valid instant");
  }
  return new Date(ms - ERASURE_CUTOFF_AFTER_MS);
}

/**
 * The templates of the customer's account e-mails (every key of the `customer` audience: `auth.verify_email`,
 * `auth.password_reset`, `account.email_changed`, `account.deleted`): their `notifications` rows lose the address and
 * the variables at the erasure. Booking e-mails (`traveller`) stay with their bookings.
 */
export const ACCOUNT_EMAIL_TEMPLATE_KEYS: readonly TemplateKey[] = Object.freeze(
  TEMPLATE_KEYS.filter((key) => TEMPLATE_REGISTRY[key].audience === "customer"),
);

/**
 * The `notifications.recipient` an erased customer's account e-mail keeps: a neutral placeholder of the reserved
 * `.invalid` domain (RFC 2606) for the NOT NULL column, the same for every customer, so it says nothing of anyone.
 */
export const ERASED_RECIPIENT = "erased@erased.invalid";

/** The timeline line of the `customer.erased` booking event (staff only: `visible_to_customer` false). */
export const CUSTOMER_ERASED_SUMMARY =
  "The customer's account was erased; the booking is kept without an account and is never attached to one again.";

/** What one erasure detached, deleted and cleared, per table: counts only, never a value. */
export interface ErasedCustomer {
  /** Checkouts whose `customer_id` was set to NULL. */
  readonly checkoutsDetached: number;
  /** `checkout_travelers` of the customer's checkouts that never became bookings, deleted. */
  readonly checkoutTravelers: number;
  /** `checkout_contacts` of those checkouts, deleted. */
  readonly checkoutContacts: number;
  /** `checkout_remarks` (special requests) of those checkouts, deleted. */
  readonly checkoutRemarks: number;
  /** Those checkouts whose `ip_address` or `metadata` held a value: cleared (NULL and `{}`). */
  readonly checkoutsCleared: number;
  /** Bookings whose `customer_id` was set to NULL, each with a `customer.erased` event. */
  readonly bookingsDetached: number;
  /** Payments whose `customer_id` was set to NULL. */
  readonly paymentsDetached: number;
  /** `notifications` of the customer's account e-mails whose address, variables and subject were cleared. */
  readonly accountEmails: number;
  readonly savedTravelerDocuments: number;
  readonly savedTravelers: number;
  readonly preferences: number;
  readonly dataExports: number;
  readonly sessions: number;
  readonly passwordResets: number;
  readonly consents: number;
  readonly identities: number;
}

/** The fields of an erasure's counts, in the order its statements run. */
export const ERASED_FIELDS: readonly (keyof ErasedCustomer)[] = Object.freeze([
  "checkoutsDetached",
  "checkoutTravelers",
  "checkoutContacts",
  "checkoutRemarks",
  "checkoutsCleared",
  "bookingsDetached",
  "paymentsDetached",
  "accountEmails",
  "savedTravelerDocuments",
  "savedTravelers",
  "preferences",
  "dataExports",
  "sessions",
  "passwordResets",
  "consents",
  "identities",
]);

/** What one job did: the customers erased and failed, and the sums of their counts. */
export type ErasureCounts = Readonly<
  { customers: number; failed: number } & Record<keyof ErasedCustomer, number>
>;

/** A job's erasures and whether its batch was full (more customers may be due). */
export interface ErasureRun {
  readonly counts: ErasureCounts;
  readonly more: boolean;
}

/** Some customers of a job could not be erased; the others were (see the file header). */
export class ErasureIncompleteError extends Error {
  override readonly name = "ErasureIncompleteError";

  constructor(
    readonly failed: number,
    readonly attempted: number,
  ) {
    super(`${failed} of ${attempted} due customers could not be erased; the job is tried again`);
  }
}

const rows = (result: { readonly numUpdatedRows?: bigint; readonly numDeletedRows?: bigint }): number =>
  Number(result.numUpdatedRows ?? result.numDeletedRows ?? 0n);

/** The statements of the erasure (see the file header), on the caller's tenant transaction. */
@Injectable()
export class CustomerErasureRepository {
  /** Up to `limit` customers deleted at or before `cutoff`, oldest deletion first (read without a lock). */
  async dueCustomers(trx: TenantTransaction, cutoff: Date, limit: number): Promise<string[]> {
    const due = await trx
      .selectFrom("customers")
      .select("id")
      .where("status", "=", DELETED_CUSTOMER_STATUS)
      .where("deleted_at", "<=", cutoff)
      .orderBy("deleted_at")
      .orderBy("id")
      .limit(limit)
      .execute();
    return due.map((row) => row.id);
  }

  /**
   * Erases customer `customerId` if it was deleted at or before `cutoff`: detaches its checkouts (deleting the
   * travellers, contacts and special requests of those that never became bookings and clearing their IP address and
   * metadata), its bookings (each with a `customer.erased` event at `now`) and its payments, clears its account
   * e-mails, deletes its own rows and then the customer (see the file header). Answers the counts, or `undefined` when
   * the customer is not due or no longer exists (another job erased it).
   */
  async erase(
    trx: TenantTransaction,
    customerId: string,
    cutoff: Date,
    now: Date,
  ): Promise<ErasedCustomer | undefined> {
    const due = await trx
      .selectFrom("customers")
      .select("id")
      .where("id", "=", customerId)
      .where("status", "=", DELETED_CUSTOMER_STATUS)
      .where("deleted_at", "<=", cutoff)
      .executeTakeFirst();
    if (due === undefined) {
      return undefined;
    }
    // Detached in the lock order of checkout, booking, payment (the order every writer of them takes).
    const checkoutIds = (
      await trx
        .updateTable("checkouts")
        .set({ customer_id: null })
        .where("customer_id", "=", customerId)
        .returning("id")
        .execute()
    ).map((checkout) => checkout.id);
    let checkoutTravelers = 0;
    let checkoutContacts = 0;
    let checkoutRemarks = 0;
    let checkoutsCleared = 0;
    if (checkoutIds.length > 0) {
      // The checkouts just detached (and locked) that no booking names: they never became bookings.
      const neverBooked = (
        await trx
          .selectFrom("checkouts")
          .select("checkouts.id")
          .where("checkouts.id", "in", checkoutIds)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("bookings")
                  .select("bookings.id")
                  .whereRef("bookings.checkout_id", "=", "checkouts.id"),
              ),
            ),
          )
          .execute()
      ).map((checkout) => checkout.id);
      if (neverBooked.length > 0) {
        checkoutTravelers = rows(
          await trx
            .deleteFrom("checkout_travelers")
            .where("checkout_id", "in", neverBooked)
            .executeTakeFirst(),
        );
        checkoutContacts = rows(
          await trx
            .deleteFrom("checkout_contacts")
            .where("checkout_id", "in", neverBooked)
            .executeTakeFirst(),
        );
        checkoutRemarks = rows(
          await trx.deleteFrom("checkout_remarks").where("checkout_id", "in", neverBooked).executeTakeFirst(),
        );
        // The checkout's own request data (lead decision (7a) of 2026-11-05, second set): the client IP (nullable)
        // becomes NULL and the OTA-defined key/values (NOT NULL, default `{}`) become `{}`; only the rows that hold
        // either are written, and nothing else of them changes (status, amounts, version and times stay).
        checkoutsCleared = rows(
          await trx
            .updateTable("checkouts")
            .set({ ip_address: null, metadata: JSON.stringify({}) })
            .where("id", "in", neverBooked)
            .where((eb) =>
              eb.or([eb("ip_address", "is not", null), eb("metadata", "<>", JSON.stringify({}))]),
            )
            .executeTakeFirst(),
        );
      }
    }
    const bookingIds = (
      await trx
        .updateTable("bookings")
        .set({ customer_id: null })
        .where("customer_id", "=", customerId)
        .returning("id")
        .execute()
    ).map((booking) => booking.id);
    if (bookingIds.length > 0) {
      // The marker that keeps claimGuestBookings away from the booking: no actor, no data, staff only.
      await trx
        .insertInto("booking_events")
        .values(
          bookingIds.map((bookingId) => ({
            id: newId("evt", now),
            booking_id: bookingId,
            type: CUSTOMER_ERASED_EVENT,
            actor_type: "system",
            actor_id: null,
            summary: CUSTOMER_ERASED_SUMMARY,
            data: JSON.stringify({}),
            visible_to_customer: false,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
    }
    const paymentsDetached = rows(
      await trx
        .updateTable("payments")
        .set({ customer_id: null })
        .where("customer_id", "=", customerId)
        .executeTakeFirst(),
    );
    // Before the customer row, whose foreign key would detach them (ON DELETE SET NULL) and hide whose they were.
    const accountEmails = rows(
      await trx
        .updateTable("notifications")
        .set((eb) => ({
          recipient: ERASED_RECIPIENT,
          payload: JSON.stringify({}),
          subject: null,
          status: eb
            .case()
            .when("status", "in", ["pending", "sending"])
            .then("cancelled")
            .else(eb.ref("status"))
            .end(),
          // `notifications_secret_purge_ck`: a secret only while pending or sending, which no row stays.
          secret_payload_ciphertext: null,
          secrets_purged_at: eb
            .case()
            .when("secret_payload_ciphertext", "is not", null)
            .then(now)
            .else(eb.ref("secrets_purged_at"))
            .end(),
          updated_at: now,
        }))
        .where("customer_id", "=", customerId)
        .where("template_key", "in", [...ACCOUNT_EMAIL_TEMPLATE_KEYS])
        .executeTakeFirst(),
    );
    const savedTravelerDocuments = rows(
      await trx
        .deleteFrom("saved_traveler_documents")
        .where("saved_traveler_id", "in", (eb) =>
          eb.selectFrom("saved_travelers").select("id").where("customer_id", "=", customerId),
        )
        .executeTakeFirst(),
    );
    const savedTravelers = rows(
      await trx.deleteFrom("saved_travelers").where("customer_id", "=", customerId).executeTakeFirst(),
    );
    const preferences = rows(
      await trx.deleteFrom("customer_preferences").where("customer_id", "=", customerId).executeTakeFirst(),
    );
    const dataExports = rows(
      await trx.deleteFrom("customer_data_exports").where("customer_id", "=", customerId).executeTakeFirst(),
    );
    // Before the identities: a session names the identity it signed in with.
    const sessions = rows(
      await trx.deleteFrom("customer_sessions").where("customer_id", "=", customerId).executeTakeFirst(),
    );
    const passwordResets = rows(
      await trx
        .deleteFrom("customer_password_resets")
        .where("customer_id", "=", customerId)
        .executeTakeFirst(),
    );
    const consents = rows(
      await trx.deleteFrom("customer_consents").where("customer_id", "=", customerId).executeTakeFirst(),
    );
    const identities = rows(
      await trx.deleteFrom("customer_identities").where("customer_id", "=", customerId).executeTakeFirst(),
    );
    const customer = rows(
      await trx
        .deleteFrom("customers")
        .where("id", "=", customerId)
        .where("status", "=", DELETED_CUSTOMER_STATUS)
        .where("deleted_at", "<=", cutoff)
        .executeTakeFirst(),
    );
    if (customer === 0) {
      // Erased by another job between the check and here: its commit left nothing for the statements above to find.
      return undefined;
    }
    return {
      checkoutsDetached: checkoutIds.length,
      checkoutTravelers,
      checkoutContacts,
      checkoutRemarks,
      checkoutsCleared,
      bookingsDetached: bookingIds.length,
      paymentsDetached,
      accountEmails,
      savedTravelerDocuments,
      savedTravelers,
      preferences,
      dataExports,
      sessions,
      passwordResets,
      consents,
      identities,
    };
  }
}

/** Counts of nothing: the start of a job's sums. */
function noCounts(): Record<keyof ErasureCounts, number> {
  const counts: Record<string, number> = { customers: 0, failed: 0 };
  for (const field of ERASED_FIELDS) {
    counts[field] = 0;
  }
  return counts as Record<keyof ErasureCounts, number>;
}

/** The error code of a failed erasure for its log line: a PostgreSQL error's SQLSTATE, else the error's name. */
function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length <= 64) {
      return code;
    }
    const name: unknown = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length <= 64) {
      return name;
    }
  }
  return "unknown";
}

/** The erasure of one tenant's due customers (see the file header); runs in the job's tenant context. */
@Injectable()
export class CustomerErasureService {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: CustomerErasureRepository,
    private readonly clock: Clock,
    @InjectPinoLogger(CustomerErasureService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Erases up to ERASURE_BATCH due customers of tenant `tenantId` (the context's), each in its own transaction, and
   * answers the counts; `more` when the batch was full. Throws ErasureIncompleteError after the batch when an erasure
   * failed (see the file header).
   */
  async eraseDue(tenantId: string): Promise<ErasureRun> {
    // One instant for the whole job (its cut-off and its booking events): its continuations take their own.
    const now = this.clock.now();
    const cutoff = erasureCutoff(now);
    const due = await this.tx.run((trx) => this.repository.dueCustomers(trx, cutoff, ERASURE_BATCH));
    const counts = noCounts();
    for (const customerId of due) {
      let erased: ErasedCustomer | undefined;
      try {
        erased = await this.tx.run((trx) => this.repository.erase(trx, customerId, cutoff, now));
      } catch (error) {
        counts.failed += 1;
        // The code only: a PostgreSQL error's message may quote a value of the row.
        this.logger.error({ tenantId, customerId, code: errorCodeOf(error) }, "customer.erasure_failed");
        continue;
      }
      if (erased === undefined) {
        continue;
      }
      counts.customers += 1;
      for (const field of ERASED_FIELDS) {
        counts[field] += erased[field];
      }
      this.logger.info({ tenantId, customerId, ...erased }, "customer.erased");
    }
    const more = due.length >= ERASURE_BATCH;
    this.logger.info({ tenantId, ...counts, more }, "customers.erasure_done");
    if (counts.failed > 0) {
      throw new ErasureIncompleteError(counts.failed, due.length);
    }
    return { counts, more };
  }
}
