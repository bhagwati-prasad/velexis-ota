// The rules of the platform admin's connection switch without a database (PBE-030; api-inventory-admin.md §3,
// `adminSetConnectionStatus`). The integration test test/integration/provisioning/suspension.int.test.ts runs suspend,
// resume and the switch through the HTTP pipeline on PostgreSQL and Redis.
import { describe, expect, it } from "vitest";
import { connectionStatusDecision, isShownTenantStatus } from "./suspension.service";

describe("connectionStatusDecision", () => {
  it("disables any connection that is not disabled, and changes nothing on a disabled one", () => {
    for (const status of ["active", "pending_verification", "invalid_credentials", "pending", "error"]) {
      expect(connectionStatusDecision("amadeus", status, "disabled", true)).toEqual({ action: "update" });
    }
    expect(connectionStatusDecision("payment", "disabled", "disabled", false)).toEqual({
      action: "unchanged",
    });
  });

  it("enables only a disabled connection that can work again", () => {
    expect(connectionStatusDecision("amadeus", "disabled", "active", true)).toEqual({ action: "update" });
    expect(connectionStatusDecision("payment", "active", "active", true)).toEqual({
      action: "conflict",
      reason: "not_disabled",
    });
    expect(connectionStatusDecision("amadeus", "disabled", "active", false)).toEqual({
      action: "conflict",
      reason: "no_office",
    });
    expect(connectionStatusDecision("payment", "disabled", "active", false)).toEqual({
      action: "conflict",
      reason: "deauthorized",
    });
  });
});

describe("isShownTenantStatus", () => {
  it("shows the statuses of TenantStatus, never a tenant being deprovisioned or deleted", () => {
    expect(["provisioning", "active", "suspended", "failed"].every(isShownTenantStatus)).toBe(true);
    expect(isShownTenantStatus("deprovisioning")).toBe(false);
    expect(isShownTenantStatus("deleted")).toBe(false);
  });
});
