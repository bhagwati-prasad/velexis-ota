// The platform admin's sign-in and sessions (PBE-028; scope PF-80, PADR-0006 "Access", PADR-0009 item 4,
// platform/docs/api-inventory-admin.md §1 and §2) through the HTTP pipeline (createTestApp) on this file's database
// clone and Redis database: only active platform admins with MFA get a challenge, and the same `401
// INVALID_CREDENTIALS` as a wrong password goes to everyone else; a TOTP or recovery code completes every admin
// sign-in; the 12-hour family with its 2-hour idle tokens; portal and admin refresh tokens never refresh each other;
// the lockout shared with the portal; the step-up, sign-out and adminGetMe; and no password, token, TOTP secret or
// recovery code in any log line or audit row. Every answer is checked against the platform document.
//
// Admins are written as rows (`is_platform_admin`, a TOTP secret encrypted with the application's own EnvelopeService
// and the associated data of PBE-015, recovery codes stored as their SHA-256), as the CLI's `admin:grant` and the
// portal's MFA set-up leave them (admin-cli.int.test.ts runs the real grant). Codes are computed at the FakeClock's
// time, as an authenticator app would; a TOTP step is accepted once per account, so a group that needs a second code
// moves the clock first. Each group signs in from an end-user IP of its own (RFC 5737) and uses its own accounts, so
// the per-IP sign-in limit and the per-account MFA limit of one group never touch another. The sign-ins (Argon2id) run
// in the setup hooks of each group, with explicit bounds; the tests then check what happened.
import { sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { decodeJwt } from "jose";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountSecretPlace,
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  totpCode,
} from "../../../src/accounts/mfa.service";
import { ADMIN_FAMILY_TTL_MS, ADMIN_REFRESH_TOKEN_TTL_MS } from "../../../src/admin/admin-auth.service";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { TokenService, type AccessTokenClaims } from "../../../src/auth/token.service";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { featuresFor } from "../../../src/common/features";
import { redisKeys } from "../../../src/common/redis/redis-keys";
import { TEST_PASSWORD } from "../../builders/accounts";
import { insertAccount, type AccountRow, type PlatformRow } from "../../builders/platform-rows";
import { createTestApp, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and parsing the platform document take about two seconds alone; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few sign-ins (Argon2id verifications) and session calls; seconds at most, bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const STEP_MS = 30 * SECOND_MS;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0";

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let envelope: EnvelopeService;
/** The Argon2id hash of TEST_PASSWORD, made once and shared by the accounts of this file. */
let passwordHash: string;

/**
 * Every password, TOTP secret, recovery code (as shown and normalised), challenge token, access and refresh token of
 * this file, for the scans. The six-digit codes are not in it: six digits occur in any log line's time.
 */
const secrets = new Set<string>([TEST_PASSWORD]);

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each group of calls, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${200 + ipCounter}`;
}

/** Notes every secret an answer carries. */
function remember(res: Response): Response {
  const body = res.body as Record<string, unknown>;
  for (const field of ["accessToken", "refreshToken", "mfaChallengeToken"]) {
    if (typeof body[field] === "string") {
      secrets.add(body[field]);
    }
  }
  return res;
}

/** A request of the admin server for the end user at `ip`, with an access token when there is one. */
async function call(
  method: "get" | "post",
  ip: string,
  path: string,
  options: { readonly accessToken?: string; readonly body?: object } = {},
): Promise<Response> {
  const headers = {
    ...t.bffHeaders(ip, USER_AGENT),
    ...(options.accessToken === undefined ? {} : { Authorization: `Bearer ${options.accessToken}` }),
  };
  const request = method === "get" ? t.http.get(path).set(headers) : t.http.post(path).set(headers);
  return remember(await (options.body === undefined ? request : request.send(options.body)));
}

function post(ip: string, path: string, body?: object, accessToken?: string): Promise<Response> {
  return call("post", ip, path, {
    ...(body === undefined ? {} : { body }),
    ...(accessToken === undefined ? {} : { accessToken }),
  });
}

/** `<status>` of a success, or `<status> <code>` of an error answer whose request id is the header's. */
function outcomeOf(res: Response): string {
  if (res.status < 300) {
    return String(res.status);
  }
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return `${res.status} ${error.code}`;
}

/** The error body without its request id, to compare two answers. */
function errorWithoutRequestId(res: Response): unknown {
  const { error } = res.body as { error: Record<string, unknown> };
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

/** The tokens of an AdminSession answer, as far as the tests read them. */
interface AdminSessionBody {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly admin: { readonly id: string; readonly email: string; readonly fullName: string };
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

/** An account that signs in with TEST_PASSWORD (active and verified unless `overrides` say otherwise). */
function insertSignInAccount(overrides: Partial<AccountRow> = {}): Promise<PlatformRow<"accounts">> {
  return insertAccount(pool, { password_hash: passwordHash, ...overrides });
}

/** An account with MFA on: its TOTP secret (encrypted as MfaService stores it) and its ten recovery codes. */
interface MfaFixture {
  readonly account: PlatformRow<"accounts">;
  readonly secret: string;
  readonly codes: readonly string[];
}

/** An account with MFA (a platform admin unless `overrides` say otherwise). */
async function insertMfaAccount(overrides: Partial<AccountRow> = {}): Promise<MfaFixture> {
  const account = await insertSignInAccount({ is_platform_admin: true, ...overrides });
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
    secrets.add(code);
    secrets.add(normaliseRecoveryCode(code) ?? code);
    await pool.query(
      "INSERT INTO platform.account_recovery_codes (account_id, code_hash, created_at) VALUES ($1, $2, $3)",
      [account.id, sha256Hex(normaliseRecoveryCode(code) ?? ""), t.clock.now()],
    );
  }
  return { account, secret, codes };
}

function adminSignIn(ip: string, email: string, password = TEST_PASSWORD): Promise<Response> {
  return post(ip, "/v1/admin/auth/sign-in", { email, password });
}

function adminVerify(ip: string, body: object): Promise<Response> {
  return post(ip, "/v1/admin/auth/mfa/verify", body);
}

function adminRefresh(ip: string, refreshToken: string): Promise<Response> {
  secrets.add(refreshToken);
  return post(ip, "/v1/admin/auth/refresh", { refreshToken });
}

/** The challenge token of a successful adminSignIn. */
function challengeOf(res: Response): string {
  const { mfaChallengeToken } = res.body as { mfaChallengeToken?: string };
  if (res.status !== 200 || mfaChallengeToken === undefined) {
    throw new Error(`adminSignIn answered ${res.status} without a challenge`);
  }
  return mfaChallengeToken;
}

/** Signs `fixture` in to the admin with the password and the current TOTP code: the AdminSession. */
async function signInAdmin(ip: string, fixture: MfaFixture): Promise<AdminSessionBody> {
  const mfaChallengeToken = challengeOf(await adminSignIn(ip, fixture.account.email));
  const res = await adminVerify(ip, { mfaChallengeToken, code: currentCode(fixture.secret) });
  if (res.status !== 200) {
    throw new Error(`adminVerifyMfa answered ${res.status}`);
  }
  return res.body as AdminSessionBody;
}

/** Signs `account` in to the portal (no MFA, or MFA with the current code of `secret`): the PortalSession. */
async function signInPortal(
  ip: string,
  account: Pick<PlatformRow<"accounts">, "email">,
  secret?: string,
): Promise<{ readonly accessToken: string; readonly refreshToken: string }> {
  const res = await post(ip, "/v1/auth/sign-in", { email: account.email, password: TEST_PASSWORD });
  const body = res.body as { accessToken?: string; refreshToken?: string; mfaChallengeToken?: string };
  if (res.status === 200 && body.mfaChallengeToken !== undefined && secret !== undefined) {
    const verified = await post(ip, "/v1/auth/mfa/verify", {
      mfaChallengeToken: body.mfaChallengeToken,
      code: currentCode(secret),
    });
    return verified.body as { accessToken: string; refreshToken: string };
  }
  if (res.status !== 200 || body.accessToken === undefined || body.refreshToken === undefined) {
    throw new Error(`the portal sign-in answered ${res.status} without a session`);
  }
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

async function accountRow(accountId: string): Promise<PlatformRow<"accounts">> {
  const { rows } = await pool.query("SELECT * FROM platform.accounts WHERE id = $1", [accountId]);
  return rows[0] as PlatformRow<"accounts">;
}

async function sessionsOf(accountId: string): Promise<Array<PlatformRow<"account_sessions">>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.account_sessions WHERE account_id = $1 ORDER BY created_at, id",
    [accountId],
  );
  return rows as Array<PlatformRow<"account_sessions">>;
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
    "SELECT actor_type, actor_account_id, actor_label, target_type, target_id, request_id, ip_address, details " +
      "FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

/** The audit rows of the accounts of a test, oldest first: action and details. */
async function auditOf(accountId: string): Promise<Array<{ action: string; details: unknown }>> {
  const { rows } = await pool.query(
    "SELECT action, details FROM platform.platform_audit_log WHERE actor_account_id = $1 OR target_id = $1 " +
      "ORDER BY id",
    [accountId],
  );
  return rows as Array<{ action: string; details: unknown }>;
}

/** How many MFA challenges Redis holds now (any test's). */
async function challengeCount(): Promise<number> {
  const keys = await t.redis.client.keys("mfach:*");
  return keys.filter((key) => !key.endsWith(":attempts")).length;
}

/**
 * The claims of an access token this file received, read without checking its time: groups move the FakeClock past
 * the 15 minutes of earlier tokens (the signature and audience checks are TokenService's, tested in the first group).
 */
function claimsOf(accessToken: string): AccessTokenClaims {
  return decodeJwt(accessToken) as unknown as AccessTokenClaims;
}

beforeAll(async () => {
  // Every line at every level is captured, so "no log line holds a secret" covers debug and trace too.
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  envelope = t.app.get(EnvelopeService);
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("an active platform admin with MFA", () => {
  const ip = nextIp();
  let fixture: MfaFixture;
  let signedInAt: Date;
  let challenge: Response;
  let storedChallenge: Record<string, unknown>;
  let verified: Response;
  let again: Response;
  let me: Response;
  let withRecoveryCode: Response;
  let recoveryCode: string;

  beforeAll(async () => {
    fixture = await insertMfaAccount({ full_name: "Lena Holm", failed_login_count: 2 });
    challenge = await adminSignIn(ip, fixture.account.email.toUpperCase());
    storedChallenge = JSON.parse(
      (await t.redis.client.get(redisKeys.mfaChallenge(sha256Hex(challengeOf(challenge))).key)) ?? "null",
    ) as Record<string, unknown>;
    signedInAt = t.clock.now();
    verified = await adminVerify(ip, {
      mfaChallengeToken: challengeOf(challenge),
      code: currentCode(fixture.secret),
    });
    // A second sign-in right after: the password alone still gives no session.
    again = await adminSignIn(ip, fixture.account.email);
    me = await call("get", ip, "/v1/admin/me", {
      accessToken: (verified.body as AdminSessionBody).accessToken,
    });
    // The second challenge, completed with a recovery code instead of a TOTP code.
    recoveryCode = fixture.codes[3] ?? "";
    withRecoveryCode = await adminVerify(ip, {
      mfaChallengeToken: challengeOf(again),
      recoveryCode: recoveryCode.toLowerCase(),
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-028 AC1] the password step answers only an admin MFA challenge, kept in Redis for 5 minutes [PF-80]", async () => {
    for (const res of [challenge, again]) {
      expectResponseToMatch("adminSignIn", res, { document: "platform" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({
        mfaChallengeToken: expect.stringMatching(/^mfa_[A-Za-z0-9_-]{43}$/) as string,
        expiresIn: 300,
      });
      expect(res.body).not.toHaveProperty("accessToken");
      expect(res.body).not.toHaveProperty("refreshToken");
    }
    expect(storedChallenge).toEqual({
      v: 1,
      audience: "platform_admin",
      accountId: fixture.account.id,
      issuedAt: signedInAt.getTime(),
      maxAttempts: 5,
    });
    // The correct password cleared the failures of the account.
    expect((await accountRow(fixture.account.id)).failed_login_count).toBe(0);
  });

  it("[PBE-028 AC1] a TOTP code completes the sign-in with a 12-hour admin family whose token carries mfa_at [PF-80]", async () => {
    expectResponseToMatch("adminVerifyMfa", verified, { document: "platform" });
    expect(verified.status).toBe(200);
    expect(verified.headers["cache-control"]).toBe("no-store");
    const session = verified.body as AdminSessionBody;
    const nowSeconds = Math.floor(signedInAt.getTime() / 1000);
    const claims = await tokens.verify(session.accessToken, "platform_admin");
    expect(claims).toMatchObject({
      aud: "platform_admin",
      typ: "admin",
      sub: fixture.account.id,
      ev: true,
      amr: ["pwd", "otp"],
      mfa_at: nowSeconds,
      iat: nowSeconds,
      exp: nowSeconds + 15 * 60,
    });
    expect(session.accessTokenExpiresAt).toBe(new Date(signedInAt.getTime() + 15 * MINUTE_MS).toISOString());
    expect(session.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(session.refreshTokenExpiresAt).toBe(
      new Date(signedInAt.getTime() + ADMIN_REFRESH_TOKEN_TTL_MS).toISOString(),
    );
    expect(session.admin).toEqual({
      id: fixture.account.id,
      email: fixture.account.email,
      fullName: "Lena Holm",
      features: featuresFor(t.config),
    });
    // A portal token check refuses it: the audiences never mix.
    await expect(tokens.verify(session.accessToken, "portal")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });

    const [row] = await familyOf(claims.sid);
    expect(row).toMatchObject({
      id: claims.sid,
      family_id: claims.sid,
      account_id: fixture.account.id,
      audience: "platform_admin",
      refresh_token_hash: sha256Hex(session.refreshToken),
      expires_at: new Date(signedInAt.getTime() + ADMIN_REFRESH_TOKEN_TTL_MS),
      family_expires_at: new Date(signedInAt.getTime() + ADMIN_FAMILY_TTL_MS),
      mfa_verified_at: signedInAt,
      user_agent: USER_AGENT,
      ip_address: ip,
      rotated_at: null,
      revoked_at: null,
    });
    expect((await accountRow(fixture.account.id)).last_login_at).toEqual(signedInAt);
    expect(await auditRows("admin.sign_in", claims.sid)).toEqual([
      {
        actor_type: "platform_admin",
        actor_account_id: fixture.account.id,
        actor_label: fixture.account.email,
        target_type: "session",
        target_id: claims.sid,
        request_id: verified.headers["x-request-id"],
        ip_address: ip,
        details: { audience: "platform_admin", method: "totp" },
      },
    ]);
  });

  it("[PBE-028 AC1] TOTP (or a recovery code) is required on every sign-in: the next one needs a code again [PF-80]", async () => {
    expectResponseToMatch("adminVerifyMfa", withRecoveryCode, { document: "platform" });
    expect(withRecoveryCode.status).toBe(200);
    const second = withRecoveryCode.body as AdminSessionBody;
    const first = verified.body as AdminSessionBody;
    expect(claimsOf(second.accessToken).sid).not.toBe(claimsOf(first.accessToken).sid);
    // The recovery code is used up.
    const { rows } = await pool.query(
      "SELECT used_at FROM platform.account_recovery_codes WHERE account_id = $1 AND code_hash = $2",
      [fixture.account.id, sha256Hex(normaliseRecoveryCode(recoveryCode) ?? "")],
    );
    expect(rows).toEqual([{ used_at: t.clock.now() }]);
    const families = new Set((await sessionsOf(fixture.account.id)).map((row) => row.family_id));
    expect(families.size).toBe(2);
    expect(
      (await auditOf(fixture.account.id))
        .map((row) => row.action)
        .filter((action) => action === "admin.sign_in"),
    ).toEqual(["admin.sign_in", "admin.sign_in"]);
  });

  it("adminGetMe answers the admin and the milestone switches of getMe", () => {
    expectResponseToMatch("adminGetMe", me, { document: "platform" });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      id: fixture.account.id,
      email: fixture.account.email,
      fullName: "Lena Holm",
      features: {
        stripeBilling: false,
        ownStripe: false,
        settlements: false,
        ownAmadeus: false,
        customDomains: false,
        liveSwitch: false,
      },
    });
  });
});

describe("who gets a challenge", () => {
  const ip = nextIp();
  const otherIp = nextIp();
  const answers: Record<string, Response> = {};
  let portalUser: PlatformRow<"accounts">;
  let adminWithoutMfa: PlatformRow<"accounts">;
  let disabledAdmin: MfaFixture;
  let unverifiedAdmin: MfaFixture;
  let portalUserWithMfa: MfaFixture;
  let admin: MfaFixture;
  let challengesBefore: number;
  let challengesAfter: number;

  beforeAll(async () => {
    portalUser = await insertSignInAccount();
    adminWithoutMfa = await insertSignInAccount({ is_platform_admin: true });
    disabledAdmin = await insertMfaAccount({ status: "disabled" });
    unverifiedAdmin = await insertMfaAccount({ status: "pending_verification", email_verified_at: null });
    portalUserWithMfa = await insertMfaAccount({ is_platform_admin: false });
    admin = await insertMfaAccount();
    challengesBefore = await challengeCount();
    answers["wrongPassword"] = await adminSignIn(ip, admin.account.email, "Wrong-Password-2026");
    answers["unknownEmail"] = await adminSignIn(ip, "nobody-at-all@example.com");
    answers["portalUser"] = await adminSignIn(ip, portalUser.email);
    answers["portalUserWithMfa"] = await adminSignIn(ip, portalUserWithMfa.account.email);
    answers["disabledAdmin"] = await adminSignIn(ip, disabledAdmin.account.email);
    answers["unverifiedAdmin"] = await adminSignIn(ip, unverifiedAdmin.account.email);
    answers["adminWithoutMfa"] = await adminSignIn(ip, adminWithoutMfa.email);
    answers["adminWithoutMfaWrongPassword"] = await adminSignIn(
      ip,
      adminWithoutMfa.email,
      "Wrong-Password-2026",
    );
    challengesAfter = await challengeCount();
    answers["withoutPassword"] = await post(otherIp, "/v1/admin/auth/sign-in", {
      email: admin.account.email,
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-028 AC1] a non-admin with the right password gets the same 401 INVALID_CREDENTIALS as a wrong password [PF-80]", () => {
    for (const name of [
      "wrongPassword",
      "unknownEmail",
      "portalUser",
      "portalUserWithMfa",
      "disabledAdmin",
      "unverifiedAdmin",
      "adminWithoutMfaWrongPassword",
    ]) {
      const res = answers[name] as Response;
      expectResponseToMatch("adminSignIn", res, { document: "platform" });
      expect(outcomeOf(res), name).toBe("401 INVALID_CREDENTIALS");
      expect(errorWithoutRequestId(res), name).toEqual(
        errorWithoutRequestId(answers["wrongPassword"] as Response),
      );
      expect(res.headers["cache-control"], name).toBe("no-store");
    }
  });

  it("[PBE-028 AC1] a platform admin without MFA gets 403 MFA_REQUIRED, only after a correct password [PF-80]", () => {
    const res = answers["adminWithoutMfa"] as Response;
    expectResponseToMatch("adminSignIn", res, { document: "platform" });
    expect(outcomeOf(res)).toBe("403 MFA_REQUIRED");
  });

  it("[PBE-028 AC1] only an active platform admin with MFA gets a challenge: none of these did [PF-80]", async () => {
    expect(challengesAfter).toBe(challengesBefore);
    for (const account of [portalUser, adminWithoutMfa, disabledAdmin.account, unverifiedAdmin.account]) {
      expect(await sessionsOf(account.id)).toEqual([]);
    }
  });

  it("audits every refusal as admin.sign_in_failed with its reason, and counts only wrong passwords", async () => {
    const failures = async (accountId: string) =>
      (await auditOf(accountId))
        .filter((row) => row.action === "admin.sign_in_failed")
        .map((row) => row.details);
    expect(await failures(admin.account.id)).toEqual([{ reason: "invalid_password", failedLoginCount: 1 }]);
    expect(await failures(portalUser.id)).toEqual([{ reason: "not_active_platform_admin" }]);
    expect(await failures(disabledAdmin.account.id)).toEqual([{ reason: "not_active_platform_admin" }]);
    expect(await failures(unverifiedAdmin.account.id)).toEqual([{ reason: "not_active_platform_admin" }]);
    expect(await failures(adminWithoutMfa.id)).toEqual([
      { reason: "mfa_not_enabled" },
      { reason: "invalid_password", failedLoginCount: 1 },
    ]);
    expect((await accountRow(admin.account.id)).failed_login_count).toBe(1);
    expect((await accountRow(portalUser.id)).failed_login_count).toBe(0);
  });

  it("answers 400 VALIDATION_FAILED for a body without a password", () => {
    const res = answers["withoutPassword"] as Response;
    expectResponseToMatch("adminSignIn", res, { document: "platform" });
    expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
  });
});

describe("the lockout, shared with the portal's sign-in", () => {
  const ip = nextIp();
  let admin: MfaFixture;
  const answers: Response[] = [];
  let withRightPassword: Response;
  let afterLockout: Response;
  let lockedAt: Date;
  let lockedUntil: Date | null;

  beforeAll(async () => {
    admin = await insertMfaAccount();
    // Two wrong passwords on the portal and three on the admin: the fifth consecutive failure locks the account.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      answers.push(
        await post(ip, "/v1/auth/sign-in", { email: admin.account.email, password: "Wrong-2026-pw" }),
      );
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      answers.push(await adminSignIn(ip, admin.account.email, "Wrong-Password-2026"));
    }
    lockedAt = t.clock.now();
    withRightPassword = await adminSignIn(ip, admin.account.email);
    lockedUntil = (await accountRow(admin.account.id)).locked_until;
    t.clock.advance(15 * MINUTE_MS);
    afterLockout = await adminSignIn(ip, admin.account.email);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-028 AC1] the fifth failure locks for 15 minutes with Retry-After, also against the right password", async () => {
    expect(answers.map((res) => outcomeOf(res))).toEqual([
      "401 INVALID_CREDENTIALS",
      "401 INVALID_CREDENTIALS",
      "401 INVALID_CREDENTIALS",
      "401 INVALID_CREDENTIALS",
      "423 ACCOUNT_LOCKED",
    ]);
    for (const res of [...answers.slice(2), withRightPassword]) {
      expectResponseToMatch("adminSignIn", res, { document: "platform" });
    }
    expect(Number(answers[4]?.headers["retry-after"])).toBe(15 * 60);
    expect(outcomeOf(withRightPassword)).toBe("423 ACCOUNT_LOCKED");
    expect(Number(withRightPassword.headers["retry-after"])).toBe(15 * 60);
    expect(lockedUntil).toEqual(new Date(lockedAt.getTime() + 15 * MINUTE_MS));
    const actions = (await auditOf(admin.account.id)).map((row) => row.action);
    expect(actions).toEqual([
      "auth.sign_in_failed",
      "auth.sign_in_failed",
      "admin.sign_in_failed",
      "admin.sign_in_failed",
      "admin.sign_in_failed",
      "auth.locked",
    ]);
  });

  it("lets the right password in once the lockout has ended, and clears the count", async () => {
    expectResponseToMatch("adminSignIn", afterLockout, { document: "platform" });
    expect(outcomeOf(afterLockout)).toBe("200");
    expect(await accountRow(admin.account.id)).toMatchObject({ failed_login_count: 0, locked_until: null });
  });
});

describe("challenges and codes", () => {
  const ip = nextIp();
  let admin: MfaFixture;
  let portalPerson: MfaFixture;
  let revokedBeforeCode: MfaFixture;
  let portalChallengeAtAdmin: Response;
  let portalChallengeAtPortal: Response;
  let adminChallengeAtPortal: Response;
  let adminChallengeAtAdmin: Response;
  let replayed: Response;
  const wrongCodes: Response[] = [];
  let afterFifth: Response;
  let usedCode: string;
  let codeAfterRevocation: Response;
  let revokedChallengeKey: string;

  beforeAll(async () => {
    admin = await insertMfaAccount();
    portalPerson = await insertMfaAccount({ is_platform_admin: false });
    revokedBeforeCode = await insertMfaAccount();

    // An admin whose flag is taken away between the password step and the code: the right code starts nothing.
    const revokedChallenge = challengeOf(await adminSignIn(ip, revokedBeforeCode.account.email));
    revokedChallengeKey = redisKeys.mfaChallenge(sha256Hex(revokedChallenge)).key;
    await pool.query("UPDATE platform.accounts SET is_platform_admin = false WHERE id = $1", [
      revokedBeforeCode.account.id,
    ]);
    codeAfterRevocation = await adminVerify(ip, {
      mfaChallengeToken: revokedChallenge,
      code: currentCode(revokedBeforeCode.secret),
    });

    // A portal challenge is refused by adminVerifyMfa without being used up, and still works on the portal.
    const portalSignIn = await post(ip, "/v1/auth/sign-in", {
      email: portalPerson.account.email,
      password: TEST_PASSWORD,
    });
    const portalToken = (portalSignIn.body as { mfaChallengeToken: string }).mfaChallengeToken;
    portalChallengeAtAdmin = await adminVerify(ip, {
      mfaChallengeToken: portalToken,
      code: currentCode(portalPerson.secret),
    });
    portalChallengeAtPortal = await post(ip, "/v1/auth/mfa/verify", {
      mfaChallengeToken: portalToken,
      code: currentCode(portalPerson.secret),
    });

    // An admin challenge is refused by the portal's verifyMfa, and still works on the admin.
    const adminToken = challengeOf(await adminSignIn(ip, admin.account.email));
    adminChallengeAtPortal = await post(ip, "/v1/auth/mfa/verify", {
      mfaChallengeToken: adminToken,
      code: currentCode(admin.secret),
    });
    usedCode = currentCode(admin.secret);
    adminChallengeAtAdmin = await adminVerify(ip, { mfaChallengeToken: adminToken, code: usedCode });

    // The same code again, in the same step: refused. Then four more wrong codes end the challenge.
    const next = challengeOf(await adminSignIn(ip, admin.account.email));
    replayed = await adminVerify(ip, { mfaChallengeToken: next, code: usedCode });
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      wrongCodes.push(await adminVerify(ip, { mfaChallengeToken: next, code: wrongCode(admin.secret) }));
    }
    t.clock.advance(STEP_MS);
    afterFifth = await adminVerify(ip, { mfaChallengeToken: next, code: currentCode(admin.secret) });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-028 AC2] a portal challenge never completes an admin sign-in, nor an admin challenge a portal one", () => {
    expectResponseToMatch("adminVerifyMfa", portalChallengeAtAdmin, { document: "platform" });
    expect(outcomeOf(portalChallengeAtAdmin)).toBe("401 MFA_CHALLENGE_INVALID");
    expectResponseToMatch("verifyMfa", portalChallengeAtPortal, { document: "platform" });
    expect(outcomeOf(portalChallengeAtPortal)).toBe("200");
    expect(portalChallengeAtPortal.body).toHaveProperty("account");

    expectResponseToMatch("verifyMfa", adminChallengeAtPortal, { document: "platform" });
    expect(outcomeOf(adminChallengeAtPortal)).toBe("401 MFA_CHALLENGE_INVALID");
    expectResponseToMatch("adminVerifyMfa", adminChallengeAtAdmin, { document: "platform" });
    expect(outcomeOf(adminChallengeAtAdmin)).toBe("200");
    expect(adminChallengeAtAdmin.body).toHaveProperty("admin");
  });

  it("[PBE-028 AC1] a used or wrong code is refused, and the fifth wrong code ends the challenge [PF-80]", async () => {
    for (const res of [replayed, ...wrongCodes, afterFifth]) {
      expectResponseToMatch("adminVerifyMfa", res, { document: "platform" });
    }
    expect([replayed, ...wrongCodes].map((res) => outcomeOf(res))).toEqual(
      Array.from({ length: 5 }, () => "401 MFA_CODE_INVALID"),
    );
    expect(outcomeOf(afterFifth)).toBe("401 MFA_CHALLENGE_INVALID");
    const wrong = (await auditOf(admin.account.id))
      .filter((row) => row.action === "admin.sign_in_failed")
      .map((row) => row.details);
    expect(wrong).toEqual(
      [1, 2, 3, 4, 5].map((attempt) => ({
        reason: "invalid_mfa_code",
        method: "totp",
        attempt,
        maxAttempts: 5,
      })),
    );
  });

  it("[PBE-028 AC1] the code of an account that stopped being a platform admin after the password starts no session [PF-80]", async () => {
    expectResponseToMatch("adminVerifyMfa", codeAfterRevocation, { document: "platform" });
    expect(outcomeOf(codeAfterRevocation)).toBe("401 MFA_CHALLENGE_INVALID");
    expect(codeAfterRevocation.body).not.toHaveProperty("accessToken");
    expect(await sessionsOf(revokedBeforeCode.account.id)).toEqual([]);
    expect(
      (await auditOf(revokedBeforeCode.account.id))
        .map((row) => row.action)
        .filter((action) => action === "admin.sign_in"),
    ).toEqual([]);
    // The challenge is ended: it cannot be tried again once the flag is back.
    expect(await t.redis.client.exists(revokedChallengeKey)).toBe(0);
  });
});

describe("refresh: rotation, reuse and the 12-hour family", () => {
  const ip = nextIp();
  let admin: MfaFixture;
  let signedIn: AdminSessionBody;
  let signedInAt: Date;
  const refreshes: Response[] = [];
  const refreshedAt: Date[] = [];
  let lastMinute: Response;
  let atTheEnd: Response;
  let idleSession: AdminSessionBody;
  let idleExpired: Response;
  let reuseSession: AdminSessionBody;
  let rotated: Response;
  let reused: Response;
  let newestAfterReuse: Response;

  beforeAll(async () => {
    admin = await insertMfaAccount();
    signedIn = await signInAdmin(ip, admin);
    signedInAt = t.clock.now();
    // A refresh every 1 h 50 min keeps the 2-hour idle tokens alive until the family ends 12 hours after the sign-in.
    let refreshToken = signedIn.refreshToken;
    for (let refresh = 1; refresh <= 6; refresh += 1) {
      t.clock.advance(110 * MINUTE_MS);
      refreshedAt.push(t.clock.now());
      const res = await adminRefresh(ip, refreshToken);
      refreshes.push(res);
      refreshToken = (res.body as AdminSessionBody).refreshToken;
    }
    t.clock.set(new Date(signedInAt.getTime() + ADMIN_FAMILY_TTL_MS - MINUTE_MS));
    lastMinute = await adminRefresh(ip, refreshToken);
    t.clock.set(new Date(signedInAt.getTime() + ADMIN_FAMILY_TTL_MS));
    atTheEnd = await adminRefresh(ip, (lastMinute.body as AdminSessionBody).refreshToken);

    // A token left idle for more than 2 hours.
    t.clock.advance(STEP_MS);
    idleSession = await signInAdmin(ip, admin);
    t.clock.advance(ADMIN_REFRESH_TOKEN_TTL_MS + SECOND_MS);
    idleExpired = await adminRefresh(ip, idleSession.refreshToken);

    // A rotated token presented again revokes the family.
    reuseSession = await signInAdmin(ip, admin);
    t.clock.advance(MINUTE_MS);
    rotated = await adminRefresh(ip, reuseSession.refreshToken);
    reused = await adminRefresh(ip, reuseSession.refreshToken);
    newestAfterReuse = await adminRefresh(ip, (rotated.body as AdminSessionBody).refreshToken);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("rotates on use: new tokens of the same family, mfa_at copied from the sign-in", () => {
    const first = refreshes[0] as Response;
    expectResponseToMatch("adminRefresh", first, { document: "platform" });
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    const session = first.body as AdminSessionBody;
    expect(session.refreshToken).not.toBe(signedIn.refreshToken);
    const claims = claimsOf(session.accessToken);
    expect(claims.sid).toBe(claimsOf(signedIn.accessToken).sid);
    expect(claims.mfa_at).toBe(Math.floor(signedInAt.getTime() / 1000));
    expect(claims.iat).toBe(Math.floor((refreshedAt[0] ?? signedInAt).getTime() / 1000));
    expect(session.admin.id).toBe(admin.account.id);
  });

  it("[PBE-028 AC1] a family older than 12 hours cannot refresh, and no token outlives it [PF-80]", async () => {
    const familyEnd = new Date(signedInAt.getTime() + ADMIN_FAMILY_TTL_MS);
    for (const [index, res] of [...refreshes, lastMinute].entries()) {
      expectResponseToMatch("adminRefresh", res, { document: "platform" });
      expect(outcomeOf(res), `refresh ${index + 1}`).toBe("200");
      const expiresAt = new Date((res.body as AdminSessionBody).refreshTokenExpiresAt);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(familyEnd.getTime());
    }
    // The sixth refresh (11 hours in) and the one a minute before the end get tokens that end with the family.
    expect((refreshes[5]?.body as AdminSessionBody).refreshTokenExpiresAt).toBe(familyEnd.toISOString());
    expect((lastMinute.body as AdminSessionBody).refreshTokenExpiresAt).toBe(familyEnd.toISOString());
    expect((refreshes[0]?.body as AdminSessionBody).refreshTokenExpiresAt).toBe(
      new Date((refreshedAt[0] ?? signedInAt).getTime() + ADMIN_REFRESH_TOKEN_TTL_MS).toISOString(),
    );

    expectResponseToMatch("adminRefresh", atTheEnd, { document: "platform" });
    expect(outcomeOf(atTheEnd)).toBe("401 REFRESH_TOKEN_INVALID");
    const family = await familyOf(claimsOf(signedIn.accessToken).sid);
    expect(family).toHaveLength(8);
    expect(family.every((row) => row.family_expires_at?.getTime() === familyEnd.getTime())).toBe(true);
    // The refused refresh changed nothing: the newest generation is still current, not rotated, not revoked.
    expect(family.at(-1)).toMatchObject({ rotated_at: null, revoked_at: null });
  });

  it("refuses a token left idle for more than 2 hours", () => {
    expectResponseToMatch("adminRefresh", idleExpired, { document: "platform" });
    expect(outcomeOf(idleExpired)).toBe("401 REFRESH_TOKEN_INVALID");
  });

  it("revokes the whole family when a rotated token comes back", async () => {
    expect(outcomeOf(rotated)).toBe("200");
    expectResponseToMatch("adminRefresh", reused, { document: "platform" });
    expect(outcomeOf(reused)).toBe("401 REFRESH_TOKEN_REUSED");
    expect(outcomeOf(newestAfterReuse)).toBe("401 REFRESH_TOKEN_INVALID");
    const family = await familyOf(claimsOf(reuseSession.accessToken).sid);
    expect(family).toHaveLength(2);
    expect(family.every((row) => row.revoked_at !== null && row.revoke_reason === "rotation_reuse")).toBe(
      true,
    );
    expect(t.logs.withMessage("auth.refresh_token_reused").at(-1)).toMatchObject({
      accountId: admin.account.id,
      familyId: family[0]?.family_id,
      audience: "platform_admin",
    });
  });
});

describe("portal and admin sessions never mix", () => {
  const ip = nextIp();
  let admin: MfaFixture;
  let adminSession: AdminSessionBody;
  let portalSession: { readonly accessToken: string; readonly refreshToken: string };
  let portalTokenAtAdmin: Response;
  let adminTokenAtPortal: Response;
  let portalStillRefreshes: Response;
  let adminStillRefreshes: Response;
  let portalAccessAtAdmin: Response;
  let adminAccessAtPortal: Response;
  let portalRowsBefore: Array<PlatformRow<"account_sessions">>;
  let portalRowsAfterAdminRefresh: Array<PlatformRow<"account_sessions">>;
  let revokedAdminMe: Response;
  let revokedAdminRefresh: Response;

  beforeAll(async () => {
    admin = await insertMfaAccount();
    adminSession = await signInAdmin(ip, admin);
    t.clock.advance(STEP_MS);
    // The same person signs in to the portal too (a platform admin is an ordinary account there).
    portalSession = await signInPortal(ip, admin.account, admin.secret);
    portalRowsBefore = (await sessionsOf(admin.account.id)).filter((row) => row.audience === "portal");
    portalTokenAtAdmin = await adminRefresh(ip, portalSession.refreshToken);
    portalRowsAfterAdminRefresh = (await sessionsOf(admin.account.id)).filter(
      (row) => row.audience === "portal",
    );
    adminTokenAtPortal = await post(ip, "/v1/auth/refresh", { refreshToken: adminSession.refreshToken });
    portalStillRefreshes = remember(
      await post(ip, "/v1/auth/refresh", { refreshToken: portalSession.refreshToken }),
    );
    adminStillRefreshes = await adminRefresh(ip, adminSession.refreshToken);
    portalAccessAtAdmin = await call("get", ip, "/v1/admin/me", { accessToken: portalSession.accessToken });
    adminAccessAtPortal = await call("get", ip, "/v1/me", { accessToken: adminSession.accessToken });

    // An admin whose flag is taken away loses the admin at once: no adminGetMe, no refresh.
    const current = adminStillRefreshes.body as AdminSessionBody;
    await pool.query("UPDATE platform.accounts SET is_platform_admin = false WHERE id = $1", [
      admin.account.id,
    ]);
    revokedAdminMe = await call("get", ip, "/v1/admin/me", { accessToken: current.accessToken });
    revokedAdminRefresh = await adminRefresh(ip, current.refreshToken);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-028 AC2] a portal refresh token answers REFRESH_TOKEN_INVALID at adminRefresh and changes nothing", () => {
    expectResponseToMatch("adminRefresh", portalTokenAtAdmin, { document: "platform" });
    expect(outcomeOf(portalTokenAtAdmin)).toBe("401 REFRESH_TOKEN_INVALID");
    expect(portalRowsAfterAdminRefresh).toEqual(portalRowsBefore);
    expect(portalRowsBefore).toHaveLength(1);
    expect(outcomeOf(portalStillRefreshes)).toBe("200");
  });

  it("[PBE-028 AC2] an admin refresh token answers REFRESH_TOKEN_INVALID at the portal's refreshSession", () => {
    expectResponseToMatch("refreshSession", adminTokenAtPortal, { document: "platform" });
    expect(outcomeOf(adminTokenAtPortal)).toBe("401 REFRESH_TOKEN_INVALID");
    expectResponseToMatch("adminRefresh", adminStillRefreshes, { document: "platform" });
    expect(outcomeOf(adminStillRefreshes)).toBe("200");
  });

  it("portal access tokens are refused on admin routes and admin access tokens on portal routes", () => {
    expectResponseToMatch("adminGetMe", portalAccessAtAdmin, { document: "platform" });
    expect(outcomeOf(portalAccessAtAdmin)).toBe("401 UNAUTHENTICATED");
    expectResponseToMatch("getMe", adminAccessAtPortal, { document: "platform" });
    expect(outcomeOf(adminAccessAtPortal)).toBe("401 UNAUTHENTICATED");
  });

  it("an account that is no longer a platform admin cannot use or refresh its admin session", () => {
    expectResponseToMatch("adminGetMe", revokedAdminMe, { document: "platform" });
    expect(outcomeOf(revokedAdminMe)).toBe("401 UNAUTHENTICATED");
    expectResponseToMatch("adminRefresh", revokedAdminRefresh, { document: "platform" });
    expect(outcomeOf(revokedAdminRefresh)).toBe("401 REFRESH_TOKEN_INVALID");
  });
});

describe("step-up and sign-out", () => {
  const ip = nextIp();
  let admin: MfaFixture;
  let other: MfaFixture;
  let session: AdminSessionBody;
  let otherSession: AdminSessionBody;
  let portalSession: { readonly accessToken: string; readonly refreshToken: string };
  let steppedUpAt: Date;
  let steppedUp: Response;
  let stepUpReplayed: Response;
  let stepUpWrong: Response;
  let stepUpWithPortalToken: Response;
  let oldTokenAfterStepUp: Response;
  let signOutOthers: Response;
  let signOutPortalToken: Response;
  let signOutWithoutToken: Response;
  let signOut: Response;
  let refreshAfterSignOut: Response;
  let otherStillRefreshes: Response;

  beforeAll(async () => {
    admin = await insertMfaAccount();
    other = await insertMfaAccount();
    session = await signInAdmin(ip, admin);
    otherSession = await signInAdmin(ip, other);
    t.clock.advance(STEP_MS);
    portalSession = await signInPortal(ip, admin.account, admin.secret);
    t.clock.advance(20 * MINUTE_MS);
    // 20 minutes later the access token has expired: refresh it first, as the admin server does.
    session = (await adminRefresh(ip, session.refreshToken)).body as AdminSessionBody;

    steppedUpAt = t.clock.now();
    const code = currentCode(admin.secret);
    steppedUp = await post(ip, "/v1/admin/auth/step-up", { code }, session.accessToken);
    stepUpReplayed = await post(ip, "/v1/admin/auth/step-up", { code }, session.accessToken);
    stepUpWrong = await post(
      ip,
      "/v1/admin/auth/step-up",
      { code: wrongCode(admin.secret) },
      session.accessToken,
    );
    stepUpWithPortalToken = await post(ip, "/v1/admin/auth/step-up", { code }, portalSession.accessToken);

    const current = steppedUp.body as AdminSessionBody;
    const nextSession = (await adminRefresh(ip, current.refreshToken)).body as AdminSessionBody;
    signOutOthers = await post(
      ip,
      "/v1/admin/auth/sign-out",
      { refreshToken: otherSession.refreshToken },
      nextSession.accessToken,
    );
    signOutPortalToken = await post(
      ip,
      "/v1/admin/auth/sign-out",
      { refreshToken: portalSession.refreshToken },
      nextSession.accessToken,
    );
    signOutWithoutToken = await post(ip, "/v1/admin/auth/sign-out", {
      refreshToken: nextSession.refreshToken,
    });
    signOut = await post(
      ip,
      "/v1/admin/auth/sign-out",
      { refreshToken: nextSession.refreshToken },
      nextSession.accessToken,
    );
    refreshAfterSignOut = await adminRefresh(ip, nextSession.refreshToken);
    otherStillRefreshes = await adminRefresh(ip, otherSession.refreshToken);
    // Last, as it revokes the family: the refresh token the step-up replaced is used up.
    oldTokenAfterStepUp = await adminRefresh(ip, session.refreshToken);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("adminStepUp answers a new session of the same family whose token carries mfa_at = now", async () => {
    expectResponseToMatch("adminStepUp", steppedUp, { document: "platform" });
    expect(steppedUp.status).toBe(200);
    expect(steppedUp.headers["cache-control"]).toBe("no-store");
    const body = steppedUp.body as AdminSessionBody;
    const claims = claimsOf(body.accessToken);
    const before = claimsOf(session.accessToken);
    expect(claims.sid).toBe(before.sid);
    expect(claims.mfa_at).toBe(Math.floor(steppedUpAt.getTime() / 1000));
    expect(before.mfa_at).toBeLessThan(claims.mfa_at ?? 0);
    const family = await familyOf(claims.sid);
    const newest = family.find((row) => row.refresh_token_hash === sha256Hex(body.refreshToken));
    expect(newest).toMatchObject({ audience: "platform_admin", mfa_verified_at: steppedUpAt });
    // The refresh token the step-up replaced is used up: presenting it again is a reuse.
    expectResponseToMatch("adminRefresh", oldTokenAfterStepUp, { document: "platform" });
    expect(outcomeOf(oldTokenAfterStepUp)).toBe("401 REFRESH_TOKEN_REUSED");
  });

  it("adminStepUp refuses a replayed or wrong code, and a portal token", () => {
    for (const res of [stepUpReplayed, stepUpWrong, stepUpWithPortalToken]) {
      expectResponseToMatch("adminStepUp", res, { document: "platform" });
    }
    expect(outcomeOf(stepUpReplayed)).toBe("401 MFA_CODE_INVALID");
    expect(outcomeOf(stepUpWrong)).toBe("401 MFA_CODE_INVALID");
    expect(outcomeOf(stepUpWithPortalToken)).toBe("401 UNAUTHENTICATED");
  });

  it("adminSignOut revokes the caller's admin family only, answering 204 either way", async () => {
    for (const res of [signOutOthers, signOutPortalToken, signOut, signOutWithoutToken]) {
      expectResponseToMatch("adminSignOut", res, { document: "platform" });
    }
    expect([signOutOthers, signOutPortalToken, signOut].map((res) => res.status)).toEqual([204, 204, 204]);
    expect(outcomeOf(signOutWithoutToken)).toBe("401 UNAUTHENTICATED");
    expect(outcomeOf(refreshAfterSignOut)).toBe("401 REFRESH_TOKEN_INVALID");
    expect(outcomeOf(otherStillRefreshes)).toBe("200");
    const rows = await sessionsOf(admin.account.id);
    // Revoked by the sign-out itself (a later reuse of a rotated token finds nothing left to revoke).
    expect(
      rows
        .filter((row) => row.audience === "platform_admin")
        .every((row) => row.revoked_at !== null && row.revoke_reason === "logout"),
    ).toBe(true);
    expect(rows.filter((row) => row.audience === "portal").every((row) => row.revoked_at === null)).toBe(
      true,
    );
  });
});

describe("the logs and the audit rows", () => {
  it("never hold a password, token, TOTP secret or recovery code of this file", async () => {
    expect(secrets.size).toBeGreaterThan(30);
    const text = t.logs.lines.map((line) => JSON.stringify(line)).join("\n");
    const { rows } = await pool.query("SELECT * FROM platform.platform_audit_log");
    const audit = JSON.stringify(rows);
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
    // The calls were logged (one request line each), so the scan read something.
    expect(t.logs.lines.filter((line) => line["msg"] === "request completed").length).toBeGreaterThan(30);
  });
});
