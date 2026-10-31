// The console queues (OBE-065; flows/console-operations.md §2 "Queues", OADR-0003 follow-up "a console booking queue
// view", the document's consoleListQueue and consoleListQueueSnapshots): what OTA staff (or a `console:automation`
// key listing `queues:read`) see of the Amadeus queues of the OTA's offices, in the request's environment only. The
// permission guard checked `queues:read` and the environment before this runs (OBE-060).
//
// - `list` (console.queues.list, `GET /v1/console/queues/{queueId}`): without `cursor`, one Queue List read of the
//   queue (`category` default 0, `officeId` default the connection's queue office, `max` as given) through the Amadeus
//   client, which refuses an office that is not one of the tenant's connection's before any call (`403
//   OFFICE_NOT_ALLOWED`; an Amadeus `403` maps to it too) and writes the call's `supplier_requests` row. No transaction
//   is open during the call. The answer is stored as a `queue_snapshots` row (queue-snapshots.repository.ts) with the
//   staff member, and the first `limit` PNRs are answered with `page.nextCursor`; with `cursor` (the snapshot and an
//   offset) the next pages are read from that row without calling Amadeus again, as long as the snapshot is retained
//   (30 days). A cursor this API did not write, or one of another queue, office, category or environment, is `400
//   VALIDATION_FAILED` (`/query/cursor`). An answer that is not a list of PNRs is `502 SUPPLIER_ERROR` and stores
//   nothing.
// - `listSnapshots` (console.queues.listSnapshots, `GET /v1/console/queue-snapshots`): the environment's snapshots,
//   newest first, staff reads and the poller's (`fetchedBy: null`), filtered by queue, office, category and fetch time,
//   with a keyset cursor bound to the environment and the filters; `include=items` adds each snapshot's PNRs (then at
//   most 20 per page: `400 VALIDATION_FAILED` at `/query/limit` above). No Amadeus call.
//
// Each PNR is shown as linked to the OTA's booking of its record locator (`bookingId`, `bookingReference`,
// `bookingStatus`, read when the page is answered) or as an orphan (all three `null`): the booking queue view of
// OADR-0003's follow-up, where staff spot the PNRs that no booking of the OTA owns. The verbatim Amadeus entry is kept
// in `amadeus`. Neither read writes a `staff_actions` row (OADR-0011 point 8 as decided on 2026-10-21: queues are
// lists, not one person's data); a refused or failed call has the audit interceptor's row as any console call.
import { Injectable } from "@nestjs/common";
import type { components, operations } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { listFingerprint } from "../bookings/bookings.mapper";
import { queueRecordLocatorOf } from "../bookings/reconcile.service";
import { StaffContext } from "../common/auth/staff.guard";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { invalidCursor } from "../reference/reference.mapper";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { DEFAULT_CONSOLE_PAGE_LIMIT } from "./console-bookings.service";
import {
  QueueSnapshotsRepository,
  type QueueBookingLink,
  type QueueSnapshotRow,
  type QueueSnapshotWithResponse,
} from "./queue-snapshots.repository";

type Schemas = components["schemas"];
type JsonObject = Record<string, unknown>;
export type QueueListResult = Schemas["QueueListResult"];
export type QueueSnapshot = Schemas["QueueSnapshot"];
export type QueueSnapshotPage = Schemas["QueueSnapshotPage"];
export type QueueItem = Schemas["QueueItem"];
type Warning = Schemas["Warning"];
type ConsoleActor = Schemas["ConsoleActor"];
export type ConsoleListQueueQuery = NonNullable<operations["consoleListQueue"]["parameters"]["query"]>;
export type ConsoleListQueueSnapshotsQuery = NonNullable<
  operations["consoleListQueueSnapshots"]["parameters"]["query"]
>;

/** `Cache-Control` of both answers: every first page is a fresh Amadeus read, and the pages hold names. */
export const CONSOLE_QUEUE_CACHE_CONTROL = "private, no-store";

/** `supplier_requests.operation` of a staff (or key) read, and of the poller's (queue-poller.processor.ts). */
export const QUEUE_LIST_OPERATION = "console.queues.list";
export const QUEUE_POLL_OPERATION = "queues.poll";

