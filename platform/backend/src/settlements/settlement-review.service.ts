// The settlement review workflow and the portal's statements (PBE-060; platform/docs/flows/stripe-payments-account.md
// §F items 4 and 5, flows/platform-admin-operations.md "Sequence: settlement review and payout" and §F, PADR-0003 items
// 5–11, api-inventory-admin.md §6, api-inventory-resources.md §5, scope PF-63 AC2 and AC3, PF-91). Who may call it is
// the guards' business (AdminAuthGuard and RecentMfaGuard by the operations' `x-scope` and `x-mfa-step-up`; the
// portal's TenantRoleGuard: owners and finance members); the request validation has checked the bodies and trimmed
// every admin `reason` (FIX-W35-PLATFORM). This service owns the rules, the transactions, the audit rows and the
// e-mail. Money is decimal.js through settlement-formula.ts, never a JavaScript number (conventions §1).
//
// The admin (`/v1/admin/settlements`):
//
// - `adminList`: every statement in any status, newest period first, then OTA key, currency, environment and id,
//   filtered by status, period and OTA; the cursor is the last statement of the page (`400 VALIDATION_FAILED` on
//   `/query/cursor` for one that names no statement). `adminGet`: one statement with its OTA and the review status of
//   the OTA's payout account now (`null` without one); its version is the `ETag`. `adminListLines`: its lines in
//   `occurredAt` order, cursor-paginated (the cursor is a line of that statement). `adminCsv`: every line as the
//   admin's CSV file (settlement-csv.ts).
// - `addAdjustment` (**reason**): a manual `adjustment` line on a **draft**, its amount in the statement's currency
//   (another answers `400` on `/amount/currency`) with no more decimals than that currency has minor units (its
//   exponent in `reference.currencies`, the generator's `minorUnits`: 2 for EUR, 0 for JPY, 3 for KWD; trailing zeros
//   do not count), else `422 UNPROCESSABLE` with `details.reason = amount_precision`, `details.path =
//   /amount/amount`, the currency and its exponent, and nothing written (`amountPrecisionError`; FIX-W37-PLATFORM,
//   lead decision (2j) of 2026-10-31); its description trimmed (blank answers `400` on `/description`); the totals
//   are computed again from every line with settlement-formula.ts (the statement's own `fee_bps`), so
//   `settlements_net_ck` holds, and the version rises. Audited `settlement.adjusted` with the reason.
// - `approve` (MFA step-up, `If-Match`): a **draft** with a positive net becomes `approved` and needs a `verified`
//   payout account (`422 PAYOUT_ACCOUNT_REQUIRED`); a net of zero or less becomes `carried_forward`. **A carried-
//   forward balance is absorbed once** (PADR-0003 item 7 and its note of 2026-10-30: by the earliest later open draft
//   of the same OTA, environment and currency): the approval reads again which balances this draft absorbs now
//   (settlements.repository.ts `unabsorbedCarryForwards`, the generator's own rule) and requires the draft's
//   `carry_forward` line to hold exactly those (the statements it names, `Balance carried forward from <month>
//   (<stl id>)`, and their net in its amount); otherwise another statement absorbed one of them since the draft was
//   generated, or a balance was carried forward after it, and the answer is `409 SETTLEMENT_STATE_INVALID` with
//   `details.reason = carry_forward_changed`: the admin generates the month again. The absorbed statements are locked
//   (`FOR UPDATE`) and get `carried_to_id` in the approval's transaction, so two approvals never absorb one balance.
//   Audited `settlement.approved`.
// - `markPaid` (MFA step-up, `If-Match`): an **approved** statement becomes `paid` with the transfer date (`paidAt`,
//   not in the future: `400` on `/paidAt`) and the bank reference (trimmed: blank answers `400` on
//   `/payoutReference`), and still needs a `verified` payout account. Audited `settlement.paid`; every active owner
//   and finance member of the OTA is e-mailed `settlement.paid` (PADR-0013 item 5) through the outbox, once per
//   statement and person.
// - `void` (**reason**): a **draft** becomes `void` with the reason, keeps its totals for the record, and loses its
//   lines (`line_count` 0), so their balance transactions can be settled again (PADR-0003 item 8). Audited
//   `settlement.voided`.
//
// Each write locks the statement (`FOR UPDATE`, the lock the generator takes too) and checks, in this order: it exists
// (`404 NOT_FOUND`), the `If-Match` version where the operation takes one (`412 PRECONDITION_FAILED`), its status
// (`409 SETTLEMENT_STATE_INVALID` with `details.status`), then the rest. A wrong state changes nothing.
//
// The portal (`/v1/tenants/{tenantId}/settlements`, owners and finance): `portalList`, `portalGet` and `portalCsv`
// answer the OTA's `approved`, `paid` and `carried_forward` statements only; a draft, a voided draft and a statement of
// another OTA answer `404 NOT_FOUND`.
//
// "Now" is the injected Clock's time. Nothing here logs an amount or a bank reference.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { OutboxService } from "../notifications/outbox.service";
import {
  adminSettlementCsv,
  adminSettlementCsvFilename,
  csvAttachment,
  portalSettlementCsv,
  statementCsvFilename,
} from "./settlement-csv";
import {
  SettlementDataError,
  SettlementMoney,
  settlementTotals,
  toMoney,
  toStoredAmount,
  type SettlementTotals,
} from "./settlement-formula";
import {
  SettlementReviewRepository,
  type AdminStatementRecord,
  type AdminStatementSummaryRecord,
  type CarryForwardLineRecord,
  type SettlementLineRecord,
  type StatementPosition,
} from "./settlement-review.repository";
import {
  SettlementsRepository,
  type CarriedForwardStatement,
  type SettlementEnvironment,
  type SettlementRecord,
  type SettlementStatus,
} from "./settlements.repository";

