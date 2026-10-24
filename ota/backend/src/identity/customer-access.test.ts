// Whether the customer of a valid access token may still act (FIX-W29-SECURITY; identity/customer-access.ts): the
// cached answer, the database read behind it, the revocation that account.delete writes after its commit, and the
// fallback when Redis cannot answer, against an in-memory Redis with the `SET … EX … NX` semantics of the real one and
// a database read the test controls. The guard and the deletion in the API's pipeline, against PostgreSQL and Redis:
// test/integration/account/deleted-customer.int.test.ts.
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it } from "vitest";
import { redisKeys } from "../common/redis/redis.keys";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import {
  CUSTOMER_ACCESS_ALLOWED,
  CUSTOMER_ACCESS_REVOKED,
  CustomerAccess,
  type CustomerAccessRedis,
} from "./customer-access";
import type { SessionCustomer, SessionsRepository } from "./sessions.repository";

const TENANT = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1A";
const CUSTOMER = "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const keyOf = (environment: "test" | "live"): string =>
  redisKeys.customerAccess(TENANT, environment, CUSTOMER).key;

/** An in-memory Redis of string keys with their TTLs, which can be told to fail. */
class MemoryRedis {
  readonly values = new Map<string, { value: string; ttlSeconds: number }>();
  failing = false;
  /** Runs once, between a GET and the next SET: what another process did meanwhile. */
  beforeNextSet: (() => void) | undefined;

  get = (key: string): Promise<string | null> =>
    this.failing
      ? Promise.reject(new Error("Connection is closed."))
      : Promise.resolve(this.values.get(key)?.value ?? null);

  set = (key: string, value: string, _ex: "EX", ttlSeconds: number, nx?: "NX"): Promise<"OK" | null> => {
    if (this.failing) {
      return Promise.reject(new Error("Connection is closed."));
    }
    const before = this.beforeNextSet;
    this.beforeNextSet = undefined;
    before?.();
    if (nx === "NX" && this.values.has(key)) {
      return Promise.resolve(null);
    }
    this.values.set(key, { value, ttlSeconds });
    return Promise.resolve("OK");
  };

  multi = () => {
    const queued: Array<[string, string, number]> = [];
    const batch = {
      set: (key: string, value: string, _ex: "EX", ttlSeconds: number) => {
        queued.push([key, value, ttlSeconds]);
        return batch;
      },
      exec: (): Promise<Array<[Error | null, unknown]>> => {
        if (this.failing) {
          return Promise.reject(new Error("Connection is closed."));
        }
        for (const [key, value, ttlSeconds] of queued) {
          this.values.set(key, { value, ttlSeconds });
        }
        return Promise.resolve(queued.map(() => [null, "OK"]));
      },
    };
    return batch;
  };
}

interface Harness {
  readonly access: CustomerAccess;
  readonly redis: MemoryRedis;
  /** How often the customer was read from the database. */
  readonly reads: { count: number };
  /** The events of the warnings logged, in order. */
  readonly warnings: string[];
  /** Sets what the database holds for the customer (`undefined`: no such customer). */
  setCustomer(customer: SessionCustomer | undefined): void;
}

function harness(environment: "test" | "live" = "test"): Harness {
  const redis = new MemoryRedis();
  const reads = { count: 0 };
  const warnings: string[] = [];
  let stored: SessionCustomer | undefined = { id: CUSTOMER, status: "active", deleted_at: null };
  const access = new CustomerAccess(
    redis as unknown as CustomerAccessRedis,
    {
      run: <T>(fn: (trx: TenantTransaction) => Promise<T>) => fn({} as TenantTransaction),
    } as unknown as TenantTx,
    { require: () => ({ tenantId: TENANT, environment }) as RequestTenant } as unknown as TenantContext,
    {
      findSessionCustomer: () => {
        reads.count += 1;
        return Promise.resolve(stored);
      },
    } as unknown as SessionsRepository,
    { warn: (_fields: unknown, event: string) => warnings.push(event) } as unknown as PinoLogger,
  );
  return {
    access,
    redis,
    reads,
    warnings,
    setCustomer: (customer) => {
      stored = customer;
    },
  };
}

