// The Redis read-through caches of the platform rows the OTA backend reads (OADR-0009 points 4 and 5, ota/docs/
// architecture.md §7, OBE-012). Every platform lookup of a request goes through here:
//
//   GET <key> → hit:  the cached value, or the cached "not found"
//             → miss: PlatformReadRepository (one short read-only transaction) → SET <key> … EX <ttl> → the value
//
//   Key                              Holds                                                      TTL   "Not found"
//   tenant:<tenantId>                the platform.tenants row (PlatformTenant)                  60 s  not cached
//   tenantkey:<key>                  the tenant id of a tenant key (<key>.<base> hosts)          60 s  10 s
//   host:<hostname>                  the tenant id of a verified storefront domain              60 s  10 s
//   apikey:<prefix>                  the platform.api_keys row (PlatformApiKey)                 60 s  10 s
//   member:<accountId>:<tenantId>    a membership, loaded by its caller (staff sessions)        60 s  not cached
//   conn:<kind>:<tenantId>:<env>     a supplier or payment connection, loaded by its caller     60 s  not cached
//   amadeus:acct:<id>                the shared Amadeus account row, loaded by its caller       60 s  not cached
//
// The key names, TTLs and negative TTLs are the builders' of redis.keys.ts. A value is stored as JSON
// `{"v":1,"value":…}` (`"value":null` for a cached "not found") and checked again when it is read back: an entry that
// does not parse (another version, a truncated write) is a miss and is replaced. Rows are cached as the repository
// returns them, plain and JSON-safe; nothing is decrypted to be cached, so the connection rows keep their ciphertext
// (as base64 text) exactly as the platform stored it.
//
// `tenantkey:` and `host:` hold a tenant id, never the row, so the `tenant` invalidation of a status change reaches
// every way to a tenant through one key. `invalidate(event)` deletes exactly the keys of an event (`invalidatedKeys`).
//
// Degraded mode (point 5): while Redis cannot be reached (the command client is reconnecting), lookups go to
// PostgreSQL directly and nothing is cached; a failing Redis command is the same. A failing platform lookup is
// `503 SERVICE_UNAVAILABLE`; a row the backend cannot read (UnexpectedPlatformValueError, InvalidTenantSchemaError)
// stays an error (500). Cached entries are never used past their TTL: Redis expires them.
//
// A fill that races an invalidation must not put the old row back: the platform publishes after its commit, so a
// lookup that read PostgreSQL before the commit may write after the subscriber deleted the key. Every invalidation
// first bumps `generation` (in this process, which also runs the subscriber); a fill that started under an older
// generation is not written, and one whose write lands after a bump is deleted again. Every process that fills the
// cache (the API, and the worker's jobs since OBE-024) runs its own subscriber for this reason.
import { Inject, Injectable } from "@nestjs/common";
import type { InvalidationEvent } from "@velexis/api-types/jobs";
import { InvalidTenantSchemaError, isTenantSchema } from "@velexis/db";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import {
  redisKeyPatterns,
  redisKeys,
  type ConnectionKind,
  type KeyEnvironment,
  type RedisKey,
  type RedisKeyName,
  type RedisKeyPattern,
} from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import {
  API_KEY_ENVIRONMENTS,
  API_KEY_KINDS,
  PlatformReadRepository,
  type PlatformApiKey,
} from "./platform-read.repository";
import {
  BILLING_NOTICES,
  STOREFRONT_ENVIRONMENTS,
  TENANT_STATUSES,
  UnexpectedPlatformValueError,
  type PlatformTenant,
} from "./platform-read.types";

/** Reads a cached value back: the value when it has the expected shape, else `undefined` (the entry is a miss). */
export type CacheParser<T> = (value: unknown) => T | undefined;

/** The version of the stored JSON (`{"v":1,"value":…}`). */
export const PLATFORM_CACHE_FORMAT = 1;

/** Keys asked of Redis per SCAN step when an invalidation deletes by pattern. */
const SCAN_COUNT = 200;

/** ioredis statuses in which the command client cannot answer: it waits to reconnect, or has been closed. */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

/** The connection kinds and environments of a tenant: the four `conn:` keys of a `connection` invalidation. */
const CONNECTION_KINDS: readonly ConnectionKind[] = ["amadeus", "payment"];
const ENVIRONMENTS: readonly KeyEnvironment[] = ["test", "live"];

