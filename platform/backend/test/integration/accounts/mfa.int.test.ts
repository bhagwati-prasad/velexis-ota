// TOTP MFA, recovery codes and the step-up (PBE-015; scope PF-04, PADR-0008 "MFA", api-inventory §4 and §5) through
// the HTTP pipeline (createTestApp) on this file's database clone and Redis database: the set-up and enabling with the
// ten recovery codes shown once, the expired set-up, the sign-in challenge completed with a TOTP code or an unused
// recovery code, a replayed code, the fifth wrong code that ends the challenge, the per-account limit, the step-up of
// the same family, disabling and regenerating behind a fresh step-up, the platform admin who cannot disable MFA, and no
// TOTP secret, code or recovery code in any log line, queue payload, audit row or outbox row. Every answer is checked
// against the platform document.
//
// Accounts that already have MFA are written as rows with a TOTP secret and recovery codes the test knows (the secret
// encrypted with the application's own EnvelopeService and the associated data of PBE-015, the codes stored as their
// SHA-256), so each group needs only its own sign-ins (Argon2id). The codes are computed at the FakeClock's time, as
// an authenticator app would compute them; the platform accepts each time step once per account, so a group that needs
// a second code moves the clock first. Each group signs in from an end-user IP of its own (RFC 5737), and each account
// is used by one group only, so the per-IP sign-in limit and the per-account MFA limit of one group never touch
// another.
import { DecryptionError, sha256Hex } from "@velexis/crypto";
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
  totpStep,
} from "../../../src/accounts/mfa.service";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { TokenService, type AccessTokenClaims } from "../../../src/auth/token.service";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { redisKeys } from "../../../src/common/redis/redis-keys";
import { TEST_PASSWORD } from "../../builders/accounts";
import { insertAccount, type AccountRow, type PlatformRow } from "../../builders/platform-rows";
import { createTestApp, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and parsing the platform document take about two seconds alone; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few sign-ins (Argon2id verifications) and MFA calls; seconds at most, bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the invalidation event of a commit. */
const WAIT_MS = 10_000;

const MINUTE_MS = 60 * 1000;
const STEP_MS = 30 * 1000;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0";

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let envelope: EnvelopeService;
let subscriber: Redis;
/** The Argon2id hash of TEST_PASSWORD, made once and shared by the accounts of this file. */
let passwordHash: string;
/** The `account` invalidations this file's accounts received. */
const invalidated: InvalidationEvent[] = [];
const accountsOfThisFile = new Set<string>();

/**
 * Every TOTP secret, `otpauth://` URI, recovery code (as shown and normalised), challenge token, access and refresh
 * token and password of this file, for the scan of AC4. The six-digit codes are not in it: six digits occur in any
 * log line's time.
 */
const secrets = new Set<string>([TEST_PASSWORD]);

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each group of calls, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${150 + ipCounter}`;
}

/** Notes every secret an answer carries. */
function remember(res: Response): Response {
  const body = res.body as Record<string, unknown>;
  for (const field of ["accessToken", "refreshToken", "mfaChallengeToken", "secret", "otpauthUrl"]) {
    if (typeof body[field] === "string") {
      secrets.add(body[field]);
    }
  }
  if (Array.isArray(body["recoveryCodes"])) {
    for (const code of body["recoveryCodes"] as string[]) {
      rememberRecoveryCode(code);
    }
  }
  return res;
}

function rememberRecoveryCode(code: string): void {
  secrets.add(code);
  secrets.add(normaliseRecoveryCode(code) ?? code);
}

/** A POST of the end user at `ip`, with the access token when there is one. */
async function post(ip: string, path: string, accessToken?: string, body?: object): Promise<Response> {
  const headers = {
    ...t.bffHeaders(ip, USER_AGENT),
    ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
  };
  const request = t.http.post(path).set(headers);
  return remember(await (body === undefined ? request : request.send(body)));
}

/** The error envelope, as far as the tests read it. */
interface ErrorBody {
  readonly error: { readonly code: string; readonly requestId: string; readonly details?: unknown };
}

/** `<status> <code>` of an error answer, with the request id in the body and the header. */
function failure(res: Response): string {
  const { error } = res.body as ErrorBody;
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return `${res.status} ${error.code}`;
}

/** The tokens of a PortalSession answer, as far as the tests read them. */
interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly account: { readonly id: string; readonly mfaEnabled: boolean };
}

/** A six-digit string that is not the code of `secret` in the steps around the FakeClock's time. */
function wrongCode(secret: string): string {
  const now = t.clock.now().getTime();
  const valid = new Set([-1, 0, 1].map((delta) => totpCode(secret, new Date(now + delta * STEP_MS))));
  for (let candidate = 123456; ; candidate += 1) {
    const code = String(candidate % 1_000_000).padStart(6, "0");
    if (!valid.has(code)) {
      return code;
    }
  }
}

/** The code of `secret` at the FakeClock's time. */
function currentCode(secret: string): string {
  return totpCode(secret, t.clock.now());
}

/** An active, verified account that signs in with TEST_PASSWORD and has no MFA. */
async function insertSignInAccount(overrides: Partial<AccountRow> = {}): Promise<PlatformRow<"accounts">> {
  const account = await insertAccount(pool, { password_hash: passwordHash, ...overrides });
  accountsOfThisFile.add(account.id);
  return account;
}

/** An account with MFA on: its TOTP secret (encrypted as MfaService stores it) and its ten recovery codes. */
interface MfaAccountFixture {
  readonly account: PlatformRow<"accounts">;
  readonly secret: string;
  readonly codes: readonly string[];
}

async function insertMfaAccount(overrides: Partial<AccountRow> = {}): Promise<MfaAccountFixture> {
  const account = await insertSignInAccount(overrides);
  const secret = generateTotpSecret();
  secrets.add(secret);
  const { ciphertext, kekId } = await envelope.encrypt(secret, accountSecretPlace(account.id));
  await pool.query(
    "UPDATE platform.accounts SET mfa_enabled = true, mfa_enabled_at = $2, mfa_secret_ciphertext = $3, " +
      "encryption_key_id = $4 WHERE id = $1",
    [account.id, t.clock.now(), Buffer.from(ciphertext), kekId],
  );
  const codes = generateRecoveryCodes();
  for (const code of codes) {
    rememberRecoveryCode(code);
    await pool.query(
      "INSERT INTO platform.account_recovery_codes (account_id, code_hash, created_at) VALUES ($1, $2, $3)",
      [account.id, sha256Hex(normaliseRecoveryCode(code) ?? ""), t.clock.now()],
    );
  }
  return { account, secret, codes };
}

async function signIn(ip: string, account: Pick<PlatformRow<"accounts">, "email">): Promise<Response> {
  return post(ip, "/v1/auth/sign-in", undefined, { email: account.email, password: TEST_PASSWORD });
}

/** Signs in with the password and answers the challenge token of an account with MFA. */
async function challengeOf(ip: string, account: Pick<PlatformRow<"accounts">, "email">): Promise<string> {
  const res = await signIn(ip, account);
  const { mfaChallengeToken } = res.body as { mfaChallengeToken?: string };
  if (res.status !== 200 || mfaChallengeToken === undefined) {
    throw new Error(`the sign-in answered ${res.status} without a challenge`);
  }
  return mfaChallengeToken;
}

function verifyMfa(ip: string, body: object): Promise<Response> {
  return post(ip, "/v1/auth/mfa/verify", undefined, body);
}

/** Signs in with the password and the current TOTP code: the session of an MFA sign-in. */
async function signInWithMfa(ip: string, fixture: MfaAccountFixture): Promise<Session> {
  const mfaChallengeToken = await challengeOf(ip, fixture.account);
  const res = await verifyMfa(ip, { mfaChallengeToken, code: currentCode(fixture.secret) });
  if (res.status !== 200) {
    throw new Error(`verifyMfa answered ${res.status}`);
  }
  return res.body as Session;
}

async function claimsOf(res: Response): Promise<AccessTokenClaims> {
  return tokens.verify((res.body as Session).accessToken, "portal");
}

async function accountRow(accountId: string): Promise<PlatformRow<"accounts">> {
  const { rows } = await pool.query("SELECT * FROM platform.accounts WHERE id = $1", [accountId]);
  return rows[0] as PlatformRow<"accounts">;
}

async function recoveryCodeRows(accountId: string): Promise<Array<PlatformRow<"account_recovery_codes">>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.account_recovery_codes WHERE account_id = $1 ORDER BY code_hash",
    [accountId],
  );
  return rows as Array<PlatformRow<"account_recovery_codes">>;
}

/** How many session rows (generations of every family) the account has. */
async function sessionCount(accountId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM platform.account_sessions WHERE account_id = $1",
    [accountId],
  );
  return rows[0]?.n ?? 0;
}

async function familyOf(familyId: string): Promise<Array<PlatformRow<"account_sessions">>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.account_sessions WHERE family_id = $1 ORDER BY created_at, id",
    [familyId],
  );
  return rows as Array<PlatformRow<"account_sessions">>;
}

/** The audit rows of `action` about `targetId`, oldest first. */
async function auditRows(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, target_type, target_id, request_id, details " +
      "FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

/** The outbox rows of an account, oldest first. */
async function outboxOf(accountId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT template, to_email, data FROM platform.email_outbox WHERE account_id = $1 ORDER BY created_at, id",
    [accountId],
  );
  return rows as Array<Record<string, unknown>>;
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

const RECOVERY_CODE =
  /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

beforeAll(async () => {
  // Every line at every level is captured, so "no log line holds a secret" covers debug and trace too.
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  envelope = t.app.get(EnvelopeService);
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  // Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same
  // time, so only the events about this file's accounts are kept.
  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-mfa-test" });
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
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("set-up and enabling", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let accessToken: string;
  let replaced: Response;
  let setup: Response;
  let pendingValue: string | null;
  let pendingTtlMs: number;
  let withReplacedSecret: Response;
  let withWrongCode: Response;
  let enabled: Response;
  let enabledAt: Date;
  let pendingAfterEnable: number;
  let enabledAgain: Response;
  let setupWhileOn: Response;

  beforeAll(async () => {
    account = await insertSignInAccount({ full_name: "Ingrid Fjell" });
    accessToken = ((await signIn(ip, account)).body as Session).accessToken;
    replaced = await post(ip, "/v1/me/mfa/setup", accessToken);
    // A second set-up replaces the first pending secret.
    setup = await post(ip, "/v1/me/mfa/setup", accessToken);
    const pendingKey = redisKeys.mfaSetup(account.id).key;
    pendingValue = await t.redis.client.get(pendingKey);
    pendingTtlMs = await t.redis.client.pttl(pendingKey);
    t.clock.advance(MINUTE_MS);
    const { secret } = setup.body as { secret: string };
    const { secret: replacedSecret } = replaced.body as { secret: string };
    withReplacedSecret = await post(ip, "/v1/me/mfa/enable", accessToken, {
      code: currentCode(replacedSecret),
    });
    withWrongCode = await post(ip, "/v1/me/mfa/enable", accessToken, { code: wrongCode(secret) });
    enabledAt = t.clock.now();
    enabled = await post(ip, "/v1/me/mfa/enable", accessToken, { code: currentCode(secret) });
    pendingAfterEnable = await t.redis.client.exists(pendingKey);
    t.clock.advance(STEP_MS);
    enabledAgain = await post(ip, "/v1/me/mfa/enable", accessToken, { code: currentCode(secret) });
    setupWhileOn = await post(ip, "/v1/me/mfa/setup", accessToken);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-015 AC1] set-up returns a base32 secret and its otpauth URI, kept encrypted in Redis for 10 minutes [PF-04 AC1]", () => {
    for (const res of [replaced, setup]) {
      expectResponseToMatch("startMfaSetup", res, { document: "platform" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const body = setup.body as { secret: string; otpauthUrl: string; expiresIn: number };
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.secret).not.toBe((replaced.body as { secret: string }).secret);
    expect(body.expiresIn).toBe(600);
    const uri = new URL(body.otpauthUrl);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.hostname).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe(`/Velexis:${account.email}`);
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: body.secret,
      issuer: "Velexis",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });

    // The pending secret: an envelope (never the secret in clear), with the set-up's start, for at most 10 minutes.
    expect(JSON.parse(pendingValue ?? "null")).toEqual({
      v: 1,
      ciphertext: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/) as string,
      createdAt: enabledAt.getTime() - MINUTE_MS,
    });
    expect(pendingValue).not.toContain(body.secret);
    expect(pendingTtlMs).toBeGreaterThan(0);
    expect(pendingTtlMs).toBeLessThanOrEqual(600_000);
  });

  it("[PBE-015 AC1] enabling with a valid code returns 10 recovery codes once and stores the secret encrypted [PF-04 AC1]", async () => {
    expectResponseToMatch("enableMfa", enabled, { document: "platform" });
    expect(enabled.status).toBe(200);
    expect(enabled.headers["cache-control"]).toBe("no-store");
    const { recoveryCodes } = enabled.body as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(RECOVERY_CODE);
    }

    const row = await accountRow(account.id);
    expect(row).toMatchObject({
      mfa_enabled: true,
      mfa_enabled_at: enabledAt,
      encryption_key_id: "local:v1",
      version: account.version + 1,
    });
    // The secret of the set-up, bound to this account's column: another row's associated data cannot open it.
    const ciphertext = row.mfa_secret_ciphertext ?? Buffer.alloc(0);
    expect(ciphertext.includes(Buffer.from((setup.body as { secret: string }).secret))).toBe(false);
    expect((await envelope.decrypt(ciphertext, accountSecretPlace(account.id))).toString("utf8")).toBe(
      (setup.body as { secret: string }).secret,
    );
    await expect(
      envelope.decrypt(ciphertext, accountSecretPlace("acc_01JA2ZA1C5E9G3J7K2M6P00000")),
    ).rejects.toBeInstanceOf(DecryptionError);

    // Only the SHA-256 of each normalised code is stored, all unused.
    const stored = await recoveryCodeRows(account.id);
    expect(stored.map((code) => code.code_hash).sort()).toEqual(
      recoveryCodes.map((code) => sha256Hex(code.replaceAll("-", ""))).sort(),
    );
    expect(stored.every((code) => code.used_at === null)).toBe(true);

    // The pending secret is gone; the account is told, audited and invalidated.
    expect(pendingAfterEnable).toBe(0);
    expect(await outboxOf(account.id)).toEqual([
      {
        template: "auth.mfa_changed",
        to_email: account.email,
        data: { fullName: "Ingrid Fjell", change: "it was turned on" },
      },
    ]);
    expect(await auditRows("account.mfa_enabled", account.id)).toEqual([
      {
        actor_type: "account",
        actor_account_id: account.id,
        target_type: "account",
        target_id: account.id,
        request_id: enabled.headers["x-request-id"],
        details: {
          recoveryCodeCount: 10,
          after: { mfaEnabled: true, mfaEnabledAt: enabledAt.toISOString() },
        },
      },
    ]);
    expect(await invalidationOf(account.id)).toEqual({ v: 1, type: "account", accountId: account.id });
  });

  it("refuses a code of the replaced secret or a wrong code, and a set-up that was used or while MFA is on", () => {
    for (const res of [withReplacedSecret, withWrongCode, enabledAgain]) {
      expectResponseToMatch("enableMfa", res, { document: "platform" });
    }
    expect(failure(withReplacedSecret)).toBe("401 MFA_CODE_INVALID");
    expect(failure(withWrongCode)).toBe("401 MFA_CODE_INVALID");
    expect(failure(enabledAgain)).toBe("400 MFA_SETUP_EXPIRED");
    expectResponseToMatch("startMfaSetup", setupWhileOn, { document: "platform" });
    expect(failure(setupWhileOn)).toBe("409 MFA_ALREADY_ENABLED");
  });
});

describe("an account that waits for e-mail verification, and an expired set-up", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let withoutSetup: Response;
  let setup: Response;
  let expired: Response;

  beforeAll(async () => {
    account = await insertSignInAccount({ status: "pending_verification", email_verified_at: null });
    const { accessToken } = (await signIn(ip, account)).body as Session;
    withoutSetup = await post(ip, "/v1/me/mfa/enable", accessToken, { code: "123456" });
    setup = await post(ip, "/v1/me/mfa/setup", accessToken);
    // Ten minutes later the pending secret has expired, whatever Redis still holds.
    t.clock.advance(10 * MINUTE_MS);
    expired = await post(ip, "/v1/me/mfa/enable", accessToken, {
      code: currentCode((setup.body as { secret: string }).secret),
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("sets MFA up for an unverified account (portal_unverified) and answers MFA_SETUP_EXPIRED after 10 minutes", async () => {
    expectResponseToMatch("startMfaSetup", setup, { document: "platform" });
    expect(setup.status).toBe(200);
    for (const res of [withoutSetup, expired]) {
      expectResponseToMatch("enableMfa", res, { document: "platform" });
      expect(failure(res)).toBe("400 MFA_SETUP_EXPIRED");
    }
    expect(await accountRow(account.id)).toMatchObject({ mfa_enabled: false, mfa_secret_ciphertext: null });
    expect(await recoveryCodeRows(account.id)).toEqual([]);
  });
});

describe("sign-in with MFA: a TOTP code, a replayed code and recovery codes", () => {
  const ip = nextIp();
  let fixture: MfaAccountFixture;
  let passwordAnswer: Response;
  let sessionsAfterPassword: number;
  let firstChallenge: string;
  let withTotp: Response;
  let verifiedAt: Date;
  let challengeKeyAfterSuccess: number;
  let replayed: Response;
  let withRecoveryCode: Response;
  let recoveredAt: Date;
  let recoveryCodeAgain: Response;
  let endedChallenge: Response;

  beforeAll(async () => {
    fixture = await insertMfaAccount({ failed_login_count: 2 });
    passwordAnswer = await signIn(ip, fixture.account);
    sessionsAfterPassword = await sessionCount(fixture.account.id);
    firstChallenge = (passwordAnswer.body as { mfaChallengeToken: string }).mfaChallengeToken;
    verifiedAt = t.clock.now();
    const code = currentCode(fixture.secret);
    withTotp = await verifyMfa(ip, { mfaChallengeToken: firstChallenge, code });
    challengeKeyAfterSuccess = await t.redis.client.exists(
      redisKeys.mfaChallenge(sha256Hex(firstChallenge)).key,
    );
    // The same code again, on a new challenge within its step: refused.
    const second = await challengeOf(ip, fixture.account);
    replayed = await verifyMfa(ip, { mfaChallengeToken: second, code });
    // A recovery code typed in lower case without its dashes completes the same challenge.
    recoveredAt = t.clock.now();
    withRecoveryCode = await verifyMfa(ip, {
      mfaChallengeToken: second,
      recoveryCode: (fixture.codes[3] ?? "").replaceAll("-", "").toLowerCase(),
    });
    const third = await challengeOf(ip, fixture.account);
    recoveryCodeAgain = await verifyMfa(ip, { mfaChallengeToken: third, recoveryCode: fixture.codes[3] });
    t.clock.advance(STEP_MS);
    endedChallenge = await verifyMfa(ip, {
      mfaChallengeToken: firstChallenge,
      code: currentCode(fixture.secret),
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-015 AC2] a TOTP code completes the challenge: a session whose token carries mfa_at [PF-04 AC2]", async () => {
    // The password alone answers the challenge and starts no session.
    expectResponseToMatch("signIn", passwordAnswer, { document: "platform" });
    expect(passwordAnswer.status).toBe(200);
    expect(passwordAnswer.headers["cache-control"]).toBe("no-store");
    expect(passwordAnswer.body).toEqual({
      mfaRequired: true,
      mfaChallengeToken: firstChallenge,
      expiresIn: 300,
    });
    expect(sessionsAfterPassword).toBe(0);

    expectResponseToMatch("verifyMfa", withTotp, { document: "platform" });
    expect(withTotp.status).toBe(200);
    expect(withTotp.headers["cache-control"]).toBe("no-store");
    const claims = await claimsOf(withTotp);
    expect(claims).toMatchObject({
      sub: fixture.account.id,
      ev: true,
      amr: ["pwd", "otp"],
      mfa_at: Math.floor(verifiedAt.getTime() / 1000),
    });
    expect((withTotp.body as Session).account).toMatchObject({ id: fixture.account.id, mfaEnabled: true });
    expect(await familyOf(claims.sid)).toEqual([
      expect.objectContaining({ audience: "portal", mfa_verified_at: verifiedAt, ip_address: ip }),
    ]);
    expect(await accountRow(fixture.account.id)).toMatchObject({
      failed_login_count: 0,
      last_login_at: verifiedAt,
    });
    expect(await auditRows("auth.sign_in", claims.sid)).toEqual([
      expect.objectContaining({
        actor_account_id: fixture.account.id,
        details: { audience: "portal", mfa: true },
      }),
    ]);
    // The challenge ended with the success, so it cannot start a second session.
    expect(challengeKeyAfterSuccess).toBe(0);
    expectResponseToMatch("verifyMfa", endedChallenge, { document: "platform" });
    expect(failure(endedChallenge)).toBe("401 MFA_CHALLENGE_INVALID");
  });

  it("refuses a TOTP code that was used already, and audits the wrong code without it", async () => {
    expectResponseToMatch("verifyMfa", replayed, { document: "platform" });
    expect(failure(replayed)).toBe("401 MFA_CODE_INVALID");
    const failed = await auditRows("auth.sign_in_failed", fixture.account.id);
    expect(failed.map((row) => row["details"])).toEqual([
      { reason: "invalid_mfa_code", method: "totp", attempt: 1, maxAttempts: 5 },
      { reason: "invalid_mfa_code", method: "recovery_code", attempt: 1, maxAttempts: 5 },
    ]);
    expect(failed[0]?.["request_id"]).toBe(replayed.headers["x-request-id"]);
  });

  it("[PBE-015 AC2] an unused recovery code completes the challenge once [PF-04 AC2]", async () => {
    expectResponseToMatch("verifyMfa", withRecoveryCode, { document: "platform" });
    expect(withRecoveryCode.status).toBe(200);
    const claims = await claimsOf(withRecoveryCode);
    expect(claims).toMatchObject({ sub: fixture.account.id, amr: ["pwd", "otp"] });
    const used = (await recoveryCodeRows(fixture.account.id)).filter((code) => code.used_at !== null);
    expect(used).toEqual([
      expect.objectContaining({
        code_hash: sha256Hex((fixture.codes[3] ?? "").replaceAll("-", "")),
        used_at: recoveredAt,
      }),
    ]);
    expect(await auditRows("auth.recovery_code_used", fixture.account.id)).toEqual([
      expect.objectContaining({
        request_id: withRecoveryCode.headers["x-request-id"],
        details: { recoveryCodesLeft: 9 },
      }),
    ]);
    // A used recovery code is a wrong code.
    expectResponseToMatch("verifyMfa", recoveryCodeAgain, { document: "platform" });
    expect(failure(recoveryCodeAgain)).toBe("401 MFA_CODE_INVALID");
  });
});

describe("five wrong codes end the challenge", () => {
  const ip = nextIp();
  let fixture: MfaAccountFixture;
  const wrong: Response[] = [];
  let challengeKeys: number[];
  let attemptsTtlMs: number;
  let sixth: Response;
  let rightCodeAfterwards: Response;
  let unknown: Response;
  let expiredChallenge: Response;
  let invalidBody: Response;

  beforeAll(async () => {
    fixture = await insertMfaAccount();
    const token = await challengeOf(ip, fixture.account);
    const challengeKey = redisKeys.mfaChallenge(sha256Hex(token)).key;
    challengeKeys = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      wrong.push(await verifyMfa(ip, { mfaChallengeToken: token, code: wrongCode(fixture.secret) }));
      challengeKeys.push(await t.redis.client.exists(challengeKey));
    }
    attemptsTtlMs = await t.redis.client.pttl(redisKeys.mfaChallengeAttempts(sha256Hex(token)).key);
    sixth = await verifyMfa(ip, { mfaChallengeToken: token, code: wrongCode(fixture.secret) });
    rightCodeAfterwards = await verifyMfa(ip, {
      mfaChallengeToken: token,
      code: currentCode(fixture.secret),
    });
    unknown = await verifyMfa(ip, { mfaChallengeToken: `mfa_${"N".repeat(43)}`, code: "123456" });
    // A challenge lives 5 minutes by the Clock.
    const late = await challengeOf(ip, fixture.account);
    t.clock.advance(5 * MINUTE_MS);
    expiredChallenge = await verifyMfa(ip, { mfaChallengeToken: late, code: currentCode(fixture.secret) });
    invalidBody = await verifyMfa(ip, { mfaChallengeToken: late, code: "12345" });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-015 AC2] the sixth wrong code fails with MFA_CHALLENGE_INVALID [PF-04 AC2]", async () => {
    for (const res of [...wrong, sixth, rightCodeAfterwards]) {
      expectResponseToMatch("verifyMfa", res, { document: "platform" });
    }
    expect(wrong.map(failure)).toEqual(Array.from({ length: 5 }, () => "401 MFA_CODE_INVALID"));
    // The fifth wrong code ends the challenge; the attempts were counted in Redis for at most its 5 minutes.
    expect(challengeKeys).toEqual([1, 1, 1, 1, 0]);
    expect(attemptsTtlMs).toBeGreaterThan(0);
    expect(attemptsTtlMs).toBeLessThanOrEqual(300_000);
    expect(failure(sixth)).toBe("401 MFA_CHALLENGE_INVALID");
    // The challenge has ended: even the right code needs a new sign-in.
    expect(failure(rightCodeAfterwards)).toBe("401 MFA_CHALLENGE_INVALID");
    expect(await sessionCount(fixture.account.id)).toBe(0);
    expect(
      (await auditRows("auth.sign_in_failed", fixture.account.id)).map(
        (row) => (row["details"] as { attempt: number }).attempt,
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("answers MFA_CHALLENGE_INVALID for an unknown or expired challenge, and VALIDATION_FAILED for a bad code", () => {
    for (const res of [unknown, expiredChallenge, invalidBody]) {
      expectResponseToMatch("verifyMfa", res, { document: "platform" });
    }
    expect(failure(unknown)).toBe("401 MFA_CHALLENGE_INVALID");
    expect(failure(expiredChallenge)).toBe("401 MFA_CHALLENGE_INVALID");
    expect(failure(invalidBody)).toBe("400 VALIDATION_FAILED");
  });
});

describe("the per-account MFA limit", () => {
  const ip = nextIp();
  const attempts: Response[] = [];
  let limited: Response;

  beforeAll(async () => {
    const fixture = await insertMfaAccount();
    for (let challenge = 1; challenge <= 2; challenge += 1) {
      const token = await challengeOf(ip, fixture.account);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        attempts.push(await verifyMfa(ip, { mfaChallengeToken: token, code: wrongCode(fixture.secret) }));
      }
    }
    const token = await challengeOf(ip, fixture.account);
    limited = await verifyMfa(ip, { mfaChallengeToken: token, code: currentCode(fixture.secret) });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("counts 10 MFA attempts per account per 10 minutes: the 11th answers 429 RATE_LIMITED with Retry-After", () => {
    for (const res of [...attempts, limited]) {
      expectResponseToMatch("verifyMfa", res, { document: "platform" });
    }
    expect(attempts.map(failure)).toEqual(Array.from({ length: 10 }, () => "401 MFA_CODE_INVALID"));
    expect(failure(limited)).toBe("429 RATE_LIMITED");
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);
  });
});

describe("step-up, regenerating the recovery codes and disabling MFA", () => {
  const ip = nextIp();
  let fixture: MfaAccountFixture;
  let signedIn: Session;
  let refreshed: Session;
  let staleDisable: Response;
  let staleRegenerate: Response;
  let wrongStepUp: Response;
  let steppedUp: Response;
  let stepUpAt: Date;
  let replayedStepUp: Response;
  let refreshedAfterStepUp: Response;
  let regenerated: Response;
  let disabled: Response;
  let disabledAt: Date;
  let stepUpWithoutMfa: Response;
  let disableWithoutMfa: Response;

  beforeAll(async () => {
    fixture = await insertMfaAccount({ full_name: "Odd Nordmann" });
    signedIn = await signInWithMfa(ip, fixture);
    // 16 minutes later the TOTP verification of the sign-in is no longer recent.
    t.clock.advance(16 * MINUTE_MS);
    refreshed = (await post(ip, "/v1/auth/refresh", undefined, { refreshToken: signedIn.refreshToken }))
      .body as Session;
    staleDisable = await post(ip, "/v1/me/mfa/disable", refreshed.accessToken);
    staleRegenerate = await post(ip, "/v1/me/mfa/recovery-codes", refreshed.accessToken);
    wrongStepUp = await post(ip, "/v1/auth/step-up", refreshed.accessToken, {
      code: wrongCode(fixture.secret),
    });
    stepUpAt = t.clock.now();
    const code = currentCode(fixture.secret);
    steppedUp = await post(ip, "/v1/auth/step-up", refreshed.accessToken, { code });
    const session = steppedUp.body as Session;
    replayedStepUp = await post(ip, "/v1/auth/step-up", session.accessToken, { code });
    regenerated = await post(ip, "/v1/me/mfa/recovery-codes", session.accessToken);
    // Fourteen minutes after the step-up it is still recent.
    t.clock.advance(14 * MINUTE_MS);
    disabledAt = t.clock.now();
    disabled = await post(ip, "/v1/me/mfa/disable", session.accessToken);
    stepUpWithoutMfa = await post(ip, "/v1/auth/step-up", session.accessToken, {
      code: currentCode(fixture.secret),
    });
    disableWithoutMfa = await post(ip, "/v1/me/mfa/disable", session.accessToken);
    refreshedAfterStepUp = await post(ip, "/v1/auth/refresh", undefined, {
      refreshToken: session.refreshToken,
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-015 AC3] disabling needs a step-up within 15 minutes [PF-04 AC3]", () => {
    expectResponseToMatch("disableMfa", staleDisable, { document: "platform" });
    expectResponseToMatch("regenerateRecoveryCodes", staleRegenerate, { document: "platform" });
    expect(failure(staleDisable)).toBe("401 REAUTH_REQUIRED");
    expect(failure(staleRegenerate)).toBe("401 REAUTH_REQUIRED");
    expectResponseToMatch("disableMfa", disabled, { document: "platform" });
    expect(disabled.status).toBe(204);
  });

  it("[PBE-015 AC3] a valid code steps up: a new session of the same family with mfa_at now [PF-04 AC3]", async () => {
    expectResponseToMatch("stepUp", steppedUp, { document: "platform" });
    expect(steppedUp.status).toBe(200);
    expect(steppedUp.headers["cache-control"]).toBe("no-store");
    const before = await tokens.verify(refreshed.accessToken, "portal");
    const claims = await claimsOf(steppedUp);
    expect(before.mfa_at).toBe(Math.floor((stepUpAt.getTime() - 16 * MINUTE_MS) / 1000));
    expect(claims).toMatchObject({
      sub: fixture.account.id,
      sid: before.sid,
      amr: ["pwd", "otp"],
      mfa_at: Math.floor(stepUpAt.getTime() / 1000),
    });
    // The refresh token of the step-up replaces the current one, as a refresh would: one family of four generations.
    const family = await familyOf(before.sid);
    const generation = (session: Session): PlatformRow<"account_sessions"> | undefined =>
      family.find((row) => row.refresh_token_hash === sha256Hex(session.refreshToken));
    const current = generation(refreshed);
    const stepped = generation(steppedUp.body as Session);
    expect(family).toHaveLength(4);
    expect(generation(refreshedAfterStepUp.body as Session)).toBeDefined();
    expect(current).toMatchObject({ rotated_at: stepUpAt, replaced_by_id: stepped?.id });
    expect(stepped).toMatchObject({ family_id: before.sid, mfa_verified_at: stepUpAt, revoked_at: null });
    // The family keeps the step-up's time: a later refresh copies it into the access token.
    expectResponseToMatch("refreshSession", refreshedAfterStepUp, { document: "platform" });
    expect((await claimsOf(refreshedAfterStepUp)).mfa_at).toBe(Math.floor(stepUpAt.getTime() / 1000));
  });

  it("refuses a wrong or replayed step-up code, and a step-up or disabling without MFA", () => {
    for (const res of [wrongStepUp, replayedStepUp, stepUpWithoutMfa]) {
      expectResponseToMatch("stepUp", res, { document: "platform" });
    }
    expect(failure(wrongStepUp)).toBe("401 MFA_CODE_INVALID");
    expect(failure(replayedStepUp)).toBe("401 MFA_CODE_INVALID");
    expect(failure(stepUpWithoutMfa)).toBe("403 MFA_REQUIRED");
    expectResponseToMatch("disableMfa", disableWithoutMfa, { document: "platform" });
    expect(failure(disableWithoutMfa)).toBe("403 MFA_REQUIRED");
  });

  it("regenerates the ten recovery codes behind a fresh step-up; the earlier ones no longer exist", async () => {
    expectResponseToMatch("regenerateRecoveryCodes", regenerated, { document: "platform" });
    expect(regenerated.status).toBe(200);
    expect(regenerated.headers["cache-control"]).toBe("no-store");
    const { recoveryCodes } = regenerated.body as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes.filter((code) => fixture.codes.includes(code))).toEqual([]);
    expect(
      await auditRows("account.recovery_codes_regenerated", fixture.account.id).then((rows) =>
        rows.map((row) => row["details"]),
      ),
    ).toEqual([{ recoveryCodeCount: 10 }]);
  });

  it("disabling clears the secret and the recovery codes, e-mails, audits and invalidates the account", async () => {
    expect(await accountRow(fixture.account.id)).toMatchObject({
      mfa_enabled: false,
      mfa_enabled_at: null,
      mfa_secret_ciphertext: null,
      encryption_key_id: null,
      version: fixture.account.version + 1,
    });
    expect(await recoveryCodeRows(fixture.account.id)).toEqual([]);
    expect(await outboxOf(fixture.account.id)).toEqual([
      {
        template: "auth.mfa_changed",
        to_email: fixture.account.email,
        data: {
          fullName: "Odd Nordmann",
          change: "new recovery codes were created, and the earlier ones no longer work",
        },
      },
      {
        template: "auth.mfa_changed",
        to_email: fixture.account.email,
        data: { fullName: "Odd Nordmann", change: "it was turned off" },
      },
    ]);
    expect(await auditRows("account.mfa_disabled", fixture.account.id)).toEqual([
      expect.objectContaining({
        actor_account_id: fixture.account.id,
        request_id: disabled.headers["x-request-id"],
        details: { recoveryCodesRemoved: 10, before: { mfaEnabled: true }, after: { mfaEnabled: false } },
      }),
    ]);
    expect(disabledAt.getTime()).toBeGreaterThan(stepUpAt.getTime());
    expect(await invalidationOf(fixture.account.id)).toEqual({
      v: 1,
      type: "account",
      accountId: fixture.account.id,
    });
  });
});

describe("a platform admin", () => {
  const ip = nextIp();
  let fixture: MfaAccountFixture;
  let steppedUp: Response;
  let refused: Response;
  let afterSignOut: Response;

  beforeAll(async () => {
    fixture = await insertMfaAccount({ is_platform_admin: true });
    const signedIn = await signInWithMfa(ip, fixture);
    // A step-up with the code of the next time step: the step-up check passes, the service refuses.
    t.clock.advance(STEP_MS);
    steppedUp = await post(ip, "/v1/auth/step-up", signedIn.accessToken, {
      code: currentCode(fixture.secret),
    });
    const session = steppedUp.body as Session;
    refused = await post(ip, "/v1/me/mfa/disable", session.accessToken);
    // Once the family is signed out, its access token (still unexpired) cannot step up.
    await post(ip, "/v1/auth/sign-out", session.accessToken, { refreshToken: session.refreshToken });
    t.clock.advance(STEP_MS);
    afterSignOut = await post(ip, "/v1/auth/step-up", session.accessToken, {
      code: currentCode(fixture.secret),
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-015 AC3] cannot disable MFA, even right after a step-up [PF-04 AC3]", async () => {
    expectResponseToMatch("stepUp", steppedUp, { document: "platform" });
    expect(steppedUp.status).toBe(200);
    expectResponseToMatch("disableMfa", refused, { document: "platform" });
    expect(failure(refused)).toBe("403 FORBIDDEN");
    expect((refused.body as ErrorBody).error.details).toEqual({ reason: "platform_admin" });
    expect(await accountRow(fixture.account.id)).toMatchObject({ mfa_enabled: true });
    expect(await recoveryCodeRows(fixture.account.id)).toHaveLength(10);
    expect(await auditRows("account.mfa_disabled", fixture.account.id)).toEqual([]);
  });

  it("refuses a step-up of a family that was signed out with UNAUTHENTICATED", () => {
    expectResponseToMatch("stepUp", afterSignOut, { document: "platform" });
    expect(failure(afterSignOut)).toBe("401 UNAUTHENTICATED");
  });
});

describe("secrets", () => {
  it("[PBE-015 AC4] no TOTP secret or recovery code appears in a log, a queue payload or an audit row", async () => {
    // Every secret of this file, in every line the API logged, every audit row, every outbox row and every value of
    // every Redis key (the BullMQ jobs of the e-mails are hashes; the pending set-ups, challenges, counters and steps
    // are strings).
    const logged = JSON.stringify(t.logs.lines);
    const { rows: audit } = await pool.query(
      "SELECT details::text AS details FROM platform.platform_audit_log",
    );
    const { rows: outbox } = await pool.query(
      "SELECT data::text AS data, secret_payload_ciphertext FROM platform.email_outbox",
    );
    const redis = t.redis.client;
    const values: string[] = [];
    for (const key of await redis.keys("*")) {
      const type = await redis.type(key);
      if (type === "string") {
        values.push(key, (await redis.get(key)) ?? "");
      } else if (type === "hash") {
        values.push(key, JSON.stringify(await redis.hgetall(key)));
      } else if (type === "list") {
        values.push(key, JSON.stringify(await redis.lrange(key, 0, -1)));
      } else if (type === "zset") {
        values.push(key, JSON.stringify(await redis.zrange(key, 0, -1)));
      } else {
        values.push(key);
      }
    }
    // The e-mails of this file were queued: their `email.send` jobs are among the values scanned.
    expect(outbox.length).toBeGreaterThan(0);
    expect(values.join("\n")).toContain("email.send");
    expect(secrets.size).toBeGreaterThan(50);
    expect(logged.length).toBeGreaterThan(0);
    const scanned = {
      logged,
      audit: JSON.stringify(audit),
      outbox: JSON.stringify(outbox),
      redis: values.join("\n"),
    };
    for (const secret of secrets) {
      for (const [where, text] of Object.entries(scanned)) {
        expect(text.includes(secret), `${where} holds a secret`).toBe(false);
      }
    }
    // The steps used are kept, never the codes: `mfastep:<accountId>` holds a time step.
    const steps = await redis.keys("mfastep:*");
    expect(steps.length).toBeGreaterThan(0);
    for (const key of steps) {
      expect(Number(await redis.get(key))).toBeLessThanOrEqual(totpStep(t.clock.now()) + 1);
    }
  });
});
