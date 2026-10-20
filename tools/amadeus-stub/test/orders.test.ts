// The order operations of the Amadeus stub (OBE-041): Flight Create Orders, Flight Order Issue, Flight Order
// Management (GET, PATCH, DELETE), the by-reference GET and Queue List on the server's in-memory orders, their
// fixtures, the declined test card, the order scenarios and the request log. Like server.test.ts, every test starts the
// stub in-process on a free port of 127.0.0.1 and needs nothing else running.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AmadeusSpecs,
  CARD_NUMBER_MASK,
  createStubServer,
  DECLINED_TEST_CARD,
  loadFixture,
  maskCardNumbers,
  OAUTH_TOKEN_PATH,
  STUB_OPERATIONS,
  STUB_SCENARIOS,
  TIMEOUT_HOLD_MS,
  type AmadeusIssue,
  type OperationName,
  type RecordedRequest,
  type StoredOrder,
  type StubOperation,
  type StubServer,
  type StubServerOptions,
  type StubTimers,
} from "../src/index";

const ORDERS_PATH = "/v1/booking/flight-orders";
const BY_REFERENCE_PATH = `${ORDERS_PATH}/by-reference`;
const QUEUES_PATH = "/v1/office/queues";
const OFFICE = "NCE1A0955";
/** The creation time of the fixtures' order. */
const FIXTURE_TIME = "2026-10-15T09:00:00.000Z";
/** The fixtures' generated values: record locator `SYN001` and the id the stub derives from it. */
const FIXTURE_LOCATOR = "SYN001";
const FIXTURE_ORDER_ID = Buffer.from(`${FIXTURE_LOCATOR}|2026-10-15`).toString("base64url");
/** A Visa test number the stub accepts, and its last 12 digits. */
const ACCEPTED_CARD = "4111111111111111";
/** The same number as people write it, in groups of 4. */
const SPACED_CARD = "4111 1111 1111 1111";

type Json = Record<string, unknown>;

