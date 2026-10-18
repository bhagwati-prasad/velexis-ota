// The flight search use cases (OBE-021; ota/docs/flows/search-and-price.md §2 steps 2–5, OADR-0002, OADR-0005):
// `flights.search` (createFlightSearch), `flights.getSearch` (getFlightSearch) and `flights.listResults`
// (listFlightSearchResults).
//
// flights.search, synchronous only (OADR-0002 point 7: `resultOptions.async: true` is 403 FEATURE_DISABLED):
//   1. settings (`storefront_settings`: default currency, offer TTL, `search_defaults`) and the currency (body →
//      X-Currency → default; a currency of `reference.currencies` with at most 2 minor units, which the numeric(12,2)
//      columns hold), then the Amadeus request (offers.mapper.ts `buildAmadeusSearch`);
//   2. single flight (OADR-0002 point 2): `t:<tenantId>:<env>:search:<sha256>` of the normalised criteria (the Amadeus
//      request, the channel and the customer) for 30 s. The first request sets it (`SET NX`) and runs the search; an
//      identical request meanwhile waits up to 30 s for the search id the first one writes there after its commit
//      (in place of its own value, keeping the key's expiry), and answers with that search. When the first one fails
//      it deletes the key and a waiting request runs the search itself. Without Redis there is no single flight (and
//      the Amadeus buckets answer 503);
//   3. the search row is inserted `pending` in a short transaction of its own (so the client's `supplier_requests` row
//      links to it), then Amadeus is called outside any transaction (AmadeusClient: rate limits, timeouts, retries,
//      error mapping). A failed call marks the row `failed` with the public error code and the error is answered;
//   4. one transaction prices every offer with the engine (step `search`: markup only), drops offers over the SIMPLE
//      `maxPrice` per traveller (selling) and offers that cannot be read or priced, keeps at most 250, computes the
//      best scores, facets and highlights, inserts the `flight_offers` rows and completes the search
//      (`expires_at = now + offer_ttl_minutes`). When it fails the row is marked `failed` too: none stays `pending`;
//   5. the answer is the search with the first page (resultOptions: limit, sort, view) read back like listResults.
//
// Reads: a search is readable in the request's environment only; a search bound to a customer only by that customer
// and in console scope (`404` otherwise). getSearch answers `status: "expired"` after `expires_at` (the document's
// getFlightSearch has no 410); listResults answers `410 SEARCH_EXPIRED`, `409 SEARCH_NOT_COMPLETED` for a pending or
// failed search, and pages in SQL (searches.repository.ts) with facets over the summary columns (facets.ts).
//
// Dictionaries come from the reference schema, completed by the Amadeus dictionaries of the search. The verbatim
// Amadeus dictionaries (`dictionaries.amadeus`, console scope) are left out: the document's AmadeusDictionaries
// requires a property literally named `key` in `locations` and `currencies` (a defect of the merged Amadeus
// definition), which no Amadeus answer has, so no answer carrying them could match the document.
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { AppError, isErrorCode, toErrorEnvelope, type ErrorCode } from "@velexis/errors";
import type { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { AmadeusClient, type AmadeusResponse } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { Clock } from "../common/clock";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { redisKeys, type RedisKey } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { priceOffer } from "../pricing/pricing-engine";
import { Money, PricingInputError, type PricingResult } from "../pricing/pricing.types";
import { RulesRepository } from "../pricing/rules.repository";
import { displayLanguage, ReferenceNames } from "../reference/reference.mapper";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  bestScores,
  computeFacets,
  decodeCursor,
  emptyFacets,
  encodeCursor,
  highlightsOf,
  parseResultFilters,
  resultFingerprint,
  type FacetRow,
  type Facets,
  type FlightSearchHighlights,
  type ResultFilters,
  type ResultQuery,
  type ResultSort,
} from "./facets";
import {
  buildAmadeusSearch,
  codesOf,
  criteriaRequestOf,
  leadPricing,
  MAX_OFFERS_PER_SEARCH,
  netTotalOf,
  offerColumns,
  parseOffer,
  parseSearchDefaults,
  pricingInputOf,
  requestedCurrencyOf,
  searchCriteriaOf,
  searchSummaryOf,
  toFlightOffer,
  travelerMarkupShares,
  type AmadeusSearchRequest,
  type DisplayNames,
  type FlightOffer,
  type FlightSearchCreateRequest,
  type LocationInfo,
  type OfferScope,
  type OfferView,
  type ParsedOffer,
} from "./offers.mapper";
import {
  SearchesRepository,
  sortKeysOf,
  validCursorKeys,
  type ListedOffer,
  type SearchRow,
} from "./searches.repository";

type Schemas = components["schemas"];
export type FlightSearch = Schemas["FlightSearch"];
export type FlightSearchResultsPage = Schemas["FlightSearchResultsPage"];
type Dictionaries = Schemas["Dictionaries"];
type DictionaryLocation = Schemas["DictionaryLocation"];
type Warning = Schemas["Warning"];
type OneWayCombination = Schemas["FlightSearchOneWayCombination"];
type MoneyAmount = Schemas["Money"];

/** The input of flights.search. */
export interface CreateSearchInput {
  readonly body: FlightSearchCreateRequest;
  /** `X-Currency`. */
  readonly currencyHeader?: string | undefined;
  /** `Accept-Language`: the language of the dictionaries' country and currency names. */
  readonly acceptLanguage?: string | undefined;
}

/** The names of facet labels stored with a search: the reference data's English names. */
const STORED_NAMES = new ReferenceNames(undefined);

/** The created search and its `Location`. */
export interface CreatedSearch {
  readonly search: FlightSearch;
  readonly location: string;
}

