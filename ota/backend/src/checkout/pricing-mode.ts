// The pricing mode of a checkout (`checkouts.pricing_mode`; ota/docs/data-model.md §3.2, OADR-0004 point 4, OADR-0005
// point 9; OBE-050): which price the traveller pays, and so which amounts the checkout's totals hold.
//
//   markup_rules  the selling price (the default): the priced offer's selling total (net plus markup plus the OTA's
//                 `booking_service` fees), the selling prices of the extras (`checkout_ancillaries.price_amount`), and
//                 as the card fee the Amadeus credit-card fee plus the OTA's `payment_card` fees.
//   net           the airline's price, for `airline_card` payments, which the airline charges: the Amadeus total of
//                 the priced offer (`priced_offers.net_total`), the Amadeus prices of the extras (`net_amount`), and as
//                 the card fee the Amadeus credit-card fee alone. The markup and fee engine is bypassed: no OTA markup
//                 and no OTA fee can be collected on this path.
//
// checkout.createPayment chooses the mode with the method (`airline_card` → `net`, any other → `markup_rules`) and
// writes the amounts of that mode into the checkout; choosing a Stripe method again restores the selling price. The
// CHECK of the table (`total = offer + ancillaries + fees`) holds in both modes. Pure functions: money in decimal.js,
// never a JavaScript number, rounded to the currency's minor units.
//
// The card fee's lines (`cardFeeLinesFor`, lead decision (2) of 2026-10-23, second batch; FIX-W28-CANCEL): the payment
// stores the lines its card fee is made of (`payments.card_fee_lines`, tenant migration 0004), each with whether a
// cancellation refunds it: the Amadeus credit-card fee never is, an OTA `payment_card` fee is when its rule is
// `refundable` (at the time the fee was quoted). In `net` mode the Amadeus fee is the only line.
import { Money } from "../pricing/pricing.types";

/** `checkouts.pricing_mode`. */
export const PRICING_MODES = ["markup_rules", "net"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/** True for a value of `checkouts.pricing_mode`. */
export function isPricingMode(value: unknown): value is PricingMode {
  return typeof value === "string" && (PRICING_MODES as readonly string[]).includes(value);
}

/** The payment methods whose price is the airline's: the airline, not the OTA, charges the card. */
const NET_METHODS: ReadonlySet<string> = new Set(["airline_card"]);

/** The pricing mode a payment method gives its checkout (PaymentCreateRequest.method). */
export function pricingModeOf(method: string): PricingMode {
  return NET_METHODS.has(method) ? "net" : "markup_rules";
}

/** The two totals of the priced offer being bought (`priced_offers`). */
export interface PricedTotals {
  /** `selling_total`: net plus markup plus the OTA's booking fees. */
  readonly sellingTotal: string;
  /** `net_total`: the Amadeus grand total of its offers. */
  readonly netTotal: string;
}

/** The two prices of one selected extra (`checkout_ancillaries`). */
export interface SelectionPrices {
  /** `price_amount`: the selling price of the selection. */
  readonly priceAmount: string;
  /** `net_amount`: the Amadeus price of the selection. */
  readonly netAmount: string;
}

/** The amounts of a checkout before the card fee: `offer_amount` and `ancillaries_amount`. */
export interface CheckoutBaseAmounts {
  readonly offer: string;
  readonly ancillaries: string;
}

/** The checkout's offer and extras in `mode`, with `minorUnits` decimals (see the file header). */
export function baseAmountsFor(
  mode: PricingMode,
  priced: PricedTotals,
  selections: readonly SelectionPrices[],
  minorUnits: number,
): CheckoutBaseAmounts {
  const offer = new Money(mode === "net" ? priced.netTotal : priced.sellingTotal);
  const ancillaries = selections.reduce(
    (total, selection) => total.plus(mode === "net" ? selection.netAmount : selection.priceAmount),
    new Money(0),
  );
  return { offer: offer.toFixed(minorUnits), ancillaries: ancillaries.toFixed(minorUnits) };
}

/** What a card-fee quote gives (card-fees.ts `CardFeeQuote`). */
export interface CardFeeParts {
  /** The Amadeus credit-card fee of the brand. */
  readonly amadeusFee: string;
  /** The Amadeus fee plus the OTA's `payment_card` fees. */
  readonly total: string;
}

/** The card fee of a checkout in `mode`: the Amadeus fee alone in `net` mode (the engine is bypassed). */
export function cardFeeFor(mode: PricingMode, quote: CardFeeParts | undefined, minorUnits: number): string {
  if (quote === undefined) {
    return new Money(0).toFixed(minorUnits);
  }
  return new Money(mode === "net" ? quote.amadeusFee : quote.total).toFixed(minorUnits);
}

/** One line of a payment's card fee, as `payments.card_fee_lines` stores it (see the file header). */
export interface CardFeeLine {
  /** `amadeus`: the Amadeus credit-card fee of the brand; `fee_rule`: an OTA `payment_card` fee rule. */
  readonly source: "amadeus" | "fee_rule";
  /** The fee rule (`fee_…`) of a `fee_rule` line, else `null`. */
  readonly ruleId: string | null;
  /** A decimal string with the currency's minor units. */
  readonly amount: string;
  /** Whether a cancellation refunds it: never for the Amadeus fee, the rule's flag for an OTA fee. */
  readonly refundable: boolean;
}

/** What the lines of a card fee are built from (card-fees.ts `CardFeeQuote`). */
export interface CardFeeLineParts extends CardFeeParts {
  /** The OTA's `payment_card` fee lines of the engine, with their rule and its refundable flag. */
  readonly feeLines: readonly {
    readonly ruleId: string;
    readonly amount: string;
    readonly refundable: boolean;
  }[];
}

/**
 * The lines of the card fee `cardFeeFor` gives in `mode` (see the file header): the Amadeus fee, then in
 * `markup_rules` the OTA's `payment_card` lines; none without a quote. They sum to `cardFeeFor`'s amount.
 */
export function cardFeeLinesFor(
  mode: PricingMode,
  quote: CardFeeLineParts | undefined,
  minorUnits: number,
): CardFeeLine[] {
  if (quote === undefined) {
    return [];
  }
  const amadeus: CardFeeLine = {
    source: "amadeus",
    ruleId: null,
    amount: new Money(quote.amadeusFee).toFixed(minorUnits),
    refundable: false,
  };
  if (mode === "net") {
    return [amadeus];
  }
  return [
    amadeus,
    ...quote.feeLines.map((line): CardFeeLine => ({
      source: "fee_rule",
      ruleId: line.ruleId,
      amount: new Money(line.amount).toFixed(minorUnits),
      refundable: line.refundable,
    })),
  ];
}

/** The amount before the card fee (`offer + ancillaries`). */
export function baseTotalOf(amounts: CheckoutBaseAmounts): string {
  return new Money(amounts.offer).plus(amounts.ancillaries).toString();
}

/** The checkout total (`offer + ancillaries + fees`), with `minorUnits` decimals. */
export function checkoutTotalOf(amounts: CheckoutBaseAmounts, fee: string, minorUnits: number): string {
  return new Money(amounts.offer).plus(amounts.ancillaries).plus(fee).toFixed(minorUnits);
}
