// The `storefront.get` use case (OBE-016; ota/docs/flows/search-and-price.md §2 step 1, OADR-0012 point 7): the
// caller-independent configuration of the request's tenant, environment and locale from the Redis cache
// `t:<tenantId>:<env>:sf:<locale>` (5 minutes), else from the settings row in one `tenantTx` transaction, then the
// caller-specific parts added for the edge or the key caller (storefront.mapper.ts `storefrontFor`).
//
// Locales. The configuration depends on the locale (localised currency and market names), so there is one entry per
// locale the storefront supports. A visitor's `Accept-Language` is matched against the supported locales, which only
// the settings know, so the entry of the default locale is kept under the locale `und` ("undetermined", BCP 47) and
// carries the supported locales:
//
//   GET sf:und → hit:  negotiate the locale; the default one → done; another one → GET sf:<locale> → hit: done
//              → miss: settings row (one transaction) → SET sf:und, and sf:<locale> for another locale
//
// So the cache never holds more than one entry per supported locale and environment, whatever the visitors send. A
// settings change (OBE-070) deletes the tenant's `sf:*` entries of both environments.
//
// Redis down: entries are neither read nor written, and every request reads PostgreSQL (architecture §10). A missing
// settings row (a schema whose provisioning did not seed it) is answered as a tenant that is not ready:
// `403 TENANT_SUSPENDED`, the storefront's maintenance page.
//
// The payment account (OBE-038) is not part of the entry: every request asks the payment gateway for the account of
// the tenant's environment (its connection is cached for 60 seconds and dropped on the platform's `connection`
// invalidation), and `storefrontFor` adds it, so a change of the connection shows within that minute. Nor is the
// airline card's global switch (`AIRLINE_CARD_ENABLED`, OBE-050): `storefrontFor` adds the edge-only airline card from
// it and the entry's flag on every request, so no caller's answer is ever taken from another's.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { redisKeys, type RedisKey } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { ApiConfig } from "../config";
import { PAYMENT_GATEWAY, type GatewayAccount, type PaymentGateway } from "../payments/payment-gateway";
import { PlatformCache } from "../tenancy/platform-cache";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import {
  decodeCachedStorefront,
  encodeCachedStorefront,
  localesOf,
  negotiateLocale,
  referencedAssetIds,
  referencedCurrencies,
  storefrontFor,
  toCachedStorefront,
  type CachedStorefront,
  type StorefrontCaller,
  type StorefrontConfig,
  type StorefrontSource,
} from "./storefront.mapper";
import { StorefrontRepository } from "./storefront.repository";

/** The locale under which the entry of the default locale is cached (BCP 47 "undetermined"). */
export const DEFAULT_ENTRY_LOCALE = "und";

/** ioredis statuses in which the command client cannot answer: it waits to reconnect, or has been closed. */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

