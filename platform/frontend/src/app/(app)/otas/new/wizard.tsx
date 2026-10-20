"use client";

import {
  memo,
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import {
  createOta,
  type CreateOtaField,
  type CreateOtaState,
  type WizardStep,
} from "@/app/(app)/otas/new/actions";
import {
  KeyAvailabilityField,
  TENANT_KEY_PATTERN,
  isKeyRefused,
  keyFromName,
  keyStatusText,
  type KeyFieldCheck,
} from "@/app/(app)/otas/new/key-availability-field";
import { PlanPicker, type Plan } from "@/app/(app)/otas/new/plan-picker";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { WIZARD_STEP_LABELS, WIZARD_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The create-OTA wizard of `/otas/new` (README §2 and §4 `Wizard`; flow signup-and-create-ota.md step 5; PF-10):
 *
 * 1. *OTA details*: name, key (prefilled from the name until the person edits it, with `KeyAvailabilityField`),
 *    country, default currency and time zone;
 * 2. *Plan*: `PlanPicker` (before M5 only `early_access`);
 * 3. *Review*, then "Create OTA".
 *
 * All three steps are one form, so the final submit sends every field. "Continue" checks the fields of its step in
 * the browser; the `createOta` action checks them all again. The `Idempotency-Key` the page made when the wizard
 * opened travels in a hidden field with every submit, so a double click or a retry creates one OTA (PF-10 AC2). A
 * refused submit returns to the step of its first problem: `TENANT_KEY_UNAVAILABLE` to step 1 with the message at
 * the key, the tenant limit stays on the review (PF-10 AC4). Nothing here is secret.
 */

/** One option of a select: an ISO code or a time zone, and its name in the portal's English. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** The steps, in order. */
const STEPS: readonly WizardStep[] = ["details", "plan", "review"];

/** The fields of each step, in form order. */
const STEP_FIELDS: Readonly<Record<WizardStep, readonly CreateOtaField[]>> = {
  details: ["name", "key", "countryCode", "defaultCurrency", "timeZone"],
  plan: ["planCode"],
  review: [],
};

/** The state before the first submission. */
const INITIAL_STATE: CreateOtaState = Object.freeze({ status: "idle", fieldErrors: Object.freeze({}) });

type Values = Readonly<Record<CreateOtaField, string>>;
type FieldErrors = Readonly<Partial<Record<CreateOtaField, string>>>;

/** The problems on screen: messages at the fields, and the summary above the step. */
interface Problems {
  readonly fieldErrors: FieldErrors;
  readonly summary: readonly FormErrorItem[];
}

const NO_PROBLEMS: Problems = Object.freeze({ fieldErrors: Object.freeze({}), summary: Object.freeze([]) });

/** The problems of `step`: its field errors in form order, then a problem of no field. */
function problemsOf(step: WizardStep, fieldErrors: FieldErrors, message?: string): Problems {
  const summary: FormErrorItem[] = [];
  for (const field of STEP_FIELDS[step]) {
    const text = fieldErrors[field];
    if (text !== undefined) {
      summary.push({ message: text, fieldId: fieldId(field) });
    }
  }
  if (message !== undefined) {
    summary.push({ message });
  }
  return { fieldErrors, summary };
}

/** The length of a text as the API counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

/** `value` is one of `options`. */
function isOption(options: readonly SelectOption[], value: string): boolean {
  return options.some((option) => option.value === value);
}

/** The label of `value` among `options`, or the value itself. */
function labelOf(options: readonly SelectOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * The `<option>`s of a select: its placeholder, then `options`. Memoised, so that typing in another field (each
 * keystroke renders the wizard) does not render the some 850 options of the three selects again; their lists come
 * from the page and do not change while the wizard is open.
 */
const SelectOptions = memo(function SelectOptions({
  placeholder,
  options,
}: {
  readonly placeholder: string;
  readonly options: readonly SelectOption[];
}) {
  return (
    <>
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </>
  );
});

const SELECT_CLASSES = cn(
  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
);

export interface WizardProps {
  /** The `Idempotency-Key` of this wizard, made on the server when the page opened (a UUID). */
  readonly idempotencyKey: string;
  /** `STOREFRONT_BASE_DOMAIN`: the key's storefront host is `<key>.<STOREFRONT_BASE_DOMAIN>`. */
  readonly storefrontBaseDomain: string;
  readonly countries: readonly SelectOption[];
  readonly currencies: readonly SelectOption[];
  readonly timeZones: readonly SelectOption[];
  /** The preselected time zone (the account's own). */
  readonly defaultTimeZone: string;
  /** The plans to offer (`wizardPlans`). */
  readonly plans: readonly Plan[];
  /** The preselected plan: before M5 always `early_access`. */
  readonly defaultPlanCode: string;
  /** A note above the plans. */
  readonly planNote?: string | undefined;
  /** Shown instead of the plans when they could not be loaded. */
  readonly plansUnavailable?: string | undefined;
}

/** The create-OTA wizard: three steps in one form, posted to `createOta` with the wizard's `Idempotency-Key`. */
export function Wizard({
  idempotencyKey,
  storefrontBaseDomain,
  countries,
  currencies,
  timeZones,
  defaultTimeZone,
  plans,
  defaultPlanCode,
  planNote,
  plansUnavailable,
}: WizardProps) {
  const [state, dispatch, pending] = useActionState(createOta, INITIAL_STATE);
  const [step, setStep] = useState<WizardStep>("details");
  const [values, setValues] = useState<Values>({
    name: "",
    key: "",
    countryCode: "",
    defaultCurrency: "",
    timeZone: defaultTimeZone,
    planCode: defaultPlanCode,
  });
  // The key follows the name until the person types a key of their own (and again once they empty it).
  const [keyEdited, setKeyEdited] = useState(false);
  const [keyCheck, setKeyCheck] = useState<KeyFieldCheck>({ key: "", status: "empty" });
  const [problems, setProblems] = useState<Problems>(NO_PROBLEMS);

  const headings: Record<WizardStep, RefObject<HTMLHeadingElement | null>> = {
    details: useRef<HTMLHeadingElement>(null),
    plan: useRef<HTMLHeadingElement>(null),
    review: useRef<HTMLHeadingElement>(null),
  };
  const moved = useRef(false);

  // A refused submission: back to the step of its first problem, with the problems shown there.
  useEffect(() => {
    if (state === INITIAL_STATE) {
      return;
    }
    const target = state.step ?? "review";
    setStep(target);
    setProblems(problemsOf(target, state.fieldErrors, state.message));
    if (state.code === "TENANT_KEY_UNAVAILABLE") {
      // The key that was sent is the one last checked (the review step cannot change it): it may have been free when
      // the live check ran, but the API has refused it since, so "Continue" must not take it again.
      setKeyCheck((previous) => ({ key: previous.key, status: "unavailable" }));
    }
  }, [state]);

  // A new step takes the focus on its heading, unless the error summary of a refused step takes it.
  useEffect(() => {
    if (!moved.current) {
      return;
    }
    moved.current = false;
    if (problems.summary.length === 0) {
      headings[step].current?.focus();
    }
  });

  function go(target: WizardStep): void {
    moved.current = true;
    setProblems(NO_PROBLEMS);
    setStep(target);
  }

  function setValue(field: CreateOtaField, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  /**
   * Drops the message at the key once the key changes, so the field shows the live check of the new key instead of a
   * problem of the old one. The summary stays as it is (a new summary would take the focus from the field).
   */
  function keyChanged(): void {
    setProblems((previous) => {
      if (previous.fieldErrors.key === undefined) {
        return previous;
      }
      const fieldErrors: Partial<Record<CreateOtaField, string>> = { ...previous.fieldErrors };
      delete fieldErrors.key;
      return { ...previous, fieldErrors };
    });
  }

  function setName(name: string): void {
    setValues((previous) => ({ ...previous, name, key: keyEdited ? previous.key : keyFromName(name) }));
    if (!keyEdited && keyFromName(name) !== values.key) {
      keyChanged();
    }
  }

  function setKey(key: string): void {
    setKeyEdited(key !== "");
    setValue("key", key);
    if (key !== values.key) {
      keyChanged();
    }
  }

  /** The problems of the fields of `current` that the browser can see. */
  function stepErrors(current: WizardStep): FieldErrors {
    const errors: Partial<Record<CreateOtaField, string>> = {};
    if (current === "details") {
      const name = values.name.trim();
      if (name === "") {
        errors.name = WIZARD_STRINGS.nameRequired;
      } else if (codePoints(name) > 100) {
        errors.name = WIZARD_STRINGS.nameTooLong;
      }
      if (values.key === "") {
        errors.key = WIZARD_STRINGS.keyRequired;
      } else if (!TENANT_KEY_PATTERN.test(values.key)) {
        errors.key = WIZARD_STRINGS.keyInvalid;
      } else if (keyCheck.key === values.key && isKeyRefused(keyCheck.status)) {
        // Taken, reserved, or refused by the last submit.
        errors.key = keyStatusText(keyCheck.status) ?? WIZARD_STRINGS.keyTaken;
      }
      if (values.countryCode === "") {
        errors.countryCode = WIZARD_STRINGS.countryRequired;
      } else if (!isOption(countries, values.countryCode)) {
        errors.countryCode = WIZARD_STRINGS.countryUnknown;
      }
      if (values.defaultCurrency === "") {
        errors.defaultCurrency = WIZARD_STRINGS.currencyRequired;
      } else if (!isOption(currencies, values.defaultCurrency)) {
        errors.defaultCurrency = WIZARD_STRINGS.currencyUnknown;
      }
      if (values.timeZone === "") {
        errors.timeZone = WIZARD_STRINGS.timeZoneRequired;
      } else if (!isOption(timeZones, values.timeZone)) {
        errors.timeZone = WIZARD_STRINGS.timeZoneUnknown;
      }
    }
    if (current === "plan" && values.planCode === "") {
      errors.planCode = WIZARD_STRINGS.planRequired;
    }
    return errors;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (step !== "review") {
      // "Continue" (or Enter in a field): check this step, then go on.
      const errors = stepErrors(step);
      if (Object.keys(errors).length > 0) {
        setProblems(problemsOf(step, errors));
        return;
      }
      go(STEPS[STEPS.indexOf(step) + 1] ?? "review");
      return;
    }
    // Every submit of this wizard carries the same hidden Idempotency-Key. React runs the queued submits one after
    // the other; the API answers a repeat with the stored 202, so one OTA is created (PF-10 AC2).
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(formData);
    });
  }

  const stepIndex = STEPS.indexOf(step);
  const storefrontHost = `${values.key}.${storefrontBaseDomain}`;
  const planName = plans.find((plan) => plan.code === values.planCode)?.name ?? values.planCode;

  function heading(id: WizardStep) {
    return (
      <h2
        ref={headings[id]}
        id={`wizard-step-${id}`}
        tabIndex={-1}
        className="text-xl font-semibold tracking-tight focus:outline-none"
      >
        {WIZARD_STEP_LABELS[id]}
      </h2>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-8">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div>
        <p className="mb-2 text-sm text-muted-foreground">
          {WIZARD_STRINGS.stepOf(stepIndex + 1, STEPS.length)}
        </p>
        <ol aria-label={WIZARD_STRINGS.progressLabel} className="flex flex-wrap gap-2 text-sm">
          {STEPS.map((id, index) => (
            <li
              key={id}
              aria-current={id === step ? "step" : undefined}
              className={cn(
                "rounded-full border px-3 py-1",
                id === step ? "border-primary bg-primary text-primary-foreground" : undefined,
                index < stepIndex ? "border-primary" : undefined,
              )}
            >
              {WIZARD_STEP_LABELS[id]}
            </li>
          ))}
        </ol>
      </div>

      <FormErrorSummary errors={problems.summary} />

      <section hidden={step !== "details"} aria-labelledby="wizard-step-details" className="grid gap-5">
        {heading("details")}
        <FormField
          label={WIZARD_STRINGS.nameLabel}
          name="name"
          description={WIZARD_STRINGS.nameHint}
          error={problems.fieldErrors.name}
          value={values.name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="organization"
          maxLength={100}
        />
        <KeyAvailabilityField
          value={values.key}
          onChange={setKey}
          baseDomain={storefrontBaseDomain}
          check={keyCheck}
          onCheck={setKeyCheck}
          error={problems.fieldErrors.key}
        />
        <FormField
          label={WIZARD_STRINGS.countryLabel}
          name="countryCode"
          description={WIZARD_STRINGS.countryHint}
          error={problems.fieldErrors.countryCode}
        >
          {(control) => (
            <select
              {...control}
              value={values.countryCode}
              onChange={(event) => setValue("countryCode", event.target.value)}
              autoComplete="country"
              className={SELECT_CLASSES}
            >
              <SelectOptions placeholder={WIZARD_STRINGS.countryPlaceholder} options={countries} />
            </select>
          )}
        </FormField>
        <FormField
          label={WIZARD_STRINGS.currencyLabel}
          name="defaultCurrency"
          description={WIZARD_STRINGS.currencyHint}
          error={problems.fieldErrors.defaultCurrency}
        >
          {(control) => (
            <select
              {...control}
              value={values.defaultCurrency}
              onChange={(event) => setValue("defaultCurrency", event.target.value)}
              className={SELECT_CLASSES}
            >
              <SelectOptions placeholder={WIZARD_STRINGS.currencyPlaceholder} options={currencies} />
            </select>
          )}
        </FormField>
        <FormField
          label={WIZARD_STRINGS.timeZoneLabel}
          name="timeZone"
          description={WIZARD_STRINGS.timeZoneHint}
          error={problems.fieldErrors.timeZone}
        >
          {(control) => (
            <select
              {...control}
              value={values.timeZone}
              onChange={(event) => setValue("timeZone", event.target.value)}
              className={SELECT_CLASSES}
            >
              <SelectOptions placeholder={WIZARD_STRINGS.timeZonePlaceholder} options={timeZones} />
            </select>
          )}
        </FormField>
      </section>

      <section hidden={step !== "plan"} aria-labelledby="wizard-step-plan" className="grid gap-5">
        {heading("plan")}
        <PlanPicker
          plans={plans}
          value={values.planCode}
          onChange={(code) => setValue("planCode", code)}
          note={planNote}
          unavailable={plansUnavailable}
          error={problems.fieldErrors.planCode}
        />
      </section>

      <section hidden={step !== "review"} aria-labelledby="wizard-step-review" className="grid gap-5">
        {heading("review")}
        <p className="text-sm text-muted-foreground">{WIZARD_STRINGS.reviewIntro}</p>
        <dl className="grid gap-x-6 gap-y-3 rounded-xl border p-4 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">{WIZARD_STRINGS.nameLabel}</dt>
          <dd>{values.name.trim()}</dd>
          <dt className="text-muted-foreground">{WIZARD_STRINGS.keyLabel}</dt>
          <dd>{values.key}</dd>
          <dt className="text-muted-foreground">{WIZARD_STRINGS.storefrontAddress}</dt>
          <dd>{storefrontHost}</dd>
          <dt className="text-muted-foreground">{WIZARD_STRINGS.countryLabel}</dt>
          <dd>{labelOf(countries, values.countryCode)}</dd>
          <dt className="text-muted-foreground">{WIZARD_STRINGS.currencyLabel}</dt>
          <dd>{labelOf(currencies, values.defaultCurrency)}</dd>
          <dt className="text-muted-foreground">{WIZARD_STRINGS.timeZoneLabel}</dt>
          <dd>{labelOf(timeZones, values.timeZone)}</dd>
          <dt className="text-muted-foreground">{WIZARD_STEP_LABELS.plan}</dt>
          <dd>{planName}</dd>
        </dl>
        <div className="flex flex-wrap gap-3">
          {(["details", "plan"] as const).map((id) => (
            <Button key={id} type="button" variant="outline" size="sm" onClick={() => go(id)}>
              {WIZARD_STRINGS.change}
              <span className="sr-only">{WIZARD_STRINGS.changeWhat(WIZARD_STEP_LABELS[id])}</span>
            </Button>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={pending}>
          {step !== "review"
            ? WIZARD_STRINGS.next
            : pending
              ? WIZARD_STRINGS.submitting
              : WIZARD_STRINGS.submit}
        </Button>
        {stepIndex === 0 ? null : (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={pending}
            onClick={() => go(STEPS[stepIndex - 1] ?? "details")}
          >
            {WIZARD_STRINGS.back}
          </Button>
        )}
      </div>
    </form>
  );
}
