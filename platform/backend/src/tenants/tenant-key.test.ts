// The key rules of an OTA (PBE-017 step 1; platform/docs/scope.md PF-10 AC1): the pattern, the reserved list of the
// sign-up flow and the storefront host. The pattern and the list are compared with the documents that define them,
// so a change on one side fails here: the flow (step 6), the OpenAPI document's `TenantKey` and migration 0002's
// `tenants_key_dns_ck`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_DIR } from "../config";
import {
  isReservedTenantKey,
  isValidTenantKey,
  RESERVED_TENANT_KEYS,
  storefrontHost,
  TENANT_KEY_PATTERN,
  tenantKeyProblem,
} from "./tenant-key";

const SIGN_UP_FLOW = join(APP_DIR, "..", "docs", "flows", "signup-and-create-ota.md");
const OPENAPI = join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml");
const MIGRATION_0002 = join(APP_DIR, "migrations", "platform", "0002_add_mvp_platform_deltas.sql");

/** The reserved names of the sign-up flow's step 6: the back-quoted words of "not in the reserved list (…)". */
function reservedKeysOfTheFlow(): string[] {
  const text = readFileSync(SIGN_UP_FLOW, "utf8");
  const match = /not in the reserved list \(([^)]*)\)/.exec(text);
  if (match?.[1] === undefined) {
    throw new Error("the sign-up flow names no reserved list in step 6");
  }
  return [...match[1].matchAll(/`([^`]+)`/g)].map((word) => word[1] ?? "");
}

describe("tenantKeyProblem", () => {
  it.each(["ab", "1abc", "a_bc"])("[PBE-017 AC1] answers invalid for %j", (key) => {
    expect(tenantKeyProblem(key)).toBe("invalid");
    expect(isValidTenantKey(key)).toBe(false);
  });

  it("[PBE-017 AC1] answers reserved for admin, and nothing for a free valid key", () => {
    expect(tenantKeyProblem("admin")).toBe("reserved");
    expect(isReservedTenantKey("admin")).toBe(true);
    expect(tenantKeyProblem("acme")).toBeUndefined();
  });

  it.each([
    ["abc", true],
    ["a".repeat(30), true],
    ["a".repeat(31), false],
    ["acme2026", true],
    ["Acme", false],
    ["acme-travel", false],
    ["acme.travel", false],
    [" acme", false],
    ["acme\n", false],
    ["", false],
    ["ácme", false],
  ])("checks the length, the letters and the first character: %j is valid: %s", (key, valid) => {
    expect(isValidTenantKey(key)).toBe(valid);
    expect(tenantKeyProblem(key)).toBe(valid ? undefined : "invalid");
  });

  it("checks the rule before the reserved list, and every reserved name follows the rule", () => {
    expect(tenantKeyProblem("Admin")).toBe("invalid");
    for (const key of RESERVED_TENANT_KEYS) {
      expect(isValidTenantKey(key), key).toBe(true);
      expect(tenantKeyProblem(key), key).toBe("reserved");
    }
  });
});

describe("the documents that define the rules", () => {
  it("reserves exactly the names of the sign-up flow (step 6), once each", () => {
    const documented = reservedKeysOfTheFlow();

    expect(documented.length).toBeGreaterThan(0);
    expect([...RESERVED_TENANT_KEYS]).toEqual(documented);
    expect(new Set(RESERVED_TENANT_KEYS).size).toBe(RESERVED_TENANT_KEYS.length);
    expect(Object.isFrozen(RESERVED_TENANT_KEYS)).toBe(true);
  });

  it("uses the pattern of the OpenAPI document's TenantKey and of migration 0002's tenants_key_dns_ck", () => {
    const document = parse(readFileSync(OPENAPI, "utf8")) as {
      components: { schemas: { TenantKey: { pattern: string } } };
    };
    const constraint = /tenants_key_dns_ck CHECK \(key ~ '([^']+)'\)/.exec(
      readFileSync(MIGRATION_0002, "utf8"),
    );

    expect(TENANT_KEY_PATTERN.source).toBe(document.components.schemas.TenantKey.pattern);
    expect(constraint?.[1]).toBe(TENANT_KEY_PATTERN.source);
    expect(TENANT_KEY_PATTERN.flags).toBe("");
  });
});

describe("storefrontHost", () => {
  it("is <key>.<STOREFRONT_BASE_DOMAIN>", () => {
    expect(storefrontHost("acme", "ota.example.com")).toBe("acme.ota.example.com");
  });
});
