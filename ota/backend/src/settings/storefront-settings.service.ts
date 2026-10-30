// console.settings.storefront.get and update (consoleGetStorefrontSettings, consoleUpdateStorefrontSettings;
// `settings:read` / `settings:write`; OBE-070, api-changes part 2 §2.3, OADR-0012 points 1, 4, 6 and 7, OADR-0008
// point 2, OADR-0004 point 1): the OTA's single `storefront_settings` row, shared by the test and live environments,
// as staff edit it (storefront-settings.mapper.ts).
//
// update, in order, in one transaction:
//
//   1. The row is read `FOR UPDATE` (missing → `403 TENANT_SUSPENDED`, the tenant is not ready) and its version compared
//      with `If-Match` (`412 PRECONDITION_FAILED`).
//   2. Turning the live airline card on (`airlineCard.enabledLive: true` sent while the stored value is `false`) while the
//      global `AIRLINE_CARD_ENABLED` switch is off → `403 FEATURE_DISABLED` (`details.feature = "airlineCard"`): live
//      airline-card payments wait for the M6 security review. A save that keeps a stored `true` (the switch went off
//      after it was turned on) or sends `false` passes, so the OTA can still save its other sections and turn the live
//      card off (lead decision (2e) of 2026-10-30, second batch, FIX-W35-OTA; before, every save that sent `true` was
//      refused, and an OTA in that state could not save the section at all). The test environment's flag may be set at
//      any time (storefront.get offers the method only while the switch is on, whatever is stored).
//   3. The sections sent replace their saved values, and the rules below are checked (`422 UNPROCESSABLE`,
//      `details.reason` and `details.path`, the first refused field in the document's order). The schema already
//      refused fonts outside the bundled list, colours that are not `#RRGGBB`, TTLs out of range and unknown enum values
//      (`400 VALIDATION_FAILED`).
//   4. The warnings: turning the airline card on (either flag from false to true) while an active markup or fee rule
//      adds an amount gives `airline_card_net_price` (OADR-0004 point 4: airline-card bookings are sold at the
//      airline's price).
//   5. The sections' columns are written with `version + 1`, and the `staff_actions` row (`settings.storefront.update`,
//      target `storefront_settings`/`sfs_default`) with the sent sections before and after and the versions, through
//      the shared redactor, in the same transaction.
//   6. After the commit, the storefront.get entries of both environments are deleted: `t:<tenantId>:<env>:sf:und` and
//      `sf:<locale>` for every locale the settings supported before or support now (the only entries storefront.get
//      ever writes, storefront.service.ts), so the next storefront.get reads the row. A Redis that does not answer is
//      logged (`storefront_settings.cache_not_deleted`) and the answer stands: the entries expire within their
//      5 minutes, as the hosted storefront's own `sessionStorage` copy does. The content pages' caches of the same
//      locales and environments, `t:<tenantId>:<env>:pages:<locale>` (OBE-072, storefront/public-pages.service.ts
//      `pageCacheKeys`), go in the same deletion: which page a locale serves follows the default and supported locales.
//
// The rules of step 3 (`details.reason` in brackets), each checked when a section it reads is sent, on the settings
// with the sent sections replaced:
//
//   brand        the time zone is one of `reference.time_zones` [unknown_time_zone]
//   branding     each asset id names an asset [asset_not_found] of its kind: logo, logo_dark, logo_square, favicon
//                [asset_kind]
//   locales      `supported` contains `default` [default_not_supported]
//   currencies   `default` and each of `supported` are active currencies of `reference.currencies`
//                [unknown_currency] with at most 2 minor units [currency_not_supported]: the money columns are
//                numeric(12,2), and flights.search refuses a currency with more, so a default currency of 3 (BHD,
//                KWD, …) would refuse every search that names none; `supported` contains `default`
//                [default_not_supported]
//   markets      each country is one of `reference.countries` [unknown_country] and listed once [duplicate_market];
//                `default` is null or a listed country [market_not_listed]; also when only locales or currencies are
//                sent: each market's currency and locale are supported [market_currency_not_supported,
//                market_locale_not_supported]
//   policies     `paymentTiming` is `authorize_before_booking` (OADR-0008 point 2) [payment_timing_not_supported]
//   legal        each `pageSlug` names a content page of `storefront_pages`, in any locale [page_not_found]
//   seo          `ogImageAssetId` names an asset of kind og_image [asset_not_found, asset_kind]
//   consent      each category once [duplicate_consent_category]; only `necessary` may be required
//                [consent_category_required]
//
// get answers the row (missing → `403 TENANT_SUSPENDED`). Both answer `ETag: "<version>"` and `Cache-Control:
// private, no-store` (the controller), and `airlineCard.liveAvailable`, the switch itself (read-only: not stored, not
// audited; a value an update sends is ignored, as the columns are written from `enabledTest` and `enabledLive` only),
// so the OTA admin offers the live switch only while it can be turned on (lead decision (2d) of 2026-10-30, second
// batch, FIX-W35-OTA). The settings hold no secret; the audit row holds what the sections hold.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { Clock } from "../common/clock";
import { redisKeys, type KeyEnvironment, type RedisKeyName } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { ApiConfig } from "../config";
import { consoleAction, StaffActionsWriter } from "../console/staff-actions.writer";
import { STOREFRONT_SETTINGS_ID } from "../provisioning/seeds/storefront-settings.seed";
import { pageCacheKeys } from "../storefront/public-pages.service";
import { canonicalLocale } from "../storefront/storefront.mapper";
import { StorefrontRepository, type StorefrontSettingsEditRow } from "../storefront/storefront.repository";
import { DEFAULT_ENTRY_LOCALE } from "../storefront/storefront.service";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  auditView,
  mergeSettings,
  withLiveAvailability,
  sectionsOf,
  toSettingsChanges,
  toStorefrontSettings,
  type SettingsSection,
  type SettingsWarning,
  type StorefrontSettings,
  type StorefrontSettingsUpdate,
  type StorefrontSettingsUpdateResult,
} from "./storefront-settings.mapper";

