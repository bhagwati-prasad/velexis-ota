// The rate limits of the platform API through its real routes (PBE-062 step 2; api-inventory §2 "Rate limits",
// architecture §3 step 4 and §3.2, PADR-0008, PADR-0019; conventions §12 "Authentication, search and payment endpoints
// are rate limited"): one group per row of the inventory's table, each ending in `429 RATE_LIMITED` with a
// `Retry-After` within the row's window (or `423 ACCOUNT_LOCKED` for the sign-in lockout of the same row), and each
// showing who else the limit leaves alone: another end-user IP, another account, another e-mail address, another
// domain.
//
// The per-IP rows run as the portal and admin servers call the API: from loopback, with the BFF key and the end user's
// IP in `X-Velexis-End-User-IP` (TestApp.bffHeaders). An IP that is throttled leaves the next IP untouched, and a
// forwarded IP without the right BFF key buys no fresh bucket. Accounts, OTAs, plans and domains are written with the
// builders; MFA accounts carry a TOTP secret the test knows, encrypted with the application's EnvelopeService as
// MfaService stores it, and codes are computed at the FakeClock's time; portal tokens come from the application's
// TokenService. The counters live in this file's Redis database and their windows run on Redis's clock: every group
// uses IPs, addresses, accounts and domains of its own, so no group touches another's counters. The requests of each
// group run in its `beforeAll` hook with an explicit budget (the sign-ins hash with Argon2id); the tests read what they
// answered. Documentation addresses (RFC 5737), example.com mailboxes and made-up passwords only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountSecretPlace, generateTotpSecret, totpCode } from "../../../src/accounts/mfa.service";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { TokenService } from "../../../src/auth/token.service";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURE_VARIABLES,
  FEATURES,
  featuresFor,
  FeatureSwitches,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { BFF_KEY_HEADER } from "../../../src/common/http/end-user";
import { RATE_LIMITS } from "../../../src/common/http/throttler.config";
import { APP_DIR } from "../../../src/config";
import { TEST_PASSWORD, TEST_TERMS_VERSION } from "../../builders/accounts";
import {
  insertAccount,
  insertPlan,
  insertTenantDomain,
  testId,
  type AccountRow,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertOta } from "../../builders/tenants";
import { createTestApp, TEST_BFF_KEY, type TestApp } from "../../support/app";

/** The database clone, the Nest module graph and the platform document take seconds on a loaded runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's requests: a few hundred cheap calls or a dozen Argon2id sign-ins; seconds at most, bounded for CI. */
const GROUP_TIMEOUT_MS = 60_000;
const STEP_MS = 30 * 1000;
const FAMILY = testId("asn", 62_100);
const MINUTE = 60;
const HOUR = 60 * MINUTE;
/** The DNS ownership token of the custom domains of this file: a made-up value of the token's shape, no secret. */
const DOMAIN_TOKEN = "vx-verify-RL62M2XP9TRWH5ZDB3NV8QKE1MZT6RYC";

/** Every milestone switch on: `checkDomain` needs `custom_domains`; the switches have tests of their own. */
class AllSwitchesOn {
  isEnabled(_feature: Feature): boolean {
    return true;
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(FEATURES.map((feature) => [FEATURE_VARIABLES[feature], true])) as FeatureConfig,
    );
  }
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let envelope: EnvelopeService;
/** The Argon2id hash of TEST_PASSWORD, made once for the accounts that sign in. */
let passwordHash: string;

let ipCounter = 0;
/** A documentation IP (RFC 5737, 203.0.113.0/24 and 198.51.100.0/24) of its own for each person of this file. */
function nextIp(): string {
  ipCounter += 1;
  return ipCounter <= 250 ? `203.0.113.${ipCounter}` : `198.51.100.${ipCounter - 250}`;
}

let mailCounter = 0;
/** An address of its own (example.com) for each person of this file. */
function nextEmail(label: string): string {
  mailCounter += 1;
  return `rl.${label}.${mailCounter}@example.com`;
}

