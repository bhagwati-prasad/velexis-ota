"use client";

import type { components } from "@velexis/api-types/platform";
import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import {
  connectStripe,
  getKeysSubmissionStatus,
  submitStripeKeys,
  type ConnectState,
  type KeysSubmissionView,
  type StripeKeysField,
  type StripeKeysState,
  type WebhookSetup,
} from "@/app/(app)/otas/[tenantId]/payments/actions";
import { CopyField } from "@/components/copy-field";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { STRIPE_ACCOUNT_STRINGS, STRIPE_KEYS_STRINGS, STRIPE_KEYS_SUBMISSION_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The OTA's own Stripe account on the payments page (README §2 `/otas/[tenantId]/payments`, §5 polling;
 * flows/stripe-payments-account.md §C and §D; PF-61, PF-62), for owners and admins while `features.ownStripe` is on:
 *
 * - `ConnectStripeForm`: "Connect Stripe" (or "Connect Stripe again" after Velexis was disconnected in Stripe) runs
 *   `connectStripe` (`startStripeConnect`) through `useStepUpAction`: `REAUTH_REQUIRED` opens `StepUpDialog`, and the
 *   same form goes again after the code; the action then sends the browser to Stripe's authorize URL with `redirect()`.
 * - `StripeKeysForm`: "Use my own Stripe keys" of one environment: the publishable key, the secret or restricted key
 *   (with the permissions a restricted key needs) and the webhook signing secret, behind a step-up
 *   (`submitStripeKeys`). The accepted submission shows the webhook endpoint to create in Stripe (its URL and events)
 *   and the reminder to send a test event, and `KeysSubmissionStatus` follows its verification.
 * - `KeysSubmissionStatus`: reads the submission every 2 seconds, one read at a time, until it is final, as the Amadeus
 *   page's `SubmissionStatus` does (PFE-023): each `errorCode` in the portal's words, never the code.
 *
 * **The secrets** (the secret key and the webhook secret) are password fields whose values only the browser holds:
 * they are not controlled fields (React would copy a controlled value into the `value` attribute), the action never
 * returns them, they are never rendered, and they are emptied once the API accepted the submission. A refused
 * submission keeps them for the correction. Their `autocomplete` is `new-password`: browsers ignore `off` on a password
 * field and would fill in the member's saved portal password, which would then be posted with the keys (as the
 * platform admin's Amadeus account form does).
 */

type Schemas = components["schemas"];
type PaymentConnection = Schemas["PaymentConnection"];
type Environment = Schemas["Environment"];
type TenantStatus = Schemas["TenantStatus"];

const ACCOUNT = STRIPE_ACCOUNT_STRINGS;
const KEYS = STRIPE_KEYS_STRINGS;
const SUBMISSION = STRIPE_KEYS_SUBMISSION_STRINGS;

/**
 * The call of a server action was rejected with Next.js's `redirect()` or `notFound()`, which the router must handle,
 * rather than failing on its own (the portal could not be reached).
 */
function isNavigation(error: unknown): boolean {
  try {
    unstable_rethrow(error);
  } catch {
    return true;
  }
  return false;
}

/** The link that reloads the page, so it shows the connections and the role as they are now. */
function ReloadLink({ tenantId }: { readonly tenantId: string }) {
  return (
    <p className="text-sm">
      <a href={otaPath(tenantId, "/payments")} className="font-medium underline underline-offset-4">
        {ACCOUNT.reload}
      </a>
    </p>
  );
}

function MfaLink({ label }: { readonly label: string }) {
  return (
    <p className="text-sm">
      <Link href="/account/security" className="font-medium underline underline-offset-4">
        {label}
      </Link>
    </p>
  );
}

// ---- Stripe Connect ------------------------------------------------------------------------------------------------

const CONNECT_IDLE: ConnectState = { status: "idle" };

export interface ConnectStripeFormProps {
  readonly tenantId: string;
  /** "Connect Stripe again": Velexis was disconnected from the OTA's Stripe account in Stripe (PF-61 AC2). */
  readonly reconnect: boolean;
}

