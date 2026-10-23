// The booking sync (OBE-045; ota/docs/flows/ticketing-and-documents.md §3 step 5 and §4, OADR-0014 points 2, 4 and 6,
// db README §6 "Booking sync", the document's consoleResyncBooking and listBookings "Freshness"): one Flight Order
// Management GET of an active booking's order, and what it says changed written onto the booking. No database
// transaction is open while Amadeus is called (architecture §4).
//
// Two ways in, one record step (lead decision (3) of 2026-10-23, FIX-W27-SYNC):
//   - `attempt`: the background sync, in the worker, for one booking of the tenant of the current job context
//     (booking-sync.processor.ts opens it), when the booking is due (sync-schedule.ts);
//   - `refresh`: the refreshes, in the API (bookings.get, getTicketingStatus and getFareRules with a refresh through
//     CustomerBookingsService, console.bookings.get with `refresh=true`, console.bookings.resync and the resync after a
//     timed-out patch), throttled instead of scheduled.
// Both claim the booking in a column (`bookings.sync_claimed_at`; until FIX-W27-SYNC a staff-only
// `booking.sync_requested` event, about four a day per upcoming booking, which filled the console's timeline), read the
// order without a transaction, and record it through the same diff (order-diff.ts) and the same events, so a schedule
// change, a cancellation by the airline or a new ticket is reported whichever path reads it first.
//
// **Due** (BookingSyncRepository.dueBookingIds, the scan's query, and the claim's check; sync-schedule.ts): a
// `confirmed`, `ticketed` or `partially_ticketed` booking with an Amadeus order whose trip is not over, last
// synchronised 6 hours ago or more (or never), or 1 hour ago or more when it still waits for tickets in the 24 hours
// before its ticketing deadline, and not claimed (by the sync or a refresh: `sync_claimed_at`) in the last 30 minutes,
// so an attempt in progress is never doubled and one whose read failed (a rate limit, a timeout, an order not found) is
// tried again half an hour later instead of at every scan; for a suspended tenant only paid ones (`amount_paid > 0`,
// OADR-0008 point 8). The scan takes the oldest synced first (`bookings_sync_idx`).
//
//   1. Claim (T1). The sync locks the booking with `FOR NO KEY UPDATE SKIP LOCKED` (lead decision (1) of 2026-10-22,
//      OADR-0014 point 6: a booking another claim, worker or request holds is skipped, a transaction that only holds
//      its `FOR KEY SHARE`, the foreign-key lock of an event, outbox or document insert, never makes the claim skip),
//      reads it in a statement after the lock and checks it again, whatever the job said (due, above). A refresh locks
//      it `FOR UPDATE` and waits (BookingsRepository.lockForRefresh), skips a booking without an order, pending, failed
//      or cancelled (and, when asked, one whose ticketing is final), and is throttled within its `throttleMs` (60 s for
//      the customer's, 10 s for the console's, none after a timed-out patch) of the last claim or synchronisation. The
//      claim writes `sync_claimed_at` (BookingsRepository.markSyncClaimed; never `version`, `updated_at` or a key
//      column, and no event), and commits before Amadeus is called: a second claim (another job, a refresh) sees it and
//      stands back (a refresh within its throttle, the sync for 30 minutes).
//   2. Read. Flight Order Management GET (the sync with `include=bags`, a refresh with the `include` and `fareRules` it
//      was asked for). A failure is recorded in `sync_error` (Booking.syncStatus `failed`; `version` unchanged): Amadeus
//      404 as `ORDER_NOT_FOUND` (an order purged, or cancelled outside Velexis: staff check it; never a cancellation,
//      see order-diff.ts), an answer that cannot be read as `SUPPLIER_ERROR`, any other as its error code. The sync
//      answers `failed` and tries again when due; a refresh answers `not_found` for a 404 and throws the error for the
//      others (a code the booking reads do not document becomes `502 SUPPLIER_ERROR`).
//   3. Record (T2), with the booking `version` of the claim: the booking is locked again (`FOR NO KEY UPDATE`, which
//      waits) and must still be active with the same order; a booking whose `version` moved since the claim (another
//      writer recorded something while the order was read: a ticketing job, a console patch or resync, another
//      refresh) is not overwritten: the sync reads the order again and records it against the new version, at most
//      BOOKING_SYNC_ROUNDS reads in all (`superseded` after that, nothing written; the next due scan tries again); a
//      refresh answers `superseded` (the stored booking is answered). Otherwise it applies the diff of order-diff.ts:
//        - tickets: new ones inserted, changed statuses recorded; a booking now fully or partly ticketed becomes
//          `ticketed`/`partially_ticketed` (`issued`/`partially_issued`, `issued_at`), event `booking.ticketed`, which
//          asks for the e-ticket receipts and a new itinerary (documents.processor.ts);
//        - segments: changed ones rewritten (times and their instants through the airports' time zones, airports,
//          terminals, flight, status, duration), added ones inserted, removed ones `CANCELLED`, `isFlown` recorded; the
//          booking's `first_departure_at`/`last_arrival_at` follow the segments that are not cancelled; event
//          `booking.schedule_changed` (flagged in the console as `hasScheduleChange`; visible to the customer when
//          times changed), which asks for a new itinerary (lead decision (3) of 2026-10-23). No customer e-mail for a
//          schedule change in the MVP (plan step 3);
//        - cancellation by the airline (every segment of the order `CANCELLED`): the booking becomes `cancelled` with
//          `cancelled_at`, `cancelled_by = airline`, no further ticketing attempt, event `booking.cancelled` through
//          OrderRecorder.event (the cancelled itinerary follows it), the traveller's `booking.cancelled` e-mail (once
//          per booking, dedupe key) and, when the booking has an authorised or captured payment, a staff alert
//          (StaffAlerts, `staff.manual_review:<bkg_…>:airline_cancelled`, once per booking; lead decision (3) of
//          2026-10-23). The money is staff's (flow §3 step 4: the authorisation is voided or the capture refunded from
//          the console). A schedule change of the same read is part of the cancellation, not an event of its own;
//        - always: the redacted `order_snapshot`, `order_dictionaries`, `order_included` (the bag options read with
//          `include=bags`, the fare rules read with `fareRules`), the order's forms of identification cut to their
//          last 4 characters (`form_of_identifications`, OBE-062's maskedIdentifications), the order's associated
//          records the booking does not have yet, what the diff changed (`sync_changes`, the console's
//          ConsoleSupplierSync.differences: `[]` when nothing changed), `last_synced_at`, `sync_error = null`.
//      `version` moves (and with it the ETag) when tickets, a status or the segments changed, the changes documents and
//      answers follow (lead decision (6a) of 2026-10-22); an `isFlown`, a record or the snapshot alone keep it.
//
// The sync does not clean the booking queue (lead decision (5) of 2026-10-22: Queue List has no removal among the 12
// operations; since lead decision (5) of 2026-10-23 the reconciler alerts staff when it nears the 500 one Queue List
// answer carries, reconcile.service.ts). Log lines carry ids, codes and counts, never an Amadeus body, a ticket number or
// a person's data.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError, isAppError, type OtaErrorCode } from "@velexis/errors";
import { sql, type Insertable, type TenantDatabase, type Updateable } from "@velexis/db";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { SharedConfig } from "../config";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import { Money } from "../pricing/pricing.types";
import { warningsOf } from "../shopping/priced-offers.mapper";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  offerFareRulesOf,
  orderRecordsOf,
  ticketingFinal,
  type FareRuleType,
  type StoredFareRules,
} from "./bookings.mapper";
import {
  BookingsRepository,
  type BookingChildren,
  type BookingRow,
  type BookingSegmentRow,
  type BookingSettingsRow,
} from "./bookings.repository";
import { maskedIdentifications } from "./identifications";
import {
  cancelledByAirline,
  diffSegments,
  diffTickets,
  orderSegmentsOf,
  scheduleChangeOf,
  syncChangesOf,
  ticketUpgradeOf,
  type OrderSegment,
  type SegmentDiff,
} from "./order-diff";
import { OrderRecorder, readCreatedOrder, type CreatedOrder, type Warning } from "./order-recorder";
import { StaffAlerts } from "./staff-alerts";
import {
  AWAITING_TICKETS_STATUSES,
  BOOKING_SYNC_DEADLINE_INTERVAL_MS,
  BOOKING_SYNC_DEADLINE_WINDOW_MS,
  BOOKING_SYNC_INTERVAL_MS,
  BOOKING_SYNC_RETRY_MS,
  BOOKING_SYNC_STATUSES,
  isSyncStatus,
  syncIntervalOf,
} from "./sync-schedule";

