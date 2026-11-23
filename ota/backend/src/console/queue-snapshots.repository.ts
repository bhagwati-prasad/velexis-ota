// `queue_snapshots` (OBE-065; db README §6 and §10 "B4 Console", flows/console-operations.md §2 "Queues"): every Queue
// List read the OTA keeps, a staff member's (console.queues.list), a `console:automation` key's, or the queue poller's
// (`queues.poll`, `fetched_by_staff_id` null), with the response as Amadeus gave it (through the shared redactor) and
// the `supplier_requests` row of the call. Append-only: the rows are never updated, and `retention.daily` deletes those
// fetched more than 30 days ago (jobs/retention.repository.ts).
//
// Who read a queue is the staff member's id when there is one; otherwise the operation of the linked supplier request
// tells a key's read (`console.queues.list`) from the poller's (`queues.poll`): the table keeps no key id, so a key's
// read is known as a key's without its id. A snapshot whose supplier request is gone (none was recorded) and that no
// staff member read counts as the poller's.
//
// The links of the PNRs to the OTA's bookings (`bookingLinks`) are read when the items are shown, never stored: a
// booking created or cancelled after the read shows as it is now. A record locator matches a booking of the snapshot's
// environment by `bookings.record_locator`, else by one of its `booking_associated_records` (an airline locator), the
// most recent booking first; anything else is an orphan.
//
// The newest read of each queue (`latest`, FIX-W70-CONSOLE, known issue KI-022) is the snapshot of each office, queue
// and category with the greatest `fetched_at`, then `id`, among the snapshots the filters match, read as a subquery of
// ids so that the page, its order and its cursor are the plain list's. It walks `queue_snapshots_queue_idx`
// (environment, office, queue, category, `fetched_at` descending) as a loose index scan: a recursive CTE finds each
// office, queue and category of the environment with one index probe (the next key after the last one found, the
// office, queue and category filters applied), then one probe per queue reads its newest snapshot within the fetch-time
// filters (a queue without one there is left out). A month of 15-minute reads of 20 queues (58,100 rows, 49 queues)
// answers in about 2 ms, where `DISTINCT ON` sorted every row of the environment (about 90 ms, the sort spilling to disk;
// EXPLAIN ANALYZE on a scratch tenant schema with PostgreSQL 16, FIX-W70-CONSOLE).
//
// Every method takes the caller's tenant transaction (TenantTx), as every repository does; none names a schema.
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** A snapshot to store. */
export interface QueueSnapshotRecord {
  /** `qsn_` + ULID. */
  readonly id: string;
  readonly environment: "test" | "live";
  readonly officeId: string;
  readonly queueId: number;
  readonly category: number;
  /** The `max` sent to Queue List, or `null` when none was. */
  readonly maxRequested: number | null;
  /** The number of PNRs of the response (`data`). */
  readonly itemCount: number;
  /** The response, already through the shared redactor; stored as JSON. */
  readonly response: unknown;
  /** `stf_…` of the staff member who read it, `null` for a key or the poller. */
  readonly fetchedByStaffId: string | null;
  /** `sreq_…` of the call, `null` when its row could not be written. */
  readonly supplierRequestId: string | null;
  readonly fetchedAt: Date;
}

/** A stored snapshot without its response. */
export interface QueueSnapshotRow {
  readonly id: string;
  readonly environment: string;
  readonly officeId: string;
  readonly queueId: number;
  readonly category: number;
  readonly maxRequested: number | null;
  readonly itemCount: number;
  readonly fetchedByStaffId: string | null;
  readonly supplierRequestId: string | null;
  /** `supplier_requests.operation` of the call (`queues.poll`, `console.queues.list`), `null` without the row. */
  readonly fetchedVia: string | null;
  readonly fetchedAt: Date;
  /** `fetched_at` in UTC with microseconds: the key of the snapshots list's cursor. */
  readonly sortKey: string;
  /** `response -> 'warnings'`. */
  readonly warnings: unknown;
}

/** A stored snapshot with its response. */
export interface QueueSnapshotWithResponse extends QueueSnapshotRow {
  readonly response: unknown;
}

/** The filters and page of the snapshots list. */
export interface QueueSnapshotQuery {
  readonly environment: string;
  readonly queueId?: number | undefined;
  readonly officeId?: string | undefined;
  readonly category?: number | undefined;
  /** At or after. */
  readonly fetchedFrom?: Date | undefined;
  /** Before. */
  readonly fetchedTo?: Date | undefined;
  /** After the row with this sort key (`fetched_at`, UTC with microseconds) and id. */
  readonly after?: { readonly key: string; readonly id: string } | undefined;
  /** Only the newest snapshot of each office, queue and category among those the filters match (see the header). */
  readonly latest?: boolean | undefined;
  readonly limit: number;
}

/** The OTA's booking a record locator of a queue belongs to. */
export interface QueueBookingLink {
  readonly bookingId: string;
  readonly reference: string;
  readonly status: string;
}

