import { createServer, type Server } from "node:net";
import { ConfigError } from "@velexis/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertBuilt,
  assertPortsFree,
  childEnv,
  exampleEnv,
  newDatabaseName,
  PLATFORM_ADMIN_URL,
  PLATFORM_API_URL,
  PORTAL_URL,
  readStackSettings,
  runningStackContext,
  serviceEnv,
  stackContext,
  stackServices,
  STACK_PORTS,
  type ServiceName,
  type ServiceSpec,
  type StackSettings,
} from "../support/stack";

/** The harness settings of the CI job (.github/workflows/e2e.yml). */
const CI_SETTINGS = {
  TEST_DATABASE_ADMIN_URL: "postgres://velexis_test_admin:dev_test_admin@127.0.0.1:5432/postgres",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  SMTP_URL: "smtp://127.0.0.1:1025",
  MAILPIT_API_URL: "http://127.0.0.1:8025",
} as const;

const DATABASE = "velexis_e2e_test_abc123";

function settings(extra: Record<string, string> = {}): StackSettings {
  return readStackSettings({ ...CI_SETTINGS, ...extra });
}

const ALL_SERVICES: readonly ServiceName[] = [
  "platform-api",
  "platform-worker",
  "platform-cli",
  "portal",
  "platform-admin",
  "amadeus-stub",
  "ota-worker",
];

