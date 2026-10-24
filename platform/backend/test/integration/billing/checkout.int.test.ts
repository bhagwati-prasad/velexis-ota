// Stripe customers, Checkout and the Customer Portal (PBE-044; subscription-billing flow §B and §F, sign-up flow step 7
// and its Stripe failure rows, PADR-0002 items 1, 3 and 11, scope PF-71 AC1 and PF-72 AC1) through the HTTP pipeline
// (createTestApp) on this file's database clone, with the FakeStripe of test/support/fake-stripe.ts in place of the
// Stripe client: createTenant with FEATURE_STRIPE_BILLING on (the `incomplete` subscription, the Customer, the Checkout
// Session with the flow's parameters, the closed dispatch gate, `checkoutError` when Stripe fails),
// createCheckoutSession, createCustomerPortalSession, the new Checkout of retryProvisioning after an abandoned one, and,
// last in the file on an application of its own, the same calls with the switch off. Every answer is checked against
// the platform document.
//
// The Stripe keys of the switched-on application are the development values of `.env.example` (no secret): nothing
// reaches Stripe. The abandoned Checkout of the retry test is written as billing.abandoned_checkouts (PBE-047) leaves
// it: the subscription `incomplete_expired`, the job `canceled`, the tenant `failed`.
import { randomUUID } from "node:crypto";
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import { validateJob } from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { checkoutSessionParams } from "../../../src/billing/stripe-billing.gateway";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import { ProvisioningDispatcher } from "../../../src/provisioning/dispatcher";
import { CHECKOUT_ERROR_MESSAGE } from "../../../src/provisioning/lifecycle.service";
import { insertAccount, insertPlan, insertRow, testId } from "../../builders/platform-rows";
import { insertMember, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";
import { FakeStripe } from "../../support/fake-stripe";

/** One database clone, the Nest module graph and the Ajv validators of the document; allows for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
const FAMILY = testId("asn", 44);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.44";
/** A zone of the reference data for the requests; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
/** The Stripe settings of the switched-on application: the development values of `.env.example`. */
const STRIPE_ENV = Object.freeze({
  FEATURE_STRIPE_BILLING: "true",
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_replace_me",
});

/** A public plan with both Stripe Prices and a 14-day trial, one with a monthly Price only, and a retired one. */
const STARTER = {
  code: "starter",
  month: "price_TestPbe044StarterMonth",
  year: "price_TestPbe044StarterYear",
};
const GROWTH = { code: "growth", month: "price_TestPbe044GrowthMonth" };
const RETIRED = { code: "retired", month: "price_TestPbe044RetiredMonth" };

type Row = Record<string, unknown>;

interface Response {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

interface Body {
  readonly key: string;
  readonly name: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly timeZone: string;
  readonly planCode?: string;
  readonly billingInterval?: "month" | "year";
}

/** The answer of createTenant. */
interface Created {
  readonly tenant: { readonly id: string; readonly planCode: string; readonly status: string };
  readonly provisioningJob: { readonly id: string; readonly status: string };
  readonly checkoutUrl: string | null;
  readonly checkoutError?: { readonly code: string; readonly message: string };
}

/** One application of this file and the helpers bound to it. */
interface Harness {
  readonly t: TestApp;
  readonly pool: PlatformPool;
  readonly stripe: FakeStripe;
  readonly tokens: TokenService;
}

/** Every token this file signed, to check that none reaches a log line. */
const signed: string[] = [];

/** Starts an application with `env` and a FakeStripe in place of the Stripe client. */
async function start(env: Readonly<Record<string, string>>): Promise<Harness> {
  const stripe = new FakeStripe();
  const t = await createTestApp({ env, overrides: [{ provide: StripeClient, useValue: stripe }] });
  const pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120) ON CONFLICT DO NOTHING",
    [TIME_ZONE],
  );
  await insertPlan(pool, {
    code: STARTER.code,
    trial_days: 14,
    stripe_price_id_month: STARTER.month,
    stripe_price_id_year: STARTER.year,
  });
  await insertPlan(pool, { code: GROWTH.code, trial_days: 0, stripe_price_id_month: GROWTH.month });
  await insertPlan(pool, { code: RETIRED.code, is_active: false, stripe_price_id_month: RETIRED.month });
  return { t, pool, stripe, tokens: t.app.get(TokenService) };
}

