// The console queues without I/O (OBE-065): Queue List entries as the document's QueueItem (linked or orphan), the
// warnings, who read a stored snapshot, the two cursors, and the refusals of the service before any read. The reads
// against PostgreSQL 16, Redis 7 and the Amadeus stub are in test/integration/console/queues.int.test.ts.
import { isAppError } from "@velexis/errors";
import { describe, expect, it, vi } from "vitest";
import type { AmadeusClient } from "../amadeus/amadeus.client";
import type { StaffContext } from "../common/auth/staff.guard";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { TenantContext } from "../tenancy/tenant-context";
import type { TenantTx } from "../tenancy/tenant-tx";
import type { QueueSnapshotRow, QueueSnapshotsRepository } from "./queue-snapshots.repository";
import {
  decodeQueueCursor,
  decodeSnapshotsCursor,
  encodeQueueCursor,
  encodeSnapshotsCursor,
  MAX_SNAPSHOTS_WITH_ITEMS,
  QUEUE_LIST_OPERATION,
  QUEUE_POLL_OPERATION,
  queueEntriesOf,
  queueSnapshotsFingerprint,
  QueuesService,
  snapshotActorOf,
  toQueueItem,
  toQueueSnapshot,
  warningsOf,
} from "./queues.service";

/** A Queue List entry as the specification writes it (the stub's form). */
const ENTRY = Object.freeze({
  type: "pnrList",
  id: "QX8P4L-2026-10-10",
  creation: { dateTime: "2026-10-10T09:20" },
  travelers: [
    { names: [{ firstName: "ANNA", lastName: "BERG" }] },
    {
      names: [
        { firstName: "LEO", lastName: "BERG" },
        { firstName: "LEOPOLD", lastName: "BERG" },
      ],
    },
    { names: [] },
  ],
  products: [
    {
      airSegment: {
        segment: {
          carrierCode: "AF",
          number: "6",
          arrival: { iataCode: "JFK", localDateTime: "2026-11-20T12:45:00" },
        },
      },
    },
    { service: { code: "SEAT" } },
  ],
});

const SNAPSHOT_ID = "qsn_01JA4G2M5P8S1V4Y7B0E3H6K9N";

function snapshotRow(overrides: Partial<QueueSnapshotRow> = {}): QueueSnapshotRow {
  return {
    id: SNAPSHOT_ID,
    environment: "test",
    officeId: "NCE1A0950",
    queueId: 50,
    category: 0,
    maxRequested: 100,
    itemCount: 1,
    fetchedByStaffId: null,
    supplierRequestId: "sreq_01JA4G2M4N7Q0T3W6Z9C2F5J8M",
    fetchedVia: QUEUE_POLL_OPERATION,
    fetchedAt: new Date("2026-10-10T10:00:03.000Z"),
    sortKey: "2026-10-10T10:00:03.000000",
    warnings: null,
    ...overrides,
  };
}

const invalidCursorError = expect.objectContaining({
  code: "VALIDATION_FAILED",
  fieldErrors: [expect.objectContaining({ path: "/query/cursor" })],
});

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("Queue List entries", () => {
  it("[OBE-065 AC2] show an entry without a booking of the OTA as an orphan, wrapping the entry verbatim", () => {
    const item = toQueueItem(structuredClone(ENTRY), undefined);

    expect(item).toEqual({
      pnrId: "QX8P4L-2026-10-10",
      recordLocator: "QX8P4L",
      creationDateTime: "2026-10-10T09:20",
      travelers: [
        { firstName: "ANNA", lastName: "BERG" },
        { firstName: "LEO", lastName: "BERG" },
      ],
      segments: [
        {
          carrierCode: "AF",
          number: "6",
          arrivalIataCode: "JFK",
          arrivalLocalDateTime: "2026-11-20T12:45:00",
        },
      ],
      bookingId: null,
      bookingReference: null,
      bookingStatus: null,
      amadeus: ENTRY,
    });
  });

  it("show an entry of a booking of the OTA as linked to it", () => {
    const item = toQueueItem(structuredClone(ENTRY), {
      bookingId: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
      reference: "VX7K2Q",
      status: "confirmed",
    });

    expect(item).toMatchObject({
      recordLocator: "QX8P4L",
      bookingId: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
      bookingReference: "VX7K2Q",
      bookingStatus: "confirmed",
    });
  });

  it("keep what an entry of another shape lacks as empty or null, never failing", () => {
    expect(
      toQueueItem({ id: 7, travelers: "x", products: [{ airSegment: { segment: {} } }] }, undefined),
    ).toEqual({
      pnrId: "",
      recordLocator: "",
      creationDateTime: null,
      travelers: [],
      segments: [{ carrierCode: null, number: null, arrivalIataCode: null, arrivalLocalDateTime: null }],
      bookingId: null,
      bookingReference: null,
      bookingStatus: null,
      amadeus: { id: 7, travelers: "x", products: [{ airSegment: { segment: {} } }] },
    });
  });

  it("are the objects of `data`; an answer without data is an empty queue, any other answer unreadable", () => {
    expect(queueEntriesOf({ meta: { count: 2 }, data: [ENTRY, "x", null, ENTRY] })).toEqual([ENTRY, ENTRY]);
    expect(queueEntriesOf({ meta: { count: 0 } })).toEqual([]);
    expect(queueEntriesOf({ data: { id: "QX8P4L" } })).toBeUndefined();
    expect(queueEntriesOf([ENTRY])).toBeUndefined();
    expect(queueEntriesOf(undefined)).toBeUndefined();
  });

  it("pass the warnings on with the documented fields only", () => {
    expect(
      warningsOf([
        {
          code: 1797,
          title: "NOT FOUND",
          detail: "no PNR",
          source: { parameter: "max", other: 1 },
          status: 200,
        },
        { title: 7 },
        "x",
      ]),
    ).toEqual([
      { code: 1797, title: "NOT FOUND", detail: "no PNR", source: { parameter: "max" } },
      { title: "" },
    ]);
    expect(warningsOf(undefined)).toEqual([]);
  });
});

