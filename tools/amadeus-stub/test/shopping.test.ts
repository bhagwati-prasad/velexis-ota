// The shopping operations of the Amadeus stub (OBE-019): Flight Offers Price, Branded Fares Upsell and Flight
// Availabilities Search, their fixtures, request validation and the `price-changed` and `sold-out` scenarios. Like
// server.test.ts, every test starts the stub in-process on a free port of 127.0.0.1 and needs nothing else running.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { raiseAmount } from "../src/handlers/pricing";
import {
  AMADEUS_SPEC_FILES,
  AmadeusSpecs,
  createStubServer,
  loadFixture,
  OAUTH_TOKEN_PATH,
  STUB_OPERATIONS,
  STUB_SCENARIOS,
  type AmadeusIssue,
  type OperationName,
  type StubOperation,
  type StubServer,
  type StubServerOptions,
  type StubTimers,
} from "../src/index";

const PRICING_PATH = "/v1/shopping/flight-offers/pricing";
const UPSELL_PATH = "/v1/shopping/flight-offers/upselling";
const AVAILABILITY_PATH = "/v1/shopping/availability/flight-availabilities";
const SEARCH_PATH = "/v2/shopping/flight-offers";
const ALL_INCLUDES = "bags,other-services,detailed-fare-rules";

type Json = Record<string, unknown>;

interface ErrorBody {
  readonly errors: readonly AmadeusIssue[];
}
interface Money {
  readonly currency: string;
  readonly total: string;
  readonly base: string;
  readonly grandTotal?: string;
}
interface PricedOffer {
  readonly id: string;
  readonly price: Money;
  readonly travelerPricings: readonly { readonly travelerId: string; readonly price: Money }[];
}
interface PricingBody {
  readonly warnings?: readonly AmadeusIssue[];
  readonly data: {
    readonly type: string;
    readonly flightOffers: readonly PricedOffer[];
    readonly bookingRequirements: { readonly travelerRequirements: readonly Json[] };
  };
  readonly included?: Readonly<Record<string, Readonly<Record<string, Json>>>>;
  readonly dictionaries?: unknown;
}
interface ListBody {
  readonly meta: { readonly count: number };
  readonly data: readonly Json[];
}

const servers: StubServer[] = [];

/** The specifications of this file's stubs, with every operation's request validators compiled in the hook below. */
const stubSpecs = new AmadeusSpecs();
beforeAll(() => {
  for (const op of STUB_OPERATIONS) {
    stubSpecs.prepare(op.spec);
  }
  // A stub compiles an operation's body validator on its first request (README "Request validation"): about 0.6 s on
  // an idle CPU for the twelve, several seconds when CI runs every package at once on 4 CPUs, which then landed in the
  // first test of each operation. Here it has a budget of its own.
}, 60_000);

