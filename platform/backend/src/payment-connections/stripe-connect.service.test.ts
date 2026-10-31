// StripeConnectService without a database or Redis (PBE-055; flows/stripe-payments-account.md §C and "Failure handling",
// PADR-0011 item 2, scope PF-61 AC1): the state (256 bits, stored under its SHA-256 for 10 minutes with the account
// that started it), the authorize URL, and the callback's rules in their order: the state is single use and bound to
// its account, the membership and the OTA are read again, Stripe's refusals and failures, `livemode` against the
// deployment, one `acct_…` per OTA, and the switch of the test (and live) connection with its audit rows, the
// invalidation after the commit, and no OAuth token anywhere.
//
// The repository is a stand-in over in-memory rows whose writes commit only when the transaction's work succeeds; the
// audit service is the real one over a stand-in of its repository; Redis is an in-memory stand-in of the commands the
// service sends; Stripe is the FakeStripe of test/support. test/integration/connections/stripe-connect.int.test.ts runs
// the same rules through HTTP, PostgreSQL and Redis.
import type { ConfigService } from "@nestjs/config";
import { sha256Hex } from "@velexis/crypto";
import { isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { FakeStripe, type FakeConnectTokens } from "../../test/support/fake-stripe";
import type { AuditRepository, AuditRowInsert } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import type { PlatformDb } from "../common/database";
import type { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { afterCommit, type InvalidationPublisher } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import type {
  ConnectMember,
  ConnectStandardInsert,
  ConnectStandardWrite,
  ConnectStarter,
  ConnectTenant,
  PaymentConnectionsRepository,
  PaymentConnectionView,
  PaymentEnvironment,
} from "./payment-connections.repository";
import {
  CONNECT_ACCOUNT_INDEX,
  CONNECT_STATE_PATTERN,
  connectCallbackUrl,
  generateConnectState,
  oauthErrorReason,
  parseConnectState,
  StripeConnectFailure,
  StripeConnectService,
  stripeConnectAuthorizeUrl,
  stripeConnectFailureOf,
  type StripeOAuthStateValue,
} from "./stripe-connect.service";

/** A prefixed ULID of the shape of the platform's ids (`acc_…`, `stf_…`, `ten_…`) for sequence number `n`. */
function id(prefix: string, n: number): string {
  return `${prefix}_01JA2ZA1C5E9G3J7K2M6P0${String(n).padStart(4, "0")}`;
}

const TENANT = id("ten", 1);
const OWNER = id("acc", 1);
const OTHER = id("acc", 2);
const MEMBERSHIP = id("stf", 1);
const OTHER_TENANT = id("ten", 2);
const TEST_ROW = id("ppc", 1);
const LIVE_ROW = id("ppc", 2);
const ACCOUNT = "acct_1QTestAgency";
const CODE = "ac_TestAuthorizationCode";
const PORTAL_URL = "https://platform.example.com";
const CLIENT_ID = "ca_TestConnectClient";
const REQUEST_ID = "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
/** The document's `StripeConnectState`. */
const DOCUMENT_STATE = /^[A-Za-z0-9_-]{16,128}$/;

/** The owner's membership, as TenantRoleGuard hands it to `start`. */
const CALLER: TenantMembership = {
  membershipId: MEMBERSHIP,
  tenantId: TENANT,
  accountId: OWNER,
  role: "owner",
};

/** A connection row as the repository reads it: `velexis` mode, active. */
function rowOf(
  environment: PaymentEnvironment,
  overrides: Partial<PaymentConnectionView> = {},
): PaymentConnectionView {
  return {
    id: environment === "test" ? TEST_ROW : LIVE_ROW,
    tenant_id: TENANT,
    provider: "stripe",
    environment,
    account_mode: "velexis",
    account_reference: null,
    publishable_key: null,
    encryption_key_id: null,
    supported_methods: ["card"],
    capture_mode: "manual",
    is_default: true,
    status: "active",
    statement_descriptor_suffix: "AGENCY TRAVEL",
    capabilities: {},
    connected_at: null,
    disconnected_at: null,
    last_verified_at: null,
    last_error: null,
    created_by_account_id: null,
    version: 1,
    created_at: new Date("2026-10-01T09:00:00Z"),
    updated_at: new Date("2026-10-01T09:00:00Z"),
    ...overrides,
  };
}

/** The transaction of the stand-in database: its own copy of the rows and its audit rows, committed on success. */
interface Trx {
  readonly rows: Map<PaymentEnvironment, PaymentConnectionView>;
  readonly audit: AuditRowInsert[];
}

/** One `SET` the service sent. */
interface SetCall {
  readonly key: string;
  readonly value: string;
  readonly options: readonly unknown[];
}

/** The service over stand-ins, and what it wrote to Redis, the rows, the audit log and `vx:invalidate`. */
class Harness {
  /** The caller's membership as `connectStarter` reads it; `undefined`: none any more. */
  starter: ConnectStarter | undefined = {
    membership_id: MEMBERSHIP,
    role: "owner",
    tenant_status: "active",
    email: "anna.berg@example.com",
  };
  /** The tenant as the transaction reads it `FOR SHARE`. */
  tenant: ConnectTenant | undefined = { status: "active", storefront_environment: "test" };
  /** The tenant whose `connect_standard` connection holds an account, by account. */
  readonly elsewhere = new Map<string, string>();
  /**
   * The accounts of `elsewhere` whose holder's connections a Stripe deauthorisation disabled (`disconnected_at` set):
   * they still hold the account for `connectedElsewhere`, no longer for `connectedHolderOf`.
   */
  readonly elsewhereDeauthorized = new Set<string>();
  /** A unique violation the next write throws (another OTA committed the account meanwhile). */
  conflictOnWrite = false;
  /** Runs when the transaction reads the tenant: what another request commits just before the switch locks the rows. */
  beforeSwitch: ((trx: Trx) => void) | undefined;
  /** Set to make `connectedElsewhere` and `connectedHolderOf` fail (the database). */
  elsewhereDown: Error | undefined;
  readonly rows = new Map<PaymentEnvironment, PaymentConnectionView>([["test", rowOf("test")]]);
  readonly clock = new FakeClock("2026-10-30T09:15:00Z");
  readonly stripe = new FakeStripe();
  readonly keys = new Map<string, string>();
  readonly sets: SetCall[] = [];
  readonly getdels: string[] = [];
  readonly audit: AuditRowInsert[] = [];
  readonly events: unknown[] = [];
  readonly warnings: Array<{ object: Record<string, unknown>; message: string }> = [];
  readonly infos: Array<{ object: Record<string, unknown>; message: string }> = [];
  /** Set to make every Redis command fail. */
  redisDown: Error | undefined;
  readonly service: StripeConnectService;

  constructor(options: { readonly appEnv?: string; readonly clientId?: string | undefined } = {}) {
    const clientId = "clientId" in options ? options.clientId : CLIENT_ID;
    const view = (row: PaymentConnectionView): PaymentConnectionView => structuredClone(row);
    const repository = {
      connectStarter: (tenantId: string, accountId: string) =>
        Promise.resolve(tenantId === TENANT && accountId === OWNER ? this.starter : undefined),
      // The callback reads the membership without the account (no e-mail address).
      connectMember: (tenantId: string, accountId: string): Promise<ConnectMember | undefined> => {
        if (tenantId !== TENANT || accountId !== OWNER || this.starter === undefined) {
          return Promise.resolve(undefined);
        }
        const { membership_id, role, tenant_status } = this.starter;
        return Promise.resolve({ membership_id, role, tenant_status });
      },
      tenantForShare: (trx: Trx, tenantId: string) => {
        this.beforeSwitch?.(trx);
        return Promise.resolve(tenantId === TENANT ? this.tenant : undefined);
      },
      connectedElsewhere: (accountReference: string, tenantId: string) => {
        if (this.elsewhereDown !== undefined) {
          return Promise.reject(this.elsewhereDown);
        }
        const holder = this.elsewhere.get(accountReference);
        return Promise.resolve(holder !== undefined && holder !== tenantId ? holder : undefined);
      },
      // Any OTA's still-connected holder (`disconnected_at` empty): this OTA's own rows first, then `elsewhere`.
      connectedHolderOf: (accountReference: string) => {
        if (this.elsewhereDown !== undefined) {
          return Promise.reject(this.elsewhereDown);
        }
        const own = [...this.rows.values()].some(
          (row) =>
            row.account_mode === "connect_standard" &&
            row.account_reference === accountReference &&
            row.disconnected_at === null,
        );
        if (own) {
          return Promise.resolve(TENANT);
        }
        const holder = this.elsewhere.get(accountReference);
        return Promise.resolve(this.elsewhereDeauthorized.has(accountReference) ? undefined : holder);
      },
      lockForTenant: (trx: Trx, tenantId: string, environment: PaymentEnvironment) => {
        const row = tenantId === TENANT ? trx.rows.get(environment) : undefined;
        return Promise.resolve(row === undefined ? undefined : view(row));
      },
      applyConnectStandard: (trx: Trx, rowId: string, write: ConnectStandardWrite) => {
        if (this.conflictOnWrite) {
          const conflict = Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint: CONNECT_ACCOUNT_INDEX,
          });
          return Promise.reject(conflict);
        }
        const [environment, current] = [...trx.rows].find(([, row]) => row.id === rowId) ?? [];
        if (environment === undefined || current === undefined) {
          return Promise.reject(new Error(`no row ${rowId}`));
        }
        trx.rows.set(environment, Harness.switched(current, write));
        return Promise.resolve(view(trx.rows.get(environment) ?? current));
      },
      insertConnectStandard: (trx: Trx, row: ConnectStandardInsert) => {
        const inserted = Harness.switched(
          rowOf(row.environment, {
            id: row.id,
            statement_descriptor_suffix: row.statementDescriptorSuffix,
            version: 0,
            created_at: row.now,
          }),
          row,
        );
        trx.rows.set(row.environment, inserted);
        return Promise.resolve(view(inserted));
      },
      listForTenant: (_tenantId: string, trx?: Trx) =>
        Promise.resolve(
          (["test", "live"] as const).flatMap((environment) => {
            const row = (trx?.rows ?? this.rows).get(environment);
            return row === undefined ? [] : [view(row)];
          }),
        ),
    };
    const redis = {
      set: (key: string, value: string, ...options: unknown[]) => {
        if (this.redisDown !== undefined) {
          return Promise.reject(this.redisDown);
        }
        this.sets.push({ key, value, options });
        if (options.includes("NX") && this.keys.has(key)) {
          return Promise.resolve(null);
        }
        this.keys.set(key, value);
        return Promise.resolve("OK");
      },
      getdel: (key: string) => {
        if (this.redisDown !== undefined) {
          return Promise.reject(this.redisDown);
        }
        this.getdels.push(key);
        const value = this.keys.get(key) ?? null;
        this.keys.delete(key);
        return Promise.resolve(value);
      },
    };
    const db = {
      transaction: () => ({
        execute: async <T>(work: (trx: Trx) => Promise<T>): Promise<T> => {
          const trx: Trx = { rows: new Map([...this.rows].map(([key, row]) => [key, view(row)])), audit: [] };
          const result = await work(trx);
          // COMMIT: the rows, then the audit rows.
          this.rows.clear();
          for (const [key, row] of trx.rows) {
            this.rows.set(key, row);
          }
          this.audit.push(...trx.audit);
          return result;
        },
      }),
    };
    const auditRepository = {
      insert: (trx: Trx, row: AuditRowInsert) => {
        trx.audit.push(row);
        return Promise.resolve({
          id: String(this.audit.length + trx.audit.length),
          createdAt: this.clock.now(),
        });
      },
    };
    const invalidations = {
      publishAfterCommit: (trx: Trx, event: unknown) => {
        afterCommit(trx as never, () => {
          this.events.push(event);
        });
      },
    };
    const context = { active: true, requestId: REQUEST_ID, ip: "203.0.113.55", userAgent: "Mozilla/5.0" };
    const settings: Record<string, string | undefined> = {
      STRIPE_CONNECT_CLIENT_ID: clientId,
      PUBLIC_PORTAL_URL: PORTAL_URL,
      APP_ENV: options.appEnv ?? "test",
    };
    const logger = {
      warn: (object: Record<string, unknown>, message: string) => {
        this.warnings.push({ object, message });
      },
      info: (object: Record<string, unknown>, message: string) => {
        this.infos.push({ object, message });
      },
    };
    this.service = new StripeConnectService(
      repository as unknown as PaymentConnectionsRepository,
      new AuditService(auditRepository as unknown as AuditRepository, context as unknown as RequestContext),
      invalidations as unknown as InvalidationPublisher,
      this.stripe,
      this.clock,
      new IdGenerator(this.clock),
      redis as unknown as Redis,
      db as unknown as PlatformDb,
      logger as unknown as PinoLogger,
      { get: (name: string) => settings[name] } as unknown as ConfigService<PlatformBackendConfig, true>,
    );
    this.stripe.put({
      id: ACCOUNT,
      object: "account",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    } as never);
  }

  /** A connection after `write`, as the update or insert returns it. */
  static switched(row: PaymentConnectionView, write: ConnectStandardWrite): PaymentConnectionView {
    return {
      ...row,
      account_mode: "connect_standard",
      account_reference: write.accountReference,
      publishable_key: null,
      encryption_key_id: null,
      capabilities: { ...write.capabilities },
      connected_at: write.now,
      disconnected_at: null,
      last_error: null,
      status: write.status,
      created_by_account_id: write.connectedByAccountId,
      version: row.version + 1,
      updated_at: write.now,
    };
  }

  /** Starts a connection as the owner and answers the state of the authorize URL. */
  async started(): Promise<string> {
    const { authorizeUrl } = await this.service.start(CALLER);
    return new URL(authorizeUrl).searchParams.get("state") ?? "";
  }

  /** The tokens of a code for `ACCOUNT` in `livemode`. */
  granted(livemode = false, code = CODE): FakeConnectTokens {
    return this.stripe.grantConnectCode(code, { stripeUserId: ACCOUNT, livemode });
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

/** The cause of the AppError `work` throws. */
async function causeOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.cause : undefined;
  }
  return undefined;
}

