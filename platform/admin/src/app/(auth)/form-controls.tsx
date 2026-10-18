"use client";

import { useEffect, useId, useRef, type ComponentProps, type MouseEvent, type ReactNode } from "react";

import { FORM_STRINGS } from "@/lib/strings";

/**
 * The form controls of the two sign-in steps (README §3 `(auth)`): a labelled field and an error summary, as the
 * portal's `FormField` and `FormErrorSummary`, in plain elements with the design tokens of `globals.css`. The
 * shadcn/ui copies of the signed-in console arrive with PAD-003 (`components/ui/`).
 */

/** The classes of the primary button of a form. */
export const PRIMARY_BUTTON_CLASS =
  "inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";

/** The classes of a button that looks like a link (switching between the code and the recovery code). */
export const LINK_BUTTON_CLASS =
  "inline-flex h-10 items-center text-sm font-medium text-foreground underline underline-offset-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

const INPUT_CLASS =
  "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm";

/**
 * The id of the control of the form field named `name`. `FormErrorSummary` links to it, so a summary entry moves the
 * focus to the field.
 */
export function fieldId(name: string): string {
  return `field-${name}`;
}

type InputProps = Omit<
  ComponentProps<"input">,
  "id" | "name" | "aria-describedby" | "aria-invalid" | "children" | "className"
>;

export interface FormFieldProps extends InputProps {
  /** The visible label (every field has one). */
  readonly label: ReactNode;
  /** The form field name, which is also what the server action reads. */
  readonly name: string;
  /** A hint shown under the label and read with the control. */
  readonly description?: ReactNode;
  /** The error of the field, from the action state (in the admin's own words). */
  readonly error?: string | undefined;
}

/**
 * A labelled `<input>` with its hint and error (conventions §3). The error is linked to the control through
 * `aria-describedby` and marks it `aria-invalid`, so a screen reader announces it with the field.
 */
export function FormField({ label, name, description, error, ...inputProps }: FormFieldProps) {
  const controlId = fieldId(name);
  const descriptionId = description === undefined ? undefined : `${controlId}-description`;
  const errorId = error === undefined || error === "" ? undefined : `${controlId}-error`;
  const describedBy = [descriptionId, errorId].filter((part) => part !== undefined).join(" ");
  return (
    <div className="grid gap-2">
      <label htmlFor={controlId} className="text-sm leading-none font-medium">
        {label}
      </label>
      {descriptionId === undefined ? null : (
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      )}
      <input
        {...inputProps}
        id={controlId}
        name={name}
        className={INPUT_CLASS}
        {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
        {...(errorId === undefined ? {} : { "aria-invalid": true })}
      />
      {errorId === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** One problem of a submitted form: its message, the id of the field it is about, and an optional link. */
export interface FormErrorItem {
  readonly message: string;
  readonly fieldId?: string;
  /** A link shown after the message (the portal's security page for `MFA_REQUIRED`). */
  readonly link?: { readonly href: string; readonly text: string };
}

export interface FormErrorSummaryProps {
  /**
   * The problems of the last submission, from the action state. The summary takes the focus each time it gets a
   * new array, so pass an array made once per answer (not one rebuilt on every render).
   */
  readonly errors: readonly FormErrorItem[];
}

/**
 * The list of a form's problems above the form. It takes the focus when errors arrive, so keyboard and screen
 * reader users start from it; each entry about a field links to it and moves the focus there.
 */
export function FormErrorSummary({ errors }: FormErrorSummaryProps) {
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
      className="grid gap-2 rounded-lg border border-destructive/50 px-4 py-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-destructive/30"
    >
      <h2 id={titleId} className="font-semibold text-destructive">
        {FORM_STRINGS.errorSummaryTitle}
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
            {error.link === undefined ? null : (
              <>
                {" "}
                <a
                  href={error.link.href}
                  rel="noopener noreferrer"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  {error.link.text}
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
