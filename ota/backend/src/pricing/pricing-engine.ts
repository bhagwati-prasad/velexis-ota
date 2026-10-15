// The markup and fee engine (OADR-0005): `priceOffer(input, rules, fees, step)` turns the net price of one offer into
// its selling price with one line per applied rule. It is pure: no I/O, no clock, no logger, inputs never changed,
// and the same arguments always give the same result. Shopping, checkout, the reconciler and the console call it with
// the rules that `RulesRepository` loaded once for their tenant transaction. All money is decimal.js (`Money`), never
// a JavaScript number (conventions §1).
//
// Computation of one line (OADR-0005 point 4):
//
// - Units and share: `booking` is one unit with the whole base; `traveler` takes the base's per-traveller share
//   (base / every traveller) and counts the travellers of the scope's traveller types (every traveller when it lists
//   none); `segment` takes the per-segment share and counts every segment.
// - Per unit: `percentage` % of the share plus the fixed amount, each only when `calculation` uses it. The fixed
//   amount and the caps are in the rule's currency and apply only when it is the offer currency (point 6); otherwise
//   they are skipped and the percentage still applies.
// - `minAmount` and `maxAmount` cap the per-unit amount (the upper cap wins when they cross); the line is the per-unit
//   amount times the units, rounded half-up (ties away from zero) to the currency's minor units (point 5).
//
// Markup: the base of percentages is the net total; negative lines (discounts) are kept as computed, but when the
// markup lines sum below `-net` the last discount lines are raised until they sum to exactly `-net`, so the selling
// total is 0, never negative. Fees: the base is the price after markup (`pricing`), each extra's amount
// (`ancillary_service`) or the step's `baseAmount` (`payment_card`, `cancellation`); a fee line is never negative.
//
// `selling = net + Σ markup lines + Σ fee lines`, summed after rounding, so the `flight_offers` and `priced_offers`
// CHECKs hold exactly.
import {
  normaliseCode,
  matchingTravelerCount,
  offerFacts,
  selectFeeRule,
  selectMarkupRules,
} from "./rule-matcher";
import type { OfferFacts } from "./rule-matcher";
import {
  Money,
  PRICING_CHANNELS,
  PricingInputError,
  toMoney,
  TRIP_TYPES,
  type AppliesPer,
  type DecimalString,
  type FeeLine,
  type FeeRule,
  type FeeType,
  type LineCap,
  type MarkupLine,
  type MarkupRule,
  type MoneyValue,
  type PricingExtra,
  type PricingInput,
  type PricingResult,
  type PricingRuleBase,
  type PricingStep,
} from "./pricing.types";

/** ISO 4217 minor units go from 0 (JPY) to 4 (CLF). */
const MAX_MINOR_UNITS = 4;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const ZERO = new Money(0);

/** The validated input and what every line needs. */
interface PricingContext {
  readonly input: PricingInput;
  readonly currency: string;
  readonly minorUnits: number;
  readonly net: MoneyValue;
  readonly travelerCount: number;
  readonly facts: OfferFacts;
}

/** A line before formatting: its amount is still a decimal.js value. */
interface ComputedLine {
  readonly appliesPer: AppliesPer;
  readonly units: number;
  readonly fixedApplied: boolean;
  readonly capped: LineCap;
  readonly amount: MoneyValue;
}

/** How a line is counted: the count its share is divided by, and the count its per-unit amount is multiplied by. */
interface UnitCount {
  readonly shareCount: number;
  readonly units: number;
}

/**
 * Prices one offer at one step: the markup lines of the matching rules, the fee lines of the step's fee types, and
 * `selling = net + markupTotal + feeTotal` (OADR-0005). Throws `PricingInputError` when the input, the step or a
 * rule's amount is malformed.
 */
