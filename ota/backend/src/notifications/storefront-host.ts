// The storefront host of a tenant's links (OBE-080; ADR-0018 "Custom domain lifecycle" step 5, PADR-0004 item 8,
// OADR-0015 point 5): the origin every absolute URL on the tenant's storefront starts with, and the only place that
// decides it.
//
//   primary origin   https://<host> of the tenant's verified primary custom storefront domain
//                    (PlatformReadRepository.primaryStorefrontHost), while the tenant is `active`;
//                    else its sub-domain https://<key>.<STOREFRONT_BASE_DOMAIN>
//
// A custom domain is served only for an active tenant (OADR-0009 point 2, PADR-0014 point 5), so a suspended OTA's
// e-mails, which are still sent (OADR-0014 point 4), link to its sub-domain, where the storefront shows its maintenance
// page; a host that is pending, failed, removed or no longer primary is never linked. The primary host is read from the
// platform table when it is needed and never cached (the `domain` invalidation names a host, not its tenant): once per
// e-mail batch by the outbox drainer and once per answer of console.auth.signIn, refresh and me. A lookup that fails
// (PostgreSQL unreachable) falls back to the sub-domain, which always serves, and is logged without the host.
//
// Who uses it:
//   - e-mails (renderer.ts): `brand.storefrontUrl` and the links the renderer builds (`verifyUrl`, `resetUrl`) start
//     with the primary origin, and so does every link of an e-mail's payload that the queuing code built on the
//     sub-domain (`booking.url` = `<sub-domain>/booking.html?id=bkg_…` of the booking use cases, renderer.ts
//     `storefrontUrl`), rebased when the e-mail is rendered (`rebaseStorefrontLinks`): an e-mail always links to the
//     host that is primary when it is sent, also when the flag moved after it was queued;
//   - the console (identity/staff/staff-auth.service.ts): `ConsoleTenant.storefrontUrl`, the same origin in test and
//     live (lead decision (1d) of 2026-10-31).
// Asset URLs carry no storefront host today: the edge gets same-origin paths (`/api/v1/assets/…`) and key callers
// `PUBLIC_OTA_API_URL` (storefront/storefront.mapper.ts `assetUrl`); an absolute URL on the storefront host that a
// later feature builds takes its origin from here.
import type { PinoLogger } from "nestjs-pino";
import type { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant } from "../tenancy/platform-read.types";

/** The two origins of a tenant's storefront, without a trailing slash. */
export interface StorefrontOrigins {
  /** `https://<key>.<STOREFRONT_BASE_DOMAIN>`: where links are built when they are queued, and the fallback. */
  readonly subdomain: string;
  /** The origin links use: the primary custom domain's, else `subdomain`. */
  readonly primary: string;
}

/** What the primary host is read from: `PlatformReadRepository`. */
export type PrimaryHostReader = Pick<PlatformReadRepository, "primaryStorefrontHost">;

/** The tenant's storefront sub-domain as an origin: `https://<key>.<baseDomain>`, always https (ADR-0018). */
export function storefrontSubdomainOrigin(tenantKey: string, baseDomain: string): string {
  return `https://${tenantKey}.${baseDomain}`;
}

/** The tenant's origins for `primaryHost` (`primaryStorefrontHost`'s answer; `null`: the sub-domain is primary). */
export function storefrontOrigins(
  tenantKey: string,
  baseDomain: string,
  primaryHost: string | null,
): StorefrontOrigins {
  const subdomain = storefrontSubdomainOrigin(tenantKey, baseDomain);
  return { subdomain, primary: primaryHost === null ? subdomain : `https://${primaryHost}` };
}

/**
 * The host name of the tenant's verified primary custom storefront domain, or `null` when its links use the
 * sub-domain: the tenant is not `active`, its sub-domain is primary, or the platform row cannot be read now (logged
 * as `storefront_host.primary_unavailable` with the tenant id; the sub-domain always serves).
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
    return await reader.primaryStorefrontHost(tenant.id);
  } catch (error) {
    logger.warn({ tenantId: tenant.id, err: error }, "storefront_host.primary_unavailable");
    return null;
  }
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
