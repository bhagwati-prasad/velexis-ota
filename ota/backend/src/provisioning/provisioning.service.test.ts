// Provisioning without PostgreSQL or Redis (OBE-005): which process can build the provisioner database, the pure parts
// of the provisioning service (steps, ledger, payload), the event producer's validation and job ids, and how the
// `ota-tenant-ops` processor dispatches and reports. The database and queue behaviour is in
// test/integration/provisioning/provision.int.test.ts.
import { Module, type INestApplicationContext } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import {
  MessageValidationError,
  validateJob,
  type TenantProvisionedPayload,
  type TenantProvisionFailedPayload,
} from "@velexis/api-types/jobs";
import { createLogger } from "@velexis/logger";
import { FakeClock } from "@velexis/testing";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { LoggerModule, type PinoLogger } from "nestjs-pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySink } from "../../test/helpers/log-sink";
import { freePort } from "../../test/helpers/ports";
import { AppModule, createApiApp, createApiLogger } from "../app.module";
import { Clock } from "../common/clock";
import { loadApiConfig, loadWorkerConfig, WORKER_APP, type ApiConfig, type WorkerConfig } from "../config";
import type { PlatformReadRepository } from "../tenancy/platform-read.repository";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../worker.module";
import { provisionerDatabaseProvider } from "./provisioning.module";
import {
  createProvisionerDatabase,
  DEFAULT_PROVISIONING_OPTIONS,
  PROVISIONER_DATABASE,
  PROVISIONER_POOL_MAX,
  ProvisionerDsnMissingError,
  provisionedPayload,
  ProvisioningService,
  provisioningSteps,
  skippedSteps,
  TENANT_MIGRATIONS_DIR,
  toMigrationRecords,
  type ProvisionerDatabase,
  type ProvisionResult,
} from "./provisioning.service";
import { dispatchAttempt, eventJobOptions, TenantEventsProducer } from "./tenant-events.producer";
import { TenantOpsProcessor } from "./tenant-ops.processor";

/** Dummy values of the shape the VM uses; nothing here is a real secret, and nothing connects to them. */
const SHARED = {
  APP_ENV: "test",
  DATABASE_URL: "postgres://velexis_ota_app:dummy-ota-password@127.0.0.1:5432/velexis",
  REDIS_URL: "redis://:dummy-redis-password@127.0.0.1:6379/0",
} as const;
const PROVISIONER_URL = "postgres://velexis_provisioner:dummy-provisioner-password@127.0.0.1:5432/velexis";
const MIGRATOR_URL = "postgres://velexis_migrator:dummy-migrator-password@127.0.0.1:5432/velexis";
const CHECKSUM = "cfa4d48672d69c947e5e96c0906d2b55c0df213c9cb38b72f30824ff9ae048cc";
const quietPoolLogger = { error: (): void => undefined };

const apps: INestApplicationContext[] = [];
const databases: ProvisionerDatabase[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(databases.splice(0).map((database) => database.pool.end()));
});

/** A Nest graph with only the validated configuration, the logger and the provisioner database provider. */
async function provisionerGraph(config: ApiConfig | WorkerConfig): Promise<INestApplicationContext> {
  const logger = createLogger({ app: "test", env: "test", level: "error", destination: new MemorySink() });
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        validatePredefined: false,
        skipProcessEnv: true,
        load: [() => config],
      }),
      LoggerModule.forRoot({ pinoHttp: { logger } }),
    ],
    providers: [provisionerDatabaseProvider],
  })
  class ProvisionerGraph {}
  const app = await NestFactory.createApplicationContext(ProvisionerGraph, {
    logger: false,
    abortOnError: false,
  });
  apps.push(app);
  return app;
}

