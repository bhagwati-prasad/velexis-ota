// Sign-up, e-mail verification and the resend of the verification link (PBE-013; platform/docs/flows/
// signup-and-create-ota.md steps 1 to 3, scope PF-01 and PF-02, PADR-0008, PADR-0013) through the HTTP pipeline
// (createTestApp) on this file's database clone, with the worker's module graph (WorkerModule, as dist/worker.js
// builds it, with the same FakeClock) sending the queued e-mails to Mailpit. Every answer is checked against the
// platform document. Every e-mail goes to an address of its own (`uniqueEmail`), and every group of calls comes from
// an end-user IP of its own (documentation addresses, RFC 5737), so the per-IP and per-address rate limits of one
// test never touch another.
//
// The slow parts (Argon2id hashing, the worker's SMTP delivery and Mailpit's API) run in the setup hooks of each
// group, with explicit bounds; the tests then check what happened and make the quick calls themselves.
import { resolve } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import {
  extractLinks,
  mailpit,
  uniqueEmail,
  waitForMessage,
  type MailpitMessage,
} from "@velexis/testing/mailpit";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { createProcessLogger, PLATFORM_PROCESSES, type PlatformBackendConfig } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import {
  accountByEmail,
  hoursFrom,
  insertAccountToken,
  insertUnverifiedAccount,
  TEST_PASSWORD,
  TEST_TERMS_VERSION,
  tokensOf,
} from "../../builders/accounts";
import { insertAccount } from "../../builders/platform-rows";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and the worker's module graph, and parsing the platform document, take about
 * two seconds alone; the bound allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/**
 * A group's setup: a few sign-ups (Argon2id, 19 MiB and 2 passes each) and the worker's delivery of their e-mails to
 * Mailpit; a few seconds alone, bounded for CI load.
 */
const GROUP_SETUP_TIMEOUT_MS = 60_000;
/** How long the setup hooks wait for the worker's e-mails. */
const WAIT_MS = 20_000;

const VERIFY_SUBJECT = "Confirm your e-mail address for Velexis";
const ACCOUNT_EXISTS_SUBJECT = "You already have a Velexis account";
/** PUBLIC_PORTAL_URL of the test applications (TEST_MAIL_ENV). */
const PORTAL = "http://localhost:3000";
const HOUR_MS = 60 * 60 * 1000;

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
const workerLogs = new LogSink();

/** Every password and token this file used or received, for the log scan of AC5. */
const secrets = new Set<string>();

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each group of calls, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

/** The development SMTP_URL (Mailpit) of the environment. */
function mailpitSmtpUrl(): string {
  loadDevEnvFiles({ appDir: resolve(__dirname, "..", "..", "..") });
  return defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:"] }) }).SMTP_URL;
}

/** A valid signUp body for `email`, with TEST_PASSWORD unless `password` is given. */
function signUpBody(email: string, password = TEST_PASSWORD): Record<string, unknown> {
  secrets.add(password);
  return { email, password, fullName: "Anna Berg", acceptTerms: true, termsVersion: TEST_TERMS_VERSION };
}

function signUp(ip: string, body: Record<string, unknown>): Promise<Response> {
  return t.http.post("/v1/auth/sign-up").set(t.bffHeaders(ip)).send(body);
}

function verify(token: string, ip = "203.0.113.20"): Promise<Response> {
  return t.http.post("/v1/auth/verify-email").set(t.bffHeaders(ip)).send({ token });
}

function resend(email: string, ip: string): Promise<Response> {
  return t.http.post("/v1/auth/resend-verification").set(t.bffHeaders(ip)).send({ email });
}

/** The token of the message's link to `path` of the portal (`/verify-email`, `/reset-password`). */
function tokenIn(message: Pick<MailpitMessage, "HTML" | "Text">, path: string): string {
  const link = extractLinks(message).find((url) => url.startsWith(`${PORTAL}${path}?token=`));
  const token = link === undefined ? null : new URL(link).searchParams.get("token");
  if (token === null) {
    throw new Error(`no ${path} link in the message`);
  }
  secrets.add(token);
  return token;
}

