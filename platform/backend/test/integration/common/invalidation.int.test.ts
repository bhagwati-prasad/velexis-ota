// The `vx:invalidate` publisher (PBE-009; platform/docs/architecture.md §4 and §6.3) against the real PostgreSQL 16 and
// Redis 7: an event published in a platform transaction reaches a subscriber only after COMMIT, and never when the
// transaction rolls back. The publisher is the API's own (RedisModule through createTestApp); the transactions run on
// this file's database clone as velexis_platform_app.
//
// Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same time.
// Every event here names a fresh tenant id, and the subscriber keeps only those.
import {
  INVALIDATION_CHANNEL,
  MessageValidationError,
  type InvalidationEvent,
} from "@velexis/api-types/jobs";
import {
  createPlatformDb,
  createPool,
  type Kysely,
  type PlatformDatabase,
  type Transaction,
} from "@velexis/db";
import { createLogger } from "@velexis/logger";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdGenerator } from "../../../src/common/ids";
import {
  InvalidationPublisher,
  NotInTransactionError,
  afterCommit,
  runInTransaction,
} from "../../../src/common/redis/invalidation.publisher";
import { buildTenant } from "../../builders/platform-rows";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

let t: TestApp;
let pool: ReturnType<typeof createPool>;
let db: Kysely<PlatformDatabase>;
let subscriber: Redis;
let publisher: InvalidationPublisher;
let ids: IdGenerator;

/** An event the subscriber received, and whether its tenant row was visible when it arrived (looked up then). */
interface Delivery {
  readonly event: InvalidationEvent;
  rowVisible?: boolean;
}

/**
 * The events of this file's tenants, in the order they arrived. An event is recorded the moment it arrives, before
 * the look-up of its row, so the order never depends on how fast the look-ups answer.
 */
const received: Delivery[] = [];
const waiters: Array<{ readonly id: string; readonly resolve: () => void }> = [];
const mine = new Set<string>();

/** A new tenant id that the subscriber keeps events for. */
function tenantId(): string {
  const id = ids.new("ten");
  mine.add(id);
  return id;
}

/** Resolves when the subscriber has received the event of tenant `id` and looked its row up. */
function eventOf(id: string): Promise<void> {
  if (
    received.some(
      ({ event, rowVisible }) => event.type === "tenant" && event.id === id && rowVisible !== undefined,
    )
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push({ id, resolve }));
}

function receivedIds(): string[] {
  return received.map(({ event }) => (event.type === "tenant" ? event.id : event.type));
}

async function tenantExists(id: string): Promise<boolean> {
  const row = await db.selectFrom("platform.tenants").select("id").where("id", "=", id).executeTakeFirst();
  return row !== undefined;
}

