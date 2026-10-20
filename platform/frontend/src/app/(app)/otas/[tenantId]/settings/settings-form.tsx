"use client";

import type { components } from "@velexis/api-types/platform";
import { startTransition, useActionState, useMemo, useState, type FormEvent, type ReactElement } from "react";

import {
  saveOtaProfile,
  type SettingsField,
  type SettingsState,
  type SettingsValues,
} from "@/app/(app)/otas/[tenantId]/settings/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SelectOption } from "@/lib/reference-options";
import { otaPath } from "@/lib/roles";
import { SETTINGS_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The OTA profile form of `/otas/[tenantId]/settings` (README §2; PF-13): name, legal name, support e-mail, country
 * and time zone, saved by `saveOtaProfile` with the version the page was rendered with (`If-Match`); the key and the
 * default currency are shown read-only, because they never change. While the OTA is not `active` (being set up,
 * suspended, failed) the fields are disabled with the reason, as the API refuses the save then
 * (`TENANT_NOT_ACTIVE`). The form holds nothing secret.
 */

type Tenant = components["schemas"]["Tenant"];

/** What the form needs of the OTA (`getTenant`). */
export type SettingsProfile = Pick<
  Tenant,
  "id" | "key" | "defaultCurrency" | "status" | "version" | SettingsField
>;

/** The order of the fields in the form and in the error summary. */
const FIELD_ORDER: readonly SettingsField[] = [
  "name",
  "legalName",
  "supportEmail",
  "countryCode",
  "timeZone",
];

/** The form values of the profile as `getTenant` answered it; no legal name or address is an empty field. */
function valuesOf(profile: SettingsProfile): SettingsValues {
  return {
    name: profile.name,
    legalName: profile.legalName ?? "",
    supportEmail: profile.supportEmail ?? "",
    countryCode: profile.countryCode ?? "",
    timeZone: profile.timeZone,
  };
}

/** The entries of the error summary: the field errors in form order, then a problem of no field. */
function summaryOf(state: SettingsState): FormErrorItem[] {
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

export interface SettingsFormProps {
  readonly tenant: SettingsProfile;
  /** The countries of the reference data (`COUNTRY_CODES`), named. */
  readonly countries: readonly SelectOption[];
  /** The time zones to offer, the OTA's own included. */
  readonly timeZones: readonly SelectOption[];
}

/**
 * The OTA profile form; after a refused save the fields keep what was typed, after a save they show the saved
 * profile (as the API stored it, trimmed). The fields are controlled and the form posts its data to the action in a
 * transition, so nothing resets them behind the person's back.
 */
export function SettingsForm({ tenant, countries, timeZones }: SettingsFormProps) {
  const initialState = useMemo<SettingsState>(
    () => ({ status: "idle", version: tenant.version, values: valuesOf(tenant), fieldErrors: {} }),
    [tenant],
  );
  const [state, dispatch, pending] = useActionState(saveOtaProfile, initialState);
  // From the state, not the profile: a form posted before the page hydrated comes back rendered with the action's
  // answer, and its fields show what was sent.
  const [values, setValues] = useState<SettingsValues>(state.values);
  // A new array per answer, so the summary takes the focus again after each refused save.
  const summary = useMemo(() => summaryOf(state), [state]);
  const readOnly = tenant.status !== "active";
  const { fieldErrors } = state;
  // Built once: a keystroke in another field re-renders the form, and the same elements let React skip the hundreds
  // of options.
  const countryOptions = useMemo(() => optionElements(countries), [countries]);
  const timeZoneOptions = useMemo(() => optionElements(timeZones), [timeZones]);

  // Each answer of the action sets the fields, in the render that shows the answer: the saved profile, or what
  // was sent.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setValues(state.values);
  }

  function setValue(field: SettingsField, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (readOnly || pending) {
      // A second save while one is on its way would carry the same version and be refused as stale.
      return;
    }
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(formData);
    });
  }

  return (
    // `action` serves a form posted before the page hydrated (Next.js then runs the action on the server and renders
    // its answer), so the fields never go into a GET query string. Once hydrated, `onSubmit` sends the data itself:
    // its `preventDefault` keeps React from running `action` and resetting the form after it.
    <form action={dispatch} onSubmit={onSubmit} noValidate className="grid gap-8">
      <input type="hidden" name="tenantId" value={tenant.id} />
      <input type="hidden" name="version" value={String(state.version)} />

      {tenant.status === "active" ? null : (
        <Alert role="status" data-notice="read-only">
          <AlertTitle>{SETTINGS_STRINGS.readOnlyTitle}</AlertTitle>
          <AlertDescription>{SETTINGS_STRINGS.readOnly[tenant.status]}</AlertDescription>
        </Alert>
      )}
      <FormErrorSummary errors={summary} />
      {state.code === "PRECONDITION_FAILED" ? (
        <p className="text-sm">
          {/* A full reload, so the page shows the profile as it is now, with its new version. */}
          <a href={otaPath(tenant.id, "/settings")} className="font-medium underline underline-offset-4">
            {SETTINGS_STRINGS.reload}
          </a>
        </p>
      ) : null}
      {state.status === "saved" ? (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm font-medium">
          {SETTINGS_STRINGS.saved}
        </p>
      ) : null}

      <fieldset disabled={readOnly} className="grid gap-5">
        <legend className="mb-5 text-lg font-semibold tracking-tight">
          {SETTINGS_STRINGS.profileLegend}
        </legend>
        <FormField
          label={SETTINGS_STRINGS.nameLabel}
          name="name"
          description={SETTINGS_STRINGS.nameHint}
          error={fieldErrors.name}
          value={values.name}
          onChange={(event) => setValue("name", event.target.value)}
          autoComplete="organization"
          required
          maxLength={100}
        />
        <FormField
          label={SETTINGS_STRINGS.legalNameLabel}
          name="legalName"
          description={SETTINGS_STRINGS.legalNameHint}
          error={fieldErrors.legalName}
          value={values.legalName}
          onChange={(event) => setValue("legalName", event.target.value)}
          maxLength={200}
        />
        <FormField
          label={SETTINGS_STRINGS.supportEmailLabel}
          name="supportEmail"
          type="email"
          description={SETTINGS_STRINGS.supportEmailHint}
          error={fieldErrors.supportEmail}
          value={values.supportEmail}
          onChange={(event) => setValue("supportEmail", event.target.value)}
          maxLength={254}
        />
        <FormField
          label={SETTINGS_STRINGS.countryLabel}
          name="countryCode"
          description={SETTINGS_STRINGS.countryHint}
          error={fieldErrors.countryCode}
        >
          {(control) => (
            <select
              {...control}
              value={values.countryCode}
              onChange={(event) => setValue("countryCode", event.target.value)}
              autoComplete="country"
              required
              className={SELECT_CLASSES}
            >
              {/* Only an OTA without a country yet gets the placeholder: a country can be changed, not removed. */}
              {tenant.countryCode === null ? (
                <option value="">{SETTINGS_STRINGS.countryPlaceholder}</option>
              ) : null}
              {countryOptions}
            </select>
          )}
        </FormField>
        <FormField
          label={SETTINGS_STRINGS.timeZoneLabel}
          name="timeZone"
          description={SETTINGS_STRINGS.timeZoneHint}
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

      <section aria-labelledby="settings-fixed" className="grid gap-3">
        <div className="grid gap-1">
          <h2 id="settings-fixed" className="text-lg font-semibold tracking-tight">
            {SETTINGS_STRINGS.fixedTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{SETTINGS_STRINGS.fixedIntro}</p>
        </div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{SETTINGS_STRINGS.keyLabel}</dt>
          <dd>
            <span data-field="key">{tenant.key}</span>
            <span className="block text-muted-foreground">{SETTINGS_STRINGS.keyHint}</span>
          </dd>
          <dt className="text-muted-foreground">{SETTINGS_STRINGS.currencyLabel}</dt>
          <dd>
            <span data-field="defaultCurrency">{tenant.defaultCurrency}</span>
            <span className="block text-muted-foreground">{SETTINGS_STRINGS.currencyHint}</span>
          </dd>
        </dl>
      </section>

      <div>
        <Button type="submit" disabled={readOnly || pending}>
          {pending ? SETTINGS_STRINGS.submitting : SETTINGS_STRINGS.submit}
        </Button>
      </div>
    </form>
  );
}
