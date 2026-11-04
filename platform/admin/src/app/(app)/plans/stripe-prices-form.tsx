"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  checkPlanPrices,
  linkStripePrices,
  type PriceCheckState,
  type StripeLink,
  type StripeLinkField,
  type StripeLinkValues,
  type StripePricesState,
} from "@/app/(app)/plans/actions";
import { currencyExponent } from "@/app/(app)/settlements/[settlementId]/adjustment-amount";
import { Money, type MoneyValue } from "@/components/money";
import { toneClasses } from "@/components/status-badge";
import { isStepUpRequired, useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PRICE_INTERVAL_LABELS, PRICE_WARNING_ATTRIBUTES, STRIPE_PRICES_STRINGS as S } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * "Link Stripe prices" on `/plans/[planCode]` (README §2 and §4; subscription-billing flow §A; PF-88, PAD-012): the
 * Stripe product and the recurring monthly and yearly prices of the plan, each price with the warnings of the last
 * comparison with Stripe next to it, and "Check prices", which compares the saved prices with Stripe again. A save
 * sends the three ids with the plan's version in `If-Match`; warnings never block it. The warnings shown are the
 * newest the form knows: those of the page, of the last save or of the last check, whichever came last. The props are
 * the few plan fields the form shows: Next.js sends them to the browser.
 */

type PriceWarning = StripeLink["priceWarnings"][number];

/** The longest Stripe id `UpdatePlanRequest` takes. */
const STRIPE_ID_MAX_LENGTH = 255;

/** The fields in display order, for moving the focus to the first field with a problem. */
const FIELD_ORDER: readonly StripeLinkField[] = [
  "stripeProductId",
  "stripePriceIdMonth",
  "stripePriceIdYear",
];

/** The price links a warning can name (`PlanPriceWarning.field` is `<link>.<attribute>`). */
type PriceLink = "stripePriceIdMonth" | "stripePriceIdYear";

const ATTRIBUTES: Readonly<Record<string, string>> = PRICE_WARNING_ATTRIBUTES;
const INTERVALS: Readonly<Record<string, string>> = PRICE_INTERVAL_LABELS;

/** The form's values of a saved link: an unlinked id is an empty field. */
function valuesOfLink(link: StripeLink): StripeLinkValues {
  return {
    stripeProductId: link.stripeProductId ?? "",
    stripePriceIdMonth: link.stripePriceIdMonth ?? "",
    stripePriceIdYear: link.stripePriceIdYear ?? "",
  };
}

function sameValues(a: StripeLinkValues, b: StripeLinkValues): boolean {
  return (
    a.stripeProductId === b.stripeProductId &&
    a.stripePriceIdMonth === b.stripePriceIdMonth &&
    a.stripePriceIdYear === b.stripePriceIdYear
  );
}

/** The link and the attribute of a warning (`stripePriceIdMonth.amount` → the monthly price, `amount`). */
function partsOf(field: string): { readonly link: string; readonly attribute: string } {
  const dot = field.indexOf(".");
  return dot === -1
    ? { link: field, attribute: "" }
    : { link: field.slice(0, dot), attribute: field.slice(dot + 1) };
}

/** A billing interval of a warning in words: `month` → "Monthly", `3 month` → "Every 3 months". */
function intervalText(value: string): string {
  const [count, unit] = value.split(" ");
  if (unit !== undefined && count !== undefined) {
    return S.everyN(count, unit);
  }
  return Object.hasOwn(INTERVALS, value) ? (INTERVALS[value] ?? value) : value;
}

/** The words of one side of a warning: an interval, whether the price is active, or the value as it is. */
function valueText(attribute: string, value: string | null, side: "plan" | "stripe"): string {
  switch (attribute) {
    case "amount":
      return side === "plan" ? S.noAnnualPrice : S.noUnitAmount;
    case "interval":
      return value === null ? S.oneTime : intervalText(value);
    case "active":
      if (value === null) {
        return S.unknownPrice;
      }
      return value === "true" ? S.active : S.archived;
    default:
      return value ?? S.none;
  }
}

/** An unsigned decimal string, as the API answers the amounts of a warning (`"149.00"`, `"5000"`). */
const UNSIGNED_DECIMAL = /^[0-9]+(?:\.[0-9]+)?$/;

/**
 * `value` (an unsigned decimal string) with its decimal point moved `places` digits to the right, or to the left when
 * `places` is negative: `("50.00", 2)` → `"5000"`, `("14900", -2)` → `"149.00"`. Every digit is kept, so no amount is
 * rounded, and no JavaScript number is involved (conventions §1).
 */
