// Staff sign-in, refresh, sign-out and me (OBE-059; OADR-0011 points 1–3 and 5, PADR-0007), without a database or
// Redis: the pure rules of staff-sessions.ts (portal token values, refresh tokens, cut-offs, family and membership
// checks, the cached membership), the role matrix of scope §1.3, StaffTokens over the test process's key file and a
// FakeClock, StaffSessions over an in-memory Redis (its keys, TTLs and arguments; the Lua scripts of the rotation run
// against Redis in test/integration/console/staff-auth.int.test.ts), and StaffAuthService over in-memory sessions,
// caches and a recording transaction. Every id and token here is made up on the spot; no value is a secret.
import { createHash, randomBytes } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { sha256Hex } from "@velexis/crypto";
import { isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it } from "vitest";
import { testApiCredentials } from "../../../test/helpers/api-env";
import type { Clock } from "../../common/clock";
import { hashMaterialOf, type IdempotentInput } from "../../common/http/idempotency.service";
import { IdGenerator } from "../../common/ids";
import type { ApiConfig } from "../../config";
import type { PlatformCache } from "../../tenancy/platform-cache";
import type {
  PlatformAmadeusConnection,
  PlatformReadRepository,
  PlatformStaffMember,
  StaffRole,
} from "../../tenancy/platform-read.repository";
import type { PlatformTenant } from "../../tenancy/platform-read.types";
import type { RequestTenant, TenantContext } from "../../tenancy/tenant-context";
import type { TenantTx } from "../../tenancy/tenant-tx";
import { TokenService } from "../token.service";
import {
  ConsoleSignInIdempotencyHooks,
  environmentsOf,
  permissionsOf,
  ROLE_PERMISSIONS,
  StaffAuthService,
  toConsoleTenant,
  type StaffSessionPrincipal,
} from "./staff-auth.service";
import {
  cutOffOf,
  familyProblem,
  membershipProblem,
  newRefreshToken,
  NO_REVOCATIONS,
  parseFamily,
  parsePortalToken,
  parseRefreshToken,
  parseStaffMember,
  STAFF_FAMILY_LIFETIME_MS,
  StaffSessions,
  StaffTokens,
  type IssuedStaffFamily,
  type PortalTokenGrant,
  type RotationOutcome,
  type StaffFamily,
  type StaffSessionsRedis,
  type StaffSessionState,
} from "./staff-sessions";

const TENANT_ID = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1A";
const OTHER_TENANT_ID = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1B";
const ACCOUNT_ID = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1C";
const STAFF_ID = "stf_01JA2Z9W5K7Q3M8N4P6R2T0V1D";
const OTHER_STAFF_ID = "stf_01JA2Z9W5K7Q3M8N4P6R2T0V1E";
const FAMILY_ID = "asn_01JA2Z9W5K7Q3M8N4P6R2T0V1F";
const START = "2026-10-18T09:00:00.000Z";
const NOW = new Date(START);

/** The permissions of each role as ota/docs/scope.md §1.3 lists them. */
const SCOPE_MATRIX: Readonly<Record<StaffRole, readonly string[]>> = {
  owner: [
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "amadeus:write",
    "settings:read",
    "settings:write",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ],
  admin: [
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "amadeus:write",
    "settings:read",
    "settings:write",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ],
  agent: [
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "settings:read",
    "payments:read",
    "payments:capture",
  ],
  finance: [
    "bookings:read",
    "customers:read",
    "supplier_requests:read",
    "settings:read",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ],
  viewer: ["bookings:read", "customers:read", "settings:read", "payments:read"],
};

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

/** A made-up portal token of the platform's shape. */
const portalToken = (): string => `ptk_${randomBytes(40).toString("hex").slice(0, 43)}`;

const member = (overrides: Partial<PlatformStaffMember> = {}): PlatformStaffMember => ({
  id: STAFF_ID,
  tenantId: TENANT_ID,
  accountId: ACCOUNT_ID,
  role: "agent",
  status: "active",
  lastActiveAt: null,
  createdAt: "2026-03-02T10:00:00.000Z",
  account: {
    email: "maria.lopez@example.com",
    fullName: "Maria Lopez",
    locale: "en-GB",
    timeZone: "Europe/Madrid",
    mfaEnabled: true,
    status: "active",
    deletedAt: null,
  },
  tenantTimeZone: "Europe/Paris",
  ...overrides,
});

const family = (overrides: Partial<StaffFamily> = {}): StaffFamily => ({
  id: FAMILY_ID,
  staffId: STAFF_ID,
  accountId: ACCOUNT_ID,
  tenantId: TENANT_ID,
  role: "agent",
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + STAFF_FAMILY_LIFETIME_MS),
  userAgent: "Mozilla/5.0 (test)",
  ...overrides,
});

const tenantRow = (overrides: Partial<PlatformTenant> = {}): PlatformTenant =>
  ({
    id: TENANT_ID,
    key: "alpha",
    name: "Alpha Travel",
    status: "active",
    schemaName: "tenant_alpha",
    storefrontEnvironment: "test",
    defaultCurrency: "EUR",
    defaultLocale: "en",
    billingNotice: null,
    ...overrides,
  }) as PlatformTenant;

const configWith = (path: string) => ({ get: () => path }) as unknown as ConfigService<ApiConfig, true>;
const staffTokensAt = (clock: FakeClock): StaffTokens =>
  new StaffTokens(configWith(testApiCredentials().jwtKeyFile), clock as unknown as Clock);

