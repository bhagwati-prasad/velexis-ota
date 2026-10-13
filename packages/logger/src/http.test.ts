import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import pinoHttp from "pino-http";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./create-logger.js";
import { isHealthPath, pinoHttpOptions, REQUEST_ID_PATTERN, resolveRequestId } from "./http.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LogRecord = Record<string, unknown>;

interface Sink {
  readonly lines: string[];
  write(line: string): void;
  records(): LogRecord[];
}

function memorySink(): Sink {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
    records: () => lines.map((line) => JSON.parse(line) as LogRecord),
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/**
 * Starts a loopback server that runs the pino-http middleware built from `pinoHttpOptions` before
 * `handler`, and resolves `finished()` after the response of each request has been logged.
 */
async function startServer(
  handler: Handler,
): Promise<{ url: string; sink: Sink; finished: () => Promise<void> }> {
  const sink = memorySink();
  const logger = createLogger({ app: "ota-api", env: "test", destination: sink });
  const httpLogger = pinoHttp(pinoHttpOptions({ app: "ota-api", logger }));
  const responses: Array<Promise<void>> = [];
  const server = createServer((req, res) => {
    httpLogger(req, res);
    // Registered after pino-http's own listener, so the line is written when this resolves.
    responses.push(new Promise<void>((resolve) => res.on("finish", () => setImmediate(resolve))));
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const finished = async (): Promise<void> => {
    await Promise.all(responses);
  };
  return { url, sink, finished };
}

const ok: Handler = (_req, res) => {
  res.statusCode = 200;
  res.end("ok");
};

describe("request id", () => {
  it("reuses a valid incoming X-Request-Id and returns it [X-003 AC4]", async () => {
    const { url, sink, finished } = await startServer(ok);
    const requestId = "req_01J9ZK3M5N.abc-DEF";

    const response = await fetch(`${url}/v1/storefront`, { headers: { "x-request-id": requestId } });
    await response.text();
    await finished();

    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(sink.records()).toEqual([expect.objectContaining({ requestId, msg: "request completed" })]);
  });

  it("replaces an invalid incoming X-Request-Id (<script>) with a UUID [X-003 AC4]", async () => {
    const { url, sink, finished } = await startServer(ok);

    const response = await fetch(`${url}/v1/storefront`, { headers: { "x-request-id": "<script>" } });
    await response.text();
    await finished();

    const returned = response.headers.get("x-request-id") ?? "";
    expect(returned).toMatch(UUID_PATTERN);
    expect(sink.lines.join("\n")).not.toContain("<script>");
    expect(sink.records()).toEqual([expect.objectContaining({ requestId: returned })]);
  });

  it("generates a UUID when no X-Request-Id is sent [X-003 AC4]", async () => {
    const { url, sink, finished } = await startServer(ok);

    const response = await fetch(`${url}/v1/storefront`);
    await response.text();
    await finished();

    const returned = response.headers.get("x-request-id") ?? "";
    expect(returned).toMatch(UUID_PATTERN);
    expect(sink.records()[0]?.["requestId"]).toBe(returned);
  });

  it("accepts exactly the ids the Caddyfile accepts [X-003 AC4]", () => {
    expect(REQUEST_ID_PATTERN.source).toBe("^[A-Za-z0-9._-]{8,128}$");
    for (const valid of ["abcdefgh", "a".repeat(128), "0f8fad5b-d9cb-469f-a165-70867728950e", "A.b_C-9.z"]) {
      expect(resolveRequestId(valid)).toBe(valid);
    }
    for (const invalid of [
      "<script>",
      "abcdefg",
      "a".repeat(129),
      "abc def gh",
      "abcdefgh\n",
      "abcdefgh,ijk",
    ]) {
      expect(resolveRequestId(invalid)).toMatch(UUID_PATTERN);
    }
    expect(resolveRequestId(["abcdefgh", "ijklmnop"])).toMatch(UUID_PATTERN);
    expect(resolveRequestId(undefined)).toMatch(UUID_PATTERN);
  });
});

describe("request line", () => {
  it("logs one line with method, route template, status and durationMs", async () => {
    const { url, sink, finished } = await startServer((req, res) => {
      // What Express sets once a route matched; NestJS registers its routes on the Express router.
      Object.assign(req, { route: { path: "/v1/bookings/:bookingId" }, baseUrl: "" });
      res.statusCode = 200;
      res.end("{}");
    });

    const response = await fetch(`${url}/v1/bookings/bkg_01J9ZK3M5N?include=travelers`);
    await response.text();
    await finished();

    expect(sink.lines).toHaveLength(1);
    const [record] = sink.records();
    expect(record).toEqual({
      level: 30,
      time: expect.any(String) as unknown,
      app: "ota-api",
      env: "test",
      requestId: expect.stringMatching(UUID_PATTERN) as unknown,
      method: "GET",
      route: "/v1/bookings/:bookingId",
      status: 200,
      durationMs: expect.any(Number) as unknown,
      msg: "request completed",
    });
  });

  it("logs the path without its query string when no route matched", async () => {
    const { url, sink, finished } = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });

    const response = await fetch(`${url}/v1/files/tenant_acme/x.pdf?exp=1760000000&sig=c2lnbmF0dXJl`);
    await response.text();
    await finished();

    expect(sink.records()).toEqual([
      expect.objectContaining({ route: "/v1/files/tenant_acme/x.pdf", status: 404 }),
    ]);
    expect(sink.lines[0]).not.toContain("sig=");
    expect(sink.lines[0]).not.toContain("c2lnbmF0dXJl");
  });

  it("logs a 5xx response at level error with the serialized error and no headers", async () => {
    const { url, sink, finished } = await startServer((_req, res) => {
      res.err = Object.assign(new Error("database unavailable"), { response: { headers: { cookie: "x" } } });
      res.statusCode = 503;
      res.end();
    });

    const response = await fetch(`${url}/v1/storefront`, { headers: { authorization: "Bearer abcdefgh" } });
    await response.text();
    await finished();

    const [record] = sink.records();
    expect(record).toMatchObject({
      level: 50,
      status: 503,
      msg: "request errored",
      err: { type: "Error", message: "database unavailable" },
    });
    expect(Object.keys(record?.["err"] as LogRecord).sort()).toEqual(["message", "stack", "type"]);
    expect(sink.lines[0]).not.toContain("Bearer");
    expect(sink.lines[0]).not.toContain("cookie");
  });

  it("logs a 4xx response that carries res.err at level info with the serialized error only", async () => {
    const { url, sink, finished } = await startServer((_req, res) => {
      // What nestjs-pino's LoggerErrorInterceptor does with a thrown HttpException.
      res.err = Object.assign(new Error("Validation failed"), { response: { body: { password: "x" } } });
      res.statusCode = 400;
      res.end();
    });

    const response = await fetch(`${url}/v1/auth/sign-in`, { method: "POST" });
    await response.text();
    await finished();

    const [record] = sink.records();
    expect(record).toMatchObject({
      level: 30,
      route: "/v1/auth/sign-in",
      status: 400,
      err: { type: "Error", message: "Validation failed" },
    });
    expect(Object.keys(record?.["err"] as LogRecord).sort()).toEqual(["message", "stack", "type"]);
  });

  it("does not log /health/* requests", async () => {
    const { url, sink, finished } = await startServer(ok);

    for (const path of ["/health/live", "/health/ready?verbose=1", "/HEALTH/live", "/health"]) {
      const response = await fetch(`${url}${path}`);
      await response.text();
    }
    const response = await fetch(`${url}/healthcheck`);
    await response.text();
    await finished();

    expect(sink.records().map((record) => record["route"])).toEqual(["/healthcheck"]);
  });

  it("binds requestId to the request logger and never the request itself", async () => {
    const { url, sink, finished } = await startServer((req, res) => {
      req.log.info({ bookingId: "bkg_01" }, "booking.retrieved");
      res.end();
    });

    const response = await fetch(`${url}/v1/bookings/bkg_01`, {
      headers: { "x-request-id": "req-12345678" },
    });
    await response.text();
    await finished();

    const [appLine, requestLine] = sink.records();
    expect(appLine).toMatchObject({ app: "ota-api", requestId: "req-12345678", bookingId: "bkg_01" });
    expect(appLine).not.toHaveProperty("req");
    expect(requestLine).toMatchObject({ requestId: "req-12345678", msg: "request completed" });
  });
});

describe("pinoHttpOptions", () => {
  it("adds the app to a logger that has none and refuses a logger of another app", () => {
    const sink = memorySink();
    const bare = pino({ base: null, timestamp: false }, sink);
    const options = pinoHttpOptions({ app: "ota-api", logger: bare });
    options.logger?.info("x");
    expect(sink.records()[0]).toMatchObject({ app: "ota-api" });

    const platformLogger = createLogger({ app: "platform-api", env: "test", destination: sink });
    expect(() => pinoHttpOptions({ app: "ota-api", logger: platformLogger })).toThrow(/does not match/);
    expect(pinoHttpOptions({ app: "platform-api", logger: platformLogger }).logger).toBe(platformLogger);
  });

  it("recognises health paths", () => {
    expect(isHealthPath("/health/live")).toBe(true);
    expect(isHealthPath("/health")).toBe(true);
    expect(isHealthPath("/health?x=1")).toBe(true);
    expect(isHealthPath("/healthz")).toBe(false);
    expect(isHealthPath("/v1/health/live")).toBe(false);
    expect(isHealthPath(undefined)).toBe(false);
  });
});
