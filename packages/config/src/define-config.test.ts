import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ESLint } from "eslint";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { findWorkspaceRoot } from "./define-config";
import { ConfigError, defineConfig, env, type ConfigOf } from "./index";

/** Runs `fn` and returns the ConfigError it throws; fails the test if it throws nothing or something else. */
function configErrorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConfigError");
}

/** Every text a ConfigError exposes, for "never the value" assertions. */
function everythingIn(error: ConfigError): string {
  return [error.message, String(error), error.stack ?? "", JSON.stringify(error.problems)].join("\n");
}

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "velexis-config-define-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("defineConfig", () => {
  it("throws a single ConfigError that names all three invalid variables and none of their values [X-002 AC1]", () => {
    const values = {
      DATABASE_URL: "mysql://velexis:Hunter2-db-secret@db.example.net:3306/velexis",
      PORT: "98765",
      APP_ENV: "staging-q7Zx",
    };
    const schema = {
      APP_ENV: env.enum(["development", "test", "production"]),
      LOG_LEVEL: env.enum(["debug", "info", "warn", "error"], { default: "info" }),
      PORT: env.port({ default: 3100 }),
      DATABASE_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
    };
    let thrown = 0;
    let error: ConfigError | undefined;
    try {
      defineConfig(schema, { ...values, LOG_LEVEL: "info" });
    } catch (caught) {
      thrown += 1;
      error = caught as ConfigError;
    }

    expect(thrown).toBe(1);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.name).toBe("ConfigError");
    expect(error?.problems.map((p) => p.variable)).toEqual(["APP_ENV", "PORT", "DATABASE_URL"]);
    for (const name of Object.keys(values)) {
      expect(error?.message).toContain(name);
    }
    const exposed = everythingIn(error as ConfigError);
    for (const value of [...Object.values(values), "Hunter2-db-secret", "db.example.net", "98765", "q7Zx"]) {
      expect(exposed).not.toContain(value);
    }
    expect(error?.stack?.startsWith("ConfigError: Invalid configuration (3 problems):")).toBe(true);
  });

  it("names a missing required variable", () => {
    const error = configErrorOf(() => defineConfig({ DATABASE_URL: env.url() }, {}));
    expect(error.problems).toEqual([{ variable: "DATABASE_URL", reason: "is required but missing" }]);
    expect(error.message).toContain("DATABASE_URL is required but missing");
  });

  it("treats an empty value as unset", () => {
    const config = defineConfig(
      {
        SENTRY_DSN: env.url({ optional: true }),
        LOG_LEVEL: env.enum(["debug", "info"], { default: "info" }),
      },
      { SENTRY_DSN: "", LOG_LEVEL: "" },
    );
    expect(config).toEqual({ SENTRY_DSN: undefined, LOG_LEVEL: "info" });

    const error = configErrorOf(() => defineConfig({ DATABASE_URL: env.url() }, { DATABASE_URL: "" }));
    expect(error.problems[0]?.reason).toBe("is required but missing");
  });

  it("returns a deep-frozen object with only the schema's variables", () => {
    const config = defineConfig(
      {
        PORT: env.port({ default: 3100 }),
        ORIGINS: env.list(),
        AIRLINE_CARD_ENABLED: env.bool({ default: false }),
      },
      { ORIGINS: "https://platform.example.com, https://admin.platform.example.com", UNRELATED: "ignored" },
    );
    expect(config).toEqual({
      PORT: 3100,
      ORIGINS: ["https://platform.example.com", "https://admin.platform.example.com"],
      AIRLINE_CARD_ENABLED: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.ORIGINS)).toBe(true);
    expect(Reflect.set(config, "PORT", 1)).toBe(false);
    expect(Reflect.set(config.ORIGINS, 0, "https://evil.example.net")).toBe(false);
    expect(config).not.toHaveProperty("UNRELATED");
  });

  it("reads process.env when no source is given", () => {
    vi.stubEnv("VELEXIS_X002_PROBE_PORT", "4321");
    const config = defineConfig({ VELEXIS_X002_PROBE_PORT: env.port() });
    expect(config.VELEXIS_X002_PROBE_PORT).toBe(4321);
  });

  it("reports an unexpected parser error without its message", () => {
    const schema = {
      BROKEN: {
        kind: "custom",
        optional: false,
        parse: () => {
          throw new RangeError("value 'Hunter2' is bad");
        },
      },
    };
    const error = configErrorOf(() => defineConfig(schema, { BROKEN: "Hunter2" }));
    expect(error.problems).toEqual([{ variable: "BROKEN", reason: "could not be validated (RangeError)" }]);
    expect(everythingIn(error)).not.toContain("Hunter2");
  });

  it("infers string | undefined for an optional string, number for an int with a default, and the literal union for an enum [X-002 AC2]", () => {
    const schema = {
      APP_ENV: env.enum(["development", "test", "production"]),
      LOG_LEVEL: env.enum(["debug", "info", "warn", "error"] as const, { default: "info" }),
      SENTRY_DSN: env.string({ optional: true }),
      MASTER_KEY_CURRENT: env.string({ pattern: /^local:v\d+$/ }),
      DB_POOL_MAX: env.int({ min: 1, max: 100, default: 20 }),
      PORT: env.port({ default: 3100 }),
      HEALTH_PORT: env.port({ optional: true }),
      AIRLINE_CARD_ENABLED: env.bool({ default: false }),
      DATABASE_URL: env.url({ protocols: ["postgres:"] }),
      API_KEY_PEPPER_FILE: env.secretFile({ minBytes: 32 }),
      JWT_PRIVATE_KEY_FILE: env.secretFile({ minBytes: 32, encoding: "pem", optional: true }),
      MASTER_KEY_DIR: env.dir(),
      CORS_ORIGINS: env.list({ default: [] }),
    };
    const keyDir = join(tmp, "typed-keys");
    mkdirSync(keyDir);
    const pepper = join(keyDir, "api-key-pepper");
    writeFileSync(pepper, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    chmodSync(pepper, 0o600);
    const config = defineConfig(schema, {
      APP_ENV: "test",
      MASTER_KEY_CURRENT: "local:v1",
      DATABASE_URL: "postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis",
      API_KEY_PEPPER_FILE: pepper,
      MASTER_KEY_DIR: keyDir,
    });
    type Config = ConfigOf<typeof schema>;

    expectTypeOf(config.SENTRY_DSN).toEqualTypeOf<string | undefined>();
    expectTypeOf(config.DB_POOL_MAX).toEqualTypeOf<number>();
    expectTypeOf(config.APP_ENV).toEqualTypeOf<"development" | "test" | "production">();
    expectTypeOf(config.LOG_LEVEL).toEqualTypeOf<"debug" | "info" | "warn" | "error">();
    expectTypeOf(config.MASTER_KEY_CURRENT).toEqualTypeOf<string>();
    expectTypeOf(config.PORT).toEqualTypeOf<number>();
    expectTypeOf(config.HEALTH_PORT).toEqualTypeOf<number | undefined>();
    expectTypeOf(config.AIRLINE_CARD_ENABLED).toEqualTypeOf<boolean>();
    expectTypeOf(config.DATABASE_URL).toEqualTypeOf<string>();
    expectTypeOf(config.API_KEY_PEPPER_FILE).toEqualTypeOf<string>();
    expectTypeOf(config.JWT_PRIVATE_KEY_FILE).toEqualTypeOf<string | undefined>();
    expectTypeOf(config.MASTER_KEY_DIR).toEqualTypeOf<string>();
    expectTypeOf(config.CORS_ORIGINS).toEqualTypeOf<readonly string[]>();
    expectTypeOf(config).toEqualTypeOf<Config>();
    expectTypeOf(config).toMatchTypeOf<{ readonly PORT: number }>();

    // The runtime values agree with the types.
    expect(config).toEqual({
      APP_ENV: "test",
      LOG_LEVEL: "info",
      SENTRY_DSN: undefined,
      MASTER_KEY_CURRENT: "local:v1",
      DB_POOL_MAX: 20,
      PORT: 3100,
      HEALTH_PORT: undefined,
      AIRLINE_CARD_ENABLED: false,
      DATABASE_URL: "postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis",
      API_KEY_PEPPER_FILE: pepper,
      JWT_PRIVATE_KEY_FILE: undefined,
      MASTER_KEY_DIR: keyDir,
      CORS_ORIGINS: [],
    });

    // Misuse does not compile. The type checker checks this function; it is never called.
    const misuse = () => [
      // @ts-expect-error a default and optional together
      env.string({ optional: true, default: "x" }),
      // @ts-expect-error an enum default that is not one of the values
      env.enum(["debug", "info"], { default: "verbose" }),
      // @ts-expect-error a default for a secret file (conventions §8)
      env.secretFile({ minBytes: 32, default: "/etc/velexis/keys/api-key-pepper" }),
      // @ts-expect-error an int default that is not a number
      env.int({ default: "20" }),
    ];
    expectTypeOf(misuse).toBeFunction();
  });

  it("infers T | undefined when optional is a boolean that is not a literal", () => {
    // A switch computed at run time: the type checker only knows `boolean`, and here it is true.
    const optional: boolean = [true].includes(true);
    const schema = {
      NAME: env.string({ optional }),
      PORT: env.port({ optional }),
      PEPPER_FILE: env.secretFile({ minBytes: 32, optional }),
      REQUIRED: env.string({ optional: false }),
    };
    const config = defineConfig(schema, { REQUIRED: "set" });

    expectTypeOf(config.NAME).toEqualTypeOf<string | undefined>();
    expectTypeOf(config.PORT).toEqualTypeOf<number | undefined>();
    expectTypeOf(config.PEPPER_FILE).toEqualTypeOf<string | undefined>();
    expectTypeOf(config.REQUIRED).toEqualTypeOf<string>();
    expect(config).toEqual({ NAME: undefined, PORT: undefined, PEPPER_FILE: undefined, REQUIRED: "set" });
  });
});

