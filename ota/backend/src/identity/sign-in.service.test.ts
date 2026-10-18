// Customer sign-in and its lockout (OBE-033 step 1; ADR-0008 "Lockout", flows/my-bookings-and-guest-lookup.md §3
// step 3 and §4), without a database or Redis: SignInService over in-memory repositories and an in-memory lockout with
// the counter semantics of lockout.ts; SignInLockout over a recording Redis client (its keys and arguments; the Lua
// scripts run against Redis in test/integration/identity/sign-in.int.test.ts); the pure lockout rules; the idempotency
// hook that keeps the password out of the request hash; and the answers' mapping. Every password, address and token
// here is made up on the spot; no value is a secret.
import { createHash, randomBytes } from "node:crypto";
import { isAppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../common/clock";
import {
  hashMaterialOf,
  UnhashableIdempotentInputError,
  type IdempotentInput,
} from "../common/http/idempotency.service";
import type { TenantContext } from "../tenancy/tenant-context";
import type { TenantTx } from "../tenancy/tenant-tx";
import type { CustomerRecord, CustomersRepository, PasswordIdentity } from "./customers.repository";
import { toAuthSessionInfo, toAuthSessionResult, toCustomer } from "./customers.mapper";
import {
  AccountLockedError,
  emailDigest,
  lockoutState,
  MAX_SIGN_IN_FAILURES,
  normaliseEmail,
  SIGN_IN_LOCKOUT_SECONDS,
  SignInLockout,
  type LockoutAttempt,
  type LockoutRedis,
  type LockoutState,
} from "./lockout";
import type { SessionDetails, SessionsService, SessionTokens, StartSessionInput } from "./sessions.service";
import { hashCustomerPassword, SignInIdempotencyHooks, SignInService } from "./sign-in.service";

const TENANT_ID = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1A";
const OTHER_TENANT_ID = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1B";
const CUSTOMER_ID = "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1C";
const IDENTITY_ID = "cid_01JA2Z9W5K7Q3M8N4P6R2T0V1D";
const SESSION_ID = "ses_01JA2Z9W5K7Q3M8N4P6R2T0V1S";
const NOW = new Date("2026-10-18T09:00:00.000Z");
const ADDRESS = "Anna.Berg@Example.com";

/** A password made up for this run. */
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
const WRONG = `${PASSWORD}-wrong`;

/** The Argon2id hash of PASSWORD, made once (below). */
let passwordHash = "";

// Two Argon2id hashes with the OWASP parameters (19 MiB each): tens of milliseconds alone, more on a busy runner; made
// once here, with their own budget, so no test pays for them.
beforeAll(async () => {
  passwordHash = await hashCustomerPassword(PASSWORD);
}, 30_000);

/** The AppError of a rejected promise as `<status> <code>` and its details. */
async function refusal(promise: Promise<unknown>): Promise<{ answer: string; details: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) {
      return { answer: `${error.status} ${error.code}`, details: error.details };
    }
    throw error;
  }
  throw new Error("the promise resolved");
}

/** The lockout of lockout.ts in memory: the same counter rules (one atomic step per attempt), without Redis. */
class MemoryLockout {
  readonly failures = new Map<string, number>();
  readonly checked: string[] = [];
  readonly cleared: string[] = [];

  takeAttempt(email: string): Promise<LockoutAttempt> {
    this.checked.push(email);
    const counted = this.failures.get(email) ?? 0;
    if (counted >= MAX_SIGN_IN_FAILURES) {
      return Promise.resolve({ taken: false, state: this.state(email) });
    }
    this.failures.set(email, counted + 1);
    return Promise.resolve({ taken: true, state: this.state(email) });
  }

  clear(email: string): Promise<void> {
    this.cleared.push(email);
    this.failures.delete(email);
    return Promise.resolve();
  }

