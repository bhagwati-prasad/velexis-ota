// The password reset (PBE-016; platform/docs/scope.md PF-05, api-inventory §4, ADR-0008 "Passwords", PADR-0007 item
// 6, PADR-0013) through the HTTP pipeline (createTestApp) on this file's database clone and Redis database, with the
// worker's module graph (WorkerModule, as dist/worker.js builds it, with the same FakeClock) sending the queued
// e-mails to Mailpit: requestPasswordReset answers the same `202` for every address and e-mails a link to active
// accounts only; confirmPasswordReset uses the link once within its hour, applies the password rules, revokes every
// session of the account, writes the OTA cut-off `staffdeny:acct:<id>`, e-mails the account, audits and publishes an
// `account` invalidation. Every answer is checked against the platform document, and no log line holds a token or a
// password.
//
// Every e-mail goes to an address of its own (`uniqueEmail`) and every group of calls comes from an end-user IP of its
// own (documentation addresses, RFC 5737), so the per-IP and per-address rate limits of one group never touch
// another. The slow parts (Argon2id, the worker's SMTP delivery and Mailpit's API) run in the setup hooks, with
// explicit bounds.
import { resolve } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { extractLinks, uniqueEmail, waitForMessage, type MailpitMessage } from "@velexis/testing/mailpit";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { redisKeys, STAFF_DENY_ACCOUNT_TTL_SECONDS } from "../../../src/common/redis/redis-keys";
import { createProcessLogger, PLATFORM_PROCESSES, type PlatformBackendConfig } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import {
  hoursFrom,
  insertAccountToken,
  insertUnverifiedAccount,
  TEST_PASSWORD,
  tokensOf,
} from "../../builders/accounts";
import { insertAccount, insertRow, testId, type PlatformRow } from "../../builders/platform-rows";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and the worker's module graph, and parsing the platform document, take about
 * two seconds alone; the bound allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/**
 * A group's setup: a few Argon2id hashes and verifications, and the worker's delivery of its e-mails to Mailpit; a
 * few seconds alone, bounded for CI load.
 */
const GROUP_SETUP_TIMEOUT_MS = 60_000;
/** How long the setup hooks wait for the worker's e-mails and the invalidation events. */
const WAIT_MS = 20_000;

const RESET_SUBJECT = "Reset your Velexis password";
const CHANGED_SUBJECT = "Your Velexis password was changed";
/** PUBLIC_PORTAL_URL of the test applications (TEST_MAIL_ENV). */
const PORTAL = "http://localhost:3000";
/** A new password that meets the rules; a test value, never a real password. */
const NEW_PASSWORD = "Silver-Fjord-Morning-7";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let subscriber: Redis;
const workerLogs = new LogSink();
/** The Argon2id hash of TEST_PASSWORD, made once and shared by the accounts of this file. */
let passwordHash: string;
/** The `account` invalidations this file's accounts received. */
const invalidated: InvalidationEvent[] = [];
const accountsOfThisFile = new Set<string>();

