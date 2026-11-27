// The supplier adapter interface (multi-supplier plan §4.2; ADR-0030 item 1; OADR-0019 items 1 and 6; OBE-110). An
// adapter implements it for one supplier: it builds the supplier's requests, reads the answers into neutral objects,
// classifies its own failures into the outcomes of outcomes.ts, redacts what it stores, and declares its capabilities.
// The engine (OBE-114) calls it; business code never does.
//
// Two parts:
// - The pure readers (`SupplierReaders`) of a stored offer and a stored priced offer: no I/O, no clock, no injection,
//   so the look-up from a row's supplier to its reader (OBE-118) works anywhere a row is read.
// - The calls, one member per action: Search, with its pure `prepare` step (a prepared request, `skipped` with a
//   reason, or a request problem) and `send`; and Price. The booking actions get their members in phase E (plan §6).
//
// A call never throws for a supplier's failure: it answers an outcome, with the public error the caller answers when
// it must fail. Outcomes and offers carry no supplier name, error code or payload outside the stored payloads that
// only the adapter's readers open; an error's supplier issue reaches console scope only, as today (conventions §6).
// The engine owns each source's deadline and aborts a late call through `SupplyCallContext.signal`; the call then
// answers `timed_out` (Search) or `unavailable` (Price). Types and constants only.
import type { components } from "@velexis/api-types";
import type { AppError } from "@velexis/errors";
import type { TenantEnvironment } from "../../tenancy/tenant-context";
import type { SupplierCapabilities } from "./capabilities";
import type {
  CabinClass,
  NeutralConfirmedOffer,
  NeutralOffer,
  NeutralPricedOffer,
  NeutralPricingReply,
  OfferContentType,
} from "./offers";
import type { PriceOutcome, SearchOutcome } from "./outcomes";

type Schemas = components["schemas"];

// ---- Readers -------------------------------------------------------------------------------------------------------

/** Reads a stored offer's payload (`flight_offers.payload`) back into the neutral offer. */
export interface StoredOfferReader {
  /**
   * The neutral offer of `payload`, or `undefined` when it cannot be read, or is not this supplier's: a reader never
   * reads another supplier's data.
   */
  readOffer(payload: unknown): NeutralOffer | undefined;
}

/** An offer a pricing answer must confirm: the stored offer's id, its reference and the currency it was found in. */
export interface RequestedOffer {
  readonly id: string;
  readonly supplierOfferRef: string;
  readonly currency: string;
}

/** Reads a stored or fresh pricing answer (`priced_offers.response`) back into the neutral priced offer. */
export interface StoredPricedOfferReader {
  /** The answer, read leniently: never throws, and an unreadable answer gives empty members. */
  readPricingReply(body: unknown): NeutralPricingReply;
  /**
   * The confirmed offers of `requested`, in its order, or `undefined` when the answer lacks one of them, has one
   * twice, cannot read one, or prices one in another currency: such an answer cannot be stored as a priced offer.
   */
  confirmedOffers(
    requested: readonly RequestedOffer[],
    reply: NeutralPricingReply,
  ): NeutralConfirmedOffer[] | undefined;
}

/** The pure readers of one supplier's stored data, usable without injection. */
export interface SupplierReaders {
  /** The supplier whose rows these readers read (the rows' `supplier`). */
  readonly supplier: string;
  readonly offer: StoredOfferReader;
  readonly pricedOffer: StoredPricedOfferReader;
}

// ---- Calls ---------------------------------------------------------------------------------------------------------

/** Who asks, what the call belongs to and its deadline: ids and a signal, never a body, a token or personal data. */
export interface SupplyCallContext {
  /** `ten_…`: the tenant the call is made for. */
  readonly tenantId: string;
  readonly environment: TenantEnvironment;
  /** The use case or SDK method (`flights.search`, `flights.price`); the call log's operation. */
  readonly operation: string;
  /** `X-Request-Id` of the triggering API call, or the job's request id. */
  readonly requestId: string;
  /** `stf_…` for console calls of a staff member. */
  readonly staffId?: string | undefined;
  /** `srch_…`: the search the call belongs to. */
  readonly searchId?: string | undefined;
  /** Aborted by the engine when the source's deadline passes. */
  readonly signal: AbortSignal;
}

/** The call log of a call: its row and how long the supplier took. */
export interface SupplyCallRecord {
  /** `sreq_…` of the call log row of the request that answered; `null` when the row could not be written. */
  readonly supplierRequestId: string | null;
  readonly durationMs: number;
}

/** Who reads an answer: customer scope (selling amounts only) or console scope. */
export type SearchScope = "customer" | "console";

/** The storefront's search defaults (`storefront_settings.search_defaults`), as far as they are well-formed. */
export interface SearchDefaults {
  /** The offers a customer-scope search asks for when it names more or none. */
  readonly maxResults: number;
  /** `nonStop` of a SIMPLE search that does not send it. */
  readonly nonStop?: boolean | undefined;
  /** `travelClass` of a SIMPLE search that does not send it. */
  readonly cabin?: CabinClass | undefined;
  /** The content types an ADVANCED search may use; any when not set. */
  readonly sources?: readonly OfferContentType[] | undefined;
}

