// The cache invalidation events of the platform (PBE-009; platform/docs/architecture.md §4 and §6.3, PADR-0016
// item 3). The OTA backend caches platform rows for 60 s (tenants, domains, API keys, connections, memberships,
// accounts, Amadeus accounts, plans) and drops a cached row when an event about it arrives on the Redis channel
// `vx:invalidate`. An event is `{ v: 1, type, …ids }`, validated with `validateInvalidation` of
// `@velexis/api-types/jobs` before it is sent: never a secret, never a row value.
//
// A change is published only after it is committed (architecture §4): an event sent before the commit lets the OTA
// reload the old row and cache it again, and an event of a change that rolls back is noise. So a service opens its
// transaction with `runInTransaction` and calls `publishAfterCommit(trx, event)` inside it:
//
//   await runInTransaction(platformDb, async (trx) => {
//     await keys.revoke(trx, keyId);
//     await audit.record(trx, { action: "api_key.revoked", … });
//     publisher.publishAfterCommit(trx, { v: 1, type: "api_key", prefix });
//   });
//
// The events of a transaction are sent once COMMIT has succeeded, each distinct event once; a rollback (fn throws,
// or COMMIT fails) drops them. An invalid event throws at once, inside the transaction, so the bug rolls the change
// back instead of committing it unannounced. `afterCommit(trx, work)` is the same hook for other work that must wait
// for the commit (enqueueing a job, PADR-0001 item 3). `publish(event)` sends at once, for code without a transaction.
//
// A lost event is not an error: the change is committed, and the OTA's 60 s TTL bounds the delay. A Redis failure
// while publishing is logged as `invalidation.publish_failed` (warn, with the event type) and never fails the request.
import { INVALIDATION_CHANNEL, validateInvalidation, type InvalidationEvent } from "@velexis/api-types/jobs";
import type { Kysely, Transaction } from "@velexis/db";
import type { Redis } from "ioredis";

/** Work that waits for the commit of a transaction. */
export type AfterCommitWork = () => Promise<void> | void;

/** The work registered on each open transaction of `runInTransaction`, by the transaction object. */
const AFTER_COMMIT = new WeakMap<object, AfterCommitWork[]>();

/** `afterCommit` or `publishAfterCommit` got a transaction that `runInTransaction` did not open (or has finished). */
export class NotInTransactionError extends Error {
  override readonly name = "NotInTransactionError";

  constructor(caller: string) {
    super(
      `${caller}: pass the open transaction of runInTransaction (its commit is what the work waits for); ` +
        "a transaction opened another way, or one that has finished, cannot be followed",
    );
  }
}

/**
 * Runs `fn` in one transaction of `db` (`db.transaction().execute`). When the transaction has committed, runs the
 * work that `fn` registered with `afterCommit(trx, …)` (and `publishAfterCommit`), in order, and resolves with `fn`'s
 * result. When `fn` throws or COMMIT fails, the transaction rolls back, the work is dropped, and the error is rethrown.
 * A piece of work that throws does not stop the others; the error (an `AggregateError` for several) is rethrown after
 * all of them ran, although the transaction stays committed.
 */
export async function runInTransaction<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const work: AfterCommitWork[] = [];
  const result = await db.transaction().execute(async (trx) => {
    AFTER_COMMIT.set(trx, work);
    try {
      return await fn(trx);
    } finally {
      // Nothing can be registered once `fn` has returned: the commit is under way.
      AFTER_COMMIT.delete(trx);
    }
  });
  const failures: unknown[] = [];
  for (const item of work) {
    try {
      await item();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "work after the commit failed");
  }
  return result;
}

/**
 * Registers `work` to run after the commit of `trx`, an open transaction of `runInTransaction`. Throws
 * `NotInTransactionError` for any other transaction.
 */
export function afterCommit<DB>(trx: Transaction<DB>, work: AfterCommitWork): void {
  const queue = AFTER_COMMIT.get(trx);
  if (queue === undefined) {
    throw new NotInTransactionError("afterCommit");
  }
  queue.push(work);
}

/** What the publisher logs with: pino's call shape, so `PinoLogger` and a pino logger both fit. */
export interface PublisherLogger {
  warn(object: Record<string, unknown>, message: string): void;
}

/** The events collected in each open transaction, by the transaction object, each distinct event once. */
const PENDING = new WeakMap<object, Map<string, InvalidationEvent>>();

/** One text per distinct event, whatever the order of its properties. */
function identity(event: InvalidationEvent): string {
  return JSON.stringify(Object.entries(event).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Publishes `vx:invalidate` events (see the file header). RedisModule provides it with the process's command client.
 */
export class InvalidationPublisher {
  constructor(
    private readonly client: Pick<Redis, "publish">,
    private readonly logger: PublisherLogger,
  ) {}

  /**
   * Validates `event` now (a `MessageValidationError` naming paths and rules, never values) and publishes it once the
   * transaction `trx` of `runInTransaction` has committed. The same event twice in one transaction is sent once.
   */
  publishAfterCommit<DB>(trx: Transaction<DB>, event: InvalidationEvent): void {
    // Checked first, also when the transaction already collected events: once `fn` has returned, the events may
    // have been sent already, and a late one would be lost without a word.
    if (!AFTER_COMMIT.has(trx)) {
      throw new NotInTransactionError("publishAfterCommit");
    }
    const valid = validateInvalidation(event);
    let pending = PENDING.get(trx);
    if (pending === undefined) {
      const events = new Map<string, InvalidationEvent>();
      afterCommit(trx, () => this.publishAll([...events.values()]));
      PENDING.set(trx, events);
      pending = events;
    }
    // A copy: the event is sent as it was validated, whatever the caller does with its object afterwards.
    pending.set(identity(valid), { ...valid });
  }

  /**
   * Validates and publishes `event` at once. Resolves to `true` when Redis took it, `false` after logging a Redis
   * failure; rejects only on an invalid event.
   */
  async publish(event: InvalidationEvent): Promise<boolean> {
    const valid = validateInvalidation(event);
    try {
      await this.client.publish(INVALIDATION_CHANNEL, JSON.stringify(valid));
      return true;
    } catch (error) {
      this.logger.warn({ err: error, type: valid.type }, "invalidation.publish_failed");
      return false;
    }
  }

  private async publishAll(events: readonly InvalidationEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }
}
