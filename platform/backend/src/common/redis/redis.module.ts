// The Redis connections of a platform backend process (PBE-009; platform/docs/architecture.md §5 and §6, ADR-0009).
// RedisModule is a global static module: whichever modules import it, Nest builds it once per process, so the API
// and the worker each hold one command client and one BullMQ connection, both on REDIS_URL:
//
// - `REDIS_CLIENT`, the client for idempotency records, throttler counters, hand-offs (`ptk:`, `mfach:`, …) and
//   `vx:invalidate`. It fails fast while Redis is down (one retry per command), so callers degrade as architecture §9
//   says (idempotent creates and sign-in challenges answer `503`) instead of hanging on a request;
// - `REDIS_BULLMQ_CONNECTION`, the connection QueuesModule hands to BullMQ for every queue and worker of the process,
//   with `maxRetriesPerRequest: null` as BullMQ requires: a queue command waits for Redis to come back instead of
//   failing. BullMQ duplicates it for each worker's blocking connection.
//
// Keys come only from redis-keys.ts. Both connections open on first use and reconnect in the background; a lost
// connection is logged once per outage, never with the URL (it carries the password). Being global, the module is
// shut down after every non-global module and after the BullMQ modules that QueuesModule imports after it, so the
// queues and workers have closed when the connections quit. The module also provides the InvalidationPublisher, so
// the API and the worker publish `vx:invalidate` through the same client. The readiness probe keeps its own client
// (HealthModule).
import {
  Global,
  Inject,
  Injectable,
  Module,
  type FactoryProvider,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis, type RedisOptions } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import type { PlatformBackendConfig } from "../../config";
import { InvalidationPublisher } from "./invalidation.publisher";

/** Injection token of the command client (`ioredis` `Redis`). */
export const REDIS_CLIENT = "REDIS_CLIENT";
/** Injection token of the BullMQ connection (`ioredis` `Redis` with `maxRetriesPerRequest: null`). */
export const REDIS_BULLMQ_CONNECTION = "REDIS_BULLMQ_CONNECTION";

/** `CLIENT SETNAME` of the two connections, as `CLIENT LIST` shows them. */
export const REDIS_CONNECTION_NAMES = Object.freeze({
  commands: "platform-backend",
  bullmq: "platform-backend-bullmq",
} as const);

/** The longest wait between two reconnection attempts; Redis runs on the same machine. */
const MAX_RECONNECT_DELAY_MS = 2000;
/** How long a connection attempt may take. */
const CONNECT_TIMEOUT_MS = 2000;

/** Reconnect after 200 ms, 400 ms, … up to 2 s, for ever. */
function reconnectDelay(attempt: number): number {
  return Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS);
}

/** Options of the command client: connect on first use, one retry per command while reconnecting. */
export function commandClientOptions(): RedisOptions {
  return {
    connectionName: REDIS_CONNECTION_NAMES.commands,
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: reconnectDelay,
  };
}

/** Options of the BullMQ connection: connect on first use, commands wait for Redis (BullMQ's requirement). */
export function bullmqConnectionOptions(): RedisOptions {
  return {
    connectionName: REDIS_CONNECTION_NAMES.bullmq,
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: null,
    retryStrategy: reconnectDelay,
  };
}

/** What the connections log with: pino's call shape, so `PinoLogger` and a pino logger both fit. */
export interface RedisLogger {
  warn(object: Record<string, unknown>, message: string): void;
  info(object: Record<string, unknown>, message: string): void;
}

/**
 * A client on `url` that logs its first error of every outage (`redis.connection_error`, with the connection name
 * and the error, never the URL) and the reconnection after it (`redis.connection_restored`).
 */
export function createRedisConnection(url: string, options: RedisOptions, logger: RedisLogger): Redis {
  const client = new Redis(url, options);
  const connection = options.connectionName;
  let outage = false;
  client.on("error", (error: unknown) => {
    if (!outage) {
      outage = true;
      logger.warn({ connection, err: error }, "redis.connection_error");
    }
  });
  client.on("ready", () => {
    if (outage) {
      outage = false;
      logger.info({ connection }, "redis.connection_restored");
    }
  });
  return client;
}

