// The customer bookings use cases (OBE-046; ota/docs/flows/my-bookings-and-guest-lookup.md §3 steps 4–5, db README §10
// "My trips", the contract's listBookings, getBooking, getBookingTicketingStatus, listBookingEvents and
// getBookingFareRules): what a signed-in customer or a guest holding a booking token sees of a booking, in customer
// scope only (bookings.mapper.ts).
//
// - `list`: the signed-in customer's bookings of the request's environment (customers are shared by test and live),
//   by tab: `upcoming` (the active statuses whose last arrival is now or later, by first departure), `past` (the active
//   statuses whose last arrival has passed, newest departure first), `cancelled` (newest departure first) and `all`
//   (every status but `failed`, newest first), with the date filters and a keyset cursor.
// - `get`, `ticketingStatus`, `events`, `fareRules`: one booking the booking access guard let the request in to
//   (`BookingAccessContext.require`). Events are the customer-visible ones only (`visible_to_customer`: staff notes,
//   supplier diagnostics and the refresh claims written before FIX-W27-SYNC are console-only), newest first.
//
// **Refresh** (`refresh=true`, and getFareRules without fresh fare rules): one Flight Order Management GET per booking
// and minute at most, shared by the three operations, run by BookingSyncService.refresh (booking-sync.service.ts; lead
// decision (3) of 2026-10-23, FIX-W27-SYNC). The claim (T1) locks the booking, refuses one refreshed or synced less than
// 60 s ago (`syncStatus: throttled`; getFareRules answers from its cache, or `429 RATE_LIMITED` with `Retry-After`
// when it has none), skips a booking without an Amadeus order (pending, failed) or a cancelled one, and records the
// claim in `bookings.sync_claimed_at` (a staff-only `booking.sync_requested` event before FIX-W27-SYNC): a second claim
// waits for the lock and sees it (it reads the booking in a statement after the lock), and the background sync stays
// away for 30 minutes. The call runs without a transaction (OADR-0003 point 1). The record (T2) writes nothing when the
// booking's `version` moved since the claim (another writer recorded it while the order was read; the answer shows the
// stored booking). Otherwise it records the order through the background sync's diff (order-diff.ts) and writes the
// same events: `order_snapshot` after the shared redactor, `order_dictionaries`, the tickets (new ones inserted,
// changed statuses recorded; event `booking.ticketed`), the segments (changed times, airports, flights and statuses
// rewritten, added and removed ones, `isFlown`; event `booking.schedule_changed`, which asks for a new itinerary), a
// cancellation by the airline (`cancelled`, event `booking.cancelled`, the traveller's e-mail, a staff alert when a
// payment holds money), a booking that is now fully or partly ticketed, the associated records the booking does not
// have yet, the forms of identification (last 4 characters), `order_included` (bag options with `include=bags`, fare
// rules with `fareRules`), what changed (`sync_changes`), `last_synced_at`, and clears `sync_error`. The `version` (and
// so the ETag) moves whenever the record stores new or changed tickets, a new status or changed segments (lead decision
// (6a) of 2026-10-22: the documents queue deduplicates its jobs by the version); a refresh that stores nothing else
// keeps the version and the ETag. Amadeus `404` (an order purged after travel) keeps the stored data with a warning;
// other Amadeus errors are recorded in `sync_error` and answered `502/503/504` (an error code the operation does not
// document becomes `502 SUPPLIER_ERROR`).
//
// console.bookings.get with `refresh=true` (OBE-061, console/console-bookings.service.ts) runs the same refresh
// (`refresh`) with the console's throttle of 10 s (`throttleMs`); a staff member's call names them in its
// `supplier_requests` row (`staff_id`).
import { Injectable } from "@nestjs/common";
import type { operations } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import { BookingAccessContext } from "../common/auth/booking-access.guard";
import { CustomerContext } from "../common/auth/customer.guard";
import { Clock } from "../common/clock";
import { PaymentsRepository } from "../payments/payments.repository";
import { toPayment } from "../payments/payments.service";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { allowedActionsOf, REFRESH_THROTTLE_MS } from "./allowed-actions";
import {
  BookingSyncService,
  ORDER_NOT_FOUND_WARNING,
  type RefreshOutcome,
  type RefreshQuery,
} from "./booking-sync.service";
import {
  customerOrderOf,
  customerTicketsOf,
  decodeListCursor,
  FARE_RULE_TYPES,
  FARE_RULES_CACHE_MS,
  fareConditionsOf,
  listFingerprint,
  pageOf,
  snapshotOffersOf,
  storedFareRulesOf,
  storedSyncStatusOf,
  toBookingEvent,
  toBookingFareRules,
  toBookingSummary,
  toCustomerBooking,
  toTicketingStatus,
  type BookingEvent,
  type BookingFareRules,
  type BookingSummary,
  type BookingTicketingStatus,
  type FareRuleType,
  type PageInfo,
  type StoredFareRules,
  type SyncStatus,
} from "./bookings.mapper";
import { BookingsRepository, type BookingListSort, type BookingTimeframe } from "./bookings.repository";
import { cancellationFactsOf, cancellationPendingOf } from "./cancellation-state";
import { BookingTravelerDocuments, type Booking, type Warning } from "./order-recorder";
import type { TicketingPolicy } from "./order-request.builder";

