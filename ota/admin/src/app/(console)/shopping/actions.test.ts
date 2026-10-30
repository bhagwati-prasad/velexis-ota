// The server actions of shopping on behalf (OAD-010) against the fake OTA API (OADR-0018 point 10): the real actions,
// `requireStaff` and the SDK, with the SDK's `fetch` answered by src/test/fake-ota-api.ts, so each test checks the exact
// request an action sends (method, path, query, `X-Velexis-Environment`, the service key, body) and the state it answers,
// without a running backend. Next.js's request scope (`cookies()`, `headers()`) and `redirect()` are mocked. Every
// token, id, offer and price here is a dummy.
import type { StaffRole } from "@velexis/ota-sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  apiError,
  fakeOtaApi,
  fakeRedirect,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", () => ({ redirect: vi.fn(fakeRedirect) }));
// The real client factory, watched: which clients `requireStaff` builds, with which retries (FIX-W34-OTA).
vi.mock("@/lib/velexis", async (importOriginal) => {
  const actual = await importOriginal<typeof VelexisModule>();
  return { ...actual, createConsoleClient: vi.fn(actual.createConsoleClient) };
});

import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";
import { createConsoleClient } from "@/lib/velexis";
import type * as VelexisModule from "@/lib/velexis";

import {
  quoteOffer,
  searchAvailability,
  searchOffers,
  upsellOffer,
  type AvailabilitySearchForm,
  type OfferSearchForm,
} from "./actions";

const ME = "GET /v1/console/auth/me";
const OFFERS = "POST /v1/console/amadeus/v2/shopping/flight-offers";
const AVAILABILITY = "POST /v1/console/amadeus/v1/shopping/availability/flight-availabilities";
const UPSELL = "POST /v1/console/amadeus/v1/shopping/flight-offers/upselling";
const PRICING = "POST /v1/console/amadeus/v1/shopping/flight-offers/pricing";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role` whose switch says `environment`. */
function signedIn(role: StaffRole = "agent", environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`shopping-actions-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-shopping-actions-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
}

/** The offer search form as a staff member fills it: a one-way trip for one adult, and `overrides`. */
function offerForm(overrides: Partial<OfferSearchForm> = {}): OfferSearchForm {
  return {
    origin: "mad",
    destination: " PAR ",
    departureDate: "2027-01-15",
    returnDate: "",
    adults: "1",
    children: "",
    infants: "",
    cabin: "",
    nonStop: false,
    carriers: "",
    currency: "",
    reason: "",
    ...overrides,
  };
}

/** The seat availability form: one seat Madrid to Paris on one day, and `overrides`. */
function availabilityForm(overrides: Partial<AvailabilitySearchForm> = {}): AvailabilitySearchForm {
  return {
    origin: "MAD",
    destination: "PAR",
    date: "2027-01-15",
    time: "",
    seats: "1",
    carriers: "",
    bookingClass: "",
    includeClosed: false,
    reason: "",
    ...overrides,
  };
}

/** An Amadeus flight offer as a search answers it (dummy, net price). */
const OFFER = Object.freeze({
  type: "flight-offer",
  id: "2",
  source: "GDS",
  lastTicketingDate: "2027-01-15",
  numberOfBookableSeats: 9,
  itineraries: [
    {
      duration: "PT2H5M",
      segments: [
        {
          departure: { iataCode: "MAD", terminal: "4", at: "2027-01-15T07:15:00" },
          arrival: { iataCode: "ORY", terminal: "1", at: "2027-01-15T09:20:00" },
          carrierCode: "IB",
          number: "3436",
          aircraft: { code: "32N" },
          duration: "PT2H5M",
          id: "3",
          numberOfStops: 0,
        },
      ],
    },
  ],
  price: { currency: "EUR", total: "98.47", base: "56.00", grandTotal: "98.47" },
  validatingAirlineCodes: ["IB"],
  travelerPricings: [
    {
      travelerId: "1",
      fareOption: "STANDARD",
      travelerType: "ADULT",
      price: { currency: "EUR", total: "98.47", base: "56.00" },
      fareDetailsBySegment: [
        { segmentId: "3", cabin: "ECONOMY", fareBasis: "ADNNALB4", brandedFare: "BASIC", class: "A" },
      ],
    },
  ],
});

