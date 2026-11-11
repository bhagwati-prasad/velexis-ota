// Go-live and live API keys (PBE-061; platform/docs/api-inventory.md §7 `goLive`, api-inventory-resources.md §1,
// flows/stripe-payments-account.md §A item 2; scope PF-14 AC1 and AC2, PF-30 AC6) through the HTTP pipeline
// (createTestApp) on this file's database clone: the preconditions an OTA must meet (each one alone, all at once, the
// owner's MFA read again in the transaction), the switch itself (the tenant live with its new version, the live
// payment connection created from the test one or kept, the `tenant.went_live` audit row and the `tenant` and
// `connection` invalidations after the commit), an OTA that is live already, two go-lives at once, the refusals
// before the service (switch, step-up, role, membership, body) and of the service (tenant status), and the live API
// keys that go-live opens: behind the live switch, for a live OTA only, and a live secret key behind a recent step-up.
// Every answer is checked against the platform document.
//
// The milestone switches are a stand-in for FeatureSwitches whose `live_switch` a test can turn off, as
// live-office.int.test.ts does. Accounts, OTAs, plans, subscriptions, connections and payout accounts are written with
// the builders; tokens come from the application's TokenService at the FakeClock's time. Redis pub/sub is not scoped
// to a database index, so the subscriber keeps only the events of this file's OTAs; a marker event this file
// publishes itself closes the window in which a refusal must publish nothing (the API publishes after the commit and
// before it answers, and Redis delivers the messages of a channel in order).
import { randomUUID } from "node:crypto";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURES,
  FEATURE_VARIABLES,
  featuresFor,
  FeatureSwitches,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { GoLiveService } from "../../../src/provisioning/go-live.service";
