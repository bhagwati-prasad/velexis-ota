// The bank identifier rules of a payout account (PBE-058; flows/stripe-payments-account.md §B item 1, PADR-0003 item
// 10, scope PF-64 AC1): the IBAN's normalisation and its mod-97 check with valid and invalid examples, the account
// number's form, and `last4`. The valid IBANs are the published documentation examples of ISO 13616 and the European
// banks (and the example of the OpenAPI document), test values only; the invalid ones are the same with one character
// changed, two adjacent digits swapped, or check digits that MOD 97-10 never gives.
//
// The normalised IBAN must match what the document answers (`RevealedIbanPayoutAccount.iban`) and `last4` what the
// masked account shows (`PayoutAccount.last4`): both patterns are read from the document.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_DIR } from "../config";
import {
  accountNumberProblems,
  ibanProblems,
  ibanRemainder,
  isValidIban,
  lastFour,
  normaliseBic,
  normaliseIban,
  NORMALISED_IBAN_PATTERN,
} from "./iban";

const OPENAPI = join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml");

/** Valid IBANs as an owner may type them, with their normalised form and last 4 characters. */
const VALID: ReadonlyArray<readonly [typed: string, normalised: string, last4: string]> = [
  ["GB82 WEST 1234 5698 7654 32", "GB82WEST12345698765432", "5432"],
  ["DE89 3704 0044 0532 0130 00", "DE89370400440532013000", "3000"],
  ["NO93 8601 1117 947", "NO9386011117947", "7947"],
  ["fr14 2004 1010 0505 0001 3m02 606", "FR1420041010050500013M02606", "2606"],
  ["BE68539007547034", "BE68539007547034", "7034"],
  ["nl91abna0417164300", "NL91ABNA0417164300", "4300"],
  ["CH93 0076 2011 6238 5295 7", "CH9300762011623852957", "2957"],
];

/** Invalid IBANs of the right shape: one character changed, two adjacent digits swapped, impossible check digits. */
const WRONG_CHECKSUM: readonly string[] = [
  "GB82 WEST 1234 5698 7654 33",
  "DE89 3704 0044 0532 0130 01",
  "GB28 WEST 1234 5698 7654 32",
  "NO93 8601 1117 974",
  "BE68 5390 0754 7043",
  "NL91 ABNB 0417 1643 00",
  "GB00 WEST 1234 5698 7654 32",
  "GB01 WEST 1234 5698 7654 32",
  "GB99 WEST 1234 5698 7654 32",
];

const codesOf = (value: string): string[] => ibanProblems(value).map(({ code }) => code);

