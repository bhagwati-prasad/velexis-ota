// The `settlements` and `settlement_lines` repository (PBE-059; platform/docs/architecture.md §2.1: SettlementsModule
// owns both tables; PADR-0003, flows/stripe-payments-account.md §F, platform/docs/data-model-migration-0002-part2.md).
// Kysely on the process's `PLATFORM_DB`, schema-qualified tables (ADR-0005).
//
// The generator (settlement-generator.ts) rebuilds one draft per tenant, environment, balance currency and month in one
// transaction: `lockStatement` takes the statement of that key that is not `void` (`FOR UPDATE`), `insertDraft` creates
// it when there is none (`ON CONFLICT … DO NOTHING` on the partial unique index `settlements_period_uq`, so two runs
// at once make one row), `deleteLines` empties a draft, `insertLines` writes its lines with `ON CONFLICT
// (balance_transaction_id) DO NOTHING` (a balance transaction already on another statement, an approved or paid one
// above all, is skipped: PADR-0003 item 8), `unabsorbedCarryForwards` reads the earlier `carried_forward` balances
// the draft absorbs (those no earlier open draft absorbs already: the earliest later open draft absorbs a balance,
// PADR-0003 item 7 and its note of 2026-10-30), and `writeTotals` stores what settlement-formula.ts computed from the
// lines. `carryForwardKeys` finds the tenants and currencies whose only open item is such a balance, so the month gets
// a draft for them too (FIX-W36-PLATFORM). Nothing here changes a statement that is not a draft.
//
// It also reads, read only, what a statement needs from other tables: the tenant and the settlement fee of its plan
// (`platform.tenants`, `platform.plans`), and the exponent of each currency (`reference.currencies`, architecture
// §2.1), as plans.repository.ts reads the reference data directly.
import { Inject, Injectable } from "@nestjs/common";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import type { SettlementLineAmounts, SettlementLineType, SettlementTotals } from "./settlement-formula";

/** A `platform.settlements` row. */
export type SettlementRecord = Selectable<PlatformDatabase["platform.settlements"]>;

/** The states of `settlements.status`. */
export type SettlementStatus = "draft" | "approved" | "paid" | "carried_forward" | "void";

/** The environments of `settlements.environment`. */
export type SettlementEnvironment = "test" | "live";

/** What names one statement: at most one that is not `void` exists per key (`settlements_period_uq`). */
export interface StatementKey {
  readonly tenantId: string;
  readonly environment: SettlementEnvironment;
  /** The balance currency, upper case. */
  readonly currency: string;
  /** The first instant of the month (UTC). */
  readonly periodStart: Date;
}

/** A new, empty draft. */
export interface DraftInsert extends StatementKey {
  readonly id: string;
  /** The first instant of the next month. */
  readonly periodEnd: Date;
  readonly feeBps: number;
  readonly now: Date;
}

/** One line as the generator writes it (the id and the statement come with `insertLines`). */
export interface SettlementLineWrite {
  readonly line_type: SettlementLineType;
  /** `txn_…`; `null` for an adjustment or a carry-forward (`settlement_lines_txn_ck`). */
  readonly balance_transaction_id: string | null;
  readonly source_id: string | null;
  readonly payment_intent_id: string | null;
  readonly velexis_payment_id: string | null;
  readonly checkout_id: string | null;
  readonly occurred_at: Date;
  /** Signed, in the statement currency: `numeric(12,2)` as a decimal string. */
  readonly amount: string;
  readonly stripe_fee: string;
  readonly original_amount: string | null;
  readonly original_currency: string | null;
  readonly description: string;
}

/** An earlier `carried_forward` statement not absorbed yet. */
export interface CarriedForwardStatement {
  readonly id: string;
  readonly period_start: Date;
  readonly net_amount: string;
}

/** The totals and bookkeeping of a rebuilt draft. */
export interface DraftTotalsWrite extends SettlementTotals {
  readonly fee_bps: number;
  readonly version: number;
  readonly now: Date;
}

/** The most rows one INSERT of lines carries (13 parameters each, far below PostgreSQL's 65 535). */
export const LINE_INSERT_BATCH = 1000;

