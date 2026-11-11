// The password rule and the Argon2id hashing of the portal (PBE-013; ADR-0008 "Passwords", scope PF-01 AC2): since
// the owner's decision (15e) of 2026-11-11 (FIX-W48-PLATFORM; ADR-0008 revision of 2026-11-11) every portal account's
// password needs 12 characters with a letter and a digit (PCI DSS 8.3.6), the rule FIX-W47-PLATFORM had asked of
// platform admins and the owners and admins of OTAs only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DIR } from "../config";
import {
  ARGON2_OPTIONS,
  BREACHED_PASSWORDS_FILE,
  MIN_PASSWORD_LENGTH,
  parseBreachedPasswords,
  PasswordPolicy,
  RULE_MESSAGE,
} from "./password-policy";

/** The SHA-256 of the shipped list, as password-policy.ts documents its source. */
const LIST_SHA256 = "68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce";

/** A password of the test, never a real one: long enough, with a letter and a digit, and not on the list. */
const GOOD_PASSWORD = "Fjord-Lantern-Quiet-42";

/** The field error message of the rule. */
const RULE_FIELD_MESSAGE = "Use at least 12 characters, with at least one letter and one digit.";

/** The error `check` throws for `password`, or `undefined`. */
function refusal(policy: PasswordPolicy, password: string, path?: string): AppError | undefined {
  try {
    policy.check(password, path);
    return undefined;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
}

let policy: PasswordPolicy;
let goodHash: string;

beforeAll(async () => {
  // Reading the 10 000 lines and one Argon2id hash (19 MiB, 2 passes) take well under a second alone; the bound allows
  // for the parallel load of `pnpm test` on a 4-CPU CI runner.
  policy = PasswordPolicy.load();
  goodHash = await policy.hash(GOOD_PASSWORD);
}, 30_000);

describe("the password rule of every portal account (PCI DSS 8.3.6)", () => {
  it("[FIX-W48-PLATFORM AC1] asks for 12 characters: refuses 9, 10 and 11, and accepts 12, letters and digits included", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(policy.problem("Fjord-Lan4!x")).toBeUndefined();
    // The lengths the 10-character rule took before (PBE-013) and the privileged rule refused (FIX-W47-PLATFORM).
    expect(policy.problem("Fjord-Lan4!")).toBe("password_rule");
    expect(policy.problem("Fjord-La4!")).toBe("password_rule");
    expect(policy.problem("Fjord-La4")).toBe("password_rule");
    expect(policy.problem("")).toBe("password_rule");
  });

  it("[FIX-W48-PLATFORM AC1] asks for at least one letter and one digit, of any script, and counts code points", () => {
    expect(policy.problem("Fjord-Lantern-Quiet")).toBe("password_rule");
    expect(policy.problem("4815-1623-4200")).toBe("password_rule");
    expect(policy.problem("!!--__??..//")).toBe("password_rule");
    expect(policy.problem("Fjord-Lantern-Quiet-4")).toBeUndefined();
    expect(policy.problem("ÅÄÖ-жизнь-7-ü")).toBeUndefined();
    expect(policy.problem("٣٤٥٦-fjord-lantern")).toBeUndefined();
  });

  it("counts characters as Unicode code points, not UTF-16 units", () => {
    // Eleven emoji, a letter and a digit are 13 characters; eleven characters with one emoji (12 UTF-16 units) are not
    // enough, and neither are six emoji (12 UTF-16 units) with a letter and a digit.
    expect(policy.problem("🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂a1")).toBeUndefined();
    expect(policy.problem("🙂abcdefgh12")).toBe("password_rule");
    expect(policy.problem("🙂🙂🙂🙂🙂🙂a1")).toBe("password_rule");
  });

  it("[PBE-013 AC2] refuses a password of the breached list, in any letter case, and names it before the rule", () => {
    for (const password of ["1234567890", "qwertyuiop", "QwertyUiop", "BASKETBALL", "password1"]) {
      expect(policy.problem(password)).toBe("breached");
    }
    expect(policy.problem(GOOD_PASSWORD)).toBeUndefined();
  });

  it("[FIX-W48-PLATFORM AC1] still refuses a listed password that has the length, a letter and a digit", () => {
    // No password of the shipped list has 12 characters, a letter and a digit (the next test), so this policy has a
    // list of its own.
    const own = new PasswordPolicy(parseBreachedPasswords("Copper-Kettle-Morning-9\n"));
    for (const password of ["Copper-Kettle-Morning-9", "COPPER-KETTLE-MORNING-9"]) {
      expect(own.problem(password)).toBe("breached");
    }
    expect(own.problem(GOOD_PASSWORD)).toBeUndefined();
  });

  it("[FIX-W48-PLATFORM AC1] check throws 422 PASSWORD_TOO_WEAK naming the rule, with a field error that never quotes the password", () => {
    const short = refusal(policy, "Fjord-Lan4!");
    const noDigit = refusal(policy, "Kettle-Morning!", "/newPassword");
    const breached = refusal(policy, "qwertyuiop", "/newPassword");

    expect(short).toMatchObject({ code: "PASSWORD_TOO_WEAK", status: 422 });
    expect(short?.message).toBe(RULE_MESSAGE);
    expect(RULE_MESSAGE).toBe(
      "The password needs at least 12 characters with at least one letter and one digit, and must not be a common or breached password.",
    );
    expect(short?.fieldErrors).toEqual([
      { path: "/password", code: "password_rule", message: RULE_FIELD_MESSAGE },
    ]);
    expect(noDigit?.fieldErrors).toEqual([
      { path: "/newPassword", code: "password_rule", message: RULE_FIELD_MESSAGE },
    ]);
    expect(breached?.message).toBe(RULE_MESSAGE);
    expect(breached?.fieldErrors).toEqual([
      { path: "/newPassword", code: "breached", message: expect.any(String) as string },
    ]);
    expect(JSON.stringify([breached?.message, breached?.fieldErrors])).not.toContain("qwertyuiop");
    expect(JSON.stringify([short?.message, short?.fieldErrors])).not.toContain("Fjord-Lan4!");
    expect(JSON.stringify([noDigit?.message, noDigit?.fieldErrors])).not.toContain("Kettle-Morning!");
    expect(refusal(policy, GOOD_PASSWORD)).toBeUndefined();
  });
});

