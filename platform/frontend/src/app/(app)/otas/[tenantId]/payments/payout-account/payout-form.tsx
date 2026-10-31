"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent, type ReactElement } from "react";

import {
  savePayoutAccount,
  type PayoutField,
  type PayoutScheme,
  type PayoutState,
  type PayoutValues,
} from "@/app/(app)/otas/[tenantId]/payments/payout-account/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SelectOption } from "@/lib/reference-options";
import { otaPath } from "@/lib/roles";
import { PAYOUT_ACCOUNT_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The owners' payout account form (README §2 `/otas/[tenantId]/payments/payout-account`; flows/stripe-payments-account.md
 * §B; PF-64 AC1): the holder, the bank's country, the currency, and either an IBAN (with an optional BIC) or a local
 * account and routing number. `savePayoutAccount` checks the fields and calls `setPayoutAccount`, which needs a TOTP
 * step-up: `useStepUpAction` opens `StepUpDialog` on `REAUTH_REQUIRED` and sends the same form again after the code.
 * The form says before the save that the account goes back to pending review (a rejected account saved again too).
 *
 * The bank identifiers live in this component's state only, while the person types: the page never has them (the API
 * never answers them), the action never returns them, and after a save the fields are empty again. A refused save keeps
 * what was typed, so it can be corrected.
 */

/** The bank identifier fields, kept apart from the values the action returns. */
interface BankNumbers {
  readonly iban: string;
  readonly bic: string;
  readonly accountNumber: string;
  readonly routingNumber: string;
}

const NO_NUMBERS: BankNumbers = { iban: "", bic: "", accountNumber: "", routingNumber: "" };

/** The id of a field's control. */
function inputId(field: PayoutField | `scheme-${PayoutScheme}`): string {
  return `payout-${field}`;
}

/** The fields in form order, for the error summary. */
const FIELD_ORDER: readonly PayoutField[] = [
  "accountHolderName",
  "countryCode",
  "currency",
  "scheme",
  "iban",
  "bic",
  "accountNumber",
  "routingNumber",
];

/** The entries of the error summary, in form order, each linked to its field, then a problem of no field. */
function summaryOf(state: PayoutState): FormErrorItem[] {
  const items: FormErrorItem[] = [];
  for (const field of FIELD_ORDER) {
    const message = state.fieldErrors[field];
    if (message !== undefined) {
      items.push({ message, fieldId: field === "scheme" ? inputId("scheme-iban") : inputId(field) });
    }
  }
  if (state.message !== undefined) {
    items.push({ message: state.message });
  }
  return items;
}

/** The `<option>`s of a select. */
function optionElements(options: readonly SelectOption[]): ReactElement[] {
  return options.map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ));
}

