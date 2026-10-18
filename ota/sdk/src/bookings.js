// Checkout, payment and bookings (mirrors docs/velexis-sdk/sdk/src/bookings.d.ts, ADR-0019, OADR-0016 point 1): the
// typedefs of bookings.d.ts with the same names, in the same order, and the factories of its namespaces. The namespace
// types are inferred from the factories in ./namespaces/, so each method is documented once, there. The schema
// aliases and `IfMatchValue` come first; then the checkout parameters (SDK-009), the parameters of `bookings`
// (`BookingListTimeframe` … `ListBookingEventsParams`, SDK-010), `CheckoutCompletionWithWarnings`, and the namespaces
// `checkout` (`CheckoutApi`, SDK-009) and `bookings` (`BookingsApi`, SDK-010), in the contract's order. The types of
// the MVP addition `checkout.completeWithAirlineCard` (ota/sdk/docs/extensions.md §3.1) close the file; the contract
// has no counterpart for them.
//
// Schema types come only from `@velexis/api-types` through ./types.js; nothing here declares a name that shared.js,
// identity.js or flights.js exports, because index.js re-exports all of them with `export *`.

export { createBookingsApi } from "./namespaces/bookings.js";
export { createCheckoutApi } from "./namespaces/checkout.js";

/* ------------------------------------------------------------------------------------------------------------ */
/* Schema aliases                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** Checkout session (`chk_…`): totals, requirements, progress, travellers, contacts, ancillaries, remarks, payment. @typedef {import("./types.js").Schemas["Checkout"]} Checkout */
/** `open` | `payment_pending` | `completed` | `expired` | `abandoned`. @typedef {Checkout["status"]} CheckoutStatus */
/** What the customer pays (`total = offer + ancillaries + cardFee`; supplier and service fees are inside `offer`). @typedef {import("./types.js").Schemas["CheckoutTotals"]} CheckoutTotals */
/** Contact and per-traveller requirements derived from Amadeus `bookingRequirements`. @typedef {import("./types.js").Schemas["CheckoutRequirements"]} CheckoutRequirements */
/** Requirements of one traveller (required fields, date-of-birth range, accepted document types). @typedef {import("./types.js").Schemas["CheckoutTravelerRequirement"]} CheckoutTravelerRequirement */
/** Completeness of the checkout steps (`missing` lists what is still needed). @typedef {import("./types.js").Schemas["CheckoutProgress"]} CheckoutProgress */
/** A selected ancillary with its re-priced selling price. @typedef {import("./types.js").Schemas["CheckoutAncillary"]} CheckoutAncillary */
/** Result of `CheckoutApi.complete` (and `completeWithAirlineCard`): the booking and, for guests, the one-time booking token. @typedef {import("./types.js").Schemas["CheckoutCompletion"]} CheckoutCompletion */

/**
 * Traveller of a checkout or booking, aligned with Amadeus `Traveler`. `id` is the Velexis row id (`ctr_…` / `btr_…`,
 * read-only); `travelerId` is the Amadeus id used by every request. Documents carry `numberMasked` only.
 * @typedef {import("./types.js").Schemas["Traveler"]} Traveler
 */

/** Identity document of a `Traveler` as returned (`numberMasked`, never a masked value in `number`). @typedef {import("./types.js").Schemas["TravelerDocument"]} TravelerDocument */

/**
 * Identity document as sent to `CheckoutApi.setTravelers` and `BookingsApi.update`. Omit `number` to keep the stored
 * number (matched by `documentType` + `issuanceCountry`), so a `TravelerDocument` can be sent back as is.
 * @typedef {import("./types.js").Schemas["TravelerDocumentInput"]} TravelerDocumentInput
 */

