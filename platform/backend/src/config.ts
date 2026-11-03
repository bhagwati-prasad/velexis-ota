// The platform backend's configuration (README §3): one schema for the API (dist/main.js), the worker
// (dist/worker.js) and the CLI (dist/cli.js), validated by @velexis/config before anything else starts. A missing or
// invalid variable stops the process with one ConfigError that names every variable and never a value
// (conventions §8). Later tasks extend the schema.
import { isIP, isIPv6 } from "node:net";
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

/** An IPv4 address in dotted-decimal form: four numbers of 0–255 without leading zeros (STOREFRONT_IPV4). */
export const IPV4_ADDRESS_PATTERN =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

/**
 * The characters an IPv6 address may have (hexadecimal digits, colons, and the dots of an embedded IPv4 address), at
 * most 45 of them: no zone index (`%eth0`), no brackets, no prefix length. `storefrontAddressProblems` checks the
 * address itself with `isIPv6`.
 */
export const IPV6_ADDRESS_CHARACTERS = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * The storefront addresses each milestone switch needs (PBE-049, PADR-0004 item 2): a custom domain at a zone apex
 * cannot have a CNAME, so its owner points an `A` record at STOREFRONT_IPV4, which must be set while
 * FEATURE_CUSTOM_DOMAINS is on. STOREFRONT_IPV6 stays optional: a VM has an IPv6 address only where its provider offers
 * one (docs/mvp/deployment-single-vm.md §1), and without it no `AAAA` record is shown.
 */
export const STOREFRONT_ADDRESS_SWITCH_VARIABLES = Object.freeze({
  FEATURE_CUSTOM_DOMAINS: Object.freeze(["STOREFRONT_IPV4"] as const),
});

/**
 * One item of DNS_RESOLVERS, as `node:dns` `Resolver.setServers` takes it: an IPv4 address with an optional port
 * (`1.1.1.1`, `127.0.0.1:5353`), or an IPv6 address, bare or in brackets with a port (`2606:4700:4700::1111`,
 * `[2606:4700:4700::1111]:53`). No host name: the resolvers must not depend on another resolver. `dnsResolverProblems`
 * checks the address and the port themselves.
 */
export const DNS_RESOLVER_ITEM =
  /^(?:[0-9.]{7,15}(?::[0-9]{1,5})?|[0-9A-Fa-f:.]{2,45}|\[[0-9A-Fa-f:.]{2,45}\](?::[0-9]{1,5})?)$/;

/** The public resolvers DNS verification asks when DNS_RESOLVERS is not set (PADR-0004 item 3). */
export const DEFAULT_DNS_RESOLVERS = Object.freeze(["1.1.1.1", "8.8.8.8"] as const);

/** The most resolvers DNS_RESOLVERS may list: each one that does not answer costs a timeout of its own. */
export const MAX_DNS_RESOLVERS = 4;

/**
 * The address and port of one DNS_RESOLVERS item, or `undefined` when it is none: an IPv4 address (with `:port`), or an
 * IPv6 address (bare, or `[address]:port`); a port is 1 to 65535.
 */
export function parseDnsResolver(item: string): { address: string; port?: number } | undefined {
  const bracketed = /^\[([^\]]+)\](?::([0-9]{1,5}))?$/.exec(item);
  const plainV4 = /^([0-9.]+)(?::([0-9]{1,5}))?$/.exec(item);
  let address: string;
  let port: string | undefined;
  if (bracketed !== null) {
    [, address = "", port] = bracketed;
    if (!isIPv6(address)) {
      return undefined;
    }
  } else if (plainV4 !== null) {
    [, address = "", port] = plainV4;
    if (isIP(address) !== 4) {
      return undefined;
    }
  } else if (isIPv6(item)) {
    address = item;
  } else {
    return undefined;
  }
  if (port === undefined) {
    return { address };
  }
  const number = Number(port);
  return number >= 1 && number <= 65_535 ? { address, port: number } : undefined;
}

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
 * Connect endpoint's secret, and settlements the key, with which the monthly drafts read the account's balance
 * transactions (FIX-W36-PLATFORM, lead decision (2g) of 2026-10-30).
 */
export const STRIPE_SWITCH_VARIABLES = Object.freeze({
  FEATURE_STRIPE_BILLING: Object.freeze(["STRIPE_SECRET_KEY", "STRIPE_BILLING_WEBHOOK_SECRET"] as const),
  FEATURE_OWN_STRIPE: Object.freeze([
    "STRIPE_SECRET_KEY",
    "STRIPE_CONNECT_CLIENT_ID",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
  ] as const),
  FEATURE_SETTLEMENTS: Object.freeze(["STRIPE_SECRET_KEY"] as const),
});

