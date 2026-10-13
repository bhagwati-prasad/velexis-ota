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

const HTTP_URL = { protocols: ["http:", "https:"] } as const;

/**
 * The platform admin's configuration (README §5, configuration matrix in docs/mvp/architecture.md §6). Every
 * variable is read on the server only; the admin has no browser-exposed variables. Later tasks add their
 * entries here (`PLATFORM_BFF_KEY` comes with PAD-002).
 */
export const ADMIN_CONFIG_SCHEMA = {
  APP_ENV: env.enum(["development", "test", "production"]),
  LOG_LEVEL: env.enum(LOG_LEVELS, { default: "info" }),
  PORT: env.port({ default: 3001 }),
  HOSTNAME: env.string({ pattern: BIND_HOST, default: "127.0.0.1" }),
  /** Platform API base URL, called from server code only (loopback on the VM; admin surface `/v1/admin`). */
  PLATFORM_API_URL: env.url(HTTP_URL),
  /** The admin's own public origin, `https://admin.platform.example.com` in production. */
  PUBLIC_PLATFORM_ADMIN_URL: env.url(HTTP_URL),
  /** The portal origin: admins enable MFA there before their first admin sign-in (`MFA_REQUIRED` link). */
  PUBLIC_PORTAL_URL: env.url(HTTP_URL),
  /** Error tracking is off when unset or empty. */
  SENTRY_DSN: env.url({ protocols: ["https:"], optional: true }),
} as const;

export type AdminConfig = ConfigOf<typeof ADMIN_CONFIG_SCHEMA>;

/** Public URLs that browsers reach must be HTTPS in production (`__Host-` cookies are `Secure`). */
const PUBLIC_URLS = ["PUBLIC_PLATFORM_ADMIN_URL", "PUBLIC_PORTAL_URL"] as const;

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
  if (validValues({ APP_ENV: ADMIN_CONFIG_SCHEMA.APP_ENV }, source)?.APP_ENV !== "production") {
    return [];
  }
  return PUBLIC_URLS.filter((variable) => {
    const url = validValues({ [variable]: ADMIN_CONFIG_SCHEMA[variable] }, source)?.[variable];
    return url !== undefined && new URL(url).protocol !== "https:";
  }).map((variable) => ({ variable, reason: "must use https: when APP_ENV is production" }));
}

/**
 * Validates the admin configuration in `source` (default: the process environment) and returns it frozen.
 * Throws one `ConfigError` that names every invalid variable and the reason, never a value: the https rule of
 * production joins the schema's problems, so a broken env file is reported in one round.
 */
export function parseConfig(source?: EnvSource): AdminConfig {
  const problems = productionProblems(source);
  try {
    const config = defineConfig(ADMIN_CONFIG_SCHEMA, source);
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

let cached: AdminConfig | undefined;

/**
 * The admin configuration of this process, validated on first use and cached. Outside production, unset
 * variables are first filled from `platform/admin/.env.local`, then from the root `.env.local`.
 *
 * Call it inside request handling (route handlers, server components, server actions), never at module scope:
 * `next build` imports modules without the runtime environment.
 */
export function getConfig(): AdminConfig {
  if (cached === undefined) {
    loadDevEnvFiles({ appDir: process.cwd() });
    cached = parseConfig();
  }
  return cached;
}
