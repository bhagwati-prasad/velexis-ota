"use client";

import { useMemo, useState, type FormEvent } from "react";

import {
  createKey,
  type ApiKeyEnvironment,
  type ApiKeyKind,
  type CreateKeyState,
  type KeyExpiry,
} from "@/app/(app)/otas/[tenantId]/api-keys/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { OriginsField, originInputId } from "@/components/origins-field";
import { DEFAULT_SCOPE, ScopePicker, scopeInputId, type ScopeSelection } from "@/components/scope-picker";
import { SecretRevealPanel } from "@/components/secret-reveal-panel";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Button } from "@/components/ui/button";
import { API_KEYS_STRINGS, KEY_EXPIRY_LABELS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The create form of the API keys page (README §2 `/otas/[tenantId]/api-keys` and §5; flow api-keys.md steps 2 and 3;
 * PF-30 AC1, AC2): name, kind, the origins of a publishable key (`OriginsField`) or the use and permissions of a secret
 * key (`ScopePicker`), and an optional expiry, for the keys of one environment (the tab it sits in). `createKey`
 * answers the new key once; it shows in `SecretRevealPanel` from React state only, with the recommended set-ups of the
 * flow, and is gone after a reload, because the page never reads it. A live secret key needs a TOTP step-up
 * (`useStepUpAction` opens `StepUpDialog` and sends the same form again).
 */

/** The id prefix of the form's fields: one create form per environment tab. */
function formIdPrefix(environment: ApiKeyEnvironment): string {
  return `create-key-${environment}`;
}

/** The order of the expiry options. */
const EXPIRY_OPTIONS: readonly KeyExpiry[] = ["never", "7d", "30d", "90d", "365d"];

/** What the form holds while the person types. */
interface CreateValues {
  readonly name: string;
  readonly kind: ApiKeyKind;
  readonly origins: readonly string[];
  readonly scopes: ScopeSelection;
  readonly expiresIn: KeyExpiry;
}

/** A new form: a secret key for a storefront (the default use), one empty origin row for a publishable key. */
const EMPTY_VALUES: CreateValues = {
  name: "",
  kind: "secret",
  origins: [""],
  scopes: { scope: DEFAULT_SCOPE, permissions: [] },
  expiresIn: "never",
};

const INITIAL_STATE: CreateKeyState = { status: "idle", fieldErrors: {} };

/**
 * The entries of the error summary, in form order, each linked to its field. A refused publishable key has origin
 * errors only and a refused secret key scope errors only, because the action checks what the kind sends.
 */
function summaryOf(state: CreateKeyState, idPrefix: string): FormErrorItem[] {
  const { fieldErrors } = state;
  const items: FormErrorItem[] = [];
  if (fieldErrors.name !== undefined) {
    items.push({ message: fieldErrors.name, fieldId: `${idPrefix}-name` });
  }
  if (fieldErrors.kind !== undefined) {
    items.push({ message: fieldErrors.kind, fieldId: `${idPrefix}-kind-secret` });
  }
  for (const [row, message] of Object.entries(fieldErrors.origins ?? {}).sort(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    items.push({ message, fieldId: originInputId(idPrefix, Number(row)) });
  }
  if (fieldErrors.allowedOrigins !== undefined) {
    items.push({ message: fieldErrors.allowedOrigins, fieldId: originInputId(idPrefix, 0) });
  }
  if (fieldErrors.scopes !== undefined) {
    items.push({ message: fieldErrors.scopes, fieldId: scopeInputId(idPrefix, "storefront") });
  }
  if (fieldErrors.expiresIn !== undefined) {
    items.push({ message: fieldErrors.expiresIn, fieldId: `${idPrefix}-expiresIn` });
  }
  if (state.message !== undefined) {
    items.push({ message: state.message });
  }
  return items;
}

const SELECT_CLASSES = cn(
  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** The recommended set-ups of the flow, under the new key (api-keys.md step 3, the OTA contract's advice). */
export function RecommendedSetups() {
  return (
    <div className="grid gap-2 text-sm">
      <h3 className="font-semibold">{API_KEYS_STRINGS.recommendedTitle}</h3>
      <ul className="grid list-disc gap-1 pl-5">
        {API_KEYS_STRINGS.recommended.map((setup) => (
          <li key={setup}>{setup}</li>
        ))}
      </ul>
    </div>
  );
}

export interface CreateKeyFormProps {
  readonly tenantId: string;
  /** The environment of the tab: the new key's environment. */
  readonly environment: ApiKeyEnvironment;
  /** Keys can be created (the OTA is `active`); otherwise the form is disabled and the page says why. */
  readonly writable: boolean;
}

/** The create form; after a key is created the fields start again, so a second click does not make a second key. */
export function CreateKeyForm({ tenantId, environment, writable }: CreateKeyFormProps) {
  const idPrefix = formIdPrefix(environment);
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(createKey, INITIAL_STATE);
  const [values, setValues] = useState<CreateValues>(EMPTY_VALUES);
  // A new array per answer, so the summary takes the focus again after each refused submission.
  const summary = useMemo(() => summaryOf(state, idPrefix), [state, idPrefix]);

  // A created key starts the form again, in the render that shows the key.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    if (state.status === "created") {
      setValues(EMPTY_VALUES);
    }
  }

  function set<Field extends keyof CreateValues>(field: Field, value: CreateValues[Field]): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    // React would reset the fields after the action; the form's state already holds them.
    event.preventDefault();
    if (!writable || isPending) {
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  const { fieldErrors } = state;
  const created = state.status === "created" ? state.created : undefined;
  return (
    <div className="grid gap-6">
      {created === undefined ? null : (
        <SecretRevealPanel
          // A new panel for each new key: a panel dismissed before does not hide the next key.
          key={created.apiKey.id}
          title={API_KEYS_STRINGS.createdTitle(created.apiKey.kind, created.apiKey.environment)}
          secrets={[{ label: API_KEYS_STRINGS.createdKeyLabel(created.apiKey.name), value: created.key }]}
        >
          <p className="text-sm">
            {API_KEYS_STRINGS.createdListed(
              API_KEYS_STRINGS.maskedKey(created.apiKey.prefix, created.apiKey.last4),
            )}
          </p>
          <RecommendedSetups />
        </SecretRevealPanel>
      )}

      {/* `action` keeps a form sent before the page hydrated from going out as a GET with its fields in the URL. */}
      <form action={dispatch} onSubmit={onSubmit} noValidate className="grid gap-6">
        <input type="hidden" name="tenantId" value={tenantId} />
        <input type="hidden" name="environment" value={environment} />
        <FormErrorSummary errors={summary} />

        <fieldset disabled={!writable} className="grid gap-6">
          <FormField
            id={`${idPrefix}-name`}
            name="name"
            label={API_KEYS_STRINGS.nameLabel}
            description={API_KEYS_STRINGS.nameHint}
            error={fieldErrors.name}
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            autoComplete="off"
            required
            maxLength={100}
          />

          <fieldset
            className="grid gap-3"
            aria-describedby={fieldErrors.kind === undefined ? undefined : `${idPrefix}-kind-error`}
          >
            <legend className="mb-2 text-sm font-medium">{API_KEYS_STRINGS.kindLegend}</legend>
            {(
              [
                ["secret", API_KEYS_STRINGS.kindSecret, API_KEYS_STRINGS.kindSecretHint],
                ["publishable", API_KEYS_STRINGS.kindPublishable, API_KEYS_STRINGS.kindPublishableHint],
              ] as const
            ).map(([kind, label, hint]) => {
              const id = `${idPrefix}-kind-${kind}`;
              return (
                <div
                  key={kind}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-4",
                    values.kind === kind ? "border-primary ring-1 ring-primary" : undefined,
                  )}
                >
                  <input
                    type="radio"
                    id={id}
                    name="kind"
                    value={kind}
                    checked={values.kind === kind}
                    onChange={() => set("kind", kind)}
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
            {fieldErrors.kind === undefined ? null : (
              <p id={`${idPrefix}-kind-error`} className="text-sm font-medium text-destructive">
                {fieldErrors.kind}
              </p>
            )}
          </fieldset>

          {values.kind === "publishable" ? (
            <OriginsField
              idPrefix={idPrefix}
              environment={environment}
              origins={values.origins}
              onChange={(origins) => set("origins", origins)}
              error={fieldErrors.allowedOrigins}
              rowErrors={fieldErrors.origins}
            />
          ) : (
            <ScopePicker
              idPrefix={idPrefix}
              value={values.scopes}
              onChange={(scopes) => set("scopes", scopes)}
              error={fieldErrors.scopes}
            />
          )}

          <FormField
            id={`${idPrefix}-expiresIn`}
            name="expiresIn"
            label={API_KEYS_STRINGS.expiryLabel}
            description={API_KEYS_STRINGS.expiryHint}
            error={fieldErrors.expiresIn}
          >
            {(control) => (
              <select
                {...control}
                value={values.expiresIn}
                onChange={(event) => set("expiresIn", event.target.value as KeyExpiry)}
                className={SELECT_CLASSES}
              >
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {KEY_EXPIRY_LABELS[option]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </fieldset>

        <div>
          <Button type="submit" disabled={!writable || isPending}>
            {isPending ? API_KEYS_STRINGS.submitting : API_KEYS_STRINGS.submit}
          </Button>
        </div>
      </form>
      {stepUpDialog}
    </div>
  );
}
