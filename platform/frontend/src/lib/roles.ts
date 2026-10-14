import type { components } from "@velexis/api-types/platform";

/**
 * The membership roles of the portal and what each may do (platform/docs/scope.md §1.2), and the navigation they
 * get (README §2 and §4). This mirrors the matrix the platform API enforces (PADR-0009 item 5): the portal hides
 * what a role may not do, the API refuses it again. Plain data without secrets, so client components use it.
 */

/** A member's role in an OTA. */
export type TenantRole = components["schemas"]["TenantRole"];
/** The milestone switches of PADR-0015, from `getMe`. */
export type MilestoneFeatures = components["schemas"]["MilestoneFeatures"];
/** One membership of the signed-in account, from `getMe`. */
export type AccountMembership = components["schemas"]["AccountMembership"];

/** The five roles, most powerful first. */
export const TENANT_ROLES = [
  "owner",
  "admin",
  "agent",
  "finance",
  "viewer",
] as const satisfies readonly TenantRole[];

const EVERY_ROLE = TENANT_ROLES;

/** The portal actions of scope §1.2, one per row of the matrix, with the roles allowed to do them. */
export const PORTAL_ACTIONS = {
  /** See the OTA overview, status, storefront link (its domains), onboarding checklist. */
  viewOta: EVERY_ROLE,
  /** Open console (SSO into the OTA admin). */
  openConsole: EVERY_ROLE,
  /** Edit the OTA profile (name, legal name, support e-mail, country, time zone). */
  editProfile: ["owner", "admin"],
  /** Create, roll and revoke API keys. */
  manageApiKeys: ["owner", "admin"],
  /** Add, verify, make primary and remove custom domains. */
  manageDomains: ["owner", "admin"],
  /** See Amadeus and payment connections (masked). */
  viewConnections: ["owner", "admin", "finance"],
  /** Change Amadeus or Stripe connections, enter credentials (MFA step-up). */
  manageConnections: ["owner", "admin"],
  /** Invite and manage agent, finance and viewer members. */
  manageTeam: ["owner", "admin"],
  /** Grant or remove owner and admin roles. */
  manageOwnersAndAdmins: ["owner"],
  /** See subscription, plan and invoices. */
  viewBilling: ["owner", "finance"],
  /** Choose a plan, open the Stripe Customer Portal (change plan, card, cancel). */
  manageBilling: ["owner"],
  /** See settlements and the payout account (masked). */
  viewSettlements: ["owner", "finance"],
  /** Set the payout bank account (MFA step-up). */
  setPayoutAccount: ["owner"],
  /** Switch the storefront to live (MFA step-up). */
  goLive: ["owner"],
} as const satisfies Record<string, readonly TenantRole[]>;

/** One action of the matrix. */
export type PortalAction = keyof typeof PORTAL_ACTIONS;

/** `role` may do `action` (scope §1.2). */
export function can(role: TenantRole, action: PortalAction): boolean {
  return (PORTAL_ACTIONS[action] as readonly TenantRole[]).includes(role);
}

// ---- Navigation -----------------------------------------------------------------------------------------------

/** The navigation entries of one OTA, in display order. */
export const OTA_NAV_IDS = [
  "overview",
  "apiKeys",
  "domains",
  "amadeus",
  "payments",
  "payoutAccount",
  "settlements",
  "team",
  "billing",
  "settings",
  "goLive",
] as const;

/** One navigation entry of an OTA. */
export type OtaNavId = (typeof OTA_NAV_IDS)[number];

interface OtaNavRule {
  /** The path below `/otas/<tenantId>` (README §2). */
  readonly path: string;
  /** The action of scope §1.2 that the page needs; the entry shows only for roles allowed to do it. */
  readonly action: PortalAction;
  /** The milestone switch the page needs (PADR-0015); the entry is hidden while it is off. */
  readonly feature?: keyof MilestoneFeatures;
}

/**
 * When each entry shows. The team entry is team management (scope §1.2 "Invite and manage members"), so only
 * owners and admins get it; billing is "See subscription, plan and invoices"; Amadeus and payments are the
 * connection settings.
 */