import {
  insertAccount,
  insertPaymentConnection,
  insertPlan,
  insertRow,
  insertSupplierConnection,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  SEEDED_PLAN_CODE,
  testId,
  type PaymentConnectionRow,
  type PlatformRow,
  type SubscriptionRow,
} from "../../builders/platform-rows";
import { insertMember, insertOta, type InsertedOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** The database clone, the Nest module graph and the Ajv validators of the document take seconds on a loaded runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for an invalidation or a marker: pub/sub on the loopback interface takes milliseconds. */
const WAIT_MS = 10_000;
/** A documentation address (RFC 5737) of the people. */
const PERSON_IP = "203.0.113.61";
const FAMILY = testId("asn", 61);

/** The milestone switches of this application: `live_switch` on unless a test turns it off. */
class TestSwitches {
  readonly on = new Set<Feature>(["live_switch"]);

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

/** The Tenant of the platform document, as the tests read it. */
interface TenantBody {
  readonly id: string;
  readonly storefrontEnvironment: string;
  readonly liveEnabledAt: string | null;
  readonly version: number;
  readonly myRole: string;
}

/** An OTA of this file with its owner (MFA on), an admin and an agent. */
interface GoLiveOta extends InsertedOta {
  readonly owner: PlatformRow<"accounts">;
  readonly admin: PlatformRow<"accounts">;
  readonly agent: PlatformRow<"accounts">;
}

/** What an OTA of `readyOta` lacks or has instead of the ready state. */
interface ReadyOptions {
  /** The plan; a plan with live mode by default. */
  readonly planCode?: string;
  readonly tenant?: Partial<PlatformRow<"tenants">>;
  /** The subscription; a Stripe trial by default, `null` for none. */
  readonly subscription?: Partial<SubscriptionRow> | null;
  /** The live Amadeus connection's status; `active` by default, `null` for none. */
  readonly amadeusLive?: string | null;
  /** The test payment connection; `velexis`, `active` by default, `null` for none. */
  readonly testPayment?: Partial<PaymentConnectionRow> | null;
  /** A live payment connection; none by default. */
  readonly livePayment?: Partial<PaymentConnectionRow>;
  /** The payout account's review status; `verified` by default, `null` for none. */
  readonly payout?: string | null;
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;
let publisher: Redis;
/** A plan with live mode; the seeded `early_access` plan has none. */
let livePlan = "";
const switches = new TestSwitches();
/** The OTAs of this file: the subscriber keeps only their events (and this file's markers). */
const watched = new Set<string>();
const events: InvalidationEvent[] = [];
let stripeSubscriptions = 0;

beforeAll(async () => {
  // The database clone, the Nest module graph and the Ajv validators of the document are the expensive part;
  // SETUP_TIMEOUT_MS covers a loaded 4-CPU CI runner.
  t = await createTestApp({ overrides: [{ provide: FeatureSwitches, useValue: switches }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  livePlan = (
    await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: true } })
  ).code;

  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-go-live-events" });
  subscriber.on("message", (_channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent & { id?: string; tenantId?: string };
    if (watched.has(event.id ?? "") || watched.has(event.tenantId ?? "")) {
      events.push(event);
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
  publisher = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-go-live-markers" });
  await publisher.connect();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await publisher?.quit();
  await subscriber?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  switches.on.clear();
  switches.on.add("live_switch");
  events.length = 0;
});

// ---- Arrangement ---------------------------------------------------------------------------------------------------

/**
 * An active OTA that meets every precondition of go-live unless `options` says otherwise: on a plan with live mode, a
 * Stripe subscription in trial, an active live Amadeus connection, its test payments in `velexis` mode and a verified
 * payout account; with an owner (MFA on), an admin and an agent.
 */
async function readyOta(options: ReadyOptions = {}): Promise<GoLiveOta> {
  const owner = await insertAccount(pool, { mfa_enabled: true, full_name: "Olga Owner" });
  const admin = await insertAccount(pool, { mfa_enabled: true, full_name: "Ada Admin" });
  const agent = await insertAccount(pool);
  stripeSubscriptions += 1;
  const subscription =
    options.subscription === null
      ? undefined
      : {
          plan_code: options.planCode ?? livePlan,
          status: "trialing",
          billing_provider: "stripe",
          provider_subscription_id: `sub_golive${stripeSubscriptions}`,
          ...options.subscription,
        };
  const inserted = await insertOta(pool, {
    tenant: { plan_code: options.planCode ?? livePlan, ...options.tenant },
    ...(subscription === undefined ? {} : { subscription }),
    members: [
      [owner, "owner"],
      [admin, "admin"],
      [agent, "agent"],
    ],
  });
  const tenant = { id: inserted.tenant.id };
  watched.add(tenant.id);
  if (options.amadeusLive !== null) {
    await insertSupplierConnection(pool, tenant, {
      environment: "live",
      base_url: "https://travel.api.amadeus.com",
      status: options.amadeusLive ?? "active",
    });
  }
  if (options.testPayment !== null) {
    await insertPaymentConnection(pool, tenant, { ...options.testPayment, environment: "test" });
  }
  if (options.livePayment !== undefined) {
    await insertPaymentConnection(pool, tenant, { ...options.livePayment, environment: "live" });
  }
  if (options.payout !== null) {
    await insertRow(pool, "tenant_payout_accounts", {
      tenant_id: tenant.id,
      account_holder_name: "Acme Travel AS",
      country_code: "NO",
      currency: "EUR",
      scheme: "iban",
      bank_details_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
      encryption_key_id: PLACEHOLDER_KEK_ID,
      last4: "0189",
      status: options.payout ?? "verified",
    });
  }
  return { ...inserted, owner, admin, agent };
}

/** The columns of a live payment connection in `api_keys` mode (verified live keys, PBE-057). */
function liveApiKeys(n: number): Partial<PaymentConnectionRow> {
  return {
    account_mode: "api_keys",
    account_reference: `acct_1GoLiveKeys${n}`,
    publishable_key: `pk_live_GoLive${n}`,
    secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    webhook_secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    encryption_key_id: PLACEHOLDER_KEK_ID,
    statement_descriptor_suffix: null,
  };
}

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** `Authorization: Bearer` with a fresh portal token of `accountId`, at the FakeClock's time. */
async function bearer(
  accountId: string,
  input: Partial<AccessTokenInput> = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
    ...input,
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** A token of `accountId` with a TOTP step-up now. */
const steppedUp = (accountId: string) => bearer(accountId, { amr: ["pwd", "otp"], mfa_at: nowSeconds() });

/** `goLive` of `tenantId` with `headers` (the owner's, stepped up, by default), checked against the document. */
async function goLive(
  ota: GoLiveOta,
  headers?: Record<string, string>,
  body: unknown = { confirm: true },
): Promise<Response> {
  const res = await t.http
    .post(`/v1/tenants/${ota.tenant.id}/go-live`)
    .set(headers ?? (await steppedUp(ota.owner.id)))
    .send(body as object);
  expectResponseToMatch("goLive", res, { document: "platform" });
  return res;
}

function errorOf(res: { body: unknown }): { code: string; details?: Record<string, unknown> } {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

async function storedTenant(tenantId: string): Promise<PlatformRow<"tenants">> {
  const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]);
  return rows[0] as PlatformRow<"tenants">;
}

async function paymentsOf(tenantId: string): Promise<Array<PlatformRow<"payment_provider_connections">>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.payment_provider_connections WHERE tenant_id = $1 ORDER BY environment = 'live', id",
    [tenantId],
  );
  return rows as Array<PlatformRow<"payment_provider_connections">>;
}

async function auditOf(tenantId: string, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, action, target_type, target_id, tenant_id, details " +
      "FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id",
    [tenantId, action],
  );
  return rows as Array<Record<string, unknown>>;
}

/** Waits until the invalidation events `expected` have arrived (in any order, among others). */
async function invalidations(expected: readonly InvalidationEvent[]): Promise<void> {
  const has = (event: InvalidationEvent): boolean =>
    events.some((received) => JSON.stringify(received) === JSON.stringify(event));
  await expect
    .poll(() => expected.every(has), { timeout: WAIT_MS, interval: 20, message: "the invalidation events" })
    .toBe(true);
}

/**
 * The events of `tenantId` received so far, once a marker this file publishes has come back: every event the API
 * published before it answered has arrived by then.
 */
async function settledEventsOf(tenantId: string): Promise<InvalidationEvent[]> {
  const marker = `ten_marker_${randomUUID()}`;
  watched.add(marker);
  await publisher.publish(INVALIDATION_CHANNEL, JSON.stringify({ v: 1, type: "tenant", id: marker }));
  await expect
    .poll(() => events.some((event) => (event as { id?: string }).id === marker), {
      timeout: WAIT_MS,
      interval: 20,
      message: "the marker event",
    })
    .toBe(true);
  return events.filter(
    (event) =>
      (event as { id?: string }).id === tenantId || (event as { tenantId?: string }).tenantId === tenantId,
  );
}

// ---- The preconditions ---------------------------------------------------------------------------------------------

describe("goLive: the preconditions", () => {
  it("[PBE-061 AC1] lists every missing precondition in details.missing and changes nothing", async () => {
    // A plan without live mode, a manual trial, no live Amadeus connection, Velexis payments a platform admin
    // disabled and no payout account.
    const ota = await readyOta({
      planCode: SEEDED_PLAN_CODE,
      subscription: { billing_provider: "manual", provider_subscription_id: null },
      amadeusLive: null,
      testPayment: { status: "disabled" },
      payout: null,
    });

    const res = await goLive(ota);

    expect([res.status, errorOf(res).code]).toEqual([422, "LIVE_PRECONDITIONS_UNMET"]);
    expect(errorOf(res).details).toEqual({
      missing: ["amadeus_live", "payments_live", "payout_account", "plan_live_mode", "subscription"],
    });
    const tenant = await storedTenant(ota.tenant.id);
    expect([tenant.storefront_environment, tenant.live_enabled_at, tenant.version]).toEqual([
      "test",
      null,
      ota.tenant.version,
    ]);
    expect((await paymentsOf(ota.tenant.id)).map((row) => row.environment)).toEqual(["test"]);
    expect(await auditOf(ota.tenant.id, "tenant.went_live")).toEqual([]);
    expect(await settledEventsOf(ota.tenant.id)).toEqual([]);
  });

  it("[PBE-061 AC1] names each missing precondition on its own", async () => {
    const cases: Array<[ReadyOptions, string]> = [
      [{ amadeusLive: "pending_verification" }, "amadeus_live"],
      // Test API keys cannot take live payments, and there are no live keys.
      [{ testPayment: liveApiKeysAsTest(1) }, "payments_live"],
      // A connected account whose charges are not enabled yet.
      [
        {
          testPayment: {
            account_mode: "connect_standard",
            account_reference: "acct_1GoLivePending",
            status: "pending",
            statement_descriptor_suffix: null,
          },
        },
        "payments_live",
      ],
      [{ payout: "pending_review" }, "payout_account"],
      [{ payout: null }, "payout_account"],
      [{ planCode: SEEDED_PLAN_CODE }, "plan_live_mode"],
      [{ subscription: { status: "past_due" } }, "subscription"],
      [{ subscription: null }, "subscription"],
    ];
    for (const [options, missing] of cases) {
      const ota = await readyOta(options);

      const res = await goLive(ota);

      expect([missing, res.status, errorOf(res).code, errorOf(res).details]).toEqual([
        missing,
        422,
        "LIVE_PRECONDITIONS_UNMET",
        { missing: [missing] },
      ]);
      expect((await storedTenant(ota.tenant.id)).storefront_environment).toBe("test");
    }
  });

  it("[FIX-W40-PLATFORM AC3] accepts an active manual subscription, and still names a manual trial missing", async () => {
    // A manual trial (`trialing` on a manual row, no Stripe subscription) counts as no subscription.
    const trial = await readyOta({
      subscription: { billing_provider: "manual", status: "trialing", provider_subscription_id: null },
    });

    const refused = await goLive(trial);

    expect([refused.status, errorOf(refused).code, errorOf(refused).details]).toEqual([
      422,
      "LIVE_PRECONDITIONS_UNMET",
      { missing: ["subscription"] },
    ]);
    expect((await storedTenant(trial.tenant.id)).storefront_environment).toBe("test");
    expect(await auditOf(trial.tenant.id, "tenant.went_live")).toEqual([]);

    // An active manual subscription (a platform admin bills the OTA outside Stripe) meets the precondition.
    const manual = await readyOta({
      subscription: { billing_provider: "manual", status: "active", provider_subscription_id: null },
    });

    const switched = await goLive(manual);

    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    expect((switched.body as TenantBody).storefrontEnvironment).toBe("live");
    expect((await storedTenant(manual.tenant.id)).storefront_environment).toBe("live");
    expect(await auditOf(manual.tenant.id, "tenant.went_live")).toHaveLength(1);
    await invalidations([{ v: 1, type: "tenant", id: manual.tenant.id }]);
  });

  it("[FIX-W48-PLATFORM AC3] lets an OTA billed outside Stripe go live once a platform admin sets its manual subscription active", async () => {
    // The OTA's manual trial counts as no subscription until the admin marks it paid outside Stripe with
    // adminUpdateManualSubscription (`status: active`, a reason, `If-Match`; lead decision (15g) of 2026-11-11).
    const ota = await readyOta({
      subscription: { billing_provider: "manual", status: "trialing", provider_subscription_id: null },
    });
    const refused = await goLive(ota);
    expect([refused.status, errorOf(refused).details]).toEqual([422, { missing: ["subscription"] }]);

    const admin = await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true });
    const { token } = await tokens.sign({
      aud: "platform_admin",
      sub: admin.id,
      sid: FAMILY,
      ev: true,
      amr: ["pwd", "otp"],
    });
    const subscriptionId = ota.subscription?.id ?? "";
    const marked = await t.http
      .patch(`/v1/admin/subscriptions/${subscriptionId}`)
      .set({
        Authorization: `Bearer ${token}`,
        ...t.bffHeaders(PERSON_IP),
        "If-Match": `"${ota.subscription?.version ?? 1}"`,
      })
      .send({ status: "active", reason: "Billed by invoice outside Stripe, as agreed with the owner." });
    expectResponseToMatch("adminUpdateManualSubscription", marked, { document: "platform" });
    expect([marked.status, (marked.body as { status?: string; billingProvider?: string }).status]).toEqual([
      200,
      "active",
    ]);

    const switched = await goLive(ota);

    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    expect((await storedTenant(ota.tenant.id)).storefront_environment).toBe("live");
    expect(await auditOf(ota.tenant.id, "tenant.went_live")).toHaveLength(1);
  });

  it("[PBE-061 AC1] names mfa when the owner's MFA is off by the time the transaction reads it", async () => {
    // RecentMfaGuard refuses an account without MFA before the handler (`403 MFA_REQUIRED`, below); MFA turned off
    // between the guard and the transaction is read again there. The service is called as the handler calls it.
    const ota = await readyOta();
    await pool.query("UPDATE platform.accounts SET mfa_enabled = false WHERE id = $1", [ota.owner.id]);

    const refused = t.app.get(GoLiveService).goLive({
      membershipId: ota.memberships[0]?.id ?? "",
      tenantId: ota.tenant.id,
      accountId: ota.owner.id,
      role: "owner",
    });

    await expect(refused).rejects.toMatchObject({
      code: "LIVE_PRECONDITIONS_UNMET",
      details: { missing: ["mfa"] },
    });
    expect((await storedTenant(ota.tenant.id)).storefront_environment).toBe("test");
  });
});

/** A test payment connection in `api_keys` mode (the OTA's own test keys). */
function liveApiKeysAsTest(n: number): Partial<PaymentConnectionRow> {
  return {
    ...liveApiKeys(n),
    account_reference: `acct_1GoLiveTestKeys${n}`,
    publishable_key: `pk_test_GoLive${n}`,
  };
}

// ---- The switch ----------------------------------------------------------------------------------------------------

describe("goLive: the switch", () => {
  it("[PBE-061 AC1] switches an OTA that meets every precondition to live and publishes the tenant invalidation", async () => {
    const ota = await readyOta({ testPayment: { statement_descriptor_suffix: "ACME TRAVEL" } });
    t.clock.advance(60_000);

    const res = await goLive(ota);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as TenantBody;
    expect(body).toMatchObject({
      id: ota.tenant.id,
      storefrontEnvironment: "live",
      liveEnabledAt: t.clock.now().toISOString(),
      version: ota.tenant.version + 1,
      myRole: "owner",
    });
    expect(res.headers["etag"]).toBe(`"${ota.tenant.version + 1}"`);
    const tenant = await storedTenant(ota.tenant.id);
    expect([tenant.storefront_environment, tenant.live_enabled_by_account_id]).toEqual([
      "live",
      ota.owner.id,
    ]);
    expect(tenant.live_enabled_at?.toISOString()).toBe(t.clock.now().toISOString());

    // The test payments were in `velexis` mode: the live connection is created in that mode.
    const [test, live] = await paymentsOf(ota.tenant.id);
    expect(live).toMatchObject({
      environment: "live",
      provider: "stripe",
      account_mode: "velexis",
      account_reference: null,
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: "ACME TRAVEL",
      created_by_account_id: ota.owner.id,
    });
    expect(live?.id).toMatch(/^ppc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(test?.environment).toBe("test");

    expect(await auditOf(ota.tenant.id, "tenant.went_live")).toEqual([
      {
        actor_type: "account",
        actor_account_id: ota.owner.id,
        action: "tenant.went_live",
        target_type: "tenant",
        target_id: ota.tenant.id,
        tenant_id: ota.tenant.id,
        details: {
          before: { storefrontEnvironment: "test" },
          after: { storefrontEnvironment: "live", liveEnabledAt: t.clock.now().toISOString() },
          paymentMode: "velexis",
          paymentConnectionId: live?.id,
          paymentConnectionCreated: true,
        },
      },
    ]);
    await invalidations([
      { v: 1, type: "tenant", id: ota.tenant.id },
      { v: 1, type: "connection", tenantId: ota.tenant.id },
    ]);
    // The OTA reads live from now on.
    const read = await t.http.get(`/v1/tenants/${ota.tenant.id}`).set(await bearer(ota.agent.id));
    expect((read.body as TenantBody).storefrontEnvironment).toBe("live");
  });

  it("[PBE-061 AC1] copies a Connect Standard test connection to live, with no payout account needed", async () => {
    const capabilities = { chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true };
    const ota = await readyOta({
      payout: null,
      testPayment: {
        account_mode: "connect_standard",
        account_reference: "acct_1GoLiveConnect",
        capabilities,
        connected_at: new Date("2026-01-10T08:00:00Z"),
        statement_descriptor_suffix: null,
      },
    });

    const res = await goLive(ota);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [test, live] = await paymentsOf(ota.tenant.id);
    expect(live).toMatchObject({
      environment: "live",
      account_mode: "connect_standard",
      account_reference: "acct_1GoLiveConnect",
      publishable_key: null,
      secret_ciphertext: null,
      capabilities,
      status: "active",
      disconnected_at: null,
      created_by_account_id: ota.owner.id,
    });
    // One OAuth serves both rows: the copy keeps the test row's `connected_at`, so a deauthorisation older than that
    // OAuth that reaches the platform after go-live disables the copy too (the stale rule compares with it).
    expect(test?.connected_at).toBeInstanceOf(Date);
    expect(live?.connected_at?.toISOString()).toBe(test?.connected_at?.toISOString());
    expect(live?.connected_at?.toISOString()).not.toBe(t.clock.now().toISOString());
    expect((await auditOf(ota.tenant.id, "tenant.went_live"))[0]?.["details"]).toMatchObject({
      paymentMode: "connect_standard",
      paymentConnectionId: live?.id,
      paymentConnectionCreated: true,
    });
    await invalidations([
      { v: 1, type: "tenant", id: ota.tenant.id },
      { v: 1, type: "connection", tenantId: ota.tenant.id },
    ]);
  });

  it("[PBE-061 AC1] keeps verified live API keys as the live payments, with no payout account needed", async () => {
    // The test payments stay on the Velexis account; the live keys were verified before going live (PBE-057).
    const ota = await readyOta({ payout: null, livePayment: liveApiKeys(1) });
    const [, before] = await paymentsOf(ota.tenant.id);

    const res = await goLive(ota);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await paymentsOf(ota.tenant.id);
    expect(after.map((row) => [row.environment, row.account_mode])).toEqual([
      ["test", "velexis"],
      ["live", "api_keys"],
    ]);
    expect(after[1]).toEqual(before);
    expect((await auditOf(ota.tenant.id, "tenant.went_live"))[0]?.["details"]).toMatchObject({
      paymentMode: "api_keys",
      paymentConnectionId: before?.id,
      paymentConnectionCreated: false,
    });
  });

  it("[PBE-061 AC1] answers an OTA that is live already as it is, with no write, audit row or invalidation", async () => {
    const liveSince = new Date("2026-01-02T09:00:00Z");
    const ota = await readyOta({
      tenant: { storefront_environment: "live", live_enabled_at: liveSince },
      amadeusLive: null,
      payout: null,
    });

    const res = await goLive(ota);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storefrontEnvironment: "live",
      liveEnabledAt: liveSince.toISOString(),
      version: ota.tenant.version,
    });
    expect((await paymentsOf(ota.tenant.id)).map((row) => row.environment)).toEqual(["test"]);
    expect(await auditOf(ota.tenant.id, "tenant.went_live")).toEqual([]);
    expect(await settledEventsOf(ota.tenant.id)).toEqual([]);
  });

  it("[PBE-061 AC1] switches once when the owner goes live twice at the same time", async () => {
    const ota = await readyOta();
    const headers = await steppedUp(ota.owner.id);

    const answers = await Promise.all([goLive(ota, headers), goLive(ota, headers)]);

    expect(answers.map((res) => res.status)).toEqual([200, 200]);
    expect(answers.map((res) => (res.body as TenantBody).version)).toEqual([
      ota.tenant.version + 1,
      ota.tenant.version + 1,
    ]);
    expect((await paymentsOf(ota.tenant.id)).map((row) => row.environment)).toEqual(["test", "live"]);
    expect(await auditOf(ota.tenant.id, "tenant.went_live")).toHaveLength(1);
  });

  it("[PBE-061 AC1] waits for a change of the payout account or a payment connection and decides on what it commits, without a deadlock on its audit row", async () => {
    // The writers of these rows that lock them before anything of the tenant: the platform admin's review of the
    // payout account and the owner's save (PBE-058), the admin's switch of a connection's status (PBE-030) and the
    // Connect account events (PBE-056). Each writes its audit row after it locked its row, and the audit row's foreign
    // key takes a KEY SHARE lock on the tenant's row; go-live, which holds the tenant's row while it waits for theirs,
    // must not hold off that lock. A transaction of this test plays such a writer: it holds the row, waits until
    // go-live waits for it, then writes the change and the audit row and commits.
    const cases = [
      {
        // An admin verifies the payout account go-live needs while the owner goes live.
        ota: await readyOta({ payout: "pending_review" }),
        lock: "SELECT 1 FROM platform.tenant_payout_accounts WHERE tenant_id = $1 FOR UPDATE",
        change:
          "UPDATE platform.tenant_payout_accounts SET status = 'verified', version = version + 1 WHERE tenant_id = $1",
        status: 200,
      },
      {
        // An admin disables the test payment connection go-live would copy.
        ota: await readyOta(),
        lock: "SELECT 1 FROM platform.payment_provider_connections WHERE tenant_id = $1 AND environment = 'test' FOR UPDATE",
        change:
          "UPDATE platform.payment_provider_connections SET status = 'disabled', version = version + 1 " +
          "WHERE tenant_id = $1 AND environment = 'test'",
        status: 422,
      },
    ];
    for (const { ota, lock, change, status } of cases) {
      const headers = await steppedUp(ota.owner.id);
      const holder = await pool.connect();
      let pending: Promise<Response> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query(lock, [ota.tenant.id]);
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = rows[0]?.pid;
        pending = goLive(ota, headers);
        // Awaited below; a failure before then must not count as unhandled.
        void pending.catch(() => undefined);
        /** How many sessions wait for this test's transaction: go-live, once it holds the tenant's row. */
        const waitingOnHolder = async (): Promise<number> => {
          const waiting = await pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))",
            [holderPid],
          );
          return waiting.rows[0]?.n ?? 0;
        };
        await expect.poll(waitingOnHolder, { timeout: WAIT_MS, interval: 20 }).toBe(1);
        await holder.query(change, [ota.tenant.id]);
        // The audit row of the change: its foreign key needs the tenant's row in KEY SHARE mode, which go-live's lock
        // leaves free (a FOR UPDATE there would make both wait for each other until PostgreSQL aborts one).
        await holder.query(
          "INSERT INTO platform.platform_audit_log (tenant_id, actor_type, action, target_type, target_id) " +
            "VALUES ($1, 'system', 'test.concurrent_change', 'tenant', $1)",
          [ota.tenant.id],
        );
        await holder.query("COMMIT");
      } catch (error) {
        await holder.query("ROLLBACK");
        throw error;
      } finally {
        holder.release();
      }

      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(await auditOf(ota.tenant.id, "test.concurrent_change")).toHaveLength(1);
      if (status === 200) {
        // The verification committed first: go-live read the account `verified` and switched.
        expect((await storedTenant(ota.tenant.id)).storefront_environment).toBe("live");
      } else {
        // The disable committed first: go-live read the connection `disabled` and changed nothing.
        expect(errorOf(res)).toMatchObject({
          code: "LIVE_PRECONDITIONS_UNMET",
          details: { missing: ["payments_live"] },
        });
        expect((await storedTenant(ota.tenant.id)).storefront_environment).toBe("test");
        expect((await paymentsOf(ota.tenant.id)).map((row) => row.environment)).toEqual(["test"]);
      }
    }
  });
});