describe("readStackSettings", () => {
  it("defaults to the platform stack without OTA or Stripe, on Redis database 15", () => {
    const values = settings();
    expect(values.E2E_WITH_OTA).toBe(false);
    expect(values.E2E_STRIPE).toBe(false);
    expect(values.E2E_REDIS_DB).toBe(15);
  });

  it("names every missing variable and never a value", () => {
    let error: unknown;
    try {
      readStackSettings({ REDIS_URL: "redis://:secret-password@127.0.0.1:6379/0" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const variable of ["TEST_DATABASE_ADMIN_URL", "SMTP_URL", "MAILPIT_API_URL"]) {
      expect(message).toContain(variable);
    }
    expect(message).not.toContain("secret-password");
  });

  it("refuses Redis database 0, the developer's `pnpm dev`", () => {
    expect(() => settings({ E2E_REDIS_DB: "0" })).toThrow(/E2E_REDIS_DB/);
  });

  it("with E2E_STRIPE=1 needs Stripe test-mode values and refuses a live key", () => {
    expect(() => settings({ E2E_STRIPE: "1" })).toThrow(/STRIPE_SECRET_KEY, STRIPE_BILLING_WEBHOOK_SECRET/);
    // Built at run time, so that no secret scanner takes this test for a leaked live key.
    const liveKey = ["sk", "live", "e2e"].join("_");
    expect(() =>
      settings({ E2E_STRIPE: "1", STRIPE_SECRET_KEY: liveKey, STRIPE_BILLING_WEBHOOK_SECRET: "whsec_abc" }),
    ).toThrow(/STRIPE_SECRET_KEY/);
    expect(
      settings({
        E2E_STRIPE: "1",
        STRIPE_SECRET_KEY: "sk_test_abc",
        STRIPE_BILLING_WEBHOOK_SECRET: "whsec_abc",
      }).E2E_STRIPE,
    ).toBe(true);
  });
});

describe("stackContext", () => {
  it("puts the stack on its own Redis database", () => {
    expect(stackContext(settings(), DATABASE).redisUrl).toBe("redis://127.0.0.1:6379/15");
    expect(stackContext(settings({ E2E_REDIS_DB: "7" }), DATABASE).redisUrl).toBe("redis://127.0.0.1:6379/7");
  });

  it("accepts only database names of this harness", () => {
    expect(newDatabaseName()).toMatch(/^velexis_e2e_[a-z0-9]+_[0-9a-f]{6}$/);
    expect(() => stackContext(settings(), "velexis")).toThrow(/not a database name/);
    expect(() => stackContext(settings(), "velexis_test_tpl_x")).toThrow(/not a database name/);
  });

  it("is what a test worker reads back from E2E_DATABASE_NAME", () => {
    const context = runningStackContext({ ...CI_SETTINGS, E2E_DATABASE_NAME: DATABASE });
    expect(context.databaseName).toBe(DATABASE);
    expect(() => runningStackContext({ ...CI_SETTINGS })).toThrow(/E2E_DATABASE_NAME/);
  });
});

describe("serviceEnv", () => {
  const context = stackContext(settings(), DATABASE);
  const dsn = (user: string, password: string) => `postgres://${user}:${password}@127.0.0.1:5432/${DATABASE}`;

  it("gives each backend process the stack database's DSN of its own role", () => {
    expect(serviceEnv("platform-api", context)["DATABASE_URL"]).toBe(
      dsn("velexis_platform_app", "dev_platform"),
    );
    expect(serviceEnv("platform-worker", context)["DATABASE_URL"]).toBe(
      dsn("velexis_platform_app", "dev_platform"),
    );
    expect(serviceEnv("platform-cli", context)["DATABASE_URL"]).toBe(
      dsn("velexis_platform_app", "dev_platform"),
    );
    const otaWorker = serviceEnv("ota-worker", context);
    expect(otaWorker["DATABASE_URL"]).toBe(dsn("velexis_ota_app", "dev_ota"));
    expect(otaWorker["DATABASE_PROVISIONER_URL"]).toBe(dsn("velexis_provisioner", "dev_provisioner"));
  });

  it("never gives the migrator's or the test admin's DSN, and no DSN at all to the Next.js apps and the stub", () => {
    for (const name of ALL_SERVICES) {
      const values = serviceEnv(name, context);
      expect(values["DATABASE_MIGRATOR_URL"]).toBeUndefined();
      expect(values["TEST_DATABASE_ADMIN_URL"]).toBeUndefined();
      if (name !== "ota-worker") {
        expect(values["DATABASE_PROVISIONER_URL"]).toBeUndefined();
      }
    }
    for (const name of ["portal", "platform-admin", "amadeus-stub"] as const) {
      expect(serviceEnv(name, context)["DATABASE_URL"]).toBeUndefined();
    }
  });

  it("points every process at the stack's Redis database, Mailpit, ports and 127.0.0.1 public URLs", () => {
    for (const name of ALL_SERVICES) {
      const values = serviceEnv(name, context);
      expect(values).toMatchObject({
        APP_ENV: "test",
        REDIS_URL: "redis://127.0.0.1:6379/15",
        SMTP_URL: CI_SETTINGS.SMTP_URL,
        PUBLIC_PORTAL_URL: PORTAL_URL,
        PUBLIC_PLATFORM_ADMIN_URL: PLATFORM_ADMIN_URL,
        PLATFORM_API_URL,
        AMADEUS_BASE_URL_TEST: "http://127.0.0.1:4900",
      });
    }
    expect(serviceEnv("portal", context)).toMatchObject({ PORT: "3000", HOSTNAME: "127.0.0.1" });
    expect(serviceEnv("platform-admin", context)).toMatchObject({ PORT: "3001", HOSTNAME: "127.0.0.1" });
    expect(serviceEnv("platform-api", context)).toMatchObject({ PORT: "3100", HEALTH_PORT: "3101" });
    expect(serviceEnv("ota-worker", context)).toMatchObject({ HEALTH_PORT: "4001" });
    expect(serviceEnv("amadeus-stub", context)).toMatchObject({ STUB_PORT: "4900" });
  });

  it("passes every other value of the app's .env.example files on, the app's own winning over the root's", () => {
    const platform = exampleEnv(["platform/backend/.env.example"]);
    const values = serviceEnv("platform-api", context);
    expect(values["PLATFORM_BFF_KEY"]).toBe(platform["PLATFORM_BFF_KEY"]);
    expect(values["MAIL_FROM"]).toBe(platform["MAIL_FROM"]);
    expect(values["FEATURE_CUSTOM_DOMAINS"]).toBe("false");
    expect(serviceEnv("portal", context)["PLATFORM_BFF_KEY"]).toBe(platform["PLATFORM_BFF_KEY"]);
    expect(serviceEnv("ota-worker", context)["AIRLINE_CARD_ENABLED"]).toBe(
      exampleEnv(["ota/backend/.env.example"])["AIRLINE_CARD_ENABLED"],
    );
  });

  it("keeps the .env.example Stripe dummies unless E2E_STRIPE=1 gives test-mode values", () => {
    const dummy = exampleEnv([".env.example", "platform/backend/.env.example"])["STRIPE_SECRET_KEY"];
    expect(serviceEnv("platform-api", context)["STRIPE_SECRET_KEY"]).toBe(dummy);
    const stripe = stackContext(
      settings({
        E2E_STRIPE: "1",
        STRIPE_SECRET_KEY: "sk_test_e2e",
        STRIPE_BILLING_WEBHOOK_SECRET: "whsec_e2e",
      }),
      DATABASE,
    );
    expect(serviceEnv("platform-api", stripe)).toMatchObject({
      STRIPE_SECRET_KEY: "sk_test_e2e",
      STRIPE_BILLING_WEBHOOK_SECRET: "whsec_e2e",
    });
    expect(serviceEnv("portal", stripe)["STRIPE_SECRET_KEY"]).not.toBe("sk_test_e2e");
  });
});

describe("childEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drops the DSNs of the developer's shell and keeps the rest of it", () => {
    vi.stubEnv("DATABASE_URL", "postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis");
    vi.stubEnv("DATABASE_MIGRATOR_URL", "postgres://velexis_migrator:dev_migrator@127.0.0.1:5432/velexis");
    vi.stubEnv("E2E_TEST_KEEP", "kept");
    const values = childEnv({ PORT: "3000" });
    expect(values["DATABASE_URL"]).toBeUndefined();
    expect(values["DATABASE_MIGRATOR_URL"]).toBeUndefined();
    expect(values["E2E_TEST_KEEP"]).toBe("kept");
    expect(values["PORT"]).toBe("3000");
    expect(childEnv({ DATABASE_URL: "postgres://x@127.0.0.1/velexis_e2e_x" })["DATABASE_URL"]).toBe(
      "postgres://x@127.0.0.1/velexis_e2e_x",
    );
  });
});