/** The largest page of snapshots with their items (`include=items`), as the document says. */
export const MAX_SNAPSHOTS_WITH_ITEMS = 20;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

// ---- Queue List answers --------------------------------------------------------------------------------------------

/**
 * The PNR entries of a Queue List answer (`data`, the entries that are objects); none when the answer has no `data`
 * (an empty queue), `undefined` when it is not an object or its `data` is not a list.
 */
export function queueEntriesOf(response: unknown): JsonObject[] | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const data = response["data"];
  if (data === undefined) {
    return [];
  }
  return Array.isArray(data) ? records(data) : undefined;
}

/**
 * Amadeus warnings as the document's `Warning`s: each object of `value` with its `title` (empty when it has none),
 * and its `code`, `detail` and `source` when they are of the documented types.
 */
export function warningsOf(value: unknown): Warning[] {
  return records(value).map((warning) => {
    const source = isRecord(warning["source"]) ? warning["source"] : undefined;
    const sourceFields = source === undefined ? {} : sourceOf(source);
    const code = warning["code"];
    return {
      title: text(warning["title"]) ?? "",
      ...(typeof code === "number" && Number.isSafeInteger(code) ? { code } : {}),
      ...(typeof warning["detail"] === "string" ? { detail: warning["detail"] } : {}),
      ...(Object.keys(sourceFields).length > 0 ? { source: sourceFields } : {}),
    };
  });
}

function sourceOf(source: JsonObject): NonNullable<Warning["source"]> {
  const fields: Record<string, string> = {};
  for (const key of ["parameter", "pointer", "example"] as const) {
    const value = source[key];
    if (typeof value === "string") {
      fields[key] = value;
    }
  }
  return fields;
}

/** The record locator of a Queue List entry (the part of its `id` before the creation day), or `""`. */
export function recordLocatorOf(entry: JsonObject): string {
  return queueRecordLocatorOf(entry) ?? "";
}

/**
 * A Queue List entry as a `QueueItem`: its id, record locator, creation, the first name of each traveller, the air
 * segments of its products, the OTA's booking of its record locator (`link`, or `null`s: an orphan) and the entry
 * itself, verbatim.
 */
export function toQueueItem(entry: JsonObject, link: QueueBookingLink | undefined): QueueItem {
  const creation = isRecord(entry["creation"]) ? entry["creation"] : {};
  return {
    pnrId: text(entry["id"]) ?? "",
    recordLocator: recordLocatorOf(entry),
    creationDateTime: text(creation["dateTime"]),
    travelers: records(entry["travelers"]).flatMap((traveler) => {
      const name = records(traveler["names"])[0];
      return name === undefined
        ? []
        : [{ firstName: text(name["firstName"]), lastName: text(name["lastName"]) }];
    }),
    segments: records(entry["products"]).flatMap((product) => {
      const delivery = isRecord(product["airSegment"]) ? product["airSegment"] : undefined;
      const segment = isRecord(delivery?.["segment"]) ? delivery["segment"] : undefined;
      if (segment === undefined) {
        return [];
      }
      const arrival = isRecord(segment["arrival"]) ? segment["arrival"] : {};
      return [
        {
          carrierCode: text(segment["carrierCode"]),
          number: text(segment["number"]),
          arrivalIataCode: text(arrival["iataCode"]),
          arrivalLocalDateTime: text(arrival["localDateTime"]),
        },
      ];
    }),
    bookingId: link?.bookingId ?? null,
    bookingReference: link?.reference ?? null,
    bookingStatus: (link?.status ?? null) as QueueItem["bookingStatus"],
    amadeus: entry as Schemas["AmadeusPnr"],
  };
}

// ---- Snapshots -----------------------------------------------------------------------------------------------------

/**
 * Who read a stored snapshot (queue-snapshots.repository.ts): its staff member (known by id: the tenant tables keep no
 * name), else a key (the read of a console operation without a staff member: the key's id is not kept), else the
 * poller (`null`).
 */
