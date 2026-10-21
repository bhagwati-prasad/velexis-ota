"use client";

import { startTransition, useActionState, useMemo, useState, type FormEvent, type ReactElement } from "react";

import {
  saveProfile,
  type ProfileField,
  type ProfileState,
  type ProfileValues,
} from "@/app/(app)/account/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import type { SelectOption } from "@/lib/reference-options";
import { ACCOUNT_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The profile form of `/account` (README §2; PF-07): full name, language and region, and time zone, saved by
 * `saveProfile` with the account version the page was rendered with (`If-Match`). The e-mail address is shown
 * read-only, because it cannot be changed here (PADR-0008 item 5). A stale version shows the portal's message with a
 * reload link [PF-07 AC1]. The form holds nothing secret.
 */

/** What the form needs of the account (`getMe`). */
export interface ProfileFormAccount extends ProfileValues {
  readonly email: string;
  readonly version: number;
}

/** The order of the fields in the form and in the error summary. */
const FIELD_ORDER: readonly ProfileField[] = ["fullName", "locale", "timeZone"];

/** The entries of the error summary: the field errors in form order, then a problem of no field. */
function summaryOf(state: ProfileState): FormErrorItem[] {
  const items: FormErrorItem[] = [];
  for (const field of FIELD_ORDER) {
    const message = state.fieldErrors[field];
    if (message !== undefined) {
      items.push({ message, fieldId: fieldId(field) });
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

export interface ProfileFormProps {
  readonly account: ProfileFormAccount;
  /** The languages to offer, the account's own included. */
  readonly locales: readonly SelectOption[];
  /** The time zones to offer, the account's own included. */
  readonly timeZones: readonly SelectOption[];
}

/**
 * The profile form; after a refused save the fields keep what was typed, after a save they show the saved profile
 * (as the API stored it, trimmed). The fields are controlled and the form posts its data in a transition, so nothing
 * resets them behind the person's back.
 */
export function ProfileForm({ account, locales, timeZones }: ProfileFormProps) {
  const initialState = useMemo<ProfileState>(
    () => ({
      status: "idle",
      version: account.version,
      values: { fullName: account.fullName, locale: account.locale, timeZone: account.timeZone },
      fieldErrors: {},
    }),
    [account],
  );
  const [state, dispatch, pending] = useActionState(saveProfile, initialState);
  // From the state, not the account: a form posted before the page hydrated comes back rendered with the action's
  // answer, and its fields show what was sent.
  const [values, setValues] = useState<ProfileValues>(state.values);
  // A new array per answer, so the summary takes the focus again after each refused save.
  const summary = useMemo(() => summaryOf(state), [state]);
  const { fieldErrors } = state;
  // Built once: a keystroke in the name re-renders the form, and the same elements let React skip the options.
  const localeOptions = useMemo(() => optionElements(locales), [locales]);
  const timeZoneOptions = useMemo(() => optionElements(timeZones), [timeZones]);

  // Each answer of the action sets the fields, in the render that shows the answer: the saved profile, or what was
  // sent.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setValues(state.values);
  }

  function setValue(field: ProfileField, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) {
      // A second save while one is on its way would carry the same version and be refused as stale.
      return;
    }
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(formData);
    });
  }

  return (
    // `action` serves a form posted before the page hydrated, so the fields never go into a GET query string; once
    // hydrated, `onSubmit` sends the data itself and React never resets the fields.
    <form action={dispatch} onSubmit={onSubmit} noValidate className="grid gap-8">
      <input type="hidden" name="version" value={String(state.version)} />

      <FormErrorSummary errors={summary} />
      {state.code === "PRECONDITION_FAILED" ? (
        <p className="text-sm" data-notice="stale">
          {/* A full reload, so the page shows the profile as it is now, with its new version. */}
          <a href="/account" className="font-medium underline underline-offset-4">
            {ACCOUNT_STRINGS.reload}
          </a>
        </p>
      ) : null}
      {state.status === "saved" ? (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm font-medium">
          {ACCOUNT_STRINGS.saved}
        </p>
      ) : null}

      <fieldset className="grid gap-5">
        <legend className="mb-5 text-lg font-semibold tracking-tight">{ACCOUNT_STRINGS.profileLegend}</legend>
        <FormField
          label={ACCOUNT_STRINGS.fullNameLabel}
          name="fullName"
          description={ACCOUNT_STRINGS.fullNameHint}
          error={fieldErrors.fullName}
          value={values.fullName}
          onChange={(event) => setValue("fullName", event.target.value)}
          autoComplete="name"
          required
          maxLength={200}
        />
        <div className="grid gap-2">
          <p className="text-sm font-medium">{ACCOUNT_STRINGS.emailLabel}</p>
          <p className="text-sm" data-field="email">
            {account.email}
          </p>
          <p className="text-sm text-muted-foreground">{ACCOUNT_STRINGS.emailHint}</p>
        </div>
        <FormField
          label={ACCOUNT_STRINGS.localeLabel}
          name="locale"
          description={ACCOUNT_STRINGS.localeHint}
          error={fieldErrors.locale}
        >
          {(control) => (
            <select
              {...control}
              value={values.locale}
              onChange={(event) => setValue("locale", event.target.value)}
              required
              className={SELECT_CLASSES}
            >
              {localeOptions}
            </select>
          )}
        </FormField>
        <FormField
          label={ACCOUNT_STRINGS.timeZoneLabel}
          name="timeZone"
          description={ACCOUNT_STRINGS.timeZoneHint}
          error={fieldErrors.timeZone}
        >
          {(control) => (
            <select
              {...control}
              value={values.timeZone}
              onChange={(event) => setValue("timeZone", event.target.value)}
              required
              className={SELECT_CLASSES}
            >
              {timeZoneOptions}
            </select>
          )}
        </FormField>
      </fieldset>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? ACCOUNT_STRINGS.submitting : ACCOUNT_STRINGS.submit}
        </Button>
      </div>
    </form>
  );
}
