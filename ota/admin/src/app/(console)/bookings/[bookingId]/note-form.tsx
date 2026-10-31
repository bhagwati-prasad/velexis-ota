"use client";

// "Add a note" on a booking's Timeline and notes tab (OAD-008, routes.md §3.2 "Actions"): `console.bookings.addNote`
// (`addNote`, `bookings:write`), internal by default, shown to the customer too only when the staff member ticks it. The
// form carries the idempotency key the page rendered with it, so a double click or a retry adds one note; the button is
// disabled while the note is being saved. A success empties the text, and the page's new render brings a new key for
// the next note; a final refusal the API stored under the key brings a new one with the action's state, which the next
// submission sends (`useActionKey` of the confirmation dialog, OADR-0018 point 5 revised on 2026-10-27, FIX-W31-OTA);
// `409 IDEMPOTENCY_KEY_REUSED` brings none and asks for a reload (revised on 2026-10-28, FIX-W32-OTA).
// The note is never sent to Amadeus and changes no booking version.
import { LoaderCircleIcon } from "lucide-react";
import { startTransition, useActionState, useEffect, useId, useState, type FormEvent } from "react";

import {
  BOOKING_ID_FIELD,
  NOTE_TEXT_FIELD,
  NOTE_VISIBLE_FIELD,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { addNote } from "@/app/(console)/bookings/[bookingId]/actions";
import { useActionKey } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_KEY_FIELD, INITIAL_ACTION_STATE, fieldError } from "@/lib/action-state";
import { cn } from "@/lib/utils";

export const NOTE_STRINGS = Object.freeze({
  title: "Add a note",
  label: "Note",
  hint: "Internal unless you tick the box below. Notes are never sent to Amadeus.",
  visible: "Visible to the customer in their booking's timeline",
  submit: "Add note",
  working: "Saving…",
  required: "Enter the note.",
  requestId: (requestId: string) => `Request id ${requestId}`,
});

/** The longest note the API takes. */
export const NOTE_MAX_LENGTH = 2000;

export interface NoteFormProps {
  readonly bookingId: string;
  /** The idempotency key rendered with the page (replaced by a new one an action's state brings: `useActionKey`). */
  readonly idempotencyKey: string;
}

/** The note form of the Timeline and notes tab. */
export function NoteForm({ bookingId, idempotencyKey }: NoteFormProps) {
  const [state, dispatch, pending] = useActionState(addNote, INITIAL_ACTION_STATE);
  const actionKey = useActionKey(idempotencyKey, state);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const error = problem ?? fieldError(state, NOTE_TEXT_FIELD);

  useEffect(() => {
    if (state.ok === true) {
      setText("");
    }
  }, [state]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (text.trim() === "") {
      setProblem(NOTE_STRINGS.required);
      return;
    }
    setProblem(undefined);
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  return (
    <form noValidate onSubmit={submit} aria-label={NOTE_STRINGS.title} className="grid max-w-2xl gap-2">
      <input type="hidden" name={BOOKING_ID_FIELD} value={bookingId} />
      <input type="hidden" name={ACTION_KEY_FIELD} value={actionKey} />
      <Label htmlFor={id}>{NOTE_STRINGS.label}</Label>
      <p id={hintId} className="text-xs text-muted-foreground">
        {NOTE_STRINGS.hint}
      </p>
      <Textarea
        id={id}
        name={NOTE_TEXT_FIELD}
        value={text}
        rows={3}
        maxLength={NOTE_MAX_LENGTH}
        autoComplete="off"
        aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
        {...(error === undefined ? {} : { "aria-invalid": true })}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      {error === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <input
          id={`${id}-visible`}
          type="checkbox"
          name={NOTE_VISIBLE_FIELD}
          value="true"
          className="size-4 accent-primary"
        />
        <Label htmlFor={`${id}-visible`}>{NOTE_STRINGS.visible}</Label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
          {pending ? NOTE_STRINGS.working : NOTE_STRINGS.submit}
        </Button>
        {state.message === undefined ? null : (
          <p
            role={state.ok === true ? "status" : "alert"}
            className={cn("text-sm", state.ok === true ? "text-muted-foreground" : "text-destructive")}
          >
            {state.message}
            {state.requestId === undefined ? null : ` (${NOTE_STRINGS.requestId(state.requestId)})`}
          </p>
        )}
      </div>
    </form>
  );
}
