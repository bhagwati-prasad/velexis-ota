// tenant.migrate and the failure classes of ota-tenant-ops against PostgreSQL 16 and Redis 7 (OBE-006; OADR-0007
// items 5–6, tenant provisioning flow §3 and §5). As provision.int.test.ts, the file runs the real worker module graph
// (WorkerModule.forRoot) on a clone of the @velexis/testing template and a Redis database of its own, and plays the
// platform: it inserts platform.tenants rows as velexis_migrator, adds messages to `ota-tenant-ops` with the
// platform's BullMQ id `<jobId>-<attempt>` and reads the events back from `platform-tenant-events`.
//
// A schema provisioned from the release's tenant migrations is at N-1 for these tests: the tests that need a pending
// file or an edited one point the worker at a folder of their own, which holds the release's files (the baseline
// edited, for some) and files numbered after the release's last one, so the tests keep working as the release gains
// migrations. The module of the provisioning service is mocked to read its default migrations folder from
// `migrations.dir` (the real one when unset). Every test provisions tenants of its own.
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import {
  bullmqJobId,
  type TenantEvent,
  type TenantMigratedEvent,
  type TenantMigrateJob,
  type TenantMigrationFailedEvent,
  type TenantProvisionFailedEvent,
  type TenantProvisionJob,
} from "@velexis/api-types/jobs";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
} from "@velexis/db";
import { BASELINE_FILE, readMigrationFiles, type MigrationFiles } from "@velexis/db/migrate";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { UnrecoverableError, type Job, type JobsOptions, type Queue, type Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { validateTenantEventJob } from "../../../src/common/queues/job-validation";
import { OTA_QUEUE, PLATFORM_TENANT_EVENTS } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import type * as ProvisioningServiceModule from "../../../src/provisioning/provisioning.service";
import { TENANT_MIGRATIONS_DIR } from "../../../src/provisioning/provisioning.service";
import { TenantOpsProcessor } from "../../../src/provisioning/tenant-ops.processor";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testWorkerVariables } from "../../helpers/api-env";
import { MemorySink, type LogLine } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/** The tenant migrations folder the worker reads: the release's when unset. */
const migrations = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock("../../../src/provisioning/provisioning.service", async (importOriginal) => {
  const original = await importOriginal<typeof ProvisioningServiceModule>();
  return {
    ...original,
    DEFAULT_PROVISIONING_OPTIONS: {
      get migrationsDir(): string {
        return migrations.dir ?? original.TENANT_MIGRATIONS_DIR;
      },
    },
  };
});

/** The platform's job options of a dispatch (platform/docs/flows/provisioning.md, Dispatch). */
const PLATFORM_JOB_OPTIONS: JobsOptions = { attempts: 3, backoff: { type: "exponential", delay: 30_000 } };
/** The same three tries with a short backoff, so the in-attempt retries of a test do not wait 90 s. */
const QUICK_RETRIES: JobsOptions = { attempts: 3, backoff: { type: "fixed", delay: 50 } };
/** SQLSTATE lock_not_available: the runner's `lock_timeout` of 5 s ran out. */
const LOCK_NOT_AVAILABLE = "55P03";
/** Three tries that each wait out the runner's 5 s lock_timeout, plus the dispatches around them. */
const LOCK_TIMEOUT_TEST_MS = 60_000;

/** A tenant migration file a test adds to its folder: ledger id, file name and text. */
interface TestMigration {
  readonly id: string;
  readonly file: string;
  readonly sql: string;
}

/** The release's tenant migrations (read in `beforeAll`): every folder of a test starts with them. */
let release: MigrationFiles;
/** N, after the release's files: a table that references one of the baseline. */
let loyaltyCards: TestMigration;
/** N+1. */
let giftCards: TestMigration;

/**
 * The `offset`-th tenant migration after the release's last one, numbered as the release numbers its files: the
 * first one is `0002_<name>` while the release ends at `0001_baseline`.
 */
function laterMigration(offset: number, name: string, description: string, body: string): TestMigration {
  const last = release.numbered.at(-1);
  const digits = last?.id.split("_", 1)[0];
  if (digits === undefined) {
    throw new Error("the release has no numbered tenant migration");
  }
  const id = `${String(Number(digits) + offset).padStart(digits.length, "0")}_${name}`;
  return { id, file: `${id}.sql`, sql: `-- velexis:phase expand\n-- ${description}\n${body}` };
}