/** The facts of the Amadeus call of a raw answer (`ConsoleAmadeusCall`). */
function call(amadeusApi: string, amadeusOperationId: string, path: string) {
  return {
    supplierRequestId: "sreq_01JA4H1A3C5E7G9J1L3N5Q7S9U",
    environment: "test",
    officeId: "OSLN12345",
    amadeusApi,
    amadeusOperationId,
    httpMethod: "POST",
    path,
    httpStatus: 200,
    durationMs: 1240,
    correlationId: "0005K2D7QX1JZT",
    staffActionId: "sact_01JA4H1A4D6F8H0K2M4P6R8T0W",
  };
}

/** The raw answers of the four operations. */
const ANSWERS = Object.freeze({
  offers: {
    call: call("FlightOffersSearch", "searchFlightOffers", "/v2/shopping/flight-offers"),
    amadeus: { meta: { count: 1 }, data: [OFFER], dictionaries: { carriers: { IB: "IBERIA" } } },
  },
  availability: {
    call: call(
      "FlightAvailabilitiesSearch",
      "searchFlightAvailabilities",
      "/v1/shopping/availability/flight-availabilities",
    ),
    amadeus: { meta: { count: 0 }, data: [] },
  },
  upsell: {
    call: call("BrandedFaresUpsell", "upsellAirOffers", "/v1/shopping/flight-offers/upselling"),
    amadeus: { meta: { count: 1 }, data: [{ ...OFFER, id: "1" }] },
  },
  pricing: {
    call: call("FlightOffersPrice", "quoteAirOffers", "/v1/shopping/flight-offers/pricing"),
    amadeus: { data: { type: "flight-offers-pricing", flightOffers: [OFFER] } },
  },
});

/** Every raw route answers its dummy answer. */
function amadeusAnswers(): void {
  api.on(OFFERS, () => Response.json(ANSWERS.offers, { headers: { "X-Request-Id": "req_offers" } }));
  api.on(AVAILABILITY, () =>
    Response.json(ANSWERS.availability, { headers: { "X-Request-Id": "req_avail" } }),
  );
  api.on(UPSELL, () => Response.json(ANSWERS.upsell, { headers: { "X-Request-Id": "req_upsell" } }));
  api.on(PRICING, () => Response.json(ANSWERS.pricing, { headers: { "X-Request-Id": "req_pricing" } }));
}