/** A logger that records each line's message and fields. */
function recordingLogger(): { logger: PinoLogger; lines: Array<{ msg: string; fields: unknown }> } {
  const lines: Array<{ msg: string; fields: unknown }> = [];
  const record = (fields: unknown, msg: string) => lines.push({ msg, fields });
  return { logger: { info: record, warn: record } as unknown as PinoLogger, lines };
}

describe("portal tokens, refresh tokens and cut-offs", () => {
  it("reads the platform's portal token value and nothing else", () => {
    const value = {
      v: 1,
      accountId: ACCOUNT_ID,
      tenantId: TENANT_ID,
      membershipId: STAFF_ID,
      role: "agent",
      mfa: true,
      issuedAt: START,
      requestId: "req_1",
    };

    expect(parsePortalToken(JSON.stringify(value))).toEqual({
      accountId: ACCOUNT_ID,
      tenantId: TENANT_ID,
      membershipId: STAFF_ID,
      role: "agent",
      mfa: true,
      issuedAt: START,
      requestId: "req_1",
    });
    expect(parsePortalToken(JSON.stringify({ ...value, requestId: undefined }))?.requestId).toBeNull();
    for (const broken of [
      { ...value, v: 2 },
      { ...value, accountId: "acc_1" },
      { ...value, tenantId: STAFF_ID },
      { ...value, membershipId: ACCOUNT_ID },
      { ...value, role: "superuser" },
      { ...value, mfa: "yes" },
      { ...value, issuedAt: "yesterday" },
    ]) {
      expect(parsePortalToken(JSON.stringify(broken))).toBeUndefined();
    }
    expect(parsePortalToken("not json")).toBeUndefined();
    expect(parsePortalToken(null)).toBeUndefined();
  });

  it("names the family in the refresh token and keeps only its SHA-256", () => {
    const { token, hash } = newRefreshToken(FAMILY_ID);

    expect(token).toMatch(/^srt_01JA2Z9W5K7Q3M8N4P6R2T0V1F[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(parseRefreshToken(token)).toEqual({ familyId: FAMILY_ID, hash });
    expect(newRefreshToken(FAMILY_ID).token).not.toBe(token);
    expect(parseRefreshToken(`rt_${randomBytes(32).toString("base64url")}`)).toBeUndefined();
    expect(parseRefreshToken(`${token}x`)).toBeUndefined();
    expect(() => newRefreshToken(STAFF_ID)).toThrow(/familyId must be an asn_ id/);
  });

  it("reads cut-offs as epoch milliseconds; one that is not a number refuses every family", () => {
    expect(cutOffOf(null)).toBeUndefined();
    expect(cutOffOf("1760778000000")).toBe(1760778000000);
    for (const unreadable of ["", "soon", "-5", "1.5"]) {
      expect([unreadable, cutOffOf(unreadable)]).toEqual([unreadable, Number.POSITIVE_INFINITY]);
    }
  });
});

describe("the revocation checks", () => {
  const state = (
    overrides: Partial<StaffSessionState["revocations"]> = {},
    f = family(),
  ): StaffSessionState => ({
    family: f,
    revocations: { ...NO_REVOCATIONS, ...overrides },
  });
  const created = NOW.getTime();

  it("refuses a family under a cut-off of its account, tenant or membership made after it [OBE-059 AC2]", () => {
    const later = new Date(created + 60_000);
    const cases: Array<[string, StaffSessionState, string | undefined]> = [
      ["live", state(), undefined],
      ["missing", { family: undefined, revocations: NO_REVOCATIONS }, "missing"],
      ["other tenant", state({}, family({ tenantId: OTHER_TENANT_ID })), "other_tenant"],
      ["denied", state({ familyDenied: true }), "denied"],
      ["account cut-off newer", state({ accountCutOff: created + 1 }), "account_cut_off"],
      ["account cut-off at creation", state({ accountCutOff: created }), "account_cut_off"],
      ["account cut-off older", state({ accountCutOff: created - 1 }), undefined],
      ["tenant cut-off newer", state({ tenantCutOff: created + 1 }), "tenant_cut_off"],
      ["tenant cut-off older", state({ tenantCutOff: created - 1 }), undefined],
      ["member cut-off newer", state({ memberCutOff: created + 1 }), "member_cut_off"],
      ["unreadable cut-off", state({ accountCutOff: Number.POSITIVE_INFINITY }), "account_cut_off"],
    ];
    for (const [name, value, expected] of cases) {
      expect([name, familyProblem(value, TENANT_ID, later)]).toEqual([name, expected]);
    }
    const end = new Date(created + STAFF_FAMILY_LIFETIME_MS);
    expect(familyProblem(state(), TENANT_ID, end)).toBe("expired");
    expect(familyProblem(state(), TENANT_ID, new Date(end.getTime() - 1))).toBeUndefined();
  });

  it("needs an active membership of an active account with the family's role", () => {
    const f = family();
    expect(membershipProblem(member(), f)).toBeUndefined();
    const inactive: Array<[string, PlatformStaffMember | null]> = [
      ["gone", null],
      ["another membership", member({ id: OTHER_STAFF_ID })],
      ["suspended", member({ status: "suspended" })],
      ["removed", member({ status: "removed" })],
      ["account disabled", member({ account: { ...member().account, status: "disabled" } })],
      ["account locked", member({ account: { ...member().account, status: "locked" } })],
      ["account erased", member({ account: { ...member().account, deletedAt: START } })],
      ["another tenant", member({ tenantId: OTHER_TENANT_ID })],
    ];
    for (const [name, value] of inactive) {
      expect([name, membershipProblem(value, f)]).toEqual([name, "inactive"]);
    }
    expect(membershipProblem(member({ role: "viewer" }), f)).toBe("role_changed");
  });

  it("caches the membership as JSON and refuses a cached value of another shape", () => {
    const value = member({ lastActiveAt: START });

    expect(parseStaffMember(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(parseStaffMember({ ...value, role: "root" })).toBeUndefined();
    expect(parseStaffMember({ ...value, account: { ...value.account, status: "gone" } })).toBeUndefined();
    expect(parseStaffMember({ ...value, account: undefined })).toBeUndefined();
    expect(parseStaffMember("member")).toBeUndefined();
  });
});

describe("permissions and environments", () => {
  it("gives each of the five roles the permissions of scope §1.3 [OBE-059 AC3]", () => {
    for (const role of ["owner", "admin", "agent", "finance", "viewer"] as const) {
      expect([role, [...permissionsOf(role)].sort()]).toEqual([role, [...SCOPE_MATRIX[role]].sort()]);
      expect(new Set(permissionsOf(role)).size).toBe(permissionsOf(role).length);
    }
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(["admin", "agent", "finance", "owner", "viewer"]);
    // settings:write and amadeus:write are owner and admin only (OADR-0011 point 6, the contract).
    for (const role of ["agent", "finance", "viewer"] as const) {
      expect(permissionsOf(role)).not.toContain("settings:write");
      expect(permissionsOf(role)).not.toContain("amadeus:write");
    }
  });

  it("offers live to the non-viewer roles of a live tenant only (OADR-0011 point 5)", () => {
    expect(environmentsOf("agent", "live")).toEqual(["test", "live"]);
    expect(environmentsOf("finance", "live")).toEqual(["test", "live"]);
    expect(environmentsOf("viewer", "live")).toEqual(["test"]);
    expect(environmentsOf("owner", "test")).toEqual(["test"]);
  });

  it("shows the connection's offices, never anything else of it", () => {
    const connection = {
      id: "sc_01JA2Z9W5K7Q3M8N4P6R2T0V1G",
      tenantId: TENANT_ID,
      environment: "test",
      credentialSource: "velexis",
      amadeusAccountId: "ama_01JA2Z9W5K7Q3M8N4P6R2T0V1H",
      baseUrl: null,
      clientId: null,
      clientSecretCiphertext: null,
      officeIds: ["NCE1A0950", "bad"],
      defaultOfficeId: "NCE1A0950",
      queuingOfficeId: "NCE1A0950",
      ownerOfficeId: "NCE1A0950",
      status: "active",
    } satisfies PlatformAmadeusConnection;

    expect(toConsoleTenant(tenantRow(), "Europe/Paris", "test", connection).supplier).toEqual({
      connected: true,
      officeIds: ["NCE1A0950"],
      defaultOfficeId: "NCE1A0950",
      queuingOfficeId: "NCE1A0950",
    });
    expect(toConsoleTenant(tenantRow(), "UTC", "live", { ...connection, status: "disabled" })).toMatchObject({
      environment: "live",
      timeZone: "UTC",
      supplier: { connected: false },
    });
    expect(toConsoleTenant(tenantRow(), "UTC", "test", null).supplier).toEqual({
      connected: false,
      officeIds: [],
      defaultOfficeId: null,
      queuingOfficeId: null,
    });
  });

  it("leaves the password and TOTP code of a password grant out of the idempotency request hash", () => {
    const hooks = new ConsoleSignInIdempotencyHooks();
    const input = (body: unknown): IdempotentInput => ({ path: {}, query: {}, body });
    const password = `pw-${randomBytes(6).toString("hex")}`;

    const passwordGrant = hooks.hashInput(
      input({ grantType: "password", email: "a@example.com", password, mfaCode: "123456" }),
    );
    const tokenGrant = hooks.hashInput(input({ grantType: "portal_token", portalToken: "ptk_abc" }));

    expect(JSON.stringify(passwordGrant)).not.toContain(password);
    expect(JSON.stringify(passwordGrant)).not.toContain("123456");
    expect(() => hashMaterialOf("consoleSignIn", passwordGrant)).not.toThrow();
    expect(tokenGrant).toEqual({
      path: {},
      query: {},
      body: { grantType: "portal_token", portalToken: "ptk_abc" },
    });
  });
});

describe("StaffTokens", () => {
  const input = { sub: STAFF_ID, tid: TENANT_ID, sid: FAMILY_ID, role: "finance" as const };

  it("signs a 15-minute staff token that verifies for its tenant only", async () => {
    const clock = new FakeClock(START);
    const tokens = staffTokensAt(clock);
    const { token, expiresAt } = await tokens.sign(input);

    const verdict = await tokens.verify(token, TENANT_ID);
    expect(verdict).toEqual({
      ok: true,
      claims: {
        typ: "staff",
        sub: STAFF_ID,
        tid: TENANT_ID,
        sid: FAMILY_ID,
        role: "finance",
        iat: NOW.getTime() / 1000,
        exp: NOW.getTime() / 1000 + 900,
      },
    });
    expect(expiresAt.toISOString()).toBe("2026-10-18T09:15:00.000Z");
    expect(await tokens.verify(token, OTHER_TENANT_ID)).toEqual({ ok: false, reason: "other_tenant" });
    clock.advance(15 * 60_000 + 31_000);
    expect(await tokens.verify(token, TENANT_ID)).toEqual({ ok: false, reason: "expired" });
    expect(await tokens.verify(token, OTHER_TENANT_ID)).toEqual({ ok: false, reason: "other_tenant" });
  });

  it("never takes a customer token for a staff token, nor a tampered or malformed one", async () => {
    const clock = new FakeClock(START);
    const tokens = staffTokensAt(clock);
    const customers = new TokenService(
      configWith(testApiCredentials().jwtKeyFile),
      clock as unknown as Clock,
    );
    const customer = await customers.signCustomerToken({
      sub: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
      tid: TENANT_ID,
      sid: "ses_01JA2Z9W5K7Q3M8N4P6R2T0V1S",
    });
    const { token } = await tokens.sign(input);
    const [header = "", payload = "", signature = ""] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), roles: ["owner"] }),
    ).toString("base64url");

    expect(await tokens.verify(customer.token, TENANT_ID)).toEqual({ ok: false, reason: "claims" });
    expect((await customers.verifyCustomerToken(token, TENANT_ID)).ok).toBe(false);
    expect(await tokens.verify(`${header}.${forged}.${signature}`, TENANT_ID)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await tokens.verify("not-a-jwt", TENANT_ID)).toEqual({ ok: false, reason: "malformed" });
    expect(await tokens.verify(undefined, TENANT_ID)).toEqual({ ok: false, reason: "missing" });
    await expect(tokens.sign({ ...input, sid: "ses_01JA2Z9W5K7Q3M8N4P6R2T0V1S" })).rejects.toThrow(
      /sid must be an asn_ id/,
    );
  });
});