@Injectable()
export class SettlementsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** True when the tenant `tenantId` exists (any status). */
  async tenantExists(tenantId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("platform.tenants")
      .select("id")
      .where("id", "=", tenantId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The settlement fee (`plans.settlement_fee_bps` of its plan) of each of `tenantIds` that exists, by tenant id. */
  async feeBpsOfTenants(tenantIds: readonly string[]): Promise<Map<string, number>> {
    if (tenantIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom("platform.tenants as t")
      .innerJoin("platform.plans as p", "p.code", "t.plan_code")
      .select(["t.id", "p.settlement_fee_bps"])
      .where("t.id", "in", tenantIds)
      .execute();
    return new Map(rows.map((row) => [row.id, row.settlement_fee_bps]));
  }

  /** The exponent (`minor_units`) of each of `codes` that `reference.currencies` knows, by code. */
  async minorUnits(codes: readonly string[]): Promise<Map<string, number>> {
    if (codes.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom("reference.currencies")
      .select(["code", "minor_units"])
      .where("code", "in", codes)
      .execute();
    return new Map(rows.map((row) => [row.code, row.minor_units]));
  }

  /** The tenant and currency of every draft of the month in `environment` (of `tenantId` only, when given). */
  async draftKeys(
    environment: SettlementEnvironment,
    periodStart: Date,
    tenantId?: string,
  ): Promise<Array<{ readonly tenant_id: string; readonly currency: string }>> {
    let query = this.db
      .selectFrom("platform.settlements")
      .select(["tenant_id", "currency"])
      .where("environment", "=", environment)
      .where("period_start", "=", periodStart)
      .where("status", "=", "draft" satisfies SettlementStatus);
    if (tenantId !== undefined) {
      query = query.where("tenant_id", "=", tenantId);
    }
    return query.orderBy("tenant_id").orderBy("currency").execute();
  }

  /**
   * The tenant and currency of every carried-forward balance in `environment` (of `tenantId` only, when given) that
   * the draft of the month starting at `periodStart` would absorb (`unabsorbedCarryForwards`: earlier, not absorbed,
   * no open draft between) while that month has no statement yet that is not `void`, and whose balances sum to
   * something other than zero: a tenant whose only open item is such a balance gets a draft holding the
   * `carry_forward` line (FIX-W36-PLATFORM, lead decision (2g) of 2026-10-30). Sorted by tenant and currency.
   */
  async carryForwardKeys(
    environment: SettlementEnvironment,
    periodStart: Date,
    tenantId?: string,
  ): Promise<Array<{ readonly tenant_id: string; readonly currency: string }>> {
    let query = this.db
      .selectFrom("platform.settlements as carried")
      .select(["carried.tenant_id", "carried.currency"])
      .where("carried.environment", "=", environment)
      .where("carried.status", "=", "carried_forward" satisfies SettlementStatus)
      .where("carried.carried_to_id", "is", null)
      .where("carried.period_start", "<", periodStart)
      .where(({ exists, not, selectFrom }) =>
        not(
          exists(
            selectFrom("platform.settlements as open_draft")
              .select("open_draft.id")
              .whereRef("open_draft.tenant_id", "=", "carried.tenant_id")
              .whereRef("open_draft.environment", "=", "carried.environment")
              .whereRef("open_draft.currency", "=", "carried.currency")
              .where("open_draft.status", "=", "draft" satisfies SettlementStatus)
              .whereRef("open_draft.period_start", ">", "carried.period_start")
              .where("open_draft.period_start", "<", periodStart),
          ),
        ),
      )
      .where(({ exists, not, selectFrom }) =>
        not(
          exists(
            selectFrom("platform.settlements as this_month")
              .select("this_month.id")
              .whereRef("this_month.tenant_id", "=", "carried.tenant_id")
              .whereRef("this_month.environment", "=", "carried.environment")
              .whereRef("this_month.currency", "=", "carried.currency")
              .where("this_month.period_start", "=", periodStart)
              .where("this_month.status", "<>", "void" satisfies SettlementStatus),
          ),
        ),
      );
    if (tenantId !== undefined) {
      query = query.where("carried.tenant_id", "=", tenantId);
    }
    return query
      .groupBy(["carried.tenant_id", "carried.currency"])
      .having((eb) => eb(eb.fn.sum("carried.net_amount"), "<>", 0))
      .orderBy("carried.tenant_id")
      .orderBy("carried.currency")
      .execute();
  }

  /** The statement of `key` that is not `void`, locked for the rest of `trx` (`FOR UPDATE`); `undefined` without one. */
  async lockStatement(trx: PlatformTransaction, key: StatementKey): Promise<SettlementRecord | undefined> {
    return trx
      .selectFrom("platform.settlements")
      .selectAll()
      .where("tenant_id", "=", key.tenantId)
      .where("environment", "=", key.environment)
      .where("currency", "=", key.currency)
      .where("period_start", "=", key.periodStart)
      .where("status", "<>", "void" satisfies SettlementStatus)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Inserts an empty draft (version 1, every amount 0) unless a statement of its key that is not `void` exists, in
   * which case nothing happens; read the statement with `lockStatement` afterwards either way. True when this call
   * inserted it.
   */
  async insertDraft(trx: PlatformTransaction, draft: DraftInsert): Promise<boolean> {
    const inserted = await trx
      .insertInto("platform.settlements")
      .values({
        id: draft.id,
        tenant_id: draft.tenantId,
        environment: draft.environment,
        currency: draft.currency,
        period_start: draft.periodStart,
        period_end: draft.periodEnd,
        status: "draft" satisfies SettlementStatus,
        fee_bps: draft.feeBps,
        generated_at: draft.now,
        created_at: draft.now,
        updated_at: draft.now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["tenant_id", "environment", "currency", "period_start"])
          .where("status", "<>", "void" satisfies SettlementStatus)
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** Deletes every line of the statement `settlementId` (a draft being rebuilt); returns how many. */
  async deleteLines(trx: PlatformTransaction, settlementId: string): Promise<number> {
    const result = await trx
      .deleteFrom("platform.settlement_lines")
      .where("settlement_id", "=", settlementId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Inserts `lines` on `statement`, each with an id from `newId`, skipping a balance transaction that is already on a
   * line of any statement (`ON CONFLICT (balance_transaction_id) DO NOTHING`). Returns the amounts of the lines it
   * inserted, for the totals.
   */
  async insertLines(
    trx: PlatformTransaction,
    statement: Pick<SettlementRecord, "id" | "tenant_id">,
    lines: readonly SettlementLineWrite[],
    newId: () => string,
  ): Promise<SettlementLineAmounts[]> {
    const inserted: SettlementLineAmounts[] = [];
    for (let start = 0; start < lines.length; start += LINE_INSERT_BATCH) {
      const rows = lines.slice(start, start + LINE_INSERT_BATCH).map((line) => ({
        ...line,
        id: newId(),
        settlement_id: statement.id,
        tenant_id: statement.tenant_id,
      }));
      inserted.push(
        ...(await trx
          .insertInto("platform.settlement_lines")
          .values(rows)
          .onConflict((conflict) => conflict.column("balance_transaction_id").doNothing())
          .returning(["line_type", "amount", "stripe_fee"])
          .execute()),
      );
    }
    return inserted;
  }

  /**
   * The `carried_forward` statements of the key's tenant, environment and currency from before its month whose balance
   * no statement has absorbed yet (`carried_to_id IS NULL`, set when the absorbing statement is approved), oldest
   * first, that the draft of the key absorbs: those with no other draft of the same tenant, environment and currency
   * between their month and the key's. The next month's draft absorbs a balance (PADR-0003 item 7, the contract of
   * `adminApproveSettlement`), so while an earlier draft is open a later one never counts the same balance a second
   * time; once that draft is voided, the next draft takes the balance over.
   */
  async unabsorbedCarryForwards(
    trx: PlatformTransaction,
    key: StatementKey,
  ): Promise<CarriedForwardStatement[]> {
    return trx
      .selectFrom("platform.settlements as carried")
      .select(["carried.id", "carried.period_start", "carried.net_amount"])
      .where("carried.tenant_id", "=", key.tenantId)
      .where("carried.environment", "=", key.environment)
      .where("carried.currency", "=", key.currency)
      .where("carried.status", "=", "carried_forward" satisfies SettlementStatus)
      .where("carried.carried_to_id", "is", null)
      .where("carried.period_start", "<", key.periodStart)
      .where(({ exists, not, selectFrom }) =>
        not(
          exists(
            selectFrom("platform.settlements as open_draft")
              .select("open_draft.id")
              .whereRef("open_draft.tenant_id", "=", "carried.tenant_id")
              .whereRef("open_draft.environment", "=", "carried.environment")
              .whereRef("open_draft.currency", "=", "carried.currency")
              .where("open_draft.status", "=", "draft" satisfies SettlementStatus)
              .whereRef("open_draft.period_start", ">", "carried.period_start")
              .where("open_draft.period_start", "<", key.periodStart),
          ),
        ),
      )
      .orderBy("carried.period_start")
      .orderBy("carried.id")
      .execute();
  }

  /** Stores the totals of the draft `settlementId` (locked by `lockStatement`) and returns the row. */
  async writeTotals(
    trx: PlatformTransaction,
    settlementId: string,
    totals: DraftTotalsWrite,
  ): Promise<SettlementRecord> {
    return trx
      .updateTable("platform.settlements")
      .set({
        gross_amount: totals.gross_amount,
        refunds_amount: totals.refunds_amount,
        disputes_amount: totals.disputes_amount,
        stripe_fees_amount: totals.stripe_fees_amount,
        velexis_fees_amount: totals.velexis_fees_amount,
        adjustments_amount: totals.adjustments_amount,
        net_amount: totals.net_amount,
        line_count: totals.line_count,
        fee_bps: totals.fee_bps,
        version: totals.version,
        generated_at: totals.now,
        updated_at: totals.now,
      })
      .where("id", "=", settlementId)
      .where("status", "=", "draft" satisfies SettlementStatus)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