// The refresh's outcomes, its query and the `ORDER_NOT_FOUND` code moved to booking-sync.service.ts with the refresh
// (FIX-W27-SYNC); they are still read from here.
export {
  ORDER_NOT_FOUND,
  ORDER_NOT_FOUND_WARNING,
  type RefreshOutcome,
  type RefreshQuery,
} from "./booking-sync.service";

export type BookingListQueryInput = NonNullable<operations["listBookings"]["parameters"]["query"]>;

/** A page of a list answer. */
export interface Page<T> {
  readonly data: T[];
  readonly page: PageInfo;
}

/** The default page size of the lists (the document's `Limit`). */
export const DEFAULT_PAGE_LIMIT = 20;

/** The default sort of each tab (BookingSort). */
const DEFAULT_SORTS: Readonly<Record<BookingTimeframe, BookingListSort>> = Object.freeze({
  upcoming: "departure",
  past: "-departure",
  cancelled: "-departure",
  all: "-created",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The storefront switches the allowed actions read (`storefront_settings.features`). */
function featuresOf(value: unknown): {
  readonly selfServiceCancellation: boolean;
  readonly ancillaries: boolean;
} {
  const features = isRecord(value) ? value : {};
  return {
    // Off unless the OTA turns it on: a cancellation moves money (OBE-049, change-and-cancel §3 step 3).
    selfServiceCancellation: features["selfServiceCancellation"] === true,
    // On unless the OTA turns it off (storefront.mapper.ts DEFAULT_FEATURES).
    ancillaries: features["ancillaries"] !== false,
  };
}

@Injectable()
export class CustomerBookingsService {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: BookingsRepository,
    private readonly payments: PaymentsRepository,
    private readonly travelerDocuments: BookingTravelerDocuments,
    private readonly sync: BookingSyncService,
    private readonly tenants: TenantContext,
    private readonly customers: CustomerContext,
    private readonly access: BookingAccessContext,
    private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(CustomerBookingsService.name);
  }

  // ---- bookings.list -----------------------------------------------------------------------------------------------

  /** The signed-in customer's bookings of one tab (see the file header). */
  async list(query: BookingListQueryInput): Promise<Page<BookingSummary>> {
    const customer = this.customers.require();
    const tenant = this.tenants.require();
    const timeframe: BookingTimeframe = query.timeframe ?? "upcoming";
    const sort: BookingListSort = query.sort ?? DEFAULT_SORTS[timeframe];
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const fingerprint = listFingerprint({
      list: "bookings",
      timeframe,
      sort,
      departureFrom: query.departureFrom,
      departureTo: query.departureTo,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
    });
    const after = query.cursor === undefined ? undefined : decodeListCursor(query.cursor, fingerprint);
    const now = this.clock.now();
    return await this.tx.run(async (trx) => {
      const rows = await this.repository.customerBookings(trx, {
        environment: tenant.environment,
        customerId: customer.customerId,
        timeframe,
        sort,
        departureFrom: query.departureFrom,
        departureTo: query.departureTo,
        createdFrom: query.createdFrom,
        createdTo: query.createdTo,
        after: after === undefined ? undefined : { key: after.key, id: after.id },
        limit: limit + 1,
        now,
      });
      const { rows: page, page: info } = pageOf(rows, limit, fingerprint);
      const ids = page.map((row) => row.id);
      const segments = await this.repository.summarySegments(trx, ids);
      const leads = new Map(
        (await this.repository.leadTravelers(trx, ids)).map((row) => [row.bookingId, row]),
      );
      const cities = await this.repository.cityNames(
        trx,
        page.flatMap((row) => (row.destinationIata === null ? [] : [row.destinationIata])),
      );
      const units = await this.minorUnitsOf(
        trx,
        page.map((row) => row.currency),
      );
      return {
        data: page.map((row) =>
          toBookingSummary({
            row,
            segments: segments.filter((segment) => segment.bookingId === row.id),
            lead: leads.get(row.id),
            cityName: row.destinationIata === null ? undefined : cities.get(row.destinationIata),
            minorUnits: units.get(row.currency) ?? 2,
            now,
          }),
        ),
        page: info,
      };
    });
  }

  // ---- bookings.get ------------------------------------------------------------------------------------------------

  /** One booking in customer scope, after a refresh when asked (see the file header). */
  async get(
    bookingId: string,
    options: {
      readonly refresh: boolean;
      readonly include?: "bags"[] | undefined;
      readonly fareRules?: FareRuleType[] | undefined;
    },
  ): Promise<Booking> {
    this.access.require(bookingId);
    const tenant = this.tenants.require();
    let syncStatus: SyncStatus | undefined;
    let warnings: readonly Warning[] = [];
    if (options.refresh) {
      const outcome = await this.refresh(tenant, bookingId, "bookings.get", {
        include: options.include,
        fareRules: options.fareRules,
      });
      if (outcome.kind === "refreshed") {
        syncStatus = "refreshed";
        warnings = outcome.warnings;
      } else if (outcome.kind === "throttled") {
        syncStatus = "throttled";
      } else if (outcome.kind === "not_found") {
        syncStatus = "failed";
        warnings = [ORDER_NOT_FOUND_WARNING];
      }
    }
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const { booking, details, children, settings, minorUnits } = await this.readBooking(trx, bookingId);
      const travelers = [];
      for (const row of children.travelers) {
        const opened = await this.travelerDocuments.open(tenant.schemaName, row);
        travelers.push({ row, documents: opened.documents, discounts: opened.discounts });
      }
      const payments = [];
      for (const id of await this.repository.paymentIdsOf(trx, bookingId)) {
        const row = await this.payments.payment(trx, id);
        if (row !== undefined) {
          payments.push(toPayment(row, { minorUnits, clientSecret: null, publishableKey: null }));
        }
      }
      const documents = await this.repository.currentDocuments(trx, bookingId);
      const offers = snapshotOffersOf(details.orderSnapshot);
      const storedRules = storedFareRulesOf(details.orderIncluded);
      const wantsFareRules = options.fareRules !== undefined && options.fareRules.length > 0;
      // The cancellation block and canCancel follow the cancellation's state (FIX-W28-CANCEL).
      const cancellationFacts = await cancellationFactsOf(trx, bookingId);
      return toCustomerBooking({
        booking,
        children,
        travelers,
        payments,
        policy: settings.policy,
        minorUnits,
        now,
        allowedActions: allowedActionsOf({
          status: booking.status,
          ticketingStatus: booking.ticketingStatus,
          amadeusOrderId: booking.amadeusOrderId,
          lastArrivalAt: booking.lastArrivalAt,
          segments: children.segments,
          documentsReady: documents.some((document) => document.status === "ready"),
          features: settings.features,
          lastRefreshAt: details.lastRefreshAt,
          cancellationPending: cancellationPendingOf(cancellationFacts.state),
          now,
        }),
        ancillaries: await this.repository.ancillaries(trx, bookingId),
        refunds: await this.repository.refundsOf(trx, bookingId),
        documents,
        cancelledBy: details.cancelledBy,
        cancelReason: details.cancelReason,
        cancellationFacts,
        amadeus: customerOrderOf({
          snapshot: details.orderSnapshot,
          dictionaries: details.orderDictionaries,
          markupAmount: booking.markupAmount,
          minorUnits,
          visibleRemarks: children.remarks.filter((row) => row.visibleToCustomer).map((row) => row.text),
        }),
        fareConditions:
          offers.length === 0 ? null : fareConditionsOf(storedRules?.offers ?? [], offers, booking.currency),
        fareRules:
          wantsFareRules && storedRules !== undefined
            ? toBookingFareRules({ booking, stored: storedRules, offers, minorUnits })
            : null,
        syncStatus: syncStatus ?? storedSyncStatusOf(booking.lastSyncedAt, details.syncError, now),
        warnings,
      });
    });
  }

  // ---- bookings.getTicketingStatus ---------------------------------------------------------------------------------

  /**
   * The ticketing progress of a booking. `refresh=true` reads the order first when its state is not final and it has
   * an Amadeus order (a pending booking's refresh is ignored: there is no order id yet).
   */
  async ticketingStatus(bookingId: string, refresh: boolean): Promise<BookingTicketingStatus> {
    this.access.require(bookingId);
    const tenant = this.tenants.require();
    if (refresh) {
      await this.refresh(tenant, bookingId, "bookings.getTicketingStatus", {}, { unlessFinal: true });
    }
    return await this.tx.run(async (trx) => {
      const { booking, details, children, settings } = await this.readBooking(trx, bookingId);
      return toTicketingStatus({
        booking,
        policy: settings.policy,
        requestedAt: details.ticketingRequestedAt,
        lastAttemptAt: details.ticketingLastAttemptAt,
        errorCode: details.ticketingErrorCode,
        tickets: customerTicketsOf(children.tickets, children.travelers),
      });
    });
  }

  // ---- bookings.listEvents -----------------------------------------------------------------------------------------

  /** The customer-visible timeline of a booking, newest first. */
  async events(
    bookingId: string,
    query: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ): Promise<Page<BookingEvent>> {
    this.access.require(bookingId);
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const fingerprint = listFingerprint({ list: "events", bookingId });
    const after = query.cursor === undefined ? undefined : decodeListCursor(query.cursor, fingerprint);
    return await this.tx.run(async (trx) => {
      const rows = await this.repository.customerEvents(trx, bookingId, {
        after: after === undefined ? undefined : { key: after.key, id: after.id },
        limit: limit + 1,
      });
      const { rows: page, page: info } = pageOf(rows, limit, fingerprint);
      return { data: page.map(toBookingEvent), page: info };
    });
  }

  // ---- bookings.getFareRules ---------------------------------------------------------------------------------------

  /**
   * The booking's rebooking and refund eligibility: from `order_included` while loaded less than an hour ago with the
   * requested types and no `refresh`, else from a Flight Order Management GET with `fareRules` (throttled; a throttled
   * call answers the cached rules, or `429 RATE_LIMITED` when there are none).
   */
  async fareRules(
    bookingId: string,
    options: { readonly types?: FareRuleType[] | undefined; readonly refresh: boolean },
  ): Promise<BookingFareRules> {
    this.access.require(bookingId);
    const tenant = this.tenants.require();
    const types =
      options.types !== undefined && options.types.length > 0 ? options.types : [...FARE_RULE_TYPES];
    const cached = await this.tx.run(async (trx) => {
      const details = await this.repository.bookingDetails(trx, bookingId);
      return details === undefined ? undefined : storedFareRulesOf(details.orderIncluded);
    });
    const now = this.clock.now();
    const fresh =
      cached !== undefined &&
      types.every((type) => cached.types.includes(type)) &&
      now.getTime() - new Date(cached.loadedAt).getTime() < FARE_RULES_CACHE_MS;
    if (options.refresh || !fresh) {
      const outcome = await this.refresh(tenant, bookingId, "bookings.getFareRules", { fareRules: types });
      if (outcome.kind === "throttled" && cached === undefined) {
        throw new AppError("RATE_LIMITED", {
          message: "The fare rules were requested a moment ago: try again shortly.",
          details: { retryAfterSeconds: outcome.retryAfterSeconds },
        });
      }
      if ((outcome.kind === "skipped" || outcome.kind === "not_found") && cached === undefined) {
        // No order to read (pending, failed, cancelled, purged): the rules are unavailable.
        return await this.unavailableFareRules(bookingId, types, now);
      }
    }
    return await this.tx.run(async (trx) => {
      const { booking, details, minorUnits } = await this.readBooking(trx, bookingId);
      const stored = storedFareRulesOf(details.orderIncluded);
      if (stored === undefined) {
        return await this.unavailableFareRules(bookingId, types, now, trx);
      }
      return toBookingFareRules({
        booking,
        stored,
        offers: snapshotOffersOf(details.orderSnapshot),
        minorUnits,
      });
    });
  }

  /** Fare rules that cannot be loaded: no rule, the summary from the booked offers' amenities. */
  private async unavailableFareRules(
    bookingId: string,
    types: readonly FareRuleType[],
    now: Date,
    trx?: TenantTransaction,
  ): Promise<BookingFareRules> {
    const build = async (transaction: TenantTransaction): Promise<BookingFareRules> => {
      const { booking, details, minorUnits } = await this.readBooking(transaction, bookingId);
      const stored: StoredFareRules = { loadedAt: now.toISOString(), types: [...types], offers: [] };
      return toBookingFareRules({
        booking,
        stored,
        offers: snapshotOffersOf(details.orderSnapshot),
        minorUnits,
      });
    };
    return trx === undefined ? await this.tx.run(build) : await build(trx);
  }

  // ---- Shared ------------------------------------------------------------------------------------------------------

  /** The booking and what every answer reads with it. */
  private async readBooking(trx: TenantTransaction, bookingId: string) {
    const booking = await this.repository.booking(trx, bookingId);
    const details = await this.repository.bookingDetails(trx, bookingId);
    if (booking === undefined || details === undefined) {
      // The guard read it in this request: only a concurrent erasure gets here.
      throw new AppError("NOT_FOUND");
    }
    const children = await this.repository.children(trx, bookingId);
    const settingsRow = await this.repository.customerSettings(trx);
    const policy = (settingsRow?.ticketingPolicy ?? "issue_after_payment") as TicketingPolicy;
    const minorUnits = (await this.payments.currencyMinorUnits(trx, booking.currency)) ?? 2;
    return {
      booking,
      details,
      children,
      settings: { policy, features: featuresOf(settingsRow?.features) },
      minorUnits,
    };
  }

  /** The minor units of each currency of `codes` (2 for one the reference data does not know). */
  private async minorUnitsOf(trx: TenantTransaction, codes: readonly string[]): Promise<Map<string, number>> {
    const units = new Map<string, number>();
    for (const code of new Set(codes)) {
      units.set(code, (await this.payments.currencyMinorUnits(trx, code)) ?? 2);
    }
    return units;
  }

  /**
   * One Flight Order Management GET of the booking's order, throttled to one per `throttleMs` (60 s by default; see
   * the file header). Also console.bookings.get's refresh (10 s) and the resync after a timed-out change (none). The
   * claim, the read and the record are BookingSyncService's (FIX-W27-SYNC: the background sync's diff and events).
   */
  async refresh(
    tenant: RequestTenant,
    bookingId: string,
    operation: string,
    query: RefreshQuery,
    options: { readonly unlessFinal?: boolean; readonly throttleMs?: number } = {},
  ): Promise<RefreshOutcome> {
    return await this.sync.refresh({ id: tenant.tenantId, key: tenant.key }, bookingId, {
      operation,
      requestId: this.requestId(tenant),
      environment: tenant.environment,
      query,
      throttleMs: options.throttleMs ?? REFRESH_THROTTLE_MS,
      unlessFinal: options.unlessFinal,
      staffId: tenant.actor.type === "staff" ? tenant.actor.id : null,
    });
  }

  private requestId(tenant: RequestTenant): string {
    return this.tenants.requestId() ?? tenant.requestId;
  }
}