/** What the rules of an update look up, for the sections it sends (`lookupsFor`). */
export interface SettingsLookupRequest {
  readonly timeZones: readonly string[];
  readonly currencies: readonly string[];
  readonly countries: readonly string[];
  readonly assetIds: readonly string[];
  readonly pageSlugs: readonly string[];
}

/**
 * What the lookups found: the names, codes and slugs that exist, the minor units of each active currency, and the kind
 * of each asset that exists.
 */
export interface SettingsLookups {
  readonly timeZones: ReadonlySet<string>;
  readonly currencies: ReadonlyMap<string, number>;
  readonly countries: ReadonlySet<string>;
  readonly assetKinds: ReadonlyMap<string, string>;
  readonly pageSlugs: ReadonlySet<string>;
}

/** A refused field of an update: the `details` of its `422 UNPROCESSABLE` and a message without the value. */
export interface SettingsProblem {
  readonly reason: string;
  /**
   * The JSON pointer of the refused field in the settings: a field of the request body, except a saved market that
   * the currencies or locales sent no longer support (`/markets/list/<n>/currency` or `/locale`, sections not sent).
   */
  readonly path: string;
  readonly message: string;
}

/** An asset id of the settings, where it is in the body and the kind it must name (OADR-0012 point 2). */
interface AssetReference {
  readonly path: string;
  readonly id: string;
  readonly kind: string;
}

/** The branding's asset fields and their kinds. */
const BRANDING_ASSETS = [
  ["logoAssetId", "logo"],
  ["logoDarkAssetId", "logo_dark"],
  ["logoSquareAssetId", "logo_square"],
  ["faviconAssetId", "favicon"],
] as const;