beforeAll(async () => {
  t = await createTestApp();
  ids = t.app.get(IdGenerator);
  publisher = t.app.get(InvalidationPublisher);
  pool = createPool(t.db.urlFor("platform"), {
    applicationName: "platform-invalidation-test",
    logger: createLogger({ app: "platform-test", env: "test", destination: new LogSink() }),
    max: 4,
  });
  db = createPlatformDb<PlatformDatabase>(pool);
  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-invalidation-test" });
  subscriber.on("message", (channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (channel !== INVALIDATION_CHANNEL || event.type !== "tenant" || !mine.has(event.id)) {
      return;
    }
    const delivery: Delivery = { event };
    received.push(delivery);
    void tenantExists(event.id).then((rowVisible) => {
      delivery.rowVisible = rowVisible;
      for (const waiter of waiters.filter((candidate) => candidate.id === event.id)) {
        waiter.resolve();
      }
    });
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
});

afterAll(async () => {
  await subscriber?.quit();
  await pool?.end();
  await t?.close();
});

describe("publishAfterCommit", () => {
  it("[PBE-009 AC2] delivers nothing of a transaction that rolls back", async () => {
    const rolledBack = tenantId();
    const marker = tenantId();

    await expect(
      runInTransaction(db, async (trx) => {
        await trx
          .insertInto("platform.tenants")
          .values(buildTenant({ id: rolledBack }))
          .execute();
        publisher.publishAfterCommit(trx, { v: 1, type: "tenant", id: rolledBack });
        throw new Error("the use case failed");
      }),
    ).rejects.toThrow("the use case failed");
    // Published after the rollback on the same channel: once it has arrived, an event of the rolled-back
    // transaction would have arrived before it (Redis delivers one publisher's messages in order).
    await publisher.publish({ v: 1, type: "tenant", id: marker });
    await eventOf(marker);

    expect(receivedIds()).not.toContain(rolledBack);
    expect(await tenantExists(rolledBack)).toBe(false);
  });

  it("[PBE-009 AC2] delivers the event to a subscriber after COMMIT, when the change is visible, and not before", async () => {
    const committed = tenantId();
    const duringTransaction = tenantId();

    await runInTransaction(db, async (trx) => {
      await trx
        .insertInto("platform.tenants")
        .values(buildTenant({ id: committed }))
        .execute();
      publisher.publishAfterCommit(trx, { v: 1, type: "tenant", id: committed });
      // An event sent at once, while the transaction is still open: it arrives, the deferred one does not.
      await publisher.publish({ v: 1, type: "tenant", id: duringTransaction });
      await eventOf(duringTransaction);
      expect(receivedIds()).not.toContain(committed);
    });
    await eventOf(committed);

    const delivered = received.find(({ event }) => event.type === "tenant" && event.id === committed);
    expect(delivered).toEqual({ event: { v: 1, type: "tenant", id: committed }, rowVisible: true });
    expect(receivedIds().indexOf(duringTransaction)).toBeLessThan(receivedIds().indexOf(committed));
  });

  it("sends each distinct event of a transaction once", async () => {
    const first = tenantId();
    const second = tenantId();
    const marker = tenantId();

    await runInTransaction(db, (trx) => {
      publisher.publishAfterCommit(trx, { v: 1, type: "tenant", id: first });
      publisher.publishAfterCommit(trx, { type: "tenant", id: first, v: 1 } as InvalidationEvent);
      publisher.publishAfterCommit(trx, { v: 1, type: "tenant", id: second });
      return Promise.resolve();
    });
    await publisher.publish({ v: 1, type: "tenant", id: marker });
    await eventOf(marker);

    expect(receivedIds().filter((id) => id === first || id === second)).toEqual([first, second]);
  });

  it("refuses an invalid event inside the transaction, so the change rolls back, without quoting the value", async () => {
    const id = tenantId();
    const secret = "sk_live_0123456789abcdef";

    const failure = runInTransaction(db, async (trx) => {
      await trx.insertInto("platform.tenants").values(buildTenant({ id })).execute();
      publisher.publishAfterCommit(trx, { v: 1, type: "tenant", id, secret } as unknown as InvalidationEvent);
    });

    await expect(failure).rejects.toThrow(MessageValidationError);
    await expect(failure).rejects.not.toThrow(secret);
    expect(await tenantExists(id)).toBe(false);
  });

  it("refuses a transaction that runInTransaction did not open, and one that has finished", async () => {
    const id = tenantId();
    const sent = tenantId();
    const late = tenantId();
    const marker = tenantId();
    let finished: Transaction<PlatformDatabase> | undefined;

    await db.transaction().execute((trx) => {
      expect(() => publisher.publishAfterCommit(trx, { v: 1, type: "tenant", id })).toThrow(
        NotInTransactionError,
      );
      return Promise.resolve();
    });
    await runInTransaction(db, (trx) => {
      finished = trx;
      // The transaction has collected an event: a later one must still be refused, not added to the sent batch.
      publisher.publishAfterCommit(trx, { v: 1, type: "tenant", id: sent });
      return Promise.resolve();
    });

    if (finished === undefined) {
      throw new Error("runInTransaction did not run its function");
    }
    const done = finished;
    expect(() => afterCommit(done, () => undefined)).toThrow(NotInTransactionError);
    expect(() => publisher.publishAfterCommit(done, { v: 1, type: "tenant", id: late })).toThrow(
      NotInTransactionError,
    );
    await publisher.publish({ v: 1, type: "tenant", id: marker });
    await eventOf(marker);
    expect(receivedIds().filter((received) => received === sent || received === late)).toEqual([sent]);
  });

  it("sends an event as it was when it was published, whatever the caller changes afterwards", async () => {
    const original = tenantId();
    const changed = tenantId();
    const marker = tenantId();

    await runInTransaction(db, (trx) => {
      const event = { v: 1 as const, type: "tenant" as const, id: original };
      publisher.publishAfterCommit(trx, event);
      event.id = changed;
      return Promise.resolve();
    });
    await publisher.publish({ v: 1, type: "tenant", id: marker });
    await eventOf(marker);

    expect(receivedIds().filter((id) => id === original || id === changed)).toEqual([original]);
  });

  it("logs a Redis failure after the commit and keeps the change", async () => {
    const id = tenantId();
    const logs = new LogSink();
    const broken = new InvalidationPublisher(
      { publish: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1")) },
      createLogger({ app: "platform-test", env: "test", destination: logs }),
    );

    await runInTransaction(db, async (trx) => {
      await trx.insertInto("platform.tenants").values(buildTenant({ id })).execute();
      broken.publishAfterCommit(trx, { v: 1, type: "tenant", id });
    });

    expect(await tenantExists(id)).toBe(true);
    expect(logs.withMessage("invalidation.publish_failed")).toEqual([
      expect.objectContaining({ level: 40, type: "tenant", err: expect.objectContaining({ type: "Error" }) }),
    ]);
  });

  it("runs afterCommit work once committed, and throws its error although the change stays committed", async () => {
    const id = tenantId();
    const order: string[] = [];

    const outcome = runInTransaction(db, async (trx) => {
      await trx.insertInto("platform.tenants").values(buildTenant({ id })).execute();
      afterCommit(trx, () => {
        order.push("first");
        throw new Error("enqueue failed");
      });
      afterCommit(trx, () => {
        order.push("second");
      });
      order.push("transaction");
    });

    await expect(outcome).rejects.toThrow("enqueue failed");
    expect(order).toEqual(["transaction", "first", "second"]);
    expect(await tenantExists(id)).toBe(true);
  });
});
