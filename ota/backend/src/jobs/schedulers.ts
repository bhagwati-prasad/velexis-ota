// The job schedulers of the OTA worker (OBE-024; OADR-0014 point 1, ota/docs/architecture.md §6, ADR-0009 item 8).
// Every schedule of the architecture's table is declared here, in code, and the worker registers them with BullMQ's
// `upsertJobScheduler` when it starts: one scheduler per schedule on `ota-maintenance`, whose id is the schedule's id
// (`offers.purge`). Each iteration adds one small `fan-out` job (`{task: "<schedule id>"}`); the maintenance processor
// (fan-out.ts) lists the schedule's target tenants and enqueues one `<schedule id>` job per tenant, with a
// deterministic id, which the module that owns the work handles (`@TenantJob("<schedule id>")`). Schedules join this
// list with the task that adds their work (M3: notifications.sweep with OBE-030, payments.authorisation_watch with
// OBE-040, ticketing.scan with OBE-044, bookings.reconcile_scan with OBE-043, checkouts.expire, …; M4: queues.poll).
//
// Target tenants (OADR-0014 point 4): a schedule names the statuses it runs for, `active` and possibly `suspended`
// (suspended tenants keep their obligations to paid travellers, but nothing that starts new supplier activity runs for
// them); `provisioning`, `failed`, `deprovisioning` and `deleted` tenants are never targets, and the types say so.
//
// Registration happens at start-up, after the BullMQ connection's first attempt: when Redis answers, the worker
// registers the schedulers before it reports itself started, so its start-up log names them (`scheduler.registered`,
// with the ids registered and removed); while Redis is down it starts anyway (its health port must answer) and the
// registration continues in the background, once BullMQ is connected. A scheduler left in Redis by an earlier
// release whose schedule no longer exists is removed. Each scheduler keeps exactly one waiting job (BullMQ adds the
// next iteration when a worker takes the current one), so nothing piles up while the worker is stopped.
import { InjectQueue } from "@nestjs/bullmq";
import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { REDIS_BULLMQ_CONNECTION } from "../common/redis/redis.module";

/** The tenant statuses a schedule may target (OADR-0014 points 1 and 4). */
export const FAN_OUT_STATUSES = ["active", "suspended"] as const;
export type FanOutStatus = (typeof FAN_OUT_STATUSES)[number];

/** One schedule of architecture §6. */
export interface ScheduleDefinition {
  /**
   * The scheduler id, the task of its fan-out jobs and the name of its per-tenant jobs, e.g. `offers.purge`: lower
   * case words joined by dots or underscores, never a `:` (the job ids `<task>:<tenantId>:<minute bucket>` and
   * BullMQ's `repeat:<scheduler id>:<millis>` have exactly three parts).
   */
  readonly id: string;
  /** A cron pattern (minute hour day-of-month month day-of-week), evaluated in UTC. */
  readonly pattern: string;
  /** The milestone that adds the schedule's work. */
  readonly milestone: "M2" | "M3" | "M4";
  /** The statuses of the tenants it runs for (the per-task filter): `active`, and `suspended` where it applies. */
  readonly statuses: readonly FanOutStatus[];
  /** What it does, as architecture §6 says. */
  readonly description: string;
}

/** The time zone of every pattern: architecture §6 gives the times in UTC. */
export const SCHEDULE_TIME_ZONE = "UTC";

/** The name of the job each scheduler iteration adds: the fan-out of its schedule. */
export const FAN_OUT_JOB = "fan-out";

/** The payload of a `fan-out` job: the schedule id, nothing else. */
export interface FanOutJobData {
  readonly task: string;
}