/** The asset ids set in `section` of the settings. */
function assetReferences(settings: StorefrontSettings, section: "branding" | "seo"): AssetReference[] {
  const fields =
    section === "branding"
      ? BRANDING_ASSETS.map(([field, kind]) => ({ field, kind, id: settings.branding[field] }))
      : [{ field: "ogImageAssetId", kind: "og_image", id: settings.seo.ogImageAssetId }];
  return fields.flatMap(({ field, kind, id }) =>
    id === null ? [] : [{ path: `/${section}/${field}`, id, kind }],
  );
}

/** The reference rows, assets and pages the rules of `sent` need for `settings` (the update merged in). */
export function lookupsFor(
  settings: StorefrontSettings,
  sent: ReadonlySet<SettingsSection>,
): SettingsLookupRequest {
  const slugs = settings.legal.links.flatMap((link) => ("pageSlug" in link ? [link.pageSlug] : []));
  return {
    timeZones: sent.has("brand") ? [settings.brand.timeZone] : [],
    currencies: sent.has("currencies")
      ? [...new Set([settings.currencies.default, ...settings.currencies.supported])]
      : [],
    countries: sent.has("markets")
      ? [...new Set(settings.markets.list.map((market) => market.countryCode))]
      : [],
    assetIds: [
      ...new Set(
        [
          ...(sent.has("branding") ? assetReferences(settings, "branding") : []),
          ...(sent.has("seo") ? assetReferences(settings, "seo") : []),
        ].map((reference) => reference.id),
      ),
    ],
    pageSlugs: sent.has("legal") ? [...new Set(slugs)] : [],
  };
}

const problem = (reason: string, path: string, message: string): SettingsProblem => ({
  reason,
  path,
  message,
});

/** The minor units the money columns (`numeric(12,2)`) hold, as flights.search requires (searches.service.ts). */
const MAX_MINOR_UNITS = 2;

/** The refusal of the selling currency `code` at `path`, or `undefined` when it can be sold in. */
function currencyProblem(code: string, path: string, lookups: SettingsLookups): SettingsProblem | undefined {
  const minorUnits = lookups.currencies.get(code);
  if (minorUnits === undefined) {
    return problem("unknown_currency", path, "The currency is not an active currency.");
  }
  return minorUnits > MAX_MINOR_UNITS
    ? problem(
        "currency_not_supported",
        path,
        `Prices can be kept with at most ${MAX_MINOR_UNITS} decimals: this currency has ${minorUnits}.`,
      )
    : undefined;
}

function marketProblem(
  settings: StorefrontSettings,
  sent: ReadonlySet<SettingsSection>,
  lookups: SettingsLookups,
): SettingsProblem | undefined {
  const { markets, currencies, locales } = settings;
  const seen = new Set<string>();
  for (const [index, market] of markets.list.entries()) {
    const at = `/markets/list/${index}`;
    if (sent.has("markets")) {
      if (!lookups.countries.has(market.countryCode)) {
        return problem(
          "unknown_country",
          `${at}/countryCode`,
          "The market's country is not a known country.",
        );
      }
      if (seen.has(market.countryCode)) {
        return problem("duplicate_market", `${at}/countryCode`, "Each country can be one market only.");
      }
      seen.add(market.countryCode);
    }
    if (!currencies.supported.includes(market.currency)) {
      return problem(
        "market_currency_not_supported",
        `${at}/currency`,
        "The market's currency must be one of the supported currencies.",
      );
    }
    if (!locales.supported.includes(market.locale)) {
      return problem(
        "market_locale_not_supported",
        `${at}/locale`,
        "The market's locale must be one of the supported locales.",
      );
    }
  }
  if (
    sent.has("markets") &&
    markets.default !== null &&
    !markets.list.some((market) => market.countryCode === markets.default)
  ) {
    return problem("market_not_listed", "/markets/default", "The default market must be one of the markets.");
  }
  return undefined;
}

/**
 * The first field of the sent sections that a rule refuses (see the file header), or `undefined`. `settings` are the
 * saved settings with the sent sections replaced; `lookups` what `lookupsFor` asked for.
 */
