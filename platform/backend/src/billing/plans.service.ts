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
// - The Stripe links (M5, PBE-048; flow §A, PADR-0002 item 2, scope PF-88). `adminUpdatePlan` takes
//   `stripeProductId`, `stripePriceIdMonth` and `stripePriceIdYear` (`null` unlinks). When the request links, changes
//   or unlinks a price, or changes a price of a plan that links one, it compares the plan as the request leaves it with
//   every linked Stripe price (price-check.ts) **before** its transaction (architecture §2.3: no transaction is open
//   during a Stripe call): a first read gives the plan, the transaction then checks that the plan is still the version
//   of `If-Match`, so the comparison was made on what is saved. The warnings never block the save; a Stripe failure
//   saves nothing (`502 PROVIDER_ERROR`). A price can link one plan only: a price that another plan links, in either
//   column, answers `409 CONFLICT` (`details.reason = stripe_price_taken`); the transaction holds the advisory lock of
//   the price links (`lockStripeLinks`) while it checks, and the unique indexes of migration 0002 refuse a race in one
//   column the same way. One price as both the monthly and the yearly price of a plan answers `400 VALIDATION_FAILED`
//   (`/stripePriceIdMonth` or `/stripePriceIdYear`, code `same_price`): billing sync could not tell its interval.
// - `adminCheckPlanPrices` runs the comparison again for the plan as it is (no linked price: no warning, no call), and
//   writes one `plan.prices_checked` audit row with the warnings before and after, under the plan's row lock. A plan
//   whose prices or links changed during the Stripe calls is compared again (at most CHECK_ATTEMPTS times).
// - The plan's `priceWarnings` are those of its last comparison. `platform.plans` has no column for them (migrations
//   0001 and 0002): the audit row of each comparison records them in `details.priceWarnings` (`plan.updated` of an
//   update that compared, `plan.prices_checked`), and the admin reads take them from the plan's newest such row
//   through AuditService (`latestDetail`; AuditModule owns `platform_audit_log`, architecture §2.2), so a plan never
//   compared has none. Every comparison writes its row while it holds the plan's row lock (`lockForUpdate`), so the
//   newest row (the log's identity order) is the comparison that committed last. A comparison does not change the
//   plan's version: an admin's open edit form stays valid.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import type { AuditAction } from "../audit/audit-actions";
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
  STRIPE_PRICE_INDEXES,
  type AdminPlanRow,
  type PlanChanges,
  type PlanRecord,
} from "./plans.repository";
import {
  linkedPrices,
  PRICE_LINKS,
  PriceCheck,
  type PlanPriceTerms,
  type PlanPriceWarning,
  type PriceLink,
} from "./price-check";

export type AdminPlan = components["schemas"]["AdminPlan"];
export type AdminPlanList = components["schemas"]["AdminPlanList"];
export type CreatePlanRequest = components["schemas"]["CreatePlanRequest"];
export type UpdatePlanRequest = components["schemas"]["UpdatePlanRequest"];
export type PlanPriceCheck = components["schemas"]["PlanPriceCheck"];
type PlanPrice = components["schemas"]["PlanPrice"];
type PlanLimits = components["schemas"]["PlanLimits"];

/** How often `adminCheckPlanPrices` compares a plan whose prices or links change during its Stripe calls. */
export const CHECK_ATTEMPTS = 3;

/** The audit actions whose rows record a comparison of a plan with its Stripe prices (file header). */
export const PRICE_CHECK_ACTIONS: readonly AuditAction[] = Object.freeze([
  "plan.updated",
  "plan.prices_checked",
] satisfies AuditAction[]);

const UNIQUE_VIOLATION = "23505";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isWarningValue = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * The stored warnings of a plan (`details.priceWarnings` of its last comparison's audit row, file header) as
 * `PlanPriceWarning`s: an array of `{field, expected, actual}`, or none for anything else (a plan never compared).
 */
export function storedWarningsOf(value: unknown): PlanPriceWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const warnings: PlanPriceWarning[] = [];
  for (const item of value) {
    if (
      isObject(item) &&
      typeof item["field"] === "string" &&
      isWarningValue(item["expected"]) &&
      isWarningValue(item["actual"])
    ) {
      warnings.push({ field: item["field"], expected: item["expected"], actual: item["actual"] });
    }
  }
  return warnings;
}

