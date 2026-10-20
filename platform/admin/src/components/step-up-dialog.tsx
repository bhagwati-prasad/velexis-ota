"use client";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { stepUp, type StepUpRequired, type StepUpState } from "@/app/(app)/step-up-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STEP_UP_STRINGS } from "@/lib/strings";

/** The action state asks for a step-up: its API call answered `REAUTH_REQUIRED` (`StepUpRequired`). */
export function isStepUpRequired(state: unknown): state is StepUpRequired {
  return typeof state === "object" && state !== null && (state as { stepUp?: unknown }).stepUp === true;
}

export interface StepUpDialogProps {
  /** Show the dialog. */
  readonly open: boolean;
  /** The code was accepted and the new session is stored: re-submit the original action. */
  readonly onVerified: () => void;
  /** The admin closed the dialog without a code. */
  readonly onCancel: () => void;
}

/**
 * The TOTP prompt of a sensitive admin action (README §2 "step-up", §4): it sends the code to the `stepUp` action
 * (`adminStepUp`), which stores the new session, and reports `onVerified` so the caller re-submits. Most forms use
 * `useStepUpAction`, which wires all of it.
 */
export function StepUpDialog({ open, onVerified, onCancel }: StepUpDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{STEP_UP_STRINGS.title}</DialogTitle>
          <DialogDescription>{STEP_UP_STRINGS.description}</DialogDescription>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so every opening starts with a fresh form state. */}
        <StepUpForm onVerified={onVerified} onCancel={onCancel} />
      </DialogContent>
    </Dialog>
  );
}

const IDLE: StepUpState = { status: "idle" };

function StepUpForm({ onVerified, onCancel }: Omit<StepUpDialogProps, "open">) {
  const [state, verify, verifying] = useActionState(stepUp, IDLE);
  const codeId = useId();
  const hintId = `${codeId}-hint`;
  const errorId = `${codeId}-error`;
  const codeInput = useRef<HTMLInputElement>(null);
  const handled = useRef<StepUpState>(IDLE);

  useEffect(() => {
    // Once per answer, even when the parent re-renders with a new callback.
    if (handled.current === state) {
      return;
    }
    handled.current = state;
    if (state.status === "verified") {
      onVerified();
    } else if (state.status === "failed") {
      codeInput.current?.focus();
    }
  }, [state, onVerified]);

  const failure = state.status === "failed" ? state : undefined;
  const fieldError = failure?.fieldError;
  return (
    <form action={verify} noValidate className="grid gap-4">
      {failure?.message === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor={codeId}>{STEP_UP_STRINGS.codeLabel}</Label>
        <p id={hintId} className="text-sm text-muted-foreground">
          {STEP_UP_STRINGS.codeHint}
        </p>
        <Input
          ref={codeInput}
          id={codeId}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          autoFocus
          aria-describedby={fieldError === undefined ? hintId : `${hintId} ${errorId}`}
          {...(fieldError === undefined ? {} : { "aria-invalid": true })}
        />
        {fieldError === undefined ? null : (
          <p id={errorId} className="text-sm font-medium text-destructive">
            {fieldError}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {STEP_UP_STRINGS.cancel}
        </Button>
        <Button type="submit" disabled={verifying}>
          {verifying ? STEP_UP_STRINGS.submitting : STEP_UP_STRINGS.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A server action as `useActionState` takes it. */
export type StateAction<State, Payload> = (state: Awaited<State>, payload: Payload) => State | Promise<State>;

/** What `useStepUpAction` gives a form. */
export interface StepUpAction<State, Payload> {
  /** The action's latest state. */
  readonly state: State;
  /** Runs the action (a form's `action`, or a dialog's `onConfirm`); the payload is kept for the re-submission. */
  readonly dispatch: (payload: Payload) => void;
  /** The action is running (first submission or re-submission). */
  readonly isPending: boolean;
  /** The step-up dialog, to render once next to the form. */
  readonly stepUpDialog: ReactNode;
}

/**
 * `useActionState` for an admin action that may answer `StepUpRequired` (README §4). When the action's state asks
 * for a step-up, the returned dialog opens; after a valid code the original action runs again with the same payload
 * (the `FormData` of the submission, the reason of a `ReasonDialog` included), now with the new access token.
 * Cancelling keeps the state as it is.
 *
 * ```tsx
 * const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(grantAdmin, INITIAL);
 * return (
 *   <>
 *     <ReasonDialog … onConfirm={dispatch} />
 *     {stepUpDialog}
 *   </>
 * );
 * ```
 *
 * Render the dialog next to the form, not inside it: the dialog has a form of its own.
 */
export function useStepUpAction<State, Payload>(
  action: StateAction<State, Payload>,
  initialState: Awaited<State>,
): StepUpAction<Awaited<State>, Payload> {
  const [state, dispatchAction, isPending] = useActionState(action, initialState);
  const lastPayload = useRef<{ readonly payload: Payload } | undefined>(undefined);
  // The state whose step-up request was answered (verified or cancelled); a new request opens the dialog again.
  const [answered, setAnswered] = useState<Awaited<State> | undefined>(undefined);

  const dispatch = useCallback(
    (payload: Payload) => {
      lastPayload.current = { payload };
      startTransition(() => dispatchAction(payload));
    },
    [dispatchAction],
  );

  const onVerified = useCallback(() => {
    setAnswered(() => state);
    const last = lastPayload.current;
    if (last !== undefined) {
      startTransition(() => dispatchAction(last.payload));
    }
  }, [state, dispatchAction]);

  const onCancel = useCallback(() => setAnswered(() => state), [state]);

  const open = isStepUpRequired(state) && answered !== state;
  return {
    state,
    dispatch,
    isPending,
    stepUpDialog: <StepUpDialog open={open} onVerified={onVerified} onCancel={onCancel} />,
  };
}
