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
//   supplier diagnostics and refresh claims are console-only), newest first.
//
// **Refresh** (`refresh=true`, and getFareRules without fresh fare rules): one Flight Order Management GET per booking
// and minute at most, shared by the three operations. The claim (T1) locks the booking, refuses one refreshed or synced
// less than 60 s ago (`syncStatus: throttled`; getFareRules answers from its cache, or `429 RATE_LIMITED` with
// `Retry-After` when it has none), skips a booking without an Amadeus order (pending, failed) or a cancelled one, and
// appends the staff-only `booking.sync_requested` event, the throttle's record: a second claim waits for the lock and
// sees it (it reads the booking in a statement after the lock). The call runs without a transaction (OADR-0003 point
// 1). The record (T2) writes nothing when the booking's `version` moved since the claim (another writer recorded it
// while the order was read; the answer shows the stored booking). Otherwise it writes what the order says:
// `order_snapshot` after the shared redactor, `order_dictionaries`, the tickets (new ones inserted, changed statuses
// recorded; event `booking.ticketed` for new ones), the segments' Amadeus status and `isFlown`, the associated records
// the booking does not have yet, a booking that is now fully or partly ticketed (`ticketed`/`partially_ticketed`,
// `issued`/`partially_issued`, `issued_at`, event `booking.ticketed`), `order_included` (bag options with
// `include=bags`, fare rules with `fareRules`), `last_synced_at`, and clears `sync_error`. The `version` (and so the
// ETag) moves whenever the record stores new or changed tickets or a new status (lead decision (6a) of 2026-10-22):
// the documents queue deduplicates its jobs by the version, so the itinerary asked for by the `booking.ticketed` of a
// new ticket is rendered again with it; a refresh that stores nothing else keeps the version and the ETag (before
// FIX-W26-BOOKINGS only a new status moved it). Schedule changes and cancellations by the airline
// are the background sync's (OBE-045, order-diff.ts): a refresh does not compare segment times. Amadeus `404` (an order
// purged after travel) keeps the stored data with a warning; other Amadeus errors are recorded in `sync_error` and
// answered `502/503/504` (an error code the operation does not document becomes `502 SUPPLIER_ERROR`).
//
// console.bookings.get with `refresh=true` (OBE-061, console/console-bookings.service.ts) runs the same refresh
// (`refresh`) with the console's throttle of 10 s (`throttleMs`); a staff member's call names them in its
// `supplier_requests` row (`staff_id`).
import { Injectable } from "@nestjs/common";
import type { operations } from "@velexis/api-types";
import { AppError, isAppError, type OtaErrorCode } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { BookingAccessContext } from "../common/auth/booking-access.guard";
import { CustomerContext } from "../common/auth/customer.guard";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { PaymentsRepository } from "../payments/payments.repository";
import { toPayment } from "../payments/payments.service";
import { warningsOf } from "../shopping/priced-offers.mapper";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { allowedActionsOf, REFRESH_THROTTLE_MS } from "./allowed-actions";
import {
  customerOrderOf,
  customerTicketsOf,
  decodeListCursor,
  FARE_RULE_TYPES,
  FARE_RULES_CACHE_MS,
  fareConditionsOf,
  listFingerprint,
  offerFareRulesOf,
  orderRecordsOf,
  pageOf,
  snapshotOffersOf,
  storedFareRulesOf,
  storedSyncStatusOf,
  ticketingFinal,
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
import {
  BookingsRepository,
  REFRESH_CLAIM_EVENT,
  type BookingChildren,
  type BookingListSort,
  type BookingRow,
  type BookingTimeframe,
} from "./bookings.repository";
import {
  BookingTravelerDocuments,
  eventActorOf,
  OrderRecorder,
  ticketCoverage,
  ticketsOf,
  type Booking,
  type OrderTicket,
  type Warning,
} from "./order-recorder";
import type { TicketingPolicy } from "./order-request.builder";

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

/** The Amadeus error codes the booking reads document; any other becomes `502 SUPPLIER_ERROR`. */
const DOCUMENTED_SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  "SUPPLIER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "SUPPLIER_ERROR",
  "SERVICE_UNAVAILABLE",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
]);

