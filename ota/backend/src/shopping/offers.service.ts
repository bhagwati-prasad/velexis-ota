// `flights.getOffer` (getFlightOffer; OBE-022; ota/docs/flows/search-and-price.md §2 step 6, OADR-0002): one stored
// offer in the full view with its dictionaries, read from `flight_offers` only. OADR-0002 point 1 keeps no offer data
// in Redis (the document's "Redis (`offer:{id}`) then flight_offers" predates it), and nothing calls Amadeus.
//
// Access follows the owning search, as flights.getSearch: an offer is readable in its own environment, and an offer
// of a customer-bound search only by that customer and in console scope; anything else (another tenant's id, which
// its own schema does not have, included) is `404 NOT_FOUND`. After `expires_at` (the search's, which upsell offers
// share) the offer is `410 OFFER_EXPIRED`.
//
// Search offers and upsell offers (`origin = 'upsell'`, with `baseOfferId` and `upsellId`) are answered alike by
// `toOfferResponse`, which the upsell answers use too: customer scope gets selling amounts only, console scope the
// verbatim Amadeus offer with `netPrice` and `markup` (offers.mapper.ts `toFlightOffer`).
import { Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { Clock } from "../common/clock";
import { RequestContext } from "../common/http/request-context";
import { displayLanguage, ReferenceNames } from "../reference/reference.mapper";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import type { FlightSearchHighlights } from "./facets";
import {
  parseOffer,
  toFlightOffer,
  type DisplayNames,
  type FlightOffer,
  type OfferScope,
  type OfferView,
  type ParsedOffer,
} from "./offers.mapper";
import { OffersRepository, type OfferRow } from "./offers.repository";
import {
  addOfferCodes,
  amadeusDictionaries,
  emptyCodes,
  SearchesService,
  type AmadeusDictionaries,
} from "./searches.service";

/** The minor units the money columns (`numeric(12,2)`) hold: the fallback for a currency missing from reference. */
const MAX_MINOR_UNITS = 2;

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The Amadeus dictionaries of an offer: its search answer's, completed by its upsell answer's. */
export function offerDictionaries(rows: readonly OfferRow[]): AmadeusDictionaries {
  const merged: {
    locations: Record<string, { readonly cityCode?: string; readonly countryCode?: string }>;
    carriers: Record<string, string>;
    aircraft: Record<string, string>;
    currencies: Record<string, string>;
  } = { locations: {}, carriers: {}, aircraft: {}, currencies: {} };
  for (const row of rows) {
    for (const source of [row.searchDictionaries, row.upsellDictionaries]) {
      const dictionary = amadeusDictionaries(source);
      Object.assign(merged.locations, dictionary.locations);
      Object.assign(merged.carriers, dictionary.carriers);
      Object.assign(merged.aircraft, dictionary.aircraft);
      Object.assign(merged.currencies, dictionary.currencies);
    }
  }
  return merged;
}

/** What `toOfferResponse` needs besides the row. */
export interface OfferResponseContext {
  readonly scope: OfferScope;
  readonly view: OfferView;
  readonly now: Date;
  readonly minorUnits: number;
  readonly names: DisplayNames;
  readonly dictionaries: AmadeusDictionaries;
  /** Amadeus offer id → `off_…` of the offer's search (`upsellOfferIds`). */
  readonly offerIds: ReadonlyMap<string, string>;
}

/**
 * A stored offer as FlightOffer: `toFlightOffer` of the search results, with the upsell fields of an upsell offer
 * (`origin`, `baseOfferId`, `upsellId`). A payload that cannot be read was never stored (parseOffer ran at insert):
 * it is an internal error, never an answer with net amounts.
 */
export function toOfferResponse(row: OfferRow, context: OfferResponseContext): FlightOffer {
  const highlights = isRecord(row.searchHighlights)
    ? (row.searchHighlights as unknown as FlightSearchHighlights)
    : null;
  const offer = toFlightOffer(row, {
    scope: context.scope,
    view: context.view,
    now: context.now,
    minorUnits: context.minorUnits,
    highlights: row.origin === "search" ? highlights : null,
    offerIds: context.offerIds,
    names: context.names,
    cityOf: (code) => context.dictionaries.locations[code]?.cityCode ?? null,
  });
  if (offer === undefined) {
    throw new Error("a stored offer cannot be read");
  }
  return row.origin === "upsell"
    ? { ...offer, origin: "upsell", baseOfferId: row.baseOfferId, upsellId: row.upsellId }
    : offer;
}

/** A stored offer's parsed payload; a payload that cannot be read was never stored (an internal error). */
export function parsedOfferOf(row: OfferRow): ParsedOffer {
  const parsed = parseOffer(row.payload);
  if (parsed === undefined) {
    throw new Error("a stored offer cannot be read");
  }
  return parsed;
}

@Injectable()
export class OffersService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly requestContext: RequestContext,
    private readonly repository: OffersRepository,
    private readonly searches: SearchesService,
    private readonly clock: Clock,
  ) {}

  // ---- flights.getOffer --------------------------------------------------------------------------------------------

  /** The offer in the full view with its dictionaries. */
  async get(offerId: string, acceptLanguage?: string): Promise<FlightOffer> {
    const scope = this.scope();
    const language = new ReferenceNames(displayLanguage(acceptLanguage));
    return await this.tx.run(async (trx) => {
      const [row] = await this.readable(trx, [offerId], scope);
      if (row === undefined) {
        throw new AppError("NOT_FOUND", { message: "No flight offer with this id." });
      }
      const now = this.clock.now();
      if (row.expiresAt.getTime() <= now.getTime()) {
        throw new AppError("OFFER_EXPIRED");
      }
      const parsed = parsedOfferOf(row);
      const codes = emptyCodes();
      addOfferCodes(codes, parsed);
      codes.currencies.add(row.currency);
      const dictionaries = offerDictionaries([row]);
      const nameSet = await this.searches.names(trx, codes, dictionaries, language);
      const offerIds =
        row.origin === "search" && parsed.upsellFlightOfferIds.length > 0
          ? await this.repository.searchOfferIds(trx, row.searchId)
          : new Map<string, string>();
      const offer = toOfferResponse(row, {
        scope,
        view: "full",
        now,
        minorUnits: await this.minorUnits(trx, row.currency),
        names: nameSet.names,
        dictionaries,
        offerIds,
      });
      return { ...offer, dictionaries: nameSet.dictionaries };
    });
  }

  // ---- Shared with flights.upsell ----------------------------------------------------------------------------------

  /** The scope of the request: console after the scope guard marked it, else customer. */
  scope(): OfferScope {
    return this.requestContext.isConsoleScope() ? "console" : "customer";
  }

  /**
   * The offers of `ids` the request may read, in the order of `ids`; ids it may not read (unknown, another environment,
   * another customer's search outside console scope) are missing from the result.
   */
  async readable(trx: TenantTransaction, ids: readonly string[], scope: OfferScope): Promise<OfferRow[]> {
    const tenant = this.tenants.require();
    const rows = new Map((await this.repository.offersByIds(trx, ids)).map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = rows.get(id);
      if (
        row === undefined ||
        row.environment !== tenant.environment ||
        row.searchEnvironment !== tenant.environment
      ) {
        return [];
      }
      const ownCustomer =
        row.searchCustomerId === null ||
        scope === "console" ||
        (tenant.actor.type === "customer" && tenant.actor.id === row.searchCustomerId);
      return ownCustomer ? [row] : [];
    });
  }

  /** The minor units of `currency` (at most the 2 the money columns hold). */
  async minorUnits(trx: TenantTransaction, currency: string): Promise<number> {
    return (await this.repository.minorUnits(trx, currency)) ?? MAX_MINOR_UNITS;
  }
}