export function snapshotActorOf(
  row: Pick<QueueSnapshotRow, "fetchedByStaffId" | "fetchedVia">,
): ConsoleActor | null {
  if (row.fetchedByStaffId !== null) {
    return { type: "staff", id: row.fetchedByStaffId, name: null, email: null, role: null };
  }
  if (row.fetchedVia !== null && row.fetchedVia !== QUEUE_POLL_OPERATION) {
    return { type: "api_key", id: null, name: null, email: null, role: null };
  }
  return null;
}

/** A stored snapshot as the document's `QueueSnapshot`, with its items when they are given (`include=items`). */
export function toQueueSnapshot(
  row: QueueSnapshotRow,
  fetchedBy: ConsoleActor | null,
  items?: readonly QueueItem[],
): QueueSnapshot {
  return {
    id: row.id,
    environment: row.environment === "live" ? "live" : "test",
    officeId: row.officeId,
    queueId: row.queueId,
    category: row.category,
    maxRequested: row.maxRequested,
    itemCount: row.itemCount,
    fetchedAt: row.fetchedAt.toISOString(),
    fetchedBy,
    supplierRequestId: row.supplierRequestId,
    warnings: warningsOf(row.warnings),
    ...(items === undefined ? {} : { items: [...items] }),
  };
}

// ---- Cursors -------------------------------------------------------------------------------------------------------

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 400;
const SNAPSHOT_ID = /^qsn_[0-9A-Za-z]{16,40}$/;
const CURSOR_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
/** The largest offset of a queue cursor: far above any Queue List answer (`max` 500). */
const MAX_QUEUE_OFFSET = 100_000;

/** The JSON array of an opaque cursor, or `undefined` when the value is not one this API wrote. */
function cursorArray(value: string): unknown[] | undefined {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The cursor of a queue page: the snapshot it pages through and the offset of the page's first PNR. */
export function encodeQueueCursor(snapshotId: string, offset: number): string {
  return Buffer.from(JSON.stringify(["q", CURSOR_VERSION, snapshotId, offset])).toString("base64url");
}

/** The snapshot and offset of a queue cursor; `400 VALIDATION_FAILED` (`/query/cursor`) for anything else. */
export function decodeQueueCursor(value: string): { readonly snapshotId: string; readonly offset: number } {
  const parsed = cursorArray(value);
  if (parsed?.length !== 4) {
    throw invalidCursor();
  }
  const [kind, version, snapshotId, offset] = parsed;
  if (
    kind !== "q" ||
    version !== CURSOR_VERSION ||
    typeof snapshotId !== "string" ||
    !SNAPSHOT_ID.test(snapshotId) ||
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    offset > MAX_QUEUE_OFFSET
  ) {
    throw invalidCursor();
  }
  return { snapshotId, offset };
}

/** The fingerprint of a snapshots list: the environment and every filter. */
export function queueSnapshotsFingerprint(
  environment: string,
  query: ConsoleListQueueSnapshotsQuery,
): string {
  const instant = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : new Date(value).toISOString();
  return listFingerprint({
    list: "console.queues.listSnapshots",
    environment,
    queueId: query.queueId === undefined ? undefined : String(query.queueId),
    officeId: query.officeId,
    category: query.category === undefined ? undefined : String(query.category),
    fetchedFrom: instant(query.fetchedFrom),
    fetchedTo: instant(query.fetchedTo),
    include: query.include?.includes("items") === true ? "items" : undefined,
  });
}

/** The cursor of the snapshots list after the row with this sort key (`fetched_at`, UTC with microseconds) and id. */
export function encodeSnapshotsCursor(fingerprint: string, key: string, id: string): string {
  return Buffer.from(JSON.stringify(["s", CURSOR_VERSION, fingerprint, key, id])).toString("base64url");
}

/** The keyset position of a snapshots cursor of the list `fingerprint`; `400 VALIDATION_FAILED` otherwise. */
export function decodeSnapshotsCursor(
  value: string,
  fingerprint: string,
): { readonly key: string; readonly id: string } {
  const parsed = cursorArray(value);
  if (parsed?.length !== 5) {
    throw invalidCursor();
  }
  const [kind, version, print, key, id] = parsed;
  if (
    kind !== "s" ||
    version !== CURSOR_VERSION ||
    print !== fingerprint ||
    typeof key !== "string" ||
    !CURSOR_KEY.test(key) ||
    typeof id !== "string" ||
    !SNAPSHOT_ID.test(id)
  ) {
    throw invalidCursor();
  }
  return { key, id };
}

/** `400 VALIDATION_FAILED` of a page of snapshots with their items larger than MAX_SNAPSHOTS_WITH_ITEMS. */
export function itemsLimitExceeded(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [
      {
        path: "/query/limit",
        code: "maximum",
        message: `must be at most ${MAX_SNAPSHOTS_WITH_ITEMS} with include=items`,
      },
    ],
  });
}

