// The staff console (mirrors docs/velexis-sdk/sdk/src/console.d.ts, ADR-0019, OADR-0016 point 1, guide B4): the
// typedefs of console.d.ts with the same names, in the same order, and the factory of the `console` namespace. The
// namespace types (`ConsoleApi` and its six sub-namespaces) are inferred from the factory in ./namespaces/console.js,
// so each method is documented once, there. SDK-011 writes the 32 methods of the contract (`console.auth`,
// `.bookings`, `.queues`, `.customers`, `.supplierRequests`, `.amadeus`); SDK-012 adds the MVP additions
// `console.settings.*` and `console.payments.*` (ota/sdk/docs/extensions.md §3.2 and §3.3) with their types, which
// close the file after the contract's names (the contract has no counterpart for them).
//
// console.d.ts also augments `VelexisClientOptions` of shared.d.ts with `sessionKind` (`"customer"` | `"staff"`) and
// `onStaffSessionRefreshed`. JavaScript cannot augment a typedef, so both options are members of
// `VelexisClientOptions` in shared.js: internal/client.js validates them, and internal/session.js makes the automatic
// refresh of a `sessionKind: "staff"` client call `console.auth.refresh` (`POST /v1/console/auth/refresh`), report
// `result.session` to `onSessionRefreshed` and the whole `ConsoleStaffSession` to `onStaffSessionRefreshed`
// (ota/sdk/README.md §4.3). The extension `environment` (`"test"` | `"live"`, extensions.md §1) sends
// `X-Velexis-Environment` on every console operation, never on a customer operation.
//
// Schema types come only from `@velexis/api-types` through ./types.js; nothing here declares a name that shared.js,
// identity.js, flights.js or bookings.js exports, because index.js re-exports all of them with `export *`.

export { createConsoleApi } from "./namespaces/console.js";

/* ------------------------------------------------------------------------------------------------------------ */
/* Schema aliases                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** Console role of a staff member: `owner` | `admin` | `agent` | `finance` | `viewer`. @typedef {import("./types.js").Schemas["StaffRole"]} StaffRole */
/** Permission derived from the role (e.g. `bookings:issue`, `amadeus:write`); automation keys list theirs in their scopes. @typedef {import("./types.js").Schemas["StaffPermission"]} StaffPermission */

/**
 * Scope of a secret key on `/v1/console/**` (`platform.api_keys.scopes`): `storefront` (console refused), `console`
 * (staff token required) or `console:automation` (key-only calls allowed, with the `StaffPermission`s listed next to
 * it in the key's scopes).
 * @typedef {import("./types.js").Schemas["ConsoleApiKeyScope"]} ConsoleApiKeyScope
 */

/** A staff member of the OTA (portal account + membership, id `stf_…`). @typedef {import("./types.js").Schemas["StaffMember"]} StaffMember */
/** The OTA, its environment (test/live) and its configured Amadeus offices. @typedef {import("./types.js").Schemas["ConsoleTenant"]} ConsoleTenant */
/** Result of sign-in / refresh: tokens (`session`), staff member, tenant, permissions. @typedef {import("./types.js").Schemas["ConsoleStaffSession"]} ConsoleStaffSession */
/** Result of `ConsoleAuthApi.me`. @typedef {import("./types.js").Schemas["ConsoleStaffProfile"]} ConsoleStaffProfile */
/** A booking in console scope: the customer `Booking` + console-only details (net, markup, sync, audit, actions). @typedef {import("./types.js").Schemas["ConsoleBooking"]} ConsoleBooking */
/** Console-only part of `ConsoleBooking`. @typedef {import("./types.js").Schemas["ConsoleBookingDetails"]} ConsoleBookingDetails */
/** Row of `ConsoleBookingsApi.list`. @typedef {import("./types.js").Schemas["ConsoleBookingSummary"]} ConsoleBookingSummary */
/** `pending` | `confirmed` | `ticketed` | `partially_ticketed` | `cancelled` | `failed`. @typedef {import("./types.js").Schemas["BookingStatus"]} ConsoleBookingStatus */
/** Ticketing status (`pending`, `in_progress`, `issued`, `partially_issued`, `failed`, `manual_review`, `not_applicable`). @typedef {import("./types.js").Schemas["IssuanceStatus"]} ConsoleTicketingStatus */
/** Derived payment state (`unpaid`, `authorized`, `paid`, `partially_refunded`, `refunded`, `failed`, `not_applicable`). @typedef {import("./types.js").Schemas["ConsolePaymentStatus"]} ConsolePaymentStatus */
/** Net cost, markup, fees, selling total and margin of a booking. @typedef {import("./types.js").Schemas["ConsoleBookingPricing"]} ConsoleBookingPricing */
/** Synchronisation state with Amadeus (last sync, error, detected differences). @typedef {import("./types.js").Schemas["ConsoleSupplierSync"]} ConsoleSupplierSync */

/**
 * One sync-status vocabulary for the list row (`ConsoleBookingSummary.syncStatus`) and the detail
 * (`ConsoleSupplierSync.status`): `refreshed` | `fresh` | `stale` | `throttled` | `failed` | `order_not_found` |
 * `not_applicable`, a superset of the customer `Booking.syncStatus`.
 * @typedef {import("./types.js").Schemas["ConsoleBookingSyncStatus"]} ConsoleBookingSyncStatus
 */

/** `error.details` of `SUPPLIER_TIMEOUT` (504) from `ConsoleBookingsApi.create`: the pending booking that was kept. @typedef {import("./types.js").Schemas["ConsoleBookingTimeoutDetails"]} ConsoleBookingTimeoutDetails */

