"use client";

import { Copy } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SECRET_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

export interface CopyFieldProps {
  /** The visible label of the value. */
  readonly label: ReactNode;
  /** The value to show and copy. It stays in this component's memory only. */
  readonly value: string;
  readonly id?: string;
  readonly className?: string;
}

type CopyStatus = "idle" | "copied" | "failed";

/**
 * A read-only value with a copy button (README §4). The value is never written anywhere: the field has no `name`
 * (a surrounding form never submits it), no autocomplete, and copying goes to the clipboard only when the person
 * presses the button. The outcome is announced in a polite live region.
 */
export function CopyField({ label, value, id, className }: CopyFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const statusId = `${inputId}-status`;
  const [status, setStatus] = useState<CopyStatus>("idle");

  async function copy(): Promise<void> {
    try {
      // `navigator.clipboard` is missing outside a secure context; that lands in the catch too.
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <div className={cn("grid gap-2", className)}>
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          readOnly
          value={value}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={statusId}
          className="font-mono"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={() => void copy()}>
          <Copy aria-hidden="true" />
          {SECRET_STRINGS.copy}
          <span className="sr-only"> {label}</span>
        </Button>
      </div>
      <p id={statusId} role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {status === "copied" ? SECRET_STRINGS.copied : status === "failed" ? SECRET_STRINGS.copyFailed : ""}
      </p>
    </div>
  );
}
