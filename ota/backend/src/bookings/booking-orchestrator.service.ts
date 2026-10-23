// checkout.complete for Stripe payments (completeCheckout, `x-scope: both`; OBE-042; ota/docs/architecture-booking.md
// §1 and §2, OADR-0003 points 1–3, OADR-0008 points 1 and 7, ota/docs/flows/checkout-stripe.md §2 steps 5–7 and §3).
// Five steps; no database transaction stays open across an Amadeus or Stripe call (OADR-0003 point 1), and a
// transaction that locks several of the checkout, the booking and the payment locks them in that order, a foreign-key
// lock (the FOR KEY SHARE an insert of a row that references a parent takes) counting as a lock of the parent (lead
// decision of 2026-10-21, OADR-0003 point 11): the claim, T2, the unknown outcome and the failure lock the checkout
// first.
//
//   0. Read (T0) and the PaymentIntent. The checkout as its own checkout.get reads it (environment and access, `404`
//      otherwise); a booking of the checkout answers `409 CHECKOUT_ALREADY_COMPLETED` (`details.bookingId`), or, while
//      it is `pending`, `504 SUPPLIER_TIMEOUT` with the same details (the order may exist: never a second Flight Create
//      Orders); `410 CHECKOUT_EXPIRED`; travellers and contacts against the requirements (`422 CHECKOUT_INCOMPLETE`);
//      the payment (`paymentId`, else the checkout's active one; an airline-card payment is `422 UNPROCESSABLE`,
//      `details.reason = use_airline_card_completion`). The tenant's Amadeus connection is resolved (`424`). The
//      PaymentIntent is read again from Stripe: `requires_capture` for exactly the checkout total (`409
//      PAYMENT_AMOUNT_MISMATCH` otherwise); not confirmed yet `402 PAYMENT_REQUIRED`, declined `402 PAYMENT_DECLINED`.
//      A total above `expectedTotal` is `409 PRICE_CHANGED` (nothing claimed, nothing voided).
//   1. Claim (T1). The checkout locked (`FOR UPDATE`); a checkout or payment that changed since step 0 starts again
//      (three times at most); the refreshed payment state is applied; the `bookings` row is inserted `pending` with a
//      new reference, `create_order_started_at`, the amounts of the checkout and its priced offer, the trip and the
//      lead traveller; the payment is linked to it. `bookings.checkout_id` is UNIQUE: a concurrent claim of the same
//      checkout fails there and answers as step 0 does for a booking.
//   2. Call. A priced offer that expired, is older than REPRICE_AFTER_MS, or whose travellers carry discount data is
//      priced again (a child priced offer): without extras PricedOffersService.repriceForCheckout; with the checkout's
//      extras (setAncillaries) the base priced offer's offers with the same additional services again, stored with
//      PricedOffersService.storeServicesPricing (`repriceWithExtras`), so that the new priced offer, the totals and the
//      order keep them. A higher total (or one above `expectedTotal`), or an extra that Amadeus no longer confirms (it
//      refuses one, or answers without one): the checkout moves to the new priced offer, extras and totals, the
//      authorisation is voided, the booking `failed`, `409 PRICE_CHANGED` (`details.oldPrice`, `newPrice`,
//      `pricedOfferId`, and `reason: extras_unavailable` for an extra): never a booking without the extras the
//      customer chose and paid for. A lower one is accepted (only it is captured; warning `PRICE_DECREASED`). Then,
//      under the booking's lock (`recordSending`, lead decision of 2026-10-21, third batch), the booking must still be
//      `pending` and undecided (else nothing is sent), and it records what is sent: `issue_requested` and, after an
//      accepted re-price, the priced offer sent with its amounts, so that a process that dies after the send leaves a
//      booking whose reconciliation captures the re-priced total (the checkout moves only once the order may exist).
//      Then Flight Create Orders (order-request.builder.ts). Its outcomes (`createFailureKind`):
//        - rejected (Amadeus answered a `4xx` business refusal: sold out, data, price, ticketing): the authorisation
//          is voided, the booking `failed` (`checkout_id` cleared, so the checkout stays open and can be completed
//          again with a new payment), and `409 SOLD_OUT`, `409 PRICE_CHANGED`, `422 TRAVELER_DATA_INVALID`,
//          `502 TICKETING_FAILED` or `502 SUPPLIER_ERROR`;
//        - not sent (the token request, the rate limits, a connection never made, an Amadeus `401`, `403` or `429`
//          that refused the request before processing it): the booking `failed`, the authorisation kept and the
//          checkout still `payment_pending`, the error answered (a retry runs again);
//        - unknown (OADR-0003 points 2 and 4): every other answer once the request may have reached Amadeus — no
//          answer in time, a reset connection, an Amadeus `5xx` (500, 502, 503, 504), an answer that cannot be read:
//          the order may exist. The booking stays `pending` with the authorisation and its `checkout_id` (the
//          checkout cannot change, CHECKOUT_BEING_COMPLETED, and is never completed a second time),
//          `reconcile_until = create_order_started_at + 15 minutes` and the event `booking.supplier_timeout`, and the
//          first `booking.reconcile` is queued 30 seconds later (reconcile.service.ts decides it, OBE-043); a re-price
//          that was accepted moves the booking and the checkout to the new priced offer now, as the order sent holds
//          it. The answer is `504 SUPPLIER_TIMEOUT` with `details.bookingId`. Nothing is voided and Flight Create
//          Orders is never sent again for the checkout.
//   3. Record (T2): order-recorder.ts (`confirmed` or `ticketed`, children, events, redacted snapshot, deadline,
//      outbox `booking.confirmed`), checkout `completed`. An order that cannot be recorded (an answer that cannot be
//      read, a T2 that fails) exists at Amadeus: it is an unknown outcome as above (`504 SUPPLIER_TIMEOUT`).
//   4. Money. Stripe capture (`pi:capture:<pay_id>:<amount>`) unless the policy is `manual_review` and no ticket was
//      issued (staff issue from the console, which captures first; the staff are alerted). A failed capture leaves the
//      booking `confirmed` with `ticketing_status = manual_review` (a ticketed one keeps `issued`), queues
//      `payment.capture_retry` on `ota-payments` (10 minutes later, OADR-0008 point 7; OBE-040 runs it), alerts the
//      staff (`staff.manual_review`), and the answer is `201` with the warning `CAPTURE_FAILED`.
//   5. Issue. `issue_after_payment` after a capture: Flight Order Issue, then the tickets (T4). A failure leaves the
//      booking `confirmed` with `ticketing_status = failed` and the next attempt 5 minutes later (OBE-044 retries).
//
// The answer is `201` CheckoutCompletion: the booking in customer scope (order-recorder.ts `toBooking`), the Amadeus
// warnings of pricing, create and issue and ours, and for a guest booking (no customer) its guest token (OBE-047,
// guest-access.service.ts): valid for 30 days or until 7 days after the last flight, whichever is later, in
// `bookingToken`/`bookingTokenExpiresAt` for a key caller, in the `__Host-vx_bt` cookie for the storefront edge (both
// fields `null`). The `504 SUPPLIER_TIMEOUT` of an unknown outcome carries one too (`details.bookingToken`,
// `details.bookingTokenExpiresAt`, or the cookie), so the guest can follow the pending booking; a customer's booking
// never gets one. The token row is written in a short transaction of its own after the booking's, and handed out once
// it committed; a token that cannot be written is logged and the answer goes out without it (the booking exists: the
// guest can look it up), so it never costs the answer or the reconciliation's schedule.
//
// Same-key retries (OBE-043, OADR-0003 point 6, architecture-booking.md §5.2): the idempotency hooks of
// completeCheckout (`CompleteCheckoutIdempotencyHooks`) link a stored `504 SUPPLIER_TIMEOUT` to its booking
// (`resourceOf`), so the record is kept instead of released, and answer its replays from the booking
// (`resolveReplay`): the same `504` with `details.replayed: true` while the booking is `pending`, then the final `201`
// built from the booking once the reconciliation found the order (with the guest token of the stored `504`: its
// details, or its `Set-Cookie`), or the final `502 SUPPLIER_ERROR` ("nothing was booked") once it proved it absent. A
// payment whose booking failed that way is not used again (`402 PAYMENT_REQUIRED`): its authorisation is being
// voided.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import type { TenantDatabase, Updateable } from "@velexis/db";
import { AppError, toErrorEnvelope } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import type { JobsOptions, Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { AmadeusClient, type AmadeusResponse } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { ConnectionResolver, type ResolvedAmadeusConnection } from "../amadeus/connection-resolver";
import { AmadeusCallError } from "../amadeus/error-mapper";
import {
  buildServicesRequest,
  extraNets,
  extrasMissingFrom,
  pricingExtrasOf,
  SERVICES_INCLUDE,
  servicesErrorOf,
  storedExtrasOf,
  storedOffersOf,
  type ServiceExtra,
  type ServicesRequest,
} from "../checkout/ancillaries.service";
import { effectiveStatus, progressOf, type TravelerView } from "../checkout/checkout.mapper";
import { CheckoutRepository, type CheckoutChildren, type CheckoutRow } from "../checkout/checkout.repository";
import {
  baseAmountsFor,
  isPricingMode,
  type PricingMode,
  type SelectionPrices,
} from "../checkout/pricing-mode";
import { requirementsForPricedOffer } from "../checkout/requirements";
import { TravelerDocuments } from "../checkout/traveler-documents";
import { CustomerContext } from "../common/auth/customer.guard";
import { Clock } from "../common/clock";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotencyRecord,
  type IdempotencyResource,
  type IdempotencyResponse,
} from "../common/http/idempotency.service";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE } from "../common/queues/queue-names";
import type { SharedConfig } from "../config";
import { InvalidNotificationError } from "../notifications/outbox.service";
import { StaffRecipients } from "../notifications/staff-recipients";
import {
  PAYMENT_GATEWAY,
  type GatewayContext,
  type GatewayPayment,
  type GatewayState,
  type PaymentGateway,
} from "../payments/payment-gateway";
import { PaymentsRepository, type PaymentRow } from "../payments/payments.repository";
import { stateValues, toPayment } from "../payments/payments.service";
import { Money, type FeeLine } from "../pricing/pricing.types";
import { parseOffer, type ParsedOffer } from "../shopping/offers.mapper";
import {
  confirmedOffersOf as confirmedPricingOffersOf,
  pricingQuery,
  readPricingReply,
  snapshotOf,
  warningsOf,
} from "../shopping/priced-offers.mapper";
import {
  PricedOffersService,
  type CheckoutPricedOffer,
  type ServicesPricing,
} from "../shopping/priced-offers.service";
import { CallerContext } from "../tenancy/caller-resolver";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { afterCommit, TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { newBookingReference } from "./booking-reference";
import { BookingsRepository, type BookingRow, type BookingSettingsRow } from "./bookings.repository";
import {
  completionTokenExpiry,
  GuestAccessService,
  NO_BOOKING_TOKEN,
  type DeliveredBookingToken,
  type IssuedBookingToken,
} from "./guest-access.service";
import {
  BookingTravelerDocuments,
  eventActorOf,
  FIRST_TICKETING_RETRY_MS,
  OrderRecorder,
  readCreatedOrder,
  ticketCoverage,
  ticketingStateOf,
  toBooking,
  type CheckoutCompletion,
  type CheckoutTravelerView,
  type CreatedOrder,
  type RecordedOrder,
  type Warning,
} from "./order-recorder";
import {
  buildCreateOrderRequest,
  buildIssueRequest,
  issueAtCreate,
  pricingTravelersOf,
  requiresInstantTicketing,
  type OrderTraveler,
  type TicketingPolicy,
} from "./order-request.builder";
import {
  CAPTURE_RETRY_DELAY_MS,
  RECONCILE_WINDOW_MS,
  reconcileJob,
  ReconcileRepository,
} from "./reconcile.service";

export { CAPTURE_RETRY_DELAY_MS, RECONCILE_WINDOW_MS };

type Schemas = components["schemas"];
export type CheckoutCompleteRequest = Schemas["CheckoutCompleteRequest"];
type MoneyAmount = Schemas["Money"];

/** The input of checkout.complete. */
export interface CompleteCheckoutInput {
  readonly checkoutId: string;
  readonly body: CheckoutCompleteRequest;
  readonly acceptLanguage?: string | undefined;
}

/** A priced offer older than this is priced again before the order (contract step 4, `repriceAfterMinutes`). */
export const REPRICE_AFTER_MS = 10 * 60_000;

/** How long a job enqueue after a commit may take before it is left to the jobs' own scans. */
export const ENQUEUE_TIMEOUT_MS = 2000;

/**
 * The job names this module adds to `ota-payments` (OBE-040 consumes them). Their payload is the queue's
 * `{tenantId, id}` with the payment id (ota/docs/architecture.md §6: ids only, ADR-0009 point 10).
 */
export const PAYMENT_JOBS = Object.freeze({
  captureRetry: "payment.capture_retry",
  void: "payment.void",
} as const);

/** The payload of a `PAYMENT_JOBS` job: the tenant and the payment (`pay_…`). */
export interface PaymentJobData {
  readonly tenantId: string;
  readonly id: string;
}

/** How often the read and claim start again when the checkout or its payment changed meanwhile. */
const CLAIM_ATTEMPTS = 3;

/** `fieldErrors` of a `422 CHECKOUT_INCOMPLETE`, at most. */
const MAX_FIELD_ERRORS = 50;

const POLICIES: readonly TicketingPolicy[] = ["issue_at_booking", "issue_after_payment", "manual_review"];

/**
 * The codes of an Amadeus `4xx` answer that refused the order as a business decision (error-mapper.ts): Amadeus
 * processed the request and did not create the order, so the authorisation is voided (step 2). A `5xx` is never one
 * of them, whatever its code (OADR-0003: the order may exist).
 */
const REJECTION_CODES: ReadonlySet<string> = new Set([
  "SOLD_OUT",
  "PRICE_CHANGED",
  "TRAVELER_DATA_INVALID",
  "SUPPLIER_REJECTED",
  "TICKETING_FAILED",
  "PAYMENT_DECLINED",
  "VERSION_CONFLICT",
]);

/**
 * The socket and TLS errors of a connection that was never made (the name, the address or the certificate failed):
 * the request cannot have reached Amadeus. Any other network error may have cut an answer off.
 */
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What step 0 read, for the claim and the call. */
interface Prepared {
  readonly checkout: CheckoutRow;
  readonly children: CheckoutChildren;
  readonly travelers: readonly CheckoutTravelerView[];
  readonly settings: BookingSettingsRow;
  readonly policy: TicketingPolicy;
  readonly priced: CheckoutPricedOffer;
  readonly payment: PaymentRow;
  readonly minorUnits: number;
  readonly pricingMode: string;
  readonly createdByStaffId: string | null;
  readonly locale: string;
}

/** A claimed booking. */
interface Claimed {
  readonly booking: BookingRow;
  readonly payment: PaymentRow;
}

/** The travellers a re-price sends (`pricingTravelersOf`), as Flight Offers Price takes them. */
type AmadeusTravelers = Parameters<typeof buildServicesRequest>[2];

/** The new prices of one stored extra after a re-price: selling and Amadeus price, its `ancillary_service` lines. */
interface ExtraPrices extends SelectionPrices {
  readonly feeLines: readonly FeeLine[];
}

/** A re-pricing of step 2: the new priced offer and, per stored extra in their order, its new prices or `undefined`. */
interface RepriceQuote {
  readonly priced: CheckoutPricedOffer;
  /** The Amadeus `warnings` of the pricing answer. */
  readonly warnings: unknown;
  readonly extras: ReadonlyArray<ExtraPrices | undefined>;
}

/** Where a re-price moves the checkout (and, when accepted, its booking): amounts in its pricing mode. */
interface Repriced {
  readonly priced: CheckoutPricedOffer;
  readonly offer: string;
  readonly ancillaries: string;
  /** Σ of the confirmed extras' Amadeus prices (`bookings.net_services_amount`). */
  readonly netServices: string;
  readonly total: string;
  /** The stored extras with their new prices (`details` as JSON text), and those Amadeus no longer confirms. */
  readonly extras: {
    readonly update: ReadonlyArray<{
      readonly id: string;
      readonly priceAmount: string;
      readonly netAmount: string;
      readonly details: string;
    }>;
    readonly remove: readonly string[];
  };
  readonly warnings: Warning[];
}

/** The unique constraints of `bookings` a claim can hit. */
const CHECKOUT_UNIQUE = "bookings_checkout_id_key";
const REFERENCE_UNIQUE = "bookings_reference_key";

/** The PostgreSQL unique violation of `constraint`. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    isRecord(error) &&
    (error as { code?: unknown }).code === "23505" &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

/** A Warning of our own (Warning.code is Amadeus's integer: ours name themselves in `title`). */
function ownWarning(title: string, detail: string): Warning {
  return { title, detail };
}

/**
 * The answer to a checkout that already has a booking (steps 0 and 1). A request with another key gets no guest
 * token: the one of the first answer exists only there and in its replays.
 */
function existingBookingError(booking: { readonly id: string; readonly status: string }): AppError {
  if (booking.status === "pending") {
    return new AppError("SUPPLIER_TIMEOUT", {
      message: "We are confirming your booking with the airline. Do not book again.",
      details: { bookingId: booking.id, ...NO_BOOKING_TOKEN, replayed: false },
    });
  }
  return new AppError("CHECKOUT_ALREADY_COMPLETED", { details: { bookingId: booking.id } });
}

/**
 * A `pending` booking whose order may exist (a lost answer): `504 SUPPLIER_TIMEOUT` with the booking and, for a
 * guest's key caller, its guest token.
 */
function supplierTimeout(
  bookingId: string,
  cause?: unknown,
  token: DeliveredBookingToken = NO_BOOKING_TOKEN,
): AppError {
  return new AppError("SUPPLIER_TIMEOUT", {
    message: "We are confirming your booking with the airline. Do not book again.",
    details: {
      bookingId,
      bookingToken: token.bookingToken,
      bookingTokenExpiresAt: token.bookingTokenExpiresAt,
      replayed: false,
    },
    cause,
  });
}

/**
 * The guest token of a stored `504 SUPPLIER_TIMEOUT` (its `details`, as the first answer gave it), for the final `201`
 * of its replays; none when the details hold none (a customer's booking, the edge, whose token is in the cookie).
 */
export function storedBookingTokenOf(response: IdempotencyResponse): DeliveredBookingToken {
  const error = isRecord(response.body) ? response.body["error"] : undefined;
  const details = isRecord(error) && isRecord(error["details"]) ? error["details"] : {};
  const token = details["bookingToken"];
  const expiresAt = details["bookingTokenExpiresAt"];
  return typeof token === "string" && typeof expiresAt === "string"
    ? { bookingToken: token, bookingTokenExpiresAt: expiresAt }
    : NO_BOOKING_TOKEN;
}

/** A booking id as checkout.complete writes them. */
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;

/**
 * The pending booking a stored answer of checkout.complete names: a `504 SUPPLIER_TIMEOUT` with `details.bookingId`
 * (the idempotency `resourceOf` hook); `undefined` for any other answer.
 */
export function pendingBookingOf(response: IdempotencyResponse): IdempotencyResource | undefined {
  const error = isRecord(response.body) ? response.body["error"] : undefined;
  if (response.status !== 504 || !isRecord(error) || error["code"] !== "SUPPLIER_TIMEOUT") {
    return undefined;
  }
  const bookingId = isRecord(error["details"]) ? error["details"]["bookingId"] : undefined;
  return typeof bookingId === "string" && BOOKING_ID.test(bookingId)
    ? { type: "booking", id: bookingId }
    : undefined;
}

/** A stored `504 SUPPLIER_TIMEOUT` as its replays send it while the booking is undecided: `details.replayed: true`. */
export function replayedTimeout(response: IdempotencyResponse): IdempotencyResponse {
  const body = isRecord(response.body) ? response.body : {};
  const error = isRecord(body["error"]) ? body["error"] : {};
  const details = isRecord(error["details"]) ? error["details"] : {};
  return {
    ...response,
    body: { ...body, error: { ...error, details: { ...details, replayed: true } } },
  };
}

/**
 * The final error of a checkout.complete whose booking failed after its `504` (the reconciliation proved the order
 * absent): `502 SUPPLIER_ERROR`, the public code of a reconciled create-order that failed; nothing was booked and the
 * authorisation is released.
 */
export function reconciledFailure(bookingId: string): AppError {
  return new AppError("SUPPLIER_ERROR", {
    message: "The airline did not confirm the booking. Nothing was booked and your payment was released.",
    details: { bookingId, bookingStatus: "failed" },
  });
}

/** The answer of a refused order (step 2), with the supplier issue kept for console scope. */
export function rejectionAnswer(error: AppError, priceDetails: JsonObject): AppError {
  if (
    error.code === "SOLD_OUT" ||
    error.code === "TRAVELER_DATA_INVALID" ||
    error.code === "TICKETING_FAILED"
  ) {
    return error;
  }
  const supplier = error.supplier === undefined ? {} : { supplier: error.supplier };
  if (error.code === "PRICE_CHANGED") {
    return new AppError("PRICE_CHANGED", {
      message: "The airline changed the price. Please review the new total.",
      details: priceDetails,
      ...supplier,
      cause: error,
    });
  }
  return new AppError("SUPPLIER_ERROR", { ...supplier, cause: error });
}

/**
 * The answer to an Amadeus call that did not create an order (a re-price that failed, or a Flight Create Orders that
 * was not sent), in the operation's codes: a timeout of the token request or of the pricing is `503
 * SUPPLIER_UNAVAILABLE` (a `504` would tell the client to look for a booking that does not exist), an office the
 * connection may not use `424 SUPPLIER_NOT_CONFIGURED`, a pricing Amadeus refused (`SUPPLIER_REJECTED`,
 * `VERSION_CONFLICT`) `502 SUPPLIER_ERROR` with the supplier issue; the others as they are.
 */
export function notSentAnswer(error: unknown): unknown {
  if (!(error instanceof AppError)) {
    return error;
  }
  if (error.code === "SUPPLIER_TIMEOUT") {
    return new AppError("SUPPLIER_UNAVAILABLE", { cause: error });
  }
  if (error.code === "OFFICE_NOT_ALLOWED") {
    return new AppError("SUPPLIER_NOT_CONFIGURED", { cause: error });
  }
  if (error.code === "SUPPLIER_REJECTED" || error.code === "VERSION_CONFLICT") {
    return new AppError("SUPPLIER_ERROR", {
      ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
      cause: error,
    });
  }
  return error;
}

/** How a Flight Create Orders call failed (step 2). */
export type CreateFailureKind = "rejected" | "not_sent" | "unknown";

/**
 * How a Flight Create Orders call failed (OADR-0003: only an answer that proves the order was not created may fail
 * the booking). Only an error whose cause is the order call's own AmadeusCallError says anything about the order:
 *   - no answer: a connection never made (NOT_CONNECTED_CODES) did not reach Amadeus (`not_sent`); a timeout, a reset
 *     or any other network error may have created the order (`unknown`);
 *   - an Amadeus `4xx`: a business refusal of REJECTION_CODES did not create it (`rejected`); a `401`, `403` or `429`
 *     refused the request before processing it (`not_sent`);
 *   - anything else (a `5xx`, 500, 502, 503 and 504 included, an answer that is not JSON, another status): the order
 *     may exist (`unknown`).
 * Every other error was raised before the request left this process (the token request, the rate limiter, the
 * office checks, a bug): `not_sent`.
 */
export function createFailureKind(error: unknown): CreateFailureKind {
  if (!(error instanceof AppError) || !(error.cause instanceof AmadeusCallError)) {
    return "not_sent";
  }
  const cause = error.cause;
  const status = cause.httpStatus;
  if (status === undefined) {
    const notConnected =
      cause.outcome === "network_error" && cause.code !== undefined && NOT_CONNECTED_CODES.has(cause.code);
    return notConnected ? "not_sent" : "unknown";
  }
  if (status >= 400 && status < 500) {
    return REJECTION_CODES.has(error.code) ? "rejected" : "not_sent";
  }
  return "unknown";
}

@Injectable()
export class BookingOrchestrator {
  private readonly baseDomain: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly callers: CallerContext,
    private readonly requestContext: RequestContext,
    private readonly customers: CustomerContext,
    private readonly repository: BookingsRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly payments: PaymentsRepository,
    private readonly checkoutDocuments: TravelerDocuments,
    private readonly bookingDocuments: BookingTravelerDocuments,
    private readonly recorder: OrderRecorder,
    private readonly pricedOffers: PricedOffersService,
    private readonly amadeus: AmadeusClient,
    private readonly connections: ConnectionResolver,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly staffRecipients: StaffRecipients,
    @InjectQueue(OTA_QUEUE.payments) private readonly paymentsQueue: Queue,
    @InjectQueue(OTA_QUEUE.bookings) private readonly bookingsQueue: Queue,
    private readonly reconcile: ReconcileRepository,
    private readonly guestAccess: GuestAccessService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: PinoLogger,
    config: ConfigService<SharedConfig, true>,
  ) {
    logger.setContext(BookingOrchestrator.name);
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  // ---- checkout.complete -------------------------------------------------------------------------------------------

  async complete(input: CompleteCheckoutInput): Promise<CheckoutCompletion> {
    const tenant = this.tenants.require();
    const ctx = this.gatewayContext(tenant);
    let claimed:
      { readonly prepared: Prepared; readonly claim: Claimed; readonly state: GatewayState } | undefined;
    let connection: ResolvedAmadeusConnection | undefined;
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS && claimed === undefined; attempt += 1) {
      const prepared = await this.tx.run((trx) => this.prepare(trx, tenant, input));
      connection ??= await this.connections.resolve(tenant.tenantId, tenant.environment);
      const state = await this.gateway.refresh(
        ctx,
        this.gatewayPaymentOf(prepared.payment, prepared.minorUnits),
      );
      this.checkPaymentState(prepared, state, input.body);
      const claim = await this.claim(tenant, prepared, state, connection);
      if (claim !== undefined) {
        claimed = { prepared, claim, state };
      }
    }
    if (claimed === undefined || connection === undefined) {
      // CONFLICT is not one of the operation's codes; a 503 releases the Idempotency-Key, so the same call can retry.
      throw new AppError("SERVICE_UNAVAILABLE", {
        message: "The checkout changed while it was completed; try again.",
      });
    }
    return await this.afterClaim(
      tenant,
      ctx,
      connection,
      claimed.prepared,
      claimed.claim,
      claimed.state,
      input,
    );
  }

  // ---- Step 0: read ------------------------------------------------------------------------------------------------

  private async prepare(
    trx: TenantTransaction,
    tenant: RequestTenant,
    input: CompleteCheckoutInput,
  ): Promise<Prepared> {
    const now = this.clock.now();
    const checkout = await this.checkouts.checkout(trx, input.checkoutId);
    if (checkout === undefined || checkout.environment !== tenant.environment || !this.mayAccess(checkout)) {
      throw new AppError("NOT_FOUND", { message: "No checkout with this id." });
    }
    const existing = await this.repository.bookingOfCheckout(trx, checkout.id);
    if (existing !== undefined) {
      throw existingBookingError(existing);
    }
    const status = effectiveStatus(checkout, now);
    if (status === "completed") {
      throw new AppError("CHECKOUT_ALREADY_COMPLETED");
    }
    if (status === "expired" || status === "abandoned") {
      throw new AppError("CHECKOUT_EXPIRED");
    }
    const settings = await this.repository.settings(trx);
    if (settings === undefined) {
      this.logger.warn({ tenantId: tenant.tenantId }, "bookings.settings_missing");
      throw new AppError("TENANT_SUSPENDED", { message: "The storefront of this OTA is not ready yet." });
    }
    if (settings.paymentTiming !== "authorize_before_booking") {
      // OADR-0008 point 2: the settings API refuses the other timings until a later decision.
      throw new AppError("UNPROCESSABLE", {
        message: "This payment timing is not supported.",
        details: { reason: "payment_timing_not_supported" },
      });
    }
    const priced = await this.pricedOffers.forCheckout(trx, checkout.pricedOfferId, input.acceptLanguage);
    if (priced === undefined) {
      throw new Error("the priced offer of a checkout is missing");
    }
    const children = await this.checkouts.children(trx, checkout.id);
    const travelers: CheckoutTravelerView[] = [];
    for (const row of children.travelers) {
      const opened = await this.checkoutDocuments.open(tenant.schemaName, row.id, row);
      travelers.push({ row, documents: opened.documents, discounts: opened.discounts });
    }
    const progress = progressOf(
      travelers as readonly TravelerView[],
      children.contacts,
      requirementsForPricedOffer(priced.pricedOffer),
      true,
    );
    if (!progress.travelersComplete || !progress.contactsComplete) {
      throw new AppError("CHECKOUT_INCOMPLETE", {
        message: "Complete the traveller and contact details before booking.",
        fieldErrors: progress.missing.slice(0, MAX_FIELD_ERRORS),
      });
    }
    const paymentId = input.body.paymentId ?? (await this.repository.activePaymentId(trx, checkout.id));
    if (paymentId === undefined) {
      throw new AppError("PAYMENT_REQUIRED", { message: "Pay for the checkout before completing it." });
    }
    const payment = await this.payments.payment(trx, paymentId);
    if (
      payment === undefined ||
      payment.checkoutId !== checkout.id ||
      payment.environment !== tenant.environment
    ) {
      throw new AppError("NOT_FOUND", { message: "No payment with this id." });
    }
    if (payment.method === "airline_card") {
      throw new AppError("UNPROCESSABLE", {
        message: "Complete an airline-card payment with checkout.completeWithAirlineCard.",
        details: { reason: "use_airline_card_completion" },
      });
    }
    if (payment.provider !== "stripe") {
      throw new AppError("UNPROCESSABLE", {
        message: "This payment cannot complete the checkout.",
        details: { reason: "payment_provider_not_supported" },
      });
    }
    if (
      payment.providerPaymentId === null ||
      ["canceled", "refunded", "partially_refunded"].includes(payment.status) ||
      // The reconciliation proved the order of this payment's booking absent: its authorisation is being voided.
      (payment.bookingId !== null && (await this.reconcile.notFound(trx, payment.bookingId)))
    ) {
      throw new AppError("PAYMENT_REQUIRED", { message: "Pay for the checkout before completing it." });
    }
    const extras = await this.repository.checkoutExtras(trx, checkout.id);
    const policy = POLICIES.find((entry) => entry === settings.ticketingPolicy) ?? "issue_after_payment";
    return {
      checkout,
      children,
      travelers,
      settings,
      policy,
      priced,
      payment,
      minorUnits: (await this.payments.currencyMinorUnits(trx, checkout.currency)) ?? 2,
      pricingMode: extras?.pricingMode ?? "markup_rules",
      createdByStaffId: extras?.createdByStaffId ?? null,
      locale: checkout.locale ?? settings.defaultLocale,
    };
  }

  /** The PaymentIntent must hold the checkout total (step 0). */
  private checkPaymentState(prepared: Prepared, state: GatewayState, body: CheckoutCompleteRequest): void {
    const { checkout, payment, minorUnits } = prepared;
    if (state.status === "failed") {
      throw new AppError("PAYMENT_DECLINED", { message: "The payment was declined. Pay with another card." });
    }
    if (state.status !== "authorized" && state.status !== "captured") {
      throw new AppError("PAYMENT_REQUIRED", { message: "The payment is not authorised yet." });
    }
    if (state.card !== null && payment.cardBrand !== null && state.card.brand !== payment.cardBrand) {
      // The card fee was quoted for the hint's brand (README, payments "Not yet"); the amount is what decides.
      this.logger.warn({ paymentId: payment.id }, "bookings.card_brand_differs_from_hint");
    }
    const held = state.status === "authorized" ? state.amountCapturable : state.amountReceived;
    if (!new Money(held).equals(checkout.totalAmount)) {
      throw new AppError("PAYMENT_AMOUNT_MISMATCH", {
        message: "The total changed after the payment was created. Please pay again.",
        details: {
          paymentId: payment.id,
          paymentAmount: this.money(held, checkout.currency, minorUnits),
          checkoutTotal: this.money(checkout.totalAmount, checkout.currency, minorUnits),
        },
      });
    }
    const expected = body.expectedTotal;
    if (
      expected !== undefined &&
      (expected.currency !== checkout.currency ||
        new Money(checkout.totalAmount).greaterThan(expected.amount))
    ) {
      throw new AppError("PRICE_CHANGED", {
        message: "The total is higher than the one you confirmed. Please review it.",
        details: {
          oldPrice: { amount: expected.amount, currency: expected.currency },
          newPrice: this.money(checkout.totalAmount, checkout.currency, minorUnits),
          pricedOfferId: checkout.pricedOfferId,
        },
      });
    }
  }

  // ---- Step 1: claim -----------------------------------------------------------------------------------------------

  /** T1 (see the file header); `undefined` when the checkout or the payment changed since step 0. */
  private async claim(
    tenant: RequestTenant,
    prepared: Prepared,
    state: GatewayState,
    connection: ResolvedAmadeusConnection,
  ): Promise<Claimed | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.tx.run((trx) => this.claimIn(trx, tenant, prepared, state, connection));
      } catch (error) {
        if (isUniqueViolation(error, REFERENCE_UNIQUE) && attempt < 3) {
          continue;
        }
        if (isUniqueViolation(error, CHECKOUT_UNIQUE)) {
          const existing = await this.tx.run((trx) =>
            this.repository.bookingOfCheckout(trx, prepared.checkout.id),
          );
          throw existing === undefined ? error : existingBookingError(existing);
        }
        throw error;
      }
    }
  }

  private async claimIn(
    trx: TenantTransaction,
    tenant: RequestTenant,
    prepared: Prepared,
    state: GatewayState,
    connection: ResolvedAmadeusConnection,
  ): Promise<Claimed | undefined> {
    const now = this.clock.now();
    const checkout = await this.checkouts.checkout(trx, prepared.checkout.id, true);
    if (checkout === undefined) {
      throw new AppError("NOT_FOUND", { message: "No checkout with this id." });
    }
    const existing = await this.repository.bookingOfCheckout(trx, checkout.id, true);
    if (existing !== undefined) {
      throw existingBookingError(existing);
    }
    if (checkout.version !== prepared.checkout.version) {
      return undefined;
    }
    const status = effectiveStatus(checkout, now);
    if (status === "expired" || status === "abandoned") {
      throw new AppError("CHECKOUT_EXPIRED");
    }
    if (status === "completed") {
      throw new AppError("CHECKOUT_ALREADY_COMPLETED");
    }
    let payment = await this.payments.payment(trx, prepared.payment.id, true);
    if (payment === undefined || payment.providerPaymentId !== state.providerPaymentId) {
      return undefined;
    }
    if (
      !["requires_payment_method", "requires_action", "processing", "authorized", "captured"].includes(
        payment.status,
      )
    ) {
      throw new AppError("PAYMENT_REQUIRED", { message: "The payment is not authorised." });
    }
    if (payment.status !== state.status) {
      const { values } = stateValues(payment, state, now);
      await this.payments.updatePayment(trx, payment.id, payment.version, values);
      await this.paymentEvent(trx, payment, {
        type: `payment.${state.status}`,
        statusFrom: payment.status,
        statusTo: state.status,
        payload: { source: "checkout.complete" },
        now,
      });
      payment = await this.payments.payment(trx, payment.id, true);
      if (payment === undefined) {
        return undefined;
      }
    }
    const bookingId = this.ids.newId("bkg");
    const reference = newBookingReference();
    const { priced } = prepared;
    const parsed = confirmedOffersOf(priced).map((entry) => entry.parsed);
    const segments = parsed.flatMap((offer) => offer.itineraries.flatMap((itinerary) => itinerary.segments));
    const zones = await this.repository.airportTimeZones(
      trx,
      segments.flatMap((segment) => [segment.departure.iataCode, segment.arrival.iataCode]),
    );
    const firstSegment = segments[0];
    const lastSegment = segments.at(-1);
    if (firstSegment === undefined || lastSegment === undefined) {
      throw new Error("a priced offer without segments");
    }
    const [firstDeparture, lastArrival] = await this.repository.instants(trx, [
      { local: firstSegment.departure.at, zone: zones.get(firstSegment.departure.iataCode) ?? "UTC" },
      { local: lastSegment.arrival.at, zone: zones.get(lastSegment.arrival.iataCode) ?? "UTC" },
    ]);
    const departure = firstDeparture ?? now;
    const amounts = netAmountsOf(priced, prepared.minorUnits);
    const netServices = prepared.children.ancillaries
      .reduce((sum, row) => sum.plus(row.netAmount), new Money(0))
      .toFixed(prepared.minorUnits);
    const lead =
      prepared.travelers.find((view) => view.row.travelerType !== "HELD_INFANT") ?? prepared.travelers[0];
    const primary =
      prepared.children.contacts.find((contact) => contact.isPrimary) ?? prepared.children.contacts[0];
    const summary = priced.pricedOffer.offers[0]?.summary;
    const itineraries = priced.pricedOffer.offers.flatMap((offer) => offer.itineraries);
    await this.repository.insertBooking(trx, {
      id: bookingId,
      environment: tenant.environment,
      reference,
      channel: checkout.channel === "console" ? "console" : "storefront",
      customer_id: checkout.customerId,
      checkout_id: checkout.id,
      priced_offer_id: priced.row.id,
      created_by_staff_id: prepared.createdByStaffId,
      status: "pending",
      supplier_connection_id: connection.connectionId,
      queuing_office_id: connection.offices.queuing,
      owner_office_id: connection.offices.owner,
      last_ticketing_date: priced.row.lastTicketingDate,
      issue_requested: issueAtCreate(prepared.policy, requiresInstantTicketing(confirmedPayloadsOf(priced))),
      ticketing_status: "pending",
      trip_type: tripTypeOf(itineraries.length, summary?.tripType),
      origin_iata: itineraries[0]?.originCode ?? firstSegment.departure.iataCode,
      destination_iata: itineraries[0]?.destinationCode ?? lastSegment.arrival.iataCode,
      first_departure_at: departure,
      last_arrival_at:
        lastArrival === undefined || lastArrival.getTime() < departure.getTime() ? departure : lastArrival,
      validating_carrier: parsed[0]?.validatingAirlineCodes[0] ?? null,
      travelers_count: Math.max(1, prepared.travelers.length),
      currency: checkout.currency,
      pricing_mode: prepared.pricingMode,
      markup_rule_id: priced.row.markupRuleId,
      // The Amadeus total with the booked services (a child priced offer's net is its flights'), as the column holds.
      net_amount: new Money(priced.row.netTotal).plus(netServices).toFixed(prepared.minorUnits),
      net_base_amount: amounts.base,
      net_fees_amount: amounts.fees,
      net_services_amount: netServices,
      markup_amount: priced.row.markupAmount,
      fees_amount: priced.row.feeAmount,
      card_fee_amount: checkout.feesAmount,
      ancillaries_amount: checkout.ancillariesAmount,
      taxes_amount: amounts.taxes,
      total_amount: checkout.totalAmount,
      contact_email: primary?.email ?? "",
      lead_last_name: (lead?.row.lastName ?? "").toUpperCase(),
      metadata: JSON.stringify(isRecord(checkout.metadata) ? checkout.metadata : {}),
      create_order_started_at: now,
      version: 1,
      created_at: now,
      updated_at: now,
    });
    // The payment's foreign key takes the new booking's FOR KEY SHARE after the payment's lock: a row this transaction
    // inserted, which no other transaction can see or lock before the commit, so it never waits. The claim's order is
    // the checkout, an existing booking, the payment (OADR-0003 point 11).
    await this.payments.updatePayment(trx, payment.id, payment.version, {
      booking_id: bookingId,
      updated_at: now,
    });
    await this.recorder.event(trx, bookingId, {
      type: "booking.create_order_started",
      actor: eventActorOf(tenant.actor),
      statusTo: "pending",
      summary: `Booking ${reference} claimed for checkout ${checkout.id}.`,
      data: { checkoutId: checkout.id, paymentId: payment.id },
      visibleToCustomer: false,
      requestId: this.requestId(tenant),
      now,
    });
    const booking = await this.repository.booking(trx, bookingId);
    const linked = await this.payments.payment(trx, payment.id);
    if (booking === undefined || linked === undefined) {
      throw new Error("a claimed booking is not readable in its own transaction");
    }
    return { booking, payment: linked };
  }

  // ---- Steps 2 to 5 ------------------------------------------------------------------------------------------------

  private async afterClaim(
    tenant: RequestTenant,
    ctx: GatewayContext,
    connection: ResolvedAmadeusConnection,
    prepared: Prepared,
    claim: Claimed,
    state: GatewayState,
    input: CompleteCheckoutInput,
  ): Promise<CheckoutCompletion> {
    const { booking } = claim;
    const warnings: Warning[] = [];
    let priced = prepared.priced;
    let total = prepared.checkout.totalAmount;
    let repriced: Repriced | undefined;
    try {
      repriced = await this.repriceIfNeeded(tenant, ctx, prepared, claim, input);
      if (repriced !== undefined) {
        priced = repriced.priced;
        total = repriced.total;
        warnings.push(...repriced.warnings);
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      await this.failBooking(tenant, prepared, claim, { code: "INTERNAL_ERROR", voided: false });
      throw error;
    }

    const flightOffers = confirmedPayloadsOf(priced);
    const issue = issueAtCreate(prepared.policy, requiresInstantTicketing(flightOffers));
    let decided: AppError | undefined;
    try {
      decided = await this.recordSending(prepared, claim, { repriced, issue });
    } catch (error) {
      // Nothing was sent: the booking fails and the authorisation is kept, as for a request that never left.
      await this.failBooking(tenant, prepared, claim, { code: "INTERNAL_ERROR", voided: false });
      throw error;
    }
    if (decided !== undefined) {
      throw decided;
    }
    let reply: AmadeusResponse<unknown>;
    try {
      const request = buildCreateOrderRequest({
        flightOffers,
        travelers: prepared.travelers.map(orderTravelerOf),
        contacts: prepared.children.contacts,
        remarks: prepared.children.remarks,
        reference: booking.reference,
        queue:
          prepared.settings.bookingQueueNumber === null
            ? null
            : {
                number: prepared.settings.bookingQueueNumber,
                category: prepared.settings.bookingQueueCategory,
              },
        offices: connection.offices,
        issue,
      });
      reply = await this.amadeus.createFlightOrders(this.callContext(tenant, booking.id), {
        body: request.body as unknown as Parameters<AmadeusClient["createFlightOrders"]>[1]["body"],
        query: request.query,
      });
    } catch (error) {
      throw await this.afterCreateFailure(tenant, ctx, prepared, claim, error, { priced, repriced, issue });
    }
    const order = readCreatedOrder(reply.body);
    if (order === undefined) {
      // The order exists (a 2xx) but its answer cannot be recorded: it is found again like a lost answer (OBE-043).
      this.logger.error({ bookingId: booking.id }, "bookings.create_order_unreadable");
      throw await this.unknownOutcome(tenant, prepared, claim, "create_order_unreadable", {
        repriced,
        issue,
      });
    }
    warnings.push(...order.warnings);

    let recorded: RecordedOrder;
    try {
      recorded = await this.tx.run(async (trx) => {
        const now = this.clock.now();
        // The lock order: the checkout, then the booking (OADR-0003 point 11), as the claim takes them.
        await this.checkouts.checkout(trx, prepared.checkout.id, true);
        const locked = await this.repository.booking(trx, booking.id, true);
        if (locked === undefined || locked.status !== "pending") {
          throw new Error("a claimed booking left `pending` during its own request");
        }
        if (repriced !== undefined) {
          await this.moveToPricedOffer(trx, prepared, booking.id, repriced, now);
        }
        const current = await this.repository.booking(trx, booking.id);
        if (current === undefined) {
          throw new Error("a claimed booking is not readable");
        }
        const result = await this.recorder.record(trx, {
          schema: tenant.schemaName,
          tenantKey: tenant.key,
          booking: current,
          order,
          travelers: prepared.travelers,
          contacts: prepared.children.contacts,
          remarks: prepared.children.remarks,
          settings: prepared.settings,
          policy: prepared.policy,
          issueRequested: issue,
          locale: prepared.locale,
          actor: tenant.actor,
          requestId: this.requestId(tenant),
          supplierRequestId: reply.call.supplierRequestId,
          now,
        });
        await this.repository.updateCheckout(trx, prepared.checkout.id, {
          status: "completed",
          completed_at: now,
          updated_at: now,
        });
        return result;
      });
    } catch (error) {
      // The order exists at Amadeus, but T2 rolled back: the booking is still `pending` with its claim, and the
      // authorisation is untouched. It is answered and found again like a lost answer (OBE-043), never booked twice.
      this.logger.error({ bookingId: booking.id, err: error }, "bookings.record_failed");
      throw await this.unknownOutcome(tenant, prepared, claim, "record_failed", { repriced, issue });
    }

    // Step 4: money.
    let captured = state.status === "captured";
    const mustCapture = prepared.policy !== "manual_review" || recorded.coverage !== "none";
    if (!captured && mustCapture) {
      captured = await this.capture(tenant, ctx, prepared, claim, total, recorded.status, warnings);
    } else if (!captured) {
      await this.tx.run(async (trx) => {
        await this.staffAlert(trx, booking, "manual_review_policy", {
          reason:
            "The ticketing policy of the OTA is manual review: issue the tickets from the console, which captures the payment first.",
          locale: prepared.settings.defaultLocale,
        });
      });
    }

    // Step 5: issue.
    if (captured && prepared.policy === "issue_after_payment" && recorded.coverage === "none" && !issue) {
      await this.issue(tenant, booking, order, warnings);
    }

    const completion = await this.answer(tenant, prepared, booking.id, warnings);
    this.logger.info(
      {
        bookingId: booking.id,
        checkoutId: prepared.checkout.id,
        status: completion.booking.status,
        ticketingStatus: completion.booking.ticketing.status,
        policy: prepared.policy,
        // Whether step 2 priced the offers again; never the re-priced offer itself (it holds Amadeus's answer).
        repriced: repriced !== undefined,
      },
      "bookings.completed",
    );
    return completion;
  }

  // ---- Step 2: re-price --------------------------------------------------------------------------------------------

  /**
   * The re-price of step 2, or `undefined` when the priced offer is still good (see the file header). The new prices
   * are compared in the checkout's pricing mode (pricing-mode.ts): a higher total, or an extra Amadeus no longer
   * confirms, voids the authorisation, fails the booking, moves the checkout and answers `409 PRICE_CHANGED`.
   */
  private async repriceIfNeeded(
    tenant: RequestTenant,
    ctx: GatewayContext,
    prepared: Prepared,
    claim: Claimed,
    input: CompleteCheckoutInput,
  ): Promise<Repriced | undefined> {
    const now = this.clock.now();
    const { priced, checkout, minorUnits } = prepared;
    const discounts = prepared.travelers.some((view) => view.discounts.length > 0);
    const stale =
      priced.row.expiresAt.getTime() <= now.getTime() ||
      now.getTime() - priced.row.createdAt.getTime() > REPRICE_AFTER_MS;
    if (!stale && !discounts) {
      return undefined;
    }
    const travelers = discounts
      ? (pricingTravelersOf(prepared.travelers.map(orderTravelerOf)) as unknown as AmadeusTravelers)
      : undefined;
    const rows = prepared.children.ancillaries;
    const quote =
      rows.length === 0
        ? await this.repriceFlights(tenant, ctx, prepared, claim, input, travelers)
        : await this.repriceWithExtras(tenant, ctx, prepared, claim, input, travelers);
    const kept = rows.flatMap((row, index) => {
      const price = quote.extras[index];
      return price === undefined ? [] : [{ row, price }];
    });
    const dropped = rows.filter((_, index) => quote.extras[index] === undefined);
    const mode: PricingMode = isPricingMode(prepared.pricingMode) ? prepared.pricingMode : "markup_rules";
    const amounts = baseAmountsFor(
      mode,
      { sellingTotal: quote.priced.row.sellingTotal, netTotal: quote.priced.row.netTotal },
      kept.map((entry) => entry.price),
      minorUnits,
    );
    const newTotal = new Money(amounts.offer)
      .plus(amounts.ancillaries)
      .plus(checkout.feesAmount)
      .toFixed(minorUnits);
    const moved: Omit<Repriced, "warnings"> = {
      priced: quote.priced,
      offer: amounts.offer,
      ancillaries: amounts.ancillaries,
      netServices: kept
        .reduce((sum, entry) => sum.plus(entry.price.netAmount), new Money(0))
        .toFixed(minorUnits),
      total: newTotal,
      extras: {
        update: kept.map(({ row, price }) => ({
          id: row.id,
          priceAmount: price.priceAmount,
          netAmount: price.netAmount,
          details: JSON.stringify({
            ...(isRecord(row.details) ? row.details : {}),
            feeLines: price.feeLines,
          }),
        })),
        remove: dropped.map((row) => row.id),
      },
    };
    const expected = input.body.expectedTotal;
    const higher =
      new Money(newTotal).greaterThan(checkout.totalAmount) ||
      (expected !== undefined && new Money(newTotal).greaterThan(expected.amount));
    if (higher || dropped.length > 0) {
      // Never booked without an extra the customer chose and paid for: the price-changed path of the contract.
      const voided = await this.voidPayment(tenant, ctx, prepared, claim.payment);
      await this.failBooking(tenant, prepared, claim, {
        code: "PRICE_CHANGED",
        voided,
        moveTo: { ...moved, warnings: [] },
      });
      throw new AppError("PRICE_CHANGED", {
        message:
          dropped.length > 0
            ? "An extra you chose is no longer available. Please review your booking."
            : "The airline changed the price. Please review the new total.",
        details: {
          oldPrice: expected ?? this.money(checkout.totalAmount, checkout.currency, minorUnits),
          newPrice: this.money(newTotal, checkout.currency, minorUnits),
          pricedOfferId: quote.priced.row.id,
          ...(dropped.length > 0 ? { reason: "extras_unavailable" } : {}),
        },
      });
    }
    const warnings = warningsOf(quote.warnings);
    if (new Money(newTotal).lessThan(checkout.totalAmount)) {
      warnings.push(
        ownWarning(
          "PRICE_DECREASED",
          `The airline lowered the price: ${this.money(newTotal, checkout.currency, minorUnits).amount} ${checkout.currency} is charged.`,
        ),
      );
    }
    return { ...moved, warnings };
  }

  /**
   * The flights alone priced again (PricedOffersService.repriceForCheckout: the search offers, a child priced offer
   * priced as flights.price prices one); every stored extra counts as not confirmed (`extras` all `undefined`).
   */
  private async repriceFlights(
    tenant: RequestTenant,
    ctx: GatewayContext,
    prepared: Prepared,
    claim: Claimed,
    input: CompleteCheckoutInput,
    travelers: AmadeusTravelers | undefined,
  ): Promise<RepriceQuote> {
    try {
      const repriced = await this.pricedOffers.repriceForCheckout({
        pricedOfferId: prepared.priced.row.id,
        travelers: travelers as Parameters<PricedOffersService["repriceForCheckout"]>[0]["travelers"],
        bookingId: claim.booking.id,
        acceptLanguage: input.acceptLanguage,
      });
      return {
        priced: repriced.current,
        warnings: repriced.warnings,
        extras: prepared.children.ancillaries.map(() => undefined),
      };
    } catch (error) {
      throw await this.repriceFailed(tenant, ctx, prepared, claim, error);
    }
  }

  /**
   * The base priced offer's confirmed offers priced again with the checkout's extras (the same additional services as
   * checkout.setAncillaries sent: `storedExtrasOf`, `buildServicesRequest`), stored as a child of the base as
   * checkout.setAncillaries stores one (PricedOffersService.storeServicesPricing). Each extra gets its new net
   * (`extraNets`) and `ancillary_service` fee lines; one the answer does not carry is not confirmed (`undefined`). When
   * Amadeus refuses an extra (4926, 32171 on it), the flights are priced again alone and no extra is confirmed.
   */
  private async repriceWithExtras(
    tenant: RequestTenant,
    ctx: GatewayContext,
    prepared: Prepared,
    claim: Claimed,
    input: CompleteCheckoutInput,
    travelers: AmadeusTravelers | undefined,
  ): Promise<RepriceQuote> {
    const { checkout } = prepared;
    const base = await this.tx.run((trx) =>
      this.pricedOffers.forCheckout(trx, checkout.basePricedOfferId, input.acceptLanguage),
    );
    if (base === undefined) {
      throw new Error("the base priced offer of a checkout is missing");
    }
    const stored = storedOffersOf(base.row);
    const extras = storedExtrasOf(prepared.children.ancillaries, stored);
    if (extras === undefined) {
      throw new Error("the extras of a checkout cannot be read back");
    }
    let request: ServicesRequest;
    try {
      request = buildServicesRequest(
        stored,
        extras,
        travelers ?? [],
        snapshotOf(base.row.response).fareRules,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "ANCILLARY_NOT_AVAILABLE") {
        // The stored offers lack an extra's traveller or segment: it cannot be booked as chosen.
        return await this.repriceFlights(tenant, ctx, prepared, claim, input, travelers);
      }
      throw error;
    }
    let reply: AmadeusResponse<unknown>;
    try {
      reply = await this.amadeus.quoteAirOffers(
        {
          tenantId: tenant.tenantId,
          environment: tenant.environment,
          operation: "checkout.complete",
          requestId: this.requestId(tenant),
          bookingId: claim.booking.id,
        },
        {
          body: request.request as unknown as Parameters<AmadeusClient["quoteAirOffers"]>[1]["body"],
          query: pricingQuery(SERVICES_INCLUDE, base.row.forceClass),
        },
      );
    } catch (error) {
      const mapped = servicesErrorOf(error, request.pointers, extras);
      if (mapped instanceof AppError && mapped.code === "ANCILLARY_NOT_AVAILABLE") {
        this.logger.warn({ bookingId: claim.booking.id, extras: extras.length }, "bookings.extras_refused");
        return await this.repriceFlights(tenant, ctx, prepared, claim, input, travelers);
      }
      throw await this.repriceFailed(tenant, ctx, prepared, claim, error);
    }
    const units = base.minorUnits;
    let child: ServicesPricing;
    let kept: ServiceExtra[];
    let nets: string[];
    try {
      const confirmed = confirmedPricingOffersOf(
        stored.map((offer) => ({
          id: offer.offerId,
          amadeusOfferId: offer.amadeusOfferId,
          currency: base.row.currency,
        })),
        readPricingReply(reply.body).flightOffers,
        parseOffer,
      );
      if (confirmed === undefined) {
        throw new AppError("SUPPLIER_ERROR", { message: "The supplier's pricing answer could not be read." });
      }
      const missing = new Set(extrasMissingFrom(extras, confirmed).map((extra) => extra.index));
      // `extraNets` places each net at its extra's index: the confirmed extras, numbered again.
      kept = extras
        .filter((extra) => !missing.has(extra.index))
        .map((extra, position) => ({ ...extra, index: position }));
      nets = extraNets(kept, confirmed, units);
      const extrasToPrice = pricingExtrasOf(kept, nets);
      child = await this.tx.run((trx) =>
        this.pricedOffers.storeServicesPricing(trx, {
          base: base.row,
          request: request.request,
          include: SERVICES_INCLUDE,
          reply,
          extras: extrasToPrice,
          acceptLanguage: input.acceptLanguage,
        }),
      );
    } catch (error) {
      throw await this.repriceFailed(tenant, ctx, prepared, claim, error);
    }
    const prices = new Map(
      kept.map((extra, position): [string, ExtraPrices] => {
        const net = new Money(nets[position] ?? 0);
        const feeLines = child.extraFeeLines.filter((line) => line.extraRef === extra.ref);
        return [
          extra.ref,
          {
            priceAmount: feeLines.reduce((sum, line) => sum.plus(line.amount), net).toFixed(units),
            netAmount: net.toFixed(units),
            feeLines,
          },
        ];
      }),
    );
    this.logger.info(
      {
        bookingId: claim.booking.id,
        pricedOfferId: child.priced.row.id,
        extras: extras.length,
        kept: kept.length,
      },
      "bookings.repriced_with_extras",
    );
    return {
      priced: child.priced,
      warnings: readPricingReply(reply.body).warnings,
      extras: extras.map((extra) => prices.get(extra.ref)),
    };
  }

  /**
   * A re-pricing that failed: a fare that is gone voids the authorisation (`409 SOLD_OUT`); any other failure (a read
   * that did not answer, an answer that could not be read or priced) books nothing and keeps the authorisation for a
   * retry, answered in the operation's codes (`notSentAnswer`). The booking is `failed` either way.
   */
  private async repriceFailed(
    tenant: RequestTenant,
    ctx: GatewayContext,
    prepared: Prepared,
    claim: Claimed,
    error: unknown,
  ): Promise<unknown> {
    if (error instanceof AppError && error.code === "SOLD_OUT") {
      await this.failBooking(tenant, prepared, claim, {
        code: "SOLD_OUT",
        voided: await this.voidPayment(tenant, ctx, prepared, claim.payment),
      });
      return error;
    }
    await this.failBooking(tenant, prepared, claim, {
      code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      voided: false,
    });
    return notSentAnswer(error);
  }

  /**
   * Step 2, before Flight Create Orders is sent (lead decision of 2026-10-21, third batch): under the booking's lock,
   * the booking must still be `pending` and undecided (the reconciliation may have adopted a claim whose request took
   * longer than its 2 minutes, OADR-0003 point 4: then nothing is sent), and it records what is about to be sent, so
   * that a process that dies after the send leaves a booking that holds the order's amounts: `issue_requested` the flag
   * sent and, after an accepted re-price, the priced offer sent with its amounts (`repricedBookingValues`). The
   * reconciliation of an adopted claim captures that total, never the first priced offer's. The checkout is moved
   * only once the order may exist (T2, or the unknown outcome): a request that is not sent leaves it on the total its
   * authorisation holds. Answers `undefined` to send, else the answer to give instead.
   */
  private async recordSending(
    prepared: Prepared,
    claim: Claimed,
    sent: { readonly repriced: Repriced | undefined; readonly issue: boolean },
  ): Promise<AppError | undefined> {
    return await this.tx.run(async (trx): Promise<AppError | undefined> => {
      const now = this.clock.now();
      const booking = await this.reconcile.lock(trx, claim.booking.id, { skipLocked: false });
      if (booking === undefined) {
        throw new Error("a claimed booking is not readable");
      }
      if (booking.status !== "pending" || booking.reconcileOutcome !== null) {
        // Decided by the reconciliation before the order left: it is never sent for this claim.
        this.logger.error(
          { bookingId: booking.id, status: booking.status, outcome: booking.reconcileOutcome },
          "bookings.decided_before_send",
        );
        return booking.status === "failed"
          ? reconciledFailure(booking.id)
          : booking.status === "pending"
            ? supplierTimeout(booking.id)
            : existingBookingError(booking);
      }
      if (sent.repriced !== undefined || booking.issueRequested !== sent.issue) {
        await this.repository.updateBooking(trx, booking.id, {
          ...(sent.repriced === undefined ? {} : this.repricedBookingValues(prepared, sent.repriced)),
          issue_requested: sent.issue,
          updated_at: now,
        });
      }
      return undefined;
    });
  }

  /** The booking's columns of an accepted re-price: the priced offer sent and its amounts. */
  private repricedBookingValues(
    prepared: Prepared,
    repriced: Repriced,
  ): Omit<Updateable<TenantDatabase["bookings"]>, "version" | "id"> {
    const { priced } = repriced;
    const amounts = netAmountsOf(priced, prepared.minorUnits);
    return {
      priced_offer_id: priced.row.id,
      net_amount: new Money(priced.row.netTotal).plus(repriced.netServices).toFixed(prepared.minorUnits),
      net_base_amount: amounts.base,
      net_fees_amount: amounts.fees,
      net_services_amount: repriced.netServices,
      taxes_amount: amounts.taxes,
      markup_amount: priced.row.markupAmount,
      markup_rule_id: priced.row.markupRuleId,
      fees_amount: priced.row.feeAmount,
      ancillaries_amount: repriced.ancillaries,
      total_amount: repriced.total,
      last_ticketing_date: priced.row.lastTicketingDate,
    };
  }

  /**
   * The booking and the checkout follow an accepted re-price (in T2, or at an unknown outcome), the checkout's extras
   * with their new prices; the caller locked the checkout, then the booking.
   */
  private async moveToPricedOffer(
    trx: TenantTransaction,
    prepared: Prepared,
    bookingId: string,
    repriced: Repriced,
    now: Date,
  ): Promise<void> {
    await this.repository.updateBooking(trx, bookingId, {
      ...this.repricedBookingValues(prepared, repriced),
      updated_at: now,
    });
    await this.moveCheckout(trx, prepared, repriced, now);
  }

  /** The checkout on a re-priced offer: its extras' new prices (the others removed) and its amounts. */
  private async moveCheckout(
    trx: TenantTransaction,
    prepared: Prepared,
    repriced: Omit<Repriced, "warnings">,
    now: Date,
    status?: string,
  ): Promise<void> {
    const checkoutId = prepared.checkout.id;
    for (const extra of repriced.extras.update) {
      await this.checkouts.updateAncillary(trx, checkoutId, extra.id, {
        price_amount: extra.priceAmount,
        net_amount: extra.netAmount,
        details: extra.details,
        updated_at: now,
      });
    }
    await this.checkouts.deleteAncillaries(trx, checkoutId, repriced.extras.remove);
    await this.repository.updateCheckout(trx, checkoutId, {
      ...(status === undefined ? {} : { status }),
      priced_offer_id: repriced.priced.row.id,
      offer_amount: repriced.offer,
      ancillaries_amount: repriced.ancillaries,
      total_amount: repriced.total,
      updated_at: now,
    });
  }

  // ---- Step 2: failures --------------------------------------------------------------------------------------------

  /** The answer after Flight Create Orders failed (see the file header). */
  private async afterCreateFailure(
    tenant: RequestTenant,
    ctx: GatewayContext,
    prepared: Prepared,
    claim: Claimed,
    error: unknown,
    sent: {
      readonly priced: CheckoutPricedOffer;
      readonly repriced: Repriced | undefined;
      readonly issue: boolean;
    },
  ): Promise<unknown> {
    const { priced } = sent;
    const kind = createFailureKind(error);
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    this.logger.warn(
      { bookingId: claim.booking.id, code, outcome: kind },
      kind === "unknown" ? "bookings.create_order_timeout" : "bookings.create_order_failed",
    );
    if (kind === "unknown") {
      return await this.unknownOutcome(tenant, prepared, claim, code, sent, error);
    }
    if (kind === "not_sent") {
      await this.failBooking(tenant, prepared, claim, { code, voided: false });
      return notSentAnswer(error);
    }
    const voided = await this.voidPayment(tenant, ctx, prepared, claim.payment);
    await this.failBooking(tenant, prepared, claim, { code, voided });
    const { checkout, minorUnits } = prepared;
    return rejectionAnswer(error as AppError, {
      oldPrice: this.money(checkout.totalAmount, checkout.currency, minorUnits),
      pricedOfferId: priced.row.id,
    });
  }

  /**
   * The unknown outcome of step 2 (see the file header): the booking stays `pending` with its claim and the
   * authorisation, `reconcile_until = create_order_started_at + RECONCILE_WINDOW_MS` and the event
   * `booking.supplier_timeout` (`reason`: the error code, or what could not be recorded); the booking holds what the
   * order sent holds (an accepted re-price moves it and the checkout to the new priced offer, `issue_requested` is the
   * flag sent), and the first `booking.reconcile` is queued after the commit, 30 seconds later (the scan of
   * reconcile.processor.ts queues it all the same when Redis does not answer); answers `504 SUPPLIER_TIMEOUT`. Nothing
   * is voided. A T that fails here is logged and the `504` stays the answer, as the booking is pending either way.
   */
  private async unknownOutcome(
    tenant: RequestTenant,
    prepared: Prepared,
    claim: Claimed,
    reason: string,
    sent: { readonly repriced: Repriced | undefined; readonly issue: boolean },
    cause?: unknown,
  ): Promise<AppError> {
    let pending: BookingRow | undefined;
    try {
      pending = await this.tx.run(async (trx): Promise<BookingRow | undefined> => {
        const now = this.clock.now();
        // The lock order: the checkout (which an accepted re-price moves), then the booking (OADR-0003 point 11).
        await this.checkouts.checkout(trx, prepared.checkout.id, true);
        const booking = await this.repository.booking(trx, claim.booking.id, true);
        if (booking === undefined || booking.status !== "pending") {
          return undefined;
        }
        if (sent.repriced !== undefined) {
          await this.moveToPricedOffer(trx, prepared, booking.id, sent.repriced, now);
        }
        const started = booking.createOrderStartedAt ?? now;
        const until = new Date(started.getTime() + RECONCILE_WINDOW_MS);
        await this.repository.updateBooking(trx, booking.id, {
          reconcile_until: until,
          issue_requested: sent.issue,
          updated_at: now,
        });
        await this.recorder.event(trx, booking.id, {
          type: "booking.supplier_timeout",
          actor: eventActorOf(tenant.actor),
          statusFrom: "pending",
          statusTo: "pending",
          summary: `Amadeus did not confirm booking ${booking.reference}; the order is looked for until ${until.toISOString()}.`,
          data: { checkoutId: prepared.checkout.id, reason, reconcileUntil: until.toISOString() },
          visibleToCustomer: false,
          requestId: this.requestId(tenant),
          now,
        });
        const job = reconcileJob(tenant.tenantId, booking.id, "first");
        afterCommit(trx, () => this.enqueue(tenant, this.bookingsQueue, job.name, job.data, job.opts));
        return booking;
      });
    } catch (error) {
      this.logger.error({ bookingId: claim.booking.id, err: error }, "bookings.reconcile_not_scheduled");
    }
    // The guest follows the pending booking with its token (bookings.getTicketingStatus) until it is decided.
    return supplierTimeout(claim.booking.id, cause, await this.guestTokenOf(pending));
  }

  /**
   * Voids the authorisation at Stripe (`pi:cancel:<pay_id>`); answers the provider's state, or `null` when the call
   * failed: then `payment.void` is queued for the payments queue (OBE-040) and the row stays as it is.
   */
  private async voidPayment(
    tenant: RequestTenant,
    ctx: GatewayContext,
    prepared: Prepared,
    payment: PaymentRow,
  ): Promise<GatewayState | null> {
    try {
      return await this.gateway.void(ctx, this.gatewayPaymentOf(payment, prepared.minorUnits));
    } catch (error) {
      this.logger.warn(
        { paymentId: payment.id, code: error instanceof AppError ? error.code : undefined },
        "bookings.void_failed",
      );
      await this.enqueue(
        tenant,
        this.paymentsQueue,
        PAYMENT_JOBS.void,
        { tenantId: tenant.tenantId, id: payment.id },
        { jobId: `payment-void-${payment.id}` },
      );
      return null;
    }
  }

  /**
   * The booking is `failed` (`checkout_id` cleared so the checkout can be completed again), with its event; a voided
   * payment is `canceled` and its checkout `open` again (moved to a re-priced offer when given); a payment that was
   * not voided keeps the checkout `payment_pending`.
   */
  private async failBooking(
    tenant: RequestTenant,
    prepared: Prepared,
    claim: Claimed,
    failure: {
      readonly code: string;
      /** The provider's state after a void, `null` when the void call failed, `false` when nothing was voided. */
      readonly voided: GatewayState | null | false;
      readonly moveTo?: Repriced;
    },
  ): Promise<void> {
    await this.tx.run(async (trx) => {
      const now = this.clock.now();
      // The lock order: the checkout (reopened below after a void), the booking, then the payment (OADR-0003 point 11).
      if (failure.voided !== false) {
        await this.checkouts.checkout(trx, prepared.checkout.id, true);
      }
      const booking = await this.repository.booking(trx, claim.booking.id, true);
      if (booking === undefined || booking.status !== "pending") {
        return;
      }
      await this.repository.updateBooking(trx, booking.id, {
        status: "failed",
        ticketing_status: "not_applicable",
        checkout_id: null,
        failure_code: failure.code,
        failure_message: `checkout.complete: ${failure.code}`,
        updated_at: now,
      });
      await this.recorder.event(trx, booking.id, {
        type: "booking.failed",
        actor: eventActorOf(tenant.actor),
        statusFrom: "pending",
        statusTo: "failed",
        summary: `Booking ${booking.reference} not created: ${failure.code}.`,
        data: {
          checkoutId: prepared.checkout.id,
          code: failure.code,
          paymentVoided: failure.voided !== false && failure.voided !== null,
        },
        visibleToCustomer: false,
        requestId: this.requestId(tenant),
        now,
      });
      if (failure.voided === false) {
        return;
      }
      if (failure.voided !== null) {
        const payment = await this.payments.payment(trx, claim.payment.id, true);
        if (payment !== undefined && failure.voided.status === "canceled" && payment.status !== "canceled") {
          const { values } = stateValues(payment, failure.voided, now);
          await this.payments.updatePayment(trx, payment.id, payment.version, values);
          await this.paymentEvent(trx, payment, {
            type: "payment.voided",
            statusFrom: payment.status,
            statusTo: "canceled",
            payload: { reason: failure.code, bookingId: booking.id },
            now,
          });
        }
      }
      if (failure.moveTo === undefined) {
        await this.repository.updateCheckout(trx, prepared.checkout.id, { status: "open", updated_at: now });
      } else {
        await this.moveCheckout(trx, prepared, failure.moveTo, now, "open");
      }
    });
  }

  // ---- Step 4: money -----------------------------------------------------------------------------------------------

  /** Captures `amount`; answers whether it was captured (a failure is recorded, see the file header). */
  private async capture(
    tenant: RequestTenant,
    ctx: GatewayContext,
    prepared: Prepared,
    claim: Claimed,
    amount: string,
    bookingStatus: string,
    warnings: Warning[],
  ): Promise<boolean> {
    const { minorUnits } = prepared;
    const captureAmount = new Money(amount).toFixed(minorUnits);
    let state: GatewayState;
    try {
      state = await this.gateway.capture(
        ctx,
        this.gatewayPaymentOf(claim.payment, minorUnits),
        captureAmount,
      );
    } catch (error) {
      this.logger.warn(
        {
          bookingId: claim.booking.id,
          paymentId: claim.payment.id,
          code: error instanceof AppError ? error.code : undefined,
        },
        "bookings.capture_failed",
      );
      await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const booking = await this.repository.booking(trx, claim.booking.id, true);
        if (booking === undefined) {
          return;
        }
        await this.repository.updateBooking(trx, booking.id, {
          // A ticketed booking keeps `issued` (bookings_ticketing_ck); the others wait for staff.
          ...(bookingStatus === "ticketed"
            ? {}
            : { ticketing_status: "manual_review", ticketing_next_attempt_at: null }),
          ticketing_error_code: "PAYMENT_CAPTURE_FAILED",
          ticketing_error: "The Stripe capture failed after the order was created",
          updated_at: now,
        });
        const payment = await this.payments.payment(trx, claim.payment.id, true);
        if (payment !== undefined) {
          await this.paymentEvent(trx, payment, {
            type: "payment.capture_failed",
            payload: { bookingId: booking.id, amount: captureAmount },
            now,
          });
        }
        await this.recorder.event(trx, booking.id, {
          type: "payment.capture_failed",
          actor: eventActorOf(tenant.actor),
          summary: "The payment could not be captured; staff will review the booking.",
          data: { paymentId: claim.payment.id },
          visibleToCustomer: false,
          requestId: this.requestId(tenant),
          now,
        });
        await this.staffAlert(trx, booking, "capture_failed", {
          reason:
            "The payment could not be captured after the order was created. The capture is retried once in 10 minutes; check the payment before issuing.",
          locale: prepared.settings.defaultLocale,
        });
        afterCommit(trx, () =>
          this.enqueue(
            tenant,
            this.paymentsQueue,
            PAYMENT_JOBS.captureRetry,
            { tenantId: tenant.tenantId, id: claim.payment.id },
            { jobId: `capture-retry-${claim.payment.id}`, delay: CAPTURE_RETRY_DELAY_MS },
          ),
        );
      });
      warnings.push(
        ownWarning(
          "CAPTURE_FAILED",
          "Your booking is confirmed; the payment is being finalised and the tickets are issued once it is.",
        ),
      );
      return false;
    }
    await this.tx.run(async (trx) => {
      const now = this.clock.now();
      // The lock order of a transaction that changes a booking and its payment: the booking first, then the payment
      // (OADR-0003 point 11), as the failed capture above, failBooking and the reconciliation take them.
      await this.repository.booking(trx, claim.booking.id, true);
      const payment = await this.payments.payment(trx, claim.payment.id, true);
      if (payment !== undefined && payment.status !== "captured") {
        const { values } = stateValues(payment, state, now);
        await this.payments.updatePayment(trx, payment.id, payment.version, values);
        await this.paymentEvent(trx, payment, {
          type: "payment.captured",
          statusFrom: payment.status,
          statusTo: state.status,
          amount: captureAmount,
          payload: { bookingId: claim.booking.id },
          now,
        });
      }
      await this.repository.updateBooking(trx, claim.booking.id, {
        amount_paid: new Money(state.amountReceived).toFixed(minorUnits),
        updated_at: now,
      });
      await this.recorder.event(trx, claim.booking.id, {
        type: "payment.captured",
        actor: eventActorOf(tenant.actor),
        summary: "Payment received.",
        data: { paymentId: claim.payment.id, amount: captureAmount },
        visibleToCustomer: true,
        requestId: this.requestId(tenant),
        now,
      });
    });
    return true;
  }

  // ---- Step 5: issue -----------------------------------------------------------------------------------------------

  private async issue(
    tenant: RequestTenant,
    claimed: BookingRow,
    order: CreatedOrder,
    warnings: Warning[],
  ): Promise<void> {
    const started = await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const booking = await this.repository.booking(trx, claimed.id, true);
      if (booking === undefined || booking.status !== "confirmed" || booking.ticketingStatus !== "pending") {
        return undefined;
      }
      await this.repository.updateBooking(trx, booking.id, {
        ticketing_status: "in_progress",
        ticketing_requested_at: now,
        ticketing_attempts: booking.ticketingAttempts + 1,
        ticketing_last_attempt_at: now,
        ticketing_next_attempt_at: null,
        updated_at: now,
      });
      return booking;
    });
    if (started === undefined) {
      return;
    }
    const offerIds = order.offers.map((offer) => offer.amadeusId);
    let issued: CreatedOrder | undefined;
    let failureCode = "TICKETING_FAILED";
    let supplierRequestId: string | null = null;
    try {
      const reply = await this.amadeus.issueFlightOrder(
        this.callContext(tenant, started.id, started.ownerOfficeId ?? undefined),
        {
          flightOrderId: order.id,
          body: buildIssueRequest(offerIds) as unknown as Parameters<
            AmadeusClient["issueFlightOrder"]
          >[1]["body"],
        },
      );
      supplierRequestId = reply.call.supplierRequestId;
      issued = readCreatedOrder(reply.body);
      warnings.push(...warningsOf(isRecord(reply.body) ? reply.body["warnings"] : undefined));
    } catch (error) {
      failureCode = error instanceof AppError ? error.code : "INTERNAL_ERROR";
      this.logger.warn({ bookingId: started.id, code: failureCode }, "bookings.issue_failed");
    }
    const coverage = issued === undefined ? "none" : ticketCoverage(issued.travelerIds, issued.tickets);
    await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const booking = await this.repository.booking(trx, started.id, true);
      if (booking === undefined) {
        return;
      }
      if (issued === undefined || coverage === "none") {
        await this.repository.updateBooking(trx, booking.id, {
          ticketing_status: "failed",
          ticketing_next_attempt_at: new Date(now.getTime() + FIRST_TICKETING_RETRY_MS),
          ticketing_error_code: failureCode,
          ticketing_error: `Flight Order Issue failed: ${failureCode}`,
          updated_at: now,
        });
        await this.recorder.event(trx, booking.id, {
          type: "booking.ticketing_failed",
          actor: eventActorOf(tenant.actor),
          summary: "The airline did not issue the tickets yet; the issuance is retried.",
          data: { attempt: booking.ticketingAttempts, code: failureCode },
          visibleToCustomer: false,
          supplierRequestId,
          requestId: this.requestId(tenant),
          now,
        });
        return;
      }
      const travelerIds = await this.repository.travelerIds(trx, booking.id);
      await this.repository.insertTickets(
        trx,
        this.recorder.ticketRows(booking.id, issued, travelerIds, now),
      );
      const state = ticketingStateOf(coverage, { issueRequested: true, policy: "issue_after_payment" });
      await this.repository.updateBooking(trx, booking.id, {
        status: state.status,
        ticketing_status: state.ticketingStatus,
        issued_at: now,
        ticketing_error_code: null,
        ticketing_error: null,
        order_snapshot: JSON.stringify(redactPayload(issued.data)),
        last_synced_at: now,
        updated_at: now,
      });
      await this.recorder.event(trx, booking.id, {
        type: "booking.ticketed",
        actor: eventActorOf(tenant.actor),
        statusFrom: booking.status,
        statusTo: state.status,
        summary: "E-tickets issued.",
        data: { tickets: issued.tickets.map((ticket) => ticket.documentNumber) },
        visibleToCustomer: true,
        supplierRequestId,
        requestId: this.requestId(tenant),
        now,
      });
    });
  }

  // ---- The answer --------------------------------------------------------------------------------------------------

  /** The `201` of step 5: the booking read again, with the guest token of a guest booking (see the file header). */
  private async answer(
    tenant: RequestTenant,
    prepared: Prepared,
    bookingId: string,
    warnings: readonly Warning[],
  ): Promise<CheckoutCompletion> {
    const { completion, booking } = await this.tx.run(async (trx) => {
      const row = await this.repository.booking(trx, bookingId);
      if (row === undefined) {
        throw new Error("a recorded booking is not readable");
      }
      return {
        completion: await this.completionIn(trx, tenant, row, {
          checkoutId: prepared.checkout.id,
          policy: prepared.policy,
          minorUnits: prepared.minorUnits,
          warnings,
        }),
        booking: row,
      };
    });
    return { ...completion, ...(await this.guestTokenOf(booking)) };
  }

  /**
   * The guest token of a booking without a customer (`booking_created`), written in a short transaction of its own and
   * handed out once it committed (a cookie or a body token never names a token that does not exist); none for a
   * customer's booking. Best effort: the booking exists and is answered even when the token cannot be written or
   * handed out (logged; the guest can still look the booking up).
   */
  private async guestTokenOf(booking: BookingRow | undefined): Promise<DeliveredBookingToken> {
    if (booking === undefined || booking.customerId !== null) {
      return NO_BOOKING_TOKEN;
    }
    try {
      const issued: IssuedBookingToken = await this.tx.run((trx) =>
        this.guestAccess.issue(trx, {
          bookingId: booking.id,
          environment: booking.environment,
          issuedVia: "booking_created",
          expiresAt: completionTokenExpiry(this.clock.now(), booking.lastArrivalAt),
        }),
      );
      return this.guestAccess.deliver(issued);
    } catch (error) {
      this.logger.error({ bookingId: booking.id, err: error }, "bookings.guest_token_not_issued");
      return NO_BOOKING_TOKEN;
    }
  }

  /**
   * The CheckoutCompletion of a booking, read in `trx` (step 5's answer, and the replay of a decided booking), without
   * a guest token (the callers add theirs).
   */
  private async completionIn(
    trx: TenantTransaction,
    tenant: RequestTenant,
    booking: BookingRow,
    answer: {
      readonly checkoutId: string;
      readonly policy: TicketingPolicy;
      readonly minorUnits: number;
      readonly warnings: readonly Warning[];
    },
  ): Promise<CheckoutCompletion> {
    const now = this.clock.now();
    const children = await this.repository.children(trx, booking.id);
    const travelers = [];
    for (const row of children.travelers) {
      const opened = await this.bookingDocuments.open(tenant.schemaName, row);
      travelers.push({ row, documents: opened.documents, discounts: opened.discounts });
    }
    const payments = [];
    for (const id of await this.repository.paymentIdsOf(trx, booking.id)) {
      const row = await this.payments.payment(trx, id);
      if (row !== undefined) {
        payments.push(
          toPayment(row, { minorUnits: answer.minorUnits, clientSecret: null, publishableKey: null }),
        );
      }
    }
    return {
      checkoutId: answer.checkoutId,
      booking: toBooking({
        booking,
        children,
        travelers,
        payments,
        policy: answer.policy,
        minorUnits: answer.minorUnits,
        now,
      }),
      ...NO_BOOKING_TOKEN,
      warnings: [...answer.warnings],
    };
  }

  // ---- Same-key retries (OBE-043) ----------------------------------------------------------------------------------

  /**
   * The answer to a same-key retry of a checkout.complete whose stored answer is a `504` linked to its booking (the
   * idempotency `resolveReplay` hook; see the file header): the same `504` (`replayed: true`) while the booking is
   * `pending`, the final `502 SUPPLIER_ERROR` once it failed, else the final `201` built from the booking. `undefined`
   * (the stored answer) for any other record, or a booking this request cannot read.
   */
  async replay(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    if (record.resource?.type !== "booking" || record.response.status !== 504) {
      return undefined;
    }
    const bookingId = record.resource.id;
    const tenant = this.tenants.require();
    return await this.tx.run(async (trx): Promise<IdempotencyResponse | undefined> => {
      const booking = await this.repository.booking(trx, bookingId);
      if (booking === undefined || booking.environment !== tenant.environment) {
        return undefined;
      }
      if (booking.status === "pending") {
        return replayedTimeout(record.response);
      }
      if (booking.status === "failed") {
        const { status, body } = toErrorEnvelope(reconciledFailure(booking.id), this.requestId(tenant), {
          exposeSupplier: this.requestContext.isConsoleScope(),
        });
        return { status, headers: { "cache-control": "no-store" }, setCookie: [], body };
      }
      if (booking.checkoutId === null) {
        return undefined;
      }
      const settings = await this.repository.settings(trx);
      const completion = await this.completionIn(trx, tenant, booking, {
        checkoutId: booking.checkoutId,
        policy: POLICIES.find((entry) => entry === settings?.ticketingPolicy) ?? "issue_after_payment",
        minorUnits: (await this.payments.currencyMinorUnits(trx, booking.currency)) ?? 2,
        warnings: [],
      });
      this.logger.info({ bookingId, status: booking.status }, "bookings.completion_replayed");
      // The guest token of the first answer, as it gave it: in its details (a key caller) or its cookie (the edge).
      return {
        status: 201,
        headers: { location: `/v1/bookings/${booking.id}`, "cache-control": "no-store" },
        setCookie: [...record.response.setCookie],
        body: { ...completion, ...storedBookingTokenOf(record.response) },
      };
    });
  }

  // ---- Shared ------------------------------------------------------------------------------------------------------

  /** As checkout.get's access (checkout.service.ts): console scope, a guest checkout's id, its customer, a secret key. */
  private mayAccess(row: CheckoutRow): boolean {
    if (this.requestContext.isConsoleScope()) {
      return true;
    }
    if (row.customerId === null && row.isGuest) {
      return true;
    }
    const customer = this.customers.get();
    if (customer !== undefined) {
      return row.customerId !== null && row.customerId === customer.customerId;
    }
    const caller = this.callers.get();
    return caller?.type === "key" && caller.kind === "secret";
  }

  /**
   * A staff alert (`staff.manual_review`) to `ops_alert_email`, else the owners (notifications/staff-recipients.ts);
   * skipped (and logged) when the OTA has neither: the API has no OPS_ALERT_EMAIL (a worker variable). Its console link
   * is `https://admin.<STOREFRONT_BASE_DOMAIN>/bookings/<bkg_…>`: the API has no PUBLIC_OTA_ADMIN_URL either.
   */
  private async staffAlert(
    trx: TenantTransaction,
    booking: BookingRow,
    kind: string,
    alert: { readonly reason: string; readonly locale: string },
  ): Promise<void> {
    try {
      await this.staffRecipients.enqueue(trx, {
        templateKey: "staff.manual_review",
        locale: alert.locale,
        bookingId: booking.id,
        dedupeKey: `staff.manual_review:${booking.id}:${kind}`,
        data: {
          booking: {
            reference: booking.reference,
            recordLocator: booking.recordLocator ?? "",
            consoleUrl: `https://admin.${this.baseDomain}/bookings/${booking.id}`,
          },
          review: { reason: alert.reason },
        },
      });
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.warn({ bookingId: booking.id, kind }, "bookings.staff_alert_invalid");
    }
  }

  /**
   * Adds a job to `ota-payments` or `ota-bookings`; never throws (a failure or a Redis that does not answer is logged:
   * the jobs' own scans find the work).
   */
  private async enqueue(
    tenant: RequestTenant,
    queue: Queue,
    name: string,
    data: PaymentJobData | { readonly tenantId: string; readonly bookingId: string },
    opts: JobsOptions,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const added = queue.add(name, data, opts).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ tenantId: tenant.tenantId, job: name, err: error }, "bookings.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), ENQUEUE_TIMEOUT_MS);
    });
    try {
      if ((await Promise.race([added, timedOut])) === "timeout") {
        this.logger.warn({ tenantId: tenant.tenantId, job: name }, "bookings.enqueue_timeout");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async paymentEvent(
    trx: TenantTransaction,
    row: PaymentRow,
    event: {
      readonly type: string;
      readonly statusFrom?: string | undefined;
      readonly statusTo?: string | undefined;
      readonly amount?: string | undefined;
      readonly payload?: Record<string, unknown>;
      readonly now: Date;
    },
  ): Promise<void> {
    await this.payments.insertEvent(trx, {
      id: this.ids.newId("pev"),
      payment_id: row.id,
      type: event.type,
      source: "api",
      status_from: event.statusFrom ?? null,
      status_to: event.statusTo ?? null,
      amount: event.amount ?? null,
      currency: event.amount === undefined ? null : row.currency,
      payload: JSON.stringify(event.payload ?? {}),
      created_at: event.now,
      updated_at: event.now,
    });
  }

  private callContext(tenant: RequestTenant, bookingId: string, orderOffice?: string): AmadeusCallContext {
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: "checkout.complete",
      requestId: this.requestId(tenant),
      bookingId,
      ...(orderOffice === undefined ? {} : { orderOffice }),
      ...(tenant.actor.type === "staff" && tenant.actor.id !== null ? { staffId: tenant.actor.id } : {}),
    };
  }

  private gatewayContext(tenant: RequestTenant): GatewayContext {
    return { tenantId: tenant.tenantId, environment: tenant.environment, requestId: this.requestId(tenant) };
  }

  private requestId(tenant: RequestTenant): string {
    return this.tenants.requestId() ?? tenant.requestId;
  }

  private gatewayPaymentOf(row: PaymentRow, minorUnits: number): GatewayPayment {
    return {
      id: row.id,
      checkoutId: row.checkoutId,
      providerPaymentId: row.providerPaymentId,
      currency: row.currency,
      amount: new Money(row.amount).toFixed(minorUnits),
      minorUnits,
      version: row.version,
    };
  }

  private money(amount: string, currency: string, minorUnits: number): MoneyAmount {
    return { amount: new Money(amount).toFixed(minorUnits), currency };
  }
}

