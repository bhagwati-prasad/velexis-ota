// The tenant lifecycle routes of the portal (platform/docs/api-inventory.md §7): `createTenant` (PBE-018); the setup
// progress, the retry and the one-time key reveal follow with PBE-023. Thin: each handler binds its operation, reads
// the validated request and makes one service call. `POST /v1/tenants` is no tenant route (there is no tenant yet), so
// it has no `@TenantRoles`: PortalAuthGuard needs a verified portal account (`x-scope: portal`), and the global
// IdempotencyInterceptor makes it idempotent (`x-idempotent: true`).
import { Controller, HttpCode, Post } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { LifecycleService, type CreateTenantRequest, type TenantCreated } from "./lifecycle.service";

@Controller("v1/tenants")
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  @Post()
  @HttpCode(202)
  @OpenApiOperation("createTenant")
  createTenant(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: CreateTenantRequest,
  ): Promise<TenantCreated> {
    return this.lifecycle.createTenant(token.sub, body);
  }
}
