// AdminDashboardService without a database or Redis (PBE-029; platform/docs/api-inventory-admin.md §2): what the
// integration test cannot provoke with its configuration and a working Redis, that is the M5 counters with their
// milestone switches on (read and answered as numbers, each only under its own switch), the 24-hour window of
// `provisioningFailed24h` on the Clock, the office pool by environment, and `503 SERVICE_UNAVAILABLE` when the BullMQ
// counts fail or take longer than QUEUE_COUNT_TIMEOUT_MS. The switches-off answer is proven over HTTP in
// test/integration/admin/admin-tenants.int.test.ts.
import type { ModuleRef } from "@nestjs/core";
import { PLATFORM_QUEUES } from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../common/database";
import type { Feature, FeatureSwitches } from "../common/features";
import type { AmadeusAccountsRepository } from "../supplier-connections/amadeus-accounts.repository";
import type { AdminDashboardRepository } from "./admin-dashboard.repository";
import {
  AdminDashboardService,
  PROVISIONING_FAILED_WINDOW_MS,
  QUEUE_COUNT_TIMEOUT_MS,
  type FailedCountSource,
} from "./admin-dashboard.service";

interface Harness {
  readonly service: AdminDashboardService;
  readonly clock: FakeClock;
  /** The repository methods called, in order, with the `since` of the failed jobs. */
  readonly calls: string[];
  readonly since: Date[];
  readonly warnings: string[];
  /** The access mode and isolation level of each transaction. */
  readonly transactions: string[];
}

function harness(options: {
  readonly features?: readonly Feature[];
  readonly failedCount?: (queue: string) => Promise<number>;
}): Harness {
  const calls: string[] = [];
  const since: Date[] = [];
  const warnings: string[] = [];
  const transactions: string[] = [];
  const clock = new FakeClock();
  const counted = (name: string, value: number) => (): Promise<number> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  const counters = {
    tenantsByStatus: () => {
      calls.push("tenantsByStatus");
      return Promise.resolve({ provisioning: 1, active: 14, suspended: 1, failed: 2 });
    },
    jobsFailedSince: (_db: unknown, from: Date) => {
      calls.push("jobsFailedSince");
      since.push(from);
      return Promise.resolve(3);
    },
    customDomainsPending: counted("customDomainsPending", 4),
    draftSettlements: counted("draftSettlements", 5),
    failedStripeEvents: counted("failedStripeEvents", 6),
    pastDueSubscriptions: counted("pastDueSubscriptions", 7),
  } as unknown as AdminDashboardRepository;
  const amadeusAccounts = {
    list: () =>
      Promise.resolve([
        { id: "ama_test", environment: "test" },
        { id: "ama_live", environment: "live" },
      ]),
    officeCounts: () =>
      Promise.resolve(
        new Map([
          ["ama_test", { available: 6, assigned: 17, releasing: 1, retired: 2 }],
          ["ama_live", { available: 2, assigned: 9, releasing: 0, retired: 0 }],
        ]),
      ),
  } as unknown as AmadeusAccountsRepository;
  const enabled = new Set(options.features ?? []);
  const features = { isEnabled: (feature: Feature) => enabled.has(feature) } as unknown as FeatureSwitches;
  const failedCount =
    options.failedCount ?? ((queue: string) => Promise.resolve(queue === "platform-emails" ? 2 : 0));
  const moduleRef = {
    get: (token: string): FailedCountSource => {
      const queue = PLATFORM_QUEUES.find((name) => token.endsWith(name)) ?? token;
      return { getFailedCount: () => failedCount(queue) };
    },
  } as unknown as ModuleRef;
  const db = {
    transaction: () => {
      const settings: string[] = [];
      const builder = {
        setIsolationLevel: (level: string) => {
          settings.push(level);
          return builder;
        },
        setAccessMode: (mode: string) => {
          settings.push(mode);
          return builder;
        },
        execute: (fn: (trx: object) => Promise<unknown>) => {
          transactions.push(settings.join(", "));
          return fn({});
        },
      };
      return builder;
    },
  } as unknown as PlatformDb;
  const logger = {
    warn: (_fields: unknown, message: string) => {
      warnings.push(message);
    },
  } as unknown as PinoLogger;
  const service = new AdminDashboardService(
    counters,
    amadeusAccounts,
    features,
    clock,
    moduleRef,
    db,
    logger,
  );
  service.onModuleInit();
  return { service, clock, calls, since, warnings, transactions };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AdminDashboardService.get", () => {
  it("[PBE-029 AC3] answers the M5 counters null and reads none of them while every switch is off", async () => {
    const { service, calls, since, clock, transactions } = harness({});

    const dashboard = await service.get();

    expect(dashboard).toEqual({
      tenantsByStatus: { provisioning: 1, active: 14, suspended: 1, failed: 2 },
      provisioningFailed24h: 3,
      jobsFailedByQueue: Object.fromEntries(
        PLATFORM_QUEUES.map((queue) => [queue, queue === "platform-emails" ? 2 : 0]),
      ),
      officePool: [
        { environment: "test", available: 6, assigned: 17 },
        { environment: "live", available: 2, assigned: 9 },
      ],
      domainsPending: null,
      settlementsToReview: null,
      stripeEventsFailed: null,
      subscriptionsPastDue: null,
    });
    expect(calls).toEqual(["tenantsByStatus", "jobsFailedSince"]);
    expect(since).toEqual([new Date(clock.now().getTime() - PROVISIONING_FAILED_WINDOW_MS)]);
    expect(transactions).toEqual(["repeatable read, read only"]);
  });

  it("answers each M5 counter as a number once its switch is on", async () => {
    const all = harness({ features: ["custom_domains", "settlements", "stripe_billing"] });
    expect(await all.service.get()).toMatchObject({
      domainsPending: 4,
      settlementsToReview: 5,
      stripeEventsFailed: 6,
      subscriptionsPastDue: 7,
    });

    // `own_stripe` alone shows the failed Stripe events (the Connect endpoint), not the past-due subscriptions.
    const ownStripe = harness({ features: ["own_stripe"] });
    expect(await ownStripe.service.get()).toMatchObject({
      domainsPending: null,
      settlementsToReview: null,
      stripeEventsFailed: 6,
      subscriptionsPastDue: null,
    });
    expect(ownStripe.calls).toEqual(["tenantsByStatus", "jobsFailedSince", "failedStripeEvents"]);
  });

  it("answers 503 SERVICE_UNAVAILABLE when a BullMQ count fails, and logs it without the counts", async () => {
    const { service, warnings } = harness({
      failedCount: (queue) =>
        queue === "platform-domains"
          ? Promise.reject(new Error("Connection is closed."))
          : Promise.resolve(0),
    });

    const failure = await service.get().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("SERVICE_UNAVAILABLE");
    expect(warnings).toEqual(["admin.dashboard_queues_unavailable"]);
  });

  it("answers 503 SERVICE_UNAVAILABLE when Redis does not answer the counts in time", async () => {
    vi.useFakeTimers();
    const { service, warnings } = harness({ failedCount: () => new Promise<number>(() => undefined) });

    const pending = service.get().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(QUEUE_COUNT_TIMEOUT_MS);
    const failure = await pending;

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("SERVICE_UNAVAILABLE");
    expect(warnings).toEqual(["admin.dashboard_queues_unavailable"]);
  });
});
