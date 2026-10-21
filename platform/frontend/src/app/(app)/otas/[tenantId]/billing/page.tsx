import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { DateTime } from "@/components/date-time";
import { NotAllowed } from "@/components/not-allowed";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { BILLING_STRINGS } from "@/lib/strings";
import { requireTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: BILLING_STRINGS.title };

type Subscription = components["schemas"]["Subscription"];

/**
 * `getSubscription` (owners and finance members). An ended session goes to sign-in and back to this page, an
 * unverified account to `/verify-pending`. `NOT_FOUND` here means an OTA without a subscription (the layout's
 * `getTenant` of the same request found the membership), and the page says so; other failures are returned for the
 * page to show the portal's message.
 */
async function loadSubscription(tenantId: string): Promise<ApiResult<Subscription>> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/subscription", { params: { path: { tenantId } } });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/billing") }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
  }
  return result;
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
      value: BILLING_STRINGS.provider[subscription.billingProvider] ?? subscription.billingProvider,
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

/**
 * `/otas/[tenantId]/billing` (README §2 Signed in; flows/subscription-billing.md §G; PF-75): the OTA's subscription
 * for owners and finance members: the plan, the status, how it is paid, the end of the trial and of the current
 * period, and the billing notice. Before M5 every OTA runs on a manual trial (`billing_provider = 'manual'`), and the
 * page says that paid plans arrive soon. The dates are in the OTA's time zone. The tenant comes from the layout's
 * `getTenant` (the same request's cached answer); another role gets the not-allowed page without a call. Choosing a
 * plan, the Stripe Customer Portal and the invoices come with PFE-021.
 */
export default async function BillingPage({ params }: Readonly<{ params: Promise<{ tenantId: string }> }>) {
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
  const result = await loadSubscription(tenant.id);
  const subscription = result.data;

  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{BILLING_STRINGS.title}</h1>
        <p className="text-muted-foreground">{BILLING_STRINGS.intro}</p>
      </div>

      {result.error === undefined ? null : result.error.code === "NOT_FOUND" ? (
        <p className="rounded-lg border px-4 py-3 text-sm" data-notice="no-subscription">
          {BILLING_STRINGS.none}
        </p>
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{BILLING_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      )}

      {subscription === undefined ? null : (
        <>
          {subscription.banner === null ? null : <SubscriptionBanner banner={subscription.banner} />}
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
          {subscription.billingProvider === "manual" ? (
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
    </div>
  );
}
