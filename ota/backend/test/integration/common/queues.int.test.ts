// QueuesModule and RedisModule against the real Redis 7 (OBE-002; ADR-0009): a processor on the real `ota-tenant-ops`
// queue validates what it takes with `validateTenantOpsJob`. The PBE-004 `tenant.provision` fixture completes; the
// same message with an extra field fails at its first attempt with UnrecoverableError, although the job has the five
// attempts of ADR-0009, and nothing of it is logged. Each test file gets its own Redis database (`useRedis`).
import { once } from "node:events";
import { getQueueToken, Processor, WorkerHost } from "@nestjs/bullmq";
import { Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import { bullmqJobId } from "@velexis/api-types/jobs";
import { createLogger } from "@velexis/logger";
import { useRedis, type TestRedis } from "@velexis/testing";
import { UnrecoverableError, type Job, type Queue, type Worker } from "bullmq";
import type { Redis } from "ioredis";
import { InjectPinoLogger, LoggerModule, Logger as NestPinoLogger, PinoLogger } from "nestjs-pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateTenantOpsJob } from "../../../src/common/queues/job-validation";
import {
  BULLMQ_PREFIX,
  DEFAULT_JOB_OPTIONS,
  OTA_BACKEND_QUEUES,
  OTA_QUEUE,
  otaWorkerOptions,
} from "../../../src/common/queues/queue-names";
import {
  BULLMQ_STARTUP_SETTLE_MS,
  QueuesModule,
  settleBullmqStartup,
} from "../../../src/common/queues/queues.module";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import {
  REDIS_BULLMQ_CONNECTION,
  REDIS_CLIENT,
  REDIS_CONNECTION_NAMES,
} from "../../../src/common/redis/redis.module";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { freePort } from "../../helpers/ports";

/** A value of the refused message that must reach no log line and no stored job field. */
const MARKER = "marker-value-that-must-not-be-logged";

/** What the probe processor returns for a valid message. */
interface ProbeResult {
  readonly name: string;
  readonly tenantId: string;
}

/** A processor as OBE-005's will be: it validates every job of `ota-tenant-ops` before acting on it. */
@Processor(OTA_QUEUE.tenantOps, otaWorkerOptions(OTA_QUEUE.tenantOps))
class TenantOpsProbe extends WorkerHost {
  constructor(@InjectPinoLogger(TenantOpsProbe.name) private readonly logger: PinoLogger) {
    super();
  }

  process(job: Job): Promise<ProbeResult> {
    return Promise.resolve().then(() => {
      const message = validateTenantOpsJob(job, this.logger);
      return { name: message.name, tenantId: message.tenantId };
    });
  }
}

@Module({})
class QueuesTestRoot {}

/** A worker-like root module: the validated configuration only, the process logger, QueuesModule and the probe. */
function testRoot(redisUrl: string, sink: MemorySink): DynamicModule {
  const logger = createLogger({ app: "ota-worker", env: "test", level: "info", destination: sink });
  return {
    module: QueuesTestRoot,
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        validatePredefined: false,
        skipProcessEnv: true,
        load: [() => ({ REDIS_URL: redisUrl })],
      }),
      LoggerModule.forRoot({ pinoHttp: { logger } }),
      QueuesModule,
    ],
    providers: [TenantOpsProbe],
  };
}

