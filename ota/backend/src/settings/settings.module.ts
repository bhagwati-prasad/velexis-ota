// The settings context (ota/docs/architecture.md §2.1, conventions §2): what the OTA admin edits in console scope. Since
// OBE-070: the storefront settings (console.settings.storefront.get and update), which read and write the row through
// the storefront context's repository (StorefrontModule exports it; it never imports this module). Since OBE-069: the
// markup and fee rules (console.settings.markupRules.* and feeRules.*, pricing-rules.service.ts), which read and write
// the rows through the pricing context's repository (PricingModule exports it), the one the engine loads them with.
// Assets (OBE-071), content pages (OBE-072) and notification templates (OBE-073) join here. The console audit
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

@Module({
  imports: [TenancyModule.forApi(), StorefrontModule, PricingModule],
  controllers: [StorefrontSettingsController, MarkupRulesController, FeeRulesController],
  providers: [StorefrontSettingsService, PricingRulesService],
})
export class SettingsModule {}
