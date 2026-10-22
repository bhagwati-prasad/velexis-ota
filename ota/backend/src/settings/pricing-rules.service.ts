// console.settings.markupRules.* and console.settings.feeRules.* (consoleListMarkupRules, consoleCreateMarkupRule,
// consoleGetMarkupRule, consoleUpdateMarkupRule, consoleDeleteMarkupRule and the five fee-rule operations;
// `settings:read` / `settings:write`; OBE-069, api-changes part 2 §2.1 and §2.2, OADR-0005 points 3, 6 and 8): the
// OTA's `markup_rules` and `fee_rules`, one set per tenant shared by the test and live environments, as staff edit them
// (pricing-rules.mapper.ts). The pricing engine reads them from the table in each pricing transaction
// (rules.repository.ts `loadActiveRules`), so a change applies to the next search (markup) or the next pricing (fees),
// and offers, priced offers, checkouts and bookings stored before keep their prices and lines (OADR-0002 point 5,
// OADR-0005 point 8). A search identical to one of the last 30 seconds joins it (OADR-0002 point 2) and so answers that
// search's stored offers.
//
//   list    the page in evaluation order (`priority`, then `id`) after the cursor, `active` true, false or absent
//   get     the rule; `404 NOT_FOUND` for an id of no rule of the tenant
//   create  the input with its defaults, checked (`400 VALIDATION_FAILED` with the field errors of the mapper), is
//           inserted with a new id and `created_by_staff_id` (the staff member, null for a key-only call); answered
//           `201` with `Location`, `ETag` and the warnings of the saved rule. The `Idempotency-Key` is the idempotency
//           interceptor's.
//   update  in one transaction: the row is read `FOR NO KEY UPDATE` (`404`), its version compared with `If-Match`
//           (`412 PRECONDITION_FAILED`), a `scope` sent for the default markup rule must match every offer
//           (`409 CONFLICT`, `details.reason = "default_rule"`; it is stored `{}`), the stored rule with the sent fields
//           replacing theirs is checked as a create is (`400`), and every column is written at `version + 1` (`scope`
//           only when sent, or `{}` for the default rule: pricing-rules.mapper.ts); answered with the new `ETag` and
//           the warnings of the saved rule.
//   delete  in one transaction: the row is read `FOR UPDATE` (`404`), `If-Match` (`412`), the default markup rule is
//           refused (`409 CONFLICT`, `default_rule`), and the row is deleted (the history keeps its amounts,
//           rules.repository.ts); answered `204`.
//
// Every change writes its `staff_actions` row in its own transaction (`settings.markupRules.create`, …, target
// `markup_rule` or `fee_rule` and the id) with the rule before and after as the document shows it (null before a
// create and after a delete), through the shared redactor; a refused change is the audit interceptor's `failed` row.
// Reads are not audited (OADR-0011 point 8 as decided on 2026-10-21). The warnings read the storefront's default
// currency (`storefront_settings`) in the same transaction.
import { Injectable } from "@nestjs/common";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { AppError, type FieldError } from "@velexis/errors";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { IdGenerator } from "../common/ids";
import { consoleAction, StaffActionsWriter } from "../console/staff-actions.writer";
import {
  RulesRepository,
  type FeeRuleEditRow,
  type MarkupRuleEditRow,
  type RuleLock,
} from "../pricing/rules.repository";
import { pageLimit } from "../reference/reference.mapper";
import { StorefrontRepository } from "../storefront/storefront.repository";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  consoleFeeRuleOf,
  consoleMarkupRuleOf,
  decodeRuleCursor,
  encodeRuleCursor,
  feeChangesOf,
  feeColumnsOf,
  feeRuleProblems,
  feeRuleWarnings,
  feeStateOfInput,
  feeStateOfRule,
  isCatchAllScope,
  markupChangesOf,
  markupColumnsOf,
  markupRuleProblems,
  markupRuleWarnings,
  markupStateOfInput,
  markupStateOfRule,
  mergeRuleUpdate,
  type ConsoleFeeRule,
  type ConsoleMarkupRule,
  type FeeRuleInput,
  type FeeRulePage,
  type FeeRuleState,
  type FeeRuleUpdate,
  type MarkupRuleInput,
  type MarkupRulePage,
  type MarkupRuleState,
  type MarkupRuleUpdate,
  type SettingsWarning,
} from "./pricing-rules.mapper";