interface ErrorBody {
  readonly errors: readonly AmadeusIssue[];
}
interface FlightOrder extends Json {
  readonly id: string;
  readonly associatedRecords: readonly { readonly reference: string; readonly creationDate: string }[];
  readonly tickets?: readonly Json[];
  readonly contacts?: readonly Json[];
  readonly remarks?: Json;
  readonly formOfPayments?: readonly Json[];
}
interface OrderBody {
  readonly warnings?: readonly AmadeusIssue[];
  readonly data: FlightOrder;
  readonly dictionaries?: unknown;
}
interface QueueEntry {
  readonly type: string;
  readonly id: string;
  readonly creation: { readonly dateTime: string };
  readonly travelers: readonly { readonly names: readonly Json[] }[];
  readonly products: readonly Json[];
}
interface QueueBody {
  readonly meta: { readonly count: number };
  readonly data: readonly QueueEntry[];
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

/** A clock the test moves (`set`, `advance`); the stub reads token expiry, creation times and queue times from it. */
function testClock(start = FIXTURE_TIME): {
  readonly clock: { now(): Date };
  set(iso: string): void;
  advance(ms: number): void;
} {
  let current = new Date(start).getTime();
  return {
    clock: { now: () => new Date(current) },
    set: (iso) => {
      current = new Date(iso).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
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

/** Fires the one held response and returns how long it was to be held. */
async function fireHeld(pending: Map<number, () => void>): Promise<void> {
  await vi.waitFor(() => expect(pending.size).toBe(1));
  const [fire] = [...pending.values()];
  pending.clear();
  fire?.();
}

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

function send(
  stub: StubServer,
  method: "POST" | "PATCH" | "GET" | "DELETE",
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return fetch(`${stub.url}${path}`, {
    method,
    headers: { "content-type": "application/vnd.amadeus+json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const scenario = (name: string): Record<string, string> => ({ "x-stub-scenario": name });

function fixtureBody<T = Json>(operation: string): T {
  return loadFixture(operation, "success").body as T;
}

/** Priced offer 2 of the Flight Offers Price fixture (Iberia Madrid to Orly, one adult), as the client books it. */
function pricedOffer(): Json {
  const offers = fixtureBody<{ data: { flightOffers: Json[] } }>("flight-offers-price").data.flightOffers;
  const [offer] = offers;
  if (offer === undefined) {
    throw new Error("the pricing fixture has no offer");
  }
  return offer;
}

const PHONE = { deviceType: "MOBILE", countryCallingCode: "44", number: "7700900123" };

function traveler(id: string, firstName: string, lastName: string): Json {
  return {
    id,
    dateOfBirth: "1990-01-01",
    name: { firstName, lastName },
    gender: "MALE",
    contact: { emailAddress: `person${id}@example.com`, phones: [PHONE] },
  };
}

/** The order of the fixtures: priced offer 2 for ALEX TESTER, remark, queue 50/0 of NCE1A0955, cash. */
function orderData(extra: Json = {}): Json {
  return {
    type: "flight-order",
    queuingOfficeId: OFFICE,
    flightOffers: [pricedOffer()],
    travelers: [traveler("1", "ALEX", "TESTER")],
    remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: "VELEXIS VX7K2M9Q" }] },
    formOfPayments: [{ other: { method: "CASH", flightOfferIds: ["2"] } }],
    ticketingAgreement: { option: "CONFIRM" },
    automatedProcess: [{ code: "IMMEDIATE", queue: { number: "50", category: "0" }, officeId: OFFICE }],
    contacts: [
      {
        addresseeName: { firstName: "ALEX", lastName: "TESTER" },
        purpose: "STANDARD",
        phones: [PHONE],
        emailAddress: "person1@example.com",
      },
    ],
    ...extra,
  };
}

/** Priced offer 2 for two adults: ALEX TESTER (1) and BLAKE SAMPLE (2). */
function twoTravelerOrder(): Json {
  const offer = pricedOffer();
  const pricings = offer["travelerPricings"] as Json[];
  const [first] = pricings;
  return orderData({
    flightOffers: [{ ...offer, travelerPricings: [first, { ...first, travelerId: "2" }] }],
    travelers: [traveler("1", "ALEX", "TESTER"), traveler("2", "BLAKE", "SAMPLE")],
  });
}

const CREDIT_CARD = (number: string): Json => ({
  creditCard: {
    brand: "VISA",
    holder: "ALEX TESTER",
    number,
    expiryDate: "2099-12",
    securityCode: "123",
    flightOfferIds: ["2"],
  },
});

async function createOrder(
  stub: StubServer,
  headers: Record<string, string>,
  data: Json = orderData(),
  query = "",
): Promise<FlightOrder> {
  const res = await send(stub, "POST", `${ORDERS_PATH}${query}`, headers, { data });
  expect(res.status).toBe(201);
  return (await json<OrderBody>(res)).data;
}

function orderPath(id: string, suffix = ""): string {
  return `${ORDERS_PATH}/${encodeURIComponent(id)}${suffix}`;
}

const locatorOf = (order: FlightOrder): string => order.associatedRecords[0]?.reference ?? "";

/** `body` with the generated id and record locator of its order replaced by the fixtures' ones. */
function withFixtureIds<T extends { readonly data: FlightOrder }>(body: T): T {
  const [record, ...others] = body.data.associatedRecords;
  return {
    ...body,
    data: {
      ...body.data,
      id: FIXTURE_ORDER_ID,
      associatedRecords: [{ ...record, reference: FIXTURE_LOCATOR }, ...others],
    },
  };
}

function operationNamed(name: OperationName): StubOperation {
  const found = STUB_OPERATIONS.find((op) => op.name === name);
  if (found === undefined) {
    throw new Error(`${name} is missing from the route table`);
  }
  return found;
}

/** One instance for every response check of this file: each response validator is compiled once. */
let responseSpecs: AmadeusSpecs | undefined;

/** Problems of a response against its schema, without the dictionaries defect of the specifications. */
function schemaProblems(name: OperationName, status: number, body: unknown): readonly unknown[] {
  responseSpecs ??= new AmadeusSpecs();
  return responseSpecs
    .validateResponse(operationNamed(name).spec, status, body)
    .filter(
      (p) =>
        !(
          p.keyword === "required" &&
          p.params["missingProperty"] === "key" &&
          ["/dictionaries/locations", "/dictionaries/currencies"].includes(p.instancePath)
        ),
    );
}

async function getOrder(stub: StubServer, headers: Record<string, string>, id: string): Promise<Response> {
  return send(stub, "GET", orderPath(id), headers);
}

async function byReference(
  stub: StubServer,
  headers: Record<string, string>,
  locator: string,
): Promise<Response> {
  return send(stub, "GET", `${BY_REFERENCE_PATH}?reference=${locator}&originSystemCode=GDS`, headers);
}

async function queue(
  stub: StubServer,
  headers: Record<string, string>,
  queueId: number,
  query = "",
): Promise<QueueBody> {
  const res = await send(stub, "GET", `${QUEUES_PATH}/${queueId}${query}`, headers);
  expect(res.status).toBe(200);
  return json<QueueBody>(res);
}

function onlyOrder(stub: StubServer): StoredOrder {
  const orders = stub.orders.list();
  expect(orders).toHaveLength(1);
  const [order] = orders;
  if (order === undefined) {
    throw new Error("no order");
  }
  return order;
}

describe("Flight Create Orders", () => {
  it("stores the order and answers it like the fixture, apart from the generated id and record locator [OBE-041 AC1]", async () => {
    const { clock } = testClock();
    const stub = await startStub({ clock });
    const headers = await authorized(stub);
    const res = await send(stub, "POST", ORDERS_PATH, headers, { data: orderData() });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/vnd.amadeus+json");
    const body = await json<OrderBody>(res);
    expect(withFixtureIds(body)).toEqual(fixtureBody("flight-create-orders"));

    const locator = locatorOf(body.data);
    expect(locator).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.data.id).toBe(Buffer.from(`${locator}|2026-10-15`).toString("base64url"));
    expect(body.data.associatedRecords).toEqual([
      {
        reference: locator,
        creationDate: "2026-10-15T09:00:00.000",
        originSystemCode: "GDS",
        flightOfferId: "2",
      },
    ]);
    expect(body.data.tickets).toBeUndefined();
    expect(onlyOrder(stub)).toMatchObject({
      id: body.data.id,
      recordLocator: locator,
      status: "active",
      version: 1,
      createdAt: new Date(FIXTURE_TIME),
      queues: [{ queue: 50, category: 0, officeId: OFFICE, from: new Date(FIXTURE_TIME) }],
      tickets: [],
    });
    expect(stub.requests().at(-1)).toMatchObject({ operation: "createFlightOrders", status: 201 });
  });

  it("shows a created order through Management GET, by-reference GET and Queue List [OBE-041 AC1]", async () => {
    const { clock } = testClock();
    const stub = await startStub({ clock });
    const headers = await authorized(stub);
    const created = await createOrder(stub, headers);
    const locator = locatorOf(created);

    const get = await getOrder(stub, headers, created.id);
    expect(get.status).toBe(200);
    const got = await json<OrderBody>(get);
    expect(got.data).toEqual(created);
    expect(schemaProblems("getFlightOrder", 200, got)).toEqual([]);

    // The record locator in any case.
    const reference = await byReference(stub, headers, locator.toLowerCase());
    expect(reference.status).toBe(200);
    const referenced = await json<{ data: FlightOrder[] }>(reference);
    expect(referenced.data).toEqual([created]);
    expect(schemaProblems("getFlightOrderByReference", 200, referenced)).toEqual([]);

    const listed = await queue(stub, headers, 50);
    expect(listed).toEqual({
      meta: { count: 1 },
      data: [
        {
          type: "pnrList",
          id: `${locator}-2026-10-15`,
          creation: { dateTime: "2026-10-15T09:00" },
          travelers: [{ names: [{ firstName: "ALEX", lastName: "TESTER" }] }],
          products: [
            {
              airSegment: {
                segment: {
                  carrierCode: "IB",
                  number: "3436",
                  arrival: { iataCode: "ORY", localDateTime: "2027-01-15T09:20:00" },
                },
              },
            },
          ],
        },
      ],
    });
    expect(schemaProblems("listQueue", 200, listed)).toEqual([]);
    expect(await queue(stub, headers, 50, `?category=0&officeId=${OFFICE}&max=5`)).toEqual(listed);
    // Another queue, category or office does not have it.
    expect((await queue(stub, headers, 51)).data).toEqual([]);
    expect((await queue(stub, headers, 50, "?category=1")).data).toEqual([]);
    expect((await queue(stub, headers, 50, "?officeId=PAR1A0001")).data).toEqual([]);
    expect(stub.requests().map((r) => [r.operation, r.status])).toEqual([
      ["oauth2Token", 200],
      ["createFlightOrders", 201],
      ["getFlightOrder", 200],
      ["getFlightOrderByReference", 200],
      ["listQueue", 200],
      ["listQueue", 200],
      ["listQueue", 200],
      ["listQueue", 200],
      ["listQueue", 200],
    ]);
  });

  it("issues one e-ticket per traveller at once with issue=true [OBE-041 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const created = await createOrder(stub, headers, twoTravelerOrder(), "?issue=true");
    expect(created.tickets).toEqual([
      {
        documentType: "ETICKET",
        documentNumber: "000-0000000001",
        documentStatus: "ISSUED",
        travelerId: "1",
        segmentIds: ["3"],
      },
      {
        documentType: "ETICKET",
        documentNumber: "000-0000000002",
        documentStatus: "ISSUED",
        travelerId: "2",
        segmentIds: ["3"],
      },
    ]);
    const listed = await queue(stub, headers, 50);
    expect(listed.data[0]?.travelers).toEqual([
      { names: [{ firstName: "ALEX", lastName: "TESTER" }] },
      { names: [{ firstName: "BLAKE", lastName: "SAMPLE" }] },
    ]);
    // issue=false (the default) issues nothing.
    expect((await createOrder(stub, headers, orderData(), "?issue=false")).tickets).toBeUndefined();
  });

  it("places orders on the queues of their automatedProcess when due, oldest first, at most max [OBE-041 AC1]", async () => {
    const time = testClock();
    const stub = await startStub({ clock: time.clock });
    let headers = await authorized(stub);
    const first = await createOrder(
      stub,
      headers,
      orderData({
        automatedProcess: [
          { code: "IMMEDIATE", queue: { number: "50", category: "0" }, officeId: OFFICE },
          { code: "DELAYED", queue: { number: "60" }, delay: "2D" },
          { code: "DELAYED", queue: { number: "61", category: "3" }, dateTime: "2026-10-16T12:00:00" },
          { code: "ERROR", queue: { number: "62" } },
        ],
        ticketingAgreement: { option: "DELAY_TO_QUEUE", delay: "6D" },
      }),
    );
    // A ticketing agreement's delay is answered with the day it gives.
    expect(first["ticketingAgreement"]).toEqual({
      option: "DELAY_TO_QUEUE",
      delay: "6D",
      dateTime: "2026-10-21",
    });
    time.advance(60_000);
    // No office anywhere: the placement is in every office.
    const second = await createOrder(
      stub,
      headers,
      orderData({ queuingOfficeId: undefined, automatedProcess: [{ queue: { number: "50" } }] }),
    );
    time.advance(60_000);
    const third = await createOrder(stub, headers, orderData());

    const ids = (body: QueueBody): string[] => body.data.map((entry) => entry.id.slice(0, 6));
    expect(ids(await queue(stub, headers, 50))).toEqual([first, second, third].map(locatorOf));
    expect(ids(await queue(stub, headers, 50, "?max=2"))).toEqual([first, second].map(locatorOf));
    expect(ids(await queue(stub, headers, 50, "?officeId=PAR1A0001"))).toEqual([locatorOf(second)]);
    expect((await queue(stub, headers, 60)).data).toEqual([]);
    expect((await queue(stub, headers, 61, "?category=3")).data).toEqual([]);

    time.set("2026-10-16T12:00:00.000Z");
    headers = await authorized(stub);
    expect(ids(await queue(stub, headers, 61, "?category=3"))).toEqual([locatorOf(first)]);
    expect((await queue(stub, headers, 60)).data).toEqual([]);
    time.set("2026-10-17T09:00:00.000Z");
    headers = await authorized(stub);
    expect(ids(await queue(stub, headers, 60))).toEqual([locatorOf(first)]);
    expect((await queue(stub, headers, 62)).data).toEqual([]);
  });

  it("accepts a credit card but keeps its brand and last 4 only, and refuses the declined test card [OBE-041 AC3]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const created = await createOrder(
      stub,
      headers,
      orderData({ formOfPayments: [CREDIT_CARD(ACCEPTED_CARD)] }),
      "?issue=true",
    );
    const masked = [
      { creditCard: { brand: "VISA", number: `${CARD_NUMBER_MASK}1111`, flightOfferIds: ["2"] } },
    ];
    expect(created.formOfPayments).toEqual(masked);
    expect(onlyOrder(stub).formOfPayments).toEqual(masked);

    const refused = await send(stub, "POST", `${ORDERS_PATH}?issue=true`, headers, {
      data: orderData({ formOfPayments: [{ other: { method: "CASH" } }, CREDIT_CARD(DECLINED_TEST_CARD)] }),
    });
    expect(refused.status).toBe(400);
    expect(await json<ErrorBody>(refused)).toEqual({
      errors: [
        {
          status: 400,
          code: 1304,
          title: "CREDIT CARD NOT ACCEPTED",
          detail: "The credit card was refused",
          source: { pointer: "/data/formOfPayments/1/creditCard/number" },
        },
      ],
    });
    expect(stub.orders.list()).toHaveLength(1);
  });

  it("answers 400 naming the body field or query parameter of an invalid order, unknown fields included [OBE-041 AC1]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const { flightOffers: _omitted, ...withoutOffers } = orderData();
    const missing = await send(stub, "POST", ORDERS_PATH, headers, { data: withoutOffers });
    expect(missing.status).toBe(400);
    expect((await json<ErrorBody>(missing)).errors).toEqual([
      expect.objectContaining({ code: 32171, source: { pointer: "/data/flightOffers" } }),
    ]);

    const unknown = await send(stub, "POST", ORDERS_PATH, headers, {
      data: orderData({ travelers: [{ ...traveler("1", "ALEX", "TESTER"), nickname: "AL" }] }),
    });
    expect(unknown.status).toBe(400);
    expect((await json<ErrorBody>(unknown)).errors).toEqual([
      expect.objectContaining({ code: 4926, source: { pointer: "/data/travelers/0/nickname" } }),
    ]);

    const badQuery = await send(stub, "POST", `${ORDERS_PATH}?issue=maybe`, headers, { data: orderData() });
    expect(badQuery.status).toBe(400);
    expect((await json<ErrorBody>(badQuery)).errors).toEqual([
      expect.objectContaining({ code: 477, source: { parameter: "issue" } }),
    ]);
    expect(stub.orders.list()).toEqual([]);
  });

  it("answers error 34651 for sold-out and stores nothing [OBE-041]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const res = await send(
      stub,
      "POST",
      ORDERS_PATH,
      { ...headers, ...scenario("sold-out") },
      { data: orderData() },
    );
    expect(res.status).toBe(400);
    expect(await json<ErrorBody>(res)).toEqual({
      errors: [
        { status: 400, code: 34651, title: "SEGMENT SELL FAILURE", detail: "Could not sell segment 3" },
      ],
    });
    expect(stub.orders.list()).toEqual([]);
  });

  it("stores the order without tickets and warns with 9112 for ticketing-failed and issue=true [OBE-041]", async () => {
    const stub = await startStub();
    const headers = { ...(await authorized(stub)), ...scenario("ticketing-failed") };
    const res = await send(stub, "POST", `${ORDERS_PATH}?issue=true`, headers, { data: orderData() });
    expect(res.status).toBe(201);
    const body = await json<OrderBody>(res);
    expect(body.warnings).toEqual([
      {
        status: 201,
        code: 9112,
        title: "TICKETING - TKT",
        detail: "Stub scenario ticketing-failed: the flight order was created but not issued",
      },
    ]);
    expect(body.data.tickets).toBeUndefined();
    expect(schemaProblems("createFlightOrders", 201, body)).toEqual([]);
    expect(onlyOrder(stub).tickets).toEqual([]);
    // Without issue=true there is nothing to fail.
    const plain = await send(stub, "POST", ORDERS_PATH, headers, { data: orderData() });
    expect((await json<OrderBody>(plain)).warnings).toBeUndefined();
  });
});