/** Traveller as sent to `CheckoutApi.setTravelers`: keyed by `travelerId` (Amadeus id) + `savedTravelerId` (`trv_…`), `saveToAccount`. @typedef {import("./types.js").Schemas["TravelerInput"]} TravelerInput */
/** `fieldErrors[].code` values of `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID` and `CHECKOUT_INCOMPLETE`. @typedef {import("./types.js").Schemas["TravelerFieldErrorCode"]} TravelerFieldErrorCode */
/** Booking contact (`cco_…` / `bco_…`), Amadeus `Contact`. @typedef {import("./types.js").Schemas["Contact"]} Contact */
/** Contact as sent to `CheckoutApi.setContacts` and `BookingsApi.update`. @typedef {import("./types.js").Schemas["ContactInput"]} ContactInput */
/** Remark (customer special request → Amadeus general remark). @typedef {import("./types.js").Schemas["Remark"]} Remark */
/** Special request as sent to `CheckoutApi.setRemarks` and `BookingsApi.update`. @typedef {import("./types.js").Schemas["RemarkInput"]} RemarkInput */
/** Payment (`pay_…`) at the OTA's payment provider, or by the airline (`provider: "airline"`). @typedef {import("./types.js").Schemas["Payment"]} Payment */
/** Payment status machine (requires_payment_method → requires_action → processing → authorized → captured …; `cancelled` / `failed`). @typedef {Payment["status"]} PaymentStatus */
/** `booking` (checkout payment) or `ancillaries` (extras bought after booking). @typedef {NonNullable<Payment["purpose"]>} PaymentPurpose */
/** Payment methods a storefront can start (`card`, and `airline_card` on the hosted storefront). @typedef {import("./types.js").Schemas["PaymentCreateRequest"]["method"]} CheckoutPaymentMethod */
/** Payment service providers (and `airline` for airline-card payments). @typedef {Payment["provider"]} PaymentProvider */
/** Card brand + BIN hint used for the credit-card fee. @typedef {import("./types.js").Schemas["PaymentCardHint"]} PaymentCardHint */
/** Booking (`bkg_…`): an Amadeus flight order as the customer sees it. @typedef {import("./types.js").Schemas["Booking"]} Booking */
/** `pending` | `confirmed` | `ticketed` | `partially_ticketed` | `cancelled` | `failed`. @typedef {import("./types.js").Schemas["BookingStatus"]} BookingStatus */
/** Booking card for "My trips". @typedef {import("./types.js").Schemas["BookingSummary"]} BookingSummary */
/** Self-service actions currently allowed (+ reasons). @typedef {import("./types.js").Schemas["BookingAllowedActions"]} BookingAllowedActions */
/** Customer-allowed traveller change keyed by `travelerId` (documents, loyalty, contact, emergency contact). @typedef {import("./types.js").Schemas["BookingTravelerUpdate"]} BookingTravelerUpdate */
/** Extras that can still be bought for a booking (`BookingsApi.getAncillaries`). @typedef {import("./types.js").Schemas["BookingAncillaryOptions"]} BookingAncillaryOptions */
/** One extra checked-bag option of an existing booking (`bao_…`). @typedef {import("./types.js").Schemas["BookingAncillaryOption"]} BookingAncillaryOption */
/** One extra to buy for a booking: option + traveller (+ quantity). @typedef {import("./types.js").Schemas["BookingAncillarySelection"]} BookingAncillarySelection */
/** A booked bag, seat or service (`source`: `checkout` | `post_booking` | `airline`). @typedef {import("./types.js").Schemas["BookingAncillary"]} BookingAncillary */
/** Issued travel document (e-ticket / EMD). @typedef {import("./types.js").Schemas["Ticket"]} Ticket */
/** Ticketing status of a booking. @typedef {import("./types.js").Schemas["IssuanceStatus"]} TicketingStatus */
/** OTA ticketing policy (`issue_at_booking` | `issue_after_payment` | `manual_review`). @typedef {import("./types.js").Schemas["IssuancePolicy"]} TicketingPolicy */
/** Ticketing progress returned by `BookingsApi.getTicketingStatus`. @typedef {import("./types.js").Schemas["BookingTicketingStatus"]} BookingTicketingStatus */
/** Generated booking document (e-ticket receipt, EMD receipt, itinerary, invoice, credit note). @typedef {import("./types.js").Schemas["Document"]} BookingDocument */
/** Document kinds. @typedef {BookingDocument["kind"]} BookingDocumentKind */
/** Short-lived signed download URL. @typedef {import("./types.js").Schemas["DocumentDownloadUrl"]} DocumentDownloadUrl */
/** Customer-visible timeline entry. @typedef {import("./types.js").Schemas["BookingEvent"]} BookingEvent */
/** Rebooking / refund eligibility of a booking. @typedef {import("./types.js").Schemas["BookingFareRules"]} BookingFareRules */
/** What cancelling now would do (mode, estimated refund, penalties, per-traveller lines). @typedef {import("./types.js").Schemas["CancellationQuote"]} CancellationQuote */
/** Cancellation of a booking. @typedef {import("./types.js").Schemas["Cancellation"]} Cancellation */
/** Customer's cancellation reason code (`reasonCode` of `BookingsApi.cancel`). @typedef {import("./types.js").Schemas["CancellationReason"]} CancellationReason */
/** Result of `BookingsApi.cancel`. @typedef {import("./types.js").Schemas["CancellationResult"]} CancellationResult */
/** Refund of a captured payment. @typedef {import("./types.js").Schemas["Refund"]} Refund */
/** Result of `BookingsApi.lookup`: guest token + booking card. @typedef {import("./types.js").Schemas["BookingLookupResult"]} BookingLookupResult */

