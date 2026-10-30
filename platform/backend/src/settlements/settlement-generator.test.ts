// The monthly settlement drafts (PBE-059; flows/stripe-payments-account.md §F, PADR-0003 items 2–7, scope PF-63 AC1):
// the periods, the one pass over the month's Stripe balance transactions (FakeStripe of test/support/fake-stripe.ts,
// nothing reaches Stripe), the tenant of each transaction from the metadata of its charge or PaymentIntent, the lines
// and statements per tenant and balance currency, and the carry-forward line. The database steps are proven by
// test/integration/settlements/settlement-generation.int.test.ts.
import Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeStripe, type FakeStripeObject } from "../../test/support/fake-stripe";
import { SettlementDataError, settlementTotals } from "./settlement-formula";
import {
  BALANCE_TRANSACTION_PAGE_SIZE,
  carryForwardLine,
  collectTransactions,
  groupStatements,
  isClosedPeriod,
  periodLabel,
  previousMonthStart,
  settlementEnvironment,
  settlementPeriod,
  transactionLine,
  type MinorUnitsOf,
  type StatementPlan,
  type TenantTransaction,
} from "./settlement-generator";

// ---- Stripe objects as the generator reads them ------------------------------------------------------------------

/** A tenant id of this file (`ten_` and a ULID's 26 characters). */
const tenantId = (letter: string) => `ten_01JSTMT${letter}`.padEnd(30, "0");
const TENANT_A = tenantId("A");
const TENANT_B = tenantId("B");

const PERIOD = settlementPeriod(new Date("2026-10-01T00:00:00.000Z"));
/** Unix seconds on a day of October 2026. */
const onDay = (day: number, hour = 12) => Date.UTC(2026, 9, day, hour) / 1000;

type Json = Record<string, unknown>;

function stripeObject(fields: Json & FakeStripeObject): FakeStripeObject {
  return fields;
}

function charge(
  id: string,
  amount: number,
  options: { currency?: string; metadata?: Json; intent?: string | null } = {},
): FakeStripeObject {
  return stripeObject({
    id,
    object: "charge",
    amount,
    amount_captured: amount,
    currency: options.currency ?? "eur",
    metadata: options.metadata ?? {},
    payment_intent: options.intent ?? null,
  });
}

function intent(id: string, metadata: Json): FakeStripeObject {
  return stripeObject({ id, object: "payment_intent", metadata });
}

function refund(id: string, chargeId: string, amount: number, currency = "eur"): FakeStripeObject {
  return stripeObject({
    id,
    object: "refund",
    charge: chargeId,
    amount,
    currency,
    payment_intent: null,
    metadata: {},
  });
}

function dispute(id: string, chargeId: string, amount: number, currency = "eur"): FakeStripeObject {
  return stripeObject({ id, object: "dispute", charge: chargeId, amount, currency, payment_intent: null });
}

function payout(id: string): FakeStripeObject {
  return stripeObject({ id, object: "payout", amount: 100_000, currency: "eur" });
}

/** A balance transaction: `amount` and `fee` in minor units of the balance currency, `source` an id the fake expands. */
function txn(
  id: string,
  category: string,
  amount: number,
  fee: number,
  source: string,
  created: number,
  currency = "eur",
): FakeStripeObject {
  return stripeObject({
    id,
    object: "balance_transaction",
    amount,
    fee,
    net: amount - fee,
    currency,
    created,
    reporting_category: category,
    source,
    status: "available",
  });
}

/** The metadata the OTA backend writes on its PaymentIntents (and Stripe copies to the charge). */
const velexis = (tenant: string, paymentId: string, checkoutId: string) => ({
  velexis_tenant_id: tenant,
  velexis_environment: "live",
  payment_id: paymentId,
  checkout_id: checkoutId,
});

/** The exponents of `reference.currencies` this file needs. */
const EXPONENTS: Readonly<Record<string, number>> = { EUR: 2, USD: 2, GBP: 2, JPY: 0, KWD: 3 };
const minorUnitsOf: MinorUnitsOf = (currency) => {
  const exponent = EXPONENTS[currency];
  if (exponent === undefined) {
    throw new SettlementDataError(`currency ${currency} is not in reference.currencies`);
  }
  return exponent;
};

