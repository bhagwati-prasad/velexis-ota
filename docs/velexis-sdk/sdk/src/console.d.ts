/**
 * @velexis/ota-sdk — `console` namespace (area B4: the OTA staff console).
 *
 * Everything an Amadeus-like back office needs, scoped to one OTA (tenant) and one environment (test / live keys):
 * - `console.auth` — staff sign-in with portal credentials (+ TOTP) or a portal token exchange, refresh, sign-out, me.
 * - `console.bookings` — ALL bookings of the OTA (filters, sort, pagination), full detail with net prices, markup and
 *   supplier sync state, PNR lookup by record locator + import of existing Amadeus orders, verbatim Amadeus order
 *   retrieve, create on behalf of a customer (full Flight Create Orders body), Flight Order Management PATCH of every
 *   patchable element, issuance, cancellation, resync and internal notes.
 * - `console.queues` — Amadeus office queues (Queue List) with stored snapshots.
 * - `console.customers` — the OTA's customer accounts with statistics and bookings.
 * - `console.supplierRequests` — the redacted Amadeus call log (troubleshooting).
 * - `console.amadeus` — RAW pass-through, one method per Amadeus operation, verbatim Amadeus request/response
 *   (`Amadeus*` schemas) so every Amadeus parameter and body field is reachable.
 * Normal shopping in the console reuses `flights.*` (search, availability, upsell, price) with the staff token.
 *
 * Keys, tokens, where to call
 * - Every console method needs a **secret key** (`sk_test_…` / `sk_live_…`) and therefore runs **server-side only**:
 *   Next.js server components, server actions and route handlers. A publishable key → `PermissionError`
 *   `SCOPE_NOT_ALLOWED`. Never import a console client into a client component — call a server action instead.
 * - **Key scopes** ({@link ConsoleApiKeyScope} = `platform.api_keys.scopes`, set in the Velexis portal): a key scoped
 *   `storefront` is refused on every console method (`SCOPE_NOT_ALLOWED`, even with a staff token); `console` allows
 *   console calls **with a staff token**; only `console:automation` allows calls **without** one, and those act with
 *   exactly the {@link StaffPermission}s listed in the key's scopes (nothing implied, never "all permissions").
 *   Recommended keys: storefront deployment `sk_…` scoped `storefront`; console deployment `sk_…` scoped `console`;
 *   one `console:automation` key per automation job with the minimum permissions (e.g. `bookings:read`).
 * - Staff identity: the staff access token from {@link ConsoleAuthApi.signIn} (15 min, refresh with
 *   {@link ConsoleAuthApi.refresh}); keep access and refresh tokens in httpOnly cookies and build console clients with
 *   `sessionKind: "staff"` (`createServerClient({ as: "staff" })` does) so the SDK's automatic refresh calls the
 *   console endpoint. A key-only call from a key without `console:automation` → `PermissionError` `SCOPE_NOT_ALLOWED`
 *   (`details.requiredScope`); automation calls are attributed to the API key in the audit log.
 * - Server actions are public POST endpoints: every console server action starts with
 *   `await requireStaff({ permissions: [...] })` (`@velexis/ota-sdk/next`), and console clients must never fall back to
 *   the secret key alone when the staff cookie is missing (the helper below throws `UNAUTHENTICATED` instead).
 * - Roles → permissions (see {@link StaffPermission}): owner/admin everything; agent all but raw Amadeus writes;
 *   finance read + supplier log; viewer read-only. Missing permission → `PermissionError` `FORBIDDEN`
 *   (`details.requiredPermission`).
 *
 * Caching: console data is personal, priced and changes constantly — the SDK sends `cache: "no-store"` for every
 * console call; never pass `next.revalidate`. After a mutation call `revalidatePath()` for the pages you rendered.
 * State-changing POSTs get an `Idempotency-Key` automatically (pass `options.idempotencyKey` to tie retries of one
 * user action together, e.g. one key per "Issue" button click). Updates of a booking need `ifMatch` = the booking
 * `version` you displayed (stale → `VelexisError` `PRECONDITION_FAILED`, 412).
 *
 * The examples assume a small server-only helper — the `@velexis/ota-sdk/next` staff client (staff cookies,
 * `sessionKind: "staff"`, rotated tokens written back) which throws `AuthenticationError` `UNAUTHENTICATED` locally when
 * there is no staff cookie, so a console call never goes out with the secret key alone:
 * ```ts
 * // lib/console.ts  (server only)
 * import "server-only";
 * import { createServerClient } from "@velexis/ota-sdk/next";
 * export async function consoleServer() {
 *   return (await createServerClient({ as: "staff" })).console;
 * }
 * ```
 * Without the Next.js helpers, guard explicitly before creating the client:
 * ```ts
 * const accessToken = jar.get("vx_staff_at")?.value, refreshToken = jar.get("vx_staff_rt")?.value;
 * if (!accessToken && !refreshToken) throw new AuthenticationError({ code: "UNAUTHENTICATED", message: "Staff session required", status: 401 });
 * const con = createVelexisClient({ secretKey: process.env.VELEXIS_CONSOLE_SECRET_KEY!, accessToken, refreshToken, sessionKind: "staff" }).console;
 * ```
 * Server actions additionally start with `await requireStaff({ permissions: [...] })` from `@velexis/ota-sdk/next`.
 */
import type { Schemas, RequestOptions, Page, ListParams, WithWarnings, Money } from "./shared";

/* ------------------------------------------------------------------------------------------------------------ */
/* Client options for staff sessions (augments VelexisClientOptions of ./shared)                                 */
/* ------------------------------------------------------------------------------------------------------------ */