/**
 * An Amadeus flight offer as console request bodies accept it: `AmadeusFlightOffer` + `fareDetailsBySegment[].fareType`
 * and the complete `additionalServices` (incl. `chargeableCabinBags`). Any `AmadeusFlightOffer` is assignable to it.
 * @typedef {import("./types.js").Schemas["ConsoleAmadeusFlightOffer"]} ConsoleAmadeusFlightOffer
 */

/** Complete Amadeus `additionalServices`: chargeable checked bags, cabin bags, seat (+ deprecated seat number), other services. @typedef {import("./types.js").Schemas["ConsoleAmadeusAdditionalServices"]} ConsoleAmadeusAdditionalServices */
/** One difference detected by a sync (JSON pointer, label, before, after). @typedef {import("./types.js").Schemas["ConsoleSyncChange"]} ConsoleSyncChange */
/** Redacted form of payment of an order. @typedef {import("./types.js").Schemas["ConsoleFormOfPayment"]} ConsoleFormOfPayment */
/** Who did something (staff, API key, system, customer, supplier). @typedef {import("./types.js").Schemas["ConsoleActor"]} ConsoleActor */
/** Internal note of a booking. @typedef {import("./types.js").Schemas["ConsoleBookingNote"]} ConsoleBookingNote */
/** Timeline entry as staff see it (incl. events hidden from customers). @typedef {import("./types.js").Schemas["ConsoleBookingEvent"]} ConsoleBookingEvent */
/** Audit row (staff_actions). @typedef {import("./types.js").Schemas["ConsoleStaffAction"]} ConsoleStaffAction */
/** Console actions the caller may perform now (+ reasons). @typedef {import("./types.js").Schemas["ConsoleBookingActions"]} ConsoleBookingActions */
/** Result of `ConsoleBookingsApi.resync`. @typedef {import("./types.js").Schemas["ConsoleBookingResyncResult"]} ConsoleBookingResyncResult */
/** Result of `ConsoleBookingsApi.retrieve`: verbatim Amadeus order + call info. @typedef {import("./types.js").Schemas["ConsoleFlightOrderRetrieval"]} ConsoleFlightOrderRetrieval */
/** Information about the Amadeus call behind a console response (supplier request id, status, latency …). @typedef {import("./types.js").Schemas["ConsoleAmadeusCall"]} ConsoleAmadeusCall */
/** Verbatim Amadeus flight-order response (`meta`, `warnings`, `data`, `included`, `dictionaries`). @typedef {import("./types.js").Schemas["ConsoleAmadeusFlightOrderReply"]} ConsoleAmadeusFlightOrderReply */
/** One logged Amadeus call (supplier_requests). @typedef {import("./types.js").Schemas["ConsoleSupplierRequest"]} ConsoleSupplierRequest */
/** Result of `ConsoleBookingsApi.findByRecordLocator`. @typedef {import("./types.js").Schemas["PnrLookupResult"]} PnrLookupResult */
/** One flight order matching a record locator (summary + verbatim order + link to this OTA's booking). @typedef {import("./types.js").Schemas["PnrMatch"]} PnrMatch */
/** Normalised summary of an Amadeus order. @typedef {import("./types.js").Schemas["PnrOrderSummary"]} PnrOrderSummary */
/** One PNR on an office queue (wraps the verbatim Amadeus PNR item). @typedef {import("./types.js").Schemas["QueueItem"]} QueueItem */
/** A stored Queue List read (`qsn_…`). @typedef {import("./types.js").Schemas["QueueSnapshot"]} QueueSnapshot */
/** Customer row of `ConsoleCustomersApi.list`. @typedef {import("./types.js").Schemas["ConsoleCustomerSummary"]} ConsoleCustomerSummary */
/** Result of `ConsoleCustomersApi.get`. @typedef {import("./types.js").Schemas["ConsoleCustomer"]} ConsoleCustomer */
/** Booking statistics of a customer. @typedef {import("./types.js").Schemas["ConsoleCustomerStats"]} ConsoleCustomerStats */
/** Result of the raw Flight Offers Search methods. @typedef {import("./types.js").Schemas["ConsoleAmadeusFlightOffersResult"]} ConsoleAmadeusFlightOffersResult */
/** Result of the raw Flight Availabilities Search. @typedef {import("./types.js").Schemas["ConsoleAmadeusAvailabilitiesResult"]} ConsoleAmadeusAvailabilitiesResult */
/** Result of the raw Branded Fares Upsell. @typedef {import("./types.js").Schemas["ConsoleAmadeusUpsellResult"]} ConsoleAmadeusUpsellResult */
/** Result of the raw Flight Offers Price. @typedef {import("./types.js").Schemas["ConsoleAmadeusPricingResult"]} ConsoleAmadeusPricingResult */
/** Result of the raw flight-order operations (create, issue, get, patch). @typedef {import("./types.js").Schemas["ConsoleAmadeusFlightOrderResult"]} ConsoleAmadeusFlightOrderResult */
/** Result of the raw Get Flight Order By Record Locator. @typedef {import("./types.js").Schemas["ConsoleAmadeusFlightOrdersByReferenceResult"]} ConsoleAmadeusFlightOrdersByReferenceResult */
/** Result of the raw Queue List. @typedef {import("./types.js").Schemas["ConsoleAmadeusQueueResult"]} ConsoleAmadeusQueueResult */
/** Result of the raw Flight Order Management DELETE. @typedef {import("./types.js").Schemas["ConsoleAmadeusCancelResult"]} ConsoleAmadeusCancelResult */