describe("Flight Order Issue", () => {
  it("adds e-tickets and answers like the fixture, then refuses to issue the order again [OBE-041 AC1]", async () => {
    const { clock } = testClock();
    const stub = await startStub({ clock });
    const headers = await authorized(stub);
    const created = await createOrder(stub, headers);
    const issuance = { data: { formOfPayments: [{ other: { method: "CASH", flightOfferIds: ["2"] } }] } };
    const res = await send(stub, "POST", orderPath(created.id, "/issuance"), headers, issuance);
    expect(res.status).toBe(200);
    const body = await json<OrderBody>(res);
    expect(withFixtureIds(body)).toEqual(fixtureBody("flight-order-issue"));
    expect(onlyOrder(stub)).toMatchObject({ version: 2, tickets: [{ documentNumber: "000-0000000001" }] });
    expect((await json<OrderBody>(await getOrder(stub, headers, created.id))).data.tickets).toEqual(
      body.data.tickets,
    );

    const again = await send(stub, "POST", orderPath(created.id, "/issuance"), headers, issuance);
    expect(again.status).toBe(400);
    expect((await json<ErrorBody>(again)).errors).toEqual([
      expect.objectContaining({ code: 9112, detail: "The flight order is already issued" }),
    ]);
    expect(onlyOrder(stub).tickets).toHaveLength(1);
  });

  it("answers 9112 and issues nothing for ticketing-failed, then issues once the scenario is gone [OBE-041]", async () => {
    const stub = await startStub({ defaultScenario: "ticketing-failed" });
    const headers = await authorized(stub);
    const created = await createOrder(stub, headers);
    const issuance = { data: { formOfPayments: [{ other: { method: "CASH" } }] } };
    const failed = await send(stub, "POST", orderPath(created.id, "/issuance"), headers, issuance);
    expect(failed.status).toBe(400);
    expect(await json<ErrorBody>(failed)).toEqual({
      errors: [
        {
          status: 400,
          code: 9112,
          title: "TICKETING - TKT",
          detail: "Stub scenario ticketing-failed: the flight order was not issued",
        },
      ],
    });
    expect(onlyOrder(stub)).toMatchObject({ version: 1, tickets: [] });
    const retried = await send(
      stub,
      "POST",
      orderPath(created.id, "/issuance"),
      { ...headers, ...scenario("success") },
      issuance,
    );
    expect(retried.status).toBe(200);
    expect(onlyOrder(stub).tickets).toHaveLength(1);
  });

  it("answers 404 for an unknown order and 1304 for the declined test card [OBE-041]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const unknown = await send(stub, "POST", orderPath("eJzTd9f3NjIxMwYADRkCqQ", "/issuance"), headers, {
      data: { formOfPayments: [{ other: { method: "CASH" } }] },
    });
    expect(unknown.status).toBe(404);
    expect(await json<ErrorBody>(unknown)).toEqual({
      errors: [{ status: 404, code: 1797, title: "NOT FOUND", detail: "No flight order with this id" }],
    });
    const created = await createOrder(stub, headers);
    const declined = await send(stub, "POST", orderPath(created.id, "/issuance"), headers, {
      data: { formOfPayments: [CREDIT_CARD(DECLINED_TEST_CARD)] },
    });
    expect(declined.status).toBe(400);
    expect((await json<ErrorBody>(declined)).errors).toEqual([
      expect.objectContaining({
        code: 1304,
        source: { pointer: "/data/formOfPayments/0/creditCard/number" },
      }),
    ]);
    expect(onlyOrder(stub).tickets).toEqual([]);
  });
});

