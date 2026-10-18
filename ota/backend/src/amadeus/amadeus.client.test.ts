// AmadeusClient against a fake `fetch` and fakes of its collaborators (OBE-018; OADR-0001 points 1, 3, 6–11, flows/
// amadeus-connection-and-tokens.md §4–§6): the 12 operations, the retry rules of reads and writes, the 401 path, the
// token request retry, the offices, the buckets, the rows and log lines, and X-Stub-Scenario. The client against
// PostgreSQL, Redis and the Amadeus stub is test/integration/amadeus/client.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import type { ClsService } from "nestjs-cls";
import type { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Clock } from "../common/clock";
import { IdGenerator, newId } from "../common/ids";
import type { ApiConfig } from "../config";
import { NoTenantContextError, type RequestTenant, type TenantContext } from "../tenancy/tenant-context";
import type { TenantTx } from "../tenancy/tenant-tx";
import {
  AmadeusClient,
  AmadeusOfficeNotAllowedError,
  AmadeusTenantMismatchError,
  requestPath,
  type AmadeusResponse,
} from "./amadeus.client";
import {
  checkCallContext,
  forwardedStubScenario,
  InvalidAmadeusCallContextError,
  type AmadeusCallContext,
} from "./call-context";
import type { ConnectionResolver, ResolvedAmadeusConnection } from "./connection-resolver";
import {
  AMADEUS_OPERATIONS,
  DEFAULT_AMADEUS_LIMITS,
  isRetryable,
  retryDelayMs,
  type AmadeusLimits,
  type AmadeusOperationName,
} from "./limits";
import type { AmadeusRateLimiter } from "./rate-limiter";
import type { SupplierRequestRecord, SupplierRequestsRepository } from "./supplier-requests.repository";
import { AmadeusTokenRequestError, type AmadeusFetch, type TokenProvider } from "./token-provider";

const BASE_URL = "http://127.0.0.1:4900";
const OFFICE = "NCE1A0955";
const SECOND_OFFICE = "NCE1A0956";
const FOREIGN_OFFICE = "PAR1A0911";
const TOKEN = "token-AAAA";
const NEW_TOKEN = "token-BBBB";

/** Short timeouts and no wait before a retry: the rules are the same, the tests are quick. */
const LIMITS: AmadeusLimits = {
  ...DEFAULT_AMADEUS_LIMITS,
  timeoutMs: Object.fromEntries(
    Object.keys(DEFAULT_AMADEUS_LIMITS.timeoutMs).map((name) => [name, 40]),
  ) as AmadeusLimits["timeoutMs"],
  retryDelayMs: { min: 0, max: 0 },
};

/** The log lines of the client, as `[level, fields, message]`. */
type LogLine = [string, Record<string, unknown>, string];

let tenantId: string;
let connection: ResolvedAmadeusConnection;
let tenant: RequestTenant | undefined;
let context: AmadeusCallContext;
let fetchMock: ReturnType<typeof vi.fn<AmadeusFetch>>;
let resolver: { resolve: ReturnType<typeof vi.fn> };
let tokens: { getToken: ReturnType<typeof vi.fn>; dropToken: ReturnType<typeof vi.fn> };
let limiter: { take: ReturnType<typeof vi.fn> };
let rows: SupplierRequestRecord[];
let insert: ReturnType<typeof vi.fn<(trx: unknown, record: SupplierRequestRecord) => Promise<void>>>;
let logs: LogLine[];
let request: { headers: Record<string, string> } | undefined;
let appEnv: string;

function client(limits: AmadeusLimits = LIMITS): AmadeusClient {
  const tx = { run: (fn: (trx: unknown) => Promise<unknown>) => fn({}) } as unknown as TenantTx;
  const tenants = { get: () => tenant } as unknown as TenantContext;
  const cls = {
    isActive: () => request !== undefined,
    get: () => request,
  } as unknown as ClsService;
  const logger = {
    setContext: () => undefined,
    info: (fields: Record<string, unknown>, message: string) => logs.push(["info", fields, message]),
    warn: (fields: Record<string, unknown>, message: string) => logs.push(["warn", fields, message]),
    error: (fields: Record<string, unknown>, message: string) => logs.push(["error", fields, message]),
  } as unknown as PinoLogger;
  const config = { get: () => appEnv } as unknown as ConfigService<ApiConfig, true>;
  return new AmadeusClient(
    resolver as unknown as ConnectionResolver,
    tokens as unknown as TokenProvider,
    limiter as unknown as AmadeusRateLimiter,
    { insert } as unknown as SupplierRequestsRepository,
    tx,
    tenants,
    new IdGenerator(new Clock()),
    cls,
    logger,
    fetchMock,
    config,
    limits,
  );
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/vnd.amadeus+json", ...headers },
  });

