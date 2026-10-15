// /health/live and /health/ready of the API (127.0.0.1:3100) and the worker (127.0.0.1:3101) against the real
// PostgreSQL 16 and Redis 7 of DATABASE_URL and REDIS_URL, and the request context and request log lines of the API
// (PBE-001). The processes start exactly as dist/main.js and dist/worker.js do (startApi, startWorker), with a log
// destination that keeps the lines. Only `SELECT 1` and `PING` reach the services: no database or key is created.
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
  Controller,
  Get,
  Module,
  Req,
  type DynamicModule,
  type INestApplicationContext,
} from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { Redis } from "ioredis";
import { ClsService } from "nestjs-cls";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../../src/app.module";
import { createProcessLogger, PLATFORM_PROCESSES, parseConfig } from "../../../src/config";
import { API_HOST, createApiApp, startApi } from "../../../src/main";
import { startWorker, WORKER_HEALTH_HOST, WorkerHealthServer } from "../../../src/worker";
import { createTestJwtKeyFile } from "../../support/jwt-key";

const API_PORT = 3100;
const WORKER_PORT = 3101;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LogLine = Record<string, unknown>;

/** A pino destination that keeps the parsed lines. */
class LogSink {
  readonly lines: LogLine[] = [];

  write(line: string): void {
    this.lines.push(JSON.parse(line) as LogLine);
  }

  withMessage(msg: string): LogLine[] {
    return this.lines.filter((line) => line["msg"] === msg);
  }
}

interface Answer {
  readonly status: number;
  readonly headers: { get(name: string): string | undefined };
  readonly body: unknown;
}

/**
 * GET over a new connection each time (no keep-alive pool): the tests stop and start servers on the same ports, and
 * a pooled connection to a closed server would fail the next request.
 */
