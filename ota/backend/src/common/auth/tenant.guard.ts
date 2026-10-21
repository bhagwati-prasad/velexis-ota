// The tenant guard (architecture §3 step 5, OADR-0009 points 2 and 3): the second guard of every route, after the
// caller guard. On a handler bound to an operation of the OTA document (`@OpenApiOperation`), an edge, key or service
// caller gets its tenant resolved (tenancy/tenant-resolver.ts: verified host, the key's tenant, the located tenant of
// the OTA admin; active tenants only) and recorded in the request context (`TenantContext`), from which `TenantTx`
// takes the schema. A refused request never reaches validation or the handler: `403 HOST_NOT_ALLOWED`,
// `403 TENANT_SUSPENDED`, or `503 SERVICE_UNAVAILABLE` when the platform tables cannot be read.
//
// It leaves alone:
//   - the anonymous caller of public, webhook and local routes: those routes find their tenant themselves (the
//     tenant key in an asset path, a signed file key, the Stripe event) or have none (health);
//   - routes that are not operations of the document (the health endpoints) and the 501 routes of pending
//     operations, which answer without touching tenant data, as they skip validation.
// The route-parity contract test keeps every other route bound to an operation, so every route that can reach tenant
// data passes here. Without a tenant in the context, `TenantTx` throws before any SQL.
//
// The OTA admin's service caller (OBE-060; OADR-0009 point 2, OADR-0011 points 4 and 5) on a console operation
// (anything else is the scope guard's refusal, and gets no tenant here):
//
//   X-Velexis-Environment      required, `test` or `live` (`400 VALIDATION_FAILED` at /header/X-Velexis-Environment)
//   the tenant                 console.auth.signIn: the portal token's (read with GET; the sign-in takes it with
//                              GETDEL after the rate limit); console.auth.refresh: the refresh token's family's;
//                              console.auth.signOut: the staff token's `tid`, else the refresh token's family's;
//                              every other console operation: the staff token's `tid` (signature checked, also when
//                              expired, so that the staff guard answers `401 TOKEN_EXPIRED`), and without a staff
//                              token of this platform `401 UNAUTHENTICATED`
//   live                       recorded as asked: that live needs a live tenant (`storefront_environment = live`) and
//                              a role other than viewer (`403 ENVIRONMENT_NOT_ALLOWED`) is the permission guard's check
//                              (and the sign-in's for the role), after the staff guard and the rate limits, so that the
//                              denied attempt is audited with its staff member (OADR-0011 point 8); nothing between the
//                              two reads tenant data
//
// A staff-session operation whose credential names no tenant (an unknown portal token, refresh token or sign-out)
// gets no tenant: its handler answers as for an unknown credential (`401 PORTAL_TOKEN_INVALID`,
// `401 REFRESH_TOKEN_INVALID`, the sign-out's 204), after the rate limits have counted it. The staff guard verifies the
// located staff token against the tenant afterwards, as for any caller: the unverified `tid` only chooses which
// tenant's token it must be. The actor of a service request starts as `system` until the staff guard sets the staff
// member.
//
// `X-Velexis-Environment` is refused (`400 VALIDATION_FAILED`) from a secret key on a console operation: its
// environment is the key's (the document's VelexisEnvironment); the edge and publishable keys get the scope guard's
// refusal there.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { AppError } from "@velexis/errors";
import type { Request } from "express";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { StaffSessions, StaffTokens } from "../../identity/staff/staff-sessions";
import { bearerTokenOf } from "../../identity/token.service";
import { CallerContext, type Caller } from "../../tenancy/caller-resolver";
import { TenantContext, type ContextActor, type TenantEnvironment } from "../../tenancy/tenant-context";
import { TenantResolver, type ResolvedTenant } from "../../tenancy/tenant-resolver";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import { scopedOperation } from "./scope.guard";

/** `X-Velexis-Environment`, lower case as Node gives header names. */
export const ENVIRONMENT_HEADER = "x-velexis-environment";

const ENVIRONMENTS: readonly TenantEnvironment[] = ["test", "live"];

