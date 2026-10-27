// The lock of one Stripe subscription's sync (FIX-W30-PLATFORM; lead decision (2) of 2026-10-26, PADR-0002 item 5
// revision of 2026-10-26, subscription-billing flow §D). The worker runs two billing events at a time
// (`platform-stripe-events`, concurrency 2), and each handler re-fetches the subscription from Stripe before its
// transaction. Without a lock, two events of one subscription whose re-fetches overlap could let the older answer
// commit after the newer one and leave the older state. So every billing-sync path that re-fetches a Stripe
// subscription and writes it into its row (`customer.subscription.*` and `checkout.session.completed`; the admin's
// resync, which PBE-048 adds, is to take it too) runs inside `SubscriptionSyncLock.run(<sub_…>, …)`, which serialises
// them per subscription:
//
// 1. Before the re-fetch, take `vx:stripe:sub:<sub_…>:lock` (redis-keys.ts: `SET … EX 15 NX` with a random token).
//    While another event holds it, try again every 100 ms for at most 30 s (`billing.sync_lock_waiting` is logged
//    once). Then the event fails with the retryable `SUBSCRIPTION_BUSY` (`billing.sync_lock_busy`) and BullMQ runs it
//    again later (5 attempts, backoff from 30 s), so no job waits for ever in a worker slot.
// 2. While the work runs, renew the lock every 5 s with this holder's token (`extendKeyIfValue`), as the idempotency
//    lock does (idempotency.interceptor.ts). A renewal that finds the lock gone or another holder's logs
//    `billing.sync_lock_lost` and stops; a Redis error is logged (`billing.sync_lock_renew_failed`) and the next
//    renewal tries again.
// 3. `confirm()`, called in the write's transaction just before it commits, renews the lock once more, and fails the
//    event with the retryable `SUBSCRIPTION_LOCK_LOST` (the transaction rolls back) when the lock is no longer this
//    holder's. The write therefore commits while the lock is held, with its full 15 s ahead: an event that takes the
//    lock after it re-fetches after that commit, and Stripe answers it the state it has then, never an older one.
// 4. After the work (the commit and what runs after it), release the lock (`deleteKeyIfValue`: only this holder's).
//
// The lock comes before every database lock of billing sync (flow §D, the lock order), so a waiting event holds no
// transaction and no row and never takes part in a deadlock. Redis failing while the lock is taken or confirmed fails
// the event, which BullMQ retries; a failed release is logged and the lock expires 15 s after its last renewal. Logs
// carry the event id and the Stripe subscription id, never a token.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  deleteKeyIfValue,
  extendKeyIfValue,
  redisKeys,
  setKeyIfAbsent,
  STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS,
  type RedisKey,
  type RedisWriter,
} from "../../common/redis/redis-keys";
import { REDIS_CLIENT } from "../../common/redis/redis.module";
import { StripeEventFailure } from "../../common/stripe/stripe-inbox.service";

/** The longest an event waits for the lock of its subscription before it fails with `SUBSCRIPTION_BUSY`. */
export const SUBSCRIPTION_LOCK_WAIT_MS = 30_000;
/**
 * How often the holder renews the lock while its work runs: a third of its 15 s TTL, so two renewals in a row may fail
 * or come late before the lock can expire under running work.
 */
export const SUBSCRIPTION_LOCK_RENEW_MS = (STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS * 1000) / 3;
/** How often a waiting event tries the lock again. */
export const SUBSCRIPTION_LOCK_POLL_MS = 100;

/** What the lock's log lines name besides the subscription. */
export interface SubscriptionLockContext {
  /** The Stripe event whose processing holds or waits for the lock. */
  readonly eventId: string;
}

