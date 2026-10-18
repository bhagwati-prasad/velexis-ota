// TlsAskService and its refusal cache without a database or Redis (PBE-027; ADR-0018, PADR-0004 item 6, scope PF-40
// and PF-42): the host syntax, the rules of both kinds of host, the order of the checks (syntax, Redis, the in-process
// refusals, the database) with what each step touches, the 60-second positive answers in Redis and the bounded LRU of
// refusals, and the `vx:invalidate` events that make the service forget a host. The repository and the Redis client
// are stand-ins that record their calls; test/integration/domains/tls-ask.int.test.ts runs the same rules through
// HTTP, PostgreSQL and Redis.
import type { InvalidationEvent } from "@velexis/api-types/jobs";
import { FakeClock } from "@velexis/testing";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it } from "vitest";
import type { FeatureSwitches } from "../common/features";
import type { CustomStorefrontTarget, DomainsRepository, TenantHosts } from "./domains.repository";
import {
  TLS_ASK_NEGATIVE_CACHE_MAX_ENTRIES,
  TLS_ASK_NEGATIVE_CACHE_TTL_MS,
  TlsAskNegativeCache,
} from "./tls-ask.negative-cache";
import { askHost, askTarget, customDomainLimit, TlsAskService } from "./tls-ask.service";

const BASE = "ota.example.com";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const CUSTOM = "travel.example.net";

/** A label of `n` letters. */
const label = (n: number): string => "a".repeat(n);

