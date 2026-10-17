// The tenant guard (architecture §3 step 5, OADR-0009 points 2 and 3): the second guard of every route, after the
// caller guard. On a handler bound to an operation of the OTA document (`@OpenApiOperation`), an edge or key caller
// gets its tenant resolved (tenancy/tenant-resolver.ts: verified host or the key's tenant, active tenants only) and
// recorded in the request context (`TenantContext`), from which `TenantTx` takes the schema. A refused request never
// reaches validation or the handler: `403 HOST_NOT_ALLOWED`, `403 TENANT_SUSPENDED`, or `503 SERVICE_UNAVAILABLE` when
// the platform tables cannot be read.
//
// It leaves alone:
//   - the anonymous caller of public, webhook and local routes: those routes find their tenant themselves (the
//     tenant key in an asset path, a signed file key, the Stripe event) or have none (health);
//   - routes that are not operations of the document (the health endpoints) and the 501 routes of pending
//     operations, which answer without touching tenant data, as they skip validation.
// The route-parity contract test keeps every other route bound to an operation, so every route that can reach tenant
// data passes here. Without a tenant in the context, `TenantTx` throws before any SQL.
//
// The OTA admin's service caller (staff token `tid`, `X-Velexis-Environment`) joins with OBE-060.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CallerContext, type Caller } from "../../tenancy/caller-resolver";
import { TenantContext, type ContextActor } from "../../tenancy/tenant-context";
import { TenantResolver } from "../../tenancy/tenant-resolver";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";

/** The actor before any session guard: the storefront visitor is a guest, a key acts as itself. */
function initialActor(caller: Exclude<Caller, { type: "anonymous" }>): ContextActor {
  return caller.type === "edge" ? { type: "guest", id: null } : { type: "api_key", id: caller.keyId };
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly callers: CallerContext,
    private readonly resolver: TenantResolver,
    private readonly tenants: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }
    const operationId = this.reflector.get<string | undefined>(OPENAPI_OPERATION, context.getHandler());
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
    const { tenant, environment } = await this.resolver.resolve(caller);
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
}
