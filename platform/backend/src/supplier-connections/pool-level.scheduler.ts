// `amadeus.pool_level` (platform/docs/architecture.md §5, daily at 06:55 UTC; PADR-0012 item 6, flows/
// amadeus-connection.md §A step 4): for the Velexis Amadeus account of each environment that is not `disabled`, count
// the `available` offices of its pool, and when fewer than POOL_LEVEL_MINIMUM remain, e-mail ops an `ops.alert`. Offices
// are ordered from Amadeus outside the system and added in bulk (`adminAddAmadeusOffices`), so the alert comes a few
// days before provisioning finds the pool empty.
//
// The alert is queued through the outbox with the idempotency key `amadeus.pool_level:<environment>:<UTC date>`, so a
// retried or repeated run of one day sends one e-mail per environment, and the next day's run reminds ops again while
// the pool stays low. The run logs `amadeus.pool_level` with the counts per environment.
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { MaintenanceJob, type MaintenanceJobHandler } from "../common/queues/maintenance.processor";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { OutboxService } from "../notifications/outbox.service";
import { AmadeusOfficesRepository, type AmadeusPoolLevel } from "./amadeus-offices.repository";

/** The schedule and job name (scheduler.registry.ts). */
export const AMADEUS_POOL_LEVEL_JOB = "amadeus.pool_level";

/** Fewer available offices than this in an environment e-mails ops (PADR-0012 item 6). */
export const POOL_LEVEL_MINIMUM = 3;

/** What a finished run returns (BullMQ keeps it with the job): the counts, never an address. */
export interface PoolLevelResult {
  readonly levels: ReadonlyArray<{ readonly environment: string; readonly available: number }>;
  /** The environments whose alert was queued by this run (not those of an earlier run of the day). */
  readonly alerted: readonly string[];
}

/** The `ops.alert` of a low pool. */
export function poolLevelAlert(level: AmadeusPoolLevel): { title: string; message: string } {
  const offices = level.available === 1 ? "office is" : "offices are";
  return {
    title: `Amadeus office pool low (${level.environment}): ${level.available} available`,
    message:
      `Only ${level.available} ${offices} available in the pool of the Velexis Amadeus account ` +
      `"${level.name}" (${level.amadeusAccountId}, ${level.environment}); the minimum is ${POOL_LEVEL_MINIMUM}. ` +
      "Order new office ids from Amadeus and add them in the platform admin (Amadeus, Offices). " +
      (level.environment === "test"
        ? "New OTAs get no test office while the pool is empty."
        : "Live access requests cannot be served while the pool is empty."),
  };
}

@Injectable()
@MaintenanceJob(AMADEUS_POOL_LEVEL_JOB)
export class PoolLevelScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly offices: AmadeusOfficesRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(PoolLevelScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<PoolLevelResult> {
    const day = this.clock.now().toISOString().slice(0, 10);
    const levels = await this.offices.poolLevels();
    const alerted: string[] = [];
    for (const level of levels.filter(({ available }) => available < POOL_LEVEL_MINIMUM)) {
      const queued = await runInTransaction(this.db, (trx) =>
        this.outbox.queueOpsAlert(trx, {
          ...poolLevelAlert(level),
          idempotencyKey: `${AMADEUS_POOL_LEVEL_JOB}:${level.environment}:${day}`,
        }),
      );
      if (queued.queued) {
        alerted.push(level.environment);
      }
    }
    const result: PoolLevelResult = {
      levels: levels.map(({ environment, available }) => ({ environment, available })),
      alerted,
    };
    this.logger.info({ ...result, minimum: POOL_LEVEL_MINIMUM }, "amadeus.pool_level");
    return result;
  }
}