  private state(email: string): LockoutState {
    const failures = this.failures.get(email) ?? 0;
    return lockoutState(failures, failures > 0 ? SIGN_IN_LOCKOUT_SECONDS * 1000 : -2);
  }
}

interface Harness {
  readonly service: SignInService;
  readonly lockout: MemoryLockout;
  readonly identities: Map<string, PasswordIdentity>;
  readonly started: StartSessionInput[];
  readonly signIns: unknown[][];
  readonly logs: [string, Record<string, unknown>, string][];
  accountsEnabled: boolean;
}

const customerRow = (overrides: Partial<CustomerRecord> = {}): CustomerRecord => ({
  id: CUSTOMER_ID,
  email: normaliseEmail(ADDRESS),
  email_verified_at: new Date("2026-10-10T08:20:41.000Z"),
  pending_email: null,
  first_name: "Anna",
  last_name: "Berg",
  date_of_birth: "1988-04-17",
  phone_country_code: "44",
  phone_number: "7700900123",
  status: "active",
  marketing_consent: true,
  marketing_consent_updated_at: new Date("2026-10-10T08:12:00.000Z"),
  marketing_consent_source: "sign_up",
  terms_accepted_version: "2026-09-01",
  last_sign_in_at: NOW,
  deleted_at: null,
  created_at: new Date("2026-10-10T08:12:00.000Z"),
  updated_at: new Date("2026-10-10T08:20:41.000Z"),
  version: 2,
  ...overrides,
});

const details: SessionDetails = {
  sessionId: SESSION_ID,
  createdAt: NOW,
  lastUsedAt: NOW,
  refreshTokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * 3_600_000),
  rememberMe: true,
  authMethod: "password",
  userAgent: "Mozilla/5.0 (test)",
  ipCountry: null,
};

function harness(): Harness {
  const identities = new Map<string, PasswordIdentity>();
  const started: StartSessionInput[] = [];
  const signIns: unknown[][] = [];
  const logs: [string, Record<string, unknown>, string][] = [];
  const state = { accountsEnabled: true };
  const customers = {
    customerAccountsEnabled: () => Promise.resolve(state.accountsEnabled),
    findPasswordIdentity: (_trx: unknown, email: string) => Promise.resolve(identities.get(email)),
    recordSignIn: (...args: unknown[]) => {
      signIns.push(args.slice(1));
      return Promise.resolve();
    },
  } as unknown as CustomersRepository;
  const sessions = {
    start: (_trx: unknown, input: StartSessionInput) => {
      started.push(input);
      return Promise.resolve({
        customerId: input.customerId,
        sessionId: SESSION_ID,
        rememberMe: input.rememberMe,
        refreshToken: `rt_${randomBytes(32).toString("base64url")}`,
        refreshTokenExpiresAt: details.refreshTokenExpiresAt,
      });
    },
    view: () => Promise.resolve({ customer: customerRow(), details }),
    tokensFor: (issued: Omit<SessionTokens, "accessToken" | "accessTokenExpiresAt">) =>
      Promise.resolve({
        ...issued,
        accessToken: `at.${randomBytes(12).toString("base64url")}`,
        accessTokenExpiresAt: new Date(NOW.getTime() + 900_000),
      }),
  } as unknown as SessionsService;
  const tx = { run: (fn: (trx: unknown) => Promise<unknown>) => fn({}) } as unknown as TenantTx;
  const clock = { now: () => new Date(NOW) } as unknown as Clock;
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => logs.push(["info", fields, message]),
    warn: (fields: Record<string, unknown>, message: string) => logs.push(["warn", fields, message]),
  } as unknown as PinoLogger;
  const lockout = new MemoryLockout();
  const service = new SignInService(
    customers,
    sessions,
    lockout as unknown as SignInLockout,
    tx,
    clock,
    logger,
  );
  return {
    service,
    lockout,
    identities,
    started,
    signIns,
    logs,
    get accountsEnabled() {
      return state.accountsEnabled;
    },
    set accountsEnabled(value: boolean) {
      state.accountsEnabled = value;
    },
  };
}

