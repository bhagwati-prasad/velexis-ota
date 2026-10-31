// The API's request pipeline, in process (no PostgreSQL or Redis: the health probes connect on the first readiness
// check only, and the vx:invalidate subscriber tries a Redis where nothing listens). A probe controller stands in for
// the business routes that later tasks add.
//
// The applications start in setup hooks, never in a test's 5 s bound (the lead's test timing rule; FIX-W28-FOLLOWUPS):
// a test whose log lines are counted gets its own application (`appPerTest`, a beforeEach hook), the others share one
// per block (`appForBlock`, a beforeAll hook). They are closed together after the file: each close waits up to
// BULLMQ_STARTUP_SETTLE_MS (1 s) for the queues that cannot reach their Redis, which took about 1 s of every test while
// each test closed its own. The request-logging tests (lead decision (2j) of 2026-10-30, third batch, FIX-W36-OTA) keep an
// application each, but all of them start in the block's beforeAll hook and serve their first request there
// (`warmAppPerTest`, `warmUp`): a beforeEach hook's start counted in each test's reported time, and the first request
// of a fresh application (Express's and Nest's first routing, the first CLS context and pino-http line) in its body,
// 0.2 to 0.5 s idle per test and much more under load. The tests' assertions are unchanged.
import { Body, Controller, Get, Module, Post, Req, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ClsService } from "nestjs-cls";
import { PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testApiVariables } from "../test/helpers/api-env";
import { MemorySink, type LogLine } from "../test/helpers/log-sink";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../test/helpers/openapi";
import { unreachableRedisUrl } from "../test/helpers/ports";
import { AppModule, createApiApp, createApiLogger } from "./app.module";
import { PublicRoute } from "./common/auth/caller.guard";
import { Clock } from "./common/clock";
import { IdGenerator } from "./common/ids";
import { loadApiConfig, type ApiConfig } from "./config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Dummy values of the shape the VM uses; nothing here is a real secret, and nothing connects. REDIS_URL is
 * `unreachableRedisUrl()`, a new port for each application (`startApp`).
 */
const ENV = {
  APP_ENV: "test",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgres://velexis_ota_app:dummy@127.0.0.1:5432/velexis",
  ...testApiVariables(),
} as const;

// Public: these tests are about the request context and logging, which come before the caller guard; the guard
// itself is common/auth/caller.guard.test.ts.
@Controller("v1/probe")
@PublicRoute()
class ProbeController {
  constructor(
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {}

  @Get()
  get(@Req() req: { ip?: string }): { clsId: string; ip: string | undefined } {
    this.logger.info({ step: "handler" }, "probe.handled");
    return { clsId: this.cls.getId(), ip: req.ip };
  }

  @Post()
  post(@Body() _body: unknown): { ok: true } {
    this.logger.info("probe.posted");
    return { ok: true };
  }

  @Get("fail")
  fail(): never {
    this.logger.info("probe.failing");
    throw new Error("probe failure");
  }
}

/**
 * The budget of a hook that starts one application: the module graph on the preloaded document, about 0.1 s alone, a
 * few seconds while every package's tests run at once on a 4-CPU runner (2.3 s were measured inside a test before
 * FIX-W28-FOLLOWUPS). The budget only stops a start that hangs.
 */
const APP_START_TIMEOUT_MS = 30_000;

/**
 * The budget of a first request to a fresh application (`warmUp`) until its request line is in the sink: about 0.2 s
 * alone, a few seconds while every package's tests run at once on a 4-CPU runner. It only stops a request that hangs.
 */
const WARM_UP_TIMEOUT_MS = 15_000;

/**
 * The budget of the beforeAll hook that starts and warms the request-logging block's applications one after the other
 * (`warmAppPerTest`): about 0.3 s each alone, a few seconds each under load. It only stops a start that hangs.
 */
const WARM_APPS_TIMEOUT_MS = 90_000;

/**
 * The budget of the hook that closes every application of the file at once: each close waits up to
 * BULLMQ_STARTUP_SETTLE_MS (1 s) for its queues, which never reach the unreachable Redis, and they wait together.
 */
const APP_CLOSE_TIMEOUT_MS = 30_000;

/** An application the setup hooks started. */
interface StartedApp {
  readonly app: INestApplication;
  readonly sink: MemorySink;
  readonly config: ApiConfig;
}

const apps: INestApplication[] = [];

// The applications the tests start reuse the OTA document, parsed and compiled once, here (test/helpers/openapi.ts).
beforeAll(preloadOpenApiDocument, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
}, APP_CLOSE_TIMEOUT_MS);

