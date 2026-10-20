// Unit tests of the ota-stripe-events consumer's edges (OBE-039): the job's payload, the facts read back from a stored
// webhook row, and the jobs it refuses or skips before it touches tenant data. Processing itself (the reads from
// Stripe and the state applied) runs against PostgreSQL, Redis and the fake Stripe API in
// test/integration/payments/webhooks.int.test.ts.
import { UnrecoverableError, type Job } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import {
  parseStripeEventJobData,
  storedFactsOf,
  StripeEventsProcessor,
  type StripeEventHandler,
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