export type AdminSettlement = components["schemas"]["AdminSettlement"];
export type AdminSettlementSummary = components["schemas"]["AdminSettlementSummary"];
export type AdminSettlementList = components["schemas"]["AdminSettlementList"];
export type AdminSettlementLine = components["schemas"]["AdminSettlementLine"];
export type AdminSettlementLineList = components["schemas"]["AdminSettlementLineList"];
export type AddSettlementAdjustmentRequest = components["schemas"]["AddSettlementAdjustmentRequest"];
export type MarkSettlementPaidRequest = components["schemas"]["MarkSettlementPaidRequest"];
export type Settlement = components["schemas"]["Settlement"];
export type SettlementSummary = components["schemas"]["SettlementSummary"];
export type SettlementList = components["schemas"]["SettlementList"];
type Money = components["schemas"]["Money"];
type AdminSettlementStatus = components["schemas"]["AdminSettlementStatus"];

/** The validated query of `adminListSettlements`. */
export interface ListAdminSettlementsQuery {
  readonly status?: AdminSettlementStatus | undefined;
  /** The first instant of a month (UTC), as the document's pattern allows it. */
  readonly periodStart?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The validated query of `adminListSettlementLines`. */
export interface ListSettlementLinesQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** A CSV file to answer: its text and its `Content-Disposition`. */
export interface SettlementCsvFile {
  readonly body: string;
  readonly disposition: string;
}

/** The page size without `limit` (the document's default). */
export const DEFAULT_SETTLEMENT_PAGE_LIMIT = 50;

/** The `details.reason` of an approval whose draft holds an out-of-date carried-forward balance. */
export const CARRY_FORWARD_CHANGED = "carry_forward_changed";

/** The `details.reason` of an adjustment whose amount has more decimals than its currency's exponent. */
export const AMOUNT_PRECISION = "amount_precision";

/** The JSON pointer of an adjustment's amount, as `details.path` of `amount_precision` names it. */
export const ADJUSTMENT_AMOUNT_PATH = "/amount/amount";

// ---- Cursors ----------------------------------------------------------------------------------------------------

const SETTLEMENT_ID = /^stl_[0-9A-HJKMNP-TV-Z]{26}$/;
const LINE_ID = /^sln_[0-9A-HJKMNP-TV-Z]{26}$/;

/** An opaque cursor: base64url of `{"id": "<id>"}`, the last row of the page. */
export function encodeIdCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

/** The id of a cursor whose id matches `pattern`, or `undefined` when it is not such a cursor. */
export function decodeIdCursor(cursor: string, pattern: RegExp): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const id: unknown = (value as Record<string, unknown>)["id"];
    return Object.keys(value).length === 1 && typeof id === "string" && pattern.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "Is not a cursor of this list." }],
  });
}

