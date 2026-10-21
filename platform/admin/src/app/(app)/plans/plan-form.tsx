"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  createPlan,
  setPlanActive,
  updatePlan,
  type EditablePlan,
  type FeatureRow,
  type PlanField,
  type PlanFormState,
  type PlanFormValues,
  type PlanStatusState,
} from "@/app/(app)/plans/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toneClasses, type StatusTone } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  PLAN_DETAIL_STRINGS as D,
  PLAN_FORM_STRINGS as F,
  PLAN_LIST_STRINGS,
  PLAN_STRINGS as P,
} from "@/lib/strings";

/**
 * The plan forms of `/plans` and `/plans/[planCode]` (README §2; subscription-billing flow §A): "New plan", "Edit the
 * plan" and "Retire plan" / "Make the plan active again". The limits and the features are structured fields (four
 * quota fields; one row per feature flag with its name and an on/off switch), never raw JSON. The forms keep what was
 * typed: a refused save shows the problems at their fields, and a stale edit (`412`) asks to reload the page instead
 * of overwriting someone else's change. The props are the few plan fields the forms show: Next.js sends them to the
 * browser.
 */

/** The longest text of each field, as the platform document bounds it (the actions check them again). */
const MAX_LENGTH = {
  code: 40,
  name: 100,
  description: 2000,
  currency: 3,
  amount: 13,
  whole: 9,
  featureName: 64,
} as const;

/** The most feature rows a plan takes (`PlanFeatures.maxProperties`). */
const FEATURES_MAX = 50;

const CHECKBOX_CLASS =
  "mt-0.5 size-4 shrink-0 rounded border-input accent-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

/** The values of a new plan's form: private, active, no features, no yearly option. */
const NEW_PLAN: PlanFormValues = {
  code: "",
  name: "",
  description: "",
  currency: "EUR",
  monthlyPrice: "",
  annualPrice: "",
  trialDays: "14",
  staffSeats: "5",
  apiKeys: "10",
  customDomains: "0",
  liveMode: false,
  features: [],
  isPublic: false,
  sortOrder: "100",
  settlementFeeBps: "0",
};

/** The form's values for a plan as the page shows it. */
function valuesOfPlan(plan: EditablePlan): PlanFormValues {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description ?? "",
    currency: plan.currency,
    monthlyPrice: plan.monthlyPrice,
    annualPrice: plan.annualPrice ?? "",
    trialDays: String(plan.trialDays),
    staffSeats: String(plan.limits.staffSeats),
    apiKeys: String(plan.limits.apiKeys),
    customDomains: String(plan.limits.customDomains),
    liveMode: plan.limits.liveMode,
    features: Object.entries(plan.features).map(([name, on]) => ({ name, on })),
    isPublic: plan.isPublic,
    sortOrder: String(plan.sortOrder),
    settlementFeeBps: String(plan.settlementFeeBps),
  };
}

