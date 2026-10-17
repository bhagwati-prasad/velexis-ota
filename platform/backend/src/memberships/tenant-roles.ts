// The role matrix of the portal (platform/docs/scope.md §1.2, PADR-0009 item 5), encoded once for the guard, the
// services and the tests of every later task:
//
// - TENANT_ACTIONS: each row of the scope's table, "what a member may do", with the roles that may do it;
// - TENANT_OPERATION_ROLES: the roles TenantRoleGuard lets through for each portal operation under
//   `/v1/tenants/{tenantId}`, taken from the actions above, as the API inventories' auth column says
//   (`portal: owner, admin`, `member` = every role). A handler declares them with
//   `@TenantRoles(...tenantRolesOf("<operationId>"))`;
// - canManageRole: who may invite, change or remove a member of a given role (only owners touch owners and admins).
//
// tenant-roles.test.ts compares the actions with the scope's table and the operations with the inventories, and checks
// that every tenant operation of the platform document has its entry. An operation added to the document under
// `/v1/tenants/{tenantId}` adds its line here in the same change.
import type { PlatformOperationId } from "@velexis/api-types/operations";
import { TENANT_ROLES, type TenantRole } from "../common/auth/tenant-role.guard";

export { isTenantRole, TENANT_ROLES, type TenantRole } from "../common/auth/tenant-role.guard";

/** One row of the matrix: the action as scope §1.2 words it, and the roles that may perform it. */
export interface TenantActionRule {
  /** The "Portal action" cell of scope §1.2, word for word. */
  readonly label: string;
  readonly roles: readonly TenantRole[];
}

const rule = (label: string, roles: readonly TenantRole[]): TenantActionRule =>
  Object.freeze({ label, roles: Object.freeze([...roles]) });

const EVERY_ROLE = TENANT_ROLES;
const OWNER_ONLY: readonly TenantRole[] = Object.freeze(["owner"] as const);

/** The rows of scope §1.2, in its order. */
export const TENANT_ACTIONS = Object.freeze({
  viewOverview: rule("See the OTA overview, status, storefront link, onboarding checklist", EVERY_ROLE),
  openConsole: rule("Open console (SSO into the OTA admin)", EVERY_ROLE),
  editProfile: rule("Edit the OTA profile (name, legal name, support e-mail, country, time zone)", [
    "owner",
    "admin",
  ]),
  manageApiKeys: rule("Create, roll and revoke API keys", ["owner", "admin"]),
  manageDomains: rule("Add, verify, make primary and remove custom domains", ["owner", "admin"]),
  viewConnections: rule("See Amadeus and payment connections (masked)", ["owner", "admin", "finance"]),
  changeConnections: rule("Change Amadeus or Stripe connections, enter credentials (MFA step-up)", [
    "owner",
    "admin",
  ]),
  manageStaff: rule("Invite and manage agent, finance and viewer members", ["owner", "admin"]),
  managePrivilegedRoles: rule("Grant or remove owner and admin roles", ["owner"]),
  viewBilling: rule("See subscription, plan and invoices", ["owner", "finance"]),
  manageBilling: rule("Choose a plan, open the Stripe Customer Portal (change plan, card, cancel)", [
    "owner",
  ]),
  viewSettlements: rule("See settlements and the payout account (masked)", ["owner", "finance"]),
  setPayoutAccount: rule("Set the payout bank account (MFA step-up)", ["owner"]),
  goLive: rule("Switch the storefront to live (MFA step-up)", ["owner"]),
} satisfies Record<string, TenantActionRule>);

/** An action of the matrix: `editProfile`, `viewBilling`, … */
export type TenantAction = keyof typeof TENANT_ACTIONS;

/** The roles that may perform `action`. */
export function rolesFor(action: TenantAction): readonly TenantRole[] {
  return TENANT_ACTIONS[action].roles;
}

/** True when a member of `role` may perform `action`. */
export function canPerform(role: TenantRole, action: TenantAction): boolean {
  return rolesFor(action).includes(role);
}

/**
 * True when a member of `actorRole` may invite, change or remove a member of `targetRole` (scope §1.2 and PF-20,
 * PF-21): owners manage every role; admins manage agents, finance members and viewers; the others manage nobody.
 * The last-owner rule (`409 LAST_OWNER`) is checked on top of it.
 */