/** The status and code of an answer: `202`, `429 RATE_LIMITED`. */
function outcomeOf(res: Response): string {
  const error = (res.body as { error?: { code?: string } } | undefined)?.error;
  return res.status < 400 ? String(res.status) : `${res.status} ${error?.code ?? "(no code)"}`;
}

/** `Retry-After` of a refusal as a number of seconds; `NaN` when it is missing. */
const retryAfterOf = (res: Response): number => Number(res.headers["retry-after"]);

/** Asserts a `429 RATE_LIMITED` with a `Retry-After` of whole seconds within the row's window. */
function expectThrottled(res: Response | undefined, windowSeconds: number): void {
  expect(res, "the limited answer").toBeDefined();
  const limited = res as Response;
  expect(outcomeOf(limited)).toBe("429 RATE_LIMITED");
  const retryAfter = retryAfterOf(limited);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
}

/** `Authorization: Bearer` with a portal token of `account` at the FakeClock's time (a step-up of now when asked). */
async function portalBearer(
  account: Pick<PlatformRow<"accounts">, "id">,
  stepUp = false,
): Promise<Record<string, string>> {
  const now = Math.floor(t.clock.now().getTime() / 1000);
  const { token } = await tokens.sign({
    aud: "portal",
    sub: account.id,
    sid: FAMILY,
    ev: true,
    amr: stepUp ? ["pwd", "otp"] : ["pwd"],
    ...(stepUp ? { mfa_at: now } : {}),
  });
  return { Authorization: `Bearer ${token}` };
}

/** An account with MFA on and a TOTP secret the test knows, signing in with TEST_PASSWORD. */
async function insertMfaAccount(
  overrides: Partial<AccountRow> = {},
): Promise<{ readonly account: PlatformRow<"accounts">; readonly secret: string }> {
  const account = await insertAccount(pool, { password_hash: passwordHash, ...overrides });
  const secret = generateTotpSecret();
  const { ciphertext, kekId } = await envelope.encrypt(secret, accountSecretPlace(account.id));
  await pool.query(
    "UPDATE platform.accounts SET mfa_enabled = true, mfa_enabled_at = $2, mfa_secret_ciphertext = $3, " +
      "encryption_key_id = $4 WHERE id = $1",
    [account.id, t.clock.now(), Buffer.from(ciphertext), kekId],
  );
  return { account, secret };
}

/** A six-digit string that is not the code of `secret` in the steps around the FakeClock's time. */
function wrongCode(secret: string): string {
  const now = t.clock.now().getTime();
  const valid = new Set([-1, 0, 1].map((delta) => totpCode(secret, new Date(now + delta * STEP_MS))));
  for (let candidate = 314159; ; candidate += 1) {
    const code = String(candidate % 1_000_000).padStart(6, "0");
    if (!valid.has(code)) {
      return code;
    }
  }
}