/** The number of a migration, e.g. `0002`: `tenant.migrate` takes it as `targetVersion` like the ledger id. */
function numberOf(migration: TestMigration): string {
  return migration.id.split("_", 1)[0] ?? migration.id;
}

const quietPoolLogger = { error: (): void => undefined };
const silentValidationLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let sink: MemorySink;
let app: INestApplicationContext;
let migratorPool: ReturnType<typeof createPool>;
/** velexis_migrator, the owner of the platform tables (as the platform inserts tenants) and member of the provisioner. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
let tenantOps: Queue;
let platformEvents: Queue;
let worker: Worker;
const folders: string[] = [];

beforeAll(async () => {
  release = await readMigrationFiles(TENANT_MIGRATIONS_DIR, "tenant");
  loyaltyCards = laterMigration(
    1,
    "add_loyalty_cards",
    "Add loyalty cards",
    "CREATE TABLE loyalty_cards (id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers (id));\n",
  );
  giftCards = laterMigration(
    2,
    "add_gift_cards",
    "Add gift cards",
    "CREATE TABLE gift_cards (id text PRIMARY KEY);\n",
  );
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 2,
  });
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  sink = new MemorySink();
  useNextApplicationLoggerOutsideRequests();
  app = await createWorkerApp(WorkerModule.forRoot(config, { logger: createWorkerLogger(config, sink) }));
  await app.init();
  tenantOps = app.get<Queue>(getQueueToken(OTA_QUEUE.tenantOps));
  platformEvents = app.get<Queue>(getQueueToken(PLATFORM_TENANT_EVENTS));
  worker = app.get(TenantOpsProcessor).worker;
  await worker.waitUntilReady();
});

afterEach(() => {
  migrations.dir = undefined;
});

afterAll(async () => {
  await app?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
  await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---- The platform's side ----------------------------------------------------------------------------------------

/** Inserts a tenant as the platform does (velexis_migrator) and returns its id; its schema is `tenant_<key>`. */
async function insertTenant(key: string, status = "provisioning"): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, plan_code: "early_access", key, name: `${key} travel`, status })
    .execute();
  return id;
}

async function setTenantStatus(id: string, status: string): Promise<void> {
  await migrator.updateTable("platform.tenants").set({ status }).where("id", "=", id).execute();
}

function envelope(tenantId: string) {
  return {
    v: 1 as const,
    jobId: newId("job"),
    tenantId,
    requestedAt: new Date().toISOString(),
    requestId: `req-obe006-${newId("req").slice(4, 20).toLowerCase()}`,
  };
}

function provisionMessage(tenantId: string): TenantProvisionJob {
  return { ...envelope(tenantId), name: "tenant.provision", payload: {} };
}

function migrateMessage(tenantId: string, targetVersion?: string): TenantMigrateJob {
  return {
    ...envelope(tenantId),
    name: "tenant.migrate",
    payload: targetVersion === undefined ? {} : { targetVersion },
  };
}

type Outcome =
  | { readonly state: "completed"; readonly result: unknown }
  | { readonly state: "failed"; readonly error: Error };

/**
 * Dispatches `message` as attempt `attempt` (BullMQ id `<jobId>-<attempt>`) and resolves with its final outcome:
 * BullMQ emits `failed` for every failed try, so only a failure that finished the job (no try left, or
 * unrecoverable) counts.
 */
