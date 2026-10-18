// SessionsService and SignInService without a database or Redis (PBE-014; platform/docs/flows/signup-and-create-ota.md
// step 4, scope PF-03 and PF-06 AC2, PADR-0009 item 4, PADR-0007 item 6): the refresh families and their rotation,
// reuse detection, sign-out, sign-out everywhere, and the sign-in with its lockout, the dummy verification of unknown
// addresses, the disabled account and the MFA challenge.
//
// The repositories are in-memory stand-ins with the semantics of sessions.repository.ts and accounts.repository.ts,
// and a transaction works on its own copy of the rows, which replaces the committed rows only when the work succeeds
// (a throw rolls it back). TokenService is the real one, with a fresh key file and the FakeClock; the audit service
// and the invalidation publisher are the real ones over stand-ins of their repository and of the Redis client.
// PasswordPolicy is a stand-in whose "hash" is a SHA-256, so no test pays for Argon2id here (the integration tests do).
// test/integration/auth/sign-in.int.test.ts and refresh.int.test.ts run the same rules through HTTP, PostgreSQL and
// Redis, the row locks included. Every token and password here is made up on the spot; none is a secret.
import type { ConfigService } from "@nestjs/config";
import type { InvalidationEvent } from "@velexis/api-types/jobs";
import { sha256Hex } from "@velexis/crypto";
import { isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestJwtKeyFile } from "../../test/support/jwt-key";
import type { AuditRepository, AuditRowInsert } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { PlatformDb } from "../common/database";
import { featuresFor, type FeatureSwitches, type MilestoneFeatures } from "../common/features";
import type { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import { MFA_CHALLENGE_TTL_SECONDS, STAFF_DENY_ACCOUNT_TTL_SECONDS } from "../common/redis/redis-keys";
import type { PlatformBackendConfig } from "../config";
import type {
  AccountIdentity,
  AccountsRepository,
  FailedSignIn,
  PortalAccountRecord,
  SignInAccount,
} from "./accounts.repository";
import {
  MFA_CHALLENGE_MAX_ATTEMPTS,
  parseMfaChallenge,
  type IssuedMfaChallenge,
  type MfaChallengeStore,
} from "./mfa-challenge.store";
import type { PasswordPolicy } from "./password-policy";
import type { NewSession, SessionAudience, SessionRecord, SessionsRepository } from "./sessions.repository";
import {
  authMethodsOf,
  maySignIn,
  mfaAtOf,
  PORTAL_FAMILY_TTL_MS,
  PORTAL_REFRESH_TOKEN_TTL_MS,
  refreshTokenExpiry,
  refreshVerdict,
  SessionsService,
  toAccount,
  type PortalSession,
} from "./sessions.service";
import {
  AccountLockedError,
  lockoutRetryAfter,
  MAX_CONSECUTIVE_FAILED_SIGN_INS,
  SIGN_IN_LOCKOUT_MS,
  SignInService,
  type SignInResult,
} from "./sign-in.service";
import { ACCESS_TOKEN_TTL_SECONDS, TokenService } from "./token.service";

const START = "2026-10-17T09:00:00.000Z";
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const IP = "203.0.113.40";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0";
/** A made-up password of the tests; the stand-in policy only hashes it. */
const PASSWORD = "Northern-Lights-Fjord-2026";

/** A prefixed ULID of the shape of the platform's ids (`acc_…`, `stf_…`, `ten_…`) for sequence number `n`. */
function id(prefix: string, n: number): string {
  return `${prefix}_01JA2ZA1C5E9G3J7K2M6P0${String(n).padStart(4, "0")}`;
}

const FEATURES: MilestoneFeatures = featuresFor({
  FEATURE_STRIPE_BILLING: false,
  FEATURE_OWN_STRIPE: false,
  FEATURE_SETTLEMENTS: false,
  FEATURE_OWN_AMADEUS: true,
  FEATURE_CUSTOM_DOMAINS: false,
  FEATURE_LIVE_SWITCH: false,
} as Parameters<typeof featuresFor>[0]);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type SessionRow = Mutable<SessionRecord>;

/** The columns of an account the two services read. */
interface AccountRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  password_hash: string | null;
  email_verified_at: Date | null;
  mfa_enabled: boolean;
  mfa_enabled_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  deleted_at: Date | null;
  locale: string;
  time_zone: string;
  is_platform_admin: boolean;
  created_at: Date;
  version: number;
}

/** The committed state, or a transaction's copy of it. */
interface State {
  readonly sessions: Map<string, SessionRow>;
  readonly accounts: Map<string, AccountRow>;
  readonly audit: AuditRowInsert[];
}

/** A transaction of the stand-in database: its copy of the state and the world's lock log. */
interface FakeTransaction {
  readonly state: State;
}

const copyState = (state: State): State => ({
  sessions: new Map([...state.sessions].map(([key, row]) => [key, { ...row }])),
  accounts: new Map([...state.accounts].map(([key, row]) => [key, { ...row }])),
  audit: [...state.audit],
});

/** The stand-in "hash" of a password: not Argon2id, but distinct per password and never the password itself. */
const fakeHash = (password: string): string => `fake$${sha256Hex(password)}`;