function sameValues(a: PlanFormValues, b: PlanFormValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The field order of the form, for moving the focus to the first field with a problem. */
const FIELD_ORDER: readonly PlanField[] = [
  "code",
  "name",
  "description",
  "currency",
  "monthlyPrice",
  "annualPrice",
  "trialDays",
  "staffSeats",
  "apiKeys",
  "customDomains",
  "features",
  "sortOrder",
  "settlementFeeBps",
];

// ---- Badges ---------------------------------------------------------------------------------------------------------

/** A plan's state in words, with a tone (colour is never the only signal). Server pages render it too. */
export function PlanBadge({ tone, children }: { readonly tone: StatusTone; readonly children: ReactNode }) {
  return (
    <Badge variant="outline" data-tone={tone} className={toneClasses(tone)}>
      {children}
    </Badge>
  );
}

/**
 * Whether the portal's pricing page offers the plan: `listPlans` answers the public, active plans (PF-70), so a plan is
 * on it exactly when both flags hold. The create-OTA wizard offers the same plans.
 */
export function PricingState({
  isPublic,
  isActive,
}: {
  readonly isPublic: boolean;
  readonly isActive: boolean;
}) {
  if (!isActive) {
    return <PlanBadge tone="neutral">{P.retiredHidden}</PlanBadge>;
  }
  return isPublic ? (
    <PlanBadge tone="success">{P.onPricingPage}</PlanBadge>
  ) : (
    <PlanBadge tone="neutral">{P.notPublic}</PlanBadge>
  );
}

/** Active or retired. */
export function PlanStatus({ isActive }: { readonly isActive: boolean }) {
  return isActive ? (
    <PlanBadge tone="success">{P.active}</PlanBadge>
  ) : (
    <PlanBadge tone="neutral">{P.retired}</PlanBadge>
  );
}

// ---- Fields ---------------------------------------------------------------------------------------------------------

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: (described: {
    readonly "aria-describedby"?: string;
    readonly "aria-invalid"?: true;
  }) => ReactNode;
}