/** The one request of `route`, failing the test when there is not exactly one. */
function only(route: string): SentRequest {
  const sent = api.sent(route);
  expect(sent, route).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The requests besides `console.auth.me`. */
function actionRequests(): SentRequest[] {
  return api.requests.filter((request) => `${request.method} ${request.url.pathname}` !== ME);
}

/** The headers every raw call carries: the environment of the switch, the service key, the staff token. */
function expectConsoleHeaders(request: SentRequest, environment: "test" | "live"): void {
  expect(request.headers.get("X-Velexis-Environment")).toBe(environment);
  expect(request.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
  expect(request.headers.get("Authorization")).toMatch(/^Bearer /);
  expect(request.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
}

// Once per file: the first SDK call and the first Zod parse of a fresh worker are the slowest; on a busy CI runner they
// would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  amadeusAnswers();
  await searchOffers(offerForm());
  await quoteOffer({ offer: OFFER, reason: "", fareRules: false });
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  vi.mocked(createConsoleClient).mockClear();
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(
    new Headers({ "User-Agent": "Mozilla/5.0 Test", "X-Forwarded-For": "203.0.113.7" }),
  );
  amadeusAnswers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- searchOffers -------------------------------------------------------------------------------------------------------

describe("searchOffers", () => {
  it("[OAD-010 AC1] sends Flight Offers Search POST in the switch's environment and answers the verbatim net offers", async () => {
    signedIn("agent", "live");

    const state = await searchOffers(offerForm());

    const sent = only(OFFERS);
    expectConsoleHeaders(sent, "live");
    expect(sent.body).toEqual({
      amadeus: {
        originDestinations: [
          {
            id: "1",
            originLocationCode: "MAD",
            destinationLocationCode: "PAR",
            departureDateTimeRange: { date: "2027-01-15" },
          },
        ],
        travelers: [{ id: "1", travelerType: "ADULT" }],
        sources: ["GDS"],
        searchCriteria: { maxFlightOffers: 50, maxUpsellOffers: 0 },
      },
    });
    expect(state).toEqual({ ok: true, result: ANSWERS.offers });
    expect(actionRequests().map((request) => `${request.method} ${request.url.pathname}`)).toEqual([OFFERS]);
  });

  it("[OAD-010 AC1] sends a return, the travellers with each infant on an adult's lap, the cabin, airlines, non-stop, currency and reason", async () => {
    signedIn("owner");

    const state = await searchOffers(
      offerForm({
        returnDate: "2027-01-22",
        adults: "2",
        children: "1",
        infants: "1",
        cabin: "business",
        nonStop: true,
        carriers: "ib, af  IB",
        currency: "eur",
        reason: "  Caller asks for a business trip  ",
      }),
    );

    expect(state.ok).toBe(true);
    const sent = only(OFFERS);
    expectConsoleHeaders(sent, "test");
    expect(sent.body).toEqual({
      amadeus: {
        currencyCode: "EUR",
        originDestinations: [
          {
            id: "1",
            originLocationCode: "MAD",
            destinationLocationCode: "PAR",
            departureDateTimeRange: { date: "2027-01-15" },
          },
          {
            id: "2",
            originLocationCode: "PAR",
            destinationLocationCode: "MAD",
            departureDateTimeRange: { date: "2027-01-22" },
          },
        ],
        travelers: [
          { id: "1", travelerType: "ADULT" },
          { id: "2", travelerType: "ADULT" },
          { id: "3", travelerType: "CHILD" },
          { id: "4", travelerType: "HELD_INFANT", associatedAdultId: "1" },
        ],
        sources: ["GDS"],
        searchCriteria: {
          maxFlightOffers: 50,
          maxUpsellOffers: 0,
          flightFilters: {
            cabinRestrictions: [
              { cabin: "BUSINESS", coverage: "MOST_SEGMENTS", originDestinationIds: ["1", "2"] },
            ],
            carrierRestrictions: { includedCarrierCodes: ["IB", "AF"] },
            connectionRestriction: { maxNumberOfConnections: 0 },
          },
        },
      },
      reason: "Caller asks for a business trip",
    });
  });

  it("checks the form first and names each field the API would refuse, without a request", async () => {
    signedIn("agent");

    const state = await searchOffers(
      offerForm({
        origin: "M1",
        destination: "",
        departureDate: "2027-02-30",
        adults: "0",
        children: "x",
        cabin: "COACH",
        carriers: "IBERIA",
        currency: "EURO",
      }),
    );

    expect(state).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Check the highlighted fields and try again.",
      fieldErrors: {
        origin: "Enter a three-letter airport or city code, like CDG or PAR.",
        destination: "Enter a three-letter airport or city code, like CDG or PAR.",
        departureDate: "Enter a day as YYYY-MM-DD.",
        adults: "Enter 1 to 9 adults.",
        children: "Enter 0 to 8 children.",
        cabin: "Choose a cabin, or any.",
        carriers: "Enter up to 10 two-character airline codes, like AF KL.",
        currency: "Enter a three-letter currency code, like EUR, or leave it empty.",
      },
    });
    expect(actionRequests()).toEqual([]);
  });

  it("refuses a trip the API or Amadeus would refuse: the same origin and destination, a return before the departure, too many travellers", async () => {
    signedIn("agent");

    const state = await searchOffers(
      offerForm({
        destination: "MAD",
        returnDate: "2027-01-14",
        adults: "2",
        children: "8",
        infants: "3",
      }),
    );

    expect(state).toMatchObject({
      ok: false,
      fieldErrors: {
        destination: "Enter a destination other than the origin.",
        returnDate: "The return cannot be before the departure.",
        infants: "Enter at most one infant per adult.",
        children: "At most 9 travellers can take a seat (adults and children).",
      },
    });
    expect(actionRequests()).toEqual([]);
  });

  it("answers Amadeus's refusal with its issues and the request id, and the API's field errors on the form's fields", async () => {
    signedIn("agent");
    api.on(OFFERS, () =>
      apiError("SUPPLIER_REJECTED", 422, {
        details: {
          supplierRequestId: "sreq_01JA4H1A3C5E7G9J1L3N5Q7S9V",
          errors: [
            {
              status: 400,
              code: 425,
              title: "INVALID DATE",
              detail: "Date/Time is in the past",
              source: { pointer: "/originDestinations[0]/departureDateTimeRange/date" },
            },
          ],
        },
      }),
    );

    expect(await searchOffers(offerForm())).toEqual({
      ok: false,
      code: "SUPPLIER_REJECTED",
      message: "Amadeus refused the search.",
      requestId: "req_fake_1",
      supplierIssues: [
        {
          code: 425,
          title: "INVALID DATE",
          detail: "Date/Time is in the past",
          source: "/originDestinations[0]/departureDateTimeRange/date",
        },
      ],
    });

    api.on(OFFERS, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [
          {
            path: "/amadeus/originDestinations/1/departureDateTimeRange/date",
            code: "format",
            message: "Must be a date.",
          },
          {
            path: "/amadeus/searchCriteria/flightFilters/carrierRestrictions/includedCarrierCodes/0",
            code: "pattern",
          },
        ],
      }),
    );
    expect(await searchOffers(offerForm({ returnDate: "2027-01-20" }))).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      fieldErrors: { returnDate: "Must be a date.", carriers: "Not in the expected format." },
    });

    // `Retry-After: 60`: the SDK ends the call at once instead of retrying the 504 after its back-off (a wait above 30 s).
    api.on(OFFERS, () => apiError("SUPPLIER_TIMEOUT", 504, {}, { "Retry-After": "60" }));
    expect(await searchOffers(offerForm())).toMatchObject({
      ok: false,
      code: "SUPPLIER_TIMEOUT",
      message: "Amadeus did not answer in time. Search again.",
    });
  });
});