export function settingsProblem(
  settings: StorefrontSettings,
  sent: ReadonlySet<SettingsSection>,
  lookups: SettingsLookups,
): SettingsProblem | undefined {
  if (sent.has("brand") && !lookups.timeZones.has(settings.brand.timeZone)) {
    return problem("unknown_time_zone", "/brand/timeZone", "The time zone is not a known IANA time zone.");
  }
  const brandingAsset = sent.has("branding") ? firstAssetProblem(settings, "branding", lookups) : undefined;
  if (brandingAsset !== undefined) {
    return brandingAsset;
  }
  if (sent.has("locales") && !settings.locales.supported.includes(settings.locales.default)) {
    return problem(
      "default_not_supported",
      "/locales/supported",
      "The supported locales must contain the default locale.",
    );
  }
  if (sent.has("currencies")) {
    const { default: defaultCurrency, supported } = settings.currencies;
    const checked: Array<[string, string]> = [
      [defaultCurrency, "/currencies/default"],
      ...supported.map((code, index): [string, string] => [code, `/currencies/supported/${index}`]),
    ];
    for (const [code, path] of checked) {
      const found = currencyProblem(code, path, lookups);
      if (found !== undefined) {
        return found;
      }
    }
    if (!supported.includes(defaultCurrency)) {
      return problem(
        "default_not_supported",
        "/currencies/supported",
        "The supported currencies must contain the default currency.",
      );
    }
  }
  if (sent.has("markets") || sent.has("currencies") || sent.has("locales")) {
    const found = marketProblem(settings, sent, lookups);
    if (found !== undefined) {
      return found;
    }
  }
  if (sent.has("policies") && settings.policies.paymentTiming !== "authorize_before_booking") {
    return problem(
      "payment_timing_not_supported",
      "/policies/paymentTiming",
      "Only authorize_before_booking is offered: the payment is authorised before the booking.",
    );
  }
  if (sent.has("legal")) {
    const missing = settings.legal.links.findIndex(
      (link) => "pageSlug" in link && !lookups.pageSlugs.has(link.pageSlug),
    );
    if (missing !== -1) {
      return problem(
        "page_not_found",
        `/legal/links/${missing}/pageSlug`,
        "The legal link names a content page that does not exist.",
      );
    }
  }
  const seoAsset = sent.has("seo") ? firstAssetProblem(settings, "seo", lookups) : undefined;
  if (seoAsset !== undefined) {
    return seoAsset;
  }
  return sent.has("consent") ? consentProblem(settings) : undefined;
}

/** The first asset id of `section` that names no asset, or an asset of another kind. */
function firstAssetProblem(
  settings: StorefrontSettings,
  section: "branding" | "seo",
  lookups: SettingsLookups,
): SettingsProblem | undefined {
  for (const reference of assetReferences(settings, section)) {
    const kind = lookups.assetKinds.get(reference.id);
    if (kind === undefined) {
      return problem("asset_not_found", reference.path, "The asset does not exist.");
    }
    if (kind !== reference.kind) {
      return problem("asset_kind", reference.path, `The asset must be an asset of kind ${reference.kind}.`);
    }
  }
  return undefined;
}

function consentProblem(settings: StorefrontSettings): SettingsProblem | undefined {
  const seen = new Set<string>();
  for (const [index, category] of settings.consent.categories.entries()) {
    const at = `/consent/categories/${index}`;
    if (seen.has(category.id)) {
      return problem("duplicate_consent_category", `${at}/id`, "Each cookie category can be listed once.");
    }
    seen.add(category.id);
    if (category.required && category.id !== "necessary") {
      return problem(
        "consent_category_required",
        `${at}/required`,
        "Only the necessary category can be required.",
      );
    }
  }
  return undefined;
}

/** The airline-card flags an update turns on (from false to true), as JSON pointers. */
export function airlineCardTurnedOn(before: StorefrontSettings, after: StorefrontSettings): string[] {
  return (["enabledTest", "enabledLive"] as const)
    .filter((flag) => after.airlineCard[flag] && !before.airlineCard[flag])
    .map((flag) => `/airlineCard/${flag}`);
}

