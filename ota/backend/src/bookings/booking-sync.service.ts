// The background booking sync (OBE-045; ota/docs/flows/ticketing-and-documents.md §3 step 5 and §4, OADR-0014 points
// 2, 4 and 6, db README §6 "Booking sync", the document's consoleResyncBooking and listBookings "Freshness"): one
// Flight Order Management GET of an active booking's order, and what it says changed written onto the booking. It runs
// in the worker only, for one booking of the tenant of the current job context (booking-sync.processor.ts opens it),
// and no database transaction is open while Amadeus is called (architecture §4).
//
// **Due** (BookingSyncRepository.dueBookingIds, the scan's query, and the claim's check): a `confirmed`, `ticketed` or
// `partially_ticketed` booking with an Amadeus order whose trip is not over (`last_arrival_at` after now: the document
// keeps "upcoming trips" current), last synchronised BOOKING_SYNC_INTERVAL_MS (6 hours, the document's "every 6 h",
// Booking.syncStatus `fresh`) ago or more (or never), or BOOKING_SYNC_DEADLINE_INTERVAL_MS (1 hour) ago or more for a
// booking that still waits for tickets (`confirmed`, `partially_ticketed`) in the 24 hours before its
// `ticketing_deadline_at` (the document's ConsoleSupplierSync.nextScheduledSyncAt: "every 6 h for upcoming trips, hourly
// in the 24 h before the ticketing deadline"; syncIntervalOf), and without a claim of a synchronisation in the last
// BOOKING_SYNC_RETRY_MS (30 minutes: `booking.sync_requested`, the events the customer refresh also writes and is
// throttled by), so an attempt in progress is never doubled and one whose read failed (a rate limit, a timeout, an
// order not found) is tried again half an hour later instead of at every scan; for a suspended tenant only paid ones
// (`amount_paid > 0`, OADR-0008 point 8). The scan takes the oldest synced first (`bookings_sync_idx`).
//
//   1. Claim (T1). The booking is locked with `FOR NO KEY UPDATE SKIP LOCKED` (lead decision (1) of 2026-10-22,
//      OADR-0014 point 6: a booking another claim, worker or request holds is skipped, a transaction that only holds its
//      `FOR KEY SHARE`, the foreign-key lock of an event, outbox or document insert, never makes the claim skip), read
//      in a statement after the lock and checked again, whatever the job said (due, above). The claim writes the
//      staff-only event `booking.sync_requested` (`data.operation = "booking.sync"`), its in-progress marker: a second
//      claim (another job, a customer refresh within 60 s) sees it and stands back. It does not move `version`, and
//      commits before Amadeus is called.
//   2. Read. Flight Order Management GET with `include=bags`. A failure is recorded in `sync_error` (Booking.syncStatus
//      `failed`; `version` unchanged): Amadeus 404 as `ORDER_NOT_FOUND` (an order purged, or cancelled outside
//      Velexis: staff check it; never a cancellation, see order-diff.ts), an answer that cannot be read as
//      `SUPPLIER_ERROR`, any other as its error code. The next attempt comes with the next due scan.
//   3. Record (T2), with the booking `version` of the claim: the booking is locked again (`FOR NO KEY UPDATE`, which
//      waits) and must still be active with the same order; a booking whose `version` moved since the claim (another
//      writer recorded something while the order was read: a ticketing job, a console patch or resync, a refresh that
//      stored tickets) is not overwritten: the sync reads the order again and records it against the new version, at
//      most BOOKING_SYNC_ROUNDS reads in all (`superseded` after that, nothing written; the next due scan tries again).
//      Otherwise it applies the diff of order-diff.ts:
//        - tickets: new ones inserted, changed statuses recorded; a booking now fully or partly ticketed becomes
//          `ticketed`/`partially_ticketed` (`issued`/`partially_issued`, `issued_at`), event `booking.ticketed`, which
//          asks for the e-ticket receipts and a new itinerary (documents.processor.ts);
//        - segments: changed ones rewritten (times and their instants through the airports' time zones, airports,
//          terminals, flight, status, duration), added ones inserted, removed ones `CANCELLED`, `isFlown` recorded; the
//          booking's `first_departure_at`/`last_arrival_at` follow the segments that are not cancelled; event
//          `booking.schedule_changed` (flagged in the console as `hasScheduleChange`; visible to the customer when
//          times changed). No customer e-mail for a schedule change in the MVP (plan step 3);
//        - cancellation by the airline (every segment of the order `CANCELLED`): the booking becomes `cancelled` with
//          `cancelled_at`, `cancelled_by = airline`, no further ticketing attempt, event `booking.cancelled` through
//          OrderRecorder.event (the cancelled itinerary follows it), and the traveller's `booking.cancelled` e-mail
//          (once per booking, dedupe key). The money is staff's (flow §3 step 4: the authorisation is voided or the
//          capture refunded from the console); the log line says whether the booking was paid. A schedule change of
//          the same read is part of the cancellation, not an event of its own;
//        - always: the redacted `order_snapshot`, `order_dictionaries`, `order_included.bags`, the order's associated
//          records the booking does not have yet, `last_synced_at`, `sync_error = null`.
//      `version` moves (and with it the ETag) when tickets, a status or the segments changed, the changes documents and
//      answers follow (lead decision (6a) of 2026-10-22); an `isFlown`, a record or the snapshot alone keep it.
//
// The sync does not clean the booking queue (lead decision (5) of 2026-10-22: Queue List has no removal among the 12
// operations). Log lines carry ids, codes and counts, never an Amadeus body, a ticket number or a person's data.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError, isAppError } from "@velexis/errors";
import { sql, type Insertable, type TenantDatabase, type Updateable } from "@velexis/db";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { WorkerConfig } from "../config";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import { Money } from "../pricing/pricing.types";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { orderRecordsOf } from "./bookings.mapper";
import {
  BookingsRepository,
  REFRESH_CLAIM_EVENT,
  type BookingChildren,
  type BookingRow,
  type BookingSegmentRow,
} from "./bookings.repository";
import { ORDER_NOT_FOUND } from "./customer-bookings.service";
import {
  cancelledByAirline,
  diffSegments,
  diffTickets,
  orderSegmentsOf,
  scheduleChangeOf,
  ticketUpgradeOf,
  type OrderSegment,
  type SegmentDiff,
} from "./order-diff";
import { OrderRecorder, readCreatedOrder, type CreatedOrder } from "./order-recorder";

