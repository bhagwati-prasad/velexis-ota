"use client";

import type { components } from "@velexis/api-types/platform";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type RefObject,
} from "react";

import {
  createAmadeusAccount,
  disableAmadeusAccount,
  rotateAmadeusAccountSecret,
  updateAmadeusAccountDetails,
  verifyAmadeusAccount,
  type AccountActionState,
  type AccountFailure,
} from "@/app/(app)/amadeus/accounts/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { isStepUpRequired, useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AMADEUS_ACCOUNT_FORM_STRINGS as S } from "@/lib/strings";

/**
 * The forms of `/amadeus/accounts` (README §2; flows/amadeus-connection.md §A; PADR-0006 item 4; PF-90): create the
 * account of an environment, edit its details, rotate its secret, verify it again and disable it. Creating, rotating
 * and changing the host or client id ask for a TOTP step-up (`StepUpDialog`), after which the same form data is sent
 * again. The client secret fields are never pre-filled, and they are emptied after every answer: the secret goes from
 * the field to the server action and on to the API, and nothing ever sends it back. The props are the few fields the
 * forms show; Next.js sends them to the browser.
 */

type Schemas = components["schemas"];
type Environment = Schemas["Environment"];
type AccountStatus = Schemas["AmadeusAccountStatus"];

const IDLE: AccountActionState = { status: "idle" };

/** The Amadeus API host of each environment, offered when an account is created (flows/amadeus-connection.md §D). */
const DEFAULT_BASE_URLS: Readonly<Record<Environment, string>> = {
  test: "https://test.travel.api.amadeus.com",
  live: "https://travel.api.amadeus.com",
};

/** The `maxLength`s of `CreateAmadeusAccountRequest` (the server actions check them again, in code points). */
const NAME_MAX = 100;
const BASE_URL_MAX = 300;
const CLIENT_ID_MAX = 200;
const CLIENT_SECRET_MAX = 512;

/** While a verification runs, the page asks the API again this often, at most this many times (two minutes). */
export const REFRESH_INTERVAL_MS = 5_000;
export const PENDING_REFRESH_LIMIT = 24;
/** After "Verify now" on an account that stays active meanwhile, it asks again for half a minute. */
export const QUEUED_REFRESH_LIMIT = 6;

// ---- Building blocks ----------------------------------------------------------------------------------------------

interface TextFieldProps extends Omit<ComponentProps<typeof Input>, "id"> {
  readonly label: string;
  readonly hint: string;
  readonly error?: string | undefined;
}

/** A labelled input with its hint and, after a refused submission, its message. */
function TextField({ label, hint, error, ...input }: TextFieldProps) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {hint}
      </p>
      <Input
        id={id}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={error === undefined ? `${id}-hint` : `${id}-hint ${id}-error`}
        {...(error === undefined ? {} : { "aria-invalid": true })}
        {...input}
      />
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A client secret field: a password input that is never pre-filled and that `useClearedAfterAnswer` empties. Browsers
 * ignore `autocomplete="off"` on a password field and would fill in the admin's saved console password;
 * `new-password` tells them that this field takes a new value.
 */
function SecretField({
  label,
  hint,
  error,
  inputRef,
}: {
  readonly label: string;
  readonly hint: string;
  readonly error: string | undefined;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <TextField
      ref={inputRef}
      label={label}
      hint={hint}
      error={error}
      name="clientSecret"
      type="password"
      autoComplete="new-password"
      defaultValue=""
      maxLength={CLIENT_SECRET_MAX}
    />
  );
}

/**
 * Empties the secret field after every answer of its action, except a step-up request: the dialog then sends the same
 * form data again, and the field is emptied after that answer. A refused secret is typed again rather than kept.
 */
function useClearedAfterAnswer(state: AccountActionState): RefObject<HTMLInputElement | null> {
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!isStepUpRequired(state) && input.current !== null) {
      input.current.value = "";
    }
  }, [state]);
  return input;
}