declare module "./shared" {
  interface VelexisClientOptions {
    /**
     * Which session `accessToken` / `refreshToken` belong to. Refresh tokens are opaque, so this option decides the
     * automatic refresh after `TOKEN_EXPIRED`: `"customer"` (default) → `auth.refresh` (`POST /v1/auth/refresh`);
     * `"staff"` → {@link ConsoleAuthApi.refresh} (`POST /v1/console/auth/refresh`, result {@link ConsoleStaffSession}).
     * A refresh token of the other kind is rejected (`REFRESH_TOKEN_INVALID` → `onSessionExpired`). For both kinds
     * `onSessionRefreshed` receives the new tokens (`result.session`); for `"staff"`,
     * {@link VelexisClientOptions.onStaffSessionRefreshed} also receives the whole {@link ConsoleStaffSession} (current
     * role and permissions — role changes apply at refresh). `createServerClient({ as: "staff" })` of
     * `@velexis/ota-sdk/next` sets `"staff"`.
     */
    sessionKind?: "customer" | "staff";
    /** With `sessionKind: "staff"`: called after an automatic staff refresh with the full result (tokens, staff member, tenant, updated permissions). */
    onStaffSessionRefreshed?: (result: ConsoleStaffSession) => void | Promise<void>;
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Schema aliases                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** Console role of a staff member: `owner` | `admin` | `agent` | `finance` | `viewer`. */
export type StaffRole = Schemas["StaffRole"];
/** Permission derived from the role (e.g. `bookings:issue`, `amadeus:write`); automation keys list theirs in their scopes. */
export type StaffPermission = Schemas["StaffPermission"];
/**
 * Scope of a secret key on `/v1/console/**` (`platform.api_keys.scopes`): `storefront` (console refused),
 * `console` (staff token required) or `console:automation` (key-only calls allowed, with the {@link StaffPermission}s
 * listed next to it in the key's scopes).
 */
export type ConsoleApiKeyScope = Schemas["ConsoleApiKeyScope"];
/** A staff member of the OTA (portal account + membership, id `stf_…`). */
export type StaffMember = Schemas["StaffMember"];
/** The OTA, its environment (test/live) and its configured Amadeus offices. */
export type ConsoleTenant = Schemas["ConsoleTenant"];
/** Result of sign-in / refresh: tokens (`session`), staff member, tenant, permissions. */
export type ConsoleStaffSession = Schemas["ConsoleStaffSession"];
/** Result of {@link ConsoleAuthApi.me}. */
export type ConsoleStaffProfile = Schemas["ConsoleStaffProfile"];

/** A booking in console scope: the customer `Booking` + console-only details (net, markup, sync, audit, actions). */
export type ConsoleBooking = Schemas["ConsoleBooking"];
/** Console-only part of {@link ConsoleBooking}. */
export type ConsoleBookingDetails = Schemas["ConsoleBookingDetails"];
/** Row of {@link ConsoleBookingsApi.list}. */
export type ConsoleBookingSummary = Schemas["ConsoleBookingSummary"];
/** `pending` | `confirmed` | `ticketed` | `partially_ticketed` | `cancelled` | `failed`. */
export type ConsoleBookingStatus = Schemas["BookingStatus"];
/** Ticketing status (`pending`, `in_progress`, `issued`, `partially_issued`, `failed`, `manual_review`, `not_applicable`). */
export type ConsoleTicketingStatus = Schemas["IssuanceStatus"];
/** Derived payment state (`unpaid`, `authorized`, `paid`, `partially_refunded`, `refunded`, `failed`, `not_applicable`). */
export type ConsolePaymentStatus = Schemas["ConsolePaymentStatus"];
/** Net cost, markup, fees, selling total and margin of a booking. */
export type ConsoleBookingPricing = Schemas["ConsoleBookingPricing"];
/** Synchronisation state with Amadeus (last sync, error, detected differences). */
export type ConsoleSupplierSync = Schemas["ConsoleSupplierSync"];
/**
 * One sync-status vocabulary for the list row (`ConsoleBookingSummary.syncStatus`) and the detail
 * (`ConsoleSupplierSync.status`): `refreshed` | `fresh` | `stale` | `throttled` | `failed` | `order_not_found` |
 * `not_applicable` — a superset of the customer `Booking.syncStatus` (same meaning for shared values; the inherited
 * `ConsoleBooking.syncStatus` shows `order_not_found` as `failed` and `not_applicable` as `fresh`).
 */
export type ConsoleBookingSyncStatus = Schemas["ConsoleBookingSyncStatus"];
/** `error.details` of `SUPPLIER_TIMEOUT` (504) from {@link ConsoleBookingsApi.create}: the pending booking that was kept. */
export type ConsoleBookingTimeoutDetails = Schemas["ConsoleBookingTimeoutDetails"];
/**
 * An Amadeus flight offer as console request bodies accept it: `AmadeusFlightOffer` + `fareDetailsBySegment[].fareType`
 * and the complete `additionalServices` (incl. `chargeableCabinBags`). Any `AmadeusFlightOffer` is assignable to it.
 */
export type ConsoleAmadeusFlightOffer = Schemas["ConsoleAmadeusFlightOffer"];
/** Complete Amadeus `additionalServices`: chargeable checked bags, cabin bags, seat (+ deprecated seat number), other services. */
export type ConsoleAmadeusAdditionalServices = Schemas["ConsoleAmadeusAdditionalServices"];
/** One difference detected by a sync (JSON pointer, label, before, after). */
export type ConsoleSyncChange = Schemas["ConsoleSyncChange"];
/** Redacted form of payment of an order. */
export type ConsoleFormOfPayment = Schemas["ConsoleFormOfPayment"];
/** Who did something (staff, API key, system, customer, supplier). */
export type ConsoleActor = Schemas["ConsoleActor"];
/** Internal note of a booking. */
export type ConsoleBookingNote = Schemas["ConsoleBookingNote"];
/** Timeline entry as staff see it (incl. events hidden from customers). */
export type ConsoleBookingEvent = Schemas["ConsoleBookingEvent"];
/** Audit row (staff_actions). */
export type ConsoleStaffAction = Schemas["ConsoleStaffAction"];
/** Console actions the caller may perform now (+ reasons). */
export type ConsoleBookingActions = Schemas["ConsoleBookingActions"];
/** Result of {@link ConsoleBookingsApi.resync}. */
export type ConsoleBookingResyncResult = Schemas["ConsoleBookingResyncResult"];
/** Result of {@link ConsoleBookingsApi.retrieve}: verbatim Amadeus order + call info. */
export type ConsoleFlightOrderRetrieval = Schemas["ConsoleFlightOrderRetrieval"];
/** Information about the Amadeus call behind a console response (supplier request id, status, latency …). */
export type ConsoleAmadeusCall = Schemas["ConsoleAmadeusCall"];
/** Verbatim Amadeus flight-order response (`meta`, `warnings`, `data`, `included`, `dictionaries`). */
export type ConsoleAmadeusFlightOrderReply = Schemas["ConsoleAmadeusFlightOrderReply"];
/** One logged Amadeus call (supplier_requests). */
export type ConsoleSupplierRequest = Schemas["ConsoleSupplierRequest"];

/** Result of {@link ConsoleBookingsApi.findByRecordLocator}. */
export type PnrLookupResult = Schemas["PnrLookupResult"];
/** One flight order matching a record locator (summary + verbatim order + link to this OTA's booking). */
export type PnrMatch = Schemas["PnrMatch"];
/** Normalised summary of an Amadeus order. */
export type PnrOrderSummary = Schemas["PnrOrderSummary"];

/** One PNR on an office queue (wraps the verbatim Amadeus PNR item). */
export type QueueItem = Schemas["QueueItem"];
/** A stored Queue List read (`qsn_…`). */
export type QueueSnapshot = Schemas["QueueSnapshot"];

/** Customer row of {@link ConsoleCustomersApi.list}. */
export type ConsoleCustomerSummary = Schemas["ConsoleCustomerSummary"];
/** Result of {@link ConsoleCustomersApi.get}. */
export type ConsoleCustomer = Schemas["ConsoleCustomer"];
/** Booking statistics of a customer. */
export type ConsoleCustomerStats = Schemas["ConsoleCustomerStats"];

/** Result of the raw Flight Offers Search methods. */
export type ConsoleAmadeusFlightOffersResult = Schemas["ConsoleAmadeusFlightOffersResult"];
/** Result of the raw Flight Availabilities Search. */
export type ConsoleAmadeusAvailabilitiesResult = Schemas["ConsoleAmadeusAvailabilitiesResult"];
/** Result of the raw Branded Fares Upsell. */
export type ConsoleAmadeusUpsellResult = Schemas["ConsoleAmadeusUpsellResult"];
/** Result of the raw Flight Offers Price. */
export type ConsoleAmadeusPricingResult = Schemas["ConsoleAmadeusPricingResult"];
/** Result of the raw flight-order operations (create, issue, get, patch). */
export type ConsoleAmadeusFlightOrderResult = Schemas["ConsoleAmadeusFlightOrderResult"];
/** Result of the raw Get Flight Order By Record Locator. */
export type ConsoleAmadeusFlightOrdersByReferenceResult = Schemas["ConsoleAmadeusFlightOrdersByReferenceResult"];
/** Result of the raw Queue List. */
export type ConsoleAmadeusQueueResult = Schemas["ConsoleAmadeusQueueResult"];
/** Result of the raw Flight Order Management DELETE. */
export type ConsoleAmadeusCancelResult = Schemas["ConsoleAmadeusCancelResult"];

/* ------------------------------------------------------------------------------------------------------------ */
/* Parameters                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Optimistic-locking value for `If-Match`: the booking `version` (number, sent as `"<n>"`) or the raw `ETag` header
 * value (string, e.g. `"3"`).
 */
export type ConsoleIfMatch = number | string;

/** Amadeus `include` of flight-order reads: `bags` adds the extra bag options (`included.bags`). */
export type ConsoleOrderInclude = Array<"bags">;
/** Amadeus `fareRules` of Flight Order Management GET: rebooking and/or refund eligibility. */
export type ConsoleOrderFareRules = Array<"rebooks" | "refunds">;

/** Params of {@link ConsoleAuthApi.signIn}: portal credentials (+ `mfaCode`) or a one-time portal token. */
export type ConsoleSignInParams = Schemas["ConsoleSignInRequest"];
/** Params of {@link ConsoleAuthApi.refresh}. */
export type ConsoleRefreshParams = Schemas["ConsoleRefreshRequest"];
/** Params of {@link ConsoleAuthApi.signOut}. */
export type ConsoleSignOutParams = Schemas["ConsoleSignOutRequest"];
/** Params of {@link ConsoleAuthApi.me} (none). */
export type ConsoleMeParams = Record<string, never>;

/** Sort orders of {@link ConsoleBookingsApi.list}. */
export type ConsoleBookingSort = "created" | "-created" | "departure" | "-departure" | "ticketingDeadline" | "-ticketingDeadline" | "total" | "-total";

/** Params of {@link ConsoleBookingsApi.list}. List values are sent comma-separated and OR-ed; filters are AND-ed. */
export interface ConsoleListBookingsParams extends ListParams {
  /** Booking statuses, e.g. `["confirmed", "partially_ticketed"]`. */
  status?: ConsoleBookingStatus[];
  /** Ticketing statuses, e.g. `["failed", "manual_review"]`. */
  ticketingStatus?: ConsoleTicketingStatus[];
  /** Only bookings whose ticketing deadline is before this ISO-8601 instant (the "to issue" work list). */
  ticketingDeadlineBefore?: string;
  /** Main record locator or any associated (airline) locator. */
  recordLocator?: string;
  /** Velexis booking reference. */
  reference?: string;
  /** Bookings of this customer (`cus_…`). */
  customerId?: string;
  /** Customer or booking-contact e-mail (exact, case-insensitive). */
  customerEmail?: string;
  /** Prefix of any traveller's last name (≥ 2 characters). */
  travelerLastName?: string;
  /** First departure on/after this local date (YYYY-MM-DD). */
  departureFrom?: string;
  /** First departure on/before this local date (YYYY-MM-DD). */
  departureTo?: string;
  /** Created at/after (ISO-8601). */
  createdFrom?: string;
  /** Created before (ISO-8601). */
  createdTo?: string;
  /** Derived payment states. */
  paymentStatus?: ConsolePaymentStatus[];
  /** Channels the booking came from. */
  source?: Array<"storefront" | "console" | "import">;
  /** Validating airline (IATA). */
  validatingCarrier?: string;
  /** Created/imported by this staff member (`stf_…`). */
  createdByStaffId?: string;
  /** Staff tag. */
  tag?: string;
  /** Free text: reference, record locator, contact e-mail or lead last name. */
  q?: string;
  /** Sort (default `-created`). */
  sort?: ConsoleBookingSort;
}

/** Page returned by {@link ConsoleBookingsApi.list} (`totalCount` exact up to 10 000, else null). */
export type ConsoleBookingPage = Page<ConsoleBookingSummary> & { totalCount?: number | null };

/** Identifies a booking. */
export interface ConsoleBookingRefParams {
  /** Booking id (`bkg_…`). */
  bookingId: string;
}

/** Params of {@link ConsoleBookingsApi.get}. */
export interface ConsoleGetBookingParams extends ConsoleBookingRefParams {
  /** Synchronise with Amadeus Flight Order Management GET first (throttled to 1 per 10 s per booking). */
  refresh?: boolean;
  /** With `refresh`: Amadeus `include`. */
  include?: ConsoleOrderInclude;
  /** With `refresh`: Amadeus `fareRules` (fills `fareRules`). */
  fareRules?: ConsoleOrderFareRules;
}

/** Params of {@link ConsoleBookingsApi.findByRecordLocator}. */
export interface ConsoleFindByRecordLocatorParams {
  /** Record locator (Amadeus or other airline), e.g. `"L2P9XC"`. */
  reference: string;
  /** Amadeus `originSystemCode`; the SDK sends `"GDS"` when omitted (the only value Amadeus supports today). */
  originSystemCode?: string;
  /** Amadeus `include` (`["bags"]`). */
  include?: ConsoleOrderInclude;
}

/** Params of {@link ConsoleBookingsApi.import}. */
export type ConsoleImportBookingParams = Schemas["ConsoleBookingImportRequest"];

/** Params of {@link ConsoleBookingsApi.retrieve}. */
export interface ConsoleRetrieveFlightOrderParams extends ConsoleBookingRefParams {
  /** Amadeus `include` (`["bags"]`). */
  include?: ConsoleOrderInclude;
  /** Amadeus `fareRules` (`["rebooks"]`, `["refunds"]` or both). */
  fareRules?: ConsoleOrderFareRules;
  /** Store the response as the booking's order snapshot (default true). */
  updateSnapshot?: boolean;
}

/**
 * Params of {@link ConsoleBookingsApi.create}: a priced offer (`prc_…`) + the full Flight Create Orders data
 * (travelers, contacts, remarks, ticketingAgreement, automatedProcess, formOfPayments, queuingOfficeId,
 * ownerOfficeId, commissions, formOfIdentifications, issue) + Velexis options (pricing mode, expected totals, tags…).
 */
export type ConsoleCreateBookingParams = Schemas["ConsoleBookingCreateRequest"];

/**
 * Params of {@link ConsoleBookingsApi.patch}: booking, `ifMatch`, the Flight Order Management PATCH elements, the merge
 * options (`mergeTravelers`, `mergeRemarks`, `mergeContacts` — all default true) and the local-only `tags` / `metadata`.
 */
export type ConsolePatchBookingParams = ConsoleBookingRefParams & {
  /** Booking version / ETag you displayed. */
  ifMatch: ConsoleIfMatch;
} & Schemas["ConsoleBookingPatchRequest"];

/** Params of {@link ConsoleBookingsApi.issue}. */
export type ConsoleIssueBookingParams = ConsoleBookingRefParams & {
  /** Booking version / ETag you displayed. */
  ifMatch: ConsoleIfMatch;
} & Schemas["ConsoleBookingIssueRequest"];

/** Params of {@link ConsoleBookingsApi.cancel}. */
export type ConsoleCancelBookingParams = ConsoleBookingRefParams & {
  /** Booking version / ETag you displayed. */
  ifMatch: ConsoleIfMatch;
} & Schemas["ConsoleBookingCancelRequest"];

/** Refund instruction of {@link ConsoleBookingsApi.cancel}. */
export interface ConsoleCancelRefund {
  /** `none`, `full` captured amount, or `amount`. */
  mode: "none" | "full" | "amount";
  /** Amount to refund for mode `amount` (≤ captured). */
  amount?: Money;
}

/** Params of {@link ConsoleBookingsApi.resync}. */
export type ConsoleResyncBookingParams = ConsoleBookingRefParams & Schemas["ConsoleBookingResyncRequest"];

/** Params of {@link ConsoleBookingsApi.addNote}. */
export type ConsoleAddBookingNoteParams = ConsoleBookingRefParams & Schemas["ConsoleBookingNoteRequest"];

/** Params of {@link ConsoleQueuesApi.list}. Without `cursor` Amadeus is called and a snapshot stored; with `cursor` the stored snapshot is paged. */
export interface ConsoleListQueueParams extends ListParams {
  /** Amadeus queue number (`queue-id`), e.g. `50`. */
  queueId: number;
  /** Queue category (Amadeus default 0). */
  category?: number;
  /** Office id (default: the OTA's queuing office); must be configured on the OTA's Amadeus connection. */
  officeId?: string;
  /** Maximum number of PNRs Amadeus returns (`max`). */
  max?: number;
}

/** Page returned by {@link ConsoleQueuesApi.list}: PNR items + the snapshot they come from + Amadeus warnings. */
export type ConsoleQueuePage = Page<QueueItem> & WithWarnings & { snapshot: QueueSnapshot };

/** Params of {@link ConsoleQueuesApi.listSnapshots}. */
export interface ConsoleListQueueSnapshotsParams extends ListParams {
  /** Queue number. */
  queueId?: number;
  /** Office id. */
  officeId?: string;
  /** Category. */
  category?: number;
  /** Taken at/after (ISO-8601). */
  fetchedFrom?: string;
  /** Taken before (ISO-8601). */
  fetchedTo?: string;
  /** `["items"]` adds the PNR items of each snapshot. */
  include?: Array<"items">;
}

/** Params of {@link ConsoleCustomersApi.list}. */
export interface ConsoleListCustomersParams extends ListParams {
  /** Prefix of e-mail, first or last name. */
  q?: string;
  /** Exact e-mail. */
  email?: string;
  /** Account statuses (default active + disabled). */
  status?: Array<"active" | "disabled" | "deleted">;
  /** Only verified / unverified e-mails. */
  emailVerified?: boolean;
  /** Only customers with / without bookings. */
  hasBookings?: boolean;
  /** Signed up at/after (ISO-8601). */
  createdFrom?: string;
  /** Signed up before (ISO-8601). */
  createdTo?: string;
  /** Sort (default `-created`). */
  sort?: "-created" | "created" | "name" | "-lastBooking" | "-totalSpent";
}

/** Params of {@link ConsoleCustomersApi.get}. */
export interface ConsoleGetCustomerParams {
  /** Customer id (`cus_…`). */
  customerId: string;
}

/** Amadeus APIs as logged in supplier_requests. */
export type ConsoleAmadeusApiName = Schemas["ConsoleSupplierRequest"]["amadeusApi"];

/** Params of {@link ConsoleSupplierRequestsApi.list}. */
export interface ConsoleListSupplierRequestsParams extends ListParams {
  /** Calls for this booking. */
  bookingId?: string;
  /** Calls for this flight search (`srch_…`). */
  searchId?: string;
  /** Amadeus APIs. */
  amadeusApi?: ConsoleAmadeusApiName[];
  /** Amadeus operationId, e.g. `"createFligtOrders"`. */
  amadeusOperationId?: string;
  /** Outcomes. */
  outcome?: Array<"success" | "client_error" | "server_error" | "timeout" | "network_error">;
  /** Amadeus HTTP status. */
  httpStatus?: number;
  /** Amadeus error code, e.g. `4926`. */
  errorCode?: number;
  /** Triggered by this staff member. */
  staffId?: string;
  /** Velexis `X-Request-Id` (e.g. `VelexisError.requestId` of a failed call). */
  requestId?: string;
  /** Amadeus `ama-request-id`. */
  correlationId?: string;
  /** Called at/after (ISO-8601). */
  createdFrom?: string;
  /** Called before (ISO-8601). */
  createdTo?: string;
  /** Add redacted request/response bodies (`limit` ≤ 20). */
  includeBodies?: boolean;
}

/** Params of {@link ConsoleAmadeusApi.searchFlightOffers}: `{ amadeus: getFlightOffersQuery, bookingId?, reason? }`. */
export type ConsoleAmadeusSearchFlightOffersParams = Schemas["ConsoleAmadeusFlightOffersSearchRequest"];

/** Params of {@link ConsoleAmadeusApi.getFlightOffers} — the Amadeus GET query parameters, verbatim. */
export interface ConsoleAmadeusGetFlightOffersParams {
  /** City/airport IATA code of departure. */
  originLocationCode: string;
  /** City/airport IATA code of destination. */
  destinationLocationCode: string;
  /** Departure date (YYYY-MM-DD). */
  departureDate: string;
  /** Return date (round trips only). */
  returnDate?: string;
  /** Adults (12+), 1–9. */
  adults: number;
  /** Children (2–11). */
  children?: number;
  /** Infants (≤ 2) on lap, ≤ adults. */
  infants?: number;
  /** Minimum cabin. */
  travelClass?: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  /** Airlines to include (array or comma-separated string). */
  includedAirlineCodes?: string[] | string;
  /** Airlines to exclude (array or comma-separated string). */
  excludedAirlineCodes?: string[] | string;
  /** Non-stop only. */
  nonStop?: boolean;
  /** Preferred currency (ISO 4217). */
  currencyCode?: string;
  /** Maximum price per traveller (integer). */
  maxPrice?: number;
  /** Maximum number of offers (default 250). */
  max?: number;
}

/** Params of {@link ConsoleAmadeusApi.searchFlightAvailabilities}: `{ amadeus: getFlightAvailabilitiesQuery, … }`. */
export type ConsoleAmadeusSearchFlightAvailabilitiesParams = Schemas["ConsoleAmadeusAvailabilitiesRequest"];
/** Params of {@link ConsoleAmadeusApi.upsellAirOffers}: `{ amadeus: { data: FlightOfferUpsellIn }, … }`. */
export type ConsoleAmadeusUpsellAirOffersParams = Schemas["ConsoleAmadeusUpsellRequest"];

/** Amadeus `include` of Flight Offers Price. */
export type ConsoleAmadeusPricingInclude = Array<"credit-card-fees" | "bags" | "other-services" | "detailed-fare-rules">;

/** Params of {@link ConsoleAmadeusApi.quoteAirOffers}: body `{ amadeus: { data: FlightOfferPricingIn } }` + Amadeus query `include` / `forceClass`. */
export type ConsoleAmadeusQuoteAirOffersParams = Schemas["ConsoleAmadeusPricingRequest"] & {
  /** Amadeus `include` (sent comma-separated). */
  include?: ConsoleAmadeusPricingInclude;
  /** Amadeus `forceClass`. */
  forceClass?: boolean;
};

/** Params of {@link ConsoleAmadeusApi.createFlightOrders}: body `{ amadeus: { data: FlightOrder }, importAsBooking?, … }` + Amadeus `issue`. */
export type ConsoleAmadeusCreateFlightOrdersParams = Schemas["ConsoleAmadeusCreateOrderRequest"] & {
  /** Amadeus `issue` query flag (force issuance at booking time). */
  issue?: boolean;
};

/** Identifies an Amadeus flight order. */
export interface ConsoleFlightOrderRefParams {
  /** Amadeus flight-order id (`data.id`). */
  flightOrderId: string;
}

/** Params of {@link ConsoleAmadeusApi.issueFlightOrder}. */
export type ConsoleAmadeusIssueFlightOrderParams = ConsoleFlightOrderRefParams & Schemas["ConsoleAmadeusIssueRequest"];

/** Params of {@link ConsoleAmadeusApi.getFlightOrder}. */
export interface ConsoleAmadeusGetFlightOrderParams extends ConsoleFlightOrderRefParams {
  /** Amadeus `include`. */
  include?: ConsoleOrderInclude;
  /** Amadeus `fareRules`. */
  fareRules?: ConsoleOrderFareRules;
}

/** Params of {@link ConsoleAmadeusApi.patchFlightOrder}: `{ flightOrderId, amadeus: { data: partial FlightOrder }, reason? }`. */
export type ConsoleAmadeusPatchFlightOrderParams = ConsoleFlightOrderRefParams & Schemas["ConsoleAmadeusPatchOrderRequest"];

/** Params of {@link ConsoleAmadeusApi.cancelFlightOrder}. */
export interface ConsoleAmadeusCancelFlightOrderParams extends ConsoleFlightOrderRefParams {
  /** Audit justification (required). */
  reason: string;
}

/** Params of {@link ConsoleAmadeusApi.getFlightOrderByReference}. */
export interface ConsoleAmadeusGetFlightOrderByReferenceParams {
  /** Record locator. */
  reference: string;
  /** Amadeus `originSystemCode` (SDK default `"GDS"`). */
  originSystemCode?: string;
  /** Amadeus `include`. */
  include?: ConsoleOrderInclude;
}

/** Params of {@link ConsoleAmadeusApi.getQueue} — Queue List parameters, verbatim. */
export interface ConsoleAmadeusGetQueueParams {
  /** `queue-id`. */
  queueId: number;
  /** `max`. */
  max?: number;
  /** `category` (default 0). */
  category?: number;
  /** `officeId`. */
  officeId?: string;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* console.auth                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** Staff sessions of the console (`console.auth.*`). */
export interface ConsoleAuthApi {
  /**
   * Sign a portal account in to this OTA's console and get a tenant-scoped staff session (roles, permissions).
   * Two grants: `{ grantType: "password", email, password, mfaCode? }` (portal credentials; `mfaCode` = TOTP when the
   * account has MFA) or `{ grantType: "portal_token", portalToken }` (one-time token from the Velexis portal's
   * "Open console" button, 60 s). The account needs an active membership in the OTA of the secret key.
   *
   * - HTTP: `POST /v1/console/auth/sign-in` → `200` {@link ConsoleStaffSession}.
   * - Amadeus: none. Writes platform.account_sessions and a tenant `staff_actions` row (`auth.sign_in`).
   * - Keys: **secret key** only, no token. Server action / route handler only — store `session.accessToken` and
   *   `session.refreshToken` in httpOnly, secure cookies (never return them to the browser).
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400)
   * @throws AuthenticationError `INVALID_CREDENTIALS` (401, `details.remainingAttempts`), `STAFF_MFA_REQUIRED` (401 — show the TOTP field and call again with `mfaCode`), `PORTAL_TOKEN_INVALID`, `INVALID_API_KEY` (401)
   * @throws PermissionError `STAFF_MEMBERSHIP_INACTIVE`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws VelexisError `ACCOUNT_LOCKED` (423, locked 15 min after 5 failures)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * // app/console/sign-in/actions.ts
   * "use server";
   * import { cookies } from "next/headers";
   * import { redirect } from "next/navigation";
   * import { createVelexisClient, isVelexisError } from "@velexis/ota-sdk";
   * export async function signIn(_: unknown, form: FormData) {
   *   const vx = createVelexisClient({ secretKey: process.env.VELEXIS_SECRET_KEY! });
   *   try {
   *     const s = await vx.console.auth.signIn({ grantType: "password", email: String(form.get("email")), password: String(form.get("password")), mfaCode: form.get("mfa") ? String(form.get("mfa")) : undefined });
   *     const jar = await cookies();
   *     jar.set("vx_staff_at", s.session.accessToken, { httpOnly: true, secure: true, sameSite: "strict", expires: new Date(s.session.accessTokenExpiresAt) });
   *     jar.set("vx_staff_rt", s.session.refreshToken, { httpOnly: true, secure: true, sameSite: "strict", path: "/console", expires: new Date(s.session.refreshTokenExpiresAt) });
   *   } catch (e) {
   *     if (isVelexisError(e, "STAFF_MFA_REQUIRED")) return { needMfa: true };
   *     if (isVelexisError(e, "INVALID_CREDENTIALS")) return { error: "Wrong e-mail or password" };
   *     throw e;
   *   }
   *   redirect("/console/bookings");
   * }
   * ```
   */
  signIn(params: ConsoleSignInParams, options?: RequestOptions): Promise<ConsoleStaffSession>;