async function startStub(options: Partial<StubServerOptions> = {}): Promise<StubServer> {
  const server = await createStubServer({ port: 0, specs: stubSpecs, ...options });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A bearer token from the stub (dummy credentials: the stub accepts any non-empty pair). */
async function authorized(stub: StubServer): Promise<Record<string, string>> {
  const res = await fetch(`${stub.url}${OAUTH_TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&client_id=stub-client-id&client_secret=not-a-real-secret",
  });
  expect(res.status).toBe(200);
  return { authorization: `Bearer ${(await json<{ access_token: string }>(res)).access_token}` };
}

function post(
  stub: StubServer,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return fetch(`${stub.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/vnd.amadeus+json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function fixtureBody<T = Json>(operation: string, scenario = "success"): T {
  return loadFixture(operation, scenario).body as T;
}

/** The offers of the Flight Offers Search fixture, as a client got them and posts them back. */
function searchOffers(): Json[] {
  return fixtureBody<{ data: Json[] }>("flight-offers-search").data;
}

function searchOffer(id: string): Json {
  const offer = searchOffers().find((candidate) => candidate["id"] === id);
  if (offer === undefined) {
    throw new Error(`no search offer ${id}`);
  }
  return offer;
}

function pricingRequest(offers: readonly Json[], extra: Json = {}): Json {
  return { data: { type: "flight-offers-pricing", flightOffers: offers, ...extra } };
}

function upsellRequest(offers: readonly Json[]): Json {
  return { data: { type: "flight-offers-upselling", flightOffers: offers } };
}

/** A valid Flight Availabilities Search body (GetFlightAvailabilitiesQuery), Madrid to Paris on 2027-01-15. */
function availabilityRequest(destination = "PAR"): Json {
  return {
    originDestinations: [
      {
        id: "1",
        originLocationCode: "MAD",
        destinationLocationCode: destination,
        departureDateTime: { date: "2027-01-15", time: "06:00:00" },
      },
    ],
    travelers: [{ id: "1", travelerType: "ADULT" }],
    sources: ["GDS"],
  };
}

const METHOD_OVERRIDE = { "x-http-method-override": "GET" };

function operationNamed(name: OperationName): StubOperation {
  const found = STUB_OPERATIONS.find((op) => op.name === name);
  if (found === undefined) {
    throw new Error(`${name} is missing from the route table`);
  }
  return found;
}

/** The specifications declare the dictionaries' `locations` and `currencies` with a required `key`, which no Amadeus
 * response has (the codes are the keys); only that defect is tolerated (fixtures/README.md). */
function schemaProblems(name: OperationName, status: number, body: unknown): readonly unknown[] {
  const problems = new AmadeusSpecs().validateResponse(operationNamed(name).spec, status, body);
  return problems.filter(
    (p) =>
      !(
        p.keyword === "required" &&
        p.params["missingProperty"] === "key" &&
        ["/dictionaries/locations", "/dictionaries/currencies"].includes(p.instancePath)
      ),
  );
}

function manualTimers(): { readonly timers: StubTimers; readonly pending: Map<number, () => void> } {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    pending,
    timers: {
      setTimeout(callback) {
        const id = next++;
        pending.set(id, callback);
        return id;
      },
      clearTimeout(handle) {
        pending.delete(handle as number);
      },
    },
  };
}

describe("Flight Offers Price", () => {
  it("returns the fixture for search offer 2 with include=bags,other-services,detailed-fare-rules [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const res = await post(
      stub,
      `${PRICING_PATH}?include=${ALL_INCLUDES}`,
      headers,
      pricingRequest([searchOffer("2")]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.amadeus+json");
    expect(await json<PricingBody>(res)).toEqual(fixtureBody("flight-offers-price"));
    expect(stub.requests().at(-1)).toMatchObject({ operation: "quoteAirOffers", status: 200 });

    // Without `include` the same pricing has no `included`; `forceClass` is accepted.
    const plain = await post(
      stub,
      `${PRICING_PATH}?forceClass=false`,
      headers,
      pricingRequest([searchOffer("2")]),
    );
    const { included, ...withoutIncluded } = fixtureBody<PricingBody>("flight-offers-price");
    expect(included).toBeDefined();
    expect(await json<PricingBody>(plain)).toEqual(withoutIncluded);
  });

  it("echoes the posted offers with booking requirements and builds the included dictionaries for them [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const offers = [searchOffer("1"), searchOffer("2")];
    const res = await post(stub, `${PRICING_PATH}?include=${ALL_INCLUDES}`, headers, pricingRequest(offers));
    expect(res.status).toBe(200);
    const body = await json<PricingBody>(res);
    expect(body.data.flightOffers).toEqual(offers);
    expect(body.data.bookingRequirements.travelerRequirements).toEqual([
      expect.objectContaining({ travelerId: "1", dateOfBirthRequired: true }),
    ]);
    expect(Object.values(body.included?.["bags"] ?? {})).toEqual([
      expect.objectContaining({ quantity: 1, segmentIds: ["1", "2", "3"], travelerIds: ["1"] }),
      expect.objectContaining({ quantity: 2, segmentIds: ["1", "2", "3"], travelerIds: ["1"] }),
    ]);
    expect(Object.values(body.included?.["other-services"] ?? {})).toEqual([
      expect.objectContaining({ name: "PRIORITY_BOARDING", segmentIds: ["1", "2", "3"] }),
    ]);
    // One fare rule per fare basis: TAP's two segments share OL0DSI05.
    expect(body.included?.["detailed-fare-rules"]).toEqual({
      "1": expect.objectContaining({ fareBasis: "OL0DSI05", segmentId: "1", name: "PENALTIES" }),
      "2": expect.objectContaining({ fareBasis: "ADNNALB4", segmentId: "3", name: "PENALTIES" }),
    });
    expect(schemaProblems("quoteAirOffers", 200, body)).toEqual([]);

    // All five search offers at once (the specification allows six), and an upsell offer, are taken back as they came,
    // with the fields that their own schemas declare and the pricing request schema does not.
    const all = await post(stub, PRICING_PATH, headers, pricingRequest(searchOffers()));
    expect(all.status).toBe(200);
    expect((await json<PricingBody>(all)).data.flightOffers.map((offer) => offer.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    const upsold = fixtureBody<{ data: Json[] }>("branded-fares-upsell").data;
    const brand = await post(stub, PRICING_PATH, headers, pricingRequest([upsold[1] ?? {}]));
    expect(brand.status).toBe(200);
    expect((await json<PricingBody>(brand)).data.flightOffers[0]?.price.total).toBe("126.47");
  });

  it("adds the credit-card fee of each posted brand with include=credit-card-fees [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const payments = ["VISA", "MASTERCARD", "AMERICAN_EXPRESS"].map((brand) => ({
      brand,
      flightOfferIds: ["2"],
    }));
    const res = await post(
      stub,
      `${PRICING_PATH}?include=credit-card-fees`,
      headers,
      pricingRequest([searchOffer("2")], { payments }),
    );
    expect(res.status).toBe(200);
    expect(await json<PricingBody>(res)).toEqual(fixtureBody("flight-offers-price", "credit-card-fees"));

    // The fee depends on the brand only; a payment without flightOfferIds pays every posted offer, and a brand the
    // fixture does not list costs 0.00. The bank identification number is accepted and never recorded.
    const other = await post(
      stub,
      `${PRICING_PATH}?include=credit-card-fees,bags`,
      headers,
      pricingRequest([searchOffer("1"), searchOffer("4")], {
        payments: [
          { brand: "AMERICAN_EXPRESS", binNumber: 424242 },
          { brand: "MAESTRO", flightOfferIds: ["4"] },
        ],
      }),
    );
    expect(other.status).toBe(200);
    const body = await json<PricingBody>(other);
    expect(body.included?.["credit-card-fees"]).toEqual({
      "1": { brand: "AMERICAN_EXPRESS", amount: "3.95", currency: "EUR", flightOfferId: "1" },
      "2": { brand: "AMERICAN_EXPRESS", amount: "3.95", currency: "EUR", flightOfferId: "4" },
      "3": { brand: "MAESTRO", amount: "0.00", currency: "EUR", flightOfferId: "4" },
    });
    expect(Object.keys(body.included ?? {}).sort()).toEqual(["bags", "credit-card-fees"]);
    expect(schemaProblems("quoteAirOffers", 200, body)).toEqual([]);
    expect(JSON.stringify(stub.requests())).not.toContain("424242");
  });

  it("serves fixtures that match the Flight Offers Price response schema [OBE-019 AC1]", () => {
    for (const scenario of ["success", "credit-card-fees"]) {
      const fixture = loadFixture("flight-offers-price", scenario);
      expect(fixture.fixture).toMatchObject({
        operation: "flight-offers-price",
        scenario,
        source: "synthetic",
      });
      expect(fixture.status).toBe(200);
      expect(schemaProblems("quoteAirOffers", 200, fixture.body), scenario).toEqual([]);
    }
    // The fixture is the pricing of the search fixture's offer 2, unchanged.
    expect(fixtureBody<PricingBody>("flight-offers-price").data.flightOffers).toEqual([searchOffer("2")]);
  });

  it("answers 400 naming the query parameter or body field of an invalid request [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const offer = searchOffer("2");
    const cases: Array<[string, unknown, Partial<AmadeusIssue>]> = [
      ["?include=seats", pricingRequest([offer]), { code: 572, source: { parameter: "include" } }],
      ["?forceClass=perhaps", pricingRequest([offer]), { code: 477, source: { parameter: "forceClass" } }],
      ["?includes=bags", pricingRequest([offer]), { code: 4926, source: { parameter: "includes" } }],
      ["", {}, { code: 32171, source: { pointer: "/data" } }],
      [
        "",
        { data: { type: "flight-offers-pricing" } },
        { code: 32171, source: { pointer: "/data/flightOffers" } },
      ],
      ["", pricingRequest([]), { code: 4926, source: { pointer: "/data/flightOffers" } }],
      [
        "",
        pricingRequest([offer], { payments: [{ brand: "VISA_GOLD" }] }),
        { code: 572, source: { pointer: "/data/payments/0/brand" } },
      ],
      [
        "",
        pricingRequest([offer], { paymentz: [{ brand: "VISA" }] }),
        {
          code: 4926,
          title: "INVALID DATA RECEIVED",
          detail: "request body field /data/paymentz is not defined by the specification",
          source: { pointer: "/data/paymentz" },
        },
      ],
    ];
    for (const [query, body, issue] of cases) {
      const res = await post(stub, `${PRICING_PATH}${query}`, headers, body);
      expect(res.status, `${query} ${JSON.stringify(issue)}`).toBe(400);
      const { errors } = await json<ErrorBody>(res);
      expect(errors, JSON.stringify(issue)).toEqual([expect.objectContaining({ status: 400, ...issue })]);
      expect(schemaProblems("quoteAirOffers", 400, { errors })).toEqual([]);
    }
  });

  it("refuses unknown body fields anywhere, the echoed flight offers included [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const offer = structuredClone(searchOffer("2")) as {
      travelerPricings: Array<{ fareDetailsBySegment: Json[] }>;
      price: Json;
    };
    offer.price["grandTotl"] = "98.47";
    const detail = offer.travelerPricings[0]?.fareDetailsBySegment[0];
    if (detail !== undefined) {
      detail["brandedFareLabels"] = "BASIC";
    }
    const res = await post(stub, PRICING_PATH, headers, { ...pricingRequest([offer]), meta: { count: 1 } });
    expect(res.status).toBe(400);
    const pointers = (await json<ErrorBody>(res)).errors.map((issue) => issue.source);
    expect(pointers).toEqual(
      expect.arrayContaining([
        { pointer: "/meta" },
        { pointer: "/data/flightOffers/0/price/grandTotl" },
        { pointer: "/data/flightOffers/0/travelerPricings/0/fareDetailsBySegment/0/brandedFareLabels" },
      ]),
    );
    expect(pointers).toHaveLength(3);
    // Validation comes before any scenario.
    const failing = await post(
      stub,
      PRICING_PATH,
      { ...headers, "x-stub-scenario": "sold-out" },
      { ...pricingRequest([searchOffer("2")]), meta: {} },
    );
    expect(failing.status).toBe(400);
    expect((await json<ErrorBody>(failing)).errors).toEqual([expect.objectContaining({ code: 4926 })]);
  });

  it("answers a higher total with warning 37200 for price-changed [OBE-019 AC2]", async () => {
    const stub = await startStub();
    const headers = { ...(await authorized(stub)), "X-Stub-Scenario": "price-changed" };
    const res = await post(stub, `${PRICING_PATH}?include=bags`, headers, pricingRequest([searchOffer("2")]));
    expect(res.status).toBe(200);
    const body = await json<PricingBody>(res);
    expect(body.warnings).toEqual([
      {
        status: 200,
        code: 37200,
        title: "PRICE DISCREPANCY",
        detail: "Current grandTotal price is different from request one",
      },
    ]);
    const [priced] = body.data.flightOffers;
    expect(priced?.price).toMatchObject({
      currency: "EUR",
      total: "108.47",
      base: "66.00",
      grandTotal: "108.47",
    });
    expect(priced?.travelerPricings[0]?.price).toMatchObject({ total: "108.47", base: "66.00" });
    expect(body.included?.["bags"]).toEqual(
      fixtureBody<PricingBody>("flight-offers-price").included?.["bags"],
    );
    expect(schemaProblems("quoteAirOffers", 200, body)).toEqual([]);
    expect(stub.requests().at(-1)).toMatchObject({ operation: "quoteAirOffers", scenario: "price-changed" });

    // Two traveller pricings: each one is raised by 10, the offer by 20.
    const family = structuredClone(searchOffer("2")) as { travelerPricings: Json[] };
    family.travelerPricings.push({ ...structuredClone(family.travelerPricings[0]), travelerId: "2" });
    const two = await json<PricingBody>(await post(stub, PRICING_PATH, headers, pricingRequest([family])));
    expect(two.data.flightOffers[0]?.price).toMatchObject({
      total: "118.47",
      base: "76.00",
      grandTotal: "118.47",
    });
    expect(two.data.flightOffers[0]?.travelerPricings.map((tp) => tp.price.total)).toEqual([
      "108.47",
      "108.47",
    ]);
    expect(two.data.bookingRequirements.travelerRequirements.map((r) => r["travelerId"])).toEqual(["1", "2"]);
  });

  it("answers error 34651 for sold-out [OBE-019 AC2]", async () => {
    const stub = await startStub();
    const headers = { ...(await authorized(stub)), "X-Stub-Scenario": "sold-out" };
    const res = await post(stub, PRICING_PATH, headers, pricingRequest([searchOffer("2")]));
    expect(res.status).toBe(400);
    const body = await json<ErrorBody>(res);
    expect(body).toEqual({
      errors: [
        { status: 400, code: 34651, title: "SEGMENT SELL FAILURE", detail: "Could not sell segment 3" },
      ],
    });
    expect(schemaProblems("quoteAirOffers", 400, body)).toEqual([]);
  });

  it("raises amounts on their digits, never through a JavaScript number", () => {
    expect(raiseAmount("98.47", 10)).toBe("108.47");
    expect(raiseAmount("0.10", 10)).toBe("10.10");
    expect(raiseAmount("1000", 20)).toBe("1020");
    expect(raiseAmount("9007199254740993.01", 10)).toBe("9007199254741003.01");
    expect(raiseAmount("-5.00", 10)).toBe("-5.00");
    expect(raiseAmount("12.5A", 10)).toBe("12.5A");
    expect(raiseAmount(undefined, 10)).toBeUndefined();
  });
});