/** The query of flights.listResults (the filters of ResultQuery plus paging). */
export interface ListResultsQuery extends ResultQuery {
  readonly sort?: ResultSort | undefined;
  readonly view?: OfferView | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Defaults of the result options and of listResults (the document's `limit` default). */
const DEFAULT_PAGE_LIMIT = 20;
const DEFAULT_SORT: ResultSort = "best";
const DEFAULT_VIEW: OfferView = "summary";
/** Seconds a client waits before polling a pending search again. */
const PENDING_RETRY_SECONDS = 1;
/** How often a request waiting for an identical search checks the single-flight key. */
export const SINGLE_FLIGHT_POLL_MS = 100;
/** The value of the single-flight key while the first request runs (then the search id). */
const RUNNING = "running:";
const SEARCH_ID = /^srch_[0-9A-Za-z]{16,40}$/;
/** The minor units the money columns (`numeric(12,2)`) can hold. */
const MAX_MINOR_UNITS = 2;

/** ioredis statuses in which the command client cannot answer. */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

/** Deletes the key only while it still holds the caller's value (another request may own it after expiry). */
const DELETE_IF_UNCHANGED = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0`;

/**
 * Replaces the caller's value with the search id, keeping the key's expiry: the key lives 30 s from the first request
 * (OADR-0002 point 2, no result cache beyond it), and a key another request took after expiry is left alone.
 */
const REPLACE_IF_UNCHANGED = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL") end
return 0`;

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with object keys sorted at every level: equal criteria give equal text, whatever the key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The Amadeus dictionaries of a search answer (`locations`, `carriers`, `aircraft`, `currencies`). */
interface AmadeusDictionaries {
  readonly locations: Readonly<Record<string, { readonly cityCode?: string; readonly countryCode?: string }>>;
  readonly carriers: Readonly<Record<string, string>>;
  readonly aircraft: Readonly<Record<string, string>>;
  readonly currencies: Readonly<Record<string, string>>;
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function amadeusDictionaries(value: unknown): AmadeusDictionaries {
  const raw = isRecord(value) ? value : {};
  const locations: Record<string, { cityCode?: string; countryCode?: string }> = {};
  if (isRecord(raw["locations"])) {
    for (const [code, location] of Object.entries(raw["locations"])) {
      if (isRecord(location)) {
        const cityCode = location["cityCode"];
        const countryCode = location["countryCode"];
        locations[code] = {
          ...(typeof cityCode === "string" ? { cityCode } : {}),
          ...(typeof countryCode === "string" ? { countryCode } : {}),
        };
      }
    }
  }
  return {
    locations,
    carriers: stringMap(raw["carriers"]),
    aircraft: stringMap(raw["aircraft"]),
    currencies: stringMap(raw["currencies"]),
  };
}

/** Display names and the response's Dictionaries, from the reference schema and the Amadeus dictionaries. */
interface NameSet {
  readonly names: DisplayNames;
  readonly dictionaries: Dictionaries;
}

/** The codes a response needs names for. */
interface CodeSet {
  readonly locations: Set<string>;
  readonly carriers: Set<string>;
  readonly aircraft: Set<string>;
  readonly currencies: Set<string>;
}

function emptyCodes(): CodeSet {
  return { locations: new Set(), carriers: new Set(), aircraft: new Set(), currencies: new Set() };
}

function addOfferCodes(codes: CodeSet, offer: ParsedOffer): void {
  const found = codesOf(offer);
  found.locations.forEach((code) => codes.locations.add(code));
  found.carriers.forEach((code) => codes.carriers.add(code));
  found.aircraft.forEach((code) => codes.aircraft.add(code));
}

/** A logo URL the document's `format: uri` accepts. */
const ABSOLUTE_URL = /^https?:\/\/[^\s]+$/;

@Injectable()
export class SearchesService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly requestContext: RequestContext,
    private readonly repository: SearchesRepository,
    private readonly rules: RulesRepository,
    private readonly amadeus: AmadeusClient,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(SearchesService.name);
  }

  // ---- flights.search ----------------------------------------------------------------------------------------------

  /** Runs (or joins) a synchronous search and answers it with its first page. */
  async create(input: CreateSearchInput): Promise<CreatedSearch> {
    const tenant = this.tenants.require();
    const scope = this.scope();
    const body = input.body;
    if (body.resultOptions?.async === true) {
      throw new AppError("FEATURE_DISABLED", {
        message: "Asynchronous search is not available: search synchronously.",
        details: { feature: "asyncSearch" },
      });
    }
    const prepared = await this.prepare(tenant, body, input.currencyHeader, scope);
    const key = redisKeys.search(tenant.tenantId, tenant.environment, prepared.criteriaHash);
    const searchId = await this.singleFlight(key, () => this.run(tenant, prepared));
    const options = body.resultOptions ?? {};
    const search = await this.tx.run(async (trx) => {
      const row = await this.repository.searchById(trx, searchId);
      if (row === undefined) {
        throw new Error("a completed search is not readable in its own tenant");
      }
      return await this.searchResponse(
        trx,
        row,
        scope,
        {
          limit: options.limit ?? DEFAULT_PAGE_LIMIT,
          sort: options.sort ?? DEFAULT_SORT,
          view: options.view ?? DEFAULT_VIEW,
        },
        new ReferenceNames(displayLanguage(input.acceptLanguage)),
      );
    });
    return { search, location: `/v1/flight-searches/${searchId}` };
  }

  /** The request, checked, with its settings, currency, Amadeus request and single-flight hash. */
  private async prepare(
    tenant: RequestTenant,
    body: FlightSearchCreateRequest,
    currencyHeader: string | undefined,
    scope: OfferScope,
  ): Promise<PreparedSearch> {
    const requested = requestedCurrencyOf(body);
    const loaded = await this.tx.run(async (trx) => {
      const settings = await this.repository.settings(trx);
      if (settings === undefined) {
        return undefined;
      }
      const currency = requested ?? currencyHeader ?? settings.defaultCurrency;
      const [row] = await this.repository.currencies(trx, [currency]);
      return { settings, currency, minorUnits: row?.minorUnits };
    });
    if (loaded === undefined) {
      this.logger.warn({ tenantId: tenant.tenantId }, "search.settings_missing");
      throw new AppError("TENANT_SUSPENDED", { message: "The storefront of this OTA is not ready yet." });
    }
    const { settings, currency, minorUnits } = loaded;
    if (minorUnits === undefined || minorUnits > MAX_MINOR_UNITS) {
      const path =
        requested !== undefined
          ? body.mode === "simple"
            ? "/currencyCode"
            : "/query/currencyCode"
          : currencyHeader !== undefined
            ? "/header/X-Currency"
            : undefined;
      if (path === undefined) {
        throw new AppError("UNPROCESSABLE", {
          message: "The storefront's default currency cannot be searched in.",
        });
      }
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path, code: "unsupported", message: "This currency is not supported." }],
      });
    }
    const defaults = parseSearchDefaults(settings.searchDefaults);
    const amadeus = buildAmadeusSearch(body, currency, defaults, scope);
    if ("kind" in amadeus) {
      if (amadeus.kind === "sources") {
        throw new AppError("FEATURE_DISABLED", { message: amadeus.message, details: { feature: "sources" } });
      }
      if (amadeus.kind === "negotiated") {
        throw new AppError("SCOPE_NOT_ALLOWED", {
          message: amadeus.message,
          details: { reason: "negotiated_fares" },
        });
      }
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path: amadeus.path, code: amadeus.code, message: amadeus.message }],
      });
    }
    const channel = scope === "console" ? "console" : "storefront";
    const customerId = tenant.actor.type === "customer" ? tenant.actor.id : null;
    const criteriaHash = createHash("sha256")
      .update(canonicalJson({ amadeus, channel, customerId }))
      .digest("hex");
    return {
      request: criteriaRequestOf(body),
      amadeus,
      currency,
      minorUnits,
      offerTtlMinutes: settings.offerTtlMinutes,
      channel,
      customerId,
      criteriaHash,
      maxPrice: body.mode === "simple" ? body.maxPrice : undefined,
    };
  }

  /**
   * Runs `search` once per key at a time (OADR-0002 point 2) and returns its search id. A request that finds the key
   * taken waits for the id; when the key disappears without one (the first search failed) it takes the key itself.
   */
  private async singleFlight(key: RedisKey, search: () => Promise<string>): Promise<string> {
    const token = `${RUNNING}${this.ids.newId("srch")}`;
    // An elapsed-time bound (the key's lifetime), not a business time: the monotonic clock, not `Clock`.
    const deadline = performance.now() + key.ttlSeconds * 1000;
    while (performance.now() < deadline) {
      const acquired = await this.tryRedis(() => this.redis.set(key.key, token, "EX", key.ttlSeconds, "NX"));
      if (acquired === undefined) {
        return await search(); // Redis cannot answer: no single flight.
      }
      if (acquired === "OK") {
        try {
          const searchId = await search();
          await this.tryRedis(() => this.redis.eval(REPLACE_IF_UNCHANGED, 1, key.key, token, searchId));
          return searchId;
        } catch (error) {
          await this.tryRedis(() => this.redis.eval(DELETE_IF_UNCHANGED, 1, key.key, token));
          throw error;
        }
      }
      const joined = await this.waitForSearch(key, deadline);
      if (joined !== undefined) {
        this.logger.info({ searchId: joined }, "search.single_flight_joined");
        return joined;
      }
    }
    return await search();
  }

  /** The search id the running request writes under `key`, or `undefined` when the key goes away or time runs out. */
  private async waitForSearch(key: RedisKey, deadline: number): Promise<string | undefined> {
    while (performance.now() < deadline) {
      const value = await this.tryRedis(() => this.redis.get(key.key));
      if (value === undefined || value === null) {
        return undefined;
      }
      if (SEARCH_ID.test(value)) {
        return value;
      }
      await sleep(SINGLE_FLIGHT_POLL_MS);
    }
    return undefined;
  }

  /** A Redis command, or `undefined` when Redis cannot answer (logged once per failure). */
  private async tryRedis<T>(command: () => Promise<T>): Promise<T | undefined> {
    if (REDIS_DOWN.has(this.redis.status)) {
      return undefined;
    }
    try {
      return await command();
    } catch (error) {
      this.logger.warn({ err: error }, "search.single_flight_unavailable");
      return undefined;
    }
  }

  /** Inserts the pending search, calls Amadeus and stores the results; returns the search id. */
  private async run(tenant: RequestTenant, prepared: PreparedSearch): Promise<string> {
    const searchId = this.ids.newId("srch");
    const createdAt = this.clock.now();
    const summary = searchSummaryOf(prepared.request);
    const [outbound, inbound] = summary.legs;
    await this.tx.run((trx) =>
      this.repository.insertSearch(trx, {
        id: searchId,
        environment: tenant.environment,
        kind: "offers",
        mode: prepared.request.mode,
        channel: prepared.channel,
        customer_id: prepared.customerId,
        criteria: JSON.stringify(prepared.request),
        amadeus_request: JSON.stringify(prepared.amadeus),
        origin_iata: outbound?.originCode ?? null,
        destination_iata: outbound?.destinationCode ?? null,
        departure_date: outbound?.departureDate ?? null,
        return_date: summary.tripType === "round_trip" ? (inbound?.departureDate ?? null) : null,
        adults: summary.travelers.adults,
        children: summary.travelers.children,
        infants: summary.travelers.infants,
        cabin: summary.travelClass ?? null,
        currency: prepared.currency,
        status: "pending",
        expires_at: addMinutes(createdAt, prepared.offerTtlMinutes),
        created_at: createdAt,
        updated_at: createdAt,
      }),
    );
    const context: AmadeusCallContext = {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: "flights.search",
      requestId: this.tenants.requestId() ?? tenant.requestId,
      searchId,
    };
    const started = performance.now();
    let reply: AmadeusResponse<unknown>;
    try {
      reply =
        prepared.amadeus.operationId === "getFlightOffers"
          ? await this.amadeus.getFlightOffers(context, {
              query: prepared.amadeus.query as Parameters<AmadeusClient["getFlightOffers"]>[1]["query"],
            })
          : await this.amadeus.searchFlightOffers(context, {
              // The body was validated against FlightSearchAdvancedQuery, the document's copy of the Amadeus
              // getFlightOffersQuery; the generated Amadeus type differs only in how it spells the same fields.
              body: prepared.amadeus.body as unknown as Parameters<
                AmadeusClient["searchFlightOffers"]
              >[1]["body"],
            });
    } catch (error) {
      await this.fail(searchId, error, Math.round(performance.now() - started), "search.failed");
      throw error;
    }
    try {
      await this.complete(tenant, searchId, prepared, reply);
    } catch (error) {
      // The offers could not be priced or stored (their transaction rolled back): the search must not stay `pending`.
      await this.fail(searchId, error, reply.call.durationMs, "search.store_failed");
      throw error;
    }
    return searchId;
  }

  /** Marks a pending search `failed` with the public code of `error` (its own transaction; never throws). */
  private async fail(searchId: string, error: unknown, durationMs: number, event: string): Promise<void> {
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    await this.tx
      .run((trx) => this.repository.failSearch(trx, searchId, code, durationMs, this.clock.now()))
      .catch((failure: unknown) => this.logger.error({ err: failure, searchId }, "search.fail_not_recorded"));
    this.logger.warn({ searchId, errorCode: code, durationMs }, event);
  }

  /** Prices and stores the offers of an Amadeus answer and completes the search, in one transaction. */
  private async complete(
    tenant: RequestTenant,
    searchId: string,
    prepared: PreparedSearch,
    reply: AmadeusResponse<unknown>,
  ): Promise<void> {
    const body = isRecord(reply.body) ? reply.body : {};
    const amadeusDictionary = amadeusDictionaries(body["dictionaries"]);
    const cityOf = (code: string): string | null => amadeusDictionary.locations[code]?.cityCode ?? null;
    const data: unknown[] = Array.isArray(body["data"]) ? body["data"] : [];
    const seen = new Set<string>();
    const offers: Array<{
      readonly payload: unknown;
      readonly parsed: ParsedOffer;
      readonly position: number;
    }> = [];
    let unreadable = 0;
    data.forEach((payload, position) => {
      const parsed = parseOffer(payload);
      if (parsed === undefined || seen.has(parsed.amadeusId) || parsed.price.currency !== prepared.currency) {
        unreadable += 1;
        return;
      }
      seen.add(parsed.amadeusId);
      offers.push({ payload, parsed, position });
    });
    const now = this.clock.now();
    const expiresAt = addMinutes(now, prepared.offerTtlMinutes);
    const stored = await this.tx.run(async (trx) => {
      const rules = await this.rules.loadActiveRules(trx);
      if (rules.invalidRules.length > 0) {
        this.logger.warn(
          {
            searchId,
            invalidRules: rules.invalidRules.map(({ table, id, reason }) => ({ table, id, reason })),
          },
          "search.pricing_rules_skipped",
        );
      }
      const codes = emptyCodes();
      offers.forEach(({ parsed }) => addOfferCodes(codes, parsed));
      const nameSet = await this.names(trx, codes, amadeusDictionary, STORED_NAMES);
      const countryOf = (code: string): string | null => nameSet.names.location(code)?.countryCode ?? null;
      const rows: StoredCandidate[] = [];
      let unpriced = 0;
      for (const { payload, parsed, position } of offers) {
        const columns = offerColumns(parsed, cityOf);
        const netTotal = netTotalOf(parsed, prepared.minorUnits);
        if (netTotal === undefined) {
          unpriced += 1;
          continue;
        }
        let result: PricingResult;
        try {
          result = priceOffer(
            pricingInputOf(parsed, columns, {
              at: now,
              minorUnits: prepared.minorUnits,
              netTotal,
              channel: prepared.channel,
              countryOf,
            }),
            rules.markupRules,
            rules.feeRules,
            { kind: "search" },
          );
        } catch (error) {
          if (!(error instanceof PricingInputError)) {
            throw error;
          }
          unpriced += 1;
          continue;
        }
        if (prepared.maxPrice !== undefined && exceedsMaxPrice(parsed, result, prepared)) {
          continue;
        }
        rows.push({ id: this.ids.newId("off"), payload, parsed, position, columns, result });
        if (rows.length === MAX_OFFERS_PER_SEARCH) {
          break;
        }
      }
      if (unreadable + unpriced > 0) {
        this.logger.warn({ searchId, unreadable, unpriced }, "search.offers_skipped");
      }
      const scores = bestScores(
        rows.map((row) => ({
          id: row.id,
          sellingTotal: row.result.selling,
          totalDurationMinutes: row.columns.totalDurationMinutes,
          maxStops: row.columns.maxStops,
        })),
      );
      const money = this.moneyOf(prepared.currency, prepared.minorUnits);
      const facetRows = rows.map((row) => facetRowOf(row));
      const brandLabels = new Map<string, string>();
      for (const row of rows) {
        for (const detail of leadPricing(row.parsed)?.fareDetails ?? []) {
          if (detail.brandedFare !== null && detail.brandedFareLabel !== null) {
            brandLabels.set(detail.brandedFare, detail.brandedFareLabel);
          }
        }
      }
      const facets = computeFacets(
        facetRows,
        {},
        {
          money,
          carrierLabel: (code) => nameSet.names.carrierName(code),
          brandedFareLabel: (code) => brandLabels.get(code) ?? null,
        },
      );
      const highlights = highlightsOf(
        facetRows.map((row) => ({ ...row, bestScore: scores.get(row.id) ?? "1" })),
        money,
      );
      const amadeusIds = new Map(rows.map((row) => [row.parsed.amadeusId, row.id]));
      await this.repository.insertOffers(
        trx,
        rows.map((row) => ({
          id: row.id,
          environment: tenant.environment,
          origin: "search",
          search_id: searchId,
          amadeus_offer_id: row.parsed.amadeusId,
          source: row.parsed.source,
          position: row.position,
          payload: JSON.stringify(row.payload),
          currency: prepared.currency,
          net_total: row.result.net,
          markup_amount: row.result.markupTotal,
          selling_total: row.result.selling,
          markup_rule_id: row.result.markupRuleId,
          validating_carrier: row.columns.validatingCarrier,
          marketing_carriers: [...row.columns.marketingCarriers],
          origin_iata: row.columns.originIata,
          destination_iata: row.columns.destinationIata,
          first_departure_local: row.columns.firstDepartureLocal,
          last_arrival_local: row.columns.lastArrivalLocal,
          itinerary_departure_minutes: [...row.columns.departureMinutes],
          itinerary_arrival_minutes: [...row.columns.arrivalMinutes],
          itinerary_duration_minutes: [...row.columns.durationMinutes],
          max_stops: row.columns.maxStops,
          total_duration_minutes: row.columns.totalDurationMinutes,
          main_cabin: row.columns.mainCabin,
          min_checked_bags: row.columns.minCheckedBags,
          refundable: row.columns.refundable,
          changeable: row.columns.changeable,
          branded_fares: [...row.columns.brandedFares],
          best_score: scores.get(row.id) ?? null,
          bookable_seats: row.columns.bookableSeats,
          last_ticketing_date: row.columns.lastTicketingDate,
          instant_ticketing_required: row.columns.instantTicketingRequired,
          expires_at: expiresAt,
          created_at: now,
          updated_at: now,
        })),
      );
      const meta = isRecord(body["meta"]) ? body["meta"] : {};
      await this.repository.completeSearch(trx, searchId, {
        resultCount: rows.length,
        dictionaries: isRecord(body["dictionaries"]) ? body["dictionaries"] : {},
        warnings: Array.isArray(body["warnings"]) ? body["warnings"] : [],
        facets,
        highlights,
        oneWayCombinations: oneWayCombinationsOf(meta["oneWayCombinations"], amadeusIds),
        durationMs: reply.call.durationMs,
        expiresAt,
        completedAt: now,
      });
      return rows.length;
    });
    this.logger.info(
      { searchId, resultCount: stored, amadeusCount: data.length, durationMs: reply.call.durationMs },
      "search.completed",
    );
  }

  // ---- flights.getSearch -------------------------------------------------------------------------------------------

  /** The search without offers; `expired` after `expires_at`. */
  async get(searchId: string, acceptLanguage?: string): Promise<FlightSearch> {
    const scope = this.scope();
    const language = new ReferenceNames(displayLanguage(acceptLanguage));
    return await this.tx.run(async (trx) => {
      const row = await this.readable(trx, searchId, scope);
      return await this.searchResponse(trx, row, scope, undefined, language);
    });
  }

  // ---- flights.listResults -----------------------------------------------------------------------------------------

  /** One page of the offers of a search with filters, sort and facets. */
  async listResults(
    searchId: string,
    query: ListResultsQuery,
    acceptLanguage?: string,
  ): Promise<FlightSearchResultsPage> {
    const scope = this.scope();
    const language = new ReferenceNames(displayLanguage(acceptLanguage));
    const sort = query.sort ?? DEFAULT_SORT;
    const view = query.view ?? DEFAULT_VIEW;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const filters = parseResultFilters(query);
    const fingerprint = resultFingerprint(searchId, filters, sort);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (
      query.cursor !== undefined &&
      (after === undefined || after.fingerprint !== fingerprint || !validCursorKeys(sort, after.keys))
    ) {
      throw new AppError("INVALID_REQUEST", {
        message:
          "The cursor belongs to other filters or another sort, or was changed: start again without a cursor.",
        details: { reason: "cursor_mismatch" },
      });
    }
    return await this.tx.run(async (trx) => {
      const row = await this.readable(trx, searchId, scope);
      const now = this.clock.now();
      if (row.status === "pending") {
        throw new AppError("SEARCH_NOT_COMPLETED", {
          details: { status: "pending", retryAfterSeconds: PENDING_RETRY_SECONDS },
        });
      }
      if (row.status === "failed") {
        throw new AppError("SEARCH_NOT_COMPLETED", {
          details: { status: "failed", errorCode: row.errorCode },
        });
      }
      if (row.expiresAt.getTime() <= now.getTime()) {
        throw new AppError("SEARCH_EXPIRED");
      }
      const currency = row.currency ?? "";
      const minorUnits = await this.minorUnits(trx, currency);
      const money = this.moneyOf(currency, minorUnits);
      const summaries = await this.repository.offerSummaries(trx, searchId);
      const storedFacets = isRecord(row.facets) ? (row.facets as unknown as Facets) : emptyFacets();
      const labels = facetLabels(storedFacets);
      const page = await this.page(trx, row, scope, {
        filters,
        sort,
        view,
        limit,
        after,
        fingerprint,
        minorUnits,
      });
      const codes = page.codes;
      const facets = computeFacets(summaries, filters, {
        money,
        carrierLabel: (code) => labels.carriers.get(code) ?? null,
        brandedFareLabel: (code) => labels.brandedFares.get(code) ?? null,
      });
      facets.carriers.forEach((bucket) => codes.carriers.add(bucket.value));
      codes.currencies.add(currency);
      const nameSet = await this.names(trx, codes, amadeusDictionaries(row.dictionaries), language);
      return {
        data: page.map(nameSet.names),
        page: { nextCursor: page.nextCursor, limit },
        searchId,
        currency,
        total: facets.total,
        sort,
        facets,
        dictionaries: nameSet.dictionaries,
        expiresAt: row.expiresAt.toISOString(),
      };
    });
  }

  // ---- Shared reads ------------------------------------------------------------------------------------------------

  /** The scope of the request: console after the scope guard marked it, else customer. */
  private scope(): OfferScope {
    return this.requestContext.isConsoleScope() ? "console" : "customer";
  }

  /** The search, if the request may read it: same environment, and a customer's search only for them or console. */
  private async readable(trx: TenantTransaction, searchId: string, scope: OfferScope): Promise<SearchRow> {
    const tenant = this.tenants.require();
    const row = await this.repository.searchById(trx, searchId);
    const ownCustomer =
      row?.customerId === null ||
      scope === "console" ||
      (tenant.actor.type === "customer" && tenant.actor.id === row?.customerId);
    if (row === undefined || row.environment !== tenant.environment || !ownCustomer) {
      throw new AppError("NOT_FOUND", { message: "No flight search with this id." });
    }
    return row;
  }

  private async minorUnits(trx: TenantTransaction, currency: string): Promise<number> {
    const [row] = await this.repository.currencies(trx, [currency]);
    return row?.minorUnits ?? MAX_MINOR_UNITS;
  }

  private moneyOf(currency: string, minorUnits: number): (amount: string) => MoneyAmount {
    return (amount) => ({ amount: new Money(amount).toFixed(minorUnits), currency });
  }

  /**
   * A page of offers: `limit` rows after `after`, read with one more to know whether a next page exists. Returns the
   * codes the page needs names for and a function that maps the rows once the names are loaded.
   */
  private async page(
    trx: TenantTransaction,
    search: SearchRow,
    scope: OfferScope,
    options: {
      readonly filters: ResultFilters;
      readonly sort: ResultSort;
      readonly view: OfferView;
      readonly limit: number;
      readonly after: { readonly keys: readonly (string | number)[]; readonly id: string } | undefined;
      readonly fingerprint: string;
      readonly minorUnits: number;
    },
  ): Promise<{ codes: CodeSet; nextCursor: string | null; map: (names: DisplayNames) => FlightOffer[] }> {
    const codes = emptyCodes();
    if (options.limit === 0) {
      return { codes, nextCursor: null, map: () => [] };
    }
    const listed = await this.repository.listOffers(
      trx,
      search.id,
      options.filters,
      options.sort,
      options.after,
      options.limit + 1,
    );
    const rows = listed.slice(0, options.limit);
    const last = rows.at(-1);
    const nextCursor =
      listed.length > options.limit && last !== undefined
        ? encodeCursor({
            fingerprint: options.fingerprint,
            keys: sortKeysOf(last, options.sort),
            id: last.id,
          })
        : null;
    for (const row of rows) {
      const parsed = parseOffer(row.payload);
      if (parsed !== undefined) {
        addOfferCodes(codes, parsed);
      }
    }
    const offerIds = await this.offerIdsOf(trx, search, rows);
    const amadeusDictionary = amadeusDictionaries(search.dictionaries);
    const highlights = isRecord(search.highlights) ? (search.highlights as FlightSearchHighlights) : null;
    const now = this.clock.now();
    return {
      codes,
      nextCursor,
      map: (names) =>
        rows.flatMap(
          (row: ListedOffer) =>
            toFlightOffer(row, {
              scope,
              view: options.view,
              now,
              minorUnits: options.minorUnits,
              highlights,
              offerIds,
              names,
              cityOf: (code) => amadeusDictionary.locations[code]?.cityCode ?? null,
            }) ?? [],
        ),
    };
  }

  /** Amadeus offer id → `off_…` of the search, when a row of the page names upsell offers. */
  private async offerIdsOf(
    trx: TenantTransaction,
    search: SearchRow,
    rows: readonly ListedOffer[],
  ): Promise<ReadonlyMap<string, string>> {
    const needed = rows.some((row) => (parseOffer(row.payload)?.upsellFlightOfferIds.length ?? 0) > 0);
    if (!needed) {
      return new Map();
    }
    const summaries = await this.repository.offerSummaries(trx, search.id);
    return new Map(summaries.map((summary) => [summary.amadeusOfferId, summary.id]));
  }

  /** FlightSearch of a row: with the first page when `firstPage` is given (the create response). */
  private async searchResponse(
    trx: TenantTransaction,
    row: SearchRow,
    scope: OfferScope,
    firstPage: { readonly limit: number; readonly sort: ResultSort; readonly view: OfferView } | undefined,
    language: ReferenceNames,
  ): Promise<FlightSearch> {
    const now = this.clock.now();
    const request = row.criteria as FlightSearchCreateRequest;
    const amadeus = row.amadeusRequest as AmadeusSearchRequest;
    const summary = searchSummaryOf(request);
    const currency = row.currency ?? "";
    const minorUnits = await this.minorUnits(trx, currency);
    const completed = row.status === "completed";
    const status: FlightSearch["status"] =
      completed && row.expiresAt.getTime() <= now.getTime()
        ? "expired"
        : (row.status as FlightSearch["status"]);
    const facets = completed && isRecord(row.facets) ? (row.facets as unknown as Facets) : emptyFacets();
    const highlights: FlightSearchHighlights =
      completed && isRecord(row.highlights)
        ? (row.highlights as FlightSearchHighlights)
        : { cheapest: null, fastest: null, best: null };
    const codes = emptyCodes();
    for (const leg of summary.legs) {
      codes.locations.add(leg.originCode);
      codes.locations.add(leg.destinationCode);
    }
    facets.carriers.forEach((bucket) => codes.carriers.add(bucket.value));
    codes.currencies.add(currency);
    let page: Awaited<ReturnType<SearchesService["page"]>> | undefined;
    if (firstPage !== undefined && completed) {
      const filters: ResultFilters = {};
      page = await this.page(trx, row, scope, {
        filters,
        sort: firstPage.sort,
        view: firstPage.view,
        limit: firstPage.limit,
        after: undefined,
        fingerprint: resultFingerprint(row.id, parseResultFilters({}), firstPage.sort),
        minorUnits,
      });
      page.codes.locations.forEach((code) => codes.locations.add(code));
      page.codes.carriers.forEach((code) => codes.carriers.add(code));
      page.codes.aircraft.forEach((code) => codes.aircraft.add(code));
    }
    const nameSet = await this.names(trx, codes, amadeusDictionaries(row.dictionaries), language);
    const diagnostics = scope === "console" ? await this.diagnosticsOf(trx, row) : undefined;
    const search: FlightSearch = {
      id: row.id,
      status,
      mode: request.mode,
      customerId: row.customerId,
      criteria: searchCriteriaOf(request, amadeus),
      summary,
      currency,
      resultCount: completed ? row.resultCount : 0,
      highlights,
      oneWayCombinations: Array.isArray(row.oneWayCombinations)
        ? (row.oneWayCombinations as OneWayCombination[])
        : [],
      facets,
      dictionaries: nameSet.dictionaries,
      warnings: warningsOf(row.warnings),
      retryAfterSeconds: row.status === "pending" ? PENDING_RETRY_SECONDS : null,
      error: row.status === "failed" ? this.publicError(row.errorCode) : null,
      createdAt: row.createdAt.toISOString(),
      completedAt: completed ? row.updatedAt.toISOString() : null,
      expiresAt: row.expiresAt.toISOString(),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
    if (firstPage !== undefined) {
      search.offers = page?.map(nameSet.names) ?? [];
      search.page = { nextCursor: page?.nextCursor ?? null, limit: firstPage.limit };
    }
    return search;
  }

  /** The console diagnostics of a search: its latest supplier call. */
  private async diagnosticsOf(trx: TenantTransaction, row: SearchRow): Promise<FlightSearch["diagnostics"]> {
    const call = await this.repository.latestSupplierRequest(trx, row.id);
    if (
      call === undefined ||
      (call.amadeusOperationId !== "getFlightOffers" && call.amadeusOperationId !== "searchFlightOffers") ||
      (call.environment !== "test" && call.environment !== "live")
    ) {
      return undefined;
    }
    return {
      supplierRequestId: call.id,
      amadeusOperationId: call.amadeusOperationId,
      environment: call.environment,
      durationMs: call.durationMs ?? 0,
    };
  }

  /** The public error of a failed search (no supplier details: they were never stored). */
  private publicError(errorCode: string | null): NonNullable<FlightSearch["error"]> {
    const code: ErrorCode = isErrorCode(errorCode) ? errorCode : "INTERNAL_ERROR";
    const requestId = this.requestContext.requestId() ?? this.tenants.require().requestId;
    return toErrorEnvelope(new AppError(code), requestId, { exposeSupplier: false }).body.error;
  }

  /**
   * Names and dictionaries for `codes`: the reference schema first, the Amadeus dictionaries for the rest. Country and
   * currency names follow `language` (`Accept-Language`) where ICU has them, as in the reference operations.
   */
  private async names(
    trx: TenantTransaction,
    codes: CodeSet,
    amadeus: AmadeusDictionaries,
    language: ReferenceNames,
  ): Promise<NameSet> {
    const locationCodes = [...codes.locations].filter((code) => /^[A-Z]{3}$/.test(code)).sort();
    const carrierCodes = [...codes.carriers].filter((code) => /^[A-Z0-9]{2}$/.test(code)).sort();
    const aircraftCodes = [...codes.aircraft].filter((code) => /^[A-Z0-9]{3}$/.test(code)).sort();
    const currencyCodes = [...codes.currencies].filter((code) => /^[A-Z]{3}$/.test(code)).sort();
    const airports = await this.repository.airports(trx, locationCodes);
    const airportCodes = new Set(airports.map((airport) => airport.iataCode));
    const cityCodes = [
      ...new Set([
        ...locationCodes.filter((code) => !airportCodes.has(code)),
        ...airports.flatMap((airport) => airport.cityCode ?? []),
      ]),
    ].sort();
    const [cities, airlines, aircraft, currencies] = [
      await this.repository.cities(trx, cityCodes),
      await this.repository.airlines(trx, carrierCodes),
      await this.repository.aircraft(trx, aircraftCodes),
      await this.repository.currencies(trx, currencyCodes),
    ];
    const cityRows = new Map(cities.map((city) => [city.iataCode, city]));
    const locations = new Map<string, LocationInfo>();
    for (const airport of airports) {
      const city = airport.cityCode === null ? undefined : cityRows.get(airport.cityCode);
      locations.set(airport.iataCode, {
        cityCode: airport.cityCode ?? amadeus.locations[airport.iataCode]?.cityCode ?? null,
        countryCode: airport.countryCode,
        airportName: airport.name,
        cityName: city?.name ?? airport.cityName,
        countryName: language.country(airport.countryCode, airport.countryName),
        timeZone: airport.timeZone,
      });
    }
    for (const code of locationCodes) {
      if (locations.has(code)) {
        continue;
      }
      const city = cityRows.get(code);
      const fallback = amadeus.locations[code];
      if (city !== undefined) {
        locations.set(code, {
          cityCode: city.iataCode,
          countryCode: city.countryCode,
          airportName: null,
          cityName: city.name,
          countryName: language.country(city.countryCode, city.countryName),
          timeZone: city.timeZone,
        });
      } else if (fallback?.countryCode !== undefined) {
        locations.set(code, {
          cityCode: fallback.cityCode ?? null,
          countryCode: fallback.countryCode,
          airportName: null,
          cityName: null,
          countryName: null,
          timeZone: null,
        });
      }
    }
    const airlineRows = new Map(airlines.map((airline) => [airline.iataCode, airline]));
    const carrierName = (code: string): string | null =>
      airlineRows.get(code)?.name ?? amadeus.carriers[code] ?? null;
    const aircraftRows = new Map(aircraft.map((row) => [row.iataCode, row.name]));
    const aircraftName = (code: string): string | null =>
      aircraftRows.get(code) ?? amadeus.aircraft[code] ?? null;

    const dictionaryLocations: Record<string, DictionaryLocation> = {};
    for (const code of locationCodes) {
      const location = locations.get(code);
      if (
        location?.countryCode !== null &&
        location !== undefined &&
        /^[A-Z]{2}$/.test(location.countryCode)
      ) {
        dictionaryLocations[code] = {
          cityCode: location.cityCode,
          countryCode: location.countryCode,
          airportName: location.airportName,
          cityName: location.cityName,
          countryName: location.countryName,
          timeZone: location.timeZone,
        };
      }
    }
    const dictionaryCarriers: Dictionaries["carriers"] = {};
    for (const code of carrierCodes) {
      const name = carrierName(code);
      if (name !== null) {
        const logo = airlineRows.get(code)?.logoUrl;
        dictionaryCarriers[code] = {
          name,
          logoUrl: logo !== null && logo !== undefined && ABSOLUTE_URL.test(logo) ? logo : null,
        };
      }
    }
    const dictionaryAircraft: Record<string, string> = {};
    for (const code of aircraftCodes) {
      const name = aircraftName(code);
      if (name !== null) {
        dictionaryAircraft[code] = name;
      }
    }
    const currencyNames = new Map(
      currencies.map((currency) => [currency.code, language.currency(currency.code, currency.name)]),
    );
    const dictionaryCurrencies: Record<string, string> = {};
    for (const code of currencyCodes) {
      const name = currencyNames.get(code) ?? amadeus.currencies[code];
      if (name !== undefined) {
        dictionaryCurrencies[code] = name;
      }
    }
    return {
      names: { location: (code) => locations.get(code), carrierName, aircraftName },
      dictionaries: {
        locations: dictionaryLocations,
        carriers: dictionaryCarriers,
        aircraft: dictionaryAircraft,
        currencies: dictionaryCurrencies,
      },
    };
  }
}

