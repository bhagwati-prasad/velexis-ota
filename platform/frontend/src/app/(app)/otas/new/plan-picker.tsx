import type { components } from "@velexis/api-types/platform";

import { fieldId } from "@/components/form-field";
import { Money } from "@/components/money";
import { PRICING_STRINGS, WIZARD_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * Step 2 of the create-OTA wizard (README §2 `/otas/new` and §4): the plan. Before M5 (`getMe.features.stripeBilling`
 * off) the API puts every new OTA on `early_access`, so the step offers that plan only (PF-10 AC3). From M5 (PFE-020,
 * PF-71) it offers every public plan with the "Annual billing" switch: each plan shows its price for the chosen
 * interval and its free trial, and a plan without a Stripe price for that interval (`checkoutAvailable`) is shown
 * but cannot be chosen with it.
 *
 * No directive: the page (a server component) uses `wizardPlans`, and the wizard (a client component) renders
 * `PlanPicker`, a controlled component without state of its own.
 */

/** A public plan, as `listPlans` answers it. */
export type Plan = components["schemas"]["Plan"];

/** The billing period of a subscription: `month` or `year`. */
export type BillingInterval = components["schemas"]["BillingInterval"];

/** The interval the wizard starts on from M5. */
export const DEFAULT_BILLING_INTERVAL: BillingInterval = "month";

/** The plan of every OTA created before M5 (ADR-0013 point 4). */
export const EARLY_ACCESS_PLAN_CODE = "early_access";

/**
 * The plans the wizard offers: before M5 only `early_access` (PF-10 AC3), from M5 every public plan `listPlans`
 * answers, in its order.
 */
export function wizardPlans(plans: readonly Plan[], stripeBilling: boolean): Plan[] {
  return stripeBilling ? [...plans] : plans.filter((plan) => plan.code === EARLY_ACCESS_PLAN_CODE);
}

/** `value` is a billing interval of the platform document (`month` or `year`). */
export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}

/** Stripe Checkout can start `plan` with `interval`: the plan has a Stripe price for it (`checkoutAvailable`). */
export function checkoutAvailable(plan: Plan, interval: BillingInterval): boolean {
  return plan.checkoutAvailable[interval];
}

/** The free trial of a plan, in words ("14 days", "None"). */
export function trialText(plan: Plan): string {
  return plan.trialDays > 0 ? PRICING_STRINGS.trialDays(plan.trialDays) : PRICING_STRINGS.noTrial;
}

/** The price of `plan` for `interval` with its unit; a plan without an annual price says it bills monthly only. */
export function PlanPrice({ plan, interval }: { readonly plan: Plan; readonly interval: BillingInterval }) {
  if (interval === "year") {
    return plan.annualPrice === null ? (
      <span className="font-medium">{WIZARD_STRINGS.monthlyOnly}</span>
    ) : (
      <>
        <Money value={plan.annualPrice} className="font-medium" />
        <span className="text-muted-foreground">{WIZARD_STRINGS.perYear}</span>
      </>
    );
  }
  return (
    <>
      <Money value={plan.monthlyPrice} className="font-medium" />
      <span className="text-muted-foreground">{WIZARD_STRINGS.perMonth}</span>
    </>
  );
}

/** The id of the radio button of `code`; the target radio button has the field's id, the error summary's link. */
function radioId(code: string, target: boolean): string {
  return target ? fieldId("planCode") : `${fieldId("planCode")}-${code}`;
}

/**
 * The index of the radio button that has the field's id: the first plan that can be chosen with `interval` (all of
 * them before M5), else the first. A disabled radio button cannot take the focus the error summary's link gives it,
 * and from M5 the first plan may be one without a Stripe price (`early_access`, the first in the API's order).
 */
function targetIndex(plans: readonly Plan[], interval: BillingInterval | undefined): number {
  return Math.max(
    0,
    plans.findIndex((plan) => interval === undefined || checkoutAvailable(plan, interval)),
  );
}