/** A queue of one environment, as the poller reads it. */
export interface QueueKey {
  readonly environment: "test" | "live";
  readonly officeId: string;
  readonly queueId: number;
  readonly category: number;
}

/** The longest list of record locators one `bookingLinks` query takes (a page of a snapshot has at most 500). */
const MAX_LINKED_LOCATORS = 10_000;

@Injectable()
export class QueueSnapshotsRepository {
  /** Stores one snapshot. */
  async insert(trx: TenantTransaction, record: QueueSnapshotRecord): Promise<void> {
    await trx
      .insertInto("queue_snapshots")
      .values({
        id: record.id,
        environment: record.environment,
        office_id: record.officeId,
        queue_id: record.queueId,
        category: record.category,
        max_requested: record.maxRequested,
        item_count: record.itemCount,
        response: JSON.stringify(record.response ?? {}),
        fetched_by_staff_id: record.fetchedByStaffId,
        supplier_request_id: record.supplierRequestId,
        fetched_at: record.fetchedAt,
        created_at: record.fetchedAt,
        updated_at: record.fetchedAt,
      })
      .execute();
  }

  /** The snapshot `id` with its response, whatever its environment, or `undefined`. */
  async byId(trx: TenantTransaction, id: string): Promise<QueueSnapshotWithResponse | undefined> {
    return await snapshotRows(snapshotsFrom(trx))
      .select("s.response")
      .where("s.id", "=", id)
      .executeTakeFirst();
  }

  /**
   * One page of the environment's snapshots, newest first (`fetched_at`, then `id`, descending: the
   * `queue_snapshots_fetched_idx` order), with the filters of consoleListQueueSnapshots; with `latest` only the newest
   * snapshot of each office, queue and category the filters match (see the file header), in the same order and with the
   * same cursor; the responses only with `withResponse` (`include=items`).
   */
  async list(
    trx: TenantTransaction,
    query: QueueSnapshotQuery,
    withResponse: boolean,
  ): Promise<QueueSnapshotWithResponse[]> {
    const rows =
      query.latest === true
        ? snapshotRows(snapshotsFrom(trx)).where("s.id", "in", newestOfEachQueue(query))
        : snapshotRows(filteredSnapshots(trx, query));
    let select = rows.select(
      withResponse ? sql<unknown>`s.response`.as("response") : sql<unknown>`NULL`.as("response"),
    );
    if (query.after !== undefined) {
      const { key, id } = query.after;
      select = select.where(
        sql<boolean>`(s.fetched_at, s.id) < ((${key}::timestamp AT TIME ZONE 'UTC'), ${id})`,
      );
    }
    return await select.orderBy("s.fetched_at", "desc").orderBy("s.id", "desc").limit(query.limit).execute();
  }

