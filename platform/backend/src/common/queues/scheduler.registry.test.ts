// The job schedulers of the platform worker (PBE-009; platform/docs/architecture.md §5): the schedules of the table,
// their registration with upsertJobScheduler, and the milestone switches that keep M5 schedules out (PADR-0015).
import type { Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import {
  JobSchedulerRegistry,
  PLATFORM_SCHEDULES,
  REGISTRATION_SETTLE_MS,
  SCHEDULE_TIME_ZONE,
  configuredSwitches,
  isScheduleEnabled,
  registerSchedules,
  switchVariable,
  type MilestoneSwitch,
  type MilestoneSwitches,
  type SchedulerQueue,
} from "./scheduler.registry";

/** architecture §5: each scheduler with its "When (UTC)" and milestone, in the order of the table. */
const ARCHITECTURE_TABLE: ReadonlyArray<readonly [id: string, when: string, milestone: "M1" | "M5"]> = [
  ["provisioning.reconcile", "every 5 min", "M1"],
  ["api_keys.flush_usage", "every 5 min", "M1"],
  ["invitations.expire", "hourly", "M1"],
  ["provisioning.purge_reveals", "hourly", "M1"],
  ["purge.daily", "02:50", "M1"],
  ["amadeus.pool_level", "06:55", "M1"],
  ["domains.verify_pending", "every 5 min", "M5"],
  ["domains.recheck_verified", "04:10", "M5"],
  ["domains.tls_probe", "04:40", "M5"],
  ["stripe_events.sweep", "every 5 min", "M5"],
  ["billing.abandoned_checkouts", "03:20", "M5"],
  ["billing.manual_trials", "08:10", "M5"],
  ["settlements.monthly", "05:00 on day 3", "M5"],
];

/** The cron pattern a "When (UTC)" of the table allows (`hourly`: any minute). */
function patternFor(when: string): RegExp {
  if (when === "every 5 min") {
    return /^\*\/5 \* \* \* \*$/;
  }
  if (when === "hourly") {
    return /^[1-5]?[0-9] \* \* \* \*$/;
  }
  const daily = /^(\d{2}):(\d{2})(?: on day (\d+))?$/.exec(when);
  if (daily === null) {
    throw new Error(`no pattern for ${when}`);
  }
  const [, hour, minute, day] = daily;
  return new RegExp(`^${Number(minute)} ${Number(hour)} ${day ?? "\\*"} \\* \\*$`);
}

/** Switches with the listed ones on. */
function switchesOn(...on: MilestoneSwitch[]): MilestoneSwitches {
  return { isEnabled: (feature) => on.includes(feature) };
}

/** A queue double that records upserts and removals and holds `existing` schedulers. */
function fakeQueue(existing: readonly string[] = []): {
  queue: SchedulerQueue;
  upserted: string[];
  removed: string[];
  upsert: ReturnType<typeof vi.fn>;
} {
  const upserted: string[] = [];
  const removed: string[] = [];
  const stored = new Set(existing);
  const upsert = vi.fn((id: string) => {
    upserted.push(id);
    stored.add(id);
    return Promise.resolve({});
  });
  const queue = {
    upsertJobScheduler: upsert,
    removeJobScheduler: vi.fn((id: string) => {
      removed.push(id);
      return Promise.resolve(stored.delete(id));
    }),
    getJobSchedulers: vi.fn(() =>
      Promise.resolve([...stored].map((key) => ({ key, name: key, pattern: "* * * * *" }))),
    ),
  };
  return { queue: queue as unknown as SchedulerQueue, upserted, removed, upsert };
}

const M1 = PLATFORM_SCHEDULES.filter((schedule) => schedule.milestone === "M1").map(
  (schedule) => schedule.id,
);
const M5 = PLATFORM_SCHEDULES.filter((schedule) => schedule.milestone === "M5").map(
  (schedule) => schedule.id,
);

describe("PLATFORM_SCHEDULES", () => {
  it("are the schedulers of architecture §5, with its times in UTC and its milestones", () => {
    expect(PLATFORM_SCHEDULES.map((schedule) => [schedule.id, schedule.milestone])).toEqual(
      ARCHITECTURE_TABLE.map(([id, , milestone]) => [id, milestone]),
    );
    for (const [id, when] of ARCHITECTURE_TABLE) {
      const schedule = PLATFORM_SCHEDULES.find((candidate) => candidate.id === id);
      expect(schedule?.pattern, id).toMatch(patternFor(when));
    }
    expect(SCHEDULE_TIME_ZONE).toBe("UTC");
  });

  it("put every M5 schedule behind a milestone switch and no M1 schedule behind one", () => {
    for (const schedule of PLATFORM_SCHEDULES) {
      expect(schedule.features.length > 0, schedule.id).toBe(schedule.milestone === "M5");
      expect(Object.isFrozen(schedule) && Object.isFrozen(schedule.features), schedule.id).toBe(true);
    }
    const featureOf = Object.fromEntries(
      PLATFORM_SCHEDULES.map((schedule) => [schedule.id, schedule.features]),
    );
    expect(featureOf).toMatchObject({
      "domains.verify_pending": ["custom_domains"],
      "domains.recheck_verified": ["custom_domains"],
      "domains.tls_probe": ["custom_domains"],
      "stripe_events.sweep": ["stripe_billing", "own_stripe"],
      "billing.abandoned_checkouts": ["stripe_billing"],
      "billing.manual_trials": ["stripe_billing"],
      "settlements.monthly": ["settlements"],
    });
    expect(Object.isFrozen(PLATFORM_SCHEDULES)).toBe(true);
  });
});

describe("registerSchedules", () => {
  it("[PBE-009 AC5] registers no scheduler for a disabled feature: with every switch off only the M1 schedules", async () => {
    const { queue, upserted } = fakeQueue();

    const result = await registerSchedules(queue, PLATFORM_SCHEDULES, switchesOn());

    expect(upserted).toEqual(M1);
    expect(result).toEqual({ registered: M1, skipped: M5, removed: [] });
  });

  it("[PBE-009 AC5] registers the schedules of a switch that is on, and still none of the switches that are off", async () => {
    const { queue, upserted } = fakeQueue();

    const result = await registerSchedules(queue, PLATFORM_SCHEDULES, switchesOn("custom_domains"));

    expect(upserted).toEqual([
      ...M1,
      "domains.verify_pending",
      "domains.recheck_verified",
      "domains.tls_probe",
    ]);
    expect(result.skipped).toEqual([
      "stripe_events.sweep",
      "billing.abandoned_checkouts",
      "billing.manual_trials",
      "settlements.monthly",
    ]);
  });

  it("[PBE-009 AC5] removes a scheduler left in Redis when its switch is now off, or when it is no schedule any more", async () => {
    const { queue, upserted, removed } = fakeQueue([
      "settlements.monthly",
      "provisioning.reconcile",
      "old.job",
    ]);

    const result = await registerSchedules(queue, PLATFORM_SCHEDULES, switchesOn());

    expect(upserted).not.toContain("settlements.monthly");
    expect(removed.sort()).toEqual(["old.job", "settlements.monthly"]);
    expect([...result.removed].sort()).toEqual(["old.job", "settlements.monthly"]);
  });

  it("registers a schedule with several switches while any one of them is on", () => {
    const sweep = PLATFORM_SCHEDULES.find((schedule) => schedule.id === "stripe_events.sweep");
    if (sweep === undefined) {
      throw new Error("stripe_events.sweep is missing");
    }

    expect(isScheduleEnabled(sweep, switchesOn())).toBe(false);
    expect(isScheduleEnabled(sweep, switchesOn("own_stripe"))).toBe(true);
    expect(isScheduleEnabled(sweep, switchesOn("stripe_billing"))).toBe(true);
  });

  it("upserts each scheduler with its id as job name, its UTC pattern and an empty payload", async () => {
    const { queue, upsert } = fakeQueue();

    await registerSchedules(queue, PLATFORM_SCHEDULES, switchesOn());

    expect(upsert).toHaveBeenCalledWith(
      "purge.daily",
      { pattern: "50 2 * * *", tz: "UTC" },
      { name: "purge.daily", data: {} },
    );
  });
});

describe("configuredSwitches", () => {
  it("reads FEATURE_<SWITCH> and counts only the boolean true as on", () => {
    const values: Record<string, unknown> = {
      FEATURE_CUSTOM_DOMAINS: true,
      FEATURE_STRIPE_BILLING: false,
      FEATURE_SETTLEMENTS: "true",
    };
    const switches = configuredSwitches({ get: ((name: string) => values[name]) as never });

    expect(switchVariable("own_amadeus")).toBe("FEATURE_OWN_AMADEUS");
    expect(switches.isEnabled("custom_domains")).toBe(true);
    expect(switches.isEnabled("stripe_billing")).toBe(false);
    expect(switches.isEnabled("settlements")).toBe(false);
    // Not in the configuration at all: off (PADR-0015 item 1).
    expect(switches.isEnabled("live_switch")).toBe(false);
  });
});

/** A logger double that keeps `[level, object, message]`. */
function fakeLogger(): { logger: PinoLogger; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const logger = {
    info: (object: unknown, message: string) => lines.push(["info", object, message]),
    error: (object: unknown, message: string) => lines.push(["error", object, message]),
  };
  return { logger: logger as unknown as PinoLogger, lines };
}

describe("JobSchedulerRegistry", () => {
  it("registers in the background when the worker starts and logs what it did", async () => {
    const { queue } = fakeQueue(["old.job"]);
    const { logger, lines } = fakeLogger();
    const registry = new JobSchedulerRegistry(queue as unknown as Queue, switchesOn(), logger);

    registry.onApplicationBootstrap();
    await registry.beforeApplicationShutdown();

    expect(lines).toEqual([
      ["info", { registered: M1, skipped: M5, removed: ["old.job"] }, "scheduler.registered"],
    ]);
  });

  it("logs a failed registration, and a shutdown waits for a registration that hangs at most a bounded time", async () => {
    vi.useFakeTimers();
    try {
      const failing = fakeQueue();
      failing.upsert.mockRejectedValueOnce(new Error("NOSCRIPT"));
      const failed = fakeLogger();
      const registry = new JobSchedulerRegistry(
        failing.queue as unknown as Queue,
        switchesOn(),
        failed.logger,
      );
      registry.onApplicationBootstrap();
      await registry.beforeApplicationShutdown();
      expect(failed.lines).toEqual([
        ["error", { err: expect.objectContaining({ message: "NOSCRIPT" }) }, "scheduler.registration_failed"],
      ]);

      const hanging = fakeQueue();
      hanging.upsert.mockReturnValue(new Promise(() => undefined));
      const quiet = fakeLogger();
      const stuck = new JobSchedulerRegistry(hanging.queue as unknown as Queue, switchesOn(), quiet.logger);
      stuck.onApplicationBootstrap();
      const shutdown = stuck.beforeApplicationShutdown();
      await vi.advanceTimersByTimeAsync(REGISTRATION_SETTLE_MS);
      await expect(shutdown).resolves.toBeUndefined();
      expect(quiet.lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
