// The storefront context (ota/docs/architecture.md §2.1, OBE-016): `storefront.get`, the bootstrap configuration of
// the hosted storefront and of storefronts built with the SDK, from the tenant's `storefront_settings` through the
// tenancy module's `TenantTx`, cached in Redis per tenant, environment and locale (OADR-0012 point 7). The content
// pages (OBE-072): storefront.listPages and storefront.getPage (PublicPagesController over PublicPagesService, which
// reads `storefront_pages` through `TenantTx`, parses the bodies with markdown-subset.parser.ts and caches them per
// tenant, environment and locale). The public image URL getPublicAsset (OBE-071): PublicAssetsController over
// PublicAssetsService, which reads the asset rows through this module's repository and the files through the
// StorageAdapter of ADR-0017 (the documents module's `documentStorageProvider`, as the settings context builds it for
// the uploads). The payment section's account comes from the payment gateway (PaymentGatewayModule, OBE-038), and so
// does the airline card's suspension (its abuse limits, AirlineCardLimits; FIX-W29-OTA). It exports its repository to
// the settings context, whose console operations read and write the same rows (OBE-070, OBE-071). The dependency is
// one way, settings → storefront: nothing under src/storefront imports src/settings (lead decision (2a) of
// 2026-10-30, FIX-W34-OTA; module-direction.test.ts). API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { CookieWriter } from "../common/http/cookie-writer";
import { documentStorageProvider } from "../documents/documents.module";
import { PaymentGatewayModule } from "../payments/payments.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { PublicAssetsController } from "./public-assets.controller";
import { PublicAssetsService } from "./public-assets.service";
import { PublicPagesController } from "./public-pages.controller";
import { PublicPagesService } from "./public-pages.service";
import { StorefrontController } from "./storefront.controller";
import { StorefrontRepository } from "./storefront.repository";
import { StorefrontService } from "./storefront.service";

@Module({
  imports: [TenancyModule.forApi(), PaymentGatewayModule],
  controllers: [StorefrontController, PublicAssetsController, PublicPagesController],
  providers: [
    StorefrontService,
    StorefrontRepository,
    CookieWriter,
    PublicAssetsService,
    PublicPagesService,
    documentStorageProvider,
  ],
  exports: [StorefrontRepository],
})
export class StorefrontModule {}
