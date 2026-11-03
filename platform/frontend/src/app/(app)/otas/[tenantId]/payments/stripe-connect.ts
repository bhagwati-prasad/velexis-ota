import { otaPath } from "@/lib/roles";
import { STRIPE_CONNECT_OUTCOME_STRINGS } from "@/lib/strings";

/**
 * What the payments page and the Stripe Connect callback (`/connect/stripe/callback`) share (PFE-024; README §2;
 * flows/stripe-payments-account.md §C). Next.js lets a page or route module export only its own fields, so the names of
 * the callback's outcomes and the payments page's path live here, in a module without a directive.
 *
 * The callback never puts what Stripe sent (the code, the state, Stripe's error text) into the URL it redirects to:
 * only one of these outcome names, which the page turns into the portal's own words.
 */

/** The query parameter of the payments page that names the outcome of a Stripe Connect callback. */
export const STRIPE_CONNECT_QUERY = "stripeConnect";

/** Every outcome the callback names, in the order of flows/stripe-payments-account.md §C and its failure table. */
export const STRIPE_CONNECT_OUTCOMES = [
  "connected",
  "pending",
  "denied",
  "state_invalid",
  "oauth_error",
  "livemode_mismatch",
  "already_connected",
  "connection_disabled",
  "feature_disabled",
  "not_active",
  "forbidden",
  "rate_limited",
  "provider_error",
  "unavailable",
  "signed_out",
] as const;

/** One outcome of a Stripe Connect callback. */
export type StripeConnectOutcome = (typeof STRIPE_CONNECT_OUTCOMES)[number];

/** Every outcome has the portal's words (`lib/strings.ts`): the type check fails for one without. */
export const STRIPE_CONNECT_OUTCOME_WORDS: Readonly<
  Record<
    StripeConnectOutcome,
    { readonly tone: "success" | "info" | "error"; readonly title: string; readonly text: string }
  >
> = STRIPE_CONNECT_OUTCOME_STRINGS;

const OUTCOMES: ReadonlySet<string> = new Set(STRIPE_CONNECT_OUTCOMES);

/** `value` is an outcome the portal has words for. */
export function isStripeConnectOutcome(value: unknown): value is StripeConnectOutcome {
  return typeof value === "string" && OUTCOMES.has(value);
}

/**
 * The outcome a payments page URL names (`?stripeConnect=`), or `undefined` for none or a value the portal does not
 * know: a crafted URL can only show one of the portal's own messages.
 */
export function stripeConnectOutcomeOf(
  searchParams: Readonly<Record<string, string | readonly string[] | undefined>>,
): StripeConnectOutcome | undefined {
  const value = searchParams[STRIPE_CONNECT_QUERY];
  const first = typeof value === "string" ? value : value?.[0];
  return isStripeConnectOutcome(first) ? first : undefined;
}

/** The payments page of an OTA, with the outcome of a callback when there is one. */
export function paymentsPath(tenantId: string, outcome?: StripeConnectOutcome): string {
  const path = otaPath(tenantId, "/payments");
  return outcome === undefined
    ? path
    : `${path}?${new URLSearchParams({ [STRIPE_CONNECT_QUERY]: outcome }).toString()}`;
}

/** The id of the "Connect Stripe" part of the payments page, which a disconnected card links to (PF-61 AC2). */
export const CONNECT_STRIPE_ANCHOR = "connect-stripe";
