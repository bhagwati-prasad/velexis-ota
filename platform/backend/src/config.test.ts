import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError } from "@velexis/config";
import { fullFormats } from "ajv-formats/dist/formats";
import { afterAll, describe, expect, it } from "vitest";
import { createTestJwtKeyFile, ed25519PrivateKeyPem, writeTestKeyFile } from "../test/support/jwt-key";
import { createTestMasterKeyDir, TEST_MAIL_ENV } from "../test/support/master-key";
import { FEATURE_VARIABLES, FEATURES } from "./common/features";
import {
  APP_DIR,
  createProcessLogger,
  EMAIL_ADDRESS,
  loadConfig,
  loadConfigOrReport,
  parseConfig,
  PLATFORM_BACKEND_CONFIG_SCHEMA,
  PLATFORM_PROCESSES,
} from "./config";

const REPO_ROOT = join(APP_DIR, "..", "..");

/**
 * The JWT signing key of the configurations below: a fresh Ed25519 key of mode 0600 in a temporary folder, in place
 * of the `.local/keys/platform-jwt-ed25519.pem` that `pnpm dev:keys` creates (JWT_PRIVATE_KEY_FILE must name an
 * existing key file).
 */
const jwtKey = createTestJwtKeyFile();
/** The master key folder of the configurations below, in place of `.local/keys/` (MASTER_KEY_DIR must exist). */
const masterKeys = createTestMasterKeyDir();

afterAll(() => {
  jwtKey.remove();
  masterKeys.remove();
});

/** The development values of platform/backend/.env.example (dummy values only), with the key files above. */
const DEVELOPMENT = {
  APP_ENV: "development",
  LOG_LEVEL: "debug",
  PORT: "3100",
  HEALTH_PORT: "3101",
  TRUST_PROXY: "loopback",
  DATABASE_URL: "postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis",
  REDIS_URL: "redis://:dev_redis@127.0.0.1:6379/0",
  PLATFORM_BFF_KEY: "dev_bff_key_change_me_0123456789abcdef",
  JWT_PRIVATE_KEY_FILE: jwtKey.path,
  API_KEY_PEPPER_FILE: masterKeys.pepperFile,
  MASTER_KEY_DIR: masterKeys.path,
  MASTER_KEY_CURRENT: "local:v1",
  ...TEST_MAIL_ENV,
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
} as const;

/** The variables without a default: the minimum a process needs. */
const REQUIRED = {
  APP_ENV: DEVELOPMENT.APP_ENV,
  DATABASE_URL: DEVELOPMENT.DATABASE_URL,
  REDIS_URL: DEVELOPMENT.REDIS_URL,
  PLATFORM_BFF_KEY: DEVELOPMENT.PLATFORM_BFF_KEY,
  JWT_PRIVATE_KEY_FILE: DEVELOPMENT.JWT_PRIVATE_KEY_FILE,
  API_KEY_PEPPER_FILE: DEVELOPMENT.API_KEY_PEPPER_FILE,
  MASTER_KEY_DIR: DEVELOPMENT.MASTER_KEY_DIR,
  MASTER_KEY_CURRENT: DEVELOPMENT.MASTER_KEY_CURRENT,
  SMTP_URL: DEVELOPMENT.SMTP_URL,
  MAIL_FROM: DEVELOPMENT.MAIL_FROM,
  OPS_ALERT_EMAIL: DEVELOPMENT.OPS_ALERT_EMAIL,
  PUBLIC_PORTAL_URL: DEVELOPMENT.PUBLIC_PORTAL_URL,
  PUBLIC_PLATFORM_ADMIN_URL: DEVELOPMENT.PUBLIC_PLATFORM_ADMIN_URL,
  STOREFRONT_BASE_DOMAIN: DEVELOPMENT.STOREFRONT_BASE_DOMAIN,
} as const;

/** The variables PBE-011 adds, in the order of the schema. */
const MAIL_AND_KEY_VARIABLES = [
  "MASTER_KEY_DIR",
  "MASTER_KEY_CURRENT",
  "SMTP_URL",
  "MAIL_FROM",
  "OPS_ALERT_EMAIL",
  "PUBLIC_PORTAL_URL",
  "PUBLIC_PLATFORM_ADMIN_URL",
] as const;

/** The Stripe variables PBE-043 adds, in the order of the schema. */
const STRIPE_VARIABLES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_BILLING_WEBHOOK_SECRET",
  "STRIPE_CONNECT_CLIENT_ID",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
] as const;

/** Dummy test-mode values of the four Stripe variables (the shapes of the app's .env.example). */
const STRIPE_TEST_VALUES = {
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_dummy_billing",
  STRIPE_CONNECT_CLIENT_ID: "ca_dummy",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_dummy_connect",
} as const satisfies Record<(typeof STRIPE_VARIABLES)[number], string>;