/** The keys an invalidation event deletes: exact keys, and patterns whose matching keys are scanned for. */
export interface InvalidatedKeys {
  readonly keys: readonly RedisKey[];
  readonly patterns: readonly RedisKeyPattern[];
}

const only = (...keys: RedisKey[]): InvalidatedKeys => ({ keys, patterns: [] });

/**
 * The keys of each invalidation type (platform architecture §6.3, OADR-0009 point 4). `tenantkey:` is never
 * invalidated: it maps an immutable key to an immutable id, and a cached "not found" lives 10 s. `plan` deletes
 * nothing yet: no cache of the OTA backend holds plan data (nothing reads `platform.plans` before plan-gated
 * features exist); the feature that caches plan rows adds its key here.
 */
export function invalidatedKeys(event: InvalidationEvent): InvalidatedKeys {
  switch (event.type) {
    case "tenant":
      return only(redisKeys.tenant(event.id));
    case "domain":
      return only(redisKeys.host(event.hostname));
    case "api_key":
      return only(redisKeys.apiKey(event.prefix));
    case "connection":
      return only(
        ...CONNECTION_KINDS.flatMap((kind) =>
          ENVIRONMENTS.map((environment) => redisKeys.conn(kind, event.tenantId, environment)),
        ),
      );
    case "membership":
      return only(redisKeys.member(event.accountId, event.tenantId));
    case "account":
      // Account status, lock and MFA reach the OTA backend only through its cached memberships.
      return { keys: [], patterns: [redisKeyPatterns.membersOfAccount(event.accountId)] };
    case "amadeus_account":
      return only(redisKeys.amadeusAccount(event.id));
    case "plan":
      return only();
  }
}

/** One entry read from Redis: the cached value, or `null` for a cached "not found". */
interface Entry<T> {
  readonly value: T | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** A tenant id as the platform writes it (`ten_` and a ULID); `tenantkey:` and `host:` hold one. */
const TENANT_ID = /^ten_[0-9A-Za-z]{1,60}$/;

/** A cached tenant id. */
export const parseTenantId: CacheParser<string> = (value) =>
  typeof value === "string" && TENANT_ID.test(value) ? value : undefined;

/** A cached `PlatformTenant`, with its schema name checked as `toPlatformTenant` checks it. */
export const parseTenant: CacheParser<PlatformTenant> = (value) => {
  if (!isRecord(value)) {
    return undefined;
  }
  const {
    id,
    key,
    name,
    status,
    schemaName,
    storefrontEnvironment,
    defaultCurrency,
    defaultLocale,
    billingNotice,
  } = value;
  if (
    typeof id !== "string" ||
    typeof key !== "string" ||
    typeof name !== "string" ||
    typeof defaultCurrency !== "string" ||
    typeof defaultLocale !== "string" ||
    !isOneOf(status, TENANT_STATUSES) ||
    !isOneOf(storefrontEnvironment, STOREFRONT_ENVIRONMENTS) ||
    !(billingNotice === null || isOneOf(billingNotice, BILLING_NOTICES)) ||
    !isTenantSchema(schemaName) ||
    schemaName !== `tenant_${key}`
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    key,
    name,
    status,
    schemaName,
    storefrontEnvironment,
    defaultCurrency,
    defaultLocale,
    billingNotice,
  });
};

/** A cached `PlatformApiKey`. */
export const parseApiKey: CacheParser<PlatformApiKey> = (value) => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, tenantId, kind, environment, prefix, keyHash, allowedOrigins, scopes, expiresAt, revokedAt } =
    value;
  if (
    typeof id !== "string" ||
    !nullableString(tenantId) ||
    !isOneOf(kind, API_KEY_KINDS) ||
    !isOneOf(environment, API_KEY_ENVIRONMENTS) ||
    typeof prefix !== "string" ||
    typeof keyHash !== "string" ||
    !isStringArray(allowedOrigins) ||
    !isStringArray(scopes) ||
    !nullableString(expiresAt) ||
    !nullableString(revokedAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    tenantId,
    kind,
    environment,
    prefix,
    keyHash,
    allowedOrigins: Object.freeze([...allowedOrigins]),
    scopes: Object.freeze([...scopes]),
    expiresAt,
    revokedAt,
  });
};

