// Configuration of the OTA backend (README §3, docs/mvp/conventions.md §8), validated by @velexis/config.
//
// The API (dist/main.js) and the worker (dist/worker.js) share one codebase but not one configuration: each process
// validates only its own schema, so a variable the other process needs is never read, never required and never
// present in the object this process gets. The privileged DSN of the worker (DATABASE_PROVISIONER_URL, role
// velexis_provisioner) is the main case: the API unit cannot read /etc/velexis/ota-worker.env (ADR-0026), and its
// configuration has no such entry even when the variable is set. DATABASE_MIGRATOR_URL belongs to deploys and the
// local migration commands only and is in neither schema (ADR-0004, configuration matrix of
// docs/mvp/architecture.md §6). Later tasks extend the schemas.
import { isIP } from "node:net";
import { resolve } from "node:path";
import {
  defineConfig,
  env,
  loadDevEnvFiles,
  type ConfigOf,
  type EnvSource,
  type EnvVar,
} from "@velexis/config";

/** The package folder (`ota/backend`, or `ota-backend` in a release): `src/` and `dist/` are one level down. */
export const APP_DIR = resolve(__dirname, "..");

/** Process names: the `app` field of every log line and the prefix of the PostgreSQL `application_name`. */
export const API_APP = "ota-api";
export const WORKER_APP = "ota-worker";

const POSTGRES_PROTOCOLS = ["postgres:", "postgresql:"] as const;
const REDIS_PROTOCOLS = ["redis:", "rediss:"] as const;

/** The named address ranges of Express' `trust proxy` setting (proxy-addr). */
const TRUST_PROXY_PRESETS: readonly string[] = ["loopback", "linklocal", "uniquelocal"];

/** Why one `TRUST_PROXY` item is refused, or `undefined` when it is a preset, an address or a CIDR range. */
function trustProxyItemProblem(item: string): string | undefined {
  if (TRUST_PROXY_PRESETS.includes(item)) {
    return undefined;
  }
  const [address = "", prefix, extra] = item.split("/");
  const family = isIP(address);
  if (family === 0 || extra !== undefined) {
    return "must list loopback, linklocal, uniquelocal, IP addresses or CIDR ranges";
  }
  if (prefix !== undefined) {
    // A prefix length of 0 (0.0.0.0/0, ::/0) would trust every address, as `true` does.
    const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : Number.NaN;
    if (!(bits >= 1 && bits <= (family === 4 ? 32 : 128))) {
      return "has a CIDR prefix length out of range (1 to 32 for IPv4, 1 to 128 for IPv6)";
    }
  }
  return undefined;
}

/**
 * Express' `trust proxy` setting as a list: the proxies whose `X-Forwarded-For` is believed. Only named ranges,
 * addresses and CIDR ranges are accepted; `true`, `*` and hop counts, which would trust any client that sends the
 * header, are refused. The default `loopback` matches Caddy and the Vite dev proxy on the same machine.
 */
function trustProxy(defaultValue: readonly string[]): EnvVar<readonly string[]> {
  const list = env.list({ default: defaultValue });
  return {
    ...list,
    kind: "trustProxy",
    parse(raw, context) {
      const result = list.parse(raw, context);
      if (!result.ok) {
        return result;
      }
      for (const item of result.value as readonly string[]) {
        const problem = trustProxyItemProblem(item);
        if (problem !== undefined) {
          return { ok: false, reason: problem };
        }
      }
      return result;
    },
  };
}

/** Variables of both processes. */
const sharedSchema = {
  APP_ENV: env.enum(["development", "test", "production"] as const),
  LOG_LEVEL: env.enum(["debug", "info", "warn", "error"] as const, { default: "info" }),
  // Role velexis_ota_app: DML on tenant schemas, SELECT on reference and on selected platform tables (ADR-0004).
  DATABASE_URL: env.url({ protocols: POSTGRES_PROTOCOLS }),
  REDIS_URL: env.url({ protocols: REDIS_PROTOCOLS }),
} as const;

/** The API process (`dist/main.js`, unit velexis-ota-api). */
export const apiConfigSchema = {
  ...sharedSchema,
  // The unit sets PORT=4000; the API binds 127.0.0.1 only (architecture.md §3).
  PORT: env.port({ default: 4000 }),
  TRUST_PROXY: trustProxy(["loopback"]),
} as const;

/** The worker process (`dist/worker.js`, unit velexis-ota-worker). */
export const workerConfigSchema = {
  ...sharedSchema,
  // The unit sets HEALTH_PORT=4001; the worker serves /health/* on 127.0.0.1 only.
  HEALTH_PORT: env.port({ default: 4001 }),
  // Role velexis_provisioner: tenant provisioning and migrations (CREATE on the database, owner of the tenant schemas,
  // nothing on platform or reference; ADR-0004). /etc/velexis/ota-worker.env on the VM. Never used to serve requests.
  DATABASE_PROVISIONER_URL: env.url({ protocols: POSTGRES_PROTOCOLS }),
} as const;

/** The variables both processes read: what shared modules such as `health` may use. */
export type SharedConfig = ConfigOf<typeof sharedSchema>;
export type ApiConfig = ConfigOf<typeof apiConfigSchema>;
export type WorkerConfig = ConfigOf<typeof workerConfigSchema>;

/**
 * Validates `source` against the schema. Without a source it validates the process environment, after filling unset
 * variables from `ota/backend/.env.local` and the root `.env.local` in development and tests (never when `APP_ENV` or
 * `NODE_ENV` is `production`: on the VM systemd provides the environment). Throws one `ConfigError` naming every
 * missing or invalid variable, never a value.
 */
function load<S extends typeof apiConfigSchema | typeof workerConfigSchema>(
  schema: S,
  source: EnvSource | undefined,
): ConfigOf<S> {
  if (source !== undefined) {
    return defineConfig(schema, source);
  }
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(schema);
}

/** The API's configuration (see `load`). */
export function loadApiConfig(source?: EnvSource): ApiConfig {
  return load(apiConfigSchema, source);
}

/** The worker's configuration (see `load`). */
export function loadWorkerConfig(source?: EnvSource): WorkerConfig {
  return load(workerConfigSchema, source);
}