/** The headers of a portal call by `accountId`: a fresh portal token and the portal server's headers. */
async function headersOf(h: Harness, accountId: string): Promise<Record<string, string>> {
  const { token } = await h.tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
  });
  signed.push(token);
  return { Authorization: `Bearer ${token}`, ...h.t.bffHeaders(PERSON_IP) };
}

/** A request body for `key`: an OTA in France selling in euros, on `plan` when given. */
function body(key: string, plan: Pick<Body, "planCode" | "billingInterval"> = {}): Body {
  return {
    key,
    name: "Nordic Fares",
    countryCode: "FR",
    defaultCurrency: "EUR",
    timeZone: TIME_ZONE,
    ...plan,
  };
}

async function createTenant(
  h: Harness,
  accountId: string,
  payload: Body,
  idempotencyKey: string = randomUUID(),
): Promise<Response> {
  return h.t.http
    .post("/v1/tenants")
    .set(await headersOf(h, accountId))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload);
}

async function checkoutSession(
  h: Harness,
  accountId: string,
  tenantId: string,
  payload: Row,
  idempotencyKey: string = randomUUID(),
): Promise<Response> {
  return h.t.http
    .post(`/v1/tenants/${tenantId}/billing/checkout-session`)
    .set(await headersOf(h, accountId))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload);
}

async function portalSession(h: Harness, accountId: string, tenantId: string): Promise<Response> {
  return h.t.http.post(`/v1/tenants/${tenantId}/billing/portal-session`).set(await headersOf(h, accountId));
}

/** `<status> <code>` of an answer; `<status>` alone for a success. */
function outcomeOf(res: Response): string {
  const { error } = (res.body ?? {}) as { error?: { code: string } };
  return error === undefined ? String(res.status) : `${res.status} ${error.code}`;
}

/** `details` of an error answer. */
function detailsOf(res: Response): unknown {
  return (res.body as { error?: { details?: unknown } }).error?.details;
}

async function rowsOf(h: Harness, text: string, values: unknown[]): Promise<Row[]> {
  return (await h.pool.query(text, values)).rows as Row[];
}

const subscriptionsOf = (h: Harness, tenantId: string): Promise<Row[]> =>
  rowsOf(h, "SELECT * FROM platform.subscriptions WHERE tenant_id = $1 ORDER BY created_at, id", [tenantId]);

const customersOf = (h: Harness, tenantId: string): Promise<Row[]> =>
  rowsOf(h, "SELECT * FROM platform.billing_customers WHERE tenant_id = $1", [tenantId]);

const auditOf = (h: Harness, tenantId: string, action: string): Promise<Row[]> =>
  rowsOf(h, "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id", [
    tenantId,
    action,
  ]);

/** The portal links of the Checkout of `tenantId` on the application's PUBLIC_PORTAL_URL. */
function portalLinks(
  h: Harness,
  tenantId: string,
): { readonly successUrl: string; readonly cancelUrl: string } {
  const base = h.t.config.PUBLIC_PORTAL_URL.replace(/\/+$/, "");
  return {
    successUrl: `${base}/otas/${tenantId}/setup?checkout=success`,
    cancelUrl: `${base}/otas/${tenantId}/billing?checkout=canceled`,
  };
}

/** Everything the application logged, as one text. */
const loggedText = (h: Harness): string => JSON.stringify(h.t.logs.lines);

