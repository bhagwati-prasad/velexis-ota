// The job schedulers of the platform worker (PBE-009; platform/docs/architecture.md §5, ADR-0009 item 8). Every
// schedule of the architecture's table is declared here, in code, and the worker registers them with BullMQ's
// `upsertJobScheduler` when it starts: one scheduler per schedule on the `platform-maintenance` queue, whose id and
// job name are the schedule's id (`provisioning.reconcile`), with an empty payload. The modules that own the work
// (provisioning, API keys, invitations, …) consume these jobs by name when they add their processors.
//
// M5 schedules belong to a milestone switch of PADR-0015 (item 2: "a check in the schedulers"). A schedule whose
// switches are all off is not registered, and a scheduler left in Redis from a run with the switch on, or from a
// schedule that no longer exists, is removed, so turning a switch off stops its schedules at the next worker start.
//
// Registration runs in the background: the worker serves its health checks while Redis is down, and the BullMQ
// connection waits for Redis instead of failing, so the schedulers are registered once Redis is back. Until a
// processor consumes the queue, each scheduler keeps exactly one waiting job (BullMQ adds the next iteration when a
// worker takes the current one), so nothing piles up.
import { InjectQueue } from "@nestjs/bullmq";
import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type FactoryProvider,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PLATFORM_QUEUE } from "./queue-names";

/** The milestone switches of PADR-0015, as `x-feature` and `FEATURE_<SWITCH>` name them. */
export type MilestoneSwitch =
  "stripe_billing" | "own_stripe" | "settlements" | "own_amadeus" | "custom_domains" | "live_switch";

/** One schedule of architecture §5. */
export interface ScheduleDefinition {
  /** The scheduler id and the name of its jobs, e.g. `provisioning.reconcile`. */
  readonly id: string;
  /** A cron pattern (minute hour day-of-month month day-of-week), evaluated in UTC. */
  readonly pattern: string;
  /** The milestone that adds the schedule's work. */
  readonly milestone: "M1" | "M5";
  /** Registered only while at least one of these switches is on; empty for the schedules without a switch. */
  readonly features: readonly MilestoneSwitch[];
  /** What it does, as architecture §5 says. */
  readonly description: string;
}

/** The time zone of every pattern: architecture §5 gives the times in UTC. */
export const SCHEDULE_TIME_ZONE = "UTC";

function schedule(definition: ScheduleDefinition): ScheduleDefinition {
  return Object.freeze({ ...definition, features: Object.freeze([...definition.features]) });
}

/** The schedules of architecture §5, in the order of its table. */
export const PLATFORM_SCHEDULES: readonly ScheduleDefinition[] = Object.freeze([
  schedule({
    id: "provisioning.reconcile",
    pattern: "*/5 * * * *",
    milestone: "M1",
    features: [],
    description:
      "Dispatch due queued provisioning jobs whose gate is open; re-dispatch running jobs past locked_until whose BullMQ job is gone or failed",
  }),
  schedule({
    id: "api_keys.flush_usage",
    pattern: "*/5 * * * *",
    milestone: "M1",
    features: [],
    description: "Move apikey:used:<keyId> into api_keys.last_used_at and last_used_ip",
  }),
  schedule({
    id: "invitations.expire",
    pattern: "5 * * * *",
    milestone: "M1",
    features: [],
    description: "Pending invitations past expires_at become expired",
  }),
  schedule({
    id: "provisioning.purge_reveals",
    pattern: "35 * * * *",
    milestone: "M1",
    features: [],
    description: "Erase reveal-once key ciphertext older than 24 hours",
  }),
  schedule({
    id: "purge.daily",
    pattern: "50 2 * * *",
    milestone: "M1",
    features: [],
    description:
      "Purge consumed or expired account_tokens, expired account_sessions, sent email_outbox, processed stripe_events and final credential_submissions past their retention",
  }),
  schedule({
    id: "amadeus.pool_level",
    pattern: "55 6 * * *",
    milestone: "M1",
    features: [],
    description: "E-mail ops when fewer than 3 available offices remain per environment",
  }),
  schedule({
    id: "domains.verify_pending",
    pattern: "*/5 * * * *",
    milestone: "M5",
    features: ["custom_domains"],
    description: "domain.verify for each pending custom domain; failed past the 72-hour deadline",
  }),
  schedule({
    id: "domains.recheck_verified",
    pattern: "10 4 * * *",
    milestone: "M5",
    features: ["custom_domains"],
    description: "domain.recheck for each verified custom domain",
  }),
  schedule({
    id: "domains.tls_probe",
    pattern: "40 4 * * *",
    milestone: "M5",
    features: ["custom_domains"],
    description: "domain.tls_probe for every storefront host",
  }),
  schedule({
    id: "stripe_events.sweep",
    pattern: "*/5 * * * *",
    milestone: "M5",
    // The inbox holds the billing events and the Connect account events (PADR-0015 item 4).
    features: ["stripe_billing", "own_stripe"],
    description:
      "Enqueue received or retryable failed inbox rows older than 2 minutes whose BullMQ job is missing",
  }),
  schedule({
    id: "billing.abandoned_checkouts",
    pattern: "20 3 * * *",
    milestone: "M5",
    features: ["stripe_billing"],
    description: "Tenants provisioning with an incomplete subscription older than 48 hours become failed",
  }),
  schedule({
    id: "billing.manual_trials",
    pattern: "10 8 * * *",
    milestone: "M5",
    features: ["stripe_billing"],
    description: "Trial-ending notices and suspension of manual trials",
  }),
  schedule({
    id: "settlements.monthly",
    pattern: "0 5 3 * *",
    milestone: "M5",
    features: ["settlements"],
    description: "settlement.generate for the previous month",
  }),
]);

