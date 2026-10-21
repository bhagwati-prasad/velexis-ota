import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { byEnvironment, ConnectionCard } from "@/components/connection-card";
import { NotAllowed } from "@/components/not-allowed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { PAYMENTS_STRINGS } from "@/lib/strings";
import { requireTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: PAYMENTS_STRINGS.title };

type PaymentConnectionList = components["schemas"]["PaymentConnectionList"];

/**
 * `listPaymentConnections` (owners, admins and finance members). An ended session goes to sign-in and back to this
 * page, an unverified account to `/verify-pending`, an OTA the caller is no member of (any more) to the not-found
 * page; other failures (a role changed in the meantime, a rate limit, the API down) are returned for the page to show
 * the portal's message.
 */
async function loadConnections(tenantId: string): Promise<ApiResult<PaymentConnectionList>> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/payment-connections", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/payments") }).toString()}`);
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
 * `/otas/[tenantId]/payments` (README §2 Signed in; flows/stripe-payments-account.md §A; PF-60): the OTA's Stripe
 * connections for owners, admins and finance members, read-only: one `ConnectionCard` per environment, test first
 * ("Velexis Stripe account, test, active"), with the account mode, the card statement suffix and, for the OTA's own
 * account (M5), its capabilities. The tenant comes from the layout's `getTenant` (the same request's cached answer);
 * another role gets the not-allowed page without a call. The descriptor suffix edit comes with M3, Stripe Connect,
 * API keys and the way back to Velexis payments with PFE-024, payout account and settlements with PFE-025.
 */
export default async function PaymentsPage({ params }: Readonly<{ params: Promise<{ tenantId: string }> }>) {
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
        <h1 className="text-3xl font-semibold tracking-tight">{PAYMENTS_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAYMENTS_STRINGS.intro}</p>
      </div>
      {connections.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>{PAYMENTS_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(connections.error)}</AlertDescription>
        </Alert>
      ) : connections.data.data.length === 0 ? (
        <p className="text-muted-foreground">{PAYMENTS_STRINGS.empty}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {byEnvironment(connections.data.data).map((connection) => (
            <ConnectionCard
              key={connection.id}
              kind="payment"
              connection={connection}
              timeZone={tenant.timeZone}
            />
          ))}
        </div>
      )}
    </div>
  );
}