// ---- The service ---------------------------------------------------------------------------------------------------

@Injectable()
export class QueuesService {
  constructor(
    private readonly tx: TenantTx,
    private readonly snapshots: QueueSnapshotsRepository,
    private readonly amadeus: AmadeusClient,
    private readonly tenants: TenantContext,
    private readonly staff: StaffContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(QueuesService.name) private readonly logger: PinoLogger,
  ) {}

  // ---- console.queues.list -----------------------------------------------------------------------------------------

  /** A page of queue `queueId`: a fresh read without a cursor, a page of the stored snapshot with one. */
  async list(queueId: number, query: ConsoleListQueueQuery): Promise<QueueListResult> {
    const tenant = this.tenants.require();
    const limit = query.limit ?? DEFAULT_CONSOLE_PAGE_LIMIT;
    if (query.cursor !== undefined) {
      const position = decodeQueueCursor(query.cursor);
      return await this.tx.run(async (trx) => {
        const snapshot = await this.snapshots.byId(trx, position.snapshotId);
        if (
          snapshot === undefined ||
          snapshot.environment !== tenant.environment ||
          snapshot.queueId !== queueId ||
          (query.category !== undefined && snapshot.category !== query.category) ||
          (query.officeId !== undefined && snapshot.officeId !== query.officeId)
        ) {
          throw invalidCursor();
        }
        return await this.page(trx, snapshot, position.offset, limit, snapshotActorOf(snapshot));
      });
    }

    const category = query.category ?? 0;
    const maxRequested = query.max ?? null;
    const reply = await this.amadeus.listQueue(this.callContext(tenant), {
      queueId,
      query: {
        category,
        ...(query.officeId === undefined ? {} : { officeId: query.officeId }),
        ...(maxRequested === null ? {} : { max: maxRequested }),
      },
    });
    const fetchedAt = this.clock.now();
    const entries = queueEntriesOf(reply.body);
    const officeId = reply.call.officeId ?? query.officeId;
    if (entries === undefined || officeId === undefined) {
      this.logger.warn(
        { queueId, supplierRequestId: reply.call.supplierRequestId },
        "console.queues.unreadable_answer",
      );
      throw new AppError("SUPPLIER_ERROR", { message: "The supplier's queue answer could not be read." });
    }
    const id = this.ids.newId("qsn");
    const staffId = this.staffIdOf(tenant);
    return await this.tx.run(async (trx) => {
      await this.snapshots.insert(trx, {
        id,
        environment: tenant.environment,
        officeId,
        queueId,
        category,
        maxRequested,
        itemCount: entries.length,
        response: redactPayload(reply.body),
        fetchedByStaffId: staffId,
        supplierRequestId: reply.call.supplierRequestId,
        fetchedAt,
      });
      const snapshot = await this.snapshots.byId(trx, id);
      if (snapshot === undefined) {
        throw new Error("the queue snapshot just stored cannot be read");
      }
      return await this.page(trx, snapshot, 0, limit, this.readerOf(tenant));
    });
  }

