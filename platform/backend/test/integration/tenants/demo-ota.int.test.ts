// `tenants:create-demo` (PBE-075; lead decision (20a) of 2026-11-13; tenants/demo-ota.command.ts, its file header) with
// APP_ENV=production on this file's database clone and Redis database: the command creates Velexis's own OTA `demo`
// for an owner with MFA through createTenant's own transaction, the job goes to the (fake) OTA worker and the worker's
// post-steps set it up like an OTA the portal created, its manual subscription is `active` and every audit row names
// the command; a second run changes nothing; another key, an unknown e-mail, an owner without MFA, a `demo` of another
// owner (also for its admin or a removed owner) or in another status are refused with nothing changed; a run after one
// that stopped before its manual edit completes it; and the portal's key check and createTenant still refuse `demo`
// (`reserved`, `409`).
//
// The API (createTestApp, APP_ENV=production) serves the portal's calls and creates the OTA the demo is compared with;
// the worker's module graph (WorkerModule, as dist/worker.js builds it) and the fake OTA worker (test/support/
// fake-ota-worker.ts) provision both. The command runs in-process through `runCli` (the dispatcher of dist/cli.js) with
// the configuration of this file's clone and Redis database, in its own application context with the real Clock, as
// `node dist/cli.js` runs it; the first run has FEATURE_STRIPE_BILLING on, which changes nothing for the demo OTA. The
// API's FakeClock starts five minutes after the real time, so the worker's steps come after the command's writes.
// Every command runs in a setup hook with an explicit bound; the tests then check what happened.
import { randomUUID } from "node:crypto";
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import { validateJob } from "@velexis/api-types/jobs";
import { expectResponseToMatch, FakeClock, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountSecretPlace, generateTotpSecret } from "../../../src/accounts/mfa.service";
import { TokenService } from "../../../src/auth/token.service";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli } from "../../../src/cli";
import { Clock } from "../../../src/common/clock";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertRow,
  testId,
  type AccountRow,
  type PlatformRow,
} from "../../builders/platform-rows";
import {
  createTestApp,
  LogSink,
  TEST_BFF_KEY,
  TEST_STOREFRONT_BASE_DOMAIN,
  type TestApp,
} from "../../support/app";
import { FakeOtaWorker, schemaNamesFrom } from "../../support/fake-ota-worker";
import { createTestJwtKeyFile, type TestKeyFile } from "../../support/jwt-key";
import {
  createTestMasterKeyDir,
  testCryptoAndMailEnv,
  type TestMasterKeyDir,
} from "../../support/master-key";

/** Starting the API, the worker's graph and the fake OTA worker, and parsing the documents: seconds, bounded for CI. */
const SETUP_TIMEOUT_MS = 90_000;
/** A group's setup: CLI runs (an application context each) and the provisioning of two OTAs. */
const GROUP_SETUP_TIMEOUT_MS = 120_000;
/** How long a setup waits for the worker to set an OTA up. */
const WAIT_MS = 30_000;
/** Documentation address (RFC 5737). */
const PERSON_IP = "203.0.113.75";
/** A zone of the reference data for createTenant; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
const OPERATOR = "Developer One";
const LABEL = `cli tenants:create-demo by ${OPERATOR}`;
/** The arguments of every run but the key and the e-mail. */
const DEMO_FLAGS = ["--country", "FR", "--currency", "EUR", "--time-zone", TIME_ZONE, "--operator", OPERATOR];

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let envelope: EnvelopeService;
let worker: TestingModule;
let fake: FakeOtaWorker;
let jwtKey: TestKeyFile;
let masterKeys: TestMasterKeyDir;
/** The configuration of the command's runs: production, this file's clone and Redis database, key files of its own. */
let cliEnv: Record<string, string>;
const workerLogs = new LogSink();
let next = 1;

/** The owner of the demo OTA: an account with MFA, at an address of this file only. */
let owner: PlatformRow<"accounts">;