// ---- Answers ----------------------------------------------------------------------------------------------------

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const money = (amount: string, currency: string): Money => ({ amount, currency });

/** The `AdminSettlementSummary` of a statement read with its OTA. */
export function toAdminSettlementSummary(row: AdminStatementSummaryRecord): AdminSettlementSummary {
  const currency = row.currency.trim();
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    tenantName: row.tenant_name,
    environment: row.environment as AdminSettlementSummary["environment"],
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    currency,
    status: row.status as AdminSettlementStatus,
    netAmount: money(row.net_amount, currency),
    lineCount: row.line_count,
    generatedAt: row.generated_at.toISOString(),
    approvedAt: iso(row.approved_at),
    paidAt: iso(row.paid_at),
    version: row.version,
  };
}

/** The `AdminSettlement` of a statement read with its OTA and the review status of its payout account. */
export function toAdminSettlement(row: AdminStatementRecord): AdminSettlement {
  const currency = row.currency.trim();
  return {
    ...toAdminSettlementSummary(row),
    grossAmount: money(row.gross_amount, currency),
    refundsAmount: money(row.refunds_amount, currency),
    disputesAmount: money(row.disputes_amount, currency),
    stripeFeesAmount: money(row.stripe_fees_amount, currency),
    velexisFeesAmount: money(row.velexis_fees_amount, currency),
    adjustmentsAmount: money(row.adjustments_amount, currency),
    feeBps: row.fee_bps,
    payoutReference: row.payout_reference,
    notes: row.notes,
    carriedToId: row.carried_to_id,
    approvedByAccountId: row.approved_by_account_id,
    paidByAccountId: row.paid_by_account_id,
    voidedAt: iso(row.voided_at),
    voidReason: row.void_reason,
    payoutAccountStatus: row.payout_account_status as AdminSettlement["payoutAccountStatus"],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The `AdminSettlementLine` of a stored line of a statement in `currency`. */
export function toAdminSettlementLine(line: SettlementLineRecord, currency: string): AdminSettlementLine {
  return {
    id: line.id,
    type: line.line_type as AdminSettlementLine["type"],
    occurredAt: line.occurred_at.toISOString(),
    amount: money(line.amount, currency),
    stripeFee: money(line.stripe_fee, currency),
    originalAmount:
      line.original_amount === null || line.original_currency === null
        ? null
        : money(line.original_amount, line.original_currency.trim()),
    balanceTransactionId: line.balance_transaction_id,
    sourceId: line.source_id,
    paymentIntentId: line.payment_intent_id,
    velexisPaymentId: line.velexis_payment_id,
    checkoutId: line.checkout_id,
    description: line.description,
    createdByAccountId: line.created_by_account_id,
  };
}

/** The portal's `SettlementSummary` of a statement its members see. */
export function toSettlementSummary(row: SettlementRecord): SettlementSummary {
  const currency = row.currency.trim();
  return {
    id: row.id,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    currency,
    status: row.status as SettlementSummary["status"],
    netAmount: money(row.net_amount, currency),
    paidAt: iso(row.paid_at),
  };
}

/** The portal's `Settlement` of a statement its members see. */
export function toSettlement(row: SettlementRecord): Settlement {
  const currency = row.currency.trim();
  return {
    ...toSettlementSummary(row),
    grossAmount: money(row.gross_amount, currency),
    refundsAmount: money(row.refunds_amount, currency),
    disputesAmount: money(row.disputes_amount, currency),
    stripeFeesAmount: money(row.stripe_fees_amount, currency),
    velexisFeesAmount: money(row.velexis_fees_amount, currency),
    adjustmentsAmount: money(row.adjustments_amount, currency),
    feeBps: row.fee_bps,
    lineCount: row.line_count,
    payoutReference: row.payout_reference,
    notes: row.notes,
  };
}

// ---- The carry-forward rule -------------------------------------------------------------------------------------

/** A statement id as the generator names it in a `carry_forward` line: `(stl_…)`. */
const NAMED_STATEMENT = /\((stl_[0-9A-HJKMNP-TV-Z]{26})\)/g;

/**
 * The statements a `carry_forward` line's text names, in its order: the generator writes `Balance carried forward from
 * 2026-09 (stl_…), 2026-10 (stl_…)` (settlement-generator.ts `carryForwardLine`).
 */
export function namedStatementIds(description: string | null): string[] {
  return description === null
    ? []
    : [...description.matchAll(NAMED_STATEMENT)].map((match) => match[1] ?? "");
}

/**
 * True when the `carry_forward` lines of a draft hold exactly the carried-forward balances it absorbs now (`expected`):
 * each statement named once, the same statements, and their net in the lines' amounts. No line and nothing to absorb
 * is a match too.
 */
export function carryForwardMatches(
  lines: readonly CarryForwardLineRecord[],
  expected: readonly Pick<CarriedForwardStatement, "id" | "net_amount">[],
): boolean {
  const named = lines.flatMap((line) => namedStatementIds(line.description));
  const expectedIds = new Set(expected.map((statement) => statement.id));
  if (
    new Set(named).size !== named.length ||
    named.length !== expectedIds.size ||
    !named.every((id) => expectedIds.has(id))
  ) {
    return false;
  }
  const held = lines.reduce((sum, line) => sum.plus(toMoney(line.amount, "amount")), new SettlementMoney(0));
  const owed = expected.reduce(
    (sum, statement) => sum.plus(toMoney(statement.net_amount, "net_amount")),
    new SettlementMoney(0),
  );
  return held.eq(owed);
}

// ---- Errors -----------------------------------------------------------------------------------------------------

function stateInvalid(status: string): AppError<"SETTLEMENT_STATE_INVALID"> {
  return new AppError("SETTLEMENT_STATE_INVALID", { details: { status } });
}

function carryForwardChanged(): AppError<"SETTLEMENT_STATE_INVALID"> {
  return new AppError("SETTLEMENT_STATE_INVALID", {
    message:
      "The draft's carried-forward balance is out of date: another statement absorbed it, or a balance was carried " +
      "forward after the draft was generated. Generate the month again, then approve the new draft.",
    details: { status: "draft" satisfies SettlementStatus, reason: CARRY_FORWARD_CHANGED },
  });
}

function payoutAccountRequired(): AppError<"PAYOUT_ACCOUNT_REQUIRED"> {
  return new AppError("PAYOUT_ACCOUNT_REQUIRED", {
    message: "A positive net is paid only to a verified payout account of the OTA.",
  });
}

/**
 * The refusal of an adjustment `amount` (a decimal string the document's pattern allowed) in `currency` whose exponent
 * is `decimals` (`reference.currencies.minor_units`, as the generator reads it): `422 UNPROCESSABLE` with `details.reason
 * = amount_precision`, `details.path`, the currency and its exponent when the amount has more decimals than that, or
 * `undefined` when it fits. Trailing zeros do not count (`1500.00` JPY is 1500 yen); the message names the currency's
 * rule, never the amount.
 */
export function amountPrecisionError(
  amount: string,
  currency: string,
  decimals: number,
): AppError<"UNPROCESSABLE"> | undefined {
  if (toMoney(amount, "amount").decimalPlaces() <= decimals) {
    return undefined;
  }
  return new AppError("UNPROCESSABLE", {
    message:
      decimals === 0
        ? `An amount in ${currency} has no decimals.`
        : `An amount in ${currency} has at most ${decimals} ${decimals === 1 ? "decimal" : "decimals"}.`,
    details: { reason: AMOUNT_PRECISION, path: ADJUSTMENT_AMOUNT_PATH, currency, decimals },
  });
}

function fieldError(path: string, code: string, message: string): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", { fieldErrors: [{ path, code, message }] });
}

/** `October 2026` for a period starting on 2026-10-01T00:00:00Z. */
const MONTH_NAME = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });

