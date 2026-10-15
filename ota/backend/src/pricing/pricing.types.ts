// The types of the markup and fee engine (OADR-0005): the facts of one offer the rules are matched against
// (point 2), the rules as the engine reads them (`markup_rules`, `fee_rules` of the tenant schema), the pricing
// steps of point 7, and the result with one line per applied rule (points 4, 5 and 8). Money is always a decimal
// string, never a JavaScript number (conventions §1); counts (travellers, segments, priorities) are integers.
import { Decimal } from "decimal.js";

/** A decimal string such as `"512.40"`, `"-5.0000"` or `"0"`, as PostgreSQL prints `numeric`. Never a number. */
export type DecimalString = string;

/** What a `DecimalString` must look like: an optional minus, digits, and an optional fraction. No exponent. */
export const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

/**
 * decimal.js for money, configured here and independent of the global `Decimal` settings: 50 significant digits (a
 * 12-digit amount times a 4-decimal percentage stays exact) and half-up rounding, which decimal.js applies away from
 * zero on a tie (`0.005` → `0.01`, `-0.005` → `-0.01`).
 */
export const Money = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

/** A decimal.js value of `Money`. */
export type MoneyValue = Decimal;

/** `value` as a `Money` value; throws `PricingInputError` naming `field` when it is not a decimal string. */
export function toMoney(value: DecimalString, field: string): MoneyValue {
  if (typeof value !== "string" || !DECIMAL_STRING.test(value)) {
    throw new PricingInputError(field, "is not a decimal string");
  }
  return new Money(value);
}

/** `markup_rules.calculation` and `fee_rules.calculation`. */
export const PRICING_CALCULATIONS = ["percentage", "fixed", "percentage_plus_fixed"] as const;
export type PricingCalculation = (typeof PRICING_CALCULATIONS)[number];

/** `applies_per`: the unit a rule is computed for, and the count its per-unit amount is multiplied by. */
export const APPLIES_PER = ["booking", "traveler", "segment"] as const;
export type AppliesPer = (typeof APPLIES_PER)[number];

/** `fee_rules.fee_type`. `change` rules are stored but never applied in the MVP (no exchanges). */
export const FEE_TYPES = [
  "booking_service",
  "payment_card",
  "ticketing",
  "change",
  "cancellation",
  "ancillary_service",
] as const;
export type FeeType = (typeof FEE_TYPES)[number];

/** The surface that prices the offer: the storefront (and API keys) or staff in the OTA admin. */
export const PRICING_CHANNELS = ["storefront", "console"] as const;
export type PricingChannel = (typeof PRICING_CHANNELS)[number];

/** The itinerary shape (`bookings.trip_type`, `FlightSearchSummary.tripType`). */
export const TRIP_TYPES = ["one_way", "round_trip", "multi_city"] as const;
export type TripType = (typeof TRIP_TYPES)[number];

/** The "any of" list fields of a rule scope (`markup_rules.scope`): an empty or missing list matches everything. */
export const SCOPE_LIST_FIELDS = [
  "origins",
  "destinations",
  "originCountries",
  "destinationCountries",
  "carriers",
  "cabins",
  "travelerTypes",
  "tripTypes",
  "sources",
  "channels",
] as const;
export type ScopeListField = (typeof SCOPE_LIST_FIELDS)[number];

/** The net-total bounds of a scope (inclusive, in the offer currency). */
export const SCOPE_AMOUNT_FIELDS = ["minNet", "maxNet"] as const;

/** The list field only fee scopes have: the card brands a `payment_card` fee is charged for. */
export const FEE_SCOPE_CARD_BRANDS = "cardBrands";

/**
 * The matching criteria of a markup rule: `{}` matches every offer. Every non-empty field must match (OADR-0005
 * point 3). Codes are compared without regard to case.
 */
export type PricingScope = {
  readonly [K in ScopeListField]?: readonly string[];
} & {
  /** Lowest net total the rule applies to (inclusive). */
  readonly minNet?: DecimalString | null;
  /** Highest net total the rule applies to (inclusive). */
  readonly maxNet?: DecimalString | null;
};

/** The matching criteria of a fee rule: those of a markup rule plus the card brands (`payment_card` fees). */
export type FeeScope = PricingScope & {
  /** Amadeus card brands (`VISA`, `MASTERCARD`, `AMERICAN_EXPRESS`, …); a non-empty list needs a known brand. */
  readonly cardBrands?: readonly string[];
};