/**
 * The admin's plan of a row: the public `Plan` and the admin fields; `checkoutEnabled` is FEATURE_STRIPE_BILLING,
 * `priceWarnings` the warnings of the plan's last comparison with Stripe (file header).
 */
export function toAdminPlan(
  row: AdminPlanRow,
  checkoutEnabled: boolean,
  priceWarnings: readonly PlanPriceWarning[],
): AdminPlan {
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
    priceWarnings: [...priceWarnings],
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

/** What the comparison reads of a stored plan. */
function termsOf(row: PlanRecord): PlanPriceTerms {
  return {
    currency: row.currency.trim(),
    monthlyPrice: row.monthly_price,
    annualPrice: row.annual_price,
    stripePriceIdMonth: row.stripe_price_id_month,
    stripePriceIdYear: row.stripe_price_id_year,
  };
}

/** The plan `row` as `request` leaves it, for the comparison (prices as `numeric(12,2)` prints them). */
function termsAfter(row: PlanRecord, request: UpdatePlanRequest): PlanPriceTerms {
  const current = termsOf(row);
  return {
    currency: current.currency,
    monthlyPrice:
      request.monthlyPrice === undefined ? current.monthlyPrice : planAmount(request.monthlyPrice.amount),
    annualPrice:
      request.annualPrice === undefined
        ? current.annualPrice
        : request.annualPrice === null
          ? null
          : planAmount(request.annualPrice.amount),
    stripePriceIdMonth:
      request.stripePriceIdMonth === undefined ? current.stripePriceIdMonth : request.stripePriceIdMonth,
    stripePriceIdYear:
      request.stripePriceIdYear === undefined ? current.stripePriceIdYear : request.stripePriceIdYear,
  };
}

/** True when two plans agree on everything the comparison reads. */
function sameTerms(a: PlanPriceTerms, b: PlanPriceTerms): boolean {
  return (
    a.currency === b.currency &&
    a.monthlyPrice === b.monthlyPrice &&
    a.annualPrice === b.annualPrice &&
    a.stripePriceIdMonth === b.stripePriceIdMonth &&
    a.stripePriceIdYear === b.stripePriceIdYear
  );
}

/**
 * True when an update from `before` to `after` must compare the plan with Stripe (file header): a price link changed,
 * or a price changed while a price is linked.
 */
export function comparisonDue(before: PlanPriceTerms, after: PlanPriceTerms): boolean {
  const linksChanged = PRICE_LINKS.some((link) => before[link] !== after[link]);
  const pricesChanged =
    before.monthlyPrice !== after.monthlyPrice || before.annualPrice !== after.annualPrice;
  return linksChanged || (pricesChanged && linkedPrices(after).length > 0);
}

/** The field errors of a plan that links one price as both its monthly and its yearly price (file header). */
function samePriceErrors(after: PlanPriceTerms, request: UpdatePlanRequest): FieldError[] {
  if (after.stripePriceIdMonth === null || after.stripePriceIdMonth !== after.stripePriceIdYear) {
    return [];
  }
  const field: PriceLink =
    request.stripePriceIdYear === undefined ? "stripePriceIdMonth" : "stripePriceIdYear";
  return [
    {
      path: `/${field}`,
      code: "same_price",
      message: "Must not be the plan's price of the other billing interval.",
    },
  ];
}

/** `409 CONFLICT` for a price that another plan links (`details.reason = stripe_price_taken`). */
function stripePriceTaken(): AppError<"CONFLICT"> {
  return new AppError("CONFLICT", { details: { reason: "stripe_price_taken" } });
}

/** True for the `pg` error of a price linked twice in one column (Kysely passes it through). */
function isStripePriceConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && typeof constraint === "string" && STRIPE_PRICE_INDEXES.has(constraint);
}

/** The price ids of `after` that `before` did not link: the links the update adds or changes. */
function newLinks(before: PlanPriceTerms, after: PlanPriceTerms): string[] {
  const ids = new Set<string>();
  for (const link of PRICE_LINKS) {
    const priceId = after[link];
    if (priceId !== null && priceId !== before[link]) {
      ids.add(priceId);
    }
  }
  return [...ids];
}

