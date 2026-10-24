"use client";

import type { components } from "@velexis/api-types/platform";
import { startTransition, useActionState, useMemo, useState, type FormEvent } from "react";

import { saveStatementDescriptor, type DescriptorState } from "@/app/(app)/otas/[tenantId]/payments/actions";
import {
  characterProblem,
  descriptorSuffixProblem,
  statementLine,
  SUFFIX_SHOWN_IN_FULL,
} from "@/app/(app)/otas/[tenantId]/payments/descriptor-rules";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { DESCRIPTOR_STRINGS } from "@/lib/strings";

/**
 * The card statement suffix form of one Velexis-mode payment connection (README §2 `/otas/[tenantId]/payments`;
 * flows/stripe-payments-account.md §A item 3; PF-60), inside its `ConnectionCard`, for owners and admins. The person
 * types the new suffix and sees, as they type, the line a card statement shows for it (`VELEXIS* ACME TRAVEL`, cut at
 * 22 characters) and a character Stripe or the API refuses; a submit checks every rule of `descriptor-rules.ts` in the
 * browser first and sends nothing while one is broken. `saveStatementDescriptor` checks them again and calls
 * `updatePaymentConnection` with the connection's version in `If-Match`. While the OTA is not `active` the form is
 * disabled with the reason (PADR-0014 item 5: the API answers `TENANT_NOT_ACTIVE` then). The form holds nothing secret.
 */

type Environment = components["schemas"]["Environment"];
type TenantStatus = components["schemas"]["TenantStatus"];

export interface DescriptorFormProps {
  readonly tenantId: string;
  /** The environment of the connection (the card's), the `{environment}` of the call. */
  readonly environment: Environment;
  /** The connection's version, sent in `If-Match`. */
  readonly version: number;
  /** The connection's suffix now (`null` when it has none). */
  readonly suffix: string | null;
  /** The OTA's status: only an `active` OTA's connections change. */
  readonly tenantStatus: TenantStatus;
}

/** The ids of one form's elements: one form per Velexis-mode card, so per environment. */
function idsOf(environment: Environment) {
  const prefix = `descriptor-${environment}`;
  return {
    title: `${prefix}-title`,
    input: `${prefix}-suffix`,
    preview: `${prefix}-preview`,
  };
}

/** The entries of the error summary: the problem of the suffix, then a problem of no field. */
function summaryOf(state: DescriptorState, inputId: string): FormErrorItem[] {
  const items: FormErrorItem[] = [];
  if (state.fieldError !== undefined) {
    items.push({ message: state.fieldError, fieldId: inputId });
  }
  if (state.message !== undefined) {
    items.push({ message: state.message });
  }
  return items;
}

