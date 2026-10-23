import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError } from "@velexis/config";
import { describe, expect, it, vi } from "vitest";
import { testApiCredentials, testApiVariables, testWorkerVariables } from "../test/helpers/api-env";
import {
  apiConfigSchema,
  APP_DIR,
  DEFAULT_STORAGE_DIR,
  loadApiConfig,
  loadWorkerConfig,
  workerConfigSchema,
  type ApiConfig,
  type WorkerConfig,
} from "./config";

const REPO_ROOT = join(APP_DIR, "..", "..");

/** Dummy values of the shape the VM uses; nothing here is a real secret. */
const SHARED = {
  APP_ENV: "production",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgres://velexis_ota_app:dummy-ota-password@127.0.0.1:5432/velexis",
  REDIS_URL: "redis://:dummy-redis-password@127.0.0.1:6379/0",
} as const;
const PROVISIONER_URL = "postgres://velexis_provisioner:dummy-provisioner-password@127.0.0.1:5432/velexis";
const MIGRATOR_URL = "postgres://velexis_migrator:dummy-migrator-password@127.0.0.1:5432/velexis";
/** The worker's variables besides the services (OBE-030): the key folder, the base domain and the e-mail settings. */
const WORKER_VARIABLES = testWorkerVariables();
const WORKER_ENV = { ...SHARED, DATABASE_PROVISIONER_URL: PROVISIONER_URL, ...WORKER_VARIABLES } as const;
/**
 * The API's variables of the test process (OBE-011): a random edge secret, the key files of this test process and the
 * storage folder it shares with the worker (OBE-054).
 */
const API_ONLY = testApiVariables();
/** The API's variables that the worker does not read: the caller credentials, the URL key and the API's public URL. */
const API_ONLY_NAMES = [
  "VELEXIS_EDGE_SECRET",
  "OTA_ADMIN_SERVICE_KEY",
  "API_KEY_PEPPER_FILE",
  "JWT_PRIVATE_KEY_FILE",
  "DOCUMENT_URL_KEY_FILE",
  "PUBLIC_OTA_API_URL",
];
const API_ENV = { ...SHARED, ...API_ONLY } as const;

function configErrorOf(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConfigError");
}