/** Where `pnpm dev:keys` puts the development key, and where provision-vm.sh puts the key on the VM. */
const DEV_JWT_KEY_FILE = "./.local/keys/platform-jwt-ed25519.pem";
const VM_JWT_KEY_FILE = "/etc/velexis/keys/platform/platform-jwt-ed25519.pem";
/** The API key pepper of `pnpm dev:keys` and of the VM (PADR-0005, ADR-0026), in the key folders below. */
const DEV_PEPPER_FILE = "./.local/keys/api-key-pepper";
const VM_PEPPER_FILE = "/etc/velexis/keys/platform/api-key-pepper";
/** The key folders of `pnpm dev:keys` and of the VM (ADR-0026). */
const DEV_MASTER_KEY_DIR = "./.local/keys";
const VM_MASTER_KEY_DIR = "/etc/velexis/keys/platform";

/** What provision-vm.sh puts in place of @@PLATFORM_BFF_KEY@@ on the VM: 32 random bytes as hex (dummy here). */
const GENERATED_BFF_KEY = "0123456789abcdef".repeat(4);

function configError(source: Record<string, string | undefined>): ConfigError {
  try {
    parseConfig(source);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("parseConfig accepted an invalid configuration");
}

/** A pino destination that keeps the parsed lines. */
function logSink(): { readonly lines: Record<string, unknown>[]; write(line: string): void } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return parseEnv(readFileSync(path, "utf8"));
}

/** The entries of `values` named in `names`. */
function pick(
  values: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, values[name]]));
}