/** What markup and fee rules have in common: matching, validity and the amount computation. */
export interface PricingRuleBase {
  /** `mkr_…` or `fee_…`. */
  readonly id: string;
  readonly name: string;
  readonly calculation: PricingCalculation;
  /** Percent of the base (`"5.0000"` = 5 %); used by `percentage` and `percentage_plus_fixed`. */
  readonly percentage: DecimalString | null;
  /** Fixed amount per unit; used by `fixed` and `percentage_plus_fixed`. */
  readonly fixedAmount: DecimalString | null;
  /**
   * Currency of the fixed amount and of the caps (`markup_rules.fixed_currency`, `fee_rules.currency`). They apply
   * only when it equals the offer currency (OADR-0005 point 6: no FX in the MVP).
   */
  readonly fixedCurrency: string | null;
  readonly appliesPer: AppliesPer;
  /** Lower cap of the computed amount per unit, in `fixedCurrency`. */
  readonly minAmount: DecimalString | null;
  /** Upper cap of the computed amount per unit, in `fixedCurrency`. */
  readonly maxAmount: DecimalString | null;
  /** Evaluation order: lower first, then `id`. */
  readonly priority: number;
  readonly isActive: boolean;
  /** Start of the validity window (inclusive); `null` = immediately. */
  readonly activeFrom: Date | null;
  /** End of the validity window (exclusive); `null` = open-ended. */
  readonly activeUntil: Date | null;
}

/** A row of `markup_rules`, as the engine reads it. */
export interface MarkupRule extends PricingRuleBase {
  readonly scope: PricingScope;
  /** Adds to the base rule instead of competing with it (OADR-0005 point 3). */
  readonly stackable: boolean;
  /** The seeded catch-all rule (priority 1000, 0 %). */
  readonly isDefault: boolean;
}

/** A row of `fee_rules`, as the engine reads it. */
export interface FeeRule extends PricingRuleBase {
  /** Shown to the customer in the price breakdown. */
  readonly label: string;
  readonly feeType: FeeType;
  readonly scope: FeeScope;
  /** Whether the fee is refunded on cancellation; non-refundable fees are kept (OADR-0005 point 7). */
  readonly refundable: boolean;
}

/**
 * The facts of one offer the engine prices (OADR-0005 point 2), taken from the Amadeus offer and the request by the
 * caller. Codes (airports, countries, carriers, cabins, traveller types, sources) are compared without regard to
 * case.
 */
export interface PricingInput {
  /** The instant the rules' validity windows are checked against (`Clock.now()` of the request). */
  readonly at: Date;
  /** ISO 4217 code of the offer's prices (`price.currency`). */
  readonly currency: string;
  /** Minor units of `currency` (`reference.currencies.minor_units`): every line is rounded to them. */
  readonly minorUnits: number;
  /** The net total (`price.grandTotal`), at most `minorUnits` decimals. */
  readonly netTotal: DecimalString;
  /** IATA code of the first departure airport. */
  readonly origin: string;
  /** IATA code of the destination airport (the outbound destination of a round trip). */
  readonly destination: string;
  /** ISO country of `origin` (`reference.airports`); `null` when unknown, which no country list matches. */
  readonly originCountry: string | null;
  /** ISO country of `destination`; `null` when unknown. */
  readonly destinationCountry: string | null;
  /** `validatingAirlineCodes`. */
  readonly validatingCarriers: readonly string[];
  /** The marketing carriers of every segment. */
  readonly marketingCarriers: readonly string[];
  /** The cabins of every segment (`ECONOMY`, `PREMIUM_ECONOMY`, `BUSINESS`, `FIRST`). */
  readonly cabins: readonly string[];
  /** Traveller counts by Amadeus traveller type, such as `{ ADULT: 2, CHILD: 1 }`; at least one traveller. */
  readonly travelers: Readonly<Record<string, number>>;
  /** Number of segments of every itinerary, at least 1. */
  readonly segmentCount: number;
  readonly tripType: TripType;
  /** `source` of the Amadeus offer (`GDS`, or an NDC source). */
  readonly source: string;
  readonly channel: PricingChannel;
}

/** One selected extra (an Amadeus additional service) that `ancillary_service` fees are charged for. */
export interface PricingExtra {
  /** The caller's reference of the extra, such as its `anc_…` option id; copied to its fee line. */
  readonly ref: string;
  /** Selling amount of the extra in the offer currency: the base of percentage fees. */
  readonly amount: DecimalString;
  /** Travellers the extra is for (the unit count of `traveler` fees), at least 1. */
  readonly travelers: number;
  /** Segments the extra is for (the unit count of `segment` fees), at least 1. */
  readonly segments: number;
}

