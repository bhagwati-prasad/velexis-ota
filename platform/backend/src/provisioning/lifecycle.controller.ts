// The tenant lifecycle routes of the portal (platform/docs/api-inventory.md §7): `createTenant` (PBE-018), the setup
// page's progress, retry and one-time key reveal (PBE-023), and the onboarding checklist (PBE-024). Thin: each handler
// binds its operation, reads the validated request and makes one service call. `POST /v1/tenants` is no tenant route
// (there is no tenant yet), so it has no `@TenantRoles`: PortalAuthGuard needs a verified portal account
// (`x-scope: portal`), and the global IdempotencyInterceptor makes it idempotent (`x-idempotent: true`). The routes
// under `/v1/tenants/{tenantId}` declare their roles from the role matrix (`tenantRolesOf`): any member reads the
// progress and the checklist, owners retry and reveal; TenantRoleGuard answers `404` to non-members before the handler
// runs. The reveal's answer holds the full keys once, so it is sent with `Cache-Control: no-store`; nothing here logs
// a body.
import { Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { IDEMPOTENCY_KEY_HEADER } from "../common/http/idempotency.interceptor";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import {
  LifecycleService,
  type CreateTenantRequest,
  type InitialKeys,
  type ProvisioningRetried,
  type ProvisioningStatus,
  type TenantCreated,
} from "./lifecycle.service";
import { OnboardingService, type OnboardingChecklist } from "./onboarding.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/tenants")
export class LifecycleController {
  constructor(
    private readonly lifecycle: LifecycleService,
    private readonly onboarding: OnboardingService,
  ) {}

  @Post()
  @HttpCode(202)
  @OpenApiOperation("createTenant")
  createTenant(
    @AccessToken() token: AccessTokenClaims,
    @Validated("header") header: Readonly<Record<string, unknown>>,
    @Validated("body") body: CreateTenantRequest,
  ): Promise<TenantCreated> {
    // The key is required by the document (checked before the handler runs); from M5 it is part of Stripe's key too.
    return this.lifecycle.createTenant(token.sub, body, header[IDEMPOTENCY_KEY_HEADER] as string);
  }

  @Get(":tenantId/provisioning")
  @OpenApiOperation("getProvisioning")
  @TenantRoles(...tenantRolesOf("getProvisioning"))
  getProvisioning(@CurrentMembership() membership: TenantMembership): Promise<ProvisioningStatus> {
    return this.lifecycle.getProvisioning(membership);
  }

  @Post(":tenantId/provisioning/retry")
  @HttpCode(202)
  @OpenApiOperation("retryProvisioning")
  @TenantRoles(...tenantRolesOf("retryProvisioning"))
  retryProvisioning(@CurrentMembership() membership: TenantMembership): Promise<ProvisioningRetried> {
    return this.lifecycle.retryProvisioning(membership);
  }

  @Post(":tenantId/initial-keys/reveal")
  @HttpCode(200)
  @OpenApiOperation("revealInitialKeys")
  @TenantRoles(...tenantRolesOf("revealInitialKeys"))
  revealInitialKeys(
    @CurrentMembership() membership: TenantMembership,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<InitialKeys> {
    // The keys are shown once (PADR-0005 item 4): never cached, and never stored for an idempotent replay.
    res.setHeader("Cache-Control", "no-store");
    return this.lifecycle.revealInitialKeys(membership);
  }

  @Get(":tenantId/onboarding")
  @OpenApiOperation("getOnboarding")
  @TenantRoles(...tenantRolesOf("getOnboarding"))
  getOnboarding(@CurrentMembership() membership: TenantMembership): Promise<OnboardingChecklist> {
    return this.onboarding.get(membership);
  }
}
