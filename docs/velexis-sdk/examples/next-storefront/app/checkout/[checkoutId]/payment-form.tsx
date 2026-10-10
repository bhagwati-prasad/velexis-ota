"use client";

import { useEffect, useRef, useState } from "react";
import { useStorefront, type UseCheckoutResult } from "@velexis/ota-sdk/react";
import type { Checkout, Payment, PaymentCardHint, Schemas } from "@velexis/ota-sdk";
import { mountPaymentForm, type MountedPayment } from "@/lib/psp";
import { CompleteStep } from "./complete-step";

type Method = "card" | "apple_pay" | "google_pay" | "paypal";
const CREATABLE: Method[] = ["card", "apple_pay", "google_pay", "paypal"];

/**
 * Payment step: create the Velexis payment (card brand → credit-card fee), let the provider SDK collect the card and run
 * 3-D Secure, poll until authorised, then complete (books with Amadeus). The card type can still change after the
 * payment exists: `checkout.updatePayment` re-quotes the fee on the same provider payment.
 */
export function PaymentForm({ checkout, config, termsUrl, checkoutState: co, onDone }: {
  checkout: Checkout;
  config: Schemas["StorefrontPaymentConfig"];
  termsUrl: string;
  checkoutState: UseCheckoutResult;
  onDone: (path: string) => void;
}) {
  const { formatMoney } = useStorefront();
  // The storefront may advertise methods the checkout cannot start (sepa_debit, ideal, klarna, bank_transfer).
  const methods = config.supportedMethods.filter((m): m is Method => (CREATABLE as string[]).includes(m));
  const [method, setMethod] = useState<Method>(methods[0] ?? "card");
  // `pspCardBrands` pairs each accepted Amadeus brand (sent as `card.brand`) with the provider's name and a label.
  const [brand, setBrand] = useState<PaymentCardHint["brand"] | undefined>(config.pspCardBrands[0]?.amadeus);
  const [terms, setTerms] = useState(false);
  const [payment, setPayment] = useState<Payment | null>(checkout.payment?.status === "authorized" || checkout.payment?.status === "captured" ? checkout.payment : null);
  const [mounted, setMounted] = useState<MountedPayment | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => () => mounted?.unmount(), [mounted]);

  async function start() {
    setMessage(null);
    setBusy(true);
    try {
      const p = await co.createPayment(
        {
          method,
          card: method === "card" && brand ? { brand } : undefined,
          termsAccepted: true,
          returnUrl: `${window.location.origin}/checkout/${checkout.id}?return=1`,
        },
        { idempotencyKey: `pay-${checkout.id}-${checkout.version}-${method}-${brand ?? "none"}` },
      );
      if (!p) return; // error / price change shown below
      if (p.redirectUrl) {
        window.location.assign(p.redirectUrl); // PayPal & redirect flows come back to returnUrl
        return;
      }
      if (container.current) setMounted(await mountPaymentForm(p, config, container.current));
      setPayment(p);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not start the payment");
    } finally {
      setBusy(false);
    }
  }

  /** Card type changed after the payment was created: re-quote the card fee on the same payment, then refresh the PSP form. */
  async function changeBrand(next: PaymentCardHint["brand"]) {
    setBrand(next);
    if (!payment || payment.status !== "requires_payment_method") return;
    setBusy(true);
    try {
      const updated = await co.updatePayment(payment.id, { brand: next });
      if (updated) {
        setPayment(updated);
        await mounted?.refresh();
      } else {
        // PRICE_CHANGED (payment cancelled), PAYMENT_NOT_UPDATABLE or another error — shown below from the hook state:
        // the amount on the card form is no longer reliable, so start a new payment.
        setMounted(null); // the effect cleanup destroys the provider element
        setPayment(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!payment || !mounted) return;
    setBusy(true);
    setMessage(null);
    try {
      const err = await mounted.confirm(`${window.location.origin}/checkout/${checkout.id}?return=1`);
      if (err) return setMessage(err);
      const final = await co.waitForPayment(payment.id, { intervalMs: 2000, timeoutMs: 120_000 });
      if (final.status !== "authorized" && final.status !== "captured") return setMessage(final.failure?.message ?? "Payment was not authorised");
      setPayment(final);
      setMounted(null); // the effect cleanup destroys the provider element
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  const authorized = payment && (payment.status === "authorized" || payment.status === "captured");
  if (authorized) return <CompleteStep checkout={checkout} payment={payment} checkoutState={co} onDone={onDone} />;

  return (
    <section className="step">
      <h2>Payment</h2>
      <p>
        Total <strong>{formatMoney(co.checkout?.totals.total ?? checkout.totals.total)}</strong>
        {payment?.cardFee && <span className="muted"> incl. card fee {formatMoney(payment.cardFee)}</span>}
      </p>
      {method === "card" && config.pspCardBrands.length > 0 && (!payment || payment.status === "requires_payment_method") && (
        <label>
          Card type (card fees may apply)
          <select value={brand ?? ""} disabled={busy} onChange={(e) => void changeBrand(e.target.value as PaymentCardHint["brand"])}>
            {config.pspCardBrands.map((b) => (
              <option key={b.amadeus} value={b.amadeus}>{b.label}</option>
            ))}
          </select>
        </label>
      )}
      {!payment && (
        <>
          <fieldset>
            <legend>Pay with</legend>
            {methods.map((m) => (
              <label key={m}>
                <input type="radio" name="method" checked={method === m} onChange={() => setMethod(m)} /> {m.replace("_", " ")}
              </label>
            ))}
          </fieldset>
          <label>
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /> I accept the{" "}
            <a href={termsUrl} target="_blank" rel="noreferrer">terms and fare conditions</a>
          </label>
          <button type="button" disabled={!terms || busy || co.pending} onClick={() => void start()}>
            {busy ? "Preparing payment…" : "Continue to payment"}
          </button>
        </>
      )}
      <div ref={container} className="psp-container" />
      {payment && mounted && (
        <button type="button" disabled={busy} onClick={() => void confirm()}>
          {busy ? "Authorising…" : "Pay now"}
        </button>
      )}
      {co.priceChange && (
        <p className="notice" role="alert">
          The price changed to {formatMoney(co.priceChange.newPrice)} — please start the payment again.
        </p>
      )}
      {co.error && <p className="error" role="alert">{co.error.code === "CHECKOUT_INCOMPLETE" ? "Some details are still missing." : co.error.message}</p>}
      {message && <p className="error" role="alert">{message}</p>}
    </section>
  );
}
