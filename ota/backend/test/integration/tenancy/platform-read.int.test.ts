// The read-only platform repository against PostgreSQL 16 (OBE-003; ADR-0004 Database roles, OADR-0009 point 5). The
// file clones the @velexis/testing template (platform and reference migrated, tenant_alpha and tenant_beta
// provisioned), inserts platform.tenants rows as velexis_migrator, the owner of the platform tables, and reads them
// through TenancyModule inside the real worker and API module graphs: its pool logs in as velexis_ota_app.
import { Injectable, Module, type INestApplicationContext, type Type } from "@nestjs/common";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  InvalidTenantSchemaError,
  POOL_DEFAULTS,
  sql,
  tenantTx,
  type Insertable,
  type Kysely,
  type PlatformDatabase,
} from "@velexis/db";
import { createTestDatabase, type TestDatabase } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule, createApiApp, createApiLogger } from "../../../src/app.module";
import { newId } from "../../../src/common/ids";
import { API_APP, loadApiConfig, loadWorkerConfig, WORKER_APP } from "../../../src/config";
import {
  PLATFORM_DB,
  PLATFORM_READ_STATEMENT_TIMEOUT_MS,
  PlatformReadRepository,
  type PlatformDb,
} from "../../../src/tenancy/platform-read.repository";
import { OTA_POOL, TenancyModule, type OtaPool } from "../../../src/tenancy/tenancy.module";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testApiVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";

/** Dummy Redis URL: nothing in these graphs connects to Redis (the readiness probe connects on its first check). */
const REDIS_URL = "redis://:dummy@127.0.0.1:6379/0";
/** SQLSTATE insufficient_privilege. */
const PERMISSION_DENIED = "42501";
/** SQLSTATE query_canceled, which `statement_timeout` raises. */
const QUERY_CANCELED = "57014";

const quietPoolLogger = { error: (): void => undefined };

type TenantInsert = Insertable<PlatformDatabase["platform.tenants"]>;

/** TenancyModule in a running process graph, and what the tests use of it. */
interface Tenancy {
  readonly app: INestApplicationContext;
  readonly repository: PlatformReadRepository;
  /** The repository's `platformDb`, on the module's pool. */
  readonly platformDb: PlatformDb;
  readonly pool: OtaPool;
  readonly sink: MemorySink;
}

let db: TestDatabase;
let migratorPool: OtaPool;
/** velexis_migrator, the owner of the platform tables: what inserts the test's tenants. */
let migrator: Kysely<PlatformDatabase>;
let worker: Tenancy;
/** The tenants of the file: alpha active and live, beta provisioning with every default. */
let alphaId: string;
let betaId: string;
const apps: INestApplicationContext[] = [];

function tenancyOf(app: INestApplicationContext, sink: MemorySink): Tenancy {
  return {
    app,
    repository: app.get(PlatformReadRepository),
    platformDb: app.get<string, PlatformDb>(PLATFORM_DB),
    pool: app.get<string, OtaPool>(OTA_POOL),
    sink,
  };
}

/** The worker graph (`WorkerModule.forRoot`) with `TenancyModule.forWorker()`, as the provisioning module imports it. */
async function startWorkerTenancy(...extraImports: Type[]): Promise<Tenancy> {
  const config = loadWorkerConfig({
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL,
  });
  const sink = new MemorySink();
  @Module({
    imports: [
      WorkerModule.forRoot(config, { logger: createWorkerLogger(config, sink) }),
      TenancyModule.forWorker(),
      ...extraImports,
    ],
  })
  class WorkerTenancyRoot {}
  const app = await createWorkerApp(WorkerTenancyRoot);
  apps.push(app);
  await app.init();
  return tenancyOf(app, sink);
}

/** The API graph (`AppModule.forRoot`, initialised, not listening) with `TenancyModule.forApi()`. */
async function startApiTenancy(): Promise<Tenancy> {
  const config = loadApiConfig({
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    REDIS_URL,
    ...testApiVariables(),
  });
  const sink = new MemorySink();
  @Module({
    imports: [AppModule.forRoot(config, { logger: createApiLogger(config, sink) }), TenancyModule.forApi()],
  })
  class ApiTenancyRoot {}
  const app = await createApiApp(config, ApiTenancyRoot);
  apps.push(app);
  await app.init();
  return tenancyOf(app, sink);
}

