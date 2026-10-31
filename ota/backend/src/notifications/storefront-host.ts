// The storefront host of a tenant's links (OBE-080; ADR-0018 "Custom domain lifecycle" steps 4 and 5, PADR-0004 items
// 7 and 8, OADR-0015 point 5): the origin every absolute URL on the tenant's storefront starts with, and the only place
// that decides it.
//
//   primary origin   https://<host> of the tenant's primary custom storefront domain: verified, primary and with an
//                    issued certificate (`tls_status = issued`, the platform's TLS probe), while the tenant is
//                    `active`; else its sub-domain https://<key>.<STOREFRONT_BASE_DOMAIN>
//
// The certificate condition is lead decision (2e) of 2026-10-31, second batch (FIX-W38-OTA): a custom domain made
// primary before Caddy holds its certificate (`pending`), or whose certificate the probe found `failed` or `expired`,
// is never linked, so no e-mail or page sends a traveller to a host that cannot answer over HTTPS; the sub-domain,
// which always serves, is linked meanwhile. A custom domain is served only for an active tenant (OADR-0009 point 2,
// PADR-0014 point 5), so a suspended OTA's e-mails, which are still sent (OADR-0014 point 4), link to its sub-domain,
// where the storefront shows its maintenance page; a host that is pending, failed, removed or no longer primary is
// never linked. The domains are read from the platform table (PlatformReadRepository.storefrontDomains, one indexed
// query) when they are needed and never cached for the links: once per e-mail batch by the outbox drainer and once per
// answer of console.auth.signIn, refresh and me (lead decision (1g) of 2026-10-31, second batch). A lookup that fails
// (PostgreSQL unreachable) falls back to the sub-domain, which always serves, and is logged without the host.
//
// Who uses it:
//   - e-mails (renderer.ts): `brand.storefrontUrl` and the links the renderer builds (`verifyUrl`, `resetUrl`) start
//     with the primary origin, and so does every link of an e-mail's payload that the queuing code built on the
//     sub-domain (`booking.url` = `<sub-domain>/booking.html?id=bkg_…` of the booking use cases, renderer.ts
//     `storefrontUrl`), rebased when the e-mail is rendered (`rebaseStorefrontLinks`): an e-mail always links to the
//     host that is primary when it is sent, also when the flag moved after it was queued;
//   - the console (identity/staff/staff-auth.service.ts): `ConsoleTenant.storefrontUrl`, the same origin in test and
//     live (lead decision (1d) of 2026-10-31);
//   - storefront.get (storefront/storefront.mapper.ts, lead decision (2g) of 2026-10-31, second batch): `primaryUrl`,
//     the absolute legal page URLs and `seo.canonicalBaseUrl` start with the primary origin, and `domains` lists the
//     servable domains, the sub-domain and every verified custom domain with an issued certificate
//     (`servableCustomDomains`), the primary one marked. Its 5-minute cache entry holds them (`storefrontDomainsOf`,
//     read when the entry is filled; a read that fails is the request's `503`, so no entry is cached without them),
//     and the platform's `domain` invalidation drops the tenant's entries (tenancy/platform-cache.ts), so a moved
//     primary flag, a verified, failed or removed domain shows in the next storefront.get.
// Asset URLs carry no storefront host today: the edge gets same-origin paths (`/api/v1/assets/…`) and key callers
// `PUBLIC_OTA_API_URL` (storefront/storefront.mapper.ts `assetUrl`); an absolute URL on the storefront host that a
// later feature builds takes its origin from here (accepted as built, lead decision (1g) of 2026-10-31, second
// batch).
import type { PinoLogger } from "nestjs-pino";
import {
  STOREFRONT_HOST_PATTERN,
  type PlatformReadRepository,
  type PlatformStorefrontDomain,
} from "../tenancy/platform-read.repository";
import type { PlatformTenant } from "../tenancy/platform-read.types";

/** The two origins of a tenant's storefront, without a trailing slash. */
export interface StorefrontOrigins {
  /** `https://<key>.<STOREFRONT_BASE_DOMAIN>`: where links are built when they are queued, and the fallback. */
  readonly subdomain: string;
  /** The origin links use: the primary custom domain's, else `subdomain`. */
  readonly primary: string;
}

/** What the tenant's storefront domains are read from: `PlatformReadRepository`. */
export type PrimaryHostReader = Pick<PlatformReadRepository, "storefrontDomains">;