beforeAll(async () => {
  // The clone, the module graph, Argon2id's first hash and the platform document are the expensive part.
  t = await createTestApp({ overrides: [{ provide: FeatureSwitches, useValue: new AllSwitchesOn() }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  envelope = t.app.get(EnvelopeService, { strict: false });
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("the rows of api-inventory §2", () => {
  it("[PBE-062 step 2] are the nine rows this file proves, with the limits the throttlers count", () => {
    const inventory = readFileSync(join(APP_DIR, "..", "docs", "api-inventory.md"), "utf8");
    const table = inventory.split("| Endpoint group | Limit |")[1]?.split("\n\n")[0] ?? "";
    const groups = table
      .split("\n")
      .slice(2)
      .map((line) => line.split("|")[1]?.trim() ?? "");

    expect(groups).toEqual([
      "Sign-up",
      "Sign-in, admin sign-in",
      "MFA verify, step-up",
      "Password reset request, resend verification",
      "Invitation lookup",
      "Key availability",
      "Console token",
      "Domain check now",
      "Everything else authenticated",
    ]);
    expect(new Set(Object.values(RATE_LIMITS).map((limit) => limit.row))).toEqual(new Set(groups));
  });
});

describe("Sign-up: 5 per IP per hour", () => {
  const ip = nextIp();
  const otherIp = nextIp();
  const answers: Response[] = [];
  let otherPerson: Response;
  let forged: Response[] = [];

  const signUp = (headers: Record<string, string>, label: string): Promise<Response> =>
    t.http
      .post("/v1/auth/sign-up")
      .set(headers)
      .send({
        email: nextEmail(label),
        password: TEST_PASSWORD,
        fullName: "Ingrid Solberg",
        acceptTerms: true,
        termsVersion: TEST_TERMS_VERSION,
      });

  beforeAll(async () => {
    for (let n = 1; n <= 6; n += 1) {
      answers.push(await signUp(t.bffHeaders(ip), "signup"));
    }
    otherPerson = await signUp(t.bffHeaders(otherIp), "signup");
    // A forwarded IP with a wrong BFF key is not believed: the calls count for the caller's own address (loopback).
    const forgedIp = nextIp();
    forged = [];
    for (let n = 1; n <= 6; n += 1) {
      forged.push(
        await signUp({ ...t.bffHeaders(`192.0.2.${n}`), [BFF_KEY_HEADER]: `${TEST_BFF_KEY}x` }, "forged"),
      );
    }
    forged.push(await signUp(t.bffHeaders(forgedIp), "forged"));
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] answers the sixth sign-up of one IP 429 with Retry-After, and the next IP 202", () => {
    for (const res of [...answers, otherPerson]) {
      expectResponseToMatch("signUp", res, { document: "platform" });
    }
    expect(answers.slice(0, 5).map(outcomeOf)).toEqual(["202", "202", "202", "202", "202"]);
    expectThrottled(answers[5], HOUR);
    expect(outcomeOf(otherPerson)).toBe("202");
  });

  it("[PBE-062 step 2] counts a forwarded IP without the right BFF key against the caller's own address", () => {
    expect(forged.slice(0, 5).map(outcomeOf)).toEqual(["202", "202", "202", "202", "202"]);
    expectThrottled(forged[5], HOUR);
    // The portal server, with the key, forwards a person whose bucket is still empty.
    expect(outcomeOf(forged[6] as Response)).toBe("202");
  });
});

describe("Sign-in, admin sign-in: 10 per IP per minute; 5 consecutive failures lock the account", () => {
  const ip = nextIp();
  const otherIp = nextIp();
  const attempts: Response[] = [];
  let otherPerson: Response;
  const failures: Response[] = [];
  let lockedWithRightPassword: Response;
  let otherAccountSameIp: Response;

  const signIn = (path: string, ipOf: string, email: string, password: string): Promise<Response> =>
    t.http.post(path).set(t.bffHeaders(ipOf)).send({ email, password });

  beforeAll(async () => {
    const person = await insertAccount(pool, { password_hash: passwordHash, email: nextEmail("signin") });
    const admin = await insertMfaAccount({ is_platform_admin: true, email: nextEmail("admin") });
    // Ten sign-ins of one IP in one minute, portal and admin alike (one bucket), then the eleventh.
    for (let n = 1; n <= 5; n += 1) {
      attempts.push(await signIn("/v1/auth/sign-in", ip, person.email, TEST_PASSWORD));
      attempts.push(await signIn("/v1/admin/auth/sign-in", ip, admin.account.email, TEST_PASSWORD));
    }
    attempts.push(await signIn("/v1/auth/sign-in", ip, person.email, TEST_PASSWORD));
    otherPerson = await signIn("/v1/auth/sign-in", otherIp, person.email, TEST_PASSWORD);

    // The lockout of the same row: five wrong passwords, each from an IP of its own, lock the account itself.
    const victim = await insertAccount(pool, { password_hash: passwordHash, email: nextEmail("locked") });
    for (let n = 1; n <= 5; n += 1) {
      failures.push(await signIn("/v1/auth/sign-in", nextIp(), victim.email, "Wrong-Password-2026!"));
    }
    const lockIp = nextIp();
    lockedWithRightPassword = await signIn("/v1/auth/sign-in", lockIp, victim.email, TEST_PASSWORD);
    // The lockout is the account's, not the IP's: another account signs in from the same address.
    const neighbour = await insertAccount(pool, {
      password_hash: passwordHash,
      email: nextEmail("neighbour"),
    });
    otherAccountSameIp = await signIn("/v1/auth/sign-in", lockIp, neighbour.email, TEST_PASSWORD);
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] answers the eleventh sign-in of one IP 429 with Retry-After, portal and admin counted together, and the next IP 200", () => {
    expect(attempts.slice(0, 10).map(outcomeOf)).toEqual(Array.from({ length: 10 }, () => "200"));
    expectResponseToMatch("signIn", attempts[10] as Response, { document: "platform" });
    expectThrottled(attempts[10], MINUTE);
    expect(outcomeOf(otherPerson)).toBe("200");
  });

  it("[PBE-062 step 2] locks an account after five consecutive failures with 423 and Retry-After, whatever the IP, and no other account", () => {
    for (const res of [...failures, lockedWithRightPassword]) {
      expectResponseToMatch("signIn", res, { document: "platform" });
    }
    // The fifth failure locks; the right password then waits for the 15 minutes too.
    expect(failures.map(outcomeOf)).toEqual([
      ...Array.from({ length: 4 }, () => "401 INVALID_CREDENTIALS"),
      "423 ACCOUNT_LOCKED",
    ]);
    expect(retryAfterOf(failures[4] as Response)).toBe(15 * MINUTE);
    expect(outcomeOf(lockedWithRightPassword)).toBe("423 ACCOUNT_LOCKED");
    const retryAfter = retryAfterOf(lockedWithRightPassword);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * MINUTE);
    expect(outcomeOf(otherAccountSameIp)).toBe("200");
  });
});

describe("MFA verify, step-up: 5 attempts per challenge; 10 per account per 10 minutes", () => {
  const ip = nextIp();
  const challengeAnswers: Response[] = [];
  const accountAnswers: Response[] = [];
  let accountLimited: Response;
  let otherAccount: Response;
  const stepUps: Response[] = [];
  let otherStepUp: Response;

  const verify = (token: string, code: string): Promise<Response> =>
    t.http.post("/v1/auth/mfa/verify").set(t.bffHeaders(ip)).send({ mfaChallengeToken: token, code });

  async function challenge(account: PlatformRow<"accounts">): Promise<string> {
    const res = await t.http
      .post("/v1/auth/sign-in")
      .set(t.bffHeaders(nextIp()))
      .send({ email: account.email, password: TEST_PASSWORD });
    const token = (res.body as { mfaChallengeToken?: string }).mfaChallengeToken;
    if (token === undefined) {
      throw new Error(`the sign-in answered ${res.status} without a challenge`);
    }
    return token;
  }

  beforeAll(async () => {
    // Per challenge: the fifth wrong code ends it, so the sixth attempt finds no challenge.
    const first = await insertMfaAccount({ email: nextEmail("mfa") });
    const token = await challenge(first.account);
    for (let n = 1; n <= 6; n += 1) {
      challengeAnswers.push(await verify(token, wrongCode(first.secret)));
    }

    // Per account: ten attempts over two challenges, then the eleventh with the right code.
    const second = await insertMfaAccount({ email: nextEmail("mfa") });
    for (let round = 1; round <= 2; round += 1) {
      const each = await challenge(second.account);
      for (let n = 1; n <= 5; n += 1) {
        accountAnswers.push(await verify(each, wrongCode(second.secret)));
      }
    }
    accountLimited = await verify(await challenge(second.account), totpCode(second.secret, t.clock.now()));
    // Another account, from the same IP, is not held back by the first one's limit.
    const third = await insertMfaAccount({ email: nextEmail("mfa") });
    otherAccount = await verify(await challenge(third.account), totpCode(third.secret, t.clock.now()));

    // The step-up of a signed-in person counts against the same per-account limit (the guard's `mfa` throttler).
    const steppingUp = await insertMfaAccount({ email: nextEmail("stepup") });
    const headers = { ...t.bffHeaders(nextIp()), ...(await portalBearer(steppingUp.account)) };
    for (let n = 1; n <= 11; n += 1) {
      stepUps.push(
        await t.http
          .post("/v1/auth/step-up")
          .set(headers)
          .send({ code: wrongCode(steppingUp.secret) }),
      );
    }
    // Another account's attempt is checked, not throttled: its wrong code is told so.
    const fresh = await insertMfaAccount({ email: nextEmail("stepup") });
    otherStepUp = await t.http
      .post("/v1/auth/step-up")
      .set({ ...t.bffHeaders(nextIp()), ...(await portalBearer(fresh.account)) })
      .send({ code: wrongCode(fresh.secret) });
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] ends a challenge after five wrong codes", () => {
    for (const res of challengeAnswers) {
      expectResponseToMatch("verifyMfa", res, { document: "platform" });
    }
    expect(challengeAnswers.map(outcomeOf)).toEqual([
      ...Array.from({ length: 5 }, () => "401 MFA_CODE_INVALID"),
      "401 MFA_CHALLENGE_INVALID",
    ]);
  });

  it("[PBE-062 step 2] answers the eleventh verification of one account in 10 minutes 429 with Retry-After, and another account 200", () => {
    expect(accountAnswers.map(outcomeOf)).toEqual(Array.from({ length: 10 }, () => "401 MFA_CODE_INVALID"));
    expectResponseToMatch("verifyMfa", accountLimited, { document: "platform" });
    expectThrottled(accountLimited, 10 * MINUTE);
    expect(outcomeOf(otherAccount)).toBe("200");
  });

  it("[PBE-062 step 2] answers the eleventh step-up of one account in 10 minutes 429 with Retry-After, and checks another account's code", () => {
    for (const res of [...stepUps, otherStepUp]) {
      expectResponseToMatch("stepUp", res, { document: "platform" });
    }
    expect(stepUps.slice(0, 10).map(outcomeOf)).toEqual(
      Array.from({ length: 10 }, () => "401 MFA_CODE_INVALID"),
    );
    expectThrottled(stepUps[10], 10 * MINUTE);
    expect(outcomeOf(otherStepUp)).toBe("401 MFA_CODE_INVALID");
  });
});

describe("Password reset request, resend verification: 3 per e-mail per hour, 10 per IP per hour", () => {
  const perEmail: Response[] = [];
  let otherEmail: Response;
  const perIp: Response[] = [];
  let otherIp: Response;

  const reset = (ip: string, email: string): Promise<Response> =>
    t.http.post("/v1/auth/password-reset").set(t.bffHeaders(ip)).send({ email });
  const resend = (ip: string, email: string): Promise<Response> =>
    t.http.post("/v1/auth/resend-verification").set(t.bffHeaders(ip)).send({ email });

  beforeAll(async () => {
    // One address, from four IPs, through both operations (one bucket per address), in other letters.
    const email = nextEmail("links");
    perEmail.push(await reset(nextIp(), email));
    perEmail.push(await resend(nextIp(), email.toUpperCase()));
    perEmail.push(await reset(nextIp(), email.replace("rl.", "RL.")));
    perEmail.push(await resend(nextIp(), email));
    otherEmail = await reset(nextIp(), nextEmail("links"));

    // One IP, eleven addresses.
    const ip = nextIp();
    for (let n = 1; n <= 11; n += 1) {
      perIp.push(n % 2 === 0 ? await resend(ip, nextEmail("ip")) : await reset(ip, nextEmail("ip")));
    }
    otherIp = await reset(nextIp(), nextEmail("ip"));
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] answers the fourth link of one address in an hour 429 with Retry-After, from any IP, and another address 202", () => {
    expect(perEmail.slice(0, 3).map(outcomeOf)).toEqual(["202", "202", "202"]);
    expectResponseToMatch("resendVerification", perEmail[3] as Response, { document: "platform" });
    expectThrottled(perEmail[3], HOUR);
    expect(outcomeOf(otherEmail)).toBe("202");
  });

  it("[PBE-062 step 2] answers the eleventh link of one IP in an hour 429 with Retry-After, and the next IP 202", () => {
    expect(perIp.slice(0, 10).map(outcomeOf)).toEqual(Array.from({ length: 10 }, () => "202"));
    expectResponseToMatch("requestPasswordReset", perIp[10] as Response, { document: "platform" });
    expectThrottled(perIp[10], HOUR);
    expect(outcomeOf(otherIp)).toBe("202");
  });
});

