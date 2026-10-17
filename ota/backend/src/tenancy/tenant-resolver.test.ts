// TenantResolver against a fake platform cache (OBE-012; OADR-0009 point 2, PADR-0014 point 5): which tenant and
// environment an edge host or an API key resolves to, and how hosts and tenants are refused. The resolver, the caches,
// the subscriber and the guard against PostgreSQL and Redis are test/integration/tenancy/tenant-resolution.int.test.ts
// and invalidation.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { newId } from "../common/ids";
import type { ApiConfig } from "../config";
import type { EdgeCaller, KeyCaller } from "./caller-resolver";
import { parseApiKey, parseTenant, parseTenantId, type PlatformCache } from "./platform-cache";
import type { PlatformApiKey } from "./platform-read.repository";
import type { PlatformTenant, TenantStatus } from "./platform-read.types";
import { TenantResolver } from "./tenant-resolver";

const BASE_DOMAIN = "ota.example.com";

function tenant(key: string, overrides: Partial<PlatformTenant> = {}): PlatformTenant {
  return Object.freeze({
    id: newId("ten"),
    key,
    name: `${key} Travel`,
    status: "active",
    schemaName: `tenant_${key}` as PlatformTenant["schemaName"],
    storefrontEnvironment: "test",
    defaultCurrency: "EUR",
    defaultLocale: "en",
    billingNotice: null,
    ...overrides,
  });
}

interface World {
  readonly tenants: readonly PlatformTenant[];
  /** Verified storefront domains: host name → tenant key. */
  readonly domains?: Readonly<Record<string, string>>;
}

/** A resolver over a fake cache that knows `world`, with spies on every lookup and the debug and warn lines. */
function harness(world: World) {
  const byKey = new Map(world.tenants.map((row) => [row.key, row]));
  const cache = {
    tenantByKey: vi.fn((key: string) => Promise.resolve(byKey.get(key) ?? null)),
    tenantById: vi.fn((id: string) => Promise.resolve(world.tenants.find((row) => row.id === id) ?? null)),
    tenantByStorefrontHost: vi.fn((host: string) => {
      const key = world.domains?.[host];
      return Promise.resolve(key === undefined ? null : (byKey.get(key) ?? null));
    }),
  };
  const logs: Array<[string, unknown, string]> = [];
  const logger = {
    setContext: () => undefined,
    debug: (fields: unknown, message: string) => logs.push(["debug", fields, message]),
    warn: (fields: unknown, message: string) => logs.push(["warn", fields, message]),
  } as unknown as PinoLogger;
  const config = { get: () => BASE_DOMAIN } as unknown as ConfigService<ApiConfig, true>;
  const resolver = new TenantResolver(config, cache as unknown as PlatformCache, logger);
  const lookups = () =>
    cache.tenantByKey.mock.calls.length +
    cache.tenantById.mock.calls.length +
    cache.tenantByStorefrontHost.mock.calls.length;
  return { resolver, cache, logs, lookups };
}

const edge = (host: string): EdgeCaller => ({ type: "edge", id: "edge", host });

function keyOf(row: PlatformTenant, environment: "test" | "live"): KeyCaller {
  const keyId = newId("key");
  return { type: "key", id: keyId, keyId, kind: "secret", tenantId: row.id, environment, scopes: [] };
}

/** The AppError a promise rejects with, as `[status, code, details]`. */
async function refusal(promise: Promise<unknown>): Promise<[number, string, unknown]> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  const { status, code, details } = error as AppError;
  return [status, code, details];
}

const HOST_NOT_ALLOWED = [403, "HOST_NOT_ALLOWED", { reason: "unknown" }];