  /**
   * Rotate a staff refresh token: returns a new access token, a new refresh token (the old one is revoked) and the
   * **current** roles/permissions (role changes apply at refresh). Reusing a rotated token revokes the whole family.
   * The SDK calls this automatically on `TOKEN_EXPIRED` when the client has `refreshToken` **and
   * `sessionKind: "staff"`** configured (without it the SDK would use the customer `auth.refresh`, which does not know
   * staff tokens) and reports the new tokens through `onSessionRefreshed` (`result.session` — persist them in the
   * cookies there) and the whole result through `onStaffSessionRefreshed` (updated permissions).
   * `createServerClient({ as: "staff" })` of `@velexis/ota-sdk/next` configures all of this. Customer refresh tokens →
   * `REFRESH_TOKEN_INVALID`.
   *
   * - HTTP: `POST /v1/console/auth/refresh` → `200` {@link ConsoleStaffSession}.
   * - Amadeus: none.
   * - Keys: **secret key** only (no access token needed; a key scoped `storefront` → `SCOPE_NOT_ALLOWED`). Server only
   *   (middleware, route handler, server action).
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `REFRESH_TOKEN_INVALID` / `REFRESH_TOKEN_REUSED` / `INVALID_API_KEY` (401 — sign the staff member out)
   * @throws PermissionError `STAFF_MEMBERSHIP_INACTIVE`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * // middleware.ts (edge) — refresh before the access token expires
   * const s = await createVelexisClient({ secretKey: process.env.VELEXIS_SECRET_KEY! })
   *   .console.auth.refresh({ refreshToken: req.cookies.get("vx_staff_rt")!.value });
   * res.cookies.set("vx_staff_at", s.session.accessToken, { httpOnly: true, secure: true, sameSite: "strict" });
   * res.cookies.set("vx_staff_rt", s.session.refreshToken, { httpOnly: true, secure: true, sameSite: "strict", path: "/console" });
   * ```
   */
  refresh(params: ConsoleRefreshParams, options?: RequestOptions): Promise<ConsoleStaffSession>;

