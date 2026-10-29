// The queue poller without I/O (OBE-065): which queues a run reads and in which order, the batches of a job and its
// continuations, and how a failed read, a refused connection and a retried job end. The poller against PostgreSQL 16,
// Redis 7 and the Amadeus stub, through the worker's fan-out and job runner, is in
// test/integration/console/queues.int.test.ts.
import { AppError } from "@velexis/errors";
import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { AmadeusClient } from "../amadeus/amadeus.client";
import type { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { JOB_BATCH_LIMITS } from "../jobs/limits";
import type { PlatformMonitoredQueues, PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { TenantTx } from "../tenancy/tenant-tx";
import { pollTargets, QUEUE_POLL_MAX, QUEUES_POLL_JOB, QueuePollerProcessor } from "./queue-poller.processor";
import type { QueueKey, QueueSnapshotRecord, QueueSnapshotsRepository } from "./queue-snapshots.repository";
import { QUEUE_POLL_OPERATION } from "./queues.service";

const TENANT: PlatformTenant = Object.freeze({
  id: "ten_01JALPHA0000000000000000AA",
  key: "alpha",
  name: "alpha Travel",
  status: "active",
  schemaName: "tenant_alpha" as PlatformTenant["schemaName"],
  storefrontEnvironment: "live",
  defaultCurrency: "EUR",
  defaultLocale: "en",
  billingNotice: null,
});
const OFFICE = "NCE1A0955";
/** The iteration of the tests: 2026-01-15T10:15:00Z, as a minute bucket. */
const DUE = new Date("2026-01-15T10:15:00.000Z");
const BUCKET = DUE.getTime() / 60_000;

function connection(
  environment: "test" | "live",
  queueIds: readonly number[],
  overrides: Partial<PlatformMonitoredQueues> = {},
): PlatformMonitoredQueues {
  return {
    connectionId: `sc_01J${environment.toUpperCase()}000000000000000000`,
    environment,
    status: "active",
    queues: queueIds.map((queueId) => ({ officeId: OFFICE, queueId, category: 0 })),
    invalid: 0,
    ...overrides,
  };
}

const job = (continuation: number): Job =>
  ({
    id: `${QUEUES_POLL_JOB}:${TENANT.id}:${BUCKET}${continuation === 0 ? "" : `-${continuation}`}`,
    name: QUEUES_POLL_JOB,
    data: { tenantId: TENANT.id, bucket: BUCKET, continuation },
  }) as unknown as Job;

/** The poller over fakes: the platform's list, an Amadeus client that answers `answer`, and stored snapshots. */
function poller(
  connections: readonly PlatformMonitoredQueues[],
  answer: (queue: { queueId: number; environment: string }) => unknown = () => ({
    meta: { count: 0 },
    data: [],
  }),
  polled: (queue: QueueKey) => boolean = () => false,
) {
  const stored: QueueSnapshotRecord[] = [];
  const listQueue = vi.fn(
    (context: { environment: string }, request: { queueId: number; query: Record<string, unknown> }) => {
      const body = answer({ queueId: request.queueId, environment: context.environment });
      if (body instanceof Error) {
        return Promise.reject(body);
      }
      return Promise.resolve({
        body,
        call: { supplierRequestId: null, officeId: request.query["officeId"] },
      });
    },
  );
  const logger = { info: vi.fn(), warn: vi.fn() };
  const processor = new QueuePollerProcessor(
    { monitoredQueues: () => Promise.resolve(connections) } as unknown as PlatformReadRepository,
    { listQueue } as unknown as AmadeusClient,
    { run: (work: (trx: unknown) => Promise<unknown>) => work({}) } as unknown as TenantTx,
    {
      polledSince: (_trx: unknown, queue: QueueKey, since: Date, operation: string) => {
        expect([since, operation]).toEqual([DUE, QUEUE_POLL_OPERATION]);
        return Promise.resolve(polled(queue));
      },
      insert: (_trx: unknown, record: QueueSnapshotRecord) => {
        stored.push(record);
        return Promise.resolve();
      },
    } as unknown as QueueSnapshotsRepository,
    new IdGenerator({ now: () => DUE } as Clock),
    { now: () => DUE } as Clock,
    logger as never,
  );
  return { processor, listQueue, stored, logger };
}

describe("the queues a run reads", () => {
  it("are those of the active connections, test before live, in the platform's order", () => {
    const { targets, inactive, invalid } = pollTargets([
      connection("live", [50, 8], { invalid: 1 }),
      connection("test", [50]),
      connection("test", [9], { status: "invalid_credentials", invalid: 2 }),
    ]);

    expect(targets).toEqual([
      { environment: "test", officeId: OFFICE, queueId: 50, category: 0 },
      { environment: "live", officeId: OFFICE, queueId: 50, category: 0 },
      { environment: "live", officeId: OFFICE, queueId: 8, category: 0 },
    ]);
    expect(inactive).toBe(1);
    expect(invalid).toBe(3);
  });
});

describe("QueuePollerProcessor", () => {
  it("[OBE-065 AC1] stores one snapshot per monitored queue, as the poller, with the call's office and max", async () => {
    const entry = { type: "pnrList", id: "QX8P4L-2026-01-15", travelers: [] };
    const { processor, listQueue, stored } = poller([connection("test", [50, 8])], ({ queueId }) => ({
      meta: { count: queueId === 50 ? 1 : 0 },
      data: queueId === 50 ? [entry] : [],
    }));

    const outcome = await processor.run(TENANT, job(0));

    expect(outcome).toEqual({
      more: false,
      counts: { queues: 2, snapshots: 2, alreadyPolled: 0, failed: 0, skipped: 0, inactive: 0, invalid: 0 },
    });
    expect(listQueue).toHaveBeenCalledTimes(2);
    expect(listQueue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenantId: TENANT.id,
        environment: "test",
        operation: QUEUE_POLL_OPERATION,
        requestId: expect.stringMatching(/^[A-Za-z0-9._-]{8,128}$/),
      }),
      { queueId: 50, query: { category: 0, officeId: OFFICE, max: QUEUE_POLL_MAX } },
    );
    expect(stored).toEqual([
      expect.objectContaining({
        environment: "test",
        officeId: OFFICE,
        queueId: 50,
        category: 0,
        maxRequested: QUEUE_POLL_MAX,
        itemCount: 1,
        response: { meta: { count: 1 }, data: [entry] },
        fetchedByStaffId: null,
        fetchedAt: DUE,
      }),
      expect.objectContaining({ queueId: 8, itemCount: 0 }),
    ]);
    expect(stored[0]?.id).toMatch(/^qsn_/);
  });

  it(`reads ${JOB_BATCH_LIMITS.queuePoll} queues per job and asks for the next job while queues are left`, async () => {
    const size = JOB_BATCH_LIMITS.queuePoll;
    const queueIds = Array.from({ length: size + 2 }, (_, index) => index + 1);
    const first = poller([connection("test", queueIds)]);
    const second = poller([connection("test", queueIds)]);

    await expect(first.processor.run(TENANT, job(0))).resolves.toMatchObject({
      more: true,
      counts: { queues: size, snapshots: size },
    });
    await expect(second.processor.run(TENANT, job(1))).resolves.toMatchObject({
      more: false,
      counts: { queues: 2, snapshots: 2 },
    });
    expect(first.stored.map((record) => record.queueId)).toEqual(queueIds.slice(0, size));
    expect(second.stored.map((record) => record.queueId)).toEqual(queueIds.slice(size));
  });

  it("goes on with the next queue after a failed read and stores nothing for it", async () => {
    const { processor, stored, logger } = poller([connection("test", [50, 8, 9])], ({ queueId }) =>
      queueId === 50
        ? new AppError("OFFICE_NOT_ALLOWED")
        : queueId === 8
          ? { data: { not: "a list" } }
          : { data: [] },
    );

    const outcome = await processor.run(TENANT, job(0));

    expect(outcome.counts).toMatchObject({ queues: 3, snapshots: 1, failed: 2 });
    expect(stored.map((record) => record.queueId)).toEqual([9]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: 50, code: "OFFICE_NOT_ALLOWED", officeId: OFFICE }),
      "queues.poll_failed",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: 8, code: "SUPPLIER_ERROR" }),
      "queues.poll_failed",
    );
  });

  it("does not ask a connection the resolver refused again in the job", async () => {
    const { processor, listQueue, stored } = poller(
      [connection("test", [50, 8]), connection("live", [50])],
      ({ environment }) => (environment === "test" ? new AppError("SUPPLIER_NOT_CONFIGURED") : { data: [] }),
    );

    const outcome = await processor.run(TENANT, job(0));

    expect(outcome.counts).toMatchObject({ queues: 3, snapshots: 1, failed: 2 });
    expect(listQueue).toHaveBeenCalledTimes(2);
    expect(stored.map((record) => record.environment)).toEqual(["live"]);
  });

  it.each(["SUPPLIER_TIMEOUT", "SUPPLIER_UNAVAILABLE"] as const)(
    "[FIX-W32-OTA AC6] asks a connection nothing more in the job after %s, skips its other queues and logs the skip",
    async (code) => {
      const { processor, listQueue, stored, logger } = poller(
        [connection("test", [50, 8, 9]), connection("live", [50])],
        ({ environment }) => (environment === "test" ? new AppError(code) : { data: [] }),
      );

      const outcome = await processor.run(TENANT, job(0));

      // One read of the test connection (the client sent it twice already), none for its two other queues; the live
      // connection is read as usual.
      expect(
        listQueue.mock.calls.map(([context, request]) => [context.environment, request.queueId]),
      ).toEqual([
        ["test", 50],
        ["live", 50],
      ]);
      expect(outcome.counts).toMatchObject({ queues: 4, snapshots: 1, failed: 1, skipped: 2 });
      expect(stored.map((record) => record.environment)).toEqual(["live"]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT.id, environment: "test", code, skipped: 2 }),
        "queues.poll_skipped",
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ skipped: 2, failed: 1, snapshots: 1 }),
        "queues.polled",
      );
    },
  );

  it("[FIX-W32-OTA AC6] goes on reading a connection after another failure (a refusal of one office, an unreadable answer)", async () => {
    const { processor, listQueue, logger } = poller([connection("test", [50, 8, 9])], ({ queueId }) =>
      queueId === 50 ? new AppError("RATE_LIMITED") : { data: [] },
    );

    const outcome = await processor.run(TENANT, job(0));

    expect(listQueue).toHaveBeenCalledTimes(3);
    expect(outcome.counts).toMatchObject({ queues: 3, snapshots: 2, failed: 1, skipped: 0 });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), "queues.poll_skipped");
  });

  it("reads no queue twice for one iteration (a retried job)", async () => {
    const { processor, listQueue, stored } = poller(
      [connection("test", [50, 8])],
      undefined,
      (queue) => queue.queueId === 50,
    );

    const outcome = await processor.run(TENANT, job(0));

    expect(outcome.counts).toMatchObject({ queues: 2, snapshots: 1, alreadyPolled: 1 });
    expect(listQueue).toHaveBeenCalledTimes(1);
    expect(stored.map((record) => record.queueId)).toEqual([8]);
  });

  it("rethrows what is not an API error (a bug), so the job fails", async () => {
    const { processor } = poller([connection("test", [50])], () => new TypeError("boom"));

    await expect(processor.run(TENANT, job(0))).rejects.toThrow(TypeError);
  });

  it("reads nothing for a tenant without monitored queues", async () => {
    const { processor, listQueue, logger } = poller([connection("test", [])]);

    await expect(processor.run(TENANT, job(0))).resolves.toEqual({
      more: false,
      counts: { queues: 0, snapshots: 0, alreadyPolled: 0, failed: 0, skipped: 0, inactive: 0, invalid: 0 },
    });
    expect(listQueue).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
