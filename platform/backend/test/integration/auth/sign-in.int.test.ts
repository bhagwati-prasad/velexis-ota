// Password sign-in to the portal (PBE-014; platform/docs/flows/signup-and-create-ota.md step 4 and "Failure handling",
// scope PF-03 AC1 and AC2, PADR-0008, PADR-0009 item 4) through the HTTP pipeline (createTestApp) on this file's
// database clone and Redis database: the session of valid credentials, the same answer for a wrong address and a wrong
// password, the lockout after five failures with `Retry-After`, the disabled account, the MFA challenge, the rate
// limit, and no password or token in any log line. Every answer is checked against the platform document.
//
// PasswordPolicy is the real one (Argon2id), wrapped so the test sees which hash each sign-in was verified against
// (only the parameters `$argon2id$v=19$m=…,t=…,p=…`, never a password): a wrong address must cost the same
// verification as a wrong password, without timing anything. Every group of calls comes from an end-user IP of its own
// (documentation addresses, RFC 5737), so the per-IP sign-in limit of one group never touches another. The sign-ins
// (Argon2id, 19 MiB and 2 passes each) run in the setup hooks of each group, with explicit bounds; the tests then
// check what happened.
import { readFileSync } from "node:fs";
import { sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MfaChallengeStore } from "../../../src/auth/mfa-challenge.store";
import {
  BREACHED_PASSWORDS_FILE,
  parseBreachedPasswords,
  PasswordPolicy,
} from "../../../src/auth/password-policy";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { redisKeys } from "../../../src/common/redis/redis-keys";
import { TEST_PASSWORD } from "../../builders/accounts";
import { insertAccount, type AccountRow, type PlatformRow } from "../../builders/platform-rows";
import { insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and parsing the platform document take about two seconds alone; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few sign-ups' worth of Argon2id hashing and verification; seconds at most, bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Safari/605.1.15";
/** The Argon2id parameters of ADR-0008 as a PHC string starts with them. */
const ARGON2_PARAMETERS = "$argon2id$v=19$m=19456,t=2,p=1";

/** PasswordPolicy that notes the parameters of every hash it verifies against (never the hash or the password). */
class RecordingPasswordPolicy extends PasswordPolicy {
  readonly verifiedAgainst: string[] = [];

  override async verify(passwordHash: string, password: string): Promise<boolean> {
    this.verifiedAgainst.push(passwordHash.split("$").slice(0, 4).join("$"));
    return super.verify(passwordHash, password);
  }
}

const passwords = new RecordingPasswordPolicy(
  parseBreachedPasswords(readFileSync(BREACHED_PASSWORDS_FILE, "utf8")),
);

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
/** The Argon2id hash of TEST_PASSWORD, made once and shared by the accounts of this file. */
let passwordHash: string;

/** Every password and token this file sent or received, for the log scan. */
const secrets = new Set<string>([TEST_PASSWORD]);

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each group of calls, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `192.0.2.${ipCounter}`;
}

/** An account that signs in with TEST_PASSWORD (active and verified unless `overrides` say otherwise). */
function insertSignInAccount(overrides: Partial<AccountRow> = {}): Promise<PlatformRow<"accounts">> {
  return insertAccount(pool, { password_hash: passwordHash, ...overrides });
}

async function signIn(ip: string, email: string, password: string): Promise<Response> {
  secrets.add(password);
  const res = await t.http
    .post("/v1/auth/sign-in")
    .set(t.bffHeaders(ip, USER_AGENT))
    .send({ email, password });
  const body = res.body as Record<string, unknown>;
  for (const field of ["accessToken", "refreshToken", "mfaChallengeToken"]) {
    if (typeof body[field] === "string") {
      secrets.add(body[field]);
    }
  }
  return res;
}

/** The error envelope, as far as the tests read it. */
interface ErrorBody {
  readonly error: { readonly code: string; readonly requestId: string };
}

/** The error code of an answer, with the request id in the body and the header. */
function errorCode(res: Response): string {
  const { error } = res.body as ErrorBody;
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.code;
}

