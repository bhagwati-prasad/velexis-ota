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
import { FormField } from "@/components/form-field";
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
  /** The person closed the dialog without a code. */
  readonly onCancel: () => void;
}

/**
 * The TOTP prompt of a sensitive action (README §4, PADR-0008): it sends the code to the `stepUp` action, which
 * stores the new session, and reports `onVerified` so the caller re-submits. Most forms use `useStepUpAction`,
 * which wires all of it.
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
  return (
    <form action={verify} noValidate className="grid gap-4">
      {failure?.message === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
      <FormField
        ref={codeInput}
        id={codeId}
        name="code"
        label={STEP_UP_STRINGS.codeLabel}
        description={STEP_UP_STRINGS.codeHint}
        error={failure?.fieldError}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
      />
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
  /** Runs the action (a form's `action`, or a button's handler); the payload is kept for the re-submission. */
  readonly dispatch: (payload: Payload) => void;
  /** The action is running (first submission or re-submission). */
  readonly isPending: boolean;
  /** The step-up dialog, to render once next to the form. */
  readonly stepUpDialog: ReactNode;
}

/**
 * `useActionState` for an action that may answer `StepUpRequired` (README §5). When the action's state asks for
 * a step-up, the returned dialog opens; after a valid code the original action runs again with the same payload
 * (the `FormData` of the submission), now with the new access token. Cancelling keeps the state as it is.
 *
 * ```tsx
 * const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(goLive, INITIAL);
 * return (
 *   <>
 *     <form action={dispatch}>…</form>
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