// ---- searchAvailability -------------------------------------------------------------------------------------------------

describe("searchAvailability", () => {
  it("[OAD-010 AC1] sends Flight Availabilities Search in the switch's environment with the day, time, seats, airlines and class", async () => {
    signedIn("admin", "live");

    const state = await searchAvailability(
      availabilityForm({
        time: "09:30",
        seats: "2",
        carriers: "IB",
        bookingClass: "y",
        includeClosed: true,
        reason: "Seats for a group",
      }),
    );

    const sent = only(AVAILABILITY);
    expectConsoleHeaders(sent, "live");
    expect(sent.body).toEqual({
      amadeus: {
        originDestinations: [
          {
            id: "1",
            originLocationCode: "MAD",
            destinationLocationCode: "PAR",
            departureDateTime: { date: "2027-01-15", time: "09:30:00" },
          },
        ],
        travelers: [
          { id: "1", travelerType: "ADULT" },
          { id: "2", travelerType: "ADULT" },
        ],
        sources: ["GDS"],
        searchCriteria: {
          includeClosedContent: true,
          class: "Y",
          flightFilters: { carrierRestrictions: { includedCarrierCodes: ["IB"] } },
        },
      },
      reason: "Seats for a group",
    });
    expect(state).toEqual({ ok: true, result: ANSWERS.availability });
  });

  it("sends the plain day without criteria, and checks the form first", async () => {
    signedIn("agent");

    expect((await searchAvailability(availabilityForm())).ok).toBe(true);
    expect(only(AVAILABILITY).body).toEqual({
      amadeus: {
        originDestinations: [
          {
            id: "1",
            originLocationCode: "MAD",
            destinationLocationCode: "PAR",
            departureDateTime: { date: "2027-01-15" },
          },
        ],
        travelers: [{ id: "1", travelerType: "ADULT" }],
        sources: ["GDS"],
      },
    });

    const state = await searchAvailability(
      availabilityForm({ time: "25:00", seats: "10", bookingClass: "YY", reason: "x".repeat(501) }),
    );
    expect(state).toMatchObject({
      ok: false,
      fieldErrors: {
        time: "Enter a time as HH:MM, or leave it empty.",
        seats: "Enter 1 to 9 seats.",
        bookingClass: "Enter one letter, like Y, or leave it empty.",
        reason: "Use at most 500 characters.",
      },
    });
    expect(api.sent(AVAILABILITY)).toHaveLength(1);
  });
});

