// Portal sessions after the sign-in (PBE-014; scope PF-03 AC3 and PF-06 AC2, PADR-0009 item 4, PADR-0007 item 6,
// architecture §3.1 and §6.3) through the HTTP pipeline (createTestApp) on this file's database clone and Redis
// database: refreshSession rotates on use and revokes the whole family when a rotated token comes back (also when two
// refreshes race with one token), copies `mfa_at` from the family, refuses expired families and admin families;
// signOut revokes one family of the caller; signOutEverywhere revokes every family of the account, writes the OTA
// cut-off `staffdeny:acct:<id>` with its TTL, audits and publishes an `account` invalidation. Every answer is checked
// against the platform document, and no log line holds a token.
//
// The sessions start with a real sign-in (Argon2id) in the setup hooks, with explicit bounds; an MFA family and an
// admin family, which PBE-015 and PBE-028 write, are inserted as rows with a refresh token the test knows (only its
// SHA-256 is stored, as AuthModule stores it). Each group signs in from an end-user IP of its own (RFC 5737), so the
// per-IP sign-in limit of one group never touches another.
import { generateToken, sha256Hex } from "@velexis/crypto";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { redisKeys, STAFF_DENY_ACCOUNT_TTL_SECONDS } from "../../../src/common/redis/redis-keys";
import { TEST_PASSWORD } from "../../builders/accounts";
import { insertAccount, insertRow, testId, type PlatformRow } from "../../builders/platform-rows";
import { createTestApp, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and parsing the platform document take about two seconds alone; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few sign-ins (Argon2id verifications) and refreshes; seconds at most, bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the invalidation event of a commit. */
const WAIT_MS = 10_000;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;
/** The Argon2id hash of TEST_PASSWORD, made once and shared by the accounts of this file. */
let passwordHash: string;
/** The `account` invalidations this file's accounts received. */
const invalidated: InvalidationEvent[] = [];
const accountsOfThisFile = new Set<string>();

/** Every token this file sent or received, for the log scan. */
const secrets = new Set<string>([TEST_PASSWORD]);

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each group of calls, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${100 + ipCounter}`;
}

/** The tokens of a PortalSession answer, as far as the tests read them. */
interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

function remember(res: Response): Response {
  const body = res.body as Record<string, unknown>;
  for (const field of ["accessToken", "refreshToken"]) {
    if (typeof body[field] === "string") {
      secrets.add(body[field]);
    }
  }
  return res;
}

/** An active, verified account that signs in with TEST_PASSWORD. */
async function newAccount(): Promise<PlatformRow<"accounts">> {
  const account = await insertAccount(pool, { password_hash: passwordHash });
  accountsOfThisFile.add(account.id);
  return account;
}

/** Signs `account` in from `ip` and returns the PortalSession. */
async function signIn(ip: string, account: Pick<PlatformRow<"accounts">, "email">): Promise<Session> {
  const res = remember(
    await t.http
      .post("/v1/auth/sign-in")
      .set(t.bffHeaders(ip))
      .send({ email: account.email, password: TEST_PASSWORD }),
  );
  expect(res.status).toBe(200);
  return res.body as Session;
}

async function refresh(refreshToken: string, ip = "203.0.113.90"): Promise<Response> {
  secrets.add(refreshToken);
  return remember(await t.http.post("/v1/auth/refresh").set(t.bffHeaders(ip)).send({ refreshToken }));
}

/** `Authorization: Bearer` of `session` and the BFF headers. */
function authOf(session: Pick<Session, "accessToken">, ip = "203.0.113.91"): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}`, ...t.bffHeaders(ip) };
}

