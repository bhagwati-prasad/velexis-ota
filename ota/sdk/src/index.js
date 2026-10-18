// @velexis/ota-sdk public entry (mirrors docs/velexis-sdk/sdk/src/index.d.ts, ADR-0019): `createVelexisClient`,
// `VERSION`, everything of shared.js (the error classes, `isVelexisError`, `Page` and the shared typedefs) and of the
// public namespace modules (their typedefs and factories, OADR-0016 point 1). A client offers the namespaces of the
// milestones built so far, `withOptions` and `request`: M2 brings `storefront`, `reference` and `flights` (SDK-005),
// M3 `checkout` (SDK-009) and `bookings` (SDK-010); `auth`, `account` (M3) and `console` (M4) follow.
import { createBookingsApi, createCheckoutApi } from "./bookings.js";
import { createFlightsApi } from "./flights.js";
import { createReferenceApi, createStorefrontApi } from "./identity.js";
import { createCore } from "./internal/client.js";

export * from "./shared.js";
export * from "./identity.js";
export * from "./flights.js";
export * from "./bookings.js";
export { VERSION } from "./version.js";

/** @typedef {import("./shared.js").VelexisClientOptions} VelexisClientOptions */
/** @typedef {import("./shared.js").RequestOptions} RequestOptions */

/** HTTP methods accepted by `VelexisClient.request`. @typedef {"GET" | "POST" | "PUT" | "PATCH" | "DELETE"} HttpMethod */

/**
 * A configured Velexis client. All namespaces and methods share the client's keys, tokens and defaults.
 * @typedef {object} VelexisClient
 * @property {import("./identity.js").StorefrontApi} storefront storefront bootstrap (branding, locales, currencies,
 *   features, payment provider public config)
 * @property {import("./identity.js").ReferenceApi} reference airports, cities, airlines, countries, currencies
 *   (platform reference data)
 * @property {import("./flights.js").FlightsApi} flights flight search, offer details, branded-fare upsell, pricing,
 *   fare rules, ancillary options and the console's availability search
 * @property {import("./bookings.js").CheckoutApi} checkout checkout session: travellers, contacts, ancillaries,
 *   payment, completion (creates the booking), and the hosted storefront's airline-card completion
 * @property {import("./bookings.js").BookingsApi} bookings customer and guest bookings: "My trips", detail, guest
 *   lookup, changes, extras after booking, cancellation, documents, timeline and ticketing status
 * @property {(overrides: Partial<VelexisClientOptions>) => VelexisClient} withOptions a new client with some options
 *   replaced (for example a per-request access token on the server); it shares nothing mutable with this one
 * @property {<T = unknown>(method: HttpMethod, path: string, init?: { query?: Record<string, string | number | boolean | string[] | undefined>, body?: unknown, options?: RequestOptions }) => Promise<T>} request
 *   low-level escape hatch for endpoints that are not wrapped yet; applies keys, tokens, retries and error mapping
 */

/**
 * Creates a client. Pass `publishableKey` in browser code and `secretKey` only on the server.
 * @param {VelexisClientOptions} options
 * @returns {VelexisClient}
 * @throws {TypeError} when an option is unknown or invalid, before any request
 */
export function createVelexisClient(options) {
  const core = createCore(options);
  return {
    storefront: createStorefrontApi(core),
    reference: createReferenceApi(core),
    flights: createFlightsApi(core),
    checkout: createCheckoutApi(core),
    bookings: createBookingsApi(core),
    withOptions: (overrides) => createVelexisClient(core.derive(overrides)),
    request: (method, path, init) => core.request(method, path, init),
  };
}