describe("edge requests", () => {
  it("resolve <key>.<STOREFRONT_BASE_DOMAIN> to the tenant of the key, in its storefront environment [OBE-012 AC1]", async () => {
    const alpha = tenant("alpha");
    const beta = tenant("beta", { storefrontEnvironment: "live" });
    const { resolver, cache } = harness({ tenants: [alpha, beta] });

    await expect(resolver.resolve(edge("alpha.ota.example.com"))).resolves.toEqual({
      tenant: alpha,
      environment: "test",
    });
    await expect(resolver.resolve(edge("beta.ota.example.com"))).resolves.toEqual({
      tenant: beta,
      environment: "live",
    });
    expect(cache.tenantByKey.mock.calls).toEqual([["alpha"], ["beta"]]);
    expect(cache.tenantByStorefrontHost).not.toHaveBeenCalled();
  });

  it("resolve a verified custom storefront domain to its tenant, in the tenant's storefront environment [OBE-012 AC1]", async () => {
    const beta = tenant("beta", { storefrontEnvironment: "live" });
    const { resolver, cache } = harness({ tenants: [beta], domains: { "book.beta-travel.example": "beta" } });

    await expect(resolver.resolve(edge("book.beta-travel.example"))).resolves.toEqual({
      tenant: beta,
      environment: "live",
    });
    expect(cache.tenantByStorefrontHost).toHaveBeenCalledExactlyOnceWith("book.beta-travel.example");
    expect(cache.tenantByKey).not.toHaveBeenCalled();
  });

  it("never resolve the host of one tenant to another", async () => {
    const alpha = tenant("alpha");
    const beta = tenant("beta");
    const { resolver } = harness({
      tenants: [alpha, beta],
      domains: { "book.alpha-travel.example": "alpha", "book.beta-travel.example": "beta" },
    });
    const hosts: Array<[string, PlatformTenant]> = [
      ["alpha.ota.example.com", alpha],
      ["beta.ota.example.com", beta],
      ["book.alpha-travel.example", alpha],
      ["book.beta-travel.example", beta],
    ];

    const resolved = await Promise.all(
      [...hosts, ...[...hosts].reverse()].map(([host]) => resolver.resolve(edge(host))),
    );

    expect(resolved.map(({ tenant: row }) => row.id)).toEqual(
      [...hosts, ...[...hosts].reverse()].map(([, row]) => row.id),
    );
  });

  it("answer 403 HOST_NOT_ALLOWED for an unknown sub-domain or host, with the same details", async () => {
    const { resolver, cache } = harness({ tenants: [tenant("alpha")] });

    expect(await refusal(resolver.resolve(edge("gamma.ota.example.com")))).toEqual(HOST_NOT_ALLOWED);
    expect(await refusal(resolver.resolve(edge("book.unknown-travel.example")))).toEqual(HOST_NOT_ALLOWED);
    expect(await refusal(resolver.resolve(edge(BASE_DOMAIN)))).toEqual(HOST_NOT_ALLOWED);
    expect(cache.tenantByKey).toHaveBeenCalledExactlyOnceWith("gamma");
    expect(cache.tenantByStorefrontHost.mock.calls).toEqual([["book.unknown-travel.example"], [BASE_DOMAIN]]);
  });

  it("refuse hosts that cannot be a tenant's sub-domain or a stored host name without a lookup", async () => {
    const { resolver, lookups, logs } = harness({ tenants: [tenant("alpha")] });

    for (const host of [
      "a.alpha.ota.example.com",
      "Alpha.ota.example.com",
      "-alpha.ota.example.com",
      ".ota.example.com",
      "alpha.ota.example.com:8443",
      "book.alpha-travel.example.",
      "203.0.113.7",
      "[::1]",
      "localhost",
      "alpha travel.example",
    ]) {
      expect([host, ...(await refusal(resolver.resolve(edge(host))))]).toEqual([host, ...HOST_NOT_ALLOWED]);
    }
    expect(lookups()).toBe(0);
    expect(logs.every(([level]) => level === "debug")).toBe(true);
  });

  it("answer 403 TENANT_SUSPENDED on the sub-domain of a tenant that is not active, so the storefront can show it", async () => {
    const statuses: TenantStatus[] = ["provisioning", "suspended", "deprovisioning", "deleted", "failed"];
    const rows = statuses.map((status, index) => tenant(`t${index}x`, { status }));
    const { resolver } = harness({ tenants: rows });

    for (const row of rows) {
      expect([row.status, ...(await refusal(resolver.resolve(edge(`${row.key}.${BASE_DOMAIN}`))))]).toEqual([
        row.status,
        403,
        "TENANT_SUSPENDED",
        undefined,
      ]);
    }
  });

  it("answer 403 HOST_NOT_ALLOWED on the custom domain of a tenant that is not active (PADR-0014 point 5)", async () => {
    const gamma = tenant("gamma", { status: "suspended" });
    const { resolver, cache } = harness({
      tenants: [gamma],
      domains: { "book.gamma-travel.example": "gamma" },
    });

    expect(await refusal(resolver.resolve(edge("book.gamma-travel.example")))).toEqual(HOST_NOT_ALLOWED);
    expect(cache.tenantByStorefrontHost).toHaveBeenCalledOnce();
  });

  it("propagate a failing lookup (503 from the cache when PostgreSQL is down)", async () => {
    const { resolver, cache } = harness({ tenants: [] });
    cache.tenantByKey.mockRejectedValue(new AppError("SERVICE_UNAVAILABLE"));

    expect(await refusal(resolver.resolve(edge("alpha.ota.example.com")))).toEqual([
      503,
      "SERVICE_UNAVAILABLE",
      undefined,
    ]);
  });
});