// ---- The refusals --------------------------------------------------------------------------------------------------

describe("goLive: the refusals", () => {
  it("[PBE-061 AC1] answers FEATURE_DISABLED while the live switch is off, before any step-up", async () => {
    const ota = await readyOta();
    switches.on.delete("live_switch");

    const stale = await goLive(ota, await bearer(ota.owner.id));
    const stepped = await goLive(ota);

    for (const res of [stale, stepped]) {
      expect([res.status, errorOf(res)]).toEqual([
        403,
        { ...errorOf(res), code: "FEATURE_DISABLED", details: { feature: "live_switch" } },
      ]);
    }
    expect((await storedTenant(ota.tenant.id)).storefront_environment).toBe("test");
  });

  it("[PBE-061 AC1] needs a recent step-up of an owner with MFA, and a member", async () => {
    const ota = await readyOta();
    const other = await readyOta();
    const noMfa = await insertAccount(pool);
    await insertMember(pool, ota.tenant, noMfa, "owner");

    const withoutStepUp = await goLive(ota, await bearer(ota.owner.id));
    const staleStepUp = await goLive(
      ota,
      await bearer(ota.owner.id, { amr: ["pwd", "otp"], mfa_at: nowSeconds() - 16 * 60 }),
    );
    const withoutMfa = await goLive(ota, await steppedUp(noMfa.id));
    const byAdmin = await goLive(ota, await steppedUp(ota.admin.id));
    const byStranger = await goLive(ota, await steppedUp(other.owner.id));

    expect([withoutStepUp.status, errorOf(withoutStepUp).code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([staleStepUp.status, errorOf(staleStepUp).code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([withoutMfa.status, errorOf(withoutMfa).code]).toEqual([403, "MFA_REQUIRED"]);
    expect([byAdmin.status, errorOf(byAdmin).code]).toEqual([403, "FORBIDDEN"]);
    expect([byStranger.status, errorOf(byStranger).code]).toEqual([404, "NOT_FOUND"]);
    expect((await storedTenant(ota.tenant.id)).storefront_environment).toBe("test");
  });

  it("[PBE-061 AC1] takes only {confirm: true}, and refuses an OTA that is not active", async () => {
    const ota = await readyOta();
    const suspended = await readyOta({ tenant: { status: "suspended", suspension_reason: "billing" } });

    const unconfirmed = await goLive(ota, undefined, { confirm: false });
    const empty = await goLive(ota, undefined, {});
    const notActive = await goLive(suspended);

    expect([unconfirmed.status, errorOf(unconfirmed).code]).toEqual([400, "VALIDATION_FAILED"]);
    expect([empty.status, errorOf(empty).code]).toEqual([400, "VALIDATION_FAILED"]);
    expect([notActive.status, errorOf(notActive)]).toEqual([
      409,
      { ...errorOf(notActive), code: "TENANT_NOT_ACTIVE", details: { status: "suspended" } },
    ]);
    expect((await storedTenant(ota.tenant.id)).storefront_environment).toBe("test");
    expect((await storedTenant(suspended.tenant.id)).storefront_environment).toBe("test");
  });
});

// ---- Live API keys -------------------------------------------------------------------------------------------------

describe("live API keys", () => {
  /** `createApiKey` of `ota` with `body`, by `headers`, checked against the document. */
  async function createKey(
    ota: GoLiveOta,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const res = await t.http.post(`/v1/tenants/${ota.tenant.id}/api-keys`).set(headers).send(body);
    expectResponseToMatch("createApiKey", res, { document: "platform" });
    return res;
  }

  /** `rollApiKey` of the key `keyId`, by `headers`, checked against the document. */
  async function rollKey(ota: GoLiveOta, keyId: string, headers: Record<string, string>): Promise<Response> {
    const res = await t.http
      .post(`/v1/tenants/${ota.tenant.id}/api-keys/${keyId}/roll`)
      .set(headers)
      .send({ expireOldIn: "1h" });
    expectResponseToMatch("rollApiKey", res, { document: "platform" });
    return res;
  }

  const LIVE_SECRET = { name: "Live server", kind: "secret", environment: "live" } as const;
  const LIVE_PUBLISHABLE = {
    name: "Live site",
    kind: "publishable",
    environment: "live",
    allowedOrigins: ["https://www.acme-travel.example.com"],
  } as const;

  it("[PBE-061 AC2] opens live keys once the OTA went live; a live secret key without a recent step-up answers REAUTH_REQUIRED", async () => {
    const ota = await readyOta();

    const beforeGoLive = await createKey(ota, await steppedUp(ota.owner.id), LIVE_PUBLISHABLE);
    expect([beforeGoLive.status, errorOf(beforeGoLive).code]).toEqual([422, "LIVE_MODE_NOT_ENABLED"]);

    expect((await goLive(ota)).status).toBe(200);
    const withoutStepUp = await createKey(ota, await bearer(ota.owner.id), LIVE_SECRET);
    const staleStepUp = await createKey(
      ota,
      await bearer(ota.owner.id, { amr: ["pwd", "otp"], mfa_at: nowSeconds() - 16 * 60 }),
      LIVE_SECRET,
    );
    const publishable = await createKey(ota, await bearer(ota.admin.id), LIVE_PUBLISHABLE);
    const secret = await createKey(ota, await steppedUp(ota.owner.id), LIVE_SECRET);

    expect([withoutStepUp.status, errorOf(withoutStepUp).code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([staleStepUp.status, errorOf(staleStepUp).code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect(publishable.status, JSON.stringify(publishable.body)).toBe(201);
    expect((publishable.body as { key: string }).key).toMatch(/^pk_live_/);
    expect(secret.status, JSON.stringify(secret.body)).toBe(201);
    expect((secret.body as { key: string }).key).toMatch(/^sk_live_/);

    // Rolling the live secret key needs the step-up too.
    const { apiKey } = secret.body as { apiKey: { id: string } };
    const rollWithoutStepUp = await rollKey(ota, apiKey.id, await bearer(ota.owner.id));
    const rolled = await rollKey(ota, apiKey.id, await steppedUp(ota.owner.id));
    expect([rollWithoutStepUp.status, errorOf(rollWithoutStepUp).code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(201);
    expect((rolled.body as { key: string }).key).toMatch(/^sk_live_/);
  });

  it("[PBE-061 AC2] answers FEATURE_DISABLED for a live key while the live switch is off, before the step-up; test keys still work", async () => {
    const ota = await readyOta();
    expect((await goLive(ota)).status).toBe(200);
    const live = await createKey(ota, await steppedUp(ota.owner.id), LIVE_SECRET);
    expect(live.status).toBe(201);
    const { apiKey } = live.body as { apiKey: { id: string } };
    switches.on.delete("live_switch");

    const created = await createKey(ota, await bearer(ota.owner.id), LIVE_SECRET);
    const publishable = await createKey(ota, await bearer(ota.admin.id), LIVE_PUBLISHABLE);
    const rolled = await rollKey(ota, apiKey.id, await bearer(ota.owner.id));
    const test = await createKey(ota, await bearer(ota.admin.id), {
      name: "Test server",
      kind: "secret",
      environment: "test",
    });

    for (const res of [created, publishable, rolled]) {
      expect([res.status, errorOf(res)]).toEqual([
        403,
        { ...errorOf(res), code: "FEATURE_DISABLED", details: { feature: "live_switch" } },
      ]);
    }
    expect(test.status, JSON.stringify(test.body)).toBe(201);
    const { rows } = await pool.query(
      "SELECT environment, count(*)::int AS n FROM platform.api_keys WHERE tenant_id = $1 GROUP BY environment ORDER BY environment",
      [ota.tenant.id],
    );
    expect(rows).toEqual([
      { environment: "live", n: 1 },
      { environment: "test", n: 1 },
    ]);
  });

  it("[PBE-061 AC2] refuses to roll a live key of an OTA that is not live", async () => {
    // A live key left on an OTA whose storefront is test (written directly: no operation leads there).
    const ota = await readyOta();
    await insertRow(pool, "api_keys", {
      id: testId("key", 6100),
      tenant_id: ota.tenant.id,
      name: "Stray live key",
      kind: "secret",
      environment: "live",
      prefix: "sk_live_Stray0",
      key_hash: "0".repeat(64),
      last4: "Zz99",
      scopes: ["storefront"],
    });

    const res = await rollKey(ota, testId("key", 6100), await steppedUp(ota.owner.id));

    expect([res.status, errorOf(res).code]).toEqual([422, "LIVE_MODE_NOT_ENABLED"]);
  });
});
