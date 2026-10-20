// The storefront context (ota/docs/architecture.md §2.1, OBE-016): `storefront.get`, the bootstrap configuration of
// the hosted storefront and of storefronts built with the SDK, from the tenant's `storefront_settings` through the
// tenancy module's `TenantTx`, cached in Redis per tenant, environment and locale (OADR-0012 point 7). The content
// pages and the public assets join in M4 (OBE-071, OBE-072). The payment section's account comes from the payment
// gateway (PaymentGatewayModule, OBE-038). API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { CookieWriter } from "../common/http/cookie-writer";
import { PaymentGatewayModule } from "../payments/payments.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { StorefrontController } from "./storefront.controller";
import { StorefrontRepository } from "./storefront.repository";
import { StorefrontService } from "./storefront.service";

@Module({
  imports: [TenancyModule.forApi(), PaymentGatewayModule],
  controllers: [StorefrontController],
  providers: [StorefrontService, StorefrontRepository, CookieWriter],
})
export class StorefrontModule {}
