// A rotation of the platform's JWT signing key (FIX-W48-PLATFORM, lead decision (15f) of 2026-11-11; ADR-0010
// "Rotation": the old public key stays valid for one token lifetime; platform/docs/runbooks/platform-operations.md §7)
// through the HTTP pipeline (createTestApp). The API runs twice on the same new signing key, one after the other:
// first with JWT_PREVIOUS_PUBLIC_KEY_FILE naming the public half of the key it signed with before the rotation, then
// with the variable removed. A portal and an admin token signed with the old key are accepted during the overlap and
// refused once it is removed; a token of a key the API never had is refused throughout; the API signs with the new
// key only. Every answer is checked against the platform document, and no log line holds a token.
//
// Each application has its own database clone and flushes this worker's Redis database, so they run one after the
// other (createTestApp), each with the same account rows.
import { decodeProtectedHeader } from "jose";
import type { ConfigService } from "@nestjs/config";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import type { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import type { PlatformBackendConfig } from "../../../src/config";
import { insertAccount, testId } from "../../builders/platform-rows";
import { createTestApp, type TestApp } from "../../support/app";
import {
  createTestJwtKeyFile,
  publicKeyPemOf,
  writeTestKeyFile,
  type TestKeyFile,
} from "../../support/jwt-key";

/**
 * Each application starts on a database clone and the platform document is parsed once (a few seconds alone); the
 * bound allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;

const PORTAL_ACCOUNT = testId("acc", 9101);
const ADMIN_ACCOUNT = testId("acc", 9102);

/** The keys of the rotation: the new signing key, the old one (its public half in a file of its own) and a stranger. */
let currentKey: TestKeyFile;
let oldKey: TestKeyFile;
let oldPublicKey: TestKeyFile;
let strangerKey: TestKeyFile;

/** Every token this file made, for the log scans. */
const tokensMade = new Set<string>();

/** A TokenService on key file `path` alone, as the API had before the rotation (or a stranger's). */
function signerOn(path: string, clock: Clock): TokenService {
  const config = {
    get: (key: string) => (key === "JWT_PRIVATE_KEY_FILE" ? path : undefined),
  } as unknown as ConfigService<PlatformBackendConfig, true>;
  return new TokenService(config, clock);
}

const PORTAL_TOKEN: AccessTokenInput = {
  aud: "portal",
  sub: PORTAL_ACCOUNT,
  sid: testId("asn", 9101),
  ev: true,
  amr: ["pwd"],
};

/** The tokens of one run, by who signed them. */
interface Tokens {
  readonly old: string;
  readonly oldAdmin: string;
  readonly current: string;
  readonly stranger: string;
}

/** Inserts the two accounts into the application's database and signs the tokens of the run at its clock. */
async function arrange(t: TestApp): Promise<Tokens> {
  const pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  await insertAccount(pool, { id: PORTAL_ACCOUNT, email: `rotation-portal-${Date.now()}@example.com` });
  await insertAccount(pool, {
    id: ADMIN_ACCOUNT,
    email: `rotation-admin-${Date.now()}@example.com`,
    is_platform_admin: true,
    mfa_enabled: true,
  });
  const before = signerOn(oldKey.path, t.clock);
  const signed = {
    old: (await before.sign(PORTAL_TOKEN)).token,
    oldAdmin: (
      await before.sign({
        aud: "platform_admin",
        sub: ADMIN_ACCOUNT,
        sid: testId("asn", 9102),
        ev: true,
        amr: ["pwd", "otp"],
      })
    ).token,
    current: (await t.app.get(TokenService).sign(PORTAL_TOKEN)).token,
    stranger: (await signerOn(strangerKey.path, t.clock).sign(PORTAL_TOKEN)).token,
  };
  for (const token of Object.values(signed)) {
    tokensMade.add(token);
  }
  return signed;
}

function getMe(t: TestApp, token: string): Promise<Response> {
  return t.http.get("/v1/me").set({ Authorization: `Bearer ${token}`, ...t.bffHeaders("203.0.113.71") });
}

function adminMe(t: TestApp, token: string): Promise<Response> {
  return t.http
    .get("/v1/admin/me")
    .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders("203.0.113.72") });
}

/** `200`, or the status and the error code. */
function outcomeOf(res: Response): string {
  const code = (res.body as { error?: { code?: string } } | undefined)?.error?.code;
  return code === undefined ? String(res.status) : `${res.status} ${code}`;
}

