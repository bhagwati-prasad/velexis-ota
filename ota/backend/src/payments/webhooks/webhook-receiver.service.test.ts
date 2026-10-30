// Unit tests of the Stripe webhook receiver (OBE-039, OBE-078; OADR-0010 point 4): the signature check on the raw body,
// the livemode and metadata cross-checks, the tenant and payment lookups, the stored row and the queued job, for the
// Velexis endpoint, the Connect endpoint (the tenant only from `event.account`) and an `api_keys` connection's own
// endpoint (its encrypted signing secret, the tenant only from the path's connection). The deliveries are the signed
// fixtures of @velexis/testing/stripe with this file's own secrets; the tenant transaction, the repository, the
// platform cache and repository, the queue and Stripe are fakes, so every test sees exactly what was written, queued
// and logged. The connections' signing secrets are sealed with the test KEKs, as the platform seals them.
import { randomBytes } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { encryptValue, type KeyProvider } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { signedStripeEvent, stripeFixture } from "@velexis/testing/stripe";
import type { Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testKeyProvider } from "../../../test/helpers/api-env";
import type { Clock } from "../../common/clock";
import type { IdGenerator } from "../../common/ids";
import type { ApiConfig } from "../../config";
import type { PlatformCache } from "../../tenancy/platform-cache";
import type {
  PlatformPaymentConnection,
  PlatformPaymentConnectionWebhook,
  PlatformReadRepository,
} from "../../tenancy/platform-read.repository";
import type { PlatformTenant } from "../../tenancy/platform-read.types";
import type { RequestTenant, TenantContext } from "../../tenancy/tenant-context";
import type { TenantTransaction, TenantTx } from "../../tenancy/tenant-tx";
import type { PaymentRow, PaymentsRepository } from "../payments.repository";
import type { StripeClientFactory } from "../stripe/stripe-client.factory";
import {
  connectionWebhookSecretAad,
  ENQUEUE_TIMEOUT_MS,
  STRIPE_EVENT_JOB,
  storedPayloadOf,
  WebhookReceiverService,
  eventFactsOf,
} from "./webhook-receiver.service";

/** This file's signing secrets: built at run time, never committed values. */
const SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const CONNECT_SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const CONNECTION_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const NOW = new Date("2026-11-03T10:00:00.000Z");

/** The OTA's own Stripe accounts (`acct_` and letters and digits, as the platform's CHECK has them). */
const CONNECTED_ACCOUNT = "acct_1TestAlphaConnected";
const OWN_ACCOUNT = "acct_1TestAlphaOwnKeys";
const CONNECT_CONNECTION_ID = "ppc_01JBWEBHOOKCONNECT0000000";
const OWN_CONNECTION_ID = "ppc_01JBWEBHOOKOWNKEYS0000000";

/** The test KEKs (MASTER_KEY_DIR as the API loads them), loaded once in `beforeAll`. */
let keys: KeyProvider;

/** The fixtures' tenant, payment and PaymentIntent (packages/testing/fixtures/README.md). */
const TENANT_ID = "ten_test_alpha";
const PAYMENT_ID = "pay_test_alpha_1";
const INTENT_ID = "pi_test_alpha_1";

const TENANT: PlatformTenant = {
  id: TENANT_ID,
  key: "alpha",
  name: "Alpha Travel",
  status: "active",
  schemaName: "tenant_alpha" as PlatformTenant["schemaName"],
  storefrontEnvironment: "test",
  defaultCurrency: "EUR",
  defaultLocale: "en",
  billingNotice: null,
};

function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: PAYMENT_ID,
    environment: "test",
    checkoutId: "chk_test_alpha_1",
    bookingId: null,
    customerId: null,
    provider: "stripe",
    providerConnectionId: "ppc_test_alpha",
    providerPaymentId: INTENT_ID,
    method: "card",
    captureMethod: "manual",
    currency: "EUR",
    amount: "452.10",
    cardFeeAmount: "0.00",
    amountAuthorized: "0.00",
    amountCaptured: "0.00",
    amountRefunded: "0.00",
    status: "requires_payment_method",
    cardBrand: null,
    cardBin: null,
    cardLast4: null,
    cardExpMonth: null,
    cardExpYear: null,
    threeDs: null,
    nextAction: null,
    failureCode: null,
    failureMessage: null,
    authorizedAt: null,
    capturedAt: null,
    canceledAt: null,
    version: 2,
    createdAt: NOW,
    updatedAt: NOW,
    checkoutCustomerId: null,
    checkoutIsGuest: true,
    ...overrides,
  };
}

/** A Stripe payment connection of the fixtures' tenant, as the platform read repository answers it. */
function connectionRow(overrides: Partial<PlatformPaymentConnection> = {}): PlatformPaymentConnection {
  return {
    id: CONNECT_CONNECTION_ID,
    tenantId: TENANT_ID,
    provider: "stripe",
    environment: "test",
    accountMode: "connect_standard",
    accountReference: CONNECTED_ACCOUNT,
    publishableKey: null,
    supportedMethods: ["card"],
    captureMode: "manual",
    status: "active",
    statementDescriptorSuffix: null,
    secretCiphertext: null,
    ...overrides,
  };
}