describe("Flight Order Management", () => {
  it("replaces contacts and remarks with PATCH, and answers 409 without a change for version-conflict [OBE-041]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const created = await createOrder(stub, headers);
    const contacts = [
      {
        addresseeName: { firstName: "CASEY", lastName: "EXAMPLE" },
        purpose: "STANDARD",
        emailAddress: "person3@example.com",
        phones: [{ deviceType: "MOBILE", countryCallingCode: "44", number: "7700900456" }],
      },
    ];
    // The specification makes `type` and `flightOffers` mandatory in a PATCH: the client sends the order's offers.
    const patch = { data: { type: "flight-order", flightOffers: created["flightOffers"], contacts } };

    const conflict = await send(
      stub,
      "PATCH",
      orderPath(created.id),
      { ...headers, ...scenario("version-conflict") },
      patch,
    );
    expect(conflict.status).toBe(409);
    expect(await json<ErrorBody>(conflict)).toEqual({
      errors: [
        {
          status: 409,
          code: 2552,
          title: "SIMULTANEOUS UPDATE",
          detail: "Stub scenario version-conflict: the flight order was updated meanwhile",
        },
      ],
    });
    expect(onlyOrder(stub)).toMatchObject({ version: 1, contacts: created.contacts });

    const patched = await send(stub, "PATCH", orderPath(created.id), headers, patch);
    expect(patched.status).toBe(200);
    const body = await json<OrderBody>(patched);
    expect(body.data).toEqual({ ...created, contacts });
    expect(schemaProblems("patchFlightOrder", 200, body)).toEqual([]);
    expect(onlyOrder(stub)).toMatchObject({ version: 2, contacts });

    const remarks = { general: [{ subType: "GENERAL_MISCELLANEOUS", text: "VELEXIS VX7K2M9Q CHANGED" }] };
    const withRemarks = await send(stub, "PATCH", orderPath(created.id), headers, {
      data: { type: "flight-order", flightOffers: created["flightOffers"], remarks },
    });
    expect((await json<OrderBody>(withRemarks)).data).toEqual({ ...created, contacts, remarks });
    expect((await json<OrderBody>(await getOrder(stub, headers, created.id))).data).toEqual({
      ...created,
      contacts,
      remarks,
    });
    // `include` and `fareRules` are accepted.
    const included = await send(
      stub,
      "GET",
      `${orderPath(created.id)}?include=bags&fareRules=refunds`,
      headers,
    );
    expect(included.status).toBe(200);
  });

  it("cancels the order with DELETE: 204 without a body, then the order is gone everywhere [OBE-041]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const created = await createOrder(stub, headers);
    const deleted = await send(stub, "DELETE", orderPath(created.id), headers);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(onlyOrder(stub)).toMatchObject({ status: "cancelled", version: 2 });

    expect((await getOrder(stub, headers, created.id)).status).toBe(404);
    const reference = await byReference(stub, headers, locatorOf(created));
    expect(reference.status).toBe(404);
    expect((await json<ErrorBody>(reference)).errors).toEqual([
      expect.objectContaining({ code: 1797, detail: "No flight order with this record locator" }),
    ]);
    expect((await queue(stub, headers, 50)).data).toEqual([]);
    expect((await send(stub, "DELETE", orderPath(created.id), headers)).status).toBe(404);
    const patch = { data: { type: "flight-order", flightOffers: created["flightOffers"] } };
    expect((await send(stub, "PATCH", orderPath(created.id), headers, patch)).status).toBe(404);
    const issuance = { data: { formOfPayments: [{ other: { method: "CASH" } }] } };
    expect((await send(stub, "POST", orderPath(created.id, "/issuance"), headers, issuance)).status).toBe(
      404,
    );
  });

  it("answers 400 for another origin system at the by-reference GET [OBE-041]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const created = await createOrder(stub, headers);
    const res = await send(
      stub,
      "GET",
      `${BY_REFERENCE_PATH}?reference=${locatorOf(created)}&originSystemCode=1A`,
      headers,
    );
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).errors).toEqual([
      expect.objectContaining({ code: 4926, source: { parameter: "originSystemCode" } }),
    ]);
    expect((await byReference(stub, headers, "ZZZZZZ")).status).toBe(404);
  });
});

