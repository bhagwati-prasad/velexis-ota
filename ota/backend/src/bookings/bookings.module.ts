// The bookings context (ota/docs/architecture.md §2.1, ota/docs/architecture-booking.md; OBE-042): the booking
// orchestrator of checkout.complete for Stripe payments (booking-orchestrator.service.ts), the Amadeus order requests
// (order-request.builder.ts), the record step (order-recorder.ts) and the tenant's `bookings` and `booking_*` tables
// through the tenancy module's `TenantTx` (bookings.repository.ts).
//
// CheckoutModule imports this module for its checkout.complete route; this module therefore never imports
// CheckoutModule or PaymentsModule (PaymentsModule imports CheckoutModule). It reads the checkout and the payment
// through their repositories and the sealed traveller documents through TravelerDocuments, provided here again (plain
// providers without state); the Stripe gateway comes from PaymentGatewayModule, the Amadeus client and the connection
// resolver from AmadeusModule, the priced offers from ShoppingModule, the request's customer from IdentityModule, the
// `ota-payments` queue from QueuesModule, OutboxService from the global NotificationsModule.
//
// The customer bookings reads (OBE-046): CustomerBookingsController over CustomerBookingsService, with the booking
// access guard of common/auth (BookingAccessContext keeps its decision for the request). The idempotency hooks of
// checkout.complete (OBE-043: a stored `504` linked to its booking and answered from it on replays) are here too.
// ConsoleModule imports this module for the console bookings reads (OBE-061): the repositories, the sealed booking
// documents and the refresh of CustomerBookingsService are exported for them.
//
// `BookingsWorkerModule` (worker only, OBE-044): the `ota-ticketing` consumer and the `ticketing.scan` handler
// (ticketing.processor.ts, `@TenantJob`, found by the jobs module's runner) with the issuance retries of
// ticketing.service.ts. It builds on the worker's tenancy module and the worker's Amadeus client
// (`AmadeusWorkerModule`), records tickets and events with the same OrderRecorder, and queues its e-mails through the
// worker's global OutboxService. Since OBE-043 also the `ota-bookings` consumer and the `bookings.reconcile_scan`
// handler (reconcile.processor.ts) with the timeout reconciliation of reconcile.service.ts, which reads the checkout
// (CheckoutRepository, TravelerDocuments) and captures through the PaymentGateway; like PaymentsWorkerModule it
// provides the gateway itself on the worker's platform caches, never PaymentGatewayModule (the API's tenancy module).
import { Module } from "@nestjs/common";
import { AmadeusModule, AmadeusWorkerModule } from "../amadeus/amadeus.module";
import { CheckoutRepository } from "../checkout/checkout.repository";
import { checkoutKeyProvider, TravelerDocuments } from "../checkout/traveler-documents";
import { BookingAccessContext, BookingAccessGuard } from "../common/auth/booking-access.guard";
import { RequestContext } from "../common/http/request-context";
import { QueuesModule } from "../common/queues/queues.module";
import { IdentityModule } from "../identity/identity.module";
import { PAYMENT_GATEWAY } from "../payments/payment-gateway";
import { PaymentGatewayModule } from "../payments/payment-gateway.module";
import { PaymentsRepository } from "../payments/payments.repository";
import { StripeClientFactory } from "../payments/stripe/stripe-client.factory";
import { StripeGateway } from "../payments/stripe/stripe.gateway";
import { ShoppingModule } from "../shopping/shopping.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { BookingOrchestrator, CompleteCheckoutIdempotencyHooks } from "./booking-orchestrator.service";
import { BookingsRepository } from "./bookings.repository";
import { CustomerBookingsController } from "./customer-bookings.controller";
import { CustomerBookingsService } from "./customer-bookings.service";
import { BookingTravelerDocuments, bookingsKeyProvider, OrderRecorder } from "./order-recorder";
import { ReconcileProcessor, ReconcileScan } from "./reconcile.processor";
import { ReconcileRepository, ReconcileService } from "./reconcile.service";
import { TicketingProcessor, TicketingScan } from "./ticketing.processor";
import { TicketingRepository, TicketingService } from "./ticketing.service";

@Module({
  imports: [
    TenancyModule.forApi(),
    PaymentGatewayModule,
    AmadeusModule,
    ShoppingModule,
    IdentityModule,
    QueuesModule,
  ],
  controllers: [CustomerBookingsController],
  providers: [
    BookingOrchestrator,
    CompleteCheckoutIdempotencyHooks,
    ReconcileRepository,
    CustomerBookingsService,
    BookingAccessContext,
    BookingAccessGuard,
    BookingsRepository,
    OrderRecorder,
    bookingsKeyProvider,
    BookingTravelerDocuments,
    checkoutKeyProvider,
    TravelerDocuments,
    CheckoutRepository,
    PaymentsRepository,
    // RequestContext only reads the request context (nestjs-cls): this module's instance sees the scope the guards set.
    RequestContext,
  ],
  // The console bookings reads (OBE-061, console/console.module.ts) read the same rows and refresh orders the same way.
  exports: [
    BookingOrchestrator,
    BookingsRepository,
    BookingTravelerDocuments,
    CustomerBookingsService,
    PaymentsRepository,
  ],
})
export class BookingsModule {}

@Module({
  imports: [TenancyModule.forWorker(), AmadeusWorkerModule, QueuesModule],
  providers: [
    BookingsRepository,
    OrderRecorder,
    bookingsKeyProvider,
    BookingTravelerDocuments,
    TicketingRepository,
    TicketingService,
    TicketingProcessor,
    TicketingScan,
    // The timeout reconciliation (OBE-043).
    ReconcileRepository,
    ReconcileService,
    ReconcileProcessor,
    ReconcileScan,
    CheckoutRepository,
    checkoutKeyProvider,
    TravelerDocuments,
    PaymentsRepository,
    StripeClientFactory,
    StripeGateway,
    { provide: PAYMENT_GATEWAY, useExisting: StripeGateway },
  ],
})
export class BookingsWorkerModule {}
