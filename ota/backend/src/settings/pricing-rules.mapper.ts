// The console's markup and fee rules (console.settings.markupRules.* and feeRules.*, OBE-069; api-changes part 2 §2.1
// and §2.2, OADR-0005 points 3, 6 and 8): rows of `markup_rules` and `fee_rules` ↔ MarkupRule and FeeRule of the OTA
// document, the rules a create or update must satisfy beyond the schema, the warnings of a saved rule, and the list
// cursor. Pure: no I/O.
//
// Columns ↔ fields: `fixed`, `min` and `max` are one currency (`fixed_currency`, or `currency` of a fee rule) and three
// amounts (`fixed_amount`, `min_amount`, `max_amount`), so a percentage rule with caps keeps the caps' currency there;
// `scope` is the jsonb as sent (a default rule's catch-all scope is written `{}`); `activeFrom` and `activeUntil` are
// the window. A create fills what it omits with the documented defaults (markup: `appliesPer` traveler; fee: booking;
// both: priority 100, active, no window; markup not stackable, fee not refundable). An update is the stored rule with
// the sent fields replacing theirs (`null` clears, `scope` is replaced whole), checked again as a whole. An update
// that sends no `scope` leaves the stored jsonb as it is (the default markup rule's aside, always `{}`): the answer
// leaves out what the document cannot carry (below), and writing that back would widen the rule the engine applies
// (a lower-case code it reads upper-cased, a field it refuses the rule for).
//
// The rules of a rule (`400 VALIDATION_FAILED`, one field error per problem, JSON pointers into the rule as the body
// writes it, messages without values):
//
//   /percentage            required by `percentage` and `percentage_plus_fixed` [required]; a markup at least -100
//                          [minimum], a fee at most 100 [maximum] (the schema's pattern bounds the rest)
//   /fixed                 required by `fixed` and `percentage_plus_fixed` [required]
//   /fixed|min|max/amount  at most two decimals [decimals] and below 10 000 000 000 [maximum] (`numeric(12,2)`); a fee's
//                          not negative [minimum]
//   /min|max/currency      the currency of `fixed`, or of the first money field set [currency]
//   /activeFrom|activeUntil an instant `timestamptz` stores as written: not the year 0000, no leap second [format]
//   /activeUntil           after `activeFrom` [window]
//
// Warnings of a saved rule (SettingsWarning; the rule is saved anyway): `fixed_currency_not_default` when its money
// fields are in a currency other than the storefront's default currency (they apply only to offers in that currency,
// no conversion: OADR-0005 point 6), and for a markup rule `sells_below_net` when what its calculation uses can be
// negative (a negative percentage, fixed amount or upper cap: a discount, floored by the engine so that the selling
// price is never below zero, OADR-0005 point 4). Only the values a calculation uses count.
//
// Reading is defensive, as for every answer of a stored row: an amount that is not a decimal number (`NaN`), a
// percentage the document cannot carry, money without a currency and scope fields the document does not have are left
// out (answered `null` or omitted), so the answer always validates; a rule with such values is one the engine skips
// (rules.repository.ts `toMarkupRule`), and saving it again requires the values its calculation needs.
//
// The list cursor is opaque base64url JSON with the last rule's priority and id and the `active` filter it was issued
// for: a cursor of another filter or another rule kind, or with a priority outside the `integer` column's range, is
// `400 VALIDATION_FAILED` (`/query/cursor`).
import type { components } from "@velexis/api-types";
import type { FieldError } from "@velexis/errors";
import { DECIMAL_STRING, Money } from "../pricing/pricing.types";
import type {
  FeeRuleChanges,
  FeeRuleEditRow,
  MarkupRuleChanges,
  MarkupRuleEditRow,
} from "../pricing/rules.repository";
import { decodeKeysetCursor, encodeCursor, invalidCursor } from "../reference/reference.mapper";
import { PAYMENT_BRANDS } from "./storefront-settings.mapper";

type Schemas = components["schemas"];
export type ConsoleMarkupRule = Schemas["MarkupRule"];
export type ConsoleFeeRule = Schemas["FeeRule"];
export type MarkupRuleInput = Schemas["MarkupRuleInput"];
export type MarkupRuleUpdate = Schemas["MarkupRuleUpdate"];
export type FeeRuleInput = Schemas["FeeRuleInput"];
export type FeeRuleUpdate = Schemas["FeeRuleUpdate"];
export type MarkupRulePage = Schemas["MarkupRulePage"];
export type FeeRulePage = Schemas["FeeRulePage"];
export type PricingRuleScope = Schemas["PricingRuleScope"];
export type FeeRuleScope = Schemas["FeeRuleScope"];
export type SettingsWarning = Schemas["SettingsWarning"];
type MoneyAmount = Schemas["Money"];

