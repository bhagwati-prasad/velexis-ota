// Where a plan's price warnings live, without a database (FIX-W42-PLATFORM, lead decision (4c) of 2026-11-04, second
// set; subscription-billing flow §A, PADR-0002 item 2): `plans.price_warnings` (platform migration 0004) is the one
// place an admin read takes `AdminPlan.priceWarnings` from, and `adminUpdatePlan` and `adminCheckPlanPrices` write the
// warnings of their comparison there while their transaction holds the plan's row lock, before the audit row that
// records the comparison; a Stripe failure writes nothing. PlansService runs over stand-ins of its repository, its
// price check and AuditService that record what they are asked to lock and write, in order. The AuditService stand-in
// has `record` only: the service no longer reads anything back from the audit log, so any other call would fail.
// test/integration/admin/admin-billing.int.test.ts runs the same rules through HTTP and PostgreSQL, the audit rows
// purged as velexis_migrator.
import { AppError, isAppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { describe, expect, it } from "vitest";
import type { AuditEntry, AuditService } from "../audit/audit.service";
import type { Clock } from "../common/clock";
import type { PlatformDb } from "../common/database";
import type { FeatureSwitches } from "../common/features";
import type { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import { planVersion, type AdminPlanRow, type PlanChanges, type PlansRepository } from "./plans.repository";
import { PlansService, storedWarningsOf, toAdminPlan } from "./plans.service";
import type { PlanPriceTerms, PlanPriceWarning, PriceCheck } from "./price-check";

const NOW = new Date("2027-03-02T10:15:00Z");
const CREATED = new Date("2027-02-01T09:00:00.000Z");
const UPDATED = new Date("2027-02-20T12:30:00.000Z");
const ADMIN = { sub: "acc_01JB3K4M8P2R6T0W4Y8A2C6E01" };
const CODE = "growth";
const MONTH = "price_TestFixW42Month";
const YEAR = "price_TestFixW42Year";

const CURRENCY_WARNING: PlanPriceWarning = Object.freeze({
  field: "stripePriceIdMonth.currency",
  expected: "EUR",
  actual: "USD",
});
const ARCHIVED_WARNING: PlanPriceWarning = Object.freeze({
  field: "stripePriceIdYear.active",
  expected: "true",
  actual: "false",
});
const AMOUNT_WARNING: PlanPriceWarning = Object.freeze({
  field: "stripePriceIdMonth.amount",
  expected: "159.00",
  actual: "149.00",
});

/** A plan of 149.00 EUR a month and 1490.00 a year as the admin reads select it, with `overrides` laid over it. */
function planRow(overrides: Partial<AdminPlanRow> = {}): AdminPlanRow {
  return {
    code: CODE,
    name: "Growth",
    description: null,
    currency: "EUR",
    monthly_price: "149.00",
    annual_price: "1490.00",
    trial_days: 14,
    limits: { staffSeats: 15, apiKeys: 25, customDomains: 1, liveMode: true },
    features: {},
    stripe_price_id_month: null,
    stripe_price_id_year: null,
    is_public: true,
    is_active: true,
    sort_order: 20,
    settlement_fee_bps: 150,
    stripe_product_id: null,
    price_warnings: [],
    created_at: CREATED,
    updated_at: UPDATED,
    tenant_count: 3,
    ...overrides,
  };
}

/** What the stand-ins hold and what PlansService asked them to do. */
interface World {
  readonly plans: Map<string, AdminPlanRow>;
  /** The answers of the price check, in order: warnings, or an error it throws (Stripe failing). */
  readonly comparisons: Array<PlanPriceWarning[] | Error>;
  /** Runs after each comparison, before the service goes on (another admin's change during the Stripe calls). */
  afterCompare: (() => void) | undefined;
  readonly compared: PlanPriceTerms[];
  /** The JSON text `storePriceWarnings` got, by plan. */
  readonly stored: Array<{ readonly code: string; readonly json: string }>;
  readonly audited: AuditEntry[];
  /** The transactions, locks and writes, in the order they were asked for. */
  readonly steps: string[];
}

interface Harness {
  readonly service: PlansService;
  readonly world: World;
}

function plan(world: World, code: string): AdminPlanRow {
  const row = world.plans.get(code);
  if (row === undefined) {
    throw new Error(`no plan ${code}`);
  }
  return row;
}

function harness(
  rows: readonly AdminPlanRow[],
  comparisons: Array<PlanPriceWarning[] | Error> = [],
): Harness {
  const world: World = {
    plans: new Map(rows.map((row) => [row.code, row])),
    comparisons: [...comparisons],
    afterCompare: undefined,
    compared: [],
    stored: [],
    audited: [],
    steps: [],
  };
  const copy = (code: string): AdminPlanRow | undefined => {
    const row = world.plans.get(code);
    return row === undefined ? undefined : { ...row };
  };
  const plans = {
    listWithTenantCounts: () => Promise.resolve([...world.plans.values()].map((row) => ({ ...row }))),
    findRecord: (code: string) => Promise.resolve(copy(code)),
    findWithTenantCount: (code: string) => Promise.resolve(copy(code)),
    lockForUpdate: (_trx: unknown, code: string) => {
      world.steps.push(`lock ${code}`);
      return Promise.resolve(copy(code));
    },
    lockStripeLinks: () => {
      world.steps.push("lock links");
      return Promise.resolve();
    },
    otherPlansLinking: () => Promise.resolve([]),
    // The repository's rule: every change moves `updated_at` (the version) forward by at least one millisecond.
    update: (_trx: unknown, code: string, changes: PlanChanges, now: Date) => {
      world.steps.push(`update ${code}`);
      const { limitsJson, featuresJson, ...columns } = changes;
      const row = plan(world, code);
      world.plans.set(code, {
        ...row,
        ...columns,
        ...(limitsJson === undefined ? {} : { limits: JSON.parse(limitsJson) as AdminPlanRow["limits"] }),
        ...(featuresJson === undefined
          ? {}
          : { features: JSON.parse(featuresJson) as AdminPlanRow["features"] }),
        updated_at: new Date(Math.max(now.getTime(), row.updated_at.getTime() + 1)),
      });
      return Promise.resolve();
    },
    // The column only: the version stays.
    storePriceWarnings: (_trx: unknown, code: string, json: string) => {
      world.steps.push(`store warnings ${code}`);
      world.stored.push({ code, json });
      world.plans.set(code, {
        ...plan(world, code),
        price_warnings: JSON.parse(json) as AdminPlanRow["price_warnings"],
      });
      return Promise.resolve();
    },
  } as unknown as PlansRepository;
  const priceCheck = {
    compare: (terms: PlanPriceTerms) => {
      world.steps.push("compare");
      world.compared.push(terms);
      const answer = world.comparisons.shift();
      world.afterCompare?.();
      if (answer === undefined) {
        throw new Error("no comparison answer left");
      }
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  } as unknown as PriceCheck;
  // `record` only: nothing may be read back from the audit log (file header).
  const audit = {
    record: (_trx: unknown, entry: AuditEntry) => {
      world.steps.push(`audit ${entry.action}`);
      world.audited.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  const invalidations = { publishAfterCommit: () => undefined } as unknown as InvalidationPublisher;
  const switches = { isEnabled: () => true } as unknown as FeatureSwitches;
  // runInTransaction only needs `transaction().execute(fn)`; the stand-ins ignore the transaction object.
  const db = {
    transaction: () => ({
      execute: async <T>(fn: (trx: object) => Promise<T>) => {
        world.steps.push("begin");
        const result = await fn({});
        world.steps.push("commit");
        return result;
      },
    }),
  } as unknown as PlatformDb;
  const service = new PlansService(
    plans,
    audit,
    invalidations,
    switches,
    new FakeClock(NOW) as unknown as Clock,
    priceCheck,
    db,
  );
  return { service, world };
}

/** What `fn` throws; fails the test when it resolves. */
async function failureOf(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

const stripeDown = (): AppError => new AppError("PROVIDER_ERROR", { details: { provider: "stripe" } });

describe("the stored price warnings of a plan", () => {
  it("[FIX-W42-PLATFORM AC2] are what an admin plan answers as priceWarnings: the plans column, never anything else", () => {
    const row = planRow({ price_warnings: [CURRENCY_WARNING, ARCHIVED_WARNING] });
    expect(toAdminPlan(row, true)).toMatchObject({
      code: CODE,
      priceWarnings: [CURRENCY_WARNING, ARCHIVED_WARNING],
      version: planVersion(UPDATED),
    });
    expect(toAdminPlan(planRow(), true).priceWarnings).toEqual([]);
  });

  it("[FIX-W42-PLATFORM AC2] keep only the {field, expected, actual} items of a JSON array", () => {
    expect(
      storedWarningsOf([CURRENCY_WARNING, { field: "x" }, "y", { ...ARCHIVED_WARNING, extra: 1 }]),
    ).toEqual([CURRENCY_WARNING, ARCHIVED_WARNING]);
    expect(storedWarningsOf([{ field: "stripePriceIdMonth.amount", expected: null, actual: null }])).toEqual([
      { field: "stripePriceIdMonth.amount", expected: null, actual: null },
    ]);
    for (const notAnArray of [null, {}, "[]", 1]) {
      expect(storedWarningsOf(notAnArray)).toEqual([]);
    }
  });
});

describe("adminListPlans", () => {
  it("[FIX-W42-PLATFORM AC2] answers each plan's warnings from its row and reads nothing from the audit log", async () => {
    const { service, world } = harness([
      planRow({ price_warnings: [CURRENCY_WARNING] }),
      planRow({ code: "starter", price_warnings: [] }),
    ]);

    const list = await service.list();

    expect(list.data.map((item) => [item.code, item.priceWarnings])).toEqual([
      [CODE, [CURRENCY_WARNING]],
      ["starter", []],
    ]);
    expect(world.steps).toEqual([]);
  });
});

describe("adminUpdatePlan", () => {
  it("[FIX-W42-PLATFORM AC2] stores the comparison's warnings in the plan's row under its lock, before the audit row that records them", async () => {
    const { service, world } = harness([planRow()], [[CURRENCY_WARNING]]);

    const answer = await service.update(ADMIN, CODE, planVersion(UPDATED), { stripePriceIdMonth: MONTH });

    expect(world.steps).toEqual([
      "compare",
      "begin",
      `lock ${CODE}`,
      "lock links",
      `update ${CODE}`,
      `store warnings ${CODE}`,
      "audit plan.updated",
      "commit",
    ]);
    expect(world.stored).toEqual([{ code: CODE, json: JSON.stringify([CURRENCY_WARNING]) }]);
    expect(plan(world, CODE).price_warnings).toEqual([CURRENCY_WARNING]);
    expect(answer).toMatchObject({ stripePriceIdMonth: MONTH, priceWarnings: [CURRENCY_WARNING] });
    expect(answer.version).toBeGreaterThan(planVersion(UPDATED));
    // The audit row keeps recording the comparison (nothing reads it back).
    expect(world.audited).toEqual([
      expect.objectContaining({
        action: "plan.updated",
        targetId: CODE,
        before: { stripePriceIdMonth: null, priceWarnings: [] },
        after: { stripePriceIdMonth: MONTH, priceWarnings: [CURRENCY_WARNING] },
        details: { changed: ["stripePriceIdMonth", "priceWarnings"], priceWarnings: [CURRENCY_WARNING] },
      }),
    ]);
  });

  it("[FIX-W42-PLATFORM AC2] leaves the stored warnings as they are when the comparison finds them again", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [CURRENCY_WARNING] });
    const { service, world } = harness([linked], [[CURRENCY_WARNING]]);

    const answer = await service.update(ADMIN, CODE, planVersion(UPDATED), {
      monthlyPrice: { amount: "159.00", currency: "EUR" },
    });

    expect(world.steps).not.toContain(`store warnings ${CODE}`);
    expect(answer.priceWarnings).toEqual([CURRENCY_WARNING]);
    expect(world.audited[0]).toMatchObject({
      before: { monthlyPrice: "149.00" },
      after: { monthlyPrice: "159.00" },
      details: { changed: ["monthlyPrice"], priceWarnings: [CURRENCY_WARNING] },
    });
  });

  it("[FIX-W42-PLATFORM AC2] weighs its comparison against the warnings of the locked row, not of the read before Stripe", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [CURRENCY_WARNING] });
    const { service, world } = harness([linked], [[CURRENCY_WARNING]]);
    // A check of the plan as it was commits its own warnings while this update waits for Stripe (version unchanged).
    world.afterCompare = () => {
      world.plans.set(CODE, { ...plan(world, CODE), price_warnings: [AMOUNT_WARNING] });
    };

    const answer = await service.update(ADMIN, CODE, planVersion(UPDATED), {
      monthlyPrice: { amount: "159.00", currency: "EUR" },
    });

    // The update commits last, so its comparison's warnings become the plan's again, although the read held them.
    expect(world.stored).toEqual([{ code: CODE, json: JSON.stringify([CURRENCY_WARNING]) }]);
    expect(plan(world, CODE).price_warnings).toEqual([CURRENCY_WARNING]);
    expect(answer.priceWarnings).toEqual([CURRENCY_WARNING]);
    expect(world.audited[0]).toMatchObject({
      before: { monthlyPrice: "149.00", priceWarnings: [AMOUNT_WARNING] },
      after: { monthlyPrice: "159.00", priceWarnings: [CURRENCY_WARNING] },
    });
  });

  it("[FIX-W42-PLATFORM AC2] keeps the stored warnings for a change that compares nothing, and answers them", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [AMOUNT_WARNING] });
    const { service, world } = harness([linked]);

    const answer = await service.update(ADMIN, CODE, planVersion(UPDATED), { name: "Growth 2027" });

    expect(world.compared).toEqual([]);
    expect(world.stored).toEqual([]);
    expect(answer).toMatchObject({ name: "Growth 2027", priceWarnings: [AMOUNT_WARNING] });
    expect(world.audited[0]?.details).toEqual({ changed: ["name"] });
  });

  it("[FIX-W42-PLATFORM AC2] stores nothing when Stripe fails: no transaction, the plan keeps its warnings", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [AMOUNT_WARNING] });
    const { service, world } = harness([linked], [stripeDown()]);

    const error = await failureOf(() =>
      service.update(ADMIN, CODE, planVersion(UPDATED), { stripePriceIdYear: YEAR }),
    );

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(world.steps).toEqual(["compare"]);
    expect(world.stored).toEqual([]);
    expect(plan(world, CODE)).toEqual(linked);
  });
});

