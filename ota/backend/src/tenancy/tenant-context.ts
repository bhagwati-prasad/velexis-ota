// The tenant of the current request (OADR-0009 point 3, db README §5): `{tenantId, key, schemaName, environment,
// caller, actor, requestId}` in the request context (nestjs-cls), set once by the tenant guard (common/auth/
// tenant.guard.ts) from the resolved platform row, never from user input. `TenantTx` (tenant-tx.ts) takes the schema
// name from here, and so does nothing else: no other code passes a schema name around. Repositories, the Amadeus
// client and the payment gateways read the tenant id and the environment here.
//
// The actor starts as the caller: a `guest` for the storefront edge, the `api_key` for a key. The session guards of
// later tasks replace it with the signed-in customer or staff member (`setActor`). Workers that act for a tenant open a
// context of their own with `run` (OADR-0014).
import { Injectable } from "@nestjs/common";
import type { TenantSchema } from "@velexis/db";
import { ClsService } from "nestjs-cls";
import type { Caller } from "./caller-resolver";

/** The environment of a request: the key's, or the tenant's storefront environment for the edge. */
export type TenantEnvironment = "test" | "live";

/** Who sent the request (the caller guard's classification), without the credential details. */
export interface ContextCaller {
  readonly type: Caller["type"];
  readonly id: string;
}

/** Who acts, as the tenant tables record it (`booking_events.actor_type`, `staff_actions.actor_type`). */
export type ActorType = "guest" | "customer" | "staff" | "api_key" | "system";

export interface ContextActor {
  readonly type: ActorType;
  /** `cus_…`, `stf_…` or `key_…`; `null` for a guest and the system. */
  readonly id: string | null;
}

/** The tenant of a request or a job. */
export interface RequestTenant {
  /** `ten_…` */
  readonly tenantId: string;
  /** The tenant key (`<key>.ota.example.com`, `tenant_<key>`). */
  readonly key: string;
  /** `tenant_<key>`, validated when the platform row was read: the only schema name `TenantTx` uses. */
  readonly schemaName: TenantSchema;
  readonly environment: TenantEnvironment;
  readonly caller: ContextCaller;
  readonly actor: ContextActor;
  readonly requestId: string;
}

/** Tenant data was reached where no tenant is resolved: outside a request, or on a route without one. */
export class NoTenantContextError extends Error {
  override readonly name = "NoTenantContextError";

  constructor() {
    super(
      "no tenant in the request context: tenant data is reachable only on an operation whose caller the tenant " +
        "guard resolved, or inside TenantContext.run",
    );
  }
}

const TENANT_KEY = "tenancy.tenant";

@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService) {}

  /** Records the tenant of the current request. Outside a request context it throws: there is nowhere to keep it. */
  set(tenant: RequestTenant): void {
    if (!this.cls.isActive()) {
      throw new Error("TenantContext.set outside a request context");
    }
    this.cls.set(TENANT_KEY, freeze(tenant));
  }

  /** The tenant of the current request, or `undefined` before the tenant guard ran or outside a request. */
  get(): RequestTenant | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const tenant: unknown = this.cls.get(TENANT_KEY);
    return typeof tenant === "object" && tenant !== null ? (tenant as RequestTenant) : undefined;
  }

  /** The tenant of the current request; throws `NoTenantContextError` when there is none. */
  require(): RequestTenant {
    const tenant = this.get();
    if (tenant === undefined) {
      throw new NoTenantContextError();
    }
    return tenant;
  }

  /** Replaces the actor of the current request (a session guard that identified the customer or staff member). */
  setActor(actor: ContextActor): void {
    this.set({ ...this.require(), actor });
  }

  /** The request id of the current request context (`X-Request-Id`), or `undefined` outside one. */
  requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.getId() : undefined;
  }

  /** Runs `fn` in a context of its own with `tenant` (jobs, and tests of tenant code without HTTP). */
  run<T>(tenant: RequestTenant, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(() => {
      this.cls.set(TENANT_KEY, freeze(tenant));
      return fn();
    });
  }
}

function freeze(tenant: RequestTenant): RequestTenant {
  return Object.freeze({
    ...tenant,
    caller: Object.freeze({ ...tenant.caller }),
    actor: Object.freeze({ ...tenant.actor }),
  });
}
