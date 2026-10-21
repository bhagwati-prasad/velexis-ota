// The role matrix of the console (OBE-060; ota/docs/scope.md §1.3, OADR-0011 points 5 and 6, the document's
// `StaffPermission`): which `StaffPermission` values each of the five roles of `tenant_memberships.role` holds, and
// which environments the role may open in the OTA admin. The permission guard (permission.guard.ts) checks an
// operation's `x-permission` against it; console.auth.signIn, refresh and me answer the role's permissions and
// environments from it (identity/staff/staff-auth.service.ts).
//
//   Permission                                           owner admin agent finance viewer
//   bookings:read, customers:read                          ✓     ✓     ✓     ✓      ✓
//   bookings:write, bookings:issue, bookings:cancel        ✓     ✓     ✓
//   queues:read, amadeus:read                              ✓     ✓     ✓
//   supplier_requests:read                                 ✓     ✓     ✓     ✓
//   amadeus:write (the deferred raw writes)                ✓     ✓
//   payments:read, settings:read                           ✓     ✓     ✓     ✓      ✓
//   payments:capture                                       ✓     ✓     ✓     ✓
//   payments:refund                                        ✓     ✓           ✓
//   settings:write                                         ✓     ✓
//   live environment in the OTA admin                      ✓     ✓     ✓     ✓      test only
//
// Settings writes are owner and admin only: markups, fees and templates change revenue and customer communication
// (OADR-0011 point 6). `allowUnpaid` issuance stays owner/admin only, as the contract says (checked by the use case).
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import type { StaffRole } from "../../tenancy/platform-read.repository";
import type { PlatformTenant } from "../../tenancy/platform-read.types";
import type { TenantEnvironment } from "../../tenancy/tenant-context";

export type StaffPermission = components["schemas"]["StaffPermission"];
export type ConsoleEnvironment = components["schemas"]["ConsoleStaffSession"]["environments"][number];

/** Every `StaffPermission`, in the document's order (the order of every permissions list answered). */
export const STAFF_PERMISSIONS: readonly StaffPermission[] = Object.freeze([
  "bookings:read",
  "bookings:write",
  "bookings:issue",
  "bookings:cancel",
  "customers:read",
  "queues:read",
  "supplier_requests:read",
  "amadeus:read",
  "amadeus:write",
  "settings:read",
  "settings:write",
  "payments:read",
  "payments:capture",
  "payments:refund",
]);

/** Keeps the document's order of `granted`. */
const inOrder = (granted: readonly StaffPermission[]): readonly StaffPermission[] =>
  Object.freeze(STAFF_PERMISSIONS.filter((permission) => granted.includes(permission)));

/** The role matrix of scope §1.3 (and of `StaffPermission`'s description). */
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly StaffPermission[]>> = Object.freeze({
  owner: STAFF_PERMISSIONS,
  admin: STAFF_PERMISSIONS,
  agent: inOrder([
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "payments:read",
    "payments:capture",
    "settings:read",
  ]),
  finance: inOrder([
    "bookings:read",
    "customers:read",
    "supplier_requests:read",
    "payments:read",
    "payments:capture",
    "payments:refund",
    "settings:read",
  ]),
  viewer: inOrder(["bookings:read", "customers:read", "payments:read", "settings:read"]),
});

/** The roles that may open the live environment in the OTA admin (OADR-0011 point 5): every role but `viewer`. */
export const LIVE_ROLES: readonly StaffRole[] = Object.freeze(["owner", "admin", "agent", "finance"]);

/** The permissions of `role`. */
export function permissionsOf(role: StaffRole): StaffPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** True when `role` holds `permission` (a value outside the matrix, such as a misspelled one, is never held). */
export function roleHasPermission(role: StaffRole, permission: string): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}

/** The environments a staff member may open (OADR-0011 point 5): live for a live tenant and a non-viewer role. */
export function environmentsOf(
  role: StaffRole,
  storefrontEnvironment: PlatformTenant["storefrontEnvironment"],
): ConsoleEnvironment[] {
  return storefrontEnvironment === "live" && LIVE_ROLES.includes(role) ? ["test", "live"] : ["test"];
}

/**
 * The refusal of an environment the tenant or the role does not allow (`403 ENVIRONMENT_NOT_ALLOWED`, with the
 * document's details: the environment asked for and the ones open to the caller). Only `live` is ever refused.
 */
export function environmentNotAllowed(reason: "tenant_not_live" | "role"): AppError {
  return new AppError("ENVIRONMENT_NOT_ALLOWED", {
    message:
      reason === "role"
        ? "This role may use the test environment only."
        : "This OTA is not live yet: only the test environment is available.",
    details: { environment: "live", environments: ["test"] },
  });
}

/**
 * Throws `403 ENVIRONMENT_NOT_ALLOWED` when `role` may not act in `environment` (live for a viewer); the tenant's own
 * live status is the tenant guard's check.
 */
export function assertRoleEnvironment(role: StaffRole, environment: TenantEnvironment): void {
  if (environment === "live" && !LIVE_ROLES.includes(role)) {
    throw environmentNotAllowed("role");
  }
}
