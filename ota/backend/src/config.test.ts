import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError } from "@velexis/config";
import { describe, expect, it, vi } from "vitest";
import {
  apiConfigSchema,
  APP_DIR,
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
const WORKER_ENV = { ...SHARED, DATABASE_PROVISIONER_URL: PROVISIONER_URL } as const;

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

/** A deploy/env template with its `@@NAME@@` placeholders replaced, as provision-vm.sh does with generated values. */
function renderedTemplate(name: string): Record<string, string> {
  const text = readFileSync(join(REPO_ROOT, "deploy/env", name), "utf8").replace(/@@[A-Z_]+@@/g, "generated");
  return Object.fromEntries(
    Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe("a missing DATABASE_URL", () => {
  it("fails the API's configuration with a ConfigError naming DATABASE_URL [OBE-001 AC3]", () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = SHARED;

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
    const error = configErrorOf(() => loadApiConfig({ ...SHARED, DATABASE_URL: "" }));

    expect(error.problems.map((problem) => problem.variable)).toEqual(["DATABASE_URL"]);
  });
});

describe("the privileged DSNs", () => {
  it("never appear in the API's configuration, even when they are set [OBE-001 AC3]", () => {
    const config: ApiConfig = loadApiConfig({
      ...SHARED,
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
      DATABASE_MIGRATOR_URL: MIGRATOR_URL,
    });

    expect(Object.keys(config).sort()).toEqual([
      "APP_ENV",
      "DATABASE_URL",
      "LOG_LEVEL",
      "PORT",
      "REDIS_URL",
      "TRUST_PROXY",
    ]);
    expect(JSON.stringify(config)).not.toContain("velexis_provisioner");
    expect(JSON.stringify(config)).not.toContain("velexis_migrator");
    // @ts-expect-error The API's configuration type has no worker DSN either.
    expect(config.DATABASE_PROVISIONER_URL).toBeUndefined();
  });

  it("are not required by the API: it starts without the worker's DSN [OBE-001 AC3]", () => {
    expect(loadApiConfig(SHARED).DATABASE_URL).toBe(SHARED.DATABASE_URL);
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
      "REDIS_URL",
    ]);
    expect(JSON.stringify(config)).not.toContain("velexis_migrator");
  });

  it("make the worker refuse to start without DATABASE_PROVISIONER_URL [OBE-001 AC3]", () => {
    const error = configErrorOf(() => loadWorkerConfig(SHARED));

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
    });
    const worker = loadWorkerConfig({
      APP_ENV: "test",
      DATABASE_URL: SHARED.DATABASE_URL,
      REDIS_URL: SHARED.REDIS_URL,
      DATABASE_PROVISIONER_URL: PROVISIONER_URL,
    });

    expect(api).toEqual({
      APP_ENV: "test",
      LOG_LEVEL: "info",
      DATABASE_URL: SHARED.DATABASE_URL,
      REDIS_URL: SHARED.REDIS_URL,
      PORT: 4000,
      TRUST_PROXY: ["loopback"],
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
    const config = loadApiConfig({ ...SHARED, TRUST_PROXY: "loopback, uniquelocal,10.0.0.0/8,::1,fd00::/8" });

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
      const error = configErrorOf(() => loadApiConfig({ ...SHARED, TRUST_PROXY: value }));

      expect(error.problems.map((problem) => problem.variable)).toEqual(["TRUST_PROXY"]);
    }
  });
});

describe("example and template files", () => {
  it("accept the local values of the root and app .env.example files", () => {
    const local = {
      ...readEnvFile(join(REPO_ROOT, ".env.example")),
      ...readEnvFile(join(APP_DIR, ".env.example")),
    };

    const api = loadApiConfig(local);
    const worker = loadWorkerConfig(local);

    expect(api.APP_ENV).toBe("development");
    expect(api.DATABASE_URL).toContain("velexis_ota_app");
    expect(api.PORT).toBe(4000);
    expect(worker.HEALTH_PORT).toBe(4001);
    expect(worker.DATABASE_PROVISIONER_URL).toContain("velexis_provisioner");
  });

  it("matches deploy/env: every variable of both schemas is in the unit's env files, except the ports", () => {
    const shared = renderedTemplate("ota-backend.env.example");
    const worker = renderedTemplate("ota-worker.env.example");

    expect(loadApiConfig(shared).APP_ENV).toBe("production");
    expect(loadWorkerConfig({ ...shared, ...worker }).APP_ENV).toBe("production");
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
    for (const [name, value] of Object.entries(SHARED)) {
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
