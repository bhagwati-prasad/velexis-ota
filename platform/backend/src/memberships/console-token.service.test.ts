// ConsoleTokenService without a database or Redis (PBE-039; PADR-0007, flows/team-and-ota-admin-sso.md §C, PADR-0008,
// scope PF-22): the token's shape, the Redis write (`SET ptk:<sha256> <json> EX 60 NX`) and its value, the audit row
// without the token, the order of the refusals (account, membership, tenant status, the MFA policy of live OTAs), the
// `503` of an unreachable Redis before anything else is written, and the clean-up of a token whose audit row failed.
//
// The repository is a stand-in that answers one ConsoleTokenState; the audit service is the real one over a stand-in
// of its repository whose rows commit only when the transaction's work succeeds; Redis is an in-memory stand-in of the
// two commands the service sends. test/integration/memberships/console-token.int.test.ts runs the same rules through
// HTTP, PostgreSQL and Redis.
import type { ConfigService } from "@nestjs/config";
import { sha256Hex } from "@velexis/crypto";
import { isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it } from "vitest";
import type { AuditRepository, AuditRowInsert } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import type { PlatformDb } from "../common/database";
import type { RequestContext } from "../common/http/request-context";
import type { PlatformBackendConfig } from "../config";
import {
  ConsoleTokenService,
  consoleGrantOf,
  consoleSsoUrl,
  generatePortalToken,
  PORTAL_TOKEN_PATTERN,
  redisFailure,
  type PortalTokenValue,
} from "./console-token.service";
import type { ConsoleTokenState, MembershipsRepository } from "./memberships.repository";
import { TENANT_ROLES } from "./tenant-roles";

/** A prefixed ULID of the shape of the platform's ids (`acc_…`, `stf_…`, `ten_…`) for sequence number `n`. */
function id(prefix: string, n: number): string {
  return `${prefix}_01JA2ZA1C5E9G3J7K2M6P0${String(n).padStart(4, "0")}`;
}

const TENANT = id("ten", 1);
const ACCOUNT = id("acc", 1);
const MEMBERSHIP = id("stf", 1);
const REQUEST_ID = "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const OTA_ADMIN_URL = "https://admin.ota.example.com";
/** The OTA contract's `ConsolePortalTokenSignIn.portalToken`, which the OTA backend's sign-in checks. */
const OTA_CONTRACT_PORTAL_TOKEN = /^ptk_[A-Za-z0-9]{24,64}$/;

/** The membership TenantRoleGuard hands the service. */
const CALLER: TenantMembership = {
  membershipId: MEMBERSHIP,
  tenantId: TENANT,
  accountId: ACCOUNT,
  role: "agent",
};

/** An agent of an active test-mode OTA, verified, without MFA: the state that gets a token. */
function stateOf(overrides: Partial<ConsoleTokenState> = {}): ConsoleTokenState {
  return {
    membership_id: MEMBERSHIP,
    role: "agent",
    account_status: "active",
    account_deleted_at: null,
    email_verified_at: new Date("2026-10-01T09:00:00Z"),
    mfa_enabled: false,
    tenant_status: "active",
    suspension_reason: null,
    storefront_environment: "test",
    ...overrides,
  };
}

/** One `SET` the service sent: the key, the value and the options after them. */
interface SetCall {
  readonly key: string;
  readonly value: string;
  readonly options: readonly unknown[];
}

/** The service over stand-ins, and what it wrote to Redis and committed to the audit log. */
class Harness {
  state: ConsoleTokenState | undefined = stateOf();
  readonly clock = new FakeClock("2026-10-23T09:15:00Z");
  /** Keys in the stand-in Redis. */
  readonly keys = new Map<string, string>();
  readonly sets: SetCall[] = [];
  readonly deleted: string[] = [];
  /** The audit rows committed. */
  readonly audit: AuditRowInsert[] = [];
  readonly warnings: Array<{ object: Record<string, unknown>; message: string }> = [];
  /** Set to make the next command of that kind fail. */
  failSet: Error | undefined;
  failDel: Error | undefined;
  failAudit: Error | undefined;
  readonly service: ConsoleTokenService;

