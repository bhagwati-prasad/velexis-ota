// The queries of the settlement review workflow and of the portal's statements (PBE-060; platform/docs/
// architecture.md §2.1: SettlementsModule owns `settlements` and `settlement_lines`; PADR-0003 items 7–11, flows/
// stripe-payments-account.md §F items 4 and 5, api-inventory-admin.md §6 and api-inventory-resources.md §5). Kysely on
// the process's `PLATFORM_DB`, schema-qualified tables (ADR-0005). The generator's queries (the drafts it rebuilds,
// the carried-forward balances a draft absorbs) stay in settlements.repository.ts; the review service uses both.
//
// - **Reads of the admin**, each of the tables its operation's `x-platform-tables` names: a statement with its OTA's
//   key and name and the review status of the OTA's payout account (`findForAdmin`, left join: `null` without an
//   account), with its OTA only (`findWithTenant`, the CSV's file name) or alone (`findStatement`, the lines), the
//   paginated list (`listForAdmin`, newest period first, then OTA key, currency, environment and id, after the sort key
//   of the previous page's last statement, `statementPosition`), and the lines in `occurred_at` order (`listLines`
//   after a line of the same statement, `allLines` for the CSV, one query, so a file is one snapshot).
// - **Reads of the portal**: the statements of one OTA that its members may see (`approved`, `paid`,
//   `carried_forward`: never a draft or a voided draft, `VISIBLE_TO_TENANT`), newest period first.
// - **Writes** in the caller's transaction, each on a statement the caller locked first (`lockStatementById`, `FOR
//   UPDATE`) and guarded by the status it expects, so a write never changes a statement in another status: an
//   adjustment line and the recomputed totals of a draft, the approval (and `carried_to_id` on the carried-forward
//   statements it absorbs, `lockUnabsorbed` first), the payment, the void (lines deleted). Every write raises the
//   version by one.
// - It also reads, read only, what the workflow needs from other tables: the review status of the OTA's payout account
//   (`payoutAccountStatusForShare`, `FOR SHARE`, so an owner's change waits for the approval or payment that read it),
//   and the active owners and finance members with their e-mail address and name (the `settlement.paid` e-mail), as
//   payout-accounts.repository.ts reads the owners.
import { Inject, Injectable } from "@nestjs/common";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import type { SettlementLineAmounts, SettlementTotals } from "./settlement-formula";
import type { SettlementRecord, SettlementStatus } from "./settlements.repository";

/** A `platform.settlement_lines` row. */
export type SettlementLineRecord = Selectable<PlatformDatabase["platform.settlement_lines"]>;

/** The statuses of the statements an OTA's members see (never `draft` or `void`). */
export const VISIBLE_TO_TENANT = Object.freeze([
  "approved",
  "paid",
  "carried_forward",
] as const satisfies readonly SettlementStatus[]);

/** A statement with its OTA's key and name, as the admin's list reads it. */
export interface AdminStatementSummaryRecord extends SettlementRecord {
  readonly tenant_key: string;
  readonly tenant_name: string;
}

/** A statement with its OTA and the review status of the OTA's payout account, as the admin's detail reads it. */
export interface AdminStatementRecord extends AdminStatementSummaryRecord {
  /** `tenant_payout_accounts.status`, or `null` when the OTA has no payout account. */
  readonly payout_account_status: string | null;
}

/** The filters of the admin's list. */
export interface AdminStatementFilter {
  readonly status?: SettlementStatus | undefined;
  readonly periodStart?: Date | undefined;
  readonly tenantId?: string | undefined;
}

/** The sort key of one statement in the admin's list: where the next page starts. */
export interface StatementPosition {
  readonly id: string;
  readonly period_start: Date;
  readonly tenant_key: string;
  readonly currency: string;
  readonly environment: string;
}

