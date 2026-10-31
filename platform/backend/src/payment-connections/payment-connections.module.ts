// PaymentConnectionsModule (platform/docs/architecture.md §2.1, layer 1; ADR-0011, PADR-0011): owns
// `payment_provider_connections`. The static module holds what every process shares: the repository, exported for the
// modules of a higher layer (ProvisioningModule creates the `velexis` test connection of a new OTA, PBE-022), and the
// statement descriptor rules (descriptor.ts, plain functions).
//
// - `PaymentConnectionsModule.forApi()` (AppModule) adds the portal's payment routes over PaymentConnectionsService:
//   `listPaymentConnections` (PBE-027) and the descriptor update `updatePaymentConnection` (PBE-038); Connect
//   Standard over StripeConnectService (`startStripeConnect`, `completeStripeConnect`, PBE-055), which calls Stripe
//   through the StripeClient of common/stripe (tests replace it with the FakeStripe of test/support); and the Connect
//   account receiver `POST /webhooks/stripe/connect-accounts` (ConnectWebhookController, PBE-056) over the inbox of
//   common/stripe (StripeInboxService, StripeEventsRepository, the `platform-stripe-events` queue of QueuesModule),
//   which stores and queues the events and never calls Stripe. The API-key mode joins it.
// - `PaymentConnectionsModule.forWorker()` (WorkerModule) is the worker's part (PBE-056), in a module of its own so the
//   worker builds none of the portal's services: the handler of the Connect account events
//   (ConnectAccountEventsHandler, `@HandlesStripeEvents("connect_accounts", …)`), which the one `platform-stripe-events`
//   processor of BillingSyncModule.forWorker() finds among the worker's providers. It re-fetches accounts with the
//   Stripe client, writes through the module's repository, audits through AuditModule and queues the
//   owners' e-mail through NotificationsModule (layer 0).
//
// It uses the global CommonModule (Clock, ids, PLATFORM_DB) and RedisModule (the command client, the
// InvalidationPublisher), and AuditModule.
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { QueuesModule } from "../common/queues/queues.module";
import { stripeClientProvider } from "../common/stripe/stripe.client";
import { StripeEventsRepository } from "../common/stripe/stripe-events.repository";
import { StripeInboxService } from "../common/stripe/stripe-inbox.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { ConnectAccountEventsHandler } from "./connect-account-events.handler";
import { ConnectWebhookController } from "./connect-webhook.controller";
import { PaymentConnectionsController } from "./payment-connections.controller";
import { PaymentConnectionsRepository } from "./payment-connections.repository";
import { PaymentConnectionsService } from "./payment-connections.service";
import { StripeConnectController } from "./stripe-connect.controller";
import { StripeConnectService } from "./stripe-connect.service";

/** The worker's part of PaymentConnectionsModule (`PaymentConnectionsModule.forWorker()`). */
@Module({
  imports: [AuditModule, NotificationsModule],
  providers: [PaymentConnectionsRepository, stripeClientProvider, ConnectAccountEventsHandler],
})
export class PaymentConnectionsWorkerModule {}

@Module({
  imports: [AuditModule],
  providers: [PaymentConnectionsRepository],
  exports: [PaymentConnectionsRepository],
})
export class PaymentConnectionsModule {
  /** The module with the portal's payment connection routes and the Connect account receiver, for AppModule. */
  static forApi(): DynamicModule {
    return {
      module: PaymentConnectionsModule,
      imports: [QueuesModule],
      controllers: [PaymentConnectionsController, StripeConnectController, ConnectWebhookController],
      providers: [
        PaymentConnectionsService,
        StripeConnectService,
        stripeClientProvider,
        StripeEventsRepository,
        StripeInboxService,
      ],
    };
  }

  /** The handler of the Connect account events, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: PaymentConnectionsWorkerModule };
  }
}
