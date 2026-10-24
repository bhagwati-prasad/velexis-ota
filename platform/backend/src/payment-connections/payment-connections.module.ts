// PaymentConnectionsModule (platform/docs/architecture.md §2.1, layer 1; ADR-0011, PADR-0011): owns
// `payment_provider_connections`. The static module holds what every process shares: the repository, exported for the
// modules of a higher layer (ProvisioningModule creates the `velexis` test connection of a new OTA, PBE-022), and the
// statement descriptor rules (descriptor.ts, plain functions).
//
// - `PaymentConnectionsModule.forApi()` (AppModule) adds the portal's payment routes over PaymentConnectionsService:
//   `listPaymentConnections` (PBE-027) and the descriptor update `updatePaymentConnection` (PBE-038); the M5 Connect
//   Standard and API-key modes join it, and the Connect account events a worker part.
//
// It uses the global CommonModule (Clock, PLATFORM_DB) and RedisModule (the InvalidationPublisher), and AuditModule.
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { PaymentConnectionsController } from "./payment-connections.controller";
import { PaymentConnectionsRepository } from "./payment-connections.repository";
import { PaymentConnectionsService } from "./payment-connections.service";

@Module({
  imports: [AuditModule],
  providers: [PaymentConnectionsRepository],
  exports: [PaymentConnectionsRepository],
})
export class PaymentConnectionsModule {
  /** The module with the portal's payment connection routes, for AppModule. */
  static forApi(): DynamicModule {
    return {
      module: PaymentConnectionsModule,
      controllers: [PaymentConnectionsController],
      providers: [PaymentConnectionsService],
    };
  }
}
