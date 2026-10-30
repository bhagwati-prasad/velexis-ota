// The monthly settlement drafts (PBE-059; platform/docs/flows/stripe-payments-account.md §F items 1–3, PADR-0003
// items 2–8, scope PF-63 AC1): the work of the job `settlement.generate {periodStart, tenantId?}` (settlements.
// processor.ts), which `settlements.monthly` queues on day 3 at 05:00 UTC for the previous month and
// `adminGenerateSettlements` for any month that has ended.
//
// 1. **Stripe, once for all tenants** (`collectTransactions`). The balance transactions of the Velexis account whose
//    `created` is in the month (`[periodStart, periodEnd)`, UTC) are listed page by page (`limit` 100, `starting_after`,
//    `expand: ["data.source"]`). The `reporting_category` says what a transaction is: `charge`, `refund`,
//    `refund_failure` (a refund that failed and came back: a positive `refund` line), `dispute` and
//    `dispute_reversal` are settled. The categories of Velexis's own money (`UNSETTLED_CATEGORIES`: payouts, Stripe's
//    own fees and their tax, transfers, top-ups, …) are skipped without a word. Every other category is one this
//    generator does not know: it is skipped too, and the run logs one warning line per such transaction with its type
//    and id only (`settlement.unknown_category`: never an amount, a source or metadata), so a category Stripe adds is
//    looked at instead of disappearing (FIX-W36-PLATFORM, lead decision (2g) of 2026-10-30). The tenant
//    is `metadata.velexis_tenant_id` of the charge, or of its PaymentIntent when the charge lacks it; a refund and a
//    dispute resolve through their charge (retrieved when the expansion left an id, each charge and PaymentIntent at
//    most once per run). A transaction without a tenant (Velexis's own subscription income, a payment made outside
//    Velexis) is skipped. The line keeps the PaymentIntent, and `payment_id` and `checkout_id` of the metadata that
//    named the tenant, by value; never card data (nothing of the card is read).
// 2. **The statements** (`groupStatements`): one per tenant and balance currency (PADR-0003 item 4), in the
//    environment of the deployment (`live` with `APP_ENV=production`, else `test`: item 1), plus every draft of the
//    month that already exists (rebuilt even when no transaction belongs to it any more), plus one for each tenant
//    and currency whose only open item is a carried-forward balance this month's draft absorbs
//    (`carryForwardKeys`: the draft then holds just that `carry_forward` line, FIX-W36-PLATFORM, lead decision (2g);
//    a balance that sums to zero opens no draft). With `tenantId`, the other tenants are left alone. A transaction of
//    a tenant the platform does not know is skipped.
// 3. **One transaction per statement** (`rebuild`), after every Stripe call (no transaction is open during one): the
//    statement of the key is locked or created as a draft; one that is `approved`, `paid` or `carried_forward` is
//    never touched (item 8). A draft is rebuilt from scratch: its lines are deleted (a manual adjustment too, as the
//    contract says), one line per balance transaction is inserted (a transaction already on another statement is
//    skipped by the unique key), a `carry_forward` line adds the net of the earlier `carried_forward` statements not
//    yet absorbed (item 7 and its note of 2026-10-30: the earliest later open draft of the same tenant, environment
//    and currency absorbs a balance, so one that an earlier open draft absorbs is left to it and never counted
//    twice), and the totals come from settlement-formula.ts with `fee_bps` copied from the tenant's plan now (a
//    dispute fee counted once, in `disputes`). A rebuilt draft gets a new version (an admin's `If-Match` from before
//    fails) and an audit row `settlement.generated` (actor `system`).
//
// Running it twice over the same Stripe data gives the same drafts: the same statements and totals, and the same lines
// (with new line ids). A failure (Stripe down, the database) fails the job, BullMQ tries again (ADR-0009), and the next
// attempt rebuilds every draft from scratch; the statements rebuilt before the failure are already consistent.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type Stripe from "stripe";
import { AuditService } from "../audit/audit.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { StripeClient, type StripeApi } from "../common/stripe/stripe.client";
import type { PlatformBackendConfig } from "../config";
import {
  fitsStoredAmount,
  fromMinorUnits,
  SettlementDataError,
  settlementTotals,
  SettlementMoney,
  toMoney,
  toStoredAmount,
  type SettlementLineType,
} from "./settlement-formula";
import {
  SettlementsRepository,
  type CarriedForwardStatement,
  type SettlementEnvironment,
  type SettlementLineWrite,
  type StatementKey,
} from "./settlements.repository";