export function shiftDecimalPoint(value: string, places: number): string {
  const [whole = "", fraction = ""] = value.split(".");
  const digits = whole + fraction;
  const point = whole.length + places;
  const padded =
    point < 0
      ? "0".repeat(-point) + digits
      : point > digits.length
        ? digits + "0".repeat(point - digits.length)
        : digits;
  const at = Math.max(point, 0);
  const integer = padded.slice(0, at).replace(/^0+(?=[0-9])/, "");
  const decimals = padded.slice(at);
  return `${integer === "" ? "0" : integer}${decimals === "" ? "" : `.${decimals}`}`;
}

/**
 * The amount Stripe answered, as money in Stripe's currency. The API answers both amounts of a warning in the minor
 * unit of the plan's currency read with that currency's decimals (subscription-billing flow §A, note of PBE-048), so a
 * price of the plan's currency is shown as it comes. A price of another currency (its `<link>.currency` warning names
 * it) is read back with its own currency's decimals from `reference.currencies`: Stripe's `unit_amount` of 5000 on a JPY
 * price of an EUR plan comes as `"50.00"` and shows as ¥5,000, and 15900 on a USD price as $159.00, never €159.00.
 */
export function stripeAmountOf(value: string, planCurrency: string, stripeCurrency: string): MoneyValue {
  if (stripeCurrency === planCurrency || !UNSIGNED_DECIMAL.test(value)) {
    return { amount: value, currency: planCurrency };
  }
  return {
    amount: shiftDecimalPoint(value, currencyExponent(planCurrency) - currencyExponent(stripeCurrency)),
    currency: stripeCurrency,
  };
}

/**
 * One side of a warning in words: an amount as money (the plan's in the plan's currency, Stripe's in the price's
 * currency, `stripeAmountOf`), a currency code, an interval, or whether the price is active.
 */
function WarningValue({
  attribute,
  value,
  side,
  currency,
  stripeCurrency,
}: {
  readonly attribute: string;
  readonly value: string | null;
  readonly side: "plan" | "stripe";
  /** The plan's currency. */
  readonly currency: string;
  /** The currency of the linked price: the plan's, unless a currency warning of the same price names another. */
  readonly stripeCurrency: string;
}): ReactNode {
  if (attribute === "amount" && value !== null) {
    return (
      <Money
        value={
          side === "plan" ? { amount: value, currency } : stripeAmountOf(value, currency, stripeCurrency)
        }
      />
    );
  }
  const monospace = attribute === "currency" || !Object.hasOwn(ATTRIBUTES, attribute);
  return (
    <span className={monospace && value !== null ? "font-mono" : undefined}>
      {valueText(attribute, value, side)}
    </span>
  );
}

/** The currency of the price `link`: Stripe's, when a currency warning of that price names one, else the plan's. */
function stripeCurrencyOf(warnings: readonly PriceWarning[], link: string, planCurrency: string): string {
  const named = warnings.find((warning) => warning.field === `${link}.currency`)?.actual;
  return named === undefined || named === null ? planCurrency : named;
}