function readEnvFile(path: string): Record<string, string> {
  const parsed = parseEnv(readFileSync(path, "utf8"));
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** What provision-vm.sh's `gen_secret` writes: `openssl rand -hex 24`, 48 hex characters (a dummy value here). */
const GENERATED_SECRET = "0123456789abcdef".repeat(3);

/**
 * What provision-vm.sh generates for a placeholder: `sk_svc_` and a secret for the OTA admin's service key (its
 * `OTA_ADMIN_SERVICE_KEY=sk_svc_$(gen_secret)`), a bare secret for every other one.
 */
const generatedValue = (placeholder: string): string =>
  placeholder === "@@OTA_ADMIN_SERVICE_KEY@@" ? `sk_svc_${GENERATED_SECRET}` : GENERATED_SECRET;

/** A deploy/env template with its `@@NAME@@` placeholders replaced, as provision-vm.sh does with generated values. */
function renderedTemplate(name: string): Record<string, string> {
  const text = readFileSync(join(REPO_ROOT, "deploy/env", name), "utf8").replace(
    /@@[A-Z_]+@@/g,
    generatedValue,
  );
  return Object.fromEntries(
    Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe("a missing DATABASE_URL", () => {
  it("fails the API's configuration with a ConfigError naming DATABASE_URL [OBE-001 AC3]", () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = API_ENV;

    const error = configErrorOf(() => loadApiConfig(withoutUrl));

    expect(error.problems).toEqual([{ variable: "DATABASE_URL", reason: "is required but missing" }]);
    expect(error.message).toContain("DATABASE_URL");
  });

  it("fails the worker's configuration with a ConfigError naming DATABASE_URL [OBE-001 AC3]", () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = WORKER_ENV;

    const error = configErrorOf(() => loadWorkerConfig(withoutUrl));

    expect(error.problems).toEqual([{ variable: "DATABASE_URL", reason: "is required but missing" }]);
  });

  it("counts an empty value as missing", () => {
    const error = configErrorOf(() => loadApiConfig({ ...API_ENV, DATABASE_URL: "" }));

    expect(error.problems.map((problem) => problem.variable)).toEqual(["DATABASE_URL"]);
  });
});

describe("the privileged DSNs", () => {
  it("never appear in the API's configuration, even when they are set [OBE-001 AC3]", () => {
    const config: ApiConfig = loadApiConfig({
      ...API_ENV,
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
      DATABASE_MIGRATOR_URL: MIGRATOR_URL,
    });

    expect(Object.keys(config).sort()).toEqual([
      "AIRLINE_CARD_ENABLED",
      "AMADEUS_BASE_URL_LIVE",
      "AMADEUS_BASE_URL_TEST",
      "API_KEY_PEPPER_FILE",
      "APP_ENV",
      "DATABASE_URL",
      "DOCUMENT_URL_KEY_FILE",
      "JWT_PRIVATE_KEY_FILE",
      "LOG_LEVEL",
      "MASTER_KEY_CURRENT",
      "MASTER_KEY_DIR",
      "OTA_ADMIN_SERVICE_KEY",
      "PORT",
      "PUBLIC_OTA_API_URL",
      "REDIS_URL",
      "STORAGE_DIR",
      "STORAGE_DRIVER",
      "STOREFRONT_BASE_DOMAIN",
      "STRIPE_PUBLISHABLE_KEY_LIVE",
      "STRIPE_PUBLISHABLE_KEY_TEST",
      "STRIPE_SECRET_KEY_LIVE",
      "STRIPE_SECRET_KEY_TEST",
      "STRIPE_WEBHOOK_SECRET_VELEXIS_LIVE",
      "STRIPE_WEBHOOK_SECRET_VELEXIS_TEST",
      "TRUST_PROXY",
      "VELEXIS_EDGE_SECRET",
    ]);
    expect(JSON.stringify(config)).not.toContain("velexis_provisioner");
    expect(JSON.stringify(config)).not.toContain("velexis_migrator");
    // @ts-expect-error The API's configuration type has no worker DSN either.
    expect(config.DATABASE_PROVISIONER_URL).toBeUndefined();
  });

  it("are not required by the API: it starts without the worker's DSN [OBE-001 AC3]", () => {
    expect(loadApiConfig(API_ENV).DATABASE_URL).toBe(SHARED.DATABASE_URL);
  });

  it("give the worker its provisioner DSN and never the migrator DSN [OBE-001 AC3]", () => {
    const config: WorkerConfig = loadWorkerConfig({ ...WORKER_ENV, DATABASE_MIGRATOR_URL: MIGRATOR_URL });

    expect(config.DATABASE_PROVISIONER_URL).toBe(PROVISIONER_URL);
    expect(Object.keys(config).sort()).toEqual([
      "APP_ENV",
      "DATABASE_PROVISIONER_URL",
      "DATABASE_URL",
      "HEALTH_PORT",
      "LOG_LEVEL",
      "MAIL_FROM",
      "MASTER_KEY_CURRENT",
      "MASTER_KEY_DIR",
      "OPS_ALERT_EMAIL",
      "PUBLIC_OTA_ADMIN_URL",
      "REDIS_URL",
      "SMTP_URL",
      "STORAGE_DIR",
      "STORAGE_DRIVER",
      "STOREFRONT_BASE_DOMAIN",
      "STRIPE_PUBLISHABLE_KEY_LIVE",
      "STRIPE_PUBLISHABLE_KEY_TEST",
      "STRIPE_SECRET_KEY_LIVE",
      "STRIPE_SECRET_KEY_TEST",
    ]);
    expect(JSON.stringify(config)).not.toContain("velexis_migrator");
  });

  it("make the worker refuse to start without DATABASE_PROVISIONER_URL [OBE-001 AC3]", () => {
    const { DATABASE_PROVISIONER_URL: _omitted, ...withoutProvisioner } = WORKER_ENV;
    const error = configErrorOf(() => loadWorkerConfig(withoutProvisioner));

    expect(error.problems).toEqual([
      { variable: "DATABASE_PROVISIONER_URL", reason: "is required but missing" },
    ]);
  });

  it("stay out of the API's env file on the VM: only ota-worker.env holds the provisioner DSN", () => {
    const shared = renderedTemplate("ota-backend.env.example");
    const worker = renderedTemplate("ota-worker.env.example");

    expect(shared).not.toHaveProperty("DATABASE_PROVISIONER_URL");
    expect(shared).not.toHaveProperty("DATABASE_MIGRATOR_URL");
    expect(Object.keys(worker)).toEqual(["DATABASE_PROVISIONER_URL"]);
    const apiUnit = readFileSync(join(REPO_ROOT, "deploy/systemd/velexis-ota-api.service"), "utf8");
    expect(apiUnit).toMatch(/^InaccessiblePaths=.*-\/etc\/velexis\/ota-worker\.env/m);
    expect(apiUnit).not.toContain("EnvironmentFile=/etc/velexis/ota-worker.env");
  });
});

describe("values", () => {
  it("returns frozen configurations with the defaults of README §3", () => {
    const api = loadApiConfig({
      APP_ENV: "test",
      DATABASE_URL: SHARED.DATABASE_URL,
      REDIS_URL: SHARED.REDIS_URL,
      ...API_ONLY,
    });
    const worker = loadWorkerConfig({
      APP_ENV: "test",
      DATABASE_URL: SHARED.DATABASE_URL,
      REDIS_URL: SHARED.REDIS_URL,
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
      ...WORKER_VARIABLES,
    });

    expect(api).toEqual({
      APP_ENV: "test",
      LOG_LEVEL: "info",
      DATABASE_URL: SHARED.DATABASE_URL,
      REDIS_URL: SHARED.REDIS_URL,
      PORT: 4000,
      TRUST_PROXY: ["loopback"],
      AIRLINE_CARD_ENABLED: false,
      STORAGE_DRIVER: "local",
      ...API_ONLY,
    });
    expect(worker.HEALTH_PORT).toBe(4001);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.TRUST_PROXY)).toBe(true);
    expect(Object.isFrozen(worker)).toBe(true);
  });

  it("names every invalid variable at once and never echoes a value", () => {
    const secret = "dummy-secret-that-must-never-be-printed";
    const error = configErrorOf(() =>
      loadWorkerConfig({
        ...WORKER_VARIABLES,
        APP_ENV: "staging",
        LOG_LEVEL: "verbose",
        DATABASE_URL: `mysql://user:${secret}@127.0.0.1/velexis`,
        REDIS_URL: `http://:${secret}@127.0.0.1:6379`,
        HEALTH_PORT: "70000",
        DATABASE_PROVISIONER_URL: secret,
      }),
    );

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      "APP_ENV",
      "DATABASE_PROVISIONER_URL",
      "DATABASE_URL",
      "HEALTH_PORT",
      "LOG_LEVEL",
      "REDIS_URL",
    ]);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("staging");
  });

  it("accepts trusted proxies as presets, addresses and CIDR ranges", () => {
    const config = loadApiConfig({
      ...API_ENV,
      TRUST_PROXY: "loopback, uniquelocal,10.0.0.0/8,::1,fd00::/8",
    });

    expect(config.TRUST_PROXY).toEqual(["loopback", "uniquelocal", "10.0.0.0/8", "::1", "fd00::/8"]);
  });

  it("refuses a TRUST_PROXY that would believe any client's X-Forwarded-For", () => {
    for (const value of [
      "true",
      "*",
      "1",
      "all",
      "10.0.0.0/33",
      "::/129",
      "0.0.0.0/0",
      "::/0",
      "10.0.0.1/8/1",
      "proxy.example.net",
    ]) {
      const error = configErrorOf(() => loadApiConfig({ ...API_ENV, TRUST_PROXY: value }));

      expect(error.problems.map((problem) => problem.variable)).toEqual(["TRUST_PROXY"]);
    }
  });
});

