// The statement descriptor suffix derived from an OTA's name (PBE-022; ADR-0011 Velexis mode, flows/provisioning.md §3
// `create_payment_connection`): ASCII letters, digits and spaces, at least one letter, 2 to 22 characters, cut after a
// whole word, the tenant key when the name gives none, and always a value the column's CHECK accepts.
//
// The rules of a typed suffix (PBE-038 step 1, `updatePaymentConnection`): only ASCII letters, digits and spaces, at
// least one letter, at most 22 characters, none of Stripe's forbidden characters, and the column's CHECK (2 characters
// or more, the first a letter or a digit). They are compared value by value with the OpenAPI document's
// `StatementDescriptorSuffix`, the request validation's rules, and with migration 0002's CHECK.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_DIR } from "../config";
import {
  asciiDescriptorText,
  cutDescriptorText,
  isStatementDescriptorSuffix,
  STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH,
  statementDescriptorSuffix,
  statementDescriptorSuffixProblems,
  STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS,
} from "./descriptor";

/** The CHECK `payment_provider_connections.statement_descriptor_suffix` of migration 0002. */
const COLUMN_CHECK = /^[A-Za-z0-9][A-Za-z0-9 .&-]{1,21}$/;

const OPENAPI = join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml");
const MIGRATION_0002 = join(APP_DIR, "migrations", "platform", "0002_add_mvp_platform_deltas.sql");

/** The codes of the rules `value` breaks as a typed suffix. */
const codesOf = (value: unknown): string[] =>
  statementDescriptorSuffixProblems(value).map(({ code }) => code);

/**
 * Values around every rule: each printable ASCII character and a few others (white space including a no-break and a
 * zero-width space, written as escapes so the source shows them, accents, other scripts, an emoji) alone, first, last
 * and inside a word, and texts of 0 to 24 characters of letters, digits and spaces.
 */
function corpus(): string[] {
  const characters = [
    ...Array.from({ length: 0x7f - 0x20 }, (_, offset) => String.fromCharCode(0x20 + offset)),
    "\t",
    "\n",
    "\u00a0",
    "é",
    "É",
    "ß",
    "Ⅻ",
    "東",
    "🚀",
    "\u200b",
  ];
  const values = new Set<string>([""]);
  for (const character of characters) {
    for (const value of [
      character,
      `${character}${character}`,
      `A${character}`,
      `${character}A`,
      `7${character}`,
      `${character}7`,
      `AB${character}CD`,
      `12${character}34`,
      `ACME${character}`,
    ]) {
      values.add(value);
    }
  }
  for (let length = 1; length <= STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH + 2; length += 1) {
    for (const unit of ["A", "7", "A ", " A", "7 ", "A7", "  "]) {
      values.add(unit.repeat(length).slice(0, length));
    }
  }
  return [...values];
}

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

describe("statementDescriptorSuffixProblems (a typed suffix)", () => {
  it("[PBE-038 AC1] refuses ACME*TRAVEL for its forbidden character and 23 characters for their length", () => {
    expect(statementDescriptorSuffixProblems("ACME*TRAVEL")).toEqual([
      { code: "forbiddenCharacter", message: "Must not contain any of < > \\ ' \" *." },
    ]);
    expect(statementDescriptorSuffixProblems("A".repeat(23))).toEqual([
      { code: "maxLength", message: "Must have at most 22 characters." },
    ]);
  });

  it.each([
    "ACME TRAVEL",
    "ACME TRAVEL 24",
    "Fjord Reisen",
    "A1",
    "7 SEAS",
    "x".repeat(22),
    "1234567890123456789 Go",
    // Spaces are kept as typed, as the OpenAPI document allows them.
    "ACME  TRAVEL",
    "ACME ",
  ])("[PBE-038 AC1] accepts %j as it is", (value) => {
    expect(statementDescriptorSuffixProblems(value)).toEqual([]);
  });

  it.each(STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS)(
    "refuses Stripe's forbidden character %j anywhere",
    (forbidden) => {
      for (const value of [`ACME${forbidden}TRAVEL`, `${forbidden}ACME`, `ACME${forbidden}`]) {
        expect([value, codesOf(value)]).toEqual([value, ["forbiddenCharacter"]]);
      }
    },
  );

  it.each([
    ["", ["minLength", "letter"]],
    ["A", ["minLength"]],
    ["12", ["letter"]],
    ["2 4 6", ["letter"]],
    ["  ", ["letter", "start"]],
    [" ACME", ["start"]],
    ["ACMÉ TRAVEL", ["characters"]],
    ["ACME-TRAVEL", ["characters"]],
    ["ACME.TRAVEL", ["characters"]],
    ["A&B TRAVEL", ["characters"]],
    ["ACME\tTRAVEL", ["characters"]],
    ["ACME\u00a0TRAVEL", ["characters"]],
    ["🚀 Rocket", ["characters"]],
    ["ACME*TRAVEL-24", ["forbiddenCharacter", "characters"]],
    [`${"A".repeat(22)}*`, ["maxLength", "forbiddenCharacter"]],
    ["*", ["minLength", "forbiddenCharacter", "letter"]],
  ] as const)("refuses %j for the rules %j", (value, rules) => {
    expect(codesOf(value)).toEqual(rules);
  });

  it("refuses a value that is not a string with one problem", () => {
    for (const value of [null, undefined, 42, true, ["ACME"], { suffix: "ACME" }]) {
      expect(codesOf(value)).toEqual(["type"]);
    }
  });

  it("counts characters, not UTF-16 units, and never puts the value in a message", () => {
    // 21 letters and one emoji: 22 characters (23 UTF-16 units), refused for the emoji only.
    expect(codesOf(`${"A".repeat(21)}🚀`)).toEqual(["characters"]);
    const value = "SECRETBRAND*<>'\"\\ é".repeat(2);
    const problems = statementDescriptorSuffixProblems(value);
    expect(problems.map(({ code }) => code)).toEqual(["maxLength", "forbiddenCharacter", "characters"]);
    for (const { message } of problems) {
      expect(message).not.toContain("SECRETBRAND");
      expect(message).not.toContain("é");
    }
  });

  it("accepts every derived suffix, and every suffix it accepts fits the column's CHECK", () => {
    const derived = [
      "Acme Travel",
      "Northern Lights Travel Agency",
      "Ünïcödé Tøürs & Co.",
      "O'Brien's Tours",
      "a".repeat(40),
      "東京トラベル",
    ].map((name) => statementDescriptorSuffix(name, "fallback_key"));
    for (const suffix of derived) {
      expect([suffix, codesOf(suffix)]).toEqual([suffix, []]);
    }
    for (const value of corpus()) {
      if (isStatementDescriptorSuffix(value)) {
        expect([value, codesOf(value)]).toEqual([value, []]);
      }
      if (codesOf(value).length === 0) {
        expect([value, COLUMN_CHECK.test(value)]).toEqual([value, true]);
      }
    }
  });
});

