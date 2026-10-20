import { cn } from "@/lib/utils";

/** An amount of money as the API sends it: a decimal string and an ISO 4217 code, never a JS number. */
export interface MoneyValue {
  readonly amount: string;
  readonly currency: string;
}

/** The decimal strings of the platform document (`Money.amount`). */
const DECIMAL = /^-?[0-9]+(?:\.([0-9]+))?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** The UI locale of the MVP (English only, ADR-0014); the same on the server and in the browser. */
export const DEFAULT_LOCALE = "en";

/**
 * `value` formatted with `Intl.NumberFormat`, or `undefined` when it is not a decimal string with a currency code.
 * The decimal string goes to `Intl` as it is (ES2023 formats numeric strings exactly), so a large or precise
 * amount is never rounded through a float; at least the currency's own digits are shown, and every digit the
 * amount has.
 */
export function formatMoney(value: MoneyValue, locale: string = DEFAULT_LOCALE): string | undefined {
  const match = DECIMAL.exec(value.amount);
  if (match === null || !CURRENCY.test(value.currency)) {
    return undefined;
  }
  try {
    const currencyDigits =
      new Intl.NumberFormat(locale, { style: "currency", currency: value.currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    const amountDigits = match[1]?.length ?? 0;
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: currencyDigits,
      maximumFractionDigits: Math.max(currencyDigits, amountDigits),
    }).format(value.amount as `${number}`);
  } catch {
    return undefined;
  }
}

export interface MoneyProps {
  readonly value: MoneyValue;
  /** A BCP 47 locale; the admin's English by default. */
  readonly locale?: string;
  readonly className?: string;
}

/** An amount of money, formatted with `Intl` (README §3, conventions §1). Server or client; no state. */
export function Money({ value, locale, className }: MoneyProps) {
  const formatted = formatMoney(value, locale);
  return (
    <data value={value.amount} className={cn("tabular-nums", className)}>
      {formatted ?? `${value.amount} ${value.currency}`}
    </data>
  );
}
