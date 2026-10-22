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
import { API_KEY_PEPPER_MIN_BYTES } from "@velexis/crypto";
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
 * The DER length of an Ed25519 private key in PKCS#8 (`openssl genpkey -algorithm ed25519`, `pnpm dev:keys`): the
 * least JWT_PRIVATE_KEY_FILE may hold. TokenService also checks that the key is Ed25519.
 */
export const JWT_PRIVATE_KEY_MIN_BYTES = 48;

/** The id of a KEK of `LocalFileKeyProvider` (ADR-0010): `local:v<N>`, N >= 1 without leading zeros. */
const KEK_ID = /^local:v[1-9][0-9]{0,8}$/;

/**
 * An e-mail address without anchors: exactly the `email` format of ajv-formats ("full" mode, the one the OpenAPI
 * validation uses; dot-atom local part, two or more labels). config.test.ts compares the two, so a sign-up the API
 * accepts never fails on its e-mail.
 */
const ADDRESS =
  "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/**
 * One e-mail address as the platform sends to it: the `email` format of the OpenAPI validation (ajv-formats), so every
 * address an account signed up with passes, ASCII only and at most 254 characters. Nothing SMTP or Nodemailer could
 * read as several addresses, a display name or a comment passes (no spaces, quotes, angle brackets, commas,
 * parentheses or line breaks).
 */
export const EMAIL_ADDRESS = new RegExp(`^(?=.{3,254}$)${ADDRESS}$`, "i");

/**
 * The sender of the platform's e-mails: an address, or a display name and the address in angle brackets
 * (`"Velexis" <no-reply@mail.platform.example.com>`, `Velexis <no-reply@mail.platform.example.com>`). One line, one
 * address.
 */
export const MAIL_FROM_PATTERN = new RegExp(
  `^(?:${ADDRESS}|(?:"[^"\\\\\\r\\n]*"|[^"<>,;:@\\\\\\r\\n]*?)\\s*<${ADDRESS}>)$`,
  "i",
);

/**
 * The parent domain of the storefront sub-domains (`<key>.<STOREFRONT_BASE_DOMAIN>`, decisions.md §4): the host-name
 * rule the OTA backend applies to the same variable (two or more lower-case DNS labels, the last one starting with a
 * letter, no trailing dot), at most 222 characters, so `<key>.` (31 characters at most) in front still makes a host
 * name of at most 253.
 */
export const STOREFRONT_BASE_DOMAIN_PATTERN =
  /^(?=.{1,222}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A secret or restricted API key of the Velexis Stripe account (`sk_test_…`, `sk_live_…`, `rk_test_…`, `rk_live_…`).
 * Its mode must be the deployment's (`stripeProblems`): live keys in production only, test keys everywhere else.
 */
export const STRIPE_SECRET_KEY_PATTERN = /^[sr]k_(?:test|live)_[A-Za-z0-9_]{1,250}$/;

/** A webhook endpoint's signing secret (`whsec_…`, as the Stripe dashboard and `stripe listen` print it). */
export const STRIPE_WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/=_-]{1,250}$/;

/** The Connect Standard OAuth client id of the Velexis platform (`ca_…`). */
export const STRIPE_CONNECT_CLIENT_ID_PATTERN = /^ca_[A-Za-z0-9_]{1,250}$/;

/**
 * The Stripe variables each milestone switch needs (PADR-0015, README §3): they are optional while their switches are
 * off, so a deployment before M5 needs none, and required while one is on. Stripe Billing needs the account's key
 * and the billing endpoint's secret, the OTA's own Stripe (Connect Standard) the key, the OAuth client id and the
 * Connect endpoint's secret.
 */
