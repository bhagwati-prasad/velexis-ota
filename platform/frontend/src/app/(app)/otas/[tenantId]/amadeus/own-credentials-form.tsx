"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";

import {
  getSubmissionStatus,
  submitOwnCredentials,
  type OwnCredentialsField,
  type OwnCredentialsState,
  type OwnCredentialsValues,
  type SubmissionView,
} from "@/app/(app)/otas/[tenantId]/amadeus/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { useStepUpAction } from "@/components/step-up-dialog";
import { SubmissionStatus } from "@/components/submission-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { OWN_CREDENTIALS_STRINGS, SUBMISSION_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * "Use my own Amadeus credentials" for one environment (README §2 `/otas/[tenantId]/amadeus`; flows/amadeus-connection.md
 * §D; PF-52 AC1), for owners and admins while `features.ownAmadeus` is on: the client id, the client secret, the office
 * ids (one per line) and the default, queuing and owner offices, offered as selects of the office ids typed (the
 * queuing and owner office default to the default office). `submitOwnCredentials` checks the form and calls
 * `submitAmadeusCredentials`, which needs a TOTP step-up: `useStepUpAction` opens `StepUpDialog` on `REAUTH_REQUIRED`
 * and sends the same form again after the code. The accepted submission is then followed by `SubmissionStatus`
 * (`components/submission-status.tsx`, with `getSubmissionStatus` and the Amadeus words), which polls it until Amadeus
 * accepted or refused the credentials; the connection keeps working as it did until then. A
 * submission the page found (`pendingSubmission`: open, or failed) is followed the same way.
 *
 * **The client secret** is a password field whose value only the browser holds: it is not a controlled field (React
 * would copy a controlled value into the `value` attribute), the action never returns it, it is never rendered, and it
 * is emptied once the API accepted the submission. A refused submission keeps it for the correction. Its
 * `autocomplete` is `new-password`: browsers ignore `off` on a password field and would fill in the member's saved
 * portal password, which would then go to Amadeus as the client secret (as on the platform admin's account form).
 */

type Schemas = components["schemas"];
type AmadeusConnection = Schemas["AmadeusConnection"];
type Environment = Schemas["Environment"];
type TenantStatus = Schemas["TenantStatus"];

const STRINGS = OWN_CREDENTIALS_STRINGS;

/** `AmadeusOfficeId` of the platform document. */
const OFFICE_ID = /^[A-Z0-9]{9}$/;

/**
 * The office ids of the form's text, in the order typed: separated by line breaks, commas, semicolons or spaces,
 * upper-cased. The action reads the text the same way (`officeIdsOf` of `actions.ts`); the test keeps both equal.
 */
export function officeIdsOf(value: string): string[] {
  return value
    .split(/[\s,;]+/u)
    .filter((part) => part !== "")
    .map((part) => part.toUpperCase());
}

/** The offices the selects offer: the valid office ids typed, each once, in the order typed. */
export function officeChoices(officeIdsText: string): string[] {
  return [...new Set(officeIdsOf(officeIdsText).filter((officeId) => OFFICE_ID.test(officeId)))];
}

/**
 * The values the form starts with: those of the connection when it uses the OTA's own credentials already (the client
 * id and offices are not secret; a new secret is needed all the same), else empty. A Velexis office is never offered:
 * it is not the OTA's.
 */
export function initialCredentialValues(connection: AmadeusConnection | null): OwnCredentialsValues {
  if (connection === null || connection.credentialSource !== "tenant") {
    return { clientId: "", officeIds: "", defaultOfficeId: "", queuingOfficeId: "", ownerOfficeId: "" };
  }
  const { defaultOfficeId, queuingOfficeId, ownerOfficeId } = connection;
  return {
    clientId: connection.clientId ?? "",
    officeIds: connection.officeIds.join("\n"),
    defaultOfficeId: defaultOfficeId ?? "",
    // The same office as the default reads as "same as the default office".
    queuingOfficeId: queuingOfficeId === null || queuingOfficeId === defaultOfficeId ? "" : queuingOfficeId,
    ownerOfficeId: ownerOfficeId === null || ownerOfficeId === defaultOfficeId ? "" : ownerOfficeId,
  };
}

/** The fields in form order, for the error summary. */
const FIELD_ORDER: readonly OwnCredentialsField[] = [
  "clientId",
  "clientSecret",
  "officeIds",
  "defaultOfficeId",
  "queuingOfficeId",
  "ownerOfficeId",
];

const SELECT_CLASSES = cn(
  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

const TEXTAREA_CLASSES = cn(
  "border-input flex min-h-24 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 font-mono text-base shadow-xs outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** The `<option>`s of the offices. */
function officeOptions(offices: readonly string[]): ReactElement[] {
  return offices.map((officeId) => (
    <option key={officeId} value={officeId}>
      {officeId}
    </option>
  ));
}

export interface OwnCredentialsFormProps {
  readonly tenantId: string;
  readonly environment: Environment;
  /** While the OTA is not `active` nothing can be submitted (PADR-0014 item 5), and the section says why. */
  readonly tenantStatus: TenantStatus;
  /** The connection of the environment, or `null` when it has none yet (a successful verification creates it). */
  readonly connection: AmadeusConnection | null;
}

/** One environment's section: the submission being verified, and the form behind its disclosure button. */
export function OwnCredentialsForm({
  tenantId,
  environment,
  tenantStatus,
  connection,
}: OwnCredentialsFormProps) {
  const [initialState] = useState<OwnCredentialsState>(() => ({
    status: "idle",
    values: initialCredentialValues(connection),
    fieldErrors: {},
  }));
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(submitOwnCredentials, initialState);
  // From the state, not the props: a form posted before the page hydrated comes back rendered with the action's
  // answer, and its fields show what was sent (never the secret, which the state does not hold).
  const [values, setValues] = useState<OwnCredentialsValues>(state.values);
  // The form opens on demand; a form that came back refused is open.
  const [open, setOpen] = useState(state.status === "failed");
  // The submission the page found when it was rendered first: a revalidation after the verification drops it from the
  // connection (`pendingSubmission` is `null` once applied), and its outcome stays in view all the same.
  const [found] = useState<SubmissionView | null>(() => connection?.pendingSubmission ?? null);
  const followed = state.submission ?? found;

  const secretInput = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const titleId = `own-credentials-${environment}-title`;
  const inputId = (field: OwnCredentialsField) => `own-${environment}-${field}`;

  // Each answer sets the fields in the render that shows it: after a submission the values as sent.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setValues(state.values);
    if (state.status === "submitted") {
      setOpen(false);
    }
  }
  // An accepted submission empties the secret (the browser's own value) and returns the focus to the disclosure button,
  // under which the verification now shows.
  useEffect(() => {
    if (state.status !== "submitted") {
      return;
    }
    if (secretInput.current !== null) {
      secretInput.current.value = "";
    }
    toggle.current?.focus();
  }, [state]);

  // A new array per answer, so the summary takes the focus again after each refused submission.
  const summary = useMemo<FormErrorItem[]>(() => {
    const items: FormErrorItem[] = [];
    for (const field of FIELD_ORDER) {
      const message = state.fieldErrors[field];
      if (message !== undefined) {
        items.push({ message, fieldId: `own-${environment}-${field}` });
      }
    }
    if (state.message !== undefined) {
      items.push({ message: state.message });
    }
    return items;
  }, [state, environment]);

  const offices = useMemo(() => officeChoices(values.officeIds), [values.officeIds]);
  const choices = useMemo(() => officeOptions(offices), [offices]);
  /** A chosen office that is no longer one of the office ids typed reads as not chosen. */
  const chosen = (officeId: string) => (offices.includes(officeId) ? officeId : "");

  function setValue(field: keyof OwnCredentialsValues, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    // React would reset the fields after the action; the component's state already holds them.
    event.preventDefault();
    if (isPending) {
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  // Nothing can be submitted while the OTA is not `active` (PADR-0014 item 5), nor for a connection a platform admin
  // disabled (PADR-0012 item 8; the API refuses it with `409 CONFLICT`, `connection_disabled`): the section says why.
  const blocked =
    tenantStatus !== "active"
      ? STRINGS.readOnly[tenantStatus]
      : connection?.status === "disabled"
        ? STRINGS.connectionDisabled
        : null;
  const own = connection?.credentialSource === "tenant";
  const intro = connection === null ? STRINGS.introNoConnection : own ? STRINGS.introOwn : STRINGS.intro;
  const { fieldErrors } = state;
  return (
    <section
      aria-labelledby={titleId}
      data-own-credentials={environment}
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {STRINGS.title(environment)}
        </h2>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>

      {followed === null ? null : (
        <SubmissionStatus
          key={followed.id}
          tenantId={tenantId}
          environment={environment}
          submission={followed}
          poll={getSubmissionStatus}
          wording={SUBMISSION_STRINGS}
        />
      )}

      {blocked !== null ? (
        <Alert>
          <AlertTitle>{STRINGS.readOnlyTitle}</AlertTitle>
          <AlertDescription>{blocked}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div>
            <Button
              ref={toggle}
              type="button"
              variant={open ? "outline" : "default"}
              aria-expanded={open}
              aria-controls={formId}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? STRINGS.close : own ? STRINGS.openOwn : STRINGS.open}
            </Button>
          </div>
          {/* The form stays mounted while closed, so what was typed (the secret included) survives closing it. */}
          <form
            id={formId}
            action={dispatch}
            onSubmit={onSubmit}
            noValidate
            hidden={!open}
            aria-labelledby={titleId}
            className="grid gap-5"
            data-own-credentials-form={environment}
          >
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="environment" value={environment} />
            <p className="text-sm text-muted-foreground" data-step-up-note="">
              {STRINGS.stepUpNote}
            </p>
            <FormErrorSummary errors={summary} />
            {state.code === "MFA_REQUIRED" ? (
              <p className="text-sm">
                <Link href="/account/security" className="font-medium underline underline-offset-4">
                  {STRINGS.mfaLink}
                </Link>
              </p>
            ) : null}
            {state.reload === true ? (
              <p className="text-sm">
                {/* A full reload, so the page shows the connections and the role as they are now. */}
                <a href={otaPath(tenantId, "/amadeus")} className="font-medium underline underline-offset-4">
                  {STRINGS.reload}
                </a>
              </p>
            ) : null}

            <FormField
              id={inputId("clientId")}
              name="clientId"
              label={STRINGS.clientIdLabel}
              description={STRINGS.clientIdHint}
              error={fieldErrors.clientId}
              value={values.clientId}
              onChange={(event) => setValue("clientId", event.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={200}
            />
            <FormField
              ref={secretInput}
              id={inputId("clientSecret")}
              name="clientSecret"
              type="password"
              label={STRINGS.clientSecretLabel}
              description={STRINGS.clientSecretHint}
              error={fieldErrors.clientSecret}
              // Never the member's saved portal password (see the module comment).
              autoComplete="new-password"
              spellCheck={false}
              required
              maxLength={512}
            />
            <FormField
              id={inputId("officeIds")}
              name="officeIds"
              label={STRINGS.officeIdsLabel}
              description={STRINGS.officeIdsHint}
              error={fieldErrors.officeIds}
            >
              {(control) => (
                <textarea
                  {...control}
                  value={values.officeIds}
                  onChange={(event) => setValue("officeIds", event.target.value)}
                  rows={3}
                  required
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className={TEXTAREA_CLASSES}
                />
              )}
            </FormField>
            <FormField
              id={inputId("defaultOfficeId")}
              name="defaultOfficeId"
              label={STRINGS.defaultOfficeLabel}
              description={STRINGS.defaultOfficeHint}
              error={fieldErrors.defaultOfficeId}
            >
              {(control) => (
                <select
                  {...control}
                  value={chosen(values.defaultOfficeId)}
                  onChange={(event) => setValue("defaultOfficeId", event.target.value)}
                  required
                  className={SELECT_CLASSES}
                >
                  {offices.length === 0 ? (
                    <option value="">{STRINGS.officesFirst}</option>
                  ) : chosen(values.defaultOfficeId) === "" ? (
                    <option value="">{STRINGS.officePlaceholder}</option>
                  ) : null}
                  {choices}
                </select>
              )}
            </FormField>
            {(
              [
                ["queuingOfficeId", STRINGS.queuingOfficeLabel, STRINGS.queuingOfficeHint],
                ["ownerOfficeId", STRINGS.ownerOfficeLabel, STRINGS.ownerOfficeHint],
              ] as const
            ).map(([field, label, hint]) => (
              <FormField
                key={field}
                id={inputId(field)}
                name={field}
                label={label}
                description={hint}
                error={fieldErrors[field]}
              >
                {(control) => (
                  <select
                    {...control}
                    value={chosen(values[field])}
                    onChange={(event) => setValue(field, event.target.value)}
                    className={SELECT_CLASSES}
                  >
                    <option value="">{STRINGS.sameAsDefault}</option>
                    {choices}
                  </select>
                )}
              </FormField>
            ))}

            <div>
              <Button type="submit" disabled={isPending}>
                {isPending ? STRINGS.submitting : STRINGS.submit}
              </Button>
            </div>
          </form>
          {stepUpDialog}
        </>
      )}
    </section>
  );
}