@Injectable()
export class StorefrontService {
  private readonly storefrontBaseDomain: string;
  private readonly publicApiUrl: string;
  private readonly airlineCardSwitch: boolean;

  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly repository: StorefrontRepository,
    private readonly platform: PlatformCache,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PAYMENT_GATEWAY) private readonly payments: PaymentGateway,
    config: ConfigService<ApiConfig, true>,
    private readonly logger: PinoLogger,
  ) {
    this.storefrontBaseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
    this.publicApiUrl = config.get("PUBLIC_OTA_API_URL", { infer: true });
    this.airlineCardSwitch = config.get("AIRLINE_CARD_ENABLED", { infer: true });
    logger.setContext(StorefrontService.name);
  }

  /** `storefront.get` for `caller`, in the locale `Accept-Language` asks for (else the default one). */
  async get(caller: StorefrontCaller, acceptLanguage: string | undefined): Promise<StorefrontConfig> {
    const entry = await this.entry(acceptLanguage);
    const payment = await this.paymentAccount(this.tenants.require());
    return storefrontFor(entry, {
      caller,
      publicApiUrl: this.publicApiUrl,
      payment,
      airlineCardSwitch: this.airlineCardSwitch,
    });
  }

  /**
   * The payment account of the tenant's environment; `null` when none can take payments, and when the platform row
   * cannot be read now (PostgreSQL down: the configuration still answers from the cache, without a payment method).
   */
  private async paymentAccount(tenant: RequestTenant): Promise<GatewayAccount | null> {
    try {
      return await this.payments.findAccount({
        tenantId: tenant.tenantId,
        environment: tenant.environment,
        requestId: this.tenants.requestId() ?? tenant.requestId,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "SERVICE_UNAVAILABLE") {
        this.logger.warn({ tenantId: tenant.tenantId }, "storefront.payment_account_unavailable");
        return null;
      }
      throw error;
    }
  }

  /** The caller-independent configuration of the request's tenant and environment for `Accept-Language`. */
  async entry(acceptLanguage: string | undefined): Promise<CachedStorefront> {
    const tenant = this.tenants.require();
    const defaults = await this.read(tenant, DEFAULT_ENTRY_LOCALE);
    if (defaults !== undefined) {
      const locale = negotiateLocale(acceptLanguage, localesOf(defaults), defaults.locale);
      if (locale === defaults.locale) {
        return defaults;
      }
      const cached = await this.read(tenant, locale);
      if (cached?.locale === locale) {
        return cached;
      }
    }
    return await this.fill(tenant, acceptLanguage);
  }

  /** Builds the entries from the settings row and caches the default one and, if another, the requested one. */
  private async fill(tenant: RequestTenant, acceptLanguage: string | undefined): Promise<CachedStorefront> {
    const source = await this.load(tenant);
    const defaults = toCachedStorefront(source);
    const locale = negotiateLocale(acceptLanguage, localesOf(defaults), defaults.locale);
    const entry = locale === defaults.locale ? defaults : toCachedStorefront(source, locale);
    await this.write(tenant, DEFAULT_ENTRY_LOCALE, defaults);
    if (entry !== defaults) {
      await this.write(tenant, entry.locale, entry);
    }
    return entry;
  }

  /** The settings row with its assets and currencies (one transaction), and the tenant's platform name. */
  private async load(tenant: RequestTenant): Promise<StorefrontSource> {
    const rows = await this.tx.run(async (trx) => {
      const settings = await this.repository.settings(trx);
      if (settings === undefined) {
        return undefined;
      }
      const assets = await this.repository.assetsByIds(trx, referencedAssetIds(settings));
      const currencies = await this.repository.currenciesByCodes(trx, referencedCurrencies(settings));
      return { settings, assets, currencies };
    });
    if (rows === undefined) {
      this.logger.warn({ tenantId: tenant.tenantId }, "storefront.settings_missing");
      throw new AppError("TENANT_SUSPENDED", {
        message: "The storefront of this OTA is not ready yet.",
      });
    }
    const platformTenant = await this.platform.tenantById(tenant.tenantId);
    return {
      tenantKey: tenant.key,
      tenantName: platformTenant?.name ?? null,
      environment: tenant.environment,
      storefrontBaseDomain: this.storefrontBaseDomain,
      ...rows,
    };
  }

  /** The key of an entry, or `undefined` when the locale cannot be a key part (the cache is then skipped). */
  private keyOf(tenant: RequestTenant, locale: string): RedisKey | undefined {
    try {
      return redisKeys.sf(tenant.tenantId, tenant.environment, locale);
    } catch (error) {
      if (error instanceof TypeError) {
        return undefined;
      }
      throw error;
    }
  }

  /** The cached entry, or `undefined` for a miss, an unreadable entry or a Redis that does not answer. */
  private async read(tenant: RequestTenant, locale: string): Promise<CachedStorefront | undefined> {
    const key = this.keyOf(tenant, locale);
    if (key === undefined || REDIS_DOWN.has(this.redis.status)) {
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
    const entry = decodeCachedStorefront(raw);
    if (entry === undefined) {
      this.logger.warn({ cache: "sf" }, "storefront.cache_entry_unreadable");
    }
    return entry;
  }

  /** Caches an entry for 5 minutes; Redis errors are ignored (the next request reads PostgreSQL again). */
  private async write(tenant: RequestTenant, locale: string, entry: CachedStorefront): Promise<void> {
    const key = this.keyOf(tenant, locale);
    if (key === undefined || REDIS_DOWN.has(this.redis.status)) {
      return;
    }
    try {
      await this.redis.set(key.key, encodeCachedStorefront(entry), "EX", key.ttlSeconds);
    } catch {
      // Not cached this time.
    }
  }
}