  /**
   * Revoke the current staff session (`scope: "current"`, default) or every session of the account in this OTA
   * (`scope: "all"`). Works with an expired access token when `refreshToken` is passed. Idempotent.
   *
   * - HTTP: `POST /v1/console/auth/sign-out` → `204`.
   * - Amadeus: none. Audited (`auth.sign_out`).
   * - Keys: secret key + staff token, or secret key alone with `refreshToken` (the refresh token identifies the session;
   *   no `console:automation` scope needed). Server action only; delete the cookies after.
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` (401)
   * @throws PermissionError `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * import { signOutStaff } from "@velexis/ota-sdk/next";
   * export async function signOut() {
   *   await signOutStaff({ scope: "current" }); // console.auth.signOut with the refresh-token cookie (errors ignored) + clears the staff cookies
   *   redirect("/console/sign-in");
   * }
   * ```
   */
  signOut(params?: ConsoleSignOutParams, options?: RequestOptions): Promise<void>;

  /**
   * The signed-in staff member, the OTA (environment, Amadeus offices), effective permissions and the current
   * session. Use it in the console layout to build the navigation and hide actions the role cannot perform.
   *
   * - HTTP: `GET /v1/console/auth/me` → {@link ConsoleStaffProfile}.
   * - Amadeus: none.
   * - Keys: secret key + **staff token** (required). Server component / layout.
   * - Next.js caching: `no-store` (wrap in React `cache()` to dedupe within one request).
   *
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401 — redirect to sign-in)
   * @throws PermissionError `STAFF_MEMBERSHIP_INACTIVE`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/console/layout.tsx — requireStaff() (@velexis/ota-sdk/next) = console.auth.me deduplicated per request,
   * // redirecting to the sign-in page when there is no (valid) staff session
   * export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
   *   const me = await requireStaff();
   *   return <Shell user={me.staff.fullName} env={me.tenant.environment} canIssue={me.permissions.includes("bookings:issue")}>{children}</Shell>;
   * }
   * ```
   */
  me(params?: ConsoleMeParams, options?: RequestOptions): Promise<ConsoleStaffProfile>;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* console.bookings                                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/** All bookings of the OTA, PNR lookup and Amadeus order management (`console.bookings.*`). */
export interface ConsoleBookingsApi {
  /**
   * List **every** booking of the OTA (all channels, customers and guests, all statuses incl. `failed`) with filters
   * (status, ticketing status, ticketing deadline before, record locator, reference, customer, customer e-mail,
   * traveller last name, departure and creation ranges, payment status, source, validating carrier, staff, tag, free
   * text), sort and cursor pagination. Each row carries net amount, markup and sync state. The page has `next()` and
   * is async-iterable; `totalCount` is exact up to 10 000.
   *
   * - HTTP: `GET /v1/console/bookings?status=confirmed,partially_ticketed&ticketingDeadlineBefore=…&sort=ticketingDeadline&limit=50`.
   * - Amadeus: none (tenant tables; freshness = `lastSyncedAt`).
   * - Keys: secret key + staff token (`bookings:read`, every role) or a `console:automation` key listing that permission. Server component.
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/console/bookings/page.tsx — "to issue in the next 24 h"
   * export default async function Bookings({ searchParams }: { searchParams: Promise<{ cursor?: string; q?: string }> }) {
   *   const { cursor, q } = await searchParams;
   *   const page = await (await consoleServer()).bookings.list({
   *     status: ["confirmed", "partially_ticketed"],
   *     ticketingDeadlineBefore: new Date(Date.now() + 864e5).toISOString(),
   *     q, sort: "ticketingDeadline", limit: 50, cursor,
   *   });
   *   return <BookingTable rows={page.data} total={page.totalCount} nextCursor={page.page.nextCursor} />;
   * }
   * ```
   */
  list(params?: ConsoleListBookingsParams, options?: RequestOptions): Promise<ConsoleBookingPage>;

  /**
   * Full console detail of a booking: everything the customer sees plus environment, Amadeus order id, offices, net
   * prices and markup (`pricing`), payment state, supplier sync state, ticketing agreement, automated processes,
   * redacted forms of payment, commissions, forms of identification, all remarks, notes, full timeline, the last 20
   * Amadeus calls and staff actions, `consoleActions` and the failure reason. `amadeus.order` is the verbatim
   * supplier order. `refresh: true` synchronises with Amadeus first.
   *
   * - HTTP: `GET /v1/console/bookings/{bookingId}?refresh=true&include=bags&fareRules=refunds` (`ETag` = `"<version>"`).
   * - Amadeus: with `refresh` only — Flight Order Management `GET /v1/booking/flight-orders/{id}` (getFlightOrder).
   * - Keys: secret key + staff token (`bookings:read`) or a `console:automation` key listing that permission. Server component.
   * - Next.js caching: `no-store`. Pass `booking.version` as `ifMatch` to patch / issue / cancel.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError (only with `refresh`) `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504) — retry without `refresh`
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/console/bookings/[bookingId]/page.tsx
   * export default async function BookingPage({ params }: { params: Promise<{ bookingId: string }> }) {
   *   const { bookingId } = await params;
   *   const b = await (await consoleServer()).bookings.get({ bookingId });
   *   return <BookingDetail booking={b} margin={b.pricing.margin} canIssue={b.consoleActions.canIssue} version={b.version} />;
   * }
   * ```
   */
  get(params: ConsoleGetBookingParams, options?: RequestOptions): Promise<ConsoleBooking>;

  /**
   * PNR lookup: Get Flight Order By Record Locator with the OTA's Amadeus connection. Returns every matching order
   * verbatim with a normalised summary and its link to this OTA (`bookingId` when attached, `importable` otherwise →
   * {@link ConsoleBookingsApi.import}). Works for PNRs created outside Velexis (GDS terminal).
   *
   * - HTTP: `GET /v1/console/bookings/by-record-locator?reference=L2P9XC&originSystemCode=GDS&include=bags`.
   * - Amadeus: Get Flight Order By Record Locator `GET /v1/booking/flight-orders/by-reference` (getFlightOrder).
   * - Keys: secret key + staff token (owner, admin, agent) or a `console:automation` key listing that permission. Server component or server action.
   * - Next.js caching: `no-store`. Audited (`pnr.lookup`).
   *
   * @throws ValidationError `VALIDATION_FAILED` (400, malformed record locator)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404, no order — `error.supplier` set)
   * @throws ValidationError `SUPPLIER_REJECTED` (422, Amadeus 477 / 572 / 4926; `details.errors`)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/console/pnr/page.tsx
   * export default async function Pnr({ searchParams }: { searchParams: Promise<{ rl?: string }> }) {
   *   const { rl } = await searchParams;
   *   if (!rl) return <PnrSearchForm />;
   *   const r = await (await consoleServer()).bookings.findByRecordLocator({ reference: rl.toUpperCase(), include: ["bags"] })
   *     .catch((e) => (isVelexisError(e, "NOT_FOUND") ? null : Promise.reject(e)));
   *   return r ? <PnrMatches matches={r.matches} /> : <p>No PNR {rl}</p>;
   * }
   * ```
   */
  findByRecordLocator(params: ConsoleFindByRecordLocatorParams, options?: RequestOptions): Promise<PnrLookupResult>;

