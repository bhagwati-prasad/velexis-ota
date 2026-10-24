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
import { API_KEY_PEPPER_MIN_BYTES, SIGNED_URL_KEY_MIN_BYTES } from "@velexis/crypto";
import { STORAGE_DRIVERS } from "@velexis/db/storage";

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

/**
 * A host name in lower case, without a trailing dot, of at least two labels: the rule of `redis.keys.ts` and of the
 * `domain` invalidation event (PADR-0004 item 1).
 */
const HOST_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `MASTER_KEY_CURRENT`: a KEK id of `LocalFileKeyProvider`, `local:v<N>` with N >= 1 and no leading zeros. */
const KEK_ID = /^local:v[1-9][0-9]{0,8}$/;

/**
 * An e-mail address without anchors: the `email` format of ajv-formats ("full" mode, the one the OpenAPI validation
 * uses; dot-atom local part, two or more labels), as the platform backend's configuration has it.
 */
const ADDRESS =
  "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/**
 * One e-mail address as the OTA backend sends to it: the `email` format of the OpenAPI validation, ASCII only and at
 * most 254 characters. Nothing SMTP or Nodemailer could read as several addresses, a display name or a comment passes
 * (no spaces, quotes, angle brackets, commas, parentheses or line breaks).
 */
export const EMAIL_ADDRESS = new RegExp(`^(?=.{3,254}$)${ADDRESS}$`, "i");

/**
 * MAIL_FROM: an address, or a display name and the address in angle brackets (`"Velexis OTA" <no-reply@…>`,
 * `Velexis OTA <no-reply@…>`). One line, one address. The notifications module sends from its address with the OTA's
 * brand name as the display name (OADR-0013 item 5); the display name here is used only where no brand is known.
 */
export const MAIL_FROM_PATTERN = new RegExp(
  `^(?:${ADDRESS}|(?:"[^"\\\\\\r\\n]*"|[^"<>,;:@\\\\\\r\\n]*?)\\s*<${ADDRESS}>)$`,
  "i",
);

/**
 * The keys of the Velexis Stripe account per environment (ADR-0011 (A), OADR-0010 point 1): a secret or restricted key
 * (`sk_…`, `rk_…`) and a publishable key (`pk_…`) of that mode, so a live key never sits in a test variable or the
 * other way round. Each is optional: an environment without both keys has no `velexis`-mode payments (`424
 * PAYMENT_PROVIDER_NOT_CONFIGURED`, and `storefront.get` lists no payment method), so the API starts on a VM whose
 * Stripe keys are not filled in yet (provision-vm.sh: "Stripe when needed"); the live keys stay empty until the M6
 * launch checklist. A refused value is named, never printed (@velexis/config).
 */
export const STRIPE_KEY_PATTERNS = Object.freeze({
  secret: { test: /^(?:sk|rk)_test_[A-Za-z0-9_]+$/, live: /^(?:sk|rk)_live_[A-Za-z0-9_]+$/ },
  publishable: { test: /^pk_test_[A-Za-z0-9_]+$/, live: /^pk_live_[A-Za-z0-9_]+$/ },
});

/**
 * A Stripe webhook signing secret (`whsec_…`, OADR-0010 point 4): the Dashboard's and the Stripe CLI's secrets are
 * `whsec_` and letters and digits; the base64 characters are accepted too. A refused value is named, never printed.
 */
export const STRIPE_WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/=_-]{8,}$/;

/** The storage folder on the VM (ADR-0017; `velexis-ota`'s, mode 0700, provision-vm.sh): STORAGE_DIR's default. */
export const DEFAULT_STORAGE_DIR = "/var/lib/velexis/storage";