/* ------------------------------------------------------------------------------------------------------------ */
/* Parameters                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Optimistic-locking value for `If-Match`: the booking `version` (a number, sent as `"<n>"`) or the raw `ETag` header
 * value (a string, sent as it is, for example `"3"` with its quotes).
 * @typedef {number | string} ConsoleIfMatch
 */

/** Amadeus `include` of flight-order reads: `bags` adds the extra bag options (`included.bags`); sent comma-separated. @typedef {Array<"bags">} ConsoleOrderInclude */
/** Amadeus `fareRules` of Flight Order Management GET: rebooking and/or refund eligibility; sent comma-separated. @typedef {Array<"rebooks" | "refunds">} ConsoleOrderFareRules */
/** Params of `ConsoleAuthApi.signIn`: a one-time portal token (the MVP grant) or portal credentials (+ `mfaCode`). @typedef {import("./types.js").Schemas["ConsoleSignInRequest"]} ConsoleSignInParams */
/** Params of `ConsoleAuthApi.refresh`. @typedef {import("./types.js").Schemas["ConsoleRefreshRequest"]} ConsoleRefreshParams */
/** Params of `ConsoleAuthApi.signOut`. @typedef {import("./types.js").Schemas["ConsoleSignOutRequest"]} ConsoleSignOutParams */
/** Params of `ConsoleAuthApi.me` (none). @typedef {Record<string, never>} ConsoleMeParams */

/**
 * Sort orders of `ConsoleBookingsApi.list`.
 * @typedef {"created" | "-created" | "departure" | "-departure" | "ticketingDeadline" | "-ticketingDeadline" | "total" | "-total"} ConsoleBookingSort
 */

/**
 * Params of `ConsoleBookingsApi.list`. List values are sent comma-separated and OR-ed; filters are AND-ed.
 * @typedef {object} ConsoleListBookingsParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 * @property {ConsoleBookingStatus[]} [status] booking statuses, e.g. `["confirmed", "partially_ticketed"]`
 * @property {ConsoleTicketingStatus[]} [ticketingStatus] ticketing statuses, e.g. `["failed", "manual_review"]`
 * @property {string} [ticketingDeadlineBefore] only bookings whose ticketing deadline is before this ISO-8601 instant
 * @property {string} [recordLocator] main record locator or any associated (airline) locator
 * @property {string} [reference] Velexis booking reference
 * @property {string} [customerId] bookings of this customer (`cus_…`)
 * @property {string} [customerEmail] customer or booking-contact e-mail (exact, case-insensitive)
 * @property {string} [travelerLastName] prefix of any traveller's last name (at least 2 characters)
 * @property {string} [departureFrom] first departure on or after this local date (`YYYY-MM-DD`)
 * @property {string} [departureTo] first departure on or before this local date (`YYYY-MM-DD`)
 * @property {string} [createdFrom] created at or after (ISO-8601)
 * @property {string} [createdTo] created before (ISO-8601)
 * @property {ConsolePaymentStatus[]} [paymentStatus] derived payment states
 * @property {Array<"storefront" | "console" | "import">} [source] channels the booking came from
 * @property {string} [validatingCarrier] validating airline (IATA)
 * @property {string} [createdByStaffId] created or imported by this staff member (`stf_…`)
 * @property {string} [tag] staff tag
 * @property {string} [q] free text: reference, record locator, contact e-mail or lead last name
 * @property {ConsoleBookingSort} [sort] sort (default `-created`)
 */

/**
 * Page returned by `ConsoleBookingsApi.list` (`totalCount` exact up to 10 000, else null).
 * @typedef {import("./shared.js").Page<ConsoleBookingSummary> & { totalCount?: number | null }} ConsoleBookingPage
 */

/**
 * Identifies a booking.
 * @typedef {object} ConsoleBookingRefParams
 * @property {string} bookingId booking id (`bkg_…`)
 */

/**
 * Params of `ConsoleBookingsApi.get`.
 * @typedef {object} ConsoleGetBookingParams
 * @property {string} bookingId booking id (`bkg_…`)
 * @property {boolean} [refresh] synchronise with Amadeus Flight Order Management GET first (throttled to 1 per 10 s
 *   per booking)
 * @property {ConsoleOrderInclude} [include] with `refresh`: Amadeus `include`
 * @property {ConsoleOrderFareRules} [fareRules] with `refresh`: Amadeus `fareRules` (fills `fareRules`)
 */

/**
 * Params of `ConsoleBookingsApi.findByRecordLocator`.
 * @typedef {object} ConsoleFindByRecordLocatorParams
 * @property {string} reference record locator (Amadeus or other airline), e.g. `"L2P9XC"`
 * @property {string} [originSystemCode] Amadeus `originSystemCode`; the SDK sends `"GDS"` when omitted (the only value
 *   Amadeus supports today)
 * @property {ConsoleOrderInclude} [include] Amadeus `include` (`["bags"]`)
 */

/** Params of `ConsoleBookingsApi.import`. @typedef {import("./types.js").Schemas["ConsoleBookingImportRequest"]} ConsoleImportBookingParams */

/**
 * Params of `ConsoleBookingsApi.retrieve`.
 * @typedef {object} ConsoleRetrieveFlightOrderParams
 * @property {string} bookingId booking id (`bkg_…`)
 * @property {ConsoleOrderInclude} [include] Amadeus `include` (`["bags"]`)
 * @property {ConsoleOrderFareRules} [fareRules] Amadeus `fareRules` (`["rebooks"]`, `["refunds"]` or both)
 * @property {boolean} [updateSnapshot] store the response as the booking's order snapshot (default true)
 */

