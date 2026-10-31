// The OTA backend's development seed and deploy report against PostgreSQL 16 and Redis 7 (OBE-007): `dev:seed` and
// `tenants:report-migrations` run through `runCli`, as `node dist/cli.js` runs them, on clones of the @velexis/testing
// template. The file plays the platform's `dev:seed` (PBE-034) first: the Velexis test Amadeus account and its test
// offices, inserted as velexis_migrator. Every expensive run happens once in a `beforeAll` hook with its own commented
// budget; the tests compare what the runs printed and wrote.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJob, type TenantEvent } from "@velexis/api-types/jobs";
import { verifyApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
} from "@velexis/db";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../../src/cli";
import { DEV_SEED_KEY_LABELS } from "../../../src/dev/dev-seed.command";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { BULLMQ_PREFIX, PLATFORM_TENANT_EVENTS } from "../../../src/common/queues/queue-names";
import { ApiKeyVerifier } from "../../../src/tenancy/api-key.verifier";
import { PlatformReadRepository } from "../../../src/tenancy/platform-read.repository";
import { TEST_STOREFRONT_BASE_DOMAIN, testApiCredentials } from "../../helpers/api-env";
import { unreachableRedisUrl } from "../../helpers/ports";

/**
 * The last file of migrations/tenant: the version tenant_demo reaches (OBE-008, FIX-W27-SYNC, FIX-W28-CANCEL,
 * FIX-W31-OTA).
 */
const SCHEMA_VERSION = "0005_add_cancellation_claim_tighten_calling_codes";
/** Every file of migrations/tenant, as a schema's ledger lists them. */
const LEDGER = [
  "0001_baseline",
  "0002_add_mvp_tenant_deltas",
  "0003_add_booking_sync_claim",
  "0004_add_payment_card_fee_lines",
  SCHEMA_VERSION,
];
/** The platform dev:seed's test offices (PBE-034). */
const OFFICES = ["DEV1A0001", "DEV1A0002", "DEV1A0003"];
const KEY_TEXT = /\b[ps]k_test_[A-Za-z0-9]{40}\b/g;
const quietPoolLogger = { error: (): void => undefined };

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(argv: string[], env: Record<string, string>): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    stdout: { write: (chunk: string) => void out.push(chunk) },
    stderr: { write: (chunk: string) => void err.push(chunk) },
    env,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** The key printed on the line of `label` (`  <label> (<key id>): <key>`), as the nightly workflow reads it. */
function printedKey(stdout: string, label: string): string | undefined {
  const line = stdout.split("\n").find((text) => text.startsWith(`  ${label} (`));
  return line?.match(KEY_TEXT)?.[0];
}

/** The variables of dev:seed on `db` (the root and app `.env.local` files locally). */
function devSeedEnv(db: TestDatabase, appEnv = "test"): Record<string, string> {
  return {
    APP_ENV: appEnv,
    LOG_LEVEL: "warn",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    DATABASE_MIGRATOR_URL: db.urlFor("migrator"),
    API_KEY_PEPPER_FILE: testApiCredentials().pepperFile,
    STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
  };
}

/** What the platform's dev:seed leaves: the Velexis test Amadeus account and its pool of available offices. */
async function platformDevSeed(migrator: Kysely<PlatformDatabase>): Promise<string> {
  const accountId = newId("ama");
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id: accountId,
      name: "Velexis test account (dev:seed)",
      environment: "test",
      base_url: "http://127.0.0.1:4900",
      client_id: "velexis-dev-seed",
      // A placeholder: dev:seed never reads the secret.
      client_secret_ciphertext: Buffer.from("not-a-real-ciphertext"),
      encryption_key_id: "local:v1",
      status: "active",
    })
    .execute();
  for (const officeId of OFFICES) {
    await migrator
      .insertInto("platform.amadeus_offices")
      .values({ id: newId("amo"), amadeus_account_id: accountId, office_id: officeId })
      .execute();
  }
  return accountId;
}

async function count(
  db: Kysely<PlatformDatabase>,
  query: ReturnType<typeof sql<{ n: string }>>,
): Promise<number> {
  const { rows } = await query.execute(db);
  return Number(rows[0]?.n ?? 0);
}

