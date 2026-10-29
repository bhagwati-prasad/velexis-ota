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
  // Storefront content (OBE-091): the published pages (the public images: OBE-071)
  listStorefrontPages: "OBE-072",
  getStorefrontPage: "OBE-072",
  // Customer account and saved travellers (account.get, account.update and account.delete: OBE-035)
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
  // Customer bookings
  getBookingAncillaries: "deferred",
  addBookingAncillaries: "deferred",
  createBookingPayment: "deferred",
  // Console: bookings
  consoleCreateBooking: "deferred",
  // Console: raw Amadeus writes (the eight reads: OBE-067; OADR-0011 point 7)
  consoleAmadeusCreateFlightOrders: "deferred",
  consoleAmadeusIssueFlightOrder: "deferred",
  consoleAmadeusCancelFlightOrder: "deferred",
  consoleAmadeusPatchFlightOrder: "deferred",
  // Console settings (OBE-091): content pages (the storefront images: OBE-071)
  consoleListStorefrontPages: "OBE-072",
  consoleCreateStorefrontPage: "OBE-072",
  consoleGetStorefrontPage: "OBE-072",
  consoleUpdateStorefrontPage: "OBE-072",
  consoleDeleteStorefrontPage: "OBE-072",
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
