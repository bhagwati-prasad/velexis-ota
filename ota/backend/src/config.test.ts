import {
  chmodSync,
  copyFileSync,
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
import { testApiCredentials, testApiVariables } from "../test/helpers/api-env";
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
/** The API-only variables (OBE-011): a random edge secret and a pepper file of this test process. */
const API_ONLY = testApiVariables();
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

/** A deploy/env template with its `@@NAME@@` placeholders replaced, as provision-vm.sh does with generated values. */
function renderedTemplate(name: string): Record<string, string> {
  const text = readFileSync(join(REPO_ROOT, "deploy/env", name), "utf8").replace(
    /@@[A-Z_]+@@/g,
    GENERATED_SECRET,
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
      "AMADEUS_BASE_URL_LIVE",
      "AMADEUS_BASE_URL_TEST",
      "API_KEY_PEPPER_FILE",
      "APP_ENV",
      "DATABASE_URL",
      "LOG_LEVEL",
      "MASTER_KEY_CURRENT",
      "MASTER_KEY_DIR",
      "PORT",
      "PUBLIC_OTA_API_URL",
      "REDIS_URL",
      "STOREFRONT_BASE_DOMAIN",
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
      ...API_ONLY,
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
    const error = configErrorOf(() => loadApiConfig(SHARED));
    const worker = loadWorkerConfig({ ...WORKER_ENV, ...API_ONLY });

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      "API_KEY_PEPPER_FILE",
      "MASTER_KEY_CURRENT",
      "MASTER_KEY_DIR",
      "PUBLIC_OTA_API_URL",
      "STOREFRONT_BASE_DOMAIN",
      "VELEXIS_EDGE_SECRET",
    ]);
    for (const name of Object.keys(API_ONLY)) {
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
  it("require a key folder that exists and a current KEK id local:v<N>; the worker reads neither", () => {
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

      expect([value, error.problems.map((problem) => problem.variable)]).toEqual([value, [name]]);
    }
    const worker = loadWorkerConfig({ ...WORKER_ENV, ...API_ONLY });
    expect(worker).not.toHaveProperty("MASTER_KEY_DIR");
    expect(worker).not.toHaveProperty("MASTER_KEY_CURRENT");
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

      // The key folder of `pnpm dev:keys` (MASTER_KEY_DIR, the pepper's folder) is the scratch root's too.
      const api = loadApiConfig({
        ...local,
        API_KEY_PEPPER_FILE: pepperFile,
        MASTER_KEY_DIR: join(root, local["MASTER_KEY_DIR"] ?? "missing"),
      });
      const worker = loadWorkerConfig(local);

      expect(local["API_KEY_PEPPER_FILE"]).toBe(".local/keys/api-key-pepper");
      expect(local["MASTER_KEY_DIR"]).toBe(".local/keys");
      expect(api.MASTER_KEY_DIR).toBe(dirname(pepperFile));
      expect(api.AMADEUS_BASE_URL_TEST).toBe("http://127.0.0.1:4900");
      expect(api.APP_ENV).toBe("development");
      expect(api.DATABASE_URL).toContain("velexis_ota_app");
      expect(api.PORT).toBe(4000);
      expect(api.STOREFRONT_BASE_DOMAIN).toBe("ota.example.com");
      expect(worker.HEALTH_PORT).toBe(4001);
      expect(worker.DATABASE_PROVISIONER_URL).toContain("velexis_provisioner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches deploy/env: every variable of both schemas is in the unit's env files, except the ports", () => {
    const shared = renderedTemplate("ota-backend.env.example");
    const worker = renderedTemplate("ota-worker.env.example");

    // The pepper of the OTA zone's key folder on the VM (ADR-0026); the test process's own file stands in for it.
    expect(shared["API_KEY_PEPPER_FILE"]).toBe(`${shared["MASTER_KEY_DIR"] ?? "missing"}/api-key-pepper`);
    // The OTA zone's key folder does not exist here either: the test process's own folder stands in for it.
    const api = loadApiConfig({
      ...shared,
      API_KEY_PEPPER_FILE: testApiCredentials().pepperFile,
      MASTER_KEY_DIR: testApiCredentials().masterKeyDir,
    });
    expect(api.APP_ENV).toBe("production");
    // Empty in the template: the connection's or the shared account's base_url is used on the VM.
    expect([api.AMADEUS_BASE_URL_TEST, api.AMADEUS_BASE_URL_LIVE]).toEqual([undefined, undefined]);
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