type Db = TenantDatabase;

/** The Velexis operation of the sync's Amadeus calls (`supplier_requests.operation`) and its claim events. */
export const BOOKING_SYNC_OPERATION = "booking.sync";

/** How long a synchronisation keeps a booking from being synchronised again (see the file header). */
export const BOOKING_SYNC_INTERVAL_MS = 6 * 60 * 60_000;

/** The same in the 24 h before the ticketing deadline of a booking that waits for tickets (see the file header). */
export const BOOKING_SYNC_DEADLINE_INTERVAL_MS = 60 * 60_000;

/** How long before its ticketing deadline a booking that waits for tickets is synchronised hourly. */
export const BOOKING_SYNC_DEADLINE_WINDOW_MS = 24 * 60 * 60_000;

/** How long a claim of a synchronisation (an attempt, in progress or failed) keeps the booking out (see the header). */
export const BOOKING_SYNC_RETRY_MS = 30 * 60_000;

/** The reads of the order one sync makes at most when other writers keep moving the booking's version. */
export const BOOKING_SYNC_ROUNDS = 3;

/** The booking statuses the sync keeps current: those with an order that is not cancelled (`pending` is reconciled). */
export const BOOKING_SYNC_STATUSES = ["confirmed", "ticketed", "partially_ticketed"] as const;

/** The statuses among BOOKING_SYNC_STATUSES of a booking that still waits for (some of) its tickets. */
const AWAITING_TICKETS_STATUSES = ["confirmed", "partially_ticketed"] as const;

/** The event of a schedule change (the console's `hasScheduleChange`, console-bookings.repository.ts). */
export const SCHEDULE_CHANGED_EVENT = "booking.schedule_changed";

/** The event of a cancellation (OrderRecorder.event asks for the cancelled itinerary). */
export const BOOKING_CANCELLED_EVENT = "booking.cancelled";

/** `bookings.cancel_reason` of a cancellation the sync found. */
export const AIRLINE_CANCEL_REASON = "Every segment of the order was cancelled by the airline.";

/** Who the sync's booking events name: Amadeus, which reported the change. */
const SUPPLIER_ACTOR = Object.freeze({ type: "supplier", id: null });
const SYSTEM_ACTOR = Object.freeze({ type: "system", id: null });

/** A BCP 47 locale as the outbox accepts it. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSyncStatus = (status: string): boolean =>
  (BOOKING_SYNC_STATUSES as readonly string[]).includes(status);

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
  /** The newest claim of a synchronisation (`booking.sync_requested` events: the sync's and the refreshes'). */
  readonly lastClaimAt: Date | null;
}

/** The query options of the scan. */
export interface DueSyncQuery {
  readonly now: Date;
  /** Only bookings with a captured amount (a suspended tenant's, OADR-0008 point 8). */
  readonly paidOnly: boolean;
  readonly limit: number;
}

/** The newest claim of a synchronisation of booking `b`. */
const lastClaimOf = sql<Date | null>`(
  SELECT max(e.created_at) FROM booking_events e
  WHERE e.booking_id = b.id AND e.type = ${REFRESH_CLAIM_EVENT}
)`;