function get(url: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: { get: (name) => res.headers[name.toLowerCase()]?.toString() },
          body: text === "" ? undefined : (JSON.parse(text) as unknown),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** DATABASE_URL and REDIS_URL of the environment (CI services, or the root and app `.env.local` files locally). */
function services(): { DATABASE_URL: string; REDIS_URL: string } {
  loadDevEnvFiles({ appDir: resolve(__dirname, "..", "..", "..") });
  return defineConfig({
    DATABASE_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
    REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
  });
}

/** A loopback port that nothing listens on: bound once by the OS, then released. */
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function withPort(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.port = String(port);
  return parsed.toString();
}

let DATABASE_URL: string;
let REDIS_URL: string;
let UNREACHABLE_DATABASE_URL: string;
let UNREACHABLE_REDIS_URL: string;

/** Everything a test started, closed after it even when it fails. */
const running: Array<{ close(): Promise<void> }> = [];

beforeAll(async () => {
  ({ DATABASE_URL, REDIS_URL } = services());
  UNREACHABLE_DATABASE_URL = withPort(DATABASE_URL, await closedPort());
  UNREACHABLE_REDIS_URL = withPort(REDIS_URL, await closedPort());
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

/** The development PLATFORM_BFF_KEY of platform/backend/.env.example (a dummy value). */
const PLATFORM_BFF_KEY = "dev_bff_key_change_me_0123456789abcdef";

/** The JWT signing key of the processes: a fresh key file of mode 0600 in a temporary folder. */
const jwtKey = createTestJwtKeyFile();

afterAll(() => {
  jwtKey.remove();
});

/** The environment of a process: the services, APP_ENV=test, the key file and the default ports of the units. */
function processEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: "test",
    DATABASE_URL,
    REDIS_URL,
    PLATFORM_BFF_KEY,
    JWT_PRIVATE_KEY_FILE: jwtKey.path,
    ...overrides,
  };
}

async function api(
  overrides: Record<string, string> = {},
): Promise<{ app: NestExpressApplication; logs: LogSink }> {
  const logs = new LogSink();
  const app = await startApi({ env: processEnv(overrides), logDestination: logs });
  if (app === undefined) {
    throw new Error(`startApi failed: ${JSON.stringify(logs.lines)}`);
  }
  running.push(app);
  return { app, logs };
}

async function worker(
  overrides: Record<string, string> = {},
): Promise<{ app: INestApplicationContext; url: string; logs: LogSink }> {
  const logs = new LogSink();
  const app = await startWorker({ env: processEnv(overrides), logDestination: logs });
  if (app === undefined) {
    throw new Error(`startWorker failed: ${JSON.stringify(logs.lines)}`);
  }
  running.push(app);
  return { app, url: app.get(WorkerHealthServer).url, logs };
}

describe("the API's health routes", () => {
  it("[PBE-001 AC2] answer 200 on 127.0.0.1:3100 with PostgreSQL and Redis running", async () => {
    const { app } = await api();
    const base = `http://${API_HOST}:${API_PORT}`;

    expect(app.getHttpServer().address()).toMatchObject({ address: "127.0.0.1", port: API_PORT });
    const live = await get(`${base}/health/live`);
    const ready = await get(`${base}/health/ready`);

    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: "ok" });
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok" } });
    expect(ready.headers.get("cache-control")).toBe("no-store");
  });

  it("[PBE-001 AC2] /health/ready answers 503 naming redis when Redis is unreachable", async () => {
    const { logs } = await api({ REDIS_URL: UNREACHABLE_REDIS_URL });

    const ready = await get(`http://${API_HOST}:${API_PORT}/health/ready`);

    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: "unavailable", checks: { postgres: "ok", redis: "down" } });
    // The cause is logged with the request's id, never answered.
    expect(logs.withMessage("health.dependency_down")).toEqual([
      expect.objectContaining({
        level: 40,
        app: "platform-api",
        dependency: "redis",
        requestId: ready.headers.get("x-request-id"),
        err: expect.objectContaining({ type: expect.any(String) }),
      }),
    ]);
  });

  it("/health/ready answers 503 naming postgres when PostgreSQL is unreachable", async () => {
    await api({ DATABASE_URL: UNREACHABLE_DATABASE_URL });

    const ready = await get(`http://${API_HOST}:${API_PORT}/health/ready`);

    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: "unavailable", checks: { postgres: "down", redis: "ok" } });
  });

  it("/health/live answers 200 while a dependency is down, and health requests write no request line", async () => {
    const { logs } = await api({ REDIS_URL: UNREACHABLE_REDIS_URL });

    const live = await get(`http://${API_HOST}:${API_PORT}/health/live`);

    expect(live.status).toBe(200);
    expect(logs.withMessage("request completed")).toEqual([]);
  });

  it("logs api.start_failed and starts nothing when the port is in use", async () => {
    const blocker: Server = createHttpServer();
    await new Promise<void>((done) => blocker.listen(API_PORT, API_HOST, done));
    try {
      const logs = new LogSink();
      const disconnect = vi.spyOn(Redis.prototype, "disconnect");
      const app = await startApi({ env: processEnv(), logDestination: logs });

      expect(app).toBeUndefined();
      expect(logs.withMessage("api.start_failed")).toEqual([
        expect.objectContaining({ level: 60, err: expect.objectContaining({ code: "EADDRINUSE" }) }),
      ]);
      // The application was closed again: the shutdown hook that ends the pool also disconnected the Redis client,
      // which would otherwise keep the process alive reconnecting.
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });
});

