"use client";

// The confirmation dialog of the OTA admin's state-changing actions (README §7 and §9, OADR-0018 points 5 and 6,
// routes.md §3.2): issue, cancel, capture, refund, import, resync and settings deletes. It shows a summary of the
// effect (amount, refund mode, environment), asks for the required reason that the API stores in `staff_actions`,
// repeats "LIVE" in the live environment, and carries a hidden idempotency key that the page rendered once: a double
// click, a retry after a timeout, a network error, a `412` or a `5xx` all send the same key, so the API replays the
// action (or waits for it) instead of issuing or refunding twice.
//
// After a final refusal that the API stores under the key (a stored `4xx` but `412`; `429` and a request still running
// under the key are not stored), the action's state brings a new key (`nextActionKey`, lib/action-state.ts
// `withNextActionKey`), which the dialog sends from then on (`useActionKey`): a corrected resubmission, an amount
// lowered after a `422` say, is a new request instead of a `409 IDEMPOTENCY_KEY_REUSED` that only a reload would end
// (OADR-0018 point 5, revision of 2026-10-27, FIX-W31-OTA). After `409 IDEMPOTENCY_KEY_REUSED` itself no new key comes
// (revision of 2026-10-28, FIX-W32-OTA): an earlier request under the key, with other values, may still be running or
// may have refunded or captured, so the dialog keeps its key and its message tells staff to reload the page. Every
// dialog built on this one gets it; the note form of a booking uses the same hook.
//
// The action is a server action for `useActionState` (`(state, formData) => Promise<ActionState>`). It receives the
// form's fields: the hidden `fields` (`bookingId`, `version`), the inputs of `children`, the trimmed `reason` and the
// key as `actionKey`. It must validate the reason again (Zod) and start with `requireStaff(permission)`; after a
// success it revalidates the page, whose new render brings a new key for the next action; after the failure of a call
// that carried the key it answers `withNextActionKey(state, error)`.
//
// `askReason={false}` (OAD-013) is for an operation whose contract takes no reason (the settings deletes: a markup or
// fee rule's `DELETE` has no body): the dialog then shows no reason field and posts none, because a reason the API
// never stores would only pretend to be audited; the confirmation, the environment badge and the key stay.
import { LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import {
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { EnvironmentBadge } from "@/components/env-banner";
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
import {
  ACTION_KEY_FIELD,
  INITIAL_ACTION_STATE,
  REASON_FIELD,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  actionKeyAfter,
  fieldError,
  fieldErrorId,
  type ActionState,
} from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";

// The field names and the reason's bounds live in lib/action-state.ts, which server actions can import too.
export { ACTION_KEY_FIELD, REASON_FIELD, REASON_MAX_LENGTH, REASON_MIN_LENGTH };

/**
 * The idempotency key of a dialog's or form's next submission (OADR-0018 point 5, revision of 2026-10-27): the key the
 * page rendered (`rendered`) until an action's state brings a new one (`nextActionKey`, after a final refusal the API
 * stored under the key), which every later submission sends until the next one comes; a state without a new key (a
 * retry after a timeout, a `412`, a `5xx`, a `409 IDEMPOTENCY_KEY_REUSED` since 2026-10-28, the form's own validation)
 * keeps the current key. A new render of the page
 * (after a success, which revalidates it, or a reload) brings a new `rendered` key, which replaces it.
 */
export function useActionKey(rendered: string, state: ActionState): string {
  const [current, setCurrent] = useState({ rendered, state, key: rendered });
  if (current.rendered !== rendered) {
    setCurrent({ rendered, state, key: rendered });
    return rendered;
  }
  if (current.state !== state) {
    const key = actionKeyAfter(current.key, state);
    setCurrent({ rendered, state, key });
    return key;
  }
  return current.key;
}

export const CONFIRM_STRINGS = Object.freeze({
  reasonLabel: "Reason",
  reasonHint: "Saved with the staff action in the audit trail.",
  reasonRequired: "Enter a reason.",
  reasonTooShort: (min: number) => `Enter at least ${min} characters.`,
  reasonTooLong: (max: number) => `Use at most ${max} characters.`,
  counter: (length: number, max: number) => `${length} / ${max}`,
  cancel: "Cancel",
  working: "Working…",
  liveWarning: "LIVE: this changes real bookings, tickets and payments.",
  liveConfirm: (label: string) => `${label} in LIVE`,
  requestId: (requestId: string) => `Request id ${requestId}`,
});

/** The reason as it is sent: without leading and trailing white space, so a reason of spaces is no reason. */
export function normalizeReason(value: string): string {
  return value.trim();
}

/** The length of a reason as JSON Schema counts it (Unicode code points, after `normalizeReason`). */
export function reasonLength(value: string): number {
  return [...normalizeReason(value)].length;
}

/** What is wrong with `value` as a reason, or `undefined` when it is one. */
export function reasonProblem(
  value: string,
  min: number = REASON_MIN_LENGTH,
  max: number = REASON_MAX_LENGTH,
): string | undefined {
  const length = reasonLength(value);
  if (length === 0) {
    return CONFIRM_STRINGS.reasonRequired;
  }
  if (length < min) {
    return CONFIRM_STRINGS.reasonTooShort(min);
  }
  if (length > max) {
    return CONFIRM_STRINGS.reasonTooLong(max);
  }
  return undefined;
}

/** A server action for `useActionState`. */
export type ConfirmAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

export interface ConfirmDialogProps {
  /** The button that opens the dialog ("Issue tickets"); rendered as it is, with the dialog's trigger behaviour. */
  readonly trigger: ReactElement;
  /** The question ("Issue the tickets of VX-7K2M9Q?"). */
  readonly title: ReactNode;
  /** What will happen: the amount, the refund mode, what cannot be undone. */
  readonly summary: ReactNode;
  /** The confirming button, naming the action ("Issue tickets"); "in LIVE" is added in the live environment. */
  readonly confirmLabel: string;
  /** The environment the action runs in (the request's, from the layout or `getConsoleRequest`). */
  readonly environment: StaffEnvironment;
  /** The server action. */
  readonly action: ConfirmAction;
  /**
   * The idempotency key, rendered once with the page (`crypto.randomUUID()` in the server component): the same for
   * every submission of this render, until the action's state brings a new one (`useActionKey`).
   */
  readonly idempotencyKey: string;
  /** Hidden fields of the action (`bookingId`, `version` for `ifMatch`). */
  readonly fields?: Readonly<Record<string, string>>;
  /**
   * Other inputs of the action (amount, refund mode), above the reason. A function gets the dialog's current state, so
   * the inputs can show their own field errors (`fieldError(state, name)`); a reopened dialog passes the initial state.
   */
  readonly children?: ReactNode | ((state: ActionState) => ReactNode);
  /** Bounds of the reason; 3 to 500 characters by default. */
  readonly reasonMinLength?: number;
  readonly reasonMaxLength?: number;
  /**
   * Ask for the reason (the default). `false` for an operation whose contract takes none (the settings deletes): no
   * reason field is shown or posted.
   */
  readonly askReason?: boolean;
  /** Style the confirming button as destructive (the default: these actions change bookings and money). */
  readonly destructive?: boolean;
}

/**
 * A dialog with the action's summary, a required reason, the environment badge, the live warning and the hidden
 * idempotency key. It stays open with the message, the request id and the field errors of a failure, and closes on
 * success with the action's message beside the trigger.
 */
export function ConfirmDialog({
  trigger,
  title,
  summary,
  confirmLabel,
  environment,
  action,
  idempotencyKey,
  fields = {},
  children,
  reasonMinLength = REASON_MIN_LENGTH,
  reasonMaxLength = REASON_MAX_LENGTH,
  askReason = true,
  destructive = true,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, dispatch, pending] = useActionState(action, INITIAL_ACTION_STATE);
  // Kept here, not in the form, so a dialog closed and opened again goes on with the key it was last given.
  const actionKey = useActionKey(idempotencyKey, state);
  // The state already seen when the dialog was last opened: its message is not shown again.
  const [seen, setSeen] = useState<ActionState>(INITIAL_ACTION_STATE);
  const fresh = state !== seen;
  // A success closes the dialog once its state is on the screen, so the message beside the trigger shows with it.
  useEffect(() => {
    if (state.ok === true) {
      setOpen(false);
    }
  }, [state]);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setSeen(state);
          }
          setOpen(next);
        }}
      >
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        {/* A click outside does not throw a typed reason away; Escape and "Cancel" still close the dialog. */}
        <DialogContent onInteractOutside={(event) => event.preventDefault()}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>{title}</DialogTitle>
              <EnvironmentBadge environment={environment} />
            </div>
            <DialogDescription asChild>
              <div>{summary}</div>
            </DialogDescription>
          </DialogHeader>
          <ConfirmForm
            confirmLabel={confirmLabel}
            environment={environment}
            idempotencyKey={actionKey}
            fields={fields}
            reasonMinLength={reasonMinLength}
            reasonMaxLength={reasonMaxLength}
            askReason={askReason}
            destructive={destructive}
            pending={pending}
            state={fresh ? state : INITIAL_ACTION_STATE}
            onCancel={() => setOpen(false)}
            onSubmit={(formData) => startTransition(() => dispatch(formData))}
          >
            {children}
          </ConfirmForm>
        </DialogContent>
      </Dialog>
      {fresh && state.ok === true && state.message !== undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

interface ConfirmFormProps {
  readonly confirmLabel: string;
  readonly environment: StaffEnvironment;
  readonly idempotencyKey: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly reasonMinLength: number;
  readonly reasonMaxLength: number;
  readonly askReason: boolean;
  readonly destructive: boolean;
  readonly pending: boolean;
  readonly state: ActionState;
  readonly children?: ReactNode | ((state: ActionState) => ReactNode);
  readonly onCancel: () => void;
  readonly onSubmit: (formData: FormData) => void;
}

/** The form inside the dialog; it unmounts when the dialog closes, so every opening starts with an empty reason. */
function ConfirmForm({
  confirmLabel,
  environment,
  idempotencyKey,
  fields,
  reasonMinLength,
  reasonMaxLength,
  askReason,
  destructive,
  pending,
  state,
  children,
  onCancel,
  onSubmit,
}: ConfirmFormProps) {
  const reasonId = useId();
  const hintId = `${reasonId}-hint`;
  const errorId = fieldErrorId(`${reasonId}-${REASON_FIELD}`);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const reasonError = problem ?? fieldError(state, REASON_FIELD);
  const live = environment === "live";

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!askReason) {
      onSubmit(new FormData(event.currentTarget));
      return;
    }
    const found = reasonProblem(reason, reasonMinLength, reasonMaxLength);
    if (found !== undefined) {
      setProblem(found);
      reasonInput.current?.focus();
      return;
    }
    const formData = new FormData(event.currentTarget);
    formData.set(REASON_FIELD, normalizeReason(reason));
    onSubmit(formData);
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name={ACTION_KEY_FIELD} value={idempotencyKey} />
      {live ? (
        <p
          role="note"
          className="flex items-center gap-2 rounded-md border border-amber-500 bg-amber-100 px-3 py-2 text-sm font-medium text-amber-950"
        >
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
          {CONFIRM_STRINGS.liveWarning}
        </p>
      ) : null}
      {typeof children === "function" ? children(state) : children}
      {askReason ? (
        <div className="grid gap-2">
          <Label htmlFor={reasonId}>{CONFIRM_STRINGS.reasonLabel}</Label>
          <p id={hintId} className="text-sm text-muted-foreground">
            {CONFIRM_STRINGS.reasonHint}
          </p>
          <Textarea
            ref={reasonInput}
            id={reasonId}
            name={REASON_FIELD}
            value={reason}
            rows={3}
            required
            autoFocus
            aria-describedby={reasonError === undefined ? hintId : `${hintId} ${errorId}`}
            {...(reasonError === undefined ? {} : { "aria-invalid": true })}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setReason(value);
              // A corrected reason clears the message; the next submission checks it again.
              if (
                problem !== undefined &&
                reasonProblem(value, reasonMinLength, reasonMaxLength) === undefined
              ) {
                setProblem(undefined);
              }
            }}
          />
          <p className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
            {CONFIRM_STRINGS.counter(reasonLength(reason), reasonMaxLength)}
          </p>
          {reasonError === undefined ? null : (
            <p id={errorId} className="text-sm font-medium text-destructive">
              {reasonError}
            </p>
          )}
        </div>
      ) : null}
      {state.ok === false && state.message !== undefined ? (
        <div role="alert" className="grid gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm">
          <p className="font-medium text-destructive">{state.message}</p>
          {state.requestId === undefined ? null : (
            <p className="text-muted-foreground">{CONFIRM_STRINGS.requestId(state.requestId)}</p>
          )}
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {CONFIRM_STRINGS.cancel}
        </Button>
        <Button
          type="submit"
          variant={destructive ? "destructive" : "default"}
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
          {live ? CONFIRM_STRINGS.liveConfirm(confirmLabel) : confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
