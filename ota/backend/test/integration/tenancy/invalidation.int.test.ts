// The `vx:invalidate` subscriber and the platform caches against Redis 7 and PostgreSQL 16 (OBE-012; OADR-0009 point
// 4, platform architecture §6.3): events published as the platform publishes them delete exactly the cached keys of
// their type, invalid messages change nothing, the subscriber subscribes again after losing its connection, and a
// cache fill that raced an invalidation is not written back.
//
// Redis pub/sub is not scoped to a database index: other test files (the platform's) may publish on `vx:invalidate`
// at the same time. Every id, host and prefix here is new, so their events never touch this file's keys. The API
// applies messages in the order they arrive, so a "sentinel" event published after another one shows that the first
// was applied when the sentinel's key is gone.
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { createPlatformDb, createPool, type Kysely, type PlatformDatabase } from "@velexis/db";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { redisKeys, type RedisKey } from "../../../src/common/redis/redis.keys";
import { INVALIDATION_CONNECTION_NAME } from "../../../src/tenancy/invalidation.subscriber";
import { PlatformCache } from "../../../src/tenancy/platform-cache";
import { PlatformReadRepository } from "../../../src/tenancy/platform-read.repository";
import { TenancyModule, type OtaPool } from "../../../src/tenancy/tenancy.module";
import { newApiKey } from "../../helpers/api-env";
import { createTestApp, type TestApp } from "../../support/create-test-app";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;

/** Publishes an event (or any text) on `vx:invalidate`, as the platform does after its commit. */
async function publish(message: InvalidationEvent | string): Promise<void> {
  await redis.client.publish(
    INVALIDATION_CHANNEL,
    typeof message === "string" ? message : JSON.stringify(message),
  );
}

/** A random 6-character base62 suffix of an API key prefix. */
function prefixOf(kind: "pk" | "sk"): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const random = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(
    "",
  );
  return `${kind}_test_${random}`;
}

/** A host name nobody else uses. */
const hostOf = (label: string): string => `${label}-${newId("ho").slice(3).toLowerCase()}.example.net`;

/**
 * Publishes a `domain` event for a cached sentinel host after whatever was published before, and waits until the API
 * has deleted it: everything published earlier has been applied by then.
 */
async function drained(): Promise<void> {
  const hostname = hostOf("sentinel");
  const sentinel = redisKeys.host(hostname);
  await redis.client.set(sentinel.key, '{"v":1,"value":null}', "EX", 10);
  await publish({ v: 1, type: "domain", hostname });
  await vi.waitFor(
    async () => {
      expect(await redis.client.exists(sentinel.key)).toBe(0);
    },
    { timeout: 5000, interval: 10 },
  );
}

/** The ids of one table case: a target of the event and a neighbour of each kind that must survive it. */
function world() {
  const tenant = newId("ten");
  const otherTenant = newId("ten");
  const account = newId("acc");
  const otherAccount = newId("acc");
  const amadeusAccount = newId("ama");
  const otherAmadeusAccount = newId("ama");
  const host = hostOf("book");
  const otherHost = hostOf("shop");
  const prefix = prefixOf("sk");
  const otherPrefix = prefixOf("pk");
  const plan = `plan_${newId("pl").slice(3, 13).toLowerCase()}`;
  // Every platform cache key of the world, and keys of other kinds that no invalidation may touch.
  const keys = {
    tenant: redisKeys.tenant(tenant),
    otherTenant: redisKeys.tenant(otherTenant),
    tenantKey: redisKeys.tenantByKey(`k${newId("tk").slice(3, 12).toLowerCase()}`),
    host: redisKeys.host(host),
    otherHost: redisKeys.host(otherHost),
    apiKey: redisKeys.apiKey(prefix),
    otherApiKey: redisKeys.apiKey(otherPrefix),
    member: redisKeys.member(account, tenant),
    memberOtherTenant: redisKeys.member(account, otherTenant),
    otherMember: redisKeys.member(otherAccount, tenant),
    connAmadeusTest: redisKeys.conn("amadeus", tenant, "test"),
    connAmadeusLive: redisKeys.conn("amadeus", tenant, "live"),
    connPaymentTest: redisKeys.conn("payment", tenant, "test"),
    connPaymentLive: redisKeys.conn("payment", tenant, "live"),
    otherConn: redisKeys.conn("amadeus", otherTenant, "test"),
    amadeusAccount: redisKeys.amadeusAccount(amadeusAccount),
    otherAmadeusAccount: redisKeys.amadeusAccount(otherAmadeusAccount),
    staffDenyAccount: redisKeys.staffDenyAccount(account),
    staffDenyTenant: redisKeys.staffDenyTenant(tenant),
    tenantData: redisKeys.sf(tenant, "test", "en"),
  } satisfies Record<string, RedisKey>;
  return { tenant, account, amadeusAccount, host, prefix, plan, keys };
}