/**
 * Whether `update` turns the live airline card on: `airlineCard.enabledLive: true` over a stored `false` (step 2 of the
 * file header). Keeping a stored `true`, or sending `false`, does not.
 */
export function liveAirlineCardTurnedOn(
  update: StorefrontSettingsUpdate,
  stored: Pick<StorefrontSettingsEditRow, "airlineCardEnabledLive">,
): boolean {
  return update.airlineCard?.enabledLive === true && !stored.airlineCardEnabledLive;
}

/** The warning of a flag turned on while amount-adding rules are active (OADR-0004 point 4). */
export function airlineCardWarning(path: string): SettingsWarning {
  return {
    code: "airline_card_net_price",
    message:
      "Airline-card bookings are sold at the airline's price: the active markup and fee rules do not apply to them.",
    path,
  };
}

/** The locales whose storefront.get entries may exist for a settings row: its default and supported ones. */
function cachedLocales(row: StorefrontSettingsEditRow): string[] {
  return [row.defaultLocale, ...row.supportedLocales].flatMap((locale) => canonicalLocale(locale) ?? []);
}

const ENVIRONMENTS: readonly KeyEnvironment[] = ["test", "live"];

/**
 * The storefront.get entries and the content pages' caches of both environments for the locales of `rows` (see the
 * file header, step 5). The tenant id is checked by the first key; a locale that cannot be a key part is left out,
 * because storefront.service.ts and public-pages.service.ts never cache under it.
 */
export function storefrontCacheKeys(
  tenantId: string,
  rows: readonly StorefrontSettingsEditRow[],
): RedisKeyName[] {
  const locales = [...new Set(rows.flatMap(cachedLocales))].filter(
    (locale) => locale !== DEFAULT_ENTRY_LOCALE,
  );
  return [...storefrontEntryKeys(tenantId, locales), ...pageCacheKeys(tenantId, locales)];
}

/** The storefront.get entries of both environments: `sf:und` and the locales'. */
function storefrontEntryKeys(tenantId: string, locales: readonly string[]): RedisKeyName[] {
  return ENVIRONMENTS.flatMap((environment) => [
    redisKeys.sf(tenantId, environment, DEFAULT_ENTRY_LOCALE).key,
    ...locales.flatMap((locale): RedisKeyName[] => {
      try {
        return [redisKeys.sf(tenantId, environment, locale).key];
      } catch (error) {
        if (error instanceof TypeError) {
          return [];
        }
        throw error;
      }
    }),
  ]);
}

/** A tenant whose settings row is missing (provisioning did not seed it): not ready, as storefront.get answers. */
function notReady(): AppError {
  return new AppError("TENANT_SUSPENDED", {
    message: "The storefront settings of this OTA are not ready yet.",
  });
}

/** What the update's transaction hands back for the answer and the cache deletion. */
interface UpdateOutcome {
  readonly before: StorefrontSettingsEditRow;
  readonly saved: StorefrontSettingsEditRow;
  readonly settings: StorefrontSettings;
  readonly warnings: SettingsWarning[];
}