export const STRIPE_SWITCH_VARIABLES = Object.freeze({
  FEATURE_STRIPE_BILLING: Object.freeze(["STRIPE_SECRET_KEY", "STRIPE_BILLING_WEBHOOK_SECRET"] as const),
  FEATURE_OWN_STRIPE: Object.freeze([
    "STRIPE_SECRET_KEY",
    "STRIPE_CONNECT_CLIENT_ID",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
  ] as const),
});

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
  /**
   * The Ed25519 key (PKCS#8 PEM) that signs the portal and admin access tokens (platform/docs/architecture.md §3.1,
   * ADR-0008); `kid` is its JWK thumbprint. The value is the path: the file must exist with mode 0400 or 0600. The
   * API signs with it; the worker and the CLI validate it too, because the three read `platform-backend.env`.
   */
  JWT_PRIVATE_KEY_FILE: env.secretFile({ minBytes: JWT_PRIVATE_KEY_MIN_BYTES, encoding: "pem" }),
  /**
   * The pepper of the API key hashes (PADR-0005 item 3, ADR-0010): 32 random bytes in base64, an identical copy of
   * the OTA backend's, in the platform zone's key folder on the VM. `key_hash = hex(HMAC-SHA-256(pepper, key))`. The
   * value is the path: the file must exist with mode 0400 or 0600. The API hashes the keys it creates and rolls, the
   * worker the initial test keys of provisioning (PBE-022); `api-keys/api-keys.module.ts` reads the file once at
   * start-up. The CLI validates it too, because the three read `platform-backend.env`. A secret: never logged.
   */
  API_KEY_PEPPER_FILE: env.secretFile({ minBytes: API_KEY_PEPPER_MIN_BYTES }),
  /**
   * The platform zone's key folder (ADR-0010, ADR-0026): every `master-v<N>.key` in it is the KEK `local:v<N>`, and
   * MASTER_KEY_CURRENT names the one that wraps new data keys. `common/crypto.provider.ts` loads them once at
   * start-up; a missing current key, or a key file that group or others may read, stops the process. The API
   * encrypts (the secret links of e-mails, PADR-0013) and the worker decrypts.
   */
  MASTER_KEY_DIR: env.dir(),
  MASTER_KEY_CURRENT: env.string({ pattern: KEK_ID }),
  /**
   * The SMTP server of the platform's e-mails (ADR-0017): `smtp://` or `smtps://`, credentials in the URL (a secret:
   * never logged). Mailpit `smtp://127.0.0.1:1025` in development and tests. Only the worker sends.
   */
  SMTP_URL: env.url({ protocols: ["smtp:", "smtps:"] }),
  /** The sender of every platform e-mail (PADR-0013 item 6), e.g. `"Velexis" <no-reply@mail.platform.example.com>`. */
  MAIL_FROM: env.string({ pattern: MAIL_FROM_PATTERN }),
  /** The recipient of `ops.alert` e-mails (pool low, live office request, payout account to review, failures). */
  OPS_ALERT_EMAIL: env.string({ pattern: EMAIL_ADDRESS }),
  /**
   * The portal's public base URL: every link of a platform e-mail starts with it or with PUBLIC_PLATFORM_ADMIN_URL,
   * never with a host taken from a request (PADR-0013 item 7). Later tasks build the Checkout and Connect redirects
   * on it too.
   */
  PUBLIC_PORTAL_URL: env.url({ protocols: ["http:", "https:"] }),
  /** The platform admin's public base URL, for the links of ops e-mails (PADR-0013 item 7). */
  PUBLIC_PLATFORM_ADMIN_URL: env.url({ protocols: ["http:", "https:"] }),
  /**
   * The parent domain of every OTA's storefront sub-domain, `<key>.<STOREFRONT_BASE_DOMAIN>` (`ota.example.com`):
   * the host the key check shows (`checkTenantKey`), the sub-domain row of a new OTA and the TLS `ask` rule. No
   * default: a wrong domain in production would hand out hosts Velexis does not serve.
   */
  STOREFRONT_BASE_DOMAIN: env.string({ pattern: STOREFRONT_BASE_DOMAIN_PATTERN }),
  /**
   * The OTAs that are not `failed` one account may own (platform/docs/scope.md PF-10 AC4): beyond it createTenant
   * answers `422 UNPROCESSABLE` with `details.reason = "tenant_limit"`.
   */
  MAX_TENANTS_PER_ACCOUNT: env.int({ min: 1, default: 3 }),
  /**
   * The milestone switches of PADR-0015 (common/features.ts), all off unless turned on: Stripe Billing, the OTA's
   * own Stripe, settlements, own Amadeus credentials, custom domains and the live switch. They are read by the API
   * (`FeatureGuard`, `getMe`) and the worker (its schedulers), so both see the same values.
   */
  FEATURE_STRIPE_BILLING: env.bool({ default: false }),
  FEATURE_OWN_STRIPE: env.bool({ default: false }),
  FEATURE_SETTLEMENTS: env.bool({ default: false }),
  FEATURE_OWN_AMADEUS: env.bool({ default: false }),
  FEATURE_CUSTOM_DOMAINS: env.bool({ default: false }),
  FEATURE_LIVE_SWITCH: env.bool({ default: false }),
  /**
   * The secret key of the Velexis Stripe account (ADR-0013, PADR-0002): Billing, Connect and balance transactions,
   * through `common/stripe/stripe.client.ts` only. Required while FEATURE_STRIPE_BILLING or FEATURE_OWN_STRIPE is on
   * (STRIPE_SWITCH_VARIABLES); a live key in production only, a test key everywhere else. A secret: never logged.
   */
  STRIPE_SECRET_KEY: env.string({ optional: true, pattern: STRIPE_SECRET_KEY_PATTERN }),
  /**
   * The signing secret of `/webhooks/stripe/billing` (StripeSignatureGuard). Required while FEATURE_STRIPE_BILLING is
   * on; without it the endpoint refuses every delivery with `400 WEBHOOK_SIGNATURE_INVALID`. A secret: never logged.
   */
  STRIPE_BILLING_WEBHOOK_SECRET: env.string({ optional: true, pattern: STRIPE_WEBHOOK_SECRET_PATTERN }),
  /** The Connect Standard OAuth client id (`ca_…`, PADR-0011). Required while FEATURE_OWN_STRIPE is on. */
  STRIPE_CONNECT_CLIENT_ID: env.string({ optional: true, pattern: STRIPE_CONNECT_CLIENT_ID_PATTERN }),
  /**
   * The signing secret of `/webhooks/stripe/connect-accounts` (PADR-0011). Required while FEATURE_OWN_STRIPE is on;
   * without it the endpoint refuses every delivery. A secret: never logged.
   */
  STRIPE_CONNECT_WEBHOOK_SECRET: env.string({ optional: true, pattern: STRIPE_WEBHOOK_SECRET_PATTERN }),
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