let stripe: FakeStripe;

beforeEach(() => {
  stripe = new FakeStripe();
});

// ---- Periods -----------------------------------------------------------------------------------------------------

describe("settlement periods (PADR-0003 item 2)", () => {
  it("[PBE-059] are calendar months in UTC, [start, end)", () => {
    expect(settlementPeriod(new Date("2026-10-01T00:00:00Z"))).toEqual({
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
    });
    expect(settlementPeriod(new Date("2026-12-01T00:00:00Z")).end).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(settlementPeriod(new Date("2028-02-01T00:00:00Z")).end).toEqual(new Date("2028-03-01T00:00:00Z"));
    expect(periodLabel(PERIOD.start)).toBe("2026-10");
    // The years 0–99 are years, not 1900–1999.
    expect(settlementPeriod(new Date("0050-03-01T00:00:00Z")).end.toISOString()).toBe(
      "0050-04-01T00:00:00.000Z",
    );
  });

  it("refuse a start that is not the first instant of a month in UTC", () => {
    for (const value of [
      "2026-10-02T00:00:00Z",
      "2026-10-01T00:00:01Z",
      "2026-10-01T00:00:00+02:00",
      "not a date",
    ]) {
      expect(() => settlementPeriod(new Date(value)), value).toThrow(RangeError);
    }
  });

  it("[PBE-059] settlements.monthly settles the previous month of its run, across a year end", () => {
    expect(previousMonthStart(new Date("2026-11-03T05:00:00Z"))).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(previousMonthStart(new Date("2027-01-03T05:00:00Z"))).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect(previousMonthStart(new Date("2027-03-31T23:59:59Z"))).toEqual(new Date("2027-02-01T00:00:00Z"));
  });

  it("[PBE-059] is closed once its end has passed", () => {
    expect(isClosedPeriod(PERIOD, new Date("2026-11-01T00:00:00.000Z"))).toBe(true);
    expect(isClosedPeriod(PERIOD, new Date("2026-10-31T23:59:59.999Z"))).toBe(false);
    expect(isClosedPeriod(PERIOD, new Date("2026-10-15T00:00:00Z"))).toBe(false);
  });

  it("[PBE-059] belong to the live environment in production only (PADR-0003 item 1)", () => {
    expect(settlementEnvironment("production")).toBe("live");
    expect(settlementEnvironment("development")).toBe("test");
    expect(settlementEnvironment("test")).toBe("test");
  });
});

// ---- A month ----------------------------------------------------------------------------------------------------

/**
 * The month of PF-63 AC1. Tenant A, EUR: two charges (the second with the metadata on its PaymentIntent only), a
 * refund of the first, a lost dispute of the second, a won dispute of a charge of September; USD: a USD charge and a
 * GBP charge settled in USD. Tenant B: one EUR charge. Velexis's own subscription charge (no tenant), a payout and a
 * Stripe fee (not settled), and one transaction outside the month.
 */
