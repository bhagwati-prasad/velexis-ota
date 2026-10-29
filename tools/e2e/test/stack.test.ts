import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@velexis/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ADMIN_SUSPENSION_STOREFRONT_HOST,
  ADMIN_SUSPENSION_STOREFRONT_URL,
  ADMIN_SUSPENSION_TENANT_KEY,
  assertBuilt,
  assertPortsFree,
  childEnv,
  DEMO_STOREFRONT_HOST,
  exampleEnv,
  newDatabaseName,
  nextAppsOf,
  OTA_ADMIN_URL,
  OTA_API_URL,
  otaStripeKeys,
  PLATFORM_ADMIN_URL,
  PLATFORM_API_URL,
  PORTAL_URL,
  readStackSettings,
  runningStackContext,
  runSeed,
  seedCommands,
  serviceEnv,
  stackContext,
  stackServices,
  STACK_PORTS,
  STOREFRONT_URL,
  SUSPENDED_STOREFRONT_HOST,
  SUSPENDED_STOREFRONT_URL,
  SUSPENDED_TENANT_KEY,
  type SeedCommand,
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
  "ota-api",
  "ota-cli",
  "ota-admin",
  "storefront",
  "suspended-storefront",
  "admin-suspension-storefront",
];

/** The processes and commands that get no DSN at all: the Next.js apps, the stub and the storefront previews. */
const WITHOUT_DSN = [
  "portal",
  "platform-admin",
  "ota-admin",
  "amadeus-stub",
  "storefront",
  "suspended-storefront",
  "admin-suspension-storefront",
] as const;

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

