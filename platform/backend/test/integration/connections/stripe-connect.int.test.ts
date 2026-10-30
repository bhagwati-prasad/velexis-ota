// Stripe Connect Standard OAuth (PBE-055; platform/docs/flows/stripe-payments-account.md §C and "Failure handling",
// PADR-0011 item 2, api-inventory-resources.md §4, scope PF-61 AC1) through the HTTP pipeline (createTestApp) on this
// file's database clone and this worker's Redis database, with the FakeStripe of test/support in place of the Stripe
// client (nothing reaches Stripe):
//
// - `startStripeConnect`: owners and admins with a TOTP step-up while `FEATURE_OWN_STRIPE` is on get Stripe's authorize
//   URL (`no-store`), whose state is stored in Redis only under its SHA-256 for 10 minutes with the account that
//   started it; the guards answer the other roles, a missing step-up, an account without MFA and the switch off;
// - `completeStripeConnect`: the state works once and only for the account that started it; a declined authorisation
//   changes nothing; the code is exchanged once; a code of the other mode answers `livemode_mismatch` (a test-mode code
//   in a live deployment too: the last describe starts the API with `APP_ENV=production`); an account another OTA holds
//   answers `409`; the test connection (and the live one of a live OTA) becomes `connect_standard` with the `acct_…`,
//   the capabilities and no key or secret, audited, and `vx:invalidate {type: "connection"}` follows the commit.
//
// The milestone switch is a stand-in this file turns on (as payout-accounts.int.test.ts does). Every answer is checked
// against the platform document. The application logs at `trace`, so "no code, state or OAuth token in a log line",
// checked after every test, covers every level. The Stripe settings are the development values of `.env.example`
// (`sk_live_dummy` for the live deployment, as config.test.ts uses it): the FakeStripe needs no key.
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURE_VARIABLES,
  FeatureSwitches,
  FEATURES,
  featuresFor,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import {
  insertAccount,
  insertPaymentConnection,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertOta, type OtaOptions } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";
import { FakeStripe } from "../../support/fake-stripe";

/** Starting the API (database clone, Nest module graph, Ajv compilation of the document) takes seconds on CI. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for an event on `vx:invalidate` (delivered within milliseconds when it is sent). */
const EVENT_WAIT_MS = 2_000;
const FAMILY = testId("asn", 55);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.55";
/** The Stripe settings of the application: the development values of `.env.example`. */
const STRIPE_ENV = Object.freeze({
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_CONNECT_CLIENT_ID: "ca_replace_me",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_replace_me",
});
/** A stand-in ciphertext of an API-key connection's secrets: bytes the switch must clear, not a real envelope. */
const OLD_CIPHERTEXT = Buffer.from("stand-in ciphertext of an earlier api_keys connection");

/** The milestone switches of this application: `own_stripe` on unless a test turns it off. */
class TestSwitches {
  readonly on = new Set<Feature>();

  isEnabled(feature: Feature): boolean {
    return this.on.has(feature);
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(
        FEATURES.map((feature) => [FEATURE_VARIABLES[feature], this.on.has(feature)]),
      ) as FeatureConfig,
    );
  }
}

type Who = TenantRole | "ownerWithoutMfa" | "stranger";

/** An OTA with a member of every role (owner and admin with MFA), an owner without MFA, a stranger, and its test row. */
interface Fixture {
  readonly tenant: PlatformRow<"tenants">;
  readonly people: ReadonlyMap<Who, PlatformRow<"accounts">>;
  readonly connection: PlatformRow<"payment_provider_connections">;
}

/** Every code, state and OAuth token of this file: none may reach a log line. */
const secrets: string[] = [];

/** A Stripe account id of this file, unique per call (`acct_` and letters and digits). */
let accounts = 0;
const newAccountId = (): string => {
  accounts += 1;
  return `acct_1QTestPbe055Agency${accounts}`;
};

/** An authorisation code of this file, unique per call. */
let codes = 0;
const newCode = (): string => {
  codes += 1;
  return `ac_TestPbe055Code${codes}`;
};

