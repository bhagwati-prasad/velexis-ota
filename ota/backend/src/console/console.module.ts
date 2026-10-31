// The console context (ota/docs/architecture.md §2.1, OADR-0011, flows/console-operations.md): what the OTA admin and
// custom consoles call in console scope. Since OBE-060 it holds the console audit: the `staff_actions` writer
// (staff-actions.writer.ts), which the permission guard and the audit interceptor of app.module.ts use, and which use
// cases of every module inject to write their row in their own transaction (console.auth.signIn in identity/staff).
// It is global for that reason, as the e-mail outbox is: a module that audits a console action does not import it, and
// the identity module, which this one would otherwise import for the staff context, does not need to. The staff guard
// reaches the writer through the `StaffRefusalAudit` token (staff.guard.ts), and the writer checks a refused request's
// path values against the OTA document (`OpenApiDocument`, parsed once per process as HttpModule's).
//
// The console operations themselves join with OBE-061 to OBE-074. Since OBE-061: console.bookings.list and get
// (console-bookings.controller.ts), which read the bookings module's rows and refresh orders with its
// CustomerBookingsService (BookingsModule exports them; it never imports this module). PNR import, queues, customers,
// supplier log, raw Amadeus reads, payments and settings follow. Since OBE-062: console.bookings.retrieve, patch, resync
// and addNote (console-booking-actions.service.ts), which call Amadeus through AmadeusModule's client. Since OBE-068:
// console.payments.list, get, capture and refund (console-payments.controller.ts, console-payments.service.ts), which
// read and change the payments module's rows (PaymentsRepository from BookingsModule, RefundsRepository), call Stripe
// through PaymentGatewayModule's gateway and queue `refund.submit` on `ota-payments` (QueuesModule). Since OBE-063:
// console.bookings.issue and cancel (console-booking-actions.service.ts), which claim a booking for its issuance with the
// ticketing job's TicketingRepository (a plain provider, provided here again), record tickets with BookingsModule's
// OrderRecorder, capture through ConsolePaymentsService, cancel through BookingsModule's CancellationService, and
// answer the same-key replays of a cancellation's `504` (ConsoleCancelBookingIdempotencyHooks). Since OBE-064:
// console.bookings.findByRecordLocator and import (pnr-import.service.ts, on the bookings controller), which read the
// connection's offices (AmadeusModule's ConnectionResolver), price an import with the tenant's markup and fee rules
// (PricingModule's RulesRepository) and record its order with BookingsModule's repositories and OrderRecorder. Since
// OBE-065: console.queues.list and listSnapshots (queues.controller.ts, queues.service.ts), which read queues through
// AmadeusModule's client and keep the reads in `queue_snapshots` (queue-snapshots.repository.ts); the queue poller that
// writes the same rows runs in the worker, where JobsModule provides it. Since OBE-066: console.customers.list and get
// (customers.controller.ts, customers.service.ts, customers.repository.ts), which read the customers and, for their
// statistics and recent bookings, the bookings and payments of the environment (through ConsoleBookingsRepository and
// BookingsModule's PaymentsRepository), and console.supplierRequests.list (supplier-log.controller.ts,
// supplier-log.repository.ts), the redacted Amadeus call log. Since OBE-067: the eight raw Amadeus reads
// `console.amadeus.*` (raw-amadeus.controller.ts, raw-amadeus.service.ts), which call AmadeusModule's client with the
// connection's offices, keep another office's orders out of the answer and of the tenant's supplier log (OBE-064's
// office rule), link order reads to bookings with PnrImportRepository and keep Queue List reads as `queue_snapshots`
// rows (QueueSnapshotsRepository); the four raw writes stay deferred (501).
import { Global, Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { BookingsModule } from "../bookings/bookings.module";
import { StaffContext, StaffRefusalAudit } from "../common/auth/staff.guard";
import { loadOpenApiDocument, OpenApiDocument } from "../common/http/openapi-validation.interceptor";
import { RequestContext } from "../common/http/request-context";
import { QueuesModule } from "../common/queues/queues.module";
import { PaymentGatewayModule } from "../payments/payment-gateway.module";
import { PricingModule } from "../pricing/pricing.module";
import { RefundsRepository } from "../payments/refunds.repository";
import { TenancyModule } from "../tenancy/tenancy.module";
import { TicketingRepository } from "../bookings/ticketing.service";
import {
  ConsoleBookingActionsService,
  ConsoleCancelBookingIdempotencyHooks,
} from "./console-booking-actions.service";
import { ConsoleBookingsController } from "./console-bookings.controller";
import { ConsoleBookingsRepository } from "./console-bookings.repository";
import { ConsoleBookingsService } from "./console-bookings.service";
import { ConsolePaymentsController } from "./console-payments.controller";
import { ConsolePaymentsService } from "./console-payments.service";
import { ConsoleCustomersController } from "./customers.controller";
import { ConsoleCustomersRepository } from "./customers.repository";
import { ConsoleCustomersService } from "./customers.service";
import { PnrImportRepository, PnrImportService } from "./pnr-import.service";
import { QueueSnapshotsRepository } from "./queue-snapshots.repository";
import { QueuesController } from "./queues.controller";
import { QueuesService } from "./queues.service";
import { RawAmadeusController } from "./raw-amadeus.controller";
import { RawAmadeusRepository, RawAmadeusService } from "./raw-amadeus.service";
import { StaffActionsWriter } from "./staff-actions.writer";
import { ConsoleSupplierLogController } from "./supplier-log.controller";
import { SupplierLogRepository } from "./supplier-log.repository";

@Global()
@Module({
  imports: [
    TenancyModule.forApi(),
    AmadeusModule,
    BookingsModule,
    PaymentGatewayModule,
    QueuesModule,
    PricingModule,
  ],
  controllers: [
    ConsoleBookingsController,
    ConsolePaymentsController,
    QueuesController,
    ConsoleCustomersController,
    ConsoleSupplierLogController,
    RawAmadeusController,
  ],
  providers: [
    StaffActionsWriter,
    { provide: StaffRefusalAudit, useExisting: StaffActionsWriter },
    // The same parsed document as HttpModule's (loadOpenApiDocument keeps one per process).
    { provide: OpenApiDocument, useFactory: () => loadOpenApiDocument() },
    // Typed views of the request context (nestjs-cls), as the identity and HTTP modules provide them: stateless, so
    // these instances read the same request state as theirs.
    StaffContext,
    RequestContext,
    ConsoleBookingsRepository,
    ConsoleBookingsService,
    ConsoleBookingActionsService,
    ConsoleCancelBookingIdempotencyHooks,
    TicketingRepository,
    ConsolePaymentsService,
    RefundsRepository,
    PnrImportService,
    PnrImportRepository,
    QueueSnapshotsRepository,
    QueuesService,
    ConsoleCustomersRepository,
    ConsoleCustomersService,
    SupplierLogRepository,
    RawAmadeusService,
    RawAmadeusRepository,
  ],
  exports: [StaffActionsWriter, StaffRefusalAudit],
})
export class ConsoleModule {}