describe("IBAN", () => {
  it.each(VALID)("[PBE-058 AC1] accepts %s, stored as its normalised form", (typed, normalised, last4) => {
    expect(ibanProblems(typed)).toEqual([]);
    expect(isValidIban(typed)).toBe(true);
    expect(normaliseIban(typed)).toBe(normalised);
    expect(ibanRemainder(normalised)).toBe(1);
    expect(lastFour(normaliseIban(typed))).toBe(last4);
  });

  it.each(WRONG_CHECKSUM)("[PBE-058 AC1] refuses %s with iban_checksum", (typed) => {
    expect(codesOf(typed)).toEqual(["iban_checksum"]);
    expect(isValidIban(typed)).toBe(false);
  });

  it("[PBE-058 AC1] refuses every single-character change of a valid IBAN (mod 97 catches each one)", () => {
    const changed: string[] = [];
    for (const [, iban] of VALID) {
      for (let index = 0; index < iban.length; index += 1) {
        const alphabet = /[0-9]/.test(iban.charAt(index)) ? "0123456789" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        for (const replacement of alphabet) {
          if (replacement !== iban.charAt(index)) {
            changed.push(`${iban.slice(0, index)}${replacement}${iban.slice(index + 1)}`);
          }
        }
      }
    }

    expect(changed.length).toBeGreaterThan(1000);
    expect(changed.filter((iban) => isValidIban(iban))).toEqual([]);
  });

  it("[PBE-058 AC1] refuses every swap of two different adjacent digits of a valid IBAN", () => {
    const swapped: string[] = [];
    for (const [, iban] of VALID) {
      // The two check digits, then each pair inside the account part: adjacent digits of the number mod 97 reads (the
      // check digits move to its end, so a check digit and the first account character are not adjacent there).
      for (const index of [2, ...Array.from({ length: iban.length - 5 }, (_, at) => at + 4)]) {
        const [a, b] = [iban.charAt(index), iban.charAt(index + 1)];
        if (/[0-9]/.test(a) && /[0-9]/.test(b) && a !== b) {
          swapped.push(`${iban.slice(0, index)}${b}${a}${iban.slice(index + 2)}`);
        }
      }
    }

    expect(swapped.length).toBeGreaterThan(50);
    expect(swapped.filter((iban) => isValidIban(iban))).toEqual([]);
  });

  it("refuses with iban_format a value whose normalised form is not an IBAN's shape", () => {
    // Too short or too long once the spaces are gone, a letter among the check digits, punctuation inside.
    for (const typed of [
      "NO93 8601 111",
      `GB82${"1".repeat(31)}`,
      "GBX2 WEST 1234 5698 7654 32",
      "GB82-WEST-1234-5698-7654-32",
      "",
    ]) {
      expect(codesOf(typed), typed).toEqual(["iban_format"]);
    }
  });

  it("never puts the value in a problem's message", () => {
    for (const typed of ["GB82 WEST 1234 5698 7654 33", "NO93 8601 111"]) {
      for (const problem of ibanProblems(typed)) {
        expect(problem.message).not.toContain(normaliseIban(typed).slice(4, 10));
        expect(problem.message).not.toContain(typed.slice(5, 14));
      }
    }
  });

  it("upper-cases a BIC", () => {
    expect(normaliseBic("dnbanokk")).toBe("DNBANOKK");
    expect(normaliseBic("deutdeffxxx")).toBe("DEUTDEFFXXX");
  });
});

describe("local account numbers and last4", () => {
  it("[PBE-058 AC1] takes the last 4 letters or digits of an account number, without spaces and hyphens", () => {
    expect(accountNumberProblems("000123456789")).toEqual([]);
    expect(lastFour("000123456789")).toBe("6789");
    expect(lastFour("12-34 56-7a")).toBe("567A");
  });

  it("refuses an account number with fewer than 4 letters or digits", () => {
    expect(accountNumberProblems("1 2-3").map(({ code }) => code)).toEqual(["account_number_format"]);
    expect(accountNumberProblems("12 3-4")).toEqual([]);
    expect(() => lastFour("1-2 3")).toThrow(RangeError);
  });
});

describe("the patterns of the OpenAPI document", () => {
  let revealedIban: RegExp;
  let maskedLast4: RegExp;
  let typedIban: RegExp;

  // Parsing the whole OpenAPI document takes a fraction of a second idle and seconds next to the other packages'
  // tests on a CI runner: once, in this hook with its own budget, and not inside the tests' 5 s.
  beforeAll(() => {
    const document = parse(readFileSync(OPENAPI, "utf8")) as {
      components: {
        schemas: {
          Iban: { pattern: string };
          RevealedIbanPayoutAccount: { properties: { iban: { pattern: string } } };
          PayoutAccount: { properties: { last4: { pattern: string } } };
        };
      };
    };
    const { Iban, RevealedIbanPayoutAccount, PayoutAccount } = document.components.schemas;
    typedIban = new RegExp(Iban.pattern, "u");
    revealedIban = new RegExp(RevealedIbanPayoutAccount.properties.iban.pattern, "u");
    maskedLast4 = new RegExp(PayoutAccount.properties.last4.pattern, "u");
  }, 30_000);

  it("[PBE-058 AC1] answers every valid IBAN in the revealed pattern and its last4 in the masked pattern", () => {
    expect(revealedIban.source).toBe(NORMALISED_IBAN_PATTERN.source);
    for (const [typed] of VALID) {
      expect(typedIban.test(typed), typed).toBe(true);
      expect(revealedIban.test(normaliseIban(typed)), typed).toBe(true);
      expect(maskedLast4.test(lastFour(normaliseIban(typed))), typed).toBe(true);
    }
    expect(maskedLast4.test(lastFour("12-34 56-7a"))).toBe(true);
  });
});