  /** The page of `snapshot` that starts at `offset`, its PNRs linked to the OTA's bookings. */
  private async page(
    trx: TenantTransaction,
    snapshot: QueueSnapshotWithResponse,
    offset: number,
    limit: number,
    fetchedBy: ConsoleActor | null,
  ): Promise<QueueListResult> {
    const entries = queueEntriesOf(snapshot.response) ?? [];
    const slice = entries.slice(offset, offset + limit);
    const links = await this.snapshots.bookingLinks(trx, snapshot.environment, slice.map(recordLocatorOf));
    const next = offset + limit;
    const meta = toQueueSnapshot(snapshot, fetchedBy);
    return {
      data: slice.map((entry) => toQueueItem(entry, links.get(recordLocatorOf(entry)))),
      page: { nextCursor: next < entries.length ? encodeQueueCursor(snapshot.id, next) : null, limit },
      snapshot: meta,
      warnings: meta.warnings,
    };
  }

  // ---- console.queues.listSnapshots --------------------------------------------------------------------------------

  /** One page of the environment's snapshots, newest first (see the file header). */
  async listSnapshots(query: ConsoleListQueueSnapshotsQuery): Promise<QueueSnapshotPage> {
    const tenant = this.tenants.require();
    const withItems = query.include?.includes("items") === true;
    const limit = query.limit ?? DEFAULT_CONSOLE_PAGE_LIMIT;
    if (withItems && limit > MAX_SNAPSHOTS_WITH_ITEMS) {
      throw itemsLimitExceeded();
    }
    const fingerprint = queueSnapshotsFingerprint(tenant.environment, query);
    const after = query.cursor === undefined ? undefined : decodeSnapshotsCursor(query.cursor, fingerprint);
    return await this.tx.run(async (trx) => {
      const rows = await this.snapshots.list(
        trx,
        {
          environment: tenant.environment,
          queueId: query.queueId,
          officeId: query.officeId,
          category: query.category,
          fetchedFrom: query.fetchedFrom === undefined ? undefined : new Date(query.fetchedFrom),
          fetchedTo: query.fetchedTo === undefined ? undefined : new Date(query.fetchedTo),
          after,
          limit: limit + 1,
        },
        withItems,
      );
      const page = rows.slice(0, limit);
      const entries = new Map(
        page.map((row) => [row.id, withItems ? (queueEntriesOf(row.response) ?? []) : []]),
      );
      const links = withItems
        ? await this.snapshots.bookingLinks(
            trx,
            tenant.environment,
            [...entries.values()].flat().map(recordLocatorOf),
          )
        : new Map<string, QueueBookingLink>();
      const last = page.at(-1);
      return {
        data: page.map((row) =>
          toQueueSnapshot(
            row,
            snapshotActorOf(row),
            withItems
              ? (entries.get(row.id) ?? []).map((entry) =>
                  toQueueItem(entry, links.get(recordLocatorOf(entry))),
                )
              : undefined,
          ),
        ),
        page: {
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeSnapshotsCursor(fingerprint, last.sortKey, last.id)
              : null,
          limit,
        },
      };
    });
  }

  // ---- Helpers ------------------------------------------------------------------------------------------------------

  private callContext(tenant: RequestTenant): AmadeusCallContext {
    const staffId = this.staffIdOf(tenant);
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: QUEUE_LIST_OPERATION,
      requestId: this.tenants.requestId() ?? tenant.requestId,
      ...(staffId === null ? {} : { staffId }),
    };
  }

  private staffIdOf(tenant: RequestTenant): string | null {
    return tenant.actor.type === "staff" && tenant.actor.id !== null ? tenant.actor.id : null;
  }

  /** Who reads the queue now: the signed-in staff member, with the membership the staff guard read, else the key. */
  private readerOf(tenant: RequestTenant): ConsoleActor {
    const principal = this.staff.get();
    if (principal !== undefined) {
      return {
        type: "staff",
        id: principal.family.staffId,
        name: principal.member.account.fullName,
        email: principal.member.account.email,
        role: principal.member.role,
      };
    }
    return {
      type: tenant.actor.type === "api_key" ? "api_key" : "system",
      id: tenant.actor.type === "api_key" ? tenant.actor.id : null,
      name: null,
      email: null,
      role: null,
    };
  }
}
