// The scope guard (architecture §3 step 7; ADR-0018 "Scope", the OTA document's "Keys" and `X-Velexis-Scope`,
// db README §5): who may call an operation, and in which scope it runs. It reads the operation's `x-scope`,
// `x-edge-only` and `x-permission` from the generated operations index (`otaOperations` of
// @velexis/api-types/operations) and compares them with the caller the caller guard classified (OBE-011):
//
//   x-edge-only and not the edge caller                          → 403 SCOPE_NOT_ALLOWED (reason edge_only)
//   the OTA admin's service caller (OBE-060, OADR-0011 point 4): a `console` operation runs in console scope (its
//     staff token and the role's permission are the staff and permission guards' business); any other operation
//                                                                → 403 SCOPE_NOT_ALLOWED (service_console_only)
//   customer scope (the default): the edge, `pk_` and `sk_` keys of any key scope, on `customer` and `both`
//   console scope, asked for with `X-Velexis-Scope: console` on a `both` operation, or a `console` operation:
//     the edge or a `pk_` key                                    → 403 SCOPE_NOT_ALLOWED (console_operation,
//                                                                  console_scope_requested)
//     `X-Velexis-Scope: console` on a `customer` operation       → 403 SCOPE_NOT_ALLOWED (console_scope_requested)
//     an `sk_` key scoped `storefront`                           → 403 SCOPE_NOT_ALLOWED (storefront_key)
//     any other `sk_` key on a staff-session operation
//     (`x-permission: none`: console.auth.signIn, refresh,
//     signOut, me), which needs a portal token, a refresh token
//     or a staff session but no permission                       → console scope (the session guards check the token)
//     any other `sk_` key with a bearer token on a `console`
//     operation: a staff token (ConsoleApiKeyScope `console`)    → console scope; the staff guard verifies the token,
//                                                                  the permission guard checks the staff member's role
//                                                                  (OBE-060)
//     any other `sk_` key without `console:automation`           → 403 SCOPE_NOT_ALLOWED, details.requiredScope
//     a `console:automation` key without the operation's
//     `x-permission` among its scopes                            → 403 FORBIDDEN, details.requiredPermission
//     otherwise the request runs in console scope (RequestContext.markConsoleScope: net prices, supplier details).
//   an operation without `x-scope` (none today)                  → 403 SCOPE_NOT_ALLOWED (no_scope)
//
// A secret key alone is customer scope on `both` operations, so storefront server code never receives net amounts
// (OfferDataScope of the document). Key-only console calls get exactly the permissions listed on the key (B4 §1);
// `both` operations have no `x-permission`, so `console:automation` alone opens their console view. The other ways
// into console scope are a staff token with a secret key not scoped `storefront`, and the OTA admin's service caller
// with a staff token (OBE-059, OBE-060). Session tokens are verified by the session guards after this one (step 8):
// here a bearer token on a console operation only means "a staff session is presented", and the staff guard refuses
// it when it is not one. In the API's pipeline the guard leaves the checks of a key-only call on a `console` operation
// (`console:automation` among the key's scopes, then the operation's `x-permission`) to the permission guard
// (`deferPermission`), which runs after the rate limits and records the denial in `staff_actions` (OBE-060, OADR-0011
// point 8); on a `both` operation in console scope this guard still refuses a key without `console:automation`, and
// `requestScope` alone still answers both checks.
//
// The guard runs after the tenant guard, on handlers bound to an operation (`@OpenApiOperation`) only, like the tenant
// guard: the anonymous caller of public and webhook routes, routes outside the document and the 501 routes of pending
// operations are left alone. Nest runs every guard before the interceptors, so a refused request is never validated.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { otaOperations, type ApiOperation, type OtaOperationId } from "@velexis/api-types/operations";
import { AppError } from "@velexis/errors";
import type { Request } from "express";
import { bearerTokenOf } from "../../identity/token.service";
import { CallerContext, type Caller } from "../../tenancy/caller-resolver";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import { RequestContext } from "../http/request-context";

/** The scope a request runs in: customer (selling amounts, ownership checks) or console (OTA staff and automation). */
export type RequestScope = "customer" | "console";

/** `X-Velexis-Scope` (OfferDataScope of the document), lower case as Node gives header names. */
export const SCOPE_HEADER = "x-velexis-scope";

/** The key scope that allows key-only console calls (`ConsoleApiKeyScope`, B4 §1). */
export const AUTOMATION_SCOPE = "console:automation";

/** Why a request was refused with `SCOPE_NOT_ALLOWED` (`details.reason`). */
export type ScopeRefusal =
  | "edge_only"
  | "console_operation"
  | "console_scope_requested"
  | "storefront_key"
  | "service_console_only"
  | "no_scope";

/** What the guard needs of an operation of the index. */
export type ScopedOperation = Pick<ApiOperation, "operationId" | "scope" | "edgeOnly" | "permission">;

/** A caller with a credential: the anonymous caller of public and webhook routes has no scope to check. */
export type ScopedCaller = Exclude<Caller, { type: "anonymous" }>;

const OPERATIONS: ReadonlyMap<string, ScopedOperation> = new Map(
  otaOperations.map((operation) => [operation.operationId, operation]),
);

/** The operation `operationId` of the generated index; throws for an id the index does not have. */
export function scopedOperation(operationId: OtaOperationId): ScopedOperation {
  const operation = OPERATIONS.get(operationId);
  if (operation === undefined) {
    throw new Error(`the operations index has no operation "${operationId}"`);
  }
  return operation;
}