/* ------------------------------------------------------------------------------------------------------------ */
/* Parameters                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Optimistic-locking value for `If-Match`: the resource `version` (a number, sent as `"<n>"`) or the raw `ETag`
 * header value (a string, sent as it is, for example `"3"` with its quotes).
 * @typedef {number | string} IfMatchValue
 */

/** Parameters of `CheckoutApi.create`. @typedef {import("./types.js").Schemas["CheckoutCreateRequest"]} CreateCheckoutParams */

/**
 * Parameters identifying a checkout.
 * @typedef {object} CheckoutRefParams
 * @property {string} checkoutId checkout id (`chk_…`)
 */

/**
 * Common parameters of the checkout step methods.
 * @typedef {CheckoutRefParams & { ifMatch?: IfMatchValue }} CheckoutStepParams `ifMatch`: the checkout `version` or
 *   ETag; a stale value throws `VelexisError` `PRECONDITION_FAILED` (412)
 */

/**
 * Parameters of `CheckoutApi.setTravelers`: `travelers` keyed by `travelerId` (the Amadeus id `"1"`, `"2"`, …, as in
 * `checkout.travelers[].travelerId`); each listed traveller is replaced, the others are kept.
 * @typedef {CheckoutStepParams & { travelers: TravelerInput[] }} SetCheckoutTravelersParams
 */

/**
 * Parameters of `CheckoutApi.setContacts`: 1–3 `contacts` (replace all); exactly one primary contact with an e-mail.
 * @typedef {CheckoutStepParams & { contacts: ContactInput[] }} SetCheckoutContactsParams
 */

/**
 * Parameters of `CheckoutApi.setAncillaries`: `selections` (replace all; `[]` removes every ancillary): `optionId`
 * from `flights.getAncillaries`, or an explicit type, quantity, weight, service name or seat number; `expectedTotal`,
 * the checkout total the customer saw (a different re-priced total throws `PriceChangedError` and leaves the checkout
 * unchanged).
 * @typedef {CheckoutStepParams & { selections: import("./types.js").Schemas["AncillarySelection"][], expectedTotal?: import("./shared.js").Money }} SetCheckoutAncillariesParams
 */

/**
 * Parameters of `CheckoutApi.setRemarks`: up to 5 `remarks` (replace all; `[]` removes them).
 * @typedef {CheckoutStepParams & { remarks: RemarkInput[] }} SetCheckoutRemarksParams
 */

/** Parameters of `CheckoutApi.createPayment`. @typedef {CheckoutRefParams & import("./types.js").Schemas["PaymentCreateRequest"]} CreateCheckoutPaymentParams */

/**
 * Parameters of `CheckoutApi.getPayment`.
 * @typedef {object} GetPaymentParams
 * @property {string} paymentId payment id (`pay_…`)
 */

/** Parameters of `CheckoutApi.updatePayment`: the payment + the card hint reported by the provider's card form. @typedef {GetPaymentParams & import("./types.js").Schemas["PaymentUpdateRequest"]} UpdatePaymentParams */
/** Parameters of `CheckoutApi.complete`. @typedef {CheckoutRefParams & import("./types.js").Schemas["CheckoutCompleteRequest"]} CompleteCheckoutParams */

