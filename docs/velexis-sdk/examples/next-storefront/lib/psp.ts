/**
 * Minimal payment-provider bridge for the example (client-side only). Velexis never sees card data: the provider's
 * front-end SDK collects the card and runs 3-D Secure with the `clientSecret` of the Velexis payment.
 * Only Stripe (Payment Element) is wired here; add Adyen / Checkout.com drop-ins the same way.
 */
import type { Payment, Schemas } from "@velexis/ota-sdk";

interface StripeElement {
  mount(el: HTMLElement): void;
  destroy(): void;
}
interface StripeElements {
  create(type: "payment"): StripeElement;
  /** Re-read the PaymentIntent (after Velexis changed its amount with `checkout.updatePayment`). */
  fetchUpdates(): Promise<{ error?: { message?: string } }>;
}
interface StripeInstance {
  elements(options: { clientSecret: string }): StripeElements;
  confirmPayment(options: { elements: StripeElements; redirect: "if_required"; confirmParams?: { return_url?: string } }): Promise<{ error?: { message?: string } }>;
}
declare global {
  interface Window {
    Stripe?: (publishableKey: string, options?: { stripeAccount?: string }) => StripeInstance;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

export interface MountedPayment {
  /** Confirm the card (3-D Secure inside the provider UI). Resolves with an error message or null. */
  confirm(returnUrl: string): Promise<string | null>;
  /** Show the new amount after `checkout.updatePayment` re-quoted the card fee (same provider payment). */
  refresh(): Promise<void>;
  unmount(): void;
}

/** Mount the provider's card form for a Velexis payment. */
export async function mountPaymentForm(payment: Payment, config: Schemas["StorefrontPaymentConfig"], container: HTMLElement): Promise<MountedPayment> {
  if (payment.provider !== "stripe") throw new Error(`Provider ${payment.provider} is not wired in this example`);
  if (!payment.clientSecret) throw new Error("Payment has no client secret");
  await loadScript("https://js.stripe.com/v3/");
  if (!window.Stripe) throw new Error("Stripe.js unavailable");
  const stripe = window.Stripe(payment.providerPublicKey ?? config.publishableKey, config.accountId ? { stripeAccount: config.accountId } : undefined);
  const elements = stripe.elements({ clientSecret: payment.clientSecret });
  const element = elements.create("payment");
  element.mount(container);
  return {
    async confirm(returnUrl) {
      const { error } = await stripe.confirmPayment({ elements, redirect: "if_required", confirmParams: { return_url: returnUrl } });
      return error ? error.message ?? "Payment failed" : null;
    },
    async refresh() {
      await elements.fetchUpdates();
    },
    unmount: () => element.destroy(),
  };
}
