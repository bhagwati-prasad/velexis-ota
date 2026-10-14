import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { databaseUrl, TEST_ROLE_NAMES, TEST_ROLES } from "./roles.js";

// Tests of task X-015 step 3: the role logins of createTestDatabase().urlFor(role) are the development values of the
// .env.example files (dummy values that dev-setup.sh and the CI bootstrap set), and stay so.

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** The value of `variable` in a repository `.env.example` file. */
function exampleValue(file: string, variable: string): string {
  const content = readFileSync(join(REPO_ROOT, file), "utf8");
  const value = new RegExp(`^${variable}=(\\S+)$`, "m").exec(content)?.[1];
  if (value === undefined) {
    throw new Error(`${file} has no ${variable} line`);
  }
  return value;
}

describe("TEST_ROLES", () => {
  it("are the four login roles of bootstrap.sql with the passwords of the .env.example files", () => {
    expect(TEST_ROLE_NAMES).toEqual(["migrator", "provisioner", "platform", "ota"]);
    expect(Object.keys(TEST_ROLES).sort()).toEqual([...TEST_ROLE_NAMES].sort());
    for (const role of TEST_ROLE_NAMES) {
      const login = TEST_ROLES[role];
      const dsn = new URL(exampleValue(login.source.file, login.source.variable));
      expect({ role, user: dsn.username, password: dsn.password }).toEqual({
        role,
        user: login.user,
        password: login.password,
      });
    }
    const bootstrap = readFileSync(join(REPO_ROOT, "deploy/postgres/bootstrap.sql"), "utf8");
    for (const { user } of Object.values(TEST_ROLES)) {
      expect(bootstrap).toContain(`CREATE ROLE ${user} LOGIN PASSWORD %L`);
    }
  });

  it("are frozen", () => {
    expect(Object.isFrozen(TEST_ROLES)).toBe(true);
    expect(Object.isFrozen(TEST_ROLES.ota)).toBe(true);
    expect(Object.isFrozen(TEST_ROLE_NAMES)).toBe(true);
  });
});

describe("databaseUrl", () => {
  const admin = "postgres://velexis_test_admin:dev_test_admin@127.0.0.1:5433/postgres?sslmode=disable";

  it("swaps the database and keeps host, port, login and query", () => {
    expect(databaseUrl(admin, "velexis_test_x")).toBe(
      "postgres://velexis_test_admin:dev_test_admin@127.0.0.1:5433/velexis_test_x?sslmode=disable",
    );
  });

  it("swaps the login when one is given", () => {
    expect(databaseUrl(admin, "velexis_test_x", TEST_ROLES.ota)).toBe(
      "postgres://velexis_ota_app:dev_ota@127.0.0.1:5433/velexis_test_x?sslmode=disable",
    );
  });

  it("percent-encodes what a URL cannot carry as is", () => {
    const url = databaseUrl(admin, "db name", { user: "us@er", password: "p@ss:w/rd" });
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe("us@er");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:w/rd");
    expect(decodeURIComponent(parsed.pathname)).toBe("/db name");
  });
});
