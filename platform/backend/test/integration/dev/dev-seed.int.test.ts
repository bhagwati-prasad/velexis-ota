// `dev:seed` of dist/cli.js (PBE-034; README §5 and §6, platform/docs/flows/amadeus-connection.md §A item 4): refused
// with exit 1 and nothing written when APP_ENV=production; otherwise it creates, once, the platform admin
// `admin@example.com` with MFA (printing its password and `otpauth://` URI once), the Velexis test Amadeus account at
// AMADEUS_BASE_URL_TEST (the stub), verified, and 10 test offices. A second run creates no duplicates, prints no secret
// and writes no audit row. When the stub is not running the account stays `pending_verification` and the command exits
// 1; once the stub runs, the next run verifies it. A test account that an admin disabled or configured is left as it
// is.
//
// The command runs in-process through `runCli` (the dispatcher of dist/cli.js) with the configuration of this file's
// database clone and Redis database and the API's key folder (`CliOptions.env`), in its own application context (the
// real Clock), as `node dist/cli.js dev:seed` runs it: `pnpm test:int` runs before the build, so the compiled file is
// not used here. The Amadeus stub runs in this process (`@velexis/testing/amadeus`). The API (createTestApp, a
// FakeClock at the real time) checks that the printed password and TOTP URI sign in to the platform admin. Every
// command runs in a setup hook with an explicit bound; the tests then check what happened.
import { createServer } from "node:net";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { createPool } from "@velexis/db";
import { createLogger } from "@velexis/logger";
import {
  createTestDatabase,
  expectResponseToMatch,
  FakeClock,
  responseChecker,
  type TestDatabase,
} from "@velexis/testing";
import { startAmadeusStub, TOKEN_OPERATION, type AmadeusStub } from "@velexis/testing/amadeus";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountSecretPlace, totpCode } from "../../../src/accounts/mfa.service";
import { defaultOperator } from "../../../src/admin/admin-cli.commands";
import { EXIT_FAILED, EXIT_OK, runCli } from "../../../src/cli";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  DEV_SEED_ADMIN_EMAIL,
  DEV_SEED_AMADEUS_CLIENT_ID,
  DEV_SEED_OFFICE_IDS,
} from "../../../src/dev/dev-seed.command";
import { clientSecretPlace } from "../../../src/supplier-connections/verification.processor";
import {
  insertAccount,
  insertAmadeusAccount,
  type PlatformRow,
  type Queryable,
} from "../../builders/platform-rows";
import {
  createTestApp,
  LogSink,
  TEST_BFF_KEY,
  TEST_STOREFRONT_BASE_DOMAIN,
  type TestApp,
} from "../../support/app";
import { TEST_MAIL_ENV } from "../../support/master-key";

/**
 * Starting the API on a database clone, the stub and parsing the platform document take a few seconds; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few CLI runs (an application context and an Argon2id hash each) and a sign-in. */
const GROUP_SETUP_TIMEOUT_MS = 120_000;
/** How long a test waits for the invalidation event of a commit. */
const WAIT_MS = 10_000;

let t: TestApp;
let pool: PlatformPool;
let envelope: EnvelopeService;
let stub: AmadeusStub;
let subscriber: Redis;
/** The configuration of the CLI runs: this file's clone and Redis database, the API's key files, the stub. */
let cliEnv: Record<string, string>;
/** The `amadeus_account` invalidations received. */
const invalidated: InvalidationEvent[] = [];

