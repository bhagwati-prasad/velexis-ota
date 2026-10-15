// Get Flight Order by Record Locator (`getFlightOrderByReference`, GET /v1/booking/flight-orders/by-reference) of the
// Amadeus stub (OBE-041): `reference` is the record locator of an order that Flight Create Orders stored (any case),
// `originSystemCode` must be `GDS` (the only one the specification supports). Answers 200 with `data` a list of that
// one order and the `dictionaries` of fixtures/flight-create-orders/success.json; an unknown or cancelled locator
// answers 404 (1797), another origin system 400 (4926). `include` (`bags`) is accepted and adds nothing. No
// operation-specific scenario applies here.
import { dictionariesOf, orderNotFound, ORIGIN_SYSTEM_CODE, toFlightOrder } from "../orders";
import type { FixtureLoader, OperationHandler } from "../routes";
import { AMADEUS_ERROR_CODES, amadeusErrorResponse, type StubResponse } from "../scenarios";
import { FLIGHT_CREATE_ORDERS_FIXTURES } from "./create-orders";

const UNKNOWN_ORIGIN_SYSTEM: StubResponse = amadeusErrorResponse([
  {
    status: 400,
    code: AMADEUS_ERROR_CODES.invalidDataReceived,
    title: "INVALID DATA RECEIVED",
    detail: `query parameter originSystemCode must be ${ORIGIN_SYSTEM_CODE}`,
    source: { parameter: "originSystemCode" },
  },
]);

/** The handler of `getFlightOrderByReference`, reading the dictionaries through `loadFixture`. */
export function getFlightOrderByReferenceHandler(loadFixture: FixtureLoader): OperationHandler {
  return (context) => {
    if (context.query["originSystemCode"] !== ORIGIN_SYSTEM_CODE) {
      return UNKNOWN_ORIGIN_SYSTEM;
    }
    const reference = context.query["reference"];
    const order = typeof reference === "string" ? context.orders.byReference(reference) : undefined;
    if (order === undefined) {
      return orderNotFound("record locator");
    }
    const { body: fixture } = loadFixture(FLIGHT_CREATE_ORDERS_FIXTURES, "success");
    return { status: 200, body: { data: [toFlightOrder(order)], ...dictionariesOf(fixture) } };
  };
}
