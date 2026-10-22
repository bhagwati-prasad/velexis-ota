// Staff permissions in the OTA admin (README §8, OADR-0018 point 4, scope §1.3). `console.auth.me` answers the
// staff member's role, the permissions the API grants and the environments they may open, once per request
// (`getStaff()` in lib/velexis.ts). Navigation, buttons and `requireStaff()` ask `can()`; the API stays the
// authority (`403 FORBIDDEN`), so this only hides what a role cannot do, for clarity.
//
// Plain data and pure functions without secrets: client components (the permission gate, the navigation) may
// import this module. Its SDK imports are types only, which the compiler erases.
import type { ConsoleStaffProfile, ConsoleStaffSession, StaffPermission, StaffRole } from "@velexis/ota-sdk";

/** The environments of the OTA admin's switch (`X-Velexis-Environment`). */
export type StaffEnvironment = ConsoleStaffProfile["environments"][number];

/** Every `StaffPermission`, in the document's order. */
export const STAFF_PERMISSIONS = [
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
] as const satisfies readonly StaffPermission[];

/** Every `StaffRole`, from the most to the least powerful. */
export const STAFF_ROLES = [
  "owner",
  "admin",
  "agent",
  "finance",
  "viewer",
] as const satisfies readonly StaffRole[];

/** `true`, or the members of `All` that `Listed` misses (which `true` is not assignable to). */
type Complete<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : Exclude<All, Listed>;
// Compile-time completeness: a permission or role the document adds and these lists miss fails the type check.
const _permissionsComplete: Complete<StaffPermission, (typeof STAFF_PERMISSIONS)[number]> = true;
const _rolesComplete: Complete<StaffRole, (typeof STAFF_ROLES)[number]> = true;

/** The permissions of a role, keeping the document's order. */
const only = (...granted: StaffPermission[]): readonly StaffPermission[] =>
  Object.freeze(STAFF_PERMISSIONS.filter((permission) => granted.includes(permission)));

/**
 * The role matrix of scope §1.3 (the `StaffPermission` description of the OTA document says the same):
 * owner and admin hold everything; agents work bookings, queues, shopping, customers, the supplier log and capture
 * payments but never refund or change settings; finance reads, captures and refunds; viewers read.
 */
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly StaffPermission[]>> = Object.freeze({
  owner: only(...STAFF_PERMISSIONS),
  admin: only(...STAFF_PERMISSIONS),
  agent: only(
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "settings:read",
    "payments:read",
    "payments:capture",
  ),
  finance: only(
    "bookings:read",
    "customers:read",
    "supplier_requests:read",
    "settings:read",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ),
  viewer: only("bookings:read", "customers:read", "settings:read", "payments:read"),
});

/** The roles that may open the live environment (scope §1.3 "Live environment in the OTA admin", OADR-0011 point 5). */
export const LIVE_ROLES: readonly StaffRole[] = Object.freeze(["owner", "admin", "agent", "finance"]);

/**
 * What `can()` reads of a staff profile: the role and the permissions of `console.auth.me` (`ConsoleStaffProfile`)
 * or of a sign-in or refresh (`ConsoleStaffSession`).
 */
export interface PermissionHolder {
  readonly staff: { readonly role: StaffRole };
  readonly permissions: readonly StaffPermission[];
}

/** What `canOpenEnvironment()` reads of a staff profile. */
export interface EnvironmentHolder {
  readonly staff: { readonly role: StaffRole };
  readonly environments: readonly StaffEnvironment[];
}

/** `value` is a `StaffPermission` (form fields, URL parameters and other untyped input). */
export function isStaffPermission(value: unknown): value is StaffPermission {
  return typeof value === "string" && (STAFF_PERMISSIONS as readonly string[]).includes(value);
}

/** `value` is a `StaffRole`. */
export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

/** The role holds `permission` in the matrix of scope §1.3; a value outside the matrix is never held. */
export function roleHasPermission(role: StaffRole, permission: string): boolean {
  return isStaffRole(role) && (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}

/**
 * Whether the staff member of `profile` may do what `permission` allows: the role holds it in the matrix of scope
 * §1.3 **and** the API granted it (`permissions` of `console.auth.me`). Both must agree, so the admin never offers
 * an action that either the matrix or the API would refuse. No profile (no session) holds nothing.
 */
export function can(
  profile: PermissionHolder | ConsoleStaffProfile | ConsoleStaffSession | null | undefined,
  permission: StaffPermission,
): boolean {
  if (profile === null || profile === undefined || !isStaffPermission(permission)) {
    return false;
  }
  return roleHasPermission(profile.staff.role, permission) && profile.permissions.includes(permission);
}

/**
 * Whether the staff member may switch to `environment`: `test` always, `live` only for a role of `LIVE_ROLES` when the
 * API lists it in `environments` (a live OTA, OADR-0011 point 5). A viewer never gets the LIVE switch.
 */
export function canOpenEnvironment(
  profile: EnvironmentHolder | ConsoleStaffProfile | ConsoleStaffSession | null | undefined,
  environment: StaffEnvironment,
): boolean {
  if (profile === null || profile === undefined) {
    return false;
  }
  if (environment === "test") {
    return true;
  }
  return (
    environment === "live" && LIVE_ROLES.includes(profile.staff.role) && profile.environments.includes("live")
  );
}
