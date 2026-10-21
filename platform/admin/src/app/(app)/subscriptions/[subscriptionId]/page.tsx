import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  ManualSubscriptionForm,
  type PlanChoice,
} from "@/app/(app)/subscriptions/[subscriptionId]/manual-subscription-form";
import { DateTime } from "@/components/date-time";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
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
  BILLING_INTERVAL_LABELS,
  BILLING_PROVIDER_LABELS,
  MANUAL_SUBSCRIPTION_STRINGS as M,
  SUBSCRIPTION_DETAIL_STRINGS as S,
  formatCount,
} from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type AdminSubscription = Schemas["AdminSubscription"];
type AdminInvoice = Schemas["AdminInvoice"];
type AdminStripeEvent = Schemas["AdminStripeEvent"];

/** `SubscriptionId` of the platform document; another value is no subscription, and the API is not asked. */
const SUBSCRIPTION_ID = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;

const LINK_CLASS = "font-medium underline underline-offset-4";

function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

/** An instant, or `empty` for `null`. */
function When({ value, empty = S.none }: { readonly value: string | null; readonly empty?: string }) {
  return value === null ? <Muted>{empty}</Muted> : <DateTime value={value} />;
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

/** A Stripe-hosted link, only for an `https:` URL (anything else is not rendered as a link). */
function StripeLink({ href, children }: { readonly href: string | null; readonly children: ReactNode }) {
  if (href === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? (
    <a href={url.toString()} rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  ) : null;
}

function SummaryPanel({ subscription }: { readonly subscription: AdminSubscription }) {
  return (
    <Panel id="subscription-summary" title={S.summaryTitle}>
      <Fields>
        <Field label={S.id}>
          <Mono>{subscription.id}</Mono>
        </Field>
        <Field label={S.ota}>
          <Link href={`/tenants/${encodeURIComponent(subscription.tenantId)}`} className={LINK_CLASS}>
            {subscription.tenantName}
          </Link>{" "}
          <Mono>{subscription.tenantKey}</Mono>
        </Field>
        <Field label={S.plan}>
          <Link href={`/plans/${encodeURIComponent(subscription.planCode)}`} className={LINK_CLASS}>
            {subscription.planName}
          </Link>{" "}
          <Mono>{subscription.planCode}</Mono>
        </Field>
        <Field label={S.status}>
          <StatusBadge kind="subscription" status={subscription.status} />
        </Field>
        <Field label={S.billing}>{labelOf(BILLING_PROVIDER_LABELS, subscription.billingProvider)}</Field>
        <Field label={S.interval}>{labelOf(BILLING_INTERVAL_LABELS, subscription.billingInterval)}</Field>
        <Field label={S.trialEnds}>
          <When value={subscription.trialEndsAt} />
        </Field>
        <Field label={S.periodStart}>
          <When value={subscription.currentPeriodStart} />
        </Field>
        <Field label={S.periodEnd}>
          <When value={subscription.currentPeriodEnd} />
        </Field>
        <Field label={S.cancelAtPeriodEnd}>{subscription.cancelAtPeriodEnd ? S.yes : S.no}</Field>
        <Field label={S.canceledAt}>
          <When value={subscription.canceledAt} empty={S.notYet} />
        </Field>
        <Field label={S.stripeCustomer}>
          {subscription.providerCustomerId === null ? (
            <Muted>{S.none}</Muted>
          ) : (
            <Mono>{subscription.providerCustomerId}</Mono>
          )}
        </Field>
        <Field label={S.stripeSubscription}>
          {subscription.providerSubscriptionId === null ? (
            <Muted>{S.none}</Muted>
          ) : (
            <Mono>{subscription.providerSubscriptionId}</Mono>
          )}
        </Field>
        <Field label={S.created}>
          <DateTime value={subscription.createdAt} />
        </Field>
        <Field label={S.version}>
          <span className="tabular-nums">{subscription.version}</span>
        </Field>
      </Fields>
    </Panel>
  );
}

function InvoicesPanel({ invoices }: { readonly invoices: readonly AdminInvoice[] }) {
  return (
    <Panel id="subscription-invoices" title={S.invoicesTitle} intro={S.invoicesIntro}>
      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{S.invoicesEmpty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{S.invoicesCaption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{S.invoiceNumber}</TableHead>
              <TableHead scope="col">{S.invoiceStatus}</TableHead>
              <TableHead scope="col">{S.invoicePeriod}</TableHead>
              <TableHead scope="col">{S.invoiceTotal}</TableHead>
              <TableHead scope="col">{S.invoiceDue}</TableHead>
              <TableHead scope="col">{S.invoiceIssued}</TableHead>
              <TableHead scope="col">{S.invoicePaid}</TableHead>
              <TableHead scope="col">{S.invoiceLinks}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((invoice) => (
              <TableRow key={invoice.id} className="align-top">
                <TableCell>
                  <Mono>{invoice.number}</Mono>
                </TableCell>
                <TableCell>
                  <StatusBadge kind="invoice" status={invoice.status} />
                </TableCell>
                <TableCell>
                  {invoice.periodStart === null || invoice.periodEnd === null ? (
                    <Muted>{S.none}</Muted>
                  ) : (
                    <span>
                      <DateTime value={invoice.periodStart} mode="date" /> {S.periodTo}{" "}
                      <DateTime value={invoice.periodEnd} mode="date" />
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Money value={invoice.total} />
                </TableCell>
                <TableCell>
                  <Money value={invoice.amountDue} />
                </TableCell>
                <TableCell>
                  <When value={invoice.issuedAt} />
                </TableCell>
                <TableCell>
                  <When value={invoice.paidAt} empty={S.notYet} />
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-3">
                    <StripeLink href={invoice.hostedInvoiceUrl}>
                      {S.invoicePage}
                      <span className="sr-only">{S.invoicePageOf(invoice.number)}</span>
                    </StripeLink>
                    <StripeLink href={invoice.invoicePdfUrl}>
                      {S.invoicePdf}
                      <span className="sr-only">{S.invoicePageOf(invoice.number)}</span>
                    </StripeLink>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function EventsPanel({ events }: { readonly events: readonly AdminStripeEvent[] }) {
  return (
    <Panel id="subscription-events" title={S.eventsTitle} intro={S.eventsIntro}>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{S.eventsEmpty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{S.eventsCaption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{S.eventId}</TableHead>
              <TableHead scope="col">{S.eventType}</TableHead>
              <TableHead scope="col">{S.eventStatus}</TableHead>
              <TableHead scope="col">{S.eventAttempts}</TableHead>
              <TableHead scope="col">{S.eventError}</TableHead>
              <TableHead scope="col">{S.eventReceived}</TableHead>
              <TableHead scope="col">{S.eventProcessed}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.id} className="align-top">
                <TableCell>
                  <Mono>{event.id}</Mono>
                </TableCell>
                <TableCell>
                  <Mono>{event.type}</Mono>
                </TableCell>
                <TableCell>
                  <StatusBadge kind="stripeEvent" status={event.status} />
                </TableCell>
                <TableCell className="tabular-nums">{formatCount(event.attempts)}</TableCell>
                <TableCell className="whitespace-normal">
                  {event.lastError === null ? <Muted>{S.none}</Muted> : event.lastError}
                </TableCell>
                <TableCell>
                  <DateTime value={event.receivedAt} />
                </TableCell>
                <TableCell>
                  <When value={event.processedAt} empty={S.notYet} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function BackLink() {
  return (
    <Link href="/subscriptions" className="text-sm font-medium underline underline-offset-4">
      {S.backToList}
    </Link>
  );
}

/**
 * `/subscriptions/[subscriptionId]` (README §2; subscription-billing flow §G, PF-75): one subscription of
 * `adminGetSubscription` with its OTA, plan, status, billing, trial and periods and the Stripe references, its invoices
 * (`Money`, Stripe-hosted links) and the Stripe events of its OTA (both empty before M5). A **manual** subscription has
 * "Edit the manual subscription" (`ManualSubscriptionForm`: plan, trial end, status, with a reason and `If-Match`; the
 * page then also loads the active plans with `adminListPlans`, and a failed list still renders the page); a
 * Stripe-billed one has no edit form at all, only a note that Stripe owns it. A value that is no subscription id, and
 * an unknown subscription, render the not-found page.
 */
export default async function SubscriptionPage({
  params,
}: Readonly<{ params: Promise<{ subscriptionId: string }> }>) {
  const { subscriptionId } = await params;
  if (!SUBSCRIPTION_ID.test(subscriptionId)) {
    notFound();
  }
  const api = await platformApi();
  const result = await api.GET("/v1/admin/subscriptions/{subscriptionId}", {
    params: { path: { subscriptionId } },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect("/sign-in");
    }
    if (code === "NOT_FOUND" || code === "VALIDATION_FAILED") {
      notFound();
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
  const { subscription, invoices, events } = result.data;
  const manual = subscription.billingProvider === "manual";
  let plans: PlanChoice[] | null = null;
  if (manual) {
    const list = await api.GET("/v1/admin/plans");
    if (list.error?.code === "UNAUTHENTICATED" || list.error?.code === "TOKEN_EXPIRED") {
      redirect("/sign-in");
    }
    // Only active plans can be chosen (`plan_not_active` otherwise); plans that are not public can.
    plans =
      list.error === undefined
        ? list.data.data.filter((plan) => plan.isActive).map((plan) => ({ code: plan.code, name: plan.name }))
        : null;
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <BackLink />
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {S.title}: {subscription.tenantName}
          </h1>
          <StatusBadge kind="subscription" status={subscription.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{subscription.id}</span> ·{" "}
          {labelOf(BILLING_PROVIDER_LABELS, subscription.billingProvider)}
        </p>
      </div>
      <SummaryPanel subscription={subscription} />
      {manual ? (
        <Panel id="subscription-edit" title={M.title} intro={M.intro}>
          <ManualSubscriptionForm
            subscriptionId={subscription.id}
            version={subscription.version}
            planCode={subscription.planCode}
            planName={subscription.planName}
            status={subscription.status}
            trialEndsAt={subscription.trialEndsAt}
            plans={plans}
          />
        </Panel>
      ) : (
        <Alert>
          <AlertTitle>{S.stripeBilledTitle}</AlertTitle>
          <AlertDescription>{S.stripeBilled}</AlertDescription>
        </Alert>
      )}
      <InvoicesPanel invoices={invoices} />
      <EventsPanel events={events} />
    </div>
  );
}
