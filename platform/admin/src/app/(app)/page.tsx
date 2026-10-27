import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { toneClasses } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

function DashboardView({ dashboard }: { readonly dashboard: Dashboard }) {
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
            <Link href="/amadeus/accounts" className="font-medium underline underline-offset-4">
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
    </div>
  );
}

/**
 * `/` (README §2): the dashboard of `adminGetDashboard`. OTAs by status, tenant jobs that failed in the last 24 hours,
 * failed BullMQ jobs per platform queue and the Velexis Amadeus office pool of each environment, with a warning below
 * three available offices. Every count is a link to the list it counts, filtered in the URL (`/tenants?status=…`,
 * `/provisioning-jobs?status=failed`, `/queues/<queue>`, `/amadeus/offices?environment=…&status=…`). The M5 counters
 * (always `null` in M1) and the live office requests arrive with PAD-014. While Redis is down the API answers
 * `SERVICE_UNAVAILABLE` and the page says so.
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
