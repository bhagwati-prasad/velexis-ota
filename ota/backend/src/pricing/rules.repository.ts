// The tenant repository of the pricing context (OADR-0005, conventions §2): it loads the enabled markup and fee rules
// of the tenant whose transaction it is given, and reads a currency's minor units from `reference.currencies`. Like
// every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a schema, so it
// only ever sees the tenant of that transaction (ADR-0004).
//
// A search prices up to 250 offers with the same rules: `loadActiveRules` queries once per transaction and hands every
// later call in it the same result, so the rules are loaded once per request whoever asks for them.
//
// Since OBE-069 the console's rule settings (settings/pricing-rules.service.ts) list, read, insert, update and delete
// the rows here, with their console columns (`description`, `version`, `created_at`, `updated_at`):
//
// - lists are in evaluation order (`priority`, then `id`) after a keyset position, with the `is_active` filter;
// - an update locks its row `FOR NO KEY UPDATE`, which a search's insert of offers that reference the rule (a
//   foreign-key `KEY SHARE`) never waits for, and writes it at `version + 1` with `updated_at = now()` only while it
//   is still at the version read;
// - a delete locks its row `FOR UPDATE` (the lock the DELETE takes anyway) and removes it: `ON DELETE SET NULL` of
//   `flight_offers`, `priced_offers` and `bookings` clears their `markup_rule_id`, their amounts and lines stay (OADR-0005
//   point 8). Fee rules have no referencing rows: priced offers, checkouts and bookings keep their fee lines in jsonb.
import { Injectable } from "@nestjs/common";
import {
  sql,
  type Insertable,
  type Selectable,
  type TenantDatabase,
  type Transaction,
  type Updateable,
} from "@velexis/db";
import {
  APPLIES_PER,
  DECIMAL_STRING,
  FEE_TYPES,
  PRICING_CALCULATIONS,
  type AppliesPer,
  type FeeRule,
  type FeeType,
  type MarkupRule,
  type PricingCalculation,
} from "./pricing.types";
import { parseRuleScope } from "./rule-matcher";

/** The open tenant transaction of the request (`tenantTx`). */
export type TenantTransaction = Transaction<TenantDatabase>;

/** A stored rule the engine cannot evaluate; it is left out of the active rules instead of applied. */
export interface InvalidPricingRule {
  readonly table: "markup_rules" | "fee_rules";
  readonly id: string;
  /** What is wrong, such as `scope has the unknown field "routes"`; never a value of the row. */
  readonly reason: string;
}

/** The enabled rules of the tenant, in evaluation order (`priority`, then `id`). */
export interface ActivePricingRules {
  readonly markupRules: readonly MarkupRule[];
  readonly feeRules: readonly FeeRule[];
  /** Enabled rows that were left out; the caller logs them (ids and reasons only). */
  readonly invalidRules: readonly InvalidPricingRule[];
}

const MARKUP_COLUMNS = [
  "id",
  "name",
  "scope",
  "calculation",
  "percentage",
  "fixed_amount",
  "fixed_currency",
  "applies_per",
  "min_amount",
  "max_amount",
  "priority",
  "stackable",
  "is_default",
  "is_active",
  "active_from",
  "active_until",
] as const;

const FEE_COLUMNS = [
  "id",
  "name",
  "label",
  "fee_type",
  "scope",
  "calculation",
  "percentage",
  "fixed_amount",
  "currency",
  "applies_per",
  "min_amount",
  "max_amount",
  "refundable",
  "priority",
  "is_active",
  "active_from",
  "active_until",
] as const;

export type MarkupRuleRow = Pick<Selectable<TenantDatabase["markup_rules"]>, (typeof MARKUP_COLUMNS)[number]>;
export type FeeRuleRow = Pick<Selectable<TenantDatabase["fee_rules"]>, (typeof FEE_COLUMNS)[number]>;

/** The columns the console reads besides the engine's. */
const CONSOLE_COLUMNS = ["version", "created_at", "updated_at"] as const;
const MARKUP_EDIT_COLUMNS = [...MARKUP_COLUMNS, "description", ...CONSOLE_COLUMNS] as const;
const FEE_EDIT_COLUMNS = [...FEE_COLUMNS, ...CONSOLE_COLUMNS] as const;

/** A `markup_rules` row as the console shows and edits it. */
export type MarkupRuleEditRow = Pick<
  Selectable<TenantDatabase["markup_rules"]>,
  (typeof MARKUP_EDIT_COLUMNS)[number]
