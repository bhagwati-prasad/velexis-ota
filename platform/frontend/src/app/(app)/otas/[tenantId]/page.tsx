import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";

import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { ConsoleLaunchNotice, OpenConsoleButton, consoleProblemOf } from "@/components/open-console-button";
import { StatusBadge } from "@/components/status-badge";
import { TenantBanner } from "@/components/tenant-banner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { NAV_LABELS, OTA_DASHBOARD_STRINGS, ROLE_LABELS } from "@/lib/strings";
import { isTenantId, requireTenant, type Tenant } from "@/lib/tenant";

export const metadata: Metadata = { title: NAV_LABELS.overview };

type OnboardingChecklistAnswer = components["schemas"]["OnboardingChecklist"];

/**
 * `getOnboarding` for the OTA (PADR-0018): computed by the API on every call, for the caller. It runs next to the
 * tenant's load; an id that is no OTA id makes no call (the tenant's load renders the not-found page for it).
 */
async function loadOnboarding(tenantId: string): Promise<ApiResult<OnboardingChecklistAnswer> | undefined> {
  if (!isTenantId(tenantId)) {
    return undefined;
  }
  const api = await platformApi();
  return api.GET("/v1/tenants/{tenantId}/onboarding", { params: { path: { tenantId } } });
}

/** A notice for an OTA that is still being set up or whose set-up failed, with the way to its set-up page. */
function SetupNotice({ tenant }: { readonly tenant: Tenant }) {
  if (tenant.status !== "provisioning" && tenant.status !== "failed") {
    return null;
  }
  return (
    <p className="rounded-lg border px-4 py-3 text-sm" data-notice="setup">
      {tenant.status === "provisioning"
        ? OTA_DASHBOARD_STRINGS.setupInProgress
        : OTA_DASHBOARD_STRINGS.setupFailed}{" "}
      <Link href={otaPath(tenant.id, "/setup")} className="font-medium underline underline-offset-4">
        {OTA_DASHBOARD_STRINGS.setupLink}
      </Link>
    </p>
  );
}

/**
 * `/otas/[tenantId]` (README §2 Signed in; PF-12): the OTA dashboard for every member. It shows the OTA's name,
 * status and notices (`TenantBanner`: suspended with its reason and, for a billing suspension, the billing link;
 * `billing_notice`; test mode), the storefront link `https://<primaryHost>/`, the OTA's key, the caller's role, and
 * the onboarding checklist of `getOnboarding`, each item linking to its page. The tenant comes from the layout's
 * `getTenant` (the same request's cached answer); "Edit the OTA profile" shows only to roles that may edit it.
 * "Open console" (PFE-017) posts to the launch route handler; when a launch was refused, the handler comes back here
 * with `?console=<problem>` and the page says why (`ConsoleLaunchNotice`: a suspension with its reason and, for a
 * billing suspension, the billing link; set-up; the rate limit; an unavailable API).
 */
export default async function OtaDashboardPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tenantId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { tenantId } = await params;
  const [loaded, onboarding, query] = await Promise.all([
    requireTenant(tenantId),
    loadOnboarding(tenantId),
    searchParams ?? Promise.resolve({}),
  ]);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  const role = tenant.myRole;
  const storefrontUrl = `https://${tenant.primaryHost}/`;
  const consoleFailure = consoleProblemOf(query);

  return (
    <div className="mx-auto grid max-w-4xl gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">{tenant.name}</h1>
            {/* Test mode is a notice of the banner below, with what it means. */}
            <StatusBadge kind="tenant" status={tenant.status} />
          </div>
          <p className="text-muted-foreground">{OTA_DASHBOARD_STRINGS.intro}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can(role, "editProfile") ? (
            <Button asChild variant="outline">
              <Link href={otaPath(tenant.id, "/settings")}>{OTA_DASHBOARD_STRINGS.editProfile}</Link>
            </Button>
          ) : null}
          {can(role, "openConsole") ? <OpenConsoleButton tenantId={tenant.id} /> : null}
        </div>
      </div>

      {consoleFailure === undefined ? null : (
        <ConsoleLaunchNotice failure={consoleFailure} tenantId={tenant.id} role={role} />
      )}
      <TenantBanner tenant={tenant} role={role} />
      <SetupNotice tenant={tenant} />

      <div className="grid gap-4 md:grid-cols-2">
        <section
          aria-labelledby="ota-storefront"
          className="grid content-start gap-2 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
        >
          <h2 id="ota-storefront" className="text-lg font-semibold tracking-tight">
            {OTA_DASHBOARD_STRINGS.storefrontTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{OTA_DASHBOARD_STRINGS.storefrontIntro}</p>
          <p className="min-w-0 break-all">
            <a href={storefrontUrl} className="font-medium underline underline-offset-4">
              {tenant.primaryHost}
            </a>
          </p>
          {tenant.status === "provisioning" || tenant.status === "failed" ? (
            <p className="text-sm text-muted-foreground">{OTA_DASHBOARD_STRINGS.storefrontPending}</p>
          ) : null}
        </section>
        <section
          aria-labelledby="ota-details"
          className="grid content-start gap-3 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
        >
          <h2 id="ota-details" className="text-lg font-semibold tracking-tight">
            {OTA_DASHBOARD_STRINGS.detailsLabel}
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{OTA_DASHBOARD_STRINGS.key}</dt>
            <dd>{tenant.key}</dd>
            <dt className="text-muted-foreground">{OTA_DASHBOARD_STRINGS.role}</dt>
            <dd>{ROLE_LABELS[role]}</dd>
            <dt className="text-muted-foreground">{OTA_DASHBOARD_STRINGS.defaultCurrency}</dt>
            <dd>{tenant.defaultCurrency}</dd>
          </dl>
        </section>
      </div>

      {onboarding === undefined ? null : onboarding.error === undefined ? (
        <OnboardingChecklist items={onboarding.data.items} />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{OTA_DASHBOARD_STRINGS.checklistUnavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(onboarding.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