/** Closes a graph before the end of the file. */
async function close(tenancy: Tenancy): Promise<void> {
  apps.splice(apps.indexOf(tenancy.app), 1);
  await tenancy.app.close();
}

/** Inserts a tenant as velexis_migrator, on the plan that platform migration 0002 seeds, and returns its id. */
async function insertTenant(values: Omit<TenantInsert, "id" | "plan_code">): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, plan_code: "early_access", ...values })
    .execute();
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  worker = await startWorkerTenancy();
  alphaId = await insertTenant({
    key: "alpha",
    name: "Alpha Travel",
    status: "active",
    default_currency: "GBP",
    default_locale: "en-GB",
    storefront_environment: "live",
    live_enabled_at: new Date("2026-10-01T08:00:00.000Z"),
    billing_notice: "past_due",
  });
  // Every other column at its default: provisioning, EUR, en, the test storefront and no billing notice.
  betaId = await insertTenant({ key: "beta", name: "Beta Trips" });
});

afterAll(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await migratorPool?.end();
  await db?.drop();
});

describe("PlatformReadRepository on PostgreSQL", () => {
  it("reads a tenant inserted as migrator by id and by key and maps the row [OBE-003 AC1]", async () => {
    const alpha = {
      id: alphaId,
      key: "alpha",
      name: "Alpha Travel",
      status: "active",
      schemaName: "tenant_alpha",
      storefrontEnvironment: "live",
      defaultCurrency: "GBP",
      defaultLocale: "en-GB",
      billingNotice: "past_due",
    };

    await expect(worker.repository.tenantById(alphaId)).resolves.toEqual(alpha);
    await expect(worker.repository.tenantByKey("alpha")).resolves.toEqual(alpha);
    await expect(worker.repository.tenantById(betaId)).resolves.toEqual({
      id: betaId,
      key: "beta",
      name: "Beta Trips",
      status: "provisioning",
      schemaName: "tenant_beta",
      storefrontEnvironment: "test",
      defaultCurrency: "EUR",
      defaultLocale: "en",
      billingNotice: null,
    });
  });

  it("returns a schema name that tenantTx runs in on the same pool [OBE-003 AC1]", async () => {
    const tenant = await worker.repository.tenantByKey("alpha");
    if (tenant === null) {
      throw new Error("tenant alpha not found");
    }

    const current = await tenantTx(
      createTenantDb(worker.pool, { appEnv: "test" }),
      tenant.schemaName,
      (trx) => sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(trx),
    );

    expect(current.rows).toEqual([{ schema: "tenant_alpha" }]);
  });

  it("returns null for an unknown id and an unknown key [OBE-003 AC1]", async () => {
    await expect(worker.repository.tenantById(newId("ten"))).resolves.toBeNull();
    await expect(worker.repository.tenantById("not-a-tenant-id")).resolves.toBeNull();
    await expect(worker.repository.tenantByKey("gamma")).resolves.toBeNull();
  });

  it("reads as velexis_ota_app, which cannot write platform.tenants: 42501 through the same pool [OBE-003 AC2]", async () => {
    const who = await sql<{ role: string }>`SELECT current_user AS role`.execute(worker.platformDb);
    expect(who.rows).toEqual([{ role: "velexis_ota_app" }]);

    const writes = {
      update: () =>
        worker.platformDb
          .updateTable("platform.tenants")
          .set({ name: "Changed by the OTA" })
          .where("id", "=", alphaId)
          .execute(),
      rawUpdate: () =>
        sql`UPDATE platform.tenants SET status = 'suspended' WHERE id = ${alphaId}`.execute(
          worker.platformDb,
        ),
      insert: () =>
        worker.platformDb
          .insertInto("platform.tenants")
          .values({ id: newId("ten"), key: "intruder", name: "Intruder", plan_code: "early_access" })
          .execute(),
      delete: () => worker.platformDb.deleteFrom("platform.tenants").where("id", "=", betaId).execute(),
    };
    for (const [statement, write] of Object.entries(writes)) {
      const error: unknown = await write().then(
        () => new Error(`${statement} succeeded`),
        (caught: unknown) => caught,
      );
      expect(error, statement).toMatchObject({
        code: PERMISSION_DENIED,
        message: "permission denied for table tenants",
      });
    }

    // Nothing changed: the migrator still sees both rows as inserted.
    const rows = await migrator
      .selectFrom("platform.tenants")
      .select(["key", "name", "status"])
      .where("id", "in", [alphaId, betaId])
      .orderBy("key")
      .execute();
    expect(rows).toEqual([
      { key: "alpha", name: "Alpha Travel", status: "active" },
      { key: "beta", name: "Beta Trips", status: "provisioning" },
    ]);
  });

  it(
    "cancels a lookup that waits past the platform read timeout, rolls it back and keeps the pool usable",
    async () => {
      // The lookup's own timeout is the shorter one: a lookup cancelled within it was not cancelled by the session's.
      expect(PLATFORM_READ_STATEMENT_TIMEOUT_MS).toBeLessThan(POOL_DEFAULTS.statementTimeoutMs);
      // A migration holding platform.tenants (ACCESS EXCLUSIVE) makes every read of the table wait for the lock.
      const locker = await migratorPool.connect();
      let waitedMs = Number.NaN;
      let error: unknown;
      try {
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE platform.tenants IN ACCESS EXCLUSIVE MODE");
        const started = performance.now();
        error = await worker.repository.tenantById(alphaId).then(
          () => new Error("the lookup did not wait for the lock"),
          (caught: unknown) => caught,
        );
        waitedMs = performance.now() - started;
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }

      expect(error).toMatchObject({
        code: QUERY_CANCELED,
        message: "canceling statement due to statement timeout",
      });
      expect(waitedMs).toBeGreaterThanOrEqual(PLATFORM_READ_STATEMENT_TIMEOUT_MS * 0.9);
      expect(waitedMs).toBeLessThan(PLATFORM_READ_STATEMENT_TIMEOUT_MS + 1_500);
      // The failed transaction was rolled back: the connection it returned to the pool serves the next lookup.
      await expect(worker.repository.tenantById(alphaId)).resolves.toMatchObject({ id: alphaId });
    },
    // Passing takes the 2 s of the lookup's timeout. The limit lets a lookup without it run into the session's 30 s
    // and fail on `waitedMs` above, after the lock is released, instead of leaving platform.tenants locked for the
    // rest of the file.
    POOL_DEFAULTS.statementTimeoutMs + 5_000,
  );
});