describe("Invitation lookup: 20 per IP per hour", () => {
  const ip = nextIp();
  const answers: Response[] = [];
  let otherIp: Response;

  const lookup = (from: string, n: number): Promise<Response> =>
    t.http
      .post("/v1/invitations/lookup")
      .set(t.bffHeaders(from))
      .send({ token: `iv_${String(n).padStart(43, "Q")}` });

  beforeAll(async () => {
    for (let n = 1; n <= 21; n += 1) {
      answers.push(await lookup(ip, n));
    }
    otherIp = await lookup(nextIp(), 22);
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] answers the 21st lookup of one IP in an hour 429 with Retry-After, and the next IP its answer", () => {
    for (const res of [...answers, otherIp]) {
      expectResponseToMatch("lookupInvitation", res, { document: "platform" });
    }
    // Unknown tokens: the lookup answers them until the IP's hour is used up.
    expect(answers.slice(0, 20).map(outcomeOf)).toEqual(
      Array.from({ length: 20 }, () => "400 INVITATION_INVALID"),
    );
    expectThrottled(answers[20], HOUR);
    expect(outcomeOf(otherIp)).toBe("400 INVITATION_INVALID");
  });
});

describe("Key availability: 30 per account per minute", () => {
  const answers: Response[] = [];
  let otherAccount: Response;

  beforeAll(async () => {
    const person = await insertAccount(pool);
    const headers = await portalBearer(person);
    // Each call from an IP of its own: the limit counts the account, whatever the IP.
    for (let n = 1; n <= 31; n += 1) {
      answers.push(
        await t.http
          .get(`/v1/tenants/key-availability?key=agency${n}`)
          .set({ ...t.bffHeaders(nextIp()), ...headers }),
      );
    }
    const other = await insertAccount(pool);
    otherAccount = await t.http
      .get("/v1/tenants/key-availability?key=agency99")
      .set({ ...t.bffHeaders(nextIp()), ...(await portalBearer(other)) });
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] answers the 31st check of one account in a minute 429 with Retry-After, from any IP, and another account 200", () => {
    for (const res of [...answers, otherAccount]) {
      expectResponseToMatch("checkTenantKey", res, { document: "platform" });
    }
    expect(answers.slice(0, 30).map(outcomeOf)).toEqual(Array.from({ length: 30 }, () => "200"));
    expectThrottled(answers[30], MINUTE);
    expect(outcomeOf(otherAccount)).toBe("200");
  });
});