/** Every password and token this file used or received, for the log scan. */
const secrets = new Set<string>([TEST_PASSWORD, NEW_PASSWORD]);

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each group of calls, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${150 + ipCounter}`;
}

/** The development SMTP_URL (Mailpit) of the environment. */
function mailpitSmtpUrl(): string {
  loadDevEnvFiles({ appDir: resolve(__dirname, "..", "..", "..") });
  return defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:"] }) }).SMTP_URL;
}

/** An active, verified account with the address `email` that signs in with TEST_PASSWORD. */
async function newAccount(email: string, overrides: Parameters<typeof insertAccount>[1] = {}) {
  const account = await insertAccount(pool, { email, password_hash: passwordHash, ...overrides });
  accountsOfThisFile.add(account.id);
  return account;
}

function requestReset(email: string, ip: string): Promise<Response> {
  return t.http.post("/v1/auth/password-reset").set(t.bffHeaders(ip)).send({ email });
}

function confirmReset(token: string, newPassword: string, ip: string): Promise<Response> {
  secrets.add(token);
  secrets.add(newPassword);
  return t.http.post("/v1/auth/password-reset/confirm").set(t.bffHeaders(ip)).send({ token, newPassword });
}

async function signIn(email: string, password: string, ip: string): Promise<Response> {
  const res = await t.http.post("/v1/auth/sign-in").set(t.bffHeaders(ip)).send({ email, password });
  rememberTokens(res);
  return res;
}

async function refresh(refreshToken: string, ip: string): Promise<Response> {
  const res = await t.http.post("/v1/auth/refresh").set(t.bffHeaders(ip)).send({ refreshToken });
  rememberTokens(res);
  return res;
}

function rememberTokens(res: Response): void {
  const body = res.body as Record<string, unknown>;
  for (const field of ["accessToken", "refreshToken"]) {
    if (typeof body[field] === "string") {
      secrets.add(body[field]);
    }
  }
}

/** The token of the message's `/reset-password` link. */
function resetTokenIn(message: Pick<MailpitMessage, "HTML" | "Text">): string {
  const link = extractLinks(message).find((url) => url.startsWith(`${PORTAL}/reset-password?token=`));
  const token = link === undefined ? null : new URL(link).searchParams.get("token");
  if (token === null) {
    throw new Error("no /reset-password link in the message");
  }
  secrets.add(token);
  return token;
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

/** Headers that differ between any two answers: the request id and the time. */
const PER_ANSWER_HEADERS = new Set(["x-request-id", "date"]);

/** What two answers must share to be the same answer: the status, the body and every header with its value. */
function answerShape(res: Response): Record<string, unknown> {
  const headers = Object.entries(res.headers as Record<string, unknown>)
    .filter(([name]) => !PER_ANSWER_HEADERS.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
  return { status: res.status, body: res.text, headers };
}

/** The e-mails queued for `to` (any letter case), oldest first. */
async function outboxTo(to: string): Promise<Array<{ template: string; account_id: string | null }>> {
  const { rows } = await pool.query(
    "SELECT template, account_id FROM platform.email_outbox WHERE lower(to_email) = lower($1) ORDER BY created_at, id",
    [to],
  );
  return rows as Array<{ template: string; account_id: string | null }>;
}

/** The audit rows of `action` about `accountId`. */
async function auditRows(action: string, accountId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, target_type, target_id, ip_address, request_id, details " +
      "FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2",
    [action, accountId],
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

let familyCounter = 0;
/** Inserts the first row of an admin family of `account` (PBE-028 writes them) and returns its refresh token. */
async function insertAdminFamily(account: Pick<PlatformRow<"accounts">, "id">): Promise<string> {
  familyCounter += 1;
  const familyId = testId("asn", 7000 + familyCounter);
  const { token, hash } = generateToken("rt");
  secrets.add(token);
  const now = t.clock.now();
  await insertRow(pool, "account_sessions", {
    id: familyId,
    account_id: account.id,
    family_id: familyId,
    audience: "platform_admin",
    refresh_token_hash: hash,
    expires_at: new Date(now.getTime() + 12 * HOUR_MS),
    family_expires_at: new Date(now.getTime() + 12 * HOUR_MS),
    mfa_verified_at: now,
    created_at: now,
    updated_at: now,
  });
  return token;
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
  // Every line at every level is captured, so the log scan covers the debug and trace lines too; the worker below
  // runs with the same configuration.
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");
  // The worker of dist/worker.js on the same database, Redis, key folder and clock, sending to Mailpit.
  const config: PlatformBackendConfig = { ...t.config, SMTP_URL: mailpitSmtpUrl() };
  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .compile();
  await worker.init();
  // Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same
  // time, so only the events about this file's accounts are kept.
  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-password-reset-test" });
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
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("requestPasswordReset", () => {
  const ip = nextIp();
  const knownEmail = uniqueEmail("reset-known");
  const unknownEmail = uniqueEmail("reset-unknown");
  const unverifiedEmail = uniqueEmail("reset-unverified");
  const disabledEmail = uniqueEmail("reset-disabled");
  let known: PlatformRow<"accounts">;
  let requestedAt: Date;
  const answers: Record<string, Response> = {};
  let message: MailpitMessage;

  beforeAll(async () => {
    known = await newAccount(knownEmail, { full_name: "Lena Holm" });
    await insertUnverifiedAccount(pool, { email: unverifiedEmail, password_hash: passwordHash });
    await newAccount(disabledEmail, { status: "disabled" });
    requestedAt = t.clock.now();
    // The known address in other letters: still the same account.
    answers["known"] = await requestReset(knownEmail.toUpperCase(), ip);
    answers["unknown"] = await requestReset(unknownEmail, ip);
    answers["unverified"] = await requestReset(unverifiedEmail, ip);
    answers["disabled"] = await requestReset(disabledEmail, ip);
    message = await waitForMessage({ to: knownEmail, subject: RESET_SUBJECT, timeoutMs: WAIT_MS });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-016 AC1] answers the same 202 for known and unknown e-mails [PF-05 AC1]", () => {
    const reference = answers["known"] as Response;
    expectResponseToMatch("requestPasswordReset", reference, { document: "platform" });
    expect(reference.status).toBe(202);
    expect(reference.text).toBe("");
    for (const name of ["unknown", "unverified", "disabled"]) {
      const res = answers[name] as Response;
      expectResponseToMatch("requestPasswordReset", res, { document: "platform" });
      expect(answerShape(res)).toEqual(answerShape(reference));
    }
  });

  it("[PBE-016 AC1] e-mails a 1-hour single-use reset link to an active account only [PF-05 AC1]", async () => {
    expect(message.Text).toContain("Hello Lena Holm,");
    const token = resetTokenIn(message);
    expect(token).toMatch(/^pr_/);
    const rows = (await tokensOf(pool, known.id)).filter((row) => row.purpose === "password_reset");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token_hash: sha256Hex(token),
      email: knownEmail,
      consumed_at: null,
      expires_at: new Date(requestedAt.getTime() + HOUR_MS),
      ip_address: ip,
    });
    expect(await outboxTo(knownEmail)).toEqual([{ template: "auth.password_reset", account_id: known.id }]);
    for (const email of [unknownEmail, unverifiedEmail, disabledEmail]) {
      expect(await outboxTo(email)).toEqual([]);
    }
  });

  it("answers 400 VALIDATION_FAILED for a body without an e-mail address", async () => {
    const res = await t.http.post("/v1/auth/password-reset").set(t.bffHeaders(ip)).send({});
    expectResponseToMatch("requestPasswordReset", res, { document: "platform" });
    expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
  });
});

describe("the reset link", () => {
  const ip = nextIp();
  const emails = {
    now: uniqueEmail("reset-now"),
    late: uniqueEmail("reset-late"),
    weak: uniqueEmail("reset-weak"),
  };
  let accounts: Record<keyof typeof emails, PlatformRow<"accounts">>;
  let tokens: Record<keyof typeof emails, string>;
  const outcomes: Record<string, Response> = {};
  let signIns: Record<string, Response>;
  /** The weak-password account's hash and OTA cut-off after its two refused passwords. */
  let afterRefusals: { passwordHash: string | null; staffDeny: string | null };
  let confirmedAt: Date;

  beforeAll(async () => {
    accounts = {
      now: await newAccount(emails.now),
      late: await newAccount(emails.late),
      weak: await newAccount(emails.weak),
    };
    for (const email of Object.values(emails)) {
      expect((await requestReset(email, ip)).status).toBe(202);
    }
    const [now, late, weak] = await Promise.all(
      Object.values(emails).map((to) => waitForMessage({ to, subject: RESET_SUBJECT, timeoutMs: WAIT_MS })),
    );
    tokens = { now: resetTokenIn(now!), late: resetTokenIn(late!), weak: resetTokenIn(weak!) };

    // Within the hour: a weak password is refused and leaves the link usable; the link then works once.
    t.clock.advance(59 * MINUTE_MS);
    confirmedAt = t.clock.now();
    outcomes["tooShort"] = await confirmReset(tokens.weak, "Fjord-9ch", ip);
    outcomes["breached"] = await confirmReset(tokens.weak, "QWERTYUIOP", ip);
    afterRefusals = {
      passwordHash: (await accountRow(accounts.weak.id)).password_hash,
      staffDeny: await t.redis.client.get(redisKeys.staffDenyAccount(accounts.weak.id).key),
    };
    outcomes["weakThenStrong"] = await confirmReset(tokens.weak, NEW_PASSWORD, ip);
    outcomes["first"] = await confirmReset(tokens.now, NEW_PASSWORD, ip);
    outcomes["reused"] = await confirmReset(tokens.now, "Another-Fjord-Morning-8", ip);
    // Past the hour (61 minutes): the third link no longer works.
    t.clock.advance(2 * MINUTE_MS);
    outcomes["expired"] = await confirmReset(tokens.late, NEW_PASSWORD, ip);
    outcomes["unknown"] = await confirmReset(generateToken("pr").token, NEW_PASSWORD, ip);
    signIns = {
      newPassword: await signIn(emails.now, NEW_PASSWORD, ip),
      oldPassword: await signIn(emails.now, TEST_PASSWORD, ip),
      notReset: await signIn(emails.late, TEST_PASSWORD, ip),
    };
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-016 AC1] works once within 1 hour [PF-05 AC1]", async () => {
    for (const res of Object.values(outcomes)) {
      expectResponseToMatch("confirmPasswordReset", res, { document: "platform" });
    }
    expect(outcomeOf(outcomes["first"] as Response)).toBe("204");
    expect(outcomeOf(outcomes["reused"] as Response)).toBe("400 PASSWORD_RESET_TOKEN_INVALID");
    expect(outcomeOf(outcomes["expired"] as Response)).toBe("400 PASSWORD_RESET_TOKEN_INVALID");
    expect(outcomeOf(outcomes["unknown"] as Response)).toBe("400 PASSWORD_RESET_TOKEN_INVALID");
    // The new password signs in; the old one no longer does; the expired link changed nothing.
    expect(outcomeOf(signIns["newPassword"] as Response)).toBe("200");
    expect(outcomeOf(signIns["oldPassword"] as Response)).toBe("401 INVALID_CREDENTIALS");
    expect(outcomeOf(signIns["notReset"] as Response)).toBe("200");
    const row = await accountRow(accounts.now.id);
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_changed_at).toEqual(confirmedAt);
    expect((await accountRow(accounts.late.id)).password_changed_at).toBeNull();
  });

  it("applies the password rules after the token, and a refused password leaves the link usable", () => {
    expect(outcomes["tooShort"]?.body).toMatchObject({
      error: { code: "PASSWORD_TOO_WEAK", fieldErrors: [{ path: "/newPassword", code: "too_short" }] },
    });
    expect(outcomes["breached"]?.body).toMatchObject({
      error: { code: "PASSWORD_TOO_WEAK", fieldErrors: [{ path: "/newPassword", code: "breached" }] },
    });
    expect(JSON.stringify(outcomes["breached"]?.body)).not.toContain("QWERTYUIOP");
    // A refused password changes nothing: the same hash, and no OTA cut-off.
    expect(afterRefusals).toEqual({ passwordHash, staffDeny: null });
    expect(outcomeOf(outcomes["weakThenStrong"] as Response)).toBe("204");
  });
});

describe("a confirmed reset", () => {
  const ip = nextIp();
  const email = uniqueEmail("reset-sessions");
  let account: PlatformRow<"accounts">;
  let stranger: PlatformRow<"accounts">;
  let refreshTokens: string[];
  let strangerRefreshToken: string;
  let otherLink: string;
  let res: Response;
  let resetAt: Date;
  let changedMessage: MailpitMessage;

  beforeAll(async () => {
    account = await newAccount(email);
    stranger = await newAccount(uniqueEmail("reset-stranger"));
    const sessions = [await signIn(email, TEST_PASSWORD, ip), await signIn(email, TEST_PASSWORD, ip)];
    // One family refreshed once, so it has a rotated generation that must be revoked too.
    const rotated = await refresh((sessions[1]?.body as { refreshToken: string }).refreshToken, ip);
    refreshTokens = [
      (sessions[0]?.body as { refreshToken: string }).refreshToken,
      (rotated.body as { refreshToken: string }).refreshToken,
      await insertAdminFamily(account),
    ];
    strangerRefreshToken = (
      (await signIn(stranger.email, TEST_PASSWORD, ip)).body as { refreshToken: string }
    ).refreshToken;
    const now = t.clock.now();
    const link = await insertAccountToken(pool, account, {
      purpose: "password_reset",
      expires_at: hoursFrom(now, 1),
    });
    otherLink = (
      await insertAccountToken(pool, account, { purpose: "password_reset", expires_at: hoursFrom(now, 1) })
    ).token;
    secrets.add(otherLink);
    t.clock.advance(MINUTE_MS);
    resetAt = t.clock.now();
    res = await confirmReset(link.token, NEW_PASSWORD, ip);
    changedMessage = await waitForMessage({ to: email, subject: CHANGED_SUBJECT, timeoutMs: WAIT_MS });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-016 AC2] a reset revokes every session and sets staffdeny:acct:<id> [PF-05 AC2]", async () => {
    expectResponseToMatch("confirmPasswordReset", res, { document: "platform" });
    expect(outcomeOf(res)).toBe("204");

    // Every row of every family of the account, portal and admin alike, rotated ones included.
    const rows = await sessionsOf(account.id);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect([row.revoked_at, row.revoke_reason]).toEqual([resetAt, "password_change"]);
    }
    for (const refreshToken of refreshTokens) {
      expect(outcomeOf(await refresh(refreshToken, ip))).toBe("401 REFRESH_TOKEN_INVALID");
    }
    expect(outcomeOf(await refresh(strangerRefreshToken, ip))).toBe("200");

    // The OTA cut-off: epoch milliseconds of the reset, for 30 days.
    const key = redisKeys.staffDenyAccount(account.id).key;
    expect(key).toBe(`staffdeny:acct:${account.id}`);
    expect(await t.redis.client.get(key)).toBe(String(resetAt.getTime()));
    const ttl = await t.redis.client.pttl(key);
    expect(ttl).toBeGreaterThan((STAFF_DENY_ACCOUNT_TTL_SECONDS - 60) * 1000);
    expect(ttl).toBeLessThanOrEqual(STAFF_DENY_ACCOUNT_TTL_SECONDS * 1000);
    expect(await t.redis.client.get(redisKeys.staffDenyAccount(stranger.id).key)).toBeNull();
    expect((await accountRow(account.id)).password_changed_at).toEqual(resetAt);
  });

  it("e-mails the account, audits, announces the change and uses up the account's other reset links", async () => {
    expect(changedMessage.Text).toContain("The password of your Velexis account was just changed");
    expect(await outboxTo(email)).toEqual([{ template: "auth.password_changed", account_id: account.id }]);
    expect(await auditRows("account.password_reset", account.id)).toEqual([
      {
        actor_type: "account",
        actor_account_id: account.id,
        target_type: "account",
        target_id: account.id,
        ip_address: ip,
        request_id: res.headers["x-request-id"],
        details: { revokedFamilies: 3, staffDenyFrom: resetAt.toISOString() },
      },
    ]);
    expect(await invalidationOf(account.id)).toEqual({ v: 1, type: "account", accountId: account.id });
    const links = (await tokensOf(pool, account.id)).filter((row) => row.purpose === "password_reset");
    expect(links.map((row) => row.consumed_at)).toEqual([resetAt, resetAt]);
    expect(outcomeOf(await confirmReset(otherLink, "Another-Fjord-Morning-8", ip))).toBe(
      "400 PASSWORD_RESET_TOKEN_INVALID",
    );
    expect(outcomeOf(await signIn(email, NEW_PASSWORD, ip))).toBe("200");
  });
});

describe("whose links work", () => {
  const ip = nextIp();
  const outcomes: Record<string, Response> = {};
  const accounts: Record<string, PlatformRow<"accounts">> = {};
  let now: Date;

  beforeAll(async () => {
    now = t.clock.now();
    const expires = { purpose: "password_reset", expires_at: hoursFrom(now, 1) } as const;
    // The reset link of an "account exists" e-mail (a sign-up with a known address) reaches unverified accounts too.
    accounts["unverified"] = await insertUnverifiedAccount(pool, {
      email: uniqueEmail("reset-link-unverified"),
      password_hash: passwordHash,
    });
    accounts["disabled"] = await newAccount(uniqueEmail("reset-link-disabled"), { status: "disabled" });
    accounts["moved"] = await newAccount(uniqueEmail("reset-link-moved"));
    accounts["verifyLink"] = await newAccount(uniqueEmail("reset-link-verify"));
    for (const account of Object.values(accounts)) {
      accountsOfThisFile.add(account.id);
    }
    const unverified = await insertAccountToken(pool, accounts["unverified"], expires);
    const disabled = await insertAccountToken(pool, accounts["disabled"], expires);
    // A link sent to an address the account no longer has.
    const moved = await insertAccountToken(pool, accounts["moved"], {
      ...expires,
      email: uniqueEmail("reset-link-old-address"),
    });
    // A verification token is no reset token.
    const verifyLink = await insertAccountToken(pool, accounts["verifyLink"], {
      purpose: "email_verification",
      expires_at: hoursFrom(now, 24),
    });
    outcomes["unverified"] = await confirmReset(unverified.token, NEW_PASSWORD, ip);
    outcomes["disabled"] = await confirmReset(disabled.token, NEW_PASSWORD, ip);
    outcomes["moved"] = await confirmReset(moved.token, NEW_PASSWORD, ip);
    outcomes["verifyLink"] = await confirmReset(verifyLink.token, NEW_PASSWORD, ip);
    outcomes["invalidBody"] = await t.http
      .post("/v1/auth/password-reset/confirm")
      .set(t.bffHeaders(ip))
      .send({ token: unverified.token });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("an unverified account's link sets the password but does not verify the address", async () => {
    expect(outcomeOf(outcomes["unverified"] as Response)).toBe("204");
    const row = await accountRow(accounts["unverified"]?.id ?? "");
    expect(row).toMatchObject({ status: "pending_verification", email_verified_at: null });
    expect(row.password_changed_at).toEqual(now);
  });

  it("refuses the link of a disabled account, of an address the account no longer has, and a verification link", async () => {
    for (const name of ["disabled", "moved", "verifyLink"]) {
      const res = outcomes[name] as Response;
      expectResponseToMatch("confirmPasswordReset", res, { document: "platform" });
      expect(outcomeOf(res)).toBe("400 PASSWORD_RESET_TOKEN_INVALID");
      const row = await accountRow(accounts[name]?.id ?? "");
      expect(row.password_changed_at).toBeNull();
      expect(row.password_hash).toBe(passwordHash);
    }
    // Nothing was cut off for a link that does not work.
    expect(
      await t.redis.client.get(redisKeys.staffDenyAccount(accounts["disabled"]?.id ?? "").key),
    ).toBeNull();
  });

  it("answers 400 VALIDATION_FAILED for a body without a new password", () => {
    expectResponseToMatch("confirmPasswordReset", outcomes["invalidBody"] as Response, {
      document: "platform",
    });
    expect(outcomeOf(outcomes["invalidBody"] as Response)).toBe("400 VALIDATION_FAILED");
  });
});

describe("the rate limits of requestPasswordReset", () => {
  const email = uniqueEmail("reset-throttle");
  const answers: Response[] = [];

  beforeAll(async () => {
    await newAccount(email);
    // Four requests for one address, each from an IP of its own: the address's limit (3 per hour) is reached.
    for (let i = 0; i < 4; i += 1) {
      answers.push(await requestReset(email, nextIp()));
    }
  }, GROUP_SETUP_TIMEOUT_MS);

  it("answers 429 RATE_LIMITED with Retry-After from the fourth request for one address within an hour", async () => {
    expect(answers.slice(0, 3).map((res) => res.status)).toEqual([202, 202, 202]);
    const limited = answers[3] as Response;
    expectResponseToMatch("requestPasswordReset", limited, { document: "platform" });
    expect(outcomeOf(limited)).toBe("429 RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Three links were issued, never a fourth.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM platform.account_tokens WHERE lower(email) = lower($1) AND purpose = 'password_reset'",
      [email],
    );
    expect(rows[0]).toEqual({ n: 3 });
  });
});

describe("the logs", () => {
  it("never hold a token or a password of this file", () => {
    expect(secrets.size).toBeGreaterThan(10);
    const text = [...t.logs.lines, ...workerLogs.lines].map((line) => JSON.stringify(line)).join("\n");
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  });
});
