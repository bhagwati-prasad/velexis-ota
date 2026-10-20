// The platform admin's plans (platform/docs/api-inventory-admin.md §4, flows/subscription-billing.md §A,
// flows/platform-admin-operations.md §D; PADR-0002 item 2): adminListPlans, adminCreatePlan and adminUpdatePlan. Who
// may call them is AdminAuthGuard's (`platform_admin`). This service owns the transactions, their audit rows
// (`actor_type = 'platform_admin'`) and the `plan` invalidations after the commit.
//
// - The list holds every plan, public or not, active or retired, in `sort_order` then `code`, with the number of OTAs
//   on each (`tenants.plan_code`, any status). It is short, so it is not paginated.
// - A new plan is active from the start. Its `code` and `currency` never change; a code in use answers `409 CONFLICT`
//   (`details.reason = code_taken`). The currency must be one of `reference.currencies`, and both prices must be in
//   it (`400 VALIDATION_FAILED`, `/currency` code `unknown`, `/monthlyPrice/currency` or `/annualPrice/currency` code
//   `currency`). Prices are stored as `numeric(12,2)` decimal strings (conventions §1).
// - An update changes any field but `code` and `currency`, with `If-Match` carrying the plan's version (`412
//   PRECONDITION_FAILED`). Only the fields that differ from the stored ones are written; a request that changes
//   nothing writes nothing. `isActive: false` retires a plan (it leaves the pricing page; existing subscriptions keep
//   it) and `annualPrice: null` removes the yearly option. The audit row holds the changed fields before and after,
//   and a change of `limits` or `features` publishes `{v: 1, type: "plan", code}` after the commit, so both backends
//   reload the quotas.
// - The version is derived from `updated_at` (plans.repository.ts, "The version of a plan"): `platform.plans` has no
//   `version` column.
// - The Stripe ids stay `null` and `priceWarnings` empty until PBE-042 links prices (M5).
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches } from "../common/features";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { toPlan } from "./plans.controller";
import {
  PlansRepository,
  planVersion,
  type AdminPlanRow,
  type PlanChanges,
  type PlanRecord,
} from "./plans.repository";

export type AdminPlan = components["schemas"]["AdminPlan"];
export type AdminPlanList = components["schemas"]["AdminPlanList"];
export type CreatePlanRequest = components["schemas"]["CreatePlanRequest"];
export type UpdatePlanRequest = components["schemas"]["UpdatePlanRequest"];
type PlanPrice = components["schemas"]["PlanPrice"];
type PlanLimits = components["schemas"]["PlanLimits"];