describe("env builders", () => {
  it("string: checks the whole pattern and ignores the g flag", () => {
    const schema = { MASTER_KEY_CURRENT: env.string({ pattern: /^local:v\d+$/g }) };
    expect(defineConfig(schema, { MASTER_KEY_CURRENT: "local:v1" }).MASTER_KEY_CURRENT).toBe("local:v1");
    expect(defineConfig(schema, { MASTER_KEY_CURRENT: "local:v2" }).MASTER_KEY_CURRENT).toBe("local:v2");
    const error = configErrorOf(() => defineConfig(schema, { MASTER_KEY_CURRENT: "kms:secret-arn" }));
    expect(error.problems[0]?.reason).toBe("does not match /^local:v\\d+$/");
    expect(everythingIn(error)).not.toContain("secret-arn");
  });

  it("int: accepts only decimal integers inside the range", () => {
    const schema = { N: env.int({ min: -5, max: 50 }) };
    expect(defineConfig(schema, { N: "-5" }).N).toBe(-5);
    expect(defineConfig(schema, { N: "+50" }).N).toBe(50);
    for (const raw of ["3.5", "12abc", " 12", "1e3", "0x10", "51", "-6", "99999999999999999999"]) {
      const error = configErrorOf(() => defineConfig(schema, { N: raw }));
      expect(error.problems[0]?.reason).toBe("must be an integer between -5 and 50");
    }
    expect(configErrorOf(() => defineConfig({ N: env.int({ min: 1 }) }, { N: "0" })).message).toContain(
      "N must be an integer of at least 1",
    );
    expect(configErrorOf(() => defineConfig({ N: env.int({ max: 9 }) }, { N: "10" })).message).toContain(
      "N must be an integer of at most 9",
    );
    expect(configErrorOf(() => defineConfig({ N: env.int() }, { N: "x" })).message).toContain(
      "N must be an integer",
    );
  });

  it("port: accepts 1 to 65535", () => {
    const schema = { PORT: env.port() };
    expect(defineConfig(schema, { PORT: "1" }).PORT).toBe(1);
    expect(defineConfig(schema, { PORT: "65535" }).PORT).toBe(65535);
    for (const raw of ["0", "65536", "http", "-1"]) {
      expect(configErrorOf(() => defineConfig(schema, { PORT: raw })).problems[0]?.reason).toBe(
        "must be a port number between 1 and 65535",
      );
    }
  });

  it("bool: accepts only true, false, 1 and 0", () => {
    const schema = { FLAG: env.bool() };
    expect(defineConfig(schema, { FLAG: "true" }).FLAG).toBe(true);
    expect(defineConfig(schema, { FLAG: "1" }).FLAG).toBe(true);
    expect(defineConfig(schema, { FLAG: "false" }).FLAG).toBe(false);
    expect(defineConfig(schema, { FLAG: "0" }).FLAG).toBe(false);
    for (const raw of ["TRUE", "yes", "on", "no", "2", " true"]) {
      expect(configErrorOf(() => defineConfig(schema, { FLAG: raw })).problems[0]?.reason).toBe(
        "must be one of true, false, 1, 0",
      );
    }
  });

  it("url: requires an absolute URL with an allowed protocol and returns it as written", () => {
    const schema = { REDIS_URL: env.url({ protocols: ["redis", "rediss:"] }) };
    const value = "redis://:dev_redis@127.0.0.1:6379/0";
    expect(defineConfig(schema, { REDIS_URL: value }).REDIS_URL).toBe(value);
    expect(configErrorOf(() => defineConfig(schema, { REDIS_URL: "not a url" })).problems[0]?.reason).toBe(
      "must be an absolute URL",
    );
    const error = configErrorOf(() => defineConfig(schema, { REDIS_URL: "http://user:pw-77@cache.test" }));
    expect(error.problems[0]?.reason).toBe("must use one of the protocols redis:, rediss:");
    expect(everythingIn(error)).not.toContain("pw-77");
    expect(defineConfig({ U: env.url() }, { U: "https://api.ota.example.com" }).U).toBe(
      "https://api.ota.example.com",
    );
  });

  it("enum: accepts only the listed values", () => {
    const schema = { APP_ENV: env.enum(["development", "test", "production"]) };
    expect(defineConfig(schema, { APP_ENV: "test" }).APP_ENV).toBe("test");
    expect(configErrorOf(() => defineConfig(schema, { APP_ENV: "Production" })).problems[0]?.reason).toBe(
      "must be one of development, test, production",
    );
  });

  it("list: splits, trims and drops empty items, with an optional item pattern", () => {
    expect(defineConfig({ L: env.list() }, { L: " a, b ,,c " }).L).toEqual(["a", "b", "c"]);
    expect(defineConfig({ L: env.list({ separator: ";" }) }, { L: "a,b;c" }).L).toEqual(["a,b", "c"]);
    expect(configErrorOf(() => defineConfig({ L: env.list() }, { L: " , " })).problems[0]?.reason).toBe(
      "must contain at least one item",
    );
    const schema = { HOSTS: env.list({ pattern: /^[a-z.]+$/ }) };
    expect(configErrorOf(() => defineConfig(schema, { HOSTS: "a.test,B-secret" })).problems[0]?.reason).toBe(
      "has an item (number 2) that does not match /^[a-z.]+$/",
    );
  });

  it("dir: requires an existing directory and returns its absolute path", () => {
    const keys = join(tmp, "keys");
    mkdirSync(keys);
    writeFileSync(join(tmp, "a-file"), "x");
    const schema = { MASTER_KEY_DIR: env.dir() };

    expect(defineConfig(schema, { MASTER_KEY_DIR: keys }).MASTER_KEY_DIR).toBe(keys);
    expect(defineConfig(schema, { MASTER_KEY_DIR: "keys" }, { baseDir: tmp }).MASTER_KEY_DIR).toBe(keys);
    expect(defineConfig(schema, { MASTER_KEY_DIR: `${keys}/../keys/` }).MASTER_KEY_DIR).toBe(keys);
    expect(
      configErrorOf(() => defineConfig(schema, { MASTER_KEY_DIR: join(tmp, "nope") })).problems[0]?.reason,
    ).toBe("must name an existing directory");
    expect(
      configErrorOf(() => defineConfig(schema, { MASTER_KEY_DIR: join(tmp, "a-file") })).problems[0]?.reason,
    ).toBe("must name a directory, not a file");

    // A default directory is checked when the configuration is loaded.
    expect(defineConfig({ D: env.dir({ default: "keys" }) }, {}, { baseDir: tmp }).D).toBe(keys);
    expect(
      configErrorOf(() => defineConfig({ D: env.dir({ default: "missing" }) }, {}, { baseDir: tmp }))
        .problems,
    ).toEqual([{ variable: "D", reason: "must name an existing directory" }]);
  });

  it("resolves relative paths against the workspace root by default", () => {
    const root = findWorkspaceRoot(__dirname);
    expect(root).toBeDefined();
    expect(readdirSync(root as string)).toContain("pnpm-workspace.yaml");
    const config = defineConfig({ SRC: env.dir() }, { SRC: "packages/config/src" });
    expect(config.SRC).toBe(join(root as string, "packages", "config", "src"));
  });

  it("refuses a default that breaks the builder's own rule when the schema is declared", () => {
    expect(() => env.port({ default: 70000 })).toThrow(TypeError);
    expect(() => env.int({ min: 1, default: 0 })).toThrow(
      "env.int(): the default is not an integer of at least 1",
    );
    expect(() => env.string({ pattern: /^local:v\d+$/, default: "v1" })).toThrow(TypeError);
    expect(() => env.url({ protocols: ["postgres:"], default: "redis://127.0.0.1" })).toThrow(TypeError);
    expect(() => env.list({ pattern: /^[a-z]+$/, default: ["ok", "NOT"] })).toThrow(TypeError);
    expect(() => env.int({ min: 5, max: 1 })).toThrow(TypeError);
    expect(() => env.url({ protocols: [] })).toThrow(TypeError);
    expect(() => env.list({ separator: "" })).toThrow(TypeError);
    expect(() => env.secretFile({ minBytes: 0 })).toThrow(TypeError);
  });
});