const amadeusError = (status: number, code: number, title = "SOME ERROR"): Response =>
  json({ errors: [{ status, code, title }] }, status);

/** A `fetch` that answers only when its signal aborts: the operation's timeout. */
const hang: AmadeusFetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

/** The AppError a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/** The method, URL and headers of each request `fetch` received. */
function sent(): Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> {
  return fetchMock.mock.calls.map(([input, init]) => ({
    method: init?.method ?? "GET",
    url: String(input),
    headers: { ...(init?.headers as Record<string, string>) },
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  }));
}

const ORDER_ID = "eJzTd9f3NjIJdgMADeQCtg";

/** One call of each operation, with a minimal request; the fake answers whatever. */
const CALLS: Readonly<Record<AmadeusOperationName, (c: AmadeusClient) => Promise<AmadeusResponse<unknown>>>> =
  {
    searchFlightOffers: (c) =>
      c.searchFlightOffers(context, {
        body: { originDestinations: [], travelers: [], sources: ["GDS"] },
      }),
    getFlightOffers: (c) =>
      c.getFlightOffers(context, {
        query: {
          originLocationCode: "MAD",
          destinationLocationCode: "PAR",
          departureDate: "2027-01-15",
          adults: 1,
          nonStop: true,
        },
      }),
    searchFlightAvailabilities: (c) =>
      c.searchFlightAvailabilities(context, {
        body: { originDestinations: [], travelers: [], sources: ["GDS"] },
      }),
    upsellAirOffers: (c) =>
      c.upsellAirOffers(context, { body: { data: { type: "flight-offers-upselling", flightOffers: [] } } }),
    quoteAirOffers: (c) =>
      c.quoteAirOffers(context, {
        body: { data: { type: "flight-offers-pricing", flightOffers: [] } },
        query: { include: ["bags", "credit-card-fees"] },
      }),
    createFlightOrders: (c) =>
      c.createFlightOrders(context, { body: { data: { type: "flight-order", flightOffers: [] } } }),
    issueFlightOrder: (c) => c.issueFlightOrder(context, { flightOrderId: ORDER_ID, body: { data: {} } }),
    getFlightOrder: (c) => c.getFlightOrder(context, { flightOrderId: ORDER_ID }),
    patchFlightOrder: (c) =>
      c.patchFlightOrder(context, {
        flightOrderId: ORDER_ID,
        body: { data: { type: "flight-order", flightOffers: [] } },
      }),
    cancelFlightOrder: (c) => c.cancelFlightOrder(context, { flightOrderId: ORDER_ID }),
    getFlightOrderByReference: (c) =>
      c.getFlightOrderByReference(context, { query: { reference: "SYN001", originSystemCode: "GDS" } }),
    listQueue: (c) => c.listQueue(context, { queueId: 8 }),
  };

const OPERATION_NAMES = Object.keys(AMADEUS_OPERATIONS) as AmadeusOperationName[];
const READS = OPERATION_NAMES.filter((name) => AMADEUS_OPERATIONS[name].retry === "read");
const WRITES = OPERATION_NAMES.filter((name) => AMADEUS_OPERATIONS[name].retry === "write");

beforeEach(() => {
  tenantId = newId("ten");
  connection = Object.freeze({
    tenantId,
    environment: "test",
    connectionId: newId("sc"),
    credentialSource: "velexis",
    credId: newId("ama"),
    clientId: "velexis-test-client",
    encryptedSecret: { ciphertext: "AAAA", aad: "aad" },
    baseUrl: BASE_URL,
    offices: { queuing: OFFICE, owner: OFFICE, queue: OFFICE, retrieval: OFFICE },
    officeIds: [OFFICE, SECOND_OFFICE],
  });
  tenant = {
    tenantId,
    key: "alpha",
    schemaName: "tenant_alpha" as RequestTenant["schemaName"],
    environment: "test",
    caller: { type: "edge", id: "edge" },
    actor: { type: "guest", id: null },
    requestId: "req-0000-0001",
  };
  context = { tenantId, environment: "test", operation: "flights.search", requestId: "req-0000-0001" };
  fetchMock = vi.fn<AmadeusFetch>(() => Promise.resolve(json({ data: [] })));
  resolver = { resolve: vi.fn(() => Promise.resolve(connection)) };
  tokens = { getToken: vi.fn(() => Promise.resolve(TOKEN)), dropToken: vi.fn(() => Promise.resolve()) };
  limiter = { take: vi.fn(() => Promise.resolve()) };
  rows = [];
  insert = vi.fn((_trx: unknown, record: SupplierRequestRecord) => {
    rows.push(record);
    return Promise.resolve();
  });
  logs = [];
  request = undefined;
  appEnv = "test";
});