/** The application a setup hook started, for the test that reads it. */
function started(current: StartedApp | undefined): StartedApp {
  if (current === undefined) {
    throw new Error("the setup hook started no application");
  }
  return current;
}

/**
 * Gives each test of the current block an application of its own, started in its beforeEach hook (after `prepare`,
 * which may stub the environment: Vitest unstubs it before each test's hooks), so no line of another test reaches its
 * sink. With `warm`, the hook also sends the application its first request (`warmUp`), whose lines are all in the sink
 * before the test starts counting.
 */
function appPerTest(env: Record<string, string> = {}, prepare?: () => void): () => StartedApp {
  let current: StartedApp | undefined;
  beforeEach(async () => {
    current = undefined;
    prepare?.();
    current = await startApp(env);
  }, APP_START_TIMEOUT_MS);
  return () => started(current);
}

/**
 * Gives each of the `count` tests of the current block an application of its own, as `appPerTest` does, but starts
 * them all, each with its first request served (`warmUp`), in the block's beforeAll hook; each test's beforeEach hook
 * only takes the next one. A test beyond `count` gets one started and warmed in its own beforeEach hook.
 */
function warmAppPerTest(count: number): () => StartedApp {
  const ready: StartedApp[] = [];
  let current: StartedApp | undefined;
  beforeAll(async () => {
    // One after the other, as the tests used to start them.
    for (let index = 0; index < count; index += 1) {
      ready.push(await warmStart());
    }
  }, WARM_APPS_TIMEOUT_MS);
  beforeEach(
    async () => {
      current = undefined;
      current = ready.shift() ?? (await warmStart());
    },
    // Only when the block has more tests than `count`: a start and a first request.
    APP_START_TIMEOUT_MS + WARM_UP_TIMEOUT_MS,
  );
  return () => started(current);
}

/** A started application that has served its first request (`warmUp`); only the setup hooks call it. */
async function warmStart(): Promise<StartedApp> {
  const app = await startApp();
  await warmUp(app);
  return app;
}

/**
 * The first request of a fresh application (see the file header): one probe request, then a wait until its request
 * line is in the sink, so every line of it lies before the lines a test counts (pino-http writes the request line when
 * the response finishes, which may come after supertest has the response).
 */
async function warmUp({ app, sink }: StartedApp): Promise<void> {
  const from = sink.lines.length;
  const response = await request(app.getHttpServer()).get("/v1/probe");
  expect(response.status).toBe(200);
  await vi.waitFor(
    () => {
      expect(
        sink
          .records()
          .slice(from)
          .filter((line) => line["msg"] === "request completed"),
      ).toHaveLength(1);
    },
    { timeout: WARM_UP_TIMEOUT_MS, interval: 20 },
  );
}

/** Gives the tests of the current block one application, started in its beforeAll hook. */
function appForBlock(env: Record<string, string> = {}): () => StartedApp {
  let current: StartedApp | undefined;
  beforeAll(async () => {
    current = await startApp(env);
  }, APP_START_TIMEOUT_MS);
  return () => started(current);
}

/** Starts an application with ENV and `env` (closed after the file); only the setup hooks call it. */
async function startApp(env: Record<string, string> = {}): Promise<StartedApp> {
  const config = loadApiConfig({ ...ENV, REDIS_URL: await unreachableRedisUrl(), ...env });
  const sink = new MemorySink();
  @Module({
    imports: [AppModule.forRoot(config, { logger: createApiLogger(config, sink) })],
    controllers: [ProbeController],
  })
  class ProbeRootModule {}
  const app = await createApiApp(config, ProbeRootModule);
  apps.push(app);
  await app.init();
  return { app, sink, config };
}

