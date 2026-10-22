// The route-parity allow-list (ADR-0006 "Route parity", plan rule 4 of ota/docs/plans/agent-tasks.md): every operation
// of the OTA document that has no handler yet, with the plan task that implements it, or "deferred" for an operation
// the MVP leaves out (`x-milestone: deferred`, scope.md §3). Each listed route answers `501 NOT_IMPLEMENTED` with
// `details.milestone` (not-implemented.controller.ts).
//
// The task that implements an operation removes its entry in the same change; a spec task that adds an operation
// adds one. The route-parity contract test fails when an operation has neither a handler nor an entry, when it has
// both, when an entry names no operation, and when a task id is not a task of the plan with the operation's
// milestone. At the M4 exit only `deferred` entries (and the two M5 webhooks of OBE-078) remain (OBE-075).
import type { OtaOperationId } from "@velexis/api-types/operations";

/** The plan task that implements an operation (`OBE-016`), or `"deferred"` for an operation outside the MVP. */
export type PendingTask = `OBE-${number}` | "deferred";

export const PENDING_OPERATIONS: Readonly<Partial<Record<OtaOperationId, PendingTask>>> = Object.freeze({
  // Storefront
  resolveStorefrontHost: "deferred",
  // Customer account and saved travellers
  getAccount: "OBE-035",
  updateAccount: "OBE-035",
  deleteAccount: "OBE-035",
  getAccountPreferences: "deferred",
  updateAccountPreferences: "deferred",
  createAccountDataExport: "deferred",
  getAccountDataExport: "deferred",
  listSavedTravelers: "deferred",
  createSavedTraveler: "deferred",
  getSavedTraveler: "deferred",
  deleteSavedTraveler: "deferred",
  updateSavedTraveler: "deferred",
  // Flights
  searchFlightAvailabilities: "deferred",
  // Checkout and payments
  completeCheckoutWithAirlineCard: "OBE-051",
  // Customer bookings
  updateBooking: "OBE-048",
  quoteBookingCancellation: "OBE-049",
  cancelBooking: "OBE-049",
  listBookingDocuments: "OBE-054",
  getBookingDocumentDownloadUrl: "OBE-054",
  getBookingAncillaries: "deferred",
  addBookingAncillaries: "deferred",
  createBookingPayment: "deferred",
  // Console: bookings
  consoleCreateBooking: "deferred",
  consoleIssueBooking: "OBE-063",
  consoleCancelBooking: "OBE-063",
  consoleFindBookingByRecordLocator: "OBE-064",
  consoleImportBooking: "OBE-064",
  // Console: queues, customers, supplier log
  consoleListQueue: "OBE-065",
  consoleListQueueSnapshots: "OBE-065",
  consoleListCustomers: "OBE-066",
  consoleGetCustomer: "OBE-066",
  consoleListSupplierRequests: "OBE-066",
  // Console: raw Amadeus (reads in M4, writes deferred)
  consoleAmadeusGetFlightOffers: "OBE-067",
  consoleAmadeusSearchFlightOffers: "OBE-067",
  consoleAmadeusSearchFlightAvailabilities: "OBE-067",
  consoleAmadeusUpsellAirOffers: "OBE-067",
  consoleAmadeusQuoteAirOffers: "OBE-067",
  consoleAmadeusGetFlightOrder: "OBE-067",
  consoleAmadeusGetFlightOrderByReference: "OBE-067",
  consoleAmadeusGetQueue: "OBE-067",
  consoleAmadeusCreateFlightOrders: "deferred",
  consoleAmadeusIssueFlightOrder: "deferred",
  consoleAmadeusCancelFlightOrder: "deferred",
  consoleAmadeusPatchFlightOrder: "deferred",
  // Console settings (OBE-058): markup and fee rules, notification templates (the storefront settings: OBE-070)
  consoleListMarkupRules: "OBE-069",
  consoleCreateMarkupRule: "OBE-069",
  consoleGetMarkupRule: "OBE-069",
  consoleUpdateMarkupRule: "OBE-069",
  consoleDeleteMarkupRule: "OBE-069",
  consoleListFeeRules: "OBE-069",
  consoleCreateFeeRule: "OBE-069",
  consoleGetFeeRule: "OBE-069",
  consoleUpdateFeeRule: "OBE-069",
  consoleDeleteFeeRule: "OBE-069",
  consoleListNotificationTemplates: "OBE-073",
  consoleGetNotificationTemplate: "OBE-073",
  consolePutNotificationTemplate: "OBE-073",
  consolePreviewNotificationTemplate: "OBE-073",
  consoleResetNotificationTemplate: "OBE-073",
  // Console payments (OBE-090)
  consoleListPayments: "OBE-068",
  consoleGetPayment: "OBE-068",
  consoleCapturePayment: "OBE-068",
  consoleRefundPayment: "OBE-068",
  // Stripe webhooks of the Connect and API-key modes (OBE-090 documents them in M4; served from M5)
  receiveStripeConnectWebhook: "OBE-078",
  receiveStripeConnectionWebhook: "OBE-078",
});

/**
 * Routes the API serves outside the OTA document, so they are no operation's handler. None since OBE-090 documented
 * the health endpoints (ADR-0016) as `healthLive` and `healthReady`, whose handler is HealthController. A route added
 * here needs a reason the document cannot have it; the route-parity test fails for a listed route that is not served
 * or that the document has.
 */
export const UNDOCUMENTED_ROUTES: readonly string[] = Object.freeze([]);