describe("parseConfig", () => {
  it("[PBE-001 AC3] refuses a missing DATABASE_URL with a ConfigError that names it", () => {
    const error = configError({ ...DEVELOPMENT, DATABASE_URL: undefined });

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.problems).toEqual([{ variable: "DATABASE_URL", reason: "is required but missing" }]);
    expect(error.message).toContain("DATABASE_URL");
  });

  it("[PBE-001 AC3] refuses an empty DATABASE_URL", () => {
    expect(configError({ ...DEVELOPMENT, DATABASE_URL: "" }).problems.map((p) => p.variable)).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("accepts the required variables and applies the defaults of the units", () => {
    const config = parseConfig(REQUIRED);

    expect(config).toEqual({
      APP_ENV: "development",
      LOG_LEVEL: "info",
      PORT: 3100,
      HEALTH_PORT: 3101,
      TRUST_PROXY: ["loopback"],
      DATABASE_URL: DEVELOPMENT.DATABASE_URL,
      REDIS_URL: DEVELOPMENT.REDIS_URL,
      PLATFORM_BFF_KEY: DEVELOPMENT.PLATFORM_BFF_KEY,
      JWT_PRIVATE_KEY_FILE: jwtKey.path,
      API_KEY_PEPPER_FILE: masterKeys.pepperFile,
      MASTER_KEY_DIR: masterKeys.path,
      MASTER_KEY_CURRENT: "local:v1",
      SMTP_URL: "smtp://127.0.0.1:1025",
      MAIL_FROM: '"Velexis" <no-reply@mail.platform.example.com>',
      OPS_ALERT_EMAIL: "ops@example.com",
      PUBLIC_PORTAL_URL: "http://localhost:3000",
      PUBLIC_PLATFORM_ADMIN_URL: "http://localhost:3001",
      STOREFRONT_BASE_DOMAIN: "ota.example.com",
      MAX_TENANTS_PER_ACCOUNT: 3,
      FEATURE_STRIPE_BILLING: false,
      FEATURE_OWN_STRIPE: false,
      FEATURE_SETTLEMENTS: false,
      FEATURE_OWN_AMADEUS: false,
      FEATURE_CUSTOM_DOMAINS: false,
      FEATURE_LIVE_SWITCH: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.TRUST_PROXY)).toBe(true);
  });

  it("names every invalid variable at once and never echoes a value", () => {
    const error = configError({
      APP_ENV: "staging-value-1",
      LOG_LEVEL: "loud-value-2",
      PORT: "port-value-3",
      HEALTH_PORT: "70000",
      DATABASE_URL: "mysql://user:secret-value-4@127.0.0.1/velexis",
      REDIS_URL: "http://:secret-value-5@127.0.0.1:6379",
      PLATFORM_BFF_KEY: "secret-value-6",
      JWT_PRIVATE_KEY_FILE: "/nowhere/secret-value-7.pem",
      API_KEY_PEPPER_FILE: "/nowhere/secret-value-17",
      MASTER_KEY_DIR: "/nowhere/secret-value-10",
      MASTER_KEY_CURRENT: "kms:secret-value-11",
      SMTP_URL: "http://user:secret-value-12@smtp.example.com",
      MAIL_FROM: "secret-value-13 <a@example.com>, b@example.com",
      OPS_ALERT_EMAIL: "secret-value-14",
      PUBLIC_PORTAL_URL: "ftp://secret-value-15.example.com",
      PUBLIC_PLATFORM_ADMIN_URL: "secret-value-16",
      STOREFRONT_BASE_DOMAIN: "https://ota.example.com/domain-value-10",
      MAX_TENANTS_PER_ACCOUNT: "many-value-8",
      FEATURE_CUSTOM_DOMAINS: "maybe-value-9",
    });

    expect(error.problems.map((problem) => problem.variable)).toEqual([
      "APP_ENV",
      "LOG_LEVEL",
      "PORT",
      "HEALTH_PORT",
      "DATABASE_URL",
      "REDIS_URL",
      "PLATFORM_BFF_KEY",
      "JWT_PRIVATE_KEY_FILE",
      "API_KEY_PEPPER_FILE",
      ...MAIL_AND_KEY_VARIABLES,
      "STOREFRONT_BASE_DOMAIN",
      "MAX_TENANTS_PER_ACCOUNT",
      "FEATURE_CUSTOM_DOMAINS",
    ]);
    for (const value of [
      "value-1",
      "value-2",
      "value-3",
      "70000",
      "secret-value-4",
      "secret-value-5",
      "secret-value-6",
      "secret-value-7",
      "value-8",
      "value-9",
      "secret-value-10",
      "secret-value-11",
      "secret-value-12",
      "secret-value-13",
      "secret-value-14",
      "secret-value-15",
      "secret-value-16",
      "secret-value-17",
      "domain-value-10",
    ]) {
      expect(error.message).not.toContain(value);
    }
  });

  it("requires STOREFRONT_BASE_DOMAIN as lower-case DNS labels without a scheme, a path or a trailing dot", () => {
    expect(configError({ ...REQUIRED, STOREFRONT_BASE_DOMAIN: undefined }).problems).toEqual([
      { variable: "STOREFRONT_BASE_DOMAIN", reason: "is required but missing" },
    ]);
    for (const domain of ["ota.example.com", "example.test", "stores.ota-1.example.co.uk"]) {
      expect(parseConfig({ ...REQUIRED, STOREFRONT_BASE_DOMAIN: domain }).STOREFRONT_BASE_DOMAIN).toBe(
        domain,
      );
    }
    // The OTA backend's rule for the same variable: a single label or a numeric last label is no parent domain.
    for (const domain of [
      "localhost",
      "ota.example.123",
      "OTA.example.com",
      "ota.example.com.",
      ".ota.example.com",
      "https://ota.example.com",
      "ota.example.com/x",
      "ota_example.com",
      "-ota.example.com",
      `${"a".repeat(64)}.example.com`,
      `${"abcdefghi.".repeat(22)}com`,
    ]) {
      expect(
        configError({ ...REQUIRED, STOREFRONT_BASE_DOMAIN: domain }).problems.map(({ variable }) => variable),
        domain,
      ).toEqual(["STOREFRONT_BASE_DOMAIN"]);
    }
  });

  it("accepts TRUST_PROXY names, addresses and subnets", () => {
    const config = parseConfig({ ...REQUIRED, TRUST_PROXY: "loopback, uniquelocal,10.0.0.0/8,::1,fd00::/8" });

    expect(config.TRUST_PROXY).toEqual(["loopback", "uniquelocal", "10.0.0.0/8", "::1", "fd00::/8"]);
  });

  it.each([
    ["true", "a switch that would trust every peer"],
    ["1", "a hop count"],
    ["127.0.0.1/33", "an IPv4 prefix longer than 32"],
    ["::1/129", "an IPv6 prefix longer than 128"],
    ["999.1.1.1", "an address that is not one"],
    ["10.0.0.0/8/8", "two prefixes"],
    ["10.0.0.0/255.0.0.0", "a netmask instead of a prefix length"],
  ])("refuses TRUST_PROXY=%s (%s)", (value) => {
    expect(configError({ ...REQUIRED, TRUST_PROXY: value }).problems.map((p) => p.variable)).toEqual([
      "TRUST_PROXY",
    ]);
  });

  it("reports a TRUST_PROXY address problem in the same error as the other problems", () => {
    const error = configError({ APP_ENV: "development", TRUST_PROXY: "300.0.0.1" });

    expect(error.problems.map((problem) => problem.variable)).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "PLATFORM_BFF_KEY",
      "JWT_PRIVATE_KEY_FILE",
      "API_KEY_PEPPER_FILE",
      ...MAIL_AND_KEY_VARIABLES,
      "STOREFRONT_BASE_DOMAIN",
      "TRUST_PROXY",
    ]);
  });

  it("accepts the app's .env.example, with the key files pnpm dev:keys creates", () => {
    const example = readEnvFile(join(APP_DIR, ".env.example"));
    const config = parseConfig({
      ...example,
      JWT_PRIVATE_KEY_FILE: jwtKey.path,
      API_KEY_PEPPER_FILE: masterKeys.pepperFile,
      MASTER_KEY_DIR: masterKeys.path,
    });

    expect(example["JWT_PRIVATE_KEY_FILE"]).toBe(DEV_JWT_KEY_FILE);
    expect(example["API_KEY_PEPPER_FILE"]).toBe(DEV_PEPPER_FILE);
    expect(example["MASTER_KEY_DIR"]).toBe(DEV_MASTER_KEY_DIR);
    expect(config.MASTER_KEY_CURRENT).toBe("local:v1");
    expect(config.SMTP_URL).toBe("smtp://127.0.0.1:1025");
    expect(config.MAIL_FROM).toBe('"Velexis" <no-reply@mail.platform.example.com>');
    expect(config.OPS_ALERT_EMAIL).toBe("ops@example.com");
    expect(config.APP_ENV).toBe("development");
    expect(config.PORT).toBe(3100);
    expect(config.HEALTH_PORT).toBe(3101);
    expect(config.MAX_TENANTS_PER_ACCOUNT).toBe(3);
    for (const feature of FEATURES) {
      expect(config[FEATURE_VARIABLES[feature]]).toBe(false);
    }
  });

  it("accepts the VM template with the ports of the systemd units, the generated key and the key file", () => {
    const template = readEnvFile(join(REPO_ROOT, "deploy/env/platform-backend.env.example"));
    const vm = {
      ...template,
      PLATFORM_BFF_KEY: GENERATED_BFF_KEY,
      JWT_PRIVATE_KEY_FILE: jwtKey.path,
      API_KEY_PEPPER_FILE: masterKeys.pepperFile,
      MASTER_KEY_DIR: masterKeys.path,
    };
    const api = parseConfig({ ...vm, PORT: "3100" });
    const worker = parseConfig({ ...vm, HEALTH_PORT: "3101" });

    expect(template.PLATFORM_BFF_KEY).toBe("@@PLATFORM_BFF_KEY@@");
    expect(template.JWT_PRIVATE_KEY_FILE).toBe(VM_JWT_KEY_FILE);
    expect(template.API_KEY_PEPPER_FILE).toBe(VM_PEPPER_FILE);
    expect(template.MASTER_KEY_DIR).toBe(VM_MASTER_KEY_DIR);
    expect(api.APP_ENV).toBe("production");
    expect(api.MASTER_KEY_CURRENT).toBe("local:v1");
    expect(api.SMTP_URL.startsWith("smtps://")).toBe(true);
    expect(api.TRUST_PROXY).toEqual(["loopback"]);
    expect(api.PLATFORM_BFF_KEY).toBe(GENERATED_BFF_KEY);
    expect(api.MAX_TENANTS_PER_ACCOUNT).toBe(3);
    for (const feature of FEATURES) {
      expect(api[FEATURE_VARIABLES[feature]]).toBe(false);
    }
    expect(worker.HEALTH_PORT).toBe(3101);
  });

  it("declares JWT_PRIVATE_KEY_FILE, TRUST_PROXY, STOREFRONT_BASE_DOMAIN, MAX_TENANTS_PER_ACCOUNT and the switches, switches off, in every env template", () => {
    const variables = [
      "JWT_PRIVATE_KEY_FILE",
      "TRUST_PROXY",
      "STOREFRONT_BASE_DOMAIN",
      "MAX_TENANTS_PER_ACCOUNT",
      ...Object.values(FEATURE_VARIABLES),
    ];
    const files = [
      ".env.example",
      "platform/backend/.env.example",
      "deploy/env/platform-backend.env.example",
    ];

    for (const file of files) {
      const values = readEnvFile(join(REPO_ROOT, file));
      expect(
        variables.filter((variable) => values[variable] === undefined),
        file,
      ).toEqual([]);
      expect(values["MAX_TENANTS_PER_ACCOUNT"], file).toBe("3");
      expect(values["TRUST_PROXY"], file).toBe("loopback");
      expect(values["STOREFRONT_BASE_DOMAIN"], file).toBe("ota.example.com");
      for (const variable of Object.values(FEATURE_VARIABLES)) {
        expect(values[variable], `${file} ${variable}`).toBe("false");
      }
    }
    // The worker's overlay holds only comments (deploy.test.sh): the API and the worker see the same switches.
    expect(readEnvFile(join(REPO_ROOT, "deploy/env/platform-worker.env.example"))).toEqual({});
  });

  it("[PBE-011] declares the key folder, the e-mail settings and the public URLs in every env template", () => {
    for (const file of [
      ".env.example",
      "platform/backend/.env.example",
      "deploy/env/platform-backend.env.example",
    ]) {
      const values = readEnvFile(join(REPO_ROOT, file));
      expect(
        MAIL_AND_KEY_VARIABLES.filter((variable) => values[variable] === undefined),
        file,
      ).toEqual([]);
      expect(values["MASTER_KEY_CURRENT"], file).toBe("local:v1");
      // The values parse, the key folder aside (it exists only after pnpm dev:keys or on the VM).
      const parsed = parseConfig({
        ...REQUIRED,
        ...pick(values, MAIL_AND_KEY_VARIABLES),
        MASTER_KEY_DIR: masterKeys.path,
      });
      expect(parsed.OPS_ALERT_EMAIL, file).toBe(values["OPS_ALERT_EMAIL"]);
    }
  });

  it("declares only variables of the configuration matrix that the processes read", () => {
    expect(Object.keys(PLATFORM_BACKEND_CONFIG_SCHEMA)).toEqual([
      "APP_ENV",
      "LOG_LEVEL",
      "PORT",
      "HEALTH_PORT",
      "TRUST_PROXY",
      "DATABASE_URL",
      "REDIS_URL",
      "PLATFORM_BFF_KEY",
      "JWT_PRIVATE_KEY_FILE",
      "API_KEY_PEPPER_FILE",
      ...MAIL_AND_KEY_VARIABLES,
      "STOREFRONT_BASE_DOMAIN",
      "MAX_TENANTS_PER_ACCOUNT",
      ...Object.values(FEATURE_VARIABLES),
      ...STRIPE_VARIABLES,
    ]);
  });

  it("requires JWT_PRIVATE_KEY_FILE and refuses a missing file or one that others may read, without its path", () => {
    const readable = writeTestKeyFile(ed25519PrivateKeyPem(), 0o644);
    try {
      expect(configError({ ...DEVELOPMENT, JWT_PRIVATE_KEY_FILE: undefined }).problems).toEqual([
        { variable: "JWT_PRIVATE_KEY_FILE", reason: "is required but missing" },
      ]);
      for (const path of [readable.path, join(readable.path, "..", "missing.pem")]) {
        const error = configError({ ...DEVELOPMENT, JWT_PRIVATE_KEY_FILE: path });

        expect(error.problems.map((problem) => problem.variable)).toEqual(["JWT_PRIVATE_KEY_FILE"]);
        expect(error.message).not.toContain(path);
        expect(error.message).not.toContain("PRIVATE KEY");
      }
    } finally {
      readable.remove();
    }
  });

  it("[PBE-021] requires API_KEY_PEPPER_FILE: a key file of at least 32 bytes that only its owner may read, never echoed", () => {
    const short = writeTestKeyFile(`${randomBytes(16).toString("base64")}\n`, 0o600);
    const readable = writeTestKeyFile(`${randomBytes(32).toString("base64")}\n`, 0o644);
    try {
      expect(configError({ ...REQUIRED, API_KEY_PEPPER_FILE: undefined }).problems).toEqual([
        { variable: "API_KEY_PEPPER_FILE", reason: "is required but missing" },
      ]);
      for (const path of [short.path, readable.path, join(short.path, "..", "missing-pepper")]) {
        const error = configError({ ...REQUIRED, API_KEY_PEPPER_FILE: path });

        expect(error.problems.map((problem) => problem.variable)).toEqual(["API_KEY_PEPPER_FILE"]);
        expect(error.message).not.toContain(path);
      }
      expect(parseConfig(REQUIRED).API_KEY_PEPPER_FILE).toBe(masterKeys.pepperFile);
    } finally {
      short.remove();
      readable.remove();
    }
  });

  it("[PBE-021] declares API_KEY_PEPPER_FILE in the key folder of every env template", () => {
    for (const [file, expected] of [
      [".env.example", ".local/keys/api-key-pepper"],
      ["platform/backend/.env.example", DEV_PEPPER_FILE],
      ["deploy/env/platform-backend.env.example", VM_PEPPER_FILE],
    ] as const) {
      const values = readEnvFile(join(REPO_ROOT, file));

      expect(values["API_KEY_PEPPER_FILE"], file).toBe(expected);
      expect(values["API_KEY_PEPPER_FILE"], file).toBe(
        `${values["MASTER_KEY_DIR"] ?? "missing"}/api-key-pepper`,
      );
    }
  });

  it("reads the six FEATURE_* switches (default false) and MAX_TENANTS_PER_ACCOUNT (default 3)", () => {
    const on = parseConfig({
      ...REQUIRED,
      // The Stripe switches need their Stripe variables since PBE-043.
      ...STRIPE_TEST_VALUES,
      FEATURE_STRIPE_BILLING: "true",
      FEATURE_OWN_STRIPE: "1",
      FEATURE_SETTLEMENTS: "false",
      FEATURE_OWN_AMADEUS: "0",
      FEATURE_CUSTOM_DOMAINS: "",
      FEATURE_LIVE_SWITCH: "true",
      MAX_TENANTS_PER_ACCOUNT: "5",
    });

    expect(on).toMatchObject({
      FEATURE_STRIPE_BILLING: true,
      FEATURE_OWN_STRIPE: true,
      FEATURE_SETTLEMENTS: false,
      FEATURE_OWN_AMADEUS: false,
      FEATURE_CUSTOM_DOMAINS: false,
      FEATURE_LIVE_SWITCH: true,
      MAX_TENANTS_PER_ACCOUNT: 5,
    });
    expect(
      configError({ ...REQUIRED, FEATURE_LIVE_SWITCH: "yes", MAX_TENANTS_PER_ACCOUNT: "0" }).problems.map(
        (problem) => problem.variable,
      ),
    ).toEqual(["MAX_TENANTS_PER_ACCOUNT", "FEATURE_LIVE_SWITCH"]);
  });

  it("requires PLATFORM_BFF_KEY (PADR-0019)", () => {
    const error = configError({ ...DEVELOPMENT, PLATFORM_BFF_KEY: undefined });

    expect(error.problems).toEqual([{ variable: "PLATFORM_BFF_KEY", reason: "is required but missing" }]);
  });

  it("refuses an empty, short or unsubstituted PLATFORM_BFF_KEY without echoing it", () => {
    for (const value of [
      "",
      "@@PLATFORM_BFF_KEY@@",
      "short_key_value_31_characters_x",
      "key with spaces 0123456789abcdef0123",
    ]) {
      const error = configError({ ...DEVELOPMENT, PLATFORM_BFF_KEY: value });

      expect(error.problems.map((problem) => problem.variable)).toEqual(["PLATFORM_BFF_KEY"]);
      if (value !== "") {
        expect(error.message).not.toContain(value);
      }
    }
  });

  it("uses the same PLATFORM_BFF_KEY as the portal's and the admin's .env.example (one shared key)", () => {
    const backend = readEnvFile(join(APP_DIR, ".env.example"))["PLATFORM_BFF_KEY"];

    expect(backend).toBeDefined();
    for (const file of [".env.example", "platform/frontend/.env.example", "platform/admin/.env.example"]) {
      expect(readEnvFile(join(REPO_ROOT, file))["PLATFORM_BFF_KEY"]).toBe(backend);
    }
  });
});