describe("Console token: 30 per account per minute", () => {
  const answers: Response[] = [];
  let otherAccount: Response;

  beforeAll(async () => {
    const owner = await insertAccount(pool);
    const colleague = await insertAccount(pool);
    const { tenant } = await insertOta(pool, {
      members: [
        [owner, "owner"],
        [colleague, "agent"],
      ],
    });
    const headers = { ...t.bffHeaders(nextIp()), ...(await portalBearer(owner)) };
    for (let n = 1; n <= 31; n += 1) {
      answers.push(await t.http.post(`/v1/tenants/${tenant.id}/console-token`).set(headers));
    }
    otherAccount = await t.http
      .post(`/v1/tenants/${tenant.id}/console-token`)
      .set({ ...t.bffHeaders(nextIp()), ...(await portalBearer(colleague)) });
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] answers the 31st console token of one account in a minute 429 with Retry-After, and another member 201", () => {
    for (const res of [...answers, otherAccount]) {
      expectResponseToMatch("createConsoleToken", res, { document: "platform" });
    }
    expect(answers.slice(0, 30).map(outcomeOf)).toEqual(Array.from({ length: 30 }, () => "201"));
    expectThrottled(answers[30], MINUTE);
    expect(outcomeOf(otherAccount)).toBe("201");
  });
});

