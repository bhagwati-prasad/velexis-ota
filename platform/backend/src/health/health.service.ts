// Liveness and readiness of a platform backend process (ADR-0016). Both processes use it: the API serves it through
// HealthController, the worker through its node:http health server (worker.ts). The service only probes and reports;
// the caller logs the failures with its request logger, so every line carries the request's requestId.
import { Inject, Injectable } from "@nestjs/common";

/** How long one dependency may take to answer before it counts as down. deploy.sh polls for up to 90 s. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/** The dependencies `/health/ready` checks, in the order of the report. */
export const HEALTH_DEPENDENCIES = ["postgres", "redis"] as const;

export type HealthDependency = (typeof HEALTH_DEPENDENCIES)[number];
export type DependencyStatus = "ok" | "down";

/** The body of `GET /health/live`. */
export interface LiveReport {
  readonly status: "ok";
}

/** The body of `GET /health/ready`: `200` when every dependency is `ok`, otherwise `503` with `unavailable`. */
export interface ReadyReport {
  readonly status: "ok" | "unavailable";
  readonly checks: Readonly<Record<HealthDependency, DependencyStatus>>;
}

/** Why a dependency is down. For the log only: the error never reaches a response. */
export interface DependencyFailure {
  readonly dependency: HealthDependency;
  readonly error: unknown;
}

export interface Readiness {
  readonly report: ReadyReport;
  readonly failures: readonly DependencyFailure[];
}

/** What the readiness check needs of the PostgreSQL pool (`createPool` of @velexis/db). */
export interface PostgresProbeTarget {
  query(text: string): Promise<unknown>;
}

/** What the readiness check needs of the Redis client (ioredis). */
export interface RedisProbeTarget {
  ping(): Promise<string>;
}

/** Injection tokens of the pool and the client that HealthModule creates. */
export const HEALTH_POSTGRES = Symbol("HEALTH_POSTGRES");
export const HEALTH_REDIS = Symbol("HEALTH_REDIS");

/** A dependency that did not answer within HEALTH_CHECK_TIMEOUT_MS. */
export class HealthCheckTimeoutError extends Error {
  override readonly name = "HealthCheckTimeoutError";

  constructor(dependency: HealthDependency, timeoutMs: number) {
    super(`${dependency} did not answer within ${timeoutMs} ms`);
  }
}

/** Redis answered something other than PONG. The reply itself is not kept. */
export class UnexpectedPingReplyError extends Error {
  override readonly name = "UnexpectedPingReplyError";

  constructor() {
    super("redis answered PING with something other than PONG");
  }
}

/** Resolves or rejects like `promise`, or rejects with HealthCheckTimeoutError after `timeoutMs`. */
async function withTimeout<T>(
  promise: Promise<T>,
  dependency: HealthDependency,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HealthCheckTimeoutError(dependency, timeoutMs)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(HEALTH_POSTGRES) private readonly postgres: PostgresProbeTarget,
    @Inject(HEALTH_REDIS) private readonly redis: RedisProbeTarget,
  ) {}

  /** The process is up and serving. Checks nothing else. */
  live(): LiveReport {
    return { status: "ok" };
  }

  /** PostgreSQL (`SELECT 1`) and Redis (`PING`), probed in parallel, each within HEALTH_CHECK_TIMEOUT_MS. */
  async ready(): Promise<Readiness> {
    const results = await Promise.all([
      this.probe("postgres", () => this.postgres.query("SELECT 1")),
      this.probe("redis", async () => {
        if ((await this.redis.ping()) !== "PONG") {
          throw new UnexpectedPingReplyError();
        }
      }),
    ]);
    const failures = results.filter((failure) => failure !== undefined);
    const down = new Set(failures.map((failure) => failure.dependency));
    const checks = Object.fromEntries(
      HEALTH_DEPENDENCIES.map((dependency) => [dependency, down.has(dependency) ? "down" : "ok"]),
    ) as Record<HealthDependency, DependencyStatus>;
    return { report: { status: failures.length === 0 ? "ok" : "unavailable", checks }, failures };
  }

  private async probe(
    dependency: HealthDependency,
    check: () => Promise<unknown>,
  ): Promise<DependencyFailure | undefined> {
    try {
      // A probe that throws synchronously counts as down too.
      await withTimeout(Promise.resolve().then(check), dependency, HEALTH_CHECK_TIMEOUT_MS);
      return undefined;
    } catch (error) {
      return { dependency, error };
    }
  }
}
