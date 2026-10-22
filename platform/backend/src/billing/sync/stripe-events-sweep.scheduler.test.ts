// `stripe_events.sweep` (PBE-043; architecture §5) on fakes: the cut-off of 2 minutes on the Clock, and what it does
// with the BullMQ job of each row it finds. The sweep against PostgreSQL and Redis runs in
// test/integration/billing/billing-webhook.int.test.ts.
import { FakeClock } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../../common/clock";
import type { PlatformDb } from "../../common/database";
import type {
  StripeEventSweepCriteria,
  StripeEventsRepository,
} from "../../common/stripe/stripe-events.repository";
import { STRIPE_EVENT_JOB } from "../../common/stripe/stripe-inbox.service";
import {
  STRIPE_EVENTS_SWEEP_JOB,
  StripeEventsSweepScheduler,
  SWEEP_AGE_MS,
  SWEEP_BATCH_SIZE,
  SWEEP_PROCESSING_AGE_MS,
} from "./stripe-events-sweep.scheduler";

const NOW = new Date("2026-01-15T10:00:00Z");

/** A sweep over `candidates`, whose BullMQ jobs are in `states` (absent: no job). */
function sweep(candidates: readonly string[], states: Readonly<Record<string, string>>, removable = true) {
  const criteria: StripeEventSweepCriteria[] = [];
  const repository = {
    sweepCandidates: (_db: unknown, given: StripeEventSweepCriteria) => {
      criteria.push(given);
      return Promise.resolve([...candidates]);
    },
  } as unknown as StripeEventsRepository;
  const removed: string[] = [];
  const add = vi.fn<Queue["add"]>().mockResolvedValue({} as Job);
  const queue = {
    getJob: (id: string) =>
      Promise.resolve(
        states[id] === undefined
          ? undefined
          : ({
              getState: () => Promise.resolve(states[id]),
              remove: () => {
                if (!removable) {
                  return Promise.reject(new Error("locked by another worker"));
                }
                removed.push(id);
                return Promise.resolve();
              },
            } as unknown as Job),
      ),
    add,
  } as unknown as Queue;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const scheduler = new StripeEventsSweepScheduler(
    repository,
    {} as PlatformDb,
    new FakeClock(NOW) as unknown as Clock,
    queue,
    logger as unknown as PinoLogger,
  );
  return { scheduler, criteria, removed, add, logger };
}

describe("StripeEventsSweepScheduler", () => {
  it("is the stripe_events.sweep schedule, for rows unchanged for 2 minutes (processing: 10), 100 a run", async () => {
    const { scheduler, criteria } = sweep([], {});

    expect(STRIPE_EVENTS_SWEEP_JOB).toBe("stripe_events.sweep");
    expect(await scheduler.run()).toEqual({ candidates: 0, enqueued: 0 });
    expect(criteria).toEqual([
      {
        before: new Date(NOW.getTime() - SWEEP_AGE_MS),
        processingBefore: new Date(NOW.getTime() - SWEEP_PROCESSING_AGE_MS),
        limit: SWEEP_BATCH_SIZE,
      },
    ]);
    expect([SWEEP_AGE_MS, SWEEP_PROCESSING_AGE_MS]).toEqual([120_000, 600_000]);
  });

  it("[PBE-043 AC3] queues stripe.event for a row whose job is missing, with the event id as job id", async () => {
    const { scheduler, add, logger } = sweep(["evt_test_lost"], {});

    expect(await scheduler.run()).toEqual({ candidates: 1, enqueued: 1 });
    expect(add.mock.calls).toEqual([
      [STRIPE_EVENT_JOB, { eventId: "evt_test_lost" }, { jobId: "evt_test_lost" }],
    ]);
    expect(logger.info).toHaveBeenCalledWith({ candidates: 1, enqueued: 1 }, "stripe_events.sweep");
  });

  it("leaves a row to a job that will still run, and replaces a finished one", async () => {
    const live = ["waiting", "delayed", "active", "prioritized", "waiting-children"];
    const states = Object.fromEntries([
      ...live.map((state) => [`evt_test_${state.replace("-", "_")}`, state]),
      ["evt_test_completed", "completed"],
      ["evt_test_failed", "failed"],
    ]);
    const { scheduler, add, removed } = sweep(Object.keys(states), states);

    expect(await scheduler.run()).toEqual({ candidates: 7, enqueued: 2 });
    expect(removed).toEqual(["evt_test_completed", "evt_test_failed"]);
    expect(add.mock.calls.map(([, data]) => data)).toEqual([
      { eventId: "evt_test_completed" },
      { eventId: "evt_test_failed" },
    ]);
  });

  it("leaves a row for the next run when its finished job cannot be removed", async () => {
    const { scheduler, add, logger } = sweep(
      ["evt_test_completed"],
      { evt_test_completed: "completed" },
      false,
    );

    expect(await scheduler.run()).toEqual({ candidates: 1, enqueued: 0 });
    expect(add).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt_test_completed" }),
      "stripe_events.sweep_remove_failed",
    );
  });
});