export interface PlanPickerProps {
  /** The plans to choose from (`wizardPlans`). */
  readonly plans: readonly Plan[];
  /** The chosen plan's code. */
  readonly value: string;
  readonly onChange: (code: string) => void;
  /**
   * The chosen billing interval, from M5 only: the step then shows the "Annual billing" switch, and each plan its
   * price and whether Checkout can start it for the interval. Before M5 it is `undefined`, and the step is M1's.
   */
  readonly interval?: BillingInterval | undefined;
  readonly onIntervalChange?: ((interval: BillingInterval) => void) | undefined;
  /** A note above the plans (before M5: why only early access is offered; from M5: the Checkout hand-off). */
  readonly note?: string | undefined;
  /** Shown instead of the plans when `listPlans` failed. */
  readonly unavailable?: string | undefined;
  /** The error of the field. */
  readonly error?: string | undefined;
  /** The error of the billing interval (M5). */
  readonly intervalError?: string | undefined;
}

/**
 * The interval switch of M5, on for annual billing (a checkbox with the `switch` role). It has no `name`: the hidden
 * field `billingInterval` carries the interval, so the form always sends `month` or `year`.
 */
function IntervalSwitch({
  interval,
  onIntervalChange,
  error,
}: {
  readonly interval: BillingInterval;
  readonly onIntervalChange: ((interval: BillingInterval) => void) | undefined;
  readonly error: string | undefined;
}) {
  const id = fieldId("billingInterval");
  const hintId = `${id}-description`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  return (
    <div className="grid gap-2" data-invalid={errorId === undefined ? undefined : true}>
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          role="switch"
          id={id}
          checked={interval === "year"}
          onChange={(event) => onIntervalChange?.(event.target.checked ? "year" : "month")}
          aria-describedby={errorId === undefined ? hintId : `${hintId} ${errorId}`}
          aria-invalid={errorId === undefined ? undefined : true}
          className="size-4 shrink-0 accent-primary"
        />
        <label htmlFor={id} className="text-sm font-medium">
          {WIZARD_STRINGS.annualBilling}
        </label>
      </div>
      <p id={hintId} className="text-sm text-muted-foreground">
        {WIZARD_STRINGS.annualBillingHint}
      </p>
      {errorId === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <input type="hidden" name="billingInterval" value={interval} />
    </div>
  );
}

/**
 * The plans as radio buttons (`name="planCode"`), each with its price, free trial and limits. When the plans could
 * not be loaded, the chosen code (before M5 always `early_access`) still travels in a hidden field. From M5 the
 * interval switch comes first, and a plan Checkout cannot start with the chosen interval is shown, disabled, with the
 * reason in its name.
 */
export function PlanPicker({
  plans,
  value,
  onChange,
  interval,
  onIntervalChange,
  note,
  unavailable,
  error,
  intervalError,
}: PlanPickerProps) {
  const noteId = note === undefined ? undefined : "plan-picker-note";
  const errorId = error === undefined ? undefined : "plan-picker-error";
  const describedBy = [noteId, errorId].filter((id) => id !== undefined).join(" ");
  const target = targetIndex(plans, interval);
  const fieldset = (
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
            const id = radioId(plan.code, index === target);
            // Before M5 every plan shown can be chosen; from M5 only with a Stripe price for the interval.
            const offered = interval === undefined || checkoutAvailable(plan, interval);
            const checked = offered && plan.code === value;
            return (
              <div
                key={plan.code}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-4",
                  checked ? "border-primary ring-1 ring-primary" : undefined,
                  offered ? undefined : "border-dashed",
                )}
              >
                <input
                  type="radio"
                  id={id}
                  name="planCode"
                  value={plan.code}
                  checked={checked}
                  disabled={!offered}
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
                    <PlanPrice plan={plan} interval={interval ?? DEFAULT_BILLING_INTERVAL} />
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {[
                      `${PRICING_STRINGS.trial}: ${trialText(plan)}`,
                      PRICING_STRINGS.staffSeats(plan.limits.staffSeats),
                      PRICING_STRINGS.apiKeys(plan.limits.apiKeys),
                      plan.limits.liveMode ? PRICING_STRINGS.liveMode : PRICING_STRINGS.testModeOnly,
                    ].join(" · ")}
                  </span>
                  {offered || interval === undefined ? null : (
                    // Part of the radio's name, so the reason is read with the disabled plan.
                    <span className="text-sm font-medium">{WIZARD_STRINGS.planNotOffered(interval)}</span>
                  )}
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
  if (interval === undefined) {
    return fieldset;
  }
  return (
    <div className="grid gap-6">
      <IntervalSwitch interval={interval} onIntervalChange={onIntervalChange} error={intervalError} />
      {fieldset}
    </div>
  );
}
