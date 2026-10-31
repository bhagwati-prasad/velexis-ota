// The limits of the Amadeus client (OADR-0001 points 6 and 7, flows/amadeus-connection-and-tokens.md §4, ADR-0012;
// OBE-018): the 12 operations with their specification, method, path, timeout and retry class, the token buckets and
// the retry delay. Everything here is a constant, and tests pass their own `AmadeusLimits` (shorter timeouts, other
// buckets) to the client and the rate limiter through the `AMADEUS_LIMITS` injection token. The M2 load test (OBE-028,
// the ADR-0012 follow-up) kept the bucket sizes: ota/docs/performance.md §3 has the figures and the reasons. The
// timeouts cannot be measured against the stub; they stay as planned until the Amadeus test environment shows its
// latencies.
//
//   Operation                                       Timeout  Automatic retry
//   OAuth token                                     10 s     1 (network, timeout, 5xx; the timeout is the token
//                                                            provider's TOKEN_REQUEST_TIMEOUT_MS)
//   Flight Offers Search (GET, POST)                30 s     1
//   Flight Availabilities Search, Branded Fares     20 s     1
//   Flight Offers Price                             20 s     1
//   Flight Create Orders                            60 s     never (reconcile, OADR-0003)
//   Flight Order Issue                              60 s     never (resync before the job retries)
//   Flight Order Management GET, by reference, QL   15 s     1
//   Flight Order Management PATCH, DELETE           30 s     never (resync / reconcile)
//
// A retry waits 300–800 ms with jitter. Reads are retried once on a network error, a timeout or a `5xx`; writes are
// never retried by the client, because a write that timed out may have happened at Amadeus. A `401` of any operation
// drops the token and sends the request once more with a new one: Amadeus refused it before doing anything.
/** The 9 Amadeus APIs, as `supplier_requests.amadeus_api` names them (the specification file prefix). */
export type AmadeusApi =
  | "FlightOffersSearch"
  | "FlightAvailabilitiesSearch"
  | "BrandedFaresUpsell"
  | "FlightOffersPrice"
  | "FlightCreateOrders"
  | "FlightOrderIssue"
  | "FlightOrderManagement"
  | "GetFlightOrderByRecordLocator"
  | "QueueList";

/** The `AmadeusClient` method of each operation, as the stub and the OTA document's `x-amadeus` entries name them. */
export type AmadeusOperationName =
  | "searchFlightOffers"
  | "getFlightOffers"
  | "searchFlightAvailabilities"
  | "upsellAirOffers"
  | "quoteAirOffers"
  | "createFlightOrders"
  | "issueFlightOrder"
  | "getFlightOrder"
  | "patchFlightOrder"
  | "cancelFlightOrder"
  | "getFlightOrderByReference"
  | "listQueue";

/** `read`: retried once on a network error, a timeout or a `5xx`; `write`: never retried (it may have happened). */
export type RetryClass = "read" | "write";

/** Which office of the connection a call acts for (`supplier_requests.office_id`) and which it may fill in. */
export type OfficeRole =
  /** Shopping: the connection's default office. */
  | "shopping"
  /** Flight Create Orders: `queuingOfficeId` and `ownerOfficeId` of the body, filled from the connection. */
  | "create"
  /** An existing order: the booking's office (`orderOffice` of the call context), else the owner office. */
  | "order"
  /** Get Flight Order by record locator: the retrieval office. */
  | "retrieval"
  /** Queue List: `officeId` of the query, filled with the queue office. */
  | "queue";