const OTA_NAV_RULES: Readonly<Record<OtaNavId, OtaNavRule>> = {
  overview: { path: "", action: "viewOta" },
  apiKeys: { path: "/api-keys", action: "manageApiKeys" },
  domains: { path: "/domains", action: "viewOta" },
  amadeus: { path: "/amadeus", action: "viewConnections" },
  payments: { path: "/payments", action: "viewConnections" },
  payoutAccount: { path: "/payments/payout-account", action: "viewSettlements", feature: "settlements" },
  settlements: { path: "/payments/settlements", action: "viewSettlements", feature: "settlements" },
  team: { path: "/team", action: "manageTeam" },
  billing: { path: "/billing", action: "viewBilling" },
  settings: { path: "/settings", action: "editProfile" },
  goLive: { path: "/go-live", action: "goLive", feature: "liveSwitch" },
};

/** A navigation entry to render. */
export interface NavEntry<Id extends string = string> {
  readonly id: Id;
  readonly href: string;
}

/** The URL of an OTA page: `/otas/<tenantId><path>`. */
export function otaPath(tenantId: string, path = ""): string {
  return `/otas/${encodeURIComponent(tenantId)}${path}`;
}

/** Where an OTA opens: its set-up page while it is being set up or after the set-up failed, else its overview. */
export function membershipHref(membership: Pick<AccountMembership, "tenantId" | "tenantStatus">): string {
  return membership.tenantStatus === "provisioning" || membership.tenantStatus === "failed"
    ? otaPath(membership.tenantId, "/setup")
    : otaPath(membership.tenantId);
}

/** The entries of an OTA that a member with `role` sees, with the milestone switches of `features`. */
export function otaNavigation(
  tenantId: string,
  role: TenantRole,
  features: MilestoneFeatures,
): NavEntry<OtaNavId>[] {
  return OTA_NAV_IDS.filter((id) => {
    const rule = OTA_NAV_RULES[id];
    return can(role, rule.action) && (rule.feature === undefined || features[rule.feature]);
  }).map((id) => ({ id, href: otaPath(tenantId, OTA_NAV_RULES[id].path) }));
}

/** The account entries every signed-in account sees. */
export const ACCOUNT_NAV_IDS = ["dashboard", "account", "security"] as const;

/** One account navigation entry. */
export type AccountNavId = (typeof ACCOUNT_NAV_IDS)[number];

const ACCOUNT_NAV_PATHS: Readonly<Record<AccountNavId, string>> = {
  dashboard: "/dashboard",
  account: "/account",
  security: "/account/security",
};

/** The account entries (my OTAs, profile, security). */
export function accountNavigation(): NavEntry<AccountNavId>[] {
  return ACCOUNT_NAV_IDS.map((id) => ({ id, href: ACCOUNT_NAV_PATHS[id] }));
}

/** An OTA id as the platform issues it (`ten_` + ULID). */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The OTA of a portal path (`/otas/<tenantId>/…`), or `undefined` outside an OTA (`/dashboard`, `/otas/new`). */
export function tenantIdOfPath(pathname: string): string | undefined {
  const segment = /^\/otas\/([^/?#]+)/.exec(pathname)?.[1];
  return segment !== undefined && TENANT_ID.test(segment) ? segment : undefined;
}

/** The membership of the OTA of `pathname`, when the account is a member of it. */
export function currentMembership(
  memberships: readonly AccountMembership[],
  pathname: string,
): AccountMembership | undefined {
  const tenantId = tenantIdOfPath(pathname);
  return tenantId === undefined ? undefined : memberships.find((member) => member.tenantId === tenantId);
}

/** `href` is the page of `pathname` or one of its parents. */
function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The entry of `entries` that is the current page: the most specific `href` that is the page or one of its
 * parents. `/payments/settlements` marks "Settlements" (when the account sees it), `/otas/<id>/setup` marks the
 * overview, `/account/security` marks "Security" rather than "Account".
 */
export function currentEntry<Id extends string>(
  entries: readonly NavEntry<Id>[],
  pathname: string,
): NavEntry<Id> | undefined {
  return entries
    .filter((entry) => matches(pathname, entry.href))
    .sort((left, right) => right.href.length - left.href.length)[0];
}