describe("the documents that define the rules of a typed suffix", () => {
  /** The request validation of the document's StatementDescriptorSuffix, compiled with Ajv as the interceptor does. */
  let documentAccepts: (value: unknown) => boolean;
  /** The pattern of PaymentConnection.statementDescriptorSuffix, which every answer must match. */
  let answeredPattern: RegExp;
  /** The back-quoted characters of StatementDescriptorSuffix's description: Stripe's forbidden characters. */
  let documentedForbidden: string[];
  /** The CHECK of migration 0002. */
  let columnCheck: RegExp;

  // Parsing the whole OpenAPI document takes a fraction of a second idle and seconds next to the other packages'
  // tests on a CI runner: once, in this hook with its own budget, and not inside the tests' 5 s.
  beforeAll(() => {
    const document = parse(readFileSync(OPENAPI, "utf8")) as {
      components: {
        schemas: {
          StatementDescriptorSuffix: {
            type: string;
            minLength: number;
            maxLength: number;
            pattern: string;
            description: string;
          };
          PaymentConnection: { properties: { statementDescriptorSuffix: { pattern: string } } };
        };
      };
    };
    const { StatementDescriptorSuffix: schema, PaymentConnection: answer } = document.components.schemas;
    const validate = new Ajv2020({ strict: true, allErrors: true, logger: false }).compile({
      type: schema.type,
      minLength: schema.minLength,
      maxLength: schema.maxLength,
      pattern: schema.pattern,
    });
    documentAccepts = (value) => validate(value);
    answeredPattern = new RegExp(answer.properties.statementDescriptorSuffix.pattern, "u");
    documentedForbidden = [...schema.description.matchAll(/`(.)`/gu)].map((match) => match[1] ?? "");
    const check = /statement_descriptor_suffix ~ '([^']+)'/u.exec(readFileSync(MIGRATION_0002, "utf8"));
    columnCheck = new RegExp(check?.[1] ?? "(?!)", "u");
  }, 30_000);

  it("[PBE-038 AC1] accepts exactly the values that the request validation accepts", () => {
    const values = [...corpus(), "ACME*TRAVEL", "A".repeat(23), 42, null];
    const disagreements = values.filter(
      (value) => documentAccepts(value) !== (statementDescriptorSuffixProblems(value).length === 0),
    );

    expect(values.length).toBeGreaterThan(1000);
    expect(disagreements).toEqual([]);
    expect(documentAccepts("ACME*TRAVEL")).toBe(false);
    expect(documentAccepts("A".repeat(23))).toBe(false);
  });

  it("accepts only values that the column's CHECK stores and the answer's pattern allows", () => {
    expect(columnCheck.source).toBe(COLUMN_CHECK.source);
    const accepted = corpus().filter((value) => statementDescriptorSuffixProblems(value).length === 0);

    expect(accepted.length).toBeGreaterThan(50);
    for (const value of accepted) {
      expect([value, columnCheck.test(value), answeredPattern.test(value)]).toEqual([value, true, true]);
    }
  });

  it("forbids the characters the document names as Stripe's forbidden characters", () => {
    expect(documentedForbidden).toEqual([...STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS]);
    expect(Object.isFrozen(STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS)).toBe(true);
  });
});
