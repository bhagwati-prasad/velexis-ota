import type { ReactNode } from "react";

import { TenantBanner } from "@/components/tenant-banner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { errorMessage } from "@/lib/errors";
import { OTA_STRINGS } from "@/lib/strings";
import { requireTenant, trialEndForBanner } from "@/lib/tenant";

/**
 * The pages of one OTA, `/otas/[tenantId]/…` (README §2 and §5): loads the OTA once per request (`getTenant`,
 * with the caller's role and the tenant's status) and passes it down: `loadTenant` of `lib/tenant.ts` is a React
 * `cache()`, so the page below reads this layout's answer instead of calling the API again. An OTA the caller is no
 * member of, or an id that is none, renders the not-found page (the API answers both with `404`, so ids cannot be
 * probed); an ended session goes to sign-in and back to the OTA's overview; any other failure shows the portal's
 * message for its code in place of the page.
 *
 * Above every page of the OTA it shows the OTA's notices (`TenantBanner`; PFE-021, PF-74 AC1): a suspension, a failed
 * payment (`past_due`), an ending trial and test mode. For an ending trial, owners and finance members also read how
 * many days are left: the layout then reads the subscription (`loadSubscription`, one call with the billing page of the
 * same request); the other roles and the other notices need no call.
 */
export default async function OtaLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    return (
      <div className="mx-auto grid max-w-xl gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">{OTA_STRINGS.unavailableTitle}</h1>
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(loaded.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const { tenant } = loaded;
  const trialEndsAt = await trialEndForBanner(tenant);
  return (
    <>
      <TenantBanner
        tenant={tenant}
        role={tenant.myRole}
        trialEndsAt={trialEndsAt}
        className="mx-auto mb-8 max-w-4xl"
      />
      {children}
    </>
  );
}
