// dist/worker.js: the platform worker (unit velexis-platform-worker). It runs no HTTP API (ADR-0003): a Nest
// application context for queues and schedules (later tasks), plus a small node:http server on
// 127.0.0.1:HEALTH_PORT (3101) that answers /health/live and /health/ready for deploy.sh and the on-VM checks.
//
// Start-up: validate the configuration (a ConfigError names every bad variable, and the process exits 1), build the
// context, start the health server. systemd's SIGTERM closes the context, the health server included, through
// Nest's shutdown hooks.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type INestApplicationContext,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppError, toErrorEnvelope } from "@velexis/errors";
import { pinoHttpOptions, type Logger } from "@velexis/logger";
import { Logger as NestPinoLogger } from "nestjs-pino";
import { pinoHttp, type HttpLogger } from "pino-http";
import {
  createProcessLogger,
  loadConfigOrReport,
  PLATFORM_PROCESSES,
  type PlatformBackendConfig,
  type StartOptions,
} from "./config";
import { HealthService } from "./health/health.service";
import { WorkerModule } from "./worker.module";

/** The interface the health server listens on: only local checks reach it. */
export const WORKER_HEALTH_HOST = "127.0.0.1";

const LIVE_PATH = "/health/live";
const READY_PATH = "/health/ready";

interface HealthServerOptions {
  readonly port: number;
  readonly logger: Logger;
}

const HEALTH_SERVER_OPTIONS = Symbol("HEALTH_SERVER_OPTIONS");

/** The request path without its query string and without one trailing slash (as Express routes it). */
function pathOf(url: string | undefined): string {
  const path = (url ?? "/").split(/[?#]/, 1)[0] ?? "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : payload);
}

/** The error envelope of both APIs (@velexis/errors), with the request id that pino-http set. */
function sendError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  const { status, body } = toErrorEnvelope(error, String(req.id), { exposeSupplier: false });
  sendJson(req, res, status, body);
}

/**
 * Answers one request of the health server: `GET`/`HEAD` of `/health/live` and `/health/ready` as the API answers
 * them, the error envelope with `404 NOT_FOUND` for anything else. pino-http has already run: `req.id` and
 * `X-Request-Id` are set, `req.log` carries the requestId, and paths other than /health/* get one request line.
 */
async function answer(health: HealthService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req.url);
  const readable = req.method === "GET" || req.method === "HEAD";
  if (readable && path === LIVE_PATH) {
    sendJson(req, res, 200, health.live());
  } else if (readable && path === READY_PATH) {
    const { report, failures } = await health.ready();
    for (const { dependency, error } of failures) {
      req.log.warn({ dependency, err: error }, "health.dependency_down");
    }
    sendJson(req, res, report.status === "ok" ? 200 : 503, report);
  } else {
    sendError(
      req,
      res,
      new AppError("NOT_FOUND", { message: "The worker serves /health/live and /health/ready only." }),
    );
  }
}

/** The worker's health server: `startWorker` starts it once the context is built; it stops with the context. */
@Injectable()
export class WorkerHealthServer implements OnApplicationShutdown {
  private readonly server: Server;

  constructor(
    private readonly health: HealthService,
    @Inject(HEALTH_SERVER_OPTIONS) private readonly options: HealthServerOptions,
  ) {
    const httpLogger: HttpLogger = pinoHttp(
      pinoHttpOptions({ app: PLATFORM_PROCESSES.worker, logger: options.logger }),
    );
    this.server = createServer((req, res) => {
      httpLogger(req, res);
      answer(this.health, req, res).catch((error: unknown) => {
        req.log.error({ err: error }, "health.request_failed");
        if (!res.headersSent) {
          sendError(req, res, error);
        }
      });
    });
  }

  /** `http://127.0.0.1:<port>` of the bound port, once listening. */
  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://${WORKER_HEALTH_HOST}:${port}`;
  }

  /** Listens on `127.0.0.1:HEALTH_PORT`; rejects when the port is in use. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, WORKER_HEALTH_HOST, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  onApplicationShutdown(): Promise<void> {
    if (!this.server.listening) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
      this.server.closeIdleConnections();
    });
  }
}

/** The worker process: WorkerModule plus its health server. */
@Module({})
class WorkerProcessModule {
  static forRoot(config: PlatformBackendConfig, logger: Logger): DynamicModule {
    return {
      module: WorkerProcessModule,
      imports: [WorkerModule.forRoot(config, logger)],
      providers: [
        { provide: HEALTH_SERVER_OPTIONS, useValue: { port: config.HEALTH_PORT, logger } },
        WorkerHealthServer,
      ],
    };
  }
}

/**
 * Starts the worker: the application context, then its health server on `127.0.0.1:HEALTH_PORT`. Resolves to the
 * running context, or to `undefined` after logging why it could not start: an invalid configuration
 * (`config.invalid`) or a failure while building the context or binding the port (`worker.start_failed`; the
 * context is closed again, so no connection stays open).
 */
export async function startWorker(options: StartOptions = {}): Promise<INestApplicationContext | undefined> {
  const config = loadConfigOrReport(PLATFORM_PROCESSES.worker, options);
  if (config === undefined) {
    return undefined;
  }
  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, config, options.logDestination);
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(WorkerProcessModule.forRoot(config, logger), {
      bufferLogs: true,
      // Errors while the context is built reach this function, which logs them and exits non-zero.
      abortOnError: false,
    });
    app.useLogger(app.get(NestPinoLogger));
    app.enableShutdownHooks();
    const health = app.get(WorkerHealthServer);
    await health.listen();
    logger.info({ health: health.url }, "worker.started");
    return app;
  } catch (error) {
    logger.fatal({ err: error }, "worker.start_failed");
    await app?.close().catch(() => undefined);
    return undefined;
  }
}

if (require.main === module) {
  void startWorker().then((app) => {
    if (app === undefined) {
      // pino flushes on exit; nothing half-started (a Redis client reconnecting) may keep the process alive.
      process.exit(1);
    }
  });
}