describe("askHost", () => {
  it("accepts lower-case host names of two or more labels, punycode included, and lower-cases its input", () => {
    for (const host of [
      "acme.ota.example.com",
      "travel.example.net",
      "xn--bcher-kva.example.net",
      "a1-b2.example.org",
      "123.example.com",
      `${label(63)}.example.com`,
    ]) {
      expect(askHost(host), host).toBe(host);
    }
    expect(askHost("ACME.Ota.Example.COM")).toBe("acme.ota.example.com");
  });

  it("accepts 253 characters and refuses 254, and a 300-character host before any pattern match", () => {
    const at253 = `${[label(63), label(63), label(63)].join(".")}.${label(61)}`;
    expect(at253).toHaveLength(253);
    expect(askHost(at253)).toBe(at253);
    expect(askHost(`${at253}a`)).toBeUndefined();

    const host300 = `${"a".repeat(296)}.com`;
    expect(host300).toHaveLength(300);
    expect(askHost(host300)).toBeUndefined();
  });

  it("refuses everything that is not a host name of PADR-0004 item 6", () => {
    for (const value of [
      undefined,
      null,
      42,
      ["acme.ota.example.com"],
      "",
      "localhost",
      "example",
      "acme.ota.example.com.",
      ".acme.ota.example.com",
      "acme..example.com",
      "192.0.2.10",
      "10.0.0.1",
      "2001:db8::10",
      "[2001:db8::10]",
      "-acme.example.com",
      "acme-.example.com",
      "ac_me.example.com",
      "acme.example.com:443",
      "acme example.com",
      "bücher.example.net",
      "acme.example.c0m-",
      "acme.example.1com",
      `${label(64)}.example.com`,
      "*.ota.example.com",
    ]) {
      expect(askHost(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe("askTarget", () => {
  it("tells sub-domains of the base domain from custom hosts, and refuses what no rule can allow", () => {
    expect(askTarget("acme.ota.example.com", BASE)).toEqual({ kind: "subdomain", key: "acme" });
    expect(askTarget("travel.example.net", BASE)).toEqual({ kind: "custom" });
    expect(askTarget("ota.example.com.evil.net", BASE)).toEqual({ kind: "custom" });
    expect(askTarget("acmeota.example.com", BASE)).toEqual({ kind: "custom" });
    // The base domain itself, a host below a sub-domain, and labels that are no tenant key.
    for (const host of [
      "ota.example.com",
      "www.acme.ota.example.com",
      "ab.ota.example.com",
      "1acme.ota.example.com",
    ]) {
      expect(askTarget(host, BASE), host).toEqual({ kind: "none" });
    }
  });

  it("reads the plan's customDomains quota as listPlans does", () => {
    expect(customDomainLimit({ customDomains: 2 })).toBe(2);
    for (const limits of [
      null,
      undefined,
      [],
      {},
      { customDomains: -1 },
      { customDomains: 1.5 },
      { customDomains: "3" },
    ]) {
      expect(customDomainLimit(limits), JSON.stringify(limits)).toBe(0);
    }
  });
});

describe("TlsAskNegativeCache", () => {
  let clock: FakeClock;
  let cache: TlsAskNegativeCache;

  beforeEach(() => {
    clock = new FakeClock("2026-10-17T09:00:00Z");
    cache = new TlsAskNegativeCache(clock);
  });

  it("remembers a refusal for 60 seconds", () => {
    cache.add("unknown.example.net");

    expect(cache.has("unknown.example.net")).toBe(true);
    clock.advance(TLS_ASK_NEGATIVE_CACHE_TTL_MS - 1);
    expect(cache.has("unknown.example.net")).toBe(true);
    clock.advance(1);
    expect(cache.has("unknown.example.net")).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("[PBE-027 AC4] never holds more than 10 000 hosts and drops the least recently used first", () => {
    for (let n = 0; n < TLS_ASK_NEGATIVE_CACHE_MAX_ENTRIES; n += 1) {
      cache.add(`host${n}.example.net`);
    }
    expect(cache.size).toBe(10_000);
    // A hit makes host0 the most recently used, so host1 is the next to go.
    expect(cache.has("host0.example.net")).toBe(true);

    let largest = cache.size;
    for (let n = 0; n < 5000; n += 1) {
      cache.add(`flood${n}.example.net`);
      largest = Math.max(largest, cache.size);
    }

    expect(largest).toBe(10_000);
    expect(cache.size).toBe(10_000);
    expect(cache.has("host0.example.net")).toBe(true);
    expect(cache.has("host1.example.net")).toBe(false);
    expect(cache.has("flood4999.example.net")).toBe(true);
  });

  it("forgets a host on delete", () => {
    cache.add("unknown.example.net");

    expect(cache.delete("unknown.example.net")).toBe(true);
    expect(cache.has("unknown.example.net")).toBe(false);
    expect(cache.delete("unknown.example.net")).toBe(false);
  });
});

/** What the stand-ins saw, in order. */
type Call = readonly [string, ...unknown[]];

/** The service over stand-ins of the repository, Redis, the switches and the refusal cache. */
class Harness {
  readonly calls: Call[] = [];
  readonly redisKeys = new Map<string, { value: string; ttl: number }>();
  readonly clock = new FakeClock("2026-10-17T09:00:00Z");
  readonly refusals = new TlsAskNegativeCache(this.clock);
  readonly service: TlsAskService;
  /** Tenant statuses by key. */
  readonly tenants = new Map<string, string>();
  /** Verified custom storefront domains by host name. */
  readonly customDomains = new Map<string, CustomStorefrontTarget>();
  readonly hosts = new Map<string, TenantHosts>();
  customDomainsSwitch = true;
  redisDown = false;
  /** Runs while a database lookup is under way (to deliver an event in the middle of it). */
  duringLookup: (() => Promise<void>) | undefined;

  constructor() {
    const lookup = async <T>(call: Call, answer: () => T): Promise<T> => {
      this.calls.push(call);
      await this.duringLookup?.();
      return answer();
    };
    const repository = {
      tenantStatusByKey: (key: string) => lookup(["db.tenantStatusByKey", key], () => this.tenants.get(key)),
      verifiedCustomStorefront: (host: string) =>
        lookup(["db.verifiedCustomStorefront", host], () => this.customDomains.get(host)),
      hostsOfTenant: (tenantId: string) =>
        lookup(["db.hostsOfTenant", tenantId], () => this.hosts.get(tenantId)),
    } as unknown as DomainsRepository;
    const redis = {
      get: (key: string) => {
        this.calls.push(["redis.get", key]);
        return this.redisDown
          ? Promise.reject(new Error("Connection is closed."))
          : Promise.resolve(this.redisKeys.get(key)?.value ?? null);
      },
      set: (key: string, value: string, ex: string, ttl: number) => {
        this.calls.push(["redis.set", key, value, ex, ttl]);
        if (this.redisDown) {
          return Promise.reject(new Error("Connection is closed."));
        }
        this.redisKeys.set(key, { value, ttl });
        return Promise.resolve("OK");
      },
      del: (...keys: string[]) => {
        this.calls.push(["redis.del", ...keys]);
        for (const key of keys) {
          this.redisKeys.delete(key);
        }
        return Promise.resolve(keys.length);
      },
    } as unknown as Redis;
    const refusals = this.refusals;
    const calls = this.calls;
    const recordingRefusals = Object.assign(Object.create(refusals) as TlsAskNegativeCache, {
      has: (host: string) => {
        calls.push(["lru.has", host]);
        return refusals.has(host);
      },
      add: (host: string) => {
        calls.push(["lru.add", host]);
        refusals.add(host);
      },
      delete: (host: string) => {
        calls.push(["lru.delete", host]);
        return refusals.delete(host);
      },
    });
    const features = {
      isEnabled: (feature: string) => feature === "custom_domains" && this.customDomainsSwitch,
    } as unknown as FeatureSwitches;
    const config = { get: () => BASE } as never;
    const logger = { setContext: () => undefined, debug: () => undefined } as unknown as PinoLogger;
    this.service = new TlsAskService(config, features, repository, recordingRefusals, redis, logger);
  }

  async ask(domain: unknown): Promise<{ allowed: boolean; calls: Call[] }> {
    this.calls.length = 0;
    const allowed = await this.service.ask(domain);
    return { allowed, calls: [...this.calls] };
  }

  async event(event: InvalidationEvent): Promise<Call[]> {
    this.calls.length = 0;
    await this.service.onInvalidation(event);
    return [...this.calls];
  }
}

describe("TlsAskService.ask", () => {
  let h: Harness;

  beforeEach(() => {
    h = new Harness();
  });

  it("[PBE-027 AC1] allows the sub-domain of a provisioning, active or suspended tenant and refuses a failed one", async () => {
    for (const status of ["provisioning", "active", "suspended", "failed", "deprovisioning", "deleted"]) {
      h.tenants.set(`ota${status.slice(0, 6)}`, status);
    }

    const answers: Record<string, boolean> = {};
    for (const status of ["provisioning", "active", "suspended", "failed", "deprovisioning", "deleted"]) {
      answers[status] = (await h.ask(`ota${status.slice(0, 6)}.${BASE}`)).allowed;
    }
    const unknown = await h.ask(`nobody.${BASE}`);

    expect(answers).toEqual({
      provisioning: true,
      active: true,
      suspended: true,
      failed: false,
      deprovisioning: false,
      deleted: false,
    });
    expect(unknown.allowed).toBe(false);
  });

  it("[PBE-027 AC2] allows a verified custom domain of an active tenant whose plan has custom domains, only with the switch on", async () => {
    h.customDomains.set(CUSTOM, { tenant_status: "active", limits: { customDomains: 1 } });
    h.customDomains.set("suspended.example.net", {
      tenant_status: "suspended",
      limits: { customDomains: 1 },
    });
    h.customDomains.set("noplan.example.net", { tenant_status: "active", limits: { customDomains: 0 } });
    h.customDomains.set("missing.example.net", { tenant_status: "active", limits: null });

    expect((await h.ask(CUSTOM)).allowed).toBe(true);
    // Pending or failed custom domains are not among the verified ones the repository answers.
    expect((await h.ask("pending.example.net")).allowed).toBe(false);
    expect((await h.ask("suspended.example.net")).allowed).toBe(false);
    expect((await h.ask("noplan.example.net")).allowed).toBe(false);
    expect((await h.ask("missing.example.net")).allowed).toBe(false);

    const off = new Harness();
    off.customDomainsSwitch = false;
    off.customDomains.set(CUSTOM, { tenant_status: "active", limits: { customDomains: 1 } });
    off.redisKeys.set(`tlsask:${CUSTOM}`, { value: "1", ttl: 60 });
    // With the switch off no custom host is looked up, in a cache or in the database.
    expect(await off.ask(CUSTOM)).toEqual({ allowed: false, calls: [] });
  });

  it("[PBE-027 AC4] refuses a malformed host before any cache or database access, and caches it nowhere", async () => {
    for (const value of [
      `${"a".repeat(296)}.com`,
      undefined,
      "",
      "192.0.2.10",
      "localhost",
      "acme.ota.example.com.",
    ]) {
      expect(await h.ask(value), JSON.stringify(value)).toEqual({ allowed: false, calls: [] });
    }
    expect(h.refusals.size).toBe(0);
    expect(h.redisKeys.size).toBe(0);
  });

  it("refuses hosts that no rule can allow without a lookup: the base domain, deeper hosts, labels that are no key", async () => {
    for (const host of [BASE, `www.acme.${BASE}`, `ab.${BASE}`, `1acme.${BASE}`]) {
      expect(await h.ask(host), host).toEqual({ allowed: false, calls: [] });
    }
  });

  it("checks Redis, then the refusals, then the database, and keeps a yes in Redis for 60 seconds", async () => {
    h.tenants.set("acme", "active");
    const host = `acme.${BASE}`;

    const first = await h.ask(host);
    const second = await h.ask(host);

    expect(first).toEqual({
      allowed: true,
      calls: [
        ["redis.get", `tlsask:${host}`],
        ["lru.has", host],
        ["db.tenantStatusByKey", "acme"],
        ["redis.set", `tlsask:${host}`, "1", "EX", 60],
      ],
    });
    expect(second).toEqual({ allowed: true, calls: [["redis.get", `tlsask:${host}`]] });
    expect(h.refusals.size).toBe(0);
  });

  it("keeps a no in the process, never in Redis, and answers it from there for 60 seconds", async () => {
    const host = "unknown.example.net";

    const first = await h.ask(host);
    const second = await h.ask(host);
    h.clock.advance(TLS_ASK_NEGATIVE_CACHE_TTL_MS);
    const third = await h.ask(host);

    expect(first).toEqual({
      allowed: false,
      calls: [
        ["redis.get", `tlsask:${host}`],
        ["lru.has", host],
        ["db.verifiedCustomStorefront", host],
        ["lru.add", host],
      ],
    });
    expect(second).toEqual({
      allowed: false,
      calls: [
        ["redis.get", `tlsask:${host}`],
        ["lru.has", host],
      ],
    });
    expect(third.calls).toContainEqual(["db.verifiedCustomStorefront", host]);
    expect(h.redisKeys.size).toBe(0);
  });

  it("answers from PostgreSQL while Redis is down", async () => {
    h.tenants.set("acme", "active");
    h.redisDown = true;

    expect((await h.ask(`acme.${BASE}`)).allowed).toBe(true);
    expect((await h.ask(`nobody.${BASE}`)).allowed).toBe(false);
  });
});

describe("TlsAskService.onInvalidation", () => {
  let h: Harness;

  beforeEach(() => {
    h = new Harness();
  });

  it("[PBE-027 AC3] forgets a refused host on its domain event, so it is allowed right after its verification", async () => {
    expect((await h.ask(CUSTOM)).allowed).toBe(false);
    h.customDomains.set(CUSTOM, { tenant_status: "active", limits: { customDomains: 1 } });
    expect((await h.ask(CUSTOM)).allowed).toBe(false);

    const calls = await h.event({ v: 1, type: "domain", hostname: CUSTOM });

    expect(calls).toEqual([
      ["lru.delete", CUSTOM],
      ["redis.del", `tlsask:${CUSTOM}`],
    ]);
    expect((await h.ask(CUSTOM)).allowed).toBe(true);
  });

  it("[PBE-027 AC3] drops a cached yes on its domain event, so a removed domain is refused at once", async () => {
    h.customDomains.set(CUSTOM, { tenant_status: "active", limits: { customDomains: 1 } });
    expect((await h.ask(CUSTOM)).allowed).toBe(true);
    expect(h.redisKeys.has(`tlsask:${CUSTOM}`)).toBe(true);
    h.customDomains.delete(CUSTOM);

    await h.event({ v: 1, type: "domain", hostname: CUSTOM });

    expect(h.redisKeys.has(`tlsask:${CUSTOM}`)).toBe(false);
    expect((await h.ask(CUSTOM)).allowed).toBe(false);
  });

  it("forgets every host of a tenant on its tenant event", async () => {
    h.tenants.set("acme", "provisioning");
    h.customDomains.set(CUSTOM, { tenant_status: "active", limits: { customDomains: 1 } });
    h.hosts.set(TENANT_ID, { key: "acme", hostnames: [`acme.${BASE}`, CUSTOM, "pending.example.net"] });
    await h.ask(`acme.${BASE}`);
    await h.ask(CUSTOM);
    await h.ask("pending.example.net");
    expect(h.redisKeys.size).toBe(2);
    expect(h.refusals.size).toBe(1);

    const calls = await h.event({ v: 1, type: "tenant", id: TENANT_ID });

    expect(calls).toEqual([
      ["db.hostsOfTenant", TENANT_ID],
      ["lru.delete", `acme.${BASE}`],
      ["lru.delete", CUSTOM],
      ["lru.delete", "pending.example.net"],
      ["redis.del", `tlsask:acme.${BASE}`, `tlsask:${CUSTOM}`, "tlsask:pending.example.net"],
    ]);
    expect(h.redisKeys.size).toBe(0);
    expect(h.refusals.size).toBe(0);
  });

  it("does not cache an answer read while an invalidation arrived", async () => {
    h.duringLookup = async () => {
      h.duringLookup = undefined;
      await h.service.onInvalidation({ v: 1, type: "domain", hostname: CUSTOM });
    };

    const { allowed, calls } = await h.ask(CUSTOM);

    expect(allowed).toBe(false);
    expect(calls).not.toContainEqual(["lru.add", CUSTOM]);
    expect(h.refusals.size).toBe(0);
  });

  it("ignores the events that change no answer, and a tenant that no longer exists", async () => {
    await h.ask("unknown.example.net");

    for (const event of [
      { v: 1, type: "api_key", prefix: "pk_test_3fA9x2" },
      { v: 1, type: "connection", tenantId: TENANT_ID },
      { v: 1, type: "plan", code: "early_access" },
    ] as const) {
      expect(await h.event(event), event.type).toEqual([]);
    }
    expect(await h.event({ v: 1, type: "tenant", id: TENANT_ID })).toEqual([["db.hostsOfTenant", TENANT_ID]]);
    expect(h.refusals.size).toBe(1);
  });
});
