// The wording of the staff alert of an airline cancellation of a paid booking (FIX-W28-NOTIFY, lead decision (6) of
// 2026-10-23; FIX-W27-SYNC, lead decision (3)), without PostgreSQL: a Stripe payment is released or refunded from the
// console, an airline-card payment is refunded through the airline. The sync that writes the alert runs against
// PostgreSQL, Redis and the Amadeus stub in test/integration/bookings/sync.int.test.ts.
import { describe, expect, it } from "vitest";
import { AIRLINE_PROVIDER } from "../payments/airline-card/airline-card.gateway";
import { airlineCancellationReason, type HeldPaymentRow } from "./booking-sync.service";

const payment = (values: Partial<HeldPaymentRow>): HeldPaymentRow => ({
  id: "pay_01JA4CG3S8W1Z4C7F0H3L6P9T2",
  provider: "stripe",
  status: "captured",
  currency: "EUR",
  amountAuthorized: "115.00",
  amountCaptured: "115.00",
  amountRefunded: "0",
  ...values,
});

describe("airlineCancellationReason", () => {
  it("[FIX-W28-NOTIFY AC4] keeps the console wording for a Stripe payment, captured or only authorised", () => {
    expect(airlineCancellationReason("VXK7M2Q9", [payment({})])).toBe(
      "The airline cancelled every flight of booking VXK7M2Q9, and its payment still holds the traveller's money " +
        "(pay_01JA4CG3S8W1Z4C7F0H3L6P9T2 captured 115.00 EUR). Release the authorisation or refund the payment " +
        "from the console.",
    );
    expect(
      airlineCancellationReason("VXK7M2Q9", [
        payment({ status: "authorized", amountCaptured: "0" }),
        payment({ id: "pay_2", status: "partially_refunded", amountRefunded: "15.00" }),
      ]),
    ).toContain(
      "(pay_01JA4CG3S8W1Z4C7F0H3L6P9T2 authorised 115.00 EUR; pay_2 captured 100.00 EUR). Release the " +
        "authorisation or refund the payment from the console.",
    );
  });

  it("[FIX-W28-NOTIFY AC4] says that an airline-card payment is refunded through the airline, not from the console", () => {
    const reason = airlineCancellationReason("VXK7M2Q9", [payment({ provider: AIRLINE_PROVIDER })]);

    expect(reason).toBe(
      "The airline cancelled every flight of booking VXK7M2Q9, and the traveller paid with a card the airline " +
        "charged (pay_01JA4CG3S8W1Z4C7F0H3L6P9T2 charged by the airline 115.00 EUR). The refund goes through the " +
        "airline (its refund rules, in Amadeus or with the airline), not the console, which can neither release nor " +
        "refund an airline-card payment.",
    );
    expect(reason).not.toContain("Release the authorisation or refund the payment from the console");
  });

  it("[FIX-W28-NOTIFY AC4] names both ways when a booking holds a Stripe and an airline-card payment", () => {
    const reason = airlineCancellationReason("VXK7M2Q9", [
      payment({}),
      payment({ id: "pay_airline", provider: AIRLINE_PROVIDER, amountCaptured: "20.00" }),
    ]);

    expect(reason).toContain("Release the authorisation or refund the payment from the console.");
    expect(reason).toContain(
      "The traveller also paid with a card the airline charged (pay_airline charged by the airline 20.00 EUR): " +
        "that refund goes through the airline, not the console",
    );
  });
});
