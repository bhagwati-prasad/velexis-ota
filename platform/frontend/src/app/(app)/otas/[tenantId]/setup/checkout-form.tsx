"use client";

import type { ReactNode } from "react";

/**
 * A form of the set-up page that hands the browser over to Stripe Checkout (PFE-020): "Continue to payment" and
 * "Retry" (README §2, the set-up page from M5, and §7).
 *
 * Its action is a function of this client component that calls the page's server action, never the server action
 * itself. React renders a server action passed straight to `<form action>` as a form the browser can post natively
 * before hydration, and that post would end with the action's `303` to Stripe, which the policy's `form-action
 * 'self'` blocks. A function action renders no such form: a submit made before hydration is replayed once React has
 * hydrated (React's form replaying), and the server action's `redirect()` to the Checkout URL is then followed by the
 * router as a top-level navigation, which no directive of the policy restricts.
 */
export function CheckoutForm({
  action,
  className,
  children,
}: {
  /** The page's server action, bound to the OTA. */
  readonly action: (formData: FormData) => Promise<void>;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <form action={(formData) => action(formData)} className={className} data-form="checkout">
      {children}
    </form>
  );
}
