// AdminModule (platform/docs/architecture.md §2.1, layer 4): the thin controllers of the platform admin's API over the
// services of the modules below it (PADR-0006). It owns no table. Every route is `x-scope: platform_admin`
// (AdminAuthGuard), and every change is audited by the service it calls, with `actor_type = 'platform_admin'`.
//
// - AdminAmadeusController: the Velexis Amadeus accounts and the office pool (SupplierConnectionsModule, PBE-020).
//
// Later tasks add the admin's auth controller (PBE-028), the dashboard, tenants, jobs and queues (PBE-029, PBE-030)
// and the other areas of platform/docs/api-inventory-admin.md, one controller per area.
import { Module } from "@nestjs/common";
import { SupplierConnectionsModule } from "../supplier-connections/supplier-connections.module";
import { AdminAmadeusController } from "./admin-amadeus.controller";

@Module({
  imports: [SupplierConnectionsModule.forApi()],
  controllers: [AdminAmadeusController],
})
export class AdminModule {}
