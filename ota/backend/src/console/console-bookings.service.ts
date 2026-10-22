// The console bookings reads (OBE-061; ota/docs/flows/console-operations.md §2 "Bookings list and detail" and §3
// step 3, db README §10 "B4 Console", the document's consoleListBookings and consoleGetBooking): what OTA staff (or a
// `console:automation` key listing `bookings:read`) see of the OTA's bookings, in the environment of the request
// only. The permission guard checked `bookings:read` and the environment before this runs (OBE-060).
//
// - `list`: every booking of the environment (storefront, console and imported, customer and guest, failed ones
//   included) with the document's filters and the needs-attention filters, a sort, a keyset cursor and `totalCount`
//   (exact up to 10 000, `null` above). No Amadeus call.
// - `get`: one booking of the environment (another environment's or an unknown id → `404 NOT_FOUND`, the same answer)
//   in console scope (console-bookings.mapper.ts): the customer-shaped booking with every remark and the net order,
//   plus the console-only details. Traveller documents are opened (decrypted) only to build their masked display, in
//   memory, never logged. `refresh=true` first runs the customer refresh of the booking's order (one Flight Order
//   Management GET, CustomerBookingsService.refresh: claim, call without a transaction, record) with the console's
//   throttle of one per 10 s per booking (`supplierSync.status` `refreshed`, `throttled`, `order_not_found`); a booking
//   without an Amadeus order (pending, failed) or a cancelled one ignores it. Amadeus errors of a refresh are recorded
//   in `sync_error` and answered as the refresh answers them (`424`, `502`, `503`, `504`): staff retry without it.
//   The schedule-change diff and `booking.synced` of a full resync are the background sync's and console.bookings.resync's
//   (OBE-045, OBE-062).
//
// Neither read is audited (the document: "Read-only; not audited per call", "Viewing is not audited"): their handlers
// do not opt in with `@AuditedRead`, so the console audit interceptor writes a row only for a refused or failed call
// (OADR-0011 point 8 as decided on 2026-10-21; console/staff-actions.writer.ts).
import { Injectable } from "@nestjs/common";
import type { operations } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { allowedActionsOf } from "../bookings/allowed-actions";
import {
  fareConditionsOf,
  snapshotOffersOf,
  storedFareRulesOf,
  toBookingFareRules,
  toCustomerBooking,
  type FareRuleType,
} from "../bookings/bookings.mapper";
import { BookingsRepository } from "../bookings/bookings.repository";
import { CustomerBookingsService, ORDER_NOT_FOUND_WARNING } from "../bookings/customer-bookings.service";
import { BookingTravelerDocuments, type Warning } from "../bookings/order-recorder";
import type { TicketingPolicy } from "../bookings/order-request.builder";
import { roleHasPermission, type StaffPermission } from "../common/auth/roles";
import { StaffContext } from "../common/auth/staff.guard";
import { Clock } from "../common/clock";
import { PaymentsRepository } from "../payments/payments.repository";
import { toPayment } from "../payments/payments.service";
import { CallerContext } from "../tenancy/caller-resolver";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  bookingSyncStatusOf,
  consoleActionsOf,
  consoleListFingerprint,
  consoleOrderOf,
  consoleRemarksOf,
  CONSOLE_REFRESH_THROTTLE_MS,
  decodeConsoleCursor,
  encodeConsoleCursor,
  storedConsoleSyncStatusOf,
  toConsoleBooking,
  toConsoleBookingSummary,
  toSupplierSync,
  type ConsoleBooking,
  type ConsoleBookingPage,
  type ConsoleBookingSyncStatus,
} from "./console-bookings.mapper";
import {
  ConsoleBookingsRepository,
  DETAIL_LIMITS,
  foldName,
  STAFF_NOTE_EVENT,
  TOTAL_COUNT_LIMIT,
  type ConsoleBookingFilters,
  type ConsoleBookingSort,
} from "./console-bookings.repository";

export type ConsoleListBookingsQuery = NonNullable<operations["consoleListBookings"]["parameters"]["query"]>;

/** The default page size of the console lists (the document's `Limit`). */
export const DEFAULT_CONSOLE_PAGE_LIMIT = 20;

/** The default sort of console.bookings.list. */
const DEFAULT_SORT: ConsoleBookingSort = "-created";

/** The operation a refresh's Amadeus call is logged under (`supplier_requests.operation`). */
const GET_OPERATION = "console.bookings.get";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The storefront switches the customer-shaped allowed actions read (as customer-bookings.service.ts reads them). */
function featuresOf(value: unknown): {
  readonly selfServiceCancellation: boolean;
  readonly ancillaries: boolean;
} {
  const features = isRecord(value) ? value : {};
  return {
    selfServiceCancellation: features["selfServiceCancellation"] === true,
    ancillaries: features["ancillaries"] !== false,
  };
}

