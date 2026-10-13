import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { ConfigError } from "@velexis/config";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import { ADMIN_CONFIG_SCHEMA, parseConfig } from "./config";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(APP_DIR, "..", "..");

/** The development values of platform/admin/.env.example (dummy values only). */
const DEVELOPMENT = {
  APP_ENV: "development",
  LOG_LEVEL: "debug",
  PORT: "3001",
  HOSTNAME: "127.0.0.1",
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PUBLIC_PLATFORM_ADMIN_URL: "http://localhost:3001",
  PUBLIC_PORTAL_URL: "http://localhost:3000",
  SENTRY_DSN: "",
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

function readEnvFile(path: string): Record<string, string | undefined> {
  return parseEnv(readFileSync(path, "utf8"));
}

/** The `Environment=NAME=value` lines of a systemd unit, as a plain object. */
function unitEnvironment(path: string): Record<string, string> {
  const lines = readFileSync(path, "utf8").split("\n");
  const pairs = lines
    .map((line) => /^Environment=([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => [match[1]!, match[2]!] as const);
  return Object.fromEntries(pairs);
}

/** Every file of `dir`, recursively, as paths relative to the app folder. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(APP_DIR, join(entry.parentPath, entry.name)));
}

describe("parseConfig", () => {
  it("[PAD-001 AC2] refuses a missing PLATFORM_API_URL", () => {
    const error = configError({ ...DEVELOPMENT, PLATFORM_API_URL: undefined });

    expect(error.problems).toEqual([{ variable: "PLATFORM_API_URL", reason: "is required but missing" }]);
    expect(error.message).toContain("PLATFORM_API_URL");
  });

  it("[PAD-001 AC2] refuses an empty PLATFORM_API_URL", () => {
    const error = configError({ ...DEVELOPMENT, PLATFORM_API_URL: "" });

    expect(error.problems.map((problem) => problem.variable)).toEqual(["PLATFORM_API_URL"]);
  });

  it("[PAD-001 AC2] refuses a PLATFORM_API_URL that is not an http(s) URL", () => {
    for (const value of ["127.0.0.1:3100", "ftp://127.0.0.1:3100", "not a url"]) {
      const error = configError({ ...DEVELOPMENT, PLATFORM_API_URL: value });

      expect(error.problems.map((problem) => problem.variable)).toEqual(["PLATFORM_API_URL"]);
    }
  });

  it("accepts the development values and applies the defaults", () => {
    const config = parseConfig({
      APP_ENV: "test",
      PLATFORM_API_URL: DEVELOPMENT.PLATFORM_API_URL,
      PUBLIC_PLATFORM_ADMIN_URL: DEVELOPMENT.PUBLIC_PLATFORM_ADMIN_URL,
      PUBLIC_PORTAL_URL: DEVELOPMENT.PUBLIC_PORTAL_URL,
    });

    expect(config).toEqual({
      APP_ENV: "test",
      LOG_LEVEL: "info",
      PORT: 3001,
      HOSTNAME: "127.0.0.1",
      PLATFORM_API_URL: "http://127.0.0.1:3100",
      PUBLIC_PLATFORM_ADMIN_URL: "http://localhost:3001",
      PUBLIC_PORTAL_URL: "http://localhost:3000",
      SENTRY_DSN: undefined,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("names every missing required variable at once", () => {
    const error = configError({});

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      "APP_ENV",
      "PLATFORM_API_URL",
      "PUBLIC_PLATFORM_ADMIN_URL",
      "PUBLIC_PORTAL_URL",
    ]);
  });

  it("names every invalid variable at once and never echoes a value", () => {
    const error = configError({
      ...DEVELOPMENT,
      APP_ENV: "staging-value-1",
      PORT: "port-value-2",
      PLATFORM_API_URL: "ftp://api-value-3.example",
      HOSTNAME: "bad host/value-4",
      SENTRY_DSN: "http://dsn-value-5@sentry.example/1",
      LOG_LEVEL: "verbose-value-6",
    });

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      "APP_ENV",
      "HOSTNAME",
      "LOG_LEVEL",
      "PLATFORM_API_URL",
      "PORT",
      "SENTRY_DSN",
    ]);
    for (const value of ["value-1", "value-2", "value-3", "value-4", "value-5", "value-6"]) {
      expect(error.message).not.toContain(value);
    }
  });

  it("requires https public URLs when APP_ENV is production", () => {
    const error = configError({
      ...DEVELOPMENT,
      APP_ENV: "production",
      PUBLIC_PLATFORM_ADMIN_URL: "http://admin.platform.example.com",
      PUBLIC_PORTAL_URL: "https://platform.example.com",
    });

    expect(error.problems).toEqual([
      { variable: "PUBLIC_PLATFORM_ADMIN_URL", reason: "must use https: when APP_ENV is production" },
    ]);
  });

  it("reports the production https rule in the same error as the other problems", () => {
    const error = configError({
      ...DEVELOPMENT,
      APP_ENV: "production",
      PLATFORM_API_URL: undefined,
      PUBLIC_PLATFORM_ADMIN_URL: "http://admin.platform.example.com",
      PUBLIC_PORTAL_URL: "not-a-url",
    });

    expect(error.problems.map((problem) => problem.variable)).toEqual([
      "PLATFORM_API_URL",
      "PUBLIC_PORTAL_URL",
      "PUBLIC_PLATFORM_ADMIN_URL",
    ]);
    expect(error.problems[2]).toEqual({
      variable: "PUBLIC_PLATFORM_ADMIN_URL",
      reason: "must use https: when APP_ENV is production",
    });
  });

  it("does not apply the https rule outside production", () => {
    const config = parseConfig({
      ...DEVELOPMENT,
      APP_ENV: "test",
      PUBLIC_PLATFORM_ADMIN_URL: "http://admin.platform.example.com",
    });

    expect(config.PUBLIC_PLATFORM_ADMIN_URL).toBe("http://admin.platform.example.com");
  });

  it("accepts the app's .env.example", () => {
    const config = parseConfig(readEnvFile(join(APP_DIR, ".env.example")));

    expect(config.APP_ENV).toBe("development");
    expect(config.PORT).toBe(3001);
    expect(config.PLATFORM_API_URL).toBe("http://127.0.0.1:3100");
  });

  it("accepts the VM template with the PORT and HOSTNAME of the systemd unit", () => {
    const template = readEnvFile(join(REPO_ROOT, "deploy/env/platform-admin.env.example"));
    const unit = unitEnvironment(join(REPO_ROOT, "deploy/systemd/velexis-platform-admin.service"));
    const config = parseConfig({ ...template, PORT: unit["PORT"], HOSTNAME: unit["HOSTNAME"] });

    expect(config.APP_ENV).toBe("production");
    expect(config.PORT).toBe(3001);
    expect(config.HOSTNAME).toBe("127.0.0.1");
    expect(config.PUBLIC_PLATFORM_ADMIN_URL).toBe("https://admin.platform.example.com");
    expect(config.PUBLIC_PORTAL_URL).toBe("https://platform.example.com");
  });
});

describe("browser exposure", () => {
  const PUBLIC_PREFIX = /NEXT_PUBLIC_/;

  it("declares no NEXT_PUBLIC_ variable", () => {
    expect(Object.keys(ADMIN_CONFIG_SCHEMA).filter((name) => PUBLIC_PREFIX.test(name))).toEqual([]);
  });

  it("no source file, Next.js config or package script of the admin uses a NEXT_PUBLIC_ variable", () => {
    const files = [
      ...listFiles(join(APP_DIR, "src")).filter((file) => !/\.test\.tsx?$/.test(file)),
      "next.config.ts",
      "package.json",
    ];
    const offenders = files.filter((file) => PUBLIC_PREFIX.test(readFileSync(join(APP_DIR, file), "utf8")));

    expect(files).toContain("src/lib/config.ts");
    expect(offenders).toEqual([]);
  });

  it("neither env example of the admin sets a NEXT_PUBLIC_ variable", () => {
    for (const path of [
      join(APP_DIR, ".env.example"),
      join(REPO_ROOT, "deploy/env/platform-admin.env.example"),
    ]) {
      const names = Object.keys(readEnvFile(path));

      expect(names).toContain("PLATFORM_API_URL");
      expect(names.filter((name) => PUBLIC_PREFIX.test(name))).toEqual([]);
    }
  });

  it("next.config inlines no variable into browser bundles", () => {
    expect(nextConfig).not.toHaveProperty("env");
  });

  it("config.ts is a server-only module", () => {
    const source = readFileSync(join(APP_DIR, "src/lib/config.ts"), "utf8");

    expect(source.startsWith('import "server-only";\n')).toBe(true);
  });
});
