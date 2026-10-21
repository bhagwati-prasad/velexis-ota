// The permission guard (OBE-060; architecture §3 step 8, OADR-0011 points 4 to 6, scope §1.3, the document's
// `x-permission` and ConsoleApiKeyScope): whether the caller of a console-scope request may do what its operation does.
// It runs after the staff guard and the rate limits (app.module.ts), on handlers bound to an operation in console
// scope only, and reads the operation's `x-permission` from the operations index:
//
//   the OTA admin's `X-Velexis-Environment: live` for a tenant that is not live (`storefront_environment` of the
//   tenant row, through the 60 s platform cache)        → 403 ENVIRONMENT_NOT_ALLOWED (OADR-0011 point 5): checked
//                                                            here rather than in the tenant guard, so that the staff
//                                                            member is known and the denied attempt is audited
//   a staff member whose role may not open live (`viewer`) in the live environment (the OTA admin's
//   `X-Velexis-Environment: live`, or a live key's)        → 403 ENVIRONMENT_NOT_ALLOWED: viewers never look at live
//                                                            data (OADR-0011 point 5 and Consequences)
//   `x-permission` none (the staff-session operations)   → allowed
//   a key-only call (no staff member) without `console:automation` among the key's scopes
//                                                          → 403 SCOPE_NOT_ALLOWED, details.requiredScope (the scope
//                                                            guard leaves this check of a `console` operation to this
//                                                            guard, so that the denial is audited as the key)
//   `x-permission` absent (the `both` operations in console scope)
//                                                          → allowed
//   a signed-in staff member (a secret key's staff token or the service caller's)
//                                                          → the role must hold the permission (roles.ts), else
//                                                            403 FORBIDDEN with details.requiredPermission
//   a key-only call                                        → the permission among the key's scopes (else
//                                                            403 FORBIDDEN): the key acts with exactly the permissions
//                                                            it lists, audited as the key
//   the service caller without a staff member             → 401 UNAUTHENTICATED (the staff guard requires the token
//                                                            first, so this does not happen)
//
// Every refusal (`FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `ENVIRONMENT_NOT_ALLOWED`) writes a `staff_actions` row with
// `outcome = denied` in a transaction of its own (StaffActionsWriter.recordDenial; console/staff-actions.writer.ts),
// with the staff member or the key as the actor and the end user's IP and user agent; a request without either (the
// OTA admin's sign-in, refresh, or a credential that named nobody) has only the log line. The rate limits run first, so
// a client that keeps asking for what it may not do is limited (600 per minute per staff session or key) before it can
// fill the audit table.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { AppError, isAppError } from "@velexis/errors";
import type { Request } from "express";
import { DENIAL_CODES, StaffActionsWriter } from "../../console/staff-actions.writer";
import { CallerContext, type Caller } from "../../tenancy/caller-resolver";
import { PlatformCache } from "../../tenancy/platform-cache";
import type { StaffRole } from "../../tenancy/platform-read.repository";
import { TenantContext, type RequestTenant, type TenantEnvironment } from "../../tenancy/tenant-context";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import { RequestContext } from "../http/request-context";
import { assertRoleEnvironment, environmentNotAllowed, roleHasPermission } from "./roles";
import {
  AUTOMATION_SCOPE,
  scopedOperation,
  STAFF_SESSION_PERMISSION,
  type ScopedOperation,
} from "./scope.guard";
import { StaffContext } from "./staff.guard";

/** What the console access check weighs. */
export interface ConsoleAccessRequest {
  readonly operation: Pick<ScopedOperation, "operationId" | "permission">;
  readonly caller: Exclude<Caller, { type: "anonymous" }>;
  /** The signed-in staff member's role, when the staff guard found one. */
  readonly role: StaffRole | undefined;
  readonly environment: TenantEnvironment;
}

/** `403 FORBIDDEN` naming the permission (the document's FORBIDDEN details). */
export function forbidden(permission: string, message: string): AppError {
  return new AppError("FORBIDDEN", { message, details: { requiredPermission: permission } });
}

/**
 * Throws the refusal of a console-scope request (see the file header; the tenant's own live status is the guard's
 * check): `ENVIRONMENT_NOT_ALLOWED`, `FORBIDDEN`, `SCOPE_NOT_ALLOWED` or `UNAUTHENTICATED`; returns when the request
 * may go on.
 */
export function assertConsoleAccess(request: ConsoleAccessRequest): void {
  const { operation, caller, role, environment } = request;
  if (role !== undefined) {
    assertRoleEnvironment(role, environment);
  }
  const permission = operation.permission;
  if (permission === STAFF_SESSION_PERMISSION) {
    return;
  }
  if (role === undefined && caller.type === "key" && !caller.scopes.includes(AUTOMATION_SCOPE)) {
    throw new AppError("SCOPE_NOT_ALLOWED", {
      message: "Console calls without a staff token need a secret key with the console:automation scope.",
      details: { requiredScope: AUTOMATION_SCOPE },
    });
  }
  if (permission === null) {
    return;
  }
  if (role !== undefined) {
    if (!roleHasPermission(role, permission)) {
      throw forbidden(permission, "Your role does not have the permission this operation needs.");
    }
    return;
  }
  if (caller.type === "key") {
    if (!caller.scopes.includes(permission)) {
      throw forbidden(permission, "The API key does not have the permission this operation needs.");
    }
    return;
  }
  // The edge never reaches console scope, and the staff guard requires the service caller's staff token.
  throw new AppError("UNAUTHENTICATED");
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly callers: CallerContext,
    private readonly tenants: TenantContext,
    private readonly context: RequestContext,
    private readonly staff: StaffContext,
    private readonly writer: StaffActionsWriter,
    private readonly platform: PlatformCache,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    if (execution.getType() !== "http") {
      return true;
    }
    const operationId = this.reflector.get<OtaOperationId | undefined>(
      OPENAPI_OPERATION,
      execution.getHandler(),
    );
    if (operationId === undefined || !this.context.isConsoleScope()) {
      return true;
    }
    const caller = this.callers.get();
    if (caller === undefined) {
      throw new Error(
        "PermissionGuard ran without a caller in the request context; CallerGuard must run first",
      );
    }
    if (caller.type === "anonymous") {
      return true;
    }
    const tenant = this.tenants.get();
    try {
      if (caller.type === "service" && tenant !== undefined) {
        await this.assertTenantEnvironment(tenant);
      }
      assertConsoleAccess({
        operation: scopedOperation(operationId),
        caller,
        role: this.staff.get()?.member.role,
        // Without a tenant (a service staff-session call whose credential named none) nothing below depends on it.
        environment: tenant?.environment ?? "test",
      });
    } catch (error) {
      if (isAppError(error) && DENIAL_CODES.has(error.code)) {
        await this.writer.recordDenial(
          operationId,
          execution.switchToHttp().getRequest<Request>().params,
          error,
        );
      }
      throw error;
    }
    return true;
  }

  /**
   * `403 ENVIRONMENT_NOT_ALLOWED` when the OTA admin asks for `live` of a tenant that is not live (OADR-0011 point 5);
   * a key's environment is the key's own. The tenant row comes through the platform cache the tenant guard just read
   * (`503 SERVICE_UNAVAILABLE` when PostgreSQL cannot be read on a miss).
   */
  private async assertTenantEnvironment(tenant: RequestTenant): Promise<void> {
    if (tenant.environment !== "live") {
      return;
    }
    const row = await this.platform.tenantById(tenant.tenantId);
    if (row?.storefrontEnvironment !== "live") {
      throw environmentNotAllowed("tenant_not_live");
    }
  }
}