describe("the operations", () => {
  it("sends each of the 12 to its method and path, with the token and the media type", async () => {
    for (const name of OPERATION_NAMES) {
      fetchMock.mockClear();
      await CALLS[name](client());
      const [call] = sent();
      const spec = AMADEUS_OPERATIONS[name];

      expect(sent()).toHaveLength(1);
      expect(call?.method).toBe(spec.method);
      expect(call?.url.split("?")[0]).toBe(
        `${BASE_URL}${spec.path.replace("{flight-orderId}", ORDER_ID).replace("{queue-id}", "8")}`,
      );
      expect(call?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect(call?.headers["x-http-method-override"]).toBe(spec.methodOverride ? "GET" : undefined);
      expect(call?.headers["content-type"]).toBe(
        ["POST", "PATCH"].includes(spec.method) ? "application/vnd.amadeus+json" : undefined,
      );
    }
    expect(rows.map((row) => row.amadeusOperationId)).toEqual(
      OPERATION_NAMES.map((name) => AMADEUS_OPERATIONS[name].operationId),
    );
  });

  it("writes queries as Amadeus reads them: arrays comma-separated, booleans as words", async () => {
    await CALLS.quoteAirOffers(client());
    await CALLS.getFlightOffers(client());

    expect(sent().map((call) => call.url)).toEqual([
      `${BASE_URL}/v1/shopping/flight-offers/pricing?include=bags%2Ccredit-card-fees`,
      `${BASE_URL}/v2/shopping/flight-offers?originLocationCode=MAD&destinationLocationCode=PAR&departureDate=2027-01-15&adults=1&nonStop=true`,
    ]);
    expect(requestPath("/v1/booking/flight-orders/{flight-orderId}", { "flight-orderId": "a/b c" })).toBe(
      "/v1/booking/flight-orders/a%2Fb%20c",
    );
    expect(() => requestPath("/v1/office/queues/{queue-id}")).toThrow(TypeError);
  });

  it("returns the parsed answer and the call's facts, with one row and one log line without bodies", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: "1" }] }, 200, { "ama-request-id": "0001ABCD" }));

    const result = await CALLS.searchFlightOffers(client());

    expect(result.body).toEqual({ data: [{ id: "1" }] });
    expect(result.call).toEqual({
      supplierRequestId: rows[0]?.id,
      officeId: OFFICE,
      status: 200,
      durationMs: expect.any(Number),
      correlationId: "0001ABCD",
      attempts: 1,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^sreq_/),
        environment: "test",
        operation: "flights.search",
        amadeusApi: "FlightOffersSearch",
        amadeusOperationId: "searchFlightOffers",
        httpMethod: "POST",
        path: "/v2/shopping/flight-offers",
        officeId: OFFICE,
        httpStatus: 200,
        outcome: "success",
        errorCodes: [],
        correlationId: "0001ABCD",
        requestId: "req-0000-0001",
        requestBody: { originDestinations: [], travelers: [], sources: ["GDS"] },
        responseBody: { data: [{ id: "1" }] },
        bookingId: null,
        searchId: null,
        staffId: null,
      }),
    ]);
    expect(logs).toEqual([
      [
        "info",
        expect.objectContaining({
          tenantId,
          amadeusOperation: "searchFlightOffers",
          status: 200,
          outcome: "success",
          attempt: 1,
          supplierRequestId: rows[0]?.id,
        }),
        "amadeus.call",
      ],
    ]);
    expect(JSON.stringify(logs)).not.toContain("originDestinations");
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("answers a 204 without a body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await CALLS.cancelFlightOrder(client());

    expect(result.body).toBeUndefined();
    expect(result.call.status).toBe(204);
    expect(rows[0]).toMatchObject({ httpMethod: "DELETE", outcome: "success", requestBody: undefined });
  });

  it("stores the caller's redacted copy instead of the request", async () => {
    const card = { creditCard: { brand: "VISA" as const, number: "4111111111111111", securityCode: "737" } };
    const redacted = { data: { formOfPayments: [{ creditCard: { brand: "VISA", number: "1111" } }] } };

    await client().createFlightOrders(
      context,
      { body: { data: { type: "flight-order", flightOffers: [], formOfPayments: [card] } } },
      { redactedRequest: redacted },
    );

    expect(sent()[0]?.body).toMatchObject({ data: { formOfPayments: [card] } });
    expect(rows[0]?.requestBody).toEqual({
      data: { ...redacted.data, queuingOfficeId: OFFICE, ownerOfficeId: OFFICE },
    });
    expect(JSON.stringify(rows)).not.toContain("4111111111111111");
  });
});

