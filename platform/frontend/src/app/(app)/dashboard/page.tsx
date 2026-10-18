import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createPlatformApi, platformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { membershipHref } from "@/lib/roles";
import { DASHBOARD_STRINGS, ROLE_LABELS } from "@/lib/strings";

export const metadata: Metadata = { title: DASHBOARD_STRINGS.title };

type TenantSummary = components["schemas"]["TenantSummary"];

/** The storefront host of an OTA: `<key>.<STOREFRONT_BASE_DOMAIN>` (README §2 `/dashboard`). */
function storefrontHost(key: string, baseDomain: string): string {
  return `${key}.${baseDomain}`;
}

/**
 * `listPlans`, for the plans' names: public, so the call carries no access token, only the end-user headers of
 * PADR-0019. A failure only costs the names: the dashboard then shows the plan codes.
 */
async function planNames(): Promise<ReadonlyMap<string, string>> {
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  const plans = await api.GET("/v1/plans");
  return new Map((plans.data?.data ?? []).map((plan) => [plan.code, plan.name]));
}

/** One OTA: name (to its set-up page or overview), status, key, plan, the caller's role and its storefront. */
function OtaCard({
  tenant,
  planName,
  baseDomain,
}: {
  readonly tenant: TenantSummary;
  readonly planName: string;
  readonly baseDomain: string;
}) {
  const nameId = `ota-${tenant.id}`;
  const host = storefrontHost(tenant.key, baseDomain);
  return (
    <li className="flex">
      <article
        aria-labelledby={nameId}
        className="flex flex-1 flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id={nameId} className="text-lg font-semibold tracking-tight">
            <Link
              href={membershipHref({ tenantId: tenant.id, tenantStatus: tenant.status })}
              className="underline-offset-4 hover:underline"
            >
              {tenant.name}
            </Link>
          </h2>
          <div className="flex flex-wrap gap-2">
            <StatusBadge kind="tenant" status={tenant.status} />
            {tenant.storefrontEnvironment === "test" ? (
              <Badge variant="outline">{DASHBOARD_STRINGS.testMode}</Badge>
            ) : null}
          </div>
        </div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.key}</dt>
          <dd>{tenant.key}</dd>
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.plan}</dt>
          <dd>{planName}</dd>
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.role}</dt>
          <dd>{ROLE_LABELS[tenant.role]}</dd>
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.storefront}</dt>
          <dd className="min-w-0 break-all">
            <a href={`https://${host}/`} className="underline underline-offset-4">
              {host}
            </a>
          </dd>
        </dl>
      </article>
    </li>
  );
}

/**
 * `/dashboard` (README §2 Signed in): the account's OTAs (`listTenants`, oldest first) with status, plan, the
 * caller's role and the storefront link `https://<key>.<STOREFRONT_BASE_DOMAIN>/`; each name opens the OTA (its
 * set-up page while it is being set up or failed). "Create an OTA" shows only for a verified account (`getMe`); the
 * `(app)` layout already sends unverified accounts to `/verify-pending`, but the page does not rely on it.
 */
export default async function DashboardPage() {
  const settings = getConfig();
  const api = await platformApi();
  const [me, tenants, names] = await Promise.all([api.GET("/v1/me"), api.GET("/v1/tenants"), planNames()]);
  const verified = me.data?.emailVerified === true;

  return (
    <div className="mx-auto grid max-w-5xl gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">{DASHBOARD_STRINGS.title}</h1>
          <p className="text-muted-foreground">{DASHBOARD_STRINGS.intro}</p>
        </div>
        {verified ? (
          <Button asChild>
            <Link href="/otas/new">{DASHBOARD_STRINGS.createOta}</Link>
          </Button>
        ) : null}
      </div>
      {me.data !== undefined && !verified ? (
        // A note, not an alert: nothing went wrong, the account has one step left.
        <p className="rounded-lg border px-4 py-3 text-sm">
          {DASHBOARD_STRINGS.verifyFirst}{" "}
          <Link href="/verify-pending" className="font-medium underline underline-offset-4">
            {DASHBOARD_STRINGS.verifyLink}
          </Link>
        </p>
      ) : null}
      {tenants.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>{DASHBOARD_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(tenants.error)}</AlertDescription>
        </Alert>
      ) : tenants.data.data.length === 0 ? (
        <section aria-labelledby="dashboard-empty" className="grid gap-3 rounded-xl border p-6">
          <h2 id="dashboard-empty" className="text-lg font-semibold tracking-tight">
            {DASHBOARD_STRINGS.emptyTitle}
          </h2>
          {verified ? <p className="text-muted-foreground">{DASHBOARD_STRINGS.empty}</p> : null}
          <p className="text-sm text-muted-foreground">{DASHBOARD_STRINGS.emptyInvited}</p>
        </section>
      ) : (
        <ul aria-label={DASHBOARD_STRINGS.listLabel} className="grid gap-4 md:grid-cols-2">
          {tenants.data.data.map((tenant) => (
            <OtaCard
              key={tenant.id}
              tenant={tenant}
              planName={names.get(tenant.planCode) ?? tenant.planCode}
              baseDomain={settings.STOREFRONT_BASE_DOMAIN}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