/** The query of a list operation as validated. */
export interface RuleListParams {
  readonly active?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** A rule as create and update answer it: the saved rule and its warnings. */
export type SavedMarkupRule = ConsoleMarkupRule & { readonly warnings: SettingsWarning[] };
export type SavedFeeRule = ConsoleFeeRule & { readonly warnings: SettingsWarning[] };

/** What the generic steps need of a rule kind: its rows, its document shape, its checks and its operations. */
interface RuleKind<Row extends { id: string; priority: number; version: number }, View, State> {
  readonly kind: "markup" | "fee";
  readonly targetType: "markup_rule" | "fee_rule";
  readonly noun: string;
  readonly operations: {
    readonly create: OtaOperationId;
    readonly update: OtaOperationId;
    readonly delete: OtaOperationId;
  };
  view(row: Row): View;
  stateOf(view: View): State;
  problems(state: State): FieldError[];
  warnings(state: State, defaultCurrency: string | null): SettingsWarning[];
  list(
    trx: TenantTransaction,
    query: {
      active: boolean | undefined;
      after: { priority: number; id: string } | undefined;
      limit: number;
    },
  ): Promise<Row[]>;
  byId(trx: TenantTransaction, id: string, lock: RuleLock): Promise<Row | undefined>;
  insert(trx: TenantTransaction, id: string, state: State, staffId: string | null): Promise<Row>;
  /** Writes `state` (the stored rule with `update`'s fields) at the row's version + 1; undefined when it moved. */
  update(trx: TenantTransaction, row: Row, state: State, update: Partial<State>): Promise<Row | undefined>;
  delete(trx: TenantTransaction, row: Row): Promise<boolean>;
  /** A refusal of `update` (or of a delete, without one) that the rule's state forbids, else undefined. */
  conflict(row: Row, update: Partial<State> | undefined): AppError | undefined;
}

/** `400 VALIDATION_FAILED` with the problems of a rule. */
function invalid(problems: readonly FieldError[]): AppError {
  return new AppError("VALIDATION_FAILED", { fieldErrors: [...problems] });
}

/** `409 CONFLICT` for a change the default markup rule does not allow. */
function defaultRuleConflict(): AppError {
  return new AppError("CONFLICT", {
    message: "The default markup rule cannot be deleted, and its scope stays empty.",
    details: { reason: "default_rule" },
  });
}

@Injectable()
export class PricingRulesService {
  private readonly markup: RuleKind<MarkupRuleEditRow, ConsoleMarkupRule, MarkupRuleState>;
  private readonly fee: RuleKind<FeeRuleEditRow, ConsoleFeeRule, FeeRuleState>;

