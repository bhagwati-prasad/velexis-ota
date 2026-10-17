// API key usage (OADR-0009 point 6, platform architecture §6.4): after each successful request of a `pk_` or `sk_`
// key, the API sets `apikey:used:<keyId>` to `{at, ip}` (JSON, 1 day), at most once a minute per key. The platform
// worker moves it into `api_keys.last_used_at` and `last_used_ip` every 5 minutes (`GETDEL`, PBE-021), so the portal
// shows when and from where a key was last used without the OTA backend writing a platform table.
//
// - `at` is the time of the request (ISO 8601, UTC) from the injected Clock; `ip` is the address the request came
//   from (Caddy's client address, the key holder's server or browser), not a forwarded end-user IP: the record says
//   where the key is used from.
// - "Successful" is a final status below 400: the interceptor reads it when the response has been sent, so errors
//   that the error filter renders after the handler do not count. Requests refused by a guard never reach it.
// - The minute is kept in this process's memory (one write per key and minute, nothing to read first), bounded to
//   MAX_TRACKED_KEYS keys; a restart or a second process may write once more within a minute, which the
//   platform's flush absorbs. A failed write is logged (`key_usage.write_failed`, the key id, never the key) and
//   retried by the key's next request; it never fails the request, whose answer has already gone, and `record` never
//   rejects (a key id that is not `key_` + ULID is `key_usage.key_id_invalid`, once a minute). While the client
//   waits to reconnect nothing is sent or logged (the connection logs the outage once, redis.module.ts): the key's
//   first request after the outage writes.
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Response } from "express";
import type { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import type { Observable } from "rxjs";
import { Clock } from "../common/clock";
import { connectionIp, type AddressedRequest } from "../common/http/rate-limits";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { redisKeys, type RedisKey } from "../common/redis/redis.keys";
import { CallerContext } from "./caller-resolver";

/** A key's usage is written at most once per this many milliseconds (OADR-0009 point 6). */
export const KEY_USAGE_INTERVAL_MS = 60_000;

/** The most keys whose last write this process remembers; older entries are dropped beyond it. */
export const MAX_TRACKED_KEYS = 10_000;

/** The value of `apikey:used:<keyId>`, as the platform's usage flush reads it. */
export interface KeyUsage {
  /** When the key was used: ISO 8601 in UTC. */
  readonly at: string;
  /** The address the request came from. */
  readonly ip: string;
}

/** What the recorder needs of the command client (`REDIS_CLIENT`). */
export type KeyUsageRedis = Pick<Redis, "set" | "status">;

/** ioredis statuses in which the command client cannot answer: it waits to reconnect, or has been closed. */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

@Injectable()
export class KeyUsageRecorder {
  /** The time (ms) of each key's last write by this process. */
  private readonly lastWrites = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: KeyUsageRedis,
    private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(KeyUsageRecorder.name);
  }

  /**
   * Records one successful request of the key `keyId` from `ip`. Resolves to true when it wrote
   * `apikey:used:<keyId>`, false when the key was written less than a minute ago, Redis is down or the write failed.
   * Never rejects.
   */
  async record(keyId: string, ip: string): Promise<boolean> {
    const now = this.clock.now().getTime();
    const last = this.lastWrites.get(keyId);
    // A clock that went back counts as a new minute rather than silencing the key.
    if (last !== undefined && now >= last && now - last < KEY_USAGE_INTERVAL_MS) {
      return false;
    }
    if (REDIS_DOWN.has(this.redis.status)) {
      return false;
    }
    this.remember(keyId, now);
    let key: RedisKey;
    try {
      key = redisKeys.apiKeyUsed(keyId);
    } catch (error) {
      // platform.api_keys checks only the `key_` prefix of its ids; one that cannot be a key part is warned about once
      // a minute (it stays remembered), never thrown: the interceptor does not wait for the write.
      this.logger.warn({ err: error, keyId }, "key_usage.key_id_invalid");
      return false;
    }
    const usage: KeyUsage = { at: new Date(now).toISOString(), ip };
    try {
      await this.redis.set(key.key, JSON.stringify(usage), "EX", key.ttlSeconds);
      return true;
    } catch (error) {
      if (this.lastWrites.get(keyId) === now) {
        this.lastWrites.delete(keyId);
      }
      this.logger.warn({ err: error, keyId }, "key_usage.write_failed");
      return false;
    }
  }

  /** Notes a write; beyond MAX_TRACKED_KEYS drops the keys written more than a minute ago, or all of them. */
  private remember(keyId: string, now: number): void {
    this.lastWrites.delete(keyId);
    if (this.lastWrites.size >= MAX_TRACKED_KEYS) {
      for (const [id, at] of this.lastWrites) {
        if (now - at >= KEY_USAGE_INTERVAL_MS || at > now) {
          this.lastWrites.delete(id);
        }
      }
      if (this.lastWrites.size >= MAX_TRACKED_KEYS) {
        this.lastWrites.clear();
      }
    }
    this.lastWrites.set(keyId, now);
  }
}

/**
 * Records the usage of the request's API key once the response has been sent with a status below 400 (global,
 * `APP_INTERCEPTOR` in app.module.ts). Other callers pass through untouched.
 */
@Injectable()
export class KeyUsageInterceptor implements NestInterceptor {
  constructor(
    private readonly callers: CallerContext,
    private readonly usage: KeyUsageRecorder,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const caller = context.getType() === "http" ? this.callers.get() : undefined;
    if (caller?.type === "key") {
      const http = context.switchToHttp();
      const ip = connectionIp(http.getRequest<AddressedRequest>());
      const res = http.getResponse<Response>();
      res.once("finish", () => {
        if (res.statusCode < 400) {
          void this.usage.record(caller.keyId, ip);
        }
      });
    }
    return next.handle();
  }
}
