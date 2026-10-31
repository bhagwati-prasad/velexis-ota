// The storefront settings' first time zone (storefront-settings.seed.ts `seedTimeZoneOf`, lead decision (2a) of
// 2026-10-30, FIX-W35-OTA): the platform tenant's zone when the runtime knows it, else UTC, so the OTA admin's cancel
// dialog, which shows the API's cancellation mode, and the OTA's own view of "today" start from the same zone. The
// seed's row against PostgreSQL is test/integration/provisioning/seeds.int.test.ts's.
import { describe, expect, it } from "vitest";
import { FALLBACK_TIME_ZONE, isKnownTimeZone, knownTimeZoneOr } from "../../common/time-zones";
import { seedTimeZoneOf, STOREFRONT_SETTINGS_DEFAULTS } from "./storefront-settings.seed";

describe("seedTimeZoneOf", () => {
  it("[FIX-W35-OTA AC3] keeps a platform zone the runtime knows", () => {
    for (const zone of ["Europe/Oslo", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati", "UTC"]) {
      expect(seedTimeZoneOf(zone)).toBe(zone);
    }
  });

  it("[FIX-W35-OTA AC3] falls back to UTC for a zone the runtime does not know, an empty one or none", () => {
    for (const zone of ["Mars/Olympus_Mons", "Europe/Atlantis", "", "not a zone", null, undefined]) {
      expect(seedTimeZoneOf(zone)).toBe("UTC");
    }
    expect(STOREFRONT_SETTINGS_DEFAULTS.timeZone).toBe(FALLBACK_TIME_ZONE);
  });
});

describe("isKnownTimeZone and knownTimeZoneOr", () => {
  it("[FIX-W35-OTA AC3] accept what Intl accepts and answer UTC otherwise, never throwing", () => {
    expect(isKnownTimeZone("Europe/Paris")).toBe(true);
    expect(isKnownTimeZone("Europe/Nowhere")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
    expect(knownTimeZoneOr("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(knownTimeZoneOr("Europe/Nowhere")).toBe("UTC");
    expect(knownTimeZoneOr(null)).toBe("UTC");
  });
});
