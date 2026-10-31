// StorefrontService's cache fill with its platform data (FIX-W38-OTA, lead decision (2g) of 2026-10-31, second batch),
// without PostgreSQL or Redis: a fill reads the tenant's servable custom domains and caches the entry that names them;
// a fill during which a platform invalidation arrived is answered but not cached (or deleted again when its write
// raced the invalidation), so it never puts old hosts back for the entry's 5 minutes; a platform that cannot be read is
// `503 SERVICE_UNAVAILABLE` and caches nothing. End to end, with the `domain` invalidation dropping the entries, in
// test/integration/tenancy/custom-domains.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { redisKeys } from "../common/redis/redis.keys";
import type { ApiConfig } from "../config";
import type { AirlineCardLimits } from "../payments/airline-card/abuse-limits";
import type { PaymentGateway } from "../payments/payment-gateway";
import type { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformReadRepository, PlatformStorefrontDomain } from "../tenancy/platform-read.repository";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTx } from "../tenancy/tenant-tx";
import type { StorefrontRepository, StorefrontSettingsRow } from "./storefront.repository";
import { StorefrontService } from "./storefront.service";

const TENANT_ID = "ten_01M4T9E68084G7ZWYRD6Z1RV0W";
const CREATED = new Date("2026-09-01T08:00:00.000Z");
const CUSTOM_HOST = "book.alpha-travel.example";

const TENANT: RequestTenant = {
  tenantId: TENANT_ID,
  key: "alpha",
  schemaName: "tenant_alpha" as RequestTenant["schemaName"],
  environment: "test",
  caller: { type: "edge", id: "edge" },
  actor: { type: "guest", id: null },
  requestId: "req_01M4T9E68084G7ZWYRD6Z1RV0W",
};

const PLATFORM_TENANT: PlatformTenant = {
  id: TENANT_ID,
  key: "alpha",
  name: "Alpha Travel",
  status: "active",
  schemaName: "tenant_alpha" as PlatformTenant["schemaName"],
  storefrontEnvironment: "test",
  defaultCurrency: "EUR",
  defaultLocale: "en",
  billingNotice: null,
};

/** The settings row a new tenant's provisioning seeds, as far as storefront.get reads it. */
const SETTINGS = {
  brandName: "Alpha Travel",
  legalName: null,
  timeZone: "UTC",
  primaryColor: null,
  secondaryColor: null,
  theme: {},
  defaultLocale: "en",
  supportedLocales: ["en"],
  defaultCurrency: "EUR",
  supportedCurrencies: ["EUR"],
  defaultMarket: null,
  markets: [],
  supportEmail: null,
  supportPhone: null,
  supportDetails: {},
  seo: {},
  consent: {},
  autoIssue: true,
  acceptedCardBrands: ["VISA"],
  require3ds: true,
  guestCheckoutEnabled: true,
  customerAccountsEnabled: true,
  requireEmailVerification: false,
  features: {},
  termsUrl: null,
  privacyUrl: null,
  legalLinks: [],
  termsVersion: null,
  privacyVersion: null,
  airlineCardEnabledTest: false,
  airlineCardEnabledLive: false,
  logoAssetId: null,
  logoDarkAssetId: null,
  logoSquareAssetId: null,
  faviconAssetId: null,
  ogImageAssetId: null,
  version: 1,
  createdAt: CREATED,
  updatedAt: CREATED,
} satisfies StorefrontSettingsRow;

const PRIMARY_CUSTOM: PlatformStorefrontDomain = {
  hostname: CUSTOM_HOST,
  kind: "custom",
  isPrimary: true,
  tlsStatus: "issued",
  verifiedAt: "2026-10-20T08:00:00.000Z",
};

const DEFAULT_ENTRY = redisKeys.sf(TENANT_ID, "test", "und").key;

interface Options {
  /** The platform's storefront domains of the tenant (a rejection: PostgreSQL unreachable). */
  readonly domains?: () => Promise<PlatformStorefrontDomain[]>;
  /** The invalidation generation the platform cache answers on each call, in order (the last one repeats). */
  readonly generations?: readonly number[];
}

