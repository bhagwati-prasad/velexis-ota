// AdminDashboardService without a database or Redis (PBE-029; platform/docs/api-inventory-admin.md §2): what the
// integration test cannot provoke with its configuration and a working Redis, that is the M5 counters with their
// milestone switches on (read and answered as numbers, each only under its own switch), the 24-hour window of
// `provisioningFailed24h` on the Clock, the office pool by environment, and `503 SERVICE_UNAVAILABLE` when the BullMQ
// counts fail or take longer than QUEUE_COUNT_TIMEOUT_MS, and the live office requests mapped from the repository's
// rows (FIX-W41-PLATFORM). The switches-off answer is proven over HTTP in
// test/integration/admin/admin-tenants.int.test.ts, the live office requests' rule in
// test/integration/admin/admin-dashboard.int.test.ts.
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
  LIVE_OFFICE_REQUESTS_LIMIT,
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
  /** The `limit` of each read of the live office requests. */
  readonly liveLimits: number[];
}

/** Two OTAs waiting for a live office, oldest first, as the repository answers them. */
const LIVE_ROWS = [
  {
    tenant_id: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F",
    tenant_key: "acme",
    tenant_name: "Acme Travel",
    connection_id: "sc_01JC4M2P6R0T4W8Y2A6C0E4G8K",
    requested_at: new Date("2027-03-01T09:12:00.000Z"),
  },
  {
    tenant_id: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5G",
    tenant_key: "nordic",
    tenant_name: "Nordic Fares",
    connection_id: "sc_01JC4M2P6R0T4W8Y2A6C0E4G8M",
    requested_at: new Date("2027-03-02T14:02:00.000Z"),
  },
];

function harness(options: {
  readonly features?: readonly Feature[];
  readonly failedCount?: (queue: string) => Promise<number>;
  readonly liveRows?: typeof LIVE_ROWS;
}): Harness {
  const calls: string[] = [];
  const since: Date[] = [];
  const warnings: string[] = [];
  const transactions: string[] = [];
  const liveLimits: number[] = [];
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
    liveOfficeRequests: (_db: unknown, limit: number) => {
      calls.push("liveOfficeRequests");
      liveLimits.push(limit);
      return Promise.resolve(options.liveRows ?? []);
    },
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
  return { service, clock, calls, since, warnings, transactions, liveLimits };
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
      liveOfficeRequests: [],
    });
    expect(calls).toEqual(["tenantsByStatus", "jobsFailedSince", "liveOfficeRequests"]);
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
    expect(ownStripe.calls).toEqual([
      "tenantsByStatus",
      "jobsFailedSince",
      "failedStripeEvents",
      "liveOfficeRequests",
    ]);
  });

  it("[FIX-W41-PLATFORM AC9] answers the live office requests of the repository, in its order, bounded, in the snapshot", async () => {
    const { service, liveLimits, transactions } = harness({ liveRows: LIVE_ROWS });

    const dashboard = await service.get();

    expect(dashboard.liveOfficeRequests).toEqual([
      {
        tenantId: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F",
        tenantKey: "acme",
        tenantName: "Acme Travel",
        connectionId: "sc_01JC4M2P6R0T4W8Y2A6C0E4G8K",
        requestedAt: "2027-03-01T09:12:00.000Z",
      },
      {
        tenantId: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5G",
        tenantKey: "nordic",
        tenantName: "Nordic Fares",
        connectionId: "sc_01JC4M2P6R0T4W8Y2A6C0E4G8M",
        requestedAt: "2027-03-02T14:02:00.000Z",
      },
    ]);
    // Bounded by the document's `maxItems`, and read in the dashboard's one read-only snapshot.
    expect(liveLimits).toEqual([LIVE_OFFICE_REQUESTS_LIMIT]);
    expect(LIVE_OFFICE_REQUESTS_LIMIT).toBe(50);
    expect(transactions).toEqual(["repeatable read, read only"]);
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