async function dispatch(
  message: { readonly jobId: string; readonly name: string },
  attempt: number,
  options: JobsOptions = PLATFORM_JOB_OPTIONS,
): Promise<Outcome> {
  const id = bullmqJobId(message.jobId, attempt);
  const outcome = new Promise<Outcome>((resolveOutcome) => {
    const completed = (job: Job, result: unknown): void => {
      if (job.id === id) {
        stop();
        resolveOutcome({ state: "completed", result });
      }
    };
    const failed = (job: Job | undefined, error: Error): void => {
      if (job?.id === id && typeof job.finishedOn === "number") {
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
  await tenantOps.add(message.name, message, { ...options, jobId: id });
  return outcome;
}

/** Provisions a new tenant through the worker with the release's migrations and sets it `status`. */
async function provisionedTenant(key: string, status = "active"): Promise<string> {
  const tenantId = await insertTenant(key);
  expect(await dispatch(provisionMessage(tenantId), 1)).toMatchObject({ state: "completed" });
  if (status !== "provisioning") {
    await setTenantStatus(tenantId, status);
  }
  return tenantId;
}

/** The events published for the job `jobId`, validated, by BullMQ id. */
async function eventsOf(jobId: string): Promise<Map<string, TenantEvent>> {
  const jobs = await platformEvents.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
  const events = new Map<string, TenantEvent>();
  for (const job of jobs) {
    const event = validateTenantEventJob(job, silentValidationLogger);
    if (event.jobId === jobId) {
      events.set(String(job.id), event);
    }
  }
  return events;
}

/** The log lines of the worker about the job `jobId` (any attempt). */
function logLinesOf(jobId: string): LogLine[] {
  return sink.records().filter((line) => String(line["jobId"]).startsWith(`${jobId}-`));
}

// ---- Migration folders and the database -------------------------------------------------------------------------

/**
 * A tenant migrations folder: the release's files (the baseline edited when `editBaseline`, as if someone changed it
 * after it was applied) and the given later files.
 */
async function migrationsFolder(
  files: readonly TestMigration[],
  options: { readonly editBaseline?: boolean } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-obe006-"));
  folders.push(dir);
  for (const file of release.numbered) {
    if (options.editBaseline === true && file.file === BASELINE_FILE) {
      const baseline = await readFile(file.path, "utf8");
      await writeFile(join(dir, file.file), `${baseline}\n-- edited after it was applied\n`);
    } else {
      await copyFile(file.path, join(dir, file.file));
    }
  }
  for (const { file, sql: text } of files) {
    await writeFile(join(dir, file), text);
  }
  return dir;
}

async function schemaExists(schema: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${schema}) AS found`.execute(migrator);
  return rows[0]?.found === true;
}

async function tablesOf(schema: string): Promise<string[]> {
  const { rows } = await sql<{ table: string }>`SELECT tablename AS table FROM pg_catalog.pg_tables
    WHERE schemaname = ${schema} ORDER BY tablename`.execute(migrator);
  return rows.map((row) => row.table);
}

/** The schema's ledger, read as velexis_ota_app through tenantTx. */
async function ledgerOf(schema: string) {
  return tenantTx(createTenantDb(otaPool, { appEnv: "test" }), schema, (trx) =>
    trx
      .selectFrom("schema_migrations")
      .select(["id", "checksum", "phase", "status", "execution_ms", "created_at"])
      .orderBy("id")
      .execute(),
  );
}

/** The ledger as the events carry it. */
function asRecords(ledger: Awaited<ReturnType<typeof ledgerOf>>) {
  return ledger.map((row) => ({
    version: row.id,
    checksum: row.checksum,
    phase: row.phase,
    appliedAt: row.created_at.toISOString(),
    durationMs: row.execution_ms,
  }));
}

/** Holds the advisory lock of `schema`'s migrations, as a second run would, while `work` runs. */
async function holdingSchemaLock<T>(schema: string, work: () => Promise<T>): Promise<T> {
  return migrator.connection().execute(async (connection) => {
    await sql`SELECT pg_advisory_lock(hashtext(${schema}::text))`.execute(connection);
    try {
      return await work();
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext(${schema}::text))`.execute(connection);
    }
  });
}

// ---- Tests ------------------------------------------------------------------------------------------------------

