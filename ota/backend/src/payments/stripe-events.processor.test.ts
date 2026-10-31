// Unit tests of the ota-stripe-events consumer's edges (OBE-039): the job's payload, the facts read back from a stored
// webhook row (and, since OBE-078, the OTA's own account of a Connect or connection event), the jobs it refuses or
// skips before it touches tenant data, and (OBE-078) the Stripe account a stored event's object is read on, with the
// account mismatches and the accounts it cannot reach. Processing itself (the reads from Stripe and the state
// applied) runs against PostgreSQL, Redis and the fake Stripe API in test/integration/payments/webhooks.int.test.ts
// and, on the OTAs' own accounts, connect-webhooks.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import { UnrecoverableError, type Job } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../common/clock";
import type { IdGenerator } from "../common/ids";
import type { WorkerConfig } from "../config";
import type { StaffRecipients } from "../notifications/staff-recipients";
import type { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformPaymentConnection, PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import type { PaymentEventRow, PaymentRow, PaymentsRepository } from "./payments.repository";
import {
  StripeAccountUnavailableError,
  type StripeAccountTarget,
  type StripeClientFactory,
} from "./stripe/stripe-client.factory";
import {
  parseStripeEventJobData,
  storedAccountOf,
  storedFactsOf,
  StripeEventHandler,
  StripeEventsProcessor,
} from "./stripe-events.processor";

const TENANT: PlatformTenant = {
  id: "ten_01JBPROCESSOR000000000000",
  key: "alpha",
  name: "Alpha Travel",
  status: "active",
  schemaName: "tenant_alpha" as PlatformTenant["schemaName"],
  storefrontEnvironment: "test",
  defaultCurrency: "EUR",
  defaultLocale: "en",
  billingNotice: null,
};
const EVENT_ID = "pev_01JBPROCESSOR000000000000";

function processor(tenant: PlatformTenant | null) {
  const handle = vi.fn(() =>
    Promise.resolve({ type: "payment_intent.succeeded", outcome: "applied" as const }),
  );
  const contexts: RequestTenant[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as PinoLogger;
  const instance = new StripeEventsProcessor(
    { handle } as unknown as StripeEventHandler,
    { tenantById: vi.fn(() => Promise.resolve(tenant)) } as unknown as PlatformCache,
    {
      run: async <T>(context: RequestTenant, fn: () => Promise<T>): Promise<T> => {
        contexts.push(context);
        return await fn();
      },
    } as unknown as TenantContext,
    logger,
  );
  return { instance, handle, contexts, logger };
}

const job = (name: string, data: unknown): Job =>
  ({ id: "evt_test_job", name, data, queueName: "ota-stripe-events" }) as unknown as Job;

describe("the stripe.event payload", () => {
  it("is exactly a tenant id and a payment event id", () => {
    expect(parseStripeEventJobData({ tenantId: TENANT.id, paymentEventId: EVENT_ID })).toEqual({
      tenantId: TENANT.id,
      paymentEventId: EVENT_ID,
    });
    for (const data of [
      null,
      [],
      { tenantId: TENANT.id },
      { tenantId: TENANT.id, paymentEventId: EVENT_ID, extra: 1 },
      { tenantId: "tenant_alpha", paymentEventId: EVENT_ID },
      { tenantId: TENANT.id, paymentEventId: "pay_01JBPROCESSOR000000000000" },
    ]) {
      expect([data, parseStripeEventJobData(data)]).toEqual([data, undefined]);
    }
  });
});

describe("the facts of a stored webhook row", () => {
  it("name the event type, the endpoint and the object's ids", () => {
    expect(
      storedFactsOf({
        type: "webhook.charge.refund.updated",
        payload: {
          endpoint: "velexis",
          object: { type: "refund", id: "re_test_1" },
          paymentIntentId: "pi_test_1",
          chargeId: "ch_test_1",
        },
      }),
    ).toEqual({
      endpoint: "velexis",
      type: "charge.refund.updated",
      objectId: "re_test_1",
      paymentIntentId: "pi_test_1",
      chargeId: "ch_test_1",
    });
  });

  it("drop ids that are not Stripe ids", () => {
    expect(
      storedFactsOf({ type: "webhook.payment_intent.succeeded", payload: { object: { id: "<script>" } } }),
    ).toMatchObject({ endpoint: null, objectId: null, paymentIntentId: null, chargeId: null });
  });

  it("name the OTA's own account of a Connect or connection event, and nothing else as one (OBE-078)", () => {
    expect(storedAccountOf({ payload: { endpoint: "connect", account: "acct_1TestAlphaConnected" } })).toBe(
      "acct_1TestAlphaConnected",
    );
    for (const payload of [
      { endpoint: "velexis" },
      { endpoint: "connection", account: "acct_test_alpha" },
      { endpoint: "connect", account: 42 },
      null,
    ]) {
      expect([payload, storedAccountOf({ payload })]).toEqual([payload, null]);
    }
  });
});

describe("StripeEventsProcessor", () => {
  it("refuses any other job at once, without retries and without the payload in the log", async () => {
    const { instance, handle, logger } = processor(TENANT);

    for (const refused of [
      job("notify", { tenantId: TENANT.id }),
      job("stripe.event", { tenantId: TENANT.id, paymentEventId: EVENT_ID, card: "4242" }),
    ]) {
      await expect(instance.process(refused)).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(handle).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("4242");
  });

  it("skips a tenant that is gone or neither active nor suspended", async () => {
    for (const tenant of [null, { ...TENANT, status: "deleted" as const }]) {
      const { instance, handle } = processor(tenant);

      expect(
        await instance.process(job("stripe.event", { tenantId: TENANT.id, paymentEventId: EVENT_ID })),
      ).toMatchObject({
        outcome: "skipped",
        reason: tenant === null ? "tenant_not_found" : "tenant_deleted",
      });
      expect(handle).not.toHaveBeenCalled();
    }
  });

  it("handles the event in the tenant's context, as the system, with the job id as request id", async () => {
    const { instance, handle, contexts } = processor({ ...TENANT, status: "suspended" });

    expect(
      await instance.process(job("stripe.event", { tenantId: TENANT.id, paymentEventId: EVENT_ID })),
    ).toEqual({
      tenantId: TENANT.id,
      paymentEventId: EVENT_ID,
      type: "payment_intent.succeeded",
      outcome: "applied",
    });
    expect(handle).toHaveBeenCalledWith(EVENT_ID);
    expect(contexts).toEqual([
      expect.objectContaining({
        tenantId: TENANT.id,
        schemaName: "tenant_alpha",
        actor: { type: "system", id: null },
        requestId: "evt_test_job",
      }),
    ]);
  });
});

describe("the account a stored event's object is read on (OBE-078)", () => {
  /** The OTA's own account of the tests, another one, and the tenant's payment connection. */
  const ACCOUNT = "acct_1ProcessorOwnAccount";
  const OTHER_ACCOUNT = "acct_1ProcessorOtherAccount";
  const CONNECTION_ID = "ppc_01JBPROCESSORCONNECTION00";
  const PAYMENT_ID = "pay_01JBPROCESSOR000000000000";
  /** The base64 ciphertext of the connection's key, as the platform cache holds it (never decrypted here). */
  const CIPHERTEXT = "c2VhbGVkLWZvci10aGUtdGVzdA==";

  interface Input {
    readonly endpoint: string;
    /** `account` of the stored payload (the receiver's `acct_…`); none on the Velexis endpoint. */
    readonly account?: string;
    /** `payments.metadata.connection`: the account the payment was created on; none for a `velexis` payment. */
    readonly recorded?: { readonly accountMode: string; readonly accountReference: string | null };
    /** The tenant's payment connection of the environment, as the platform cache answers it. */
    readonly connection?: Partial<PlatformPaymentConnection> | null;
    /** What `withAccount` does: answer the job's outcome, or refuse the target. */
    readonly unreachable?: StripeAccountUnavailableError;
  }

  /** A tenant connection that is `connect_standard` on the test account, and one that is `velexis`. */
  const CONNECTED = {
    accountMode: "connect_standard",
    publishableKey: null,
    secretCiphertext: null,
  } as const;
  const VELEXIS_ROW = {
    accountMode: "velexis",
    accountReference: null,
    publishableKey: null,
    secretCiphertext: null,
  } as const;

  /** A handler whose platform cache, Stripe factory and repository are fakes: `withAccount` records its target. */
  function handler(input: Input) {
    const targets: StripeAccountTarget[] = [];
    const logs: Array<{ level: string; message: string; object: Record<string, unknown> }> = [];
    const log =
      (level: string) =>
      (object: Record<string, unknown>, message: string): void => {
        logs.push({ level, message, object });
      };
    const logger = {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    } as unknown as PinoLogger;
    const event: PaymentEventRow = {
      id: EVENT_ID,
      paymentId: PAYMENT_ID,
      type: "webhook.payment_intent.succeeded",
      source: "webhook",
      providerEventId: "evt_test_processor_account",
      payload: {
        endpoint: input.endpoint,
        ...(input.account === undefined ? {} : { account: input.account, connectionId: CONNECTION_ID }),
        object: { type: "payment_intent", id: "pi_test_processor_account" },
        paymentIntentId: "pi_test_processor_account",
      },
      createdAt: new Date(0),
    };
    const payment = {
      id: PAYMENT_ID,
      environment: "test",
      provider: "stripe",
      providerPaymentId: "pi_test_processor_account",
      currency: "EUR",
      metadata: input.recorded === undefined ? {} : { connection: input.recorded },
    } as unknown as PaymentRow;
    const repository = {
      event: () => Promise.resolve(event),
      payment: () => Promise.resolve(payment),
      currencyMinorUnits: () => Promise.resolve(2),
    } as unknown as PaymentsRepository;
    const connectionLookups = vi.fn();
    const connection: PlatformPaymentConnection | null =
      input.connection === null
        ? null
        : {
            id: CONNECTION_ID,
            tenantId: TENANT.id,
            provider: "stripe",
            environment: "test",
            accountMode: "api_keys",
            accountReference: ACCOUNT,
            publishableKey: "pk_test_processorOwnKeys",
            supportedMethods: ["card"],
            captureMode: "manual",
            status: "active",
            statementDescriptorSuffix: null,
            secretCiphertext: CIPHERTEXT,
            ...input.connection,
          };
    const cache = {
      connection: (kind: string, tenantId: string, environment: string) => {
        connectionLookups(kind, tenantId, environment);
        return Promise.resolve(connection);
      },
    } as unknown as PlatformCache;
    const clients = {
      withAccount: (target: StripeAccountTarget) => {
        targets.push(target);
        return input.unreachable === undefined
          ? Promise.resolve("unchanged")
          : Promise.reject(input.unreachable);
      },
    } as unknown as StripeClientFactory;
    const instance = new StripeEventHandler(
      {
        run: <T>(fn: (trx: TenantTransaction) => Promise<T>) => fn({} as TenantTransaction),
      } as unknown as TenantTx,
      { require: () => ({ tenantId: TENANT.id }) } as unknown as TenantContext,
      repository,
      clients,
      {} as StaffRecipients,
      {} as ConfigService<WorkerConfig, true>,
      {} as Clock,
      {} as IdGenerator,
      logger,
      cache,
      {} as PlatformReadRepository,
    );
    return { instance, targets, logs, connectionLookups };
  }

  it("reads a velexis event on the Velexis account and a connect_standard payment with Stripe-Account [OBE-078 AC1]", async () => {
    const velexis = handler({ endpoint: "velexis" });
    expect(await velexis.instance.handle(EVENT_ID)).toEqual({
      type: "payment_intent.succeeded",
      outcome: "unchanged",
    });
    expect(velexis.targets).toEqual([{ accountMode: "velexis", environment: "test" }]);

    // The tenant's connection still the connect_standard one of that account.
    const connect = handler({
      endpoint: "connect",
      account: ACCOUNT,
      recorded: { accountMode: "connect_standard", accountReference: ACCOUNT },
      connection: { accountMode: "connect_standard", publishableKey: null, secretCiphertext: null },
    });
    expect((await connect.instance.handle(EVENT_ID)).outcome).toBe("unchanged");
    expect(connect.targets).toEqual([
      { accountMode: "connect_standard", environment: "test", accountReference: ACCOUNT },
    ]);
    // A velexis event never reads the tenant's connection; a Connect one does since FIX-W37-OTA (lead decision (2l)):
    // whether the OTA has moved that account to its own keys.
    expect([velexis.connectionLookups, connect.connectionLookups].map((lookup) => lookup.mock.calls)).toEqual(
      [[], [["payment", TENANT.id, "test"]]],
    );
  });

  // The mirror of lead decision (2i), lead decision (2l) of 2026-10-31: by the gateway's one rule (paymentTargetOf).
  it.each([
    { name: "api_keys on the payment's account", connection: {}, expected: "own_key" },
    { name: "connect_standard on the payment's account", connection: CONNECTED, expected: "connect" },
    {
      name: "api_keys on another account",
      connection: { accountReference: "acct_1ProcessorOtherAccount" },
      expected: "connect",
    },
    { name: "velexis", connection: VELEXIS_ROW, expected: "connect" },
    { name: "no connection", connection: null, expected: "connect" },
    {
      name: "api_keys on the payment's account without its key",
      connection: { secretCiphertext: null },
      expected: "connect",
    },
  ] as const)(
    "[FIX-W37-OTA AC7] reads a connect_standard payment after a switch to $name by the gateway's rule",
    async ({ connection, expected }) => {
      for (const endpoint of ["connect", "connection"] as const) {
        const { instance, targets, logs } = handler({
          endpoint,
          account: ACCOUNT,
          recorded: { accountMode: "connect_standard", accountReference: ACCOUNT },
          connection: connection as Partial<PlatformPaymentConnection> | null,
        });

        expect((await instance.handle(EVENT_ID)).outcome).toBe("unchanged");
        expect(targets).toEqual([
          expected === "own_key"
            ? {
                accountMode: "api_keys",
                environment: "test",
                connectionId: CONNECTION_ID,
                secretCiphertext: CIPHERTEXT,
              }
            : { accountMode: "connect_standard", environment: "test", accountReference: ACCOUNT },
        ]);
        expect(JSON.stringify(logs)).not.toContain(CIPHERTEXT);
      }
    },
  );

  it("reads an api_keys payment with the key the tenant's connection holds for its account [OBE-078 AC1]", async () => {
    const { instance, targets, connectionLookups, logs } = handler({
      endpoint: "connection",
      account: ACCOUNT,
      recorded: { accountMode: "api_keys", accountReference: ACCOUNT },
    });

    expect((await instance.handle(EVENT_ID)).outcome).toBe("unchanged");
    expect(targets).toEqual([
      {
        accountMode: "api_keys",
        environment: "test",
        connectionId: CONNECTION_ID,
        secretCiphertext: CIPHERTEXT,
      },
    ]);
    expect(connectionLookups.mock.calls).toEqual([["payment", TENANT.id, "test"]]);
    expect(JSON.stringify(logs)).not.toContain(CIPHERTEXT);
  });

  it("reads an api_keys payment through the Connect path once its account is connected (lead decision (2i))", async () => {
    const { instance, targets } = handler({
      endpoint: "connect",
      account: ACCOUNT,
      recorded: { accountMode: "api_keys", accountReference: ACCOUNT },
      connection: { accountMode: "connect_standard", publishableKey: null, secretCiphertext: null },
    });

    expect((await instance.handle(EVENT_ID)).outcome).toBe("unchanged");
    expect(targets).toEqual([
      { accountMode: "connect_standard", environment: "test", accountReference: ACCOUNT },
    ]);
  });

  it("never reads a payment that does not live on the event's account: a security event, nothing read", async () => {
    for (const input of [
      // A velexis payment named by a Connect event, and a stored event without its account.
      { endpoint: "connect", account: ACCOUNT },
      { endpoint: "connection", recorded: { accountMode: "api_keys", accountReference: ACCOUNT } },
      // A payment created on another acct_.
      {
        endpoint: "connect",
        account: ACCOUNT,
        recorded: { accountMode: "connect_standard", accountReference: OTHER_ACCOUNT },
      },
      {
        endpoint: "connection",
        account: ACCOUNT,
        recorded: { accountMode: "velexis", accountReference: null },
      },
    ] satisfies Input[]) {
      const { instance, targets, logs, connectionLookups } = handler(input);

      expect([input, await instance.handle(EVENT_ID)]).toEqual([
        input,
        { type: "payment_intent.succeeded", outcome: "mismatch" },
      ]);
      expect([input, targets, connectionLookups.mock.calls]).toEqual([input, [], []]);
      expect(logs).toContainEqual({
        level: "warn",
        message: "payments.stripe_event_mismatch",
        object: expect.objectContaining({
          securityEvent: "payments.stripe_event_mismatch",
          check: "payment_account",
          paymentId: PAYMENT_ID,
        }),
      });
    }
  });

  it("fails the job for BullMQ's retries when the payment's account cannot be reached, logged with ids only", async () => {
    const recorded = { accountMode: "api_keys", accountReference: ACCOUNT };
    for (const connection of [
      null,
      { accountReference: OTHER_ACCOUNT },
      { accountMode: "velexis" as const, accountReference: null, secretCiphertext: null },
      { secretCiphertext: null },
      { tenantId: "ten_01JBANOTHERTENANT000000000" },
    ] satisfies Input["connection"][]) {
      const { instance, targets, logs } = handler({
        endpoint: "connection",
        account: ACCOUNT,
        recorded,
        connection,
      });

      await expect(instance.handle(EVENT_ID)).rejects.toThrow(/cannot be read/);
      expect([connection, targets]).toEqual([connection, []]);
      expect(logs).toContainEqual({
        level: "error",
        message: "payments.stripe_event_not_configured",
        object: {
          paymentEventId: EVENT_ID,
          environment: "test",
          reason: "payment_account_unavailable",
          connectionId: null,
        },
      });
      expect(logs.some((line) => line.message === "payments.stripe_event_mismatch")).toBe(false);
    }

    // A key the factory cannot decrypt: the same retry, with the factory's reason and the connection id.
    const { instance, logs } = handler({
      endpoint: "connection",
      account: ACCOUNT,
      recorded,
      unreachable: new StripeAccountUnavailableError("secret_unreadable", "test", CONNECTION_ID),
    });
    await expect(instance.handle(EVENT_ID)).rejects.toThrow(/secret_unreadable/);
    expect(logs.at(-1)).toEqual({
      level: "error",
      message: "payments.stripe_event_not_configured",
      object: {
        paymentEventId: EVENT_ID,
        environment: "test",
        reason: "secret_unreadable",
        connectionId: CONNECTION_ID,
      },
    });
    expect(JSON.stringify(logs)).not.toContain(CIPHERTEXT);
  });
});