const SELECT_CLASSES = cn(
  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export interface PayoutFormProps {
  readonly tenantId: string;
  /** The holder, country, currency and scheme the fields start with: the stored account's, or the OTA's defaults. */
  readonly initialValues: PayoutValues;
  /** The OTA has a payout account already: the form changes it rather than adding one. */
  readonly hasAccount: boolean;
  /** The countries of the reference data, named. */
  readonly countries: readonly SelectOption[];
  /** The active currencies of the reference data, named. */
  readonly currencies: readonly SelectOption[];
}

/** The message after a save, by the review status the API answered. */
function savedMessage(state: PayoutState): string | undefined {
  if (state.status !== "saved" || state.account === undefined) {
    return undefined;
  }
  return state.account.status === "verified"
    ? PAYOUT_ACCOUNT_STRINGS.savedVerified
    : PAYOUT_ACCOUNT_STRINGS.savedPending;
}

/** The form; its fields are controlled and posted in a transition, so nothing resets them behind the person's back. */
export function PayoutForm({ tenantId, initialValues, hasAccount, countries, currencies }: PayoutFormProps) {
  const initialState = useMemo<PayoutState>(
    () => ({ status: "idle", values: initialValues, fieldErrors: {} }),
    [initialValues],
  );
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(savePayoutAccount, initialState);
  // From the state, not the props: a form posted before the page hydrated comes back rendered with the action's
  // answer, and its fields show what was sent (never the bank numbers, which the state does not hold).
  const [values, setValues] = useState<PayoutValues>(state.values);
  const [numbers, setNumbers] = useState<BankNumbers>(NO_NUMBERS);
  // A new array per answer, so the summary takes the focus again after each refused save.
  const summary = useMemo(() => summaryOf(state), [state]);
  // Built once: a keystroke in another field re-renders the form, and the same elements let React skip the options.
  const countryOptions = useMemo(() => optionElements(countries), [countries]);
  const currencyOptions = useMemo(() => optionElements(currencies), [currencies]);

  // Each answer sets the fields in the render that shows it: after a save the saved values and empty bank numbers,
  // after a refusal what was sent (the bank numbers stay as typed).
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setValues(state.values);
    if (state.status === "saved") {
      setNumbers(NO_NUMBERS);
    }
  }

  function setValue<Field extends keyof PayoutValues>(field: Field, value: PayoutValues[Field]): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function setNumber(field: keyof BankNumbers, value: string): void {
    setNumbers((previous) => ({ ...previous, [field]: value }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    // React would reset the fields after the action; the component's state already holds them.
    event.preventDefault();
    if (isPending) {
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  const { fieldErrors } = state;
  const saved = savedMessage(state);
  return (
    <section aria-labelledby="payout-form-title" className="grid gap-6" data-payout-form="">
      <div className="grid gap-2">
        <h2 id="payout-form-title" className="text-xl font-semibold tracking-tight">
          {hasAccount ? PAYOUT_ACCOUNT_STRINGS.formTitleChange : PAYOUT_ACCOUNT_STRINGS.formTitleAdd}
        </h2>
        <p className="text-sm text-muted-foreground" data-step-up-note="">
          {PAYOUT_ACCOUNT_STRINGS.formIntro}
        </p>
      </div>

      {/* `action` keeps a form sent before the page hydrated from going out as a GET with its fields in the URL. */}
      <form
        action={dispatch}
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="payout-form-title"
        className="grid gap-6"
      >
        <input type="hidden" name="tenantId" value={tenantId} />
        <FormErrorSummary errors={summary} />
        {state.code === "MFA_REQUIRED" ? (
          <p className="text-sm">
            <Link href="/account/security" className="font-medium underline underline-offset-4">
              {PAYOUT_ACCOUNT_STRINGS.mfaLink}
            </Link>
          </p>
        ) : null}
        {state.reload === true ? (
          <p className="text-sm">
            {/* A full reload, so the page shows the account and the role as they are now. */}
            <a
              href={otaPath(tenantId, "/payments/payout-account")}
              className="font-medium underline underline-offset-4"
            >
              {PAYOUT_ACCOUNT_STRINGS.reload}
            </a>
          </p>
        ) : null}
        {saved === undefined ? null : (
          <Alert role="status" data-saved={state.account?.status}>
            <AlertDescription>{saved}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-5">
          <FormField
            id={inputId("accountHolderName")}
            name="accountHolderName"
            label={PAYOUT_ACCOUNT_STRINGS.holderLabel}
            description={PAYOUT_ACCOUNT_STRINGS.holderHint}
            error={fieldErrors.accountHolderName}
            value={values.accountHolderName}
            onChange={(event) => setValue("accountHolderName", event.target.value)}
            autoComplete="off"
            required
            maxLength={200}
          />
          <FormField
            id={inputId("countryCode")}
            name="countryCode"
            label={PAYOUT_ACCOUNT_STRINGS.countryLabel}
            description={PAYOUT_ACCOUNT_STRINGS.countryHint}
            error={fieldErrors.countryCode}
          >
            {(control) => (
              <select
                {...control}
                value={values.countryCode}
                onChange={(event) => setValue("countryCode", event.target.value)}
                required
                className={SELECT_CLASSES}
              >
                <option value="">{PAYOUT_ACCOUNT_STRINGS.countryPlaceholder}</option>
                {countryOptions}
              </select>
            )}
          </FormField>
          <FormField
            id={inputId("currency")}
            name="currency"
            label={PAYOUT_ACCOUNT_STRINGS.currencyLabel}
            description={PAYOUT_ACCOUNT_STRINGS.currencyHint}
            error={fieldErrors.currency}
          >
            {(control) => (
              <select
                {...control}
                value={values.currency}
                onChange={(event) => setValue("currency", event.target.value)}
                required
                className={SELECT_CLASSES}
              >
                <option value="">{PAYOUT_ACCOUNT_STRINGS.currencyPlaceholder}</option>
                {currencyOptions}
              </select>
            )}
          </FormField>

          <fieldset
            className="grid gap-3"
            aria-describedby={fieldErrors.scheme === undefined ? undefined : `${inputId("scheme")}-error`}
          >
            <legend className="mb-2 text-sm font-medium">{PAYOUT_ACCOUNT_STRINGS.schemeLegend}</legend>
            {(
              [
                ["iban", PAYOUT_ACCOUNT_STRINGS.schemeIban, PAYOUT_ACCOUNT_STRINGS.schemeIbanHint],
                ["local", PAYOUT_ACCOUNT_STRINGS.schemeLocal, PAYOUT_ACCOUNT_STRINGS.schemeLocalHint],
              ] as const
            ).map(([scheme, label, hint]) => {
              const id = inputId(`scheme-${scheme}`);
              return (
                <div
                  key={scheme}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-4",
                    values.scheme === scheme ? "border-primary ring-1 ring-primary" : undefined,
                  )}
                >
                  <input
                    type="radio"
                    id={id}
                    name="scheme"
                    value={scheme}
                    checked={values.scheme === scheme}
                    onChange={() => setValue("scheme", scheme)}
                    aria-describedby={`${id}-hint`}
                    className="mt-1 size-4 shrink-0 accent-primary"
                  />
                  <div className="grid flex-1 gap-1">
                    <label htmlFor={id} className="font-semibold">
                      {label}
                    </label>
                    <span id={`${id}-hint`} className="text-sm text-muted-foreground">
                      {hint}
                    </span>
                  </div>
                </div>
              );
            })}
            {fieldErrors.scheme === undefined ? null : (
              <p id={`${inputId("scheme")}-error`} className="text-sm font-medium text-destructive">
                {fieldErrors.scheme}
              </p>
            )}
          </fieldset>

          {/* Only the fields of the chosen scheme are rendered, so only they are sent. */}
          {values.scheme === "iban" ? (
            <>
              <FormField
                id={inputId("iban")}
                name="iban"
                label={PAYOUT_ACCOUNT_STRINGS.ibanLabel}
                description={PAYOUT_ACCOUNT_STRINGS.ibanHint}
                error={fieldErrors.iban}
                value={numbers.iban}
                onChange={(event) => setNumber("iban", event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={42}
              />
              <FormField
                id={inputId("bic")}
                name="bic"
                label={PAYOUT_ACCOUNT_STRINGS.bicLabel}
                description={PAYOUT_ACCOUNT_STRINGS.bicHint}
                error={fieldErrors.bic}
                value={numbers.bic}
                onChange={(event) => setNumber("bic", event.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={11}
              />
            </>
          ) : (
            <>
              <FormField
                id={inputId("accountNumber")}
                name="accountNumber"
                label={PAYOUT_ACCOUNT_STRINGS.accountNumberLabel}
                description={PAYOUT_ACCOUNT_STRINGS.accountNumberHint}
                error={fieldErrors.accountNumber}
                value={numbers.accountNumber}
                onChange={(event) => setNumber("accountNumber", event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={34}
              />
              <FormField
                id={inputId("routingNumber")}
                name="routingNumber"
                label={PAYOUT_ACCOUNT_STRINGS.routingNumberLabel}
                description={PAYOUT_ACCOUNT_STRINGS.routingNumberHint}
                error={fieldErrors.routingNumber}
                value={numbers.routingNumber}
                onChange={(event) => setNumber("routingNumber", event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={20}
              />
            </>
          )}
        </div>

        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? PAYOUT_ACCOUNT_STRINGS.submitting : PAYOUT_ACCOUNT_STRINGS.submit}
          </Button>
        </div>
      </form>
      {stepUpDialog}
    </section>
  );
}
