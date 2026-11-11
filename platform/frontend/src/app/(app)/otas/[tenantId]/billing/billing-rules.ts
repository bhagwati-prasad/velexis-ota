import type { components } from "@velexis/api-types/platform";

/**
 * What the billing page, its server actions and its client components share (PFE-021; README §2 `/billing`;
 * flows/subscription-billing.md §B, §E, §F). Next.js lets a page module export only its own fields and a `"use server"`
 * module only its actions, so these plain rules live here, in a module without a directive: the server page, the
 * actions and the browser's invoices table import the same functions.
 */

type Subscription = components["schemas"]["Subscription"];

/** The query of the billing page: Stripe Checkout's way back (`?checkout=success`, `?checkout=canceled`). */
export type CheckoutReturn = "success" | "canceled";

/**
 * `?checkout=` of a billing page URL, or `undefined` for none or any other value: a crafted URL can only show one of
 * the portal's own notices.
 */
export function checkoutReturnOf(
  searchParams: Readonly<Record<string, string | readonly string[] | undefined>>,
): CheckoutReturn | undefined {
  const value = searchParams["checkout"];
  return value === "success" || value === "canceled" ? value : undefined;
}

/**
 * The statuses of a current Stripe subscription: `createCheckoutSession` refuses them (`409 CONFLICT`,
 * `stripe_subscription_active`), and its plan and card change in the Stripe Customer Portal instead.
 */
const CURRENT_STRIPE_STATUSES: ReadonlySet<string> = new Set([
  "trialing",
  "active",
  "past_due",
  "paused",
  "unpaid",
]);

/**
 * The completed Checkout reached Velexis: the subscription is a Stripe one that is `trialing` or `active` (billing
 * sync writes it from the `checkout.session.completed` webhook, §D). Until then the shown subscription is still the
 * manual trial, the canceled or the expired one, and the page keeps confirming.
 */
export function isConfirmedSubscription(
  subscription: Pick<Subscription, "billingProvider" | "status">,
): boolean {
  return (
    subscription.billingProvider === "stripe" &&
    (subscription.status === "trialing" || subscription.status === "active")
  );
}

/**
 * A manual subscription a platform admin set `active`: the OTA is billed by Velexis outside Stripe (lead decision (15g)
 * of 2026-11-11, FIX-W48-PLATFORM), so it is no trial, whatever trial end it kept.
 */
export function isPaidOutsideStripe(subscription: Pick<Subscription, "billingProvider" | "status">): boolean {
  return subscription.billingProvider === "manual" && subscription.status === "active";
}

/**
 * The subscription lets an owner choose a plan through Stripe Checkout (§B step 2, PF-72): a manual trial (also once it
 * ended: `past_due`, `canceled`), a canceled Stripe subscription, or a Checkout that was never paid (`incomplete`, or
 * `incomplete_expired` after an abandoned Checkout, §H). A manual subscription an admin set `active` (billed outside
 * Stripe) and a current Stripe subscription are not offered: the API refuses the latter, which changes in Stripe. The
 * page decides `undefined`, an OTA without a subscription (`NOT_FOUND`), itself.
 */
export function planChoiceOffered(subscription: Pick<Subscription, "billingProvider" | "status">): boolean {
  if (subscription.billingProvider === "manual") {
    return !isPaidOutsideStripe(subscription);
  }
  return !CURRENT_STRIPE_STATUSES.has(subscription.status);
}

/**
 * `value` when it is an absolute `https:` URL without credentials, exactly as the API answered it (Stripe's Checkout
 * URLs carry a fragment the page needs); `undefined` otherwise. The portal follows, or links to, only such a URL of the
 * API's answer (README §5, external navigations): never `http:`, `javascript:`, a relative or a credential-bearing one,
 * and never one built here.
 */
export function followableUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" ? value : undefined;
}