/** The key `build` returns, or `undefined` when a part cannot be a key part (the lookup then skips the cache). */
function keyOf<K extends RedisKey>(build: () => K): K | undefined {
  try {
    return build();
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

@Injectable()
export class PlatformCache {
  /** Bumped by every invalidation; see the file header. */
  private generation = 0;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly platform: PlatformReadRepository,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(PlatformCache.name);
  }

  /** The tenant with this id, or `null` when there is none (`tenant:<id>`; a missing tenant is not cached). */
  async tenantById(tenantId: string): Promise<PlatformTenant | null> {
    return this.readThrough(
      keyOf(() => redisKeys.tenant(tenantId)),
      () => this.platform.tenantById(tenantId),
      parseTenant,
    );
  }

  /** The tenant with this key, or `null` (`tenantkey:<key>` → `tenant:<id>`; an unknown key is cached 10 s). */
  async tenantByKey(tenantKey: string): Promise<PlatformTenant | null> {
    const key = keyOf(() => redisKeys.tenantByKey(tenantKey));
    const cached = key === undefined ? undefined : await this.read(key, parseTenantId);
    if (cached !== undefined) {
      return cached.value === null ? null : this.tenantById(cached.value);
    }
    const generation = this.generation;
    const tenant = await this.load(() => this.platform.tenantByKey(tenantKey));
    if (key !== undefined) {
      const tenantKeyEntry: [RedisKey, unknown] = [key, tenant?.id ?? null];
      const rowKey = tenant === null ? undefined : keyOf(() => redisKeys.tenant(tenant.id));
      await this.fill(
        rowKey === undefined ? [tenantKeyEntry] : [tenantKeyEntry, [rowKey, tenant]],
        generation,
      );
    }
    return tenant;
  }

  /**
   * The tenant of a verified storefront domain (`host:<hostname>` → `tenant:<id>`), whatever its status, or `null`
   * for an unknown, pending, failed or other-purpose host (cached 10 s).
   */
  async tenantByStorefrontHost(hostname: string): Promise<PlatformTenant | null> {
    const tenantId = await this.readThrough(
      keyOf(() => redisKeys.host(hostname)),
      () => this.platform.tenantIdByStorefrontHost(hostname),
      parseTenantId,
    );
    return tenantId === null ? null : this.tenantById(tenantId);
  }

  /** The API key row of a prefix, or `null` (`apikey:<prefix>`; an unknown prefix is cached 10 s). */
  async apiKeyByPrefix(prefix: string): Promise<PlatformApiKey | null> {
    return this.readThrough(
      keyOf(() => redisKeys.apiKey(prefix)),
      () => this.platform.apiKeyByPrefix(prefix),
      parseApiKey,
    );
  }

  /** A staff member's membership (`member:<accountId>:<tenantId>`), loaded by `load` on a miss. */
  async membership<T>(
    accountId: string,
    tenantId: string,
    load: () => Promise<T | null>,
    parse: CacheParser<T>,
  ): Promise<T | null> {
    return this.readThrough(
      keyOf(() => redisKeys.member(accountId, tenantId)),
      load,
      parse,
    );
  }

  /**
   * A tenant's supplier or payment connection of one environment (`conn:<kind>:<tenantId>:<env>`), loaded by `load`
   * on a miss. The value must be JSON-safe with its ciphertext as text; it is cached as it is, never decrypted.
   */
  async connection<T>(
    kind: ConnectionKind,
    tenantId: string,
    environment: KeyEnvironment,
    load: () => Promise<T | null>,
    parse: CacheParser<T>,
  ): Promise<T | null> {
    return this.readThrough(
      keyOf(() => redisKeys.conn(kind, tenantId, environment)),
      load,
      parse,
    );
  }

  /** The Velexis shared Amadeus account row (`amadeus:acct:<id>`), loaded by `load` on a miss; as `connection`. */
  async amadeusAccount<T>(
    amadeusAccountId: string,
    load: () => Promise<T | null>,
    parse: CacheParser<T>,
  ): Promise<T | null> {
    return this.readThrough(
      keyOf(() => redisKeys.amadeusAccount(amadeusAccountId)),
      load,
      parse,
    );
  }

  /**
   * Deletes the keys of an invalidation event (`invalidatedKeys`) and resolves to how many existed. Fills in flight
   * are not written back (see the file header). Throws when Redis does not answer.
   */
  async invalidate(event: InvalidationEvent): Promise<number> {
    this.generation += 1;
    const { keys, patterns } = invalidatedKeys(event);
    const unique = new Set<RedisKeyName>(keys.map((key) => key.key));
    for (const pattern of patterns) {
      for (const key of await this.scan(pattern)) {
        unique.add(key.key);
      }
    }
    const names = [...unique];
    return names.length === 0 ? 0 : await this.redis.del(...names);
  }

  /** `key` from Redis, else `load` from PostgreSQL, cached for the key's TTL (a `null` for its negative TTL). */
  private async readThrough<T>(
    key: RedisKey | undefined,
    load: () => Promise<T | null>,
    parse: CacheParser<T>,
  ): Promise<T | null> {
    const cached = key === undefined ? undefined : await this.read(key, parse);
    if (cached !== undefined) {
      return cached.value;
    }
    const generation = this.generation;
    const value = await this.load(load);
    if (key !== undefined) {
      await this.fill([[key, value]], generation);
    }
    return value;
  }

  /** The entry of `key`, or `undefined` for a miss, an unreadable entry, or a Redis that does not answer. */
  private async read<T>(key: RedisKey, parse: CacheParser<T>): Promise<Entry<T> | undefined> {
    if (REDIS_DOWN.has(this.redis.status)) {
      return undefined;
    }
    let raw: string | null;
    try {
      raw = await this.redis.get(key.key);
    } catch {
      return undefined; // The connection logs the outage (redis.module.ts); PostgreSQL answers meanwhile.
    }
    if (raw === null) {
      return undefined;
    }
    const entry = decode(raw, parse, key.negativeTtlSeconds !== undefined);
    if (entry === undefined) {
      this.logger.warn({ cache: cacheNameOf(key) }, "platform_cache.entry_unreadable");
    }
    return entry;
  }

  /**
   * Writes the entries with their TTLs, unless an invalidation came after `generation`; deletes them again when one
   * came while they were written. A `null` is written only for a key with a negative TTL. Redis errors are ignored.
   */
  private async fill(
    entries: ReadonlyArray<readonly [RedisKey, unknown]>,
    generation: number,
  ): Promise<void> {
    const writable = entries.filter(([key, value]) => value !== null || key.negativeTtlSeconds !== undefined);
    if (writable.length === 0 || generation !== this.generation || REDIS_DOWN.has(this.redis.status)) {
      return;
    }
    try {
      await Promise.all(
        writable.map(([key, value]) =>
          this.redis.set(
            key.key,
            JSON.stringify({ v: PLATFORM_CACHE_FORMAT, value }),
            "EX",
            value === null ? (key.negativeTtlSeconds ?? key.ttlSeconds) : key.ttlSeconds,
          ),
        ),
      );
      if (generation !== this.generation) {
        await this.redis.del(...writable.map(([key]) => key.key));
      }
    } catch {
      // Not cached this time; the next lookup reads PostgreSQL again.
    }
  }

  /**
   * `load` against PostgreSQL. A failure to read is `503 SERVICE_UNAVAILABLE`; an `AppError` and a row the backend
   * cannot read keep their own meaning.
   */
  private async load<T>(load: () => Promise<T>): Promise<T> {
    try {
      return await load();
    } catch (error) {
      if (
        error instanceof AppError ||
        error instanceof UnexpectedPlatformValueError ||
        error instanceof InvalidTenantSchemaError
      ) {
        throw error;
      }
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }

  /** The keys of `pattern` that exist (SCAN, in steps; a key the pattern does not rebuild is left alone). */
  private async scan(pattern: RedisKeyPattern): Promise<RedisKey[]> {
    const found: RedisKey[] = [];
    let cursor = "0";
    do {
      const [next, names] = await this.redis.scan(cursor, "MATCH", pattern.match, "COUNT", SCAN_COUNT);
      cursor = next;
      for (const name of names) {
        const key = pattern.keyOf(name);
        if (key !== undefined) {
          found.push(key);
        }
      }
    } while (cursor !== "0");
    return found;
  }
}

/** A stored entry, or `undefined` when it is not one this version wrote (a `null` only where "not found" is cached). */
function decode<T>(raw: string, parse: CacheParser<T>, negativeCached: boolean): Entry<T> | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(stored) || stored["v"] !== PLATFORM_CACHE_FORMAT || !("value" in stored)) {
    return undefined;
  }
  if (stored["value"] === null) {
    return negativeCached ? { value: null } : undefined;
  }
  const value = parse(stored["value"]);
  return value === undefined ? undefined : { value };
}

/** The cache of a key for a log line (`tenant:<id>` → `tenant`), never its ids, hosts or prefixes. */
function cacheNameOf(key: RedisKey): string {
  return key.key.split(":", 1)[0] ?? "";
}