const SCHEDULE_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** Checks and freezes a schedule definition; a malformed one is a programming error and stops the module load. */
function schedule(definition: ScheduleDefinition): ScheduleDefinition {
  if (!SCHEDULE_ID.test(definition.id)) {
    throw new TypeError(`schedule ${JSON.stringify(definition.id)}: the id must be dotted lower-case words`);
  }
  if (
    definition.statuses.length === 0 ||
    definition.statuses.some((status) => !FAN_OUT_STATUSES.includes(status))
  ) {
    throw new TypeError(
      `schedule ${definition.id}: statuses must be a non-empty list of active and suspended`,
    );
  }
  return Object.freeze({ ...definition, statuses: Object.freeze([...new Set(definition.statuses)]) });
}

/** The schedules of architecture §6 that this release runs, in the order of its table. */
export const OTA_SCHEDULES: readonly ScheduleDefinition[] = Object.freeze([
  schedule({
    id: "offers.purge",
    pattern: "*/15 * * * *",
    milestone: "M2",
    // Housekeeping of the tenant's own tables: it starts no supplier activity, so suspended tenants are purged too.
    statuses: ["active", "suspended"],
    description:
      "Delete expired searches (with their offers, upsells and priced offers) unless a checkout references one of their priced offers",
  }),
  schedule({
    id: "notifications.sweep",
    pattern: "* * * * *",
    milestone: "M3",
    // The e-mails of a suspended OTA's existing bookings and accounts are still sent (OADR-0014 point 4).
    statuses: ["active", "suspended"],
    description:
      "Enqueue notify {tenantId} for each tenant with a due outbox row (a lost enqueue, a retry that became due, an abandoned claim)",
  }),
  schedule({
    id: "payments.authorisation_watch",
    pattern: "15 6 * * *",
    milestone: "M3",
    // The authorisations of a suspended OTA's bookings lapse all the same (OADR-0014 point 4, OADR-0008 point 6).
    statuses: ["active", "suspended"],
    description:
      "Alert staff, once per payment, about authorised, uncaptured Stripe payments whose authorisation is older than 5 days",
  }),
  schedule({
    id: "ticketing.scan",
    pattern: "*/5 * * * *",
    milestone: "M3",
    // Issuance retries continue for a suspended OTA's paid bookings (OADR-0008 point 8, OADR-0014 point 4).
    statuses: ["active", "suspended"],
    description:
      "Enqueue ticketing.issue {tenantId, bookingId} for each booking whose issuance retry is due or whose claim was abandoned (bookings/ticketing.processor.ts)",
  }),
  schedule({
    id: "bookings.reconcile_scan",
    pattern: "* * * * *",
    milestone: "M3",
    // A suspended OTA's pending bookings are decided all the same: their authorisation is captured or released
    // (OADR-0003 point 5, OADR-0014 point 4).
    statuses: ["active", "suspended"],
    description:
      "Adopt pending bookings claimed more than 2 minutes ago without reconcile_until, then enqueue booking.reconcile {tenantId, bookingId} for each pending booking with reconcile_until that is not decided yet (bookings/reconcile.processor.ts)",
  }),
]);

if (new Set(OTA_SCHEDULES.map((definition) => definition.id)).size !== OTA_SCHEDULES.length) {
  throw new TypeError("OTA_SCHEDULES: two schedules share an id");
}

/** The schedule with this id, or `undefined`. */
export function scheduleById(id: string): ScheduleDefinition | undefined {
  return OTA_SCHEDULES.find((definition) => definition.id === id);
}

/** The queue methods the registration uses: a BullMQ `Queue`, or a test double. */
export type SchedulerQueue = Pick<Queue, "upsertJobScheduler" | "removeJobScheduler" | "getJobSchedulers">;

/** What a registration did, by schedule id. */
export interface ScheduleRegistration {
  /** Upserted: every schedule of the list. */
  readonly registered: readonly string[];
  /** Schedulers found in Redis that are not in the list any more. */
  readonly removed: readonly string[];
}

/**
 * Upserts a scheduler for every schedule of `definitions` (its id, its UTC cron pattern, and a `fan-out` job template
 * with `{task: id}` and the queue's default job options) and removes every scheduler of the queue that is not one of
 * them. Upserting an unchanged scheduler keeps its waiting job.
 */
