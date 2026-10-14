// useRedis (X-015; ADR-0015 "Dependencies in tests"): one Redis database per Vitest worker, emptied when a test file
// starts using it. Database 0 stays the developer's (`REDIS_URL=…/0` in .env.example); workers use 1 to 15.
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { Redis } from "ioredis";

/** Redis databases 1 to 15 are for tests; 0 is left to `pnpm dev`. */
export const REDIS_TEST_DATABASES = 15;

export interface TestRedis {
  /** A connected `ioredis` client on the worker's database. */
  readonly client: Redis;
  /**
   * REDIS_URL with the worker's database index as its path (`redis://:…@127.0.0.1:6379/3`), for the code under test.
   * It carries the password: never log or print it.
   */
  readonly url: string;
  /** The database index, `1 + (VITEST_POOL_ID % 15)`. */
  readonly db: number;
  /** Closes the client (`QUIT`). Idempotent. Call it in `afterAll`. */
  close(): Promise<void>;
}

/** The Redis database of a Vitest worker: `1 + (poolId % 15)`, so 1 to 15 and never 0. */
export function redisDatabaseIndex(poolId: number): number {
  if (!Number.isSafeInteger(poolId) || poolId < 0) {
    throw new RangeError("VITEST_POOL_ID must be a non-negative integer");
  }
  return 1 + (poolId % REDIS_TEST_DATABASES);
}

/** `url` with the database index `db` as its path; everything else (password, host, port, query) unchanged. */
export function redisUrlWithDatabase(url: string, db: number): string {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

/**
 * REDIS_URL and VITEST_POOL_ID through @velexis/config: the real environment (CI services; Vitest sets
 * VITEST_POOL_ID in every worker), else the `.env.local` files (local development). Never printed.
 */
function redisEnv(): { readonly url: string; readonly poolId: number } {
  loadDevEnvFiles({ appDir: process.cwd() });
  const config = defineConfig({
    REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
    VITEST_POOL_ID: env.int({ min: 0 }),
  });
  return { url: config.REDIS_URL, poolId: config.VITEST_POOL_ID };
}

/**
 * Connects to the worker's Redis database (`1 + (VITEST_POOL_ID % 15)`) and runs `FLUSHDB`, so the test file starts
 * with an empty database. Call it once per test file, in `beforeAll`, and `close()` the result in `afterAll`:
 *
 *   let redis: TestRedis;
 *   beforeAll(async () => { redis = await useRedis(); });
 *   afterAll(() => redis.close());
 *
 * A worker runs its files one after another, so two files never share a database at the same time. Database 0 (the
 * developer's `pnpm dev`) is never used.
 */
export async function useRedis(): Promise<TestRedis> {
  const { url: baseUrl, poolId } = redisEnv();
  const db = redisDatabaseIndex(poolId);
  const url = redisUrlWithDatabase(baseUrl, db);
  // Fail fast in tests: a command is retried once after a lost connection, then it fails.
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectionName: "velexis-testing",
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // Already gone (the test quit the client itself): `end` was emitted before and will not come again.
    if (client.status === "end") {
      return;
    }
    // Resolve once the connection is really gone (status `end`), so no socket outlives the test file.
    const ended = new Promise<void>((resolve) => client.once("end", () => resolve()));
    await client.quit().catch(() => client.disconnect());
    await ended;
  };
  try {
    await client.connect();
    await client.flushdb();
  } catch (error) {
    closed = true;
    client.disconnect();
    throw error;
  }
  return Object.freeze({ client, url, db, close });
}