/** A manual `adjustment` line as the review service writes it. */
export interface AdjustmentLineWrite {
  readonly id: string;
  readonly settlementId: string;
  readonly tenantId: string;
  /** Signed, `numeric(12,2)` as a decimal string. */
  readonly amount: string;
  readonly description: string;
  readonly createdByAccountId: string;
  readonly now: Date;
}

/** A `carry_forward` line of a draft: its amount and the text that names the statements it absorbs. */
export interface CarryForwardLineRecord {
  readonly amount: string;
  readonly description: string | null;
}

/** An active owner or finance member of an OTA, as the `settlement.paid` e-mail addresses them. */
export interface StatementRecipient {
  readonly account_id: string;
  readonly email: string;
  readonly full_name: string;
}

/** The columns of a statement with its OTA's key and name. */
const ADMIN_SUMMARY_COLUMNS = [
  "s.id",
  "s.tenant_id",
  "s.environment",
  "s.currency",
  "s.period_start",
  "s.period_end",
  "s.status",
  "s.gross_amount",
  "s.refunds_amount",
  "s.disputes_amount",
  "s.stripe_fees_amount",
  "s.velexis_fees_amount",
  "s.adjustments_amount",
  "s.net_amount",
  "s.fee_bps",
  "s.line_count",
  "s.carried_to_id",
  "s.generated_at",
  "s.approved_at",
  "s.approved_by_account_id",
  "s.paid_at",
  "s.paid_by_account_id",
  "s.payout_reference",
  "s.voided_at",
  "s.void_reason",
  "s.notes",
  "s.version",
  "s.created_at",
  "s.updated_at",
  "t.key as tenant_key",
  "t.name as tenant_name",
] as const;

/** The columns of a statement with its OTA and payout account status. */
const ADMIN_STATEMENT_COLUMNS = [...ADMIN_SUMMARY_COLUMNS, "p.status as payout_account_status"] as const;

