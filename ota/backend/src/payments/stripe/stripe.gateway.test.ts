// StripeGateway and its clients (OBE-038, OBE-077; OADR-0010 points 1–3, 7, 8): the real `stripe` SDK client against a
// fake of the Stripe API on the loopback interface (test/helpers/fake-stripe.ts), so what is checked is what reaches
// Stripe over HTTP: the PaymentIntent's parameters, the metadata, the idempotency keys, the API version, the key and the
// `Stripe-Account` header of each account mode. The tenant's payment connection comes from a fake platform cache and
// repository; an `api_keys` connection's key is encrypted with the test KEKs (test/helpers/api-env.ts) as the platform
// stores it; no database, Redis or network.
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { ConfigService } from "@nestjs/config";
import { encryptValue, type KeyProvider } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testKeyProvider } from "../../../test/helpers/api-env";
import { startFakeStripe, type FakeStripe, type FakeStripeRequest } from "../../../test/helpers/fake-stripe";
import type { ApiConfig } from "../../config";
import {
  paymentConfigFor,
  STRIPE_CARD_BRANDS,
  VELEXIS_MERCHANT_PREFIX,
  type StorefrontBase,
} from "../../storefront/storefront.mapper";
import type { PlatformCache } from "../../tenancy/platform-cache";
import type {
  PlatformPaymentConnection,
  PlatformReadRepository,
} from "../../tenancy/platform-read.repository";
import {
  failureKeptForKey,
  paymentAccountOf,
  paymentMetadataFor,
  recordedPaymentAccount,
  samePaymentAccount,
  VELEXIS_PAYMENT_ACCOUNT,
  type GatewayAccount,
  type GatewayContext,
  type GatewayPayment,
  type GatewayPaymentAccount,
} from "../payment-gateway";
import {
  connectionSecretAad,
  STRIPE_API_VERSION,
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
  StripeAccountUnavailableError,
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
/** The OTA's own keys of an `api_keys` connection (a restricted key, as PADR-0011 point 5 allows), new in every run. */
const OTA_SECRET_KEY = `rk_test_${randomBytes(18).toString("hex")}`;
const OTA_PUBLISHABLE_KEY = `pk_test_${randomBytes(18).toString("hex")}`;
/** The OTA's Stripe accounts: connected through Connect, and the one of its own keys. */
const CONNECT_ACCOUNT = "acct_1OtaAlphaConnect000000";
const OWN_ACCOUNT = "acct_1OtaAlphaOwnKeys000000";
const CONNECTION_ID = "ppc_01JA4CE5H8K1M4P7R0T3V6Y9B3";

function connection(overrides: Partial<PlatformPaymentConnection> = {}): PlatformPaymentConnection {
  return {
    id: CONNECTION_ID,
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
    secretCiphertext: null,
    ...overrides,
  };
}

/** The platform's ciphertext of `secret` for the connection `connectionId` (base64, as the connection row holds it). */
async function sealed(secret: string, connectionId = CONNECTION_ID): Promise<string> {
  const { ciphertext } = await encryptValue(Buffer.from(secret, "utf8"), {
    aad: connectionSecretAad(connectionId),
    keys,
  });
  return Buffer.from(ciphertext).toString("base64");
}

/** The tenant's connection in each mode (the platform's CHECK shapes; a suffix left on every row). */
const rows = {
  velexis: (): PlatformPaymentConnection => connection(),
  connect_standard: (): PlatformPaymentConnection =>
    connection({ accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT }),
  api_keys: async (secret = OTA_SECRET_KEY): Promise<PlatformPaymentConnection> =>
    connection({
      accountMode: "api_keys",
      accountReference: OWN_ACCOUNT,
      publishableKey: OTA_PUBLISHABLE_KEY,
      secretCiphertext: await sealed(secret),
    }),
};

function config(values: Partial<Record<keyof ApiConfig, unknown>>): ConfigService<ApiConfig, true> {
  return { get: (key: keyof ApiConfig) => values[key] } as unknown as ConfigService<ApiConfig, true>;
}

let stripe: FakeStripe;
let row: PlatformPaymentConnection | null;
let logs: Array<[string, Record<string, unknown>, string]>;
/** The test KEKs, as the platform and the API load them. */
let keys: KeyProvider;
/** How many data keys were unwrapped (one per decryption) since the last `beforeEach`. */
let unwraps: number;
/** `keys`, counting its unwraps. */
let countingKeys: KeyProvider;

function gatewayWith(
  velexis: Partial<Record<keyof ApiConfig, unknown>>,
  endpoint?: StripeApiEndpoint,
): StripeGateway {
  return gatewayOf(factoryWith(velexis, endpoint));
}

function factoryWith(
  velexis: Partial<Record<keyof ApiConfig, unknown>>,
  endpoint?: StripeApiEndpoint,
): StripeClientFactory {
  return new StripeClientFactory(
    config({ APP_ENV: "test", ...velexis }),
    countingKeys,
    endpoint ?? stripe.endpoint,
  );
}

function gatewayOf(factory: StripeClientFactory): StripeGateway {
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
  return new StripeGateway(factory, cache, platform, logger);
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
    account: VELEXIS_PAYMENT_ACCOUNT,
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

// The fake Stripe API listens on a port of its own for the whole file; the test KEKs are read once (the key folder of
// test/helpers/api-env.ts, created by the first test process that needs it). Budget: 30 s for both.
beforeAll(async () => {
  stripe = await startFakeStripe();
  keys = await testKeyProvider();
  countingKeys = {
    currentKekId: () => keys.currentKekId(),
    wrap: (dek) => keys.wrap(dek),
    unwrap: (wrapped, kekId) => {
      unwraps += 1;
      return keys.unwrap(wrapped, kekId);
    },
  };
}, 30_000);

afterAll(async () => {
  await stripe?.close();
});

beforeEach(() => {
  stripe.reset();
  row = connection();
  logs = [];
  unwraps = 0;
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
      countingKeys,
    );

    expect(factory.velexisClient("test")).toBeInstanceOf(Stripe);
    expect(factory.velexisClient("test")).toBe(factory.velexisClient("test"));
    expect(factory.velexisPublishableKey("test")).toBe(PUBLISHABLE_KEY);
    // The live publishable key is missing: no live client, whatever the secret key.
    expect(factory.velexisClient("live")).toBeUndefined();
    expect(factory.hasVelexisAccount("live")).toBe(false);
    expect(
      () => new StripeClientFactory(config({ APP_ENV: "production" }), countingKeys, stripe.endpoint),
    ).toThrow(/tests only/);
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
      accountReference: null,
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
      [connection({ environment: "live" }), velexisKeys, "connection_environment"],
      // A row of the OTA's own account must be complete for its mode (the platform's CHECK says the same).
      [connection({ accountMode: "connect_standard" }), velexisKeys, "connection_incomplete"],
      [
        connection({ accountMode: "connect_standard", accountReference: "acct-not-an-account" }),
        velexisKeys,
        "connection_incomplete",
      ],
      [{ ...(await rows.api_keys()), secretCiphertext: null }, velexisKeys, "connection_incomplete"],
      [{ ...(await rows.api_keys()), publishableKey: null }, velexisKeys, "connection_incomplete"],
      [
        { ...(await rows.api_keys()), publishableKey: `pk_live_${"x".repeat(24)}` },
        velexisKeys,
        "connection_incomplete",
      ],
      [{ ...(await rows.api_keys()), accountReference: null }, velexisKeys, "connection_incomplete"],
      [connection(), {}, "no_velexis_keys"],
      [connection(), { STRIPE_SECRET_KEY_TEST: SECRET_KEY }, "no_velexis_keys"],
      // Connect calls are made with the Velexis key: none, no account.
      [rows.connect_standard(), {}, "no_velexis_keys"],
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
    expect(unwraps).toBe(0);
  });

  it("serves an api_keys account without its Velexis keys, and never decrypts its key to say so", async () => {
    row = await rows.api_keys();

    const account = await gatewayWith({}).account(CTX);

    expect(account).toMatchObject({ accountMode: "api_keys", publishableKey: OTA_PUBLISHABLE_KEY });
    // The storefront and checkout.createPayment's check need the public side only.
    expect(unwraps).toBe(0);
  });

  it("lists no method when the connection enables no card payments", async () => {
    row = connection({ supportedMethods: ["paypal"] });

    expect((await gatewayWith(velexisKeys).account(CTX)).methods).toEqual([]);
  });

  it("reads a cached connection only in the shape the repository writes", () => {
    const valid = connection();
    const own = { ...valid, accountMode: "api_keys" as const, secretCiphertext: "AAAA" };

    expect(parsePaymentConnection(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    expect(parsePaymentConnection(JSON.parse(JSON.stringify(own)))).toEqual(own);
    const { secretCiphertext: _dropped, ...before } = valid;
    for (const broken of [
      null,
      "ppc",
      { ...valid, accountMode: "own" },
      { ...valid, status: "unknown" },
      { ...valid, supportedMethods: "card" },
      { ...valid, statementDescriptorSuffix: 7 },
      { ...valid, secretCiphertext: 7 },
      // An entry cached before OBE-077 (no `secretCiphertext`) is a miss and is read again.
      before,
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
      account: current.account,
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

/** The settings' side of StorefrontPaymentConfig, as `toCachedStorefront` caches it (no method, no account). */
const STOREFRONT_PAYMENT: StorefrontBase["payment"] = {
  provider: "stripe",
  environment: "test",
  accountMode: "velexis",
  publishableKey: "",
  accountId: null,
  merchantName: "Alpha Travel",
  statementDescriptor: null,
  supportedMethods: [],
  cardBrands: ["VISA", "MASTERCARD"],
  pspCardBrands: [
    { amadeus: "VISA", psp: "visa", label: "Visa" },
    { amadeus: "MASTERCARD", psp: "mastercard", label: "Mastercard" },
  ],
  merchantCountry: "NO",
  threeDSecure: "automatic",
};

/** What one request carried to Stripe: its key and its `Stripe-Account` header. */
function credentialsOf(request: FakeStripeRequest | undefined): [string | undefined, string | undefined] {
  return [request?.headers["authorization"], request?.headers["stripe-account"]];
}

/** Everything a value shows when it is logged or serialised: JSON, `util.inspect` with its causes, its message. */
function exposed(value: unknown): string {
  const error = value instanceof Error ? value : undefined;
  return [
    JSON.stringify(value),
    inspect(value, { depth: 10, showHidden: true }),
    error?.message ?? "",
    error?.stack ?? "",
    String(error?.cause ?? ""),
    error?.cause instanceof Error ? (error.cause.stack ?? "") : "",
  ].join("\n");
}

describe("the three account modes (OBE-077, OADR-0010 point 1)", () => {
  // One table, one code path: the key, the Stripe-Account header and the storefront configuration of each mode.
  const MODES = [
    {
      mode: "velexis",
      row: () => Promise.resolve(rows.velexis()),
      key: () => SECRET_KEY,
      stripeAccount: undefined,
      descriptor: "ALPHA TRAVEL",
      storefront: () => ({
        accountMode: "velexis",
        publishableKey: PUBLISHABLE_KEY,
        accountId: null,
        merchantName: `${VELEXIS_MERCHANT_PREFIX} Alpha Travel`,
        statementDescriptor: "ALPHA TRAVEL",
        supportedMethods: ["card"],
      }),
      recorded: { accountMode: "velexis", accountReference: null },
    },
    {
      mode: "connect_standard",
      row: () => Promise.resolve(rows.connect_standard()),
      key: () => SECRET_KEY,
      stripeAccount: CONNECT_ACCOUNT,
      descriptor: undefined,
      storefront: () => ({
        accountMode: "connect_standard",
        publishableKey: PUBLISHABLE_KEY,
        accountId: CONNECT_ACCOUNT,
        merchantName: "Alpha Travel",
        statementDescriptor: null,
        supportedMethods: ["card"],
      }),
      recorded: { accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT },
    },
    {
      mode: "api_keys",
      row: () => rows.api_keys(),
      key: () => OTA_SECRET_KEY,
      stripeAccount: undefined,
      descriptor: undefined,
      storefront: () => ({
        accountMode: "api_keys",
        publishableKey: OTA_PUBLISHABLE_KEY,
        accountId: null,
        merchantName: "Alpha Travel",
        statementDescriptor: null,
        supportedMethods: ["card"],
      }),
      recorded: { accountMode: "api_keys", accountReference: OWN_ACCOUNT },
    },
  ] as const;

  it.each(MODES)(
    "[OBE-077 AC1] $mode: the storefront configuration of the account [OF-12 AC1]",
    async ({ row: rowOf, storefront }) => {
      row = await rowOf();

      const account = await gatewayWith(velexisKeys).findAccount(CTX);

      expect(paymentConfigFor(STOREFRONT_PAYMENT, account)).toMatchObject({
        provider: "stripe",
        ...storefront(),
      });
      expect(JSON.stringify(account)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(account)).not.toContain(OTA_SECRET_KEY);
      expect(unwraps).toBe(0);
    },
  );

  it.each(MODES)(
    "[OBE-077 AC1] $mode: the key and the Stripe-Account header of every call [OF-12 AC1]",
    async ({ row: rowOf, key, stripeAccount, descriptor, recorded }) => {
      row = await rowOf();
      const gateway = gatewayWith(velexisKeys);
      const account = await gateway.account(CTX);
      // The row as payments.service.ts inserts it: with the account it is created on.
      const draft = payment({ account: paymentAccountOf(account) });
      expect(draft.account).toEqual(recorded);

      const session = await gateway.createSession(CTX, draft, {
        checkoutId: draft.checkoutId ?? "",
        requireThreeDSecure: false,
      });
      const created = { ...draft, providerPaymentId: session.state.providerPaymentId };
      await gateway.updateAmount(CTX, created, "1415.26");
      stripe.update(created.providerPaymentId, { status: "requires_capture", amount_capturable: 141526 });
      await gateway.refresh(CTX, created);
      await gateway.capture(CTX, created, "1415.26");
      await gateway.refund(CTX, {
        id: "rfd_01JA4CF2R7V0Y3B6D9G2K5N8Q1",
        paymentId: created.id,
        providerPaymentId: created.providerPaymentId,
        currency: "EUR",
        amount: "100.00",
        minorUnits: 2,
        account: created.account,
      });
      await gateway.void(CTX, created);

      expect(stripe.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "POST /v1/payment_intents",
        `POST /v1/payment_intents/${created.providerPaymentId}`,
        `GET /v1/payment_intents/${created.providerPaymentId}`,
        `POST /v1/payment_intents/${created.providerPaymentId}/capture`,
        "POST /v1/refunds",
        `POST /v1/payment_intents/${created.providerPaymentId}/cancel`,
      ]);
      for (const request of stripe.requests) {
        expect(credentialsOf(request)).toEqual([`Bearer ${key()}`, stripeAccount]);
        expect(request.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
      }
      // The statement descriptor suffix carries the OTA's brand in `velexis` mode only (ADR-0011 (A)).
      expect(stripe.requests[0]?.form["statement_descriptor_suffix"]).toBe(descriptor);
      expect(session.account).toEqual(account);
      // The OTA's key is decrypted for each call and kept by none: six calls, six decryptions in api_keys mode.
      expect(unwraps).toBe(recorded.accountMode === "api_keys" ? 6 : 0);
    },
  );
});

describe("existing payments keep the account they were created on (OBE-077 step 3, PADR-0011 point 7)", () => {
  /** A payment created in the current mode, with its PaymentIntent authorised. */
  async function authorised(gateway: StripeGateway): Promise<GatewayPayment & { providerPaymentId: string }> {
    const draft = payment({ account: paymentAccountOf(await gateway.account(CTX)) });
    const session = await gateway.createSession(CTX, draft, {
      checkoutId: draft.checkoutId ?? "",
      requireThreeDSecure: false,
    });
    stripe.update(session.state.providerPaymentId, { status: "requires_capture", amount_capturable: 141406 });
    return { ...draft, providerPaymentId: session.state.providerPaymentId };
  }

  it("captures a connect_standard payment on its connected account after the switch back to velexis", async () => {
    row = rows.connect_standard();
    const gateway = gatewayWith(velexisKeys);
    const connected = await authorised(gateway);
    row = rows.velexis();
    stripe.reset();

    await gateway.capture(CTX, connected, "1414.06");
    const fresh = await authorised(gateway);

    expect(stripe.requests.map(credentialsOf)).toEqual([
      // The old payment: the Velexis key with its own account.
      [`Bearer ${SECRET_KEY}`, CONNECT_ACCOUNT],
      // New payments: the account the connection names now.
      [`Bearer ${SECRET_KEY}`, undefined],
    ]);
    expect(fresh.account).toEqual(VELEXIS_PAYMENT_ACCOUNT);
  });

  it("captures and voids velexis payments with the Velexis key after a switch to the OTA's own keys", async () => {
    const gateway = gatewayWith(velexisKeys);
    const before = await authorised(gateway);
    // A payment written before OBE-077 has no record: it is a velexis one.
    const legacy = { ...(await authorised(gateway)), account: null };
    row = await rows.api_keys();
    stripe.reset();

    await gateway.capture(CTX, before, "1414.06");
    await gateway.void(CTX, legacy);
    await gateway.createSession(CTX, payment({ account: paymentAccountOf(await gateway.account(CTX)) }), {
      checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2",
      requireThreeDSecure: false,
    });

    expect(stripe.requests.map(credentialsOf)).toEqual([
      [`Bearer ${SECRET_KEY}`, undefined],
      [`Bearer ${SECRET_KEY}`, undefined],
      [`Bearer ${OTA_SECRET_KEY}`, undefined],
    ]);
  });

  it("serves an api_keys payment with the account's current key, and refuses it once the account is gone", async () => {
    row = await rows.api_keys();
    const gateway = gatewayWith(velexisKeys);
    const own = await authorised(gateway);
    // The OTA rolls its key on the same account: the platform stores the new one, the next read of the row serves it.
    const rolled = `rk_test_${randomBytes(18).toString("hex")}`;
    row = await rows.api_keys(rolled);
    stripe.reset();

    await gateway.refresh(CTX, own);
    expect(stripe.requests.map(credentialsOf)).toEqual([[`Bearer ${rolled}`, undefined]]);

    // Another account of its own, then back to Velexis: the old account's key is no longer stored.
    for (const next of [
      { ...(await rows.api_keys()), accountReference: "acct_1OtaAlphaOtherKeys0000" },
      rows.velexis(),
      rows.connect_standard(),
      null,
    ]) {
      row = next;
      stripe.reset();

      const error = await appErrorOf(gateway.capture(CTX, own, "1414.06"));

      expect([error.code, (error.cause as PaymentAccountUnusableError).reason]).toEqual([
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "payment_account_unavailable",
      ]);
      expect(stripe.requests).toEqual([]);
    }
  });

  // Lead decision (2i) of 2026-10-30, third batch: the OTA connected (Connect Standard) the very account its own keys
  // belonged to. Before, its api_keys payments answered 424 from then on (their key was no longer stored).
  const MOVED = [
    {
      name: "connect_standard on the payment's account (active)",
      next: () => ({ ...rows.connect_standard(), accountReference: OWN_ACCOUNT }),
      expected: [`Bearer ${SECRET_KEY}`, OWN_ACCOUNT] as const,
    },
    {
      name: "connect_standard on the payment's account (disabled: the account is still the OTA's)",
      next: () => ({ ...rows.connect_standard(), accountReference: OWN_ACCOUNT, status: "disabled" }),
      expected: [`Bearer ${SECRET_KEY}`, OWN_ACCOUNT] as const,
    },
    {
      name: "api_keys on the payment's account",
      next: () => rows.api_keys(),
      expected: [`Bearer ${OTA_SECRET_KEY}`, undefined] as const,
    },
    {
      name: "connect_standard on another account",
      next: () => rows.connect_standard(),
      expected: "payment_account_unavailable",
    },
    {
      name: "connect_standard on the payment's account, of another environment",
      next: () => ({ ...rows.connect_standard(), accountReference: OWN_ACCOUNT, environment: "live" }),
      expected: "payment_account_unavailable",
    },
    {
      name: "connect_standard on the payment's account, of another tenant",
      next: () => ({
        ...rows.connect_standard(),
        accountReference: OWN_ACCOUNT,
        tenantId: "ten_01JA4CG3S8W1Z4C7F0H3L6P9T9",
      }),
      expected: "payment_account_unavailable",
    },
    { name: "velexis", next: () => rows.velexis(), expected: "payment_account_unavailable" },
    { name: "no connection", next: () => null, expected: "payment_account_unavailable" },
  ] as const;

  it.each(MOVED)(
    "[FIX-W36-OTA AC6] captures, voids and refunds an api_keys payment after a switch to $name",
    async ({ next, expected }) => {
      row = await rows.api_keys();
      const gateway = gatewayWith(velexisKeys);
      const own = await authorised(gateway);
      expect(own.account).toEqual({ accountMode: "api_keys", accountReference: OWN_ACCOUNT });
      // The api_keys row is sealed with the test KEKs (asynchronous); the others are plain rows.
      row = (await next()) as PlatformPaymentConnection | null;
      stripe.reset();
      const calls = [
        () => gateway.capture(CTX, own, "1414.06"),
        () =>
          gateway.refund(CTX, {
            id: "rfd_01JA4CF2R7V0Y3B6D9G2K5N8Q1",
            paymentId: own.id,
            providerPaymentId: own.providerPaymentId,
            currency: "EUR",
            amount: "100.00",
            minorUnits: 2,
            account: own.account,
          }),
        () => gateway.void(CTX, own),
      ];

      if (typeof expected === "string") {
        for (const run of calls) {
          const error = await appErrorOf(run());
          expect([error.code, error.status, (error.cause as PaymentAccountUnusableError).reason]).toEqual([
            "PAYMENT_PROVIDER_NOT_CONFIGURED",
            424,
            expected,
          ]);
        }
        expect(stripe.requests).toEqual([]);
        return;
      }
      for (const run of calls) {
        await run();
      }
      expect(stripe.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        `POST /v1/payment_intents/${own.providerPaymentId}/capture`,
        "POST /v1/refunds",
        `POST /v1/payment_intents/${own.providerPaymentId}/cancel`,
      ]);
      expect(stripe.requests.map(credentialsOf)).toEqual([expected, expected, expected]);
    },
  );

  it("[FIX-W36-OTA AC6] answers 424 no_velexis_keys for a payment moved to Connect when the environment has no Velexis keys", async () => {
    row = await rows.api_keys();
    const own = await authorised(gatewayWith(velexisKeys));
    row = { ...rows.connect_standard(), accountReference: OWN_ACCOUNT };
    stripe.reset();

    const error = await appErrorOf(gatewayWith({}).capture(CTX, own, "1414.06"));

    expect([error.code, (error.cause as PaymentAccountUnusableError).reason]).toEqual([
      "PAYMENT_PROVIDER_NOT_CONFIGURED",
      "no_velexis_keys",
    ]);
    expect(stripe.requests).toEqual([]);
  });

  it("refuses a new session whose row recorded another account than the connection names now", async () => {
    const gateway = gatewayWith(velexisKeys);
    const draft = payment({ account: paymentAccountOf(await gateway.account(CTX)) });
    // The platform switched between the insert of the row and the Stripe call.
    row = rows.connect_standard();

    const error = await appErrorOf(
      gateway.createSession(CTX, draft, { checkoutId: draft.checkoutId ?? "", requireThreeDSecure: false }),
    );

    expect([error.code, error.status, (error.cause as PaymentAccountUnusableError).reason]).toEqual([
      "PAYMENT_PROVIDER_NOT_CONFIGURED",
      424,
      "payment_account_changed",
    ]);
    expect(stripe.requests).toEqual([]);
  });

  it("records the account with the payment and reads it back, a missing or foreign record being velexis", () => {
    const connect: Pick<GatewayAccount, "accountMode" | "accountReference"> = {
      accountMode: "connect_standard",
      accountReference: CONNECT_ACCOUNT,
    };
    const metadata = JSON.parse(JSON.stringify(paymentMetadataFor(connect))) as unknown;

    expect(metadata).toEqual({
      connection: { accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT },
    });
    expect(recordedPaymentAccount(metadata)).toEqual(paymentAccountOf(connect));
    expect(paymentAccountOf({ accountMode: "velexis", accountReference: "acct_ignored" })).toEqual(
      VELEXIS_PAYMENT_ACCOUNT,
    );
    for (const none of [
      undefined,
      {},
      [],
      { connection: { accountMode: "own", accountReference: null } },
      { connection: { accountMode: "api_keys", accountReference: null } },
      { connection: { accountMode: "connect_standard", accountReference: "not-an-account" } },
      { connection: { accountMode: "velexis", accountReference: CONNECT_ACCOUNT } },
    ]) {
      expect(recordedPaymentAccount(none)).toBeNull();
    }
    const own: GatewayPaymentAccount = { accountMode: "api_keys", accountReference: OWN_ACCOUNT };
    expect([
      samePaymentAccount(null, VELEXIS_PAYMENT_ACCOUNT),
      samePaymentAccount(own, { ...own }),
      samePaymentAccount(own, { ...own, accountReference: CONNECT_ACCOUNT }),
      samePaymentAccount(null, own),
    ]).toEqual([true, true, false, false]);
  });
});

describe("the decrypted key of an api_keys connection (OBE-077 AC2)", () => {
  it("[OBE-077 AC2] never appears in a log line or an error when Stripe fails", async () => {
    row = await rows.api_keys();
    const gateway = gatewayWith(velexisKeys);
    stripe.fail(2, "server_error");
    const draft = payment({ account: paymentAccountOf(await gateway.account(CTX)) });

    const error = await appErrorOf(
      gateway.createSession(CTX, draft, { checkoutId: draft.checkoutId ?? "", requireThreeDSecure: false }),
    );

    // The key did reach Stripe, as the Authorization of both attempts…
    expect(stripe.requests.map(credentialsOf)).toEqual([
      [`Bearer ${OTA_SECRET_KEY}`, undefined],
      [`Bearer ${OTA_SECRET_KEY}`, undefined],
    ]);
    // …and nowhere else: not in the error, its cause or the log lines.
    expect([error.code, error.cause]).toEqual(["PAYMENT_PROVIDER_ERROR", expect.any(StripeCallError)]);
    expect(logs.map(([level, fields, message]) => [level, message, fields["accountMode"]])).toEqual([
      ["warn", "payments.stripe_call_failed", "api_keys"],
    ]);
    expect(exposed(error)).not.toContain(OTA_SECRET_KEY);
    expect(JSON.stringify(logs)).not.toContain(OTA_SECRET_KEY);
  });

  it("[OBE-077 AC2] answers 424 with the connection id only for a key it cannot decrypt or that is not a key of the environment", async () => {
    const liveKey = `sk_live_${randomBytes(18).toString("hex")}`;
    const cases: Array<[string, Promise<PlatformPaymentConnection>, string]> = [
      // Sealed for another connection: the associated data does not match.
      [
        "another row's ciphertext",
        rows.api_keys().then(async (own) => ({
          ...own,
          secretCiphertext: await sealed(OTA_SECRET_KEY, "ppc_01JA4CE5H8K1M4P7R0T3V6Y9ZZ"),
        })),
        "connection_secret_unreadable",
      ],
      [
        "a damaged ciphertext",
        rows
          .api_keys()
          .then((own) => ({ ...own, secretCiphertext: Buffer.from("damaged").toString("base64") })),
        "connection_secret_unreadable",
      ],
      ["a live key on the test environment", rows.api_keys(liveKey), "connection_secret_invalid"],
      ["a publishable key as the secret", rows.api_keys(OTA_PUBLISHABLE_KEY), "connection_secret_invalid"],
    ];
    for (const [name, connectionRow, reason] of cases) {
      row = await connectionRow;
      logs = [];
      const gateway = gatewayWith(velexisKeys);
      const draft = payment({ account: paymentAccountOf(await gateway.account(CTX)) });

      const error = await appErrorOf(
        gateway.createSession(CTX, draft, { checkoutId: draft.checkoutId ?? "", requireThreeDSecure: false }),
      );

      expect([name, error.code, error.status, (error.cause as PaymentAccountUnusableError).reason]).toEqual([
        name,
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        424,
        reason,
      ]);
      expect(logs).toEqual([
        [
          "warn",
          {
            operation: "paymentIntents.create",
            tenantId: TENANT_ID,
            environment: "test",
            accountMode: "api_keys",
            connectionId: CONNECTION_ID,
            reason,
          },
          "payments.stripe_account_unavailable",
        ],
      ]);
      for (const secret of [OTA_SECRET_KEY, liveKey]) {
        expect(exposed(error)).not.toContain(secret);
        expect(JSON.stringify(logs)).not.toContain(secret);
      }
    }
    expect(stripe.requests).toEqual([]);
  });

  it("lives only in the client of one call: the factory keeps no copy of it", async () => {
    const factory = factoryWith(velexisKeys);
    const target = {
      accountMode: "api_keys",
      environment: "test",
      connectionId: CONNECTION_ID,
      secretCiphertext: await sealed(OTA_SECRET_KEY),
    } as const;
    const seen: Array<[Stripe, Record<string, unknown>]> = [];

    for (let call = 0; call < 2; call += 1) {
      await factory.withAccount(target, (client, scope) => {
        seen.push([client, { ...scope }]);
        return Promise.resolve();
      });
    }
    await factory.withAccount({ accountMode: "velexis", environment: "test" }, (client, scope) => {
      seen.push([client, { ...scope }]);
      return Promise.resolve();
    });
    await factory.withAccount(
      { accountMode: "connect_standard", environment: "test", accountReference: CONNECT_ACCOUNT },
      (client, scope) => {
        seen.push([client, { ...scope }]);
        return Promise.resolve();
      },
    );

    const [first, second, velexis, connect] = seen;
    // A new client for each api_keys call, the one Velexis client of the environment for the two other modes.
    expect(first?.[0]).not.toBe(second?.[0]);
    expect([velexis?.[0], connect?.[0]]).toEqual([
      factory.velexisClient("test"),
      factory.velexisClient("test"),
    ]);
    expect(seen.map(([, scope]) => scope)).toEqual([{}, {}, {}, { stripeAccount: CONNECT_ACCOUNT }]);
    expect(unwraps).toBe(2);
    expect(exposed(factory)).not.toContain(OTA_SECRET_KEY);
    // Without the Velexis keys, velexis and connect_standard targets cannot be reached.
    await expect(
      factoryWith({}).withAccount({ accountMode: "velexis", environment: "test" }, () => Promise.resolve()),
    ).rejects.toEqual(new StripeAccountUnavailableError("no_velexis_keys", "test", null));
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
