// Flight Availabilities Search (`searchFlightAvailabilities`, POST /v1/shopping/availability/flight-availabilities,
// with `X-HTTP-Method-Override: GET`) of the Amadeus stub (OBE-019).
//
// Like Flight Offers Search, the stub answers one fixture whatever the itinerary: fixtures/flight-availabilities/
// success.json, the seats by booking class of the flights of the Flight Offers Search fixture. The magic destination
// `ZZZ` (in any `originDestinations` entry) finds nothing. No operation-specific scenario applies here.
import type { FixtureLoader, OperationHandler } from "../routes";
import { findsNoOffers, type StubResponse } from "../scenarios";

/** The fixture folder of Flight Availabilities Search. */
export const FLIGHT_AVAILABILITIES_FIXTURES = "flight-availabilities";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The destination codes of a Flight Availabilities Search body. */
function destinationsOf(body: unknown): unknown[] {
  const originDestinations = isRecord(body) ? body["originDestinations"] : undefined;
  return Array.isArray(originDestinations)
    ? originDestinations.map((entry: unknown) =>
        isRecord(entry) ? entry["destinationLocationCode"] : undefined,
      )
    : [];
}

/** The handler of `searchFlightAvailabilities`, reading its fixture through `loadFixture`. */
export function searchFlightAvailabilitiesHandler(loadFixture: FixtureLoader): OperationHandler {
  return (context): StubResponse => {
    if (findsNoOffers(destinationsOf(context.body))) {
      return { status: 200, body: { meta: { count: 0 }, data: [] } };
    }
    const { status, body } = loadFixture(FLIGHT_AVAILABILITIES_FIXTURES, "success");
    return { status, body };
  };
}