/** A markup rule as a create writes it: every field of the input, the omitted ones defaulted. */
export type MarkupRuleState = Required<MarkupRuleInput>;
/**
 * Every column of `T`, each with a value. Not `Required<T>`: since Kysely 0.28.18 `Updateable` types every column as
 * `… | undefined`, which `Required` keeps under `exactOptionalPropertyTypes`, and an insert needs the values.
 */
type AllColumns<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
/** Every column a markup rule's create or update writes. */
export type MarkupRuleColumns = AllColumns<MarkupRuleChanges>;
/** Every column a fee rule's create or update writes. */
export type FeeRuleColumns = AllColumns<FeeRuleChanges>;
/** A fee rule as a create writes it: every field of the input, the omitted ones defaulted. */
export type FeeRuleState = Required<FeeRuleInput>;

/** `Cache-Control` of every answer: the OTA's own configuration, for one staff member. */
export const PRICING_RULES_CACHE_CONTROL = "private, no-store";

/** The ETag of a rule: `"<version>"` (the If-Match of its update and delete). */
export const ruleEtagOf = (version: number): string => `"${version}"`;

/* ------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */

/** The calculations that use the percentage, and those that use the fixed amount (as the engine reads them). */
const usesPercentage = (calculation: string): boolean =>
  calculation === "percentage" || calculation === "percentage_plus_fixed";
const usesFixed = (calculation: string): boolean =>
  calculation === "fixed" || calculation === "percentage_plus_fixed";

/** jsonb is written as JSON text (conventions §1). */
const json = (value: unknown): string => JSON.stringify(value);

/** A stored timestamp as the document writes it, or null. */
const instant = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** A stored amount that is a decimal number, or null (`NaN` is not one). */
const decimal = (value: string | null): string | null =>
  value !== null && DECIMAL_STRING.test(value) ? value : null;

/** A stored amount and currency as Money, or null when either is missing. */
function moneyOf(amount: string | null, currency: string | null): MoneyAmount | null {
  const value = decimal(amount);
  const code = currency?.trim().toUpperCase() ?? "";
  return value === null || !/^[A-Z]{3}$/.test(code) ? null : { amount: value, currency: code };
}

/** The percentage patterns of MarkupRule and FeeRule. */
const MARKUP_PERCENTAGE = /^-?[0-9]{1,3}(\.[0-9]{1,4})?$/;
const FEE_PERCENTAGE = /^[0-9]{1,3}(\.[0-9]{1,4})?$/;

/** The money fields of a rule, in the document's order. */
const MONEY_FIELDS = ["fixed", "min", "max"] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];

/** The money fields a state sets, with their values. */
function moneyFieldsOf(state: Pick<MarkupRuleState, MoneyField>): Array<[MoneyField, MoneyAmount]> {
  return MONEY_FIELDS.flatMap((field): Array<[MoneyField, MoneyAmount]> => {
    const value = state[field];
    return value === null ? [] : [[field, value]];
  });
}

/** The one currency of the money fields (`fixed_currency`, `currency`): the first set, or null. */
const currencyOf = (state: Pick<MarkupRuleState, MoneyField>): string | null =>
  moneyFieldsOf(state)[0]?.[1].currency ?? null;

/* ------------------------------------------------------------------------------------------------
 * Scopes
 * ---------------------------------------------------------------------------------------------- */

const CABINS: readonly Schemas["AmadeusTravelClass"][] = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"];
const TRAVELER_TYPES: readonly Schemas["AmadeusTravelerType"][] = [
  "ADULT",
  "CHILD",
  "SENIOR",
  "YOUNG",
  "HELD_INFANT",
  "SEATED_INFANT",
  "STUDENT",
];
const SOURCES: readonly Schemas["AmadeusFlightOfferSource"][] = ["GDS", "LTC", "PYTON", "EAC", "NDC"];
const TRIP_TYPES = ["one_way", "round_trip", "multi_city"] as const;
const CHANNELS = ["storefront", "console"] as const;

/** The list fields of a scope as the document allows them: an item pattern or the allowed values, and a maximum. */
const SCOPE_LISTS: ReadonlyArray<
  readonly [keyof FeeRuleScope, RegExp | readonly string[], number | undefined]