/** `secret` sealed as the platform seals connection `id`'s webhook signing secret (base64, as the repository reads it). */
async function sealedWebhookSecret(secret: string, id = OWN_CONNECTION_ID): Promise<string> {
  const { ciphertext } = await encryptValue(Buffer.from(secret, "utf8"), {
    aad: connectionWebhookSecretAad(id),
    keys,
  });
  return Buffer.from(ciphertext).toString("base64");
}

/** The account snapshot a payment created on an OTA's own account records (`payments.metadata`, OBE-077). */
const createdOn = (accountMode: "connect_standard" | "api_keys", accountReference: string) => ({
  connection: { accountMode, accountReference },
});

interface Harness {
  readonly receiver: WebhookReceiverService;
  /** The platform tenants by id. */
  readonly tenants: Map<string, PlatformTenant>;
  /** The tenant's payments by id. */
  readonly payments: Map<string, PaymentRow>;
  /** The stored events by provider event id: the row the receiver wrote. */
  readonly events: Map<string, Record<string, unknown>>;
  readonly contexts: RequestTenant[];
  readonly queue: { add: ReturnType<typeof vi.fn> };
  readonly retrieveIntent: ReturnType<typeof vi.fn>;
  readonly lookups: ReturnType<typeof vi.fn>;
  readonly logs: Array<{ level: string; object: Record<string, unknown>; message: string }>;
  /** The `connect_standard` connections by `<environment>:<acct_…>` (connectPaymentConnection). */
  readonly connectConnections: Map<string, PlatformPaymentConnection>;
  /** The connections with their webhook secret's ciphertext by id (paymentConnectionWebhook). */
  readonly ownConnections: Map<string, PlatformPaymentConnectionWebhook>;
  readonly platformLookups: ReturnType<typeof vi.fn>;
  secret: string | undefined;
  connectSecret: string | undefined;
  /** When set, every platform lookup fails as a database outage would. */
  platformDown: boolean;
}

function harness(): Harness {
  const tenants = new Map<string, PlatformTenant>([[TENANT_ID, TENANT]]);
  const payments = new Map<string, PaymentRow>([[PAYMENT_ID, paymentRow()]]);
  const events = new Map<string, Record<string, unknown>>();
  const contexts: RequestTenant[] = [];
  const logs: Harness["logs"] = [];
  const connectConnections = new Map<string, PlatformPaymentConnection>([
    [`test:${CONNECTED_ACCOUNT}`, connectionRow()],
  ]);
  const ownConnections = new Map<string, PlatformPaymentConnectionWebhook>();
  const platformLookups = vi.fn();
  const log =
    (level: string) =>
    (object: Record<string, unknown>, message: string): void => {
      logs.push({ level, object, message });
    };
  const logger = {
    setContext: vi.fn(),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  } as unknown as PinoLogger;
  const lookups = vi.fn((id: string) => Promise.resolve(tenants.get(id) ?? null));
  const retrieveIntent = vi.fn();
  const queue = { add: vi.fn(() => Promise.resolve({})) };
  let next = 0;
  const state: Harness = {
    tenants,
    payments,
    events,
    contexts,
    queue,
    retrieveIntent,
    lookups,
    logs,
    connectConnections,
    ownConnections,
    platformLookups,
    secret: SECRET,
    connectSecret: CONNECT_SECRET,
    platformDown: false,
    receiver: undefined as unknown as WebhookReceiverService,
  };
  const config = {
    get: (name: keyof ApiConfig) =>
      name === "STRIPE_WEBHOOK_SECRET_VELEXIS_TEST"
        ? state.secret
        : name === "STRIPE_WEBHOOK_SECRET_CONNECT_TEST"
          ? state.connectSecret
          : undefined,
  } as unknown as ConfigService<ApiConfig, true>;
  const platformRead = <T>(lookup: string, value: () => T): Promise<T> => {
    platformLookups(lookup);
    return state.platformDown ? Promise.reject(new Error("connect ECONNREFUSED")) : Promise.resolve(value());
  };
  const platform = {
    connectPaymentConnection: (environment: string, account: string) =>
      platformRead("connect", () => connectConnections.get(`${environment}:${account}`) ?? null),
    paymentConnectionWebhook: (id: string) =>
      platformRead("connection", () => ownConnections.get(id) ?? null),
  } as unknown as PlatformReadRepository;
  const clients = {
    velexisClient: () => ({ paymentIntents: { retrieve: retrieveIntent } }) as unknown as Stripe,
  } as unknown as StripeClientFactory;
  const cache = { tenantById: lookups } as unknown as PlatformCache;
  const tenantContext = {
    run: async <T>(tenant: RequestTenant, fn: () => Promise<T>): Promise<T> => {
      contexts.push(tenant);
      return await fn();
    },
    requestId: () => "req_test_webhook",
  } as unknown as TenantContext;
  const trx = {} as TenantTransaction;
  const tx = {
    run: async <T>(fn: (t: TenantTransaction) => Promise<T>) => await fn(trx),
  } as unknown as TenantTx;
  const repository = {
    payment: (_trx: TenantTransaction, id: string) => Promise.resolve(payments.get(id)),
    paymentIdByProviderId: (_trx: TenantTransaction, provider: string, intentId: string) =>
      Promise.resolve(
        [...payments.values()].find((row) => row.provider === provider && row.providerPaymentId === intentId)
          ?.id,
      ),
    insertProviderEvent: (_trx: TenantTransaction, row: Record<string, unknown>) => {
      const key = String(row["provider_event_id"]);
      if (events.has(key)) {
        return Promise.resolve(false);
      }
      events.set(key, row);
      return Promise.resolve(true);
    },
    eventIdByProviderEventId: (_trx: TenantTransaction, providerEventId: string) =>
      Promise.resolve(events.get(providerEventId)?.["id"] as string | undefined),
  } as unknown as PaymentsRepository;
  const ids = {
    newId: (prefix: string) => {
      next += 1;
      return `${prefix}_01JBWEBHOOK${String(next).padStart(15, "0")}`;
    },
  } as unknown as IdGenerator;
  const clock = { now: () => NOW } as Clock;
  Object.assign(state, {
    receiver: new WebhookReceiverService(
      config,
      clients,
      cache,
      tenantContext,
      tx,
      repository,
      ids,
      clock,
      queue as unknown as Queue,
      logger,
      platform,
      keys,
    ),
  });
  return state;
}

