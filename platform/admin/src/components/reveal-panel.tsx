"use client";

import { EyeOff, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { REVEAL_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** How long revealed details stay on the screen (README §4). */
export const REVEAL_DURATION_MS = 60_000;

/** One revealed detail ("IBAN", "Account holder"). */
export interface RevealedField {
  readonly label: string;
  readonly value: string;
}

export interface RevealPanelProps {
  /** The heading of the panel ("Payout account of Acme Travel"). */
  readonly title: ReactNode;
  /**
   * The revealed details, as the reveal server action returned them. A new array (a new reveal) shows the panel again
   * for another 60 seconds.
   */
  readonly fields: readonly RevealedField[];
  /**
   * Called once the details are hidden (after 60 seconds or "Hide now"); the caller drops its own copy then, for
   * example by resetting the state of its reveal action.
   */
  readonly onHide?: () => void;
  /** How long the details stay; 60 seconds. Only tests and stories pass another value. */
  readonly durationMs?: number;
  readonly className?: string;
}

/**
 * Details revealed for a short time (README §4: the payout account, after a reason and a step-up). They live only in
 * React state while the panel shows them: never in `localStorage`, `sessionStorage`, cookies, the URL, a form field or
 * the Next.js cache, and the panel offers no copy-to-clipboard of the full value. After 60 seconds, or on "Hide now",
 * the values leave the page and `onHide` tells the caller to drop its copy; revealing them again is a new, audited
 * call.
 */
export function RevealPanel({
  title,
  fields,
  onHide,
  durationMs = REVEAL_DURATION_MS,
  className,
}: RevealPanelProps) {
  const titleId = useId();
  // The reveal (the `fields` array) that was hidden; a new array is a new reveal and shows again.
  const [hiddenReveal, setHiddenReveal] = useState<readonly RevealedField[] | undefined>(undefined);
  const [secondsLeft, setSecondsLeft] = useState(() => Math.ceil(durationMs / 1000));
  const hidden = hiddenReveal === fields;
  // The latest callback, so a parent re-rendering with a new function does not restart the 60 seconds.
  const onHideRef = useRef(onHide);
  useEffect(() => {
    onHideRef.current = onHide;
  });

  function hide(): void {
    setHiddenReveal(fields);
    onHideRef.current?.();
  }

  useEffect(() => {
    if (hidden) {
      return undefined;
    }
    const deadline = Date.now() + durationMs;
    setSecondsLeft(Math.ceil(durationMs / 1000));
    const countdown = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 1000);
    const timeout = setTimeout(() => {
      setHiddenReveal(fields);
      onHideRef.current?.();
    }, durationMs);
    return () => {
      clearInterval(countdown);
      clearTimeout(timeout);
    };
  }, [fields, durationMs, hidden]);

  if (hidden) {
    return (
      <p role="status" className={cn("text-sm text-muted-foreground", className)}>
        {REVEAL_STRINGS.hidden}
      </p>
    );
  }

  return (
    <section aria-labelledby={titleId} className={cn("grid gap-4 rounded-lg border p-4", className)}>
      <h2 id={titleId} className="text-lg font-semibold">
        {title}
      </h2>
      <Alert>
        <TriangleAlert aria-hidden="true" />
        <AlertDescription>{REVEAL_STRINGS.warning}</AlertDescription>
      </Alert>
      <dl className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        {fields.map((field, index) => (
          <div key={`${index}:${field.label}`} className="contents">
            <dt className="text-sm text-muted-foreground">{field.label}</dt>
            <dd className="font-mono text-sm break-all">{field.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-4">
        <p className="text-sm text-muted-foreground tabular-nums">{REVEAL_STRINGS.hidesIn(secondsLeft)}</p>
        <Button type="button" variant="outline" onClick={hide}>
          <EyeOff aria-hidden="true" />
          {REVEAL_STRINGS.hideNow}
        </Button>
      </div>
    </section>
  );
}
