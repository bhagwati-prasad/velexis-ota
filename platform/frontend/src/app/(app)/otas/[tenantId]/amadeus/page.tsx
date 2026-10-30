import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

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
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { AMADEUS_SETTINGS_STRINGS, AMADEUS_STRINGS } from "@/lib/strings";
import { requireTenant, type Tenant } from "@/lib/tenant";

export const metadata: Metadata = { title: AMADEUS_STRINGS.title };

type AmadeusConnectionList = components["schemas"]["AmadeusConnectionList"];
type AutomatedProcess = components["schemas"]["AmadeusAutomatedProcessDefault"];

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
 * `/otas/[tenantId]/amadeus` (README §2 Signed in; flows/amadeus-connection.md §B and §E; PF-50, PF-53): the OTA's
 * Amadeus connections for owners, admins and finance members: one `ConnectionCard` per environment, test first
 * ("Velexis test account, office NCE1A0955, active"), then the settings of each connection: owners and admins change the
 * default, queuing and owner offices, the ticketing defaults and the monitored queues (`AmadeusSettingsForm`, PFE-018),
 * finance members read them. A Velexis connection still waiting for an office (the pool was empty at set-up) explains
 * that Velexis assigns one soon. The tenant comes from the layout's `getTenant` (the same request's cached answer);
 * another role gets the not-allowed page without a call. Live access and the OTA's own credentials come with PFE-023.
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
  const connections = await loadConnections(tenant.id);

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
      ) : connections.data.data.length === 0 ? (
        <p className="text-muted-foreground">{AMADEUS_STRINGS.empty}</p>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {byEnvironment(connections.data.data).map((connection) => (
              <ConnectionCard
                key={connection.id}
                kind="amadeus"
                connection={connection}
                timeZone={tenant.timeZone}
              />
            ))}
          </div>
          {byEnvironment(connections.data.data).map((connection) => (
            <SettingsSection key={connection.id} tenant={tenant} connection={connection} />
          ))}
        </>
      )}
    </div>
  );
}
