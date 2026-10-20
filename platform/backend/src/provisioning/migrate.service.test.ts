// The order of tenant migration versions and the ops alert of a failed fan-out report without a database (PBE-030;
// flows/provisioning.md §5). The integration test test/integration/provisioning/migrate.int.test.ts runs the mirror,
// adminMigrateTenant and the failures on PostgreSQL and Redis with the fake OTA worker.
import { describe, expect, it } from "vitest";
import { compareMigrationVersions, fanOutFailureAlert, isLaterMigrationVersion } from "./migrate.service";

describe("compareMigrationVersions", () => {
  it("orders by the version's number first, then as text", () => {
    expect(compareMigrationVersions("0001_baseline", "0002_add_mvp_tenant_deltas")).toBeLessThan(0);
    expect(compareMigrationVersions("0010_later", "0009_earlier")).toBeGreaterThan(0);
    // Numbers of another width still compare as numbers.
    expect(compareMigrationVersions("00010", "0009_add")).toBeGreaterThan(0);
    expect(compareMigrationVersions("0002_a", "0002_b")).toBeLessThan(0);
    expect(compareMigrationVersions("0002_a", "0002_a")).toBe(0);
  });

  it("takes a version as later only when it is after the current one, or there is none", () => {
    expect(isLaterMigrationVersion("0002_add_mvp_tenant_deltas", "0001_baseline")).toBe(true);
    expect(isLaterMigrationVersion("0001_baseline", "0002_add_mvp_tenant_deltas")).toBe(false);
    expect(isLaterMigrationVersion("0001_baseline", "0001_baseline")).toBe(false);
    expect(isLaterMigrationVersion("0001_baseline", null)).toBe(true);
  });
});

describe("fanOutFailureAlert", () => {
  it("names the OTA, the deploy run, the migration and the error, and says that nothing changed", () => {
    const alert = fanOutFailureAlert(
      { id: "ten_01M4T9E68084G7ZWYRD6Z1RV0W", key: "acme", schemaVersion: "0001_baseline" },
      {
        requestId: "deploy-c3a3730c5f84",
        payload: {
          version: "0002_add_mvp_tenant_deltas",
          error: { code: "LOCK_TIMEOUT", message: "canceling statement due to lock timeout" },
        },
      },
    );

    expect(alert.title).toBe("Tenant migration failed: acme");
    expect(alert.message).toContain("deploy-c3a3730c5f84");
    expect(alert.message).toContain("at the migration 0002_add_mvp_tenant_deltas: LOCK_TIMEOUT");
    expect(alert.message).toContain("schema version (0001_baseline) did not change");
  });
});