describe("the state and the authorize URL", () => {
  it("[PBE-055] makes a state of 256 bits: 43 base64url characters within the document's StripeConnectState", () => {
    const states = Array.from({ length: 200 }, () => generateConnectState());

    for (const state of states) {
      expect(state).toMatch(CONNECT_STATE_PATTERN);
      expect(state).toMatch(DOCUMENT_STATE);
      expect(Buffer.from(state, "base64url")).toHaveLength(32);
    }
    expect(new Set(states).size).toBe(states.length);
  });

  it.each([
    ["https://platform.example.com", "https://platform.example.com/connect/stripe/callback"],
    ["https://platform.example.com/", "https://platform.example.com/connect/stripe/callback"],
    ["http://localhost:3000", "http://localhost:3000/connect/stripe/callback"],
    ["https://example.com/portal/?x=1#top", "https://example.com/portal/connect/stripe/callback"],
  ])("answers the callback of %s as %s", (portal, callback) => {
    expect(connectCallbackUrl(portal)).toBe(callback);
  });

  it("[PBE-055] builds Stripe's authorize URL with the parameters of PADR-0011 in their order", () => {
    const url = new URL(
      stripeConnectAuthorizeUrl({
        clientId: CLIENT_ID,
        state: "Xq7Lm2Np9Rt4Vw8Yb3Dc6Fg1Hj5Kk0Zs2Ae7Ui4Ow9Pq",
        redirectUri: "https://platform.example.com/connect/stripe/callback",
        email: "anna.berg+ota@example.com",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect([...url.searchParams]).toEqual([
      ["response_type", "code"],
      ["client_id", CLIENT_ID],
      ["scope", "read_write"],
      ["state", "Xq7Lm2Np9Rt4Vw8Yb3Dc6Fg1Hj5Kk0Zs2Ae7Ui4Ow9Pq"],
      ["redirect_uri", "https://platform.example.com/connect/stripe/callback"],
      ["stripe_user[email]", "anna.berg+ota@example.com"],
    ]);
    expect(url.search).toContain("stripe_user%5Bemail%5D=anna.berg%2Bota%40example.com");
  });

  it("reads a stored state only in start's shape", () => {
    const value: StripeOAuthStateValue = { tenantId: TENANT, accountId: OWNER, membershipId: MEMBERSHIP };

    expect(parseConnectState(JSON.stringify(value))).toEqual(value);
    for (const raw of [
      null,
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify({ ...value, tenantId: "ten_short" }),
      JSON.stringify({ ...value, accountId: 7 }),
      JSON.stringify({ tenantId: TENANT, accountId: OWNER }),
    ]) {
      expect([raw, parseConnectState(raw)]).toEqual([raw, undefined]);
    }
  });

  it("names the reason of a callback with an error: access_denied, else oauth_error", () => {
    expect(oauthErrorReason("access_denied")).toBe("access_denied");
    expect(oauthErrorReason("invalid_scope")).toBe("oauth_error");
    expect(oauthErrorReason("server_error")).toBe("oauth_error");
  });

  it("reduces Stripe's errors to their type, status and code, never Stripe's message", () => {
    const request = stripeConnectFailureOf("oauth.token", FakeStripe.apiError(400, "resource_missing"));
    expect([request.summary, request.invalidGrant]).toEqual([
      "invalid_request_error 400 (resource_missing)",
      false,
    ]);
    expect(stripeConnectFailureOf("accounts.retrieve", FakeStripe.connectionError()).summary).toBe(
      "connection_error no_status",
    );
    const failure = new StripeConnectFailure("oauth.token", "the answer has no acct_ id");
    expect(stripeConnectFailureOf("oauth.token", failure)).toBe(failure);
    expect(stripeConnectFailureOf("oauth.token", new TypeError(`bad ${CODE}`)).summary).toBe(
      "unexpected TypeError",
    );
  });
});

describe("StripeConnectService.start", () => {
  it("[PBE-055 AC1] stores stripe:oauth:<sha256(state)> for 10 minutes with the account, and answers the authorize URL", async () => {
    const h = new Harness();

    const answer = await h.service.start(CALLER);

    const url = new URL(answer.authorizeUrl);
    const state = url.searchParams.get("state") ?? "";
    expect(state).toMatch(CONNECT_STATE_PATTERN);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      scope: "read_write",
      state,
      redirect_uri: "https://platform.example.com/connect/stripe/callback",
      "stripe_user[email]": "anna.berg@example.com",
    });
    expect(answer.expiresAt).toBe("2026-10-30T09:25:00.000Z");
    const key = `stripe:oauth:${sha256Hex(state)}`;
    expect(h.sets).toEqual([{ key, value: expect.any(String) as string, options: ["EX", 600, "NX"] }]);
    expect(JSON.parse(h.keys.get(key) ?? "null")).toEqual({
      tenantId: TENANT,
      accountId: OWNER,
      membershipId: MEMBERSHIP,
    });
    // The state itself is stored nowhere: the key holds its digest, the value the ids.
    expect(JSON.stringify([...h.keys])).not.toContain(state);
    expect(h.audit).toEqual([]);
  });

  it("[PBE-055] refuses an OTA that is not active, and a membership that ended, before anything is stored", async () => {
    const h = new Harness();
    for (const status of ["suspended", "provisioning", "failed"]) {
      h.starter = {
        membership_id: MEMBERSHIP,
        role: "owner",
        tenant_status: status,
        email: "anna.berg@example.com",
      };
      expect(await outcome(() => h.service.start(CALLER))).toEqual({
        code: "TENANT_NOT_ACTIVE",
        details: { status },
      });
    }
    h.starter = undefined;
    expect(await outcome(() => h.service.start(CALLER))).toEqual({ code: "NOT_FOUND" });
    expect(h.sets).toEqual([]);
  });

  it("[PBE-055] answers 503 SERVICE_UNAVAILABLE while Redis is down, without the command's arguments in the cause", async () => {
    const h = new Harness();
    // ioredis attaches the command and its arguments (the key and the stored ids) to the errors it throws.
    const key = `stripe:oauth:${"a".repeat(64)}`;
    h.redisDown = Object.assign(new Error("Connection is closed."), {
      command: { name: "set", args: [key, JSON.stringify({ membershipId: MEMBERSHIP }), "EX", 600, "NX"] },
    });

    expect(await outcome(() => h.service.start(CALLER))).toEqual({ code: "SERVICE_UNAVAILABLE" });
    const cause = await causeOf(() => h.service.start(CALLER));
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBe(h.redisDown);
    expect(cause).toMatchObject({ name: "Error", message: "Connection is closed." });
    expect(cause).not.toHaveProperty("command");
    expect(JSON.stringify(cause)).not.toContain(MEMBERSHIP);
  });

  it("fails without STRIPE_CONNECT_CLIENT_ID (a configuration bug: the switch requires it)", async () => {
    const h = new Harness({ clientId: undefined });

    await expect(h.service.start(CALLER)).rejects.toThrow(/STRIPE_CONNECT_CLIENT_ID/);
    expect(h.sets).toEqual([]);
  });
});

describe("StripeConnectService.complete", () => {
  it("[PBE-055 AC1] takes the state with GETDEL: it works once, and only for the account that started it", async () => {
    const h = new Harness();
    const state = await h.started();
    h.granted();

    // Another account: refused, and the state is spent all the same.
    expect(await outcome(() => h.service.complete(OTHER, { state, code: CODE }))).toEqual({
      code: "CONNECT_STATE_INVALID",
    });
    expect(h.warnings).toEqual([
      { object: { tenantId: TENANT }, message: "stripe_connect.state_account_mismatch" },
    ]);
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "CONNECT_STATE_INVALID",
    });

    // A fresh state: used once by its own account, then refused.
    const second = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state: second, code: CODE }))).toEqual({
      code: "ok",
    });
    h.granted(false, "ac_TestSecondCode");
    expect(
      await outcome(() => h.service.complete(OWNER, { state: second, code: "ac_TestSecondCode" })),
    ).toEqual({
      code: "CONNECT_STATE_INVALID",
    });
    // An unknown state never reaches Stripe.
    expect(
      await outcome(() => h.service.complete(OWNER, { state: generateConnectState(), code: CODE })),
    ).toEqual({
      code: "CONNECT_STATE_INVALID",
    });
    expect(h.getdels).toEqual(
      [state, state, second, second]
        .map((s) => `stripe:oauth:${sha256Hex(s)}`)
        .concat([expect.any(String) as string]),
    );
    expect(h.stripe.callsOf("oauth.token")).toHaveLength(1);
  });

  it("[PBE-055] needs the starter still an owner or admin of an active OTA", async () => {
    const h = new Harness();
    for (const role of ["agent", "finance", "viewer"]) {
      const state = await h.started();
      h.starter = {
        membership_id: MEMBERSHIP,
        role,
        tenant_status: "active",
        email: "anna.berg@example.com",
      };
      expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
        code: "FORBIDDEN",
      });
      h.starter = {
        membership_id: MEMBERSHIP,
        role: "owner",
        tenant_status: "active",
        email: "anna.berg@example.com",
      };
    }
    // The state is bound to the membership that started it: another membership of the same account is refused.
    let state = await h.started();
    h.starter = {
      membership_id: id("stf", 2),
      role: "owner",
      tenant_status: "active",
      email: "anna.berg@example.com",
    };
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "FORBIDDEN",
    });
    state = await h.started();
    h.starter = undefined;
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "FORBIDDEN",
    });
    // A state started before the OTA was suspended is refused at the callback.
    h.starter = {
      membership_id: MEMBERSHIP,
      role: "admin",
      tenant_status: "active",
      email: "anna.berg@example.com",
    };
    state = await h.started();
    h.starter = {
      membership_id: MEMBERSHIP,
      role: "admin",
      tenant_status: "suspended",
      email: "anna.berg@example.com",
    };
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "TENANT_NOT_ACTIVE",
      details: { status: "suspended" },
    });
    expect(h.stripe.calls).toEqual([]);
    expect([h.audit, h.events]).toEqual([[], []]);
  });

  it("[PBE-055] answers a declined authorisation 422 access_denied, any other error oauth_error, without calling Stripe", async () => {
    const h = new Harness();

    const declined = await h.started();
    expect(
      await outcome(() =>
        h.service.complete(OWNER, {
          state: declined,
          error: "access_denied",
          errorDescription: "The user denied",
        }),
      ),
    ).toEqual({ code: "UNPROCESSABLE", details: { reason: "access_denied" } });
    const failed = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state: failed, error: "invalid_scope" }))).toEqual(
      {
        code: "UNPROCESSABLE",
        details: { reason: "oauth_error" },
      },
    );
    // The error spent the state as well.
    expect(await outcome(() => h.service.complete(OWNER, { state: declined, code: CODE }))).toEqual({
      code: "CONNECT_STATE_INVALID",
    });
    expect(h.stripe.calls).toEqual([]);
    expect(h.rows.get("test")?.account_mode).toBe("velexis");
  });

  it("[PBE-055 AC2] answers a test-mode code in a live deployment 422 livemode_mismatch, and the reverse too", async () => {
    const live = new Harness({ appEnv: "production" });
    live.granted(false);
    const test = new Harness();
    test.granted(true);

    for (const h of [live, test]) {
      const state = await h.started();
      expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
        code: "UNPROCESSABLE",
        details: { reason: "livemode_mismatch" },
      });
      expect(h.stripe.callsOf("accounts.retrieve")).toEqual([]);
      expect([h.rows.get("test")?.account_mode, h.audit, h.events]).toEqual(["velexis", [], []]);
    }
    // A live-mode code in the live deployment connects.
    live.granted(true);
    const state = await live.started();
    expect(await outcome(() => live.service.complete(OWNER, { state, code: CODE }))).toEqual({ code: "ok" });
  });

  it("[PBE-055 AC2] answers 409 STRIPE_ACCOUNT_ALREADY_CONNECTED for an acct_ another OTA holds, also when it commits meanwhile", async () => {
    const h = new Harness();
    h.elsewhere.set(ACCOUNT, OTHER_TENANT);
    h.granted();
    let state = await h.started();

    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "STRIPE_ACCOUNT_ALREADY_CONNECTED",
    });
    expect(h.stripe.callsOf("accounts.retrieve")).toEqual([]);

    // The same OTA reconnecting its own account is no conflict; another OTA's write at the same moment is.
    h.elsewhere.set(ACCOUNT, TENANT);
    h.conflictOnWrite = true;
    h.granted();
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "STRIPE_ACCOUNT_ALREADY_CONNECTED",
    });
    expect([h.rows.get("test")?.account_mode, h.audit, h.events]).toEqual(["velexis", [], []]);
  });

  it("[PBE-055 AC3] switches the test connection to connect_standard, audits it, publishes after the commit and keeps no token", async () => {
    const h = new Harness();
    const tokens = h.granted();
    const state = await h.started();

    const completed = await h.service.complete(OWNER, { state, code: CODE });

    expect(completed.tenantId).toBe(TENANT);
    expect(completed.connections).toEqual([
      expect.objectContaining({
        id: TEST_ROW,
        environment: "test",
        account_mode: "connect_standard",
        account_reference: ACCOUNT,
        publishable_key: null,
        encryption_key_id: null,
        status: "active",
        capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
        connected_at: h.clock.now(),
        created_by_account_id: OWNER,
        statement_descriptor_suffix: "AGENCY TRAVEL",
        version: 2,
      }),
    ]);
    // The code was exchanged once, with the state's idempotency key; the account was read for its capabilities.
    expect(h.stripe.callsOf("oauth.token")).toEqual([
      {
        method: "oauth.token",
        id: undefined,
        params: { grant_type: "authorization_code", code: CODE },
        idempotencyKey: `connect_oauth:${sha256Hex(state)}`,
      },
    ]);
    expect(h.stripe.callsOf("accounts.retrieve").map((call) => call.id)).toEqual([ACCOUNT]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      actorType: "account",
      actorAccountId: OWNER,
      action: "payments.connect_connected",
      targetType: "payment_connection",
      targetId: TEST_ROW,
      tenantId: TENANT,
    });
    expect(JSON.parse(h.audit[0]?.detailsJson ?? "{}")).toEqual({
      environment: "test",
      before: { accountMode: "velexis", accountReference: null, status: "active" },
      after: {
        accountMode: "connect_standard",
        accountReference: ACCOUNT,
        status: "active",
        capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
      },
    });
    expect(h.events).toEqual([{ v: 1, type: "connection", tenantId: TENANT }]);
    // No token, code or state in the rows, the audit, the answer or a log line.
    const everything = JSON.stringify([completed, [...h.rows.values()], h.audit, h.warnings]);
    for (const secret of [tokens.accessToken, tokens.refreshToken, tokens.publishableKey, CODE, state]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("[PBE-055] switches the live connection too when the OTA is live, and inserts a connection that is missing", async () => {
    const h = new Harness();
    h.tenant = { status: "active", storefront_environment: "live" };
    h.rows.set(
      "test",
      rowOf("test", {
        account_mode: "api_keys",
        account_reference: "acct_1QOldKeys",
        publishable_key: "pk_test_old",
        encryption_key_id: "kek_1",
      }),
    );
    h.stripe.put({
      id: ACCOUNT,
      object: "account",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
    } as never);
    h.granted();
    const state = await h.started();

    const completed = await h.service.complete(OWNER, { state, code: CODE });

    expect(
      completed.connections.map((row) => [
        row.environment,
        row.account_mode,
        row.account_reference,
        row.status,
        row.publishable_key,
        row.encryption_key_id,
        row.statement_descriptor_suffix,
      ]),
    ).toEqual([
      ["test", "connect_standard", ACCOUNT, "pending", null, null, "AGENCY TRAVEL"],
      ["live", "connect_standard", ACCOUNT, "pending", null, null, "AGENCY TRAVEL"],
    ]);
    expect(completed.connections[1]?.id).toMatch(/^ppc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      h.audit.map((row) => [row.targetId, JSON.parse(row.detailsJson) as Record<string, unknown>]),
    ).toEqual([
      [
        TEST_ROW,
        expect.objectContaining({
          environment: "test",
          before: { accountMode: "api_keys", accountReference: "acct_1QOldKeys", status: "active" },
        }),
      ],
      [completed.connections[1]?.id, expect.not.objectContaining({ before: expect.anything() as unknown })],
    ]);
    expect(h.events).toEqual([{ v: 1, type: "connection", tenantId: TENANT }]);
  });

  it("[PBE-055] answers a code Stripe refuses 422 oauth_error and Stripe's failures 502 PROVIDER_ERROR, never with Stripe's message", async () => {
    const h = new Harness();

    // Never granted: Stripe's invalid_grant, whose description names the code.
    let state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "oauth_error" },
    });
    state = await h.started();
    const cause = await causeOf(() => h.service.complete(OWNER, { state, code: CODE }));
    expect(cause).toBeInstanceOf(StripeConnectFailure);
    expect(String((cause as Error).message)).not.toContain(CODE);

    h.stripe.failNext("oauth.token", FakeStripe.apiError(503));
    h.granted();
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "PROVIDER_ERROR",
      details: { provider: "stripe" },
    });
    h.stripe.failNext("accounts.retrieve", FakeStripe.connectionError());
    h.granted();
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "PROVIDER_ERROR",
      details: { provider: "stripe" },
    });
    h.stripe.notConfigured();
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "PROVIDER_ERROR",
      details: { provider: "stripe" },
    });
    expect([h.rows.get("test")?.account_mode, h.audit, h.events]).toEqual(["velexis", [], []]);
  });

  it("[FIX-W36-PLATFORM AC3] answers 409 CONFLICT connection_disabled for a connection an admin disabled, before Stripe, and writes nothing", async () => {
    const h = new Harness();
    h.tenant = { status: "active", storefront_environment: "live" };
    const disabled = { status: "disabled", disconnected_at: null };
    for (const environment of ["test", "live"] as const) {
      h.rows.set("test", rowOf("test"));
      h.rows.delete("live");
      h.rows.set(environment, rowOf(environment, disabled));
      h.granted();
      const before = structuredClone([...h.rows]);
      const state = await h.started();

      expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE })), environment).toEqual({
        code: "CONFLICT",
        details: { reason: "connection_disabled" },
      });
      // A declined callback for it answers the same: nothing to connect while an admin keeps it off.
      const declined = await h.started();
      expect(
        await outcome(() => h.service.complete(OWNER, { state: declined, error: "access_denied" })),
        environment,
      ).toEqual({ code: "CONFLICT", details: { reason: "connection_disabled" } });
      expect([...h.rows], environment).toEqual(before);
    }
    expect(h.stripe.calls).toEqual([]);
    expect([h.audit, h.events]).toEqual([[], []]);

    // A connection disabled because the OTA disconnected Velexis in Stripe (disconnected_at) connects again.
    h.rows.set(
      "test",
      rowOf("test", { status: "disabled", disconnected_at: new Date("2026-10-20T08:00:00Z") }),
    );
    h.rows.delete("live");
    h.tenant = { status: "active", storefront_environment: "test" };
    const state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({ code: "ok" });
    expect(h.rows.get("test")).toMatchObject({
      account_mode: "connect_standard",
      status: "active",
      disconnected_at: null,
    });
  });

  it("[FIX-W36-PLATFORM AC3] answers 409 connection_disabled when an admin disables the connection during the exchange, and rolls back", async () => {
    const h = new Harness();
    h.granted();
    const state = await h.started();
    h.beforeSwitch = (trx) => {
      const row = trx.rows.get("test");
      if (row !== undefined) {
        trx.rows.set("test", { ...row, status: "disabled" });
      }
    };

    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "CONFLICT",
      details: { reason: "connection_disabled" },
    });
    // The transaction rolled back: the stored row is the one before, no audit row, no event.
    expect(h.rows.get("test")).toEqual(rowOf("test"));
    expect([h.audit, h.events]).toEqual([[], []]);
  });

  it("[FIX-W36-PLATFORM AC3] deauthorises the account of a code of the other mode before answering livemode_mismatch, best effort", async () => {
    const h = new Harness();
    const tokens = h.granted(true);
    let state = await h.started();

    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "livemode_mismatch" },
    });
    expect(h.stripe.callsOf("oauth.deauthorize")).toEqual([
      {
        method: "oauth.deauthorize",
        id: undefined,
        params: { client_id: CLIENT_ID, stripe_user_id: ACCOUNT },
        idempotencyKey: `connect_deauthorize:${sha256Hex(state)}`,
      },
    ]);
    expect(h.stripe.deauthorized).toEqual([ACCOUNT]);
    expect(h.infos).toEqual([
      { object: { tenantId: TENANT, stripeAccount: ACCOUNT }, message: "stripe_connect.deauthorized" },
    ]);
    // The exchange comes first, the deauthorisation after it; the account is never read and nothing is written.
    expect(h.stripe.calls.map((call) => call.method)).toEqual(["oauth.token", "oauth.deauthorize"]);
    expect([h.rows.get("test")?.account_mode, h.audit, h.events]).toEqual(["velexis", [], []]);

    // A failed deauthorisation is logged (Stripe's type, status and code only) and the answer stays the same.
    h.stripe.failNext("oauth.deauthorize", FakeStripe.apiError(400, "invalid_client"));
    h.granted(true);
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "livemode_mismatch" },
    });
    expect(h.warnings).toEqual([
      {
        object: {
          tenantId: TENANT,
          stripeAccount: ACCOUNT,
          failure: "invalid_request_error 400 (invalid_client)",
        },
        message: "stripe_connect.deauthorize_failed",
      },
    ]);
    const logged = JSON.stringify([h.warnings, h.infos]);
    for (const secret of [tokens.accessToken, tokens.refreshToken, tokens.publishableKey, CODE, state]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain("Fake Stripe answered");
  });

  it("[FIX-W36-PLATFORM AC3] leaves connected an account of the other mode that an OTA's connection holds", async () => {
    const h = new Harness();
    // Another OTA holds the account: deauthorising it would cut that OTA off.
    h.elsewhere.set(ACCOUNT, OTHER_TENANT);
    h.granted(true);
    let state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "livemode_mismatch" },
    });
    // This OTA's own connection holds it.
    h.elsewhere.clear();
    h.rows.set("test", rowOf("test", { account_mode: "connect_standard", account_reference: ACCOUNT }));
    h.granted(true);
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "livemode_mismatch" },
    });
    // Who holds it cannot be read: it is left connected too.
    h.rows.set("test", rowOf("test"));
    h.elsewhereDown = new Error("Connection terminated unexpectedly");
    h.granted(true);
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "livemode_mismatch" },
    });

    expect(h.stripe.callsOf("oauth.deauthorize")).toEqual([]);
    expect(h.warnings.map((warning) => [warning.message, warning.object["failure"]])).toEqual([
      ["stripe_connect.deauthorize_skipped", undefined],
      ["stripe_connect.deauthorize_skipped", undefined],
      ["stripe_connect.deauthorize_skipped", "Error"],
    ]);
  });

  it("[FIX-W37-PLATFORM AC1] deauthorises an account of the other mode that only connections a Stripe deauthorisation disabled name", async () => {
    const h = new Harness();
    // This OTA's own connection named the account until the OTA deauthorised Velexis in Stripe (disconnected_at).
    const deauthorized = rowOf("test", {
      account_mode: "connect_standard",
      account_reference: ACCOUNT,
      status: "disabled",
      disconnected_at: new Date("2026-10-20T08:00:00Z"),
    });
    h.rows.set("test", deauthorized);
    h.granted(true);
    let state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "livemode_mismatch" },
    });
    // Nothing is written: the deauthorised row stays as it was, and there is no audit row or event.
    expect([h.rows.get("test"), h.audit, h.events]).toEqual([deauthorized, [], []]);
    // Another OTA's connections name it, all of them deauthorised in Stripe.
    h.rows.set("test", rowOf("test"));
    h.elsewhere.set(ACCOUNT, OTHER_TENANT);
    h.elsewhereDeauthorized.add(ACCOUNT);
    h.granted(true);
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "livemode_mismatch" },
    });

    expect(h.stripe.callsOf("oauth.deauthorize").map((call) => call.params)).toEqual([
      { client_id: CLIENT_ID, stripe_user_id: ACCOUNT },
      { client_id: CLIENT_ID, stripe_user_id: ACCOUNT },
    ]);
    expect(h.warnings).toEqual([]);
    expect(h.infos.map((info) => info.message)).toEqual([
      "stripe_connect.deauthorized",
      "stripe_connect.deauthorized",
    ]);

    // Once another OTA's connection is still connected (disconnected_at empty), the account is left connected again.
    h.elsewhereDeauthorized.clear();
    h.granted(true);
    state = await h.started();
    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "livemode_mismatch" },
    });
    expect(h.stripe.callsOf("oauth.deauthorize")).toHaveLength(2);
    expect(h.warnings).toEqual([
      { object: { tenantId: TENANT, stripeAccount: ACCOUNT }, message: "stripe_connect.deauthorize_skipped" },
    ]);
  });

  it("[FIX-W36-PLATFORM AC3] answers invalid_grant from oauth.token 422 oauth_error, whatever Stripe's description says", async () => {
    const h = new Harness();
    h.granted();
    h.stripe.failNext(
      "oauth.token",
      new Stripe.errors.StripeInvalidGrantError({
        type: "invalid_grant",
        message: `This authorization code has expired: ${CODE}`,
        statusCode: 400,
      }),
    );
    const state = await h.started();

    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "UNPROCESSABLE",
      details: { reason: "oauth_error" },
    });
    expect(h.stripe.callsOf("oauth.deauthorize")).toEqual([]);
    expect(h.stripe.callsOf("accounts.retrieve")).toEqual([]);
    expect([h.rows.get("test")?.account_mode, h.audit, h.events]).toEqual(["velexis", [], []]);
  });

  it("[PBE-055] answers 503 SERVICE_UNAVAILABLE while Redis is down, before anything else", async () => {
    const h = new Harness();
    const state = await h.started();
    h.redisDown = new Error("Connection is closed.");

    expect(await outcome(() => h.service.complete(OWNER, { state, code: CODE }))).toEqual({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(h.stripe.calls).toEqual([]);
  });
});