describe("Domain check now: 1 per domain per minute", () => {
  const answers: Response[] = [];
  let otherDomain: Response;
  let anonymousAfterwards: Response;

  beforeAll(async () => {
    const owner = await insertAccount(pool);
    const plan = await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10, customDomains: 2 } });
    const { tenant } = await insertOta(pool, {
      tenant: { plan_code: plan.code },
      members: [[owner, "owner"]],
    });
    const pending = {
      kind: "custom",
      verification_status: "pending",
      verification_token: DOMAIN_TOKEN,
      verification_deadline_at: new Date(t.clock.now().getTime() + 72 * HOUR * 1000),
      verified_at: null,
    } as const;
    const first = await insertTenantDomain(pool, tenant, {
      hostname: "www.fjord-reiser.example.com",
      ...pending,
    });
    const second = await insertTenantDomain(pool, tenant, {
      hostname: "booking.fjord-reiser.example.com",
      ...pending,
    });
    const headers = { ...t.bffHeaders(nextIp()), ...(await portalBearer(owner)) };
    const check = (domainId: string): Promise<Response> =>
      t.http.post(`/v1/tenants/${tenant.id}/domains/${domainId}/check`).set(headers);
    answers.push(await check(first.id));
    answers.push(await check(first.id));
    otherDomain = await check(second.id);
    // The limit counts before the auth guards: a caller without a token is refused by it too.
    anonymousAfterwards = await t.http
      .post(`/v1/tenants/${tenant.id}/domains/${first.id}/check`)
      .set(t.bffHeaders(nextIp()));
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] answers the second check of one domain in a minute 429 with Retry-After, and another domain 202", () => {
    for (const res of [...answers, otherDomain]) {
      expectResponseToMatch("checkDomain", res, { document: "platform" });
    }
    expect(outcomeOf(answers[0] as Response)).toBe("202");
    expectThrottled(answers[1], MINUTE);
    expect(outcomeOf(otherDomain)).toBe("202");
    expectThrottled(anonymousAfterwards, MINUTE);
  });
});