function putMonth(): void {
  stripe.put(
    charge("ch_A1", 100_000, { metadata: velexis(TENANT_A, "pay_A1", "chk_A1"), intent: "pi_A1" }),
    charge("ch_A2", 50_000, { intent: "pi_A2" }),
    intent("pi_A2", velexis(TENANT_A, "pay_A2", "chk_A2")),
    charge("ch_A3", 30_000, { metadata: velexis(TENANT_A, "pay_A3", "chk_A3"), intent: "pi_A3" }),
    refund("re_A1", "ch_A1", 20_000),
    dispute("du_A2", "ch_A2", 50_000),
    dispute("du_A3", "ch_A3", 30_000),
    charge("ch_A4", 25_000, { currency: "usd", metadata: velexis(TENANT_A, "pay_A4", "chk_A4") }),
    charge("ch_A5", 10_000, { currency: "gbp", metadata: velexis(TENANT_A, "pay_A5", "chk_A5") }),
    charge("ch_B1", 40_000, { metadata: velexis(TENANT_B, "pay_B1", "chk_B1") }),
    charge("ch_sub", 4_900, { metadata: { velexis_subscription_id: "sub_1" } }),
    payout("po_1"),
    // Put in the order Stripe would make them; the fake lists them newest first.
    txn("txn_A1", "charge", 100_000, 1_475, "ch_A1", onDay(2)),
    txn("txn_A2", "charge", 50_000, 775, "ch_A2", onDay(3)),
    txn("txn_sub", "charge", 4_900, 170, "ch_sub", onDay(4)),
    txn("txn_A4", "charge", 25_000, 755, "ch_A4", onDay(5), "usd"),
    // 100.00 GBP settled as 126.40 USD.
    txn("txn_A5", "charge", 12_640, 410, "ch_A5", onDay(6), "usd"),
    txn("txn_B1", "charge", 40_000, 595, "ch_B1", onDay(7)),
    txn("txn_reA1", "refund", -20_000, 0, "re_A1", onDay(8)),
    txn("txn_duA2", "dispute", -50_000, 1_500, "du_A2", onDay(9)),
    txn("txn_duA3", "dispute", -30_000, 1_500, "du_A3", onDay(10)),
    txn("txn_po1", "payout", -100_000, 0, "po_1", onDay(11)),
    txn("txn_fee", "fee", -500, 0, "po_1", onDay(12)),
    txn("txn_drA3", "dispute_reversal", 30_000, 0, "du_A3", onDay(20)),
    // Outside the month: the first instant of November, and the last second of September.
    txn("txn_late", "charge", 9_900, 100, "ch_A1", Date.UTC(2026, 10, 1) / 1000),
    txn("txn_early", "charge", 9_900, 100, "ch_A1", Date.UTC(2026, 9, 1) / 1000 - 1),
  );
}

function planOf(plans: readonly StatementPlan[], tenant: string, currency: string): StatementPlan {
  const plan = plans.find((each) => each.tenantId === tenant && each.currency === currency);
  if (plan === undefined) {
    throw new Error(`no statement for ${tenant} ${currency}`);
  }
  return plan;
}

