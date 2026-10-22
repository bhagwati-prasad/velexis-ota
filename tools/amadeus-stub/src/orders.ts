// The in-memory flight orders of the Amadeus stub (OBE-041): what Flight Create Orders stored, so that Flight Order
// Issue, Flight Order Management (GET, PATCH, DELETE), the by-reference GET and Queue List see the same orders, as the
// OTA backend's ticketing jobs and its reconciliation after a timeout need (ota/docs/architecture-booking.md §4).
//
// Each stub server has its own store (`createStubServer` creates one, `server.orders` shows it to tests, and
// `server.orders.reset()` empties it). An order keeps its id, record locator, creation time, offices, flight offers,
// travellers, remarks, contacts, forms of payment, ticketing agreement, automated processes and the queue placements
// they make, tickets, status (`active` until DELETE cancels it) and version (1 at creation, +1 per issue, PATCH or
// cancel). Values are copied in and out, so nothing outside the store changes a stored order. Tests play what the
// airline does to an order through `server.orders` too (OBE-045): a schedule change of one segment (`changeSegment`:
// new local times, a booking status) and a cancellation by the airline (`cancelByAirline`: every segment `CANCELLED`,
// the order still readable), each +1 on the version.
//
// Generated values: the record locator is 6 random letters and digits (unique per store; random so that orders of
// different stub runs never collide in a test database), the flight-order id is the base64url of `<locator>|<creation
// day>` (Amadeus's ids are base64 of the locator, a name and the day; the stub leaves the name out), and ticket numbers
// are `000-0000000001`, `000-0000000002`, … per store (the synthetic prefix of fixtures/README.md). Times are the
// injected clock's, written in UTC without an offset, as Amadeus writes local times.
//
// Card data: a credit card of a form of payment is kept as its brand, the last 4 characters of its number (answered as
// `XXXXXXXXXXXX1111`, the way Amadeus masks a card) and the flight offers it pays. The number, the security code, the
// expiry date, the holder and the payment operation context are never stored, so no answer, test helper or log shows
// them. `maskCardNumbers` does the same to the text of the request log (src/server.ts).
import { randomInt } from "node:crypto";
import { AMADEUS_ERROR_CODES, amadeusErrorResponse, type StubResponse } from "./scenarios";

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The test card number that every Flight Create Orders and Flight Order Issue refuses (error 1304). */
export const DECLINED_TEST_CARD = "4000000000000002";

/** What replaces all but the last 4 characters of a stored card number (`XXXXXXXXXXXX1111`). */
export const CARD_NUMBER_MASK = "XXXXXXXXXXXX";

/** The origin system code of the main record (`associatedRecords[0]`) and the only one the by-reference GET knows. */
export const ORIGIN_SYSTEM_CODE = "GDS";

/** The prefix of the ticket numbers the stub issues: the synthetic prefix of fixtures/README.md. */
export const TICKET_NUMBER_PREFIX = "000";

/** Where an order lands on a queue: an `automatedProcess` entry of the order. */
export interface QueuePlacement {
  /** The queue number (`automatedProcess[].queue.number`). */
  readonly queue: number;
  /** The category (`queue.category`, default 0). */
  readonly category: number;
  /** `automatedProcess[].officeId`, else the order's `queuingOfficeId`; `undefined` when neither is set. */
  readonly officeId: string | undefined;
  /** From when the order is on the queue: creation (`IMMEDIATE`), or the `dateTime` or `delay` of `DELAYED`. */
  readonly from: Date;
}

export type OrderStatus = "active" | "cancelled";

/** One stored order (a copy: changing it changes nothing in the store). */
export interface StoredOrder {
  readonly id: string;
  readonly recordLocator: string;
  readonly createdAt: Date;
  readonly status: OrderStatus;
  /** 1 at creation, +1 for each issue, PATCH and cancel. */
  readonly version: number;
  readonly queuingOfficeId: string | undefined;
  readonly ownerOfficeId: string | undefined;
  readonly flightOffers: readonly JsonObject[];
  readonly travelers: readonly JsonObject[];
  readonly remarks: JsonObject | undefined;
  readonly contacts: readonly JsonObject[] | undefined;
  /** The forms of payment, cards reduced to brand, masked number and flight offer ids. */
  readonly formOfPayments: readonly JsonObject[] | undefined;
  readonly ticketingAgreement: JsonObject | undefined;
  readonly automatedProcess: readonly JsonObject[] | undefined;
  readonly commissions: readonly JsonObject[] | undefined;
  readonly formOfIdentifications: readonly JsonObject[] | undefined;
  readonly queues: readonly QueuePlacement[];
  /** `AirTravelDocument`s: `{ documentType, documentNumber, documentStatus, travelerId, segmentIds }`. */
  readonly tickets: readonly JsonObject[];
}