/** A search request checked and completed with what the search needs. */
interface PreparedSearch {
  readonly request: FlightSearchCreateRequest;
  readonly amadeus: AmadeusSearchRequest;
  readonly currency: string;
  readonly minorUnits: number;
  readonly offerTtlMinutes: number;
  readonly channel: "storefront" | "console";
  readonly customerId: string | null;
  readonly criteriaHash: string;
  /** SIMPLE `maxPrice`: the highest selling price per traveller, in whole currency units. */
  readonly maxPrice: number | undefined;
}

/** An offer about to be stored. */
interface StoredCandidate {
  readonly id: string;
  readonly payload: unknown;
  readonly parsed: ParsedOffer;
  readonly position: number;
  readonly columns: ReturnType<typeof offerColumns>;
  readonly result: PricingResult;
}

function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

function facetRowOf(row: StoredCandidate): FacetRow {
  return {
    id: row.id,
    sellingTotal: row.result.selling,
    maxStops: row.columns.maxStops,
    marketingCarriers: row.columns.marketingCarriers,
    departureMinutes: row.columns.departureMinutes,
    arrivalMinutes: row.columns.arrivalMinutes,
    durationMinutes: row.columns.durationMinutes,
    totalDurationMinutes: row.columns.totalDurationMinutes,
    mainCabin: row.columns.mainCabin,
    minCheckedBags: row.columns.minCheckedBags,
    refundable: row.columns.refundable,
    changeable: row.columns.changeable,
    brandedFares: row.columns.brandedFares,
  };
}