describe("CustomerAccess.mayAct", () => {
  it("lets a customer act on its cached answer without reading the database [FIX-W29-SECURITY AC3]", async () => {
    const { access, redis, reads } = harness();
    redis.values.set(keyOf("test"), { value: CUSTOMER_ACCESS_ALLOWED, ttlSeconds: 60 });

    expect(await access.mayAct(CUSTOMER)).toBe(true);
    expect(reads.count).toBe(0);
  });

  it("reads an active or unverified customer from the database and caches the answer for a minute [FIX-W29-SECURITY AC3]", async () => {
    for (const status of ["active", "pending_verification"]) {
      const { access, redis, reads, setCustomer } = harness("live");
      setCustomer({ id: CUSTOMER, status, deleted_at: null });

      expect(await access.mayAct(CUSTOMER), status).toBe(true);
      expect(await access.mayAct(CUSTOMER), status).toBe(true);
      expect(reads.count, status).toBe(1);
      expect([...redis.values]).toEqual([
        [keyOf("live"), { value: CUSTOMER_ACCESS_ALLOWED, ttlSeconds: 60 }],
      ]);
    }
  });

  it("refuses a deleted, disabled or missing customer and caches nothing [FIX-W29-SECURITY AC3]", async () => {
    const states: Array<SessionCustomer | undefined> = [
      { id: CUSTOMER, status: "deleted", deleted_at: new Date("2026-10-20T08:00:00Z") },
      { id: CUSTOMER, status: "disabled", deleted_at: null },
      { id: CUSTOMER, status: "active", deleted_at: new Date("2026-10-20T08:00:00Z") },
      undefined,
    ];
    for (const state of states) {
      const { access, redis, reads, setCustomer } = harness();
      setCustomer(state);

      expect(await access.mayAct(CUSTOMER), String(state?.status)).toBe(false);
      expect(await access.mayAct(CUSTOMER), String(state?.status)).toBe(false);
      expect([reads.count, redis.values.size], String(state?.status)).toEqual([2, 0]);
    }
  });

  it("revokes the cached answer in both environments for a minute, and then reads the database on every request [FIX-W29-SECURITY AC3]", async () => {
    const { access, redis, reads, setCustomer } = harness();
    expect(await access.mayAct(CUSTOMER)).toBe(true);

    setCustomer({ id: CUSTOMER, status: "deleted", deleted_at: new Date("2026-10-20T08:00:00Z") });
    await access.revoke(TENANT, CUSTOMER);

    expect(Object.fromEntries(redis.values)).toEqual({
      [keyOf("test")]: { value: CUSTOMER_ACCESS_REVOKED, ttlSeconds: 60 },
      [keyOf("live")]: { value: CUSTOMER_ACCESS_REVOKED, ttlSeconds: 60 },
    });
    expect(await access.mayAct(CUSTOMER)).toBe(false);
    expect(await access.mayAct(CUSTOMER)).toBe(false);
    expect(reads.count).toBe(3);
  });

  it("never caches a customer over a revocation, even one that is allowed again (re-enabled) [FIX-W29-SECURITY AC3]", async () => {
    const { access, redis, reads } = harness();
    await access.revoke(TENANT, CUSTOMER);

    expect(await access.mayAct(CUSTOMER)).toBe(true);
    expect(await access.mayAct(CUSTOMER)).toBe(true);
    expect(reads.count).toBe(2);
    expect(redis.values.get(keyOf("test"))?.value).toBe(CUSTOMER_ACCESS_REVOKED);
  });

  it("does not cache what it read before a revocation that came in before its write (SET NX) [FIX-W29-SECURITY AC3]", async () => {
    const { access, redis } = harness();
    // The guard read the customer active; the deletion committed and revoked before the guard wrote its answer.
    redis.beforeNextSet = () => {
      redis.values.set(keyOf("test"), { value: CUSTOMER_ACCESS_REVOKED, ttlSeconds: 60 });
    };

    expect(await access.mayAct(CUSTOMER)).toBe(true);
    expect(redis.values.get(keyOf("test"))?.value).toBe(CUSTOMER_ACCESS_REVOKED);
  });

  it("reads the database when Redis cannot answer, caches nothing and logs it [FIX-W29-SECURITY AC3]", async () => {
    const { access, redis, reads, warnings, setCustomer } = harness();
    redis.failing = true;

    expect(await access.mayAct(CUSTOMER)).toBe(true);
    setCustomer({ id: CUSTOMER, status: "disabled", deleted_at: null });
    expect(await access.mayAct(CUSTOMER)).toBe(false);
    expect([reads.count, redis.values.size]).toEqual([2, 0]);
    expect(warnings).toEqual(["customer.access_cache_unavailable", "customer.access_cache_unavailable"]);
  });
});

describe("CustomerAccess.revoke", () => {
  it("never throws when Redis cannot store the revocation, and logs it [FIX-W29-SECURITY AC3]", async () => {
    const { access, redis, warnings } = harness();
    redis.failing = true;

    await expect(access.revoke(TENANT, CUSTOMER)).resolves.toBeUndefined();
    expect(warnings).toEqual(["customer.access_revocation_failed"]);
  });
});
