// Provisioning end to end with the real OTA worker (PBE-035; platform/docs/flows/provisioning.md "Tests that prove
// it", PADR-0017 item 2, OADR-0007). The stack of ./stack.ts runs the platform API and worker and the BUILT OTA worker
// (ota/backend/dist/worker.js) on one database clone and one Redis database, after `dev:seed` has put the verified
// Velexis test Amadeus account and its twenty test offices in place. No fake answers here: the OTA worker builds the
// schema as velexis_provisioner and answers `tenant.provisioned`, and the platform worker runs the post-steps.
//
// The journey goes through the public API, as the portal does: a person signs up, verifies the address with the
// token of the e-mail the platform worker sent to Mailpit, signs in and creates an OTA; the setup progress
// (`getProvisioning`) is read until the OTA is `active`, at most 60 seconds. Then the tests check what exists: the
// schema `tenant_<key>` with the same ledger as `platform.tenant_schema_migrations` (and the migration files), one
// assigned test office and two test keys. The tenant schema is read as velexis_ota_app through `tenantTx`, the way
// the OTA backend reads it; the platform's role has no privilege there, and nothing here writes to it.
//
// The stack and the journey are expensive (two Nest module graphs, an OTA process, Argon2id hashes, Mailpit, the setup
// itself): they run in setup hooks with explicit bounds, each step of which fails by itself with what it saw first
// (the OTA worker's last output included), never by a hook timeout. The tests then check what happened.
//
// The gate of AC2 needs no stack: a missing OTA build fails `startStack` at once, naming the build command, and CI
// runs this suite after its `Build` step.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { OTA_PROVISIONING_STEPS } from "@velexis/api-types/jobs";
import { createPool, createTenantDb, tenantTx } from "@velexis/db";
import { readMigrationFiles } from "@velexis/db/migrate";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { APP_DIR } from "../../src/config";
import { DEV_SEED_AMADEUS_CLIENT_ID, DEV_SEED_OFFICE_IDS } from "../../src/dev/dev-seed.command";
import { POST_STEP_NAMES } from "../../src/provisioning/post-steps/post-steps.runner";
import {
  createOta,
  OTA_BACKEND_DIR,
  OTA_BUILD_COMMAND,
  OtaBuildMissingError,
  outcomeOf,
  OTA_BLANKED_DSNS,
  REPO_ROOT,
  SETUP_POLL_MS,
  SETUP_TIMEOUT_MS,
  signUpOwner,
  startStack,
  waitForSetup,
  type CreatedOta,
  type PortalOwner,
  type SetupResult,
  type Stack,
} from "./stack";

/**
 * Starting the stack: the template clone, the API's and the worker's module graphs, the stub, `dev:seed` (an
 * application context and an Argon2id hash) and the OTA worker process, a few seconds each locally. The OTA worker's
 * readiness wait fails by itself after 60 s; the bound allows for that on a loaded CI runner.
 */
const STACK_TIMEOUT_MS = 180_000;
/**
 * The journey: sign-up and sign-in (Argon2id each), the verification e-mail (at most 20 s), createTenant, the setup (at
 * most 60 s, then waitForSetup fails by itself), the `notify` step (at most 20 s) and the reads.
 */
const JOURNEY_TIMEOUT_MS = 150_000;
/** Stopping the OTA worker (SIGTERM, at most 10 s before SIGKILL), the module graphs, and dropping the database. */
const STOP_TIMEOUT_MS = 60_000;
/** How long the hook waits for the last post-step (`notify`) after the OTA is `active`. */
const NOTIFY_WAIT_MS = 20_000;
/** Documentation address (RFC 5737) of the person who signs up. */
const PERSON_IP = "203.0.113.35";
/** The new OTA (the clone is this file's own, so the key is free). */
const OTA_KEY = "xbprovision";
const OTA_NAME = "Cross Backend Travel";
/** The OTA backend's tenant migrations, which the OTA worker applies. */
const TENANT_MIGRATIONS_DIR = join(OTA_BACKEND_DIR, "migrations", "tenant");

const quietPoolLogger = { error: (): void => undefined };

interface LedgerRow {
  readonly id: string;
  readonly checksum: string;
  readonly phase: string;
  readonly status: string;
}

interface MirrorRow {
  readonly version: string;
  readonly checksum: string;
  readonly phase: string;
  readonly status: string;
  readonly schema_name: string;
}

