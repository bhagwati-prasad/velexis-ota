// The statement descriptor suffix derived from an OTA's name (PBE-022; ADR-0011 Velexis mode, flows/provisioning.md §3
// `create_payment_connection`): ASCII letters, digits and spaces, at least one letter, 2 to 22 characters, cut after a
// whole word, the tenant key when the name gives none, and always a value the column's CHECK accepts.
import { describe, expect, it } from "vitest";
import {
  asciiDescriptorText,
  cutDescriptorText,
  isStatementDescriptorSuffix,
  STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH,
  statementDescriptorSuffix,
} from "./descriptor";

/** The CHECK `payment_provider_connections.statement_descriptor_suffix` of migration 0002. */
const COLUMN_CHECK = /^[A-Za-z0-9][A-Za-z0-9 .&-]{1,21}$/;

describe("statementDescriptorSuffix", () => {
  it.each([
    ["Acme Travel", "Acme Travel"],
    ["  Acme   Travel  ", "Acme Travel"],
    ["Café Voyages", "Cafe Voyages"],
    ["Ålesund Reisebyrå", "Alesund Reisebyra"],
    ["Straße & Söhne Reisen", "Strasse Sohne Reisen"],
    ["Łódź Øresund Æther", "Lodz Oresund AEther"],
    ["O'Brien's Tours", "O Brien s Tours"],
    ["Acme-Travel.com", "Acme Travel com"],
    ["ＡＣＭＥ Travel", "ACME Travel"],
    ["Travel 24/7", "Travel 24 7"],
    ["A1", "A1"],
  ])("[PBE-022 AC1] derives %j as %j: ASCII letters, digits and single spaces", (name, expected) => {
    expect(statementDescriptorSuffix(name)).toBe(expected);
  });

  it("[PBE-022 AC1] keeps at most 22 characters, cut after the last whole word that fits", () => {
    expect(statementDescriptorSuffix("Acme International Holidays")).toBe("Acme International");
    expect(statementDescriptorSuffix("Northern Lights Travel Agency")).toBe("Northern Lights Travel");
    expect(statementDescriptorSuffix("Northern Lights Travel")).toBe("Northern Lights Travel");
    // A first word longer than 22 characters is cut inside it.
    expect(statementDescriptorSuffix("Supercalifragilisticexpialidocious Travel")).toBe(
      "Supercalifragilisticex",
    );
  });

  it("[PBE-022 AC1] falls back to the tenant key when the name gives no suffix, and to null when neither does", () => {
    expect(statementDescriptorSuffix("東京トラベル", "tokyo_travel")).toBe("tokyo travel");
    expect(statementDescriptorSuffix("24/7", "agency_24")).toBe("agency 24");
    expect(statementDescriptorSuffix("&", "a1")).toBe("a1");
    expect(statementDescriptorSuffix("東京", "a_")).toBeNull();
    expect(statementDescriptorSuffix("2024")).toBeNull();
    expect(statementDescriptorSuffix("")).toBeNull();
  });

  it("[PBE-022 AC1] gives only values the column's CHECK accepts, for any name", () => {
    const names = [
      "Acme Travel",
      "x",
      "  -Acme- ",
      "Ünïcödé Tøürs & Co.",
      "a".repeat(40),
      `${"word ".repeat(10)}end`,
      "日本 Travel Company Limited of Tokyo",
      "\t\nTravel Time​",
      "Ⅻ Roman Numeral Tours",
      "🚀 Rocket Trips",
    ];
    for (const name of names) {
      const suffix = statementDescriptorSuffix(name, "fallback_key");
      expect(suffix, name).not.toBeNull();
      expect(suffix, name).toMatch(COLUMN_CHECK);
      expect(isStatementDescriptorSuffix(suffix), name).toBe(true);
      expect(suffix?.length ?? 0, name).toBeLessThanOrEqual(STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH);
    }
  });
});

describe("isStatementDescriptorSuffix", () => {
  it.each(["AC", "Acme Travel", "A1 Tours", "a".repeat(22), "2 Go"])("accepts %j", (value) => {
    expect(isStatementDescriptorSuffix(value)).toBe(true);
  });

  it.each([
    "A",
    "a".repeat(23),
    "1234",
    " Acme",
    "Acme ",
    "Acme  Travel",
    "ACME*TRAVEL",
    "Acme's",
    'Acme "Travel"',
    "Acme<Travel>",
    "Acme\\Travel",
    "Café",
    "Acme.Travel",
    "",
    42,
    null,
  ])("refuses %j", (value) => {
    expect(isStatementDescriptorSuffix(value)).toBe(false);
  });
});

describe("asciiDescriptorText and cutDescriptorText", () => {
  it("turns accents into ASCII and every other run of characters into one space", () => {
    expect(asciiDescriptorText("  Crème brûlée — Voyages!  ")).toBe("Creme brulee Voyages");
  });

  it("leaves a text of 22 characters or fewer as it is", () => {
    expect(cutDescriptorText("Exactly twenty-two ch")).toBe("Exactly twenty-two ch");
  });
});