describe("the provisioner database", () => {
  it("cannot be built from the API's configuration, even when the privileged DSNs are set [OBE-005 AC4]", () => {
    const api = loadApiConfig({
      ...SHARED,
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
      DATABASE_MIGRATOR_URL: MIGRATOR_URL,
    });

    // @ts-expect-error The API's configuration type has no DATABASE_PROVISIONER_URL.
    expect(() => createProvisionerDatabase(api, quietPoolLogger)).toThrow(ProvisionerDsnMissingError);
    expect(() => createProvisionerDatabase(api as never, quietPoolLogger)).toThrow(
      /DATABASE_PROVISIONER_URL is not in this process's configuration: only the OTA worker/,
    );
  });

  it("stops a module graph with the API's configuration from starting [OBE-005 AC4]", async () => {
    const api = loadApiConfig({ ...SHARED, DATABASE_PROVISIONER_URL: PROVISIONER_URL });

    await expect(provisionerGraph(api)).rejects.toBeInstanceOf(ProvisionerDsnMissingError);
  });

  it("is built from the worker's configuration: its DSN, a pool of 2 named ota-worker-provisioner, not connected [OBE-005 AC4]", async () => {
    const worker = loadWorkerConfig({ ...SHARED, DATABASE_PROVISIONER_URL: PROVISIONER_URL });

    const app = await provisionerGraph(worker);

    const database = app.get<string, ProvisionerDatabase>(PROVISIONER_DATABASE);
    databases.push(database);
    expect(database.url).toBe(PROVISIONER_URL);
    expect(database.pool.options).toMatchObject({
      max: PROVISIONER_POOL_MAX,
      application_name: `${WORKER_APP}-provisioner`,
    });
    expect(database.pool.totalCount).toBe(0);
  });

  it("is in the worker's module graph and not in the API's [OBE-005 AC4]", async () => {
    const redisUrl = `redis://:dummy@127.0.0.1:${await freePort()}/0`;
    const apiConfig = loadApiConfig({
      ...SHARED,
      REDIS_URL: redisUrl,
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
    });
    const workerConfig = loadWorkerConfig({
      ...SHARED,
      REDIS_URL: redisUrl,
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
    });
    const sink = new MemorySink();

    const api = await createApiApp(
      apiConfig,
      AppModule.forRoot(apiConfig, { logger: createApiLogger(apiConfig, sink) }),
    );
    apps.push(api);
    await api.init();
    const worker = await createWorkerApp(
      WorkerModule.forRoot(workerConfig, { logger: createWorkerLogger(workerConfig, sink) }),
    );
    apps.push(worker);
    await worker.init();

    expect(() => api.get(PROVISIONER_DATABASE, { strict: false })).toThrow();
    expect(() => api.get(ProvisioningService, { strict: false })).toThrow();
    expect(worker.get<string, ProvisionerDatabase>(PROVISIONER_DATABASE, { strict: false }).url).toBe(
      PROVISIONER_URL,
    );
    expect(worker.get(TenantOpsProcessor, { strict: false })).toBeInstanceOf(TenantOpsProcessor);
    expect(sink.text()).not.toContain("dummy-provisioner-password");
  });
});