/**
 * True when a traveller's selling price is above the SIMPLE `maxPrice` (whole units per traveller): Amadeus applied it
 * to the net fare, Velexis also drops offers whose selling price per traveller exceeds it.
 */
function exceedsMaxPrice(offer: ParsedOffer, result: PricingResult, prepared: PreparedSearch): boolean {
  const limit = new Money(prepared.maxPrice ?? 0);
  const shares = travelerMarkupShares(offer, new Money(result.markupTotal), prepared.minorUnits);
  if (offer.travelerPricings.length === 0) {
    return new Money(result.selling).gt(limit);
  }
  return offer.travelerPricings.some((pricing, index) =>
    new Money(pricing.total ?? 0).plus(shares[index] ?? 0).gt(limit),
  );
}

/** Amadeus `meta.oneWayCombinations` with offer ids (combinations naming an offer that was not stored are cut). */
function oneWayCombinationsOf(value: unknown, offerIds: ReadonlyMap<string, string>): OneWayCombination[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry["originDestinationId"] !== "string") {
      return [];
    }
    const ids = Array.isArray(entry["flightOfferIds"])
      ? entry["flightOfferIds"].flatMap((id: unknown) =>
          typeof id === "string" ? (offerIds.get(id) ?? []) : [],
        )
      : [];
    return [{ originDestinationId: entry["originDestinationId"], offerIds: ids }];
  });
}