/** An in-memory Redis with the commands StaffSessions sends (no Lua: `eval` answers what the test queues). */
class MemoryRedis {
  readonly values = new Map<string, { value: string; ttl: number | undefined }>();
  readonly calls: unknown[][] = [];
  readonly evalReplies: unknown[] = [];
  failing = false;

  private check(call: unknown[]): void {
    this.calls.push(call);
    if (this.failing) {
      throw new Error("connection is closed");
    }
  }

  getdel(key: string): Promise<string | null> {
    this.check(["getdel", key]);
    const entry = this.values.get(key);
    this.values.delete(key);
    return Promise.resolve(entry?.value ?? null);
  }

  set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null> {
    this.check(["set", key, value, ...args]);
    if (args.includes("NX") && this.values.has(key)) {
      return Promise.resolve(null);
    }
    const ex = args.indexOf("EX");
    this.values.set(key, { value, ttl: ex === -1 ? undefined : Number(args[ex + 1]) });
    return Promise.resolve("OK");
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    this.check(["mget", ...keys]);
    return Promise.resolve(keys.map((key) => this.values.get(key)?.value ?? null));
  }

  eval(...args: unknown[]): Promise<unknown> {
    this.check(["eval", ...args.slice(1)]);
    return Promise.resolve(this.evalReplies.shift());
  }

