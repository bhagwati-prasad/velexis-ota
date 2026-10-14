import { describe, expect, it } from "vitest";

import {
  PORTAL_ACTIONS,
  TENANT_ROLES,
  accountNavigation,
  can,
  currentEntry,
  currentMembership,
  membershipHref,
  otaNavigation,
  otaPath,
  tenantIdOfPath,
  type AccountMembership,
  type MilestoneFeatures,
  type OtaNavId,
  type PortalAction,
  type TenantRole,
} from "./roles";

const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const OTHER_TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5G";

const FEATURES_OFF: MilestoneFeatures = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};
const FEATURES_ON: MilestoneFeatures = {
  stripeBilling: true,
  ownStripe: true,
  settlements: true,
  ownAmadeus: true,
  customDomains: true,
  liveSwitch: true,
};

function ids(role: TenantRole, features: MilestoneFeatures): OtaNavId[] {
  return otaNavigation(TENANT_ID, role, features).map((entry) => entry.id);
}

/** The matrix of platform/docs/scope.md §1.2, transcribed row by row (owner, admin, agent, finance, viewer). */
const SCOPE_MATRIX: Readonly<Record<PortalAction, readonly [boolean, boolean, boolean, boolean, boolean]>> = {
  viewOta: [true, true, true, true, true],
  openConsole: [true, true, true, true, true],
  editProfile: [true, true, false, false, false],
  manageApiKeys: [true, true, false, false, false],
  manageDomains: [true, true, false, false, false],
  viewConnections: [true, true, false, true, false],
  manageConnections: [true, true, false, false, false],
  manageTeam: [true, true, false, false, false],
  manageOwnersAndAdmins: [true, false, false, false, false],
  viewBilling: [true, false, false, true, false],
  manageBilling: [true, false, false, false, false],
  viewSettlements: [true, false, false, true, false],
  setPayoutAccount: [true, false, false, false, false],
  goLive: [true, false, false, false, false],
};

describe("role matrix", () => {
  it("has the five roles of TenantRole, most powerful first", () => {
    expect(TENANT_ROLES).toEqual(["owner", "admin", "agent", "finance", "viewer"]);
  });

  it("allows exactly the actions of scope §1.2 for every role", () => {
    expect(Object.keys(PORTAL_ACTIONS).sort()).toEqual(Object.keys(SCOPE_MATRIX).sort());
    for (const [action, allowed] of Object.entries(SCOPE_MATRIX) as [PortalAction, readonly boolean[]][]) {
      expect(
        TENANT_ROLES.map((role) => can(role, action)),
        action,
      ).toEqual(allowed);
    }
  });
});

describe("OTA navigation", () => {
  // Every entry the role sees, with the M5 switches off (M1) and on (M5).
  it.each<[TenantRole, OtaNavId[], OtaNavId[]]>([
    [
      "owner",
      ["overview", "apiKeys", "domains", "amadeus", "payments", "team", "billing", "settings"],
      [
        "overview",
        "apiKeys",
        "domains",
        "amadeus",
        "payments",
        "payoutAccount",
        "settlements",
        "team",
        "billing",
        "settings",
        "goLive",
      ],
    ],
    [
      "admin",
      ["overview", "apiKeys", "domains", "amadeus", "payments", "team", "settings"],
      ["overview", "apiKeys", "domains", "amadeus", "payments", "team", "settings"],
    ],
    ["agent", ["overview", "domains"], ["overview", "domains"]],
    [
      "finance",
      ["overview", "domains", "amadeus", "payments", "billing"],
      ["overview", "domains", "amadeus", "payments", "payoutAccount", "settlements", "billing"],
    ],
    ["viewer", ["overview", "domains"], ["overview", "domains"]],
  ])(
    "[PFE-003 AC1] gives the %s role exactly the entries of scope §1.2",
    (role, withSwitchesOff, withSwitchesOn) => {
      expect(ids(role, FEATURES_OFF)).toEqual(withSwitchesOff);
      expect(ids(role, FEATURES_ON)).toEqual(withSwitchesOn);
    },
  );

  const MANAGEMENT_ENTRIES: OtaNavId[] = ["apiKeys", "team", "billing", "amadeus", "payments"];

  it.each(TENANT_ROLES)(
    "[PFE-003 AC1] shows the %s role API keys, team, billing and connection entries only when the matrix allows",
    (role) => {
      for (const features of [FEATURES_OFF, FEATURES_ON]) {
        const entries = ids(role, features);
        expect(entries.includes("apiKeys")).toBe(can(role, "manageApiKeys"));
        expect(entries.includes("team")).toBe(can(role, "manageTeam"));
        expect(entries.includes("billing")).toBe(can(role, "viewBilling"));
        expect(entries.includes("amadeus")).toBe(can(role, "viewConnections"));
        expect(entries.includes("payments")).toBe(can(role, "viewConnections"));
      }
    },
  );

  it("[PFE-003 AC1] gives a viewer no API keys, team management, billing or connection settings entry", () => {
    for (const features of [FEATURES_OFF, FEATURES_ON]) {
      expect(ids("viewer", features).filter((id) => MANAGEMENT_ENTRIES.includes(id))).toEqual([]);
    }
  });

  it("[PFE-003 AC1] gives a finance member the billing entry", () => {
    expect(ids("finance", FEATURES_OFF)).toContain("billing");
    expect(ids("finance", FEATURES_ON)).toContain("billing");
  });

  it("hides each M5 area while its switch is off (PADR-0015)", () => {
    expect(ids("owner", { ...FEATURES_ON, settlements: false })).not.toContain("settlements");
    expect(ids("owner", { ...FEATURES_ON, settlements: false })).not.toContain("payoutAccount");
    expect(ids("owner", { ...FEATURES_ON, liveSwitch: false })).not.toContain("goLive");
    expect(ids("owner", { ...FEATURES_OFF, liveSwitch: true })).toContain("goLive");
  });

  it("links every entry below the OTA's own path", () => {
    expect(otaNavigation(TENANT_ID, "owner", FEATURES_ON).map((entry) => entry.href)).toEqual([
      `/otas/${TENANT_ID}`,
      `/otas/${TENANT_ID}/api-keys`,
      `/otas/${TENANT_ID}/domains`,
      `/otas/${TENANT_ID}/amadeus`,
      `/otas/${TENANT_ID}/payments`,
      `/otas/${TENANT_ID}/payments/payout-account`,
      `/otas/${TENANT_ID}/payments/settlements`,
      `/otas/${TENANT_ID}/team`,
      `/otas/${TENANT_ID}/billing`,
      `/otas/${TENANT_ID}/settings`,
      `/otas/${TENANT_ID}/go-live`,
    ]);
  });

  it("encodes the OTA id in its paths", () => {
    expect(otaPath("a/b?c", "/team")).toBe("/otas/a%2Fb%3Fc/team");
  });

  it("gives every account the account entries", () => {
    expect(accountNavigation()).toEqual([
      { id: "dashboard", href: "/dashboard" },
      { id: "account", href: "/account" },
      { id: "security", href: "/account/security" },
    ]);
  });
});

