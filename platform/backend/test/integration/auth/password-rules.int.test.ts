// The password rule of every portal account (FIX-W48-PLATFORM; ADR-0008 revisions of 2026-11-10 and 2026-11-11, the
// owner's decisions (13g) and (15e): PCI DSS 8.3.6) through the HTTP pipeline (createTestApp) on this file's database
// clone and Redis database. signUp, changePassword and confirmPasswordReset ask every account for at least 12
// characters with at least one letter and one digit (`422 PASSWORD_TOO_WEAK`, field code `password_rule`, the rule's
// message): a platform admin, the owner of a live OTA, an admin of a test OTA and the owner of a suspended OTA (the
// accounts of FIX-W47-PLATFORM's privileged rule), and an agent, an account whose owner membership was removed, the
// owner of an OTA being deleted and an account without any membership (whom FIX-W47-PLATFORM had left at 10
// characters) alike, and a person who signs up (an invited person signs up through the same operation: the portal's
// invitation page links to the sign-up). Every account starts with an 11-character password written by the fixture,
// which keeps working until the account sets a new one, because a password is checked only when it is chosen: they
// sign in with it and change it. Every answer is checked against the platform document, and no log line holds a token
// or a password.
//
// Each account calls from an end-user IP of its own (documentation addresses, RFC 5737), so the per-IP rate limits of
// one never touch another. The calls (Argon2id hashes and verifications) run in the setup hooks, with explicit bounds;
// the tests read their answers.
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasswordPolicy, RULE_MESSAGE } from "../../../src/auth/password-policy";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { hoursFrom, insertAccountToken, TEST_TERMS_VERSION } from "../../builders/accounts";
import { insertAccount, testId, type PlatformRow } from "../../builders/platform-rows";
import { insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and parsing the platform document take about two seconds alone; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/**
 * A group's setup: eight accounts, each with sign-ins or four refused and one accepted password (a few Argon2id hashes
 * and verifications); a few seconds alone, bounded for CI load.
 */
const GROUP_SETUP_TIMEOUT_MS = 60_000;

/** Test values, never real passwords. The current one is the fixture's: 11 characters, set before the rule. */
const CURRENT_PASSWORD = "Fjord-Lan4!";
/** 11 characters with a letter and a digit: what the 10-character rule took and the rule refuses. */
const ELEVEN_CHARACTERS = "Kettle-Rn7!";
/** 15 characters without a digit, and 12 characters without a letter. */
const NO_DIGIT = "Kettle-Morning!";
const NO_LETTER = "4815-1623-42";
/** 12 characters with a letter and a digit: the shortest password of the rule. */
const TWELVE_CHARACTERS = "Copper-Lan4!";
/** 9 characters: too short under every rule there was. */
const NINE_CHARACTERS = "Fjord-La4";

/** The weak passwords every account tries first, by name. */
const WEAK = [
  ["nine", NINE_CHARACTERS],
  ["eleven", ELEVEN_CHARACTERS],
  ["noDigit", NO_DIGIT],
  ["noLetter", NO_LETTER],
] as const;

/** The field error of the rule at `path`. */
function ruleFieldError(path: string): { path: string; code: string; message: string } {
  return {
    path,
    code: "password_rule",
    message: "Use at least 12 characters, with at least one letter and one digit.",
  };
}

/** The accounts of a group, by what made their rule before (FIX-W47-PLATFORM). */
const KINDS = [
  "platformAdmin",
  "liveOwner",
  "testAdmin",
  "suspendedOwner",
  "agent",
  "formerOwner",
  "deprovisioningOwner",
  "noMembership",
] as const;
type Kind = (typeof KINDS)[number];

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let policy: PasswordPolicy;
/** The Argon2id hash of CURRENT_PASSWORD, made once and shared by the accounts of this file. */
let currentHash: string;

/** Every password and token this file used, for the log scan. */
const secrets = new Set<string>([
  CURRENT_PASSWORD,
  ELEVEN_CHARACTERS,
  NO_DIGIT,
  NO_LETTER,
  TWELVE_CHARACTERS,
  NINE_CHARACTERS,
]);

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each account or sign-up, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${100 + ipCounter}`;
}

let counter = 0;
/**
 * The eight accounts of a group, each with CURRENT_PASSWORD: a platform admin with MFA and no membership, the owner
 * of a live OTA with MFA, an admin of a test OTA, an agent of that OTA, an account whose owner membership of it was
 * removed, the owner of a suspended test OTA (members still see it), the active owner of an OTA being deleted
 * (`deprovisioning`: members no longer see it) and an account without any membership.
 */
async function accountsOfAGroup(label: string): Promise<Record<Kind, PlatformRow<"accounts">>> {
  counter += 1;
  const account = (kind: Kind, overrides: Parameters<typeof insertAccount>[1] = {}) =>
    insertAccount(pool, {
      email: `rules-${label}-${kind.toLowerCase()}-${counter}-${Date.now()}@example.com`,
      password_hash: currentHash,
      ...overrides,
    });
  const accounts: Record<Kind, PlatformRow<"accounts">> = {
    platformAdmin: await account("platformAdmin", { is_platform_admin: true, mfa_enabled: true }),
    liveOwner: await account("liveOwner", { mfa_enabled: true }),
    testAdmin: await account("testAdmin"),
    suspendedOwner: await account("suspendedOwner"),
    agent: await account("agent"),
    formerOwner: await account("formerOwner"),
    deprovisioningOwner: await account("deprovisioningOwner"),
    noMembership: await account("noMembership"),
  };
  await insertOta(pool, {
    tenant: {
      key: `rules${label}live${counter}`,
      storefront_environment: "live",
      live_enabled_at: new Date("2026-01-10T09:00:00.000Z"),
    },
    members: [[accounts.liveOwner, "owner"]],
  });
  const testOta = await insertOta(pool, {
    tenant: { key: `rules${label}test${counter}`, storefront_environment: "test" },
    members: [
      [accounts.testAdmin, "admin"],
      [accounts.agent, "agent"],
    ],
  });
  await insertMembership(pool, testOta.tenant, accounts.formerOwner, {
    id: testId("stf", 7000 + counter),
    role: "owner",
    status: "removed",
  });
  await insertOta(pool, {
    tenant: {
      key: `rules${label}susp${counter}`,
      storefront_environment: "test",
      status: "suspended",
      suspended_at: new Date("2026-10-20T09:00:00.000Z"),
      suspension_reason: "billing",
    },
    members: [[accounts.suspendedOwner, "owner"]],
  });
  await insertOta(pool, {
    tenant: {
      key: `rules${label}deprov${counter}`,
      storefront_environment: "test",
      status: "deprovisioning",
    },
    members: [[accounts.deprovisioningOwner, "owner"]],
  });
  return accounts;
}

/** A fresh portal access token of `account` from the application's TokenService, for a family that need not exist. */
async function tokenOf(account: Pick<PlatformRow<"accounts">, "id">): Promise<string> {
  counter += 1;
  const { token } = await tokens.sign({
    aud: "portal",
    sub: account.id,
    sid: testId("asn", 8000 + counter),
    ev: true,
    amr: ["pwd"],
  });
  secrets.add(token);
  return token;
}

function changePassword(accessToken: string, ip: string, newPassword: string): Promise<Response> {
  return t.http
    .post("/v1/me/password")
    .set({ Authorization: `Bearer ${accessToken}`, ...t.bffHeaders(ip) })
    .send({ currentPassword: CURRENT_PASSWORD, newPassword });
}

function confirmReset(token: string, ip: string, newPassword: string): Promise<Response> {
  secrets.add(token);
  return t.http.post("/v1/auth/password-reset/confirm").set(t.bffHeaders(ip)).send({ token, newPassword });
}

function signIn(email: string, password: string, ip: string): Promise<Response> {
  return t.http.post("/v1/auth/sign-in").set(t.bffHeaders(ip)).send({ email, password });
}

function signUp(email: string, password: string, ip: string): Promise<Response> {
  return t.http.post("/v1/auth/sign-up").set(t.bffHeaders(ip)).send({
    email,
    password,
    fullName: "Ingrid Rules",
    acceptTerms: true,
    termsVersion: TEST_TERMS_VERSION,
  });
}

/** `204`, or the status, the error code and the field codes of the envelope (whose request id is the header's). */
function outcomeOf(res: Response): string {
  if (res.status < 300) {
    return String(res.status);
  }
  const { error } = res.body as {
    error: { code: string; requestId: string; fieldErrors?: { path: string; code: string }[] };
  };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  const fields = (error.fieldErrors ?? []).map((field) => `${field.path}:${field.code}`).join(",");
  return `${res.status} ${error.code}${fields === "" ? "" : ` ${fields}`}`;
}

/** The outcome of each try, by its name. */
function outcomesOf(tries: Record<string, Response>): Record<string, string> {
  return Object.fromEntries(Object.entries(tries).map(([name, res]) => [name, outcomeOf(res)]));
}

/** The envelope of a refusal: its message and field errors. */
function envelopeOf(res: Response | undefined): { message?: unknown; fieldErrors?: unknown } {
  return (res?.body as { error?: { message?: unknown; fieldErrors?: unknown } } | undefined)?.error ?? {};
}

async function passwordHashOf(accountId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT password_hash FROM platform.accounts WHERE id = $1", [accountId]);
  return (rows[0] as { password_hash: string | null }).password_hash;
}

/** The refusal of each weak password at `pointer`, then the accepted one. */
function refusedThenAccepted(pointer: string, accepted: string): Record<string, string> {
  return {
    ...Object.fromEntries(WEAK.map(([name]) => [name, `422 PASSWORD_TOO_WEAK ${pointer}:password_rule`])),
    accepted,
  };
}

beforeAll(async () => {
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  policy = t.app.get(PasswordPolicy);
  currentHash = await policy.hash(CURRENT_PASSWORD);
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("changePassword", () => {
  let accounts: Record<Kind, PlatformRow<"accounts">>;
  /** The answers by account: each weak password in turn, then the accepted one. */
  const answers: Partial<Record<Kind, Record<string, Response>>> = {};
  /** The admin of the test OTA and the agent sign in with the fixture's password before and after the refusals. */
  const signIns: Record<string, Response> = {};
  const hashes: Partial<Record<Kind, { before: string | null; afterRefusals: string | null }>> = {};

  beforeAll(async () => {
    accounts = await accountsOfAGroup("chg");
    const ips = { testAdmin: nextIp(), agent: nextIp() };
    for (const kind of ["testAdmin", "agent"] as const) {
      signIns[`${kind}Before`] = await signIn(accounts[kind].email, CURRENT_PASSWORD, ips[kind]);
    }
    for (const kind of KINDS) {
      const ip = kind === "testAdmin" || kind === "agent" ? ips[kind] : nextIp();
      const accessToken = await tokenOf(accounts[kind]);
      const before = await passwordHashOf(accounts[kind].id);
      const tries: Record<string, Response> = {};
      for (const [name, password] of WEAK) {
        tries[name] = await changePassword(accessToken, ip, password);
      }
      if (kind === "testAdmin" || kind === "agent") {
        signIns[`${kind}AfterRefusals`] = await signIn(accounts[kind].email, CURRENT_PASSWORD, ip);
      }
      hashes[kind] = { before, afterRefusals: await passwordHashOf(accounts[kind].id) };
      tries["accepted"] = await changePassword(accessToken, ip, TWELVE_CHARACTERS);
      answers[kind] = tries;
    }
    for (const kind of ["testAdmin", "agent"] as const) {
      signIns[`${kind}New`] = await signIn(accounts[kind].email, TWELVE_CHARACTERS, ips[kind]);
    }
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[FIX-W48-PLATFORM AC1] asks every account for 12 characters with a letter and a digit: the accounts of the former privileged rule and every other one alike", () => {
    for (const kind of KINDS) {
      const tries = answers[kind] ?? {};
      for (const res of Object.values(tries)) {
        expectResponseToMatch("changePassword", res, { document: "platform" });
      }
      expect(outcomesOf(tries), kind).toEqual(refusedThenAccepted("/newPassword", "204"));
      // The message names the rule; the field error says it in a sentence of its own.
      expect(envelopeOf(tries["eleven"]), kind).toMatchObject({
        message: RULE_MESSAGE,
        fieldErrors: [ruleFieldError("/newPassword")],
      });
    }
  });

  it("[FIX-W48-PLATFORM AC1] lets a password set before the rule keep working until the account sets a new one", async () => {
    // The fixture's 11-character password signs the admin and the agent in before and after the refusals, which
    // changed no hash; the accepted change replaced it.
    for (const kind of ["testAdmin", "agent"] as const) {
      expect(outcomeOf(signIns[`${kind}Before`] as Response), kind).toBe("200");
      expect(outcomeOf(signIns[`${kind}AfterRefusals`] as Response), kind).toBe("200");
      expect(outcomeOf(signIns[`${kind}New`] as Response), kind).toBe("200");
    }
    for (const kind of KINDS) {
      expect(hashes[kind]?.afterRefusals, kind).toBe(hashes[kind]?.before);
      expect(await passwordHashOf(accounts[kind].id), kind).not.toBe(hashes[kind]?.before);
    }
    for (const kind of ["liveOwner", "agent", "noMembership"] as const) {
      expect(
        await policy.verify((await passwordHashOf(accounts[kind].id)) ?? "", TWELVE_CHARACTERS),
        kind,
      ).toBe(true);
    }
  });
});

describe("confirmPasswordReset", () => {
  let accounts: Record<Kind, PlatformRow<"accounts">>;
  const answers: Partial<Record<Kind, Record<string, Response>>> = {};

  beforeAll(async () => {
    accounts = await accountsOfAGroup("rst");
    for (const kind of KINDS) {
      const ip = nextIp();
      const { token } = await insertAccountToken(pool, accounts[kind], {
        id: testId("atk", 7100 + KINDS.indexOf(kind)),
        purpose: "password_reset",
        expires_at: hoursFrom(t.clock.now(), 1),
      });
      const tries: Record<string, Response> = {};
      for (const [name, password] of WEAK) {
        tries[name] = await confirmReset(token, ip, password);
      }
      // A refusal leaves the link usable: the same token sets a password the rule accepts.
      tries["accepted"] = await confirmReset(token, ip, TWELVE_CHARACTERS);
      answers[kind] = tries;
    }
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[FIX-W48-PLATFORM AC1] asks every account for 12 characters with a letter and a digit, and keeps the link usable after a refusal", async () => {
    for (const kind of KINDS) {
      const tries = answers[kind] ?? {};
      for (const res of Object.values(tries)) {
        expectResponseToMatch("confirmPasswordReset", res, { document: "platform" });
      }
      expect(outcomesOf(tries), kind).toEqual(refusedThenAccepted("/newPassword", "204"));
      expect(envelopeOf(tries["noLetter"]), kind).toMatchObject({
        message: RULE_MESSAGE,
        fieldErrors: [ruleFieldError("/newPassword")],
      });
      expect(
        await policy.verify((await passwordHashOf(accounts[kind].id)) ?? "", TWELVE_CHARACTERS),
        kind,
      ).toBe(true);
    }
  });
});

describe("signUp", () => {
  let email: string;
  let tries: Record<string, Response>;

  beforeAll(async () => {
    counter += 1;
    email = `rules-signup-${counter}-${Date.now()}@example.com`;
    tries = {};
    // Five sign-ups per end-user IP and hour: each try from an address of its own.
    for (const [name, password] of WEAK) {
      tries[name] = await signUp(email, password, nextIp());
    }
    tries["accepted"] = await signUp(email, TWELVE_CHARACTERS, nextIp());
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[FIX-W48-PLATFORM AC1] asks a person who signs up for 12 characters with a letter and a digit, and makes no account until then", async () => {
    for (const res of Object.values(tries)) {
      expectResponseToMatch("signUp", res, { document: "platform" });
    }
    expect(outcomesOf(tries)).toEqual(refusedThenAccepted("/password", "202"));
    expect(envelopeOf(tries["noDigit"])).toMatchObject({
      message: RULE_MESSAGE,
      fieldErrors: [ruleFieldError("/password")],
    });
    // Only the accepted sign-up made the account, with the 12-character password.
    const { rows } = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM platform.accounts WHERE lower(email) = lower($1)",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(await policy.verify(rows[0]?.password_hash ?? "", TWELVE_CHARACTERS)).toBe(true);
  });
});

describe("the logs", () => {
  it("never hold a password or a token of this file", () => {
    const text = t.logs.lines.map((line) => JSON.stringify(line)).join("\n");
    expect(text.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(text.includes(secret)).toBe(false);
    }
  });
});