  /**
   * Attach an existing Amadeus order (created in a GDS terminal, another tool or with
   * {@link ConsoleAmadeusApi.createFlightOrders}) to the OTA's tables as a booking (channel `import`), optionally for a
   * customer, with a selling price (`pricing`: markup rules, net or override). Pass `flightOrderId` when several
   * orders match the record locator.
   *
   * - HTTP: `POST /v1/console/bookings/imports` → `201` {@link ConsoleBooking} + `Location`.
   * - Amadeus: Get Flight Order By Record Locator (getFlightOrder) + Flight Order Management GET (getFlightOrder, `include=bags`).
   * - Keys: secret key + staff token (`bookings:write`) or a `console:automation` key listing that permission. Server action.
   * - Next.js caching: `no-store`; `revalidatePath("/console/bookings")` after. Idempotent with the same idempotency key.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `UNPROCESSABLE` (422, several matches / no contact e-mail), `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404, no such order)
   * @throws ConflictError `ORDER_ALREADY_IMPORTED` (409, `details.bookingId`), `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * export async function importPnr(reference: string, customerId?: string) {
   *   await requireStaff({ permissions: ["bookings:write"] }); // server actions are public endpoints
   *   const b = await (await consoleServer()).bookings.import({ reference, originSystemCode: "GDS", customerId, pricing: { mode: "markup_rules" }, reason: "Terminal booking" });
   *   redirect(`/console/bookings/${b.id}`);
   * }
   * ```
   */
  import(params: ConsoleImportBookingParams, options?: RequestOptions): Promise<ConsoleBooking>;

  /**
   * Retrieve the **verbatim** Amadeus order of a booking (Flight Order Management GET with `include=bags` and
   * `fareRules=rebooks|refunds`): net prices, full traveller documents, tickets, remarks, ticketing agreement,
   * automated processes, commissions, `included.bags`, `dictionaries`, `warnings` — wrapped with the call info.
   * Refreshes the stored order snapshot unless `updateSnapshot: false` (child tables are rewritten only by resync).
   *
   * - HTTP: `GET /v1/console/bookings/{bookingId}/amadeus-order?include=bags&fareRules=rebooks,refunds`.
   * - Amadeus: Flight Order Management `GET /v1/booking/flight-orders/{id}` (getFlightOrder).
   * - Keys: secret key + staff token (owner, admin, agent, finance) or a `console:automation` key listing that permission. Server component ("Amadeus" tab).
   * - Next.js caching: `no-store`. Audited (`order.retrieve`).
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404, booking or Amadeus order)
   * @throws ConflictError `BOOKING_NOT_MODIFIABLE` (409, booking has no Amadeus order)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/console/bookings/[bookingId]/amadeus/page.tsx
   * const r = await (await consoleServer()).bookings.retrieve({ bookingId, include: ["bags"], fareRules: ["refunds"] });
   * return <JsonViewer value={r.amadeus.data} title={`Order ${r.flightOrderId} (${r.call.durationMs} ms)`} />;
   * ```
   */
  retrieve(params: ConsoleRetrieveFlightOrderParams, options?: RequestOptions): Promise<ConsoleFlightOrderRetrieval>;

  /**
   * Book a priced offer (`prc_…` from `flights.price`, called with the staff token) on behalf of a customer
   * (`customerId`) or as a guest booking, with the **full Flight Create Orders body**: `travelers`, `contacts`,
   * `remarks` (general / airline), `ticketingAgreement` (CONFIRM / DELAY_TO_QUEUE / DELAY_TO_CANCEL with `delay`, e.g.
   * `"2D"` — the only settable ticketing time limit; `dateTime` / `segmentIds` are read-only Amadeus outputs returned on
   * the order, sending them → `VALIDATION_FAILED`), `automatedProcess`, `formOfPayments` (creditCard, b2bWallet, other), `queuingOfficeId`,
   * `ownerOfficeId`, `commissions`, `formOfIdentifications` and the Amadeus `issue` flag. Omitted fields get the
   * storefront defaults. Expired priced offers are re-priced (`repriceIfExpired`, default true); a higher price than
   * `expectedNetTotal` / `expectedTotal` throws `PriceChangedError` and books nothing. Selling price per `pricing`
   * (`markup_rules` default, `net`, `override`). No payment is taken (`paymentStatus = not_applicable`).
   *
   * - HTTP: `POST /v1/console/bookings` → `201` {@link ConsoleBooking} + `Location` + `ETag`.
   * - Amadeus: Flight Offers Price (quoteAirOffers, only when re-pricing) then Flight Create Orders
   *   `POST /v1/booking/flight-orders?issue=` (createFligtOrders).
   * - Keys: secret key + staff token (`bookings:write`, + `bookings:issue` when `issue: true`) or a `console:automation` key listing that permission.
   *   Server action only. Allow up to 60 s (`timeoutMs: 90000`).
   * - Next.js caching: `no-store`; redirect to the new booking.
   * - `SUPPLIER_TIMEOUT` (504): the order may exist. A `pending` booking was kept and is identified in `error.details`
   *   ({@link ConsoleBookingTimeoutDetails}: `bookingId`, `reference`, `reconcileBy`) — open it and **never book again
   *   with a new idempotency key**. A same-key retry (also the SDK's automatic retries) never calls Flight Create Orders
   *   again: it replays the 504 (`details.replayed: true`) until the reconciliation job (≤ 15 min) decides, then returns
   *   the final booking (`201`) or the final error. Until then the pending booking has no Amadeus order
   *   (`resync` → `BOOKING_NOT_MODIFIABLE`); poll {@link ConsoleBookingsApi.get} until `status` leaves `pending`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `TRAVELER_DATA_INVALID` / `CONTACT_DATA_INVALID` / `UNPROCESSABLE` / `SUPPLIER_REJECTED` (422, `fieldErrors` / `details.errors`)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `OFFICE_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404, priced offer or customer)
   * @throws PriceChangedError `PRICE_CHANGED` (409, `newPrice`, `details.pricedOfferId`)
   * @throws SoldOutError `SOLD_OUT` (409)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws ExpiredError `OFFER_EXPIRED` (410, with `repriceIfExpired: false`)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` / `TICKETING_FAILED` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504, {@link ConsoleBookingTimeoutDetails} — open the pending booking; retry only with the same idempotency key)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * // app/console/new-booking/actions.ts
   * "use server";
   * export async function book(pricedOfferId: string, customerId: string, travelers: Schemas["AmadeusTraveler"][], attemptKey: string) {
   *   await requireStaff({ permissions: ["bookings:write"] });
   *   const vx = await consoleServer();
   *   let bookingId: string;
   *   try {
   *     const b = await vx.bookings.create({
   *       pricedOfferId, customerId, travelers,
   *       ticketingAgreement: { option: "DELAY_TO_QUEUE", delay: "2D" }, // delay only — dateTime is read-only
   *       automatedProcess: [{ code: "IMMEDIATE", queue: { number: "50", category: "0" }, text: "TO ISSUE" }],
   *       formOfPayments: [{ other: { method: "ACCOUNT", flightOfferIds: ["1"] } }],
   *       pricing: { mode: "markup_rules" }, reason: "Phone booking",
   *     }, { idempotencyKey: attemptKey, timeoutMs: 90_000 });
   *     bookingId = b.id;
   *   } catch (e) {
   *     if (!isVelexisError(e, "SUPPLIER_TIMEOUT")) throw e;
   *     // The order may exist: open the pending booking (it shows "confirming with Amadeus") — never re-book with a new key.
   *     bookingId = (e.details as ConsoleBookingTimeoutDetails).bookingId;
   *   }
   *   redirect(`/console/bookings/${bookingId}`);
   * }
   * ```
   */
  create(params: ConsoleCreateBookingParams, options?: RequestOptions): Promise<ConsoleBooking>;

  /**
   * Modify the booking's Amadeus order with Flight Order Management PATCH — every patchable element: `travelers`,
   * `contacts`, `remarks`, `formOfPayments`, `ticketingAgreement`, `automatedProcess`, `queuingOfficeId`,
   * `ownerOfficeId`, `associatedRecords`, `commissions`, `formOfIdentifications`, `tickets` and partial `flightOffers`
   * ({@link ConsoleAmadeusFlightOffer}: chargeable seats, checked bags, **cabin bags** (`chargeableCabinBags`) and other
   * services via `additionalServices`). The returned order rewrites the booking tables; `version` increases.
   *
   * Element semantics — Amadeus PATCH **replaces** every top-level element sent and keeps the others, so Velexis merges
   * three elements with the stored order first:
   * - `travelers`: merged by `id` over the stored traveller (`mergeTravelers`, default true).
   * - `remarks`: **added** to the stored remarks, exact duplicates skipped (`mergeRemarks`, default true) — send only the
   *   new remark; `mergeRemarks: false` makes each `general` / `airline` list sent replace that kind (send the remaining
   *   remarks to delete one; the Velexis BACKOFFICE remark is kept).
   * - `contacts`: replace the stored contact with the same `purpose`, others kept (`mergeContacts`, default true);
   *   `mergeContacts: false` replaces the whole list.
   * - `formOfPayments`, `ticketingAgreement`, `automatedProcess`, `associatedRecords`, `commissions`,
   *   `formOfIdentifications`, `tickets`: sent as given and replace the order's element — send the complete list.
   * - `ticketingAgreement`: `option` + `delay` only; `dateTime` / `segmentIds` are read-only → `VALIDATION_FAILED`.
   * - `tags` / `metadata`: local only (replace `bookings.tags` / `metadata`, no Amadeus call). A body with only them works
   *   in every status (also cancelled / failed) and still needs `ifMatch`.
   *
   * - HTTP: `PATCH /v1/console/bookings/{bookingId}` with `If-Match` → {@link ConsoleBooking}.
   * - Amadeus: Flight Order Management `PATCH /v1/booking/flight-orders/{id}` (patchFlightOrder); 2552 → `VERSION_CONFLICT`.
   * - Keys: secret key + staff token (`bookings:write`) or a `console:automation` key listing that permission. Server action.
   * - Next.js caching: `no-store`; `revalidatePath` the booking page after. After `SUPPLIER_TIMEOUT` call
   *   {@link ConsoleBookingsApi.resync} before retrying.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `TRAVELER_DATA_INVALID` / `CONTACT_DATA_INVALID` / `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `OFFICE_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `VERSION_CONFLICT`, `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED` (409)
   * @throws VelexisError `PRECONDITION_FAILED` (412, stale `ifMatch` — reload)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * export async function moveTicketingDeadline(bookingId: string, version: number) {
   *   await requireStaff({ permissions: ["bookings:write"] });
   *   await (await consoleServer()).bookings.patch({
   *     bookingId, ifMatch: version,
   *     ticketingAgreement: { option: "DELAY_TO_QUEUE", delay: "1D" },
   *     remarks: { general: [{ subType: "TICKETING_MISCELLANEOUS", text: "DEADLINE EXTENDED BY DESK" }] }, // added (mergeRemarks)
   *     reason: "Customer pays tomorrow",
   *   });
   *   revalidatePath(`/console/bookings/${bookingId}`);
   * }
   * export async function addCabinBag(bookingId: string, version: number) {
   *   await requireStaff({ permissions: ["bookings:write"] });
   *   await (await consoleServer()).bookings.patch({
   *     bookingId, ifMatch: version, reason: "Extra cabin bag",
   *     flightOffers: [{ type: "flight-offer", id: "1", travelerPricings: [{ travelerId: "1", fareOption: "STANDARD", travelerType: "ADULT",
   *       fareDetailsBySegment: [{ segmentId: "1", additionalServices: { chargeableCabinBags: { quantity: 1 } } }] }] }],
   *   });
   * }
   * export async function retag(bookingId: string, version: number, tags: string[]) {
   *   await requireStaff({ permissions: ["bookings:write"] });
   *   await (await consoleServer()).bookings.patch({ bookingId, ifMatch: version, tags, reason: "Re-tag" }); // no Amadeus call
   * }
   * ```
   */
  patch(params: ConsolePatchBookingParams, options?: RequestOptions): Promise<ConsoleBooking>;