/** The tenant's storefront sub-domain as an origin: `https://<key>.<baseDomain>`, always https (ADR-0018). */
export function storefrontSubdomainOrigin(tenantKey: string, baseDomain: string): string {
  return `https://${tenantKey}.${baseDomain}`;
}

/** The tenant's origins for `primaryHost` (`primaryCustomHost`'s answer; `null`: the sub-domain is primary). */
export function storefrontOrigins(
  tenantKey: string,
  baseDomain: string,
  primaryHost: string | null,
): StorefrontOrigins {
  const subdomain = storefrontSubdomainOrigin(tenantKey, baseDomain);
  return { subdomain, primary: primaryHost === null ? subdomain : `https://${primaryHost}` };
}

/**
 * Whether a verified storefront domain may be linked and listed (lead decision (2e) of 2026-10-31, second batch): a
 * custom domain whose certificate the platform's TLS probe found `issued`, with a host name the tenant resolver
 * accepts. `pending` (no probe yet), `failed` and `expired` certificates are not linked. The sub-domain is not one of
 * them: it is always served, and named from the tenant key.
 */
export function isServableCustomDomain(domain: PlatformStorefrontDomain): boolean {
  return (
    domain.kind === "custom" && domain.tlsStatus === "issued" && STOREFRONT_HOST_PATTERN.test(domain.hostname)
  );
}

/** The servable custom domains of `domains` (`isServableCustomDomain`), in their order. */
export function servableCustomDomains(
  domains: readonly PlatformStorefrontDomain[],
): PlatformStorefrontDomain[] {
  return domains.filter(isServableCustomDomain);
}

/**
 * The primary custom host of `domains` (verified storefront domains of one tenant): the servable custom domain marked
 * primary, or `null` while the sub-domain is primary, or while the primary custom domain has no issued certificate.
 */
export function primaryCustomHost(domains: readonly PlatformStorefrontDomain[]): string | null {
  return domains.find((domain) => domain.isPrimary && isServableCustomDomain(domain))?.hostname ?? null;
}

/**
 * The host name of the tenant's primary custom storefront domain (`primaryCustomHost` of its verified storefront
 * domains), or `null` when its links use the sub-domain: the tenant is not `active`, its sub-domain is primary, the
 * primary custom domain has no issued certificate, or the platform rows cannot be read now (logged as
 * `storefront_host.primary_unavailable` with the tenant id; the sub-domain always serves).
 */
export async function primaryStorefrontHost(
  reader: PrimaryHostReader,
  tenant: Pick<PlatformTenant, "id" | "status">,
  logger: Pick<PinoLogger, "warn">,
): Promise<string | null> {
  if (tenant.status !== "active") {
    return null;
  }
  try {
    return primaryCustomHost(await reader.storefrontDomains(tenant.id));
  } catch (error) {
    logger.warn({ tenantId: tenant.id, err: error }, "storefront_host.primary_unavailable");
    return null;
  }
}

/**
 * The servable custom domains of the tenant for storefront.get (`servableCustomDomains` of its verified storefront
 * domains, the primary one among them marked), or none while the tenant is not `active` (its custom domains are not
 * served). A read that fails is thrown: storefront.get answers it and caches nothing.
 */
export async function storefrontDomainsOf(
  reader: PrimaryHostReader,
  tenant: Pick<PlatformTenant, "id" | "status">,
): Promise<PlatformStorefrontDomain[]> {
  if (tenant.status !== "active") {
    return [];
  }
  return servableCustomDomains(await reader.storefrontDomains(tenant.id));
}

/**
 * `url` on the primary origin when it is a URL on the sub-domain (the origin alone, or followed by `/`, `?` or `#`);
 * any other value unchanged.
 */
export function onPrimaryOrigin(url: string, origins: StorefrontOrigins): string {
  const { subdomain, primary } = origins;
  if (primary === subdomain || !url.startsWith(subdomain)) {
    return url;
  }
  const rest = url.slice(subdomain.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#")
    ? `${primary}${rest}`
    : url;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A copy of the JSON value `value` (an e-mail's payload) with every string that is a URL on the sub-domain moved to the
 * primary origin (`onPrimaryOrigin`); `value` itself when the sub-domain is primary. Nothing else changes.
 */
export function rebaseStorefrontLinks(value: unknown, origins: StorefrontOrigins): unknown {
  if (origins.primary === origins.subdomain) {
    return value;
  }
  if (typeof value === "string") {
    return onPrimaryOrigin(value, origins);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => rebaseStorefrontLinks(item, origins));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, rebaseStorefrontLinks(item, origins)]),
    );
  }
  return value;
}
