// Rule matching of the markup and fee engine (OADR-0005 point 3), pure and without I/O:
//
// - A rule matches when it is active, inside its validity window (`activeFrom` inclusive, `activeUntil` exclusive),
//   and every non-empty scope field matches. Lists are "any of": the rule matches when one of the offer's values is
//   listed (carriers are the validating and the marketing carriers, cabins those of every segment, traveller types
//   those with at least one traveller). `minNet` and `maxNet` bound the net total, both inclusive. Codes are
//   compared without regard to case. A fee scope's `cardBrands` needs the card brand, which only the
//   `payment_card` step knows.
// - Rules are evaluated by `priority` ascending, then `id`. The first matching non-stackable markup rule is the
//   base; every matching stackable rule with a lower priority number than the base, or every one when no base
//   matched, adds to it. The seeded default rule (priority 1000, scope {}) is the base when nothing else matches.
// - Fee rules have no stacking: per fee type, the first matching rule applies, so an OTA overrides a general fee
//   with a narrower rule of a lower priority number.
//
// `parseRuleScope` turns the `scope` jsonb of a row into a `PricingScope` and refuses anything it cannot evaluate,
// so a rule is never applied more broadly than written.
import {
  DECIMAL_STRING,
  FEE_SCOPE_CARD_BRANDS,
  SCOPE_AMOUNT_FIELDS,
  SCOPE_LIST_FIELDS,
  toMoney,
  type FeeRule,
  type FeeScope,
  type FeeType,
  type MarkupRule,
  type MoneyValue,
  type PricingInput,
  type PricingRuleBase,
  type PricingScope,
  type ScopeListField,
} from "./pricing.types";

/** What a scope is matched against: the offer's values per scope field, normalised once per offer. */
export interface OfferFacts {
  readonly at: Date;
  readonly lists: Readonly<Record<ScopeListField, ReadonlySet<string>>>;
  readonly netTotal: MoneyValue;
  /** The card brand of the `payment_card` step; `null` at every other step. */
  readonly cardBrand: string | null;
}

/** The markup rules that apply to an offer. */
export interface MarkupSelection {
  /** The first matching non-stackable rule, or `null` when none matched. */
  readonly base: MarkupRule | null;
  /** The matching stackable rules that add to the base, in evaluation order. */
  readonly stacked: readonly MarkupRule[];
}

export type ScopeParseResult =
  { readonly ok: true; readonly scope: FeeScope } | { readonly ok: false; readonly reason: string };

/** A code as it is compared: trimmed and upper case. */
export function normaliseCode(value: string): string {
  return value.trim().toUpperCase();
}

/** The facts of `input` for matching; `cardBrand` only at the `payment_card` step. */
export function offerFacts(
  input: PricingInput,
  netTotal: MoneyValue,
  cardBrand: string | null = null,
): OfferFacts {
  const codes = (values: readonly (string | null)[]): ReadonlySet<string> =>
    new Set(values.filter((value): value is string => value !== null).map(normaliseCode));
  const travelerTypes = Object.entries(input.travelers)
    .filter(([, count]) => count > 0)
    .map(([type]) => type);
  return Object.freeze({
    at: input.at,
    lists: Object.freeze({
      origins: codes([input.origin]),
      destinations: codes([input.destination]),
      originCountries: codes([input.originCountry]),
      destinationCountries: codes([input.destinationCountry]),
      carriers: codes([...input.validatingCarriers, ...input.marketingCarriers]),
      cabins: codes(input.cabins),
      travelerTypes: codes(travelerTypes),
      tripTypes: codes([input.tripType]),
      sources: codes([input.source]),
      channels: codes([input.channel]),
    }),
    netTotal,
    cardBrand: cardBrand === null ? null : normaliseCode(cardBrand),
  });
}

/** Whether the rule is enabled and `at` is inside its validity window. */
export function isActiveAt(rule: PricingRuleBase, at: Date): boolean {
  const time = at.getTime();
  return (
    rule.isActive &&
    (rule.activeFrom === null || rule.activeFrom.getTime() <= time) &&
    (rule.activeUntil === null || time < rule.activeUntil.getTime())
  );
}