describe("timeouts at the order writes", () => {
  it("stores the order on timeout before the 504, so reconciliation finds it [OBE-041 AC2]", async () => {
    const { timers, pending } = manualTimers();
    const stub = await startStub({ timers });
    const headers = await authorized(stub);
    const held = send(
      stub,
      "POST",
      ORDERS_PATH,
      { ...headers, ...scenario("timeout") },
      { data: orderData() },
    );
    await vi.waitFor(() => expect(pending.size).toBe(1));
    // While the answer is held, the order already exists for the reconciler's reads.
    const order = onlyOrder(stub);
    const listed = await queue(stub, headers, 50);
    expect(listed.data.map((entry) => entry.id)).toEqual([
      `${order.recordLocator}-${order.createdAt.toISOString().slice(0, 10)}`,
    ]);
    expect((await byReference(stub, headers, order.recordLocator)).status).toBe(200);
    expect((await getOrder(stub, headers, order.id)).status).toBe(200);

    await fireHeld(pending);
    const res = await held;
    expect(res.status).toBe(504);
    expect((await json<ErrorBody>(res)).errors).toEqual([
      expect.objectContaining({ status: 504, code: 141 }),
    ]);
    expect(stub.requests().find((r) => r.operation === "createFlightOrders")).toMatchObject({
      scenario: "timeout",
      status: 504,
    });
  });

  it("stores nothing on timeout-lost, and answers the other routes as for success [OBE-041 AC2]", async () => {
    const { timers, pending } = manualTimers();
    const stub = await startStub({ timers, defaultScenario: "timeout-lost" });
    // The token endpoint and the reads answer as usual under timeout-lost …
    const headers = await authorized(stub);
    const held = send(stub, "POST", ORDERS_PATH, headers, { data: orderData() });
    await vi.waitFor(() => expect(pending.size).toBe(1));
    expect(stub.orders.list()).toEqual([]);
    expect(await queue(stub, headers, 50)).toEqual({ meta: { count: 0 }, data: [] });
    await fireHeld(pending);
    expect((await held).status).toBe(504);
    expect(stub.orders.list()).toEqual([]);
    expect(TIMEOUT_HOLD_MS).toBe(30_000);
  });

  it("applies the write before the 504 for timeout, and never for timeout-lost, at issue, PATCH and DELETE [OBE-041 AC2]", async () => {
    const { timers, pending } = manualTimers();
    const stub = await startStub({ timers });
    const headers = await authorized(stub);
    const issuance = { data: { formOfPayments: [{ other: { method: "CASH" } }] } };
    const timedOut = async (request: Promise<Response>): Promise<void> => {
      await fireHeld(pending);
      expect((await request).status).toBe(504);
    };

    const lost = await createOrder(stub, headers);
    await timedOut(
      send(
        stub,
        "POST",
        orderPath(lost.id, "/issuance"),
        { ...headers, ...scenario("timeout-lost") },
        issuance,
      ),
    );
    const contacts = [{ purpose: "STANDARD", emailAddress: "person9@example.com" }];
    const patch = { data: { type: "flight-order", flightOffers: lost["flightOffers"], contacts } };
    await timedOut(
      send(stub, "PATCH", orderPath(lost.id), { ...headers, ...scenario("timeout-lost") }, patch),
    );
    await timedOut(send(stub, "DELETE", orderPath(lost.id), { ...headers, ...scenario("timeout-lost") }));
    expect(stub.orders.list()[0]).toMatchObject({
      status: "active",
      version: 1,
      tickets: [],
      contacts: lost.contacts,
    });

    const applied = await createOrder(stub, headers);
    const find = (): StoredOrder | undefined => stub.orders.list().find((order) => order.id === applied.id);
    await timedOut(
      send(
        stub,
        "POST",
        orderPath(applied.id, "/issuance"),
        { ...headers, ...scenario("timeout") },
        issuance,
      ),
    );
    expect(find()?.tickets).toHaveLength(1);
    await timedOut(send(stub, "PATCH", orderPath(applied.id), { ...headers, ...scenario("timeout") }, patch));
    expect(find()?.contacts).toEqual(contacts);
    await timedOut(send(stub, "DELETE", orderPath(applied.id), { ...headers, ...scenario("timeout") }));
    expect(find()).toMatchObject({ status: "cancelled", version: 4 });
  });

  it("holds the order reads like any route for timeout, and answers server-error and rate-limited before any write [OBE-041]", async () => {
    const { timers, pending } = manualTimers();
    const stub = await startStub({ timers });
    const headers = await authorized(stub);
    const created = await createOrder(stub, headers);
    const reads: Array<() => Promise<Response>> = [
      () => getOrder(stub, { ...headers, ...scenario("timeout") }, created.id),
      () => byReference(stub, { ...headers, ...scenario("timeout") }, locatorOf(created)),
      () => send(stub, "GET", `${QUEUES_PATH}/50`, { ...headers, ...scenario("timeout") }),
    ];
    for (const read of reads) {
      const held = read();
      await fireHeld(pending);
      expect((await held).status).toBe(504);
    }
    for (const [name, status] of [
      ["server-error", 500],
      ["rate-limited", 429],
    ] as const) {
      const res = await send(
        stub,
        "POST",
        `${ORDERS_PATH}?issue=true`,
        { ...headers, ...scenario(name) },
        { data: orderData() },
      );
      expect(res.status).toBe(status);
      const deleted = await send(stub, "DELETE", orderPath(created.id), { ...headers, ...scenario(name) });
      expect(deleted.status).toBe(status);
    }
    expect(onlyOrder(stub)).toMatchObject({ status: "active", version: 1 });
  });
});