export interface AmadeusOperationSpec {
  readonly name: AmadeusOperationName;
  readonly api: AmadeusApi;
  /** The specification's `operationId` (`createFligtOrders` sic, Queue List's is its path key). */
  readonly operationId: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path after the base URL, with `{param}` templates (the stub's route table). */
  readonly path: string;
  /** `X-HTTP-Method-Override: GET` on a POST search (Flight Offers Search POST, Flight Availabilities Search). */
  readonly methodOverride: boolean;
  readonly retry: RetryClass;
  readonly office: OfficeRole;
}

function operation(
  name: AmadeusOperationName,
  api: AmadeusApi,
  operationId: string,
  method: AmadeusOperationSpec["method"],
  path: string,
  retry: RetryClass,
  office: OfficeRole,
  methodOverride = false,
): AmadeusOperationSpec {
  return Object.freeze({ name, api, operationId, method, path, methodOverride, retry, office });
}

/** The 12 operations of ADR-0012, in the order of the OTA plan. */
export const AMADEUS_OPERATIONS: Readonly<Record<AmadeusOperationName, AmadeusOperationSpec>> = Object.freeze(
  {
    searchFlightOffers: operation(
      "searchFlightOffers",
      "FlightOffersSearch",
      "searchFlightOffers",
      "POST",
      "/v2/shopping/flight-offers",
      "read",
      "shopping",
      true,
    ),
    getFlightOffers: operation(
      "getFlightOffers",
      "FlightOffersSearch",
      "getFlightOffers",
      "GET",
      "/v2/shopping/flight-offers",
      "read",
      "shopping",
    ),
    searchFlightAvailabilities: operation(
      "searchFlightAvailabilities",
      "FlightAvailabilitiesSearch",
      "searchFlightAvailabilities",
      "POST",
      "/v1/shopping/availability/flight-availabilities",
      "read",
      "shopping",
      true,
    ),
    upsellAirOffers: operation(
      "upsellAirOffers",
      "BrandedFaresUpsell",
      "upsellAirOffers",
      "POST",
      "/v1/shopping/flight-offers/upselling",
      "read",
      "shopping",
    ),
    quoteAirOffers: operation(
      "quoteAirOffers",
      "FlightOffersPrice",
      "quoteAirOffers",
      "POST",
      "/v1/shopping/flight-offers/pricing",
      "read",
      "shopping",
    ),
    createFlightOrders: operation(
      "createFlightOrders",
      "FlightCreateOrders",
      "createFligtOrders",
      "POST",
      "/v1/booking/flight-orders",
      "write",
      "create",
    ),
    issueFlightOrder: operation(
      "issueFlightOrder",
      "FlightOrderIssue",
      "issueFlightOrder",
      "POST",
      "/v1/booking/flight-orders/{flight-orderId}/issuance",
      "write",
      "order",
    ),
    getFlightOrder: operation(
      "getFlightOrder",
      "FlightOrderManagement",
      "getFlightOrder",
      "GET",
      "/v1/booking/flight-orders/{flight-orderId}",
      "read",
      "order",
    ),
    patchFlightOrder: operation(
      "patchFlightOrder",
      "FlightOrderManagement",
      "patchFlightOrder",
      "PATCH",
      "/v1/booking/flight-orders/{flight-orderId}",
      "write",
      "order",
    ),
    cancelFlightOrder: operation(
      "cancelFlightOrder",
      "FlightOrderManagement",
      "cancelFlightOrder",
      "DELETE",
      "/v1/booking/flight-orders/{flight-orderId}",
      "write",
      "order",
    ),
    getFlightOrderByReference: operation(
      "getFlightOrderByReference",
      "GetFlightOrderByRecordLocator",
      "getFlightOrder",
      "GET",
      "/v1/booking/flight-orders/by-reference",
      "read",
      "retrieval",
    ),
    listQueue: operation(
      "listQueue",
      "QueueList",
      "GET/office/queues/{queue-id}",
      "GET",
      "/v1/office/queues/{queue-id}",
      "read",
      "queue",
    ),
  },
);

/** A token bucket: `burst` tokens at most, refilled at `ratePerSecond`. */
export interface TokenBucketLimit {
  readonly ratePerSecond: number;
  readonly burst: number;
}

/** Everything the client and the rate limiter take from this file; tests pass their own. */
export interface AmadeusLimits {
  /** The timeout of each operation, in milliseconds. */
  readonly timeoutMs: Readonly<Record<AmadeusOperationName, number>>;
  /** The wait before the one automatic retry: a uniform jitter between `min` and `max` milliseconds. */
  readonly retryDelayMs: { readonly min: number; readonly max: number };
  /** The bucket of a credential set, shared by every OTA on it (`rl:amadeus:cred:<credId>:<env>`). */
  readonly credentialBucket: TokenBucketLimit;
  /** The bucket of a tenant (`rl:amadeus:ten:<tenantId>:<env>`). */
  readonly tenantBucket: TokenBucketLimit;
}

/** Injection token of the `AmadeusLimits` (optional: `DEFAULT_AMADEUS_LIMITS` when nothing provides it). */
export const AMADEUS_LIMITS = "AMADEUS_LIMITS";

/** The limits of flow §4 and ADR-0012. */
export const DEFAULT_AMADEUS_LIMITS: AmadeusLimits = Object.freeze({
  timeoutMs: Object.freeze({
    searchFlightOffers: 30_000,
    getFlightOffers: 30_000,
    searchFlightAvailabilities: 20_000,
    upsellAirOffers: 20_000,
    quoteAirOffers: 20_000,
    createFlightOrders: 60_000,
    issueFlightOrder: 60_000,
    getFlightOrder: 15_000,
    patchFlightOrder: 30_000,
    cancelFlightOrder: 30_000,
    getFlightOrderByReference: 15_000,
    listQueue: 15_000,
  }),
  retryDelayMs: Object.freeze({ min: 300, max: 800 }),
  // Both buckets kept by the M2 load test (ota/docs/performance.md §3). The credential set's rate is the planning
  // figure for the shared Velexis account (ADR-0012): lower it when Amadeus states the account's real quota.
  credentialBucket: Object.freeze({ ratePerSecond: 20, burst: 20 }),
  tenantBucket: Object.freeze({ ratePerSecond: 5, burst: 10 }),
});

/** The jittered wait before a retry: `min` plus `random()` (0 ≤ r < 1) of the range, in whole milliseconds. */
export function retryDelayMs(limits: Pick<AmadeusLimits, "retryDelayMs">, random: () => number): number {
  const { min, max } = limits.retryDelayMs;
  return Math.round(min + Math.min(Math.max(random(), 0), 1) * (max - min));
}

/** True when the operation may be sent a second time after a network error, a timeout or a `5xx`. */
export function isRetryable(spec: AmadeusOperationSpec): boolean {
  return spec.retry === "read";
}