  /**
   * Whether the poller stored a snapshot of `queue` at or after `since` (the iteration it runs for): a snapshot without
   * a staff member whose supplier request has the poller's `operation`. A job that runs again after a failure, or a
   * second run of one iteration, reads no queue twice; reads by staff or keys do not count.
   */
  async polledSince(
    trx: TenantTransaction,
    queue: QueueKey,
    since: Date,
    operation: string,
  ): Promise<boolean> {
    const row = await trx
      .selectFrom("queue_snapshots as s")
      .innerJoin("supplier_requests as r", "r.id", "s.supplier_request_id")
      .select("s.id")
      .where("s.environment", "=", queue.environment)
      .where("s.office_id", "=", queue.officeId)
      .where("s.queue_id", "=", queue.queueId)
      .where("s.category", "=", queue.category)
      .where("s.fetched_at", ">=", since)
      .where("s.fetched_by_staff_id", "is", null)
      .where("r.operation", "=", operation)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The bookings of `environment` that the record locators `recordLocators` belong to (see the file header), by
   * locator; a locator without a booking is absent.
   */
  async bookingLinks(
    trx: TenantTransaction,
    environment: string,
    recordLocators: readonly string[],
  ): Promise<ReadonlyMap<string, QueueBookingLink>> {
    const wanted = [...new Set(recordLocators)].filter((locator) => locator !== "");
    const links = new Map<string, QueueBookingLink>();
    if (wanted.length === 0) {
      return links;
    }
    if (wanted.length > MAX_LINKED_LOCATORS) {
      throw new RangeError(`bookingLinks: at most ${MAX_LINKED_LOCATORS} record locators`);
    }
    const main = await trx
      .selectFrom("bookings")
      .select(["id", "reference", "status", "record_locator as locator"])
      .where("environment", "=", environment)
      .where("record_locator", "in", wanted)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    for (const row of main) {
      if (row.locator !== null && !links.has(row.locator)) {
        links.set(row.locator, { bookingId: row.id, reference: row.reference, status: row.status });
      }
    }
    const rest = wanted.filter((locator) => !links.has(locator));
    if (rest.length === 0) {
      return links;
    }
    const associated = await trx
      .selectFrom("booking_associated_records as r")
      .innerJoin("bookings as b", "b.id", "r.booking_id")
      .select(["b.id", "b.reference", "b.status", "r.reference as locator"])
      .where("b.environment", "=", environment)
      .where("r.reference", "in", rest)
      .orderBy("b.created_at", "desc")
      .orderBy("b.id", "desc")
      .execute();
    for (const row of associated) {
      if (!links.has(row.locator)) {
        links.set(row.locator, { bookingId: row.id, reference: row.reference, status: row.status });
      }
    }
    return links;
  }
}

/** The snapshots table as `s`. */
function snapshotsFrom(trx: TenantTransaction) {
  return trx.selectFrom("queue_snapshots as s");
}

/** The snapshots of the query's environment that its filters match (not its cursor, not `latest`). */
function filteredSnapshots(
  trx: TenantTransaction,
  query: QueueSnapshotQuery,
): ReturnType<typeof snapshotsFrom> {
  let select = snapshotsFrom(trx).where("s.environment", "=", query.environment);
  if (query.queueId !== undefined) {
    select = select.where("s.queue_id", "=", query.queueId);
  }
  if (query.officeId !== undefined) {
    select = select.where("s.office_id", "=", query.officeId);
  }
  if (query.category !== undefined) {
    select = select.where("s.category", "=", query.category);
  }
  if (query.fetchedFrom !== undefined) {
    select = select.where("s.fetched_at", ">=", query.fetchedFrom);
  }
  if (query.fetchedTo !== undefined) {
    select = select.where("s.fetched_at", "<", query.fetchedTo);
  }
  return select;
}

/**
 * The ids of the newest snapshot of each office, queue and category the query's filters match (see the file header):
 * the keys with one probe each of `queue_snapshots_queue_idx`, then each key's newest snapshot within the fetch times.
 */
function newestOfEachQueue(query: QueueSnapshotQuery) {
  const keyFilters = [
    sql<boolean>`q.environment = ${query.environment}`,
    ...(query.officeId === undefined ? [] : [sql<boolean>`q.office_id = ${query.officeId}`]),
    ...(query.queueId === undefined ? [] : [sql<boolean>`q.queue_id = ${query.queueId}`]),
    ...(query.category === undefined ? [] : [sql<boolean>`q.category = ${query.category}`]),
  ];
  const timeFilters = [
    ...(query.fetchedFrom === undefined ? [] : [sql<boolean>`q.fetched_at >= ${query.fetchedFrom}`]),
    ...(query.fetchedTo === undefined ? [] : [sql<boolean>`q.fetched_at < ${query.fetchedTo}`]),
  ];
  const keys = sql.join(keyFilters, sql` AND `);
  const newestOfKey = sql.join(
    [
      sql<boolean>`q.environment = ${query.environment}`,
      sql<boolean>`q.office_id = k.office_id`,
      sql<boolean>`q.queue_id = k.queue_id`,
      sql<boolean>`q.category = k.category`,
      ...timeFilters,
    ],
    sql` AND `,
  );
  return sql<string>`(WITH RECURSIVE queues AS (
      (SELECT q.office_id, q.queue_id, q.category FROM queue_snapshots AS q
        WHERE ${keys}
        ORDER BY q.office_id, q.queue_id, q.category LIMIT 1)
      UNION ALL
      SELECT n.office_id, n.queue_id, n.category FROM queues AS k
      CROSS JOIN LATERAL (
        SELECT q.office_id, q.queue_id, q.category FROM queue_snapshots AS q
         WHERE ${keys} AND (q.office_id, q.queue_id, q.category) > (k.office_id, k.queue_id, k.category)
         ORDER BY q.office_id, q.queue_id, q.category LIMIT 1) AS n
    )
    SELECT newest.id FROM queues AS k
    CROSS JOIN LATERAL (
      SELECT q.id FROM queue_snapshots AS q
       WHERE ${newestOfKey}
       ORDER BY q.fetched_at DESC, q.id DESC LIMIT 1) AS newest)`;
}

/** The columns of a snapshot of `from` without its response, with its supplier request's operation. */
function snapshotRows(from: ReturnType<typeof snapshotsFrom>) {
  return from
    .leftJoin("supplier_requests as r", "r.id", "s.supplier_request_id")
    .select([
      "s.id",
      "s.environment",
      "s.office_id as officeId",
      "s.queue_id as queueId",
      "s.category",
      "s.max_requested as maxRequested",
      "s.item_count as itemCount",
      "s.fetched_by_staff_id as fetchedByStaffId",
      "s.supplier_request_id as supplierRequestId",
      "r.operation as fetchedVia",
      "s.fetched_at as fetchedAt",
      sql<string>`to_char(s.fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`.as("sortKey"),
      sql<unknown>`s.response -> 'warnings'`.as("warnings"),
    ]);
}