/** What a CLI run wrote and answered. */
interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node dist/cli.js tenants:create-demo <args>` in-process with `env` (default: this file's configuration). */
async function createDemo(args: readonly string[], env: Record<string, string> = cliEnv): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["tenants:create-demo", ...args], {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env,
  });
  return { code, stdout, stderr };
}

/** An account at an address of this file (active and verified unless `overrides` say otherwise). */
async function account(label: string, overrides: Partial<AccountRow> = {}): Promise<PlatformRow<"accounts">> {
  const n = next++;
  return insertAccount(pool, {
    id: testId("acc", 7500 + n),
    email: uniqueEmail(`${label}${n}`),
    ...overrides,
  });
}

/** An account with TOTP MFA on, its secret encrypted as MfaService stores it. */
async function mfaAccount(label: string): Promise<PlatformRow<"accounts">> {
  const created = await account(label);
  const { ciphertext, kekId } = await envelope.encrypt(generateTotpSecret(), accountSecretPlace(created.id));
  await pool.query(
    "UPDATE platform.accounts SET mfa_enabled = true, mfa_enabled_at = $2, mfa_secret_ciphertext = $3, " +
      "encryption_key_id = $4 WHERE id = $1",
    [created.id, t.clock.now(), Buffer.from(ciphertext), kekId],
  );
  return created;
}

/** The portal headers of `accountId`: a fresh portal access token and the portal server's headers. */
async function portal(accountId: string): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: testId("asn", 7500 + next++),
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** The portal's key check (`checkTenantKey`) of `key` as `accountId`. */
async function keyCheck(accountId: string, key: string): Promise<Response> {
  return t.http
    .get("/v1/tenants/key-availability")
    .query({ key })
    .set(await portal(accountId));
}

/** The portal's createTenant of `key` as `accountId`. */
async function portalCreate(accountId: string, key: string): Promise<Response> {
  return t.http
    .post("/v1/tenants")
    .set(await portal(accountId))
    .set("Idempotency-Key", randomUUID())
    .send({ key, name: "Portal Travel", countryCode: "FR", defaultCurrency: "EUR", timeZone: TIME_ZONE });
}

/** `<status>` of a success, or `<status> <code>` of an error answer. */
function outcomeOf(res: Response): string {
  return res.status < 300
    ? String(res.status)
    : `${res.status} ${(res.body as { error: { code: string } }).error.code}`;
}

async function rows(sql: string, params: readonly unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return (await pool.query(sql, [...params])).rows as Array<Record<string, unknown>>;
}

/** The tenant with `key`, or `undefined`. */
async function tenantByKey(key: string): Promise<Record<string, unknown> | undefined> {
  return (await rows("SELECT * FROM platform.tenants WHERE key = $1", [key]))[0];
}

/** Waits until the tenant with `key` is `active` (the worker's post-steps ran) and answers its id. */
async function activeTenant(key: string): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const tenant = await tenantByKey(key);
    if (tenant?.["status"] === "active") {
      return tenant["id"] as string;
    }
    if (Date.now() > deadline) {
      throw new Error(`the tenant ${key} is not active within ${WAIT_MS} ms (${String(tenant?.["status"])})`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** The audit rows the command wrote (its actor label), oldest first. */
async function commandAudit(): Promise<Array<Record<string, unknown>>> {
  return rows(
    "SELECT action, actor_type, actor_account_id, actor_label, target_type, target_id, tenant_id, tenant_key, details " +
      "FROM platform.platform_audit_log WHERE actor_label LIKE 'cli tenants:create-demo%' ORDER BY id",
  );
}

/**
 * Everything of an OTA that provisioning makes, without ids, keys, names, times or the subscription's status: the
 * demo OTA and an OTA the portal created must have the same.
 */
async function footprint(tenantId: string): Promise<Record<string, unknown>> {
  const one = async (sql: string) => rows(sql, [tenantId]);
  return {
    tenant: await one(
      "SELECT status, storefront_environment, plan_code, region, cluster, default_locale, schema_version, " +
        "live_enabled_at, suspended_at, suspension_reason, billing_notice, activated_at IS NOT NULL AS activated, " +
        "created_by_account_id IS NOT NULL AS has_creator, metadata, version FROM platform.tenants WHERE id = $1",
    ),
    members: await one("SELECT role, status FROM platform.tenant_memberships WHERE tenant_id = $1"),
    subscriptions: await one(
      "SELECT plan_code, billing_provider, billing_interval, trial_ends_at IS NOT NULL AS has_trial_end, " +
        "provider_customer_id, provider_subscription_id, cancel_at_period_end FROM platform.subscriptions " +
        "WHERE tenant_id = $1",
    ),
    domains: await one(
      "SELECT kind, purpose, verification_status, tls_status, is_primary, " +
        "hostname = t.key || '.ota.example.com' AS subdomain FROM platform.tenant_domains d " +
        "JOIN platform.tenants t ON t.id = d.tenant_id WHERE d.tenant_id = $1",
    ),
    jobs: await one(
      "SELECT kind, status, attempt, max_attempts, error, reveal_ciphertext IS NOT NULL AS keys_to_reveal " +
        "FROM platform.provisioning_jobs WHERE tenant_id = $1",
    ),
    amadeus: await one(
      "SELECT provider, environment, credential_source, status, default_office_id IS NOT NULL AS has_office " +
        "FROM platform.supplier_connections WHERE tenant_id = $1",
    ),
    payments: await one(
      "SELECT provider, environment, account_mode, capture_mode, status, is_default " +
        "FROM platform.payment_provider_connections WHERE tenant_id = $1",
    ),
    apiKeys: await one(
      "SELECT kind, environment, scopes FROM platform.api_keys WHERE tenant_id = $1 ORDER BY kind, environment",
    ),
    migrations: await one(
      "SELECT count(*)::int AS n FROM platform.tenant_schema_migrations WHERE tenant_id = $1",
    ),
  };
}

/** The rows a refused or idle run must leave as they are: counts, and the versions of the tenants and subscriptions. */
async function snapshot(): Promise<Record<string, unknown>> {
  const [counts] = await rows(
    "SELECT (SELECT count(*)::int FROM platform.tenants) AS tenants, " +
      "(SELECT count(*)::int FROM platform.tenant_memberships) AS members, " +
      "(SELECT count(*)::int FROM platform.subscriptions) AS subscriptions, " +
      "(SELECT count(*)::int FROM platform.tenant_domains) AS domains, " +
      "(SELECT count(*)::int FROM platform.provisioning_jobs) AS jobs, " +
      "(SELECT count(*)::int FROM platform.platform_audit_log) AS audit",
  );
  return {
    counts,
    tenants: await rows("SELECT id, key, status, version, updated_at FROM platform.tenants ORDER BY id"),
    subscriptions: await rows(
      "SELECT id, status, version, updated_at FROM platform.subscriptions ORDER BY id",
    ),
    otaMessages: fake.handled.length,
  };
}

beforeAll(async () => {
  t = await createTestApp({
    env: {
      APP_ENV: "production",
      // APP_ENV=production takes an https OTA API URL only (FIX-W39-PLATFORM).
      PUBLIC_OTA_API_URL: "https://api.ota.example.com",
    },
    clock: new FakeClock(Date.now() + 5 * 60_000),
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  envelope = t.app.get(EnvelopeService);
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120)",
    [TIME_ZONE],
  );
  responseChecker("platform");
  validateJob("tenant.provision", provisionFixture);

  worker = await Test.createTestingModule({
    imports: [
      WorkerModule.forRoot(t.config, createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs)),
    ],
  })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  fake = await FakeOtaWorker.start({
    redisUrl: t.redis.url,
    schemaNameOf: schemaNamesFrom(pool),
    now: () => t.clock.now(),
  });

  jwtKey = createTestJwtKeyFile();
  masterKeys = createTestMasterKeyDir();
  cliEnv = {
    APP_ENV: "production",
    LOG_LEVEL: "info",
    DATABASE_URL: t.db.urlFor("platform"),
    REDIS_URL: t.redis.url,
    PLATFORM_BFF_KEY: TEST_BFF_KEY,
    JWT_PRIVATE_KEY_FILE: jwtKey.path,
    ...testCryptoAndMailEnv(masterKeys),
    STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
    PUBLIC_OTA_API_URL: "https://api.ota.example.com",
  };

  // The Velexis test Amadeus account with two available offices: one for the demo OTA, one for the portal's.
  const amadeus = await insertAmadeusAccount(pool, { id: testId("ama", 7500), status: "active" });
  for (const n of [1, 2]) {
    await insertAmadeusOffice(pool, amadeus, { id: testId("amo", 7500 + n), office_id: `PAR1A750${n}` });
  }
  owner = await mfaAccount("demo-owner");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fake?.close();
  await worker?.close();
  await t?.close();
  jwtKey?.remove();
  masterKeys?.remove();
}, SETUP_TIMEOUT_MS);

describe("refusals before the demo OTA exists", () => {
  let before: Record<string, unknown>;
  let otherKey: CliRun;
  let unknownEmail: CliRun;
  let withoutMfa: CliRun;
  let unverified: CliRun;
  let unknownZone: CliRun;
  let keyCheckBefore: Response;
  let createBefore: Response;
  let noMfaEmail: string;

  beforeAll(async () => {
    const noMfa = await account("no-mfa");
    noMfaEmail = noMfa.email;
    const pending = await account("pending", { status: "pending_verification", email_verified_at: null });
    before = await snapshot();
    otherKey = await createDemo([owner.email, ...DEMO_FLAGS, "--key", "acme"]);
    unknownEmail = await createDemo([uniqueEmail("nobody"), ...DEMO_FLAGS]);
    withoutMfa = await createDemo([noMfa.email, ...DEMO_FLAGS]);
    unverified = await createDemo([pending.email, ...DEMO_FLAGS]);
    unknownZone = await createDemo([
      owner.email,
      "--country",
      "FR",
      "--currency",
      "EUR",
      "--time-zone",
      "Mars/Olympus",
      "--operator",
      OPERATOR,
    ]);
    keyCheckBefore = await keyCheck(owner.id, "demo");
    createBefore = await portalCreate(owner.id, "demo");
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-075 AC2] refuses another key with exit 2 before any configuration is read, writing nothing", async () => {
    expect(otherKey.code).toBe(EXIT_USAGE);
    expect(otherKey.stdout).toBe("");
    expect(otherKey.stderr).toMatch(
      /^tenants:create-demo: --key takes only Velexis's own key \(demo\); create any other OTA in the portal; nothing was created\.\n/,
    );
    expect(await tenantByKey("acme")).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it("[PBE-075 AC2] refuses an unknown e-mail and an owner without MFA (or unverified) with exit 1, writing nothing", async () => {
    expect([unknownEmail, withoutMfa, unverified].map((run) => run.code)).toEqual([
      EXIT_FAILED,
      EXIT_FAILED,
      EXIT_FAILED,
    ]);
    expect(unknownEmail.stderr).toMatch(/^No account has the e-mail address \S+; nothing was created\.\n$/);
    expect(withoutMfa.stderr).toBe(
      `The account ${noMfaEmail} has no MFA; nothing was created. The person turns MFA on in the portal first ` +
        "(Account, Security), then run tenants:create-demo again.\n",
    );
    expect(unverified.stderr).toMatch(/has not verified its e-mail address; nothing was created\./);
    for (const run of [unknownEmail, withoutMfa, unverified]) {
      expect(run.stdout).toBe("");
    }
    expect(await tenantByKey("demo")).toBeUndefined();
    expect(await commandAudit()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a time zone the reference data does not hold with exit 1 (createTenant's check), writing nothing", async () => {
    expect(unknownZone.code).toBe(EXIT_FAILED);
    expect(unknownZone.stderr).toBe(
      "The reference data holds no such value for --time-zone; nothing was created.\n",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("[PBE-075 AC3] the portal's key check answers reserved for demo, and createTenant 409, also for the owner", () => {
    expectResponseToMatch("checkTenantKey", keyCheckBefore, { document: "platform" });
    expect(keyCheckBefore.body).toEqual({
      key: "demo",
      available: false,
      reason: "reserved",
      storefrontHost: "demo.ota.example.com",
    });
    expectResponseToMatch("createTenant", createBefore, { document: "platform" });
    expect(outcomeOf(createBefore)).toBe("409 TENANT_KEY_UNAVAILABLE");
  });
});

describe("the first run with APP_ENV=production", () => {
  let first: CliRun;
  let demoId: string;
  let portalId: string;
  let portalCreated: Response;

  beforeAll(async () => {
    // The OTA the demo is compared with: created in the portal by an account of its own.
    const portalOwner = await account("portal-owner");
    portalCreated = await portalCreate(portalOwner.id, "portalota");
    portalId = await activeTenant("portalota");

    // The billing switch on: the demo OTA still gets the manual trial of early_access, and Stripe is never called.
    first = await createDemo([owner.email, ...DEMO_FLAGS], {
      ...cliEnv,
      FEATURE_STRIPE_BILLING: "true",
      STRIPE_SECRET_KEY: "sk_live_never_called",
      STRIPE_BILLING_WEBHOOK_SECRET: "whsec_never_called",
    });
    demoId = await activeTenant("demo");
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-075 AC1] exits 0 and says what it created, with ids and statuses only", () => {
    expect(first.stderr).toBe("");
    expect(first.code).toBe(EXIT_OK);
    const lines = first.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      new RegExp(
        `^The OTA demo "Velexis demo" \\(${demoId}\\) of ${owner.email.replace(/[.+]/g, "\\$&")} was created: ` +
          "provisioning, storefront environment test, plan early_access; its setup job job_\\w+ is running\\. " +
          "Audit rows tenant\\.created and tenant\\.reserved_key_used were written\\.$",
      ),
    );
    expect(lines[1]).toMatch(
      /^Its manual subscription sub_\w+ is now active \("Velexis demo OTA, not billed"; audit row subscription\.manually_updated\)/,
    );
    expect(lines[2]).toBe(
      `Next: the owner signs in to the portal and opens /otas/${demoId}/setup within 24 hours of the setup to ` +
        "reveal the initial test keys once.",
    );
  });

  it("[PBE-075 AC1] creates the OTA demo for the owner in the test environment, on early_access, with an active manual subscription", async () => {
    expect(await tenantByKey("demo")).toMatchObject({
      id: demoId,
      key: "demo",
      name: "Velexis demo",
      status: "active",
      storefront_environment: "test",
      live_enabled_at: null,
      plan_code: "early_access",
      country_code: "FR",
      default_currency: "EUR",
      time_zone: TIME_ZONE,
      created_by_account_id: owner.id,
      schema_name: "tenant_demo",
    });
    expect(
      await rows("SELECT account_id, role, status FROM platform.tenant_memberships WHERE tenant_id = $1", [
        demoId,
      ]),
    ).toEqual([{ account_id: owner.id, role: "owner", status: "active" }]);
    expect(
      await rows(
        "SELECT plan_code, billing_provider, status, canceled_at FROM platform.subscriptions WHERE tenant_id = $1",
        [demoId],
      ),
    ).toEqual([
      { plan_code: "early_access", billing_provider: "manual", status: "active", canceled_at: null },
    ]);
    expect(
      await rows(
        "SELECT hostname, kind, verification_status, is_primary FROM platform.tenant_domains WHERE tenant_id = $1",
        [demoId],
      ),
    ).toEqual([
      {
        hostname: "demo.ota.example.com",
        kind: "subdomain",
        verification_status: "verified",
        is_primary: true,
      },
    ]);
    // No Stripe customer: the demo OTA stays out of billing.
    expect(await rows("SELECT 1 FROM platform.billing_customers WHERE tenant_id = $1", [demoId])).toEqual([]);
  });

  it("[PBE-075 AC1] is provisioned like an OTA the portal created: the same rows, the same job, the same setup", async () => {
    expect(outcomeOf(portalCreated)).toBe("202");
    const demo = await footprint(demoId);
    const portalOta = await footprint(portalId);
    expect(demo).toEqual(portalOta);
    expect(demo["jobs"]).toEqual([
      {
        kind: "provision",
        status: "succeeded",
        attempt: 1,
        max_attempts: 5,
        error: null,
        keys_to_reveal: true,
      },
    ]);
    // The setup ran to its end: the Velexis test Amadeus connection with an office, the test payment connection in
    // velexis mode, the initial test keys and the tenant migrations.
    expect(demo).toMatchObject({
      amadeus: [{ environment: "test", credential_source: "velexis", status: "active", has_office: true }],
      payments: [{ environment: "test", account_mode: "velexis", status: "active" }],
      apiKeys: [
        { kind: "publishable", environment: "test" },
        { kind: "secret", environment: "test" },
      ],
      migrations: [{ n: 2 }],
    });
    // The dispatch after the commit handed the job to the OTA worker, its message valid against the job contract.
    const handled = fake.handled.filter((entry) => entry.message.tenantId === demoId);
    expect(handled.map((entry) => [entry.message.name, entry.answer?.name])).toEqual([
      ["tenant.provision", "tenant.provisioned"],
    ]);
    expect(fake.invalid).toEqual([]);
  });

  it("[PBE-075 AC1] writes tenant.created, tenant.reserved_key_used and subscription.manually_updated, each naming the command", async () => {
    const audit = await commandAudit();
    expect(audit.map((row) => row["action"])).toEqual([
      "tenant.created",
      "tenant.reserved_key_used",
      "subscription.manually_updated",
    ]);
    for (const row of audit) {
      expect(row).toMatchObject({
        actor_type: "system",
        actor_account_id: null,
        actor_label: LABEL,
        tenant_id: demoId,
        tenant_key: "demo",
      });
      expect(row["details"]).toMatchObject({ command: "tenants:create-demo", operator: OPERATOR });
    }
    const [created, reserved, updated] = audit;
    expect(created?.["details"]).toMatchObject({
      ownerAccountId: owner.id,
      subscriptionStatus: "trialing",
      billingProvider: "manual",
      after: { key: "demo", status: "provisioning", planCode: "early_access", storefrontEnvironment: "test" },
    });
    expect(reserved).toMatchObject({ target_type: "tenant", target_id: demoId });
    expect(reserved?.["details"]).toEqual({
      command: "tenants:create-demo",
      operator: OPERATOR,
      key: "demo",
      ownerAccountId: owner.id,
    });
    expect(updated).toMatchObject({ target_type: "subscription" });
    expect(updated?.["details"]).toMatchObject({
      reason: "Velexis demo OTA, not billed",
      before: { status: "trialing" },
      after: { status: "active" },
    });
  });
});

describe("a second run for the same owner", () => {
  let before: Record<string, unknown>;
  let second: CliRun;

  beforeAll(async () => {
    before = await snapshot();
    second = await createDemo([owner.email.toUpperCase(), ...DEMO_FLAGS]);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-075 AC1] reports the existing OTA, exits 0 and changes nothing", async () => {
    const demo = await tenantByKey("demo");
    expect(second.code).toBe(EXIT_OK);
    expect(second.stderr).toBe("");
    expect(second.stdout).toMatch(
      new RegExp(
        `^The OTA demo "Velexis demo" \\(${String(demo?.["id"])}\\) of \\S+ exists already \\(active\\); it was not ` +
          "created again\\.\\nIts manual subscription sub_\\w+ is active already; nothing changed\\.\\n$",
      ),
    );
    expect(await snapshot()).toEqual(before);
  });
});

describe("the portal and the API once the demo OTA exists", () => {
  let other: PlatformRow<"accounts">;
  let keyChecks: Response[];
  let creates: Response[];

  beforeAll(async () => {
    other = await account("someone-else");
    keyChecks = [await keyCheck(owner.id, "demo"), await keyCheck(other.id, "demo")];
    creates = [await portalCreate(owner.id, "demo"), await portalCreate(other.id, "demo")];
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-075 AC3] the key check still answers reserved, and createTenant 409 TENANT_KEY_UNAVAILABLE", async () => {
    for (const res of keyChecks) {
      expectResponseToMatch("checkTenantKey", res, { document: "platform" });
      expect(res.body).toEqual({
        key: "demo",
        available: false,
        reason: "reserved",
        storefrontHost: "demo.ota.example.com",
      });
    }
    for (const res of creates) {
      expectResponseToMatch("createTenant", res, { document: "platform" });
      expect(outcomeOf(res)).toBe("409 TENANT_KEY_UNAVAILABLE");
    }
    expect(await rows("SELECT id FROM platform.tenants WHERE key = 'demo'")).toHaveLength(1);
  });
});

describe("refusals once the demo OTA exists", () => {
  /** Accounts with MFA that are not the demo OTA's owner: none, an active admin, a removed owner. */
  let notOwners: Array<{ readonly email: string; readonly run: CliRun }>;
  let suspended: CliRun;
  let afterOtherOwner: Record<string, unknown>;
  let beforeOtherOwner: Record<string, unknown>;
  let beforeSuspended: Record<string, unknown>;
  let afterSuspended: Record<string, unknown>;

  beforeAll(async () => {
    // Another person with MFA and no membership; an active admin of the demo OTA (the product owner invited for its
    // branding and texts, launch checklist §6); and an owner whose membership was removed. Only an active owner may
    // run the command for it.
    const demoId = String((await tenantByKey("demo"))?.["id"]);
    const someone = await mfaAccount("other-owner");
    const admin = await mfaAccount("demo-admin");
    const formerOwner = await mfaAccount("former-owner");
    for (const [n, member, role, status] of [
      [1, admin, "admin", "active"],
      [2, formerOwner, "owner", "removed"],
    ] as const) {
      await insertRow(pool, "tenant_memberships", {
        id: testId("stf", 7500 + n),
        tenant_id: demoId,
        account_id: member.id,
        role,
        status,
      });
    }
    beforeOtherOwner = await snapshot();
    notOwners = [];
    for (const account of [someone, admin, formerOwner]) {
      notOwners.push({ email: account.email, run: await createDemo([account.email, ...DEMO_FLAGS]) });
    }
    afterOtherOwner = await snapshot();

    // The demo OTA suspended (as an admin would): the command leaves it to the platform admin.
    await pool.query(
      "UPDATE platform.tenants SET status = 'suspended', suspended_at = now(), suspension_reason = 'admin' " +
        "WHERE key = 'demo'",
    );
    beforeSuspended = await snapshot();
    suspended = await createDemo([owner.email, ...DEMO_FLAGS]);
    afterSuspended = await snapshot();
    await pool.query(
      "UPDATE platform.tenants SET status = 'active', suspended_at = NULL, suspension_reason = NULL WHERE key = 'demo'",
    );
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-075 AC2] refuses a demo OTA of another owner, also for its admin or a removed owner, with exit 1 and changes nothing", async () => {
    const demo = await tenantByKey("demo");
    expect(notOwners).toHaveLength(3);
    for (const { email, run } of notOwners) {
      expect(run.code, email).toBe(EXIT_FAILED);
      expect(run.stdout, email).toBe("");
      expect(run.stderr, email).toBe(
        `The OTA demo (${String(demo?.["id"])}) exists and ${email} is not its owner; nothing changed.\n`,
      );
    }
    expect(afterOtherOwner).toEqual(beforeOtherOwner);
  });

  it("[PBE-075 AC2] refuses a demo OTA in another status than active or provisioning with exit 1 and changes nothing", () => {
    expect(suspended.code).toBe(EXIT_FAILED);
    expect(suspended.stdout).toBe("");
    expect(suspended.stderr).toMatch(
      /^The OTA demo \(ten_\w+\) is suspended, not active or provisioning; nothing changed\./,
    );
    expect(afterSuspended).toEqual(beforeSuspended);
  });
});

describe("a run after a first run that stopped before its manual edit", () => {
  let completed: CliRun;
  let subscriptionId: string;

  beforeAll(async () => {
    // What a first run leaves when it stops between its two transactions: the manual trial of createTenant.
    const [subscription] = await rows(
      "UPDATE platform.subscriptions SET status = 'trialing', version = version + 1 " +
        "WHERE tenant_id = (SELECT id FROM platform.tenants WHERE key = 'demo') RETURNING id",
    );
    subscriptionId = String(subscription?.["id"]);
    completed = await createDemo([owner.email, ...DEMO_FLAGS]);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-075 AC1] sets the manual subscription active, audited as the command, and creates nothing", async () => {
    expect(completed.code).toBe(EXIT_OK);
    expect(completed.stderr).toBe("");
    expect(completed.stdout).toMatch(/exists already \(active\); it was not created again\.\n/);
    expect(completed.stdout).toContain(`Its manual subscription ${subscriptionId} is now active`);
    expect(await rows("SELECT status FROM platform.subscriptions WHERE id = $1", [subscriptionId])).toEqual([
      { status: "active" },
    ]);
    const audit = await commandAudit();
    expect(audit.map((row) => row["action"])).toEqual([
      "tenant.created",
      "tenant.reserved_key_used",
      "subscription.manually_updated",
      "subscription.manually_updated",
    ]);
    expect(await rows("SELECT id FROM platform.tenants WHERE key = 'demo'")).toHaveLength(1);
  });
});