/** The sync's queries on `bookings` and `booking_segments` (tenant repository: the `tenantTx` transaction first). */
@Injectable()
export class BookingSyncRepository {
  /**
   * The ids of the bookings due at `now` (see the file header), the oldest synced first (never synced first), at most
   * `limit`. The partial index `bookings_sync_idx` serves the order; `booking_events_booking_idx` the claim check.
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
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("booking_events as e")
              .select(sql<number>`1`.as("one"))
              .whereRef("e.booking_id", "=", "b.id")
              .where("e.type", "=", REFRESH_CLAIM_EVENT)
              .where("e.created_at", ">", claimedBefore),
          ),
        ),
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
        sql<string>`b.amount_paid::text`.as("amountPaid"),
        lastClaimOf.as("lastClaimAt"),
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

/** What a sync recorded (counts and flags for the job's result and the log line). */
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

/** A claimed booking. */
interface SyncClaim {
  readonly id: string;
  readonly environment: "test" | "live";
  readonly orderId: string;
  readonly office: string | null;
  /** The booking's `version` at the claim. */
  readonly version: number;
  /** When the claim was written: the record's events come after it on the timeline. */
  readonly claimedAt: Date;
}

/** A read of the order. */
type OrderRead =
  | {
      readonly ok: true;
      readonly order: CreatedOrder;
      readonly body: Record<string, unknown>;
      readonly supplierRequestId: string | null;
    }
  | { readonly ok: false; readonly code: string };

/** What the record step did. */
type RecordResult =
  | { readonly kind: "applied"; readonly changes: BookingSyncChanges }
  | { readonly kind: "superseded"; readonly version: number }
  | { readonly kind: "gone"; readonly reason: BookingSyncSkip };

/**
 * How long after its last synchronisation a booking is due again at `now` (see the file header): an hour for one that
 * waits for tickets (`confirmed`, `partially_ticketed`) whose ticketing deadline is in the next 24 hours, else 6 hours.
 * dueBookingIds runs the same rule in SQL.
 */
export function syncIntervalOf(row: Pick<SyncClaimRow, "status" | "ticketingDeadlineAt">, now: Date): number {
  const left =
    row.ticketingDeadlineAt === null ? undefined : row.ticketingDeadlineAt.getTime() - now.getTime();
  return left !== undefined &&
    left > 0 &&
    left <= BOOKING_SYNC_DEADLINE_WINDOW_MS &&
    (AWAITING_TICKETS_STATUSES as readonly string[]).includes(row.status)
    ? BOOKING_SYNC_DEADLINE_INTERVAL_MS
    : BOOKING_SYNC_INTERVAL_MS;
}

/** Why a booking may not be claimed at `now`, or `undefined` when it may. */
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
  if (since(row.lastSyncedAt) < syncIntervalOf(row, now) || since(row.lastClaimAt) < BOOKING_SYNC_RETRY_MS) {
    return "not_due";
  }
  return undefined;
}

/** The API code of a failed read: an AppError's code (404 as ORDER_NOT_FOUND), `INTERNAL_ERROR` for anything else. */
function readFailureCode(error: unknown): string {
  if (isAppError(error) && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404) {
    return ORDER_NOT_FOUND;
  }
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}

/** A segment row to write, with its instants. */
interface PlacedSegment {
  readonly order: OrderSegment;
  readonly departureAt: Date;
  readonly arrivalAt: Date;
}

