// The erasure of deleted customers (OBE-087; db README §7 "End-customer erasure inside a tenant",
// ota/docs/data-model.md §6, ota/docs/scope.md §3.1 `account.delete`, OADR-0014 points 2, 4 and 5). account.delete deletes an account at once
// (account.service.ts: sessions revoked, identities disabled, the address replaced by the `…@deleted.invalid`
// placeholder, a marketing withdrawal in the consent log, `customers.status = 'deleted'` and `deleted_at`); its answer
// promises the erasure of the rest of the customer's personal data 30 days later (`erasureDueBy`,
// account.mapper.ts `ERASURE_DUE_AFTER_MS`). The daily `customers.erase` job (erasure.processor.ts, fanned out per
// tenant by jobs/schedulers.ts, `active` and `suspended` tenants) erases them:
//
// - Due: `status = 'deleted'` and `deleted_at` at least ERASURE_DUE_AFTER_MS before the job's instant (`Clock`, one
//   instant per job), so a customer deleted 31 days ago is erased and one deleted 29 days ago is left as it is. The
//   status is final (no writer ever turns a deleted customer back), so a customer due once stays due.
// - Batches: at most ERASURE_BATCH (100) customers per job, oldest deletion first; a full batch asks for more and the
//   runner queues the job again (jobs/fan-out.ts, at most MAX_CONTINUATIONS times per run). Each customer is erased in
//   a short transaction of its own (`tenantTx`), so one customer's erasure never waits for another's, and what was
//   erased stays erased if a later one fails.
// - One erasure (`CustomerErasureRepository.erase`), in this order: the customer is checked to be due (without a
//   lock); its checkouts, bookings and payments are detached (`customer_id` set to NULL, in the lock order of
//   checkout, booking, payment: nothing else of them changes, neither `version` nor an amount, a reference or a
//   status; a guest flag stays as it was); then its saved traveller documents and saved travellers, preferences, data
//   exports, sessions (refresh tokens with their IP addresses and user agents), password reset tokens, consent log
//   and identities are deleted; last the customer row itself (names, phone, date of birth, the placeholder address,
//   metadata), which locks it and whose foreign keys detach what remains (`notifications` and `flight_searches`
//   rows: ON DELETE SET NULL) or would delete what a statement above missed (ON DELETE CASCADE). Bookings, payments
//   and refunds keep their amounts, references, travellers and contacts: they are the financial record the deletion
//   kept (account.mapper.ts `RETAINED_BOOKING_RECORDS`), and their traveller data stays for the legal retention
//   period (db README §7; data-model §6: kept until the tenant is deleted). Booking events and refunds keep the
//   `cus_…` id by value of the customer who caused them; it names no row any more. A detached booking is a guest
//   booking from then on: a later auth.verifyEmail of its contact address claims it, as it does any guest booking
//   (identity/customers.repository.ts `claimGuestBookings`). Data exports are deferred in the
//   MVP (scope §3.1: account.dataExports.* answer 501, `exportData` is refused), so `customer_data_exports` holds no
//   row and no file; the task that brings them deletes an export's file with its row. The bookings' customer indexes
//   are partial (by status), so their detachment reads the table, as the foreign key's own SET NULL would: a daily job
//   of at most 100 customers.
// - When: the job runs once a day, so a customer is erased by the first run at or after `deleted_at` + 30 days,
//   between 30 days and 30 days and one run after the deletion.
// - Idempotent: an erased customer has no row, so a second run (a job run again after a failure, a duplicate, the
//   next day's) finds nothing to do; a customer another job erased meanwhile is not counted.
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
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { ERASURE_DUE_AFTER_MS } from "./account.mapper";

/** The customers one `customers.erase` job erases at most (OADR-0014 point 2); a full batch continues in the next. */
export const ERASURE_BATCH = 100;

/** The `customers.status` account.delete leaves: the only one the erasure takes. */
export const DELETED_CUSTOMER_STATUS = "deleted";

/** The latest deletion instant (`customers.deleted_at`) whose erasure is due at `now`: ERASURE_DUE_AFTER_MS before. */
export function erasureCutoff(now: Date): Date {
  const ms = now.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError("erasureCutoff: not a valid instant");
  }
  return new Date(ms - ERASURE_DUE_AFTER_MS);
}

/** What one erasure detached and deleted, per table: counts only, never a value. */
export interface ErasedCustomer {
  /** Checkouts whose `customer_id` was set to NULL. */
  readonly checkoutsDetached: number;
  /** Bookings whose `customer_id` was set to NULL. */
  readonly bookingsDetached: number;
  /** Payments whose `customer_id` was set to NULL. */
  readonly paymentsDetached: number;
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
  "bookingsDetached",
  "paymentsDetached",
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
   * Erases customer `customerId` if it was deleted at or before `cutoff`: detaches its checkouts, bookings and
   * payments, deletes its own rows and then the customer (see the file header). Answers the counts, or `undefined`
   * when the customer is not due or no longer exists (another job erased it).
   */
  async erase(trx: TenantTransaction, customerId: string, cutoff: Date): Promise<ErasedCustomer | undefined> {
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
    const checkoutsDetached = rows(
      await trx
        .updateTable("checkouts")
        .set({ customer_id: null })
        .where("customer_id", "=", customerId)
        .executeTakeFirst(),
    );
    const bookingsDetached = rows(
      await trx
        .updateTable("bookings")
        .set({ customer_id: null })
        .where("customer_id", "=", customerId)
        .executeTakeFirst(),
    );
    const paymentsDetached = rows(
      await trx
        .updateTable("payments")
        .set({ customer_id: null })
        .where("customer_id", "=", customerId)
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
      // Erased by another job between the check and here: its statements found what this one would have.
      return undefined;
    }
    return {
      checkoutsDetached,
      bookingsDetached,
      paymentsDetached,
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
    // One instant for the whole job: its continuations take their own.
    const cutoff = erasureCutoff(this.clock.now());
    const due = await this.tx.run((trx) => this.repository.dueCustomers(trx, cutoff, ERASURE_BATCH));
    const counts = noCounts();
    for (const customerId of due) {
      let erased: ErasedCustomer | undefined;
      try {
        erased = await this.tx.run((trx) => this.repository.erase(trx, customerId, cutoff));
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