/** The AppError code a promise rejects with, or `ok`. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (isAppError(error)) {
      return error.code;
    }
    throw error;
  }
}

/** The rejection of a promise that must reject. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the promise resolved");
}

const keyFile = createTestJwtKeyFile();
afterAll(() => keyFile.remove());

/** The two services over one in-memory platform, and everything they wrote, published and logged. */
class World {
  state: State = { sessions: new Map(), accounts: new Map(), audit: [] };
  readonly clock = new FakeClock(START);
  /** The locks the transactions took, in order (`account-share:<id>`, `account-update:<id>`, `family:<id>`, …). */
  readonly locks: string[] = [];
  readonly published: InvalidationEvent[] = [];
  /** `SET key value EX ttl` calls on Redis, with the committed session rows revoked at that moment. */
  readonly redisWrites: Array<{ key: string; value: string; ttl: number; revokedRows: number }> = [];
  redisDown = false;
  readonly warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
  /** The hashes PasswordPolicy.verify was asked to compare against, in order. */
  readonly verified: string[] = [];
  /** Runs while a password is being verified: what a concurrent request commits meanwhile. */
  duringVerification: (() => void) | undefined;
  readonly challenges: Array<{ accountId: string; audience: SessionAudience }> = [];
  readonly tokens: TokenService;
  readonly sessions: SessionsService;
  readonly signIns: SignInService;
  private sequence = 0;

  constructor() {
    const config = { get: () => keyFile.path } as unknown as ConfigService<PlatformBackendConfig, true>;
    this.tokens = new TokenService(config, this.clock);
    const db = {
      transaction: () => ({
        execute: async <T>(work: (trx: FakeTransaction) => Promise<T>): Promise<T> => {
          const trx: FakeTransaction = { state: copyState(this.state) };
          const result = await work(trx);
          this.state = trx.state;
          return result;
        },
      }),
    };
    const auditRepository = {
      insert: (trx: FakeTransaction, row: AuditRowInsert) => {
        trx.state.audit.push(row);
        return Promise.resolve({ id: String(trx.state.audit.length), createdAt: this.clock.now() });
      },
    };
    const audit = new AuditService(auditRepository as unknown as AuditRepository);
    const redis = {
      publish: (_channel: string, message: string) => {
        this.published.push(JSON.parse(message) as InvalidationEvent);
        return Promise.resolve(1);
      },
      set: (key: string, value: string, _ex: string, ttl: number) => {
        if (this.redisDown) {
          return Promise.reject(new Error("Redis is down"));
        }
        const revokedRows = [...this.state.sessions.values()].filter((row) => row.revoked_at !== null).length;
        this.redisWrites.push({ key, value, ttl, revokedRows });
        return Promise.resolve("OK");
      },
    };
    const context = { ip: IP, userAgent: USER_AGENT, active: false } as unknown as RequestContext;
    const features = { features: () => FEATURES } as unknown as FeatureSwitches;
    const logger = {
      warn: (fields: Record<string, unknown>, message: string) => this.warnings.push({ fields, message }),
    } as unknown as PinoLogger;
    this.sessions = new SessionsService(
      this.sessionsRepository() as unknown as SessionsRepository,
      this.accountsRepository() as unknown as AccountsRepository,
      this.tokens,
      features,
      audit,
      new InvalidationPublisher(redis as unknown as ConstructorParameters<typeof InvalidationPublisher>[0], {
        warn: () => undefined,
      }),
      new IdGenerator(this.clock),
      this.clock,
      context,
      db as unknown as PlatformDb,
      redis as unknown as ConstructorParameters<typeof SessionsService>[10],
      logger,
    );
    const passwords = {
      hash: (password: string) => Promise.resolve(fakeHash(password)),
      verify: (hash: string, password: string) => {
        this.verified.push(hash);
        this.duringVerification?.();
        return Promise.resolve(hash === fakeHash(password));
      },
    };
    const challenges = {
      create: (accountId: string, audience: SessionAudience): Promise<IssuedMfaChallenge> => {
        this.challenges.push({ accountId, audience });
        return Promise.resolve({ token: `mfa_${"C".repeat(43)}`, expiresIn: MFA_CHALLENGE_TTL_SECONDS });
      },
    };
    this.signIns = new SignInService(
      this.accountsRepository() as unknown as AccountsRepository,
      passwords as unknown as PasswordPolicy,
      this.sessions,
      challenges as unknown as MfaChallengeStore,
      audit,
      this.clock,
      db as unknown as PlatformDb,
    );
  }

  /** Adds an active, verified account with PASSWORD and no MFA; `change` overrides columns. */
  addAccount(change: Partial<AccountRow> = {}): AccountRow {
    this.sequence += 1;
    const row: AccountRow = {
      id: id("acc", this.sequence),
      email: `person${this.sequence}@example.com`,
      full_name: `Person ${this.sequence}`,
      status: "active",
      password_hash: fakeHash(PASSWORD),
      email_verified_at: new Date("2026-10-01T09:00:00.000Z"),
      mfa_enabled: false,
      mfa_enabled_at: null,
      failed_login_count: 0,
      locked_until: null,
      last_login_at: null,
      deleted_at: null,
      locale: "en",
      time_zone: "Europe/Oslo",
      is_platform_admin: false,
      created_at: new Date("2026-10-01T08:00:00.000Z"),
      version: 2,
      ...change,
    };
    this.state.accounts.set(row.id, row);
    return row;
  }

  /** The committed account. */
  account(accountId: string): AccountRow {
    const row = this.state.accounts.get(accountId);
    if (row === undefined) {
      throw new Error(`no account ${accountId}`);
    }
    return { ...row };
  }

  /** Starts a portal family of `accountId` as a sign-in does, and answers its PortalSession. */
  signedIn(accountId: string, mfaVerifiedAt: Date | null = null): Promise<PortalSession> {
    return this.transaction(async (trx) => {
      const issued = await this.sessions.startPortalFamily(
        trx,
        accountId,
        { mfaVerifiedAt },
        this.clock.now(),
      );
      return this.sessions.portalSession(trx, issued);
    });
  }

