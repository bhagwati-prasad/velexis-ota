// The settings context (ota/docs/architecture.md §2.1, conventions §2): what the OTA admin edits in console scope. Since
// OBE-070: the storefront settings (console.settings.storefront.get and update), which read and write the row through
// the storefront context's repository (StorefrontModule exports it; it never imports this module). Since OBE-069: the
// markup and fee rules (console.settings.markupRules.* and feeRules.*, pricing-rules.service.ts), which read and write
// the rows through the pricing context's repository (PricingModule exports it), the one the engine loads them with.
// Since OBE-073: the notification templates (console.settings.templates.*, templates.service.ts), which read, check,
// render and write the rows through the notifications module's TemplateService (global, NotificationsModule.forApi),
// the engine e-mails are rendered with. Assets (OBE-071) and content pages (OBE-072) join here. The console audit
// (StaffActionsWriter) is global (console.module.ts). API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { StorefrontModule } from "../storefront/storefront.module";
import { TenancyModule } from "../tenancy/tenancy.module";
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
  ],
  providers: [StorefrontSettingsService, PricingRulesService, TemplateSettingsService],
})
export class SettingsModule {}