// ---- upsellOffer and quoteOffer ---------------------------------------------------------------------------------------

describe("upsellOffer", () => {
  it("[OAD-010 AC1] sends Branded Fares Upsell of the one offer, verbatim, in the switch's environment", async () => {
    signedIn("agent", "live");

    const state = await upsellOffer({ offer: OFFER, reason: "Caller compares fares" });

    const sent = only(UPSELL);
    expectConsoleHeaders(sent, "live");
    expect(sent.body).toEqual({
      amadeus: { data: { type: "flight-offer-upsell", flightOffers: [OFFER] } },
      reason: "Caller compares fares",
    });
    expect(state).toEqual({ ok: true, result: ANSWERS.upsell });
  });

  it("refuses something that is not an offer of this page, without a request", async () => {
    signedIn("agent");

    for (const offer of [null, "1", { type: "flight-order", id: "1" }, { type: "flight-offer" }]) {
      expect(await upsellOffer({ offer, reason: "" })).toEqual({
        ok: false,
        code: "VALIDATION_FAILED",
        message: "This offer cannot be sent to Amadeus as it is. Search again.",
      });
    }
    expect(actionRequests()).toEqual([]);
  });
});

describe("quoteOffer", () => {
  it("[OAD-010 AC1] sends Flight Offers Price of the one offer with its bag options in the switch's environment", async () => {
    signedIn("agent", "live");

    const state = await quoteOffer({ offer: OFFER, reason: "", fareRules: false });

    const sent = only(PRICING);
    expectConsoleHeaders(sent, "live");
    expect(Object.fromEntries(sent.url.searchParams)).toEqual({ include: "bags" });
    expect(sent.body).toEqual({ amadeus: { data: { type: "flight-offer-pricing", flightOffers: [OFFER] } } });
    expect(state).toEqual({ ok: true, result: ANSWERS.pricing });
  });

  it("asks for the detailed fare rules when staff want them, with the search's reason", async () => {
    signedIn("owner");

    await quoteOffer({ offer: OFFER, reason: "Refund conditions", fareRules: true });

    const sent = only(PRICING);
    expect(sent.url.searchParams.get("include")).toBe("bags,detailed-fare-rules");
    expect(sent.body).toMatchObject({ reason: "Refund conditions" });
  });

  it("answers Amadeus's refusal of a sold-out offer in this page's words, with its issues", async () => {
    signedIn("agent");
    api.on(PRICING, () =>
      apiError("SUPPLIER_REJECTED", 422, {
        details: { errors: [{ status: 400, code: 37200, title: "PRICE DISCREPANCY" }] },
      }),
    );

    expect(await quoteOffer({ offer: OFFER, reason: "", fareRules: false })).toMatchObject({
      ok: false,
      code: "SUPPLIER_REJECTED",
      message: "Amadeus refused this offer. It may have sold out or changed: search again.",
      requestId: "req_fake_1",
      supplierIssues: [{ code: 37200, title: "PRICE DISCREPANCY" }],
    });
  });
});

// ---- Every action ---------------------------------------------------------------------------------------------------------

