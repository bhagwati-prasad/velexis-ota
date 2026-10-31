// The console payments (OBE-068): the rules of console.payments (statuses, amounts, cursors, the answer in console
// scope, the refusals of a refund), then ConsolePaymentsService over fakes: Stripe is called with no transaction open,
// a failed capture is decided by the PaymentIntent read again (a lost answer is recorded, an expired authorisation is
// 402, another capture 409, anything else 502), a refused refund writes nothing, and a refund request writes the
// booking's `refund.requested` event (never one that says refunded) and queues refund.submit after the commit, without
// ever failing the request on the enqueue. Against PostgreSQL, Redis and the fake Stripe API:
// test/integration/console/payments.int.test.ts. Every number here is made up on the spot.
import { AppError } from "@velexis/errors";
import type { Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { GatewayState, PaymentGateway } from "../payments/payment-gateway";
import type {
  ConsolePaymentEventRow,
  ConsoleRefundRow,
  PaymentRow,
  PaymentsRepository,
} from "../payments/payments.repository";
import type { CreateRefundResult, RefundsRepository } from "../payments/refunds.repository";
import { StripeCallError, StripeMetadataMismatchError } from "../payments/stripe/stripe.gateway";
import type { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type * as TenantTxModule from "../tenancy/tenant-tx";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import {
  authorizedCeilingOf,
  captureFailureOutcome,
  consolePaymentsFingerprint,
  ConsolePaymentsService,
  decodePaymentCursor,
  encodePaymentCursor,
  isCapturable,
  paymentEtagOf,
  refundRefusal,
  requestedAmountOf,
  storedStatusesOf,
  toConsolePayment,
} from "./console-payments.service";
import type { StaffActionsWriter } from "./staff-actions.writer";

/** The work `afterCommit` registered, run by the test as the commit would. */
const afterCommitWork = vi.hoisted(() => [] as (() => Promise<void> | void)[]);

vi.mock("../tenancy/tenant-tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TenantTxModule>()),
  afterCommit: (_trx: unknown, work: () => Promise<void> | void) => {
    afterCommitWork.push(work);
  },
}));

const NOW = new Date("2026-10-22T09:00:00.000Z");
const PAYMENT_ID = "pay_01JBCONSOLEPAYMENT00000000";
const BOOKING_ID = "bkg_01JBCONSOLEBOOKING00000000";
const STAFF_ID = "stf_01JBCONSOLESTAFF0000000000";
const INTENT_ID = "pi_3QconsoleIntent000000001";

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
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

function errorOf(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

/** A Stripe card payment of 452.10 EUR, authorised, as the webhooks leave it. */
function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: PAYMENT_ID,
    environment: "test",
    checkoutId: "chk_01JBCONSOLECHECKOUT0000000",
    bookingId: BOOKING_ID,
    customerId: null,
    provider: "stripe",
    providerConnectionId: "ppc_01JBCONSOLECONNECTION00000",
    providerPaymentId: INTENT_ID,
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
    cardBin: "424242",
    cardLast4: "4242",
    cardExpMonth: 12,
    cardExpYear: 2030,
    threeDs: { required: false, status: "not_required", version: null },
    nextAction: null,
    failureCode: null,
    failureMessage: null,
    authorizedAt: new Date("2026-10-21T09:00:00.000Z"),
    capturedAt: null,
    canceledAt: null,
    version: 3,
    createdAt: new Date("2026-10-21T08:59:00.000Z"),
    updatedAt: new Date("2026-10-21T09:00:00.000Z"),
    checkoutCustomerId: null,
    checkoutIsGuest: true,
    ...overrides,
  };
}

/** A PaymentIntent state as the gateway reads it. */
function state(overrides: Partial<GatewayState> = {}): GatewayState {
  return {
    providerPaymentId: INTENT_ID,
    status: "authorized",
    amount: "452.10",
    amountCapturable: "452.10",
    amountReceived: "0.00",
    card: { brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 },
    threeDSecure: null,
    failure: null,
    clientSecret: null,
    ...overrides,
  };
}

/** A Stripe failure as the gateway throws it: `502 PAYMENT_PROVIDER_ERROR` with Stripe's facts as the cause. */
const stripeFailure = (statusCode: number | null): AppError =>
  new AppError("PAYMENT_PROVIDER_ERROR", {
    cause: new StripeCallError("paymentIntents.capture", "api_error", null, statusCode, null),
  });

