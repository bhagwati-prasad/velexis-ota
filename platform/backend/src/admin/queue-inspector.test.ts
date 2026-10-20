// The pure parts of the platform admin's queue inspector (PBE-031, ADR-0009 items 4 and 11): the queues of both
// backends with their owners, the counts and age of one queue, the failed-job view, and the `503` while Redis cannot
// answer. The counts against a real Redis are in test/integration/admin/admin-jobs.int.test.ts.
import { OTA_QUEUES, PLATFORM_QUEUES } from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import {
  INSPECTED_QUEUES,
  QueueInspector,
  queueOwnerOf,
  toFailedQueueJob,
  toQueueCounts,
} from "./queue-inspector";

describe("INSPECTED_QUEUES", () => {
  it("lists every platform queue, then every OTA queue, each owned by the backend whose worker consumes it", () => {
    expect(INSPECTED_QUEUES).toEqual([
      ...PLATFORM_QUEUES.map((name) => ({ name, owner: "platform" })),
      ...OTA_QUEUES.map((name) => ({ name, owner: "ota" })),
    ]);
    expect(queueOwnerOf("ota-tenant-ops")).toBe("ota");
    expect(queueOwnerOf("platform-tenant-events")).toBe("platform");
    expect(queueOwnerOf("platform-unknown")).toBeUndefined();
    expect(queueOwnerOf("ota-unknown")).toBeUndefined();
  });
});

describe("toQueueCounts", () => {
  const queue = { name: "platform-emails", owner: "platform" } as const;
  const now = new Date("2026-10-19T08:00:00.000Z");

  it("counts paused and prioritized jobs as waiting, and ages the oldest waiting job in whole seconds", () => {
    expect(
      toQueueCounts(
        queue,
        { waiting: 2, paused: 1, prioritized: 1, active: 3, delayed: 4, failed: 5 },
        now.getTime() - 42_999,
        now,
      ),
    ).toEqual({
      name: "platform-emails",
      owner: "platform",
      waiting: 4,
      active: 3,
      delayed: 4,
      failed: 5,
      oldestWaitingSeconds: 42,
    });
  });

  it("answers zero for states BullMQ did not count, null without a waiting job, and never a negative age", () => {
    expect(toQueueCounts(queue, {}, undefined, now)).toEqual({
      name: "platform-emails",
      owner: "platform",
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      oldestWaitingSeconds: null,
    });
    expect(toQueueCounts(queue, { waiting: 1 }, now.getTime() + 5_000, now).oldestWaitingSeconds).toBe(0);
  });
});

describe("toFailedQueueJob", () => {
  it("answers the reason, attempts and failure time, and passes the data through the shared redactor", () => {
    const finishedOn = Date.parse("2026-10-19T07:59:00.000Z");
    expect(
      toFailedQueueJob({
        id: "1843",
        name: "email.send",
        failedReason: "SMTP 451: temporary local problem, try again later",
        attemptsMade: 5,
        finishedOn,
        data: { emailId: "eml_01JC3M7P1R5T9W3Y7A1C5E9G3J", password: "not-a-real-password" },
      }),
    ).toEqual({
      id: "1843",
      name: "email.send",
      failedReason: "SMTP 451: temporary local problem, try again later",
      attemptsMade: 5,
      failedAt: "2026-10-19T07:59:00.000Z",
      data: { emailId: "eml_01JC3M7P1R5T9W3Y7A1C5E9G3J", password: "[REDACTED]" },
    });
  });

  it("answers an empty id without one, null without a reason or a time, and {} for data that is not an object", () => {
    expect(
      toFailedQueueJob({
        name: "domain.verify",
        failedReason: undefined as unknown as string,
        attemptsMade: 0,
        data: "dom_01JB3K5N9Q3S7W1Y5A9C3E7G1J",
      }),
    ).toEqual({
      id: "",
      name: "domain.verify",
      failedReason: null,
      attemptsMade: 0,
      failedAt: null,
      data: {},
    });
  });
});

describe("QueueInspector while Redis cannot answer", () => {
  it("answers 503 SERVICE_UNAVAILABLE and logs the queue, never hanging on the command", async () => {
    // Port 1 of the loopback refuses at once; no reconnection, so the commands fail on the spot.
    const redis = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    const logger = { warn: vi.fn() };
    const inspector = new QueueInspector(redis, new FakeClock() as never, logger as unknown as PinoLogger);
    try {
      const failure: unknown = await inspector
        .listFailed("platform-emails", 10)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).toBe("SERVICE_UNAVAILABLE");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ queue: "platform-emails" }),
        "admin.queue_unavailable",
      );
    } finally {
      await inspector.onApplicationShutdown();
      redis.disconnect();
    }
  });
});
