// StripeGateway and its clients (OBE-038; OADR-0010 points 1–3, 7, 8): the real `stripe` SDK client against a fake of
// the Stripe API on the loopback interface (test/helpers/fake-stripe.ts), so what is checked is what reaches Stripe
// over HTTP: the PaymentIntent's parameters, the metadata, the idempotency keys, the API version and the key. The
// tenant's payment connection comes from a fake platform cache and repository; no database, Redis or network.
import { randomBytes } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeStripe, type FakeStripe } from "../../../test/helpers/fake-stripe";
import type { ApiConfig } from "../../config";
import { STRIPE_CARD_BRANDS } from "../../storefront/storefront.mapper";
import type { PlatformCache } from "../../tenancy/platform-cache";
import type {
  PlatformPaymentConnection,
  PlatformReadRepository,
} from "../../tenancy/platform-read.repository";
import { failureKeptForKey, type GatewayContext, type GatewayPayment } from "../payment-gateway";
import {
  STRIPE_API_VERSION,
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
  StripeClientFactory,
  stripeClientOptions,
  type StripeApiEndpoint,
} from "./stripe-client.factory";
import {
  amadeusBrandOf,
  fromMinorUnits,
  parsePaymentConnection,
  PaymentAccountUnusableError,
  StripeCallError,
  StripeGateway,
  toMinorUnits,
} from "./stripe.gateway";

const TENANT_ID = "ten_01JA4CE5H8K1M4P7R0T3V6Y9B2";
const CTX: GatewayContext = Object.freeze({
  tenantId: TENANT_ID,
  environment: "test",
  requestId: "0b9f6c2e-3a1d-4c5e-8f7a-1b2c3d4e5f60",
});

/** Keys of Stripe's shapes, built at run time: never a real key, and new in every run. */
const SECRET_KEY = `sk_test_${randomBytes(18).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(18).toString("hex")}`;

function connection(overrides: Partial<PlatformPaymentConnection> = {}): PlatformPaymentConnection {
  return {
    id: "ppc_01JA4CE5H8K1M4P7R0T3V6Y9B3",
    tenantId: TENANT_ID,
    provider: "stripe",
    environment: "test",
    accountMode: "velexis",
    accountReference: null,
    publishableKey: null,
    supportedMethods: ["card"],
    captureMode: "manual",
    status: "active",
    statementDescriptorSuffix: "ALPHA TRAVEL",
    ...overrides,
  };
}

function config(values: Partial<Record<keyof ApiConfig, unknown>>): ConfigService<ApiConfig, true> {
  return { get: (key: keyof ApiConfig) => values[key] } as unknown as ConfigService<ApiConfig, true>;
}

let stripe: FakeStripe;
let row: PlatformPaymentConnection | null;
let logs: Array<[string, Record<string, unknown>, string]>;

function gatewayWith(
  keys: Partial<Record<keyof ApiConfig, unknown>>,
  endpoint?: StripeApiEndpoint,
): StripeGateway {
  const cache = {
    // As the platform cache stores it: JSON, parsed back on the way out.
    connection: async (
      _kind: string,
      _tenantId: string,
      _environment: string,
      load: () => Promise<unknown>,
      parse: (value: unknown) => unknown,
    ) => {
      const value = await load();
      return value === null ? null : (parse(JSON.parse(JSON.stringify(value))) ?? null);
    },
  } as unknown as PlatformCache;
  const platform = { paymentConnection: () => Promise.resolve(row) } as unknown as PlatformReadRepository;
  const logger = {
    setContext: () => undefined,
    info: (fields: Record<string, unknown>, message: string) => logs.push(["info", fields, message]),
    warn: (fields: Record<string, unknown>, message: string) => logs.push(["warn", fields, message]),
    error: (fields: Record<string, unknown>, message: string) => logs.push(["error", fields, message]),
  } as unknown as PinoLogger;
  return new StripeGateway(
    new StripeClientFactory(config({ APP_ENV: "test", ...keys }), endpoint ?? stripe.endpoint),
    cache,
    platform,
    logger,
  );
}

