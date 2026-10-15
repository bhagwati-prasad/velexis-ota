// Flight Create Orders (`createFlightOrders`, POST /v1/booking/flight-orders) of the Amadeus stub (OBE-041).
//
// The stub books whatever valid order it is sent: it stores the posted `data` (src/orders.ts) with a new record
// locator and flight-order id, and answers 201 with the stored order and the `dictionaries` of
// fixtures/flight-create-orders/success.json. With `issue=true` the order is issued at once (one e-ticket per
// traveller). Creating the order of that fixture's description (priced offer 2 for ALEX TESTER) answers exactly the
// fixture, apart from the generated id, record locator and creation time.
//
// A credit card is accepted and kept as brand and last 4 only; the test card `4000000000000002` is refused with error
// 1304 (CREDIT CARD NOT ACCEPTED) and nothing is stored.
//
// Scenarios: `sold-out` answers error 34651 for the first posted segment (nothing stored); `ticketing-failed` with
// `issue=true` stores the order without tickets and answers 201 with warning 9112; `timeout` stores the order (issued
// when asked), then holds the answer and gives up with a 504, so the order exists for reconciliation to find;
// `timeout-lost` holds the answer without storing anything.
import { cardRefused, declinedCardPointer, dictionariesOf, toFlightOrder } from "../orders";
import type { FixtureLoader, HandlerContext, OperationHandler } from "../routes";
import { soldOutResponse, TICKETING_FAILED_WARNING, timedOut, type StubResponse } from "../scenarios";
import { firstSegmentId, postedFlightOffers } from "./pricing";

/** The fixture folder of Flight Create Orders. */
export const FLIGHT_CREATE_ORDERS_FIXTURES = "flight-create-orders";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The `data` of a Flight Create Orders or Management PATCH body (`{}` when it has none). */
export function orderData(body: unknown): Record<string, unknown> {
  return isRecord(body) && isRecord(body["data"]) ? body["data"] : {};
}

function create(context: HandlerContext, loadFixture: FixtureLoader): StubResponse {
  const data = orderData(context.body);
  const declined = declinedCardPointer(data["formOfPayments"]);
  if (declined !== undefined) {
    return cardRefused(`/data${declined}`);
  }
  if (context.scenario === "sold-out") {
    return soldOutResponse(firstSegmentId(postedFlightOffers(context.body)));
  }
  const issue = context.query["issue"] === true;
  const ticketingFailed = issue && context.scenario === "ticketing-failed";
  const order = context.orders.create(data, { now: context.now, issue: issue && !ticketingFailed });
  const { status, body: fixture } = loadFixture(FLIGHT_CREATE_ORDERS_FIXTURES, "success");
  return {
    status,
    body: {
      ...(ticketingFailed ? { warnings: [TICKETING_FAILED_WARNING] } : {}),
      data: toFlightOrder(order),
      ...dictionariesOf(fixture),
    },
  };
}

/** The handler of `createFlightOrders`, reading its fixture through `loadFixture`. */
export function createFlightOrdersHandler(loadFixture: FixtureLoader): OperationHandler {
  return (context) => {
    if (context.scenario === "timeout-lost") {
      return timedOut();
    }
    const response = create(context, loadFixture);
    return context.scenario === "timeout" ? timedOut() : response;
  };
}