@Injectable()
export class SettlementReviewRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  // ---- The admin's reads ------------------------------------------------------------------------------------------

  /** The statement `settlementId` with its OTA and payout account status, read on `db`; `undefined` without one. */
  async findForAdmin(
    settlementId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<AdminStatementRecord | undefined> {
    return db
      .selectFrom("platform.settlements as s")
      .innerJoin("platform.tenants as t", "t.id", "s.tenant_id")
      .leftJoin("platform.tenant_payout_accounts as p", "p.tenant_id", "s.tenant_id")
      .select(ADMIN_STATEMENT_COLUMNS)
      .where("s.id", "=", settlementId)
      .executeTakeFirst();
  }

  /** The statement `settlementId` with its OTA's key and name; `undefined` without one. */
  async findWithTenant(settlementId: string): Promise<AdminStatementSummaryRecord | undefined> {
    return this.db
      .selectFrom("platform.settlements as s")
      .innerJoin("platform.tenants as t", "t.id", "s.tenant_id")
      .select(ADMIN_SUMMARY_COLUMNS)
      .where("s.id", "=", settlementId)
      .executeTakeFirst();
  }

  /** The statement `settlementId` alone; `undefined` without one. */
  async findStatement(settlementId: string): Promise<SettlementRecord | undefined> {
    return this.db
      .selectFrom("platform.settlements")
      .selectAll()
      .where("id", "=", settlementId)
      .executeTakeFirst();
  }

  /** The sort key of the statement `settlementId` in the admin's list; `undefined` for an unknown statement. */
  async statementPosition(settlementId: string): Promise<StatementPosition | undefined> {
    return this.db
      .selectFrom("platform.settlements as s")
      .innerJoin("platform.tenants as t", "t.id", "s.tenant_id")
      .select(["s.id", "s.period_start", "t.key as tenant_key", "s.currency", "s.environment"])
      .where("s.id", "=", settlementId)
      .executeTakeFirst();
  }

  /**
   * At most `limit` statements of `filter`, newest period first, then by OTA key, currency, environment and id, after
   * `after` (the last statement of the previous page) when given.
   */
  async listForAdmin(
    filter: AdminStatementFilter,
    after: StatementPosition | undefined,
    limit: number,
  ): Promise<AdminStatementSummaryRecord[]> {
    let query = this.db
      .selectFrom("platform.settlements as s")
      .innerJoin("platform.tenants as t", "t.id", "s.tenant_id")
      .select(ADMIN_SUMMARY_COLUMNS);
    if (filter.status !== undefined) {
      query = query.where("s.status", "=", filter.status);
    }
    if (filter.periodStart !== undefined) {
      query = query.where("s.period_start", "=", filter.periodStart);
    }
    if (filter.tenantId !== undefined) {
      query = query.where("s.tenant_id", "=", filter.tenantId);
    }
    if (after !== undefined) {
      // The period descends and the rest ascends, so the position is two comparisons.
      query = query.where((eb) =>
        eb.or([
          eb("s.period_start", "<", after.period_start),
          eb.and([
            eb("s.period_start", "=", after.period_start),
            eb(
              eb.refTuple("t.key", "s.currency", "s.environment", "s.id"),
              ">",
              eb.tuple(after.tenant_key, after.currency, after.environment, after.id),
            ),
          ]),
        ]),
      );
    }
    return query
      .orderBy("s.period_start", "desc")
      .orderBy("t.key")
      .orderBy("s.currency")
      .orderBy("s.environment")
      .orderBy("s.id")
      .limit(limit)
      .execute();
  }

  /** True when `lineId` is a line of the statement `settlementId` (the cursor check of the lines). */
  async lineExists(settlementId: string, lineId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("platform.settlement_lines")
      .select("id")
      .where("id", "=", lineId)
      .where("settlement_id", "=", settlementId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * At most `limit` lines of the statement `settlementId` in `occurred_at` order (then id), after the line
   * `afterLineId` of the same statement when given.
   */
  async listLines(
    settlementId: string,
    afterLineId: string | undefined,
    limit: number,
  ): Promise<SettlementLineRecord[]> {
    let query = this.db
      .selectFrom("platform.settlement_lines as l")
      .selectAll("l")
      .where("l.settlement_id", "=", settlementId);
    if (afterLineId !== undefined) {
      query = query.where(
        (eb) => eb.refTuple("l.occurred_at", "l.id"),
        ">",
        (eb) =>
          eb
            .selectFrom("platform.settlement_lines as c")
            .select(["c.occurred_at", "c.id"])
            .where("c.id", "=", afterLineId)
            .$asTuple("occurred_at", "id"),
      );
    }
    return query.orderBy("l.occurred_at").orderBy("l.id").limit(limit).execute();
  }

  /** Every line of the statement `settlementId` in `occurred_at` order (then id), in one query: the CSV files. */
  async allLines(settlementId: string): Promise<SettlementLineRecord[]> {
    return this.db
      .selectFrom("platform.settlement_lines")
      .selectAll()
      .where("settlement_id", "=", settlementId)
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();
  }

  // ---- The portal's reads -----------------------------------------------------------------------------------------

  /** The statements of `tenantId` its members see, newest period first, then by currency, environment and id. */
  async listForTenant(tenantId: string): Promise<SettlementRecord[]> {
    return this.db
      .selectFrom("platform.settlements")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("status", "in", [...VISIBLE_TO_TENANT])
      .orderBy("period_start", "desc")
      .orderBy("currency")
      .orderBy("environment")
      .orderBy("id")
      .execute();
  }

  /** The statement `settlementId` of `tenantId` when its members see it; `undefined` otherwise. */
  async findForTenant(tenantId: string, settlementId: string): Promise<SettlementRecord | undefined> {
    return this.db
      .selectFrom("platform.settlements")
      .selectAll()
      .where("id", "=", settlementId)
      .where("tenant_id", "=", tenantId)
      .where("status", "in", [...VISIBLE_TO_TENANT])
      .executeTakeFirst();
  }

  // ---- The review's writes (in the caller's transaction) ----------------------------------------------------------

  /** The statement `settlementId`, locked for the rest of `trx` (`FOR UPDATE`); `undefined` without one. */
  async lockStatementById(
    trx: PlatformTransaction,
    settlementId: string,
  ): Promise<SettlementRecord | undefined> {
    return trx
      .selectFrom("platform.settlements")
      .selectAll()
      .where("id", "=", settlementId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The type and amounts of every line of the statement `settlementId`, for its totals. */
  async lineAmounts(trx: PlatformTransaction, settlementId: string): Promise<SettlementLineAmounts[]> {
    return trx
      .selectFrom("platform.settlement_lines")
      .select(["line_type", "amount", "stripe_fee"])
      .where("settlement_id", "=", settlementId)
      .execute();
  }

  /** The `carry_forward` lines of the statement `settlementId` (the generator writes at most one). */
  async carryForwardLines(trx: PlatformTransaction, settlementId: string): Promise<CarryForwardLineRecord[]> {
    return trx
      .selectFrom("platform.settlement_lines")
      .select(["amount", "description"])
      .where("settlement_id", "=", settlementId)
      .where("line_type", "=", "carry_forward")
      .orderBy("id")
      .execute();
  }

  /** Inserts a manual `adjustment` line (no Stripe reference, no Stripe fee). */
  async insertAdjustment(trx: PlatformTransaction, line: AdjustmentLineWrite): Promise<void> {
    await trx
      .insertInto("platform.settlement_lines")
      .values({
        id: line.id,
        settlement_id: line.settlementId,
        tenant_id: line.tenantId,
        line_type: "adjustment",
        balance_transaction_id: null,
        source_id: null,
        payment_intent_id: null,
        velexis_payment_id: null,
        checkout_id: null,
        occurred_at: line.now,
        amount: line.amount,
        stripe_fee: "0.00",
        original_amount: null,
        original_currency: null,
        description: line.description,
        created_by_account_id: line.createdByAccountId,
        created_at: line.now,
      })
      .execute();
  }

  /** Stores the recomputed totals of the draft `settlementId` (locked) with `version + 1`; `false` if not a draft. */
  async writeDraftTotals(
    trx: PlatformTransaction,
    settlementId: string,
    totals: SettlementTotals,
    now: Date,
  ): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.settlements")
      .set((eb) => ({
        gross_amount: totals.gross_amount,
        refunds_amount: totals.refunds_amount,
        disputes_amount: totals.disputes_amount,
        stripe_fees_amount: totals.stripe_fees_amount,
        velexis_fees_amount: totals.velexis_fees_amount,
        adjustments_amount: totals.adjustments_amount,
        net_amount: totals.net_amount,
        line_count: totals.line_count,
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", settlementId)
      .where("status", "=", "draft" satisfies SettlementStatus)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  /**
   * Of `ids`, the `carried_forward` statements whose balance no statement has absorbed yet (`carried_to_id IS NULL`),
   * locked for the rest of `trx` (`FOR UPDATE`): a row another transaction absorbs first is re-read after its commit
   * and left out.
   */
  async lockUnabsorbed(trx: PlatformTransaction, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await trx
      .selectFrom("platform.settlements")
      .select("id")
      .where("id", "in", [...ids])
      .where("status", "=", "carried_forward" satisfies SettlementStatus)
      .where("carried_to_id", "is", null)
      .orderBy("id")
      .forUpdate()
      .execute();
    return rows.map((row) => row.id);
  }

  /** Approves the draft `settlementId` (locked) as `status`, with `version + 1`; `false` if it is not a draft. */
  async approveDraft(
    trx: PlatformTransaction,
    approval: {
      readonly settlementId: string;
      readonly status: Extract<SettlementStatus, "approved" | "carried_forward">;
      readonly approvedByAccountId: string;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.settlements")
      .set((eb) => ({
        status: approval.status,
        approved_at: approval.now,
        approved_by_account_id: approval.approvedByAccountId,
        version: eb("version", "+", 1),
        updated_at: approval.now,
      }))
      .where("id", "=", approval.settlementId)
      .where("status", "=", "draft" satisfies SettlementStatus)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  /**
   * Sets `carried_to_id = absorbingId` on those of `ids` that are `carried_forward` and not absorbed yet; returns how
   * many rows it changed.
   */
  async absorb(
    trx: PlatformTransaction,
    ids: readonly string[],
    absorbingId: string,
    now: Date,
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const updated = await trx
      .updateTable("platform.settlements")
      .set({ carried_to_id: absorbingId, updated_at: now })
      .where("id", "in", [...ids])
      .where("status", "=", "carried_forward" satisfies SettlementStatus)
      .where("carried_to_id", "is", null)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows);
  }

  /** Records the payment of the approved statement `settlementId` (locked), with `version + 1`; `false` otherwise. */
  async markPaid(
    trx: PlatformTransaction,
    payment: {
      readonly settlementId: string;
      readonly paidAt: Date;
      readonly payoutReference: string;
      readonly paidByAccountId: string;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const updated = await trx
      .updateTable("platform.settlements")
      .set((eb) => ({
        status: "paid" satisfies SettlementStatus,
        paid_at: payment.paidAt,
        payout_reference: payment.payoutReference,
        paid_by_account_id: payment.paidByAccountId,
        version: eb("version", "+", 1),
        updated_at: payment.now,
      }))
      .where("id", "=", payment.settlementId)
      .where("status", "=", "approved" satisfies SettlementStatus)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  /**
   * Voids the draft `settlementId` (locked): its lines are deleted, its totals kept for the record, `line_count` 0,
   * `version + 1`. Returns how many lines it deleted, or `undefined` when the statement is not a draft.
   */
  async voidDraft(
    trx: PlatformTransaction,
    voiding: { readonly settlementId: string; readonly reason: string; readonly now: Date },
  ): Promise<number | undefined> {
    const updated = await trx
      .updateTable("platform.settlements")
      .set((eb) => ({
        status: "void" satisfies SettlementStatus,
        voided_at: voiding.now,
        void_reason: voiding.reason,
        line_count: 0,
        version: eb("version", "+", 1),
        updated_at: voiding.now,
      }))
      .where("id", "=", voiding.settlementId)
      .where("status", "=", "draft" satisfies SettlementStatus)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      return undefined;
    }
    const deleted = await trx
      .deleteFrom("platform.settlement_lines")
      .where("settlement_id", "=", voiding.settlementId)
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }

  // ---- What the review reads of other tables -----------------------------------------------------------------------

  /**
   * The review status of `tenantId`'s payout account, read `FOR SHARE` in `trx` (an owner's change waits for the end
   * of the approval or payment that read it); `undefined` without an account.
   */
  async payoutAccountStatusForShare(trx: PlatformTransaction, tenantId: string): Promise<string | undefined> {
    const row = await trx
      .selectFrom("platform.tenant_payout_accounts")
      .select("status")
      .where("tenant_id", "=", tenantId)
      .forShare()
      .executeTakeFirst();
    return row?.status;
  }

  /**
   * The active owners and finance members of `tenantId`, oldest membership first, with their e-mail address and name
   * (read only), in `trx`: the recipients of `settlement.paid`. A disabled or deleted account gets no e-mail.
   */
  async activeOwnersAndFinance(trx: PlatformTransaction, tenantId: string): Promise<StatementRecipient[]> {
    return trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(["m.account_id", "a.email", "a.full_name"])
      .where("m.tenant_id", "=", tenantId)
      .where("m.role", "in", ["owner", "finance"])
      .where("m.status", "=", "active")
      .where("a.status", "not in", ["disabled", "deleted"])
      .where("a.deleted_at", "is", null)
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
  }
}
