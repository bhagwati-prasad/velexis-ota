import { randomUUID } from "node:crypto";

import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  getCheckoutSync,
  openCustomerPortal,
  startCheckout,
} from "@/app/(app)/otas/[tenantId]/billing/actions";
import {
  CheckoutConfirmation,
  ChoosePlanForm,
  ManageInStripeForm,
} from "@/app/(app)/otas/[tenantId]/billing/billing-forms";
import {
  checkoutReturnOf,
  isConfirmedSubscription,
  isPaidOutsideStripe,
  planChoiceOffered,
} from "@/app/(app)/otas/[tenantId]/billing/billing-rules";
import { InvoicesTable } from "@/app/(app)/otas/[tenantId]/billing/invoices-table";
import type { Plan } from "@/app/(app)/otas/new/plan-picker";
import { DateTime } from "@/components/date-time";
import { NotAllowed } from "@/components/not-allowed";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { createPlatformApi, platformApi, type ApiError, type ApiResult } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { BILLING_STRINGS } from "@/lib/strings";
import { loadSubscription, requireTenant, type Tenant } from "@/lib/tenant";

export const metadata: Metadata = { title: BILLING_STRINGS.title };

type Schemas = components["schemas"];
type Subscription = Schemas["Subscription"];
type InvoiceList = Schemas["InvoiceList"];
type Account = Schemas["Account"];

/** The query of the page: Stripe Checkout's way back (`checkout=success` or `checkout=canceled`). */
type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Ends the request for an ended session (sign in again and come back to this page) and an unverified account
 * (`/verify-pending`); any other failure is the page's to show.
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/billing") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/**
 * `getSubscription` (owners and finance members), shared with the layout's banner of the same request
 * (`loadSubscription`). `NOT_FOUND` here means an OTA without a subscription (the layout's `getTenant` of the same
 * request found the membership), and the page says so; other failures are returned for the page to show.
 */
async function loadSubscriptionFor(tenantId: string): Promise<ApiResult<Subscription>> {
  const result = await loadSubscription(tenantId);
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
  }
  return result;
}

/** `getMe`, for the M5 switch `features.stripeBilling`; a failed call leaves the switch off. */
async function loadAccount(tenantId: string): Promise<ApiResult<Account>> {
  const api = await platformApi();
  const result = await api.GET("/v1/me");
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
  }
  return result;
}

/** `listInvoices` (owners and finance members), newest first. */
async function loadInvoices(tenantId: string): Promise<ApiResult<InvoiceList>> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/invoices", { params: { path: { tenantId } } });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
  }
  return result;
}

/**
 * The plans an owner can choose: the public plans of `listPlans` that Stripe Checkout can start with at least one
 * billing interval, in the API's order. `listPlans` is public: the call carries no access token, only the end-user
 * headers of PADR-0019, as on the pricing page. `undefined` when the call failed.
 */
async function checkoutPlans(): Promise<Plan[] | undefined> {
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  const result = await api.GET("/v1/plans");
  return result.data?.data.filter((plan) => plan.checkoutAvailable.month || plan.checkoutAvailable.year);
}

/**
 * The billing notice of the subscription (`banner`): a failed payment is an alert, the others status messages. A
 * banner the portal has no words for yet (a newer API) is left out rather than breaking the page; the status shows.
 */
function SubscriptionBanner({ banner }: { readonly banner: NonNullable<Subscription["banner"]> }) {
  if (!Object.hasOwn(BILLING_STRINGS.banners, banner)) {
    return null;
  }
  const strings = BILLING_STRINGS.banners[banner];
  return (
    <Alert
      {...(banner === "past_due" ? { variant: "destructive" as const } : { role: "status" })}
      data-notice={banner}
    >
      <AlertTitle>{strings.title}</AlertTitle>
      <AlertDescription>{strings.text}</AlertDescription>
    </Alert>
  );
}

/** One term and its value of the subscription. */
interface Detail {
  readonly id: string;
  readonly term: string;
  readonly value: ReactNode;
}

/** The subscription's details, each only when the API answers it. */
function details(subscription: Subscription, timeZone: string): Detail[] {
  const rows: Detail[] = [
    { id: "plan", term: BILLING_STRINGS.plan, value: subscription.planName },
    {
      id: "status",
      term: BILLING_STRINGS.status,
      value: <StatusBadge kind="subscription" status={subscription.status} />,
    },
    {
      id: "billingProvider",
      term: BILLING_STRINGS.billedBy,
      // A manual subscription an admin set `active` is paid outside Stripe, not a free trial (FIX-W48-PLATFORM).
      value: isPaidOutsideStripe(subscription)
        ? BILLING_STRINGS.paidOutsideStripe
        : (BILLING_STRINGS.provider[subscription.billingProvider] ?? subscription.billingProvider),
    },
  ];
  if (subscription.billingProvider === "stripe") {
    // A manual trial has no billing period of its own; its interval means nothing to the OTA.
    rows.push({
      id: "billingInterval",
      term: BILLING_STRINGS.interval,
      value: BILLING_STRINGS.intervals[subscription.billingInterval] ?? subscription.billingInterval,
    });
  }
  if (subscription.trialEndsAt !== null) {
    rows.push({
      id: "trialEndsAt",
      term: BILLING_STRINGS.trialEnds,
      value: <DateTime value={subscription.trialEndsAt} mode="date" timeZone={timeZone} />,
    });
  }
  if (subscription.currentPeriodEnd !== null) {
    rows.push({
      id: "currentPeriodEnd",
      term: BILLING_STRINGS.periodEnds,
      value: <DateTime value={subscription.currentPeriodEnd} mode="date" timeZone={timeZone} />,
    });
  }
  return rows;
}

