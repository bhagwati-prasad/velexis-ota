// SupplierConnectionsModule (platform/docs/architecture.md §2.1, layer 1; ADR-0012, PADR-0012): owns
// `amadeus_accounts`, `amadeus_offices` and `supplier_connections`. The static module holds what every process shares:
// the three repositories, exported for the modules of a higher layer (ProvisioningModule assigns a test office and
// creates the `velexis` connection of a new OTA, PBE-022).
//
// - `SupplierConnectionsModule.forApi()` (AdminModule) adds the platform admin's use cases, exported for its
//   controllers: the Velexis Amadeus accounts (AmadeusAccountsService) and the office pool (AmadeusOfficesService)
//   (PBE-020). They queue the verification job on `platform-connections` (QueuesModule). It also carries the portal's
//   Amadeus connection routes (ConnectionsController over ConnectionsService: `listAmadeusConnections`, PBE-027, and
//   the settings update `updateAmadeusConnection`, PBE-040).
// - `SupplierConnectionsModule.forWorker()` (WorkerModule) adds the worker's side: the Amadeus token check
//   (AmadeusOAuthGateway), the one processor of `platform-connections` (VerificationProcessor) and the
//   `amadeus.pool_level` handler of the `platform-maintenance` processor (PoolLevelScheduler), in a module of its own,
//   so the worker gets none of the admin's services.
//
// It uses the global CommonModule (Clock, IdGenerator, PLATFORM_DB, EnvelopeService; AccountAuthStates in the API),
// RedisModule (InvalidationPublisher), AuditModule and NotificationsModule (the ops alert of the pool level).
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { QueuesModule } from "../common/queues/queues.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AmadeusAccountsRepository } from "./amadeus-accounts.repository";
import { AmadeusAccountsService } from "./amadeus-accounts.service";
import { AmadeusOAuthGateway } from "./amadeus-oauth.gateway";
import { AmadeusOfficesRepository } from "./amadeus-offices.repository";
import { AmadeusOfficesService } from "./amadeus-offices.service";
import { ConnectionsController } from "./connections.controller";
import { ConnectionsService } from "./connections.service";
import { PoolLevelScheduler } from "./pool-level.scheduler";
import { SupplierConnectionsRepository } from "./supplier-connections.repository";
import { VerificationProcessor } from "./verification.processor";

/** The repositories of the module's three tables. */
const REPOSITORIES = [AmadeusAccountsRepository, AmadeusOfficesRepository, SupplierConnectionsRepository];

/**
 * The worker's part of SupplierConnectionsModule (`SupplierConnectionsModule.forWorker()`): the verification
 * processor of `platform-connections`, the token check it calls and the `amadeus.pool_level` handler.
 */
@Module({
  imports: [AuditModule, NotificationsModule, QueuesModule],
  providers: [...REPOSITORIES, AmadeusOAuthGateway, VerificationProcessor, PoolLevelScheduler],
})
export class SupplierConnectionsWorkerModule {}

@Module({
  providers: REPOSITORIES,
  exports: REPOSITORIES,
})
export class SupplierConnectionsModule {
  /** The module with the platform admin's Amadeus use cases and the portal's connection routes, for AdminModule. */
  static forApi(): DynamicModule {
    return {
      module: SupplierConnectionsModule,
      imports: [AuditModule, QueuesModule],
      controllers: [ConnectionsController],
      providers: [AmadeusAccountsService, AmadeusOfficesService, ConnectionsService],
      exports: [AmadeusAccountsService, AmadeusOfficesService],
    };
  }

  /** The module with the verification processor and the pool level check, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: SupplierConnectionsWorkerModule };
  }
}