/** What `prepare` reads: the search request as the API received it, its currency, the defaults and the scope. */
export interface SearchQuery {
  readonly request: Schemas["FlightSearchCreateRequest"];
  /** The search's one currency (ISO 4217): a source that cannot quote it is skipped, nothing is converted. */
  readonly currency: string;
  readonly defaults: SearchDefaults;
  readonly scope: SearchScope;
}

/** Why a source is not called for a query, as `prepare` answers it. */
export const SEARCH_SKIP_REASONS = Object.freeze([
  "journeys",
  "travellers",
  "infants",
  "currency",
  "unsupported_query",
] as const);
export type SearchSkipReason = (typeof SEARCH_SKIP_REASONS)[number];

/** Why a search request cannot be sent, as a field error of the request body (a pointer into it). */
export interface SearchRequestProblem {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  /** `403 FEATURE_DISABLED` (no allowed content type) or `403 SCOPE_NOT_ALLOWED` (negotiated fares) instead of a 400. */
  readonly kind: "validation" | "sources" | "negotiated";
}

/** The answer of `prepare`: the request to send, a skip with its reason, or a problem of the request. */
export type SearchPreparation<Prepared> =
  | { readonly kind: "prepared"; readonly request: Prepared }
  | { readonly kind: "skipped"; readonly reason: SearchSkipReason }
  | { readonly kind: "problem"; readonly problem: SearchRequestProblem };

/** One offer of a search answer: its payload to store, opaque, and its reading. */
export interface SearchedOffer {
  readonly payload: unknown;
  readonly offer: NeutralOffer;
}

/** The answer of `send`: one of the search outcomes but `skipped`, which `prepare` answers. */
export type SearchCallResult =
  | {
      readonly outcome: Extract<SearchOutcome, "ok">;
      /** The readable offers in the order of the supplier's answer, never empty. */
      readonly offers: readonly SearchedOffer[];
      /** Offers of the answer that could not be read; they are left out. */
      readonly unreadable: number;
      /** Airport code → its city code, as the answer gives it (the trip type); `{}` when it gives none. */
      readonly cityOfAirport: Readonly<Record<string, string>>;
      readonly call: SupplyCallRecord;
    }
  | {
      readonly outcome: Extract<SearchOutcome, "empty">;
      /** Offers of the answer that could not be read: an answer of unreadable offers only is `empty`. */
      readonly unreadable: number;
      readonly call: SupplyCallRecord;
    }
  | {
      readonly outcome: Extract<SearchOutcome, "failed" | "timed_out">;
      /** The public error the search answers when no other source answers. */
      readonly error: AppError;
      /** `null` when no call log row exists for the call. */
      readonly call: SupplyCallRecord | null;
    };

/** One offer to price: the stored offer's id, its reference, its stored payload, travellers and currency. */
export interface PriceOffer {
  readonly id: string;
  readonly supplierOfferRef: string;
  readonly payload: unknown;
  readonly travelerIds: readonly string[];
  readonly currency: string;
}

/** What Price sends: the offers in the order of the request, and the request's options as the API received them. */
export interface PriceQuery {
  readonly offers: readonly PriceOffer[];
  readonly body: Pick<Schemas["PricingRequest"], "payments" | "travelers" | "fareRules">;
  /** What the answer includes (bags, other services, card fees, detailed fare rules). */
  readonly include: readonly Schemas["PricingInclude"][];
  readonly forceClass: boolean;
}

/** The answer of Price. */
export type PriceCallResult =
  | {
      readonly outcome: Extract<PriceOutcome, "priced">;
      readonly pricedOffer: NeutralPricedOffer;
      /** The answer to store (`priced_offers.response`), redacted: the priced-offer reader reads it again. */
      readonly response: unknown;
      readonly call: SupplyCallRecord;
    }
  | {
      readonly outcome: Extract<PriceOutcome, "sold_out" | "refused" | "unavailable">;
      /** The public error the caller answers. */
      readonly error: AppError;
      /** `null` when no request was sent or no call log row exists for the call. */
      readonly call: SupplyCallRecord | null;
    };

/** Search: the pure `prepare` step, then `send`. `Prepared` is the adapter's own request, opaque to the engine. */
export interface SearchCall<Prepared> {
  /** Pure: no I/O, no clock. The same query always gives the same answer. */
  prepare(query: SearchQuery): SearchPreparation<Prepared>;
  /** Sends what `prepare` answered as `prepared`. */
  send(context: SupplyCallContext, request: Prepared): Promise<SearchCallResult>;
}

/** Price, and re-price: one pricing request for the offers of one source. */
export interface PriceCall {
  send(context: SupplyCallContext, query: PriceQuery): Promise<PriceCallResult>;
}

/** The calls of an adapter, one member per action. */
export interface SupplierCalls<Prepared> {
  readonly search: SearchCall<Prepared>;
  readonly price: PriceCall;
}

/** An adapter: the supplier it serves, its capability declaration, its readers and its calls. */
export interface SupplierAdapter<Prepared = unknown> extends SupplierCalls<Prepared> {
  /** The supplier this adapter serves: the value it stores in a row's `supplier`. */
  readonly supplier: string;
  readonly capabilities: SupplierCapabilities;
  readonly readers: SupplierReaders;
}
