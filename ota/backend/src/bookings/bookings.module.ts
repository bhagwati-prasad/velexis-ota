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
// bookings.update (OBE-048): BookingChangesService (with its BookingChangesRepository) changes the contacts and special
// requests of a booking through Flight Order Management PATCH, answering through CustomerBookingsService.
//
// bookings.quoteCancellation and bookings.cancel (OBE-049): CancellationService (with CancellationRepository) quotes
// and cancels through Flight Order Management, CancellationRecorder writes the cancellation and its money step (the
// refunds of OBE-040 through RefundsRepository, a plain provider provided here again; the void through the payment
// gateway), CancelBookingIdempotencyHooks answer the replays of a `504`; the markup and fee engine's rules come from
// PricingModule.
//
// The booking documents' routes (OBE-054): DocumentsController of src/documents/ (bookings.listDocuments,
// bookings.getDocumentDownloadUrl) is registered here, behind the same booking access guard, over the
// DocumentDownloadsService of the global DocumentsModule (bookings → documents, architecture §2.2).
//
// Guest access (OBE-047): GuestAccessService issues the guest booking tokens of checkout.complete and bookings.lookup
// (LookupController) and hands them out in `__Host-vx_bt` (CookieWriter, a plain provider without state, provided here
// again) or the body; LookupAttempts counts the failed lookups in Redis (the global RedisModule's client).
//
// `BookingsWorkerModule` (worker only, OBE-044): the `ota-ticketing` consumer and the `ticketing.scan` handler
// (ticketing.processor.ts, `@TenantJob`, found by the jobs module's runner) with the issuance retries of
// ticketing.service.ts. It builds on the worker's tenancy module and the worker's Amadeus client
// (`AmadeusWorkerModule`), records tickets and events with the same OrderRecorder, and queues its e-mails through the
// worker's global OutboxService. Since OBE-043 also the `ota-bookings` consumer and the `bookings.reconcile_scan`
// handler (reconcile.processor.ts) with the timeout reconciliation of reconcile.service.ts, which reads the checkout
// (CheckoutRepository, TravelerDocuments) and captures through the PaymentGateway; like PaymentsWorkerModule it
// provides the gateway itself on the worker's platform caches, never PaymentGatewayModule (the API's tenancy module).
// Since OBE-045 also the `bookings.sync_scan` handler and the `booking.sync` jobs (booking-sync.processor.ts, which the
// `ota-bookings` consumer hands them to) with the background sync of booking-sync.service.ts. Since OBE-049 also the
// `booking.cancellation_check` jobs (CancellationChecks of cancellation.service.ts, which the same consumer hands them
// to) with the worker's CancellationRecorder.
//
// Since FIX-W27-SYNC (lead decision (3) of 2026-10-23) BookingSyncService runs in both processes: the API's
// CustomerBookingsService refreshes through it, and ConsoleModule's console.bookings.resync calls it (it is exported),
// so every path records a fetched order through the same diff. Its staff alerts (StaffAlerts, also the reconciler's)
// take the process's options: STAFF_ALERT_OPTIONS from `apiStaffAlertOptions` here, `workerStaffAlertOptions` in the
// worker.
import { Module } from "@nestjs/common";
import { AmadeusModule, AmadeusWorkerModule } from "../amadeus/amadeus.module";
import { CheckoutRepository } from "../checkout/checkout.repository";
import { checkoutKeyProvider, TravelerDocuments } from "../checkout/traveler-documents";
import { BookingAccessContext, BookingAccessGuard } from "../common/auth/booking-access.guard";
import { CookieWriter } from "../common/http/cookie-writer";
import { RequestContext } from "../common/http/request-context";
import { QueuesModule } from "../common/queues/queues.module";
import { DocumentsController } from "../documents/documents.controller";
import { IdentityModule } from "../identity/identity.module";
import { PAYMENT_GATEWAY } from "../payments/payment-gateway";
import { PaymentGatewayModule } from "../payments/payment-gateway.module";
import { PaymentsRepository } from "../payments/payments.repository";
import { RefundsRepository } from "../payments/refunds.repository";
import { StripeClientFactory } from "../payments/stripe/stripe-client.factory";
import { StripeGateway } from "../payments/stripe/stripe.gateway";
import { PricingModule } from "../pricing/pricing.module";
import { ShoppingModule } from "../shopping/shopping.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { BookingChangesRepository, BookingChangesService } from "./booking-changes.service";
import { BookingOrchestrator, CompleteCheckoutIdempotencyHooks } from "./booking-orchestrator.service";
import { BookingSyncJobs, BookingSyncScan } from "./booking-sync.processor";
import { BookingSyncRepository, BookingSyncService } from "./booking-sync.service";
import { BookingsRepository } from "./bookings.repository";
import {
  CancelBookingIdempotencyHooks,
  CancellationChecks,
  CancellationRecorder,
  CancellationRepository,
  CancellationService,
} from "./cancellation.service";
import { CustomerBookingsController } from "./customer-bookings.controller";
import { CustomerBookingsService } from "./customer-bookings.service";
import { GuestAccessRepository, GuestAccessService, LookupAttempts } from "./guest-access.service";
import { LookupController } from "./lookup.controller";
import { BookingTravelerDocuments, bookingsKeyProvider, OrderRecorder } from "./order-recorder";
import { ReconcileProcessor, ReconcileScan } from "./reconcile.processor";
import { ReconcileRepository, ReconcileService } from "./reconcile.service";
import { TicketingProcessor, TicketingScan } from "./ticketing.processor";
import { apiStaffAlertOptions, StaffAlerts, workerStaffAlertOptions } from "./staff-alerts";
import { TicketingRepository, TicketingService } from "./ticketing.service";

@Module({
  imports: [
    TenancyModule.forApi(),
    PaymentGatewayModule,
    AmadeusModule,
    ShoppingModule,
    IdentityModule,
    QueuesModule,
    PricingModule,
  ],
  controllers: [CustomerBookingsController, LookupController, DocumentsController],
  providers: [
    BookingOrchestrator,
    CompleteCheckoutIdempotencyHooks,
    ReconcileRepository,
    CustomerBookingsService,
    // Every refresh records the order through the background sync's diff (FIX-W27-SYNC).
    BookingSyncService,
    BookingSyncRepository,
    StaffAlerts,
    apiStaffAlertOptions,
    BookingChangesService,
    BookingChangesRepository,
    // bookings.quoteCancellation and bookings.cancel (OBE-049).
    CancellationService,
    CancellationRepository,
    CancellationRecorder,
    CancelBookingIdempotencyHooks,
    RefundsRepository,
    BookingAccessContext,
    BookingAccessGuard,
    GuestAccessService,
    GuestAccessRepository,
    LookupAttempts,
    CookieWriter,
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
    BookingSyncService,
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
    // The background booking sync (OBE-045).
    BookingSyncRepository,
    BookingSyncService,
    BookingSyncJobs,
    BookingSyncScan,
    // The staff alerts of the reconciliation and the sync (FIX-W27-SYNC).
    StaffAlerts,
    workerStaffAlertOptions,
    // The check of a cancellation whose DELETE got no answer (OBE-049).
    CancellationRepository,
    CancellationRecorder,
    CancellationChecks,
    RefundsRepository,
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
