"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import {
  loadPayoutAccount,
  revealPayoutAccount,
  reviewPayoutAccount,
  type PayoutAccountView,
  type PayoutLoadState,
  type RevealState,
  type ReviewState,
} from "@/app/(app)/tenants/[tenantId]/payout-actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DateTime } from "@/components/date-time";
import { MaskedValue } from "@/components/masked-value";
import { ReasonDialog } from "@/components/reason-dialog";
import { RevealPanel, type RevealedField } from "@/components/reveal-panel";
import { StatusBadge } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PAYOUT_ACCOUNT_STRINGS as P, PAYOUT_SCHEME_LABELS, REVEAL_STRINGS } from "@/lib/strings";

export interface PayoutAccountPanelProps {
  readonly tenantId: string;
  /** The OTA's name, for the dialogs' questions and the revealed panel's title. */
  readonly tenantName: string;
}

const IDLE_REVEAL: RevealState = { status: "idle" };
const IDLE_REVIEW: ReviewState = { status: "idle" };

const NOTE_MAX = 1000;

/**
 * The reveal action of the panel: the server action with a form's data, or, with `null`, nothing but forgetting the
 * revealed details (the state goes back to idle in the browser, without a call), which `RevealPanel`'s `onHide` asks
 * for after 60 seconds or "Hide now".
 */
async function revealOrForget(previous: RevealState, payload: FormData | null): Promise<RevealState> {
  return payload === null ? IDLE_REVEAL : await revealPayoutAccount(previous, payload);
}

/** The answer an action shows: a step-up request is no answer yet (the dialog is open, nothing happened). */
function shownState<State extends { readonly stepUp?: true }>(state: State, idle: State): State {
  return state.stepUp === true ? idle : state;
}

function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

