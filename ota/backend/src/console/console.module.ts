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
// and addNote (console-booking-actions.service.ts), which call Amadeus through AmadeusModule's client.
import { Global, Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { BookingsModule } from "../bookings/bookings.module";
import { StaffContext, StaffRefusalAudit } from "../common/auth/staff.guard";
import { loadOpenApiDocument, OpenApiDocument } from "../common/http/openapi-validation.interceptor";
import { RequestContext } from "../common/http/request-context";
import { TenancyModule } from "../tenancy/tenancy.module";
import { ConsoleBookingActionsService } from "./console-booking-actions.service";
import { ConsoleBookingsController } from "./console-bookings.controller";
import { ConsoleBookingsRepository } from "./console-bookings.repository";
import { ConsoleBookingsService } from "./console-bookings.service";
import { StaffActionsWriter } from "./staff-actions.writer";

@Global()
@Module({
  imports: [TenancyModule.forApi(), AmadeusModule, BookingsModule],
  controllers: [ConsoleBookingsController],
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
  ],
  exports: [StaffActionsWriter, StaffRefusalAudit],
})
export class ConsoleModule {}