/**
 * `details` of `409 PRICE_CHANGED` thrown by checkout methods (also on `PriceChangedError.oldPrice` / `.newPrice`).
 * @typedef {object} CheckoutPriceChangedDetails
 * @property {import("./shared.js").Money} oldPrice total the customer saw
 * @property {import("./shared.js").Money} newPrice new total
 * @property {string} pricedOfferId new priced offer (the checkout already points to it after `complete`,
 *   `createPayment` or `updatePayment`)
 */

/**
 * `details` of `504 SUPPLIER_TIMEOUT` thrown by `CheckoutApi.complete`: the order may exist — store the guest token,
 * poll the booking, never re-book with a new idempotency key. Same-key retries replay these details.
 * @typedef {object} CheckoutTimeoutDetails
 * @property {string} bookingId pending booking to poll with `BookingsApi.getTicketingStatus` until `bookingStatus`
 *   leaves `pending`
 * @property {string} [bookingToken] guests only: booking token; keep it exactly like `CheckoutCompletion.bookingToken`
 * @property {string} [bookingTokenExpiresAt] guests only: token expiry
 * @property {boolean} [replayed] true when this answer is a replay of an earlier same-key attempt
 */

/** Tab of "My trips": the `timeframe` filter, matching `BookingSummary.timeframe` (not a `BookingStatus`). @typedef {"upcoming" | "past" | "cancelled" | "all"} BookingListTimeframe */
/**
 * Deprecated: the old name of `BookingListTimeframe`, renamed because the filter is `timeframe`, not a booking status.
 * @deprecated Renamed to `BookingListTimeframe`.
 * @typedef {BookingListTimeframe} BookingListStatus
 */
/** Order of `BookingsApi.list`. @typedef {"departure" | "-departure" | "created" | "-created"} BookingListSort */

/**
 * Parameters of `BookingsApi.list`: the common list parameters and the filters of "My trips".
 * @typedef {object} ListBookingsParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size (at most 100)
 * @property {BookingListTimeframe} [timeframe] tab (default `upcoming`); filters on `BookingSummary.timeframe`. For
 *   booking statuses use the console list.
 * @property {string} [departureFrom] first departure on or after this local date (`YYYY-MM-DD`)
 * @property {string} [departureTo] first departure on or before this local date
 * @property {string} [createdFrom] booked at or after this instant (inclusive, ISO-8601 date-time), as in the console
 *   lists
 * @property {string} [createdTo] booked before this instant (exclusive, ISO-8601 date-time), as in the console lists
 * @property {BookingListSort} [sort] sort (default per tab); changing filters or sort requires dropping `cursor`
 */

/**
 * Parameters identifying a booking.
 * @typedef {object} BookingRefParams
 * @property {string} bookingId booking id (`bkg_…`)
 */

/**
 * Parameters of `BookingsApi.get`.
 * @typedef {object} GetBookingParams
 * @property {string} bookingId booking id (`bkg_…`)
 * @property {boolean} [refresh] synchronise with Amadeus Flight Order Management GET first (throttled to once per
 *   60 s per booking)
 * @property {Array<"bags">} [include] with `refresh`: Amadeus `include` (`bags` = raw extra bag options in
 *   `amadeus.included.bags`; to buy them use `BookingsApi.getAncillaries`); sent comma-separated
 * @property {Array<"rebooks" | "refunds">} [fareRules] with `refresh`: Amadeus `fareRules` eligibility (`rebooks`,
 *   `refunds`), returned in `fareRules`; sent comma-separated
 */

/** Parameters of `BookingsApi.lookup`: the booking reference (or record locator) and any traveller's last name. @typedef {import("./types.js").Schemas["BookingLookupRequest"]} LookupBookingParams */

/**
 * Parameters of `BookingsApi.update`: `ifMatch` (required), the booking `version` (or ETag) the customer saw, and the
 * changes (`contacts`, `travelers` keyed by `travelerId`, `remarks`).
 * @typedef {BookingRefParams & { ifMatch: IfMatchValue } & import("./types.js").Schemas["BookingUpdateRequest"]} UpdateBookingParams
 */

/**
 * Parameters of `BookingsApi.cancel`: `ifMatch` (required), the booking `version` (or ETag), `reasonCode`
 * (`CancellationReason`), an optional `comment` and the quote's `estimatedRefund` as `expectedRefund`.
 * @typedef {BookingRefParams & { ifMatch: IfMatchValue } & import("./types.js").Schemas["CancellationRequest"]} CancelBookingParams
 */