/** The note of a rejection: a dialog with the note for the owner (1–1000 characters after trimming). */
function RejectDialog({
  tenantName,
  disabled,
  noteError,
  onReject,
}: {
  readonly tenantName: string;
  readonly disabled: boolean;
  /** The API's refusal of the note, shown at the field when the dialog opens again. */
  readonly noteError: string | undefined;
  readonly onReject: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const noteId = useId();
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const shownError = error ?? noteError;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = note.trim();
    const problem =
      trimmed === "" ? P.noteRequired : [...trimmed].length > NOTE_MAX ? P.noteTooLong : undefined;
    if (problem !== undefined) {
      setError(problem);
      noteInput.current?.focus();
      return;
    }
    setError(undefined);
    setOpen(false);
    onReject(trimmed);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setError(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" disabled={disabled}>
          {P.reject}
        </Button>
      </DialogTrigger>
      {/* A click outside does not throw away a note being typed; Escape and "Cancel" still close the dialog. */}
      <DialogContent onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{P.rejectTitle(tenantName)}</DialogTitle>
          <DialogDescription>{P.rejectDescription}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={noteId}>{P.noteLabel}</Label>
            <p id={`${noteId}-hint`} className="text-sm text-muted-foreground">
              {P.noteHint}
            </p>
            <Textarea
              ref={noteInput}
              id={noteId}
              name="note"
              rows={4}
              value={note}
              autoFocus
              aria-describedby={
                shownError === undefined ? `${noteId}-hint` : `${noteId}-hint ${noteId}-error`
              }
              {...(shownError === undefined ? {} : { "aria-invalid": true })}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            {shownError === undefined ? null : (
              <p id={`${noteId}-error`} className="text-sm font-medium text-destructive">
                {shownError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {P.cancel}
            </Button>
            <Button type="submit" variant="destructive">
              {P.rejectConfirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The masked account, its review and the actions on it. */
function AccountDetails({
  tenantId,
  tenantName,
  account,
  onReviewed,
}: {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly account: PayoutAccountView;
  readonly onReviewed: (account: PayoutAccountView) => void;
}) {
  const reveal = useStepUpAction(revealOrForget, IDLE_REVEAL);
  const review = useStepUpAction(reviewPayoutAccount, IDLE_REVIEW);
  // A reveal hidden again (after 60 seconds or "Hide now"); a new reveal shows its details again.
  const [hidden, setHidden] = useState(false);
  // Forgetting a reveal (after 60 seconds or "Hide now") runs through the reveal action too, without a call: it does not
  // count as work in progress, so "Reveal bank details" stays usable meanwhile (a new reveal queues behind it).
  const [forgetting, setForgetting] = useState(false);
  const revealPending = reveal.isPending;
  useEffect(() => {
    if (!revealPending) {
      setForgetting(false);
    }
  }, [revealPending]);
  const pending = (revealPending && !forgetting) || review.isPending;

  // The reviewed account replaces the shown one, once per answer.
  const reviewState = review.state;
  useEffect(() => {
    if (reviewState.status === "done") {
      onReviewed(reviewState.account);
    }
  }, [reviewState, onReviewed]);

  // One array per reveal, so `RevealPanel` counts its 60 seconds once per reveal, whatever re-renders the panel.
  const revealedState = reveal.state;
  const holder = account.accountHolderName;
  const revealed = useMemo<readonly RevealedField[] | undefined>(
    () =>
      revealedState.status === "revealed" && revealedState.stepUp !== true
        ? [{ label: P.holder, value: holder }, ...revealedState.fields]
        : undefined,
    [revealedState, holder],
  );
  const { dispatch: dispatchReveal } = reveal;
  const forget = useCallback(() => {
    setHidden(true);
    setForgetting(true);
    dispatchReveal(null);
  }, [dispatchReveal]);

  function runReview(decision: "verified" | "rejected", note?: string): void {
    const formData = new FormData();
    formData.set("tenantId", tenantId);
    formData.set("version", String(account.version));
    formData.set("decision", decision);
    if (note !== undefined) {
      formData.set("note", note);
    }
    review.dispatch(formData);
  }

  const revealShown = shownState(reveal.state, IDLE_REVEAL);
  const reviewShown = shownState(review.state, IDLE_REVIEW);

  return (
    <div className="grid gap-4">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{P.holder}</dt>
        <dd>{account.accountHolderName}</dd>
        <dt className="text-muted-foreground">{P.country}</dt>
        <dd>{account.countryCode}</dd>
        <dt className="text-muted-foreground">{P.currency}</dt>
        <dd>{account.currency}</dd>
        <dt className="text-muted-foreground">{P.scheme}</dt>
        <dd>{labelOf(PAYOUT_SCHEME_LABELS, account.scheme)}</dd>
        <dt className="text-muted-foreground">{P.account}</dt>
        <dd>
          <MaskedValue label={P.maskedLabel[account.scheme]} last4={account.last4} />
        </dd>
        <dt className="text-muted-foreground">{P.status}</dt>
        <dd>
          <StatusBadge kind="payoutAccount" status={account.status} />
        </dd>
        {account.reviewNote === null ? null : (
          <>
            <dt className="text-muted-foreground">{P.reviewNote}</dt>
            <dd className="whitespace-pre-wrap">{account.reviewNote}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{P.updated}</dt>
        <dd>
          <DateTime value={account.updatedAt} />
        </dd>
      </dl>
      {account.status === "pending_review" ? <p className="text-sm">{P.pendingNote}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <ReasonDialog
          trigger={
            <Button variant="outline" disabled={pending}>
              {P.reveal}
            </Button>
          }
          title={P.revealTitle(tenantName)}
          description={P.revealDescription}
          confirmLabel={P.revealConfirm}
          destructive={false}
          onConfirm={(formData) => {
            setHidden(false);
            setForgetting(false);
            reveal.dispatch(formData);
          }}
        >
          <input type="hidden" name="tenantId" value={tenantId} />
        </ReasonDialog>
        {account.status === "verified" ? null : (
          <ConfirmDialog
            trigger={<Button disabled={pending}>{P.verify}</Button>}
            title={P.verifyTitle(tenantName)}
            description={P.verifyDescription}
            confirmLabel={P.verifyConfirm}
            destructive={false}
            onConfirm={() => runReview("verified")}
          />
        )}
        {account.status === "rejected" ? null : (
          <RejectDialog
            tenantName={tenantName}
            disabled={pending}
            noteError={reviewShown.status === "failed" ? reviewShown.noteError : undefined}
            onReject={(note) => runReview("rejected", note)}
          />
        )}
        {pending ? <span className="text-sm text-muted-foreground">{P.working}</span> : null}
      </div>
      {revealShown.status === "failed" ? (
        <Alert variant="destructive" data-notice="failed" data-code={revealShown.code}>
          <AlertDescription>{revealShown.message}</AlertDescription>
        </Alert>
      ) : null}
      {reviewShown.status === "failed" ? (
        <Alert variant="destructive" data-notice="failed" data-code={reviewShown.code}>
          <AlertDescription>
            <p>{reviewShown.noteError ?? reviewShown.message}</p>
            {reviewShown.code === "PRECONDITION_FAILED" ? (
              // A full reload, so the panel loads the account as it is now, with its new version.
              <a
                href={`/tenants/${encodeURIComponent(tenantId)}?tab=connections`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                {P.reload}
              </a>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {reviewShown.status === "done" ? (
        <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">{reviewShown.decision === "verified" ? P.verified : P.rejected}</p>
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{P.statusNow}</span>
            <StatusBadge kind="payoutAccount" status={reviewShown.account.status} />
          </p>
        </div>
      ) : null}
      {revealed === undefined ? null : (
        <RevealPanel title={P.revealedTitle(tenantName)} fields={revealed} onHide={forget} />
      )}
      {hidden && revealed === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {REVEAL_STRINGS.hidden}
        </p>
      ) : null}
      {reveal.stepUpDialog}
      {review.stepUpDialog}
    </div>
  );
}

/**
 * The payout account of an OTA on its page (README §2 tenant detail, §4 reveal; scope PF-64 AC2, PF-91), in the
 * connections tab: masked as the portal shows it (holder, bank country, currency, kind, the last four characters of the
 * IBAN or account number), with its review status and note. The panel loads it when it is shown
 * (`loadPayoutAccount`), so the page stays one `adminGetTenant` call and a tab that is not opened asks nothing.
 *
 * - **Reveal bank details** (`ReasonDialog`, then the step-up the API asks for): the identifiers show in `RevealPanel`
 *   from React state only, count down and leave the page after 60 seconds or on "Hide now", when the panel forgets its
 *   copy too; revealing again is a new, audited call.
 * - **Verify** (`ConfirmDialog`) unless verified, **Reject** (a note for the owner) unless rejected, both with the
 *   account's version in `If-Match`; the answer replaces the shown account.
 *
 * The component gets the OTA's id and name only.
 */
export function PayoutAccountPanel({ tenantId, tenantName }: PayoutAccountPanelProps) {
  const titleId = useId();
  const [load, setLoad] = useState<PayoutLoadState | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [reviewed, setReviewed] = useState<PayoutAccountView | undefined>(undefined);

  useEffect(() => {
    let current = true;
    loadPayoutAccount(tenantId).then(
      (answer) => {
        if (current) {
          setLoad(answer);
        }
      },
      () => {
        // A redirect to sign-in, or an action that could not be called; a later attempt asks again.
        if (current) {
          setLoad({ status: "failed", code: "SERVICE_UNAVAILABLE", message: P.unavailable });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [tenantId, attempt]);

  const loaded = load?.status === "loaded" ? load.account : undefined;
  // The newest of the loaded and the reviewed account.
  const account =
    reviewed !== undefined && (loaded === undefined || reviewed.version >= loaded.version)
      ? reviewed
      : loaded;

  return (
    <section
      aria-labelledby={titleId}
      id="payout-account"
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <h2 id={titleId} className="text-lg font-semibold tracking-tight">
        {P.title}
      </h2>
      <p className="text-sm text-muted-foreground">{P.intro}</p>
      {load === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {P.loading}
        </p>
      ) : load.status === "failed" ? (
        <Alert variant="destructive" data-notice="failed" data-code={load.code}>
          <AlertDescription>
            <p>{P.unavailable}</p>
            {load.message === P.unavailable ? null : <p>{load.message}</p>}
            <Button
              type="button"
              variant="outline"
              className="mt-2 w-fit"
              onClick={() => {
                setLoad(undefined);
                setAttempt((value) => value + 1);
              }}
            >
              {P.tryAgain}
            </Button>
          </AlertDescription>
        </Alert>
      ) : load.status === "none" || account === undefined ? (
        <p className="text-sm">{P.none}</p>
      ) : (
        <AccountDetails
          tenantId={tenantId}
          tenantName={tenantName}
          account={account}
          onReviewed={setReviewed}
        />
      )}
      <p className="text-sm">
        <Link
          href={`/settlements?${new URLSearchParams({ tenantId }).toString()}`}
          className="font-medium underline underline-offset-4"
        >
          {P.statements}
        </Link>
      </p>
    </section>
  );
}