/** A delivery's body as the raw body parser hands it over. */
const raw = (payload: string): Buffer => Buffer.from(payload, "utf8");

/** Signs `event` (an event without a fixture, such as payment_intent.canceled) as Stripe would. */
function signedEvent(event: Record<string, unknown>): { payload: string; header: string } {
  const payload = JSON.stringify(event, null, 2);
  return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) };
}

let h: Harness;

// Reading the test KEKs from disk once; a few milliseconds, well inside the hook's default budget.
beforeAll(async () => {
  keys = await testKeyProvider();
});

beforeEach(() => {
  h = harness();
});

describe("the signature", () => {
  it("is verified on the raw body: a payload changed after signing answers 400 and nothing is read [OBE-039 AC2]", async () => {
    const { payload, header } = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      undefined,
      SECRET,
    );
    const changed = payload.replace('"amount_capturable": 45210', '"amount_capturable": 45211');
    expect(changed).not.toBe(payload);

    const refusal = await h.receiver
      .receiveVelexis("test", raw(changed), header)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "signature_invalid" } });
    expect(h.lookups).not.toHaveBeenCalled();
    expect(h.events.size).toBe(0);
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual(
      expect.objectContaining({ message: "payments.webhook_signature_invalid", object: expect.anything() }),
    );
  });

  it("refuses another secret, a missing signature, an empty body and an environment without a secret", async () => {
    const other = signedStripeEvent(
      "payment_intent.succeeded",
      undefined,
      `whsec_${randomBytes(24).toString("hex")}`,
    );
    const valid = signedStripeEvent("payment_intent.succeeded", undefined, SECRET);
    for (const [body, header] of [
      [raw(other.payload), other.header],
      [raw(valid.payload), undefined],
      [Buffer.alloc(0), valid.header],
      [valid.payload, valid.header],
    ] as const) {
      await expect(h.receiver.receiveVelexis("test", body, header)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
    h.secret = undefined;
    await expect(h.receiver.receiveVelexis("test", raw(valid.payload), valid.header)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(h.logs.map((line) => line.message)).toContain("payments.webhook_secret_missing");
    expect(h.events.size).toBe(0);
  });

  it("never logs the secret, the signature or the body", async () => {
    const { payload, header } = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      undefined,
      SECRET,
    );
    await h.receiver
      .receiveVelexis("test", raw(payload.replace("45210", "45219")), header)
      .catch(() => undefined);
    await h.receiver.receiveVelexis("test", raw(payload), header);

    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(header);
    expect(logged).not.toContain("secret_synthetic");
  });
});

