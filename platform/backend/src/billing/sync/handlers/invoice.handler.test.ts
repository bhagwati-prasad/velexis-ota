// The pure parts of the invoice handler (PBE-046; invoice.handler.ts): the state an invoice row keeps of a Stripe
// invoice (minor units with the currency's exponent, the amounts that keep `invoices_total_ck`, the billed period and
// the dates), the OTA an invoice names, and its subscription. The X-028 fixture of `invoice.paid` is the invoice.
import { stripeFixture } from "@velexis/testing/stripe";
import type Stripe from "stripe";
import { beforeAll, describe, expect, it } from "vitest";
import { StripeEventFailure } from "../../../common/stripe/stripe-inbox.service";
import { BillingMoney } from "../../minor-units";
import { invoiceCurrency, invoiceStateOf, invoiceSubscriptionId, invoiceTenantOf } from "./invoice.handler";

type NumberedInvoice = Stripe.Invoice & { readonly number: string };

const TENANT = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const OTHER = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5G";

let base: Stripe.Invoice;

beforeAll(() => {
  // Reads and parses the fixture once.
  base = stripeFixture("invoice.paid").data.object;
});

/** The fixture's invoice with `changes`. */
function invoice(changes: Partial<Stripe.Invoice> = {}): NumberedInvoice {
  return { ...base, number: base.number ?? "TESTALPHA-0001", ...changes } as NumberedInvoice;
}

/** The StripeEventFailure `run` throws (or fails the test). */
function failureOf(run: () => unknown): StripeEventFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof StripeEventFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a StripeEventFailure");
}

describe("invoiceStateOf", () => {
  it("[PBE-046 AC1] converts the amounts of a JPY invoice of 5000 minor units with exponent 0: 5000", () => {
    const state = invoiceStateOf(
      invoice({
        currency: "jpy",
        total: 5000,
        subtotal: 5000,
        total_excluding_tax: 5000,
        amount_paid: 5000,
        amount_due: 5000,
        amount_remaining: 0,
      }),
      0,
      TENANT,
    );

    expect(state).toMatchObject({
      currency: "JPY",
      total: "5000.00",
      subtotal: "5000.00",
      taxAmount: "0.00",
      amountPaid: "5000.00",
      amountDue: "0.00",
    });
  });

  it("[PBE-046 AC1] converts the amounts of a EUR invoice of 4900 minor units with exponent 2: 49.00", () => {
    const state = invoiceStateOf(invoice(), 2, TENANT);

    expect(state).toEqual({
      number: "TESTALPHA-0001",
      status: "paid",
      currency: "EUR",
      subtotal: "49.00",
      taxAmount: "0.00",
      total: "49.00",
      amountPaid: "49.00",
      amountDue: "0.00",
      // The line's period: the month the invoice charges in advance.
      periodStart: new Date(1_791_795_895_000),
      periodEnd: new Date(1_794_474_295_000),
      issuedAt: new Date(1_791_795_896_000),
      dueAt: null,
      paidAt: new Date(1_791_795_898_000),
      hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_test_velexis/test_in_test_alpha_1",
      invoicePdfUrl: "https://pay.stripe.com/invoice/acct_test_velexis/test_in_test_alpha_1/pdf",
    });
  });

  it("keeps total = subtotal + tax with a discount and tax: the subtotal is the total before tax, after discounts", () => {
    // 49.00 less a 9.00 discount, plus 20 % VAT on 40.00.
    const state = invoiceStateOf(
      invoice({ subtotal: 4900, total_excluding_tax: 4000, total: 4800, status: "open", amount_paid: 0 }),
      2,
      TENANT,
    );

    expect(state).toMatchObject({ subtotal: "40.00", taxAmount: "8.00", total: "48.00", status: "open" });
    expect(new BillingMoney(state.subtotal).plus(state.taxAmount).toFixed(2)).toBe(state.total);
  });

  it("takes the invoice's taxes off the total when Stripe gives no total_excluding_tax", () => {
    const taxes = [{ amount: 800 } as Stripe.Invoice.TotalTax];
    const state = invoiceStateOf(
      invoice({ total_excluding_tax: null, total: 4800, total_taxes: taxes }),
      2,
      TENANT,
    );

    expect(state).toMatchObject({ subtotal: "40.00", taxAmount: "8.00", total: "48.00" });
  });

  it("takes the invoice's own period without lines, and the finalization time without effective_at", () => {
    const state = invoiceStateOf(
      invoice({
        lines: { ...base.lines, data: [] },
        period_start: 1_791_000_000,
        period_end: 1_791_100_000,
        effective_at: null,
        due_date: 1_792_000_000,
        status: "open",
        status_transitions: { ...base.status_transitions, paid_at: null },
      }),
      2,
      TENANT,
    );

    expect(state).toMatchObject({
      periodStart: new Date(1_791_000_000_000),
      periodEnd: new Date(1_791_100_000_000),
      issuedAt: new Date(1_791_795_896_000),
      dueAt: new Date(1_792_000_000_000),
      paidAt: null,
    });
  });

  it("spans every line of the invoice (a proration and the next period)", () => {
    const [line] = base.lines.data;
    if (line === undefined) {
      throw new Error("the fixture has no line");
    }
    const lines = [
      { ...line, period: { start: 1_791_500_000, end: 1_791_795_895 } },
      { ...line, period: { start: 1_791_795_895, end: 1_794_474_295 } },
    ];
    const state = invoiceStateOf(invoice({ lines: { ...base.lines, data: lines } }), 2, TENANT);

    expect(state).toMatchObject({
      periodStart: new Date(1_791_500_000_000),
      periodEnd: new Date(1_794_474_295_000),
    });
  });

  it("fails for good on an amount the numeric(12,2) columns cannot hold exactly, rather than rounding it", () => {
    const failure = failureOf(() => invoiceStateOf(invoice({ total: 1235, currency: "kwd" }), 3, TENANT));

    expect(failure).toMatchObject({
      code: "UNSUPPORTED_AMOUNT",
      options: { retryable: false, tenantId: TENANT },
    });
  });

  it("fails for good on a tax amount that is not a whole number of minor units", () => {
    const taxes = [{ amount: 1.5 } as Stripe.Invoice.TotalTax];
    const failure = failureOf(() =>
      invoiceStateOf(invoice({ total_excluding_tax: null, total_taxes: taxes }), 2, TENANT),
    );

    expect(failure).toMatchObject({ code: "UNSUPPORTED_AMOUNT", options: { retryable: false } });
  });

  it("fails for good on a status the table does not know", () => {
    const failure = failureOf(() => invoiceStateOf(invoice({ status: null }), 2, TENANT));

    expect(failure).toMatchObject({ code: "UNSUPPORTED_INVOICE", options: { retryable: false } });
  });
});