/**
 * The idempotency hooks of checkout.complete (OBE-043; idempotency.service.ts): a stored `504 SUPPLIER_TIMEOUT` is
 * linked to its pending booking and kept, and its same-key replays are answered from the booking
 * (`BookingOrchestrator.replay`; see the file header).
 */
@Injectable()
@IdempotencyHooksFor(["completeCheckout"])
export class CompleteCheckoutIdempotencyHooks implements IdempotencyHooks {
  constructor(private readonly orchestrator: BookingOrchestrator) {}

  resourceOf(response: IdempotencyResponse): IdempotencyResource | undefined {
    return pendingBookingOf(response);
  }

  resolveReplay(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    return this.orchestrator.replay(record);
  }
}

// ---- Helpers -------------------------------------------------------------------------------------------------------

/** The priced offer's confirmed Amadeus offers, verbatim and parsed, in the order of its snapshot. */
export function confirmedOffersOf(
  priced: CheckoutPricedOffer,
): Array<{ readonly payload: unknown; readonly parsed: ParsedOffer }> {
  const snapshot = snapshotOf(priced.row.response);
  const answered = readPricingReply(priced.row.response).flightOffers;
  return snapshot.offers.flatMap((entry) => {
    const payload = answered.find((offer) => isRecord(offer) && offer["id"] === entry.amadeusOfferId);
    const parsed = payload === undefined ? undefined : parseOffer(payload);
    return payload === undefined || parsed === undefined ? [] : [{ payload, parsed }];
  });
}

