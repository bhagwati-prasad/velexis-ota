// The neutral offer and the neutral priced offer (multi-supplier plan §4.1 and §4.2; OBE-110). An adapter reads its
// supplier's offers into these shapes; business code reads them and never the supplier's payload, which only the
// adapter's own reader opens.
//
// The neutral offer has the members of today's `ParsedOffer` (shopping/offers.mapper.ts), with `supplierOfferRef`, an
// opaque text that the adapter chooses, in place of the supplier's own offer id. The neutral priced offer builds on
// it: the confirmed offers of a pricing answer, each with its reference and its reading. The mappers keep their own
// types until OBE-118 and OBE-119 move them onto these; offers.test.ts proves that the shapes match member for member.
// Types only. Codes are those of the public contract (`@velexis/api-types`), not a supplier's.
import type { components } from "@velexis/api-types";

type Schemas = components["schemas"];
type JsonObject = Record<string, unknown>;

/** The content type of an offer, as the contract's `FlightOffer.source` gives it (ADR-0030 item 17). */
export type OfferContentType = Schemas["FlightOffer"]["source"];

/** A cabin, as the contract's fare detail of a segment gives it. */
export type CabinClass = NonNullable<Schemas["SegmentFareDetail"]["cabin"]>;

/** A traveller type, as the contract's traveller pricing gives it. */
export type TravellerType = Schemas["OfferTravelerPricing"]["travelerType"];

export interface NeutralEndpoint {
  readonly iataCode: string;
  readonly terminal: string | null;
  /** `YYYY-MM-DDTHH:MM:SS`, local time of the airport. */
  readonly at: string;
}

export interface NeutralSegment {
  /** The segment's id within its offer, as the supplier numbers it. */
  readonly id: string;
  readonly departure: NeutralEndpoint;
  readonly arrival: NeutralEndpoint;
  readonly carrierCode: string;
  readonly number: string;
  readonly operatingCarrier: string | null;
  readonly aircraft: string | null;
  /** ISO 8601 duration, `null` when the supplier gave none. */
  readonly duration: string | null;
  readonly durationMinutes: number | null;
  readonly numberOfStops: number;
  readonly stops: readonly JsonObject[];
  readonly co2Emissions: readonly JsonObject[];
  readonly blacklistedInEU: boolean | undefined;
}

export interface NeutralItinerary {
  readonly duration: string | null;
  readonly durationMinutes: number;
  readonly segments: readonly NeutralSegment[];
}

export interface NeutralBags {
  readonly quantity: number | null;
  readonly weight: number | null;
  readonly weightUnit: string | null;
}

export interface NeutralFareDetail {
  readonly segmentId: string;
  readonly cabin: CabinClass | null;
  readonly fareBasis: string | null;
  readonly brandedFare: string | null;
  readonly brandedFareLabel: string | null;
  readonly bookingClass: string | null;
  readonly isAllotment: boolean | undefined;
  readonly checkedBags: NeutralBags | null;
  readonly cabinBags: NeutralBags | null;
  readonly amenities: readonly JsonObject[];
}

export interface NeutralTravellerPricing {
  /** The traveller's id within the offer, used by pricing, extras and checkout. */
  readonly travelerId: string;
  readonly travelerType: TravellerType;
  readonly fareOption: string;
  readonly associatedAdultId: string | null;
  /** Net traveller total (taxes included), a decimal string; `null` when the supplier gave none. */
  readonly total: string | null;
  readonly base: string | null;
  readonly taxes: ReadonlyArray<{ readonly code: string; readonly amount: string }>;
  readonly fareDetails: readonly NeutralFareDetail[];
}

export interface NeutralFee {
  readonly type: string;
  readonly amount: string;
}

/** Net amounts as decimal strings, never a JavaScript number. */
export interface NeutralPrice {
  readonly currency: string;
  /** Base + taxes + supplier fees (net). */
  readonly total: string;
  readonly base: string;
  /** `total` + additional services (net); `total` when the supplier gave none. */
  readonly grandTotal: string;
  readonly fees: readonly NeutralFee[];
}

/** A checked, normalised reading of a supplier's offer. */
export interface NeutralOffer {
  /** The supplier offer reference: an opaque text that the adapter chooses and alone reads. */
  readonly supplierOfferRef: string;
  readonly source: OfferContentType;
  readonly itineraries: readonly NeutralItinerary[];
  readonly travelerPricings: readonly NeutralTravellerPricing[];
  readonly price: NeutralPrice;
  readonly validatingAirlineCodes: readonly string[];
  readonly lastTicketingDate: string | null;
  readonly lastTicketingDateTime: string | null;
  readonly numberOfBookableSeats: number | null;
  readonly instantTicketingRequired: boolean;
  readonly paymentCardRequired: boolean | undefined;
  readonly oneWay: boolean | undefined;
  readonly isUpsellOffer: boolean | undefined;
  /** The supplier offer references of this offer's upsell offers, from the same answer. */
  readonly upsellFlightOfferIds: readonly string[];
  /** Known refundability from the fare rules or the branded-fare amenities, `null` when unknown. */
  readonly refundable: boolean | null;
  readonly changeable: boolean | null;
}

/** A pricing answer, stored or fresh, read leniently: what the adapter's priced-offer reader answers. */
export interface NeutralPricingReply {
  /** The answer's data, as answered. */
  readonly data: JsonObject;
  /** The confirmed offers' payloads, opaque: the adapter's reader reads them. */
  readonly flightOffers: readonly unknown[];
  readonly bookingRequirements: unknown;
  /** Data of the answer beside its offers (extras, fare rules), `{}` when absent. */
  readonly included: JsonObject;
  readonly dictionaries: unknown;
  readonly warnings: unknown;
}

/** One offer of a priced offer, as its supplier confirmed it. */
export interface NeutralConfirmedOffer {
  /** `off_…`: the stored offer that was priced. */
  readonly offerId: string;
  readonly supplierOfferRef: string;
  /** The confirmed payload, opaque: only the adapter's reader opens it. */
  readonly payload: unknown;
  readonly parsed: NeutralOffer;
}

/** A priced offer: the confirmed offers in the order of the request, and the answer they came in. */
export interface NeutralPricedOffer {
  readonly offers: readonly NeutralConfirmedOffer[];
  readonly reply: NeutralPricingReply;
}
