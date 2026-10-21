import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { byEnvironment, ConnectionCard } from "@/components/connection-card";
import { NotAllowed } from "@/components/not-allowed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { AMADEUS_STRINGS } from "@/lib/strings";
import { requireTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: AMADEUS_STRINGS.title };

type AmadeusConnectionList = components["schemas"]["AmadeusConnectionList"];

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

/**
 * `/otas/[tenantId]/amadeus` (README §2 Signed in; flows/amadeus-connection.md §B; PF-50): the OTA's Amadeus
 * connections for owners, admins and finance members, read-only: one `ConnectionCard` per environment, test first
 * ("Velexis test account, office NCE1A0955, active"). A Velexis connection still waiting for an office (the pool was
 * empty at set-up) explains that Velexis assigns one soon. The tenant comes from the layout's `getTenant` (the same
 * request's cached answer); another role gets the not-allowed page without a call. Live access and the OTA's own
 * credentials come with PFE-023, the office settings with M4.
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
      )}
    </div>
  );
}