/** One application of a describe block and the helpers bound to it. */
class Harness {
  t!: TestApp;
  pool!: PlatformPool;
  tokens!: TokenService;
  readonly stripe = new FakeStripe();
  readonly switches = new TestSwitches();
  private subscriber: Redis | undefined;
  private redis: Redis | undefined;
  readonly events: InvalidationEvent[] = [];

  async boot(env: Readonly<Record<string, string>>): Promise<void> {
    // Every line at every level is captured, so "no log line holds a code" covers the debug and trace lines too.
    this.t = await createTestApp({
      env: { LOG_LEVEL: "trace", ...env },
      overrides: [
        { provide: FeatureSwitches, useValue: this.switches },
        { provide: StripeClient, useValue: this.stripe },
      ],
    });
    this.pool = this.t.app.get<PlatformPool>(PLATFORM_POOL);
    this.tokens = this.t.app.get(TokenService);
    this.redis = new Redis(this.t.redis.url, { lazyConnect: true });
    await this.redis.connect();
    this.subscriber = new Redis(this.t.redis.url, { lazyConnect: true });
    this.subscriber.on("message", (_channel: string, message: string) => {
      this.events.push(JSON.parse(message) as InvalidationEvent);
    });
    await this.subscriber.connect();
    await this.subscriber.subscribe(INVALIDATION_CHANNEL);
  }

  async close(): Promise<void> {
    await this.subscriber?.quit();
    await this.redis?.quit();
    await this.t?.close();
  }

  /** The Redis client of the test (the application's database). */
  get keys(): Redis {
    if (this.redis === undefined) {
      throw new Error("the harness has not started");
    }
    return this.redis;
  }

  async fixture(options: OtaOptions = {}): Promise<Fixture> {
    const ota = await insertOta(this.pool, options);
    const people = new Map<Who, PlatformRow<"accounts">>();
    for (const role of TENANT_ROLES) {
      const account = await insertAccount(
        this.pool,
        role === "owner" || role === "admin" ? { mfa_enabled: true } : {},
      );
      await insertMember(this.pool, ota.tenant, account, role);
      people.set(role, account);
    }
    const ownerWithoutMfa = await insertAccount(this.pool);
    await insertMember(this.pool, ota.tenant, ownerWithoutMfa, "owner");
    people.set("ownerWithoutMfa", ownerWithoutMfa);
    people.set("stranger", await insertAccount(this.pool, { mfa_enabled: true }));
    const connection = await insertPaymentConnection(this.pool, ota.tenant, {
      statement_descriptor_suffix: "AGENCY TRAVEL",
    });
    return { tenant: ota.tenant, people, connection };
  }

  /** The headers of a portal call by `who`, with a TOTP step-up now unless `stepUp` is false. */
  async portal(f: Fixture, who: Who, stepUp = true): Promise<Record<string, string>> {
    const nowSeconds = Math.floor(this.t.clock.now().getTime() / 1000);
    const { token } = await this.tokens.sign({
      aud: "portal",
      sub: person(f, who).id,
      sid: FAMILY,
      ev: true,
      amr: stepUp ? ["pwd", "otp"] : ["pwd"],
      ...(stepUp ? { mfa_at: nowSeconds } : {}),
    });
    return { Authorization: `Bearer ${token}`, ...this.t.bffHeaders(PERSON_IP) };
  }

  /** `startStripeConnect` by `who`. */
  async start(f: Fixture, who: Who = "owner", stepUp = true): Promise<Response> {
    return this.t.http
      .post(`/v1/tenants/${f.tenant.id}/payment-connections/stripe-connect/start`)
      .set(await this.portal(f, who, stepUp))
      .send();
  }

  /** `startStripeConnect` by `who`, which must succeed, and the state of its authorize URL. */
  async started(f: Fixture, who: Who = "owner"): Promise<string> {
    const res = await this.start(f, who);
    expect(res.status).toBe(200);
    const state =
      new URL((res.body as { authorizeUrl: string }).authorizeUrl).searchParams.get("state") ?? "";
    secrets.push(state);
    return state;
  }

