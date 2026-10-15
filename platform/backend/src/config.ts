// The platform backend's configuration (README §3): one schema for the API (dist/main.js), the worker
// (dist/worker.js) and the CLI (dist/cli.js), validated by @velexis/config before anything else starts. A missing or
// invalid variable stops the process with one ConfigError that names every variable and never a value
// (conventions §8). Later tasks extend the schema.
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { DynamicModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import {
  ConfigError,
  defineConfig,
  env,
  loadDevEnvFiles,
  type ConfigOf,
  type ConfigProblem,
  type ConfigSchema,
  type EnvSource,
} from "@velexis/config";
import { createLogger, type Logger } from "@velexis/logger";
import type { DestinationStream } from "pino";

/** The `app` field of every log line, and the `application_name` of every database connection, per process. */
export const PLATFORM_PROCESSES = {
  api: "platform-api",
  worker: "platform-worker",
  cli: "platform-cli",
} as const;

export type PlatformProcess = (typeof PLATFORM_PROCESSES)[keyof typeof PLATFORM_PROCESSES];

/** The app folder (platform/backend): `src/` and `dist/` are one level down. Its `.env.local` wins over the root one. */
export const APP_DIR = resolve(__dirname, "..");

/** pino levels, as `@velexis/logger` accepts them. */
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/**
 * The names Express's `trust proxy` setting knows (`loopback` is 127.0.0.0/8 and ::1, where Caddy runs on the VM).
 * Each TRUST_PROXY item is one of them or an IP address with an optional prefix length.
 */
const TRUST_PROXY_NAMES = ["loopback", "linklocal", "uniquelocal"] as const;
const TRUST_PROXY_ITEM = /^(?:loopback|linklocal|uniquelocal|[0-9A-Fa-f.:]+(?:\/\d{1,3})?)$/;

/**
 * The first-party key of the portal and admin servers (PADR-0019): at least 32 characters of `[A-Za-z0-9_-]`, the
 * rule of the portal's and the admin's configuration (`provision-vm.sh` generates 64 hex characters). It refuses an
 * empty value and the unsubstituted `@@PLATFORM_BFF_KEY@@` placeholder of the deploy template.
 */
const BFF_KEY = /^[A-Za-z0-9_-]{32,}$/;

/**
 * The schema of every variable the platform backend reads (README §3, configuration matrix in
 * docs/mvp/architecture.md §6). Defaults exist only where they are safe in production (conventions §8).
 */
export const PLATFORM_BACKEND_CONFIG_SCHEMA = {
  APP_ENV: env.enum(["development", "test", "production"]),
  LOG_LEVEL: env.enum(LOG_LEVELS, { default: "info" }),
  /** API port on 127.0.0.1 (velexis-platform-api.service sets 3100). */
  PORT: env.port({ default: 3100 }),
  /** Worker health port on 127.0.0.1 (velexis-platform-worker.service sets 3101). */
  HEALTH_PORT: env.port({ default: 3101 }),
  /**
   * Express `trust proxy`: the peers whose `X-Forwarded-For` is believed, so client IPs come from Caddy. A
   * comma-separated list of `loopback`, `linklocal`, `uniquelocal` and IP addresses or subnets; never `true` or a
   * hop count, which would trust any peer.
   */
  TRUST_PROXY: env.list({ pattern: TRUST_PROXY_ITEM, default: ["loopback"] }),
  /** Role velexis_platform_app: DML on `platform` and `reference`, nothing on tenant schemas (ADR-0004). */
  DATABASE_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
  /**
   * The key the portal and admin servers send in `X-Velexis-Bff-Key` (PADR-0019): only a loopback request without
   * `X-Forwarded-For` that carries it (compared in constant time) may forward the end user's IP and user agent. The
   * API uses it; the worker and the CLI validate it too, because the three read `platform-backend.env`. A secret:
   * never logged.
   */
  PLATFORM_BFF_KEY: env.string({ pattern: BFF_KEY }),
} as const satisfies ConfigSchema;

export type PlatformBackendConfig = ConfigOf<typeof PLATFORM_BACKEND_CONFIG_SCHEMA>;

/** The values of `schema` when they are valid on their own; `undefined` when not (the full schema reports why). */
function validValues<S extends ConfigSchema>(
  schema: S,
  source: EnvSource | undefined,
): ConfigOf<S> | undefined {
  try {
    return defineConfig(schema, source);
  } catch (error) {
    if (error instanceof ConfigError) {
      return undefined;
    }
    throw error;
  }
}

/** True when `item` names an IP address, or a subnet with a prefix length the address family allows. */
function isAddressOrSubnet(item: string): boolean {
  const [address = "", prefix, ...rest] = item.split("/");
  const family = isIP(address);
  if (family === 0 || rest.length > 0) {
    return false;
  }
  return prefix === undefined || Number(prefix) <= (family === 4 ? 32 : 128);
}

/** The TRUST_PROXY rule that a pattern cannot express: every item that is not a name is a valid address or subnet. */
function trustProxyProblems(source: EnvSource | undefined): ConfigProblem[] {
  const items = validValues({ TRUST_PROXY: PLATFORM_BACKEND_CONFIG_SCHEMA.TRUST_PROXY }, source)?.TRUST_PROXY;
  const names: readonly string[] = TRUST_PROXY_NAMES;
  const invalid = (items ?? []).filter((item) => !names.includes(item) && !isAddressOrSubnet(item));
  return invalid.length === 0
    ? []
    : [
        {
          variable: "TRUST_PROXY",
          reason: `must list ${TRUST_PROXY_NAMES.join(", ")} or IP addresses with an optional prefix length`,
        },
      ];
}

/**
 * Validates the configuration in `source` (default: the process environment) and returns it deep-frozen. Throws one
 * `ConfigError` that names every invalid variable and the reason, never a value.
 */
export function parseConfig(source?: EnvSource): PlatformBackendConfig {
  const problems = trustProxyProblems(source);
  try {
    const config = defineConfig(PLATFORM_BACKEND_CONFIG_SCHEMA, source);
    if (problems.length === 0) {
      return config;
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    problems.unshift(...error.problems);
  }
  throw new ConfigError(problems);
}

/**
 * The configuration of this process. Without `source`, unset variables are first filled from
 * `platform/backend/.env.local`, then from the root `.env.local`; `loadDevEnvFiles` reads nothing when `APP_ENV` or
 * `NODE_ENV` is `production` (on the VM systemd provides the environment). With `source` (tests), no file is read.
 */
export function loadConfig(source?: EnvSource): PlatformBackendConfig {
  if (source === undefined) {
    loadDevEnvFiles({ appDir: APP_DIR });
  }
  return parseConfig(source);
}

/**
 * `ConfigModule` with the validated configuration as its only source (packages/README.md): no `.env` file, no
 * `process.env` fallback, nothing written back to `process.env`. Services read it with
 * `ConfigService<PlatformBackendConfig, true>`. Shared by the API and the worker.
 */
export function configModule(config: PlatformBackendConfig): Promise<DynamicModule> {
  return ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    validatePredefined: false,
    skipProcessEnv: true,
    load: [() => config],
  });
}

