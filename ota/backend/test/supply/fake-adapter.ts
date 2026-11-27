// Test support: a fake supplier adapter that implements the supplier interface (src/supply/interface; OBE-110). A
// test scripts its capabilities, the answer of `prepare`, and the outcome, delay and offers of each Search and Price
// call, and reads back every call it received. It lives outside `src`, so no build ships it (multi-supplier plan
// §9.1, ADR-0025 item 7): src/supply/interface/fake-adapter.test.ts proves that the build leaves it out.
//
// What it stores is its own: an offer's payload is `{ supplier, offer }` and a pricing answer is
// `{ supplier, data, flightOffers, warnings }`, so its readers read back what it answered and refuse another
// supplier's data. Delays run on the global timers (vi.useFakeTimers drives them) and end early when the call's signal
// aborts: the engine's deadline. An aborted Search answers `timed_out` and an aborted Price `unavailable`.
//
// Search and Price answers are used in order, one per call; a call with none left gets the default: `empty` for
// Search and `priced` (every offer confirmed as asked) for Price. `prepare` stays pure: it answers what
// `scriptPrepare` set, `prepared` by default, whatever the calls before it.
import { AppError } from "@velexis/errors";
import type {
  NeutralConfirmedOffer,
  NeutralOffer,
  NeutralPricingReply,
  PriceCall,
  PriceCallResult,
  PriceQuery,
  RequestedOffer,
  SearchCall,
  SearchCallResult,
  SearchPreparation,
  SearchQuery,
  SupplierAdapter,
  SupplierCapabilities,
  SupplierReaders,
  SupplyCallContext,
} from "../../src/supply/interface";

/** The supplier the fake serves unless a test names another one (two fake sources need two names). */
export const FAKE_SUPPLIER = "fake";

/** The fake's default declaration: every capability present, so no step is skipped unless a test says so. */
export const FAKE_CAPABILITIES: SupplierCapabilities = Object.freeze({
  searchLimits: Object.freeze({ maxJourneys: 6, maxTravellers: 9, currencies: "any" as const }),
  extras: Object.freeze({ bags: true, seats: true, afterBooking: true }),
  findOrder: "our_reference",
  ticketing: Object.freeze({ issuance: "now", payment: "agency", ticketNumbersMayBeAbsent: false }),
  servicing: Object.freeze({ cancel: "api", void: "api", refund: "api", change: "api" }),
});

/** The fake's prepared request: the query it was prepared from. */
export interface FakePreparedSearch {
  readonly query: SearchQuery;
}

interface Delayed {
  /** How long the fake takes before it answers (milliseconds of the global timers); 0 by default. */
  readonly delayMs?: number;
}

/** One scripted Search answer. */
export type FakeSearchStep = Delayed &
  (
    | {
        readonly outcome: "ok";
        readonly offers: readonly NeutralOffer[];
        readonly unreadable?: number;
        readonly cityOfAirport?: Readonly<Record<string, string>>;
      }
    | { readonly outcome: "empty"; readonly unreadable?: number }
    | { readonly outcome: "failed" | "timed_out"; readonly error?: AppError }
  );

/** One scripted Price answer. */
export type FakePriceStep = Delayed &
  (
    | {
        readonly outcome: "priced";
        /** How the supplier confirms each offer (a changed price, say); as it was asked by default. */
        readonly confirm?: (offer: NeutralOffer) => NeutralOffer;
        readonly warnings?: unknown;
      }
    | { readonly outcome: "sold_out" | "refused" | "unavailable"; readonly error?: AppError }
  );

/** One call the fake received, in order. */
export type FakeCall =
  | { readonly action: "search.prepare"; readonly query: SearchQuery }
  | {
      readonly action: "search.send";
      readonly context: SupplyCallContext;
      readonly request: FakePreparedSearch;
      readonly outcome: SearchCallResult["outcome"];
      /** True when the call's signal aborted it before its answer. */
      readonly aborted: boolean;
    }
  | {
      readonly action: "price.send";
      readonly context: SupplyCallContext;
      readonly query: PriceQuery;
      readonly outcome: PriceCallResult["outcome"];
      readonly aborted: boolean;
    };