export async function registerSchedules(
  queue: SchedulerQueue,
  definitions: readonly ScheduleDefinition[],
): Promise<ScheduleRegistration> {
  const registered: string[] = [];
  for (const definition of definitions) {
    const data: FanOutJobData = { task: definition.id };
    await queue.upsertJobScheduler(
      definition.id,
      { pattern: definition.pattern, tz: SCHEDULE_TIME_ZONE },
      { name: FAN_OUT_JOB, data },
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
  return { registered, removed };
}

/** How long start-up waits at most for the BullMQ connection's first attempt, and then for the registration. */
export const REGISTRATION_WAIT_MS = 2500;
/** How long a shutting-down worker waits at most for a registration still under way. */
export const REGISTRATION_SETTLE_MS = 1000;

/** ioredis statuses in which a connection is waiting to reconnect, or closed: its first attempt is over. */
const CONNECTION_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

/** Waits for `promise` (which never rejects), for at most `ms`. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How the first connection attempt of `connection` ended: `ready`, or `failed` (an error, the end of the connection,
 * or no answer within `timeoutMs`). A connection that is ready already, or waiting to reconnect, answers at once.
 */
export function firstAttempt(
  connection: Pick<Redis, "status" | "once" | "off">,
  timeoutMs: number = REGISTRATION_WAIT_MS,
): Promise<"ready" | "failed"> {
  if (connection.status === "ready") {
    return Promise.resolve("ready");
  }
  if (CONNECTION_DOWN.has(connection.status)) {
    return Promise.resolve("failed");
  }
  return new Promise((resolveAttempt) => {
    const timer = setTimeout(() => settle("failed"), timeoutMs);
    const ready = (): void => settle("ready");
    const failed = (): void => settle("failed");
    function settle(outcome: "ready" | "failed"): void {
      clearTimeout(timer);
      connection.off("ready", ready);
      connection.off("error", failed);
      connection.off("end", failed);
      resolveAttempt(outcome);
    }
    connection.once("ready", ready);
    connection.once("error", failed);
    connection.once("end", failed);
  });
}

/**
 * Registers OTA_SCHEDULES on `ota-maintenance` when the worker starts (WorkerModule, through JobsModule): see the file
 * header. Logs `scheduler.registered` (the ids registered and removed) or `scheduler.registration_failed`.
 */
@Injectable()
export class JobSchedulerRegistry implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private registration: Promise<void> | undefined;
  /** True once the registration talks to Redis: from then on a shutdown lets it finish first. */
  private started = false;
  private stopping = false;

  constructor(
    @InjectQueue(OTA_QUEUE.maintenance) private readonly queue: Queue,
    @Inject(REDIS_BULLMQ_CONNECTION) private readonly connection: Redis,
    @InjectPinoLogger(JobSchedulerRegistry.name) private readonly logger: PinoLogger,
  ) {}

  /** The registration of OTA_SCHEDULES, as the worker runs it at start. */
  register(): Promise<ScheduleRegistration> {
    return registerSchedules(this.queue, OTA_SCHEDULES);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.registration = this.queue
      .waitUntilReady()
      .then(async () => {
        if (this.stopping) {
          return;
        }
        this.started = true;
        const result = await this.register();
        this.logger.info({ ...result }, "scheduler.registered");
      })
      .catch((error: unknown) => {
        // A shutdown that closes the queue while Redis is away ends the registration: not worth an error.
        if (!this.stopping) {
          this.logger.error({ err: error }, "scheduler.registration_failed");
        }
      });
    if ((await firstAttempt(this.connection)) === "ready") {
      await within(this.registration, REGISTRATION_WAIT_MS);
    }
  }

  /** Lets a registration under way finish before the queue closes, for at most REGISTRATION_SETTLE_MS. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.registration !== undefined && this.started) {
      await within(this.registration, REGISTRATION_SETTLE_MS);
    }
  }
}
