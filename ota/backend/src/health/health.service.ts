// Liveness and readiness of an OTA backend process (ADR-0016). Both processes use this service: the API through
// HealthController on PORT, the worker through HealthServer on HEALTH_PORT. deploy.sh polls /health/ready after every
// restart (curl --max-time 3), so a readiness answer never takes longer than READINESS_TIMEOUT_MS.
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { createPool } from "@velexis/db";
import type { Logger } from "@velexis/logger";
import { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

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

/**
 * Resolves to `true` when `promise` resolves within `ms`, to `false` when it has not settled by then, and rejects
 * when it rejects first. `Promise.race` keeps its handler on `promise`, so a rejection after the timeout is not an
 * unhandled rejection.
 */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService implements OnApplicationShutdown {
  constructor(
    @Inject(HEALTH_PROBES) private readonly probes: readonly DependencyProbe[],
    @InjectPinoLogger(HealthService.name) private readonly logger: PinoLogger,
  ) {}

  /** The process is up and its event loop answers. It checks nothing else, so it answers while a dependency is down. */
  live(): LivenessBody {
    return { status: "ok" };
  }

  /** Checks every dependency in parallel; a failing one makes the process not ready and is logged without values. */
  async ready(): Promise<Readiness> {
    const entries = await Promise.all(
      this.probes.map(async (probe) => [probe.name, await this.checkOne(probe)] as const),
    );
    const checks = Object.fromEntries(entries) as Record<DependencyName, DependencyStatus>;
    const ready = entries.every(([, status]) => status === "ok");
    return { ready, body: { status: ready ? "ok" : "unavailable", checks } };
  }

  private async checkOne(probe: DependencyProbe): Promise<DependencyStatus> {
    try {
      if (!(await settlesWithin(probe.check(), READINESS_TIMEOUT_MS))) {
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

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.probes.map((probe) => probe.close()));
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