describe("collectTransactions and groupStatements (flow §F items 2 and 3)", () => {
  it("[PBE-059 AC1] give the expected totals for charges, a refund, a lost and a won dispute, two currencies and a carried-forward negative balance", async () => {
    putMonth();

    const collected = await collectTransactions(stripe.api(), PERIOD);
    const plans = groupStatements(collected.transactions, [], minorUnitsOf);
    const carried = carryForwardLine(
      [{ id: "stl_sep", period_start: new Date("2026-09-01T00:00:00Z"), net_amount: "-45.50" }],
      PERIOD,
    );
    if (carried === undefined) {
      throw new Error("a carried-forward balance gives a line");
    }
    const eur = planOf(plans, TENANT_A, "EUR");
    const usd = planOf(plans, TENANT_A, "USD");

    expect(collected).toMatchObject({ listed: 12, ignored: 2, withoutTenant: 1 });
    expect(plans.map((plan) => [plan.tenantId, plan.currency, plan.lines.length])).toEqual([
      [TENANT_A, "EUR", 6],
      [TENANT_A, "USD", 2],
      [TENANT_B, "EUR", 1],
    ]);
    expect(settlementTotals([...eur.lines, carried], { feeBps: 150, decimals: 2 })).toEqual({
      gross_amount: "1500.00",
      refunds_amount: "200.00",
      disputes_amount: "530.00",
      stripe_fees_amount: "22.50",
      velexis_fees_amount: "19.50",
      adjustments_amount: "-45.50",
      net_amount: "682.50",
      line_count: 7,
    });
    expect(settlementTotals(usd.lines, { feeBps: 150, decimals: 2 })).toEqual({
      gross_amount: "376.40",
      refunds_amount: "0.00",
      disputes_amount: "0.00",
      stripe_fees_amount: "11.65",
      velexis_fees_amount: "5.65",
      adjustments_amount: "0.00",
      net_amount: "359.10",
      line_count: 2,
    });
    expect(settlementTotals(planOf(plans, TENANT_B, "EUR").lines, { feeBps: 0, decimals: 2 })).toMatchObject({
      gross_amount: "400.00",
      stripe_fees_amount: "5.95",
      net_amount: "394.05",
    });
  });

  it("[PBE-059 AC1] writes one line per balance transaction, oldest first, with its source, PaymentIntent and Velexis ids", async () => {
    putMonth();

    const plans = groupStatements(
      (await collectTransactions(stripe.api(), PERIOD)).transactions,
      [],
      minorUnitsOf,
    );
    const eur = planOf(plans, TENANT_A, "EUR");

    expect(
      eur.lines.map((line) => [
        line.line_type,
        line.balance_transaction_id,
        line.source_id,
        line.amount,
        line.stripe_fee,
      ]),
    ).toEqual([
      ["charge", "txn_A1", "ch_A1", "1000.00", "14.75"],
      ["charge", "txn_A2", "ch_A2", "500.00", "7.75"],
      ["refund", "txn_reA1", "re_A1", "-200.00", "0.00"],
      ["dispute", "txn_duA2", "du_A2", "-500.00", "15.00"],
      ["dispute", "txn_duA3", "du_A3", "-300.00", "15.00"],
      ["dispute_reversal", "txn_drA3", "du_A3", "300.00", "0.00"],
    ]);
    // The ids of the metadata that named the tenant: the charge's, or the PaymentIntent's when the charge has none.
    expect(
      eur.lines.map((line) => [line.payment_intent_id, line.velexis_payment_id, line.checkout_id]),
    ).toEqual([
      ["pi_A1", "pay_A1", "chk_A1"],
      ["pi_A2", "pay_A2", "chk_A2"],
      ["pi_A1", "pay_A1", "chk_A1"],
      ["pi_A2", "pay_A2", "chk_A2"],
      ["pi_A3", "pay_A3", "chk_A3"],
      ["pi_A3", "pay_A3", "chk_A3"],
    ]);
    expect(eur.lines[0]).toMatchObject({
      occurred_at: new Date(onDay(2) * 1000),
      original_amount: null,
      original_currency: null,
      description: "Card payment captured",
    });
    // The GBP charge settled in USD keeps its own amount for reference.
    expect(planOf(plans, TENANT_A, "USD").lines[1]).toMatchObject({
      amount: "126.40",
      stripe_fee: "4.10",
      original_amount: "100.00",
      original_currency: "GBP",
    });
  });

  it("[PBE-059] lists the month once with the source expanded, and retrieves each charge and PaymentIntent at most once", async () => {
    putMonth();

    await collectTransactions(stripe.api(), PERIOD);

    expect(stripe.callsOf("balanceTransactions.list").map((call) => call.params)).toEqual([
      {
        created: { gte: Date.UTC(2026, 9, 1) / 1000, lt: Date.UTC(2026, 10, 1) / 1000 },
        limit: BALANCE_TRANSACTION_PAGE_SIZE,
        expand: ["data.source"],
      },
    ]);
    // The refund's and the disputes' charges (the dispute and its reversal share one), once each.
    expect(
      stripe
        .callsOf("charges.retrieve")
        .map((call) => call.id)
        .sort(),
    ).toEqual(["ch_A1", "ch_A2", "ch_A3"]);
    // ch_A2 has no metadata: its PaymentIntent is read once for the charge and its dispute; ch_sub has none to read.
    expect(stripe.callsOf("paymentIntents.retrieve").map((call) => call.id)).toEqual(["pi_A2"]);
    // A GET carries no idempotency key; nothing is created.
    expect(stripe.calls.every((call) => call.idempotencyKey === undefined)).toBe(true);
  });

  it("[PBE-059] pages through a long month with starting_after", async () => {
    stripe.put(charge("ch_many", 1_000, { metadata: velexis(TENANT_A, "pay_many", "chk_many") }));
    const count = 2 * BALANCE_TRANSACTION_PAGE_SIZE + 5;
    for (let n = 0; n < count; n += 1) {
      stripe.put(txn(`txn_page${n}`, "charge", 1_000, 10, "ch_many", onDay(1) + n));
    }

    const collected = await collectTransactions(stripe.api(), PERIOD);
    const calls = stripe.callsOf("balanceTransactions.list");

    expect(collected.transactions).toHaveLength(count);
    expect(new Set(collected.transactions.map((each) => each.id)).size).toBe(count);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => (call.params as Record<string, unknown>)["starting_after"])).toEqual([
      undefined,
      `txn_page${count - BALANCE_TRANSACTION_PAGE_SIZE}`,
      `txn_page${count - 2 * BALANCE_TRANSACTION_PAGE_SIZE}`,
    ]);
  });

  it("[PBE-059] skips what names no tenant: no metadata, a malformed tenant id, an unknown source", async () => {
    stripe.put(
      charge("ch_none", 1_000, { intent: "pi_none" }),
      intent("pi_none", {}),
      charge("ch_bad", 1_000, { metadata: { velexis_tenant_id: "ten_42" } }),
      charge("ch_intentless", 1_000),
      txn("txn_none", "charge", 1_000, 10, "ch_none", onDay(2)),
      txn("txn_bad", "charge", 1_000, 10, "ch_bad", onDay(3)),
      txn("txn_intentless", "charge", 1_000, 10, "ch_intentless", onDay(4)),
      // A source the account does not hold any more: the expansion leaves its id.
      txn("txn_gone", "refund", -1_000, 0, "re_gone", onDay(5)),
    );

    expect(await collectTransactions(stripe.api(), PERIOD)).toEqual({
      listed: 4,
      ignored: 0,
      unknownCategories: [],
      withoutTenant: 4,
      transactions: [],
    });
  });

  it("[FIX-W36-PLATFORM AC2] settles a failed refund as a positive refund line, skips Velexis's own money silently and names any other category by its type and id only", async () => {
    stripe.put(
      charge("ch_A1", 100_000, { metadata: velexis(TENANT_A, "pay_A1", "chk_A1"), intent: "pi_A1" }),
      refund("re_A1", "ch_A1", 20_000),
      payout("po_1"),
      txn("txn_A1", "charge", 100_000, 1_475, "ch_A1", onDay(2)),
      txn("txn_reA1", "refund", -20_000, 0, "re_A1", onDay(3)),
      // The refund failed and Stripe put the money back on the balance.
      txn("txn_rfA1", "refund_failure", 20_000, 0, "re_A1", onDay(4)),
      // Velexis's own money: a payout, Stripe's fee and the tax on it.
      txn("txn_po1", "payout", -100_000, 0, "po_1", onDay(5)),
      txn("txn_fee", "fee", -500, 0, "po_1", onDay(5, 13)),
      txn("txn_tax", "tax", -100, 0, "po_1", onDay(5, 14)),
      // Categories this generator does not know, one of them on the tenant's own charge: skipped, never guessed.
      stripeObject({
        ...txn("txn_pcr", "partial_capture_reversal", -5_000, 0, "ch_A1", onDay(6)),
        type: "adjustment",
      }),
      stripeObject({ ...txn("txn_odd", "other_adjustment", 777, 0, "ch_A1", onDay(7)), type: "adjustment" }),
      // A prototype key of a plain object is no category either.
      stripeObject({
        ...txn("txn_proto", "toString", 123, 0, "ch_A1", onDay(8)),
        type: "Not a Stripe type!",
      }),
    );

    const collected = await collectTransactions(stripe.api(), PERIOD);
    const [eur] = groupStatements(collected.transactions, [], minorUnitsOf);

    expect(collected).toMatchObject({ listed: 9, ignored: 3, withoutTenant: 0 });
    // Newest first, as Stripe lists them; the type and the id only, a type of another shape left unread.
    expect(collected.unknownCategories).toEqual([
      { id: "txn_proto", type: "unreadable", reportingCategory: "unreadable" },
      { id: "txn_odd", type: "adjustment", reportingCategory: "other_adjustment" },
      { id: "txn_pcr", type: "adjustment", reportingCategory: "partial_capture_reversal" },
    ]);
    expect(JSON.stringify(collected.unknownCategories)).not.toMatch(/5000|777|123|ch_A1|pay_A1/);
    expect(
      eur?.lines.map((line) => [line.line_type, line.balance_transaction_id, line.amount, line.description]),
    ).toEqual([
      ["charge", "txn_A1", "1000.00", "Card payment captured"],
      ["refund", "txn_reA1", "-200.00", "Refund to the customer"],
      ["refund", "txn_rfA1", "200.00", "Failed refund returned"],
    ]);
    // The failed refund gives the refund back: no refund is left on the statement.
    expect(settlementTotals(eur?.lines ?? [], { feeBps: 0, decimals: 2 })).toMatchObject({
      gross_amount: "1000.00",
      refunds_amount: "0.00",
      net_amount: "985.25",
    });
  });

  it("[PBE-059] fails the run when Stripe fails, as the SDK throws", async () => {
    putMonth();
    stripe.failNext("charges.retrieve", FakeStripe.apiError(503));

    await expect(collectTransactions(stripe.api(), PERIOD)).rejects.toBeInstanceOf(
      Stripe.errors.StripeAPIError,
    );
  });
});

