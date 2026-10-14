// Integration test of useRedis (X-015 step 4) on Redis 7: the worker's database index, FLUSHDB when a file starts,
// and the URL handed to the code under test. It needs REDIS_URL (root .env.example, CI services).
//
// Other test runs on the same Redis server may flush databases 1 to 15 at any time, so the assertions only rely on
// what such a flush cannot fake: a key that disappears, and the database a connection is on.
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redisDatabaseIndex, redisUrlWithDatabase, useRedis, type TestRedis } from "../../src/index.js";

/** The `db=` field of `CLIENT INFO`: the database a connection is on. */
async function databaseOf(client: Redis): Promise<number> {
  const info = String(await client.call("CLIENT", "INFO"));
  const db = /(?:^| )db=(\d+)(?: |$)/.exec(info)?.[1];
  if (db === undefined) {
    throw new Error("CLIENT INFO has no db field");
  }
  return Number(db);
}

describe("useRedis", () => {
  // Read the way useRedis reads them: the environment, else the .env.local files.
  const config = () => {
    loadDevEnvFiles({ appDir: process.cwd() });
    return defineConfig({
      REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
      VITEST_POOL_ID: env.int({ min: 0 }),
    });
  };
  let redis: TestRedis;
  let staleKeyBefore: number;

  beforeAll(async () => {
    // A key left in this worker's database by an earlier file, before useRedis runs.
    const { REDIS_URL, VITEST_POOL_ID } = config();
    const earlier = new Redis(redisUrlWithDatabase(REDIS_URL, redisDatabaseIndex(VITEST_POOL_ID)));
    try {
      await earlier.set("velexis:testing:stale", "1");
      staleKeyBefore = await earlier.exists("velexis:testing:stale");
    } finally {
      await earlier.quit();
    }
    redis = await useRedis();
  });

  afterAll(async () => {
    await redis?.close();
  });

  it("uses database 1 + (VITEST_POOL_ID % 15) and empties it when the file starts", async () => {
    const { VITEST_POOL_ID } = config();
    expect(redis.db).toBe(1 + (VITEST_POOL_ID % 15));
    expect(redis.db).toBeGreaterThanOrEqual(1);
    expect(await databaseOf(redis.client)).toBe(redis.db);
    expect(staleKeyBefore).toBe(1);
    expect(await redis.client.exists("velexis:testing:stale")).toBe(0);
  });

  it("returns the URL of that database for the code under test", async () => {
    const { REDIS_URL } = config();
    expect(new URL(redis.url).pathname).toBe(`/${redis.db}`);
    expect(redis.url).toBe(redisUrlWithDatabase(REDIS_URL, redis.db));
    const app = new Redis(redis.url);
    try {
      expect(await databaseOf(app)).toBe(redis.db);
    } finally {
      await app.quit();
    }
  });

  it("closes the client once, however often close() is called", async () => {
    const extra = await useRedis();
    await extra.close();
    await extra.close();
    expect(extra.client.status).toBe("end");
    expect(redis.client.status).toBe("ready");
  });

  it("close() resolves when the test already quit the client itself", async () => {
    const extra = await useRedis();
    const ended = new Promise<void>((resolve) => extra.client.once("end", () => resolve()));
    await extra.client.quit();
    await ended;
    expect(extra.client.status).toBe("end");
    await expect(extra.close()).resolves.toBeUndefined();
  });
});
