// TenantRoleGuard (platform/docs/architecture.md §3 step 6, PADR-0009 item 5): the tenant authorisation of every
// portal operation under `/v1/tenants/{tenantId}/…`. A handler declares who may call it with `@TenantRoles(...)`,
// written from the role matrix of platform/docs/scope.md §1.2 (`memberships/tenant-roles.ts`, one entry per
// operation):
//
//   @Patch(":tenantId")
//   @OpenApiOperation("updateTenant")
//   @TenantRoles(...tenantRolesOf("updateTenant"))      // owner, admin
//
// On each request the guard reads the caller's **active** membership of `{tenantId}` from PostgreSQL (no cache, so a
// removal or a role change acts at once):
//
// - no active membership (none, removed or suspended, an OTA that is not visible to members, a malformed id): `404
//   NOT_FOUND`, the answer of an unknown tenant, so tenant ids cannot be probed;
// - a member whose role is not declared: `403 FORBIDDEN`.
//
// The membership stays on the request for the handler (`@CurrentMembership()`, `tenantMembershipOf`), so `getTenant`
// answers the caller's `myRole` without a second read. The guard runs after the auth guards and the per-account rate
// limits and before RecentMfaGuard and FeatureGuard (API_GUARDS of common.module.ts): a non-member learns nothing about
// the OTA's switches or the step-up of the operation, only `404`. Handlers without `@TenantRoles` pass untouched.
//
// The read is the MembershipsModule's (layer 1): this layer-0 guard depends on the abstract TenantMembershipLookup,
// which MembershipsModule provides with its repository.
import {
  createParamDecorator,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import { accessTokenOf } from "./decorators";

/** A role of `tenant_memberships.role`: `owner`, `admin`, `agent`, `finance` or `viewer` (scope §1.2). */
export type TenantRole = components["schemas"]["TenantRole"];

/** The five roles, in the order of scope §1.2. */
export const TENANT_ROLES: readonly TenantRole[] = Object.freeze([
  "owner",
  "admin",
  "agent",
  "finance",
  "viewer",
] as const);

/** True when `value` is one of TENANT_ROLES. */
export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && (TENANT_ROLES as readonly string[]).includes(value);
}

/**
 * The tenant statuses in which members see their OTA: the `TenantStatus` values of the OpenAPI document. A tenant being
 * deprovisioned or deleted is visible to nobody, so every route of it answers `404`, and the lists leave it out.
 */
export const MEMBER_VISIBLE_TENANT_STATUSES = Object.freeze([
  "provisioning",
  "active",
  "suspended",
  "failed",
] as const satisfies readonly components["schemas"]["TenantStatus"][]);

/** A status of MEMBER_VISIBLE_TENANT_STATUSES. */
export type TenantStatus = (typeof MEMBER_VISIBLE_TENANT_STATUSES)[number];

/** The caller's active membership of the request's tenant, as the guard read it. */
export interface TenantMembership {
  /** `stf_…`: the membership (the staff id of the OTA admin). */
  readonly membershipId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly role: TenantRole;
}

/**
 * The read the guard needs: the **active** membership of an account in a tenant that members may see, or `undefined`.
 * MembershipsModule provides it (memberships.repository.ts); unit tests pass a stand-in.
 */
export abstract class TenantMembershipLookup {
  abstract findActive(tenantId: string, accountId: string): Promise<TenantMembership | undefined>;
}

/** The metadata key of `@TenantRoles(...)`. */
export const TENANT_ROLES_METADATA = "velexis:tenant-roles";

/**
 * The handler (or every handler of the controller) needs an active membership of the route's `{tenantId}` with one of
 * `roles` (TenantRoleGuard). Take the roles from `memberships/tenant-roles.ts`, never from memory. At least one role;
 * an unknown role throws when the class is defined.
 */
export function TenantRoles(...roles: TenantRole[]): MethodDecorator & ClassDecorator {
  if (roles.length === 0 || !roles.every(isTenantRole)) {
    throw new TypeError("@TenantRoles(): name at least one role of owner, admin, agent, finance, viewer");
  }
  return SetMetadata(TENANT_ROLES_METADATA, Object.freeze([...new Set(roles)]));
}

/** Where the guard keeps the membership on the request. */
const TENANT_MEMBERSHIP = Symbol("velexis:tenant-membership");

/** The membership TenantRoleGuard read for this request; `undefined` on a handler without `@TenantRoles`. */
export function tenantMembershipOf(request: object): TenantMembership | undefined {
  const membership: unknown = Reflect.get(request, TENANT_MEMBERSHIP);
  return membership === undefined ? undefined : (membership as TenantMembership);
}

/**
 * The caller's membership of the route's tenant, on a handler with `@TenantRoles(...)`:
 * `@CurrentMembership() membership: TenantMembership`. Throws on a handler that has none.
 */
export const CurrentMembership = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantMembership => {
    const membership = tenantMembershipOf(context.switchToHttp().getRequest<object>());
    if (membership === undefined) {
      throw new Error(
        "@CurrentMembership(): the handler has no @TenantRoles(...), so no membership was read",
      );
    }
    return membership;
  },
);

/** The parts of an Express request the guard reads. */
interface TenantRequest {
  readonly params?: Readonly<Record<string, unknown>>;
}

@Injectable()
export class TenantRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly memberships: TenantMembershipLookup,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }
    const roles = this.reflector.getAllAndOverride<readonly TenantRole[] | undefined>(TENANT_ROLES_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles === undefined) {
      return true;
    }
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const claims = accessTokenOf(request);
    if (claims === undefined || claims.aud !== "portal") {
      // @TenantRoles on a handler that PortalAuthGuard did not cover (a public or admin operation): refuse, never wave
      // through.
      throw new AppError("UNAUTHENTICATED");
    }
    const tenantId = request.params?.["tenantId"];
    if (typeof tenantId !== "string") {
      throw new Error("@TenantRoles(): the route has no {tenantId} path parameter");
    }
    const membership = await this.memberships.findActive(tenantId, claims.sub);
    if (membership === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (!roles.includes(membership.role)) {
      throw new AppError("FORBIDDEN");
    }
    Reflect.set(request, TENANT_MEMBERSHIP, membership);
    return true;
  }
}