const identity = (overrides: Partial<PasswordIdentity> = {}): PasswordIdentity => ({
  identityId: IDENTITY_ID,
  customerId: CUSTOMER_ID,
  passwordHash,
  customerStatus: "active",
  customerDeletedAt: null,
  ...overrides,
});

describe("lockoutState", () => {
  it("counts down the attempts and locks from the fifth failure while the counter lives", () => {
    expect(lockoutState(0, -2)).toEqual({
      failures: 0,
      locked: false,
      remainingAttempts: 5,
      retryAfterSeconds: 0,
    });
    expect(lockoutState(4, 61_500)).toEqual({
      failures: 4,
      locked: false,
      remainingAttempts: 1,
      retryAfterSeconds: 62,
    });
    expect(lockoutState(MAX_SIGN_IN_FAILURES, 900_000)).toEqual({
      failures: 5,
      locked: true,
      remainingAttempts: 0,
      retryAfterSeconds: 900,
    });
    // A counter about to end still waits a second; a counter without a lifetime locks nothing.
    expect(lockoutState(7, 20).retryAfterSeconds).toBe(1);
    expect(lockoutState(5, -1).locked).toBe(false);
  });

  it("answers 423 with lockedUntil from now and the Retry-After seconds", () => {
    const error = new AccountLockedError(900, NOW);

    expect([error.status, error.code, error.retryAfterSeconds]).toEqual([423, "ACCOUNT_LOCKED", 900]);
    expect(error.details).toEqual({ lockedUntil: "2026-10-18T09:15:00.000Z" });
  });
});

describe("SignInLockout", () => {
  const tenant = (tenantId: string, environment: "test" | "live") =>
    ({ require: () => ({ tenantId, environment }) }) as unknown as TenantContext;

  it("keys the counter by tenant, environment and the SHA-256 of the normalised address, never the address", async () => {
    const calls: unknown[][] = [];
    const replies: unknown[] = [
      [1, 900_000, 1],
      [5, 61_500, 0],
    ];
    const redis = {
      eval: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(replies.shift());
      },
      del: (...args: unknown[]) => {
        calls.push(["del", ...args]);
        return Promise.resolve(1);
      },
    } as unknown as LockoutRedis;
    const digest = createHash("sha256").update("anna.berg@example.com").digest("hex");

    const first = await new SignInLockout(redis, tenant(TENANT_ID, "test")).takeAttempt(ADDRESS);
    const refused = await new SignInLockout(redis, tenant(TENANT_ID, "live")).takeAttempt(
      ` ${ADDRESS.toUpperCase()} `,
    );
    await new SignInLockout(redis, tenant(OTHER_TENANT_ID, "test")).clear(ADDRESS);

    expect(emailDigest(ADDRESS)).toBe(digest);
    expect(calls.map((call) => call.slice(1))).toEqual([
      [1, `t:${TENANT_ID}:test:authfail:${digest}`, "900000", "5"],
      [1, `t:${TENANT_ID}:live:authfail:${digest}`, "900000", "5"],
      [`t:${OTHER_TENANT_ID}:test:authfail:${digest}`],
    ]);
    expect(first).toEqual({ taken: true, state: lockoutState(1, 900_000) });
    expect(refused).toEqual({ taken: false, state: lockoutState(5, 61_500) });
    expect(JSON.stringify(calls).toLowerCase()).not.toContain("anna.berg");
  });

  it("refuses the sign-in with 503 when Redis cannot answer, rather than skip the lockout", async () => {
    const redis = {
      eval: () => Promise.reject(new Error("connection lost")),
      del: () => Promise.reject(new Error("connection lost")),
    } as unknown as LockoutRedis;
    const lockout = new SignInLockout(redis, tenant(TENANT_ID, "test"));

    expect((await refusal(lockout.takeAttempt(ADDRESS))).answer).toBe("503 SERVICE_UNAVAILABLE");
    expect((await refusal(lockout.clear(ADDRESS))).answer).toBe("503 SERVICE_UNAVAILABLE");
    for (const reply of ["OK", [1, 900_000], [1, 900_000, 2]]) {
      const odd = new SignInLockout(
        { eval: () => Promise.resolve(reply), del: () => Promise.resolve(0) } as unknown as LockoutRedis,
        tenant(TENANT_ID, "test"),
      );
      expect((await refusal(odd.takeAttempt(ADDRESS))).answer).toBe("503 SERVICE_UNAVAILABLE");
    }
  });
});

