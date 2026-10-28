// The console reads of customers (OBE-066; ota/docs/flows/console-operations.md §2 "Customers", db README §10 "B4
// Console" and §7 "End-customer erasure inside a tenant", the document's consoleListCustomers and consoleGetCustomer):
// the OTA's customer accounts (`customers`, shared by test and live) with their booking statistics in the request's
// environment.
//
// - Statistics (ConsoleCustomerSummary, ConsoleCustomerStats) are computed from the environment's `bookings` and their
//   `payments`, never from the denormalised `customers.last_booking_at` / `total_spent_amount`, which no writer keeps
//   up to date and which mix test and live: `bookingsCount` every booking but the failed ones, `upcomingBookingsCount`
//   the active ones (`pending`, `confirmed`, `ticketed`, `partially_ticketed`) whose trip is not over (db README §10 "My
//   trips"), `cancelledBookingsCount` the cancelled ones, `lastBookingAt` the creation of the latest counted one;
//   `totalSpent` the captured minus refunded amounts and `totalRefunded` the refunded amounts of the payments of the
//   customer's bookings that captured something, in the OTA's currency (`storefront_settings.default_currency`):
//   payments in another currency are not converted (the MVP has no exchange rates) and are left out, and both are
//   `null` when no such payment exists.
// - `list`: the document's filters, AND-ed: `q` (prefix of the e-mail, any case, or of the first or last name, any case
//   or accent, `ß` as `ss`: the search and the names are folded the same way), `email` (exact, any case), `status`
//   (the stored `pending_verification` counts as `active`: the document's console statuses have no other place for an
//   account that waits for its e-mail verification),
//   `emailVerified`, `hasBookings` (`bookingsCount` above zero), `createdFrom` (at or after), `createdTo` (before).
//   Sorts with the id as tie-breaker after a keyset position: `created` / `-created` (sign-up instant), `name` (last
//   name, then first name, any case, deleted accounts last), `-lastBooking` (customers without bookings last) and
//   `-totalSpent` (no payment counts as zero). The position of `created`, `-lastBooking` and `-totalSpent` is the
//   previous page's last sort key (UTC with microseconds, the numeric's text, `null` for no booking) and id; the
//   position of `name` is the previous page's last id alone, whose current key is read here, so that a cursor never
//   carries a name (cursors travel in the OTA admin's URLs).
// - Deleted accounts (account.delete): their names, phone and date of birth stay in the row until the erasure job
//   (OBE-087) anonymises it, but the console shows them as the contract allows, without them (`firstName`/`lastName`
//   `null`, "null for deleted accounts"; customers.service.ts). Here a deleted account is never matched by `q` on its
//   names and is sorted by `name` as nameless, so neither a search nor the order of a page tells a deleted customer's
//   name; its address is the `…@deleted.invalid` placeholder already.
//
// Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a tenant
// schema. Amounts are read as text.
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { CustomerRecord } from "../identity/customers.repository";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** A SQL fragment of type `T` (Kysely's RawBuilder, which @velexis/db does not re-export by name). */
type RawBuilder<T> = ReturnType<typeof sql.raw<T>>;

/** The sort orders of console.customers.list. */
export type ConsoleCustomerSort = "-created" | "created" | "name" | "-lastBooking" | "-totalSpent";

/** The account statuses of the console (the document's `status` filter and ConsoleCustomerSummary.status). */
export type ConsoleCustomerStatus = "active" | "disabled" | "deleted";

/** The stored statuses (`customers.status`) of each console status (see the file header). */
export const STORED_STATUSES: Readonly<Record<ConsoleCustomerStatus, readonly string[]>> = Object.freeze({
  active: Object.freeze(["active", "pending_verification"]),
  disabled: Object.freeze(["disabled"]),
  deleted: Object.freeze(["deleted"]),
});

/** The booking statuses of an upcoming trip (db README §10 "My trips"). */
const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed", "ticketed", "partially_ticketed"] as const;

/** What the statistics are computed for: the request's environment, the OTA's currency, and now. */
export interface CustomerStatsScope {
  readonly environment: string;
  /** `storefront_settings.default_currency`. */
  readonly currency: string;
  readonly now: Date;
}

/** The filters of console.customers.list, as validated. */
export interface ConsoleCustomerFilters {
  readonly q?: string | undefined;
  readonly email?: string | undefined;
  /** Non-empty: the request's, or the default `active, disabled`. */
  readonly status: readonly ConsoleCustomerStatus[];
  readonly emailVerified?: boolean | undefined;
  readonly hasBookings?: boolean | undefined;
  /** ISO-8601 instants: `createdFrom` inclusive, `createdTo` exclusive. */
  readonly createdFrom?: string | undefined;
  readonly createdTo?: string | undefined;
}

/** The keyset position after a row: its sort key (`null` for `name` and for no booking) and id. */
export interface CustomerPosition {
  readonly key: string | null;
  readonly id: string;
}

/** One page of console.customers.list. */
export interface ConsoleCustomerListQuery extends ConsoleCustomerFilters, CustomerStatsScope {
  readonly sort: ConsoleCustomerSort;
  readonly after?: CustomerPosition | undefined;
  /** Rows to read (the page size plus one). */
  readonly limit: number;
}

/** The statistics of one customer in one environment (see the file header). */
export interface CustomerStatsRow {
  readonly bookingsCount: number;
  readonly upcomingBookingsCount: number;
  readonly cancelledBookingsCount: number;
  readonly lastBookingAt: Date | null;
  /** Captured minus refunded, in the OTA's currency; `null` without a payment that captured something. */
  readonly totalSpent: string | null;
  readonly totalRefunded: string | null;
}

/** A row of the console list (ConsoleCustomerSummary before mapping). */
export interface ConsoleCustomerListRow extends CustomerStatsRow {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** The stored status (`pending_verification` included). */
  readonly status: string;
  readonly emailVerifiedAt: Date | null;
  readonly phoneCountryCode: string | null;
  readonly phoneNumber: string | null;
  readonly lastSignInAt: Date | null;
  readonly createdAt: Date;
  /** The sort key as text (see the file header); `null` for `name` and for a customer without bookings. */
  readonly sortKey: string | null;
}

/** The text of an instant as a cursor key: UTC with microseconds. */
const instantKey = (expression: RawBuilder<Date | null>) =>
  sql<string | null>`to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/** The combining marks (U+0300 to U+036F) NFD splits accents into, removed to compare names without accents. */
const COMBINING_MARKS = "[\u0300-\u036f]";
const COMBINING_MARK_PATTERN = new RegExp(COMBINING_MARKS, "g");

/** The lower-case letters without a decomposition, and the letter each folds to (SQL `translate`). */
const UNDECOMPOSED_FROM = "øłıđ";
const UNDECOMPOSED_TO = "olid";

/**
 * A name column folded exactly as `foldedPrefix` folds the search: lower case, NFD without combining marks, `ø`, `ł`,
 * `ı`, `đ` to `o`, `l`, `i`, `d`, and `ß` to `ss`.
 */
const foldedName = (column: string) =>
  sql<string>`replace(translate(regexp_replace(normalize(lower(coalesce(${sql.ref(column)}, '')), NFD), ${COMBINING_MARKS}, '', 'g'), ${UNDECOMPOSED_FROM}, ${UNDECOMPOSED_TO}), 'ß', 'ss')`;

/** `value` with the LIKE wildcards escaped (the default escape character is the backslash), then `%`. */
const likePrefix = (value: string): string => `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * The search text as names are compared, step for step as `foldedName` folds a column (so `Strauß`, `strauss` and
 * `STRAUSS` all find `Strauß`): lower case, NFD without combining marks, the undecomposed letters, then `ß`.
 */
export function foldedPrefix(value: string): string {
  return [...value.toLowerCase().normalize("NFD").replace(COMBINING_MARK_PATTERN, "")]
    .map((letter) => {
      const index = UNDECOMPOSED_FROM.indexOf(letter);
      return index === -1 ? letter : (UNDECOMPOSED_TO[index] ?? letter);
    })
    .join("")
    .replaceAll("ß", "ss");
}

/** Whether customer row `alias` is a deleted account. */
const deletedOf = (alias: string) => sql<boolean>`(${sql.ref(`${alias}.status`)} = 'deleted')`;

/** The name sort key of customer row `alias`: the lower-case name, or nothing for a deleted account. */
const nameKeyOf = (alias: string, column: "last_name" | "first_name") =>
  sql<string>`(CASE WHEN ${deletedOf(alias)} THEN '' ELSE lower(coalesce(${sql.ref(`${alias}.${column}`)}, '')) END)`;

/** The amount sort key: the spent amount, zero without a payment. */
const spentKey = sql<string>`round(coalesce(${sql.ref("m.spent")}, 0), 2)`;

/** The conditions of `filters` on customer `c` (with its statistics `s`). */
function conditionsOf(filters: ConsoleCustomerFilters): RawBuilder<boolean>[] {
  const conditions: RawBuilder<boolean>[] = [];
  const stored = [...new Set(filters.status.flatMap((status) => STORED_STATUSES[status]))];
  conditions.push(sql<boolean>`c.status = ANY(${stored}::text[])`);
  if (filters.q !== undefined) {
    const email = likePrefix(filters.q.toLowerCase());
    const name = likePrefix(foldedPrefix(filters.q));
    conditions.push(sql<boolean>`(
      lower(c.email) LIKE ${email}
      OR (NOT ${deletedOf("c")} AND (${foldedName("c.first_name")} LIKE ${name} OR ${foldedName("c.last_name")} LIKE ${name}))
    )`);
  }
  if (filters.email !== undefined) {
    conditions.push(sql<boolean>`lower(c.email) = ${filters.email.toLowerCase()}`);
  }
  if (filters.emailVerified !== undefined) {
    conditions.push(
      filters.emailVerified
        ? sql<boolean>`c.email_verified_at IS NOT NULL`
        : sql<boolean>`c.email_verified_at IS NULL`,
    );
  }
  if (filters.hasBookings !== undefined) {
    const count = sql.ref("s.bookingsCount");
    conditions.push(filters.hasBookings ? sql<boolean>`${count} > 0` : sql<boolean>`${count} = 0`);
  }
  if (filters.createdFrom !== undefined) {
    conditions.push(sql<boolean>`c.created_at >= ${filters.createdFrom}::timestamptz`);
  }
  if (filters.createdTo !== undefined) {
    conditions.push(sql<boolean>`c.created_at < ${filters.createdTo}::timestamptz`);
  }
  return conditions;
}

/** The keyset condition after `after` for `sort` (see the file header). */
function afterCondition(sort: ConsoleCustomerSort, after: CustomerPosition): RawBuilder<boolean> {
  switch (sort) {
    case "created":
    case "-created": {
      const comparison = sql.raw(sort === "created" ? ">" : "<");
      return sql<boolean>`(c.created_at, c.id) ${comparison} (${after.key}::timestamp AT TIME ZONE 'UTC', ${after.id})`;
    }
    case "name":
      // The position's current key, read from its row: the cursor carries no name.
      return sql<boolean>`(${deletedOf("c")}, ${nameKeyOf("c", "last_name")}, ${nameKeyOf("c", "first_name")}, c.id) > (
        SELECT ${deletedOf("p")}, ${nameKeyOf("p", "last_name")}, ${nameKeyOf("p", "first_name")}, p.id
        FROM customers p WHERE p.id = ${after.id}
      )`;
    case "-lastBooking": {
      const last = sql.ref("s.lastBookingAt");
      // Nulls last: after a dated row come the earlier dated rows, then every undated one; after an undated row only
      // undated rows with a smaller id.
      if (after.key === null) {
        return sql<boolean>`(${last} IS NULL AND c.id < ${after.id})`;
      }
      return sql<boolean>`(${last} IS NULL OR (${last}, c.id) < (${after.key}::timestamp AT TIME ZONE 'UTC', ${after.id}))`;
    }
    case "-totalSpent":
      return sql<boolean>`(${spentKey}, c.id) < (${after.key}::numeric, ${after.id})`;
  }
}

@Injectable()
export class ConsoleCustomersRepository {
  /** One page of the console list (see the file header). */
  async list(trx: TenantTransaction, query: ConsoleCustomerListQuery): Promise<ConsoleCustomerListRow[]> {
    const conditions = conditionsOf(query);
    if (query.after !== undefined) {
      conditions.push(afterCondition(query.sort, query.after));
    }
    let select = trx
      .selectFrom("customers as c")
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("bookings as b")
            .select(bookingStatsColumns(query.now))
            .whereRef("b.customer_id", "=", "c.id")
            .where("b.environment", "=", query.environment)
            .as("s"),
        (join) => join.onTrue(),
      )
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("payments as p")
            .innerJoin("bookings as pb", "pb.id", "p.booking_id")
            .select(paymentStatsColumns())
            .whereRef("pb.customer_id", "=", "c.id")
            .where("pb.environment", "=", query.environment)
            .where("p.currency", "=", query.currency)
            .where("p.amount_captured", ">", "0")
            .as("m"),
        (join) => join.onTrue(),
      )
      .select([
        "c.id as id",
        "c.email as email",
        "c.first_name as firstName",
        "c.last_name as lastName",
        "c.status as status",
        "c.email_verified_at as emailVerifiedAt",
        "c.phone_country_code as phoneCountryCode",
        "c.phone_number as phoneNumber",
        "c.last_sign_in_at as lastSignInAt",
        "c.created_at as createdAt",
        sql<number>`coalesce(${sql.ref("s.bookingsCount")}, 0)`.as("bookingsCount"),
        sql<number>`coalesce(${sql.ref("s.upcomingBookingsCount")}, 0)`.as("upcomingBookingsCount"),
        sql<number>`coalesce(${sql.ref("s.cancelledBookingsCount")}, 0)`.as("cancelledBookingsCount"),
        sql<Date | null>`${sql.ref("s.lastBookingAt")}`.as("lastBookingAt"),
        sql<string | null>`${sql.ref("m.spent")}::text`.as("totalSpent"),
        sql<string | null>`${sql.ref("m.refunded")}::text`.as("totalRefunded"),
        sortKeyOf(query.sort).as("sortKey"),
      ])
      .where(sql<boolean>`${sql.join(conditions, sql` AND `)}`);
    for (const item of orderOf(query.sort)) {
      select = select.orderBy(item);
    }
    return await select.limit(query.limit).execute();
  }

  /** Whether customer `id` exists (a `name` cursor's position). */
  async exists(trx: TenantTransaction, id: string): Promise<boolean> {
    const row = await trx.selectFrom("customers").select("id").where("id", "=", id).executeTakeFirst();
    return row !== undefined;
  }

  /** Customer `id` with the columns of the document's `Customer`; `undefined` when there is none. */
  async customer(trx: TenantTransaction, id: string): Promise<CustomerRecord | undefined> {
    return await trx
      .selectFrom("customers")
      .select([
        "id",
        "email",
        "email_verified_at",
        "pending_email",
        "first_name",
        "last_name",
        sql<string | null>`to_char(date_of_birth, 'YYYY-MM-DD')`.as("date_of_birth"),
        "phone_country_code",
        "phone_number",
        "status",
        "marketing_consent",
        "marketing_consent_updated_at",
        "marketing_consent_source",
        "terms_accepted_version",
        "last_sign_in_at",
        "deleted_at",
        "created_at",
        "updated_at",
        "version",
      ])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  /** The statistics of customer `id` in `scope` (see the file header). */
  async stats(trx: TenantTransaction, id: string, scope: CustomerStatsScope): Promise<CustomerStatsRow> {
    const bookings = await trx
      .selectFrom("bookings as b")
      .select(bookingStatsColumns(scope.now))
      .where("b.customer_id", "=", id)
      .where("b.environment", "=", scope.environment)
      .executeTakeFirstOrThrow();
    const payments = await trx
      .selectFrom("payments as p")
      .innerJoin("bookings as pb", "pb.id", "p.booking_id")
      .select(paymentStatsColumns())
      .where("pb.customer_id", "=", id)
      .where("pb.environment", "=", scope.environment)
      .where("p.currency", "=", scope.currency)
      .where("p.amount_captured", ">", "0")
      .executeTakeFirstOrThrow();
    return {
      bookingsCount: bookings.bookingsCount,
      upcomingBookingsCount: bookings.upcomingBookingsCount,
      cancelledBookingsCount: bookings.cancelledBookingsCount,
      lastBookingAt: bookings.lastBookingAt,
      totalSpent: payments.spent,
      totalRefunded: payments.refunded,
    };
  }

  /** How many saved travellers customer `id` has. */
  async savedTravelersCount(trx: TenantTransaction, id: string): Promise<number> {
    const row = await trx
      .selectFrom("saved_travelers")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("customer_id", "=", id)
      .executeTakeFirstOrThrow();
    return row.count;
  }

  /**
   * How many sessions of customer `id` are live at `now`: families whose current generation (not rotated) is neither
   * revoked nor past the family's end (identity/sessions.repository.ts).
   */
  async activeSessionsCount(trx: TenantTransaction, id: string, now: Date): Promise<number> {
    const row = await trx
      .selectFrom("customer_sessions")
      .select(sql<number>`count(DISTINCT family_id)::int`.as("count"))
      .where("customer_id", "=", id)
      .where("revoked_at", "is", null)
      .where("rotated_at", "is", null)
      .where("family_expires_at", ">", now)
      .where("expires_at", ">", now)
      .executeTakeFirstOrThrow();
    return row.count;
  }

  /** The OTA's currency (`storefront_settings.default_currency`); the column's default when the row is missing. */
  async defaultCurrency(trx: TenantTransaction): Promise<string> {
    const row = await trx
      .selectFrom("storefront_settings")
      .select(sql<string>`default_currency::text`.as("currency"))
      .executeTakeFirst();
    return row?.currency ?? "EUR";
  }
}