/** pino-http writes the request line when the response finishes, which may come after supertest has the response. */
async function requestLines(sink: MemorySink, from: number, count: number): Promise<LogLine[]> {
  return vi.waitFor(() => {
    const lines = sink
      .records()
      .slice(from)
      .filter((line) => line["msg"] === "request completed");
    expect(lines).toHaveLength(count);
    return sink.records().slice(from);
  });
}

describe("request id and request logging", () => {
  // Every test counts the log lines of its own requests: each has an application of its own, started and warmed with
  // the others in the block's beforeAll hook (one per test of the block).
  const current = warmAppPerTest(6);

  it("logs one request line and every handler line with the requestId it returns in X-Request-Id [OBE-001 AC4]", async () => {
    const { app, sink } = current();
    const before = sink.lines.length;

    const response = await request(app.getHttpServer()).get("/v1/probe?token=secret-query-value");
    const lines = await requestLines(sink, before, 1);

    const requestId = response.headers["x-request-id"];
    expect(requestId).toMatch(UUID);
    expect(lines.map((line) => line["msg"])).toEqual(["probe.handled", "request completed"]);
    for (const line of lines) {
      expect(line["requestId"]).toBe(requestId);
    }
    expect(lines[1]).toMatchObject({ app: "ota-api", method: "GET", route: "/v1/probe", status: 200 });
    expect(sink.lines.slice(before).join("\n")).not.toContain("secret-query-value");
  });

  it("keeps a valid incoming X-Request-Id and replaces an invalid one [OBE-001 AC4]", async () => {
    const { app, sink } = current();

    const before = sink.lines.length;
    const kept = await request(app.getHttpServer()).get("/v1/probe").set("X-Request-Id", "caddy-req-0001");
    const replaced = await request(app.getHttpServer()).get("/v1/probe").set("X-Request-Id", "bad id!");
    const lines = await requestLines(sink, before, 2);

    expect(kept.headers["x-request-id"]).toBe("caddy-req-0001");
    expect(replaced.headers["x-request-id"]).toMatch(UUID);
    const ids = lines.map((line) => line["requestId"]);
    expect(new Set(ids)).toEqual(new Set(["caddy-req-0001", replaced.headers["x-request-id"]]));
  });

  it("puts the same requestId into the request context (nestjs-cls) [OBE-001 AC4]", async () => {
    const { app } = current();

    for (const header of [undefined, "caddy-req-0002", "bad id!"]) {
      const call = request(app.getHttpServer()).get("/v1/probe");
      const response = await (header === undefined ? call : call.set("X-Request-Id", header));
      expect((response.body as { clsId: string }).clsId).toBe(response.headers["x-request-id"]);
    }
  });

  it("logs unmatched routes with their requestId and never logs bodies or credential headers [OBE-001 AC4]", async () => {
    const { app, sink } = current();
    const before = sink.lines.length;

    const missing = await request(app.getHttpServer()).get("/v1/unknown");
    const posted = await request(app.getHttpServer())
      .post("/v1/probe")
      .set("Authorization", "Bearer secret-bearer-value")
      .set("Cookie", "__Host-vx_session=secret-cookie-value")
      .send({ password: "secret-password-value", card: { number: "4111111111111111", cvc: "123" } });
    const lines = await requestLines(sink, before, 2);

    expect(missing.status).toBe(404);
    expect(posted.status).toBe(201);
    expect(lines.map((line) => line["msg"])).toEqual([
      "request completed",
      "probe.posted",
      "request completed",
    ]);
    for (const line of lines) {
      expect(line["requestId"]).toEqual(expect.any(String));
      expect(line).not.toHaveProperty("body");
      expect(line).not.toHaveProperty("req.headers");
    }
    const text = sink.lines.slice(before).join("\n");
    for (const secret of [
      "secret-bearer-value",
      "secret-cookie-value",
      "secret-password-value",
      "4111111111111111",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("logs every line of a failed request, Nest's error line included, with its requestId [OBE-001 AC4]", async () => {
    const { app, sink } = current();
    const before = sink.lines.length;

    const response = await request(app.getHttpServer()).get("/v1/probe/fail");
    const lines = await vi.waitFor(() => {
      const logged = sink.records().slice(before);
      expect(logged.map((line) => line["msg"])).toContain("request errored");
      return logged;
    });

    expect(response.status).toBe(500);
    const requestId = response.headers["x-request-id"];
    expect(requestId).toMatch(UUID);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line["requestId"]).toBe(requestId);
    }
    expect(lines).toContainEqual(expect.objectContaining({ msg: "probe.failing" }));
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, err: expect.objectContaining({ message: "probe failure" }) }),
    );
    expect(lines.at(-1)).toMatchObject({
      msg: "request errored",
      method: "GET",
      route: "/v1/probe/fail",
      status: 500,
    });
  });

  it("does not log the health endpoints", async () => {
    const { app, sink } = current();
    const before = sink.lines.length;

    const health = await request(app.getHttpServer()).get("/health/live");
    await request(app.getHttpServer()).get("/v1/probe");
    const lines = await requestLines(sink, before, 1);

    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(lines.filter((line) => line["msg"] === "request completed")).toEqual([
      expect.objectContaining({ route: "/v1/probe" }),
    ]);
  });
});

