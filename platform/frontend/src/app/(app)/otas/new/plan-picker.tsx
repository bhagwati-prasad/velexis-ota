import type { components } from "@velexis/api-types/platform";

import { fieldId } from "@/components/form-field";
import { Money } from "@/components/money";
import { PRICING_STRINGS, WIZARD_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * Step 2 of the create-OTA wizard (README §2 `/otas/new` and §4): the plan. Before M5 (`getMe.features.stripeBilling`
 * off) the API puts every new OTA on `early_access`, so the step offers that plan only (PF-10 AC3); the public plans
 * with a monthly or annual interval and the Stripe Checkout hand-off arrive with M5 (PFE-020).
 *
 * No directive: the page (a server component) uses `wizardPlans`, and the wizard (a client component) renders
 * `PlanPicker`, a controlled component without state of its own.
 */

/** A public plan, as `listPlans` answers it. */
export type Plan = components["schemas"]["Plan"];

/** The plan of every OTA created before M5 (ADR-0013 point 4). */
export const EARLY_ACCESS_PLAN_CODE = "early_access";

/**
 * The plans the wizard offers: before M5 only `early_access` (PF-10 AC3), from M5 every public plan `listPlans`
 * answers, in its order.
 */
export function wizardPlans(plans: readonly Plan[], stripeBilling: boolean): Plan[] {
  return stripeBilling ? [...plans] : plans.filter((plan) => plan.code === EARLY_ACCESS_PLAN_CODE);
}

/** The id of the radio button of `code`; the first one is the field's id, the target of the error summary. */
function radioId(code: string, index: number): string {
  return index === 0 ? fieldId("planCode") : `${fieldId("planCode")}-${code}`;
}

export interface PlanPickerProps {
  /** The plans to choose from (`wizardPlans`). */
  readonly plans: readonly Plan[];
  /** The chosen plan's code. */
  readonly value: string;
  readonly onChange: (code: string) => void;
  /** A note above the plans (before M5: why only early access is offered). */
  readonly note?: string | undefined;
  /** Shown instead of the plans when `listPlans` failed. */
  readonly unavailable?: string | undefined;
  /** The error of the field. */
  readonly error?: string | undefined;
}

/**
 * The plans as radio buttons (`name="planCode"`), each with its price, free trial and limits. When the plans could
 * not be loaded, the chosen code (before M5 always `early_access`) still travels in a hidden field.
 */
export function PlanPicker({ plans, value, onChange, note, unavailable, error }: PlanPickerProps) {
  const noteId = note === undefined ? undefined : "plan-picker-note";
  const errorId = error === undefined ? undefined : "plan-picker-error";
  const describedBy = [noteId, errorId].filter((id) => id !== undefined).join(" ");
  return (
    <fieldset
      className="grid gap-4"
      aria-describedby={describedBy === "" ? undefined : describedBy}
      data-invalid={errorId === undefined ? undefined : true}
    >
      <legend className="mb-2 text-sm font-medium">{WIZARD_STRINGS.planLegend}</legend>
      {note === undefined ? null : (
        <p id={noteId} className="text-sm text-muted-foreground">
          {note}
        </p>
      )}
      {unavailable !== undefined ? (
        <>
          <p role="status" className="rounded-lg border px-4 py-3 text-sm">
            {unavailable}
          </p>
          {value === "" ? null : <input type="hidden" name="planCode" value={value} />}
        </>
      ) : (
        <div className="grid gap-3">
          {plans.map((plan, index) => {
            const id = radioId(plan.code, index);
            const checked = plan.code === value;
            return (
              <div
                key={plan.code}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-4",
                  checked ? "border-primary ring-1 ring-primary" : undefined,
                )}
              >
                <input
                  type="radio"
                  id={id}
                  name="planCode"
                  value={plan.code}
                  checked={checked}
                  onChange={() => onChange(plan.code)}
                  aria-invalid={errorId === undefined ? undefined : true}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <label htmlFor={id} className="grid flex-1 gap-2">
                  <span className="font-semibold">{plan.name}</span>
                  {plan.description === null || plan.description === "" ? null : (
                    <span className="text-sm text-muted-foreground">{plan.description}</span>
                  )}
                  <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <Money value={plan.monthlyPrice} className="font-medium" />
                    <span className="text-muted-foreground">{WIZARD_STRINGS.perMonth}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {[
                      `${PRICING_STRINGS.trial}: ${plan.trialDays > 0 ? PRICING_STRINGS.trialDays(plan.trialDays) : PRICING_STRINGS.noTrial}`,
                      PRICING_STRINGS.staffSeats(plan.limits.staffSeats),
                      PRICING_STRINGS.apiKeys(plan.limits.apiKeys),
                      plan.limits.liveMode ? PRICING_STRINGS.liveMode : PRICING_STRINGS.testModeOnly,
                    ].join(" · ")}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      )}
      {errorId === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
