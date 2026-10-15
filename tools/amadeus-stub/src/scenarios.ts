// Scenarios of the Amadeus stub (X-026, ADR-0015) and the Amadeus error envelope they answer with.
//
// A scenario is chosen per request with the header `X-Stub-Scenario`, or for every request with the server's default
// scenario (`createStubServer({ defaultScenario })`, `server.setDefaultScenario()`); the header wins. The generic
// scenarios apply to every route, the token endpoint included, after authentication and request validation, so a
// malformed or unauthenticated request still fails loudly whatever the scenario. An unknown name is a 400, never a
// silent success. Magic values (destination `ZZZ`) select behaviour without a header, for end-to-end runs where the
// browser cannot set one.
//
// Operation-specific scenarios change only the operations that know them, in their handlers; every other route, the
// token endpoint included, answers as for `success`, so a default scenario can be set for a whole flow. OBE-019 adds
// `sold-out` (Flight Offers Price and Branded Fares Upsell answer error 34651) and `price-changed` (Flight Offers Price
// answers a higher total with warning 37200). OBE-041 adds the order operations and their scenarios:
//   - `sold-out` also refuses Flight Create Orders (34651, no order stored);
//   - `ticketing-failed`: Flight Order Issue answers 9112 (TICKETING - TKT); Flight Create Orders with `issue=true`
//     stores the order without tickets and answers 201 with warning 9112;
//   - `version-conflict`: Flight Order Management PATCH answers 409 with 2552 (SIMULTANEOUS UPDATE);
//   - `timeout` at an order write (create, issue, PATCH, DELETE) applies the write, then holds the answer as
//     everywhere else: the order exists although the client never heard so, and reconciliation can find it;
//   - `timeout-lost` holds the answer of an order write without applying it (no order stored); every other route
//     answers as for `success`.

/** The request header that selects a scenario (case-insensitive, as every HTTP header). */
export const SCENARIO_HEADER = "X-Stub-Scenario";

/**
 * Every scenario name the stub knows. `success` is the normal behaviour: it lets one request opt out of a default
 * scenario set on the server.
 */
export const STUB_SCENARIOS = [
  "success",
  "server-error",
  "rate-limited",
  "timeout",
  "sold-out",
  "price-changed",
  "ticketing-failed",
  "version-conflict",
  "timeout-lost",
] as const;
export type StubScenario = (typeof STUB_SCENARIOS)[number];

export function isStubScenario(value: string): value is StubScenario {
  return (STUB_SCENARIOS as readonly string[]).includes(value);
}

/** How long the `timeout` scenario holds a response before it gives up with a 504. */
export const TIMEOUT_HOLD_MS = 30_000;

/**
 * Flight Offers Search (GET `destinationLocationCode`, any POST origin-destination) and Flight Availabilities Search
 * (any origin-destination) for this destination find nothing.
 */
export const NO_OFFERS_DESTINATION = "ZZZ";

/** How much `price-changed` raises the base and the total of each traveller pricing, in major units of the currency. */
export const PRICE_CHANGE_PER_TRAVELER = 10;

/** Amadeus's error codes that the stub answers with (the `code` of an `Issue`). */
export const AMADEUS_ERROR_CODES = Object.freeze({
  /** OAuth: invalid or missing parameters or credentials (`error` says which). */
  oauthInvalidParameters: 38187,
  /** The bearer token is not one the server issued. */
  invalidAccessToken: 38190,
  /** No `Authorization: Bearer <token>` header. */
  invalidHttpHeader: 38191,
  /** The bearer token has expired. */
  accessTokenExpired: 38192,
  /** Rate limit exceeded. */
  tooManyRequests: 38194,
  /** No such route (method and path). */
  resourceNotFound: 38196,
  /** Generic system error (the `Error_500` example of the specifications). */
  systemError: 141,
  /** A parameter or body field has the wrong type, pattern or format. */
  invalidFormat: 477,
  /** A value outside the allowed enumeration. */
  invalidOption: 572,
  /** Any other invalid value (range, length, unknown parameter). */
  invalidDataReceived: 4926,
  /** A mandatory parameter, header or body field is missing. */
  mandatoryDataMissing: 32171,
  /** Segment sell failure: no seat left in the booking class (`sold-out`). */
  segmentSellFailure: 34651,
  /** Price discrepancy: the current price differs from the requested one (`price-changed`, a warning at pricing). */
  priceDiscrepancy: 37200,
  /** The credit card of a form of payment was refused (the test card `4000000000000002`). */
  creditCardNotAccepted: 1304,
  /** Ticketing failed (`ticketing-failed`; an error at issuance, a warning at a create order with `issue=true`). */
  ticketing: 9112,
  /** Simultaneous update: the order changed meanwhile (`version-conflict` at Flight Order Management PATCH). */
  simultaneousUpdate: 2552,
  /** No flight order with this id or record locator (the specifications' `Error_404` example). */
  notFound: 1797,
} as const);

