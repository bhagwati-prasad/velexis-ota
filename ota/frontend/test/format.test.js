// lib/format.js (ota/frontend/README.md §7): money from decimal strings with Intl.NumberFormat, airport-local times
// from their parts without any time-zone shift, ISO 8601 durations as "7 h 35 min", booking timestamps in the OTA's
// time zone. Intl output contains no-break spaces; the expectations spell them out.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  durationMinutes,
  formatDuration,
  formatLocalDate,
  formatLocalTime,
  formatMinutes,
  formatMoney,
  formatTimestamp,
  localDayDifference,
  parseLocalDateTime,
} from "../src/lib/format.js";

const NBSP = " ";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatMoney", () => {
  it("[OFE-002 AC1] formats money in three currencies with each currency's own digits", () => {
    expect(formatMoney({ amount: "412.30", currency: "EUR" }, "de-DE")).toBe(`412,30${NBSP}€`);
    expect(formatMoney({ amount: "1234.50", currency: "GBP" }, "en-GB")).toBe("£1,234.50");
    expect(formatMoney({ amount: "52000", currency: "JPY" }, "en-US")).toBe("¥52,000");
    // Three-digit currencies keep their third digit.
    expect(formatMoney({ amount: "120.500", currency: "KWD" }, "en-GB")).toBe(`KWD${NBSP}120.500`);
  });

  it("[OFE-002 AC1] formats the decimal string exactly, never through a JavaScript number", () => {
    // As a number, 90071992547409.93 is 90071992547409.94; the string keeps every digit.
    expect(formatMoney({ amount: "90071992547409.93", currency: "USD" }, "en-US")).toBe(
      "$90,071,992,547,409.93",
    );
    expect(formatMoney({ amount: "-35.00", currency: "EUR" }, "en-GB")).toBe("-€35.00");
  });

  it("[OFE-002 AC1] never throws on odd data: malformed amounts or currencies come back as text", () => {
    expect(formatMoney({ amount: "1e3", currency: "USD" }, "en-US")).toBe("1e3 USD");
    expect(formatMoney({ amount: "10", currency: "EURO" }, "en-US")).toBe("10 EURO");
    expect(formatMoney(null, "en-US")).toBe("");
    // An invalid locale tag falls back to English instead of throwing.
    expect(formatMoney({ amount: "10", currency: "EUR" }, "not a locale!")).toBe("€10.00");
  });
});

describe("airport-local times", () => {
  const AT = "2026-11-20T23:30:00";

  it("[OFE-002 AC1] shows a local time without time-zone shift, whatever the browser's time zone", async () => {
    for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata", "UTC"]) {
      vi.stubEnv("TZ", zone);
      // Precondition: the zone is in effect (reading the text as UTC and showing it locally would shift it).
      const naive = new Intl.DateTimeFormat("en-GB", { timeStyle: "short" }).format(new Date(`${AT}Z`));
      expect(naive === "23:30", zone).toBe(zone === "UTC");
      // A fresh module per zone: an Intl.DateTimeFormat keeps the time zone it was created in, so a formatter
      // cached under an earlier zone would hide a shift.
      vi.resetModules();
      const fresh = await import("../src/lib/format.js");

      expect(fresh.formatLocalTime(AT, "en-GB"), zone).toBe("23:30");
      expect(fresh.formatLocalDate(AT, "en-GB"), zone).toBe("Fri 20 Nov");
      expect(fresh.formatLocalDateTime(AT, "en-GB"), zone).toBe("20 Nov 2026, 23:30");
      expect(fresh.formatLocalTime(AT, "en-US"), zone).toMatch(/^11:30\sPM$/u);
      expect(fresh.localDayDifference(AT, "2026-11-21T06:10:00"), zone).toBe(1);
    }
  });

  it("[OFE-002 AC1] reads date-only values, ignores an offset and refuses impossible dates", () => {
    expect(formatLocalDate("2026-11-20", "en-GB")).toBe("Fri 20 Nov");
    expect(formatLocalTime("2026-11-20T08:35:00+05:30", "en-GB")).toBe("08:35");
    expect(formatLocalDate("2026-11-20", "en-GB", { day: "numeric", month: "long", year: "numeric" })).toBe(
      "20 November 2026",
    );
    expect(parseLocalDateTime("2026-02-30T10:00:00")).toBeNull();
    expect(formatLocalTime("2026-02-30T10:00:00", "en-GB")).toBe("2026-02-30T10:00:00");
    expect(formatLocalTime("tomorrow", "en-GB")).toBe("tomorrow");
  });

  it("[OFE-002 AC1] counts calendar days between a departure and an arrival for the +1 marker", () => {
    expect(localDayDifference("2026-11-20T23:30:00", "2026-11-21T06:10:00")).toBe(1);
    expect(localDayDifference("2026-12-31T22:00:00", "2027-01-02T01:00:00")).toBe(2);
    expect(localDayDifference("2026-11-20T08:00:00", "2026-11-20T11:00:00")).toBe(0);
    expect(localDayDifference("2026-11-20T08:00:00", "nope")).toBeNull();
  });

  it("[OFE-002 AC1] shows booking timestamps in the OTA's time zone, UTC for an unknown zone", () => {
    expect(formatTimestamp("2026-07-20T23:30:00Z", "en-GB", "Europe/London")).toBe("21 Jul 2026, 00:30");
    expect(formatTimestamp("2026-11-20T23:30:00Z", "en-GB", "Europe/London")).toBe("20 Nov 2026, 23:30");
    expect(formatTimestamp("2026-07-20T23:30:00Z", "en-GB", "Not/A_Zone")).toBe("20 Jul 2026, 23:30");
    expect(formatTimestamp("not a date", "en-GB", "Europe/London")).toBe("not a date");
  });
});

describe("durations", () => {
  it('[OFE-002 AC1] turns PT7H35M into "7 h 35 min"', () => {
    expect(formatDuration("PT7H35M")).toBe("7 h 35 min");
    expect(formatDuration("PT45M")).toBe("45 min");
    expect(formatDuration("PT2H")).toBe("2 h");
    expect(formatDuration("PT0M")).toBe("0 min");
    // Days count as hours, seconds round to the nearest minute.
    expect(formatDuration("P1DT2H5M")).toBe("26 h 5 min");
    expect(formatDuration("PT1H59M40S")).toBe("2 h");
  });

  it("[OFE-002 AC1] reads durations into minutes and leaves anything else as it is", () => {
    expect(durationMinutes("PT7H35M")).toBe(455);
    expect(durationMinutes("P1D")).toBe(1440);
    for (const bad of ["P", "PT", "P1DT", "PT1.5H", "P1W", "7h35", ""]) {
      expect(durationMinutes(bad)).toBeNull();
      expect(formatDuration(bad)).toBe(bad);
    }
  });

  it("[OFE-002 AC1] formats layover minutes the same way", () => {
    expect(formatMinutes(95)).toBe("1 h 35 min");
    expect(formatMinutes(30)).toBe("30 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(-1)).toBe("");
    expect(formatMinutes(Number.NaN)).toBe("");
  });
});
