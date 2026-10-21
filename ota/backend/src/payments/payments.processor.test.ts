// Unit tests of the `ota-payments` consumer (OBE-040): the jobs and their payloads, the rules of payments.processor.ts
// and refunds.repository.ts (provider failures, capture amounts, the refund claim and what can be refunded), the jobs it
// refuses or skips before it touches tenant data, and the handler's decisions with doubles of its repositories and the
// gateway: a job whose row already moved never reaches the gateway. The same paths run against PostgreSQL, Redis and the
// fake Stripe API in test/integration/payments/payments-queue.int.test.ts.
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { UnrecoverableError, type Job } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { PAYMENT_JOBS } from "../bookings/booking-orchestrator.service";
import type { Clock } from "../common/clock";
import type { IdGenerator } from "../common/ids";
import type { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import { AUTHORISATION_WATCH_JOB, authorisationAlertReason } from "./authorisation-watch.processor";
import type { GatewayState, PaymentGateway } from "./payment-gateway";
import {
  attemptOf,
  captureAmountOf,
  failureCodeOf,
  isPaymentJobName,
  parsePaymentJobData,
  PAYMENT_JOB,
  paymentJob,
  PaymentJobsHandler,
  PaymentProviderUnavailableError,
  PaymentsProcessor,
  providerFailureOf,
  RefundSubmissionInFlightError,
  type PaymentAlerts,
  type PaymentJobAttempt,
} from "./payments.processor";
import type { PaymentRow, PaymentsRepository } from "./payments.repository";
import {
  isRefundAmount,
  REFUND_CLAIM_LEASE_MS,
  refundableAmount,
  refundSubmission,
  type RefundJobRow,
  type RefundsRepository,
} from "./refunds.repository";
import { StripeCallError, StripeMetadataMismatchError } from "./stripe/stripe.gateway";

const TENANT: PlatformTenant = {
  id: "ten_01JBPAYMENTS0000000000000",
  key: "alpha",
  name: "Alpha Travel",
  status: "active",
  schemaName: "tenant_alpha" as PlatformTenant["schemaName"],
  storefrontEnvironment: "test",
  defaultCurrency: "EUR",
  defaultLocale: "en",
  billingNotice: null,
};
const PAYMENT_ID = "pay_01JBPAYMENTS0000000000000";
const REFUND_ID = "rfd_01JBPAYMENTS0000000000000";
const ATTEMPT: PaymentJobAttempt = { jobId: `payment-void-${PAYMENT_ID}`, last: false };

const logger = (): PinoLogger =>
  ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as PinoLogger;

const stripeFailure = (statusCode: number | null, stripeCode: string | null = null): AppError =>
  new AppError("PAYMENT_PROVIDER_ERROR", {
    cause: new StripeCallError("paymentIntents.cancel", "api_error", stripeCode, statusCode, null),
  });

/** A Stripe card payment row as checkout.createPayment and the webhooks leave it. */
function paymentRow(patch: Partial<PaymentRow> = {}): PaymentRow {
  const created = new Date("2026-01-15T10:00:00.000Z");
  return {
    id: PAYMENT_ID,
    environment: "test",
    checkoutId: "chk_01JBPAYMENTS0000000000000",
    bookingId: null,
    customerId: null,
    provider: "stripe",
    providerConnectionId: "ppc_01JBPAYMENTS0000000000000",
    providerPaymentId: "pi_test_unit",
    method: "card",
    captureMethod: "manual",
    currency: "EUR",
    amount: "452.10",
    cardFeeAmount: "0.00",
    amountAuthorized: "452.10",
    amountCaptured: "0.00",
    amountRefunded: "0.00",
    status: "authorized",
    cardBrand: "VISA",
    cardBin: null,
    cardLast4: "4242",
    cardExpMonth: 12,
    cardExpYear: 2030,
    threeDs: null,
    nextAction: null,
    failureCode: null,
    failureMessage: null,
    authorizedAt: created,
    capturedAt: null,
    canceledAt: null,
    version: 3,
    createdAt: created,
    updatedAt: created,
    checkoutCustomerId: null,
    checkoutIsGuest: true,
    ...patch,
  };
}

function refundRow(patch: Partial<RefundJobRow> = {}): RefundJobRow {
  const created = new Date("2026-01-15T10:00:00.000Z");
  return {
    id: REFUND_ID,
    paymentId: PAYMENT_ID,
    bookingId: null,
    currency: "EUR",
    amount: "100.00",
    status: "pending",
    providerRefundId: null,
    failureReason: null,
    processedAt: null,
    version: 1,
    createdAt: created,
    updatedAt: created,
    ...patch,
  };
}

/** A PaymentIntent of the payment as the gateway reads it back. */
function intentState(status: GatewayState["status"], patch: Partial<GatewayState> = {}): GatewayState {
  return {
    providerPaymentId: "pi_test_unit",
    status,
    amount: "452.10",
    amountCapturable: status === "authorized" ? "452.10" : "0.00",
    amountReceived: status === "captured" ? "452.10" : "0.00",
    card: { brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 },
    threeDSecure: null,
    failure: null,
    clientSecret: null,
    ...patch,
  };
}

describe("the jobs of ota-payments", () => {
  it("are the names the booking orchestration queues, and refund.submit", () => {
    expect(PAYMENT_JOB).toEqual({
      void: PAYMENT_JOBS.void,
      captureRetry: PAYMENT_JOBS.captureRetry,
      refundSubmit: "refund.submit",
    });
    expect(["payment.void", "payment.capture_retry", "refund.submit"].every(isPaymentJobName)).toBe(true);
    expect(isPaymentJobName("stripe.event")).toBe(false);
  });

  it("carry {tenantId, id} with a deterministic job id per payment or refund", () => {
    expect(paymentJob(PAYMENT_JOB.void, TENANT.id, PAYMENT_ID)).toEqual({
      name: "payment.void",
      data: { tenantId: TENANT.id, id: PAYMENT_ID },
      opts: { jobId: `payment-void-${PAYMENT_ID}` },
    });
    expect(paymentJob(PAYMENT_JOB.captureRetry, TENANT.id, PAYMENT_ID).opts.jobId).toBe(
      `capture-retry-${PAYMENT_ID}`,
    );
    expect(paymentJob(PAYMENT_JOB.refundSubmit, TENANT.id, REFUND_ID).opts.jobId).toBe(
      `refund-submit-${REFUND_ID}`,
    );
  });

  it("accept exactly a tenant id and the id of the job's row", () => {
    expect(parsePaymentJobData("payment.void", { tenantId: TENANT.id, id: PAYMENT_ID })).toEqual({
      tenantId: TENANT.id,
      id: PAYMENT_ID,
    });
    expect(parsePaymentJobData("refund.submit", { tenantId: TENANT.id, id: REFUND_ID })).toEqual({
      tenantId: TENANT.id,
      id: REFUND_ID,
    });
    for (const [name, data] of [
      ["payment.void", null],
      ["payment.void", { tenantId: TENANT.id }],
      ["payment.void", { tenantId: TENANT.id, id: PAYMENT_ID, amount: "1.00" }],
      ["payment.void", { tenantId: "tenant_alpha", id: PAYMENT_ID }],
      ["payment.void", { tenantId: TENANT.id, id: REFUND_ID }],
      ["payment.capture_retry", { tenantId: TENANT.id, id: "pay_<script>" }],
      ["refund.submit", { tenantId: TENANT.id, id: PAYMENT_ID }],
    ] as const) {
      expect([name, data, parsePaymentJobData(name, data)]).toEqual([name, data, undefined]);
    }
  });

  it("know their last attempt from the job's options", () => {
    const job = (attemptsMade: number, attempts?: number) =>
      ({ id: "payment-void-x", name: "payment.void", attemptsMade, opts: { attempts } }) as unknown as Job;

    expect(attemptOf(job(0, 5))).toEqual({ jobId: "payment-void-x", last: false });
    expect(attemptOf(job(4, 5))).toEqual({ jobId: "payment-void-x", last: true });
    expect(attemptOf(job(0))).toEqual({ jobId: "payment-void-x", last: true });
  });
});

describe("the rules", () => {
  it("try again what may pass, and stop after a refusal, a 5xx kept for the key or a foreign PaymentIntent", () => {
    expect(providerFailureOf(stripeFailure(null))).toBe("retry");
    expect(providerFailureOf(stripeFailure(429))).toBe("retry");
    expect(providerFailureOf(stripeFailure(409))).toBe("retry");
    expect(providerFailureOf(new AppError("PAYMENT_PROVIDER_NOT_CONFIGURED"))).toBe("retry");
    expect(providerFailureOf(stripeFailure(400, "payment_intent_unexpected_state"))).toBe("refused");
    expect(providerFailureOf(stripeFailure(402, "card_declined"))).toBe("refused");
    expect(providerFailureOf(stripeFailure(500))).toBe("kept");
    expect(
      providerFailureOf(
        new AppError("PAYMENT_PROVIDER_ERROR", { cause: new StripeMetadataMismatchError(PAYMENT_ID) }),
      ),
    ).toBe("mismatch");
    expect(providerFailureOf(new Error("connection terminated"))).toBeUndefined();
    expect(providerFailureOf(new AppError("NOT_FOUND"))).toBeUndefined();
  });

  it("name a failure by Stripe's code, never by a message", () => {
    expect(failureCodeOf(stripeFailure(400, "charge_already_refunded"))).toBe("charge_already_refunded");
    expect(failureCodeOf(stripeFailure(400, "Not a code!"))).toBe("provider_http_400");
    expect(failureCodeOf(stripeFailure(null))).toBe("provider_unreachable");
    expect(failureCodeOf(new AppError("PAYMENT_PROVIDER_NOT_CONFIGURED"))).toBe(
      "PAYMENT_PROVIDER_NOT_CONFIGURED",
    );
  });

  it("capture again the amount of the failed capture, within the authorisation", () => {
    const payment = { amount: "452.10", amountAuthorized: "452.10" };

    expect(captureAmountOf("440.00", payment, 2)).toBe("440.00");
    expect(captureAmountOf("452.1", payment, 2)).toBe("452.10");
    expect(captureAmountOf(null, payment, 2)).toBe("452.10");
    expect(captureAmountOf("500.00", payment, 2)).toBe("452.10");
    expect(captureAmountOf("-1", payment, 2)).toBe("452.10");
    expect(captureAmountOf(null, { amount: "452.10", amountAuthorized: "0.00" }, 2)).toBe("452.10");
    expect(captureAmountOf("1200", { amount: "1200", amountAuthorized: "1200" }, 0)).toBe("1200");
  });

  it("submit a pending refund, leave a fresh claim to its job and take over an abandoned one", () => {
    const now = new Date("2026-01-15T10:00:00.000Z");
    const claimedAt = (ms: number) => new Date(now.getTime() - ms);

    expect(refundSubmission(refundRow(), now)).toBe("submit");
    expect(refundSubmission(refundRow({ status: "processing", updatedAt: claimedAt(60_000) }), now)).toBe(
      "in_flight",
    );
    expect(
      refundSubmission(refundRow({ status: "processing", updatedAt: claimedAt(REFUND_CLAIM_LEASE_MS) }), now),
    ).toBe("submit");
    expect(refundSubmission(refundRow({ status: "processing", providerRefundId: "re_test_1" }), now)).toBe(
      "done",
    );
    expect(refundSubmission(refundRow({ status: "pending", providerRefundId: "re_test_1" }), now)).toBe(
      "done",
    );
    for (const status of ["succeeded", "failed", "canceled"]) {
      expect(refundSubmission(refundRow({ status }), now)).toBe("done");
    }
  });

  it("refund at most the captured amount less the refunded amount and the refunds in flight", () => {
    expect(refundableAmount({ amountCaptured: "452.10", amountRefunded: "0.00" }, "0")).toBe("452.10");
    expect(refundableAmount({ amountCaptured: "452.10", amountRefunded: "100.00" }, "52.10")).toBe("300.00");
    expect(refundableAmount({ amountCaptured: "452.10", amountRefunded: "452.10" }, "100.00")).toBe("0.00");
    expect(isRefundAmount("100.00", 2)).toBe(true);
    expect(isRefundAmount("100.5", 2)).toBe(true);
    expect(isRefundAmount("100.50", 0)).toBe(false);
    expect(isRefundAmount("0", 2)).toBe(false);
    expect(isRefundAmount("-5.00", 2)).toBe(false);
    expect(isRefundAmount("1e3", 2)).toBe(false);
    expect(isRefundAmount("100.001", 3)).toBe(false);
  });

  it("alert about an authorisation with its ids, amount and dates", () => {
    expect(AUTHORISATION_WATCH_JOB).toBe("payments.authorisation_watch");
    const reason = authorisationAlertReason({
      id: PAYMENT_ID,
      environment: "live",
      bookingId: null,
      currency: "EUR",
      amountAuthorized: "452.10",
      authorizedAt: new Date("2026-01-09T10:00:00.000Z"),
    });

    expect(reason).toContain(`${PAYMENT_ID} (452.10 EUR, live)`);
    expect(reason).toContain("authorised at 2026-01-09T10:00:00.000Z");
    expect(reason).toContain("around 2026-01-16T10:00:00.000Z");
  });
});

/** The processor with doubles of its handler, cache and tenant context. */
function processor(tenant: PlatformTenant | null) {
  const run = vi.fn(() => Promise.resolve("applied" as const));
  const contexts: RequestTenant[] = [];
  const log = logger();
  const instance = new PaymentsProcessor(
    { run } as unknown as PaymentJobsHandler,
    { tenantById: vi.fn(() => Promise.resolve(tenant)) } as unknown as PlatformCache,
    {
      run: async <T>(context: RequestTenant, fn: () => Promise<T>): Promise<T> => {
        contexts.push(context);
        return await fn();
      },
    } as unknown as TenantContext,
    log,
  );
  return { instance, run, contexts, logger: log };
}

const job = (name: string, data: unknown, attemptsMade = 0): Job =>
  ({
    id: `job-${name}`,
    name,
    data,
    queueName: "ota-payments",
    attemptsMade,
    opts: { attempts: 5 },
  }) as unknown as Job;

describe("PaymentsProcessor", () => {
  it("refuses any other job at once, without retries and without the payload in the log", async () => {
    const { instance, run, logger: log } = processor(TENANT);

    for (const refused of [
      job("stripe.event", { tenantId: TENANT.id, id: PAYMENT_ID }),
      job("payment.void", { tenantId: TENANT.id, id: PAYMENT_ID, card: "4242424242424242" }),
      job("refund.submit", { tenantId: TENANT.id, id: PAYMENT_ID }),
    ]) {
      await expect(instance.process(refused)).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain("4242");
  });

  it("skips a tenant that is gone or neither active nor suspended", async () => {
    for (const tenant of [
      null,
      { ...TENANT, status: "deleted" as const },
      { ...TENANT, status: "failed" as const },
    ]) {
      const { instance, run } = processor(tenant);

      expect(await instance.process(job("payment.void", { tenantId: TENANT.id, id: PAYMENT_ID }))).toEqual({
        tenantId: TENANT.id,
        job: "payment.void",
        id: PAYMENT_ID,
        outcome: "skipped",
        reason: tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`,
      });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("runs the job in the tenant's context, as the system, also for a suspended tenant", async () => {
    const { instance, run, contexts } = processor({ ...TENANT, status: "suspended" });

    expect(await instance.process(job("refund.submit", { tenantId: TENANT.id, id: REFUND_ID }, 4))).toEqual({
      tenantId: TENANT.id,
      job: "refund.submit",
      id: REFUND_ID,
      outcome: "applied",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith("refund.submit", REFUND_ID, {
      jobId: "job-refund.submit",
      last: true,
    });
    expect(contexts).toEqual([
      expect.objectContaining({
        tenantId: TENANT.id,
        schemaName: "tenant_alpha",
        actor: { type: "system", id: null },
        requestId: "job-refund.submit",
      }),
    ]);
  });
});

/** The handler with doubles: a transaction that is never used for SQL, the repositories and the gateway. */
function handler(options: { payment?: PaymentRow | undefined; refund?: RefundJobRow | undefined } = {}) {
  const trx = {} as TenantTransaction;
  const clock = new FakeClock();
  const gateway = {
    void: vi.fn(),
    capture: vi.fn(),
    refresh: vi.fn(),
    refund: vi.fn(),
  };
  const payments = {
    payment: vi.fn(() => Promise.resolve(options.payment)),
    currencyMinorUnits: vi.fn(() => Promise.resolve(2)),
    updatePayment: vi.fn(() => Promise.resolve(true)),
    insertEvent: vi.fn(() => Promise.resolve()),
  };
  const refunds = {
    refund: vi.fn(() => Promise.resolve(options.refund)),
    claim: vi.fn(() => Promise.resolve((options.refund?.version ?? 0) + 1)),
    markFailed: vi.fn(() => Promise.resolve(true)),
    release: vi.fn(() => Promise.resolve(true)),
  };
  const alerts = { send: vi.fn(() => Promise.resolve(true)) };
  const instance = new PaymentJobsHandler(
    {
      run: <T>(fn: (transaction: TenantTransaction) => Promise<T>): Promise<T> => fn(trx),
    } as unknown as TenantTx,
    { require: () => ({ tenantId: TENANT.id }) } as unknown as TenantContext,
    payments as unknown as PaymentsRepository,
    refunds as unknown as RefundsRepository,
    gateway as unknown as PaymentGateway,
    alerts as unknown as PaymentAlerts,
    clock as unknown as Clock,
    { newId: (prefix: string) => `${prefix}_01JBUNIT00000000000000000` } as unknown as IdGenerator,
    logger(),
  );
  return { instance, gateway, payments, refunds, alerts, clock };
}

describe("PaymentJobsHandler", () => {
  it("makes no Stripe call for a void of a payment already cancelled, captured or failed [OBE-040 AC1]", async () => {
    for (const status of ["canceled", "captured", "partially_refunded", "refunded", "failed"]) {
      const { instance, gateway, payments } = handler({ payment: paymentRow({ status }) });

      expect(await instance.run(PAYMENT_JOB.void, PAYMENT_ID, ATTEMPT)).toBe("unchanged");
      expect(gateway.void).not.toHaveBeenCalled();
      expect(gateway.refresh).not.toHaveBeenCalled();
      expect(payments.updatePayment).not.toHaveBeenCalled();
    }
  });

  it("voids an authorised payment through the gateway, in the payment's environment, with the job as request id", async () => {
    const { instance, gateway } = handler({ payment: paymentRow({ environment: "live" }) });
    gateway.void.mockRejectedValue(stripeFailure(null));

    await expect(instance.run(PAYMENT_JOB.void, PAYMENT_ID, ATTEMPT)).rejects.toThrow(/could not void/);
    expect(gateway.void).toHaveBeenCalledExactlyOnceWith(
      { tenantId: TENANT.id, environment: "live", requestId: ATTEMPT.jobId },
      expect.objectContaining({ id: PAYMENT_ID, providerPaymentId: "pi_test_unit", amount: "452.10" }),
    );
    // A failure that may pass is BullMQ's to retry: no re-read, no alert before the last attempt.
    expect(gateway.refresh).not.toHaveBeenCalled();
  });

  it("reads the PaymentIntent again after a 5xx Stripe kept for the key, and records the void it finds", async () => {
    const { instance, gateway, payments, alerts } = handler({ payment: paymentRow() });
    gateway.void.mockRejectedValue(stripeFailure(500));
    gateway.refresh.mockResolvedValue(intentState("canceled"));

    expect(await instance.run(PAYMENT_JOB.void, PAYMENT_ID, ATTEMPT)).toBe("applied");
    expect(gateway.void).toHaveBeenCalledOnce();
    expect(payments.updatePayment).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      PAYMENT_ID,
      3,
      expect.objectContaining({ status: "canceled" }),
    );
    expect(payments.insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "payment.voided", source: "system", status_to: "canceled" }),
    );
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("records a capture Stripe reports instead of the void, and alerts the staff", async () => {
    const { instance, gateway, payments, alerts } = handler({ payment: paymentRow() });
    gateway.void.mockRejectedValue(stripeFailure(400, "payment_intent_unexpected_state"));
    gateway.refresh.mockResolvedValue(intentState("captured"));

    expect(await instance.run(PAYMENT_JOB.void, PAYMENT_ID, ATTEMPT)).toBe("failed");
    expect(payments.insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "payment.captured", status_to: "captured" }),
    );
    expect(alerts.send).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ id: PAYMENT_ID }),
      {
        dedupeKey: `staff.payment:${PAYMENT_ID}:void_failed`,
        reason: expect.stringContaining("Stripe reports the payment captured"),
      },
    );
  });

  it("alerts the staff when the last attempt of a void finds Stripe unreachable", async () => {
    const { instance, gateway, payments, alerts } = handler({ payment: paymentRow() });
    gateway.void.mockRejectedValue(stripeFailure(null));
    gateway.refresh.mockRejectedValue(stripeFailure(null));

    expect(await instance.run(PAYMENT_JOB.void, PAYMENT_ID, { ...ATTEMPT, last: true })).toBe("failed");
    expect(gateway.refresh).toHaveBeenCalledOnce();
    expect(payments.updatePayment).not.toHaveBeenCalled();
    expect(alerts.send).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), {
      dedupeKey: `staff.payment:${PAYMENT_ID}:void_failed`,
      reason: expect.stringContaining("(provider_unreachable)"),
    });
  });

  it("changes nothing and does not retry when the PaymentIntent names another tenant or payment", async () => {
    const { instance, gateway, payments, alerts } = handler({ payment: paymentRow() });
    gateway.void.mockRejectedValue(
      new AppError("PAYMENT_PROVIDER_ERROR", { cause: new StripeMetadataMismatchError(PAYMENT_ID) }),
    );

    await expect(instance.run(PAYMENT_JOB.void, PAYMENT_ID, ATTEMPT)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(gateway.refresh).not.toHaveBeenCalled();
    expect(payments.updatePayment).not.toHaveBeenCalled();
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("makes no Stripe call for an airline-card payment or a payment without a PaymentIntent", async () => {
    for (const patch of [{ provider: "airline", providerPaymentId: null }, { providerPaymentId: null }]) {
      const { instance, gateway } = handler({ payment: paymentRow(patch) });

      expect(await instance.run(PAYMENT_JOB.void, PAYMENT_ID, ATTEMPT)).toBe("ignored");
      expect(await instance.run(PAYMENT_JOB.captureRetry, PAYMENT_ID, ATTEMPT)).toBe("ignored");
      expect(gateway.void).not.toHaveBeenCalled();
      expect(gateway.capture).not.toHaveBeenCalled();
    }
  });

  it("answers missing for a row that is gone", async () => {
    const { instance, gateway } = handler();

    expect(await instance.run(PAYMENT_JOB.void, PAYMENT_ID, ATTEMPT)).toBe("missing");
    expect(await instance.run(PAYMENT_JOB.refundSubmit, REFUND_ID, ATTEMPT)).toBe("missing");
    expect(gateway.void).not.toHaveBeenCalled();
    expect(gateway.refund).not.toHaveBeenCalled();
  });

  it("never submits a refund whose Stripe id is recorded or whose state is final [OBE-040 AC2]", async () => {
    for (const patch of [
      { status: "processing", providerRefundId: "re_test_1" },
      { status: "succeeded", providerRefundId: "re_test_1" },
      { status: "failed" },
      { status: "canceled" },
    ]) {
      const { instance, gateway, refunds } = handler({ payment: paymentRow(), refund: refundRow(patch) });

      expect(await instance.run(PAYMENT_JOB.refundSubmit, REFUND_ID, ATTEMPT)).toBe("unchanged");
      expect(gateway.refund).not.toHaveBeenCalled();
      expect(refunds.claim).not.toHaveBeenCalled();
    }
  });

  it("leaves a refund another job is submitting to that job, and BullMQ's next attempt [OBE-040 AC2]", async () => {
    const { instance, gateway, refunds, clock } = handler({ payment: paymentRow() });
    refunds.refund.mockResolvedValue(refundRow({ status: "processing", updatedAt: clock.now() }));

    await expect(instance.run(PAYMENT_JOB.refundSubmit, REFUND_ID, ATTEMPT)).rejects.toBeInstanceOf(
      RefundSubmissionInFlightError,
    );
    expect(gateway.refund).not.toHaveBeenCalled();
    expect(refunds.claim).not.toHaveBeenCalled();
  });

  it("fails a refund of a payment that cannot be refunded at Stripe, without a call", async () => {
    const { instance, gateway, refunds, alerts } = handler({
      payment: paymentRow({ provider: "airline", providerPaymentId: null }),
      refund: refundRow(),
    });

    expect(await instance.run(PAYMENT_JOB.refundSubmit, REFUND_ID, ATTEMPT)).toBe("failed");
    expect(refunds.markFailed).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      REFUND_ID,
      1,
      "payment_not_refundable",
      expect.any(Date),
    );
    expect(gateway.refund).not.toHaveBeenCalled();
    expect(alerts.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: PAYMENT_ID }),
      expect.objectContaining({ dedupeKey: `staff.refund:${REFUND_ID}:failed` }),
    );
  });

  it("fails a refund Stripe refuses with Stripe's code, records it and alerts the staff; the cancellation stands", async () => {
    const { instance, gateway, payments, refunds, alerts } = handler({
      payment: paymentRow({ status: "captured", amountCaptured: "452.10" }),
      refund: refundRow(),
    });
    gateway.refund.mockRejectedValue(stripeFailure(400, "charge_already_refunded"));

    expect(await instance.run(PAYMENT_JOB.refundSubmit, REFUND_ID, ATTEMPT)).toBe("failed");
    expect(gateway.refund).toHaveBeenCalledExactlyOnceWith(
      { tenantId: TENANT.id, environment: "test", requestId: ATTEMPT.jobId },
      {
        id: REFUND_ID,
        paymentId: PAYMENT_ID,
        providerPaymentId: "pi_test_unit",
        currency: "EUR",
        amount: "100.00",
        minorUnits: 2,
      },
    );
    // The claim (version 1 → 2) is what fails: a row another job took over meanwhile is left alone.
    expect(refunds.claim).toHaveBeenCalledExactlyOnceWith(expect.anything(), REFUND_ID, 1, expect.any(Date));
    expect(refunds.markFailed).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      REFUND_ID,
      2,
      "charge_already_refunded",
      expect.any(Date),
    );
    expect(refunds.release).not.toHaveBeenCalled();
    expect(payments.insertEvent).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        type: "refund.failed",
        source: "system",
        status_from: "processing",
        status_to: "failed",
        amount: "100.00",
      }),
    );
    expect(alerts.send).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ id: PAYMENT_ID }),
      {
        dedupeKey: `staff.refund:${REFUND_ID}:failed`,
        reason: expect.stringContaining("(charge_already_refunded). The cancellation stands"),
      },
    );
  });

  it("releases a refund whose submission got no answer, for BullMQ's next attempt with the same key", async () => {
    const { instance, gateway, refunds, alerts } = handler({
      payment: paymentRow({ status: "captured", amountCaptured: "452.10" }),
      refund: refundRow(),
    });
    gateway.refund.mockRejectedValue(stripeFailure(null));

    await expect(instance.run(PAYMENT_JOB.refundSubmit, REFUND_ID, ATTEMPT)).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
    expect(refunds.release).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      REFUND_ID,
      2,
      expect.any(Date),
    );
    expect(refunds.markFailed).not.toHaveBeenCalled();
    expect(alerts.send).not.toHaveBeenCalled();
  });
});