/**
 * "Connect Stripe": one button in a form with the OTA's id. It leaves the page for Stripe once the API answered the
 * authorize URL (after the step-up when the API asks for one); a refusal shows its message under the button.
 */
export function ConnectStripeForm({ tenantId, reconnect }: ConnectStripeFormProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(connectStripe, CONNECT_IDLE);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  return (
    <>
      <form
        action={dispatch}
        onSubmit={onSubmit}
        noValidate
        className="grid gap-3"
        data-connect-stripe-form=""
      >
        <input type="hidden" name="tenantId" value={tenantId} />
        <p className="text-sm text-muted-foreground" data-step-up-note="">
          {ACCOUNT.connectStepUpNote}
        </p>
        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? ACCOUNT.connecting : reconnect ? ACCOUNT.reconnect : ACCOUNT.connect}
          </Button>
        </div>
        {state.message === undefined ? null : (
          <Alert variant="destructive" data-connect-problem={state.code}>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {state.code === "MFA_REQUIRED" ? <MfaLink label={ACCOUNT.mfaLink} /> : null}
        {state.reload === true ? <ReloadLink tenantId={tenantId} /> : null}
      </form>
      {stepUpDialog}
    </>
  );
}

// ---- The verification ----------------------------------------------------------------------------------------------

/** How long the page waits between two reads of a submission (README §5). */
export const KEYS_POLL_INTERVAL_MS = 2_000;

/** The longest wait a `Retry-After` may ask for between two reads. */
const MAX_POLL_DELAY_MS = 60_000;

/** The submission changes no more: polling stops (`applied`, `failed`, `superseded`). */
export function isFinalKeysSubmission(status: string): boolean {
  return status === "applied" || status === "failed" || status === "superseded";
}

/** Why a submission failed, in words: the verification result's own words, or the general ones. Never the code. */
export function keysSubmissionReason(errorCode: string | null): string {
  return errorCode !== null && Object.hasOwn(SUBMISSION.reasons, errorCode)
    ? (SUBMISSION.reasons[errorCode] ?? SUBMISSION.reasonUnknown)
    : SUBMISSION.reasonUnknown;
}

/** The colours of a status; the label always says it in words. */
const TONE_CLASSES: Readonly<Record<string, string>> = {
  pending: "border-transparent bg-sky-100 text-sky-900",
  verifying: "border-transparent bg-sky-100 text-sky-900",
  applied: "border-transparent bg-emerald-100 text-emerald-900",
  failed: "border-transparent bg-red-100 text-red-900",
  superseded: "border-transparent bg-secondary text-secondary-foreground",
};

/** A status in words; one the portal does not know yet (a newer API) in its raw form. */
function statusLabel(status: string): string {
  return Object.hasOwn(SUBMISSION.statuses, status)
    ? (SUBMISSION.statuses[status] ?? status)
    : status.replaceAll("_", " ");
}

function SubmissionMessage({
  submission,
  environment,
}: {
  readonly submission: KeysSubmissionView;
  readonly environment: Environment;
}) {
  switch (submission.status) {
    case "applied":
      return <p>{SUBMISSION.applied(environment)}</p>;
    case "failed":
      return (
        <>
          <p>{SUBMISSION.failed}</p>
          <p data-submission-reason="">{keysSubmissionReason(submission.errorCode)}</p>
        </>
      );
    case "superseded":
      return <p>{SUBMISSION.superseded}</p>;
    case "pending":
    case "verifying":
      return <p>{SUBMISSION.open}</p>;
  }
}

export interface KeysSubmissionStatusProps {
  readonly tenantId: string;
  readonly environment: Environment;
  /** The submission to follow, as the page or the form has it. */
  readonly submission: KeysSubmissionView;
}

/**
 * The status of one submission of Stripe keys, read with `getKeysSubmissionStatus` every 2 seconds until it is final.
 * A read that may pass (rate limit, API unavailable, the portal unreachable) is tried again with a note, after its
 * `Retry-After` (at most a minute); any other failure stops polling with the portal's message. An action that ends with
 * `redirect()` (an ended session) is thrown again while rendering, so the router's redirect boundary navigates. The
 * parent renders it with `key={submission.id}`, so a new submission starts a fresh component.
 */
export function KeysSubmissionStatus({
  tenantId,
  environment,
  submission: initial,
}: KeysSubmissionStatusProps) {
  const [submission, setSubmission] = useState<KeysSubmissionView>(initial);
  const [pollNote, setPollNote] = useState<string | undefined>(undefined);
  const [pollStopped, setPollStopped] = useState<string | undefined>(undefined);
  const [navigation, setNavigation] = useState<{ readonly error: unknown } | undefined>(undefined);

  const polling =
    !isFinalKeysSubmission(submission.status) && pollStopped === undefined && navigation === undefined;
  const submissionId = submission.id;

  useEffect(() => {
    if (!polling) {
      return undefined;
    }
    // One read at a time: the next one is scheduled when the previous answer arrived. The cleanup (the component going
    // away) cancels the chain, and a late answer of the old chain changes nothing.
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        getKeysSubmissionStatus(tenantId, submissionId).then(
          (result) => {
            if (!current) {
              return;
            }
            if (result.status === "ok") {
              setPollNote(undefined);
              setSubmission(result.submission);
              if (!isFinalKeysSubmission(result.submission.status)) {
                schedule(KEYS_POLL_INTERVAL_MS);
              }
              return;
            }
            if (result.transient) {
              setPollNote(SUBMISSION.pollFailed);
              const wait = (result.retryAfterSeconds ?? 0) * 1_000;
              schedule(Math.min(Math.max(KEYS_POLL_INTERVAL_MS, wait), MAX_POLL_DELAY_MS));
              return;
            }
            setPollNote(undefined);
            setPollStopped(result.message);
          },
          (error: unknown) => {
            if (!current) {
              return;
            }
            if (isNavigation(error)) {
              // The session ended: the router leaves the page, and no read follows.
              setNavigation({ error });
              return;
            }
            // The portal itself could not be reached: try again.
            setPollNote(SUBMISSION.pollFailed);
            schedule(KEYS_POLL_INTERVAL_MS);
          },
        );
      }, delay);
    };
    schedule(KEYS_POLL_INTERVAL_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [polling, tenantId, submissionId]);

  if (navigation !== undefined) {
    // While rendering, where the router's redirect boundary catches it and navigates.
    throw navigation.error;
  }

  const { status } = submission;
  const final = isFinalKeysSubmission(status);
  return (
    <div
      className="grid gap-2 rounded-lg border px-4 py-3 text-sm"
      data-keys-submission-status={status}
      data-environment={environment}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{SUBMISSION.title}</span>
        <Badge
          variant="outline"
          data-status={status}
          className={cn(TONE_CLASSES[status] ?? TONE_CLASSES["superseded"])}
        >
          {final ? null : <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {statusLabel(status)}
        </Badge>
      </div>
      {/* A live region from the first render, so each new status is read out. */}
      <div role="status" className="grid gap-1" data-submission-message="">
        <SubmissionMessage submission={submission} environment={environment} />
      </div>
      {pollNote === undefined ? null : (
        <p className="text-muted-foreground" data-poll-note="">
          {pollNote}
        </p>
      )}
      {pollStopped === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{SUBMISSION.pollStoppedTitle}</AlertTitle>
          <AlertDescription>{pollStopped}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---- Own Stripe keys -----------------------------------------------------------------------------------------------

/** The webhook endpoint to create in Stripe, with the reminder to send a test event (flows §D items 2 and 4). */
function WebhookEndpoint({
  webhook,
  environment,
}: {
  readonly webhook: WebhookSetup;
  readonly environment: Environment;
}) {
  const titleId = `stripe-webhook-${environment}-title`;
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="grid gap-3 rounded-lg border px-4 py-3 text-sm"
      data-webhook-setup={environment}
    >
      <h4 id={titleId} className="font-medium">
        {KEYS.webhookTitle}
      </h4>
      <p className="text-muted-foreground">{KEYS.webhookIntro}</p>
      <CopyField label={KEYS.webhookUrlLabel} value={webhook.url} id={`stripe-webhook-${environment}-url`} />
      {webhook.events.length === 0 ? null : (
        <div className="grid gap-1">
          <p className="font-medium" id={`stripe-webhook-${environment}-events`}>
            {KEYS.webhookEventsLabel}
          </p>
          <ul
            aria-labelledby={`stripe-webhook-${environment}-events`}
            className="grid list-disc gap-0.5 pl-5 font-mono"
            data-webhook-events=""
          >
            {webhook.events.map((event) => (
              <li key={event}>{event}</li>
            ))}
          </ul>
        </div>
      )}
      <p data-test-event-reminder="">{KEYS.testEventReminder}</p>
    </div>
  );
}

/** The fields in form order, for the error summary. */
const FIELD_ORDER: readonly StripeKeysField[] = ["publishableKey", "secretKey", "webhookSecret"];

export interface StripeKeysFormProps {
  readonly tenantId: string;
  readonly environment: Environment;
  /** While the OTA is not `active` nothing can be submitted (PADR-0014 item 5), and the part says why. */
  readonly tenantStatus: TenantStatus;
  /** The connection of the environment, or `null` when it has none yet (a successful verification creates it). */
  readonly connection: PaymentConnection | null;
}

/** One environment's keys: the submission being verified, the webhook endpoint, and the form behind its button. */
export function StripeKeysForm({ tenantId, environment, tenantStatus, connection }: StripeKeysFormProps) {
  const [initialState] = useState<StripeKeysState>(() => ({
    status: "idle",
    publishableKey: "",
    fieldErrors: {},
  }));
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(submitStripeKeys, initialState);
  // From the state, not the props: a form posted before the page hydrated comes back rendered with the action's
  // answer, and its field shows what was sent (never a secret, which the state does not hold).
  const [publishableKey, setPublishableKey] = useState(state.publishableKey);
  // The form opens on demand; a form that came back refused is open.
  const [open, setOpen] = useState(state.status === "failed");
  // The submission the page found when it was rendered first: a revalidation after the verification drops it from the
  // connection (`pendingSubmission` is `null` once applied), and its outcome stays in view all the same.
  const [found] = useState<KeysSubmissionView | null>(() => connection?.pendingSubmission ?? null);
  const followed = state.submission ?? found;

  const secretInput = useRef<HTMLInputElement>(null);
  const webhookSecretInput = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const titleId = `stripe-keys-${environment}-title`;
  const inputId = (field: StripeKeysField) => `stripe-keys-${environment}-${field}`;

  // Each answer sets the field in the render that shows it: after a submission the publishable key as sent.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setPublishableKey(state.publishableKey);
    if (state.status === "submitted") {
      setOpen(false);
    }
  }
  // An accepted submission empties the secrets (the browser's own values) and returns the focus to the button, under
  // which the webhook endpoint and the verification now show.
  useEffect(() => {
    if (state.status !== "submitted") {
      return;
    }
    for (const input of [secretInput.current, webhookSecretInput.current]) {
      if (input !== null) {
        input.value = "";
      }
    }
    toggle.current?.focus();
  }, [state]);

  // A new array per answer, so the summary takes the focus again after each refused submission.
  const summary = useMemo<FormErrorItem[]>(() => {
    const items: FormErrorItem[] = [];
    for (const field of FIELD_ORDER) {
      const message = state.fieldErrors[field];
      if (message !== undefined) {
        items.push({ message, fieldId: `stripe-keys-${environment}-${field}` });
      }
    }
    if (state.message !== undefined) {
      items.push({ message: state.message });
    }
    return items;
  }, [state, environment]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    // React would reset the fields after the action; the component's state already holds the publishable key.
    event.preventDefault();
    if (isPending) {
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  // Nothing can be submitted while the OTA is not `active` (PADR-0014 item 5), nor for a connection a platform admin
  // disabled (the API refuses it with `409 CONFLICT`, `connection_disabled`): the part says why.
  const blocked =
    tenantStatus !== "active"
      ? KEYS.readOnly[tenantStatus]
      : connection?.status === "disabled" && connection.disconnectedAt === null
        ? KEYS.connectionDisabled
        : null;
  const own = connection?.accountMode === "api_keys";
  const intro = connection === null ? KEYS.introNoConnection : own ? KEYS.introOwn : KEYS.intro;
  const { fieldErrors } = state;
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-stripe-keys={environment}
      className="grid content-start gap-4 rounded-lg border p-4"
    >
      <div className="grid gap-1">
        <h3 id={titleId} className="font-semibold tracking-tight">
          {KEYS.title(environment)}
        </h3>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>

      {state.webhook === undefined ? null : (
        <WebhookEndpoint webhook={state.webhook} environment={environment} />
      )}
      {followed === null ? null : (
        <KeysSubmissionStatus
          key={followed.id}
          tenantId={tenantId}
          environment={environment}
          submission={followed}
        />
      )}

      {blocked !== null ? (
        <Alert>
          <AlertTitle>{KEYS.readOnlyTitle}</AlertTitle>
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
              {open ? KEYS.close : own ? KEYS.openOwn : KEYS.open}
            </Button>
          </div>
          {/* The form stays mounted while closed, so what was typed (the secrets included) survives closing it. */}
          <form
            id={formId}
            action={dispatch}
            onSubmit={onSubmit}
            noValidate
            hidden={!open}
            aria-labelledby={titleId}
            className="grid gap-5"
            data-stripe-keys-form={environment}
          >
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="environment" value={environment} />
            <p className="text-sm text-muted-foreground" data-step-up-note="">
              {KEYS.stepUpNote}
            </p>
            <p className="text-sm text-muted-foreground">{KEYS.where(environment)}</p>
            <FormErrorSummary errors={summary} />
            {state.code === "MFA_REQUIRED" ? <MfaLink label={KEYS.mfaLink} /> : null}
            {state.reload === true ? <ReloadLink tenantId={tenantId} /> : null}

            <FormField
              id={inputId("publishableKey")}
              name="publishableKey"
              label={KEYS.publishableKeyLabel}
              description={KEYS.publishableKeyHint(environment)}
              error={fieldErrors.publishableKey}
              value={publishableKey}
              onChange={(event) => setPublishableKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={255}
            />
            <FormField
              ref={secretInput}
              id={inputId("secretKey")}
              name="secretKey"
              type="password"
              label={KEYS.secretKeyLabel}
              description={KEYS.secretKeyHint(environment)}
              error={fieldErrors.secretKey}
              // Never the member's saved portal password (see the module comment).
              autoComplete="new-password"
              spellCheck={false}
              required
              maxLength={255}
            />
            <div className="grid gap-1 text-sm" data-restricted-permissions="">
              <p className="font-medium" id={`stripe-keys-${environment}-restricted`}>
                {KEYS.restrictedTitle}
              </p>
              <ul
                aria-labelledby={`stripe-keys-${environment}-restricted`}
                className="grid list-disc gap-0.5 pl-5"
              >
                {KEYS.restrictedPermissions.map((permission) => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
            </div>
            <FormField
              ref={webhookSecretInput}
              id={inputId("webhookSecret")}
              name="webhookSecret"
              type="password"
              label={KEYS.webhookSecretLabel}
              description={KEYS.webhookSecretHint}
              error={fieldErrors.webhookSecret}
              autoComplete="new-password"
              spellCheck={false}
              required
              maxLength={255}
            />

            <div>
              <Button type="submit" disabled={isPending}>
                {isPending ? KEYS.submitting : KEYS.submit}
              </Button>
            </div>
          </form>
          {stepUpDialog}
        </>
      )}
    </div>
  );
}