type World = ReturnType<typeof world>;
type KeyName = keyof World["keys"];

/** platform architecture §6.3: each type, the event of a world, and the keys of that world it deletes. */
const CASES: ReadonlyArray<[string, (w: World) => InvalidationEvent, readonly KeyName[]]> = [
  ["tenant", (w) => ({ v: 1, type: "tenant", id: w.tenant }), ["tenant"]],
  ["domain", (w) => ({ v: 1, type: "domain", hostname: w.host }), ["host"]],
  ["api_key", (w) => ({ v: 1, type: "api_key", prefix: w.prefix }), ["apiKey"]],
  [
    "connection",
    (w) => ({ v: 1, type: "connection", tenantId: w.tenant }),
    ["connAmadeusTest", "connAmadeusLive", "connPaymentTest", "connPaymentLive"],
  ],
  ["membership", (w) => ({ v: 1, type: "membership", accountId: w.account, tenantId: w.tenant }), ["member"]],
  ["account", (w) => ({ v: 1, type: "account", accountId: w.account }), ["member", "memberOtherTenant"]],
  ["amadeus_account", (w) => ({ v: 1, type: "amadeus_account", id: w.amadeusAccount }), ["amadeusAccount"]],
  // No cache of the OTA backend holds plan data yet: the event changes nothing.
  ["plan", (w) => ({ v: 1, type: "plan", code: w.plan }), []],
];

/** Writes every key of the world, each with its TTL. */
async function seed(w: World): Promise<void> {
  for (const key of Object.values(w.keys)) {
    await redis.client.set(key.key, '{"v":1,"value":"seeded"}', "EX", key.ttlSeconds);
  }
}

/** The names of the world's keys that exist, in the order of `world()`. */
async function existing(w: World): Promise<KeyName[]> {
  const names: KeyName[] = [];
  for (const [name, key] of Object.entries(w.keys) as Array<[KeyName, RedisKey]>) {
    if ((await redis.client.exists(key.key)) === 1) {
      names.push(name);
    }
  }
  return names;
}

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  api = await createTestApp({ database: db, redis, imports: [TenancyModule.forApi()] });
});

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

