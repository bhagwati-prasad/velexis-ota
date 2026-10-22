// The Amadeus stub server (X-026, ADR-0015): a plain Node `http` server, no framework.
//
// Every request goes through the same steps:
//   1. the route (token endpoint or one of the 12 operations; anything else is a 404 like Amadeus's gateway, and a
//      request target that is not a URL a 400);
//   2. the scenario (`X-Stub-Scenario` or the server's default; an unknown name is a 400);
//   3. the token endpoint checks the grant and the client credentials; an operation checks the bearer token (401),
//      answers 501 while it is not stubbed, then validates the request against its specification (400);
//   4. the generic scenario (`server-error` 500, `rate-limited` 429, `timeout` holds the response; an order write
//      applies `timeout` itself, after the write);
//   5. the token or the operation's handler, which answers now or holds its answer.
// Each request is recorded (method, path, query, headers with `Authorization` and `Cookie` redacted, never a body;
// runs of 13 to 19 digits in the path, the query and the headers masked to their last 4, so no card number lands in
// it) for test assertions (`requests()`, used by @velexis/testing/amadeus). Each server keeps the flight orders that
// Flight Create Orders stored in memory (`orders`, src/orders.ts).
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { TokenStore, type StubClock, type StubCredentials } from "./oauth";
import { maskCardNumbers, OrderStore, type AirlineSegmentChange, type StubOrders } from "./orders";
import {
  loadFixture,
  matchRoute,
  STUB_FIXTURES,
  STUB_OPERATIONS,
  type OperationName,
  type StubOperation,
} from "./routes";
import {
  AMADEUS_ERROR_CODES,
  AMADEUS_JSON,
  amadeusErrorResponse,
  applyScenario,
  isHeld,
  isStubScenario,
  resolveScenario,
  SCENARIO_HEADER,
  STUB_ERROR_CODES,
  STUB_SCENARIOS,
  type ScenarioOutcome,
  type StubResponse,
  type StubScenario,
} from "./scenarios";
import { AmadeusSpecs } from "./validate";

/** The interface the stub binds to unless told otherwise: loopback only. */
export const DEFAULT_HOST = "127.0.0.1";
/** Larger request bodies get a 413. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** The request log keeps the most recent requests only, so a long-running stub does not grow without bound. */
export const MAX_RECORDED_REQUESTS = 1000;
/** The `operation` of a recorded token request. */
export const TOKEN_OPERATION = "oauth2Token";

/** Timers of the `timeout` scenario; tests inject manual ones instead of waiting 30 s. */
export interface StubTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StubServerOptions {
  /** TCP port; `0` picks a free one (read it from `url` or `port`). */
  readonly port: number;
  /** Interface to bind; default `127.0.0.1`. */
  readonly host?: string | undefined;
  /** Scenario of requests without `X-Stub-Scenario`; default `success`. */
  readonly defaultScenario?: StubScenario | undefined;
  /** Accept only these client credentials; default: any non-empty client id and secret. */
  readonly credentials?: StubCredentials | undefined;
  /** Time source of token expiry and `receivedAt`; default the system clock. */
  readonly clock?: StubClock | undefined;
  /** Timers of the `timeout` scenario; default the global `setTimeout` and `clearTimeout`. */
  readonly timers?: StubTimers | undefined;
  /** The specifications to validate against; default one instance shared by every server of the process. */
  readonly specs?: AmadeusSpecs | undefined;
  /** Called once per request when its response is sent or the client went away (the CLI prints a line). */
  readonly onResponse?: ((request: RecordedRequest) => void) | undefined;
}