export function canManageRole(actorRole: TenantRole, targetRole: TenantRole): boolean {
  const privileged = targetRole === "owner" || targetRole === "admin";
  return canPerform(actorRole, privileged ? "managePrivilegedRoles" : "manageStaff");
}

/**
 * The roles TenantRoleGuard lets through, for every portal operation of the platform document under
 * `/v1/tenants/{tenantId}`. Rules finer than a role (the member who leaves, owner-only role grants, live keys behind a
 * step-up) are the services' on top of these.
 */
export const TENANT_OPERATION_ROLES = Object.freeze({
  // Tenants and lifecycle (api-inventory.md §7).
  getTenant: rolesFor("viewOverview"),
  updateTenant: rolesFor("editProfile"),
  getProvisioning: rolesFor("viewOverview"),
  retryProvisioning: OWNER_ONLY,
  revealInitialKeys: OWNER_ONLY,
  getOnboarding: rolesFor("viewOverview"),
  goLive: rolesFor("goLive"),

  // Team and console (api-inventory.md §8).
  listMembers: rolesFor("viewOverview"),
  // Owners and admins remove members by canManageRole; any member may remove themself (PBE-025).
  removeMember: EVERY_ROLE,
  // Granting owner or admin needs an owner (canManageRole) and, for owner, a step-up (PBE-025).
  updateMember: rolesFor("manageStaff"),
  listInvitations: rolesFor("manageStaff"),
  createInvitation: rolesFor("manageStaff"),
  revokeInvitation: rolesFor("manageStaff"),
  resendInvitation: rolesFor("manageStaff"),
  createConsoleToken: rolesFor("openConsole"),

  // API keys, domains, connections, payout account and settlements (api-inventory-resources.md §1–§5).
  listApiKeys: rolesFor("manageApiKeys"),
  createApiKey: rolesFor("manageApiKeys"),
  updateApiKey: rolesFor("manageApiKeys"),
  rollApiKey: rolesFor("manageApiKeys"),
  revokeApiKey: rolesFor("manageApiKeys"),
  listDomains: rolesFor("viewOverview"),
  addDomain: rolesFor("manageDomains"),
  checkDomain: rolesFor("manageDomains"),
  makeDomainPrimary: rolesFor("manageDomains"),
  removeDomain: rolesFor("manageDomains"),
  listAmadeusConnections: rolesFor("viewConnections"),
  updateAmadeusConnection: rolesFor("changeConnections"),
  requestLiveAmadeus: OWNER_ONLY,
  submitAmadeusCredentials: rolesFor("changeConnections"),
  getCredentialSubmission: rolesFor("changeConnections"),
  listPaymentConnections: rolesFor("viewConnections"),
  updatePaymentConnection: rolesFor("changeConnections"),
  startStripeConnect: rolesFor("changeConnections"),
  submitStripeApiKeys: rolesFor("changeConnections"),
  useVelexisPayments: OWNER_ONLY,
  getPayoutAccount: rolesFor("viewSettlements"),
  setPayoutAccount: rolesFor("setPayoutAccount"),
  listSettlements: rolesFor("viewSettlements"),
  getSettlement: rolesFor("viewSettlements"),
  downloadSettlementLines: rolesFor("viewSettlements"),

  // Billing (api-inventory-resources.md §6).
  getSubscription: rolesFor("viewBilling"),
  listInvoices: rolesFor("viewBilling"),
  createCheckoutSession: rolesFor("manageBilling"),
  createCustomerPortalSession: rolesFor("manageBilling"),
} satisfies Partial<Record<PlatformOperationId, readonly TenantRole[]>>);

/** A portal operation under `/v1/tenants/{tenantId}`. */
export type TenantOperationId = keyof typeof TENANT_OPERATION_ROLES;

/** The roles TenantRoleGuard lets through for `operationId`: `@TenantRoles(...tenantRolesOf("updateTenant"))`. */
export function tenantRolesOf(operationId: TenantOperationId): TenantRole[] {
  return [...TENANT_OPERATION_ROLES[operationId]];
}