@Injectable()
export class SettlementReviewService {
  constructor(
    private readonly review: SettlementReviewRepository,
    private readonly settlements: SettlementsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  // ---- The admin's reads ------------------------------------------------------------------------------------------

  /** adminListSettlements (see the file header). */
  async adminList(query: ListAdminSettlementsQuery): Promise<AdminSettlementList> {
    const limit = query.limit ?? DEFAULT_SETTLEMENT_PAGE_LIMIT;
    let after: StatementPosition | undefined;
    if (query.cursor !== undefined) {
      const id = decodeIdCursor(query.cursor, SETTLEMENT_ID);
      after = id === undefined ? undefined : await this.review.statementPosition(id);
      if (after === undefined) {
        throw invalidCursor();
      }
    }
    const rows = await this.review.listForAdmin(
      {
        status: query.status,
        periodStart: query.periodStart === undefined ? undefined : new Date(query.periodStart),
        tenantId: query.tenantId,
      },
      after,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminSettlementSummary),
      page: { nextCursor: rows.length > limit && last !== undefined ? encodeIdCursor(last.id) : null, limit },
    };
  }

  /** adminGetSettlement: the statement with its OTA and payout account status; `404` for an unknown one. */
  async adminGet(settlementId: string): Promise<AdminStatementRecord> {
    const row = await this.review.findForAdmin(settlementId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return row;
  }

  /** adminListSettlementLines (see the file header). */
  async adminListLines(
    settlementId: string,
    query: ListSettlementLinesQuery,
  ): Promise<AdminSettlementLineList> {
    const statement = await this.review.findStatement(settlementId);
    if (statement === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const limit = query.limit ?? DEFAULT_SETTLEMENT_PAGE_LIMIT;
    let afterLineId: string | undefined;
    if (query.cursor !== undefined) {
      afterLineId = decodeIdCursor(query.cursor, LINE_ID);
      if (afterLineId === undefined || !(await this.review.lineExists(settlementId, afterLineId))) {
        throw invalidCursor();
      }
    }
    const rows = await this.review.listLines(settlementId, afterLineId, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const currency = statement.currency.trim();
    return {
      data: page.map((line) => toAdminSettlementLine(line, currency)),
      page: { nextCursor: rows.length > limit && last !== undefined ? encodeIdCursor(last.id) : null, limit },
    };
  }

  /** adminDownloadSettlementLines: every line of the statement as the admin's CSV file; `404` for an unknown one. */
  async adminCsv(settlementId: string): Promise<SettlementCsvFile> {
    const statement = await this.review.findWithTenant(settlementId);
    if (statement === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const lines = await this.review.allLines(settlementId);
    return {
      body: adminSettlementCsv(lines),
      disposition: csvAttachment(
        adminSettlementCsvFilename(statement.tenant_key, statement.period_start, statement.currency),
      ),
    };
  }

  // ---- The admin's writes -----------------------------------------------------------------------------------------

  /** adminAddSettlementAdjustment (see the file header): the draft with its new totals and version. */
  async addAdjustment(
    caller: AccessTokenClaims,
    settlementId: string,
    body: AddSettlementAdjustmentRequest,
  ): Promise<AdminStatementRecord> {
    const description = body.description.trim();
    if (description === "") {
      throw fieldError("/description", "blank", "Write the text of the line, which the OTA sees.");
    }
    return runInTransaction(this.db, async (trx) => {
      const statement = await this.lockOrNotFound(trx, settlementId);
      if (statement.status !== "draft") {
        throw stateInvalid(statement.status);
      }
      const currency = statement.currency.trim();
      if (body.amount.currency !== currency) {
        throw fieldError(
          "/amount/currency",
          "currency_mismatch",
          `An adjustment is in the statement's currency, ${currency}.`,
        );
      }
      const precision = amountPrecisionError(body.amount.amount, currency, await this.decimalsOf(currency));
      if (precision !== undefined) {
        // Before any write: the transaction leaves nothing behind.
        throw precision;
      }
      const amount = toStoredAmount(toMoney(body.amount.amount, "amount"));
      const now = this.clock.now();
      const lineId = this.ids.new("sln");
      await this.review.insertAdjustment(trx, {
        id: lineId,
        settlementId: statement.id,
        tenantId: statement.tenant_id,
        amount,
        description,
        createdByAccountId: caller.sub,
        now,
      });
      const totals = await this.totalsOf(trx, statement, () =>
        fieldError(
          "/amount/amount",
          "out_of_range",
          "With this amount the statement's totals no longer fit 10 digits before the decimal point.",
        ),
      );
      if (!(await this.review.writeDraftTotals(trx, statement.id, totals, now))) {
        throw new Error("settlement adjustment: the locked draft could not be updated");
      }
      const after = await this.readForAdmin(trx, statement.id);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "settlement.adjusted",
        targetType: "settlement",
        targetId: statement.id,
        tenantId: statement.tenant_id,
        before: {
          adjustmentsAmount: statement.adjustments_amount,
          netAmount: statement.net_amount,
          lineCount: statement.line_count,
        },
        after: {
          adjustmentsAmount: after.adjustments_amount,
          netAmount: after.net_amount,
          lineCount: after.line_count,
        },
        details: { reason: body.reason, lineId, amount, currency, description, version: after.version },
      });
      return after;
    });
  }

  /** adminApproveSettlement (see the file header): the approved or carried-forward statement. */
  async approve(
    caller: AccessTokenClaims,
    settlementId: string,
    expectedVersion: number,
  ): Promise<AdminStatementRecord> {
    return runInTransaction(this.db, async (trx) => {
      const statement = await this.lockOrNotFound(trx, settlementId);
      if (statement.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (statement.status !== "draft") {
        throw stateInvalid(statement.status);
      }
      const absorbed = await this.absorbedBalances(trx, statement);
      const status = toMoney(statement.net_amount, "net_amount").gt(0) ? "approved" : "carried_forward";
      if (status === "approved") {
        await this.requireVerifiedPayoutAccount(trx, statement.tenant_id);
      }
      const now = this.clock.now();
      const approved = await this.review.approveDraft(trx, {
        settlementId: statement.id,
        status,
        approvedByAccountId: caller.sub,
        now,
      });
      if (!approved) {
        throw new Error("settlement approval: the locked draft could not be updated");
      }
      // The balances were locked unabsorbed above, so each of them is absorbed here, by this statement only.
      if ((await this.review.absorb(trx, absorbed, statement.id, now)) !== absorbed.length) {
        throw carryForwardChanged();
      }
      const after = await this.readForAdmin(trx, statement.id);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "settlement.approved",
        targetType: "settlement",
        targetId: statement.id,
        tenantId: statement.tenant_id,
        before: { status: statement.status },
        after: { status: after.status, netAmount: after.net_amount },
        details: {
          absorbedStatementIds: absorbed,
          payoutAccountStatus: after.payout_account_status,
          version: after.version,
        },
      });
      return after;
    });
  }

  /** adminMarkSettlementPaid (see the file header): the paid statement; the owners and finance members e-mailed. */
  async markPaid(
    caller: AccessTokenClaims,
    settlementId: string,
    expectedVersion: number,
    body: MarkSettlementPaidRequest,
  ): Promise<AdminStatementRecord> {
    const payoutReference = body.payoutReference.trim();
    if (payoutReference === "") {
      throw fieldError("/payoutReference", "blank", "Enter the bank transfer's reference.");
    }
    const paidAt = new Date(body.paidAt);
    const now = this.clock.now();
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > now.getTime()) {
      throw fieldError("/paidAt", "future", "The date of the bank transfer cannot be in the future.");
    }
    return runInTransaction(this.db, async (trx) => {
      const statement = await this.lockOrNotFound(trx, settlementId);
      if (statement.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (statement.status !== "approved") {
        throw stateInvalid(statement.status);
      }
      await this.requireVerifiedPayoutAccount(trx, statement.tenant_id);
      const paid = await this.review.markPaid(trx, {
        settlementId: statement.id,
        paidAt,
        payoutReference,
        paidByAccountId: caller.sub,
        now,
      });
      if (!paid) {
        throw new Error("settlement payment: the locked statement could not be updated");
      }
      const after = await this.readForAdmin(trx, statement.id);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "settlement.paid",
        targetType: "settlement",
        targetId: statement.id,
        tenantId: statement.tenant_id,
        before: { status: statement.status },
        after: { status: after.status, netAmount: after.net_amount },
        details: { paidAt: paidAt.toISOString(), payoutReference, version: after.version },
      });
      await this.notifyPaid(trx, after);
      return after;
    });
  }

  /** adminVoidSettlement (see the file header): the voided statement, without lines. */
  async void(caller: AccessTokenClaims, settlementId: string, reason: string): Promise<AdminStatementRecord> {
    return runInTransaction(this.db, async (trx) => {
      const statement = await this.lockOrNotFound(trx, settlementId);
      if (statement.status !== "draft") {
        throw stateInvalid(statement.status);
      }
      const deletedLines = await this.review.voidDraft(trx, {
        settlementId: statement.id,
        reason,
        now: this.clock.now(),
      });
      if (deletedLines === undefined) {
        throw new Error("settlement void: the locked draft could not be updated");
      }
      const after = await this.readForAdmin(trx, statement.id);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "settlement.voided",
        targetType: "settlement",
        targetId: statement.id,
        tenantId: statement.tenant_id,
        before: {
          status: statement.status,
          lineCount: statement.line_count,
          netAmount: statement.net_amount,
        },
        after: { status: after.status, lineCount: after.line_count },
        details: { reason, deletedLines, version: after.version },
      });
      return after;
    });
  }

  // ---- The portal -------------------------------------------------------------------------------------------------

  /** listSettlements: the statements of `tenantId` its members see, newest period first. */
  async portalList(tenantId: string): Promise<SettlementList> {
    return { data: (await this.review.listForTenant(tenantId)).map(toSettlementSummary) };
  }

  /** getSettlement: one statement of `tenantId` its members see; `404` for any other. */
  async portalGet(tenantId: string, settlementId: string): Promise<SettlementRecord> {
    const row = await this.review.findForTenant(tenantId, settlementId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return row;
  }

  /** downloadSettlementLines: the lines of one statement of `tenantId` its members see, as the portal's CSV file. */
  async portalCsv(tenantId: string, settlementId: string): Promise<SettlementCsvFile> {
    const statement = await this.portalGet(tenantId, settlementId);
    const lines = await this.review.allLines(settlementId);
    return {
      body: portalSettlementCsv(lines),
      disposition: csvAttachment(statementCsvFilename(statement.period_start, statement.currency)),
    };
  }

  // ---- Helpers ----------------------------------------------------------------------------------------------------

  /** The statement `settlementId` locked for the rest of `trx`; `404 NOT_FOUND` without one. */
  private async lockOrNotFound(trx: PlatformTransaction, settlementId: string): Promise<SettlementRecord> {
    const statement = await this.review.lockStatementById(trx, settlementId);
    if (statement === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return statement;
  }

  /** The statement `settlementId` with its OTA and payout account status, read in `trx` after a write. */
  private async readForAdmin(trx: PlatformTransaction, settlementId: string): Promise<AdminStatementRecord> {
    const row = await this.review.findForAdmin(settlementId, trx);
    if (row === undefined) {
      throw new Error("settlement review: a statement written in this transaction could not be read back");
    }
    return row;
  }

  /**
   * The totals of the draft `statement` from its lines as they are in `trx`, with its own `fee_bps` and the exponent of
   * its currency. Totals that do not fit the columns throw what `tooLarge` makes.
   */
  private async totalsOf(
    trx: PlatformTransaction,
    statement: SettlementRecord,
    tooLarge: () => Error,
  ): Promise<SettlementTotals> {
    const decimals = await this.decimalsOf(statement.currency.trim());
    const lines = await this.review.lineAmounts(trx, statement.id);
    try {
      return settlementTotals(lines, { feeBps: statement.fee_bps, decimals });
    } catch (error) {
      if (error instanceof SettlementDataError) {
        throw tooLarge();
      }
      throw error;
    }
  }

  /**
   * The exponent of `currency` in `reference.currencies` (the generator's `minorUnits`: 2 for EUR, 0 for JPY, 3 for
   * KWD); a currency it does not know is a data error (500), as for the generator.
   */
  private async decimalsOf(currency: string): Promise<number> {
    const decimals = (await this.settlements.minorUnits([currency])).get(currency);
    if (decimals === undefined) {
      throw new SettlementDataError(`currency ${currency} is not in reference.currencies`);
    }
    return decimals;
  }

  /**
   * The carried-forward statements the draft `statement` absorbs, locked unabsorbed for the rest of `trx`, after
   * checking that its `carry_forward` line holds exactly them (see the file header); `409 SETTLEMENT_STATE_INVALID`
   * with `details.reason = carry_forward_changed` otherwise.
   */
  private async absorbedBalances(trx: PlatformTransaction, statement: SettlementRecord): Promise<string[]> {
    const expected = await this.settlements.unabsorbedCarryForwards(trx, {
      tenantId: statement.tenant_id,
      environment: statement.environment as SettlementEnvironment,
      currency: statement.currency.trim(),
      periodStart: statement.period_start,
    });
    if (!carryForwardMatches(await this.review.carryForwardLines(trx, statement.id), expected)) {
      throw carryForwardChanged();
    }
    const ids = expected.map((carried) => carried.id);
    if ((await this.review.lockUnabsorbed(trx, ids)).length !== ids.length) {
      throw carryForwardChanged();
    }
    return ids;
  }

  /** `422 PAYOUT_ACCOUNT_REQUIRED` unless the OTA's payout account is `verified` (read `FOR SHARE` in `trx`). */
  private async requireVerifiedPayoutAccount(trx: PlatformTransaction, tenantId: string): Promise<void> {
    if ((await this.review.payoutAccountStatusForShare(trx, tenantId)) !== "verified") {
      throw payoutAccountRequired();
    }
  }

  /** Queues `settlement.paid` to every active owner and finance member of the statement's OTA, once per person. */
  private async notifyPaid(trx: PlatformTransaction, statement: AdminStatementRecord): Promise<void> {
    const currency = statement.currency.trim();
    const statementUrl = this.outbox.portalLink(
      `/otas/${statement.tenant_id}/payments/settlements/${statement.id}`,
    );
    for (const person of await this.review.activeOwnersAndFinance(trx, statement.tenant_id)) {
      await this.outbox.queue(trx, {
        templateKey: "settlement.paid",
        to: person.email,
        accountId: person.account_id,
        tenantId: statement.tenant_id,
        data: {
          fullName: person.full_name,
          tenantName: statement.tenant_name,
          tenantKey: statement.tenant_key,
          period: MONTH_NAME.format(statement.period_start),
          netAmount: `${statement.net_amount} ${currency}`,
          paidOn: (statement.paid_at ?? this.clock.now()).toISOString().slice(0, 10),
          payoutReference: statement.payout_reference ?? "",
          statementUrl,
        },
        idempotencyKey: `settlement_paid:${statement.id}`,
      });
    }
  }
}
