"use client";

import { TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { CopyField } from "@/components/copy-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SECRET_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** One value shown once: an API key, an initial test key, a recovery code. */
export interface SecretValue {
  readonly label: string;
  readonly value: string;
}

export interface SecretRevealPanelProps {
  /** The heading of the panel ("Your new secret key"). */
  readonly title: ReactNode;
  /** The values, as the server action returned them. */
  readonly secrets: readonly SecretValue[];
  /** Extra guidance under the warning (recommended set-ups, where to paste the key). */
  readonly children?: ReactNode;
  /** Called after the person confirms they stored the values; the caller drops its own copy then. */
  readonly onDismiss?: () => void;
  readonly className?: string;
}

/**
 * Values the API shows exactly once (README §5): API keys, the initial test keys, recovery codes. They live only
 * in React state for as long as the panel is open: never in `localStorage`, `sessionStorage`, cookies, the URL or
 * the Next.js cache. The panel warns that they cannot be shown again, and "I have stored it" removes them from
 * the page.
 */
export function SecretRevealPanel({
  title,
  secrets,
  children,
  onDismiss,
  className,
}: SecretRevealPanelProps) {
  const titleId = useId();
  const [shown, setShown] = useState(true);

  if (!shown) {
    return (
      <p role="status" className={cn("text-sm text-muted-foreground", className)}>
        {SECRET_STRINGS.dismissed}
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
        <AlertTitle className="line-clamp-none">{SECRET_STRINGS.warningTitle}</AlertTitle>
        <AlertDescription>{SECRET_STRINGS.warning}</AlertDescription>
      </Alert>
      {children}
      {secrets.map((secret, index) => (
        <CopyField key={`${index}:${secret.label}`} label={secret.label} value={secret.value} />
      ))}
      <div>
        <Button
          type="button"
          onClick={() => {
            setShown(false);
            onDismiss?.();
          }}
        >
          {SECRET_STRINGS.dismiss}
        </Button>
      </div>
    </section>
  );
}