/** Evaluation order: `priority` ascending, then `id`. */
export function compareRules(a: PricingRuleBase, b: PricingRuleBase): number {
  if (a.priority !== b.priority) {
    return a.priority < b.priority ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/** Whether every non-empty field of `scope` matches the offer. */
export function scopeMatches(scope: FeeScope, facts: OfferFacts, ruleId = "rule"): boolean {
  for (const field of SCOPE_LIST_FIELDS) {
    const listed = scope[field];
    if (listed !== undefined && listed.length > 0) {
      const values = facts.lists[field];
      if (!listed.some((value) => values.has(normaliseCode(value)))) {
        return false;
      }
    }
  }
  const brands = scope.cardBrands;
  if (brands !== undefined && brands.length > 0) {
    if (facts.cardBrand === null || !brands.some((brand) => normaliseCode(brand) === facts.cardBrand)) {
      return false;
    }
  }
  if (scope.minNet !== undefined && scope.minNet !== null) {
    if (facts.netTotal.lt(toMoney(scope.minNet, `${ruleId}.scope.minNet`))) {
      return false;
    }
  }
  if (scope.maxNet !== undefined && scope.maxNet !== null) {
    if (facts.netTotal.gt(toMoney(scope.maxNet, `${ruleId}.scope.maxNet`))) {
      return false;
    }
  }
  return true;
}

/** The active, matching rules among `rules`, in evaluation order. */
function matching<R extends PricingRuleBase & { readonly scope: FeeScope }>(
  rules: readonly R[],
  facts: OfferFacts,
): R[] {
  return rules
    .filter((rule) => isActiveAt(rule, facts.at) && scopeMatches(rule.scope, facts, rule.id))
    .sort(compareRules);
}

/** The base markup rule and the stackable rules that add to it (OADR-0005 point 3). */
export function selectMarkupRules(rules: readonly MarkupRule[], facts: OfferFacts): MarkupSelection {
  const ordered = matching(rules, facts);
  const base = ordered.find((rule) => !rule.stackable) ?? null;
  const stacked = ordered.filter(
    (rule) => rule.stackable && (base === null || rule.priority < base.priority),
  );
  return Object.freeze({ base, stacked: Object.freeze(stacked) });
}

/** The first matching fee rule of `feeType`, or `null`. */
export function selectFeeRule(fees: readonly FeeRule[], facts: OfferFacts, feeType: FeeType): FeeRule | null {
  return (
    matching(
      fees.filter((fee) => fee.feeType === feeType),
      facts,
    )[0] ?? null
  );
}

/**
 * The travellers a `traveler` rule counts: those of the types its scope lists, or every traveller when it lists
 * none (a child discount per traveller applies to the children only).
 */
export function matchingTravelerCount(
  scope: PricingScope,
  travelers: Readonly<Record<string, number>>,
): number {
  const listed = scope.travelerTypes;
  const types = listed === undefined || listed.length === 0 ? null : new Set(listed.map(normaliseCode));
  let count = 0;
  for (const [type, travelerCount] of Object.entries(travelers)) {
    if (types === null || types.has(normaliseCode(type))) {
      count += travelerCount;
    }
  }
  return count;
}

const MAX_KEY_SHOWN = 64;

/** A key of the stored scope for a reason: quoted and shortened. Scopes hold codes, never personal data. */
function keyName(key: string): string {
  return JSON.stringify(key.length > MAX_KEY_SHOWN ? `${key.slice(0, MAX_KEY_SHOWN)}…` : key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isListField(key: string): key is ScopeListField {
  return (SCOPE_LIST_FIELDS as readonly string[]).includes(key);
}

function isAmountField(key: string): key is (typeof SCOPE_AMOUNT_FIELDS)[number] {
  return (SCOPE_AMOUNT_FIELDS as readonly string[]).includes(key);
}

/**
 * The stored `scope` (jsonb) of a markup rule or, with `kind` `fee`, of a fee rule, as a scope the engine evaluates:
 * list fields are arrays of non-empty strings (normalised to upper case), `minNet` and `maxNet` decimal strings or
 * `null`, and `cardBrands` is allowed in fee scopes only. Anything else, an unknown field included, is refused with a
 * reason: the rule is then skipped rather than applied more broadly than written.
 */
export function parseRuleScope(value: unknown, kind: "markup" | "fee"): ScopeParseResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "scope is not an object" };
  }
  const scope: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (isListField(key) || (kind === "fee" && key === FEE_SCOPE_CARD_BRANDS)) {
      if (!Array.isArray(field) || !field.every((item) => typeof item === "string" && item.trim() !== "")) {
        return { ok: false, reason: `scope.${key} is not a list of codes` };
      }
      scope[key] = Object.freeze(field.map((item: string) => normaliseCode(item)));
    } else if (isAmountField(key)) {
      if (field === null) {
        continue;
      }
      if (typeof field !== "string" || !DECIMAL_STRING.test(field)) {
        return { ok: false, reason: `scope.${key} is not a decimal string` };
      }
      scope[key] = field;
    } else {
      return { ok: false, reason: `scope has the unknown field ${keyName(key)}` };
    }
  }
  return { ok: true, scope: Object.freeze(scope) as FeeScope };
}