describe("with FEATURE_STRIPE_BILLING on", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await start(STRIPE_ENV);
    // Parse the platform document for expectResponseToMatch and compile the job message schemas that a dispatch
    // checks (PBE-019) here, not in the first test.
    responseChecker("platform");
    validateJob("tenant.provision", provisionFixture);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await h?.t.close();
  }, SETUP_TIMEOUT_MS);

  it("[PBE-044 AC1] createTenant returns a Checkout URL built with the flow's parameters, and the tenant stays provisioning until the webhook [PF-71 AC1]", async () => {
    const founder = await insertAccount(h.pool, { email: "founder.nordic@example.com" });
    const idempotencyKey = randomUUID();
    h.stripe.reset();

    const res = await createTenant(
      h,
      founder.id,
      body("nordic", { planCode: "starter", billingInterval: "year" }),
      idempotencyKey,
    );

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const answer = res.body as Created;
    const tenantId = answer.tenant.id;
    expect(answer.tenant).toMatchObject({ planCode: "starter", status: "provisioning" });
    expect(answer.provisioningJob.status).toBe("queued");
    expect(answer).not.toHaveProperty("checkoutError");

    // The subscription is incomplete and Stripe-billed; the Customer and the Session come from the fake.
    const [subscription] = await subscriptionsOf(h, tenantId);
    const [customer] = await customersOf(h, tenantId);
    expect(h.stripe.calls.map((call) => [call.method, call.idempotencyKey])).toEqual([
      ["customers.create", `customer:${tenantId}`],
      ["checkout.sessions.create", `checkout:${tenantId}:${idempotencyKey}`],
    ]);
    expect(h.stripe.callsOf("customers.create")[0]?.params).toEqual({
      email: "founder.nordic@example.com",
      name: "Nordic Fares",
      metadata: { velexis_tenant_id: tenantId },
    });
    const sessionCall = h.stripe.callsOf("checkout.sessions.create")[0];
    expect(sessionCall?.params).toEqual(
      checkoutSessionParams({
        tenantId,
        customerId: String(customer?.["provider_customer_id"]),
        priceId: STARTER.year,
        planCode: "starter",
        subscriptionId: String(subscription?.["id"]),
        trialDays: 14,
        ...portalLinks(h, tenantId),
      }),
    );
    const session = h.stripe.get(String(subscription?.["checkout_session_id"])) as unknown as { url: string };
    expect(answer.checkoutUrl).toBe(session.url);
    expect(subscription).toMatchObject({
      status: "incomplete",
      billing_provider: "stripe",
      plan_code: "starter",
      billing_interval: "year",
      trial_ends_at: null,
      provider_subscription_id: null,
      checkout_session_id: expect.stringMatching(/^cs_/),
    });
    expect(customer).toMatchObject({
      provider: "stripe",
      provider_customer_id: expect.stringMatching(/^cus_/),
      livemode: false,
      billing_email: "founder.nordic@example.com",
    });
    expect(await auditOf(h, tenantId, "tenant.created")).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          subscriptionStatus: "incomplete",
          billingProvider: "stripe",
          billingInterval: "year",
        }),
      }),
    ]);
    expect(await auditOf(h, tenantId, "billing.checkout_started")).toEqual([
      expect.objectContaining({
        actor_account_id: founder.id,
        target_type: "subscription",
        target_id: subscription?.["id"],
        details: expect.objectContaining({
          checkoutSessionId: subscription?.["checkout_session_id"],
          planCode: "starter",
          billingInterval: "year",
          trialDays: 14,
        }),
      }),
    ]);

    // The gate stays closed while the subscription is incomplete: nothing dispatches the job before the webhook.
    const dispatched = await h.t.app
      .get(ProvisioningDispatcher, { strict: false })
      .dispatch(answer.provisioningJob.id);
    expect(dispatched).toMatchObject({ dispatched: false, reason: "gate_closed" });
    expect(
      await rowsOf(
        h,
        "SELECT t.status, j.status AS job_status, j.attempt FROM platform.tenants t " +
          "JOIN platform.provisioning_jobs j ON j.tenant_id = t.id WHERE t.id = $1",
        [tenantId],
      ),
    ).toEqual([{ status: "provisioning", job_status: "queued", attempt: 0 }]);

    // A retry with the same key replays the answer without a second Checkout; the URL is never logged.
    const replay = await createTenant(
      h,
      founder.id,
      body("nordic", { planCode: "starter", billingInterval: "year" }),
      idempotencyKey,
    );
    expect([replay.status, replay.body]).toEqual([202, res.body]);
    expect(h.stripe.callsOf("checkout.sessions.create")).toHaveLength(1);
    expect(loggedText(h)).not.toContain(session.url);
  });

  it("[PBE-044 AC1] answers 422 PLAN_NOT_AVAILABLE to a plan without a Stripe Price for the interval or that is retired, and 400 without a plan; nothing is written and Stripe is not called", async () => {
    const founder = await insertAccount(h.pool);
    h.stripe.reset();
    const tenantsBefore = await rowsOf(h, "SELECT count(*)::int AS n FROM platform.tenants", []);

    for (const plan of [
      { planCode: "growth", billingInterval: "year" },
      { planCode: "retired", billingInterval: "month" },
      { planCode: "early_access", billingInterval: "month" },
      { planCode: "nosuchplan" },
    ] as const) {
      const res = await createTenant(h, founder.id, body("planless", plan));
      expect([plan.planCode, outcomeOf(res)]).toEqual([plan.planCode, "422 PLAN_NOT_AVAILABLE"]);
      expectResponseToMatch("createTenant", res, { document: "platform" });
    }
    const missing = await createTenant(h, founder.id, body("planless"));
    expect(outcomeOf(missing)).toBe("400 VALIDATION_FAILED");
    expect((missing.body as { error: { fieldErrors: unknown } }).error.fieldErrors).toEqual([
      { path: "/planCode", code: "required", message: expect.any(String) },
    ]);

    expect(await rowsOf(h, "SELECT count(*)::int AS n FROM platform.tenants", [])).toEqual(tenantsBefore);
    expect(h.stripe.calls).toEqual([]);
  });

  it("[PBE-044 AC2] a Stripe failure returns checkoutUrl null with checkoutError and keeps the OTA; createCheckoutSession later succeeds on the same incomplete row", async () => {
    const founder = await insertAccount(h.pool);
    h.stripe.reset();
    h.stripe.failNext("checkout.sessions.create", FakeStripe.apiError(503));

    const res = await createTenant(h, founder.id, body("fjordair", { planCode: "growth" }));

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const answer = res.body as Created;
    const tenantId = answer.tenant.id;
    expect(answer).toMatchObject({
      provisioningJob: { status: "queued" },
      checkoutUrl: null,
      checkoutError: { code: "PROVIDER_ERROR", message: CHECKOUT_ERROR_MESSAGE },
    });
    const [pending] = await subscriptionsOf(h, tenantId);
    expect(pending).toMatchObject({
      status: "incomplete",
      billing_interval: "month",
      checkout_session_id: null,
    });
    expect(await customersOf(h, tenantId)).toHaveLength(1);
    expect(h.t.logs.withMessage("billing.checkout_failed")).toEqual([
      expect.objectContaining({ tenantId, subscriptionId: pending?.["id"] }),
    ]);

    // The setup page's "Continue to payment": a new Checkout, the Customer reused, the incomplete row carried.
    const idempotencyKey = randomUUID();
    const later = await checkoutSession(
      h,
      founder.id,
      tenantId,
      { planCode: "starter", billingInterval: "month" },
      idempotencyKey,
    );

    expect(outcomeOf(later)).toBe("201");
    expectResponseToMatch("createCheckoutSession", later, { document: "platform" });
    const sessions = h.stripe.callsOf("checkout.sessions.create");
    expect(h.stripe.callsOf("customers.create")).toHaveLength(1);
    expect(sessions.at(-1)?.idempotencyKey).toBe(`checkout:${tenantId}:${idempotencyKey}`);
    const params = sessions.at(-1)?.params as { metadata: Row; line_items: unknown; subscription_data: Row };
    expect(params.metadata).toEqual({
      velexis_tenant_id: tenantId,
      velexis_subscription_id: pending?.["id"],
      velexis_plan_code: "starter",
    });
    expect(params.line_items).toEqual([{ price: STARTER.month, quantity: 1 }]);
    expect(params.subscription_data["trial_period_days"]).toBe(14);
    const [recorded] = await subscriptionsOf(h, tenantId);
    expect(recorded).toMatchObject({
      id: pending?.["id"],
      status: "incomplete",
      plan_code: "starter",
      billing_interval: "month",
      checkout_session_id: expect.stringMatching(/^cs_/),
    });
    const { url } = later.body as { url: string; expiresAt: string };
    expect(url).toBe(
      (h.stripe.get(String(recorded?.["checkout_session_id"])) as unknown as { url: string }).url,
    );

    // Idempotent: the same key replays the same URL; another body with that key is refused.
    const replay = await checkoutSession(
      h,
      founder.id,
      tenantId,
      { planCode: "starter", billingInterval: "month" },
      idempotencyKey,
    );
    expect([replay.status, replay.body]).toEqual([201, later.body]);
    const reused = await checkoutSession(
      h,
      founder.id,
      tenantId,
      { planCode: "starter", billingInterval: "year" },
      idempotencyKey,
    );
    expect(outcomeOf(reused)).toBe("409 IDEMPOTENCY_KEY_REUSED");
    expect(h.stripe.callsOf("checkout.sessions.create")).toHaveLength(sessions.length);
    expect(loggedText(h)).not.toContain(url);
  });

  it("[PBE-044 AC2] createCheckoutSession: the manual trial of an existing OTA gets a Checkout without a new row; a current Stripe subscription answers 409 CONFLICT; Stripe failing answers 502 PROVIDER_ERROR", async () => {
    const owner = await insertAccount(h.pool, { email: "owner.legacy@example.com" });
    const { tenant: manual } = await insertOta(h.pool, {
      tenant: { legal_name: "Legacy Travel AS" },
      subscription: {},
      members: [[owner, "owner"]],
    });
    const { tenant: paying } = await insertOta(h.pool, {
      subscription: {
        billing_provider: "stripe",
        status: "past_due",
        plan_code: "starter",
        provider_subscription_id: "sub_TestPbe044PastDue",
      },
      members: [[owner, "owner"]],
    });
    h.stripe.reset();

    const res = await checkoutSession(h, owner.id, manual.id, {
      planCode: "starter",
      billingInterval: "year",
    });

    expect(outcomeOf(res)).toBe("201");
    expectResponseToMatch("createCheckoutSession", res, { document: "platform" });
    expect(h.stripe.callsOf("customers.create")[0]?.params).toEqual({
      email: "owner.legacy@example.com",
      name: "Legacy Travel AS",
      metadata: { velexis_tenant_id: manual.id },
    });
    const params = h.stripe.callsOf("checkout.sessions.create")[0]?.params as {
      metadata: Row;
      subscription_data: Row;
    };
    expect(params.metadata).toEqual({ velexis_tenant_id: manual.id, velexis_plan_code: "starter" });
    expect(params.subscription_data["trial_period_days"]).toBe(14);
    expect(
      (await subscriptionsOf(h, manual.id)).map((row) => [row["billing_provider"], row["status"]]),
    ).toEqual([["manual", "trialing"]]);
    expect(await auditOf(h, manual.id, "billing.checkout_started")).toEqual([
      expect.objectContaining({ target_type: "tenant", target_id: manual.id }),
    ]);

    const conflict = await checkoutSession(h, owner.id, paying.id, {
      planCode: "starter",
      billingInterval: "month",
    });
    expect(outcomeOf(conflict)).toBe("409 CONFLICT");
    expect(detailsOf(conflict)).toEqual({ reason: "stripe_subscription_active" });
    expectResponseToMatch("createCheckoutSession", conflict, { document: "platform" });

    const unavailable = await checkoutSession(h, owner.id, manual.id, {
      planCode: "retired",
      billingInterval: "month",
    });
    expect(outcomeOf(unavailable)).toBe("422 PLAN_NOT_AVAILABLE");

    h.stripe.failNext("checkout.sessions.create", FakeStripe.connectionError());
    const failed = await checkoutSession(h, owner.id, manual.id, {
      planCode: "starter",
      billingInterval: "month",
    });
    expect(outcomeOf(failed)).toBe("502 PROVIDER_ERROR");
    expect(detailsOf(failed)).toEqual({ provider: "stripe" });
    expectResponseToMatch("createCheckoutSession", failed, { document: "platform" });
    // The manual row keeps its place whatever happened: the webhook replaces it (PBE-045).
    expect(await subscriptionsOf(h, manual.id)).toHaveLength(1);
  });

  it("[PBE-044 AC2] createCheckoutSession after a canceled Stripe subscription reuses the Customer without a trial; after an abandoned Checkout it gives the trial; neither writes a subscription row", async () => {
    const owner = await insertAccount(h.pool);
    // Canceled at the end of a paid period: the OTA had a Stripe subscription, so a new one gets no trial.
    const { tenant: canceled } = await insertOta(h.pool, {
      subscription: {
        billing_provider: "stripe",
        status: "canceled",
        plan_code: "starter",
        provider_subscription_id: "sub_TestPbe044Canceled",
        trial_ends_at: null,
      },
      members: [[owner, "owner"]],
    });
    // Abandoned Checkout, as billing.abandoned_checkouts (PBE-047) leaves it: Stripe never made a subscription.
    const { tenant: abandoned } = await insertOta(h.pool, {
      tenant: { status: "failed", activated_at: null },
      subscription: {
        billing_provider: "stripe",
        status: "incomplete_expired",
        plan_code: "starter",
        trial_ends_at: null,
      },
      members: [[owner, "owner"]],
    });
    for (const [tenantId, customerId] of [
      [canceled.id, "cus_TestPbe044Canceled"],
      [abandoned.id, "cus_TestPbe044Abandoned"],
    ] as const) {
      await insertRow(h.pool, "billing_customers", {
        tenant_id: tenantId,
        provider_customer_id: customerId,
        livemode: false,
      });
    }
    h.stripe.reset();

    for (const [tenantId, customerId, trialDays] of [
      [canceled.id, "cus_TestPbe044Canceled", null],
      [abandoned.id, "cus_TestPbe044Abandoned", 14],
    ] as const) {
      const before = await subscriptionsOf(h, tenantId);
      const idempotencyKey = randomUUID();

      const res = await checkoutSession(
        h,
        owner.id,
        tenantId,
        { planCode: "starter", billingInterval: "month" },
        idempotencyKey,
      );

      expect([tenantId, outcomeOf(res)]).toEqual([tenantId, "201"]);
      expectResponseToMatch("createCheckoutSession", res, { document: "platform" });
      const call = h.stripe.callsOf("checkout.sessions.create").at(-1);
      expect(call?.idempotencyKey).toBe(`checkout:${tenantId}:${idempotencyKey}`);
      expect(call?.params).toEqual(
        checkoutSessionParams({
          tenantId,
          customerId,
          priceId: STARTER.month,
          planCode: "starter",
          subscriptionId: null,
          trialDays,
          ...portalLinks(h, tenantId),
        }),
      );
      // No subscription row is written: the webhook inserts the Stripe one (PBE-045).
      expect(await subscriptionsOf(h, tenantId)).toEqual(before);
    }
    // PADR-0002 item 1: the stored Customers are reused, also after a cancellation.
    expect(h.stripe.callsOf("customers.create")).toEqual([]);
  });

  it("[PBE-044 AC3] owners get a Customer Portal URL with no-store; finance members, admins, agents and viewers get 403, non-members 404 [PF-72 AC1]", async () => {
    const owner = await insertAccount(h.pool);
    const finance = await insertAccount(h.pool);
    const admin = await insertAccount(h.pool);
    const agent = await insertAccount(h.pool);
    const viewer = await insertAccount(h.pool);
    const stranger = await insertAccount(h.pool);
    const { tenant } = await insertOta(h.pool, {
      subscription: { billing_provider: "stripe", status: "active", plan_code: "starter" },
      members: [
        [owner, "owner"],
        [finance, "finance"],
        [admin, "admin"],
        [agent, "agent"],
        [viewer, "viewer"],
      ],
    });
    await insertRow(h.pool, "billing_customers", {
      tenant_id: tenant.id,
      provider_customer_id: "cus_TestPbe044Portal",
      livemode: false,
    });
    h.stripe.reset();

    const res = await portalSession(h, owner.id, tenant.id);

    expect(outcomeOf(res)).toBe("201");
    expectResponseToMatch("createCustomerPortalSession", res, { document: "platform" });
    expect(res.headers["cache-control"]).toBe("no-store");
    const { url } = res.body as { url: string };
    expect(url).toMatch(/^https:\/\/billing\.stripe\.com\/p\/session\//);
    expect(h.stripe.callsOf("billingPortal.sessions.create").map((call) => call.params)).toEqual([
      {
        customer: "cus_TestPbe044Portal",
        return_url: `${h.t.config.PUBLIC_PORTAL_URL.replace(/\/+$/, "")}/otas/${tenant.id}/billing`,
      },
    ]);

    for (const [who, account] of [
      ["finance", finance],
      ["admin", admin],
      ["agent", agent],
      ["viewer", viewer],
    ] as const) {
      const portal = await portalSession(h, account.id, tenant.id);
      const checkout = await checkoutSession(h, account.id, tenant.id, {
        planCode: "starter",
        billingInterval: "month",
      });
      expect([who, outcomeOf(portal), outcomeOf(checkout)]).toEqual([who, "403 FORBIDDEN", "403 FORBIDDEN"]);
      expectResponseToMatch("createCustomerPortalSession", portal, { document: "platform" });
    }
    expect(outcomeOf(await portalSession(h, stranger.id, tenant.id))).toBe("404 NOT_FOUND");
    expect(h.stripe.callsOf("billingPortal.sessions.create")).toHaveLength(1);
    expect(loggedText(h)).not.toContain(url);

    // An OTA that never went through Checkout has no Customer yet.
    const { tenant: manual } = await insertOta(h.pool, { subscription: {}, members: [[owner, "owner"]] });
    const conflict = await portalSession(h, owner.id, manual.id);
    expect(outcomeOf(conflict)).toBe("409 CONFLICT");
    expect(detailsOf(conflict)).toEqual({ reason: "no_stripe_customer" });
    expectResponseToMatch("createCustomerPortalSession", conflict, { document: "platform" });

    h.stripe.failNext("billingPortal.sessions.create", FakeStripe.apiError(500));
    const failed = await portalSession(h, owner.id, tenant.id);
    expect(outcomeOf(failed)).toBe("502 PROVIDER_ERROR");
    expect(failed.headers["cache-control"]).not.toBe("no-store");
  });

  it("[PBE-044 AC2] retryProvisioning of a tenant failed by an abandoned Checkout returns a new checkoutUrl and waits for the payment", async () => {
    const founder = await insertAccount(h.pool);
    const created = (
      await createTenant(h, founder.id, body("polarjet", { planCode: "starter", billingInterval: "month" }))
    ).body as Created;
    const tenantId = created.tenant.id;
    const [abandoned] = await subscriptionsOf(h, tenantId);
    // As billing.abandoned_checkouts leaves it after 48 hours (PBE-047); the owner retries an hour later.
    await h.pool.query("UPDATE platform.subscriptions SET status = 'incomplete_expired' WHERE id = $1", [
      abandoned?.["id"],
    ]);
    await h.pool.query(
      "UPDATE platform.provisioning_jobs SET status = 'canceled', finished_at = now() WHERE id = $1",
      [created.provisioningJob.id],
    );
    await h.pool.query("UPDATE platform.tenants SET status = 'failed' WHERE id = $1", [tenantId]);
    h.t.clock.advance(49 * 60 * 60 * 1000);
    h.stripe.reset();

    const res = await h.t.http
      .post(`/v1/tenants/${tenantId}/provisioning/retry`)
      .set(await headersOf(h, founder.id))
      .send();

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("retryProvisioning", res, { document: "platform" });
    const answer = res.body as {
      job: { id: string; status: string; attempt: number };
      checkoutUrl: string | null;
    };
    expect(answer.job).toMatchObject({ status: "queued", attempt: 0 });
    const subscriptions = await subscriptionsOf(h, tenantId);
    expect(subscriptions.map((row) => [row["id"] === abandoned?.["id"], row["status"]])).toEqual([
      [true, "incomplete_expired"],
      [false, "incomplete"],
    ]);
    const renewed = subscriptions[1];
    expect(renewed).toMatchObject({
      plan_code: "starter",
      billing_interval: "month",
      checkout_session_id: expect.stringMatching(/^cs_/),
    });
    expect(answer.checkoutUrl).toBe(
      (h.stripe.get(String(renewed?.["checkout_session_id"])) as unknown as { url: string }).url,
    );
    // The Customer of the first Checkout is reused; the Session is the retry's own, keyed by its new job.
    expect(h.stripe.calls.map((call) => [call.method, call.idempotencyKey])).toEqual([
      ["checkout.sessions.create", `checkout:${tenantId}:${answer.job.id}`],
    ]);
    expect((h.stripe.callsOf("checkout.sessions.create")[0]?.params as { metadata: Row }).metadata).toEqual({
      velexis_tenant_id: tenantId,
      velexis_subscription_id: renewed?.["id"],
      velexis_plan_code: "starter",
    });
    expect(await rowsOf(h, "SELECT status FROM platform.tenants WHERE id = $1", [tenantId])).toEqual([
      { status: "provisioning" },
    ]);
    expect(await auditOf(h, tenantId, "provisioning_job.retried")).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ awaitingCheckout: true, subscriptionId: renewed?.["id"] }),
      }),
    ]);
  });

  it("[PBE-044] retryProvisioning of a failed OTA on a manual trial needs no Checkout: its job is dispatched as before M5", async () => {
    const owner = await insertAccount(h.pool);
    const { tenant } = await insertOta(h.pool, {
      tenant: { status: "failed", activated_at: null },
      subscription: {},
      members: [[owner, "owner"]],
    });
    h.stripe.reset();

    const res = await h.t.http
      .post(`/v1/tenants/${tenant.id}/provisioning/retry`)
      .set(await headersOf(h, owner.id))
      .send();

    expect(outcomeOf(res)).toBe("202");
    expect(res.body).toMatchObject({ job: { status: "running", attempt: 1 }, checkoutUrl: null });
    expect((await subscriptionsOf(h, tenant.id)).map((row) => row["status"])).toEqual(["trialing"]);
    expect(h.stripe.calls).toEqual([]);
  });

  it("never writes a token into a log line", () => {
    const logged = loggedText(h);
    for (const token of signed) {
      expect(logged).not.toContain(token.split(".")[2]);
    }
  });
});