describe("parseConfig: the key folder and the e-mail settings (PBE-011)", () => {
  it("requires every e-mail and key variable", () => {
    for (const variable of MAIL_AND_KEY_VARIABLES) {
      expect(configError({ ...REQUIRED, [variable]: undefined }).problems, variable).toEqual([
        { variable, reason: "is required but missing" },
      ]);
    }
  });

  it("accepts the three MAIL_FROM forms of the env templates", () => {
    for (const from of [
      '"Velexis" <no-reply@mail.platform.example.com>',
      "Velexis <no-reply@mail.platform.example.com>",
      "Velexis (dev) <no-reply@mail.ota.example.com>",
      "no-reply@mail.platform.example.com",
    ]) {
      expect(parseConfig({ ...REQUIRED, MAIL_FROM: from }).MAIL_FROM).toBe(from);
    }
  });

  it.each([
    ["two addresses", "a@example.com, b@example.com"],
    ["a second address after the name", '"Velexis" <a@example.com>, b@example.com'],
    ["a header after a line break", "Velexis <a@example.com>\r\nBcc: b@example.com"],
    ["no address", "Velexis"],
    ["an address without a domain", "Velexis <no-reply@localhost>"],
  ])("refuses a MAIL_FROM with %s", (_case, from) => {
    expect(configError({ ...REQUIRED, MAIL_FROM: from }).problems.map((p) => p.variable)).toEqual([
      "MAIL_FROM",
    ]);
  });

  it("accepts smtp:// and smtps:// only, and never echoes the URL's password", () => {
    expect(parseConfig({ ...REQUIRED, SMTP_URL: "smtps://user:pw@smtp.example.com:465" }).SMTP_URL).toBe(
      "smtps://user:pw@smtp.example.com:465",
    );
    const error = configError({ ...REQUIRED, SMTP_URL: "https://user:secret-smtp-1@smtp.example.com" });

    expect(error.problems.map((p) => p.variable)).toEqual(["SMTP_URL"]);
    expect(error.message).not.toContain("secret-smtp-1");
  });

  it.each([
    "ops",
    "ops@localhost",
    "Ops <ops@example.com>",
    "a@example.com,b@example.com",
    '"ops"@example.com',
  ])("refuses OPS_ALERT_EMAIL=%s: one plain address only", (value) => {
    expect(configError({ ...REQUIRED, OPS_ALERT_EMAIL: value }).problems.map((p) => p.variable)).toEqual([
      "OPS_ALERT_EMAIL",
    ]);
  });

  it("checks addresses with exactly the OpenAPI `email` format (ajv-formats), up to 254 characters", () => {
    const openApiEmail = fullFormats.email;
    if (!(openApiEmail instanceof RegExp)) {
      throw new TypeError("ajv-formats' email format is no longer a regular expression");
    }

    // Every address the API accepts at sign-up can be queued: a sign-up never fails on its e-mail.
    expect(EMAIL_ADDRESS.source).toBe(`^(?=.{3,254}$)${openApiEmail.source.slice(1, -1)}$`);
    expect(EMAIL_ADDRESS.flags).toBe(openApiEmail.flags);
    for (const address of ["ana.lima+ota@example.com", `ana@${"a".repeat(64)}.example.com`]) {
      expect(openApiEmail.test(address), address).toBe(true);
      expect(EMAIL_ADDRESS.test(address), address).toBe(true);
    }
    expect(EMAIL_ADDRESS.test(`${"a".repeat(243)}@example.com`)).toBe(false);
  });

  it.each(["local:v0", "local:v01", "local:1", "kms:v1", ""])("refuses MASTER_KEY_CURRENT=%s", (value) => {
    expect(configError({ ...REQUIRED, MASTER_KEY_CURRENT: value }).problems.map((p) => p.variable)).toEqual([
      "MASTER_KEY_CURRENT",
    ]);
  });

  it("refuses a MASTER_KEY_DIR that is not an existing folder, and public URLs that are not http(s)", () => {
    const error = configError({
      ...REQUIRED,
      MASTER_KEY_DIR: join(masterKeys.path, "master-v1.key"),
      PUBLIC_PORTAL_URL: "platform.example.com",
      PUBLIC_PLATFORM_ADMIN_URL: "javascript:alert(1)",
    });

    expect(error.problems.map((p) => p.variable)).toEqual([
      "MASTER_KEY_DIR",
      "PUBLIC_PORTAL_URL",
      "PUBLIC_PLATFORM_ADMIN_URL",
    ]);
  });
});

