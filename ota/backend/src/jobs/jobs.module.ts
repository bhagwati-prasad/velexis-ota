// The jobs module of the OTA worker (OBE-024; ota/docs/architecture.md §2.1 and §6, OADR-0014): the schedulers of
// schedulers.ts, registered at start-up, the consumer of `ota-maintenance` with the fan-out and the per-tenant job
// runner (fan-out.ts), and the per-tenant handlers of the schedules (`@TenantJob`). Only WorkerModule imports it: the
// API process never runs a processor or a scheduler (README §4).
//
// The handlers that belong to another context are provided here, where the worker runs them, as architecture §2.2's
// `jobs → shopping` arrow says; each later schedule adds its handler the same way (`jobs → bookings`, `jobs →
// notifications`) or, when its module is imported by the worker, provides it there. The runner finds them all among
// the worker's providers. The checkout expiry (OBE-056) is provided here too (`jobs → checkout`): the checkout module
// is the API's only. The retention purge (OBE-056) is this module's own work (`retention.processor.ts`,
// `retention.repository.ts`). The platform repository, the platform cache, the tenant context and `TenantTx` come from
// `TenancyModule.forWorker()`, the queues from QueuesModule, Clock from the global CommonModule; the tenant context
// needs the worker's request-context module (nestjs-cls, worker.module.ts).
import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { CheckoutExpiryProcessor } from "../checkout/checkout-expiry.processor";
import { QueuesModule } from "../common/queues/queues.module";
import { OffersPurgeProcessor } from "../shopping/offers-purge.processor";
import { TenancyModule } from "../tenancy/tenancy.module";
import { FanOutService, MaintenanceProcessor, TenantJobRunner } from "./fan-out";
import { RetentionProcessor } from "./retention.processor";
import { RetentionRepository } from "./retention.repository";
import { JobSchedulerRegistry } from "./schedulers";

@Module({
  imports: [DiscoveryModule, TenancyModule.forWorker(), QueuesModule],
  providers: [
    JobSchedulerRegistry,
    FanOutService,
    TenantJobRunner,
    MaintenanceProcessor,
    OffersPurgeProcessor,
    CheckoutExpiryProcessor,
    RetentionRepository,
    RetentionProcessor,
  ],
})
export class JobsModule {}
