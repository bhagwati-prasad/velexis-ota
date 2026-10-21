import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import type { EditablePlan } from "@/app/(app)/plans/actions";
import {
  EditPlanForm,
  PlanBadge,
  PlanStatus,
  PlanStatusForm,
  PricingState,
} from "@/app/(app)/plans/plan-form";
import { DateTime } from "@/components/date-time";
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
import { errorMessage } from "@/lib/errors";
import {
  PLAN_DETAIL_STRINGS as S,
  PLAN_LIST_STRINGS,
  PLAN_STRINGS as P,
  formatBasisPoints,
  formatCount,
} from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type AdminPlan = components["schemas"]["AdminPlan"];

/** `PlanCode` of the platform document; another value is no plan, and the API is not asked. */
const PLAN_CODE = /^[a-z][a-z0-9_]{1,39}$/;

const LINK_CLASS = "font-medium underline underline-offset-4";

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

function Fields({ children }: { readonly children: ReactNode }) {
  return <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">{children}</dl>;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Panel({
  id,
  title,
  intro,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {intro === undefined ? null : <p className="text-sm text-muted-foreground">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * The fields of the plan the forms show. The forms are client components, so what they get is sent to the browser:
 * only these fields go, whatever else the answer might carry.
 */
function editableOf(plan: AdminPlan): EditablePlan {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    currency: plan.currency,
    monthlyPrice: plan.monthlyPrice.amount,
    annualPrice: plan.annualPrice === null ? null : plan.annualPrice.amount,
    trialDays: plan.trialDays,
    limits: {
      staffSeats: plan.limits.staffSeats,
      apiKeys: plan.limits.apiKeys,
      customDomains: plan.limits.customDomains,
      liveMode: plan.limits.liveMode,
    },
    features: { ...plan.features },
    isPublic: plan.isPublic,
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
    settlementFeeBps: plan.settlementFeeBps,
    version: plan.version,
  };
}

function SummaryPanel({ plan }: { readonly plan: AdminPlan }) {
  const features = Object.entries(plan.features);
  return (
    <Panel id="plan-summary" title={S.summaryTitle}>
      <Fields>
        <Field label={S.code}>
          <Mono>{plan.code}</Mono>
        </Field>
        <Field label={S.status}>
          <PlanStatus isActive={plan.isActive} />
        </Field>
        <Field label={S.pricingPage}>
          <PricingState isPublic={plan.isPublic} isActive={plan.isActive} />
        </Field>
        <Field label={S.currency}>
          <Mono>{plan.currency}</Mono>
        </Field>
        <Field label={S.monthlyPrice}>
          <Money value={plan.monthlyPrice} />
        </Field>
        <Field label={S.annualPrice}>
          {plan.annualPrice === null ? <Muted>{P.noAnnual}</Muted> : <Money value={plan.annualPrice} />}
        </Field>
        <Field label={S.trial}>{P.trialDays(plan.trialDays)}</Field>
        <Field label={S.limits}>{P.limits(plan.limits)}</Field>
        <Field label={S.features}>
          {features.length === 0 ? (
            <Muted>{P.noFeatures}</Muted>
          ) : (
            <ul className="grid gap-1">
              {features.map(([name, on]) => (
                <li key={name}>
                  <Mono>{name}</Mono> {on ? P.featureOn : P.featureOff}
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label={S.settlementFee}>
          <span className="tabular-nums">{formatBasisPoints(plan.settlementFeeBps)}</span>
        </Field>
        <Field label={S.sortOrder}>
          <span className="tabular-nums">{formatCount(plan.sortOrder)}</span>
        </Field>
        <Field label={S.tenants}>
          <Link
            href={`/tenants?${new URLSearchParams({ planCode: plan.code }).toString()}`}
            className={LINK_CLASS}
          >
            {P.tenantCount(plan.tenantCount)}
          </Link>
        </Field>
        <Field label={S.created}>
          <DateTime value={plan.createdAt} />
        </Field>
        <Field label={S.updated}>
          <DateTime value={plan.updatedAt} />
        </Field>
        <Field label={S.version}>
          <span className="tabular-nums">{plan.version}</span>
        </Field>
      </Fields>
    </Panel>
  );
}

/** A Stripe id, or "Not linked". */
function StripeId({ value }: { readonly value: string | null }) {
  return value === null ? <Muted>{S.notLinked}</Muted> : <Mono>{value}</Mono>;
}

/** The Stripe product and prices (M5), whether Checkout can start, and the price warnings of the last comparison. */
function StripePanel({ plan }: { readonly plan: AdminPlan }) {
  return (
    <Panel id="plan-stripe" title={S.stripeTitle} intro={S.stripeIntro}>
      <Fields>
        <Field label={S.stripeProduct}>
          <StripeId value={plan.stripeProductId} />
        </Field>
        <Field label={S.stripePriceMonth}>
          <StripeId value={plan.stripePriceIdMonth} />
        </Field>
        <Field label={S.stripePriceYear}>
          <StripeId value={plan.stripePriceIdYear} />
        </Field>
        <Field label={`${S.checkoutTitle}, ${S.checkoutMonth.toLowerCase()}`}>
          {plan.checkoutAvailable.month ? S.checkoutOpen : <Muted>{S.checkoutClosed}</Muted>}
        </Field>
        <Field label={`${S.checkoutTitle}, ${S.checkoutYear.toLowerCase()}`}>
          {plan.checkoutAvailable.year ? S.checkoutOpen : <Muted>{S.checkoutClosed}</Muted>}
        </Field>
      </Fields>
      <div className="grid gap-2">
        <h3 className="text-base font-semibold">{S.warningsTitle}</h3>
        <p className="text-sm text-muted-foreground">{S.warningsIntro}</p>
        {plan.priceWarnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{S.warningsEmpty}</p>
        ) : (
          <>
            <PlanBadge tone="warning">{P.priceWarnings(plan.priceWarnings.length)}</PlanBadge>
            <Table>
              <TableCaption className="sr-only">{S.warningsCaption}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{S.warningField}</TableHead>
                  <TableHead scope="col">{S.warningExpected}</TableHead>
                  <TableHead scope="col">{S.warningActual}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.priceWarnings.map((warning) => (
                  <TableRow key={warning.field}>
                    <TableCell>
                      <Mono>{warning.field}</Mono>
                    </TableCell>
                    <TableCell>{warning.expected ?? <Muted>{S.none}</Muted>}</TableCell>
                    <TableCell>{warning.actual ?? <Muted>{S.none}</Muted>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </Panel>
  );
}

function BackLink() {
  return (
    <Link href="/plans" className="text-sm font-medium underline underline-offset-4">
      {S.backToList}
    </Link>
  );
}

/**
 * `/plans/[planCode]` (README §2; subscription-billing flow §A): one plan of `adminListPlans` (the API has no read of a
 * single plan, and the list is short) with its fields, the OTAs on it, its Stripe link state and price warnings (M5),
 * "Edit the plan" (`EditPlanForm`: every field but the code and the currency, the limits and the features as structured
 * fields, the version in `If-Match`) and "Retire plan" or "Make the plan active again" (`PlanStatusForm`). A value that
 * is no plan code renders the not-found page without a call, and so does a code the list does not have.
 */
export default async function PlanPage({ params }: Readonly<{ params: Promise<{ planCode: string }> }>) {
  const { planCode } = await params;
  if (!PLAN_CODE.test(planCode)) {
    notFound();
  }
  const api = await platformApi();
  const result = await api.GET("/v1/admin/plans");
  if (result.error !== undefined) {
    if (result.error.code === "UNAUTHENTICATED" || result.error.code === "TOKEN_EXPIRED") {
      redirect("/sign-in");
    }
    return (
      <div className="mx-auto grid max-w-6xl gap-6">
        <BackLink />
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const plan = result.data.data.find((candidate) => candidate.code === planCode);
  if (plan === undefined) {
    notFound();
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <BackLink />
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {S.title}: {plan.name}
          </h1>
          <PlanStatus isActive={plan.isActive} />
          <PricingState isPublic={plan.isPublic} isActive={plan.isActive} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{plan.code}</span> · {PLAN_LIST_STRINGS.columnTenants}:{" "}
          {P.tenantCount(plan.tenantCount)}
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <SummaryPanel plan={plan} />
        <StripePanel plan={plan} />
      </div>
      <EditPlanForm plan={editableOf(plan)} />
      <section aria-labelledby="plan-lifecycle" className="grid gap-3">
        <h2 id="plan-lifecycle" className="text-lg font-semibold tracking-tight">
          {S.lifecycleTitle}
        </h2>
        <PlanStatusForm code={plan.code} name={plan.name} isActive={plan.isActive} version={plan.version} />
      </section>
    </div>
  );
}