describe("invoiceCurrency", () => {
  it("upper-cases Stripe's currency and refuses another shape", () => {
    expect(invoiceCurrency(invoice({ currency: "eur" }))).toBe("EUR");
    expect(failureOf(() => invoiceCurrency(invoice({ currency: "euro" })))).toMatchObject({
      code: "UNKNOWN_CURRENCY",
      options: { retryable: false },
    });
  });
});

describe("invoiceSubscriptionId", () => {
  it("names the subscription of a subscription invoice, and none for a one-off invoice", () => {
    expect(invoiceSubscriptionId(invoice())).toBe("sub_test_alpha_1");
    expect(invoiceSubscriptionId(invoice({ parent: null }))).toBeUndefined();
  });

  it("fails for good on a subscription id of another shape (the lock takes sub_ ids only)", () => {
    const parent = {
      type: "subscription_details",
      quote_details: null,
      subscription_details: { metadata: null, subscription: "sub test" },
    } as Stripe.Invoice.Parent;

    expect(failureOf(() => invoiceSubscriptionId(invoice({ parent })))).toMatchObject({
      code: "INVALID_SUBSCRIPTION",
      options: { retryable: false },
    });
  });
});

describe("invoiceTenantOf", () => {
  it("takes the Customer's OTA, else the subscription row's, else the metadata's", () => {
    expect(invoiceTenantOf({ customer: TENANT, subscription: undefined, metadata: undefined })).toBe(TENANT);
    expect(invoiceTenantOf({ customer: undefined, subscription: TENANT, metadata: TENANT })).toBe(TENANT);
    expect(invoiceTenantOf({ customer: undefined, subscription: undefined, metadata: TENANT })).toBe(TENANT);
    expect(
      invoiceTenantOf({ customer: undefined, subscription: undefined, metadata: undefined }),
    ).toBeUndefined();
  });

  it.each([
    { customer: TENANT, subscription: undefined, metadata: OTHER },
    { customer: TENANT, subscription: OTHER, metadata: undefined },
    { customer: undefined, subscription: TENANT, metadata: OTHER },
  ])("fails for good when two of them name different OTAs (%o)", (claims) => {
    expect(failureOf(() => invoiceTenantOf(claims))).toMatchObject({
      code: "TENANT_MISMATCH",
      options: { retryable: false },
    });
  });
});