/**
 * Params of `ConsoleBookingsApi.create`: a priced offer (`prc_…`) + the full Flight Create Orders data + Velexis options
 * (pricing mode, expected totals, tags …).
 * @typedef {import("./types.js").Schemas["ConsoleBookingCreateRequest"]} ConsoleCreateBookingParams
 */

/**
 * Params of `ConsoleBookingsApi.patch`: booking, `ifMatch` (the booking version or ETag you displayed), the Flight Order
 * Management PATCH elements, the merge options (`mergeTravelers`, `mergeRemarks`, `mergeContacts`, all default true)
 * and the local-only `tags` / `metadata`.
 * @typedef {ConsoleBookingRefParams & { ifMatch: ConsoleIfMatch } & import("./types.js").Schemas["ConsoleBookingPatchRequest"]} ConsolePatchBookingParams
 */

/**
 * Params of `ConsoleBookingsApi.issue`: booking, `ifMatch` (the booking version or ETag you displayed) and the issue
 * request (`formOfPayments`, `capturePayment`, `allowUnpaid`, `reason`).
 * @typedef {ConsoleBookingRefParams & { ifMatch: ConsoleIfMatch } & import("./types.js").Schemas["ConsoleBookingIssueRequest"]} ConsoleIssueBookingParams
 */

/**
 * Params of `ConsoleBookingsApi.cancel`: booking, `ifMatch` (the booking version or ETag you displayed) and the
 * cancellation request (`reasonCode`, `reason`, `refund`, `notifyCustomer`).
 * @typedef {ConsoleBookingRefParams & { ifMatch: ConsoleIfMatch } & import("./types.js").Schemas["ConsoleBookingCancelRequest"]} ConsoleCancelBookingParams
 */

/**
 * Refund instruction of `ConsoleBookingsApi.cancel`.
 * @typedef {object} ConsoleCancelRefund
 * @property {"none" | "full" | "amount"} mode `none`, the `full` captured amount, or `amount`
 * @property {import("./shared.js").Money} [amount] amount to refund for mode `amount` (at most the captured amount)
 */

/** Params of `ConsoleBookingsApi.resync`. @typedef {ConsoleBookingRefParams & import("./types.js").Schemas["ConsoleBookingResyncRequest"]} ConsoleResyncBookingParams */
/** Params of `ConsoleBookingsApi.addNote`. @typedef {ConsoleBookingRefParams & import("./types.js").Schemas["ConsoleBookingNoteRequest"]} ConsoleAddBookingNoteParams */

/**
 * Params of `ConsoleQueuesApi.list`. Without `cursor` Amadeus is called and a snapshot stored; with `cursor` the stored
 * snapshot is paged.
 * @typedef {object} ConsoleListQueueParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page (pages the stored snapshot)
 * @property {number} [limit] the page size
 * @property {number} queueId Amadeus queue number (`queue-id`), e.g. `50`
 * @property {number} [category] queue category (Amadeus default 0)
 * @property {string} [officeId] office id (default: the OTA's queuing office); must be configured on the OTA's Amadeus
 *   connection
 * @property {number} [max] maximum number of PNRs Amadeus returns (`max`)
 */

/**
 * Page returned by `ConsoleQueuesApi.list`: PNR items + the snapshot they come from + Amadeus warnings.
 * @typedef {import("./shared.js").Page<QueueItem> & import("./shared.js").WithWarnings & { snapshot: QueueSnapshot }} ConsoleQueuePage
 */

/**
 * Params of `ConsoleQueuesApi.listSnapshots`.
 * @typedef {object} ConsoleListQueueSnapshotsParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 * @property {number} [queueId] queue number
 * @property {string} [officeId] office id
 * @property {number} [category] category
 * @property {string} [fetchedFrom] taken at or after (ISO-8601)
 * @property {string} [fetchedTo] taken before (ISO-8601)
 * @property {Array<"items">} [include] `["items"]` adds the PNR items of each snapshot
 */

/**
 * Params of `ConsoleCustomersApi.list`.
 * @typedef {object} ConsoleListCustomersParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 * @property {string} [q] prefix of e-mail, first or last name
 * @property {string} [email] exact e-mail
 * @property {Array<"active" | "disabled" | "deleted">} [status] account statuses (default active + disabled)
 * @property {boolean} [emailVerified] only verified / unverified e-mails
 * @property {boolean} [hasBookings] only customers with / without bookings
 * @property {string} [createdFrom] signed up at or after (ISO-8601)
 * @property {string} [createdTo] signed up before (ISO-8601)
 * @property {"-created" | "created" | "name" | "-lastBooking" | "-totalSpent"} [sort] sort (default `-created`)
 */

/**
 * Params of `ConsoleCustomersApi.get`.
 * @typedef {object} ConsoleGetCustomerParams
 * @property {string} customerId customer id (`cus_…`)
 */

/** Amadeus APIs as logged in supplier_requests. @typedef {import("./types.js").Schemas["ConsoleSupplierRequest"]["amadeusApi"]} ConsoleAmadeusApiName */

