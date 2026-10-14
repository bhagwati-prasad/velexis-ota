"use client";

import { useEffect, useId, useRef, type MouseEvent } from "react";

import { FORM_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** One problem of a submitted form: its message, and the id of the field it is about (`fieldId(name)`). */
export interface FormErrorItem {
  readonly message: string;
  readonly fieldId?: string;
}

export interface FormErrorSummaryProps {
  /**
   * The problems of the last submission, from the action state. The summary takes the focus each time it gets a
   * new array, so pass the array the action returned (not one rebuilt on every render).
   */
  readonly errors: readonly FormErrorItem[];
  readonly title?: string;
  readonly className?: string;
}

/**
 * The list of a form's problems above the form (README §4). It takes the focus when errors arrive, so keyboard
 * and screen reader users start from it; each entry links to its field and moves the focus there.
 */
export function FormErrorSummary({
  errors,
  title = FORM_STRINGS.errorSummaryTitle,
  className,
}: FormErrorSummaryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (errors.length > 0) {
      ref.current?.focus();
    }
  }, [errors]);

  if (errors.length === 0) {
    return null;
  }

  function focusField(event: MouseEvent<HTMLAnchorElement>, id: string): void {
    const field = document.getElementById(id);
    if (field !== null) {
      event.preventDefault();
      field.focus();
      field.scrollIntoView({ block: "center" });
    }
  }

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      aria-labelledby={titleId}
      className={cn(
        "grid gap-2 rounded-lg border border-destructive/50 px-4 py-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-destructive/30",
        className,
      )}
    >
      <h2 id={titleId} className="font-semibold text-destructive">
        {title}
      </h2>
      <ul className="grid list-disc gap-1 pl-5">
        {errors.map((error, index) => (
          <li key={`${error.fieldId ?? ""}:${index}`}>
            {error.fieldId === undefined ? (
              error.message
            ) : (
              <a
                href={`#${error.fieldId}`}
                className="text-destructive underline underline-offset-4"
                onClick={(event) => focusField(event, error.fieldId ?? "")}
              >
                {error.message}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