/** What a CLI run wrote and answered. */
interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node dist/cli.js <argv>` in-process with `env` (default: this file's configuration). */
async function cli(argv: readonly string[], env: Record<string, string> = cliEnv): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env,
  });
  return { code, stdout, stderr };
}

/** The rows dev:seed may write, counted per table. */
interface Counts {
  readonly accounts: number;
  readonly amadeusAccounts: number;
  readonly amadeusOffices: number;
  readonly auditRows: number;
}

async function counts(db: Queryable = pool): Promise<Counts> {
  const { rows } = await db.query(
    "SELECT (SELECT count(*)::int FROM platform.accounts) AS accounts, " +
      "(SELECT count(*)::int FROM platform.amadeus_accounts) AS amadeus_accounts, " +
      "(SELECT count(*)::int FROM platform.amadeus_offices) AS amadeus_offices, " +
      "(SELECT count(*)::int FROM platform.platform_audit_log) AS audit_rows",
  );
  const row = rows[0] as Record<string, number>;
  return {
    accounts: row["accounts"] ?? -1,
    amadeusAccounts: row["amadeus_accounts"] ?? -1,
    amadeusOffices: row["amadeus_offices"] ?? -1,
    auditRows: row["audit_rows"] ?? -1,
  };
}

async function adminAccount(db: Queryable = pool): Promise<PlatformRow<"accounts"> | undefined> {
  const { rows } = await db.query("SELECT * FROM platform.accounts WHERE lower(email) = $1", [
    DEV_SEED_ADMIN_EMAIL,
  ]);
  return rows[0] as PlatformRow<"accounts"> | undefined;
}

async function testAmadeusAccount(
  db: Queryable = pool,
): Promise<PlatformRow<"amadeus_accounts"> | undefined> {
  const { rows } = await db.query("SELECT * FROM platform.amadeus_accounts WHERE environment = 'test'");
  return rows[0] as PlatformRow<"amadeus_accounts"> | undefined;
}

async function offices(db: Queryable = pool): Promise<Array<PlatformRow<"amadeus_offices">>> {
  const { rows } = await db.query("SELECT * FROM platform.amadeus_offices ORDER BY office_id");
  return rows as Array<PlatformRow<"amadeus_offices">>;
}

async function auditRows(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, actor_label, action, target_type, target_id, details " +
      "FROM platform.platform_audit_log ORDER BY id",
  );
  return rows as Array<Record<string, unknown>>;
}

/** The token requests the stub received. */
const tokenRequests = (of: AmadeusStub = stub): number =>
  of.requests().filter((request) => request.operation === TOKEN_OPERATION).length;

/** The password and TOTP set-up URI a run printed, if any. */
function printedSecrets(run: CliRun): { password?: string; otpauthUrl?: string } {
  const password = /^ {2}Password: +(\S+)$/m.exec(run.stdout)?.[1];
  const otpauthUrl = /^ {2}TOTP set-up URI: +(otpauth:\/\/\S+)$/m.exec(run.stdout)?.[1];
  return {
    ...(password === undefined ? {} : { password }),
    ...(otpauthUrl === undefined ? {} : { otpauthUrl }),
  };
}

/** A TCP port of 127.0.0.1 that nothing listens on (now). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  await new Promise<void>((closed) => server.close(() => closed()));
  if (address === null || typeof address === "string") {
    throw new Error("no TCP address");
  }
  return address.port;
}

/** `<status>` of a success, or `<status> <code>` of an error answer. */
function outcomeOf(res: Response): string {
  return res.status < 300
    ? String(res.status)
    : `${res.status} ${(res.body as { error: { code: string } }).error.code}`;
}

beforeAll(async () => {
  // The CLI runs on the real Clock; the API's FakeClock starts at the real time, so the TOTP codes agree.
  t = await createTestApp({ clock: new FakeClock(new Date()) });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  envelope = t.app.get(EnvelopeService);
  stub = await startAmadeusStub();
  cliEnv = {
    APP_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL: t.db.urlFor("platform"),
    REDIS_URL: t.redis.url,
    PLATFORM_BFF_KEY: TEST_BFF_KEY,
    JWT_PRIVATE_KEY_FILE: t.config.JWT_PRIVATE_KEY_FILE,
    MASTER_KEY_DIR: t.config.MASTER_KEY_DIR,
    MASTER_KEY_CURRENT: t.config.MASTER_KEY_CURRENT,
    API_KEY_PEPPER_FILE: t.config.API_KEY_PEPPER_FILE,
    ...TEST_MAIL_ENV,
    STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
    AMADEUS_BASE_URL_TEST: stub.url,
  };
  // Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same
  // time, so only `amadeus_account` events are kept, and the tests look for this file's account.
  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-dev-seed-test" });
  subscriber.on("message", (channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (channel === INVALIDATION_CHANNEL && event.type === "amadeus_account") {
      invalidated.push(event);
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
  // Compiles the platform document's response schemas here, not in the first test that checks an answer.
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await stub?.stop();
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("dev:seed", () => {
  let empty: Counts;
  let production: CliRun;
  let afterProduction: Counts;
  let tokensAfterProduction: number;
  let first: CliRun;
  let afterFirst: Counts;
  let tokensAfterFirst: number;
  let auditAfterFirst: Array<Record<string, unknown>>;
  let invalidatedAfterFirst: boolean;
  let second: CliRun;
  let afterSecond: Counts;
  let tokensAfterSecond: number;
  let adminSignIn: Response;
  let adminVerify: Response;

  beforeAll(async () => {
    empty = await counts();
    production = await cli(["dev:seed"], { ...cliEnv, APP_ENV: "production" });
    afterProduction = await counts();
    tokensAfterProduction = tokenRequests();

    first = await cli(["dev:seed"]);
    afterFirst = await counts();
    tokensAfterFirst = tokenRequests();
    auditAfterFirst = await auditRows();
    // The `amadeus_account` invalidation of the first run's commit, waited for here (bounded by WAIT_MS).
    const seeded = (await testAmadeusAccount())?.id;
    const seen = (): boolean =>
      invalidated.some((event) => event.type === "amadeus_account" && event.id === seeded);
    const deadline = Date.now() + WAIT_MS;
    while (!seen() && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20));
    }
    invalidatedAfterFirst = seen();

    second = await cli(["dev:seed"]);
    afterSecond = await counts();
    tokensAfterSecond = tokenRequests();

    // The new admin signs in to the platform admin with what the first run printed.
    const { password = "", otpauthUrl = "" } = printedSecrets(first);
    const secret = new URL(otpauthUrl || "otpauth://totp/none").searchParams.get("secret") ?? "";
    const ip = "203.0.113.190";
    adminSignIn = await t.http
      .post("/v1/admin/auth/sign-in")
      .set(t.bffHeaders(ip))
      .send({ email: DEV_SEED_ADMIN_EMAIL, password });
    adminVerify = await t.http
      .post("/v1/admin/auth/mfa/verify")
      .set(t.bffHeaders(ip))
      .send({
        mfaChallengeToken: (adminSignIn.body as { mfaChallengeToken?: string }).mfaChallengeToken ?? "",
        code: totpCode(secret, t.clock.now()),
      });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-034 AC2] exits 1 without writing anything when APP_ENV=production", () => {
    expect(production.code).toBe(EXIT_FAILED);
    expect(production.stderr).toBe(
      "dev:seed creates development data and refuses APP_ENV=production; nothing was written.\n",
    );
    expect(production.stdout).toBe("");
    expect(afterProduction).toEqual(empty);
    expect(tokensAfterProduction).toBe(0);
  });

  it("[PBE-034 AC2] creates the platform admin with MFA and prints its otpauth:// URI and password once", async () => {
    expect(first.code, first.stderr).toBe(EXIT_OK);
    expect(first.stderr).toBe("");
    const printed = printedSecrets(first);
    expect(printed.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Velexis:admin%40example\.com\?secret=[A-Z2-7]+&/);
    expect(printed.password).toMatch(/^[A-Za-z0-9_-]{24}$/);

    const admin = await adminAccount();
    expect(admin).toMatchObject({
      email: DEV_SEED_ADMIN_EMAIL,
      status: "active",
      is_platform_admin: true,
      mfa_enabled: true,
      deleted_at: null,
    });
    expect(admin?.email_verified_at).toBeInstanceOf(Date);
    expect(admin?.mfa_enabled_at).toBeInstanceOf(Date);
    expect(admin?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    // The TOTP secret is stored only as the envelope MfaService reads.
    const secret = new URL(printed.otpauthUrl ?? "").searchParams.get("secret");
    const stored = await envelope.decrypt(
      Buffer.from(admin?.mfa_secret_ciphertext ?? Buffer.alloc(0)),
      accountSecretPlace(admin?.id ?? ""),
    );
    expect(stored.toString("utf8")).toBe(secret);
    expect(Buffer.from(admin?.mfa_secret_ciphertext ?? Buffer.alloc(0)).toString("latin1")).not.toContain(
      secret ?? "",
    );
  });

  it("[PBE-034 AC2] creates the Velexis test Amadeus account at AMADEUS_BASE_URL_TEST, verified at the stub", async () => {
    const account = await testAmadeusAccount();
    expect(account).toMatchObject({
      environment: "test",
      base_url: stub.url,
      client_id: DEV_SEED_AMADEUS_CLIENT_ID,
      status: "active",
      last_error: null,
      created_by_account_id: (await adminAccount())?.id,
    });
    expect(account?.last_verified_at).toBeInstanceOf(Date);
    expect(tokensAfterFirst).toBe(1);
    expect(first.stdout).toContain(
      `Velexis test Amadeus account (${account?.id ?? ""}) at ${stub.url}: created, verified, active.`,
    );
    // The change of status reaches the OTA backend's caches, as the verification job's does.
    expect(invalidatedAfterFirst, "the amadeus_account invalidation of the account").toBe(true);
  });

  it("[PBE-034 AC2] adds the 10 test offices to the test account's pool", async () => {
    const account = await testAmadeusAccount();
    const pool10 = await offices();
    expect(pool10.map((office) => office.office_id)).toEqual([...DEV_SEED_OFFICE_IDS]);
    expect(new Set(pool10.map((office) => office.amadeus_account_id))).toEqual(new Set([account?.id]));
    expect(
      pool10.every((office) => office.status === "available" && office.assigned_tenant_id === null),
    ).toBe(true);
    expect(first.stdout).toContain("Test offices DEV1A0001 to DEV1A0010: 10 added, 0 in the pool already.");
  });

  it("[PBE-034 AC2] writes one audit row per change, as the system with the operator", async () => {
    const label = `cli dev:seed by ${defaultOperator()}`;
    const admin = await adminAccount();
    const account = await testAmadeusAccount();
    expect(auditAfterFirst.map((row) => [row["action"], row["target_type"], row["target_id"]])).toEqual([
      ["admin.granted", "account", admin?.id],
      ["amadeus_account.created", "amadeus_account", account?.id],
      ["amadeus_account.verified", "amadeus_account", account?.id],
      ["amadeus_office.added", "amadeus_account", account?.id],
    ]);
    for (const row of auditAfterFirst) {
      expect(row).toMatchObject({ actor_type: "system", actor_account_id: null, actor_label: label });
    }
  });

  it("[PBE-034 AC2] running dev:seed twice creates no duplicates, prints no secret and writes no audit row", () => {
    expect(second.code, second.stderr).toBe(EXIT_OK);
    expect(second.stderr).toBe("");
    expect(afterFirst).toEqual({
      accounts: empty.accounts + 1,
      amadeusAccounts: empty.amadeusAccounts + 1,
      amadeusOffices: empty.amadeusOffices + DEV_SEED_OFFICE_IDS.length,
      auditRows: empty.auditRows + 4,
    });
    expect(afterSecond).toEqual(afterFirst);
    // An active account is not verified again.
    expect(tokensAfterSecond).toBe(tokensAfterFirst);
    expect(printedSecrets(second)).toEqual({});
    expect(second.stdout).not.toContain("otpauth://");
    expect(second.stdout).not.toContain(printedSecrets(first).password ?? "no password printed");
    expect(second.stdout).toContain(`Platform admin ${DEV_SEED_ADMIN_EMAIL} (`);
    expect(second.stdout).toContain("exists already; nothing changed");
    expect(second.stdout).toContain("Test offices DEV1A0001 to DEV1A0010: 0 added, 10 in the pool already.");
  });

  it("[PBE-034] the new admin signs in to the platform admin with the printed password and a code of the URI", async () => {
    expectResponseToMatch("adminSignIn", adminSignIn, { document: "platform" });
    expect(outcomeOf(adminSignIn)).toBe("200");
    expectResponseToMatch("adminVerifyMfa", adminVerify, { document: "platform" });
    expect(outcomeOf(adminVerify)).toBe("200");
    expect((adminVerify.body as { admin: { id: string } }).admin.id).toBe((await adminAccount())?.id);
  });

  it("[PBE-034] never prints the client secret, and keeps every secret out of the audit rows and the logs", async () => {
    const account = await testAmadeusAccount();
    const clientSecret = (
      await envelope.decrypt(
        Buffer.from(account?.client_secret_ciphertext ?? Buffer.alloc(0)),
        clientSecretPlace(account?.id ?? ""),
      )
    ).toString("utf8");
    const { password = "", otpauthUrl = "" } = printedSecrets(first);
    const totpSecret = new URL(otpauthUrl).searchParams.get("secret") ?? "";
    expect(clientSecret.length).toBeGreaterThanOrEqual(20);
    const everywhere = [
      first.stdout,
      first.stderr,
      second.stdout,
      second.stderr,
      JSON.stringify(await auditRows()),
      JSON.stringify(t.logs.lines),
    ].join("\n");
    expect(everywhere).not.toContain(clientSecret);
    const notPrinted = [first.stderr, second.stdout, second.stderr, JSON.stringify(await auditRows())].join(
      "\n",
    );
    expect(notPrinted).not.toContain(password);
    expect(notPrinted).not.toContain(totpSecret);
  });
});

describe("dev:seed while the Amadeus stub is not running", () => {
  let other: TestDatabase;
  let otherPool: PlatformPool;
  let lateStub: AmadeusStub | undefined;
  let baseUrl: string;
  let down: CliRun;
  let accountWhileDown: PlatformRow<"amadeus_accounts"> | undefined;
  let officesWhileDown: number;
  let up: CliRun;
  let accountWhenUp: PlatformRow<"amadeus_accounts"> | undefined;
  let afterDown: Counts;
  let afterUp: Counts;
  let tokensWhenUp: number;
  let disabledRun: CliRun;
  let accountWhenDisabled: PlatformRow<"amadeus_accounts"> | undefined;
  let afterDisabled: Counts;
  let tokensWhenDisabled: number;

  beforeAll(async () => {
    // A clone of its own: the account of this group points at a port where nothing listens yet.
    other = await createTestDatabase();
    otherPool = createPool(other.urlFor("platform"), {
      applicationName: "platform-dev-seed-test",
      logger: createLogger({ app: "platform-test", env: "test", destination: new LogSink() }),
      max: 2,
    });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...cliEnv, DATABASE_URL: other.urlFor("platform"), AMADEUS_BASE_URL_TEST: baseUrl };

    down = await cli(["dev:seed"], env);
    accountWhileDown = await testAmadeusAccount(otherPool);
    officesWhileDown = (await offices(otherPool)).length;
    afterDown = await counts(otherPool);

    lateStub = await startAmadeusStub({ port });
    up = await cli(["dev:seed"], env);
    accountWhenUp = await testAmadeusAccount(otherPool);
    afterUp = await counts(otherPool);
    tokensWhenUp = tokenRequests(lateStub);

    // An admin disables the seed's account (as adminUpdateAmadeusAccount would); the next run leaves it so.
    await otherPool.query("UPDATE platform.amadeus_accounts SET status = 'disabled' WHERE id = $1", [
      accountWhenUp?.id ?? "",
    ]);
    disabledRun = await cli(["dev:seed"], env);
    accountWhenDisabled = await testAmadeusAccount(otherPool);
    afterDisabled = await counts(otherPool);
    tokensWhenDisabled = tokenRequests(lateStub);
  }, GROUP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await lateStub?.stop();
    await otherPool?.end();
    await other?.drop();
  }, SETUP_TIMEOUT_MS);

  it("[PBE-034] leaves the account pending_verification, says to start the stub and exits 1", () => {
    expect(down.code).toBe(EXIT_FAILED);
    expect(down.stderr).toBe(
      `The test Amadeus account is pending_verification (${accountWhileDown?.last_error ?? ""}): start the ` +
        `Amadeus stub (pnpm stub:amadeus) at ${baseUrl} and run dev:seed again.\n`,
    );
    expect(accountWhileDown).toMatchObject({ status: "pending_verification", last_verified_at: null });
    expect(accountWhileDown?.last_error).toMatch(/^network error \(ECONNREFUSED\)$/);
    // The admin and the offices are in place already; the admin's secrets are shown on this run.
    expect(down.stdout).toContain("TOTP set-up URI:  otpauth://");
    expect(officesWhileDown).toBe(DEV_SEED_OFFICE_IDS.length);
  });

  it("[PBE-034] verifies the account on the next run once the stub runs, without duplicates", () => {
    expect(up.code, up.stderr).toBe(EXIT_OK);
    expect(accountWhenUp).toMatchObject({ id: accountWhileDown?.id, status: "active", last_error: null });
    expect(accountWhenUp?.last_verified_at).toBeInstanceOf(Date);
    expect(tokensWhenUp).toBe(1);
    expect(up.stdout).not.toContain("otpauth://");
    // Only the verification's audit row is new.
    expect(afterUp).toEqual({ ...afterDown, auditRows: afterDown.auditRows + 1 });
  });

  it("[PBE-034] leaves an account an admin disabled as it is, sends no token request and exits 1", () => {
    expect(disabledRun.code).toBe(EXIT_FAILED);
    expect(disabledRun.stderr).toBe(
      "The test Amadeus account is disabled: dev:seed leaves a disabled account alone; verify it in the platform " +
        "admin (Amadeus) to make it active again.\n",
    );
    expect(accountWhenDisabled).toMatchObject({ id: accountWhenUp?.id, status: "disabled" });
    expect(tokensWhenDisabled).toBe(1);
    expect(afterDisabled).toEqual(afterUp);
  });
});

describe("dev:seed with an admin@example.com account and a test Amadeus account that it did not create", () => {
  let third: TestDatabase;
  let thirdPool: PlatformPool;
  let portalAccount: PlatformRow<"accounts">;
  let configured: PlatformRow<"amadeus_accounts">;
  let run: CliRun;
  let portalAccountAfter: PlatformRow<"accounts"> | undefined;
  let accountAfter: PlatformRow<"amadeus_accounts"> | undefined;
  let officesAfter: Array<PlatformRow<"amadeus_offices">>;
  let actionsAfter: unknown[];
  let tokensBefore: number;
  let tokensAfter: number;

  beforeAll(async () => {
    // A clone of its own: someone signed up as admin@example.com in the portal (no platform admin, no MFA), and an
    // admin created the test account (another client id), whose verification is open.
    third = await createTestDatabase();
    thirdPool = createPool(third.urlFor("platform"), {
      applicationName: "platform-dev-seed-test",
      logger: createLogger({ app: "platform-test", env: "test", destination: new LogSink() }),
      max: 2,
    });
    portalAccount = await insertAccount(thirdPool, { email: DEV_SEED_ADMIN_EMAIL });
    configured = await insertAmadeusAccount(thirdPool, {
      base_url: stub.url,
      client_id: "admin-configured-client",
      status: "pending_verification",
    });
    tokensBefore = tokenRequests();
    run = await cli(["dev:seed"], { ...cliEnv, DATABASE_URL: third.urlFor("platform") });
    tokensAfter = tokenRequests();
    portalAccountAfter = await adminAccount(thirdPool);
    accountAfter = await testAmadeusAccount(thirdPool);
    officesAfter = await offices(thirdPool);
    const { rows } = await thirdPool.query<{ action: string }>(
      "SELECT action FROM platform.platform_audit_log ORDER BY id",
    );
    actionsAfter = rows.map((row) => row.action);
  }, GROUP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await thirdPool?.end();
    await third?.drop();
  }, SETUP_TIMEOUT_MS);

  it("[PBE-034] changes neither account, adds the offices to the test account's pool and says what is missing", () => {
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stderr).toBe(
      "The account admin@example.com is not an active platform admin with MFA, and dev:seed never changes an " +
        "existing account: turn MFA on in the portal, then run admin:grant for it.\n" +
        "The test Amadeus account is pending_verification and was not created by dev:seed: verify it in the " +
        "platform admin (Amadeus).\n",
    );
    expect(printedSecrets(run)).toEqual({});
    expect(portalAccountAfter).toEqual(portalAccount);
    expect(accountAfter).toEqual(configured);
    expect(tokensAfter).toBe(tokensBefore);
    expect(
      officesAfter.map((office) => [office.office_id, office.amadeus_account_id, office.status]),
    ).toEqual(DEV_SEED_OFFICE_IDS.map((officeId) => [officeId, configured.id, "available"]));
    expect(actionsAfter).toEqual(["amadeus_office.added"]);
  });
});