  /** The committed rows of a family, oldest first. */
  family(familyId: string): SessionRow[] {
    return [...this.state.sessions.values()]
      .filter((row) => row.family_id === familyId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : 1));
  }

  /** Adds an admin family's row of `accountId` (PBE-028 writes them), with the plain token it hashes. */
  addAdminFamily(accountId: string): string {
    this.sequence += 1;
    const familyId = id("asn", this.sequence);
    const token = `rt_${"A".repeat(40)}${String(this.sequence).padStart(3, "0")}`;
    const now = this.clock.now();
    this.state.sessions.set(familyId, {
      id: familyId,
      account_id: accountId,
      active_tenant_id: null,
      audience: "platform_admin",
      refresh_token_hash: sha256Hex(token),
      family_id: familyId,
      replaced_by_id: null,
      user_agent: USER_AGENT,
      ip_address: IP,
      expires_at: new Date(now.getTime() + 2 * 60 * MINUTE_MS),
      family_expires_at: new Date(now.getTime() + 12 * 60 * MINUTE_MS),
      mfa_verified_at: now,
      last_used_at: null,
      rotated_at: null,
      revoked_at: null,
      revoke_reason: null,
      created_at: now,
      updated_at: now,
    });
    return token;
  }

  /** Runs `work` in a transaction of the stand-in database, as the services do. */
  private transaction<T>(work: (trx: never) => Promise<T>): Promise<T> {
    const trx: FakeTransaction = { state: copyState(this.state) };
    return work(trx as never).then((result) => {
      this.state = trx.state;
      return result;
    });
  }

  private sessionsRepository() {
    const find = (trx: FakeTransaction, hash: string): SessionRow | undefined => {
      const row = [...trx.state.sessions.values()].find((session) => session.refresh_token_hash === hash);
      return row === undefined ? undefined : { ...row };
    };
    return {
      insert: (trx: FakeTransaction, session: NewSession) => {
        trx.state.sessions.set(session.id, {
          id: session.id,
          account_id: session.accountId,
          active_tenant_id: null,
          audience: session.audience,
          refresh_token_hash: session.refreshTokenHash,
          family_id: session.familyId,
          replaced_by_id: null,
          user_agent: session.userAgent,
          ip_address: session.ipAddress,
          expires_at: session.expiresAt,
          family_expires_at: session.familyExpiresAt,
          mfa_verified_at: session.mfaVerifiedAt,
          last_used_at: null,
          rotated_at: null,
          revoked_at: null,
          revoke_reason: null,
          created_at: session.now,
          updated_at: session.now,
        });
        return Promise.resolve();
      },
      findByTokenHash: (trx: FakeTransaction, hash: string) => Promise.resolve(find(trx, hash)),
      lockByTokenHash: (trx: FakeTransaction, hash: string) => {
        const row = find(trx, hash);
        this.locks.push(`row:${row?.id ?? "none"}`);
        return Promise.resolve(row);
      },
      lockFamily: (trx: FakeTransaction, familyId: string) => {
        this.locks.push(`family:${familyId}`);
        return Promise.resolve(trx.state.sessions.has(familyId));
      },
      markRotated: (trx: FakeTransaction, rowId: string, replacedById: string, now: Date) => {
        Object.assign(trx.state.sessions.get(rowId) ?? {}, {
          rotated_at: now,
          last_used_at: now,
          replaced_by_id: replacedById,
          updated_at: now,
        });
        return Promise.resolve();
      },
      revokeFamily: (trx: FakeTransaction, familyId: string, reason: string, now: Date) => {
        let count = 0;
        for (const row of trx.state.sessions.values()) {
          if (row.family_id === familyId && row.revoked_at === null) {
            Object.assign(row, { revoked_at: now, revoke_reason: reason, updated_at: now });
            count += 1;
          }
        }
        return Promise.resolve(count);
      },
      revokeAllOfAccount: (trx: FakeTransaction, accountId: string, reason: string, now: Date) => {
        const families = new Set<string>();
        for (const row of trx.state.sessions.values()) {
          if (row.account_id === accountId && row.revoked_at === null) {
            Object.assign(row, { revoked_at: now, revoke_reason: reason, updated_at: now });
            families.add(row.family_id);
          }
        }
        return Promise.resolve(families.size);
      },
    };
  }

  private accountsRepository() {
    const notLockedOut = (row: AccountRow, now: Date): boolean =>
      row.locked_until === null || row.locked_until.getTime() <= now.getTime();
    return {
      // Sign-in reads the committed rows through the pool.
      findForSignIn: (_db: unknown, email: string): Promise<SignInAccount | undefined> => {
        const row = [...this.state.accounts.values()].find(
          (account) => account.email.toLowerCase() === email.toLowerCase(),
        );
        return Promise.resolve(row === undefined ? undefined : { ...row });
      },
      lockedUntil: (trx: FakeTransaction, accountId: string) =>
        Promise.resolve(trx.state.accounts.get(accountId)?.locked_until ?? null),
      recordFailedSignIn: (
        trx: FakeTransaction,
        accountId: string,
        now: Date,
        lockout: { threshold: number; lockedUntil: Date },
      ): Promise<FailedSignIn | undefined> => {
        const row = trx.state.accounts.get(accountId);
        if (row === undefined || !notLockedOut(row, now)) {
          return Promise.resolve(undefined);
        }
        row.failed_login_count += 1;
        const starts = row.failed_login_count >= lockout.threshold;
        if (starts) {
          row.locked_until = lockout.lockedUntil;
        }
        return Promise.resolve({
          failedLoginCount: row.failed_login_count,
          lockedUntil: starts ? lockout.lockedUntil : null,
        });
      },
      recordSignIn: (trx: FakeTransaction, accountId: string, now: Date, options: { signedIn: boolean }) => {
        const row = trx.state.accounts.get(accountId);
        if (row === undefined || !notLockedOut(row, now)) {
          return Promise.resolve(false);
        }
        Object.assign(row, { failed_login_count: 0, locked_until: null });
        if (options.signedIn) {
          row.last_login_at = now;
        }
        return Promise.resolve(true);
      },
      findPortalAccount: (
        trx: FakeTransaction,
        accountId: string,
      ): Promise<PortalAccountRecord | undefined> => {
        const row = trx.state.accounts.get(accountId);
        return Promise.resolve(row === undefined ? undefined : { ...row, memberships: [] });
      },
      lockForSessionChange: (trx: FakeTransaction, accountId: string) => {
        this.locks.push(`account-share:${accountId}`);
        return Promise.resolve(trx.state.accounts.has(accountId));
      },
      lockForUpdate: (trx: FakeTransaction, accountId: string): Promise<AccountIdentity | undefined> => {
        this.locks.push(`account-update:${accountId}`);
        return Promise.resolve(trx.state.accounts.get(accountId));
      },
    };
  }
}