describe("a verified event", () => {
  it("is stored once with a payload of ids, statuses and amounts, and queued with the event id as job id [OBE-039 AC1]", async () => {
    const { payload, header, event } = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      undefined,
      SECRET,
    );

    const receipt = await h.receiver.receiveVelexis("test", raw(payload), header);

    expect(receipt).toEqual({ outcome: "stored", paymentEventId: expect.stringMatching(/^pev_/) });
    const stored = h.events.get(event.id);
    expect(stored).toMatchObject({
      id: receipt.paymentEventId,
      payment_id: PAYMENT_ID,
      type: "webhook.payment_intent.amount_capturable_updated",
      source: "webhook",
      provider_event_id: event.id,
      created_at: NOW,
    });
    const storedPayload = JSON.parse(String(stored?.["payload"])) as Record<string, unknown>;
    expect(storedPayload).toMatchObject({
      endpoint: "velexis",
      eventId: event.id,
      type: "payment_intent.amount_capturable_updated",
      livemode: false,
      object: { type: "payment_intent", id: INTENT_ID, status: "requires_capture", amountCapturable: 45210 },
      paymentIntentId: INTENT_ID,
    });
    expect(String(stored?.["payload"])).not.toContain("secret");
    expect(h.contexts).toEqual([
      expect.objectContaining({ tenantId: TENANT_ID, schemaName: "tenant_alpha", environment: "test" }),
    ]);
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    expect(h.queue.add).toHaveBeenCalledWith(
      STRIPE_EVENT_JOB,
      { tenantId: TENANT_ID, paymentEventId: receipt.paymentEventId },
      { jobId: event.id },
    );
  });

  it("delivered twice keeps one row and queues the same job id again, which BullMQ adds once [OBE-039 AC1]", async () => {
    const { payload, header, event } = signedStripeEvent("payment_intent.succeeded", undefined, SECRET);

    const first = await h.receiver.receiveVelexis("test", raw(payload), header);
    const second = await h.receiver.receiveVelexis("test", raw(payload), header);

    expect(first.outcome).toBe("stored");
    expect(second).toEqual({ outcome: "duplicate", paymentEventId: first.paymentEventId });
    expect(h.events.size).toBe(1);
    expect(h.queue.add.mock.calls.map((call) => call[2])).toEqual([{ jobId: event.id }, { jobId: event.id }]);
  });

  it("with livemode true on the test endpoint writes nothing and logs a security event [OBE-039 AC3]", async () => {
    const { payload, header } = signedStripeEvent(
      "payment_intent.succeeded",
      { livemode: true, data: { object: { livemode: true } } },
      SECRET,
    );

    expect(await h.receiver.receiveVelexis("test", raw(payload), header)).toEqual({
      outcome: "mismatch",
      paymentEventId: null,
    });
    expect(h.lookups).not.toHaveBeenCalled();
    expect(h.events.size).toBe(0);
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual({
      level: "warn",
      message: "payments.webhook_mismatch",
      object: expect.objectContaining({ securityEvent: "payments.webhook_mismatch", check: "livemode" }),
    });
  });

  it("whose metadata names the other environment writes nothing and logs a security event", async () => {
    const { payload, header } = signedStripeEvent(
      "payment_intent.succeeded",
      { data: { object: { metadata: { velexis_environment: "live" } } } },
      SECRET,
    );

    expect((await h.receiver.receiveVelexis("test", raw(payload), header)).outcome).toBe("mismatch");
    expect(h.events.size).toBe(0);
    expect(h.logs.at(-1)?.object).toMatchObject({ check: "metadata_environment" });
  });

  it("of an unknown tenant, or without one, answers and writes nothing [OBE-039 AC2]", async () => {
    for (const tenantId of ["ten_01JBNOSUCHTENANT0000000000", undefined]) {
      const { payload, header } = signedStripeEvent(
        "payment_intent.succeeded",
        {
          id: `evt_test_unknown_${String(tenantId)}`,
          data: { object: { metadata: { velexis_tenant_id: tenantId } } },
        },
        SECRET,
      );

      expect(await h.receiver.receiveVelexis("test", raw(payload), header)).toEqual({
        outcome: "tenant_unknown",
        paymentEventId: null,
      });
    }
    expect(h.events.size).toBe(0);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("of a tenant that is neither active nor suspended writes nothing; a suspended tenant's is stored", async () => {
    const { payload, header } = signedStripeEvent("payment_intent.succeeded", undefined, SECRET);
    h.tenants.set(TENANT_ID, { ...TENANT, status: "deprovisioning" });
    expect((await h.receiver.receiveVelexis("test", raw(payload), header)).outcome).toBe(
      "tenant_unavailable",
    );
    expect(h.events.size).toBe(0);

    h.tenants.set(TENANT_ID, { ...TENANT, status: "suspended" });
    expect((await h.receiver.receiveVelexis("test", raw(payload), header)).outcome).toBe("stored");
  });

  it("finds the payment by its PaymentIntent when the metadata names no payment", async () => {
    const { payload, header } = signedStripeEvent(
      "payment_intent.succeeded",
      { data: { object: { metadata: { payment_id: undefined } } } },
      SECRET,
    );

    expect((await h.receiver.receiveVelexis("test", raw(payload), header)).outcome).toBe("stored");
  });

  it("of an unknown payment answers and writes nothing", async () => {
    h.payments.clear();
    const { payload, header } = signedStripeEvent("payment_intent.succeeded", undefined, SECRET);

    expect((await h.receiver.receiveVelexis("test", raw(payload), header)).outcome).toBe("payment_unknown");
    expect(h.events.size).toBe(0);
  });

  it("for another PaymentIntent, payment, environment or provider than the row's is a security event", async () => {
    const cases: Array<[Partial<PaymentRow>, string]> = [
      [{ providerPaymentId: "pi_test_other" }, "payment_intent"],
      [{ environment: "live" }, "payment_environment"],
      [{ provider: "airline" }, "payment_provider"],
    ];
    for (const [overrides, check] of cases) {
      h.payments.set(PAYMENT_ID, paymentRow(overrides));
      const { payload, header } = signedStripeEvent("payment_intent.succeeded", undefined, SECRET);

      expect([check, (await h.receiver.receiveVelexis("test", raw(payload), header)).outcome]).toEqual([
        check,
        "mismatch",
      ]);
      expect(h.logs.at(-1)?.object).toMatchObject({ securityEvent: "payments.webhook_mismatch", check });
    }
    // The metadata names one payment, the PaymentIntent belongs to another one.
    h.payments.clear();
    h.payments.set("pay_test_alpha_2", paymentRow({ id: "pay_test_alpha_2" }));
    const { payload, header } = signedStripeEvent("payment_intent.succeeded", undefined, SECRET);
    expect((await h.receiver.receiveVelexis("test", raw(payload), header)).outcome).toBe("mismatch");
    expect(h.events.size).toBe(0);
  });

  it("of a dispute takes the tenant from its PaymentIntent, read from Stripe, since disputes carry no metadata", async () => {
    h.retrieveIntent.mockResolvedValue(stripeFixture("payment_intent.succeeded").data.object);
    const { payload, header, event } = signedStripeEvent("charge.dispute.created", undefined, SECRET);

    expect((await h.receiver.receiveVelexis("test", raw(payload), header)).outcome).toBe("stored");
    expect(h.retrieveIntent).toHaveBeenCalledWith(INTENT_ID);
    expect(h.events.get(event.id)).toMatchObject({ type: "webhook.charge.dispute.created" });
  });

  it("of a dispute whose PaymentIntent cannot be read answers 503 so that Stripe sends it again", async () => {
    h.retrieveIntent.mockRejectedValue(
      Stripe.errors.StripeError.generate({ type: "api_error", message: "unavailable" }),
    );
    const { payload, header } = signedStripeEvent("charge.dispute.created", undefined, SECRET);

    await expect(h.receiver.receiveVelexis("test", raw(payload), header)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(h.events.size).toBe(0);
  });

  it("that cannot be queued answers 503: the delivery Stripe sends again finds it stored and queues it", async () => {
    h.queue.add.mockRejectedValueOnce(new Error("Connection is closed."));
    const { payload, header, event } = signedStripeEvent("payment_intent.succeeded", undefined, SECRET);

    await expect(h.receiver.receiveVelexis("test", raw(payload), header)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(h.events.size).toBe(1);
    expect(await h.receiver.receiveVelexis("test", raw(payload), header)).toMatchObject({
      outcome: "duplicate",
    });
    expect(h.queue.add).toHaveBeenLastCalledWith(STRIPE_EVENT_JOB, expect.anything(), { jobId: event.id });
  });

  it("that Redis does not take within the enqueue timeout answers 503", async () => {
    vi.useFakeTimers();
    try {
      h.queue.add.mockReturnValueOnce(new Promise(() => undefined));
      const { payload, header } = signedStripeEvent("payment_intent.succeeded", undefined, SECRET, {
        timestamp: NOW,
      });
      vi.setSystemTime(NOW);
      const answer = h.receiver.receiveVelexis("test", raw(payload), header).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);

      expect(await answer).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("of a type without a fixture (payment_intent.canceled) is stored like the others", async () => {
    const fixture = stripeFixture("payment_intent.succeeded");
    const { payload, header } = signedEvent({
      ...fixture,
      id: "evt_test_pi_canceled",
      type: "payment_intent.canceled",
      created: Math.floor(Date.now() / 1000),
      data: { object: { ...fixture.data.object, status: "canceled" } },
    });

    expect((await h.receiver.receiveVelexis("test", raw(payload), header)).outcome).toBe("stored");
  });
});

/** An event of the fixtures' tenant on its connected account, signed with the Connect secret. */
function connectEvent(
  overrides: Parameters<typeof signedStripeEvent<"payment_intent.succeeded">>[1] = {},
  secret = CONNECT_SECRET,
): ReturnType<typeof signedStripeEvent<"payment_intent.succeeded">> {
  return signedStripeEvent("payment_intent.succeeded", { account: CONNECTED_ACCOUNT, ...overrides }, secret);
}

describe("the Connect endpoint (OBE-078)", () => {
  beforeEach(() => {
    h.payments.set(PAYMENT_ID, paymentRow({ metadata: createdOn("connect_standard", CONNECTED_ACCOUNT) }));
  });

  it("takes the tenant only from event.account and stores the event with its account and connection [OBE-078 AC1]", async () => {
    const { payload, header, event } = connectEvent();

    const receipt = await h.receiver.receiveConnect("test", raw(payload), header);

    expect(receipt).toEqual({ outcome: "stored", paymentEventId: expect.stringMatching(/^pev_/) });
    expect(h.platformLookups.mock.calls).toEqual([["connect"]]);
    expect(h.lookups).toHaveBeenCalledWith(TENANT_ID);
    const storedPayload = JSON.parse(String(h.events.get(event.id)?.["payload"])) as Record<string, unknown>;
    expect(storedPayload).toMatchObject({
      endpoint: "connect",
      account: CONNECTED_ACCOUNT,
      connectionId: CONNECT_CONNECTION_ID,
      eventId: event.id,
      paymentIntentId: INTENT_ID,
    });
    expect(h.queue.add).toHaveBeenCalledWith(
      STRIPE_EVENT_JOB,
      { tenantId: TENANT_ID, paymentEventId: receipt.paymentEventId },
      { jobId: event.id },
    );
    // Delivered again: one row, the same job id.
    expect(await h.receiver.receiveConnect("test", raw(payload), header)).toEqual({
      outcome: "duplicate",
      paymentEventId: receipt.paymentEventId,
    });
    expect(h.events.size).toBe(1);
  });

  it("finds the tenant without any metadata: the account alone chooses it", async () => {
    const { payload, header } = connectEvent({
      data: { object: { metadata: { velexis_tenant_id: undefined, velexis_environment: undefined } } },
    });

    expect((await h.receiver.receiveConnect("test", raw(payload), header)).outcome).toBe("stored");
  });

  it("answers 400 to an event signed with the Velexis or a connection's secret, or without the Connect secret", async () => {
    for (const secret of [SECRET, CONNECTION_SECRET]) {
      const { payload, header } = connectEvent({}, secret);
      await expect(h.receiver.receiveConnect("test", raw(payload), header)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        details: { reason: "signature_invalid" },
      });
    }
    h.connectSecret = undefined;
    const { payload, header } = connectEvent();
    await expect(h.receiver.receiveConnect("test", raw(payload), header)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: "payments.webhook_secret_missing",
        object: { endpoint: "connect/test" },
      }),
    );
    expect(h.platformLookups).not.toHaveBeenCalled();
    expect(h.events.size).toBe(0);
  });

  it("acknowledges an event without account or of an acct_ no connection has, without effect [OBE-078 AC2]", async () => {
    for (const account of [undefined, "acct_1NoSuchAccount", "acct_test_alpha", "not-an-account"]) {
      const { payload, header } = signedStripeEvent("payment_intent.succeeded", { account }, CONNECT_SECRET);

      expect([account, await h.receiver.receiveConnect("test", raw(payload), header)]).toEqual([
        account,
        { outcome: "account_unknown", paymentEventId: null },
      ]);
    }
    // Only the well-formed unknown account was looked up; nothing else happened.
    expect(h.platformLookups.mock.calls).toEqual([["connect"]]);
    expect(h.lookups).not.toHaveBeenCalled();
    expect(h.events.size).toBe(0);
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.logs.filter((line) => line.message === "payments.webhook_mismatch")).toEqual([]);
  });

  it("never follows metadata that names another tenant: nothing written, a security event [OBE-078 AC3]", async () => {
    const otherTenant = "ten_01JBOTHERTENANT00000000000";
    h.tenants.set(otherTenant, {
      ...TENANT,
      id: otherTenant,
      key: "beta",
      schemaName: "tenant_beta" as PlatformTenant["schemaName"],
    });
    const { payload, header, event } = connectEvent({
      data: { object: { metadata: { velexis_tenant_id: otherTenant } } },
    });

    expect(await h.receiver.receiveConnect("test", raw(payload), header)).toEqual({
      outcome: "mismatch",
      paymentEventId: null,
    });
    expect(h.lookups).not.toHaveBeenCalled();
    expect(h.contexts).toEqual([]);
    expect(h.events.size).toBe(0);
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual({
      level: "warn",
      message: "payments.webhook_mismatch",
      object: expect.objectContaining({
        securityEvent: "payments.webhook_mismatch",
        check: "metadata_tenant",
        endpoint: "connect/test",
        eventId: event.id,
        account: CONNECTED_ACCOUNT,
        tenantId: TENANT_ID,
      }),
    });
    expect(JSON.stringify(h.logs)).not.toContain("secret_synthetic");
  });

  it("with a livemode or metadata environment other than the path's writes nothing and logs a security event [OBE-078 AC3]", async () => {
    const live = connectEvent({ livemode: true, data: { object: { livemode: true } } });
    expect((await h.receiver.receiveConnect("test", raw(live.payload), live.header)).outcome).toBe(
      "mismatch",
    );
    expect(h.logs.at(-1)?.object).toMatchObject({
      securityEvent: "payments.webhook_mismatch",
      check: "livemode",
    });
    expect(h.platformLookups).not.toHaveBeenCalled();

    const otherEnvironment = connectEvent({
      data: { object: { metadata: { velexis_environment: "live" } } },
    });
    expect(
      (await h.receiver.receiveConnect("test", raw(otherEnvironment.payload), otherEnvironment.header))
        .outcome,
    ).toBe("mismatch");
    expect(h.logs.at(-1)?.object).toMatchObject({ check: "metadata_environment" });
    expect(h.events.size).toBe(0);
  });

  it("refuses a payment that does not live on the event's account: a Velexis one, or another acct_'s", async () => {
    for (const metadata of [undefined, {}, createdOn("connect_standard", "acct_1AnotherAccount")]) {
      h.payments.set(PAYMENT_ID, paymentRow({ metadata }));
      const { payload, header } = connectEvent();

      expect((await h.receiver.receiveConnect("test", raw(payload), header)).outcome).toBe("mismatch");
      expect(h.logs.at(-1)?.object).toMatchObject({ check: "payment_account", paymentId: PAYMENT_ID });
    }
    expect(h.events.size).toBe(0);
    // An `api_keys` payment of that same account (connected with Connect since) is that account's.
    h.payments.set(PAYMENT_ID, paymentRow({ metadata: createdOn("api_keys", CONNECTED_ACCOUNT) }));
    const { payload, header } = connectEvent();
    expect((await h.receiver.receiveConnect("test", raw(payload), header)).outcome).toBe("stored");
  });

  it("answers 503 when the connection cannot be looked up, so that Stripe sends the event again", async () => {
    h.platformDown = true;
    const { payload, header } = connectEvent();

    await expect(h.receiver.receiveConnect("test", raw(payload), header)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(h.events.size).toBe(0);
  });
});

describe("an api_keys connection's endpoint c/<ppc_id> (OBE-078)", () => {
  beforeEach(async () => {
    h.payments.set(PAYMENT_ID, paymentRow({ metadata: createdOn("api_keys", OWN_ACCOUNT) }));
    h.ownConnections.set(OWN_CONNECTION_ID, {
      connection: connectionRow({
        id: OWN_CONNECTION_ID,
        accountMode: "api_keys",
        accountReference: OWN_ACCOUNT,
        publishableKey: "pk_test_ownKeysPublishable",
        secretCiphertext: "c2VhbGVk",
      }),
      webhookSecretCiphertext: await sealedWebhookSecret(CONNECTION_SECRET),
    });
  });

  /** An event of the OTA's own account, signed with `secret` (its own by default). */
  const ownEvent = (
    overrides: Parameters<typeof signedStripeEvent<"payment_intent.succeeded">>[1] = {},
    secret = CONNECTION_SECRET,
  ) => signedStripeEvent("payment_intent.succeeded", overrides, secret);

  it("verifies with the connection's own secret, takes the tenant from the path's connection and stores the event [OBE-078 AC1]", async () => {
    const { payload, header, event } = ownEvent();

    const receipt = await h.receiver.receiveConnection(OWN_CONNECTION_ID, raw(payload), header);

    expect(receipt).toEqual({ outcome: "stored", paymentEventId: expect.stringMatching(/^pev_/) });
    expect(h.platformLookups.mock.calls).toEqual([["connection"]]);
    const storedPayload = JSON.parse(String(h.events.get(event.id)?.["payload"])) as Record<string, unknown>;
    expect(storedPayload).toMatchObject({
      endpoint: "connection",
      account: OWN_ACCOUNT,
      connectionId: OWN_CONNECTION_ID,
      eventId: event.id,
    });
    expect(h.contexts).toEqual([expect.objectContaining({ tenantId: TENANT_ID, environment: "test" })]);
    expect(h.queue.add).toHaveBeenCalledWith(
      STRIPE_EVENT_JOB,
      { tenantId: TENANT_ID, paymentEventId: receipt.paymentEventId },
      { jobId: event.id },
    );
  });

  it("answers the same 400 to another connection's secret, an unknown id, another mode, no secret, a secret sealed for another row or not a secret [OBE-078 AC1]", async () => {
    const answers: unknown[] = [];
    const refusal = async (connectionId: string, secret = CONNECTION_SECRET): Promise<void> => {
      const { payload, header } = ownEvent({}, secret);
      answers.push(
        await h.receiver
          .receiveConnection(connectionId, raw(payload), header)
          .catch((error: unknown) => error),
      );
    };
    // Signed with another connection's secret (or the Connect secret).
    await refusal(OWN_CONNECTION_ID, `whsec_${randomBytes(24).toString("hex")}`);
    await refusal(OWN_CONNECTION_ID, CONNECT_SECRET);
    // An id no connection has.
    await refusal("ppc_01JBWEBHOOKNOSUCH00000000");
    // A connection that is not in api_keys mode, one without a secret, and a secret sealed for another row.
    const own = h.ownConnections.get(OWN_CONNECTION_ID);
    if (own === undefined) {
      throw new Error("the connection of the test is missing");
    }
    h.ownConnections.set(OWN_CONNECTION_ID, {
      ...own,
      connection: { ...own.connection, accountMode: "connect_standard" },
    });
    await refusal(OWN_CONNECTION_ID);
    h.ownConnections.set(OWN_CONNECTION_ID, { ...own, webhookSecretCiphertext: null });
    await refusal(OWN_CONNECTION_ID);
    h.ownConnections.set(OWN_CONNECTION_ID, {
      ...own,
      webhookSecretCiphertext: await sealedWebhookSecret(CONNECTION_SECRET, "ppc_01JBWEBHOOKOTHERROW000000"),
    });
    await refusal(OWN_CONNECTION_ID);
    // A value sealed for this row that is not a signing secret (a damaged or mistaken save).
    h.ownConnections.set(OWN_CONNECTION_ID, {
      ...own,
      webhookSecretCiphertext: await sealedWebhookSecret("not-a-signing-secret"),
    });
    await refusal(OWN_CONNECTION_ID);

    expect(answers).toHaveLength(7);
    for (const answer of answers) {
      expect(answer).toBeInstanceOf(AppError);
      expect(answer).toMatchObject({
        code: "INVALID_REQUEST",
        message: "The Stripe signature of the request is not valid.",
        details: { reason: "signature_invalid" },
      });
    }
    expect(
      h.logs
        .filter((line) => line.message === "payments.webhook_connection_unusable")
        .map((line) => line.object["reason"]),
    ).toEqual([
      "connection_unknown",
      "connection_not_api_keys",
      "no_webhook_secret",
      "webhook_secret_unreadable",
      "webhook_secret_invalid",
    ]);
    expect(h.events.size).toBe(0);
    expect(h.lookups).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logs)).not.toContain("not-a-signing-secret");
  });

  it("looks nothing up for a delivery without a body or a signature", async () => {
    const { payload } = ownEvent();

    await expect(
      h.receiver.receiveConnection(OWN_CONNECTION_ID, raw(payload), undefined),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(h.platformLookups).not.toHaveBeenCalled();
  });

  it("never follows metadata that names another tenant, nor a livemode other than the connection's [OBE-078 AC3]", async () => {
    const forged = ownEvent({
      data: { object: { metadata: { velexis_tenant_id: "ten_01JBOTHERTENANT00000000000" } } },
    });
    expect(
      (await h.receiver.receiveConnection(OWN_CONNECTION_ID, raw(forged.payload), forged.header)).outcome,
    ).toBe("mismatch");
    expect(h.logs.at(-1)?.object).toMatchObject({
      securityEvent: "payments.webhook_mismatch",
      check: "metadata_tenant",
      endpoint: `c/${OWN_CONNECTION_ID}`,
    });

    const live = ownEvent({ livemode: true, data: { object: { livemode: true } } });
    expect(
      (await h.receiver.receiveConnection(OWN_CONNECTION_ID, raw(live.payload), live.header)).outcome,
    ).toBe("mismatch");
    expect(h.logs.at(-1)?.object).toMatchObject({ check: "livemode" });
    expect(h.lookups).not.toHaveBeenCalled();
    expect(h.events.size).toBe(0);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("refuses a payment created on another account, and never logs the connection's secret or the signature", async () => {
    h.payments.set(PAYMENT_ID, paymentRow({ metadata: createdOn("connect_standard", CONNECTED_ACCOUNT) }));
    const { payload, header } = ownEvent();

    expect((await h.receiver.receiveConnection(OWN_CONNECTION_ID, raw(payload), header)).outcome).toBe(
      "mismatch",
    );
    expect(h.logs.at(-1)?.object).toMatchObject({ check: "payment_account" });
    const logged = JSON.stringify(h.logs);
    for (const secret of [CONNECTION_SECRET, header, "secret_synthetic"]) {
      expect([secret, logged.includes(secret)]).toEqual([secret, false]);
    }
  });
});

describe("the stored facts", () => {
  it("name the object, its PaymentIntent and charge, and never copy the object", () => {
    const refunded = stripeFixture("charge.refunded");
    const facts = eventFactsOf(refunded as unknown as Stripe.Event);

    expect(facts).toMatchObject({
      objectType: "charge",
      objectId: "ch_test_alpha_1",
      paymentIntentId: INTENT_ID,
      chargeId: "ch_test_alpha_1",
      metadata: { tenantId: TENANT_ID, environment: "test", paymentId: PAYMENT_ID },
    });
    const stored = JSON.stringify(storedPayloadOf(refunded as unknown as Stripe.Event, facts));
    for (const leak of ["4242", "TestFingerprint", "billing_details", "payment_method_details"]) {
      expect([leak, stored.includes(leak)]).toEqual([leak, false]);
    }
  });
});
