// TOTP MFA without a database or Redis (PBE-015; scope PF-04, PADR-0008 "MFA"): the TOTP parameters and the ±1 step
// window, the recovery code format, its normalisation and hash, the pending set-up, the associated data of the two
// places a secret is kept, and the decisions of MfaService that the integration test reaches only with effort (a
// challenge of the admin surface, the per-account limit, Redis down, an account that lost MFA or may no longer sign
// in, the attempt counting, the platform admin, a Redis failure once MFA is on). The stand-ins record what the service
// asked of them; the integration test (test/integration/accounts/mfa.int.test.ts) runs the same rules through HTTP,
// PostgreSQL and Redis. Every secret and code here is made up on the spot; none is a secret.
import { sha256Hex } from "@velexis/crypto";
import { isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { authenticator } from "otplib";
import { describe, expect, it, vi } from "vitest";
import type { AuditService } from "../audit/audit.service";
import type { AccountsRepository, MfaAccount } from "../auth/accounts.repository";
import { MfaRateLimitedError, type MfaChallenge, type MfaChallengeStore } from "../auth/mfa-challenge.store";
import type { SessionsService } from "../auth/sessions.service";
import type { SignInService } from "../auth/sign-in.service";
import { associatedData, type EnvelopeService } from "../common/crypto.provider";
import type { PlatformDb } from "../common/database";
import type { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import type { OutboxService } from "../notifications/outbox.service";
import {
  accountSecretPlace,
  generateRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  matchTotp,
  MFA_CHANGES,
  MfaService,
  normaliseRecoveryCode,
  otpauthUrl,
  parsePendingMfaSetup,
  pendingSecretPlace,
  RECOVERY_CODE_ALPHABET,
  recoveryCodeHash,
  totpCode,
  totpStep,
} from "./mfa.service";
import type { RecoveryCodesRepository } from "./recovery-codes.repository";

const START = new Date("2026-10-17T09:00:00.000Z");
const STEP_MS = 30_000;
const ACCOUNT_ID = "acc_01JA2ZA1C5E9G3J7K2M6P00001";
/** A made-up base32 secret of 32 characters. */
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const CHALLENGE_TOKEN = `mfa_${"C".repeat(43)}`;

describe("TOTP", () => {
  it("makes 160-bit base32 secrets and an otpauth URI with the platform's parameters", () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(20);
    for (const secret of secrets) {
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    }
    const uri = new URL(otpauthUrl("anna+ota@example.com", SECRET));
    expect(`${uri.protocol}//${uri.hostname}${decodeURIComponent(uri.pathname)}`).toBe(
      "otpauth://totp/Velexis:anna+ota@example.com",
    );
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: SECRET,
      issuer: "Velexis",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });
  });

  it("computes the code an authenticator app shows (SHA-1, 6 digits, 30 s)", () => {
    const app = authenticator.clone({ epoch: START.getTime() });
    expect(totpCode(SECRET, START)).toBe(app.generate(SECRET));
    expect(totpCode(SECRET, START)).toMatch(/^[0-9]{6}$/);
    expect(totpStep(START)).toBe(Math.floor(START.getTime() / STEP_MS));
  });

  it("accepts the codes of the current step and of the steps before and after it, and nothing else", () => {
    const step = totpStep(START);
    const at = (deltaSteps: number): Date => new Date(START.getTime() + deltaSteps * STEP_MS);
    expect(matchTotp(SECRET, totpCode(SECRET, at(0)), START)).toBe(step);
    expect(matchTotp(SECRET, totpCode(SECRET, at(-1)), START)).toBe(step - 1);
    expect(matchTotp(SECRET, totpCode(SECRET, at(1)), START)).toBe(step + 1);
    const nearby = new Set([-1, 0, 1].map((delta) => totpCode(SECRET, at(delta))));
    for (const delta of [-3, -2, 2, 3]) {
      const code = totpCode(SECRET, at(delta));
      // A far step's code is refused, unless it happens to equal a nearby step's code (one chance in 10^6 each).
      expect(matchTotp(SECRET, code, START), String(delta)).toEqual(
        nearby.has(code) ? expect.any(Number) : undefined,
      );
    }
    for (const code of ["", "12345", "1234567", "12345a", " 123456"]) {
      expect(matchTotp(SECRET, code, START), code).toBeUndefined();
    }
    // Another secret's code is not this secret's.
    expect(matchTotp("KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU", totpCode(SECRET, START), START)).toBeUndefined();
  });
});