/** The `bookingStatus` values of an Amadeus FlightSegment (Flight Order Management's specification). */
export const SEGMENT_BOOKING_STATUSES = [
  "CONFIRMED",
  "WAITLISTED",
  "CANCELLED",
  "PENDING",
  "DENIED",
] as const;
export type SegmentBookingStatus = (typeof SEGMENT_BOOKING_STATUSES)[number];

/**
 * A change the airline makes to a segment of an order (OBE-045: the booking sync's schedule changes), as tests play
 * it: new local times (`YYYY-MM-DDTHH:MM:SS`, or without seconds, as Amadeus writes `departure.at`), a booking status.
 */
export interface AirlineSegmentChange {
  readonly departureAt?: string;
  readonly arrivalAt?: string;
  readonly bookingStatus?: SegmentBookingStatus;
}

/** What tests see of a server's orders (`StubServer.orders`). */
export interface StubOrders {
  /** Every order, cancelled ones included, oldest first (copies). */
  list(): readonly StoredOrder[];
  /** Forgets every order, as a restarted stub would. */
  reset(): void;
  /**
   * Plays a schedule change by the airline (OBE-045): the segment `segmentId` of every flight offer of the active
   * order `id` takes the change, and the order's version goes up by one; the order stays readable everywhere. Answers
   * the changed order, or `undefined` when there is no such active order or segment. A malformed change throws.
   */
  changeSegment(id: string, segmentId: string, change: AirlineSegmentChange): StoredOrder | undefined;
  /**
   * Plays a cancellation by the airline (OBE-045; a time limit that lapsed, say): every segment of the active order
   * `id` becomes `bookingStatus: CANCELLED` and its version goes up by one. Unlike Management DELETE (a cancellation
   * by the agency, after which the order is gone), the order stays readable, as Amadeus shows the airline's cancelled
   * segments. Answers the changed order, or `undefined` when there is no such active order.
   */
  cancelByAirline(id: string): StoredOrder | undefined;
}

/** A local date-time as Amadeus writes `departure.at` and `arrival.at`. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** Which queue a Queue List reads. */
export interface QueueQuery {
  readonly queue: number;
  /** Default 0. */
  readonly category: number;
  /** Only placements of this office (a placement without an office is in every office). */
  readonly officeId?: string | undefined;
}

/** The changes a Flight Order Management PATCH can make. */
export interface OrderChanges {
  readonly contacts?: unknown;
  readonly remarks?: unknown;
}

type MutableOrder = { -readonly [K in keyof StoredOrder]: StoredOrder[K] };

const LOCATOR_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LOCATOR_LENGTH = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `2027-01-15T07:15:00.000` (UTC, no offset): the form of `associatedRecords[].creationDate`. */
export const localDateTime = (date: Date): string => date.toISOString().slice(0, 23);

/** `2027-01-15` (UTC). */
export const localDate = (date: Date): string => date.toISOString().slice(0, 10);

