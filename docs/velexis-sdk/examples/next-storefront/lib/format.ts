import type { Money } from "@velexis/ota-sdk";

/** Format money (decimal string amount) with Intl, keeping the API's precision. */
export function formatMoney(money: Money | null | undefined, locale = "en-GB"): string {
  if (!money) return "—";
  const n = Number(money.amount);
  if (!Number.isFinite(n)) return `${money.amount} ${money.currency}`;
  return new Intl.NumberFormat(locale, { style: "currency", currency: money.currency }).format(n);
}

/** 135 → "2h 15m". */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * Local airport date-time as Amadeus gives it (`2026-11-20T10:15:00`, no offset) → "Fri 20 Nov, 10:15".
 * Never convert through the browser time zone: the value is wall-clock time at the airport.
 */
export function formatLocalDateTime(value: string | null | undefined, locale = "en-GB"): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!m) return value;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)));
  const opts: Intl.DateTimeFormatOptions = { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" };
  if (m[4]) Object.assign(opts, { hour: "2-digit", minute: "2-digit", hour12: false });
  return new Intl.DateTimeFormat(locale, opts).format(date);
}

/** Local time part only: "10:15". */
export function formatLocalTime(value: string | null | undefined): string {
  return value && value.length >= 16 ? value.slice(11, 16) : "—";
}

/** ISO-8601 UTC instant → localised date-time in the viewer's zone. */
export function formatInstant(value: string | null | undefined, locale = "en-GB"): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}
