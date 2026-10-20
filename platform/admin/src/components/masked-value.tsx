import { MASKED_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** The dots that stand for the hidden part of a value. */
const MASK = "••••";

export interface MaskedValueProps {
  /** What the value is ("IBAN", "Client id", "Secret key"), for screen readers. */
  readonly label: string;
  /**
   * The last characters the API answers (`last4` of a payout account or an API key), or `null`/`undefined` when it
   * answers none. The full value is never passed: the masked shapes of the API do not hold it.
   */
  readonly last4?: string | null | undefined;
  /** A visible prefix the API answers (`prefix` of an API key, `sk_test_4f9K…`). */
  readonly prefix?: string | null | undefined;
  readonly className?: string;
}

/**
 * A secret or bank value in its masked shape (README §2: connections and payout accounts are masked): the prefix the
 * API shows, dots, and the last characters, read by a screen reader as "IBAN ending in 7947". Nothing to reveal or
 * copy here: revealing the payout account is `RevealPanel`'s job. Server or client; no state.
 */
export function MaskedValue({ label, last4, prefix, className }: MaskedValueProps) {
  const ending = last4 === null || last4 === undefined || last4 === "" ? undefined : last4;
  const start = prefix === null || prefix === undefined ? "" : prefix;
  const spoken = ending === undefined ? MASKED_STRINGS.hidden(label) : MASKED_STRINGS.endingIn(label, ending);
  return (
    <span className={cn("font-mono tabular-nums", className)} data-masked="">
      <span aria-hidden="true">
        {start}
        {MASK}
        {ending ?? ""}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}