/** Reads the milestone switches. */
export interface MilestoneSwitches {
  isEnabled(feature: MilestoneSwitch): boolean;
}

/** Injection token of the MilestoneSwitches the registry reads. */
export const SCHEDULER_SWITCHES = Symbol("SCHEDULER_SWITCHES");

/** `FEATURE_STRIPE_BILLING` for `stripe_billing`: the configuration variable of a switch (PADR-0015 item 1). */
export function switchVariable(feature: MilestoneSwitch): string {
  return `FEATURE_${feature.toUpperCase()}`;
}

/**
 * The switches of the process configuration: a switch is on only when its `FEATURE_*` variable is the boolean
 * `true`. A variable the configuration does not define (yet) is off, as PADR-0015 item 1 and conventions §8 require.
 */
export function configuredSwitches(config: Pick<ConfigService, "get">): MilestoneSwitches {
  return {
    isEnabled: (feature) => config.get<unknown>(switchVariable(feature)) === true,
  };
}

/** The provider of SCHEDULER_SWITCHES from the process configuration. */
export const schedulerSwitchesProvider: FactoryProvider<MilestoneSwitches> = {
  provide: SCHEDULER_SWITCHES,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => configuredSwitches(config),
};

/** True when the schedule has no switch or at least one of its switches is on. */
export function isScheduleEnabled(definition: ScheduleDefinition, switches: MilestoneSwitches): boolean {
  return (
    definition.features.length === 0 || definition.features.some((feature) => switches.isEnabled(feature))
  );
}

/** The queue methods the registry uses: a BullMQ `Queue`, or a test double. */
export type SchedulerQueue = Pick<Queue, "upsertJobScheduler" | "removeJobScheduler" | "getJobSchedulers">;

/** What a registration did, by schedule id. */
export interface ScheduleRegistration {
  /** Upserted: enabled schedules. */
  readonly registered: readonly string[];
  /** Not registered because every switch of the schedule is off. */
  readonly skipped: readonly string[];
  /** Schedulers found in Redis that are not registered now (a switch turned off, a schedule removed). */
  readonly removed: readonly string[];
}

/**
 * Upserts a scheduler for every enabled schedule of `definitions`, skips the others, and removes every scheduler of
 * the queue that is not one of the upserted ones.
 */
export async function registerSchedules(
  queue: SchedulerQueue,
  definitions: readonly ScheduleDefinition[],
  switches: MilestoneSwitches,
): Promise<ScheduleRegistration> {
  const registered: string[] = [];
  const skipped: string[] = [];
  for (const definition of definitions) {
    if (!isScheduleEnabled(definition, switches)) {
      skipped.push(definition.id);
      continue;
    }
    await queue.upsertJobScheduler(
      definition.id,
      { pattern: definition.pattern, tz: SCHEDULE_TIME_ZONE },
      { name: definition.id, data: {} },
    );
    registered.push(definition.id);
  }
  const removed: string[] = [];
  for (const existing of await queue.getJobSchedulers(0, -1)) {
    if (!registered.includes(existing.key)) {
      await queue.removeJobScheduler(existing.key);
      removed.push(existing.key);
    }
  }
  return { registered, skipped, removed };
}

/** How long a shutting-down worker waits at most for a registration still under way (Redis down: for ever). */
export const REGISTRATION_SETTLE_MS = 1000;

/**
 * Registers PLATFORM_SCHEDULES on `platform-maintenance` when the worker starts (WorkerModule), in the background.
 * Logs `scheduler.registered` (ids registered, skipped and removed) or `scheduler.registration_failed`.
 */
@Injectable()
export class JobSchedulerRegistry implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private registration: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectQueue(PLATFORM_QUEUE.maintenance) private readonly queue: Queue,
    @Inject(SCHEDULER_SWITCHES) private readonly switches: MilestoneSwitches,
    @InjectPinoLogger(JobSchedulerRegistry.name) private readonly logger: PinoLogger,
  ) {}

  /** The registration of PLATFORM_SCHEDULES, as the worker runs it at start. */
  register(): Promise<ScheduleRegistration> {
    return registerSchedules(this.queue, PLATFORM_SCHEDULES, this.switches);
  }

  onApplicationBootstrap(): void {
    this.registration = this.register().then(
      (result) => {
        this.logger.info({ ...result }, "scheduler.registered");
      },
      (error: unknown) => {
        // A shutdown that closes the queue while Redis is still away ends the registration: not worth an error.
        if (!this.stopping) {
          this.logger.error({ err: error }, "scheduler.registration_failed");
        }
      },
    );
  }

  /** Lets a registration under way finish before the queue closes, for at most REGISTRATION_SETTLE_MS. */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.registration === undefined) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, REGISTRATION_SETTLE_MS);
    });
    try {
      await Promise.race([this.registration, timeout]);
    } finally {
      clearTimeout(timer);
      this.stopping = true;
    }
  }
}