/** A labelled field with its hint and its message; the control gets the matching `aria-*` attributes. */
function Field({ id, label, hint, error, children }: FieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId]
    .filter((value) => value !== undefined)
    .join(" ");
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      {hint === undefined ? null : (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {children({
        ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
        ...(error === undefined ? {} : { "aria-invalid": true }),
      })}
      {error === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  intro,
  children,
}: {
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="grid gap-4 rounded-lg border p-4">
      <legend className="px-1 text-base font-semibold">{title}</legend>
      {intro === undefined ? null : <p className="text-sm text-muted-foreground">{intro}</p>}
      {children}
    </fieldset>
  );
}

function Checkbox({
  id,
  name,
  checked,
  label,
  hint,
  onChange,
}: {
  readonly id: string;
  readonly name: string;
  readonly checked: boolean;
  readonly label: string;
  readonly hint: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        name={name}
        checked={checked}
        aria-describedby={`${id}-hint`}
        className={CHECKBOX_CLASS}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}

/** A refused save: the admin's message, and a full reload of the page for a stale version. */
function FailureNotice({
  state,
  reloadHref,
}: {
  readonly state: PlanFormState;
  readonly reloadHref: string;
}) {
  if (state.status !== "failed" || state.message === undefined) {
    return null;
  }
  return (
    <Alert variant="destructive" data-notice="failed" data-code={state.code}>
      <AlertDescription>
        <p>{state.message}</p>
        {state.code === "PRECONDITION_FAILED" ? (
          // A full reload, so the page shows the plan as it is now, with its new version.
          <a href={reloadHref} className="font-medium text-foreground underline underline-offset-4">
            {F.reload}
          </a>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

// ---- The editor -----------------------------------------------------------------------------------------------------

interface PlanEditorProps {
  readonly mode: "create" | "edit";
  /** The plan's code and the version for `If-Match` (edit only). */
  readonly planCode?: string;
  readonly version: number;
  readonly values: PlanFormValues;
  readonly onValuesChange: (values: PlanFormValues) => void;
  readonly state: PlanFormState;
  readonly isPending: boolean;
  readonly dispatch: (formData: FormData) => void;
  readonly onCancel?: () => void;
  readonly notice?: ReactNode;
}

/** The fields of a plan: the plan, its prices, its limits, its features and its offer. */
function PlanEditor({
  mode,
  planCode,
  version,
  values,
  onValuesChange,
  state,
  isPending,
  dispatch,
  onCancel,
  notice,
}: PlanEditorProps) {
  const titleId = useId();
  const idPrefix = useId();
  const id = (field: string) => `${idPrefix}-${field}`;
  const form = useRef<HTMLFormElement>(null);
  const errors = state.fieldErrors;

  // After a refused save, the focus moves to the first field with a problem, once per answer.
  const handled = useRef(state);
  useEffect(() => {
    if (handled.current === state) {
      return;
    }
    handled.current = state;
    const first = FIELD_ORDER.find((field) => state.fieldErrors[field] !== undefined);
    if (first !== undefined) {
      form.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus();
    }
  }, [state]);

  function set<Field extends keyof PlanFormValues>(field: Field, value: PlanFormValues[Field]): void {
    onValuesChange({ ...values, [field]: value });
  }

  function setFeature(index: number, row: FeatureRow): void {
    set(
      "features",
      values.features.map((current, position) => (position === index ? row : current)),
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      // A second save while one is on its way would carry the same version and be refused as stale.
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  // The prices are in the plan's currency; while a new plan has none yet, the labels say so with a placeholder.
  const currency = values.currency.trim().toUpperCase();
  const shownCurrency = currency === "" ? F.noCurrency : currency;
  const text = (
    field: Exclude<PlanField, "features">,
    props: { label: string; hint?: string; maxLength: number; inputMode?: "decimal" | "numeric" },
  ) => (
    <Field id={id(field)} label={props.label} hint={props.hint} error={errors[field]}>
      {(described) => (
        <Input
          id={id(field)}
          name={field}
          data-field={field}
          value={values[field]}
          maxLength={props.maxLength}
          autoComplete="off"
          spellCheck={false}
          {...(props.inputMode === undefined ? {} : { inputMode: props.inputMode })}
          {...described}
          onChange={(event) => set(field, event.currentTarget.value)}
        />
      )}
    </Field>
  );

  return (
    <form
      ref={form}
      onSubmit={onSubmit}
      noValidate
      aria-labelledby={titleId}
      className="grid gap-5 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {mode === "create" ? F.createTitle : F.editTitle}
        </h2>
        <p className="text-sm text-muted-foreground">{mode === "create" ? F.createIntro : F.editIntro}</p>
      </div>
      {notice}
      <FailureNotice state={state} reloadHref={planCode === undefined ? "/plans" : `/plans/${planCode}`} />
      {mode === "edit" ? (
        <>
          <input type="hidden" name="planCode" value={planCode ?? ""} />
          <input type="hidden" name="version" value={String(version)} />
          <input type="hidden" name="currency" value={values.currency} />
        </>
      ) : null}

      <Section title={D.summaryTitle}>
        <div className="grid gap-4 md:grid-cols-2">
          {mode === "create"
            ? text("code", { label: F.codeLabel, hint: F.codeHint, maxLength: MAX_LENGTH.code })
            : null}
          {text("name", { label: F.nameLabel, hint: F.nameHint, maxLength: MAX_LENGTH.name })}
          {mode === "create"
            ? text("currency", {
                label: F.currencyLabel,
                hint: F.currencyHint,
                maxLength: MAX_LENGTH.currency,
              })
            : null}
        </div>
        <Field
          id={id("description")}
          label={F.descriptionLabel}
          hint={F.descriptionHint}
          error={errors.description}
        >
          {(described) => (
            <Textarea
              id={id("description")}
              name="description"
              data-field="description"
              value={values.description}
              rows={3}
              maxLength={MAX_LENGTH.description}
              {...described}
              onChange={(event) => set("description", event.currentTarget.value)}
            />
          )}
        </Field>
      </Section>

      <Section title={F.pricesTitle} intro={F.pricesIntro(shownCurrency)}>
        <div className="grid gap-4 md:grid-cols-3">
          {text("monthlyPrice", {
            label: F.monthlyPriceLabel(shownCurrency),
            hint: F.monthlyPriceHint,
            maxLength: MAX_LENGTH.amount,
            inputMode: "decimal",
          })}
          {text("annualPrice", {
            label: F.annualPriceLabel(shownCurrency),
            hint: F.annualPriceHint,
            maxLength: MAX_LENGTH.amount,
            inputMode: "decimal",
          })}
          {text("trialDays", {
            label: F.trialDaysLabel,
            hint: F.trialDaysHint,
            maxLength: 3,
            inputMode: "numeric",
          })}
        </div>
      </Section>

      <Section title={F.limitsTitle} intro={F.limitsIntro}>
        <div className="grid gap-4 md:grid-cols-3">
          {text("staffSeats", {
            label: F.staffSeatsLabel,
            hint: F.staffSeatsHint,
            maxLength: MAX_LENGTH.whole,
            inputMode: "numeric",
          })}
          {text("apiKeys", {
            label: F.apiKeysLabel,
            hint: F.apiKeysHint,
            maxLength: MAX_LENGTH.whole,
            inputMode: "numeric",
          })}
          {text("customDomains", {
            label: F.customDomainsLabel,
            hint: F.customDomainsHint,
            maxLength: MAX_LENGTH.whole,
            inputMode: "numeric",
          })}
        </div>
        <Checkbox
          id={id("liveMode")}
          name="liveMode"
          checked={values.liveMode}
          label={F.liveModeLabel}
          hint={F.liveModeHint}
          onChange={(checked) => set("liveMode", checked)}
        />
      </Section>

      <Section title={F.featuresTitle} intro={F.featuresIntro}>
        {values.features.length === 0 ? (
          <p className="text-sm text-muted-foreground">{F.featuresEmpty}</p>
        ) : (
          <ul className="grid gap-3">
            {values.features.map((row, index) => {
              const position = index + 1;
              const nameId = id(`feature-${index}`);
              return (
                // Rows have no identity but their position; the inputs are controlled, so nothing is lost.
                <li key={index} className="flex flex-wrap items-center gap-3">
                  <Label htmlFor={nameId} className="sr-only">
                    {F.featureName(position)}
                  </Label>
                  <Input
                    id={nameId}
                    name="featureName"
                    {...(index === 0 ? { "data-field": "features" } : {})}
                    value={row.name}
                    maxLength={MAX_LENGTH.featureName}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-64 font-mono"
                    {...(errors.features === undefined
                      ? {}
                      : { "aria-invalid": true, "aria-describedby": id("features-error") })}
                    onChange={(event) => setFeature(index, { ...row, name: event.currentTarget.value })}
                  />
                  <span className="flex items-center gap-2 text-sm">
                    <input
                      id={`${nameId}-on`}
                      type="checkbox"
                      name="featureOn"
                      value={String(index)}
                      checked={row.on}
                      aria-label={F.featureOn(position)}
                      className={CHECKBOX_CLASS}
                      onChange={(event) => setFeature(index, { ...row, on: event.currentTarget.checked })}
                    />
                    <span aria-hidden="true">{F.featureOnShort}</span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      set(
                        "features",
                        values.features.filter((_, position) => position !== index),
                      )
                    }
                  >
                    {F.removeFeature}
                    <span className="sr-only">{F.removeFeatureOf(position)}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {errors.features === undefined ? null : (
          <p id={id("features-error")} className="text-sm font-medium text-destructive">
            {errors.features}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={values.features.length >= FEATURES_MAX}
            onClick={() => set("features", [...values.features, { name: "", on: true }])}
          >
            {F.addFeature}
          </Button>
        </div>
      </Section>

      <Section title={F.offerTitle}>
        <Checkbox
          id={id("isPublic")}
          name="isPublic"
          checked={values.isPublic}
          label={F.isPublicLabel}
          hint={F.isPublicHint}
          onChange={(checked) => set("isPublic", checked)}
        />
        <div className="grid gap-4 md:grid-cols-2">
          {text("sortOrder", {
            label: F.sortOrderLabel,
            hint: F.sortOrderHint,
            maxLength: 5,
            inputMode: "numeric",
          })}
          {text("settlementFeeBps", {
            label: F.settlementFeeLabel,
            hint: F.settlementFeeHint,
            maxLength: 5,
            inputMode: "numeric",
          })}
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={isPending}>
          {mode === "create" ? (isPending ? F.creating : F.create) : isPending ? F.saving : F.save}
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" variant="outline" onClick={onCancel}>
            {F.cancel}
          </Button>
        )}
      </div>
    </form>
  );
}

// ---- New plan -------------------------------------------------------------------------------------------------------

const IDLE_CREATE: PlanFormState = { status: "idle", version: 0, values: NEW_PLAN, fieldErrors: {} };

export interface CreatePlanFormProps {
  /** The portal's pricing page (`PUBLIC_PORTAL_URL/pricing`), linked after a public plan is created. */
  readonly pricingUrl: string;
}

/**
 * "New plan" on `/plans`: the button opens the form; a created plan closes it and says whether the portal's pricing
 * page now offers the plan (public plans are active from the start), with links to the plan and to the pricing page.
 * The revalidated list shows the plan at once.
 */
export function CreatePlanForm({ pricingUrl }: CreatePlanFormProps) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<EditablePlan | undefined>(undefined);

  return (
    <div className="grid gap-4">
      {created === undefined ? null : (
        <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">{F.created(created.name)}</p>
          <p>{created.isPublic && created.isActive ? F.createdPublic : F.createdHidden}</p>
          <p className="flex flex-wrap gap-4">
            <Link
              href={`/plans/${encodeURIComponent(created.code)}`}
              className="font-medium underline underline-offset-4"
            >
              {F.openPlan} <span className="font-mono text-xs">{created.code}</span>
            </Link>
            {created.isPublic && created.isActive ? (
              <a href={pricingUrl} className="font-medium underline underline-offset-4">
                {PLAN_LIST_STRINGS.pricingPageLink}
              </a>
            ) : null}
          </p>
        </div>
      )}
      {open ? (
        <NewPlanEditor
          onCancel={() => setOpen(false)}
          onCreated={(plan) => {
            setCreated(plan);
            setOpen(false);
          }}
        />
      ) : (
        <div>
          <Button
            onClick={() => {
              setCreated(undefined);
              setOpen(true);
            }}
          >
            {F.newPlan}
          </Button>
        </div>
      )}
    </div>
  );
}

function NewPlanEditor({
  onCancel,
  onCreated,
}: {
  readonly onCancel: () => void;
  readonly onCreated: (plan: EditablePlan) => void;
}) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(createPlan, IDLE_CREATE);
  const [values, setValues] = useState<PlanFormValues>(state.values);

  // A creation closes the form, once per answer.
  const handled = useRef(state);
  useEffect(() => {
    if (handled.current === state) {
      return;
    }
    handled.current = state;
    if (state.status === "saved" && state.plan !== undefined) {
      onCreated(state.plan);
    }
  }, [state, onCreated]);

  return (
    <>
      <PlanEditor
        mode="create"
        version={0}
        values={values}
        onValuesChange={setValues}
        state={state}
        isPending={isPending}
        dispatch={dispatch}
        onCancel={onCancel}
      />
      {stepUpDialog}
    </>
  );
}

// ---- Edit -----------------------------------------------------------------------------------------------------------

export interface EditPlanFormProps {
  /** The plan as the page was rendered with it, with its version for `If-Match`. */
  readonly plan: EditablePlan;
}

/** The values a form's typing starts from, and their version. */
interface Base {
  readonly version: number;
  readonly values: PlanFormValues;
}

/**
 * "Edit the plan" on `/plans/[planCode]`: every field but the code and the currency, sent with the version the values
 * come from in `If-Match`. A save shows "The plan is saved" and the next save sends the new version. When the page
 * comes back with a newer version (after "Retire plan", or a reload) the form takes the new values, unless the admin
 * has typed something: then it keeps the typing and its old version, so the save is refused as stale (`412`) instead
 * of overwriting the newer plan.
 */
export function EditPlanForm({ plan }: EditPlanFormProps) {
  const fromProps: Base = { version: plan.version, values: valuesOfPlan(plan) };
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(updatePlan, {
    status: "idle",
    version: fromProps.version,
    values: fromProps.values,
    fieldErrors: {},
  });
  const [values, setValues] = useState<PlanFormValues>(fromProps.values);
  const [base, setBase] = useState<Base>(fromProps);

  // Each answer of the action sets the fields, in the render that shows it: the saved plan after a save.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    if (state.status === "saved" && state.plan !== undefined) {
      const saved: Base = { version: state.plan.version, values: valuesOfPlan(state.plan) };
      setBase(saved);
      setValues(saved.values);
    }
  }
  // A newer plan from the page replaces untouched values.
  if (fromProps.version > base.version && sameValues(values, base.values)) {
    setBase(fromProps);
    setValues(fromProps.values);
  }

  return (
    <>
      <PlanEditor
        mode="edit"
        planCode={plan.code}
        version={base.version}
        values={values}
        onValuesChange={setValues}
        state={state}
        isPending={isPending}
        dispatch={dispatch}
        notice={
          state.status === "saved" ? (
            <p role="status" data-notice="saved" className="rounded-lg border px-4 py-3 text-sm font-medium">
              {F.saved}
            </p>
          ) : null
        }
      />
      {stepUpDialog}
    </>
  );
}

// ---- Retire and reactivate ------------------------------------------------------------------------------------------

const IDLE_STATUS: PlanStatusState = { status: "idle" };

export interface PlanStatusFormProps {
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  /** The plan version the page was rendered with. */
  readonly version: number;
}

/**
 * "Retire plan" on an active plan and "Make the plan active again" on a retired one, each behind `ConfirmDialog`. A
 * retired plan leaves the pricing page and the create-OTA wizard at once; its OTAs keep it. The outcome stays while the
 * revalidated page shows the plan's new state.
 */
export function PlanStatusForm({ code, name, isActive, version }: PlanStatusFormProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(setPlanActive, IDLE_STATUS);
  // The newest version known here: the page's, or the one the last action answered.
  const done = state.status === "done" && state.version > version ? state : undefined;
  const active = done === undefined ? isActive : done.isActive;
  const currentVersion = done === undefined ? version : done.version;

  function run(nextActive: boolean): void {
    const formData = new FormData();
    formData.set("planCode", code);
    formData.set("version", String(currentVersion));
    formData.set("isActive", String(nextActive));
    dispatch(formData);
  }

  return (
    <div className="grid gap-3">
      {active ? null : <p className="text-sm">{D.retiredNotice}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {active ? (
          <ConfirmDialog
            trigger={
              <Button variant="destructive" disabled={isPending}>
                {D.retire}
              </Button>
            }
            title={D.retireTitle(name)}
            description={D.retireDescription}
            confirmLabel={D.retireConfirm}
            onConfirm={() => run(false)}
          />
        ) : (
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={isPending}>
                {D.reactivate}
              </Button>
            }
            title={D.reactivateTitle(name)}
            description={D.reactivateDescription}
            confirmLabel={D.reactivateConfirm}
            destructive={false}
            onConfirm={() => run(true)}
          />
        )}
        {isPending ? <span className="text-sm text-muted-foreground">{D.working}</span> : null}
      </div>
      {state.status === "failed" ? (
        <Alert variant="destructive" data-notice="failed" data-code={state.code}>
          <AlertDescription>
            <p>{state.message}</p>
            {state.code === "PRECONDITION_FAILED" ? (
              <a
                href={`/plans/${encodeURIComponent(code)}`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                {F.reload}
              </a>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {state.status === "done" ? (
        <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
          {state.isActive ? D.reactivatedDone : D.retiredDone}
        </p>
      ) : null}
      {stepUpDialog}
    </div>
  );
}
