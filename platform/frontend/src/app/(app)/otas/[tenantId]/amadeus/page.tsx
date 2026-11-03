import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { LiveAccessForm } from "@/app/(app)/otas/[tenantId]/amadeus/live-access-form";
import { OwnCredentialsForm } from "@/app/(app)/otas/[tenantId]/amadeus/own-credentials-form";
import { AmadeusSettingsForm } from "@/app/(app)/otas/[tenantId]/amadeus/settings-form";
import { byEnvironment, ConnectionCard, type AmadeusConnection } from "@/components/connection-card";
import { NotAllowed } from "@/components/not-allowed";
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
import { createPlatformApi, platformApi, type ApiResult } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { can, otaPath, type MilestoneFeatures } from "@/lib/roles";
import { AMADEUS_SETTINGS_STRINGS, AMADEUS_STRINGS } from "@/lib/strings";
import { requireTenant, type Tenant } from "@/lib/tenant";

export const metadata: Metadata = { title: AMADEUS_STRINGS.title };

type AmadeusConnectionList = components["schemas"]["AmadeusConnectionList"];
type AutomatedProcess = components["schemas"]["AmadeusAutomatedProcessDefault"];
type Environment = components["schemas"]["Environment"];

const SETTINGS = AMADEUS_SETTINGS_STRINGS;

/**
 * `listAmadeusConnections` (owners, admins and finance members). An ended session goes to sign-in and back to this
 * page, an unverified account to `/verify-pending`, an OTA the caller is no member of (any more) to the not-found
 * page; other failures (a role changed in the meantime, a rate limit, the API down) are returned for the page to show
 * the portal's message.
 */
async function loadConnections(tenantId: string): Promise<ApiResult<AmadeusConnectionList>> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/amadeus-connections", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/amadeus") }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    if (code === "NOT_FOUND") {
      notFound();
    }
  }
  return result;
}

/** Answers of `getMe` that mean the session is over: sign in again. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** Every M5 switch off: what the page assumes when `getMe` fails. */
const NO_FEATURES: MilestoneFeatures = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

/**
 * The milestone switches of PADR-0015 from `getMe` (`features.liveSwitch` for live access, `features.ownAmadeus` for
 * the OTA's own credentials; PFE-023). An ended session goes to sign-in and back to this page, an unverified account to
 * `/verify-pending`; any other failure hides the M5 parts, as a switch that is off does, and the rest of the page stays.
 */
