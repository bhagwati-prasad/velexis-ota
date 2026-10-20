// Unit tests of payment-state.ts (OBE-039): which PaymentIntent, refund and charge states read from Stripe a payment
// and its refunds take, so that a state read for an older event never undoes a newer one.
import { describe, expect, it } from "vitest";
import type { GatewayPaymentStatus, GatewayState } from "./payment-gateway";
import {
  canApplyProviderStatus,
  canMoveRefund,
  matchRefund,
  providerStateUpdate,
  refundedState,
  refundedStatusOf,
  refundStatusOf,
  refundUpdate,
  type ProviderRefund,
} from "./payment-state";
import type { PaymentRow, RefundRow } from "./payments.repository";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const EARLIER = new Date("2026-11-03T09:00:00.000Z");
const INTENT = "pi_test_state_1";

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: "pay_01JBSTATE0000000000000000",
    environment: "test",
    checkoutId: "chk_01JBSTATE0000000000000000",
    bookingId: null,
    customerId: null,
    provider: "stripe",
    providerConnectionId: "ppc_01JBSTATE0000000000000000",
    providerPaymentId: INTENT,
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
    threeDs: { required: false, status: "not_required", version: null },
    nextAction: null,
    failureCode: null,
    failureMessage: null,
    authorizedAt: null,
    capturedAt: null,
    canceledAt: null,
    version: 3,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    checkoutCustomerId: null,
    checkoutIsGuest: true,
    ...overrides,
  };
}

function state(status: GatewayPaymentStatus, overrides: Partial<GatewayState> = {}): GatewayState {
  return {
    providerPaymentId: INTENT,
    status,
    amount: "452.10",
    amountCapturable: status === "authorized" ? "452.10" : "0.00",
    amountReceived: status === "captured" ? "452.10" : "0.00",
    card: { brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030 },
    threeDSecure: null,
    failure: null,
    clientSecret: null,
    ...overrides,
  };
}

describe("PaymentIntent states on a payment", () => {
  it("lets an unconfirmed payment take any state and an authorised one only captured or cancelled [OBE-039 AC4]", () => {
    for (const from of ["requires_payment_method", "requires_action", "processing"]) {
      for (const to of ["requires_payment_method", "authorized", "captured", "canceled"] as const) {
        expect([from, to, canApplyProviderStatus(from, to)]).toEqual([from, to, true]);
      }
    }
    expect(canApplyProviderStatus("authorized", "captured")).toBe(true);
    expect(canApplyProviderStatus("authorized", "canceled")).toBe(true);
    expect(canApplyProviderStatus("authorized", "requires_payment_method")).toBe(false);
    for (const final of ["captured", "partially_refunded", "refunded", "canceled", "failed"]) {
      expect([final, canApplyProviderStatus(final, "authorized")]).toEqual([final, false]);
      expect([final, canApplyProviderStatus(final, "canceled")]).toEqual([final, false]);
    }
  });

  it("applies the authorisation Stripe reports, with the card, the amount and the PaymentIntent id [OBE-039 AC4]", () => {
    const update = providerStateUpdate(payment({ providerPaymentId: null }), state("authorized"), NOW);

    expect(update).toMatchObject({
      kind: "apply",
      status: "authorized",
      values: {
        status: "authorized",
        amount_authorized: "452.10",
        authorized_at: NOW,
        card_last4: "4242",
        card_brand: "VISA",
        provider_payment_id: INTENT,
        failure_code: null,
      },
    });
  });

  it("applies a capture over an authorisation, keeping when it was authorised", () => {
    const authorised = payment({ status: "authorized", amountAuthorized: "452.10", authorizedAt: EARLIER });

    expect(providerStateUpdate(authorised, state("captured"), NOW)).toMatchObject({
      kind: "apply",
      status: "captured",
      values: { amount_captured: "452.10", authorized_at: EARLIER, captured_at: NOW },
    });
  });

  it("refuses the authorisation read for an older event once the payment is captured or cancelled [OBE-039 AC4]", () => {
    const captured = payment({ status: "captured", amountAuthorized: "452.10", amountCaptured: "452.10" });
    const cancelled = payment({ status: "canceled", canceledAt: EARLIER });

    expect(providerStateUpdate(captured, state("authorized"), NOW)).toEqual({
      kind: "refused",
      from: "captured",
      to: "authorized",
    });
    expect(providerStateUpdate(cancelled, state("authorized"), NOW)).toEqual({
      kind: "refused",
      from: "canceled",
      to: "authorized",
    });
  });

  it("changes nothing when the row already shows the state, also a refunded payment whose PaymentIntent succeeded", () => {
    const authorised = payment({
      status: "authorized",
      amountAuthorized: "452.10",
      cardLast4: "4242",
      authorizedAt: EARLIER,
    });
    const refunded = payment({ status: "refunded", amountCaptured: "452.10", amountRefunded: "452.10" });

    expect(providerStateUpdate(authorised, state("authorized"), NOW)).toEqual({ kind: "unchanged" });
    expect(providerStateUpdate(refunded, state("captured"), NOW)).toEqual({ kind: "unchanged" });
  });

  it("sends a declined payment back to requires_payment_method with the decline code", () => {
    const update = providerStateUpdate(
      payment({ status: "requires_action" }),
      state("requires_payment_method", {
        card: null,
        failure: { code: "PAYMENT_DECLINED", declineCode: "generic_decline" },
      }),
      NOW,
    );

    expect(update).toMatchObject({
      kind: "apply",
      status: "requires_payment_method",
      values: { failure_code: "PAYMENT_DECLINED", failure_message: "generic_decline" },
    });
  });

  it("refuses a PaymentIntent that is not the payment's", () => {
    expect(
      providerStateUpdate(payment(), state("authorized", { providerPaymentId: "pi_other" }), NOW),
    ).toEqual({
      kind: "refused",
      from: "requires_payment_method",
      to: "authorized",
    });
  });
});