describe("Branded Fares Upsell", () => {
  it("returns the fixture for a valid request [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const res = await post(stub, UPSELL_PATH, await authorized(stub), upsellRequest([searchOffer("2")]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.amadeus+json");
    const body = await json<ListBody>(res);
    expect(body).toEqual(fixtureBody("branded-fares-upsell"));
    expect(body.meta.count).toBe(body.data.length);
    expect(stub.requests().at(-1)).toMatchObject({ operation: "upsellAirOffers", status: 200 });
  });

  it("serves a fixture that matches the response schema and the search fixture's offer 2 [OBE-019 AC1]", () => {
    const body = fixtureBody<{ data: Array<PricedOffer & { itineraries: unknown }> }>("branded-fares-upsell");
    expect(schemaProblems("upsellAirOffers", 200, body)).toEqual([]);
    const original = searchOffer("2") as unknown as PricedOffer & { itineraries: unknown };
    expect(body.data.map((offer) => offer.price.total)).toEqual(["98.47", "126.47", "189.47"]);
    expect(body.data[0]?.price.total).toBe(original.price.total);
    for (const offer of body.data) {
      expect(offer.itineraries).toEqual(original.itineraries);
    }
  });

  it("answers 400 naming the body field or query parameter of an invalid request [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const cases: Array<[string, unknown, Partial<AmadeusIssue>]> = [
      [
        "",
        { data: { type: "flight-offers-upselling" } },
        { code: 32171, source: { pointer: "/data/flightOffers" } },
      ],
      [
        "",
        { data: { flightOffers: [searchOffer("2")] } },
        { code: 32171, source: { pointer: "/data/type" } },
      ],
      ["?include=bags", upsellRequest([searchOffer("2")]), { code: 4926, source: { parameter: "include" } }],
      [
        "",
        { ...upsellRequest([searchOffer("2")]), included: {} },
        { code: 4926, source: { pointer: "/included" } },
      ],
    ];
    for (const [query, body, issue] of cases) {
      const res = await post(stub, `${UPSELL_PATH}${query}`, headers, body);
      expect(res.status, JSON.stringify(issue)).toBe(400);
      expect((await json<ErrorBody>(res)).errors, JSON.stringify(issue)).toEqual([
        expect.objectContaining({ status: 400, ...issue }),
      ]);
    }
  });

  it("answers error 34651 for sold-out [OBE-019 AC2]", async () => {
    const stub = await startStub();
    const headers = { ...(await authorized(stub)), "x-stub-scenario": "sold-out" };
    const res = await post(stub, UPSELL_PATH, headers, upsellRequest([searchOffer("1")]));
    expect(res.status).toBe(400);
    const body = await json<ErrorBody>(res);
    expect(body).toEqual({
      errors: [
        { status: 400, code: 34651, title: "SEGMENT SELL FAILURE", detail: "Could not sell segment 1" },
      ],
    });
    expect(schemaProblems("upsellAirOffers", 400, body)).toEqual([]);
    // price-changed is a pricing scenario: the upsell answers as usual.
    const unchanged = await post(
      stub,
      UPSELL_PATH,
      { ...headers, "x-stub-scenario": "price-changed" },
      upsellRequest([searchOffer("1")]),
    );
    expect(unchanged.status).toBe(200);
    expect(await json<ListBody>(unchanged)).toEqual(fixtureBody("branded-fares-upsell"));
  });
});

