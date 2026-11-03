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
import { platformApi, type ApiError, type PlatformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { DASHBOARD_STRINGS, STATUS_LABELS, SUPPLIER_ENVIRONMENT_LABELS, formatCount } from "@/lib/strings";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: DASHBOARD_STRINGS.title };

type Schemas = components["schemas"];
type Dashboard = Schemas["AdminDashboard"];
type TenantStatus = Schemas["TenantStatus"];
type OfficePoolLevel = Schemas["OfficePoolLevel"];
type AmadeusConnection = Schemas["AmadeusConnection"];

/** The statuses of `tenantsByStatus`, in the order of an OTA's life. */
const TENANT_STATUSES: readonly TenantStatus[] = ["provisioning", "active", "suspended", "failed"];

/** Below this many available offices the pool level is a warning (PADR-0012: new OTAs would wait for an office). */
const OFFICE_POOL_LOW = 3;

const ENVIRONMENT_LABELS: Readonly<Record<Schemas["Environment"], string>> = SUPPLIER_ENVIRONMENT_LABELS;

/** The audit action of an owner's live request (`requestLiveAmadeus`, PBE-054): its target is the live connection. */
const LIVE_REQUEST_ACTION = "amadeus.live_requested";
/** The newest live requests read from the audit log (one page of `adminListAudit`). */
const LIVE_REQUEST_AUDIT_LIMIT = 100;
/**
 * The most OTAs whose live connection the dashboard reads (`adminGetTenant` each, in parallel), the newest requests
 * first. The platform has no read of the waiting live connections, so this bounds the calls of one dashboard view; an
 * older request beyond it is in the audit log, which the section links. A page module exports nothing else (Next.js),
 * so domains.test.tsx asserts this number.
 */
const LIVE_REQUEST_CHECKS = 10;

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

/** One OTA whose live Velexis connection waits for an office, as the section shows it. */
interface LiveRequest {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly tenantName: string;
  /** The waiting live connection: the card the link scrolls to on the OTA's page. */
  readonly connectionId: string;
  /** When the owner requested live access (the audit row's time). */
  readonly requestedAt: string;
  /** The owner's optional note of the request. */
  readonly note: string | null;
}

type LiveRequests =
  | { readonly status: "unavailable" }
  | {
      readonly status: "ok";
      /** The waiting requests, newest first. */
      readonly requests: readonly LiveRequest[];
      /** More OTAs requested live access than were checked: the oldest requests are only in the audit log. */
      readonly truncated: boolean;
      /** Requests whose OTA could not be read now (not shown). */
      readonly unchecked: number;
    };

/**
 * The live connection waits for an office: a `velexis` connection of the live environment that is
 * `pending_verification` without an office, as `requestLiveAmadeus` inserts it (flows/amadeus-connection.md §C) and
 * as the OTA page's "Assign office" serves it.
 */
function waitsForLiveOffice(connection: AmadeusConnection): boolean {
  return (
    connection.environment === "live" &&
    connection.credentialSource === "velexis" &&
    connection.status === "pending_verification" &&
    connection.officeIds.length === 0
  );
}

function sessionEnded(error: ApiError): boolean {
  return error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED";
}

/**
 * The live office requests (PAD-014, flows/amadeus-connection.md §C, PF-90) from the existing admin reads, since
 * `AdminDashboard` has no counter of them: the newest `amadeus.live_requested` rows of the audit log (`adminListAudit`;
 * each names its OTA and, as target, the live connection it inserted), then, for the OTAs of the newest
 * `LIVE_REQUEST_CHECKS` requests, `adminGetTenant` to keep the ones whose live connection still waits for an office.
 * A request already served (an office assigned, the connection active), withdrawn into own credentials or disabled is
 * left out. Neither read writes an audit row (they hold no secret and are not personal-data reads of PADR-0006).
 */
async function loadLiveRequests(api: PlatformApi): Promise<LiveRequests> {
  const audit = await api.GET("/v1/admin/audit-log", {
    params: { query: { action: LIVE_REQUEST_ACTION, limit: LIVE_REQUEST_AUDIT_LIMIT } },
  });
  if (audit.error !== undefined) {
    if (sessionEnded(audit.error)) {
      redirect("/sign-in");
    }
    return { status: "unavailable" };
  }
  // The newest request of each OTA (the audit log answers newest first).
  const newest = new Map<string, Schemas["AuditEntry"]>();
  for (const row of audit.data.data) {
    if (row.tenantId !== null && !newest.has(row.tenantId)) {
      newest.set(row.tenantId, row);
    }
  }
  const candidates = [...newest.values()].slice(0, LIVE_REQUEST_CHECKS);
  const checks = await Promise.all(
    candidates.map(async (row) => {
      const tenantId = row.tenantId ?? "";
      const detail = await api.GET("/v1/admin/tenants/{tenantId}", { params: { path: { tenantId } } });
      return { row, detail };
    }),
  );
  const requests: LiveRequest[] = [];
  let unchecked = 0;
  for (const { row, detail } of checks) {
    if (detail.error !== undefined) {
      if (sessionEnded(detail.error)) {
        redirect("/sign-in");
      }
      // An OTA that no longer exists has nothing to serve; any other failure is counted and said.
      if (detail.error.code !== "NOT_FOUND") {
        unchecked += 1;
      }
      continue;
    }
    const waiting = detail.data.amadeusConnections.filter(waitsForLiveOffice);
    // The request's own connection when it is still waiting; else any live connection of the OTA that waits.
    const connection = waiting.find((candidate) => candidate.id === row.targetId) ?? waiting[0];
    if (connection === undefined) {
      continue;
    }
    const note = row.details["note"];
    requests.push({
      tenantId: detail.data.tenant.id,
      tenantKey: detail.data.tenant.key,
      tenantName: detail.data.tenant.name,
      connectionId: connection.id,
      requestedAt: row.createdAt,
      note: typeof note === "string" && note.trim() !== "" ? note : null,
    });
  }
  return {
    status: "ok",
    requests,
    truncated: audit.data.page.nextCursor !== null || newest.size > LIVE_REQUEST_CHECKS,
    unchecked,
  };
}

