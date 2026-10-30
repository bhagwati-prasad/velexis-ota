// The Stripe Connect Standard routes of the portal (PBE-055; platform/docs/api-inventory-resources.md §4,
// flows/stripe-payments-account.md §C, PADR-0011, scope PF-61 AC1). Thin: each handler binds its operation, reads the
// validated request and makes one StripeConnectService call.
//
// - `startStripeConnect` (`POST /v1/tenants/{tenantId}/payment-connections/stripe-connect/start`): owners and admins.
//   The operation is `x-mfa-step-up` and `x-feature: own_stripe`, so TenantRoleGuard (`404` to non-members, `403` to
//   the other roles), RecentMfaGuard (`401 REAUTH_REQUIRED`, `403 MFA_REQUIRED`) and FeatureGuard (`403
//   FEATURE_DISABLED`) answer before the handler. The answer holds the single-use OAuth state, so it is sent with
//   `Cache-Control: no-store`, set before the service runs (its refusals carry it too).
// - `completeStripeConnect` (`POST /v1/payment-connections/stripe-connect/callback`): the portal's callback page posts
//   what Stripe sent back for the signed-in account; the OTA is the state's, so the path names none and no tenant guard
//   runs: the service checks the state's account, the membership, the OTA and its connections. The operation is
//   `x-feature: own_stripe` too (FIX-W36-PLATFORM, lead decision (2h) of 2026-10-30), so FeatureGuard answers `403
//   FEATURE_DISABLED` while the switch is off, before the handler takes the state. The answer is the OTA and its
//   connections as `listPaymentConnections` maps them. `code` and `state` are write-only: nothing here logs the body.
import { Controller, HttpCode, Post, Res } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import { toPaymentConnection } from "./payment-connections.controller";
import {
  StripeConnectService,
  type CompleteStripeConnectRequest,
  type StripeConnectStart,
} from "./stripe-connect.service";

export type StripeConnectCompleted = components["schemas"]["StripeConnectCompleted"];

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller()
export class StripeConnectController {
  constructor(private readonly connect: StripeConnectService) {}

  @Post("v1/tenants/:tenantId/payment-connections/stripe-connect/start")
  @HttpCode(200)
  @OpenApiOperation("startStripeConnect")
  @TenantRoles(...tenantRolesOf("startStripeConnect"))
  startStripeConnect(
    @CurrentMembership() membership: TenantMembership,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<StripeConnectStart> {
    res.setHeader("Cache-Control", "no-store");
    return this.connect.start(membership);
  }

  @Post("v1/payment-connections/stripe-connect/callback")
  @HttpCode(200)
  @OpenApiOperation("completeStripeConnect")
  async completeStripeConnect(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: CompleteStripeConnectRequest,
  ): Promise<StripeConnectCompleted> {
    const completed = await this.connect.complete(token.sub, body);
    return { tenantId: completed.tenantId, connections: completed.connections.map(toPaymentConnection) };
  }
}
