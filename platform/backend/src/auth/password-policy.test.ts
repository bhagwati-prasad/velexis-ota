// The password rules and the Argon2id hashing of the portal (PBE-013; ADR-0008 "Passwords", scope PF-01 AC2), and the
// privileged rule of platform admins and owners and admins of OTAs (FIX-W47-PLATFORM; ADR-0008 revision of 2026-11-10).
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
  PRIVILEGED_MIN_PASSWORD_LENGTH,
  PRIVILEGED_PASSWORD_ROLES,
  RULE_MESSAGES,
  type PasswordRule,
} from "./password-policy";

/** The SHA-256 of the shipped list, as password-policy.ts documents its source. */
const LIST_SHA256 = "68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce";

/** A password of the test, never a real one: long enough and not on the list. */
const GOOD_PASSWORD = "Fjord-Lantern-Quiet-42";

/** The error `check` throws for `password`, or `undefined`. */
function refusal(
  policy: PasswordPolicy,
  password: string,
  path?: string,
  rule?: PasswordRule,
): AppError | undefined {
  try {
    policy.check(password, path, rule);
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

describe("password rules", () => {
  it("[PBE-013 AC2] refuses a 9-character password and accepts one of 10 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(policy.problem("Fjord-La4!")).toBeUndefined();
    expect(policy.problem("Fjord-La4")).toBe("too_short");
    expect(policy.problem("")).toBe("too_short");
  });

  it("counts characters as Unicode code points, not UTF-16 units", () => {
    // Five emoji are ten UTF-16 units but five characters.
    expect(policy.problem("🙂🙂🙂🙂🙂")).toBe("too_short");
    expect(policy.problem("🙂🙂🙂🙂🙂-fjord")).toBeUndefined();
  });

  it("[PBE-013 AC2] refuses a password of the breached list, in any letter case", () => {
    for (const password of ["1234567890", "qwertyuiop", "QwertyUiop", "BASKETBALL"]) {
      expect(policy.problem(password)).toBe("breached");
    }
    expect(policy.problem(GOOD_PASSWORD)).toBeUndefined();
  });

  it("[PBE-013 AC2] check throws 422 PASSWORD_TOO_WEAK with a field error that never quotes the password", () => {
    const tooShort = refusal(policy, "Fjord-La4");
    const breached = refusal(policy, "qwertyuiop", "/newPassword");

    expect(tooShort).toMatchObject({ code: "PASSWORD_TOO_WEAK", status: 422 });
    expect(tooShort?.fieldErrors).toEqual([
      { path: "/password", code: "too_short", message: "Use at least 10 characters." },
    ]);
    expect(breached?.fieldErrors).toEqual([
      { path: "/newPassword", code: "breached", message: expect.any(String) as string },
    ]);
    expect(JSON.stringify([breached?.message, breached?.fieldErrors])).not.toContain("qwertyuiop");
    expect(JSON.stringify([tooShort?.message, tooShort?.fieldErrors])).not.toContain("Fjord-La4");
    expect(refusal(policy, GOOD_PASSWORD)).toBeUndefined();
  });
});

describe("the privileged rule of platform admins and owners and admins of OTAs (PCI DSS 8.3.6)", () => {
  it("[FIX-W47-PLATFORM AC2] asks for 12 characters: refuses 11 and accepts 12, letters and digits included", () => {
    expect(PRIVILEGED_MIN_PASSWORD_LENGTH).toBe(12);
    expect(PRIVILEGED_PASSWORD_ROLES).toEqual(["owner", "admin"]);
    expect(policy.problem("Fjord-Lan4!x", "privileged")).toBeUndefined();
    expect(policy.problem("Fjord-Lan4!", "privileged")).toBe("privileged_rule");
    expect(policy.problem("Fjord-La4", "privileged")).toBe("privileged_rule");
    expect(policy.problem("", "privileged")).toBe("privileged_rule");
    // The standard rule still takes 10 and 11 characters.
    expect(policy.problem("Fjord-Lan4!")).toBeUndefined();
    expect(policy.problem("Fjord-Lan4!", "standard")).toBeUndefined();
  });

  it("[FIX-W47-PLATFORM AC2] asks for at least one letter and one digit, of any script, and counts code points", () => {
    expect(policy.problem("Fjord-Lantern-Quiet", "privileged")).toBe("privileged_rule");
    expect(policy.problem("4815-1623-4200", "privileged")).toBe("privileged_rule");
    expect(policy.problem("!!--__??..//", "privileged")).toBe("privileged_rule");
    expect(policy.problem("Fjord-Lantern-Quiet-4", "privileged")).toBeUndefined();
    expect(policy.problem("ÅÄÖ-жизнь-7-ü", "privileged")).toBeUndefined();
    // Eleven emoji, a letter and a digit are 13 characters; ten characters with one emoji are not enough.
    expect(policy.problem("🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂a1", "privileged")).toBeUndefined();
    expect(policy.problem("🙂abcdefgh1", "privileged")).toBe("privileged_rule");
    // The same passwords meet the standard rule, which has no composition rule.
    expect(policy.problem("Fjord-Lantern-Quiet")).toBeUndefined();
    expect(policy.problem("4815-1623-4200")).toBeUndefined();
  });

  it("[FIX-W47-PLATFORM AC2] still refuses a password of the breached list that has the length, a letter and a digit", () => {
    // No password of the shipped list has 12 characters, a letter and a digit, so this policy has a list of its own.
    const own = new PasswordPolicy(parseBreachedPasswords("Copper-Kettle-Morning-9\n"));
    for (const password of ["Copper-Kettle-Morning-9", "COPPER-KETTLE-MORNING-9"]) {
      expect(own.problem(password, "standard")).toBe("breached");
      expect(own.problem(password, "privileged")).toBe("breached");
    }
    expect(own.problem(GOOD_PASSWORD, "privileged")).toBeUndefined();
  });

  it("[FIX-W47-PLATFORM AC2] check names the account's rule in the 422 PASSWORD_TOO_WEAK and never quotes the password", () => {
    const privileged = refusal(policy, "Fjord-Lan4!", "/newPassword", "privileged");
    const standard = refusal(policy, "Fjord-La4", "/newPassword", "standard");
    const breached = refusal(policy, "qwertyuiop", "/newPassword", "standard");

    expect(privileged).toMatchObject({ code: "PASSWORD_TOO_WEAK", status: 422 });
    expect(privileged?.message).toBe(RULE_MESSAGES.privileged);
    expect(privileged?.message).toMatch(/at least 12 characters with at least one letter and one digit/);
    expect(privileged?.message).toMatch(/platform admins and for owners and admins of an OTA/);
    expect(privileged?.fieldErrors).toEqual([
      {
        path: "/newPassword",
        code: "privileged_rule",
        message:
          "Use at least 12 characters, with at least one letter and one digit: the rule for platform admins and for owners and admins of an OTA.",
      },
    ]);
    expect(standard?.message).toBe(RULE_MESSAGES.standard);
    expect(standard?.message).toMatch(/at least 10 characters/);
    expect(standard?.fieldErrors).toEqual([
      { path: "/newPassword", code: "too_short", message: "Use at least 10 characters." },
    ]);
    expect(breached?.message).toBe(RULE_MESSAGES.standard);
    expect(breached?.fieldErrors?.map((error) => error.code)).toEqual(["breached"]);
    expect(JSON.stringify([privileged?.message, privileged?.fieldErrors])).not.toContain("Fjord-Lan4!");
    expect(refusal(policy, GOOD_PASSWORD, "/newPassword", "privileged")).toBeUndefined();
  });

  it("[FIX-W47-PLATFORM AC2] uses the standard rule when no rule is given, as at sign-up", () => {
    expect(refusal(policy, "Fjord-Lan4!")).toBeUndefined();
    expect(refusal(policy, "Fjord-La4")?.message).toBe(RULE_MESSAGES.standard);
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
