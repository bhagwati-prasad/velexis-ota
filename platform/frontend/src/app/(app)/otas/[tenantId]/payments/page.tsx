import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DescriptorForm } from "@/app/(app)/otas/[tenantId]/payments/descriptor-form";
import { byEnvironment, ConnectionCard, type PaymentConnection } from "@/components/connection-card";
import { NotAllowed } from "@/components/not-allowed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { DESCRIPTOR_STRINGS, PAYMENTS_STRINGS } from "@/lib/strings";
import { requireTenant, type Tenant } from "@/lib/tenant";

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
 * What a Velexis-mode card adds for the caller (PFE-016; flows/stripe-payments-account.md §A item 3): owners and admins
 * the statement suffix form, finance members a note that only owners and admins change it (they read the suffix in the
 * card's details). Cards of the OTA's own Stripe account (M5) add nothing: the OTA backend sends no suffix for them.
 */
function descriptorPart(tenant: Tenant, connection: PaymentConnection) {
  if (connection.accountMode !== "velexis") {
    return null;
  }
  if (!can(tenant.myRole, "manageConnections")) {
    return (
      <p className="text-sm text-muted-foreground" data-descriptor-role-note="">
        {DESCRIPTOR_STRINGS.roleNote}
      </p>
    );
  }
  return (
    <DescriptorForm
      tenantId={tenant.id}
      environment={connection.environment}
      version={connection.version}
      suffix={connection.statementDescriptorSuffix}
      tenantStatus={tenant.status}
    />
  );
}

/**
 * `/otas/[tenantId]/payments` (README §2 Signed in; flows/stripe-payments-account.md §A; PF-60): the OTA's Stripe
 * connections for owners, admins and finance members: one `ConnectionCard` per environment, test first ("Velexis Stripe
 * account, test, active"), with the account mode, the card statement suffix and, for the OTA's own account (M5), its
 * capabilities. On each Velexis-mode card owners and admins change the suffix (`DescriptorForm`, PFE-016) with a preview
 * of the card statement line; finance members read it. The tenant comes from the layout's `getTenant` (the same
 * request's cached answer); another role gets the not-allowed page without a call. Stripe Connect, API keys and the way
 * back to Velexis payments come with PFE-024, payout account and settlements with PFE-025.
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
            >
              {descriptorPart(tenant, connection)}
            </ConnectionCard>
          ))}
        </div>
      )}
    </div>
  );
}
