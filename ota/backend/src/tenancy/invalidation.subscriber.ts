// The `vx:invalidate` subscriber of the API and the worker (OADR-0009 point 4, platform architecture §6.3, OBE-012,
// OBE-024; see the last paragraph). The platform
// publishes `{v: 1, type, …ids}` after the commit of every change to a row the OTA backend caches; this subscriber
// validates each message with `validateInvalidation` (@velexis/api-types/jobs) and has the platform cache delete
// exactly the keys of its type (`invalidatedKeys` of platform-cache.ts): tenant, domain, api_key, connection,
// membership, account, amadeus_account and plan.
//
// It holds a Redis connection of its own (`ota-backend-invalidation`): a connection in subscriber mode can run no
// other command, so the deletions go through the process's command client. Messages are applied one after another,
// in the order they arrive. A message that is not valid JSON or not a valid event is refused (`invalidation.refused`,
// with the failing paths, never the content) and changes nothing.
//
// Pub/sub delivers only to connected subscribers, so a message published while this connection is down is lost; the
// 60 s TTL of every cached key bounds the staleness (platform architecture §6.3). The connection reconnects in the
// background like the others (redis.module.ts) and subscribes again each time it is ready. At start-up the API waits
// for the first connection attempt (at most 2.5 s): from then on it either listens or logs why it does not, and a
// Redis that is down does not stop it from serving (cached lookups fall back to PostgreSQL).
//
// The cache lives in Redis, which every process shares, so one subscriber would delete every key; but each process
// guards its own cache fills against invalidations that arrive meanwhile (platform-cache.ts), so each process that
// fills the cache runs one: the API, and since OBE-024 the worker, whose jobs resolve their tenant through
// `tenant:<id>` (OADR-0014 point 5). Deleting a key twice is harmless. Provisioning still reads the platform tables
// directly: it wants the current row.
import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  INVALIDATION_CHANNEL,
  MessageValidationError,
  validateInvalidation,
  type InvalidationEvent,
} from "@velexis/api-types/jobs";
import type { Redis, RedisOptions } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import {
  closeRedisConnection,
  commandClientOptions,
  createRedisConnection,
} from "../common/redis/redis.module";
import type { SharedConfig } from "../config";
import { PlatformCache } from "./platform-cache";

/** `CLIENT SETNAME` of the subscriber connection. */
export const INVALIDATION_CONNECTION_NAME = "ota-backend-invalidation";

/** How long start-up waits for the first connection attempt of the subscriber. */
const FIRST_ATTEMPT_TIMEOUT_MS = 2500;

/** The command client's options, under its own name; it subscribes again on every `ready` itself. */
export function subscriberOptions(): RedisOptions {
  return { ...commandClientOptions(), connectionName: INVALIDATION_CONNECTION_NAME, autoResubscribe: false };
}

@Injectable()
export class InvalidationSubscriber implements OnApplicationBootstrap, OnApplicationShutdown {
  private client: Redis | undefined;
  /** The messages applied so far, one after another. */
  private applying: Promise<void> = Promise.resolve();
  /** Resolves the start-up wait once the first attempt has ended (subscribed, failed, or timed out). */
  private firstAttemptEnded: () => void = () => undefined;

  constructor(
    private readonly config: ConfigService<SharedConfig, true>,
    private readonly cache: PlatformCache,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(InvalidationSubscriber.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    const client = createRedisConnection(
      this.config.get("REDIS_URL", { infer: true }),
      subscriberOptions(),
      this.logger,
    );
    this.client = client;
    client.on("message", (channel: string, message: string) => {
      if (channel === INVALIDATION_CHANNEL) {
        this.applying = this.applying.then(() => this.apply(message));
      }
    });
    client.on("ready", () => {
      void this.subscribe(client);
    });
    const firstAttempt = new Promise<void>((resolveAttempt) => {
      const timer = setTimeout(ended, FIRST_ATTEMPT_TIMEOUT_MS);
      function ended(): void {
        clearTimeout(timer);
        client.off("error", ended);
        client.off("end", ended);
        resolveAttempt();
      }
      client.once("error", ended);
      client.once("end", ended);
      this.firstAttemptEnded = ended;
    });
    // A failed attempt is logged by the connection, which keeps reconnecting in the background.
    client.connect().catch(() => undefined);
    await firstAttempt;
  }

  async onApplicationShutdown(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) {
      await closeRedisConnection(client);
    }
    await this.applying;
  }

  /**
   * Applies one message of the channel: deletes the keys of a valid event, refuses anything else. Never rejects: a
   * failing deletion (Redis gone meanwhile) is logged, and the TTL ends the stale entry.
   */
  async apply(message: string): Promise<void> {
    let event: InvalidationEvent;
    try {
      event = validateInvalidation(JSON.parse(message) as unknown);
    } catch (error) {
      this.logger.warn(
        error instanceof MessageValidationError
          ? {
              reason: "invalid_event",
              issues: error.issues.map(({ path, keyword }) => ({ path, keyword })),
            }
          : { reason: "malformed_json" },
        "invalidation.refused",
      );
      return;
    }
    try {
      const deleted = await this.cache.invalidate(event);
      this.logger.debug({ type: event.type, deleted }, "invalidation.applied");
    } catch (error) {
      this.logger.warn({ type: event.type, err: error }, "invalidation.failed");
    }
  }

  /** Subscribes a connection that has just become ready (the first one, or after a reconnection). */
  private async subscribe(client: Redis): Promise<void> {
    try {
      await client.subscribe(INVALIDATION_CHANNEL);
      this.logger.info({ channel: INVALIDATION_CHANNEL }, "invalidation.subscribed");
    } catch (error) {
      this.logger.warn({ channel: INVALIDATION_CHANNEL, err: error }, "invalidation.subscribe_failed");
    } finally {
      this.firstAttemptEnded();
    }
  }
}