/**
 * Params of `ConsoleSupplierRequestsApi.list`.
 * @typedef {object} ConsoleListSupplierRequestsParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size (at most 20 with `includeBodies`)
 * @property {string} [bookingId] calls for this booking
 * @property {string} [searchId] calls for this flight search (`srch_…`)
 * @property {ConsoleAmadeusApiName[]} [amadeusApi] Amadeus APIs
 * @property {string} [amadeusOperationId] Amadeus operationId, e.g. `"createFligtOrders"`
 * @property {Array<"success" | "client_error" | "server_error" | "timeout" | "network_error">} [outcome] outcomes
 * @property {number} [httpStatus] Amadeus HTTP status
 * @property {number} [errorCode] Amadeus error code, e.g. `4926`
 * @property {string} [staffId] triggered by this staff member
 * @property {string} [requestId] Velexis `X-Request-Id` (e.g. `VelexisError.requestId` of a failed call)
 * @property {string} [correlationId] Amadeus `ama-request-id`
 * @property {string} [createdFrom] called at or after (ISO-8601)
 * @property {string} [createdTo] called before (ISO-8601)
 * @property {boolean} [includeBodies] add the redacted request and response bodies (`limit` at most 20)
 */

/** Params of `ConsoleAmadeusApi.searchFlightOffers`: `{ amadeus: getFlightOffersQuery, bookingId?, reason? }`. @typedef {import("./types.js").Schemas["ConsoleAmadeusFlightOffersSearchRequest"]} ConsoleAmadeusSearchFlightOffersParams */

/**
 * Params of `ConsoleAmadeusApi.getFlightOffers`: the Amadeus GET query parameters, verbatim.
 * @typedef {object} ConsoleAmadeusGetFlightOffersParams
 * @property {string} originLocationCode city or airport IATA code of departure
 * @property {string} destinationLocationCode city or airport IATA code of destination
 * @property {string} departureDate departure date (`YYYY-MM-DD`)
 * @property {string} [returnDate] return date (round trips only)
 * @property {number} adults adults (12+), 1–9
 * @property {number} [children] children (2–11)
 * @property {number} [infants] infants (up to 2) on lap, at most one per adult
 * @property {"ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST"} [travelClass] minimum cabin
 * @property {string[] | string} [includedAirlineCodes] airlines to include (an array is sent comma-separated)
 * @property {string[] | string} [excludedAirlineCodes] airlines to exclude (an array is sent comma-separated)
 * @property {boolean} [nonStop] non-stop only
 * @property {string} [currencyCode] preferred currency (ISO 4217)
 * @property {number} [maxPrice] maximum price per traveller (integer)
 * @property {number} [max] maximum number of offers (default 250)
 */

/** Params of `ConsoleAmadeusApi.searchFlightAvailabilities`: `{ amadeus: getFlightAvailabilitiesQuery, … }`. @typedef {import("./types.js").Schemas["ConsoleAmadeusAvailabilitiesRequest"]} ConsoleAmadeusSearchFlightAvailabilitiesParams */
/** Params of `ConsoleAmadeusApi.upsellAirOffers`: `{ amadeus: { data: FlightOfferUpsellIn }, … }`. @typedef {import("./types.js").Schemas["ConsoleAmadeusUpsellRequest"]} ConsoleAmadeusUpsellAirOffersParams */
/** Amadeus `include` of Flight Offers Price. @typedef {Array<"credit-card-fees" | "bags" | "other-services" | "detailed-fare-rules">} ConsoleAmadeusPricingInclude */

/**
 * Params of `ConsoleAmadeusApi.quoteAirOffers`: body `{ amadeus: { data: FlightOfferPricingIn } }` + the Amadeus query
 * `include` (sent comma-separated) and `forceClass`.
 * @typedef {import("./types.js").Schemas["ConsoleAmadeusPricingRequest"] & { include?: ConsoleAmadeusPricingInclude, forceClass?: boolean }} ConsoleAmadeusQuoteAirOffersParams
 */

/**
 * Params of `ConsoleAmadeusApi.createFlightOrders`: body `{ amadeus: { data: FlightOrder }, importAsBooking?, … }` +
 * the Amadeus `issue` query flag (force issuance at booking time).
 * @typedef {import("./types.js").Schemas["ConsoleAmadeusCreateOrderRequest"] & { issue?: boolean }} ConsoleAmadeusCreateFlightOrdersParams
 */

/**
 * Identifies an Amadeus flight order.
 * @typedef {object} ConsoleFlightOrderRefParams
 * @property {string} flightOrderId Amadeus flight-order id (`data.id`)
 */

/** Params of `ConsoleAmadeusApi.issueFlightOrder`. @typedef {ConsoleFlightOrderRefParams & import("./types.js").Schemas["ConsoleAmadeusIssueRequest"]} ConsoleAmadeusIssueFlightOrderParams */

/**
 * Params of `ConsoleAmadeusApi.getFlightOrder`.
 * @typedef {object} ConsoleAmadeusGetFlightOrderParams
 * @property {string} flightOrderId Amadeus flight-order id (`data.id`)
 * @property {ConsoleOrderInclude} [include] Amadeus `include`
 * @property {ConsoleOrderFareRules} [fareRules] Amadeus `fareRules`
 */

/** Params of `ConsoleAmadeusApi.patchFlightOrder`: `{ flightOrderId, amadeus: { data: partial FlightOrder }, reason? }`. @typedef {ConsoleFlightOrderRefParams & import("./types.js").Schemas["ConsoleAmadeusPatchOrderRequest"]} ConsoleAmadeusPatchFlightOrderParams */

/**
 * Params of `ConsoleAmadeusApi.cancelFlightOrder`.
 * @typedef {object} ConsoleAmadeusCancelFlightOrderParams
 * @property {string} flightOrderId Amadeus flight-order id (`data.id`)
 * @property {string} reason audit justification (required)
 */

/**
 * Params of `ConsoleAmadeusApi.getFlightOrderByReference`.
 * @typedef {object} ConsoleAmadeusGetFlightOrderByReferenceParams
 * @property {string} reference record locator
 * @property {string} [originSystemCode] Amadeus `originSystemCode`; the SDK sends `"GDS"` when omitted
 * @property {ConsoleOrderInclude} [include] Amadeus `include`
 */