describe("recovery codes", () => {
  it("are four groups of four Crockford base32 characters, 80 random bits, ten distinct ones per set", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(500);
    for (const code of codes) {
      expect(code).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      );
    }
    // Every character of the alphabet occurs, in every position (5 bits each, 16 positions: 80 bits).
    const characters = new Set([...codes].join("").replaceAll("-", ""));
    expect([...characters].sort().join("")).toBe(RECOVERY_CODE_ALPHABET);
    const set = generateRecoveryCodes();
    expect(set).toHaveLength(10);
    expect(new Set(set).size).toBe(10);
  });

  it("accept any letter case, dashes and spaces, O for 0 and I or L for 1, and nothing that cannot be a code", () => {
    expect(normaliseRecoveryCode("7KQ4-M2XP-9TRW-H5ZD")).toBe("7KQ4M2XP9TRWH5ZD");
    expect(normaliseRecoveryCode("7kq4 m2xp 9trw h5zd")).toBe("7KQ4M2XP9TRWH5ZD");
    expect(normaliseRecoveryCode("7kq4m2xp9trwh5zd")).toBe("7KQ4M2XP9TRWH5ZD");
    expect(normaliseRecoveryCode("O1IL-0000-1111-2222")).toBe("0111000011112222");
    for (const input of [
      "7KQ4-M2XP-9TRW-H5Z",
      "7KQ4-M2XP-9TRW-H5ZDD",
      "UKQ4-M2XP-9TRW-H5ZD",
      "7KQ4_M2XP_9TRW_H5ZD",
    ]) {
      expect(normaliseRecoveryCode(input), input).toBeUndefined();
    }
    expect(recoveryCodeHash("7kq4 m2xp 9trw h5zd")).toBe(sha256Hex("7KQ4M2XP9TRWH5ZD"));
    expect(recoveryCodeHash("7KQ4-M2XP-9TRW-H5ZD")).toBe(recoveryCodeHash("7kq4m2xp9trwh5zd"));
    expect(recoveryCodeHash("short")).toBeUndefined();
  });
});

describe("the places of a TOTP secret", () => {
  it("binds the pending secret to its Redis key and the enabled one to the account's column (ADR-0010)", () => {
    expect(associatedData(pendingSecretPlace(ACCOUNT_ID))).toBe(`redis.mfasetup.totp_secret:${ACCOUNT_ID}`);
    expect(associatedData(accountSecretPlace(ACCOUNT_ID))).toBe(
      `platform.accounts.mfa_secret_ciphertext:${ACCOUNT_ID}`,
    );
  });

  it("reads a pending set-up back, and nothing that is not one", () => {
    expect(
      parsePendingMfaSetup(JSON.stringify({ v: 1, ciphertext: "AQID", createdAt: 1_700_000_000_000 })),
    ).toEqual({ v: 1, ciphertext: "AQID", createdAt: 1_700_000_000_000 });
    for (const text of [
      null,
      "",
      "not json",
      "null",
      JSON.stringify({ v: 2, ciphertext: "AQID", createdAt: 1 }),
      JSON.stringify({ v: 1, ciphertext: "", createdAt: 1 }),
      JSON.stringify({ v: 1, ciphertext: "AQID", createdAt: "1" }),
    ]) {
      expect(parsePendingMfaSetup(text), String(text)).toBeUndefined();
    }
  });
});

/** An account with MFA as the repository reads it. */
function mfaAccount(change: Partial<MfaAccount> = {}): MfaAccount {
  return {
    id: ACCOUNT_ID,
    email: "kari.nordmann@example.com",
    full_name: "Kari Nordmann",
    status: "active",
    is_platform_admin: false,
    mfa_enabled: true,
    mfa_secret_ciphertext: Buffer.from(`enc:${SECRET}`),
    deleted_at: null,
    ...change,
  };
}

