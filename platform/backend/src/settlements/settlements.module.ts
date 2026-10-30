// SettlementsModule (platform/docs/architecture.md §2.1, layer 1; PADR-0003): owns `tenant_payout_accounts`, and from
// the settlement tasks `settlements` and `settlement_lines`. The static module holds what every process shares: the
// payout account repository and PayoutAccountsService (PBE-058), exported for the modules of a higher layer: the
// platform admin's AdminPayoutsController (AdminModule, layer 4), and go-live's verified-account check (PBE-061).
//
// - `SettlementsModule.forApi()` (AppModule) adds the portal's payout account routes (`getPayoutAccount`,
//   `setPayoutAccount`, PBE-058); the settlement generation (PBE-059) and the statements (PBE-060) join it, with the
//   worker's part.
//
// It uses the global CommonModule (Clock, EnvelopeService, PLATFORM_DB), AuditModule for the audit rows and
// NotificationsModule for the ops alert and the owners' review e-mail (layer 0).
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PayoutAccountsController } from "./payout-accounts.controller";
import { PayoutAccountsRepository } from "./payout-accounts.repository";
import { PayoutAccountsService } from "./payout-accounts.service";

@Module({
  imports: [AuditModule, NotificationsModule],
  providers: [PayoutAccountsRepository, PayoutAccountsService],
  exports: [PayoutAccountsRepository, PayoutAccountsService],
})
export class SettlementsModule {
  /** The module with the portal's payout account routes, for AppModule. */
  static forApi(): DynamicModule {
    return {
      module: SettlementsModule,
      controllers: [PayoutAccountsController],
    };
  }
}
