// The admin bootstrap commands of dist/cli.js (PBE-028; PADR-0006 item 6, platform/docs/flows/platform-admin-
// operations.md §A item 2 and "Failure handling", scope PF-86): `admin:grant` refuses an account without MFA (and an
// unknown, unverified or inactive one) and grants a verified account with MFA, writing one audit row with
// `actor_type = 'system'`; the new admin then signs in to the platform admin. `admin:reset-mfa` turns MFA off for a
// platform admin, deletes its recovery codes, revokes every session family, writes `staffdeny`, e-mails the account and
// writes one audit row; it refuses accounts that are not admins. Wrong arguments and an invalid configuration exit
// with their codes without echoing what was typed.
//
// The commands run in-process through `runCli` (the dispatcher of dist/cli.js) with the configuration of this file's
// database clone and Redis database (`CliOptions.env`), each in its own application context (the real Clock), as
// `node dist/cli.js` runs them: `pnpm test:int` runs before the build, so the compiled file is not used here. The API
// (createTestApp) arranges and checks sessions on the same clone. Every command runs in a setup hook with an explicit
// bound; the tests then check what happened.
import { sha256Hex } from "@velexis/crypto";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountSecretPlace,
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  totpCode,
} from "../../../src/accounts/mfa.service";
import { defaultOperator } from "../../../src/admin/admin-cli.commands";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli } from "../../../src/cli";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { redisKeys, STAFF_DENY_ACCOUNT_TTL_SECONDS } from "../../../src/common/redis/redis-keys";
import { TEST_PASSWORD } from "../../builders/accounts";
import { insertAccount, type AccountRow, type PlatformRow } from "../../builders/platform-rows";
import { createTestApp, TEST_BFF_KEY, TEST_STOREFRONT_BASE_DOMAIN, type TestApp } from "../../support/app";
import { createTestJwtKeyFile, type TestKeyFile } from "../../support/jwt-key";
import {
  createTestMasterKeyDir,
  testCryptoAndMailEnv,
  type TestMasterKeyDir,
} from "../../support/master-key";

/**
 * Starting the API on a database clone and parsing the platform document take about two seconds alone; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few CLI runs (an application context each) and sign-ins; seconds at most, bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 90_000;
/** How long a test waits for the invalidation event of a commit. */
const WAIT_MS = 10_000;

const STEP_MS = 30 * 1000;

let t: TestApp;
let pool: PlatformPool;
let envelope: EnvelopeService;
let jwtKey: TestKeyFile;
let masterKeys: TestMasterKeyDir;
let subscriber: Redis;
/** The Argon2id hash of TEST_PASSWORD, made once and shared by the accounts of this file. */
let passwordHash: string;
/** The configuration of the CLI runs: this file's clone and Redis database, key files of its own. */
let cliEnv: Record<string, string>;
/** The `account` invalidations this file's accounts received. */
const invalidated: InvalidationEvent[] = [];
const accountsOfThisFile = new Set<string>();

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

/** An account that signs in with TEST_PASSWORD (active and verified unless `overrides` say otherwise). */
async function insertSignInAccount(overrides: Partial<AccountRow> = {}): Promise<PlatformRow<"accounts">> {
  const account = await insertAccount(pool, { password_hash: passwordHash, ...overrides });
  accountsOfThisFile.add(account.id);
  return account;
}

/** An account with MFA on: its TOTP secret (encrypted as MfaService stores it) and its recovery codes. */
interface MfaFixture {
  readonly account: PlatformRow<"accounts">;
  readonly secret: string;
}

async function insertMfaAccount(overrides: Partial<AccountRow> = {}): Promise<MfaFixture> {
  const created = await insertSignInAccount(overrides);
  const secret = generateTotpSecret();
  const { ciphertext, kekId } = await envelope.encrypt(secret, accountSecretPlace(created.id));
  await pool.query(
    "UPDATE platform.accounts SET mfa_enabled = true, mfa_enabled_at = $2, mfa_secret_ciphertext = $3, " +
      "encryption_key_id = $4 WHERE id = $1",
    [created.id, t.clock.now(), Buffer.from(ciphertext), kekId],
  );
  for (const code of generateRecoveryCodes()) {
    await pool.query(
      "INSERT INTO platform.account_recovery_codes (account_id, code_hash, created_at) VALUES ($1, $2, $3)",
      [created.id, sha256Hex(normaliseRecoveryCode(code) ?? ""), t.clock.now()],
    );
  }
  return { account: await accountRow(created.id), secret };
}