/** MfaService over stand-ins that record what it asked of them. */
class Harness {
  readonly clock = new FakeClock(START);
  account: MfaAccount | undefined = mfaAccount();
  challenge: MfaChallenge | undefined = {
    v: 1,
    audience: "portal",
    accountId: ACCOUNT_ID,
    issuedAt: START.getTime(),
    maxAttempts: 5,
  };
  attempts = 0;
  /** The reply of the `mfa` limit's counter: hits and milliseconds left, or an error (Redis down). */
  limitReply: [number, number] | Error = [1, 600_000];
  lastStep: number | undefined;
  readonly deleted: string[] = [];
  readonly audited: Array<Record<string, unknown>> = [];
  readonly queued: Array<Record<string, unknown>> = [];
  readonly sessionsStarted: Array<{ accountId: string; mfaVerifiedAt: Date | null }> = [];
  readonly disabled: string[] = [];
  /** The pending set-up `mfasetup:<accountId>` holds: SECRET, "encrypted" as the envelope stand-in reads it. */
  pendingSetup: string | null = JSON.stringify({
    v: 1,
    ciphertext: Buffer.from(`enc:${SECRET}`).toString("base64"),
    createdAt: START.getTime(),
  });
  /** The reply of Redis's DEL: the keys removed, or an error (Redis lost). */
  delReply: number | Error = 1;
  readonly removedKeys: string[] = [];
  readonly enabled: Array<{ accountId: string; secret: string; kekId: string }> = [];
  storedCodeHashes: readonly string[] = [];
  readonly warnings: string[] = [];
  readonly service: MfaService;

  constructor() {
    const challenges = {
      find: () => Promise.resolve(this.challenge),
      recordAttempt: () => Promise.resolve(++this.attempts),
      delete: (token: string) => {
        this.deleted.push(token);
        const existed = this.challenge !== undefined;
        this.challenge = undefined;
        return Promise.resolve(existed);
      },
    };
    const accounts = {
      findMfaAccount: () => Promise.resolve(this.account),
      lockMfaAccount: () => Promise.resolve(this.account),
      disableMfa: (_trx: unknown, accountId: string) => {
        this.disabled.push(accountId);
        return Promise.resolve(true);
      },
      enableMfa: (_trx: unknown, accountId: string, mfa: { secretCiphertext: Uint8Array; kekId: string }) => {
        const secret = Buffer.from(mfa.secretCiphertext).toString().slice(4);
        this.enabled.push({ accountId, secret, kekId: mfa.kekId });
        return Promise.resolve(true);
      },
    };
    const recoveryCodes = {
      replaceAll: (_trx: unknown, _accountId: string, codeHashes: readonly string[]) => {
        this.storedCodeHashes = codeHashes;
        return Promise.resolve();
      },
      use: () => Promise.resolve(false),
      deleteAll: () => Promise.resolve(10),
      countUnused: () => Promise.resolve(10),
    };
    const envelope = {
      decrypt: (ciphertext: Uint8Array) =>
        Promise.resolve(Buffer.from(Buffer.from(ciphertext).toString().slice(4))),
      encrypt: (plaintext: Uint8Array) =>
        Promise.resolve({
          ciphertext: Buffer.concat([Buffer.from("enc:"), Buffer.from(plaintext)]),
          kekId: "local:v1",
        }),
    };
    const redis = {
      get: () => Promise.resolve(this.pendingSetup),
      del: (key: string) => {
        this.removedKeys.push(key);
        return this.delReply instanceof Error
          ? Promise.reject(this.delReply)
          : Promise.resolve(this.delReply);
      },
      eval: vi.fn((script: string, _keys: number, _key: string, value: string) => {
        if (script.includes("INCR")) {
          return this.limitReply instanceof Error
            ? Promise.reject(this.limitReply)
            : Promise.resolve(this.limitReply);
        }
        const step = Number(value);
        if (this.lastStep !== undefined && this.lastStep >= step) {
          return Promise.resolve(0);
        }
        this.lastStep = step;
        return Promise.resolve(1);
      }),
    };
    const db = { transaction: () => ({ execute: <T>(fn: (trx: object) => Promise<T>) => fn({}) }) };
    const audit = {
      record: (_trx: unknown, entry: Record<string, unknown>) => {
        this.audited.push(entry);
        return Promise.resolve();
      },
    };
    const outbox = {
      queue: (_trx: unknown, input: Record<string, unknown>) => {
        this.queued.push(input);
        return Promise.resolve({ emailId: "eml_x", queued: true });
      },
    };
    const signIns = {
      startSession: (accountId: string, options: { mfaVerifiedAt: Date | null }) => {
        this.sessionsStarted.push({ accountId, mfaVerifiedAt: options.mfaVerifiedAt });
        return Promise.resolve({ accessToken: "test-access-token" });
      },
    };
    this.service = new MfaService(
      accounts as unknown as AccountsRepository,
      recoveryCodes as unknown as RecoveryCodesRepository,
      challenges as unknown as MfaChallengeStore,
      signIns as unknown as SignInService,
      {} as SessionsService,
      envelope as unknown as EnvelopeService,
      audit as unknown as AuditService,
      outbox as unknown as OutboxService,
      { publishAfterCommit: vi.fn() } as unknown as InvalidationPublisher,
      this.clock,
      db as unknown as PlatformDb,
      redis as unknown as ConstructorParameters<typeof MfaService>[11],
      {
        warn: (_object: unknown, message: string) => {
          this.warnings.push(message);
        },
      } as unknown as PinoLogger,
    );
  }

