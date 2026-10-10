"use client";

import { useState } from "react";
import { useStorefront, type UseCheckoutResult } from "@velexis/ota-sdk/react";
import type { Checkout, Payment } from "@velexis/ota-sdk";

/**
 * Final step: complete the checkout (Amadeus Flight Create Orders, payment capture, ticket issuance per the OTA's
 * policy) through the server action given to `useCheckout({ completeAction })`. Outcomes that must NOT lead to a
 * second booking attempt (`pending` after SUPPLIER_TIMEOUT, `already_completed`) navigate to the booking.
 */
export function CompleteStep({ checkout, payment, checkoutState: co, onDone }: { checkout: Checkout; payment?: Payment; checkoutState: UseCheckoutResult; onDone: (path: string) => void }) {
  const { formatMoney, features } = useStorefront();
  const [message, setMessage] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  async function complete() {
    setLocked(true);
    setMessage(null);
    const outcome = await co.complete({ paymentId: payment?.id, expectedTotal: payment?.amount ?? checkout.totals.total });
    switch (outcome.status) {
      case "booked":
        return onDone(`/bookings/${outcome.completion.booking.id}?new=1`);
      case "pending":
        return onDone(`/bookings/${outcome.bookingId}?pending=1`); // the order may exist — never book again
      case "already_completed":
        return onDone(`/bookings/${outcome.bookingId}`);
      case "price_changed":
        setMessage(`The fare changed to ${formatMoney(outcome.priceChange.newPrice)}. Your authorisation was released — please pay again.`);
        break;
      case "failed":
        setMessage(
          outcome.error.code === "SOLD_OUT"
            ? "Sorry, this fare sold out. Nothing was charged."
            : outcome.error.code === "PAYMENT_DECLINED"
              ? "Your payment was declined."
              : outcome.error.code === "CHECKOUT_EXPIRED"
                ? "Your checkout expired. Please search again."
                : outcome.error.message,
        );
        break;
    }
    setLocked(false);
  }

  return (
    <section className="step">
      <h2>Confirm your booking</h2>
      {payment && <p>Payment of {formatMoney(payment.amount)} authorised.</p>}
      <p className="muted">{features.autoIssue ? "Your e-tickets are issued right away." : "Your tickets will follow by e-mail once issued."}</p>
      <button type="button" disabled={co.pending || locked} onClick={() => void complete()}>
        {co.pending ? "Booking with the airline… (up to a minute)" : "Book now"}
      </button>
      {message && <p className="error" role="alert">{message}</p>}
    </section>
  );
}
