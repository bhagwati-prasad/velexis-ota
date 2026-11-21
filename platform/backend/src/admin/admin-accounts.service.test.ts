// The pure parts of the platform admin's account support (PBE-032): the status an account shows (KI-015,
// FIX-W68-PLATFORM: the sign-in lockout writes `locked_until` and leaves `status` alone, so a running lockout is shown
// as `locked`) and the mapping of a row to the search and detail answers. The search's filter by the same rule and the
// routes are in test/integration/admin/admin-accounts.int.test.ts.
import { describe, expect, it } from "vitest";
import type { AdminAccountRecord } from "../auth/accounts.repository";
import { adminAccountStatus, toAdminAccount, toAdminAccountSummary } from "./admin-accounts.service";

/** The Clock's time of these tests. */
const NOW = new Date("2026-11-21T10:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

function row(overrides: Partial<AdminAccountRecord> = {}): AdminAccountRecord {
  return {
    id: "acc_01JATESTRW0000000000000007",
    email: "anna.berg@example.com",
    email_verified_at: new Date("2026-10-01T10:05:00.000Z"),
    full_name: "Anna Berg",
    locale: "en",
    time_zone: "Europe/Oslo",
    status: "active",
    mfa_enabled: false,
    mfa_enabled_at: null,
    is_platform_admin: false,
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    created_at: new Date("2026-10-01T10:02:17.000Z"),
    version: 3,
    deleted_at: null,
    ...overrides,
  };
}

describe("adminAccountStatus", () => {
  it("[FIX-W68-PLATFORM AC1] shows a pending_verification or active account as locked while its lockout runs", () => {
    for (const status of ["active", "pending_verification"]) {
      expect(adminAccountStatus(row({ status, locked_until: at(15 * MINUTE_MS) }), NOW)).toBe("locked");
      expect(adminAccountStatus(row({ status, locked_until: at(1) }), NOW)).toBe("locked");
    }
  });

  it("[FIX-W68-PLATFORM AC1] shows the stored status once the lockout has ended, at its very end, and without one", () => {
    for (const status of ["active", "pending_verification"]) {
      // Sign-in lets the account in again at `locked_until` itself (`locked_until <= now` is not locked out).
      expect(adminAccountStatus(row({ status, locked_until: NOW }), NOW)).toBe(status);
      expect(adminAccountStatus(row({ status, locked_until: at(-MINUTE_MS) }), NOW)).toBe(status);
      expect(adminAccountStatus(row({ status, locked_until: null }), NOW)).toBe(status);
    }
  });

  it("[FIX-W68-PLATFORM AC1] keeps disabled and deleted whatever the lockout, and the reserved stored locked as locked", () => {
    for (const status of ["disabled", "deleted"]) {
      expect(adminAccountStatus(row({ status, locked_until: at(15 * MINUTE_MS) }), NOW)).toBe(status);
    }
    expect(adminAccountStatus(row({ status: "locked", locked_until: null }), NOW)).toBe("locked");
  });
});

describe("the account answers", () => {
  it("[FIX-W68-PLATFORM AC1] carry the status at the given time in the search and the detail, and the lockout's end", () => {
    const lockedOut = row({ failed_login_count: 5, locked_until: at(10 * MINUTE_MS) });

    expect(toAdminAccountSummary(lockedOut, NOW)).toEqual({
      id: lockedOut.id,
      email: "anna.berg@example.com",
      fullName: "Anna Berg",
      status: "locked",
      mfaEnabled: false,
      isPlatformAdmin: false,
      lastLoginAt: null,
      createdAt: "2026-10-01T10:02:17.000Z",
    });
    expect(toAdminAccount(lockedOut, NOW)).toEqual(
      expect.objectContaining({
        status: "locked",
        failedLoginCount: 5,
        lockedUntil: at(10 * MINUTE_MS).toISOString(),
        version: 3,
      }),
    );

    // Eleven minutes later the same row reads active again, with the past lockout's end still shown.
    const later = at(11 * MINUTE_MS);
    expect(toAdminAccountSummary(lockedOut, later).status).toBe("active");
    expect(toAdminAccount(lockedOut, later)).toEqual(
      expect.objectContaining({ status: "active", lockedUntil: at(10 * MINUTE_MS).toISOString() }),
    );
  });
});
