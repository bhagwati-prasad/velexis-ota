// @velexis/testing/amadeus (X-027; ADR-0022 item 5, ADR-0015 "Amadeus stub server"): starts the Amadeus stub of
// tools/amadeus-stub in-process, on a free port of 127.0.0.1, and builds the header that picks a stub scenario for one
// request.
//
//   const stub = await startAmadeusStub();                          // http://127.0.0.1:<free port>, in beforeAll
//   app = await startApi({ env: { AMADEUS_BASE_URL_TEST: stub.url } });
//   await request(app.server).post("/v1/flight-searches").set(stubScenario("server-error")).send(simpleSearch);
//   expect(stub.requests().at(-1)).toMatchObject({ operation: "getFlightOffers", status: 500 });
//   stub.orders.changeSegment(orderId, "3", { departureAt: "2027-01-15T08:45:00" });   // the airline's change
//   await stub.stop();                                               // in afterAll: frees the port
//
// The stub itself (OAuth, routes, scenarios, request validation, fixtures) stays in tools/amadeus-stub
// (@velexis/amadeus-stub, tools/amadeus-stub/README.md). It is a devDependency of this package, never a runtime one
// (ADR-0022 item 2): this module only wraps `createStubServer`, and re-exports the names a test needs, so a package
// that uses @velexis/testing/amadeus does not list the stub itself.
import {
  createStubServer,
  isStubScenario,
  NO_OFFERS_DESTINATION,
  OAUTH_TOKEN_PATH,
  SCENARIO_HEADER,
  STUB_SCENARIOS,
  TIMEOUT_HOLD_MS,
  TOKEN_EXPIRES_IN,
  TOKEN_OPERATION,
  type AirlineSegmentChange,
  type RecordedRequest,
  type StoredOrder,
  type StubClock,
  type StubCredentials,
  type StubOrders,
  type StubScenario,
  type StubTimers,
} from "@velexis/amadeus-stub";

export {
  NO_OFFERS_DESTINATION,
  OAUTH_TOKEN_PATH,
  SCENARIO_HEADER,
  STUB_SCENARIOS,
  TIMEOUT_HOLD_MS,
  TOKEN_EXPIRES_IN,
  TOKEN_OPERATION,
  type AirlineSegmentChange,
  type StoredOrder,
  type StubClock,
  type StubCredentials,
  type StubOrders,
  type StubScenario,
  type StubTimers,
};

/**
 * One request as the stub saw it, oldest first in `requests()`: `method`, `path` (without the query string), `query`,
 * `headers` (lower-case names; `authorization`, `proxy-authorization` and `cookie` are `[REDACTED]`), `operation`
 * (`oauth2Token`, the operation's name, or `undefined` for a 404), `scenario`, `status`, `receivedAt` and
 * `durationMs`. Bodies are never recorded, so a client secret or a token never lands in it.
 */
export type AmadeusStubRequest = RecordedRequest;

export interface StartAmadeusStubOptions {
  /** TCP port on 127.0.0.1; default `0`, a free one (read it from `url` or `port`). */
  readonly port?: number | undefined;
  /** Scenario of requests without `X-Stub-Scenario`; default `success`. `setDefaultScenario()` changes it later. */
  readonly defaultScenario?: StubScenario | undefined;
  /** Accept only this client id and secret at the token endpoint; default any non-empty pair. */
  readonly credentials?: StubCredentials | undefined;
  /** Time source of token expiry and `receivedAt` (the package's `FakeClock` fits); default the system clock. */
  readonly clock?: StubClock | undefined;
  /** Timers of the `timeout` scenario's 30 s hold, so a test fires it itself; default the global timers. */
  readonly timers?: StubTimers | undefined;
}

/** A running stub. Call `stop()` when the test file ends (`afterAll`), or the port stays taken. */
export interface AmadeusStub {
  /** `http://127.0.0.1:<port>`: the value of `AMADEUS_BASE_URL_TEST` for the code under test. */
  readonly url: string;
  readonly port: number;
  /** The recorded requests, oldest first, at most the last 1000 (copies: later requests do not change them). */
  requests(): readonly AmadeusStubRequest[];
  /** Empties the request log, for a test that asserts on its own requests only. */
  clearRequests(): void;
  /**
   * The scenario of every request without `X-Stub-Scenario` from now on, token requests included; `success` goes
   * back to normal. A request with the header (`stubScenario("success")`) still picks its own.
   */
  setDefaultScenario(name: StubScenario): void;
  /**
   * The flight orders the stub stored (`list()`, `reset()`), and what the airline does to one, which every later read
   * of the order answers: `changeSegment(id, segmentId, { departureAt?, arrivalAt?, bookingStatus? })` (a schedule
   * change) and `cancelByAirline(id)` (every segment `CANCELLED`, the order still readable). The stub's README, Orders.
   */
  readonly orders: StubOrders;
  /**
   * Stops listening, drops the responses the `timeout` scenario holds and every open connection, and resolves when
   * the port is free again. Idempotent: a second call returns the same promise.
   */
  stop(): Promise<void>;
}

/**
 * Starts the Amadeus stub in this process on `127.0.0.1:<port>` (a free port by default) and resolves when it listens.
 * The specifications of the implemented operations and their fixtures are loaded first (once per process), so a broken
 * one fails here, not on the first request. Every stub has its own tokens, request log and default scenario.
 */
export async function startAmadeusStub({
  port = 0,
  defaultScenario,
  credentials,
  clock,
  timers,
}: StartAmadeusStubOptions = {}): Promise<AmadeusStub> {
  // The options are picked one by one, so the stub always binds the loopback interface (the stub's default host).
  const server = await createStubServer({ port, defaultScenario, credentials, clock, timers });
  return Object.freeze({
    url: server.url,
    port: server.port,
    requests: () => server.requests(),
    clearRequests: () => server.clearRequests(),
    setDefaultScenario: (name: StubScenario) => server.setDefaultScenario(name),
    orders: server.orders,
    stop: () => server.close(),
  });
}

/** The header that `stubScenario(name)` returns: `{ "X-Stub-Scenario": name }`. */
export type StubScenarioHeader<S extends StubScenario = StubScenario> = Readonly<
  Record<typeof SCENARIO_HEADER, S>
>;

/**
 * `{ "X-Stub-Scenario": name }`, the header that makes the stub answer one request with the scenario `name`
 * (`fetch(url, { headers: { ...auth, ...stubScenario("server-error") } })`, Supertest's `.set(stubScenario(…))`).
 * The names are the stub's `StubScenario`s, so a misspelt one does not compile; at run time an unknown name (from
 * JavaScript, or a cast) throws a `TypeError` here instead of reaching the stub as a 400.
 */
export function stubScenario<S extends StubScenario>(name: S): StubScenarioHeader<S> {
  if (typeof name !== "string" || !isStubScenario(name)) {
    throw new TypeError(`Unknown Amadeus stub scenario; use one of: ${STUB_SCENARIOS.join(", ")}`);
  }
  return { [SCENARIO_HEADER]: name };
}