describe("Everything else authenticated: 300 per account per minute", () => {
  const LIMIT = 300;
  const statuses: number[] = [];
  let limited: Response;
  let otherAccount: Response;

  beforeAll(async () => {
    const person = await insertAccount(pool);
    const headers = { ...t.bffHeaders(nextIp()), ...(await portalBearer(person)) };
    // Three hundred reads of one account in a minute, eight at a time, then the 301st.
    let sent = 0;
    const lane = async (): Promise<void> => {
      while (sent < LIMIT) {
        sent += 1;
        statuses.push((await t.http.get("/v1/me").set(headers)).status);
      }
    };
    await Promise.all(Array.from({ length: 8 }, lane));
    limited = await t.http.get("/v1/me").set(headers);
    const other = await insertAccount(pool);
    otherAccount = await t.http
      .get("/v1/me")
      .set({ ...t.bffHeaders(nextIp()), ...(await portalBearer(other)) });
  }, GROUP_TIMEOUT_MS);

  it("[PBE-062 step 2] answers the 301st request of one account in a minute 429 with Retry-After, and another account 200", () => {
    expect(statuses).toHaveLength(LIMIT);
    expect(statuses.every((status) => status === 200)).toBe(true);
    expectResponseToMatch("getMe", limited, { document: "platform" });
    expectThrottled(limited, MINUTE);
    expect(outcomeOf(otherAccount)).toBe("200");
  });
});
