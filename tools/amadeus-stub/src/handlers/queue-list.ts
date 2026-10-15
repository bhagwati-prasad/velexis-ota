// Queue List (`listQueue`, GET /v1/office/queues/{queue-id}) of the Amadeus stub (OBE-041): the orders that Flight
// Create Orders placed on queue `queue-id` through their `automatedProcess` (src/orders.ts), oldest first, at most
// `max` of them.
//
//   - A placement is on the queue `queue.number` and category `queue.category` (default 0) of the office
//     `automatedProcess[].officeId`, else of the order's `queuingOfficeId`. `category` (default 0) and `officeId`
//     choose the queue; a placement without any office is in every office (the stub does not know the caller's).
//   - `IMMEDIATE` (or no code) places the order at creation, `DELAYED` at its `dateTime`, else after its `delay`
//     (`2D`), on the stub's clock; `ERROR` places it nowhere. Cancelled orders are gone.
//   - Each entry is a `pnr` of the specification: `type: "pnrList"`, `id` `<record locator>-<creation day>`
//     (`ABC123-2027-01-15`), `creation.dateTime` to the minute in UTC without an offset (`2027-01-15T07:15`, the
//     specification's form), the travellers' names, and one product per flight segment (carrier, number, arrival).
//
// The answer is `{ "meta": { "count": n }, "data": [ … ] }`. No operation-specific scenario applies here.
import { localDate, type StoredOrder } from "../orders";
import type { OperationHandler } from "../routes";

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The `firstName` and `lastName` of a traveller's `name`, or `undefined` when it has neither. */
function namesOf(traveler: JsonObject): JsonObject | undefined {
  const name = isRecord(traveler["name"]) ? traveler["name"] : {};
  const names: JsonObject = {};
  for (const key of ["firstName", "lastName"]) {
    if (typeof name[key] === "string") {
      names[key] = name[key];
    }
  }
  return Object.keys(names).length > 0 ? names : undefined;
}

/** One product per flight segment of the order: carrier, flight number and arrival. */
function productsOf(order: StoredOrder): JsonObject[] {
  return order.flightOffers
    .flatMap((offer) => records(offer["itineraries"]).flatMap((itinerary) => records(itinerary["segments"])))
    .map((segment) => {
      const arrival = isRecord(segment["arrival"]) ? segment["arrival"] : {};
      return {
        airSegment: {
          segment: {
            carrierCode: segment["carrierCode"],
            number: segment["number"],
            arrival: { iataCode: arrival["iataCode"], localDateTime: arrival["at"] },
          },
        },
      };
    });
}

/** The Queue List entry (`pnr`) of a stored order. */
export function toQueueEntry(order: StoredOrder): JsonObject {
  return {
    type: "pnrList",
    id: `${order.recordLocator}-${localDate(order.createdAt)}`,
    creation: { dateTime: order.createdAt.toISOString().slice(0, 16) },
    travelers: order.travelers.flatMap((traveler) => {
      const names = namesOf(traveler);
      return names === undefined ? [] : [{ names: [names] }];
    }),
    products: productsOf(order),
  };
}

/** The handler of `listQueue`. */
export const listQueueHandler: OperationHandler = (context) => {
  const queue = Number(context.pathParams["queue-id"]);
  const category = context.query["category"];
  const officeId = context.query["officeId"];
  const max = context.query["max"];
  const orders = context.orders.onQueue(
    {
      queue,
      category: typeof category === "number" ? category : 0,
      officeId: typeof officeId === "string" ? officeId : undefined,
    },
    context.now,
  );
  const data = (typeof max === "number" && max >= 1 ? orders.slice(0, Math.floor(max)) : orders).map(
    toQueueEntry,
  );
  return { status: 200, body: { meta: { count: data.length }, data } };
};