/** Variables of both processes. */
const sharedSchema = {
  APP_ENV: env.enum(["development", "test", "production"] as const),
  LOG_LEVEL: env.enum(["debug", "info", "warn", "error"] as const, { default: "info" }),
  // Role velexis_ota_app: DML on tenant schemas, SELECT on reference and on selected platform tables (ADR-0004).
  DATABASE_URL: env.url({ protocols: POSTGRES_PROTOCOLS }),
  REDIS_URL: env.url({ protocols: REDIS_PROTOCOLS }),
  // The OTA zone's key folder (ADR-0010, ADR-0026): every `master-v<N>.key` in it is the KEK `local:v<N>`, and
  // MASTER_KEY_CURRENT names the one that wraps new data keys (identical copies of the platform zone's files, so the
  // OTA backend decrypts the Amadeus secrets the platform encrypted). The API loads them in the Amadeus module
  // (OBE-017: client secrets, cached access tokens), the HTTP module (OBE-014: idempotent replays that carry a token in
  // `idempotency_keys.response_ciphertext`), the checkout module (OBE-036: travellers' documents) and the notifications
  // module (OBE-030: the secret variables of an e-mail it queues); the worker in the notifications module, which
  // decrypts `notifications.secret_payload_ciphertext` to render an e-mail.
  MASTER_KEY_DIR: env.dir(),
  MASTER_KEY_CURRENT: env.string({ pattern: KEK_ID }),
  // `<key>.<STOREFRONT_BASE_DOMAIN>` is a tenant's storefront sub-domain (ADR-0018, OADR-0009 point 2): the API
  // resolves edge requests by it, and the worker builds the links of e-mails on it (OADR-0015 point 5, OBE-030).
  STOREFRONT_BASE_DOMAIN: env.string({ pattern: HOST_NAME }),
  // The Velexis Stripe account (OBE-038; STRIPE_KEY_PATTERNS above): the keys of `velexis`-mode payments (and of
  // `connect_standard` from M5) per environment. Only the payments module reads them
  // (src/payments/stripe/stripe-client.factory.ts): the API creates, reads and updates PaymentIntents and hands the
  // publishable key to the storefront through storefront.get; the worker reads the PaymentIntents, charges, refunds and
  // disputes of the webhook events again (OBE-039, OADR-0010 point 5), and from OBE-040 voids, captures and refunds.
  // Both units read ota-backend.env, which holds them.
  STRIPE_SECRET_KEY_TEST: env.string({ pattern: STRIPE_KEY_PATTERNS.secret.test, optional: true }),
  STRIPE_PUBLISHABLE_KEY_TEST: env.string({ pattern: STRIPE_KEY_PATTERNS.publishable.test, optional: true }),
  STRIPE_SECRET_KEY_LIVE: env.string({ pattern: STRIPE_KEY_PATTERNS.secret.live, optional: true }),
  STRIPE_PUBLISHABLE_KEY_LIVE: env.string({ pattern: STRIPE_KEY_PATTERNS.publishable.live, optional: true }),
  // The StorageAdapter of @velexis/db/storage (ADR-0017, OADR-0013 items 7 and 9; OBE-053, OBE-054): `local` (the MVP)
  // keeps the objects as files under STORAGE_DIR, an existing folder (checked here; `.local/storage` locally, which
  // `pnpm dev:keys` creates). The worker's documents module writes the rendered PDFs there (`tenant_<key>/documents/…`)
  // and reads the storefront's square logo from it (`tenant_<key>/assets/…`); the API's reads the PDFs it serves at
  // their signed URLs (`GET /v1/files/…`, OBE-054). `s3` passes this check, but the adapter refuses it until an S3
  // adapter exists, so neither process starts with it. Both units read ota-backend.env, which holds them.
  STORAGE_DRIVER: env.enum(STORAGE_DRIVERS, { default: "local" }),
  STORAGE_DIR: env.dir({ default: DEFAULT_STORAGE_DIR }),
  // Velexis ops, one plain address (EMAIL_ADDRESS): the last recipient of an OTA's staff alerts, after the OTA's
  // `ops_alert_email` and its owners (notifications/staff-recipients.ts, OADR-0013 item 5), and the recipient of the
  // operational alerts of the OTA backend (airline-card abuse, refused Amadeus credentials; OADR-0004). Both processes
  // raise staff alerts (checkout.complete, a refresh and the console in the API; the jobs in the worker), so both read
  // it since FIX-W28-NOTIFY (lead decision (4) of 2026-10-23); before, only the worker had it and the API skipped an
  // alert of an OTA without an address or an owner. Optional: without it such an alert is skipped and logged. Both
  // units read ota-backend.env, which holds it.
  OPS_ALERT_EMAIL: env.string({ pattern: EMAIL_ADDRESS, optional: true }),
} as const;

/**
 * The storefront edge credential (ADR-0018): at least 24 characters of `[A-Za-z0-9_-]`. provision-vm.sh generates 48
 * hex characters, the development value of the `.env.example` files has 25; an empty value and the unsubstituted
 * `@@EDGE_SECRET@@` placeholder of the deploy template are refused.
 */
const EDGE_SECRET = /^[A-Za-z0-9_-]{24,}$/;

/**
 * The OTA admin's first-party service key (ADR-0008, OADR-0009 rule 1.2): `sk_` and at least 16 of `[A-Za-z0-9_]`, the
 * pattern the OTA admin's own configuration checks (ota/admin/src/config.ts). provision-vm.sh generates `sk_svc_` and 48
 * hex characters, the development value of the `.env.example` files is `sk_dev_…`; an empty value and the
 * unsubstituted `@@OTA_ADMIN_SERVICE_KEY@@` placeholder are refused.
 */
export const SERVICE_KEY_PATTERN = /^sk_[A-Za-z0-9_]{16,}$/;

/**
 * The DER length of an Ed25519 private key in PKCS#8 (`openssl genpkey -algorithm ed25519`, `pnpm dev:keys`): the
 * least JWT_PRIVATE_KEY_FILE may hold. The identity module's TokenService also checks that the key is Ed25519.
 */