  constructor() {
    const repository = {
      findConsoleTokenState: (tenantId: string, accountId: string) =>
        Promise.resolve(tenantId === TENANT && accountId === ACCOUNT ? this.state : undefined),
    };
    const redis = {
      set: (key: string, value: string, ...options: unknown[]) => {
        if (this.failSet !== undefined) {
          return Promise.reject(this.failSet);
        }
        this.sets.push({ key, value, options });
        if (options.includes("NX") && this.keys.has(key)) {
          return Promise.resolve(null);
        }
        this.keys.set(key, value);
        return Promise.resolve("OK");
      },
      del: (key: string) => {
        if (this.failDel !== undefined) {
          return Promise.reject(this.failDel);
        }
        this.deleted.push(key);
        return Promise.resolve(this.keys.delete(key) ? 1 : 0);
      },
    };
    const db = {
      transaction: () => ({
        execute: async <T>(work: (trx: AuditRowInsert[]) => Promise<T>): Promise<T> => {
          const trx: AuditRowInsert[] = [];
          const result = await work(trx);
          this.audit.push(...trx);
          return result;
        },
      }),
    };
    const auditRepository = {
      insert: (trx: AuditRowInsert[], row: AuditRowInsert) => {
        if (this.failAudit !== undefined) {
          return Promise.reject(this.failAudit);
        }
        trx.push(row);
        return Promise.resolve({ id: String(this.audit.length + trx.length), createdAt: this.clock.now() });
      },
    };
    const context = { active: true, requestId: REQUEST_ID, ip: "203.0.113.7", userAgent: "Mozilla/5.0" };
    const config = {
      get: (name: string) => (name === "PUBLIC_OTA_ADMIN_URL" ? OTA_ADMIN_URL : undefined),
    };
    const logger = {
      warn: (object: Record<string, unknown>, message: string) => {
        this.warnings.push({ object, message });
      },
    };
    this.service = new ConsoleTokenService(
      repository as unknown as MembershipsRepository,
      new AuditService(auditRepository as unknown as AuditRepository, context as unknown as RequestContext),
      this.clock,
      context as unknown as RequestContext,
      redis as unknown as Redis,
      db as unknown as PlatformDb,
      logger as unknown as PinoLogger,
      config as unknown as ConfigService<PlatformBackendConfig, true>,
    );
  }
}

/** `ok`, or the code of the AppError the work threw (its details too). */
async function outcome(work: () => Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await work();
    return { code: "ok" };
  } catch (error) {
    if (isAppError(error)) {
      return error.details === undefined
        ? { code: error.code }
        : { code: error.code, details: error.details };
    }
    throw error;
  }
}