/**
 * Params of `ConsoleAmadeusApi.getQueue`: the Queue List parameters, verbatim.
 * @typedef {object} ConsoleAmadeusGetQueueParams
 * @property {number} queueId `queue-id`
 * @property {number} [max] `max`
 * @property {number} [category] `category` (default 0)
 * @property {string} [officeId] `officeId`
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Namespaces (inferred from the factory)                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/** `client.console.auth`: staff sign-in (portal token or portal credentials), refresh, sign-out, me. @typedef {ConsoleApi["auth"]} ConsoleAuthApi */
/** `client.console.bookings`: all bookings of the OTA, PNR lookup and import, Amadeus order management, resync, notes. @typedef {ConsoleApi["bookings"]} ConsoleBookingsApi */
/** `client.console.queues`: Amadeus office queues and stored queue snapshots. @typedef {ConsoleApi["queues"]} ConsoleQueuesApi */
/** `client.console.customers`: customers of the OTA with statistics and bookings. @typedef {ConsoleApi["customers"]} ConsoleCustomersApi */
/** `client.console.supplierRequests`: the redacted Amadeus call log. @typedef {ConsoleApi["supplierRequests"]} ConsoleSupplierRequestsApi */
/** `client.console.amadeus`: raw Amadeus pass-through (verbatim request and response), one method per Amadeus operation. @typedef {ConsoleApi["amadeus"]} ConsoleAmadeusApi */

/**
 * `client.console`: the staff console of the OTA. A secret key (or the OTA admin's service key) is required, so it
 * runs server-side only (server components, server actions, route handlers); console data is personal, priced or
 * live supplier data, so every method sends `cache: "no-store"` unless the call sets `cache` or `next`. With the
 * client option `environment`, every console request carries `X-Velexis-Environment`.
 * @typedef {ReturnType<typeof import("./namespaces/console.js").createConsoleApi>} ConsoleApi
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Additions to the contract (ota/sdk/docs/extensions.md §3.2 and §3.3)                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** A markup rule (`mkr_…`, `markup_rules`): turns Amadeus net prices into selling prices; may carry `warnings`. @typedef {import("./types.js").Schemas["MarkupRule"]} MarkupRule */
/** Body of `ConsoleSettingsMarkupRulesApi.create`: `name`, `scope`, `calculation` and the values it uses. @typedef {import("./types.js").Schemas["MarkupRuleInput"]} MarkupRuleInput */
/** Body of `ConsoleSettingsMarkupRulesApi.update`: any subset of `MarkupRuleInput`. @typedef {import("./types.js").Schemas["MarkupRuleUpdate"]} MarkupRuleUpdate */
/** A fee rule (`fee_…`, `fee_rules`): a service, card, ticketing, change, cancellation or extra fee; may carry `warnings`. @typedef {import("./types.js").Schemas["FeeRule"]} FeeRule */
/** Body of `ConsoleSettingsFeeRulesApi.create`: `name`, `label`, `feeType`, `scope`, `calculation` and its values. @typedef {import("./types.js").Schemas["FeeRuleInput"]} FeeRuleInput */
/** Body of `ConsoleSettingsFeeRulesApi.update`: any subset of `FeeRuleInput`. @typedef {import("./types.js").Schemas["FeeRuleUpdate"]} FeeRuleUpdate */
/** The storefront settings as staff edit them (`storefront_settings`, one row per OTA). @typedef {import("./types.js").Schemas["StorefrontSettings"]} StorefrontSettings */
/** Body of `ConsoleSettingsStorefrontApi.update`: whole sections of `StorefrontSettings`. @typedef {import("./types.js").Schemas["StorefrontSettingsUpdate"]} StorefrontSettingsUpdate */
/** Result of `ConsoleSettingsStorefrontApi.update`: the saved settings and `warnings`. @typedef {import("./types.js").Schemas["StorefrontSettingsUpdateResult"]} StorefrontSettingsUpdateResult */
/** A content page (`stp_…`, `storefront_pages`) as staff edit it, drafts included, with its Markdown body. @typedef {import("./types.js").Schemas["StorefrontPage"]} StorefrontPage */
/** Body of `ConsoleSettingsPagesApi.create`: `slug`, `locale`, `title` and the optional fields. @typedef {import("./types.js").Schemas["StorefrontPageInput"]} StorefrontPageInput */
/** Body of `ConsoleSettingsPagesApi.update`: any subset of `kind`, `title`, `bodyMarkdown`, `isPublished`, `showInFooter`, `sortOrder`. @typedef {import("./types.js").Schemas["StorefrontPageUpdate"]} StorefrontPageUpdate */
/** An uploaded storefront image (`ast_…`, `storefront_assets`) with its public `url`. @typedef {import("./types.js").Schemas["StorefrontAsset"]} StorefrontAsset */
/** What an image is for: `logo`, `logo_dark`, `logo_square`, `favicon`, `og_image`, `page_image`. @typedef {import("./types.js").Schemas["StorefrontAssetKind"]} StorefrontAssetKind */
/** The effective e-mail template of a key, channel and locale (the OTA's own or the code default). @typedef {import("./types.js").Schemas["NotificationTemplate"]} NotificationTemplate */
/** Result of `ConsoleSettingsTemplatesApi.list`: every effective template (`data`, not paginated). @typedef {import("./types.js").Schemas["NotificationTemplateList"]} NotificationTemplateList */
/** A notification template key of the MVP (`auth.verify_email`, `booking.confirmed`, `staff.manual_review` …). @typedef {import("./types.js").Schemas["NotificationTemplateKey"]} NotificationTemplateKey */
/** Delivery channel of a template: `email` in the MVP. @typedef {import("./types.js").Schemas["NotificationChannel"]} NotificationChannel */
/** Body of `ConsoleSettingsTemplatesApi.put`: `subject`, `bodyHtml`, `bodyText`, `isActive`. @typedef {import("./types.js").Schemas["NotificationTemplateInput"]} NotificationTemplateInput */
/** Body of `ConsoleSettingsTemplatesApi.preview`: a draft (`subject`, `bodyHtml`, `bodyText`) and `variables`, all optional. @typedef {import("./types.js").Schemas["NotificationTemplatePreviewRequest"]} NotificationTemplatePreviewRequest */
/** Result of `ConsoleSettingsTemplatesApi.preview`: `{ subject, html, text }`. @typedef {import("./types.js").Schemas["NotificationTemplatePreview"]} NotificationTemplatePreview */
/** A payment in console scope: `Payment` + environment, version, redacted events, refunds, booking and connection mode. @typedef {import("./types.js").Schemas["ConsolePayment"]} ConsolePayment */
/** Body of `ConsolePaymentsApi.capture`: optional `amount` (default: the whole authorisation) and `reason`. @typedef {import("./types.js").Schemas["ConsolePaymentCaptureRequest"]} ConsolePaymentCaptureRequest */
/** Body of `ConsolePaymentsApi.refund`: `amount`, `reason` category and optional `reasonNote`. @typedef {import("./types.js").Schemas["ConsolePaymentRefundRequest"]} ConsolePaymentRefundRequest */