/** The warnings of one price, next to its field; "No price warning." for a linked price that agrees with the plan. */
function PriceWarnings({
  id,
  warnings,
  linked,
  currency,
}: {
  readonly id: string;
  readonly warnings: readonly PriceWarning[];
  readonly linked: boolean;
  readonly currency: string;
}) {
  if (warnings.length === 0) {
    return linked ? (
      <p id={id} className="text-sm text-muted-foreground" data-warnings="none">
        {S.noWarning}
      </p>
    ) : null;
  }
  return (
    <div
      id={id}
      className={cn("grid gap-1 rounded-md border px-3 py-2 text-sm", toneClasses("warning"))}
      data-warnings={warnings.length}
    >
      <p className="font-medium">{S.warningCount(warnings.length)}</p>
      <ul className="grid gap-1">
        {warnings.map((warning) => {
          const { link, attribute } = partsOf(warning.field);
          const label = Object.hasOwn(ATTRIBUTES, attribute) ? ATTRIBUTES[attribute] : warning.field;
          const values = { attribute, currency, stripeCurrency: stripeCurrencyOf(warnings, link, currency) };
          return (
            <li key={warning.field} data-warning={warning.field}>
              <span className="font-medium">{label}</span>
              {" · "}
              {S.planSays} <WarningValue {...values} value={warning.expected} side="plan" />
              {" · "}
              {S.stripeSays} <WarningValue {...values} value={warning.actual} side="stripe" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface StripePricesFormProps {
  readonly planCode: string;
  /** The plan's currency, in which both prices are compared and their amounts shown. */
  readonly currency: string;
  /** Whether the plan has a yearly price (`annualPrice`); a linked yearly price without one warns about its amount. */
  readonly hasAnnualPrice: boolean;
  /** The link as the page was rendered with it, with the plan's version for `If-Match`. */
  readonly link: StripeLink;
}

/** The values a form's typing starts from, and their version. */
interface Base {
  readonly version: number;
  readonly values: StripeLinkValues;
}

type ActionId = "save" | "check";

export function StripePricesForm({ planCode, currency, hasAnnualPrice, link }: StripePricesFormProps) {
  const titleId = useId();
  const idPrefix = useId();
  const id = (field: string) => `${idPrefix}-${field}`;
  const form = useRef<HTMLFormElement>(null);

  const fromProps: Base = { version: link.version, values: valuesOfLink(link) };
  const save = useStepUpAction<StripePricesState, FormData>(linkStripePrices, {
    status: "idle",
    values: fromProps.values,
    fieldErrors: {},
  });
  const check = useStepUpAction<PriceCheckState, FormData>(checkPlanPrices, { status: "idle" });
  const [values, setValues] = useState<StripeLinkValues>(fromProps.values);
  const [base, setBase] = useState<Base>(fromProps);
  const [warnings, setWarnings] = useState<readonly PriceWarning[]>(link.priceWarnings);
  // The outcome shown is the one of the action that ran last.
  const [latest, setLatest] = useState<ActionId | undefined>(undefined);

  // Each answer sets the fields and the warnings in the render that shows it: the saved link after a save, the
  // comparison's warnings after a check. A step-up request is no answer yet.
  const [saveAnswer, setSaveAnswer] = useState(save.state);
  if (saveAnswer !== save.state) {
    setSaveAnswer(save.state);
    if (save.state.status === "saved" && save.state.link !== undefined && !isStepUpRequired(save.state)) {
      const saved: Base = { version: save.state.link.version, values: valuesOfLink(save.state.link) };
      setBase(saved);
      setValues(saved.values);
      setWarnings(save.state.link.priceWarnings);
    }
  }
  const [checkAnswer, setCheckAnswer] = useState(check.state);
  if (checkAnswer !== check.state) {
    setCheckAnswer(check.state);
    if (check.state.status === "checked" && !isStepUpRequired(check.state)) {
      setWarnings(check.state.warnings);
    }
  }
  // A newer page (after a save of either form of the page, or a reload) brings the stored warnings, and its link
  // replaces untouched fields; typed fields keep their version, so their save is refused as stale (`412`) instead of
  // overwriting the newer plan.
  const pageKey = JSON.stringify(link);
  const [seenPage, setSeenPage] = useState(pageKey);
  if (seenPage !== pageKey) {
    setSeenPage(pageKey);
    setWarnings(link.priceWarnings);
    if (fromProps.version > base.version && sameValues(values, base.values)) {
      setBase(fromProps);
      setValues(fromProps.values);
    }
  }

  // After a refused save, the focus moves to the first field with a problem, once per answer.
  const handled = useRef(save.state);
  useEffect(() => {
    if (handled.current === save.state) {
      return;
    }
    handled.current = save.state;
    const first = FIELD_ORDER.find((field) => save.state.fieldErrors[field] !== undefined);
    if (first !== undefined) {
      form.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    }
  }, [save.state]);

  const pending = save.isPending || check.isPending;
  const errors = save.state.fieldErrors;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) {
      // A second save while one is on its way would carry the same version and be refused as stale.
      return;
    }
    setLatest("save");
    save.dispatch(new FormData(event.currentTarget));
  }

  function runCheck(): void {
    const formData = new FormData();
    formData.set("planCode", planCode);
    setLatest("check");
    check.dispatch(formData);
  }

  const warningsOf = (priceLink: PriceLink) =>
    warnings.filter((warning) => partsOf(warning.field).link === priceLink);
  const others = warnings.filter((warning) => {
    const { link: named } = partsOf(warning.field);
    return named !== "stripePriceIdMonth" && named !== "stripePriceIdYear";
  });
  // "Check prices" compares the saved links, so it is offered while a saved price is linked.
  const linkedPrice = base.values.stripePriceIdMonth !== "" || base.values.stripePriceIdYear !== "";

  const field = (
    name: StripeLinkField,
    props: { readonly label: string; readonly hint: string; readonly priceLink?: PriceLink },
  ) => {
    const inputId = id(name);
    const hintId = `${inputId}-hint`;
    const errorId = `${inputId}-error`;
    const warningsId = `${inputId}-warnings`;
    const shown = props.priceLink === undefined ? [] : warningsOf(props.priceLink);
    const linked = props.priceLink !== undefined && base.values[props.priceLink] !== "";
    const describedBy = [
      hintId,
      errors[name] === undefined ? undefined : errorId,
      shown.length > 0 || linked ? warningsId : undefined,
    ]
      .filter((value) => value !== undefined)
      .join(" ");
    return (
      <div className="grid content-start gap-2" data-stripe-field={name}>
        <Label htmlFor={inputId}>{props.label}</Label>
        <p id={hintId} className="text-sm text-muted-foreground">
          {props.hint}
        </p>
        <Input
          id={inputId}
          name={name}
          value={values[name]}
          maxLength={STRIPE_ID_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-describedby={describedBy}
          {...(errors[name] === undefined ? {} : { "aria-invalid": true })}
          onChange={(event) => {
            const typed = event.currentTarget.value;
            setValues((current) => ({ ...current, [name]: typed }));
          }}
        />
        {errors[name] === undefined ? null : (
          <p id={errorId} className="text-sm font-medium text-destructive">
            {errors[name]}
          </p>
        )}
        {props.priceLink === undefined ? null : (
          <PriceWarnings id={warningsId} warnings={shown} linked={linked} currency={currency} />
        )}
      </div>
    );
  };

  return (
    <section
      aria-labelledby={titleId}
      className="grid gap-5 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {S.title}
        </h2>
        <p className="text-sm text-muted-foreground">{S.intro}</p>
      </div>
      {latest === "save" ? <SaveOutcome state={save.state} planCode={planCode} /> : null}
      {latest === "check" ? <CheckOutcome state={check.state} /> : null}
      <form ref={form} onSubmit={onSubmit} noValidate aria-labelledby={titleId} className="grid gap-4">
        <input type="hidden" name="planCode" value={planCode} />
        <input type="hidden" name="version" value={String(base.version)} />
        {field("stripeProductId", { label: S.productLabel, hint: S.productHint })}
        <div className="grid gap-4 md:grid-cols-2">
          {field("stripePriceIdMonth", {
            label: S.monthLabel,
            hint: S.monthHint(currency),
            priceLink: "stripePriceIdMonth",
          })}
          {field("stripePriceIdYear", {
            label: S.yearLabel,
            hint: hasAnnualPrice ? S.yearHint(currency) : S.yearHintNoAnnual,
            priceLink: "stripePriceIdYear",
          })}
        </div>
        {others.length === 0 ? null : (
          <PriceWarnings id={id("other-warnings")} warnings={others} linked currency={currency} />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {save.isPending ? S.saving : S.save}
          </Button>
        </div>
      </form>
      <div className="grid gap-2 border-t pt-4">
        <h3 className="text-base font-semibold">{S.checkTitle}</h3>
        <p className="text-sm text-muted-foreground">{S.checkHint}</p>
        {linkedPrice ? (
          <div>
            <Button type="button" variant="outline" disabled={pending} onClick={runCheck}>
              {check.isPending ? S.checking : S.check}
            </Button>
          </div>
        ) : (
          <p className="text-sm">{S.checkNothingLinked}</p>
        )}
      </div>
      {save.stepUpDialog}
      {check.stepUpDialog}
    </section>
  );
}

/** The outcome of the last save: saved (with its warnings in words), or the refusal that belongs to no field. */
function SaveOutcome({ state, planCode }: { readonly state: StripePricesState; readonly planCode: string }) {
  if (isStepUpRequired(state)) {
    return null;
  }
  if (state.status === "saved" && state.link !== undefined) {
    const count = state.link.priceWarnings.length;
    const priceLinked = state.link.stripePriceIdMonth !== null || state.link.stripePriceIdYear !== null;
    return (
      <p role="status" data-notice="saved" className="rounded-lg border px-4 py-3 text-sm font-medium">
        {count > 0 ? S.savedWithWarnings(count) : priceLinked ? S.saved : S.savedNoPrice}
      </p>
    );
  }
  if (state.status !== "failed" || state.message === undefined) {
    return null;
  }
  return (
    <Alert variant="destructive" data-notice="failed" data-code={state.code}>
      <AlertDescription>
        <p>{state.message}</p>
        {state.code === "PRECONDITION_FAILED" ? (
          // A full reload, so the page shows the plan as it is now, with its new version.
          <a
            href={`/plans/${encodeURIComponent(planCode)}`}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {S.reload}
          </a>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** The outcome of the last check: the number of warnings now shown next to the prices, or the refusal. */
function CheckOutcome({ state }: { readonly state: PriceCheckState }) {
  if (state.status === "idle" || isStepUpRequired(state)) {
    return null;
  }
  if (state.status === "failed") {
    return (
      <Alert variant="destructive" data-notice="failed" data-code={state.code}>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <p role="status" data-notice="checked" className="rounded-lg border px-4 py-3 text-sm font-medium">
      {state.warnings.length === 0 ? S.checkedNone : S.checkedSome(state.warnings.length)}
    </p>
  );
}