  /** `completeStripeConnect` by `who` with `body`. */
  async complete(f: Fixture, who: Who, body: Record<string, unknown>): Promise<Response> {
    return this.t.http
      .post("/v1/payment-connections/stripe-connect/callback")
      .set(await this.portal(f, who, false))
      .send(body);
  }

  /** A code Stripe exchanges for `stripeUserId` in `livemode`, its tokens kept for the log check. */
  grant(stripeUserId: string, livemode = false): string {
    const code = newCode();
    const tokens = this.stripe.grantConnectCode(code, { stripeUserId, livemode });
    secrets.push(code, tokens.accessToken, tokens.refreshToken, tokens.publishableKey);
    return code;
  }

  /** Puts the connected account Stripe answers for `accounts.retrieve`. */
  account(id: string, chargesEnabled = true): void {
    this.stripe.put({
      id,
      object: "account",
      charges_enabled: chargesEnabled,
      payouts_enabled: chargesEnabled,
      details_submitted: true,
    } as never);
  }

  async connections(tenantId: string): Promise<Array<PlatformRow<"payment_provider_connections">>> {
    const { rows } = await this.pool.query(
      "SELECT * FROM platform.payment_provider_connections WHERE tenant_id = $1 ORDER BY environment = 'live', id",
      [tenantId],
    );
    return rows as Array<PlatformRow<"payment_provider_connections">>;
  }

  async audit(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(
      "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = 'payments.connect_connected' ORDER BY id",
      [tenantId],
    );
    return rows as Array<Record<string, unknown>>;
  }

  /** Waits for `{type: "connection", tenantId}` on `vx:invalidate`. */
  async connectionEvent(tenantId: string): Promise<void> {
    await vi.waitFor(
      () => {
        expect(this.events).toContainEqual({ v: 1, type: "connection", tenantId });
      },
      { timeout: EVENT_WAIT_MS },
    );
  }
}

function person(f: Fixture, who: Who): PlatformRow<"accounts"> {
  const account = f.people.get(who);
  if (account === undefined) {
    throw new Error(`no ${who} in the fixture`);
  }
  return account;
}

