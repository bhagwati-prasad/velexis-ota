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
// `ota-payments` queue from QueuesModule, OutboxService from the global NotificationsModule. API only so far; the
// bookings reads (OBE-046), the timeout reconciliation (OBE-043) and the ticketing retries (OBE-044) join it.
import { Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { CheckoutRepository } from "../checkout/checkout.repository";
import { checkoutKeyProvider, TravelerDocuments } from "../checkout/traveler-documents";
import { RequestContext } from "../common/http/request-context";
import { QueuesModule } from "../common/queues/queues.module";
import { IdentityModule } from "../identity/identity.module";
import { PaymentGatewayModule } from "../payments/payment-gateway.module";
import { PaymentsRepository } from "../payments/payments.repository";
import { ShoppingModule } from "../shopping/shopping.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { BookingOrchestrator } from "./booking-orchestrator.service";
import { BookingsRepository } from "./bookings.repository";
import { BookingTravelerDocuments, bookingsKeyProvider, OrderRecorder } from "./order-recorder";

@Module({
  imports: [
    TenancyModule.forApi(),
    PaymentGatewayModule,
    AmadeusModule,
    ShoppingModule,
    IdentityModule,
    QueuesModule,
  ],
  providers: [
    BookingOrchestrator,
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
  exports: [BookingOrchestrator],
})
export class BookingsModule {}
