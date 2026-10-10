/**
 * @velexis/ota-sdk — `checkout` and `bookings` namespaces (area B3: checkout, payment, bookings, tickets, documents).
 *
 * Priced offer (`prc_…`, from `flights.price`) → `checkout.create` (`chk_…`) → travellers, contacts, ancillaries,
 * special requests → `checkout.createPayment` (`pay_…`, PSP-agnostic; the provider's SDK collects the card and runs
 * 3-D Secure; `checkout.updatePayment` sets the card brand / BIN once the card form reports it) → `checkout.complete`
 * (Amadeus Flight Create Orders + Flight Order Issue) → booking (`bkg_…`) → "My trips" (`bookings.list`), booking
 * detail, guest lookup, changes, extra bags after booking (`bookings.getAncillaries` → `bookings.createPayment` →
 * `bookings.addAncillaries`), cancellation, documents, timeline.
 *
 * Every method maps 1:1 to an operation of the Velexis OTA Booking API (`x-sdk-method`). Amadeus APIs behind this area:
 * Flight Offers Price (re-pricing with ancillaries / card fees / at completion), Flight Create Orders, Flight Order
 * Issue, Flight Order Management (GET with `include=bags` / `fareRules=rebooks|refunds`, PATCH, DELETE).
 *
 * Keys and tokens
 * - Publishable key (`pk_…`): every method here; safe in client components (origin allow-list applies).
 * - Secret key (`sk_…`): every method; server only (server components, server actions, route handlers).
 * - Customer token: owns checkouts and bookings; required by `bookings.list`.
 * - Guest booking token (`X-Booking-Token`, client option `bookingToken` or `RequestOptions.bookingToken`): returned by
 *   `checkout.complete` for guest checkouts (also in the `SUPPLIER_TIMEOUT` error details) and by `bookings.lookup`;
 *   grants access to one booking only. Keep it in the httpOnly cookie `vx_bt_<bookingId>` (`setBookingTokenCookie`
 *   from `@velexis/ota-sdk/next`) and read it server-side (`createServerClient({ bookingId })`); never pass it to
 *   client components — the browser client's same-origin proxy attaches it for client-side calls.
 * - Staff token: may drive `checkout.*` for assisted bookings; staff booking management lives in `console.*`.
 * - Environment: test keys see only test checkouts, payments and bookings, live keys only live ones (anything of the
 *   other environment is a `404`), even for the same customer.
 *
 * Ids: `travelerId` is always the Amadeus traveller id (`"1"`, `"2"`, …) in requests and responses; `Traveler.id` is
 * the Velexis row id (`ctr_…` / `btr_…`) and is never sent back; saved travellers are `trv_…` (`savedTravelerId`).
 *
 * Caching: everything here is personal, priced or time-limited — the SDK sends `cache: "no-store"` by default.
 * Never pass `next.revalidate` to these methods. State-changing POSTs get an `Idempotency-Key` automatically
 * (pass `options.idempotencyKey` to control it, e.g. one key per checkout completion attempt). The server replays the
 * stored outcome for a repeated key — including after `504 SUPPLIER_TIMEOUT` of `checkout.complete`,
 * `bookings.addAncillaries` and `bookings.cancel`, where a same-key retry never calls Amadeus again — so the SDK's
 * automatic retries (`maxRetries`) are safe for these POSTs.
 */
import type { Schemas, RequestOptions, Page, ListParams, WithWarnings, Money } from "./shared";

/* ------------------------------------------------------------------------------------------------------------ */
/* Schema aliases                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** Checkout session (`chk_…`): totals, requirements, progress, travellers, contacts, ancillaries, remarks, payment. */
export type Checkout = Schemas["Checkout"];
/** `open` | `payment_pending` | `completed` | `expired` | `abandoned`. */
export type CheckoutStatus = Checkout["status"];
/** What the customer pays (`total = offer + ancillaries + cardFee`; supplier / service fees are inside `offer`). */
export type CheckoutTotals = Schemas["CheckoutTotals"];
/** Contact and per-traveller requirements derived from Amadeus `bookingRequirements`. */
export type CheckoutRequirements = Schemas["CheckoutRequirements"];
/** Requirements of one traveller (required fields, date-of-birth range, accepted document types). */
export type CheckoutTravelerRequirement = Schemas["CheckoutTravelerRequirement"];
/** Completeness of the checkout steps (`missing` lists what is still needed). */
export type CheckoutProgress = Schemas["CheckoutProgress"];
/** A selected ancillary with its re-priced selling price. */
export type CheckoutAncillary = Schemas["CheckoutAncillary"];
/** Result of {@link CheckoutApi.complete}: the booking and, for guests, the one-time booking token. */
export type CheckoutCompletion = Schemas["CheckoutCompletion"];
/**
 * Traveller of a checkout or booking, aligned with Amadeus `Traveler`. `id` is the Velexis row id (`ctr_…` / `btr_…`,
 * read-only); `travelerId` is the Amadeus id used by every request. Documents carry `numberMasked` only.
 */
export type Traveler = Schemas["Traveler"];
/** Identity document of a {@link Traveler} as returned (`numberMasked`, never a masked value in `number`). */
export type TravelerDocument = Schemas["TravelerDocument"];
/**
 * Identity document as sent to {@link CheckoutApi.setTravelers} / {@link BookingsApi.update}. Omit `number` to keep the
 * stored number (matched by `documentType` + `issuanceCountry`), so a {@link TravelerDocument} can be sent back as is.
 */