export function priceOffer(
  input: PricingInput,
  rules: readonly MarkupRule[],
  fees: readonly FeeRule[],
  step: PricingStep,
): PricingResult {
  const context = pricingContext(input, step);

  // Evaluation order: the stacked rules have lower priority numbers than the base rule.
  const selection = selectMarkupRules(rules, context.facts);
  const applied = [
    ...selection.stacked.map((rule) => ({ rule, role: "stacked" as const })),
    ...(selection.base === null ? [] : [{ rule: selection.base, role: "base" as const }]),
  ].map(({ rule, role }) => ({
    rule,
    role,
    line: computeLine(rule, context, context.net, offerUnits(rule, context), `markupRules[${rule.id}]`),
  }));
  const floored = floorAtNegativeNet(
    applied.map(({ line }) => line.amount),
    context.net,
  );
  const markupLines = applied.map(({ rule, role, line }, index): MarkupLine =>
    Object.freeze({
      ruleId: rule.id,
      ruleName: rule.name,
      role,
      ...formatLine(line, floored.amounts[index] ?? line.amount, context.minorUnits),
    }),
  );
  const markupTotal = sum(floored.amounts);

  const feeLines = feeLinesOf(step, fees, context, context.net.plus(markupTotal));
  const feeTotal = sum(feeLines.map((line) => new Money(line.amount)));

  return Object.freeze({
    step: step.kind,
    currency: context.currency,
    net: format(context.net, context.minorUnits),
    markupRuleId: selection.base?.id ?? null,
    markupLines: Object.freeze(markupLines),
    markupTotal: format(markupTotal, context.minorUnits),
    markupFloored: floored.floored,
    feeLines: Object.freeze(feeLines),
    feeTotal: format(feeTotal, context.minorUnits),
    selling: format(context.net.plus(markupTotal).plus(feeTotal), context.minorUnits),
  });
}

/**
 * The fee lines of the step (OADR-0005 point 7): at most one rule per fee type, one line per extra. The step's amounts
 * were validated by `assertStep`.
 */
function feeLinesOf(
  step: PricingStep,
  fees: readonly FeeRule[],
  context: PricingContext,
  priceAfterMarkup: MoneyValue,
): FeeLine[] {
  const lines: FeeLine[] = [];
  const offerFee = (feeType: FeeType, base: MoneyValue, facts: OfferFacts): void => {
    const rule = selectFeeRule(fees, facts, feeType);
    if (rule !== null) {
      lines.push(feeLine(rule, context, base, offerUnits(rule, context), null));
    }
  };
  switch (step.kind) {
    case "search":
      break;
    case "pricing": {
      offerFee("booking_service", priceAfterMarkup, context.facts);
      offerFee("ticketing", priceAfterMarkup, context.facts);
      const rule = selectFeeRule(fees, context.facts, "ancillary_service");
      if (rule !== null) {
        for (const extra of step.extras ?? []) {
          lines.push(
            feeLine(rule, context, new Money(extra.amount), extraUnits(rule.appliesPer, extra), extra.ref),
          );
        }
      }
      break;
    }
    case "payment_card":
      offerFee(
        "payment_card",
        new Money(step.baseAmount),
        offerFacts(context.input, context.net, step.cardBrand),
      );
      break;
    case "cancellation":
      offerFee("cancellation", new Money(step.baseAmount), context.facts);
      break;
  }
  return lines;
}

/** One fee line; a fee is never negative (a misconfigured cap cannot turn it into a discount). */
function feeLine(
  rule: FeeRule,
  context: PricingContext,
  base: MoneyValue,
  count: UnitCount,
  extraRef: string | null,
): FeeLine {
  const line = computeLine(rule, context, base, count, `feeRules[${rule.id}]`);
  return Object.freeze({
    ruleId: rule.id,
    feeType: rule.feeType,
    label: rule.label,
    refundable: rule.refundable,
    extraRef,
    ...formatLine(line, Money.max(line.amount, ZERO), context.minorUnits),
  });
}

/** Units and share of a rule applied to the whole offer. */
function offerUnits(rule: MarkupRule | FeeRule, context: PricingContext): UnitCount {
  switch (rule.appliesPer) {
    case "booking":
      return { shareCount: 1, units: 1 };
    case "traveler":
      return {
        shareCount: context.travelerCount,
        units: matchingTravelerCount(rule.scope, context.input.travelers),
      };
    case "segment":
      return { shareCount: context.input.segmentCount, units: context.input.segmentCount };
  }
}