/** The filters of a validated console.bookings.list query (the traveller name folded as the repository compares it). */
export function filtersOf(query: ConsoleListBookingsQuery): ConsoleBookingFilters {
  return {
    status: query.status,
    ticketingStatus: query.ticketingStatus,
    ticketingDeadlineBefore: query.ticketingDeadlineBefore,
    recordLocator: query.recordLocator,
    reference: query.reference,
    customerId: query.customerId,
    customerEmail: query.customerEmail,
    travelerLastName: query.travelerLastName === undefined ? undefined : foldName(query.travelerLastName),
    departureFrom: query.departureFrom,
    departureTo: query.departureTo,
    createdFrom: query.createdFrom,
    createdTo: query.createdTo,
    paymentStatus: query.paymentStatus,
    source: query.source,
    validatingCarrier: query.validatingCarrier,
    createdByStaffId: query.createdByStaffId,
    tag: query.tag,
    reconcileOutcome: query.reconcileOutcome,
    cancellationRequested: query.cancellationRequested,
    hasScheduleChange: query.hasScheduleChange,
    q: query.q,
  };
}

/** What `get` takes besides the booking id. */
export interface ConsoleGetBookingOptions {
  readonly refresh: boolean;
  readonly include?: "bags"[] | undefined;
  readonly fareRules?: FareRuleType[] | undefined;
}

