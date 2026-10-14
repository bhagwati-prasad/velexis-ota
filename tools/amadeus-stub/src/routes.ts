// The route table of the Amadeus stub (X-026): the OAuth token endpoint and the 12 operations of the 9 specifications
// in docs/amadeus-api that the OTA backend calls (ADR-0012, the `x-amadeus` entries of the OTA OpenAPI document).
//
// X-026 implements Flight Offers Search (GET and POST /v2/shopping/flight-offers) from the synthetic fixture
// fixtures/flight-offers-search/success.json. Every other operation has no handler yet and answers 501 "not stubbed
// yet"; `plannedBy` names the OTA task that adds it. A handler gets the request after authentication, validation
// against the specification and the generic scenarios (server.ts), so it only decides what to answer.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OAUTH_TOKEN_PATH } from "./oauth";
import { findsNoOffers, type StubResponse, type StubScenario } from "./scenarios";
import type { OperationSpec } from "./validate";

/** The 9 Amadeus APIs, by the name the OTA OpenAPI document's `x-amadeus` uses. */
export type AmadeusApi =
  | "FlightOffersSearch"
  | "FlightAvailabilitiesSearch"
  | "BrandedFaresUpsell"
  | "FlightOffersPrice"
  | "FlightCreateOrders"
  | "FlightOrderIssue"
  | "FlightOrderManagement"
  | "GetFlightOrderByRecordLocator"
  | "QueueList";

/** The specification file of each API in docs/amadeus-api. */
export const AMADEUS_SPEC_FILES: Readonly<Record<AmadeusApi, string>> = Object.freeze({
  FlightOffersSearch: "FlightOffersSearch_v2_Version_1.0_swagger_specification.json",
  FlightAvailabilitiesSearch: "FlightAvailabilitiesSearch_v1_Version_1.0_swagger_specification.json",
  BrandedFaresUpsell: "BrandedFaresUpsell_v1_Version_1.4_swagger_specification.json",
  FlightOffersPrice: "FlightOffersPrice_v1_Version_1.15_swagger_specification.json",
  FlightCreateOrders: "FlightCreateOrders_v1_Version_1.16_swagger_specification.json",
  FlightOrderIssue: "FlightOrderIssue_v1_Version_1.8_swagger_specification.json",
  FlightOrderManagement: "FlightOrderManagement_v1_Version_1.15_swagger_specification.json",
  GetFlightOrderByRecordLocator: "GetFlightOrderByRecordLocator_v1_Version_1.10_swagger_specification.json",
  QueueList: "QueueList_v1_Version_1.0_swagger_specification.json",
});

/**
 * The stub's name of each operation: the `AmadeusClient` method names of the OTA plan (OBE-018). The specifications'
 * own `operationId`s are not unique (two `getFlightOrder`) and one is a path (`GET/office/queues/{queue-id}`).
 */
export type OperationName =
  | "getFlightOffers"
  | "searchFlightOffers"
  | "searchFlightAvailabilities"
  | "upsellAirOffers"
  | "quoteAirOffers"
  | "createFlightOrders"
  | "issueFlightOrder"
  | "getFlightOrder"
  | "patchFlightOrder"
  | "cancelFlightOrder"
  | "getFlightOrderByReference"
  | "listQueue";

/** What a handler gets: the validated request and the scenario (`success` or one the handler knows). */
export interface HandlerContext {
  readonly operation: StubOperation;
  /** Query parameters, coerced to their declared types. */
  readonly query: Readonly<Record<string, unknown>>;
  /** The parsed JSON body (`undefined` for none). */
  readonly body: unknown;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly scenario: StubScenario;
}

export type OperationHandler = (context: HandlerContext) => StubResponse;

export interface StubOperation {
  readonly name: OperationName;
  readonly api: AmadeusApi;
  /** The `operationId` in the specification. */
  readonly operationId: string;
  readonly method: OperationSpec["method"];
  /** The full path served by the stub (base path of the specification included), with `{param}` templates. */
  readonly path: string;
  readonly spec: OperationSpec;
  /** The handler, or `undefined` while the operation is not stubbed (501). */
  readonly handler: OperationHandler | undefined;
  /** The task that stubs the operation. */
  readonly plannedBy: string;
}

// ---- Fixtures --------------------------------------------------------------------------------------------------

/** tools/amadeus-stub/fixtures (this file is `src/*.ts` or `dist/*.js`). */
export const FIXTURE_DIR = resolve(__dirname, "..", "fixtures");