describe("transactionLine", () => {
  const base: TenantTransaction = {
    id: "txn_1",
    tenantId: TENANT_A,
    lineType: "charge",
    description: "Card payment captured",
    currency: "EUR",
    amount: 1_050,
    fee: 45,
    created: onDay(2),
    sourceId: "ch_1",
    paymentIntentId: "pi_1",
    velexisPaymentId: "pay_1",
    checkoutId: "chk_1",
    originalAmount: null,
    originalCurrency: null,
  };

  it("[PBE-059] converts with each currency's exponent", () => {
    expect(transactionLine({ ...base, currency: "JPY", amount: 1_500, fee: 54 }, minorUnitsOf)).toMatchObject(
      {
        amount: "1500.00",
        stripe_fee: "54.00",
      },
    );
    expect(
      transactionLine(
        { ...base, amount: -1_050, originalAmount: -1_200, originalCurrency: "USD" },
        minorUnitsOf,
      ),
    ).toMatchObject({ amount: "-10.50", original_amount: "-12.00", original_currency: "USD" });
  });

  it("leaves out an original amount the column cannot hold, and refuses a statement amount it cannot", () => {
    expect(
      transactionLine({ ...base, originalAmount: 12_345, originalCurrency: "KWD" }, minorUnitsOf),
    ).toMatchObject({ original_amount: null, original_currency: null });
    expect(() => transactionLine({ ...base, currency: "KWD", amount: 12_345 }, minorUnitsOf)).toThrow(
      SettlementDataError,
    );
    expect(() => transactionLine({ ...base, currency: "XXX" }, minorUnitsOf)).toThrow(SettlementDataError);
  });
});

