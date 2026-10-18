// ProvisioningModule (platform/docs/architecture.md §2.1, layer 2; PADR-0001): owns `provisioning_jobs` and
// `tenant_schema_migrations`, and the tenant lifecycle use cases that span the resource modules of layer 1, so those
// stay simple (architecture §2.2). PBE-018 brings the create-OTA transaction and PBE-019 the dispatch to the OTA worker;
// the tenant-event consumer and post-steps (PBE-022), the reconciler, retries and key reveal (PBE-023) and the later
// lifecycle actions follow.
//
// - The static module holds what the API and the worker share: the jobs repository, ProvisioningDispatcher (on the
//   `ota-tenant-ops` queue of QueuesModule), and the layer-1 modules whose repositories the use cases write through
//   (AuthModule for the account, TenantsModule, the global MembershipsModule, BillingModule, DomainsModule) and
//   AuditModule.
// - `ProvisioningModule.forApi()` (AppModule) adds the portal's lifecycle routes and LifecycleService. The worker's
//   part (the tenant-event processor) comes with PBE-022.
//
// It uses the global CommonModule (Clock, IdGenerator, FeatureSwitches, PLATFORM_DB, and RequestContext in the API)
// and RedisModule.
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { QueuesModule } from "../common/queues/queues.module";
import { DomainsModule } from "../domains/domains.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { TenantsModule } from "../tenants/tenants.module";
import { ProvisioningDispatcher } from "./dispatcher";
import { LifecycleController } from "./lifecycle.controller";
import { LifecycleService } from "./lifecycle.service";
import { ProvisioningJobsRepository } from "./provisioning-jobs.repository";

@Module({
  imports: [
    QueuesModule,
    AuditModule,
    AuthModule,
    TenantsModule,
    MembershipsModule,
    BillingModule,
    DomainsModule,
  ],
  providers: [ProvisioningJobsRepository, ProvisioningDispatcher],
  exports: [ProvisioningJobsRepository, ProvisioningDispatcher],
})
export class ProvisioningModule {
  /** The module with the portal's lifecycle routes, for AppModule. */
  static forApi(): DynamicModule {
    return {
      module: ProvisioningModule,
      controllers: [LifecycleController],
      providers: [LifecycleService],
    };
  }
}