/**
 * Headers that differ between any two answers: the request id, the time, and Express's ETag, a digest of the body,
 * which holds the request id.
 */
const PER_ANSWER_HEADERS = new Set(["x-request-id", "date", "etag"]);

/**
 * What two error answers must share to be the same answer: the status, every header with its value, and the body with
 * its request id (which differs between any two answers) set aside.
 */
function answerShape(res: Response): Record<string, unknown> {
  const { error } = res.body as ErrorBody;
  return {
    status: res.status,
    body: res.text.replace(error.requestId, "<request id>"),
    headers: Object.entries(res.headers as Record<string, unknown>)
      .filter(([name]) => !PER_ANSWER_HEADERS.has(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  };
}

/** The audit rows of `action` about `targetId`, oldest first. */
async function auditRows(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, target_type, target_id, ip_address, user_agent, request_id, details " +
      "FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, targetId],
  );
  return rows as Array<Record<string, unknown>>;
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

beforeAll(async () => {
  // Every line at every level is captured, so "no log line holds a password or a token" covers debug and trace too.
  t = await createTestApp({
    env: { LOG_LEVEL: "trace" },
    overrides: [{ provide: PasswordPolicy, useValue: passwords }],
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  passwordHash = await passwords.hash(TEST_PASSWORD);
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("valid credentials", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let tenant: PlatformRow<"tenants">;
  let membershipId: string;
  let res: Response;
  let signedInAt: Date;

  beforeAll(async () => {
    account = await insertSignInAccount({ email: "Kari.Nordmann@example.com", failed_login_count: 2 });
    const ota = await insertOta(pool, { members: [[account, "owner"]], tenant: { name: "Fjord Travel" } });
    tenant = ota.tenant;
    membershipId = ota.memberships[0]?.id ?? "";
    // A removed membership of another OTA is not shown.
    const other = await insertOta(pool);
    await insertMembership(pool, other.tenant, account, { role: "admin", status: "removed" });
    signedInAt = t.clock.now();
    // The address in other letters: still the same account.
    res = await signIn(ip, "kari.nordmann@EXAMPLE.com", TEST_PASSWORD);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-014 AC1] valid credentials return a 15-minute access token and a refresh token [PF-03 AC1]", async () => {
    expectResponseToMatch("signIn", res, { document: "platform" });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as {
      accessToken: string;
      accessTokenExpiresAt: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
      account: Record<string, unknown>;
    };
    const claims = await tokens.verify(body.accessToken, "portal");
    expect(claims).toMatchObject({ sub: account.id, ev: true, amr: ["pwd"], typ: "portal" });
    expect(claims.mfa_at).toBeUndefined();
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect(body.accessTokenExpiresAt).toBe(new Date(signedInAt.getTime() + 15 * MINUTE_MS).toISOString());
    expect(body.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(body.refreshTokenExpiresAt).toBe(new Date(signedInAt.getTime() + 7 * DAY_MS).toISOString());
    expect(body.account).toEqual({
      id: account.id,
      email: "Kari.Nordmann@example.com",
      emailVerified: true,
      fullName: account.full_name,
      locale: "en",
      timeZone: "UTC",
      mfaEnabled: false,
      mfaEnabledAt: null,
      isPlatformAdmin: false,
      createdAt: account.created_at.toISOString(),
      version: account.version,
      memberships: [
        {
          membershipId,
          tenantId: tenant.id,
          tenantKey: tenant.key,
          tenantName: "Fjord Travel",
          tenantStatus: "active",
          role: "owner",
        },
      ],
      features: {
        stripeBilling: false,
        ownStripe: false,
        settlements: false,
        ownAmadeus: false,
        customDomains: false,
        liveSwitch: false,
      },
    });

    // One new refresh family: only the SHA-256 of the token, the end user's device, 30 days absolute, 7 days idle.
    expect(await sessionsOf(account.id)).toEqual([
      expect.objectContaining({
        id: claims.sid,
        family_id: claims.sid,
        audience: "portal",
        refresh_token_hash: sha256Hex(body.refreshToken),
        user_agent: USER_AGENT,
        ip_address: ip,
        expires_at: new Date(signedInAt.getTime() + 7 * DAY_MS),
        family_expires_at: new Date(signedInAt.getTime() + 30 * DAY_MS),
        mfa_verified_at: null,
        rotated_at: null,
        revoked_at: null,
        created_at: signedInAt,
      }),
    ]);
    // The failures are reset and the sign-in noted, without touching the profile's version.
    expect(await accountRow(account.id)).toMatchObject({
      failed_login_count: 0,
      locked_until: null,
      last_login_at: signedInAt,
      version: account.version,
    });
    expect(await auditRows("auth.sign_in", claims.sid)).toEqual([
      {
        actor_type: "account",
        actor_account_id: account.id,
        target_type: "session",
        target_id: claims.sid,
        ip_address: ip,
        user_agent: USER_AGENT,
        request_id: res.headers["x-request-id"],
        details: { audience: "portal", mfa: false },
      },
    ]);
  });
});

describe("an account that waits for e-mail verification", () => {
  const ip = nextIp();
  let res: Response;
  let checked: Response;
  let signedOut: Response;

  beforeAll(async () => {
    const account = await insertSignInAccount({ status: "pending_verification", email_verified_at: null });
    res = await signIn(ip, account.email, TEST_PASSWORD);
    const { accessToken, refreshToken } = res.body as { accessToken: string; refreshToken: string };
    const auth = { Authorization: `Bearer ${accessToken}`, ...t.bffHeaders(ip) };
    // checkTenantKey is a `portal` operation; sign-out is `portal_unverified`.
    checked = await t.http.get("/v1/tenants/key-availability").query({ key: "fjordtravel" }).set(auth);
    signedOut = await t.http.post("/v1/auth/sign-out").set(auth).send({ refreshToken });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("signs in with ev = false and reaches only the portal_unverified operations [PF-02 AC3]", async () => {
    expectResponseToMatch("signIn", res, { document: "platform" });
    expect(res.status).toBe(200);
    const { accessToken, account } = res.body as { accessToken: string; account: { emailVerified: boolean } };
    expect((await tokens.verify(accessToken, "portal")).ev).toBe(false);
    expect(account.emailVerified).toBe(false);
    expectResponseToMatch("checkTenantKey", checked, { document: "platform" });
    expect(`${checked.status} ${errorCode(checked)}`).toBe("403 EMAIL_NOT_VERIFIED");
    expectResponseToMatch("signOut", signedOut, { document: "platform" });
    expect(signedOut.status).toBe(204);
  });
});

describe("wrong credentials and the lockout", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let unknown: Response;
  const failures: Response[] = [];
  let lockedAt: Date;
  let whileLocked: Response;
  let verifiedWhileLocked: number;
  let afterLockout: Response;
  let verifiedAgainst: string[];

  beforeAll(async () => {
    account = await insertSignInAccount();
    passwords.verifiedAgainst.length = 0;
    unknown = await signIn(ip, "nobody-signed-up-here@example.com", "Wrong-Password-2026");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      failures.push(await signIn(ip, account.email, `Wrong-Password-${attempt}`));
    }
    lockedAt = t.clock.now();
    verifiedAgainst = [...passwords.verifiedAgainst];
    // Ten minutes later the right password is still refused, without being verified.
    t.clock.advance(10 * MINUTE_MS);
    whileLocked = await signIn(ip, account.email, TEST_PASSWORD);
    verifiedWhileLocked = passwords.verifiedAgainst.length - verifiedAgainst.length;
    // At the end of the 15 minutes it works again.
    t.clock.advance(5 * MINUTE_MS);
    afterLockout = await signIn(ip, account.email, TEST_PASSWORD);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-014 AC2] wrong e-mail and wrong password give identical bodies, after the same verification [PF-03 AC2]", () => {
    const wrongPassword = failures[0] as Response;
    for (const res of [unknown, wrongPassword]) {
      expectResponseToMatch("signIn", res, { document: "platform" });
      expect(`${res.status} ${errorCode(res)}`).toBe("401 INVALID_CREDENTIALS");
    }
    expect(answerShape(unknown)).toEqual(answerShape(wrongPassword));
    // One Argon2id verification each, with the same parameters: the unknown address against the dummy hash.
    expect(verifiedAgainst.slice(0, 2)).toEqual([ARGON2_PARAMETERS, ARGON2_PARAMETERS]);
  });

  it("[PBE-014 AC2] the fifth failure locks for 15 minutes with Retry-After [PF-03 AC2]", async () => {
    for (const res of [...failures, whileLocked]) {
      expectResponseToMatch("signIn", res, { document: "platform" });
    }
    expect(failures.map((res) => `${res.status} ${errorCode(res)}`)).toEqual([
      "401 INVALID_CREDENTIALS",
      "401 INVALID_CREDENTIALS",
      "401 INVALID_CREDENTIALS",
      "401 INVALID_CREDENTIALS",
      "423 ACCOUNT_LOCKED",
    ]);
    const fifth = failures[4] as Response;
    expect(fifth.headers["retry-after"]).toBe("900");
    expect(failures.slice(0, 4).map((res) => res.headers["retry-after"])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(`${whileLocked.status} ${errorCode(whileLocked)}`).toBe("423 ACCOUNT_LOCKED");
    expect(whileLocked.headers["retry-after"]).toBe("300");
    // Six verifications for the six calls before the lockout, and none for the attempt while locked.
    expect(verifiedAgainst).toEqual(Array.from({ length: 6 }, () => ARGON2_PARAMETERS));
    expect(verifiedWhileLocked).toBe(0);

    // The audit trail: five failures, the lockout with its end.
    const failed = await auditRows("auth.sign_in_failed", account.id);
    expect(failed.map((row) => row["details"])).toEqual(
      [1, 2, 3, 4, 5].map((count) => ({ reason: "invalid_password", failedLoginCount: count })),
    );
    expect(failed.every((row) => row["ip_address"] === ip)).toBe(true);
    expect(await auditRows("auth.locked", account.id)).toEqual([
      expect.objectContaining({
        actor_account_id: account.id,
        target_type: "account",
        request_id: fifth.headers["x-request-id"],
        details: {
          failedLoginCount: 5,
          after: { lockedUntil: new Date(lockedAt.getTime() + 15 * MINUTE_MS).toISOString() },
        },
      }),
    ]);
  });

  it("lets the right password in once the lockout has ended, and clears the count", async () => {
    expectResponseToMatch("signIn", afterLockout, { document: "platform" });
    expect(afterLockout.status).toBe(200);
    expect(await accountRow(account.id)).toMatchObject({
      failed_login_count: 0,
      locked_until: null,
      last_login_at: t.clock.now(),
    });
  });
});

describe("a disabled account", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let wrong: Response;
  let right: Response;

  beforeAll(async () => {
    account = await insertSignInAccount({ status: "disabled" });
    wrong = await signIn(ip, account.email, "Wrong-Password-2026");
    right = await signIn(ip, account.email, TEST_PASSWORD);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("answers 403 ACCOUNT_DISABLED only after a correct password", async () => {
    expectResponseToMatch("signIn", wrong, { document: "platform" });
    expectResponseToMatch("signIn", right, { document: "platform" });
    expect(`${wrong.status} ${errorCode(wrong)}`).toBe("401 INVALID_CREDENTIALS");
    expect(`${right.status} ${errorCode(right)}`).toBe("403 ACCOUNT_DISABLED");
    expect(await sessionsOf(account.id)).toEqual([]);
    expect((await auditRows("auth.sign_in_failed", account.id)).map((row) => row["details"])).toEqual([
      { reason: "invalid_password", failedLoginCount: 1 },
      { reason: "account_disabled", status: "disabled" },
    ]);
  });
});

describe("an account with MFA", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let res: Response;

  beforeAll(async () => {
    account = await insertSignInAccount({ mfa_enabled: true, failed_login_count: 3 });
    res = await signIn(ip, account.email, TEST_PASSWORD);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("answers an MFA challenge kept in Redis for 5 minutes, and no session yet", async () => {
    expectResponseToMatch("signIn", res, { document: "platform" });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as { mfaRequired: boolean; mfaChallengeToken: string; expiresIn: number };
    expect(body).toEqual({
      mfaRequired: true,
      mfaChallengeToken: expect.stringMatching(/^mfa_[A-Za-z0-9_-]{43}$/) as string,
      expiresIn: 300,
    });
    const key = redisKeys.mfaChallenge(sha256Hex(body.mfaChallengeToken)).key;
    const stored = JSON.parse((await t.redis.client.get(key)) ?? "null") as Record<string, unknown>;
    expect(stored).toEqual({
      v: 1,
      audience: "portal",
      accountId: account.id,
      issuedAt: t.clock.now().getTime(),
      maxAttempts: 5,
    });
    const ttl = await t.redis.client.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300_000);
    // Only the token's digest is in Redis.
    expect(await t.redis.client.keys(`*${body.mfaChallengeToken}*`)).toEqual([]);
    expect(await sessionsOf(account.id)).toEqual([]);
    expect(await accountRow(account.id)).toMatchObject({ failed_login_count: 0, last_login_at: null });
    expect(await auditRows("auth.sign_in", account.id)).toEqual([]);
  });

  it("finds the challenge by its token for verifyMfa (PBE-015), and nothing for another token once it ended", async () => {
    const store = t.app.get(MfaChallengeStore);
    const { mfaChallengeToken } = res.body as { mfaChallengeToken: string };
    expect(await store.find(mfaChallengeToken)).toEqual({
      v: 1,
      audience: "portal",
      accountId: account.id,
      issuedAt: expect.any(Number) as number,
      maxAttempts: 5,
    });
    // A challenge of this test's own, so the sign-in's challenge above stays as it is.
    const own = await store.create(account.id, "portal");
    secrets.add(own.token);
    expect(own.expiresIn).toBe(300);
    expect(await store.find(own.token)).toMatchObject({ accountId: account.id, audience: "portal" });
    await store.delete(own.token);
    expect(await store.find(own.token)).toBeUndefined();
    expect(await t.redis.client.exists(redisKeys.mfaChallenge(sha256Hex(own.token)).key)).toBe(0);
    for (const token of ["", `mfa_${"N".repeat(43)}`, "x".repeat(513)]) {
      expect(await store.find(token)).toBeUndefined();
    }
  });
});

describe("the request rules", () => {
  const ip = nextIp();
  const answers: Response[] = [];
  let withoutPassword: Response;

  beforeAll(async () => {
    withoutPassword = await t.http
      .post("/v1/auth/sign-in")
      .set(t.bffHeaders(nextIp()))
      .send({ email: "someone@example.com" });
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      answers.push(await signIn(ip, `nobody${attempt}@example.com`, "Wrong-Password-2026"));
    }
  }, GROUP_SETUP_TIMEOUT_MS);

  it("answers 400 VALIDATION_FAILED for a body without a password", () => {
    expectResponseToMatch("signIn", withoutPassword, { document: "platform" });
    expect(`${withoutPassword.status} ${errorCode(withoutPassword)}`).toBe("400 VALIDATION_FAILED");
  });

  it("counts 10 sign-ins per end-user IP per minute: the 11th answers 429 RATE_LIMITED with Retry-After", () => {
    for (const res of answers) {
      expectResponseToMatch("signIn", res, { document: "platform" });
    }
    expect(answers.map((res) => res.status)).toEqual([...Array.from({ length: 10 }, () => 401), 429]);
    const limited = answers[10] as Response;
    expect(errorCode(limited)).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
  });
});

describe("the logs", () => {
  it("never hold a password or a token of this file", () => {
    expect(secrets.size).toBeGreaterThan(10);
    const text = t.logs.lines.map((line) => JSON.stringify(line)).join("\n");
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
    // The sign-ins were logged (one request line each), so the scan read something.
    expect(t.logs.lines.filter((line) => line["msg"] === "request completed").length).toBeGreaterThan(10);
  });
});