@Injectable()
export class ConsoleBookingsService {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: ConsoleBookingsRepository,
    private readonly bookings: BookingsRepository,
    private readonly payments: PaymentsRepository,
    private readonly travelerDocuments: BookingTravelerDocuments,
    private readonly customerBookings: CustomerBookingsService,
    private readonly tenants: TenantContext,
    private readonly staff: StaffContext,
    private readonly callers: CallerContext,
    private readonly clock: Clock,
  ) {}

  // ---- console.bookings.list ---------------------------------------------------------------------------------------

  /** One page of the OTA's bookings in the request's environment (see the file header). */
  async list(query: ConsoleListBookingsQuery): Promise<ConsoleBookingPage> {
    const tenant = this.tenants.require();
    const sort: ConsoleBookingSort = query.sort ?? DEFAULT_SORT;
    const limit = query.limit ?? DEFAULT_CONSOLE_PAGE_LIMIT;
    const filters = filtersOf(query);
    const fingerprint = consoleListFingerprint(tenant.environment, sort, filters);
    const after =
      query.cursor === undefined ? undefined : decodeConsoleCursor(query.cursor, fingerprint, sort);
    const now = this.clock.now();
    return await this.tx.run(async (trx) => {
      const rows = await this.repository.list(trx, {
        ...filters,
        environment: tenant.environment,
        sort,
        after,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const count = await this.repository.count(trx, tenant.environment, filters);
      const units = await this.minorUnitsOf(
        trx,
        page.map((row) => row.currency),
      );
      return {
        data: page.map((row) => toConsoleBookingSummary(row, units.get(row.currency) ?? 2, now)),
        page: {
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeConsoleCursor(fingerprint, last.sortKey, last.id)
              : null,
          limit,
        },
        totalCount: count > TOTAL_COUNT_LIMIT ? null : count,
      };
    });
  }

  // ---- console.bookings.get ----------------------------------------------------------------------------------------

  /** One booking of the request's environment in console scope, after a refresh when asked (see the file header). */
  async get(bookingId: string, options: ConsoleGetBookingOptions): Promise<ConsoleBooking> {
    const tenant = this.tenants.require();
    const environment = await this.tx.run((trx) => this.repository.environmentOf(trx, bookingId));
    if (environment !== tenant.environment) {
      // Unknown, or of the other environment: the same answer, and no Amadeus call.
      throw new AppError("NOT_FOUND");
    }
    let refreshed: ConsoleBookingSyncStatus | undefined;
    let warnings: readonly Warning[] = [];
    if (options.refresh) {
      const outcome = await this.customerBookings.refresh(
        tenant,
        bookingId,
        GET_OPERATION,
        { include: options.include, fareRules: options.fareRules },
        { throttleMs: CONSOLE_REFRESH_THROTTLE_MS },
      );
      if (outcome.kind === "refreshed") {
        refreshed = "refreshed";
        warnings = outcome.warnings;
      } else if (outcome.kind === "throttled") {
        refreshed = "throttled";
      } else if (outcome.kind === "not_found") {
        refreshed = "order_not_found";
        warnings = [ORDER_NOT_FOUND_WARNING];
      }
    }
    return await this.tx.run((trx) => this.read(trx, bookingId, options, refreshed, warnings));
  }

  /** The console view of the booking, read in one transaction. */
  private async read(
    trx: TenantTransaction,
    bookingId: string,
    options: ConsoleGetBookingOptions,
    refreshed: ConsoleBookingSyncStatus | undefined,
    warnings: readonly Warning[],
  ): Promise<ConsoleBooking> {
    const tenant = this.tenants.require();
    const now = this.clock.now();
    const booking = await this.bookings.booking(trx, bookingId);
    const stored = await this.bookings.bookingDetails(trx, bookingId);
    const details = await this.repository.details(trx, bookingId);
    if (booking === undefined || stored === undefined || details === undefined) {
      // Read moments ago: only a concurrent erasure gets here.
      throw new AppError("NOT_FOUND");
    }
    const children = await this.bookings.children(trx, bookingId);
    const settingsRow = await this.bookings.customerSettings(trx);
    const policy = (settingsRow?.ticketingPolicy ?? "issue_after_payment") as TicketingPolicy;
    const minorUnits = (await this.payments.currencyMinorUnits(trx, booking.currency)) ?? 2;
    const travelers = [];
    for (const row of children.travelers) {
      // Decrypted in memory for the masked display only (readableDocument): never logged, never answered in full.
      const opened = await this.travelerDocuments.open(tenant.schemaName, row);
      travelers.push({ row, documents: opened.documents, discounts: opened.discounts });
    }
    const payments = [];
    for (const id of await this.bookings.paymentIdsOf(trx, bookingId)) {
      const row = await this.payments.payment(trx, id);
      if (row !== undefined) {
        payments.push(toPayment(row, { minorUnits, clientSecret: null, publishableKey: null }));
      }
    }
    const documents = await this.bookings.currentDocuments(trx, bookingId);
    const offers = snapshotOffersOf(stored.orderSnapshot);
    const storedRules = storedFareRulesOf(stored.orderIncluded);
    const wantsFareRules = options.fareRules !== undefined && options.fareRules.length > 0;
    const syncStatus =
      refreshed ??
      storedConsoleSyncStatusOf({
        status: booking.status,
        amadeusOrderId: booking.amadeusOrderId,
        lastSyncedAt: booking.lastSyncedAt,
        syncError: stored.syncError,
        now,
      });
    const base = toCustomerBooking({
      booking,
      children,
      travelers,
      payments,
      policy,
      minorUnits,
      now,
      allowedActions: allowedActionsOf({
        status: booking.status,
        ticketingStatus: booking.ticketingStatus,
        amadeusOrderId: booking.amadeusOrderId,
        lastArrivalAt: booking.lastArrivalAt,
        segments: children.segments,
        documentsReady: documents.some((document) => document.status === "ready"),
        features: featuresOf(settingsRow?.features),
        lastRefreshAt: stored.lastRefreshAt,
        now,
      }),
      ancillaries: await this.bookings.ancillaries(trx, bookingId),
      refunds: await this.bookings.refundsOf(trx, bookingId),
      documents,
      cancelledBy: stored.cancelledBy,
      amadeus: consoleOrderOf(stored.orderSnapshot, stored.orderDictionaries),
      fareConditions:
        offers.length === 0 ? null : fareConditionsOf(storedRules?.offers ?? [], offers, booking.currency),
      fareRules:
        wantsFareRules && storedRules !== undefined
          ? toBookingFareRules({ booking, stored: storedRules, offers, minorUnits })
          : null,
      syncStatus: bookingSyncStatusOf(syncStatus),
      warnings,
    });
    return toConsoleBooking(
      // Every remark, the staff and system ones included.
      { ...base, remarks: consoleRemarksOf(children.remarks) },
      {
        booking,
        details,
        minorUnits,
        supplierSync: toSupplierSync({
          status: syncStatus,
          lastSyncedAt: booking.lastSyncedAt,
          lastAttemptAt: stored.lastRefreshAt,
          syncError: stored.syncError,
          lastSupplierRequestId: await this.repository.lastOrderRead(trx, bookingId),
        }),
        events: await this.repository.events(trx, bookingId, { limit: DETAIL_LIMITS.events }),
        notes: await this.repository.events(trx, bookingId, {
          limit: DETAIL_LIMITS.notes,
          types: [STAFF_NOTE_EVENT],
        }),
        supplierRequests: await this.repository.supplierRequests(
          trx,
          bookingId,
          DETAIL_LIMITS.supplierRequests,
        ),
        staffActions: await this.repository.staffActions(trx, bookingId, DETAIL_LIMITS.staffActions),
        consoleActions: consoleActionsOf({
          status: booking.status,
          ticketingStatus: booking.ticketingStatus,
          amadeusOrderId: booking.amadeusOrderId,
          ticketingDeadlineAt: booking.ticketingDeadlineAt,
          lastArrivalAt: booking.lastArrivalAt,
          segments: children.segments,
          lastRefreshAt: stored.lastRefreshAt,
          now,
          can: (permission) => this.can(permission),
        }),
      },
    );
  }

  /** Whether the caller holds `permission`: the signed-in staff member's role, else a key-only call's own scopes. */
  private can(permission: StaffPermission): boolean {
    const role = this.staff.get()?.member.role;
    if (role !== undefined) {
      return roleHasPermission(role, permission);
    }
    const caller = this.callers.get();
    return caller?.type === "key" && caller.scopes.includes(permission);
  }

  /** The minor units of each currency of `codes` (2 for one the reference data does not know). */
  private async minorUnitsOf(trx: TenantTransaction, codes: readonly string[]): Promise<Map<string, number>> {
    const units = new Map<string, number>();
    for (const code of new Set(codes)) {
      units.set(code, (await this.payments.currencyMinorUnits(trx, code)) ?? 2);
    }
    return units;
  }
}