/** `200`, or the status and the error code of the envelope (whose request id is the header's). */
function outcomeOf(res: Response): string {
  if (res.status < 300) {
    return String(res.status);
  }
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return `${res.status} ${error.code}`;
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

let rowCounter = 0;
/**
 * Inserts the first row of a family of `account` as another task writes it (an MFA sign-in of PBE-015, an admin
 * sign-in of PBE-028), and returns the plain refresh token whose SHA-256 it stores.
 */
async function insertFamily(
  account: Pick<PlatformRow<"accounts">, "id">,
  values: { audience: "portal" | "platform_admin"; mfaVerifiedAt: Date | null; lifetimeMs: number },
): Promise<{ readonly familyId: string; readonly refreshToken: string }> {
  rowCounter += 1;
  const familyId = testId("asn", 9000 + rowCounter);
  const { token, hash } = generateToken("rt");
  secrets.add(token);
  const now = t.clock.now();
  await insertRow(pool, "account_sessions", {
    id: familyId,
    account_id: account.id,
    family_id: familyId,
    audience: values.audience,
    refresh_token_hash: hash,
    expires_at: new Date(now.getTime() + Math.min(values.lifetimeMs, 7 * DAY_MS)),
    family_expires_at: new Date(now.getTime() + values.lifetimeMs),
    mfa_verified_at: values.mfaVerifiedAt,
    created_at: now,
    updated_at: now,
  });
  return { familyId, refreshToken: token };
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

beforeAll(async () => {
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  // Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same
  // time, so only the events about this file's accounts are kept.
  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-refresh-test" });
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
}, SETUP_TIMEOUT_MS);

describe("refreshSession", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let first: Session;
  let second: Response;
  let third: Response;
  let reused: Response;
  let newest: Response;
  let rotatedAt: Date;
  let reusedAt: Date;

  beforeAll(async () => {
    account = await newAccount();
    first = await signIn(ip, account);
    t.clock.advance(MINUTE_MS);
    rotatedAt = t.clock.now();
    second = await refresh(first.refreshToken);
    t.clock.advance(MINUTE_MS);
    third = await refresh((second.body as Session).refreshToken);
    t.clock.advance(MINUTE_MS);
    reusedAt = t.clock.now();
    reused = await refresh(first.refreshToken);
    newest = await refresh((third.body as Session).refreshToken);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("rotates on use: a new access token and refresh token of the same family, the presented token used up", async () => {
    for (const res of [second, third]) {
      expectResponseToMatch("refreshSession", res, { document: "platform" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const sid = (await tokens.verify(first.accessToken, "portal")).sid;
    const secondBody = second.body as Session & { accessTokenExpiresAt: string; account: { id: string } };
    const claims = await tokens.verify(secondBody.accessToken, "portal");
    expect(claims).toMatchObject({ sub: account.id, sid, ev: true, amr: ["pwd"] });
    expect(secondBody.accessTokenExpiresAt).toBe(
      new Date(rotatedAt.getTime() + 15 * MINUTE_MS).toISOString(),
    );
    expect(secondBody.refreshTokenExpiresAt).toBe(new Date(rotatedAt.getTime() + 7 * DAY_MS).toISOString());
    expect(secondBody.account.id).toBe(account.id);
    expect(
      new Set([first.refreshToken, secondBody.refreshToken, (third.body as Session).refreshToken]).size,
    ).toBe(3);

    const rows = await familyOf(sid);
    expect(rows.map((row) => row.refresh_token_hash)).toEqual(
      [first, second.body as Session, third.body as Session].map((session) =>
        sha256Hex(session.refreshToken),
      ),
    );
    expect(rows[0]).toMatchObject({
      rotated_at: rotatedAt,
      last_used_at: rotatedAt,
      replaced_by_id: rows[1]?.id,
    });
    expect(rows[1]).toMatchObject({ replaced_by_id: rows[2]?.id });
    // Every generation keeps the family's end, 30 days after the sign-in.
    expect(new Set(rows.map((row) => row.family_expires_at?.toISOString())).size).toBe(1);
  });

  it("[PBE-014 AC3] reusing a rotated refresh token revokes the family, so the newest token of the family fails too [PF-03 AC3]", async () => {
    expectResponseToMatch("refreshSession", reused, { document: "platform" });
    expectResponseToMatch("refreshSession", newest, { document: "platform" });
    expect(outcomeOf(reused)).toBe("401 REFRESH_TOKEN_REUSED");
    expect(outcomeOf(newest)).toBe("401 REFRESH_TOKEN_INVALID");
    const sid = (await tokens.verify(first.accessToken, "portal")).sid;
    expect((await familyOf(sid)).map((row) => [row.revoked_at, row.revoke_reason])).toEqual([
      [reusedAt, "rotation_reuse"],
      [reusedAt, "rotation_reuse"],
      [reusedAt, "rotation_reuse"],
    ]);
    expect(t.logs.withMessage("auth.refresh_token_reused")).toEqual([
      expect.objectContaining({ level: 40, accountId: account.id, familyId: sid }),
    ]);
  });

  it("answers 400 VALIDATION_FAILED for a body without a refresh token, and REFRESH_TOKEN_INVALID for an unknown one", async () => {
    const empty = await t.http.post("/v1/auth/refresh").set(t.bffHeaders(ip)).send({});
    const unknown = await refresh(`rt_${"U".repeat(43)}`);

    expectResponseToMatch("refreshSession", empty, { document: "platform" });
    expectResponseToMatch("refreshSession", unknown, { document: "platform" });
    expect(outcomeOf(empty)).toBe("400 VALIDATION_FAILED");
    expect(outcomeOf(unknown)).toBe("401 REFRESH_TOKEN_INVALID");
  });
});

describe("two refreshes with one token at the same time", () => {
  const ip = nextIp();
  let answers: Response[];
  let sid: string;
  let afterRace: Response;

  beforeAll(async () => {
    const account = await newAccount();
    const session = await signIn(ip, account);
    sid = (await tokens.verify(session.accessToken, "portal")).sid;
    answers = await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken)]);
    const winner = answers.find((res) => res.status === 200);
    afterRace = await refresh((winner?.body as Session | undefined)?.refreshToken ?? "none");
  }, GROUP_SETUP_TIMEOUT_MS);

  it("rotates once, sees the second as a reuse and revokes the family, the new token included", async () => {
    for (const res of answers) {
      expectResponseToMatch("refreshSession", res, { document: "platform" });
    }
    expect(answers.map(outcomeOf).sort()).toEqual(["200", "401 REFRESH_TOKEN_REUSED"]);
    expect(outcomeOf(afterRace)).toBe("401 REFRESH_TOKEN_INVALID");
    const rows = await familyOf(sid);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revoke_reason === "rotation_reuse")).toBe(true);
  });
});

describe("families written by other sign-ins", () => {
  let mfaRefresh: Response;
  let verifiedAt: Date;
  let mfaFamily: string;
  let admin: { familyId: string; refreshToken: string };
  let adminRefresh: Response;
  let adminRowsBefore: Array<PlatformRow<"account_sessions">>;

  beforeAll(async () => {
    const account = await newAccount();
    verifiedAt = new Date(t.clock.now().getTime() - 5 * MINUTE_MS);
    const mfa = await insertFamily(account, {
      audience: "portal",
      mfaVerifiedAt: verifiedAt,
      lifetimeMs: 30 * DAY_MS,
    });
    mfaFamily = mfa.familyId;
    mfaRefresh = await refresh(mfa.refreshToken);
    const adminAccount = await newAccount();
    admin = await insertFamily(adminAccount, {
      audience: "platform_admin",
      mfaVerifiedAt: t.clock.now(),
      lifetimeMs: 12 * 60 * MINUTE_MS,
    });
    adminRowsBefore = await familyOf(admin.familyId);
    adminRefresh = await refresh(admin.refreshToken);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("copies mfa_at from the family's mfa_verified_at into the new access token", async () => {
    expectResponseToMatch("refreshSession", mfaRefresh, { document: "platform" });
    expect(mfaRefresh.status).toBe(200);
    const claims = await tokens.verify((mfaRefresh.body as Session).accessToken, "portal");
    expect(claims).toMatchObject({
      sid: mfaFamily,
      amr: ["pwd", "otp"],
      mfa_at: Math.floor(verifiedAt.getTime() / 1000),
    });
    expect((await familyOf(mfaFamily)).map((row) => row.mfa_verified_at)).toEqual([verifiedAt, verifiedAt]);
  });

  it("refuses an admin family's token on the portal surface and leaves it as it was", async () => {
    expectResponseToMatch("refreshSession", adminRefresh, { document: "platform" });
    expect(outcomeOf(adminRefresh)).toBe("401 REFRESH_TOKEN_INVALID");
    expect(await familyOf(admin.familyId)).toEqual(adminRowsBefore);
  });
});

describe("expiry", () => {
  const ip = nextIp();
  let idle: Response;
  let atFamilyEnd: Response;
  let lastBeforeEnd: Response;
  let familyEnd: Date;

  beforeAll(async () => {
    const idleAccount = await newAccount();
    const idleSession = await signIn(ip, idleAccount);
    const account = await newAccount();
    let session = await signIn(ip, account);
    familyEnd = new Date(t.clock.now().getTime() + 30 * DAY_MS);
    // The second session is refreshed within every 7 days (days 6, 12, 18, 24 and 29) until its family's 30 days are
    // over; the first one is not used, and on day 7 its token has expired.
    for (const step of [6, 1, 5, 6, 6, 5]) {
      t.clock.advance(step * DAY_MS);
      if (step === 1) {
        idle = await refresh(idleSession.refreshToken);
        continue;
      }
      lastBeforeEnd = await refresh(session.refreshToken);
      session = lastBeforeEnd.body as Session;
    }
    t.clock.set(familyEnd);
    atFamilyEnd = await refresh(session.refreshToken);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("answers REFRESH_TOKEN_INVALID after 7 idle days, and at the end of the family's 30 days", () => {
    expectResponseToMatch("refreshSession", idle, { document: "platform" });
    expectResponseToMatch("refreshSession", atFamilyEnd, { document: "platform" });
    expect(outcomeOf(idle)).toBe("401 REFRESH_TOKEN_INVALID");
    expect(outcomeOf(atFamilyEnd)).toBe("401 REFRESH_TOKEN_INVALID");
    // The last token before the end (day 29) was cut to the family's end instead of 7 days.
    expectResponseToMatch("refreshSession", lastBeforeEnd, { document: "platform" });
    expect(outcomeOf(lastBeforeEnd)).toBe("200");
    expect((lastBeforeEnd.body as Session).refreshTokenExpiresAt).toBe(familyEnd.toISOString());
  });
});

describe("signOut", () => {
  const ip = nextIp();
  let current: Session;
  let other: Session;
  let stranger: Session;
  let signedOut: Response;
  let withStrangersToken: Response;
  let withoutToken: Response;
  let currentFamily: string;

  beforeAll(async () => {
    const account = await newAccount();
    current = await signIn(ip, account);
    other = await signIn(ip, account);
    stranger = await signIn(ip, await newAccount());
    currentFamily = (await tokens.verify(current.accessToken, "portal")).sid;
    withStrangersToken = await t.http
      .post("/v1/auth/sign-out")
      .set(authOf(current))
      .send({ refreshToken: stranger.refreshToken });
    signedOut = await t.http
      .post("/v1/auth/sign-out")
      .set(authOf(current))
      .send({ refreshToken: current.refreshToken });
    withoutToken = await t.http
      .post("/v1/auth/sign-out")
      .set(t.bffHeaders(ip))
      .send({ refreshToken: other.refreshToken });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("revokes the caller's family of the presented token, and nothing else", async () => {
    for (const res of [signedOut, withStrangersToken, withoutToken]) {
      expectResponseToMatch("signOut", res, { document: "platform" });
    }
    expect(outcomeOf(withStrangersToken)).toBe("204");
    expect(outcomeOf(signedOut)).toBe("204");
    expect(outcomeOf(withoutToken)).toBe("401 UNAUTHENTICATED");
    expect(await familyOf(currentFamily)).toEqual([
      expect.objectContaining({ revoked_at: t.clock.now(), revoke_reason: "logout" }),
    ]);
    expect(outcomeOf(await refresh(current.refreshToken))).toBe("401 REFRESH_TOKEN_INVALID");
    expect(outcomeOf(await refresh(other.refreshToken))).toBe("200");
    expect(outcomeOf(await refresh(stranger.refreshToken))).toBe("200");
  });
});

describe("signOutEverywhere", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let sessions: Session[];
  let admin: { familyId: string; refreshToken: string };
  let stranger: Session;
  let res: Response;
  let signedOutAt: Date;
  let withoutToken: Response;

  beforeAll(async () => {
    account = await newAccount();
    sessions = [await signIn(ip, account), await signIn(ip, account)];
    admin = await insertFamily(account, {
      audience: "platform_admin",
      mfaVerifiedAt: t.clock.now(),
      lifetimeMs: 12 * 60 * MINUTE_MS,
    });
    stranger = await signIn(ip, await newAccount());
    t.clock.advance(MINUTE_MS);
    signedOutAt = t.clock.now();
    withoutToken = await t.http.post("/v1/auth/sign-out-everywhere").set(t.bffHeaders(ip));
    res = await t.http.post("/v1/auth/sign-out-everywhere").set(authOf(sessions[0] as Session));
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-014 AC4] sign out everywhere revokes every family and sets staffdeny:acct:<id> with a TTL [PF-06 AC2]", async () => {
    expectResponseToMatch("signOutEverywhere", res, { document: "platform" });
    expectResponseToMatch("signOutEverywhere", withoutToken, { document: "platform" });
    expect(outcomeOf(res)).toBe("204");
    expect(outcomeOf(withoutToken)).toBe("401 UNAUTHENTICATED");

    // Every family of the account, portal and admin alike, is revoked; another account's is not.
    const rows = await sessionsOf(account.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.audience, row.revoked_at, row.revoke_reason]).sort()).toEqual([
      ["platform_admin", signedOutAt, "logout"],
      ["portal", signedOutAt, "logout"],
      ["portal", signedOutAt, "logout"],
    ]);
    for (const token of [...sessions.map((session) => session.refreshToken), admin.refreshToken]) {
      expect(outcomeOf(await refresh(token))).toBe("401 REFRESH_TOKEN_INVALID");
    }
    expect(outcomeOf(await refresh(stranger.refreshToken))).toBe("200");

    // The OTA cut-off: epoch milliseconds of the sign-out, for 30 days.
    const key = redisKeys.staffDenyAccount(account.id).key;
    expect(key).toBe(`staffdeny:acct:${account.id}`);
    expect(await t.redis.client.get(key)).toBe(String(signedOutAt.getTime()));
    const ttl = await t.redis.client.pttl(key);
    expect(ttl).toBeGreaterThan((STAFF_DENY_ACCOUNT_TTL_SECONDS - 60) * 1000);
    expect(ttl).toBeLessThanOrEqual(STAFF_DENY_ACCOUNT_TTL_SECONDS * 1000);
    expect(STAFF_DENY_ACCOUNT_TTL_SECONDS).toBe(30 * 24 * 60 * 60);

    // Audited, and announced to the OTA backend after the commit.
    const { rows: audit } = await pool.query(
      "SELECT actor_type, actor_account_id, target_type, target_id, ip_address, request_id, details " +
        "FROM platform.platform_audit_log WHERE action = 'auth.signed_out_everywhere' AND target_id = $1",
      [account.id],
    );
    expect(audit).toEqual([
      {
        actor_type: "account",
        actor_account_id: account.id,
        target_type: "account",
        target_id: account.id,
        ip_address: "203.0.113.91",
        request_id: res.headers["x-request-id"],
        details: { revokedFamilies: 3, staffDenyFrom: signedOutAt.toISOString() },
      },
    ]);
    expect(await invalidationOf(account.id)).toEqual({ v: 1, type: "account", accountId: account.id });
  });
});

describe("the logs", () => {
  it("never hold a token or a password of this file", () => {
    expect(secrets.size).toBeGreaterThan(10);
    const text = t.logs.lines.map((line) => JSON.stringify(line)).join("\n");
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  });
});
