// The IANA time zones the runtime knows (its ICU data). The OTA's day is read in `storefront_settings.time_zone`
// (cancellation-mode.ts: the void window of a same-day cancellation), and provisioning seeds that column from the
// platform tenant's time zone (provisioning/seeds/storefront-settings.seed.ts, lead decision (2a) of 2026-10-30,
// FIX-W35-OTA): both fall back to UTC for a zone the runtime cannot use, so no clock ever throws on a stored value.

/** The zone every caller falls back to. */
export const FALLBACK_TIME_ZONE = "UTC";

/** Whether the runtime knows `timeZone` (`Intl.DateTimeFormat` accepts it). */
export function isKnownTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `timeZone` when the runtime knows it, else UTC (`FALLBACK_TIME_ZONE`); a missing zone is UTC too. */
export function knownTimeZoneOr(timeZone: string | null | undefined): string {
  return timeZone !== null && timeZone !== undefined && isKnownTimeZone(timeZone)
    ? timeZone
    : FALLBACK_TIME_ZONE;
}
