"use client";

import { useId, useRef, useState, type FormEvent } from "react";

import { normalizeReason, reasonLength, reasonProblem } from "@/components/reason-dialog";
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
import { OFFICE_ACTION_STRINGS as S, REASON_STRINGS } from "@/lib/strings";

/**
 * "Release" on an office of the pool (README §2 `/amadeus/offices`; PADR-0012 item 5; flows/amadeus-connection.md §D
 * item 5; PF-90): the dialog of `adminReleaseAmadeusOffice`, which takes `confirmNoOpenBookings: true` and a reason.
 * The admin ticks that the OTA confirmed, from its bookings console filtered by the office, that no booking with future
 * travel remains on it, and writes the reason (5–500 characters after trimming, stored in the audit log). Without the
 * box or with a reason out of bounds the dialog says so at the field, keeps the focus there and runs nothing; the
 * server action checks both again. A `releasing` office (the OTA moved to its own credentials) and an `assigned` one
 * (released only while the OTA's connection that holds it is not active, PADR-0012 item 8) say what the release does
 * for each.
 */

/** The office being released: the fields the dialog shows and sends. */
export interface ReleaseOffice {
  /** The pool entry (`amo_…`), which the API releases. */
  readonly id: string;
  /** The Amadeus office id ("NCE1A0955"). */
  readonly officeId: string;
  readonly status: "releasing" | "assigned";
  /** The OTA the office is assigned to, which it leaves. */
  readonly tenantId: string;
  readonly tenantKey: string;
}

export interface ReleaseDialogProps {
  readonly office: ReleaseOffice;
  /** Another action of the table is on its way. */
  readonly disabled?: boolean;
  /**
   * Runs the release with the dialog's `FormData` (`officeRowId`, `tenantId`, `confirmNoOpenBookings=true` and the
   * trimmed `reason`): the `dispatch` of `useStepUpAction`, so a step-up would send the same again. The dialog closes;
   * the table shows the progress and the outcome.
   */
  readonly onConfirm: (formData: FormData) => void;
}

export function ReleaseDialog({ office, disabled = false, onConfirm }: ReleaseDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          {S.release}
          <span className="sr-only">{S.officeSuffix(office.officeId)}</span>
        </Button>
      </DialogTrigger>
      {/* A click outside does not throw away a reason being typed; Escape and "Cancel" still close the dialog. */}
      <DialogContent onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{S.releaseTitle(office.officeId)}</DialogTitle>
          <DialogDescription>
            {office.status === "releasing"
              ? S.releaseDescriptionReleasing(office.tenantKey)
              : S.releaseDescriptionAssigned(office.tenantKey)}
          </DialogDescription>
        </DialogHeader>
        {/* The form unmounts when the dialog closes, so every opening starts unticked and without a reason. */}
        <ReleaseForm
          office={office}
          onCancel={() => setOpen(false)}
          onConfirm={(formData) => {
            setOpen(false);
            onConfirm(formData);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

interface ReleaseFormProps {
  readonly office: ReleaseOffice;
  readonly onCancel: () => void;
  readonly onConfirm: (formData: FormData) => void;
}

function ReleaseForm({ office, onCancel, onConfirm }: ReleaseFormProps) {
  const id = useId();
  const confirmId = `${id}-confirm`;
  const confirmErrorId = `${id}-confirm-error`;
  const reasonId = `${id}-reason`;
  const hintId = `${id}-reason-hint`;
  const reasonErrorId = `${id}-reason-error`;
  const confirmInput = useRef<HTMLInputElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmError, setConfirmError] = useState<string | undefined>(undefined);
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const missingConfirmation = confirmed ? undefined : S.confirmRequired;
    const problem = reasonProblem(reason);
    setConfirmError(missingConfirmation);
    setReasonError(problem);
    if (missingConfirmation !== undefined) {
      confirmInput.current?.focus();
      return;
    }
    if (problem !== undefined) {
      reasonInput.current?.focus();
      return;
    }
    const formData = new FormData();
    formData.set("officeRowId", office.id);
    formData.set("tenantId", office.tenantId);
    formData.set("confirmNoOpenBookings", "true");
    formData.set("reason", normalizeReason(reason));
    onConfirm(formData);
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <div className="grid gap-2">
        <div className="flex items-start gap-3">
          <input
            ref={confirmInput}
            id={confirmId}
            type="checkbox"
            name="confirmNoOpenBookings"
            value="true"
            checked={confirmed}
            required
            className="mt-1 size-4"
            {...(confirmError === undefined
              ? {}
              : { "aria-describedby": confirmErrorId, "aria-invalid": true as const })}
            onChange={(event) => {
              setConfirmed(event.currentTarget.checked);
              if (event.currentTarget.checked) {
                setConfirmError(undefined);
              }
            }}
          />
          <Label htmlFor={confirmId} className="leading-snug">
            {S.confirmLabel(office.tenantKey, office.officeId)}
          </Label>
        </div>
        {confirmError === undefined ? null : (
          <p id={confirmErrorId} className="text-sm font-medium text-destructive">
            {confirmError}
          </p>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={reasonId}>{REASON_STRINGS.label}</Label>
        <p id={hintId} className="text-sm text-muted-foreground">
          {REASON_STRINGS.hint}
        </p>
        <Textarea
          ref={reasonInput}
          id={reasonId}
          name="reason"
          value={reason}
          rows={4}
          required
          aria-describedby={reasonError === undefined ? hintId : `${hintId} ${reasonErrorId}`}
          {...(reasonError === undefined ? {} : { "aria-invalid": true })}
          onChange={(event) => {
            setReason(event.currentTarget.value);
            // A corrected reason clears the message; the next submission checks it again.
            if (reasonError !== undefined && reasonProblem(event.currentTarget.value) === undefined) {
              setReasonError(undefined);
            }
          }}
        />
        <p className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
          {REASON_STRINGS.counter(reasonLength(reason))}
        </p>
        {reasonError === undefined ? null : (
          <p id={reasonErrorId} className="text-sm font-medium text-destructive">
            {reasonError}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {S.cancel}
        </Button>
        <Button type="submit" variant="destructive">
          {S.releaseConfirm}
        </Button>
      </DialogFooter>
    </form>
  );
}