/** One request as the stub saw it. Bodies are never recorded. */
export interface RecordedRequest {
  readonly method: string;
  /** The path without the query string. */
  readonly path: string;
  /** Query parameters; a repeated one is an array. */
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /**
   * Request headers (lower-case names) with `authorization`, `proxy-authorization` and `cookie` redacted. In the path,
   * the query and the headers, a run of 13 to 19 digits is masked to its last 4 (`XXXXXXXXXXXX1111`).
   */
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  /** `oauth2Token`, the operation's name, or `undefined` when no route matched. */
  readonly operation: OperationName | typeof TOKEN_OPERATION | undefined;
  /** The scenario that applied, or `undefined` before it was resolved (no route, unknown scenario). */
  readonly scenario: StubScenario | undefined;
  /** The status sent, or `undefined` while the response is held or when the client went away first. */
  readonly status: number | undefined;
  readonly receivedAt: Date;
  /** Milliseconds until the response was sent or the client went away; `undefined` while still open. */
  readonly durationMs: number | undefined;
}

export interface StubServer {
  /** `http://127.0.0.1:<port>`: the value of `AMADEUS_BASE_URL_TEST`. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** The recorded requests, oldest first (copies). */
  requests(): readonly RecordedRequest[];
  clearRequests(): void;
  /** The scenario of requests without `X-Stub-Scenario` from now on (`success` to go back to normal). */
  setDefaultScenario(scenario: StubScenario): void;
  /**
   * The flight orders this server stored (Flight Create Orders), `reset()` to forget them, and the airline's changes
   * a test plays on them (`changeSegment`, `cancelByAirline`).
   */
  readonly orders: StubOrders;
  /** Stops listening, drops held responses and open connections, and resolves when the port is free. */
  close(): Promise<void>;
}

const REDACTED = "[REDACTED]";
const REDACTED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

const SYSTEM_TIMERS: StubTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const SYSTEM_CLOCK: StubClock = { now: () => new Date() };

const NOT_FOUND = amadeusErrorResponse([
  {
    status: 404,
    code: AMADEUS_ERROR_CODES.resourceNotFound,
    title: "Resource not found",
    detail: "The targeted resource doesn't exist",
  },
]);

const INVALID_REQUEST_TARGET = amadeusErrorResponse([
  {
    status: 400,
    code: AMADEUS_ERROR_CODES.invalidFormat,
    title: "INVALID FORMAT",
    detail: "The request target is not a valid URL",
  },
]);

/** The base of relative request targets (`/v2/...`); an absolute-form target (`http://host/v2/...`) keeps its own. */
const TARGET_BASE = "http://amadeus-stub.invalid";

/** The URL of a request target, or `undefined` when it is not one (`http://[::1`): a 400, never a crash. */
function parseTarget(target: string): URL | undefined {
  try {
    return new URL(target, TARGET_BASE);
  } catch {
    return undefined;
  }
}

const PAYLOAD_TOO_LARGE = amadeusErrorResponse([
  {
    status: 413,
    code: STUB_ERROR_CODES.payloadTooLarge,
    title: "PAYLOAD TOO LARGE",
    detail: `The stub accepts request bodies up to ${MAX_BODY_BYTES} bytes`,
  },
]);

function notStubbed(operation: StubOperation): StubResponse {
  return amadeusErrorResponse([
    {
      status: 501,
      code: STUB_ERROR_CODES.notStubbed,
      title: "NOT STUBBED YET",
      detail:
        `${operation.name} (${operation.method} ${operation.path}, ${operation.api}) is not stubbed yet; ` +
        `task ${operation.plannedBy} adds it`,
    },
  ]);
}

function internalError(error: unknown): StubResponse {
  return amadeusErrorResponse([
    {
      status: 500,
      code: STUB_ERROR_CODES.internalError,
      title: "STUB INTERNAL ERROR",
      detail: error instanceof Error ? error.message : String(error),
    },
  ]);
}

let sharedSpecs: AmadeusSpecs | undefined;

/** What the stub does with a request: answer now, or hold the answer (`timeout`). */
type Answer = Exclude<ScenarioOutcome, { readonly kind: "continue" }>;