/**
 * The Amadeus Enterprise hosts of each environment (flows/amadeus-connection.md §D item 3): the defaults of
 * AMADEUS_BASE_URL_TEST and AMADEUS_BASE_URL_LIVE, and the only values `APP_ENV=production` accepts.
 */
export const AMADEUS_OFFICIAL_BASE_URLS = Object.freeze({
  AMADEUS_BASE_URL_TEST: "https://test.travel.api.amadeus.com",
  AMADEUS_BASE_URL_LIVE: "https://travel.api.amadeus.com",
} as const);

/**
 * An Amadeus base URL: an `https:` origin, or `http://127.0.0.1` with an optional port (the Amadeus stub of development
 * and tests: the rule of `platform.amadeus_accounts.base_url` and of the token check, AmadeusOAuthGateway), with an
 * optional trailing slash and nothing else: no path, query, fragment or user info. `amadeusBaseUrl` drops the slash.
 */
export const AMADEUS_BASE_URL_PATTERN =
  /^(?:https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?|http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?)\/?$/;

/** The Amadeus base URL variable of each environment of a connection. */
export const AMADEUS_BASE_URL_VARIABLES = Object.freeze({
  test: "AMADEUS_BASE_URL_TEST",
  live: "AMADEUS_BASE_URL_LIVE",
} as const);