let world: World;
beforeEach(() => {
  world = new World();
});

describe("the session rules", () => {
  const row = {
    audience: "portal",
    rotated_at: null,
    revoked_at: null,
    expires_at: new Date("2026-10-20T09:00:00.000Z"),
    family_expires_at: new Date("2026-11-10T09:00:00.000Z"),
  };
  const now = new Date(START);

  it("gives a refresh token 7 days, never past the end of its family", () => {
    const familyEnd = new Date(now.getTime() + PORTAL_FAMILY_TTL_MS);
    expect(PORTAL_FAMILY_TTL_MS).toBe(30 * DAY_MS);
    expect(PORTAL_REFRESH_TOKEN_TTL_MS).toBe(7 * DAY_MS);
    expect(refreshTokenExpiry(now, familyEnd)).toEqual(new Date(now.getTime() + 7 * DAY_MS));
    expect(refreshTokenExpiry(now, new Date(now.getTime() + DAY_MS))).toEqual(
      new Date(now.getTime() + DAY_MS),
    );
  });

  it("rotates a live token, reports a rotated one as reused, and refuses the rest", () => {
    expect(refreshVerdict(row, now, "portal")).toBe("rotate");
    expect(refreshVerdict({ ...row, rotated_at: now }, now, "portal")).toBe("reused");
    // A rotated token stays a reuse after its family was revoked or has ended.
    expect(refreshVerdict({ ...row, rotated_at: now, revoked_at: now }, now, "portal")).toBe("reused");
    expect(refreshVerdict({ ...row, rotated_at: now, expires_at: now }, now, "portal")).toBe("reused");
    expect(refreshVerdict({ ...row, revoked_at: now }, now, "portal")).toBe("invalid");
    expect(refreshVerdict({ ...row, expires_at: now }, now, "portal")).toBe("invalid");
    expect(refreshVerdict({ ...row, family_expires_at: now }, now, "portal")).toBe("invalid");
    // The admin's families never refresh on the portal surface, rotated or not, and the reverse.
    expect(refreshVerdict({ ...row, audience: "platform_admin" }, now, "portal")).toBe("invalid");
    expect(refreshVerdict({ ...row, audience: "platform_admin", rotated_at: now }, now, "portal")).toBe(
      "invalid",
    );
    expect(refreshVerdict(row, now, "platform_admin")).toBe("invalid");
  });

  it("names the password, and the TOTP code of an MFA family, in amr and mfa_at", () => {
    expect(authMethodsOf(null)).toEqual(["pwd"]);
    expect(authMethodsOf(now)).toEqual(["pwd", "otp"]);
    expect(mfaAtOf(null)).toBeUndefined();
    expect(mfaAtOf(new Date("2026-10-17T09:00:00.900Z"))).toBe(Date.parse(START) / 1000);
  });

  it("lets verified and unverified accounts hold a session, and no other status", () => {
    expect(["active", "pending_verification"].map(maySignIn)).toEqual([true, true]);
    expect(["disabled", "locked", "deleted", "unknown"].map(maySignIn)).toEqual([false, false, false, false]);
  });

  it("maps an account and its memberships to the Account of the document", () => {
    const record: PortalAccountRecord = {
      id: id("acc", 1),
      email: "anna.berg@example.com",
      email_verified_at: null,
      full_name: "Anna Berg",
      locale: "nb",
      time_zone: "Europe/Oslo",
      mfa_enabled: true,
      mfa_enabled_at: new Date("2026-10-03T09:12:44.000Z"),
      is_platform_admin: false,
      status: "pending_verification",
      created_at: new Date("2026-10-01T10:02:17.000Z"),
      version: 3,
      memberships: [
        {
          membership_id: id("stf", 1),
          tenant_id: id("ten", 1),
          tenant_key: "acme",
          tenant_name: "Acme Travel",
          tenant_status: "active",
          role: "owner",
        },
      ],
    };

    expect(toAccount(record, FEATURES)).toEqual({
      id: id("acc", 1),
      email: "anna.berg@example.com",
      emailVerified: false,
      fullName: "Anna Berg",
      locale: "nb",
      timeZone: "Europe/Oslo",
      mfaEnabled: true,
      mfaEnabledAt: "2026-10-03T09:12:44.000Z",
      isPlatformAdmin: false,
      createdAt: "2026-10-01T10:02:17.000Z",
      version: 3,
      memberships: [
        {
          membershipId: id("stf", 1),
          tenantId: id("ten", 1),
          tenantKey: "acme",
          tenantName: "Acme Travel",
          tenantStatus: "active",
          role: "owner",
        },
      ],
      features: FEATURES,
    });
    expect(toAccount({ ...record, mfa_enabled_at: null, memberships: [] }, FEATURES)).toMatchObject({
      mfaEnabledAt: null,
      memberships: [],
    });
  });

  it("answers Retry-After with the whole seconds a lockout has left, at least one", () => {
    const now2 = new Date(START);
    expect(lockoutRetryAfter(new Date(now2.getTime() + SIGN_IN_LOCKOUT_MS), now2)).toBe(900);
    expect(lockoutRetryAfter(new Date(now2.getTime() + 1500), now2)).toBe(2);
    expect(lockoutRetryAfter(now2, now2)).toBe(1);
    expect(MAX_CONSECUTIVE_FAILED_SIGN_INS).toBe(5);
    expect(SIGN_IN_LOCKOUT_MS).toBe(15 * MINUTE_MS);
  });

  it("reads back only well-formed MFA challenges", () => {
    const challenge = { v: 1, audience: "portal", accountId: id("acc", 1), issuedAt: 1, maxAttempts: 5 };
    expect(parseMfaChallenge(JSON.stringify(challenge))).toEqual(challenge);
    expect(MFA_CHALLENGE_MAX_ATTEMPTS).toBe(5);
    expect(MFA_CHALLENGE_TTL_SECONDS).toBe(300);
    for (const broken of [
      null,
      "not json",
      "null",
      JSON.stringify({ ...challenge, v: 2 }),
      JSON.stringify({ ...challenge, audience: "staff" }),
      JSON.stringify({ ...challenge, accountId: "acc_1" }),
      JSON.stringify({ ...challenge, issuedAt: "yesterday" }),
      JSON.stringify({ ...challenge, maxAttempts: 0 }),
    ]) {
      expect(parseMfaChallenge(broken)).toBeUndefined();
    }
  });
});

