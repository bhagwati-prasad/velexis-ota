// Liveness and readiness of an OTA backend process (ADR-0016). Both processes use this service: the API through
// HealthController on PORT, the worker through HealthServer on HEALTH_PORT. deploy.sh polls /health/ready after every
// restart (curl --max-time 3), so a readiness answer never takes longer than READINESS_TIMEOUT_MS. The worker's
// readiness also reports its BullMQ queues (OBE-025, queue-age.ts), within QUEUE_REPORT_TIMEOUT_MS and in parallel with
// the probes; the queues never make it unready.
import { Inject, Injectable, Optional, type OnApplicationShutdown } from "@nestjs/common";
import { createPool } from "@velexis/db";
import type { Logger } from "@velexis/logger";
import { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { HEALTH_QUEUE_AGES, QUEUE_REPORT_TIMEOUT_MS, type QueueAges, type QueueAgeSource } from "./queue-age";

/** The dependencies a process needs before it can serve: the names in the readiness answer. */
export type DependencyName = "postgres" | "redis";

/** `timeout`: no answer within READINESS_TIMEOUT_MS; `down`: refused, reset or failed. */
export type DependencyStatus = "ok" | "timeout" | "down";

export interface LivenessBody {
  readonly status: "ok";
}

export interface ReadinessBody {
  readonly status: "ok" | "unavailable";
  readonly checks: Readonly<Record<DependencyName, DependencyStatus>>;
  /**
   * The worker's queues (OBE-025): absent in the API's answer, and in the worker's while they are unknown (Redis did
   * not answer them within QUEUE_REPORT_TIMEOUT_MS).
   */
  readonly queues?: QueueAges;
}

export interface Readiness {
  /** `true` when every dependency answered: HTTP 200, otherwise 503. */
  readonly ready: boolean;
  readonly body: ReadinessBody;
}

/** One dependency checked by `/health/ready` and released when the process shuts down. */
export interface DependencyProbe {
  readonly name: DependencyName;
  /** Resolves when the dependency answers; rejects otherwise. */
  check(): Promise<void>;
  /** Releases the probe's connections. */
  close(): Promise<void>;
}

/** Injection token of the probes (`DependencyProbe[]`), one per `DependencyName`. */
export const HEALTH_PROBES = "HEALTH_PROBES";

/** How long one probe may take before it counts as `timeout`. The probes run in parallel. */
export const READINESS_TIMEOUT_MS = 2000;

/** What a probe logs with: pino's call shape, so `PinoLogger` and a pino logger both fit. */
export type ProbeLogger = Pick<Logger, "warn" | "error">;

/** The outcome of `within`: the value, or `timedOut` when the promise had not settled in time. */
type Within<T> = { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

/**
 * Resolves to the value of `promise` when it resolves within `ms`, to `{timedOut: true}` when it has not settled by
 * then, and rejects when it rejects first. `Promise.race` keeps its handler on `promise`, so a rejection after the
 * timeout is not an unhandled rejection.
 */
async function within<T>(promise: Promise<T>, ms: number): Promise<Within<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Within<T>>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value): Within<T> => ({ timedOut: false, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService implements OnApplicationShutdown {
  constructor(
    @Inject(HEALTH_PROBES) private readonly probes: readonly DependencyProbe[],
    @InjectPinoLogger(HealthService.name) private readonly logger: PinoLogger,
    @Optional() @Inject(HEALTH_QUEUE_AGES) private readonly queueAges?: QueueAgeSource,
  ) {}

  /** The process is up and its event loop answers. It checks nothing else, so it answers while a dependency is down. */
  live(): LivenessBody {
    return { status: "ok" };
  }

  /**
   * Checks every dependency in parallel; a failing one makes the process not ready and is logged without values. The
   * worker's queues are read meanwhile and added when they answered in time; they never change `ready`.
   */
  async ready(): Promise<Readiness> {
    const [entries, queues] = await Promise.all([
      Promise.all(this.probes.map(async (probe) => [probe.name, await this.checkOne(probe)] as const)),
      this.readQueues(),
    ]);
    const checks = Object.fromEntries(entries) as Record<DependencyName, DependencyStatus>;
    const ready = entries.every(([, status]) => status === "ok");
    const status = ready ? "ok" : "unavailable";
    return { ready, body: queues === undefined ? { status, checks } : { status, checks, queues } };
  }

  private async checkOne(probe: DependencyProbe): Promise<DependencyStatus> {
    try {
      if ((await within(probe.check(), READINESS_TIMEOUT_MS)).timedOut) {
        this.logger.warn({ dependency: probe.name, status: "timeout" }, "health.dependency_unavailable");
        return "timeout";
      }
      return "ok";
    } catch (error) {
      // The err serializer keeps type, message, stack and code only (ADR-0016); no DSN is part of these errors.
      this.logger.warn(
        { dependency: probe.name, status: "down", err: error },
        "health.dependency_unavailable",
      );
      return "down";
    }
  }

  /** The worker's queues, or `undefined` in the API and while they are unknown (logged, without job data). */
  private async readQueues(): Promise<QueueAges | undefined> {
    if (this.queueAges === undefined) {
      return undefined;
    }
    try {
      const outcome = await within(this.queueAges.read(), QUEUE_REPORT_TIMEOUT_MS);
      if (outcome.timedOut) {
        this.logger.warn({ part: "queues", status: "timeout" }, "health.queues_unknown");
        return undefined;
      }
      return outcome.value;
    } catch (error) {
      // As for the probes: type, message, stack and code of a Redis error, never a URL or a job.
      this.logger.warn({ part: "queues", status: "down", err: error }, "health.queues_unknown");
      return undefined;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      ...this.probes.map((probe) => probe.close()),
      ...(this.queueAges === undefined ? [] : [this.queueAges.close()]),
    ]);
  }
}

export interface ProbeOptions {
  /** `application_name` / client name of the probe's connection: `ota-api-health`, `ota-worker-health`. */
  readonly connectionName: string;
  readonly logger: ProbeLogger;
}

/**
 * PostgreSQL: `SELECT 1` on a small pool of its own (`createPool`, role of DATABASE_URL), with short connection and
 * statement timeouts, so a readiness check neither waits behind nor takes connections from the request pools.
 * Connections open on the first check, not at start-up.
 */
export function createPostgresProbe(url: string, options: ProbeOptions): DependencyProbe {
  const pool = createPool(url, {
    applicationName: options.connectionName,
    logger: options.logger,
    max: 2,
    statementTimeoutMs: READINESS_TIMEOUT_MS,
    connectionTimeoutMillis: READINESS_TIMEOUT_MS,
  });
  let closed = false;
  return {
    name: "postgres",
    async check() {
      await pool.query("SELECT 1");
    },
    async close() {
      if (!closed) {
        closed = true;
        await pool.end();
      }
    },
  };
}

/**
 * Redis: `PING` on a connection of its own. It connects on the first check and keeps reconnecting in the background
 * while Redis is down; without an offline queue a check fails at once instead of waiting for the reconnection.
 * Connection errors are logged once per outage, never with the URL.
 */
export function createRedisProbe(url: string, options: ProbeOptions): DependencyProbe {
  const client = new Redis(url, {
    connectionName: options.connectionName,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: READINESS_TIMEOUT_MS,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  let outageLogged = false;
  // The first check connects; concurrent first checks share that attempt instead of failing on "already connecting".
  let connecting: Promise<void> | undefined;
  client.on("error", (error: unknown) => {
    if (!outageLogged) {
      outageLogged = true;
      options.logger.warn({ dependency: "redis", err: error }, "health.redis.connection_error");
    }
  });
  client.on("ready", () => {
    outageLogged = false;
  });
  return {
    name: "redis",
    async check() {
      if (client.status === "wait") {
        connecting ??= client.connect().finally(() => {
          connecting = undefined;
        });
      }
      if (connecting !== undefined) {
        await connecting;
      }
      await client.ping();
    },
    close() {
      client.disconnect();
      return Promise.resolve();
    },
  };
}