/** A section of the page with its `h2`; `name` is its `data-section`, for tests. */
function PageSection({
  id,
  name,
  title,
  children,
}: {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid content-start gap-4 rounded-xl border p-5"
      data-section={name}
    >
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Back from Stripe with `?checkout=success` once the completed Checkout reached Velexis: the subscription shows below,
 * and an OTA whose set-up starts again (an abandoned Checkout paid at last, billing flow §H) is followed on its set-up
 * page.
 */
function CheckoutConfirmed({ tenant }: { readonly tenant: Tenant }) {
  const setupFollows = tenant.status === "provisioning" || tenant.status === "failed";
  return (
    <Alert role="status" data-checkout="confirmed">
      <AlertTitle>{BILLING_STRINGS.checkoutConfirmedTitle}</AlertTitle>
      <AlertDescription>
        <p>{BILLING_STRINGS.checkoutConfirmed}</p>
        {setupFollows ? (
          <p>
            {BILLING_STRINGS.checkoutSetup}{" "}
            <Link href={otaPath(tenant.id, "/setup")} className="font-medium underline underline-offset-4">
              {BILLING_STRINGS.setupLink}
            </Link>
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * `/otas/[tenantId]/billing` (README §2 Signed in; flows/subscription-billing.md §B, §E, §F, §G; PF-72 to PF-75): the
 * OTA's subscription for owners and finance members: the plan, the status, how it is paid, the end of the trial and
 * of the current period, the subscription's notice where the OTA's banner (`TenantBanner`, above every page of the OTA)
 * does not show it already, and from M5 (PFE-021):
 *
 * - "Choose a plan" for owners while the subscription allows one (a manual trial, a canceled subscription, an unpaid
 *   or abandoned Checkout, or none at all) and `features.stripeBilling` is on: the public plans Stripe Checkout can
 *   start, then Stripe Checkout (`createCheckoutSession`);
 * - "Manage in Stripe" for owners of a Stripe subscription (`canManageInStripe`): the Stripe Customer Portal
 *   (`createCustomerPortalSession`, a `303`);
 * - the invoices (`listInvoices`) for owners and finance members, once Stripe billing is on or the subscription is a
 *   Stripe one; finance members read the invoices and that an owner acts, and get neither action [PF-72 AC1];
 * - Stripe's way back: `?checkout=canceled` a neutral notice, `?checkout=success` "Confirming your payment" until the
 *   completed Checkout's webhook has made the subscription a Stripe one that is `trialing` or `active` (read every 2
 *   seconds, `CheckoutConfirmation`), then the subscription, with the way to the set-up page for an OTA whose set-up
 *   starts again (the note of 2026-11-03 in PFE-021's block, lead decision (2i)).
 *
 * Before M5 every OTA runs on a manual trial (`billing_provider = 'manual'`), and the page says that paid plans arrive
 * soon. The dates are in the OTA's time zone. The tenant comes from the layout's `getTenant` (the same request's cached
 * answer); another role gets the not-allowed page without a call.
 */
export default async function BillingPage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ tenantId: string }>; searchParams?: Promise<SearchParams> }>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "viewBilling")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }
  const [result, me, query] = await Promise.all([
    loadSubscriptionFor(tenant.id),
    loadAccount(tenant.id),
    searchParams ?? Promise.resolve<SearchParams>({}),
  ]);
  const subscription = result.data;
  const stripeBilling = me.data?.features.stripeBilling === true;
  const isOwner = can(tenant.myRole, "manageBilling");
  const checkoutReturn = checkoutReturnOf(query);
  // Back from Stripe before the webhook: no plan to choose until the Checkout's outcome is known.
  const confirming =
    checkoutReturn === "success" && (subscription === undefined || !isConfirmedSubscription(subscription));
  const planChoice =
    stripeBilling &&
    !confirming &&
    (subscription === undefined ? result.error?.code === "NOT_FOUND" : planChoiceOffered(subscription));
  const manageInStripe = subscription?.canManageInStripe === true;
  const showInvoices = stripeBilling || subscription?.billingProvider === "stripe";

  const [invoices, plans] = await Promise.all([
    showInvoices ? loadInvoices(tenant.id) : Promise.resolve(undefined),
    isOwner && planChoice ? checkoutPlans() : Promise.resolve(undefined),
  ]);
  // The subscription's own notice, unless the OTA's banner above the page shows it already (`past_due`,
  // `trial_ending`): `canceled`, or a notice the tenant row does not carry (yet).
  const banner = subscription?.banner ?? null;
  const ownBanner = banner !== null && banner !== tenant.billingNotice ? banner : null;

  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{BILLING_STRINGS.title}</h1>
        <p className="text-muted-foreground">{BILLING_STRINGS.intro}</p>
      </div>

      {checkoutReturn === "canceled" ? (
        <Alert role="status" data-checkout="canceled">
          <AlertDescription>{BILLING_STRINGS.checkoutCanceled}</AlertDescription>
        </Alert>
      ) : null}
      {confirming ? <CheckoutConfirmation poll={getCheckoutSync.bind(null, tenant.id)} /> : null}
      {checkoutReturn === "success" && !confirming ? <CheckoutConfirmed tenant={tenant} /> : null}

      {result.error === undefined ? null : result.error.code === "NOT_FOUND" ? (
        // While a Checkout is being confirmed, an OTA without a subscription waits for the one its webhook writes:
        // "contact Velexis support" would contradict the confirmation above.
        confirming ? null : (
          <p className="rounded-lg border px-4 py-3 text-sm" data-notice="no-subscription">
            {BILLING_STRINGS.none}
          </p>
        )
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{BILLING_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      )}

      {subscription === undefined ? null : (
        <>
          {ownBanner === null ? null : <SubscriptionBanner banner={ownBanner} />}
          <section
            aria-labelledby="billing-subscription"
            className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
          >
            <h2 id="billing-subscription" className="text-lg font-semibold tracking-tight">
              {BILLING_STRINGS.subscriptionTitle}
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
              {details(subscription, tenant.timeZone).map((detail) => (
                <div key={detail.id} className="contents" data-detail={detail.id}>
                  <dt className="text-muted-foreground">{detail.term}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
            {subscription.cancelAtPeriodEnd ? (
              <p className="text-sm" data-notice="cancel-at-period-end">
                {BILLING_STRINGS.cancelAtPeriodEnd}
              </p>
            ) : null}
          </section>
          {subscription.billingProvider === "manual" &&
          !isPaidOutsideStripe(subscription) &&
          !stripeBilling ? (
            <section
              aria-labelledby="billing-manual-trial"
              className="grid gap-2 rounded-xl border p-5"
              data-notice="manual-trial"
            >
              <h2 id="billing-manual-trial" className="text-lg font-semibold tracking-tight">
                {BILLING_STRINGS.manualTrialTitle}
              </h2>
              <p className="text-sm text-muted-foreground">{BILLING_STRINGS.manualTrial}</p>
            </section>
          ) : null}
        </>
      )}

      {isOwner && planChoice ? (
        <PageSection id="billing-choose-plan" name="choose-plan" title={BILLING_STRINGS.choosePlanTitle}>
          <p className="text-sm text-muted-foreground">{BILLING_STRINGS.choosePlanIntro}</p>
          <ChoosePlanForm
            tenantId={tenant.id}
            plans={plans ?? []}
            unavailable={
              plans === undefined
                ? BILLING_STRINGS.plansUnavailable
                : plans.length === 0
                  ? BILLING_STRINGS.noPlans
                  : undefined
            }
            // One key per rendering of the page: a double click opens one Checkout, a later visit a fresh one.
            idempotencyKey={randomUUID()}
            action={startCheckout.bind(null, tenant.id)}
          />
        </PageSection>
      ) : null}
      {isOwner && manageInStripe ? (
        <PageSection id="billing-manage" name="manage-in-stripe" title={BILLING_STRINGS.manageTitle}>
          <p className="text-sm text-muted-foreground">{BILLING_STRINGS.manageIntro}</p>
          <ManageInStripeForm tenantId={tenant.id} action={openCustomerPortal.bind(null, tenant.id)} />
        </PageSection>
      ) : null}
      {!isOwner && (planChoice || manageInStripe) ? (
        <p className="rounded-lg border px-4 py-3 text-sm" data-notice="owner-only">
          {BILLING_STRINGS.ownerOnly}
        </p>
      ) : null}

      {invoices === undefined ? null : (
        <PageSection id="billing-invoices" name="invoices" title={BILLING_STRINGS.invoicesTitle}>
          <p className="text-sm text-muted-foreground">{BILLING_STRINGS.invoicesIntro}</p>
          {invoices.error === undefined ? (
            <InvoicesTable invoices={invoices.data.data} timeZone={tenant.timeZone} />
          ) : (
            <Alert variant="destructive">
              <AlertTitle>{BILLING_STRINGS.invoicesUnavailableTitle}</AlertTitle>
              <AlertDescription>{errorMessage(invoices.error)}</AlertDescription>
            </Alert>
          )}
        </PageSection>
      )}
    </div>
  );
}