describe("stackServices", () => {
  it("starts the platform processes, and the stub and the OTA worker only with E2E_WITH_OTA=1", () => {
    const platform = stackServices(stackContext(settings(), DATABASE)).map((service) => service.name);
    expect(platform).toEqual(["platform-api", "platform-worker", "portal", "platform-admin"]);
    const withOta = stackServices(stackContext(settings({ E2E_WITH_OTA: "1" }), DATABASE));
    expect(withOta.map((service) => service.name)).toEqual([
      "amadeus-stub",
      "platform-api",
      "platform-worker",
      "portal",
      "platform-admin",
      "ota-worker",
    ]);
    expect(new Set(withOta.map((service) => service.port)).size).toBe(withOta.length);
  });

  it("waits for /health/ready with 200, and for the stub's 404", () => {
    const services = stackServices(stackContext(settings({ E2E_WITH_OTA: "1" }), DATABASE));
    for (const service of services) {
      expect(service.readyUrl).toBe(`http://127.0.0.1:${service.port}/health/ready`);
      expect(service.isReady(200)).toBe(service.name !== "amadeus-stub");
      expect(service.isReady(404)).toBe(service.name === "amadeus-stub");
      expect(service.isReady(503)).toBe(false);
    }
    expect(services.find((service) => service.name === "portal")?.port).toBe(STACK_PORTS.portal);
  });
});

describe("assertBuilt", () => {
  it("lists every app that is not built, with the command that builds it", () => {
    const [api] = stackServices(stackContext(settings(), DATABASE));
    const missing: ServiceSpec = {
      ...api!,
      name: "portal",
      entry: "platform/frontend/.next/nothing/server.js",
    };
    expect(() => assertBuilt([missing])).toThrow(
      /portal: platform\/frontend\/\.next\/nothing\/server\.js \(pnpm --filter @velexis\/platform-backend build\)/,
    );
    const present: ServiceSpec = { ...api!, entry: "package.json" };
    expect(() => assertBuilt([present])).not.toThrow();
  });
});

describe("assertPortsFree", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("names the process whose port is in use", async () => {
    server = createServer();
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
    });
    const [api] = stackServices(stackContext(settings(), DATABASE));
    await expect(assertPortsFree([{ ...api!, port }])).rejects.toThrow(
      new RegExp(`port ${port} \\(platform-api\\) is in use`),
    );
  });
});
