import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CreatePlanForm, PlanBadge, PlanStatus, PricingState } from "@/app/(app)/plans/plan-form";
import { Money } from "@/components/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { PLAN_LIST_STRINGS as S, PLAN_STRINGS as P } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type AdminPlan = components["schemas"]["AdminPlan"];

const LINK_CLASS = "font-medium underline-offset-4 hover:underline focus-visible:underline";

/** The Stripe link state: linked prices (M5) and the warnings of their last comparison. */
function StripeState({ plan }: { readonly plan: AdminPlan }) {
  const linked =
    plan.stripeProductId !== null || plan.stripePriceIdMonth !== null || plan.stripePriceIdYear !== null;
  return (
    <span className="grid gap-1">
      <span className={linked ? undefined : "text-muted-foreground"}>
        {linked ? P.stripeLinked : P.stripeNotLinked}
      </span>
      {plan.priceWarnings.length === 0 ? null : (
        <PlanBadge tone="warning">{P.priceWarnings(plan.priceWarnings.length)}</PlanBadge>
      )}
    </span>
  );
}

function PlanRow({ plan }: { readonly plan: AdminPlan }) {
  return (
    <TableRow className="align-top" data-plan={plan.code}>
      <TableCell>
        <span className="grid gap-0.5">
          <Link href={`/plans/${encodeURIComponent(plan.code)}`} className={LINK_CLASS}>
            {plan.name}
          </Link>
          <span className="font-mono text-xs text-muted-foreground">{plan.code}</span>
        </span>
      </TableCell>
      <TableCell>
        <PlanStatus isActive={plan.isActive} />
      </TableCell>
      <TableCell>
        <PricingState isPublic={plan.isPublic} isActive={plan.isActive} />
      </TableCell>
      <TableCell>
        <Money value={plan.monthlyPrice} />
      </TableCell>
      <TableCell>
        {plan.annualPrice === null ? (
          <span className="text-muted-foreground">{P.noAnnual}</span>
        ) : (
          <Money value={plan.annualPrice} />
        )}
      </TableCell>
      <TableCell>{P.trialDays(plan.trialDays)}</TableCell>
      <TableCell className="whitespace-normal">{P.limits(plan.limits)}</TableCell>
      <TableCell>
        <Link
          href={`/tenants?${new URLSearchParams({ planCode: plan.code }).toString()}`}
          className={`${LINK_CLASS} tabular-nums`}
          aria-label={`${S.tenantsOf(plan.name)}: ${P.tenantCount(plan.tenantCount)}`}
        >
          {P.tenantCount(plan.tenantCount)}
        </Link>
      </TableCell>
      <TableCell>
        <StripeState plan={plan} />
      </TableCell>
    </TableRow>
  );
}

/**
 * `/plans` (README §2; subscription-billing flow §A): every plan of `adminListPlans`, public or not and active or
 * retired, in the pricing page's order, with its state, whether the portal's pricing page offers it (public and
 * active), its prices (`Money`, decimal strings), trial, limits, the OTAs on it (linking the tenant list filtered by
 * the plan) and its Stripe link state with price warnings (M5). The list is short and not paginated, so it is a server
 * table: nothing of the plans but what it shows reaches the browser. "New plan" (`CreatePlanForm`) creates a plan; the
 * revalidated list shows it at once.
 */
export default async function PlansPage() {
  const api = await platformApi();
  const plans = await api.GET("/v1/admin/plans");
  if (plans.error?.code === "UNAUTHENTICATED" || plans.error?.code === "TOKEN_EXPIRED") {
    redirect("/sign-in");
  }
  const pricingUrl = new URL("/pricing", getConfig().PUBLIC_PORTAL_URL).toString();

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
        <p>
          <a href={pricingUrl} className="text-sm font-medium underline underline-offset-4">
            {S.pricingPageLink}
          </a>
        </p>
      </div>
      <CreatePlanForm pricingUrl={pricingUrl} />
      {plans.error === undefined ? (
        <Table>
          <TableCaption className="sr-only">{S.caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{S.columnPlan}</TableHead>
              <TableHead scope="col">{S.columnStatus}</TableHead>
              <TableHead scope="col">{S.columnPricing}</TableHead>
              <TableHead scope="col">{S.columnMonthly}</TableHead>
              <TableHead scope="col">{S.columnAnnual}</TableHead>
              <TableHead scope="col">{S.columnTrial}</TableHead>
              <TableHead scope="col">{S.columnLimits}</TableHead>
              <TableHead scope="col">{S.columnTenants}</TableHead>
              <TableHead scope="col">{S.columnStripe}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.data.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-20 text-center text-muted-foreground">
                  {S.empty}
                </TableCell>
              </TableRow>
            ) : (
              plans.data.data.map((plan) => <PlanRow key={plan.code} plan={plan} />)
            )}
          </TableBody>
        </Table>
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(plans.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