  /**
   * Issue the tickets of a booking with Flight Order Issue (`formOfPayments` optional: b2bWallet, creditCard, other).
   * An authorised storefront payment is captured first (`capturePayment`, default true); an unpaid storefront booking
   * needs `allowUnpaid: true` (owner/admin). Tickets, documents and the customer e-mail follow.
   *
   * - HTTP: `POST /v1/console/bookings/{bookingId}/issuance` with `If-Match` → {@link ConsoleBooking}.
   * - Amadeus: Flight Order Issue `POST /v1/booking/flight-orders/{id}/issuance` (issueFlightOrder).
   * - Keys: secret key + staff token (`bookings:issue`) or a `console:automation` key listing that permission. Server action (button handler).
   * - Next.js caching: `no-store`. One idempotency key per click: a retry never issues twice. After a timeout call
   *   {@link ConsoleBookingsApi.resync} — Amadeus may have issued.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PaymentError `PAYMENT_REQUIRED` / `PAYMENT_DECLINED` (402)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `ALREADY_ISSUED`, `BOOKING_ALREADY_CANCELLED`, `BOOKING_NOT_MODIFIABLE`, `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws VelexisError `PRECONDITION_FAILED` (412)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `TICKETING_FAILED` / `SUPPLIER_ERROR` (502, `supplier.code` e.g. 9112), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * export async function issue(bookingId: string, version: number, clickId: string) {
   *   await requireStaff({ permissions: ["bookings:issue"] });
   *   try {
   *     await (await consoleServer()).bookings.issue({ bookingId, ifMatch: version, reason: "Payment received" }, { idempotencyKey: clickId, timeoutMs: 90_000 });
   *   } catch (e) {
   *     if (isVelexisError(e, "TICKETING_FAILED")) return { error: `Amadeus: ${(e as VelexisError).supplier?.title ?? e.message}` };
   *     throw e;
   *   }
   *   revalidatePath(`/console/bookings/${bookingId}`);
   * }
   * ```
   */
  issue(params: ConsoleIssueBookingParams, options?: RequestOptions): Promise<ConsoleBooking>;

  /**
   * Cancel a booking: refreshes the order (Flight Order Management GET), cancels it with Flight Order Management
   * DELETE, marks the booking `cancelled` (`reasonCode`, `reason` audited) and refunds captured payments per
   * `refund` (`none` default, `full`, `amount`). Refund rows get `refunds.reason` mapped from `reasonCode`:
   * `no_payment`, `ticketing_deadline`, `airline_request` → `booking_cancelled`; the other codes keep their value. Issued tickets are voided by Amadeus when still voidable; otherwise
   * Amadeus refuses (`SUPPLIER_REJECTED`) and the case must be handled with the airline.
   *
   * - HTTP: `POST /v1/console/bookings/{bookingId}/cancellation` with `If-Match` → {@link ConsoleBooking}.
   * - Amadeus: Flight Order Management GET (getFlightOrder) + `DELETE /v1/booking/flight-orders/{id}` (cancelFlightOrder).
   * - Keys: secret key + staff token (`bookings:cancel`) or a `console:automation` key listing that permission. Server action behind a confirmation dialog.
   * - Next.js caching: `no-store`; `revalidatePath` after.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `UNPROCESSABLE` (422, refund amount > captured), `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `BOOKING_ALREADY_CANCELLED`, `BOOKING_NOT_MODIFIABLE` (e.g. flown), `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws VelexisError `PRECONDITION_FAILED` (412)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * export async function cancelBooking(bookingId: string, version: number, form: FormData) {
   *   await requireStaff({ permissions: ["bookings:cancel"] });
   *   await (await consoleServer()).bookings.cancel({
   *     bookingId, ifMatch: version,
   *     reasonCode: "customer_request", reason: String(form.get("reason")),
   *     refund: { mode: form.get("refund") === "on" ? "full" : "none" }, notifyCustomer: true,
   *   });
   *   revalidatePath(`/console/bookings/${bookingId}`);
   * }
   * ```
   */
  cancel(params: ConsoleCancelBookingParams, options?: RequestOptions): Promise<ConsoleBooking>;

  /**
   * Re-synchronise a booking with Amadeus (Flight Order Management GET): status, segments and schedule changes,
   * tickets, travellers, contacts, remarks, ticketing agreement. Returns the booking and the list of `changes`.
   * Use after `SUPPLIER_TIMEOUT`, when a PNR shows up on a queue, or before acting on stale data.
   *
   * - HTTP: `POST /v1/console/bookings/{bookingId}/resync` → {@link ConsoleBookingResyncResult} (idempotent by design).
   * - Amadeus: Flight Order Management `GET /v1/booking/flight-orders/{id}` (getFlightOrder) with `include` / `fareRules`.
   * - Keys: secret key + staff token (`bookings:write`) or a `console:automation` key listing that permission. Server action ("Sync" button).
   * - Next.js caching: `no-store`. Throttled to 1 call per 10 s per booking (`RateLimitError`).
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422, e.g. Amadeus no longer knows the order)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `BOOKING_NOT_MODIFIABLE` (409, no Amadeus order)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * export async function sync(bookingId: string) {
   *   await requireStaff({ permissions: ["bookings:write"] });
   *   const r = await (await consoleServer()).bookings.resync({ bookingId, include: ["bags"] });
   *   revalidatePath(`/console/bookings/${bookingId}`);
   *   return { changed: r.changes.map((c) => c.label), statusChanged: r.statusChanged };
   * }
   * ```
   */
  resync(params: ConsoleResyncBookingParams, options?: RequestOptions): Promise<ConsoleBookingResyncResult>;

  /**
   * Add an internal note to the booking timeline (never sent to Amadeus; shown to the customer only with
   * `visibleToCustomer: true`). The booking `version` does not change.
   *
   * - HTTP: `POST /v1/console/bookings/{bookingId}/notes` → `201` {@link ConsoleBookingNote} + `Location`.
   * - Amadeus: none.
   * - Keys: secret key + staff token (`bookings:write`; finance too) or a `console:automation` key listing that permission. Server action.
   * - Next.js caching: `no-store`; `revalidatePath` after.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * export async function addNote(bookingId: string, form: FormData) {
   *   await requireStaff(); // signed-in staff; the API checks bookings:write (finance may also add notes)
   *   await (await consoleServer()).bookings.addNote({ bookingId, text: String(form.get("text")), visibleToCustomer: false });
   *   revalidatePath(`/console/bookings/${bookingId}`);
   * }
   * ```
   */
  addNote(params: ConsoleAddBookingNoteParams, options?: RequestOptions): Promise<ConsoleBookingNote>;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* console.queues                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** Amadeus office queues (`console.queues.*`). */
export interface ConsoleQueuesApi {
  /**
   * Read an Amadeus office queue (Queue List): PNRs with record locator, creation date-time, traveller names and air
   * segments, each linked to this OTA's booking when it exists (`bookingId`) and wrapping the verbatim Amadeus item.
   * A call **without** `cursor` reads Amadeus and stores a snapshot (`page.snapshot.id`); `next()` / `cursor` page
   * through that stored snapshot without calling Amadeus again.
   *
   * - HTTP: `GET /v1/console/queues/{queueId}?category=0&officeId=NCE1A0950&max=100&limit=50`.
   * - Amadeus: Queue List `GET /office/queues/{queue-id}` (with `max`, `category`, `officeId`).
   * - Keys: secret key + staff token (`queues:read`: owner, admin, agent) or a `console:automation` key listing that permission. Server component.
   * - Next.js caching: `no-store` (each first page is a fresh Amadeus read).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400, bad cursor); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `OFFICE_NOT_ALLOWED` / `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/console/queues/page.tsx
   * export default async function Queues({ searchParams }: { searchParams: Promise<{ q?: string; cat?: string }> }) {
   *   const { q = "50", cat = "0" } = await searchParams;
   *   const page = await (await consoleServer()).queues.list({ queueId: Number(q), category: Number(cat), max: 200, limit: 50 });
   *   return <QueueTable items={page.data} snapshotId={page.snapshot.id} fetchedAt={page.snapshot.fetchedAt} warnings={page.warnings} />;
   * }
   * ```
   */
  list(params: ConsoleListQueueParams, options?: RequestOptions): Promise<ConsoleQueuePage>;

  /**
   * List stored queue snapshots (newest first) — reads by staff, raw `getQueue` calls and the scheduled queue poller
   * (`fetchedBy: null`; the polled queues are configured per OTA and environment in
   * `platform.supplier_connections.monitored_queues`, managed in the Velexis portal). `include: ["items"]` adds the PNR items. Retained 30 days.
   *
   * - HTTP: `GET /v1/console/queue-snapshots?queueId=50&officeId=NCE1A0950&include=items`.
   * - Amadeus: none.
   * - Keys: secret key + staff token (`queues:read`) or a `console:automation` key listing that permission. Server component.
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * const history = await (await consoleServer()).queues.listSnapshots({ queueId: 50, limit: 10 });
   * return <QueueHistory points={history.data.map((s) => ({ at: s.fetchedAt, count: s.itemCount }))} />;
   * ```
   */
  listSnapshots(params?: ConsoleListQueueSnapshotsParams, options?: RequestOptions): Promise<Page<QueueSnapshot>>;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* console.customers / console.supplierRequests                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** Customers of the OTA (`console.customers.*`). */
export interface ConsoleCustomersApi {
  /**
   * List the OTA's customer accounts with booking statistics (bookings, upcoming, total spent, last booking).
   * Guests are not customers — find their bookings with {@link ConsoleBookingsApi.list} `customerEmail`.
   *
   * - HTTP: `GET /v1/console/customers?q=berg&hasBookings=true&sort=-lastBooking`.
   * - Amadeus: none.
   * - Keys: secret key + staff token (`customers:read`, every role) or a `console:automation` key listing that permission. Server component.
   * - Next.js caching: `no-store` (PII).
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * const customers = await (await consoleServer()).customers.list({ q: searchQuery, sort: "-lastBooking", limit: 25 });
   * return <CustomerTable rows={customers.data} nextCursor={customers.page.nextCursor} />;
   * ```
   */
  list(params?: ConsoleListCustomersParams, options?: RequestOptions): Promise<Page<ConsoleCustomerSummary>>;