function recordHeaders(headers: IncomingHttpHeaders): Record<string, string | readonly string[]> {
  const copy: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      copy[name] = REDACTED_HEADERS.has(name)
        ? REDACTED
        : Array.isArray(value)
          ? value.map(maskCardNumbers)
          : maskCardNumbers(value);
    }
  }
  return copy;
}

function recordQuery(params: URLSearchParams): Record<string, string | readonly string[]> {
  const query: Record<string, string | readonly string[]> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name).map(maskCardNumbers);
    query[maskCardNumbers(name)] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return query;
}

/** Reads the body as UTF-8; past `MAX_BODY_BYTES` it keeps draining the request but returns `undefined`. */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    let ended = false;
    req.on("end", () => {
      ended = true;
      resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
    req.on("error", reject);
    req.on("close", () => {
      if (!ended) {
        reject(new Error("the client closed the connection before the request body ended"));
      }
    });
  });
}

/**
 * Sends `response` unless the client went away or an answer was already sent; returns whether it was sent. A body of
 * `undefined` (Flight Order Management DELETE's 204) sends no content.
 */
function send(res: ServerResponse, response: StubResponse): boolean {
  if (res.headersSent || res.destroyed) {
    return false;
  }
  if (response.body === undefined) {
    res.writeHead(response.status, { "cache-control": "no-store" });
    res.end();
    return true;
  }
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    "content-type": response.contentType ?? AMADEUS_JSON,
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
  return true;
}

type MutableRecord = { -readonly [K in keyof RecordedRequest]: RecordedRequest[K] };

function snapshot(record: MutableRecord): RecordedRequest {
  return Object.freeze({
    ...record,
    query: Object.freeze({ ...record.query }),
    headers: Object.freeze({ ...record.headers }),
    receivedAt: new Date(record.receivedAt.getTime()),
  });
}

/**
 * Starts the stub on `127.0.0.1:<port>` (or `host`) and resolves when it listens. The specifications of the
 * implemented operations and their fixtures are loaded and checked first (`AmadeusSpecs.check`), so a broken one fails
 * here, not on the first request; body validators are compiled on their first request.
 */