describe("refund states", () => {
  const row = (overrides: Partial<RefundRow> = {}): RefundRow => ({
    id: "rfd_01JBSTATE0000000000000000",
    paymentId: "pay_01JBSTATE0000000000000000",
    currency: "EUR",
    amount: "100.00",
    status: "pending",
    providerRefundId: null,
    failureReason: null,
    processedAt: null,
    version: 1,
    ...overrides,
  });
  const refund = (overrides: Partial<ProviderRefund> = {}): ProviderRefund => ({
    providerRefundId: "re_test_state_1",
    status: "succeeded",
    amount: "100.00",
    failureReason: null,
    refundId: "rfd_01JBSTATE0000000000000000",
    ...overrides,
  });

  it("maps Stripe's refund statuses: pending and requires_action are processing", () => {
    expect(
      ["pending", "requires_action", "succeeded", "failed", "canceled", null].map(refundStatusOf),
    ).toEqual(["processing", "processing", "succeeded", "failed", "canceled", "processing"]);
  });

  it("moves a refund forward only, a succeeded one still to failed", () => {
    expect(canMoveRefund("pending", "succeeded")).toBe(true);
    expect(canMoveRefund("processing", "failed")).toBe(true);
    expect(canMoveRefund("succeeded", "failed")).toBe(true);
    expect(canMoveRefund("succeeded", "processing")).toBe(false);
    expect(canMoveRefund("failed", "succeeded")).toBe(false);
    expect(canMoveRefund("canceled", "succeeded")).toBe(false);
  });

  it("records the Stripe id and the final state with its time, and the failure reason of a failed refund", () => {
    expect(refundUpdate(row(), refund(), NOW)).toEqual({
      status: "succeeded",
      values: {
        provider_refund_id: "re_test_state_1",
        status: "succeeded",
        processed_at: NOW,
        updated_at: NOW,
      },
    });
    expect(
      refundUpdate(
        row({ status: "succeeded", providerRefundId: "re_test_state_1", processedAt: EARLIER }),
        refund({ status: "failed", failureReason: "expired_or_canceled_card" }),
        NOW,
      ),
    ).toEqual({
      status: "failed",
      values: {
        status: "failed",
        processed_at: EARLIER,
        failure_reason: "expired_or_canceled_card",
        updated_at: NOW,
      },
    });
  });

  it("changes nothing for a stale state or one the row shows already", () => {
    const done = row({ status: "succeeded", providerRefundId: "re_test_state_1", processedAt: EARLIER });

    expect(refundUpdate(done, refund({ status: "pending" }), NOW)).toBeUndefined();
    expect(refundUpdate(done, refund(), NOW)).toBeUndefined();
  });

  it("finds a refund's row by its Stripe id, else by the refund id Velexis wrote in it", () => {
    const linked = row({ id: "rfd_linked", providerRefundId: "re_test_state_1" });
    const unlinked = row({ id: "rfd_unlinked" });

    expect(matchRefund([unlinked, linked], refund())).toBe(linked);
    expect(matchRefund([unlinked], refund({ providerRefundId: "re_new", refundId: "rfd_unlinked" }))).toBe(
      unlinked,
    );
    expect(matchRefund([unlinked], refund({ providerRefundId: "re_new", refundId: null }))).toBeUndefined();
  });
});

describe("refunded amounts of a payment", () => {
  const captured = payment({
    status: "captured",
    amountAuthorized: "452.10",
    amountCaptured: "452.10",
    authorizedAt: EARLIER,
    capturedAt: EARLIER,
  });

  it("names the status of a captured payment by its refunded share", () => {
    expect(refundedStatusOf("452.10", "0.00")).toBe("captured");
    expect(refundedStatusOf("452.10", "100.00")).toBe("partially_refunded");
    expect(refundedStatusOf("452.10", "452.10")).toBe("refunded");
  });

  it("takes the charge's refunded amount and the status that follows", () => {
    expect(
      refundedState(captured, { amountCaptured: "452.10", amountRefunded: "100.00" }, NOW),
    ).toMatchObject({
      status: "partially_refunded",
      values: { status: "partially_refunded", amount_refunded: "100.00", amount_captured: "452.10" },
    });
    expect(
      refundedState(captured, { amountCaptured: "452.10", amountRefunded: "452.10" }, NOW),
    ).toMatchObject({
      status: "refunded",
    });
  });

  it("records the capture a refund proves on a payment still shown authorised, within the payment's amount", () => {
    const authorised = payment({ status: "authorized", amountAuthorized: "452.10", authorizedAt: EARLIER });

    expect(
      refundedState(authorised, { amountCaptured: "999.99", amountRefunded: "999.99" }, NOW),
    ).toMatchObject({
      status: "refunded",
      values: {
        amount_captured: "452.10",
        amount_refunded: "452.10",
        amount_authorized: "452.10",
        authorized_at: EARLIER,
        captured_at: NOW,
      },
    });
  });

  it("changes nothing for a payment that cannot have refunds or already shows them", () => {
    expect(
      refundedState(payment({ status: "canceled" }), { amountCaptured: "0.00", amountRefunded: "0.00" }, NOW),
    ).toBeUndefined();
    expect(
      refundedState(captured, { amountCaptured: "452.10", amountRefunded: "0.00" }, NOW),
    ).toBeUndefined();
  });
});