  multi(commands: string[][]): { exec(): Promise<Array<[Error | null, unknown]>> } {
    return {
      exec: () => {
        this.check(["multi", ...commands]);
        for (const [name, key = "", value = "", , ttl] of commands) {
          if (name === "del") {
            this.values.delete(key);
          } else if (name === "set") {
            this.values.set(key, { value, ttl: Number(ttl) });
          }
        }
        return Promise.resolve(commands.map((): [Error | null, unknown] => [null, "OK"]));
      },
    };
  }
}

interface SessionsHarness {
  readonly sessions: StaffSessions;
  readonly redis: MemoryRedis;
  readonly clock: FakeClock;
  readonly members: Map<string, PlatformStaffMember | null>;
  readonly lines: Array<{ msg: string; fields: unknown }>;
}

function sessionsHarness(): SessionsHarness {
  const redis = new MemoryRedis();
  const clock = new FakeClock(START);
  const members = new Map<string, PlatformStaffMember | null>([[`${ACCOUNT_ID}:${TENANT_ID}`, member()]]);
  const cache = {
    membership: (accountId: string, tenantId: string) =>
      Promise.resolve(members.get(`${accountId}:${tenantId}`) ?? null),
  } as unknown as PlatformCache;
  const platform = {
    staffMember: (accountId: string, tenantId: string) =>
      Promise.resolve(members.get(`${accountId}:${tenantId}`) ?? null),
  } as unknown as PlatformReadRepository;
  const { logger, lines } = recordingLogger();
  const sessions = new StaffSessions(
    redis as unknown as StaffSessionsRedis,
    cache,
    platform,
    new IdGenerator(clock as unknown as Clock),
    clock as unknown as Clock,
    logger,
  );
  return { sessions, redis, clock, members, lines };
}