describe("generatePortalToken", () => {
  it("[PBE-039] makes ptk_ and 43 base62 characters: the document's PortalToken, within the OTA contract's pattern", () => {
    const tokens = Array.from({ length: 200 }, () => generatePortalToken());

    for (const token of tokens) {
      expect(token).toMatch(PORTAL_TOKEN_PATTERN);
      expect(token).toMatch(OTA_CONTRACT_PORTAL_TOKEN);
      expect(token).toHaveLength(4 + 43);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("draws from all 62 characters (rejection sampling keeps each of them reachable)", () => {
    const seen = new Set(
      Array.from({ length: 100 }, () => generatePortalToken().slice(4))
        .join("")
        .split(""),
    );

    // 4 300 uniform draws miss one of 62 characters with a probability far below 10^-25.
    expect(seen.size).toBe(62);
  });
});

describe("consoleSsoUrl", () => {
  it.each([
    ["https://admin.ota.example.com", "https://admin.ota.example.com/sso"],
    ["https://admin.ota.example.com/", "https://admin.ota.example.com/sso"],
    ["http://localhost:3002", "http://localhost:3002/sso"],
    ["https://example.com/ota-admin/", "https://example.com/ota-admin/sso"],
    ["https://admin.ota.example.com/?x=1#top", "https://admin.ota.example.com/sso"],
  ])("answers %s as %s", (base, expected) => {
    expect(consoleSsoUrl(base)).toBe(expected);
  });
});

describe("consoleGrantOf", () => {
  it("lets every role of an active member through, with the account's MFA flag", () => {
    for (const role of TENANT_ROLES) {
      for (const mfa of [false, true]) {
        expect(consoleGrantOf(stateOf({ role, mfa_enabled: mfa }))).toEqual({
          membershipId: MEMBERSHIP,
          role,
          mfa,
        });
      }
    }
  });

  it("refuses in the order of the file header: account, e-mail, membership, tenant, MFA", async () => {
    const refusal = (state: ConsoleTokenState | undefined) =>
      outcome(() => Promise.resolve(consoleGrantOf(state)));
    const suspendedLiveWithoutMfa = {
      tenant_status: "suspended",
      suspension_reason: "billing",
      storefront_environment: "live",
    };

    expect(await refusal(stateOf({ account_status: "disabled", ...suspendedLiveWithoutMfa }))).toEqual({
      code: "UNAUTHENTICATED",
    });
    expect(await refusal(stateOf({ account_status: "deleted" }))).toEqual({ code: "UNAUTHENTICATED" });
    expect(await refusal(stateOf({ account_status: "locked" }))).toEqual({ code: "UNAUTHENTICATED" });
    expect(await refusal(stateOf({ account_deleted_at: new Date("2026-10-20T00:00:00Z") }))).toEqual({
      code: "UNAUTHENTICATED",
    });
    expect(
      await refusal(stateOf({ account_status: "pending_verification", ...suspendedLiveWithoutMfa })),
    ).toEqual({ code: "EMAIL_NOT_VERIFIED" });
    expect(await refusal(stateOf({ email_verified_at: null }))).toEqual({ code: "EMAIL_NOT_VERIFIED" });
    expect(await refusal(undefined)).toEqual({ code: "NOT_FOUND" });
    expect(await refusal(stateOf(suspendedLiveWithoutMfa))).toEqual({
      code: "TENANT_NOT_ACTIVE",
      details: { status: "suspended", suspensionReason: "billing" },
    });
    expect(await refusal(stateOf({ storefront_environment: "live" }))).toEqual({ code: "MFA_REQUIRED" });
  });

  it("[PBE-039 AC2] answers TENANT_NOT_ACTIVE with the status, and the reason of a suspension", async () => {
    for (const status of ["provisioning", "failed"]) {
      expect(
        await outcome(() => Promise.resolve(consoleGrantOf(stateOf({ tenant_status: status })))),
      ).toEqual({
        code: "TENANT_NOT_ACTIVE",
        details: { status },
      });
    }
    for (const reason of ["billing", "abuse", "request", "admin"]) {
      expect(
        await outcome(() =>
          Promise.resolve(consoleGrantOf(stateOf({ tenant_status: "suspended", suspension_reason: reason }))),
        ),
      ).toEqual({ code: "TENANT_NOT_ACTIVE", details: { status: "suspended", suspensionReason: reason } });
    }
    // A suspension without a recorded reason (an old row) still names its status.
    expect(
      await outcome(() => Promise.resolve(consoleGrantOf(stateOf({ tenant_status: "suspended" })))),
    ).toEqual({ code: "TENANT_NOT_ACTIVE", details: { status: "suspended" } });
  });

  it("[PBE-039 AC2] needs MFA for a live OTA only; a test-only OTA lets a member without MFA through", async () => {
    expect(
      await outcome(() => Promise.resolve(consoleGrantOf(stateOf({ storefront_environment: "live" })))),
    ).toEqual({ code: "MFA_REQUIRED" });
    expect(consoleGrantOf(stateOf({ storefront_environment: "live", mfa_enabled: true })).mfa).toBe(true);
    expect(consoleGrantOf(stateOf({ storefront_environment: "test" })).mfa).toBe(false);
  });

  it("answers NOT_FOUND for a role the matrix does not know (a row the guard would not have let through)", async () => {
    expect(await outcome(() => Promise.resolve(consoleGrantOf(stateOf({ role: "superuser" }))))).toEqual({
      code: "NOT_FOUND",
    });
  });
});

describe("ConsoleTokenService.create", () => {
  it("[PBE-039 AC1] stores ptk:<sha256> with EX 60 NX and the grant, audits the issue without the token, and answers it", async () => {
    const h = new Harness();
    h.state = stateOf({ role: "finance", mfa_enabled: true });

    const answer = await h.service.create(CALLER);

    expect(answer).toEqual({
      portalToken: expect.stringMatching(PORTAL_TOKEN_PATTERN) as string,
      expiresAt: "2026-10-23T09:16:00.000Z",
      consoleSsoUrl: "https://admin.ota.example.com/sso",
    });
    const key = `ptk:${sha256Hex(answer.portalToken)}`;
    expect(h.sets).toEqual([{ key, value: expect.any(String) as string, options: ["EX", 60, "NX"] }]);
    const value = JSON.parse(h.keys.get(key) ?? "null") as PortalTokenValue;
    expect(value).toEqual({
      v: 1,
      accountId: ACCOUNT,
      tenantId: TENANT,
      membershipId: MEMBERSHIP,
      // The role as the fresh read has it, not as the guard's read had it.
      role: "finance",
      mfa: true,
      issuedAt: "2026-10-23T09:15:00.000Z",
      requestId: REQUEST_ID,
    });

    expect(h.audit).toEqual([
      {
        actorType: "account",
        actorAccountId: ACCOUNT,
        actorLabel: null,
        action: "console.token_issued",
        targetType: "membership",
        targetId: MEMBERSHIP,
        tenantId: TENANT,
        tenantKey: null,
        requestId: REQUEST_ID,
        ipAddress: "203.0.113.7",
        userAgent: "Mozilla/5.0",
        detailsJson: JSON.stringify({ role: "finance", mfa: true, expiresAt: "2026-10-23T09:16:00.000Z" }),
      },
    ]);
    // Neither the token, nor its random part, nor its digest reaches the stored value or the audit row.
    for (const secret of [answer.portalToken, answer.portalToken.slice(4), sha256Hex(answer.portalToken)]) {
      expect(h.keys.get(key)).not.toContain(secret);
      expect(JSON.stringify(h.audit)).not.toContain(secret);
    }
    expect(h.warnings).toEqual([]);
  });

  it("issues a new token on every call", async () => {
    const h = new Harness();

    const first = await h.service.create(CALLER);
    const second = await h.service.create(CALLER);

    expect(first.portalToken).not.toBe(second.portalToken);
    expect(h.keys.size).toBe(2);
    expect(h.audit).toHaveLength(2);
  });

  it("[PBE-039 AC2] refuses a suspended OTA and a live OTA without MFA before anything is written", async () => {
    for (const [state, expected] of [
      [
        stateOf({ tenant_status: "suspended", suspension_reason: "billing" }),
        { code: "TENANT_NOT_ACTIVE", details: { status: "suspended", suspensionReason: "billing" } },
      ],
      [
        stateOf({ tenant_status: "provisioning" }),
        { code: "TENANT_NOT_ACTIVE", details: { status: "provisioning" } },
      ],
      [stateOf({ storefront_environment: "live" }), { code: "MFA_REQUIRED" }],
      [undefined, { code: "NOT_FOUND" }],
    ] as const) {
      const h = new Harness();
      h.state = state;

      expect(await outcome(() => h.service.create(CALLER))).toEqual(expected);
      expect(h.sets).toEqual([]);
      expect(h.audit).toEqual([]);
    }
  });

  it("answers 503 SERVICE_UNAVAILABLE while Redis refuses the write, with no audit row and a cause without arguments", async () => {
    const h = new Harness();
    const replyError = Object.assign(new Error("READONLY You can't write against a read only replica."), {
      name: "ReplyError",
      command: { name: "set", args: ["ptk:digest", "{}", "EX", "60", "NX"] },
    });
    h.failSet = replyError;

    let caught: unknown;
    try {
      await h.service.create(CALLER);
    } catch (error) {
      caught = error;
    }

    expect(isAppError(caught) && caught.code).toBe("SERVICE_UNAVAILABLE");
    const cause = (caught as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toMatchObject({ name: "ReplyError", message: replyError.message });
    expect(Object.keys(cause as object)).not.toContain("command");
    expect(h.audit).toEqual([]);
  });

  it("never hands out a token whose key existed already (NX refused the write)", async () => {
    const h = new Harness();
    // Every key "exists": the stand-in answers NX's null as Redis would for a repeated digest.
    h.keys.has = () => true;

    await expect(h.service.create(CALLER)).rejects.toThrow("the portal token key exists already");
    expect(h.sets).toHaveLength(1);
    expect(h.deleted).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it("deletes the token again when its audit row cannot be written, and answers the failure", async () => {
    const h = new Harness();
    h.failAudit = new Error("connection terminated");

    await expect(h.service.create(CALLER)).rejects.toThrow("connection terminated");

    const [set] = h.sets;
    expect(set).toBeDefined();
    expect(h.deleted).toEqual([set?.key]);
    expect(h.keys.size).toBe(0);
    expect(h.audit).toEqual([]);
  });

  it("logs a failed clean-up without the key, and still answers the audit failure", async () => {
    const h = new Harness();
    h.failAudit = new Error("connection terminated");
    h.failDel = Object.assign(new Error("Connection is closed."), {
      command: { name: "del", args: ["ptk:x"] },
    });

    await expect(h.service.create(CALLER)).rejects.toThrow("connection terminated");

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]?.message).toBe("console_token.discard_failed");
    expect(JSON.stringify(h.warnings)).not.toContain("ptk:");
    expect(Object.keys(h.warnings[0]?.object["err"] as object)).not.toContain("command");
  });

  it("names the requestId null outside a request context", async () => {
    const h = new Harness();
    Object.defineProperty(h.service, "context", { value: { requestId: undefined } });

    const answer = await h.service.create(CALLER);

    const value = JSON.parse(
      h.keys.get(`ptk:${sha256Hex(answer.portalToken)}`) ?? "null",
    ) as PortalTokenValue;
    expect(value.requestId).toBeNull();
  });
});

describe("redisFailure", () => {
  it("keeps the name and message of an error and nothing else", () => {
    const failure = redisFailure(
      Object.assign(new Error("MaxRetriesPerRequestError"), {
        name: "MaxRetriesPerRequestError",
        args: ["x"],
      }),
    );

    expect(failure).toMatchObject({
      name: "MaxRetriesPerRequestError",
      message: "MaxRetriesPerRequestError",
    });
    // `name` is the only own property; nothing of the original error (its `args`, an ioredis `command`) is copied.
    expect(Object.keys(failure)).toEqual(["name"]);
    expect(redisFailure("boom")).toMatchObject({ name: "Error", message: "Redis command failed" });
  });
});

describe("ConsoleTokenService.create for every role", () => {
  it("gives a token to a member of each role of the matrix (scope §1.2 `openConsole`: every role)", async () => {
    for (const role of TENANT_ROLES) {
      const h = new Harness();
      h.state = stateOf({ role });

      const answer = await h.service.create({ ...CALLER, role });

      const value = JSON.parse(
        h.keys.get(`ptk:${sha256Hex(answer.portalToken)}`) ?? "null",
      ) as PortalTokenValue;
      expect(value.role).toBe(role);
    }
  });
});