interface ProgressBody {
  readonly tenantStatus: string;
  readonly initialKeysAvailable: boolean;
  readonly job: {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly step: string | null;
    readonly attempt: number;
    readonly error: unknown;
    readonly steps: ReadonlyArray<{ readonly step: string; readonly status: string }>;
  };
}

describe("[PBE-035] a new OTA through the real OTA worker", () => {
  let stack: Stack;
  let otaPool: ReturnType<typeof createPool>;

  let owner: PortalOwner;
  let ota: CreatedOta;
  let setup: SetupResult;
  /** From before createTenant until the OTA was seen `active`. */
  let elapsedMs: number;
  /** The setup progress once the last post-step ran. */
  let done: Response;

  let schema: { readonly name: string; readonly owner: string } | undefined;
  let ledger: readonly LedgerRow[];
  let mirror: readonly MirrorRow[];
  let files: ReadonlyArray<{ readonly id: string; readonly checksum: string }>;
  let tenantRow: {
    readonly status: string;
    readonly schema_name: string;
    readonly schema_version: string | null;
  };
  let offices: ReadonlyArray<Record<string, unknown>>;
  let testAccountId: string | undefined;
  let connections: Response;
  let keys: Response;
  let keyRows: ReadonlyArray<Record<string, unknown>>;

  beforeAll(async () => {
    stack = await startStack();
    // velexis_ota_app on the clone: reads the schema the OTA worker built, through tenantTx (never writes).
    otaPool = createPool(stack.api.db.urlFor("ota"), {
      applicationName: "platform-xb-test",
      logger: quietPoolLogger,
      max: 2,
    });
    // Parses the platform document here, not in the first test that checks an answer.
    responseChecker("platform");
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    await otaPool?.end();
    await stack?.stop();
  }, STOP_TIMEOUT_MS);

  beforeAll(async () => {
    owner = await signUpOwner(stack, { label: "xb-owner", ip: PERSON_IP });
    const started = performance.now();
    ota = await createOta(stack, owner, { key: OTA_KEY, name: OTA_NAME });
    setup = await waitForSetup(stack, owner, ota.tenantId, { timeoutMs: SETUP_TIMEOUT_MS });
    elapsedMs = performance.now() - started;

    // `activate` makes the tenant active; `notify` runs right after its commit. Wait for it, bounded, at the pace of
    // waitForSetup, which keeps every read of this minute under the account's rate limit (stack.ts SETUP_POLL_MS).
    const deadline = performance.now() + NOTIFY_WAIT_MS;
    for (;;) {
      done = await stack.api.http.get(`/v1/tenants/${ota.tenantId}/provisioning`).set(owner.headers);
      const step = done.status === 200 ? (done.body as ProgressBody).job.step : undefined;
      if (step === "notify" || performance.now() > deadline) {
        break;
      }
      await delay(SETUP_POLL_MS);
    }

    const { rows: schemas } = await otaPool.query<{ name: string; owner: string }>(
      "SELECT nspname AS name, pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace " +
        "WHERE nspname = $1",
      [ota.schemaName],
    );
    schema = schemas[0];
    ledger = await tenantTx(createTenantDb(otaPool, { appEnv: "test" }), ota.schemaName, (trx) =>
      trx
        .selectFrom("schema_migrations")
        .select(["id", "checksum", "phase", "status"])
        .orderBy("id")
        .execute(),
    );
    const { pool } = stack;
    mirror = (
      await pool.query<MirrorRow>(
        "SELECT version, checksum, phase, status, schema_name FROM platform.tenant_schema_migrations " +
          "WHERE tenant_id = $1 ORDER BY version",
        [ota.tenantId],
      )
    ).rows;
    files = (await readMigrationFiles(TENANT_MIGRATIONS_DIR, "tenant")).numbered.map(({ id, checksum }) => ({
      id,
      checksum,
    }));
    const [tenant] = (
      await pool.query<{ status: string; schema_name: string; schema_version: string | null }>(
        "SELECT status, schema_name, schema_version FROM platform.tenants WHERE id = $1",
        [ota.tenantId],
      )
    ).rows;
    if (tenant === undefined) {
      throw new Error(`no platform.tenants row ${ota.tenantId}`);
    }
    tenantRow = tenant;
    offices = (
      await pool.query(
        "SELECT office_id, status, amadeus_account_id, assigned_tenant_id FROM platform.amadeus_offices " +
          "WHERE assigned_tenant_id = $1",
        [ota.tenantId],
      )
    ).rows as Array<Record<string, unknown>>;
    testAccountId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM platform.amadeus_accounts WHERE environment = 'test' AND client_id = $1",
        [DEV_SEED_AMADEUS_CLIENT_ID],
      )
    ).rows[0]?.id;
    connections = await stack.api.http
      .get(`/v1/tenants/${ota.tenantId}/amadeus-connections`)
      .set(owner.headers);
    keys = await stack.api.http.get(`/v1/tenants/${ota.tenantId}/api-keys`).set(owner.headers);
    keyRows = (
      await pool.query(
        "SELECT kind, environment, prefix, revoked_at FROM platform.api_keys WHERE tenant_id = $1 ORDER BY kind",
        [ota.tenantId],
      )
    ).rows as Array<Record<string, unknown>>;
  }, JOURNEY_TIMEOUT_MS);

  it("[PBE-035 AC1] becomes active through the real OTA worker within 60 seconds", () => {
    // The journey's answers keep the platform document.
    expectResponseToMatch("signUp", owner.responses.signUp, { document: "platform" });
    expectResponseToMatch("verifyEmail", owner.responses.verifyEmail, { document: "platform" });
    expectResponseToMatch("signIn", owner.responses.signIn, { document: "platform" });
    expectResponseToMatch("createTenant", ota.response, { document: "platform" });
    expectResponseToMatch("getProvisioning", setup.active, { document: "platform" });

    expect((setup.active.body as ProgressBody).tenantStatus).toBe("active");
    expect(elapsedMs).toBeLessThan(SETUP_TIMEOUT_MS);

    // Every step of the OTA worker's answer, then every platform post-step, done once, on the first attempt.
    expect(outcomeOf(done)).toBe("200");
    expectResponseToMatch("getProvisioning", done, { document: "platform" });
    const progress = done.body as ProgressBody;
    expect(progress).toMatchObject({
      tenantStatus: "active",
      initialKeysAvailable: true,
      job: { id: ota.jobId, kind: "provision", status: "succeeded", step: "notify", attempt: 1, error: null },
    });
    expect(progress.job.steps.map(({ step }) => step)).toEqual([
      ...OTA_PROVISIONING_STEPS,
      ...POST_STEP_NAMES,
    ]);
    expect(progress.job.steps.filter(({ status }) => status !== "succeeded")).toEqual([]);
    // The OTA worker is still up: the setup did not end it.
    expect(stack.otaWorker.exitDescription()).toBeUndefined();
  });

  it("[PBE-035 AC1] tenant_<key> exists, built by the OTA worker, with the migrations platform.tenant_schema_migrations records", () => {
    // Created by the OTA worker's role, never by the platform's (ADR-0004, OADR-0007 item 2).
    expect(schema).toEqual({ name: `tenant_${OTA_KEY}`, owner: "velexis_provisioner" });
    expect(files.length).toBeGreaterThan(0);
    // The OTA processes start without the migrator's and the test admin's DSN, and only the worker gets the
    // provisioner's: set empty, so a developer's `.env.local` cannot add them either (stack.ts header). Names only.
    const otaEnv = stack.otaEnv();
    expect(otaEnv).toMatchObject(OTA_BLANKED_DSNS);
    expect(
      Object.entries(otaEnv)
        .filter(([, value]) => /velexis_(migrator|provisioner|test_admin)\b/.test(value))
        .map(([name]) => name),
    ).toEqual([]);

    // The schema's own ledger has every tenant migration file, applied, with the file's checksum.
    expect(ledger.map(({ id, checksum }) => ({ id, checksum }))).toEqual(files);
    expect(ledger.every(({ status }) => status === "applied")).toBe(true);

    // The platform's mirror is the same ledger: version, checksum, phase and status, for this schema.
    expect(
      mirror.map(({ version, checksum, phase, status }) => ({ id: version, checksum, phase, status })),
    ).toEqual(ledger.map(({ id, checksum, phase, status }) => ({ id, checksum, phase, status })));
    expect(new Set(mirror.map(({ schema_name }) => schema_name))).toEqual(new Set([ota.schemaName]));
    expect(tenantRow).toEqual({
      status: "active",
      schema_name: ota.schemaName,
      schema_version: files[files.length - 1]?.id,
    });
  });

  it("[PBE-035 AC1] one test office of the Velexis test account is assigned to the OTA", () => {
    expect(testAccountId).toBeDefined();
    expect(offices).toHaveLength(1);
    const [office] = offices;
    expect(office).toMatchObject({
      status: "assigned",
      amadeus_account_id: testAccountId,
      assigned_tenant_id: ota.tenantId,
    });
    expect(DEV_SEED_OFFICE_IDS).toContain(office?.["office_id"]);

    // The portal sees the test connection on that office, active.
    expect(outcomeOf(connections)).toBe("200");
    expectResponseToMatch("listAmadeusConnections", connections, { document: "platform" });
    const { data } = connections.body as {
      data: Array<{ environment: string; credentialSource: string; status: string; officeIds: string[] }>;
    };
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      environment: "test",
      credentialSource: "velexis",
      status: "active",
      officeIds: [office?.["office_id"]],
      defaultOfficeId: office?.["office_id"],
    });
  });

  it("[PBE-035 AC1] two test keys exist: one publishable, one secret", () => {
    expect(outcomeOf(keys)).toBe("200");
    expectResponseToMatch("listApiKeys", keys, { document: "platform" });
    const { data } = keys.body as {
      data: Array<{
        kind: string;
        environment: string;
        prefix: string;
        scopes: string[];
        createdBy: unknown;
        revokedAt: unknown;
      }>;
    };
    expect(
      data
        .map(({ kind, environment, scopes, createdBy, revokedAt }) => ({
          kind,
          environment,
          scopes,
          createdBy,
          revokedAt,
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: "publishable", environment: "test", scopes: [], createdBy: null, revokedAt: null },
      { kind: "secret", environment: "test", scopes: ["storefront"], createdBy: null, revokedAt: null },
    ]);
    expect(data.map(({ prefix }) => prefix.slice(0, 8)).sort()).toEqual(["pk_test_", "sk_test_"]);

    expect(keyRows).toHaveLength(2);
    expect(keyRows.map((row) => [row["kind"], row["environment"], row["revoked_at"]])).toEqual([
      ["publishable", "test", null],
      ["secret", "test", null],
    ]);
  });
});