describe("dev:seed", () => {
  let db: TestDatabase;
  let migratorPool: ReturnType<typeof createPool>;
  let migrator: Kysely<PlatformDatabase>;
  let otaPool: ReturnType<typeof createPool>;
  let first: CliRun;
  let second: CliRun;

  // A clone of the template, the platform's seed, then dev:seed twice: two provisioning transactions (the first
  // creates tenant_demo, the second finds it complete). About 3 s here; budgeted for a loaded CI runner.
  beforeAll(async () => {
    db = await createTestDatabase();
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
    await platformDevSeed(migrator);
    first = await cli(["dev:seed"], devSeedEnv(db));
    second = await cli(["dev:seed"], devSeedEnv(db));
  }, 120_000);

  afterAll(async () => {
    await migratorPool?.end();
    await otaPool?.end();
    await db?.drop();
  });

  async function demoTenant() {
    return migrator
      .selectFrom("platform.tenants")
      .selectAll()
      .where("key", "=", "demo")
      .executeTakeFirstOrThrow();
  }

  it("twice leaves one tenant, one schema and three keys, printed once [OBE-007 AC2] [FIX-W37-OTA AC5]", async () => {
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(second).toMatchObject({ code: 0, stderr: "" });

    expect(
      await count(
        migrator,
        sql<{ n: string }>`SELECT count(*) AS n FROM platform.tenants WHERE key = 'demo'`,
      ),
    ).toBe(1);
    expect(
      await count(
        migrator,
        sql<{ n: string }>`SELECT count(*) AS n FROM pg_catalog.pg_namespace WHERE nspname = 'tenant_demo'`,
      ),
    ).toBe(1);
    const tenant = await demoTenant();
    const keys = await migrator
      .selectFrom("platform.api_keys")
      .select(["kind", "environment", "prefix", "scopes", "allowed_origins", "revoked_at"])
      .where("tenant_id", "=", tenant.id)
      // The console key's name ("dev:seed console automation …") comes before the storefront's ("dev:seed secret …").
      .orderBy("kind")
      .orderBy("name")
      .execute();
    expect(
      keys.map(({ kind, environment, scopes, allowed_origins, revoked_at }) => ({
        kind,
        environment,
        scopes,
        allowed_origins,
        revoked_at,
      })),
    ).toEqual([
      { kind: "publishable", environment: "test", scopes: [], allowed_origins: [], revoked_at: null },
      // The console automation key of the SDK's smoke test (lead decision (2f) of 2026-10-31): least privilege.
      {
        kind: "secret",
        environment: "test",
        scopes: ["console:automation", "amadeus:read"],
        allowed_origins: [],
        revoked_at: null,
      },
      { kind: "secret", environment: "test", scopes: ["storefront"], allowed_origins: [], revoked_at: null },
    ]);

    // The raw keys are printed by the run that creates them, each on its own labelled line, and never again.
    const printed = first.stdout.match(KEY_TEXT) ?? [];
    expect(printed).toHaveLength(3);
    expect(printed.map((key) => key.slice(0, 14)).sort()).toEqual(keys.map((key) => key.prefix).sort());
    for (const [kind, label] of Object.entries(DEV_SEED_KEY_LABELS)) {
      const lines = first.stdout.split("\n").filter((line) => line.startsWith(`  ${label} (`));
      expect(lines, kind).toHaveLength(1);
      expect(lines[0], kind).toMatch(
        new RegExp(
          `^  ${label} \\(key_[0-9A-Z]{26}\\): ${kind === "publishable" ? "pk" : "sk"}_test_[A-Za-z0-9]{40}$`,
        ),
      );
    }
    expect(second.stdout.match(KEY_TEXT)).toBeNull();
    expect(second.stdout).toContain("exists already");
  });

  it("stores only the keys' HMAC, and the printed sk_test authenticates with the shared pepper [OBE-007 AC2]", async () => {
    const tenant = await demoTenant();
    const secret = printedKey(first.stdout, DEV_SEED_KEY_LABELS.secret);
    const publishable = printedKey(first.stdout, DEV_SEED_KEY_LABELS.publishable);
    const automation = printedKey(first.stdout, DEV_SEED_KEY_LABELS.console);
    expect(secret).toBeDefined();
    expect(publishable).toBeDefined();
    expect(automation).toBeDefined();

    const { rows } = await sql<{ key_hash: string; last4: string; prefix: string }>`
      SELECT key_hash, last4, prefix FROM platform.api_keys WHERE prefix = ${(secret ?? "").slice(0, 14)}
    `.execute(migrator);
    expect(rows[0]?.last4).toBe((secret ?? "").slice(-4));
    expect(verifyApiKey(secret ?? "", testApiCredentials().pepper, rows[0]?.key_hash ?? "")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(secret ?? "-");

    // The OTA backend's own key verifier (OBE-011) accepts both keys for the demo tenant.
    const verifier = new ApiKeyVerifier(
      new PlatformReadRepository(createPlatformDb(otaPool)),
      testApiCredentials().pepper,
      new Clock(),
      { setContext: () => undefined, info: () => undefined } as unknown as PinoLogger,
    );
    await expect(verifier.verify(secret ?? "")).resolves.toMatchObject({
      tenantId: tenant.id,
      kind: "secret",
      environment: "test",
      scopes: ["storefront"],
    });
    await expect(verifier.verify(publishable ?? "")).resolves.toMatchObject({
      tenantId: tenant.id,
      kind: "publishable",
    });
    // The console automation key passes the verifier's scope rules (console:automation needs a permission).
    await expect(verifier.verify(automation ?? "")).resolves.toMatchObject({
      tenantId: tenant.id,
      kind: "secret",
      environment: "test",
      scopes: ["console:automation", "amadeus:read"],
    });
  });

  it("provisions tenant_demo through the real provisioning function and activates the tenant [OBE-007 AC2]", async () => {
    const tenant = await demoTenant();
    expect(tenant).toMatchObject({
      name: "Demo Travel",
      status: "active",
      schema_name: "tenant_demo",
      schema_version: SCHEMA_VERSION,
      storefront_environment: "test",
      plan_code: "early_access",
    });
    expect(tenant.activated_at).not.toBeNull();

    // The seeds of OBE-004 and the ledger, read as velexis_ota_app through tenantTx.
    const tenants = createTenantDb(otaPool, { appEnv: "test" });
    const { settings, ledger } = await tenantTx(tenants, "tenant_demo", async (trx) => ({
      settings: (await sql<{ brand_name: string }>`SELECT brand_name FROM storefront_settings`.execute(trx))
        .rows,
      ledger: (
        await sql<{
          id: string;
        }>`SELECT id FROM schema_migrations WHERE status = 'applied' ORDER BY id`.execute(trx)
      ).rows,
    }));
    expect(settings).toEqual([{ brand_name: "Demo Travel" }]);
    expect(ledger.map((row) => row.id)).toEqual(LEDGER);

    // The platform's mirror of the ledger, as the record_migrations post-step writes it.
    const mirror = await migrator
      .selectFrom("platform.tenant_schema_migrations")
      .select(["version", "status", "schema_name"])
      .where("tenant_id", "=", tenant.id)
      .orderBy("version")
      .execute();
    expect(mirror).toEqual(
      LEDGER.map((version) => ({ version, status: "applied", schema_name: "tenant_demo" })),
    );
    expect(first.stdout).toContain(`Schema tenant_demo at ${SCHEMA_VERSION}: provisioned; tenant activated.`);
    expect(second.stdout).toContain(
      `Schema tenant_demo at ${SCHEMA_VERSION}: complete already; tenant active.`,
    );
  });

  it("gives the demo tenant its sub-domain, an Amadeus test office and a velexis Stripe test connection [OBE-007 AC2]", async () => {
    const tenant = await demoTenant();
    const domains = await migrator
      .selectFrom("platform.tenant_domains")
      .select(["hostname", "kind", "purpose", "is_primary", "verification_status"])
      .where("tenant_id", "=", tenant.id)
      .execute();
    expect(domains).toEqual([
      {
        hostname: `demo.${TEST_STOREFRONT_BASE_DOMAIN}`,
        kind: "subdomain",
        purpose: "storefront",
        is_primary: true,
        verification_status: "verified",
      },
    ]);

    const connections = await migrator
      .selectFrom("platform.supplier_connections")
      .select(["environment", "credential_source", "office_ids", "default_office_id", "status"])
      .where("tenant_id", "=", tenant.id)
      .execute();
    expect(connections).toEqual([
      {
        environment: "test",
        credential_source: "velexis",
        office_ids: ["DEV1A0001"],
        default_office_id: "DEV1A0001",
        status: "active",
      },
    ]);
    const offices = await migrator
      .selectFrom("platform.amadeus_offices")
      .select(["office_id", "status", "assigned_tenant_id"])
      .orderBy("office_id")
      .execute();
    expect(offices).toEqual([
      { office_id: "DEV1A0001", status: "assigned", assigned_tenant_id: tenant.id },
      { office_id: "DEV1A0002", status: "available", assigned_tenant_id: null },
      { office_id: "DEV1A0003", status: "available", assigned_tenant_id: null },
    ]);

    const payments = await migrator
      .selectFrom("platform.payment_provider_connections")
      .select(["provider", "environment", "account_mode", "capture_mode", "status", "is_default"])
      .where("tenant_id", "=", tenant.id)
      .execute();
    expect(payments).toEqual([
      {
        provider: "stripe",
        environment: "test",
        account_mode: "velexis",
        capture_mode: "manual",
        status: "active",
        is_default: true,
      },
    ]);
  });

  describe("tenants:report-migrations on the seeded database", () => {
    let redis: TestRedis;
    let events: Queue;
    let eventsConnection: Redis;
    let folder: string;
    let report: string;
    let published: CliRun;
    let again: CliRun;
    let refused: CliRun;
    let alphaId: string;

    // A fan-out report naming tenant_demo (migrated), tenant_gone (migrated, but its schema was dropped since: the
    // search_path would resolve its ledger to the reference one) and tenant_alpha (failed), published twice on a Redis
    // database of the file's own and once towards a Redis where nothing listens (three refused connection attempts,
    // about 1 s).
    beforeAll(async () => {
      redis = await useRedis();
      eventsConnection = new Redis(redis.url, { maxRetriesPerRequest: null });
      events = new Queue(PLATFORM_TENANT_EVENTS, { connection: eventsConnection, prefix: BULLMQ_PREFIX });
      alphaId = newId("ten");
      await migrator
        .insertInto("platform.tenants")
        .values([
          { id: alphaId, key: "alpha", name: "Alpha", plan_code: "early_access", status: "active" },
          { id: newId("ten"), key: "gone", name: "Gone", plan_code: "early_access", status: "active" },
        ])
        .execute();
      folder = await mkdtemp(join(tmpdir(), "ota-dev-seed-report-"));
      report = join(folder, "migrate-0123456abcdef.json");
      await writeFile(
        report,
        JSON.stringify({
          target: SCHEMA_VERSION,
          total: 3,
          applied: [
            { schema: "tenant_demo", files: [] },
            { schema: "tenant_gone", files: [] },
          ],
          failed: [
            {
              schema: "tenant_alpha",
              file: `${SCHEMA_VERSION}.sql`,
              error: { message: "lock timeout", code: "55P03" },
              exitCode: 1,
            },
          ],
          skipped: [],
        }),
      );
      const env = { APP_ENV: "test", DATABASE_URL: db.urlFor("ota"), REDIS_URL: redis.url };
      published = await cli(["tenants:report-migrations", "--report", report], env);
      again = await cli(["tenants:report-migrations", "--report", report], env);
      refused = await cli(["tenants:report-migrations", "--report", report], {
        ...env,
        REDIS_URL: await unreachableRedisUrl(),
      });
    }, 120_000);

    afterAll(async () => {
      await events?.close();
      await eventsConnection?.quit();
      await redis?.close();
      if (folder !== undefined) {
        await rm(folder, { recursive: true, force: true });
      }
    });

    it("publishes tenant.migrated with the full ledger and tenant.migration_failed, jobId null, each run [OBE-007 AC1]", async () => {
      const skippedGone =
        "tenants:report-migrations: tenant_gone has no schema_migrations ledger any more; no event for it.\n";
      expect(published).toMatchObject({ code: 0, stderr: skippedGone });
      expect(again).toMatchObject({ code: 0, stderr: skippedGone });
      expect(published.stdout).toContain(
        "2 event(s) published on platform-tenant-events (request deploy-0123456abcdef)",
      );
      expect(published.stdout).toContain(`tenant.migrated tenant_demo (`);
      expect(published.stdout).toContain(`tenant.migration_failed tenant_alpha (${alphaId}) LOCK_TIMEOUT`);

      const jobs = await events.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
      const received = jobs
        .map((job) => validateJob(job.name, job.data) as TenantEvent)
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(received).toHaveLength(4);
      const tenant = await demoTenant();
      const migrated = received.filter((event) => event.name === "tenant.migrated");
      const failed = received.filter((event) => event.name === "tenant.migration_failed");
      expect(migrated).toHaveLength(2);
      expect(failed).toHaveLength(2);
      for (const event of received) {
        expect(event).toMatchObject({ v: 1, jobId: null, requestId: "deploy-0123456abcdef" });
      }
      for (const event of migrated) {
        expect(event.tenantId).toBe(tenant.id);
        expect(event.payload).toMatchObject({
          schemaVersion: SCHEMA_VERSION,
          migrations: LEDGER.map((version) => ({ version })),
        });
      }
      for (const event of failed) {
        expect(event.tenantId).toBe(alphaId);
        expect(event.payload).toMatchObject({ version: SCHEMA_VERSION, error: { code: "LOCK_TIMEOUT" } });
      }
    });

    it("exits 1 when Redis refuses the events [OBE-007 AC1]", () => {
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("Redis refused the events (ECONNREFUSED); 0 of 2 were published.");
      expect(refused.stderr).not.toContain("dummy");
    });
  });

  // Last in this describe, so the runs above are what its other tests read.
  describe("a database whose console automation key is gone (or one seeded before that key existed)", () => {
    /** A run after the console automation key was revoked. */
    let third: CliRun;

    // One more dev:seed run, which finds tenant_demo complete: about 1 s here; budgeted for a loaded CI runner.
    beforeAll(async () => {
      const automation = printedKey(first.stdout, DEV_SEED_KEY_LABELS.console) ?? "";
      await migrator
        .updateTable("platform.api_keys")
        .set({ revoked_at: new Date() })
        .where("prefix", "=", automation.slice(0, 14))
        .execute();
      third = await cli(["dev:seed"], devSeedEnv(db));
    }, 60_000);

    it("[FIX-W37-OTA AC5] creates a missing console automation key alone, as it does each of its keys, printing only it", async () => {
      expect(third).toMatchObject({ code: 0, stderr: "" });
      const printed = third.stdout.match(KEY_TEXT) ?? [];
      expect(printed).toHaveLength(1);
      expect(printedKey(third.stdout, DEV_SEED_KEY_LABELS.console)).toBe(printed[0]);
      expect(third.stdout).toContain(`${DEV_SEED_KEY_LABELS.publishable}: exists already`);
      expect(third.stdout).toContain(`${DEV_SEED_KEY_LABELS.secret}: exists already`);
      const tenant = await demoTenant();
      const valid = await migrator
        .selectFrom("platform.api_keys")
        .select(["prefix", "scopes"])
        .where("tenant_id", "=", tenant.id)
        .where("revoked_at", "is", null)
        .where("name", "=", "dev:seed console automation test key")
        .execute();
      expect(valid).toEqual([
        { prefix: (printed[0] ?? "").slice(0, 14), scopes: ["console:automation", "amadeus:read"] },
      ]);
    });
  });
});

describe("dev:seed with APP_ENV=production", () => {
  let db: TestDatabase;
  let migratorPool: ReturnType<typeof createPool>;
  let migrator: Kysely<PlatformDatabase>;
  let refused: CliRun;

  // A fresh clone with the platform's seed, then one refused run with every other variable valid.
  beforeAll(async () => {
    db = await createTestDatabase();
    migratorPool = createPool(db.urlFor("migrator"), {
      applicationName: "ota-test-migrator",
      logger: quietPoolLogger,
      max: 1,
    });
    migrator = createPlatformDb<PlatformDatabase>(migratorPool);
    await platformDevSeed(migrator);
    refused = await cli(["dev:seed"], devSeedEnv(db, "production"));
  }, 60_000);

  afterAll(async () => {
    await migratorPool?.end();
    await db?.drop();
  });

  it("exits 1 without writing anything [OBE-007 AC3]", async () => {
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("refuses APP_ENV=production; nothing was written");
    const written = await sql<{
      tenants: string;
      keys: string;
      domains: string;
      schemas: string;
      assigned: string;
    }>`
      SELECT (SELECT count(*) FROM platform.tenants) AS tenants,
             (SELECT count(*) FROM platform.api_keys) AS keys,
             (SELECT count(*) FROM platform.tenant_domains) AS domains,
             (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = 'tenant_demo') AS schemas,
             (SELECT count(*) FROM platform.amadeus_offices WHERE status <> 'available') AS assigned
    `.execute(migrator);
    expect(written.rows[0]).toEqual({ tenants: "0", keys: "0", domains: "0", schemas: "0", assigned: "0" });
  });
});