describe("a platform.tenants row with a malformed schema_name", () => {
  /**
   * Keys whose generated `schema_name` ('tenant_' || key) is not a valid tenant schema name. The key CHECKs of
   * platform migrations 0001 and 0002 make such rows impossible; this file's own clone drops them to create the rows.
   */
  const MALFORMED_KEYS = [
    "Acme", // tenant_Acme: upper case
    "a", // tenant_a: too short
    "beta, public", // tenant_beta, public: a search_path list
    "x; DROP SCHEMA tenant_alpha CASCADE", // a statement
  ];
  const ids = new Map<string, string>();

  beforeAll(async () => {
    const checks = await sql<{ name: string }>`
      SELECT c.conname AS name
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'platform.tenants'::regclass AND c.contype = 'c' AND a.attname = 'key'
    `.execute(migrator);
    expect(checks.rows.length).toBeGreaterThanOrEqual(2);
    for (const { name } of checks.rows) {
      await sql`ALTER TABLE platform.tenants DROP CONSTRAINT ${sql.id(name)}`.execute(migrator);
    }
    for (const key of MALFORMED_KEYS) {
      ids.set(key, await insertTenant({ key, name: `Malformed ${key}`, status: "active" }));
    }
  });

  it.each(MALFORMED_KEYS)(
    "refuses the tenant with key %j before any tenant SQL [OBE-003 AC3]",
    async (key) => {
      const id = ids.get(key) ?? "";
      const stored = await migrator
        .selectFrom("platform.tenants")
        .select("schema_name")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(stored.schema_name).toBe(`tenant_${key}`);

      const acquired = vi.fn();
      worker.pool.on("acquire", acquired);
      const resolved = vi.fn();
      const useCase = vi.fn(() => Promise.resolve("never"));
      try {
        // What a tenant-scoped use case does: resolve the tenant, then open its tenant transaction on the same pool.
        const run = async (): Promise<string> => {
          const tenant = await worker.repository.tenantById(id);
          resolved(tenant);
          if (tenant === null) {
            throw new Error("unknown tenant");
          }
          return await tenantTx(createTenantDb(worker.pool, { appEnv: "test" }), tenant.schemaName, useCase);
        };

        await expect(run()).rejects.toBeInstanceOf(InvalidTenantSchemaError);
        // The repository itself refused the row: no caller got the schema name.
        expect(resolved).not.toHaveBeenCalled();
        // The key itself can never be a tenant's key, so the lookup by key answers "unknown" without a query.
        await expect(worker.repository.tenantByKey(key)).resolves.toBeNull();
      } finally {
        worker.pool.off("acquire", acquired);
      }

      expect(useCase).not.toHaveBeenCalled();
      // One connection was taken, for the platform read; tenantTx refused the name before taking one.
      expect(acquired).toHaveBeenCalledTimes(1);
      const schemas = await sql<{ name: string }>`
        SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname LIKE 'tenant\\_%' ORDER BY nspname
      `.execute(migrator);
      expect(schemas.rows).toEqual([{ name: "tenant_alpha" }, { name: "tenant_beta" }]);
    },
  );
});