export interface FakeAdapterOptions {
  readonly supplier?: string;
  readonly capabilities?: Partial<SupplierCapabilities>;
}

const DEFAULT_ERRORS = {
  failed: "SUPPLIER_UNAVAILABLE",
  timed_out: "SUPPLIER_TIMEOUT",
  sold_out: "SOLD_OUT",
  refused: "SUPPLIER_REJECTED",
  unavailable: "SUPPLIER_UNAVAILABLE",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Waits `ms` on the global timers, or less when `signal` aborts first. */
function wait(ms: number, signal: AbortSignal): Promise<"elapsed" | "aborted"> {
  if (signal.aborted) {
    return Promise.resolve("aborted");
  }
  if (ms <= 0) {
    return Promise.resolve("elapsed");
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeAdapter implements SupplierAdapter<FakePreparedSearch> {
  readonly supplier: string;
  readonly readers: SupplierReaders;
  readonly search: SearchCall<FakePreparedSearch>;
  readonly price: PriceCall;
  /** Every call received, in order. */
  readonly calls: FakeCall[] = [];

  private declaration: SupplierCapabilities;
  private preparation: (query: SearchQuery) => SearchPreparation<FakePreparedSearch>;
  private readonly searchSteps: FakeSearchStep[] = [];
  private readonly priceSteps: FakePriceStep[] = [];

  constructor(options: FakeAdapterOptions = {}) {
    this.supplier = options.supplier ?? FAKE_SUPPLIER;
    this.declaration = { ...FAKE_CAPABILITIES, ...options.capabilities };
    this.preparation = (query) => ({ kind: "prepared", request: { query } });
    this.readers = {
      supplier: this.supplier,
      offer: { readOffer: (payload) => this.readOffer(payload) },
      pricedOffer: {
        readPricingReply: (body) => this.readPricingReply(body),
        confirmedOffers: (requested, reply) => this.confirmedOffers(requested, reply),
      },
    };
    this.search = {
      prepare: (query) => {
        this.calls.push({ action: "search.prepare", query });
        return this.preparation(query);
      },
      send: (context, request) => this.sendSearch(context, request),
    };
    this.price = { send: (context, query) => this.sendPrice(context, query) };
  }

  get capabilities(): SupplierCapabilities {
    return this.declaration;
  }

  /** Replaces the rows given; the others keep their value. */
  scriptCapabilities(rows: Partial<SupplierCapabilities>): this {
    this.declaration = { ...this.declaration, ...rows };
    return this;
  }

  /** What `prepare` answers from now on: one answer for every query, or a pure function of the query. */
  scriptPrepare(
    answer:
      | Exclude<SearchPreparation<FakePreparedSearch>, { kind: "prepared" }>
      | ((query: SearchQuery) => SearchPreparation<FakePreparedSearch>),
  ): this {
    this.preparation = typeof answer === "function" ? answer : () => answer;
    return this;
  }

  /** Adds Search answers, used in order. */
  scriptSearch(...steps: FakeSearchStep[]): this {
    this.searchSteps.push(...steps);
    return this;
  }

  /** Adds Price answers, used in order. */
  scriptPrice(...steps: FakePriceStep[]): this {
    this.priceSteps.push(...steps);
    return this;
  }

  /** The calls of one action, in order. */
  callsOf<A extends FakeCall["action"]>(action: A): Array<Extract<FakeCall, { action: A }>> {
    return this.calls.filter((call): call is Extract<FakeCall, { action: A }> => call.action === action);
  }

  /** The payload the fake stores for `offer`. */
  payloadOf(offer: NeutralOffer): unknown {
    return { supplier: this.supplier, offer };
  }

  private readOffer(payload: unknown): NeutralOffer | undefined {
    if (!isRecord(payload) || payload["supplier"] !== this.supplier || !isRecord(payload["offer"])) {
      return undefined;
    }
    const offer = payload["offer"];
    return typeof offer["supplierOfferRef"] === "string" ? (offer as unknown as NeutralOffer) : undefined;
  }

  private readPricingReply(body: unknown): NeutralPricingReply {
    const own = isRecord(body) && body["supplier"] === this.supplier ? body : {};
    const flightOffers = own["flightOffers"];
    return {
      data: isRecord(own["data"]) ? own["data"] : {},
      flightOffers: Array.isArray(flightOffers) ? flightOffers : [],
      bookingRequirements: undefined,
      included: {},
      dictionaries: undefined,
      warnings: own["warnings"],
    };
  }

  private confirmedOffers(
    requested: readonly RequestedOffer[],
    reply: NeutralPricingReply,
  ): NeutralConfirmedOffer[] | undefined {
    // As the interface says: an offer of the answer that was not asked for does not matter, even when it cannot be
    // read; a requested offer that cannot be read is one the answer lacks.
    const answered = new Map<string, Array<{ payload: unknown; parsed: NeutralOffer }>>();
    for (const payload of reply.flightOffers) {
      const parsed = this.readOffer(payload);
      if (parsed === undefined) {
        continue;
      }
      answered.set(parsed.supplierOfferRef, [
        ...(answered.get(parsed.supplierOfferRef) ?? []),
        { payload, parsed },
      ]);
    }
    const confirmed: NeutralConfirmedOffer[] = [];
    for (const offer of requested) {
      const matches = answered.get(offer.supplierOfferRef) ?? [];
      const [match] = matches;
      if (matches.length !== 1 || match === undefined || match.parsed.price.currency !== offer.currency) {
        return undefined;
      }
      confirmed.push({
        offerId: offer.id,
        supplierOfferRef: offer.supplierOfferRef,
        payload: match.payload,
        parsed: match.parsed,
      });
    }
    return confirmed;
  }

  private async sendSearch(
    context: SupplyCallContext,
    request: FakePreparedSearch,
  ): Promise<SearchCallResult> {
    const step = this.searchSteps.shift() ?? { outcome: "empty" };
    const started = Date.now();
    const waited = await wait(step.delayMs ?? 0, context.signal);
    const call = { supplierRequestId: null, durationMs: Date.now() - started };
    const result: SearchCallResult =
      waited === "aborted"
        ? { outcome: "timed_out", error: new AppError(DEFAULT_ERRORS.timed_out), call }
        : step.outcome === "ok"
          ? {
              outcome: "ok",
              offers: step.offers.map((offer) => ({ payload: this.payloadOf(offer), offer })),
              unreadable: step.unreadable ?? 0,
              cityOfAirport: step.cityOfAirport ?? {},
              call,
            }
          : step.outcome === "empty"
            ? { outcome: "empty", unreadable: step.unreadable ?? 0, call }
            : {
                outcome: step.outcome,
                error: step.error ?? new AppError(DEFAULT_ERRORS[step.outcome]),
                call,
              };
    this.calls.push({
      action: "search.send",
      context,
      request,
      outcome: result.outcome,
      aborted: waited === "aborted",
    });
    return result;
  }

  private async sendPrice(context: SupplyCallContext, query: PriceQuery): Promise<PriceCallResult> {
    const step = this.priceSteps.shift() ?? { outcome: "priced" };
    const started = Date.now();
    const waited = await wait(step.delayMs ?? 0, context.signal);
    const call = { supplierRequestId: null, durationMs: Date.now() - started };
    let result: PriceCallResult;
    if (waited === "aborted") {
      result = { outcome: "unavailable", error: new AppError(DEFAULT_ERRORS.unavailable), call };
    } else if (step.outcome !== "priced") {
      result = {
        outcome: step.outcome,
        error: step.error ?? new AppError(DEFAULT_ERRORS[step.outcome]),
        call,
      };
    } else {
      result = this.priced(query, step, call);
    }
    this.calls.push({
      action: "price.send",
      context,
      query,
      outcome: result.outcome,
      aborted: waited === "aborted",
    });
    return result;
  }

  /** Confirms every offer of `query`; an offer whose payload is not the fake's is refused, as a supplier would. */
  private priced(
    query: PriceQuery,
    step: Extract<FakePriceStep, { outcome: "priced" }>,
    call: { supplierRequestId: null; durationMs: number },
  ): PriceCallResult {
    const confirm = step.confirm ?? ((offer: NeutralOffer) => offer);
    const flightOffers: unknown[] = [];
    for (const offer of query.offers) {
      const parsed = this.readOffer(offer.payload);
      if (parsed === undefined) {
        return { outcome: "refused", error: new AppError(DEFAULT_ERRORS.refused), call };
      }
      flightOffers.push(this.payloadOf(confirm(parsed)));
    }
    const response = { supplier: this.supplier, data: {}, flightOffers, warnings: step.warnings };
    const reply = this.readPricingReply(response);
    const offers = this.confirmedOffers(
      query.offers.map((offer) => ({
        id: offer.id,
        supplierOfferRef: offer.supplierOfferRef,
        currency: offer.currency,
      })),
      reply,
    );
    if (offers === undefined) {
      return { outcome: "refused", error: new AppError(DEFAULT_ERRORS.refused), call };
    }
    return { outcome: "priced", pricedOffer: { offers, reply }, response, call };
  }
}

let offerCount = 0;

/**
 * A neutral offer for tests: one adult, one segment from LHR to JFK, 400.00 in EUR. `overrides` replace whole
 * members; the reference is `fake-<n>` unless given.
 */
export function fakeOffer(overrides: Partial<NeutralOffer> = {}): NeutralOffer {
  offerCount += 1;
  return {
    supplierOfferRef: `fake-${offerCount}`,
    source: "GDS",
    itineraries: [
      {
        duration: "PT8H",
        durationMinutes: 480,
        segments: [
          {
            id: "1",
            departure: { iataCode: "LHR", terminal: null, at: "2027-03-01T10:00:00" },
            arrival: { iataCode: "JFK", terminal: null, at: "2027-03-01T13:00:00" },
            carrierCode: "ZZ",
            number: "100",
            operatingCarrier: null,
            aircraft: null,
            duration: "PT8H",
            durationMinutes: 480,
            numberOfStops: 0,
            stops: [],
            co2Emissions: [],
            blacklistedInEU: undefined,
          },
        ],
      },
    ],
    travelerPricings: [
      {
        travelerId: "1",
        travelerType: "ADULT",
        fareOption: "STANDARD",
        associatedAdultId: null,
        total: "400.00",
        base: "300.00",
        taxes: [{ code: "GB", amount: "100.00" }],
        fareDetails: [
          {
            segmentId: "1",
            cabin: "ECONOMY",
            fareBasis: null,
            brandedFare: null,
            brandedFareLabel: null,
            bookingClass: "Y",
            isAllotment: undefined,
            checkedBags: { quantity: 1, weight: null, weightUnit: null },
            cabinBags: null,
            amenities: [],
          },
        ],
      },
    ],
    price: { currency: "EUR", total: "400.00", base: "300.00", grandTotal: "400.00", fees: [] },
    validatingAirlineCodes: ["ZZ"],
    lastTicketingDate: null,
    lastTicketingDateTime: null,
    numberOfBookableSeats: 9,
    instantTicketingRequired: false,
    paymentCardRequired: undefined,
    oneWay: undefined,
    isUpsellOffer: undefined,
    upsellFlightOfferIds: [],
    refundable: null,
    changeable: null,
    ...overrides,
  };
}

/** A call context for tests, with a signal that nothing aborts unless `signal` is given. */
export function fakeCallContext(overrides: Partial<SupplyCallContext> = {}): SupplyCallContext {
  return {
    tenantId: "ten_fake",
    environment: "test",
    operation: "flights.search",
    requestId: "req_fake",
    signal: new AbortController().signal,
    ...overrides,
  };
}
