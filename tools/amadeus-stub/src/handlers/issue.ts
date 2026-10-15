// Flight Order Issue (`issueFlightOrder`, POST /v1/booking/flight-orders/{flight-orderId}/issuance) of the Amadeus
// stub (OBE-041).
//
// Issues one e-ticket per traveller of a stored order that has none yet, replaces the order's forms of payment with the
// posted ones (cards kept as brand and last 4 only), and answers 200 with the order and the `dictionaries` of
// fixtures/flight-order-issue/success.json. Issuing the order of fixtures/flight-create-orders/success.json with a cash
// form of payment answers exactly that fixture, apart from the generated id, record locator, creation time and ticket
// numbers.
//
// An unknown or cancelled order answers 404 (1797); the declined test card `4000000000000002` answers 400 (1304); an
// order whose travellers all have tickets answers 400 (9112, "already issued"), so a second issue call fails loudly.
// Scenarios: `ticketing-failed` answers 400 with 9112 and issues nothing; `timeout` issues, then holds the answer and
// gives up with a 504 (the tickets exist, so a resync finds them); `timeout-lost` holds the answer without issuing.
import {
  cardRefused,
  declinedCardPointer,
  dictionariesOf,
  isFullyIssued,
  orderNotFound,
  toFlightOrder,
} from "../orders";
import type { FixtureLoader, HandlerContext, OperationHandler } from "../routes";
import {
  AMADEUS_ERROR_CODES,
  amadeusErrorResponse,
  TICKETING_FAILED,
  timedOut,
  type StubResponse,
} from "../scenarios";

/** The fixture folder of Flight Order Issue. */
export const FLIGHT_ORDER_ISSUE_FIXTURES = "flight-order-issue";

const ALREADY_ISSUED: StubResponse = amadeusErrorResponse([
  {
    status: 400,
    code: AMADEUS_ERROR_CODES.ticketing,
    title: "TICKETING - TKT",
    detail: "The flight order is already issued",
  },
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function issue(context: HandlerContext, loadFixture: FixtureLoader): StubResponse {
  const id = context.pathParams["flight-orderId"] ?? "";
  const order = context.orders.get(id);
  if (order === undefined) {
    return orderNotFound("id");
  }
  const data = isRecord(context.body) && isRecord(context.body["data"]) ? context.body["data"] : {};
  const declined = declinedCardPointer(data["formOfPayments"]);
  if (declined !== undefined) {
    return cardRefused(`/data${declined}`);
  }
  if (context.scenario === "ticketing-failed") {
    return TICKETING_FAILED;
  }
  if (isFullyIssued(order)) {
    return ALREADY_ISSUED;
  }
  const issued = context.orders.issue(id, data["formOfPayments"]) ?? order;
  const { status, body: fixture } = loadFixture(FLIGHT_ORDER_ISSUE_FIXTURES, "success");
  return { status, body: { data: toFlightOrder(issued), ...dictionariesOf(fixture) } };
}

/** The handler of `issueFlightOrder`, reading its fixture through `loadFixture`. */
export function issueFlightOrderHandler(loadFixture: FixtureLoader): OperationHandler {
  return (context) => {
    if (context.scenario === "timeout-lost") {
      return timedOut();
    }
    const response = issue(context, loadFixture);
    return context.scenario === "timeout" ? timedOut() : response;
  };
}
