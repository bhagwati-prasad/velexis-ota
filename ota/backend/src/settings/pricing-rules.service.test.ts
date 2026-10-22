// console.settings.markupRules.* and feeRules.* without PostgreSQL (OBE-069): the rows ↔ MarkupRule and FeeRule mapping
// (checked against the OTA document with the checker of the integration tests), the rules a create or update must
// satisfy beyond the schema, the warnings, the list cursor, and the service's order of checks, writes and audit rows
// with an in-memory repository that keeps the rows as PostgreSQL would (numeric scales, versions, the keyset order).
// The SQL, the pipeline, the permissions and the next search after a change are
// test/integration/settings/pricing-rules.int.test.ts.
import { AppError } from "@velexis/errors";
import { responseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../common/ids";
import type { StaffActionActor, StaffActionEntry, StaffActionsWriter } from "../console/staff-actions.writer";
import { Money } from "../pricing/pricing.types";
import type {
  FeeRuleChanges,
  FeeRuleEditRow,
  FeeRuleValues,
  MarkupRuleChanges,
  MarkupRuleEditRow,
  MarkupRuleValues,
  RuleListQuery,
  RuleLock,
  RulesRepository,
} from "../pricing/rules.repository";
import type { StorefrontRepository } from "../storefront/storefront.repository";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import type { IdGenerator } from "../common/ids";
import {
  consoleFeeRuleOf,
  consoleMarkupRuleOf,
  decodeRuleCursor,
  encodeRuleCursor,
  feeRuleProblems,
  feeRuleWarnings,
  feeStateOfInput,
  isCatchAllScope,
  markupColumnsOf,
  markupRuleProblems,
  markupRuleWarnings,
  markupStateOfInput,
  ruleEtagOf,
  scopeOf,
  type MarkupRuleState,
} from "./pricing-rules.mapper";
import { PricingRulesService } from "./pricing-rules.service";

let checker: ResponseChecker;

// Parsing the OTA document and compiling the response validators of the operations checked below takes about a second
// alone, several times that while every package's tests run at once on a 4-CPU runner: paid once here, with a budget
// that only stops a hang.
beforeAll(() => {
  checker = responseChecker("ota");
  for (const [operationId, status] of [
    ["consoleGetMarkupRule", 200],
    ["consoleCreateMarkupRule", 201],
    ["consoleListMarkupRules", 200],
    ["consoleGetFeeRule", 200],
    ["consoleCreateFeeRule", 201],
  ] as const) {
    checker.check(operationId, { status, body: {} });
  }
}, 60_000);

const CREATED = new Date("2026-09-01T08:00:00.000Z");
const STAFF_ID = "stf_01JA4CH3G1K4N7R0V3X6A9D2F6";

/** A stored markup row with the column defaults, as PostgreSQL returns it. */
function markupRow(overrides: Partial<MarkupRuleEditRow> = {}): MarkupRuleEditRow {
  return {
    id: newId("mkr", CREATED),
    name: "Long-haul economy",
    description: null,
    scope: {},
    calculation: "percentage",
    percentage: "4.0000",
    fixed_amount: null,
    fixed_currency: null,
    applies_per: "traveler",
    min_amount: null,
    max_amount: null,
    priority: 100,
    stackable: false,
    is_default: false,
    is_active: true,
    active_from: null,
    active_until: null,
    version: 1,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

/** A stored fee row with the column defaults. */
function feeRow(overrides: Partial<FeeRuleEditRow> = {}): FeeRuleEditRow {
  return {
    id: newId("fee", CREATED),
    name: "Service fee",
    label: "Service fee",
    fee_type: "booking_service",
    scope: {},
    calculation: "fixed",
    percentage: null,
    fixed_amount: "12.00",
    currency: "EUR",
    applies_per: "booking",
    min_amount: null,
    max_amount: null,
    refundable: false,
    priority: 100,
    is_active: true,
    active_from: null,
    active_until: null,
    version: 1,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

/** A markup state as a create with `input` writes it. */
const markupState = (input: Partial<MarkupRuleState> = {}): MarkupRuleState =>
  markupStateOfInput({ name: "Rule", scope: {}, calculation: "percentage", percentage: "5.0000", ...input });

const eur = (amount: string) => ({ amount, currency: "EUR" });

/* ------------------------------------------------------------------------------------------------
 * The mapping
 * ---------------------------------------------------------------------------------------------- */

describe("the rows as MarkupRule and FeeRule", () => {
  it("answers a stored markup rule as the document's MarkupRule, its caps in the rule's currency", () => {
    const row = markupRow({
      scope: { originCountries: ["FR"], cabins: ["ECONOMY"], minNet: "400.00" },
      min_amount: "15.00",
      fixed_currency: "EUR",
    });

    const rule = consoleMarkupRuleOf(row);

    expect(checker.check("consoleGetMarkupRule", { status: 200, body: rule })).toEqual([]);
    expect(rule).toEqual({
      id: row.id,
      name: "Long-haul economy",
      description: null,
      scope: { originCountries: ["FR"], cabins: ["ECONOMY"], minNet: "400.00" },
      calculation: "percentage",
      percentage: "4.0000",
      fixed: null,
      appliesPer: "traveler",
      min: { amount: "15.00", currency: "EUR" },
      max: null,
      priority: 100,
      stackable: false,
      isDefault: false,
      isActive: true,
      activeFrom: null,
      activeUntil: null,
      version: 1,
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    });
    expect(ruleEtagOf(rule.version)).toBe('"1"');
  });

  it("answers a stored fee rule as the document's FeeRule, card brands in its scope", () => {
    const row = feeRow({ fee_type: "payment_card", scope: { cardBrands: ["AMERICAN_EXPRESS"] } });

    const rule = consoleFeeRuleOf(row);

    expect(checker.check("consoleGetFeeRule", { status: 200, body: rule })).toEqual([]);
    expect(rule).toMatchObject({
      feeType: "payment_card",
      scope: { cardBrands: ["AMERICAN_EXPRESS"] },
      fixed: { amount: "12.00", currency: "EUR" },
      refundable: false,
    });
  });

  it("answers stored values the document cannot carry as null or leaves them out, so the answer stays valid", () => {
    const markup = consoleMarkupRuleOf(
      markupRow({
        scope: { routes: ["MAD-ORY"], carriers: ["AF", "af", 7], cardBrands: ["VISA"], maxNet: "1e3" },
        calculation: "fixed",
        percentage: "1000.0000",
        fixed_amount: "NaN",
        fixed_currency: "EUR",
        max_amount: "50.00",
      }),
    );
    const fee = consoleFeeRuleOf(feeRow({ currency: null }));

    expect(checker.check("consoleGetMarkupRule", { status: 200, body: markup })).toEqual([]);
    expect(checker.check("consoleGetFeeRule", { status: 200, body: fee })).toEqual([]);
    expect(markup).toMatchObject({
      scope: { carriers: ["AF"] },
      percentage: null,
      fixed: null,
      max: { amount: "50.00", currency: "EUR" },
    });
    expect(fee.fixed).toBeNull();
    expect(scopeOf("not an object", "fee")).toEqual({});
  });

  it("fills a create's omitted fields with the documented defaults", () => {
    expect(markupStateOfInput({ name: "A", scope: {}, calculation: "percentage", percentage: "1" })).toEqual({
      name: "A",
      description: null,
      scope: {},
      calculation: "percentage",
      percentage: "1",
      fixed: null,
      appliesPer: "traveler",
      min: null,
      max: null,
      priority: 100,
      stackable: false,
      isActive: true,
      activeFrom: null,
      activeUntil: null,
    });
    expect(
      feeStateOfInput({
        name: "F",
        label: "Fee",
        feeType: "ticketing",
        scope: {},
        calculation: "fixed",
        fixed: eur("5"),
      }),
    ).toMatchObject({ appliesPer: "booking", refundable: false, priority: 100, isActive: true });
  });

  it("writes the caps' currency with the amounts, and the default rule's scope as {}", () => {
    const state = markupState({ min: eur("15.00"), max: eur("80.00") });

    expect(markupColumnsOf(state, false)).toMatchObject({
      fixed_amount: null,
      fixed_currency: "EUR",
      min_amount: "15.00",
      max_amount: "80.00",
      scope: "{}",
    });
    expect(markupColumnsOf({ ...state, scope: { carriers: [], minNet: null } }, true).scope).toBe("{}");
    expect(markupColumnsOf({ ...state, scope: { carriers: ["AF"] } }, false).scope).toBe(
      '{"carriers":["AF"]}',
    );
  });

  it("knows a catch-all scope: no list with an item and no net bound", () => {
    expect(isCatchAllScope({})).toBe(true);
    expect(isCatchAllScope({ carriers: [], cabins: [], minNet: null, maxNet: null })).toBe(true);
    expect(isCatchAllScope({ carriers: ["AF"] })).toBe(false);
    expect(isCatchAllScope({ minNet: "100.00" })).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------
 * The rules of a rule and the warnings
 * ---------------------------------------------------------------------------------------------- */

describe("the rules of a rule", () => {
  it("accepts the document's examples", () => {
    expect(
      markupRuleProblems(
        markupState({ appliesPer: "traveler", percentage: "4.0000", min: eur("15.00"), priority: 100 }),
      ),
    ).toEqual([]);
    expect(
      markupRuleProblems(
        markupState({
          calculation: "fixed",
          percentage: null,
          fixed: eur("-10.00"),
          activeFrom: "2026-10-01T00:00:00Z",
          activeUntil: "2026-11-01T00:00:00Z",
        }),
      ),
    ).toEqual([]);
  });

  it("requires the values the calculation uses", () => {
    const paths = (state: MarkupRuleState) => markupRuleProblems(state).map((e) => [e.path, e.code]);

    expect(paths(markupState({ percentage: null }))).toEqual([["/percentage", "required"]]);
    expect(paths(markupState({ calculation: "fixed" }))).toEqual([["/fixed", "required"]]);
    expect(paths(markupState({ calculation: "percentage_plus_fixed", percentage: null }))).toEqual([
      ["/percentage", "required"],
      ["/fixed", "required"],
    ]);
  });

  it("bounds the percentage: a markup at least -100, a fee at most 100", () => {
    expect(markupRuleProblems(markupState({ percentage: "-100.0000" }))).toEqual([]);
    expect(markupRuleProblems(markupState({ percentage: "-100.0001" }))).toEqual([
      expect.objectContaining({ path: "/percentage", code: "minimum" }),
    ]);
    const fee = feeStateOfInput({
      name: "Card",
      label: "Card fee",
      feeType: "payment_card",
      scope: {},
      calculation: "percentage",
      percentage: "100.0001",
    });
    expect(feeRuleProblems({ ...fee, percentage: "100" })).toEqual([]);
    expect(feeRuleProblems(fee)).toEqual([expect.objectContaining({ path: "/percentage", code: "maximum" })]);
  });

  it("keeps amounts to two decimals and numeric(12,2), fees not negative, and one currency", () => {
    const problems = markupRuleProblems(
      markupState({
        calculation: "percentage_plus_fixed",
        fixed: eur("1.005"),
        min: { amount: "10000000000", currency: "EUR" },
        max: { amount: "20.00", currency: "USD" },
      }),
    );
    expect(problems.map((e) => [e.path, e.code])).toEqual([
      ["/fixed/amount", "decimals"],
      ["/min/amount", "maximum"],
      ["/max/currency", "currency"],
    ]);
    // A negative markup is a discount; a negative fee is refused.
    expect(markupRuleProblems(markupState({ calculation: "fixed", fixed: eur("-9999999999.99") }))).toEqual(
      [],
    );
    const fee = feeStateOfInput({
      name: "F",
      label: "Fee",
      feeType: "booking_service",
      scope: {},
      calculation: "fixed",
      fixed: eur("-1.00"),
      max: eur("-0.00"),
    });
    expect(feeRuleProblems(fee).map((e) => [e.path, e.code])).toEqual([["/fixed/amount", "minimum"]]);
    for (const problem of [...problems, ...feeRuleProblems(fee)]) {
      // Messages never echo the value.
      expect(problem.message).not.toMatch(/1\.005|10000000000|USD|-1\.00/);
    }
  });

  it("requires the end of the window after its start", () => {
    const window = (activeFrom: string, activeUntil: string) =>
      markupRuleProblems(markupState({ activeFrom, activeUntil })).map((e) => [e.path, e.code]);

    expect(window("2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")).toEqual([["/activeUntil", "window"]]);
    expect(window("2026-10-01T02:00:00+02:00", "2026-10-01T00:00:01Z")).toEqual([]);
    // The date-time format admits both; PostgreSQL refuses the year 0000 and moves a leap second to the next minute.
    expect(window("0000-01-01T00:00:00Z", "2026-10-01T00:00:00Z")).toEqual([["/activeFrom", "format"]]);
    expect(window("2026-06-30T23:59:00Z", "2026-06-30T23:59:60Z")).toEqual([["/activeUntil", "format"]]);
  });
});

describe("the warnings of a saved rule", () => {
  it("warns about amounts in another currency than the storefront's default, and only then", () => {
    const usd = markupState({ calculation: "fixed", fixed: { amount: "10.00", currency: "USD" } });

    expect(markupRuleWarnings(usd, "EUR")).toEqual([
      { code: "fixed_currency_not_default", message: expect.any(String), path: "/fixed/currency" },
    ]);
    expect(markupRuleWarnings(markupState({ max: { amount: "50.00", currency: "GBP" } }), "EUR")).toEqual([
      expect.objectContaining({ code: "fixed_currency_not_default", path: "/max/currency" }),
    ]);
    expect(markupRuleWarnings(usd, "USD")).toEqual([]);
    expect(markupRuleWarnings(markupState(), "EUR")).toEqual([]);
    expect(markupRuleWarnings(usd, null)).toEqual([]);
    const fee = feeStateOfInput({
      name: "F",
      label: "Fee",
      feeType: "booking_service",
      scope: {},
      calculation: "fixed",
      fixed: { amount: "5.00", currency: "USD" },
    });
    expect(feeRuleWarnings(fee, "EUR")).toEqual([
      expect.objectContaining({ code: "fixed_currency_not_default", path: "/fixed/currency" }),
    ]);
  });

  it("warns about a markup that can sell below net: a negative percentage, fixed amount or upper cap it uses", () => {
    const codes = (state: MarkupRuleState) => markupRuleWarnings(state, "EUR").map((w) => [w.code, w.path]);

    expect(codes(markupState({ percentage: "-5.0000" }))).toEqual([["sells_below_net", "/percentage"]]);
    expect(codes(markupState({ calculation: "fixed", percentage: null, fixed: eur("-10.00") }))).toEqual([
      ["sells_below_net", "/fixed/amount"],
    ]);
    expect(codes(markupState({ max: eur("-1.00") }))).toEqual([["sells_below_net", "/max/amount"]]);
    // Values the calculation does not use, zero and positive markups do not sell below net.
    expect(codes(markupState({ calculation: "fixed", percentage: "-5.0000", fixed: eur("3.00") }))).toEqual(
      [],
    );
    expect(codes(markupState({ percentage: "-0.0000" }))).toEqual([]);
    expect(codes(markupState({ percentage: "0" }))).toEqual([]);
  });
});

describe("the list cursor", () => {
  it("round-trips the last rule of a page for its filter and kind only", () => {
    const id = newId("mkr", CREATED);
    const cursor = encodeRuleCursor(true, { priority: 100, id });

    expect(decodeRuleCursor("markup", true, cursor)).toEqual({ priority: 100, id });
    expect(decodeRuleCursor("markup", undefined, encodeRuleCursor(undefined, { priority: -3, id }))).toEqual({
      priority: -3,
      id,
    });
    for (const [kind, active, value] of [
      ["markup", false, cursor],
      ["markup", undefined, cursor],
      ["fee", true, cursor],
      ["markup", true, "not-a-cursor"],
      ["markup", true, Buffer.from('{"p":"1.5","i":"x","f":"true"}').toString("base64url")],
      // A priority no `integer` column holds (PostgreSQL would refuse the comparison).
      ["markup", undefined, encodeRuleCursor(undefined, { priority: 2_147_483_648, id })],
      ["markup", undefined, encodeRuleCursor(undefined, { priority: -2_147_483_649, id })],
      ["markup", undefined, encodeRuleCursor(undefined, { priority: 9_999_999_999, id })],
    ] as const) {
      expect(() => decodeRuleCursor(kind, active, value)).toThrow(AppError);
    }
    expect(
      decodeRuleCursor("markup", undefined, encodeRuleCursor(undefined, { priority: 2_147_483_647, id })),
    ).toEqual({ priority: 2_147_483_647, id });
  });
});

/* ------------------------------------------------------------------------------------------------
 * The service
 * ---------------------------------------------------------------------------------------------- */

const TRX = { transaction: "alpha" } as unknown as TenantTransaction;
const NOW = new Date("2026-10-02T10:00:00.000Z");

/** PostgreSQL's text of a numeric(p, scale) value, or null. */
const scaled = (value: unknown, scale: number): string | null =>
  typeof value === "string" || typeof value === "number" ? new Money(value).toFixed(scale) : null;

/** PostgreSQL's timestamptz of a written value, or null. */
const timestamp = (value: unknown): Date | null =>
  typeof value === "string" || value instanceof Date ? new Date(value) : null;

/** The repository on in-memory rows, with the SQL's numeric scales, versions, keyset order and the default rule. */
class MemoryRules {
  markup: MarkupRuleEditRow[] = [];
  fee: FeeRuleEditRow[] = [];
  readonly locks: string[] = [];

  private static sorted<R extends { priority: number; id: string; is_active: boolean }>(
    rows: readonly R[],
    query: RuleListQuery,
  ): R[] {
    return rows
      .filter((row) => query.active === undefined || row.is_active === query.active)
      .filter(
        (row) =>
          query.after === undefined ||
          row.priority > query.after.priority ||
          (row.priority === query.after.priority && row.id > query.after.id),
      )
      .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, query.limit);
  }

  /** The columns written, as PostgreSQL stores and returns them (an update may leave `scope` out). */
  private static stored(changes: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return {
      ...changes,
      ...(changes["scope"] === undefined ? {} : { scope: JSON.parse(String(changes["scope"])) as unknown }),
      percentage: scaled(changes["percentage"], 4),
      fixed_amount: scaled(changes["fixed_amount"], 2),
      min_amount: scaled(changes["min_amount"], 2),
      max_amount: scaled(changes["max_amount"], 2),
      active_from: timestamp(changes["active_from"]),
      active_until: timestamp(changes["active_until"]),
    };
  }

  listMarkupRules(trx: TenantTransaction, query: RuleListQuery): Promise<MarkupRuleEditRow[]> {
    expect(trx).toBe(TRX);
    return Promise.resolve(MemoryRules.sorted(this.markup, query));
  }

  markupRuleById(_trx: TenantTransaction, id: string, lock: RuleLock = "none") {
    this.locks.push(`markup:${lock}`);
    return Promise.resolve(this.markup.find((row) => row.id === id));
  }

  insertMarkupRule(_trx: TenantTransaction, values: MarkupRuleValues): Promise<MarkupRuleEditRow> {
    const row = {
      ...markupRow(),
      ...MemoryRules.stored(values),
      id: values.id,
      created_at: NOW,
      updated_at: NOW,
    };
    this.markup.push(row as MarkupRuleEditRow);
    return Promise.resolve(row as MarkupRuleEditRow);
  }

  updateMarkupRule(_trx: TenantTransaction, id: string, version: number, changes: MarkupRuleChanges) {
    const index = this.markup.findIndex((row) => row.id === id && row.version === version);
    const current = this.markup[index];
    if (current === undefined) {
      return Promise.resolve(undefined);
    }
    const row = { ...current, ...MemoryRules.stored(changes), version: version + 1, updated_at: NOW };
    this.markup[index] = row as MarkupRuleEditRow;
    return Promise.resolve(row as MarkupRuleEditRow);
  }

  deleteMarkupRule(_trx: TenantTransaction, id: string, version: number): Promise<boolean> {
    const before = this.markup.length;
    this.markup = this.markup.filter((row) => !(row.id === id && row.version === version && !row.is_default));
    return Promise.resolve(this.markup.length < before);
  }

  listFeeRules(_trx: TenantTransaction, query: RuleListQuery): Promise<FeeRuleEditRow[]> {
    return Promise.resolve(MemoryRules.sorted(this.fee, query));
  }

  feeRuleById(_trx: TenantTransaction, id: string, lock: RuleLock = "none") {
    this.locks.push(`fee:${lock}`);
    return Promise.resolve(this.fee.find((row) => row.id === id));
  }

  insertFeeRule(_trx: TenantTransaction, values: FeeRuleValues): Promise<FeeRuleEditRow> {
    const row = {
      ...feeRow(),
      ...MemoryRules.stored(values),
      id: values.id,
      created_at: NOW,
      updated_at: NOW,
    };
    this.fee.push(row as FeeRuleEditRow);
    return Promise.resolve(row as FeeRuleEditRow);
  }

  updateFeeRule(_trx: TenantTransaction, id: string, version: number, changes: FeeRuleChanges) {
    const index = this.fee.findIndex((row) => row.id === id && row.version === version);
    const current = this.fee[index];
    if (current === undefined) {
      return Promise.resolve(undefined);
    }
    const row = { ...current, ...MemoryRules.stored(changes), version: version + 1, updated_at: NOW };
    this.fee[index] = row as FeeRuleEditRow;
    return Promise.resolve(row as FeeRuleEditRow);
  }

  deleteFeeRule(_trx: TenantTransaction, id: string, version: number): Promise<boolean> {
    const before = this.fee.length;
    this.fee = this.fee.filter((row) => !(row.id === id && row.version === version));
    return Promise.resolve(this.fee.length < before);
  }
}

interface Harness {
  readonly service: PricingRulesService;
  readonly rules: MemoryRules;
  readonly records: StaffActionEntry[];
  /** The tables after each transaction that committed. */
  readonly commits: () => number;
}

function harness(
  actor: StaffActionActor | undefined = {
    type: "staff",
    staffId: STAFF_ID,
    accountId: null,
    email: null,
    role: "admin",
  },
): Harness {
  const rules = new MemoryRules();
  const records: StaffActionEntry[] = [];
  let commits = 0;
  const tx = {
    run: async <T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> => {
      // A failure rolls the rows and the audit rows back, as PostgreSQL would.
      const saved = { markup: [...rules.markup], fee: [...rules.fee], records: records.length };
      try {
        const result = await fn(TRX);
        commits += 1;
        return result;
      } catch (error) {
        rules.markup = saved.markup;
        rules.fee = saved.fee;
        records.splice(saved.records);
        throw error;
      }
    },
  } as unknown as TenantTx;
  const writer = {
    requestActor: () => actor,
    record: (trx: TenantTransaction, entry: StaffActionEntry): Promise<void> => {
      expect(trx).toBe(TRX);
      records.push(entry);
      return Promise.resolve();
    },
  } as unknown as StaffActionsWriter;
  const storefront = {
    settings: (trx: TenantTransaction) => {
      expect(trx).toBe(TRX);
      return Promise.resolve({ defaultCurrency: "EUR" });
    },
  } as unknown as StorefrontRepository;
  const ids = { newId: (prefix: "mkr" | "fee") => newId(prefix, NOW) } as unknown as IdGenerator;
  const service = new PricingRulesService(tx, rules as unknown as RulesRepository, storefront, writer, ids);
  return { service, rules, records, commits: () => commits };
}

/** The AppError `promise` rejects with, as `[code, details, field errors as "path code"]`. */
async function refusalOf(promise: Promise<unknown>): Promise<[string, unknown, string[]]> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  return [appError.code, appError.details, (appError.fieldErrors ?? []).map((e) => `${e.path} ${e.code}`)];
}

describe("PricingRulesService", () => {
  let h: Harness;
  let defaultRule: MarkupRuleEditRow;

  beforeEach(() => {
    h = harness();
    defaultRule = markupRow({ name: "Default", percentage: "0.0000", priority: 1000, is_default: true });
    h.rules.markup.push(defaultRule);
  });

  it("creates a markup rule with its defaults, audits it and answers its warnings", async () => {
    const saved = await h.service.createMarkupRule({
      name: "AF October promotion",
      scope: { carriers: ["AF"] },
      calculation: "fixed",
      fixed: { amount: "-10", currency: "USD" },
      appliesPer: "booking",
      priority: 50,
      stackable: true,
    });

    expect(checker.check("consoleCreateMarkupRule", { status: 201, body: saved })).toEqual([]);
    expect(saved).toMatchObject({
      id: expect.stringMatching(/^mkr_/),
      fixed: { amount: "-10.00", currency: "USD" },
      isDefault: false,
      isActive: true,
      version: 1,
      warnings: [
        expect.objectContaining({ code: "fixed_currency_not_default", path: "/fixed/currency" }),
        expect.objectContaining({ code: "sells_below_net", path: "/fixed/amount" }),
      ],
    });
    const stored = h.rules.markup.find((row) => row.id === saved.id);
    expect(stored).toMatchObject({ is_default: false, fixed_currency: "USD", stackable: true });
    expect((stored as unknown as { created_by_staff_id: string }).created_by_staff_id).toBe(STAFF_ID);
    const { warnings: _warnings, ...rule } = saved;
    expect(h.records).toEqual([
      {
        action: "settings.markupRules.create",
        targetType: "markup_rule",
        targetId: saved.id,
        before: null,
        after: rule,
      },
    ]);
  });

  it("refuses a create whose calculation lacks its value with 400 VALIDATION_FAILED and writes nothing", async () => {
    expect(
      await refusalOf(
        h.service.createMarkupRule({ name: "No value", scope: {}, calculation: "percentage_plus_fixed" }),
      ),
    ).toEqual(["VALIDATION_FAILED", undefined, ["/percentage required", "/fixed required"]]);
    expect([h.rules.markup.length, h.records, h.commits()]).toEqual([1, [], 0]);
  });

  it("records a key-only create without a creating staff member", async () => {
    const keyOnly = harness({ type: "api_key", keyId: "key_01JA4CH3G1K4N7R0V3X6A9D2F7" });

    const saved = await keyOnly.service.createFeeRule({
      name: "Service fee",
      label: "Service fee",
      feeType: "booking_service",
      scope: {},
      calculation: "fixed",
      fixed: eur("12"),
    });

    expect(checker.check("consoleCreateFeeRule", { status: 201, body: saved })).toEqual([]);
    expect(saved).toMatchObject({
      fixed: { amount: "12.00", currency: "EUR" },
      appliesPer: "booking",
      warnings: [],
    });
    expect(keyOnly.rules.fee[0]).toMatchObject({ created_by_staff_id: null });
    expect(keyOnly.records).toEqual([
      expect.objectContaining({ action: "settings.feeRules.create", targetType: "fee_rule" }),
    ]);
  });

  it("updates the sent fields at version + 1, null clearing and scope replacing, with the rule before and after", async () => {
    const row = markupRow({
      scope: { carriers: ["AF"], cabins: ["ECONOMY"] },
      min_amount: "15.00",
      fixed_currency: "EUR",
    });
    h.rules.markup.push(row);

    const saved = await h.service.updateMarkupRule(
      row.id,
      { percentage: "4.5", min: null, scope: { cabins: ["BUSINESS"] } },
      ruleEtagOf(1),
    );

    expect(saved).toMatchObject({
      percentage: "4.5000",
      min: null,
      scope: { cabins: ["BUSINESS"] },
      version: 2,
      warnings: [],
    });
    expect(h.rules.locks).toEqual(["markup:update"]);
    expect(h.rules.markup.find((stored) => stored.id === row.id)).toMatchObject({ fixed_currency: null });
    expect(h.records).toEqual([
      expect.objectContaining({
        action: "settings.markupRules.update",
        targetType: "markup_rule",
        targetId: row.id,
        before: expect.objectContaining({ percentage: "4.0000", version: 1, min: eur("15.00") }),
        after: expect.objectContaining({ percentage: "4.5000", version: 2, min: null }),
      }),
    ]);
  });

  it("leaves the stored scope as it is when an update sends none, and replaces it when one is sent", async () => {
    // Stored outside the console: the engine reads `af` as AF and refuses the rule for `routes`; the answer shows
    // neither, and writing the answer's scope back would apply the rule to every carrier.
    const scope = { carriers: ["af"], routes: ["MAD-ORY"] };
    const row = markupRow({ scope });
    const fee = feeRow({ scope: { cardBrands: ["visa"] } });
    h.rules.markup.push(row);
    h.rules.fee.push(fee);

    const saved = await h.service.updateMarkupRule(row.id, { percentage: "6.0000" }, '"1"');
    const savedFee = await h.service.updateFeeRule(fee.id, { refundable: true }, '"1"');

    expect(saved.scope).toEqual({ carriers: [] });
    expect(h.rules.markup.find((stored) => stored.id === row.id)).toMatchObject({
      scope,
      percentage: "6.0000",
      version: 2,
    });
    expect(savedFee.refundable).toBe(true);
    expect(h.rules.fee.find((stored) => stored.id === fee.id)?.scope).toEqual({ cardBrands: ["visa"] });

    await h.service.updateMarkupRule(row.id, { scope: { carriers: ["AF"] } }, '"2"');
    await h.service.updateFeeRule(fee.id, { scope: {} }, '"2"');

    expect(h.rules.markup.find((stored) => stored.id === row.id)?.scope).toEqual({ carriers: ["AF"] });
    expect(h.rules.fee.find((stored) => stored.id === fee.id)?.scope).toEqual({});
  });

  it("writes the default rule's scope as {} on every update, a scope sent or not", async () => {
    h.rules.markup[0] = { ...defaultRule, scope: { carriers: ["AF"] } };

    const saved = await h.service.updateMarkupRule(defaultRule.id, { percentage: "1.0000" }, '"1"');

    expect(saved).toMatchObject({ isDefault: true, scope: {}, percentage: "1.0000" });
    expect(h.rules.markup[0]?.scope).toEqual({});
  });

  it("takes If-Match quoted, weak or bare, and answers a stale one 412 without writing", async () => {
    const row = markupRow();
    h.rules.markup.push(row);

    expect(await refusalOf(h.service.updateMarkupRule(row.id, { name: "Stale" }, '"2"'))).toEqual([
      "PRECONDITION_FAILED",
      undefined,
      [],
    ]);
    expect((await h.service.updateMarkupRule(row.id, { name: "A" }, '"1"')).version).toBe(2);
    expect((await h.service.updateMarkupRule(row.id, { name: "B" }, 'W/"2"')).version).toBe(3);
    expect((await h.service.updateMarkupRule(row.id, { name: "C" }, "3")).version).toBe(4);
    expect(await refusalOf(h.service.deleteMarkupRule(row.id, '"3"'))).toEqual([
      "PRECONDITION_FAILED",
      undefined,
      [],
    ]);
    expect(h.records.map((record) => record.action)).toEqual([
      "settings.markupRules.update",
      "settings.markupRules.update",
      "settings.markupRules.update",
    ]);
  });

  it("checks the changed rule as a whole: a calculation without its value is 400, nothing is written", async () => {
    const row = markupRow();
    h.rules.markup.push(row);

    expect(await refusalOf(h.service.updateMarkupRule(row.id, { calculation: "fixed" }, '"1"'))).toEqual([
      "VALIDATION_FAILED",
      undefined,
      ["/fixed required"],
    ]);
    expect(
      await refusalOf(
        h.service.updateMarkupRule(row.id, { max: { amount: "9", currency: "USD" }, min: eur("1") }, '"1"'),
      ),
    ).toEqual(["VALIDATION_FAILED", undefined, ["/max/currency currency"]]);
    expect([h.rules.markup.find((stored) => stored.id === row.id)?.version, h.records]).toEqual([1, []]);
  });

  it("keeps the default rule's catch-all scope: a narrowing scope is 409 default_rule, other fields may change [OBE-069 AC2]", async () => {
    const etag = ruleEtagOf(defaultRule.version);

    expect(
      await refusalOf(h.service.updateMarkupRule(defaultRule.id, { scope: { carriers: ["AF"] } }, etag)),
    ).toEqual(["CONFLICT", { reason: "default_rule" }, []]);
    const saved = await h.service.updateMarkupRule(
      defaultRule.id,
      { percentage: "2.0000", priority: 2000, scope: { carriers: [], minNet: null } },
      etag,
    );

    expect(saved).toMatchObject({ percentage: "2.0000", priority: 2000, isDefault: true, scope: {} });
    expect(h.rules.markup.find((row) => row.id === defaultRule.id)?.scope).toEqual({});
  });

  it("refuses to delete the default rule with 409 default_rule, and deletes another one with its audit row [OBE-069 AC2]", async () => {
    const row = markupRow();
    h.rules.markup.push(row);

    expect(await refusalOf(h.service.deleteMarkupRule(defaultRule.id, ruleEtagOf(1)))).toEqual([
      "CONFLICT",
      { reason: "default_rule" },
      [],
    ]);
    await h.service.deleteMarkupRule(row.id, ruleEtagOf(1));

    expect(h.rules.markup.map((stored) => stored.id)).toEqual([defaultRule.id]);
    expect(h.rules.locks).toEqual(["markup:delete", "markup:delete"]);
    expect(h.records).toEqual([
      {
        action: "settings.markupRules.delete",
        targetType: "markup_rule",
        targetId: row.id,
        before: consoleMarkupRuleOf(row),
        after: null,
      },
    ]);
  });

  it("answers an unknown rule 404 NOT_FOUND on get, update and delete", async () => {
    const missing = newId("mkr", NOW);
    const missingFee = newId("fee", NOW);

    for (const promise of [
      h.service.getMarkupRule(missing),
      h.service.updateMarkupRule(missing, { name: "x" }, '"1"'),
      h.service.deleteMarkupRule(missing, '"1"'),
      h.service.getFeeRule(missingFee),
      h.service.updateFeeRule(missingFee, { name: "x" }, '"1"'),
      h.service.deleteFeeRule(missingFee, '"1"'),
    ]) {
      expect((await refusalOf(promise))[0]).toBe("NOT_FOUND");
    }
  });

  it("lists in evaluation order with the active filter, one page after another", async () => {
    const at = (priority: number, isActive = true) =>
      markupRow({ id: newId("mkr"), priority, is_active: isActive });
    h.rules.markup.push(at(50), at(100, false), at(100), at(10));

    const first = await h.service.listMarkupRules({ limit: 2 });
    const second = await h.service.listMarkupRules({ limit: 2, cursor: first.page.nextCursor ?? "" });
    const third = await h.service.listMarkupRules({ limit: 2, cursor: second.page.nextCursor ?? "" });
    const active = await h.service.listMarkupRules({ active: true });
    const inactive = await h.service.listMarkupRules({ active: false });

    expect(checker.check("consoleListMarkupRules", { status: 200, body: first })).toEqual([]);
    const pages = [first, second, third].map((page) => page.data.map((rule) => rule.priority));
    expect(pages).toEqual([[10, 50], [100, 100], [1000]]);
    expect(third.page).toEqual({ nextCursor: null, limit: 2 });
    expect(active.data.map((rule) => [rule.priority, rule.isActive])).toEqual([
      [10, true],
      [50, true],
      [100, true],
      [1000, true],
    ]);
    expect(active.page).toEqual({ nextCursor: null, limit: 20 });
    expect(inactive.data.map((rule) => rule.priority)).toEqual([100]);
    expect(
      (await refusalOf(h.service.listMarkupRules({ active: true, cursor: first.page.nextCursor ?? "" })))[0],
    ).toBe("VALIDATION_FAILED");
  });

  it("updates and deletes fee rules, which have no default rule", async () => {
    const row = feeRow();
    h.rules.fee.push(row);

    const saved = await h.service.updateFeeRule(
      row.id,
      { refundable: true, fixed: { amount: "5", currency: "USD" } },
      '"1"',
    );
    await h.service.deleteFeeRule(row.id, '"2"');

    expect(saved).toMatchObject({
      refundable: true,
      fixed: { amount: "5.00", currency: "USD" },
      version: 2,
      warnings: [expect.objectContaining({ code: "fixed_currency_not_default" })],
    });
    expect(h.rules.fee).toEqual([]);
    expect(h.records.map((record) => [record.action, record.targetType])).toEqual([
      ["settings.feeRules.update", "fee_rule"],
      ["settings.feeRules.delete", "fee_rule"],
    ]);
  });
});