/** The header every fixture file carries (fixtures/README.md). */
export interface FixtureHeader {
  /** The fixture folder: the API in kebab case (`flight-offers-search`). */
  readonly operation: string;
  /** The file name without `.json` (`success`). */
  readonly scenario: string;
  /** `synthetic` (written by hand) or `recorded` (captured from the Amadeus test environment, then scrubbed). */
  readonly source: "synthetic" | "recorded";
  /** The day it was written or recorded (`YYYY-MM-DD`). */
  readonly date: string;
  /** Always `true`: no personal data (names, documents, e-mail addresses, phone numbers, record locators). */
  readonly scrubbed: true;
  readonly description?: string;
}

export interface Fixture {
  readonly fixture: FixtureHeader;
  /** The HTTP status the stub answers with. */
  readonly status: number;
  /** The Amadeus response body. */
  readonly body: unknown;
}

const fixtureCache = new Map<string, Fixture>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads `fixtures/<operation>/<scenario>.json` once, checks its header and returns a deep copy, so a caller may change
 * what it got. A file without a valid header, or not marked `scrubbed: true`, throws.
 */
export function loadFixture(operation: string, scenario: string, dir: string = FIXTURE_DIR): Fixture {
  const file = join(dir, operation, `${scenario}.json`);
  let fixture = fixtureCache.get(file);
  if (fixture === undefined) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const header = isRecord(raw) ? raw["fixture"] : undefined;
    const valid =
      isRecord(raw) &&
      isRecord(header) &&
      header["operation"] === operation &&
      header["scenario"] === scenario &&
      (header["source"] === "synthetic" || header["source"] === "recorded") &&
      typeof header["date"] === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(header["date"]) &&
      header["scrubbed"] === true &&
      Number.isInteger(raw["status"]) &&
      "body" in raw;
    if (!valid) {
      throw new Error(
        `${file}: not a stub fixture (needs "fixture": { operation: "${operation}", scenario: "${scenario}", ` +
          `source, date, scrubbed: true }, "status" and "body"; see fixtures/README.md)`,
      );
    }
    fixture = raw as unknown as Fixture;
    fixtureCache.set(file, fixture);
  }
  return structuredClone(fixture);
}

// ---- Flight Offers Search --------------------------------------------------------------------------------------

/** The fixture folder of Flight Offers Search. */
export const FLIGHT_OFFERS_SEARCH_FIXTURES = "flight-offers-search";

/** The fixtures the implemented operations serve: read and checked when a server starts, so a broken one fails fast. */
export const STUB_FIXTURES: readonly (readonly [operation: string, scenario: string])[] = Object.freeze([
  [FLIGHT_OFFERS_SEARCH_FIXTURES, "success"],
] as const);

function destinationsOf(context: HandlerContext): unknown[] {
  if (context.operation.method === "GET") {
    return [context.query["destinationLocationCode"]];
  }
  const originDestinations = isRecord(context.body) ? context.body["originDestinations"] : undefined;
  return Array.isArray(originDestinations)
    ? originDestinations.map((entry: unknown) =>
        isRecord(entry) ? entry["destinationLocationCode"] : undefined,
      )
    : [];
}

function maxOffersOf(context: HandlerContext): unknown {
  if (context.operation.method === "GET") {
    return context.query["max"];
  }
  const criteria = isRecord(context.body) ? context.body["searchCriteria"] : undefined;
  return isRecord(criteria) ? criteria["maxFlightOffers"] : undefined;
}

/**
 * GET `getFlightOffers` and POST `searchFlightOffers`: the offers of the success fixture whatever the itinerary, at
 * most `max` (GET) or `searchCriteria.maxFlightOffers` (POST) of them; none for the destination `ZZZ`.
 */
export function searchFlightOffersHandler(context: HandlerContext): StubResponse {
  if (findsNoOffers(destinationsOf(context))) {
    return { status: 200, body: { meta: { count: 0 }, data: [] } };
  }
  const { status, body } = loadFixture(FLIGHT_OFFERS_SEARCH_FIXTURES, "success");
  const max = maxOffersOf(context);
  if (typeof max === "number" && max >= 1 && isRecord(body) && Array.isArray(body["data"])) {
    const data = body["data"].slice(0, Math.floor(max));
    const meta = isRecord(body["meta"]) ? body["meta"] : {};
    return { status, body: { ...body, meta: { ...meta, count: data.length }, data } };
  }
  return { status, body };
}

// ---- The route table -------------------------------------------------------------------------------------------

function operation(
  name: OperationName,
  api: AmadeusApi,
  operationId: string,
  method: OperationSpec["method"],
  basePath: string,
  specPath: string,
  plannedBy: string,
  handler?: OperationHandler,
): StubOperation {
  // Queue List (OpenAPI 3.0) writes its path key with the method in front: `GET/office/queues/{queue-id}`.
  const path = basePath + specPath.replace(/^[A-Z]+(?=\/)/, "");
  return Object.freeze({
    name,
    api,
    operationId,
    method,
    path,
    spec: Object.freeze({ specFile: AMADEUS_SPEC_FILES[api], specPath, method }),
    handler,
    plannedBy,
  });
}

