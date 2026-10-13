import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError } from "@velexis/config";
import { describe, expect, it } from "vitest";
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

/** The development values of platform/backend/.env.example (dummy values only). */
const DEVELOPMENT = {
  APP_ENV: "development",
  LOG_LEVEL: "debug",
  PORT: "3100",
  HEALTH_PORT: "3101",
  TRUST_PROXY: "loopback",
  DATABASE_URL: "postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis",
  REDIS_URL: "redis://:dev_redis@127.0.0.1:6379/0",
} as const;

/** The variables without a default: the minimum a process needs. */
const REQUIRED = {
  APP_ENV: DEVELOPMENT.APP_ENV,
  DATABASE_URL: DEVELOPMENT.DATABASE_URL,
  REDIS_URL: DEVELOPMENT.REDIS_URL,
} as const;

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
    });

    expect(error.problems.map((problem) => problem.variable)).toEqual([
      "APP_ENV",
      "LOG_LEVEL",
      "PORT",
      "HEALTH_PORT",
      "DATABASE_URL",
      "REDIS_URL",
    ]);
    for (const value of ["value-1", "value-2", "value-3", "70000", "secret-value-4", "secret-value-5"]) {
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
      "TRUST_PROXY",
    ]);
  });

  it("accepts the app's .env.example", () => {
    const config = parseConfig(readEnvFile(join(APP_DIR, ".env.example")));

    expect(config.APP_ENV).toBe("development");
    expect(config.PORT).toBe(3100);
    expect(config.HEALTH_PORT).toBe(3101);
  });

  it("accepts the VM template with the ports of the systemd units", () => {
    const template = readEnvFile(join(REPO_ROOT, "deploy/env/platform-backend.env.example"));
    const api = parseConfig({ ...template, PORT: "3100" });
    const worker = parseConfig({ ...template, HEALTH_PORT: "3101" });

    expect(api.APP_ENV).toBe("production");
    expect(api.TRUST_PROXY).toEqual(["loopback"]);
    expect(worker.HEALTH_PORT).toBe(3101);
  });

  it("declares only variables of the configuration matrix that the M0 processes read", () => {
    expect(Object.keys(PLATFORM_BACKEND_CONFIG_SCHEMA)).toEqual([
      "APP_ENV",
      "LOG_LEVEL",
      "PORT",
      "HEALTH_PORT",
      "TRUST_PROXY",
      "DATABASE_URL",
      "REDIS_URL",
    ]);
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
