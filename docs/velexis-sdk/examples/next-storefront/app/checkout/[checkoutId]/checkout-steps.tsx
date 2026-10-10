"use client";

import { useRouter } from "next/navigation";
import { useCheckout } from "@velexis/ota-sdk/react";
import type { AncillaryCatalogue, Checkout, Schemas } from "@velexis/ota-sdk";
import { completeCheckoutAction } from "./actions";
import { TravelersForm } from "./travelers-form";
import { ContactsForm } from "./contacts-form";
import { AncillariesForm } from "./ancillaries-form";
import { PaymentForm } from "./payment-form";
import { CompleteStep } from "./complete-step";

/**
 * Orchestrates the checkout steps around one `useCheckout` state. Travellers and contacts are saved by server actions
 * (then the hook re-reads the checkout); extras, payment and completion use the hook (completion through a server
 * action so a guest booking token lands in an httpOnly cookie).
 */
export function CheckoutSteps(props: {
  initialCheckout: Checkout;
  catalogue: AncillaryCatalogue | null;
  savedTravelers: Schemas["SavedTraveler"][];
  signedIn: boolean;
  payment: Schemas["StorefrontPaymentConfig"];
  termsUrl: string;
  seatSelection: boolean;
}) {
  const router = useRouter();
  const co = useCheckout(props.initialCheckout.id, { initial: props.initialCheckout, completeAction: completeCheckoutAction });
  const checkout = co.checkout ?? props.initialCheckout;
  const payLater = checkout.ticketing.paymentTiming === "pay_later";

  return (
    <div className="checkout-steps">
      <ol className="progress">
        <li data-done={checkout.progress.travelersComplete}>Travellers</li>
        <li data-done={checkout.progress.contactsComplete}>Contact</li>
        {props.catalogue && <li data-done={checkout.ancillaries.length > 0}>Extras</li>}
        <li data-done={checkout.progress.paymentReady}>Payment</li>
      </ol>

      <TravelersForm checkout={checkout} savedTravelers={props.savedTravelers} signedIn={props.signedIn} onSaved={co.refresh} />
      <ContactsForm checkout={checkout} onSaved={co.refresh} />
      {props.catalogue && <AncillariesForm checkout={checkout} catalogue={props.catalogue} seatSelection={props.seatSelection} checkoutState={co} />}

      {checkout.progress.travelersComplete && checkout.progress.contactsComplete ? (
        payLater ? (
          <CompleteStep checkout={checkout} checkoutState={co} onDone={(path) => router.push(path)} />
        ) : (
          <PaymentForm checkout={checkout} config={props.payment} termsUrl={props.termsUrl} checkoutState={co} onDone={(path) => router.push(path)} />
        )
      ) : (
        <p className="muted">
          Complete travellers and contact details to continue to payment.
          {checkout.progress.missing.length > 0 && ` Missing: ${checkout.progress.missing.map((m) => m.message ?? m.path).join(", ")}`}
        </p>
      )}
    </div>
  );
}