describe("the provisioning steps and payload", () => {
  const at = (iso: string) => new Date(`2026-10-14T09:30:${iso}Z`);
  const seededNothing = { storefrontSettings: false, defaultMarkupRule: false, notificationTemplates: [] };

  it("reports a fresh provisioning as three succeeded steps that follow each other", () => {
    const steps = provisioningSteps({
      startedAt: at("00.000"),
      migrationsDoneAt: at("01.000"),
      seedsDoneAt: at("01.250"),
      created: true,
      applied: [{ executionMs: 400 }, { executionMs: 200 }],
      seeded: { storefrontSettings: true, defaultMarkupRule: true, notificationTemplates: [] },
    });

    expect(steps).toEqual([
      {
        step: "create_schema",
        status: "succeeded",
        startedAt: "2026-10-14T09:30:00.000Z",
        finishedAt: "2026-10-14T09:30:00.400Z",
      },
      {
        step: "run_migrations",
        status: "succeeded",
        startedAt: "2026-10-14T09:30:00.400Z",
        finishedAt: "2026-10-14T09:30:01.000Z",
      },
      {
        step: "seed_defaults",
        status: "succeeded",
        startedAt: "2026-10-14T09:30:01.000Z",
        finishedAt: "2026-10-14T09:30:01.250Z",
      },
    ]);
  });

  it("skips what had nothing to do, and never starts the files before the run", () => {
    const steps = provisioningSteps({
      startedAt: at("00.000"),
      migrationsDoneAt: at("00.100"),
      seedsDoneAt: at("00.120"),
      created: false,
      applied: [{ executionMs: 5_000 }],
      seeded: seededNothing,
    });

    expect(steps.map(({ step, status, startedAt }) => [step, status, startedAt])).toEqual([
      ["create_schema", "skipped", "2026-10-14T09:30:00.000Z"],
      ["run_migrations", "succeeded", "2026-10-14T09:30:00.000Z"],
      ["seed_defaults", "skipped", "2026-10-14T09:30:00.100Z"],
    ]);
    expect(skippedSteps(at("05.000")).map(({ status }) => status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("maps the ledger in apply order, takes the last row as the schema version, and validates as tenant.provisioned", () => {
    const migrations = toMigrationRecords([
      {
        id: "0002_add_mvp_tenant_deltas",
        checksum: CHECKSUM,
        phase: "expand",
        execution_ms: null,
        created_at: at("02.000"),
      },
      {
        id: "0001_baseline",
        checksum: CHECKSUM,
        phase: "expand",
        execution_ms: 412,
        created_at: at("01.000"),
      },
    ]);
    const payload = provisionedPayload("tenant_acme", migrations, skippedSteps(at("03.000")));

    expect(payload.schemaVersion).toBe("0002_add_mvp_tenant_deltas");
    expect(payload.migrations).toEqual([
      {
        version: "0001_baseline",
        checksum: CHECKSUM,
        phase: "expand",
        appliedAt: "2026-10-14T09:30:01.000Z",
        durationMs: 412,
      },
      {
        version: "0002_add_mvp_tenant_deltas",
        checksum: CHECKSUM,
        phase: "expand",
        appliedAt: "2026-10-14T09:30:02.000Z",
        durationMs: null,
      },
    ]);
    expect(() =>
      validateJob("tenant.provisioned", { ...provisionFixture, name: "tenant.provisioned", payload }),
    ).not.toThrow();
  });

  it("refuses an empty ledger and a phase the runner never writes", () => {
    expect(() => provisionedPayload("tenant_acme", [], [])).toThrow(/ledger of tenant_acme is empty/);
    expect(() =>
      toMigrationRecords([
        {
          id: "R__grants",
          checksum: CHECKSUM,
          phase: "repeatable",
          execution_ms: 1,
          created_at: at("00.000"),
        },
      ]),
    ).toThrow(/R__grants has the phase "repeatable"/);
  });
});

describe("ProvisioningService", () => {
  it("answers TENANT_NOT_FOUND, not retryable, for an unknown tenant without touching a schema", async () => {
    const tenantById = vi.fn(() => Promise.resolve(null));
    const database = { url: "postgres://nobody@127.0.0.1:1/none" } as unknown as ProvisionerDatabase;
    const service = new ProvisioningService(
      { tenantById } as unknown as PlatformReadRepository,
      database,
      DEFAULT_PROVISIONING_OPTIONS,
      new FakeClock() as Clock,
    );

    const result = await service.provisionTenant(provisionFixture.tenantId);

    expect(tenantById).toHaveBeenCalledWith(provisionFixture.tenantId);
    expect(result).toEqual({
      status: "failed",
      payload: {
        error: { code: "TENANT_NOT_FOUND", message: "No tenant has the id of the message" },
        retryable: false,
        steps: [],
      },
    });
  });

  it("reads the tenant migrations of the package", () => {
    expect(DEFAULT_PROVISIONING_OPTIONS.migrationsDir).toBe(TENANT_MIGRATIONS_DIR);
    expect(TENANT_MIGRATIONS_DIR).toMatch(/[/\\]ota[/\\]backend[/\\]migrations[/\\]tenant$/);
  });
});

/** A queue that records what is added to it. */
function recordingQueue(): { queue: Queue; added: Array<{ name: string; data: unknown; opts: unknown }> } {
  const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
  const add = vi.fn((name: string, data: unknown, opts: unknown) => {
    added.push({ name, data, opts });
    return Promise.resolve({ id: "1" });
  });
  return { queue: { add } as unknown as Queue, added };
}

const PROVISIONED: TenantProvisionedPayload = {
  schemaName: "tenant_acme",
  schemaVersion: "0001_baseline",
  migrations: [
    {
      version: "0001_baseline",
      checksum: CHECKSUM,
      phase: "expand",
      appliedAt: "2026-10-14T09:30:01.000Z",
      durationMs: 412,
    },
  ],
  steps: [],
};

const NOT_PROVISIONING: TenantProvisionFailedPayload = {
  error: { code: "TENANT_NOT_PROVISIONING", message: "The tenant is active, not provisioning" },
  retryable: false,
  steps: [],
};

describe("TenantEventsProducer", () => {
  it("reads the dispatch attempt from the BullMQ id of the message's own job only", () => {
    expect(dispatchAttempt(`${provisionFixture.jobId}-2`, provisionFixture.jobId)).toBe(2);
    expect(dispatchAttempt("job_01M4T9HVE0355QAKGD2AVSQWH3-2", provisionFixture.jobId)).toBeUndefined();
    expect(dispatchAttempt("17", provisionFixture.jobId)).toBeUndefined();
    expect(dispatchAttempt(undefined, provisionFixture.jobId)).toBeUndefined();
    expect(eventJobOptions({ message: provisionFixture, attempt: 3 })).toEqual({
      jobId: `${provisionFixture.jobId}-3`,
    });
    expect(eventJobOptions({ message: provisionFixture, attempt: undefined })).toEqual({});
  });

  it("publishes a valid tenant.provisioned that answers the message, with the attempt's job id", async () => {
    const { queue, added } = recordingQueue();
    const clock = new FakeClock("2026-10-14T09:30:05.000Z");
    const producer = new TenantEventsProducer(queue, clock as Clock);

    const event = await producer.provisioned({ message: provisionFixture, attempt: 1 }, PROVISIONED);

    expect(event).toEqual({
      v: 1,
      name: "tenant.provisioned",
      jobId: provisionFixture.jobId,
      tenantId: provisionFixture.tenantId,
      requestedAt: "2026-10-14T09:30:05.000Z",
      requestId: provisionFixture.requestId,
      payload: PROVISIONED,
    });
    expect(added).toEqual([
      { name: "tenant.provisioned", data: event, opts: { jobId: `${provisionFixture.jobId}-1` } },
    ]);
  });

  it("refuses an event outside its contract and adds nothing", async () => {
    const { queue, added } = recordingQueue();
    const producer = new TenantEventsProducer(queue, new FakeClock() as Clock);

    await expect(
      producer.provisioned(
        { message: provisionFixture, attempt: 1 },
        { ...PROVISIONED, schemaName: "public" },
      ),
    ).rejects.toBeInstanceOf(MessageValidationError);
    expect(added).toEqual([]);
  });
});

describe("TenantOpsProcessor", () => {
  function processorWith(result: () => Promise<ProvisionResult>) {
    const { queue, added } = recordingQueue();
    const provisionTenant = vi.fn(result);
    const lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
    const log = (level: string) => (fields: Record<string, unknown>, msg: string) =>
      void lines.push({ level, fields, msg });
    const logger = { info: log("info"), warn: log("warn"), error: log("error") } as unknown as PinoLogger;
    const processor = new TenantOpsProcessor(
      { provisionTenant } as unknown as ProvisioningService,
      new TenantEventsProducer(queue, new FakeClock() as Clock),
      logger,
    );
    return { processor, provisionTenant, added, lines };
  }

  function job(name: string, data: unknown, id = `${provisionFixture.jobId}-1`): Job {
    return { id, name, data, queueName: "ota-tenant-ops" } as unknown as Job;
  }

  it("provisions, publishes tenant.provisioned after it and returns names and versions only", async () => {
    const { processor, provisionTenant, added, lines } = processorWith(() =>
      Promise.resolve({ status: "provisioned", payload: PROVISIONED }),
    );

    const result = await processor.process(
      job("tenant.provision", provisionFixture, `${provisionFixture.jobId}-4`),
    );

    expect(provisionTenant).toHaveBeenCalledWith(provisionFixture.tenantId);
    expect(result).toEqual({
      event: "tenant.provisioned",
      schemaName: "tenant_acme",
      schemaVersion: "0001_baseline",
    });
    expect(added.map(({ name, opts }) => [name, opts])).toEqual([
      ["tenant.provisioned", { jobId: `${provisionFixture.jobId}-4` }],
    ]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "tenant_ops.provisioned",
        fields: expect.objectContaining({
          tenantId: provisionFixture.tenantId,
          schemaVersion: "0001_baseline",
        }),
      }),
    );
  });

  it("publishes tenant.provision_failed and fails as unrecoverable for a non-retryable result", async () => {
    const { processor, added } = processorWith(() =>
      Promise.resolve({ status: "failed", payload: NOT_PROVISIONING }),
    );

    const error = await processor
      .process(job("tenant.provision", provisionFixture))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({
      message: "TENANT_NOT_PROVISIONING: The tenant is active, not provisioning",
    });
    expect(added).toEqual([
      expect.objectContaining({
        name: "tenant.provision_failed",
        data: expect.objectContaining({ payload: NOT_PROVISIONING }),
      }),
    ]);
  });

  it("throws any other error as it is, for BullMQ to retry, and publishes nothing", async () => {
    const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    const { processor, added } = processorWith(() => Promise.reject(lockTimeout));

    await expect(processor.process(job("tenant.provision", provisionFixture))).rejects.toBe(lockTimeout);
    expect(added).toEqual([]);
  });

  it("fails the messages this release does not handle, and unknown names, as unrecoverable", async () => {
    const { processor, provisionTenant, added, lines } = processorWith(() =>
      Promise.resolve({ status: "provisioned", payload: PROVISIONED }),
    );

    for (const name of ["tenant.migrate", "tenant.resume"]) {
      await expect(processor.process(job(name, { ...provisionFixture, name }))).rejects.toThrow(
        new UnrecoverableError(`${name} is not handled by this release of the OTA worker`),
      );
    }
    await expect(
      processor.process(job("tenant.delete", { ...provisionFixture, name: "tenant.delete" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(provisionTenant).not.toHaveBeenCalled();
    expect(added).toEqual([]);
    expect(lines.map(({ level, msg }) => [level, msg])).toEqual([
      ["error", "tenant_ops.unhandled"],
      ["error", "tenant_ops.unhandled"],
      ["error", "queue.job_invalid"],
    ]);
  });

  it("logs a worker error once until a job runs again", () => {
    const { processor, lines } = processorWith(() =>
      Promise.resolve({ status: "provisioned", payload: PROVISIONED }),
    );

    processor.onWorkerError(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    processor.onWorkerError(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    processor.onActive();
    processor.onWorkerError(new Error("connect ECONNREFUSED 127.0.0.1:6379"));

    expect(lines.filter(({ msg }) => msg === "queue.worker_error")).toHaveLength(2);
  });
});