describe("key requests", () => {
  it("resolve the key's tenant in the key's environment, whatever the storefront's [OBE-012 AC1]", async () => {
    const alpha = tenant("alpha", { storefrontEnvironment: "test" });
    const { resolver, cache } = harness({ tenants: [alpha] });

    await expect(resolver.resolve(keyOf(alpha, "live"))).resolves.toEqual({
      tenant: alpha,
      environment: "live",
    });
    await expect(resolver.resolve(keyOf(alpha, "test"))).resolves.toEqual({
      tenant: alpha,
      environment: "test",
    });
    expect(cache.tenantById.mock.calls).toEqual([[alpha.id], [alpha.id]]);
  });

  it("answer 403 TENANT_SUSPENDED for the key of a tenant that is not active", async () => {
    const gamma = tenant("gamma", { status: "suspended" });
    const { resolver } = harness({ tenants: [gamma] });

    expect(await refusal(resolver.resolve(keyOf(gamma, "test")))).toEqual([
      403,
      "TENANT_SUSPENDED",
      undefined,
    ]);
  });

  it("answer 401 INVALID_API_KEY for a key whose tenant row is gone, and log the key id", async () => {
    const { resolver, logs } = harness({ tenants: [] });
    const caller = keyOf(tenant("ghost"), "test");

    expect(await refusal(resolver.resolve(caller))).toEqual([401, "INVALID_API_KEY", undefined]);
    expect(logs).toEqual([["warn", { keyId: caller.keyId }, "tenant.key_tenant_missing"]]);
  });
});

describe("cached values read back", () => {
  it("are accepted only with the shape the cache writes; a tenant's schema name is checked again", () => {
    const alpha = tenant("alpha");
    const row: PlatformApiKey = {
      id: newId("key"),
      tenantId: alpha.id,
      kind: "secret",
      environment: "test",
      prefix: "sk_test_Ab12Cd",
      keyHash: "0".repeat(64),
      allowedOrigins: [],
      scopes: ["storefront"],
      expiresAt: null,
      revokedAt: "2026-10-15T09:00:00.000Z",
    };
    const roundTrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

    expect(parseTenant(roundTrip(alpha))).toEqual(alpha);
    expect(Object.isFrozen(parseTenant(roundTrip(alpha)))).toBe(true);
    expect(parseApiKey(roundTrip(row))).toEqual(row);
    expect(parseTenantId(alpha.id)).toBe(alpha.id);
    for (const broken of [
      { ...alpha, schemaName: "public" },
      { ...alpha, schemaName: "tenant_beta" },
      { ...alpha, status: "archived" },
      { ...alpha, storefrontEnvironment: "prod" },
      { ...alpha, billingNotice: "overdue" },
      { ...alpha, name: 7 },
      null,
      [alpha],
    ]) {
      expect(parseTenant(broken)).toBeUndefined();
    }
    for (const broken of [
      { ...row, kind: "root" },
      { ...row, scopes: "storefront" },
      { ...row, allowedOrigins: [1] },
      { ...row, revokedAt: 0 },
    ]) {
      expect(parseApiKey(broken)).toBeUndefined();
    }
    for (const broken of ["acc_01M4TA0Z9N3QKX8V5B7C2D4E6F", "ten_", "ten_x:y", 7, null]) {
      expect(parseTenantId(broken)).toBeUndefined();
    }
  });
});
