// SettlementsModule (platform/docs/architecture.md §2.1, layer 1; PADR-0003): owns `tenant_payout_accounts`,
// `settlements` and `settlement_lines`. The static module holds what every process shares: the payout account
// repository and PayoutAccountsService (PBE-058), the statements' repository and SettlementJobs, the producer of
// `settlement.generate` on `platform-settlements` (PBE-059). It exports what the modules of a higher layer use: the
// platform admin's AdminPayoutsController and AdminSettlementsController (AdminModule, layer 4), and go-live's
// verified-account check (PBE-061).
//
// - `SettlementsModule.forApi()` (AppModule) adds the portal's payout account routes (`getPayoutAccount`,
//   `setPayoutAccount`, PBE-058); the portal's statements (PBE-060) join it.
// - `SettlementsModule.forWorker()` (WorkerModule) is the worker's part (PBE-059): the one processor of
//   `platform-settlements` (SettlementsProcessor) over SettlementGenerator, which lists the month's Stripe balance
//   transactions with the Stripe client and rebuilds the drafts, and the `settlements.monthly` handler of the
//   `platform-maintenance` processor. It is a module of its own, as BillingSyncModule's worker part is, so the worker
//   does not build the API's payout account services.
//
// It uses the global CommonModule (Clock, IdGenerator, EnvelopeService, PLATFORM_DB), the queues of QueuesModule,
// AuditModule for the audit rows and NotificationsModule for the ops alert and the owners' review e-mail (layer 0).
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { QueuesModule } from "../common/queues/queues.module";
import { stripeClientProvider } from "../common/stripe/stripe.client";
import { NotificationsModule } from "../notifications/notifications.module";
import { PayoutAccountsController } from "./payout-accounts.controller";
import { PayoutAccountsRepository } from "./payout-accounts.repository";
import { PayoutAccountsService } from "./payout-accounts.service";
import { SettlementGenerator } from "./settlement-generator";
import { SettlementsMonthlyScheduler } from "./settlements-monthly.scheduler";
import { SettlementJobs, SettlementsProcessor } from "./settlements.processor";
import { SettlementsRepository } from "./settlements.repository";

/** The worker's part of SettlementsModule (`SettlementsModule.forWorker()`). */
@Module({
  imports: [QueuesModule, AuditModule],
  providers: [
    stripeClientProvider,
    SettlementsRepository,
    SettlementJobs,
    SettlementGenerator,
    SettlementsProcessor,
    SettlementsMonthlyScheduler,
  ],
})
export class SettlementsWorkerModule {}

@Module({
  imports: [AuditModule, NotificationsModule, QueuesModule],
  providers: [PayoutAccountsRepository, PayoutAccountsService, SettlementsRepository, SettlementJobs],
  exports: [PayoutAccountsRepository, PayoutAccountsService, SettlementJobs],
})
export class SettlementsModule {
  /** The module with the portal's payout account routes, for AppModule. */
  static forApi(): DynamicModule {
    return {
      module: SettlementsModule,
      controllers: [PayoutAccountsController],
    };
  }

  /** The processor of `platform-settlements`, its generator and the monthly schedule's handler, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: SettlementsWorkerModule };
  }
}