describe("retries", () => {
  it("sends a read once more after a 5xx, a network error or a timeout, then maps the failure", async () => {
    for (const name of READS) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(() =>
        Promise.resolve(amadeusError(500, 141, "SYSTEM ERROR HAS OCCURRED")),
      );
      const error = await rejection(CALLS[name](client()));

      expect([name, error.code, sent().length]).toEqual([name, "SUPPLIER_ERROR", 2]);
    }

    fetchMock.mockReset();
    fetchMock.mockImplementation(hang);
    const timeout = await rejection(CALLS.getFlightOffers(client()));
    expect([timeout.status, timeout.code, sent().length]).toEqual([504, "SUPPLIER_TIMEOUT", 2]);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(
      new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }),
    );
    const refused = await rejection(CALLS.quoteAirOffers(client()));
    expect([refused.status, refused.code, sent().length]).toEqual([503, "SUPPLIER_UNAVAILABLE", 2]);
  });

  it("succeeds when the retry of a read does, with a row for each request", async () => {
    fetchMock.mockResolvedValueOnce(amadeusError(503, 141)).mockResolvedValueOnce(json({ data: [] }));

    const result = await CALLS.getFlightOrder(client());

    expect(result.call.attempts).toBe(2);
    expect(rows.map((row) => [row.httpStatus, row.outcome])).toEqual([
      [503, "server_error"],
      [200, "success"],
    ]);
    expect(limiter.take).toHaveBeenCalledTimes(2);
  });

  it("never sends a write twice: not after a 5xx, not after a timeout [OBE-018 AC1]", async () => {
    for (const name of WRITES) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(() => Promise.resolve(amadeusError(500, 141)));
      const failed = await rejection(CALLS[name](client()));
      fetchMock.mockReset();
      fetchMock.mockImplementation(hang);
      const timedOut = await rejection(CALLS[name](client()));

      expect([name, failed.code, timedOut.status, timedOut.code, sent().length]).toEqual([
        name,
        "SUPPLIER_ERROR",
        504,
        "SUPPLIER_TIMEOUT",
        1,
      ]);
    }
    expect(WRITES.sort()).toEqual([
      "cancelFlightOrder",
      "createFlightOrders",
      "issueFlightOrder",
      "patchFlightOrder",
    ]);
  });

  it("never repeats a 4xx", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(amadeusError(400, 34651, "SEGMENT SELL FAILURE")));

    const error = await rejection(CALLS.quoteAirOffers(client()));

    expect([error.code, sent().length, rows[0]?.errorCodes, rows[0]?.outcome]).toEqual([
      "SOLD_OUT",
      1,
      [34651],
      "client_error",
    ]);
  });

  it("drops the token after a 401 and sends the request once more with a new one, writes included", async () => {
    tokens.getToken.mockResolvedValueOnce(TOKEN).mockResolvedValueOnce(NEW_TOKEN);
    fetchMock
      .mockResolvedValueOnce(amadeusError(401, 38190, "Invalid access token"))
      .mockResolvedValueOnce(json({ data: { id: ORDER_ID } }, 201));

    const result = await CALLS.createFlightOrders(client());

    expect(result.call).toMatchObject({ status: 201, attempts: 2 });
    expect(tokens.dropToken).toHaveBeenCalledWith(connection, TOKEN);
    expect(sent().map((call) => call.headers["authorization"])).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${NEW_TOKEN}`,
    ]);
  });

  it("answers a second 401 with 502 SUPPLIER_ERROR", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(amadeusError(401, 38190, "Invalid access token")));

    const error = await rejection(CALLS.issueFlightOrder(client()));

    expect([error.status, error.code, sent().length, tokens.dropToken.mock.calls.length]).toEqual([
      502,
      "SUPPLIER_ERROR",
      2,
      1,
    ]);
  });

  it("logs an ops alert when Amadeus itself answers 429", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(amadeusError(429, 38194, "Too many requests")));

    const error = await rejection(CALLS.getFlightOffers(client()));

    expect([error.status, error.code, sent().length]).toEqual([503, "SUPPLIER_UNAVAILABLE", 1]);
    expect(logs.filter(([, , message]) => message === "amadeus.quota_exceeded")).toEqual([
      [
        "error",
        { credId: connection.credId, environment: "test", amadeusOperation: "getFlightOffers" },
        "amadeus.quota_exceeded",
      ],
    ]);
  });

  it("requests the token once more after a network error, a timeout or a 5xx of the token request, never after a 429", async () => {
    const tokenError = (status: number | null, retryable: boolean): AppError =>
      new AppError(status === null ? "SUPPLIER_TIMEOUT" : "SUPPLIER_UNAVAILABLE", {
        cause: new AmadeusTokenRequestError("token request failed", status, retryable),
      });
    tokens.getToken.mockRejectedValueOnce(tokenError(null, true)).mockResolvedValueOnce(TOKEN);
    await CALLS.createFlightOrders(client());
    expect(tokens.getToken).toHaveBeenCalledTimes(2);

    tokens.getToken.mockReset();
    tokens.getToken.mockRejectedValueOnce(tokenError(503, true)).mockRejectedValueOnce(tokenError(503, true));
    const twice = await rejection(CALLS.getFlightOffers(client()));
    expect([twice.code, tokens.getToken.mock.calls.length]).toEqual(["SUPPLIER_UNAVAILABLE", 2]);

    tokens.getToken.mockReset();
    tokens.getToken.mockRejectedValueOnce(tokenError(429, false));
    const quota = await rejection(CALLS.getFlightOffers(client()));
    expect([quota.code, tokens.getToken.mock.calls.length]).toEqual(["SUPPLIER_UNAVAILABLE", 1]);

    tokens.getToken.mockReset();
    tokens.getToken.mockRejectedValueOnce(new AppError("SUPPLIER_NOT_CONFIGURED"));
    const refused = await rejection(CALLS.getFlightOffers(client()));
    expect([refused.code, tokens.getToken.mock.calls.length]).toEqual(["SUPPLIER_NOT_CONFIGURED", 1]);
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

describe("the limits of flow §4", () => {
  it("time each operation out as the table says, and retry reads only", () => {
    expect(DEFAULT_AMADEUS_LIMITS.timeoutMs).toEqual({
      searchFlightOffers: 30_000,
      getFlightOffers: 30_000,
      searchFlightAvailabilities: 20_000,
      upsellAirOffers: 20_000,
      quoteAirOffers: 20_000,
      createFlightOrders: 60_000,
      issueFlightOrder: 60_000,
      getFlightOrder: 15_000,
      patchFlightOrder: 30_000,
      cancelFlightOrder: 30_000,
      getFlightOrderByReference: 15_000,
      listQueue: 15_000,
    });
    expect(OPERATION_NAMES.filter((name) => isRetryable(AMADEUS_OPERATIONS[name]))).toEqual(READS);
    expect(READS).toHaveLength(8);
  });

  it("wait 300 to 800 ms before a retry", () => {
    expect([0, 0.5, 0.999_999, 1, -1, 2].map((r) => retryDelayMs(DEFAULT_AMADEUS_LIMITS, () => r))).toEqual([
      300, 550, 800, 800, 300, 800,
    ]);
  });

  it("abort a request at its operation's timeout", async () => {
    fetchMock.mockImplementation(hang);
    const started = performance.now();

    await rejection(
      CALLS.createFlightOrders(
        client({ ...LIMITS, timeoutMs: { ...LIMITS.timeoutMs, createFlightOrders: 30 } }),
      ),
    );

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(rows[0]).toMatchObject({ httpStatus: null, outcome: "timeout" });
  });
});

describe("offices", () => {
  it("fills the queuing and owner offices of a new order from the connection, and keeps the tenant's own", async () => {
    await CALLS.createFlightOrders(client());
    await client().createFlightOrders(context, {
      body: {
        data: {
          type: "flight-order",
          flightOffers: [],
          queuingOfficeId: SECOND_OFFICE,
          ownerOfficeId: SECOND_OFFICE,
        },
      },
    });

    expect(sent().map((call) => call.body)).toEqual([
      { data: { type: "flight-order", flightOffers: [], queuingOfficeId: OFFICE, ownerOfficeId: OFFICE } },
      {
        data: {
          type: "flight-order",
          flightOffers: [],
          queuingOfficeId: SECOND_OFFICE,
          ownerOfficeId: SECOND_OFFICE,
        },
      },
    ]);
    expect(rows.map((row) => row.officeId)).toEqual([OFFICE, SECOND_OFFICE]);
  });

  it("answers 403 OFFICE_NOT_ALLOWED for another office, before any bucket, token or call", async () => {
    const attempts: Array<() => Promise<unknown>> = [
      () =>
        client().createFlightOrders(context, {
          body: { data: { type: "flight-order", flightOffers: [], ownerOfficeId: FOREIGN_OFFICE } },
        }),
      () =>
        client().createFlightOrders(context, {
          body: {
            data: {
              type: "flight-order",
              flightOffers: [],
              automatedProcess: [{ code: "IMMEDIATE", queue: { number: "8" }, officeId: FOREIGN_OFFICE }],
            },
          },
        }),
      () =>
        client().patchFlightOrder(context, {
          flightOrderId: ORDER_ID,
          body: { data: { type: "flight-order", flightOffers: [], queuingOfficeId: FOREIGN_OFFICE } },
        }),
      () => client().listQueue(context, { queueId: 8, query: { officeId: FOREIGN_OFFICE } }),
      () => client().getFlightOrder({ ...context, orderOffice: FOREIGN_OFFICE }, { flightOrderId: ORDER_ID }),
    ];
    for (const attempt of attempts) {
      const error = await rejection(attempt());

      expect([error.status, error.code]).toEqual([403, "OFFICE_NOT_ALLOWED"]);
      expect(error.cause).toBeInstanceOf(AmadeusOfficeNotAllowedError);
    }
    expect([
      limiter.take.mock.calls.length,
      tokens.getToken.mock.calls.length,
      fetchMock.mock.calls.length,
    ]).toEqual([0, 0, 0]);
    expect(rows).toEqual([]);
  });

  it("lists the tenant's queue office, or another of its offices, and records the order office", async () => {
    await CALLS.listQueue(client());
    await client().listQueue(context, { queueId: 8, query: { officeId: SECOND_OFFICE, max: 5 } });
    await client().getFlightOrder({ ...context, orderOffice: SECOND_OFFICE }, { flightOrderId: ORDER_ID });

    expect(sent().map((call) => call.url)).toEqual([
      `${BASE_URL}/v1/office/queues/8?officeId=${OFFICE}`,
      `${BASE_URL}/v1/office/queues/8?officeId=${SECOND_OFFICE}&max=5`,
      `${BASE_URL}/v1/booking/flight-orders/${ORDER_ID}`,
    ]);
    expect(rows.map((row) => row.officeId)).toEqual([OFFICE, SECOND_OFFICE, SECOND_OFFICE]);
  });
});

describe("the buckets", () => {
  it("make no call when either is empty [OBE-018 AC3]", async () => {
    limiter.take.mockRejectedValue(new AppError("RATE_LIMITED", { details: { retryAfterSeconds: 1 } }));

    const error = await rejection(CALLS.searchFlightOffers(client()));

    expect([error.status, error.code, error.details]).toEqual([
      429,
      "RATE_LIMITED",
      { retryAfterSeconds: 1 },
    ]);
    expect(limiter.take).toHaveBeenCalledWith({ credId: connection.credId, tenantId, environment: "test" });
    expect([tokens.getToken.mock.calls.length, fetchMock.mock.calls.length, rows.length]).toEqual([0, 0, 0]);
  });
});

describe("the call context", () => {
  it("must name the tenant of the request or job context", async () => {
    tenant = undefined;
    await expect(CALLS.getFlightOffers(client())).rejects.toBeInstanceOf(NoTenantContextError);
    tenant = { ...(tenant ?? ({} as RequestTenant)), tenantId: newId("ten") } as RequestTenant;
    await expect(CALLS.getFlightOffers(client())).rejects.toBeInstanceOf(AmadeusTenantMismatchError);

    expect([resolver.resolve.mock.calls.length, fetchMock.mock.calls.length]).toEqual([0, 0]);
  });

  it("is checked: ids, operation and offices of the right shape, never their values in the error", () => {
    const bad: Array<[Partial<AmadeusCallContext>, keyof AmadeusCallContext]> = [
      [{ tenantId: "acme" }, "tenantId"],
      [{ environment: "prod" as "live" }, "environment"],
      [{ operation: "" }, "operation"],
      [{ operation: "flights search" }, "operation"],
      [{ requestId: "short" }, "requestId"],
      [{ staffId: "acc_123" }, "staffId"],
      [{ bookingId: "bkg_x" }, "bookingId"],
      [{ searchId: newId("bkg") }, "searchId"],
      [{ orderOffice: "nce1a0955" }, "orderOffice"],
      [{ stubScenario: "Server Error" }, "stubScenario"],
    ];
    for (const [change, field] of bad) {
      expect(() => checkCallContext({ ...context, ...change })).toThrow(
        new InvalidAmadeusCallContextError(field),
      );
    }
    const full = {
      ...context,
      staffId: newId("stf"),
      bookingId: newId("bkg"),
      searchId: newId("srch"),
      orderOffice: OFFICE,
      stubScenario: "timeout-lost",
    };
    expect(checkCallContext(full)).toEqual(full);
    expect(Object.isFrozen(checkCallContext(full))).toBe(true);
  });

  it("links the row to the booking, the search and the staff member", async () => {
    const linked = { ...context, bookingId: newId("bkg"), searchId: newId("srch"), staffId: newId("stf") };

    await client().getFlightOrder(linked, { flightOrderId: ORDER_ID });

    expect(rows[0]).toMatchObject({
      bookingId: linked.bookingId,
      searchId: linked.searchId,
      staffId: linked.staffId,
    });
  });
});

describe("X-Stub-Scenario", () => {
  it("forwards the context's scenario, else the request's header, outside production only", async () => {
    const query = {
      originLocationCode: "MAD",
      destinationLocationCode: "PAR",
      departureDate: "2027-01-15",
      adults: 1,
    };
    await client().getFlightOffers({ ...context, stubScenario: "server-error" }, { query });
    request = { headers: { "x-stub-scenario": "sold-out" } };
    await CALLS.quoteAirOffers(client());
    request = { headers: { "x-stub-scenario": "evil\r\nheader" } };
    await CALLS.quoteAirOffers(client());
    appEnv = "production";
    request = { headers: { "x-stub-scenario": "sold-out" } };
    await CALLS.quoteAirOffers(client());
    await client().getFlightOffers({ ...context, stubScenario: "timeout" }, { query });

    expect(sent().map((call) => call.headers["X-Stub-Scenario"])).toEqual([
      "server-error",
      "sold-out",
      undefined,
      undefined,
      undefined,
    ]);
    expect(forwardedStubScenario("development", {}, ["timeout", "success"])).toBe("timeout");
    expect(forwardedStubScenario("production", { stubScenario: "timeout" }, "timeout")).toBeUndefined();
  });
});

describe("the supplier_requests row", () => {
  it("never fails the call when it cannot be written", async () => {
    insert.mockRejectedValue(new Error("connection terminated"));

    const result = await CALLS.createFlightOrders(client());

    expect(result.call.supplierRequestId).toBeNull();
    expect(logs).toContainEqual([
      "warn",
      expect.objectContaining({ tenantId, amadeusOperation: "createFlightOrders" }),
      "amadeus.supplier_request_not_recorded",
    ]);
  });

  it("is written without the booking link when the booking is not committed yet", async () => {
    const bookingId = newId("bkg");
    insert
      .mockRejectedValueOnce(Object.assign(new Error("violates foreign key constraint"), { code: "23503" }))
      .mockImplementationOnce((_trx, record) => {
        rows.push(record);
        return Promise.resolve();
      });

    const result = await client().issueFlightOrder(
      { ...context, bookingId },
      { flightOrderId: ORDER_ID, body: {} },
    );

    expect(rows).toEqual([expect.objectContaining({ id: result.call.supplierRequestId, bookingId: null })]);
    expect(logs).toContainEqual([
      "warn",
      expect.objectContaining({ bookingId }),
      "amadeus.supplier_request_unlinked",
    ]);
  });
});