/** How long `QUIT` may wait (for pending replies, or for Redis to come back) before the socket is just closed. */
const QUIT_TIMEOUT_MS = 2000;

function ignore(): void {
  // The outcome of QUIT does not matter: the connection is closed right after it either way.
}

/**
 * Resolves with the client's status when the connection attempt in flight has ended: the client is `ready`, waits to
 * reconnect, or has ended. At most `CONNECT_TIMEOUT_MS` plus a margin: ioredis gives up an attempt that takes longer.
 */
async function attemptEnded(client: Redis): Promise<Redis["status"]> {
  const events = ["ready", "reconnecting", "end"] as const;
  let finish: () => void = ignore;
  const ended = new Promise<void>((resolveAttempt) => {
    finish = resolveAttempt;
  });
  const timer = setTimeout(finish, CONNECT_TIMEOUT_MS + 500);
  for (const event of events) {
    client.once(event, finish);
  }
  try {
    await ended;
  } finally {
    clearTimeout(timer);
    for (const event of events) {
      client.off(event, finish);
    }
  }
  return client.status;
}

/**
 * Closes a client, as the OTA backend's RedisModule does (OBE-002, OBE-005):
 *
 * - a client that never connected (`lazyConnect`, status `wait`) has no socket and no timer: nothing to close;
 * - a client with a connection attempt in flight is closed when that attempt has ended, because BullMQ 5 rejects the
 *   set-up of every queue still waiting on a shared connection once it sees `end`, and those queues have already
 *   removed their listeners (an unhandled rejection);
 * - a ready connection gets `QUIT`, so pending replies are delivered first, and closes, for at most 2 s;
 * - any other connection, or one that has not quit by then, is closed at once. No reconnection follows.
 */
export async function closeRedisConnection(client: Redis): Promise<void> {
  if (client.status === "wait") {
    return;
  }
  if (client.status === "connecting" || client.status === "connect") {
    if ((await attemptEnded(client)) === "ready") {
      // One event-loop turn, so the commands other listeners of `ready` send (BullMQ's version check) go out first.
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
    }
  }
  if (client.status === "ready") {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, QUIT_TIMEOUT_MS);
    });
    // QUIT's reply comes before the socket has closed: wait for `end` too, so a connection that quit is not also
    // disconnected.
    const ended = new Promise<void>((resolveEnd) => client.once("end", () => resolveEnd()));
    try {
      await Promise.race([Promise.all([client.quit().then(ignore, ignore), ended]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (client.status !== "end") {
    client.disconnect();
  }
}

function connectionProvider(token: string, options: () => RedisOptions): FactoryProvider<Redis> {
  return {
    provide: token,
    inject: [ConfigService, PinoLogger],
    useFactory: (config: ConfigService<PlatformBackendConfig, true>, logger: PinoLogger) => {
      logger.setContext(RedisModule.name);
      return createRedisConnection(config.get("REDIS_URL", { infer: true }), options(), logger);
    },
  };
}

/** Quits both connections when the application shuts down. */
@Injectable()
export class RedisConnections implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(REDIS_BULLMQ_CONNECTION) private readonly bullmq: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([closeRedisConnection(this.client), closeRedisConnection(this.bullmq)]);
  }
}

/** The InvalidationPublisher on the command client. */
const publisherProvider: FactoryProvider<InvalidationPublisher> = {
  provide: InvalidationPublisher,
  inject: [REDIS_CLIENT, PinoLogger],
  useFactory: (client: Redis, logger: PinoLogger) => {
    logger.setContext(InvalidationPublisher.name);
    return new InvalidationPublisher(client, logger);
  },
};

/** The process's Redis connections and the invalidation publisher; see the file header. */
@Global()
@Module({
  providers: [
    connectionProvider(REDIS_CLIENT, commandClientOptions),
    connectionProvider(REDIS_BULLMQ_CONNECTION, bullmqConnectionOptions),
    RedisConnections,
    publisherProvider,
  ],
  exports: [REDIS_CLIENT, REDIS_BULLMQ_CONNECTION, InvalidationPublisher],
})
export class RedisModule {}
