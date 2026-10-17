// `api_keys.flush_usage` (PBE-021; PADR-0005 item 10, flows/api-keys.md step 8): the worker's module graph
// (WorkerModule, as dist/worker.js builds it, with the FakeClock of the API) on this file's database clone and Redis
// database moves the `apikey:used:<keyId>` counters the OTA backend writes into `last_used_at` and `last_used_ip`, and
// the portal's list shows the last use. The job runs through the `platform-maintenance` queue and its one processor,
// as the job scheduler would start it, or by calling the handler. The worker's job schedulers are not registered here
// (JobSchedulerRegistry is replaced), so no run starts on its own during a test.
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { expectResponseToMatch } from "@velexis/testing";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_KEYS_FLUSH_USAGE_JOB,
  USAGE_FLUSH_BATCH_SIZE,
  UsageFlushProcessor,
} from "../../../src/api-keys/usage-flush.processor";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { redisKeys, setKey } from "../../../src/common/redis/redis-keys";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import { insertAccount, insertRow, testId } from "../../builders/platform-rows";
import { insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/** Starting the API and the worker's module graph takes seconds; the bound allows for a loaded 4-CPU CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish a job. */
const WAIT_MS = 20_000;
const HOUR_MS = 60 * 60 * 1000;

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let flush: UsageFlushProcessor;
let maintenance: Queue;
let tenantId: string;
let ownerId: string;
const workerLogs = new LogSink();
let nextKey = 1;

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  flush = worker.get(UsageFlushProcessor, { strict: false });
  maintenance = worker.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
  ownerId = (await insertAccount(pool)).id;
  tenantId = (await insertOta(pool, { members: [[{ id: ownerId }, "owner"]] })).tenant.id;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

/** A key row of the OTA, as createApiKey writes it (the hash is a placeholder: no key is verified here). */
async function insertKey(overrides: Record<string, unknown> = {}): Promise<string> {
  const n = nextKey++;
  const row = await insertRow(pool, "api_keys", {
    id: testId("key", n),
    tenant_id: tenantId,
    name: `Key ${n}`,
    kind: "secret",
    environment: "test",
    prefix: `sk_test_${String(n).padStart(6, "0")}`,
    key_hash: n.toString(16).padStart(64, "0"),
    last4: "Ab12",
    scopes: ["storefront"],
    created_by_account_id: ownerId,
    ...overrides,
  });
  return row.id;
}

/** Writes the counter of `keyId` as the OTA backend does (`{at, ip}`, 1 day). */
async function used(keyId: string, value: unknown): Promise<void> {
  await setKey(
    t.redis.client,
    redisKeys.apiKeyUsed(keyId),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

async function lastUse(keyId: string): Promise<{ at: string | null; ip: string | null }> {
  const { rows } = await pool.query(
    "SELECT last_used_at, host(last_used_ip) AS ip FROM platform.api_keys WHERE id = $1",
    [keyId],
  );
  const row = rows[0] as { last_used_at: Date | null; ip: string | null };
  return { at: row.last_used_at?.toISOString() ?? null, ip: row.ip };
}

const counterOf = (keyId: string): Promise<string | null> =>
  t.redis.client.get(redisKeys.apiKeyUsed(keyId).key);

describe("api_keys.flush_usage", () => {
  it("[PBE-021 AC5] moves a counter written to Redis into last_used_at at the next flush, and the portal shows it", async () => {
    const keyId = await insertKey();
    const at = new Date(t.clock.now().getTime() - 2 * 60 * 1000).toISOString();
    await used(keyId, { at, ip: "203.0.113.9" });

    // The run the job scheduler starts every 5 minutes: a job named after the schedule on `platform-maintenance`.
    const job = await maintenance.add(API_KEYS_FLUSH_USAGE_JOB, {});
    const deadline = Date.now() + WAIT_MS;
    while ((await job.getState()) !== "completed") {
      expect(Date.now(), "the flush job to complete").toBeLessThan(deadline);
      await new Promise((done) => setTimeout(done, 50));
    }

    expect(await lastUse(keyId)).toEqual({ at, ip: "203.0.113.9" });
    expect(await counterOf(keyId)).toBeNull();
    const { token } = await t.app.get(TokenService).sign({
      aud: "portal",
      sub: ownerId,
      sid: testId("asn", 1),
      ev: true,
      amr: ["pwd"],
    });
    const list = await t.http
      .get(`/v1/tenants/${tenantId}/api-keys`)
      .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders("203.0.113.7") });
    expect(list.status).toBe(200);
    expectResponseToMatch("listApiKeys", list, { document: "platform" });
    expect((list.body as { data: Array<{ id: string; lastUsedAt: string | null }> }).data).toContainEqual(
      expect.objectContaining({ id: keyId, lastUsedAt: at }),
    );
  });

  it("parses {at, ip}, keeps the latest use, drops what is no counter, and looks at keys revoked or expired within a day", async () => {
    const now = t.clock.now().getTime();
    const iso = await insertKey();
    const epoch = await insertKey();
    const garbage = await insertKey();
    const newer = await insertKey({ last_used_at: new Date(now - 60 * 1000), last_used_ip: "198.51.100.1" });
    const revokedLately = await insertKey({ revoked_at: new Date(now - 2 * HOUR_MS) });
    const revokedLongAgo = await insertKey({ revoked_at: new Date(now - 25 * HOUR_MS) });
    const expiredLongAgo = await insertKey({ expires_at: new Date(now - 25 * HOUR_MS) });
    const unused = await insertKey();
    const earlier = new Date(now - 10 * 60 * 1000);
    await used(iso, { at: earlier.toISOString(), ip: "2001:db8::7" });
    await used(epoch, { at: earlier.getTime(), ip: "not an address" });
    await used(garbage, "secret-value-of-a-broken-counter");
    await used(newer, { at: earlier.toISOString(), ip: "203.0.113.20" });
    await used(revokedLately, { at: earlier.toISOString(), ip: "203.0.113.21" });
    await used(revokedLongAgo, { at: earlier.toISOString(), ip: "203.0.113.22" });
    await used(expiredLongAgo, { at: earlier.toISOString(), ip: "203.0.113.23" });

    const result = await flush.run();

    expect(result).toMatchObject({ taken: 5, updated: 3, discarded: 1 });
    expect(await lastUse(iso)).toEqual({ at: earlier.toISOString(), ip: "2001:db8::7" });
    expect(await lastUse(epoch)).toEqual({ at: earlier.toISOString(), ip: null });
    expect(await lastUse(garbage)).toEqual({ at: null, ip: null });
    expect(await lastUse(newer)).toEqual({ at: new Date(now - 60 * 1000).toISOString(), ip: "198.51.100.1" });
    expect(await lastUse(revokedLately)).toEqual({ at: earlier.toISOString(), ip: "203.0.113.21" });
    expect(await lastUse(unused)).toEqual({ at: null, ip: null });
    // Counters live one day: the keys revoked or expired before were not looked at, and their counters expire.
    expect(await lastUse(revokedLongAgo)).toEqual({ at: null, ip: null });
    expect(await counterOf(revokedLongAgo)).not.toBeNull();
    expect(await counterOf(expiredLongAgo)).not.toBeNull();
    for (const keyId of [iso, epoch, garbage, newer, revokedLately]) {
      expect(await counterOf(keyId), keyId).toBeNull();
    }
    const lines = [...t.logs.lines, ...workerLogs.lines];
    expect(lines.filter((line) => line["msg"] === "api_keys.usage_discarded")).toEqual([
      expect.objectContaining({ keyId: garbage }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret-value-of-a-broken-counter");

    // A second run finds nothing to move.
    expect(await flush.run()).toMatchObject({ taken: 0, updated: 0, discarded: 0 });
  });

  it(`reads the keys in pages of ${USAGE_FLUSH_BATCH_SIZE}`, async () => {
    // More keys than one page, written in one statement.
    const first = nextKey;
    const count = USAGE_FLUSH_BATCH_SIZE + 5;
    nextKey += count;
    const numbers = Array.from({ length: count }, (_, index) => first + index);
    await pool.query(
      `INSERT INTO platform.api_keys (id, tenant_id, name, kind, environment, prefix, key_hash, last4, scopes)
       SELECT u.id, $1, 'Bulk ' || u.n, 'secret', 'test', 'sk_test_' || lpad(u.n::text, 6, '0'),
              lpad(to_hex(u.n), 64, '0'), 'Ab12', '{storefront}'
       FROM unnest($2::text[], $3::int[]) AS u(id, n)`,
      [tenantId, numbers.map((n) => testId("key", n)), numbers],
    );
    const firstId = testId("key", first);
    const lastId = testId("key", first + count - 1);
    const at = new Date(t.clock.now().getTime() - 60 * 1000).toISOString();
    await used(firstId, { at, ip: "203.0.113.30" });
    await used(lastId, { at, ip: "203.0.113.31" });

    const result = await flush.run();

    expect(result.checked).toBeGreaterThan(USAGE_FLUSH_BATCH_SIZE);
    expect(result).toMatchObject({ taken: 2, updated: 2 });
    expect(await lastUse(firstId)).toEqual({ at, ip: "203.0.113.30" });
    expect(await lastUse(lastId)).toEqual({ at, ip: "203.0.113.31" });
  });
});