export {
  BOOKING_SYNC_DEADLINE_INTERVAL_MS,
  BOOKING_SYNC_DEADLINE_WINDOW_MS,
  BOOKING_SYNC_INTERVAL_MS,
  BOOKING_SYNC_RETRY_MS,
  BOOKING_SYNC_STATUSES,
  syncIntervalOf,
} from "./sync-schedule";

type Db = TenantDatabase;

/** The Velexis operation of the sync's Amadeus calls (`supplier_requests.operation`) and its events (`data.via`). */
export const BOOKING_SYNC_OPERATION = "booking.sync";

/** The reads of the order one sync makes at most when other writers keep moving the booking's version. */
export const BOOKING_SYNC_ROUNDS = 3;

/** The event of a schedule change (the console's `hasScheduleChange`, console-bookings.repository.ts). */
export const SCHEDULE_CHANGED_EVENT = "booking.schedule_changed";

/** The event of a cancellation (OrderRecorder.event asks for the cancelled itinerary). */
export const BOOKING_CANCELLED_EVENT = "booking.cancelled";

/** `bookings.cancel_reason` of a cancellation the sync found. */
export const AIRLINE_CANCEL_REASON = "Every segment of the order was cancelled by the airline.";

/** The kind of the staff alert of an airline cancellation of a paid booking (its dedupe key's last part). */
export const AIRLINE_CANCELLED_ALERT = "airline_cancelled";

/** `sync_error` of a read whose order Amadeus no longer has (also the console's `order_not_found`). */
export const ORDER_NOT_FOUND = "ORDER_NOT_FOUND";

/** The warning of a refresh that found no order at Amadeus (purged after travel): the stored data is shown. */
export const ORDER_NOT_FOUND_WARNING: Warning = Object.freeze({
  title: "ORDER NOT FOUND AT THE AIRLINE",
  detail: "The airline no longer returns this order; the booking as last synchronised is shown.",
});

/** The Amadeus error codes the booking reads document; a refresh answers any other as `502 SUPPLIER_ERROR`. */
const DOCUMENTED_SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  "SUPPLIER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "SUPPLIER_ERROR",
  "SERVICE_UNAVAILABLE",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
]);

/** The payment states that hold the traveller's money: an authorisation or a capture (the staff alert's test). */
const HELD_PAYMENT_STATUSES = ["authorized", "captured", "partially_refunded"] as const;

/** Who the sync's booking events name: Amadeus, which reported the change. */
const SUPPLIER_ACTOR = Object.freeze({ type: "supplier", id: null });

/** A BCP 47 locale as the outbox accepts it. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the claim reads of a booking. */
export interface SyncClaimRow {
  readonly id: string;
  readonly environment: string;
  readonly status: string;
  readonly amadeusOrderId: string | null;
  readonly ownerOfficeId: string | null;
  readonly lastArrivalAt: Date;
  readonly ticketingDeadlineAt: Date | null;
  readonly amountPaid: string;
  readonly version: number;
  readonly lastSyncedAt: Date | null;
  /** `sync_claimed_at`: the newest claim of a synchronisation (the sync's and the refreshes'). */
  readonly syncClaimedAt: Date | null;
}

/** The query options of the scan. */
export interface DueSyncQuery {
  readonly now: Date;
  /** Only bookings with a captured amount (a suspended tenant's, OADR-0008 point 8). */
  readonly paidOnly: boolean;
  readonly limit: number;
}

/** A payment of a booking that holds the traveller's money (HELD_PAYMENT_STATUSES). */
export interface HeldPaymentRow {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly amountAuthorized: string;
  readonly amountCaptured: string;
  readonly amountRefunded: string;
}

