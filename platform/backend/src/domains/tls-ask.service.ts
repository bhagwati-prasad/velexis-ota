// Caddy's on-demand TLS gate (PBE-027; ADR-0018, PADR-0004 item 6, scope PF-40 and PF-42, api-inventory-admin.md §9
// `tlsAsk`). Caddy asks before it obtains a certificate for a host it has none for; the answer is yes only for:
//
// 1. `<key>.<STOREFRONT_BASE_DOMAIN>` of a tenant in `provisioning`, `active` or `suspended` (a suspended OTA still
//    shows its "suspended" page over HTTPS); or
// 2. a verified custom storefront domain (`kind = 'custom'`, `purpose = 'storefront'`, `verification_status =
//    'verified'`) of an `active` tenant whose plan has `customDomains > 0`, while the `custom_domains` switch is on.
//
// Everything else is no. The order of the checks (PADR-0004 item 6) keeps a flood of random SNI names cheap:
//
// - the host syntax first (lower-cased, at most 253 characters, labels of 1–63 characters of `a-z`, `0-9` and inner
//   `-`, at least two labels, the last starting with a letter, so never an IP address): a malformed host is refused
//   before any cache or database access and cached nowhere. Hosts that no rule can allow are refused here too, without
//   a lookup: the base domain itself or a host below a sub-domain, a label that is no tenant key, and every custom host
//   while the switch is off;
// - then Redis `tlsask:<host>` (60 s), which holds **positive answers only**;
// - then the in-process LRU of refusals (tls-ask.negative-cache.ts: 10 000 hosts, 60 s), so unknown names cost no Redis
//   memory;
// - then one indexed lookup in PostgreSQL, whose answer goes to Redis (yes) or to the LRU (no).
//
// The service is also a listener of the `vx:invalidate` subscriber (common/redis/invalidation.subscriber.ts): a
// `domain` event forgets its host, a `tenant` event every host of the tenant (its sub-domain and its domain rows), in
// Redis and in the LRU, so a host refused a moment ago is allowed right after its domain is verified, and a removed one
// stops being allowed. An answer read from the database while an invalidation arrived is returned but not cached, so a
// lookup that saw the old rows cannot put an answer back that the event has just removed.
//
// Redis is a cache here, never a dependency: a failed read counts as a miss and a failed write is skipped, so `ask`
// keeps answering from PostgreSQL while Redis is down. Host names are no secret; nothing here logs per request (the
// request line of pino-http has the route), so a flood writes no extra lines.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { InvalidationEvent } from "@velexis/api-types/jobs";
import type { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { FeatureSwitches } from "../common/features";
import { InvalidationListener, type InvalidationHandler } from "../common/redis/invalidation.subscriber";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { redisKeys, setKey, type RedisKey } from "../common/redis/redis-keys";
import type { PlatformBackendConfig } from "../config";
import { isValidTenantKey } from "../tenants/tenant-key";
import { DomainsRepository } from "./domains.repository";
import { TlsAskNegativeCache } from "./tls-ask.negative-cache";

/** The longest host name `ask` considers (PADR-0004 item 6, RFC 1035). */
export const TLS_ASK_MAX_HOST_LENGTH = 253;

/**
 * The host syntax of PADR-0004 item 6, on a lower-cased host: labels of 1–63 characters of `a-z`, `0-9` and inner `-`
 * (punycode `xn--` labels included), at least two labels, no trailing dot, and a last label that starts with a letter,
 * so no IPv4 address passes (an IPv6 address has `:`). The same rule as the `domain` invalidation event and the
 * `tlsask:` key builder.
 */
export const TLS_ASK_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The tenant statuses whose sub-domain `ask` allows (ADR-0018 rule 1). */
export const SUBDOMAIN_TENANT_STATUSES: ReadonlySet<string> = new Set([
  "provisioning",
  "active",
  "suspended",
]);

/**
 * The `customDomains` quota of a plan's `limits` column: a whole number of at least 0, or 0 when the plan does not set
 * it (the rule of `PlanLimits` in listPlans, so a plan with incomplete limits never allows custom domains).
 */
export function customDomainLimit(limits: unknown): number {
  const value =
    limits !== null && typeof limits === "object" && !Array.isArray(limits)
      ? (limits as Record<string, unknown>)["customDomains"]
      : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The value Redis keeps under `tlsask:<host>`: the key's presence is the answer. */
const ALLOWED = "1";

/**
 * The host of an `ask` request when `value` passes the syntax check (lower-cased), otherwise `undefined`. The length is
 * checked before anything else, so an over-long value costs no pattern match.
 */
export function askHost(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > TLS_ASK_MAX_HOST_LENGTH) {
    return undefined;
  }
  const host = value.toLowerCase();
  return host.length <= TLS_ASK_MAX_HOST_LENGTH && TLS_ASK_HOST_PATTERN.test(host) ? host : undefined;
}

/** Which rule could allow a well-formed host, decided without any lookup. */
export type AskTarget =
  | { readonly kind: "subdomain"; readonly key: string }
  | { readonly kind: "custom" }
  | { readonly kind: "none" };

/**
 * The rule that could allow `host` (already through `askHost`): `<key>.<base>` with a valid tenant key is a sub-domain,
 * any host outside the base domain a custom domain; the base domain itself, a host below a sub-domain and a label that
 * is no tenant key can never be allowed (`none`).
 */
export function askTarget(host: string, baseDomain: string): AskTarget {
  const suffix = `.${baseDomain}`;
  if (host === baseDomain) {
    return { kind: "none" };
  }
  if (!host.endsWith(suffix)) {
    return { kind: "custom" };
  }
  const label = host.slice(0, -suffix.length);
  return !label.includes(".") && isValidTenantKey(label)
    ? { kind: "subdomain", key: label }
    : { kind: "none" };
}

@Injectable()
@InvalidationListener()
export class TlsAskService implements InvalidationHandler {
  private readonly baseDomain: string;
  /**
   * Counts the invalidations that reached this process. A database answer is cached only when the count did not move
   * while it was read (see the file header).
   */
  private invalidations = 0;

  constructor(
    config: ConfigService<PlatformBackendConfig, true>,
    private readonly features: FeatureSwitches,
    private readonly domains: DomainsRepository,
    private readonly refusals: TlsAskNegativeCache,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(TlsAskService.name);
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** True when Caddy may obtain a certificate for the host `domain` (the `domain` query value, as Caddy sent it). */
  async ask(domain: unknown): Promise<boolean> {
    const host = askHost(domain);
    if (host === undefined) {
      return false;
    }
    const target = askTarget(host, this.baseDomain);
    if (target.kind === "none" || (target.kind === "custom" && !this.features.isEnabled("custom_domains"))) {
      return false;
    }
    const key = redisKeys.tlsAsk(host);
    if (await this.cachedAllowed(key)) {
      return true;
    }
    if (this.refusals.has(host)) {
      return false;
    }
    const seen = this.invalidations;
    const allowed = await this.decide(host, target);
    if (seen === this.invalidations) {
      if (allowed) {
        await this.cacheAllowed(key);
      } else {
        this.refusals.add(host);
      }
    }
    return allowed;
  }

  /**
   * Forgets the cached answers an event changes: the host of a `domain` event, every host of the tenant of a `tenant`
   * event (`<key>.<base>` and its domain rows). Other events change no answer of `ask`.
   */
  async onInvalidation(event: InvalidationEvent): Promise<void> {
    if (event.type === "domain") {
      this.invalidations += 1;
      await this.forget([event.hostname]);
    } else if (event.type === "tenant") {
      this.invalidations += 1;
      const tenant = await this.domains.hostsOfTenant(event.id);
      if (tenant !== undefined) {
        await this.forget([`${tenant.key}.${this.baseDomain}`, ...tenant.hostnames]);
      }
    }
  }

  /** The database's answer for a well-formed host that no cache knows. */
  private async decide(host: string, target: Exclude<AskTarget, { kind: "none" }>): Promise<boolean> {
    if (target.kind === "subdomain") {
      const status = await this.domains.tenantStatusByKey(target.key);
      return status !== undefined && SUBDOMAIN_TENANT_STATUSES.has(status);
    }
    const domain = await this.domains.verifiedCustomStorefront(host);
    return domain !== undefined && domain.tenant_status === "active" && customDomainLimit(domain.limits) > 0;
  }

  /** True when Redis holds a positive answer for the host; a failed read is a miss. */
  private async cachedAllowed(key: RedisKey): Promise<boolean> {
    try {
      return (await this.redis.get(key.key)) !== null;
    } catch (error) {
      this.logger.debug({ err: error }, "tls_ask.cache_read_failed");
      return false;
    }
  }

  /** Keeps a positive answer in Redis for 60 s; a failed write is skipped. */
  private async cacheAllowed(key: RedisKey): Promise<void> {
    try {
      await setKey(this.redis, key, ALLOWED);
    } catch (error) {
      this.logger.debug({ err: error }, "tls_ask.cache_write_failed");
    }
  }

  /** Drops the cached answers of `hosts`: the refusals here, then the positive answers in Redis. */
  private async forget(hosts: readonly string[]): Promise<void> {
    const keys: string[] = [];
    for (const host of new Set(hosts)) {
      this.refusals.delete(host);
      if (askHost(host) === host) {
        keys.push(redisKeys.tlsAsk(host).key);
      }
    }
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