describe("SessionsService", () => {
  it("[PBE-014 AC1] starts a portal family with a 15-minute access token and a refresh token stored as SHA-256 only [PF-03 AC1]", async () => {
    const account = world.addAccount();
    const now = world.clock.now();

    const session = await world.signedIn(account.id);

    const rows = [...world.state.sessions.values()];
    expect(rows).toHaveLength(1);
    const row = rows[0] as SessionRow;
    expect(row).toMatchObject({
      id: expect.stringMatching(/^asn_[0-9A-HJKMNP-TV-Z]{26}$/) as string,
      account_id: account.id,
      audience: "portal",
      refresh_token_hash: sha256Hex(session.refreshToken),
      user_agent: USER_AGENT,
      ip_address: IP,
      expires_at: new Date(now.getTime() + 7 * DAY_MS),
      family_expires_at: new Date(now.getTime() + 30 * DAY_MS),
      mfa_verified_at: null,
      rotated_at: null,
      revoked_at: null,
    });
    expect(row.family_id).toBe(row.id);
    expect(session.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(rows)).not.toContain(session.refreshToken);
    expect(session.refreshTokenExpiresAt).toBe(new Date(now.getTime() + 7 * DAY_MS).toISOString());
    expect(session.accessTokenExpiresAt).toBe(
      new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    );
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    const claims = await world.tokens.verify(session.accessToken, "portal");
    expect(claims).toMatchObject({ sub: account.id, sid: row.family_id, ev: true, amr: ["pwd"] });
    expect(claims.mfa_at).toBeUndefined();
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect(session.account).toMatchObject({ id: account.id, email: account.email, emailVerified: true });
  });

  it("gives an unverified account a token with ev = false", async () => {
    const account = world.addAccount({ status: "pending_verification", email_verified_at: null });

    const session = await world.signedIn(account.id);

    expect((await world.tokens.verify(session.accessToken, "portal")).ev).toBe(false);
    expect(session.account.emailVerified).toBe(false);
  });

  it("[PBE-014 AC3] rotates on use; reusing a rotated token revokes the family, so its newest token fails too [PF-03 AC3]", async () => {
    const account = world.addAccount();
    const first = await world.signedIn(account.id);
    world.clock.advance(MINUTE_MS);
    const second = await world.sessions.refresh(first.refreshToken);
    world.clock.advance(MINUTE_MS);
    const third = await world.sessions.refresh(second.refreshToken);
    const familyId = (await world.tokens.verify(first.accessToken, "portal")).sid;

    // Each refresh is a new generation of the same family; the presented one is used up.
    expect(new Set([first.refreshToken, second.refreshToken, third.refreshToken]).size).toBe(3);
    expect((await world.tokens.verify(third.accessToken, "portal")).sid).toBe(familyId);
    const rows = world.family(familyId);
    expect(rows.map((row) => row.refresh_token_hash)).toEqual(
      [first, second, third].map((session) => sha256Hex(session.refreshToken)),
    );
    expect(rows[0]).toMatchObject({
      rotated_at: new Date(Date.parse(START) + MINUTE_MS),
      replaced_by_id: rows[1]?.id,
    });
    expect(rows[1]).toMatchObject({ replaced_by_id: rows[2]?.id });
    expect(rows[2]).toMatchObject({
      rotated_at: null,
      revoked_at: null,
      user_agent: USER_AGENT,
      ip_address: IP,
    });

    world.clock.advance(MINUTE_MS);
    const reused = await outcome(world.sessions.refresh(first.refreshToken));
    const newest = await outcome(world.sessions.refresh(third.refreshToken));

    expect(reused).toBe("REFRESH_TOKEN_REUSED");
    expect(newest).toBe("REFRESH_TOKEN_INVALID");
    // The revocation was committed although the refresh answered an error.
    expect(world.family(familyId).map((row) => [row.revoked_at, row.revoke_reason])).toEqual([
      [world.clock.now(), "rotation_reuse"],
      [world.clock.now(), "rotation_reuse"],
      [world.clock.now(), "rotation_reuse"],
    ]);
    expect(world.warnings).toEqual([
      { fields: { accountId: account.id, familyId }, message: "auth.refresh_token_reused" },
    ]);
    // A second reuse is still a reuse.
    expect(await outcome(world.sessions.refresh(second.refreshToken))).toBe("REFRESH_TOKEN_REUSED");
  });

  it("copies mfa_at from the family's TOTP verification into every new access token", async () => {
    const account = world.addAccount({ mfa_enabled: true });
    const verifiedAt = world.clock.now();
    const first = await world.signedIn(account.id, verifiedAt);
    world.clock.advance(20 * MINUTE_MS);

    const refreshed = await world.sessions.refresh(first.refreshToken);

    const claims = await world.tokens.verify(refreshed.accessToken, "portal");
    expect(claims.mfa_at).toBe(Date.parse(START) / 1000);
    expect(claims.amr).toEqual(["pwd", "otp"]);
    expect(world.family(claims.sid).map((row) => row.mfa_verified_at)).toEqual([verifiedAt, verifiedAt]);
  });

  it("never lets a rotated token outlive its family's 30 days, and refuses the family after them", async () => {
    const account = world.addAccount();
    let session = await world.signedIn(account.id);
    const familyEnd = Date.parse(START) + 30 * DAY_MS;
    // Refreshed every 6 days, within the 7-day idle expiry.
    for (let day = 6; day <= 24; day += 6) {
      world.clock.advance(6 * DAY_MS);
      session = await world.sessions.refresh(session.refreshToken);
    }
    world.clock.advance(5 * DAY_MS);
    session = await world.sessions.refresh(session.refreshToken);
    expect(session.refreshTokenExpiresAt).toBe(new Date(familyEnd).toISOString());

    world.clock.set(familyEnd);
    expect(await outcome(world.sessions.refresh(session.refreshToken))).toBe("REFRESH_TOKEN_INVALID");
  });

  it("refuses an idle-expired, revoked, unknown, admin or oversized token, or a disabled account, and changes nothing", async () => {
    const idle = world.addAccount();
    const idleSession = await world.signedIn(idle.id);
    // Seven days later the first token has not been used: it expired. The others are fresh.
    world.clock.advance(7 * DAY_MS);
    const disabled = world.addAccount();
    const disabledSession = await world.signedIn(disabled.id);
    world.state.accounts.set(disabled.id, { ...world.account(disabled.id), status: "disabled" });
    const revoked = world.addAccount();
    const revokedSession = await world.signedIn(revoked.id);
    await world.sessions.signOut(revoked.id, revokedSession.refreshToken);
    const adminToken = world.addAdminFamily(world.addAccount({ is_platform_admin: true }).id);
    const before = copyState(world.state);

    const answers = await Promise.all(
      [
        idleSession.refreshToken,
        disabledSession.refreshToken,
        revokedSession.refreshToken,
        adminToken,
        `rt_${"Z".repeat(43)}`,
        "x".repeat(513),
      ].map((token) => outcome(world.sessions.refresh(token))),
    );

    expect(answers).toEqual(Array.from({ length: 6 }, () => "REFRESH_TOKEN_INVALID"));
    expect(world.state).toEqual(before);
  });

  it("takes the account's lock, then the family's, then the token's", async () => {
    const account = world.addAccount();
    const session = await world.signedIn(account.id);
    const familyId = (await world.tokens.verify(session.accessToken, "portal")).sid;

    await world.sessions.refresh(session.refreshToken);

    expect(world.locks).toEqual([`account-share:${account.id}`, `family:${familyId}`, `row:${familyId}`]);
  });

  it("signs out of the family of the caller's own portal token only", async () => {
    const account = world.addAccount();
    const other = world.addAccount();
    const current = await world.signedIn(account.id);
    const elsewhere = await world.signedIn(account.id);
    const strangers = await world.signedIn(other.id);
    const adminToken = world.addAdminFamily(account.id);

    // Another account's token, an admin token, an unknown and an oversized one change nothing.
    await world.sessions.signOut(account.id, strangers.refreshToken);
    await world.sessions.signOut(account.id, adminToken);
    await world.sessions.signOut(account.id, `rt_${"Q".repeat(43)}`);
    await world.sessions.signOut(account.id, "x".repeat(513));
    expect([...world.state.sessions.values()].filter((row) => row.revoked_at !== null)).toEqual([]);

    await world.sessions.signOut(account.id, current.refreshToken);
    // Signing out again changes nothing more.
    await world.sessions.signOut(account.id, current.refreshToken);

    const currentFamily = (await world.tokens.verify(current.accessToken, "portal")).sid;
    expect(world.family(currentFamily)).toEqual([
      expect.objectContaining({ revoked_at: world.clock.now(), revoke_reason: "logout" }),
    ]);
    expect(await outcome(world.sessions.refresh(current.refreshToken))).toBe("REFRESH_TOKEN_INVALID");
    expect(await outcome(world.sessions.refresh(elsewhere.refreshToken))).toBe("ok");
    expect(await outcome(world.sessions.refresh(strangers.refreshToken))).toBe("ok");
    expect(world.state.audit).toEqual([]);
  });

  it("[PBE-014 AC4] signs out everywhere: staffdeny first with a 30-day TTL, then every family, audited and announced [PF-06 AC2]", async () => {
    const account = world.addAccount();
    const other = world.addAccount();
    const portal = [await world.signedIn(account.id), await world.signedIn(account.id)];
    const adminToken = world.addAdminFamily(account.id);
    const strangers = await world.signedIn(other.id);
    world.clock.advance(MINUTE_MS);
    const cutOff = world.clock.now();

    await world.sessions.signOutEverywhere(account.id);

    // The OTA cut-off went out before any family was revoked.
    expect(world.redisWrites).toEqual([
      {
        key: `staffdeny:acct:${account.id}`,
        value: String(cutOff.getTime()),
        ttl: STAFF_DENY_ACCOUNT_TTL_SECONDS,
        revokedRows: 0,
      },
    ]);
    expect(STAFF_DENY_ACCOUNT_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    const ofAccount = [...world.state.sessions.values()].filter((row) => row.account_id === account.id);
    expect(ofAccount).toHaveLength(3);
    expect(ofAccount.map((row) => [row.audience, row.revoked_at, row.revoke_reason]).sort()).toEqual([
      ["platform_admin", cutOff, "logout"],
      ["portal", cutOff, "logout"],
      ["portal", cutOff, "logout"],
    ]);
    for (const token of [...portal.map((session) => session.refreshToken), adminToken]) {
      expect(await outcome(world.sessions.refresh(token))).toBe("REFRESH_TOKEN_INVALID");
    }
    expect(await outcome(world.sessions.refresh(strangers.refreshToken))).toBe("ok");
    expect(world.locks).toContain(`account-update:${account.id}`);
    expect(world.state.audit).toEqual([
      expect.objectContaining({
        actorType: "account",
        actorAccountId: account.id,
        action: "auth.signed_out_everywhere",
        targetType: "account",
        targetId: account.id,
      }),
    ]);
    expect(JSON.parse(world.state.audit[0]?.detailsJson ?? "{}")).toEqual({
      revokedFamilies: 3,
      staffDenyFrom: cutOff.toISOString(),
    });
    expect(world.published).toEqual([{ v: 1, type: "account", accountId: account.id }]);
  });

  it("revokes nothing when the staffdeny cut-off cannot be written", async () => {
    const account = world.addAccount();
    const session = await world.signedIn(account.id);
    world.redisDown = true;

    await expect(world.sessions.signOutEverywhere(account.id)).rejects.toThrow("Redis is down");

    expect([...world.state.sessions.values()].map((row) => row.revoked_at)).toEqual([null]);
    expect(world.state.audit).toEqual([]);
    expect(world.published).toEqual([]);
    expect(await outcome(world.sessions.refresh(session.refreshToken))).toBe("ok");
  });
});

describe("SignInService", () => {
  beforeEach(async () => {
    await world.signIns.onModuleInit();
    world.verified.length = 0;
  });

  /** Signs in with `email` and `password`; the AppError code, or the result. */
  async function signIn(email: string, password = PASSWORD): Promise<SignInResult | string> {
    try {
      return await world.signIns.signIn({ email, password });
    } catch (error) {
      if (isAppError(error)) {
        return error.code;
      }
      throw error;
    }
  }

  it("[PBE-014 AC1] valid credentials answer a PortalSession, reset the failures and audit auth.sign_in [PF-03 AC1]", async () => {
    const account = world.addAccount({ failed_login_count: 3, email: "Anna.Berg@example.com" });

    const result = await signIn("  anna.berg@EXAMPLE.com ");

    expect(result).toMatchObject({ account: { id: account.id } });
    const session = result as PortalSession;
    const claims = await world.tokens.verify(session.accessToken, "portal");
    expect(claims).toMatchObject({ sub: account.id, amr: ["pwd"], ev: true });
    expect(world.account(account.id)).toMatchObject({
      failed_login_count: 0,
      locked_until: null,
      last_login_at: world.clock.now(),
    });
    expect(world.state.audit).toEqual([
      expect.objectContaining({
        actorAccountId: account.id,
        action: "auth.sign_in",
        targetType: "session",
        targetId: claims.sid,
      }),
    ]);
    expect(world.verified).toEqual([account.password_hash]);
  });

  it("[PBE-014 AC2] a wrong address and a wrong password give the same 401 after one password verification each [PF-03 AC2]", async () => {
    const account = world.addAccount();

    const unknown = await rejectionOf(
      world.signIns.signIn({ email: "nobody@example.com", password: PASSWORD }),
    );
    const wrong = await rejectionOf(
      world.signIns.signIn({ email: account.email, password: "Wrong-Password-2026" }),
    );

    for (const error of [unknown, wrong]) {
      expect(isAppError(error) && { code: error.code, status: error.status, message: error.message }).toEqual(
        {
          code: "INVALID_CREDENTIALS",
          status: 401,
          message: (unknown as Error).message,
        },
      );
    }
    // One verification each: the unknown address against the dummy hash, made like a real one when the module started.
    expect(world.verified).toHaveLength(2);
    expect(world.verified[0]).toMatch(/^fake\$[0-9a-f]{64}$/);
    expect(world.verified[0]).not.toBe(account.password_hash);
    expect(world.verified[1]).toBe(account.password_hash);
    expect(world.account(account.id).failed_login_count).toBe(1);
    expect(world.state.audit).toEqual([
      expect.objectContaining({ action: "auth.sign_in_failed", targetId: account.id }),
    ]);
  });

  it("[PBE-014 AC2] the fifth consecutive failure locks for 15 minutes with Retry-After; the lockout is checked before the password [PF-03 AC2]", async () => {
    const account = world.addAccount();
    const answers: Array<SignInResult | string> = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      answers.push(await signIn(account.email, `Wrong-Password-${attempt}`));
    }
    const fifth = await rejectionOf(
      world.signIns.signIn({ email: account.email, password: "Wrong-Password-5" }),
    );
    const lockedAt = world.clock.now();

    expect(answers).toEqual([
      "INVALID_CREDENTIALS",
      "INVALID_CREDENTIALS",
      "INVALID_CREDENTIALS",
      "INVALID_CREDENTIALS",
    ]);
    expect(fifth).toBeInstanceOf(AccountLockedError);
    expect(fifth).toMatchObject({ code: "ACCOUNT_LOCKED", status: 423, retryAfterSeconds: 900 });
    expect(world.account(account.id)).toMatchObject({
      failed_login_count: 5,
      locked_until: new Date(lockedAt.getTime() + 15 * MINUTE_MS),
    });
    expect(world.state.audit.map((row) => row.action)).toEqual([
      "auth.sign_in_failed",
      "auth.sign_in_failed",
      "auth.sign_in_failed",
      "auth.sign_in_failed",
      "auth.sign_in_failed",
      "auth.locked",
    ]);

    // While locked, even the right password is refused before it is verified, with the seconds left.
    world.verified.length = 0;
    world.clock.advance(10 * MINUTE_MS);
    const locked = await rejectionOf(world.signIns.signIn({ email: account.email, password: PASSWORD }));
    expect(locked).toMatchObject({ code: "ACCOUNT_LOCKED", retryAfterSeconds: 300 });
    expect(world.verified).toEqual([]);

    // After the 15 minutes, one more failure locks again at once; the right password works after that lockout.
    world.clock.advance(5 * MINUTE_MS);
    const again = await rejectionOf(
      world.signIns.signIn({ email: account.email, password: "Wrong-Password-6" }),
    );
    expect(again).toMatchObject({ code: "ACCOUNT_LOCKED", retryAfterSeconds: 900 });
    world.clock.advance(15 * MINUTE_MS);
    expect(await signIn(account.email)).toMatchObject({ account: { id: account.id } });
    expect(world.account(account.id)).toMatchObject({ failed_login_count: 0, locked_until: null });
  });

  it("answers ACCOUNT_DISABLED only after a correct password, and INVALID_CREDENTIALS for an erased account", async () => {
    const disabled = world.addAccount({ status: "disabled" });
    const erased = world.addAccount({ status: "deleted", deleted_at: new Date("2026-10-10T00:00:00.000Z") });
    const withoutPassword = world.addAccount({ password_hash: null });

    expect(await signIn(disabled.email, "Wrong-Password-2026")).toBe("INVALID_CREDENTIALS");
    expect(await signIn(disabled.email)).toBe("ACCOUNT_DISABLED");
    expect(await signIn(erased.email)).toBe("INVALID_CREDENTIALS");
    expect(await signIn(withoutPassword.email)).toBe("INVALID_CREDENTIALS");

    expect(world.state.sessions.size).toBe(0);
    expect(world.account(disabled.id).failed_login_count).toBe(1);
    expect(world.account(erased.id).failed_login_count).toBe(0);
    expect(world.state.audit.map((row) => [row.action, JSON.parse(row.detailsJson) as unknown])).toEqual([
      ["auth.sign_in_failed", { reason: "invalid_password", failedLoginCount: 1 }],
      ["auth.sign_in_failed", { reason: "account_disabled", status: "disabled" }],
      ["auth.sign_in_failed", { reason: "invalid_password", failedLoginCount: 1 }],
    ]);
    // Every attempt cost one verification, the erased account and the one without a password against the dummy hash.
    expect(world.verified).toHaveLength(4);
  });

  it("[PBE-014 AC2] a lockout that a concurrent failure starts during the verification wins: 423, nothing counted, started or challenged [PF-03 AC2]", async () => {
    const right = world.addAccount();
    const wrong = world.addAccount();
    const withMfa = world.addAccount({ mfa_enabled: true });
    const lockedUntil = new Date(world.clock.now().getTime() + 10 * MINUTE_MS);
    // Each sign-in reads its account unlocked; another request locks it before the password check has finished.
    const lockDuringVerification = (accountId: string) => () => {
      world.state.accounts.set(accountId, {
        ...world.account(accountId),
        failed_login_count: MAX_CONSECUTIVE_FAILED_SIGN_INS,
        locked_until: lockedUntil,
      });
    };

    world.duringVerification = lockDuringVerification(right.id);
    const rightPassword = await rejectionOf(world.signIns.signIn({ email: right.email, password: PASSWORD }));
    world.duringVerification = lockDuringVerification(wrong.id);
    const wrongPassword = await rejectionOf(
      world.signIns.signIn({ email: wrong.email, password: "Wrong-Password-2026" }),
    );
    world.duringVerification = lockDuringVerification(withMfa.id);
    const mfaPassword = await rejectionOf(world.signIns.signIn({ email: withMfa.email, password: PASSWORD }));

    for (const error of [rightPassword, wrongPassword, mfaPassword]) {
      expect(error).toBeInstanceOf(AccountLockedError);
      expect(error).toMatchObject({ code: "ACCOUNT_LOCKED", retryAfterSeconds: 600 });
    }
    for (const account of [right, wrong, withMfa]) {
      expect(world.account(account.id)).toMatchObject({
        failed_login_count: MAX_CONSECUTIVE_FAILED_SIGN_INS,
        locked_until: lockedUntil,
        last_login_at: null,
      });
    }
    expect(world.state.sessions.size).toBe(0);
    expect(world.challenges).toEqual([]);
    expect(world.state.audit).toEqual([]);
  });

  it("answers an MFA challenge for an account with MFA, without a session or last_login_at", async () => {
    const account = world.addAccount({ mfa_enabled: true, failed_login_count: 2 });

    const result = await signIn(account.email);

    expect(result).toEqual({
      mfaRequired: true,
      mfaChallengeToken: `mfa_${"C".repeat(43)}`,
      expiresIn: 300,
    });
    expect(world.challenges).toEqual([{ accountId: account.id, audience: "portal" }]);
    expect(world.state.sessions.size).toBe(0);
    expect(world.account(account.id)).toMatchObject({ failed_login_count: 0, last_login_at: null });
    expect(world.state.audit).toEqual([]);
  });

  it("lets an unverified account sign in with ev = false", async () => {
    const account = world.addAccount({ status: "pending_verification", email_verified_at: null });

    const result = (await signIn(account.email)) as PortalSession;

    expect((await world.tokens.verify(result.accessToken, "portal")).ev).toBe(false);
  });
});
