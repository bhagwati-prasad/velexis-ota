import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError } from "@velexis/config";
import { afterAll, describe, expect, it } from "vitest";
import { createTestJwtKeyFile, ed25519PrivateKeyPem, writeTestKeyFile } from "../test/support/jwt-key";
import { FEATURE_VARIABLES, FEATURES } from "./common/features";
import {
  APP_DIR,
  createProcessLogger,
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

afterAll(() => {
  jwtKey.remove();
});

/** The development values of platform/backend/.env.example (dummy values only), with the key file above. */
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
} as const;

/** The variables without a default: the minimum a process needs. */
const REQUIRED = {
  APP_ENV: DEVELOPMENT.APP_ENV,
  DATABASE_URL: DEVELOPMENT.DATABASE_URL,
  REDIS_URL: DEVELOPMENT.REDIS_URL,
  PLATFORM_BFF_KEY: DEVELOPMENT.PLATFORM_BFF_KEY,
  JWT_PRIVATE_KEY_FILE: DEVELOPMENT.JWT_PRIVATE_KEY_FILE,
} as const;

/** Where `pnpm dev:keys` puts the development key, and where provision-vm.sh puts the key on the VM. */
const DEV_JWT_KEY_FILE = "./.local/keys/platform-jwt-ed25519.pem";
const VM_JWT_KEY_FILE = "/etc/velexis/keys/platform/platform-jwt-ed25519.pem";

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
    ]) {
      expect(error.message).not.toContain(value);
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
      "TRUST_PROXY",
    ]);
  });

  it("accepts the app's .env.example, with the key file pnpm dev:keys creates", () => {
    const example = readEnvFile(join(APP_DIR, ".env.example"));
    const config = parseConfig({ ...example, JWT_PRIVATE_KEY_FILE: jwtKey.path });

    expect(example["JWT_PRIVATE_KEY_FILE"]).toBe(DEV_JWT_KEY_FILE);
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
    const vm = { ...template, PLATFORM_BFF_KEY: GENERATED_BFF_KEY, JWT_PRIVATE_KEY_FILE: jwtKey.path };
    const api = parseConfig({ ...vm, PORT: "3100" });
    const worker = parseConfig({ ...vm, HEALTH_PORT: "3101" });

    expect(template.PLATFORM_BFF_KEY).toBe("@@PLATFORM_BFF_KEY@@");
    expect(template.JWT_PRIVATE_KEY_FILE).toBe(VM_JWT_KEY_FILE);
    expect(api.APP_ENV).toBe("production");
    expect(api.TRUST_PROXY).toEqual(["loopback"]);
    expect(api.PLATFORM_BFF_KEY).toBe(GENERATED_BFF_KEY);
    expect(api.MAX_TENANTS_PER_ACCOUNT).toBe(3);
    for (const feature of FEATURES) {
      expect(api[FEATURE_VARIABLES[feature]]).toBe(false);
    }
    expect(worker.HEALTH_PORT).toBe(3101);
  });

  it("declares JWT_PRIVATE_KEY_FILE, TRUST_PROXY, MAX_TENANTS_PER_ACCOUNT and the switches, switches off, in every env template", () => {
    const variables = [
      "JWT_PRIVATE_KEY_FILE",
      "TRUST_PROXY",
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
      for (const variable of Object.values(FEATURE_VARIABLES)) {
        expect(values[variable], `${file} ${variable}`).toBe("false");
      }
    }
    // The worker's overlay holds only comments (deploy.test.sh): the API and the worker see the same switches.
    expect(readEnvFile(join(REPO_ROOT, "deploy/env/platform-worker.env.example"))).toEqual({});
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
      "MAX_TENANTS_PER_ACCOUNT",
      ...Object.values(FEATURE_VARIABLES),
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

  it("reads the six FEATURE_* switches (default false) and MAX_TENANTS_PER_ACCOUNT (default 3)", () => {
    const on = parseConfig({
      ...REQUIRED,
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