describe("the rules of console.payments", () => {
  it("lists `cancelled` as the stored `canceled`, and every other status as it is", () => {
    expect(storedStatusesOf(["authorized", "cancelled"])).toEqual(["authorized", "canceled"]);
    expect(storedStatusesOf(undefined)).toBeUndefined();
  });

  it("takes an amount in the payment's currency, positive, with at most the currency's minor units", () => {
    const eur = paymentRow();
    expect(requestedAmountOf({ amount: "100.5", currency: "EUR" }, eur, 2)).toBe("100.50");
    expect(requestedAmountOf({ amount: "7", currency: "EUR" }, eur, 2)).toBe("7.00");
    const currency = errorOf(() => requestedAmountOf({ amount: "1.00", currency: "USD" }, eur, 2));
    expect([currency.code, currency.details]).toEqual([
      "UNPROCESSABLE",
      { reason: "currency_mismatch", currency: "EUR" },
    ]);
    for (const amount of ["0", "0.00", "-1.00", "1.001", "01.00", "1e3"]) {
      const refused = errorOf(() => requestedAmountOf({ amount, currency: "EUR" }, eur, 2));
      expect([amount, refused.code, refused.fieldErrors?.map((error) => error.path)]).toEqual([
        amount,
        "VALIDATION_FAILED",
        ["/amount/amount"],
      ]);
    }
    // A currency without minor units takes whole amounts only.
    const jpy = paymentRow({ currency: "JPY" });
    expect(requestedAmountOf({ amount: "5000", currency: "JPY" }, jpy, 0)).toBe("5000");
    expect(errorOf(() => requestedAmountOf({ amount: "5000.5", currency: "JPY" }, jpy, 0)).code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("captures at most the authorised amount, and only an authorised Stripe payment with its PaymentIntent", () => {
    expect(authorizedCeilingOf(paymentRow({ amountAuthorized: "400.00" }))).toBe("400.00");
    // Before Stripe reported an amount, the payment's own.
    expect(authorizedCeilingOf(paymentRow({ amountAuthorized: "0.00" }))).toBe("452.10");
    expect(isCapturable(paymentRow())).toBe(true);
    expect(isCapturable(paymentRow({ status: "captured" }))).toBe(false);
    expect(isCapturable(paymentRow({ provider: "airline", providerPaymentId: null }))).toBe(false);
    expect(isCapturable(paymentRow({ providerPaymentId: null }))).toBe(false);
  });

  it("decides a failed capture by the PaymentIntent read again", () => {
    expect(captureFailureOutcome(undefined, "452.10")).toBe("provider_error");
    expect(captureFailureOutcome(state(), "452.10")).toBe("provider_error");
    expect(captureFailureOutcome(state({ status: "canceled" }), "452.10")).toBe("declined");
    expect(captureFailureOutcome(state({ status: "captured", amountReceived: "452.10" }), "452.10")).toBe(
      "captured",
    );
    expect(captureFailureOutcome(state({ status: "captured", amountReceived: "400.00" }), "452.10")).toBe(
      "conflict",
    );
  });

  it("binds a cursor to its environment and filters, and refuses one of another list", () => {
    const query = {
      status: ["captured", "authorized"] as ("captured" | "authorized")[],
      bookingId: BOOKING_ID,
    };
    const print = consolePaymentsFingerprint("test", query);
    // The order of a list's values does not matter; the environment and every filter do.
    expect(consolePaymentsFingerprint("test", { ...query, status: ["authorized", "captured"] })).toBe(print);
    expect(consolePaymentsFingerprint("live", query)).not.toBe(print);
    expect(consolePaymentsFingerprint("test", { ...query, provider: ["stripe"] })).not.toBe(print);
    const cursor = encodePaymentCursor(print, "2026-10-21T08:59:00.123456", PAYMENT_ID);
    expect(decodePaymentCursor(cursor, print)).toEqual({ key: "2026-10-21T08:59:00.123456", id: PAYMENT_ID });
    for (const bad of [
      encodePaymentCursor(
        consolePaymentsFingerprint("live", query),
        "2026-10-21T08:59:00.123456",
        PAYMENT_ID,
      ),
      encodePaymentCursor(print, "yesterday", PAYMENT_ID),
      encodePaymentCursor(print, "2026-10-21T08:59:00.123456", BOOKING_ID),
      "not a cursor",
      "",
    ]) {
      const refused = errorOf(() => decodePaymentCursor(bad, print));
      expect([refused.code, refused.fieldErrors?.[0]?.path]).toEqual(["VALIDATION_FAILED", "/query/cursor"]);
    }
  });

  it("answers a payment in console scope without a client secret, statuses in the API's spelling", () => {
    const event: ConsolePaymentEventRow = {
      id: "pev_01JBCONSOLEEVENT0000000000",
      paymentId: PAYMENT_ID,
      type: "payment.canceled",
      source: "webhook",
      statusFrom: "authorized",
      statusTo: "canceled",
      amount: null,
      currency: null,
      providerEventId: "evt_3QconsoleEvent00000000001",
      // A payload that somehow kept a secret: the answer redacts it again.
      payload: { paymentIntentId: INTENT_ID, clientSecret: "pi_3Qconsole_secret_abc" },
      createdAt: NOW,
    };
    const refund: ConsoleRefundRow = {
      id: "rfd_01JBCONSOLEREFUND000000000",
      paymentId: PAYMENT_ID,
      bookingId: BOOKING_ID,
      currency: "EUR",
      amount: "50",
      penaltyAmount: null,
      reason: "goodwill",
      reasonNote: null,
      status: "canceled",
      providerRefundId: null,
      requestedByType: "staff",
      // A key-only call's id is not a requester the document knows.
      requestedById: "key_01JBCONSOLEKEY00000000000",
      failureReason: null,
      processedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const payment = toConsolePayment({
      row: paymentRow({ status: "canceled", canceledAt: NOW }),
      minorUnits: 2,
      events: [event],
      refunds: [refund],
      booking: { id: BOOKING_ID, reference: "VX7K2Q", status: "confirmed" },
      accountMode: "velexis",
    });
    expect(payment).toMatchObject({
      id: PAYMENT_ID,
      status: "cancelled",
      clientSecret: null,
      providerPublicKey: null,
      environment: "test",
      version: 3,
      booking: { id: BOOKING_ID, reference: "VX7K2Q", status: "confirmed" },
      providerConnection: { accountMode: "velexis" },
    });
    expect(payment.events).toEqual([
      expect.objectContaining({
        statusFrom: "authorized",
        statusTo: "cancelled",
        payload: { paymentIntentId: INTENT_ID, clientSecret: "[REDACTED]" },
        createdAt: NOW.toISOString(),
      }),
    ]);
    expect(payment.refunds).toEqual([
      expect.objectContaining({
        amount: { amount: "50.00", currency: "EUR" },
        status: "cancelled",
        requestedBy: { type: "staff", id: null },
      }),
    ]);
    const airline = toConsolePayment({
      row: paymentRow({ provider: "airline", method: "airline_card", providerPaymentId: null }),
      minorUnits: 2,
      events: [],
      refunds: [],
      booking: undefined,
      accountMode: undefined,
    });
    expect(airline).toMatchObject({ booking: null, providerConnection: null, providerPaymentId: null });
    expect(paymentEtagOf(4)).toBe('"4"');
  });

  it("answers a refused refund with the document's codes and reasons", () => {
    const row = paymentRow({ status: "authorized" });
    expect(refundRefusal("payment_not_found", row, null).code).toBe("NOT_FOUND");
    expect(refundRefusal("refund_via_airline", row, null).details).toEqual({ reason: "refund_via_airline" });
    expect(refundRefusal("payment_not_refundable", row, null).details).toEqual({
      reason: "payment_not_refundable",
      status: "authorized",
      provider: "stripe",
    });
    expect(refundRefusal("amount_invalid", row, null).fieldErrors).toEqual([
      expect.objectContaining({ path: "/amount/amount" }),
    ]);
    const exceeds = refundRefusal("amount_exceeds_captured", row, { amount: "12.00", currency: "EUR" });
    expect([exceeds.code, exceeds.details]).toEqual([
      "UNPROCESSABLE",
      { reason: "amount_exceeds_captured", refundable: { amount: "12.00", currency: "EUR" } },
    ]);
  });
});

// ---- The service over fakes ----------------------------------------------------------------------------------------

const TENANT: RequestTenant = {
  tenantId: "ten_01JBCONSOLETENANT000000000",
  key: "alpha",
  schemaName: "tenant_alpha" as RequestTenant["schemaName"],
  environment: "test",
  caller: { type: "service" } as unknown as RequestTenant["caller"],
  actor: { type: "staff", id: STAFF_ID },
  requestId: "req_01JBCONSOLEREQUEST00000000",
};

/** The service with fakes: `row` is the payment as the database holds it now; `open` says a transaction is running. */
function harness(initial: PaymentRow) {
  let row = initial;
  let open = false;
  const trx = {} as TenantTransaction;
  const tx = {
    run: vi.fn(async (fn: (t: TenantTransaction) => Promise<unknown>) => {
      open = true;
      try {
        return await fn(trx);
      } finally {
        open = false;
      }
    }),
  };
  const payments = {
    payment: vi.fn(() => Promise.resolve(row)),
    currencyMinorUnits: vi.fn(() => Promise.resolve(2)),
    lockBookings: vi.fn(() => Promise.resolve([{ id: BOOKING_ID, amountPaid: "0.00" }])),
    updatePayment: vi.fn((_trx: unknown, _id: string, version: number, values: Record<string, unknown>) => {
      row = { ...row, status: String(values["status"]), version: version + 1 };
      return Promise.resolve(true);
    }),
    insertEvent: vi.fn(() => Promise.resolve()),
    setAmountPaid: vi.fn(() => Promise.resolve()),
    insertBookingEvent: vi.fn(() => Promise.resolve()),
    insertRefundBookingEvent: vi.fn(() => Promise.resolve()),
    consoleEvents: vi.fn(() => Promise.resolve([])),
    consoleRefunds: vi.fn((): Promise<ConsoleRefundRow[]> => Promise.resolve([])),
    bookingSummaries: vi.fn(() => Promise.resolve(new Map())),
  };
  const refunds = { create: vi.fn<() => Promise<CreateRefundResult>>() };
  const platform = { paymentConnectionModes: vi.fn(() => Promise.resolve(new Map())) };
  const gateway = {
    capture: vi.fn<() => Promise<GatewayState>>(),
    refresh: vi.fn<() => Promise<GatewayState>>(),
  };
  const queue = { add: vi.fn(() => Promise.resolve({})) };
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const tenants = { require: () => TENANT, requestId: () => undefined };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const clock = new Clock();
  vi.spyOn(clock, "now").mockReturnValue(NOW);
  const service = new ConsolePaymentsService(
    tx as unknown as TenantTx,
    payments as unknown as PaymentsRepository,
    refunds as unknown as RefundsRepository,
    platform as unknown as PlatformReadRepository,
    gateway as unknown as PaymentGateway,
    queue as unknown as Queue,
    audit as unknown as StaffActionsWriter,
    tenants as unknown as TenantContext,
    clock,
    new IdGenerator(clock),
    logger as unknown as PinoLogger,
  );
  return { service, tx, payments, refunds, platform, gateway, queue, audit, logger, isOpen: () => open };
}

beforeEach(() => {
  afterCommitWork.length = 0;
});

describe("ConsolePaymentsService.capture", () => {
  const body = { reason: "Manual review passed" };

  it("calls Stripe with no transaction open, then records the capture, the booking's payment and the staff action", async () => {
    const h = harness(paymentRow());
    let openDuringCall: boolean | undefined;
    h.gateway.capture.mockImplementation(() => {
      openDuringCall = h.isOpen();
      return Promise.resolve(
        state({ status: "captured", amountCapturable: "0.00", amountReceived: "452.10" }),
      );
    });
    const payment = await h.service.capture(PAYMENT_ID, '"3"', body);
    expect(openDuringCall).toBe(false);
    expect(h.gateway.capture).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT.tenantId, environment: "test" }),
      expect.objectContaining({ id: PAYMENT_ID, providerPaymentId: INTENT_ID }),
      "452.10",
    );
    expect(payment).toMatchObject({ status: "captured", version: 4 });
    expect(h.payments.lockBookings).toHaveBeenCalledWith(expect.anything(), [BOOKING_ID], "update");
    expect(h.payments.insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "payment.captured", source: "staff", amount: "452.10" }),
    );
    expect(h.payments.setAmountPaid).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, "452.10", NOW);
    expect(h.payments.insertBookingEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "payment.captured", actor_type: "staff", actor_id: STAFF_ID }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "payment.capture",
        reason: "Manual review passed",
        bookingId: BOOKING_ID,
      }),
    );
  });

  it("refuses a stale If-Match and a payment that is not authorised before any Stripe call", async () => {
    const stale = harness(paymentRow());
    expect((await rejectionOf(stale.service.capture(PAYMENT_ID, '"2"', body))).code).toBe(
      "PRECONDITION_FAILED",
    );
    const captured = harness(paymentRow({ status: "captured", amountCaptured: "452.10" }));
    const conflict = await rejectionOf(captured.service.capture(PAYMENT_ID, '"3"', body));
    expect([conflict.code, conflict.details]).toEqual([
      "CONFLICT",
      { reason: "payment_not_capturable", status: "captured", provider: "stripe" },
    ]);
    const other = harness(paymentRow({ environment: "live" }));
    expect((await rejectionOf(other.service.capture(PAYMENT_ID, '"3"', body))).code).toBe("NOT_FOUND");
    for (const h of [stale, captured, other]) {
      expect(h.gateway.capture).not.toHaveBeenCalled();
    }
  });

  it("records a capture whose answer was lost when Stripe holds it", async () => {
    const h = harness(paymentRow());
    h.gateway.capture.mockRejectedValue(stripeFailure(null));
    h.gateway.refresh.mockResolvedValue(state({ status: "captured", amountReceived: "452.10" }));
    expect(await h.service.capture(PAYMENT_ID, '"3"', body)).toMatchObject({ status: "captured" });
    expect(h.audit.record).toHaveBeenCalledTimes(1);
  });

  it("answers 402 PAYMENT_DECLINED for an authorisation that expired, after applying it", async () => {
    const h = harness(paymentRow());
    h.gateway.capture.mockRejectedValue(stripeFailure(400));
    h.gateway.refresh.mockResolvedValue(state({ status: "canceled", amountCapturable: "0.00" }));
    expect((await rejectionOf(h.service.capture(PAYMENT_ID, '"3"', body))).code).toBe("PAYMENT_DECLINED");
    expect(h.payments.updatePayment).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      3,
      expect.objectContaining({ status: "canceled" }),
    );
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it("answers 409 for a capture of another amount at Stripe, and 502 for a payment still authorised or unread", async () => {
    const elsewhere = harness(paymentRow());
    elsewhere.gateway.capture.mockRejectedValue(stripeFailure(400));
    elsewhere.gateway.refresh.mockResolvedValue(state({ status: "captured", amountReceived: "400.00" }));
    expect((await rejectionOf(elsewhere.service.capture(PAYMENT_ID, '"3"', body))).details).toMatchObject({
      reason: "payment_not_capturable",
      status: "captured",
    });
    const pending = harness(paymentRow());
    pending.gateway.capture.mockRejectedValue(stripeFailure(500));
    pending.gateway.refresh.mockResolvedValue(state());
    const unavailable = await rejectionOf(pending.service.capture(PAYMENT_ID, '"3"', body));
    expect([unavailable.code, unavailable.details]).toEqual([
      "PAYMENT_PROVIDER_ERROR",
      { provider: "stripe" },
    ]);
    expect(pending.payments.updatePayment).not.toHaveBeenCalled();
    const unread = harness(paymentRow());
    unread.gateway.capture.mockRejectedValue(stripeFailure(null));
    unread.gateway.refresh.mockRejectedValue(stripeFailure(null));
    expect((await rejectionOf(unread.service.capture(PAYMENT_ID, '"3"', body))).code).toBe(
      "PAYMENT_PROVIDER_ERROR",
    );
  });

  it("reads nothing again after a PaymentIntent of another payment, and lets a non-Stripe error through", async () => {
    const mismatch = harness(paymentRow());
    mismatch.gateway.capture.mockRejectedValue(
      new AppError("PAYMENT_PROVIDER_ERROR", { cause: new StripeMetadataMismatchError(PAYMENT_ID) }),
    );
    expect((await rejectionOf(mismatch.service.capture(PAYMENT_ID, '"3"', body))).code).toBe(
      "PAYMENT_PROVIDER_ERROR",
    );
    expect(mismatch.gateway.refresh).not.toHaveBeenCalled();
    const bug = harness(paymentRow());
    bug.gateway.capture.mockRejectedValue(new TypeError("not a Stripe failure"));
    await expect(bug.service.capture(PAYMENT_ID, '"3"', body)).rejects.toThrow(TypeError);
  });
});