// Last in the file: createTestApp empties this worker's Redis database, which the application above uses.
describe("with FEATURE_STRIPE_BILLING off", () => {
  let h: Harness;

  beforeAll(async () => {
    // A second application on its own database clone, with every switch off: the same start-up cost as above.
    h = await start({});
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await h?.t.close();
  }, SETUP_TIMEOUT_MS);

  it("[PBE-044 AC4] createTenant behaves as in M1, and both billing endpoints answer 403 FEATURE_DISABLED", async () => {
    const owner = await insertAccount(h.pool);
    const finance = await insertAccount(h.pool);

    const res = await createTenant(
      h,
      owner.id,
      body("arcticfly", { planCode: "starter", billingInterval: "year" }),
    );

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const answer = res.body as Created;
    expect(answer).toMatchObject({
      tenant: { planCode: "early_access", status: "provisioning" },
      // Dispatched at once: the gate of a manual trial is open.
      provisioningJob: { status: "running" },
      checkoutUrl: null,
    });
    expect(answer).not.toHaveProperty("checkoutError");
    expect(
      (await subscriptionsOf(h, answer.tenant.id)).map((row) => [row["billing_provider"], row["status"]]),
    ).toEqual([["manual", "trialing"]]);
    expect(await customersOf(h, answer.tenant.id)).toEqual([]);
    await insertMember(h.pool, { id: answer.tenant.id }, finance, "finance");

    const checkout = await checkoutSession(h, owner.id, answer.tenant.id, {
      planCode: "starter",
      billingInterval: "month",
    });
    const portal = await portalSession(h, owner.id, answer.tenant.id);
    for (const [operationId, denied] of [
      ["createCheckoutSession", checkout],
      ["createCustomerPortalSession", portal],
    ] as const) {
      expect([operationId, outcomeOf(denied), detailsOf(denied)]).toEqual([
        operationId,
        "403 FEATURE_DISABLED",
        { feature: "stripe_billing" },
      ]);
      expectResponseToMatch(operationId, denied, { document: "platform" });
    }
    // The role comes first: a finance member learns nothing about the switch.
    expect(outcomeOf(await portalSession(h, finance.id, answer.tenant.id))).toBe("403 FORBIDDEN");
    expect(h.stripe.calls).toEqual([]);
  });
});
