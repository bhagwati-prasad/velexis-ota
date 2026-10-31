// The portal's pages of this OTA (README §5 `/portal`, routes.md §11, OAD-012): API keys, domains, Amadeus, payments
// and Stripe, team, billing, go-live and the OTA's settings belong to the platform, so the admin only links to them.
// A link is built from two values and nothing else: the configured `PUBLIC_PORTAL_URL` and the id of the staff
// session's OTA (`console.auth.me` → `tenant.id`), as `${PUBLIC_PORTAL_URL}/otas/<tenantId>/<area>` (the portal's
// route map, platform/frontend/README.md). No request header, cookie, query parameter or API answer other than the
// tenant id goes into a link, so a link can never point at another host or another OTA than the session's. The portal
// checks its own roles when the page opens (some areas are for owners and admins only).
import { parseTenantId } from "@/lib/session";

/** One area of the portal for an OTA. */
export interface PortalArea {
  readonly id: string;
  /** The path under `/otas/<tenantId>`; empty for the OTA's overview. */
  readonly path: string;
  readonly label: string;
  /** What the area is for, in a sentence. */
  readonly description: string;
}

/** A portal area with its absolute URL. */
export interface PortalLink extends PortalArea {
  readonly href: string;
}

/** The portal's areas of an OTA, in the order of the portal's own navigation. */
export const PORTAL_AREAS: readonly PortalArea[] = Object.freeze([
  {
    id: "overview",
    path: "",
    label: "OTA overview",
    description: "The OTA's status, its storefront address, the onboarding checklist and Open console.",
  },
  {
    id: "api-keys",
    path: "api-keys",
    label: "API keys",
    description:
      "The publishable and secret keys of each environment: create, restrict to origins, roll and revoke.",
  },
  {
    id: "domains",
    path: "domains",
    label: "Domains",
    description: "The storefront's Velexis address and the custom domains with their DNS records.",
  },
  {
    id: "amadeus",
    path: "amadeus",
    label: "Amadeus",
    description: "The Amadeus connection of each environment, the office settings and live access.",
  },
  {
    id: "payments",
    path: "payments",
    label: "Payments and Stripe",
    description:
      "The Stripe connection of each environment, the statement descriptor and the OTA's own Stripe account.",
  },
  {
    id: "team",
    path: "team",
    label: "Team",
    description: "Members, roles and invitations: who opens this console, and with which role.",
  },
  {
    id: "billing",
    path: "billing",
    label: "Billing",
    description: "The Velexis plan of this OTA, its status and its invoices.",
  },
  {
    id: "go-live",
    path: "go-live",
    label: "Go live",
    description: "The checklist of the live environment and the switch to it.",
  },
  {
    id: "settings",
    path: "settings",
    label: "OTA settings",
    description: "The OTA's profile: name, legal name, support e-mail, country and time zone.",
  },
]);

/**
 * The portal page `path` of the OTA `tenantId` (`${portalUrl}/otas/<tenantId>/<path>`), or `undefined` when `tenantId`
 * is not a tenant id (`ten_` and a ULID). The portal URL keeps its scheme, host, port and path; its credentials, query
 * and fragment are dropped.
 */
export function portalOtaUrl(portalUrl: string, tenantId: string, path = ""): string | undefined {
  const tenant = parseTenantId(tenantId);
  if (tenant === undefined) {
    return undefined;
  }
  const url = new URL(portalUrl);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = path === "" ? `${base}/otas/${tenant}` : `${base}/otas/${tenant}/${path}`;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Every portal area of the OTA `tenantId` with its URL under `portalUrl` (`PUBLIC_PORTAL_URL`); none when `tenantId`
 * is not a tenant id.
 */
export function portalLinks(portalUrl: string, tenantId: string): PortalLink[] {
  const links: PortalLink[] = [];
  for (const area of PORTAL_AREAS) {
    const href = portalOtaUrl(portalUrl, tenantId, area.path);
    if (href === undefined) {
      return [];
    }
    links.push({ ...area, href });
  }
  return links;
}
