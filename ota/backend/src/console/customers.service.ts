// The console customers (OBE-066; ota/docs/flows/console-operations.md §2 "Customers" and §3 step 7, OADR-0011 point 8
// as decided on 2026-10-21, db README §7 and §10 "B4 Console", the document's consoleListCustomers and
// consoleGetCustomer): what OTA staff (or a `console:automation` key listing `customers:read`) see of the OTA's
// customer accounts. The permission guard checked `customers:read` (every role) and the environment before this runs
// (OBE-060). No Amadeus call. Accounts are shared by test and live; their booking statistics and bookings are the
// request's environment's (customers.repository.ts).
//
// - `list`: one page of accounts (ConsoleCustomerSummary) with the document's filters (`status` defaults to `active`
//   and `disabled`: deleted accounts only when asked for), sorts and an opaque keyset cursor bound to the environment,
//   the filters and the sort (`400 VALIDATION_FAILED` at `/query/cursor` otherwise, also for a `name` cursor whose
//   customer no longer exists). Not audited: the customer search returns no personal data of one person.
// - `get`: one account (`404 NOT_FOUND` for an unknown id) as account.get shows it to the customer (identity
//   customers.mapper.ts `toCustomer`), with its statistics, its 10 most recent bookings of the environment as
//   console.bookings.list shows them (sort `-created`, the failed ones included; console-bookings.repository.ts), and
//   how many saved travellers and live sessions it has (saved-traveller documents are never read). Viewing a customer
//   is an audited read (the document: "GDPR access log"): its handler opts in with `@AuditedRead`, and the console
//   audit interceptor writes the `succeeded` row `customer.view` with the customer as its target (OADR-0011 point 8,
//   whose action name the flow and the writer use).
//
// Deleted accounts (account.delete; db README §7): the row keeps the names, phone and date of birth until the erasure
// job (OBE-087), but staff see the account as the contract allows: `status: deleted`, its `…@deleted.invalid`
// placeholder address, no name (`null` in ConsoleCustomerSummary and in the bookings' ConsoleCustomerRef, "null for
// deleted accounts"; the empty string in `Customer`, whose names are required strings), no phone, no date of birth and
// no pending address. Its statistics and bookings stay: the bookings are records the deletion keeps
// (account.mapper.ts `RETAINED_BOOKING_RECORDS`).
//
// The answers carry no password hash, identity, token or saved-traveller document; `Cache-Control: private, no-store`.
import { Injectable } from "@nestjs/common";
import type { components, operations } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { listFingerprint } from "../bookings/bookings.mapper";
import { Clock } from "../common/clock";
import { toCustomer } from "../identity/customers.mapper";
import type { CustomerRecord } from "../identity/customers.repository";
import { PaymentsRepository } from "../payments/payments.repository";
import { Money } from "../pricing/pricing.types";
import { invalidCursor } from "../reference/reference.mapper";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  toConsoleBookingSummary,
  withoutDeletedName as withoutDeletedRefName,
} from "./console-bookings.mapper";
import { ConsoleBookingsRepository } from "./console-bookings.repository";
import { DEFAULT_CONSOLE_PAGE_LIMIT } from "./console-bookings.service";
import {
  ConsoleCustomersRepository,
  type ConsoleCustomerFilters,
  type ConsoleCustomerListRow,
  type ConsoleCustomerSort,
  type ConsoleCustomerStatus,
  type CustomerPosition,
  type CustomerStatsRow,
} from "./customers.repository";

type Schemas = components["schemas"];
type MoneyAmount = Schemas["Money"];
type Customer = Schemas["Customer"];
export type ConsoleCustomerSummary = Schemas["ConsoleCustomerSummary"];
export type ConsoleCustomerPage = Schemas["ConsoleCustomerPage"];
export type ConsoleCustomer = Schemas["ConsoleCustomer"];
export type ConsoleCustomerStats = Schemas["ConsoleCustomerStats"];
type ConsoleBookingSummary = Schemas["ConsoleBookingSummary"];
export type ConsoleListCustomersQuery = NonNullable<
  operations["consoleListCustomers"]["parameters"]["query"]
>;

/** `Cache-Control` of console.customers.list and get (personal data, never cached). */
export const CONSOLE_CUSTOMER_CACHE_CONTROL = "private, no-store";

/** The `staff_actions.action` of viewing a customer (OADR-0011 point 8). */
export const CUSTOMER_VIEW_ACTION = "customer.view";

/** The statuses listed when the request names none (the document: "default active,disabled"). */
export const DEFAULT_CUSTOMER_STATUSES: readonly ConsoleCustomerStatus[] = Object.freeze([
  "active",
  "disabled",
]);

/** The default sort of console.customers.list. */
const DEFAULT_SORT: ConsoleCustomerSort = "-created";

/** How many bookings console.customers.get shows (ConsoleCustomer.recentBookings, `maxItems`). */
export const RECENT_BOOKINGS_LIMIT = 10;

