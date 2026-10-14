import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  databaseGrantStatements,
  newRunId,
  REFERENCE_FIXTURE,
  REPO_ROOT,
  runIdOfTemplate,
  SCHEMAS_SQL,
  SHARED_MIGRATIONS_DIR,
  TEMPLATE_DATABASE_PREFIX,
  TENANT_MIGRATIONS_DIR,
  TEST_TENANTS,
} from "./test-database.js";

// Unit tests of task X-015 steps 2 and 3 that need no PostgreSQL: the mirrored database grants of bootstrap.sql, the
// reference fixture, run ids and the paths the template is built from. The databases themselves are tested in
// test/integration/test-database.int.test.ts.

describe("databaseGrantStatements", () => {
  it("are the database-level statements of bootstrap.sql's Database section, in order", () => {
    const bootstrap = readFileSync(join(REPO_ROOT, "deploy/postgres/bootstrap.sql"), "utf8");
    const mirrored = [
      ...bootstrap.matchAll(/^SELECT format\('((?:REVOKE|GRANT) [^']* ON DATABASE %I [^']*)'/gm),
    ].map((match) => (match[1] as string).replace("%I", '"velexis_test_x"'));
    expect(mirrored).toHaveLength(4);
    expect(databaseGrantStatements("velexis_test_x")).toEqual(mirrored);
  });

  it("quotes the database name as an identifier", () => {
    expect(databaseGrantStatements('odd"name')[0]).toBe('REVOKE ALL ON DATABASE "odd""name" FROM PUBLIC');
  });
});

describe("REFERENCE_FIXTURE", () => {
  it("has 3 currencies, 3 countries, 5 airports and 3 airlines whose references resolve", () => {
    const { currencies, countries, airports, airlines } = REFERENCE_FIXTURE;
    expect([currencies.length, countries.length, airports.length, airlines.length]).toEqual([3, 3, 5, 3]);
    const currencyCodes = new Set(currencies.map((row) => row.code));
    const countryCodes = new Set(countries.map((row) => row.code));
    expect(countries.every((row) => currencyCodes.has(row.currency_code))).toBe(true);
    expect(airports.every((row) => countryCodes.has(row.country_code))).toBe(true);
    expect(airlines.every((row) => countryCodes.has(row.country_code))).toBe(true);
    expect(new Set(airports.map((row) => row.iata_code)).size).toBe(5);
  });
});

describe("run ids and template names", () => {
  it("names the template velexis_test_tpl_<runId> and reads the run id back", () => {
    const runId = newRunId();
    expect(runId).toMatch(/^[a-z0-9]+_[0-9a-f]{6}$/);
    expect(runIdOfTemplate(`${TEMPLATE_DATABASE_PREFIX}${runId}`)).toBe(runId);
    // Every name built from it stays under PostgreSQL's 63-byte identifier limit.
    expect(`velexis_test_${runId}_${"0".repeat(12)}`.length).toBeLessThanOrEqual(63);
    expect(newRunId()).not.toBe(runId);
  });

  it("refuses names that are not template names", () => {
    expect(() => runIdOfTemplate("velexis")).toThrow(
      new TypeError("velexis is not a template database name (velexis_test_tpl_<runId>)"),
    );
    expect(() => runIdOfTemplate(`${TEMPLATE_DATABASE_PREFIX}Bad-Id`)).toThrow(TypeError);
  });
});

describe("the files the template is built from", () => {
  it("exist in the repository", () => {
    expect(existsSync(SCHEMAS_SQL)).toBe(true);
    expect(existsSync(join(SHARED_MIGRATIONS_DIR, "platform", "0001_baseline.sql"))).toBe(true);
    expect(existsSync(join(SHARED_MIGRATIONS_DIR, "reference", "0001_baseline.sql"))).toBe(true);
    expect(existsSync(join(TENANT_MIGRATIONS_DIR, "0001_baseline.sql"))).toBe(true);
    expect(TEST_TENANTS).toEqual(["tenant_alpha", "tenant_beta"]);
  });
});
