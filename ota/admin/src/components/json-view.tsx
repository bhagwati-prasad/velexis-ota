// The JSON view of the OTA admin (README §9): the Amadeus order of a booking (`console.bookings.retrieve`), supplier
// request bodies and payment events, as a collapsible `<details>` with a `<pre>` of the payload. The API redacts these
// payloads before they leave it (card numbers masked, document and form-of-identification numbers cut to their last 4
// characters, no credentials), so the view shows what it gets and adds no third-party viewer. React escapes the text,
// so a value can never become markup. Server or client; no state.
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

export const JSON_VIEW_STRINGS = Object.freeze({
  empty: "Nothing to show.",
  unreadable: "This value cannot be shown as JSON.",
});

export interface JsonViewProps {
  /** The payload as the API answered it, already redacted. */
  readonly value: unknown;
  /** What the value is ("Amadeus order"): the summary that opens the view, and the name of the scrollable block. */
  readonly label: string;
  /** Open at first; collapsed by default, because payloads are long. */
  readonly open?: boolean;
  readonly className?: string;
}

/** A collapsible, read-only JSON payload. */
export function JsonView({ value, label, open = false, className }: JsonViewProps) {
  const text = isEmpty(value) ? undefined : formatJson(value);
  return (
    <details open={open} className={cn("group rounded-md border", className)}>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {label}
      </summary>
      {text === undefined ? (
        <p className="border-t px-3 py-2 text-sm text-muted-foreground">
          {isEmpty(value) ? JSON_VIEW_STRINGS.empty : JSON_VIEW_STRINGS.unreadable}
        </p>
      ) : (
        <pre
          role="region"
          aria-label={label}
          tabIndex={0}
          className="max-h-[32rem] overflow-auto border-t bg-muted/50 p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <code>{text}</code>
        </pre>
      )}
    </details>
  );
}
