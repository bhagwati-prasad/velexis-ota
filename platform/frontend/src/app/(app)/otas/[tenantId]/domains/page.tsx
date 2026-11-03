import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AddDomainForm } from "@/app/(app)/otas/[tenantId]/domains/add-domain-form";
import {
  DomainActions,
  DomainActionsProvider,
  UpgradeHint,
} from "@/app/(app)/otas/[tenantId]/domains/domain-actions";
import { DateTime } from "@/components/date-time";
import { DnsRecordsTable, type Domain } from "@/components/dns-records-table";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { createPlatformApi, platformApi, type ApiError, type ApiResult } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { DOMAINS_STRINGS, TLS_STATUS_NOTES } from "@/lib/strings";
import { isTenantId, requireTenant, type Tenant } from "@/lib/tenant";

export const metadata: Metadata = { title: DOMAINS_STRINGS.title };

type DomainList = components["schemas"]["DomainList"];
type Account = components["schemas"]["Account"];

/**
 * `listDomains` (any member) for the OTA, next to the tenant's load; an id that is no OTA id makes no call (the
 * tenant's load renders the not-found page for it).
 */
async function loadDomains(tenantId: string): Promise<ApiResult<DomainList> | undefined> {
  if (!isTenantId(tenantId)) {
    return undefined;
  }
  const api = await platformApi();
  return api.GET("/v1/tenants/{tenantId}/domains", { params: { path: { tenantId } } });
}

/** `getMe`, for the milestone switch of the custom domains (`features.customDomains`, PADR-0015). */
async function loadAccount(tenantId: string): Promise<ApiResult<Account> | undefined> {
  if (!isTenantId(tenantId)) {
    return undefined;
  }
  const api = await platformApi();
  return api.GET("/v1/me");
}

/**
 * The number of custom domains the OTA's plan allows (`limits.customDomains` of `listPlans`; 0 means none). `listPlans`
 * is public: the call carries no access token, only the end-user headers of PADR-0019. A plan it does not list (not
 * public) or a failed call answers `undefined` and leaves the decision to the API (`FEATURE_DISABLED`,
 * `PLAN_LIMIT_REACHED`), whose answer the form shows.
 */
async function customDomainLimit(planCode: string): Promise<number | undefined> {
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  const plans = await api.GET("/v1/plans");
  return plans.data?.data.find((candidate) => candidate.code === planCode)?.limits.customDomains;
}

/** Answers that mean the session is over: sign in again. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/**
 * An ended session goes to sign-in and back to the domains page, an unverified account to `/verify-pending`, and an
 * OTA the caller is no member of (any more) to the not-found page.
 */
function leaveOnSessionEnd(error: ApiError | undefined, tenantId: string): void {
  if (error === undefined) {
    return;
  }
  if (SESSION_ENDED.has(error.code)) {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/domains") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
  if (error.code === "NOT_FOUND") {
    notFound();
  }
}

/** A host name as the API answers it (lower case, dot-separated labels), the only kind the page links to. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The storefront address of a domain: a link to `https://<hostname>/` once the domain is verified (a domain still
 * being verified does not lead to the storefront yet), otherwise, or when the name is no host name, plain text.
 */
function Address({ domain }: { readonly domain: Domain }) {
  return domain.verificationStatus === "verified" && HOSTNAME.test(domain.hostname) ? (
    <a href={`https://${domain.hostname}/`} className="font-medium break-all underline underline-offset-4">
      {domain.hostname}
    </a>
  ) : (
    <span className="font-medium break-all">{domain.hostname}</span>
  );
}

/** The address of a domain with its badges: primary, and its verification status in words. */
function DomainHeading({ domain }: { readonly domain: Domain }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Address domain={domain} />
      {domain.isPrimary ? (
        <Badge variant="outline" data-primary="">
          {DOMAINS_STRINGS.primary}
        </Badge>
      ) : null}
      <StatusBadge kind="domain" status={domain.verificationStatus} />
    </div>
  );
}

/** The words of a certificate status; a status the portal does not know yet has none (its badge still shows it). */
function tlsNote(status: string): string | undefined {
  return Object.hasOwn(TLS_STATUS_NOTES, status) ? TLS_STATUS_NOTES[status] : undefined;
}

/**
 * The certificate of a verified custom domain (flows/custom-domains.md step 4; PF-41 AC3): its status in words
 * (`tlsStatus`, which the TLS probe sets after verification and every day) and its expiry (`tlsExpiresAt`) in the OTA's
 * time zone. Caddy renews certificates itself; the page reports what the probe found.
 */