export type TravelerDocumentInput = Schemas["TravelerDocumentInput"];
/** Traveller as sent to {@link CheckoutApi.setTravelers}: keyed by `travelerId` (Amadeus id) + `savedTravelerId` (`trv_…`), `saveToAccount`. */
export type TravelerInput = Schemas["TravelerInput"];
/** `fieldErrors[].code` values of `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID` and `CHECKOUT_INCOMPLETE`. */
export type TravelerFieldErrorCode = Schemas["TravelerFieldErrorCode"];
/** Booking contact (`cco_…` / `bco_…`), Amadeus `Contact`. */
export type Contact = Schemas["Contact"];
/** Contact as sent to {@link CheckoutApi.setContacts} and {@link BookingsApi.update}. */
export type ContactInput = Schemas["ContactInput"];
/** Remark (customer special request → Amadeus general remark). */
export type Remark = Schemas["Remark"];
/** Special request as sent to {@link CheckoutApi.setRemarks} / {@link BookingsApi.update}. */
export type RemarkInput = Schemas["RemarkInput"];
/** Payment (`pay_…`) at the OTA's payment provider. */
export type Payment = Schemas["Payment"];
/** Payment status machine (requires_payment_method → requires_action → processing → authorized → captured …; `cancelled` / `failed`). */
export type PaymentStatus = Payment["status"];
/** `booking` (checkout payment) or `ancillaries` (extras bought after booking). */
export type PaymentPurpose = NonNullable<Payment["purpose"]>;
/** Payment methods a storefront can start. */
export type CheckoutPaymentMethod = Schemas["PaymentCreateRequest"]["method"];
/** Payment service providers. */
export type PaymentProvider = Payment["provider"];
/** Card brand + BIN hint used for the credit-card fee. */
export type PaymentCardHint = Schemas["PaymentCardHint"];
/** Booking (`bkg_…`): an Amadeus flight order as the customer sees it. */
export type Booking = Schemas["Booking"];
/** `pending` | `confirmed` | `ticketed` | `partially_ticketed` | `cancelled` | `failed`. */
export type BookingStatus = Schemas["BookingStatus"];
/** Booking card for "My trips". */
export type BookingSummary = Schemas["BookingSummary"];
/** Self-service actions currently allowed (+ reasons). */
export type BookingAllowedActions = Schemas["BookingAllowedActions"];
/** Customer-allowed traveller change keyed by `travelerId` (documents, loyalty, contact, emergency contact). */
export type BookingTravelerUpdate = Schemas["BookingTravelerUpdate"];
/** Extras that can still be bought for a booking ({@link BookingsApi.getAncillaries}). */
export type BookingAncillaryOptions = Schemas["BookingAncillaryOptions"];
/** One extra checked-bag option of an existing booking (`bao_…`). */
export type BookingAncillaryOption = Schemas["BookingAncillaryOption"];
/** One extra to buy for a booking: option + traveller (+ quantity). */
export type BookingAncillarySelection = Schemas["BookingAncillarySelection"];
/** A booked bag, seat or service (`source`: `checkout` | `post_booking` | `airline`). */
export type BookingAncillary = Schemas["BookingAncillary"];
/** Issued travel document (e-ticket / EMD). */
export type Ticket = Schemas["Ticket"];
/** Ticketing status of a booking. */
export type TicketingStatus = Schemas["IssuanceStatus"];
/** OTA ticketing policy (`issue_at_booking` | `issue_after_payment` | `manual_review`). */
export type TicketingPolicy = Schemas["IssuancePolicy"];
/** Ticketing progress returned by {@link BookingsApi.getTicketingStatus}. */
export type BookingTicketingStatus = Schemas["BookingTicketingStatus"];
/** Generated booking document (e-ticket receipt, EMD receipt, itinerary, invoice, credit note). */
export type BookingDocument = Schemas["Document"];
/** Document kinds. */
export type BookingDocumentKind = BookingDocument["kind"];
/** Short-lived signed download URL. */
export type DocumentDownloadUrl = Schemas["DocumentDownloadUrl"];
/** Customer-visible timeline entry. */
export type BookingEvent = Schemas["BookingEvent"];
/** Rebooking / refund eligibility of a booking. */
export type BookingFareRules = Schemas["BookingFareRules"];
/** What cancelling now would do (mode, estimated refund, penalties, per-traveller lines). */
export type CancellationQuote = Schemas["CancellationQuote"];
/** Cancellation of a booking. */
export type Cancellation = Schemas["Cancellation"];
/** Customer's cancellation reason code (`reasonCode` of {@link BookingsApi.cancel}). */
export type CancellationReason = Schemas["CancellationReason"];
/** Result of {@link BookingsApi.cancel}. */
export type CancellationResult = Schemas["CancellationResult"];
/** Refund of a captured payment. */
export type Refund = Schemas["Refund"];
/** Result of {@link BookingsApi.lookup}: guest token + booking card. */
export type BookingLookupResult = Schemas["BookingLookupResult"];

/* ------------------------------------------------------------------------------------------------------------ */
/* Parameters                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Optimistic-locking value for `If-Match`: the resource `version` (number, sent as `"<n>"`) or the raw `ETag`
 * header value (string, e.g. `"3"`).
 */
export type IfMatchValue = number | string;

/** Parameters of {@link CheckoutApi.create}. */
export type CreateCheckoutParams = Schemas["CheckoutCreateRequest"];

/** Parameters identifying a checkout. */
export interface CheckoutRefParams {
  /** Checkout id (`chk_…`). */
  checkoutId: string;
}

/** Common parameters of the checkout step methods. */
export interface CheckoutStepParams extends CheckoutRefParams {
  /** Optional checkout version / ETag; a stale value throws `VelexisError` `PRECONDITION_FAILED` (412). */
  ifMatch?: IfMatchValue;
}

/** Parameters of {@link CheckoutApi.setTravelers}. */
export interface SetCheckoutTravelersParams extends CheckoutStepParams {
  /** Travellers keyed by `travelerId` (Amadeus id `"1"`, `"2"`, …, as in `checkout.travelers[].travelerId`); each listed traveller is replaced, others are kept. */
  travelers: TravelerInput[];
}

/** Parameters of {@link CheckoutApi.setContacts}. */
export interface SetCheckoutContactsParams extends CheckoutStepParams {
  /** 1–3 contacts (replace all); exactly one primary contact with an e-mail. */
  contacts: ContactInput[];
}

/** Parameters of {@link CheckoutApi.setAncillaries}. */
export interface SetCheckoutAncillariesParams extends CheckoutStepParams {
  /** Selections (replace all; `[]` removes every ancillary): `optionId` from `flights.getAncillaries`, or explicit type/quantity/weight/serviceName/seatNumber. */
  selections: Schemas["AncillarySelection"][];
  /** Checkout total the customer saw; a different re-priced total throws `PriceChangedError` and leaves the checkout unchanged. */
  expectedTotal?: Money;
}

/** Parameters of {@link CheckoutApi.setRemarks}. */
export interface SetCheckoutRemarksParams extends CheckoutStepParams {
  /** Up to 5 special requests (replace all; `[]` removes them). */
  remarks: RemarkInput[];
}

/** Parameters of {@link CheckoutApi.createPayment}. */
export type CreateCheckoutPaymentParams = CheckoutRefParams & Schemas["PaymentCreateRequest"];

/** Parameters of {@link CheckoutApi.getPayment}. */
export interface GetPaymentParams {
  /** Payment id (`pay_…`). */
  paymentId: string;
}

/** Parameters of {@link CheckoutApi.updatePayment}: the payment + the card hint reported by the provider's card form. */
export type UpdatePaymentParams = GetPaymentParams & Schemas["PaymentUpdateRequest"];

/** Parameters of {@link CheckoutApi.complete}. */
export type CompleteCheckoutParams = CheckoutRefParams & Schemas["CheckoutCompleteRequest"];

/** `details` of `409 PRICE_CHANGED` thrown by checkout methods (also on `PriceChangedError.oldPrice/newPrice`). */
export interface CheckoutPriceChangedDetails {
  /** Total the customer saw. */
  oldPrice: Money;
  /** New total. */
  newPrice: Money;
  /** New priced offer (the checkout already points to it after `complete` / `createPayment` / `updatePayment`). */
  pricedOfferId: string;
}

/**
 * `details` of `504 SUPPLIER_TIMEOUT` thrown by {@link CheckoutApi.complete}: the order may exist — store the guest
 * token, poll the booking, never re-book with a new idempotency key. Same-key retries replay these details.
 */
export interface CheckoutTimeoutDetails {
  /** Pending booking to poll with {@link BookingsApi.getTicketingStatus} until `bookingStatus` leaves `pending`. */
  bookingId: string;
  /** Guests only: booking token — store it in `vx_bt_<bookingId>` exactly like `CheckoutCompletion.bookingToken`. */
  bookingToken?: string;
  /** Guests only: token expiry. */
  bookingTokenExpiresAt?: string;
  /** True when this answer is a replay of an earlier same-key attempt. */
  replayed?: boolean;
}

/** Tab of "My trips" — the `timeframe` filter, matching `BookingSummary.timeframe` (not a {@link BookingStatus}). */
export type BookingListTimeframe = "upcoming" | "past" | "cancelled" | "all";
/** @deprecated Renamed to {@link BookingListTimeframe} (the filter is `timeframe`, not a booking status). */
export type BookingListStatus = BookingListTimeframe;
/** Order of {@link BookingsApi.list}. */
export type BookingListSort = "departure" | "-departure" | "created" | "-created";

/** Parameters of {@link BookingsApi.list}. */
export interface ListBookingsParams extends ListParams {
  /** Tab (default `upcoming`); filters on `BookingSummary.timeframe`. For booking statuses use the console list. */
  timeframe?: BookingListTimeframe;
  /** First departure on or after this local date (`YYYY-MM-DD`). */
  departureFrom?: string;
  /** First departure on or before this local date. */
  departureTo?: string;
  /** Booked at or after this instant (inclusive, ISO-8601 date-time) — same semantics as the console lists. */
  createdFrom?: string;
  /** Booked before this instant (exclusive, ISO-8601 date-time) — same semantics as the console lists. */
  createdTo?: string;
  /** Sort (default per tab). Changing filters or sort requires dropping `cursor`. */
  sort?: BookingListSort;
}

