// dist/main.js: the platform API (unit velexis-platform-api, 127.0.0.1:3100). Caddy proxies
// api.platform.example.com to it, and the portal and admin servers call it on loopback; nothing else may reach it, so
// it binds the loopback interface only (platform/docs/architecture.md §1).
//
// Start-up: validate the configuration (a ConfigError names every bad variable, and the process exits 1), build the
// module graph, listen. systemd's SIGTERM closes the application through Nest's shutdown hooks.
import { type DynamicModule, type NestApplicationOptions, type Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Logger as NestPinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module";
import {
  createProcessLogger,
  loadConfigOrReport,
  PLATFORM_PROCESSES,
  type PlatformBackendConfig,
  type StartOptions,
} from "./config";

/** The interface the API listens on. Never a public address: Caddy is the only public entry. */
export const API_HOST = "127.0.0.1";

/**
 * The options of the API application (also of the test application, test/support/app.ts). Nest's body parser is
 * off: CommonModule's JSON parser runs after pino-http and keeps the raw body on `/webhooks/*` only (raw-body.ts).
 */
export const API_APP_OPTIONS = Object.freeze({
  bufferLogs: true,
  // Errors while the module graph is built reach the caller, which logs them and exits non-zero.
  abortOnError: false,
  bodyParser: false,
} satisfies NestApplicationOptions);

/**
 * Sets up a created API application (platform/docs/architecture.md §3, step 1): nestjs-pino as the Nest logger,
 * Express `trust proxy` from TRUST_PROXY (client IPs from Caddy's `X-Forwarded-For`), no `X-Powered-By`, `helmet`'s
 * security headers and `cookie-parser` before every other middleware, and shutdown hooks (SIGTERM from systemd
 * closes the pool and the Redis client). The API sets no cookies; the Next.js apps do.
 */
export function configureApiApp(
  app: NestExpressApplication,
  config: PlatformBackendConfig,
): NestExpressApplication {
  app.useLogger(app.get(NestPinoLogger));
  // An HTTP application keeps Nest's own lines in the start-up buffer until listen() succeeds. Flush it now, so they
  // reach pino from here on (the exception handler's error line of a failed request included) also when listen()
  // fails or when a test only runs init() and drives the HTTP server itself.
  app.flushLogs();
  app.set("trust proxy", [...config.TRUST_PROXY]);
  app.disable("x-powered-by");
  // Registered before init(), so they run before the module middleware (pino-http, the body parser, the context).
  app.use(helmet());
  app.use(cookieParser());
  app.enableShutdownHooks();
  return app;
}

/**
 * Creates the API application, not yet listening (`configureApiApp`). `root` is `AppModule.forRoot(…)` or a test
 * module importing it.
 */
export async function createApiApp(
  config: PlatformBackendConfig,
  root: DynamicModule | Type,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(root, { ...API_APP_OPTIONS });
  return configureApiApp(app, config);
}

/**
 * Starts the API on `127.0.0.1:PORT`. Resolves to the listening application, or to `undefined` after logging why it
 * could not start: an invalid configuration (`config.invalid`) or a failure while building the module graph or
 * binding the port (`api.start_failed`).
 */
export async function startApi(options: StartOptions = {}): Promise<NestExpressApplication | undefined> {
  const config = loadConfigOrReport(PLATFORM_PROCESSES.api, options);
  if (config === undefined) {
    return undefined;
  }
  const logger = createProcessLogger(PLATFORM_PROCESSES.api, config, options.logDestination);
  let app: NestExpressApplication | undefined;
  try {
    app = await createApiApp(config, AppModule.forRoot(config, logger));
    await app.listen(config.PORT, API_HOST);
    logger.info({ host: API_HOST, port: config.PORT }, "api.listening");
    return app;
  } catch (error) {
    logger.fatal({ err: error }, "api.start_failed");
    await app?.close().catch(() => undefined);
    return undefined;
  }
}

if (require.main === module) {
  void startApi().then((app) => {
    if (app === undefined) {
      // pino flushes on exit; nothing half-started (a Redis client reconnecting) may keep the process alive.
      process.exit(1);
    }
  });
}
