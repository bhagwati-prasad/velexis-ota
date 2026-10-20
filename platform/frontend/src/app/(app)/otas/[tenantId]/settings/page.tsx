import type { Metadata } from "next";

import { SettingsForm } from "@/app/(app)/otas/[tenantId]/settings/settings-form";
import { NotAllowed } from "@/components/not-allowed";
import { COUNTRY_CODES, namedOptions, timeZoneOptions } from "@/lib/reference-options";
import { can } from "@/lib/roles";
import { SETTINGS_STRINGS } from "@/lib/strings";
import { requireTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: SETTINGS_STRINGS.title };

/**
 * `/otas/[tenantId]/settings` (README §2 Signed in; PF-13): the OTA profile for owners and admins. The tenant comes
 * from the layout's `getTenant` (the same request's cached answer): another role gets the not-allowed page (the
 * navigation has no entry for it, the API refuses `updateTenant` with `403` all the same). The country and time zone
 * lists are built here, on the server, with the OTA's own zone among them; the form is disabled with the reason
 * while the OTA is not active.
 */
export default async function OtaSettingsPage({
  params,
}: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "editProfile")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }

  return (
    <div className="mx-auto grid max-w-2xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{SETTINGS_STRINGS.title}</h1>
        <p className="text-muted-foreground">{SETTINGS_STRINGS.intro}</p>
      </div>
      <SettingsForm
        tenant={{
          id: tenant.id,
          key: tenant.key,
          defaultCurrency: tenant.defaultCurrency,
          status: tenant.status,
          version: tenant.version,
          name: tenant.name,
          legalName: tenant.legalName,
          supportEmail: tenant.supportEmail,
          countryCode: tenant.countryCode,
          timeZone: tenant.timeZone,
        }}
        countries={namedOptions(COUNTRY_CODES, "region")}
        timeZones={timeZoneOptions(tenant.timeZone)}
      />
    </div>
  );
}