/**
 * Params of `ConsoleSettingsMarkupRulesApi.list`.
 * @typedef {object} ConsoleListMarkupRulesParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 * @property {boolean} [active] `true`: only enabled rules; `false`: only disabled ones; absent: every rule
 */

/** Params of `ConsoleSettingsMarkupRulesApi.create`. @typedef {MarkupRuleInput} ConsoleCreateMarkupRuleParams */

/**
 * Identifies a markup rule (`ConsoleSettingsMarkupRulesApi.get`).
 * @typedef {object} ConsoleMarkupRuleRefParams
 * @property {string} markupRuleId markup rule id (`mkr_…`)
 */

/** Params of `ConsoleSettingsMarkupRulesApi.update`: the rule, `ifMatch` (its version or ETag) and the fields to change. @typedef {ConsoleMarkupRuleRefParams & { ifMatch: ConsoleIfMatch } & MarkupRuleUpdate} ConsoleUpdateMarkupRuleParams */
/** Params of `ConsoleSettingsMarkupRulesApi.delete`: the rule and `ifMatch`. @typedef {ConsoleMarkupRuleRefParams & { ifMatch: ConsoleIfMatch }} ConsoleDeleteMarkupRuleParams */

/**
 * Params of `ConsoleSettingsFeeRulesApi.list`.
 * @typedef {object} ConsoleListFeeRulesParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 * @property {boolean} [active] `true`: only enabled rules; `false`: only disabled ones; absent: every rule
 */

/** Params of `ConsoleSettingsFeeRulesApi.create`. @typedef {FeeRuleInput} ConsoleCreateFeeRuleParams */

/**
 * Identifies a fee rule (`ConsoleSettingsFeeRulesApi.get`).
 * @typedef {object} ConsoleFeeRuleRefParams
 * @property {string} feeRuleId fee rule id (`fee_…`)
 */

/** Params of `ConsoleSettingsFeeRulesApi.update`: the rule, `ifMatch` (its version or ETag) and the fields to change. @typedef {ConsoleFeeRuleRefParams & { ifMatch: ConsoleIfMatch } & FeeRuleUpdate} ConsoleUpdateFeeRuleParams */
/** Params of `ConsoleSettingsFeeRulesApi.delete`: the rule and `ifMatch`. @typedef {ConsoleFeeRuleRefParams & { ifMatch: ConsoleIfMatch }} ConsoleDeleteFeeRuleParams */
/** Params of `ConsoleSettingsStorefrontApi.get` (none). @typedef {Record<string, never>} ConsoleGetStorefrontSettingsParams */
/** Params of `ConsoleSettingsStorefrontApi.update`: `ifMatch` (the settings' version or ETag) and the sections to replace. @typedef {{ ifMatch: ConsoleIfMatch } & StorefrontSettingsUpdate} ConsoleUpdateStorefrontSettingsParams */

/**
 * Params of `ConsoleSettingsPagesApi.list`.
 * @typedef {object} ConsoleListStorefrontPagesParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 * @property {string} [locale] only the pages of this locale (BCP 47, such as `en`)
 * @property {boolean} [published] `true`: only published pages; `false`: only drafts; absent: every page
 */

/** Params of `ConsoleSettingsPagesApi.create`. @typedef {StorefrontPageInput} ConsoleCreateStorefrontPageParams */

/**
 * Identifies a content page (`ConsoleSettingsPagesApi.get`).
 * @typedef {object} ConsoleStorefrontPageRefParams
 * @property {string} pageId content page id (`stp_…`)
 */

/** Params of `ConsoleSettingsPagesApi.update`: the page, `ifMatch` (its version or ETag) and the fields to change. @typedef {ConsoleStorefrontPageRefParams & { ifMatch: ConsoleIfMatch } & StorefrontPageUpdate} ConsoleUpdateStorefrontPageParams */
/** Params of `ConsoleSettingsPagesApi.delete`: the page and `ifMatch`. @typedef {ConsoleStorefrontPageRefParams & { ifMatch: ConsoleIfMatch }} ConsoleDeleteStorefrontPageParams */