/** Waits until Mailpit holds `count` messages to `to` with `subject`, and returns them in full, oldest first. */
async function waitForMessages(to: string, subject: string, count: number): Promise<MailpitMessage[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = await mailpit.search({ to, subject });
    if (found.length >= count) {
      const messages = await Promise.all(found.map((summary) => mailpit.get(summary.ID)));
      return messages.reverse();
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForMessages: ${found.length} of ${count} messages arrived within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Waits until `count` statements of this file's database wait for a lock (row locks included). */
async function waitForLockWaits(count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if ((rows[0]?.n ?? 0) >= count) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitForLockWaits: ${rows[0]?.n ?? 0} of ${count} statements waited within ${WAIT_MS} ms`,
      );
    }
    await new Promise((done) => setTimeout(done, 20));
  }
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
    "SELECT actor_type, actor_account_id, actor_label, target_type, target_id, ip_address, user_agent, request_id, " +
      "details FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2",
    [action, accountId],
  );
  return rows as Array<Record<string, unknown>>;
}

/** The error envelope, as far as the tests read it. */
interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** Headers that differ between any two answers: the request id and the time. */
const PER_ANSWER_HEADERS = new Set(["x-request-id", "date"]);

/** What two answers must share to be the same answer: the status, the body and every header with its value. */
function answerShape(res: Response): Record<string, unknown> {
  const headers = Object.entries(res.headers as Record<string, unknown>)
    .filter(([name]) => !PER_ANSWER_HEADERS.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    status: res.status,
    body: res.text,
    headerNames: Object.keys(res.headers).sort(),
    headers,
  };
}

beforeAll(async () => {
  // Every line at every level is captured, so "no captured log contains the password or the token" (AC5) covers the
  // debug and trace lines too; the worker below runs with the same configuration.
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
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
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("signUp", () => {
  const ip = nextIp();
  const newEmail = uniqueEmail("signup-new");
  const existingEmail = uniqueEmail("signup-existing");
  let existing: Awaited<ReturnType<typeof insertAccount>>;
  let forNew: Response;
  let forExisting: Response;
  let verifyMessage: MailpitMessage;
  let existsMessage: MailpitMessage;

  beforeAll(async () => {
    existing = await insertAccount(pool, { email: existingEmail, full_name: "Lena Holm" });
    forNew = await signUp(ip, signUpBody(newEmail));
    // The known address in other letters: still the same account.
    forExisting = await signUp(ip, signUpBody(existingEmail.toUpperCase()));
    [verifyMessage, existsMessage] = await Promise.all([
      waitForMessage({ to: newEmail, subject: VERIFY_SUBJECT, timeoutMs: WAIT_MS }),
      waitForMessage({ to: existingEmail, subject: ACCOUNT_EXISTS_SUBJECT, timeoutMs: WAIT_MS }),
    ]);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-013 AC1] a new and an existing e-mail get byte-identical 202 responses [PF-01 AC1]", () => {
    expectResponseToMatch("signUp", forNew, { document: "platform" });
    expectResponseToMatch("signUp", forExisting, { document: "platform" });
    expect(forNew.status).toBe(202);
    expect(forNew.text).toBe('{"status":"verification_sent"}');
    expect(answerShape(forExisting)).toEqual(answerShape(forNew));
    expect(forExisting.headers["x-request-id"]).not.toBe(forNew.headers["x-request-id"]);
  });

  it("[PBE-013 AC1] the new address gets the verification e-mail and the known one the account-exists e-mail [PF-01 AC1]", async () => {
    const verifyToken = tokenIn(verifyMessage, "/verify-email");
    const resetToken = tokenIn(existsMessage, "/reset-password");
    expect(verifyMessage.Text).toContain("Hello Anna Berg,");
    expect(existsMessage.Text).toContain("Hello Lena Holm,");
    expect(existsMessage.Text).toContain(`sign in at ${PORTAL}`);
    expect(verifyToken).toMatch(/^vt_[A-Za-z0-9_-]{43}$/);
    expect(resetToken).toMatch(/^pr_[A-Za-z0-9_-]{43}$/);
    // One message each, and only of its kind.
    expect(await mailpit.search({ to: newEmail })).toHaveLength(1);
    expect(await mailpit.search({ to: existingEmail })).toHaveLength(1);

    // The new account: pending, with its terms, its hash and a 24-hour verification token (only the hash is stored).
    const created = await accountByEmail(pool, newEmail);
    expect(created).toMatchObject({
      id: expect.stringMatching(/^acc_[0-9A-HJKMNP-TV-Z]{26}$/) as string,
      email: newEmail,
      full_name: "Anna Berg",
      status: "pending_verification",
      email_verified_at: null,
      terms_accepted_at: t.clock.now(),
      terms_version: TEST_TERMS_VERSION,
      created_at: t.clock.now(),
    });
    const createdId = created?.id ?? "";
    expect(await tokensOf(pool, createdId)).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^atk_[0-9A-HJKMNP-TV-Z]{26}$/) as string,
        purpose: "email_verification",
        token_hash: sha256Hex(verifyToken),
        email: newEmail,
        expires_at: new Date(t.clock.now().getTime() + 24 * HOUR_MS),
        consumed_at: null,
        ip_address: ip,
      }),
    ]);
    expect(await outboxTo(newEmail)).toEqual([{ template: "auth.verify_email", account_id: createdId }]);
    expect(await auditRows("account.signed_up", createdId)).toEqual([
      expect.objectContaining({
        actor_type: "account",
        actor_account_id: createdId,
        actor_label: newEmail,
        target_type: "account",
        ip_address: ip,
        request_id: forNew.headers["x-request-id"],
        details: { termsVersion: TEST_TERMS_VERSION, after: { status: "pending_verification" } },
      }),
    ]);

    // The known address: no second account, no verification link, a 1-hour reset link to the account's own address.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM platform.accounts WHERE lower(email) = lower($1)",
      [existingEmail],
    );
    expect(rows).toEqual([{ n: 1 }]);
    expect(await accountByEmail(pool, existingEmail)).toEqual(existing);
    expect(await tokensOf(pool, existing.id)).toEqual([
      expect.objectContaining({
        purpose: "password_reset",
        token_hash: sha256Hex(resetToken),
        email: existingEmail,
        expires_at: new Date(t.clock.now().getTime() + HOUR_MS),
        consumed_at: null,
      }),
    ]);
    expect(await outboxTo(existingEmail)).toEqual([
      { template: "auth.account_exists", account_id: existing.id },
    ]);
    // To the account's own address, not to the letters the caller typed.
    const { rows: recipients } = await pool.query(
      "SELECT to_email FROM platform.email_outbox WHERE account_id = $1",
      [existing.id],
    );
    expect(recipients).toEqual([{ to_email: existingEmail }]);
    expect(existingEmail.toUpperCase()).not.toBe(existingEmail);
    expect(await auditRows("account.signed_up", existing.id)).toEqual([]);
  });

  it("[PBE-013 AC2] a 9-character password and a breached password answer 422 PASSWORD_TOO_WEAK [PF-01 AC2]", async () => {
    const callerIp = nextIp();
    const tooShort = uniqueEmail("signup-short");
    const breached = uniqueEmail("signup-breached");

    const short = await signUp(callerIp, signUpBody(tooShort, "Fjord-La4"));
    const common = await signUp(callerIp, signUpBody(breached, "QwertyUiop"));

    for (const [res, code] of [
      [short, "too_short"],
      [common, "breached"],
    ] as const) {
      expectResponseToMatch("signUp", res, { document: "platform" });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: {
          code: "PASSWORD_TOO_WEAK",
          status: 422,
          fieldErrors: [{ path: "/password", code, message: expect.any(String) as string }],
        },
      });
    }
    expect(short.text).not.toContain("Fjord-La4");
    expect(common.text.toLowerCase()).not.toContain("qwertyuiop");
    expect(await accountByEmail(pool, tooShort)).toBeUndefined();
    expect(await accountByEmail(pool, breached)).toBeUndefined();
    expect([...(await outboxTo(tooShort)), ...(await outboxTo(breached))]).toEqual([]);
  });

  it("refuses a blank full name with 400 VALIDATION_FAILED on /fullName", async () => {
    const email = uniqueEmail("signup-blank");

    const res = await signUp(nextIp(), { ...signUpBody(email), fullName: "   " });

    expectResponseToMatch("signUp", res, { document: "platform" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: [{ path: "/fullName", code: "blank" }] },
    });
    expect(await accountByEmail(pool, email)).toBeUndefined();
  });

  describe("racing for one address", () => {
    const email = uniqueEmail("signup-race");
    let answers: Response[];

    beforeAll(async () => {
      const callerIp = nextIp();
      answers = await Promise.all([signUp(callerIp, signUpBody(email)), signUp(callerIp, signUpBody(email))]);
    }, GROUP_SETUP_TIMEOUT_MS);

    it("makes one account: one sign-up gets the verification e-mail, the other the account-exists e-mail", async () => {
      for (const res of answers) {
        expectResponseToMatch("signUp", res, { document: "platform" });
      }
      expect(answers.map((res) => res.status)).toEqual([202, 202]);
      expect(answers[1]?.text).toBe(answers[0]?.text);
      const account = await accountByEmail(pool, email);
      const queued = await outboxTo(email);
      expect(queued.map((row) => row.template).sort()).toEqual(["auth.account_exists", "auth.verify_email"]);
      expect(queued.map((row) => row.account_id)).toEqual([account?.id, account?.id]);
      expect((await tokensOf(pool, account?.id ?? "")).map((row) => row.purpose).sort()).toEqual([
        "email_verification",
        "password_reset",
      ]);
    });
  });

  describe("from one IP", () => {
    const callerIp = nextIp();
    const answers: Response[] = [];
    let fromElsewhere: Response;

    beforeAll(async () => {
      for (let n = 1; n <= 6; n += 1) {
        answers.push(await signUp(callerIp, signUpBody(uniqueEmail(`signup-limit${n}`))));
      }
      fromElsewhere = await signUp(nextIp(), signUpBody(uniqueEmail("signup-elsewhere")));
    }, GROUP_SETUP_TIMEOUT_MS);

    it("[PBE-013 AC2] the sixth sign-up from one IP within an hour answers 429 RATE_LIMITED [PF-01 AC3]", () => {
      for (const res of [...answers, fromElsewhere]) {
        expectResponseToMatch("signUp", res, { document: "platform" });
      }
      expect(answers.map((res) => res.status)).toEqual([202, 202, 202, 202, 202, 429]);
      const limited = answers[5] as Response;
      expect(limited.body).toMatchObject({ error: { code: "RATE_LIMITED", status: 429 } });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(3600);
      expect(fromElsewhere.status).toBe(202);
    });
  });
});

describe("verifyEmail", () => {
  const email = uniqueEmail("verify");
  let token: string;

  beforeAll(async () => {
    expect((await signUp(nextIp(), signUpBody(email))).status).toBe(202);
    token = tokenIn(
      await waitForMessage({ to: email, subject: VERIFY_SUBJECT, timeoutMs: WAIT_MS }),
      "/verify-email",
    );
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-013 AC3] a verification token works once; a reused, unknown or 25-hour-old token answers VERIFICATION_TOKEN_INVALID [PF-02 AC1]", async () => {
    const signedUpAt = t.clock.now();
    // 25 hours later the link has expired (FakeClock); nothing changes.
    t.clock.advance(25 * HOUR_MS);
    let expired: Response;
    try {
      expired = await verify(token);
    } finally {
      t.clock.set(signedUpAt);
    }
    expect((await accountByEmail(pool, email))?.status).toBe("pending_verification");

    // Within the 24 hours it works, once.
    const first = await verify(token);
    const reused = await verify(token);
    const unknown = await verify(`vt_${"A".repeat(43)}`);

    for (const res of [expired, reused, unknown]) {
      expectResponseToMatch("verifyEmail", res, { document: "platform" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "VERIFICATION_TOKEN_INVALID", status: 400 } });
    }
    expect((reused.body as ErrorBody).error.message).toBe((unknown.body as ErrorBody).error.message);
    expectResponseToMatch("verifyEmail", first, { document: "platform" });
    const account = await accountByEmail(pool, email);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accountId: account?.id, email, emailVerified: true });
    expect(account).toMatchObject({ status: "active", email_verified_at: signedUpAt, version: 2 });
    expect(await tokensOf(pool, account?.id ?? "")).toEqual([
      expect.objectContaining({ purpose: "email_verification", consumed_at: signedUpAt }),
    ]);
    expect(await auditRows("account.email_verified", account?.id ?? "")).toEqual([
      expect.objectContaining({
        actor_type: "account",
        actor_account_id: account?.id,
        details: { before: { status: "pending_verification" }, after: { status: "active" } },
      }),
    ]);
  });

  it("refuses a token whose account is not waiting for it: verified, disabled, another address, or a reset token", async () => {
    const verified = await insertAccount(pool, { email: uniqueEmail("verify-active") });
    const disabled = await insertUnverifiedAccount(pool, { status: "disabled" });
    const moved = await insertUnverifiedAccount(pool);
    const pending = await insertUnverifiedAccount(pool);
    const expiresAt = hoursFrom(t.clock.now(), 24);
    const tokens = [
      await insertAccountToken(pool, verified, { expires_at: expiresAt }),
      await insertAccountToken(pool, disabled, { expires_at: expiresAt }),
      await insertAccountToken(pool, moved, { expires_at: expiresAt, email: "earlier@example.com" }),
      await insertAccountToken(pool, pending, { expires_at: expiresAt, purpose: "password_reset" }),
    ];

    for (const { token: presented, row } of tokens) {
      const res = await verify(presented);
      expectResponseToMatch("verifyEmail", res, { document: "platform" });
      expect(res.body).toMatchObject({ error: { code: "VERIFICATION_TOKEN_INVALID" } });
      // The refusal used nothing up.
      expect((await tokensOf(pool, row.account_id))[0]?.consumed_at).toBeNull();
    }
    for (const account of [verified, disabled, moved, pending]) {
      expect(await accountByEmail(pool, account.email)).toEqual(account);
    }
  });

  it("answers 400 VALIDATION_FAILED for a body without a token", async () => {
    const res = await t.http.post("/v1/auth/verify-email").set(t.bffHeaders("203.0.113.21")).send({});

    expectResponseToMatch("verifyEmail", res, { document: "platform" });
    expect(res.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  describe("two links of one account used at the same time", () => {
    let account: Awaited<ReturnType<typeof insertUnverifiedAccount>>;
    let answers: Response[];

    beforeAll(async () => {
      account = await insertUnverifiedAccount(pool);
      const expiresAt = hoursFrom(t.clock.now(), 24);
      const links = [
        await insertAccountToken(pool, account, { expires_at: expiresAt }),
        await insertAccountToken(pool, account, { expires_at: expiresAt }),
      ];
      // The test holds the account's row until both verifications wait for a lock, then lets them run together:
      // the interleaving in which two links of one account (the first e-mail and a resend) are opened at once.
      const holder = await pool.connect();
      let pending: Array<Promise<Response>> = [];
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM platform.accounts WHERE id = $1 FOR UPDATE", [account.id]);
        pending = links.map(({ token }) => verify(token).then((res) => res));
        await waitForLockWaits(2);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      answers = await Promise.all(pending);
    }, GROUP_SETUP_TIMEOUT_MS);

    it("verifies the account once and refuses the other link, without a deadlock", async () => {
      for (const res of answers) {
        expectResponseToMatch("verifyEmail", res, { document: "platform" });
      }
      expect(answers.map((res) => res.status).sort()).toEqual([200, 400]);
      expect(answers.find((res) => res.status === 400)?.body).toMatchObject({
        error: { code: "VERIFICATION_TOKEN_INVALID" },
      });
      expect(await accountByEmail(pool, account.email)).toMatchObject({ status: "active", version: 2 });
      expect((await tokensOf(pool, account.id)).map((row) => row.consumed_at)).toEqual([
        t.clock.now(),
        t.clock.now(),
      ]);
      expect(await auditRows("account.email_verified", account.id)).toHaveLength(1);
    });
  });
});

describe("resendVerification", () => {
  const ip = nextIp();
  const unknownEmail = uniqueEmail("resend-unknown");
  let unverified: Awaited<ReturnType<typeof insertUnverifiedAccount>>;
  let verified: Awaited<ReturnType<typeof insertAccount>>;
  let answers: Response[];
  let fourth: Response;
  let links: string[];

  beforeAll(async () => {
    unverified = await insertUnverifiedAccount(pool, {
      email: uniqueEmail("resend"),
      full_name: "Mira Sand",
    });
    verified = await insertAccount(pool, { email: uniqueEmail("resend-verified") });
    answers = [];
    for (const email of [
      unverified.email,
      unknownEmail,
      verified.email,
      unverified.email,
      unverified.email,
    ]) {
      // A minute between the calls, so the tokens' times tell the order of the links.
      t.clock.advance(60_000);
      answers.push(await resend(email, ip));
    }
    // The fourth for the unverified address, in other letters: the same address for the limit.
    fourth = await resend(unverified.email.toUpperCase(), ip);
    const received = (await waitForMessages(unverified.email, VERIFY_SUBJECT, 3)).map((message) =>
      tokenIn(message, "/verify-email"),
    );
    // The links in the order the resends made them (the worker may send them in another order).
    const byHash = new Map(received.map((link) => [sha256Hex(link), link]));
    links = (await tokensOf(pool, unverified.id)).map((row) => byHash.get(row.token_hash) ?? "");
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-013 AC4] resend always answers 202 and sends at most 3 e-mails per hour [PF-02 AC2]", async () => {
    for (const res of answers) {
      expectResponseToMatch("resendVerification", res, { document: "platform" });
      expect(res.status).toBe(202);
      expect(res.text).toBe("");
    }
    expect(new Set(answers.map((res) => JSON.stringify(answerShape(res)))).size).toBe(1);
    expectResponseToMatch("resendVerification", fourth, { document: "platform" });
    expect(fourth.status).toBe(429);
    expect(fourth.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(Number(fourth.headers["retry-after"])).toBeGreaterThan(0);

    // Three links for the unverified account, nothing for the unknown or the verified address.
    expect(links).toHaveLength(3);
    expect(new Set(links).size).toBe(3);
    expect(await outboxTo(unverified.email)).toEqual(
      Array.from({ length: 3 }, () => ({ template: "auth.verify_email", account_id: unverified.id })),
    );
    expect(await mailpit.search({ to: unverified.email })).toHaveLength(3);
    expect([...(await outboxTo(unknownEmail)), ...(await outboxTo(verified.email))]).toEqual([]);
    expect(await mailpit.search({ to: unknownEmail })).toEqual([]);
    expect(await tokensOf(pool, verified.id)).toEqual([]);
    const rows = await tokensOf(pool, unverified.id);
    expect(rows.map((row) => row.token_hash)).toEqual(links.map((link) => sha256Hex(link)));
    for (const row of rows) {
      expect(row).toMatchObject({
        purpose: "email_verification",
        email: unverified.email,
        consumed_at: null,
      });
      expect(row.expires_at).toEqual(hoursFrom(row.created_at, 24));
    }
  });

  it("keeps the earlier links working until one of them verifies the address (PADR-0008 item 3)", async () => {
    const [first, , last] = links;

    const res = await verify(first ?? "");
    const later = await verify(last ?? "");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accountId: unverified.id, email: unverified.email, emailVerified: true });
    expect(later.body).toMatchObject({ error: { code: "VERIFICATION_TOKEN_INVALID" } });
    expect((await tokensOf(pool, unverified.id)).map((row) => row.consumed_at)).toEqual(
      Array.from({ length: 3 }, () => t.clock.now()),
    );
  });
});

describe("secrets", () => {
  const email = uniqueEmail("secrets");
  const password = "Glacier-Compass-Ember-77";
  let token: string;

  beforeAll(async () => {
    expect((await signUp(nextIp(), signUpBody(email, password))).status).toBe(202);
    token = tokenIn(
      await waitForMessage({ to: email, subject: VERIFY_SUBJECT, timeoutMs: WAIT_MS }),
      "/verify-email",
    );
    expect((await verify(token)).status).toBe(200);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-013 AC5] the stored hash starts with $argon2id$ and no captured log contains the password or the token", async () => {
    const account = await accountByEmail(pool, email);
    expect(account?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(account?.password_hash).not.toContain(password);
    expect(await tokensOf(pool, account?.id ?? "")).toEqual([
      expect.objectContaining({ token_hash: sha256Hex(token) }),
    ]);

    // Every password and token of this file, in every line the API and the worker logged, every audit row, every
    // outbox row (sent: the secret payload is erased) and every key of Redis (the BullMQ jobs carry ids only).
    const logged = JSON.stringify([...t.logs.lines, ...workerLogs.lines]);
    const { rows: audit } = await pool.query(
      "SELECT details::text AS details FROM platform.platform_audit_log",
    );
    const { rows: outbox } = await pool.query(
      "SELECT data::text AS data, secret_payload_ciphertext FROM platform.email_outbox",
    );
    // The BullMQ jobs are hashes (`vx:platform-emails:<id>`, with their `data`); the other keys are counters and lists
    // of ids.
    const redis = t.redis.client;
    const values: string[] = [];
    for (const key of await redis.keys("*")) {
      values.push(key, (await redis.type(key)) === "hash" ? JSON.stringify(await redis.hgetall(key)) : "");
    }
    expect(secrets.size).toBeGreaterThan(10);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(logged).not.toContain(secret);
      expect(JSON.stringify(audit)).not.toContain(secret);
      expect(JSON.stringify(outbox)).not.toContain(secret);
      expect(values.join("\n")).not.toContain(secret);
    }
  });
});