/** Parameters identifying a booking. */
export interface BookingRefParams {
  /** Booking id (`bkg_…`). */
  bookingId: string;
}

/** Parameters of {@link BookingsApi.get}. */
export interface GetBookingParams extends BookingRefParams {
  /** Synchronise with Amadeus Flight Order Management GET first (throttled to once per 60 s per booking). */
  refresh?: boolean;
  /** With `refresh`: Amadeus `include` (`bags` = raw extra bag options in `amadeus.included.bags`; to buy them use {@link BookingsApi.getAncillaries}). */
  include?: Array<"bags">;
  /** With `refresh`: Amadeus `fareRules` eligibility (`rebooks`, `refunds`), returned in `fareRules`. */
  fareRules?: Array<"rebooks" | "refunds">;
}

/** Parameters of {@link BookingsApi.lookup}. */
export type LookupBookingParams = Schemas["BookingLookupRequest"];

/** Parameters of {@link BookingsApi.update}. */
export type UpdateBookingParams = BookingRefParams & {
  /** Booking `version` (or ETag) the customer saw — required. */
  ifMatch: IfMatchValue;
} & Schemas["BookingUpdateRequest"];

/** Parameters of {@link BookingsApi.cancel}: `reasonCode` ({@link CancellationReason}), optional `comment`, `expectedRefund`. */
export type CancelBookingParams = BookingRefParams & {
  /** Booking `version` (or ETag) — required. */
  ifMatch: IfMatchValue;
} & Schemas["CancellationRequest"];

/** Parameters of {@link BookingsApi.createPayment}: selections, confirmed `expectedTotal`, payment method. */
export type CreateBookingPaymentParams = BookingRefParams & Schemas["BookingPaymentCreateRequest"];

/** Parameters of {@link BookingsApi.addAncillaries}. */
export type AddBookingAncillariesParams = BookingRefParams & {
  /** Booking `version` (or ETag) — required. */
  ifMatch: IfMatchValue;
} & Schemas["BookingAncillariesRequest"];

/** Parameters of {@link BookingsApi.getFareRules}. */
export interface GetBookingFareRulesParams extends BookingRefParams {
  /** Amadeus `fareRules` values (default both). */
  types?: Array<"rebooks" | "refunds">;
  /** Bypass the 1-hour cache. */
  refresh?: boolean;
}

/** Parameters of {@link BookingsApi.getTicketingStatus}. */
export interface GetTicketingStatusParams extends BookingRefParams {
  /** Read tickets from Amadeus when the status is not final (throttled to once per 60 s). */
  refresh?: boolean;
}

/** Parameters of {@link BookingsApi.listDocuments}. */
export interface ListBookingDocumentsParams extends ListParams, BookingRefParams {
  /** Only these kinds. */
  kind?: BookingDocumentKind[];
}

/** Parameters of {@link BookingsApi.getDocumentDownloadUrl}. */
export interface GetDocumentDownloadUrlParams extends BookingRefParams {
  /** Document id (`doc_…`). */
  documentId: string;
}

/** Parameters of {@link BookingsApi.listEvents}. */
export interface ListBookingEventsParams extends ListParams, BookingRefParams {}

/** A checkout completion as returned to callers that want warnings typed explicitly. */
export type CheckoutCompletionWithWarnings = CheckoutCompletion & WithWarnings;

/* ------------------------------------------------------------------------------------------------------------ */
/* checkout namespace                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * `velexis.checkout` — turn a priced offer into a booking.
 *
 * Typical order: `create` → `setTravelers` → `setContacts` → (`setAncillaries`) → (`setRemarks`) → `createPayment`
 * → `updatePayment` when the provider's card form reports the brand / BIN (card fee) → provider SDK confirms the card
 * (3-D Secure) → `getPayment` → `complete`. Every step returns the whole {@link Checkout}; render
 * `checkout.progress.missing` and `checkout.requirements` to drive the forms.
 */
export interface CheckoutApi {
  /**
   * Open a checkout for a priced offer (`prc_…` from `flights.price`). Creates one empty traveller slot per Amadeus
   * traveller, derives `requirements` from the priced offer's `bookingRequirements` and, for signed-in customers,
   * prefills the primary contact from the profile.
   *
   * - HTTP: `POST /v1/checkouts` → `201` + `Location`, `ETag`.
   * - Amadeus: none (uses the stored priced offer).
   * - Keys: publishable or secret key; customer token (customer checkout) or none (guest, when the storefront allows
   *   guest checkout); staff token for assisted bookings.
   * - Where: server action (secret key + customer cookie) or client component (publishable key).
   * - Next.js caching: `no-store`. Idempotent with `options.idempotencyKey` (auto-generated otherwise).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` (401, guest checkout disabled — sign in), `INVALID_API_KEY`, `TOKEN_EXPIRED`
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` / `EMAIL_NOT_VERIFIED` (403)
   * @throws NotFoundError `NOT_FOUND` (404, unknown priced offer or owned by another customer)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws ExpiredError `OFFER_EXPIRED` (410) — price again with `flights.price`
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * // app/flights/review/actions.ts
   * "use server";
   * import { redirect } from "next/navigation";
   * import { createServerClient } from "@velexis/ota-sdk/next"; // secret key + customer session cookies (vx_at / vx_rt)
   * export async function startCheckout(pricedOfferId: string) {
   *   const checkout = await (await createServerClient()).checkout.create({ pricedOfferId, locale: "en-GB" });
   *   redirect(`/checkout/${checkout.id}/travellers`);
   * }
   * ```
   */
  create(params: CreateCheckoutParams, options?: RequestOptions): Promise<Checkout>;

  /**
   * Get the whole checkout (status, totals, price change, requirements, progress, travellers with masked document
   * numbers, contacts, ancillaries, special requests, active payment without `clientSecret`, itineraries, ticketing
   * policy, `bookingId` once completed). Expired and completed checkouts stay readable.
   *
   * - HTTP: `GET /v1/checkouts/{checkoutId}` (`ETag` = `"<version>"`).
   * - Amadeus: none.
   * - Keys: publishable or secret key; the owning customer's token for customer checkouts (guest checkouts are
   *   capability URLs: anyone with the id and the OTA key).
   * - Where: server components (each checkout step page) or client components. Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/checkout/[checkoutId]/travellers/page.tsx (server component)
   * const checkout = await (await createServerClient()).checkout.get({ checkoutId: params.checkoutId });
   * if (checkout.status === "completed") redirect(`/trips/${checkout.bookingId}`);
   * return <TravellerForms requirements={checkout.requirements.travelers} travelers={checkout.travelers} />;
   * ```
   */
  get(params: CheckoutRefParams, options?: RequestOptions): Promise<Checkout>;

  /**
   * Store travellers (Amadeus `Traveler`: name, dateOfBirth, gender, contact with phones
   * deviceType/countryCallingCode/number, documents, loyaltyPrograms, discountEligibility, emergencyContact).
   * `savedTravelerId` copies a saved traveller of the signed-in customer; `saveToAccount` saves the data after booking.
   * Validated against the checkout requirements (age vs traveller type, documents, name characters, discounts);
   * all-or-nothing per request.
   *
   * - HTTP: `PUT /v1/checkouts/{checkoutId}/travelers` (optional `If-Match`).
   * - Amadeus: none (fare-relevant data is sent to Flight Offers Price at `complete`).
   * - Keys: publishable or secret key (+ customer token for customer checkouts / saved travellers).
   * - Where: prefer a server action (passport data never touches third-party scripts); client components work too.
   * - Next.js caching: `no-store`. `PUT` is idempotent.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `TRAVELER_DATA_INVALID` (422) with
   *   `fieldErrors[]` (`path` like `/travelers/0/documents/0/expiryDate`, `code` from {@link TravelerFieldErrorCode})
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `CHECKOUT_ALREADY_COMPLETED` (409)
   * @throws ExpiredError `CHECKOUT_EXPIRED` (410)
   * @throws VelexisError `PRECONDITION_FAILED` (412, stale `ifMatch`)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * import { isVelexisError } from "@velexis/ota-sdk";
   * export async function saveTravellers(checkoutId: string, travelers: TravelerInput[]) {
   *   try {
   *     return { checkout: await (await createServerClient()).checkout.setTravelers({ checkoutId, travelers }) };
   *   } catch (e) {
   *     if (isVelexisError(e, "TRAVELER_DATA_INVALID")) return { fieldErrors: e.fieldErrors };
   *     throw e;
   *   }
   * }
   * ```
   */
  setTravelers(params: SetCheckoutTravelersParams, options?: RequestOptions): Promise<Checkout>;