/** The confirmed Amadeus offers of a priced offer, verbatim. */
export function confirmedPayloadsOf(priced: CheckoutPricedOffer): unknown[] {
  return confirmedOffersOf(priced).map((entry) => entry.payload);
}

/** Σ of the confirmed offers' Amadeus base fares, fees and taxes (`total − base − fees`), in minor units. */
export function netAmountsOf(
  priced: CheckoutPricedOffer,
  minorUnits: number,
): { readonly base: string; readonly fees: string; readonly taxes: string } {
  let base = new Money(0);
  let fees = new Money(0);
  let taxes = new Money(0);
  for (const { parsed } of confirmedOffersOf(priced)) {
    const offerFees = parsed.price.fees.reduce((sum, fee) => sum.plus(fee.amount), new Money(0));
    base = base.plus(parsed.price.base);
    fees = fees.plus(offerFees);
    taxes = taxes.plus(new Money(parsed.price.total).minus(parsed.price.base).minus(offerFees));
  }
  return { base: base.toFixed(minorUnits), fees: fees.toFixed(minorUnits), taxes: taxes.toFixed(minorUnits) };
}

/** `bookings.trip_type`: the priced offer's, else from the number of bounds. */
function tripTypeOf(bounds: number, summary: string | undefined): string {
  if (summary === "one_way" || summary === "round_trip" || summary === "multi_city") {
    return bounds > 1 && summary === "one_way" ? "multi_city" : summary;
  }
  return bounds <= 1 ? "one_way" : "multi_city";
}

/** A checkout traveller as the order request builder reads it. */
export function orderTravelerOf(view: CheckoutTravelerView): OrderTraveler {
  const { row } = view;
  return {
    travelerId: row.amadeusTravelerId,
    firstName: row.firstName,
    middleName: row.middleName,
    lastName: row.lastName,
    secondLastName: row.secondLastName,
    dateOfBirth: row.dateOfBirth,
    gender: row.gender,
    contact: row.contact,
    documents: view.documents,
    discounts: view.discounts,
    loyaltyPrograms: row.loyaltyPrograms,
    emergencyContact: row.emergencyContact,
  };
}