describe("the request log and card numbers", () => {
  it("never records a full card number, whether it comes in a body, the path, the query or a header [OBE-041 AC3]", async () => {
    const logged: RecordedRequest[] = [];
    const stub = await startStub({ onResponse: (request) => logged.push(request) });
    const headers = await authorized(stub);
    const answers: string[] = [];
    const keep = async (res: Response): Promise<number> => {
      answers.push(await res.text());
      return res.status;
    };

    const card = { ...CREDIT_CARD(ACCEPTED_CARD) };
    expect(
      await keep(
        await send(stub, "POST", `${ORDERS_PATH}?issue=true`, headers, {
          data: orderData({ formOfPayments: [card] }),
        }),
      ),
    ).toBe(201);
    expect(
      await keep(
        await send(stub, "POST", ORDERS_PATH, headers, {
          data: orderData({ formOfPayments: [CREDIT_CARD(DECLINED_TEST_CARD)] }),
        }),
      ),
    ).toBe(400);
    const [order] = stub.orders.list();
    expect(await keep(await getOrder(stub, headers, order?.id ?? ""))).toBe(200);
    expect(await keep(await byReference(stub, headers, order?.recordLocator ?? ""))).toBe(200);
    expect(await keep(await send(stub, "GET", `${QUEUES_PATH}/50`, headers))).toBe(200);
    // A card number where none belongs: in the path (plain, and written with spaces, which the path keeps
    // percent-encoded), in a query parameter, in a header.
    expect(await keep(await getOrder(stub, headers, SPACED_CARD))).toBe(404);
    expect(stub.requests().at(-1)?.path).toBe(`${ORDERS_PATH}/${CARD_NUMBER_MASK}1111`);
    expect(await keep(await getOrder(stub, headers, ACCEPTED_CARD))).toBe(404);
    expect(
      await keep(
        await send(stub, "GET", `${BY_REFERENCE_PATH}?reference=${ACCEPTED_CARD}&originSystemCode=GDS`, {
          ...headers,
          "x-note": "card 4111 1111 1111 1111",
        }),
      ),
    ).toBe(404);
    await vi.waitFor(() => expect(logged).toHaveLength(stub.requests().length));

    const everything = JSON.stringify([stub.requests(), logged, stub.orders.list(), answers]);
    for (const secret of [
      ACCEPTED_CARD,
      ACCEPTED_CARD.slice(-12),
      encodeURIComponent(SPACED_CARD),
      DECLINED_TEST_CARD,
      DECLINED_TEST_CARD.slice(-12),
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain("securityCode");
    expect(everything).not.toContain("2099-12");
    expect(stub.requests().at(-2)?.path).toBe(`${ORDERS_PATH}/${CARD_NUMBER_MASK}1111`);
    expect(stub.requests().at(-1)).toMatchObject({
      query: { reference: `${CARD_NUMBER_MASK}1111`, originSystemCode: "GDS" },
      headers: { "x-note": "card XXXXXXXXXXXX1111" },
    });
  });

  it("masks runs of 13 to 19 digits to their last 4 and leaves everything else alone [OBE-041 AC3]", () => {
    expect(maskCardNumbers("4111111111111111")).toBe("XXXXXXXXXXXX1111");
    expect(maskCardNumbers("pay 4111-1111-1111-1111 now")).toBe("pay XXXXXXXXXXXX1111 now");
    // A path keeps a space percent-encoded.
    expect(maskCardNumbers(`${ORDERS_PATH}/4111%201111%201111%201111`)).toBe(
      `${ORDERS_PATH}/XXXXXXXXXXXX1111`,
    );
    expect(maskCardNumbers("/v1/x/2027%2001%2015")).toBe("/v1/x/2027%2001%2015");
    expect(maskCardNumbers("378282246310005")).toBe("XXXXXXXXXXX0005");
    expect(maskCardNumbers("2027-01-15T07:15:00 queue 50 PNR SYN001 +44 7700 900123")).toBe(
      "2027-01-15T07:15:00 queue 50 PNR SYN001 +44 7700 900123",
    );
    expect(maskCardNumbers("123456789012")).toBe("123456789012");
    expect(maskCardNumbers("12345678901234567890")).toBe("12345678901234567890");
  });
});

describe("the order operations in the route table", () => {
  it("names each order operation's handler, its writes and its checked bodies [OBE-041 AC1]", () => {
    const orders: Array<[OperationName, boolean, boolean]> = [
      ["createFlightOrders", true, true],
      ["issueFlightOrder", true, true],
      ["getFlightOrder", false, false],
      ["patchFlightOrder", true, true],
      ["cancelFlightOrder", true, false],
      ["getFlightOrderByReference", false, false],
      ["listQueue", false, false],
    ];
    for (const [name, writesOrder, checksBody] of orders) {
      const op = operationNamed(name);
      expect(op.handler, name).toBeTypeOf("function");
      expect(op).toMatchObject({ plannedBy: "OBE-041", writesOrder });
      expect(op.spec.unknownBodyFields !== undefined, name).toBe(checksBody);
    }
    expect(STUB_OPERATIONS.filter((op) => op.writesOrder).map((op) => op.name)).toEqual([
      "createFlightOrders",
      "issueFlightOrder",
      "patchFlightOrder",
      "cancelFlightOrder",
    ]);
    expect(STUB_SCENARIOS).toEqual(
      expect.arrayContaining(["ticketing-failed", "version-conflict", "timeout-lost"]),
    );
  });

  it("serves fixtures that match the response schemas and describe one order before and after issue [OBE-041 AC1]", () => {
    const created = fixtureBody<OrderBody>("flight-create-orders");
    const issued = fixtureBody<OrderBody>("flight-order-issue");
    expect(loadFixture("flight-create-orders", "success").status).toBe(201);
    expect(loadFixture("flight-order-issue", "success").status).toBe(200);
    expect(schemaProblems("createFlightOrders", 201, created)).toEqual([]);
    expect(schemaProblems("issueFlightOrder", 200, issued)).toEqual([]);
    expect(schemaProblems("getFlightOrder", 200, created)).toEqual([]);
    expect(schemaProblems("getFlightOrderByReference", 200, { ...created, data: [created.data] })).toEqual(
      [],
    );
    const { tickets, ...issuedOrder } = issued.data;
    expect(issuedOrder).toEqual(created.data);
    expect(tickets).toEqual([
      expect.objectContaining({ documentNumber: "000-0000000001", travelerId: "1", segmentIds: ["3"] }),
    ]);
    expect(created.data.id).toBe(FIXTURE_ORDER_ID);
    // The booked offer is priced offer 2.
    expect(created.data["flightOffers"]).toEqual([pricedOffer()]);
  });

  it("checks each operation at start but compiles its body validator on first use [OBE-041]", () => {
    // A scratch Swagger 2.0 document: one body schema Ajv cannot compile (an invalid pattern), one body without schema.
    const dir = mkdtempSync(join(tmpdir(), "amadeus-stub-check-"));
    try {
      const bodyOperation = (schema: Json | undefined): Json => ({
        operationId: "postThings",
        parameters: [
          { name: "body", in: "body", required: true, ...(schema === undefined ? {} : { schema }) },
        ],
        responses: { "200": { description: "ok" } },
      });
      writeFileSync(
        join(dir, "Things.json"),
        JSON.stringify({
          swagger: "2.0",
          basePath: "/v1",
          paths: {
            "/things": {
              post: bodyOperation({ type: "object", properties: { code: { type: "string", pattern: "(" } } }),
            },
            "/broken": { post: bodyOperation(undefined) },
          },
        }),
      );
      const things = { specFile: "Things.json", specPath: "/things", method: "POST" } as const;
      const specs = new AmadeusSpecs(dir);
      // At start: the operation and its body schema exist, nothing is compiled that could fail …
      expect(() => specs.check(things)).not.toThrow();
      // … a missing operation or body schema fails there …
      expect(() => specs.check({ ...things, specPath: "/nowhere" })).toThrow(
        /has no operation POST \/nowhere/,
      );
      expect(() => specs.check({ ...things, specPath: "/broken" })).toThrow(/has no body schema/);
      // … and the body validator is compiled by the first request (or by prepare()).
      const request = {
        query: new URLSearchParams(),
        headers: { "content-type": "application/json" },
        pathParams: {},
        body: JSON.stringify({ code: "A" }),
      };
      expect(() => specs.validateRequest(things, request)).toThrow();
      expect(() => new AmadeusSpecs(dir).prepare(things)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps each server's orders apart and forgets them on reset() [OBE-041]", async () => {
    const one = await startStub();
    const other = await startStub();
    const created = await createOrder(one, await authorized(one));
    const otherHeaders = await authorized(other);
    expect((await getOrder(other, otherHeaders, created.id)).status).toBe(404);
    expect(other.orders.list()).toEqual([]);
    const listed = one.orders.list();
    expect(listed).toHaveLength(1);
    // A copy: changing it changes nothing in the store.
    (listed[0]?.travelers as Json[]).length = 0;
    expect(one.orders.list()[0]?.travelers).toHaveLength(1);
    one.orders.reset();
    expect(one.orders.list()).toEqual([]);
    expect((await getOrder(one, await authorized(one), created.id)).status).toBe(404);
  });
});
