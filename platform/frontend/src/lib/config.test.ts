import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { ConfigError } from "@velexis/config";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import { PORTAL_CONFIG_SCHEMA, parseConfig } from "./config";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(APP_DIR, "..", "..");

/** The development values of platform/frontend/.env.example (dummy values only). */
const DEVELOPMENT = {
  APP_ENV: "development",
  LOG_LEVEL: "debug",
  PORT: "3000",
  HOSTNAME: "127.0.0.1",
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PUBLIC_PORTAL_URL: "http://localhost:3000",
  PUBLIC_OTA_ADMIN_URL: "http://localhost:3002",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
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

/** Every file of `dir`, recursively, as paths relative to the app folder. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(APP_DIR, join(entry.parentPath, entry.name)));
}

describe("parseConfig", () => {
  it("[PFE-001 AC3] refuses a missing PLATFORM_API_URL", () => {
    const error = configError({ ...DEVELOPMENT, PLATFORM_API_URL: undefined });

    expect(error.problems).toEqual([{ variable: "PLATFORM_API_URL", reason: "is required but missing" }]);
    expect(error.message).toContain("PLATFORM_API_URL");
  });

  it("[PFE-001 AC3] refuses an empty PLATFORM_API_URL", () => {
    const error = configError({ ...DEVELOPMENT, PLATFORM_API_URL: "" });

    expect(error.problems.map((problem) => problem.variable)).toEqual(["PLATFORM_API_URL"]);
  });

  it("accepts the development values and applies the defaults", () => {
    const config = parseConfig({
      APP_ENV: "test",
      PLATFORM_API_URL: DEVELOPMENT.PLATFORM_API_URL,
      PUBLIC_PORTAL_URL: DEVELOPMENT.PUBLIC_PORTAL_URL,
      PUBLIC_OTA_ADMIN_URL: DEVELOPMENT.PUBLIC_OTA_ADMIN_URL,
      STOREFRONT_BASE_DOMAIN: DEVELOPMENT.STOREFRONT_BASE_DOMAIN,
    });

    expect(config).toEqual({
      APP_ENV: "test",
      LOG_LEVEL: "info",
      PORT: 3000,
      HOSTNAME: "127.0.0.1",
      PLATFORM_API_URL: "http://127.0.0.1:3100",
      PUBLIC_PORTAL_URL: "http://localhost:3000",
      PUBLIC_OTA_ADMIN_URL: "http://localhost:3002",
      STOREFRONT_BASE_DOMAIN: "ota.example.com",
      SENTRY_DSN: undefined,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("names every invalid variable at once and never echoes a value", () => {
    const error = configError({
      ...DEVELOPMENT,
      APP_ENV: "staging-value-1",
      PORT: "port-value-2",
      PLATFORM_API_URL: "ftp://api-value-3.example",
      STOREFRONT_BASE_DOMAIN: "Not A Domain-value-4",
      SENTRY_DSN: "http://dsn-value-5@sentry.example/1",
    });

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      "APP_ENV",
      "PLATFORM_API_URL",
      "PORT",
      "SENTRY_DSN",
      "STOREFRONT_BASE_DOMAIN",
    ]);
    for (const value of ["value-1", "value-2", "value-3", "value-4", "value-5"]) {
      expect(error.message).not.toContain(value);
    }
  });

  it("requires https public URLs when APP_ENV is production", () => {
    const error = configError({
      ...DEVELOPMENT,
      APP_ENV: "production",
      PUBLIC_PORTAL_URL: "http://platform.example.com",
      PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
    });

    expect(error.problems).toEqual([
      { variable: "PUBLIC_PORTAL_URL", reason: "must use https: when APP_ENV is production" },
    ]);
  });

  it("reports the production https rule in the same error as the other problems", () => {
    const error = configError({
      ...DEVELOPMENT,
      APP_ENV: "production",
      PLATFORM_API_URL: undefined,
      PUBLIC_PORTAL_URL: "http://platform.example.com",
      PUBLIC_OTA_ADMIN_URL: "not-a-url",
    });

    expect(error.problems.map((problem) => problem.variable)).toEqual([
      "PLATFORM_API_URL",
      "PUBLIC_OTA_ADMIN_URL",
      "PUBLIC_PORTAL_URL",
    ]);
    expect(error.problems[2]).toEqual({
      variable: "PUBLIC_PORTAL_URL",
      reason: "must use https: when APP_ENV is production",
    });
  });

  it("does not apply the https rule outside production", () => {
    const config = parseConfig({
      ...DEVELOPMENT,
      APP_ENV: "test",
      PUBLIC_PORTAL_URL: "http://platform.example.com",
    });

    expect(config.PUBLIC_PORTAL_URL).toBe("http://platform.example.com");
  });

  it("accepts the app's .env.example", () => {
    const config = parseConfig(readEnvFile(join(APP_DIR, ".env.example")));

    expect(config.APP_ENV).toBe("development");
    expect(config.PLATFORM_API_URL).toBe("http://127.0.0.1:3100");
  });

  it("accepts the VM template with the PORT and HOSTNAME of the systemd unit", () => {
    const template = readEnvFile(join(REPO_ROOT, "deploy/env/platform-frontend.env.example"));
    const config = parseConfig({ ...template, PORT: "3000", HOSTNAME: "127.0.0.1" });

    expect(config.APP_ENV).toBe("production");
    expect(config.PUBLIC_PORTAL_URL).toBe("https://platform.example.com");
  });
});

describe("browser exposure", () => {
  const PUBLIC_PREFIX = /NEXT_PUBLIC_/;

  it("[PFE-001 AC3] declares no NEXT_PUBLIC_ variable", () => {
    expect(Object.keys(PORTAL_CONFIG_SCHEMA).filter((name) => PUBLIC_PREFIX.test(name))).toEqual([]);
  });

  it("[PFE-001 AC3] no source file, Next.js config or package script of the portal uses a NEXT_PUBLIC_ variable", () => {
    const files = [
      ...listFiles(join(APP_DIR, "src")).filter((file) => !/\.test\.tsx?$/.test(file)),
      "next.config.ts",
      "package.json",
    ];
    const offenders = files.filter((file) => PUBLIC_PREFIX.test(readFileSync(join(APP_DIR, file), "utf8")));

    expect(files).toContain("src/lib/config.ts");
    expect(offenders).toEqual([]);
  });

  it("[PFE-001 AC3] neither env example of the portal sets a NEXT_PUBLIC_ variable", () => {
    for (const path of [
      join(APP_DIR, ".env.example"),
      join(REPO_ROOT, "deploy/env/platform-frontend.env.example"),
    ]) {
      const names = Object.keys(readEnvFile(path));

      expect(names).toContain("PLATFORM_API_URL");
      expect(names.filter((name) => PUBLIC_PREFIX.test(name))).toEqual([]);
    }
  });

  it("[PFE-001 AC3] next.config inlines no variable into browser bundles", () => {
    expect(nextConfig).not.toHaveProperty("env");
  });

  it("config.ts is a server-only module", () => {
    const source = readFileSync(join(APP_DIR, "src/lib/config.ts"), "utf8");

    expect(source.startsWith('import "server-only";\n')).toBe(true);
  });
});
