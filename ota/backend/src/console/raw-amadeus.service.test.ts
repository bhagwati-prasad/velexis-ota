// The raw Amadeus reads of the console (OBE-067, raw-amadeus.service.ts): the office isolation of the shared Amadeus
// account (ADR-0012, OF-09 AC3) applied to what the caller gets and to what the tenant's supplier log keeps, the
// answers (net prices verbatim, dictionaries for display, no card number), the error answers, and the use cases with
// fakes: the order read of another office refused after its row was withheld, the booking of a body checked before any
// call, the audit rows with their reason. The orders are the Amadeus stub's synthetic fixture (test/builders/
// bookings.ts); the HTTP, database and Amadeus paths are in test/integration/console/raw-amadeus.int.test.ts.
import { AppError, isAppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { buildCreatedOrderBody } from "../../test/builders/bookings";
import type { AmadeusCallOptions, AmadeusClient, AmadeusResponse } from "../amadeus/amadeus.client";
import { AmadeusOfficeNotAllowedError } from "../amadeus/amadeus.client";
import type { ConnectionResolver } from "../amadeus/connection-resolver";
import { mapAmadeusError } from "../amadeus/error-mapper";
import { Clock } from "../common/clock";
import type { IdGenerator } from "../common/ids";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import type { PnrImportRepository } from "./pnr-import.service";
import type { QueueSnapshotsRepository } from "./queue-snapshots.repository";
import {
  byReferenceReplyOf,
  ordersOf,
  partitionQueueEntries,
  queueAnswerOf,
  queueEntryOfficeOf,
  RAW_READS,
  rawErrorOf,
  rawRecordedResponseOf,
  rawReplyOf,
  RawAmadeusService,
  resultCountOf,
  type RawAmadeusRepository,
} from "./raw-amadeus.service";
import type { StaffActionEntry, StaffActionsWriter } from "./staff-actions.writer";

type JsonObject = Record<string, unknown>;

const OWN = "NCE1A0001";
const OWN_SECOND = "NCE1A0002";
const OTHER = "PAR1A0950";
const OFFICES = [OWN, OWN_SECOND];
const WITHHELD = "office_not_allowed";

/** The fixture's order (Madrid–Paris Orly, one adult) with `fields` over its data. */
function orderData(fields: JsonObject = {}): JsonObject {
  return { ...(buildCreatedOrderBody()["data"] as JsonObject), ...fields };
}

const DICTIONARIES = {
  locations: { MAD: { cityCode: "MAD", countryCode: "ES" }, ORY: { cityCode: "PAR", countryCode: "FR" } },
  carriers: { IB: "IBERIA" },
  aircraft: { "320": "AIRBUS A320" },
  currencies: { EUR: "EURO" },
};

const QUEUE_ENTRY = (locator: string, fields: JsonObject = {}): JsonObject => ({
  type: "pnrList",
  id: `${locator}-2026-11-20`,
  creation: { dateTime: "2026-11-20T10:20" },
  travelers: [{ names: [{ firstName: "TESTA", lastName: `SAMPLE${locator}` }] }],
  ...fields,
});

describe("office isolation of the order reads [OF-09 AC3]", () => {
  it("[OBE-067 AC1] keeps another office's orders out of the tenant's supplier log, owner office first", () => {
    const own = orderData({ id: "own", ownerOfficeId: OWN, queuingOfficeId: OWN });
    const queuedOnly = orderData({ id: "queued", ownerOfficeId: undefined, queuingOfficeId: OWN_SECOND });
    // Queued in one of the tenant's offices, owned by another: the owner office decides.
    const ownedElsewhere = orderData({
      id: "elsewhere",
      ownerOfficeId: OTHER,
      queuingOfficeId: OWN,
      travelers: [{ id: "1", name: { firstName: "OTHER", lastName: "OFFICEPAX" } }],
    });
    const noOffice = orderData({ id: "nowhere", ownerOfficeId: undefined, queuingOfficeId: undefined });
    const body = {
      data: [own, queuedOnly, ownedElsewhere, noOffice],
      included: { bags: {} },
      dictionaries: DICTIONARIES,
    };

    const recorded = rawRecordedResponseOf({ kind: "orders" }, OFFICES)(body);

    expect(recorded).toEqual({
      data: [
        own,
        queuedOnly,
        { type: "flight-order", id: "elsewhere", withheld: WITHHELD },
        { type: "flight-order", id: "nowhere", withheld: WITHHELD },
      ],
    });
    expect(JSON.stringify(recorded)).not.toContain("OFFICEPAX");
  });

  it("[OBE-067 AC1] withholds the one order of a Management GET of another office, and keeps the tenant's as it is", () => {
    const other = { data: orderData({ id: "other", ownerOfficeId: OTHER }), dictionaries: DICTIONARIES };
    const own = { data: orderData({ id: "own", ownerOfficeId: OWN }), dictionaries: DICTIONARIES };
    const hook = rawRecordedResponseOf({ kind: "orders" }, OFFICES);

    expect(hook(other)).toEqual({ data: { type: "flight-order", id: "other", withheld: WITHHELD } });
    // The very same object when nothing is withheld, and any other answer (an error) as it is.
    expect(hook(own)).toBe(own);
    const error = { errors: [{ status: 404, code: 1797, title: "NOT FOUND" }] };
    expect(hook(error)).toBe(error);
    expect(hook(undefined)).toBeUndefined();
  });

  it("reads the orders of a by-reference answer (a list) and of a Management GET (one order)", () => {
    const order = orderData({ id: "a" });
    expect(ordersOf({ data: [order, "not an order"] })).toEqual([order]);
    expect(ordersOf({ data: order })).toEqual([order]);
    expect(ordersOf({ errors: [] })).toEqual([]);
    expect(ordersOf("text")).toEqual([]);
  });

  it("[OBE-067 AC1] answers the tenant's orders only, without another office's bags and dictionaries", () => {
    const own = orderData({
      id: "own",
      ownerOfficeId: OWN,
      formOfPayments: [{ creditCard: { brand: "VISA", number: "4111111111111111", holder: "TESTA SAMPLE" } }],
    });
    const other = orderData({ id: "other", ownerOfficeId: OTHER });
    const body = {
      meta: { links: { self: "x" } },
      data: [own, other],
      included: { bags: {} },
      dictionaries: DICTIONARIES,
    };

    const withheld = byReferenceReplyOf(body, [own], true);
    const complete = byReferenceReplyOf({ ...body, data: [own] }, [own], false);

    expect(withheld).toEqual({
      meta: { links: { self: "x" } },
      data: [expect.objectContaining({ id: "own" })],
    });
    expect(complete).toMatchObject({
      included: { bags: {} },
      dictionaries: {
        carriers: DICTIONARIES.carriers,
        aircraft: DICTIONARIES.aircraft,
        locations: { key: "MAD", ...DICTIONARIES.locations },
        currencies: { key: "EUR", ...DICTIONARIES.currencies },
      },
    });
    // No card number reaches the console, whatever the order holds (OADR-0018 point 8).
    expect(JSON.stringify(complete)).not.toContain("4111111111111111");
    expect(JSON.stringify(complete)).not.toContain("TESTA SAMPLE");
  });
});

describe("office isolation of Queue List [OF-09 AC3]", () => {
  it("takes an entry as the queue office's unless it names an office of its own, owner first", () => {
    expect(queueEntryOfficeOf(QUEUE_ENTRY("AAA111"), OWN)).toBe(OWN);
    expect(queueEntryOfficeOf(QUEUE_ENTRY("AAA111", { queuingOfficeId: OWN_SECOND }), OWN)).toBe(OWN_SECOND);
    expect(
      queueEntryOfficeOf(QUEUE_ENTRY("AAA111", { queuingOfficeId: OWN, ownerOfficeId: OTHER }), OWN),
    ).toBe(OTHER);
  });

  it("[OBE-067 AC1] leaves another office's entries out of the answer and the supplier log", () => {
    const own = QUEUE_ENTRY("AAA111");
    const other = QUEUE_ENTRY("BBB222", { ownerOfficeId: OTHER });
    const body = { meta: { count: 2 }, data: [own, other] };

    const parts = partitionQueueEntries([own, other], OFFICES, OWN);
    const recorded = rawRecordedResponseOf({ kind: "queue", queueOffice: OWN }, OFFICES)(body);

    expect(parts).toEqual({ allowed: [own], withheld: [other] });
    expect(queueAnswerOf(body, parts.withheld)).toEqual({ meta: { count: 1 }, data: [own] });
    expect(recorded).toEqual({
      meta: { count: 2 },
      data: [own, { type: "pnrList", id: "BBB222-2026-11-20", withheld: WITHHELD }],
    });
    expect(JSON.stringify(recorded)).not.toContain("SAMPLEBBB222");
    // A queue of the tenant's office without such entries is kept as it is.
    const plain = { meta: { count: 1 }, data: [own] };
    expect(rawRecordedResponseOf({ kind: "queue", queueOffice: OWN }, OFFICES)(plain)).toBe(plain);
    expect(queueAnswerOf(plain, [])).toBe(plain);
  });
});

describe("the answers of the raw reads", () => {
  it("[FIX-W33-OTA] [OBE-067] answers Amadeus's body verbatim, every dictionary with the key its schema requires", () => {
    const offers = [
      { type: "flight-offer", id: "1", price: { currency: "EUR", total: "98.47", grandTotal: "98.47" } },
    ];
    // `locations` and `currencies` get the `key` of AmadeusLocationEntry and AmadeusCurrencyEntry from their own first
    // code in Amadeus's order, and keep every code Amadeus sent.
    expect(rawReplyOf({ meta: { count: 1 }, data: offers, dictionaries: DICTIONARIES })).toEqual({
      meta: { count: 1 },
      data: offers,
      dictionaries: {
        carriers: DICTIONARIES.carriers,
        aircraft: DICTIONARIES.aircraft,
        locations: {
          key: "MAD",
          MAD: { cityCode: "MAD", countryCode: "ES" },
          ORY: { cityCode: "PAR", countryCode: "FR" },
        },
        currencies: { key: "EUR", EUR: "EURO" },
      },
    });
    expect(
      rawReplyOf({ data: { flightOffers: offers }, dictionaries: { locations: DICTIONARIES.locations } }),
    ).toEqual({
      data: { flightOffers: offers },
      dictionaries: { locations: { key: "MAD", ...DICTIONARIES.locations } },
    });
    // Entries of another shape are left out, and an empty dictionary with them; nothing left, no dictionaries.
    expect(
      rawReplyOf({
        data: [],
        dictionaries: {
          locations: { MAD: "Madrid", CDG: { cityCode: 7 }, ORY: { cityCode: "PAR" } },
          currencies: { EUR: { name: "EURO" } },
        },
      }),
    ).toEqual({ data: [], dictionaries: { locations: { key: "ORY", ORY: { cityCode: "PAR" } } } });
    expect(rawReplyOf({ data: [], dictionaries: { locations: {}, currencies: { EUR: 1 } } })).toEqual({
      data: [],
    });
  });

  it("counts the results of an answer for the audit row", () => {
    expect(resultCountOf({ data: [1, 2, 3] })).toBe(3);
    expect(resultCountOf({ data: { flightOffers: [] } })).toBe(1);
    expect(resultCountOf({})).toBe(0);
  });

  it("names each read's supplier log operation and audit action after its SDK method", () => {
    expect(
      Object.values(RAW_READS).map((read) => [read.operationId, read.client, read.operation, read.action]),
    ).toEqual([
      [
        "consoleAmadeusSearchFlightOffers",
        "searchFlightOffers",
        "console.amadeus.searchFlightOffers",
        "amadeus.searchFlightOffers",
      ],
      [
        "consoleAmadeusGetFlightOffers",
        "getFlightOffers",
        "console.amadeus.getFlightOffers",
        "amadeus.getFlightOffers",
      ],
      [
        "consoleAmadeusSearchFlightAvailabilities",
        "searchFlightAvailabilities",
        "console.amadeus.searchFlightAvailabilities",
        "amadeus.searchFlightAvailabilities",
      ],
      [
        "consoleAmadeusUpsellAirOffers",
        "upsellAirOffers",
        "console.amadeus.upsellAirOffers",
        "amadeus.upsellAirOffers",
      ],
      [
        "consoleAmadeusQuoteAirOffers",
        "quoteAirOffers",
        "console.amadeus.quoteAirOffers",
        "amadeus.quoteAirOffers",
      ],
      [
        "consoleAmadeusGetFlightOrder",
        "getFlightOrder",
        "console.amadeus.getFlightOrder",
        "amadeus.getFlightOrder",
      ],
      [
        "consoleAmadeusGetFlightOrderByReference",
        "getFlightOrderByReference",
        "console.amadeus.getFlightOrderByReference",
        "amadeus.getFlightOrderByReference",
      ],
      ["consoleAmadeusGetQueue", "listQueue", "console.amadeus.getQueue", "amadeus.getQueue"],
    ]);
  });
});

describe("the error answers of the raw reads", () => {
  const http = (status: number, code?: number) =>
    mapAmadeusError("quoteAirOffers", {
      kind: "http",
      status,
      issues: [{ status, ...(code === undefined ? {} : { code }), title: "AMADEUS SAYS NO" }],
    });
  const outcome = (error: unknown): unknown =>
    isAppError(error) ? [error.status, error.code, error.details, error.supplier?.code] : error;
  const issues = (status: number, code?: number) => [
    { provider: "amadeus", status, ...(code === undefined ? {} : { code }), title: "AMADEUS SAYS NO" },
  ];

  it("answers every Amadeus 4xx of a shopping read as 422 SUPPLIER_REJECTED with the verbatim errors", () => {
    const read = RAW_READS.quoteAirOffers;
    for (const [status, code] of [
      [400, 4926],
      [400, 34651], // SOLD_OUT for the storefront
      [400, 37200], // PRICE_CHANGED
      [400, 9112], // TICKETING_FAILED
      [403, undefined], // OFFICE_NOT_ALLOWED for the order reads
      [404, undefined],
    ] as const) {
      expect(outcome(rawErrorOf(read, http(status, code), "sreq_01JA4H1A3C5E7G9J1L3N5Q7S9U"))).toEqual([
        422,
        "SUPPLIER_REJECTED",
        { supplierRequestId: "sreq_01JA4H1A3C5E7G9J1L3N5Q7S9U", errors: issues(status, code) },
        code,
      ]);
    }
  });

  it("answers an order read's Amadeus 404 as 404 NOT_FOUND and its 403 as 403 OFFICE_NOT_ALLOWED", () => {
    const read = RAW_READS.getFlightOrder;
    expect(outcome(rawErrorOf(read, http(404, 1797), null))).toEqual([
      404,
      "NOT_FOUND",
      { errors: issues(404, 1797) },
      1797,
    ]);
    expect(outcome(rawErrorOf(read, http(403), null))).toEqual([
      403,
      "OFFICE_NOT_ALLOWED",
      { errors: issues(403) },
      undefined,
    ]);
    expect(outcome(rawErrorOf(RAW_READS.getQueue, http(403), null))).toEqual([
      403,
      "OFFICE_NOT_ALLOWED",
      { errors: issues(403) },
      undefined,
    ]);
  });

  it("passes the client's other documented codes, and makes anything else 502 SUPPLIER_ERROR", () => {
    const read = RAW_READS.searchFlightOffers;
    const timeout = mapAmadeusError("searchFlightOffers", { kind: "timeout" });
    expect(outcome(rawErrorOf(read, timeout, null))).toEqual([
      504,
      "SUPPLIER_TIMEOUT",
      { errors: [] },
      undefined,
    ]);
    expect(outcome(rawErrorOf(read, http(500, 141), null))).toEqual([
      502,
      "SUPPLIER_ERROR",
      { errors: issues(500, 141) },
      141,
    ]);
    expect(outcome(rawErrorOf(read, http(503), null))).toEqual([
      503,
      "SUPPLIER_UNAVAILABLE",
      { errors: issues(503) },
      undefined,
    ]);
    // Refusals before any answer pass as they are: the connection, the buckets.
    const limited = new AppError("RATE_LIMITED", { details: { retryAfterSeconds: 1 } });
    expect(rawErrorOf(read, limited, null)).toBe(limited);
    const unconfigured = new AppError("SUPPLIER_NOT_CONFIGURED");
    expect(rawErrorOf(read, unconfigured, null)).toBe(unconfigured);
    // The client's office refusal before any call: Queue List documents it, a search cannot meet it.
    const office = new AppError("OFFICE_NOT_ALLOWED", {
      cause: new AmadeusOfficeNotAllowedError("officeId"),
    });
    expect(rawErrorOf(RAW_READS.getQueue, office, null)).toBe(office);
    expect(outcome(rawErrorOf(read, office, null))).toEqual([502, "SUPPLIER_ERROR", undefined, undefined]);
    const bug = new TypeError("a bug");
    expect(rawErrorOf(read, bug, null)).toBe(bug);
  });
});

// ---- The use cases, with fakes ---------------------------------------------------------------------------------------

const TRX = {} as TenantTransaction;
const TENANT: RequestTenant = {
  tenantId: "ten_01JA4H1A3C5E7G9J1L3N5Q7S9U",
  key: "alpha",
  schemaName: "tenant_alpha" as RequestTenant["schemaName"],
  environment: "test",
  caller: { type: "service" } as unknown as RequestTenant["caller"],
  actor: { type: "staff", id: "stf_01JA4H1A3C5E7G9J1L3N5Q7S9U" } as RequestTenant["actor"],
  requestId: "req_01JA4H1A3C5E7G9J1L3N5Q7S9U",
};

function harness(reply: { readonly body: unknown; readonly officeId?: string }) {
  const entries: StaffActionEntry[] = [];
  // What the client's supplier_requests row stores of each answer: its `recordedResponse` of it (AmadeusClient).
  const recorded: unknown[] = [];
  const response = (options: AmadeusCallOptions): AmadeusResponse<unknown> => {
    recorded.push(options.recordedResponse === undefined ? reply.body : options.recordedResponse(reply.body));
    return {
      body: reply.body,
      call: {
        supplierRequestId: "sreq_01JA4H1A3C5E7G9J1L3N5Q7S9U",
        officeId: reply.officeId ?? OWN,
        status: 200,
        durationMs: 12,
        correlationId: "0005K2D7QX1JZT",
        attempts: 1,
      },
    };
  };
  const call = (_context: unknown, _request: unknown, options: AmadeusCallOptions) =>
    Promise.resolve(response(options));
  const amadeus = {
    searchFlightOffers: vi.fn(call),
    getFlightOrder: vi.fn(call),
  };
  const repository = {
    bookingExists: vi.fn(() => Promise.resolve(false)),
    orderBooking: vi.fn(() => Promise.resolve(undefined)),
    lastSupplierRequestId: vi.fn(() => Promise.resolve(undefined)),
  };
  const audit = {
    recordAlone: vi.fn((entry: StaffActionEntry) => {
      entries.push(entry);
      return Promise.resolve(`sact_0${entries.length}JA4H1A3C5E7G9J1L3N5Q7S9U`);
    }),
  };
  const service = new RawAmadeusService(
    { run: (fn: (trx: TenantTransaction) => Promise<unknown>) => fn(TRX) } as unknown as TenantTx,
    repository as unknown as RawAmadeusRepository,
    {} as PnrImportRepository,
    {} as QueueSnapshotsRepository,
    amadeus as unknown as AmadeusClient,
    {
      resolve: () =>
        Promise.resolve({
          officeIds: OFFICES,
          offices: { queuing: OWN, owner: OWN, queue: OWN, retrieval: OWN },
        }),
    } as unknown as ConnectionResolver,
    audit as unknown as StaffActionsWriter,
    { require: () => TENANT, requestId: () => undefined } as unknown as TenantContext,
    { newId: () => "qsn_01JA4H1A3C5E7G9J1L3N5Q7S9U" } as unknown as IdGenerator,
    new Clock(),
    { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as PinoLogger,
  );
  return { service, amadeus, repository, entries, recorded };
}

describe("the raw read use cases", () => {
  it("[OBE-067 AC1] [OF-09 AC3] refuses another office's order after withholding it from the supplier log, with a denied row", async () => {
    const other = orderData({ id: "eJzOther0001", ownerOfficeId: OTHER, queuingOfficeId: OTHER });
    const h = harness({ body: { data: other, dictionaries: DICTIONARIES } });

    const error = await h.service.getFlightOrder("eJzOther0001", {}).catch((caught: unknown) => caught);

    expect(isAppError(error) ? [error.status, error.code] : error).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    // The client's row holds the withheld order from its first write (its recordedResponse hook).
    expect(h.amadeus.getFlightOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      recordedResponse: expect.any(Function),
    });
    expect(h.recorded).toEqual([{ data: { type: "flight-order", id: "eJzOther0001", withheld: WITHHELD } }]);
    expect(h.entries).toEqual([
      expect.objectContaining({
        action: "amadeus.getFlightOrder",
        outcome: "denied",
        targetType: "flight_order",
        targetId: "eJzOther0001",
      }),
    ]);
  });

  it("[OBE-067 AC1] answers the tenant's order with its call and audit row, the supplier log untouched", async () => {
    const own = orderData({ id: "eJzOwn000001", ownerOfficeId: OWN_SECOND });
    const body = { data: own };
    const h = harness({ body, officeId: OWN });

    const result = await h.service.getFlightOrder("eJzOwn000001", { include: ["bags"] });

    expect(result).toMatchObject({
      flightOrderId: "eJzOwn000001",
      bookingId: null,
      bookingSynced: false,
      call: {
        supplierRequestId: "sreq_01JA4H1A3C5E7G9J1L3N5Q7S9U",
        officeId: OWN,
        path: "/v1/booking/flight-orders/eJzOwn000001?include=bags",
        staffActionId: "sact_01JA4H1A3C5E7G9J1L3N5Q7S9U",
      },
    });
    expect(h.amadeus.getFlightOrder).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "console.amadeus.getFlightOrder", staffId: TENANT.actor.id }),
      { flightOrderId: "eJzOwn000001", query: { include: ["bags"] } },
      { recordedResponse: expect.any(Function) },
    );
    // The row stores the very answer: nothing of the tenant's own order is withheld.
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toBe(body);
    expect(h.entries).toEqual([
      expect.objectContaining({ action: "amadeus.getFlightOrder", targetId: "eJzOwn000001" }),
    ]);
  });

  it("refuses a body's bookingId of no booking of the environment before any call", async () => {
    const h = harness({ body: { data: [] } });

    const error = await h.service
      .searchFlightOffers({ amadeus: {} as never, bookingId: "bkg_01JA4H1A3C5E7G9J1L3N5Q7S9U" })
      .catch((caught: unknown) => caught);

    expect(isAppError(error) ? [error.code, error.fieldErrors] : error).toEqual([
      "VALIDATION_FAILED",
      [expect.objectContaining({ path: "/bookingId", code: "not_found" })],
    ]);
    expect(h.amadeus.searchFlightOffers).not.toHaveBeenCalled();
    expect(h.entries).toEqual([]);
  });

  it("[OBE-067 AC1] passes a search body to the client as it is and audits the reason", async () => {
    const h = harness({ body: { meta: { count: 0 }, data: [] } });
    const amadeus = { originDestinations: [], travelers: [], sources: ["GDS"] } as never;

    const result = await h.service.searchFlightOffers({ amadeus, reason: "Corporate request" });

    expect(h.amadeus.searchFlightOffers).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "console.amadeus.searchFlightOffers" }),
      { body: amadeus },
      {},
    );
    expect(result.amadeus).toEqual({ meta: { count: 0 }, data: [] });
    expect(h.entries).toEqual([
      expect.objectContaining({
        action: "amadeus.searchFlightOffers",
        reason: "Corporate request",
        after: expect.objectContaining({ supplierRequestId: "sreq_01JA4H1A3C5E7G9J1L3N5Q7S9U", results: 0 }),
      }),
    ]);
  });
});