describe("the account a payment was created on (OBE-077, PADR-0011 point 7)", () => {
  const CONNECT_ACCOUNT = "acct_1ConsoleConnect000000";
  /** A payment created on the OTA's connected account, as checkout.createPayment records it. */
  const connected = (patch: Partial<PaymentRow> = {}) =>
    paymentRow({
      metadata: { connection: { accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT } },
      ...patch,
    });

  it("shows the mode the payment recorded, whatever the connection's mode is now, and reads it again there", async () => {
    const h = harness(connected());
    // The OTA went back to the Velexis account since: the connection row was updated in place.
    h.platform.paymentConnectionModes.mockResolvedValue(
      new Map([[paymentRow().providerConnectionId, "velexis"]]),
    );
    h.gateway.refresh.mockResolvedValue(state());

    const payment = await h.service.get(PAYMENT_ID, { refresh: true });

    expect(payment.providerConnection).toEqual({ accountMode: "connect_standard" });
    expect(h.platform.paymentConnectionModes).not.toHaveBeenCalled();
    expect(h.gateway.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT.tenantId }),
      expect.objectContaining({
        id: PAYMENT_ID,
        account: { accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT },
      }),
    );
  });

  it("captures on the recorded account, and shows a payment without a record with its connection's mode", async () => {
    const h = harness(connected());
    h.gateway.capture.mockResolvedValue(
      state({ status: "captured", amountCapturable: "0.00", amountReceived: "452.10" }),
    );

    await h.service.capture(PAYMENT_ID, '"3"', { reason: "Manual review passed" });

    expect(h.gateway.capture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        account: { accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT },
      }),
      "452.10",
    );
    // Written before OBE-077 (`{}`): a velexis payment, shown with what its connection says.
    const legacy = harness(paymentRow({ metadata: {} }));
    const connectionId = paymentRow().providerConnectionId ?? "";
    legacy.platform.paymentConnectionModes.mockResolvedValue(new Map([[connectionId, "velexis"]]));

    const read = await legacy.service.get(PAYMENT_ID, { refresh: false });

    expect(read.providerConnection).toEqual({ accountMode: "velexis" });
    expect(legacy.platform.paymentConnectionModes).toHaveBeenCalledWith(TENANT.tenantId, [connectionId]);
  });
});

