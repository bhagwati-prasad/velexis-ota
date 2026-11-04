import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { DateTime } from "@/components/date-time";
import { toneClasses } from "@/components/status-badge";
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
import { DASHBOARD_STRINGS, STATUS_LABELS, SUPPLIER_ENVIRONMENT_LABELS, formatCount } from "@/lib/strings";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: DASHBOARD_STRINGS.title };

type Schemas = components["schemas"];
type Dashboard = Schemas["AdminDashboard"];
type TenantStatus = Schemas["TenantStatus"];
type OfficePoolLevel = Schemas["OfficePoolLevel"];

/** The statuses of `tenantsByStatus`, in the order of an OTA's life. */
const TENANT_STATUSES: readonly TenantStatus[] = ["provisioning", "active", "suspended", "failed"];

/** Below this many available offices the pool level is a warning (PADR-0012: new OTAs would wait for an office). */
const OFFICE_POOL_LOW = 3;

const ENVIRONMENT_LABELS: Readonly<Record<Schemas["Environment"], string>> = SUPPLIER_ENVIRONMENT_LABELS;

/**
 * The most live office requests `adminGetDashboard` answers (`maxItems` of `AdminDashboard.liveOfficeRequests`): at
 * this many, the section says that the oldest ones are shown.
 */
const LIVE_OFFICE_REQUESTS_LIMIT = 50;

/** A list URL with its filters, so each count opens exactly the rows it counts (README §4: lists live in the URL). */
function filtered(pathname: string, filters: Readonly<Record<string, string>>): string {
  return `${pathname}?${new URLSearchParams(filters).toString()}`;
}

const COUNT_LINK_CLASS =
  "group grid gap-1 rounded-xl border bg-card p-4 text-card-foreground shadow-xs outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * Muted text inside a link with the hover background: it takes the hover's foreground, because muted text on
 * `bg-accent` has a contrast of 4.35:1, under the 4.5:1 of WCAG 1.4.3 (found by the PAD-010 journeys).
 */
const MUTED_IN_LINK_CLASS = "text-muted-foreground group-hover:text-accent-foreground";

const LINK_CLASS = "font-medium underline underline-offset-4";

/** One count that opens its filtered list; the link's name is the number and what it counts ("14 Active"). */
function CountLink({
  href,
  count,
  label,
  attention = false,
}: {
  readonly href: string;
  readonly count: number;
  readonly label: string;
  /** A count that needs someone (failures): highlighted while it is above zero. */
  readonly attention?: boolean;
}) {
  const flagged = attention && count > 0;
  return (
    <Link href={href} className={cn(COUNT_LINK_CLASS, flagged && "border-red-300")} data-count={count}>
      <span className={cn("text-2xl font-semibold tabular-nums", flagged && "text-red-900")}>
        {formatCount(count)}
      </span>{" "}
      <span className={cn("text-sm", MUTED_IN_LINK_CLASS)}>{label}</span>
    </Link>
  );
}