describe("Flight Availabilities Search", () => {
  it("returns the fixture for a valid request [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const headers = { ...(await authorized(stub)), ...METHOD_OVERRIDE };
    const res = await post(stub, AVAILABILITY_PATH, headers, availabilityRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.amadeus+json");
    const body = await json<ListBody>(res);
    expect(body).toEqual(fixtureBody("flight-availabilities"));
    expect(body.meta.count).toBe(body.data.length);
    expect(stub.requests().at(-1)).toMatchObject({ operation: "searchFlightAvailabilities", status: 200 });
  });

  it("serves a fixture that matches the response schema and the flights of the search fixture [OBE-019 AC1]", () => {
    const body = fixtureBody<{ data: Array<{ segments: Json[] }> }>("flight-availabilities");
    expect(schemaProblems("searchFlightAvailabilities", 200, body)).toEqual([]);
    const flights = (segments: readonly Json[]): string[] =>
      segments.map((s) => `${String(s["carrierCode"])}${String(s["number"])}`).sort();
    const searched = searchOffers().flatMap((offer) =>
      (offer["itineraries"] as Array<{ segments: Json[] }>).flatMap((itinerary) => itinerary.segments),
    );
    expect(flights(body.data.flatMap((availability) => availability.segments))).toEqual(flights(searched));

    // The booking class of every search offer is open on its flights, with at least the offer's bookable seats.
    const seats = new Map<string, number>(
      body.data
        .flatMap((availability) => availability.segments)
        .flatMap((s) =>
          (s["availabilityClasses"] as Array<{ class: string; numberOfBookableSeats: number }>).map(
            (c) =>
              [
                `${String(s["carrierCode"])}${String(s["number"])} ${c.class}`,
                c.numberOfBookableSeats,
              ] as const,
          ),
        ),
    );
    for (const offer of searchOffers()) {
      const segments = new Map(
        (offer["itineraries"] as Array<{ segments: Json[] }>)
          .flatMap((itinerary) => itinerary.segments)
          .map((s) => [s["id"], `${String(s["carrierCode"])}${String(s["number"])}`]),
      );
      const [pricing] = offer["travelerPricings"] as Array<{
        fareDetailsBySegment: Array<{ segmentId: string; class: string }>;
      }>;
      for (const detail of pricing?.fareDetailsBySegment ?? []) {
        const key = `${segments.get(detail.segmentId) ?? "?"} ${detail.class}`;
        expect(seats.get(key), key).toBeGreaterThanOrEqual(offer["numberOfBookableSeats"] as number);
      }
    }
  });

  it("answers 400 naming the header or body field of an invalid request [OBE-019 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const { sources: _sources, ...withoutSources } = availabilityRequest();
    const misspelt = availabilityRequest() as { originDestinations: Json[] };
    misspelt.originDestinations[0] = { ...misspelt.originDestinations[0], departureDate: "2027-01-15" };
    const cases: Array<[Record<string, string>, unknown, Partial<AmadeusIssue>]> = [
      [{}, availabilityRequest(), { code: 32171, source: { parameter: "X-HTTP-Method-Override" } }],
      [METHOD_OVERRIDE, withoutSources, { code: 32171, source: { pointer: "/sources" } }],
      [
        METHOD_OVERRIDE,
        { ...availabilityRequest(), sources: ["NDC"] },
        { code: 572, source: { pointer: "/sources/0" } },
      ],
      [
        METHOD_OVERRIDE,
        misspelt,
        {
          code: 4926,
          detail:
            "request body field /originDestinations/0/departureDate is not defined by the specification",
          source: { pointer: "/originDestinations/0/departureDate" },
        },
      ],
    ];
    for (const [extra, body, issue] of cases) {
      const res = await post(stub, AVAILABILITY_PATH, { ...headers, ...extra }, body);
      expect(res.status, JSON.stringify(issue)).toBe(400);
      const { errors } = await json<ErrorBody>(res);
      expect(errors, JSON.stringify(issue)).toEqual([expect.objectContaining({ status: 400, ...issue })]);
      expect(JSON.stringify(errors)).not.toContain("NDC");
    }
  });

  it("finds nothing for the destination ZZZ [OBE-019 AC2]", async () => {
    const stub = await startStub();
    const headers = { ...(await authorized(stub)), ...METHOD_OVERRIDE };
    const res = await post(stub, AVAILABILITY_PATH, headers, availabilityRequest("ZZZ"));
    expect(res.status).toBe(200);
    expect(await json<ListBody>(res)).toEqual({ meta: { count: 0 }, data: [] });
  });
});