/** The configured Amadeus base URL of `environment`, without a trailing slash (`https://test.travel.api.amadeus.com`). */
export function amadeusBaseUrl(
  config: Pick<PlatformBackendConfig, "AMADEUS_BASE_URL_TEST" | "AMADEUS_BASE_URL_LIVE">,
  environment: keyof typeof AMADEUS_BASE_URL_VARIABLES,
): string {
  return config[AMADEUS_BASE_URL_VARIABLES[environment]].replace(/\/$/, "");
}

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
   * The OTA admin's public base URL (`https://admin.ota.example.com`): `createConsoleToken` answers it with `/sso` as
   * the `consoleSsoUrl` the portal posts the one-time token to (PADR-0007 item 4, PBE-039), never a host taken from a
   * request. The API reads it; the worker and the CLI validate it too, because the three read `platform-backend.env`.
   */
  PUBLIC_OTA_ADMIN_URL: env.url({ protocols: ["http:", "https:"] }),
  /**
   * The OTA API's public base URL (`https://api.ota.example.com`), the OTA backend's own PUBLIC_OTA_API_URL: the
   * webhook URL of an OTA's own Stripe keys, `<PUBLIC_OTA_API_URL>/webhooks/stripe/c/<ppc_id>`, starts with it
   * (`submitStripeApiKeys` and every answered `api_keys` connection, PBE-057; FIX-W39-PLATFORM, lead decision (2m) of
   * 2026-11-02), never with a host taken from a request. An `https:` URL with `APP_ENV=production` (Stripe needs an
   * HTTPS endpoint, `publicOtaApiUrlProblems`); `http:` is allowed in development and tests (`http://localhost:4000`).
   * A base URL (a path is allowed), never with credentials, a query or a fragment. The API reads it; the worker and the CLI validate it too, because the three read `platform-backend.env`.
   * Its host, and every host below it, is a Velexis host that no OTA may add as a custom domain (`velexisHostsOf`,
   * FIX-W40-PLATFORM, lead decision (2a) of 2026-11-03).
   */
  PUBLIC_OTA_API_URL: env.url({ protocols: ["http:", "https:"] }),
  /**
   * The parent domain of every OTA's storefront sub-domain, `<key>.<STOREFRONT_BASE_DOMAIN>` (`ota.example.com`):
   * the host the key check shows (`checkTenantKey`), the sub-domain row of a new OTA and the TLS `ask` rule. No
   * default: a wrong domain in production would hand out hosts Velexis does not serve.
   */
  STOREFRONT_BASE_DOMAIN: env.string({ pattern: STOREFRONT_BASE_DOMAIN_PATTERN }),
  /**
   * The VM's public IPv4 and IPv6 addresses, where Caddy serves the storefronts (PBE-049, PADR-0004 item 2): the
   * routing records of a custom domain at a zone apex, which cannot have a CNAME, are `A <host> → STOREFRONT_IPV4` and
   * `AAAA <host> → STOREFRONT_IPV6`; `addDomain` and `listDomains` show them next to the CNAME, and the DNS
   * verification accepts A/AAAA records only among them. STOREFRONT_IPV4 is required while FEATURE_CUSTOM_DOMAINS is
   * on (STOREFRONT_ADDRESS_SWITCH_VARIABLES); STOREFRONT_IPV6 is optional (no `AAAA` record without it). The API reads
   * them; the worker validates them too, because both read `platform-backend.env`.
   */
  STOREFRONT_IPV4: env.string({ optional: true, pattern: IPV4_ADDRESS_PATTERN }),
  STOREFRONT_IPV6: env.string({ optional: true, pattern: IPV6_ADDRESS_CHARACTERS }),
  /**
   * The DNS resolvers of custom domain verification (PBE-050, PADR-0004 item 3): a comma-separated list of 1 to
   * MAX_DNS_RESOLVERS IP addresses, each with an optional port (`1.1.1.1,8.8.8.8`, `[2606:4700:4700::1111]:53`). The
   * worker's `node:dns` `Resolver` asks them, never the VM's caching resolver, so a new record is seen at once and a
   * stale local cache never verifies a domain. The default is two public resolvers, safe in production; the API
   * validates the value too, because both read `platform-backend.env`.
   */
  DNS_RESOLVERS: env.list({ pattern: DNS_RESOLVER_ITEM, default: DEFAULT_DNS_RESOLVERS }),
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
   * through `common/stripe/stripe.client.ts` only. Required while FEATURE_STRIPE_BILLING, FEATURE_OWN_STRIPE or
   * FEATURE_SETTLEMENTS is on (STRIPE_SWITCH_VARIABLES); a live key in production only, a test key everywhere else. A
   * secret: never logged.
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
  /**
   * The Amadeus host of each environment for the OTA's own credentials (PBE-053, flows/amadeus-connection.md §D): the
   * worker's token request that verifies a submission goes there, and the connection it switches stores it as its
   * `base_url`. The defaults are the official hosts (AMADEUS_OFFICIAL_BASE_URLS); another value, such as the Amadeus
   * stub `http://127.0.0.1:4900` of development and tests, is refused with `APP_ENV=production`
   * (`amadeusBaseUrlProblems`). An empty value counts as unset. The worker reads them; the API validates them too,
   * because both read `platform-backend.env`.
   */
  AMADEUS_BASE_URL_TEST: env.string({
    pattern: AMADEUS_BASE_URL_PATTERN,
    default: AMADEUS_OFFICIAL_BASE_URLS.AMADEUS_BASE_URL_TEST,
  }),
  AMADEUS_BASE_URL_LIVE: env.string({
    pattern: AMADEUS_BASE_URL_PATTERN,
    default: AMADEUS_OFFICIAL_BASE_URLS.AMADEUS_BASE_URL_LIVE,
  }),
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
      FEATURE_SETTLEMENTS: PLATFORM_BACKEND_CONFIG_SCHEMA.FEATURE_SETTLEMENTS,
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
 * The storefront address rules that a schema entry cannot express: STOREFRONT_IPV6 must be an IPv6 address (its
 * pattern only checks the characters), and a variable of STOREFRONT_ADDRESS_SWITCH_VARIABLES must be set while its
 * switch is on. A variable that is invalid on its own is reported by the schema, not here.
 */
function storefrontAddressProblems(source: EnvSource | undefined): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const ipv6 = validValues(
    { STOREFRONT_IPV6: PLATFORM_BACKEND_CONFIG_SCHEMA.STOREFRONT_IPV6 },
    source,
  )?.STOREFRONT_IPV6;
  if (ipv6 !== undefined && !isIPv6(ipv6)) {
    problems.push({ variable: "STOREFRONT_IPV6", reason: "must be an IPv6 address" });
  }
  const customDomains = validValues(
    { FEATURE_CUSTOM_DOMAINS: PLATFORM_BACKEND_CONFIG_SCHEMA.FEATURE_CUSTOM_DOMAINS },
    source,
  )?.FEATURE_CUSTOM_DOMAINS;
  if (customDomains === true) {
    for (const variable of STOREFRONT_ADDRESS_SWITCH_VARIABLES.FEATURE_CUSTOM_DOMAINS) {
      const value = validValues({ [variable]: PLATFORM_BACKEND_CONFIG_SCHEMA[variable] }, source);
      if (value !== undefined && value[variable] === undefined) {
        problems.push({ variable, reason: "is required while FEATURE_CUSTOM_DOMAINS is on" });
      }
    }
  }
  return problems;
}

/**
 * The DNS_RESOLVERS rules that a pattern cannot express: every item is an IP address of its family with a port of 1 to
 * 65535 when it has one, and there are at most MAX_DNS_RESOLVERS of them. A value that is invalid on its own is
 * reported by the schema, not here.
 */