async function startApp(redisUrl: string, sink: MemorySink): Promise<INestApplicationContext> {
  useNextApplicationLoggerOutsideRequests();
  const app = await NestFactory.createApplicationContext(testRoot(redisUrl, sink), {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(NestPinoLogger));
  return app;
}

type Outcome =
  | { readonly state: "completed"; readonly result: unknown }
  | { readonly state: "failed"; readonly error: Error };

/** Resolves with the first outcome of the job `jobId` on `worker`. Register it before adding the job. */
function outcomeOf(worker: Worker, jobId: string): Promise<Outcome> {
  return new Promise((resolveOutcome) => {
    const completed = (job: Job, result: unknown): void => {
      if (job.id === jobId) {
        stop();
        resolveOutcome({ state: "completed", result });
      }
    };
    const failed = (job: Job | undefined, error: Error): void => {
      if (job?.id === jobId) {
        stop();
        resolveOutcome({ state: "failed", error });
      }
    };
    const stop = (): void => {
      worker.off("completed", completed);
      worker.off("failed", failed);
    };
    worker.on("completed", completed);
    worker.on("failed", failed);
  });
}

/** Resolves once the client's connection is gone. */
async function ended(client: Redis): Promise<void> {
  if (client.status !== "end") {
    await once(client, "end");
  }
}

let redis: TestRedis;
let sink: MemorySink;
let app: INestApplicationContext | undefined;
let queue: Queue;
let worker: Worker;

beforeAll(async () => {
  redis = await useRedis();
});

afterAll(async () => {
  await redis.close();
});

describe("QueuesModule with a real ota-tenant-ops queue", () => {
  beforeAll(async () => {
    sink = new MemorySink();
    app = await startApp(redis.url, sink);
    queue = app.get<Queue>(getQueueToken(OTA_QUEUE.tenantOps));
    worker = app.get(TenantOpsProbe).worker;
  });

  afterAll(async () => {
    await app?.close();
    app = undefined;
  });

  it("completes the tenant.provision fixture of PBE-004 [OBE-002 AC2]", async () => {
    const jobId = bullmqJobId(provisionFixture.jobId, 1);
    const outcome = outcomeOf(worker, jobId);

    await queue.add(provisionFixture.name, provisionFixture, { jobId });

    await expect(outcome).resolves.toEqual({
      state: "completed",
      result: { name: "tenant.provision", tenantId: provisionFixture.tenantId },
    });
    const job = await queue.getJob(jobId);
    expect(await job?.getState()).toBe("completed");
    expect(job?.attemptsMade).toBe(1);
    expect(sink.records().filter((line) => line["msg"] === "queue.job_invalid")).toEqual([]);
    // The job lives under vx:ota-tenant-ops:* in this test file's database.
    expect(queue.toKey(jobId)).toBe(`vx:ota-tenant-ops:${provisionFixture.jobId}-1`);
    expect(await redis.client.exists(queue.toKey(jobId))).toBe(1);
  });

  it("fails a message with an extra field at once as unrecoverable, logged without the payload [OBE-002 AC2]", async () => {
    const jobId = bullmqJobId(provisionFixture.jobId, 2);
    const outcome = outcomeOf(worker, jobId);

    await queue.add(provisionFixture.name, { ...provisionFixture, payload: { note: MARKER } }, { jobId });

    const result = await outcome;
    expect(result.state).toBe("failed");
    expect(result.state === "failed" ? result.error : undefined).toBeInstanceOf(UnrecoverableError);
    const job = await queue.getJob(jobId);
    expect(await job?.getState()).toBe("failed");
    // Five attempts were allowed (ADR-0009); the unrecoverable error ended them after the first.
    expect(job?.opts.attempts).toBe(5);
    expect(job?.attemptsMade).toBe(1);
    expect(job?.failedReason).toBe(
      "invalid tenant.provision message: /payload/note is not allowed (additionalProperties: false)",
    );

    const refusals = sink.records().filter((line) => line["msg"] === "queue.job_invalid");
    expect(refusals).toEqual([
      expect.objectContaining({
        level: 50,
        app: "ota-worker",
        queue: OTA_QUEUE.tenantOps,
        jobId,
        jobName: "tenant.provision",
        issues: [
          {
            path: "/payload/note",
            keyword: "additionalProperties",
            message: "is not allowed (additionalProperties: false)",
          },
        ],
      }),
    ]);
    // Nothing of the message is logged or stored with the failure: not the stray value, not the envelope's ids.
    const stored = JSON.stringify([job?.failedReason, job?.stacktrace]);
    for (const value of [MARKER, provisionFixture.tenantId, provisionFixture.requestId]) {
      expect(sink.text()).not.toContain(value);
      expect(stored).not.toContain(value);
    }
  });

  it("opens every queue of the backend with the vx prefix, the ADR-0009 defaults and one shared connection", () => {
    const connection = app?.get<Redis>(REDIS_BULLMQ_CONNECTION);
    expect(connection?.options.maxRetriesPerRequest).toBeNull();

    for (const name of OTA_BACKEND_QUEUES) {
      const opened = app?.get<Queue>(getQueueToken(name));
      expect(opened?.name, name).toBe(name);
      expect(opened?.qualifiedName, name).toBe(`${BULLMQ_PREFIX}:${name}`);
      expect(opened?.opts.connection, name).toBe(connection);
      expect(opened?.defaultJobOptions, name).toEqual(DEFAULT_JOB_OPTIONS);
    }
    expect(worker.opts.concurrency).toBe(2);
    expect(worker.opts.prefix).toBe(BULLMQ_PREFIX);
  });

  it("gives the process one command client on REDIS_URL, named in CLIENT LIST", async () => {
    const client = app?.get<Redis>(REDIS_CLIENT);
    const connection = app?.get<Redis>(REDIS_BULLMQ_CONNECTION);
    const key = redisKeys.tenant(provisionFixture.tenantId);

    await client?.set(key.key, "{}", "EX", key.ttlSeconds);

    expect(await redis.client.ttl(key.key)).toBeGreaterThan(key.ttlSeconds - 5);
    // This process's own connections, by id: other processes may hold connections with the same names.
    for (const [opened, name] of [
      [client, REDIS_CONNECTION_NAMES.commands],
      [connection, REDIS_CONNECTION_NAMES.bullmq],
    ] as const) {
      const id = await opened?.client("ID");
      const line = String(await redis.client.client("LIST", "ID", String(id)));
      expect(line, name).toContain(` name=${name} `);
      expect(line, name).toContain(` db=${redis.db} `);
    }
  });
});

describe("RedisModule shutdown", () => {
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("closes both connections after the queues and workers, without errors", async () => {
    sink = new MemorySink();
    app = await startApp(redis.url, sink);
    const client = app.get<Redis>(REDIS_CLIENT);
    const connection = app.get<Redis>(REDIS_BULLMQ_CONNECTION);
    await client.ping();
    const probe = app.get(TenantOpsProbe).worker;
    const tenantOps = app.get<Queue>(getQueueToken(OTA_QUEUE.tenantOps));
    await probe.waitUntilReady();
    await tenantOps.waitUntilReady();
    const order: string[] = [];
    probe.on("closed", () => order.push("worker closed"));
    const closeQueue = tenantOps.close.bind(tenantOps);
    tenantOps.close = async (): Promise<void> => {
      await closeQueue();
      order.push("queue closed");
    };
    connection.once("end", () => order.push("BullMQ connection ended"));
    client.once("end", () => order.push("command client ended"));

    await app.close();
    app = undefined;

    await Promise.all([ended(client), ended(connection)]);
    expect(order.slice(0, 2).sort()).toEqual(["queue closed", "worker closed"]);
    expect(order.slice(2).sort()).toEqual(["BullMQ connection ended", "command client ended"]);
    expect(sink.records().filter((line) => Number(line["level"]) >= 40)).toEqual([]);
  });

  it("starts without Redis, logs the outage once without the URL, and still shuts down", async () => {
    sink = new MemorySink();
    const password = "dummy-redis-password-of-this-test";
    app = await startApp(`redis://:${password}@127.0.0.1:${await freePort()}/0`, sink);
    const client = app.get<Redis>(REDIS_CLIENT);
    const connection = app.get<Redis>(REDIS_BULLMQ_CONNECTION);
    // The worker connects the BullMQ connection; a command connects the command client and fails after one retry.
    await expect(client.get(redisKeys.tenant(provisionFixture.tenantId).key)).rejects.toThrow();

    // Neither connection is ready, so they are closed at once, without waiting for Redis (no QUIT, no reconnection).
    await app.close();
    app = undefined;

    expect([client.status, connection.status]).not.toContain("ready");
    const outages = sink.records().filter((line) => line["msg"] === "redis.connection_error");
    expect(outages.map((line) => line["connection"]).sort()).toEqual(
      [REDIS_CONNECTION_NAMES.bullmq, REDIS_CONNECTION_NAMES.commands].sort(),
    );
    expect(sink.text()).not.toContain(password);
  });

  it("closes right after the start, while the queues and the worker still connect, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      for (const url of [redis.url, `redis://:dummy@127.0.0.1:${await freePort()}/0`]) {
        sink = new MemorySink();
        app = await startApp(url, sink);
        const started = performance.now();

        // BullMQ is still setting up its connections (OBE-005: BullmqStartupSettler waits for that first).
        await app.close();
        app = undefined;

        expect(performance.now() - started).toBeLessThan(BULLMQ_STARTUP_SETTLE_MS + 1000);
      }
      // Late set-up failures would surface within a few event-loop turns of the close.
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    } finally {
      process.off("unhandledRejection", record);
    }

    expect(unhandled).toEqual([]);
  });
});

describe("settleBullmqStartup", () => {
  it("returns when every set-up has settled, rejected ones included, or after the time limit", async () => {
    const ready = { waitUntilReady: () => Promise.resolve() };
    const failing = { waitUntilReady: () => Promise.reject(new Error("WRONGPASS")) };
    const hanging = { waitUntilReady: () => new Promise<void>(() => undefined) };

    await expect(settleBullmqStartup([ready, failing], 60_000)).resolves.toBeUndefined();
    const started = performance.now();
    await expect(settleBullmqStartup([ready, hanging], 50)).resolves.toBeUndefined();
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });
});