/** The process logger: JSON lines with `app` and `env` at LOG_LEVEL, and the redaction list of `@velexis/logger`. */
export function createProcessLogger(
  app: PlatformProcess,
  config: Pick<PlatformBackendConfig, "APP_ENV" | "LOG_LEVEL">,
  destination?: DestinationStream,
): Logger {
  return createLogger({ app, env: config.APP_ENV, level: config.LOG_LEVEL, destination });
}

export interface StartOptions {
  /** The variables to validate instead of the process environment (tests). No `.env.local` file is read then. */
  readonly env?: EnvSource;
  /** Where log lines go instead of stdout (tests). */
  readonly logDestination?: DestinationStream;
}

/**
 * `loadConfig` for an entry point: the configuration, or `undefined` after one `fatal` line `config.invalid` whose
 * `err` is the `ConfigError` (it names each variable and the reason, never a value). The caller then exits non-zero.
 * `APP_ENV` and `LOG_LEVEL` are not known yet, so the line has `env: "unknown"` and is always written.
 */
export function loadConfigOrReport(
  app: PlatformProcess,
  options: StartOptions = {},
): PlatformBackendConfig | undefined {
  try {
    return loadConfig(options.env);
  } catch (error) {
    createLogger({ app, env: "unknown", destination: options.logDestination }).fatal(
      { err: error },
      "config.invalid",
    );
    return undefined;
  }
}
