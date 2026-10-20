import { JSON_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * `value` as indented JSON, or `undefined` when it cannot be written as JSON (a cycle, a `BigInt`, a function).
 * Keys keep the order the API sent them in.
 */
export function formatJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value, null, 2) as string | undefined;
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/** A value with nothing to show: `null`, `undefined`, an empty object or an empty array. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return typeof value === "object" && Object.keys(value).length === 0;
}

export interface JsonViewProps {
  /**
   * The value as the API answered it: the id-only payload of a queue or provisioning job, or the `details` of an
   * audit row. The API never puts a secret, a token or card data into either, so nothing is hidden here.
   */
  readonly value: unknown;
  /** What the value is ("Payload of job 4f2…"), the accessible name of the scrollable block. */
  readonly label: string;
  readonly className?: string;
}

/**
 * Read-only JSON (README §3: id-only payloads and audit details), indented in a scrollable, keyboard-focusable block.
 * React escapes the text, so a value can never become markup. Server or client; no state.
 */
export function JsonView({ value, label, className }: JsonViewProps) {
  if (isEmpty(value)) {
    return <p className={cn("text-sm text-muted-foreground", className)}>{JSON_STRINGS.empty}</p>;
  }
  const text = formatJson(value);
  if (text === undefined) {
    return <p className={cn("text-sm text-muted-foreground", className)}>{JSON_STRINGS.unreadable}</p>;
  }
  return (
    <pre
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "max-h-96 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      <code>{text}</code>
    </pre>
  );
}