/** A non-negative integer given as a number or as a string of digits (`"50"`), else `undefined`. */
function integerOf(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  return typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** A date-time of the request (local, as Amadeus writes them, read as UTC), or `undefined`. */
function parseDateTime(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const date = new Date(hasOffset ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `createdAt` plus the days of a `delay` such as `6D`, or `undefined` for any other delay. */
function afterDelay(delay: unknown, createdAt: Date): Date | undefined {
  const days = typeof delay === "string" ? /^(\d{1,3})D$/i.exec(delay)?.[1] : undefined;
  return days === undefined ? undefined : new Date(createdAt.getTime() + Number(days) * DAY_MS);
}

/** The queue placements of an order's `automatedProcess` (an `ERROR` process places it nowhere). */
function placementsOf(
  automatedProcess: readonly JsonObject[],
  queuingOfficeId: string | undefined,
  createdAt: Date,
): QueuePlacement[] {
  const placements: QueuePlacement[] = [];
  for (const process of automatedProcess) {
    const code = optionalString(process["code"]) ?? "IMMEDIATE";
    const queue = isRecord(process["queue"]) ? process["queue"] : {};
    const number = integerOf(queue["number"]);
    const category = queue["category"] === undefined ? 0 : integerOf(queue["category"]);
    if (code === "ERROR" || number === undefined || category === undefined) {
      continue;
    }
    const from =
      code === "DELAYED"
        ? (parseDateTime(process["dateTime"]) ?? afterDelay(process["delay"], createdAt) ?? createdAt)
        : createdAt;
    placements.push({
      queue: number,
      category,
      officeId: optionalString(process["officeId"]) ?? queuingOfficeId,
      from,
    });
  }
  return placements;
}

/** A credit card reduced to what may be kept: brand, masked number (last 4 only), flight offer ids. */
function maskedCard(card: JsonObject): JsonObject {
  const number = optionalString(card["number"]);
  const flightOfferIds = strings(card["flightOfferIds"]);
  return {
    ...(typeof card["brand"] === "string" ? { brand: card["brand"] } : {}),
    ...(number === undefined
      ? {}
      : { number: CARD_NUMBER_MASK + (number.length > 4 ? number.slice(-4) : "") }),
    ...(flightOfferIds.length > 0 ? { flightOfferIds } : {}),
  };
}

/**
 * The forms of payment as the store keeps them: `creditCard` reduced by `maskedCard`, `b2bWallet` without its
 * `virtualCreditCardDetails` (a card), `other` as it is; any other key is dropped.
 */
export function storableFormOfPayments(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return records(value).map((formOfPayment) => {
    const kept: JsonObject = {};
    for (const [method, details] of Object.entries(formOfPayment)) {
      if (!isRecord(details)) {
        continue;
      }
      if (method === "creditCard") {
        kept[method] = maskedCard(details);
      } else if (method === "b2bWallet") {
        kept[method] = structuredClone(
          Object.fromEntries(Object.entries(details).filter(([key]) => key !== "virtualCreditCardDetails")),
        );
      } else if (method === "other") {
        kept[method] = structuredClone(details);
      }
    }
    return kept;
  });
}

/**
 * The JSON pointer (below the body's `data`) of the first credit card of `formOfPayments` whose number is the declined
 * test card, or `undefined` when none is.
 */
export function declinedCardPointer(formOfPayments: unknown): string | undefined {
  const index = Array.isArray(formOfPayments)
    ? formOfPayments.findIndex(
        (formOfPayment: unknown) =>
          isRecord(formOfPayment) &&
          isRecord(formOfPayment["creditCard"]) &&
          formOfPayment["creditCard"]["number"] === DECLINED_TEST_CARD,
      )
    : -1;
  return index < 0 ? undefined : `/formOfPayments/${index}/creditCard/number`;
}

/**
 * 13 to 19 digits, a single space, hyphen or percent-encoded space (`%20`, as a request path keeps it) allowed between
 * them: a card number (or anything that looks like one).
 */
const CARD_NUMBER_RUN = /(?<!\d)\d(?:(?:[ -]|%20)?\d){12,18}(?!\d)/g;

/** The separators a `CARD_NUMBER_RUN` may have between its digits. */
const CARD_NUMBER_SEPARATORS = /%20|[ -]/g;

/** `text` with every run of 13 to 19 digits masked to its last 4 (`XXXXXXXXXXXX1111`). */
export function maskCardNumbers(text: string): string {
  return text.replace(CARD_NUMBER_RUN, (run) => {
    const digits = run.replace(CARD_NUMBER_SEPARATORS, "");
    return "X".repeat(digits.length - 4) + digits.slice(-4);
  });
}

/** The segment ids of an order's flight offers, each once, in order. */
function segmentIdsOf(flightOffers: readonly JsonObject[]): string[] {
  const ids = flightOffers.flatMap((offer) =>
    records(offer["itineraries"]).flatMap((itinerary) =>
      records(itinerary["segments"]).flatMap((segment) => strings([segment["id"]])),
    ),
  );
  return [...new Set(ids)];
}

/** The segment ids that a traveller's pricings cover, each once (all segments when no pricing names them). */
function segmentIdsOfTraveler(flightOffers: readonly JsonObject[], travelerId: string): string[] {
  const ids = flightOffers.flatMap((offer) =>
    records(offer["travelerPricings"])
      .filter((pricing) => pricing["travelerId"] === travelerId)
      .flatMap((pricing) =>
        records(pricing["fareDetailsBySegment"]).flatMap((detail) => strings([detail["segmentId"]])),
      ),
  );
  return ids.length > 0 ? [...new Set(ids)] : segmentIdsOf(flightOffers);
}

/** The traveller ids of an order: `travelers[].id`, else the ids its flight offers' pricings name. */
function travelerIdsOf(order: StoredOrder): string[] {
  const ids = order.travelers.flatMap((traveler) => strings([traveler["id"]]));
  if (ids.length > 0) {
    return [...new Set(ids)];
  }
  return [
    ...new Set(
      order.flightOffers.flatMap((offer) =>
        records(offer["travelerPricings"]).flatMap((pricing) => strings([pricing["travelerId"]])),
      ),
    ),
  ];
}

/** Whether every traveller of the order has a ticket. */
export function isFullyIssued(order: StoredOrder): boolean {
  const ticketed = new Set(order.tickets.map((ticket) => ticket["travelerId"]));
  return travelerIdsOf(order).every((id) => ticketed.has(id));
}

/** The ticketing agreement as Amadeus answers it: with the `dateTime` (a day) that a `delay` such as `6D` gives. */
function answeredTicketingAgreement(value: unknown, createdAt: Date): JsonObject | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const agreement = structuredClone(value);
  const due = agreement["dateTime"] === undefined ? afterDelay(agreement["delay"], createdAt) : undefined;
  return due === undefined ? agreement : { ...agreement, dateTime: localDate(due) };
}

const copyRecords = (value: unknown): JsonObject[] | undefined =>
  Array.isArray(value) ? structuredClone(records(value)) : undefined;

const copyRecord = (value: unknown): JsonObject | undefined =>
  isRecord(value) ? structuredClone(value) : undefined;

function snapshot(order: MutableOrder): StoredOrder {
  return Object.freeze(structuredClone(order));
}

/** The in-memory orders of one stub server. */
export class OrderStore implements StubOrders {
  readonly #orders = new Map<string, MutableOrder>();
  #tickets = 0;

  /**
   * Stores the order of a Flight Create Orders body's `data` (validated against the specification) and returns it.
   * The read-only fields of the request (`id`, `associatedRecords`, `tickets`) are ignored; `issue` issues one
   * ticket per traveller at once.
   */
  create(data: JsonObject, options: { readonly now: Date; readonly issue: boolean }): StoredOrder {
    const createdAt = new Date(options.now.getTime());
    const recordLocator = this.#newLocator();
    const queuingOfficeId = optionalString(data["queuingOfficeId"]);
    const automatedProcess = copyRecords(data["automatedProcess"]);
    const order: MutableOrder = {
      id: Buffer.from(`${recordLocator}|${localDate(createdAt)}`).toString("base64url"),
      recordLocator,
      createdAt,
      status: "active",
      version: 1,
      queuingOfficeId,
      ownerOfficeId: optionalString(data["ownerOfficeId"]),
      flightOffers: copyRecords(data["flightOffers"]) ?? [],
      travelers: copyRecords(data["travelers"]) ?? [],
      remarks: copyRecord(data["remarks"]),
      contacts: copyRecords(data["contacts"]),
      formOfPayments: storableFormOfPayments(data["formOfPayments"]),
      ticketingAgreement: answeredTicketingAgreement(data["ticketingAgreement"], createdAt),
      automatedProcess,
      commissions: copyRecords(data["commissions"]),
      formOfIdentifications: copyRecords(data["formOfIdentifications"]),
      queues: placementsOf(automatedProcess ?? [], queuingOfficeId, createdAt),
      tickets: [],
    };
    if (options.issue) {
      order.tickets = this.#newTickets(order);
    }
    this.#orders.set(order.id, order);
    return snapshot(order);
  }

  /** The active order with this id, or `undefined` (none, or cancelled). */
  get(id: string): StoredOrder | undefined {
    const order = this.#active(id);
    return order === undefined ? undefined : snapshot(order);
  }

  /** The active order whose record locator is `recordLocator` (any case), or `undefined`. */
  byReference(recordLocator: string): StoredOrder | undefined {
    const wanted = recordLocator.toUpperCase();
    const order = [...this.#orders.values()].find(
      (candidate) => candidate.status === "active" && candidate.recordLocator === wanted,
    );
    return order === undefined ? undefined : snapshot(order);
  }

  /** The active orders on a queue at `now`, oldest first (queues are first in, first out). */
  onQueue(query: QueueQuery, now: Date): StoredOrder[] {
    const on = (placement: QueuePlacement): boolean =>
      placement.queue === query.queue &&
      placement.category === query.category &&
      (query.officeId === undefined ||
        placement.officeId === undefined ||
        placement.officeId === query.officeId) &&
      placement.from.getTime() <= now.getTime();
    return [...this.#orders.values()]
      .filter((order) => order.status === "active" && order.queues.some(on))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(snapshot);
  }

  /**
   * Issues one ticket per traveller without one and replaces the forms of payment when `formOfPayments` is an array;
   * `undefined` when there is no such active order.
   */
  issue(id: string, formOfPayments: unknown): StoredOrder | undefined {
    const order = this.#active(id);
    if (order === undefined) {
      return undefined;
    }
    order.tickets = [...order.tickets, ...this.#newTickets(order)];
    order.formOfPayments = storableFormOfPayments(formOfPayments) ?? order.formOfPayments;
    order.version += 1;
    return snapshot(order);
  }

  /** Replaces the order's `contacts` and `remarks` with those given; `undefined` when there is no such order. */
  patch(id: string, changes: OrderChanges): StoredOrder | undefined {
    const order = this.#active(id);
    if (order === undefined) {
      return undefined;
    }
    order.contacts = copyRecords(changes.contacts) ?? order.contacts;
    order.remarks = copyRecord(changes.remarks) ?? order.remarks;
    order.version += 1;
    return snapshot(order);
  }

  /** Cancels the order (it is gone for every operation); `undefined` when there is no such active order. */
  cancel(id: string): StoredOrder | undefined {
    const order = this.#active(id);
    if (order === undefined) {
      return undefined;
    }
    order.status = "cancelled";
    order.version += 1;
    return snapshot(order);
  }

  changeSegment(id: string, segmentId: string, change: AirlineSegmentChange): StoredOrder | undefined {
    for (const value of [change.departureAt, change.arrivalAt]) {
      if (value !== undefined && !LOCAL_DATE_TIME.test(value)) {
        throw new TypeError("changeSegment: a time is a local date-time YYYY-MM-DDTHH:MM[:SS]");
      }
    }
    if (
      change.bookingStatus !== undefined &&
      !(SEGMENT_BOOKING_STATUSES as readonly string[]).includes(change.bookingStatus)
    ) {
      throw new TypeError("changeSegment: bookingStatus is not a FlightSegment booking status");
    }
    const order = this.#active(id);
    if (order === undefined) {
      return undefined;
    }
    let found = false;
    const flightOffers = this.#mapSegments(order.flightOffers, (segment) => {
      if (segment["id"] !== segmentId) {
        return segment;
      }
      found = true;
      const departure = isRecord(segment["departure"]) ? segment["departure"] : {};
      const arrival = isRecord(segment["arrival"]) ? segment["arrival"] : {};
      return {
        ...segment,
        departure: change.departureAt === undefined ? departure : { ...departure, at: change.departureAt },
        arrival: change.arrivalAt === undefined ? arrival : { ...arrival, at: change.arrivalAt },
        ...(change.bookingStatus === undefined ? {} : { bookingStatus: change.bookingStatus }),
      };
    });
    if (!found) {
      return undefined;
    }
    order.flightOffers = flightOffers;
    order.version += 1;
    return snapshot(order);
  }

  cancelByAirline(id: string): StoredOrder | undefined {
    const order = this.#active(id);
    if (order === undefined) {
      return undefined;
    }
    order.flightOffers = this.#mapSegments(order.flightOffers, (segment) => ({
      ...segment,
      bookingStatus: "CANCELLED",
    }));
    order.version += 1;
    return snapshot(order);
  }

  list(): readonly StoredOrder[] {
    return [...this.#orders.values()].map(snapshot);
  }

  reset(): void {
    this.#orders.clear();
    this.#tickets = 0;
  }

  #active(id: string): MutableOrder | undefined {
    const order = this.#orders.get(id);
    return order?.status === "active" ? order : undefined;
  }

  /** Copies of `flightOffers` with every segment of every itinerary replaced by `change(segment)`. */
  #mapSegments(
    flightOffers: readonly JsonObject[],
    change: (segment: JsonObject) => JsonObject,
  ): JsonObject[] {
    return flightOffers.map((offer) => ({
      ...structuredClone(offer),
      itineraries: records(offer["itineraries"]).map((itinerary) => ({
        ...structuredClone(itinerary),
        segments: records(itinerary["segments"]).map((segment) => change(structuredClone(segment))),
      })),
    }));
  }

  #newLocator(): string {
    const taken = new Set([...this.#orders.values()].map((order) => order.recordLocator));
    for (;;) {
      const locator = Array.from(
        { length: LOCATOR_LENGTH },
        () => LOCATOR_ALPHABET[randomInt(LOCATOR_ALPHABET.length)],
      ).join("");
      if (!taken.has(locator)) {
        return locator;
      }
    }
  }

  /** One `ETICKET` per traveller of `order` that has none yet. */
  #newTickets(order: StoredOrder): JsonObject[] {
    const ticketed = new Set(order.tickets.map((ticket) => ticket["travelerId"]));
    return travelerIdsOf(order)
      .filter((travelerId) => !ticketed.has(travelerId))
      .map((travelerId) => {
        this.#tickets += 1;
        return {
          documentType: "ETICKET",
          documentNumber: `${TICKET_NUMBER_PREFIX}-${String(this.#tickets).padStart(10, "0")}`,
          documentStatus: "ISSUED",
          travelerId,
          segmentIds: segmentIdsOfTraveler(order.flightOffers, travelerId),
        };
      });
  }
}