const money = (amount: string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

const optionalMoney = (amount: string | null, currency: string, minorUnits: number): MoneyAmount | null =>
  amount === null ? null : money(amount, currency, minorUnits);

// ---- Cursors -------------------------------------------------------------------------------------------------------

const CURSOR_VERSION = 1;
const INSTANT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const AMOUNT_KEY = /^-?\d{1,16}\.\d{2}$/;
const CUSTOMER_ID = /^cus_[0-9A-Za-z]{12,40}$/;
const MAX_CURSOR_LENGTH = 400;

/** The filters of a validated console.customers.list query, the default statuses applied. */
export function customerFiltersOf(query: ConsoleListCustomersQuery): ConsoleCustomerFilters {
  return {
    q: query.q,
    email: query.email,
    status:
      query.status === undefined || query.status.length === 0 ? DEFAULT_CUSTOMER_STATUSES : query.status,
    emailVerified: query.emailVerified,
    hasBookings: query.hasBookings,
    createdFrom: query.createdFrom,
    createdTo: query.createdTo,
  };
}

/** The fingerprint of a console customers list: the environment, every filter and the sort. */
export function consoleCustomersFingerprint(
  environment: string,
  sort: ConsoleCustomerSort,
  filters: ConsoleCustomerFilters,
): string {
  const instant = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : new Date(value).toISOString();
  const flag = (value: boolean | undefined): string | undefined =>
    value === undefined ? undefined : String(value);
  return listFingerprint({
    list: "console.customers",
    environment,
    sort,
    q: filters.q,
    email: filters.email?.toLowerCase(),
    status: [...filters.status].sort().join(","),
    emailVerified: flag(filters.emailVerified),
    hasBookings: flag(filters.hasBookings),
    createdFrom: instant(filters.createdFrom),
    createdTo: instant(filters.createdTo),
  });
}

/** The opaque cursor after the row with this sort key and id (see customers.repository.ts). */
export function encodeCustomerCursor(fingerprint: string, key: string | null, id: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, fingerprint, key, id])).toString("base64url");
}

/** Whether `key` is a sort key `sort` writes (customers.repository.ts). */
function validKey(sort: ConsoleCustomerSort, key: unknown): key is string | null {
  switch (sort) {
    case "created":
    case "-created":
      return typeof key === "string" && INSTANT_KEY.test(key);
    case "-lastBooking":
      return key === null || (typeof key === "string" && INSTANT_KEY.test(key));
    case "-totalSpent":
      return typeof key === "string" && AMOUNT_KEY.test(key);
    case "name":
      return key === null;
  }
}

/**
 * The keyset position of `value` for the list of `fingerprint` sorted by `sort`; `400 VALIDATION_FAILED`
 * (`/query/cursor`) for a value this API did not write or a cursor of other filters.
 */
export function decodeCustomerCursor(
  value: string,
  fingerprint: string,
  sort: ConsoleCustomerSort,
): CustomerPosition {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw invalidCursor();
  }
  const [version, print, key, id] = parsed as unknown[];
  if (
    version !== CURSOR_VERSION ||
    print !== fingerprint ||
    !validKey(sort, key) ||
    typeof id !== "string" ||
    !CUSTOMER_ID.test(id)
  ) {
    throw invalidCursor();
  }
  return { key, id };
}

// ---- The answers ---------------------------------------------------------------------------------------------------

/** The console status of a stored one (`pending_verification` is `active`; see customers.repository.ts). */
export function consoleStatusOf(stored: string): ConsoleCustomerStatus {
  if (stored === "active" || stored === "pending_verification") {
    return "active";
  }
  if (stored === "disabled" || stored === "deleted") {
    return stored;
  }
  // The CHECK of `customers.status` rules this out; a new status needs a contract change first.
  throw new TypeError(`a customer has a status the contract does not know: ${stored}`);
}