> = [
  ["origins", /^[A-Z]{3}$/, 200],
  ["destinations", /^[A-Z]{3}$/, 200],
  ["originCountries", /^[A-Z]{2}$/, 250],
  ["destinationCountries", /^[A-Z]{2}$/, 250],
  ["carriers", /^[A-Z0-9]{2}$/, 200],
  ["cabins", CABINS, undefined],
  ["travelerTypes", TRAVELER_TYPES, undefined],
  ["tripTypes", TRIP_TYPES, undefined],
  ["sources", SOURCES, undefined],
  ["channels", CHANNELS, undefined],
  ["cardBrands", PAYMENT_BRANDS, undefined],
];

/** The pattern of `minNet` and `maxNet`. */
const NET_BOUND = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored scope as the document can carry it (see the file header); `cardBrands` only for a fee rule. */
export function scopeOf(value: unknown, kind: "markup" | "fee"): FeeRuleScope {
  const stored = isRecord(value) ? value : {};
  const scope: Record<string, unknown> = {};
  for (const [field, allowed, max] of SCOPE_LISTS) {
    const items = stored[field];
    if ((field === "cardBrands" && kind === "markup") || !Array.isArray(items)) {
      continue;
    }
    const kept = [
      ...new Set(
        (items as unknown[]).filter(
          (item): item is string =>
            typeof item === "string" &&
            (allowed instanceof RegExp ? allowed.test(item) : allowed.includes(item)),
        ),
      ),
    ];
    scope[field] = max === undefined ? kept : kept.slice(0, max);
  }
  for (const field of ["minNet", "maxNet"] as const) {
    const bound = stored[field];
    if (bound === null || (typeof bound === "string" && NET_BOUND.test(bound))) {
      scope[field] = bound;
    }
  }
  return scope as FeeRuleScope;
}

/**
 * True when `scope` matches every offer: no list with an item, no net bound (`{}`, or empty lists and null bounds,
 * which the engine reads the same way). The default markup rule keeps such a scope.
 */
export function isCatchAllScope(scope: FeeRuleScope): boolean {
  return Object.entries(scope).every(([, value]) =>
    Array.isArray(value) ? value.length === 0 : value === null || value === undefined,
  );
}

/* ------------------------------------------------------------------------------------------------
 * Rows → the document
 * ---------------------------------------------------------------------------------------------- */

/** The rule fields markup and fee rows share, read defensively (see the file header). */
function commonOf(row: MarkupRuleEditRow | FeeRuleEditRow, currency: string | null) {
  return {
    calculation: row.calculation as MarkupRuleState["calculation"],
    fixed: moneyOf(row.fixed_amount, currency),
    appliesPer: row.applies_per as MarkupRuleState["appliesPer"],
    min: moneyOf(row.min_amount, currency),
    max: moneyOf(row.max_amount, currency),
    priority: row.priority,
    isActive: row.is_active,
    activeFrom: instant(row.active_from),
    activeUntil: instant(row.active_until),
  };
}

