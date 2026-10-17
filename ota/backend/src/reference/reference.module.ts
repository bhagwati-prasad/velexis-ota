// The reference context (ota/docs/architecture.md §2.1, OBE-015): the six read-only `reference.*` operations over the
// shared `reference` schema, through the tenancy module's `TenantTx`. API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { TenancyModule } from "../tenancy/tenancy.module";
import { ReferenceController } from "./reference.controller";
import { ReferenceRepository } from "./reference.repository";
import { ReferenceService } from "./reference.service";

@Module({
  imports: [TenancyModule.forApi()],
  controllers: [ReferenceController],
  providers: [ReferenceService, ReferenceRepository],
})
export class ReferenceModule {}
