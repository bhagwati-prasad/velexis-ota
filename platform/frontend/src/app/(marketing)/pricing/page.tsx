import type { components } from "@velexis/api-types/platform";
import { Check, Minus } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { Money } from "@/components/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { createPlatformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { PRICING_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: PRICING_STRINGS.title };

type Plan = components["schemas"]["Plan"];

/**
 * `/sign-up?plan=<code>`: sign-up with the plan the visitor chose (README §2 Public). Sign-up does not read `plan`
 * yet; the plan is chosen in the create-OTA wizard.
 */
function signUpHref(code: string): string {
  return `/sign-up?${new URLSearchParams({ plan: code }).toString()}`;
}

/**
 * `listPlans`: the public, active plans in the order of their `sort_order`. The operation is public, so the call
 * carries no access token even when the visitor is signed in; it still carries the end-user headers of PADR-0019,
 * so the API's per-IP rate limit counts the visitor and not the portal.
 */
async function listPlans() {
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  return api.GET("/v1/plans");
}

/** One line of a plan's "Included" list; `included: false` marks a limit the plan does not lift. */
function Included({ included, children }: { readonly included: boolean; readonly children: string }) {
  const Icon = included ? Check : Minus;
  return (
    <li className="flex items-start gap-2">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{children}</span>
    </li>
  );
}

/** A plan as the API returned it: prices with `Money`, the free trial, the limits and "Start". */
function PlanCard({ plan }: { readonly plan: Plan }) {
  const nameId = `plan-${plan.code}`;
  return (
    <li className="flex">
      <article
        aria-labelledby={nameId}
        className="flex flex-1 flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground shadow-xs"
      >
        <div className="grid gap-2">
          <h2 id={nameId} className="text-xl font-semibold tracking-tight">
            {plan.name}
          </h2>
          {plan.description === null || plan.description === "" ? null : (
            <p className="text-sm text-muted-foreground">{plan.description}</p>
          )}
        </div>
        <dl className="grid gap-4">
          <div className="grid gap-1">
            <dt className="text-sm text-muted-foreground">{PRICING_STRINGS.monthly}</dt>
            <dd className="flex flex-wrap items-baseline gap-x-2">
              <Money value={plan.monthlyPrice} className="text-3xl font-semibold tracking-tight" />
              <span className="text-sm text-muted-foreground">{PRICING_STRINGS.perMonth}</span>
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-sm text-muted-foreground">{PRICING_STRINGS.annual}</dt>
            <dd className="flex flex-wrap items-baseline gap-x-2">
              {plan.annualPrice === null ? (
                PRICING_STRINGS.noAnnual
              ) : (
                <>
                  <Money value={plan.annualPrice} className="font-semibold" />
                  <span className="text-sm text-muted-foreground">{PRICING_STRINGS.perYear}</span>
                </>
              )}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-sm text-muted-foreground">{PRICING_STRINGS.trial}</dt>
            <dd>
              {plan.trialDays > 0 ? PRICING_STRINGS.trialDays(plan.trialDays) : PRICING_STRINGS.noTrial}
            </dd>
          </div>
        </dl>
        <div className="grid gap-3">
          <h3 className="text-sm font-medium">{PRICING_STRINGS.includedTitle}</h3>
          <ul className="grid gap-2 text-sm">
            <Included included>{PRICING_STRINGS.staffSeats(plan.limits.staffSeats)}</Included>
            <Included included>{PRICING_STRINGS.apiKeys(plan.limits.apiKeys)}</Included>
            <Included included={plan.limits.customDomains > 0}>
              {PRICING_STRINGS.customDomains(plan.limits.customDomains)}
            </Included>
            <Included included={plan.limits.liveMode}>
              {plan.limits.liveMode ? PRICING_STRINGS.liveMode : PRICING_STRINGS.testModeOnly}
            </Included>
          </ul>
        </div>
        <Button asChild className="mt-auto">
          <Link href={signUpHref(plan.code)} prefetch={false}>
            {PRICING_STRINGS.start}
            <span className="sr-only">{PRICING_STRINGS.startWith(plan.name)}</span>
          </Link>
        </Button>
      </article>
    </li>
  );
}

/**
 * `/pricing` (README §2 Public, PF-70 AC1): the plans `listPlans` returns, in its order and nothing else: name,
 * description, monthly and annual price (`Money`), free trial and limits, and "Start", which leads to
 * `/sign-up?plan=<code>`. A failed call shows the portal's message for its code, never the API's own text.
 */
export default async function PricingPage() {
  const plans = await listPlans();
  return (
    <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-16">
        <div className="grid max-w-2xl gap-3">
          <h1 className="text-4xl font-semibold tracking-tight">{PRICING_STRINGS.title}</h1>
          <p className="text-lg text-muted-foreground">{PRICING_STRINGS.intro}</p>
        </div>
        {plans.error !== undefined ? (
          <Alert variant="destructive">
            <AlertTitle>{PRICING_STRINGS.unavailableTitle}</AlertTitle>
            <AlertDescription>
              <p>{errorMessage(plans.error)}</p>
              <p>
                {PRICING_STRINGS.signUpAnyway}{" "}
                <Link
                  href="/sign-up"
                  prefetch={false}
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  {PRICING_STRINGS.signUp}
                </Link>
              </p>
            </AlertDescription>
          </Alert>
        ) : plans.data.data.length === 0 ? (
          <p className="text-muted-foreground">{PRICING_STRINGS.empty}</p>
        ) : (
          <ul aria-label={PRICING_STRINGS.plansLabel} className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {plans.data.data.map((plan) => (
              <PlanCard key={plan.code} plan={plan} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
