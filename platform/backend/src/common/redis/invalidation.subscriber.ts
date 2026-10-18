// The `vx:invalidate` subscriber of the platform API (PBE-027; platform/docs/architecture.md §6.3, PADR-0004 item 6).
// The platform publishes `{v: 1, type, …ids}` after the commit of every change to a row the OTA backend caches
// (invalidation.publisher.ts). The OTA backend is not the only process that caches such rows: the API answers Caddy's
// TLS `ask` from a cache too (positive answers in Redis `tlsask:<host>`, refusals in an in-process LRU), and that cache
// must forget a host as soon as its domain or its tenant changes, so a newly verified domain or an OTA whose status
// changed is not refused for the rest of the minute, and a removed one is not served for it. (createTenant publishes no
// event yet: a sub-domain refused in the minute before its OTA was created stays refused until its refusal expires.)
//
// A module that keeps such a cache marks an injectable class with `@InvalidationListener()` and implements
// `onInvalidation(event)`; the subscriber finds the listeners among the providers of the API's module graph
// (DiscoveryService) when the application starts, as MaintenanceProcessor finds its handlers:
//
//   @Injectable()
//   @InvalidationListener()
//   export class TlsAskService implements InvalidationHandler {
//     async onInvalidation(event: InvalidationEvent): Promise<void> { … }
//   }
//
// Each message is validated with `validateInvalidation` (@velexis/api-types/jobs); a message that is not valid JSON or
// not a valid event is refused (`invalidation.refused`, with the failing paths and rules, never the content) and
// reaches no listener. Valid events go to every listener, one message after another in the order they arrive; a
// listener that throws is logged (`invalidation.listener_failed`, with the event type) and the others still run.
//
// The subscriber holds a Redis connection of its own (`platform-backend-invalidation`): a connection in subscriber mode
// can run no other command, so listeners delete keys through the process's command client. Pub/sub delivers only to
// connected subscribers, so a message published while this connection is down is lost; the 60 s TTL of every cached
// answer bounds the staleness. The connection reconnects in the background like the others (redis.module.ts) and
// subscribes again each time it is ready. At start-up the API waits for the first connection attempt (at most 2.5 s):
// from then on it either listens or has logged why it does not, and a Redis that is down does not stop it from
// serving. Without any listener in the module graph the subscriber opens no connection. Only the API runs it
// (CommonModule.forApi()): the worker and the CLI cache nothing.
import {
  Injectable,
  SetMetadata,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DiscoveryService, Reflector } from "@nestjs/core";
import {
  INVALIDATION_CHANNEL,
  MessageValidationError,
  validateInvalidation,
  type InvalidationEvent,
} from "@velexis/api-types/jobs";
import type { Redis, RedisOptions } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import type { PlatformBackendConfig } from "../../config";
import {
  closeRedisConnection,
  commandClientOptions,
  createRedisConnection,
  type RedisLogger,
} from "./redis.module";

/** `CLIENT SETNAME` of the subscriber connection. */
export const INVALIDATION_CONNECTION_NAME = "platform-backend-invalidation";

/** How long start-up waits for the first connection attempt of the subscriber. */
export const FIRST_ATTEMPT_TIMEOUT_MS = 2500;

/** The metadata key of `@InvalidationListener()`. */
export const INVALIDATION_LISTENER_METADATA = "velexis:invalidation-listener";

/** A cache of the API that forgets what an invalidation event names. */
export interface InvalidationHandler {
  /** Applies one valid event; a rejection is logged and never stops the other listeners or later events. */
  onInvalidation(event: InvalidationEvent): Promise<void>;
}

/** Marks an injectable class as a listener of the `vx:invalidate` events (see the file header). */
export function InvalidationListener(): ClassDecorator {
  return SetMetadata(INVALIDATION_LISTENER_METADATA, true);
}

function isHandler(value: unknown): value is InvalidationHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<InvalidationHandler>).onInvalidation === "function"
  );
}

/**
 * The listeners among `providers` (instances of classes marked with `@InvalidationListener()`), each instance once.
 * Throws for a marked class without `onInvalidation`.
 */
export function invalidationListeners(
  providers: ReadonlyArray<{ readonly instance: unknown; readonly metatype: unknown }>,
  reflector: Pick<Reflector, "get">,
): InvalidationHandler[] {
  const listeners = new Set<InvalidationHandler>();
  for (const { instance, metatype } of providers) {
    if (typeof metatype !== "function" || reflector.get(INVALIDATION_LISTENER_METADATA, metatype) !== true) {
      continue;
    }
    if (!isHandler(instance)) {
      throw new TypeError(`@InvalidationListener(): ${metatype.name} has no onInvalidation(event) method`);
    }
    listeners.add(instance);
  }
  return [...listeners];
}

/**
 * Applies one message of the channel (`InvalidationSubscriber.apply`): hands a valid event to every listener, one after
 * another, and refuses anything else (`invalidation.refused`, with the failing paths and rules, never the content).
 * Never rejects: a listener that throws is logged (`invalidation.listener_failed`) and the next one still runs.
 */
export async function applyInvalidation(
  message: string,
  listeners: readonly InvalidationHandler[],
  logger: Pick<RedisLogger, "warn">,
): Promise<void> {
  let event: InvalidationEvent;
  try {
    event = validateInvalidation(JSON.parse(message) as unknown);
  } catch (error) {
    logger.warn(
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
  for (const listener of listeners) {
    try {
      await listener.onInvalidation(event);
    } catch (error) {
      logger.warn(
        { type: event.type, listener: listener.constructor.name, err: error },
        "invalidation.listener_failed",
      );
    }
  }
}

/** The command client's options, under its own name; it subscribes again on every `ready` itself. */
export function subscriberOptions(): RedisOptions {
  return { ...commandClientOptions(), connectionName: INVALIDATION_CONNECTION_NAME, autoResubscribe: false };
}

/** Subscribes the API to `vx:invalidate` and hands each valid event to the listeners (see the file header). */
@Injectable()
export class InvalidationSubscriber implements OnApplicationBootstrap, OnApplicationShutdown {
  private client: Redis | undefined;
  private listeners: readonly InvalidationHandler[] = [];
  /** The messages applied so far, one after another. */
  private applying: Promise<void> = Promise.resolve();
  /** Resolves the start-up wait once the first attempt has ended (subscribed, failed, or timed out). */
  private firstAttemptEnded: () => void = () => undefined;

  constructor(
    private readonly config: ConfigService<PlatformBackendConfig, true>,
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(InvalidationSubscriber.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.listeners = invalidationListeners(this.discovery.getProviders(), this.reflector);
    if (this.listeners.length === 0) {
      return;
    }
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
   * Applies one message of the channel: hands a valid event to every listener, refuses anything else. Never rejects:
   * a listener's failure is logged, and the TTL of the cached answers ends what it could not forget.
   */
  async apply(message: string): Promise<void> {
    await applyInvalidation(message, this.listeners, this.logger);
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