/** A refused action that belongs to no field: the admin's message, and a full reload for a stale version. */
function FailureNotice({ state }: { readonly state: AccountFailure }) {
  if (state.message === undefined) {
    return null;
  }
  return (
    <Alert variant="destructive" data-notice="failed" data-code={state.code}>
      <AlertDescription>
        <p>{state.message}</p>
        {state.code === "PRECONDITION_FAILED" ? (
          // A full reload, so the page shows the account as it is now, with its new version.
          <a href="/amadeus/accounts" className="font-medium text-foreground underline underline-offset-4">
            {S.reload}
          </a>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function failureOf(state: AccountActionState): AccountFailure | undefined {
  return state.status === "failed" ? state : undefined;
}

/**
 * The action has just saved. A step-up request is the previous state with `stepUp: true` (README §4), so after an
 * earlier save it still reads `done`: that is no answer yet, and nothing may say saved while the code is asked for.
 */
function isSaved(state: AccountActionState): boolean {
  return state.status === "done" && !isStepUpRequired(state);
}

/**
 * Asks the API again (`router.refresh()`) every five seconds, at most `limit` times, while it is rendered: the
 * verification job runs after the answer of the action, so its result arrives later.
 */
function VerificationRefresh({ limit }: { readonly limit: number }) {
  const router = useRouter();
  useEffect(() => {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      router.refresh();
      if (count >= limit) {
        clearInterval(timer);
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [router, limit]);
  return null;
}

// ---- Create -------------------------------------------------------------------------------------------------------

export interface CreateAccountFormProps {
  readonly environment: Environment;
  /** The environment's name ("Test"). */
  readonly environmentLabel: string;
  /**
   * The environment has an account. The form then shows nothing but the outcome of a creation it made, so that
   * outcome stays after the revalidated page shows the new account.
   */
  readonly hasAccount: boolean;
}

/**
 * "Set up the Test account": name, host (the environment's Amadeus host offered), client id and client secret, saved
 * with `adminCreateAmadeusAccount` after a step-up. The account then shows `pending_verification`.
 */
export function CreateAccountForm({ environment, environmentLabel, hasAccount }: CreateAccountFormProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(createAmadeusAccount, IDLE);
  // The form is open, with the state its action had then: an older refusal is not shown in a form opened again.
  const [openedWith, setOpenedWith] = useState<AccountActionState | undefined>(undefined);
  const open = openedWith !== undefined;
  const secret = useClearedAfterAnswer(state);
  const titleId = useId();

  // A creation closes the form, once per answer.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    if (isSaved(state)) {
      setOpenedWith(undefined);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!isPending) {
      dispatch(new FormData(event.currentTarget));
    }
  }

  const failure = state === openedWith ? undefined : failureOf(state);
  return (
    <>
      {isSaved(state) ? (
        <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
          {S.created(environmentLabel)}
        </p>
      ) : null}
      {hasAccount ? null : open ? (
        <form
          onSubmit={onSubmit}
          noValidate
          aria-labelledby={titleId}
          className="grid max-w-xl gap-4 rounded-lg border p-4"
        >
          <h3 id={titleId} className="text-base font-semibold">
            {S.createTitle(environmentLabel)}
          </h3>
          <p className="text-sm text-muted-foreground">{S.createIntro}</p>
          {failure === undefined ? null : <FailureNotice state={failure} />}
          <input type="hidden" name="environment" value={environment} />
          <TextField
            label={S.nameLabel}
            hint={S.nameHint}
            error={failure?.fieldErrors.name}
            name="name"
            maxLength={NAME_MAX}
            autoFocus
          />
          <TextField
            label={S.baseUrlLabel}
            hint={S.baseUrlHint}
            error={failure?.fieldErrors.baseUrl}
            name="baseUrl"
            inputMode="url"
            defaultValue={DEFAULT_BASE_URLS[environment]}
            maxLength={BASE_URL_MAX}
          />
          <TextField
            label={S.clientIdLabel}
            hint={S.clientIdHint}
            error={failure?.fieldErrors.clientId}
            name="clientId"
            maxLength={CLIENT_ID_MAX}
          />
          <SecretField
            label={S.clientSecretLabel}
            hint={S.clientSecretHint}
            error={failure?.fieldErrors.clientSecret}
            inputRef={secret}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={isPending}>
              {isPending ? S.saving : S.save}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpenedWith(undefined)}>
              {S.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button onClick={() => setOpenedWith(state)}>{S.create(environmentLabel)}</Button>
        </div>
      )}
      {stepUpDialog}
    </>
  );
}

// ---- Account actions ----------------------------------------------------------------------------------------------

export interface AccountActionsProps {
  readonly accountId: string;
  readonly environment: Environment;
  /** The environment's name ("Test"). */
  readonly environmentLabel: string;
  readonly status: AccountStatus;
  /** The account version the page was rendered with (`If-Match` of every update). */
  readonly version: number;
  /** The name and host, which the details form offers to change. */
  readonly name: string;
  readonly baseUrl: string;
  /** The last four characters of the client id, for the hint of the details form; never the whole value. */
  readonly clientIdLast4: string | null;
}

type ActionId = "details" | "secret" | "disable" | "verify";

/**
 * The actions on an account: **Verify now** (**Verify and enable** on a disabled account), **Edit details** (name,
 * host, client id), **Rotate secret** and **Disable account** (`ConfirmDialog`). Each update sends the version the page
 * was rendered with in `If-Match`, so a change made in the meantime answers `412` and the form asks to reload. While the
 * account waits for its verification, and for a while after a verification was queued, the page asks the API again on
 * its own.
 */
export function AccountActions(props: AccountActionsProps) {
  const { accountId, environmentLabel, status, version } = props;
  const details = useStepUpAction(updateAmadeusAccountDetails, IDLE);
  const secret = useStepUpAction(rotateAmadeusAccountSecret, IDLE);
  const disable = useStepUpAction(disableAmadeusAccount, IDLE);
  const verify = useStepUpAction(verifyAmadeusAccount, IDLE);
  // The open form, with the state its action had then: an older refusal is not shown in a form opened again.
  const [opened, setOpened] = useState<
    { readonly form: "details" | "secret"; readonly with: AccountActionState } | undefined
  >(undefined);
  const open = opened?.form;
  // The outcome shown is the one of the action that ran last.
  const [latest, setLatest] = useState<ActionId | undefined>(undefined);
  // Each queued verification asks the API again for a while, until the account's status changes; a new one restarts.
  const [queued, setQueued] = useState<
    { readonly count: number; readonly status: AccountStatus } | undefined
  >(undefined);
  const pending = details.isPending || secret.isPending || disable.isPending || verify.isPending;

  // A saved form closes, once per answer; a queued verification starts the short refresh.
  const [answered, setAnswered] = useState({
    details: details.state,
    secret: secret.state,
    verify: verify.state,
  });
  if (
    answered.details !== details.state ||
    answered.secret !== secret.state ||
    answered.verify !== verify.state
  ) {
    if (
      (answered.details !== details.state && isSaved(details.state)) ||
      (answered.secret !== secret.state && isSaved(secret.state))
    ) {
      setOpened(undefined);
    }
    if (answered.verify !== verify.state && isSaved(verify.state)) {
      setQueued({ count: (queued?.count ?? 0) + 1, status });
    }
    setAnswered({ details: details.state, secret: secret.state, verify: verify.state });
  }

  function hidden(): FormData {
    const formData = new FormData();
    formData.set("accountId", accountId);
    formData.set("version", String(version));
    return formData;
  }

  function toggle(form: "details" | "secret"): void {
    setOpened(open === form ? undefined : { form, with: form === "details" ? details.state : secret.state });
  }

  function close(): void {
    setOpened(undefined);
    setLatest(undefined);
  }

  const outcome =
    latest === undefined
      ? undefined
      : { details: details.state, secret: secret.state, disable: disable.state, verify: verify.state }[
          latest
        ];
  const refreshLimit =
    status === "pending_verification"
      ? PENDING_REFRESH_LIMIT
      : queued?.status === status && verify.state.status === "done"
        ? QUEUED_REFRESH_LIMIT
        : 0;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={status === "disabled" || status === "invalid_credentials" ? "default" : "outline"}
          disabled={pending}
          aria-describedby={`${accountId}-verify-hint`}
          onClick={() => {
            setLatest("verify");
            verify.dispatch(hidden());
          }}
        >
          {status === "disabled" ? S.verifyAndEnable : S.verify}
        </Button>
        <Button
          variant="outline"
          disabled={pending}
          aria-expanded={open === "details"}
          onClick={() => {
            setLatest("details");
            toggle("details");
          }}
        >
          {S.edit}
        </Button>
        <Button
          variant="outline"
          disabled={pending}
          aria-expanded={open === "secret"}
          onClick={() => {
            setLatest("secret");
            toggle("secret");
          }}
        >
          {S.rotate}
        </Button>
        {status === "disabled" ? null : (
          <ConfirmDialog
            trigger={
              <Button variant="destructive" disabled={pending}>
                {S.disable}
              </Button>
            }
            title={S.disableTitle(environmentLabel)}
            description={S.disableDescription}
            confirmLabel={S.disableConfirm}
            onConfirm={() => {
              setLatest("disable");
              setOpened(undefined);
              disable.dispatch(hidden());
            }}
          />
        )}
        {pending ? <span className="text-sm text-muted-foreground">{S.working}</span> : null}
      </div>
      <p id={`${accountId}-verify-hint`} className="text-sm text-muted-foreground">
        {S.verifyHint}
      </p>
      {open === "details" ? (
        <DetailsForm
          {...props}
          state={details.state === opened?.with ? IDLE : details.state}
          isPending={details.isPending}
          dispatch={details.dispatch}
          onCancel={close}
        />
      ) : null}
      {open === "secret" ? (
        <SecretForm
          accountId={accountId}
          version={version}
          state={secret.state === opened?.with ? IDLE : secret.state}
          isPending={secret.isPending}
          dispatch={secret.dispatch}
          onCancel={close}
        />
      ) : null}
      {/* The open form shows its own refusals; the outcome below is the last action's otherwise. */}
      {outcome === undefined || (open !== undefined && open === latest) ? null : (
        <Outcome action={latest} state={outcome} />
      )}
      {refreshLimit > 0 ? (
        <VerificationRefresh key={`${status}-${String(queued?.count ?? 0)}`} limit={refreshLimit} />
      ) : null}
      {details.stepUpDialog}
      {secret.stepUpDialog}
      {disable.stepUpDialog}
      {verify.stepUpDialog}
    </div>
  );
}

const DONE_MESSAGES: Readonly<Record<ActionId, string>> = {
  details: S.edited,
  secret: S.rotated,
  disable: S.disabled,
  verify: S.verifyQueued,
};

function Outcome({
  action,
  state,
}: {
  readonly action: ActionId | undefined;
  readonly state: AccountActionState;
}) {
  // A step-up request is still waiting for its answer: no outcome, old or new, until the code is given.
  if (action === undefined || state.status === "idle" || isStepUpRequired(state)) {
    return null;
  }
  if (state.status === "failed") {
    return state.message === undefined ? null : <FailureNotice state={state} />;
  }
  // No status here: the account's badge above is the status, and the page refreshes it while a verification runs.
  return (
    <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
      {DONE_MESSAGES[action]}
    </p>
  );
}

interface FormProps {
  readonly state: AccountActionState;
  readonly isPending: boolean;
  readonly dispatch: (formData: FormData) => void;
  readonly onCancel: () => void;
}

/** "Edit details": the name and the host as they are, the client id empty (keeps the current one). */
function DetailsForm({
  accountId,
  version,
  name,
  baseUrl,
  clientIdLast4,
  state,
  isPending,
  dispatch,
  onCancel,
}: AccountActionsProps & FormProps) {
  const titleId = useId();
  const failure = failureOf(state);
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!isPending) {
      dispatch(new FormData(event.currentTarget));
    }
  }
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby={titleId}
      className="grid max-w-xl gap-4 rounded-lg border p-4"
    >
      <h3 id={titleId} className="text-base font-semibold">
        {S.editTitle}
      </h3>
      <p className="text-sm text-muted-foreground">{S.editIntro}</p>
      {failure === undefined ? null : <FailureNotice state={failure} />}
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="version" value={String(version)} />
      <TextField
        label={S.nameLabel}
        hint={S.nameHint}
        error={failure?.fieldErrors.name}
        name="name"
        defaultValue={name}
        maxLength={NAME_MAX}
        autoFocus
      />
      <TextField
        label={S.baseUrlLabel}
        hint={S.baseUrlHint}
        error={failure?.fieldErrors.baseUrl}
        name="baseUrl"
        inputMode="url"
        defaultValue={baseUrl}
        maxLength={BASE_URL_MAX}
      />
      <TextField
        label={S.clientIdLabel}
        hint={clientIdLast4 === null ? S.clientIdKeepHintUnknown : S.clientIdKeepHint(clientIdLast4)}
        error={failure?.fieldErrors.clientId}
        name="clientId"
        defaultValue=""
        maxLength={CLIENT_ID_MAX}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? S.saving : S.saveDetails}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {S.cancel}
        </Button>
      </div>
    </form>
  );
}

/** "Rotate secret": the new client secret only, in a field that is never pre-filled. */
function SecretForm({
  accountId,
  version,
  state,
  isPending,
  dispatch,
  onCancel,
}: { readonly accountId: string; readonly version: number } & FormProps) {
  const titleId = useId();
  const failure = failureOf(state);
  const secret = useClearedAfterAnswer(state);
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!isPending) {
      dispatch(new FormData(event.currentTarget));
    }
  }
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby={titleId}
      className="grid max-w-xl gap-4 rounded-lg border p-4"
    >
      <h3 id={titleId} className="text-base font-semibold">
        {S.rotateTitle}
      </h3>
      <p className="text-sm text-muted-foreground">{S.rotateIntro}</p>
      {failure === undefined ? null : <FailureNotice state={failure} />}
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="version" value={String(version)} />
      <SecretField
        label={S.newSecretLabel}
        hint={S.newSecretHint}
        error={failure?.fieldErrors.clientSecret}
        inputRef={secret}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? S.saving : S.saveSecret}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {S.cancel}
        </Button>
      </div>
    </form>
  );
}