/** The sync's queries on `bookings`, `booking_segments` and `payments` (tenant repository: `tenantTx` first). */
@Injectable()
export class BookingSyncRepository {
  /**
   * The ids of the bookings due at `now` (see the file header), the oldest synced first (never synced first), at most
   * `limit`. The partial index `bookings_sync_idx` serves the order.
   */
  async dueBookingIds(trx: TenantTransaction, query: DueSyncQuery): Promise<string[]> {
    const at = query.now.getTime();
    const before = new Date(at - BOOKING_SYNC_INTERVAL_MS);
    const hourBefore = new Date(at - BOOKING_SYNC_DEADLINE_INTERVAL_MS);
    const windowEnd = new Date(at + BOOKING_SYNC_DEADLINE_WINDOW_MS);
    const claimedBefore = new Date(at - BOOKING_SYNC_RETRY_MS);
    let select = trx
      .selectFrom("bookings as b")
      .select("b.id")
      .where("b.status", "in", [...BOOKING_SYNC_STATUSES])
      .where("b.amadeus_order_id", "is not", null)
      .where("b.last_arrival_at", ">", query.now)
      // syncIntervalOf, in SQL.
      .where((eb) =>
        eb.or([
          eb("b.last_synced_at", "is", null),
          eb("b.last_synced_at", "<=", before),
          eb.and([
            eb("b.status", "in", [...AWAITING_TICKETS_STATUSES]),
            eb("b.ticketing_deadline_at", ">", query.now),
            eb("b.ticketing_deadline_at", "<=", windowEnd),
            eb("b.last_synced_at", "<=", hourBefore),
          ]),
        ]),
      )
      // Not claimed in the last 30 minutes (BOOKING_SYNC_RETRY_MS).
      .where((eb) =>
        eb.or([eb("b.sync_claimed_at", "is", null), eb("b.sync_claimed_at", "<=", claimedBefore)]),
      );
    if (query.paidOnly) {
      select = select.where("b.amount_paid", ">", "0");
    }
    const rows = await select
      .orderBy(sql`b.last_synced_at NULLS FIRST`)
      .orderBy("b.id")
      .limit(query.limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * The booking `id` for a claim: locked `FOR NO KEY UPDATE SKIP LOCKED`, then read in a statement of its own (under
   * READ COMMITTED it sees what was committed by then); `undefined` when it does not exist or another claim, worker or
   * request holds it.
   */
  async claim(trx: TenantTransaction, id: string): Promise<SyncClaimRow | undefined> {
    const locked = await trx
      .selectFrom("bookings")
      .select("id")
      .where("id", "=", id)
      .forNoKeyUpdate()
      .skipLocked()
      .executeTakeFirst();
    return locked === undefined ? undefined : await this.read(trx, id);
  }

  /**
   * The booking `id` for the record step: locked `FOR NO KEY UPDATE` (it waits for a writer of the booking, never for
   * a key-share holder), then read; `undefined` when it does not exist.
   */
  async lock(trx: TenantTransaction, id: string): Promise<SyncClaimRow | undefined> {
    const locked = await trx
      .selectFrom("bookings")
      .select("id")
      .where("id", "=", id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return locked === undefined ? undefined : await this.read(trx, id);
  }

  /** Rewrites a segment the order changed (or removed: its status only). */
  async updateSegment(
    trx: TenantTransaction,
    segmentRowId: string,
    values: Omit<Updateable<Db["booking_segments"]>, "id" | "booking_id">,
  ): Promise<void> {
    await trx.updateTable("booking_segments").set(values).where("id", "=", segmentRowId).execute();
  }

  /** Inserts the segments the airline added. */
  async insertSegments(
    trx: TenantTransaction,
    rows: readonly Insertable<Db["booking_segments"]>[],
  ): Promise<void> {
    if (rows.length > 0) {
      await trx
        .insertInto("booking_segments")
        .values([...rows])
        .execute();
    }
  }

  /** The booking's payments that hold the traveller's money (an authorisation or a capture), oldest first; no lock. */
  async heldPayments(trx: TenantTransaction, bookingId: string): Promise<HeldPaymentRow[]> {
    return await trx
      .selectFrom("payments")
      .select([
        "id",
        "status",
        sql<string>`currency::text`.as("currency"),
        sql<string>`amount_authorized::text`.as("amountAuthorized"),
        sql<string>`amount_captured::text`.as("amountCaptured"),
        sql<string>`amount_refunded::text`.as("amountRefunded"),
      ])
      .where("booking_id", "=", bookingId)
      .where("status", "in", [...HELD_PAYMENT_STATUSES])
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  private async read(trx: TenantTransaction, id: string): Promise<SyncClaimRow | undefined> {
    return await trx
      .selectFrom("bookings as b")
      .select([
        "b.id as id",
        "b.environment as environment",
        "b.status as status",
        "b.amadeus_order_id as amadeusOrderId",
        "b.owner_office_id as ownerOfficeId",
        "b.last_arrival_at as lastArrivalAt",
        "b.ticketing_deadline_at as ticketingDeadlineAt",
        "b.version as version",
        "b.last_synced_at as lastSyncedAt",
        "b.sync_claimed_at as syncClaimedAt",
        sql<string>`b.amount_paid::text`.as("amountPaid"),
      ])
      .where("b.id", "=", id)
      .executeTakeFirst();
  }
}

/** Why a sync job did nothing. */
export type BookingSyncSkip =
  /** No such booking in the tenant, or another transaction holds it. */
  | "not_claimable"
  /** Not `confirmed`, `ticketed` or `partially_ticketed` (pending, failed, cancelled). */
  | "not_active"
  | "no_order"
  /** The trip is over. */
  | "trip_over"
  /** A suspended tenant's booking without a captured amount. */
  | "unpaid"
  /** Synchronised less than syncIntervalOf ago, or claimed less than BOOKING_SYNC_RETRY_MS ago. */
  | "not_due";

/** What a record step changed (counts and flags for the job's result and the log line). */
export interface BookingSyncChanges {
  readonly segmentsChanged: number;
  readonly segmentsAdded: number;
  readonly segmentsRemoved: number;
  readonly ticketsAdded: number;
  readonly ticketsChanged: number;
  readonly scheduleChanged: boolean;
  readonly ticketed: boolean;
  readonly cancelledByAirline: boolean;
  /** The booking's `version` moved. */
  readonly versionMoved: boolean;
}

/** What one sync job did (kept with the BullMQ job): ids, counts and codes, never more. */
export type BookingSyncOutcome =
  | { readonly outcome: "skipped"; readonly reason: BookingSyncSkip }
  | { readonly outcome: "synced"; readonly rounds: number; readonly changes: BookingSyncChanges }
  | { readonly outcome: "failed"; readonly rounds: number; readonly code: string }
  /** Other writers moved the booking's version during every read: nothing was written. */
  | { readonly outcome: "superseded"; readonly rounds: number };

/** The Amadeus query of a refresh (the sync's is `include=bags`). */
export interface RefreshQuery {
  readonly include?: "bags"[] | undefined;
  readonly fareRules?: FareRuleType[] | undefined;
}

/** What a refresh did. */
export type RefreshOutcome =
  | { readonly kind: "refreshed"; readonly warnings: readonly Warning[] }
  | { readonly kind: "throttled"; readonly retryAfterSeconds: number }
  | { readonly kind: "skipped" }
  | { readonly kind: "not_found" }
  /** Another writer changed the booking (`version`) while its order was read: nothing was written over it. */
  | { readonly kind: "superseded" };

/** The tenant a synchronisation writes for: its id, its key (the storefront's links) and its default locale. */
export interface SyncTenant {
  readonly id: string;
  readonly key: string;
  /** The e-mails' locale without a settings row; `en` when unknown (the API's tenant context has none). */
  readonly defaultLocale?: string | undefined;
}

/** One refresh (see the file header). */
export interface RefreshRequest {
  /** The Velexis operation (`supplier_requests.operation`, the events' `data.via`). */
  readonly operation: string;
  readonly requestId: string;
  /** The request's environment (the booking's: the callers checked it). */
  readonly environment: "test" | "live";
  readonly query: RefreshQuery;
  /** No refresh within this long of the last claim or synchronisation (`throttled`). */
  readonly throttleMs: number;
  /** Skip a booking whose ticketing is final (getTicketingStatus). */
  readonly unlessFinal?: boolean | undefined;
  /** The staff member a console call names in its `supplier_requests` row. */
  readonly staffId?: string | null | undefined;
}

/** A claimed booking. */
interface SyncClaim {
  readonly id: string;
  readonly environment: "test" | "live";
  readonly orderId: string;
  readonly office: string | null;
  /** The booking's `version` at the claim. */
  readonly version: number;
}

/** A read of the order. */
type OrderRead =
  | {
      readonly ok: true;
      readonly order: CreatedOrder;
      readonly body: Record<string, unknown>;
      readonly supplierRequestId: string | null;
    }
  | { readonly ok: false; readonly code: string; readonly error?: Error };

/** What the record step writes for (the path's operation, the job's or request's id, what was read). */
interface RecordRequest {
  readonly operation: string;
  readonly requestId: string;
  readonly query: RefreshQuery;
}

/** What the record step did. */
type RecordResult =
  | { readonly kind: "applied"; readonly changes: BookingSyncChanges }
  | { readonly kind: "superseded"; readonly version: number }
  | { readonly kind: "gone"; readonly reason: BookingSyncSkip };

/** Why a booking may not be claimed by the sync at `now`, or `undefined` when it may. */
export function syncClaimSkip(
  row: SyncClaimRow,
  now: Date,
  tenantStatus: PlatformTenant["status"],
): BookingSyncSkip | undefined {
  if (!isSyncStatus(row.status)) {
    return "not_active";
  }
  if (row.amadeusOrderId === null) {
    return "no_order";
  }
  if (row.lastArrivalAt.getTime() <= now.getTime()) {
    return "trip_over";
  }
  if (tenantStatus === "suspended" && !new Money(row.amountPaid).greaterThan(0)) {
    return "unpaid";
  }
  const since = (instant: Date | null): number =>
    instant === null ? Number.POSITIVE_INFINITY : now.getTime() - instant.getTime();
  if (
    since(row.lastSyncedAt) < syncIntervalOf(row, now) ||
    since(row.syncClaimedAt) < BOOKING_SYNC_RETRY_MS
  ) {
    return "not_due";
  }
  return undefined;
}

/** True for an Amadeus `404` (an order Amadeus no longer has). */
const isOrderNotFound = (error: unknown): boolean =>
  isAppError(error) && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404;

/** The API code of a failed read: an AppError's code (404 as ORDER_NOT_FOUND), `INTERNAL_ERROR` for anything else. */
function readFailureCode(error: unknown): string {
  if (isOrderNotFound(error)) {
    return ORDER_NOT_FOUND;
  }
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}

/** The Amadeus query of `query` (empty lists left out). */
function amadeusQueryOf(query: RefreshQuery): { include?: "bags"[]; fareRules?: FareRuleType[] } {
  return {
    ...(query.include !== undefined && query.include.length > 0 ? { include: [...query.include] } : {}),
    ...(query.fareRules !== undefined && query.fareRules.length > 0
      ? { fareRules: [...query.fareRules] }
      : {}),
  };
}

/** A segment row to write, with its instants. */
interface PlacedSegment {
  readonly order: OrderSegment;
  readonly departureAt: Date;
  readonly arrivalAt: Date;
}

/** Runs the synchronisations of a booking (see the file header). Both processes. */
@Injectable()
export class BookingSyncService {
  private readonly baseDomain: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly repository: BookingSyncRepository,
    private readonly bookings: BookingsRepository,
    private readonly recorder: OrderRecorder,
    private readonly amadeus: AmadeusClient,
    private readonly outbox: OutboxService,
    private readonly alerts: StaffAlerts,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    config: ConfigService<SharedConfig, true>,
    @InjectPinoLogger(BookingSyncService.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  // ---- The background sync -----------------------------------------------------------------------------------------

  /**
   * One synchronisation of the booking `bookingId` of `tenant`, in the tenant's job context; `requestId` names the job
   * in the Amadeus call and the events. Amadeus failures are recorded, never thrown; a database error is thrown (the
   * job fails and BullMQ retries it; its claim keeps the booking from being claimed again until it is due).
   */
  async attempt(tenant: PlatformTenant, bookingId: string, requestId: string): Promise<BookingSyncOutcome> {
    const claim = await this.claim(tenant, bookingId);
    if (typeof claim === "string") {
      this.logger.debug({ bookingId, reason: claim }, "bookings.sync_skipped");
      return { outcome: "skipped", reason: claim };
    }
    const context: AmadeusCallContext = {
      tenantId: tenant.id,
      environment: claim.environment,
      operation: BOOKING_SYNC_OPERATION,
      requestId,
      bookingId,
      ...(claim.office === null ? {} : { orderOffice: claim.office }),
    };
    const request: RecordRequest = {
      operation: BOOKING_SYNC_OPERATION,
      requestId,
      query: { include: ["bags"] },
    };
    let version = claim.version;
    for (let round = 1; round <= BOOKING_SYNC_ROUNDS; round += 1) {
      const read = await this.read(context, claim, request.query);
      if (!read.ok) {
        await this.recordFailure(bookingId, read.code);
        this.logger.warn({ tenantId: tenant.id, bookingId, code: read.code, round }, "bookings.sync_failed");
        return { outcome: "failed", rounds: round, code: read.code };
      }
      const result = await this.tx.run((trx) => this.record(trx, tenant, claim, version, read, request));
      if (result.kind === "applied") {
        this.logger.info({ tenantId: tenant.id, bookingId, round, ...result.changes }, "bookings.synced");
        return { outcome: "synced", rounds: round, changes: result.changes };
      }
      if (result.kind === "gone") {
        this.logger.info({ bookingId, reason: result.reason, round }, "bookings.sync_skipped");
        return { outcome: "skipped", reason: result.reason };
      }
      // Another writer recorded the booking while the order was read: read it again against the new version.
      this.logger.info(
        { bookingId, round, claimedVersion: version, version: result.version },
        "bookings.sync_superseded",
      );
      version = result.version;
    }
    return { outcome: "superseded", rounds: BOOKING_SYNC_ROUNDS };
  }

  /** Step 1 of the sync: the claim, `FOR NO KEY UPDATE SKIP LOCKED`, the due rule, `sync_claimed_at`. */
  private async claim(tenant: PlatformTenant, bookingId: string): Promise<SyncClaim | BookingSyncSkip> {
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const row = await this.repository.claim(trx, bookingId);
      if (row === undefined) {
        return "not_claimable";
      }
      const skip = syncClaimSkip(row, now, tenant.status);
      if (skip !== undefined) {
        return skip;
      }
      if ((row.environment !== "test" && row.environment !== "live") || row.amadeusOrderId === null) {
        return "not_claimable";
      }
      await this.bookings.markSyncClaimed(trx, row.id, now);
      return {
        id: row.id,
        environment: row.environment,
        orderId: row.amadeusOrderId,
        office: row.ownerOfficeId,
        version: row.version,
      };
    });
  }

  // ---- The refreshes -----------------------------------------------------------------------------------------------

  /**
   * One refresh of the booking `bookingId` (see the file header): claimed and throttled, one read, the record step.
   * Answers what it did; Amadeus errors other than a 404 are recorded in `sync_error` and thrown (`NOT_FOUND` for an
   * unknown booking).
   */
  async refresh(tenant: SyncTenant, bookingId: string, request: RefreshRequest): Promise<RefreshOutcome> {
    const claim = await this.tx.run(async (trx) => {
      const row = await this.bookings.lockForRefresh(trx, bookingId);
      if (row === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const now = this.clock.now();
      if (
        row.amadeusOrderId === null ||
        row.status === "pending" ||
        row.status === "failed" ||
        row.status === "cancelled"
      ) {
        return { kind: "skipped" } as const;
      }
      if (request.unlessFinal === true) {
        const booking = await this.bookings.booking(trx, bookingId);
        if (booking !== undefined && ticketingFinal(booking.status, booking.ticketingStatus)) {
          return { kind: "skipped" } as const;
        }
      }
      if (row.lastRefreshAt !== null && now.getTime() - row.lastRefreshAt.getTime() < request.throttleMs) {
        const left = request.throttleMs - (now.getTime() - row.lastRefreshAt.getTime());
        return { kind: "throttled", retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)) } as const;
      }
      await this.bookings.markSyncClaimed(trx, bookingId, now);
      return {
        kind: "claimed",
        claim: {
          id: bookingId,
          environment: request.environment,
          orderId: row.amadeusOrderId,
          office: row.ownerOfficeId,
          version: row.version,
        } satisfies SyncClaim,
      } as const;
    });
    if (claim.kind !== "claimed") {
      return claim;
    }
    const context: AmadeusCallContext = {
      tenantId: tenant.id,
      environment: request.environment,
      operation: request.operation,
      requestId: request.requestId,
      bookingId,
      ...(request.staffId === null || request.staffId === undefined ? {} : { staffId: request.staffId }),
      ...(claim.claim.office === null ? {} : { orderOffice: claim.claim.office }),
    };
    const read = await this.read(context, claim.claim, request.query);
    if (!read.ok) {
      if (read.error !== undefined && !isAppError(read.error)) {
        // A bug, not an Amadeus answer: nothing to record on the booking.
        throw read.error;
      }
      await this.recordFailure(bookingId, read.code);
      if (read.code === ORDER_NOT_FOUND) {
        this.logger.warn({ bookingId }, "bookings.refresh_order_not_found");
        return { kind: "not_found" };
      }
      const error = read.error;
      if (isAppError(error) && !DOCUMENTED_SUPPLIER_CODES.has(error.code)) {
        throw new AppError("SUPPLIER_ERROR", {
          ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
          cause: error,
        });
      }
      throw error ?? new AppError("SUPPLIER_ERROR");
    }
    const result = await this.tx.run((trx) =>
      this.record(trx, tenant, claim.claim, claim.claim.version, read, request),
    );
    if (result.kind !== "applied") {
      this.logger.info({ bookingId }, "bookings.refresh_superseded");
      return { kind: "superseded" };
    }
    this.logger.info({ bookingId, operation: request.operation, ...result.changes }, "bookings.refreshed");
    return { kind: "refreshed", warnings: warningsOf(read.body["warnings"]) };
  }

  // ---- Step 2: the read --------------------------------------------------------------------------------------------

  private async read(context: AmadeusCallContext, claim: SyncClaim, query: RefreshQuery): Promise<OrderRead> {
    try {
      const reply = await this.amadeus.getFlightOrder(context, {
        flightOrderId: claim.orderId,
        query: amadeusQueryOf(query),
      });
      const body: unknown = reply.body;
      const order = readCreatedOrder(body);
      if (order === undefined || !isRecord(body)) {
        this.logger.warn({ bookingId: claim.id }, "bookings.sync_order_unreadable");
        return { ok: false, code: "SUPPLIER_ERROR" };
      }
      return { ok: true, order, body, supplierRequestId: reply.call.supplierRequestId };
    } catch (error) {
      const code = readFailureCode(error);
      if (!(error instanceof AppError)) {
        // A bug, not an Amadeus answer: its name only (a message could quote what was read).
        this.logger.error(
          { bookingId: claim.id, error: error instanceof Error ? error.name : typeof error },
          "bookings.sync_read_error",
        );
      }
      return { ok: false, code, ...(error instanceof Error ? { error } : {}) };
    }
  }

  /** Records a failed read in `sync_error` (Booking.syncStatus `failed`), in a short transaction of its own. */
  private async recordFailure(bookingId: string, code: string): Promise<void> {
    await this.tx.run((trx) =>
      this.bookings.updateSynced(trx, bookingId, { sync_error: code, updated_at: this.clock.now() }, false),
    );
  }

  // ---- Step 3: the record ------------------------------------------------------------------------------------------

  private async record(
    trx: TenantTransaction,
    tenant: SyncTenant,
    claim: SyncClaim,
    claimedVersion: number,
    read: Extract<OrderRead, { ok: true }>,
    request: RecordRequest,
  ): Promise<RecordResult> {
    const now = this.clock.now();
    const current = await this.repository.lock(trx, claim.id);
    if (current === undefined) {
      return { kind: "gone", reason: "not_claimable" };
    }
    if (!isSyncStatus(current.status)) {
      return { kind: "gone", reason: "not_active" };
    }
    if (current.amadeusOrderId !== claim.orderId) {
      return { kind: "gone", reason: "no_order" };
    }
    if (current.version !== claimedVersion) {
      return { kind: "superseded", version: current.version };
    }
    const booking = await this.bookings.booking(trx, claim.id);
    const details = await this.bookings.bookingDetails(trx, claim.id);
    if (booking === undefined || details === undefined) {
      return { kind: "gone", reason: "not_claimable" };
    }
    const children = await this.bookings.children(trx, claim.id);
    const { order } = read;
    const orderSegments = orderSegmentsOf(order);
    const segments = diffSegments(children.segments, orderSegments);
    const tickets = diffTickets(children.tickets, order.tickets);
    const cancelled = cancelledByAirline(orderSegments);
    const upgrade = cancelled
      ? undefined
      : ticketUpgradeOf(
          booking.status,
          children.travelers.map((traveler) => traveler.amadeusTravelerId),
          children.tickets,
          order.tickets,
        );

    // Tickets.
    for (const changed of tickets.statusChanged) {
      await this.bookings.updateTicketStatus(trx, changed.stored.id, { status: changed.to, now });
    }
    if (tickets.added.length > 0) {
      const travelerRowIds = new Map(children.travelers.map((row) => [row.amadeusTravelerId, row.id]));
      await this.bookings.insertTickets(
        trx,
        this.recorder
          .ticketRows(booking.id, { tickets: tickets.added, offers: order.offers }, travelerRowIds, now)
          .map((row) => ({
            ...row,
            validating_carrier: booking.validatingCarrier ?? row.validating_carrier ?? null,
          })),
      );
    }

    // Segments.
    const trip = await this.applySegments(trx, booking, segments, now);
    await this.applyAssociatedRecords(trx, booking, children, order, now);

    // The booking.
    const scheduleChange = scheduleChangeOf(segments);
    const statusAfter = cancelled ? "cancelled" : (upgrade?.status ?? booking.status);
    const ticketingAfter = upgrade?.ticketingStatus ?? booking.ticketingStatus;
    const moved =
      cancelled ||
      upgrade !== undefined ||
      tickets.added.length > 0 ||
      tickets.statusChanged.length > 0 ||
      scheduleChange !== undefined;
    const included = isRecord(details.orderIncluded) ? { ...details.orderIncluded } : {};
    if (request.query.include !== undefined && request.query.include.length > 0) {
      included["bags"] = isRecord(read.body["included"]) ? (read.body["included"]["bags"] ?? {}) : {};
      included["bagsLoadedAt"] = now.toISOString();
    }
    if (request.query.fareRules !== undefined && request.query.fareRules.length > 0) {
      const fareRules: StoredFareRules = {
        loadedAt: now.toISOString(),
        types: [...request.query.fareRules],
        offers: offerFareRulesOf(order.data),
      };
      included["fareRules"] = fareRules;
    }
    const changes = syncChangesOf({
      statusBefore: booking.status,
      statusAfter,
      ticketingStatusBefore: booking.ticketingStatus,
      ticketingStatusAfter: ticketingAfter,
      segments: children.segments,
      segmentDiff: segments,
      tickets: children.tickets,
      ticketDiff: tickets,
    });
    await this.bookings.updateSynced(
      trx,
      booking.id,
      {
        order_snapshot: JSON.stringify(redactPayload(order.data)),
        ...(order.dictionaries === undefined
          ? {}
          : { order_dictionaries: JSON.stringify(order.dictionaries) }),
        order_included: JSON.stringify(redactPayload(included)),
        form_of_identifications: JSON.stringify(maskedIdentifications(order.data["formOfIdentifications"])),
        sync_changes: JSON.stringify(changes),
        last_synced_at: now,
        sync_error: null,
        updated_at: now,
        ...(trip === undefined ? {} : { first_departure_at: trip.first, last_arrival_at: trip.last }),
        ...(cancelled
          ? {
              status: "cancelled",
              cancelled_at: now,
              cancelled_by: "airline",
              cancel_reason: AIRLINE_CANCEL_REASON,
              ticketing_next_attempt_at: null,
            }
          : {}),
        ...(upgrade === undefined
          ? {}
          : {
              status: upgrade.status,
              ticketing_status: upgrade.ticketingStatus,
              issued_at: booking.issuedAt ?? now,
              ticketing_next_attempt_at: null,
              ticketing_error_code: null,
              ticketing_error: null,
            }),
      },
      moved,
    );

    // The events, after the booking's write: the documents they ask for read its new version. One millisecond apart, as
    // the timeline orders by time, then by the random id.
    let at = now.getTime();
    const event = async (
      input: Omit<Parameters<OrderRecorder["event"]>[2], "now" | "requestId">,
    ): Promise<void> => {
      await this.recorder.event(trx, booking.id, {
        ...input,
        requestId: request.requestId,
        now: new Date(at),
      });
      at += 1;
    };
    if (upgrade !== undefined || tickets.added.length > 0) {
      await event({
        type: "booking.ticketed",
        actor: SUPPLIER_ACTOR,
        statusFrom: booking.status,
        statusTo: upgrade?.status ?? booking.status,
        summary: "E-tickets issued.",
        data: { tickets: tickets.added.map((ticket) => ticket.documentNumber), via: request.operation },
        visibleToCustomer: true,
        supplierRequestId: read.supplierRequestId,
      });
    }
    if (cancelled) {
      await event({
        type: BOOKING_CANCELLED_EVENT,
        actor: SUPPLIER_ACTOR,
        statusFrom: upgrade?.status ?? booking.status,
        statusTo: "cancelled",
        summary: `The airline cancelled booking ${booking.reference}.`,
        data: { cancelledBy: "airline", via: request.operation },
        visibleToCustomer: true,
        supplierRequestId: read.supplierRequestId,
      });
      const settings = await this.bookings.settings(trx);
      await this.cancellationEmail(trx, tenant, booking, children, settings);
      const held = await this.cancellationAlert(trx, tenant, booking, settings);
      this.logger.warn(
        {
          tenantId: tenant.id,
          bookingId: booking.id,
          paid: new Money(booking.amountPaid).greaterThan(0),
          heldPayments: held,
          via: request.operation,
        },
        "bookings.sync_cancelled_by_airline",
      );
    } else if (scheduleChange !== undefined) {
      await event({
        type: SCHEDULE_CHANGED_EVENT,
        actor: SUPPLIER_ACTOR,
        statusFrom: statusAfter,
        statusTo: statusAfter,
        summary: scheduleChange.summary,
        data: { ...scheduleChange.data, via: request.operation },
        visibleToCustomer: scheduleChange.visibleToCustomer,
        supplierRequestId: read.supplierRequestId,
      });
    }
    return {
      kind: "applied",
      changes: {
        segmentsChanged: segments.changed.length,
        segmentsAdded: segments.added.length,
        segmentsRemoved: segments.removed.length,
        ticketsAdded: tickets.added.length,
        ticketsChanged: tickets.statusChanged.length,
        scheduleChanged: scheduleChange !== undefined,
        ticketed: upgrade !== undefined,
        cancelledByAirline: cancelled,
        versionMoved: moved,
      },
    };
  }

  /**
   * Writes the segment diff (see the file header) and answers the trip's new first departure and last arrival, over
   * the segments that are not cancelled; `undefined` when the segments' instants did not change or none is left.
   */
  private async applySegments(
    trx: TenantTransaction,
    booking: BookingRow,
    diff: SegmentDiff,
    now: Date,
  ): Promise<{ readonly first: Date; readonly last: Date } | undefined> {
    const placed = await this.placed(trx, [...diff.changed.map((segment) => segment.order), ...diff.added]);
    const changedRows = new Map<string, PlacedSegment>();
    diff.changed.forEach((segment, index) => {
      const at = placed[index];
      if (at !== undefined) {
        changedRows.set(segment.stored.id, at);
      }
    });
    const flown = new Map(diff.flown.map((entry) => [entry.stored.id, entry.isFlown]));
    for (const segment of diff.changed) {
      const at = changedRows.get(segment.stored.id);
      if (at === undefined) {
        continue;
      }
      await this.repository.updateSegment(trx, segment.stored.id, {
        departure_iata: segment.order.departureIata,
        departure_terminal: segment.order.departureTerminal,
        departure_local: segment.order.departureLocal,
        departure_at: at.departureAt,
        arrival_iata: segment.order.arrivalIata,
        arrival_terminal: segment.order.arrivalTerminal,
        arrival_local: segment.order.arrivalLocal,
        arrival_at: at.arrivalAt,
        carrier_code: segment.order.carrierCode,
        flight_number: segment.order.flightNumber,
        duration_minutes: segment.order.durationMinutes ?? segment.stored.durationMinutes,
        status: segment.order.status ?? segment.stored.status,
        is_flown: flown.get(segment.stored.id) ?? segment.stored.isFlown,
        updated_at: now,
      });
      flown.delete(segment.stored.id);
    }
    for (const [rowId, isFlown] of flown) {
      await this.repository.updateSegment(trx, rowId, { is_flown: isFlown, updated_at: now });
    }
    for (const segment of diff.removed) {
      await this.repository.updateSegment(trx, segment.id, { status: "CANCELLED", updated_at: now });
    }
    const added = placed.slice(diff.changed.length);
    await this.repository.insertSegments(
      trx,
      added.map((at) => this.segmentRow(booking.id, at, now)),
    );
    if (diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
      return undefined;
    }
    // The trip over the segments as they are now (read again after the writes), those not cancelled.
    const live = (await this.bookings.children(trx, booking.id)).segments.filter(
      (segment) => segment.status !== "CANCELLED",
    );
    if (live.length === 0) {
      return undefined;
    }
    const first = new Date(Math.min(...live.map((segment) => segment.departureAt.getTime())));
    const last = new Date(Math.max(first.getTime(), ...live.map((segment) => segment.arrivalAt.getTime())));
    return { first, last };
  }

  /** The instants of order segments, their local times read in the airports' time zones (UTC when unknown). */
  private async placed(trx: TenantTransaction, segments: readonly OrderSegment[]): Promise<PlacedSegment[]> {
    if (segments.length === 0) {
      return [];
    }
    const zones = await this.bookings.airportTimeZones(
      trx,
      segments.flatMap((segment) => [segment.departureIata, segment.arrivalIata]),
    );
    const instants = await this.bookings.instants(
      trx,
      segments.flatMap((segment) => [
        { local: segment.departureLocal, zone: zones.get(segment.departureIata) ?? "UTC" },
        { local: segment.arrivalLocal, zone: zones.get(segment.arrivalIata) ?? "UTC" },
      ]),
    );
    return segments.map((segment, index) => {
      const departureAt = instants[index * 2];
      const arrivalAt = instants[index * 2 + 1];
      if (departureAt === undefined || arrivalAt === undefined) {
        throw new Error("placed: an instant is missing");
      }
      // An arrival before the departure (unknown zones) would break `booking_segments_time_ck`.
      return {
        order: segment,
        departureAt,
        arrivalAt: arrivalAt.getTime() < departureAt.getTime() ? departureAt : arrivalAt,
      };
    });
  }

  /** The row of a segment the airline added, as the record step writes one (order-recorder.ts). */
  private segmentRow(bookingId: string, at: PlacedSegment, now: Date): Insertable<Db["booking_segments"]> {
    const plan = at.order;
    return {
      id: this.ids.newId("seg"),
      booking_id: bookingId,
      amadeus_flight_offer_id: plan.amadeusFlightOfferId,
      amadeus_segment_id: plan.amadeusSegmentId,
      itinerary_index: plan.itineraryIndex,
      segment_index: plan.segmentIndex,
      carrier_code: plan.carrierCode,
      flight_number: plan.flightNumber,
      operating_carrier_code: plan.operatingCarrierCode,
      aircraft_code: plan.aircraftCode,
      departure_iata: plan.departureIata,
      departure_terminal: plan.departureTerminal,
      departure_local: plan.departureLocal,
      departure_at: at.departureAt,
      arrival_iata: plan.arrivalIata,
      arrival_terminal: plan.arrivalTerminal,
      arrival_local: plan.arrivalLocal,
      arrival_at: at.arrivalAt,
      duration_minutes: plan.durationMinutes,
      number_of_stops: plan.numberOfStops,
      stops: plan.stops.length === 0 ? null : JSON.stringify(plan.stops),
      cabin: plan.cabin,
      booking_class: plan.bookingClass,
      fare_basis: plan.fareBasis,
      branded_fare: plan.brandedFare,
      included_checked_bags:
        plan.includedCheckedBags === null ? null : JSON.stringify(plan.includedCheckedBags),
      fare_details: JSON.stringify(plan.fareDetails),
      co2_emissions: plan.co2Emissions.length === 0 ? null : JSON.stringify(plan.co2Emissions),
      ...(plan.status === null ? {} : { status: plan.status }),
      ...(plan.isFlown === null ? {} : { is_flown: plan.isFlown }),
      created_at: now,
      updated_at: now,
    };
  }

  /** The order's associated records the booking does not have yet (an airline locator that appeared after booking). */
  private async applyAssociatedRecords(
    trx: TenantTransaction,
    booking: BookingRow,
    children: BookingChildren,
    order: CreatedOrder,
    now: Date,
  ): Promise<void> {
    const key = (record: { readonly reference: string; readonly originSystemCode: string }) =>
      `${record.reference}|${record.originSystemCode}`;
    const known = new Set(children.associatedRecords.map(key));
    const hasPrimary = children.associatedRecords.some((record) => record.isPrimary);
    await this.bookings.insertAssociatedRecords(
      trx,
      orderRecordsOf(order.data)
        .filter((record) => !known.has(key(record)))
        .map((record) => ({
          id: this.ids.newId("bar"),
          booking_id: booking.id,
          reference: record.reference,
          origin_system_code: record.originSystemCode,
          creation_date: record.creationDate,
          flight_offer_id: record.flightOfferId,
          // The primary record is the one copied into `bookings.record_locator` by the record step.
          is_primary: !hasPrimary && record.reference === booking.recordLocator,
          created_at: now,
          updated_at: now,
        })),
    );
  }

  // ---- What a cancellation by the airline sends ---------------------------------------------------------------------

  /**
   * The outbox `booking.cancelled` e-mail to the primary contact (or the booking's contact e-mail), once per booking
   * (its dedupe key), nothing refunded (the money is staff's). A call the outbox refuses (InvalidNotificationError,
   * raised before any SQL) is logged and skipped: the cancellation is recorded all the same.
   */
  private async cancellationEmail(
    trx: TenantTransaction,
    tenant: SyncTenant,
    booking: BookingRow,
    children: BookingChildren,
    settings: BookingSettingsRow | undefined,
  ): Promise<void> {
    const primary = children.contacts.find((contact) => contact.isPrimary) ?? children.contacts[0];
    const language = primary?.language ?? null;
    try {
      await this.outbox.enqueue(trx, {
        templateKey: "booking.cancelled",
        to: primary?.email ?? booking.contactEmail,
        locale:
          language !== null && LOCALE.test(language)
            ? language
            : (settings?.defaultLocale ?? tenant.defaultLocale ?? "en"),
        customerId: booking.customerId,
        bookingId: booking.id,
        dedupeKey: `booking.cancelled:${booking.id}`,
        data: {
          booking: {
            reference: booking.reference,
            recordLocator: booking.recordLocator ?? "",
            url: `${storefrontUrl(tenant.key, this.baseDomain)}/booking.html?id=${booking.id}`,
            total: { amount: booking.totalAmount, currency: booking.currency },
            contact: { firstName: primary?.firstName ?? "", lastName: primary?.lastName ?? "" },
            travellers: children.travelers.map((traveler) => ({
              firstName: traveler.firstName,
              lastName: traveler.lastName,
            })),
            segments: children.segments.map((segment: BookingSegmentRow) => ({
              origin: segment.departureIata,
              destination: segment.arrivalIata,
              departureAt: segment.departureLocal,
              arrivalAt: segment.arrivalLocal,
              carrierCode: segment.carrierCode,
              flightNumber: segment.flightNumber,
            })),
          },
          refund: { amount: "", currency: "" },
        },
      });
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error(
        { bookingId: booking.id, template: "booking.cancelled" },
        "bookings.sync_email_invalid",
      );
    }
  }

  /**
   * The staff alert of an airline cancellation of a booking whose payment holds the traveller's money (an authorisation
   * or a capture): `staff.manual_review`, once per booking (lead decision (3) of 2026-10-23). Answers how many payments
   * hold money (0: no alert).
   */
  private async cancellationAlert(
    trx: TenantTransaction,
    tenant: SyncTenant,
    booking: BookingRow,
    settings: BookingSettingsRow | undefined,
  ): Promise<number> {
    const held = await this.repository.heldPayments(trx, booking.id);
    if (held.length === 0) {
      return 0;
    }
    const money = held.map((payment) => {
      const captured = new Money(payment.amountCaptured).minus(payment.amountRefunded);
      return captured.greaterThan(0)
        ? `${payment.id} captured ${captured.toFixed(2)} ${payment.currency}`
        : `${payment.id} authorised ${new Money(payment.amountAuthorized).toFixed(2)} ${payment.currency}`;
    });
    await this.alerts.send(trx, {
      settings,
      fallbackLocale: tenant.defaultLocale ?? "en",
      booking: { id: booking.id, reference: booking.reference, recordLocator: booking.recordLocator },
      dedupeKey: `staff.manual_review:${booking.id}:${AIRLINE_CANCELLED_ALERT}`,
      reason:
        `The airline cancelled every flight of booking ${booking.reference}, and its payment still holds the ` +
        `traveller's money (${money.join("; ")}). Release the authorisation or refund the payment from the console.`,
    });
    return held.length;
  }
}