describe("StaffSessions", () => {
  it("takes a portal token once, by the SHA-256 of the token [OBE-059 AC1]", async () => {
    const { sessions, redis, lines } = sessionsHarness();
    const token = portalToken();
    const key = `ptk:${sha256Hex(token)}`;
    const grant = {
      v: 1,
      accountId: ACCOUNT_ID,
      tenantId: TENANT_ID,
      membershipId: STAFF_ID,
      role: "agent",
      mfa: false,
      issuedAt: START,
      requestId: null,
    };
    await redis.set(key, JSON.stringify(grant), "EX", 60, "NX");
    await redis.set(`ptk:${sha256Hex(`${token}x`)}`, "{garbage", "EX", 60, "NX");

    expect(await sessions.redeemPortalToken(token)).toMatchObject({
      accountId: ACCOUNT_ID,
      membershipId: STAFF_ID,
    });
    expect(await sessions.redeemPortalToken(token)).toBeUndefined();
    expect(await sessions.redeemPortalToken(`${token}x`)).toBeUndefined();
    expect(await sessions.redeemPortalToken("ptk_short")).toBeUndefined();
    expect(redis.calls.filter(([name]) => name === "getdel")).toEqual([
      ["getdel", key],
      ["getdel", key],
      ["getdel", `ptk:${sha256Hex(`${token}x`)}`],
    ]);
    expect(lines.map((line) => line.msg)).toEqual(["staff.portal_token_refused"]);
    expect(JSON.stringify(lines)).not.toContain(token);
  });

  it("opens a 12-hour family with the hash of its first refresh token, never the token", async () => {
    const { sessions, redis } = sessionsHarness();

    const issued = await sessions.open(member({ role: "finance" }), "Mozilla/5.0 (test)");

    const key = `staffsess:${issued.family.id}`;
    const stored = redis.values.get(key);
    expect(issued.family).toMatchObject({
      staffId: STAFF_ID,
      accountId: ACCOUNT_ID,
      tenantId: TENANT_ID,
      role: "finance",
    });
    expect(issued.family.expiresAt.getTime() - issued.family.createdAt.getTime()).toBe(12 * 3600 * 1000);
    expect(redis.calls[0]).toEqual(["set", key, stored?.value, "EX", 43200, "NX"]);
    expect(stored?.value).toContain(sha256Hex(issued.refreshToken));
    expect(stored?.value).not.toContain(issued.refreshToken);
    expect(parseFamily(stored?.value ?? null)).toEqual(issued.family);
    expect(parseRefreshToken(issued.refreshToken)?.familyId).toBe(issued.family.id);
  });

  it("reads the family, its deny key and the three cut-offs, and accepts a live session", async () => {
    const { sessions, redis } = sessionsHarness();
    const { family: opened } = await sessions.open(member(), null);
    redis.calls.length = 0;
    const claims = {
      typ: "staff" as const,
      sub: STAFF_ID,
      tid: TENANT_ID,
      sid: opened.id,
      role: "agent" as const,
      iat: 0,
      exp: 0,
    };

    const accepted = await sessions.authenticate(claims, TENANT_ID);

    expect(accepted.member).toEqual(member());
    expect(redis.calls).toEqual([
      ["mget", `staffsess:${opened.id}`, `staffdeny:${opened.id}`, `staffdeny:tenant:${TENANT_ID}`],
      ["mget", `staffdeny:acct:${ACCOUNT_ID}`, `staffdeny:member:${STAFF_ID}`],
    ]);
  });

  it("refuses a revoked family, a token of another member or role, and an inactive or changed membership", async () => {
    const { sessions, redis, clock, members } = sessionsHarness();
    const { family: opened } = await sessions.open(member(), null);
    const claims = {
      typ: "staff" as const,
      sub: STAFF_ID,
      tid: TENANT_ID,
      sid: opened.id,
      role: "agent" as const,
      iat: 0,
      exp: 0,
    };
    clock.advance(1000);

    expect((await refusal(sessions.authenticate({ ...claims, sub: OTHER_STAFF_ID }, TENANT_ID))).answer).toBe(
      "401 UNAUTHENTICATED",
    );
    expect((await refusal(sessions.authenticate({ ...claims, role: "owner" }, TENANT_ID))).answer).toBe(
      "401 UNAUTHENTICATED",
    );
    members.set(`${ACCOUNT_ID}:${TENANT_ID}`, member({ role: "viewer" }));
    expect((await refusal(sessions.authenticate(claims, TENANT_ID))).answer).toBe("401 UNAUTHENTICATED");
    members.set(`${ACCOUNT_ID}:${TENANT_ID}`, member({ status: "removed" }));
    expect((await refusal(sessions.authenticate(claims, TENANT_ID))).answer).toBe(
      "403 STAFF_MEMBERSHIP_INACTIVE",
    );
    members.set(`${ACCOUNT_ID}:${TENANT_ID}`, member());
    await redis.set(`staffdeny:acct:${ACCOUNT_ID}`, String(opened.createdAt.getTime() + 1), "EX", 60);
    expect((await refusal(sessions.authenticate(claims, TENANT_ID))).answer).toBe("401 UNAUTHENTICATED");
    redis.values.delete(`staffdeny:acct:${ACCOUNT_ID}`);
    await sessions.revoke(opened.id);
    expect(redis.values.get(`staffdeny:${opened.id}`)).toEqual({ value: "1", ttl: 43200 });
    expect((await refusal(sessions.authenticate(claims, TENANT_ID))).answer).toBe("401 UNAUTHENTICATED");
  });

  it("reads the account's cut-off for the sign-in; one that is not a number refuses every token", async () => {
    const { sessions, redis, lines } = sessionsHarness();
    const key = `staffdeny:acct:${ACCOUNT_ID}`;

    const none = await sessions.accountCutOff(ACCOUNT_ID);
    await redis.set(key, String(NOW.getTime()), "EX", 60);
    const written = await sessions.accountCutOff(ACCOUNT_ID);
    await redis.set(key, "soon", "EX", 60);
    const unreadable = await sessions.accountCutOff(ACCOUNT_ID);

    expect([none, written, unreadable]).toEqual([undefined, NOW.getTime(), Number.POSITIVE_INFINITY]);
    expect(redis.calls.filter(([name]) => name === "mget")).toEqual([
      ["mget", key],
      ["mget", key],
      ["mget", key],
    ]);
    expect(lines).toEqual([{ msg: "staff.cut_off_unreadable", fields: { kind: "account" } }]);
  });

  it("writes the membership cut-off with the time of the sign-out, for as long as a family lives", async () => {
    const { sessions, redis } = sessionsHarness();

    await sessions.revokeMember(STAFF_ID);

    expect(redis.values.get(`staffdeny:member:${STAFF_ID}`)).toEqual({
      value: String(NOW.getTime()),
      ttl: 43200,
    });
  });

  it("maps the rotation script's answers, and answers 503 when Redis does not", async () => {
    const { sessions, redis } = sessionsHarness();
    const hash = sha256Hex("srt_x");
    redis.evalReplies.push("rotated", "reused", "invalid", "garbage");

    const rotated = await sessions.rotate(FAMILY_ID, hash);
    expect(rotated.outcome).toBe("rotated");
    expect(parseRefreshToken((rotated as { refreshToken: string }).refreshToken)?.familyId).toBe(FAMILY_ID);
    const [call] = redis.calls;
    expect(call?.slice(1, 5)).toEqual([2, `staffsess:${FAMILY_ID}`, `staffdeny:${FAMILY_ID}`, hash]);
    expect(call?.slice(6)).toEqual(["100", "43200"]);
    expect((await sessions.rotate(FAMILY_ID, hash)).outcome).toBe("reused");
    expect((await sessions.rotate(FAMILY_ID, hash)).outcome).toBe("invalid");
    expect((await refusal(sessions.rotate(FAMILY_ID, hash))).answer).toBe("503 SERVICE_UNAVAILABLE");
    redis.failing = true;
    expect((await refusal(sessions.redeemPortalToken(portalToken()))).answer).toBe("503 SERVICE_UNAVAILABLE");
    expect((await refusal(sessions.state(FAMILY_ID, TENANT_ID))).answer).toBe("503 SERVICE_UNAVAILABLE");
  });
});