/**
 * The stub's own codes, for answers Amadeus never gives. They start at 90000 so that a client's error mapping never
 * confuses them with an Amadeus code.
 */
export const STUB_ERROR_CODES = Object.freeze({
  internalError: 90000,
  unknownScenario: 90001,
  notStubbed: 90002,
  payloadTooLarge: 90003,
} as const);

/** One entry of the `errors` array of an Amadeus error response (the specifications' `Issue`). */
export interface AmadeusIssue {
  readonly status: number;
  readonly code: number;
  readonly title: string;
  readonly detail?: string;
  /** At most one key, as the specifications' `Issue_Source` (`maxProperties: 1`). */
  readonly source?: { readonly parameter: string } | { readonly pointer: string };
}

/** What a route answers: the status, the JSON body and the media type (default `application/vnd.amadeus+json`). */
export interface StubResponse {
  readonly status: number;
  readonly body: unknown;
  readonly contentType?: string;
}

/** The media type of every Amadeus API response (the specifications' `produces`). */
export const AMADEUS_JSON = "application/vnd.amadeus+json";

/** An Amadeus error response `{ "errors": [...] }`, with the HTTP status of the first issue. */
export function amadeusErrorResponse(issues: readonly [AmadeusIssue, ...AmadeusIssue[]]): StubResponse {
  return { status: issues[0].status, body: { errors: issues } };
}

/** An answer the server holds for `holdMs` before it sends `afterHold` (unless the client goes away first). */
export interface HeldResponse {
  readonly kind: "hold";
  readonly holdMs: number;
  readonly afterHold: StubResponse;
}

/** What a scenario does to a request that passed authentication and validation. */
export type ScenarioOutcome =
  | { readonly kind: "continue" }
  | { readonly kind: "respond"; readonly response: StubResponse }
  | HeldResponse;

/** Whether a handler's result is a held answer rather than a response to send now. */
export function isHeld(result: StubResponse | HeldResponse): result is HeldResponse {
  return "kind" in result && result.kind === "hold";
}

const SERVER_ERROR: StubResponse = amadeusErrorResponse([
  {
    status: 500,
    code: AMADEUS_ERROR_CODES.systemError,
    title: "SYSTEM ERROR HAS OCCURRED",
    detail: "Stub scenario server-error",
  },
]);

const RATE_LIMITED: StubResponse = amadeusErrorResponse([
  {
    status: 429,
    code: AMADEUS_ERROR_CODES.tooManyRequests,
    title: "Too many requests",
    detail: "The network rate limit is exceeded, please try again later",
  },
]);

const TIMED_OUT: StubResponse = amadeusErrorResponse([
  {
    status: 504,
    code: AMADEUS_ERROR_CODES.systemError,
    title: "SYSTEM ERROR HAS OCCURRED",
    detail: `Stub scenario timeout: no answer within ${TIMEOUT_HOLD_MS / 1000} s`,
  },
]);

/** The held answer of `timeout` (and of `timeout-lost` at an order write): a 504 after 30 s. */
export function timedOut(): HeldResponse {
  return { kind: "hold", holdMs: TIMEOUT_HOLD_MS, afterHold: TIMED_OUT };
}

/**
 * What `scenario` does to any route. The operation-specific scenarios continue to the operation's handler, which
 * applies them or, when the operation does not know them, answers as for `success`. `writesOrder` marks the order
 * writes (Flight Create Orders, Flight Order Issue, Management PATCH and DELETE): their handlers apply `timeout`
 * themselves, after the write, so it continues to them too.
 */