/** The warning of a refresh that found no order at Amadeus (purged after travel): the stored data is shown. */
export const ORDER_NOT_FOUND_WARNING: Warning = Object.freeze({
  title: "ORDER NOT FOUND AT THE AIRLINE",
  detail: "The airline no longer returns this order; the booking as last synchronised is shown.",
});

/** `sync_error` of a refresh whose order Amadeus no longer has (also the console's `order_not_found`). */
export const ORDER_NOT_FOUND = "ORDER_NOT_FOUND";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The Amadeus query of a refresh. */
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
    private readonly recorder: OrderRecorder,
    private readonly amadeus: AmadeusClient,
    private readonly tenants: TenantContext,
    private readonly customers: CustomerContext,
    private readonly access: BookingAccessContext,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
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
          now,
        }),
        ancillaries: await this.repository.ancillaries(trx, bookingId),
        refunds: await this.repository.refundsOf(trx, bookingId),
        documents,
        cancelledBy: details.cancelledBy,
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
   * the file header). Also console.bookings.get's refresh (10 s).
   */
  async refresh(
    tenant: RequestTenant,
    bookingId: string,
    operation: string,
    query: RefreshQuery,
    options: { readonly unlessFinal?: boolean; readonly throttleMs?: number } = {},
  ): Promise<RefreshOutcome> {
    const throttleMs = options.throttleMs ?? REFRESH_THROTTLE_MS;
    const claim = await this.tx.run(async (trx) => {
      const row = await this.repository.lockForRefresh(trx, bookingId);
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
      if (options.unlessFinal === true) {
        const booking = await this.repository.booking(trx, bookingId);
        if (booking !== undefined && ticketingFinal(booking.status, booking.ticketingStatus)) {
          return { kind: "skipped" } as const;
        }
      }
      if (row.lastRefreshAt !== null && now.getTime() - row.lastRefreshAt.getTime() < throttleMs) {
        const left = throttleMs - (now.getTime() - row.lastRefreshAt.getTime());
        return { kind: "throttled", retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)) } as const;
      }
      await this.recorder.event(trx, bookingId, {
        type: REFRESH_CLAIM_EVENT,
        actor: eventActorOf(tenant.actor),
        summary: "Synchronisation with the airline requested.",
        data: { operation },
        visibleToCustomer: false,
        requestId: this.requestId(tenant),
        now,
      });
      return {
        kind: "claimed",
        orderId: row.amadeusOrderId,
        office: row.ownerOfficeId,
        version: row.version,
      } as const;
    });
    if (claim.kind !== "claimed") {
      return claim;
    }
    let body: unknown;
    try {
      const reply = await this.amadeus.getFlightOrder(
        this.callContext(tenant, bookingId, operation, claim.office),
        {
          flightOrderId: claim.orderId,
          query: {
            ...(query.include !== undefined && query.include.length > 0
              ? { include: [...query.include] }
              : {}),
            ...(query.fareRules !== undefined && query.fareRules.length > 0
              ? { fareRules: [...query.fareRules] }
              : {}),
          },
        },
      );
      body = reply.body;
    } catch (error) {
      if (isAppError(error) && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404) {
        await this.recordSyncError(bookingId, ORDER_NOT_FOUND);
        this.logger.warn({ bookingId }, "bookings.refresh_order_not_found");
        return { kind: "not_found" };
      }
      if (isAppError(error)) {
        await this.recordSyncError(bookingId, error.code);
        if (!DOCUMENTED_SUPPLIER_CODES.has(error.code)) {
          throw new AppError("SUPPLIER_ERROR", {
            ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
            cause: error,
          });
        }
      }
      throw error;
    }
    const data = isRecord(body) && isRecord(body["data"]) ? body["data"] : undefined;
    if (data === undefined) {
      await this.recordSyncError(bookingId, "SUPPLIER_ERROR");
      throw new AppError("SUPPLIER_ERROR");
    }
    const applied = await this.tx.run((trx) =>
      this.applyOrder(trx, tenant, bookingId, claim.version, {
        data,
        dictionaries: isRecord(body) ? body["dictionaries"] : undefined,
        included: isRecord(body) ? body["included"] : undefined,
        query,
      }),
    );
    if (!applied) {
      this.logger.info({ bookingId }, "bookings.refresh_superseded");
      return { kind: "superseded" };
    }
    return { kind: "refreshed", warnings: warningsOf(isRecord(body) ? body["warnings"] : undefined) };
  }

  /**
   * The record step of a refresh (T2; see the file header). Writes nothing and answers false when the booking's
   * `version` moved since the claim: another writer (the ticketing job, a change) recorded the booking while the order
   * was read, and an order read before that write must not overwrite it.
   */
  private async applyOrder(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    claimedVersion: number,
    order: {
      readonly data: Record<string, unknown>;
      readonly dictionaries: unknown;
      readonly included: unknown;
      readonly query: RefreshQuery;
    },
  ): Promise<boolean> {
    const now = this.clock.now();
    const booking = await this.repository.booking(trx, bookingId, true);
    const details = await this.repository.bookingDetails(trx, bookingId);
    if (booking === undefined || details === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (booking.version !== claimedVersion) {
      return false;
    }
    const children = await this.repository.children(trx, bookingId);
    const tickets = ticketsOf(order.data);
    await this.applyTickets(trx, booking, children, tickets, now);
    await this.applySegments(trx, children, order.data, now);
    await this.applyAssociatedRecords(trx, booking, children, order.data, now);
    const stored = new Map(children.tickets.map((row) => [row.documentNumber, row]));
    const all: OrderTicket[] = [
      ...children.tickets
        .filter((row) => !tickets.some((ticket) => ticket.documentNumber === row.documentNumber))
        .map((row) => ({
          documentType: row.documentType,
          documentNumber: row.documentNumber,
          documentStatus: row.status,
          travelerId: row.amadeusTravelerId,
          segmentIds: row.segmentIds,
          raw: {},
        })),
      ...tickets,
    ];
    const coverage = ticketCoverage(
      children.travelers.map((row) => row.amadeusTravelerId),
      all,
    );
    const upgrade =
      (coverage === "full" && (booking.status === "confirmed" || booking.status === "partially_ticketed")) ||
      (coverage === "partial" && booking.status === "confirmed");
    const added = tickets.filter((ticket) => !stored.has(ticket.documentNumber));
    const changed = tickets.filter((ticket) => {
      const row = stored.get(ticket.documentNumber);
      return row !== undefined && row.status !== ticket.documentStatus;
    });
    // The documents follow the booking's version (their jobs are deduplicated by it, documents.processor.ts): a record
    // that stores a change they show, new or changed tickets or a new status, moves it, and with it the ETag (lead
    // decision (6a) of 2026-10-22); one that only brings the snapshot, the segments' state, the associated records or
    // `order_included` up to date keeps both.
    const moved = upgrade || added.length > 0 || changed.length > 0;
    const included = isRecord(details.orderIncluded) ? { ...details.orderIncluded } : {};
    if (order.query.include !== undefined && order.query.include.length > 0 && isRecord(order.included)) {
      included["bags"] = order.included["bags"] ?? {};
      included["bagsLoadedAt"] = now.toISOString();
    }
    if (order.query.fareRules !== undefined && order.query.fareRules.length > 0) {
      const fareRules: StoredFareRules = {
        loadedAt: now.toISOString(),
        types: [...order.query.fareRules],
        offers: offerFareRulesOf(order.data),
      };
      included["fareRules"] = fareRules;
    }
    await this.repository.updateSynced(
      trx,
      bookingId,
      {
        order_snapshot: JSON.stringify(redactPayload(order.data)),
        ...(order.dictionaries === undefined
          ? {}
          : { order_dictionaries: JSON.stringify(order.dictionaries) }),
        order_included: JSON.stringify(redactPayload(included)),
        last_synced_at: now,
        sync_error: null,
        updated_at: now,
        ...(upgrade
          ? {
              status: coverage === "full" ? "ticketed" : "partially_ticketed",
              ticketing_status: coverage === "full" ? "issued" : "partially_issued",
              issued_at: booking.issuedAt ?? now,
              ticketing_next_attempt_at: null,
              ticketing_error_code: null,
              ticketing_error: null,
            }
          : {}),
      },
      moved,
    );
    if (upgrade || added.length > 0) {
      await this.recorder.event(trx, bookingId, {
        type: "booking.ticketed",
        actor: { type: "supplier", id: null },
        statusFrom: booking.status,
        statusTo: upgrade ? (coverage === "full" ? "ticketed" : "partially_ticketed") : booking.status,
        summary: "E-tickets issued.",
        data: { tickets: added.map((ticket) => ticket.documentNumber) },
        visibleToCustomer: true,
        requestId: this.requestId(tenant),
        now,
      });
    }
    return true;
  }

  /** New tickets inserted, changed statuses of known ones recorded. */
  private async applyTickets(
    trx: TenantTransaction,
    booking: BookingRow,
    children: BookingChildren,
    tickets: readonly OrderTicket[],
    now: Date,
  ): Promise<void> {
    const known = new Map(children.tickets.map((row) => [row.documentNumber, row]));
    for (const ticket of tickets) {
      const row = known.get(ticket.documentNumber);
      if (row !== undefined && row.status !== ticket.documentStatus) {
        await this.repository.updateTicketStatus(trx, row.id, { status: ticket.documentStatus, now });
      }
    }
    const added = tickets.filter((ticket) => !known.has(ticket.documentNumber));
    if (added.length > 0) {
      const travelerRowIds = new Map(children.travelers.map((row) => [row.amadeusTravelerId, row.id]));
      await this.repository.insertTickets(
        trx,
        this.recorder
          .ticketRows(booking.id, { tickets: added, offers: [] }, travelerRowIds, now)
          .map((row) => ({
            ...row,
            validating_carrier: booking.validatingCarrier,
          })),
      );
    }
  }

  /** The Amadeus `bookingStatus` and `isFlown` of each known segment of the order. */
  private async applySegments(
    trx: TenantTransaction,
    children: BookingChildren,
    data: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const statuses = new Set(["CONFIRMED", "WAITLISTED", "CANCELLED", "PENDING", "DENIED"]);
    const offers = Array.isArray(data["flightOffers"]) ? data["flightOffers"].filter(isRecord) : [];
    for (const offer of offers) {
      const offerId = typeof offer["id"] === "string" ? offer["id"] : "1";
      const itineraries = Array.isArray(offer["itineraries"]) ? offer["itineraries"].filter(isRecord) : [];
      for (const segment of itineraries.flatMap((itinerary) =>
        Array.isArray(itinerary["segments"]) ? itinerary["segments"].filter(isRecord) : [],
      )) {
        const row = children.segments.find(
          (candidate) =>
            candidate.amadeusFlightOfferId === offerId && candidate.amadeusSegmentId === segment["id"],
        );
        if (row === undefined) {
          continue;
        }
        const status =
          typeof segment["bookingStatus"] === "string" && statuses.has(segment["bookingStatus"])
            ? segment["bookingStatus"]
            : row.status;
        const isFlown = typeof segment["isFlown"] === "boolean" ? segment["isFlown"] : row.isFlown;
        if (status !== row.status || isFlown !== row.isFlown) {
          await this.repository.updateSegmentState(trx, row.id, { status, isFlown, now });
        }
      }
    }
  }

  /** The order's associated records the booking does not have yet (an airline locator that appeared after booking). */
  private async applyAssociatedRecords(
    trx: TenantTransaction,
    booking: BookingRow,
    children: BookingChildren,
    data: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const key = (record: { readonly reference: string; readonly originSystemCode: string }) =>
      `${record.reference}|${record.originSystemCode}`;
    const known = new Set(children.associatedRecords.map(key));
    const hasPrimary = children.associatedRecords.some((record) => record.isPrimary);
    const added = orderRecordsOf(data).filter((record) => !known.has(key(record)));
    await this.repository.insertAssociatedRecords(
      trx,
      added.map((record) => ({
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

  /** Records a failed refresh in `sync_error` (Booking.syncStatus `failed`), in a short transaction of its own. */
  private async recordSyncError(bookingId: string, code: string): Promise<void> {
    await this.tx.run((trx) =>
      this.repository.updateSynced(trx, bookingId, { sync_error: code, updated_at: this.clock.now() }, false),
    );
  }

  private callContext(
    tenant: RequestTenant,
    bookingId: string,
    operation: string,
    office: string | null,
  ): AmadeusCallContext {
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation,
      requestId: this.requestId(tenant),
      bookingId,
      ...(tenant.actor.type === "staff" && tenant.actor.id !== null ? { staffId: tenant.actor.id } : {}),
      ...(office === null ? {} : { orderOffice: office }),
    };
  }

  private requestId(tenant: RequestTenant): string {
    return this.tenants.requestId() ?? tenant.requestId;
  }
}
