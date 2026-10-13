// dist/worker.js: the OTA worker (unit velexis-ota-worker). A Nest application context without an HTTP adapter, plus a
// node:http server for /health/live and /health/ready on 127.0.0.1:HEALTH_PORT (4001). BullMQ processors and
// schedulers join WorkerModule in later tasks; the API never runs them (README §4).
import type { AddressInfo } from "node:net";
import type { INestApplicationContext } from "@nestjs/common";
import type { EnvSource } from "@velexis/config";
import { createLogger } from "@velexis/logger";
import type { DestinationStream } from "pino";
import { loadWorkerConfig, WORKER_APP, type WorkerConfig } from "./config";
import { HealthServer } from "./health/health.controller";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "./worker.module";

/** The interface of the health port. The on-VM checks and deploy.sh are local. */
export const WORKER_HOST = "127.0.0.1";

export interface StartWorkerOptions {
  /** The variables to validate instead of the process environment (tests). No `.env.local` file is read then. */
  readonly env?: EnvSource;
  /** Where log lines go instead of stdout (tests). */
  readonly logDestination?: DestinationStream;
}

export interface RunningWorker {
  readonly app: INestApplicationContext;
  /** The bound address of the health port. */
  readonly health: AddressInfo;
}

/**
 * Starts the worker and its health port. Resolves to the running worker, or to `undefined` after logging why it could
 * not start: an invalid configuration (`worker.config_invalid`, the `ConfigError` names variables, never values) or a
 * failure while building the module graph or binding HEALTH_PORT (`worker.start_failed`).
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<RunningWorker | undefined> {
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(options.env);
  } catch (error) {
    createLogger({ app: WORKER_APP, env: "unknown", destination: options.logDestination }).fatal(
      { err: error },
      "worker.config_invalid",
    );
    return undefined;
  }

  const logger = createWorkerLogger(config, options.logDestination);
  let app: INestApplicationContext | undefined;
  try {
    app = await createWorkerApp(WorkerModule.forRoot(config, { logger }));
    const health = await app.get(HealthServer).listen(config.HEALTH_PORT, WORKER_HOST);
    logger.info({ host: WORKER_HOST, port: health.port }, "worker.health_listening");
    return { app, health };
  } catch (error) {
    logger.fatal({ err: error }, "worker.start_failed");
    await app?.close().catch(() => undefined);
    return undefined;
  }
}

if (require.main === module) {
  void startWorker().then((worker) => {
    if (worker === undefined) {
      // Pending log lines are flushed on exit; nothing else may keep a half-started process alive.
      process.exit(1);
    }
  });
}