/** The OTA's page on the connections tab, at the card of the waiting live connection, where "Assign office" is. */
function assignOfficeHref(request: LiveRequest): string {
  return `/tenants/${encodeURIComponent(request.tenantId)}?tab=connections#connection-${encodeURIComponent(request.connectionId)}`;
}

function LiveOfficeRequests({ liveRequests }: { readonly liveRequests: LiveRequests }) {
  const auditHref = filtered("/audit", { action: LIVE_REQUEST_ACTION });
  return (
    <Section
      id="dashboard-live-requests"
      title={DASHBOARD_STRINGS.liveRequestsTitle}
      intro={DASHBOARD_STRINGS.liveRequestsIntro}
    >
      {liveRequests.status === "unavailable" ? (
        <Alert data-notice="live-requests-unavailable">
          <AlertDescription>{DASHBOARD_STRINGS.liveRequestsUnavailable}</AlertDescription>
        </Alert>
      ) : (
        <>
          {liveRequests.requests.length === 0 ? (
            <p className="text-sm">{DASHBOARD_STRINGS.liveRequestsEmpty}</p>
          ) : (
            <Table>
              <TableCaption className="sr-only">{DASHBOARD_STRINGS.liveRequestsCaption}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{DASHBOARD_STRINGS.liveRequestOta}</TableHead>
                  <TableHead scope="col">{DASHBOARD_STRINGS.liveRequestRequested}</TableHead>
                  <TableHead scope="col">{DASHBOARD_STRINGS.liveRequestNote}</TableHead>
                  <TableHead scope="col">{DASHBOARD_STRINGS.liveRequestAction}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {liveRequests.requests.map((request) => (
                  <TableRow key={request.tenantId} data-tenant-id={request.tenantId}>
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
                      {request.note === null ? (
                        <span className="text-muted-foreground">{DASHBOARD_STRINGS.liveRequestNoNote}</span>
                      ) : (
                        <span className="block max-w-sm break-words whitespace-pre-wrap">{request.note}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link href={assignOfficeHref(request)} className={LINK_CLASS}>
                        {DASHBOARD_STRINGS.assignOffice}
                        <span className="sr-only">
                          {DASHBOARD_STRINGS.assignOfficeFor(request.tenantName)}
                        </span>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {liveRequests.unchecked > 0 ? (
            <p className="text-sm" data-notice="live-requests-unchecked">
              {DASHBOARD_STRINGS.liveRequestsUnchecked(liveRequests.unchecked)}
            </p>
          ) : null}
          {liveRequests.truncated ? (
            <p className="text-sm" data-notice="live-requests-truncated">
              {DASHBOARD_STRINGS.liveRequestsTruncated(LIVE_REQUEST_CHECKS)}{" "}
              <Link href={auditHref} className={LINK_CLASS}>
                {DASHBOARD_STRINGS.liveRequestsAuditLink}
              </Link>
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}

function DashboardView({
  dashboard,
  liveRequests,
}: {
  readonly dashboard: Dashboard;
  /** `undefined` without a Velexis live account: no OTA can have requested live access then. */
  readonly liveRequests: LiveRequests | undefined;
}) {
  const queues = Object.entries(dashboard.jobsFailedByQueue);
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

      {liveRequests === undefined ? null : <LiveOfficeRequests liveRequests={liveRequests} />}
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
 * follow (PAD-014, `loadLiveRequests`): each OTA whose live connection waits for an office links to its connections,
 * where "Assign office" serves it. While Redis is down the API answers `SERVICE_UNAVAILABLE` and the page says so.
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
  // Only a Velexis live account takes live requests (`live_account_missing` otherwise), and `officePool` lists the
  // environment of every account: without a live one there is nothing to look for.
  const liveRequests =
    result.error === undefined && result.data.officePool.some((level) => level.environment === "live")
      ? await loadLiveRequests(api)
      : undefined;
  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{DASHBOARD_STRINGS.title}</h1>
        <p className="text-muted-foreground">{DASHBOARD_STRINGS.intro}</p>
      </div>
      {result.error === undefined ? (
        <DashboardView dashboard={result.data} liveRequests={liveRequests} />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{DASHBOARD_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
