// The tenant.provision consumer against PostgreSQL 16 and Redis 7 (OBE-005; OADR-0007, tenant provisioning flow §1,
// §2, §5 and §7). The file runs the real worker module graph (WorkerModule.forRoot: TenancyModule, QueuesModule,
// ProvisioningModule) on a clone of the @velexis/testing template and a Redis database of its own. It plays the
// platform: platform.tenants rows are inserted as velexis_migrator, `tenant.provision` messages are added to
// `ota-tenant-ops` with the platform's BullMQ id `<jobId>-<attempt>` and job options, and the events the worker
// publishes are read back from `platform-tenant-events`, where no consumer takes them. Every test provisions tenants
// of its own, so no test depends on another.
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import {
  bullmqJobId,
  type TenantEvent,
  type TenantProvisionedEvent,
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
import { BASELINE_FILE, migrateTenantSchema, readMigrationFiles } from "@velexis/db/migrate";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { UnrecoverableError, type Job, type JobsOptions, type Queue, type Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { validateTenantEventJob } from "../../../src/common/queues/job-validation";
import { OTA_QUEUE, PLATFORM_TENANT_EVENTS } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { ProvisioningService, TENANT_MIGRATIONS_DIR } from "../../../src/provisioning/provisioning.service";
import { TenantOpsProcessor } from "../../../src/provisioning/tenant-ops.processor";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/** The platform's job options of a dispatch (platform/docs/flows/provisioning.md, Dispatch). */
const PLATFORM_JOB_OPTIONS: JobsOptions = { attempts: 3, backoff: { type: "exponential", delay: 30_000 } };
/** The privileges of velexis_ota_app on every tenant table: exactly DML (OADR-0007 item 3). */
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];
/** SQLSTATE admin_shutdown: the provisioning connection was terminated. */
const ADMIN_SHUTDOWN = "57P01";

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
let service: ProvisioningService;
const folders: string[] = [];

beforeAll(async () => {
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
  service = app.get(ProvisioningService);
  await worker.waitUntilReady();
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

interface TenantRow {
  readonly key: string;
  readonly name: string;
  readonly status?: string;
  readonly default_currency?: string;
  readonly default_locale?: string;
}

/** Inserts a tenant as the platform does (velexis_migrator) and returns its id; its schema is `tenant_<key>`. */
async function insertTenant(row: TenantRow): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, plan_code: "early_access", ...row })
    .execute();
  return id;
}

async function setTenantStatus(id: string, status: string): Promise<void> {
  await migrator.updateTable("platform.tenants").set({ status }).where("id", "=", id).execute();
}

/** The `tenant.provision` message of a new provisioning job of `tenantId`. */
function provisionMessage(tenantId: string): TenantProvisionJob {
  return {
    v: 1,
    name: "tenant.provision",
    jobId: newId("job"),
    tenantId,
    requestedAt: new Date().toISOString(),
    requestId: `req-obe005-${newId("req").slice(4, 20).toLowerCase()}`,
    payload: {},
  };
}

type Outcome =
  | { readonly state: "completed"; readonly result: unknown }
  | { readonly state: "failed"; readonly error: Error };