>;
/** A `fee_rules` row as the console shows and edits it. */
export type FeeRuleEditRow = Pick<Selectable<TenantDatabase["fee_rules"]>, (typeof FEE_EDIT_COLUMNS)[number]>;

/** The columns a console create writes (the id and the defaults of the table aside, `is_default` is never set). */
export type MarkupRuleValues = Omit<
  Insertable<TenantDatabase["markup_rules"]>,
  "is_default" | "version" | "created_at" | "updated_at"
>;
export type FeeRuleValues = Omit<
  Insertable<TenantDatabase["fee_rules"]>,
  "version" | "created_at" | "updated_at"
>;

/** The columns a console update writes. */
export type MarkupRuleChanges = Omit<
  Updateable<TenantDatabase["markup_rules"]>,
  "id" | "is_default" | "version" | "created_at" | "updated_at" | "created_by_staff_id"
>;
export type FeeRuleChanges = Omit<
  Updateable<TenantDatabase["fee_rules"]>,
  "id" | "version" | "created_at" | "updated_at" | "created_by_staff_id"
>;

/** What a console list asks for: the `is_active` filter, the keyset position after which it starts, the row count. */
export interface RuleListQuery {
  /** `true`: enabled rules only; `false`: disabled ones only; `undefined`: every rule. */
  readonly active: boolean | undefined;
  /** The last rule of the previous page, in evaluation order. */
  readonly after: { readonly priority: number; readonly id: string } | undefined;
  readonly limit: number;
}

/** How the console reads one rule: plainly, or locked for its update or delete until the end of the transaction. */
export type RuleLock = "none" | "update" | "delete";

@Injectable()
export class RulesRepository {
  /** One load per transaction; an entry goes when its transaction object is garbage-collected. */
  readonly #loads = new WeakMap<TenantTransaction, Promise<ActivePricingRules>>();

  /**
   * The enabled (`is_active`) markup and fee rules of the transaction's tenant. The validity windows are left to the
   * engine, which checks them against the instant it prices at. The first call in a transaction queries; every later
   * call in the same transaction returns the same result.
   */
  loadActiveRules(trx: TenantTransaction): Promise<ActivePricingRules> {
    let load = this.#loads.get(trx);
    if (load === undefined) {
      load = queryActiveRules(trx);
      this.#loads.set(trx, load);
    }
    return load;
  }

  /** `reference.currencies.minor_units` of `code` (2 for EUR, 0 for JPY), or `null` for an unknown currency. */
  async currencyMinorUnits(trx: TenantTransaction, code: string): Promise<number | null> {
    const row = await trx
      .selectFrom("reference.currencies")
      .select("minor_units")
      .where("code", "=", code)
      .executeTakeFirst();
    return row?.minor_units ?? null;
  }

  // ---- The console's markup rules (OBE-069) ----------------------------------------------------------------------

  /** Up to `limit` markup rules in evaluation order after `after`, every rule or those of the `active` filter. */
  async listMarkupRules(trx: TenantTransaction, query: RuleListQuery): Promise<MarkupRuleEditRow[]> {
    let select = trx.selectFrom("markup_rules").select(MARKUP_EDIT_COLUMNS);
    if (query.active !== undefined) {
      select = select.where("is_active", "=", query.active);
    }
    const { after } = query;
    if (after !== undefined) {
      select = select.where((eb) =>
        eb.or([
          eb("priority", ">", after.priority),
          eb.and([eb("priority", "=", after.priority), eb("id", ">", after.id)]),
        ]),
      );
    }
    return await select.orderBy("priority").orderBy("id").limit(query.limit).execute();
  }

  /** The markup rule `id`, locked as `lock` says (see the file header), or `undefined`. */
  async markupRuleById(
    trx: TenantTransaction,
    id: string,
    lock: RuleLock = "none",
  ): Promise<MarkupRuleEditRow | undefined> {
    const select = trx.selectFrom("markup_rules").select(MARKUP_EDIT_COLUMNS).where("id", "=", id);
    const locked =
      lock === "update" ? select.forNoKeyUpdate() : lock === "delete" ? select.forUpdate() : select;
    return await locked.executeTakeFirst();
  }