/** The logs of an application hold none of the tokens. */
function expectNoTokenIn(t: TestApp): void {
  const text = t.logs.lines.map((line) => JSON.stringify(line)).join("\n");
  for (const token of tokensMade) {
    expect(text.includes(token)).toBe(false);
  }
}

beforeAll(() => {
  currentKey = createTestJwtKeyFile();
  oldKey = createTestJwtKeyFile();
  oldPublicKey = writeTestKeyFile(publicKeyPemOf(oldKey.pem));
  strangerKey = createTestJwtKeyFile();
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in a test.
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  for (const file of [currentKey, oldKey, oldPublicKey, strangerKey]) {
    file?.remove();
  }
});

describe("during the overlap: JWT_PREVIOUS_PUBLIC_KEY_FILE names the old key", () => {
  let t: TestApp;
  let tokens: Tokens;
  const answers: Record<string, Response> = {};

  beforeAll(async () => {
    t = await createTestApp({
      env: { JWT_PRIVATE_KEY_FILE: currentKey.path, JWT_PREVIOUS_PUBLIC_KEY_FILE: oldPublicKey.path },
    });
    tokens = await arrange(t);
    answers["old"] = await getMe(t, tokens.old);
    answers["current"] = await getMe(t, tokens.current);
    answers["stranger"] = await getMe(t, tokens.stranger);
    answers["oldAdmin"] = await adminMe(t, tokens.oldAdmin);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await t?.close();
  }, SETUP_TIMEOUT_MS);

  it("[FIX-W48-PLATFORM AC2] accepts the old key's portal and admin tokens and the new key's, and refuses an unknown kid", () => {
    expectResponseToMatch("getMe", answers["old"] as Response, { document: "platform" });
    expectResponseToMatch("getMe", answers["current"] as Response, { document: "platform" });
    expectResponseToMatch("getMe", answers["stranger"] as Response, { document: "platform" });
    expectResponseToMatch("adminGetMe", answers["oldAdmin"] as Response, { document: "platform" });
    expect(Object.fromEntries(Object.entries(answers).map(([name, res]) => [name, outcomeOf(res)]))).toEqual({
      old: "200",
      current: "200",
      stranger: "401 UNAUTHENTICATED",
      oldAdmin: "200",
    });
    expect((answers["old"]?.body as { id: string }).id).toBe(PORTAL_ACCOUNT);
  });

  it("[FIX-W48-PLATFORM AC2] signs with the new key only", () => {
    const service = t.app.get(TokenService);
    expect(service.previousKid).toBe(signerOn(oldKey.path, t.clock).kid);
    expect(service.kid).toBe(signerOn(currentKey.path, t.clock).kid);
    expect(decodeProtectedHeader(tokens.current).kid).toBe(service.kid);
    expect(decodeProtectedHeader(tokens.old).kid).toBe(service.previousKid);
    expectNoTokenIn(t);
  });
});

describe("after the overlap: the variable is removed", () => {
  let t: TestApp;
  const answers: Record<string, Response> = {};

  beforeAll(async () => {
    t = await createTestApp({ env: { JWT_PRIVATE_KEY_FILE: currentKey.path } });
    const tokens = await arrange(t);
    answers["old"] = await getMe(t, tokens.old);
    answers["current"] = await getMe(t, tokens.current);
    answers["stranger"] = await getMe(t, tokens.stranger);
    answers["oldAdmin"] = await adminMe(t, tokens.oldAdmin);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await t?.close();
  }, SETUP_TIMEOUT_MS);

  it("[FIX-W48-PLATFORM AC2] refuses the old key's tokens and an unknown kid, and keeps accepting the new key's", () => {
    for (const [name, res] of Object.entries(answers)) {
      expectResponseToMatch(name === "oldAdmin" ? "adminGetMe" : "getMe", res, { document: "platform" });
    }
    expect(Object.fromEntries(Object.entries(answers).map(([name, res]) => [name, outcomeOf(res)]))).toEqual({
      old: "401 UNAUTHENTICATED",
      current: "200",
      stranger: "401 UNAUTHENTICATED",
      oldAdmin: "401 UNAUTHENTICATED",
    });
    expect(t.app.get(TokenService).previousKid).toBeUndefined();
    expectNoTokenIn(t);
  });
});