type StripeVariable = (typeof STRIPE_SWITCH_VARIABLES)[keyof typeof STRIPE_SWITCH_VARIABLES][number];

const STRIPE_VARIABLES: readonly StripeVariable[] = [
  "STRIPE_SECRET_KEY",
  "STRIPE_BILLING_WEBHOOK_SECRET",
  "STRIPE_CONNECT_CLIENT_ID",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
];

/**
 * The Stripe rules that a schema entry cannot express (STRIPE_SWITCH_VARIABLES): a variable that a switch which is on
 * needs must be set, and STRIPE_SECRET_KEY's mode must be the deployment's (`APP_ENV=production` means live, as for
 * the `livemode` of webhook events). A variable that is invalid on its own is reported by the schema, not here.
 */
function stripeProblems(source: EnvSource | undefined): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const switches = validValues(
    {
      FEATURE_STRIPE_BILLING: PLATFORM_BACKEND_CONFIG_SCHEMA.FEATURE_STRIPE_BILLING,
      FEATURE_OWN_STRIPE: PLATFORM_BACKEND_CONFIG_SCHEMA.FEATURE_OWN_STRIPE,
    },
    source,
  );
  for (const variable of STRIPE_VARIABLES) {
    const value = validValues({ [variable]: PLATFORM_BACKEND_CONFIG_SCHEMA[variable] }, source);
    if (value === undefined || value[variable] !== undefined || switches === undefined) {
      continue;
    }
    const needing = (
      Object.keys(STRIPE_SWITCH_VARIABLES) as Array<keyof typeof STRIPE_SWITCH_VARIABLES>
    ).filter(
      (feature) =>
        switches[feature] &&
        (STRIPE_SWITCH_VARIABLES[feature] as readonly StripeVariable[]).includes(variable),
    );
    if (needing.length > 0) {
      problems.push({ variable, reason: `is required while ${needing.join(" or ")} is on` });
    }
  }
  const appEnv = validValues({ APP_ENV: PLATFORM_BACKEND_CONFIG_SCHEMA.APP_ENV }, source)?.APP_ENV;
  const key = validValues(
    { STRIPE_SECRET_KEY: PLATFORM_BACKEND_CONFIG_SCHEMA.STRIPE_SECRET_KEY },
    source,
  )?.STRIPE_SECRET_KEY;
  if (appEnv !== undefined && key !== undefined && /^[sr]k_live_/.test(key) !== (appEnv === "production")) {
    problems.push({
      variable: "STRIPE_SECRET_KEY",
      reason: "must be a live-mode key with APP_ENV=production and a test-mode key otherwise",
    });
  }
  return problems;
}

/**
 * Validates the configuration in `source` (default: the process environment) and returns it deep-frozen. Throws one
 * `ConfigError` that names every invalid variable and the reason, never a value.
 */
export function parseConfig(source?: EnvSource): PlatformBackendConfig {
  const problems = [...trustProxyProblems(source), ...stripeProblems(source)];
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