describe("the breached-password list", () => {
  it("is the documented public top-10 000 list: lower-case, one password per line, read once into a set", () => {
    const text = readFileSync(BREACHED_PASSWORDS_FILE, "utf8");
    const lines = text.split("\n");

    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(LIST_SHA256);
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).every((line) => line !== "" && line === line.trim().toLowerCase())).toBe(true);
    expect(policy.breachedCount).toBeGreaterThanOrEqual(10_000);
    expect(policy.breachedCount).toBe(new Set(lines.slice(0, -1)).size);
  });

  it("ships next to the compiled code: the build copies it to dist/auth", () => {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(BREACHED_PASSWORDS_FILE).toBe(join(APP_DIR, "src", "auth", "breached-passwords.txt"));
    expect(manifest.scripts["build"]).toContain(
      "require('node:fs').cpSync('src/auth/breached-passwords.txt', 'dist/auth/breached-passwords.txt')",
    );
  });

  it("parses lists with CRLF line ends, blank lines, spaces and capitals", () => {
    expect([...parseBreachedPasswords("Password1\r\n\r\n  dragon  \nDRAGON\n")]).toEqual([
      "password1",
      "dragon",
    ]);
  });

  it("[FIX-W48-PLATFORM AC1] holds no password that meets the rule, so the list is checked first to name a listed one", () => {
    const meetsRule = (password: string) =>
      [...password].length >= MIN_PASSWORD_LENGTH && /\p{L}/u.test(password) && /\p{Nd}/u.test(password);
    const lines = readFileSync(BREACHED_PASSWORDS_FILE, "utf8").split("\n").slice(0, -1);
    expect(lines.filter(meetsRule)).toEqual([]);
  });

  it("refuses to build a policy on an empty list", () => {
    expect(() => new PasswordPolicy(new Set())).toThrow("the breached-password list is empty");
  });
});

describe("hashing", () => {
  it("[PBE-013 AC5] hashes with Argon2id and the OWASP parameters of ADR-0008", () => {
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    expect(goodHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(goodHash).not.toContain(GOOD_PASSWORD);
  });

  it("verifies the right password only, and a hash that cannot be read as no match", async () => {
    await expect(policy.verify(goodHash, GOOD_PASSWORD)).resolves.toBe(true);
    await expect(policy.verify(goodHash, `${GOOD_PASSWORD}x`)).resolves.toBe(false);
    await expect(policy.verify("not-a-phc-string", GOOD_PASSWORD)).resolves.toBe(false);
  });
});