  /**
   * Replace the booking contacts (Amadeus `Contact`: purpose STANDARD / INVOICE / STANDARD_WITHOUT_TRANSMISSION,
   * addresseeName, companyName, emailAddress, phones, address, language) and mark the primary contact (receives
   * confirmations, documents and — for guests — the booking token). Validated against `requirements.contact`.
   *
   * - HTTP: `PUT /v1/checkouts/{checkoutId}/contacts` (optional `If-Match`).
   * - Amadeus: none (sent in Flight Create Orders `data.contacts` at `complete`).
   * - Keys: publishable or secret key (+ customer token for customer checkouts).
   * - Where: server action or client component. Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `CONTACT_DATA_INVALID` (422) with `fieldErrors`
   *   (`PRIMARY_CONTACT_REQUIRED`, `MOBILE_PHONE_REQUIRED`, `COUNTRY_CALLING_CODE_REQUIRED`, `INVOICE_ADDRESS_REQUIRED`, …)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `CHECKOUT_ALREADY_COMPLETED` (409)
   * @throws ExpiredError `CHECKOUT_EXPIRED` (410)
   * @throws VelexisError `PRECONDITION_FAILED` (412)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * await velexis.checkout.setContacts({
   *   checkoutId,
   *   contacts: [{ isPrimary: true, purpose: "STANDARD", addresseeName: { firstName: "ANNA", lastName: "BERG" },
   *     emailAddress: "anna.berg@example.com", phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }] }],
   * });
   * ```
   */
  setContacts(params: SetCheckoutContactsParams, options?: RequestOptions): Promise<Checkout>;

  /**
   * Select ancillaries (extra checked/cabin bags, PRIORITY_BOARDING / AIRPORT_CHECKIN / FAST_TRACK, chargeable seats
   * where supported) per traveller and segment and re-price the checkout. Pass `expectedTotal` to refuse silent
   * price moves. `selections: []` removes all ancillaries (no Amadeus call).
   *
   * - HTTP: `PUT /v1/checkouts/{checkoutId}/ancillaries` (optional `If-Match`).
   * - Amadeus: `POST /v1/shopping/flight-offers/pricing` (Flight Offers Price, quoteAirOffers) with the selections in
   *   `fareDetailsBySegment[].additionalServices` and `include=bags,other-services`.
   * - Keys: publishable or secret key (+ customer token); storefront feature `ancillaries` must be enabled.
   * - Where: client component (extras picker) or server action. Next.js caching: `no-store`.
   * - An un-confirmed payment is updated to the new amount; an authorised one is voided (create a new payment).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `ANCILLARY_NOT_AVAILABLE` (422, `details.selectionIndex`, `details.reason`)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws PriceChangedError `PRICE_CHANGED` (409, {@link CheckoutPriceChangedDetails}; checkout unchanged — retry with `expectedTotal = newPrice`)
   * @throws SoldOutError `SOLD_OUT` (409)
   * @throws ConflictError `CHECKOUT_ALREADY_COMPLETED` (409)
   * @throws ExpiredError `CHECKOUT_EXPIRED` / `OFFER_EXPIRED` (410)
   * @throws VelexisError `PRECONDITION_FAILED` (412)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504, nothing changed — retry)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * "use client";
   * try {
   *   const updated = await velexis.checkout.setAncillaries({
   *     checkoutId, selections: [{ optionId: bag.id, travelerId: "1", quantity: 1 }],
   *     expectedTotal: { amount: shownTotal, currency: "EUR" },
   *   });
   *   setCheckout(updated);
   * } catch (e) {
   *   if (e instanceof PriceChangedError) setPriceNotice(e.newPrice);
   *   else throw e;
   * }
   * ```
   */
  setAncillaries(params: SetCheckoutAncillariesParams, options?: RequestOptions): Promise<Checkout>;

  /**
   * Replace the customer's special requests (max 5 × 110 characters, Amadeus remark character set). They become
   * Amadeus general remarks (`remarks.general[]`, subType GENERAL_MISCELLANEOUS) at `complete` and are handled by the
   * OTA's staff (not transmitted to the airline).
   *
   * - HTTP: `PUT /v1/checkouts/{checkoutId}/remarks` (optional `If-Match`).
   * - Amadeus: none.
   * - Keys: publishable or secret key (+ customer token).
   * - Where: server action or client component. Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `CHECKOUT_ALREADY_COMPLETED` (409)
   * @throws ExpiredError `CHECKOUT_EXPIRED` (410)
   * @throws VelexisError `PRECONDITION_FAILED` (412)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * await velexis.checkout.setRemarks({ checkoutId, remarks: [{ text: "Child meal requested for Leo if possible", travelerIds: ["2"] }] });
   * ```
   */
  setRemarks(params: SetCheckoutRemarksParams, options?: RequestOptions): Promise<Checkout>;

  /**
   * Create the payment session for the checkout total at the OTA's payment provider (Stripe, Adyen, Checkout.com,
   * PayPal). Returns `clientSecret` + `providerPublicKey` for the provider's front-end SDK (which collects the card
   * and runs 3-D Secure) or a `redirectUrl`. `card` (brand + BIN, for the credit-card fee) is optional and usually
   * unknown here — the card form reports it only after the customer typed the card, so send it with
   * {@link CheckoutApi.updatePayment} before confirming. Requires complete travellers and contacts and `termsAccepted: true`.
   *
   * - HTTP: `POST /v1/checkouts/{checkoutId}/payments` → `201` + `Location: /v1/payments/{id}`.
   * - Amadeus: `POST /v1/shopping/flight-offers/pricing?include=credit-card-fees` (quoteAirOffers) only when a card
   *   hint is given and the fee for that brand is not known yet.
   * - Keys: publishable or secret key (+ customer token). Card data never reaches Velexis.
   * - Where: client component (it feeds the provider SDK directly) or server action. Next.js caching: `no-store`.
   * - Idempotent with `options.idempotencyKey` (the same key is used at the provider).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `CHECKOUT_INCOMPLETE` (422, `fieldErrors`), `UNPROCESSABLE` (422, card brand not accepted)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403, method not enabled)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws PriceChangedError `PRICE_CHANGED` (409, fare moved while fetching the card fee; checkout updated)
   * @throws ConflictError `CHECKOUT_ALREADY_COMPLETED` / `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws ExpiredError `CHECKOUT_EXPIRED` (410)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `PAYMENT_PROVIDER_NOT_CONFIGURED` / `SUPPLIER_NOT_CONFIGURED` (424), `PAYMENT_PROVIDER_ERROR` / `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * "use client";
   * // 1. No card hint yet: the brand is only known once the customer types the card.
   * const payment = await velexis.checkout.createPayment({
   *   checkoutId, method: "card", termsAccepted: true,
   *   returnUrl: `${location.origin}/checkout/${checkoutId}/return`,
   * });
   * // 2. Mount the provider form with payment.clientSecret / payment.providerPublicKey; when it reports the brand,
   * //    call velexis.checkout.updatePayment (see there) and show the new payment.amount.
   * // 3. Confirm (3-D Secure runs here):
   * const stripe = await loadStripe(payment.providerPublicKey!);
   * const { error } = await stripe!.confirmPayment({ elements, clientSecret: payment.clientSecret!, redirect: "if_required" });
   * ```
   */
  createPayment(params: CreateCheckoutPaymentParams, options?: RequestOptions): Promise<Payment>;