function TlsDetails({ domain, timeZone }: { readonly domain: Domain; readonly timeZone: string }) {
  const note = tlsNote(domain.tlsStatus);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm" data-tls={domain.tlsStatus}>
      <div className="contents" data-tls-detail="status">
        <dt className="text-muted-foreground">{DOMAINS_STRINGS.tlsLabel}</dt>
        <dd className="grid justify-items-start gap-1">
          <StatusBadge kind="tls" status={domain.tlsStatus} />
          {note === undefined ? null : <span className="text-muted-foreground">{note}</span>}
        </dd>
      </div>
      {domain.tlsExpiresAt === null ? null : (
        <div className="contents" data-tls-detail="expiresAt">
          <dt className="text-muted-foreground">
            {domain.tlsStatus === "expired" ? DOMAINS_STRINGS.tlsExpired : DOMAINS_STRINGS.tlsExpires}
          </dt>
          <dd>
            <DateTime value={domain.tlsExpiresAt} timeZone={timeZone} />
          </dd>
        </div>
      )}
    </dl>
  );
}

/** One custom domain: its heading, why it failed, its records and last check, its certificate, and its actions. */
function CustomDomainItem({
  domain,
  tenant,
  writable,
}: {
  readonly domain: Domain;
  readonly tenant: Tenant;
  readonly writable: boolean;
}) {
  return (
    <li
      data-domain={domain.hostname}
      className="grid gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <DomainHeading domain={domain} />
      {domain.verificationStatus === "failed" ? (
        <p className="text-sm" data-failed-note="">
          {can(tenant.myRole, "manageDomains")
            ? DOMAINS_STRINGS.failedNote
            : DOMAINS_STRINGS.failedNoteReadOnly}
        </p>
      ) : null}
      <DnsRecordsTable domain={domain} timeZone={tenant.timeZone} />
      {domain.verificationStatus === "verified" ? (
        <TlsDetails domain={domain} timeZone={tenant.timeZone} />
      ) : null}
      {writable ? <DomainActions domain={domain} /> : null}
    </li>
  );
}

/**
 * "Add a custom domain" for owners and admins: the add form, or why there is none (the OTA is not active, `listPlans`
 * says the plan has no custom domains, or the plan's limit is reached).
 */
function AddSection({
  tenant,
  limit,
  customCount,
}: {
  readonly tenant: Tenant;
  readonly limit: number | undefined;
  readonly customCount: number;
}) {
  const isOwner = tenant.myRole === "owner";
  let content: ReactNode;
  if (tenant.status !== "active") {
    content = (
      <Alert data-read-only="">
        <AlertTitle>{DOMAINS_STRINGS.readOnlyTitle}</AlertTitle>
        <AlertDescription>{DOMAINS_STRINGS.readOnly[tenant.status]}</AlertDescription>
      </Alert>
    );
  } else if (limit === 0) {
    content = (
      <Alert data-upgrade-hint="">
        <AlertTitle>{DOMAINS_STRINGS.upgradeTitle}</AlertTitle>
        <AlertDescription>
          <p>
            <UpgradeHint tenantId={tenant.id} isOwner={isOwner} />
          </p>
        </AlertDescription>
      </Alert>
    );
  } else {
    // A full plan shows its limit in the form's place; the form stays mounted for it, so the records of the add that
    // filled the plan stay in view after the revalidation that counts the new domain.
    content = (
      <AddDomainForm
        tenantId={tenant.id}
        isOwner={isOwner}
        timeZone={tenant.timeZone}
        limitReached={limit !== undefined && customCount >= limit ? limit : undefined}
      />
    );
  }
  return (
    <section
      aria-labelledby="add-domain-title"
      className="grid gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
      data-section="add"
    >
      <div className="grid gap-1">
        <h3 id="add-domain-title" className="text-lg font-semibold tracking-tight">
          {DOMAINS_STRINGS.addTitle}
        </h3>
        <p className="text-sm text-muted-foreground">{DOMAINS_STRINGS.addIntro}</p>
      </div>
      {content}
    </section>
  );
}