async function accountRow(accountId: string): Promise<PlatformRow<"accounts">> {
  const { rows } = await pool.query("SELECT * FROM platform.accounts WHERE id = $1", [accountId]);
  return rows[0] as PlatformRow<"accounts">;
}

/** The audit rows of `action` about `targetId`, oldest first. */
async function auditRows(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, actor_label, target_type, target_id, tenant_id, request_id, ip_address, " +
      "user_agent, details FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

async function sessionsOf(accountId: string): Promise<Array<PlatformRow<"account_sessions">>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.account_sessions WHERE account_id = $1 ORDER BY created_at, id",
    [accountId],
  );
  return rows as Array<PlatformRow<"account_sessions">>;
}

async function recoveryCodeCount(accountId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM platform.account_recovery_codes WHERE account_id = $1",
    [accountId],
  );
  return rows[0]?.n ?? 0;
}

/** Waits for the `account` invalidation of `accountId`. */
async function invalidationOf(accountId: string): Promise<InvalidationEvent> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const event = invalidated.find(
      (candidate) => "accountId" in candidate && candidate.accountId === accountId,
    );
    if (event !== undefined) {
      return event;
    }
    if (Date.now() > deadline) {
      throw new Error(`no account invalidation of ${accountId} within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** `<status>` of a success, or `<status> <code>` of an error answer. */
function outcomeOf(res: Response): string {
  return res.status < 300
    ? String(res.status)
    : `${res.status} ${(res.body as { error: { code: string } }).error.code}`;
}

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  envelope = t.app.get(EnvelopeService);
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  jwtKey = createTestJwtKeyFile();
  masterKeys = createTestMasterKeyDir();
  cliEnv = {
    APP_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL: t.db.urlFor("platform"),
    REDIS_URL: t.redis.url,
    PLATFORM_BFF_KEY: TEST_BFF_KEY,
    JWT_PRIVATE_KEY_FILE: jwtKey.path,
    ...testCryptoAndMailEnv(masterKeys),
    STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
  };
  // Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same
  // time, so only the events about this file's accounts are kept.
  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-admin-cli-test" });
  subscriber.on("message", (channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (
      channel === INVALIDATION_CHANNEL &&
      event.type === "account" &&
      accountsOfThisFile.has(event.accountId)
    ) {
      invalidated.push(event);
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
  jwtKey?.remove();
  masterKeys?.remove();
}, SETUP_TIMEOUT_MS);

describe("admin:grant", () => {
  const ip = "203.0.113.180";
  let withoutMfa: PlatformRow<"accounts">;
  let unverified: MfaFixture;
  let disabled: MfaFixture;
  let eligible: MfaFixture;
  let byDefaultOperator: MfaFixture;
  let refusedNoMfa: CliRun;
  let refusedUnknown: CliRun;
  let refusedUnverified: CliRun;
  let refusedDisabled: CliRun;
  let granted: CliRun;
  let grantedAgain: CliRun;
  let grantedByDefault: CliRun;
  let adminSignIn: Response;
  let adminVerify: Response;

  beforeAll(async () => {
    withoutMfa = await insertSignInAccount({ email: "no-mfa.person@example.com" });
    unverified = await insertMfaAccount({ status: "pending_verification", email_verified_at: null });
    disabled = await insertMfaAccount({ status: "disabled" });
    eligible = await insertMfaAccount({ email: "Lena.Holm@example.com", full_name: "Lena Holm" });
    byDefaultOperator = await insertMfaAccount();

    refusedNoMfa = await cli(["admin:grant", withoutMfa.email, "--operator", "Developer One"]);
    refusedUnknown = await cli(["admin:grant", "nobody.here@example.com"]);
    refusedUnverified = await cli(["admin:grant", unverified.account.email]);
    refusedDisabled = await cli(["admin:grant", disabled.account.email]);
    granted = await cli(["admin:grant", "--operator", "Developer One", "lena.holm@EXAMPLE.com"]);
    grantedAgain = await cli(["admin:grant", eligible.account.email, "--operator", "Developer One"]);
    grantedByDefault = await cli(["admin:grant", byDefaultOperator.account.email]);

    // The new admin signs in to the platform admin.
    adminSignIn = await t.http
      .post("/v1/admin/auth/sign-in")
      .set(t.bffHeaders(ip))
      .send({ email: eligible.account.email, password: TEST_PASSWORD });
    adminVerify = await t.http
      .post("/v1/admin/auth/mfa/verify")
      .set(t.bffHeaders(ip))
      .send({
        mfaChallengeToken: (adminSignIn.body as { mfaChallengeToken?: string }).mfaChallengeToken ?? "",
        code: totpCode(eligible.secret, t.clock.now()),
      });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-028 AC3] refuses an account without MFA: exit 1 with a message, nothing changed, no audit row [PF-86]", async () => {
    expect(refusedNoMfa.code).toBe(EXIT_FAILED);
    expect(refusedNoMfa.stdout).toBe("");
    expect(refusedNoMfa.stderr).toBe(
      "The account no-mfa.person@example.com has no MFA; nothing changed. The person turns MFA on in the portal " +
        "first (Account, Security), then run admin:grant again.\n",
    );
    const row = await accountRow(withoutMfa.id);
    expect(row).toMatchObject({ is_platform_admin: false, version: withoutMfa.version });
    expect(await auditRows("admin.granted", withoutMfa.id)).toEqual([]);
  });

  it("refuses an unknown, unverified or inactive account with exit 1, changing nothing", async () => {
    expect([refusedUnknown, refusedUnverified, refusedDisabled].map((run) => run.code)).toEqual([
      EXIT_FAILED,
      EXIT_FAILED,
      EXIT_FAILED,
    ]);
    expect(refusedUnknown.stderr).toBe(
      "No account has the e-mail address nobody.here@example.com; nothing changed.\n",
    );
    expect(refusedUnverified.stderr).toMatch(
      /^The account \S+ has not verified its e-mail address; nothing changed\./,
    );
    expect(refusedDisabled.stderr).toBe(
      `The account ${disabled.account.email} is not active; nothing changed.\n`,
    );
    for (const fixture of [unverified, disabled]) {
      expect((await accountRow(fixture.account.id)).is_platform_admin).toBe(false);
      expect(await auditRows("admin.granted", fixture.account.id)).toEqual([]);
    }
  });

  it("[PBE-028 AC3] grants a verified account with MFA, writing one audit row as system with the operator [PF-86]", async () => {
    expect(granted.code).toBe(EXIT_OK);
    expect(granted.stderr).toBe("");
    expect(granted.stdout).toBe(
      `lena.holm@EXAMPLE.com (${eligible.account.id}) is now a platform admin; one audit row admin.granted was ` +
        "written.\n",
    );
    const row = await accountRow(eligible.account.id);
    expect(row).toMatchObject({ is_platform_admin: true, version: eligible.account.version + 1 });
    expect(await auditRows("admin.granted", eligible.account.id)).toEqual([
      {
        actor_type: "system",
        actor_account_id: null,
        actor_label: "cli admin:grant by Developer One",
        target_type: "account",
        target_id: eligible.account.id,
        tenant_id: null,
        request_id: null,
        ip_address: null,
        user_agent: null,
        details: {
          command: "admin:grant",
          operator: "Developer One",
          before: { isPlatformAdmin: false },
          after: { isPlatformAdmin: true },
        },
      },
    ]);
  });

  it("[PBE-028 AC3] a second grant changes nothing and writes no second audit row", async () => {
    expect(grantedAgain.code).toBe(EXIT_OK);
    expect(grantedAgain.stdout).toBe(
      `${eligible.account.email} (${eligible.account.id}) is a platform admin already; nothing changed.\n`,
    );
    expect((await accountRow(eligible.account.id)).version).toBe(eligible.account.version + 1);
    expect(await auditRows("admin.granted", eligible.account.id)).toHaveLength(1);
  });

  it("names the user who ran it as the operator when --operator is not given", async () => {
    expect(grantedByDefault.code).toBe(EXIT_OK);
    const [audit] = await auditRows("admin.granted", byDefaultOperator.account.id);
    expect(audit?.["actor_label"]).toBe(`cli admin:grant by ${defaultOperator()}`);
  });

  it("[PBE-028 AC3] the granted account signs in to the platform admin with its TOTP code [PF-80]", () => {
    expectResponseToMatch("adminSignIn", adminSignIn, { document: "platform" });
    expect(outcomeOf(adminSignIn)).toBe("200");
    expectResponseToMatch("adminVerifyMfa", adminVerify, { document: "platform" });
    expect(outcomeOf(adminVerify)).toBe("200");
    expect((adminVerify.body as { admin: { id: string } }).admin.id).toBe(eligible.account.id);
  });
});

describe("arguments and configuration", () => {
  let missing: CliRun;
  let notAnAddress: CliRun;
  let twoAddresses: CliRun;
  let operatorWithoutName: CliRun;
  let unknownFlag: CliRun;
  let resetWithoutAddress: CliRun;
  let badConfig: CliRun;

  beforeAll(async () => {
    missing = await cli(["admin:grant"]);
    notAnAddress = await cli(["admin:grant", "Secret-Value 1!"]);
    twoAddresses = await cli(["admin:grant", "one@example.com", "two@example.com"]);
    operatorWithoutName = await cli(["admin:grant", "one@example.com", "--operator"]);
    unknownFlag = await cli(["admin:grant", "one@example.com", "--force"]);
    resetWithoutAddress = await cli(["admin:reset-mfa"]);
    badConfig = await cli(["admin:grant", "one@example.com"], {
      ...cliEnv,
      DATABASE_URL: "not-a-dsn-Secret-Config-Value",
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("exits 2 with the command's usage for wrong arguments, never echoing them", () => {
    for (const run of [missing, notAnAddress, twoAddresses, operatorWithoutName, unknownFlag]) {
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(
        /^admin:grant: .+\.\nUsage: node dist\/cli\.js admin:grant <email> \[--operator <name>\]\n$/,
      );
    }
    expect(notAnAddress.stderr).not.toContain("Secret-Value");
    expect(twoAddresses.stderr).not.toContain("two@example.com");
    expect(resetWithoutAddress.code).toBe(EXIT_USAGE);
    expect(resetWithoutAddress.stderr).toContain(
      "Usage: node dist/cli.js admin:reset-mfa <email> [--operator <name>]",
    );
  });

  it("exits 1 for an invalid configuration, naming the variable and never its value", () => {
    expect(badConfig.code).toBe(EXIT_FAILED);
    expect(badConfig.stdout).toBe("");
    expect(badConfig.stderr).toMatch(/^The configuration is invalid:\n/);
    expect(badConfig.stderr).toContain("DATABASE_URL");
    expect(badConfig.stderr).not.toContain("Secret-Config-Value");
  });
});

describe("admin:reset-mfa", () => {
  const ip = "203.0.113.181";
  let admin: MfaFixture;
  let portalPerson: MfaFixture;
  let adminWithoutMfa: PlatformRow<"accounts">;
  let adminRefreshToken: string;
  let startedAt: number;
  let finishedAt: number;
  let reset: CliRun;
  let refusedPortalPerson: CliRun;
  let nothingToReset: CliRun;
  let refusedUnknown: CliRun;
  let refreshAfterReset: Response;
  let signInAfterReset: Response;
  let staffDeny: string | null;
  let staffDenyTtl: number;

  beforeAll(async () => {
    admin = await insertMfaAccount({ is_platform_admin: true, full_name: "Ola Admin" });
    portalPerson = await insertMfaAccount();
    adminWithoutMfa = await insertSignInAccount({ is_platform_admin: true });

    // The admin holds an admin session and a portal session.
    const challenge = await t.http
      .post("/v1/admin/auth/sign-in")
      .set(t.bffHeaders(ip))
      .send({ email: admin.account.email, password: TEST_PASSWORD });
    const session = await t.http
      .post("/v1/admin/auth/mfa/verify")
      .set(t.bffHeaders(ip))
      .send({
        mfaChallengeToken: (challenge.body as { mfaChallengeToken: string }).mfaChallengeToken,
        code: totpCode(admin.secret, t.clock.now()),
      });
    adminRefreshToken = (session.body as { refreshToken: string }).refreshToken;
    t.clock.advance(STEP_MS);
    const portalChallenge = await t.http
      .post("/v1/auth/sign-in")
      .set(t.bffHeaders(ip))
      .send({ email: admin.account.email, password: TEST_PASSWORD });
    await t.http
      .post("/v1/auth/mfa/verify")
      .set(t.bffHeaders(ip))
      .send({
        mfaChallengeToken: (portalChallenge.body as { mfaChallengeToken: string }).mfaChallengeToken,
        code: totpCode(admin.secret, t.clock.now()),
      });

    startedAt = Date.now();
    reset = await cli(["admin:reset-mfa", admin.account.email, "--operator", "Developer One"]);
    finishedAt = Date.now();
    const staffDenyKey = redisKeys.staffDenyAccount(admin.account.id).key;
    staffDeny = await t.redis.client.get(staffDenyKey);
    staffDenyTtl = await t.redis.client.ttl(staffDenyKey);
    refusedPortalPerson = await cli(["admin:reset-mfa", portalPerson.account.email]);
    nothingToReset = await cli(["admin:reset-mfa", adminWithoutMfa.email]);
    refusedUnknown = await cli(["admin:reset-mfa", "nobody.there@example.com"]);

    refreshAfterReset = await t.http
      .post("/v1/admin/auth/refresh")
      .set(t.bffHeaders(ip))
      .send({ refreshToken: adminRefreshToken });
    signInAfterReset = await t.http
      .post("/v1/admin/auth/sign-in")
      .set(t.bffHeaders(ip))
      .send({ email: admin.account.email, password: TEST_PASSWORD });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("turns MFA off, deletes the recovery codes and revokes every session of the admin", async () => {
    expect(reset.code).toBe(EXIT_OK);
    expect(reset.stderr).toBe("");
    expect(reset.stdout).toMatch(
      new RegExp(
        `^The MFA of ${admin.account.email.replace(/\./g, "\\.")} \\(${admin.account.id}\\) is reset: `,
      ),
    );
    expect(await accountRow(admin.account.id)).toMatchObject({
      is_platform_admin: true,
      mfa_enabled: false,
      mfa_enabled_at: null,
      mfa_secret_ciphertext: null,
      encryption_key_id: null,
      version: admin.account.version + 1,
    });
    expect(await recoveryCodeCount(admin.account.id)).toBe(0);
    const sessions = await sessionsOf(admin.account.id);
    expect(new Set(sessions.map((row) => row.audience))).toEqual(new Set(["portal", "platform_admin"]));
    expect(sessions.every((row) => row.revoked_at !== null && row.revoke_reason === "admin")).toBe(true);
    expect(outcomeOf(refreshAfterReset)).toBe("401 REFRESH_TOKEN_INVALID");
    // Until MFA is on again, the admin cannot sign in to the platform admin.
    expectResponseToMatch("adminSignIn", signInAfterReset, { document: "platform" });
    expect(outcomeOf(signInAfterReset)).toBe("403 MFA_REQUIRED");
  });

  it("writes the OTA cut-off staffdeny, e-mails the account and publishes an account invalidation", async () => {
    expect(Number(staffDeny)).toBeGreaterThanOrEqual(startedAt);
    expect(Number(staffDeny)).toBeLessThanOrEqual(finishedAt);
    expect(staffDenyTtl).toBeGreaterThan(0);
    expect(staffDenyTtl).toBeLessThanOrEqual(STAFF_DENY_ACCOUNT_TTL_SECONDS);
    const { rows } = await pool.query(
      "SELECT template, to_email, data FROM platform.email_outbox WHERE account_id = $1",
      [admin.account.id],
    );
    expect(rows).toEqual([
      {
        template: "auth.mfa_changed",
        to_email: admin.account.email,
        data: { fullName: "Ola Admin", change: "it was turned off" },
      },
    ]);
    expect(await invalidationOf(admin.account.id)).toEqual({
      v: 1,
      type: "account",
      accountId: admin.account.id,
    });
  });

  it("writes one audit row account.mfa_reset as system with the operator", async () => {
    const [audit, ...more] = await auditRows("account.mfa_reset", admin.account.id);
    expect(more).toEqual([]);
    expect(audit).toMatchObject({
      actor_type: "system",
      actor_account_id: null,
      actor_label: "cli admin:reset-mfa by Developer One",
      target_type: "account",
      ip_address: null,
      details: {
        command: "admin:reset-mfa",
        operator: "Developer One",
        recoveryCodesRemoved: 10,
        revokedFamilies: 2,
        staffDenyFrom: new Date(Number(staffDeny)).toISOString(),
        before: { mfaEnabled: true },
        after: { mfaEnabled: false },
      },
    });
  });

  it("refuses an account that is not a platform admin, and leaves an admin without MFA as it is", async () => {
    expect(refusedPortalPerson.code).toBe(EXIT_FAILED);
    expect(refusedPortalPerson.stderr).toMatch(/is not a platform admin; nothing changed\./);
    expect(await accountRow(portalPerson.account.id)).toMatchObject({ mfa_enabled: true });
    expect(await recoveryCodeCount(portalPerson.account.id)).toBe(10);
    expect(nothingToReset.code).toBe(EXIT_OK);
    expect(nothingToReset.stdout).toBe(
      `${adminWithoutMfa.email} (${adminWithoutMfa.id}) has no MFA to reset; nothing changed.\n`,
    );
    expect(refusedUnknown.code).toBe(EXIT_FAILED);
    for (const accountId of [portalPerson.account.id, adminWithoutMfa.id]) {
      expect(await auditRows("account.mfa_reset", accountId)).toEqual([]);
      expect(await t.redis.client.exists(redisKeys.staffDenyAccount(accountId).key)).toBe(0);
    }
  });
});