  /**
   * A customer account (as the customer sees it) + statistics, the 10 most recent bookings, saved-traveller and
   * active-session counts. Viewing is audited (GDPR access log). Page through all bookings with
   * {@link ConsoleBookingsApi.list} `{ customerId }`.
   *
   * - HTTP: `GET /v1/console/customers/{customerId}`.
   * - Amadeus: none.
   * - Keys: secret key + staff token (`customers:read`) or a `console:automation` key listing that permission. Server component.
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/console/customers/[customerId]/page.tsx
   * const c = await (await consoleServer()).customers.get({ customerId });
   * return <CustomerCard customer={c.customer} stats={c.stats} bookings={c.recentBookings} />;
   * ```
   */
  get(params: ConsoleGetCustomerParams, options?: RequestOptions): Promise<ConsoleCustomer>;
}

/** The redacted Amadeus call log (`console.supplierRequests.*`). */
export interface ConsoleSupplierRequestsApi {
  /**
   * List logged Amadeus calls (newest first, 90-day retention): operation, Amadeus API/operationId, method, path,
   * office, status, outcome, Amadeus error codes, latency, `correlationId` (quote it to Amadeus support), Velexis
   * `requestId`, related booking/search/staff. `includeBodies: true` adds the redacted bodies (cards, CVV, documents,
   * e-mails and phones masked). Filter by `requestId` to troubleshoot a failed SDK call (`VelexisError.requestId`).
   *
   * - HTTP: `GET /v1/console/supplier-requests?bookingId=…&outcome=client_error,server_error&includeBodies=true`.
   * - Amadeus: none.
   * - Keys: secret key + staff token (`supplier_requests:read`: owner, admin, agent, finance) or a `console:automation` key listing that permission. Server component.
   * - Next.js caching: `no-store`.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * const log = await (await consoleServer()).supplierRequests.list({ bookingId, includeBodies: true, limit: 20 });
   * return <SupplierLog rows={log.data} />; // e.g. errorCodes [9112] on issueFlightOrder
   * ```
   */
  list(params?: ConsoleListSupplierRequestsParams, options?: RequestOptions): Promise<Page<ConsoleSupplierRequest>>;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* console.amadeus (raw pass-through)                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Raw Amadeus pass-through (`console.amadeus.*`): one method per Amadeus operation, verbatim request (`amadeus`
 * body or the Amadeus query parameters) and verbatim response (`result.amadeus`) + call info (`result.call`).
 *
 * Common to every method:
 * - Runs with the OTA's own Amadeus connection of the key's environment; Velexis adds only authentication (and
 *   `X-HTTP-Method-Override: GET` where Amadeus requires it). Prices are **net** (no markup) — never show them to
 *   customers. Nothing is stored in flight_offers / priced_offers.
 * - Amadeus 4xx → `ValidationError` `SUPPLIER_REJECTED` (422) with the verbatim Amadeus `errors[]` in
 *   `error.details.errors` and the first one in `error.supplier`; 404 → `NotFoundError`; 2552 → `ConflictError`
 *   `VERSION_CONFLICT`; 5xx → `SupplierError` `SUPPLIER_ERROR` (502); unavailable 503; timeout 504.
 * - Logged in supplier_requests (redacted; pass `bookingId` to link) and audited in staff_actions (`reason`).
 * - Keys: secret key + staff token, or a `console:automation` key that lists the permission, **server-side only**. Permissions: `amadeus:read` for
 *   searches/reads (owner, admin, agent), `amadeus:write` for create/issue/patch/cancel (owner, admin). Raw access can
 *   be disabled per OTA → `PermissionError` `FEATURE_DISABLED`. Rate limit 30 calls/min per staff member.
 * - Next.js caching: always `no-store`.
 */
export interface ConsoleAmadeusApi {
  /**
   * Raw **Flight Offers Search** POST with the complete getFlightOffersQuery (currencyCode, originDestinations with
   * date/time windows, radius, alternative and connection points; travelers; sources GDS/LTC/PYTON/EAC/NDC;
   * searchCriteria incl. maxFlightOffers, pricingOptions, additionalInformation, flightFilters).
   *
   * - HTTP: `POST /v1/console/amadeus/v2/shopping/flight-offers` (idempotent by design).
   * - Amadeus: Flight Offers Search `POST /v2/shopping/flight-offers` (searchFlightOffers).
   * - Keys: secret key + staff token (`amadeus:read`). Server action or route handler.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `STAFF_MEMBERSHIP_INACTIVE` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * export async function rawSearch() {
   *   await requireStaff({ permissions: ["amadeus:read"] });
   *   const r = await (await consoleServer()).amadeus.searchFlightOffers({
   *     amadeus: {
   *       currencyCode: "EUR",
   *       originDestinations: [{ id: "1", originLocationCode: "PAR", destinationLocationCode: "NYC", departureDateTimeRange: { date: "2026-11-20", time: "10:00:00" } }],
   *       travelers: [{ id: "1", travelerType: "ADULT" }],
   *       sources: ["GDS"],
   *       searchCriteria: { maxFlightOffers: 20, flightFilters: { carrierRestrictions: { includedCarrierCodes: ["AF"] } } },
   *     },
   *     reason: "Corporate request",
   *   });
   *   return r.amadeus.data; // verbatim AmadeusFlightOffer[] (net)
   * }
   * ```
   */
  searchFlightOffers(params: ConsoleAmadeusSearchFlightOffersParams, options?: RequestOptions): Promise<ConsoleAmadeusFlightOffersResult>;

  /**
   * Raw **Flight Offers Search** GET (simple query; every Amadeus query parameter: originLocationCode,
   * destinationLocationCode, departureDate, returnDate, adults, children, infants, travelClass, includedAirlineCodes,
   * excludedAirlineCodes, nonStop, currencyCode, maxPrice, max).
   *
   * - HTTP: `GET /v1/console/amadeus/v2/shopping/flight-offers?originLocationCode=PAR&destinationLocationCode=NYC&departureDate=2026-11-20&adults=1`.
   * - Amadeus: Flight Offers Search `GET /v2/shopping/flight-offers` (getFlightOffers).
   * - Keys: secret key + staff token (`amadeus:read`). Server component or server action.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * const r = await (await consoleServer()).amadeus.getFlightOffers({ originLocationCode: "PAR", destinationLocationCode: "NYC", departureDate: "2026-11-20", adults: 1, includedAirlineCodes: ["AF"], max: 10 });
   * return <RawOffers offers={r.amadeus.data} dictionaries={r.amadeus.dictionaries} />;
   * ```
   */
  getFlightOffers(params: ConsoleAmadeusGetFlightOffersParams, options?: RequestOptions): Promise<ConsoleAmadeusFlightOffersResult>;

  /**
   * Raw **Flight Availabilities Search** (seat availability per booking class) with the complete
   * getFlightAvailabilitiesQuery (originDestinations with departureDateTime/arrivalDateTime, travelers, sources,
   * searchCriteria incl. includeClosedContent and class). For the normalised view use `flights.availability`.
   *
   * - HTTP: `POST /v1/console/amadeus/v1/shopping/availability/flight-availabilities` (idempotent by design).
   * - Amadeus: Flight Availabilities Search `POST /v1/shopping/availability/flight-availabilities` (searchFlightAvailabilities).
   * - Keys: secret key + staff token (`amadeus:read`). Server action.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * const r = await (await consoleServer()).amadeus.searchFlightAvailabilities({
   *   amadeus: { originDestinations: [{ id: "1", originLocationCode: "MAD", destinationLocationCode: "ATH", departureDateTime: { date: "2026-11-20", time: "21:15:00" } }], travelers: [{ id: "1", travelerType: "ADULT" }], sources: ["GDS"] },
   * });
   * const classes = r.amadeus.data.flatMap((a) => a.segments.flatMap((s) => s.availabilityClasses ?? []));
   * ```
   */
  searchFlightAvailabilities(params: ConsoleAmadeusSearchFlightAvailabilitiesParams, options?: RequestOptions): Promise<ConsoleAmadeusAvailabilitiesResult>;

  /**
   * Raw **Branded Fares Upsell**: `{ amadeus: { data: { type: "flight-offer-upsell", flightOffers, payments } } }` →
   * the upsold offers per branded fare (`meta.oneWayUpselledCombinations`). For the storefront comparison view use
   * `flights.upsell`.
   *
   * - HTTP: `POST /v1/console/amadeus/v1/shopping/flight-offers/upselling` (idempotent by design).
   * - Amadeus: Branded Fares Upsell `POST /v1/shopping/flight-offers/upselling` (upsellAirOffers).
   * - Keys: secret key + staff token (`amadeus:read`). Server action.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * const up = await (await consoleServer()).amadeus.upsellAirOffers({ amadeus: { data: { type: "flight-offer-upsell", flightOffers: [offer] } } });
   * const brands = up.amadeus.data.map((o) => o.travelerPricings?.[0]?.fareDetailsBySegment[0]?.brandedFare);
   * ```
   */
  upsellAirOffers(params: ConsoleAmadeusUpsellAirOffersParams, options?: RequestOptions): Promise<ConsoleAmadeusUpsellResult>;

  /**
   * Raw **Flight Offers Price** with Amadeus query `include` (credit-card-fees, bags, other-services,
   * detailed-fare-rules) and `forceClass`, body `{ amadeus: { data: { type: "flight-offer-pricing", flightOffers,
   * payments?, travelers?, additionalInformation? } } }` → confirmed offers, `bookingRequirements` and the `included`
   * maps. `flightOffers` are {@link ConsoleAmadeusFlightOffer}s (additionalServices incl. `chargeableCabinBags`). Book
   * the result with {@link ConsoleAmadeusApi.createFlightOrders}.
   *
   * - HTTP: `POST /v1/console/amadeus/v1/shopping/flight-offers/pricing?include=credit-card-fees,bags&forceClass=false` (idempotent by design).
   * - Amadeus: Flight Offers Price `POST /v1/shopping/flight-offers/pricing` (quoteAirOffers).
   * - Keys: secret key + staff token (`amadeus:read`). Server action.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * const priced = await (await consoleServer()).amadeus.quoteAirOffers({
   *   include: ["credit-card-fees", "bags", "detailed-fare-rules"], forceClass: false,
   *   amadeus: { data: { type: "flight-offer-pricing", flightOffers: [offer], payments: [{ brand: "VISA", binNumber: 424242, flightOfferIds: ["1"] }] } },
   * });
   * const requirements = priced.amadeus.data.bookingRequirements;
   * ```
   */
  quoteAirOffers(params: ConsoleAmadeusQuoteAirOffersParams, options?: RequestOptions): Promise<ConsoleAmadeusPricingResult>;