/**
 * `/otas/[tenantId]/domains` (README §2 Signed in; flows/custom-domains.md; PF-40, PF-41): the storefront addresses
 * of the OTA, for every member. The Velexis sub-domain `<key>.<STOREFRONT_BASE_DOMAIN>` comes first, created verified
 * and primary with the OTA, as a link to the storefront. The custom domains (M5) show only while
 * `features.customDomains` is on, each with its status, its DNS records and last check (`DnsRecordsTable`), and once
 * verified its certificate's status and expiry (PFE-022).
 *
 * Owners and admins of an active OTA also change them (`DomainActionsProvider`, `DomainActions`, `AddDomainForm`):
 * "Add domain" (unless `listPlans` says the plan has none, which shows the upgrade hint, or its limit is reached),
 * "Check now" for a pending or failed domain, "Make primary" for a verified domain (and for the sub-domain whenever a
 * custom domain is primary: going back to it needs neither the switch nor the plan), and "Remove" behind
 * `ConfirmDialog`. While the OTA is not active its domains are read-only, and the page says why (PADR-0014 item 5).
 *
 * The tenant comes from the layout's `getTenant`, the domains from `listDomains` and the switch from `getMe`, side by
 * side; `listPlans` follows only when the add form would be offered. A list that cannot be loaded shows the portal's
 * message in its place.
 */
export default async function DomainsPage({ params }: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const [loaded, domains, account] = await Promise.all([
    requireTenant(tenantId),
    loadDomains(tenantId),
    loadAccount(tenantId),
  ]);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  leaveOnSessionEnd(domains?.error, tenant.id);
  leaveOnSessionEnd(account?.error, tenant.id);
  const list = domains?.data?.data ?? [];
  const subdomains = list.filter((domain) => domain.kind === "subdomain");
  const customDomains = list.filter((domain) => domain.kind !== "subdomain");
  // A failed getMe hides the custom domains, as the switch being off does.
  const customOn = account?.data?.features.customDomains === true;
  const manage = can(tenant.myRole, "manageDomains");
  const writable = manage && tenant.status === "active";
  // The plan is asked only when the add form would be offered.
  const limit =
    customOn && writable && domains?.data !== undefined
      ? await customDomainLimit(tenant.planCode)
      : undefined;

  const lists =
    domains?.data === undefined ? null : (
      <>
        <section aria-labelledby="domains-subdomain" className="grid gap-4" data-section="subdomain">
          <div className="grid gap-1">
            <h2 id="domains-subdomain" className="text-xl font-semibold tracking-tight">
              {DOMAINS_STRINGS.subdomainTitle}
            </h2>
            <p className="text-sm text-muted-foreground">{DOMAINS_STRINGS.subdomainIntro}</p>
          </div>
          {subdomains.length === 0 ? (
            <p className="text-sm text-muted-foreground">{DOMAINS_STRINGS.subdomainMissing}</p>
          ) : (
            <ul className="grid gap-3">
              {subdomains.map((domain) => (
                <li
                  key={domain.id}
                  data-domain={domain.hostname}
                  className="grid gap-2 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
                >
                  <DomainHeading domain={domain} />
                  <p className="text-sm text-muted-foreground">
                    {DOMAINS_STRINGS.added}{" "}
                    <DateTime value={domain.createdAt} mode="date" timeZone={tenant.timeZone} />
                  </p>
                  {writable ? <DomainActions domain={domain} /> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {customOn ? (
          <section aria-labelledby="domains-custom" className="grid gap-4" data-section="custom">
            <div className="grid gap-1">
              <h2 id="domains-custom" className="text-xl font-semibold tracking-tight">
                {DOMAINS_STRINGS.customTitle}
              </h2>
              <p className="text-sm text-muted-foreground">{DOMAINS_STRINGS.customIntro}</p>
            </div>
            {customDomains.length === 0 ? (
              <p className="text-sm text-muted-foreground">{DOMAINS_STRINGS.customEmpty}</p>
            ) : (
              <ul className="grid gap-3">
                {customDomains.map((domain) => (
                  <CustomDomainItem key={domain.id} domain={domain} tenant={tenant} writable={writable} />
                ))}
              </ul>
            )}
            {manage ? <AddSection tenant={tenant} limit={limit} customCount={customDomains.length} /> : null}
          </section>
        ) : null}
      </>
    );

  return (
    <div className="mx-auto grid max-w-4xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{DOMAINS_STRINGS.title}</h1>
        <p className="text-muted-foreground">{DOMAINS_STRINGS.intro}</p>
      </div>

      {domains?.error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{DOMAINS_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(domains.error)}</AlertDescription>
        </Alert>
      )}

      {writable && lists !== null ? (
        <DomainActionsProvider tenantId={tenant.id} isOwner={tenant.myRole === "owner"}>
          <div className="grid gap-8">{lists}</div>
        </DomainActionsProvider>
      ) : (
        lists
      )}
    </div>
  );
}