  /**
   * Set or replace the card hint (brand + BIN) of a payment that is still `requires_payment_method` and re-quote the
   * credit-card fee, so the fee follows the card the customer actually entered. Updates `amount` / `cardFee` of the
   * **same** provider payment (same `clientSecret`, no orphaned intents) and the checkout's `totals.cardFee` / `total`.
   * Call it from the provider form's brand / BIN event (Adyen `onBinLookup`, Checkout.com Frames `cardBinChanged`,
   * Stripe confirmation-token `payment_method_preview.card`), then refresh the amount shown and confirm. Also works for
   * payments of extras created with {@link BookingsApi.createPayment} (OTA card surcharge only).
   *
   * - HTTP: `PATCH /v1/payments/{paymentId}`.
   * - Amadeus: `POST /v1/shopping/flight-offers/pricing?include=credit-card-fees` (quoteAirOffers, `data.payments`
   *   brand / binNumber) when the fee for that brand is not known yet; none for `ancillaries` payments.
   * - Keys: publishable or secret key (+ customer token, or the guest `bookingToken` for payments of a guest booking).
   * - Where: client component (it reacts to the card form) or server action. Next.js caching: `no-store`.
   * - Idempotent: the same hint again changes nothing.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `UNPROCESSABLE` (422, card brand not accepted)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `PAYMENT_NOT_UPDATABLE` (409, `details.status` — confirmation started or the payment is final: create a new payment), `CHECKOUT_ALREADY_COMPLETED` (409)
   * @throws PriceChangedError `PRICE_CHANGED` (409, {@link CheckoutPriceChangedDetails}; checkout moved to the new price and this payment was cancelled — create a new one)
   * @throws ExpiredError `CHECKOUT_EXPIRED` (410)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `PAYMENT_PROVIDER_ERROR` / `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504) — nothing changed, retry
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * "use client";
   * // Called by the PSP card form when it recognises the card (e.g. Adyen onBinLookup).
   * async function onCardBrand(brand: PaymentCardHint["brand"], bin?: string) {
   *   const p = await velexis.checkout.updatePayment({ paymentId: payment.id, card: bin ? { brand, bin } : { brand } });
   *   setAmountShown(p.amount); // includes p.cardFee — show it before the customer confirms
   * }
   * ```
   */
  updatePayment(params: UpdatePaymentParams, options?: RequestOptions): Promise<Payment>;

  /**
   * Get a payment (status, amounts, card summary, 3-D Secure state, failure). Non-final statuses are refreshed from
   * the provider when older than 5 s, so polling every 2 s after the provider SDK confirmed is fine.
   *
   * - HTTP: `GET /v1/payments/{paymentId}`.
   * - Amadeus: none.
   * - Keys: publishable or secret key (+ customer token, or the guest `bookingToken` for payments of a guest booking).
   * - Where: client component (after `confirmPayment`; guests through the browser client's proxy) or the server
   *   component behind `returnUrl`. Next.js caching: `no-store`.
   * - Final statuses: `authorized`, `captured` (continue), `failed`, `cancelled` (create a new payment).
   *
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * let p = await velexis.checkout.getPayment({ paymentId });
   * while (p.status === "processing" || p.status === "requires_action") {
   *   await new Promise((r) => setTimeout(r, 2000));
   *   p = await velexis.checkout.getPayment({ paymentId });
   * }
   * if (p.status === "authorized" || p.status === "captured") await completeCheckout(checkoutId, paymentId);
   * ```
   */
  getPayment(params: GetPaymentParams, options?: RequestOptions): Promise<Payment>;

