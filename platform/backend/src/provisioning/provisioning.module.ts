// ProvisioningModule (platform/docs/architecture.md §2.1, layer 2; PADR-0001): owns `provisioning_jobs` and
// `tenant_schema_migrations`, and the tenant lifecycle use cases that span the resource modules of layer 1, so those
// stay simple (architecture §2.2). PBE-018 brings the create-OTA transaction, PBE-019 the dispatch to the OTA worker,
// PBE-022 the tenant-event consumer and the post-steps, PBE-023 the failure handler, the reconciler, the purge of
// unrevealed keys and the portal's setup progress, retry and one-time key reveal; the later lifecycle actions follow.
//
// - The static module holds what the API uses: the jobs repository, ProvisioningDispatcher (on the `ota-tenant-ops`
//   queue of QueuesModule), and the layer-1 modules whose repositories the use cases write through (AuthModule for the
//   account, TenantsModule, the global MembershipsModule, BillingModule, DomainsModule) and AuditModule.
// - `ProvisioningModule.forApi()` (AppModule) adds the portal's lifecycle routes, LifecycleService, and
//   OnboardingService with its read-only OnboardingRepository (the checklist of PADR-0018, PBE-024).
// - `ProvisioningModule.forWorker()` (WorkerModule) is the worker's part, in a module of its own (ProvisioningWorker-
//   Module), so the worker gets none of the portal's routes and services: the one processor of
//   `platform-tenant-events` (TenantEventsProcessor), the post-steps it runs (PostStepsRunner and the six steps of
//   post-steps/), the failure handler both it and the reconciler end failed attempts with, the dispatcher, and the
//   `@MaintenanceJob` handlers of `provisioning.reconcile` and `provisioning.purge_reveals`, which the one
//   `platform-maintenance` processor runs. They write through the repositories of the layer-1 modules they import
//   (ApiKeysModule, SupplierConnectionsModule, PaymentConnectionsModule) and through TenantsRepository and
//   MembershipsRepository, provided here on their own because their modules carry the portal's routes.
//   NotificationsModule queues the e-mails (ops alerts, `tenant.welcome`, `tenant.provisioning_failed`) and AuditModule
//   writes the audit rows.
//
// It uses the global CommonModule (Clock, IdGenerator, FeatureSwitches, PLATFORM_DB, EnvelopeService, and
// RequestContext in the API) and RedisModule (InvalidationPublisher).
import { Module, type DynamicModule } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { QueuesModule } from "../common/queues/queues.module";
import { DomainsModule } from "../domains/domains.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { MembershipsRepository } from "../memberships/memberships.repository";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentConnectionsModule } from "../payment-connections/payment-connections.module";
import { SupplierConnectionsModule } from "../supplier-connections/supplier-connections.module";
import { TenantsModule } from "../tenants/tenants.module";
import { TenantsRepository } from "../tenants/tenants.repository";
import { ProvisioningDispatcher } from "./dispatcher";
import { ProvisioningFailureHandler } from "./failure-handler";
import { LifecycleController } from "./lifecycle.controller";
import { LifecycleService } from "./lifecycle.service";
import { OnboardingRepository } from "./onboarding.repository";
import { OnboardingService } from "./onboarding.service";
import { ActivateStep } from "./post-steps/activate.step";
import { AssignAmadeusOfficeStep } from "./post-steps/assign-amadeus-office.step";
import { CreatePaymentConnectionStep } from "./post-steps/create-payment-connection.step";
import { IssueApiKeysStep } from "./post-steps/issue-api-keys.step";
import { NotifyStep } from "./post-steps/notify.step";
import { PostStepsRunner } from "./post-steps/post-steps.runner";
import { RecordMigrationsStep } from "./post-steps/record-migrations.step";
import { ProvisioningJobsRepository } from "./provisioning-jobs.repository";
import { PurgeRevealsScheduler } from "./purge-reveals.scheduler";
import { ReconcilerScheduler } from "./reconciler.scheduler";
import { TenantEventsProcessor } from "./tenant-events.processor";

/**
 * The worker's part of ProvisioningModule (`ProvisioningModule.forWorker()`): the `platform-tenant-events` processor,
 * the post-steps, the failure handler, the reconciler and the purge of unrevealed keys.
 */
@Module({
  imports: [
    QueuesModule,
    AuditModule,
    NotificationsModule,
    ApiKeysModule,
    SupplierConnectionsModule,
    PaymentConnectionsModule,
  ],
  providers: [
    ProvisioningJobsRepository,
    TenantsRepository,
    MembershipsRepository,
    RecordMigrationsStep,
    AssignAmadeusOfficeStep,
    CreatePaymentConnectionStep,
    IssueApiKeysStep,
    ActivateStep,
    NotifyStep,
    PostStepsRunner,
    ProvisioningDispatcher,
    ProvisioningFailureHandler,
    TenantEventsProcessor,
    ReconcilerScheduler,
    PurgeRevealsScheduler,
  ],
})
export class ProvisioningWorkerModule {}

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
  /** The one `forApi()` module object of the process. */
  private static apiModule: DynamicModule | undefined;

  /**
   * The module with the portal's lifecycle routes, for AppModule; AdminModule imports it too, for the jobs repository
   * and the dispatcher (PBE-031). It is one object for every caller: Nest tells dynamic modules apart by reference, so
   * both imports share one module instance, and the API has exactly one ProvisioningDispatcher.
   */
  static forApi(): DynamicModule {
    ProvisioningModule.apiModule ??= {
      module: ProvisioningModule,
      controllers: [LifecycleController],
      providers: [LifecycleService, OnboardingService, OnboardingRepository],
    };
    return ProvisioningModule.apiModule;
  }

  /** The module with the tenant-event processor and the post-steps, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: ProvisioningWorkerModule };
  }
}