describe("process.env boundary", () => {
  it("keeps n/no-process-env active in every other package and app, and off only in @velexis/config [X-002 AC5]", async () => {
    const root = findWorkspaceRoot(__dirname) as string;
    const eslint = new ESLint({ cwd: root });
    const severity = async (file: string): Promise<unknown> => {
      const config = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown[]> };
      return config.rules?.["n/no-process-env"]?.[0];
    };

    for (const file of [
      "packages/logger/src/create-logger.ts",
      "packages/crypto/src/envelope.ts",
      "packages/db/src/index.ts",
      "packages/errors/src/index.ts",
      "packages/api-types/src/index.ts",
      "packages/testing/src/index.ts",
      "platform/backend/src/main.ts",
      "platform/frontend/src/lib/config.ts",
      "platform/admin/src/lib/config.ts",
      "ota/backend/src/main.ts",
      "ota/admin/src/lib/config.ts",
    ]) {
      expect({ file, severity: await severity(file) }).toEqual({ file, severity: 2 });
    }
    for (const file of ["packages/config/src/define-config.ts", "packages/config/src/dev-env-files.ts"]) {
      expect({ file, severity: await severity(file) }).toEqual({ file, severity: 0 });
    }
  }, 30_000);

  it("reads process.env in no source file of the package except define-config.ts", () => {
    const sources = readdirSync(__dirname).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    expect(sources).toContain("define-config.ts");
    const readers = sources.filter((file) =>
      readFileSync(join(__dirname, file), "utf8").includes("process.env"),
    );
    expect(readers).toEqual(["define-config.ts"]);
  });
});