/** Dispatches `message` as attempt `attempt` (BullMQ id `<jobId>-<attempt>`) and resolves with its final outcome. */
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
      if (job?.id === id) {
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

/** The events published for the provisioning job `jobId`, validated, by BullMQ id. */
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

// ---- Reading the database ---------------------------------------------------------------------------------------

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

/** The seeded rows of `schema`, read as velexis_ota_app through tenantTx. */
async function seedsOf(schema: string) {
  return tenantTx(createTenantDb(otaPool, { appEnv: "test" }), schema, async (trx) => ({
    settings: await trx.selectFrom("storefront_settings").selectAll().execute(),
    markupRules: await trx.selectFrom("markup_rules").selectAll().execute(),
  }));
}

/**
 * The transactions that wrote the schema: the schema's catalog row, its default privileges, its relations (the
 * GRANTs rewrote them in the same transaction), the ledger rows and the seeded rows, by the xid that wrote each.
 * Read as velexis_migrator, a member of the schema's owner; test code may name the schema, application code never.
 */
async function writingTransactions(schema: string): Promise<Record<string, string[]>> {
  const { rows } = await sql<{ what: string; xids: string[] }>`
    WITH ns AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ${schema})
    SELECT what, array_agg(DISTINCT xid ORDER BY xid) AS xids FROM (
      SELECT 'schema' AS what, xmin::text AS xid FROM pg_catalog.pg_namespace WHERE oid = (SELECT oid FROM ns)
      UNION ALL SELECT 'default_privileges', xmin::text FROM pg_catalog.pg_default_acl
        WHERE defaclnamespace = (SELECT oid FROM ns)
      UNION ALL SELECT 'relations', xmin::text FROM pg_catalog.pg_class WHERE relnamespace = (SELECT oid FROM ns)
      UNION ALL SELECT 'ledger', xmin::text FROM ${sql.table(`${schema}.schema_migrations`)}
      UNION ALL SELECT 'storefront_settings', xmin::text FROM ${sql.table(`${schema}.storefront_settings`)}
      UNION ALL SELECT 'markup_rules', xmin::text FROM ${sql.table(`${schema}.markup_rules`)}
    ) AS writes GROUP BY what ORDER BY what`.execute(migrator);
  return Object.fromEntries(rows.map((row) => [row.what, row.xids]));
}

/** The privileges of a role on every table of `schema`, by table. */
async function tablePrivileges(role: string, schema: string): Promise<Record<string, string[]>> {
  const { rows } = await sql<{ table: string; privileges: string[] }>`
    SELECT c.relname AS table, array(
      SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
      WHERE has_table_privilege(${role}::name, c.oid, p)) AS privileges
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`.execute(migrator);
  return Object.fromEntries(rows.map((row) => [row.table, row.privileges]));
}

/**
 * A hash of the normalised catalog of `schema`, as the nightly drift check describes it (db README §4): columns,
 * indexes, constraints, triggers and privileges, with the schema's own name taken out.
 */
async function catalogHash(schema: string): Promise<string> {
  const { rows } = await sql<{ hash: string; lines: number }>`
    WITH lines AS (
      SELECT format('column %s.%s %s %s %s', table_name, column_name, data_type, is_nullable,
        coalesce(column_default, '')) AS line
      FROM information_schema.columns WHERE table_schema = ${schema}
      UNION ALL SELECT format('index %s %s', indexname, indexdef) FROM pg_catalog.pg_indexes
        WHERE schemaname = ${schema}
      UNION ALL SELECT format('constraint %s %s %s', cl.relname, co.conname, pg_get_constraintdef(co.oid))
        FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_class cl ON cl.oid = co.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = ${schema}
      UNION ALL SELECT format('trigger %s', pg_get_triggerdef(t.oid)) FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class cl ON cl.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = ${schema} AND NOT t.tgisinternal
      UNION ALL SELECT format('acl %s %s', cl.relname, cl.relacl) FROM pg_catalog.pg_class cl
        JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = ${schema}
      UNION ALL SELECT format('default acl %s %s', d.defaclobjtype, d.defaclacl) FROM pg_catalog.pg_default_acl d
        JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = ${schema}
      UNION ALL SELECT format('schema acl %s', nspacl) FROM pg_catalog.pg_namespace WHERE nspname = ${schema}
    )
    SELECT md5(string_agg(replace(line, ${schema}, '<schema>'), E'\n' ORDER BY line)) AS hash,
      count(*)::int AS lines
    FROM lines`.execute(migrator);
  const [row] = rows;
  if (row === undefined || row.lines < 100) {
    throw new Error(`the catalog of ${schema} has only ${row?.lines ?? 0} lines`);
  }
  return row.hash;
}

async function runnerSessions(): Promise<number> {
  const { rows } = await sql<{
    sessions: number;
  }>`SELECT count(*)::int AS sessions FROM pg_catalog.pg_stat_activity
    WHERE datname = ${db.name} AND application_name = 'velexis-migrate-tenant'`.execute(migrator);
  return rows[0]?.sessions ?? -1;
}

// ---- Tests ------------------------------------------------------------------------------------------------------

describe("tenant.provision on ota-tenant-ops", () => {
  it("creates the schema, applies every migration, grants and seeds in one transaction and reports tenant.provisioned with the ledger [OF-11 AC1] [OBE-005 AC1]", async () => {
    const tenantId = await insertTenant({
      key: "acme",
      name: "Acme Travel",
      default_currency: "GBP",
      default_locale: "en-GB",
    });
    const message = provisionMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome).toEqual({
      state: "completed",
      result: { event: "tenant.provisioned", schemaName: "tenant_acme", schemaVersion: "0001_baseline" },
    });

    // Every file of migrations/tenant, applied with its checksum; every table of the baseline.
    const files = await readMigrationFiles(TENANT_MIGRATIONS_DIR, "tenant");
    const ledger = await ledgerOf("tenant_acme");
    expect(ledger.map(({ id, checksum, phase, status }) => ({ id, checksum, phase, status }))).toEqual(
      files.numbered.map((file) => ({
        id: file.id,
        checksum: file.checksum,
        phase: file.phase,
        status: "applied",
      })),
    );
    const tables = await tablesOf("tenant_acme");
    expect(tables).toHaveLength(42);
    expect(tables).toEqual(await tablesOf("tenant_alpha"));

    // Grants: DML for velexis_ota_app on every table (nothing more), nothing for velexis_platform_app.
    const privileges = await tablePrivileges("velexis_ota_app", "tenant_acme");
    expect(Object.keys(privileges)).toEqual(tables);
    // Exactly DML on every table: never TRUNCATE, REFERENCES or TRIGGER.
    expect(new Set(Object.values(privileges).map((granted) => granted.join(",")))).toEqual(
      new Set([DML.join(",")]),
    );
    expect(
      (
        await sql<{ usage: boolean; platform: boolean }>`SELECT
          has_schema_privilege('velexis_ota_app', 'tenant_acme', 'USAGE') AS usage,
          has_schema_privilege('velexis_platform_app', 'tenant_acme', 'USAGE') AS platform`.execute(migrator)
      ).rows,
    ).toEqual([{ usage: true, platform: false }]);

    // Seeds: the settings row from the tenant's name, currency and locale, and the default markup rule.
    const seeds = await seedsOf("tenant_acme");
    expect(seeds.settings).toEqual([
      expect.objectContaining({
        id: "sfs_default",
        brand_name: "Acme Travel",
        default_currency: "GBP",
        default_locale: "en-GB",
        ticketing_policy: "issue_after_payment",
        payment_timing: "authorize_before_booking",
      }),
    ]);
    expect(seeds.markupRules).toEqual([
      expect.objectContaining({ name: "Default", percentage: "0.0000", priority: 1000, is_default: true }),
    ]);

    // One transaction: the schema, its default privileges, every relation, the ledger and the seeds have one writer.
    const writers = await writingTransactions("tenant_acme");
    expect(Object.keys(writers)).toEqual([
      "default_privileges",
      "ledger",
      "markup_rules",
      "relations",
      "schema",
      "storefront_settings",
    ]);
    expect(new Set(Object.values(writers).flat()).size).toBe(1);

    // The event, after the commit: the ledger as written, the three steps, answering the message's job and attempt.
    const events = await eventsOf(message.jobId);
    expect([...events.keys()]).toEqual([bullmqJobId(message.jobId, 1)]);
    const event = events.get(bullmqJobId(message.jobId, 1)) as TenantProvisionedEvent;
    expect(event).toMatchObject({
      v: 1,
      name: "tenant.provisioned",
      jobId: message.jobId,
      tenantId,
      requestId: message.requestId,
      payload: {
        schemaName: "tenant_acme",
        schemaVersion: "0001_baseline",
        migrations: ledger.map((row) => ({
          version: row.id,
          checksum: row.checksum,
          phase: row.phase,
          appliedAt: row.created_at.toISOString(),
          durationMs: row.execution_ms,
        })),
      },
    });
    expect(event.payload.steps.map(({ step, status }) => [step, status])).toEqual([
      ["create_schema", "succeeded"],
      ["run_migrations", "succeeded"],
      ["seed_defaults", "succeeded"],
    ]);
    expect(await runnerSessions()).toBe(0);
    // Neither the provisioner's DSN nor its password reaches a log line.
    expect(sink.text()).not.toContain(db.urlFor("provisioner"));
    expect(sink.text()).not.toContain(new URL(db.urlFor("provisioner")).password);
  });

  it("grants velexis_ota_app the tables of a later migration through the default privileges of provisioning", async () => {
    const tenantId = await insertTenant({ key: "later", name: "Later Trips" });
    expect(await dispatch(provisionMessage(tenantId), 1)).toMatchObject({ state: "completed" });
    const dir = await mkdtemp(join(tmpdir(), "velexis-obe005-later-"));
    folders.push(dir);
    await copyFile(join(TENANT_MIGRATIONS_DIR, BASELINE_FILE), join(dir, BASELINE_FILE));
    await writeFile(
      join(dir, "0002_add_loyalty_cards.sql"),
      "-- velexis:phase expand\n-- Add loyalty cards\n" +
        "CREATE TABLE loyalty_cards (id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers (id));\n",
    );

    // As the deploy fan-out runs it: velexis_migrator, no --create, no GRANT in the file.
    await migrateTenantSchema({ schema: "tenant_later", dir, url: db.urlFor("migrator") });

    expect((await tablePrivileges("velexis_ota_app", "tenant_later"))["loyalty_cards"]).toEqual(DML);
  });

  it("answers tenant.provisioned again for the same message, also once the tenant is active, and changes nothing [OF-11 AC2] [OBE-005 AC2]", async () => {
    const tenantId = await insertTenant({ key: "bravo", name: "Bravo Holidays" });
    const message = provisionMessage(tenantId);
    expect(await dispatch(message, 1)).toMatchObject({ state: "completed" });
    const ledger = await ledgerOf("tenant_bravo");
    // The OTA edits its settings before the message comes again: seeds never overwrite.
    await tenantTx(createTenantDb(otaPool, { appEnv: "test" }), "tenant_bravo", (trx) =>
      trx.updateTable("storefront_settings").set({ brand_name: "Bravo!" }).execute(),
    );

    // The same message again (the platform re-dispatched it), then once more after the platform activated the tenant.
    expect(await dispatch(message, 2)).toMatchObject({
      state: "completed",
      result: { event: "tenant.provisioned", schemaName: "tenant_bravo", schemaVersion: "0001_baseline" },
    });
    await setTenantStatus(tenantId, "active");
    expect(await dispatch(message, 3)).toMatchObject({ state: "completed" });

    // One schema: the same ledger, one settings row with the OTA's edit, one default rule.
    expect(await ledgerOf("tenant_bravo")).toEqual(ledger);
    const seeds = await seedsOf("tenant_bravo");
    expect(seeds.settings.map((row) => row.brand_name)).toEqual(["Bravo!"]);
    expect(seeds.markupRules).toHaveLength(1);

    // Three tenant.provisioned events, one per attempt, with the same ledger; the repeats did nothing.
    const events = await eventsOf(message.jobId);
    expect([...events.keys()].sort()).toEqual(
      [1, 2, 3].map((attempt) => bullmqJobId(message.jobId, attempt)),
    );
    const [first, second, third] = [1, 2, 3].map(
      (attempt) => events.get(bullmqJobId(message.jobId, attempt)) as TenantProvisionedEvent,
    );
    for (const event of [second, third]) {
      expect(event?.name).toBe("tenant.provisioned");
      expect(event?.payload.migrations).toEqual(first?.payload.migrations);
      expect(event?.payload.steps.map(({ status }) => status)).toEqual(["skipped", "skipped", "skipped"]);
    }
  });

  it("answers tenant.provision_failed TENANT_NOT_PROVISIONING, not retryable, for a tenant that is not provisioning", async () => {
    const tenantId = await insertTenant({ key: "charlie", name: "Charlie Air", status: "suspended" });
    const message = provisionMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome.state).toBe("failed");
    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    // Three attempts were allowed; the first ended them.
    expect((await tenantOps.getJob(bullmqJobId(message.jobId, 1)))?.attemptsMade).toBe(1);
    expect(await schemaExists("tenant_charlie")).toBe(false);
    const events = [...(await eventsOf(message.jobId)).values()] as TenantProvisionFailedEvent[];
    expect(events).toEqual([
      expect.objectContaining({
        name: "tenant.provision_failed",
        payload: {
          error: {
            code: "TENANT_NOT_PROVISIONING",
            message:
              "The tenant is suspended, not provisioning, and its schema is not complete at the latest version",
          },
          retryable: false,
          steps: [],
        },
      }),
    ]);
  });

  it("leaves a schema with foreign content alone and answers FOREIGN_CONTENT, not retryable", async () => {
    const tenantId = await insertTenant({ key: "delta", name: "Delta Tours" });
    // A schema of the provisioner with a table but no ledger, as a hand-made schema would be.
    await migrator.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE velexis_provisioner`.execute(trx);
      await sql`CREATE SCHEMA tenant_delta`.execute(trx);
      await sql`CREATE TABLE tenant_delta.leftovers (id int)`.execute(trx);
    });
    const message = provisionMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    expect(await tablesOf("tenant_delta")).toEqual(["leftovers"]);
    const [event] = [...(await eventsOf(message.jobId)).values()] as TenantProvisionFailedEvent[];
    expect(event?.payload).toMatchObject({
      error: { code: "FOREIGN_CONTENT" },
      retryable: false,
      steps: [{ step: "create_schema", status: "failed", error: { code: "FOREIGN_CONTENT" } }],
    });
  });

  it("leaves a schema that belongs to another role alone and answers FOREIGN_OWNER, not retryable", async () => {
    const tenantId = await insertTenant({ key: "india", name: "India Escapes" });
    // An empty schema of velexis_migrator: not created by provisioning, so never completed or taken over.
    await sql`CREATE SCHEMA tenant_india`.execute(migrator);
    const message = provisionMessage(tenantId);

    const outcome = await dispatch(message, 1);

    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    expect((await tenantOps.getJob(bullmqJobId(message.jobId, 1)))?.attemptsMade).toBe(1);
    const { rows } = await sql<{ owner: string; relations: number; default_acls: number }>`
      SELECT n.nspowner::regrole::text AS owner,
        (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid)::int AS relations,
        (SELECT count(*) FROM pg_catalog.pg_default_acl d WHERE d.defaclnamespace = n.oid)::int AS default_acls
      FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_india'`.execute(migrator);
    expect(rows).toEqual([{ owner: "velexis_migrator", relations: 0, default_acls: 0 }]);
    const events = [...(await eventsOf(message.jobId)).values()] as TenantProvisionFailedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      error: { code: "FOREIGN_OWNER" },
      retryable: false,
      steps: [{ step: "create_schema", status: "failed", error: { code: "FOREIGN_OWNER" } }],
    });
  });

  it("leaves no schema when the worker's connection dies after the migrations and seeds, before COMMIT [OBE-005 AC3]", async () => {
    const tenantId = await insertTenant({ key: "echo", name: "Echo Journeys" });
    const message = provisionMessage(tenantId);
    const seen: Array<{ settings: string | null; seeded: boolean }> = [];
    const seedDefaults = service.seedDefaults.bind(service);
    vi.spyOn(service, "seedDefaults").mockImplementationOnce(async (trx, tenant) => {
      const seeded = await seedDefaults(trx, tenant);
      const { rows } = await sql<{ settings: string | null }>`
        SELECT to_regclass('storefront_settings')::text AS settings`.execute(trx);
      seen.push({ settings: rows[0]?.settings ?? null, seeded: seeded.storefrontSettings });
      // The crash: the server ends the provisioning connection in the middle of its transaction.
      await sql`SELECT pg_terminate_backend(pg_backend_pid())`.execute(trx);
      return seeded;
    });

    const outcome = await dispatch(message, 1, { attempts: 1 });

    // The crash came after every file and the seeds, inside the transaction.
    expect(seen).toEqual([{ settings: "storefront_settings", seeded: true }]);
    expect(outcome.state).toBe("failed");
    expect(outcome.state === "failed" ? outcome.error : undefined).toMatchObject({ code: ADMIN_SHUTDOWN });
    expect(outcome.state === "failed" ? outcome.error : undefined).not.toBeInstanceOf(UnrecoverableError);
    expect(await schemaExists("tenant_echo")).toBe(false);
    expect(await eventsOf(message.jobId)).toEqual(new Map());
    expect(await runnerSessions()).toBe(0);

    // The platform's next attempt provisions the tenant from scratch.
    expect(await dispatch(message, 2)).toMatchObject({ state: "completed" });
    expect(await tablesOf("tenant_echo")).toHaveLength(42);
    expect([...(await eventsOf(message.jobId)).keys()]).toEqual([bullmqJobId(message.jobId, 2)]);
  });

  it("provisions two schemas from scratch with the same catalog hash", async () => {
    const [foxtrot, golf] = await Promise.all([
      insertTenant({ key: "foxtrot", name: "Foxtrot Travel" }),
      insertTenant({ key: "golf", name: "Golf Getaways", default_currency: "USD" }),
    ]);

    // Concurrency 2: both run at the same time, each in its own transaction.
    const outcomes = await Promise.all([
      dispatch(provisionMessage(foxtrot), 1),
      dispatch(provisionMessage(golf), 1),
    ]);

    expect(outcomes.map((outcome) => outcome.state)).toEqual(["completed", "completed"]);
    expect(worker.opts.concurrency).toBe(2);
    expect(await catalogHash("tenant_foxtrot")).toBe(await catalogHash("tenant_golf"));
  });

  it("fails a message this release does not handle as unrecoverable, without an event", async () => {
    const tenantId = await insertTenant({ key: "hotel", name: "Hotel Hops", status: "active" });
    const message = { ...provisionMessage(tenantId), name: "tenant.resume" as const };

    const outcome = await dispatch(message, 1);

    expect(outcome.state === "failed" ? outcome.error : undefined).toBeInstanceOf(UnrecoverableError);
    expect((await tenantOps.getJob(bullmqJobId(message.jobId, 1)))?.attemptsMade).toBe(1);
    expect(await eventsOf(message.jobId)).toEqual(new Map());
  });
});