/** Parameters of `BookingsApi.createPayment`: selections, confirmed `expectedTotal`, payment method. @typedef {BookingRefParams & import("./types.js").Schemas["BookingPaymentCreateRequest"]} CreateBookingPaymentParams */

/**
 * Parameters of `BookingsApi.addAncillaries`: `ifMatch` (required), the booking `version` (or ETag), and the
 * `selections`, `paymentId` and `expectedTotal` of `BookingsApi.createPayment`.
 * @typedef {BookingRefParams & { ifMatch: IfMatchValue } & import("./types.js").Schemas["BookingAncillariesRequest"]} AddBookingAncillariesParams
 */

/**
 * Parameters of `BookingsApi.getFareRules`.
 * @typedef {object} GetBookingFareRulesParams
 * @property {string} bookingId booking id (`bkg_…`)
 * @property {Array<"rebooks" | "refunds">} [types] Amadeus `fareRules` values (default both); sent comma-separated
 * @property {boolean} [refresh] bypass the 1-hour cache
 */

/**
 * Parameters of `BookingsApi.getTicketingStatus`.
 * @typedef {object} GetTicketingStatusParams
 * @property {string} bookingId booking id (`bkg_…`)
 * @property {boolean} [refresh] read tickets from Amadeus when the status is not final (throttled to once per 60 s)
 */

/**
 * Parameters of `BookingsApi.listDocuments`.
 * @typedef {object} ListBookingDocumentsParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 * @property {string} bookingId booking id (`bkg_…`)
 * @property {BookingDocumentKind[]} [kind] only these kinds; sent comma-separated
 */

/**
 * Parameters of `BookingsApi.getDocumentDownloadUrl`.
 * @typedef {object} GetDocumentDownloadUrlParams
 * @property {string} bookingId booking id (`bkg_…`)
 * @property {string} documentId document id (`doc_…`)
 */

/** Parameters of `BookingsApi.listEvents`. @typedef {import("./shared.js").ListParams & BookingRefParams} ListBookingEventsParams */

/** A checkout completion as returned to callers that want warnings typed explicitly. @typedef {CheckoutCompletion & import("./shared.js").WithWarnings} CheckoutCompletionWithWarnings */

/* ------------------------------------------------------------------------------------------------------------ */
/* Namespaces (inferred from the factories)                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * `client.checkout`: turn a priced offer into a booking. Typical order: `create` → `setTravelers` → `setContacts` →
 * (`setAncillaries`) → (`setRemarks`) → `createPayment` → `updatePayment` when the card form reports the brand or BIN →
 * the provider confirms the card → `getPayment` → `complete`; on the hosted storefront with the airline card,
 * `createPayment({ method: "airline_card" })` → `completeWithAirlineCard`. Every step returns the whole `Checkout`.
 * @typedef {ReturnType<typeof import("./namespaces/checkout.js").createCheckoutApi>} CheckoutApi
 */

/**
 * `client.bookings`: the customer and guest view of bookings ("My trips", detail, manage booking). Customers use their
 * access token; guests the booking token of `checkout.complete` or `bookings.lookup` (client option `bookingToken` or
 * `RequestOptions.bookingToken` in token and server mode; the httpOnly `__Host-vx_bt` cookie in cookie mode, where a
 * booking token in the options is refused). Only bookings of the key's environment are visible. Staff booking
 * management is `console.*`.
 * @typedef {ReturnType<typeof import("./namespaces/bookings.js").createBookingsApi>} BookingsApi
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Additions to the contract (ota/sdk/docs/extensions.md §3.1)                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The traveller's card for `CheckoutApi.completeWithAirlineCard`: `brand`, `holderName`, `number` (digits only),
 * `expiryMonth`, `expiryYear` and `securityCode`. Held in memory for one call only; never store, log or queue it.
 * @typedef {import("./types.js").Schemas["AirlineCardCompletionRequest"]["card"]} AirlineCard
 */

/**
 * Parameters of `CheckoutApi.completeWithAirlineCard`: the checkout, its active `airline_card` payment, the amount the
 * airline will charge (`expectedTotal`) and the `card`.
 * @typedef {CheckoutRefParams & import("./types.js").Schemas["AirlineCardCompletionRequest"]} CompleteWithAirlineCardParams
 */