/** The admin's plan of a row: the public `Plan` and the admin fields; `checkoutEnabled` is FEATURE_STRIPE_BILLING. */
export function toAdminPlan(row: AdminPlanRow, checkoutEnabled: boolean): AdminPlan {
  return {
    ...toPlan(row, checkoutEnabled),
    currency: row.currency,
    isPublic: row.is_public,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    settlementFeeBps: row.settlement_fee_bps,
    stripeProductId: row.stripe_product_id,
    stripePriceIdMonth: row.stripe_price_id_month,
    stripePriceIdYear: row.stripe_price_id_year,
    // The comparison with Stripe comes with the price links of PBE-042 (M5); no price is linked before.
    priceWarnings: [],
    tenantCount: row.tenant_count,
    version: planVersion(row.updated_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * A plan price as `numeric(12,2)` prints it: the amount of a PlanPrice (at most ten digits and two decimals, leading
 * zeros allowed) with no leading zero and exactly two decimals (`"0149.5"` → `"149.50"`).
 */
export function planAmount(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  return `${whole.replace(/^0+(?=[0-9])/, "")}.${fraction.padEnd(2, "0")}`;
}

/** JSON text with the keys of every object in order, so two equal objects give the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

/** The `limits` column of a plan: exactly the four quotas of PlanLimits. */
function limitsOf(limits: PlanLimits): PlanLimits {
  return {
    staffSeats: limits.staffSeats,
    apiKeys: limits.apiKeys,
    customDomains: limits.customDomains,
    liveMode: limits.liveMode,
  };
}

/** The field errors of prices whose currency is not the plan's. */
function priceCurrencyErrors(
  currency: string,
  prices: {
    readonly monthlyPrice?: PlanPrice | undefined;
    readonly annualPrice?: PlanPrice | null | undefined;
  },
): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of ["monthlyPrice", "annualPrice"] as const) {
    const price = prices[field];
    if (price !== undefined && price !== null && price.currency !== currency) {
      errors.push({ path: `/${field}/currency`, code: "currency", message: "Must be the plan's currency." });
    }
  }
  return errors;
}

/** The fields of a plan as the audit rows hold them (the API's names). */
function auditedPlan(row: PlanRecord): Record<string, unknown> {
  return {
    name: row.name,
    description: row.description,
    currency: row.currency,
    monthlyPrice: row.monthly_price,
    annualPrice: row.annual_price,
    limits: row.limits,
    features: row.features,
    isPublic: row.is_public,
    isActive: row.is_active,
    trialDays: row.trial_days,
    settlementFeeBps: row.settlement_fee_bps,
    sortOrder: row.sort_order,
  };
}

@Injectable()
export class PlansService {
  constructor(
    private readonly plans: PlansRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly switches: FeatureSwitches,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** adminListPlans: every plan with its tenant count. */
  async list(): Promise<AdminPlanList> {
    const checkoutEnabled = this.checkoutEnabled();
    const rows = await this.plans.listWithTenantCounts();
    return { data: rows.map((row) => toAdminPlan(row, checkoutEnabled)) };
  }

  /** adminCreatePlan: a new, active plan, with a `plan.created` audit row. */
  async create(claims: Pick<AccessTokenClaims, "sub">, request: CreatePlanRequest): Promise<AdminPlan> {
    const fieldErrors: FieldError[] = [];
    if (!(await this.plans.currencyExists(request.currency))) {
      fieldErrors.push({
        path: "/currency",
        code: "unknown",
        message: "Must be a known ISO 4217 currency code.",
      });
    }
    fieldErrors.push(...priceCurrencyErrors(request.currency, request));
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors });
    }
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      const inserted = await this.plans.insertIfNew(trx, {
        code: request.code,
        name: request.name,
        description: request.description,
        currency: request.currency,
        monthly_price: planAmount(request.monthlyPrice.amount),
        annual_price: request.annualPrice === undefined ? null : planAmount(request.annualPrice.amount),
        limitsJson: JSON.stringify(limitsOf(request.limits)),
        featuresJson: JSON.stringify(request.features),
        is_public: request.isPublic,
        trial_days: request.trialDays,
        settlement_fee_bps: request.settlementFeeBps,
        sort_order: request.sortOrder,
        now,
      });
      if (!inserted) {
        throw new AppError("CONFLICT", { details: { reason: "code_taken" } });
      }
      const row = await this.mustFind(request.code, trx);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "plan.created",
        targetType: "plan",
        targetId: row.code,
        after: auditedPlan(row),
      });
      return toAdminPlan(row, this.checkoutEnabled());
    });
  }

  /**
   * adminUpdatePlan: the fields of `request` that differ from the stored ones, with a `plan.updated` audit row (the
   * changed fields before and after) and, when `limits` or `features` changed, a `plan` invalidation after the commit.
   * `404` for an unknown plan, `412` for a stale version, `400` for a price in another currency.
   */
  async update(
    claims: Pick<AccessTokenClaims, "sub">,
    code: string,
    version: number,
    request: UpdatePlanRequest,
  ): Promise<AdminPlan> {
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      const current = await this.plans.lockForUpdate(trx, code);
      if (current === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (planVersion(current.updated_at) !== version) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const fieldErrors = priceCurrencyErrors(current.currency, request);
      if (fieldErrors.length > 0) {
        throw new AppError("VALIDATION_FAILED", { fieldErrors });
      }

      const changes: PlanChanges = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = <K extends keyof PlanChanges>(
        field: string,
        column: K,
        stored: unknown,
        value: PlanChanges[K] | undefined,
        shown: unknown = value,
      ): void => {
        if (value !== undefined && canonicalJson(shown) !== canonicalJson(stored)) {
          changes[column] = value;
          before[field] = stored;
          after[field] = shown;
        }
      };
      change("name", "name", current.name, request.name);
      change("description", "description", current.description, request.description);
      if (request.monthlyPrice !== undefined) {
        const amount = planAmount(request.monthlyPrice.amount);
        change("monthlyPrice", "monthly_price", current.monthly_price, amount);
      }
      if (request.annualPrice !== undefined) {
        const amount = request.annualPrice === null ? null : planAmount(request.annualPrice.amount);
        change("annualPrice", "annual_price", current.annual_price, amount);
      }
      if (request.limits !== undefined) {
        const limits = limitsOf(request.limits);
        change("limits", "limitsJson", current.limits, JSON.stringify(limits), limits);
      }
      if (request.features !== undefined) {
        change(
          "features",
          "featuresJson",
          current.features,
          JSON.stringify(request.features),
          request.features,
        );
      }
      change("isPublic", "is_public", current.is_public, request.isPublic);
      change("isActive", "is_active", current.is_active, request.isActive);
      change("trialDays", "trial_days", current.trial_days, request.trialDays);
      change("settlementFeeBps", "settlement_fee_bps", current.settlement_fee_bps, request.settlementFeeBps);
      change("sortOrder", "sort_order", current.sort_order, request.sortOrder);

      if (Object.keys(changes).length > 0) {
        await this.plans.update(trx, code, changes, now);
        await this.audit.record(trx, {
          actorType: "platform_admin",
          actorAccountId: claims.sub,
          action: "plan.updated",
          targetType: "plan",
          targetId: code,
          before,
          after,
          details: { changed: Object.keys(after) },
        });
        if (changes.limitsJson !== undefined || changes.featuresJson !== undefined) {
          this.invalidations.publishAfterCommit(trx, { v: 1, type: "plan", code });
        }
      }
      return toAdminPlan(await this.mustFind(code, trx), this.checkoutEnabled());
    });
  }

  /** The plan `code` with its tenant count, read in `trx`, which holds it (just inserted or locked). */
  private async mustFind(code: string, trx: PlatformTransaction): Promise<AdminPlanRow> {
    const row = await this.plans.findWithTenantCount(code, trx);
    if (row === undefined) {
      throw new Error(`plan ${code} vanished inside its own transaction`);
    }
    return row;
  }

  /** Stripe Checkout is offered only while Stripe Billing is switched on (FEATURE_STRIPE_BILLING, PADR-0015). */
  private checkoutEnabled(): boolean {
    return this.switches.isEnabled("stripe_billing");
  }
}
