// Provisioning without PostgreSQL or Redis (OBE-005, OBE-006): which process can build the provisioner database, the
// pure parts of the provisioning service (steps, ledger, payload, the files of a target version), the failures it
// decides before any tenant SQL, the event producer's validation and job ids, and how the `ota-tenant-ops` processor
// dispatches and reports, retryable failures only on the last try. The database and queue behaviour is in
// test/integration/provisioning/provision.int.test.ts and migrate.int.test.ts.
import { Module, type INestApplicationContext } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import {
  MessageValidationError,
  validateJob,
  type TenantMigratedPayload,
  type TenantProvisionedPayload,
  type TenantProvisionFailedPayload,
} from "@velexis/api-types/jobs";
import { InvalidTenantSchemaError } from "@velexis/db";
import type { MigrationFiles } from "@velexis/db/migrate";
import { createLogger } from "@velexis/logger";
import { FakeClock } from "@velexis/testing";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { LoggerModule, type PinoLogger } from "nestjs-pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testApiVariables, testWorkerVariables } from "../../test/helpers/api-env";
import { MemorySink } from "../../test/helpers/log-sink";
import { unreachableRedisUrl } from "../../test/helpers/ports";
import { AppModule, createApiApp, createApiLogger } from "../app.module";
import { Clock } from "../common/clock";
import { loadApiConfig, loadWorkerConfig, WORKER_APP, type ApiConfig, type WorkerConfig } from "../config";
import type { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../worker.module";
import { MAX_ERROR_MESSAGE_LENGTH } from "./failure-classifier";
import type { HousekeepingService } from "./housekeeping.service";
import { provisionerDatabaseProvider } from "./provisioning.module";
import {
  createProvisionerDatabase,
  DEFAULT_PROVISIONING_OPTIONS,
  filesUpTo,
  migratedPayload,
  PROVISIONER_DATABASE,
  PROVISIONER_POOL_MAX,
  ProvisionerDsnMissingError,
  provisionedPayload,
  ProvisioningService,
  provisioningSteps,
  skippedSteps,
  TENANT_MIGRATIONS_DIR,
  toMigrationRecords,
  type MigrateResult,
  type ProvisionerDatabase,
  type ProvisioningOptions,
  type ProvisionResult,
} from "./provisioning.service";
import { dispatchAttempt, eventJobOptions, TenantEventsProducer } from "./tenant-events.producer";
import { isLastTry, TenantOpsProcessor } from "./tenant-ops.processor";

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
/** The budget of the hook that starts the API's and the worker's module graphs (see its comment). */
const GRAPH_SETUP_TIMEOUT_MS = 60_000;

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
      ...testApiVariables(),
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
    const api = loadApiConfig({
      ...SHARED,
      ...testApiVariables(),
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
    });

    await expect(provisionerGraph(api)).rejects.toBeInstanceOf(ProvisionerDsnMissingError);
  });

  it("is built from the worker's configuration: its DSN, a pool of 2 named ota-worker-provisioner, not connected [OBE-005 AC4]", async () => {
    const worker = loadWorkerConfig({
      ...SHARED,
      ...testWorkerVariables(),
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
    });

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

  describe("in the module graphs of both processes", () => {
    const started: INestApplicationContext[] = [];
    const sink = new MemorySink();
    let graphs: { api: INestApplicationContext; worker: INestApplicationContext };

    // Starting the API's graph parses the OTA document and compiles its request validators (about 1.5 s alone), and
    // the worker's graph adds its own modules: a few seconds on an idle machine, and more than Vitest's 5 s test
    // bound while every package's tests run at once on a 4-CPU runner (CI run 38752280673 took 9.5 s). Both graphs
    // start once, in this hook with a budget that only stops a start-up that hangs; the test below reads them.
    beforeAll(async () => {
      const redisUrl = await unreachableRedisUrl();
      const apiConfig = loadApiConfig({
        ...SHARED,
        ...testApiVariables(),
        REDIS_URL: redisUrl,
        DATABASE_PROVISIONER_URL: PROVISIONER_URL,
      });
      const workerConfig = loadWorkerConfig({
        ...SHARED,
        ...testWorkerVariables(),
        REDIS_URL: redisUrl,
        DATABASE_PROVISIONER_URL: PROVISIONER_URL,
      });

      const api = await createApiApp(
        apiConfig,
        AppModule.forRoot(apiConfig, { logger: createApiLogger(apiConfig, sink) }),
      );
      started.push(api);
      await api.init();
      const worker = await createWorkerApp(
        WorkerModule.forRoot(workerConfig, { logger: createWorkerLogger(workerConfig, sink) }),
      );
      started.push(worker);
      await worker.init();
      graphs = { api, worker };
    }, GRAPH_SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await Promise.all(started.splice(0).map((app) => app.close()));
    });

    it("is in the worker's module graph and not in the API's [OBE-005 AC4]", () => {
      const { api, worker } = graphs;

      expect(() => api.get(PROVISIONER_DATABASE, { strict: false })).toThrow();
      expect(() => api.get(ProvisioningService, { strict: false })).toThrow();
      expect(worker.get<string, ProvisionerDatabase>(PROVISIONER_DATABASE, { strict: false }).url).toBe(
        PROVISIONER_URL,
      );
      expect(worker.get(TenantOpsProcessor, { strict: false })).toBeInstanceOf(TenantOpsProcessor);
      expect(sink.text()).not.toContain("dummy-provisioner-password");
    });
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

  it("takes the last ledger row as the schema version of tenant.migrated and validates it", () => {
    const migrations = toMigrationRecords([
      {
        id: "0001_baseline",
        checksum: CHECKSUM,
        phase: "expand",
        execution_ms: 412,
        created_at: at("01.000"),
      },
      {
        id: "0002_add_loyalty_cards",
        checksum: CHECKSUM,
        phase: "expand",
        execution_ms: 3,
        created_at: at("02.000"),
      },
    ]);
    const payload = migratedPayload("tenant_acme", migrations);

    expect(payload).toEqual({ schemaVersion: "0002_add_loyalty_cards", migrations });
    expect(() =>
      validateJob("tenant.migrated", { ...provisionFixture, name: "tenant.migrated", payload }),
    ).not.toThrow();
    expect(() => migratedPayload("tenant_acme", [])).toThrow(/ledger of tenant_acme is empty/);
  });
});

describe("the files of a tenant.migrate target", () => {
  /** A folder of three numbered files; only `numbered` matters here. */
  function folder(): MigrationFiles {
    const numbered = ["0001_baseline", "0002_add_loyalty_cards", "0003_add_gift_cards"].map((id) => ({
      kind: "numbered" as const,
      file: `${id}.sql`,
      id,
      path: `/srv/velexis/migrations/tenant/${id}.sql`,
      phase: "expand" as const,
      noTransaction: false,
      description: id,
      checksum: CHECKSUM,
      sql: "SELECT 1;\n",
      statements: [],
    }));
    return { set: "tenant", dir: "/srv/velexis/migrations/tenant", exists: true, numbered, repeatable: [] };
  }
  const ids = (files: MigrationFiles | undefined) => files?.numbered.map((file) => file.id);

  it("selects every file without a target, and the files up to the target by ledger id or number", () => {
    const files = folder();

    expect(filesUpTo(files, undefined)).toBe(files);
    expect(ids(filesUpTo(files, "0002_add_loyalty_cards"))).toEqual([
      "0001_baseline",
      "0002_add_loyalty_cards",
    ]);
    expect(ids(filesUpTo(files, "0002"))).toEqual(["0001_baseline", "0002_add_loyalty_cards"]);
    expect(ids(filesUpTo(files, "0001"))).toEqual(["0001_baseline"]);
    expect(ids(filesUpTo(files, "0003_add_gift_cards"))).toEqual(ids(files));
    expect(filesUpTo(files, "0002")?.dir).toBe(files.dir);
  });

  it("finds no files for a version the release does not have", () => {
    const files = folder();

    for (const target of ["0004", "0002_add_other_cards", "00002", "0002_add"]) {
      expect(filesUpTo(files, target)).toBeUndefined();
    }
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

  /** A tenant row as PlatformReadRepository maps it. */
  function tenantRow(status: PlatformTenant["status"]): PlatformTenant {
    return {
      id: provisionFixture.tenantId,
      key: "acme",
      name: "Acme Travel",
      status,
      schemaName: "tenant_acme" as PlatformTenant["schemaName"],
      storefrontEnvironment: "test",
      defaultCurrency: "EUR",
      defaultLocale: "en",
      billingNotice: null,
    };
  }

  /** A service whose provisioner DSN refuses every connection: these tests must decide before any tenant SQL. */
  function serviceWith(
    tenantById: () => Promise<PlatformTenant | null>,
    options: ProvisioningOptions = DEFAULT_PROVISIONING_OPTIONS,
  ): ProvisioningService {
    return new ProvisioningService(
      {
        tenantById: vi.fn(tenantById),
        // The platform's zone of a provisioning tenant, read before its transaction (FIX-W35-OTA).
        tenantTimeZone: vi.fn(() => Promise.resolve("Europe/Oslo")),
      } as unknown as PlatformReadRepository,
      { url: "postgres://nobody@127.0.0.1:1/none" } as unknown as ProvisionerDatabase,
      options,
      new FakeClock() as Clock,
    );
  }

  it("classifies what reading the tenant throws: a malformed schema name is not retryable, a refused connection is", async () => {
    const malformed = new InvalidTenantSchemaError("tenant_x; DROP SCHEMA platform");
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

    const invalid = await serviceWith(() => Promise.reject(malformed)).provisionTenant(
      provisionFixture.tenantId,
    );
    const lost = await serviceWith(() => Promise.reject(refused)).migrateTenant(provisionFixture.tenantId);

    expect(invalid).toMatchObject({
      status: "failed",
      payload: { error: { code: "INVALID_SCHEMA_NAME" }, retryable: false, steps: [] },
      cause: malformed,
    });
    expect(lost).toMatchObject({
      status: "failed",
      payload: { version: null, error: { code: "CONNECTION_LOST" }, retryable: true },
      cause: refused,
    });
  });

  it("answers tenant.migrate for an unknown tenant, a tenant that is not migrated and an unknown target, not retryable", async () => {
    expect(await serviceWith(() => Promise.resolve(null)).migrateTenant(provisionFixture.tenantId)).toEqual({
      status: "failed",
      payload: {
        version: null,
        error: { code: "TENANT_NOT_FOUND", message: "No tenant has the id of the message" },
        retryable: false,
      },
    });
    for (const status of ["deprovisioning", "deleted", "failed"] as const) {
      expect(await serviceWith(() => Promise.resolve(tenantRow(status))).migrateTenant("ten_x")).toEqual({
        status: "failed",
        payload: {
          version: null,
          error: {
            code: "TENANT_NOT_MIGRATABLE",
            message: `The tenant is ${status}: only provisioning, active and suspended tenants are migrated`,
          },
          retryable: false,
        },
      });
    }
    expect(
      await serviceWith(() => Promise.resolve(tenantRow("active"))).migrateTenant(
        "ten_x",
        "0999_add_nothing",
      ),
    ).toEqual({
      status: "failed",
      payload: {
        version: null,
        error: {
          code: "UNKNOWN_TARGET_VERSION",
          message: "No tenant migration of this release has the target version 0999_add_nothing",
        },
        retryable: false,
      },
    });
  });

  it("caps the message of a failure it decides, so a long unknown target still makes a valid event", async () => {
    // The contract's version pattern has no length limit; the event's error.message allows 1,000 characters.
    const target = `0999_${"x".repeat(2000)}`;

    const result = await serviceWith(() => Promise.resolve(tenantRow("active"))).migrateTenant(
      "ten_x",
      target,
    );

    expect(result).toMatchObject({
      status: "failed",
      payload: { version: null, error: { code: "UNKNOWN_TARGET_VERSION" }, retryable: false },
    });
    const payload = result.status === "failed" ? result.payload : undefined;
    expect(payload?.error.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(() =>
      validateJob("tenant.migration_failed", {
        ...provisionFixture,
        name: "tenant.migration_failed",
        payload,
      }),
    ).not.toThrow();
  });

  it("reports a release without its tenant migrations folder as INVALID_MIGRATION_FILES, not retryable", async () => {
    const missing = { migrationsDir: "/nonexistent-velexis-obe006/migrations/tenant" };
    const invalidFiles = {
      code: "INVALID_MIGRATION_FILES",
      message: "The tenant migrations folder of this release is invalid (1 problem(s)); nothing was applied",
    };

    const migrate = await serviceWith(() => Promise.resolve(tenantRow("active")), missing).migrateTenant(
      "ten_x",
    );
    // A provisioning tenant reaches migrateTenantSchema, which finds no folder; an active one the ledger check.
    const provisions = await Promise.all(
      (["provisioning", "active"] as const).map((status) =>
        serviceWith(() => Promise.resolve(tenantRow(status)), missing).provisionTenant("ten_x"),
      ),
    );

    expect(migrate).toMatchObject({
      status: "failed",
      payload: { version: null, error: invalidFiles, retryable: false },
    });
    for (const provision of provisions) {
      expect(provision).toMatchObject({
        status: "failed",
        payload: { error: invalidFiles, retryable: false, steps: [] },
      });
    }
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
  function processorWith(
    result: () => Promise<ProvisionResult>,
    migration: () => Promise<MigrateResult> = () =>
      Promise.reject(new Error("migrateTenant is not expected")),
  ) {
    const { queue, added } = recordingQueue();
    const provisionTenant = vi.fn(result);
    const migrateTenant = vi.fn(migration);
    const lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
    const log = (level: string) => (fields: Record<string, unknown>, msg: string) =>
      void lines.push({ level, fields, msg });
    const logger = { info: log("info"), warn: log("warn"), error: log("error") } as unknown as PinoLogger;
    // The housekeeping of tenant.suspend and tenant.resume (OBE-074) has tests of its own (housekeeping.service.test.ts).
    const housekeeping = {
      suspend: vi.fn(() => Promise.reject(new Error("suspend is not expected"))),
      resume: vi.fn(() => Promise.reject(new Error("resume is not expected"))),
    };
    const processor = new TenantOpsProcessor(
      { provisionTenant, migrateTenant } as unknown as ProvisioningService,
      housekeeping as unknown as HousekeepingService,
      new TenantEventsProducer(queue, new FakeClock() as Clock),
      logger,
    );
    return { processor, provisionTenant, migrateTenant, housekeeping, added, lines };
  }

  function job(
    name: string,
    data: unknown,
    id = `${provisionFixture.jobId}-1`,
    tries?: { readonly attemptsMade: number; readonly attempts: number },
  ): Job {
    const options =
      tries === undefined ? {} : { attemptsMade: tries.attemptsMade, opts: { attempts: tries.attempts } };
    return { id, name, data, queueName: "ota-tenant-ops", ...options } as unknown as Job;
  }

  const migrateMessage = (payload: Record<string, unknown> = {}) => ({
    ...provisionFixture,
    name: "tenant.migrate",
    payload,
  });

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

  it("fails a name outside the queue's contract as unrecoverable, without running or publishing anything", async () => {
    const { processor, provisionTenant, migrateTenant, housekeeping, added, lines } = processorWith(() =>
      Promise.resolve({ status: "provisioned", payload: PROVISIONED }),
    );

    // Every message of the contract is handled: tenant.migrate since OBE-006 (tests below), tenant.suspend and
    // tenant.resume since OBE-074 (housekeeping.service.test.ts).
    await expect(
      processor.process(job("tenant.delete", { ...provisionFixture, name: "tenant.delete" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(provisionTenant).not.toHaveBeenCalled();
    expect(migrateTenant).not.toHaveBeenCalled();
    expect(housekeeping.suspend).not.toHaveBeenCalled();
    expect(housekeeping.resume).not.toHaveBeenCalled();
    expect(added).toEqual([]);
    expect(lines.map(({ level, msg }) => [level, msg])).toEqual([["error", "queue.job_invalid"]]);
  });

  const LOCK_TIMEOUT_FAILURE: TenantProvisionFailedPayload = {
    error: { code: "LOCK_TIMEOUT", message: "Waiting for a lock timed out (SQLSTATE 55P03)" },
    retryable: true,
    steps: [],
  };

  it("knows the last try of a job from BullMQ's attempts", () => {
    expect(isLastTry({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(false);
    expect(isLastTry({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
    expect(isLastTry({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(true);
    expect(isLastTry({ attemptsMade: 0, opts: { attempts: 1 } })).toBe(true);
    expect(isLastTry({ attemptsMade: 0, opts: { attempts: 0 } })).toBe(true);
    expect(isLastTry({ attemptsMade: 0, opts: {} })).toBe(true);
  });

  it("throws a retryable failure back to BullMQ while the job has tries left, and publishes nothing [OBE-006 AC1]", async () => {
    const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    const { processor, added, lines } = processorWith(() =>
      Promise.resolve({ status: "failed", payload: LOCK_TIMEOUT_FAILURE, cause: lockTimeout }),
    );

    for (const attemptsMade of [0, 1]) {
      await expect(
        processor.process(
          job("tenant.provision", provisionFixture, undefined, { attemptsMade, attempts: 3 }),
        ),
      ).rejects.toBe(lockTimeout);
    }

    expect(added).toEqual([]);
    expect(lines.map(({ level, msg, fields }) => [level, msg, fields["attempt"], fields["code"]])).toEqual([
      ["warn", "tenant_ops.retrying", 1, "LOCK_TIMEOUT"],
      ["warn", "tenant_ops.retrying", 2, "LOCK_TIMEOUT"],
    ]);
  });

  it("publishes tenant.provision_failed {retryable: true} on the last try and fails with the run's error [OBE-006 AC1]", async () => {
    const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    const { processor, added, lines } = processorWith(() =>
      Promise.resolve({ status: "failed", payload: LOCK_TIMEOUT_FAILURE, cause: lockTimeout }),
    );

    const error = await processor
      .process(job("tenant.provision", provisionFixture, undefined, { attemptsMade: 2, attempts: 3 }))
      .catch((thrown: unknown) => thrown);

    expect(error).toBe(lockTimeout);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(added).toEqual([
      {
        name: "tenant.provision_failed",
        data: expect.objectContaining({ payload: LOCK_TIMEOUT_FAILURE }),
        opts: { jobId: `${provisionFixture.jobId}-1` },
      },
    ]);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "tenant_ops.provision_failed",
        fields: expect.objectContaining({ code: "LOCK_TIMEOUT", retryable: true, attempt: 3, attempts: 3 }),
      }),
    ]);
    // The log line names the code, never the error and its message.
    expect(JSON.stringify(lines)).not.toContain("canceling statement");
  });

  it("fails a retryable result without an error with its code and message", async () => {
    const { processor } = processorWith(() =>
      Promise.resolve({ status: "failed", payload: LOCK_TIMEOUT_FAILURE }),
    );

    await expect(
      processor.process(
        job("tenant.provision", provisionFixture, undefined, { attemptsMade: 0, attempts: 3 }),
      ),
    ).rejects.toThrow(new Error("LOCK_TIMEOUT: Waiting for a lock timed out (SQLSTATE 55P03)"));
  });

  it("migrates with the message's target, publishes tenant.migrated after it and returns names and versions only", async () => {
    const migrated: TenantMigratedPayload = {
      schemaVersion: "0002_add_loyalty_cards",
      migrations: [
        ...PROVISIONED.migrations,
        {
          version: "0002_add_loyalty_cards",
          checksum: CHECKSUM,
          phase: "expand",
          appliedAt: "2026-10-14T09:31:00.000Z",
          durationMs: 3,
        },
      ],
    };
    const { processor, migrateTenant, added, lines } = processorWith(
      () => Promise.reject(new Error("provisionTenant is not expected")),
      () =>
        Promise.resolve({
          status: "migrated",
          schemaName: "tenant_acme",
          applied: ["0002_add_loyalty_cards"],
          payload: migrated,
        }),
    );

    const result = await processor.process(
      job(
        "tenant.migrate",
        migrateMessage({ targetVersion: "0002_add_loyalty_cards" }),
        `${provisionFixture.jobId}-2`,
      ),
    );

    expect(migrateTenant).toHaveBeenCalledWith(provisionFixture.tenantId, "0002_add_loyalty_cards");
    expect(result).toEqual({
      event: "tenant.migrated",
      schemaName: "tenant_acme",
      schemaVersion: "0002_add_loyalty_cards",
    });
    expect(added).toEqual([
      {
        name: "tenant.migrated",
        data: expect.objectContaining({ jobId: provisionFixture.jobId, payload: migrated }),
        opts: { jobId: `${provisionFixture.jobId}-2` },
      },
    ]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "tenant_ops.migrated",
        fields: expect.objectContaining({
          targetVersion: "0002_add_loyalty_cards",
          applied: ["0002_add_loyalty_cards"],
          migrations: 2,
        }),
      }),
    );
  });

  it("publishes tenant.migration_failed and fails as unrecoverable for a non-retryable failure [OBE-006 AC2]", async () => {
    const changed = {
      version: "0001_baseline",
      error: { code: "CHECKSUM_MISMATCH", message: "1 applied tenant migration file(s) changed" },
      retryable: false,
    };
    const { processor, migrateTenant, added } = processorWith(
      () => Promise.reject(new Error("provisionTenant is not expected")),
      () => Promise.resolve({ status: "failed", payload: changed, cause: new Error("checksum") }),
    );

    const error = await processor
      .process(job("tenant.migrate", migrateMessage(), undefined, { attemptsMade: 0, attempts: 3 }))
      .catch((thrown: unknown) => thrown);

    expect(migrateTenant).toHaveBeenCalledWith(provisionFixture.tenantId, undefined);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: "CHECKSUM_MISMATCH: 1 applied tenant migration file(s) changed" });
    expect(added).toEqual([
      expect.objectContaining({
        name: "tenant.migration_failed",
        data: expect.objectContaining({ payload: changed }),
      }),
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
