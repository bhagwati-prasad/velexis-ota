// The services of the integration tests, read through @velexis/config like the app itself: the CI service containers
// (job environment), or locally the root and ota/backend `.env.local` files (docs/mvp/local-development.md).
// @velexis/testing (X-015) later replaces this with per-file databases.
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { APP_DIR } from "../../src/config";
import { testApiVariables, testWorkerVariables } from "../helpers/api-env";

export interface IntegrationEnv {
  /**
   * Variables for `startApi({ env })`: APP_ENV=test, the services and the API's caller credentials (the test
   * process's edge secret and pepper file, test/helpers/api-env.ts); PORT stays at its default (4000).
   */
  readonly api: Readonly<Record<string, string>>;
  /**
   * Variables for `startWorker({ env })`: the API's plus the provisioner DSN and the worker's e-mail settings
   * (OBE-030); HEALTH_PORT stays at 4001.
   */
  readonly worker: Readonly<Record<string, string>>;
}

export function integrationEnv(): IntegrationEnv {
  loadDevEnvFiles({ appDir: APP_DIR });
  const services = defineConfig({
    DATABASE_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
    REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
    DATABASE_PROVISIONER_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  });
  const api = {
    APP_ENV: "test",
    DATABASE_URL: services.DATABASE_URL,
    REDIS_URL: services.REDIS_URL,
    ...testApiVariables(),
  };
  return {
    api,
    worker: { ...api, ...testWorkerVariables(), DATABASE_PROVISIONER_URL: services.DATABASE_PROVISIONER_URL },
  };
}