/** A row of console.customers.list (a deleted account without its name and phone; see the file header). */
export function toConsoleCustomerSummary(
  row: ConsoleCustomerListRow,
  currency: string,
  minorUnits: number,
): ConsoleCustomerSummary {
  const deleted = row.status === "deleted";
  return {
    id: row.id,
    email: row.email,
    firstName: deleted ? null : row.firstName,
    lastName: deleted ? null : row.lastName,
    status: consoleStatusOf(row.status),
    emailVerified: row.emailVerifiedAt !== null,
    phone:
      deleted || row.phoneCountryCode === null || row.phoneNumber === null
        ? null
        : { countryCallingCode: row.phoneCountryCode, number: row.phoneNumber },
    bookingsCount: row.bookingsCount,
    upcomingBookingsCount: row.upcomingBookingsCount,
    totalSpent: optionalMoney(row.totalSpent, currency, minorUnits),
    lastBookingAt: row.lastBookingAt?.toISOString() ?? null,
    lastSignInAt: row.lastSignInAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The account of console.customers.get: the document's `Customer` as account.get shows it, a deleted account without
 * its names, phone, date of birth and pending address (see the file header).
 */
export function toConsoleCustomerAccount(row: CustomerRecord): Customer {
  const customer = toCustomer(row);
  if (row.status !== "deleted") {
    return customer;
  }
  return { ...customer, firstName: "", lastName: "", phone: null, dateOfBirth: null, pendingEmail: null };
}

/** The statistics of console.customers.get. */
export function toConsoleCustomerStats(
  stats: CustomerStatsRow,
  currency: string,
  minorUnits: number,
): ConsoleCustomerStats {
  return {
    bookingsCount: stats.bookingsCount,
    upcomingBookingsCount: stats.upcomingBookingsCount,
    cancelledBookingsCount: stats.cancelledBookingsCount,
    totalSpent: optionalMoney(stats.totalSpent, currency, minorUnits),
    totalRefunded: optionalMoney(stats.totalRefunded, currency, minorUnits),
    lastBookingAt: stats.lastBookingAt?.toISOString() ?? null,
  };
}

/**
 * A booking of a deleted account as the console shows it: its customer without a name (ConsoleCustomerRef,
 * console-bookings.mapper.ts `withoutDeletedName`, which console.bookings.list and get apply from the customer's status
 * since FIX-W32-OTA; kept here for the account console.customers.get reads).
 */
export function withoutDeletedName(summary: ConsoleBookingSummary): ConsoleBookingSummary {
  return summary.customer === null
    ? summary
    : { ...summary, customer: withoutDeletedRefName(summary.customer) };
}

@Injectable()
export class ConsoleCustomersService {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: ConsoleCustomersRepository,
    private readonly bookings: ConsoleBookingsRepository,
    private readonly payments: PaymentsRepository,
    private readonly tenants: TenantContext,
    private readonly clock: Clock,
  ) {}

  // ---- console.customers.list --------------------------------------------------------------------------------------

  /** One page of the OTA's customer accounts with their statistics in the request's environment (file header). */
  async list(query: ConsoleListCustomersQuery): Promise<ConsoleCustomerPage> {
    const tenant = this.tenants.require();
    const sort: ConsoleCustomerSort = query.sort ?? DEFAULT_SORT;
    const limit = query.limit ?? DEFAULT_CONSOLE_PAGE_LIMIT;
    const filters = customerFiltersOf(query);
    const fingerprint = consoleCustomersFingerprint(tenant.environment, sort, filters);
    const after =
      query.cursor === undefined ? undefined : decodeCustomerCursor(query.cursor, fingerprint, sort);
    const now = this.clock.now();
    return await this.tx.run(async (trx) => {
      if (after !== undefined && sort === "name" && !(await this.repository.exists(trx, after.id))) {
        // The position of a name cursor is its customer's current name: a customer erased since has none.
        throw invalidCursor();
      }
      const currency = await this.repository.defaultCurrency(trx);
      const minorUnits = await this.minorUnitsOf(trx, currency);
      const rows = await this.repository.list(trx, {
        ...filters,
        environment: tenant.environment,
        currency,
        now,
        sort,
        after,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map((row) => toConsoleCustomerSummary(row, currency, minorUnits)),
        page: {
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCustomerCursor(fingerprint, last.sortKey, last.id)
              : null,
          limit,
        },
      };
    });
  }

  // ---- console.customers.get ---------------------------------------------------------------------------------------

  /** One customer account with its statistics and recent bookings in the request's environment (file header). */
  async get(customerId: string): Promise<ConsoleCustomer> {
    const tenant = this.tenants.require();
    const now = this.clock.now();
    return await this.tx.run(async (trx) => {
      const row = await this.repository.customer(trx, customerId);
      if (row === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const currency = await this.repository.defaultCurrency(trx);
      const minorUnits = await this.minorUnitsOf(trx, currency);
      const stats = await this.repository.stats(trx, customerId, {
        environment: tenant.environment,
        currency,
        now,
      });
      const bookings = await this.bookings.list(trx, {
        environment: tenant.environment,
        customerId,
        sort: "-created",
        limit: RECENT_BOOKINGS_LIMIT,
      });
      const units = new Map<string, number>();
      for (const code of new Set(bookings.map((booking) => booking.currency))) {
        units.set(code, await this.minorUnitsOf(trx, code));
      }
      const recentBookings = bookings.map((booking) =>
        toConsoleBookingSummary(booking, units.get(booking.currency) ?? 2, now),
      );
      return {
        customer: toConsoleCustomerAccount(row),
        stats: toConsoleCustomerStats(stats, currency, minorUnits),
        recentBookings: row.status === "deleted" ? recentBookings.map(withoutDeletedName) : recentBookings,
        savedTravelersCount: await this.repository.savedTravelersCount(trx, customerId),
        activeSessionsCount: await this.repository.activeSessionsCount(trx, customerId, now),
      };
    });
  }

  /** The minor units of `code` (2 for a currency the reference data does not know). */
  private async minorUnitsOf(trx: TenantTransaction, code: string): Promise<number> {
    return (await this.payments.currencyMinorUnits(trx, code)) ?? 2;
  }
}