const velexisKeys = { STRIPE_SECRET_KEY_TEST: SECRET_KEY, STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY };

function payment(overrides: Partial<GatewayPayment> = {}): GatewayPayment {
  return {
    id: `pay_01JA4CF2R7V0Y3B6D9G2K5N8${randomBytes(2).toString("hex").toUpperCase()}`,
    checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2",
    providerPaymentId: null,
    currency: "EUR",
    amount: "1414.06",
    minorUnits: 2,
    version: 1,
    ...overrides,
  };
}

async function appErrorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

// The fake Stripe API listens on a port of its own for the whole file.
beforeAll(async () => {
  stripe = await startFakeStripe();
}, 30_000);

afterAll(async () => {
  await stripe?.close();
});

beforeEach(() => {
  stripe.reset();
  row = connection();
  logs = [];
});

describe("the Stripe clients", () => {
  it("pin the API version, a 10 s timeout and one network retry", () => {
    expect(stripeClientOptions(undefined)).toMatchObject({
      apiVersion: STRIPE_API_VERSION,
      timeout: 10_000,
      maxNetworkRetries: 1,
      telemetry: false,
    });
    expect([STRIPE_TIMEOUT_MS, STRIPE_MAX_NETWORK_RETRIES]).toEqual([10_000, 1]);
    // The version the installed SDK is typed for: an SDK upgrade fails here until the pin is moved on purpose.
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
    expect(stripeClientOptions(undefined)).not.toHaveProperty("host");
  });

  it("give a client only for an environment with both keys, and never with a test endpoint in production", () => {
    const factory = new StripeClientFactory(
      config({ APP_ENV: "test", ...velexisKeys, STRIPE_SECRET_KEY_LIVE: `sk_live_${"x".repeat(24)}` }),
    );

    expect(factory.velexisClient("test")).toBeInstanceOf(Stripe);
    expect(factory.velexisClient("test")).toBe(factory.velexisClient("test"));
    expect(factory.velexisPublishableKey("test")).toBe(PUBLISHABLE_KEY);
    // The live publishable key is missing: no live client, whatever the secret key.
    expect(factory.velexisClient("live")).toBeUndefined();
    expect(factory.hasVelexisAccount("live")).toBe(false);
    expect(() => new StripeClientFactory(config({ APP_ENV: "production" }), stripe.endpoint)).toThrow(
      /tests only/,
    );
  });
});