function dnsResolverProblems(source: EnvSource | undefined): ConfigProblem[] {
  const items = validValues(
    { DNS_RESOLVERS: PLATFORM_BACKEND_CONFIG_SCHEMA.DNS_RESOLVERS },
    source,
  )?.DNS_RESOLVERS;
  if (items === undefined) {
    return [];
  }
  if (items.some((item) => parseDnsResolver(item) === undefined)) {
    return [
      {
        variable: "DNS_RESOLVERS",
        reason:
          "must list IP addresses, each with an optional port of 1 to 65535 (`[address]:port` for IPv6)",
      },
    ];
  }
  if (items.length > MAX_DNS_RESOLVERS) {
    return [{ variable: "DNS_RESOLVERS", reason: `must list at most ${MAX_DNS_RESOLVERS} resolvers` }];
  }
  return [];
}

/**
 * The Amadeus base URL rules that a pattern cannot express (PBE-053, flows/amadeus-connection.md §D item 3: the host is
 * "overridable only in development"): each value must be a URL whose port is at most 65535, and with
 * `APP_ENV=production` it must be the official host of its environment (AMADEUS_OFFICIAL_BASE_URLS), so a deployment
 * never sends an OTA's client secret anywhere else. A variable that is invalid on its own is reported by the schema,
 * not here.
 */
function amadeusBaseUrlProblems(source: EnvSource | undefined): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const appEnv = validValues({ APP_ENV: PLATFORM_BACKEND_CONFIG_SCHEMA.APP_ENV }, source)?.APP_ENV;
  for (const variable of Object.values(AMADEUS_BASE_URL_VARIABLES)) {
    const value = validValues({ [variable]: PLATFORM_BACKEND_CONFIG_SCHEMA[variable] }, source)?.[variable];
    if (value === undefined) {
      continue;
    }
    if (!URL.canParse(value)) {
      problems.push({ variable, reason: "must be a URL with a port of at most 65535" });
    } else if (appEnv === "production" && value.replace(/\/$/, "") !== AMADEUS_OFFICIAL_BASE_URLS[variable]) {
      problems.push({
        variable,
        reason: "must be the official Amadeus host of its environment with APP_ENV=production",
      });
    }
  }
  return problems;
}

/**
 * The PUBLIC_OTA_API_URL rules that a schema entry cannot express (FIX-W39-PLATFORM, lead decision (2m) of
 * 2026-11-02): a base URL the webhook path can follow, so without user name, password, query or fragment (the
 * `webhookUrl` of the contract admits none), in every environment; and with `APP_ENV=production` an `https:` URL,
 * because Stripe sends the webhooks of an OTA's own keys there and accepts no other endpoint. A value that is invalid
 * on its own is reported by the schema, not here; the reasons never hold the value.
 */
function publicOtaApiUrlProblems(source: EnvSource | undefined): ConfigProblem[] {
  const appEnv = validValues({ APP_ENV: PLATFORM_BACKEND_CONFIG_SCHEMA.APP_ENV }, source)?.APP_ENV;
  const url = validValues(
    { PUBLIC_OTA_API_URL: PLATFORM_BACKEND_CONFIG_SCHEMA.PUBLIC_OTA_API_URL },
    source,
  )?.PUBLIC_OTA_API_URL;
  if (url === undefined) {
    return [];
  }
  // The schema has parsed the value: `new URL` does not throw here. An empty `?` or `#` leaves `search` and `hash`
  // empty, so the text itself is checked for them.
  const parsed = new URL(url);
  if (parsed.username !== "" || parsed.password !== "" || url.includes("?") || url.includes("#")) {
    return [
      { variable: "PUBLIC_OTA_API_URL", reason: "must be a base URL without credentials, query or fragment" },
    ];
  }
  return appEnv === "production" && parsed.protocol !== "https:"
    ? [{ variable: "PUBLIC_OTA_API_URL", reason: "must be an https URL with APP_ENV=production" }]
    : [];
}

/**
 * Validates the configuration in `source` (default: the process environment) and returns it deep-frozen. Throws one
 * `ConfigError` that names every invalid variable and the reason, never a value.
 */
export function parseConfig(source?: EnvSource): PlatformBackendConfig {
  const problems = [
    ...trustProxyProblems(source),
    ...stripeProblems(source),
    ...storefrontAddressProblems(source),
    ...dnsResolverProblems(source),
    ...amadeusBaseUrlProblems(source),
    ...publicOtaApiUrlProblems(source),
  ];
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
