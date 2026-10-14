// The OTA queues (OBE-002): the names appended to `OTA_QUEUES` of @velexis/api-types, their concurrency from
// ota/docs/architecture.md §6 and the job defaults of ADR-0009 item 7.
import {
  BULLMQ_PREFIX as SHARED_PREFIX,
  OTA_QUEUES as SHARED_OTA_QUEUES,
  PLATFORM_QUEUES,
} from "@velexis/api-types/jobs";
import { describe, expect, it } from "vitest";
import {
  BULLMQ_PREFIX,
  DEFAULT_JOB_OPTIONS,
  OTA_BACKEND_QUEUES,
  OTA_QUEUE,
  OTA_QUEUE_CONCURRENCY,
  OTA_QUEUES,
  otaWorkerOptions,
  PLATFORM_TENANT_EVENTS,
} from "./queue-names";

/** ota/docs/architecture.md §6: the queues the OTA worker consumes and their concurrency, in the table's order. */
const ARCHITECTURE_SECTION_6 = [
  ["ota-tenant-ops", 2],
  ["ota-stripe-events", 4],
  ["ota-payments", 4],
  ["ota-bookings", 4],
  ["ota-ticketing", 2],
  ["ota-notifications", 4],
  ["ota-documents", 2],
  ["ota-maintenance", 2],
] as const;

describe("OTA queue names", () => {
  it("appends the OTA queues of architecture §6 to OTA_QUEUES of @velexis/api-types [OBE-002 AC3]", () => {
    expect([...SHARED_OTA_QUEUES]).toEqual(ARCHITECTURE_SECTION_6.map(([name]) => name));
    expect(OTA_QUEUES).toBe(SHARED_OTA_QUEUES);
    expect(Object.isFrozen(SHARED_OTA_QUEUES)).toBe(true);
    // Every queue has one owner (ADR-0009 item 4): no OTA queue is also a platform queue.
    expect(SHARED_OTA_QUEUES.filter((name) => (PLATFORM_QUEUES as readonly string[]).includes(name))).toEqual(
      [],
    );
  });

  it("names every OTA queue once by topic, with its concurrency from architecture §6", () => {
    expect(Object.values(OTA_QUEUE)).toEqual([...OTA_QUEUES]);
    expect(Object.entries(OTA_QUEUE_CONCURRENCY)).toEqual(
      ARCHITECTURE_SECTION_6.map(([name, n]) => [name, n]),
    );
    expect(Object.isFrozen(OTA_QUEUE)).toBe(true);
    expect(Object.isFrozen(OTA_QUEUE_CONCURRENCY)).toBe(true);
  });

  it("opens the consumed queues and the platform-tenant-events queue it produces", () => {
    expect(OTA_BACKEND_QUEUES).toEqual([...OTA_QUEUES, PLATFORM_TENANT_EVENTS]);
    expect(PLATFORM_TENANT_EVENTS).toBe("platform-tenant-events");
  });

  it("uses the vx prefix and the job defaults of ADR-0009", () => {
    expect(BULLMQ_PREFIX).toBe("vx");
    expect(BULLMQ_PREFIX).toBe(SHARED_PREFIX);
    expect(DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnFail: { age: 2_592_000 },
      removeOnComplete: { age: 86_400 },
    });
    expect(Object.isFrozen(DEFAULT_JOB_OPTIONS)).toBe(true);
  });

  it("gives each processor its queue's concurrency and the retention of ADR-0009", () => {
    expect(otaWorkerOptions(OTA_QUEUE.tenantOps)).toEqual({
      concurrency: 2,
      removeOnFail: { age: 2_592_000 },
      removeOnComplete: { age: 86_400 },
    });
    expect(otaWorkerOptions(OTA_QUEUE.notifications).concurrency).toBe(4);
  });
});
