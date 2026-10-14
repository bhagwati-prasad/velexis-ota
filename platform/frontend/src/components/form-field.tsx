import type { ComponentProps, ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The id of the control of the form field named `name`, unless the field sets its own. `FormErrorSummary` links
 * to it, so a summary entry moves the focus to the field.
 */
export function fieldId(name: string): string {
  return `field-${name}`;
}

/** The attributes that tie a control to its label, hint and error (conventions §3). */
export interface FormControlProps {
  readonly id: string;
  readonly name: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: true;
}

type InputProps = Omit<
  ComponentProps<"input">,
  "id" | "name" | "aria-describedby" | "aria-invalid" | "children"
>;

export interface FormFieldProps extends InputProps {
  /** The visible label (every field has one). */
  readonly label: ReactNode;
  /** The form field name, which is also what the server action reads. */
  readonly name: string;
  /** The control's id; `fieldId(name)` by default. */
  readonly id?: string;
  /** A hint shown under the label and read with the control. */
  readonly description?: ReactNode;
  /** The error of the field, from the action state (`fieldErrors` mapped to the portal's text). */
  readonly error?: string | undefined;
  /**
   * Renders another control (select, textarea, checkbox group) with the given attributes instead of an `<input>`
   * with the remaining props.
   */
  readonly children?: (control: FormControlProps) => ReactNode;
}

/**
 * A labelled form control with its hint and error (README §4). The error is linked to the control through
 * `aria-describedby` and marks it `aria-invalid`, so a screen reader announces it with the field.
 */
export function FormField({
  label,
  name,
  id,
  description,
  error,
  children,
  className,
  ...inputProps
}: FormFieldProps) {
  const controlId = id ?? fieldId(name);
  const descriptionId = description === undefined ? undefined : `${controlId}-description`;
  const errorId = error === undefined || error === "" ? undefined : `${controlId}-error`;
  const describedBy = [descriptionId, errorId].filter((part) => part !== undefined).join(" ");
  const control: FormControlProps = {
    id: controlId,
    name,
    ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
    ...(errorId === undefined ? {} : { "aria-invalid": true }),
  };
  return (
    <div className={cn("grid gap-2", className)} data-invalid={errorId === undefined ? undefined : true}>
      <Label htmlFor={controlId}>{label}</Label>
      {descriptionId === undefined ? null : (
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {children === undefined ? <Input {...inputProps} {...control} /> : children(control)}
      {errorId === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
