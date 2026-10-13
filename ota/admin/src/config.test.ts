import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { ConfigError } from "@velexis/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { configSchema, loadConfig, type OtaAdminConfig } from "./config";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Dummy values of the shape the VM uses; nothing here is a real secret. */
const VALID_ENV = {
  APP_ENV: "production",
  LOG_LEVEL: "info",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  OTA_API_URL: "http://127.0.0.1:4000",
  OTA_ADMIN_SERVICE_KEY: `sk_svc_${"0".repeat(48)}`,
  SENTRY_DSN: "",
} as const;

function readEnvFile(path: string): Record<string, string> {
  const parsed = parseEnv(readFileSync(path, "utf8"));
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

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

describe("loadConfig", () => {
  it("fails with a ConfigError naming OTA_ADMIN_SERVICE_KEY when it is missing [OAD-001 AC2]", () => {
    const { OTA_ADMIN_SERVICE_KEY: _omitted, ...withoutKey } = VALID_ENV;

    const error = configErrorOf(() => loadConfig(withoutKey));

    expect(error.problems).toEqual([
      { variable: "OTA_ADMIN_SERVICE_KEY", reason: "is required but missing" },
    ]);
    expect(error.message).toContain("OTA_ADMIN_SERVICE_KEY");
  });

  it("fails on an empty OTA_ADMIN_SERVICE_KEY or the unsubstituted deploy placeholder [OAD-001 AC2]", () => {
    for (const value of ["", "@@OTA_ADMIN_SERVICE_KEY@@", "sk_short"]) {
      const error = configErrorOf(() => loadConfig({ ...VALID_ENV, OTA_ADMIN_SERVICE_KEY: value }));

      expect(error.problems.map((problem) => problem.variable)).toEqual(["OTA_ADMIN_SERVICE_KEY"]);
      if (value !== "") {
        expect(error.message).not.toContain(value);
      }
    }
  });

  it("names every invalid variable at once and never echoes a value", () => {
    const secret = "sk_dev_this_value_must_never_be_printed";
    const error = configErrorOf(() =>
      loadConfig({
        APP_ENV: "staging",
        PUBLIC_OTA_ADMIN_URL: "admin.ota.example.com",
        OTA_API_URL: `http://${secret}@api.ota.example.com`,
      }),
    );

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      "APP_ENV",
      "OTA_ADMIN_SERVICE_KEY",
      "OTA_API_URL",
      "PUBLIC_OTA_ADMIN_URL",
      "PUBLIC_PORTAL_URL",
    ]);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("staging");
  });

  it("returns a frozen, typed configuration with the defaults of README §11", () => {
    const { LOG_LEVEL: _level, ...withoutLevel } = VALID_ENV;

    const config: OtaAdminConfig = loadConfig(withoutLevel);

    expect(config).toEqual({
      APP_ENV: "production",
      LOG_LEVEL: "info",
      PORT: 3002,
      PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
      PUBLIC_PORTAL_URL: "https://platform.example.com",
      OTA_API_URL: "http://127.0.0.1:4000",
      OTA_ADMIN_SERVICE_KEY: VALID_ENV.OTA_ADMIN_SERVICE_KEY,
      SENTRY_DSN: undefined,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("accepts the OTA API only on the loopback interface, where the service key is honoured", () => {
    for (const url of ["http://127.0.0.1:4000", "http://localhost:4000", "http://[::1]:4000"]) {
      expect(loadConfig({ ...VALID_ENV, OTA_API_URL: url }).OTA_API_URL).toBe(url);
    }
    for (const url of ["https://api.ota.example.com", "http://10.0.0.5:4000", "https://127.0.0.1:4000"]) {
      const error = configErrorOf(() => loadConfig({ ...VALID_ENV, OTA_API_URL: url }));
      expect(error.problems.map((problem) => problem.variable)).toEqual(["OTA_API_URL"]);
    }
  });

  it("accepts the local values of the root and app .env.example files", () => {
    const local = {
      ...readEnvFile(join(REPO_ROOT, ".env.example")),
      ...readEnvFile(join(APP_DIR, ".env.example")),
    };

    const config = loadConfig(local);

    expect(config.APP_ENV).toBe("development");
    expect(config.PORT).toBe(3002);
    expect(config.OTA_API_URL).toBe("http://127.0.0.1:4000");
  });

  it("matches deploy/env/ota-admin.env.example, the template of /etc/velexis/ota-admin.env", () => {
    const template = readEnvFile(join(REPO_ROOT, "deploy/env/ota-admin.env.example"));
    // provision-vm.sh substitutes the generated key (sk_svc_<48 hex>) for the placeholder.
    const onTheVm = { ...template, OTA_ADMIN_SERVICE_KEY: VALID_ENV.OTA_ADMIN_SERVICE_KEY };

    expect(loadConfig(onTheVm).APP_ENV).toBe("production");
    // Every variable of the schema is in the template, except PORT, which the velexis-ota-admin unit sets.
    expect(Object.keys(template).sort()).toEqual(
      Object.keys(configSchema)
        .filter((name) => name !== "PORT")
        .sort(),
    );
  });
});

describe("getConfig", () => {
  // The static import at the top of this file already loaded ./config: every test imports a fresh copy after
  // stubbing the environment, so a module that validated at load time would fail the import itself.
  beforeEach(() => {
    vi.resetModules();
  });

  it("validates the process environment on first use, not when the module is loaded [OAD-001 AC2]", async () => {
    // production: loadDevEnvFiles reads no .env.local file, so only the stubbed environment counts.
    for (const [name, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("OTA_ADMIN_SERVICE_KEY", "");

    const { getConfig } = await import("./config");
    const error = configErrorOf(() => getConfig());

    expect(error.problems.map((problem) => problem.variable)).toEqual(["OTA_ADMIN_SERVICE_KEY"]);
  });

  it("returns the same validated configuration on every call", async () => {
    for (const [name, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(name, value);
    }

    const { getConfig } = await import("./config");
    const first = getConfig();
    vi.stubEnv("OTA_API_URL", "http://127.0.0.1:4999");

    expect(first.OTA_API_URL).toBe("http://127.0.0.1:4000");
    expect(getConfig()).toBe(first);
  });
});

describe("next.config.ts", () => {
  it("builds a standalone server traced from the repository root, at the path the release expects [OAD-001 AC1]", () => {
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.outputFileTracingRoot).toBe(REPO_ROOT.replace(/[\\/]$/, ""));
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    // The server lands at .next/standalone/<app folder relative to the tracing root>/server.js.
    const appFolder = relative(nextConfig.outputFileTracingRoot ?? "", APP_DIR)
      .split(sep)
      .join("/");
    expect(appFolder).toBe("ota/admin");

    const packRelease = readFileSync(join(REPO_ROOT, "deploy/scripts/pack-release.sh"), "utf8");
    expect(packRelease).toContain("pack_next ota/admin ota-admin ota-admin");
    const unit = readFileSync(join(REPO_ROOT, "deploy/systemd/velexis-ota-admin.service"), "utf8");
    expect(unit).toContain("WorkingDirectory=/srv/velexis/current/ota-admin\n");
    expect(unit).toContain("ExecStart=/usr/bin/node ota/admin/server.js\n");
  });

  it("sends the static security headers and no X-Powered-By header", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = (await nextConfig.headers?.()) ?? [];

    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe("/:path*");
    expect(rules[0]?.headers).toEqual([
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ]);
  });

  it("accepts server action bodies up to 2 MB", () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("2mb");
  });
});

describe("NEXT_PUBLIC_ variables", () => {
  // Built from parts, so that this file does not name such a variable itself.
  const PREFIX = ["NEXT", "PUBLIC", ""].join("_");
  const PUBLIC_VARIABLE = new RegExp(`\\b${PREFIX}\\w`);
  const SKIPPED = new Set(["node_modules", ".next", ".turbo", "coverage"]);

  function filesOf(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (SKIPPED.has(entry.name)) {
        return [];
      }
      const path = join(dir, entry.name);
      return entry.isDirectory() ? filesOf(path) : [path];
    });
  }

  it("recognises a variable name and ignores prose about the prefix", () => {
    expect(PUBLIC_VARIABLE.test(`process.env.${PREFIX}OTA_API_URL`)).toBe(true);
    expect(PUBLIC_VARIABLE.test(`${PREFIX}SENTRY_DSN=`)).toBe(true);
    expect(PUBLIC_VARIABLE.test(`No ${PREFIX} variable exists in this app`)).toBe(false);
  });

  it("finds no NEXT_PUBLIC_ variable in any file of the app [OAD-001 AC4]", () => {
    const files = filesOf(APP_DIR);
    const relativePaths = files.map((file) => relative(APP_DIR, file).split(sep).join("/"));

    // The scan covers the sources, the Next.js configuration and the env example, so it cannot pass vacuously.
    expect(relativePaths).toEqual(
      expect.arrayContaining([".env.example", "next.config.ts", "src/config.ts", "src/app/layout.tsx"]),
    );
    const offenders = relativePaths.filter((_, index) =>
      PUBLIC_VARIABLE.test(readFileSync(files[index] ?? "", "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("has no env block in next.config.ts, which would inline values into browser bundles [OAD-001 AC4]", () => {
    expect(nextConfig.env).toBeUndefined();
  });
});