function harness(options: Options = {}) {
  const store = new Map<string, string>();
  const redis = {
    status: "ready",
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve("OK");
    }),
    del: vi.fn((...keys: string[]) => Promise.resolve(keys.filter((key) => store.delete(key)).length)),
  };
  const generations = [...(options.generations ?? [0])];
  const platform = {
    tenantById: vi.fn(() => Promise.resolve(PLATFORM_TENANT)),
    invalidationGeneration: vi.fn(() => (generations.length > 1 ? generations.shift() : generations[0]) ?? 0),
  };
  const platformRead = {
    storefrontDomains: vi.fn(options.domains ?? (() => Promise.resolve([PRIMARY_CUSTOM]))),
  };
  const repository = {
    settings: vi.fn(() => Promise.resolve(SETTINGS)),
    assetsByIds: vi.fn(() => Promise.resolve([])),
    currenciesByCodes: vi.fn(() =>
      Promise.resolve([{ code: "EUR", name: "Euro", symbol: "€", minorUnits: 2 }]),
    ),
  };
  const tx = { run: (fn: (trx: unknown) => Promise<unknown>) => fn({}) };
  const tenants = { require: () => TENANT, requestId: () => TENANT.requestId };
  const payments = { findAccount: vi.fn(() => Promise.resolve(null)) };
  const config = {
    get: (name: string) =>
      ({
        STOREFRONT_BASE_DOMAIN: "ota.example.com",
        PUBLIC_OTA_API_URL: "https://api.ota.example.com",
        AIRLINE_CARD_ENABLED: false,
      })[name],
  };
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const service = new StorefrontService(
    tx as unknown as TenantTx,
    tenants as unknown as TenantContext,
    repository as unknown as StorefrontRepository,
    platform as unknown as PlatformCache,
    platformRead as unknown as PlatformReadRepository,
    redis as unknown as Redis,
    payments as unknown as PaymentGateway,
    { suspension: vi.fn(() => Promise.resolve("available")) } as unknown as AirlineCardLimits,
    config as unknown as ConfigService<ApiConfig, true>,
    logger as unknown as PinoLogger,
  );
  return { service, store, redis, platformRead, logger };
}

describe("storefront.get's fill (FIX-W38-OTA)", () => {
  it("[FIX-W38-OTA AC3] reads the tenant's servable custom domains and caches the entry that names the primary one", async () => {
    const { service, store, platformRead } = harness();

    const config = await service.get("edge", undefined);

    expect(platformRead.storefrontDomains).toHaveBeenCalledExactlyOnceWith(TENANT_ID);
    expect([config.primaryUrl, config.seo.canonicalBaseUrl]).toEqual([
      `https://${CUSTOM_HOST}`,
      `https://${CUSTOM_HOST}`,
    ]);
    expect(config.domains.map((domain) => [domain.host, domain.primary])).toEqual([
      ["alpha.ota.example.com", false],
      [CUSTOM_HOST, true],
    ]);
    expect(store.get(DEFAULT_ENTRY)).toContain(`"primaryUrl":"https://${CUSTOM_HOST}"`);
    // The next request answers from the entry, without a platform read.
    await service.get("edge", undefined);
    expect(platformRead.storefrontDomains).toHaveBeenCalledTimes(1);
  });

  it("[FIX-W38-OTA AC3] answers but does not cache a fill during which a platform invalidation arrived", async () => {
    const { service, store, redis } = harness({ generations: [3, 4] });

    const config = await service.get("edge", undefined);

    expect(config.primaryUrl).toBe(`https://${CUSTOM_HOST}`);
    expect(redis.set).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("[FIX-W38-OTA AC3] deletes the entry again when an invalidation arrived while it was written", async () => {
    const { service, store, redis } = harness({ generations: [3, 3, 4] });

    await service.get("edge", undefined);

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledExactlyOnceWith(DEFAULT_ENTRY);
    expect(store.size).toBe(0);
  });

  it("answers 503 SERVICE_UNAVAILABLE and caches nothing when the platform cannot be read", async () => {
    const { service, store, logger } = harness({
      domains: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
    });

    const failure: unknown = await service.get("edge", undefined).catch((error: unknown) => error);

    expect(failure instanceof AppError ? failure.code : failure).toBe("SERVICE_UNAVAILABLE");
    expect(store.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { tenantId: TENANT_ID },
      "storefront.domains_unavailable",
    );
  });
});