describe("failure classification on ota-tenant-ops", () => {
  it(
    "ends a forced lock timeout in tenant.provision_failed {retryable: true} after the in-attempt retries [OBE-006 AC1]",
    async () => {
      const tenantId = await insertTenant("lima");
      const message = provisionMessage(tenantId);

      // A second connection holds the advisory lock of the schema's migrations during all three tries.
      const outcome = await holdingSchemaLock("tenant_lima", () => dispatch(message, 1, QUICK_RETRIES));

      // The last try failed with the lock timeout itself, not as unrecoverable: BullMQ used all three tries.
      expect(outcome.state).toBe("failed");
      const error = outcome.state === "failed" ? outcome.error : undefined;
      expect(error).toMatchObject({ code: LOCK_NOT_AVAILABLE });
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect((await tenantOps.getJob(bullmqJobId(message.jobId, 1)))?.attemptsMade).toBe(3);
      expect(await schemaExists("tenant_lima")).toBe(false);

      // One event for the attempt, after its last try.
      const events = await eventsOf(message.jobId);
      expect([...events.keys()]).toEqual([bullmqJobId(message.jobId, 1)]);
      expect((events.get(bullmqJobId(message.jobId, 1)) as TenantProvisionFailedEvent).payload).toEqual({
        error: {
          code: "LOCK_TIMEOUT",
          message:
            "Waiting for a lock timed out (SQLSTATE 55P03): another run may hold the tenant schema's advisory " +
            "lock; nothing was changed",
        },
        retryable: true,
        steps: [],
      });
      expect(logLinesOf(message.jobId).map((line) => [line["msg"], line["attempt"], line["code"]])).toEqual([
        ["tenant_ops.retrying", 1, "LOCK_TIMEOUT"],
        ["tenant_ops.retrying", 2, "LOCK_TIMEOUT"],
        ["tenant_ops.provision_failed", 3, "LOCK_TIMEOUT"],
      ]);

      // The lock is free again: the platform's next attempt provisions the tenant.
      expect(await dispatch(message, 2)).toMatchObject({
        state: "completed",
        result: { event: "tenant.provisioned", schemaName: "tenant_lima" },
      });
      expect([...(await eventsOf(message.jobId)).keys()].sort()).toEqual(
        [1, 2].map((attempt) => bullmqJobId(message.jobId, attempt)),
      );
    },
    LOCK_TIMEOUT_TEST_MS,
  );

  it(
    "reports a lock timeout of tenant.migrate on the last try as tenant.migration_failed {version: null, retryable: true}",
    async () => {
      const tenantId = await provisionedTenant("mike");
      const message = migrateMessage(tenantId);

      const outcome = await holdingSchemaLock("tenant_mike", () => dispatch(message, 1, { attempts: 1 }));

      expect(outcome.state === "failed" ? outcome.error : undefined).toMatchObject({
        code: LOCK_NOT_AVAILABLE,
      });
      const events = [...(await eventsOf(message.jobId)).values()] as TenantMigrationFailedEvent[];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "tenant.migration_failed",
        jobId: message.jobId,
        tenantId,
        payload: { version: null, error: { code: "LOCK_TIMEOUT" }, retryable: true },
      });
    },
    LOCK_TIMEOUT_TEST_MS,
  );

  it("ends tenant.migrate over an edited, already applied file in retryable: false and changes nothing [OBE-006 AC2]", async () => {
    const tenantId = await provisionedTenant("november");
    const ledger = await ledgerOf("tenant_november");
    const tables = await tablesOf("tenant_november");
    // The edited baseline, and a pending file that must not be applied either.
    migrations.dir = await migrationsFolder([loyaltyCards], { editBaseline: true });
    const message = migrateMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    // Three tries were allowed; the first ended them.
    expect((await tenantOps.getJob(bullmqJobId(message.jobId, 1)))?.attemptsMade).toBe(1);
    expect(await ledgerOf("tenant_november")).toEqual(ledger);
    expect(await tablesOf("tenant_november")).toEqual(tables);
    const events = [...(await eventsOf(message.jobId)).values()] as TenantMigrationFailedEvent[];
    expect(events.map((event) => event.payload)).toEqual([
      {
        version: "0001_baseline",
        error: {
          code: "CHECKSUM_MISMATCH",
          message:
            "1 applied tenant migration file(s) changed since they were applied: 0001_baseline.sql. Nothing was " +
            "applied; restore the merged files and fix forward with a new numbered file",
        },
        retryable: false,
      },
    ]);
  });

  it("ends tenant.provision over an edited, already applied file in retryable: false and changes nothing [OBE-006 AC2]", async () => {
    // Provisioned once, still `provisioning` (the platform has not consumed the event yet), then dispatched again.
    const tenantId = await provisionedTenant("oscar", "provisioning");
    const ledger = await ledgerOf("tenant_oscar");
    migrations.dir = await migrationsFolder([], { editBaseline: true });
    const message = provisionMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    expect(await ledgerOf("tenant_oscar")).toEqual(ledger);
    const [event] = [...(await eventsOf(message.jobId)).values()] as TenantProvisionFailedEvent[];
    expect(event?.payload).toMatchObject({
      error: { code: "CHECKSUM_MISMATCH" },
      retryable: false,
      steps: [{ step: "run_migrations", status: "failed", error: { code: "CHECKSUM_MISMATCH" } }],
    });
  });

  it("stops tenant.migrate also for an edited file after its target, and changes nothing", async () => {
    const tenantId = await provisionedTenant("papa");
    migrations.dir = await migrationsFolder([loyaltyCards, giftCards]);
    expect(await dispatch(migrateMessage(tenantId), 1)).toMatchObject({ state: "completed" });
    const ledger = await ledgerOf("tenant_papa");
    migrations.dir = await migrationsFolder([
      loyaltyCards,
      { ...giftCards, sql: `${giftCards.sql}-- edited after it was applied\n` },
    ]);
    const message = migrateMessage(tenantId, loyaltyCards.id);

    const outcome = await dispatch(message, 1);

    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    expect(await ledgerOf("tenant_papa")).toEqual(ledger);
    const [event] = [...(await eventsOf(message.jobId)).values()] as TenantMigrationFailedEvent[];
    expect(event?.payload).toMatchObject({
      version: giftCards.id,
      error: { code: "CHECKSUM_MISMATCH" },
      retryable: false,
    });
  });

  it("reports a file that fails as MIGRATION_FAILED with its version, not retryable, and rolls it back", async () => {
    const tenantId = await provisionedTenant("quebec");
    const ledger = await ledgerOf("tenant_quebec");
    const customersAgain = laterMigration(
      2,
      "add_customers_again",
      "Add customers again",
      "CREATE TABLE customers (id text PRIMARY KEY);\n",
    );
    migrations.dir = await migrationsFolder([loyaltyCards, customersAgain]);
    const message = migrateMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    // One transaction: the loyalty cards file is rolled back with the failing file after it.
    expect(await ledgerOf("tenant_quebec")).toEqual(ledger);
    expect(await tablesOf("tenant_quebec")).not.toContain("loyalty_cards");
    const [event] = [...(await eventsOf(message.jobId)).values()] as TenantMigrationFailedEvent[];
    expect(event?.payload).toEqual({
      version: customersAgain.id,
      error: {
        code: "MIGRATION_FAILED",
        message:
          `The tenant migration ${customersAgain.file} failed (SQLSTATE 42P07): its transaction was rolled ` +
          "back and nothing of it is recorded; fix it forward with a new numbered file",
      },
      retryable: false,
    });
  });

  it("answers SCHEMA_MISSING, not retryable, for tenant.migrate on a tenant without a schema, and creates none", async () => {
    const tenantId = await insertTenant("romeo");
    const message = migrateMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    expect(await schemaExists("tenant_romeo")).toBe(false);
    const [event] = [...(await eventsOf(message.jobId)).values()] as TenantMigrationFailedEvent[];
    expect(event?.payload).toMatchObject({
      version: null,
      error: { code: "SCHEMA_MISSING" },
      retryable: false,
    });
  });
});

