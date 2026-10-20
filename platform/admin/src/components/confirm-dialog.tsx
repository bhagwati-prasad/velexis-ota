"use client";

import { useState, type ReactElement, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { CONFIRM_STRINGS } from "@/lib/strings";

export interface ConfirmDialogProps {
  /** The button that opens the dialog ("Retry"); rendered as it is, with the dialog's trigger behaviour. */
  readonly trigger: ReactElement;
  /** The question ("Retry this job?"). */
  readonly title: ReactNode;
  /** What happens, and that it cannot be undone when that is the case. */
  readonly description: ReactNode;
  /** The confirming button, naming the action ("Retry job"). */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** Style the confirming button as destructive (the default: the dialog guards destructive actions). */
  readonly destructive?: boolean;
  /**
   * Runs the action, typically a `dispatch` of `useActionState` or `useStepUpAction`; the dialog closes and the
   * caller shows the progress and the outcome.
   */
  readonly onConfirm: () => void;
}

/**
 * Confirmation of an action that needs no reason (README §2: retry a failed job, migrate an OTA, revoke an admin
 * before its step-up). An alert dialog: the focus starts on "Cancel", Escape cancels, and a click outside does not
 * close it. Actions with a mandatory reason use `ReasonDialog` instead.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = CONFIRM_STRINGS.cancel,
  destructive = true,
  onConfirm,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={destructive ? buttonVariants({ variant: "destructive" }) : undefined}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
