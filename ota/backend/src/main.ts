// dist/main.js: the OTA booking API (unit velexis-ota-api, 127.0.0.1:4000). Caddy proxies api.ota.example.com and
// every storefront's /api/* to it; nothing else may reach it, so it binds the loopback interface only.
//
// Start-up: validate the configuration (a ConfigError names every bad variable and the process exits 1), build the
// module graph (which parses the OpenAPI document and compiles its request schemas), listen. systemd's SIGTERM closes
// the application through Nest's shutdown hooks.
//
// The request pipeline (architecture §3; src/common/http/): `trust proxy` from TRUST_PROXY (`loopback`: Caddy),
// helmet, cookie-parser, the raw body on /webhooks/*, JSON bodies up to 256 KB elsewhere and up to the limits of
// JSON_BODY_LIMITS below on their routes, OpenAPI validation, the error envelope, and 501 for pending operations.
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { EnvSource } from "@velexis/config";
import { createLogger } from "@velexis/logger";
import type { DestinationStream } from "pino";
import { AppModule, createApiApp, createApiLogger } from "./app.module";
import type { JsonBodyLimits } from "./common/http/body-parsers";
import { API_APP, loadApiConfig, type ApiConfig } from "./config";

/** The interface the API listens on. Never a public address: Caddy is the only client. */
export const API_HOST = "127.0.0.1";

/** The JSON body limit of checkout.completeWithAirlineCard (OADR-0004 point 2): a card and a few ids fit easily. */
export const AIRLINE_CARD_BODY_LIMIT_BYTES = 10 * 1024;

/**
 * The per-route JSON body limits in bytes, by operation, where a route needs less than the 256 KB default
 * (architecture §3, step 2): the 10 KB of the airline-card completion route (OBE-051).
 */
export const JSON_BODY_LIMITS: JsonBodyLimits = Object.freeze({
  completeCheckoutWithAirlineCard: AIRLINE_CARD_BODY_LIMIT_BYTES,
});

export interface StartApiOptions {
  /** The variables to validate instead of the process environment (tests). No `.env.local` file is read then. */
  readonly env?: EnvSource;
  /** Where log lines go instead of stdout (tests). */
  readonly logDestination?: DestinationStream;
}

/**
 * Starts the API on `127.0.0.1:PORT`. Resolves to the listening application, or to `undefined` after logging why it
 * could not start: an invalid configuration (`api.config_invalid` with the `ConfigError`, which names variables and
 * never values) or a failure while building the module graph or binding the port (`api.start_failed`).
 */
export async function startApi(options: StartApiOptions = {}): Promise<NestExpressApplication | undefined> {
  let config: ApiConfig;
  try {
    config = loadApiConfig(options.env);
  } catch (error) {
    // LOG_LEVEL and APP_ENV are not validated yet: a fatal line always passes, and `env` is unknown.
    createLogger({ app: API_APP, env: "unknown", destination: options.logDestination }).fatal(
      { err: error },
      "api.config_invalid",
    );
    return undefined;
  }

  const logger = createApiLogger(config, options.logDestination);
  let app: NestExpressApplication | undefined;
  try {
    app = await createApiApp(config, AppModule.forRoot(config, { logger, jsonBodyLimits: JSON_BODY_LIMITS }));
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
      // Pending log lines are flushed on exit; nothing else may keep a half-started process alive.
      process.exit(1);
    }
  });
}
