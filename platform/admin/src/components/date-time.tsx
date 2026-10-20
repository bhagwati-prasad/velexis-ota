import { DEFAULT_LOCALE } from "@/components/money";

/** What `DateTime` shows: the date only, or the date and the time with its zone. */
export type DateTimeMode = "date" | "dateTime";

const FORMATS: Readonly<Record<DateTimeMode, Intl.DateTimeFormatOptions>> = {
  date: { year: "numeric", month: "short", day: "numeric" },
  dateTime: {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  },
};

/**
 * `value` (an ISO 8601 instant of the API) formatted with `Intl.DateTimeFormat` in `timeZone`, or `undefined`
 * when it is not a date or the zone is unknown. The zone is always explicit (UTC unless the page passes the OTA's
 * or the account's), so the server and the browser render the same text.
 */
export function formatDateTime(
  value: string,
  { mode = "dateTime", timeZone = "UTC", locale = DEFAULT_LOCALE }: DateTimeOptions = {},
): string | undefined {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat(locale, { ...FORMATS[mode], timeZone }).format(instant);
  } catch {
    return undefined;
  }
}

export interface DateTimeOptions {
  /** `dateTime` (default) or `date`. */
  readonly mode?: DateTimeMode;
  /** An IANA time zone; `UTC` by default (conventions §1: local times only with the tenant's or account's zone). */
  readonly timeZone?: string;
  /** A BCP 47 locale; the admin's English by default. */
  readonly locale?: string;
}

export interface DateTimeProps extends DateTimeOptions {
  /** An ISO 8601 instant as the API sends it (`2026-10-14T08:14:03Z`). */
  readonly value: string;
  readonly className?: string;
}

/** A point in time in a `<time>` element, formatted with `Intl` (README §3). Server or client; no state. */
export function DateTime({ value, className, ...options }: DateTimeProps) {
  return (
    <time dateTime={value} className={className}>
      {formatDateTime(value, options) ?? value}
    </time>
  );
}