describe("ConsolePaymentsService.refund", () => {
  const body = { amount: { amount: "50.00", currency: "EUR" }, reason: "goodwill" as const };
  const captured = () => paymentRow({ status: "captured", amountCaptured: "452.10" });

  it("refuses an airline-card payment, an uncaptured one and another currency without asking for a refund", async () => {
    const real = harness(
      paymentRow({ provider: "airline", method: "airline_card", providerPaymentId: null }),
    );
    expect((await rejectionOf(real.service.refund(PAYMENT_ID, body))).details).toEqual({
      reason: "refund_via_airline",
    });
    const authorized = harness(paymentRow());
    expect((await rejectionOf(authorized.service.refund(PAYMENT_ID, body))).code).toBe("CONFLICT");
    const usd = harness(captured());
    expect(
      (
        await rejectionOf(
          usd.service.refund(PAYMENT_ID, { ...body, amount: { amount: "1.00", currency: "USD" } }),
        )
      ).details,
    ).toEqual({ reason: "currency_mismatch", currency: "EUR" });
    for (const h of [real, authorized, usd]) {
      expect(h.refunds.create).not.toHaveBeenCalled();
      expect(h.audit.record).not.toHaveBeenCalled();
    }
  });

  it("[OBE-068 AC1] answers 422 amount_exceeds_captured with what can still be refunded, and writes nothing", async () => {
    const h = harness(captured());
    h.refunds.create.mockResolvedValue({ ok: false, reason: "amount_exceeds_captured", refundable: "12" });
    const refused = await rejectionOf(h.service.refund(PAYMENT_ID, body));
    expect([refused.code, refused.details]).toEqual([
      "UNPROCESSABLE",
      { reason: "amount_exceeds_captured", refundable: { amount: "12.00", currency: "EUR" } },
    ]);
    expect(h.payments.insertRefundBookingEvent).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(afterCommitWork).toEqual([]);
  });

  it("writes refund.requested (never refunded), the staff action, and queues refund.submit after the commit", async () => {
    const h = harness(captured());
    h.refunds.create.mockImplementation((...args: unknown[]) => {
      const input = args[1] as { id: string; requestedBy: unknown; amount: string };
      expect(input.requestedBy).toEqual({ type: "staff", id: STAFF_ID });
      expect(input.amount).toBe("50.00");
      return Promise.resolve({
        ok: true,
        refund: {
          id: input.id,
          paymentId: PAYMENT_ID,
          bookingId: BOOKING_ID,
          currency: "EUR",
          amount: "50.00",
          status: "pending",
          providerRefundId: null,
          failureReason: null,
          processedAt: null,
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
    });
    await h.service.refund(PAYMENT_ID, body);
    expect(h.payments.insertRefundBookingEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "requested", bookingId: BOOKING_ID, amount: "50.00", currency: "EUR" }),
    );
    expect(h.payments.insertBookingEvent).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "payment.refund", targetId: PAYMENT_ID, reason: "goodwill" }),
    );
    // Nothing is queued before the commit; the commit's work adds the job with its deterministic id.
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(afterCommitWork).toHaveLength(1);
    await afterCommitWork[0]?.();
    expect(h.queue.add).toHaveBeenCalledWith(
      "refund.submit",
      { tenantId: TENANT.tenantId, id: expect.stringMatching(/^rfd_/) },
      { jobId: expect.stringMatching(/^refund-submit-rfd_/) },
    );
  });

  it("answers the pending refund as its own transaction left it, before refund.submit can claim it", async () => {
    const h = harness(captured());
    const refundId = "rfd_01JBCONSOLEREFUND000000001";
    let created = false;
    h.refunds.create.mockImplementation(() => {
      created = true;
      return Promise.resolve({
        ok: true,
        refund: {
          id: refundId,
          paymentId: PAYMENT_ID,
          bookingId: null,
          currency: "EUR",
          amount: "50.00",
          status: "pending",
          providerRefundId: null,
          failureReason: null,
          processedAt: null,
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
    });
    // As TenantTx.run does: the commit's work (the enqueue) runs when the transaction's function has resolved.
    h.tx.run.mockImplementation(async (fn: (t: TenantTransaction) => Promise<unknown>) => {
      const result = await fn({} as TenantTransaction);
      for (const work of afterCommitWork.splice(0)) {
        await work();
      }
      return result;
    });
    // What the database holds: the pending row once create() wrote it, `processing` once the queued job claimed it.
    h.payments.consoleRefunds.mockImplementation(() =>
      Promise.resolve(
        created
          ? [
              {
                id: refundId,
                paymentId: PAYMENT_ID,
                bookingId: null,
                currency: "EUR",
                amount: "50.00",
                penaltyAmount: null,
                reason: "goodwill",
                reasonNote: null,
                status: h.queue.add.mock.calls.length > 0 ? "processing" : "pending",
                providerRefundId: null,
                requestedByType: "staff",
                requestedById: STAFF_ID,
                failureReason: null,
                processedAt: null,
                createdAt: NOW,
                updatedAt: NOW,
              } satisfies ConsoleRefundRow,
            ]
          : [],
      ),
    );
    const payment = await h.service.refund(PAYMENT_ID, body);
    // One transaction: the checks, the writes and the answer; the job is queued by the commit's work, after it.
    expect(h.tx.run).toHaveBeenCalledTimes(1);
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    expect(payment.refunds).toEqual([expect.objectContaining({ id: refundId, status: "pending" })]);
  });

  it("never fails the request on the enqueue: a Redis error is logged", async () => {
    const h = harness(captured());
    h.refunds.create.mockResolvedValue({
      ok: true,
      refund: {
        id: "rfd_01JBCONSOLEREFUND000000000",
        paymentId: PAYMENT_ID,
        bookingId: null,
        currency: "EUR",
        amount: "50.00",
        status: "pending",
        providerRefundId: null,
        failureReason: null,
        processedAt: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    h.queue.add.mockRejectedValue(new Error("Connection is closed."));
    await h.service.refund(PAYMENT_ID, body);
    await expect(afterCommitWork[0]?.()).resolves.toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ refundId: "rfd_01JBCONSOLEREFUND000000000" }),
      "console.payments.refund_enqueue_failed",
    );
    // A refund of a payment without a booking writes no booking event.
    expect(h.payments.insertRefundBookingEvent).not.toHaveBeenCalled();
  });
});
