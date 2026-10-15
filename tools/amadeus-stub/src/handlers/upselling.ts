// Branded Fares Upsell (`upsellAirOffers`, POST /v1/shopping/flight-offers/upselling) of the Amadeus stub (OBE-019).
//
// Like Flight Offers Search, the stub answers one fixture whatever is posted: fixtures/branded-fares-upsell/
// success.json, the branded fares (BASIC, CLASSIC, FLEXIBLE) of offer 2 of the Flight Offers Search fixture. The
// scenario `sold-out` answers error 34651 (SEGMENT SELL FAILURE) for the first posted segment, as Flight Offers Price
// does; `price-changed` does not apply here.
import type { FixtureLoader, OperationHandler } from "../routes";
import { soldOutResponse, type StubResponse } from "../scenarios";
import { firstSegmentId, postedFlightOffers } from "./pricing";

/** The fixture folder of Branded Fares Upsell. */
export const BRANDED_FARES_UPSELL_FIXTURES = "branded-fares-upsell";

/** The handler of `upsellAirOffers`, reading its fixture through `loadFixture`. */
export function upsellAirOffersHandler(loadFixture: FixtureLoader): OperationHandler {
  return (context): StubResponse => {
    if (context.scenario === "sold-out") {
      return soldOutResponse(firstSegmentId(postedFlightOffers(context.body)));
    }
    const { status, body } = loadFixture(BRANDED_FARES_UPSELL_FIXTURES, "success");
    return { status, body };
  };
}