@Injectable()
class ProvisioningProbe {
  constructor(readonly repository: PlatformReadRepository) {}
}

@Module({ imports: [TenancyModule.forWorker()], providers: [ProvisioningProbe] })
class ProvisioningProbeModule {}

@Injectable()
class JobsProbe {
  constructor(readonly repository: PlatformReadRepository) {}
}

@Module({ imports: [TenancyModule.forWorker()], providers: [JobsProbe] })
class JobsProbeModule {}

describe("TenancyModule", () => {
  it("gives the API and the worker one velexis_ota_app pool each, named after the process, ended at shutdown", async () => {
    const api = await startApiTenancy();
    const workerProcess = await startWorkerTenancy();

    // The connection budget of deploy/postgres/velexis.conf (max_connections = 100): OTA API 20, worker 10.
    for (const [tenancy, app, max] of [
      [api, API_APP, 20],
      [workerProcess, WORKER_APP, 10],
    ] as const) {
      const session = await sql<{ application: string; role: string }>`
        SELECT current_setting('application_name') AS application, current_user AS role
      `.execute(tenancy.platformDb);
      expect(session.rows).toEqual([{ application: app, role: "velexis_ota_app" }]);
      expect(tenancy.pool.options.max).toBe(max);
      await expect(tenancy.repository.tenantByKey("alpha")).resolves.toMatchObject({ key: "alpha" });

      await close(tenancy);
      expect(tenancy.pool.ended).toBe(true);
      // No line of either process carries the DSN's password.
      expect(tenancy.sink.text()).not.toContain(new URL(db.urlFor("ota")).password);
    }
    // Each application has its own pool: the file's worker graph, which imports the same module object, still reads.
    expect(worker.pool.ended).toBe(false);
    await expect(worker.repository.tenantById(alphaId)).resolves.toMatchObject({ id: alphaId });
  });

  it("shares one repository, and so one pool, between every module of a process that imports it", async () => {
    const tenancy = await startWorkerTenancy(ProvisioningProbeModule, JobsProbeModule);

    const fromProvisioning = tenancy.app.get(ProvisioningProbe).repository;
    const fromJobs = tenancy.app.get(JobsProbe).repository;

    expect(fromProvisioning).toBe(tenancy.repository);
    expect(fromJobs).toBe(tenancy.repository);
  });
});