// ---- Answers -----------------------------------------------------------------------------------------------------

/** The Amadeus `FlightOrder` of a stored order, its fields in the order of the specifications' schema. */
export function toFlightOrder(order: StoredOrder): JsonObject {
  const optional = (key: string, value: unknown): JsonObject =>
    value === undefined ? {} : { [key]: structuredClone(value) };
  return {
    type: "flight-order",
    id: order.id,
    ...optional("queuingOfficeId", order.queuingOfficeId),
    ...optional("ownerOfficeId", order.ownerOfficeId),
    associatedRecords: [
      {
        reference: order.recordLocator,
        creationDate: localDateTime(order.createdAt),
        originSystemCode: ORIGIN_SYSTEM_CODE,
        ...optional("flightOfferId", order.flightOffers[0]?.["id"]),
      },
    ],
    flightOffers: structuredClone(order.flightOffers),
    travelers: structuredClone(order.travelers),
    ...optional("remarks", order.remarks),
    ...optional("formOfPayments", order.formOfPayments),
    ...optional("ticketingAgreement", order.ticketingAgreement),
    ...optional("automatedProcess", order.automatedProcess),
    ...optional("contacts", order.contacts),
    ...(order.tickets.length > 0 ? { tickets: structuredClone(order.tickets) } : {}),
    ...optional("commissions", order.commissions),
    ...optional("formOfIdentifications", order.formOfIdentifications),
  };
}

/** `{ dictionaries }` of a fixture body, or `{}` when it has none. */
export function dictionariesOf(fixtureBody: unknown): JsonObject {
  return isRecord(fixtureBody) && fixtureBody["dictionaries"] !== undefined
    ? { dictionaries: fixtureBody["dictionaries"] }
    : {};
}

/** No active flight order with this id or record locator (cancelled orders are gone). */
export function orderNotFound(what: "id" | "record locator"): StubResponse {
  return amadeusErrorResponse([
    {
      status: 404,
      code: AMADEUS_ERROR_CODES.notFound,
      title: "NOT FOUND",
      detail: `No flight order with this ${what}`,
    },
  ]);
}

/** The refusal of the declined test card: a 400 with error 1304 naming the card's field, never its number. */
export function cardRefused(pointer: string): StubResponse {
  return amadeusErrorResponse([
    {
      status: 400,
      code: AMADEUS_ERROR_CODES.creditCardNotAccepted,
      title: "CREDIT CARD NOT ACCEPTED",
      detail: "The credit card was refused",
      source: { pointer },
    },
  ]);
}