/** StaffSessions in memory for the service: what the service asks of it, and what it did. */
class FakeSessions {
  grant: PortalTokenGrant | undefined;
  freshMemberValue: PlatformStaffMember | null = member();
  memberValue: PlatformStaffMember | null = member();
  stateValue: StaffSessionState = { family: family(), revocations: NO_REVOCATIONS };
  rotation: RotationOutcome = { outcome: "rotated", refreshToken: newRefreshToken(FAMILY_ID).token };
  issued: "current" | "rotated" | "none" = "current";
  accountCutOffValue: number | undefined = undefined;
  readonly revoked: string[] = [];
  readonly revokedMembers: string[] = [];
  readonly opened: IssuedStaffFamily[] = [];

  redeemPortalToken(): Promise<PortalTokenGrant | undefined> {
    const grant = this.grant;
    this.grant = undefined;
    return Promise.resolve(grant);
  }

  accountCutOff(): Promise<number | undefined> {
    return Promise.resolve(this.accountCutOffValue);
  }

  freshMember(): Promise<PlatformStaffMember | null> {
    return Promise.resolve(this.freshMemberValue);
  }

  member(): Promise<PlatformStaffMember | null> {
    return Promise.resolve(this.memberValue);
  }

  open(m: PlatformStaffMember, userAgent: string | null): Promise<IssuedStaffFamily> {
    const issued = {
      family: family({ role: m.role, userAgent }),
      refreshToken: newRefreshToken(FAMILY_ID).token,
    };
    this.opened.push(issued);
    return Promise.resolve(issued);
  }

  state(): Promise<StaffSessionState> {
    return Promise.resolve(this.stateValue);
  }

  rotate(): Promise<RotationOutcome> {
    return Promise.resolve(this.rotation);
  }

  issuedByFamily(): Promise<"current" | "rotated" | "none"> {
    return Promise.resolve(this.issued);
  }

  revoke(familyId: string): Promise<void> {
    this.revoked.push(familyId);
    return Promise.resolve();
  }

  revokeMember(staffId: string): Promise<void> {
    this.revokedMembers.push(staffId);
    return Promise.resolve();
  }
}

interface ServiceHarness {
  readonly service: StaffAuthService;
  readonly sessions: FakeSessions;
  readonly rows: unknown[];
  readonly tenant: { value: PlatformTenant | null };
  readonly audit: { failing: boolean };
  readonly lines: Array<{ msg: string; fields: unknown }>;
}

function serviceHarness(): ServiceHarness {
  const clock = new FakeClock(new Date(NOW.getTime() + 60_000));
  const sessions = new FakeSessions();
  const rows: unknown[] = [];
  const tenant = { value: tenantRow() as PlatformTenant | null };
  const audit = { failing: false };
  const context = {
    require: () =>
      ({
        tenantId: TENANT_ID,
        environment: "test",
        requestId: "req-staff-1",
        key: "alpha",
      }) as unknown as RequestTenant,
  } as unknown as TenantContext;
  const trx = {
    insertInto: (table: string) => ({
      values: (row: unknown) => ({
        execute: () => {
          if (audit.failing) {
            return Promise.reject(new Error("connection lost"));
          }
          rows.push({ table, row });
          return Promise.resolve([]);
        },
      }),
    }),
  };
  const tx = { run: (fn: (t: unknown) => Promise<unknown>) => fn(trx) } as unknown as TenantTx;
  const cache = {
    tenantById: () => Promise.resolve(tenant.value),
    connection: () => Promise.resolve(null),
  } as unknown as PlatformCache;
  const platform = { tenantById: () => Promise.resolve(tenant.value) } as unknown as PlatformReadRepository;
  const { logger, lines } = recordingLogger();
  const service = new StaffAuthService(
    sessions as unknown as StaffSessions,
    staffTokensAt(clock),
    context,
    cache,
    platform,
    tx,
    new IdGenerator(clock as unknown as Clock),
    clock as unknown as Clock,
    logger,
  );
  return { service, sessions, rows, tenant, audit, lines };
}