  verify(code: string): Promise<unknown> {
    return this.service.verifyMfa({ mfaChallengeToken: CHALLENGE_TOKEN, code });
  }
}

/** The catalogue code of what `promise` rejected with. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : String(error);
  }
  return "resolved";
}

describe("MfaService.verifyMfa", () => {
  it("completes the challenge with a valid code: the challenge ends and the session records the verification", async () => {
    const h = new Harness();

    await expect(h.verify(totpCode(SECRET, START))).resolves.toEqual({ accessToken: "test-access-token" });

    expect(h.deleted).toEqual([CHALLENGE_TOKEN]);
    expect(h.sessionsStarted).toEqual([{ accountId: ACCOUNT_ID, mfaVerifiedAt: START }]);
    expect(h.lastStep).toBe(totpStep(START));
  });

  it("refuses a challenge of the admin surface, or none, without counting an attempt", async () => {
    const h = new Harness();
    h.challenge = { ...(h.challenge as MfaChallenge), audience: "platform_admin" };
    expect(await rejection(h.verify(totpCode(SECRET, START)))).toBe("MFA_CHALLENGE_INVALID");
    h.challenge = undefined;
    expect(await rejection(h.verify(totpCode(SECRET, START)))).toBe("MFA_CHALLENGE_INVALID");
    expect(h.attempts).toBe(0);
    expect(h.sessionsStarted).toEqual([]);
  });

  it("ends the challenge after the fifth wrong code, and refuses an attempt past the limit", async () => {
    const h = new Harness();
    const wrong = String((Number(totpCode(SECRET, START)) + 500_000) % 1_000_000).padStart(6, "0");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await rejection(h.verify(wrong))).toBe("MFA_CODE_INVALID");
    }
    expect(h.deleted).toEqual([]);
    expect(await rejection(h.verify(wrong))).toBe("MFA_CODE_INVALID");
    expect(h.deleted).toEqual([CHALLENGE_TOKEN]);
    expect(h.audited.map((entry) => entry["details"])).toEqual(
      [1, 2, 3, 4, 5].map((attempt) => ({
        reason: "invalid_mfa_code",
        method: "totp",
        attempt,
        maxAttempts: 5,
      })),
    );

    // Concurrent attempts that pass the limit before the challenge is gone end it too.
    const late = new Harness();
    late.attempts = 5;
    expect(await rejection(late.verify(totpCode(SECRET, START)))).toBe("MFA_CHALLENGE_INVALID");
    expect(late.deleted).toEqual([CHALLENGE_TOKEN]);
    expect(late.sessionsStarted).toEqual([]);
  });

  it("refuses a code of a step the account used already", async () => {
    const h = new Harness();
    h.lastStep = totpStep(START);
    expect(await rejection(h.verify(totpCode(SECRET, START)))).toBe("MFA_CODE_INVALID");
    // The next step's code is still good (an authenticator app moves on).
    expect(await rejection(h.verify(totpCode(SECRET, new Date(START.getTime() + STEP_MS))))).toBe("resolved");
  });

  it("ends the challenge of an account that has no MFA any more or may no longer sign in", async () => {
    for (const change of [
      { mfa_enabled: false },
      { mfa_secret_ciphertext: null },
      { status: "disabled" },
      { deleted_at: START },
    ] satisfies Array<Partial<MfaAccount>>) {
      const h = new Harness();
      h.account = mfaAccount(change);
      expect(await rejection(h.verify(totpCode(SECRET, START))), JSON.stringify(change)).toBe(
        "MFA_CHALLENGE_INVALID",
      );
      expect(h.deleted).toEqual([CHALLENGE_TOKEN]);
      expect(h.sessionsStarted).toEqual([]);
    }
  });

  it("answers 429 with the seconds left over the account's limit, and 503 while Redis cannot count", async () => {
    const limited = new Harness();
    limited.limitReply = [11, 123_400];
    const error = await limited.verify(totpCode(SECRET, START)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MfaRateLimitedError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", status: 429, retryAfterSeconds: 124 });
    expect(limited.attempts).toBe(0);

    const down = new Harness();
    down.limitReply = new Error("connection refused");
    expect(await rejection(down.verify(totpCode(SECRET, START)))).toBe("SERVICE_UNAVAILABLE");
    expect(down.sessionsStarted).toEqual([]);
  });
});

describe("MfaService.enable", () => {
  /** An account that has set MFA up but not enabled it yet. */
  function settingUp(): Harness {
    const h = new Harness();
    h.account = mfaAccount({ mfa_enabled: false, mfa_secret_ciphertext: null });
    return h;
  }

  it("moves the pending secret into the account, answers ten codes stored as their hashes and removes the set-up", async () => {
    const h = settingUp();

    const { recoveryCodes } = await h.service.enable(ACCOUNT_ID, { code: totpCode(SECRET, START) });

    expect(recoveryCodes).toHaveLength(10);
    expect(h.storedCodeHashes).toEqual(recoveryCodes.map((code) => recoveryCodeHash(code)));
    expect(h.enabled).toEqual([{ accountId: ACCOUNT_ID, secret: SECRET, kekId: "local:v1" }]);
    expect(h.removedKeys).toEqual([`mfasetup:${ACCOUNT_ID}`]);
    expect(h.warnings).toEqual([]);
  });

  it("still answers the ten codes when Redis cannot remove the used set-up, and logs it", async () => {
    // MFA is on once the transaction has committed: an error now would leave the person without their codes.
    const h = settingUp();
    h.delReply = new Error("Connection is closed.");

    const { recoveryCodes } = await h.service.enable(ACCOUNT_ID, { code: totpCode(SECRET, START) });

    expect(recoveryCodes).toHaveLength(10);
    expect(h.enabled).toHaveLength(1);
    expect(h.removedKeys).toEqual([`mfasetup:${ACCOUNT_ID}`]);
    expect(h.warnings).toEqual(["mfa.setup_cleanup_failed"]);
  });

  it("answers MFA_SETUP_EXPIRED without a set-up or ten minutes after it started, and changes nothing", async () => {
    const missing = settingUp();
    missing.pendingSetup = null;
    expect(await rejection(missing.service.enable(ACCOUNT_ID, { code: totpCode(SECRET, START) }))).toBe(
      "MFA_SETUP_EXPIRED",
    );

    const late = settingUp();
    late.clock.advance(10 * 60_000);
    const code = totpCode(SECRET, late.clock.now());
    expect(await rejection(late.service.enable(ACCOUNT_ID, { code }))).toBe("MFA_SETUP_EXPIRED");

    for (const h of [missing, late]) {
      expect(h.enabled).toEqual([]);
      expect(h.lastStep).toBeUndefined();
    }
  });
});

describe("MfaService.disable", () => {
  it("refuses a platform admin with FORBIDDEN and the reason, and changes nothing", async () => {
    const h = new Harness();
    h.account = mfaAccount({ is_platform_admin: true });

    const error = await h.service.disable(ACCOUNT_ID).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "FORBIDDEN", status: 403, details: { reason: "platform_admin" } });
    expect(h.disabled).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.audited).toEqual([]);
  });

  it("turns MFA off for anyone else, e-mails the account and audits without a secret", async () => {
    const h = new Harness();

    await h.service.disable(ACCOUNT_ID);

    expect(h.disabled).toEqual([ACCOUNT_ID]);
    expect(h.queued).toEqual([
      {
        templateKey: "auth.mfa_changed",
        to: "kari.nordmann@example.com",
        accountId: ACCOUNT_ID,
        data: { fullName: "Kari Nordmann", change: MFA_CHANGES.disabled },
      },
    ]);
    expect(h.audited).toEqual([
      expect.objectContaining({ action: "account.mfa_disabled", targetId: ACCOUNT_ID }),
    ]);
    expect(JSON.stringify(h.audited)).not.toContain(SECRET);
  });
});