const MESSAGES: Readonly<Record<ScopeRefusal, string>> = {
  edge_only: "This operation is available on the hosted storefront only.",
  console_operation: "This operation needs a secret key with console access.",
  console_scope_requested: "Console scope is not available to this caller on this operation.",
  storefront_key: "A secret key scoped storefront cannot call console operations.",
  service_console_only: "The OTA admin's service key may call console operations only.",
  no_scope: "This operation cannot be called.",
};

function refused(reason: ScopeRefusal): AppError {
  return new AppError("SCOPE_NOT_ALLOWED", { message: MESSAGES[reason], details: { reason } });
}

/** What else `requestScope` weighs besides the operation, the caller and `X-Velexis-Scope`. */
export interface ScopeOptions {
  /** The request carries a bearer token: on a `console` operation a secret key's staff token (OBE-060). */
  readonly staffToken?: boolean;
  /**
   * Leave a key-only call's `x-permission`, and on a `console` operation its `console:automation` scope, to the
   * permission guard (which records the denial).
   */
  readonly deferPermission?: boolean;
}

/**
 * The scope `caller` gets on `operation` when it sends `X-Velexis-Scope: requested`; throws `AppError`
 * `SCOPE_NOT_ALLOWED` (403) or `FORBIDDEN` (403) as the file header says. Only `console` in the header asks for more;
 * any other value leaves the default (the validation interceptor refuses values outside the document's enum).
 */
export function requestScope(
  operation: ScopedOperation,
  caller: ScopedCaller,
  requested: string | undefined,
  options: ScopeOptions = {},
): RequestScope {
  if (operation.edgeOnly && caller.type !== "edge") {
    throw refused("edge_only");
  }
  const scope = operation.scope;
  if (scope !== "customer" && scope !== "both" && scope !== "console") {
    // Every operation of the OTA document has an x-scope today; a credential never reaches one without it.
    throw refused("no_scope");
  }
  if (caller.type === "service") {
    // OADR-0011 point 4: console operations only, whatever X-Velexis-Scope says.
    if (scope !== "console") {
      throw refused("service_console_only");
    }
    return "console";
  }
  if (scope !== "console" && requested !== "console") {
    return "customer";
  }
  if (caller.type === "edge" || caller.kind === "publishable") {
    throw refused(scope === "console" ? "console_operation" : "console_scope_requested");
  }
  if (scope === "customer") {
    throw refused("console_scope_requested");
  }
  return keyConsoleScope(operation, caller.scopes, {
    consoleOperation: scope === "console",
    staffToken: scope === "console" && options.staffToken === true,
    deferPermission: options.deferPermission === true,
  });
}

/**
 * The `x-permission` of the four staff-session operations (console.auth.signIn, refresh, signOut, me): they need a
 * portal token, a refresh token or a staff session, but no permission (ota/backend/openapi/README.md).
 */
export const STAFF_SESSION_PERMISSION = "none";

/**
 * Console scope for a secret key: with a staff token on a console operation the staff member's role decides (the
 * permission guard); without one, `console:automation` and the operation's permission (on a console operation the
 * permission guard's checks when they are deferred).
 */
function keyConsoleScope(
  operation: ScopedOperation,
  scopes: readonly string[],
  options: {
    readonly consoleOperation: boolean;
    readonly staffToken: boolean;
    readonly deferPermission: boolean;
  },
): RequestScope {
  if (scopes.includes("storefront")) {
    throw refused("storefront_key");
  }
  if (operation.permission === STAFF_SESSION_PERMISSION) {
    // How a console backend gets and keeps its staff token: any secret key not scoped storefront may call them (the
    // document's console.auth.signIn preconditions); the staff session guards check the token they need (OBE-059).
    return "console";
  }
  if (options.staffToken) {
    // ConsoleApiKeyScope `console` (or none, or `console:automation`) with a staff token: the staff guard verifies the
    // token (a bearer that is not a staff token of the tenant is 401), the permission guard the role (OBE-060).
    return "console";
  }
  if (!scopes.includes(AUTOMATION_SCOPE)) {
    if (options.deferPermission && options.consoleOperation) {
      // A key-only call on a console operation: the permission guard refuses it with the same answer after the rate
      // limits, and records the denied attempt as the key (OADR-0011 point 8).
      return "console";
    }
    throw new AppError("SCOPE_NOT_ALLOWED", {
      message: "Console calls without a staff token need a secret key with the console:automation scope.",
      details: { requiredScope: AUTOMATION_SCOPE },
    });
  }
  const permission = operation.permission;
  if (!options.deferPermission && permission !== null && !scopes.includes(permission)) {
    throw new AppError("FORBIDDEN", {
      message: "The API key does not have the permission this operation needs.",
      details: { requiredPermission: permission },
    });
  }
  return "console";
}

/** A header's value; Node joins repeated headers into one string. */
function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly callers: CallerContext,
    private readonly context: RequestContext,
  ) {}

  canActivate(execution: ExecutionContext): boolean {
    if (execution.getType() !== "http") {
      return true;
    }
    const operationId = this.reflector.get<OtaOperationId | undefined>(
      OPENAPI_OPERATION,
      execution.getHandler(),
    );
    if (operationId === undefined) {
      return true;
    }
    const caller = this.callers.get();
    if (caller === undefined) {
      throw new Error("ScopeGuard ran without a caller in the request context; CallerGuard must run first");
    }
    if (caller.type === "anonymous") {
      return true;
    }
    const req = execution.switchToHttp().getRequest<Request>();
    const options: ScopeOptions = {
      staffToken: bearerTokenOf(req.headers) !== undefined,
      deferPermission: true,
    };
    if (
      requestScope(scopedOperation(operationId), caller, header(req, SCOPE_HEADER), options) === "console"
    ) {
      this.context.markConsoleScope();
    }
    return true;
  }
}
