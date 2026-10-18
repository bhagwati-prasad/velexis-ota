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
  // Customer auth
  signUp: "OBE-032",
  verifyEmail: "OBE-032",
  resendEmailVerification: "OBE-032",
  requestPasswordReset: "OBE-034",
  resetPassword: "OBE-034",
  changePassword: "OBE-034",
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
  createCheckout: "OBE-036",
  getCheckout: "OBE-036",
  setCheckoutTravelers: "OBE-036",
  setCheckoutContacts: "OBE-036",
  setCheckoutRemarks: "OBE-036",
  setCheckoutAncillaries: "OBE-037",
  createCheckoutPayment: "OBE-038",
  getPayment: "OBE-038",
  updatePayment: "OBE-038",
  completeCheckout: "OBE-042",
  completeCheckoutWithAirlineCard: "OBE-051",
  // Customer bookings
  listBookings: "OBE-046",
  getBooking: "OBE-046",
  getBookingFareRules: "OBE-046",
  getBookingTicketingStatus: "OBE-046",
  listBookingEvents: "OBE-046",
  lookupBooking: "OBE-047",
  updateBooking: "OBE-048",
  quoteBookingCancellation: "OBE-049",
  cancelBooking: "OBE-049",
  listBookingDocuments: "OBE-054",
  getBookingDocumentDownloadUrl: "OBE-054",
  getBookingAncillaries: "deferred",
  addBookingAncillaries: "deferred",
  createBookingPayment: "deferred",
  // Console: staff sessions
  consoleSignIn: "OBE-059",
  consoleRefreshSession: "OBE-059",
  consoleSignOut: "OBE-059",
  consoleGetMe: "OBE-059",
  // Console: bookings
  consoleListBookings: "OBE-061",
  consoleGetBooking: "OBE-061",
  consoleCreateBooking: "deferred",
  consoleRetrieveFlightOrder: "OBE-062",
  consolePatchBooking: "OBE-062",
  consoleResyncBooking: "OBE-062",
  consoleAddBookingNote: "OBE-062",
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
  // Console settings (OBE-058): markup and fee rules, storefront settings, notification templates
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
  consoleGetStorefrontSettings: "OBE-070",
  consoleUpdateStorefrontSettings: "OBE-070",
  consoleListNotificationTemplates: "OBE-073",
  consoleGetNotificationTemplate: "OBE-073",
  consolePutNotificationTemplate: "OBE-073",
  consolePreviewNotificationTemplate: "OBE-073",
  consoleResetNotificationTemplate: "OBE-073",
});

/**
 * Routes the API serves outside the OTA document, so they are no operation's handler: the health endpoints
 * (ADR-0016) until OBE-090 documents them as `healthLive` and `healthReady` and removes them here. The route-parity
 * test fails for a listed route that is not served or that the document has.
 */
export const UNDOCUMENTED_ROUTES: readonly string[] = Object.freeze([
  "GET /health/live",
  "GET /health/ready",
]);
