// The portal's billing actions of M5 (platform/docs/api-inventory-resources.md §6, subscription-billing flow §B and §F,
// PBE-044): `createCheckoutSession` and `createCustomerPortalSession`. Thin: each handler binds its operation, reads
// the validated request and makes one CheckoutService call. Owners only (`manageBilling` of the role matrix):
// TenantRoleGuard answers `404` to non-members and `403 FORBIDDEN` to the other roles, then FeatureGuard answers `403
// FEATURE_DISABLED` while `FEATURE_STRIPE_BILLING` is off (`x-feature: stripe_billing`). The Checkout is idempotent
// through the global IdempotencyInterceptor (`x-idempotent: true`), whose `Idempotency-Key` is also part of Stripe's
// key; the Customer Portal URL signs its holder in, so it is sent with `Cache-Control: no-store` and never stored for
// a replay. Nothing here logs a body or a URL.
import { Controller, HttpCode, Post, Res } from "@nestjs/common";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { IDEMPOTENCY_KEY_HEADER } from "../common/http/idempotency.interceptor";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import {
  CheckoutService,
  type CheckoutSession,
  type CreateCheckoutSessionRequest,
  type CustomerPortalSession,
} from "./checkout.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/tenants/:tenantId/billing")
export class BillingController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post("checkout-session")
  @HttpCode(201)
  @OpenApiOperation("createCheckoutSession")
  @TenantRoles(...tenantRolesOf("createCheckoutSession"))
  createCheckoutSession(
    @CurrentMembership() membership: TenantMembership,
    @Validated("header") header: Readonly<Record<string, unknown>>,
    @Validated("body") body: CreateCheckoutSessionRequest,
  ): Promise<CheckoutSession> {
    // Required by the document, so the validation interceptor has checked it before the handler runs.
    return this.checkout.createCheckoutSession(membership, body, header[IDEMPOTENCY_KEY_HEADER] as string);
  }

  @Post("portal-session")
  @HttpCode(201)
  @OpenApiOperation("createCustomerPortalSession")
  @TenantRoles(...tenantRolesOf("createCustomerPortalSession"))
  async createCustomerPortalSession(
    @CurrentMembership() membership: TenantMembership,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<CustomerPortalSession> {
    const session = await this.checkout.createCustomerPortalSession(membership);
    res.setHeader("Cache-Control", "no-store");
    return session;
  }
}
