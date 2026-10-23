// Flight Order Management (GET, PATCH and DELETE /v1/booking/flight-orders/{flight-orderId}: `getFlightOrder`,
// `patchFlightOrder`, `cancelFlightOrder`) of the Amadeus stub (OBE-041), on the orders that Flight Create Orders
// stored (src/orders.ts). An unknown or cancelled order answers 404 (1797) to each of them.
//
//   - GET answers 200 with the order and the `dictionaries` of fixtures/flight-create-orders/success.json. `include`
//     (`bags`) and `fareRules` (`rebooks`, `refunds`) are accepted and add nothing.
//   - PATCH replaces the order's `contacts` and `remarks` with those of the body's `data` when it has them, and
//     answers 200 with the order. The specification makes `data.type` and `data.flightOffers` mandatory; the stub
//     accepts them and changes no flight offer. Scenario `version-conflict` answers 409 with 2552 (SIMULTANEOUS
//     UPDATE) and changes nothing.
//   - DELETE cancels the order and answers 204 without a body; from then on it is gone for every operation. Scenario
//     `version-conflict` answers 409 with 2552 and `cancel-refused` 400 with 4926 (OBE-049); both change nothing.
//
// `timeout` on PATCH and DELETE applies the change, then holds the answer and gives up with a 504; `timeout-lost` holds
// the answer without changing anything. GET knows no operation-specific scenario.
import { dictionariesOf, orderNotFound, toFlightOrder } from "../orders";
import type { FixtureLoader, HandlerContext, OperationHandler } from "../routes";
import {
  CANCEL_REFUSED,
  timedOut,
  VERSION_CONFLICT,
  type HeldResponse,
  type StubResponse,
} from "../scenarios";
import { FLIGHT_CREATE_ORDERS_FIXTURES, orderData } from "./create-orders";

const orderIdOf = (context: HandlerContext): string => context.pathParams["flight-orderId"] ?? "";

/** An order write: `timeout-lost` holds without writing, `timeout` writes then holds. */
function write(context: HandlerContext, apply: () => StubResponse): StubResponse | HeldResponse {
  if (context.scenario === "timeout-lost") {
    return timedOut();
  }
  const response = apply();
  return context.scenario === "timeout" ? timedOut() : response;
}

/** The handler of `getFlightOrder`, reading the dictionaries through `loadFixture`. */
export function getFlightOrderHandler(loadFixture: FixtureLoader): OperationHandler {
  return (context) => {
    const order = context.orders.get(orderIdOf(context));
    if (order === undefined) {
      return orderNotFound("id");
    }
    const { body: fixture } = loadFixture(FLIGHT_CREATE_ORDERS_FIXTURES, "success");
    return { status: 200, body: { data: toFlightOrder(order), ...dictionariesOf(fixture) } };
  };
}

/** The handler of `patchFlightOrder`, reading the dictionaries through `loadFixture`. */
export function patchFlightOrderHandler(loadFixture: FixtureLoader): OperationHandler {
  return (context) =>
    write(context, () => {
      const id = orderIdOf(context);
      if (context.orders.get(id) === undefined) {
        return orderNotFound("id");
      }
      if (context.scenario === "version-conflict") {
        return VERSION_CONFLICT;
      }
      const data = orderData(context.body);
      const patched = context.orders.patch(id, { contacts: data["contacts"], remarks: data["remarks"] });
      if (patched === undefined) {
        return orderNotFound("id");
      }
      const { body: fixture } = loadFixture(FLIGHT_CREATE_ORDERS_FIXTURES, "success");
      return { status: 200, body: { data: toFlightOrder(patched), ...dictionariesOf(fixture) } };
    });
}

/** The handler of `cancelFlightOrder`. */
export const cancelFlightOrderHandler: OperationHandler = (context) =>
  write(context, () => {
    const id = orderIdOf(context);
    if (context.orders.get(id) === undefined) {
      return orderNotFound("id");
    }
    if (context.scenario === "version-conflict") {
      return VERSION_CONFLICT;
    }
    if (context.scenario === "cancel-refused") {
      return CANCEL_REFUSED;
    }
    return context.orders.cancel(id) === undefined ? orderNotFound("id") : { status: 204, body: undefined };
  });