/**
 * Params of `ConsoleSettingsAssetsApi.list`.
 * @typedef {object} ConsoleListStorefrontAssetsParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 * @property {StorefrontAssetKind} [kind] only the assets of this kind
 */

/**
 * Params of `ConsoleSettingsAssetsApi.upload` (`StorefrontAssetUpload`, sent as `multipart/form-data`).
 * @typedef {object} ConsoleUploadStorefrontAssetParams
 * @property {Blob} file the image, a `Blob` or `File`: PNG, JPEG or WebP (ICO for a `favicon`), at most 1 MB, never SVG
 * @property {StorefrontAssetKind} kind what the image is for
 * @property {string} [fileName] the name shown in the console (1 to 200 characters); by default the name of the `file`
 *   part (a `File`'s own name, `blob` for a plain `Blob`)
 */

/**
 * Params of `ConsoleSettingsAssetsApi.delete`.
 * @typedef {object} ConsoleDeleteStorefrontAssetParams
 * @property {string} assetId asset id (`ast_…`)
 */

/** Params of `ConsoleSettingsTemplatesApi.list` (none). @typedef {Record<string, never>} ConsoleListNotificationTemplatesParams */

/**
 * Identifies a notification template (`ConsoleSettingsTemplatesApi.get`, `.reset`).
 * @typedef {object} ConsoleNotificationTemplateRefParams
 * @property {NotificationTemplateKey} templateKey the template key, such as `booking.confirmed`
 * @property {NotificationChannel} channel the channel (`email`)
 * @property {string} locale the locale (BCP 47, one of the storefront's supported locales)
 */

/**
 * Params of `ConsoleSettingsTemplatesApi.put`: the template, `ifMatch` (its version or ETag) when the OTA already has
 * its own template (leave it out when it has none), and the template.
 * @typedef {ConsoleNotificationTemplateRefParams & { ifMatch?: ConsoleIfMatch } & NotificationTemplateInput} ConsolePutNotificationTemplateParams
 */

/** Params of `ConsoleSettingsTemplatesApi.preview`: the template and an optional draft and render data. @typedef {ConsoleNotificationTemplateRefParams & NotificationTemplatePreviewRequest} ConsolePreviewNotificationTemplateParams */

/**
 * Params of `ConsolePaymentsApi.list`. `status`, `provider` and `method` take one value or several (sent
 * comma-separated, OR-ed); the filters are AND-ed.
 * @typedef {object} ConsoleListPaymentsParams
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size (at most 100)
 * @property {import("./bookings.js").PaymentStatus | import("./bookings.js").PaymentStatus[]} [status] payment statuses, e.g. `["authorized", "captured"]`
 * @property {import("./bookings.js").PaymentProvider | import("./bookings.js").PaymentProvider[]} [provider] providers (`stripe`; `airline` for airline-card payments)
 * @property {import("./bookings.js").Payment["method"] | import("./bookings.js").Payment["method"][]} [method] payment methods
 * @property {string} [bookingId] payments of this booking (`bkg_…`)
 * @property {string} [createdFrom] created at or after (ISO-8601)
 * @property {string} [createdTo] created before (ISO-8601)
 */

/**
 * Params of `ConsolePaymentsApi.get`.
 * @typedef {object} ConsoleGetPaymentParams
 * @property {string} paymentId payment id (`pay_…`)
 * @property {boolean} [refresh] read the PaymentIntent from Stripe first and apply its state
 */

/**
 * Identifies a payment.
 * @typedef {object} ConsolePaymentRefParams
 * @property {string} paymentId payment id (`pay_…`)
 */

/** Params of `ConsolePaymentsApi.capture`: the payment, `ifMatch` (its version or ETag), `amount?` and `reason`. @typedef {ConsolePaymentRefParams & { ifMatch: ConsoleIfMatch } & ConsolePaymentCaptureRequest} ConsoleCapturePaymentParams */
/** Params of `ConsolePaymentsApi.refund`: the payment, `amount`, `reason` and `reasonNote?`. @typedef {ConsolePaymentRefParams & ConsolePaymentRefundRequest} ConsoleRefundPaymentParams */

/** `client.console.settings`: markup and fee rules, storefront settings, content pages, storefront images and e-mail templates. @typedef {ConsoleApi["settings"]} ConsoleSettingsApi */
/** `client.console.settings.markupRules`: list, create, get, update, delete. @typedef {ConsoleSettingsApi["markupRules"]} ConsoleSettingsMarkupRulesApi */
/** `client.console.settings.feeRules`: list, create, get, update, delete. @typedef {ConsoleSettingsApi["feeRules"]} ConsoleSettingsFeeRulesApi */
/** `client.console.settings.storefront`: get, update. @typedef {ConsoleSettingsApi["storefront"]} ConsoleSettingsStorefrontApi */
/** `client.console.settings.pages`: list, create, get, update, delete. @typedef {ConsoleSettingsApi["pages"]} ConsoleSettingsPagesApi */
/** `client.console.settings.assets`: list, upload, delete. @typedef {ConsoleSettingsApi["assets"]} ConsoleSettingsAssetsApi */
/** `client.console.settings.templates`: list, get, put, preview, reset. @typedef {ConsoleSettingsApi["templates"]} ConsoleSettingsTemplatesApi */
/** `client.console.payments`: list, get, capture, refund. @typedef {ConsoleApi["payments"]} ConsolePaymentsApi */