  /** Inserts a markup rule (never a default one) and returns it as stored. */
  async insertMarkupRule(trx: TenantTransaction, values: MarkupRuleValues): Promise<MarkupRuleEditRow> {
    return await trx
      .insertInto("markup_rules")
      .values({ ...values, is_default: false })
      .returning(MARKUP_EDIT_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * Writes `changes` to the markup rule `id` at `version` and moves it to `version + 1` with `updated_at = now()`;
   * `undefined` when the row is gone or no longer at that version.
   */
  async updateMarkupRule(
    trx: TenantTransaction,
    id: string,
    version: number,
    changes: MarkupRuleChanges,
  ): Promise<MarkupRuleEditRow | undefined> {
    return await trx
      .updateTable("markup_rules")
      .set({ ...changes, version: sql<number>`version + 1`, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .where("version", "=", version)
      .returning(MARKUP_EDIT_COLUMNS)
      .executeTakeFirst();
  }

  /**
   * Deletes the markup rule `id` at `version` (never the default rule); the referencing offers and bookings keep their
   * amounts and lose the reference (see the file header). False when no such row was deleted.
   */
  async deleteMarkupRule(trx: TenantTransaction, id: string, version: number): Promise<boolean> {
    const deleted = await trx
      .deleteFrom("markup_rules")
      .where("id", "=", id)
      .where("version", "=", version)
      .where("is_default", "=", false)
      .executeTakeFirst();
    return deleted.numDeletedRows > 0n;
  }

  // ---- The console's fee rules (OBE-069) -------------------------------------------------------------------------

  /** Up to `limit` fee rules in evaluation order after `after`, every rule or those of the `active` filter. */
  async listFeeRules(trx: TenantTransaction, query: RuleListQuery): Promise<FeeRuleEditRow[]> {
    let select = trx.selectFrom("fee_rules").select(FEE_EDIT_COLUMNS);
    if (query.active !== undefined) {
      select = select.where("is_active", "=", query.active);
    }
    const { after } = query;
    if (after !== undefined) {
      select = select.where((eb) =>
        eb.or([
          eb("priority", ">", after.priority),
          eb.and([eb("priority", "=", after.priority), eb("id", ">", after.id)]),
        ]),
      );
    }
    return await select.orderBy("priority").orderBy("id").limit(query.limit).execute();
  }

  /** The fee rule `id`, locked as `lock` says (see the file header), or `undefined`. */
  async feeRuleById(
    trx: TenantTransaction,
    id: string,
    lock: RuleLock = "none",
  ): Promise<FeeRuleEditRow | undefined> {
    const select = trx.selectFrom("fee_rules").select(FEE_EDIT_COLUMNS).where("id", "=", id);
    const locked =
      lock === "update" ? select.forNoKeyUpdate() : lock === "delete" ? select.forUpdate() : select;
    return await locked.executeTakeFirst();
  }

  /** Inserts a fee rule and returns it as stored. */
  async insertFeeRule(trx: TenantTransaction, values: FeeRuleValues): Promise<FeeRuleEditRow> {
    return await trx
      .insertInto("fee_rules")
      .values(values)
      .returning(FEE_EDIT_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** As `updateMarkupRule`, for the fee rule `id`. */
  async updateFeeRule(
    trx: TenantTransaction,
    id: string,
    version: number,
    changes: FeeRuleChanges,
  ): Promise<FeeRuleEditRow | undefined> {
    return await trx
      .updateTable("fee_rules")
      .set({ ...changes, version: sql<number>`version + 1`, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .where("version", "=", version)
      .returning(FEE_EDIT_COLUMNS)
      .executeTakeFirst();
  }

  /** Deletes the fee rule `id` at `version`; false when no such row was deleted. */
  async deleteFeeRule(trx: TenantTransaction, id: string, version: number): Promise<boolean> {
    const deleted = await trx
      .deleteFrom("fee_rules")
      .where("id", "=", id)
      .where("version", "=", version)
      .executeTakeFirst();
    return deleted.numDeletedRows > 0n;
  }
}

async function queryActiveRules(trx: TenantTransaction): Promise<ActivePricingRules> {
  const markupRows = await trx
    .selectFrom("markup_rules")
    .select(MARKUP_COLUMNS)
    .where("is_active", "=", true)
    .orderBy("priority")
    .orderBy("id")
    .execute();
  const feeRows = await trx
    .selectFrom("fee_rules")
    .select(FEE_COLUMNS)
    .where("is_active", "=", true)
    .orderBy("priority")
    .orderBy("id")
    .execute();

  const markupRules: MarkupRule[] = [];
  const feeRules: FeeRule[] = [];
  const invalidRules: InvalidPricingRule[] = [];
  for (const row of markupRows) {
    const rule = toMarkupRule(row);
    if ("reason" in rule) {
      invalidRules.push(rule);
    } else {
      markupRules.push(rule);
    }
  }
  for (const row of feeRows) {
    const rule = toFeeRule(row);
    if ("reason" in rule) {
      invalidRules.push(rule);
    } else {
      feeRules.push(rule);
    }
  }
  return Object.freeze({
    markupRules: Object.freeze(markupRules),
    feeRules: Object.freeze(feeRules),
    invalidRules: Object.freeze(invalidRules),
  });
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

/** The amounts `calculation` needs, as the `markup_rules_values_ck` CHECK requires them (fee rules have none). */
function missingValue(
  calculation: PricingCalculation,
  percentage: string | null,
  fixedAmount: string | null,
): string | null {
  if (calculation !== "fixed" && percentage === null) {
    return `calculation ${calculation} has no percentage`;
  }
  if (calculation !== "percentage" && fixedAmount === null) {
    return `calculation ${calculation} has no fixed_amount`;
  }
  return null;
}

/**
 * The first amount column holding something other than a decimal number. PostgreSQL stores `'NaN'` in a `numeric`
 * column, even past `fee_rules.fixed_amount >= 0` (NaN sorts above every number), and the engine refuses it for every
 * offer the rule matches.
 */
function notDecimal(row: MarkupRuleRow | FeeRuleRow): string | null {
  const amounts = {
    percentage: row.percentage,
    fixed_amount: row.fixed_amount,
    min_amount: row.min_amount,
    max_amount: row.max_amount,
  };
  for (const [column, value] of Object.entries(amounts)) {
    if (value !== null && !DECIMAL_STRING.test(value)) {
      return column;
    }
  }
  return null;
}

/** What markup and fee rows share, checked; or the reason the row cannot be evaluated. */
function commonFields(
  row: MarkupRuleRow | FeeRuleRow,
): { calculation: PricingCalculation; appliesPer: AppliesPer } | { reason: string } {
  const { calculation } = row;
  if (!isOneOf(calculation, PRICING_CALCULATIONS)) {
    return { reason: `calculation is not one of ${PRICING_CALCULATIONS.join(", ")}` };
  }
  if (!isOneOf(row.applies_per, APPLIES_PER)) {
    return { reason: `applies_per is not one of ${APPLIES_PER.join(", ")}` };
  }
  const column = notDecimal(row);
  if (column !== null) {
    return { reason: `${column} is not a decimal number` };
  }
  const missing = missingValue(calculation, row.percentage, row.fixed_amount);
  return missing === null ? { calculation, appliesPer: row.applies_per } : { reason: missing };
}

/** A `markup_rules` row as the engine reads it, or why it cannot be evaluated. */
export function toMarkupRule(row: MarkupRuleRow): MarkupRule | InvalidPricingRule {
  const invalid = (reason: string): InvalidPricingRule =>
    Object.freeze({ table: "markup_rules", id: row.id, reason });
  const common = commonFields(row);
  if ("reason" in common) {
    return invalid(common.reason);
  }
  const scope = parseRuleScope(row.scope, "markup");
  if (!scope.ok) {
    return invalid(scope.reason);
  }
  return Object.freeze({
    id: row.id,
    name: row.name,
    scope: scope.scope,
    calculation: common.calculation,
    percentage: row.percentage,
    fixedAmount: row.fixed_amount,
    fixedCurrency: row.fixed_currency,
    appliesPer: common.appliesPer,
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
    priority: row.priority,
    stackable: row.stackable,
    isDefault: row.is_default,
    isActive: row.is_active,
    activeFrom: row.active_from,
    activeUntil: row.active_until,
  });
}

/** A `fee_rules` row as the engine reads it (`currency` is the fixed amount's), or why it cannot be evaluated. */
export function toFeeRule(row: FeeRuleRow): FeeRule | InvalidPricingRule {
  const invalid = (reason: string): InvalidPricingRule =>
    Object.freeze({ table: "fee_rules", id: row.id, reason });
  const common = commonFields(row);
  if ("reason" in common) {
    return invalid(common.reason);
  }
  const feeType: string = row.fee_type;
  if (!isOneOf<FeeType>(feeType, FEE_TYPES)) {
    return invalid(`fee_type is not one of ${FEE_TYPES.join(", ")}`);
  }
  const scope = parseRuleScope(row.scope, "fee");
  if (!scope.ok) {
    return invalid(scope.reason);
  }
  return Object.freeze({
    id: row.id,
    name: row.name,
    label: row.label,
    feeType,
    scope: scope.scope,
    calculation: common.calculation,
    percentage: row.percentage,
    fixedAmount: row.fixed_amount,
    fixedCurrency: row.currency,
    appliesPer: common.appliesPer,
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
    refundable: row.refundable,
    priority: row.priority,
    isActive: row.is_active,
    activeFrom: row.active_from,
    activeUntil: row.active_until,
  });
}
