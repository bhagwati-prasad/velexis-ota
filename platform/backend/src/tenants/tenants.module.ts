// TenantsModule (platform/docs/architecture.md §2.1, layer 1): owns `tenants`: the key rules and the key check, the
// lists and reads of the portal, and the profile update (PBE-017). ProvisioningModule (layer 2) imports it for the
// create, activate, suspend and resume use cases (PBE-018 onwards), which reuse its repository and `toTenant`.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TenantsController } from "./tenants.controller";
import { TenantsRepository } from "./tenants.repository";
import { TenantsService } from "./tenants.service";

@Module({
  imports: [AuditModule],
  controllers: [TenantsController],
  providers: [TenantsRepository, TenantsService],
  exports: [TenantsRepository, TenantsService],
})
export class TenantsModule {}