function errorOf(res: Response): { code: string; details?: Record<string, unknown> } {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

const outcomeOf = (res: Response): string =>
  res.status < 400 ? String(res.status) : `${res.status} ${errorOf(res).code}`;

/** Asserts that no log line of `h`'s application holds a code, a state or an OAuth token of this file. */
function expectNoSecretLogged(h: Harness): void {
  const logged = (h.t?.logs.lines ?? []).map((line) => JSON.stringify(line)).join("\n");
  for (const secret of secrets) {
    expect(logged).not.toContain(secret);
  }
}

describe("Stripe Connect Standard in a test deployment", () => {
  const h = new Harness();

  beforeAll(async () => {
    await h.boot(STRIPE_ENV);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await h.close();
  }, SETUP_TIMEOUT_MS);

  beforeEach(() => {
    h.switches.on.add("own_stripe");
  });

  afterEach(() => {
    h.switches.on.clear();
    // After every test, not only the ones that look: no line logged so far, at any level, holds a secret.
    expectNoSecretLogged(h);
  });

  it("[PBE-055 AC1] connects the OTA's account: a no-store authorize URL, then one exchange of the code and the switch", async () => {
    const f = await h.fixture();
    const owner = person(f, "owner");
    const accountId = newAccountId();
    h.account(accountId);
    const code = h.grant(accountId);

    const start = await h.start(f);

    expect(outcomeOf(start)).toBe("200");
    expectResponseToMatch("startStripeConnect", start, { document: "platform" });
    expect(start.headers["cache-control"]).toBe("no-store");
    const answer = start.body as { authorizeUrl: string; expiresAt: string };
    const url = new URL(answer.authorizeUrl);
    const state = url.searchParams.get("state") ?? "";
    secrets.push(state);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "ca_replace_me",
      scope: "read_write",
      state,
      redirect_uri: `${h.t.config.PUBLIC_PORTAL_URL.replace(/\/+$/, "")}/connect/stripe/callback`,
      "stripe_user[email]": owner.email,
    });
    expect(answer.expiresAt).toBe(new Date(h.t.clock.now().getTime() + 600_000).toISOString());
    // Redis holds the state's digest and the account that started it, for 10 minutes; never the state.
    const key = `stripe:oauth:${sha256Hex(state)}`;
    expect(JSON.parse((await h.keys.get(key)) ?? "null")).toEqual({
      tenantId: f.tenant.id,
      accountId: owner.id,
      membershipId: expect.stringMatching(/^stf_/) as string,
    });
    expect(await h.keys.ttl(key)).toBeGreaterThan(590);
    expect(await h.keys.keys(`*${state}*`)).toEqual([]);

    const res = await h.complete(f, "owner", { state, code });

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("completeStripeConnect", res, { document: "platform" });
    expect(res.body).toEqual({
      tenantId: f.tenant.id,
      connections: [
        expect.objectContaining({
          id: f.connection.id,
          environment: "test",
          accountMode: "connect_standard",
          status: "active",
          accountReference: accountId,
          publishableKey: null,
          statementDescriptorSuffix: "AGENCY TRAVEL",
          capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
          connectedAt: h.t.clock.now().toISOString(),
          disconnectedAt: null,
          version: f.connection.version + 1,
        }),
      ],
    });
    expect(await h.keys.exists(key)).toBe(0);
    expect(h.stripe.callsOf("oauth.token")).toEqual([
      {
        method: "oauth.token",
        id: undefined,
        params: { grant_type: "authorization_code", code },
        idempotencyKey: `connect_oauth:${sha256Hex(state)}`,
      },
    ]);
    expect(h.stripe.callsOf("accounts.retrieve").map((call) => call.id)).toEqual([accountId]);
    const [row] = await h.connections(f.tenant.id);
    expect(row).toMatchObject({
      account_mode: "connect_standard",
      account_reference: accountId,
      status: "active",
      created_by_account_id: owner.id,
    });
    const audit = await h.audit(f.tenant.id);
    expect(audit).toEqual([
      expect.objectContaining({
        actor_type: "account",
        actor_account_id: owner.id,
        target_type: "payment_connection",
        target_id: f.connection.id,
      }),
    ]);
    expect(audit[0]?.["details"]).toEqual({
      environment: "test",
      before: { accountMode: "velexis", accountReference: null, status: "active" },
      after: {
        accountMode: "connect_standard",
        accountReference: accountId,
        status: "active",
        capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
      },
    });
    await h.connectionEvent(f.tenant.id);

    // The state is spent: the same callback again is refused, and Stripe is not asked again.
    const again = await h.complete(f, "owner", { state, code });
    expect(outcomeOf(again)).toBe("400 CONNECT_STATE_INVALID");
    expectResponseToMatch("completeStripeConnect", again, { document: "platform" });
    expect(h.stripe.callsOf("oauth.token")).toHaveLength(1);
    expect(await h.audit(f.tenant.id)).toHaveLength(1);
  });

  it("[PBE-055 AC1] binds the state to the account that started it: another owner or admin is refused, and the state is spent", async () => {
    const f = await h.fixture();
    const accountId = newAccountId();
    h.account(accountId);
    const code = h.grant(accountId);
    const state = await h.started(f, "admin");
    h.stripe.reset();

    for (const who of ["owner", "stranger"] as const) {
      const res = await h.complete(f, who, { state, code });
      expect([who, outcomeOf(res)]).toEqual([who, "400 CONNECT_STATE_INVALID"]);
      expectResponseToMatch("completeStripeConnect", res, { document: "platform" });
    }
    // The admin who started it comes too late: the first try spent it.
    expect(outcomeOf(await h.complete(f, "admin", { state, code }))).toBe("400 CONNECT_STATE_INVALID");
    expect(outcomeOf(await h.complete(f, "admin", { state: "UnknownStateOfSixteenPlus", code }))).toBe(
      "400 CONNECT_STATE_INVALID",
    );
    expect(h.stripe.calls).toEqual([]);
    expect((await h.connections(f.tenant.id)).map((row) => row.account_mode)).toEqual(["velexis"]);
    expect(await h.audit(f.tenant.id)).toEqual([]);
  });

  it("[PBE-055] lets only owners and admins start, with a step-up, an MFA account and the switch on, while the OTA is active", async () => {
    const f = await h.fixture();
    const statesBefore = (await h.keys.keys("stripe:oauth:*")).length;
    const outcomes: Array<[string, string]> = [];
    for (const who of [...TENANT_ROLES, "stranger"] as const) {
      const res = await h.start(f, who);
      expectResponseToMatch("startStripeConnect", res, { document: "platform" });
      outcomes.push([who, outcomeOf(res)]);
    }
    expect(outcomes).toEqual([
      ["owner", "200"],
      ["admin", "200"],
      ["agent", "403 FORBIDDEN"],
      ["finance", "403 FORBIDDEN"],
      ["viewer", "403 FORBIDDEN"],
      ["stranger", "404 NOT_FOUND"],
    ]);
    expect(outcomeOf(await h.start(f, "owner", false))).toBe("401 REAUTH_REQUIRED");
    expect(outcomeOf(await h.start(f, "ownerWithoutMfa"))).toBe("403 MFA_REQUIRED");
    h.switches.on.delete("own_stripe");
    const off = await h.start(f);
    expect([outcomeOf(off), errorOf(off).details]).toEqual([
      "403 FEATURE_DISABLED",
      { feature: "own_stripe" },
    ]);
    h.switches.on.add("own_stripe");
    await h.pool.query(
      "UPDATE platform.tenants SET status = 'suspended', suspended_at = now() WHERE id = $1",
      [f.tenant.id],
    );
    const suspended = await h.start(f);
    expect([outcomeOf(suspended), errorOf(suspended).details]).toEqual([
      "409 TENANT_NOT_ACTIVE",
      { status: "suspended" },
    ]);
    expectResponseToMatch("startStripeConnect", suspended, { document: "platform" });
    // Only the two successful starts stored a state.
    expect(await h.keys.keys("stripe:oauth:*")).toHaveLength(statesBefore + 2);
  });

  it("[PBE-055] changes nothing for a declined authorisation or a starter who lost the role, and refuses a suspended OTA", async () => {
    const f = await h.fixture();
    const accountId = newAccountId();
    h.stripe.reset();

    const declined = await h.complete(f, "owner", {
      state: await h.started(f),
      error: "access_denied",
      errorDescription: "The user denied your request",
    });
    expect([outcomeOf(declined), errorOf(declined).details]).toEqual([
      "422 UNPROCESSABLE",
      { reason: "access_denied" },
    ]);
    expectResponseToMatch("completeStripeConnect", declined, { document: "platform" });
    const otherError = await h.complete(f, "owner", { state: await h.started(f), error: "invalid_scope" });
    expect(errorOf(otherError).details).toEqual({ reason: "oauth_error" });

    const state = await h.started(f, "admin");
    await h.pool.query(
      "UPDATE platform.tenant_memberships SET role = 'agent' WHERE tenant_id = $1 AND account_id = $2",
      [f.tenant.id, person(f, "admin").id],
    );
    const demoted = await h.complete(f, "admin", { state, code: h.grant(accountId) });
    expect(outcomeOf(demoted)).toBe("403 FORBIDDEN");
    expectResponseToMatch("completeStripeConnect", demoted, { document: "platform" });

    const beforeSuspension = await h.started(f);
    await h.pool.query(
      "UPDATE platform.tenants SET status = 'suspended', suspended_at = now() WHERE id = $1",
      [f.tenant.id],
    );
    const suspended = await h.complete(f, "owner", { state: beforeSuspension, code: h.grant(accountId) });
    expect([outcomeOf(suspended), errorOf(suspended).details]).toEqual([
      "409 TENANT_NOT_ACTIVE",
      { status: "suspended" },
    ]);
    expectResponseToMatch("completeStripeConnect", suspended, { document: "platform" });

    expect(h.stripe.calls).toEqual([]);
    expect((await h.connections(f.tenant.id)).map((row) => row.account_mode)).toEqual(["velexis"]);
    expect(await h.audit(f.tenant.id)).toEqual([]);
  });

  it("[PBE-055 AC2] answers a live-mode code in a test deployment 422 livemode_mismatch and an acct_ of another OTA 409", async () => {
    const other = await h.fixture();
    const f = await h.fixture();
    const taken = newAccountId();
    h.account(taken);
    expect(
      outcomeOf(await h.complete(other, "owner", { state: await h.started(other), code: h.grant(taken) })),
    ).toBe("200");
    h.stripe.reset();

    const mismatch = await h.complete(f, "owner", {
      state: await h.started(f),
      code: h.grant(newAccountId(), true),
    });
    expect([outcomeOf(mismatch), errorOf(mismatch).details]).toEqual([
      "422 UNPROCESSABLE",
      { reason: "livemode_mismatch" },
    ]);
    expectResponseToMatch("completeStripeConnect", mismatch, { document: "platform" });

    const duplicate = await h.complete(f, "owner", { state: await h.started(f), code: h.grant(taken) });
    expect(outcomeOf(duplicate)).toBe("409 STRIPE_ACCOUNT_ALREADY_CONNECTED");
    expectResponseToMatch("completeStripeConnect", duplicate, { document: "platform" });

    // Neither read the account; nothing changed for the second OTA, and the first keeps its account.
    expect(h.stripe.callsOf("accounts.retrieve")).toEqual([]);
    expect((await h.connections(f.tenant.id)).map((row) => row.account_mode)).toEqual(["velexis"]);
    expect(await h.audit(f.tenant.id)).toEqual([]);
    expect((await h.connections(other.tenant.id)).map((row) => row.account_reference)).toEqual([taken]);

    // A code Stripe refuses (unknown, expired or used) answers oauth_error, without Stripe's message.
    const refused = await h.complete(f, "owner", {
      state: await h.started(f),
      code: "ac_TestPbe055NeverGranted",
    });
    expect([outcomeOf(refused), errorOf(refused).details]).toEqual([
      "422 UNPROCESSABLE",
      { reason: "oauth_error" },
    ]);
    expect(JSON.stringify(refused.body)).not.toContain("ac_TestPbe055NeverGranted");
    secrets.push("ac_TestPbe055NeverGranted");
  });

  it("[PBE-055 AC3] leaves no Stripe token or secret on the rows, and switches the live connection of a live OTA too", async () => {
    const f = await h.fixture({
      tenant: { storefront_environment: "live", live_enabled_at: new Date("2026-10-20T09:00:00Z") },
    });
    // The test connection was in API-key mode with its secrets; the live one in Velexis mode.
    await h.pool.query(
      "UPDATE platform.payment_provider_connections SET account_mode = 'api_keys', account_reference = 'acct_1QTestPbe055OldKeys', " +
        "publishable_key = 'pk_test_TestPbe055OldKeys', secret_ciphertext = $2, webhook_secret_ciphertext = $2, " +
        "encryption_key_id = 'kek_test_1' WHERE id = $1",
      [f.connection.id, OLD_CIPHERTEXT],
    );
    const live = await insertPaymentConnection(h.pool, f.tenant, { environment: "live" });
    const accountId = newAccountId();
    // Charges are not enabled yet: both rows wait in `pending` for `account.updated`.
    h.account(accountId, false);
    const code = h.grant(accountId);

    const res = await h.complete(f, "admin", { state: await h.started(f, "admin"), code });

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("completeStripeConnect", res, { document: "platform" });
    const rows = await h.connections(f.tenant.id);
    expect(
      rows.map((row) => [
        row.id,
        row.account_mode,
        row.account_reference,
        row.status,
        row.publishable_key,
        row.secret_ciphertext,
        row.webhook_secret_ciphertext,
        row.encryption_key_id,
        row.capabilities,
      ]),
    ).toEqual(
      [f.connection.id, live.id].map((id) => [
        id,
        "connect_standard",
        accountId,
        "pending",
        null,
        null,
        null,
        null,
        { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true },
      ]),
    );
    expect((res.body as { connections: Array<{ id: string; status: string }> }).connections).toEqual([
      expect.objectContaining({ id: f.connection.id, environment: "test", status: "pending" }),
      expect.objectContaining({ id: live.id, environment: "live", status: "pending" }),
    ]);
    expect(
      (await h.audit(f.tenant.id)).map((row) => [
        row["target_id"],
        (row["details"] as { environment: string }).environment,
      ]),
    ).toEqual([
      [f.connection.id, "test"],
      [live.id, "live"],
    ]);
    // No OAuth token, code or state anywhere in the OTA's connections, its audit rows or the answer.
    const stored = JSON.stringify([rows, await h.audit(f.tenant.id), res.body]);
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
    }
    await h.connectionEvent(f.tenant.id);
  });

  it("[PBE-055] inserts the live connection of a live OTA that has none, in connect_standard mode", async () => {
    const f = await h.fixture({
      tenant: { storefront_environment: "live", live_enabled_at: new Date("2026-10-20T09:00:00Z") },
    });
    const accountId = newAccountId();
    h.account(accountId);
    const owner = person(f, "owner");

    const res = await h.complete(f, "owner", { state: await h.started(f), code: h.grant(accountId) });

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("completeStripeConnect", res, { document: "platform" });
    const rows = await h.connections(f.tenant.id);
    expect(rows).toHaveLength(2);
    const live = rows[1];
    expect(live).toMatchObject({
      tenant_id: f.tenant.id,
      provider: "stripe",
      environment: "live",
      account_mode: "connect_standard",
      account_reference: accountId,
      status: "active",
      capture_mode: "manual",
      is_default: true,
      publishable_key: null,
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      encryption_key_id: null,
      statement_descriptor_suffix: "AGENCY TRAVEL",
      capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
      connected_at: h.t.clock.now(),
      created_by_account_id: owner.id,
      version: 1,
    });
    expect(live?.id).toMatch(/^ppc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((res.body as { connections: Array<{ id: string }> }).connections.map((c) => c.id)).toEqual([
      f.connection.id,
      live?.id,
    ]);
    // The inserted connection's audit row has no `before`.
    const audit = await h.audit(f.tenant.id);
    expect(audit.map((row) => row["target_id"])).toEqual([f.connection.id, live?.id]);
    expect(audit[1]?.["details"]).toEqual({
      environment: "live",
      after: {
        accountMode: "connect_standard",
        accountReference: accountId,
        status: "active",
        capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
      },
    });
    await h.connectionEvent(f.tenant.id);
  });
});

