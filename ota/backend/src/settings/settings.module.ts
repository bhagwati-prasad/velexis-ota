// The settings context (ota/docs/architecture.md §2.1, conventions §2): what the OTA admin edits in console scope. Since
// OBE-070: the storefront settings (console.settings.storefront.get and update), which read and write the row through
// the storefront context's repository (StorefrontModule exports it; it never imports this module). Markup and fee
// rules (OBE-069), assets (OBE-071), content pages (OBE-072) and notification templates (OBE-073) join here. The
// console audit (StaffActionsWriter) is global (console.module.ts). API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { StorefrontModule } from "../storefront/storefront.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { StorefrontSettingsController } from "./storefront-settings.controller";
import { StorefrontSettingsService } from "./storefront-settings.service";

@Module({
  imports: [TenancyModule.forApi(), StorefrontModule],
  controllers: [StorefrontSettingsController],
  providers: [StorefrontSettingsService],
})
export class SettingsModule {}
