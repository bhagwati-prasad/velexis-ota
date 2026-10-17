// `api_keys.flush_usage` (platform/docs/architecture.md §5, every 5 minutes; PADR-0005 item 10, flows/api-keys.md
// step 8): moves the last uses of API keys from Redis into `api_keys.last_used_at` and `last_used_ip`, so the portal
// shows them at most 5 minutes stale. The OTA backend never writes the platform table (ADR-0003): after a request it
// sets `apikey:used:<keyId>` to `{at, ip}` (1 day, at most once a minute per key; OBE-013).
//
// Each run takes the keys that may have a counter (every key not revoked or expired more than a day ago, the
// counter's lifetime), in pages of USAGE_FLUSH_BATCH_SIZE ids, and `GETDEL`s their counters, so a use is moved once
// even when two runs overlap. The uses of a page are written in one statement that never moves `last_used_at` back.
// A counter that is not `{at, ip}` with a valid time is dropped with a warning that names the key, never the value;
// an `ip` that is not an address is stored as `null`. Redis or PostgreSQL down fails the job, and BullMQ tries again;
// the uses taken before the failure are lost, which only leaves `last used` staler until the key's next request.
import { isIP } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { MaintenanceJob, type MaintenanceJobHandler } from "../common/queues/maintenance.processor";
import { redisKeys } from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { ApiKeysRepository, type ApiKeyUsage } from "./api-keys.repository";

/** The schedule and job name (scheduler.registry.ts). */
export const API_KEYS_FLUSH_USAGE_JOB = "api_keys.flush_usage";

/** The key ids one page reads and `GETDEL`s. */
export const USAGE_FLUSH_BATCH_SIZE = 500;

/** What a finished run returns (BullMQ keeps it with the job): counts only. */
export interface UsageFlushResult {
  /** Keys whose counter was looked at. */
  readonly checked: number;
  /** Counters taken from Redis. */
  readonly taken: number;
  /** Keys whose `last_used_at` moved forward. */
  readonly updated: number;
  /** Counters dropped because they were not `{at, ip}`. */
  readonly discarded: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The use of key `keyId` that a counter's value records, or `undefined` when the value is not JSON `{at, ip}` with a
 * valid `at` (an ISO 8601 date-time, or epoch milliseconds). An `ip` that is not an IPv4 or IPv6 address is `null`.
 */
export function parseKeyUsage(keyId: string, raw: string): ApiKeyUsage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const at = value["at"];
  const time =
    typeof at === "string" && at !== ""
      ? new Date(at)
      : typeof at === "number" && Number.isFinite(at)
        ? new Date(at)
        : undefined;
  if (time === undefined || Number.isNaN(time.getTime())) {
    return undefined;
  }
  const ip = value["ip"];
  return { keyId, at: time, ip: typeof ip === "string" && isIP(ip) !== 0 ? ip : null };
}

@Injectable()
@MaintenanceJob(API_KEYS_FLUSH_USAGE_JOB)
export class UsageFlushProcessor implements MaintenanceJobHandler {
  constructor(
    private readonly keys: ApiKeysRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Pick<Redis, "getdel">,
    private readonly clock: Clock,
    @InjectPinoLogger(UsageFlushProcessor.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). Logs `api_keys.usage_flushed` when it took any counter. */
  async run(): Promise<UsageFlushResult> {
    const now = this.clock.now();
    let checked = 0;
    let taken = 0;
    let updated = 0;
    let discarded = 0;
    let afterId: string | null = null;
    for (;;) {
      const ids = await this.keys.usageCandidates(now, afterId, USAGE_FLUSH_BATCH_SIZE);
      if (ids.length === 0) {
        break;
      }
      checked += ids.length;
      afterId = ids[ids.length - 1] ?? null;
      // One command per key, sent together: ioredis writes them on one connection without waiting in between.
      const values = await Promise.all(ids.map((id) => this.redis.getdel(redisKeys.apiKeyUsed(id).key)));
      const usages: ApiKeyUsage[] = [];
      values.forEach((raw, index) => {
        const keyId = ids[index];
        if (raw === null || keyId === undefined) {
          return;
        }
        taken += 1;
        const usage = parseKeyUsage(keyId, raw);
        if (usage === undefined) {
          discarded += 1;
          this.logger.warn({ keyId }, "api_keys.usage_discarded");
          return;
        }
        usages.push(usage);
      });
      updated += await this.keys.recordUsage(usages);
      if (ids.length < USAGE_FLUSH_BATCH_SIZE) {
        break;
      }
    }
    const result: UsageFlushResult = { checked, taken, updated, discarded };
    if (taken > 0) {
      this.logger.info({ ...result }, "api_keys.usage_flushed");
    }
    return result;
  }
}