/** The 12 Amadeus operations, in the order of ADR-0012 and the OTA plan. */
export const STUB_OPERATIONS: readonly StubOperation[] = Object.freeze([
  operation(
    "getFlightOffers",
    "FlightOffersSearch",
    "getFlightOffers",
    "GET",
    "/v2",
    "/shopping/flight-offers",
    "X-026",
    searchFlightOffersHandler,
  ),
  operation(
    "searchFlightOffers",
    "FlightOffersSearch",
    "searchFlightOffers",
    "POST",
    "/v2",
    "/shopping/flight-offers",
    "X-026",
    searchFlightOffersHandler,
  ),
  operation(
    "searchFlightAvailabilities",
    "FlightAvailabilitiesSearch",
    "searchFlightAvailabilities",
    "POST",
    "/v1",
    "/shopping/availability/flight-availabilities",
    "OBE-019",
  ),
  operation(
    "upsellAirOffers",
    "BrandedFaresUpsell",
    "upsellAirOffers",
    "POST",
    "/v1",
    "/shopping/flight-offers/upselling",
    "OBE-019",
  ),
  operation(
    "quoteAirOffers",
    "FlightOffersPrice",
    "quoteAirOffers",
    "POST",
    "/v1",
    "/shopping/flight-offers/pricing",
    "OBE-019",
  ),
  operation(
    "createFlightOrders",
    "FlightCreateOrders",
    "createFligtOrders",
    "POST",
    "/v1",
    "/booking/flight-orders",
    "OBE-041",
  ),
  operation(
    "issueFlightOrder",
    "FlightOrderIssue",
    "issueFlightOrder",
    "POST",
    "/v1",
    "/booking/flight-orders/{flight-orderId}/issuance",
    "OBE-041",
  ),
  operation(
    "getFlightOrder",
    "FlightOrderManagement",
    "getFlightOrder",
    "GET",
    "/v1",
    "/booking/flight-orders/{flight-orderId}",
    "OBE-041",
  ),
  operation(
    "patchFlightOrder",
    "FlightOrderManagement",
    "patchFlightOrder",
    "PATCH",
    "/v1",
    "/booking/flight-orders/{flight-orderId}",
    "OBE-041",
  ),
  operation(
    "cancelFlightOrder",
    "FlightOrderManagement",
    "cancelFlightOrder",
    "DELETE",
    "/v1",
    "/booking/flight-orders/{flight-orderId}",
    "OBE-041",
  ),
  operation(
    "getFlightOrderByReference",
    "GetFlightOrderByRecordLocator",
    "getFlightOrder",
    "GET",
    "/v1",
    "/booking/flight-orders/by-reference",
    "OBE-041",
  ),
  operation(
    "listQueue",
    "QueueList",
    "GET/office/queues/{queue-id}",
    "GET",
    "/v1",
    "GET/office/queues/{queue-id}",
    "OBE-041",
  ),
]);

/** What a method and path lead to. */
export type RouteMatch =
  | { readonly kind: "token" }
  | {
      readonly kind: "operation";
      readonly operation: StubOperation;
      readonly pathParams: Readonly<Record<string, string>>;
    };

interface CompiledRoute {
  readonly operation: StubOperation;
  readonly pattern: RegExp;
  readonly names: readonly string[];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Static paths first, so `/v1/booking/flight-orders/by-reference` is never read as a `{flight-orderId}`. */
const COMPILED_ROUTES: readonly CompiledRoute[] = STUB_OPERATIONS.map((op) => {
  const names: string[] = [];
  const source = op.path
    .split(/(\{[^}]+\})/)
    .map((part) => {
      const param = /^\{([^}]+)\}$/.exec(part);
      if (param?.[1] !== undefined) {
        names.push(param[1]);
        return "([^/]+)";
      }
      return escapeRegExp(part);
    })
    .join("");
  return { operation: op, pattern: new RegExp(`^${source}$`), names };
}).sort((a, b) => a.names.length - b.names.length);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The route of `method` and `pathname` (already without the query), or `undefined` for none (404). */
export function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  if (pathname === OAUTH_TOKEN_PATH) {
    return method === "POST" ? { kind: "token" } : undefined;
  }
  for (const route of COMPILED_ROUTES) {
    if (route.operation.method !== method) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (match !== null) {
      const pathParams = Object.fromEntries(
        route.names.map((name, i) => [name, decodeSegment(match[i + 1] ?? "")]),
      );
      return { kind: "operation", operation: route.operation, pathParams };
    }
  }
  return undefined;
}
