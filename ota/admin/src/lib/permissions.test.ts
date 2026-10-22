import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ConsoleStaffProfile, StaffPermission, StaffRole } from "@velexis/ota-sdk";
import { describe, expect, it } from "vitest";

import {
  LIVE_ROLES,
  ROLE_PERMISSIONS,
  STAFF_PERMISSIONS,
  STAFF_ROLES,
  can,
  canOpenEnvironment,
  isStaffPermission,
  roleHasPermission,
  type StaffEnvironment,
} from "./permissions";

/** ota/docs/scope.md, whose §1.3 is the role matrix the admin follows. */
const SCOPE_MD = fileURLToPath(new URL("../../../docs/scope.md", import.meta.url));

interface ScopeMatrix {
  /** role → permission → granted, from the rows that name permissions. */
  readonly permissions: ReadonlyMap<StaffRole, ReadonlyMap<StaffPermission, boolean>>;
  /** role → may open the live environment, from the "Live environment in the OTA admin" row. */
  readonly live: ReadonlyMap<StaffRole, boolean>;
}

/** Throws when the table of scope §1.3 is not shaped as this test reads it. */
function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`scope.md §1.3: ${message}`);
  }
}

/** The cells of a Markdown table row, trimmed. */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * The table of scope §1.3 as data: the header names the roles, each row's first cell names its permissions in
 * backticks (or is the live-environment row), and every other cell is ✓ or empty (`test only` for the viewer's
 * live cell).
 */
function readScopeMatrix(): ScopeMatrix {
  const markdown = readFileSync(SCOPE_MD, "utf8");
  const start = markdown.indexOf("### 1.3 Staff roles and permissions");
  const end = markdown.indexOf("\n## ", start);
  check(start > -1, "the section exists");
  const rows = markdown
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[-\s|]+\|$/.test(line));
  const [header, ...body] = rows;
  const roles = cells(header ?? "").slice(1) as StaffRole[];
  check(roles.join() === STAFF_ROLES.join(), "the header names the five roles in order");

  const permissions = new Map<StaffRole, Map<StaffPermission, boolean>>(
    roles.map((role) => [role, new Map()]),
  );
  const live = new Map<StaffRole, boolean>();
  for (const row of body) {
    const [label = "", ...marks] = cells(row);
    check(marks.length === roles.length, `a row has one cell per role: ${row}`);
    const named = [...label.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    roles.forEach((role, index) => {
      const granted = marks[index] === "✓";
      if (label.startsWith("Live environment")) {
        live.set(role, granted);
        return;
      }
      for (const permission of named) {
        check(isStaffPermission(permission), `${String(permission)} is a StaffPermission`);
        permissions.get(role)?.set(permission, granted);
      }
    });
  }
  return { permissions, live };
}

/** A `console.auth.me` profile of `role` with the permissions and environments the API answers. */
function profile(
  role: StaffRole,
  permissions: readonly StaffPermission[],
  environments: readonly StaffEnvironment[] = ["test", "live"],
): ConsoleStaffProfile {
  return {
    staff: {
      id: "stf_01JBT6V2B3K8Q4M9N5P7R1T0VX",
      accountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
      email: "kari.nordmann@example.com",
      fullName: "Kari Nordmann",
      role,
      status: "active",
      locale: "en",
      timeZone: "Europe/Oslo",
      mfaEnabled: true,
      lastActiveAt: null,
      createdAt: "2026-10-01T10:02:17Z",
    },
    tenant: {
      id: "ten_01JA3B4C5D6E7F8G9H0J1K2M3N",
      key: "demo",
      name: "Demo Travel",
      status: "active",
      environment: "test",
      defaultCurrency: "EUR",
      defaultLocale: "en",
      timeZone: "Europe/Oslo",
      supplier: {
        connected: true,
        officeIds: ["OSLN12345"],
        defaultOfficeId: "OSLN12345",
        queuingOfficeId: null,
      },
    },
    permissions: [...permissions],
    session: {
      id: "asn_01JBT6V2B3K8Q4M9N5P7R1T0VY",
      createdAt: "2026-10-21T08:00:00Z",
      expiresAt: "2026-10-21T20:00:00Z",
    },
    environments: [...environments],
  };
}

