// Stripe Checkout and the Customer Portal without a database (PBE-044; subscription-billing flow §B and §F, PADR-0002
// items 1 and 3): the Checkout Session's parameters, the trial on the first Stripe subscription only, the reuse of the
// OTA's Stripe Customer, the plan rule (`PLAN_NOT_AVAILABLE`), the `CONFLICT`s, and what a Stripe failure answers and
// leaves behind, including the attempts of the Customer creation after a failure that spent its idempotency key
// (FIX-W29-PLATFORM; PADR-0002 item 3, revision of 2026-10-24). CheckoutService runs over the FakeStripe of
// test/support/fake-stripe.ts and stand-ins of its repositories that record what they are asked to write.
// test/integration/billing/checkout.int.test.ts runs the same rules through HTTP and PostgreSQL, with createTenant and
// retryProvisioning.
import type { ConfigService } from "@nestjs/config";
import { isAppError, type AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { CHECKOUT_SESSION_LIFETIME_SECONDS, FakeStripe } from "../../test/support/fake-stripe";
import type { AuditEntry, AuditService } from "../audit/audit.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import type { Clock } from "../common/clock";
import type { PlatformDb } from "../common/database";
import { StripeNotConfiguredError } from "../common/stripe/stripe.client";
import type { PlatformBackendConfig } from "../config";
import type {
  BillingCustomerRow,
  BillingCustomersRepository,
  CustomerAttemptMove,
  CustomerContext,
  NewBillingCustomer,
} from "./billing-customers.repository";
import {
  checkoutPlanOf,
  CheckoutService,
  pendingCheckoutRowOf,
  PORTAL_MANAGED_STATUSES,
  type CheckoutPlan,
} from "./checkout.service";
import type { PlansRepository, PublicPlanRow } from "./plans.repository";
import {
  checkoutSessionParams,
  customerIdempotencyKey,
  providerError,
  StripeBillingGateway,
  stripeBillingFailureOf,
} from "./stripe-billing.gateway";
import type {
  CheckoutSessionRecord,
  CheckoutSubscriptionRow,
  SubscriptionsRepository,
} from "./subscriptions.repository";

const NOW = new Date("2027-03-02T10:15:00Z");
const TENANT = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const ACCOUNT = "acc_01JB3K4M8P2R6T0W4Y8A2C6E01";
const SUBSCRIPTION = "sub_01JB3K4M8P2R6T0W4Y8A2C6E02";
/** An `Idempotency-Key` of the request (16 to 128 letters, digits, `_` and `-`). */
const REQUEST_KEY = "idem_pbe044_unit_0001";
const PORTAL = "https://platform.example.com";
const OWNER: TenantMembership = Object.freeze({
  membershipId: "stf_01JB3K4M8P2R6T0W4Y8A2C6E03",
  tenantId: TENANT,
  accountId: ACCOUNT,
  role: "owner",
});

/** A public, active plan with both Stripe prices and a 14-day trial. */
function plan(overrides: Partial<PublicPlanRow> = {}): PublicPlanRow {
  return {
    code: "starter",
    name: "Starter",
    description: null,
    currency: "EUR",
    monthly_price: "49.00",
    annual_price: "490.00",
    trial_days: 14,
    limits: {},
    features: {},
    stripe_price_id_month: "price_TestStarterMonth",
    stripe_price_id_year: "price_TestStarterYear",
    ...overrides,
  };
}

const STARTER_MONTH: CheckoutPlan = Object.freeze({
  code: "starter",
  interval: "month",
  priceId: "price_TestStarterMonth",
  trialDays: 14,
});

/** The state the stand-ins answer, and what CheckoutService asked them to write. */
interface World {
  plans: PublicPlanRow[];
  customer: BillingCustomerRow | undefined;
  context: CustomerContext | undefined;
  current: CheckoutSubscriptionRow | undefined;
  hadStripeSubscription: boolean;
  /** The attempt of the Customer creation (`billing_customer_attempts`; 0 without a row). */
  attempt: number;
  /** An error `advanceCustomerAttempt` throws (the database down), or `undefined`. */
  moveFailure: Error | undefined;
  readonly moves: CustomerAttemptMove[];
  readonly insertedCustomers: NewBillingCustomer[];
  readonly recorded: CheckoutSessionRecord[];
  readonly audited: AuditEntry[];
  readonly logs: Array<{ readonly line: unknown; readonly msg: unknown }>;
  readonly warnings: Array<{ readonly line: unknown; readonly msg: unknown }>;
}

interface Harness {
  readonly service: CheckoutService;
  readonly stripe: FakeStripe;
  readonly world: World;
}

function harness(world: Partial<World> = {}): Harness {
  const state: World = {
    plans: [plan()],
    customer: undefined,
    context: { name: "Nordic Fares AB", email: "owner@example.com" },
    current: undefined,
    hadStripeSubscription: false,
    attempt: 0,
    moveFailure: undefined,
    moves: [],
    insertedCustomers: [],
    recorded: [],
    audited: [],
    logs: [],
    warnings: [],
    ...world,
  };
  const plans = { listPublicActive: () => Promise.resolve(state.plans) } as unknown as PlansRepository;
  const customers = {
    find: () => Promise.resolve(state.customer),
    customerContext: () => Promise.resolve(state.context),
    customerAttempt: () => Promise.resolve(state.attempt),
    // The compare-and-set of the repository: only the attempt that failed moves on.
    advanceCustomerAttempt: (move: CustomerAttemptMove) => {
      if (state.moveFailure !== undefined) {
        return Promise.reject(state.moveFailure);
      }
      state.moves.push(move);
      if (state.attempt === move.from) {
        state.attempt = move.from + 1;
      }
      return Promise.resolve(state.attempt);
    },
    insertIfAbsent: (customer: NewBillingCustomer) => {
      state.insertedCustomers.push(customer);
      state.customer ??= {
        tenant_id: customer.tenantId,
        provider_customer_id: customer.customerId,
        livemode: customer.livemode,
      };
      return Promise.resolve(state.customer);
    },
  } as unknown as BillingCustomersRepository;
  const subscriptions = {
    findCurrentForCheckout: () => Promise.resolve(state.current),
    hasStripeSubscription: () => Promise.resolve(state.hadStripeSubscription),
    recordCheckoutSession: (_trx: unknown, record: CheckoutSessionRecord) => {
      state.recorded.push(record);
      return Promise.resolve(true);
    },
  } as unknown as SubscriptionsRepository;
  const audit = {
    record: (_trx: unknown, entry: AuditEntry) => {
      state.audited.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  // runInTransaction only needs `transaction().execute(fn)`; the stand-ins ignore the transaction object.
  const db = {
    transaction: () => ({ execute: <T>(fn: (trx: object) => Promise<T>) => fn({}) }),
  } as unknown as PlatformDb;
  const config = {
    get: (name: keyof PlatformBackendConfig) => (name === "PUBLIC_PORTAL_URL" ? `${PORTAL}/` : undefined),
  } as unknown as ConfigService<PlatformBackendConfig, true>;
  const logger = {
    info: (line: unknown, msg: unknown) => state.logs.push({ line, msg }),
    warn: (line: unknown, msg: unknown) => state.warnings.push({ line, msg }),
  } as unknown as PinoLogger;
  const stripe = new FakeStripe();
  const service = new CheckoutService(
    plans,
    customers,
    subscriptions,
    new StripeBillingGateway(stripe),
    audit,
    new FakeClock(NOW) as unknown as Clock,
    db,
    logger,
    config,
  );
  return { service, stripe, world: state };
}

/** What `fn` throws; fails the test when it resolves. */
async function failureOf(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

describe("checkoutSessionParams", () => {
  it("[PBE-044 AC1] fixes the parameters of flow §B: subscription mode, one line item, the metadata twice, the trial, card always, no promotion codes, no automatic tax, the portal's URLs [PF-71 AC1]", () => {
    expect(
      checkoutSessionParams({
        tenantId: TENANT,
        customerId: "cus_TestNordic",
        priceId: "price_TestStarterYear",
        planCode: "starter",
        subscriptionId: SUBSCRIPTION,
        trialDays: 14,
        successUrl: `${PORTAL}/otas/${TENANT}/setup?checkout=success`,
        cancelUrl: `${PORTAL}/otas/${TENANT}/billing?checkout=canceled`,
      }),
    ).toEqual({
      mode: "subscription",
      customer: "cus_TestNordic",
      line_items: [{ price: "price_TestStarterYear", quantity: 1 }],
      client_reference_id: TENANT,
      metadata: {
        velexis_tenant_id: TENANT,
        velexis_subscription_id: SUBSCRIPTION,
        velexis_plan_code: "starter",
      },
      subscription_data: {
        metadata: {
          velexis_tenant_id: TENANT,
          velexis_subscription_id: SUBSCRIPTION,
          velexis_plan_code: "starter",
        },
        trial_period_days: 14,
      },
      payment_method_collection: "always",
      allow_promotion_codes: false,
      automatic_tax: { enabled: false },
      success_url: `${PORTAL}/otas/${TENANT}/setup?checkout=success`,
      cancel_url: `${PORTAL}/otas/${TENANT}/billing?checkout=canceled`,
    });
  });

  it("leaves out velexis_subscription_id without a pre-inserted row, and the trial for none or zero days", () => {
    for (const trialDays of [null, 0]) {
      const params = checkoutSessionParams({
        tenantId: TENANT,
        customerId: "cus_TestNordic",
        priceId: "price_TestStarterMonth",
        planCode: "starter",
        subscriptionId: null,
        trialDays,
        successUrl: `${PORTAL}/s`,
        cancelUrl: `${PORTAL}/c`,
      });
      expect(params.metadata).toEqual({ velexis_tenant_id: TENANT, velexis_plan_code: "starter" });
      expect(params.subscription_data).toEqual({
        metadata: { velexis_tenant_id: TENANT, velexis_plan_code: "starter" },
      });
    }
  });
});

describe("checkoutPlanOf and pendingCheckoutRowOf", () => {
  it("takes the plan's Stripe Price of the interval, and nothing without one", () => {
    expect(checkoutPlanOf(plan(), "month")).toEqual(STARTER_MONTH);
    expect(checkoutPlanOf(plan(), "year")).toEqual({
      ...STARTER_MONTH,
      interval: "year",
      priceId: "price_TestStarterYear",
    });
    expect(checkoutPlanOf(plan({ stripe_price_id_year: null }), "year")).toBeUndefined();
    expect(checkoutPlanOf(plan({ stripe_price_id_month: null }), "month")).toBeUndefined();
  });

  it("carries only an incomplete Stripe row that no Stripe subscription has filled yet", () => {
    const row = (overrides: Partial<CheckoutSubscriptionRow>): CheckoutSubscriptionRow => ({
      id: SUBSCRIPTION,
      status: "incomplete",
      billing_provider: "stripe",
      plan_code: "starter",
      billing_interval: "month",
      provider_subscription_id: null,
      ...overrides,
    });
    expect(pendingCheckoutRowOf(row({}))).toBe(SUBSCRIPTION);
    expect(pendingCheckoutRowOf(undefined)).toBeNull();
    expect(pendingCheckoutRowOf(row({ provider_subscription_id: "sub_TestStripe" }))).toBeNull();
    expect(pendingCheckoutRowOf(row({ status: "active" }))).toBeNull();
    expect(pendingCheckoutRowOf(row({ billing_provider: "manual", status: "trialing" }))).toBeNull();
  });
});

describe("CheckoutService.planFor", () => {
  it("[PBE-044 AC1] answers 422 PLAN_NOT_AVAILABLE for a plan that is not public and active, or has no Stripe Price for the interval", async () => {
    const { service } = harness({ plans: [plan(), plan({ code: "growth", stripe_price_id_year: null })] });

    expect(await service.planFor("starter", "month")).toEqual(STARTER_MONTH);
    for (const [code, interval] of [
      ["growth", "year"],
      ["early_access", "month"],
      ["unknown", "month"],
    ] as const) {
      const error = await failureOf(() => service.planFor(code, interval));
      expect([error.code, error.status]).toEqual(["PLAN_NOT_AVAILABLE", 422]);
    }
  });
});

describe("CheckoutService.start", () => {
  it("[PBE-044 AC1] creates the OTA's Stripe Customer, then the Checkout Session with Stripe's keys, and records the Session on the incomplete row [PF-71 AC1]", async () => {
    const { service, stripe, world } = harness();

    const session = await service.start({
      tenantId: TENANT,
      accountId: ACCOUNT,
      plan: STARTER_MONTH,
      subscriptionId: SUBSCRIPTION,
      requestKey: REQUEST_KEY,
    });

    expect(stripe.calls.map((call) => [call.method, call.idempotencyKey])).toEqual([
      ["customers.create", `customer:${TENANT}`],
      ["checkout.sessions.create", `checkout:${TENANT}:${REQUEST_KEY}`],
    ]);
    expect(stripe.callsOf("customers.create")[0]?.params).toEqual({
      email: "owner@example.com",
      name: "Nordic Fares AB",
      metadata: { velexis_tenant_id: TENANT },
    });
    const customerId = world.insertedCustomers[0]?.customerId;
    expect(world.insertedCustomers).toEqual([
      { tenantId: TENANT, customerId, livemode: false, billingEmail: "owner@example.com", now: NOW },
    ]);
    expect(stripe.callsOf("checkout.sessions.create")[0]?.params).toEqual(
      checkoutSessionParams({
        tenantId: TENANT,
        customerId: customerId ?? "",
        priceId: "price_TestStarterMonth",
        planCode: "starter",
        subscriptionId: SUBSCRIPTION,
        trialDays: 14,
        successUrl: `${PORTAL}/otas/${TENANT}/setup?checkout=success`,
        cancelUrl: `${PORTAL}/otas/${TENANT}/billing?checkout=canceled`,
      }),
    );
    const created = stripe.get(session.id) as unknown as { created: number; url: string };
    expect(session).toEqual({
      id: expect.stringMatching(/^cs_/),
      url: created.url,
      expiresAt: new Date((created.created + CHECKOUT_SESSION_LIFETIME_SECONDS) * 1000),
    });
    expect(world.recorded).toEqual([
      {
        id: SUBSCRIPTION,
        checkoutSessionId: session.id,
        planCode: "starter",
        billingInterval: "month",
        now: NOW,
      },
    ]);
    expect(world.audited).toEqual([
      {
        actorType: "account",
        actorAccountId: ACCOUNT,
        action: "billing.checkout_started",
        targetType: "subscription",
        targetId: SUBSCRIPTION,
        tenantId: TENANT,
        details: {
          checkoutSessionId: session.id,
          customerId,
          planCode: "starter",
          billingInterval: "month",
          trialDays: 14,
          subscriptionId: SUBSCRIPTION,
        },
      },
    ]);
    // The URL opens a payment page: it is answered, never logged or audited.
    expect(JSON.stringify([world.logs, world.audited])).not.toContain(session.url);
  });

  it("[PBE-044 AC1] reuses the stored Stripe Customer and gives no trial after a first Stripe subscription", async () => {
    const { service, stripe, world } = harness({
      customer: { tenant_id: TENANT, provider_customer_id: "cus_TestNordic", livemode: false },
      hadStripeSubscription: true,
    });

    await service.start({
      tenantId: TENANT,
      accountId: ACCOUNT,
      plan: STARTER_MONTH,
      subscriptionId: null,
      requestKey: REQUEST_KEY,
    });

    expect(stripe.callsOf("customers.create")).toEqual([]);
    expect(world.insertedCustomers).toEqual([]);
    const params = stripe.callsOf("checkout.sessions.create")[0]
      ?.params as Stripe.Checkout.SessionCreateParams;
    expect(params.customer).toBe("cus_TestNordic");
    expect(params.subscription_data).toEqual({
      metadata: { velexis_tenant_id: TENANT, velexis_plan_code: "starter" },
    });
    // Without a pre-inserted row nothing is recorded on a subscription; the audit row is the tenant's.
    expect(world.recorded).toEqual([]);
    expect(world.audited.map((entry) => [entry.targetType, entry.targetId])).toEqual([["tenant", TENANT]]);
  });

  it("[PBE-044 AC2] answers 502 PROVIDER_ERROR when Stripe fails, records nothing, and keeps the Customer for the next attempt", async () => {
    const { service, stripe, world } = harness();
    stripe.failNext("checkout.sessions.create", FakeStripe.apiError(503));
    const input = {
      tenantId: TENANT,
      accountId: ACCOUNT,
      plan: STARTER_MONTH,
      subscriptionId: SUBSCRIPTION,
      requestKey: REQUEST_KEY,
    };

    const error = await failureOf(() => service.start(input));

    expect([error.code, error.status, error.details]).toEqual([
      "PROVIDER_ERROR",
      502,
      { provider: "stripe" },
    ]);
    expect(world.recorded).toEqual([]);
    expect(world.audited).toEqual([]);
    expect(world.insertedCustomers).toHaveLength(1);

    // The next attempt reuses the Customer and gets its Session.
    await service.start(input);
    expect(stripe.callsOf("customers.create")).toHaveLength(1);
    expect(world.recorded).toHaveLength(1);
  });

  it("answers 502 PROVIDER_ERROR when the Customer cannot be created, without a Checkout Session", async () => {
    const { service, stripe, world } = harness();
    stripe.failNext("customers.create", FakeStripe.connectionError());

    const error = await failureOf(() =>
      service.start({
        tenantId: TENANT,
        accountId: ACCOUNT,
        plan: STARTER_MONTH,
        subscriptionId: null,
        requestKey: REQUEST_KEY,
      }),
    );

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(stripe.callsOf("checkout.sessions.create")).toEqual([]);
    expect(world.insertedCustomers).toEqual([]);
  });
});

describe("CheckoutService.start: the Customer after a failure that spent its key", () => {
  const input = {
    tenantId: TENANT,
    accountId: ACCOUNT,
    plan: STARTER_MONTH,
    subscriptionId: SUBSCRIPTION,
    requestKey: REQUEST_KEY,
  };
  const customerParams = {
    email: "owner@example.com",
    name: "Nordic Fares AB",
    metadata: { velexis_tenant_id: TENANT },
  };

  it("[FIX-W29-PLATFORM AC2] after a Stripe 5xx that Stripe replays for its key, the next attempt creates the Customer under customer:<tenantId>:1", async () => {
    const { service, stripe, world } = harness();
    stripe.failNext("customers.create", FakeStripe.apiError(500), { storedForKey: true });

    const error = await failureOf(() => service.start(input));

    expect([error.code, error.details]).toEqual(["PROVIDER_ERROR", { provider: "stripe" }]);
    expect(world.moves).toEqual([{ tenantId: TENANT, from: 0, now: NOW }]);
    expect(world.attempt).toBe(1);
    expect(world.warnings).toEqual([
      { line: { tenantId: TENANT, attempt: 1 }, msg: "billing.customer_attempt_moved" },
    ]);
    // What the fix avoids: Stripe answers the first key with the stored 500 again, for 24 hours.
    await expect(
      stripe.api().customers.create(customerParams, { idempotencyKey: `customer:${TENANT}` }),
    ).rejects.toBeInstanceOf(Stripe.errors.StripeAPIError);
    stripe.calls.length = 0;

    const session = await service.start(input);

    expect(stripe.calls.map((call) => [call.method, call.idempotencyKey])).toEqual([
      ["customers.search", undefined],
      ["customers.create", `customer:${TENANT}:1`],
      ["checkout.sessions.create", `checkout:${TENANT}:${REQUEST_KEY}`],
    ]);
    expect(stripe.callsOf("customers.search")[0]?.params).toEqual({
      query: `metadata['velexis_tenant_id']:'${TENANT}'`,
      limit: 10,
    });
    expect(stripe.callsOf("customers.create")[0]?.params).toEqual(customerParams);
    expect(world.insertedCustomers.map((customer) => customer.customerId)).toEqual([
      (stripe.callsOf("checkout.sessions.create")[0]?.params as { customer: string }).customer,
    ]);
    expect(world.recorded).toEqual([expect.objectContaining({ checkoutSessionId: session.id })]);
    expect(world.attempt).toBe(1);
  });

  it("[FIX-W29-PLATFORM AC2] stores the Customer that Stripe made before its 5xx instead of making a second one", async () => {
    const { service, stripe, world } = harness();
    stripe.failNext("customers.create", FakeStripe.apiError(500), { created: true, storedForKey: true });

    expect((await failureOf(() => service.start(input))).code).toBe("PROVIDER_ERROR");
    const made = (await stripe.api().customers.search({ query: `metadata['velexis_tenant_id']:'${TENANT}'` }))
      .data;
    expect(made.map((customer) => customer.id)).toEqual([expect.stringMatching(/^cus_/)]);
    stripe.calls.length = 0;

    await service.start(input);

    expect(stripe.calls.map((call) => call.method)).toEqual(["customers.search", "checkout.sessions.create"]);
    expect(world.insertedCustomers).toEqual([
      {
        tenantId: TENANT,
        customerId: made[0]?.id,
        livemode: false,
        billingEmail: "owner@example.com",
        now: NOW,
      },
    ]);
    expect((stripe.callsOf("checkout.sessions.create")[0]?.params as { customer: string }).customer).toBe(
      made[0]?.id,
    );
    expect(world.logs).toContainEqual({
      line: { tenantId: TENANT, customerId: made[0]?.id, attempt: 1 },
      msg: "billing.customer_found",
    });
  });

  it("[FIX-W29-PLATFORM AC2] moves the attempt after a timeout and after a key Stripe refuses, never after a rate limit or a refused request", async () => {
    const spent = [
      FakeStripe.connectionError(),
      FakeStripe.apiError(503),
      new Stripe.errors.StripeIdempotencyError({
        message: "Keys for idempotent requests can only be used with the same parameters.",
        type: "idempotency_error",
        statusCode: 400,
      }),
    ];
    for (const failure of spent) {
      const { service, stripe, world } = harness();
      stripe.failNext("customers.create", failure);

      expect((await failureOf(() => service.start(input))).code, failure.name).toBe("PROVIDER_ERROR");
      expect(world.attempt, failure.name).toBe(1);
    }
    for (const failure of [FakeStripe.apiError(429), FakeStripe.apiError(400, "parameter_invalid_empty")]) {
      const { service, stripe, world } = harness();
      stripe.failNext("customers.create", failure);

      expect((await failureOf(() => service.start(input))).code, failure.name).toBe("PROVIDER_ERROR");
      expect([world.attempt, world.moves], failure.name).toEqual([0, []]);
      // The key was not spent: the next attempt sends it again, without a search.
      stripe.calls.length = 0;
      await service.start(input);
      expect(stripe.calls.map((call) => [call.method, call.idempotencyKey])[0], failure.name).toEqual([
        "customers.create",
        `customer:${TENANT}`,
      ]);
    }
  });

  it("[FIX-W29-PLATFORM AC2] a timeout whose Customer Stripe made is found by the next attempt: one Customer, one creation", async () => {
    const { service, stripe, world } = harness();
    stripe.failNext("customers.create", FakeStripe.connectionError(), { created: true });

    expect((await failureOf(() => service.start(input))).code).toBe("PROVIDER_ERROR");
    await service.start(input);

    expect(stripe.callsOf("customers.create")).toHaveLength(1);
    expect(world.insertedCustomers).toHaveLength(1);
    expect(
      (await stripe.api().customers.search({ query: `metadata['velexis_tenant_id']:'${TENANT}'` })).data,
    ).toHaveLength(1);
  });

  it("[FIX-W29-PLATFORM AC2] goes on from a stored attempt: a failed search answers 502 without creating; a failed move is logged and the Stripe failure answered", async () => {
    const searchDown = harness({ attempt: 2 });
    searchDown.stripe.failNext("customers.search", FakeStripe.apiError(503));

    expect((await failureOf(() => searchDown.service.start(input))).code).toBe("PROVIDER_ERROR");
    expect(searchDown.stripe.calls.map((call) => call.method)).toEqual(["customers.search"]);
    await searchDown.service.start(input);
    expect(searchDown.stripe.callsOf("customers.create").map((call) => call.idempotencyKey)).toEqual([
      `customer:${TENANT}:2`,
    ]);

    const databaseDown = harness({ moveFailure: new Error("connection terminated") });
    databaseDown.stripe.failNext("customers.create", FakeStripe.apiError(502));
    const error = await failureOf(() => databaseDown.service.start(input));
    expect([error.code, databaseDown.world.attempt]).toEqual(["PROVIDER_ERROR", 0]);
    expect(databaseDown.world.warnings).toEqual([
      {
        line: { tenantId: TENANT, attempt: 0, err: databaseDown.world.moveFailure },
        msg: "billing.customer_attempt_not_moved",
      },
    ]);
  });
});

describe("customerIdempotencyKey", () => {
  it("[FIX-W29-PLATFORM AC2] keeps customer:<tenantId> for the first attempt and adds the attempt after", () => {
    expect(customerIdempotencyKey(TENANT, 0)).toBe(`customer:${TENANT}`);
    expect(customerIdempotencyKey(TENANT, 1)).toBe(`customer:${TENANT}:1`);
    expect(customerIdempotencyKey(TENANT, 12)).toBe(`customer:${TENANT}:12`);
    for (const attempt of [-1, 1.5, Number.NaN]) {
      expect(() => customerIdempotencyKey(TENANT, attempt), String(attempt)).toThrow(RangeError);
    }
  });
});

describe("CheckoutService.createCheckoutSession", () => {
  it("[PBE-044 AC2] answers 409 CONFLICT for an OTA whose Stripe subscription is current, before calling Stripe", async () => {
    for (const status of PORTAL_MANAGED_STATUSES) {
      const { service, stripe } = harness({
        current: {
          id: SUBSCRIPTION,
          status,
          billing_provider: "stripe",
          plan_code: "starter",
          billing_interval: "month",
          provider_subscription_id: "sub_TestStripe",
        },
      });

      const error = await failureOf(() =>
        service.createCheckoutSession(OWNER, { planCode: "starter", billingInterval: "month" }, REQUEST_KEY),
      );

      expect([status, error.code, error.details]).toEqual([
        status,
        "CONFLICT",
        { reason: "stripe_subscription_active" },
      ]);
      expect(stripe.calls).toEqual([]);
    }
  });

  it("[PBE-044 AC2] opens a Checkout for a manual trial without touching its row, and carries a pending incomplete row", async () => {
    const manual = harness({
      current: {
        id: SUBSCRIPTION,
        status: "trialing",
        billing_provider: "manual",
        plan_code: "early_access",
        billing_interval: "month",
        provider_subscription_id: null,
      },
    });
    const answer = await manual.service.createCheckoutSession(
      OWNER,
      { planCode: "starter", billingInterval: "year" },
      REQUEST_KEY,
    );
    const params = manual.stripe.callsOf("checkout.sessions.create")[0]
      ?.params as Stripe.Checkout.SessionCreateParams;
    expect(params.line_items).toEqual([{ price: "price_TestStarterYear", quantity: 1 }]);
    expect(params.metadata).toEqual({ velexis_tenant_id: TENANT, velexis_plan_code: "starter" });
    expect(manual.world.recorded).toEqual([]);
    expect(answer).toEqual({
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//),
      expiresAt: expect.any(String),
    });
    expect(new Date(answer.expiresAt).toISOString()).toBe(answer.expiresAt);

    const pending = harness({
      current: {
        id: SUBSCRIPTION,
        status: "incomplete",
        billing_provider: "stripe",
        plan_code: "starter",
        billing_interval: "month",
        provider_subscription_id: null,
      },
    });
    await pending.service.createCheckoutSession(
      OWNER,
      { planCode: "starter", billingInterval: "year" },
      REQUEST_KEY,
    );
    const pendingParams = pending.stripe.callsOf("checkout.sessions.create")[0]
      ?.params as Stripe.Checkout.SessionCreateParams;
    expect(pendingParams.metadata?.["velexis_subscription_id"]).toBe(SUBSCRIPTION);
    expect(pending.world.recorded.map((record) => [record.id, record.billingInterval])).toEqual([
      [SUBSCRIPTION, "year"],
    ]);
  });
});

describe("CheckoutService.createCustomerPortalSession", () => {
  it("[PBE-044 AC3] opens the Customer Portal of the OTA's Customer, returning to its billing page, with a new key each call [PF-72 AC1]", async () => {
    const { service, stripe } = harness({
      customer: { tenant_id: TENANT, provider_customer_id: "cus_TestNordic", livemode: false },
    });

    const first = await service.createCustomerPortalSession(OWNER);
    await service.createCustomerPortalSession(OWNER);

    const calls = stripe.callsOf("billingPortal.sessions.create");
    expect(calls.map((call) => call.params)).toEqual([
      { customer: "cus_TestNordic", return_url: `${PORTAL}/otas/${TENANT}/billing` },
      { customer: "cus_TestNordic", return_url: `${PORTAL}/otas/${TENANT}/billing` },
    ]);
    for (const call of calls) {
      expect(call.idempotencyKey).toMatch(new RegExp(`^portal_session:${TENANT}:[0-9a-f-]{36}$`));
    }
    expect(calls[0]?.idempotencyKey).not.toBe(calls[1]?.idempotencyKey);
    expect(first).toEqual({ url: expect.stringMatching(/^https:\/\/billing\.stripe\.com\/p\/session\//) });
  });

  it("[PBE-044 AC3] answers 409 CONFLICT without a Stripe Customer, and 502 PROVIDER_ERROR when Stripe fails", async () => {
    const none = harness();
    const conflict = await failureOf(() => none.service.createCustomerPortalSession(OWNER));
    expect([conflict.code, conflict.details]).toEqual(["CONFLICT", { reason: "no_stripe_customer" }]);
    expect(none.stripe.calls).toEqual([]);

    const down = harness({
      customer: { tenant_id: TENANT, provider_customer_id: "cus_TestNordic", livemode: false },
    });
    down.stripe.failNext("billingPortal.sessions.create", FakeStripe.apiError(500));
    const failed = await failureOf(() => down.service.createCustomerPortalSession(OWNER));
    expect([failed.code, failed.status, failed.details]).toEqual([
      "PROVIDER_ERROR",
      502,
      { provider: "stripe" },
    ]);
  });
});

describe("stripeBillingFailureOf and providerError", () => {
  it("keeps Stripe's type, status and code, never its message, and says whether a retry may help", () => {
    const invalid = stripeBillingFailureOf(
      "customers.create",
      new Stripe.errors.StripeInvalidRequestError({
        message: "Invalid email address: owner@example.com",
        type: "invalid_request_error",
        statusCode: 400,
        code: "email_invalid",
      }),
    );
    expect([invalid.summary, invalid.retryable]).toEqual([
      "invalid_request_error 400 (email_invalid)",
      false,
    ]);
    expect(invalid.message).not.toContain("owner@example.com");

    expect(stripeBillingFailureOf("checkout.sessions.create", FakeStripe.apiError(503)).retryable).toBe(true);
    expect(stripeBillingFailureOf("checkout.sessions.create", FakeStripe.apiError(429)).retryable).toBe(true);
    const connection = stripeBillingFailureOf("checkout.sessions.create", FakeStripe.connectionError());
    expect([connection.summary, connection.retryable]).toEqual(["connection_error no_status", true]);
    // FIX-W29-PLATFORM AC2: a 5xx, no answer, or a key used with other parameters spends the key; nothing else does.
    expect(
      [
        FakeStripe.apiError(500),
        FakeStripe.apiError(503),
        FakeStripe.connectionError(),
        new Stripe.errors.StripeIdempotencyError({
          message: "reused",
          type: "idempotency_error",
          statusCode: 400,
        }),
        FakeStripe.apiError(429),
        FakeStripe.apiError(409, "idempotency_key_in_use"),
        FakeStripe.apiError(404, "resource_missing"),
        new StripeNotConfiguredError(),
        new TypeError("x"),
      ].map((error) => stripeBillingFailureOf("customers.create", error).keySpent),
    ).toEqual([true, true, true, true, false, false, false, false, false]);
    expect(invalid.keySpent).toBe(false);
    const notConfigured = stripeBillingFailureOf("customers.create", new StripeNotConfiguredError());
    expect(notConfigured.retryable).toBe(false);
    expect(stripeBillingFailureOf("customers.create", new TypeError("x@example.com")).summary).toBe(
      "unexpected TypeError",
    );

    const error = providerError(invalid);
    expect([error.code, error.status, error.details, error.cause]).toEqual([
      "PROVIDER_ERROR",
      502,
      { provider: "stripe" },
      invalid,
    ]);
  });
});