function Section({
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
    <section aria-labelledby={id} className="grid content-start gap-3">
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

/** The office pool of one environment: available and assigned offices, and a warning below three available. */
function OfficePool({ level }: { readonly level: OfficePoolLevel }) {
  const environment = ENVIRONMENT_LABELS[level.environment] ?? level.environment;
  const headingId = `dashboard-pool-${level.environment}`;
  const low = level.available < OFFICE_POOL_LOW;
  return (
    <section
      aria-labelledby={headingId}
      className="grid content-start gap-3"
      data-environment={level.environment}
    >
      <h3 id={headingId} className="text-sm font-medium">
        {environment}
      </h3>
      <ul className="grid gap-3 sm:grid-cols-2">
        <li>
          <CountLink
            href={filtered("/amadeus/offices", { environment: level.environment, status: "available" })}
            count={level.available}
            label={DASHBOARD_STRINGS.available}
            attention={low}
          />
        </li>
        <li>
          <CountLink
            href={filtered("/amadeus/offices", { environment: level.environment, status: "assigned" })}
            count={level.assigned}
            label={DASHBOARD_STRINGS.assigned}
          />
        </li>
      </ul>
      {low ? (
        // Words, not only colour: the warning says what is wrong and what to do.
        <p
          className={cn("rounded-lg px-4 py-3 text-sm", toneClasses("warning"))}
          data-warning="office-pool-low"
        >
          {DASHBOARD_STRINGS.poolLow(environment, level.available)}
        </p>
      ) : null}
    </section>
  );
}

// ---- The M5 counters ------------------------------------------------------------------------------------------------

/** One M5 counter: its count (`null` while its milestone switch is off), its list and its words. */
interface ReviewCounter {
  readonly id: string;
  readonly count: number | null;
  readonly href: string;
  readonly label: (count: number) => string;
  /** A failure count, highlighted while above zero. */
  readonly attention: boolean;
}

/**
 * The M5 counters of `adminGetDashboard` (README §2), each linking to the list it counts: custom domains waiting for
 * their DNS records (`/domains`, PAD-014), draft settlements (`/settlements`, PAD-013), failed Stripe events
 * (`/stripe-events`, PAD-012) and past-due subscriptions (`/subscriptions`, PAD-008). A counter whose switch is off is
 * `null` and left out (PADR-0015 item 3), as the navigation leaves out its area; with every switch off the section is.
 */
function reviewCounters(dashboard: Dashboard): ReviewCounter[] {
  return [
    {
      id: "domainsPending",
      count: dashboard.domainsPending,
      href: filtered("/domains", { kind: "custom", verificationStatus: "pending" }),
      label: DASHBOARD_STRINGS.domainsPending,
      attention: false,
    },
    {
      id: "settlementsToReview",
      count: dashboard.settlementsToReview,
      href: filtered("/settlements", { status: "draft" }),
      label: DASHBOARD_STRINGS.settlementsToReview,
      attention: false,
    },
    {
      id: "stripeEventsFailed",
      count: dashboard.stripeEventsFailed,
      href: filtered("/stripe-events", { status: "failed" }),
      label: DASHBOARD_STRINGS.stripeEventsFailed,
      attention: true,
    },
    {
      id: "subscriptionsPastDue",
      count: dashboard.subscriptionsPastDue,
      href: filtered("/subscriptions", { status: "past_due" }),
      label: DASHBOARD_STRINGS.subscriptionsPastDue,
      attention: true,
    },
  ];
}

function ReviewCounters({ dashboard }: { readonly dashboard: Dashboard }) {
  const shown = reviewCounters(dashboard).flatMap((counter) =>
    counter.count === null ? [] : [{ ...counter, count: counter.count }],
  );
  if (shown.length === 0) {
    return null;
  }
  return (
    <Section id="dashboard-review" title={DASHBOARD_STRINGS.m5Title} intro={DASHBOARD_STRINGS.m5Intro}>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {shown.map((counter) => (
          <li key={counter.id} data-counter={counter.id}>
            <CountLink
              href={counter.href}
              count={counter.count}
              label={counter.label(counter.count)}
              attention={counter.attention}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---- Live office requests -----------------------------------------------------------------------------------------

type LiveOfficeRequest = Schemas["LiveOfficeRequest"];

/** The OTA's page on the connections tab, at the card of the waiting live connection, where "Assign office" is. */
function assignOfficeHref(request: LiveOfficeRequest): string {
  return `/tenants/${encodeURIComponent(request.tenantId)}?tab=connections#connection-${encodeURIComponent(request.connectionId)}`;
}

/**
 * The live office requests (PAD-014, flows/amadeus-connection.md §C, PF-90) as `adminGetDashboard` answers them
 * (`liveOfficeRequests`, FIX-W41-PLATFORM, lead decision (2n) of 2026-11-04): the OTAs whose live Velexis connection
 * waits for an office, oldest request first, read by the API from the connections themselves, so this page asks for
 * nothing else. Each links to the OTA's connections, where "Assign office" serves it.
 */
function LiveOfficeRequests({ requests }: { readonly requests: readonly LiveOfficeRequest[] }) {
  return (
    <Section
      id="dashboard-live-requests"
      title={DASHBOARD_STRINGS.liveRequestsTitle}
      intro={DASHBOARD_STRINGS.liveRequestsIntro}
    >
      {requests.length === 0 ? (
        <p className="text-sm">{DASHBOARD_STRINGS.liveRequestsEmpty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{DASHBOARD_STRINGS.liveRequestsCaption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{DASHBOARD_STRINGS.liveRequestOta}</TableHead>
              <TableHead scope="col">{DASHBOARD_STRINGS.liveRequestRequested}</TableHead>
              <TableHead scope="col">{DASHBOARD_STRINGS.liveRequestAction}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <TableRow key={request.connectionId} data-tenant-id={request.tenantId}>
                <TableCell>
                  <span className="grid gap-0.5">
                    <span className="font-medium">{request.tenantName}</span>
                    <span className="font-mono text-xs text-muted-foreground">{request.tenantKey}</span>
                  </span>
                </TableCell>
                <TableCell>
                  <DateTime value={request.requestedAt} />
                </TableCell>
                <TableCell>
                  <Link href={assignOfficeHref(request)} className={LINK_CLASS}>
                    {DASHBOARD_STRINGS.assignOffice}
                    <span className="sr-only">{DASHBOARD_STRINGS.assignOfficeFor(request.tenantName)}</span>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {requests.length >= LIVE_OFFICE_REQUESTS_LIMIT ? (
        <p className="text-sm" data-notice="live-requests-oldest">
          {DASHBOARD_STRINGS.liveRequestsOldest(LIVE_OFFICE_REQUESTS_LIMIT)}
        </p>
      ) : null}
    </Section>
  );
}

function DashboardView({ dashboard }: { readonly dashboard: Dashboard }) {
  const queues = Object.entries(dashboard.jobsFailedByQueue);
  // Only a Velexis live account takes live requests (`live_account_missing` otherwise), and `officePool` lists the
  // environment of every account: without one, and without a request left from before, the section is left out.
  const showLiveRequests =
    dashboard.liveOfficeRequests.length > 0 ||
    dashboard.officePool.some((level) => level.environment === "live");
  return (
    <div className="grid gap-10">
      <Section id="dashboard-tenants" title={DASHBOARD_STRINGS.tenantsTitle}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TENANT_STATUSES.map((status) => (
            <li key={status}>
              <CountLink
                href={filtered("/tenants", { status })}
                count={dashboard.tenantsByStatus[status]}
                label={STATUS_LABELS.tenant[status]}
                attention={status === "failed"}
              />
            </li>
          ))}
        </ul>
      </Section>

      <ReviewCounters dashboard={dashboard} />

      <div className="grid gap-10 lg:grid-cols-2">
        <Section
          id="dashboard-provisioning"
          title={DASHBOARD_STRINGS.provisioningTitle}
          intro={DASHBOARD_STRINGS.provisioningHint}
        >
          <CountLink
            href={filtered("/provisioning-jobs", { status: "failed" })}
            count={dashboard.provisioningFailed24h}
            label={DASHBOARD_STRINGS.provisioningFailed(dashboard.provisioningFailed24h)}
            attention
          />
        </Section>

        <Section
          id="dashboard-queues"
          title={DASHBOARD_STRINGS.queuesTitle}
          intro={DASHBOARD_STRINGS.queuesIntro}
        >
          <ul className="grid gap-2">
            {queues.map(([queue, count]) => (
              <li key={queue}>
                <Link
                  href={`/queues/${encodeURIComponent(queue)}`}
                  className={cn(
                    "group flex items-baseline justify-between gap-4 rounded-md border px-3 py-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    count > 0 && "border-red-300",
                  )}
                  data-count={count}
                >
                  <span className="font-mono">{queue}</span>{" "}
                  <span
                    className={cn(
                      "tabular-nums",
                      count > 0 ? "font-medium text-red-900" : MUTED_IN_LINK_CLASS,
                    )}
                  >
                    {formatCount(count)} {DASHBOARD_STRINGS.failedJobs(count)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Section
        id="dashboard-pool"
        title={DASHBOARD_STRINGS.officePoolTitle}
        intro={DASHBOARD_STRINGS.officePoolIntro}
      >
        {dashboard.officePool.length === 0 ? (
          <p className="text-sm">
            {DASHBOARD_STRINGS.officePoolEmpty}{" "}
            <Link href="/amadeus/accounts" className={LINK_CLASS}>
              {DASHBOARD_STRINGS.officePoolAccountsLink}
            </Link>
          </p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {dashboard.officePool.map((level) => (
              <OfficePool key={level.environment} level={level} />
            ))}
          </div>
        )}
      </Section>

      {showLiveRequests ? <LiveOfficeRequests requests={dashboard.liveOfficeRequests} /> : null}
    </div>
  );
}

/**
 * `/` (README §2): the dashboard of `adminGetDashboard`. OTAs by status, the M5 counters while their switches are on
 * (custom domains waiting for DNS, draft settlements, failed Stripe events, past-due subscriptions; PAD-014), tenant jobs
 * that failed in the last 24 hours, failed BullMQ jobs per platform queue and the Velexis Amadeus office pool of each
 * environment, with a warning below three available offices. Every count is a link to the list it counts, filtered in
 * the URL (`/tenants?status=…`, `/domains?kind=custom&verificationStatus=pending`, `/settlements?status=draft`,
 * `/stripe-events?status=failed`, `/subscriptions?status=past_due`, `/provisioning-jobs?status=failed`,
 * `/queues/<queue>`, `/amadeus/offices?environment=…&status=…`). With a Velexis live account, the live office requests
 * of the same answer follow (`liveOfficeRequests`, FIX-W41-PLATFORM): each OTA whose live connection waits for an
 * office, oldest first, links to its connections, where "Assign office" serves it. The page makes this one call. While
 * Redis is down the API answers `SERVICE_UNAVAILABLE` and the page says so.
 */
export default async function DashboardPage() {
  const api = await platformApi();
  const result = await api.GET("/v1/admin/dashboard");
  if (
    result.error !== undefined &&
    (result.error.code === "UNAUTHENTICATED" || result.error.code === "TOKEN_EXPIRED")
  ) {
    redirect("/sign-in");
  }
  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{DASHBOARD_STRINGS.title}</h1>
        <p className="text-muted-foreground">{DASHBOARD_STRINGS.intro}</p>
      </div>
      {result.error === undefined ? (
        <DashboardView dashboard={result.data} />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{DASHBOARD_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
