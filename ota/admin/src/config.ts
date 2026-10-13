// Configuration of the OTA admin (docs/mvp/conventions.md §8, README §11), validated by @velexis/config.
// Server code only: `server-only` fails the build of any client component that imports this module, so no
// value can reach a browser bundle. No NEXT_PUBLIC_ variable exists in this app (README §10).
import "server-only";
import {
  defineConfig,
  env,
  loadDevEnvFiles,
  type ConfigOf,
  type EnvSource,
  type EnvVar,
} from "@velexis/config";

/**
 * The service credential: `sk_svc_<48 hex>` on the VM (deploy/scripts/provision-vm.sh), the dummy
 * `sk_dev_…` value of `.env.example` locally. It rejects an empty value and the `@@…@@` template placeholder.
 */
const SERVICE_KEY_PATTERN = /^sk_[A-Za-z0-9_]{16,}$/;

/** Host names of the loopback interface, as `URL.hostname` writes them. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "[::1]", "localhost"];

/**
 * An `http:` URL on the loopback interface. The OTA API accepts the service key only on a direct local
 * connection that did not come through Caddy (OADR-0009 rule 1.2), so any other host is refused when the
 * configuration is loaded instead of failing on every console call.
 */
function loopbackHttpUrl(): EnvVar<string> {
  const url = env.url({ protocols: ["http:"] });
  return {
    ...url,
    kind: "loopbackHttpUrl",
    parse(raw, context) {
      const result = url.parse(raw, context);
      if (result.ok && !LOOPBACK_HOSTS.includes(new URL(raw).hostname)) {
        return {
          ok: false,
          reason:
            "must point at the loopback interface (127.0.0.1, [::1] or localhost), never at a Caddy host",
        };
      }
      return result;
    },
  };
}

/** Every variable of the OTA admin (configuration matrix, docs/mvp/architecture.md §6). */
export const configSchema = {
  APP_ENV: env.enum(["development", "test", "production"] as const),
  LOG_LEVEL: env.enum(["debug", "info", "warn", "error"] as const, { default: "info" }),
  // Next.js binds the port itself (`next dev --port`, or PORT for the standalone server.js of the unit);
  // the value is validated here with the rest.
  PORT: env.port({ default: 3002 }),
  // Absolute links and Origin checks.
  PUBLIC_OTA_ADMIN_URL: env.url({ protocols: ["https:", "http:"] }),
  // SSO Origin check, redirects to the portal and portal links.
  PUBLIC_PORTAL_URL: env.url({ protocols: ["https:", "http:"] }),
  // SDK baseUrl.
  OTA_API_URL: loopbackHttpUrl(),
  // SDK secretKey. A secret: never logged, never sent anywhere but OTA_API_URL.
  OTA_ADMIN_SERVICE_KEY: env.string({ pattern: SERVICE_KEY_PATTERN }),
  // Optional error tracking, off when empty (ADR-0016).
  SENTRY_DSN: env.url({ optional: true }),
} as const;

export type OtaAdminConfig = ConfigOf<typeof configSchema>;

/**
 * Validates `source` (default: the process environment) and returns the frozen configuration. Throws one
 * `ConfigError` naming every missing or invalid variable, never a value.
 */
export function loadConfig(source?: EnvSource): OtaAdminConfig {
  return defineConfig(configSchema, source);
}

let current: OtaAdminConfig | undefined;

/**
 * The configuration of this process, validated on first use and then cached. It is read when a request needs
 * it, never at module load, so `next build` needs no runtime variables: the same build runs on every machine.
 * In development and tests the root and app `.env.local` files fill unset variables first; with
 * `APP_ENV=production` (or `NODE_ENV=production`) only the environment that systemd provides is used.
 */
export function getConfig(): OtaAdminConfig {
  if (current === undefined) {
    // In development and tests the app runs from its own folder (`pnpm --filter @velexis/ota-admin …`).
    loadDevEnvFiles({ appDir: process.cwd() });
    current = loadConfig();
  }
  return current;
}