  constructor(
    private readonly tx: TenantTx,
    private readonly rules: RulesRepository,
    private readonly storefront: StorefrontRepository,
    private readonly writer: StaffActionsWriter,
    private readonly ids: IdGenerator,
  ) {
    this.markup = {
      kind: "markup",
      targetType: "markup_rule",
      noun: "markup rule",
      operations: {
        create: "consoleCreateMarkupRule",
        update: "consoleUpdateMarkupRule",
        delete: "consoleDeleteMarkupRule",
      },
      view: consoleMarkupRuleOf,
      stateOf: markupStateOfRule,
      problems: markupRuleProblems,
      warnings: markupRuleWarnings,
      list: (trx, query) => rules.listMarkupRules(trx, query),
      byId: (trx, id, lock) => rules.markupRuleById(trx, id, lock),
      insert: (trx, id, state, staffId) =>
        rules.insertMarkupRule(trx, { id, created_by_staff_id: staffId, ...markupColumnsOf(state, false) }),
      update: (trx, row, state, update) =>
        rules.updateMarkupRule(trx, row.id, row.version, markupChangesOf(state, row.is_default, update)),
      delete: (trx, row) => rules.deleteMarkupRule(trx, row.id, row.version),
      conflict: (row, update) => {
        if (!row.is_default) {
          return undefined;
        }
        // A delete (no update), or a scope that narrows the catch-all rule.
        return update === undefined || (update.scope !== undefined && !isCatchAllScope(update.scope))
          ? defaultRuleConflict()
          : undefined;
      },
    };
    this.fee = {
      kind: "fee",
      targetType: "fee_rule",
      noun: "fee rule",
      operations: {
        create: "consoleCreateFeeRule",
        update: "consoleUpdateFeeRule",
        delete: "consoleDeleteFeeRule",
      },
      view: consoleFeeRuleOf,
      stateOf: feeStateOfRule,
      problems: feeRuleProblems,
      warnings: feeRuleWarnings,
      list: (trx, query) => rules.listFeeRules(trx, query),
      byId: (trx, id, lock) => rules.feeRuleById(trx, id, lock),
      insert: (trx, id, state, staffId) =>
        rules.insertFeeRule(trx, { id, created_by_staff_id: staffId, ...feeColumnsOf(state) }),
      update: (trx, row, state, update) =>
        rules.updateFeeRule(trx, row.id, row.version, feeChangesOf(state, update)),
      delete: (trx, row) => rules.deleteFeeRule(trx, row.id, row.version),
      conflict: () => undefined,
    };
  }

  // ---- Markup rules ------------------------------------------------------------------------------------------------

  /** console.settings.markupRules.list. */
  async listMarkupRules(params: RuleListParams): Promise<MarkupRulePage> {
    return await this.list(this.markup, params);
  }

  /** console.settings.markupRules.get. */
  async getMarkupRule(id: string): Promise<ConsoleMarkupRule> {
    return await this.get(this.markup, id);
  }

  /** console.settings.markupRules.create. */
  async createMarkupRule(input: MarkupRuleInput): Promise<SavedMarkupRule> {
    return await this.create(this.markup, markupStateOfInput(input));
  }

  /** console.settings.markupRules.update with the request's `If-Match`. */
  async updateMarkupRule(id: string, update: MarkupRuleUpdate, ifMatch: string): Promise<SavedMarkupRule> {
    return await this.update(this.markup, id, update, ifMatch);
  }

  /** console.settings.markupRules.delete with the request's `If-Match`. */
  async deleteMarkupRule(id: string, ifMatch: string): Promise<void> {
    await this.delete(this.markup, id, ifMatch);
  }

  // ---- Fee rules ---------------------------------------------------------------------------------------------------

  /** console.settings.feeRules.list. */
  async listFeeRules(params: RuleListParams): Promise<FeeRulePage> {
    return await this.list(this.fee, params);
  }

  /** console.settings.feeRules.get. */
  async getFeeRule(id: string): Promise<ConsoleFeeRule> {
    return await this.get(this.fee, id);
  }

  /** console.settings.feeRules.create. */
  async createFeeRule(input: FeeRuleInput): Promise<SavedFeeRule> {
    return await this.create(this.fee, feeStateOfInput(input));
  }

  /** console.settings.feeRules.update with the request's `If-Match`. */
  async updateFeeRule(id: string, update: FeeRuleUpdate, ifMatch: string): Promise<SavedFeeRule> {
    return await this.update(this.fee, id, update, ifMatch);
  }

  /** console.settings.feeRules.delete with the request's `If-Match`. */
  async deleteFeeRule(id: string, ifMatch: string): Promise<void> {
    await this.delete(this.fee, id, ifMatch);
  }

  // ---- The steps both kinds share (see the file header) ----------------------------------------------------------