export function applyScenario(scenario: StubScenario, writesOrder = false): ScenarioOutcome {
  switch (scenario) {
    case "success":
    case "sold-out":
    case "price-changed":
    case "ticketing-failed":
    case "version-conflict":
    case "timeout-lost":
      return { kind: "continue" };
    case "server-error":
      return { kind: "respond", response: SERVER_ERROR };
    case "rate-limited":
      return { kind: "respond", response: RATE_LIMITED };
    case "timeout":
      return writesOrder ? { kind: "continue" } : timedOut();
  }
}

/**
 * The scenario of a request: the `X-Stub-Scenario` header when present, otherwise the server's default. An unknown
 * or repeated header is a 400 that names the header and lists the known scenarios.
 */
export function resolveScenario(
  header: string | readonly string[] | undefined,
  defaultScenario: StubScenario,
): { readonly scenario: StubScenario } | { readonly error: StubResponse } {
  if (header === undefined) {
    return { scenario: defaultScenario };
  }
  const value = typeof header === "string" ? header.trim() : undefined;
  if (value !== undefined && isStubScenario(value)) {
    return { scenario: value };
  }
  return {
    error: amadeusErrorResponse([
      {
        status: 400,
        code: STUB_ERROR_CODES.unknownScenario,
        title: "UNKNOWN STUB SCENARIO",
        detail: `${SCENARIO_HEADER} must be exactly one of: ${STUB_SCENARIOS.join(", ")}`,
        source: { parameter: SCENARIO_HEADER },
      },
    ]),
  };
}

/**
 * `sold-out` at Flight Offers Price, Branded Fares Upsell or Flight Create Orders: a 400 with error 34651 for the
 * first segment of the posted flight offers, as Amadeus answers when the booking class has no seat left.
 */
export function soldOutResponse(segmentId: string | undefined): StubResponse {
  return amadeusErrorResponse([
    {
      status: 400,
      code: AMADEUS_ERROR_CODES.segmentSellFailure,
      title: "SEGMENT SELL FAILURE",
      detail: segmentId === undefined ? "Could not sell segment" : `Could not sell segment ${segmentId}`,
    },
  ]);
}

/** The warning of a `price-changed` pricing (the 200 response's `warnings`). */
export const PRICE_DISCREPANCY_WARNING: AmadeusIssue = Object.freeze({
  status: 200,
  code: AMADEUS_ERROR_CODES.priceDiscrepancy,
  title: "PRICE DISCREPANCY",
  detail: "Current grandTotal price is different from request one",
});

/** True when a Flight Offers or Flight Availabilities Search for these destination codes finds nothing (`ZZZ`). */
export function findsNoOffers(destinationCodes: readonly unknown[]): boolean {
  return destinationCodes.some((code) => code === NO_OFFERS_DESTINATION);
}

/** `ticketing-failed` at Flight Order Issue: a 400 with error 9112, the order stays without tickets. */
export const TICKETING_FAILED: StubResponse = amadeusErrorResponse([
  {
    status: 400,
    code: AMADEUS_ERROR_CODES.ticketing,
    title: "TICKETING - TKT",
    detail: "Stub scenario ticketing-failed: the flight order was not issued",
  },
]);

/** The warning of a Flight Create Orders with `issue=true` under `ticketing-failed` (the 201 response's `warnings`). */
export const TICKETING_FAILED_WARNING: AmadeusIssue = Object.freeze({
  status: 201,
  code: AMADEUS_ERROR_CODES.ticketing,
  title: "TICKETING - TKT",
  detail: "Stub scenario ticketing-failed: the flight order was created but not issued",
});

/** `version-conflict` at Flight Order Management PATCH: a 409 with error 2552, the order unchanged. */
export const VERSION_CONFLICT: StubResponse = amadeusErrorResponse([
  {
    status: 409,
    code: AMADEUS_ERROR_CODES.simultaneousUpdate,
    title: "SIMULTANEOUS UPDATE",
    detail: "Stub scenario version-conflict: the flight order was updated meanwhile",
  },
]);