  /**
   * Raw **Flight Create Orders**: `{ amadeus: { data: FlightOrder } }` with every Amadeus field (flightOffers,
   * travelers, remarks, formOfPayments, ticketingAgreement, automatedProcess, contacts, queuingOfficeId,
   * ownerOfficeId, commissions, formOfIdentifications) + Amadeus `issue`. Not attached to the OTA's tables unless
   * `importAsBooking: true` (then `result.bookingId`).
   *
   * - HTTP: `POST /v1/console/amadeus/v1/booking/flight-orders?issue=false` → `201` + `Location`.
   * - Amadeus: Flight Create Orders `POST /v1/booking/flight-orders` (createFligtOrders).
   * - Keys: secret key + staff token (`amadeus:write`: owner, admin). Server action. Allow 60 s (`timeoutMs: 90000`).
   * - Idempotency: one key per attempt. Unlike {@link ConsoleBookingsApi.create} (which keeps a pending booking and
   *   returns its id), a raw create keeps **no** booking row after `SUPPLIER_TIMEOUT` (also with `importAsBooking`). A
   *   same-key retry (also the SDK's automatic retries) replays the stored 504 and never calls Amadeus again — check the
   *   queuing office's queue ({@link ConsoleQueuesApi.list}) or look the PNR up before booking again with a **new** key.
   * - `flightOffers` are {@link ConsoleAmadeusFlightOffer}s: priced offers as returned, optionally with
   *   `additionalServices.chargeableCabinBags` / `chargeableCheckedBags` / `chargeableSeat` added.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `OFFICE_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws SoldOutError `SOLD_OUT` (409) · PriceChangedError `PRICE_CHANGED` (409) · ConflictError `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` / `TICKETING_FAILED` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * "use server";
   * export async function rawBook(offer: Schemas["AmadeusFlightOffer"], traveler: Schemas["AmadeusTraveler"]) {
   *   await requireStaff({ permissions: ["amadeus:write"] });
   *   const r = await (await consoleServer()).amadeus.createFlightOrders({
   *     issue: false, importAsBooking: true, reason: "Group fare",
   *     amadeus: { data: { type: "flight-order", flightOffers: [offer], travelers: [traveler], ticketingAgreement: { option: "DELAY_TO_CANCEL", delay: "6D" } } },
   *   }, { timeoutMs: 90_000 });
   *   redirect(r.bookingId ? `/console/bookings/${r.bookingId}` : `/console/pnr?rl=${r.amadeus.data.associatedRecords?.[0]?.reference}`);
   * }
   * ```
   */
  createFlightOrders(params: ConsoleAmadeusCreateFlightOrdersParams, options?: RequestOptions): Promise<ConsoleAmadeusFlightOrderResult>;

  /**
   * Raw **Flight Order Issue** of any order: `{ flightOrderId, amadeus?: { data: { formOfPayments } } }`. An attached
   * booking is re-synchronised (tickets) but no payment is captured — prefer {@link ConsoleBookingsApi.issue}.
   *
   * - HTTP: `POST /v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}/issuance`.
   * - Amadeus: Flight Order Issue `POST /v1/booking/flight-orders/{id}/issuance` (issueFlightOrder).
   * - Keys: secret key + staff token (`amadeus:write`). Server action. Never issues twice for one idempotency key.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `VERSION_CONFLICT` (409, Amadeus 2552) / `IDEMPOTENCY_KEY_REUSED` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `TICKETING_FAILED` / `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * await requireStaff({ permissions: ["amadeus:write"] }); // in the server action
   * const r = await (await consoleServer()).amadeus.issueFlightOrder({ flightOrderId, amadeus: { data: { formOfPayments: [{ other: { method: "CASH", flightOfferIds: ["1"] } }] } }, reason: "NDC cash" });
   * const tickets = r.amadeus.data.tickets ?? [];
   * ```
   */
  issueFlightOrder(params: ConsoleAmadeusIssueFlightOrderParams, options?: RequestOptions): Promise<ConsoleAmadeusFlightOrderResult>;

  /**
   * Raw **Flight Order Management GET** of any order the OTA's credentials can read, with `include` (bags) and
   * `fareRules` (rebooks, refunds). Does not modify an attached booking (`result.bookingId`).
   *
   * - HTTP: `GET /v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}?include=bags&fareRules=rebooks`.
   * - Amadeus: Flight Order Management `GET /v1/booking/flight-orders/{id}` (getFlightOrder).
   * - Keys: secret key + staff token (`amadeus:read`). Server component.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * const r = await (await consoleServer()).amadeus.getFlightOrder({ flightOrderId, include: ["bags"], fareRules: ["rebooks", "refunds"] });
   * return <JsonViewer value={r.amadeus} />;
   * ```
   */
  getFlightOrder(params: ConsoleAmadeusGetFlightOrderParams, options?: RequestOptions): Promise<ConsoleAmadeusFlightOrderResult>;

  /**
   * Raw **Flight Order Management PATCH**: `{ flightOrderId, amadeus: { data: { type: "flight-order", …elements } } }`
   * sent verbatim (no merge: every element sent replaces the order's element, e.g. `remarks.general` replaces all general
   * remarks). `flightOffers` are partial {@link ConsoleAmadeusFlightOffer}s (seats, checked / cabin bags, services). An
   * attached booking is re-synchronised from the response. Prefer {@link ConsoleBookingsApi.patch} for bookings of the
   * OTA (If-Match, traveller / remark / contact merge).
   *
   * - HTTP: `PATCH /v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}`.
   * - Amadeus: Flight Order Management `PATCH /v1/booking/flight-orders/{id}` (patchFlightOrder).
   * - Keys: secret key + staff token (`amadeus:write`). Server action. After a timeout GET the order before retrying.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `OFFICE_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `VERSION_CONFLICT` (409, Amadeus 2552)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * await requireStaff({ permissions: ["amadeus:write"] }); // in the server action
   * await (await consoleServer()).amadeus.patchFlightOrder({
   *   flightOrderId, reason: "Add seat",
   *   amadeus: { data: { type: "flight-order", flightOffers: [{ type: "flight-offer", id: "1", travelerPricings: [{ travelerId: "1", fareOption: "STANDARD", travelerType: "ADULT", fareDetailsBySegment: [{ segmentId: "1", additionalServices: { chargeableSeatNumber: "28A" } }] }] }] } },
   * });
   * ```
   */
  patchFlightOrder(params: ConsoleAmadeusPatchFlightOrderParams, options?: RequestOptions): Promise<ConsoleAmadeusFlightOrderResult>;

  /**
   * Raw **Flight Order Management DELETE** (`reason` required). An attached booking is marked cancelled without
   * refund or notification — prefer {@link ConsoleBookingsApi.cancel} for bookings of the OTA.
   *
   * - HTTP: `DELETE /v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}?reason=…` → `200` (Amadeus 204).
   * - Amadeus: Flight Order Management `DELETE /v1/booking/flight-orders/{id}` (cancelFlightOrder).
   * - Keys: secret key + staff token (`amadeus:write`). Server action behind a confirmation dialog.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404, unknown or already cancelled)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * await requireStaff({ permissions: ["amadeus:write"] }); // in the server action
   * const r = await (await consoleServer()).amadeus.cancelFlightOrder({ flightOrderId, reason: "Duplicate test order" });
   * if (r.bookingId) revalidatePath(`/console/bookings/${r.bookingId}`);
   * ```
   */
  cancelFlightOrder(params: ConsoleAmadeusCancelFlightOrderParams, options?: RequestOptions): Promise<ConsoleAmadeusCancelResult>;

  /**
   * Raw **Get Flight Order By Record Locator** (`reference`, `originSystemCode` default GDS, `include`) — verbatim
   * orders + `matches` (order ↔ booking of this OTA). For lookup + import prefer
   * {@link ConsoleBookingsApi.findByRecordLocator}.
   *
   * - HTTP: `GET /v1/console/amadeus/v1/booking/flight-orders/by-reference?reference=K7M2QF&originSystemCode=GDS`.
   * - Amadeus: Get Flight Order By Record Locator `GET /v1/booking/flight-orders/by-reference` (getFlightOrder).
   * - Keys: secret key + staff token (`amadeus:read`). Server component.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * const r = await (await consoleServer()).amadeus.getFlightOrderByReference({ reference: "K7M2QF", include: ["bags"] });
   * const orders = r.amadeus.data; // AmadeusFlightOrder[]
   * ```
   */
  getFlightOrderByReference(params: ConsoleAmadeusGetFlightOrderByReferenceParams, options?: RequestOptions): Promise<ConsoleAmadeusFlightOrdersByReferenceResult>;

  /**
   * Raw **Queue List** (`queueId`, `max`, `category`, `officeId` verbatim) → verbatim PNR list; the read is also
   * stored as a queue snapshot (`result.queueSnapshotId`). For PNRs linked to bookings prefer
   * {@link ConsoleQueuesApi.list}.
   *
   * - HTTP: `GET /v1/console/amadeus/office/queues/{queueId}?max=5&category=0&officeId=NCE1A0950`.
   * - Amadeus: Queue List `GET /office/queues/{queue-id}`.
   * - Keys: secret key + staff token (`amadeus:read`). Server component.
   *
   * @throws ValidationError `VALIDATION_FAILED` (400); `SUPPLIER_REJECTED` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `OFFICE_NOT_ALLOWED` / `FORBIDDEN` / `FEATURE_DISABLED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```ts
   * const q = await (await consoleServer()).amadeus.getQueue({ queueId: 50, max: 5, category: 0 });
   * const pnrs = (q.amadeus.data ?? []).map((p) => p.id);
   * ```
   */
  getQueue(params: ConsoleAmadeusGetQueueParams, options?: RequestOptions): Promise<ConsoleAmadeusQueueResult>;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Root                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The staff console namespace (`client.console`). Secret key required — server-side only (server components, server
 * actions, route handlers). See the module documentation for tokens, roles and caching.
 */
export interface ConsoleApi {
  /** Staff sign-in (portal credentials or portal token), refresh, sign-out, me. */
  readonly auth: ConsoleAuthApi;
  /** All bookings of the OTA, PNR lookup and import, Amadeus order retrieve / create / patch / issue / cancel, resync, notes. */
  readonly bookings: ConsoleBookingsApi;
  /** Amadeus office queues and stored queue snapshots. */
  readonly queues: ConsoleQueuesApi;
  /** Customers of the OTA with statistics and bookings. */
  readonly customers: ConsoleCustomersApi;
  /** Redacted Amadeus call log. */
  readonly supplierRequests: ConsoleSupplierRequestsApi;
  /** Raw Amadeus pass-through (verbatim request / response), one method per Amadeus operation. */
  readonly amadeus: ConsoleAmadeusApi;
}