describe("adminCheckPlanPrices", () => {
  it("[FIX-W42-PLATFORM AC2] stores the warnings under the plan's row lock and records the check, leaving the version", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [CURRENCY_WARNING] });
    const { service, world } = harness([linked], [[]]);

    const answer = await service.checkPrices(ADMIN, CODE);

    expect(answer).toEqual({ warnings: [] });
    expect(world.steps).toEqual([
      "compare",
      "begin",
      `lock ${CODE}`,
      `store warnings ${CODE}`,
      "audit plan.prices_checked",
      "commit",
    ]);
    expect(world.stored).toEqual([{ code: CODE, json: "[]" }]);
    expect(plan(world, CODE)).toEqual({ ...linked, price_warnings: [] });
    expect(world.audited).toEqual([
      expect.objectContaining({
        action: "plan.prices_checked",
        before: { priceWarnings: [CURRENCY_WARNING] },
        after: { priceWarnings: [] },
        details: { priceIds: [MONTH], priceWarnings: [] },
      }),
    ]);
  });

  it("[FIX-W42-PLATFORM AC2] records a check that finds the stored warnings again without writing them", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [CURRENCY_WARNING] });
    const { service, world } = harness([linked], [[CURRENCY_WARNING]]);

    expect(await service.checkPrices(ADMIN, CODE)).toEqual({ warnings: [CURRENCY_WARNING] });

    expect(world.stored).toEqual([]);
    expect(world.steps).toEqual(["compare", "begin", `lock ${CODE}`, "audit plan.prices_checked", "commit"]);
  });

  it("[FIX-W42-PLATFORM AC2] weighs the check against the warnings of the locked row, so the check that commits last wins", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [CURRENCY_WARNING] });
    const { service, world } = harness([linked], [[CURRENCY_WARNING]]);
    // Another check of the same terms commits other warnings while this one waits for Stripe.
    world.afterCompare = () => {
      world.plans.set(CODE, { ...plan(world, CODE), price_warnings: [AMOUNT_WARNING] });
    };

    expect(await service.checkPrices(ADMIN, CODE)).toEqual({ warnings: [CURRENCY_WARNING] });

    expect(world.stored).toEqual([{ code: CODE, json: JSON.stringify([CURRENCY_WARNING]) }]);
    expect(plan(world, CODE).price_warnings).toEqual([CURRENCY_WARNING]);
    expect(world.audited).toEqual([
      expect.objectContaining({
        before: { priceWarnings: [AMOUNT_WARNING] },
        after: { priceWarnings: [CURRENCY_WARNING] },
      }),
    ]);
  });

  it("[FIX-W42-PLATFORM AC2] stores nothing when Stripe fails, and calls nothing for a plan without a linked price", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [CURRENCY_WARNING] });
    const failing = harness([linked], [stripeDown()]);
    expect((await failureOf(() => failing.service.checkPrices(ADMIN, CODE))).code).toBe("PROVIDER_ERROR");
    expect(failing.world.steps).toEqual(["compare"]);
    expect(plan(failing.world, CODE)).toEqual(linked);

    const unlinked = harness([planRow()]);
    expect(await unlinked.service.checkPrices(ADMIN, CODE)).toEqual({ warnings: [] });
    expect(unlinked.world.steps).toEqual([]);
  });

  it("[FIX-W42-PLATFORM AC2] never stores the warnings of a comparison whose plan changed during the Stripe calls", async () => {
    const linked = planRow({ stripe_price_id_month: MONTH, price_warnings: [] });
    const { service, world } = harness([linked], [[CURRENCY_WARNING], [AMOUNT_WARNING]]);
    // Another admin changes the monthly price while the first comparison waits for Stripe.
    world.afterCompare = () => {
      world.afterCompare = undefined;
      world.plans.set(CODE, { ...plan(world, CODE), monthly_price: "159.00" });
    };

    expect(await service.checkPrices(ADMIN, CODE)).toEqual({ warnings: [AMOUNT_WARNING] });

    expect(world.compared.map((terms) => terms.monthlyPrice)).toEqual(["149.00", "159.00"]);
    expect(world.stored).toEqual([{ code: CODE, json: JSON.stringify([AMOUNT_WARNING]) }]);
    expect(world.audited).toHaveLength(1);
    expect(plan(world, CODE).price_warnings).toEqual([AMOUNT_WARNING]);
  });
});
