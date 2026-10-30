// The settings context (ota/docs/architecture.md §2.1, conventions §2): what the OTA admin edits in console scope. Since
// OBE-070: the storefront settings (console.settings.storefront.get and update), which read and write the row through
// the storefront context's repository (StorefrontModule exports it; it never imports this module). Since OBE-069: the
// markup and fee rules (console.settings.markupRules.* and feeRules.*, pricing-rules.service.ts), which read and write
// the rows through the pricing context's repository (PricingModule exports it), the one the engine loads them with.
// Since OBE-073: the notification templates (console.settings.templates.*, templates.service.ts), which read, check,
// render and write the rows through the notifications module's TemplateService (global, NotificationsModule.forApi),
// the engine e-mails are rendered with. Since OBE-071: the storefront assets (console.settings.assets.list, upload and
// delete, assets.service.ts), whose rows go through the storefront context's repository and whose files go through
// the StorageAdapter of ADR-0017 (documentStorageProvider: STORAGE_DRIVER and STORAGE_DIR, as the documents module
// builds it), with the idempotency hooks of the upload; their public image URL getPublicAsset is the storefront
// context's (StorefrontModule: storefront/public-assets.controller.ts and public-assets.service.ts), since the
// dependency is one way, settings → storefront (lead decision (2a) of 2026-10-30, FIX-W34-OTA). Content pages
// (OBE-072) join here. The console audit (StaffActionsWriter) is global (console.module.ts). API only; the worker
// never imports it.
import { Module } from "@nestjs/common";
import { documentStorageProvider } from "../documents/documents.module";
import { PricingModule } from "../pricing/pricing.module";
import { StorefrontModule } from "../storefront/storefront.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AssetsController } from "./assets.controller";
import { AssetsService, AssetUploadIdempotencyHooks } from "./assets.service";
import { FeeRulesController } from "./fee-rules.controller";
import { MarkupRulesController } from "./markup-rules.controller";
import { PricingRulesService } from "./pricing-rules.service";
import { StorefrontSettingsController } from "./storefront-settings.controller";
import { StorefrontSettingsService } from "./storefront-settings.service";
import { NotificationTemplatesController } from "./templates.controller";
import { TemplateSettingsService } from "./templates.service";

@Module({
  imports: [TenancyModule.forApi(), StorefrontModule, PricingModule],
  controllers: [
    StorefrontSettingsController,
    MarkupRulesController,
    FeeRulesController,
    NotificationTemplatesController,
    AssetsController,
  ],
  providers: [
    StorefrontSettingsService,
    PricingRulesService,
    TemplateSettingsService,
    AssetsService,
    AssetUploadIdempotencyHooks,
    documentStorageProvider,
  ],
})
export class SettingsModule {}