async function loadFeatures(tenantId: string): Promise<MilestoneFeatures> {
  const api = await platformApi();
  const me = await api.GET("/v1/me");
  if (me.error === undefined) {
    return me.data.features;
  }
  if (SESSION_ENDED.has(me.error.code)) {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/amadeus") }).toString()}`);
  }
  if (me.error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
  return NO_FEATURES;
}

/**
 * Whether `listPlans` says the OTA's plan has no live mode (`limits.liveMode` false), so live access is not offered.
 * `listPlans` is public: the call carries no access token, only the end-user headers of PADR-0019. A plan it does not
 * list (not public) or a failed call leaves the decision to the API, which answers `FEATURE_DISABLED` then.
 */
async function planWithoutLiveMode(planCode: string): Promise<boolean> {
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  const plans = await api.GET("/v1/plans");
  const plan = plans.data?.data.find((candidate) => candidate.code === planCode);
  return plan !== undefined && !plan.limits.liveMode;
}

/** The environments of the OTA's own credentials, in the page's order. */
const ENVIRONMENTS: readonly Environment[] = ["test", "live"];

/** A label of `labels`, or the raw value of a newer API the portal has no words for. */
function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

function notSet(): ReactNode {
  return <span className="text-muted-foreground">{SETTINGS.notSet}</span>;
}

/** An automated process in words: "At once, queue 8, category 0, office NCE1A0955, after 2 days, remark “…”". */
function automatedProcessWords(entry: AutomatedProcess): string {
  return SETTINGS.joined([
    labelOf(SETTINGS.automatedCodes, entry.code),
    ...(entry.queue?.number === undefined ? [] : [SETTINGS.viewQueue(entry.queue.number)]),
    ...(entry.queue?.category === undefined ? [] : [SETTINGS.viewCategory(entry.queue.category)]),
    ...(entry.officeId === undefined ? [] : [SETTINGS.viewOffice(entry.officeId)]),
    ...(entry.delay === undefined ? [] : [SETTINGS.viewDelay(entry.delay)]),
    ...(entry.text === undefined || entry.text === "" ? [] : [SETTINGS.viewText(entry.text)]),
  ]);
}

/**
 * The settings of a connection as text, for finance members (PFE-018 step 2): the same values the form edits, without
 * a field or a button. A server component.
 */
function SettingsView({ connection }: { readonly connection: AmadeusConnection }) {
  const { ticketingDefaults: defaults, monitoredQueues } = connection;
  const agreement = defaults.ticketingAgreement;
  const automated = defaults.automatedProcess ?? [];
  const details: { id: string; term: string; value: ReactNode }[] = [
    { id: "defaultOffice", term: SETTINGS.defaultOfficeLabel, value: connection.defaultOfficeId ?? notSet() },
    { id: "queuingOffice", term: SETTINGS.queuingOfficeLabel, value: connection.queuingOfficeId ?? notSet() },
    { id: "ownerOffice", term: SETTINGS.ownerOfficeLabel, value: connection.ownerOfficeId ?? notSet() },
    {
      id: "agreement",
      term: SETTINGS.agreementLabel,
      value:
        agreement === undefined
          ? notSet()
          : SETTINGS.joined([
              labelOf(SETTINGS.agreementOptions, agreement.option),
              ...(agreement.delay === undefined ? [] : [SETTINGS.viewDelay(agreement.delay)]),
            ]),
    },
    {
      id: "issue",
      term: SETTINGS.issueLabel,
      value: defaults.issue === undefined ? notSet() : labelOf(SETTINGS.issueOptions, String(defaults.issue)),
    },
    {
      id: "automatedProcess",
      term: SETTINGS.automatedTitle,
      value:
        automated.length === 0 ? (
          <span className="text-muted-foreground">{SETTINGS.automatedNone}</span>
        ) : (
          <ul className="grid gap-1">
            {automated.map((entry, index) => (
              // The entries have no id of their own; their order is the order Amadeus gets them in, and the list is
              // rendered once on the server.
              <li key={index}>{automatedProcessWords(entry)}</li>
            ))}
          </ul>
        ),
    },
  ];
  return (
    <div className="grid gap-4" data-settings-view="">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        {details.map((detail) => (
          <div key={detail.id} className="contents" data-setting={detail.id}>
            <dt className="text-muted-foreground">{detail.term}</dt>
            <dd className="min-w-0 break-words">{detail.value}</dd>
          </div>
        ))}
      </dl>
      {monitoredQueues.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-setting="monitoredQueues">
          {SETTINGS.queuesNone}
        </p>
      ) : (
        <Table data-setting="monitoredQueues">
          <TableCaption className="sr-only">{SETTINGS.monitoredCaption(connection.environment)}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{SETTINGS.officeLabel}</TableHead>
              <TableHead scope="col">{SETTINGS.queueIdLabel}</TableHead>
              <TableHead scope="col">{SETTINGS.categoryLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {monitoredQueues.map((queue) => (
              <TableRow key={`${queue.officeId}:${queue.queueId}:${queue.category}`}>
                <TableCell>{queue.officeId}</TableCell>
                <TableCell>{queue.queueId}</TableCell>
                <TableCell>{queue.category}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * The settings of one connection (PFE-018; flows/amadeus-connection.md §E; PF-53): owners and admins get the form
 * (`AmadeusSettingsForm`), finance members the same values as text with a note that only owners and admins change them.
 * A connection without an office (still waiting for one) has nothing to choose yet.
 */
function SettingsSection({
  tenant,
  connection,
}: {
  readonly tenant: Tenant;
  readonly connection: AmadeusConnection;
}) {
  const titleId = `amadeus-settings-${connection.environment}-title`;
  const manage = can(tenant.myRole, "manageConnections");
  let content: ReactNode;
  if (connection.officeIds.length === 0) {
    content = <p className="text-sm text-muted-foreground">{SETTINGS.noOffices}</p>;
  } else if (manage) {
    content = (
      <AmadeusSettingsForm
        tenantId={tenant.id}
        labelledBy={titleId}
        connection={connection}
        tenantStatus={tenant.status}
      />
    );
  } else {
    content = (
      <>
        <SettingsView connection={connection} />
        <p className="text-sm text-muted-foreground" data-settings-role-note="">
          {SETTINGS.roleNote}
        </p>
      </>
    );
  }
  return (
    <section
      aria-labelledby={titleId}
      data-amadeus-settings={connection.environment}
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {SETTINGS.title(connection.environment)}
        </h2>
        <p className="text-sm text-muted-foreground">{SETTINGS.intro}</p>
      </div>
      {content}
    </section>
  );
}

/**
 * The live access section and the own credentials sections of the page (PFE-023), as far as the role, the M5 switches
 * and the connections allow them:
 *
 * - **Live access** (`features.liveSwitch`): while the OTA has no live connection, or its live Velexis connection still
 *   waits for an office (the request was made). Owners get the request (unless `listPlans` says the plan has no live
 *   mode), the other roles read that an owner requests it.
 * - **Own credentials** (`features.ownAmadeus`, owners and admins): one section per environment, test then live, each
 *   with the submission being verified and the form behind "Use my own Amadeus credentials". An environment without a
 *   connection has one too: a successful verification creates the connection. The live section also needs
 *   `features.liveSwitch` (the API answers `FEATURE_DISABLED` without it; FIX-W40-PLATFORM, lead decision (2g) of
 *   2026-11-03).
 */
async function m5Sections(
  tenant: Tenant,
  connections: readonly AmadeusConnection[],
  features: MilestoneFeatures,
): Promise<{ readonly live: ReactNode; readonly ownCredentials: ReactNode }> {
  const live = connections.find((connection) => connection.environment === "live");
  const liveRequested =
    live !== undefined &&
    live.credentialSource === "velexis" &&
    live.status === "pending_verification" &&
    live.officeIds.length === 0;
  const isOwner = tenant.myRole === "owner";
  let liveSection: ReactNode = null;
  if (features.liveSwitch && (live === undefined || liveRequested)) {
    // The plan is asked only when the request would be offered.
    const withoutLive =
      isOwner && live === undefined && tenant.status === "active"
        ? await planWithoutLiveMode(tenant.planCode)
        : false;
    liveSection = (
      <LiveAccessForm
        tenantId={tenant.id}
        tenantStatus={tenant.status}
        isOwner={isOwner}
        requested={liveRequested}
        planWithoutLive={withoutLive}
      />
    );
  }
  const ownCredentials =
    features.ownAmadeus && can(tenant.myRole, "manageConnections")
      ? ENVIRONMENTS.filter((environment) => environment === "test" || features.liveSwitch).map(
          (environment) => (
            <OwnCredentialsForm
              key={environment}
              tenantId={tenant.id}
              environment={environment}
              tenantStatus={tenant.status}
              connection={connections.find((connection) => connection.environment === environment) ?? null}
            />
          ),
        )
      : null;
  return { live: liveSection, ownCredentials };
}

/**
 * `/otas/[tenantId]/amadeus` (README §2 Signed in; flows/amadeus-connection.md §B to §E; PF-50 to PF-53): the OTA's
 * Amadeus connections for owners, admins and finance members: one `ConnectionCard` per environment, test first
 * ("Velexis test account, office NCE1A0955, active"), then live access and the OTA's own credentials (M5, PFE-023,
 * `m5Sections`), then the settings of each connection: owners and admins change the default, queuing and owner offices,
 * the ticketing defaults and the monitored queues (`AmadeusSettingsForm`, PFE-018), finance members read them. A
 * Velexis connection still waiting for an office (the pool was empty at set-up, or a live office follows the commercial
 * onboarding) explains it. The tenant comes from the layout's `getTenant` (the same request's cached answer); another
 * role gets the not-allowed page without a call. The connections (`listAmadeusConnections`) and the M5 switches
 * (`getMe`) are read side by side.
 */
export default async function AmadeusPage({ params }: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "viewConnections")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }
  const [connections, features] = await Promise.all([loadConnections(tenant.id), loadFeatures(tenant.id)]);
  const ordered = connections.error === undefined ? byEnvironment(connections.data.data) : [];
  // Without the connections the page cannot tell what the OTA has: the M5 parts wait for a page that has them.
  const m5 =
    connections.error === undefined
      ? await m5Sections(tenant, ordered, features)
      : { live: null, ownCredentials: null };

  return (
    <div className="mx-auto grid max-w-4xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{AMADEUS_STRINGS.title}</h1>
        <p className="text-muted-foreground">{AMADEUS_STRINGS.intro}</p>
      </div>
      {connections.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>{AMADEUS_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(connections.error)}</AlertDescription>
        </Alert>
      ) : ordered.length === 0 ? (
        <p className="text-muted-foreground">{AMADEUS_STRINGS.empty}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {ordered.map((connection) => (
            <ConnectionCard
              key={connection.id}
              kind="amadeus"
              connection={connection}
              timeZone={tenant.timeZone}
            />
          ))}
        </div>
      )}
      {m5.live}
      {m5.ownCredentials}
      {ordered.map((connection) => (
        <SettingsSection key={connection.id} tenant={tenant} connection={connection} />
      ))}
    </div>
  );
}