describe("the account of a tenant's environment (OADR-0010 point 1)", () => {
  it("is the Velexis account in velexis mode, with Velexis's publishable key and the connection's descriptor", async () => {
    const account = await gatewayWith(velexisKeys).account(CTX);

    expect(account).toEqual({
      connectionId: row?.id,
      provider: "stripe",
      accountMode: "velexis",
      publishableKey: PUBLISHABLE_KEY,
      accountId: null,
      statementDescriptor: "ALPHA TRAVEL",
      methods: ["card"],
    });
    expect(JSON.stringify(account)).not.toContain(SECRET_KEY);
  });

  it("answers 424 PAYMENT_PROVIDER_NOT_CONFIGURED, with the reason as the cause, when nothing can take payments", async () => {
    const cases: Array<[PlatformPaymentConnection | null, Record<string, unknown>, string]> = [
      [null, velexisKeys, "no_connection"],
      [connection({ provider: "adyen" }), velexisKeys, "provider_not_supported"],
      [connection({ status: "pending" }), velexisKeys, "connection_not_active"],
      [connection({ status: "disabled" }), velexisKeys, "connection_not_active"],
      [connection({ tenantId: "ten_01JA4CE5H8K1M4P7R0T3V6Y9ZZ" }), velexisKeys, "connection_environment"],
      [
        connection({ accountMode: "connect_standard", accountReference: "acct_test_alpha" }),
        velexisKeys,
        "account_mode_not_supported",
      ],
      [connection({ accountMode: "api_keys" }), velexisKeys, "account_mode_not_supported"],
      [connection(), {}, "no_velexis_keys"],
      [connection(), { STRIPE_SECRET_KEY_TEST: SECRET_KEY }, "no_velexis_keys"],
    ];
    for (const [connectionRow, keys, reason] of cases) {
      row = connectionRow;
      const gateway = gatewayWith(keys);

      const error = await appErrorOf(gateway.account(CTX));
      expect([reason, error.code, error.status]).toEqual([reason, "PAYMENT_PROVIDER_NOT_CONFIGURED", 424]);
      expect(error.cause).toBeInstanceOf(PaymentAccountUnusableError);
      expect((error.cause as PaymentAccountUnusableError).reason).toBe(reason);
      expect(await gateway.findAccount(CTX)).toBeNull();
    }
    expect(stripe.requests).toEqual([]);
  });

  it("lists no method when the connection enables no card payments", async () => {
    row = connection({ supportedMethods: ["paypal"] });

    expect((await gatewayWith(velexisKeys).account(CTX)).methods).toEqual([]);
  });

  it("reads a cached connection only in the shape the repository writes", () => {
    const valid = connection();

    expect(parsePaymentConnection(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    for (const broken of [
      null,
      "ppc",
      { ...valid, accountMode: "own" },
      { ...valid, status: "unknown" },
      { ...valid, supportedMethods: "card" },
      { ...valid, statementDescriptorSuffix: 7 },
    ]) {
      expect(parsePaymentConnection(broken)).toBeUndefined();
    }
  });
});

describe("a payment session (OADR-0010 points 2, 3, 7, 8)", () => {
  it("creates a PaymentIntent with manual capture, the four metadata keys and pi:create:<pay_id> [OBE-038 AC1]", async () => {
    const created = payment();

    const session = await gatewayWith(velexisKeys).createSession(CTX, created, {
      checkoutId: created.checkoutId ?? "",
      requireThreeDSecure: true,
    });

    expect(stripe.requests).toHaveLength(1);
    const [request] = stripe.requests;
    expect(request).toMatchObject({ method: "POST", path: "/v1/payment_intents" });
    expect(request?.headers["idempotency-key"]).toBe(`pi:create:${created.id}`);
    expect(request?.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    expect(request?.headers["authorization"]).toBe(`Bearer ${SECRET_KEY}`);
    expect(request?.form).toEqual({
      amount: "141406",
      currency: "eur",
      capture_method: "manual",
      payment_method_types: ["card"],
      payment_method_options: { card: { request_three_d_secure: "any" } },
      metadata: {
        velexis_tenant_id: TENANT_ID,
        velexis_environment: "test",
        checkout_id: created.checkoutId,
        payment_id: created.id,
      },
      statement_descriptor_suffix: "ALPHA TRAVEL",
    });
    expect(session.account.publishableKey).toBe(PUBLISHABLE_KEY);
    expect(session.state).toMatchObject({
      status: "requires_payment_method",
      amount: "1414.06",
      amountCapturable: "0.00",
      card: null,
      failure: null,
    });
    expect(session.state.providerPaymentId).toMatch(/^pi_/);
    expect(session.state.clientSecret).toMatch(/_secret_/);
  });

  it("asks for 3-D Secure when needed (automatic) unless the storefront requires it, and sends no empty descriptor", async () => {
    row = connection({ statementDescriptorSuffix: null });
    const created = payment({ currency: "JPY", amount: "35000", minorUnits: 0 });

    await gatewayWith(velexisKeys).createSession(CTX, created, {
      checkoutId: created.checkoutId ?? "",
      requireThreeDSecure: false,
    });

    const form = stripe.requests[0]?.form ?? {};
    expect(form["payment_method_options"]).toEqual({ card: { request_three_d_secure: "automatic" } });
    expect(form).not.toHaveProperty("statement_descriptor_suffix");
    expect([form["amount"], form["currency"]]).toEqual(["35000", "jpy"]);
  });

  it("retries an unreachable Stripe once with the same key, then answers 502 without Stripe's payload [OBE-038 AC2]", async () => {
    stripe.fail(2, "drop");
    const created = payment();

    const error = await appErrorOf(
      gatewayWith(velexisKeys).createSession(CTX, created, {
        checkoutId: created.checkoutId ?? "",
        requireThreeDSecure: false,
      }),
    );

    expect([error.code, error.status]).toEqual(["PAYMENT_PROVIDER_ERROR", 502]);
    expect(error.cause).toBeInstanceOf(StripeCallError);
    expect((error.cause as StripeCallError).type).toBe("StripeConnectionError");
    // No answer: the same key may still find what Stripe did.
    expect(failureKeptForKey(error)).toBe(false);
    expect(stripe.requests.map((request) => request.headers["idempotency-key"])).toEqual([
      `pi:create:${created.id}`,
      `pi:create:${created.id}`,
    ]);
    expect(logs.map(([level, , message]) => [level, message])).toEqual([
      ["warn", "payments.stripe_call_failed"],
    ]);
    expect(JSON.stringify(logs)).not.toContain(SECRET_KEY);
  });

  it("answers 502 for a Stripe API error, and succeeds when the retry gets through", async () => {
    stripe.fail(2, "server_error");
    const failed = payment();
    const gateway = gatewayWith(velexisKeys);

    const error = await appErrorOf(
      gateway.createSession(CTX, failed, { checkoutId: failed.checkoutId ?? "", requireThreeDSecure: false }),
    );
    expect([error.code, (error.cause as StripeCallError).statusCode]).toEqual([
      "PAYMENT_PROVIDER_ERROR",
      500,
    ]);
    // Stripe keeps a 5xx as the key's answer: the SDK's retry got it replayed, and so would any later request.
    expect(failureKeptForKey(error)).toBe(true);
    expect(stripe.requests.map((request) => request.headers["idempotency-key"])).toEqual([
      `pi:create:${failed.id}`,
      `pi:create:${failed.id}`,
    ]);

    stripe.reset();
    stripe.fail(1, "drop");
    const retried = payment();
    const session = await gateway.createSession(CTX, retried, {
      checkoutId: retried.checkoutId ?? "",
      requireThreeDSecure: false,
    });
    expect(session.state.status).toBe("requires_payment_method");
    expect(stripe.requests).toHaveLength(2);
  });
});

describe("a PaymentIntent after its session", () => {
  async function created(): Promise<{ gateway: StripeGateway; payment: GatewayPayment }> {
    const gateway = gatewayWith(velexisKeys);
    const draft = payment();
    const session = await gateway.createSession(CTX, draft, {
      checkoutId: draft.checkoutId ?? "",
      requireThreeDSecure: true,
    });
    stripe.reset();
    return { gateway, payment: { ...draft, providerPaymentId: session.state.providerPaymentId } };
  }

  it("sets a new amount with pi:update:<pay_id>:<version>", async () => {
    const { gateway, payment: current } = await created();

    const state = await gateway.updateAmount(CTX, { ...current, version: 3 }, "1415.26");

    expect(stripe.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/payment_intents/${current.providerPaymentId}`,
      form: { amount: "141526" },
    });
    expect(stripe.requests[0]?.headers["idempotency-key"]).toBe(`pi:update:${current.id}:3`);
    expect(state.amount).toBe("1415.26");
  });

  it("refuses an update key whose answer was lost with another amount, and keeps nothing for that refusal", async () => {
    const { gateway, payment: current } = await created();
    const version3 = { ...current, version: 3 };
    stripe.fail(2, "lost");

    const lost = await appErrorOf(gateway.updateAmount(CTX, version3, "1415.26"));

    // Stripe set the amount, the answer never came: nothing says the key is spent.
    expect([lost.code, failureKeptForKey(lost)]).toEqual(["PAYMENT_PROVIDER_ERROR", false]);
    expect(stripe.intents.get(current.providerPaymentId ?? "")?.amount).toBe(141526);

    const refused = await appErrorOf(gateway.updateAmount(CTX, version3, "1416.00"));

    expect([refused.code, (refused.cause as StripeCallError).statusCode, failureKeptForKey(refused)]).toEqual(
      ["PAYMENT_PROVIDER_ERROR", 400, false],
    );
    // The service moves the payment's version on after a failed update (payments.service.ts): the next key is new.
    const state = await gateway.updateAmount(CTX, { ...current, version: 4 }, "1416.00");
    expect(state.amount).toBe("1416.00");
    expect(stripe.requests.map((request) => request.headers["idempotency-key"])).toEqual([
      `pi:update:${current.id}:3`,
      `pi:update:${current.id}:3`,
      `pi:update:${current.id}:3`,
      `pi:update:${current.id}:4`,
    ]);
  });

  it("reads the confirmed state back: authorised, the card's brand and last 4, the 3-D Secure outcome", async () => {
    const { gateway, payment: current } = await created();
    stripe.update(current.providerPaymentId ?? "", {
      status: "requires_capture",
      amount_capturable: 141406,
      payment_method: {
        id: "pm_test_card",
        object: "payment_method",
        card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
      },
      latest_charge: {
        id: "ch_test_charge",
        object: "charge",
        payment_method_details: { card: { three_d_secure: { result: "authenticated", version: "2.2.0" } } },
      },
    });

    const state = await gateway.refresh(CTX, current);

    expect(stripe.requests[0]?.query).toEqual({ expand: ["payment_method", "latest_charge"] });
    expect(state).toEqual({
      providerPaymentId: current.providerPaymentId,
      status: "authorized",
      amount: "1414.06",
      amountCapturable: "1414.06",
      amountReceived: "0.00",
      card: { brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 },
      threeDSecure: { status: "authenticated", version: "2.2.0" },
      failure: null,
      // Confirmed: the browser has nothing left to confirm.
      clientSecret: null,
    });
  });

  it("maps a declined attempt to PAYMENT_DECLINED with Stripe's decline code", async () => {
    const { gateway, payment: current } = await created();
    stripe.update(current.providerPaymentId ?? "", {
      last_payment_error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" },
    });

    const state = await gateway.refresh(CTX, current);

    expect([state.status, state.failure]).toEqual([
      "requires_payment_method",
      { code: "PAYMENT_DECLINED", declineCode: "insufficient_funds" },
    ]);
    expect(state.clientSecret).toMatch(/_secret_/);
  });

  it("captures with pi:capture:<pay_id>:<amount>, cancels with pi:cancel:<pay_id> and refunds with refund:<rfd_id>", async () => {
    const other = (await created()).payment;
    const { gateway, payment: current } = await created();
    stripe.update(current.providerPaymentId ?? "", { status: "requires_capture", amount_capturable: 141406 });

    const captured = await gateway.capture(CTX, current, "1414.06");
    const refund = await gateway.refund(CTX, {
      id: "rfd_01JA4CF2R7V0Y3B6D9G2K5N8Q1",
      paymentId: current.id,
      providerPaymentId: current.providerPaymentId ?? "",
      currency: "EUR",
      amount: "100.00",
      minorUnits: 2,
    });
    const voided = await gateway.void(CTX, other);

    expect(stripe.requests.map((request) => [request.path, request.headers["idempotency-key"]])).toEqual([
      [`/v1/payment_intents/${current.providerPaymentId}/capture`, `pi:capture:${current.id}:1414.06`],
      ["/v1/refunds", "refund:rfd_01JA4CF2R7V0Y3B6D9G2K5N8Q1"],
      [`/v1/payment_intents/${other.providerPaymentId}/cancel`, `pi:cancel:${other.id}`],
    ]);
    expect(stripe.requests[1]?.form).toMatchObject({
      payment_intent: current.providerPaymentId,
      amount: "10000",
      metadata: { velexis_tenant_id: TENANT_ID, payment_id: current.id },
    });
    expect([captured.status, captured.amountReceived]).toEqual(["captured", "1414.06"]);
    expect(refund).toMatchObject({ status: "pending", amount: "100.00" });
    expect(voided.status).toBe("canceled");
  });

  it("[FIX-W28-CANCEL AC1] captures a cancellation's kept amount with its own key; Stripe releases the rest", async () => {
    const { gateway, payment: current } = await created();
    stripe.update(current.providerPaymentId ?? "", { status: "requires_capture", amount_capturable: 141406 });

    const captured = await gateway.capture(CTX, current, "25.00", "cancellation");

    expect(stripe.requests.map((request) => [request.path, request.headers["idempotency-key"]])).toEqual([
      [
        `/v1/payment_intents/${current.providerPaymentId}/capture`,
        `pi:capture:${current.id}:cancellation:25.00`,
      ],
    ]);
    // amount_to_capture below the authorisation: the rest is released.
    expect(stripe.requests[0]?.form).toEqual({ amount_to_capture: "2500" });
    expect([captured.status, captured.amountReceived, captured.amountCapturable]).toEqual([
      "captured",
      "25.00",
      "0.00",
    ]);
  });

  it("refuses a PaymentIntent whose metadata names another payment, as a security event", async () => {
    const { gateway, payment: current } = await created();
    stripe.update(current.providerPaymentId ?? "", {
      metadata: { velexis_tenant_id: "ten_01JA4CE5H8K1M4P7R0T3V6Y9ZZ", payment_id: current.id },
    });

    const error = await appErrorOf(gateway.refresh(CTX, current));

    expect(error.code).toBe("PAYMENT_PROVIDER_ERROR");
    expect(logs).toEqual([
      [
        "warn",
        {
          securityEvent: "payments.provider_metadata_mismatch",
          paymentId: current.id,
          tenantId: TENANT_ID,
        },
        "payments.provider_metadata_mismatch",
      ],
    ]);
  });
});

describe("amounts and brands", () => {
  it("convert decimal amounts to Stripe's minor units and back, never losing a fraction", () => {
    expect([toMinorUnits("1414.06", 2), toMinorUnits("1414.6", 2), toMinorUnits("35000", 0)]).toEqual([
      141406, 141460, 35000,
    ]);
    expect([fromMinorUnits(141406, 2), fromMinorUnits(35000, 0), fromMinorUnits(5, 3)]).toEqual([
      "1414.06",
      "35000",
      "0.005",
    ]);
    expect(() => toMinorUnits("10.005", 2)).toThrow(RangeError);
    expect(() => toMinorUnits("-1.00", 2)).toThrow(RangeError);
  });

  it("names Stripe's card brands as Amadeus brands where one matches", () => {
    expect(["visa", "mastercard", "amex", "diners", "jcb"].map(amadeusBrandOf)).toEqual([
      "VISA",
      "MASTERCARD",
      "AMERICAN_EXPRESS",
      "DINERS",
      "JCB",
    ]);
  });

  it("names every Stripe brand the storefront offers as an Amadeus brand of that same Stripe brand", () => {
    // The gateway keeps its own table (payments never imports the storefront module): it must not drift from the
    // storefront's `pspCardBrands`.
    for (const [amadeus, stripeBrand] of Object.entries(STRIPE_CARD_BRANDS)) {
      const named = amadeusBrandOf(stripeBrand?.psp ?? "") as keyof typeof STRIPE_CARD_BRANDS;
      expect([amadeus, STRIPE_CARD_BRANDS[named]?.psp]).toEqual([amadeus, stripeBrand?.psp]);
    }
  });
});