describe("the OTA's Stripe test keys (OFE-017)", () => {
  // Built at run time, so that no secret scanner takes these test values for leaked keys.
  const SECRET_KEY = ["sk", "test", "ofe017"].join("_");
  const PUBLISHABLE_KEY = ["pk", "test", "ofe017"].join("_");
  const PLATFORM = {
    E2E_STRIPE: "1",
    STRIPE_SECRET_KEY: "sk_test_abc",
    STRIPE_BILLING_WEBHOOK_SECRET: "whsec_abc",
  } as const;

  it("with E2E_STRIPE=1 takes both keys or neither, in test mode only, and refuses live keys [OFE-017 AC1]", () => {
    expect(otaStripeKeys(settings({ ...PLATFORM, E2E_WITH_OTA: "1" }))).toBeUndefined();
    expect(() => settings({ ...PLATFORM, STRIPE_SECRET_KEY_TEST: SECRET_KEY })).toThrow(
      /needs both, in test mode .*: STRIPE_PUBLISHABLE_KEY_TEST\./,
    );
    expect(() => settings({ ...PLATFORM, STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY })).toThrow(
      /: STRIPE_SECRET_KEY_TEST\./,
    );
    const liveSecret = ["sk", "live", "ofe017"].join("_");
    const livePublishable = ["pk", "live", "ofe017"].join("_");
    let message = "";
    try {
      settings({
        ...PLATFORM,
        STRIPE_SECRET_KEY_TEST: liveSecret,
        STRIPE_PUBLISHABLE_KEY_TEST: livePublishable,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/STRIPE_SECRET_KEY_TEST, STRIPE_PUBLISHABLE_KEY_TEST\. Live keys are never used/);
    expect(message).not.toContain(liveSecret);
    // A restricted test key is a test key too (the OTA backend's own pattern).
    const restricted = ["rk", "test", "ofe017"].join("_");
    expect(
      settings({
        ...PLATFORM,
        STRIPE_SECRET_KEY_TEST: restricted,
        STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
      }).STRIPE_SECRET_KEY_TEST,
    ).toBe(restricted);
  });

  it("turns Stripe on for the OTA only with E2E_STRIPE=1, E2E_WITH_OTA=1 and both keys [OFE-017 AC1]", () => {
    const keys = { STRIPE_SECRET_KEY_TEST: SECRET_KEY, STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY };
    expect(otaStripeKeys(settings({ ...PLATFORM, ...keys, E2E_WITH_OTA: "1" }))).toEqual({
      secretKey: SECRET_KEY,
      publishableKey: PUBLISHABLE_KEY,
    });
    expect(otaStripeKeys(settings({ ...PLATFORM, ...keys }))).toBeUndefined();
    // Without E2E_STRIPE the keys are not even read: the stack keeps the dummies.
    expect(otaStripeKeys(settings({ ...keys, E2E_WITH_OTA: "1" }))).toBeUndefined();
    expect(settings().E2E_STRIPE_CLI).toBe("stripe");
    expect(settings({ E2E_STRIPE_CLI: "/opt/stripe/stripe" }).E2E_STRIPE_CLI).toBe("/opt/stripe/stripe");
  });

  it("gives the keys to the OTA API and worker, and the forwarder's signing secret to the API alone [OFE-017 AC1]", () => {
    const webhookSecret = ["whsec", "ofe017forwarder"].join("_");
    const stripe = stackContext(
      settings({
        ...PLATFORM,
        E2E_WITH_OTA: "1",
        STRIPE_SECRET_KEY_TEST: SECRET_KEY,
        STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
      }),
      DATABASE,
      { webhookSecret },
    );
    expect(stripe.stripeWebhookSecret).toBe(webhookSecret);
    expect(serviceEnv("ota-api", stripe)).toMatchObject({
      STRIPE_SECRET_KEY_TEST: SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
      STRIPE_WEBHOOK_SECRET_VELEXIS_TEST: webhookSecret,
    });
    const worker = serviceEnv("ota-worker", stripe);
    expect(worker).toMatchObject({
      STRIPE_SECRET_KEY_TEST: SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
    });
    expect(worker["STRIPE_WEBHOOK_SECRET_VELEXIS_TEST"]).not.toBe(webhookSecret);
    for (const name of ALL_SERVICES.filter((service) => service !== "ota-api" && service !== "ota-worker")) {
      const values = serviceEnv(name, stripe);
      expect(values["STRIPE_SECRET_KEY_TEST"]).not.toBe(SECRET_KEY);
      expect(values["STRIPE_WEBHOOK_SECRET_VELEXIS_TEST"]).not.toBe(webhookSecret);
    }
  });

  it("takes the .env.example dummies for no keys: a .env.local copied from it turns nothing on [OFE-017 AC1]", () => {
    // docs/mvp/local-development.md §2 copies .env.example to .env.local, which the harness reads: its dummies must
    // not start a forwarder that Stripe refuses, which would fail every project of the run (portal-stripe too).
    const dummies = exampleEnv([".env.example", "ota/backend/.env.example"]);
    const dummySecret = dummies["STRIPE_SECRET_KEY_TEST"] ?? "";
    const dummyPublishable = dummies["STRIPE_PUBLISHABLE_KEY_TEST"] ?? "";
    expect(dummySecret).toMatch(/^sk_test_/);
    expect(dummyPublishable).toMatch(/^pk_test_/);
    const withDummies = settings({
      ...PLATFORM,
      E2E_WITH_OTA: "1",
      STRIPE_SECRET_KEY_TEST: dummySecret,
      STRIPE_PUBLISHABLE_KEY_TEST: dummyPublishable,
    });
    expect(otaStripeKeys(withDummies)).toBeUndefined();
    expect(serviceEnv("ota-api", stackContext(withDummies, DATABASE))["STRIPE_SECRET_KEY_TEST"]).toBe(
      dummySecret,
    );
    // A real key next to a dummy is one key: both are needed.
    expect(() =>
      settings({
        ...PLATFORM,
        E2E_WITH_OTA: "1",
        STRIPE_SECRET_KEY_TEST: SECRET_KEY,
        STRIPE_PUBLISHABLE_KEY_TEST: dummyPublishable,
      }),
    ).toThrow(/needs both, in test mode .*: STRIPE_PUBLISHABLE_KEY_TEST\./);
  });

  it("keeps the .env.example dummies of the OTA processes without the keys", () => {
    const dummies = exampleEnv([".env.example", "ota/backend/.env.example"]);
    const context = stackContext(settings({ E2E_WITH_OTA: "1" }), DATABASE);
    expect(context.stripeWebhookSecret).toBeUndefined();
    for (const name of ["ota-api", "ota-worker"] as const) {
      for (const variable of [
        "STRIPE_SECRET_KEY_TEST",
        "STRIPE_PUBLISHABLE_KEY_TEST",
        "STRIPE_WEBHOOK_SECRET_VELEXIS_TEST",
      ]) {
        expect(serviceEnv(name, context)[variable]).toBe(dummies[variable]);
      }
    }
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
    expect(serviceEnv("ota-api", context)["DATABASE_URL"]).toBe(dsn("velexis_ota_app", "dev_ota"));
    expect(serviceEnv("ota-cli", context)).toMatchObject({
      DATABASE_URL: dsn("velexis_ota_app", "dev_ota"),
      DATABASE_PROVISIONER_URL: dsn("velexis_provisioner", "dev_provisioner"),
    });
  });

  it("never gives the migrator's or the test admin's DSN, and no DSN at all to the Next.js apps, the stub and the previews", () => {
    for (const name of ALL_SERVICES) {
      const values = serviceEnv(name, context);
      expect(values["TEST_DATABASE_ADMIN_URL"]).toBeUndefined();
      if (name !== "ota-cli") {
        expect(values["DATABASE_MIGRATOR_URL"]).toBeUndefined();
      }
      if (name !== "ota-worker" && name !== "ota-cli") {
        expect(values["DATABASE_PROVISIONER_URL"]).toBeUndefined();
      }
    }
    for (const name of WITHOUT_DSN) {
      expect(serviceEnv(name, context)["DATABASE_URL"]).toBeUndefined();
    }
  });

  it("gives the migrator's DSN of the stack database to the OTA backend's dev:seed only, a command and no app [OFE-008 AC1]", () => {
    expect(serviceEnv("ota-cli", context)["DATABASE_MIGRATOR_URL"]).toBe(
      dsn("velexis_migrator", "dev_migrator"),
    );
    expect(serviceEnv("ota-api", context)["DATABASE_MIGRATOR_URL"]).toBeUndefined();
  });

  it("points each storefront preview at the OTA API with its own host and port, and the API's edge secret [OFE-008 AC1]", () => {
    const api = serviceEnv("ota-api", context);
    expect(serviceEnv("storefront", context)).toMatchObject({
      OTA_API_URL,
      STOREFRONT_PREVIEW_PORT: "4173",
      STOREFRONT_DEV_HOST: DEMO_STOREFRONT_HOST,
      VELEXIS_EDGE_SECRET: api["VELEXIS_EDGE_SECRET"],
    });
    expect(serviceEnv("suspended-storefront", context)).toMatchObject({
      OTA_API_URL,
      STOREFRONT_PREVIEW_PORT: "4174",
      STOREFRONT_DEV_HOST: SUSPENDED_STOREFRONT_HOST,
      VELEXIS_EDGE_SECRET: api["VELEXIS_EDGE_SECRET"],
    });
    expect(DEMO_STOREFRONT_HOST).toBe("demo.ota.example.com");
    expect(SUSPENDED_STOREFRONT_HOST).toBe("suspended.ota.example.com");
    // The seed, the API and the previews agree on the base domain of the storefront hosts.
    for (const name of [
      "ota-api",
      "ota-cli",
      "storefront",
      "suspended-storefront",
      "admin-suspension-storefront",
    ] as const) {
      expect(serviceEnv(name, context)["STOREFRONT_BASE_DOMAIN"]).toBe("ota.example.com");
    }
    expect(api).toMatchObject({ PORT: "4000" });
  });

  it("serves the storefront of the OTA the platform admin suspends on a third preview, with its own host [PAD-011 AC1]", () => {
    // specs/admin-suspension-storefront.e2e.ts creates this OTA through the portal API; the preview is there before it.
    expect(serviceEnv("admin-suspension-storefront", context)).toMatchObject({
      OTA_API_URL,
      STOREFRONT_PREVIEW_PORT: "4175",
      STOREFRONT_DEV_HOST: ADMIN_SUSPENSION_STOREFRONT_HOST,
      VELEXIS_EDGE_SECRET: serviceEnv("ota-api", context)["VELEXIS_EDGE_SECRET"],
    });
    expect(ADMIN_SUSPENSION_STOREFRONT_HOST).toBe("suspension.ota.example.com");
    expect(ADMIN_SUSPENSION_STOREFRONT_URL).toBe("http://127.0.0.1:4175");
    // A key `createTenant` accepts (`TenantKey`: a DNS label of 3 to 30 characters), and not the other preview's.
    expect(ADMIN_SUSPENSION_TENANT_KEY).toMatch(/^[a-z][a-z0-9]{2,29}$/);
    expect(ADMIN_SUSPENSION_TENANT_KEY).not.toBe(SUSPENDED_TENANT_KEY);
  });

  it("runs the OTA admin on 3002 against the OTA API, with the API's service key and the stack's public URLs [OAD-016 AC1]", () => {
    const admin = serviceEnv("ota-admin", context);
    expect(admin).toMatchObject({
      PORT: "3002",
      HOSTNAME: "127.0.0.1",
      OTA_API_URL,
      PUBLIC_OTA_ADMIN_URL: OTA_ADMIN_URL,
      PUBLIC_PORTAL_URL: PORTAL_URL,
      APP_ENV: "test",
    });
    // The development service key of ota/admin/.env.example is the one the OTA API accepts (OADR-0009 rule 1.2).
    expect(admin["OTA_ADMIN_SERVICE_KEY"]).toMatch(/^sk_dev_/);
    expect(admin["OTA_ADMIN_SERVICE_KEY"]).toBe(serviceEnv("ota-api", context)["OTA_ADMIN_SERVICE_KEY"]);
    // The portal hands staff over to this admin, and the platform names its /sso: both get its public URL.
    expect(serviceEnv("portal", context)["PUBLIC_OTA_ADMIN_URL"]).toBe(OTA_ADMIN_URL);
    expect(serviceEnv("platform-api", context)["PUBLIC_OTA_ADMIN_URL"]).toBe(OTA_ADMIN_URL);
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
  it("starts the platform processes, and the OTA ones only with E2E_WITH_OTA=1 [OFE-008 AC1]", () => {
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
      "ota-api",
      "ota-admin",
      "storefront",
      "suspended-storefront",
      "admin-suspension-storefront",
    ]);
    expect(new Set(withOta.map((service) => service.port)).size).toBe(withOta.length);
  });

  it("starts the built OTA admin's standalone server on 3002 with E2E_WITH_OTA=1 only [OAD-016 AC1]", () => {
    const platform = stackServices(stackContext(settings(), DATABASE));
    expect(platform.map((service) => service.name)).not.toContain("ota-admin");
    expect(nextAppsOf(platform)).toEqual(["platform/frontend", "platform/admin"]);
    const withOta = stackServices(stackContext(settings({ E2E_WITH_OTA: "1" }), DATABASE));
    expect(withOta.find((service) => service.name === "ota-admin")).toMatchObject({
      entry: "ota/admin/.next/standalone/ota/admin/server.js",
      argv: ["ota/admin/.next/standalone/ota/admin/server.js"],
      build: "pnpm --filter @velexis/ota-admin build",
      cwd: "ota/admin/.next/standalone/ota/admin",
      port: STACK_PORTS.otaAdmin,
      readyUrl: `${OTA_ADMIN_URL}/health/ready`,
    });
    // Its static assets are copied into the standalone tree, as for the platform's two Next.js apps.
    expect(nextAppsOf(withOta)).toEqual(["platform/frontend", "platform/admin", "ota/admin"]);
  });

  it("waits for /health/ready with 200, for the stub's 404 and for each preview's home page [OFE-008 AC1]", () => {
    const services = stackServices(stackContext(settings({ E2E_WITH_OTA: "1" }), DATABASE));
    const previews: readonly string[] = ["storefront", "suspended-storefront", "admin-suspension-storefront"];
    for (const service of services) {
      expect(service.readyUrl).toBe(
        `http://127.0.0.1:${service.port}${previews.includes(service.name) ? "/" : "/health/ready"}`,
      );
      expect(service.isReady(200)).toBe(service.name !== "amadeus-stub");
      expect(service.isReady(404)).toBe(service.name === "amadeus-stub");
      expect(service.isReady(503)).toBe(false);
    }
    expect(services.find((service) => service.name === "portal")?.port).toBe(STACK_PORTS.portal);
    expect(services.find((service) => service.name === "storefront")?.readyUrl).toBe(`${STOREFRONT_URL}/`);
    expect(services.find((service) => service.name === "suspended-storefront")?.readyUrl).toBe(
      `${SUSPENDED_STOREFRONT_URL}/`,
    );
    expect(services.find((service) => service.name === "admin-suspension-storefront")?.readyUrl).toBe(
      `${ADMIN_SUSPENSION_STOREFRONT_URL}/`,
    );
  });

  it("runs the built apps with node, and `vite preview` of the built storefront on 127.0.0.1 [OFE-008 AC1]", () => {
    const services = stackServices(stackContext(settings({ E2E_WITH_OTA: "1" }), DATABASE));
    for (const service of services) {
      if (
        service.name === "storefront" ||
        service.name === "suspended-storefront" ||
        service.name === "admin-suspension-storefront"
      ) {
        expect(service.argv).toEqual([
          "ota/frontend/node_modules/vite/bin/vite.js",
          "preview",
          "--host",
          "127.0.0.1",
        ]);
        expect(service).toMatchObject({
          entry: "ota/frontend/dist/index.html",
          build: "pnpm --filter @velexis/ota-frontend build",
          cwd: "ota/frontend",
        });
      } else {
        expect(service.argv).toEqual([service.entry]);
      }
    }
    expect(services.find((service) => service.name === "ota-api")).toMatchObject({
      entry: "ota/backend/dist/main.js",
      port: 4000,
    });
  });
});

describe("seedCommands", () => {
  it("runs nothing without E2E_WITH_OTA, else the platform's dev:seed and then the OTA backend's [OFE-008 AC1]", () => {
    expect(seedCommands(stackContext(settings(), DATABASE))).toEqual([]);
    const context = stackContext(settings({ E2E_WITH_OTA: "1" }), DATABASE);
    const seeds = seedCommands(context);
    expect(seeds.map((seed) => [seed.name, seed.argv])).toEqual([
      ["platform-dev-seed", ["platform/backend/dist/cli.js", "dev:seed"]],
      ["ota-dev-seed", ["ota/backend/dist/cli.js", "dev:seed"]],
    ]);
    expect(seeds[0]?.env).toEqual(serviceEnv("platform-cli", context));
    expect(seeds[1]?.env).toEqual(serviceEnv("ota-cli", context));
    expect(seeds.map((seed) => seed.entry)).toEqual([
      "platform/backend/dist/cli.js",
      "ota/backend/dist/cli.js",
    ]);
  });
});

describe("runSeed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ofe-008-seed-"));

  /** A stand-in seed that prints a secret on stdout and a problem on stderr, then exits with `code`. */
  const fakeSeed = (code: number): SeedCommand => {
    const script = join(dir, `seed-${code}.js`);
    writeFileSync(
      script,
      'process.stdout.write("Password: e2e-secret-shown-once\\n");\n' +
        'process.stderr.write("dev:seed: the stub is not running\\n");\n' +
        `process.exitCode = ${code};\n`,
    );
    return { name: "ota-dev-seed", entry: script, build: "none", argv: [script], cwd: ".", env: {} };
  };

  /** The log of the seed that succeeded, and what the failing one rejected with. */
  let succeededLog = "";
  let failure: unknown;

  // Spawning the two stand-in seeds (a node process each, about 50 ms idle) happens here, not in the tests' 5 s
  // budget: 20 s for both on a loaded machine.
  beforeAll(async () => {
    await runSeed(fakeSeed(0), dir);
    succeededLog = readFileSync(join(dir, "ota-dev-seed.log"), "utf8");
    try {
      await runSeed(fakeSeed(1), dir);
    } catch (caught) {
      failure = caught;
    }
  }, 20_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("discards what a seed prints on stdout and logs its stderr [OFE-008 AC1]", () => {
    expect(succeededLog).toBe("dev:seed: the stub is not running\n");
    expect(succeededLog).not.toContain("e2e-secret-shown-once");
  });

  it("fails with the seed's stderr, never its stdout, when it exits with an error [OFE-008 AC1]", () => {
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/exited with code 1[\s\S]*dev:seed: the stub is not running/);
    expect(String(failure)).not.toContain("e2e-secret-shown-once");
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