/** The booking statistics of the bookings `b` of one customer (see the file header). */
function bookingStatsColumns(now: Date) {
  return [
    sql<number>`(count(*) FILTER (WHERE b.status <> 'failed'))::int`.as("bookingsCount"),
    sql<number>`(count(*) FILTER (
      WHERE b.status = ANY(${[...ACTIVE_BOOKING_STATUSES]}::text[]) AND b.last_arrival_at >= ${now}
    ))::int`.as("upcomingBookingsCount"),
    sql<number>`(count(*) FILTER (WHERE b.status = 'cancelled'))::int`.as("cancelledBookingsCount"),
    sql<Date | null>`max(b.created_at) FILTER (WHERE b.status <> 'failed')`.as("lastBookingAt"),
  ] as const;
}

/** The money statistics of the payments `p` of one customer's bookings (see the file header). */
function paymentStatsColumns() {
  return [
    sql<string | null>`sum(p.amount_captured - p.amount_refunded)`.as("spent"),
    sql<string | null>`sum(p.amount_refunded)`.as("refunded"),
  ] as const;
}

/** The sort key of customer `c` as text (see the file header). */
function sortKeyOf(sort: ConsoleCustomerSort): RawBuilder<string | null> {
  switch (sort) {
    case "created":
    case "-created":
      return instantKey(sql<Date>`c.created_at`);
    case "-lastBooking":
      return instantKey(sql<Date | null>`${sql.ref("s.lastBookingAt")}`);
    case "-totalSpent":
      return sql<string>`${spentKey}::text`;
    case "name":
      return sql<string | null>`NULL::text`;
  }
}

/** The ORDER BY items of `sort`, the id last (see the file header). */
function orderOf(sort: ConsoleCustomerSort): RawBuilder<unknown>[] {
  switch (sort) {
    case "created":
      return [sql`c.created_at ASC`, sql`c.id ASC`];
    case "-created":
      return [sql`c.created_at DESC`, sql`c.id DESC`];
    case "name":
      return [
        sql`${deletedOf("c")} ASC`,
        sql`${nameKeyOf("c", "last_name")} ASC`,
        sql`${nameKeyOf("c", "first_name")} ASC`,
        sql`c.id ASC`,
      ];
    case "-lastBooking":
      return [sql`${sql.ref("s.lastBookingAt")} DESC NULLS LAST`, sql`c.id DESC`];
    case "-totalSpent":
      return [sql`${spentKey} DESC`, sql`c.id DESC`];
  }
}
