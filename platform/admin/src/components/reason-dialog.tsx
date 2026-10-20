"use client";

import { useId, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";

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
import { REASON_MAX_LENGTH, REASON_MIN_LENGTH, REASON_STRINGS } from "@/lib/strings";

/**
 * The reason as it is sent: without leading and trailing white space, so a reason of spaces is no reason. Its
 * length is counted in Unicode code points, as JSON Schema's `minLength` and `maxLength` of `AdminReason` count it.
 */
export function normalizeReason(value: string): string {
  return value.trim();
}

/** The number of characters of `value` as `AdminReason` counts them (code points, after `normalizeReason`). */
export function reasonLength(value: string): number {
  return [...normalizeReason(value)].length;
}

/** What is wrong with `value` as an `AdminReason` (5–500 characters), or `undefined` when it is a valid reason. */
export function reasonProblem(value: string): string | undefined {
  const length = reasonLength(value);
  if (length === 0) {
    return REASON_STRINGS.required;
  }
  if (length < REASON_MIN_LENGTH) {
    return REASON_STRINGS.tooShort;
  }
  if (length > REASON_MAX_LENGTH) {
    return REASON_STRINGS.tooLong;
  }
  return undefined;
}

export interface ReasonDialogProps {
  /** The button that opens the dialog ("Suspend"); rendered as it is, with the dialog's trigger behaviour. */
  readonly trigger: ReactElement;
  /** The question ("Suspend Acme Travel?"). */
  readonly title: ReactNode;
  /** What the action does; the dialog adds that the reason goes into the audit log. */
  readonly description: ReactNode;
  /** The confirming button, naming the action ("Suspend OTA"). */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** Style the confirming button as destructive (the default: reason actions change what an OTA or account may do). */
  readonly destructive?: boolean;
  /** The form field of the reason; `reason`, as in `AdminReasonRequest`, by default. */
  readonly name?: string;
  /**
   * Other fields of the action, rendered above the reason inside the dialog's form (the suspension reason type, a
   * hidden id); their values travel in the same `FormData`.
   */
  readonly children?: ReactNode;
  /**
   * Runs the action with the dialog's `FormData`: the other fields and the normalised reason (5–500 characters).
   * Typically the `dispatch` of `useStepUpAction`, so a step-up re-submits the same reason. The dialog closes and the
   * caller shows the progress and the outcome; its server action validates the reason again.
   */
  readonly onConfirm: (formData: FormData) => void;
}

/**
 * The mandatory reason of a **reason** action (README §2: suspend, resume, disable a connection, cancel a job, release
 * or retire an office, …; PADR-0006 item 5). The admin types 5 to 500 characters; a shorter or longer reason is
 * refused at the field and nothing runs. The reason is stored in the audit log with the action.
 */
export function ReasonDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = REASON_STRINGS.cancel,
  destructive = true,
  name = "reason",
  children,
  onConfirm,
}: ReasonDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      {/* A click outside does not throw away a reason being typed; Escape and "Cancel" still close the dialog. */}
      <DialogContent onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* The form unmounts when the dialog closes, so every opening starts with an empty reason. */}
        <ReasonForm
          name={name}
          confirmLabel={confirmLabel}
          cancelLabel={cancelLabel}
          destructive={destructive}
          onCancel={() => setOpen(false)}
          onConfirm={(formData) => {
            setOpen(false);
            onConfirm(formData);
          }}
        >
          {children}
        </ReasonForm>
      </DialogContent>
    </Dialog>
  );
}

interface ReasonFormProps {
  readonly name: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly destructive: boolean;
  readonly children?: ReactNode;
  readonly onCancel: () => void;
  readonly onConfirm: (formData: FormData) => void;
}

function ReasonForm({
  name,
  confirmLabel,
  cancelLabel,
  destructive,
  children,
  onCancel,
  onConfirm,
}: ReasonFormProps) {
  const reasonId = useId();
  const hintId = `${reasonId}-hint`;
  const errorId = `${reasonId}-error`;
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const problem = reasonProblem(reason);
    if (problem !== undefined) {
      setError(problem);
      reasonInput.current?.focus();
      return;
    }
    const formData = new FormData(event.currentTarget);
    formData.set(name, normalizeReason(reason));
    onConfirm(formData);
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      {children}
      <div className="grid gap-2">
        <Label htmlFor={reasonId}>{REASON_STRINGS.label}</Label>
        <p id={hintId} className="text-sm text-muted-foreground">
          {REASON_STRINGS.hint}
        </p>
        <Textarea
          ref={reasonInput}
          id={reasonId}
          name={name}
          value={reason}
          rows={4}
          required
          autoFocus
          aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
          {...(error === undefined ? {} : { "aria-invalid": true })}
          onChange={(event) => {
            setReason(event.currentTarget.value);
            // A corrected reason clears the message; the next submission checks it again.
            if (error !== undefined && reasonProblem(event.currentTarget.value) === undefined) {
              setError(undefined);
            }
          }}
        />
        <p className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
          {REASON_STRINGS.counter(reasonLength(reason))}
        </p>
        {error === undefined ? null : (
          <p id={errorId} className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="submit" variant={destructive ? "destructive" : "default"}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