describe("scenarios of the shopping operations", () => {
  it("knows sold-out and price-changed besides the generic scenarios [OBE-019 AC2]", () => {
    // OBE-041 adds the order scenarios after them, OBE-049 the refused cancellation.
    expect(STUB_SCENARIOS).toEqual([
      "success",
      "server-error",
      "rate-limited",
      "timeout",
      "sold-out",
      "price-changed",
      "ticketing-failed",
      "version-conflict",
      "timeout-lost",
      "cancel-refused",
    ]);
  });

  it("still returns no offers for the destination ZZZ, whatever the default scenario [OBE-019 AC2]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    for (const scenario of ["success", "sold-out", "price-changed"] as const) {
      stub.setDefaultScenario(scenario);
      const get = await fetch(
        `${stub.url}${SEARCH_PATH}?originLocationCode=MAD&destinationLocationCode=ZZZ&departureDate=2027-01-15&adults=1`,
        { headers },
      );
      expect(get.status, scenario).toBe(200);
      expect(await json<ListBody>(get)).toEqual({ meta: { count: 0 }, data: [] });
      const postSearch = await post(
        stub,
        SEARCH_PATH,
        { ...headers, ...METHOD_OVERRIDE },
        {
          originDestinations: [
            {
              id: "1",
              originLocationCode: "MAD",
              destinationLocationCode: "ZZZ",
              departureDateTimeRange: { date: "2027-01-15" },
            },
          ],
          travelers: [{ id: "1", travelerType: "ADULT" }],
          sources: ["GDS"],
        },
      );
      expect(await json<ListBody>(postSearch)).toEqual({ meta: { count: 0 }, data: [] });
    }
  });

  it("applies sold-out and price-changed only where they mean something, so a whole flow can run under them [OBE-019 AC2]", async () => {
    const stub = await startStub({ defaultScenario: "sold-out" });
    // The token endpoint, Flight Offers Search and Flight Availabilities Search answer as usual …
    const headers = await authorized(stub);
    const search = await fetch(
      `${stub.url}${SEARCH_PATH}?originLocationCode=MAD&destinationLocationCode=PAR&departureDate=2027-01-15&adults=1`,
      { headers },
    );
    expect(search.status).toBe(200);
    expect(await json<ListBody>(search)).toEqual(fixtureBody("flight-offers-search"));
    const availability = await post(
      stub,
      AVAILABILITY_PATH,
      { ...headers, ...METHOD_OVERRIDE },
      availabilityRequest(),
    );
    expect(availability.status).toBe(200);
    // … and pricing fails until the header opts the request out.
    expect((await post(stub, PRICING_PATH, headers, pricingRequest([searchOffer("2")]))).status).toBe(400);
    const optOut = await post(
      stub,
      PRICING_PATH,
      { ...headers, "x-stub-scenario": "success" },
      pricingRequest([searchOffer("2")]),
    );
    expect(optOut.status).toBe(200);
    expect(stub.requests().map((r) => [r.operation, r.scenario, r.status])).toEqual([
      ["oauth2Token", "sold-out", 200],
      ["getFlightOffers", "sold-out", 200],
      ["searchFlightAvailabilities", "sold-out", 200],
      ["quoteAirOffers", "sold-out", 400],
      ["quoteAirOffers", "success", 200],
    ]);
  });

  it("applies server-error, rate-limited and timeout to the new routes too [OBE-019 AC2]", async () => {
    const { timers, pending } = manualTimers();
    const stub = await startStub({ timers });
    const headers = { ...(await authorized(stub)), ...METHOD_OVERRIDE };
    const routes: Array<[string, unknown]> = [
      [PRICING_PATH, pricingRequest([searchOffer("2")])],
      [UPSELL_PATH, upsellRequest([searchOffer("2")])],
      [AVAILABILITY_PATH, availabilityRequest()],
    ];
    for (const [path, body] of routes) {
      const failed = await post(stub, path, { ...headers, "x-stub-scenario": "server-error" }, body);
      expect(failed.status, path).toBe(500);
      expect((await json<ErrorBody>(failed)).errors).toEqual([expect.objectContaining({ code: 141 })]);
      const limited = await post(stub, path, { ...headers, "x-stub-scenario": "rate-limited" }, body);
      expect(limited.status, path).toBe(429);
      expect((await json<ErrorBody>(limited)).errors).toEqual([expect.objectContaining({ code: 38194 })]);

      const held = post(stub, path, { ...headers, "x-stub-scenario": "timeout" }, body);
      await vi.waitFor(() => expect(pending.size).toBe(1));
      const [fire] = [...pending.values()];
      pending.clear();
      fire?.();
      expect((await held).status, path).toBe(504);
    }
  });

  it("names the new operations' specifications and handlers in the route table [OBE-019 AC1]", () => {
    const shopping: Array<[OperationName, string, string]> = [
      ["quoteAirOffers", AMADEUS_SPEC_FILES.FlightOffersPrice, PRICING_PATH],
      ["upsellAirOffers", AMADEUS_SPEC_FILES.BrandedFaresUpsell, UPSELL_PATH],
      ["searchFlightAvailabilities", AMADEUS_SPEC_FILES.FlightAvailabilitiesSearch, AVAILABILITY_PATH],
    ];
    for (const [name, specFile, path] of shopping) {
      const op = operationNamed(name);
      expect(op.handler, name).toBeTypeOf("function");
      expect(op).toMatchObject({ method: "POST", path, plannedBy: "OBE-019", spec: { specFile } });
      expect(op.spec.unknownBodyFields, name).toBeDefined();
    }
  });

  it("knows a body field through $ref, allOf, oneOf, additionalProperties, patternProperties and alsoKnown, and only where they apply [OBE-019 AC1]", () => {
    // A small Swagger 2.0 document with each rule of the unknown-field check, in a scratch specification folder.
    const dir = mkdtempSync(join(tmpdir(), "amadeus-stub-unknown-fields-"));
    try {
      writeFileSync(
        join(dir, "Things.json"),
        JSON.stringify({
          swagger: "2.0",
          basePath: "/v1",
          paths: {
            "/things": {
              post: {
                operationId: "postThings",
                parameters: [
                  { name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Root" } },
                ],
                responses: { "200": { description: "ok" } },
              },
            },
          },
          definitions: {
            Root: {
              type: "object",
              properties: {
                base: { $ref: "#/definitions/Extended" },
                choice: {
                  oneOf: [
                    { required: ["a"], properties: { a: { type: "string" } } },
                    { required: ["b"], properties: { b: { type: "string" } } },
                  ],
                },
                labels: {
                  type: "object",
                  additionalProperties: { properties: { text: { type: "string" } } },
                },
                open: {
                  type: "object",
                  properties: { known: { type: "string" } },
                  additionalProperties: true,
                },
                patterned: {
                  type: "object",
                  properties: { known: { type: "string" } },
                  patternProperties: { "^x-": {} },
                },
                free: { type: "object" },
                list: { type: "array", items: { properties: { id: { type: "string" } } } },
                "a/b": { type: "string" },
              },
            },
            Base: { type: "object", properties: { id: { type: "string" } } },
            Extended: {
              allOf: [{ $ref: "#/definitions/Base" }, { properties: { name: { type: "string" } } }],
            },
            Other: { properties: { extra: { type: "string" } } },
          },
        }),
      );
      const specs = new AmadeusSpecs(dir);
      const plain = { specFile: "Things.json", specPath: "/things", method: "POST" } as const;
      const strict = {
        ...plain,
        unknownBodyFields: {
          alsoKnown: [{ pointer: "/list/*", specFile: "Things.json", ref: "#/definitions/Other" }],
        },
      };
      const request = (body: unknown) => ({
        query: new URLSearchParams(),
        headers: { "content-type": "application/json" },
        pathParams: {},
        body: JSON.stringify(body),
      });

      const known = {
        base: { id: "1", name: "allOf" },
        choice: { a: "oneOf" },
        labels: { anyKey: { text: "additionalProperties schema" } },
        open: { known: "k", anything: { at: "all" } },
        patterned: { known: "k", "x-custom": 1 },
        free: { anything: { at: "all" } },
        list: [{ id: "1", extra: "alsoKnown at /list/*" }],
        "a/b": "slash",
      };
      expect(specs.validateRequest(strict, request(known))).toMatchObject({
        ok: true,
        request: { body: known },
      });

      const unknown = {
        base: { id: "1", nam: "typo", extra: "alsoKnown only at /list/*" },
        choice: { a: "x", c: "y" },
        labels: { anyKey: { text: "t", txt: "u" } },
        list: [{ id: "1", extra: "e", extr: "f" }],
        "c/d": 1,
        "e~f": 2,
      };
      const refused = specs.validateRequest(strict, request(unknown));
      expect(refused.ok).toBe(false);
      const issues = refused.ok ? [] : refused.issues;
      const pointers = [
        "/base/nam",
        "/base/extra",
        "/choice/c",
        "/labels/anyKey/txt",
        "/list/0/extr",
        "/c~1d",
        "/e~0f",
      ];
      expect(issues).toEqual(
        pointers.map((pointer) => ({
          status: 400,
          code: 4926,
          title: "INVALID DATA RECEIVED",
          detail: `request body field ${pointer} is not defined by the specification`,
          source: { pointer },
        })),
      );
      expect(JSON.stringify(issues)).not.toContain("typo");

      // Without `unknownBodyFields` (Flight Offers Search), JSON Schema's default holds: unknown fields pass.
      expect(specs.validateRequest(plain, request(unknown))).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an alsoKnown schema that does not exist when the operation is prepared", () => {
    const op = operationNamed("quoteAirOffers");
    const specs = new AmadeusSpecs();
    expect(() =>
      specs.prepare({
        ...op.spec,
        unknownBodyFields: {
          alsoKnown: [
            {
              pointer: "/data/flightOffers/*",
              specFile: AMADEUS_SPEC_FILES.FlightOffersSearch,
              ref: "#/definitions/Nope",
            },
          ],
        },
      }),
    ).toThrow(/has no schema #\/definitions\/Nope/);
  });
});
