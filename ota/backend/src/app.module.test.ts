// The API's request pipeline, in process (no PostgreSQL or Redis: the health probes connect on the first readiness
// check only, and the vx:invalidate subscriber tries a Redis where nothing listens). A probe controller stands in for
// the business routes that later tasks add.
import { Body, Controller, Get, Module, Post, Req, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ClsService } from "nestjs-cls";
import { PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

const apps: INestApplication[] = [];

// The applications the tests start reuse the OTA document, parsed and compiled once, here (test/helpers/openapi.ts).
beforeAll(preloadOpenApiDocument, OPENAPI_SETUP_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function startApp(env: Record<string, string> = {}): Promise<{
  app: INestApplication;
  sink: MemorySink;
  config: ApiConfig;
}> {
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
  it("logs one request line and every handler line with the requestId it returns in X-Request-Id [OBE-001 AC4]", async () => {
    const { app, sink } = await startApp();
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
    const { app, sink } = await startApp();

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
    const { app } = await startApp();

    for (const header of [undefined, "caddy-req-0002", "bad id!"]) {
      const call = request(app.getHttpServer()).get("/v1/probe");
      const response = await (header === undefined ? call : call.set("X-Request-Id", header));
      expect((response.body as { clsId: string }).clsId).toBe(response.headers["x-request-id"]);
    }
  });

  it("logs unmatched routes with their requestId and never logs bodies or credential headers [OBE-001 AC4]", async () => {
    const { app, sink } = await startApp();
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
    const { app, sink } = await startApp();
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
    const { app, sink } = await startApp();
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
  it("believes X-Forwarded-For from loopback proxies only (TRUST_PROXY=loopback by default)", async () => {
    const { app } = await startApp();

    const response = await request(app.getHttpServer())
      .get("/v1/probe")
      .set("X-Forwarded-For", "203.0.113.7");

    expect((response.body as { ip: string }).ip).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For when the connecting address is not a trusted proxy", async () => {
    const { app } = await startApp({ TRUST_PROXY: "10.0.0.0/8" });

    const response = await request(app.getHttpServer())
      .get("/v1/probe")
      .set("X-Forwarded-For", "203.0.113.7");

    expect((response.body as { ip: string }).ip).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
  });

  it("sends no X-Powered-By header", async () => {
    const { app } = await startApp();

    const response = await request(app.getHttpServer()).get("/health/live");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("module graph", () => {
  it("answers from the validated configuration only, never from process.env [OBE-001 AC3]", async () => {
    // The worker's and the deploy's DSNs set in the API's environment stay invisible to it.
    vi.stubEnv("DATABASE_PROVISIONER_URL", "postgres://velexis_provisioner:dummy@127.0.0.1:5432/velexis");
    vi.stubEnv("DATABASE_MIGRATOR_URL", "postgres://velexis_migrator:dummy@127.0.0.1:5432/velexis");
    const { app, config } = await startApp();
    const configService = app.get(ConfigService);

    expect(configService.get("DATABASE_PROVISIONER_URL")).toBeUndefined();
    expect(configService.get("DATABASE_MIGRATOR_URL")).toBeUndefined();
    expect(configService.get("DATABASE_URL")).toBe(config.DATABASE_URL);
    expect(configService.get("PORT")).toBe(4000);
  });

  it("provides Clock and IdGenerator to every module", async () => {
    const { app } = await startApp();

    expect(app.get(Clock).now()).toBeInstanceOf(Date);
    expect(app.get(IdGenerator).newId("bkg")).toMatch(/^bkg_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