  private async list<Row extends { id: string; priority: number; version: number }, View, State>(
    kind: RuleKind<Row, View, State>,
    params: RuleListParams,
  ): Promise<{ data: View[]; page: { nextCursor: string | null; limit: number } }> {
    const limit = pageLimit(params.limit);
    const { active } = params;
    const after =
      params.cursor === undefined ? undefined : decodeRuleCursor(kind.kind, active, params.cursor);
    const rows = await this.tx.run((trx) => kind.list(trx, { active, after, limit: limit + 1 }));
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => kind.view(row)),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeRuleCursor(active, last) : null,
        limit,
      },
    };
  }

  private async get<Row extends { id: string; priority: number; version: number }, View, State>(
    kind: RuleKind<Row, View, State>,
    id: string,
  ): Promise<View> {
    const row = await this.tx.run((trx) => kind.byId(trx, id, "none"));
    if (row === undefined) {
      throw this.notFound(kind);
    }
    return kind.view(row);
  }

  private async create<Row extends { id: string; priority: number; version: number }, View, State>(
    kind: RuleKind<Row, View, State>,
    state: State,
  ): Promise<View & { readonly warnings: SettingsWarning[] }> {
    const problems = kind.problems(state);
    if (problems.length > 0) {
      throw invalid(problems);
    }
    const actor = this.writer.requestActor();
    const staffId = actor?.type === "staff" ? actor.staffId : null;
    return await this.tx.run(async (trx) => {
      const row = await kind.insert(
        trx,
        this.ids.newId(kind.kind === "markup" ? "mkr" : "fee"),
        state,
        staffId,
      );
      const view = kind.view(row);
      await this.writer.record(trx, {
        action: consoleAction(kind.operations.create),
        targetType: kind.targetType,
        targetId: row.id,
        before: null,
        after: view,
      });
      return { ...view, warnings: kind.warnings(state, await this.defaultCurrency(trx)) };
    });
  }

  private async update<
    Row extends { id: string; priority: number; version: number },
    View,
    State extends object,
  >(
    kind: RuleKind<Row, View, State>,
    id: string,
    update: Partial<State>,
    ifMatch: string,
  ): Promise<View & { readonly warnings: SettingsWarning[] }> {
    return await this.tx.run(async (trx) => {
      const row = await kind.byId(trx, id, "update");
      if (row === undefined) {
        throw this.notFound(kind);
      }
      if (!ifMatchSatisfied(ifMatch, row.version)) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const conflict = kind.conflict(row, update);
      if (conflict !== undefined) {
        throw conflict;
      }
      const before = kind.view(row);
      const state = mergeRuleUpdate(kind.stateOf(before), update);
      const problems = kind.problems(state);
      if (problems.length > 0) {
        throw invalid(problems);
      }
      const saved = await kind.update(trx, row, state, update);
      if (saved === undefined) {
        // The row is locked since it was read: only a writer outside this service could have moved it.
        throw new AppError("PRECONDITION_FAILED");
      }
      const after = kind.view(saved);
      await this.writer.record(trx, {
        action: consoleAction(kind.operations.update),
        targetType: kind.targetType,
        targetId: row.id,
        before,
        after,
      });
      return { ...after, warnings: kind.warnings(state, await this.defaultCurrency(trx)) };
    });
  }

  private async delete<Row extends { id: string; priority: number; version: number }, View, State>(
    kind: RuleKind<Row, View, State>,
    id: string,
    ifMatch: string,
  ): Promise<void> {
    await this.tx.run(async (trx) => {
      const row = await kind.byId(trx, id, "delete");
      if (row === undefined) {
        throw this.notFound(kind);
      }
      if (!ifMatchSatisfied(ifMatch, row.version)) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const conflict = kind.conflict(row, undefined);
      if (conflict !== undefined) {
        throw conflict;
      }
      if (!(await kind.delete(trx, row))) {
        throw new AppError("PRECONDITION_FAILED");
      }
      await this.writer.record(trx, {
        action: consoleAction(kind.operations.delete),
        targetType: kind.targetType,
        targetId: row.id,
        before: kind.view(row),
        after: null,
      });
    });
  }

  /** The storefront's default currency, which the currency warning compares with; null without a settings row. */
  private async defaultCurrency(trx: TenantTransaction): Promise<string | null> {
    return (await this.storefront.settings(trx))?.defaultCurrency.trim().toUpperCase() ?? null;
  }

  private notFound(kind: { readonly noun: string }): AppError {
    return new AppError("NOT_FOUND", { message: `The ${kind.noun} does not exist.` });
  }
}
