// The mappings of AccountsModule's routes (PBE-016; platform/docs/api-inventory.md §5): an active refresh family as
// listSessions shows it, and the profile changes of updateMe with the before and after values of their audit row.
// test/integration/accounts/me.int.test.ts runs them through HTTP and PostgreSQL.
import { describe, expect, it } from "vitest";
import type { ActiveFamily } from "../auth/sessions.repository";
import { PROFILE_FIELDS, profileChanges, profileRequestOf, toAccountSession } from "./accounts.mapper";

const FAMILY: ActiveFamily = {
  family_id: "asn_01JA2ZB4N8Q6R1T5V9X3Z7C2E6",
  audience: "portal",
  user_agent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0",
  ip_address: "203.0.113.24",
  signed_in_at: new Date("2026-10-12T08:14:03.000Z"),
  last_used_at: new Date("2026-10-14T07:52:41.000Z"),
};

describe("toAccountSession", () => {
  it("maps a family with its sign-in, its last refresh and `current` for the caller's family", () => {
    expect(toAccountSession(FAMILY, FAMILY.family_id)).toEqual({
      familyId: FAMILY.family_id,
      audience: "portal",
      userAgent: FAMILY.user_agent,
      ipAddress: "203.0.113.24",
      createdAt: "2026-10-12T08:14:03.000Z",
      lastUsedAt: "2026-10-14T07:52:41.000Z",
      current: true,
    });
  });

  it("keeps the nulls of a family without device data or refresh, and is not current for another family", () => {
    const family: ActiveFamily = {
      ...FAMILY,
      audience: "platform_admin",
      user_agent: null,
      ip_address: null,
      last_used_at: null,
    };
    expect(toAccountSession(family, "asn_01J9XK2M5P8R3T6V1X4Z7B0D3F")).toMatchObject({
      audience: "platform_admin",
      userAgent: null,
      ipAddress: null,
      lastUsedAt: null,
      current: false,
    });
  });
});

describe("profileRequestOf", () => {
  it("takes only the fields of the request, the full name trimmed", () => {
    expect(profileRequestOf({ fullName: "  Anna Berg-Lund  ", timeZone: "Europe/Oslo" })).toEqual({
      full_name: "Anna Berg-Lund",
      time_zone: "Europe/Oslo",
    });
    expect(profileRequestOf({ locale: "en-GB" })).toEqual({ locale: "en-GB" });
  });

  it("covers every field of UpdateMeRequest", () => {
    expect(PROFILE_FIELDS.map(([field]) => field)).toEqual(["fullName", "locale", "timeZone"]);
  });
});

describe("profileChanges", () => {
  const current = { full_name: "Anna Berg", locale: "en", time_zone: "UTC" };

  it("keeps only the fields whose value changes, with their before and after values by field name", () => {
    expect(
      profileChanges(current, { full_name: "Anna Berg", locale: "en-GB", time_zone: "Europe/Oslo" }),
    ).toEqual({
      changes: { locale: "en-GB", time_zone: "Europe/Oslo" },
      before: { locale: "en", timeZone: "UTC" },
      after: { locale: "en-GB", timeZone: "Europe/Oslo" },
    });
  });

  it("answers undefined when nothing changes", () => {
    expect(profileChanges(current, { full_name: "Anna Berg" })).toBeUndefined();
    expect(profileChanges(current, {})).toBeUndefined();
  });
});