/** The statement line of the suffix as typed, or why there is none yet. */
function Preview({
  id,
  inputId,
  suffix,
}: {
  readonly id: string;
  readonly inputId: string;
  readonly suffix: string;
}) {
  const line = statementLine(suffix);
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/40 px-4 py-3" data-preview="">
      <p id={`${id}-title`} className="text-sm font-medium">
        {DESCRIPTOR_STRINGS.previewTitle}
      </p>
      {/* A polite live region of its own (`output` is a status): a screen reader reads the new line when it changes. */}
      <output id={id} htmlFor={inputId} aria-labelledby={`${id}-title`} aria-live="polite">
        {line === null ? (
          <span className="text-sm text-muted-foreground" data-statement-line-missing="">
            {suffix === "" ? DESCRIPTOR_STRINGS.previewEmpty : DESCRIPTOR_STRINGS.previewInvalid}
          </span>
        ) : (
          <span className="font-mono text-base tracking-wide break-all" data-statement-line="">
            {line.line}
          </span>
        )}
      </output>
      <p className="text-sm text-muted-foreground" data-length="">
        {DESCRIPTOR_STRINGS.length([...suffix].length)}
      </p>
      {line?.cut === true ? (
        <p className="text-sm" data-cut="">
          {DESCRIPTOR_STRINGS.previewCut(SUFFIX_SHOWN_IN_FULL)}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{DESCRIPTOR_STRINGS.previewHint}</p>
    </div>
  );
}

/**
 * The form; after a refused save the field keeps what was typed, after a save it shows the saved suffix. The field is
 * controlled and the form posts its data to the action in a transition, so nothing resets it behind the person's back.
 */
export function DescriptorForm({
  tenantId,
  environment,
  version,
  suffix,
  tenantStatus,
}: DescriptorFormProps) {
  const ids = idsOf(environment);
  const initialState = useMemo<DescriptorState>(
    () => ({ status: "idle", version, suffix: suffix ?? "" }),
    [version, suffix],
  );
  const [state, dispatch, pending] = useActionState(saveStatementDescriptor, initialState);
  // From the state, not the props: a form posted before the page hydrated comes back rendered with the action's
  // answer, and its field shows what was sent.
  const [value, setValue] = useState(state.suffix);
  // After a submit the browser refused, every rule shows at the field until a submit is sent; before it, only the
  // character rules do, so typing "A" does not read as too short.
  const [everyRule, setEveryRule] = useState(false);
  // A new array per refusal (the browser's or the API's), so the summary takes the focus again each time.
  const [summary, setSummary] = useState<FormErrorItem[]>(() => summaryOf(state, ids.input));
  const writable = tenantStatus === "active";

  // Each answer of the action sets the field and the summary, in the render that shows the answer.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setValue(state.suffix);
    setSummary(summaryOf(state, ids.input));
  }

  const trimmed = value.trim();
  const browserProblem = everyRule ? descriptorSuffixProblem(trimmed) : characterProblem(trimmed);
  // The API's problem stays at the field until the suffix it was about changes.
  const fieldError =
    browserProblem !== null
      ? DESCRIPTOR_STRINGS.problems[browserProblem]
      : value === state.suffix
        ? state.fieldError
        : undefined;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!writable || pending) {
      // A second save while one is on its way would carry the same version and be refused as stale.
      return;
    }
    const problem = descriptorSuffixProblem(trimmed);
    if (problem !== null) {
      // Refused before it is sent: the rules are the API's, so the call could only fail.
      setEveryRule(true);
      setSummary([{ message: DESCRIPTOR_STRINGS.problems[problem], fieldId: ids.input }]);
      return;
    }
    setEveryRule(false);
    setSummary([]);
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(formData);
    });
  }

  return (
    // `action` serves a form posted before the page hydrated (Next.js then runs the action on the server and renders
    // its answer), so the field never goes into a GET query string. Once hydrated, `onSubmit` checks the rules and sends
    // the data itself: its `preventDefault` keeps React from running `action` and resetting the form after it.
    <form
      action={dispatch}
      onSubmit={onSubmit}
      noValidate
      aria-labelledby={ids.title}
      className="grid gap-4 border-t pt-4"
      data-descriptor-form={environment}
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="environment" value={environment} />
      <input type="hidden" name="version" value={String(state.version)} />

      <div className="grid gap-1">
        <h3 id={ids.title} className="font-semibold tracking-tight">
          {DESCRIPTOR_STRINGS.title}
        </h3>
        <p className="text-sm text-muted-foreground">{DESCRIPTOR_STRINGS.intro}</p>
      </div>

      {tenantStatus === "active" ? null : (
        <Alert role="status" data-descriptor-read-only="">
          <AlertTitle>{DESCRIPTOR_STRINGS.readOnlyTitle}</AlertTitle>
          <AlertDescription>{DESCRIPTOR_STRINGS.readOnly[tenantStatus]}</AlertDescription>
        </Alert>
      )}
      <FormErrorSummary errors={summary} />
      {state.reload === true ? (
        <p className="text-sm">
          {/* A full reload, so the card shows the connection as it is now, with its new version. */}
          <a href={otaPath(tenantId, "/payments")} className="font-medium underline underline-offset-4">
            {DESCRIPTOR_STRINGS.reload}
          </a>
        </p>
      ) : null}
      {state.status === "saved" && value === state.suffix ? (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm font-medium" data-saved="">
          {DESCRIPTOR_STRINGS.saved}
        </p>
      ) : null}

      <fieldset disabled={!writable} className="grid gap-4">
        <FormField
          id={ids.input}
          name="statementDescriptorSuffix"
          label={DESCRIPTOR_STRINGS.label}
          description={DESCRIPTOR_STRINGS.hint}
          error={fieldError}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <Preview id={ids.preview} inputId={ids.input} suffix={trimmed} />
      </fieldset>

      <div>
        <Button type="submit" disabled={!writable || pending}>
          {pending ? DESCRIPTOR_STRINGS.submitting : DESCRIPTOR_STRINGS.submit}
        </Button>
      </div>
    </form>
  );
}
