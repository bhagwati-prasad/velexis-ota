import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertTenantSchema,
  InvalidTenantSchemaError,
  isTenantSchema,
  TENANT_SCHEMA_PATTERN,
  type TenantSchema,
} from "./tenant-schema.js";

describe("assertTenantSchema", () => {
  it.each([
    "tenant_ab",
    "tenant_acme",
    "tenant_alpha",
    "tenant_beta",
    "tenant_acme_travel_2",
    "tenant_x1",
    `tenant_a${"b".repeat(39)}`,
  ])("accepts %j", (schema) => {
    expect(() => {
      assertTenantSchema(schema);
    }).not.toThrow();
    expect(isTenantSchema(schema)).toBe(true);
  });

  it.each([
    "tenant_a; DROP TABLE x",
    "public",
    "platform",
    "reference",
    "pg_catalog",
    "information_schema",
    "tenant_",
    // A tenant key has at least two characters (platform.tenants.key), so the one-letter names of the X-010
    // plan text are not schema names; the integration tests use tenant_alpha and tenant_beta instead.
    "tenant_a",
    "tenant_b",
    "tenant_1abc",
    "tenant__abc",
    "tenant_Acme",
    "TENANT_ACME",
    "tenant_acme-travel",
    "tenant_acme travel",
    'tenant_acme"',
    "tenant_acme, public",
    "tenant_acme\n",
    "\ntenant_acme",
    " tenant_acme",
    "tenant_acmé",
    `tenant_a${"b".repeat(40)}`,
    "",
  ])("rejects %j before any SQL runs [X-010 AC3]", (schema) => {
    expect(() => {
      assertTenantSchema(schema);
    }).toThrow(InvalidTenantSchemaError);
    expect(isTenantSchema(schema)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ["tenant_acme"]])("rejects the non-string %j", (value) => {
    expect(() => {
      assertTenantSchema(value);
    }).toThrow(InvalidTenantSchemaError);
  });

  it("names the rejected value, shortened, in the message", () => {
    expect(() => {
      assertTenantSchema("tenant_a; DROP TABLE x");
    }).toThrow('Invalid tenant schema name "tenant_a; DROP TABLE x"');
    const long = `public${"x".repeat(200)}`;
    expect(() => {
      assertTenantSchema(long);
    }).toThrow(/^Invalid tenant schema name "publicx{58}"…: it must match/);
    expect(() => {
      assertTenantSchema(42);
    }).toThrow("Invalid tenant schema name (number)");
  });

  it("uses the ADR-0004 pattern", () => {
    expect(TENANT_SCHEMA_PATTERN.source).toBe("^tenant_[a-z][a-z0-9_]{1,39}$");
    expect(TENANT_SCHEMA_PATTERN.flags).toBe("");
  });

  it("narrows to the TenantSchema brand", () => {
    const value: string = "tenant_acme";
    assertTenantSchema(value);
    expectTypeOf(value).toMatchTypeOf<TenantSchema>();
    // @ts-expect-error: a plain string is not a TenantSchema until it is checked
    const unchecked: TenantSchema = "tenant_acme";
    expect(unchecked).toBe("tenant_acme");
  });
});
