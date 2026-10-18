// PaymentConnectionsModule (platform/docs/architecture.md §2.1, layer 1; ADR-0011, PADR-0011): owns
// `payment_provider_connections`. The static module holds what every process shares: the repository, exported for the
// modules of a higher layer (ProvisioningModule creates the `velexis` test connection of a new OTA, PBE-022), and the
// statement descriptor rules (descriptor.ts, plain functions). The portal's payment routes (PBE-038 and the M5
// Connect Standard and API-key modes) add `forApi()`, and the Connect account events their worker part.
//
// It uses the global CommonModule (PLATFORM_DB).
import { Module } from "@nestjs/common";
import { PaymentConnectionsRepository } from "./payment-connections.repository";

@Module({
  providers: [PaymentConnectionsRepository],
  exports: [PaymentConnectionsRepository],
})
export class PaymentConnectionsModule {}
