import "server-only";

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

/** pino levels, as `@velexis/logger` accepts them. */
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** A host name or IP literal for the Next.js server to bind to (`127.0.0.1` on the VM: Caddy is the entry). */
const BIND_HOST = /^[A-Za-z0-9.:-]+$/;

/** A lower-case DNS name with at least two labels, for example `ota.example.com`. */
const DOMAIN_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const HTTP_URL = { protocols: ["http:", "https:"] } as const;

/**
 * The portal's configuration (README §8, configuration matrix in docs/mvp/architecture.md §6). Every variable is
 * read on the server only; the portal has no browser-exposed variables. Later tasks add their entries here.
 */
export const PORTAL_CONFIG_SCHEMA = {
  APP_ENV: env.enum(["development", "test", "production"]),
  LOG_LEVEL: env.enum(LOG_LEVELS, { default: "info" }),
  PORT: env.port({ default: 3000 }),
  HOSTNAME: env.string({ pattern: BIND_HOST, default: "127.0.0.1" }),
  /** Platform API base URL, called from server code only (loopback on the VM). */
  PLATFORM_API_URL: env.url(HTTP_URL),
  PUBLIC_PORTAL_URL: env.url(HTTP_URL),
  PUBLIC_OTA_ADMIN_URL: env.url(HTTP_URL),
  /** Storefront parent domain: an OTA's sub-domain is `<key>.<STOREFRONT_BASE_DOMAIN>`. */
  STOREFRONT_BASE_DOMAIN: env.string({ pattern: DOMAIN_NAME }),
  /** Error tracking is off when unset or empty. */
  SENTRY_DSN: env.url({ protocols: ["https:"], optional: true }),
} as const;

export type PortalConfig = ConfigOf<typeof PORTAL_CONFIG_SCHEMA>;

/** Public URLs that browsers reach must be HTTPS in production (`__Host-` cookies are `Secure`). */
const PUBLIC_URLS = ["PUBLIC_PORTAL_URL", "PUBLIC_OTA_ADMIN_URL"] as const;

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

/**
 * The production rule for public URLs. It checks each variable on its own, so its problems are reported in the
 * same `ConfigError` as the schema's problems of other variables.
 */
function productionProblems(source: EnvSource | undefined): ConfigProblem[] {
  if (validValues({ APP_ENV: PORTAL_CONFIG_SCHEMA.APP_ENV }, source)?.APP_ENV !== "production") {
    return [];
  }
  return PUBLIC_URLS.filter((variable) => {
    const url = validValues({ [variable]: PORTAL_CONFIG_SCHEMA[variable] }, source)?.[variable];
    return url !== undefined && new URL(url).protocol !== "https:";
  }).map((variable) => ({ variable, reason: "must use https: when APP_ENV is production" }));
}

/**
 * Validates the portal configuration in `source` (default: the process environment) and returns it frozen.
 * Throws one `ConfigError` that names every invalid variable and the reason, never a value.
 */
export function parseConfig(source?: EnvSource): PortalConfig {
  const problems = productionProblems(source);
  try {
    const config = defineConfig(PORTAL_CONFIG_SCHEMA, source);
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

let cached: PortalConfig | undefined;

/**
 * The portal configuration of this process, validated on first use and cached. Outside production, unset
 * variables are first filled from `platform/frontend/.env.local`, then from the root `.env.local`.
 *
 * Call it inside request handling (route handlers, server components, server actions), never at module scope:
 * `next build` imports modules without the runtime environment.
 */
export function getConfig(): PortalConfig {
  if (cached === undefined) {
    loadDevEnvFiles({ appDir: process.cwd() });
    cached = parseConfig();
  }
  return cached;
}