describe("stored snapshots", () => {
  it("name a staff member's read by the staff id, a key's read as a key's, and the poller's as null", () => {
    expect(
      snapshotActorOf({
        fetchedByStaffId: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y",
        fetchedVia: QUEUE_LIST_OPERATION,
      }),
    ).toEqual({ type: "staff", id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y", name: null, email: null, role: null });
    expect(snapshotActorOf({ fetchedByStaffId: null, fetchedVia: QUEUE_LIST_OPERATION })).toEqual({
      type: "api_key",
      id: null,
      name: null,
      email: null,
      role: null,
    });
    expect(snapshotActorOf({ fetchedByStaffId: null, fetchedVia: QUEUE_POLL_OPERATION })).toBeNull();
    // A snapshot whose supplier request is gone counts as the poller's.
    expect(snapshotActorOf({ fetchedByStaffId: null, fetchedVia: null })).toBeNull();
  });

  it("are answered as QueueSnapshot, with their items only when asked", () => {
    const row = snapshotRow({ warnings: [{ title: "QUEUE EMPTY" }] });

    expect(toQueueSnapshot(row, null)).toEqual({
      id: SNAPSHOT_ID,
      environment: "test",
      officeId: "NCE1A0950",
      queueId: 50,
      category: 0,
      maxRequested: 100,
      itemCount: 1,
      fetchedAt: "2026-10-10T10:00:03.000Z",
      fetchedBy: null,
      supplierRequestId: "sreq_01JA4G2M4N7Q0T3W6Z9C2F5J8M",
      warnings: [{ title: "QUEUE EMPTY" }],
    });
    expect(toQueueSnapshot(row, null, [])).toHaveProperty("items", []);
  });
});

describe("cursors", () => {
  it("of a queue page carry the snapshot and the offset of the next page", () => {
    const cursor = encodeQueueCursor(SNAPSHOT_ID, 40);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeQueueCursor(cursor)).toEqual({ snapshotId: SNAPSHOT_ID, offset: 40 });
  });

  it.each([
    ["not base64url JSON", "%%%"],
    ["empty", ""],
    ["of another list", encodeSnapshotsCursor("abc", "2026-10-10T10:00:03.000000", SNAPSHOT_ID)],
    ["with an offset of 0", encodeQueueCursor(SNAPSHOT_ID, 0)],
    ["with another id", encodeQueueCursor("bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2", 20)],
    [
      "with an offset that is no integer",
      Buffer.from(JSON.stringify(["q", 1, SNAPSHOT_ID, 1.5])).toString("base64url"),
    ],
  ])("of a queue page refuse a value %s", (_label, value) => {
    expect(caught(() => decodeQueueCursor(value))).toEqual(invalidCursorError);
  });

  it("of the snapshots list are bound to the environment and the filters", () => {
    const query = { queueId: 50, officeId: "NCE1A0950", fetchedFrom: "2026-10-10T00:00:00+02:00" };
    const fingerprint = queueSnapshotsFingerprint("test", query);
    const cursor = encodeSnapshotsCursor(fingerprint, "2026-10-10T10:00:03.123456", SNAPSHOT_ID);

    expect(decodeSnapshotsCursor(cursor, fingerprint)).toEqual({
      key: "2026-10-10T10:00:03.123456",
      id: SNAPSHOT_ID,
    });
    // The same instant written another way is the same list.
    expect(queueSnapshotsFingerprint("test", { ...query, fetchedFrom: "2026-10-09T22:00:00Z" })).toBe(
      fingerprint,
    );
    for (const other of [
      queueSnapshotsFingerprint("live", query),
      queueSnapshotsFingerprint("test", { ...query, queueId: 8 }),
      queueSnapshotsFingerprint("test", { ...query, include: ["items"] }),
    ]) {
      expect(other).not.toBe(fingerprint);
      expect(caught(() => decodeSnapshotsCursor(cursor, other))).toEqual(invalidCursorError);
    }
    expect(caught(() => decodeSnapshotsCursor(encodeQueueCursor(SNAPSHOT_ID, 20), fingerprint))).toEqual(
      invalidCursorError,
    );
  });
});

describe("QueuesService refusals", () => {
  const tenant = {
    tenantId: "ten_01JA2X7Q9M3K5N8P1R4T6V0W2Y",
    key: "alpha",
    schemaName: "tenant_alpha",
    environment: "test",
    caller: { type: "secret_key", id: "key_01JA2X7Q9M3K5N8P1R4T6V0W2Y" },
    actor: { type: "staff", id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y" },
    requestId: "req-00000001",
  };

  function service(stored: Record<string, unknown> | undefined) {
    const repository = {
      byId: vi.fn(() => Promise.resolve(stored)),
      list: vi.fn(() => Promise.resolve([])),
      bookingLinks: vi.fn(() => Promise.resolve(new Map())),
    };
    const amadeus = { listQueue: vi.fn() };
    const tx = { run: (work: (trx: unknown) => Promise<unknown>) => work({}) };
    const queues = new QueuesService(
      tx as unknown as TenantTx,
      repository as unknown as QueueSnapshotsRepository,
      amadeus as unknown as AmadeusClient,
      { require: () => tenant, requestId: () => tenant.requestId } as unknown as TenantContext,
      { get: () => undefined } as unknown as StaffContext,
      new IdGenerator(new Clock()),
      new Clock(),
      { warn: vi.fn() } as never,
    );
    return { queues, repository, amadeus };
  }

  it.each([
    ["another queue", { queueId: 8 }, {}],
    ["another environment", { environment: "live" }, {}],
    ["another category", {}, { category: 3 }],
    ["another office", {}, { officeId: "NCE1A0951" }],
  ])("answer 400 for a cursor of %s, with no Amadeus call", async (_label, row, query) => {
    const { queues, amadeus } = service({ ...snapshotRow(row), response: { data: [ENTRY] } });

    const error = await queues
      .list(50, { cursor: encodeQueueCursor(SNAPSHOT_ID, 20), ...query })
      .catch((failure: unknown) => failure);

    expect(isAppError(error)).toBe(true);
    expect(error).toEqual(invalidCursorError);
    expect(amadeus.listQueue).not.toHaveBeenCalled();
  });

  it("answer 400 for a cursor of a snapshot that is gone (retained 30 days)", async () => {
    const { queues } = service(undefined);

    await expect(queues.list(50, { cursor: encodeQueueCursor(SNAPSHOT_ID, 20) })).rejects.toEqual(
      invalidCursorError,
    );
  });

  it(`answer 400 for more than ${MAX_SNAPSHOTS_WITH_ITEMS} snapshots with their items, before any read`, async () => {
    const { queues, repository } = service(undefined);

    await expect(
      queues.listSnapshots({ include: ["items"], limit: MAX_SNAPSHOTS_WITH_ITEMS + 1 }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        fieldErrors: [expect.objectContaining({ path: "/query/limit", code: "maximum" })],
      }),
    );
    expect(repository.list).not.toHaveBeenCalled();
    await expect(
      queues.listSnapshots({ include: ["items"], limit: MAX_SNAPSHOTS_WITH_ITEMS }),
    ).resolves.toEqual({
      data: [],
      page: { nextCursor: null, limit: MAX_SNAPSHOTS_WITH_ITEMS },
    });
    await expect(queues.listSnapshots({ limit: 100 })).resolves.toMatchObject({ page: { limit: 100 } });
  });
});