describe("tenant.migrate on ota-tenant-ops", () => {
  it("applies the pending file to a schema at N-1 and reports the full ledger [OBE-006 AC3]", async () => {
    const tenantId = await provisionedTenant("sierra");
    const tenants = createTenantDb(otaPool, { appEnv: "test" });
    const settingsBefore = await tenantTx(tenants, "tenant_sierra", (trx) =>
      trx.selectFrom("storefront_settings").selectAll().execute(),
    );
    // The OTA removed the seeded default markup rule: a run that seeds would insert it again.
    await tenantTx(tenants, "tenant_sierra", (trx) =>
      trx.deleteFrom("markup_rules").where("is_default", "=", true).execute(),
    );
    expect((await ledgerOf("tenant_sierra")).map((row) => row.id)).toEqual(
      release.numbered.map((file) => file.id),
    );
    migrations.dir = await migrationsFolder([loyaltyCards]);
    const message = migrateMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome).toEqual({
      state: "completed",
      result: {
        event: "tenant.migrated",
        schemaName: "tenant_sierra",
        schemaVersion: loyaltyCards.id,
      },
    });
    // The pending file is applied with its checksum; the release's rows are the ones provisioning wrote.
    const files = await readMigrationFiles(migrations.dir, "tenant");
    const ledger = await ledgerOf("tenant_sierra");
    expect(ledger.map(({ id, checksum, phase, status }) => ({ id, checksum, phase, status }))).toEqual(
      files.numbered.map((file) => ({
        id: file.id,
        checksum: file.checksum,
        phase: file.phase,
        status: "applied",
      })),
    );
    // No GRANT in the file: velexis_ota_app writes the new table through the default privileges of provisioning.
    await tenantTx(tenants, "tenant_sierra", async (trx) => {
      await sql`INSERT INTO customers (id, email) VALUES ('cus_obe006', 'traveller@example.com')`.execute(
        trx,
      );
      await sql`INSERT INTO loyalty_cards (id, customer_id) VALUES ('lc_obe006', 'cus_obe006')`.execute(trx);
    });
    // Nothing was seeded again: the settings row is unchanged and the removed default rule stays removed.
    expect(
      await tenantTx(tenants, "tenant_sierra", (trx) =>
        trx.selectFrom("storefront_settings").selectAll().execute(),
      ),
    ).toEqual(settingsBefore);
    expect(
      await tenantTx(tenants, "tenant_sierra", (trx) =>
        trx.selectFrom("markup_rules").select("id").execute(),
      ),
    ).toEqual([]);

    // tenant.migrated answers the message's job and attempt with the full ledger.
    const events = await eventsOf(message.jobId);
    expect([...events.keys()]).toEqual([bullmqJobId(message.jobId, 1)]);
    expect(events.get(bullmqJobId(message.jobId, 1)) as TenantMigratedEvent).toEqual({
      v: 1,
      name: "tenant.migrated",
      jobId: message.jobId,
      tenantId,
      requestedAt: expect.any(String) as string,
      requestId: message.requestId,
      payload: { schemaVersion: loyaltyCards.id, migrations: asRecords(ledger) },
    });

    // The same message again applies nothing and answers the same ledger.
    expect(await dispatch(message, 2)).toMatchObject({
      state: "completed",
      result: { schemaVersion: loyaltyCards.id },
    });
    expect(await ledgerOf("tenant_sierra")).toEqual(ledger);
    const again = (await eventsOf(message.jobId)).get(bullmqJobId(message.jobId, 2)) as TenantMigratedEvent;
    expect(again.payload.migrations).toEqual(asRecords(ledger));
  });

  it("applies the pending files up to targetVersion only, then the rest, and refuses a version the release does not have", async () => {
    // A suspended tenant is migrated like an active one (the deploy fan-out's statuses).
    const tenantId = await provisionedTenant("tango", "suspended");
    migrations.dir = await migrationsFolder([loyaltyCards, giftCards]);

    // The target by its number alone, e.g. `0002`.
    expect(await dispatch(migrateMessage(tenantId, numberOf(loyaltyCards)), 1)).toMatchObject({
      state: "completed",
      result: { schemaVersion: loyaltyCards.id },
    });
    expect((await ledgerOf("tenant_tango")).map((row) => row.id)).toEqual([
      ...release.numbered.map((file) => file.id),
      loyaltyCards.id,
    ]);
    expect(await tablesOf("tenant_tango")).not.toContain("gift_cards");

    expect(await dispatch(migrateMessage(tenantId), 1)).toMatchObject({
      state: "completed",
      result: { schemaVersion: giftCards.id },
    });
    expect(await tablesOf("tenant_tango")).toContain("gift_cards");

    const nothing = laterMigration(9, "add_nothing", "Add nothing", "SELECT 1;\n");
    const unknown = migrateMessage(tenantId, nothing.id);
    const outcome = await dispatch(unknown, 1);
    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    const [event] = [...(await eventsOf(unknown.jobId)).values()] as TenantMigrationFailedEvent[];
    expect(event?.payload).toEqual({
      version: null,
      error: {
        code: "UNKNOWN_TARGET_VERSION",
        message: `No tenant migration of this release has the target version ${nothing.id}`,
      },
      retryable: false,
    });
  });
});