/** The lock as its holder's work sees it. */
export interface HeldSubscriptionLock {
  /** Stripe's `sub_…` the lock is held for. */
  readonly subscriptionId: string;
  /**
   * Renews the lock once more; throws StripeEventFailure `SUBSCRIPTION_LOCK_LOST` (retryable) when it is no longer this
   * holder's. Called in the write's transaction just before its commit (file header, item 3).
   */
  confirm(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** See the file header. */
@Injectable()
export class SubscriptionSyncLock {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisWriter,
    @InjectPinoLogger(SubscriptionSyncLock.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Runs `work` while this process holds the lock of the Stripe subscription `subscriptionId`, and answers what it
   * answers (file header). Throws StripeEventFailure `SUBSCRIPTION_BUSY` (retryable) when the lock stayed another
   * event's for SUBSCRIPTION_LOCK_WAIT_MS; `work` has not run then.
   */
  async run<T>(
    subscriptionId: string,
    context: SubscriptionLockContext,
    work: (lock: HeldSubscriptionLock) => Promise<T>,
  ): Promise<T> {
    const key = redisKeys.stripeSubscriptionLock(subscriptionId);
    const line = { eventId: context.eventId, providerSubscriptionId: subscriptionId };
    const token = randomUUID();
    await this.acquire(key, token, line);
    const renewal = this.keepLocked(key, token, line);
    try {
      return await work({ subscriptionId, confirm: () => this.confirm(key, token, line) });
    } finally {
      renewal.stop();
      await this.release(key, token, line);
    }
  }

  /** Item 1 of the file header: the lock, or `SUBSCRIPTION_BUSY` after SUBSCRIPTION_LOCK_WAIT_MS. */
  private async acquire(key: RedisKey, token: string, line: Record<string, string>): Promise<void> {
    const deadline = Date.now() + SUBSCRIPTION_LOCK_WAIT_MS;
    let waiting = false;
    for (;;) {
      if (await setKeyIfAbsent(this.redis, key, token)) {
        return;
      }
      if (!waiting) {
        waiting = true;
        this.logger.info(line, "billing.sync_lock_waiting");
      }
      if (Date.now() >= deadline) {
        this.logger.warn(line, "billing.sync_lock_busy");
        throw new StripeEventFailure(
          "SUBSCRIPTION_BUSY",
          `another event of the subscription held its lock for ${SUBSCRIPTION_LOCK_WAIT_MS / 1000} s`,
          { retryable: true },
        );
      }
      await sleep(SUBSCRIPTION_LOCK_POLL_MS);
    }
  }

  /**
   * Item 2 of the file header: renews the lock every SUBSCRIPTION_LOCK_RENEW_MS until `stop()`. One renewal at a time:
   * the next is scheduled when the previous one has answered.
   */
  private keepLocked(key: RedisKey, token: string, line: Record<string, string>): { stop(): void } {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = async (): Promise<void> => {
      let held = true;
      try {
        held = await extendKeyIfValue(this.redis, key, token);
      } catch (error) {
        this.logger.warn({ ...line, err: error }, "billing.sync_lock_renew_failed");
      }
      if (stopped) {
        return;
      }
      if (!held) {
        this.logger.warn(line, "billing.sync_lock_lost");
        return;
      }
      schedule();
    };
    const schedule = (): void => {
      timer = setTimeout(() => void renew(), SUBSCRIPTION_LOCK_RENEW_MS);
      // The job in flight keeps the process up, not its renewal timer.
      timer.unref();
    };
    schedule();
    return {
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }

  /** Item 3 of the file header. */
  private async confirm(key: RedisKey, token: string, line: Record<string, string>): Promise<void> {
    if (!(await extendKeyIfValue(this.redis, key, token))) {
      this.logger.warn(line, "billing.sync_lock_lost");
      throw new StripeEventFailure(
        "SUBSCRIPTION_LOCK_LOST",
        "the lock of the subscription expired before the write committed",
        { retryable: true },
      );
    }
  }

  /** Item 4 of the file header; a failure is logged, and the lock expires on its own. */
  private async release(key: RedisKey, token: string, line: Record<string, string>): Promise<void> {
    try {
      await deleteKeyIfValue(this.redis, key, token);
    } catch (error) {
      this.logger.warn({ ...line, err: error }, "billing.sync_lock_release_failed");
    }
  }
}