export type { SettlementEnvironment } from "./settlements.repository";

// ---- Periods ---------------------------------------------------------------------------------------------------

/** A statement period: a calendar month in UTC, `[start, end)`. */
export interface SettlementPeriod {
  readonly start: Date;
  readonly end: Date;
}

/** The first instant of month `month` (0–11, may overflow into the next or previous year) of `year`, in UTC. */
function utcMonthStart(year: number, month: number): Date {
  // setUTCFullYear, unlike Date.UTC, takes the years 0–99 as they are.
  const date = new Date(0);
  date.setUTCFullYear(year, month, 1);
  return date;
}

/** The period that starts at `periodStart`; throws a RangeError unless it is the first instant of a month in UTC. */
export function settlementPeriod(periodStart: Date): SettlementPeriod {
  const start = utcMonthStart(periodStart.getUTCFullYear(), periodStart.getUTCMonth());
  if (Number.isNaN(periodStart.getTime()) || start.getTime() !== periodStart.getTime()) {
    throw new RangeError("a settlement period starts at the first instant of a month in UTC");
  }
  return { start, end: utcMonthStart(start.getUTCFullYear(), start.getUTCMonth() + 1) };
}

/** The first instant of the calendar month (UTC) before the one of `now`: the month `settlements.monthly` settles. */
export function previousMonthStart(now: Date): Date {
  return utcMonthStart(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

/** True when the period has ended at `now` (`adminGenerateSettlements` refuses any other). */
export function isClosedPeriod(period: SettlementPeriod, now: Date): boolean {
  return period.end.getTime() <= now.getTime();
}

/** `2026-09` for a period starting on 2026-09-01. */
export function periodLabel(start: Date): string {
  return start.toISOString().slice(0, 7);
}

/** The environment of the statements a deployment generates (PADR-0003 item 1): `live` in production only. */
export function settlementEnvironment(appEnv: PlatformBackendConfig["APP_ENV"]): SettlementEnvironment {
  return appEnv === "production" ? "live" : "test";
}

// ---- Stripe ----------------------------------------------------------------------------------------------------

/** How many balance transactions one list call asks for: Stripe's maximum. */
export const BALANCE_TRANSACTION_PAGE_SIZE = 100;

/** The line types of a balance transaction. */
export type TransactionLineType = Exclude<SettlementLineType, "adjustment" | "carry_forward">;

/** What a settled `reporting_category` becomes: its line type and the line's text. */
interface SettledCategory {
  readonly lineType: TransactionLineType;
  readonly description: string;
}

/** The reporting categories that are settled (file header, step 1), and their lines. */
export const SETTLED_CATEGORIES: Readonly<Record<string, SettledCategory>> = Object.freeze({
  charge: { lineType: "charge", description: "Card payment captured" },
  refund: { lineType: "refund", description: "Refund to the customer" },
  refund_failure: { lineType: "refund", description: "Failed refund returned" },
  dispute: { lineType: "dispute", description: "Dispute: amount and dispute fee withdrawn" },
  dispute_reversal: { lineType: "dispute_reversal", description: "Dispute won: amount reinstated" },
});

/**
 * The reporting categories of Velexis's own money on its Stripe balance, never a tenant's payment (PADR-0003 item 3:
 * payouts, Stripe's own fees and the tax on them, transfers, top-ups, Connect and reserve movements, contributions):
 * skipped without a word. Any category in neither list is skipped with a warning (file header, step 1).
 */
export const UNSETTLED_CATEGORIES: ReadonlySet<string> = new Set([
  "payout",
  "payout_reversal",
  "fee",
  "tax",
  "transfer",
  "transfer_reversal",
  "topup",
  "topup_reversal",
  "platform_earning",
  "platform_earning_refund",
  "connect_collection_transfer",
  "connect_reserved_funds",
  "risk_reserved_funds",
  "contribution",
  "climate_order_purchase",
  "climate_order_refund",
]);

/** A short lower-case Stripe identifier (a type or a category), safe to log as it is. */
const STRIPE_IDENTIFIER = /^[a-z_]{1,64}$/;
/** A Stripe object id (`txn_…`), safe to log as it is. */
const STRIPE_OBJECT_ID = /^[A-Za-z0-9_]{1,255}$/;

/** A balance transaction of a category this generator does not know: what the warning names, and nothing else. */
export interface UnknownCategoryTransaction {
  /** `txn_…`, or `unreadable` when Stripe sent something of another shape. */
  readonly id: string;
  /** The transaction's `type` (`adjustment`, …), or `unreadable`. */
  readonly type: string;
  /** Its `reporting_category`, or `unreadable`. */
  readonly reportingCategory: string;
}

/** What the warning of an unknown category may name: the type and the id, each only in Stripe's own shape. */
function unknownCategoryOf(txn: Stripe.BalanceTransaction): UnknownCategoryTransaction {
  const readable = (value: unknown, pattern: RegExp): string =>
    typeof value === "string" && pattern.test(value) ? value : "unreadable";
  return {
    id: readable(txn.id, STRIPE_OBJECT_ID),
    type: readable(txn.type, STRIPE_IDENTIFIER),
    reportingCategory: readable(txn.reporting_category, STRIPE_IDENTIFIER),
  };
}

/** A `ten_` id as the platform writes it. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;
/** What a tenant id taken by value from Stripe metadata may look like (`pay_…`, `chk_…`). */
const METADATA_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A balance transaction of the month that belongs to a tenant, with what its line needs (amounts in minor units). */
export interface TenantTransaction {
  /** `txn_…`. */
  readonly id: string;
  readonly tenantId: string;
  readonly lineType: TransactionLineType;
  readonly description: string;
  /** The balance currency, upper case. */
  readonly currency: string;
  /** Signed: negative for refunds and disputes. */
  readonly amount: number;
  /** Stripe's fee (positive = cost). */
  readonly fee: number;
  /** Unix seconds. */
  readonly created: number;
  /** The charge, refund or dispute. */
  readonly sourceId: string;
  readonly paymentIntentId: string | null;
  readonly velexisPaymentId: string | null;
  readonly checkoutId: string | null;
  /** The amount in the charge's currency when it is not the balance currency (signed like `amount`), else null. */
  readonly originalAmount: number | null;
  readonly originalCurrency: string | null;
}

/** What one pass over the month's balance transactions found. */
export interface CollectedTransactions {
  /** Every balance transaction listed. */
  readonly listed: number;
  /** Transactions of Velexis's own money (`UNSETTLED_CATEGORIES`). */
  readonly ignored: number;
  /** Transactions of a category this generator does not know, skipped (the run warns about each). */
  readonly unknownCategories: UnknownCategoryTransaction[];
  /** Settled categories without a tenant in the metadata. */
  readonly withoutTenant: number;
  readonly transactions: TenantTransaction[];
}

/** The Velexis keys of a metadata object that names a tenant. */
interface VelexisMetadata {
  readonly tenantId: string;
  readonly paymentId: string | null;
  readonly checkoutId: string | null;
}

function velexisMetadata(metadata: Stripe.Metadata | null | undefined): VelexisMetadata | undefined {
  const tenantId = metadata?.["velexis_tenant_id"];
  if (typeof tenantId !== "string" || !TENANT_ID.test(tenantId)) {
    return undefined;
  }
  const byValue = (key: string): string | null => {
    const value = metadata?.[key];
    return typeof value === "string" && METADATA_ID.test(value) ? value : null;
  };
  return { tenantId, paymentId: byValue("payment_id"), checkoutId: byValue("checkout_id") };
}

/** The id of a Stripe reference that may be expanded. */
function idOf(reference: string | { readonly id: string } | null | undefined): string | null {
  if (reference === null || reference === undefined) {
    return null;
  }
  return typeof reference === "string" ? reference : reference.id;
}

/** The charges and PaymentIntents of one run, each retrieved at most once. */
class StripeObjects {
  private readonly charges = new Map<string, Promise<Stripe.Charge>>();
  private readonly intents = new Map<string, Promise<Stripe.PaymentIntent>>();

  constructor(private readonly stripe: StripeApi) {}

  charge(reference: string | Stripe.Charge | null | undefined): Promise<Stripe.Charge | null> {
    if (reference === null || reference === undefined) {
      return Promise.resolve(null);
    }
    if (typeof reference !== "string") {
      return Promise.resolve(reference);
    }
    let charge = this.charges.get(reference);
    if (charge === undefined) {
      charge = this.stripe.charges.retrieve(reference);
      this.charges.set(reference, charge);
    }
    return charge;
  }

  intent(reference: string | Stripe.PaymentIntent | null | undefined): Promise<Stripe.PaymentIntent | null> {
    if (reference === null || reference === undefined) {
      return Promise.resolve(null);
    }
    if (typeof reference !== "string") {
      return Promise.resolve(reference);
    }
    let intent = this.intents.get(reference);
    if (intent === undefined) {
      intent = this.stripe.paymentIntents.retrieve(reference);
      this.intents.set(reference, intent);
    }
    return intent;
  }
}

/** The source of a settled transaction, as far as its line needs it. */
interface SourceFacts {
  readonly id: string;
  readonly charge: Stripe.Charge | null;
  /** The source's own PaymentIntent reference (a refund's or a dispute's), used when the charge has none. */
  readonly intent: string | Stripe.PaymentIntent | null;
  /** The amount in the source's currency, unsigned (minor units). */
  readonly amount: number;
  readonly currency: string;
}

async function sourceFacts(
  source: Stripe.BalanceTransaction["source"],
  objects: StripeObjects,
): Promise<SourceFacts | undefined> {
  if (source === null || typeof source === "string") {
    return undefined;
  }
  if (source.object === "charge") {
    return {
      id: source.id,
      charge: source,
      intent: null,
      amount: source.amount_captured,
      currency: source.currency,
    };
  }
  if (source.object === "refund" || source.object === "dispute") {
    return {
      id: source.id,
      charge: await objects.charge(source.charge),
      intent: source.payment_intent ?? null,
      amount: source.amount,
      currency: source.currency,
    };
  }
  // Payouts, transfers, Stripe's own fees: never a tenant's payment.
  return undefined;
}

/**
 * The tenant transaction of `txn`; `"ignored"` for a category of Velexis's own money, `"unknown"` for a category this
 * generator does not know, `"no_tenant"` without a tenant.
 */
async function resolveTransaction(
  txn: Stripe.BalanceTransaction,
  objects: StripeObjects,
): Promise<TenantTransaction | "ignored" | "unknown" | "no_tenant"> {
  const category = Object.hasOwn(SETTLED_CATEGORIES, txn.reporting_category)
    ? SETTLED_CATEGORIES[txn.reporting_category]
    : undefined;
  if (category === undefined) {
    return UNSETTLED_CATEGORIES.has(txn.reporting_category) ? "ignored" : "unknown";
  }
  const source = await sourceFacts(txn.source, objects);
  if (source === undefined) {
    return "no_tenant";
  }
  const intentReference = source.charge?.payment_intent ?? source.intent;
  let owner = velexisMetadata(source.charge?.metadata);
  if (owner === undefined) {
    owner = velexisMetadata((await objects.intent(intentReference))?.metadata);
  }
  if (owner === undefined) {
    return "no_tenant";
  }
  const currency = txn.currency.toUpperCase();
  const originalCurrency = source.currency.toUpperCase();
  const converted = originalCurrency !== currency;
  return {
    id: txn.id,
    tenantId: owner.tenantId,
    lineType: category.lineType,
    description: category.description,
    currency,
    amount: txn.amount,
    fee: txn.fee,
    created: txn.created,
    sourceId: source.id,
    paymentIntentId: idOf(intentReference),
    velexisPaymentId: owner.paymentId,
    checkoutId: owner.checkoutId,
    originalAmount: converted ? Math.sign(txn.amount) * Math.abs(source.amount) : null,
    originalCurrency: converted ? originalCurrency : null,
  };
}

/** Whole seconds since the epoch, as Stripe's `created`. */
function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Lists the balance transactions of `period` once (newest first, as Stripe pages them) and resolves the tenant of
 * each settled one (file header, step 1). Throws what the Stripe SDK throws.
 */
export async function collectTransactions(
  stripe: StripeApi,
  period: SettlementPeriod,
): Promise<CollectedTransactions> {
  const objects = new StripeObjects(stripe);
  const transactions: TenantTransaction[] = [];
  const unknownCategories: UnknownCategoryTransaction[] = [];
  let listed = 0;
  let ignored = 0;
  let withoutTenant = 0;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.balanceTransactions.list({
      created: { gte: unixSeconds(period.start), lt: unixSeconds(period.end) },
      limit: BALANCE_TRANSACTION_PAGE_SIZE,
      expand: ["data.source"],
      ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
    });
    for (const txn of page.data) {
      listed += 1;
      const resolved = await resolveTransaction(txn, objects);
      if (resolved === "ignored") {
        ignored += 1;
      } else if (resolved === "unknown") {
        unknownCategories.push(unknownCategoryOf(txn));
      } else if (resolved === "no_tenant") {
        withoutTenant += 1;
      } else {
        transactions.push(resolved);
      }
    }
    const last = page.data.at(-1);
    if (!page.has_more || last === undefined) {
      break;
    }
    startingAfter = last.id;
  }
  return { listed, ignored, unknownCategories, withoutTenant, transactions };
}

// ---- Statements -------------------------------------------------------------------------------------------------

/** The exponent of a currency; throws SettlementDataError for one `reference.currencies` does not know. */
export type MinorUnitsOf = (currency: string) => number;

/** The line of a tenant transaction, its amounts in the statement currency (`numeric(12,2)`). */
export function transactionLine(txn: TenantTransaction, minorUnitsOf: MinorUnitsOf): SettlementLineWrite {
  const decimals = minorUnitsOf(txn.currency);
  let originalAmount: string | null = null;
  let originalCurrency: string | null = null;
  if (txn.originalAmount !== null && txn.originalCurrency !== null) {
    const original = fromMinorUnits(txn.originalAmount, minorUnitsOf(txn.originalCurrency));
    // For reference only: an amount with more decimals than the column holds is left out rather than rounded.
    if (fitsStoredAmount(original)) {
      originalAmount = toStoredAmount(original);
      originalCurrency = txn.originalCurrency;
    }
  }
  return {
    line_type: txn.lineType,
    balance_transaction_id: txn.id,
    source_id: txn.sourceId,
    payment_intent_id: txn.paymentIntentId,
    velexis_payment_id: txn.velexisPaymentId,
    checkout_id: txn.checkoutId,
    occurred_at: new Date(txn.created * 1000),
    amount: toStoredAmount(fromMinorUnits(txn.amount, decimals)),
    stripe_fee: toStoredAmount(fromMinorUnits(txn.fee, decimals)),
    original_amount: originalAmount,
    original_currency: originalCurrency,
    description: txn.description,
  };
}

/** The draft one tenant and balance currency should have. */
export interface StatementPlan {
  readonly tenantId: string;
  readonly currency: string;
  /** One line per balance transaction, oldest first. */
  readonly lines: SettlementLineWrite[];
}

/**
 * The statements of `transactions` (one per tenant and balance currency), plus one without transaction lines for each
 * of `otherKeys` that no transaction names (an existing draft of the month, or a tenant and currency whose only open
 * item is a carried-forward balance), sorted by tenant and currency.
 */
export function groupStatements(
  transactions: readonly TenantTransaction[],
  otherKeys: ReadonlyArray<{ readonly tenant_id: string; readonly currency: string }>,
  minorUnitsOf: MinorUnitsOf,
): StatementPlan[] {
  const plans = new Map<string, StatementPlan>();
  const planOf = (tenantId: string, currency: string): StatementPlan => {
    const key = `${tenantId} ${currency}`;
    let plan = plans.get(key);
    if (plan === undefined) {
      plan = { tenantId, currency, lines: [] };
      plans.set(key, plan);
    }
    return plan;
  };
  const oldestFirst = [...transactions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  for (const txn of oldestFirst) {
    planOf(txn.tenantId, txn.currency).lines.push(transactionLine(txn, minorUnitsOf));
  }
  for (const key of otherKeys) {
    planOf(key.tenant_id, key.currency.trim());
  }
  return [...plans.values()].sort(
    (a, b) => a.tenantId.localeCompare(b.tenantId) || a.currency.localeCompare(b.currency),
  );
}

/**
 * The `carry_forward` line of a draft that absorbs `statements` (earlier `carried_forward` balances, PADR-0003 item
 * 7): their net in one signed amount on the first day of the period; `undefined` when there is none.
 */
export function carryForwardLine(
  statements: readonly CarriedForwardStatement[],
  period: SettlementPeriod,
): SettlementLineWrite | undefined {
  if (statements.length === 0) {
    return undefined;
  }
  const net = statements.reduce(
    (sum, statement) => sum.plus(toMoney(statement.net_amount, "net_amount")),
    new SettlementMoney(0),
  );
  const from = statements.map((statement) => `${periodLabel(statement.period_start)} (${statement.id})`);
  return {
    line_type: "carry_forward",
    balance_transaction_id: null,
    source_id: null,
    payment_intent_id: null,
    velexis_payment_id: null,
    checkout_id: null,
    occurred_at: period.start,
    amount: toStoredAmount(net),
    stripe_fee: "0.00",
    original_amount: null,
    original_currency: null,
    description: `Balance carried forward from ${from.join(", ")}`,
  };
}

// ---- The job ----------------------------------------------------------------------------------------------------

/** What one `settlement.generate` job does. */
export interface SettlementGenerationInput {
  /** The first instant of the month (UTC). */
  readonly periodStart: Date;
  /** Only this tenant's drafts; every tenant's without it. */
  readonly tenantId?: string;
  /** The request that queued the job (`adminGenerateSettlements`), for the audit rows. */
  readonly requestId?: string;
}

/** What a finished run returns (BullMQ keeps it with the job): counts and ids, never an amount or metadata. */
export interface SettlementGenerationResult {
  readonly periodStart: string;
  readonly environment: SettlementEnvironment;
  readonly tenantId: string | null;
  /** Balance transactions listed. */
  readonly transactions: number;
  /** Of a category of Velexis's own money. */
  readonly ignored: number;
  /** Of a category the generator does not know: skipped, each with a warning line. */
  readonly unknownCategory: number;
  /** Without a tenant. */
  readonly withoutTenant: number;
  /** Of a tenant the platform does not know. */
  readonly unknownTenant: number;
  /** Of another tenant than `tenantId`. */
  readonly otherTenants: number;
  /** Already on another statement (an approved or paid one): skipped by the unique key. */
  readonly alreadySettled: number;
  /** Transaction lines written on drafts. */
  readonly lines: number;
  /** Drafts created or rebuilt. */
  readonly rebuilt: number;
  /**
   * Of `rebuilt`: drafts this run opened for a tenant and currency whose only open item was a carried-forward balance
   * (`carryForwardKeys`). A later run of the month rebuilds such a draft as an existing one and does not count it here.
   */
  readonly carryForwardOnly: number;
  /** Approved, paid or carried-forward statements left as they are. */
  readonly untouched: number;
}

/** What `rebuild` did with one statement. */
type RebuildOutcome =
  | { readonly status: "rebuilt"; readonly lines: number; readonly alreadySettled: number }
  | { readonly status: "untouched" };

/** The actor label of the job's audit rows. */
export const SETTLEMENT_GENERATE_ACTOR = "settlement.generate";

@Injectable()
export class SettlementGenerator {
  private readonly environment: SettlementEnvironment;

  constructor(
    private readonly stripe: StripeClient,
    private readonly repository: SettlementsRepository,
    private readonly audit: AuditService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(SettlementGenerator.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.environment = settlementEnvironment(config.get("APP_ENV", { infer: true }));
  }

  /** One run (file header). */
  async generate(input: SettlementGenerationInput): Promise<SettlementGenerationResult> {
    const period = settlementPeriod(input.periodStart);
    const collected = await collectTransactions(this.stripe.api(), period);
    const inScope =
      input.tenantId === undefined
        ? collected.transactions
        : collected.transactions.filter((txn) => txn.tenantId === input.tenantId);
    for (const unknown of collected.unknownCategories) {
      // One line per transaction, its type and id only: never an amount, a source or metadata.
      this.logger.warn(
        {
          periodStart: period.start.toISOString(),
          balanceTransactionId: unknown.id,
          type: unknown.type,
          reportingCategory: unknown.reportingCategory,
        },
        "settlement.unknown_category",
      );
    }
    const drafts = await this.repository.draftKeys(this.environment, period.start, input.tenantId);
    // A tenant and currency whose only open item is a carried-forward balance gets a draft too (file header, step 2).
    const carried = await this.repository.carryForwardKeys(this.environment, period.start, input.tenantId);
    const otherKeys = [...drafts, ...carried];
    const feeBps = await this.repository.feeBpsOfTenants([
      ...new Set([...inScope.map((txn) => txn.tenantId), ...otherKeys.map((key) => key.tenant_id)]),
    ]);
    const known = inScope.filter((txn) => feeBps.has(txn.tenantId));
    const currencies = new Set<string>(otherKeys.map((key) => key.currency.trim()));
    for (const txn of known) {
      currencies.add(txn.currency);
      if (txn.originalCurrency !== null) {
        currencies.add(txn.originalCurrency);
      }
    }
    const exponents = await this.repository.minorUnits([...currencies]);
    const minorUnitsOf: MinorUnitsOf = (currency) => {
      const exponent = exponents.get(currency);
      if (exponent === undefined) {
        throw new SettlementDataError(`currency ${currency} is not in reference.currencies`);
      }
      return exponent;
    };

    const carriedOnly = new Set(carried.map((key) => `${key.tenant_id} ${key.currency.trim()}`));
    let lines = 0;
    let alreadySettled = 0;
    let rebuilt = 0;
    let carryForwardOnly = 0;
    let untouched = 0;
    for (const plan of groupStatements(known, otherKeys, minorUnitsOf)) {
      const outcome = await this.rebuild(
        plan,
        period,
        feeBps.get(plan.tenantId) ?? 0,
        minorUnitsOf(plan.currency),
        input.requestId,
      );
      if (outcome.status === "untouched") {
        untouched += 1;
      } else {
        rebuilt += 1;
        lines += outcome.lines;
        alreadySettled += outcome.alreadySettled;
        if (plan.lines.length === 0 && carriedOnly.has(`${plan.tenantId} ${plan.currency}`)) {
          carryForwardOnly += 1;
        }
      }
    }
    const result: SettlementGenerationResult = {
      periodStart: period.start.toISOString(),
      environment: this.environment,
      tenantId: input.tenantId ?? null,
      transactions: collected.listed,
      ignored: collected.ignored,
      unknownCategory: collected.unknownCategories.length,
      withoutTenant: collected.withoutTenant,
      unknownTenant: inScope.length - known.length,
      otherTenants: collected.transactions.length - inScope.length,
      alreadySettled,
      lines,
      rebuilt,
      carryForwardOnly,
      untouched,
    };
    this.logger.info({ ...result }, "settlement.generated");
    return result;
  }

  /** Rebuilds the draft of `plan` in one transaction, or leaves a statement that is no longer a draft alone. */
  private async rebuild(
    plan: StatementPlan,
    period: SettlementPeriod,
    feeBps: number,
    decimals: number,
    requestId: string | undefined,
  ): Promise<RebuildOutcome> {
    const key: StatementKey = {
      tenantId: plan.tenantId,
      environment: this.environment,
      currency: plan.currency,
      periodStart: period.start,
    };
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      let statement = await this.repository.lockStatement(trx, key);
      let created = false;
      if (statement === undefined) {
        created = await this.repository.insertDraft(trx, {
          ...key,
          id: this.ids.new("stl"),
          periodEnd: period.end,
          feeBps,
          now,
        });
        // The new draft, or the statement another run inserted first (then rebuilt like any existing one).
        statement = await this.repository.lockStatement(trx, key);
      }
      if (statement === undefined) {
        throw new Error("settlement.generate: the draft of a statement key could not be read back");
      }
      if (statement.status !== "draft") {
        return { status: "untouched" };
      }
      const before = { lineCount: statement.line_count, netAmount: statement.net_amount };
      await this.repository.deleteLines(trx, statement.id);
      const newLineId = () => this.ids.new("sln");
      const inserted = await this.repository.insertLines(trx, statement, plan.lines, newLineId);
      const carryForward = carryForwardLine(await this.repository.unabsorbedCarryForwards(trx, key), period);
      const all =
        carryForward === undefined
          ? inserted
          : [...inserted, ...(await this.repository.insertLines(trx, statement, [carryForward], newLineId))];
      const totals = settlementTotals(all, { feeBps, decimals });
      const row = await this.repository.writeTotals(trx, statement.id, {
        ...totals,
        fee_bps: feeBps,
        // A new draft keeps version 1; a rebuilt one changes under any If-Match taken before.
        version: created ? statement.version : statement.version + 1,
        now,
      });
      const alreadySettled = plan.lines.length - inserted.length;
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: SETTLEMENT_GENERATE_ACTOR,
        action: "settlement.generated",
        targetType: "settlement",
        targetId: row.id,
        tenantId: row.tenant_id,
        ...(created ? {} : { before }),
        after: { lineCount: row.line_count, netAmount: row.net_amount },
        details: {
          periodStart: period.start.toISOString(),
          environment: this.environment,
          currency: plan.currency,
          alreadySettled,
        },
        ...(requestId === undefined ? {} : { requestId }),
      });
      return { status: "rebuilt", lines: inserted.length, alreadySettled };
    });
  }
}