describe("every shopping action", () => {
  /** Each action once, with a valid input. */
  const everyAction = [
    () => searchOffers(offerForm()),
    () => searchAvailability(availabilityForm()),
    () => upsellOffer({ offer: OFFER, reason: "" }),
    () => quoteOffer({ offer: OFFER, reason: "", fareRules: true }),
  ];

  it("refuses a role without amadeus:read before any call, naming the permission", async () => {
    for (const role of ["finance", "viewer"] as const) {
      signedIn(role);
      for (const action of everyAction) {
        expect(await action()).toEqual({
          ok: false,
          code: "FORBIDDEN",
          message: "You do not have permission to do this (amadeus:read).",
        });
      }
    }
    expect(actionRequests()).toEqual([]);
  });

  it("[OAD-010 AC2] calls only raw console operations: never a customer-scope flights.* request such as /v1/flight-searches", async () => {
    signedIn("agent");

    for (const action of everyAction) {
      expect((await action()).ok).toBe(true);
    }

    const paths = actionRequests().map((request) => request.url.pathname);
    expect(paths).toEqual([
      "/v1/console/amadeus/v2/shopping/flight-offers",
      "/v1/console/amadeus/v1/shopping/availability/flight-availabilities",
      "/v1/console/amadeus/v1/shopping/flight-offers/upselling",
      "/v1/console/amadeus/v1/shopping/flight-offers/pricing",
    ]);
    expect(api.requests.filter((request) => request.url.pathname.startsWith("/v1/flight"))).toEqual([]);
    expect(api.requests.every((request) => request.url.pathname.startsWith("/v1/console/"))).toBe(true);
  });

  it("answers the session's and the API's refusals as states, never as thrown errors", async () => {
    signedIn("agent");
    api.on(UPSELL, () => apiError("TOKEN_EXPIRED", 401));
    expect(await upsellOffer({ offer: OFFER, reason: "" })).toMatchObject({
      ok: false,
      code: "TOKEN_EXPIRED",
      message: "Your session expired. Reload the page to continue.",
    });

    api.on(OFFERS, () => apiError("SUPPLIER_NOT_CONFIGURED", 424));
    expect(await searchOffers(offerForm())).toMatchObject({
      ok: false,
      code: "SUPPLIER_NOT_CONFIGURED",
      message: "No Amadeus connection is active for this environment. Set it up in the portal.",
      requestId: "req_fake_1",
    });
  });
});

// ---- Retries (lead decision (2d) of 2026-10-30) ----------------------------------------------------------------------------

describe("the retries of the shopping actions", () => {
  /** The `maxRetries` of each console client the action built, in order (`undefined`: the SDK's default). */
  function clientRetries(): (number | undefined)[] {
    return vi.mocked(createConsoleClient).mock.calls.map(([input]) => input.maxRetries);
  }

  it("[FIX-W34-OTA AC2] builds the searches' client with maxRetries 0, console.auth.me's with the SDK default", async () => {
    signedIn("agent");

    expect((await searchOffers(offerForm())).ok).toBe(true);
    // `requireStaff`'s client for console.auth.me first, then the search's own.
    expect(clientRetries()).toEqual([undefined, 0]);
    vi.mocked(createConsoleClient).mockClear();

    expect((await searchAvailability(availabilityForm())).ok).toBe(true);
    expect(clientRetries()).toEqual([undefined, 0]);
    vi.mocked(createConsoleClient).mockClear();

    // The upsell and the quote of one offer keep the default: one client, also for console.auth.me.
    expect((await upsellOffer({ offer: OFFER, reason: "" })).ok).toBe(true);
    expect((await quoteOffer({ offer: OFFER, reason: "", fareRules: false })).ok).toBe(true);
    expect(clientRetries()).toEqual([undefined, undefined]);
  });

  it("[FIX-W34-OTA AC2] sends a search that timed out at Amadeus once: its 504 SUPPLIER_TIMEOUT reaches the API once", async () => {
    signedIn("agent");
    // No `Retry-After` at all: the SDK's default would retry the 504 twice after its back-off.
    api.on(OFFERS, () => apiError("SUPPLIER_TIMEOUT", 504));
    api.on(AVAILABILITY, () => apiError("SUPPLIER_TIMEOUT", 504));

    expect(await searchOffers(offerForm())).toMatchObject({
      ok: false,
      code: "SUPPLIER_TIMEOUT",
      message: "Amadeus did not answer in time. Search again.",
    });
    expect(await searchAvailability(availabilityForm())).toMatchObject({
      ok: false,
      code: "SUPPLIER_TIMEOUT",
      message: "Amadeus did not answer in time. Search again.",
    });

    expect(api.sent(OFFERS)).toHaveLength(1);
    expect(api.sent(AVAILABILITY)).toHaveLength(1);
  });

  it("[FIX-W34-OTA AC2] keeps the SDK's default elsewhere: the quote's 504 is sent again twice", async () => {
    signedIn("agent");
    // `Retry-After: 0`: the default retries go out at once instead of after the back-off.
    api.on(PRICING, () => apiError("SUPPLIER_TIMEOUT", 504, {}, { "Retry-After": "0" }));

    expect(await quoteOffer({ offer: OFFER, reason: "", fareRules: false })).toMatchObject({
      ok: false,
      code: "SUPPLIER_TIMEOUT",
    });

    expect(api.sent(PRICING)).toHaveLength(3);
  });
});