describe("SignInService", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
    h.identities.set(normaliseEmail(ADDRESS), identity());
  });

  it("locks the address at the fifth wrong password; the sixth attempt answers 423 even with the right one [OBE-033 AC1]", async () => {
    const answers: string[] = [];
    const remaining: unknown[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const { answer, details: errorDetails } = await refusal(
        h.service.signIn({ email: ADDRESS, password: WRONG }),
      );
      answers.push(answer);
      remaining.push(errorDetails);
    }
    const fifth = await refusal(h.service.signIn({ email: ADDRESS, password: WRONG }));
    const sixth = h.service.signIn({ email: ADDRESS, password: PASSWORD });
    let sixthError: unknown;
    try {
      await sixth;
    } catch (error) {
      sixthError = error;
    }

    expect(answers).toEqual(Array.from({ length: 4 }, () => "401 INVALID_CREDENTIALS"));
    expect(remaining).toEqual([4, 3, 2, 1].map((left) => ({ remainingAttempts: left })));
    expect(fifth).toEqual({
      answer: "423 ACCOUNT_LOCKED",
      details: { lockedUntil: "2026-10-18T09:15:00.000Z" },
    });
    expect(sixthError).toBeInstanceOf(AccountLockedError);
    expect((sixthError as AccountLockedError).retryAfterSeconds).toBe(SIGN_IN_LOCKOUT_SECONDS);
    // The locked attempt counted nothing more and opened no session.
    expect(h.lockout.failures.get(normaliseEmail(ADDRESS))).toBe(5);
    expect(h.started).toEqual([]);
  });

  it("counts each attempt before its password is verified, so a burst gets five verifications at most", async () => {
    // Seven wrong guesses and the right password, all at once: a check of the counter before the verification and a
    // count after it would let all eight through while the counter is still empty, the right one included.
    const burst = await Promise.all(
      [...Array.from({ length: 7 }, () => WRONG), PASSWORD].map((password) =>
        refusal(h.service.signIn({ email: ADDRESS, password })),
      ),
    );

    expect(burst.map((outcome) => outcome.answer)).toEqual([
      ...Array.from({ length: 4 }, () => "401 INVALID_CREDENTIALS"),
      ...Array.from({ length: 4 }, () => "423 ACCOUNT_LOCKED"),
    ]);
    expect(h.lockout.failures.get(normaliseEmail(ADDRESS))).toBe(MAX_SIGN_IN_FAILURES);
    // Five passwords were verified (each logs its failure); the sixth to eighth were refused before.
    expect(h.logs.filter(([, , message]) => message === "customer.sign_in_failed")).toHaveLength(5);
    expect([h.started, h.lockout.cleared]).toEqual([[], []]);
  });

  it("answers an unknown address, a wrong password and a disabled or deleted customer alike, counting each", async () => {
    h.identities.set("disabled@example.com", identity({ customerStatus: "disabled" }));
    h.identities.set("deleted@example.com", identity({ customerStatus: "active", customerDeletedAt: NOW }));

    const outcomes = [
      await refusal(h.service.signIn({ email: "nobody@example.com", password: PASSWORD })),
      await refusal(h.service.signIn({ email: ADDRESS, password: WRONG })),
      await refusal(h.service.signIn({ email: "disabled@example.com", password: PASSWORD })),
      await refusal(h.service.signIn({ email: "deleted@example.com", password: PASSWORD })),
    ];

    for (const outcome of outcomes) {
      expect(outcome).toEqual({ answer: "401 INVALID_CREDENTIALS", details: { remainingAttempts: 4 } });
    }
    expect([...h.lockout.failures.values()]).toEqual([1, 1, 1, 1]);
    expect(
      h.logs.filter(([, , message]) => message === "customer.sign_in_failed").map(([, f]) => f["reason"]),
    ).toEqual(["unknown_address", "wrong_password", "customer_blocked", "customer_blocked"]);
    expect(h.started).toEqual([]);
  });

  it("opens a session for the right password: lockout cleared, rememberMe true by default, sign-in recorded", async () => {
    await refusal(h.service.signIn({ email: ADDRESS, password: WRONG }));

    const opened = await h.service.signIn({
      email: ` ${ADDRESS.toUpperCase()} `,
      password: PASSWORD,
      userAgent: "Mozilla/5.0 (test)",
    });
    const short = await h.service.signIn({ email: ADDRESS, password: PASSWORD, rememberMe: false });

    expect(opened.tokens.customerId).toBe(CUSTOMER_ID);
    expect(opened.tokens.refreshToken).toMatch(/^rt_/);
    expect(opened.customer.id).toBe(CUSTOMER_ID);
    expect(h.started).toEqual([
      { customerId: CUSTOMER_ID, identityId: IDENTITY_ID, rememberMe: true, userAgent: "Mozilla/5.0 (test)" },
      { customerId: CUSTOMER_ID, identityId: IDENTITY_ID, rememberMe: false, userAgent: undefined },
    ]);
    expect(short.tokens.rememberMe).toBe(false);
    expect(h.signIns).toEqual([
      [CUSTOMER_ID, IDENTITY_ID, NOW],
      [CUSTOMER_ID, IDENTITY_ID, NOW],
    ]);
    expect(h.lockout.cleared).toEqual(["anna.berg@example.com", "anna.berg@example.com"]);
    expect(h.lockout.failures.size).toBe(0);
    // A pending verification does not stop a sign-in: this OTA asks for a verified address before checkout only.
    h.identities.set("pending@example.com", identity({ customerStatus: "pending_verification" }));
    expect(
      (await h.service.signIn({ email: "pending@example.com", password: PASSWORD })).tokens.customerId,
    ).toBe(CUSTOMER_ID);
  });

  it("answers 403 FEATURE_DISABLED when customer accounts are off, before the lockout or the password", async () => {
    h.accountsEnabled = false;

    expect(await refusal(h.service.signIn({ email: ADDRESS, password: PASSWORD }))).toEqual({
      answer: "403 FEATURE_DISABLED",
      details: { feature: "customerAccounts" },
    });
    expect([h.lockout.checked, h.started]).toEqual([[], []]);
  });

  it("never matches a stored hash Argon2 cannot read, and never logs the hash, the address or the password", async () => {
    h.identities.set(normaliseEmail(ADDRESS), identity({ passwordHash: "not-a-phc-string" }));

    expect((await refusal(h.service.signIn({ email: ADDRESS, password: PASSWORD }))).answer).toBe(
      "401 INVALID_CREDENTIALS",
    );
    expect(h.logs.map(([level, fields, message]) => [level, message, fields["identityId"]])).toEqual([
      ["warn", "customer.password_hash_unreadable", IDENTITY_ID],
      ["info", "customer.sign_in_failed", undefined],
    ]);
    await h.service.signIn({ email: "nobody@example.com", password: PASSWORD }).catch(() => undefined);
    const text = JSON.stringify(h.logs).toLowerCase();
    for (const secret of [PASSWORD.toLowerCase(), "anna.berg", "not-a-phc-string", "nobody@"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("SignInIdempotencyHooks", () => {
  it("keeps the password out of the idempotency request hash and normalises the address", () => {
    const hooks = new SignInIdempotencyHooks();
    const input: IdempotentInput = {
      path: {},
      query: {},
      body: { email: ` ${ADDRESS} `, password: PASSWORD, rememberMe: false },
    };

    expect(() => hashMaterialOf("signIn", input)).toThrow(UnhashableIdempotentInputError);
    const material = hooks.hashInput(input);
    expect(material).toEqual({
      path: {},
      query: {},
      body: { email: "anna.berg@example.com", rememberMe: false },
    });
    expect(hashMaterialOf("signIn", material)).toEqual(material);
    expect(JSON.stringify(material)).not.toContain(PASSWORD);
  });
});

describe("the answers", () => {
  const tokens: SessionTokens = {
    customerId: CUSTOMER_ID,
    sessionId: SESSION_ID,
    rememberMe: true,
    refreshToken: `rt_${randomBytes(32).toString("base64url")}`,
    refreshTokenExpiresAt: details.refreshTokenExpiresAt,
    accessToken: `at.${randomBytes(12).toString("base64url")}`,
    accessTokenExpiresAt: new Date(NOW.getTime() + 900_000),
  };

  it("give key callers the tokens and the edge only the session's metadata", () => {
    const result = toAuthSessionResult(tokens, customerRow());
    const info = toAuthSessionInfo(customerRow(), details, tokens.accessTokenExpiresAt);

    expect(result.session).toEqual({
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: "2026-10-18T09:15:00.000Z",
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: "2026-11-17T09:00:00.000Z",
      tokenType: "Bearer",
      subject: { type: "customer", id: CUSTOMER_ID },
    });
    expect(info.session).toEqual({
      id: SESSION_ID,
      createdAt: "2026-10-18T09:00:00.000Z",
      lastUsedAt: "2026-10-18T09:00:00.000Z",
      accessTokenExpiresAt: "2026-10-18T09:15:00.000Z",
      refreshTokenExpiresAt: "2026-11-17T09:00:00.000Z",
      rememberMe: true,
      authMethod: "password",
      userAgent: "Mozilla/5.0 (test)",
      ipCountry: null,
    });
    const text = JSON.stringify(info);
    expect(text).not.toContain(tokens.accessToken);
    expect(text).not.toContain(tokens.refreshToken);
  });

  it("show the customer as the contract's Customer", () => {
    expect(toCustomer(customerRow())).toEqual({
      id: CUSTOMER_ID,
      email: "anna.berg@example.com",
      emailVerified: true,
      emailVerifiedAt: "2026-10-10T08:20:41.000Z",
      pendingEmail: null,
      firstName: "Anna",
      lastName: "Berg",
      phone: { countryCallingCode: "44", number: "7700900123" },
      dateOfBirth: "1988-04-17",
      status: "active",
      marketingConsent: { granted: true, updatedAt: "2026-10-10T08:12:00.000Z", source: "sign_up" },
      termsAcceptedVersion: "2026-09-01",
      lastSignInAt: "2026-10-18T09:00:00.000Z",
      createdAt: "2026-10-10T08:12:00.000Z",
      updatedAt: "2026-10-10T08:20:41.000Z",
      version: 2,
    });
    const bare = toCustomer(
      customerRow({
        email_verified_at: null,
        first_name: null,
        last_name: null,
        phone_number: null,
        marketing_consent_updated_at: null,
        marketing_consent_source: null,
      }),
    );
    expect([bare.emailVerified, bare.firstName, bare.phone, bare.marketingConsent]).toEqual([
      false,
      "",
      null,
      { granted: true, updatedAt: "2026-10-10T08:12:00.000Z", source: "sign_up" },
    ]);
    expect(() => toCustomer(customerRow({ status: "frozen" }))).toThrow(TypeError);
  });
});