describe("parseConfig: Stripe (PBE-043)", () => {
  it("[PBE-043] leaves the four Stripe variables optional while Stripe Billing and the OTA's own Stripe are off", () => {
    const config = parseConfig(REQUIRED);

    for (const variable of STRIPE_VARIABLES) {
      expect(config[variable], variable).toBeUndefined();
    }
    expect(parseConfig({ ...REQUIRED, ...STRIPE_TEST_VALUES })).toMatchObject(STRIPE_TEST_VALUES);
    // The settlements switch reads balance transactions in M5 (PBE-059 adds what it needs).
    expect(parseConfig({ ...REQUIRED, FEATURE_SETTLEMENTS: "true" }).STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("[PBE-043] requires the key and the billing secret with FEATURE_STRIPE_BILLING on, naming the switch", () => {
    expect(configError({ ...REQUIRED, FEATURE_STRIPE_BILLING: "true" }).problems).toEqual([
      { variable: "STRIPE_SECRET_KEY", reason: "is required while FEATURE_STRIPE_BILLING is on" },
      { variable: "STRIPE_BILLING_WEBHOOK_SECRET", reason: "is required while FEATURE_STRIPE_BILLING is on" },
    ]);
    expect(
      parseConfig({
        ...REQUIRED,
        FEATURE_STRIPE_BILLING: "true",
        STRIPE_SECRET_KEY: STRIPE_TEST_VALUES.STRIPE_SECRET_KEY,
        STRIPE_BILLING_WEBHOOK_SECRET: STRIPE_TEST_VALUES.STRIPE_BILLING_WEBHOOK_SECRET,
      }).FEATURE_STRIPE_BILLING,
    ).toBe(true);
  });

  it("[PBE-043] requires the key, the Connect client id and the Connect secret with FEATURE_OWN_STRIPE on", () => {
    expect(configError({ ...REQUIRED, FEATURE_OWN_STRIPE: "true" }).problems).toEqual([
      { variable: "STRIPE_SECRET_KEY", reason: "is required while FEATURE_OWN_STRIPE is on" },
      { variable: "STRIPE_CONNECT_CLIENT_ID", reason: "is required while FEATURE_OWN_STRIPE is on" },
      { variable: "STRIPE_CONNECT_WEBHOOK_SECRET", reason: "is required while FEATURE_OWN_STRIPE is on" },
    ]);
    expect(
      configError({ ...REQUIRED, FEATURE_STRIPE_BILLING: "true", FEATURE_OWN_STRIPE: "true" }).problems[0],
    ).toEqual({
      variable: "STRIPE_SECRET_KEY",
      reason: "is required while FEATURE_STRIPE_BILLING or FEATURE_OWN_STRIPE is on",
    });
  });

  it("[PBE-043] refuses Stripe values of another shape without echoing them, and reports them once", () => {
    const error = configError({
      ...REQUIRED,
      FEATURE_STRIPE_BILLING: "true",
      FEATURE_OWN_STRIPE: "true",
      STRIPE_SECRET_KEY: "pk_test_secret-value-1",
      STRIPE_BILLING_WEBHOOK_SECRET: "secret-value-2",
      STRIPE_CONNECT_CLIENT_ID: "acct_secret-value-3",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_secret value-4",
    });

    expect(error.problems.map((problem) => problem.variable)).toEqual([...STRIPE_VARIABLES]);
    for (const value of ["secret-value-1", "secret-value-2", "secret-value-3", "secret value-4"]) {
      expect(error.message).not.toContain(value);
    }
  });

  it("[PBE-043] accepts only test-mode keys outside production and only live-mode keys in production", () => {
    for (const key of ["sk_test_dummy", "rk_test_dummy"]) {
      expect(parseConfig({ ...REQUIRED, STRIPE_SECRET_KEY: key }).STRIPE_SECRET_KEY).toBe(key);
      expect(configError({ ...REQUIRED, APP_ENV: "production", STRIPE_SECRET_KEY: key }).problems).toEqual([
        {
          variable: "STRIPE_SECRET_KEY",
          reason: "must be a live-mode key with APP_ENV=production and a test-mode key otherwise",
        },
      ]);
    }
    for (const key of ["sk_live_dummy", "rk_live_dummy"]) {
      expect(
        parseConfig({ ...REQUIRED, APP_ENV: "production", STRIPE_SECRET_KEY: key }).STRIPE_SECRET_KEY,
      ).toBe(key);
      for (const appEnv of ["development", "test"]) {
        expect(
          configError({ ...REQUIRED, APP_ENV: appEnv, STRIPE_SECRET_KEY: key }).problems.map(
            (p) => p.variable,
          ),
        ).toEqual(["STRIPE_SECRET_KEY"]);
      }
    }
  });

  it("[PBE-043] declares the four Stripe variables in every env template: dummies locally, empty on the VM", () => {
    for (const file of [
      ".env.example",
      "platform/backend/.env.example",
      "deploy/env/platform-backend.env.example",
    ]) {
      const values = readEnvFile(join(REPO_ROOT, file));
      expect(
        STRIPE_VARIABLES.filter((variable) => values[variable] === undefined),
        file,
      ).toEqual([]);
      // The values parse with both Stripe switches on (the VM template's are empty until M5: switches off).
      const stripe = pick(values, STRIPE_VARIABLES);
      if (file.startsWith("deploy/")) {
        expect(Object.values(stripe), file).toEqual(["", "", "", ""]);
      } else {
        expect(
          parseConfig({ ...REQUIRED, ...stripe, FEATURE_STRIPE_BILLING: "true", FEATURE_OWN_STRIPE: "true" })
            .STRIPE_SECRET_KEY,
          file,
        ).toMatch(/^sk_test_/);
      }
    }
  });
});

describe("loadConfig", () => {
  it("validates the given variables without reading any .env.local file", () => {
    expect(() => loadConfig({ APP_ENV: "test" })).toThrow(ConfigError);
    expect(loadConfig({ ...REQUIRED, APP_ENV: "test" }).APP_ENV).toBe("test");
  });
});

describe("loadConfigOrReport", () => {
  it("[PBE-001 AC3] logs one fatal config.invalid line whose ConfigError names DATABASE_URL, and returns undefined", () => {
    const sink = logSink();

    const config = loadConfigOrReport(PLATFORM_PROCESSES.api, {
      env: { ...DEVELOPMENT, DATABASE_URL: undefined },
      logDestination: sink,
    });

    expect(config).toBeUndefined();
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toMatchObject({
      level: 60,
      app: "platform-api",
      env: "unknown",
      msg: "config.invalid",
      err: { type: "ConfigError" },
    });
    expect(JSON.stringify(sink.lines[0])).toContain("DATABASE_URL is required but missing");
  });

  it("never writes a value of the configuration into the line", () => {
    const sink = logSink();

    loadConfigOrReport(PLATFORM_PROCESSES.worker, {
      env: { ...DEVELOPMENT, DATABASE_URL: "mysql://user:secret-value-1@127.0.0.1/x" },
      logDestination: sink,
    });

    expect(sink.lines[0]).toMatchObject({ app: "platform-worker", msg: "config.invalid" });
    expect(JSON.stringify(sink.lines)).not.toContain("secret-value-1");
  });

  it("returns the configuration and logs nothing when it is valid", () => {
    const sink = logSink();

    expect(loadConfigOrReport(PLATFORM_PROCESSES.api, { env: REQUIRED, logDestination: sink })).toMatchObject(
      {
        PORT: 3100,
      },
    );
    expect(sink.lines).toEqual([]);
  });
});

describe("createProcessLogger", () => {
  it("writes JSON lines with app and env at LOG_LEVEL", () => {
    const sink = logSink();
    const logger = createProcessLogger(
      PLATFORM_PROCESSES.worker,
      { APP_ENV: "test", LOG_LEVEL: "warn" },
      sink,
    );

    logger.info("not written");
    logger.warn({ jobId: "job_1" }, "written");

    expect(sink.lines).toEqual([
      expect.objectContaining({
        level: 40,
        app: "platform-worker",
        env: "test",
        jobId: "job_1",
        msg: "written",
      }),
    ]);
  });
});
