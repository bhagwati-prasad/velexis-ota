import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DateTime } from "@/components/date-time";
import { DnsRecordsTable, type Domain } from "@/components/dns-records-table";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { platformApi, type ApiError, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { DOMAINS_STRINGS } from "@/lib/strings";
import { isTenantId, requireTenant } from "@/lib/tenant";

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

/**
 * `/otas/[tenantId]/domains` (README §2 Signed in; PF-40): the storefront addresses of the OTA, for every member.
 * The Velexis sub-domain `<key>.<STOREFRONT_BASE_DOMAIN>` comes first, created verified and primary with the OTA, as a
 * link to the storefront. The custom domains (M5) show only while `features.customDomains` is on, each with its DNS
 * records and last check (`DnsRecordsTable`); adding, checking, making primary and removing them come with PFE-022.
 * The tenant comes from the layout's `getTenant`, the domains from `listDomains` and the switch from `getMe`, side by
 * side. A list that cannot be loaded shows the portal's message in its place.
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

      {domains?.data === undefined ? null : (
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
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {customOn && domains?.data !== undefined ? (
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
                <li
                  key={domain.id}
                  data-domain={domain.hostname}
                  className="grid gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
                >
                  <DomainHeading domain={domain} />
                  <DnsRecordsTable domain={domain} timeZone={tenant.timeZone} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