/**
 * The pricing step decides which fee types apply (OADR-0005 point 7). Markup is computed at every step; a step that
 * only needs fees reads `feeLines`.
 *
 * - `search`: search results and upsell alternatives (`flight_offers`): markup only, no fees.
 * - `pricing`: priced offers (`priced_offers`): `booking_service` and `ticketing` on the price after markup, plus
 *   one `ancillary_service` fee per selected extra when `extras` are given (`checkout.setAncillaries`).
 * - `payment_card`: the card brand is known (`checkout.updatePayment`): `payment_card` fees whose `cardBrands`
 *   list the brand (or is empty), on `baseAmount`, the amount charged before the card fee.
 * - `cancellation`: the cancellation quote: `cancellation` fees on `baseAmount`, the booking total.
 */
export type PricingStep =
  | { readonly kind: "search" }
  | { readonly kind: "pricing"; readonly extras?: readonly PricingExtra[] }
  | { readonly kind: "payment_card"; readonly cardBrand: string; readonly baseAmount: DecimalString }
  | { readonly kind: "cancellation"; readonly baseAmount: DecimalString };

export type PricingStepKind = PricingStep["kind"];

/** How the per-unit amount of a line was capped, if it was. */
export type LineCap = "min" | "max" | null;

/** The part of a line that explains its amount (the OTA admin shows it on a booking). */
export interface LineComputation {
  readonly appliesPer: AppliesPer;
  /** The count the per-unit amount was multiplied by. */
  readonly units: number;
  /** `false` when the rule has a fixed part that was skipped because its currency is not the offer's. */
  readonly fixedApplied: boolean;
  readonly capped: LineCap;
  /** Rounded half-up to the currency's minor units; negative for a discount. */
  readonly amount: DecimalString;
}

/** One markup rule applied to the offer (OADR-0005 point 4: one line per rule, with the rule id). */
export interface MarkupLine extends LineComputation {
  readonly ruleId: string;
  readonly ruleName: string;
  /** `base`: the first matching non-stackable rule; `stacked`: a stackable rule added to it. */
  readonly role: "base" | "stacked";
}

/** One fee rule applied at the step. */
export interface FeeLine extends LineComputation {
  readonly ruleId: string;
  readonly feeType: FeeType;
  /** The customer-facing label of the rule. */
  readonly label: string;
  readonly refundable: boolean;
  /** The `ref` of the extra an `ancillary_service` fee is for; `null` for every other fee. */
  readonly extraRef: string | null;
}

/**
 * The price of the offer at a step: `selling = net + markupTotal + feeTotal`, where each total is the sum of its
 * rounded lines, so the CHECKs of `flight_offers` and `priced_offers` hold exactly (OADR-0005 point 5). Every amount
 * has exactly `minorUnits` decimals.
 */
export interface PricingResult {
  readonly step: PricingStepKind;
  readonly currency: string;
  readonly net: DecimalString;
  /** The base rule (`markup_rule_id` of OADR-0005 point 8); `null` when no non-stackable rule matched. */
  readonly markupRuleId: string | null;
  /** In evaluation order: stacked rules (lower priority numbers) first, the base rule last. */
  readonly markupLines: readonly MarkupLine[];
  readonly markupTotal: DecimalString;
  /** The markup lines summed below `-net` and were raised so the selling total is 0, never negative. */
  readonly markupFloored: boolean;
  readonly feeLines: readonly FeeLine[];
  readonly feeTotal: DecimalString;
  /**
   * `net + markupTotal + feeTotal`: the `selling_total` of a search offer (`search`) or a priced offer (`pricing`). At
   * the `payment_card` and `cancellation` steps `feeTotal` holds only that step's fees, so this is not a checkout or
   * booking total: the caller adds `feeLines` to the totals it already holds.
   */
  readonly selling: DecimalString;
}

/**
 * The engine was called with an input it cannot price: a malformed amount, a currency that is not three letters, no
 * traveller, an amount with more decimals than the currency has. A programming error of the caller, never a
 * customer error. The message names the field, not its value.
 */
export class PricingInputError extends Error {
  override readonly name = "PricingInputError";

  constructor(
    /** The offending field, such as `netTotal` or `markupRules[mkr_…].percentage`. */
    readonly field: string,
    problem: string,
  ) {
    super(`priceOffer: ${field} ${problem}`);
  }
}