/** Runs one synchronisation of a booking (see the file header). */
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
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    config: ConfigService<WorkerConfig, true>,
    @InjectPinoLogger(BookingSyncService.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /**
   * One synchronisation of the booking `bookingId` of `tenant`, in the tenant's job context; `requestId` names the job
   * in the Amadeus call and the events. Amadeus failures are recorded, never thrown; a database error is thrown (the
   * job fails and BullMQ retries it; its claim keeps the booking from being claimed again until it is due).
   */
  async attempt(tenant: PlatformTenant, bookingId: string, requestId: string): Promise<BookingSyncOutcome> {
    const claim = await this.claim(tenant, bookingId, requestId);
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
    let version = claim.version;
    for (let round = 1; round <= BOOKING_SYNC_ROUNDS; round += 1) {
      const read = await this.read(context, claim);
      if (!read.ok) {
        await this.recordFailure(bookingId, read.code);
        this.logger.warn({ tenantId: tenant.id, bookingId, code: read.code, round }, "bookings.sync_failed");
        return { outcome: "failed", rounds: round, code: read.code };
      }
      const result = await this.tx.run((trx) => this.record(trx, tenant, claim, version, read, requestId));
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

  // ---- Step 1: the claim -------------------------------------------------------------------------------------------

  private async claim(
    tenant: PlatformTenant,
    bookingId: string,
    requestId: string,
  ): Promise<SyncClaim | BookingSyncSkip> {
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
      await this.recorder.event(trx, row.id, {
        type: REFRESH_CLAIM_EVENT,
        actor: SYSTEM_ACTOR,
        summary: "Synchronisation with the airline started.",
        data: { operation: BOOKING_SYNC_OPERATION },
        visibleToCustomer: false,
        requestId,
        now,
      });
      return {
        id: row.id,
        environment: row.environment,
        orderId: row.amadeusOrderId,
        office: row.ownerOfficeId,
        version: row.version,
        claimedAt: now,
      };
    });
  }

  // ---- Step 2: the read --------------------------------------------------------------------------------------------

  private async read(context: AmadeusCallContext, claim: SyncClaim): Promise<OrderRead> {
    try {
      const reply = await this.amadeus.getFlightOrder(context, {
        flightOrderId: claim.orderId,
        query: { include: ["bags"] },
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
      return { ok: false, code };
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
    tenant: PlatformTenant,
    claim: SyncClaim,
    claimedVersion: number,
    read: Extract<OrderRead, { ok: true }>,
    requestId: string,
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
    const moved =
      cancelled ||
      upgrade !== undefined ||
      tickets.added.length > 0 ||
      tickets.statusChanged.length > 0 ||
      scheduleChange !== undefined;
    const included = isRecord(details.orderIncluded) ? { ...details.orderIncluded } : {};
    if (isRecord(read.body["included"])) {
      included["bags"] = read.body["included"]["bags"] ?? {};
      included["bagsLoadedAt"] = now.toISOString();
    }
    await this.bookings.updateSynced(
      trx,
      booking.id,
      {
        order_snapshot: JSON.stringify(redactPayload(order.data)),
        ...(order.dictionaries === undefined
          ? {}
          : { order_dictionaries: JSON.stringify(order.dictionaries) }),
        order_included: JSON.stringify(redactPayload(included)),
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

    // The events, after the booking's write: the documents they ask for read its new version. One millisecond apart,
    // and after the claim's, as the timeline orders by time, then by the random id.
    let at = Math.max(now.getTime(), claim.claimedAt.getTime() + 1);
    const event = async (
      input: Omit<Parameters<OrderRecorder["event"]>[2], "now" | "requestId">,
    ): Promise<void> => {
      await this.recorder.event(trx, booking.id, { ...input, requestId, now: new Date(at) });
      at += 1;
    };
    if (upgrade !== undefined || tickets.added.length > 0) {
      await event({
        type: "booking.ticketed",
        actor: SUPPLIER_ACTOR,
        statusFrom: booking.status,
        statusTo: upgrade?.status ?? booking.status,
        summary: "E-tickets issued.",
        data: { tickets: tickets.added.map((ticket) => ticket.documentNumber), via: BOOKING_SYNC_OPERATION },
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
        data: { cancelledBy: "airline" },
        visibleToCustomer: true,
        supplierRequestId: read.supplierRequestId,
      });
      await this.cancellationEmail(trx, tenant, booking, children);
      this.logger.warn(
        { tenantId: tenant.id, bookingId: booking.id, paid: new Money(booking.amountPaid).greaterThan(0) },
        "bookings.sync_cancelled_by_airline",
      );
    } else if (scheduleChange !== undefined) {
      await event({
        type: SCHEDULE_CHANGED_EVENT,
        actor: SUPPLIER_ACTOR,
        statusFrom: statusAfter,
        statusTo: statusAfter,
        summary: scheduleChange.summary,
        data: scheduleChange.data,
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

  // ---- The traveller's e-mail of a cancellation --------------------------------------------------------------------

  /**
   * The outbox `booking.cancelled` e-mail to the primary contact (or the booking's contact e-mail), once per booking
   * (its dedupe key), nothing refunded (the money is staff's). A call the outbox refuses (InvalidNotificationError,
   * raised before any SQL) is logged and skipped: the cancellation is recorded all the same.
   */
  private async cancellationEmail(
    trx: TenantTransaction,
    tenant: PlatformTenant,
    booking: BookingRow,
    children: BookingChildren,
  ): Promise<void> {
    const settings = await this.bookings.settings(trx);
    const primary = children.contacts.find((contact) => contact.isPrimary) ?? children.contacts[0];
    const language = primary?.language ?? null;
    try {
      await this.outbox.enqueue(trx, {
        templateKey: "booking.cancelled",
        to: primary?.email ?? booking.contactEmail,
        locale:
          language !== null && LOCALE.test(language)
            ? language
            : (settings?.defaultLocale ?? tenant.defaultLocale),
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
}