describe("Stripe Connect Standard in a live deployment (APP_ENV=production)", () => {
  const h = new Harness();

  beforeAll(async () => {
    await h.boot({ ...STRIPE_ENV, APP_ENV: "production", STRIPE_SECRET_KEY: "sk_live_dummy" });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await h.close();
  }, SETUP_TIMEOUT_MS);

  beforeEach(() => {
    h.switches.on.add("own_stripe");
  });

  afterEach(() => {
    h.switches.on.clear();
    expectNoSecretLogged(h);
  });

  it("[PBE-055 AC2] answers a test-mode code 422 livemode_mismatch and connects with a live-mode one", async () => {
    const f = await h.fixture();
    const accountId = newAccountId();
    h.account(accountId);

    const mismatch = await h.complete(f, "owner", {
      state: await h.started(f),
      code: h.grant(accountId, false),
    });

    expect([outcomeOf(mismatch), errorOf(mismatch).details]).toEqual([
      "422 UNPROCESSABLE",
      { reason: "livemode_mismatch" },
    ]);
    expectResponseToMatch("completeStripeConnect", mismatch, { document: "platform" });
    expect(h.stripe.callsOf("accounts.retrieve")).toEqual([]);
    expect((await h.connections(f.tenant.id)).map((row) => row.account_mode)).toEqual(["velexis"]);

    const connected = await h.complete(f, "owner", {
      state: await h.started(f),
      code: h.grant(accountId, true),
    });
    expect(outcomeOf(connected)).toBe("200");
    expect(
      (await h.connections(f.tenant.id)).map((row) => [row.account_mode, row.account_reference]),
    ).toEqual([["connect_standard", accountId]]);
  });
});