describe("the worker's health server", () => {
  it("[PBE-001 AC2] answers 200 on 127.0.0.1:3101 with PostgreSQL and Redis running", async () => {
    const { url } = await worker();

    expect(url).toBe(`http://${WORKER_HEALTH_HOST}:${WORKER_PORT}`);
    const live = await get(`${url}/health/live`);
    const ready = await get(`${url}/health/ready`);

    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: "ok" });
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok" } });
    expect(ready.headers.get("cache-control")).toBe("no-store");
  });

  it("[PBE-001 AC2] /health/ready answers 503 naming redis when Redis is unreachable", async () => {
    const { url, logs } = await worker({ REDIS_URL: UNREACHABLE_REDIS_URL });

    const ready = await get(`${url}/health/ready`);

    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: "unavailable", checks: { postgres: "ok", redis: "down" } });
    expect(logs.withMessage("health.dependency_down")).toEqual([
      expect.objectContaining({
        app: "platform-worker",
        dependency: "redis",
        requestId: ready.headers.get("x-request-id"),
      }),
    ]);
  });

  it("answers any other path with the error envelope, and logs that request with its requestId", async () => {
    const { url, logs } = await worker();

    const answer = await get(`${url}/v1/anything`, { "X-Request-Id": "worker-probe-0001" });

    expect(answer.status).toBe(404);
    expect(answer.headers.get("x-request-id")).toBe("worker-probe-0001");
    expect(answer.body).toMatchObject({
      error: { code: "NOT_FOUND", status: 404, requestId: "worker-probe-0001" },
    });
    expect(logs.withMessage("request completed")).toEqual([
      expect.objectContaining({ requestId: "worker-probe-0001", route: "/v1/anything", status: 404 }),
    ]);
  });

  it("logs worker.start_failed and keeps nothing open when the port is in use", async () => {
    const blocker: Server = createHttpServer();
    await new Promise<void>((done) => blocker.listen(WORKER_PORT, WORKER_HEALTH_HOST, done));
    try {
      const logs = new LogSink();
      const disconnect = vi.spyOn(Redis.prototype, "disconnect");
      const app = await startWorker({ env: processEnv(), logDestination: logs });

      expect(app).toBeUndefined();
      expect(logs.withMessage("worker.start_failed")).toEqual([
        expect.objectContaining({ level: 60, err: expect.objectContaining({ code: "EADDRINUSE" }) }),
      ]);
      // The context was closed again: the shutdown hook that ends the pool also disconnected the Redis client.
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  it("stops listening when the context closes", async () => {
    const { app, url } = await worker();
    running.splice(running.indexOf(app), 1);

    await app.close();

    await expect(get(`${url}/health/live`)).rejects.toThrow(/ECONNREFUSED/);
  });
});

/** A route that shows the request context, for the tests below only. */
@Controller("test")
class RequestContextController {
  constructor(
    private readonly cls: ClsService,
    @InjectPinoLogger(RequestContextController.name) private readonly logger: PinoLogger,
  ) {}

  @Get("context")
  context(@Req() req: { ip?: string }): { requestId: string; ip: string | undefined } {
    this.logger.info({ step: "inside" }, "test.event");
    return { requestId: this.cls.getId(), ip: req.ip };
  }

  @Get("fail")
  fail(): never {
    this.logger.info({ step: "inside" }, "test.failing");
    throw new Error("test failure");
  }
}

describe("the API's request context and request log lines", () => {
  let base: string;
  let logs: LogSink;

  beforeAll(async () => {
    const config = parseConfig(processEnv());
    logs = new LogSink();
    const logger = createProcessLogger(PLATFORM_PROCESSES.api, config, logs);

    @Module({})
    class TestRootModule {
      static forRoot(): DynamicModule {
        return {
          module: TestRootModule,
          imports: [AppModule.forRoot(config, logger)],
          controllers: [RequestContextController],
        };
      }
    }

    const app = await createApiApp(config, TestRootModule.forRoot());
    await app.listen(0, API_HOST);
    base = `http://${API_HOST}:${(app.getHttpServer().address() as AddressInfo).port}`;
    // Closed by afterAll, not afterEach: every test of this group uses the same application.
    return () => app.close();
  });

  it("[PBE-001 AC4] uses a valid X-Request-Id as the request id of the context, the log lines and the response", async () => {
    logs.lines.length = 0;

    const answer = await get(`${base}/test/context`, { "X-Request-Id": "req-test-0001" });

    expect(answer.headers.get("x-request-id")).toBe("req-test-0001");
    expect(answer.body).toMatchObject({ requestId: "req-test-0001" });
    expect(logs.lines.map((line) => line["msg"])).toEqual(["test.event", "request completed"]);
    for (const line of logs.lines) {
      expect(line).toMatchObject({ app: "platform-api", requestId: "req-test-0001" });
    }
  });

  it("[PBE-001 AC4] generates one id when there is no X-Request-Id, and every line carries it", async () => {
    logs.lines.length = 0;

    const answer = await get(`${base}/test/context`);
    const requestId = answer.headers.get("x-request-id");

    expect(requestId).toMatch(UUID);
    expect(answer.body).toMatchObject({ requestId });
    expect(logs.lines).toHaveLength(2);
    for (const line of logs.lines) {
      expect(line["requestId"]).toBe(requestId);
    }
  });

  it("[PBE-001 AC4] replaces an invalid X-Request-Id", async () => {
    logs.lines.length = 0;

    const answer = await get(`${base}/test/context`, { "X-Request-Id": "<script>" });
    const requestId = answer.headers.get("x-request-id");

    expect(requestId).toMatch(UUID);
    expect(answer.body).toMatchObject({ requestId });
    expect(JSON.stringify(logs.lines)).not.toContain("<script>");
  });

  it("[PBE-001 AC4] logs an unknown route with its requestId and without the query string", async () => {
    logs.lines.length = 0;

    const answer = await get(`${base}/nowhere?token=secret-value-1`, { "X-Request-Id": "req-test-0404" });

    expect(answer.status).toBe(404);
    expect(logs.lines).toEqual([
      expect.objectContaining({ msg: "request completed", requestId: "req-test-0404", status: 404 }),
    ]);
    expect(JSON.stringify(logs.lines)).not.toContain("secret-value-1");
  });

  it("[PBE-001 AC4] keeps the request ids of concurrent requests apart", async () => {
    logs.lines.length = 0;
    const ids = Array.from({ length: 10 }, (_, index) => `req-concurrent-${String(index).padStart(2, "0")}`);

    const answers = await Promise.all(ids.map((id) => get(`${base}/test/context`, { "X-Request-Id": id })));

    expect(answers.map((answer) => (answer.body as { requestId: string }).requestId)).toEqual(ids);
    expect(logs.lines).toHaveLength(20);
    for (const id of ids) {
      expect(
        logs.lines
          .filter((line) => line["requestId"] === id)
          .map((line) => line["msg"])
          .sort(),
      ).toEqual(["request completed", "test.event"]);
    }
  });

  it("takes the client IP from X-Forwarded-For when the peer is loopback (TRUST_PROXY=loopback)", async () => {
    const answer = await get(`${base}/test/context`, { "X-Forwarded-For": "203.0.113.7" });

    expect(answer.body).toMatchObject({ ip: "203.0.113.7" });
  });

  it("ignores X-Forwarded-For from a peer outside TRUST_PROXY", async () => {
    const config = parseConfig(processEnv({ TRUST_PROXY: "10.0.0.0/8" }));
    const logger = createProcessLogger(PLATFORM_PROCESSES.api, config, new LogSink());

    @Module({})
    class UntrustedRootModule {
      static forRoot(): DynamicModule {
        return {
          module: UntrustedRootModule,
          imports: [AppModule.forRoot(config, logger)],
          controllers: [RequestContextController],
        };
      }
    }

    const app = await createApiApp(config, UntrustedRootModule.forRoot());
    running.push(app);
    await app.listen(0, API_HOST);
    const port = (app.getHttpServer().address() as AddressInfo).port;

    const answer = await get(`http://${API_HOST}:${port}/test/context`, { "X-Forwarded-For": "203.0.113.7" });

    expect(answer.body).toMatchObject({ ip: "127.0.0.1" });
  });

  it("[PBE-001 AC4] logs every line of a failed request with its requestId, Nest's error line included", async () => {
    const config = parseConfig(processEnv());
    const sink = new LogSink();
    const logger = createProcessLogger(PLATFORM_PROCESSES.api, config, sink);

    @Module({})
    class FailingRootModule {
      static forRoot(): DynamicModule {
        return {
          module: FailingRootModule,
          imports: [AppModule.forRoot(config, logger)],
          controllers: [RequestContextController],
        };
      }
    }

    // init() and the HTTP server's own listen(), as request tests drive an application (Supertest): Nest's lines
    // must not wait in its start-up buffer for a listen() that never comes.
    const app = await createApiApp(config, FailingRootModule.forRoot());
    running.push(app);
    await app.init();
    const server: Server = app.getHttpServer();
    await new Promise<void>((done) => server.listen(0, API_HOST, done));
    const before = sink.lines.length;

    const answer = await get(`http://${API_HOST}:${(server.address() as AddressInfo).port}/test/fail`, {
      "X-Request-Id": "req-test-0500",
    });
    const lines = await vi.waitFor(() => {
      const logged = sink.lines.slice(before);
      expect(logged.map((line) => line["msg"])).toContain("request errored");
      return logged;
    });

    expect(answer.status).toBe(500);
    // Since PBE-008 the error filter logs the unknown error (with its stack) instead of Nest's ExceptionsHandler.
    expect(lines.map((line) => line["msg"])).toEqual([
      "test.failing",
      "http.unhandled_error",
      "request errored",
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({ app: "platform-api", requestId: "req-test-0500" });
    }
    expect(lines[1]).toMatchObject({
      level: 50,
      context: "ErrorFilter",
      err: expect.objectContaining({
        message: "test failure",
        stack: expect.stringContaining("test failure"),
      }),
    });
    expect(answer.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected error; quote the requestId to support.",
        status: 500,
        requestId: "req-test-0500",
      },
    });
    expect(lines[2]).toMatchObject({ level: 50, method: "GET", route: "/test/fail", status: 500 });
  });
});