describe("current OTA and page", () => {
  const membership = (tenantId: string, overrides: Partial<AccountMembership> = {}): AccountMembership => ({
    membershipId: "stf_01JA2ZA1C5E9G3J7K2M6P0R4T8",
    tenantId,
    tenantKey: "acme",
    tenantName: "Acme Travel",
    tenantStatus: "active",
    role: "owner",
    ...overrides,
  });

  it("reads the OTA id from /otas/<tenantId>/… only", () => {
    expect(tenantIdOfPath(`/otas/${TENANT_ID}`)).toBe(TENANT_ID);
    expect(tenantIdOfPath(`/otas/${TENANT_ID}/team`)).toBe(TENANT_ID);
    expect(tenantIdOfPath("/otas/new")).toBeUndefined();
    expect(tenantIdOfPath("/otas/ten_short")).toBeUndefined();
    expect(tenantIdOfPath("/dashboard")).toBeUndefined();
    expect(tenantIdOfPath(`/account/otas/${TENANT_ID}`)).toBeUndefined();
  });

  it("finds the caller's membership of the OTA of the page, and none for an OTA they are not a member of", () => {
    const memberships = [membership(TENANT_ID)];
    expect(currentMembership(memberships, `/otas/${TENANT_ID}/api-keys`)).toBe(memberships[0]);
    expect(currentMembership(memberships, `/otas/${OTHER_TENANT_ID}`)).toBeUndefined();
    expect(currentMembership(memberships, "/dashboard")).toBeUndefined();
  });

  it("marks the most specific entry of the page as current", () => {
    const entries = [...otaNavigation(TENANT_ID, "owner", FEATURES_ON), ...accountNavigation()];
    expect(currentEntry(entries, `/otas/${TENANT_ID}`)?.id).toBe("overview");
    expect(currentEntry(entries, `/otas/${TENANT_ID}/setup`)?.id).toBe("overview");
    expect(currentEntry(entries, `/otas/${TENANT_ID}/payments`)?.id).toBe("payments");
    expect(currentEntry(entries, `/otas/${TENANT_ID}/payments/settlements/stl_1`)?.id).toBe("settlements");
    expect(currentEntry(entries, "/account/security")?.id).toBe("security");
    expect(currentEntry(entries, "/account")?.id).toBe("account");
    expect(currentEntry(entries, "/accounting")).toBeUndefined();
    expect(currentEntry(entries, "/console")).toBeUndefined();
  });

  it("opens an OTA that is being set up, or whose set-up failed, on its set-up page", () => {
    expect(membershipHref(membership(TENANT_ID))).toBe(`/otas/${TENANT_ID}`);
    expect(membershipHref(membership(TENANT_ID, { tenantStatus: "suspended" }))).toBe(`/otas/${TENANT_ID}`);
    expect(membershipHref(membership(TENANT_ID, { tenantStatus: "provisioning" }))).toBe(
      `/otas/${TENANT_ID}/setup`,
    );
    expect(membershipHref(membership(TENANT_ID, { tenantStatus: "failed" }))).toBe(
      `/otas/${TENANT_ID}/setup`,
    );
  });
});