/** Units and share of an `ancillary_service` fee on one extra. */
function extraUnits(appliesPer: AppliesPer, extra: PricingExtra): UnitCount {
  switch (appliesPer) {
    case "booking":
      return { shareCount: 1, units: 1 };
    case "traveler":
      return { shareCount: extra.travelers, units: extra.travelers };
    case "segment":
      return { shareCount: extra.segments, units: extra.segments };
  }
}

const usesPercentage = (rule: PricingRuleBase): boolean =>
  rule.calculation === "percentage" || rule.calculation === "percentage_plus_fixed";
const usesFixed = (rule: PricingRuleBase): boolean =>
  rule.calculation === "fixed" || rule.calculation === "percentage_plus_fixed";

/** The rounded amount of one rule on `base` (OADR-0005 points 4 to 6). */
function computeLine(
  rule: PricingRuleBase,
  context: PricingContext,
  base: MoneyValue,
  { shareCount, units }: UnitCount,
  field: string,
): ComputedLine {
  const rate =
    usesPercentage(rule) && rule.percentage !== null
      ? toMoney(rule.percentage, `${field}.percentage`).div(100)
      : ZERO;
  const inOfferCurrency =
    rule.fixedCurrency !== null && normaliseCode(rule.fixedCurrency) === context.currency;
  const fixedAmount = usesFixed(rule) ? rule.fixedAmount : null;
  const fixedApplied = fixedAmount !== null && inOfferCurrency;
  const fixed = fixedAmount !== null && inOfferCurrency ? toMoney(fixedAmount, `${field}.fixedAmount`) : ZERO;

  let perUnit = rate.times(base).div(shareCount).plus(fixed);
  let capped: LineCap = null;
  if (inOfferCurrency && rule.minAmount !== null) {
    const min = toMoney(rule.minAmount, `${field}.minAmount`);
    if (perUnit.lt(min)) {
      perUnit = min;
      capped = "min";
    }
  }
  if (inOfferCurrency && rule.maxAmount !== null) {
    const max = toMoney(rule.maxAmount, `${field}.maxAmount`);
    if (perUnit.gt(max)) {
      perUnit = max;
      capped = "max";
    }
  }
  // Uncapped, the share is multiplied before it is divided, so a share that does not terminate (1000 / 3) costs no
  // precision: the exact line is what gets rounded.
  const raw =
    capped === null
      ? rate.times(base).times(units).div(shareCount).plus(fixed.times(units))
      : perUnit.times(units);
  return {
    appliesPer: rule.appliesPer,
    units,
    fixedApplied,
    capped,
    amount: raw.toDecimalPlaces(context.minorUnits, Money.ROUND_HALF_UP),
  };
}

/**
 * Raises the last negative lines until the lines sum to `-net` when they sum below it (OADR-0005 point 4), so the
 * selling total is never negative. Lines already at or above the floor are returned unchanged.
 */
function floorAtNegativeNet(
  amounts: readonly MoneyValue[],
  net: MoneyValue,
): { amounts: MoneyValue[]; floored: boolean } {
  const result = [...amounts];
  let deficit = net.neg().minus(sum(result));
  if (deficit.lte(ZERO)) {
    return { amounts: result, floored: false };
  }
  for (let index = result.length - 1; index >= 0 && deficit.gt(ZERO); index -= 1) {
    const amount = result[index];
    if (amount !== undefined && amount.lt(ZERO)) {
      const raise = Money.min(deficit, amount.neg());
      result[index] = amount.plus(raise);
      deficit = deficit.minus(raise);
    }
  }
  return { amounts: result, floored: true };
}

function sum(amounts: readonly MoneyValue[]): MoneyValue {
  return amounts.reduce((total, amount) => total.plus(amount), ZERO);
}

/** `amount` with exactly `minorUnits` decimals, never `-0.00`. */
function format(amount: MoneyValue, minorUnits: number): DecimalString {
  return (amount.isZero() ? ZERO : amount).toFixed(minorUnits);
}

function formatLine(line: ComputedLine, amount: MoneyValue, minorUnits: number) {
  return {
    appliesPer: line.appliesPer,
    units: line.units,
    fixedApplied: line.fixedApplied,
    capped: line.capped,
    amount: format(amount, minorUnits),
  };
}