/** A `markup_rules` row as MarkupRule (without `warnings`). */
export function consoleMarkupRuleOf(row: MarkupRuleEditRow): ConsoleMarkupRule {
  const common = commonOf(row, row.fixed_currency);
  const percentage = decimal(row.percentage);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: scopeOf(row.scope, "markup"),
    calculation: common.calculation,
    percentage: percentage !== null && MARKUP_PERCENTAGE.test(percentage) ? percentage : null,
    fixed: common.fixed,
    appliesPer: common.appliesPer,
    min: common.min,
    max: common.max,
    priority: common.priority,
    stackable: row.stackable,
    isDefault: row.is_default,
    isActive: common.isActive,
    activeFrom: common.activeFrom,
    activeUntil: common.activeUntil,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** A `fee_rules` row as FeeRule (without `warnings`). */
export function consoleFeeRuleOf(row: FeeRuleEditRow): ConsoleFeeRule {
  const common = commonOf(row, row.currency);
  const percentage = decimal(row.percentage);
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    feeType: row.fee_type as FeeRuleState["feeType"],
    scope: scopeOf(row.scope, "fee"),
    calculation: common.calculation,
    percentage: percentage !== null && FEE_PERCENTAGE.test(percentage) ? percentage : null,
    fixed: common.fixed,
    appliesPer: common.appliesPer,
    min: common.min,
    max: common.max,
    refundable: row.refundable,
    priority: common.priority,
    isActive: common.isActive,
    activeFrom: common.activeFrom,
    activeUntil: common.activeUntil,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/* ------------------------------------------------------------------------------------------------
 * The document → the rule to write
 * ---------------------------------------------------------------------------------------------- */

/** A create's markup rule: the input with the documented defaults. */
export function markupStateOfInput(input: MarkupRuleInput): MarkupRuleState {
  return {
    name: input.name,
    description: input.description ?? null,
    scope: input.scope,
    calculation: input.calculation,
    percentage: input.percentage ?? null,
    fixed: input.fixed ?? null,
    appliesPer: input.appliesPer ?? "traveler",
    min: input.min ?? null,
    max: input.max ?? null,
    priority: input.priority ?? 100,
    stackable: input.stackable ?? false,
    isActive: input.isActive ?? true,
    activeFrom: input.activeFrom ?? null,
    activeUntil: input.activeUntil ?? null,
  };
}

/** A create's fee rule: the input with the documented defaults. */
export function feeStateOfInput(input: FeeRuleInput): FeeRuleState {
  return {
    name: input.name,
    label: input.label,
    feeType: input.feeType,
    scope: input.scope,
    calculation: input.calculation,
    percentage: input.percentage ?? null,
    fixed: input.fixed ?? null,
    appliesPer: input.appliesPer ?? "booking",
    min: input.min ?? null,
    max: input.max ?? null,
    refundable: input.refundable ?? false,
    priority: input.priority ?? 100,
    isActive: input.isActive ?? true,
    activeFrom: input.activeFrom ?? null,
    activeUntil: input.activeUntil ?? null,
  };
}

/** The stored markup rule as a state an update starts from. */
export function markupStateOfRule(rule: ConsoleMarkupRule): MarkupRuleState {
  return {
    name: rule.name,
    description: rule.description ?? null,
    scope: rule.scope,
    calculation: rule.calculation,
    percentage: rule.percentage ?? null,
    fixed: rule.fixed ?? null,
    appliesPer: rule.appliesPer,
    min: rule.min ?? null,
    max: rule.max ?? null,
    priority: rule.priority,
    stackable: rule.stackable,
    isActive: rule.isActive,
    activeFrom: rule.activeFrom ?? null,
    activeUntil: rule.activeUntil ?? null,
  };
}

/** The stored fee rule as a state an update starts from. */
export function feeStateOfRule(rule: ConsoleFeeRule): FeeRuleState {
  return {
    name: rule.name,
    label: rule.label,
    feeType: rule.feeType,
    scope: rule.scope,
    calculation: rule.calculation,
    percentage: rule.percentage ?? null,
    fixed: rule.fixed ?? null,
    appliesPer: rule.appliesPer,
    min: rule.min ?? null,
    max: rule.max ?? null,
    refundable: rule.refundable,
    priority: rule.priority,
    isActive: rule.isActive,
    activeFrom: rule.activeFrom ?? null,
    activeUntil: rule.activeUntil ?? null,
  };
}

/** The state with the fields an update sends replacing theirs (`null` clears, `scope` is replaced whole). */
export function mergeRuleUpdate<S extends object>(state: S, update: Partial<S>): S {
  const merged: S = { ...state };
  for (const [field, value] of Object.entries(update)) {
    if (value !== undefined) {
      Object.assign(merged, { [field]: value });
    }
  }
  return merged;
}

/** The columns of a markup rule (create and update write every one of them). */
export function markupColumnsOf(state: MarkupRuleState, isDefault: boolean): MarkupRuleColumns {
  return {
    name: state.name,
    description: state.description,
    scope: json(isDefault ? {} : state.scope),
    calculation: state.calculation,
    percentage: state.percentage,
    fixed_amount: state.fixed?.amount ?? null,
    fixed_currency: currencyOf(state),
    applies_per: state.appliesPer,
    min_amount: state.min?.amount ?? null,
    max_amount: state.max?.amount ?? null,
    priority: state.priority,
    stackable: state.stackable,
    is_active: state.isActive,
    active_from: state.activeFrom,
    active_until: state.activeUntil,
  };
}

/** The columns of a fee rule (create and update write every one of them). */
export function feeColumnsOf(state: FeeRuleState): FeeRuleColumns {
  return {
    name: state.name,
    label: state.label,
    fee_type: state.feeType,
    scope: json(state.scope),
    calculation: state.calculation,
    percentage: state.percentage,
    fixed_amount: state.fixed?.amount ?? null,
    currency: currencyOf(state),
    applies_per: state.appliesPer,
    min_amount: state.min?.amount ?? null,
    max_amount: state.max?.amount ?? null,
    refundable: state.refundable,
    priority: state.priority,
    is_active: state.isActive,
    active_from: state.activeFrom,
    active_until: state.activeUntil,
  };
}

/**
 * The columns an update of a markup rule writes: every column, but `scope` only when the update sends one or the rule
 * is the default rule (see the file header).
 */
export function markupChangesOf(
  state: MarkupRuleState,
  isDefault: boolean,
  update: Partial<MarkupRuleState>,
): MarkupRuleChanges {
  const { scope, ...columns } = markupColumnsOf(state, isDefault);
  return update.scope === undefined && !isDefault ? columns : { ...columns, scope };
}

/** The columns an update of a fee rule writes: every column, but `scope` only when the update sends one. */
export function feeChangesOf(state: FeeRuleState, update: Partial<FeeRuleState>): FeeRuleChanges {
  const { scope, ...columns } = feeColumnsOf(state);
  return update.scope === undefined ? columns : { ...columns, scope };
}

/* ------------------------------------------------------------------------------------------------
 * The rules of a rule
 * ---------------------------------------------------------------------------------------------- */

/** `numeric(12,2)`: below 10^10 in absolute value. */
const AMOUNT_LIMIT = new Money("10000000000");

const fieldError = (path: string, code: string, message: string): FieldError => ({ path, code, message });

/** The problems of the money fields: decimals, size, sign (fees) and one currency. */
function moneyProblems(state: Pick<MarkupRuleState, MoneyField>, kind: "markup" | "fee"): FieldError[] {
  const problems: FieldError[] = [];
  const fields = moneyFieldsOf(state);
  const currency = fields[0]?.[1].currency;
  for (const [field, money] of fields) {
    const amount = new Money(money.amount);
    if (amount.decimalPlaces() > 2) {
      problems.push(fieldError(`/${field}/amount`, "decimals", "Amounts have at most two decimals."));
    }
    if (amount.abs().gte(AMOUNT_LIMIT)) {
      problems.push(fieldError(`/${field}/amount`, "maximum", "Amounts are below 10 000 000 000."));
    }
    if (kind === "fee" && amount.isNegative() && !amount.isZero()) {
      problems.push(fieldError(`/${field}/amount`, "minimum", "Fee amounts are not negative."));
    }
    if (money.currency !== currency) {
      problems.push(
        fieldError(
          `/${field}/currency`,
          "currency",
          "The fixed amount and the caps share one currency: the currency of the first one set.",
        ),
      );
    }
  }
  return problems;
}

/**
 * Whether a `date-time` of the schema is an instant `timestamptz` stores as written: the format admits the year 0000,
 * which PostgreSQL refuses, and a leap second, which it moves to the next minute (and `Date.parse` cannot read).
 */
const isStorableInstant = (value: string): boolean =>
  !value.startsWith("0000-") && !Number.isNaN(Date.parse(value));

/** The problems the calculation, the percentage and the window share. */
function commonProblems(state: MarkupRuleState | FeeRuleState, kind: "markup" | "fee"): FieldError[] {
  const problems: FieldError[] = [];
  if (usesPercentage(state.calculation) && state.percentage === null) {
    problems.push(fieldError("/percentage", "required", `A ${state.calculation} rule needs a percentage.`));
  }
  if (usesFixed(state.calculation) && state.fixed === null) {
    problems.push(fieldError("/fixed", "required", `A ${state.calculation} rule needs a fixed amount.`));
  }
  if (state.percentage !== null) {
    const percentage = new Money(state.percentage);
    if (kind === "markup" && percentage.lt(-100)) {
      problems.push(fieldError("/percentage", "minimum", "A markup percentage is at least -100."));
    }
    if (kind === "fee" && percentage.gt(100)) {
      problems.push(fieldError("/percentage", "maximum", "A fee percentage is at most 100."));
    }
  }
  problems.push(...moneyProblems(state, kind));
  const window = { activeFrom: state.activeFrom, activeUntil: state.activeUntil };
  for (const [field, value] of Object.entries(window)) {
    if (value !== null && !isStorableInstant(value)) {
      problems.push(fieldError(`/${field}`, "format", "The time is not one PostgreSQL can store."));
    }
  }
  if (
    window.activeFrom !== null &&
    window.activeUntil !== null &&
    isStorableInstant(window.activeFrom) &&
    isStorableInstant(window.activeUntil) &&
    Date.parse(window.activeUntil) <= Date.parse(window.activeFrom)
  ) {
    problems.push(fieldError("/activeUntil", "window", "The end of the window is after its start."));
  }
  return problems;
}

/** What refuses a markup rule (see the file header); empty when it can be saved. */
export function markupRuleProblems(state: MarkupRuleState): FieldError[] {
  return commonProblems(state, "markup");
}

/** What refuses a fee rule (see the file header); empty when it can be saved. */
export function feeRuleProblems(state: FeeRuleState): FieldError[] {
  return commonProblems(state, "fee");
}

/* ------------------------------------------------------------------------------------------------
 * Warnings
 * ---------------------------------------------------------------------------------------------- */

/** `fixed_currency_not_default` of a rule whose money fields are not in `defaultCurrency`. */
function currencyWarning(
  state: Pick<MarkupRuleState, MoneyField>,
  defaultCurrency: string | null,
): SettingsWarning[] {
  const [first] = moneyFieldsOf(state);
  if (first === undefined || defaultCurrency === null || first[1].currency === defaultCurrency) {
    return [];
  }
  return [
    {
      code: "fixed_currency_not_default",
      message:
        "The rule's amounts are not in the storefront's default currency: they apply only to offers in their " +
        "currency, without conversion.",
      path: `/${first[0]}/currency`,
    },
  ];
}

/** The warnings of a saved markup rule (see the file header). */
export function markupRuleWarnings(
  state: MarkupRuleState,
  defaultCurrency: string | null,
): SettingsWarning[] {
  const negative = (value: string | null | undefined): boolean =>
    value !== null && value !== undefined && new Money(value).isNegative() && !new Money(value).isZero();
  const belowNet: string | undefined = [
    usesPercentage(state.calculation) && negative(state.percentage) ? "/percentage" : undefined,
    usesFixed(state.calculation) && negative(state.fixed?.amount) ? "/fixed/amount" : undefined,
    negative(state.max?.amount) ? "/max/amount" : undefined,
  ].find((path) => path !== undefined);
  return [
    ...currencyWarning(state, defaultCurrency),
    ...(belowNet === undefined
      ? []
      : [
          {
            code: "sells_below_net",
            message:
              "The rule can make a negative markup: matching offers can be sold below the net price (never " +
              "below zero).",
            path: belowNet,
          },
        ]),
  ];
}

/** The warnings of a saved fee rule (see the file header). */
export function feeRuleWarnings(state: FeeRuleState, defaultCurrency: string | null): SettingsWarning[] {
  return currencyWarning(state, defaultCurrency);
}

/* ------------------------------------------------------------------------------------------------
 * The list cursor
 * ---------------------------------------------------------------------------------------------- */

/** The rule ids of each kind. */
const RULE_ID = { markup: /^mkr_[0-9A-Za-z]{16,40}$/, fee: /^fee_[0-9A-Za-z]{16,40}$/ } as const;

/** The `active` filter as the cursor records it. */
const filterOf = (active: boolean | undefined): string => (active === undefined ? "all" : String(active));

/** The range of `priority` (`integer`): a cursor outside it is no position of a rule (and PostgreSQL would refuse it). */
const PRIORITY_MIN = -2_147_483_648;
const PRIORITY_MAX = 2_147_483_647;

/** The cursor of the page after the rule at `priority` and `id`, for the list of `active`. */
export function encodeRuleCursor(
  active: boolean | undefined,
  last: { readonly priority: number; readonly id: string },
): string {
  return encodeCursor({ p: String(last.priority), i: last.id, f: filterOf(active) });
}

/**
 * The position of a cursor of the `kind` list with the `active` filter; `400 VALIDATION_FAILED` (`/query/cursor`) for
 * one this list did not issue.
 */
export function decodeRuleCursor(
  kind: "markup" | "fee",
  active: boolean | undefined,
  cursor: string,
): { readonly priority: number; readonly id: string } {
  const { p, i, f } = decodeKeysetCursor(cursor, ["p", "i", "f"]);
  const priority = Number(p);
  if (
    !/^-?\d{1,10}$/.test(p) ||
    priority < PRIORITY_MIN ||
    priority > PRIORITY_MAX ||
    !RULE_ID[kind].test(i) ||
    f !== filterOf(active)
  ) {
    throw invalidCursor();
  }
  return { priority, id: i };
}
