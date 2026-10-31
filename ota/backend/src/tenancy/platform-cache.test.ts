// PlatformCache.invalidate for the `domain` event against an in-memory Redis (FIX-W38-OTA, lead decision (2g) of
// 2026-10-31, second batch): the host's tenant is resolved from the cached `host:<hostname>` entry before it is
// deleted, else from the platform table, and that tenant's storefront.get entries of both environments are dropped
// with it; a host of no tenant drops nothing else. The same against Redis 7 and PostgreSQL 16, with storefront.get
// itself, is in test/integration/tenancy/custom-domains.int.test.ts.
import type { InvalidationEvent } from "@velexis/api-types/jobs";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { redisKeys } from "../common/redis/redis.keys";
import { PLATFORM_CACHE_FORMAT, PlatformCache } from "./platform-cache";
import type { PlatformReadRepository } from "./platform-read.repository";

const ALPHA = "ten_01M4T9E68084G7ZWYRD6Z1RV0W";
const BETA = "ten_01M4T9HVE0355QAKGD2AVSQWH2";
const HOST = "book.alpha-travel.example";

/** A Redis of string keys answering the commands PlatformCache sends (GET, SET, DEL, SCAN with a `prefix*` glob). */
function memoryRedis(entries: Readonly<Record<string, string>> = {}) {
  const store = new Map(Object.entries(entries));
  const redis = {
    status: "ready",
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve("OK");
    }),
    del: vi.fn((...keys: string[]) => Promise.resolve(keys.filter((key) => store.delete(key)).length)),
    scan: vi.fn((_cursor: string, _match: "MATCH", glob: string) => {
      const prefix = glob.endsWith("*") ? glob.slice(0, -1) : glob;
      return Promise.resolve(["0", [...store.keys()].filter((key) => key.startsWith(prefix))]);
    }),
  };
  return { redis, store };
}

/** The storefront.get entries of `tenantId`: the default locale's and one more, in both environments. */
function storefrontEntries(tenantId: string): Record<string, string> {
  return Object.fromEntries(
    (["test", "live"] as const).flatMap((environment) =>
      ["und", "fr-FR"].map((locale) => [redisKeys.sf(tenantId, environment, locale).key, "{}"]),
    ),
  );
}

const cachedTenantId = (tenantId: string | null): string =>
  JSON.stringify({ v: PLATFORM_CACHE_FORMAT, value: tenantId });

function harness(
  entries: Readonly<Record<string, string>>,
  storefrontDomainTenantId: () => Promise<string | null>,
) {
  const { redis, store } = memoryRedis(entries);
  const platform = { storefrontDomainTenantId: vi.fn(storefrontDomainTenantId) };
  const logger = { setContext: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const cache = new PlatformCache(
    redis as unknown as Redis,
    platform as unknown as PlatformReadRepository,
    logger as unknown as PinoLogger,
  );
  return { cache, store, platform, logger };
}

const domainEvent: InvalidationEvent = { v: 1, type: "domain", hostname: HOST };

describe("PlatformCache.invalidate: a domain event", () => {
  it("[FIX-W38-OTA AC3] drops the storefront.get entries of the tenant the cached host entry names, in both environments, without a platform read", async () => {
    const { cache, store, platform } = harness(
      {
        [redisKeys.host(HOST).key]: cachedTenantId(ALPHA),
        ...storefrontEntries(ALPHA),
        ...storefrontEntries(BETA),
        [redisKeys.pages(ALPHA, "test", "en").key]: "{}",
      },
      () => Promise.resolve(BETA),
    );

    expect(await cache.invalidate(domainEvent)).toBe(5);

    expect([...store.keys()].sort()).toEqual(
      [...Object.keys(storefrontEntries(BETA)), redisKeys.pages(ALPHA, "test", "en").key].sort(),
    );
    expect(platform.storefrontDomainTenantId).not.toHaveBeenCalled();
  });

  it("[FIX-W38-OTA AC3] resolves the tenant from the platform table when the host is not cached, or cached as unknown", async () => {
    for (const hostEntry of [{}, { [redisKeys.host(HOST).key]: cachedTenantId(null) }]) {
      const { cache, store, platform } = harness(
        { ...hostEntry, ...storefrontEntries(ALPHA), ...storefrontEntries(BETA) },
        () => Promise.resolve(ALPHA),
      );

      await cache.invalidate(domainEvent);

      expect([...store.keys()].sort()).toEqual(Object.keys(storefrontEntries(BETA)).sort());
      expect(platform.storefrontDomainTenantId).toHaveBeenCalledExactlyOnceWith(HOST);
    }
  });

  it("[FIX-W38-OTA AC3] drops nothing but the host entry for a host of no tenant", async () => {
    const { cache, store } = harness(
      { [redisKeys.host(HOST).key]: cachedTenantId(null), ...storefrontEntries(ALPHA) },
      () => Promise.resolve(null),
    );

    expect(await cache.invalidate(domainEvent)).toBe(1);
    expect([...store.keys()].sort()).toEqual(Object.keys(storefrontEntries(ALPHA)).sort());
  });

  it("still deletes the host entry when the platform cannot be read, and logs without the host", async () => {
    const { cache, store, logger } = harness(storefrontEntries(ALPHA), () =>
      Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
    );
    store.set(redisKeys.host(HOST).key, cachedTenantId(null));

    expect(await cache.invalidate(domainEvent)).toBe(1);
    expect(store.has(redisKeys.host(HOST).key)).toBe(false);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ hostname: HOST }),
      "platform_cache.domain_tenant_unavailable",
    );
  });

  it("leaves the storefront.get entries alone on the other events, and counts every invalidation", async () => {
    const { cache, store, platform } = harness(storefrontEntries(ALPHA), () => Promise.resolve(ALPHA));
    const before = cache.invalidationGeneration();

    await cache.invalidate({ v: 1, type: "tenant", id: ALPHA });
    await cache.invalidate({ v: 1, type: "connection", tenantId: ALPHA });

    expect([...store.keys()].sort()).toEqual(Object.keys(storefrontEntries(ALPHA)).sort());
    expect(platform.storefrontDomainTenantId).not.toHaveBeenCalled();
    expect(cache.invalidationGeneration()).toBe(before + 2);
  });
});