@Injectable()
export class StorefrontSettingsService {
  private readonly airlineCardSwitch: boolean;

  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly repository: StorefrontRepository,
    private readonly writer: StaffActionsWriter,
    private readonly clock: Clock,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<ApiConfig, true>,
    @InjectPinoLogger(StorefrontSettingsService.name) private readonly logger: PinoLogger,
  ) {
    this.airlineCardSwitch = config.get("AIRLINE_CARD_ENABLED", { infer: true });
  }

  /** console.settings.storefront.get, with the live airline card's availability (see the file header). */
  async get(): Promise<StorefrontSettings> {
    const row = await this.tx.run((trx) => this.repository.editableSettings(trx));
    if (row === undefined) {
      throw notReady();
    }
    return withLiveAvailability(toStorefrontSettings(row), this.airlineCardSwitch);
  }

  /** console.settings.storefront.update with the `If-Match` of the request (see the file header). */
  async update(update: StorefrontSettingsUpdate, ifMatch: string): Promise<StorefrontSettingsUpdateResult> {
    const tenant = this.tenants.require();
    const outcome = await this.tx.run((trx) => this.save(trx, update, ifMatch));
    await this.deleteCaches(tenant, [outcome.before, outcome.saved]);
    return {
      ...withLiveAvailability(outcome.settings, this.airlineCardSwitch),
      warnings: outcome.warnings,
    };
  }

  /** Steps 1 to 5 of the file header, in the update's transaction. */
  private async save(
    trx: TenantTransaction,
    update: StorefrontSettingsUpdate,
    ifMatch: string,
  ): Promise<UpdateOutcome> {
    const row = await this.repository.editableSettings(trx, { forUpdate: true });
    if (row === undefined) {
      throw notReady();
    }
    if (!ifMatchSatisfied(ifMatch, row.version)) {
      throw new AppError("PRECONDITION_FAILED");
    }
    if (liveAirlineCardTurnedOn(update, row) && !this.airlineCardSwitch) {
      throw new AppError("FEATURE_DISABLED", {
        message: "The airline card cannot be enabled in the live environment yet.",
        details: { feature: "airlineCard" },
      });
    }
    const sections = sectionsOf(update);
    const sent = new Set(sections);
    const before = toStorefrontSettings(row);
    const merged = mergeSettings(before, update);
    const found = settingsProblem(merged, sent, await this.lookups(trx, lookupsFor(merged, sent)));
    if (found !== undefined) {
      throw new AppError("UNPROCESSABLE", {
        message: found.message,
        details: { reason: found.reason, path: found.path },
      });
    }
    const turnedOn = airlineCardTurnedOn(before, merged);
    const warnings =
      turnedOn.length > 0 && (await this.repository.hasAmountAddingRules(trx, this.clock.now()))
        ? turnedOn.map(airlineCardWarning)
        : [];
    const saved = await this.repository.updateSettings(trx, row.version, toSettingsChanges(update, row));
    if (saved === undefined) {
      // The row is locked since it was read: only a writer outside this service could have moved it.
      throw new AppError("PRECONDITION_FAILED");
    }
    const settings = toStorefrontSettings(saved);
    await this.writer.record(trx, {
      action: consoleAction("consoleUpdateStorefrontSettings"),
      targetType: "storefront_settings",
      targetId: STOREFRONT_SETTINGS_ID,
      before: auditView(before, sections),
      after: auditView(settings, sections),
    });
    return { before: row, saved, settings, warnings };
  }

  /** The lookups of `request`, in the update's transaction. */
  private async lookups(trx: TenantTransaction, request: SettingsLookupRequest): Promise<SettingsLookups> {
    const [timeZone] = request.timeZones;
    const timeZones =
      timeZone !== undefined && (await this.repository.timeZoneExists(trx, timeZone)) ? [timeZone] : [];
    const currencies = await this.repository.activeCurrencies(trx, request.currencies);
    const countries = await this.repository.countryCodes(trx, request.countries);
    const assets = await this.repository.assetsByIds(trx, request.assetIds);
    const pageSlugs = await this.repository.pageSlugs(trx, request.pageSlugs);
    return {
      timeZones: new Set(timeZones),
      currencies: new Map(currencies.map((currency) => [currency.code, currency.minorUnits])),
      countries: new Set(countries),
      assetKinds: new Map(assets.map((asset) => [asset.id, asset.kind])),
      pageSlugs: new Set(pageSlugs),
    };
  }

  /** Step 5 of the file header: never fails the answer, the change is saved. */
  private async deleteCaches(
    tenant: RequestTenant,
    rows: readonly StorefrontSettingsEditRow[],
  ): Promise<void> {
    const keys = storefrontCacheKeys(tenant.tenantId, rows);
    try {
      await this.redis.del(...keys);
    } catch {
      this.logger.warn(
        { tenantId: tenant.tenantId, keys: keys.length },
        "storefront_settings.cache_not_deleted",
      );
    }
  }
}