export async function createStubServer(options: StubServerOptions): Promise<StubServer> {
  const host = options.host ?? DEFAULT_HOST;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const timers = options.timers ?? SYSTEM_TIMERS;
  const specs = options.specs ?? (sharedSpecs ??= new AmadeusSpecs());
  const tokens = new TokenStore({ clock, credentials: options.credentials });
  const orders = new OrderStore();
  let defaultScenario: StubScenario = "success";
  const setDefaultScenario = (scenario: StubScenario): void => {
    if (!isStubScenario(scenario)) {
      throw new TypeError(`Unknown stub scenario; use one of: ${STUB_SCENARIOS.join(", ")}`);
    }
    defaultScenario = scenario;
  };
  if (options.defaultScenario !== undefined) {
    setDefaultScenario(options.defaultScenario);
  }

  for (const operation of STUB_OPERATIONS) {
    if (operation.handler !== undefined) {
      specs.check(operation.spec);
    }
  }
  for (const [operation, scenario] of STUB_FIXTURES) {
    loadFixture(operation, scenario);
  }

  const recorded: MutableRecord[] = [];
  /** Cancels of the responses that the `timeout` scenario holds. */
  const held = new Set<() => void>();

  /** Steps 1 to 5 of the header comment, for a request whose body has been read. */
  const answer = (
    req: IncomingMessage,
    url: URL,
    body: string | undefined,
    record: MutableRecord,
  ): Answer => {
    const respond = (response: StubResponse): Answer => ({ kind: "respond", response });
    const match = matchRoute(req.method ?? "", url.pathname);
    if (match === undefined) {
      return respond(NOT_FOUND);
    }
    record.operation = match.kind === "token" ? TOKEN_OPERATION : match.operation.name;
    const resolved = resolveScenario(req.headers[SCENARIO_HEADER.toLowerCase()], defaultScenario);
    if ("error" in resolved) {
      return respond(resolved.error);
    }
    const { scenario } = resolved;
    record.scenario = scenario;
    if (body === undefined) {
      return respond(PAYLOAD_TOO_LARGE);
    }

    if (match.kind === "token") {
      const checked = tokens.checkTokenRequest(req.headers, body);
      if ("error" in checked) {
        return respond(checked.error);
      }
      const outcome = applyScenario(scenario);
      return outcome.kind === "continue" ? respond(tokens.issue(checked.clientId)) : outcome;
    }

    const unauthenticated = tokens.authenticate(req.headers);
    if (unauthenticated !== undefined) {
      return respond(unauthenticated);
    }
    const { operation, pathParams } = match;
    if (operation.handler === undefined) {
      return respond(notStubbed(operation));
    }
    const validation = specs.validateRequest(operation.spec, {
      query: url.searchParams,
      headers: req.headers,
      pathParams,
      body,
    });
    if (!validation.ok) {
      return respond(amadeusErrorResponse(validation.issues));
    }
    const outcome = applyScenario(scenario, operation.writesOrder);
    if (outcome.kind !== "continue") {
      return outcome;
    }
    const result = operation.handler({
      operation,
      query: validation.request.query,
      body: validation.request.body,
      pathParams,
      scenario,
      orders,
      now: clock.now(),
    });
    return isHeld(result) ? result : respond(result);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now();
    const target = req.url ?? "/";
    const url = parseTarget(target);
    const record: MutableRecord = {
      method: req.method ?? "",
      path: maskCardNumbers(url === undefined ? (target.split("?")[0] ?? "") : url.pathname),
      query: url === undefined ? {} : recordQuery(url.searchParams),
      headers: recordHeaders(req.headers),
      operation: undefined,
      scenario: undefined,
      status: undefined,
      receivedAt: clock.now(),
      durationMs: undefined,
    };
    recorded.push(record);
    if (recorded.length > MAX_RECORDED_REQUESTS) {
      recorded.shift();
    }
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      record.durationMs = Math.round(performance.now() - started);
      options.onResponse?.(snapshot(record));
    };
    res.on("close", finish);
    const reply = (response: StubResponse): void => {
      if (send(res, response)) {
        record.status = response.status;
      }
    };

    try {
      const body = await readBody(req);
      const outcome: Answer =
        url === undefined
          ? { kind: "respond", response: INVALID_REQUEST_TARGET }
          : answer(req, url, body, record);
      if (outcome.kind === "respond") {
        reply(outcome.response);
      } else {
        const timer = timers.setTimeout(() => {
          if (held.delete(cancel)) {
            reply(outcome.afterHold);
          }
        }, outcome.holdMs);
        const cancel = (): void => timers.clearTimeout(timer);
        held.add(cancel);
        res.on("close", () => {
          if (held.delete(cancel)) {
            cancel();
          }
        });
      }
    } catch (error) {
      reply(internalError(error));
    }
  };

  const server = createServer((req, res) => {
    // `handle` answers every error itself; should answering fail too, drop the connection rather than crash the
    // process (and with it the test runner that started the stub in-process).
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  let closing: Promise<void> | undefined;
  return Object.freeze({
    url,
    host,
    port,
    requests: () => recorded.map(snapshot),
    clearRequests: () => {
      recorded.length = 0;
    },
    setDefaultScenario,
    orders: Object.freeze({
      list: () => orders.list(),
      reset: () => orders.reset(),
      changeSegment: (id: string, segmentId: string, change: AirlineSegmentChange) =>
        orders.changeSegment(id, segmentId, change),
      cancelByAirline: (id: string) => orders.cancelByAirline(id),
    }),
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const cancel of held) {
          cancel();
        }
        held.clear();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
      return closing;
    },
  });
}