const grantFor = (overrides: Partial<PortalTokenGrant> = {}): PortalTokenGrant => ({
  accountId: ACCOUNT_ID,
  tenantId: TENANT_ID,
  membershipId: STAFF_ID,
  role: "agent",
  mfa: true,
  issuedAt: START,
  requestId: null,
  ...overrides,
});

const signInInput = (token = portalToken()) => ({
  body: { grantType: "portal_token" as const, portalToken: token },
  userAgent: "Mozilla/5.0 (test)",
  ip: "203.0.113.7",
});

describe("StaffAuthService", () => {
  it("answers the password grant with 403 FEATURE_DISABLED before anything else", async () => {
    const { service, sessions } = serviceHarness();
    sessions.grant = grantFor();

    const refused = await refusal(
      service.signIn({
        body: { grantType: "password", email: "a@example.com", password: "irrelevant" },
        userAgent: null,
        ip: null,
      }),
    );

    expect(refused).toEqual({ answer: "403 FEATURE_DISABLED", details: { feature: "passwordGrant" } });
    expect(sessions.grant).toBeDefined();
  });

  it("refuses an unknown token, a token of another tenant, an inactive membership and a suspended tenant", async () => {
    const { service, sessions, tenant, lines } = serviceHarness();
    const token = portalToken();

    expect((await refusal(service.signIn(signInInput(token)))).answer).toBe("401 PORTAL_TOKEN_INVALID");
    sessions.grant = grantFor({ tenantId: OTHER_TENANT_ID });
    expect((await refusal(service.signIn(signInInput(token)))).answer).toBe("401 PORTAL_TOKEN_INVALID");
    sessions.grant = grantFor({ membershipId: OTHER_STAFF_ID });
    expect((await refusal(service.signIn(signInInput(token)))).answer).toBe("403 STAFF_MEMBERSHIP_INACTIVE");
    sessions.grant = grantFor();
    sessions.freshMemberValue = member({ status: "suspended" });
    expect((await refusal(service.signIn(signInInput(token)))).answer).toBe("403 STAFF_MEMBERSHIP_INACTIVE");
    sessions.grant = grantFor();
    sessions.freshMemberValue = member();
    tenant.value = tenantRow({ status: "suspended" });
    expect((await refusal(service.signIn(signInInput(token)))).answer).toBe("403 TENANT_SUSPENDED");
    expect(sessions.opened).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(token);
  });

  it("refuses a portal token issued at or before the account's staffdeny:acct cut-off", async () => {
    const { service, sessions, lines } = serviceHarness();
    const issuedAt = Date.parse(START);
    const token = portalToken();

    // The platform's "sign out everywhere" after the token was issued, at the same millisecond, and unreadable.
    for (const cutOff of [issuedAt + 1, issuedAt, Number.POSITIVE_INFINITY]) {
      sessions.grant = grantFor();
      sessions.accountCutOffValue = cutOff;
      expect([cutOff, (await refusal(service.signIn(signInInput(token)))).answer]).toEqual([
        cutOff,
        "401 PORTAL_TOKEN_INVALID",
      ]);
    }
    expect(sessions.opened).toEqual([]);
    expect(lines.map((line) => (line.fields as { reason?: unknown }).reason)).toEqual([
      "account_cut_off",
      "account_cut_off",
      "account_cut_off",
    ]);
    // A cut-off from before the token leaves it alone.
    sessions.grant = grantFor();
    sessions.accountCutOffValue = issuedAt - 1;
    expect((await service.signIn(signInInput(token))).session.subject.id).toBe(STAFF_ID);
    expect(JSON.stringify(lines)).not.toContain(token);
  });

  it("opens a session with the membership's current role and writes the staff.sign_in row", async () => {
    const { service, sessions, rows } = serviceHarness();
    sessions.grant = grantFor({ role: "viewer" });
    sessions.freshMemberValue = member({ role: "finance" });
    const token = portalToken();

    const answer = await service.signIn(signInInput(token));

    expect(answer.session.subject).toEqual({ type: "staff", id: STAFF_ID, roles: ["finance"] });
    expect(answer.session.tokenType).toBe("Bearer");
    expect(answer.permissions).toEqual(permissionsOf("finance"));
    expect(answer.environments).toEqual(["test"]);
    expect(answer.staff).toMatchObject({ id: STAFF_ID, email: "maria.lopez@example.com", role: "finance" });
    expect(answer.tenant).toMatchObject({
      id: TENANT_ID,
      timeZone: "Europe/Paris",
      supplier: { connected: false },
    });
    expect(rows).toEqual([
      {
        table: "staff_actions",
        row: expect.objectContaining({
          actor_type: "staff",
          actor_id: STAFF_ID,
          staff_id: STAFF_ID,
          staff_role: "finance",
          action: "staff.sign_in",
          target_type: "staff_session",
          target_id: FAMILY_ID,
          outcome: "succeeded",
          request_id: "req-staff-1",
          ip_address: "203.0.113.7",
          user_agent: "Mozilla/5.0 (test)",
        }),
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(answer.session.refreshToken);
  });

  it("ends the new session again when the audit row cannot be written", async () => {
    const { service, sessions, audit } = serviceHarness();
    sessions.grant = grantFor();
    audit.failing = true;

    await expect(service.signIn(signInInput())).rejects.toThrow("connection lost");
    expect(sessions.revoked).toEqual([FAMILY_ID]);
  });

  it("rotates a live family, and refuses reuse, revoked families and inactive members", async () => {
    const { service, sessions } = serviceHarness();
    const presented = newRefreshToken(FAMILY_ID).token;

    const rotated = await service.refresh(presented);
    expect(rotated.session.refreshToken).not.toBe(presented);
    expect(rotated.session.subject.id).toBe(STAFF_ID);

    sessions.rotation = { outcome: "reused" };
    expect((await refusal(service.refresh(presented))).answer).toBe("401 REFRESH_TOKEN_REUSED");
    sessions.rotation = { outcome: "invalid" };
    expect((await refusal(service.refresh(presented))).answer).toBe("401 REFRESH_TOKEN_INVALID");
    expect((await refusal(service.refresh(`rt_${randomBytes(32).toString("base64url")}`))).answer).toBe(
      "401 REFRESH_TOKEN_INVALID",
    );
    expect(sessions.revoked).toEqual([]);

    sessions.rotation = { outcome: "rotated", refreshToken: newRefreshToken(FAMILY_ID).token };
    sessions.stateValue = {
      family: family(),
      revocations: { ...NO_REVOCATIONS, accountCutOff: NOW.getTime() + 1 },
    };
    expect((await refusal(service.refresh(presented))).answer).toBe("401 REFRESH_TOKEN_INVALID");
    sessions.stateValue = { family: family(), revocations: NO_REVOCATIONS };
    sessions.memberValue = member({ status: "removed" });
    expect((await refusal(service.refresh(presented))).answer).toBe("403 STAFF_MEMBERSHIP_INACTIVE");
    sessions.memberValue = member({ role: "owner" });
    expect((await refusal(service.refresh(presented))).answer).toBe("401 REFRESH_TOKEN_INVALID");
    expect(sessions.revoked).toEqual([FAMILY_ID, FAMILY_ID, FAMILY_ID]);
  });

  it("signs out the access token's session, or the family of a refresh token it issued", async () => {
    const { service, sessions } = serviceHarness();
    const principal: StaffSessionPrincipal = { family: family(), member: member() };
    const token = newRefreshToken(FAMILY_ID).token;

    await service.signOut({ scope: "current", principal, refreshToken: undefined });
    sessions.issued = "rotated";
    await service.signOut({ scope: "current", principal: undefined, refreshToken: token });
    sessions.issued = "none";
    await service.signOut({ scope: "current", principal: undefined, refreshToken: token });
    await service.signOut({ scope: "current", principal: undefined, refreshToken: "srt_garbage" });

    expect(sessions.revoked).toEqual([FAMILY_ID, FAMILY_ID]);
    expect(sessions.revokedMembers).toEqual([]);
    expect(
      (await refusal(service.signOut({ scope: "current", principal: undefined, refreshToken: undefined })))
        .answer,
    ).toBe("401 UNAUTHENTICATED");
  });

  it("signs out everywhere in the tenant with the access token or the current refresh token only", async () => {
    const { service, sessions } = serviceHarness();
    const token = newRefreshToken(FAMILY_ID).token;

    await service.signOut({
      scope: "all",
      principal: { family: family(), member: member() },
      refreshToken: undefined,
    });
    sessions.issued = "current";
    await service.signOut({ scope: "all", principal: undefined, refreshToken: token });
    sessions.issued = "rotated";
    const rotated = await refusal(
      service.signOut({ scope: "all", principal: undefined, refreshToken: token }),
    );

    expect(rotated.answer).toBe("401 UNAUTHENTICATED");
    expect(sessions.revokedMembers).toEqual([STAFF_ID, STAFF_ID]);
    expect(sessions.revoked).toEqual([FAMILY_ID, FAMILY_ID]);
  });

  it("signs an already-ended session out again with its access token alone, but never everywhere", async () => {
    const { service, sessions } = serviceHarness();
    const endedSession = { familyId: FAMILY_ID, staffId: STAFF_ID };

    await service.signOut({ scope: "current", principal: undefined, refreshToken: undefined, endedSession });
    const all = await refusal(
      service.signOut({ scope: "all", principal: undefined, refreshToken: undefined, endedSession }),
    );

    expect(sessions.revoked).toEqual([FAMILY_ID]);
    expect(all.answer).toBe("401 UNAUTHENTICATED");
    expect(sessions.revokedMembers).toEqual([]);
  });

  it("answers me with the staff member, the tenant, the role's permissions, the session and the environments", async () => {
    const { service, tenant } = serviceHarness();
    tenant.value = tenantRow({ storefrontEnvironment: "live" });

    const profile = await service.me({
      family: family({ role: "viewer" }),
      member: member({ role: "viewer" }),
    });

    expect(profile.permissions).toEqual(permissionsOf("viewer"));
    expect(profile.environments).toEqual(["test"]);
    expect(profile.session).toEqual({
      id: FAMILY_ID,
      createdAt: START,
      expiresAt: "2026-10-18T21:00:00.000Z",
      userAgent: "Mozilla/5.0 (test)",
    });
    expect(profile.staff).toMatchObject({ role: "viewer", timeZone: "Europe/Madrid", mfaEnabled: true });
    expect(profile.tenant).toMatchObject({ key: "alpha", environment: "test", timeZone: "Europe/Paris" });
  });
});