/** The actor before any session guard: the storefront visitor is a guest, a key acts as itself, the service as none. */
function initialActor(caller: Exclude<Caller, { type: "anonymous" }>): ContextActor {
  switch (caller.type) {
    case "edge":
      return { type: "guest", id: null };
    case "service":
      return { type: "system", id: null };
    case "key":
      return { type: "api_key", id: caller.keyId };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A string property of the (not yet validated) JSON body, or `undefined`. */
function bodyString(req: Request, property: string): string | undefined {
  const body: unknown = req.body;
  const value = isObject(body) ? body[property] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** `X-Velexis-Environment` of a service request; `400 VALIDATION_FAILED` when it is missing or not `test`/`live`. */
export function serviceEnvironmentOf(headers: Request["headers"]): TenantEnvironment {
  const value = headers[ENVIRONMENT_HEADER];
  const text = typeof value === "string" ? value.trim() : "";
  const environment = ENVIRONMENTS.find((candidate) => candidate === text);
  if (environment === undefined) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        {
          path: "/header/X-Velexis-Environment",
          code: text === "" ? "required" : "enum",
          message: "X-Velexis-Environment must be test or live with the OTA admin's service key",
        },
      ],
    });
  }
  return environment;
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly callers: CallerContext,
    private readonly resolver: TenantResolver,
    private readonly tenants: TenantContext,
    private readonly sessions: StaffSessions,
    private readonly tokens: StaffTokens,
    @InjectPinoLogger(TenantGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }
    const operationId = this.reflector.get<OtaOperationId | undefined>(
      OPENAPI_OPERATION,
      context.getHandler(),
    );
    if (operationId === undefined) {
      return true;
    }
    const caller = this.callers.get();
    if (caller === undefined) {
      throw new Error("TenantGuard ran without a caller in the request context; CallerGuard must run first");
    }
    if (caller.type === "anonymous") {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const consoleOperation = scopedOperation(operationId).scope === "console";
    let resolved: ResolvedTenant;
    if (caller.type === "service") {
      if (!consoleOperation) {
        // The scope guard refuses the service caller anything but console operations.
        return true;
      }
      const environment = serviceEnvironmentOf(req.headers);
      const tenantId = await this.serviceTenantId(operationId, req);
      if (tenantId === undefined) {
        return true;
      }
      resolved = await this.resolver.resolveService(caller, tenantId, environment);
    } else {
      // A publishable key or the edge on a console operation is the scope guard's refusal.
      const secretKey = caller.type === "key" && caller.kind === "secret";
      if (consoleOperation && secretKey && req.headers[ENVIRONMENT_HEADER] !== undefined) {
        throw new AppError("VALIDATION_FAILED", {
          fieldErrors: [
            {
              path: "/header/X-Velexis-Environment",
              code: "not_allowed",
              message:
                "X-Velexis-Environment is for the OTA admin's service key; a key acts in its own environment",
            },
          ],
        });
      }
      resolved = await this.resolver.resolve(caller);
    }
    const { tenant, environment } = resolved;
    this.tenants.set({
      tenantId: tenant.id,
      key: tenant.key,
      schemaName: tenant.schemaName,
      environment,
      caller: { type: caller.type, id: caller.id },
      actor: initialActor(caller),
      requestId: this.tenants.requestId() ?? "",
    });
    return true;
  }

  /**
   * The tenant a service request's staff credential names (see the file header), or `undefined` for a staff-session
   * operation whose credential names none. Throws `401 UNAUTHENTICATED` for another console operation without a
   * staff token of this platform.
   */
  private async serviceTenantId(operationId: OtaOperationId, req: Request): Promise<string | undefined> {
    const bearer = bearerTokenOf(req.headers);
    if (operationId === "consoleSignIn") {
      const portalToken = bodyString(req, "portalToken");
      return portalToken === undefined
        ? undefined
        : (await this.sessions.peekPortalToken(portalToken))?.tenantId;
    }
    if (operationId === "consoleRefreshSession") {
      return this.familyTenantId(bodyString(req, "refreshToken"));
    }
    const tid = bearer === undefined ? undefined : await this.tokens.tenantOf(bearer);
    if (operationId === "consoleSignOut") {
      return tid ?? this.familyTenantId(bodyString(req, "refreshToken"));
    }
    if (tid === undefined) {
      // The service key alone opens nothing (OADR-0011 point 4); the token is never logged.
      this.logger.info(
        { reason: bearer === undefined ? "missing" : "not_a_staff_token", callerType: "service" },
        "staff.token_refused",
      );
      throw new AppError("UNAUTHENTICATED");
    }
    return tid;
  }

  /** The tenant of the family a refresh token names, or `undefined`. */
  private async familyTenantId(refreshToken: string | undefined): Promise<string | undefined> {
    return refreshToken === undefined ? undefined : (await this.sessions.familyOf(refreshToken))?.tenantId;
  }
}