describe("[PBE-035] the gate on the OTA build", () => {
  it("[PBE-035 AC2] fails at once, naming the missing entry point and the build command, when dist/worker.js is missing", async () => {
    // An OTA backend folder without dist/: startStack must refuse before it creates a database or starts a process.
    // The services' settings are made invalid (restored after the test, unstubEnvs): a gate that ran after reading
    // them, creating the database or connecting to Redis would fail with another error, not OtaBuildMissingError.
    for (const variable of ["TEST_DATABASE_ADMIN_URL", "REDIS_URL", "SMTP_URL", "MAILPIT_API_URL"]) {
      vi.stubEnv(variable, "not-a-url");
    }
    const dir = mkdtempSync(join(tmpdir(), "velexis-xb-no-ota-build-"));
    try {
      const attempt = startStack({ otaBackendDir: dir });
      await expect(attempt).rejects.toBeInstanceOf(OtaBuildMissingError);
      await expect(attempt).rejects.toThrow(
        `test:xb runs the built OTA backend, and ${join(dir, "dist", "worker.js")} is missing. Build it first: ` +
          `${OTA_BUILD_COMMAND} (in CI, test:xb runs after the Build step).`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Inside the repository the path is shown as the developer types it.
    expect(new OtaBuildMissingError(["ota/backend/dist/worker.js"]).message).toContain(
      "ota/backend/dist/worker.js is missing. Build it first: pnpm --filter @velexis/ota-backend build",
    );
  });

  it("[PBE-035 AC2] CI runs test:xb in the build-test job after the Build step", () => {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["test:xb"]).toBe("vitest run --config vitest.xb.config.ts");

    const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
      jobs: Record<
        string,
        { steps: Array<{ name?: string; run?: string; if?: unknown; "continue-on-error"?: unknown }> }
      >;
    };
    const steps = workflow.jobs["build-test"]?.steps ?? [];
    const build = steps.findIndex((step) => step.name === "Build" && step.run?.trim() === "pnpm build");
    const crossBackend = steps.findIndex(
      (step) => step.run?.trim() === "pnpm --filter @velexis/platform-backend test:xb",
    );
    expect(build).toBeGreaterThanOrEqual(0);
    expect(crossBackend).toBeGreaterThan(build);
    // No condition of its own and no continue-on-error: it runs after Build as the steps before it do, and its
    // failure fails the job.
    expect(steps[crossBackend]?.if).toBeUndefined();
    expect(steps[crossBackend]?.["continue-on-error"]).toBeUndefined();
  });
});