/** Amadeus warnings as the document's Warning (title required). */
function warningsOf(value: unknown): Warning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry["title"] !== "string") {
      return [];
    }
    const warning: Warning = { title: entry["title"] };
    if (Number.isInteger(entry["code"])) {
      warning.code = entry["code"] as number;
    }
    if (typeof entry["detail"] === "string") {
      warning.detail = entry["detail"];
    }
    const source = entry["source"];
    if (isRecord(source)) {
      const copy: NonNullable<Warning["source"]> = {};
      for (const field of ["parameter", "pointer", "example"] as const) {
        const value = source[field];
        if (typeof value === "string") {
          copy[field] = value;
        }
      }
      warning.source = copy;
    }
    return [warning];
  });
}

/** The carrier and branded-fare labels of the stored (unfiltered) facets. */
function facetLabels(facets: Facets): {
  readonly carriers: ReadonlyMap<string, string>;
  readonly brandedFares: ReadonlyMap<string, string>;
} {
  const labels = (buckets: Facets["carriers"] | undefined): Map<string, string> =>
    new Map(
      (buckets ?? []).flatMap((bucket) =>
        typeof bucket.label === "string" ? [[bucket.value, bucket.label] as const] : [],
      ),
    );
  return { carriers: labels(facets.carriers), brandedFares: labels(facets.brandedFares) };
}