  /**
   * Complete the checkout: verify the payment, re-price when needed, create the Amadeus flight order (travellers,
   * contacts, remarks, ticketing agreement, automated process, queuing office and form of payment from storefront
   * settings), capture the payment and issue tickets per the OTA's ticketing policy. Returns the booking and — for
   * guests — a one-time `bookingToken`. Can take up to 60 s: pass `timeoutMs: 90_000` (the SDK default for this method).
   *
   * - HTTP: `POST /v1/checkouts/{checkoutId}/complete` → `201` + `Location: /v1/bookings/{id}`.
   * - Amadeus: Flight Offers Price `POST /v1/shopping/flight-offers/pricing` (if the price is stale), Flight Create
   *   Orders `POST /v1/booking/flight-orders?issue=…` (createFligtOrders), Flight Order Issue
   *   `POST /v1/booking/flight-orders/{id}/issuance` (issueFlightOrder) for `issue_after_payment`.
   * - Keys: publishable or secret key (+ customer token for customer checkouts).
   * - Where: **server action or route handler** recommended (store the guest `bookingToken` in an httpOnly cookie);
   *   client components work through the browser client's proxy, which moves the token into the cookie.
   * - Next.js caching: `no-store`. Always pass a stable `options.idempotencyKey` per attempt so a network retry
   *   replays the stored result instead of booking twice.
   * - Retries: the server calls Flight Create Orders at most once per checkout. A same-key request replays the stored
   *   outcome — the `201`, the final error, or after a `504 SUPPLIER_TIMEOUT` the same 504 with the same
   *   {@link CheckoutTimeoutDetails} (`replayed: true`) until reconciliation decides, then the final result; a same-key
   *   request that arrives while the original still runs waits for it. The SDK's automatic retries on 503/504/network
   *   errors are therefore safe for this method, and a replayed 504 answers immediately, so they do not multiply the
   *   wait. Never retry with a **new** key after a 504: poll {@link BookingsApi.getTicketingStatus} instead.
   * - On booking failure the authorisation is voided / payment refunded automatically.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `CHECKOUT_INCOMPLETE` / `TRAVELER_DATA_INVALID` / `CONTACT_DATA_INVALID` / `UNPROCESSABLE` (422)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PaymentError `PAYMENT_REQUIRED` (402, payment not authorised yet), `PAYMENT_DECLINED` (402)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` / `EMAIL_NOT_VERIFIED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws PriceChangedError `PRICE_CHANGED` (409, {@link CheckoutPriceChangedDetails}; authorisation voided, checkout moved to the new price — create a new payment)
   * @throws SoldOutError `SOLD_OUT` (409, nothing booked, payment voided)
   * @throws ConflictError `CHECKOUT_ALREADY_COMPLETED` (409, `details.bookingId`), `PAYMENT_AMOUNT_MISMATCH`, `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws ExpiredError `CHECKOUT_EXPIRED` / `OFFER_EXPIRED` (410)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` / `PAYMENT_PROVIDER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` / `TICKETING_FAILED` / `PAYMENT_PROVIDER_ERROR` (502),
   *   `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504, {@link CheckoutTimeoutDetails} — the order may exist: store the guest token, poll the booking, never re-book with a new key)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```ts
   * // app/checkout/[checkoutId]/actions.ts
   * "use server";
   * import { redirect } from "next/navigation";
   * import { isVelexisError, type CheckoutTimeoutDetails, type Money } from "@velexis/ota-sdk";
   * import { createServerClient, setBookingTokenCookie } from "@velexis/ota-sdk/next";
   * export async function completeCheckout(checkoutId: string, paymentId: string, total: Money) {
   *   const vx = await createServerClient();
   *   let target: string;
   *   try {
   *     const done = await vx.checkout.complete(
   *       { checkoutId, paymentId, expectedTotal: total },
   *       { idempotencyKey: `complete-${checkoutId}-${paymentId}`, timeoutMs: 90_000 },
   *     );
   *     if (done.bookingToken) await setBookingTokenCookie(done.booking.id, done.bookingToken, done.bookingTokenExpiresAt);
   *     target = `/trips/${done.booking.id}?new=1`;
   *   } catch (e) {
   *     if (isVelexisError(e, "SUPPLIER_TIMEOUT")) {
   *       // The order may exist: keep the guest token (vx_bt_<bookingId>) and poll the pending booking — never re-book.
   *       const d = e.details as unknown as CheckoutTimeoutDetails;
   *       if (d.bookingToken) await setBookingTokenCookie(d.bookingId, d.bookingToken, d.bookingTokenExpiresAt);
   *       target = `/trips/${d.bookingId}?pending=1`;
   *     } else if (isVelexisError(e, "PRICE_CHANGED")) {
   *       return { priceChanged: e.details };
   *     } else throw e;
   *   }
   *   redirect(target);
   * }
   * ```
   */
  complete(params: CompleteCheckoutParams, options?: RequestOptions): Promise<CheckoutCompletion>;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* bookings namespace                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * `velexis.bookings` — customer and guest view of bookings ("My trips", detail, manage booking).
 *
 * Customers use their access token; guests use the booking token from `checkout.complete` or `bookings.lookup`
 * (server side: `createServerClient({ bookingId })` from `@velexis/ota-sdk/next`, or per call `options.bookingToken`
 * read from the `vx_bt_<bookingId>` cookie; client side: the browser client's proxy attaches it). Only bookings of
 * the key's environment are visible. Staff booking management is `console.*`.
 */
export interface BookingsApi {
  /**
   * List the signed-in customer's bookings for the "My trips" tabs (`timeframe`: `upcoming` default, `past`,
   * `cancelled`, `all`) with date filters, sort and cursor pagination. The page has `next()` and is async-iterable.
   * Only bookings of the key's environment are listed (test and live share customers).
   *
   * - HTTP: `GET /v1/bookings?timeframe=upcoming&sort=departure&limit=20`.
   * - Amadeus: none (tenant tables; a background job syncs upcoming bookings every 6 h).
   * - Keys: publishable or secret key + **customer token** (required).
   * - Where: server component (secret key + session cookie) or client component.
   * - Next.js caching: `no-store` (personal data).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/trips/page.tsx (server component)
   * import { createServerClient } from "@velexis/ota-sdk/next";
   * export default async function Trips({ searchParams }: { searchParams: Promise<{ tab?: "upcoming" | "past" | "cancelled" }> }) {
   *   const { tab = "upcoming" } = await searchParams;
   *   const page = await (await createServerClient()).bookings.list({ timeframe: tab, limit: 20 });
   *   return <TripList trips={page.data} nextCursor={page.page.nextCursor} />;
   * }
   * ```
   */
  list(params?: ListBookingsParams, options?: RequestOptions): Promise<Page<BookingSummary>>;

  /**
   * Get a booking: status, record locators (Amadeus + airline, for online check-in), itineraries with segment status
   * and schedule changes, travellers (documents with `numberMasked` only), contacts, ancillaries, tickets, payments,
   * refunds, remarks, documents, totals, ticketing, fare conditions, `allowedActions`, cancellation, `lastSyncedAt` and
   * the wrapped Amadeus order (selling amounts; document, resident-card and certificate numbers masked).
   * `refresh: true` synchronises with Amadeus first.
   *
   * - HTTP: `GET /v1/bookings/{bookingId}?refresh=true&include=bags&fareRules=rebooks,refunds` (`ETag` = `"<version>"`).
   * - Amadeus: with `refresh` only — Flight Order Management `GET /v1/booking/flight-orders/{id}` (getFlightOrder) with
   *   `include` / `fareRules` passed through; throttled to once per 60 s per booking.
   * - Keys: publishable or secret key + customer token **or** guest `bookingToken`.
   * - Where: server component (booking page) or client component (refresh button).
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError (only with `refresh`) `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504) — retry without `refresh`
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * // app/trips/[bookingId]/page.tsx — customer session or guest booking-token cookie (vx_bt_<bookingId>)
   * import { createServerClient } from "@velexis/ota-sdk/next";
   * const { bookingId } = await params;
   * const vx = await createServerClient({ bookingId }); // attaches X-Booking-Token from the httpOnly cookie, if any
   * const booking = await vx.bookings.get({ bookingId });
   * return <BookingDetail booking={booking} canCancel={booking.allowedActions.canCancel} />;
   * ```
   */
  get(params: GetBookingParams, options?: RequestOptions): Promise<Booking>;

  /**
   * "Manage my booking" for guests: find a booking by booking reference (or airline/Amadeus record locator) and the
   * last name of any traveller, and receive a guest booking token (24 h). Wrong reference or name → the same 404.
   *
   * - HTTP: `POST /v1/bookings/lookup` → `200`.
   * - Amadeus: none.
   * - Keys: publishable or secret key only (no user token).
   * - Where: **server action** — store `bookingToken` in an httpOnly cookie, never in localStorage.
   * - Next.js caching: `no-store`. Rate-limited (5 failed attempts / 15 min per IP and reference).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400)
   * @throws AuthenticationError `INVALID_API_KEY` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404, no booking with this reference and last name)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429, `retryAfterSeconds`)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * import { createServerClient, setBookingTokenCookie } from "@velexis/ota-sdk/next";
   * export async function findBooking(_: unknown, form: FormData) {
   *   const vx = await createServerClient({ as: "anonymous" });
   *   const r = await vx.bookings.lookup({ bookingReference: String(form.get("ref")), lastName: String(form.get("lastName")) });
   *   await setBookingTokenCookie(r.bookingId, r.bookingToken, r.expiresAt); // httpOnly vx_bt_<bookingId>
   *   redirect(`/trips/${r.bookingId}`);
   * }
   * ```
   */
  lookup(params: LookupBookingParams, options?: RequestOptions): Promise<BookingLookupResult>;

  /**
   * Customer-allowed changes applied at the airline: replace contacts, traveller identity/APIS documents, traveller
   * contact / emergency contact, loyalty numbers, and add special requests. Names, dates of birth and gender cannot
   * change. Requires `ifMatch` (the booking `version` you displayed). Travellers are keyed by `travelerId` (Amadeus
   * id, `booking.travelers[i].travelerId`). `documents` replaces the list: send `booking.travelers[i].documents` back
   * with the edited entry — entries without `number` keep their stored number (matched by `documentType` +
   * `issuanceCountry`), and masked values are rejected, so masked numbers never reach Amadeus. Extra bags: see
   * {@link BookingsApi.getAncillaries}.
   *
   * - HTTP: `PATCH /v1/bookings/{bookingId}` with `If-Match`.
   * - Amadeus: Flight Order Management `PATCH /v1/booking/flight-orders/{id}` (patchFlightOrder) — complete travellers
   *   are sent with the changes merged; Amadeus 2552 SIMULTANEOUS UPDATE → `VERSION_CONFLICT`.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: server action (documents are sensitive). Next.js caching: `no-store`; `revalidatePath` the booking page after.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `TRAVELER_DATA_INVALID` / `CONTACT_DATA_INVALID` (422, `fieldErrors`)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `VERSION_CONFLICT` (409, reload with `get({ refresh: true })` and retry), `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED` (409)
   * @throws VelexisError `PRECONDITION_FAILED` (412, stale `ifMatch`)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```ts
   * "use server";
   * import { createServerClient } from "@velexis/ota-sdk/next";
   * // New passport for traveller "2": replace that traveller's documents with the new one.
   * export async function updatePassport(bookingId: string, version: number, doc: TravelerDocumentInput) {
   *   const vx = await createServerClient({ bookingId });
   *   const booking = await vx.bookings.update({ bookingId, ifMatch: version, travelers: [{ travelerId: "2", documents: [doc] }] });
   *   revalidatePath(`/trips/${bookingId}`);
   *   return booking;
   * }
   * // Fix only the expiry date of a stored document: send it back without `number` (the stored number is kept).
   * //   documents: booking.travelers[0].documents.map((d) => d.documentType === "PASSPORT" ? { ...d, expiryDate: "2031-05-15" } : d)
   * ```
   */
  update(params: UpdateBookingParams, options?: RequestOptions): Promise<Booking>;

  /**
   * Extra checked bags the customer can still buy for this booking, with selling prices (first step of "add a bag":
   * `getAncillaries` → {@link BookingsApi.createPayment} → provider SDK confirms → {@link BookingsApi.addAncillaries}).
   * Returns `available: false` + `notAvailableReason` when nothing can be bought (see
   * `booking.allowedActions.canAddAncillaries`). Seats and other services after booking are handled by staff.
   *
   * - HTTP: `GET /v1/bookings/{bookingId}/ancillaries`.
   * - Amadeus: Flight Order Management `GET /v1/booking/flight-orders/{id}?include=bags` (getFlightOrder); cached 30 min.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: server component (extras page) or client component. Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * // app/trips/[bookingId]/extras/page.tsx
   * const vx = await createServerClient({ bookingId });
   * const extras = await vx.bookings.getAncillaries({ bookingId });
   * if (!extras.available) return <p>Extra bags cannot be added online ({extras.notAvailableReason}).</p>;
   * return <BagPicker bookingId={bookingId} options={extras.options} currency={extras.currency} />;
   * ```
   */
  getAncillaries(params: BookingRefParams, options?: RequestOptions): Promise<BookingAncillaryOptions>;

  /**
   * Create the payment (`purpose: "ancillaries"`) for extras to add to the booking: selections from
   * {@link BookingsApi.getAncillaries} and the `expectedTotal` the customer saw. Returns `clientSecret` /
   * `providerPublicKey` / `redirectUrl` like {@link CheckoutApi.createPayment}; set the card hint with
   * {@link CheckoutApi.updatePayment}, confirm with the provider SDK, check with {@link CheckoutApi.getPayment}, then
   * call {@link BookingsApi.addAncillaries} with the same selections. Authorised only; captured when the airline
   * accepted the extras, voided otherwise.
   *
   * - HTTP: `POST /v1/bookings/{bookingId}/payments` → `201` + `Location: /v1/payments/{id}` (Idempotency-Key).
   * - Amadeus: Flight Order Management `GET …?include=bags` only when the cached options expired.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: client component (feeds the provider SDK; guests through the browser client's proxy) or server action.
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `ANCILLARY_NOT_AVAILABLE` / `UNPROCESSABLE` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws PriceChangedError `PRICE_CHANGED` (409, extras' price moved; no payment created)
   * @throws ConflictError `BOOKING_NOT_MODIFIABLE` / `BOOKING_ALREADY_CANCELLED` / `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `PAYMENT_PROVIDER_NOT_CONFIGURED` / `SUPPLIER_NOT_CONFIGURED` (424), `PAYMENT_PROVIDER_ERROR` / `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * "use client";
   * const selections = [{ optionId: bag.id, travelerId: "1" }];
   * const payment = await velexis.bookings.createPayment({
   *   bookingId, selections, expectedTotal: bag.price, method: "card", termsAccepted: true,
   *   returnUrl: `${location.origin}/trips/${bookingId}/extras/return`,
   * });
   * // provider form → velexis.checkout.updatePayment({ paymentId: payment.id, card }) → confirm → addBagsAction(...)
   * ```
   */
  createPayment(params: CreateBookingPaymentParams, options?: RequestOptions): Promise<Payment>;

  /**
   * Add paid extras to the booking: Flight Order Management PATCH with `additionalServices` (chargeableCheckedBags) on
   * the booked offer, capture of the `ancillaries` payment, EMD issuance (Flight Order Issue) when already ticketed.
   * Requires `ifMatch` and the authorised `paymentId` from {@link BookingsApi.createPayment} for the same selections.
   * On `PRICE_CHANGED` / `ANCILLARY_NOT_AVAILABLE` / airline refusal the authorisation is voided and nothing is added.
   *
   * - HTTP: `POST /v1/bookings/{bookingId}/ancillaries` with `If-Match` and `Idempotency-Key` → `200` booking + new `ETag`.
   * - Amadeus: Flight Order Management `GET …?include=bags` (re-quote when stale) and `PATCH /v1/booking/flight-orders/{id}`
   *   (patchFlightOrder); Flight Order Issue `POST /v1/booking/flight-orders/{id}/issuance` (issueFlightOrder) for EMDs.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: **server action**. Next.js caching: `no-store`; `revalidatePath` the booking page afterwards.
   * - Retries: a same-key retry never PATCHes twice — it replays the stored outcome (after `504 SUPPLIER_TIMEOUT`, the
   *   same 504 until reconciliation decides, then the final result), so automatic SDK retries are safe. Pass a stable
   *   `options.idempotencyKey` (e.g. `extras-${paymentId}`).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `ANCILLARY_NOT_AVAILABLE` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PaymentError `PAYMENT_REQUIRED` (402, not authorised yet), `PAYMENT_DECLINED` (402)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws PriceChangedError `PRICE_CHANGED` (409; authorisation voided — show the new price and pay again)
   * @throws ConflictError `PAYMENT_AMOUNT_MISMATCH`, `VERSION_CONFLICT`, `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED`, `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws VelexisError `PRECONDITION_FAILED` (412, stale `ifMatch`)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` / `PAYMENT_PROVIDER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` / `PAYMENT_PROVIDER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504 — outcome unknown; same-key retries replay, `get({ refresh: true })` shows the result)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```ts
   * "use server";
   * import { createServerClient } from "@velexis/ota-sdk/next";
   * export async function addBagsAction(bookingId: string, version: number, paymentId: string, selections: BookingAncillarySelection[], expectedTotal: Money) {
   *   const vx = await createServerClient({ bookingId });
   *   const booking = await vx.bookings.addAncillaries(
   *     { bookingId, ifMatch: version, paymentId, selections, expectedTotal },
   *     { idempotencyKey: `extras-${paymentId}` },
   *   );
   *   revalidatePath(`/trips/${bookingId}`);
   *   return booking.ancillaries.filter((a) => a.source === "post_booking");
   * }
   * ```
   */
  addAncillaries(params: AddBookingAncillariesParams, options?: RequestOptions): Promise<Booking>;

  /**
   * Preview a cancellation: mode (`release` not ticketed, `void` same-day tickets, `refund` per fare rules,
   * `request_only` handled by the OTA, `not_allowed`), estimated refund, airline penalties, OTA fee, per-traveller
   * lines and the REFUND/CANCELLATION rules behind it. Valid 10 minutes (`expiresAt`).
   *
   * - HTTP: `GET /v1/bookings/{bookingId}/cancellation-quote`.
   * - Amadeus: Flight Order Management `GET /v1/booking/flight-orders/{id}?fareRules=refunds` (getFlightOrder,
   *   `refundingPreview`); net amounts are never exposed in customer scope.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: server component (cancel page) or client component (dialog). Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `BOOKING_ALREADY_CANCELLED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * const quote = await (await createServerClient({ bookingId })).bookings.quoteCancellation({ bookingId });
   * return quote.cancellable
   *   ? <CancelDialog refund={quote.estimatedRefund} penalty={quote.penalty} fee={quote.otaFee} version={booking.version} />
   *   : <p>Cancellation not possible ({quote.notAllowedReason}).</p>;
   * ```
   */
  quoteCancellation(params: BookingRefParams, options?: RequestOptions): Promise<CancellationQuote>;

  /**
   * Cancel the booking (self-service). Pass the quote's `estimatedRefund` as `expectedRefund`, the booking `version`
   * as `ifMatch`, the customer's `reasonCode` ({@link CancellationReason}) and an optional free-text `comment` (same
   * naming as the console: `reasonCode` is always the code). Resolves with `cancellation.status = "cancelled"` (HTTP
   * 200) or `"pending"` (HTTP 202, the OTA completes it); the refund (or voided authorisation) is in
   * `cancellation.refund` / `refundStatus`. A same-key retry after `504 SUPPLIER_TIMEOUT` never repeats the Amadeus
   * DELETE: it replays the 504 until reconciliation decides, then the final result (automatic SDK retries are safe).
   *
   * - HTTP: `POST /v1/bookings/{bookingId}/cancellation` with `If-Match` and `Idempotency-Key`.
   * - Amadeus: Flight Order Management `GET …?fareRules=refunds` (re-check of the refund) and
   *   `DELETE /v1/booking/flight-orders/{id}` (cancelFlightOrder).
   * - Keys: publishable or secret key + customer token or guest `bookingToken`; storefront self-service cancellation enabled.
   * - Where: **server action**. Next.js caching: `no-store`; `revalidatePath("/trips")` afterwards.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `REFUND_AMOUNT_CHANGED` (409, `details.newRefund` — show it and confirm again), `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED`, `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws VelexisError `PRECONDITION_FAILED` (412)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504 — outcome unknown: `get({ refresh: true })` before retrying with the same idempotency key)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```ts
   * "use server";
   * import { createServerClient } from "@velexis/ota-sdk/next";
   * export async function cancelTrip(bookingId: string, version: number, expectedRefund: Money) {
   *   const vx = await createServerClient({ bookingId });
   *   const { cancellation } = await vx.bookings.cancel(
   *     { bookingId, ifMatch: version, reasonCode: "change_of_plans", expectedRefund },
   *     { idempotencyKey: `cancel-${bookingId}-${version}` },
   *   );
   *   revalidatePath("/trips");
   *   return cancellation;
   * }
   * ```
   */
  cancel(params: CancelBookingParams, options?: RequestOptions): Promise<CancellationResult>;

  /**
   * Rebooking (change) and refund eligibility of the booked fares: per category applicability, penalties,
   * circumstances, airline texts, rebook conditions and a refund estimate, plus a summary. Cached 1 h server-side.
   *
   * - HTTP: `GET /v1/bookings/{bookingId}/fare-rules?types=rebooks,refunds`.
   * - Amadeus: Flight Order Management `GET /v1/booking/flight-orders/{id}?fareRules=rebooks,refunds` (getFlightOrder)
   *   when not cached or `refresh: true`.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: server or client component. Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * const rules = await (await createServerClient({ bookingId })).bookings.getFareRules({ bookingId, types: ["rebooks", "refunds"] });
   * return <Conditions changeable={rules.summary.changeable} refundable={rules.summary.refundable} rules={rules.rules} />;
   * ```
   */
  getFareRules(params: GetBookingFareRulesParams, options?: RequestOptions): Promise<BookingFareRules>;

  /**
   * List the booking's documents (e-ticket receipts, EMD receipts, itinerary, invoices, credit notes), newest first.
   *
   * - HTTP: `GET /v1/bookings/{bookingId}/documents?kind=e_ticket_receipt,itinerary`.
   * - Amadeus: none.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: server or client component. Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * const vx = await createServerClient({ bookingId }); // customer session or guest cookie vx_bt_<bookingId>
   * const docs = await vx.bookings.listDocuments({ bookingId, kind: ["e_ticket_receipt", "itinerary", "invoice"] });
   * ```
   */
  listDocuments(params: ListBookingDocumentsParams, options?: RequestOptions): Promise<Page<BookingDocument>>;

  /**
   * Get a 5-minute signed download URL for one document (PDF, `Content-Disposition: attachment`). Do not cache or
   * store the URL; request a new one per click.
   *
   * - HTTP: `GET /v1/bookings/{bookingId}/documents/{documentId}/download-url`.
   * - Amadeus: none.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: route handler that redirects (keeps tokens server-side: `createServerClient({ bookingId })` reads the
   *   customer session or the guest cookie `vx_bt_<bookingId>`), or a client component through the browser client's
   *   proxy. A plain publishable-key client without a token gets `401`. Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `DOCUMENT_NOT_READY` (409, `details.retryAfterSeconds`)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * // app/trips/[bookingId]/documents/[documentId]/route.ts
   * import { createServerClient } from "@velexis/ota-sdk/next";
   * export async function GET(_: Request, ctx: { params: Promise<{ bookingId: string; documentId: string }> }) {
   *   const { bookingId, documentId } = await ctx.params;
   *   const vx = await createServerClient({ bookingId }); // customer session, or X-Booking-Token from vx_bt_<bookingId>
   *   const { url } = await vx.bookings.getDocumentDownloadUrl({ bookingId, documentId });
   *   return Response.redirect(url, 302);
   * }
   * ```
   */
  getDocumentDownloadUrl(params: GetDocumentDownloadUrlParams, options?: RequestOptions): Promise<DocumentDownloadUrl>;

  /**
   * List the customer-visible booking timeline (created, payment, ticketed, changes, schedule changes, cancellation,
   * refunds, documents), newest first.
   *
   * - HTTP: `GET /v1/bookings/{bookingId}/events?limit=20`.
   * - Amadeus: none.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: server or client component. Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * for await (const evt of await velexis.bookings.listEvents({ bookingId, limit: 50 })) console.log(evt.createdAt, evt.summary);
   * ```
   */
  listEvents(params: ListBookingEventsParams, options?: RequestOptions): Promise<Page<BookingEvent>>;

  /**
   * Ticketing progress: booking status (always present), ticketing status, policy, deadline, attempts, last/next
   * attempt, message, issued tickets and a polling hint (`pollAfterSeconds`). Poll it after `checkout.complete` while
   * `status` is `pending` / `in_progress`, and after a `SUPPLIER_TIMEOUT` from `checkout.complete` until `bookingStatus`
   * leaves `pending` (`confirmed` / `ticketed` → follow `status`; `failed` → `failureCode`, payment voided). While the
   * create-order outcome is unknown `refresh` is ignored (no Amadeus order id yet). Stop when `pollAfterSeconds` is null.
   *
   * - HTTP: `GET /v1/bookings/{bookingId}/ticketing?refresh=true`.
   * - Amadeus: with `refresh`, a non-final status and an Amadeus order id — Flight Order Management
   *   `GET /v1/booking/flight-orders/{id}` (getFlightOrder) to pick up tickets; throttled to once per 60 s.
   * - Keys: publishable or secret key + customer token or guest `bookingToken`.
   * - Where: client component through the browser client (`createBrowserClient()` from `@velexis/ota-sdk/next`, whose
   *   same-origin proxy attaches the customer session or the guest cookie `vx_bt_<bookingId>`; `useTicketingStatus`
   *   from `@velexis/ota-sdk/react` does the polling) or server component (`createServerClient({ bookingId })`). A plain
   *   publishable-key client without a token gets `401`. Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * "use client";
   * import { createBrowserClient } from "@velexis/ota-sdk/next";
   * const velexis = createBrowserClient(); // token-bound calls go through /api/velexis (httpOnly cookies, no token in props)
   * useEffect(() => {
   *   let stop = false;
   *   (async function poll() {
   *     const s = await velexis.bookings.getTicketingStatus({ bookingId, refresh: true });
   *     if (stop) return;
   *     setStatus(s); // s.bookingStatus === "failed" → show "booking did not go through" (s.failureCode)
   *     if (s.pollAfterSeconds) setTimeout(poll, s.pollAfterSeconds * 1000);
   *   })();
   *   return () => { stop = true; };
   * }, [bookingId]);
   * // or simply: const { data } = useTicketingStatus(bookingId); // @velexis/ota-sdk/react
   * ```
   */
  getTicketingStatus(params: GetTicketingStatusParams, options?: RequestOptions): Promise<BookingTicketingStatus>;
}