/** A non-negative amount of the input with at most `minorUnits` decimals. */
function checkedAmount(value: DecimalString, minorUnits: number, field: string): MoneyValue {
  const amount = toMoney(value, field);
  if (amount.lt(ZERO)) {
    throw new PricingInputError(field, "is negative");
  }
  if (amount.decimalPlaces() > minorUnits) {
    throw new PricingInputError(field, `has more decimals than the currency's ${minorUnits} minor units`);
  }
  return amount;
}

function isCount(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function assertCodes(values: unknown, field: string): void {
  if (!Array.isArray(values) || !values.every(isCode)) {
    throw new PricingInputError(field, "is not a list of codes");
  }
}

/** Validates the input and the step, and builds what every line needs. */
function pricingContext(input: PricingInput, step: PricingStep): PricingContext {
  if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) {
    throw new PricingInputError("at", "is not a valid date");
  }
  if (typeof input.currency !== "string" || !CURRENCY_CODE.test(input.currency)) {
    throw new PricingInputError("currency", "is not an ISO 4217 code");
  }
  if (!isCount(input.minorUnits, 0) || input.minorUnits > MAX_MINOR_UNITS) {
    throw new PricingInputError("minorUnits", `is not an integer from 0 to ${MAX_MINOR_UNITS}`);
  }
  const net = checkedAmount(input.netTotal, input.minorUnits, "netTotal");
  for (const field of ["origin", "destination", "source"] as const) {
    if (!isCode(input[field])) {
      throw new PricingInputError(field, "is not a code");
    }
  }
  for (const field of ["originCountry", "destinationCountry"] as const) {
    if (input[field] !== null && !isCode(input[field])) {
      throw new PricingInputError(field, "is neither a code nor null");
    }
  }
  assertCodes(input.validatingCarriers, "validatingCarriers");
  assertCodes(input.marketingCarriers, "marketingCarriers");
  assertCodes(input.cabins, "cabins");
  if (!(TRIP_TYPES as readonly string[]).includes(input.tripType)) {
    throw new PricingInputError("tripType", `is not one of ${TRIP_TYPES.join(", ")}`);
  }
  if (!(PRICING_CHANNELS as readonly string[]).includes(input.channel)) {
    throw new PricingInputError("channel", `is not one of ${PRICING_CHANNELS.join(", ")}`);
  }
  if (!isCount(input.segmentCount, 1)) {
    throw new PricingInputError("segmentCount", "is not an integer of at least 1");
  }
  let travelerCount = 0;
  for (const [type, count] of Object.entries(input.travelers ?? {})) {
    if (!isCode(type) || !isCount(count, 0)) {
      throw new PricingInputError("travelers", "is not a map of traveller types to counts");
    }
    travelerCount += count;
  }
  if (travelerCount < 1) {
    throw new PricingInputError("travelers", "has no traveller");
  }
  assertStep(step, input.minorUnits);
  return Object.freeze({
    input,
    currency: input.currency,
    minorUnits: input.minorUnits,
    net,
    travelerCount,
    facts: offerFacts(input, net),
  });
}

/** Validates the step, its amounts included, whether or not a fee rule will use them. */
function assertStep(step: PricingStep, minorUnits: number): void {
  switch (step.kind) {
    case "search":
      return;
    case "pricing":
      for (const [index, extra] of (step.extras ?? []).entries()) {
        if (!isCode(extra.ref)) {
          throw new PricingInputError(`step.extras[${index}].ref`, "is empty");
        }
        if (!isCount(extra.travelers, 1) || !isCount(extra.segments, 1)) {
          throw new PricingInputError(`step.extras[${index}]`, "needs at least 1 traveller and 1 segment");
        }
        checkedAmount(extra.amount, minorUnits, `step.extras[${index}].amount`);
      }
      return;
    case "payment_card":
      if (!isCode(step.cardBrand)) {
        throw new PricingInputError("step.cardBrand", "is empty");
      }
      checkedAmount(step.baseAmount, minorUnits, "step.baseAmount");
      return;
    case "cancellation":
      checkedAmount(step.baseAmount, minorUnits, "step.baseAmount");
      return;
    default:
      throw new PricingInputError("step.kind", "is not a pricing step");
  }
}
