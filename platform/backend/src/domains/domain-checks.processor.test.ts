// The strike rule of the daily DNS re-check without Redis or PostgreSQL (FIX-W41-PLATFORM, lead decision (2b) of
// 2026-11-04; PADR-0004 item 5): a failed re-check counts a strike only when none was counted on the same UTC day, read
// from the locked row's `check_failures`, `last_checked_at` and `last_check_error`. The re-check jobs themselves run
// in test/integration/domains/domain-recheck.int.test.ts and, queued by a platform admin, in
// test/integration/admin/admin-domains.int.test.ts.
import { describe, expect, it } from "vitest";
import { adminRecheckJobId, ADMIN_RECHECK_SLOT_MS } from "./admin-domains.service";
import { DOMAIN_RECHECK_JOB, strikeCountedOn, UTC_DAY_MS, utcDayOf } from "./domain-checks.processor";
import { dailyJobId } from "./recheck.scheduler";

const DOMAIN = "dom_01JA2ZA1C5E9G3J7K2M6P00001";
const at = (iso: string): Date => new Date(iso);

describe("strikeCountedOn", () => {
  const failedThisMorning = {
    check_failures: 1,
    last_checked_at: at("2026-11-04T04:10:03Z"),
    last_check_error: "txt_missing",
  };

  it("[FIX-W41-PLATFORM AC2] holds after a failed check counted earlier the same UTC day, up to its last millisecond", () => {
    expect(strikeCountedOn(failedThisMorning, at("2026-11-04T04:10:04Z"))).toBe(true);
    expect(strikeCountedOn(failedThisMorning, at("2026-11-04T23:59:59.999Z"))).toBe(true);
    expect(strikeCountedOn({ ...failedThisMorning, check_failures: 2 }, at("2026-11-04T18:00:00Z"))).toBe(
      true,
    );
  });

  it("[FIX-W41-PLATFORM AC2] does not hold on the next UTC day, after a pass, or before any failed check", () => {
    // The next UTC day: a failure counts again.
    expect(strikeCountedOn(failedThisMorning, at("2026-11-05T00:00:00Z"))).toBe(false);
    // A pass (or the verification) the same day cleared the error and reset the count.
    const passed = { check_failures: 0, last_checked_at: at("2026-11-04T09:00:00Z"), last_check_error: null };
    expect(strikeCountedOn(passed, at("2026-11-04T10:00:00Z"))).toBe(false);
    // Never checked since it was verified.
    expect(
      strikeCountedOn(
        { check_failures: 0, last_checked_at: null, last_check_error: null },
        at("2026-11-04T10:00:00Z"),
      ),
    ).toBe(false);
    // Strikes of earlier days do not count for today.
    const yesterday = {
      check_failures: 2,
      last_checked_at: at("2026-11-03T04:10:00Z"),
      last_check_error: "dns_timeout",
    };
    expect(strikeCountedOn(yesterday, at("2026-11-04T04:10:00Z"))).toBe(false);
    // A count above zero is part of the rule: an error without a strike is not the day's strike.
    expect(strikeCountedOn({ ...failedThisMorning, check_failures: 0 }, at("2026-11-04T10:00:00Z"))).toBe(
      false,
    );
  });
});

describe("the job ids of the DNS re-check", () => {
  it("[FIX-W41-PLATFORM AC2] an admin's re-check has an id of its own, shared within its slot, never the daily run's", () => {
    const now = at("2026-11-04T10:00:00.000Z");
    const id = adminRecheckJobId(DOMAIN, now);

    expect(id).toBe(
      `${DOMAIN_RECHECK_JOB}.admin.${DOMAIN}.${Math.floor(now.getTime() / ADMIN_RECHECK_SLOT_MS)}`,
    );
    expect(id).not.toContain(":");
    expect(id).not.toBe(dailyJobId(DOMAIN_RECHECK_JOB, DOMAIN, now));
    // A double click within the slot shares the job; a later click has a job of its own.
    expect(adminRecheckJobId(DOMAIN, new Date(now.getTime() + ADMIN_RECHECK_SLOT_MS - 1))).toBe(id);
    expect(adminRecheckJobId(DOMAIN, new Date(now.getTime() + ADMIN_RECHECK_SLOT_MS))).not.toBe(id);
  });

  it("keeps the daily run's id: the job, the domain and the UTC day", () => {
    const now = at("2026-11-04T04:10:00Z");

    expect(utcDayOf(now)).toBe(Math.floor(now.getTime() / UTC_DAY_MS));
    expect(dailyJobId(DOMAIN_RECHECK_JOB, DOMAIN, now)).toBe(
      `${DOMAIN_RECHECK_JOB}.${DOMAIN}.${utcDayOf(now)}`,
    );
    expect(dailyJobId(DOMAIN_RECHECK_JOB, DOMAIN, at("2026-11-04T23:59:59Z"))).toBe(
      dailyJobId(DOMAIN_RECHECK_JOB, DOMAIN, now),
    );
  });
});
