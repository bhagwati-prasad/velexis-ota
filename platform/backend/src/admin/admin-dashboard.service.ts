// The counters of the platform admin's home page (PBE-029; platform/docs/api-inventory-admin.md §2 `adminGetDashboard`,
// flows/platform-admin-operations.md): read-only, every count links to its filtered list in the admin.
//
// - `tenantsByStatus`: the OTAs in each status of `TenantStatus`, zero included;
// - `provisioningFailed24h`: tenant jobs of any kind that ended `failed` in the 24 hours before the `Clock`'s now;
// - `jobsFailedByQueue`: the failed BullMQ jobs of every platform queue (`PLATFORM_QUEUES` of
//   `@velexis/api-types/jobs`), zero included. They come from Redis, so a Redis that fails or does not answer within
//   QUEUE_COUNT_TIMEOUT_MS answers `503 SERVICE_UNAVAILABLE` (logged as `admin.dashboard_queues_unavailable`, the
//   error only), like the queue operations;
// - `officePool`: the `available` and `assigned` offices of the Velexis Amadeus account of each environment that has
//   one, `test` before `live` (PADR-0012; the admin warns below 3 available offices);
// - the M5 counters, always present and `null` while their milestone switch is off (PADR-0015), and read only when it
//   is on: `domainsPending` (`custom_domains`), `settlementsToReview` (`settlements`), `stripeEventsFailed`
//   (`stripe_billing` or `own_stripe`) and `subscriptionsPastDue` (`stripe_billing`).
//
// The database counts are one snapshot: one read-only `REPEATABLE READ` transaction, which never holds a lock and
// writes nothing. The Redis counts run next to it, never inside it.
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches, type Feature } from "../common/features";
import { PLATFORM_QUEUES, type PlatformQueueName } from "../common/queues/queue-names";
import { AmadeusAccountsRepository } from "../supplier-connections/amadeus-accounts.repository";
import { AdminDashboardRepository, type TenantStatusCounts } from "./admin-dashboard.repository";

export type AdminDashboard = components["schemas"]["AdminDashboard"];
type OfficePoolLevel = components["schemas"]["OfficePoolLevel"];

/** How long the failed counts of the platform queues may take before the dashboard answers `503`. */
export const QUEUE_COUNT_TIMEOUT_MS = 2000;

/** The window of `provisioningFailed24h`. */
export const PROVISIONING_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What the dashboard needs of a BullMQ queue. */
export type FailedCountSource = Pick<Queue, "getFailedCount">;

/** The database part of the dashboard: one snapshot. */
interface DatabaseCounts {
  readonly tenantsByStatus: TenantStatusCounts;
  readonly provisioningFailed24h: number;
  readonly officePool: OfficePoolLevel[];
  readonly domainsPending: number | null;
  readonly settlementsToReview: number | null;
  readonly stripeEventsFailed: number | null;
  readonly subscriptionsPastDue: number | null;
}

@Injectable()
export class AdminDashboardService implements OnModuleInit {
  private queues: ReadonlyArray<readonly [PlatformQueueName, FailedCountSource]> = [];

  constructor(
    private readonly counters: AdminDashboardRepository,
    private readonly amadeusAccounts: AmadeusAccountsRepository,
    private readonly features: FeatureSwitches,
    private readonly clock: Clock,
    private readonly moduleRef: ModuleRef,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(AdminDashboardService.name) private readonly logger: PinoLogger,
  ) {}

  /** Finds the BullMQ queue of every platform queue (QueuesModule registers them all). */
  onModuleInit(): void {
    this.queues = PLATFORM_QUEUES.map(
      (name) => [name, this.moduleRef.get<Queue>(getQueueToken(name), { strict: false })] as const,
    );
  }

  /** adminGetDashboard: the counters of the admin home page. */
  async get(): Promise<AdminDashboard> {
    const [counts, jobsFailedByQueue] = await Promise.all([this.databaseCounts(), this.failedJobsByQueue()]);
    return {
      tenantsByStatus: counts.tenantsByStatus,
      provisioningFailed24h: counts.provisioningFailed24h,
      jobsFailedByQueue,
      officePool: counts.officePool,
      domainsPending: counts.domainsPending,
      settlementsToReview: counts.settlementsToReview,
      stripeEventsFailed: counts.stripeEventsFailed,
      subscriptionsPastDue: counts.subscriptionsPastDue,
    };
  }

  /** The failed jobs of each platform queue; `503 SERVICE_UNAVAILABLE` when Redis fails or is too slow. */
  async failedJobsByQueue(): Promise<Record<PlatformQueueName, number>> {
    let timer: NodeJS.Timeout | undefined;
    const counted = Promise.all(
      this.queues.map(async ([name, queue]) => [name, await queue.getFailedCount()] as const),
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), QUEUE_COUNT_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([counted, timedOut]);
      if (result === "timeout") {
        this.logger.warn({ timeoutMs: QUEUE_COUNT_TIMEOUT_MS }, "admin.dashboard_queues_unavailable");
        throw new AppError("SERVICE_UNAVAILABLE");
      }
      return Object.fromEntries(result) as Record<PlatformQueueName, number>;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      this.logger.warn({ err: error }, "admin.dashboard_queues_unavailable");
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  /** The counts of the database, in one read-only snapshot. */
  private async databaseCounts(): Promise<DatabaseCounts> {
    const since = new Date(this.clock.now().getTime() - PROVISIONING_FAILED_WINDOW_MS);
    const on = (feature: Feature): boolean => this.features.isEnabled(feature);
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(async (trx) => {
        const tenantsByStatus = await this.counters.tenantsByStatus(trx);
        const provisioningFailed24h = await this.counters.jobsFailedSince(trx, since);
        const accounts = await this.amadeusAccounts.list(trx);
        const offices = await this.amadeusAccounts.officeCounts(
          accounts.map(({ id }) => id),
          trx,
        );
        const officePool = accounts.map((account): OfficePoolLevel => {
          const level = offices.get(account.id);
          return {
            environment: account.environment as OfficePoolLevel["environment"],
            available: level?.available ?? 0,
            assigned: level?.assigned ?? 0,
          };
        });
        return {
          tenantsByStatus,
          provisioningFailed24h,
          officePool,
          domainsPending: on("custom_domains") ? await this.counters.customDomainsPending(trx) : null,
          settlementsToReview: on("settlements") ? await this.counters.draftSettlements(trx) : null,
          stripeEventsFailed:
            on("stripe_billing") || on("own_stripe") ? await this.counters.failedStripeEvents(trx) : null,
          subscriptionsPastDue: on("stripe_billing") ? await this.counters.pastDueSubscriptions(trx) : null,
        };
      });
  }
}