@Injectable()
export class PlansService {
  constructor(
    private readonly plans: PlansRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly switches: FeatureSwitches,
    private readonly clock: Clock,
    private readonly priceCheck: PriceCheck,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** adminListPlans: every plan with its tenant count and its stored price warnings (file header). */
  async list(): Promise<AdminPlanList> {
    const checkoutEnabled = this.checkoutEnabled();
    const rows = await this.plans.listWithTenantCounts();
    const codes = rows.map((row) => row.code);
    const warnings = await this.storedWarnings(codes, this.db);
    return { data: rows.map((row) => toAdminPlan(row, checkoutEnabled, warnings.get(row.code) ?? [])) };
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
      return this.adminPlanOf(row, trx);
    });
  }

  /**
   * adminUpdatePlan: the fields of `request` that differ from the stored ones, with a `plan.updated` audit row (the
   * changed fields before and after, and the warnings of the comparison with Stripe when it ran) and, when `limits` or
   * `features` changed, a `plan` invalidation after the commit. `404` for an unknown plan, `412` for a stale version,
   * `400` for a price in another currency or one price for both intervals, `409` for a price another plan links, `502`
   * when Stripe fails (file header).
   */
  async update(
    claims: Pick<AccessTokenClaims, "sub">,
    code: string,
    version: number,
    request: UpdatePlanRequest,
  ): Promise<AdminPlan> {
    // Stripe before the transaction (file header): the plan the request changes, then the comparison of the result.
    const read = await this.plans.findRecord(code);
    const compared = await this.compareForUpdate(read, code, version, request);
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      const current = await this.plans.lockForUpdate(trx, code);
      const terms = this.checkUpdate(current, version, request);
      // The plan is still the version the comparison read (`If-Match`), so the comparison holds for what is saved.
      const stored = termsOf(terms.current);
      const linking = newLinks(stored, terms.after);
      if (linking.length > 0) {
        await this.plans.lockStripeLinks(trx);
        if ((await this.plans.otherPlansLinking(trx, code, linking)).length > 0) {
          throw stripePriceTaken();
        }
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
      const row = terms.current;
      change("name", "name", row.name, request.name);
      change("description", "description", row.description, request.description);
      if (request.monthlyPrice !== undefined) {
        const amount = planAmount(request.monthlyPrice.amount);
        change("monthlyPrice", "monthly_price", row.monthly_price, amount);
      }
      if (request.annualPrice !== undefined) {
        const amount = request.annualPrice === null ? null : planAmount(request.annualPrice.amount);
        change("annualPrice", "annual_price", row.annual_price, amount);
      }
      if (request.limits !== undefined) {
        const limits = limitsOf(request.limits);
        change("limits", "limitsJson", row.limits, JSON.stringify(limits), limits);
      }
      if (request.features !== undefined) {
        change("features", "featuresJson", row.features, JSON.stringify(request.features), request.features);
      }
      change("isPublic", "is_public", row.is_public, request.isPublic);
      change("isActive", "is_active", row.is_active, request.isActive);
      change("trialDays", "trial_days", row.trial_days, request.trialDays);
      change("settlementFeeBps", "settlement_fee_bps", row.settlement_fee_bps, request.settlementFeeBps);
      change("sortOrder", "sort_order", row.sort_order, request.sortOrder);
      change("stripeProductId", "stripe_product_id", row.stripe_product_id, request.stripeProductId);
      change(
        "stripePriceIdMonth",
        "stripe_price_id_month",
        row.stripe_price_id_month,
        request.stripePriceIdMonth,
      );
      change(
        "stripePriceIdYear",
        "stripe_price_id_year",
        row.stripe_price_id_year,
        request.stripePriceIdYear,
      );

      if (Object.keys(changes).length > 0) {
        if (compared !== undefined) {
          const storedWarnings = (await this.storedWarnings([code], trx)).get(code) ?? [];
          if (canonicalJson(storedWarnings) !== canonicalJson(compared)) {
            before["priceWarnings"] = storedWarnings;
            after["priceWarnings"] = compared;
          }
        }
        try {
          await this.plans.update(trx, code, changes, now);
        } catch (error) {
          throw isStripePriceConflict(error) ? stripePriceTaken() : error;
        }
        await this.audit.record(trx, {
          actorType: "platform_admin",
          actorAccountId: claims.sub,
          action: "plan.updated",
          targetType: "plan",
          targetId: code,
          before,
          after,
          details: {
            changed: Object.keys(after),
            // The record of the comparison: the plan's stored warnings from now on (file header).
            ...(compared === undefined ? {} : { priceWarnings: compared }),
          },
        });
        if (changes.limitsJson !== undefined || changes.featuresJson !== undefined) {
          this.invalidations.publishAfterCommit(trx, { v: 1, type: "plan", code });
        }
      }
      return this.adminPlanOf(await this.mustFind(code, trx), trx);
    });
  }

  /**
   * adminCheckPlanPrices: the comparison of the plan as it is with its Stripe prices, recorded by a
   * `plan.prices_checked` audit row (the warnings before and after); no call and no row for a plan without a linked
   * price. `404` for an unknown plan, `502` when Stripe fails (the stored warnings stay as they were).
   */
  async checkPrices(claims: Pick<AccessTokenClaims, "sub">, code: string): Promise<PlanPriceCheck> {
    for (let attempt = 1; ; attempt += 1) {
      const plan = await this.plans.findRecord(code);
      if (plan === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const terms = termsOf(plan);
      if (linkedPrices(terms).length === 0) {
        return { warnings: [] };
      }
      const warnings = await this.priceCheck.compare(terms);
      const recorded = await runInTransaction(this.db, async (trx) => {
        const locked = await this.plans.lockForUpdate(trx, code);
        if (locked === undefined) {
          throw new AppError("NOT_FOUND");
        }
        if (!sameTerms(termsOf(locked), terms)) {
          // Its prices or links changed during the Stripe calls: these warnings are not the plan's.
          return false;
        }
        const storedWarnings = (await this.storedWarnings([code], trx)).get(code) ?? [];
        await this.audit.record(trx, {
          actorType: "platform_admin",
          actorAccountId: claims.sub,
          action: "plan.prices_checked",
          targetType: "plan",
          targetId: code,
          before: { priceWarnings: storedWarnings },
          after: { priceWarnings: warnings },
          details: {
            priceIds: linkedPrices(terms).map(({ priceId }) => priceId),
            priceWarnings: warnings,
          },
        });
        return true;
      });
      if (recorded || attempt >= CHECK_ATTEMPTS) {
        return { warnings };
      }
    }
  }

  /**
   * The checks of an update that need no Stripe call (`404`, `412`, `400`), on `row` (read or locked); the plan and
   * the plan as the request leaves it.
   */
  private checkUpdate(
    row: PlanRecord | undefined,
    version: number,
    request: UpdatePlanRequest,
  ): { readonly current: PlanRecord; readonly after: PlanPriceTerms } {
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (planVersion(row.updated_at) !== version) {
      throw new AppError("PRECONDITION_FAILED");
    }
    const after = termsAfter(row, request);
    const fieldErrors = [...priceCurrencyErrors(row.currency, request), ...samePriceErrors(after, request)];
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors });
    }
    return { current: row, after };
  }

  /**
   * The comparison of an update, made before its transaction on the plan `read` (file header): `undefined` when the
   * update needs none, the warnings otherwise. Answers the update's own errors first, so a refused request calls no
   * Stripe: `404`, `412`, `400`, and `409` for a price another plan links already.
   */
  private async compareForUpdate(
    read: PlanRecord | undefined,
    code: string,
    version: number,
    request: UpdatePlanRequest,
  ): Promise<PlanPriceWarning[] | undefined> {
    const { current, after } = this.checkUpdate(read, version, request);
    const before = termsOf(current);
    if (!comparisonDue(before, after)) {
      return undefined;
    }
    const linking = newLinks(before, after);
    if ((await this.plans.otherPlansLinking(this.db, code, linking)).length > 0) {
      throw stripePriceTaken();
    }
    return this.priceCheck.compare(after);
  }

  /**
   * The stored warnings of the plans `codes` (file header), read on `db` through AuditService, by plan code; a plan
   * never compared is absent.
   */
  private async storedWarnings(
    codes: readonly string[],
    db: PlatformDb | PlatformTransaction,
  ): Promise<Map<string, PlanPriceWarning[]>> {
    const stored = await this.audit.latestDetail(db, {
      targetType: "plan",
      targetIds: codes,
      actions: PRICE_CHECK_ACTIONS,
      key: "priceWarnings",
    });
    return new Map([...stored].map(([code, value]) => [code, storedWarningsOf(value)]));
  }

  /** The admin's plan of `row` with its stored warnings, read in `trx`, which holds the plan. */
  private async adminPlanOf(row: AdminPlanRow, trx: PlatformTransaction): Promise<AdminPlan> {
    const warnings = await this.storedWarnings([row.code], trx);
    return toAdminPlan(row, this.checkoutEnabled(), warnings.get(row.code) ?? []);
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