const scope = readScopeMatrix();

describe("can() against scope §1.3", () => {
  it("[OAD-002 AC3] the role matrix lists every permission of scope §1.3 exactly as the table grants it", () => {
    for (const role of STAFF_ROLES) {
      const fromScope = STAFF_PERMISSIONS.filter((permission) =>
        scope.permissions.get(role)?.get(permission),
      );
      expect(ROLE_PERMISSIONS[role], role).toEqual(fromScope);
    }
    // Every permission is named in exactly one row of the table, for every role.
    for (const role of STAFF_ROLES) {
      expect([...(scope.permissions.get(role)?.keys() ?? [])].sort(), role).toEqual(
        [...STAFF_PERMISSIONS].sort(),
      );
    }
  });

  it.each(STAFF_ROLES)("[OAD-002 AC3] can() matches scope §1.3 for %s, for every permission", (role) => {
    const granted = STAFF_PERMISSIONS.filter((permission) => scope.permissions.get(role)?.get(permission));
    const asTheApiAnswers = profile(role, granted);
    // An API that answered more than the role holds still does not unlock an action the matrix refuses.
    const overGranted = profile(role, STAFF_PERMISSIONS);

    for (const permission of STAFF_PERMISSIONS) {
      const expected = scope.permissions.get(role)?.get(permission) ?? false;
      expect(can(asTheApiAnswers, permission), `${role} ${permission}`).toBe(expected);
      expect(can(overGranted, permission), `${role} ${permission} (over-granted)`).toBe(expected);
      expect(roleHasPermission(role, permission), `${role} ${permission} (matrix)`).toBe(expected);
    }
  });

  it.each(STAFF_ROLES)("[OAD-002 AC3] the LIVE switch matches scope §1.3 for %s", (role) => {
    const liveOta = profile(role, ROLE_PERMISSIONS[role], ["test", "live"]);

    expect(canOpenEnvironment(liveOta, "live")).toBe(scope.live.get(role));
    expect(canOpenEnvironment(liveOta, "test")).toBe(true);
    expect(LIVE_ROLES.includes(role)).toBe(scope.live.get(role));
  });

  it("refuses an action the API did not grant, even when the role holds it", () => {
    const narrowed = profile("owner", ["bookings:read"]);

    expect(can(narrowed, "bookings:read")).toBe(true);
    expect(can(narrowed, "bookings:issue")).toBe(false);
    expect(can(narrowed, "settings:write")).toBe(false);
  });

  it("offers live only when the API lists it for the session", () => {
    expect(canOpenEnvironment(profile("owner", ROLE_PERMISSIONS.owner, ["test"]), "live")).toBe(false);
    // A viewer never gets the switch, even if an environments list said otherwise.
    expect(canOpenEnvironment(profile("viewer", ROLE_PERMISSIONS.viewer, ["test", "live"]), "live")).toBe(
      false,
    );
  });

  it("holds nothing without a profile, and never a value outside the matrix", () => {
    expect(can(null, "bookings:read")).toBe(false);
    expect(can(undefined, "bookings:read")).toBe(false);
    expect(canOpenEnvironment(null, "test")).toBe(false);
    const owner = profile("owner", STAFF_PERMISSIONS);
    expect(can(owner, "bookings:delete" as StaffPermission)).toBe(false);
    expect(roleHasPermission("intern" as StaffRole, "bookings:read")).toBe(false);
    expect(isStaffPermission("bookings:read")).toBe(true);
    expect(isStaffPermission("BOOKINGS:READ")).toBe(false);
    expect(isStaffPermission(42)).toBe(false);
  });
});