describe("HTTP settings", () => {
  // These tests read their own responses only: they share an application of the default settings.
  const defaults = appForBlock();

  it("believes X-Forwarded-For from loopback proxies only (TRUST_PROXY=loopback by default)", async () => {
    const { app } = defaults();

    const response = await request(app.getHttpServer())
      .get("/v1/probe")
      .set("X-Forwarded-For", "203.0.113.7");

    expect((response.body as { ip: string }).ip).toBe("203.0.113.7");
  });

  it("sends no X-Powered-By header", async () => {
    const { app } = defaults();

    const response = await request(app.getHttpServer()).get("/health/live");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  describe("with TRUST_PROXY=10.0.0.0/8", () => {
    const behindOtherProxy = appForBlock({ TRUST_PROXY: "10.0.0.0/8" });

    it("ignores X-Forwarded-For when the connecting address is not a trusted proxy", async () => {
      const { app } = behindOtherProxy();

      const response = await request(app.getHttpServer())
        .get("/v1/probe")
        .set("X-Forwarded-For", "203.0.113.7");

      expect((response.body as { ip: string }).ip).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
    });
  });
});

describe("module graph", () => {
  describe("with the worker's and the deploy's DSNs in process.env", () => {
    // The worker's and the deploy's DSNs set in the API's environment, from its start to the test's reads, stay
    // invisible to it.
    const current = appPerTest({}, () => {
      vi.stubEnv("DATABASE_PROVISIONER_URL", "postgres://velexis_provisioner:dummy@127.0.0.1:5432/velexis");
      vi.stubEnv("DATABASE_MIGRATOR_URL", "postgres://velexis_migrator:dummy@127.0.0.1:5432/velexis");
    });

    it("answers from the validated configuration only, never from process.env [OBE-001 AC3]", () => {
      const { app, config } = current();
      const configService = app.get(ConfigService);
      expect(configService.get("DATABASE_PROVISIONER_URL")).toBeUndefined();
      expect(configService.get("DATABASE_MIGRATOR_URL")).toBeUndefined();
      expect(configService.get("DATABASE_URL")).toBe(config.DATABASE_URL);
      expect(configService.get("PORT")).toBe(4000);
    });
  });

  const defaults = appForBlock();

  it("provides Clock and IdGenerator to every module", () => {
    const { app } = defaults();

    expect(app.get(Clock).now()).toBeInstanceOf(Date);
    expect(app.get(IdGenerator).newId("bkg")).toMatch(/^bkg_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
