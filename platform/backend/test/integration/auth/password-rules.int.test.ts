// The password rules of the account (FIX-W47-PLATFORM; ADR-0008 revision of 2026-11-10, the owner's decision (13g):
// PCI DSS 8.3.6) through the HTTP pipeline (createTestApp) on this file's database clone and Redis database:
// changePassword and confirmPasswordReset ask a platform admin, the owner of a live OTA, an admin of a test OTA and the
// owner of a suspended OTA (an OTA members still see) for at least 12 characters with at least one letter and one digit
// (`422 PASSWORD_TOO_WEAK`, field code `privileged_rule`, a message that names the rule), while an agent, an account
// whose owner membership was removed and the owner of an OTA being deleted (one members no longer see) keep the
// 10-character rule. Every account starts with an 11-character password, which keeps working for the privileged
// accounts until they set a new one: they sign in with it and change it. Every answer is checked against the platform
// document, and no log line holds a token or a password.
//
// Each account calls from an end-user IP of its own (documentation addresses, RFC 5737), so the per-IP rate limits of
// one never touch another. The calls (Argon2id hashes and verifications) run in the setup hooks, with explicit bounds;
// the tests read their answers.
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasswordPolicy, RULE_MESSAGES } from "../../../src/auth/password-policy";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { hoursFrom, insertAccountToken } from "../../builders/accounts";
import { insertAccount, testId, type PlatformRow } from "../../builders/platform-rows";
import { insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and parsing the platform document take about two seconds alone; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/**
 * A group's setup: seven accounts, each with a sign-in or a refused and an accepted password (a few Argon2id hashes and
 * verifications); a few seconds alone, bounded for CI load.
 */
const GROUP_SETUP_TIMEOUT_MS = 60_000;

/** Test values, never real passwords. The current one meets the 10-character rule and not the privileged one. */
const CURRENT_PASSWORD = "Fjord-Lan4!";
/** 11 characters with a letter and a digit: the standard rule's, not the privileged rule's. */
const ELEVEN_CHARACTERS = "Kettle-Rn7!";
/** 15 characters without a digit, and 12 characters without a letter. */
const NO_DIGIT = "Kettle-Morning!";
const NO_LETTER = "4815-1623-42";
/** 12 characters with a letter and a digit: the shortest password of the privileged rule. */
const TWELVE_CHARACTERS = "Copper-Lan4!";
/** 9 characters: too short for every account. */
const NINE_CHARACTERS = "Fjord-La4";

/** The accounts of a group, by what makes their rule. */
const KINDS = [
  "platformAdmin",
  "liveOwner",
  "testAdmin",
  "suspendedOwner",
  "agent",
  "formerOwner",
  "deprovisioningOwner",
] as const;
type Kind = (typeof KINDS)[number];
const PRIVILEGED: readonly Kind[] = ["platformAdmin", "liveOwner", "testAdmin", "suspendedOwner"];
const STANDARD: readonly Kind[] = ["agent", "formerOwner", "deprovisioningOwner"];

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
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
/** A documentation IP (RFC 5737) of its own for each account, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${100 + ipCounter}`;
}

let counter = 0;
/**
 * The seven accounts of a group, each with CURRENT_PASSWORD: a platform admin with MFA and no membership, the owner
 * of a live OTA with MFA, an admin of a test OTA, an agent of that OTA, an account whose owner membership of it was
 * removed, the owner of a suspended test OTA (members still see it) and the active owner of an OTA being deleted
 * (`deprovisioning`: members no longer see it, as `listActiveMemberships` reads them).
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

/** The envelope's message of a refusal. */
function messageOf(res: Response | undefined): unknown {
  return (res?.body as { error?: { message?: unknown } } | undefined)?.error?.message;
}

async function passwordHashOf(accountId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT password_hash FROM platform.accounts WHERE id = $1", [accountId]);
  return (rows[0] as { password_hash: string | null }).password_hash;
}

beforeAll(async () => {
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  currentHash = await t.app.get(PasswordPolicy).hash(CURRENT_PASSWORD);
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
  /** The admin of the test OTA signs in with its 11-character password before and after the refusals. */
  const signIns: Record<string, Response> = {};
  const hashes: Partial<Record<Kind, { before: string | null; afterRefusals: string | null }>> = {};

  beforeAll(async () => {
    accounts = await accountsOfAGroup("chg");
    const adminIp = nextIp();
    signIns["before"] = await signIn(accounts.testAdmin.email, CURRENT_PASSWORD, adminIp);
    for (const kind of KINDS) {
      const ip = kind === "testAdmin" ? adminIp : nextIp();
      const accessToken = await tokenOf(accounts[kind]);
      const before = await passwordHashOf(accounts[kind].id);
      const tries: Record<string, Response> = {};
      for (const [name, password] of [
        ["nine", NINE_CHARACTERS],
        ["eleven", ELEVEN_CHARACTERS],
        ["noDigit", NO_DIGIT],
        ["noLetter", NO_LETTER],
      ] as const) {
        if (PRIVILEGED.includes(kind) || name === "nine") {
          tries[name] = await changePassword(accessToken, ip, password);
        }
      }
      if (kind === "testAdmin") {
        signIns["afterRefusals"] = await signIn(accounts.testAdmin.email, CURRENT_PASSWORD, adminIp);
      }
      hashes[kind] = { before, afterRefusals: await passwordHashOf(accounts[kind].id) };
      tries["accepted"] = await changePassword(
        accessToken,
        ip,
        PRIVILEGED.includes(kind) ? TWELVE_CHARACTERS : ELEVEN_CHARACTERS,
      );
      answers[kind] = tries;
    }
    signIns["new"] = await signIn(accounts.testAdmin.email, TWELVE_CHARACTERS, adminIp);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[FIX-W47-PLATFORM AC2] asks a platform admin, the owner of a live OTA, an admin of a test OTA and the owner of a suspended OTA for 12 characters with a letter and a digit", () => {
    for (const kind of PRIVILEGED) {
      const tries = answers[kind] ?? {};
      for (const res of Object.values(tries)) {
        expectResponseToMatch("changePassword", res, { document: "platform" });
      }
      expect(
        Object.fromEntries(Object.entries(tries).map(([name, res]) => [name, outcomeOf(res)])),
        kind,
      ).toEqual({
        nine: "422 PASSWORD_TOO_WEAK /newPassword:privileged_rule",
        eleven: "422 PASSWORD_TOO_WEAK /newPassword:privileged_rule",
        noDigit: "422 PASSWORD_TOO_WEAK /newPassword:privileged_rule",
        noLetter: "422 PASSWORD_TOO_WEAK /newPassword:privileged_rule",
        accepted: "204",
      });
      // The message names the rule; the field error says it in a sentence of its own.
      expect(messageOf(tries["eleven"]), kind).toBe(RULE_MESSAGES.privileged);
      expect((tries["eleven"]?.body as { error: { fieldErrors: unknown } }).error.fieldErrors).toEqual([
        {
          path: "/newPassword",
          code: "privileged_rule",
          message: expect.stringMatching(
            /^Use at least 12 characters, with at least one letter and one digit/,
          ),
        },
      ]);
    }
  });

  it("[FIX-W47-PLATFORM AC2] keeps the 10-character rule for an agent, an account whose owner membership was removed and the owner of an OTA being deleted", () => {
    for (const kind of STANDARD) {
      const tries = answers[kind] ?? {};
      for (const res of Object.values(tries)) {
        expectResponseToMatch("changePassword", res, { document: "platform" });
      }
      expect(
        Object.fromEntries(Object.entries(tries).map(([name, res]) => [name, outcomeOf(res)])),
        kind,
      ).toEqual({ nine: "422 PASSWORD_TOO_WEAK /newPassword:too_short", accepted: "204" });
      expect(messageOf(tries["nine"]), kind).toBe(RULE_MESSAGES.standard);
    }
  });

  it("[FIX-W47-PLATFORM AC2] lets an existing short password keep working until the account sets a new one", async () => {
    // The privileged accounts' 11-character password was accepted as their current one, and the admin signed in with
    // it before and after the refusals, which changed no hash.
    expect(outcomeOf(signIns["before"] as Response)).toBe("200");
    expect(outcomeOf(signIns["afterRefusals"] as Response)).toBe("200");
    for (const kind of KINDS) {
      expect(hashes[kind]?.afterRefusals, kind).toBe(hashes[kind]?.before);
      expect(await passwordHashOf(accounts[kind].id), kind).not.toBe(hashes[kind]?.before);
    }
    expect(outcomeOf(signIns["new"] as Response)).toBe("200");
    const policy = t.app.get(PasswordPolicy);
    expect(await policy.verify((await passwordHashOf(accounts.liveOwner.id)) ?? "", TWELVE_CHARACTERS)).toBe(
      true,
    );
    expect(await policy.verify((await passwordHashOf(accounts.agent.id)) ?? "", ELEVEN_CHARACTERS)).toBe(
      true,
    );
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
      if (PRIVILEGED.includes(kind)) {
        tries["eleven"] = await confirmReset(token, ip, ELEVEN_CHARACTERS);
        tries["noDigit"] = await confirmReset(token, ip, NO_DIGIT);
      } else {
        tries["nine"] = await confirmReset(token, ip, NINE_CHARACTERS);
      }
      // A refusal leaves the link usable: the same token sets the password the rule accepts.
      tries["accepted"] = await confirmReset(
        token,
        ip,
        PRIVILEGED.includes(kind) ? TWELVE_CHARACTERS : ELEVEN_CHARACTERS,
      );
      answers[kind] = tries;
    }
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[FIX-W47-PLATFORM AC2] asks a platform admin, the owner of a live OTA, an admin of a test OTA and the owner of a suspended OTA for 12 characters with a letter and a digit", async () => {
    for (const kind of PRIVILEGED) {
      const tries = answers[kind] ?? {};
      for (const res of Object.values(tries)) {
        expectResponseToMatch("confirmPasswordReset", res, { document: "platform" });
      }
      expect(
        Object.fromEntries(Object.entries(tries).map(([name, res]) => [name, outcomeOf(res)])),
        kind,
      ).toEqual({
        eleven: "422 PASSWORD_TOO_WEAK /newPassword:privileged_rule",
        noDigit: "422 PASSWORD_TOO_WEAK /newPassword:privileged_rule",
        accepted: "204",
      });
      expect(messageOf(tries["eleven"]), kind).toBe(RULE_MESSAGES.privileged);
      expect(await passwordHashOf(accounts[kind].id), kind).not.toBe(currentHash);
    }
  });

  it("[FIX-W47-PLATFORM AC2] keeps the 10-character rule for an agent, an account whose owner membership was removed and the owner of an OTA being deleted", async () => {
    for (const kind of STANDARD) {
      const tries = answers[kind] ?? {};
      for (const res of Object.values(tries)) {
        expectResponseToMatch("confirmPasswordReset", res, { document: "platform" });
      }
      expect(
        Object.fromEntries(Object.entries(tries).map(([name, res]) => [name, outcomeOf(res)])),
        kind,
      ).toEqual({ nine: "422 PASSWORD_TOO_WEAK /newPassword:too_short", accepted: "204" });
      expect(messageOf(tries["nine"]), kind).toBe(RULE_MESSAGES.standard);
      expect(await passwordHashOf(accounts[kind].id), kind).not.toBe(currentHash);
    }
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
