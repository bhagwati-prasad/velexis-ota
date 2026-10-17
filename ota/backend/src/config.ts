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
import { API_KEY_PEPPER_MIN_BYTES } from "@velexis/crypto";

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

/**
 * The storefront edge credential (ADR-0018): at least 24 characters of `[A-Za-z0-9_-]`. provision-vm.sh generates 48
 * hex characters, the development value of the `.env.example` files has 25; an empty value and the unsubstituted
 * `@@EDGE_SECRET@@` placeholder of the deploy template are refused.
 */
const EDGE_SECRET = /^[A-Za-z0-9_-]{24,}$/;

/**
 * A host name in lower case, without a trailing dot, of at least two labels: the rule of `redis.keys.ts` and of the
 * `domain` invalidation event (PADR-0004 item 1).
 */
const HOST_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `MASTER_KEY_CURRENT`: a KEK id of `LocalFileKeyProvider`, `local:v<N>` with N >= 1 and no leading zeros. */
const KEK_ID = /^local:v[1-9][0-9]{0,8}$/;

/** The loopback hosts on which an `http:` Amadeus base URL is accepted: the stub in development and CI. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/**
 * An optional Amadeus base URL (`AMADEUS_BASE_URL_TEST`, `_LIVE`): the origin that every Amadeus request of that
 * environment goes to instead of the connection's (flows/amadeus-connection-and-tokens.md §2 rule 5). The client
 * secret and the access tokens travel to it, so only `https:` is accepted, or `http:` on the loopback interface (the
 * stub, as the CHECK of `platform.amadeus_accounts.base_url` allows); a path, query, fragment or user info is refused.
 * The value is the URL's origin (`http://127.0.0.1:4900`, no trailing slash).
 */
function amadeusBaseUrl(): EnvVar<string | undefined> {
  const url = env.url({ protocols: ["https:", "http:"], optional: true });
  return {
    ...url,
    kind: "amadeusBaseUrl",
    parse(raw, context) {
      const result = url.parse(raw, context);
      if (!result.ok) {
        return result;
      }
      const parsed = new URL(raw);
      if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.includes(parsed.hostname)) {
        return {
          ok: false,
          reason: "must be an https URL, or an http URL on the loopback interface (the stub)",
        };
      }
      if (
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.username !== "" ||
        parsed.password !== ""
      ) {
        return {
          ok: false,
          reason: "must be an origin only, without a path, query, fragment or credentials",
        };
      }
      return { ok: true, value: parsed.origin };
    },
  };
}

/** The API process (`dist/main.js`, unit velexis-ota-api). */
export const apiConfigSchema = {
  ...sharedSchema,
  // The unit sets PORT=4000; the API binds 127.0.0.1 only (architecture.md §3).
  PORT: env.port({ default: 4000 }),
  TRUST_PROXY: trustProxy(["loopback"]),
  // The shared secret Caddy sends in X-Velexis-Edge on every storefront /api/* request (ADR-0018, OADR-0009 rule
  // 1.1); compared in constant time by the caller guard, never logged. The same value is in caddy.env.
  VELEXIS_EDGE_SECRET: env.string({ pattern: EDGE_SECRET }),
  // The HMAC pepper of API key hashes (PADR-0005 item 3): an identical copy of the platform's file in the OTA zone's
  // key folder (ADR-0026). Checked at start-up (mode 0400 or 0600, at least 32 bytes after base64 decoding); the
  // configuration holds the path, and the tenancy module reads the key once.
  API_KEY_PEPPER_FILE: env.secretFile({ minBytes: API_KEY_PEPPER_MIN_BYTES }),
  // `<key>.<STOREFRONT_BASE_DOMAIN>` is a tenant's storefront sub-domain (ADR-0018, OADR-0009 point 2).
  STOREFRONT_BASE_DOMAIN: env.string({ pattern: HOST_NAME }),
  // The API's public origin, for absolute URLs given to key callers (asset and file links; ADR-0018).
  PUBLIC_OTA_API_URL: env.url({ protocols: ["https:", "http:"] }),
  // The OTA zone's key folder (ADR-0010, ADR-0026): every `master-v<N>.key` in it is the KEK `local:v<N>`, and
  // MASTER_KEY_CURRENT names the one that wraps new data keys (identical copies of the platform zone's files, so the
  // OTA backend decrypts the Amadeus secrets the platform encrypted). The Amadeus module loads them once when it
  // starts (OBE-017): it decrypts client secrets and encrypts the cached access tokens. The worker adds both variables
  // with its first encrypted value.
  MASTER_KEY_DIR: env.dir(),
  MASTER_KEY_CURRENT: env.string({ pattern: KEK_ID }),
  // Optional overrides of the Amadeus host per environment (the stub, http://127.0.0.1:4900, in development and CI);
  // empty on the VM, where the connection's or the shared account's base_url is used (OADR-0001 point 4).
  AMADEUS_BASE_URL_TEST: amadeusBaseUrl(),
  AMADEUS_BASE_URL_LIVE: amadeusBaseUrl(),
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