export const JWT_PRIVATE_KEY_MIN_BYTES = 48;

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
  // The OTA admin's first-party service key (OBE-060; ADR-0008, OADR-0009 rule 1.2, OADR-0011 point 4): `X-Api-Key`
  // equal to it (constant time) on a direct loopback connection without X-Forwarded-For or X-Forwarded-Host is the
  // service caller, which may call console operations only, with a staff token. The same value is in ota-admin.env;
  // never logged (the logger redacts X-Api-Key).
  OTA_ADMIN_SERVICE_KEY: env.string({ pattern: SERVICE_KEY_PATTERN }),
  // The HMAC pepper of API key hashes (PADR-0005 item 3): an identical copy of the platform's file in the OTA zone's
  // key folder (ADR-0026). Checked at start-up (mode 0400 or 0600, at least 32 bytes after base64 decoding); the
  // configuration holds the path, and the tenancy module reads the key once.
  API_KEY_PEPPER_FILE: env.secretFile({ minBytes: API_KEY_PEPPER_MIN_BYTES }),
  // The OTA backend's own Ed25519 signing key (ADR-0008, architecture §3.2): customer access tokens (OBE-031) and
  // later staff tokens, with its JWK thumbprint as `kid`. A PKCS#8 PEM file of mode 0400 or 0600 in the OTA zone's key
  // folder, never the platform's key. Checked here and read once by the identity module's TokenService, which refuses
  // a key that is not Ed25519. Only the API signs and verifies tokens; the worker does not read it.
  JWT_PRIVATE_KEY_FILE: env.secretFile({ minBytes: JWT_PRIVATE_KEY_MIN_BYTES, encoding: "pem" }),
  // The HMAC key of the signed document URLs (ADR-0010, ADR-0017, OADR-0013 item 9; OBE-054): `document-url.key` of
  // the OTA zone's key folder only (the platform never has it), 32 random bytes in base64, mode 0400 or 0600. Checked at
  // start-up and read once by the documents module, which signs `GET /v1/files/<storageKey>?exp=…&sig=…` with it for
  // bookings.getDocumentDownloadUrl and checks the signature of every download. Only the API signs and verifies; the
  // worker does not read it.
  DOCUMENT_URL_KEY_FILE: env.secretFile({ minBytes: SIGNED_URL_KEY_MIN_BYTES }),
  // The API's public origin, for absolute URLs given to key callers (asset and file links; ADR-0018).
  PUBLIC_OTA_API_URL: env.url({ protocols: ["https:", "http:"] }),
  // Optional overrides of the Amadeus host per environment (the stub, http://127.0.0.1:4900, in development and CI);
  // empty on the VM, where the connection's or the shared account's base_url is used (OADR-0001 point 4).
  AMADEUS_BASE_URL_TEST: amadeusBaseUrl(),
  AMADEUS_BASE_URL_LIVE: amadeusBaseUrl(),
  // The signing secrets of the Velexis account's webhook endpoints, `/webhooks/stripe/velexis/{test,live}` (OBE-039,
  // OADR-0010 point 4). Optional: an environment without its secret refuses every delivery with `400` (Stripe keeps
  // sending it, so nothing is lost once the secret is set); the live one stays empty until the M6 launch checklist.
  // Only the webhook receiver reads them (src/payments/webhooks/webhook-receiver.service.ts); never logged.
  STRIPE_WEBHOOK_SECRET_VELEXIS_TEST: env.string({ pattern: STRIPE_WEBHOOK_SECRET_PATTERN, optional: true }),
  STRIPE_WEBHOOK_SECRET_VELEXIS_LIVE: env.string({ pattern: STRIPE_WEBHOOK_SECRET_PATTERN, optional: true }),
  // The global kill switch of the airline-card method (ADR-0011, OADR-0004 point 1; OBE-050), `false` by default
  // (`true`, `false`, `1` or `0`; anything else is refused at start-up). Off, checkout.createPayment refuses
  // `airline_card` (`403 FEATURE_DISABLED`) and storefront.get never lists it, whatever the tenants' settings say.
  // `true` in development and CI only until the M6 security review (OBE-086); `false` in the deploy template.
  AIRLINE_CARD_ENABLED: env.bool({ default: false }),
} as const;

/** The worker process (`dist/worker.js`, unit velexis-ota-worker). */
export const workerConfigSchema = {
  ...sharedSchema,
  // The unit sets HEALTH_PORT=4001; the worker serves /health/* on 127.0.0.1 only.
  HEALTH_PORT: env.port({ default: 4001 }),
  // Role velexis_provisioner: tenant provisioning and migrations (CREATE on the database, owner of the tenant schemas,
  // nothing on platform or reference; ADR-0004). /etc/velexis/ota-worker.env on the VM. Never used to serve requests.
  DATABASE_PROVISIONER_URL: env.url({ protocols: POSTGRES_PROTOCOLS }),
  // E-mail (ADR-0017, OADR-0013 item 5): only the worker sends, through SMTP (Mailpit `smtp://127.0.0.1:1025` in
  // development), from the address of MAIL_FROM with the OTA's brand name as the display name.
  SMTP_URL: env.url({ protocols: ["smtp:", "smtps:"] }),
  MAIL_FROM: env.string({ pattern: MAIL_FROM_PATTERN }),
  // The OTA admin's public base URL: the links of staff alert e-mails (OADR-0013 item 4).
  PUBLIC_OTA_ADMIN_URL: env.url({ protocols: ["https:", "http:"] }),
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