describe("the caller credentials of the API (OBE-011)", () => {
  it("are required: the API names every missing one, the worker reads none of them", () => {
    // The storage folder of the test process stands in for the VM's, STORAGE_DIR's default (checked below).
    const error = configErrorOf(() =>
      loadApiConfig({ ...SHARED, STORAGE_DIR: API_ONLY["STORAGE_DIR"] ?? "missing" }),
    );
    const worker = loadWorkerConfig({ ...WORKER_ENV, ...API_ONLY });

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      "API_KEY_PEPPER_FILE",
      "DOCUMENT_URL_KEY_FILE",
      "JWT_PRIVATE_KEY_FILE",
      "MASTER_KEY_CURRENT",
      "MASTER_KEY_DIR",
      "OTA_ADMIN_SERVICE_KEY",
      "PUBLIC_OTA_API_URL",
      "STOREFRONT_BASE_DOMAIN",
      "VELEXIS_EDGE_SECRET",
    ]);
    for (const name of API_ONLY_NAMES) {
      expect(worker).not.toHaveProperty(name);
    }
  });

  it("refuse a short edge secret and the deploy template's placeholder without printing either", () => {
    for (const value of ["@@EDGE_SECRET@@", "short-edge-secret", "an edge secret with spaces in it"]) {
      const error = configErrorOf(() => loadApiConfig({ ...API_ENV, VELEXIS_EDGE_SECRET: value }));

      expect(error.problems.map((problem) => problem.variable)).toEqual(["VELEXIS_EDGE_SECRET"]);
      expect(error.message).not.toContain(value);
    }
  });

  it("refuse an empty or short service key and the deploy template's placeholder without printing either [OBE-060]", () => {
    for (const value of [
      "@@OTA_ADMIN_SERVICE_KEY@@",
      "sk_short",
      "pk_test_not_a_service_key_at_all",
      "sk_with space_x",
    ]) {
      const error = configErrorOf(() => loadApiConfig({ ...API_ENV, OTA_ADMIN_SERVICE_KEY: value }));

      expect(error.problems.map((problem) => problem.variable)).toEqual(["OTA_ADMIN_SERVICE_KEY"]);
      expect(error.message).not.toContain(value);
    }
    expect(loadApiConfig(API_ENV).OTA_ADMIN_SERVICE_KEY).toBe(testApiCredentials().serviceKey);
  });

  it("refuse a pepper file that others may read, that is shorter than 32 bytes or that is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "velexis-ota-pepper-"));
    try {
      const readable = join(dir, "readable");
      copyFileSync(testApiCredentials().pepperFile, readable);
      chmodSync(readable, 0o644);
      const short = join(dir, "short");
      writeFileSync(short, Buffer.alloc(16, 7).toString("base64"), { mode: 0o600 });

      for (const file of [readable, short, join(dir, "missing")]) {
        const error = configErrorOf(() => loadApiConfig({ ...API_ENV, API_KEY_PEPPER_FILE: file }));

        expect(error.problems.map((problem) => problem.variable)).toEqual(["API_KEY_PEPPER_FILE"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuse a signing key file that others may read, that holds no PEM block or that is missing (OBE-031)", () => {
    const dir = mkdtempSync(join(tmpdir(), "velexis-ota-jwt-"));
    try {
      const readable = join(dir, "readable.pem");
      copyFileSync(testApiCredentials().jwtKeyFile, readable);
      chmodSync(readable, 0o644);
      const notPem = join(dir, "not-pem");
      writeFileSync(notPem, Buffer.alloc(64, 7).toString("base64"), { mode: 0o600 });

      for (const file of [readable, notPem, join(dir, "missing.pem")]) {
        const error = configErrorOf(() => loadApiConfig({ ...API_ENV, JWT_PRIVATE_KEY_FILE: file }));

        expect(error.problems.map((problem) => problem.variable)).toEqual(["JWT_PRIVATE_KEY_FILE"]);
      }
      expect(loadApiConfig(API_ENV).JWT_PRIVATE_KEY_FILE).toBe(testApiCredentials().jwtKeyFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuse a base domain that is not a lower-case host name, and a public URL that is not http(s)", () => {
    for (const domain of [
      "OTA.example.com",
      "ota.example.com.",
      "localhost",
      "https://ota.example.com",
      "10.0.0.1",
    ]) {
      const error = configErrorOf(() => loadApiConfig({ ...API_ENV, STOREFRONT_BASE_DOMAIN: domain }));

      expect([domain, error.problems.map((problem) => problem.variable)]).toEqual([
        domain,
        ["STOREFRONT_BASE_DOMAIN"],
      ]);
    }
    const error = configErrorOf(() =>
      loadApiConfig({ ...API_ENV, PUBLIC_OTA_API_URL: "ftp://api.ota.example.com" }),
    );

    expect(error.problems.map((problem) => problem.variable)).toEqual(["PUBLIC_OTA_API_URL"]);
  });
});

describe("the envelope keys and the Amadeus base URLs of the API (OBE-017, OBE-014)", () => {
  it("require a key folder that exists and a current KEK id local:v<N>, in both processes (OBE-030)", () => {
    const missingDir = join(tmpdir(), `velexis-ota-no-keys-${process.pid}`);
    for (const [name, value] of [
      ["MASTER_KEY_DIR", missingDir],
      ["MASTER_KEY_DIR", testApiCredentials().pepperFile],
      ["MASTER_KEY_CURRENT", "v1"],
      ["MASTER_KEY_CURRENT", "local:v01"],
      ["MASTER_KEY_CURRENT", "local:v0"],
      ["MASTER_KEY_CURRENT", "kms:key-1"],
    ] as const) {
      const error = configErrorOf(() => loadApiConfig({ ...API_ENV, [name]: value }));
      const workerError = configErrorOf(() => loadWorkerConfig({ ...WORKER_ENV, [name]: value }));

      expect([value, error.problems.map((problem) => problem.variable)]).toEqual([value, [name]]);
      expect([value, workerError.problems.map((problem) => problem.variable)]).toEqual([value, [name]]);
    }
    // The worker decrypts the secret values of the e-mails it sends (OBE-030); the Amadeus overrides stay the API's.
    const worker = loadWorkerConfig({ ...WORKER_ENV, ...API_ONLY });
    expect(worker.MASTER_KEY_DIR).toBe(testApiCredentials().masterKeyDir);
    expect(worker.MASTER_KEY_CURRENT).toBe("local:v1");
    expect(worker).not.toHaveProperty("AMADEUS_BASE_URL_TEST");
  });

  it("accept an https origin, or http on the loopback interface, and give the origin without a slash", () => {
    const config = loadApiConfig({
      ...API_ENV,
      AMADEUS_BASE_URL_TEST: "http://127.0.0.1:4900/",
      AMADEUS_BASE_URL_LIVE: "https://travel.api.amadeus.com",
    });

    expect(config.AMADEUS_BASE_URL_TEST).toBe("http://127.0.0.1:4900");
    expect(config.AMADEUS_BASE_URL_LIVE).toBe("https://travel.api.amadeus.com");
    for (const origin of ["http://localhost:4900", "http://[::1]:4900"]) {
      expect(loadApiConfig({ ...API_ENV, AMADEUS_BASE_URL_TEST: origin }).AMADEUS_BASE_URL_TEST).toBe(origin);
    }
    expect(loadApiConfig({ ...API_ENV, AMADEUS_BASE_URL_TEST: "" }).AMADEUS_BASE_URL_TEST).toBeUndefined();
  });

  it("refuse a base URL that would send the client secret in clear text, or that is not an origin", () => {
    for (const value of [
      "http://test.travel.api.amadeus.com",
      "http://10.0.0.5:4900",
      "ftp://127.0.0.1:4900",
      "https://test.travel.api.amadeus.com/v1",
      "https://test.travel.api.amadeus.com/?x=1",
      "https://user:dummy-password@test.travel.api.amadeus.com",
      "not a url",
    ]) {
      const error = configErrorOf(() => loadApiConfig({ ...API_ENV, AMADEUS_BASE_URL_LIVE: value }));

      expect([value, error.problems.map((problem) => problem.variable)]).toEqual([
        value,
        ["AMADEUS_BASE_URL_LIVE"],
      ]);
      expect(error.message).not.toContain("dummy-password");
    }
  });
});

describe("the Stripe keys of the Velexis account (OBE-038)", () => {
  /** Keys of the documented shapes, built at run time; none is a real key. */
  const fake = (prefix: string): string => `${prefix}_${"0123456789abcdefABCDEF".repeat(2)}`;

  // OBE-038 gave the keys to the API only. Since OBE-039 the worker reads them too: its stripe.event processor reads
  // the webhook events' PaymentIntents, charges, refunds and disputes again from Stripe (OADR-0010 point 5), so the
  // keys moved to the variables of both processes (both units read ota-backend.env, which holds them).
  it("are optional in both processes, so neither needs them to start; the worker reads them since OBE-039", () => {
    const api = loadApiConfig(API_ENV);
    const worker = loadWorkerConfig(WORKER_ENV);

    for (const config of [api, worker]) {
      expect([
        config.STRIPE_SECRET_KEY_TEST,
        config.STRIPE_PUBLISHABLE_KEY_TEST,
        config.STRIPE_SECRET_KEY_LIVE,
        config.STRIPE_PUBLISHABLE_KEY_LIVE,
      ]).toEqual([undefined, undefined, undefined, undefined]);
    }
    const keys = { STRIPE_SECRET_KEY_TEST: fake("sk_test"), STRIPE_PUBLISHABLE_KEY_TEST: fake("pk_test") };
    expect(loadWorkerConfig({ ...WORKER_ENV, ...keys })).toMatchObject(keys);
  });

  it("accept secret, restricted and publishable keys of their own mode", () => {
    const keys = {
      STRIPE_SECRET_KEY_TEST: fake("sk_test"),
      STRIPE_PUBLISHABLE_KEY_TEST: fake("pk_test"),
      STRIPE_SECRET_KEY_LIVE: fake("rk_live"),
      STRIPE_PUBLISHABLE_KEY_LIVE: fake("pk_live"),
    };

    expect(loadApiConfig({ ...API_ENV, ...keys })).toMatchObject(keys);
    expect(loadWorkerConfig({ ...WORKER_ENV, ...keys })).toMatchObject(keys);
  });

  it("refuse a key of the other mode or of the other kind, and never print it", () => {
    for (const [name, value] of [
      ["STRIPE_SECRET_KEY_TEST", fake("sk_live")],
      ["STRIPE_SECRET_KEY_TEST", fake("pk_test")],
      ["STRIPE_PUBLISHABLE_KEY_TEST", fake("pk_live")],
      ["STRIPE_PUBLISHABLE_KEY_TEST", fake("sk_test")],
      ["STRIPE_SECRET_KEY_LIVE", fake("sk_test")],
      ["STRIPE_PUBLISHABLE_KEY_LIVE", fake("pk_test")],
      ["STRIPE_SECRET_KEY_TEST", "sk_test_with spaces"],
    ] as const) {
      for (const load of [
        () => loadApiConfig({ ...API_ENV, [name]: value }),
        () => loadWorkerConfig({ ...WORKER_ENV, [name]: value }),
      ]) {
        const error = configErrorOf(load);

        expect([value, error.problems.map((problem) => problem.variable)]).toEqual([value, [name]]);
        expect(error.message).not.toContain(value);
      }
    }
  });
});

describe("the webhook signing secrets of the Velexis account (OBE-039)", () => {
  /** Secrets of the documented shape, built at run time; none is a real secret. */
  const fakeSecret = (body = "0123456789abcdefABCDEF"): string => `whsec_${body.repeat(2)}`;

  it("are optional and read by the API only, which refuses deliveries of an environment without its secret", () => {
    const api = loadApiConfig(API_ENV);
    expect([api.STRIPE_WEBHOOK_SECRET_VELEXIS_TEST, api.STRIPE_WEBHOOK_SECRET_VELEXIS_LIVE]).toEqual([
      undefined,
      undefined,
    ]);
    const worker = loadWorkerConfig({ ...WORKER_ENV, STRIPE_WEBHOOK_SECRET_VELEXIS_TEST: fakeSecret() });
    expect(worker).not.toHaveProperty("STRIPE_WEBHOOK_SECRET_VELEXIS_TEST");
  });

  it("accept whsec_ secrets of letters, digits and the base64 characters", () => {
    const secrets = {
      STRIPE_WEBHOOK_SECRET_VELEXIS_TEST: fakeSecret(),
      STRIPE_WEBHOOK_SECRET_VELEXIS_LIVE: fakeSecret("Ab+/=_-9"),
    };

    expect(loadApiConfig({ ...API_ENV, ...secrets })).toMatchObject(secrets);
  });

  it("refuse anything else, and never print it", () => {
    for (const value of [
      `sk_test_${"0123456789abcdef".repeat(2)}`,
      "whsec_ab",
      "whsec_short",
      `whsec_${"a".repeat(20)} x`,
    ]) {
      const error = configErrorOf(() =>
        loadApiConfig({ ...API_ENV, STRIPE_WEBHOOK_SECRET_VELEXIS_TEST: value }),
      );

      expect([value, error.problems.map((problem) => problem.variable)]).toEqual([
        value,
        ["STRIPE_WEBHOOK_SECRET_VELEXIS_TEST"],
      ]);
      expect(error.message).not.toContain(value);
    }
  });
});

describe("the e-mail settings of the worker (OBE-030)", () => {
  const EMAIL_SETTINGS = ["SMTP_URL", "MAIL_FROM", "OPS_ALERT_EMAIL", "PUBLIC_OTA_ADMIN_URL"];

  it("are required by the worker and never read by the API", () => {
    const rest = Object.fromEntries(
      Object.entries(WORKER_ENV).filter(([name]) => !EMAIL_SETTINGS.includes(name)),
    );
    const error = configErrorOf(() => loadWorkerConfig(rest));
    const api = loadApiConfig({ ...API_ENV, ...WORKER_VARIABLES });

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      "MAIL_FROM",
      "OPS_ALERT_EMAIL",
      "PUBLIC_OTA_ADMIN_URL",
      "SMTP_URL",
    ]);
    for (const name of EMAIL_SETTINGS) {
      expect(api).not.toHaveProperty(name);
    }
  });

  it("accept a sender with or without a display name, and refuse one that is not one line with one address", () => {
    for (const value of [
      "no-reply@mail.ota.example.com",
      "Velexis OTA <no-reply@mail.ota.example.com>",
      '"Velexis OTA" <no-reply@mail.ota.example.com>',
    ]) {
      expect(loadWorkerConfig({ ...WORKER_ENV, MAIL_FROM: value }).MAIL_FROM).toBe(value);
    }
    for (const value of [
      "Velexis OTA",
      "a@example.com, b@example.com",
      "Velexis <a@example.com>, <b@example.com>",
      "Velexis\r\nBcc: x@example.com <a@example.com>",
    ]) {
      const error = configErrorOf(() => loadWorkerConfig({ ...WORKER_ENV, MAIL_FROM: value }));

      expect([value, error.problems.map((problem) => problem.variable)]).toEqual([value, ["MAIL_FROM"]]);
    }
  });

  it("refuse an SMTP URL that is not smtp(s), an ops address that is not one plain address, and a non-http admin URL", () => {
    for (const [name, value] of [
      ["SMTP_URL", "http://127.0.0.1:1025"],
      ["SMTP_URL", "not a url"],
      ["OPS_ALERT_EMAIL", "Ops <ops@example.com>"],
      ["OPS_ALERT_EMAIL", "ops@example.com, other@example.com"],
      ["PUBLIC_OTA_ADMIN_URL", "ftp://admin.ota.example.com"],
    ] as const) {
      const error = configErrorOf(() => loadWorkerConfig({ ...WORKER_ENV, [name]: value }));

      expect([value, error.problems.map((problem) => problem.variable)]).toEqual([value, [name]]);
    }
    expect(
      loadWorkerConfig({ ...WORKER_ENV, SMTP_URL: "smtps://user:dummy@smtp.example.com:465" }).SMTP_URL,
    ).toBe("smtps://user:dummy@smtp.example.com:465");
  });
});

describe("the storage settings of both processes (OBE-053, OBE-054)", () => {
  it("default to the local driver and read STORAGE_DIR as an existing folder, in the worker and the API [OBE-054]", () => {
    const folder = mkdtempSync(join(tmpdir(), "velexis-ota-storage-"));
    try {
      const worker = loadWorkerConfig({ ...WORKER_ENV, STORAGE_DIR: folder });
      const api = loadApiConfig({ ...API_ENV, STORAGE_DIR: folder });
      const apiS3 = loadApiConfig({ ...API_ENV, STORAGE_DRIVER: "s3", STORAGE_DIR: folder });

      expect([worker.STORAGE_DRIVER, worker.STORAGE_DIR]).toEqual(["local", folder]);
      expect([api.STORAGE_DRIVER, api.STORAGE_DIR]).toEqual(["local", folder]);
      expect(apiS3.STORAGE_DRIVER).toBe("s3");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuse a folder that does not exist (the VM's by default) and a driver that is not local or s3", () => {
    const missing = join(tmpdir(), `velexis-ota-missing-${process.pid}`, "storage");
    const loaders = [
      ["worker", WORKER_ENV, loadWorkerConfig],
      ["api", API_ENV, loadApiConfig],
    ] as const;

    for (const [name, env, load] of loaders) {
      const withoutDir = Object.fromEntries(
        Object.entries(env).filter(([variable]) => variable !== "STORAGE_DIR"),
      );
      for (const [source, variable] of [
        [{ ...env, STORAGE_DIR: missing }, "STORAGE_DIR"],
        [{ ...env, STORAGE_DRIVER: "gcs" }, "STORAGE_DRIVER"],
      ] as const) {
        const error = configErrorOf(() => load(source));
        expect([name, error.problems.map((problem) => problem.variable)]).toEqual([name, [variable]]);
      }
      // Without the variable the VM's folder is the value, checked like one: here it exists only where it was
      // created.
      if (existsSync(DEFAULT_STORAGE_DIR)) {
        expect([name, load(withoutDir).STORAGE_DIR]).toEqual([name, DEFAULT_STORAGE_DIR]);
      } else {
        expect([
          name,
          configErrorOf(() => load(withoutDir)).problems.map((problem) => problem.variable),
        ]).toEqual([name, ["STORAGE_DIR"]]);
      }
    }
  });
});

describe("the document URL key of the API (OBE-054)", () => {
  it("is a required key file of at least 32 bytes that only the API reads", () => {
    const folder = mkdtempSync(join(tmpdir(), "velexis-ota-url-key-"));
    try {
      const short = join(folder, "short.key");
      writeFileSync(short, `${Buffer.alloc(16, 1).toString("base64")}\n`, { mode: 0o600 });
      const readable = join(folder, "readable.key");
      writeFileSync(readable, `${Buffer.alloc(32, 1).toString("base64")}\n`, { mode: 0o644 });
      chmodSync(readable, 0o644);
      const withoutKey = Object.fromEntries(
        Object.entries(API_ENV).filter(([variable]) => variable !== "DOCUMENT_URL_KEY_FILE"),
      );

      for (const source of [
        withoutKey,
        { ...API_ENV, DOCUMENT_URL_KEY_FILE: short },
        { ...API_ENV, DOCUMENT_URL_KEY_FILE: readable },
        { ...API_ENV, DOCUMENT_URL_KEY_FILE: join(folder, "missing.key") },
      ]) {
        const error = configErrorOf(() => loadApiConfig(source));
        expect(error.problems.map((problem) => problem.variable)).toEqual(["DOCUMENT_URL_KEY_FILE"]);
      }
      expect(loadApiConfig(API_ENV).DOCUMENT_URL_KEY_FILE).toBe(testApiCredentials().documentUrlKeyFile);
      expect(loadWorkerConfig({ ...WORKER_ENV, ...API_ONLY })).not.toHaveProperty("DOCUMENT_URL_KEY_FILE");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the airline card's kill switch", () => {
  it("is off by default and in the deploy template, on in development, and only for true, false, 1 or 0 [OBE-050 AC1]", () => {
    expect(loadApiConfig(API_ENV).AIRLINE_CARD_ENABLED).toBe(false);
    for (const [raw, value] of [
      ["true", true],
      ["1", true],
      ["false", false],
      ["0", false],
    ] as const) {
      expect([raw, loadApiConfig({ ...API_ENV, AIRLINE_CARD_ENABLED: raw }).AIRLINE_CARD_ENABLED]).toEqual([
        raw,
        value,
      ]);
    }
    for (const raw of ["yes", "on", "TRUE "]) {
      const error = configErrorOf(() => loadApiConfig({ ...API_ENV, AIRLINE_CARD_ENABLED: raw }));
      expect(error.problems.map((problem) => problem.variable)).toEqual(["AIRLINE_CARD_ENABLED"]);
    }
    // Production keeps the switch off until the M6 security review (OBE-086); development and CI turn it on.
    expect(renderedTemplate("ota-backend.env.example")["AIRLINE_CARD_ENABLED"]).toBe("false");
    expect(readEnvFile(join(APP_DIR, ".env.example"))["AIRLINE_CARD_ENABLED"]).toBe("true");
    // The worker never reads it.
    expect(loadWorkerConfig({ ...WORKER_ENV, AIRLINE_CARD_ENABLED: "true" })).not.toHaveProperty(
      "AIRLINE_CARD_ENABLED",
    );
  });
});

describe("example and template files", () => {
  it("accept the local values of the root and app .env.example files", () => {
    const local = {
      ...readEnvFile(join(REPO_ROOT, ".env.example")),
      ...readEnvFile(join(APP_DIR, ".env.example")),
    };
    // The pepper path is relative to the workspace root, where `pnpm dev:keys` writes it; a scratch root with the
    // test process's pepper at that place stands in for a developer's checkout.
    const root = mkdtempSync(join(tmpdir(), "velexis-ota-config-"));
    try {
      const pepperFile = join(root, local["API_KEY_PEPPER_FILE"] ?? "missing");
      mkdirSync(dirname(pepperFile), { recursive: true });
      copyFileSync(testApiCredentials().pepperFile, pepperFile);
      chmodSync(pepperFile, 0o600);

      // The OTA backend's own signing key of `pnpm dev:keys`, in the same folder (OBE-031).
      const jwtKeyFile = join(root, local["JWT_PRIVATE_KEY_FILE"] ?? "missing");
      copyFileSync(testApiCredentials().jwtKeyFile, jwtKeyFile);
      chmodSync(jwtKeyFile, 0o600);
      // And its document URL key (OBE-054).
      const documentUrlKeyFile = join(root, local["DOCUMENT_URL_KEY_FILE"] ?? "missing");
      copyFileSync(testApiCredentials().documentUrlKeyFile, documentUrlKeyFile);
      chmodSync(documentUrlKeyFile, 0o600);
      // The storage folder that `pnpm dev:keys` creates (OBE-053), relative to the same root.
      const storageDir = join(root, local["STORAGE_DIR"] ?? "missing");
      mkdirSync(storageDir, { recursive: true });

      // The key folder of `pnpm dev:keys` (MASTER_KEY_DIR, the pepper's folder) is the scratch root's too.
      const api = loadApiConfig({
        ...local,
        API_KEY_PEPPER_FILE: pepperFile,
        JWT_PRIVATE_KEY_FILE: jwtKeyFile,
        DOCUMENT_URL_KEY_FILE: documentUrlKeyFile,
        MASTER_KEY_DIR: join(root, local["MASTER_KEY_DIR"] ?? "missing"),
        STORAGE_DIR: storageDir,
      });
      const worker = loadWorkerConfig({
        ...local,
        MASTER_KEY_DIR: join(root, local["MASTER_KEY_DIR"] ?? "missing"),
        STORAGE_DIR: storageDir,
      });

      expect(local["API_KEY_PEPPER_FILE"]).toBe(".local/keys/api-key-pepper");
      expect(local["JWT_PRIVATE_KEY_FILE"]).toBe(".local/keys/ota-jwt-ed25519.pem");
      expect(local["DOCUMENT_URL_KEY_FILE"]).toBe(".local/keys/document-url.key");
      expect(api.DOCUMENT_URL_KEY_FILE).toBe(documentUrlKeyFile);
      expect(local["MASTER_KEY_DIR"]).toBe(".local/keys");
      expect(api.MASTER_KEY_DIR).toBe(dirname(pepperFile));
      expect(api.AMADEUS_BASE_URL_TEST).toBe("http://127.0.0.1:4900");
      expect(api.APP_ENV).toBe("development");
      expect(api.DATABASE_URL).toContain("velexis_ota_app");
      expect(api.PORT).toBe(4000);
      expect(api.STOREFRONT_BASE_DOMAIN).toBe("ota.example.com");
      expect(worker.HEALTH_PORT).toBe(4001);
      expect(worker.DATABASE_PROVISIONER_URL).toContain("velexis_provisioner");
      // OBE-030: Mailpit, and a sender on the Velexis-controlled sending domain.
      expect(worker.SMTP_URL).toBe("smtp://127.0.0.1:1025");
      expect(worker.MAIL_FROM).toMatch(/<no-reply@mail\.ota\.example\.com>$/);
      expect(worker.STOREFRONT_BASE_DOMAIN).toBe("ota.example.com");
      expect(local["STORAGE_DIR"]).toBe(".local/storage");
      expect([worker.STORAGE_DRIVER, worker.STORAGE_DIR]).toEqual(["local", storageDir]);
      expect([api.STORAGE_DRIVER, api.STORAGE_DIR]).toEqual(["local", storageDir]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches deploy/env: every variable of both schemas is in the unit's env files, except the ports", () => {
    const shared = renderedTemplate("ota-backend.env.example");
    const worker = renderedTemplate("ota-worker.env.example");

    // The pepper and the signing key of the OTA zone's key folder on the VM (ADR-0026); the test process's own files
    // stand in for them.
    expect(shared["API_KEY_PEPPER_FILE"]).toBe(`${shared["MASTER_KEY_DIR"] ?? "missing"}/api-key-pepper`);
    expect(shared["JWT_PRIVATE_KEY_FILE"]).toBe(
      `${shared["MASTER_KEY_DIR"] ?? "missing"}/ota-jwt-ed25519.pem`,
    );
    expect(shared["DOCUMENT_URL_KEY_FILE"]).toBe(`${shared["MASTER_KEY_DIR"] ?? "missing"}/document-url.key`);
    // The OTA zone's key folder and the VM's storage folder do not exist here either: the test process's own stand in.
    const api = loadApiConfig({
      ...shared,
      API_KEY_PEPPER_FILE: testApiCredentials().pepperFile,
      JWT_PRIVATE_KEY_FILE: testApiCredentials().jwtKeyFile,
      DOCUMENT_URL_KEY_FILE: testApiCredentials().documentUrlKeyFile,
      MASTER_KEY_DIR: testApiCredentials().masterKeyDir,
      STORAGE_DIR: API_ONLY["STORAGE_DIR"] ?? "missing",
    });
    expect(api.APP_ENV).toBe("production");
    // Empty in the template: the connection's or the shared account's base_url is used on the VM.
    expect([api.AMADEUS_BASE_URL_TEST, api.AMADEUS_BASE_URL_LIVE]).toEqual([undefined, undefined]);
    // Nor does the VM's storage folder (OBE-053): the template names it, the test process's folder stands in for it.
    expect(shared["STORAGE_DIR"]).toBe(DEFAULT_STORAGE_DIR);
    expect(
      loadWorkerConfig({
        ...shared,
        ...worker,
        MASTER_KEY_DIR: testApiCredentials().masterKeyDir,
        STORAGE_DIR: WORKER_VARIABLES["STORAGE_DIR"] ?? "missing",
      }).APP_ENV,
    ).toBe("production");
    // PORT and HEALTH_PORT are set by the velexis-ota-api and velexis-ota-worker units.
    for (const name of Object.keys(apiConfigSchema).filter((variable) => variable !== "PORT")) {
      expect(shared).toHaveProperty(name);
    }
    for (const name of Object.keys(workerConfigSchema).filter((variable) => variable !== "HEALTH_PORT")) {
      expect({ ...shared, ...worker }).toHaveProperty(name);
    }
  });
});

describe("loading the process environment", () => {
  it("validates the process environment when no source is given [OBE-001 AC3]", () => {
    // production: no .env.local file is read, so only the stubbed environment counts.
    for (const [name, value] of Object.entries(API_ENV)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("DATABASE_URL", "");

    const error = configErrorOf(() => loadApiConfig());

    expect(error.problems.map((problem) => problem.variable)).toEqual(["DATABASE_URL"]);
  });

  it("reads the same variables as an explicit source", () => {
    for (const [name, value] of Object.entries(WORKER_ENV)) {
      vi.stubEnv(name, value);
    }

    expect(loadWorkerConfig()).toEqual(loadWorkerConfig(WORKER_ENV));
  });
});
