// The OTA queues (OBE-002): the names appended to `OTA_QUEUES` of @velexis/api-types, their concurrency from
// ota/docs/architecture.md §6 and the job defaults of ADR-0009 item 7, with the hour `ota-maintenance` keeps its
// completed jobs since OBE-101 (ADR-0009 item 7, revision of 2026-11-11).
import {
  BULLMQ_PREFIX as SHARED_PREFIX,
  OTA_QUEUES as SHARED_OTA_QUEUES,
  PLATFORM_QUEUES,
} from "@velexis/api-types/jobs";
import { describe, expect, it } from "vitest";
import {
  BULLMQ_PREFIX,
  DEFAULT_JOB_OPTIONS,
  KEEP_COMPLETED_JOBS,
  KEEP_COMPLETED_MAINTENANCE_JOBS,
  KEEP_FAILED_JOBS,
  keepCompletedJobs,
  OTA_BACKEND_QUEUES,
  OTA_QUEUE,
  OTA_QUEUE_CONCURRENCY,
  OTA_QUEUES,
  otaWorkerOptions,
  PLATFORM_TENANT_EVENTS,
  RETRY_BACKOFF_TOTAL_SECONDS,
} from "./queue-names";

const DAY_SECONDS = 86_400;
/** The on-VM check's alert on a job that waits for a worker (`QUEUE_AGE_MAX` of deploy/scripts/healthcheck.sh). */
const QUEUE_AGE_ALERT_SECONDS = 600;

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

  it("[OBE-101 AC1] keeps the completed jobs of ota-maintenance 1 hour and those of every other queue 1 day", () => {
    expect(KEEP_COMPLETED_MAINTENANCE_JOBS).toEqual({ age: 3_600 });
    expect(KEEP_COMPLETED_JOBS).toEqual({ age: DAY_SECONDS });
    expect(Object.isFrozen(KEEP_COMPLETED_MAINTENANCE_JOBS)).toBe(true);
    for (const queue of OTA_QUEUES) {
      const kept = queue === "ota-maintenance" ? { age: 3_600 } : { age: DAY_SECONDS };
      expect(keepCompletedJobs(queue)).toEqual(kept);
      expect(otaWorkerOptions(queue)).toEqual({
        concurrency: OTA_QUEUE_CONCURRENCY[queue],
        removeOnFail: { age: 30 * DAY_SECONDS },
        removeOnComplete: kept,
      });
    }
    // The queues' own defaults stay the day of ADR-0009 item 7: the maintenance jobs carry their hour themselves
    // (jobs/fan-out.ts, jobs/schedulers.ts).
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toBe(KEEP_COMPLETED_JOBS);
  });

  it("[OBE-101 AC2] still keeps the failed jobs of every queue 30 days", () => {
    expect(KEEP_FAILED_JOBS).toEqual({ age: 30 * DAY_SECONDS });
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBe(KEEP_FAILED_JOBS);
    for (const queue of OTA_QUEUES) {
      expect(otaWorkerOptions(queue).removeOnFail).toBe(KEEP_FAILED_JOBS);
    }
  });

  it("[OBE-101 AC1] keeps a completed maintenance job longer than a scheduler iteration's retries can come", () => {
    // The backoffs of the default options added up: 30 s, 60 s, 120 s and 240 s before attempts 2 to 5.
    const backoff = DEFAULT_JOB_OPTIONS.backoff;
    const delay = typeof backoff === "object" ? (backoff.delay ?? 0) : 0;
    const attempts = DEFAULT_JOB_OPTIONS.attempts ?? 1;
    const backoffs = Array.from({ length: attempts - 1 }, (_, retry) => (delay / 1000) * 2 ** retry);
    expect(backoffs).toEqual([30, 60, 120, 240]);
    expect(RETRY_BACKOFF_TOTAL_SECONDS).toBe(450);
    expect(backoffs.reduce((a, b) => a + b, 0)).toBe(RETRY_BACKOFF_TOTAL_SECONDS);
    // A fan-out retried after it added the per-tenant jobs builds their ids again at its last attempt at the latest:
    // the 7.5 minutes of backoffs plus four waits for a worker below the on-VM check's alert. BullMQ must still hold
    // the jobs that completed meanwhile, or they would run twice for one iteration.
    const age = "age" in KEEP_COMPLETED_MAINTENANCE_JOBS ? KEEP_COMPLETED_MAINTENANCE_JOBS.age : 0;
    expect(age).toBeGreaterThan(RETRY_BACKOFF_TOTAL_SECONDS + (attempts - 1) * QUEUE_AGE_ALERT_SECONDS);
  });
});