describe("groupStatements and carryForwardLine", () => {
  it("[PBE-059 AC2] keeps an existing draft that no transaction names, to rebuild it empty", () => {
    const plans = groupStatements([], [{ tenant_id: TENANT_B, currency: "EUR" }], minorUnitsOf);

    expect(plans).toEqual([{ tenantId: TENANT_B, currency: "EUR", lines: [] }]);
  });

  it("[PBE-059 AC1] absorbs every earlier carried-forward balance in one line on the first day of the month", () => {
    expect(carryForwardLine([], PERIOD)).toBeUndefined();
    expect(
      carryForwardLine(
        [
          { id: "stl_aug", period_start: new Date("2026-08-01T00:00:00Z"), net_amount: "-12.25" },
          { id: "stl_sep", period_start: new Date("2026-09-01T00:00:00Z"), net_amount: "0.00" },
          { id: "stl_sep2", period_start: new Date("2026-09-01T00:00:00Z"), net_amount: "-30.00" },
        ],
        PERIOD,
      ),
    ).toEqual({
      line_type: "carry_forward",
      balance_transaction_id: null,
      source_id: null,
      payment_intent_id: null,
      velexis_payment_id: null,
      checkout_id: null,
      occurred_at: PERIOD.start,
      amount: "-42.25",
      stripe_fee: "0.00",
      original_amount: null,
      original_currency: null,
      description: "Balance carried forward from 2026-08 (stl_aug), 2026-09 (stl_sep), 2026-09 (stl_sep2)",
    });
  });
});