describe("the vx:invalidate subscriber", () => {
  it("subscribes when the API starts", () => {
    expect(api.sink.records()).toContainEqual(
      expect.objectContaining({ level: 30, msg: "invalidation.subscribed", channel: INVALIDATION_CHANNEL }),
    );
  });

  it.each(CASES)("deletes exactly the keys of a %s event [OBE-012 AC3]", async (_type, eventOf, deleted) => {
    const w = world();
    await seed(w);
    const all = Object.keys(w.keys) as KeyName[];
    expect(await existing(w)).toEqual(all);

    await publish(eventOf(w));
    await drained();

    expect(await existing(w)).toEqual(all.filter((name) => !deleted.includes(name)));
  });

  it("refuses messages that are not valid events, changes nothing, and keeps listening", async () => {
    const w = world();
    await seed(w);
    const before = api.sink.records().length;
    // A whole key where a prefix belongs: built at run time, never written into a file (test/helpers/api-env.ts).
    const secret = newApiKey("sk", "live");

    await publish("not json {");
    await publish({ v: 2, type: "tenant", id: w.tenant } as unknown as InvalidationEvent);
    await publish({ v: 1, type: "tenant", id: w.tenant, extra: secret } as unknown as InvalidationEvent);
    await publish({ v: 1, type: "tenants", id: w.tenant } as unknown as InvalidationEvent);
    await publish({ v: 1, type: "api_key", prefix: secret } as unknown as InvalidationEvent);
    await drained();

    expect(await existing(w)).toEqual(Object.keys(w.keys));
    const refused = api.sink
      .records()
      .slice(before)
      .filter((line) => line["msg"] === "invalidation.refused");
    expect(refused.map((line) => [line["level"], line["reason"]])).toEqual([
      [40, "malformed_json"],
      [40, "invalid_event"],
      [40, "invalid_event"],
      [40, "invalid_event"],
      [40, "invalid_event"],
    ]);
    expect(refused[1]).toMatchObject({ issues: [{ path: "/v", keyword: "const" }] });
    expect(api.sink.text()).not.toContain(secret);

    await publish({ v: 1, type: "tenant", id: w.tenant });
    await drained();
    expect(await existing(w)).not.toContain("tenant");
  });

  it("subscribes again after losing its connection", async () => {
    const subscribed = () =>
      api.sink.records().filter((line) => line["msg"] === "invalidation.subscribed").length;
    const before = subscribed();
    const clients = String(await redis.client.call("CLIENT", "LIST", "TYPE", "pubsub"));
    const ours = clients
      .split("\n")
      .find(
        (line) =>
          line.includes(` name=${INVALIDATION_CONNECTION_NAME} `) && line.includes(` db=${redis.db} `),
      );
    const id = /\bid=(\d+)\b/.exec(ours ?? "")?.[1];
    expect(id).toBeDefined();

    await redis.client.call("CLIENT", "KILL", "ID", id ?? "");
    await vi.waitFor(() => expect(subscribed()).toBe(before + 1), { timeout: 5000, interval: 20 });

    const w = world();
    await seed(w);
    await publish({ v: 1, type: "api_key", prefix: w.prefix });
    await drained();
    expect(await existing(w)).not.toContain("apiKey");
  });
});

describe("a cache fill racing an invalidation", () => {
  it("is not written back, so the next lookup reads the committed row", async () => {
    const tenantId = newId("ten");
    await migrator
      .insertInto("platform.tenants")
      .values({
        id: tenantId,
        key: "racer",
        name: "Racer Travel",
        status: "active",
        plan_code: "early_access",
      })
      .execute();
    const cache = api.app.get(PlatformCache);
    const repository = api.app.get(PlatformReadRepository);
    const read = repository.tenantById.bind(repository);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let readEnded: () => void = () => undefined;
    const hasRead = new Promise<void>((resolveRead) => {
      readEnded = resolveRead;
    });
    const lookup = vi.spyOn(repository, "tenantById").mockImplementationOnce(async (id) => {
      const row = await read(id);
      readEnded();
      await gate;
      return row;
    });

    // The lookup has read the active row and not yet written it when the platform suspends and publishes. The test
    // waits for that read to end, not only to start: an UPDATE committed before the lookup's SELECT (its first query
    // in this file, so it opens a connection first) would hand it the suspended row, and nothing would race.
    const pending = cache.tenantById(tenantId);
    await hasRead;
    expect(lookup).toHaveBeenCalledOnce();
    await migrator
      .updateTable("platform.tenants")
      .set({ status: "suspended", suspension_reason: "admin" })
      .where("id", "=", tenantId)
      .execute();
    await publish({ v: 1, type: "tenant", id: tenantId });
    await drained();
    release();

    expect((await pending)?.status).toBe("active");
    expect(await redis.client.exists(redisKeys.tenant(tenantId).key)).toBe(0);
    expect((await cache.tenantById(tenantId))?.status).toBe("suspended");
    expect(await redis.client.exists(redisKeys.tenant(tenantId).key)).toBe(1);
  });
});
